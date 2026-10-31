/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * doorbell-effects.test.ts: The doorbell capability's observer-effect net - the two nettable observer reflections (physical-chime duration, chime volume), the
 * doorbell-trigger ring, the volume-Lightbulb's cross-device chime-volume write, and the doorbell capability's MQTT handler bodies (the /chime and /message GET/SET
 * bodies) - against the REAL constructed ProtectCamera-plus-DoorbellCapability.
 *
 * The doorbell capability registers its observers (doorbell.ts). Their WAKE is netted by doorbell-construction.test.ts; this suite nets the two reflections
 * whose EFFECT is observable without a controller write surface: chimeDuration -> updatePhysicalChimes (the mutually-exclusive physical-chime switch fan-out) and
 * chimeVolume -> updateChimeVolume (the volume Lightbulb's On + Brightness). The lcdMessage reflection needs its own harness support - updateLcdSwitch iterates
 * messageSwitches, which getMessages leaves empty unless nvr.ufp.doorbellSettings is seeded - so it gets its own dedicated section below (the LCD message switch net)
 * rather than the simple push-and-assert shape the other two reflections use; the hasPackageCamera reflection is a lifecycle reconcile already netted by the family
 * construction suite.
 *
 * The doorbell-trigger ring onSet is also netted here: triggering the switch with a truthy value fires nvr.events.doorbellEventHandler(this) - it writes no
 * accessory.context and never touches the controller. The ring is captured through a TEST-LOCAL ProtectEventDispatch subclass that overrides doorbellEventHandler into a
 * recording array (the pattern event-dispatch.test.ts established), injected through makeTestNvr's dispatch hook and read back off nvr.events - NOT the shared
 * TestRecordingDispatch, which overrides only motionEventHandler. The override captures the routing (which device the ring fired for); it deliberately does not
 * re-test the handler's HomeKit effects, which are event-dispatch.ts's own concern.
 *
 * The volume Lightbulb's Brightness onSet is netted as a cross-device write: it routes to setChimeVolume, which PATCHes every real client.chimes entry serving this
 * doorbell with a modified ring, skips a chime that does not serve this doorbell or carries no ring for it, early-returns on the first failed write, and reports
 * both a generic failure and an authorization failure through the shared command-error log. A negative Brightness never reaches the handler: HAP refuses one written
 * from HomeKit, and the MQTT set range-checks its value first.
 *
 * The doorbell capability's MQTT handler bodies are netted directly against the doorbell's registered subscriptions: the /chime GET and SET (reading and routing the
 * chime volume through the same Lightbulb path) and the /message GET and SET (reading the current LCD message and parsing, validating, translating, and routing a
 * new one to setMessage).
 *
 * The vacuity gate is two-part (carried from the device-* law): every gated reflection HARD-asserts its gated service or switch EXISTS as the FIRST check (a
 * non-optional assert.ok, so an absent service throws here rather than passing vacuously) and pairs with a without-gate test that proves the same push produces nothing
 * when the precondition is omitted. The chime-volume push MUST move the computed mean, because the volume selector dedups on the COMPUTED volume - a push that leaves the
 * mean unchanged would never wake the observer, making the assertion vacuous.
 *
 * Every constructed doorbell is unwound through cleanup() plus the harness abort in an afterEach, so no observe loop outlives the test.
 */
import type { Camera, ProtectCameraConfig, ProtectChimeConfig, ProtectNvrConfig } from "unifi-protect";
import { Characteristic, Service, TestStateStore, makeProtectState, makeTestAccessory } from "../../testing.helpers.ts";
import { HAPStatus, TIMER_DELAY_MAX_MS } from "homebridge-plugin-utils";
import { TEST_CLOCK_EPOCH, makeTestNvr } from "../../nvr/testing.helpers.ts";
import { TestCameraProjection, TestChimeProjection, makeCameraConfig, makeChimeConfig } from "../testing.helpers.ts";
import type { TestClock, TestLogEntry, TestMqttClient } from "homebridge-plugin-utils/testing";
import { afterEach, describe, test } from "node:test";
import { hapStatus, loggedAt, settle, triggerSet } from "homebridge-plugin-utils/testing";
import { G2_PRO_CHANNELS } from "../../camera.fixtures.ts";
import type { Nullable } from "homebridge-plugin-utils";
import { ProtectAuthorizationError } from "unifi-protect";
import { ProtectCamera } from "./camera.ts";
import { ProtectEventDispatch } from "../../nvr/event-dispatch.ts";
import type { ProtectNvr } from "../../nvr/nvr.ts";
import { ProtectReservedNames } from "../../types.ts";
import type { TestProtectAccessory } from "../../testing.helpers.ts";
import type { TestProtectNvr } from "../../nvr/testing.helpers.ts";
import assert from "node:assert/strict";
import { configured } from "../device-base.ts";
import { effectiveLcdMessage } from "./doorbell.ts";

// One captured doorbell-ring routing. The onSet's observable effect is which device it routed to, so this is the shape the recording subclass captures - the same posture
// event-dispatch.test.ts uses for its own routing assertions.
interface RingCall {

  id: string;
}

// A REAL ProtectEventDispatch whose doorbell delivery is overridden to record rather than touch HomeKit or arm a ring timer. The override's arity and parameter types
// mirror production's doorbellEventHandler (event-dispatch.ts) exactly, so it type-checks as a true override; the camera's doorbell-trigger onSet calls
// this.nvr.events.doorbellEventHandler(this), so this captures exactly that routing without firing the real ring's HomeKit effects.
class RecordingRingDispatch extends ProtectEventDispatch {

  public readonly rings: RingCall[] = [];

  public override doorbellEventHandler(protectDevice: ProtectCamera): void {

    this.rings.push({ id: protectDevice.protectId });
  }
}

// The construction handles a test holds onto, so the afterEach can unwind the per-accessory abort regardless of which build the test ran. chimeProjections are the HELD
// chime doubles the doorbell's cross-device setChimeVolume writes through (one per seeded chime config, in order) - the test asserts each projection's updateCalls
// and sets its updateRejection lever on the SAME instance the write hits. logEntries and mqtt are the write-drive's additional read surface: the write reports its
// failure through the shared command-error log (logEntries) and publishes the new volume through the MQTT double (mqtt) on success.
interface BuiltDoorbell {

  accessory: TestProtectAccessory;
  cameraConfig: ProtectCameraConfig;
  // The camera's read-through projection, the SAME instance the doorbell's #device write-through reaches (camera.ts passes this.device into
  // createDoorbellCapability), so the /message SET's setMessage -> this.#device.update lands on this projection's updateCalls. Exposed for the /message assertions.
  cameraProjection: TestCameraProjection;
  chimeProjections: TestChimeProjection[];
  clock: TestClock;
  controller: AbortController;
  doorbell: ProtectCamera;
  logEntries: readonly TestLogEntry[];
  mqtt: TestMqttClient;
  nvr: TestProtectNvr;
  // What the doorbell published as it was built, taken off the double's list so each row reads only what its own occasion adds.
  stated: TestMqttClient["published"];
  store: TestStateStore;
}

// Build a REAL ProtectCamera against an isDoorbell-true config (so it construction-attaches its DoorbellCapability), exactly as doorbell-construction.test.ts
// assembles it: the doorbell camera config (with the test's extra feature flags merged over isDoorbell), an optional chime serving it, the store double, the typed
// NVR / platform doubles with the test's userOptions threaded into the REAL FeatureOptions engine and an optional dispatch factory, the read-through projection, and a
// fresh accessory. The casts are confined to this one boundary - the instance is the production ProtectCamera and its composed capability.
async function buildDoorbell(options: { chimeConfigs?: ProtectChimeConfig[]; disconnected?: boolean; dispatch?: (nvr: ProtectNvr) => ProtectEventDispatch;
  doorbellSettings?: ProtectNvrConfig["doorbellSettings"];
  featureFlags?: Partial<ProtectCameraConfig["featureFlags"]>; lcdMessage?: { duration?: number; resetAt?: Nullable<number>; text?: string; type?: string };
  userOptions?: string[]; } = {}): Promise<BuiltDoorbell> {

  // lcdMessage is threaded through when the /message GET net seeds a current message; makeCameraConfig only carries the key when it is supplied, so the no-message GET
  // case (the default omission) reads an absent lcdMessage and returns the empty string.
  const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { isDoorbell: true, ...options.featureFlags },
    ...(options.lcdMessage !== undefined ? { lcdMessage: options.lcdMessage } : {}), name: "Front Door" });
  const chimeConfigs = options.chimeConfigs ?? [];
  const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig], ...(chimeConfigs.length ? { chimes: chimeConfigs } : {}) }));

  // The HELD chime projections, one per seeded chime config and against this same store, captured in the SAME order the configs were supplied so a test can name them by
  // index. These are the exact instances the doorbell's setChimeVolume filters out of client.chimes and writes through, so a test's updateRejection lever and its
  // updateCalls assertion act on the same object the write hits - the held-not-rebuilt contract client.chimes guarantees.
  const chimeProjections = chimeConfigs.map((chime) => new TestChimeProjection(chime.id, store));

  // mqtt is always installed: the write-drive asserts the chime publish, and the reflection / ring tests never read mqtt, so an installed no-op recorder is
  // behavior-neutral for them. The held chime projections flow in through client.chimes; non-chime tests seed none (the empty default).
  const { clock, controller, logEntries, mqtt, nvr } = makeTestNvr({ chimes: chimeProjections, ...(options.dispatch ? { dispatch: options.dispatch } : {}),
    ...(options.doorbellSettings !== undefined ? { doorbellSettings: options.doorbellSettings } : {}), mqtt: true, store, userOptions: options.userOptions });

  // A disconnected double is the production startup shape: the doorbell is built before the broker acknowledges the first session.
  if(mqtt && options.disconnected) {

    mqtt.connected = false;
  }

  const accessory = makeTestAccessory("Front Door", "74ACB9000001");
  const projection = new TestCameraProjection(cameraConfig.id, store);
  const doorbell = configured(new ProtectCamera(nvr as unknown as ProtectNvr, accessory, projection as unknown as Camera));

  // Settle the floating configure IIFE, the capability's configure, and the observe loops' lazy registration before any push so the doorbell is fully wired.
  await settle();

  assert.ok(mqtt, "the MQTT recording double is installed");

  // The doorbell states its held state as it is built. The builder hands that statement back as the baseline and leaves the list past it, so each row reads what its
  // own occasion publishes. The double's gate memory still holds what was stated, as the client's would, so a same-value statement stays unsent.
  const stated = mqtt.published.splice(0);

  return { accessory, cameraConfig, cameraProjection: projection, chimeProjections, clock, controller, doorbell, logEntries, mqtt, nvr, stated, store };
}

