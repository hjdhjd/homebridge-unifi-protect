/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * device-motion.test.ts: The first base-capability concern net - the shared ProtectDevice motion surface, netted once family-agnostically.
 *
 * The motion sensor switch (Motion.Switch), the manual motion trigger (Motion.Trigger), and the occupancy sensor (Motion.OccupancySensor) are BASE ProtectDevice
 * behaviors: configureMotionSensor / configureOccupancySensor live on the base and are called identically by every family (camera, light, sensor, package camera), gated
 * by the hasProperty: ["isMotionDetected", "isPirMotionDetected"] applicability check. Per the two-layer test architecture they are netted ONCE here, against the shared
 * minimal TestBaseDevice vehicle, rather than re-asserted inside each family suite. Each family suite nets only that the family wires these base methods; the base
 * behavior itself is this file's job.
 *
 * The vacuity gate (required for these assertions to be meaningful): every Motion service option defaults to FALSE, so the runtime service gate is the Enable.Motion.*
 * userOptions string, NOT the carrier's isMotionDetected. The carrier's isMotionDetected only satisfies the hasProperty APPLICABILITY check (it makes the option visible
 * to FeatureOptions) and backs the read-through; it does NOT materialize a service. So every with-feature test builds with the exact alphabetical Enable.Motion.*
 * userOptions subset and HARD-asserts the service EXISTS (a non-optional assert.ok checked first) - an absent service then throws rather than passing vacuously - paired
 * with a without-feature absence test that proves the same path produces nothing when the string is omitted.
 *
 * The trigger's reverts are deferred reflects armed on the platform's clock outside this.timers, so device.cleanup() does not clear them; the disabled-revert and the
 * off-revert tests advance the harness clock through the reflect delay so the revert fires within the test, touching only that test's fresh accessory. The firehose
 * routing goes through the shared TestRecordingDispatch (a real ProtectEventDispatch whose motion delivery records into an array and arms no reset timer), injected
 * through makeTestNvr's dispatch parameter and read off nvr.events.
 *
 * The isolation model is per-test-fresh: each test calls buildMotionDevice with its own userOptions, and an afterEach unwinds the device's per-accessory abort. These
 * base services are HAP- and MQTT-driven, not observeState-driven, so there is no observer-wake subscription here (unlike the family suites).
 */
import { Characteristic, Service, TestStateStore, makeProtectState, makeTestAccessory } from "../testing.helpers.ts";
import { TestBaseDevice, TestSensorProjection, makeSensorConfig } from "./testing.helpers.ts";
import type { TestClock, TestHomebridgeApi, TestLogEntry, TestMqttClient } from "homebridge-plugin-utils/testing";
import { TestRecordingDispatch, makeTestNvr, restoreAccessories } from "../nvr/testing.helpers.ts";
import { afterEach, describe, test } from "node:test";
import { loggedAt, settle, triggerGet, triggerSet } from "homebridge-plugin-utils/testing";
import { ACCESSORY_SAVE_WINDOW_MS } from "homebridge-plugin-utils";
import { PROTECT_HOMEKIT_REFLECT_DELAY } from "../settings.ts";
import type { ProtectNvr } from "../nvr/nvr.ts";
import { ProtectReservedNames } from "../types.ts";
import type { Sensor } from "unifi-protect";
import type { TestProtectAccessory } from "../testing.helpers.ts";
import assert from "node:assert/strict";

// Fire the deferred reflects the motion trigger arms outside this.timers, so the revert lands within the test rather than after teardown: settle the set handler,
// advance the device's clock through the reflect delay, and settle again, exactly as the chime suite fires its own reverts.
async function fireDeferredReflect(clock: TestClock): Promise<void> {

  await settle();
  clock.advance(PROTECT_HOMEKIT_REFLECT_DELAY);
  await settle();
}

// The carrier identity, pinned so the firehose-routing assertions match the recorded id and the MQTT topic composition matches the device MAC. The all-quiet
// makeSensorConfig default carries isMotionDetected: true (the Motion.* hasProperty applicability gate) and state CONNECTED + isConnected true (so isReachable is true).
const SENSOR_ID = "test-sensor-1";
const SENSOR_MAC = "74ACB9000401";

