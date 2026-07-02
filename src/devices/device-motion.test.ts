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
 * The vacuity gate (load-bearing): all three Motion options default to FALSE, so the runtime service gate is the Enable.Motion.* userOptions string, NOT the carrier's
 * isMotionDetected. The carrier's isMotionDetected only satisfies the hasProperty APPLICABILITY check (it makes the option visible to FeatureOptions) and backs the
 * read-through; it does NOT materialize a service. So every with-feature test builds with the exact alphabetical Enable.Motion.* userOptions subset and HARD-asserts the
 * service EXISTS (a non-optional assert.ok as the FIRST discriminator) - an absent service then throws rather than passing vacuously - paired with a without-feature
 * absence test that proves the same path produces nothing when the string is omitted.
 *
 * The trigger's two reverts are bare setTimeout(...,50) NOT registered in this.timers, so device.cleanup() does not clear them; the disabled-revert and the off-revert
 * tests await ~60ms so the bare revert fires within the test, touching only that test's fresh accessory. The firehose routing goes through the shared
 * TestRecordingDispatch (a real ProtectEventDispatch whose motion delivery records into an array and arms no reset timer), injected through makeTestNvr's dispatch seam
 * and read off nvr.events.
 *
 * The isolation model is per-test-fresh: each test calls buildMotionDevice with its own userOptions, and an afterEach unwinds the device's per-accessory abort. These
 * base services are HAP- and MQTT-driven, not observeState-driven, so there is no observer-wake subscription here (unlike the family suites).
 */
import { Characteristic, Service, TestBaseDevice, TestRecordingDispatch, TestSensorProjection, TestStateStore, makeProtectState, makeSensorConfig, makeTestAccessory,
  makeTestNvr } from "../testing.helpers.ts";
import type { TestAccessory, TestLogEntry, TestMqttClient } from "../testing.helpers.ts";
import { afterEach, describe, test } from "node:test";
import type { ProtectAccessory } from "../types.ts";
import type { ProtectNvr } from "../nvr/nvr.ts";
import { ProtectReservedNames } from "../types.ts";
import type { Sensor } from "unifi-protect";
import assert from "node:assert/strict";

// The device log wrapper formats every line through util.format into a single string parameter prefixed with the device name (for example "Test Sensor: Motion detection
// enabled."), so a log assertion matches a substring of that one formatted parameter at the given level, mirroring the chime suite's helper.
function loggedAt(entries: TestLogEntry[], level: TestLogEntry["level"], substring: string): boolean {

  return entries.some((entry) => (entry.level === level) && String(entry.parameters[0]).includes(substring));
}

// Await the bare setTimeout(...,50) reverts the motion trigger arms outside this.timers, so the revert fires within the test rather than after teardown. 60ms clears the
// 50ms timer with margin, exactly as the chime suite waits out its own bare reverts.
async function awaitBareRevert(): Promise<void> {

  await new Promise<void>((resolve) => setTimeout(resolve, 60));
}

// The carrier identity, pinned so the firehose-routing assertions match the recorded id and the MQTT topic composition matches the device MAC. The all-quiet
// makeSensorConfig default carries isMotionDetected: true (the Motion.* hasProperty applicability gate) and state CONNECTED + isConnected true (so isReachable is true).
const SENSOR_ID = "test-sensor-1";
const SENSOR_MAC = "74ACB9000401";