describe("doorbell capability observer effects and the trigger ring (doorbell-effects concern net)", () => {

  // The per-test handle, torn down in afterEach so each test's per-accessory abort unwinds.
  let built: BuiltDoorbell | undefined;

  afterEach(() => {

    built?.doorbell.cleanup();
    built?.controller.abort();
    built = undefined;
  });

  describe("the chimeDuration -> physical-chime switches reflection", () => {

    test("with hasChime and the physical-chime option, a chimeDuration push fans the mode across the three physical-chime switches", async () => {

      built = await buildDoorbell({ featureFlags: { hasChime: true }, userOptions: ["Enable.Doorbell.PhysicalChime"] });

      // The doorbell census: the camera's plain set (thirteen, including the always-armed isDoorbell observer, the bare-motion lastMotion observer, the
      // capability-reconcile featureFlags observer, the Access-lock supportUnlock observer, and the HomeKit Secure Video eligibility observer) plus the base pair plus
      // the capability's four = nineteen. A drift here means an extra or missing observer slipped in.
      assert.equal(built.nvr.client.state.observerCount, 19, "the doorbell wires nineteen observers (the camera thirteen, the base pair, and the capability four)");

      // HARD-assert all three physical-chime switches exist FIRST: the gate is hasChime && hasFeature("Doorbell.PhysicalChime") (doorbell.ts). An absent service
      // would let the value assertions pass vacuously.
      const none = built.accessory.getServiceById(Service.Switch, ProtectReservedNames.SWITCH_DOORBELL_CHIME_NONE);
      const mechanical = built.accessory.getServiceById(Service.Switch, ProtectReservedNames.SWITCH_DOORBELL_CHIME_MECHANICAL);
      const digital = built.accessory.getServiceById(Service.Switch, ProtectReservedNames.SWITCH_DOORBELL_CHIME_DIGITAL);

      assert.ok(none, "hasChime plus Enable.Doorbell.PhysicalChime materializes the NONE physical-chime switch");
      assert.ok(mechanical, "the MECHANICAL physical-chime switch materializes");
      assert.ok(digital, "the DIGITAL physical-chime switch materializes");

      // makeCameraConfig seeds chimeDuration 0, which is the NONE duration, so the NONE switch starts On. Push 300 - the MECHANICAL duration (a constant,
      // doorbell.ts) - which wakes the chimeDuration observer -> updatePhysicalChimes -> the fan-out (On === (chimeDuration === getPhysicalChimeDuration(type))).
      assert.equal(none.getCharacteristic(Characteristic.On).value, true, "the NONE switch initialized On for the seeded chimeDuration 0");

      built.nvr.client.state.pushCameraPatch(built.cameraConfig.id, { chimeDuration: 300 });

      await settle();

      assert.equal(none.getCharacteristic(Characteristic.On).value, false, "the chimeDuration push drove the NONE switch Off");
      assert.equal(mechanical.getCharacteristic(Characteristic.On).value, true, "the chimeDuration 300 push drove the MECHANICAL switch On (its duration is 300)");
      assert.equal(digital.getCharacteristic(Characteristic.On).value, false, "the chimeDuration push left the DIGITAL switch Off (its duration is the clamped value)");
    });

    test("without hasChime, no physical-chime switches are materialized and a chimeDuration push writes nothing", async () => {

      built = await buildDoorbell({ userOptions: ["Enable.Doorbell.PhysicalChime"] });

      assert.equal(built.accessory.getServiceById(Service.Switch, ProtectReservedNames.SWITCH_DOORBELL_CHIME_MECHANICAL), undefined,
        "without hasChime the physical-chime switches are not materialized, even with the option enabled");

      built.nvr.client.state.pushCameraPatch(built.cameraConfig.id, { chimeDuration: 300 });

      await settle();

      assert.equal(built.accessory.getServiceById(Service.Switch, ProtectReservedNames.SWITCH_DOORBELL_CHIME_MECHANICAL), undefined,
        "the chimeDuration push materialized no physical-chime switch when the hardware gate held");
    });
  });

  describe("the chimeVolume -> volume Lightbulb reflection", () => {

    test("with the volume-dimmer option and an assigned chime, a chime-volume push reflects the new mean onto the Lightbulb On + Brightness", async () => {

      // A chime serving this doorbell at volume 50, so the doorbell's effective chime volume is the computed mean (50 with one assigned chime).
      const chime = makeChimeConfig({ cameraIds: ["test-camera-1"], ringSettings: [{ cameraId: "test-camera-1", volume: 50 }] });

      built = await buildDoorbell({ chimeConfigs: [chime], userOptions: ["Enable.Doorbell.Volume.Dimmer"] });

      // HARD-assert the volume Lightbulb exists FIRST: the gate is hasFeature("Doorbell.Volume.Dimmer") (doorbell.ts). An absent service would let the value
      // assertions pass vacuously.
      const volumeBulb = built.accessory.getServiceById(Service.Lightbulb, ProtectReservedNames.LIGHTBULB_DOORBELL_VOLUME);

      assert.ok(volumeBulb, "Enable.Doorbell.Volume.Dimmer materializes the chime-volume Lightbulb");

      // The bulb initializes from the seeded volume (50): On true (volume > 0), Brightness 50.
      assert.equal(volumeBulb.getCharacteristic(Characteristic.On).value, true, "the volume Lightbulb initialized On for the seeded volume of 50");
      assert.equal(volumeBulb.getCharacteristic(Characteristic.Brightness).value, 50, "the volume Lightbulb initialized Brightness to the seeded volume of 50");

      // The reaction: push the chime's ring volume to 80, which MOVES the computed mean (the selector dedups on the mean, so a push leaving it at 50 would never wake
      // the observer). This wakes doorbell.chimeVolume -> updateChimeVolume -> the Lightbulb write.
      built.nvr.client.state.pushChimePatch(chime.id, { ringSettings: [{ cameraId: "test-camera-1", repeatTimes: 1, ringtoneId: "default", volume: 80 }] });

      await settle();

      assert.equal(volumeBulb.getCharacteristic(Characteristic.Brightness).value, 80, "the chime-volume push reflected the new mean (80) onto Brightness");
      assert.equal(volumeBulb.getCharacteristic(Characteristic.On).value, true, "the volume Lightbulb stays On for a non-zero volume");

      // The zero edge: push the ring volume to 0, which moves the mean to 0 and drives On false.
      built.nvr.client.state.pushChimePatch(chime.id, { ringSettings: [{ cameraId: "test-camera-1", repeatTimes: 1, ringtoneId: "default", volume: 0 }] });

      await settle();

      assert.equal(volumeBulb.getCharacteristic(Characteristic.Brightness).value, 0, "the zero-volume push reflected 0 onto Brightness");
      assert.equal(volumeBulb.getCharacteristic(Characteristic.On).value, false, "the volume Lightbulb went Off for a zero volume");
    });

    test("without the volume-dimmer option, no volume Lightbulb is materialized", async () => {

      const chime = makeChimeConfig({ cameraIds: ["test-camera-1"], ringSettings: [{ cameraId: "test-camera-1", volume: 50 }] });

      built = await buildDoorbell({ chimeConfigs: [chime] });

      assert.equal(built.accessory.getServiceById(Service.Lightbulb, ProtectReservedNames.LIGHTBULB_DOORBELL_VOLUME), undefined,
        "omitting Enable.Doorbell.Volume.Dimmer materializes no chime-volume Lightbulb");
    });
  });

  describe("the volume-Lightbulb Brightness onSet -> setChimeVolume cross-device write (real client.chimes drive)", () => {

    // The doorbell's identity in this suite: makeCameraConfig defaults the id to "test-camera-1" and the mac to "74ACB9000001", so a chime serving this doorbell must
    // list "test-camera-1" in its cameraIds and key its ring there, and the publish goes out on the "74ACB9000001/chime" topic. These literals must match exactly - a
    // mismatch makes the filter / find skip every chime and the write becomes vacuous, which the single-chime case's captured payload proves against directly.
    const doorbellId = "test-camera-1";
    const chimeTopic = "74ACB9000001/chime";

    // Each test resolves the materialized volume Lightbulb inline and HARD-asserts it exists FIRST (the gate is hasFeature("Doorbell.Volume.Dimmer")): an absent service
    // would let the write assertions pass vacuously. The Brightness onSet routes straight to setChimeVolume(value), so a triggerSet on it drives the cross-device write.

    test("a single serving chime is PATCHed with a single-entry ringSettings carrying the modified ring, and its confirmation published once", async () => {

      const chime = makeChimeConfig({ cameraIds: [doorbellId], ringSettings: [{ cameraId: doorbellId, ringtoneId: "tone-a", volume: 20 }] });

      built = await buildDoorbell({ chimeConfigs: [chime], userOptions: ["Enable.Doorbell.Volume.Dimmer"] });

      const volumeBulb = built.accessory.getServiceById(Service.Lightbulb, ProtectReservedNames.LIGHTBULB_DOORBELL_VOLUME);

      assert.ok(volumeBulb, "Enable.Doorbell.Volume.Dimmer materializes the chime-volume Lightbulb");

      const [served] = built.chimeProjections;

      assert.ok(served, "the held chime projection is present");

      await triggerSet(volumeBulb.getCharacteristic(Characteristic.Brightness), 70);

      assert.deepEqual(served.updateCalls, [{ payload: { ringSettings: [{ cameraId: doorbellId, repeatTimes: 1, ringtoneId: "tone-a", volume: 70 }] } }],
        "the PATCH carries one ring entry: this doorbell's ring spread with only the volume changed to 70");
      assert.equal(built.mqtt.publishedTo("/chime").length, 0, "the command with no controller confirmation published nothing");

      built.store.pushChimePatch(chime.id, { ringSettings: [{ cameraId: doorbellId, repeatTimes: 1, ringtoneId: "tone-a", volume: 70 }] });
      await settle();

      assert.deepEqual(built.mqtt.published.filter((entry) => entry.topic === chimeTopic), [{ payload: "70", retain: false, topic: chimeTopic }],
        "the confirmed volume is published once on the chime topic");
      assert.ok(!loggedAt(built.logEntries, "error", "Unable to set the chime volume"), "an accepted write logs no failure");
    });

    test("a negative Brightness write is refused with HAP's invalid-value status and reaches no chime", async () => {

      const chime = makeChimeConfig({ cameraIds: [doorbellId], ringSettings: [{ cameraId: doorbellId, ringtoneId: "tone-a", volume: 50 }] });

      built = await buildDoorbell({ chimeConfigs: [chime], userOptions: ["Enable.Doorbell.Volume.Dimmer"] });

      const volumeBulb = built.accessory.getServiceById(Service.Lightbulb, ProtectReservedNames.LIGHTBULB_DOORBELL_VOLUME);

      assert.ok(volumeBulb, "the chime-volume Lightbulb materialized");

      const [served] = built.chimeProjections;

      assert.ok(served, "the held chime projection is present");

      // HAP validates a controller's write against Brightness's own range before the set handler runs, so a negative Brightness never reaches setChimeVolume: the write
      // is refused with HAP's invalid-value status, and no ring PATCH reaches the chime.
      await assert.rejects(triggerSet(volumeBulb.getCharacteristic(Characteristic.Brightness), -15), hapStatus(HAPStatus.INVALID_VALUE_IN_REQUEST));

      assert.deepEqual(served.updateCalls, [], "the refused write sends the chime no ring PATCH");
      assert.equal(built.mqtt.publishedTo("/chime").length, 0, "the refused write published nothing");

      // The controller reporting a zero volume on its own is still confirmed and published once.
      built.store.pushChimePatch(chime.id, { ringSettings: [{ cameraId: doorbellId, repeatTimes: 1, ringtoneId: "tone-a", volume: 0 }] });
      await settle();

      assert.deepEqual(built.mqtt.published.filter((entry) => entry.topic === chimeTopic), [{ payload: "0", retain: false, topic: chimeTopic }],
        "the controller-confirmed zero volume is what we publish");
    });

    test("a chime volume change pushed to a doorbell built without Doorbell.Volume.Dimmer publishes nothing", async () => {

      const chime = makeChimeConfig({ cameraIds: [doorbellId], ringSettings: [{ cameraId: doorbellId, ringtoneId: "tone-a", volume: 20 }] });

      built = await buildDoorbell({ chimeConfigs: [chime] });

      built.store.pushChimePatch(chime.id, { ringSettings: [{ cameraId: doorbellId, repeatTimes: 1, ringtoneId: "tone-a", volume: 70 }] });
      await settle();

      assert.equal(built.mqtt.publishedTo("/chime").length, 0, "a doorbell with no volume dimmer has no chime topic to publish");
    });

    test("a chime volume change the controller reports with no command publishes the value the chime get answers once", async () => {

      const chime = makeChimeConfig({ cameraIds: [doorbellId], ringSettings: [{ cameraId: doorbellId, ringtoneId: "tone-a", volume: 20 }] });

      built = await buildDoorbell({ chimeConfigs: [chime], userOptions: ["Enable.Doorbell.Volume.Dimmer"] });

      built.store.pushChimePatch(chime.id, { ringSettings: [{ cameraId: doorbellId, repeatTimes: 1, ringtoneId: "tone-a", volume: 70 }] });
      await settle();

      assert.deepEqual(built.mqtt.publishedTo("/chime").map((entry) => entry.payload), ["70"], "the reported change published the doorbell's chime volume once");
    });

    test("every chime serving this doorbell is written, and the confirmed volume is published exactly once", async () => {

      const chimeA = makeChimeConfig({ cameraIds: [doorbellId], id: "chime-a", mac: "74ACB9000201", ringSettings: [{ cameraId: doorbellId, volume: 10 }] });
      const chimeB = makeChimeConfig({ cameraIds: [ doorbellId, "doorbell-2" ], id: "chime-b", mac: "74ACB9000202",
        ringSettings: [{ cameraId: doorbellId, volume: 20 }] });

      built = await buildDoorbell({ chimeConfigs: [ chimeA, chimeB ], userOptions: ["Enable.Doorbell.Volume.Dimmer"] });

      const volumeBulb = built.accessory.getServiceById(Service.Lightbulb, ProtectReservedNames.LIGHTBULB_DOORBELL_VOLUME);

      assert.ok(volumeBulb, "the chime-volume Lightbulb materialized");

      const [ servedA, servedB ] = built.chimeProjections;

      assert.ok(servedA && servedB, "both held chime projections are present");

      await triggerSet(volumeBulb.getCharacteristic(Characteristic.Brightness), 55);

      assert.equal(servedA.updateCalls.length, 1, "the first chime serving this doorbell is written");
      assert.equal(servedB.updateCalls.length, 1, "the second chime serving this doorbell is written");
      assert.equal(built.mqtt.publishedTo("/chime").length, 0, "the command with no controller confirmation published nothing");

      // The confirmations land together in one drain of the observe loop, which reads the final state once.
      built.store.pushChimePatch(chimeA.id, { ringSettings: [{ cameraId: doorbellId, repeatTimes: 1, ringtoneId: "default", volume: 55 }] });
      built.store.pushChimePatch(chimeB.id, { ringSettings: [{ cameraId: doorbellId, repeatTimes: 1, ringtoneId: "default", volume: 55 }] });
      await settle();

      assert.deepEqual(built.mqtt.published.filter((entry) => entry.topic === chimeTopic), [{ payload: "55", retain: false, topic: chimeTopic }],
        "the volume is published exactly once after every assigned chime confirms the write");
    });

    test("a chime that does not serve this doorbell is left untouched", async () => {

      const foreign = makeChimeConfig({ cameraIds: ["doorbell-2"], id: "chime-foreign", mac: "74ACB9000203", ringSettings: [{ cameraId: "doorbell-2", volume: 90 }] });
      const served = makeChimeConfig({ cameraIds: [doorbellId], id: "chime-served", mac: "74ACB9000204", ringSettings: [{ cameraId: doorbellId, volume: 30 }] });

      built = await buildDoorbell({ chimeConfigs: [ foreign, served ], userOptions: ["Enable.Doorbell.Volume.Dimmer"] });

      const volumeBulb = built.accessory.getServiceById(Service.Lightbulb, ProtectReservedNames.LIGHTBULB_DOORBELL_VOLUME);

      assert.ok(volumeBulb, "the chime-volume Lightbulb materialized");

      const [ foreignProjection, servedProjection ] = built.chimeProjections;

      assert.ok(foreignProjection && servedProjection, "both held chime projections are present");

      await triggerSet(volumeBulb.getCharacteristic(Characteristic.Brightness), 45);

      assert.equal(foreignProjection.updateCalls.length, 0, "the chime that does not list this doorbell is filtered out and never written");
      assert.equal(servedProjection.updateCalls.length, 1, "only the chime that serves this doorbell is written");
      assert.equal(built.mqtt.publishedTo("/chime").length, 0, "the command publishes nothing of its own");

      // The served chime's confirmation is the change the topic follows, and the foreign chime's volume never enters the doorbell's reading.
      built.store.pushChimePatch(served.id, { ringSettings: [{ cameraId: doorbellId, repeatTimes: 1, ringtoneId: "default", volume: 45 }] });
      await settle();

      assert.deepEqual(built.mqtt.publishedTo("/chime").map((entry) => entry.payload), ["45"], "the served chime's confirmation published its volume once");
    });

    test("a chime serving this doorbell but carrying no ring for it is skipped without a write", async () => {

      const noRing = makeChimeConfig({ cameraIds: [doorbellId], id: "chime-noring", mac: "74ACB9000205", ringSettings: [] });
      const served = makeChimeConfig({ cameraIds: [doorbellId], id: "chime-served", mac: "74ACB9000206", ringSettings: [{ cameraId: doorbellId, volume: 30 }] });

      built = await buildDoorbell({ chimeConfigs: [ noRing, served ], userOptions: ["Enable.Doorbell.Volume.Dimmer"] });

      const volumeBulb = built.accessory.getServiceById(Service.Lightbulb, ProtectReservedNames.LIGHTBULB_DOORBELL_VOLUME);

      assert.ok(volumeBulb, "the chime-volume Lightbulb materialized");

      const [ noRingProjection, servedProjection ] = built.chimeProjections;

      assert.ok(noRingProjection && servedProjection, "both held chime projections are present");

      await triggerSet(volumeBulb.getCharacteristic(Characteristic.Brightness), 35);

      assert.equal(noRingProjection.updateCalls.length, 0, "the chime listing the doorbell but with no ring for it is skipped; the loop continues to the next");
      assert.equal(servedProjection.updateCalls.length, 1, "the chime carrying a ring for this doorbell is written");
      assert.equal(built.mqtt.publishedTo("/chime").length, 0, "the command publishes nothing of its own");

      // The ringing chime's confirmation is the change the topic follows, and the chime with no ring for this doorbell never enters the doorbell's reading.
      built.store.pushChimePatch(served.id, { ringSettings: [{ cameraId: doorbellId, repeatTimes: 1, ringtoneId: "default", volume: 35 }] });
      await settle();

      assert.deepEqual(built.mqtt.publishedTo("/chime").map((entry) => entry.payload), ["35"], "the ringing chime's confirmation published its volume once");
    });

    test("the first failed write early-returns: no later chime is written, nothing is published, and the failure is logged", async () => {

      const first = makeChimeConfig({ cameraIds: [doorbellId], id: "chime-first", mac: "74ACB9000207", ringSettings: [{ cameraId: doorbellId, volume: 10 }] });
      const second = makeChimeConfig({ cameraIds: [doorbellId], id: "chime-second", mac: "74ACB9000208", ringSettings: [{ cameraId: doorbellId, volume: 20 }] });

      built = await buildDoorbell({ chimeConfigs: [ first, second ], userOptions: ["Enable.Doorbell.Volume.Dimmer"] });

      const volumeBulb = built.accessory.getServiceById(Service.Lightbulb, ProtectReservedNames.LIGHTBULB_DOORBELL_VOLUME);

      assert.ok(volumeBulb, "the chime-volume Lightbulb materialized");

      const [ firstProjection, secondProjection ] = built.chimeProjections;

      assert.ok(firstProjection && secondProjection, "both held chime projections are present");

      // The held projection identity is what makes this drive non-vacuous: the rejection lever set here is the SAME object setChimeVolume writes through, so the first
      // write genuinely throws and the early-return is exercised.
      firstProjection.updateRejection = new Error("The chime rejected the write.");

      await triggerSet(volumeBulb.getCharacteristic(Characteristic.Brightness), 25);

      assert.equal(firstProjection.updateCalls.length, 1, "the first chime's write was attempted");
      assert.equal(secondProjection.updateCalls.length, 0, "the second chime is never written once the first write fails - the loop early-returns");
      assert.equal(built.mqtt.published.filter((entry) => entry.topic === chimeTopic).length, 0, "a failed write publishes nothing");
      assert.ok(loggedAt(built.logEntries, "error", "Unable to set the chime volume: The chime rejected the write."),
        "the doorbell-specific action string is reported through the shared command-error helper");
    });

    test("an authorization failure on the write earns the Administrator-role guidance", async () => {

      const chime = makeChimeConfig({ cameraIds: [doorbellId], ringSettings: [{ cameraId: doorbellId, volume: 40 }] });

      built = await buildDoorbell({ chimeConfigs: [chime], userOptions: ["Enable.Doorbell.Volume.Dimmer"] });

      const volumeBulb = built.accessory.getServiceById(Service.Lightbulb, ProtectReservedNames.LIGHTBULB_DOORBELL_VOLUME);

      assert.ok(volumeBulb, "the chime-volume Lightbulb materialized");

      const [served] = built.chimeProjections;

      assert.ok(served, "the held chime projection is present");

      served.updateRejection = new ProtectAuthorizationError("forbidden");

      await triggerSet(volumeBulb.getCharacteristic(Characteristic.Brightness), 25);

      assert.equal(built.mqtt.published.filter((entry) => entry.topic === chimeTopic).length, 0, "an authorization failure publishes nothing");
      assert.ok(loggedAt(built.logEntries, "error", "Unable to set the chime volume. Please ensure this username has the full management role in UniFi Protect."),
        "an authorization failure on the chime-volume write earns the admin-role guidance for the doorbell action");
    });
  });

  describe("the doorbell-trigger ring onSet (fires doorbellEventHandler, no controller write)", () => {

    test("triggering the switch on routes a ring to doorbellEventHandler with this doorbell", async () => {

      // Inject the recording dispatch so nvr.events.doorbellEventHandler is the captured override; the trigger switch needs Enable.Doorbell.Trigger to materialize.
      const dispatch = (nvr: ProtectNvr): ProtectEventDispatch => new RecordingRingDispatch(nvr);

      built = await buildDoorbell({ dispatch, userOptions: ["Enable.Doorbell.Trigger"] });

      // HARD-assert the trigger switch exists FIRST.
      const triggerSwitch = built.accessory.getServiceById(Service.Switch, ProtectReservedNames.SWITCH_DOORBELL_TRIGGER);

      assert.ok(triggerSwitch, "Enable.Doorbell.Trigger materializes the doorbell-trigger switch");

      const ring = built.nvr.events as unknown as RecordingRingDispatch;

      assert.equal(ring.rings.length, 0, "no ring has fired before the trigger");

      // onSet true: the handler fires this.nvr.events.doorbellEventHandler(this) - no accessory.context write, no controller write. The recording override captures the
      // routing.
      await triggerSet(triggerSwitch.getCharacteristic(Characteristic.On), true);

      assert.equal(ring.rings.length, 1, "the truthy trigger fired exactly one ring through doorbellEventHandler");
      assert.equal(ring.rings[0]?.id, built.cameraConfig.id, "the ring routed to this doorbell (the protectDevice argument is the doorbell itself)");
    });

    test("triggering the switch off fires no ring", async () => {

      const dispatch = (nvr: ProtectNvr): ProtectEventDispatch => new RecordingRingDispatch(nvr);

      built = await buildDoorbell({ dispatch, userOptions: ["Enable.Doorbell.Trigger"] });

      const triggerSwitch = built.accessory.getServiceById(Service.Switch, ProtectReservedNames.SWITCH_DOORBELL_TRIGGER);

      assert.ok(triggerSwitch, "the doorbell-trigger switch materialized");

      const ring = built.nvr.events as unknown as RecordingRingDispatch;

      // onSet false: the handler's else branch never calls doorbellEventHandler (it only re-asserts an in-flight ring), so no ring is routed.
      await triggerSet(triggerSwitch.getCharacteristic(Characteristic.On), false);

      assert.equal(ring.rings.length, 0, "a falsy trigger fires no ring");
    });
  });

  describe("the doorbell-capability MQTT handler bodies (the /chime and /message get/set bodies)", () => {

    // The doorbell's identity in this suite: makeCameraConfig defaults the mac to "74ACB9000001", so every captured subscription is on a "74ACB9000001/<tail>" topic and
    // the publish goes out on "74ACB9000001/chime". These literals must match exactly - a mismatch makes the subscription find skip and the test reads as vacuous, which
    // the HARD-assert-exists gate catches.
    const mac = "74ACB9000001";

    // The message topic exists only while Doorbell.Messages is on, so the message get and set rows build with the feature enabled.
    const messagesOn = ["Enable.Doorbell.Messages"];
    const doorbellId = "test-camera-1";

    describe("the /chime GET (the chime-volume read-through)", () => {

      test("returns the doorbell's effective chime volume as a string", async () => {

        // A chime serving this doorbell at volume 50, so chimeVolume reads 50 through the live projection.
        const chime = makeChimeConfig({ cameraIds: [doorbellId], ringSettings: [{ cameraId: doorbellId, volume: 50 }] });

        built = await buildDoorbell({ chimeConfigs: [chime], userOptions: ["Enable.Doorbell.Volume.Dimmer"] });

        // HARD-assert the /chime GET subscription exists FIRST: an absent subscription whose getValue is optional-chained would let the value assertion pass vacuously.
        const get = built.mqtt.subscriptions.find((subscription) => (subscription.kind === "get") && (subscription.topic === mac + "/chime/get"));

        assert.ok(get, "the doorbell registered a /chime GET subscription");
        assert.equal(await built.mqtt.invokeGet(mac + "/chime/get"), "50", "the /chime GET returns the doorbell's effective chime volume (50) as a string");
      });
    });

    describe("the /chime SET (parse, gate, route the volume to the Lightbulb)", () => {

      test("a valid in-range value drives one served-chime write and publishes nothing from the command path", async () => {

        const chime = makeChimeConfig({ cameraIds: [doorbellId], ringSettings: [{ cameraId: doorbellId, ringtoneId: "default", volume: 20 }] });

        built = await buildDoorbell({ chimeConfigs: [chime], userOptions: ["Enable.Doorbell.Volume.Dimmer"] });

        // HARD-assert the volume Lightbulb the body drives exists FIRST: the SET body routes through setCharacteristic on it, so an absent service would no-op and the
        // write assertions would pass vacuously.
        const volumeBulb = built.accessory.getServiceById(Service.Lightbulb, ProtectReservedNames.LIGHTBULB_DOORBELL_VOLUME);

        assert.ok(volumeBulb, "Enable.Doorbell.Volume.Dimmer materializes the chime-volume Lightbulb the SET body drives");

        const set = built.mqtt.subscriptions.find((subscription) => (subscription.kind === "set") && (subscription.topic === mac + "/chime/set"));

        assert.ok(set, "the doorbell registered a /chime SET subscription");

        const [served] = built.chimeProjections;

        assert.ok(served, "the held chime projection is present");

        // The body parses "70", passes the gate (not NaN, 0..100), and setCharacteristic(Brightness, 70) -> the Brightness onSet -> setChimeVolume(70).
        // setCharacteristic is fire-and-forget, so settle past the onSet before asserting. The On onSet (value > 0 truthy) early-returns, so exactly one served-chime
        // write lands. This nets only the MQTT body's parse / gate / route - setChimeVolume's fan-out and auth are the
        // setChimeVolume cross-device write describe's concern.
        await built.mqtt.invokeSet(mac + "/chime/set", "70");
        await settle();

        assert.deepEqual(served.updateCalls, [{ payload: { ringSettings: [{ cameraId: doorbellId, repeatTimes: 1, ringtoneId: "default", volume: 70 }] } }],
          "the valid /chime SET routed the volume to the Lightbulb, driving one served-chime ring PATCH at volume 70");
        assert.equal(built.mqtt.publishedTo("/chime").length, 0, "the command with no controller confirmation published nothing");

        built.store.pushChimePatch(chime.id, { ringSettings: [{ cameraId: doorbellId, repeatTimes: 1, ringtoneId: "default", volume: 70 }] });
        await settle();

        assert.deepEqual(built.mqtt.publishedTo("/chime").map((entry) => entry.payload), ["70"], "the controller's confirmation published the new volume once");
      });

      test("a non-numeric value is gated out: no write, no publish", async () => {

        const chime = makeChimeConfig({ cameraIds: [doorbellId], ringSettings: [{ cameraId: doorbellId, volume: 50 }] });

        built = await buildDoorbell({ chimeConfigs: [chime], userOptions: ["Enable.Doorbell.Volume.Dimmer"] });

        const volumeBulb = built.accessory.getServiceById(Service.Lightbulb, ProtectReservedNames.LIGHTBULB_DOORBELL_VOLUME);

        assert.ok(volumeBulb, "the chime-volume Lightbulb materialized");

        const set = built.mqtt.subscriptions.find((subscription) => (subscription.kind === "set") && (subscription.topic === mac + "/chime/set"));

        assert.ok(set, "the /chime SET subscription registered");

        const [served] = built.chimeProjections;

        assert.ok(served, "the held chime projection is present");

        // "abc" parses to NaN, so the isNaN gate returns before any setCharacteristic - no Lightbulb drive, no chime write, no publish.
        await built.mqtt.invokeSet(mac + "/chime/set", "abc");
        await settle();

        assert.equal(served.updateCalls.length, 0, "a NaN value is gated out before the Lightbulb drive, so no chime write happens");
        assert.equal(built.mqtt.published.filter((entry) => entry.topic === mac + "/chime").length, 0, "a gated-out value publishes nothing");
      });

      test("an out-of-range value (above 100 or below 0) is gated out: no write, no publish", async () => {

        const chime = makeChimeConfig({ cameraIds: [doorbellId], ringSettings: [{ cameraId: doorbellId, volume: 50 }] });

        built = await buildDoorbell({ chimeConfigs: [chime], userOptions: ["Enable.Doorbell.Volume.Dimmer"] });

        const volumeBulb = built.accessory.getServiceById(Service.Lightbulb, ProtectReservedNames.LIGHTBULB_DOORBELL_VOLUME);

        assert.ok(volumeBulb, "the chime-volume Lightbulb materialized");

        const set = built.mqtt.subscriptions.find((subscription) => (subscription.kind === "set") && (subscription.topic === mac + "/chime/set"));

        assert.ok(set, "the /chime SET subscription registered");

        const [served] = built.chimeProjections;

        assert.ok(served, "the held chime projection is present");

        // Both 150 ( > 100 ) and -5 ( < 0 ) fail the (volume < 0) || (volume > 100) gate, so neither reaches the Lightbulb drive.
        await built.mqtt.invokeSet(mac + "/chime/set", "150");
        await built.mqtt.invokeSet(mac + "/chime/set", "-5");
        await settle();

        assert.equal(served.updateCalls.length, 0, "an out-of-range value is gated out, so no chime write happens");
        assert.equal(built.mqtt.published.filter((entry) => entry.topic === mac + "/chime").length, 0, "an out-of-range value publishes nothing");
      });
    });

    describe("the /message GET (the current LCD message read)", () => {

      test("with a current message and no numeric resetAt, returns duration 0 and the message text", async () => {

        // Seed lcdMessage WITHOUT a numeric resetAt (omitted), so typeof resetAt !== "number" forces the deterministic duration-0 branch.
        built = await buildDoorbell({ lcdMessage: { text: "Hello" }, userOptions: messagesOn });

        const get = built.mqtt.subscriptions.find((subscription) => (subscription.kind === "get") && (subscription.topic === mac + "/message/get"));

        assert.ok(get, "the doorbell registered a /message GET subscription");
        assert.deepEqual(JSON.parse(await built.mqtt.invokeGet(mac + "/message/get") ?? ""), { duration: 0, message: "Hello" },
          "a current message with no numeric resetAt reads as duration 0 and the text");
      });

      test("with a numeric resetAt, computes the remaining duration in seconds", async () => {

        // The harness clock starts at TEST_CLOCK_EPOCH and this row never advances it, so (resetAt - now) / 1000 is exact. T0 is that epoch, the clock's instant
        // before construction; a resetAt 45 seconds out reads back as duration 45, killing mutations of the subtraction, the / 1000 scaling, and the Math.round.
        const t0 = TEST_CLOCK_EPOCH;

        built = await buildDoorbell({ lcdMessage: { resetAt: t0 + 45000, text: "Hi" }, userOptions: messagesOn });

        const get = built.mqtt.subscriptions.find((subscription) => (subscription.kind === "get") && (subscription.topic === mac + "/message/get"));

        assert.ok(get, "the doorbell registered a /message GET subscription");
        assert.deepEqual(JSON.parse(await built.mqtt.invokeGet(mac + "/message/get") ?? ""), { duration: 45, message: "Hi" },
          "a resetAt 45 seconds out reads back as duration 45 with the message text");
      });

      test("with no current message, returns the empty string", async () => {

        // No lcdMessage seeded: the body's !this.ufp.lcdMessage guard returns the empty string (not the JSON "{}").
        built = await buildDoorbell({ userOptions: messagesOn });

        const get = built.mqtt.subscriptions.find((subscription) => (subscription.kind === "get") && (subscription.topic === mac + "/message/get"));

        assert.ok(get, "the doorbell registered a /message GET subscription");
        assert.equal(await built.mqtt.invokeGet(mac + "/message/get"), "", "with no current message the /message GET returns the empty string");
      });
    });

    describe("the /message SET (parse, validate, translate, route to setMessage)", () => {

      // The /message SET handler reads rawValue (the SECOND argument) - production passes the raw MQTT string there - so every drive passes the JSON string as both args.
      // The setMessage write-through lands on the camera projection (the doorbell's #device IS the camera's this.device IS built.cameraProjection), so the outbound
      // lcdMessage payload is asserted against cameraProjection.updateCalls.

      test("a custom message with a positive duration writes a CUSTOM_MESSAGE with a resetAt now + duration", async () => {

        // The harness clock holds still through the row, so resetAt === T0 + duration*1000 is exact, making the * 1000 seconds-scaling and the now + duration math
        // mutation-detectable.
        built = await buildDoorbell({ userOptions: messagesOn });

        const t0 = built.clock.now();
        const set = built.mqtt.subscriptions.find((subscription) => (subscription.kind === "set") && (subscription.topic === mac + "/message/set"));

        assert.ok(set, "the doorbell registered a /message SET subscription");

        const payload = JSON.stringify({ duration: 30, message: "Ding" });

        await built.mqtt.invokeSet(mac + "/message/set", payload);

        assert.deepEqual(built.cameraProjection.updateCalls,
          [{ payload: { lcdMessage: { resetAt: t0 + 30000, text: "Ding", type: "CUSTOM_MESSAGE" } } }],
          "a 30-second custom message writes a CUSTOM_MESSAGE whose resetAt is now plus 30 seconds (the * 1000 scaling applied)");
      });

      test("a duration of 0 writes a non-expiring CUSTOM_MESSAGE (resetAt null)", async () => {

        // Deterministic, no time dependence: duration 0 is present and not negative, so * 1000 = 0; setMessage's resetAt = duration ? ... : null yields null. The
        // null-vs-T0 check kills a mutation flipping the ternary.
        built = await buildDoorbell({ userOptions: messagesOn });

        const set = built.mqtt.subscriptions.find((subscription) => (subscription.kind === "set") && (subscription.topic === mac + "/message/set"));

        assert.ok(set, "the /message SET subscription registered");

        const payload = JSON.stringify({ duration: 0, message: "Ding" });

        await built.mqtt.invokeSet(mac + "/message/set", payload);

        assert.deepEqual(built.cameraProjection.updateCalls, [{ payload: { lcdMessage: { resetAt: null, text: "Ding", type: "CUSTOM_MESSAGE" } } }],
          "a duration-0 custom message is non-expiring: resetAt is null, not a timestamp");
      });

      test("a blank message resets the LCD: writes a resetAt with no text or type, and logs the reset", async () => {

        // The reset resetAt is the harness clock's exact instant T0, asserted with deepEqual rather than truthiness so the check reads the value itself. A blank
        // message takes the reset branch: outbound { resetAt: now } has no "duration" key, so setMessage passes it through untranslated.
        built = await buildDoorbell({ userOptions: messagesOn });

        const t0 = built.clock.now();
        const set = built.mqtt.subscriptions.find((subscription) => (subscription.kind === "set") && (subscription.topic === mac + "/message/set"));

        assert.ok(set, "the /message SET subscription registered");

        const payload = JSON.stringify({ message: "" });

        await built.mqtt.invokeSet(mac + "/message/set", payload);

        assert.deepEqual(built.cameraProjection.updateCalls, [{ payload: { lcdMessage: { resetAt: t0 } } }],
          "a blank message writes a bare resetAt (the clock's current instant) with no text or type key");
        assert.ok(loggedAt(built.logEntries, "info", "Received MQTT doorbell message reset."), "the blank-message reset is logged at info");
      });

      test("invalid JSON is caught, logged, and writes nothing", async () => {

        built = await buildDoorbell({ userOptions: messagesOn });

        const set = built.mqtt.subscriptions.find((subscription) => (subscription.kind === "set") && (subscription.topic === mac + "/message/set"));

        assert.ok(set, "the /message SET subscription registered");

        // A malformed JSON rawValue trips the JSON.parse catch: the body logs the invalid-JSON error and returns before setMessage.
        await built.mqtt.invokeSet(mac + "/message/set", "{bad");

        assert.equal(built.cameraProjection.updateCalls.length, 0, "invalid JSON writes nothing to the doorbell");
        assert.ok(loggedAt(built.logEntries, "error", "Unable to process MQTT message"), "invalid JSON is reported at error");
        assert.ok(loggedAt(built.logEntries, "error", "Invalid JSON."), "the invalid-JSON branch names the JSON failure");
      });

      test("a payload missing the message key is rejected and writes nothing", async () => {

        built = await buildDoorbell({ userOptions: messagesOn });

        const set = built.mqtt.subscriptions.find((subscription) => (subscription.kind === "set") && (subscription.topic === mac + "/message/set"));

        assert.ok(set, "the /message SET subscription registered");

        // Valid JSON, but no "message" key: the message is undefined, so the typeof message !== "string" guard rejects it before setMessage. The missing-key case now
        // shares the same string-typed guard as the wrong-type cases below, so it is netted here as one of them rather than left uncovered.
        const payload = JSON.stringify({ duration: 10 });

        await built.mqtt.invokeSet(mac + "/message/set", payload);

        assert.equal(built.cameraProjection.updateCalls.length, 0, "a payload with no message key writes nothing");
        assert.ok(loggedAt(built.logEntries, "error", "Unable to process MQTT message"), "a missing message key is reported at error");
      });

      test("a non-numeric string duration is rejected and writes nothing", async () => {

        built = await buildDoorbell({ userOptions: messagesOn });

        const set = built.mqtt.subscriptions.find((subscription) => (subscription.kind === "set") && (subscription.topic === mac + "/message/set"));

        assert.ok(set, "the /message SET subscription registered");

        // A duration of "abc" is present but not a number, so the typeof-duration guard rejects it - without it, "abc" * 1000 would evaluate to NaN, which setMessage
        // would map to a never-expiring message.
        const payload = JSON.stringify({ duration: "abc", message: "Back soon" });

        await built.mqtt.invokeSet(mac + "/message/set", payload);

        assert.equal(built.cameraProjection.updateCalls.length, 0, "a non-numeric string duration writes nothing");
        assert.ok(loggedAt(built.logEntries, "error", "Unable to process MQTT message"), "a non-numeric duration is reported at error");
      });

      test("a non-string message is rejected and writes nothing", async () => {

        built = await buildDoorbell({ userOptions: messagesOn });

        const set = built.mqtt.subscriptions.find((subscription) => (subscription.kind === "set") && (subscription.topic === mac + "/message/set"));

        assert.ok(set, "the /message SET subscription registered");

        // A message of 42 is present but not a string, so the typeof-message guard rejects it - a presence-only check would let it slip past, since 42 is neither
        // undefined nor an empty string.
        const payload = JSON.stringify({ duration: 5, message: 42 });

        await built.mqtt.invokeSet(mac + "/message/set", payload);

        assert.equal(built.cameraProjection.updateCalls.length, 0, "a non-string message writes nothing");
        assert.ok(loggedAt(built.logEntries, "error", "Unable to process MQTT message"), "a non-string message is reported at error");
      });

      test("a numeric-looking string duration is rejected per the documented numeric contract", async () => {

        built = await buildDoorbell({ userOptions: messagesOn });

        const set = built.mqtt.subscriptions.find((subscription) => (subscription.kind === "set") && (subscription.topic === mac + "/message/set"));

        assert.ok(set, "the /message SET subscription registered");

        // The blessed behavior-narrowing: "30" is a numeric-looking STRING, and the typeof-duration guard rejects it rather than accepting it through arithmetic
        // coercion ("30" * 1000 === 30000), since the documented contract has always required a numeric duration.
        const payload = JSON.stringify({ duration: "30", message: "Back soon" });

        await built.mqtt.invokeSet(mac + "/message/set", payload);

        assert.equal(built.cameraProjection.updateCalls.length, 0, "a numeric-looking string duration writes nothing");
        assert.ok(loggedAt(built.logEntries, "error", "Unable to process MQTT message"), "a stringly-typed duration is reported at error");
      });
    });
  });

  describe("the LCD message switch net (self-re-syncing expiry, clear, and stale sync)", () => {

    // The rest of a truthy doorbell-settings shape, so getMessages sees a valid source; the saved messages each case seeds are what materialize the switches.
    // defaultMessageResetTimeoutMs supplies the switch duration, since the controller's own allMessages entries carry a text and a type and no duration of their own.
    const settingsShell = { customImages: [], customMessages: [], defaultMessageResetTimeoutMs: 60000, defaultMessageText: "" };
    const backSoon = "CUSTOM_MESSAGE.Back soon";
    const away = "CUSTOM_MESSAGE.Away";

    // Build a doorbell with an LCD screen and one or two messages saved on the controller plus the Doorbell.Messages option, so getMessages materializes a message
    // switch per saved entry, subtyped as its type and text.
    const buildMessageDoorbell = async (messages: { text: string; type: string }[]): Promise<BuiltDoorbell> => {

      return buildDoorbell({ doorbellSettings: { allMessages: messages, ...settingsShell }, featureFlags: { hasLcdScreen: true },
        userOptions: ["Enable.Doorbell.Messages"] });
    };

    test("clears every message switch when the active message reaches its resetAt deadline", async () => {

      built = await buildMessageDoorbell([{ text: "Back soon", type: "CUSTOM_MESSAGE" }]);

      const messageSwitch = built.accessory.getServiceById(Service.Switch, backSoon);

      assert.ok(messageSwitch, "the seeded user message materializes a message switch");

      const t0 = built.clock.now();

      // Set the message through its switch (a write-through the observer never sees), then push the controller's echo carrying the resetAt: the observer wakes, turns
      // the switch on, and arms the self-re-syncing expiry timer.
      await triggerSet(messageSwitch.getCharacteristic(Characteristic.On), true);
      built.nvr.client.state.pushCameraPatch(built.cameraConfig.id, { lcdMessage: { resetAt: t0 + 30000, text: "Back soon", type: "CUSTOM_MESSAGE" } });
      await settle();

      assert.equal(messageSwitch.getCharacteristic(Characteristic.On).value, true, "the echoed active message turns its switch on");

      // Past the deadline, the expiry timer fires and re-reads live truth: the resetAt is now in the past, so it blanks the switch.
      built.clock.advance(30001);

      assert.equal(messageSwitch.getCharacteristic(Characteristic.On).value, false, "the switch clears when the message's resetAt passes, with no controller patch");
    });

    test("arms one expiry timer for the full remaining time when the deadline lies past the platform timer ceiling", async () => {

      built = await buildMessageDoorbell([{ text: "Back soon", type: "CUSTOM_MESSAGE" }]);

      const messageSwitch = built.accessory.getServiceById(Service.Switch, backSoon);

      assert.ok(messageSwitch, "the seeded user message materializes a message switch");

      // A deadline a minute past the ceiling. The clock's requested ledger records every delay asked of it, whichever subsystem armed it, so the row reads the expiry's
      // delay by value: the full remaining time is asked for once, and the ceiling never is.
      const remaining = TIMER_DELAY_MAX_MS + 60000;

      built.nvr.client.state.pushCameraPatch(built.cameraConfig.id,
        { lcdMessage: { resetAt: built.clock.now() + remaining, text: "Back soon", type: "CUSTOM_MESSAGE" } });
      await settle();

      assert.equal(messageSwitch.getCharacteristic(Characteristic.On).value, true, "the far-off message turns its switch on, so the expiry is armed");
      assert.equal(built.clock.requested.filter((ms) => ms === remaining).length, 1, "the expiry is one timer for the full remaining time");
      assert.ok(!built.clock.requested.includes(TIMER_DELAY_MAX_MS), "no timer is armed at the platform timer ceiling");
    });

    test("clears the message switches on a null wire clear", async () => {

      built = await buildMessageDoorbell([{ text: "Back soon", type: "CUSTOM_MESSAGE" }]);

      const messageSwitch = built.accessory.getServiceById(Service.Switch, backSoon);

      assert.ok(messageSwitch, "the seeded user message materializes a message switch");

      // Activate the message via the controller echo.
      built.nvr.client.state.pushCameraPatch(built.cameraConfig.id, { lcdMessage: { resetAt: built.clock.now() + 30000, text: "Back soon", type: "CUSTOM_MESSAGE" } });
      await settle();

      assert.equal(messageSwitch.getCharacteristic(Characteristic.On).value, true, "the message switch is on before the clear");

      // A null wire clear replaces the record wholesale and wakes the observer, which reads the absent message as a clear and blanks the switch - a guard that only
      // checked the whole payload's truthiness would skip this case. The controller can send lcdMessage: null even though the projection type models only the object
      // shape, so the null is cast at this boundary.
      built.nvr.client.state.pushCameraPatch(built.cameraConfig.id, { lcdMessage: null } as unknown as Partial<ProtectCameraConfig>);
      await settle();

      assert.equal(messageSwitch.getCharacteristic(Characteristic.On).value, false, "a null wire clear turns the message switch off");
    });

    test("latches no switch on when the observed message is already expired at sync time", async () => {

      built = await buildMessageDoorbell([{ text: "Back soon", type: "CUSTOM_MESSAGE" }]);

      const messageSwitch = built.accessory.getServiceById(Service.Switch, backSoon);

      assert.ok(messageSwitch, "the seeded user message materializes a message switch");

      // A message whose resetAt is already in the past when the observer first sees it (a restart after the message expired while the plugin was down): the sync reads it
      // as a clear, so no switch latches on.
      built.nvr.client.state.pushCameraPatch(built.cameraConfig.id, { lcdMessage: { resetAt: built.clock.now() - 1000, text: "Back soon", type: "CUSTOM_MESSAGE" } });
      await settle();

      assert.equal(messageSwitch.getCharacteristic(Characteristic.On).value !== true, true, "an already-expired message latches no switch on at sync time");
    });

    test("logs a set message's remaining duration in seconds when it carries a numeric resetAt", async () => {

      built = await buildMessageDoorbell([{ text: "Back soon", type: "CUSTOM_MESSAGE" }]);

      const messageSwitch = built.accessory.getServiceById(Service.Switch, backSoon);

      assert.ok(messageSwitch, "the seeded user message materializes a message switch");

      // The harness clock holds still through the row, so a resetAt 30 seconds past its instant renders as exactly 30 seconds.
      built.nvr.client.state.pushCameraPatch(built.cameraConfig.id, { lcdMessage: { resetAt: built.clock.now() + 30000, text: "Back soon", type: "CUSTOM_MESSAGE" } });
      await settle();

      assert.equal(messageSwitch.getCharacteristic(Characteristic.On).value, true, "the echoed message turns its switch on, which is where the set is logged");
      assert.ok(loggedAt(built.logEntries, "info", "Doorbell message set (30 seconds): Back soon."), "the set line carries the message's remaining duration in seconds");
    });

    test("logs a set message with no duration when it carries no resetAt", async () => {

      built = await buildMessageDoorbell([{ text: "Back soon", type: "CUSTOM_MESSAGE" }]);

      const messageSwitch = built.accessory.getServiceById(Service.Switch, backSoon);

      assert.ok(messageSwitch, "the seeded user message materializes a message switch");

      // A message with no resetAt never expires, so the expiry predicate passes it through as it stands and the set line has no deadline to render.
      built.nvr.client.state.pushCameraPatch(built.cameraConfig.id, { lcdMessage: { text: "Back soon", type: "CUSTOM_MESSAGE" } });
      await settle();

      assert.equal(messageSwitch.getCharacteristic(Characteristic.On).value, true, "the echoed message turns its switch on, which is where the set is logged");
      assert.ok(loggedAt(built.logEntries, "info", "Doorbell message set: Back soon."), "the set line names the message with no duration");
      assert.ok(!loggedAt(built.logEntries, "info", "seconds)"), "no set line renders a duration for a message with no deadline");
    });

    test("a replacement message moves the expiry deadline and survives the superseded message's original deadline", async () => {

      built = await buildMessageDoorbell([ { text: "Back soon", type: "CUSTOM_MESSAGE" }, { text: "Away", type: "CUSTOM_MESSAGE" } ]);

      const first = built.accessory.getServiceById(Service.Switch, backSoon);
      const second = built.accessory.getServiceById(Service.Switch, away);

      assert.ok(first && second, "both seeded user messages materialize switches");

      const t0 = built.clock.now();

      // Message A active with a deadline at T1 = t0 + 30s.
      built.nvr.client.state.pushCameraPatch(built.cameraConfig.id, { lcdMessage: { resetAt: t0 + 30000, text: "Back soon", type: "CUSTOM_MESSAGE" } });
      await settle();

      // Replacement B active with a later deadline at T2 = t0 + 90s: the clear-then-set re-arm cancels A's timer and schedules B's, and the switches swap.
      built.nvr.client.state.pushCameraPatch(built.cameraConfig.id, { lcdMessage: { resetAt: t0 + 90000, text: "Away", type: "CUSTOM_MESSAGE" } });
      await settle();

      assert.equal(first.getCharacteristic(Characteristic.On).value, false, "the superseded message's switch is off after the replacement");
      assert.equal(second.getCharacteristic(Characteristic.On).value, true, "the replacement message's switch is on");

      // Cross A's ORIGINAL deadline: B's switch must be untouched - a stale A timer left un-cleared would have blanked it here.
      built.clock.advance(30001);

      assert.equal(second.getCharacteristic(Characteristic.On).value, true, "the replacement's switch survives past the superseded message's original deadline");

      // Cross B's deadline: now the active message expires and its switch clears.
      built.clock.advance(60000);

      assert.equal(second.getCharacteristic(Characteristic.On).value, false, "the replacement's switch clears at its own moved deadline");
    });

    test("the capability's teardown drains the pending expiry timer, so no post-teardown fire writes to the message switches", async () => {

      built = await buildMessageDoorbell([{ text: "Back soon", type: "CUSTOM_MESSAGE" }]);

      const messageSwitch = built.accessory.getServiceById(Service.Switch, backSoon);

      assert.ok(messageSwitch, "the seeded user message materializes a message switch");

      // Activate the message via the controller echo, arming the self-re-syncing expiry timer.
      built.nvr.client.state.pushCameraPatch(built.cameraConfig.id, { lcdMessage: { resetAt: built.clock.now() + 30000, text: "Back soon", type: "CUSTOM_MESSAGE" } });
      await settle();

      assert.equal(messageSwitch.getCharacteristic(Characteristic.On).value, true, "the echoed active message turns its switch on before the teardown");

      // The teardown runs through the capability itself rather than through its hosting camera, so the assertion rests on the capability's own unwinding: aborting its
      // controller drains the registry holding the expiry deadline alongside its observers and MQTT handlers. A deadline surviving that drain would fire against a
      // torn-down capability and blank this switch, so the ON value outliving the deadline is what proves the drain.
      const capability = built.doorbell.doorbell;

      assert.ok(capability, "the isDoorbell config attached the capability whose teardown is under test");

      capability.cleanup();
      built.clock.advance(30001);

      assert.equal(messageSwitch.getCharacteristic(Characteristic.On).value, true, "no expiry fire touches a message switch after the capability's cleanup");
    });

    test("the MQTT message GET reports the empty string once the message's resetAt is past", async () => {

      built = await buildMessageDoorbell([{ text: "Back soon", type: "CUSTOM_MESSAGE" }]);

      const get = built.mqtt.subscriptions.find((subscription) => (subscription.kind === "get") && (subscription.topic === "74ACB9000001/message/get"));

      assert.ok(get, "the doorbell registered a /message GET subscription");

      const t0 = built.clock.now();

      built.nvr.client.state.pushCameraPatch(built.cameraConfig.id, { lcdMessage: { resetAt: t0 + 30000, text: "Back soon", type: "CUSTOM_MESSAGE" } });
      await settle();

      assert.deepEqual(JSON.parse(await built.mqtt.invokeGet("74ACB9000001/message/get") ?? ""), { duration: 30, message: "Back soon" },
        "the GET reports the active message's remaining duration while it is live");

      // Advance past the deadline. The GET runs the slice through the same expiry predicate, so an expired message reports the empty string rather than a stale
      // negative duration.
      built.clock.advance(30001);

      assert.equal(await built.mqtt.invokeGet("74ACB9000001/message/get"), "", "the GET reports the empty string once the message has expired");
    });

    // Declared-not-reproducible: the empty-object no-wake path (an lcdMessage: {} patch the reducer's structural sharing collapses to the same record, so the store never
    // wakes the observer) cannot be exercised here - the harness's shallow merge cannot mirror the reducer's reference-preserving merge, and building a second reducer
    // mirror is the anti-pattern this suite avoids. That path self-heals only via the 120-second bootstrap-refresh reconcile, and capturing the real {}-vs-null wire
    // shape is HJD's rig item.
  });

  describe("the doorbell's held state stated as it is built and restated per broker session", () => {

    const doorbellId = "test-camera-1";
    const settingsShell = { customImages: [], customMessages: [], defaultMessageResetTimeoutMs: 60000, defaultMessageText: "" };
    const both = [ "Enable.Doorbell.Messages", "Enable.Doorbell.Volume.Dimmer" ];

    // A chime serving this doorbell at a known volume, and a doorbell with an LCD screen and one saved message, so a showing message can match a switch or not.
    interface StatedOptions {

      disconnected?: boolean;
      lcdMessage?: { resetAt?: null; text: string; type: string };
      noChime?: boolean;
      userOptions: string[];
    }

    const buildStatedDoorbell = async (options: StatedOptions): Promise<BuiltDoorbell> => {

      const chime = makeChimeConfig({ cameraIds: [doorbellId], ringSettings: [{ cameraId: doorbellId, ringtoneId: "tone-a", volume: 20 }] });

      return buildDoorbell({ chimeConfigs: options.noChime ? [] : [chime], disconnected: options.disconnected ?? false,
        doorbellSettings: { allMessages: [{ text: "Back soon", type: "CUSTOM_MESSAGE" }], ...settingsShell }, featureFlags: { hasLcdScreen: true },
        ...(options.lcdMessage ? { lcdMessage: options.lcdMessage } : {}), userOptions: options.userOptions });
    };

    // Flip the double's session lever off and back on, settling after each edge so the connect handlers have run.
    const restoreSession = async (mqtt: TestMqttClient): Promise<void> => {

      mqtt.connected = false;
      await settle();
      mqtt.connected = true;
      await settle();
    };

    // The payloads a list of recorded publishes carries on one topic.
    const payloads = (entries: TestMqttClient["published"], suffix: string): string[] => {

      return entries.filter((entry) => entry.topic.endsWith(suffix)).map((entry) => entry.payload.toString());
    };

    // The registration kinds the double holds on a topic's get and set children, which is whether the topic answers or accepts anything from the broker at all.
    const registrations = (doorbell: BuiltDoorbell, topic: string): string[] => {

      return doorbell.mqtt.subscriptions.filter((subscription) => subscription.topic.startsWith(doorbell.cameraConfig.mac + topic + "/"))
        .map((subscription) => subscription.kind);
    };

    test("built with both features and a showing message that matches a switch, it states the chime volume and the message once each", async () => {

      built = await buildStatedDoorbell({ lcdMessage: { resetAt: null, text: "Back soon", type: "CUSTOM_MESSAGE" }, userOptions: both });

      assert.deepEqual(payloads(built.stated, "/chime"), ["20"], "the chime volume is stated once as the doorbell is built");
      assert.deepEqual(payloads(built.stated, "/message"), [JSON.stringify({ duration: 0, message: "Back soon" })],
        "the switch sync states the matching message once, in the get's shape");
    });

    test("built with a showing message that matches no switch, it states that message once", async () => {

      built = await buildStatedDoorbell({ lcdMessage: { resetAt: null, text: "Elsewhere", type: "CUSTOM_MESSAGE" }, userOptions: both });

      assert.deepEqual(payloads(built.stated, "/message"), [JSON.stringify({ duration: 0, message: "Elsewhere" })], "the unmatched message is stated once");
    });

    test("with no message it states none, a restore restates the chime volume once and no message or event, and an unchanged volume records nothing", async () => {

      built = await buildStatedDoorbell({ userOptions: both });

      assert.equal(payloads(built.stated, "/message").length, 0, "no message is stated when none shows");

      await restoreSession(built.mqtt);

      assert.deepEqual(payloads(built.mqtt.published, "/chime"), ["20"], "the restore restates the chime volume once");
      assert.equal(payloads(built.mqtt.published, "/message").length, 0, "a doorbell with no message restates no message");
      assert.equal(payloads(built.mqtt.published, "/doorbell").length, 0, "no event topic is restated");

      const [chime] = built.chimeProjections;

      assert.ok(chime, "the doorbell is served by one chime");

      const recorded = built.mqtt.published.length;

      // A chime change that leaves this doorbell's volume where it was is one the volume observer never sees, so this holds only that such a change records nothing.
      // That the gate suppresses an unchanged statement is held by the owner spine's own rows in device-mqtt-topic.test.ts.
      built.store.pushChimePatch(chime.id, { ringSettings: [{ cameraId: doorbellId, repeatTimes: 2, ringtoneId: "tone-a", volume: 20 }] });
      await settle();

      assert.equal(built.mqtt.published.length, recorded, "a chime change leaving the volume where it was records nothing");
    });

    test("built while no session is held, it records nothing until the session starts, then its chime volume and showing message once each", async () => {

      built = await buildStatedDoorbell({ disconnected: true, lcdMessage: { resetAt: null, text: "Back soon", type: "CUSTOM_MESSAGE" }, userOptions: both });

      assert.equal(built.stated.length, 0, "the statements made with no session held are refused");

      built.mqtt.connected = true;
      await settle();

      assert.deepEqual(payloads(built.mqtt.published, "/chime"), ["20"], "the first session states the chime volume once");
      assert.deepEqual(payloads(built.mqtt.published, "/message"), [JSON.stringify({ duration: 0, message: "Back soon" })],
        "the first session states the showing message once");
    });

    test("a chime volume changed while the session is down is restated once, as the current value, when the session returns", async () => {

      built = await buildStatedDoorbell({ userOptions: both });

      const [chime] = built.chimeProjections;

      assert.ok(chime, "the doorbell is served by one chime");

      built.mqtt.connected = false;
      built.store.pushChimePatch(chime.id, { ringSettings: [{ cameraId: doorbellId, repeatTimes: 1, ringtoneId: "tone-a", volume: 70 }] });
      await settle();

      assert.equal(payloads(built.mqtt.published, "/chime").length, 0, "the change made with no session held is refused");

      built.mqtt.connected = true;
      await settle();

      assert.deepEqual(payloads(built.mqtt.published, "/chime"), ["70"], "the returning session hears the current value once");
    });

    test("a session restore restates a showing message once", async () => {

      built = await buildStatedDoorbell({ lcdMessage: { resetAt: null, text: "Elsewhere", type: "CUSTOM_MESSAGE" }, userOptions: both });

      await restoreSession(built.mqtt);

      assert.deepEqual(payloads(built.mqtt.published, "/message"), [JSON.stringify({ duration: 0, message: "Elsewhere" })], "the restore restates the message once");
    });

    test("with both features off it states neither topic as it is built or at a session restore, whatever shows", async () => {

      built = await buildStatedDoorbell({ lcdMessage: { resetAt: null, text: "Back soon", type: "CUSTOM_MESSAGE" },
        userOptions: [ "Disable.Doorbell.Messages", "Disable.Doorbell.Volume.Dimmer" ] });

      await restoreSession(built.mqtt);

      for(const suffix of [ "/chime", "/message" ]) {

        assert.equal(payloads([ ...built.stated, ...built.mqtt.published ], suffix).length, 0, "a disabled feature's topic states nothing");
      }
    });

    test("without Doorbell.Volume.Dimmer the chime topic has no get or set and states nothing as built, on a change, or at a session restore", async () => {

      built = await buildStatedDoorbell({ lcdMessage: { resetAt: null, text: "Elsewhere", type: "CUSTOM_MESSAGE" }, userOptions: ["Enable.Doorbell.Messages"] });

      assert.deepEqual(registrations(built, "/chime"), [], "the chime topic has no get and no set without the volume dimmer");
      assert.deepEqual(registrations(built, "/message"), [ "get", "set" ], "the message topic, whose feature is on, registers its get and its set");
      assert.deepEqual(payloads(built.stated, "/message"), [JSON.stringify({ duration: 0, message: "Elsewhere" })], "the enabled message topic is stated as built");

      const [chime] = built.chimeProjections;

      assert.ok(chime, "the doorbell is served by one chime");

      built.store.pushChimePatch(chime.id, { ringSettings: [{ cameraId: doorbellId, repeatTimes: 1, ringtoneId: "tone-a", volume: 70 }] });
      await settle();
      await restoreSession(built.mqtt);

      assert.equal(payloads([ ...built.stated, ...built.mqtt.published ], "/chime").length, 0, "no chime volume is stated as built, on the change, or at the restore");
    });

    test("without Doorbell.Messages the message topic has no get or set and states nothing as built, on a change, or at a session restore", async () => {

      built = await buildStatedDoorbell({ lcdMessage: { resetAt: null, text: "Back soon", type: "CUSTOM_MESSAGE" }, userOptions: ["Enable.Doorbell.Volume.Dimmer"] });

      assert.deepEqual(registrations(built, "/message"), [], "the message topic has no get and no set without the messages feature");
      assert.deepEqual(registrations(built, "/chime"), [ "get", "set" ], "the chime topic, whose feature is on, registers its get and its set");
      assert.deepEqual(payloads(built.stated, "/chime"), ["20"], "the enabled chime topic is stated as built");

      built.store.pushCameraPatch(built.cameraConfig.id, { lcdMessage: { text: "Elsewhere", type: "CUSTOM_MESSAGE" } });
      await settle();
      await restoreSession(built.mqtt);

      assert.equal(payloads([ ...built.stated, ...built.mqtt.published ], "/message").length, 0, "no message is stated as built, on the change, or at the restore");
    });

    test("with the volume dimmer and no chime assigned it states and restates no chime volume", async () => {

      built = await buildStatedDoorbell({ noChime: true, userOptions: both });

      await restoreSession(built.mqtt);

      assert.equal(payloads([ ...built.stated, ...built.mqtt.published ], "/chime").length, 0, "no chime rings for this doorbell, so no volume is stated");
    });

    test("with the volume dimmer and only an assigned chime that carries no ring for this doorbell it states and restates no chime volume", async () => {

      // The chime lists this doorbell but rings only for another, so the volume reads 0 with no setting behind it. A ring check that read the assignment alone would
      // state that 0 here, where the no-chime row above cannot tell the difference.
      const noRing = makeChimeConfig({ cameraIds: [ doorbellId, "doorbell-2" ], ringSettings: [{ cameraId: "doorbell-2", volume: 60 }] });

      built = await buildDoorbell({ chimeConfigs: [noRing], userOptions: ["Enable.Doorbell.Volume.Dimmer"] });

      await restoreSession(built.mqtt);

      assert.equal(payloads([ ...built.stated, ...built.mqtt.published ], "/chime").length, 0,
        "a chime with no ring for this doorbell states no volume, built or restored");
    });
  });
});

