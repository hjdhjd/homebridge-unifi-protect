/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * device-hints.test.ts: The base-capability concern net for the shared ProtectDevice feature-option hints derivation, netted once family-agnostically.
 *
 * configureHints (device.ts) is a BASE ProtectDevice behavior every family runs at construction: it derives seven hints from feature options (enabled, logMotion,
 * motionDuration, occupancyDuration, smartOccupancy, standalone, syncName), clamps the two durations to their floors (motionDuration >= 2, occupancyDuration >= 60), and
 * logs deviations from the defaults. Per the two-layer test architecture the base derivation/clamp/log logic is netted ONCE here against the shared minimal
 * TestBaseDevice vehicle (the all-quiet makeSensorConfig carrier) rather than re-asserted inside each family suite: every concern test builds the device with a
 * userOptions set, calls the test-only configureHintsFor window, and asserts the resulting hints + the deviation logs.
 *
 * configureHints's PRODUCT is the hints object - a PUBLIC field (device.ts) consumed across the class hierarchy, the same field doorbell-construction.test.ts
 * reads directly - plus the user-visible deviation logs. So this suite reads device.hints DIRECTLY (typed Readonly<ProtectHints> at the read site for read-only intent)
 * with no harness window and no harness change; it captures the deviation logs through the NVR double's logEntries. The wider ProtectHints fields (crop,
 * hardwareDecoding, hardwareTranscoding, highResSnapshots, and the rest) are set by the CAMERA family's configureHints OVERRIDE - family-owned and out of scope here;
 * this nets the seven the BASE sets and the two clamps.
 *
 * The value-option override syntax (load-bearing, verified against homebridge-plugin-utils featureoptions.js): Motion.Duration and Motion.OccupancySensor.Duration are
 * value-centric options (default: true, defaultValue 10 / 300). The global value override is Enable.<Option>.<N> - a single trailing numeric segment parsed as the value
 * - so Enable.Motion.Duration.20 sets the value to 20 and Enable.Motion.Duration.1 sets it to 1 (then the clamp raises it to 2). Each duration / clamp test asserts the
 * EXACT resulting device.hints value, so a no-op override (the value staying at its default) fails loudly rather than passing vacuously.
 *
 * The syncName deviation log routes through scope: the test vehicle steers Device.SyncName via the GLOBAL userOption "Enable.Device.SyncName", which resolves to scope
 * "global" - so logFeature (device.ts) routes to nvr.logFeature, which emits the PLURAL "Syncing Protect device names to HomeKit." message (not the singular device
 * line). The syncName test asserts that plural line AND device.hints.syncName === true (the robust core, independent of the log path). The singular "Not syncing this
 * Protect device name to HomeKit." else-branch (device.ts) fires only when Device.SyncName is DEVICE-scoped; this vehicle uses global userOptions, so that branch is
 * acknowledged-conditional, not driven here.
 *
 * The isolation model is per-test-fresh: each test calls buildHintsDevice with its own userOptions, and an afterEach unwinds the device's per-accessory abort.
 * configureHints is synchronous and observer-free (no observeState, no services, no commands, no MQTT), so there is no observer-wake subscription and no settle() here -
 * the hints are read and the logs are asserted immediately after the synchronous configureHintsFor call.
 */
import type { TestAccessory, TestLogEntry } from "../testing.helpers.ts";
import { TestBaseDevice, TestSensorProjection, TestStateStore, makeProtectState, makeSensorConfig, makeTestAccessory, makeTestNvr } from "../testing.helpers.ts";
import { afterEach, describe, test } from "node:test";
import type { ProtectAccessory } from "../types.ts";
import type { ProtectHints } from "./device.ts";
import type { ProtectNvr } from "../nvr/nvr.ts";
import type { Sensor } from "unifi-protect";
import assert from "node:assert/strict";

// The device log wrapper formats every line through util.format into a single string parameter prefixed with the device name (for example "Test Sensor: Motion event
// duration set to 20 seconds."), so a log assertion matches a substring of that one formatted parameter at the given level, mirroring the device-motion /
// device-statusled suites' helper.
function loggedAt(entries: TestLogEntry[], level: TestLogEntry["level"], substring: string): boolean {

  return entries.some((entry) => (entry.level === level) && String(entry.parameters[0]).includes(substring));
}