// The reusable construction helper: build a REAL TestBaseDevice (a concrete ProtectDevice leaf whose ctor only super()s) against the harness doubles, seeded with the
// all-quiet sensor carrier and the recording dispatch injected through the NVR double's dispatch seam. The casts are confined to the construction seam exactly as the
// light / chime suites do; the instance under test is the production base, running its real configureHints / configureMotionSensor / configureOccupancySensor paths. We
// drive the wiring a family leaf would: configureHints first (the motion configurators read this.hints), then the two motion configurators with isEnabled true. The
// userOptions thread into the REAL FeatureOptions engine, so the Enable.Motion.* strings - and only those - materialize the services.
function buildMotionDevice(harnessOptions: { userOptions?: string[] } = {}): {
  accessory: TestAccessory; device: TestBaseDevice; logEntries: TestLogEntry[]; mqtt: TestMqttClient; recording: TestRecordingDispatch;
} {

  const sensorConfig = makeSensorConfig();
  const store = new TestStateStore(makeProtectState({ sensors: [sensorConfig] }));
  const { logEntries, mqtt, nvr } = makeTestNvr({ dispatch: (innerNvr: ProtectNvr): TestRecordingDispatch => new TestRecordingDispatch(innerNvr), mqtt: true, store,
    userOptions: harnessOptions.userOptions });
  const recording = nvr.events as TestRecordingDispatch;
  const accessory = makeTestAccessory("Test Sensor", "uuid:test-sensor");

  // The device-leaf mqttId now sources the bare MAC from the persisted accessory context, not this.ufp.mac, so seed it to match the projection's MAC for the topic-scope
  // assertions.
  accessory.context["mac"] = sensorConfig.mac;

  const projection = new TestSensorProjection(sensorConfig.id, store) as unknown as Sensor;
  const device = new TestBaseDevice(nvr as unknown as ProtectNvr, accessory as unknown as ProtectAccessory, projection);

  // makeTestNvr was called with mqtt: true, so the MQTT client double is present; a guard narrows Nullable<TestMqttClient> to the non-null type without an assertion or a
  // same-type cast (either of which the house lint preset forbids in opposite directions), and fails loudly if the opt-in ever stops installing the double.
  if(!mqtt) {

    throw new Error("The MQTT recording double was not installed despite mqtt: true.");
  }

  // Wire the base capabilities the way a family leaf does: hints first (the motion configurators read this.hints), then the motion sensor (which configures the switch /
  // trigger) and the occupancy sensor. isEnabled is true; whether each switch / service actually materializes is then governed entirely by the Enable.Motion.*
  // userOptions.
  device.configureHintsFor();
  device.configureMotionSensorFor(true);
  device.configureOccupancySensorFor(true);

  return { accessory, device, logEntries, mqtt, recording };
}