describe("the effectiveLcdMessage expiry predicate (pure truth table)", () => {

  test("passes a message with no resetAt through unchanged", () => {

    const message = { text: "Back soon", type: "CUSTOM_MESSAGE" };

    assert.deepEqual(effectiveLcdMessage({ lcdMessage: message, nowMs: 1000 }), message, "a non-expiring message (no resetAt) is returned unchanged");
  });

  test("passes a message with a future resetAt through unchanged", () => {

    const message = { resetAt: 5000, text: "Back soon", type: "CUSTOM_MESSAGE" };

    assert.deepEqual(effectiveLcdMessage({ lcdMessage: message, nowMs: 1000 }), message, "a message whose resetAt is still ahead is returned unchanged");
  });

  test("blanks a message whose resetAt has already passed", () => {

    assert.deepEqual(effectiveLcdMessage({ lcdMessage: { resetAt: 500, text: "Back soon", type: "CUSTOM_MESSAGE" }, nowMs: 1000 }), {},
      "a past resetAt reads as a clear");
  });

  test("blanks a message whose resetAt is exactly now", () => {

    assert.deepEqual(effectiveLcdMessage({ lcdMessage: { resetAt: 1000, text: "Back soon", type: "CUSTOM_MESSAGE" }, nowMs: 1000 }), {},
      "a resetAt equal to now is expired (the boundary is inclusive)");
  });
});