// Every harness controller this suite opens, drained in afterEach so the controller lifetime signal bounds each test's constructions rather than the file's. The builder
// is the single push site for the fixture builds, and the one test that assembles its own controller pushes at its construction.
const controllers: AbortController[] = [];

// The reusable construction helper: build a REAL TestBaseDevice (a concrete ProtectDevice leaf whose ctor only super()s) against the harness doubles, seeded with the
// all-quiet sensor carrier and the recording dispatch injected through the NVR double's dispatch parameter. The casts are confined to the point of construction exactly
// as the light / chime suites do; the instance under test is the production base, running its real configureHints / configureMotionSensor / configureOccupancySensor
// paths. We drive the wiring a family leaf would: configureHints first (the motion configurators read this.hints), then the base's motion-capability configurators with
// enabled true. The userOptions thread into the REAL FeatureOptions engine, so the Enable.Motion.* strings - and only those - materialize the services. seedAccessory,
// when supplied, runs against the fresh accessory before construction, standing in for the services a Homebridge restart restores from the accessory cache.
function buildMotionDevice(harnessOptions: { seedAccessory?: (accessory: TestProtectAccessory) => void; userOptions?: string[] } = {}): {
  accessory: TestProtectAccessory; api: TestHomebridgeApi; clock: TestClock; device: TestBaseDevice; logEntries: readonly TestLogEntry[]; mqtt: TestMqttClient;
  recording: TestRecordingDispatch;
} {

  const sensorConfig = makeSensorConfig();
  const store = new TestStateStore(makeProtectState({ sensors: [sensorConfig] }));
  const { api, clock, controller, logEntries, mqtt, nvr } = makeTestNvr({

    dispatch: (innerNvr: ProtectNvr): TestRecordingDispatch => new TestRecordingDispatch(innerNvr),
    mqtt: true,
    store, userOptions: harnessOptions.userOptions });

  controllers.push(controller);

  const recording = nvr.events as TestRecordingDispatch;
  const accessory = makeTestAccessory("Test Sensor", sensorConfig.mac);

  // The device-leaf mqttId sources the bare MAC from the persisted accessory context, not this.ufp.mac, so seed it to match the projection's MAC for the topic-scope
  // assertions.
  accessory.context.mac = sensorConfig.mac;

  harnessOptions.seedAccessory?.(accessory);

  // The accessory is the cached one Homebridge restores onto the bridge before the platform configures it, so the persistence saves what the device marks.
  restoreAccessories(nvr, [accessory]);

  const projection = new TestSensorProjection(sensorConfig.id, store) as unknown as Sensor;
  const device = new TestBaseDevice(nvr as unknown as ProtectNvr, accessory, projection);

  // makeTestNvr was called with mqtt: true, so the MQTT client double is present; a guard narrows Nullable<TestMqttClient> to the non-null type without an assertion or a
  // same-type cast (either of which the house lint preset forbids in opposite directions), and fails loudly if the opt-in ever stops installing the double.
  if(!mqtt) {

    throw new Error("The MQTT recording double was not installed despite mqtt: true.");
  }

  // Wire the base capabilities the way a family leaf does: hints first (the motion configurators read this.hints), then the motion sensor (which configures the switch /
  // trigger) and the occupancy sensor. enabled is true; whether each switch / service actually materializes is then governed entirely by the Enable.Motion.*
  // userOptions.
  device.configureHintsFor();
  device.configureMotionSensorFor({ enabled: true });
  device.configureOccupancySensorFor({ enabled: true });

  return { accessory, api, clock, device, logEntries, mqtt, recording };
}

