/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * device-statusled.test.ts: The base-capability concern net for the shared ProtectDevice status-indicator switch, netted once family-agnostically.
 *
 * The status-indicator switch (Device.StatusLed.Switch) is a BASE ProtectDevice behavior: configureStatusLedSwitch (device.ts) acquires the switch, setStatusLed
 * (device.ts) routes the onSet through the shared command-error helper, and statusLedCommand (device.ts) resolves the device-appropriate write-through update.
 * Cameras, sensors, and relays share the ledSettings.isEnabled routing the base serves directly (it narrows this.device through its modelKey discriminant), so this net
 * rides the all-quiet makeSensorConfig carrier - which always carries ledSettings - as the shared vehicle. Per the two-layer test architecture the base
 * camera/sensor/relay routing is netted ONCE here against the shared minimal TestBaseDevice vehicle rather than re-asserted inside each family suite. The light's
 * statusLedCommand override (its lightDeviceSettings command) is LIGHT-family-specific and stays owned by light.test.ts; the chime / viewer projections expose no status
 * indicator and never configure the switch, so the statusLed false-branch (the hasLedSettings structural check finding no "ledSettings" key on the peeked device record)
 * is unreachable via this carrier and is honestly out of this file's reach.
 *
 * The vacuity gate (load-bearing, carried from device-motion): the Device.StatusLed.Switch option defaults to FALSE, so the runtime service gate is the
 * Enable.Device.StatusLed.Switch userOptions string, NOT the carrier's ledSettings. The carrier's ledSettings only backs the read-through (the switch's On state) and
 * satisfies the option's hasSensorProperty applicability check; it does NOT materialize a service. So every with-feature test builds with the exact
 * Enable.Device.StatusLed.Switch userOptions and HARD-asserts the switch EXISTS (a non-optional assert.ok as the FIRST discriminator) - an absent service then throws
 * rather than passing vacuously - paired with a without-feature absence test that proves the same path produces nothing when the string is omitted.
 *
 * The command-routing net exercises TestSensorProjection.update's recorder for the first time: the onSet drives setStatusLed -> statusLedCommand ->
 * device.update({ ledSettings: { isEnabled: <value> } }), and the projection RECORDS that payload (it deliberately does not fold it back into the store), so the test
 * asserts updateCalls deepEquals the exact { payload: { ledSettings } } shape. Because the projection never folds, statusLed reads the carrier's static ledEnabled
 * across the whole test, which is what keys the if(this.statusLed !== value) change-gate: the no-change case (value === ledEnabled) suppresses the onSet log but STILL
 * issues the command, so it is asserted on the command - never vacuously - while the change case asserts both the log and the command. The failure / authorization paths
 * set projection.updateRejection so the real runDeviceCommand branch reports through the shared command-error helper.
 *
 * The isolation model is per-test-fresh: each test calls buildStatusLedDevice with its own userOptions, and an afterEach unwinds the device's per-accessory abort. The
 * status-LED switch is neither observeState- nor MQTT-driven (it is a HAP confirm-plus-state path), so there is no observer-wake subscription, no MQTT assertion, and no
 * bare-revert await - the onSet arms no timer.
 */
import { Characteristic, Service, TestBaseDevice, TestSensorProjection, TestStateStore, makeProtectState, makeSensorConfig, makeTestAccessory, makeTestNvr }
  from "../testing.helpers.ts";
import type { TestAccessory, TestLogEntry } from "../testing.helpers.ts";
import { afterEach, describe, test } from "node:test";
import type { ProtectAccessory } from "../types.ts";
import { ProtectAuthorizationError } from "unifi-protect";
import type { ProtectNvr } from "../nvr/nvr.ts";
import { ProtectReservedNames } from "../types.ts";
import type { Sensor } from "unifi-protect";
import assert from "node:assert/strict";

// The device log wrapper formats every line through util.format into a single string parameter prefixed with the device name (for example "Test Sensor: Status indicator
// light enabled."), so a log assertion matches a substring of that one formatted parameter at the given level, mirroring the device-motion / chime suites' helper.
function loggedAt(entries: TestLogEntry[], level: TestLogEntry["level"], substring: string): boolean {

  return entries.some((entry) => (entry.level === level) && String(entry.parameters[0]).includes(substring));
}

// A tail-exact variant of loggedAt: it requires a formatted line at the given level to END WITH the supplied suffix. The failure-path assertion uses this so a regression
// in runDeviceCommand's trailing-period strip (which would leave the line ending in a doubled period after the format string supplies its own terminal one) fails the
// test, where a plain includes() of the single-period suffix would still match the doubled-period substring and let the regression through.
function tailLoggedAt(entries: TestLogEntry[], level: TestLogEntry["level"], suffix: string): boolean {

  return entries.some((entry) => (entry.level === level) && String(entry.parameters[0]).endsWith(suffix));
}

// The reusable construction helper: build a REAL TestBaseDevice (a concrete ProtectDevice leaf whose ctor only super()s) against the harness doubles, seeded with the
// all-quiet sensor carrier whose ledSettings.isEnabled the configOptions.ledEnabled toggles. We HOLD the TestSensorProjection instance (cast to Sensor only at the
// construction seam, exactly as the light / chime suites confine their casts) so the test asserts the recorded update payloads. We drive the wiring a family leaf would:
// configureHints first (the base configurators read this.hints), then the status-LED switch with isEnabled true. The userOptions thread into the REAL FeatureOptions
// engine, so the Enable.Device.StatusLed.Switch string - and only it - materializes the switch.
function buildStatusLedDevice(configOptions: { ledEnabled?: boolean } = {}, harnessOptions: { userOptions?: string[] } = {}): {
  accessory: TestAccessory; device: TestBaseDevice; logEntries: TestLogEntry[]; projection: TestSensorProjection;
} {

  const sensorConfig = makeSensorConfig(configOptions);
  const store = new TestStateStore(makeProtectState({ sensors: [sensorConfig] }));
  const { logEntries, nvr } = makeTestNvr({ mqtt: true, store, userOptions: harnessOptions.userOptions });
  const accessory = makeTestAccessory("Test Sensor", "uuid:test-sensor");
  const projection = new TestSensorProjection(sensorConfig.id, store);
  const device = new TestBaseDevice(nvr as unknown as ProtectNvr, accessory as unknown as ProtectAccessory, projection as unknown as Sensor);

  // Wire the base capabilities the way a family leaf does: hints first, then the status-LED switch with isEnabled true. Whether the switch actually materializes is then
  // governed entirely by the Enable.Device.StatusLed.Switch userOptions.
  device.configureHintsFor();
  device.configureStatusLedSwitchFor(true);

  return { accessory, device, logEntries, projection };
}

describe("base ProtectDevice status-indicator switch capability (device-statusled concern net)", () => {

  // The per-test handle, torn down in afterEach so each test's per-accessory abort unwinds.
  let device: TestBaseDevice | undefined;

  afterEach(() => {

    device?.cleanup();
    device = undefined;
  });

  describe("construction and reflection", () => {

    test("with the feature and ledEnabled true, the switch exists, inits On true, onGet reads true, and the enabling line logs", async () => {

      const built = buildStatusLedDevice({ ledEnabled: true }, { userOptions: ["Enable.Device.StatusLed.Switch"] });

      device = built.device;

      // HARD-assert the service exists FIRST: with Enable.Device.StatusLed.Switch the SWITCH_STATUS_LED-subtyped Switch must materialize, so an absent service throws
      // here rather than letting later optional-chained assertions pass vacuously.
      const statusLedSwitch = built.accessory.getServiceById(Service.Switch, ProtectReservedNames.SWITCH_STATUS_LED);

      assert.ok(statusLedSwitch, "the Device.StatusLed.Switch feature materializes the SWITCH_STATUS_LED switch");
      assert.ok(loggedAt(built.logEntries, "info", "Enabling status indicator light switch."), "the enabling line logged");

      const onChar = statusLedSwitch.getCharacteristic(Characteristic.On);

      // The switch initializes On to statusLed (ledSettings.isEnabled), which the carrier seeded true, and the onGet reads the same through the projection.
      assert.equal(onChar.value, true, "the switch initialized On to statusLed (ledSettings.isEnabled, true here)");
      assert.equal(await onChar.triggerGet(), true, "the On getter reads statusLed (true)");
    });

    test("with the feature and ledEnabled false, the switch exists but inits On false and onGet reads false", async () => {

      const built = buildStatusLedDevice({ ledEnabled: false }, { userOptions: ["Enable.Device.StatusLed.Switch"] });

      device = built.device;

      const statusLedSwitch = built.accessory.getServiceById(Service.Switch, ProtectReservedNames.SWITCH_STATUS_LED);

      assert.ok(statusLedSwitch, "the switch materializes regardless of the LED state (the feature gate is the userOptions, not ledSettings)");

      const onChar = statusLedSwitch.getCharacteristic(Characteristic.On);

      assert.equal(onChar.value, false, "the switch initialized On to statusLed (ledSettings.isEnabled, false here)");
      assert.equal(await onChar.triggerGet(), false, "the On getter reads statusLed (false)");
    });

    test("without the feature, no status-indicator switch is materialized", () => {

      const built = buildStatusLedDevice({ ledEnabled: true });

      device = built.device;

      assert.equal(built.accessory.getServiceById(Service.Switch, ProtectReservedNames.SWITCH_STATUS_LED), undefined,
        "omitting Enable.Device.StatusLed.Switch materializes no status-indicator switch");
    });
  });

  describe("the onSet command routing and the change-gated log", () => {

    test("an onSet that turns the LED off logs the disabled line and routes the ledSettings update", async () => {

      const built = buildStatusLedDevice({ ledEnabled: true }, { userOptions: ["Enable.Device.StatusLed.Switch"] });

      device = built.device;

      const statusLedSwitch = built.accessory.getServiceById(Service.Switch, ProtectReservedNames.SWITCH_STATUS_LED);

      assert.ok(statusLedSwitch, "the switch materialized");

      // The carrier reads ledEnabled true, so onSet false is a change: it logs the disabled line and routes the camera/sensor statusLedCommand
      // (device.update({ ledSettings: { isEnabled: false } })). deepEqual on the whole array catches a missing or empty update.
      await statusLedSwitch.getCharacteristic(Characteristic.On).triggerSet(false);

      assert.ok(loggedAt(built.logEntries, "info", "Status indicator light disabled."), "the disabled-on-change line logged");
      assert.deepEqual(built.projection.updateCalls, [{ payload: { ledSettings: { isEnabled: false } } }], "the onSet routed the ledSettings update (isEnabled false)");
    });

    test("an onSet that turns the LED on logs the enabled line and routes the ledSettings update", async () => {

      const built = buildStatusLedDevice({ ledEnabled: false }, { userOptions: ["Enable.Device.StatusLed.Switch"] });

      device = built.device;

      const statusLedSwitch = built.accessory.getServiceById(Service.Switch, ProtectReservedNames.SWITCH_STATUS_LED);

      assert.ok(statusLedSwitch, "the switch materialized");

      // The carrier reads ledEnabled false, so onSet true is a change: it logs the enabled line and routes device.update({ ledSettings: { isEnabled: true } }).
      await statusLedSwitch.getCharacteristic(Characteristic.On).triggerSet(true);

      assert.ok(loggedAt(built.logEntries, "info", "Status indicator light enabled."), "the enabled-on-change line logged");
      assert.deepEqual(built.projection.updateCalls, [{ payload: { ledSettings: { isEnabled: true } } }], "the onSet routed the ledSettings update with isEnabled true");
    });

    test("an onSet matching the current LED state issues NO change log but STILL routes the command", async () => {

      const built = buildStatusLedDevice({ ledEnabled: true }, { userOptions: ["Enable.Device.StatusLed.Switch"] });

      device = built.device;

      const statusLedSwitch = built.accessory.getServiceById(Service.Switch, ProtectReservedNames.SWITCH_STATUS_LED);

      assert.ok(statusLedSwitch, "the switch materialized");

      // The carrier reads ledEnabled true, and the projection never folds the update, so statusLed stays true across the test: onSet true is value === statusLed, so the
      // if(this.statusLed !== value) guard suppresses BOTH onSet log lines. The change-gate is on the log ONLY - the command issues in both the change and no-change
      // cases - so the no-change case is asserted on the command (the exact ledSettings update), which is what keeps it non-vacuous.
      await statusLedSwitch.getCharacteristic(Characteristic.On).triggerSet(true);

      assert.equal(loggedAt(built.logEntries, "info", "Status indicator light enabled."), false, "no enabled change-log on a same-value set");
      assert.equal(loggedAt(built.logEntries, "info", "Status indicator light disabled."), false, "no disabled change-log on a same-value set");
      assert.deepEqual(built.projection.updateCalls, [{ payload: { ledSettings: { isEnabled: true } } }], "the command still issued on a same-value set");
    });
  });

  describe("the failure and authorization paths", () => {

    test("a write rejection reports the failure with its underlying cause and does not throw out of the onSet", async () => {

      const built = buildStatusLedDevice({ ledEnabled: true }, { userOptions: ["Enable.Device.StatusLed.Switch"] });

      device = built.device;

      const statusLedSwitch = built.accessory.getServiceById(Service.Switch, ProtectReservedNames.SWITCH_STATUS_LED);

      assert.ok(statusLedSwitch, "the switch materialized");

      // Arm the projection to reject the next write, so the real runDeviceCommand catch reports through the shared command-error helper. onSet false is a change here, so
      // the action interpolated is "turn the status indicator light off"; the message strips its own trailing period before the format string supplies the terminal one.
      built.projection.updateRejection = new Error("The device is unreachable.");

      await statusLedSwitch.getCharacteristic(Characteristic.On).triggerSet(false);

      // tailLoggedAt (not loggedAt) so the line must END WITH the single-period sentence: runDeviceCommand strips the error message's own trailing period before the
      // format string supplies the terminal one, so a regression in that strip would leave a doubled period that endsWith catches but a plain includes() would not.
      assert.ok(tailLoggedAt(built.logEntries, "error", "Unable to turn the status indicator light off: The device is unreachable."),
        "the failure line reports the action and the underlying cause, ending in exactly one period");
    });

    test("an authorization rejection earns the Administrator-role guidance", async () => {

      const built = buildStatusLedDevice({ ledEnabled: false }, { userOptions: ["Enable.Device.StatusLed.Switch"] });

      device = built.device;

      const statusLedSwitch = built.accessory.getServiceById(Service.Switch, ProtectReservedNames.SWITCH_STATUS_LED);

      assert.ok(statusLedSwitch, "the switch materialized");

      // Arm an authorization rejection, the one actionable failure: runDeviceCommand routes it to the admin-guidance line. onSet true is a change here, so the action is
      // "turn the status indicator light on".
      built.projection.updateRejection = new ProtectAuthorizationError("forbidden");

      await statusLedSwitch.getCharacteristic(Characteristic.On).triggerSet(true);

      assert.ok(loggedAt(built.logEntries, "error",
        "Unable to turn the status indicator light on. Please ensure this username has the full management role in UniFi Protect."),
      "the authorization failure earns the Administrator-role guidance");
    });
  });
});
