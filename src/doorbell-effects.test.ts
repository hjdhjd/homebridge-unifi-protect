/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * doorbell-effects.test.ts: The doorbell capability's observer-effect net - the two netteable observer reflections (physical-chime duration, chime volume) and the
 * doorbell-trigger ring - against the REAL constructed ProtectCamera-plus-DoorbellCapability.
 *
 * The doorbell capability registers four observers (doorbell.ts:262-291). Their WAKE is netted by doorbell-construction.test.ts; this suite nets the two reflections
 * whose EFFECT is observable without a controller write surface: chimeDuration -> updatePhysicalChimes (the mutually-exclusive physical-chime switch fan-out) and
 * chimeVolume -> updateChimeVolume (the volume Lightbulb's On + Brightness). The lcdMessage reflection is NOT nettable here (updateLcdSwitch iterates messageSwitches,
 * which getMessages leaves empty unless nvr.ufp.doorbellSettings is seeded - a harness add this Tier does not make), so it is owned by Tier 2; the hasPackageCamera
 * reflection is a lifecycle reconcile already netted by the family construction suite.
 *
 * The doorbell-trigger ring onSet is also netted here: triggering the switch with a truthy value fires nvr.events.doorbellEventHandler(this) - it writes no
 * accessory.context and never touches the controller. The ring is captured through a TEST-LOCAL ProtectEventDispatch subclass that overrides doorbellEventHandler into a
 * recording array (the pattern event-dispatch.test.ts established), injected through makeTestNvr's dispatch seam and read back off nvr.events - NOT the shared
 * TestRecordingDispatch, which overrides only motionEventHandler. The override captures the routing (which device the ring fired for); it deliberately does not
 * re-test the handler's HomeKit effects, which are event-dispatch.ts's own concern.
 *
 * The vacuity gate is two-part (carried from the device-* law): every gated reflection HARD-asserts its gated service or switch EXISTS as the FIRST discriminator (a
 * non-optional assert.ok, so an absent service throws here rather than passing vacuously) and pairs with a without-gate test that proves the same push produces nothing
 * when the precondition is omitted. The chime-volume push MUST move the computed mean, because the volume selector dedups on the COMPUTED volume - a push that leaves the
 * mean unchanged would never wake the observer, making the assertion vacuous.
 *
 * Every constructed doorbell is unwound through cleanup() plus the harness abort in an afterEach, so no observe loop outlives the test.
 */
import type { Camera, ProtectCameraConfig, ProtectChimeConfig } from "unifi-protect";
import { Characteristic, Service, TestCameraProjection, TestChimeProjection, TestStateStore, makeCameraConfig, makeChimeConfig, makeProtectState, makeTestAccessory,
  makeTestNvr, settle } from "./testing.helpers.ts";
import type { TestAccessory, TestLogEntry, TestMqttClient, TestProtectNvr } from "./testing.helpers.ts";
import { afterEach, describe, mock, test } from "node:test";
import { G2_PRO_CHANNELS } from "./resolution.fixtures.ts";
import type { Nullable } from "homebridge-plugin-utils";
import type { ProtectAccessory } from "./types.ts";
import { ProtectAuthorizationError } from "unifi-protect";
import { ProtectCamera } from "./devices/camera.ts";
import { ProtectEventDispatch } from "./event-dispatch.ts";
import type { ProtectNvr } from "./nvr.ts";
import { ProtectReservedNames } from "./types.ts";
import assert from "node:assert/strict";

// One captured doorbell-ring routing. The onSet's observable effect is which device it routed to, so this is the shape the recording subclass captures - the same posture
// event-dispatch.test.ts uses for its own routing assertions.
interface RingCall {

  id: string;
}

// A REAL ProtectEventDispatch whose doorbell delivery is overridden to record rather than touch HomeKit or arm a ring timer. The override's arity and parameter types
// mirror production's doorbellEventHandler (event-dispatch.ts:523) exactly, so it type-checks as a true override; the camera's doorbell-trigger onSet calls
// this.nvr.events.doorbellEventHandler(this), so this captures exactly that routing without firing the real ring's HomeKit effects.
class RecordingRingDispatch extends ProtectEventDispatch {