describe("base ProtectDevice motion capability (device-motion concern net)", () => {

  // The per-test handle, torn down in afterEach so each test's per-accessory abort unwinds and the bare reverts touch only their own fresh accessory.
  let device: TestBaseDevice | undefined;

  afterEach(() => {

    device?.cleanup();
    device = undefined;
  });

  describe("the motion sensor switch (Motion.Switch)", () => {

    test("with the feature, the switch exists, reads detectMotion, toggles it, and logs the enabling line", async () => {

      const built = buildMotionDevice({ userOptions: ["Enable.Motion.Switch"] });

      device = built.device;

      // HARD-assert the service exists FIRST: with Enable.Motion.Switch the SWITCH_MOTION_SENSOR-subtyped Switch must materialize, so an absent service throws here
      // rather than letting later optional-chained assertions pass vacuously.
      const motionSwitch = built.accessory.getServiceById(Service.Switch, ProtectReservedNames.SWITCH_MOTION_SENSOR);

      assert.ok(motionSwitch, "the Motion.Switch feature materializes the SWITCH_MOTION_SENSOR switch");
      assert.ok(loggedAt(built.logEntries, "info", "Enabling motion sensor switch."), "the enabling line logged");

      const onChar = motionSwitch.getCharacteristic(Characteristic.On);

      // detectMotion defaults true (initialized on first configure), so the onGet reads true and the switch initialized to true.
      assert.equal(onChar.value, true, "the switch initialized On to the default detectMotion (true)");
      assert.equal(await onChar.triggerGet(), true, "the On getter reads context.detectMotion (true by default)");

      // onSet false flips detectMotion off and logs the disabled line; onSet true flips it back on and logs the enabled line.
      await onChar.triggerSet(false);

      assert.equal(built.device.accessory.context.detectMotion, false, "the onSet wrote context.detectMotion false");
      assert.ok(loggedAt(built.logEntries, "info", "Motion detection disabled."), "the disabled-on-change line logged");

      await onChar.triggerSet(true);

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
  });

  describe("the manual motion trigger (Motion.Trigger)", () => {

    test("with the feature, the trigger exists, inits off, logs the enabling line, and a trigger-on fires the firehose once", async () => {

      const built = buildMotionDevice({ userOptions: ["Enable.Motion.Trigger"] });

      device = built.device;

      const trigger = built.accessory.getServiceById(Service.Switch, ProtectReservedNames.SWITCH_MOTION_TRIGGER);

      assert.ok(trigger, "the Motion.Trigger feature materializes the SWITCH_MOTION_TRIGGER switch");
      assert.ok(loggedAt(built.logEntries, "info", "Enabling motion sensor automation trigger."), "the enabling line logged");

      const onChar = trigger.getCharacteristic(Characteristic.On);

      assert.equal(onChar.value, false, "the trigger initialized On to false");

      // No motion switch is present (Motion.Switch was not enabled), so the onSet's switchService is undefined and the else-branch fires the firehose. Baseline the
      // recorded calls so the assertion measures only this trigger.
      const baseline = built.recording.calls.length;

      await onChar.triggerSet(true);

      assert.equal(built.recording.calls.length - baseline, 1, "a trigger-on with no motion switch routed to motionEventHandler exactly once");
      assert.deepEqual(built.recording.calls[baseline], { id: SENSOR_ID, kind: "motion" }, "the firehose call carried the carrier id and the motion kind");
      assert.ok(loggedAt(built.logEntries, "info", "Motion event triggered."), "the triggered line logged");
    });

    test("with both switches, a trigger-on while motion detection is OFF takes the bare revert and fires no firehose", async () => {

      // Both switches present so configureMotionTrigger's onSet can see the motion switch and read its OFF state - the disabled-revert branch (the bare setTimeout(->
      // false, 50) NOT in this.timers).
      const built = buildMotionDevice({ userOptions: [ "Enable.Motion.Switch", "Enable.Motion.Trigger" ] });

      device = built.device;

      const motionSwitch = built.accessory.getServiceById(Service.Switch, ProtectReservedNames.SWITCH_MOTION_SENSOR);
      const trigger = built.accessory.getServiceById(Service.Switch, ProtectReservedNames.SWITCH_MOTION_TRIGGER);

      assert.ok(motionSwitch, "the motion switch materialized");
      assert.ok(trigger, "the trigger materialized");

      // Turn motion detection OFF so the trigger's onSet sees switchService.On === false and takes the revert path.
      const motionOn = motionSwitch.getCharacteristic(Characteristic.On);

      await motionOn.triggerSet(false);

      assert.equal(motionOn.value, false, "the motion switch is now OFF");

      const triggerOn = trigger.getCharacteristic(Characteristic.On);
      const baseline = built.recording.calls.length;

      await triggerOn.triggerSet(true);

      // Let the bare setTimeout(-> false, 50) fire within the test. The revert is NOT in this.timers, so cleanup() would not clear it.
      await awaitBareRevert();

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

      // Drive the off-revert in configureMotionTrigger's onSet (device.ts): on isOn false it re-arms the trigger to true via a bare setTimeout(-> true, 50) IFF the
      // motion sensor still reports motion. Set MotionDetected true to model live motion, then turn the trigger off.
      motionService.updateCharacteristic(Characteristic.MotionDetected, true);

      const triggerOn = trigger.getCharacteristic(Characteristic.On);

      await triggerOn.triggerSet(false);
      await awaitBareRevert();

      assert.equal(triggerOn.value, true, "the off-revert re-armed the trigger to on because the motion sensor still reported motion");
    });
  });

  describe("the occupancy sensor (Motion.OccupancySensor)", () => {

    test("with the feature, the occupancy service exists with StatusActive reading isReachable and OccupancyDetected initialized false", async () => {

      const built = buildMotionDevice({ userOptions: ["Enable.Motion.OccupancySensor"] });

      device = built.device;

      // HARD-assert the SERVICE exists FIRST - this is the primary, non-optional discriminator that defeats vacuity.
      const occupancy = built.accessory.getService(Service.OccupancySensor);

      assert.ok(occupancy, "the Motion.OccupancySensor feature materializes the OccupancySensor service");
      assert.ok(loggedAt(built.logEntries, "info", "Enabling occupancy sensor."), "the enabling line logged (no smart-detect suffix on the base carrier)");

      // OccupancyDetected initializes false (the A.5 characteristic the harness now carries on the OccupancySensor service).
      assert.equal(occupancy.getCharacteristic(Characteristic.OccupancyDetected).value, false, "OccupancyDetected initialized to false");

      // StatusActive reads isReachable, a non-trivial harness-driven value: the carrier is isConnected: true and CONNECTED and the client connection is healthy, so
      // isReachable is true.
      assert.equal(occupancy.getCharacteristic(Characteristic.StatusActive).value, true, "StatusActive initialized to isReachable (true for a reachable carrier)");
      assert.equal(await occupancy.getCharacteristic(Characteristic.StatusActive).triggerGet(), true, "the StatusActive getter reads isReachable (true)");
    });

    test("without the feature, no occupancy service is materialized", () => {

      const built = buildMotionDevice();

      device = built.device;

      assert.equal(built.accessory.getService(Service.OccupancySensor), undefined, "omitting Enable.Motion.OccupancySensor materializes no occupancy service");
    });
  });

  describe("the base motion get/set MQTT seam", () => {

    test("the motion set handler fires the firehose on \"true\" and is a no-op otherwise; the get handler reads MotionDetected; the topic is MAC-scoped", async () => {

      const built = buildMotionDevice();

      device = built.device;

      // The motion get/set MQTT registrations are unconditional in configureMotionSensor (independent of the Motion.* switch features), so they are present on the bare
      // carrier. Find each by the MAC-scoped topic and kind.
      const motionTopic = SENSOR_MAC + "/motion";
      const setSub = built.mqtt.subscriptions.find((subscription) => (subscription.topic === motionTopic) && (subscription.kind === "set"));
      const getSub = built.mqtt.subscriptions.find((subscription) => (subscription.topic === motionTopic) && (subscription.kind === "get"));

      assert.ok(setSub, "the motion set subscription registered on the MAC-scoped topic");
      assert.ok(getSub, "the motion get subscription registered on the MAC-scoped topic");

      // The firehose-live half: a "true" payload routes to motionEventHandler exactly once, carrying the carrier id.
      const trueBaseline = built.recording.calls.length;

      await setSub.setValue?.("true", "true");

      assert.equal(built.recording.calls.length - trueBaseline, 1, "a \"true\" motion set routed to motionEventHandler exactly once");
      assert.deepEqual(built.recording.calls[trueBaseline], { id: SENSOR_ID, kind: "motion" }, "the firehose call carried the carrier id and the motion kind");

      // The non-"true" half is non-vacuous only because the "true" half proved the path live: from a FRESH baseline, a "false" payload routes nothing.
      const falseBaseline = built.recording.calls.length;

      await setSub.setValue?.("false", "false");

      assert.equal(built.recording.calls.length - falseBaseline, 0, "a non-\"true\" motion set is a no-op (no firehose)");

      // The get handler reflects the MotionDetected characteristic state: false initially, true once the motion service is flipped.
      assert.equal(getSub.getValue?.(), "false", "the motion get reads the initial MotionDetected state (false)");

      const motionService = built.accessory.getService(Service.MotionSensor);

      assert.ok(motionService, "the motion sensor service exists for the get read-through");

      motionService.updateCharacteristic(Characteristic.MotionDetected, true);

      assert.equal(getSub.getValue?.(), "true", "the motion get reflects the flipped MotionDetected state (true)");
    });
  });
});