// The reusable construction helper: build a REAL TestBaseDevice (a concrete ProtectDevice leaf whose ctor only super()s) against the harness doubles, seeded with the
// all-quiet sensor carrier, then run the production base configureHints through the configureHintsFor window. The casts are confined to the construction seam exactly as
// the device-motion / device-statusled suites do; the instance under test is the production base, running its real configureHints derivation / clamp / log paths. The
// userOptions thread into the REAL FeatureOptions engine, so the supplied Enable.* / Disable.* strings - and only those - move the hints off their defaults. There is no
// projection recorder, no MQTT, and no observer wiring: configureHints reads only feature options (resolved against the carrier's MAC), so a plain TestSensorProjection
// supplies the read-through identity and nothing more.
function buildHintsDevice(harnessOptions: { userOptions?: string[] } = {}): { accessory: TestAccessory; device: TestBaseDevice; logEntries: TestLogEntry[] } {

  const sensorConfig = makeSensorConfig();
  const store = new TestStateStore(makeProtectState({ sensors: [sensorConfig] }));
  const { logEntries, nvr } = makeTestNvr({ mqtt: true, store, userOptions: harnessOptions.userOptions });
  const accessory = makeTestAccessory("Test Sensor", "uuid:test-sensor");
  const projection = new TestSensorProjection(sensorConfig.id, store);
  const device = new TestBaseDevice(nvr as unknown as ProtectNvr, accessory as unknown as ProtectAccessory, projection as unknown as Sensor);

  // Run the base hints derivation the way a family leaf does at construction: a single synchronous configureHintsFor. Whether each hint moves off its default is then
  // governed entirely by the userOptions threaded into the REAL FeatureOptions engine.
  device.configureHintsFor();

  return { accessory, device, logEntries };
}