  public readonly rings: RingCall[] = [];

  public override doorbellEventHandler(protectDevice: ProtectCamera): void {

    this.rings.push({ id: protectDevice.ufp.id });
  }
}

// The construction handles a test holds, so the afterEach can unwind the per-accessory abort regardless of which build the test ran. chimeProjections are the HELD chime
// doubles the doorbell's cross-device setChimeVolume writes through (one per seeded chime config, in order) - the test asserts each projection's updateCalls and sets its
// updateRejection lever on the SAME instance the write hits. logEntries and mqtt are the write-drive's additional read surface: the write reports its failure through the
// shared command-error log (logEntries) and publishes the new volume through the MQTT double (mqtt) on success.
interface BuiltDoorbell {

  accessory: TestAccessory;
  cameraConfig: ProtectCameraConfig;
  // The camera's read-through projection, the SAME instance the doorbell's #device write-through reaches (camera.ts:280 passes this.device into
  // createDoorbellCapability), so the /message SET's setMessage -> this.#device.update lands on this projection's updateCalls. Exposed for the /message assertions.
  cameraProjection: TestCameraProjection;
  chimeProjections: TestChimeProjection[];
  controller: AbortController;
  doorbell: ProtectCamera;
  logEntries: TestLogEntry[];
  mqtt: TestMqttClient;
  nvr: TestProtectNvr;
}

// A log assertion matches a substring of the single formatted parameter at the given level, mirroring camera-onsets.test.ts / chime.test.ts: the device log wrapper
// formats every line into one string parameter, so we narrow to that one and substring-match it.
function loggedAt(entries: TestLogEntry[], level: TestLogEntry["level"], substring: string): boolean {

  return entries.some((entry) => (entry.level === level) && (typeof entry.parameters[0] === "string") && entry.parameters[0].includes(substring));
}