describe("base ProtectDevice motion capability (device-motion concern net)", () => {

  // The per-test handle, torn down in afterEach so each test's per-accessory abort unwinds and the bare reverts touch only their own fresh accessory.
  let device: TestBaseDevice | undefined;

  afterEach(() => {

    device?.cleanup();
    device = undefined;

    for(const controller of controllers) {

      controller.abort();
    }

    controllers.length = 0;
  });

  describe("the motion sensor switch (Motion.Switch)", () => {

    test("with the feature, the switch exists, reads detectMotion, toggles it, and logs the feature's line", async () => {

      const built = buildMotionDevice({ userOptions: ["Enable.Motion.Switch"] });

      device = built.device;

      // HARD-assert the service exists FIRST: with Enable.Motion.Switch the SWITCH_MOTION_SENSOR-subtyped Switch must materialize, so an absent service throws here
      // rather than letting later optional-chained assertions pass vacuously.
      const motionSwitch = built.accessory.getServiceById(Service.Switch, ProtectReservedNames.SWITCH_MOTION_SENSOR);

      assert.ok(motionSwitch, "the Motion.Switch feature materializes the SWITCH_MOTION_SENSOR switch");
      assert.ok(loggedAt(built.logEntries, "info", "Motion sensor switches enabled."), "the feature's line logged");

      const onChar = motionSwitch.getCharacteristic(Characteristic.On);

      // detectMotion defaults true (initialized on first configure), so the onGet reads true and the switch initialized to true.
      assert.equal(onChar.value, true, "the switch initialized On to the default detectMotion (true)");
      assert.equal(await triggerGet(onChar), true, "the On getter reads context.detectMotion (true by default)");

      // onSet false flips detectMotion off and logs the disabled line; onSet true flips it back on and logs the enabled line.
      await triggerSet(onChar, false);

      assert.equal(built.device.accessory.context.detectMotion, false, "the onSet wrote context.detectMotion false");
      assert.ok(loggedAt(built.logEntries, "info", "Motion detection disabled."), "the disabled-on-change line logged");

      await triggerSet(onChar, true);

      assert.equal(built.device.accessory.context.detectMotion, true, "the onSet wrote context.detectMotion back to true");
      assert.ok(loggedAt(built.logEntries, "info", "Motion detection enabled."), "the enabled-on-change line logged");
    });

    test("without the feature, no switch is materialized and detectMotion is reset to true", () => {

      const built = buildMotionDevice();

      device = built.device;

      assert.equal(built.accessory.getServiceById(Service.Switch, ProtectReservedNames.SWITCH_MOTION_SENSOR), undefined,
        "omitting Enable.Motion.Switch materializes no motion switch");

      // The disabled path resets context.detectMotion to true so motion detection cannot be left silently off with no switch to re-enable it.
      assert.equal(built.device.accessory.context.detectMotion, true, "the absent-switch path reset context.detectMotion to true");
    });

    /* A toggle is a setting the user expects to survive a restart, so the switch's set saves it to Homebridge's accessory cache: one update names the accessory once
     * the save window the set opened closes, carrying the value the set wrote. The window the construction opened is closed first, so the update the row reads belongs
     * to the toggle alone.
     */
    test("a toggle is saved once its save window closes, carrying the detectMotion it wrote", async () => {

      const built = buildMotionDevice({ userOptions: ["Enable.Motion.Switch"] });
      const saves = (): number => built.api.calls.filter((call) => (call.kind === "update") && call.accessories.includes(built.accessory)).length;

      device = built.device;

      const motionSwitch = built.accessory.getServiceById(Service.Switch, ProtectReservedNames.SWITCH_MOTION_SENSOR);

      assert.ok(motionSwitch, "the Motion.Switch feature materializes the SWITCH_MOTION_SENSOR switch");

      built.clock.advance(ACCESSORY_SAVE_WINDOW_MS);

      const constructed = saves();

      await triggerSet(motionSwitch.getCharacteristic(Characteristic.On), false);
      built.clock.advance(ACCESSORY_SAVE_WINDOW_MS - 1);

      assert.equal(saves(), constructed, "nothing is saved while the toggle's window is open");

      built.clock.advance(1);

      assert.equal(saves(), constructed + 1, "exactly one update names the accessory once the toggle's window closes");
      assert.equal(built.accessory.context.detectMotion, false, "the saved accessory carries the detectMotion the toggle wrote");
    });

    // Every mark inside one window goes out in one save, so a burst of toggles costs Homebridge one cache write rather than one per toggle.
    test("a burst of toggles inside one save window is saved in one update", async () => {

      const built = buildMotionDevice({ userOptions: ["Enable.Motion.Switch"] });
      const saves = (): number => built.api.calls.filter((call) => (call.kind === "update") && call.accessories.includes(built.accessory)).length;

      device = built.device;

      const motionSwitch = built.accessory.getServiceById(Service.Switch, ProtectReservedNames.SWITCH_MOTION_SENSOR);

      assert.ok(motionSwitch, "the Motion.Switch feature materializes the SWITCH_MOTION_SENSOR switch");

      built.clock.advance(ACCESSORY_SAVE_WINDOW_MS);

      const constructed = saves();
      const on = motionSwitch.getCharacteristic(Characteristic.On);

      await triggerSet(on, false);
      built.clock.advance(ACCESSORY_SAVE_WINDOW_MS / 2);
      await triggerSet(on, true);
      await triggerSet(on, false);
      built.clock.advance(ACCESSORY_SAVE_WINDOW_MS / 2);

      assert.equal(saves(), constructed + 1, "the toggles inside the window were saved in exactly one update");
      assert.equal(built.accessory.context.detectMotion, false, "the one save carries the last toggle's value");
    });
  });

  describe("the manual motion trigger (Motion.Trigger)", () => {

    test("with the feature, the trigger exists, inits off, logs the feature's line, and a trigger-on fires the firehose once", async () => {

      const built = buildMotionDevice({ userOptions: ["Enable.Motion.Trigger"] });

      device = built.device;

      const trigger = built.accessory.getServiceById(Service.Switch, ProtectReservedNames.SWITCH_MOTION_TRIGGER);

      assert.ok(trigger, "the Motion.Trigger feature materializes the SWITCH_MOTION_TRIGGER switch");
      assert.ok(loggedAt(built.logEntries, "info", "Motion sensor automation triggers enabled."), "the feature's line logged");

      const onChar = trigger.getCharacteristic(Characteristic.On);

      assert.equal(onChar.value, false, "the trigger initialized On to false");

      // No motion switch is present (Motion.Switch was not enabled), so the onSet's switchService is undefined and the else-branch fires the firehose. Baseline the
      // recorded calls so the assertion measures only this trigger.
      const baseline = built.recording.calls.length;

      await triggerSet(onChar, true);

      assert.equal(built.recording.calls.length - baseline, 1, "a trigger-on with no motion switch routed to motionEventHandler exactly once");
      assert.deepEqual(built.recording.calls[baseline], { id: SENSOR_ID, kind: "motion" }, "the firehose call carried the carrier id and the motion kind");
      assert.ok(loggedAt(built.logEntries, "info", "Motion event triggered."), "the triggered line logged");
    });

    test("with both switches, a trigger-on while motion detection is OFF takes the bare revert and fires no firehose", async () => {

      // Both switches present so configureMotionTrigger's onSet can see the motion switch and read its OFF state - the disabled-revert branch (the deferred reflect to
      // false, outside this.timers).
      const built = buildMotionDevice({ userOptions: [ "Enable.Motion.Switch", "Enable.Motion.Trigger" ] });

      device = built.device;

      const motionSwitch = built.accessory.getServiceById(Service.Switch, ProtectReservedNames.SWITCH_MOTION_SENSOR);
      const trigger = built.accessory.getServiceById(Service.Switch, ProtectReservedNames.SWITCH_MOTION_TRIGGER);

      assert.ok(motionSwitch, "the motion switch materialized");
      assert.ok(trigger, "the trigger materialized");

      // Turn motion detection OFF so the trigger's onSet sees switchService.On === false and takes the revert path.
      const motionOn = motionSwitch.getCharacteristic(Characteristic.On);

      await triggerSet(motionOn, false);

      assert.equal(motionOn.value, false, "the motion switch is now OFF");

      const triggerOn = trigger.getCharacteristic(Characteristic.On);
      const baseline = built.recording.calls.length;

      await triggerSet(triggerOn, true);

      // Let the deferred reflect to false fire within the test. The revert is outside this.timers, so cleanup() would not clear it.
      await fireDeferredReflect(built.clock);

      assert.equal(built.recording.calls.length - baseline, 0, "the disabled-revert branch fired no firehose (the motion switch was OFF)");
      assert.equal(triggerOn.value, false, "the bare revert pushed the trigger back to off");
    });

    test("a trigger-off while the motion sensor still shows motion takes the bare re-arm revert", async () => {

      const built = buildMotionDevice({ userOptions: ["Enable.Motion.Trigger"] });

      device = built.device;

      const trigger = built.accessory.getServiceById(Service.Switch, ProtectReservedNames.SWITCH_MOTION_TRIGGER);
      const motionService = built.accessory.getService(Service.MotionSensor);

      assert.ok(trigger, "the trigger materialized");
      assert.ok(motionService, "the motion sensor materialized");

      // Drive the off-revert in configureMotionTrigger's onSet (device.ts): on isOn false it re-arms the trigger to true through the deferred reflect IFF the motion
      // sensor still reports motion. Set MotionDetected true to model live motion, then turn the trigger off.
      motionService.updateCharacteristic(Characteristic.MotionDetected, true);

      const triggerOn = trigger.getCharacteristic(Characteristic.On);

      await triggerSet(triggerOn, false);
      await fireDeferredReflect(built.clock);

      assert.equal(triggerOn.value, true, "the off-revert re-armed the trigger to on because the motion sensor still reported motion");
    });
  });

  describe("the occupancy sensor (Motion.OccupancySensor)", () => {

    test("with the feature, the occupancy service exists carrying no StatusActive and OccupancyDetected initialized false", () => {

      const built = buildMotionDevice({ userOptions: ["Enable.Motion.OccupancySensor"] });

      device = built.device;

      // HARD-assert the SERVICE exists FIRST - this is the primary, non-optional check that defeats vacuity.
      const occupancy = built.accessory.getService(Service.OccupancySensor);

      assert.ok(occupancy, "the Motion.OccupancySensor feature materializes the OccupancySensor service");
      assert.ok(loggedAt(built.logEntries, "info", "Enabling occupancy sensor."), "the enabling line logged (no smart-detect suffix on the base carrier)");

      // OccupancyDetected initializes false (the A.5 characteristic the harness carries on the OccupancySensor service).
      assert.equal(occupancy.getCharacteristic(Characteristic.OccupancyDetected).value, Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED,
        "OccupancyDetected initialized to not detected");

      // This device is no camera, so its sensors carry no StatusActive, No Response being what HomeKit shows when it cannot be reached.
      assert.equal(occupancy.testCharacteristic(Characteristic.StatusActive), false, "the occupancy sensor carries no StatusActive");
    });

    test("without the feature, no occupancy service is materialized", () => {

      const built = buildMotionDevice();

      device = built.device;

      assert.equal(built.accessory.getService(Service.OccupancySensor), undefined, "omitting Enable.Motion.OccupancySensor materializes no occupancy service");
    });

    test("an occupancy service created during a steady-state reconcile runs its full init block", async () => {

      // Motion.OccupancySensor must be enabled so validService re-creates the service on the enable. The constructor's first configure stands the service up and
      // registers its GET; a disable removes it, and a steady-state reconcile (initialized TRUE, the shape a runtime enable takes) re-creates the service. The attached
      // transition that re-creation answers is what makes the init block run again rather than being skipped.
      const built = buildMotionDevice({ userOptions: ["Enable.Motion.OccupancySensor"] });

      device = built.device;

      const occupancyGets = (): number => built.mqtt.subscriptions.filter((subscription) => (subscription.kind === "get") && (subscription.topic ===
        (SENSOR_MAC + "/occupancy/get"))).length;

      built.device.configureOccupancySensorFor({ enabled: false, initialized: false });

      const baseline = occupancyGets();

      built.device.configureOccupancySensorFor({ enabled: true, initialized: true });

      const occupancy = built.accessory.getService(Service.OccupancySensor);

      assert.ok(occupancy, "the reconcile re-created the occupancy service");
      assert.ok(occupancyGets() > baseline, "the reconcile-created service re-registered its occupancy MQTT GET - the init block ran");
      assert.equal(await triggerGet(occupancy.getCharacteristic(Characteristic.OccupancyDetected)), Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED,
        "OccupancyDetected carries its read handler after the re-creation");
    });

    test("the base answers no smart-occupancy types for a non-camera, on the first configure and on a re-created service", async () => {

      // Only a camera reports smart detections, so the base derivation answers none. The carrier is seeded with smart-detect types and hints.smartDetect is forced
      // true, the arrangement under which a camera-shaped read of the configuration would find a type to select, and the list stays empty on the first configure and
      // again when the init block re-runs on a re-created service.
      const sensorConfig = makeSensorConfig();
      const seededFlags = sensorConfig.featureFlags as unknown as Record<string, unknown>;

      seededFlags["smartDetectAudioTypes"] = [];
      seededFlags["smartDetectTypes"] = ["person"];

      const store = new TestStateStore(makeProtectState({ sensors: [sensorConfig] }));
      const { controller, nvr } = makeTestNvr({ mqtt: true, store, userOptions: ["Enable.Motion.OccupancySensor=person"] });

      controllers.push(controller);

      const accessory = makeTestAccessory("Test Sensor", sensorConfig.mac);

      accessory.context.mac = sensorConfig.mac;

      const projection = new TestSensorProjection(sensorConfig.id, store) as unknown as Sensor;
      const built = new TestBaseDevice(nvr as unknown as ProtectNvr, accessory, projection);

      device = built;

      built.configureHintsFor();
      built.hints.smartDetect = true;

      built.configureOccupancySensorFor({ enabled: true, initialized: false });

      assert.deepEqual(built.hints.smartOccupancy, [], "the first configure resolved no smart-occupancy types for a non-camera");

      // Disable, then reconcile-create so the init block runs a SECOND time through the same derivation.
      built.configureOccupancySensorFor({ enabled: false, initialized: false });
      built.configureOccupancySensorFor({ enabled: true, initialized: true });

      assert.deepEqual(built.hints.smartOccupancy, [], "the re-created service resolved none either");
    });
  });

  describe("the base motion get/set MQTT interface", () => {

    test("the motion set handler fires the firehose on \"true\" and is a no-op otherwise; the get handler reads MotionDetected; the topic is MAC-scoped", async () => {

      const built = buildMotionDevice();

      device = built.device;

      // The motion get/set MQTT registrations are unconditional in configureMotionSensor (independent of the Motion.* switch features), so they are present on the bare
      // carrier. Find each by the MAC-scoped topic and kind.
      const motionTopic = SENSOR_MAC + "/motion";
      const setSub = built.mqtt.subscriptions.find((subscription) => (subscription.topic === motionTopic + "/set") && (subscription.kind === "set"));
      const getSub = built.mqtt.subscriptions.find((subscription) => (subscription.topic === motionTopic + "/get") && (subscription.kind === "get"));

      assert.ok(setSub, "the motion set subscription registered on the MAC-scoped topic");
      assert.ok(getSub, "the motion get subscription registered on the MAC-scoped topic");

      // The firehose-live half: a "true" payload routes to motionEventHandler exactly once, carrying the carrier id.
      const trueBaseline = built.recording.calls.length;

      await built.mqtt.invokeSet(motionTopic + "/set", "true");

      assert.equal(built.recording.calls.length - trueBaseline, 1, "a \"true\" motion set routed to motionEventHandler exactly once");
      assert.deepEqual(built.recording.calls[trueBaseline], { id: SENSOR_ID, kind: "motion" }, "the firehose call carried the carrier id and the motion kind");

      // The non-"true" half is non-vacuous only because the "true" half proved the path live: from a FRESH baseline, a "false" payload routes nothing.
      const falseBaseline = built.recording.calls.length;

      await built.mqtt.invokeSet(motionTopic + "/set", "false");

      assert.equal(built.recording.calls.length - falseBaseline, 0, "a non-\"true\" motion set is a no-op (no firehose)");

      // The get handler reflects the MotionDetected characteristic state: false initially, true once the motion service is flipped.
      assert.equal(await built.mqtt.invokeGet(motionTopic + "/get"), "false", "the motion get reads the initial MotionDetected state (false)");

      const motionService = built.accessory.getService(Service.MotionSensor);

      assert.ok(motionService, "the motion sensor service exists for the get read-through");

      motionService.updateCharacteristic(Characteristic.MotionDetected, true);

      assert.equal(await built.mqtt.invokeGet(motionTopic + "/get"), "true", "the motion get reflects the flipped MotionDetected state (true)");
    });
  });

  /* The first-time setup across configure passes. A runtime reconfigure runs as a later pass (initialized true), and on it the setup - the MQTT registrations, the
   * read handlers, and the initial values - runs only for a service that pass created; a service the pass finds standing keeps the registrations it already
   * has. The MQTT double records every registration, so a second one is directly countable.
   */
  describe("the motion and occupancy setup across configure passes", () => {

    // The count of MQTT registrations of one kind on one MAC-scoped topic.
    const registrations = (mqtt: TestMqttClient, kind: "get" | "set", tail: string): number => {

      return mqtt.subscriptions.filter((subscription) => (subscription.kind === kind) && (subscription.topic === (SENSOR_MAC + tail))).length;
    };

    test("a first pass over sensors restored from the accessory cache runs their full setup", () => {

      // A Homebridge restart restores each service with none of its handlers or MQTT registrations, so the first pass answers kept and still sets each one up.
      const built = buildMotionDevice({ seedAccessory: (accessory) => {

        accessory.addService(Service.MotionSensor, "Test Sensor").getCharacteristic(Characteristic.StatusActive);
        accessory.addService(Service.OccupancySensor, "Test Sensor").getCharacteristic(Characteristic.StatusActive);
      }, userOptions: ["Enable.Motion.OccupancySensor"] });

      device = built.device;

      assert.equal(built.accessory.getService(Service.MotionSensor)?.testCharacteristic(Characteristic.StatusActive), false,
        "the StatusActive the motion service was restored with came off it");
      assert.equal(built.accessory.getService(Service.OccupancySensor)?.testCharacteristic(Characteristic.StatusActive), false, "and off the occupancy service");
      assert.equal(built.accessory.services.filter((service) => service.UUID === Service.MotionSensor.UUID).length, 1, "the first pass kept the restored motion service");
      assert.equal(registrations(built.mqtt, "get", "/motion/get"), 1, "the restored motion service registered its motion MQTT get");
      assert.equal(registrations(built.mqtt, "set", "/motion/set"), 1, "the restored motion service registered its motion MQTT set");
      assert.equal(registrations(built.mqtt, "get", "/occupancy/get"), 1, "the restored occupancy service registered its occupancy MQTT get");
    });

    test("a motion service created during a steady-state reconcile runs its full setup", async () => {

      const built = buildMotionDevice();

      device = built.device;

      // Disable the sensor, which removes the service, then run the shape a runtime enable takes (initialized true). The attached transition the re-creation answers
      // is what runs the setup again.
      built.device.configureMotionSensorFor({ enabled: false, initialized: false });

      const getBaseline = registrations(built.mqtt, "get", "/motion/get");
      const setBaseline = registrations(built.mqtt, "set", "/motion/set");

      built.device.configureMotionSensorFor({ enabled: true, initialized: true });

      const motion = built.accessory.getService(Service.MotionSensor);

      assert.ok(motion, "the reconcile re-created the motion service");
      assert.equal(registrations(built.mqtt, "get", "/motion/get") - getBaseline, 1, "the re-created service registered its motion MQTT get once");
      assert.equal(registrations(built.mqtt, "set", "/motion/set") - setBaseline, 1, "the re-created service registered its motion MQTT set once");
      assert.equal(await triggerGet(motion.getCharacteristic(Characteristic.MotionDetected)), false, "MotionDetected carries its read handler after the re-creation");
    });

    test("a steady-state reconcile over a standing motion service registers nothing a second time", () => {

      const built = buildMotionDevice();

      device = built.device;

      assert.equal(registrations(built.mqtt, "get", "/motion/get"), 1, "the first pass registered the motion MQTT get once");
      assert.equal(registrations(built.mqtt, "set", "/motion/set"), 1, "the first pass registered the motion MQTT set once");

      // The service is standing, so the later pass answers kept and leaves the registrations the first pass made.
      built.device.configureMotionSensorFor({ enabled: true, initialized: true });

      assert.ok(built.accessory.getService(Service.MotionSensor), "the motion service is still standing");
      assert.equal(registrations(built.mqtt, "get", "/motion/get"), 1, "the reconcile did not register a second motion MQTT get");
      assert.equal(registrations(built.mqtt, "set", "/motion/set"), 1, "the reconcile did not register a second motion MQTT set");
    });

    test("a steady-state reconcile over a standing occupancy service registers its MQTT get only once", () => {

      const built = buildMotionDevice({ userOptions: ["Enable.Motion.OccupancySensor"] });

      device = built.device;

      assert.equal(registrations(built.mqtt, "get", "/occupancy/get"), 1, "the first pass registered the occupancy MQTT get once");

      // The service is standing, so the later pass answers kept and leaves the registration the first pass made.
      built.device.configureOccupancySensorFor({ enabled: true, initialized: true });

      assert.ok(built.accessory.getService(Service.OccupancySensor), "the occupancy service is still standing");
      assert.equal(registrations(built.mqtt, "get", "/occupancy/get"), 1, "the reconcile did not register a second occupancy MQTT get");
    });
  });
});