describe("base ProtectDevice feature-option hints derivation (device-hints concern net)", () => {

  // The per-test handle, torn down in afterEach so each test's per-accessory abort unwinds.
  let device: TestBaseDevice | undefined;

  afterEach(() => {

    device?.cleanup();
    device = undefined;
  });

  describe("the defaults (no userOptions)", () => {

    test("the seven base hints take their option defaults and no deviation log fires", () => {

      const built = buildHintsDevice();

      device = built.device;

      // Read the public hints field directly, typed read-only to mark the read-only intent (the field is the product configureHints derives).
      const hints: Readonly<ProtectHints> = device.hints;

      // The Device option defaults TRUE (the empty-name option under the Device category composed to "Device"), so enabled is true at no userOptions; the
      // remaining four boolean-backed hints take their false / unset defaults, and the two durations take their registered defaultValues (10 / 300).
      assert.equal(hints.enabled, true, "enabled defaults to true (the Device option defaults true)");
      assert.equal(hints.logMotion, false, "logMotion defaults to false (Log.Motion defaults false)");
      assert.equal(hints.motionDuration, 10, "motionDuration defaults to PROTECT_MOTION_DURATION (10)");
      assert.equal(hints.occupancyDuration, 300, "occupancyDuration defaults to PROTECT_OCCUPANCY_DURATION (300)");
      assert.deepEqual(hints.smartOccupancy, [], "smartOccupancy seeds to an empty array (the base sets [], the camera family populates it)");
      assert.equal(hints.standalone, false, "standalone defaults to false (Device.Standalone defaults false)");
      assert.equal(hints.syncName, false, "syncName defaults to false (Device.SyncName defaults false)");

      // No hint deviated from its default, so none of the deviation logs fire.
      assert.equal(loggedAt(built.logEntries, "info", "Motion event duration set to"), false, "no motion-duration deviation log at the defaults");
      assert.equal(loggedAt(built.logEntries, "info", "Occupancy event duration set to"), false, "no occupancy-duration deviation log at the defaults");
      assert.equal(loggedAt(built.logEntries, "info", "Syncing Protect device name"), false, "no syncName deviation log at the defaults (singular nor plural)");
    });
  });

  describe("the boolean toggles (each discriminating - moved off its default)", () => {

    test("Disable.Device drives enabled false while the other hints stay at their defaults", () => {

      // The Device option defaults TRUE, so the discriminating toggle is the off-the-default Disable.Device direction (Enable.Device would be vacuous).
      const built = buildHintsDevice({ userOptions: ["Disable.Device"] });

      device = built.device;

      const hints: Readonly<ProtectHints> = device.hints;

      assert.equal(hints.enabled, false, "Disable.Device drives enabled false");

      // The five asserted hints stay at their defaults, so the toggle is discriminating - a derivation that hard-coded or mis-sourced one of them would be caught.
      assert.equal(hints.logMotion, false, "logMotion stays at its default");
      assert.equal(hints.motionDuration, 10, "motionDuration stays at its default");
      assert.equal(hints.occupancyDuration, 300, "occupancyDuration stays at its default");
      assert.equal(hints.standalone, false, "standalone stays at its default");
      assert.equal(hints.syncName, false, "syncName stays at its default");
    });

    test("Enable.Log.Motion drives logMotion true while the other hints stay at their defaults", () => {

      const built = buildHintsDevice({ userOptions: ["Enable.Log.Motion"] });

      device = built.device;

      const hints: Readonly<ProtectHints> = device.hints;

      assert.equal(hints.logMotion, true, "Enable.Log.Motion drives logMotion true");

      assert.equal(hints.enabled, true, "enabled stays at its default (true)");
      assert.equal(hints.motionDuration, 10, "motionDuration stays at its default");
      assert.equal(hints.occupancyDuration, 300, "occupancyDuration stays at its default");
      assert.equal(hints.standalone, false, "standalone stays at its default");
      assert.equal(hints.syncName, false, "syncName stays at its default");
    });

    test("Enable.Device.Standalone drives standalone true while the other hints stay at their defaults", () => {

      const built = buildHintsDevice({ userOptions: ["Enable.Device.Standalone"] });

      device = built.device;

      const hints: Readonly<ProtectHints> = device.hints;

      assert.equal(hints.standalone, true, "Enable.Device.Standalone drives standalone true");

      assert.equal(hints.enabled, true, "enabled stays at its default (true)");
      assert.equal(hints.logMotion, false, "logMotion stays at its default");
      assert.equal(hints.motionDuration, 10, "motionDuration stays at its default");
      assert.equal(hints.occupancyDuration, 300, "occupancyDuration stays at its default");
      assert.equal(hints.syncName, false, "syncName stays at its default");
    });

    test("Enable.Device.SyncName drives syncName true and emits the global-scope plural log while the other hints stay at their defaults", () => {

      const built = buildHintsDevice({ userOptions: ["Enable.Device.SyncName"] });

      device = built.device;

      const hints: Readonly<ProtectHints> = device.hints;

      // The robust core, asserted independently of the log path: the global userOption drives syncName true.
      assert.equal(hints.syncName, true, "Enable.Device.SyncName drives syncName true");

      // The global userOption resolves to scope "global", so logFeature routes to nvr.logFeature, which emits the PLURAL message (not the singular device line).
      assert.ok(loggedAt(built.logEntries, "info", "Syncing Protect device names to HomeKit."), "the global-scope syncName routes to the plural nvr message");
      assert.equal(loggedAt(built.logEntries, "info", "Syncing Protect device name to HomeKit."), false,
        "the singular device line does NOT fire (the userOption is global-scoped, not device-scoped)");

      assert.equal(hints.enabled, true, "enabled stays at its default (true)");
      assert.equal(hints.logMotion, false, "logMotion stays at its default");
      assert.equal(hints.motionDuration, 10, "motionDuration stays at its default");
      assert.equal(hints.occupancyDuration, 300, "occupancyDuration stays at its default");
      assert.equal(hints.standalone, false, "standalone stays at its default");
    });
  });

  describe("the duration overrides", () => {

    test("Enable.Motion.Duration.20 sets motionDuration to 20 and logs the deviation", () => {

      const built = buildHintsDevice({ userOptions: ["Enable.Motion.Duration.20"] });

      device = built.device;

      const hints: Readonly<ProtectHints> = device.hints;

      // The exact value is asserted so a no-op override (motionDuration staying at the default 10) fails loudly rather than passing vacuously.
      assert.equal(hints.motionDuration, 20, "the value-option override set motionDuration to 20");
      assert.ok(loggedAt(built.logEntries, "info", "Motion event duration set to 20 seconds."), "the motion-duration deviation log fired with the override value");

      // The sibling duration stays at its default, so the override is scoped to the one option.
      assert.equal(hints.occupancyDuration, 300, "occupancyDuration stays at its default");
    });

    test("Enable.Motion.OccupancySensor.Duration.120 sets occupancyDuration to 120 and logs the deviation", () => {

      const built = buildHintsDevice({ userOptions: ["Enable.Motion.OccupancySensor.Duration.120"] });

      device = built.device;

      const hints: Readonly<ProtectHints> = device.hints;

      assert.equal(hints.occupancyDuration, 120, "the value-option override set occupancyDuration to 120");
      assert.ok(loggedAt(built.logEntries, "info", "Occupancy event duration set to 120 seconds."),
        "the occupancy-duration deviation log fired with the override value");

      assert.equal(hints.motionDuration, 10, "motionDuration stays at its default");
    });
  });

  describe("the duration clamps", () => {

    test("Enable.Motion.Duration.1 clamps motionDuration up to 2 and logs the clamped value", () => {

      const built = buildHintsDevice({ userOptions: ["Enable.Motion.Duration.1"] });

      device = built.device;

      const hints: Readonly<ProtectHints> = device.hints;

      // The override sets the raw value to 1; the clamp floor (motionDuration >= 2) raises it to 2, and the deviation log (2 !== 10) reports the clamped value.
      assert.equal(hints.motionDuration, 2, "the sub-floor override clamped motionDuration up to 2");
      assert.ok(loggedAt(built.logEntries, "info", "Motion event duration set to 2 seconds."), "the deviation log reported the clamped value (2)");
    });

    test("Enable.Motion.OccupancySensor.Duration.1 clamps occupancyDuration up to 60 and logs the clamped value", () => {

      const built = buildHintsDevice({ userOptions: ["Enable.Motion.OccupancySensor.Duration.1"] });

      device = built.device;

      const hints: Readonly<ProtectHints> = device.hints;

      // The override sets the raw value to 1; the clamp floor (occupancyDuration >= 60) raises it to 60, and the deviation log (60 !== 300) reports the clamped value.
      assert.equal(hints.occupancyDuration, 60, "the sub-floor override clamped occupancyDuration up to 60");
      assert.ok(loggedAt(built.logEntries, "info", "Occupancy event duration set to 60 seconds."), "the deviation log reported the clamped value (60)");
    });
  });

  describe("the constant fallback when the option is disabled", () => {

    // These two cases exercise the `?? PROTECT_MOTION_DURATION` / `?? PROTECT_OCCUPANCY_DURATION` constant fallbacks (in configureHints, device.ts) distinctly from the
    // value-option-defaultValue path the defaults case covers. A value-centric duration option defaults true with a registered defaultValue, so at no userOptions
    // getFeatureNumber returns that defaultValue (10 / 300) DIRECTLY and the `??` fallback is never reached. Disabling the option makes getFeatureNumber return null
    // (verified: Disable.Motion.Duration and Disable.Motion.OccupancySensor.Duration both resolve getInteger to null), so the `??` falls through to the PROTECT_*
    // constant - which happens to equal the same default value, so no deviation log fires (the resolved duration equals PROTECT_*_DURATION). Asserting the exact value
    // here keeps the constant-fallback branch non-vacuous: a swap of the fallback constant would change the resolved value and fail loudly.

    test("Disable.Motion.Duration falls back to PROTECT_MOTION_DURATION (10) and fires no deviation log", () => {

      const built = buildHintsDevice({ userOptions: ["Disable.Motion.Duration"] });

      device = built.device;

      const hints: Readonly<ProtectHints> = device.hints;

      // getFeatureNumber returns null for the disabled option, so the `?? PROTECT_MOTION_DURATION` fallback resolves to 10; 10 equals the default, so no deviation log
      // fires.
      assert.equal(hints.motionDuration, 10, "the disabled-option path falls back to PROTECT_MOTION_DURATION (10)");
      assert.equal(loggedAt(built.logEntries, "info", "Motion event duration set to"), false, "no motion-duration deviation log (the fallback equals the default)");

      // The sibling duration stays at its own (value-option-defaultValue) default, so the disable is scoped to the one option.
      assert.equal(hints.occupancyDuration, 300, "occupancyDuration stays at its default");
    });

    test("Disable.Motion.OccupancySensor.Duration falls back to PROTECT_OCCUPANCY_DURATION (300) and fires no deviation log", () => {

      const built = buildHintsDevice({ userOptions: ["Disable.Motion.OccupancySensor.Duration"] });

      device = built.device;

      const hints: Readonly<ProtectHints> = device.hints;

      // getFeatureNumber returns null for the disabled option, so the `?? PROTECT_OCCUPANCY_DURATION` fallback resolves to 300; 300 === the default, so no log fires.
      assert.equal(hints.occupancyDuration, 300, "the disabled-option path falls back to PROTECT_OCCUPANCY_DURATION (300)");
      assert.equal(loggedAt(built.logEntries, "info", "Occupancy event duration set to"), false,
        "no occupancy-duration deviation log (the constant fallback equals the default)");

      assert.equal(hints.motionDuration, 10, "motionDuration stays at its default");
    });
  });
});