// Build a REAL ProtectCamera against an isDoorbell-true config (so it construction-attaches its DoorbellCapability), exactly as doorbell-construction.test.ts:35-65
// assembles it: the doorbell camera config (with the test's extra feature flags merged over isDoorbell), an optional chime serving it, the v5 store double, the typed
// NVR / platform doubles with the test's userOptions threaded into the REAL FeatureOptions engine and an optional dispatch factory, the read-through projection, and a
// fresh accessory. The casts are confined to this seam - the instance is the production ProtectCamera and its composed capability.
async function buildDoorbell(options: { chimeConfigs?: ProtectChimeConfig[]; dispatch?: (nvr: ProtectNvr) => ProtectEventDispatch;
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
  const { controller, logEntries, mqtt, nvr } = makeTestNvr({ chimes: chimeProjections, ...(options.dispatch ? { dispatch: options.dispatch } : {}), mqtt: true, store,
    userOptions: options.userOptions });
  const accessory = makeTestAccessory("Front Door", "uuid:74ACB9000001");
  const projection = new TestCameraProjection(cameraConfig.id, store);
  const doorbell = new ProtectCamera(nvr as unknown as ProtectNvr, accessory as unknown as ProtectAccessory, projection as unknown as Camera);

  // Settle the floating configure IIFE, the capability's configure, and the observe loops' lazy registration before any push so the doorbell is fully wired.
  await settle();

  assert.ok(mqtt, "the MQTT recording double is installed");

  return { accessory, cameraConfig, cameraProjection: projection, chimeProjections, controller, doorbell, logEntries, mqtt, nvr };
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

      // The doorbell census: the camera's plain set (ten, including the always-armed isDoorbell observer and the bare-motion lastMotion observer) plus the base pair plus
      // the capability's four = sixteen. A drift here means an extra or missing observer slipped in.
      assert.equal(built.nvr.client.state.observerCount, 16, "the doorbell wires exactly sixteen observers (the camera ten, the base pair, and the capability four)");

      // HARD-assert all three physical-chime switches exist FIRST: the gate is hasChime && hasFeature("Doorbell.PhysicalChime") (doorbell.ts:526). An absent service
      // would let the value assertions pass vacuously.
      const none = built.accessory.getServiceById(Service.Switch, ProtectReservedNames.SWITCH_DOORBELL_CHIME_NONE);
      const mechanical = built.accessory.getServiceById(Service.Switch, ProtectReservedNames.SWITCH_DOORBELL_CHIME_MECHANICAL);
      const digital = built.accessory.getServiceById(Service.Switch, ProtectReservedNames.SWITCH_DOORBELL_CHIME_DIGITAL);

      assert.ok(none, "hasChime plus Enable.Doorbell.PhysicalChime materializes the NONE physical-chime switch");
      assert.ok(mechanical, "the MECHANICAL physical-chime switch materializes");
      assert.ok(digital, "the DIGITAL physical-chime switch materializes");

      // makeCameraConfig seeds chimeDuration 0, which is the NONE duration, so the NONE switch starts On. Push 300 - the MECHANICAL duration (a constant,
      // doorbell.ts:816) - which wakes the chimeDuration observer -> updatePhysicalChimes -> the fan-out (On === (chimeDuration === getPhysicalChimeDuration(type))).
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

      // HARD-assert the volume Lightbulb exists FIRST: the gate is hasFeature("Doorbell.Volume.Dimmer") (doorbell.ts:603). An absent service would let the value
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
    // list "test-camera-1" in its cameraIds and key its ring there, and the publish rides the "74ACB9000001/chime" topic. These literals are load-bearing - a mismatch
    // makes the filter / find skip every chime and the write becomes vacuous, which the single-chime case's captured payload proves against directly.
    const doorbellId = "test-camera-1";
    const chimeTopic = "74ACB9000001/chime";

    // Each test resolves the materialized volume Lightbulb inline and HARD-asserts it exists FIRST (the gate is hasFeature("Doorbell.Volume.Dimmer")): an absent service
    // would let the write assertions pass vacuously. The Brightness onSet routes straight to setChimeVolume(value), so a triggerSet on it drives the cross-device write.

    test("a single serving chime is PATCHed with a single-entry ringSettings carrying the modified ring, then published once", async () => {

      const chime = makeChimeConfig({ cameraIds: [doorbellId], ringSettings: [{ cameraId: doorbellId, ringtoneId: "tone-a", volume: 20 }] });

      built = await buildDoorbell({ chimeConfigs: [chime], userOptions: ["Enable.Doorbell.Volume.Dimmer"] });

      const volumeBulb = built.accessory.getServiceById(Service.Lightbulb, ProtectReservedNames.LIGHTBULB_DOORBELL_VOLUME);

      assert.ok(volumeBulb, "Enable.Doorbell.Volume.Dimmer materializes the chime-volume Lightbulb");

      const [served] = built.chimeProjections;

      assert.ok(served, "the held chime projection is present");

      await volumeBulb.getCharacteristic(Characteristic.Brightness).triggerSet(70);

      assert.deepEqual(served.updateCalls, [{ payload: { ringSettings: [{ cameraId: doorbellId, repeatTimes: 1, ringtoneId: "tone-a", volume: 70 }] } }],
        "the PATCH carries one ring entry: this doorbell's ring spread with only the volume changed to 70");
      assert.deepEqual(built.mqtt.published.filter((entry) => entry.topic === chimeTopic), [{ message: "70", topic: chimeTopic }],
        "the new volume is published once on the chime topic after the write is accepted");
      assert.ok(!loggedAt(built.logEntries, "error", "Unable to set the chime volume"), "an accepted write logs no failure");
    });

    test("a negative Brightness is clamped to zero in the written payload", async () => {

      const chime = makeChimeConfig({ cameraIds: [doorbellId], ringSettings: [{ cameraId: doorbellId, ringtoneId: "tone-a", volume: 50 }] });

      built = await buildDoorbell({ chimeConfigs: [chime], userOptions: ["Enable.Doorbell.Volume.Dimmer"] });

      const volumeBulb = built.accessory.getServiceById(Service.Lightbulb, ProtectReservedNames.LIGHTBULB_DOORBELL_VOLUME);

      assert.ok(volumeBulb, "the chime-volume Lightbulb materialized");

      const [served] = built.chimeProjections;

      assert.ok(served, "the held chime projection is present");

      // A negative Brightness reaches setChimeVolume(-15) intact - triggerSet bypasses HAP's own characteristic clamping - so it genuinely exercises the Math.max(value,
      // 0) clamp. (The On=false onSet would call setChimeVolume with a LITERAL 0, where a deleted clamp still yields 0, so it could not prove the clamp.)
      await volumeBulb.getCharacteristic(Characteristic.Brightness).triggerSet(-15);

      assert.deepEqual(served.updateCalls, [{ payload: { ringSettings: [{ cameraId: doorbellId, repeatTimes: 1, ringtoneId: "tone-a", volume: 0 }] } }],
        "a negative volume clamps to zero in the written ring PATCH");
      assert.deepEqual(built.mqtt.published.filter((entry) => entry.topic === chimeTopic), [{ message: "0", topic: chimeTopic }], "the clamped value is what we publish");
    });

    test("every chime serving this doorbell is written, and the volume is published exactly once", async () => {

      const chimeA = makeChimeConfig({ cameraIds: [doorbellId], id: "chime-a", mac: "74ACB9000201", ringSettings: [{ cameraId: doorbellId, volume: 10 }] });
      const chimeB = makeChimeConfig({ cameraIds: [ doorbellId, "doorbell-2" ], id: "chime-b", mac: "74ACB9000202",
        ringSettings: [{ cameraId: doorbellId, volume: 20 }] });

      built = await buildDoorbell({ chimeConfigs: [ chimeA, chimeB ], userOptions: ["Enable.Doorbell.Volume.Dimmer"] });

      const volumeBulb = built.accessory.getServiceById(Service.Lightbulb, ProtectReservedNames.LIGHTBULB_DOORBELL_VOLUME);

      assert.ok(volumeBulb, "the chime-volume Lightbulb materialized");

      const [ servedA, servedB ] = built.chimeProjections;

      assert.ok(servedA && servedB, "both held chime projections are present");

      await volumeBulb.getCharacteristic(Characteristic.Brightness).triggerSet(55);

      assert.equal(servedA.updateCalls.length, 1, "the first chime serving this doorbell is written");
      assert.equal(servedB.updateCalls.length, 1, "the second chime serving this doorbell is written");
      assert.deepEqual(built.mqtt.published.filter((entry) => entry.topic === chimeTopic), [{ message: "55", topic: chimeTopic }],
        "the volume is published exactly once after every assigned chime accepts the write");
    });

    test("a chime that does not serve this doorbell is left untouched", async () => {

      const foreign = makeChimeConfig({ cameraIds: ["doorbell-2"], id: "chime-foreign", mac: "74ACB9000203", ringSettings: [{ cameraId: "doorbell-2", volume: 90 }] });
      const served = makeChimeConfig({ cameraIds: [doorbellId], id: "chime-served", mac: "74ACB9000204", ringSettings: [{ cameraId: doorbellId, volume: 30 }] });

      built = await buildDoorbell({ chimeConfigs: [ foreign, served ], userOptions: ["Enable.Doorbell.Volume.Dimmer"] });

      const volumeBulb = built.accessory.getServiceById(Service.Lightbulb, ProtectReservedNames.LIGHTBULB_DOORBELL_VOLUME);

      assert.ok(volumeBulb, "the chime-volume Lightbulb materialized");

      const [ foreignProjection, servedProjection ] = built.chimeProjections;

      assert.ok(foreignProjection && servedProjection, "both held chime projections are present");

      await volumeBulb.getCharacteristic(Characteristic.Brightness).triggerSet(45);

      assert.equal(foreignProjection.updateCalls.length, 0, "the chime that does not list this doorbell is filtered out and never written");
      assert.equal(servedProjection.updateCalls.length, 1, "only the chime that serves this doorbell is written");
      assert.deepEqual(built.mqtt.published.filter((entry) => entry.topic === chimeTopic), [{ message: "45", topic: chimeTopic }], "the volume is published once");
    });

    test("a chime serving this doorbell but carrying no ring for it is skipped without a write", async () => {

      const noRing = makeChimeConfig({ cameraIds: [doorbellId], id: "chime-noring", mac: "74ACB9000205", ringSettings: [] });
      const served = makeChimeConfig({ cameraIds: [doorbellId], id: "chime-served", mac: "74ACB9000206", ringSettings: [{ cameraId: doorbellId, volume: 30 }] });

      built = await buildDoorbell({ chimeConfigs: [ noRing, served ], userOptions: ["Enable.Doorbell.Volume.Dimmer"] });

      const volumeBulb = built.accessory.getServiceById(Service.Lightbulb, ProtectReservedNames.LIGHTBULB_DOORBELL_VOLUME);

      assert.ok(volumeBulb, "the chime-volume Lightbulb materialized");

      const [ noRingProjection, servedProjection ] = built.chimeProjections;

      assert.ok(noRingProjection && servedProjection, "both held chime projections are present");

      await volumeBulb.getCharacteristic(Characteristic.Brightness).triggerSet(35);

      assert.equal(noRingProjection.updateCalls.length, 0, "the chime listing the doorbell but with no ring for it is skipped; the loop continues to the next");
      assert.equal(servedProjection.updateCalls.length, 1, "the chime carrying a ring for this doorbell is written");
      assert.deepEqual(built.mqtt.published.filter((entry) => entry.topic === chimeTopic), [{ message: "35", topic: chimeTopic }], "the volume is published once");
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

      await volumeBulb.getCharacteristic(Characteristic.Brightness).triggerSet(25);

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

      await volumeBulb.getCharacteristic(Characteristic.Brightness).triggerSet(25);

      assert.equal(built.mqtt.published.filter((entry) => entry.topic === chimeTopic).length, 0, "an authorization failure publishes nothing");
      assert.ok(loggedAt(built.logEntries, "error", "Unable to set the chime volume. Please ensure this username has the Administrator role in UniFi Protect."),
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
      await triggerSwitch.getCharacteristic(Characteristic.On).triggerSet(true);

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
      await triggerSwitch.getCharacteristic(Characteristic.On).triggerSet(false);

      assert.equal(ring.rings.length, 0, "a falsy trigger fires no ring");
    });
  });

  describe("the doorbell-capability MQTT handler bodies (the /chime and /message get/set bodies)", () => {

    // The doorbell's identity in this suite: makeCameraConfig defaults the mac to "74ACB9000001", so every captured subscription rides a "74ACB9000001/<tail>" topic and
    // the publish rides "74ACB9000001/chime". These literals are load-bearing - a mismatch makes the subscription find skip and the test reads as vacuous, which the
    // HARD-assert-exists gate catches.
    const mac = "74ACB9000001";
    const doorbellId = "test-camera-1";

    describe("the /chime GET (the chime-volume read-through)", () => {

      test("returns the doorbell's effective chime volume as a string", async () => {

        // A chime serving this doorbell at volume 50, so chimeVolume reads 50 through the live projection.
        const chime = makeChimeConfig({ cameraIds: [doorbellId], ringSettings: [{ cameraId: doorbellId, volume: 50 }] });

        built = await buildDoorbell({ chimeConfigs: [chime], userOptions: ["Enable.Doorbell.Volume.Dimmer"] });

        // HARD-assert the /chime GET subscription exists FIRST: an absent subscription whose getValue is optional-chained would let the value assertion pass vacuously.
        const get = built.mqtt.subscriptions.find((subscription) => (subscription.kind === "get") && (subscription.topic === mac + "/chime"));

        assert.ok(get?.getValue, "the doorbell registered a /chime GET subscription");
        assert.equal(get.getValue(), "50", "the /chime GET returns the doorbell's effective chime volume (50) as a string");
      });
    });

    describe("the /chime SET (parse, gate, route the volume to the Lightbulb)", () => {

      test("a valid in-range value drives one served-chime write and publishes once", async () => {

        const chime = makeChimeConfig({ cameraIds: [doorbellId], ringSettings: [{ cameraId: doorbellId, ringtoneId: "default", volume: 20 }] });

        built = await buildDoorbell({ chimeConfigs: [chime], userOptions: ["Enable.Doorbell.Volume.Dimmer"] });

        // HARD-assert the volume Lightbulb the body drives exists FIRST: the SET body routes through setCharacteristic on it, so an absent service would no-op and the
        // write assertions would pass vacuously.
        const volumeBulb = built.accessory.getServiceById(Service.Lightbulb, ProtectReservedNames.LIGHTBULB_DOORBELL_VOLUME);

        assert.ok(volumeBulb, "Enable.Doorbell.Volume.Dimmer materializes the chime-volume Lightbulb the SET body drives");

        const set = built.mqtt.subscriptions.find((subscription) => (subscription.kind === "set") && (subscription.topic === mac + "/chime"));

        assert.ok(set?.setValue, "the doorbell registered a /chime SET subscription");

        const [served] = built.chimeProjections;

        assert.ok(served, "the held chime projection is present");

        // The body parses "70", passes the gate (not NaN, 0..100), and setCharacteristic(Brightness, 70) -> the Brightness onSet -> setChimeVolume(70).
        // setCharacteristic is fire-and-forget, so settle past the onSet before asserting. The On onSet (value > 0 truthy) early-returns, so exactly one served-chime
        // write lands. This nets only the MQTT body's parse / gate / route - setChimeVolume's clamp / fan-out / auth are the B3 describe's concern.
        await set.setValue("70", "70");
        await settle();

        assert.deepEqual(served.updateCalls, [{ payload: { ringSettings: [{ cameraId: doorbellId, repeatTimes: 1, ringtoneId: "default", volume: 70 }] } }],
          "the valid /chime SET routed the volume to the Lightbulb, driving one served-chime ring PATCH at volume 70");
        assert.deepEqual(built.mqtt.published.filter((entry) => entry.topic === mac + "/chime"), [{ message: "70", topic: mac + "/chime" }],
          "the accepted write published the new volume once on the chime topic");
      });

      test("a non-numeric value is gated out: no write, no publish", async () => {

        const chime = makeChimeConfig({ cameraIds: [doorbellId], ringSettings: [{ cameraId: doorbellId, volume: 50 }] });

        built = await buildDoorbell({ chimeConfigs: [chime], userOptions: ["Enable.Doorbell.Volume.Dimmer"] });

        const volumeBulb = built.accessory.getServiceById(Service.Lightbulb, ProtectReservedNames.LIGHTBULB_DOORBELL_VOLUME);

        assert.ok(volumeBulb, "the chime-volume Lightbulb materialized");

        const set = built.mqtt.subscriptions.find((subscription) => (subscription.kind === "set") && (subscription.topic === mac + "/chime"));

        assert.ok(set?.setValue, "the /chime SET subscription registered");

        const [served] = built.chimeProjections;

        assert.ok(served, "the held chime projection is present");

        // "abc" parses to NaN, so the isNaN gate returns before any setCharacteristic - no Lightbulb drive, no chime write, no publish.
        await set.setValue("abc", "abc");
        await settle();

        assert.equal(served.updateCalls.length, 0, "a NaN value is gated out before the Lightbulb drive, so no chime write happens");
        assert.equal(built.mqtt.published.filter((entry) => entry.topic === mac + "/chime").length, 0, "a gated-out value publishes nothing");
      });

      test("an out-of-range value (above 100 or below 0) is gated out: no write, no publish", async () => {

        const chime = makeChimeConfig({ cameraIds: [doorbellId], ringSettings: [{ cameraId: doorbellId, volume: 50 }] });

        built = await buildDoorbell({ chimeConfigs: [chime], userOptions: ["Enable.Doorbell.Volume.Dimmer"] });

        const volumeBulb = built.accessory.getServiceById(Service.Lightbulb, ProtectReservedNames.LIGHTBULB_DOORBELL_VOLUME);

        assert.ok(volumeBulb, "the chime-volume Lightbulb materialized");

        const set = built.mqtt.subscriptions.find((subscription) => (subscription.kind === "set") && (subscription.topic === mac + "/chime"));

        assert.ok(set?.setValue, "the /chime SET subscription registered");

        const [served] = built.chimeProjections;

        assert.ok(served, "the held chime projection is present");

        // Both 150 ( > 100 ) and -5 ( < 0 ) fail the (volume < 0) || (volume > 100) gate, so neither reaches the Lightbulb drive.
        await set.setValue("150", "150");
        await set.setValue("-5", "-5");
        await settle();

        assert.equal(served.updateCalls.length, 0, "an out-of-range value is gated out, so no chime write happens");
        assert.equal(built.mqtt.published.filter((entry) => entry.topic === mac + "/chime").length, 0, "an out-of-range value publishes nothing");
      });
    });

    describe("the /message GET (the current LCD message read)", () => {

      test("with a current message and no numeric resetAt, returns duration 0 and the message text", async () => {

        // Seed lcdMessage WITHOUT a numeric resetAt (omitted), so typeof resetAt !== "number" forces the deterministic duration-0 branch.
        built = await buildDoorbell({ lcdMessage: { text: "Hello" } });

        const get = built.mqtt.subscriptions.find((subscription) => (subscription.kind === "get") && (subscription.topic === mac + "/message"));

        assert.ok(get?.getValue, "the doorbell registered a /message GET subscription");
        assert.deepEqual(JSON.parse(get.getValue()), { duration: 0, message: "Hello" }, "a current message with no numeric resetAt reads as duration 0 and the text");
      });

      test("with a numeric resetAt, computes the remaining duration in seconds", async () => {

        // Pin Date so (resetAt - Date.now()) / 1000 is exact. T0 is the mocked epoch; a resetAt 45 seconds out reads back as duration 45, killing mutations of the
        // subtraction, the / 1000 scaling, and the Math.round.
        mock.timers.enable({ apis: ["Date"] });

        try {

          const t0 = Date.now();

          built = await buildDoorbell({ lcdMessage: { resetAt: t0 + 45000, text: "Hi" } });

          const get = built.mqtt.subscriptions.find((subscription) => (subscription.kind === "get") && (subscription.topic === mac + "/message"));

          assert.ok(get?.getValue, "the doorbell registered a /message GET subscription");
          assert.deepEqual(JSON.parse(get.getValue()), { duration: 45, message: "Hi" }, "a resetAt 45 seconds out reads back as duration 45 with the message text");
        } finally {

          mock.timers.reset();
        }
      });

      test("with no current message, returns the empty string", async () => {

        // No lcdMessage seeded: the body's !this.ufp.lcdMessage guard returns the empty string (not the JSON "{}").
        built = await buildDoorbell({});

        const get = built.mqtt.subscriptions.find((subscription) => (subscription.kind === "get") && (subscription.topic === mac + "/message"));

        assert.ok(get?.getValue, "the doorbell registered a /message GET subscription");
        assert.equal(get.getValue(), "", "with no current message the /message GET returns the empty string");
      });
    });

    describe("the /message SET (parse, validate, translate, route to setMessage)", () => {

      // The /message SET handler reads rawValue (the SECOND argument) - production passes the raw MQTT string there - so every drive passes the JSON string as both args.
      // The setMessage write-through lands on the camera projection (the doorbell's #device IS the camera's this.device IS built.cameraProjection), so the outbound
      // lcdMessage payload is asserted against cameraProjection.updateCalls.

      test("a custom message with a positive duration writes a CUSTOM_MESSAGE with a resetAt now + duration", async () => {

        // Pin Date so resetAt === T0 + duration*1000 is exact, making the * 1000 seconds-scaling and the Date.now() + duration math mutation-detectable.
        mock.timers.enable({ apis: ["Date"] });

        try {

          built = await buildDoorbell({});

          const t0 = Date.now();
          const set = built.mqtt.subscriptions.find((subscription) => (subscription.kind === "set") && (subscription.topic === mac + "/message"));

          assert.ok(set?.setValue, "the doorbell registered a /message SET subscription");

          const payload = JSON.stringify({ duration: 30, message: "Ding" });

          await set.setValue(payload, payload);

          assert.deepEqual(built.cameraProjection.updateCalls,
            [{ payload: { lcdMessage: { resetAt: t0 + 30000, text: "Ding", type: "CUSTOM_MESSAGE" } } }],
            "a 30-second custom message writes a CUSTOM_MESSAGE whose resetAt is now plus 30 seconds (the * 1000 scaling applied)");
        } finally {

          mock.timers.reset();
        }
      });

      test("a duration of 0 writes a non-expiring CUSTOM_MESSAGE (resetAt null)", async () => {

        // Deterministic, no time dependence: duration 0 is present and not negative, so * 1000 = 0; setMessage's resetAt = duration ? ... : null yields null. The
        // null-vs-T0 discriminator kills a mutation flipping the ternary.
        built = await buildDoorbell({});

        const set = built.mqtt.subscriptions.find((subscription) => (subscription.kind === "set") && (subscription.topic === mac + "/message"));

        assert.ok(set?.setValue, "the /message SET subscription registered");

        const payload = JSON.stringify({ duration: 0, message: "Ding" });

        await set.setValue(payload, payload);

        assert.deepEqual(built.cameraProjection.updateCalls, [{ payload: { lcdMessage: { resetAt: null, text: "Ding", type: "CUSTOM_MESSAGE" } } }],
          "a duration-0 custom message is non-expiring: resetAt is null, not a timestamp");
      });

      test("a blank message resets the LCD: writes a resetAt with no text or type, and logs the reset", async () => {

        // Pin Date so the reset resetAt is the exact mocked epoch T0 (which is 0 by default - assert it with deepEqual, NEVER truthiness, or the legitimate 0 fails a
        // truthy check). A blank message takes the reset branch: outbound { resetAt: Date.now() } has no "duration" key, so setMessage passes it through untranslated.
        mock.timers.enable({ apis: ["Date"] });

        try {

          built = await buildDoorbell({});

          const t0 = Date.now();
          const set = built.mqtt.subscriptions.find((subscription) => (subscription.kind === "set") && (subscription.topic === mac + "/message"));

          assert.ok(set?.setValue, "the /message SET subscription registered");

          const payload = JSON.stringify({ message: "" });

          await set.setValue(payload, payload);

          assert.deepEqual(built.cameraProjection.updateCalls, [{ payload: { lcdMessage: { resetAt: t0 } } }],
            "a blank message writes a bare resetAt (the mocked epoch) with no text or type key");
          assert.ok(loggedAt(built.logEntries, "info", "Received MQTT doorbell message reset."), "the blank-message reset is logged at info");
        } finally {

          mock.timers.reset();
        }
      });

      test("invalid JSON is caught, logged, and writes nothing", async () => {

        built = await buildDoorbell({});

        const set = built.mqtt.subscriptions.find((subscription) => (subscription.kind === "set") && (subscription.topic === mac + "/message"));

        assert.ok(set?.setValue, "the /message SET subscription registered");

        // A malformed JSON rawValue trips the JSON.parse catch: the body logs the invalid-JSON error and returns before setMessage.
        await set.setValue("{bad", "{bad");

        assert.equal(built.cameraProjection.updateCalls.length, 0, "invalid JSON writes nothing to the doorbell");
        assert.ok(loggedAt(built.logEntries, "error", "Unable to process MQTT message"), "invalid JSON is reported at error");
        assert.ok(loggedAt(built.logEntries, "error", "Invalid JSON."), "the invalid-JSON branch names the JSON failure");
      });

      test("a payload missing the message key is rejected and writes nothing", async () => {

        built = await buildDoorbell({});

        const set = built.mqtt.subscriptions.find((subscription) => (subscription.kind === "set") && (subscription.topic === mac + "/message"));

        assert.ok(set?.setValue, "the /message SET subscription registered");

        // Valid JSON, but no "message" key, so the !("message" in payload) validation fork logs the error and returns before setMessage. The Number.isNaN(duration)
        // sub-clause of this same guard (doorbell.ts:726) is a defensive guard NOT reachable through the MQTT wire: the handler always JSON.parses rawValue, and
        // JSON.parse never yields the literal number NaN (JSON has no NaN representation), so Number.isNaN(parsed.duration) cannot be true for any valid-JSON input.
        // It is honestly left uncovered rather than netted with a non-representable input.
        const payload = JSON.stringify({ duration: 10 });

        await set.setValue(payload, payload);

        assert.equal(built.cameraProjection.updateCalls.length, 0, "a payload with no message key writes nothing");
        assert.ok(loggedAt(built.logEntries, "error", "Unable to process MQTT message"), "a missing message key is reported at error");
      });
    });
  });
});
