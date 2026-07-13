/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * camera-onsets.test.ts: The camera-leaf device.update-backed onSet net - the bound HomeKit onSet handlers that write through runDeviceCommand -> device.update,
 * driven against the REAL constructed ProtectCamera both on the SUCCESS path (the captured update payload plus the inline / observer reflection) and on the FAILURE path
 * (the revert where production reverts, the no-revert + error-log contract where it does not, and the runDeviceCommand error branches).
 *
 * camera-reactions.test.ts explicitly deferred these: the night-vision-dimmer On / Brightness onSets, the status-LED-switch onSet, and the recording-switch
 * onSet "all route through runDeviceCommand -> device.update and belong to the projection command surface - this suite drives none of them." This is that
 * Tier-2 suite. It is unlocked by the ONE harness add this tier needs: a recording update() member on TestCameraProjection (testing.helpers.ts), the proven
 * resolve-by-default + settable-rejection idiom (TestSensorProjection.update). The member RECORDS the payload and does NOT fold it into the store, so the command (the
 * captured updateCalls payload) and the reflection (an inline-local characteristic write, or an observer-driven push) are asserted INDEPENDENTLY - folding would make a
 * broken observer pass vacuously.
 *
 * runDeviceCommand (device-base.ts) is the chokepoint: await command() -> true on success; any throw -> false, logging one of its branches - a
 * ProtectAuthorizationError earns the admin-role guidance, anything else earns the trailing-period-stripped "Unable to %s: %s." line. It does NOT revert; the CALLER
 * reverts gated on the boolean. So updateRejection null drives the success path, a plain Error the plain-error branch, and a ProtectAuthorizationError the admin-guidance
 * branch.
 *
 * The 50ms reverts (the dimmer-On failure revert, and the dimmer-Brightness success reflect) use the GLOBAL setTimeout, which mock.timers intercepts (the
 * established event-dispatch.test.ts pattern); settle() is one setImmediate macrotask and does NOT advance setTimeout timers, so a revert assertion relying on
 * settle alone is vacuous.
 * Every timed assertion enables mock.timers, awaits the onSet to completion (which schedules the timer), ticks(50), asserts, and resets in finally. The vacuity gate is
 * two-part, carried from the device-* law: a gated service is HARD-asserted to EXIST as the FIRST discriminator (a non-optional assert.ok) before any value assertion,
 * paired with the exact Enable.* userOption string; the without-gate reaction absence is already netted by the camera-reactions suite, so here the mandatory half is
 * the existence assert.
 */
import type { Camera, ProtectCameraConfig } from "unifi-protect";
import { Characteristic, Service, TestCameraProjection, TestStateStore, makeCameraConfig, makeProtectState, makeTestAccessory, makeTestNvr, settle }
  from "../../testing.helpers.ts";
import type { TestAccessory, TestLogEntry, TestProtectNvr, TestStreamingDelegateFactory } from "../../testing.helpers.ts";
import { afterEach, describe, mock, test } from "node:test";
import { G2_PRO_CHANNELS } from "../../camera.fixtures.ts";
import type { ProtectAccessory } from "../../types.ts";
import { ProtectAuthorizationError } from "unifi-protect";
import { ProtectCamera } from "./camera.ts";
import type { ProtectNvr } from "../../nvr/nvr.ts";
import { ProtectReservedNames } from "../../types.ts";
import assert from "node:assert/strict";

// Confine the lone partial-config cast here, mirroring camera-reactions.test.ts: pushCameraPatch's patch is typed as a Partial of the full wire record, whose nested
// setting objects (ispSettings, ledSettings, recordingSettings) carry many fields the onSets never read. A test moves exactly the field under test, so the loose shape is
// cast once here rather than scattering casts (or over-specifying every wire field) through the onSet drives.
function cameraPatch(patch: Record<string, unknown>): Partial<ProtectCameraConfig> {

  return patch as Partial<ProtectCameraConfig>;
}

// The construction handle a test holds, so the afterEach can unwind the per-accessory abort regardless of which onSet it drove. logEntries is exposed (unlike the Tier-1
// camera-reactions seam) because the failure-path drives assert the runDeviceCommand error lines.
interface BuiltCamera {

  accessory: TestAccessory;
  camera: ProtectCamera;
  cameraConfig: ProtectCameraConfig;
  controller: AbortController;
  factory: TestStreamingDelegateFactory;
  logEntries: TestLogEntry[];
  nvr: TestProtectNvr;
  projection: TestCameraProjection;
}

// Build a REAL plain ProtectCamera against the doubles, exactly as camera-reactions.test.ts's buildCamera assembles it: a camera config (optionally carrying feature
// flags), the store double over it, the typed NVR / platform doubles with the test's userOptions threaded into the REAL FeatureOptions engine, the read-through camera
// projection (held so a test sets updateRejection and reads updateCalls on the SAME instance the onSet wrote into), and a fresh accessory. The casts are confined to this
// seam - the instance is the production ProtectCamera and everything it runs is the production path. The returned controller is the harness AbortController the
// afterEach aborts to unwind the observe loops.
async function buildCamera(options: { featureFlags?: Partial<ProtectCameraConfig["featureFlags"]>; userOptions?: string[] } = {}): Promise<BuiltCamera> {

  const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, ...(options.featureFlags ? { featureFlags: options.featureFlags } : {}) });
  const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
  const { controller, factory, logEntries, nvr } = makeTestNvr({ store, userOptions: options.userOptions });
  const accessory = makeTestAccessory("Test Camera", "uuid:74ACB9000001");
  const projection = new TestCameraProjection(cameraConfig.id, store);
  const camera = new ProtectCamera(nvr as unknown as ProtectNvr, accessory as unknown as ProtectAccessory, projection as unknown as Camera);

  // Settle the floating configure IIFE and the observe loops' lazy registration before any drive so the camera is fully wired when the onSet is triggered.
  await settle();

  return { accessory, camera, cameraConfig, controller, factory, logEntries, nvr, projection };
}

// A log assertion matches a substring of the single formatted parameter at the given level, mirroring chime.test.ts's loggedAt: the device log wrapper formats every line
// through util.format into one string parameter prefixed with the device name, so a substring match reads as the intent (did the camera log this line at this level).
function loggedAt(entries: TestLogEntry[], level: TestLogEntry["level"], substring: string): boolean {

  return entries.some((entry) => (entry.level === level) && String(entry.parameters[0]).includes(substring));
}

describe("camera-family device.update-backed onSet handlers (camera-onsets concern net)", () => {

  // The per-test handle, torn down in afterEach so each test's per-accessory abort unwinds and no observe loop outlives the test.
  let built: BuiltCamera | undefined;

  afterEach(() => {

    built?.camera.cleanup();
    built?.controller.abort();
    built = undefined;
  });

  describe("the night-vision dimmer On onSet (camera.ts)", () => {

    test("a successful On set issues the ispSettings irLedMode write picked from the dimmer Brightness and schedules no revert", async () => {

      built = await buildCamera({ featureFlags: { hasIcrSensitivity: true, hasInfrared: true }, userOptions: ["Enable.Device.NightVision.Dimmer"] });

      // HARD-assert the dimmer exists FIRST: the gate is capabilityGate({ capability: hasInfrared && hasIcrSensitivity, toggle: hasFeature("Device.NightVision.Dimmer")
      // }) (camera.ts), so an absent service would let the payload assertion pass vacuously.
      const dimmer = built.accessory.getServiceById(Service.Lightbulb, ProtectReservedNames.LIGHTBULB_NIGHTVISION);

      assert.ok(dimmer, "the infrared hardware plus Enable.Device.NightVision.Dimmer materializes the night-vision dimmer Lightbulb");

      const onChar = dimmer.getCharacteristic(Characteristic.On);

      // The onSet reads the dimmer's current Brightness to pick the mode (5 -> autoFilterOnly, 10 -> auto, default -> custom / customFilterOnly per irLedMode). Seed
      // Brightness 10 directly (updateCharacteristic writes the value without firing the Brightness onSet), so the mode resolves deterministically to "auto".
      dimmer.updateCharacteristic(Characteristic.Brightness, 10);

      mock.timers.enable({ apis: ["setTimeout"] });

      try {

        await onChar.triggerSet(true);

        // The command: value true with Brightness 10 issues irLedMode "auto" (value ? mode : "off"). The projection records it and does not fold the store.
        assert.deepEqual(built.projection.updateCalls, [{ payload: { ispSettings: { irLedMode: "auto" } } }],
          "the On set issued the ispSettings irLedMode auto write picked from the seeded Brightness 10");

        // NON-VACUITY: triggerSet caches On true unconditionally and the success path schedules no revert timer, so reading On without ticking proves nothing. Tick the
        // 50ms window and assert On is STILL true - no !value revert fired.
        mock.timers.tick(50);

        assert.equal(onChar.value, true, "a successful On set schedules no revert - On stays true through the 50ms window");
      } finally {

        mock.timers.reset();
      }
    });

    test("a successful On set with Brightness seeded to 100 issues the irLedMode on write", async () => {

      built = await buildCamera({ featureFlags: { hasIcrSensitivity: true, hasInfrared: true }, userOptions: ["Enable.Device.NightVision.Dimmer"] });

      const dimmer = built.accessory.getServiceById(Service.Lightbulb, ProtectReservedNames.LIGHTBULB_NIGHTVISION);

      assert.ok(dimmer, "the night-vision dimmer exists");

      // Seed Brightness 100 - the mode picker quantizes it and turns night vision ON. The drift the fix closes: without a 100 arm on the On path, a 100 brightness fell
      // to the custom arm and silently downgraded the mode instead of setting irLedMode on.
      dimmer.updateCharacteristic(Characteristic.Brightness, 100);

      await dimmer.getCharacteristic(Characteristic.On).triggerSet(true);

      assert.deepEqual(built.projection.updateCalls, [{ payload: { ispSettings: { irLedMode: "on" } } }],
        "the On set at Brightness 100 issued the irLedMode on write rather than a custom-arm downgrade");
    });

    test("a successful Off set issues the irLedMode off write", async () => {

      built = await buildCamera({ featureFlags: { hasIcrSensitivity: true, hasInfrared: true }, userOptions: ["Enable.Device.NightVision.Dimmer"] });

      const dimmer = built.accessory.getServiceById(Service.Lightbulb, ProtectReservedNames.LIGHTBULB_NIGHTVISION);

      assert.ok(dimmer, "the night-vision dimmer exists");

      // value false short-circuits the mode picker (value ? mode : "off"), so the payload is irLedMode "off" regardless of the seeded Brightness.
      await dimmer.getCharacteristic(Characteristic.On).triggerSet(false);

      assert.deepEqual(built.projection.updateCalls, [{ payload: { ispSettings: { irLedMode: "off" } } }], "the Off set issued the irLedMode off write");
    });

    test("a rejecting On set reverts the dimmer On to false through the 50ms window and reports the plain-error branch", async () => {

      built = await buildCamera({ featureFlags: { hasIcrSensitivity: true, hasInfrared: true }, userOptions: ["Enable.Device.NightVision.Dimmer"] });

      const dimmer = built.accessory.getServiceById(Service.Lightbulb, ProtectReservedNames.LIGHTBULB_NIGHTVISION);

      assert.ok(dimmer, "the night-vision dimmer exists");

      const onChar = dimmer.getCharacteristic(Characteristic.On);

      // Seed Brightness 10 so the mode picker resolves deterministically to "auto", fixing the action string the error line reports ("set night vision to auto").
      dimmer.updateCharacteristic(Characteristic.Brightness, 10);

      // The settable rejection drives runDeviceCommand's plain-error branch (the trailing period is stripped before the format string supplies the terminal one).
      built.projection.updateRejection = new Error("The camera is unreachable.");

      mock.timers.enable({ apis: ["setTimeout"] });

      try {

        await onChar.triggerSet(true);

        // The command was attempted, then the failed command bare-returned and armed the 50ms revert. Before the tick the cached value is still the set true.
        assert.equal(built.projection.updateCalls.length, 1, "the rejecting On set still attempted the command");

        mock.timers.tick(50);

        // The revert target is !value, so the dimmer On returns to false.
        assert.equal(onChar.value, false, "the failed On set reverted the dimmer On to false after the 50ms window");
        assert.ok(loggedAt(built.logEntries, "error", "Unable to set night vision to auto: The camera is unreachable."),
          "the plain-error branch reported the trailing-period-stripped failure line");
      } finally {

        mock.timers.reset();
      }
    });

    test("an authorization failure on an On set reverts and earns the Administrator-role guidance", async () => {

      built = await buildCamera({ featureFlags: { hasIcrSensitivity: true, hasInfrared: true }, userOptions: ["Enable.Device.NightVision.Dimmer"] });

      const dimmer = built.accessory.getServiceById(Service.Lightbulb, ProtectReservedNames.LIGHTBULB_NIGHTVISION);

      assert.ok(dimmer, "the night-vision dimmer exists");

      const onChar = dimmer.getCharacteristic(Characteristic.On);

      built.projection.updateRejection = new ProtectAuthorizationError("forbidden");

      mock.timers.enable({ apis: ["setTimeout"] });

      try {

        await onChar.triggerSet(true);

        mock.timers.tick(50);

        assert.equal(onChar.value, false, "the authorization-failed On set reverted the dimmer On to false");
        assert.ok(loggedAt(built.logEntries, "error", "Unable to set night vision to custom. Please ensure this username has the full management role in UniFi Protect."),
          "the authorization branch earned the admin-role guidance");
      } finally {

        mock.timers.reset();
      }
    });
  });

  describe("the night-vision dimmer Brightness onSet (camera.ts)", () => {

    test("a successful Brightness set snaps to the custom range, issues icrCustomValue, and reflects the snapped local level after the 50ms window", async () => {

      built = await buildCamera({ featureFlags: { hasIcrSensitivity: true, hasInfrared: true }, userOptions: ["Enable.Device.NightVision.Dimmer"] });

      const dimmer = built.accessory.getServiceById(Service.Lightbulb, ProtectReservedNames.LIGHTBULB_NIGHTVISION);

      assert.ok(dimmer, "the night-vision dimmer exists");

      const brightnessChar = dimmer.getCharacteristic(Characteristic.Brightness);

      mock.timers.enable({ apis: ["setTimeout"] });

      try {

        // Level 50 falls through every snap guard (not <5, not 5-10, not 10-20, not >90), so it hits the default branch: icrCustomValue = Math.round((50-20)/7) = 4, and
        // the seeded irLedMode "off" is not in [autoFilterOnly, customFilterOnly], so irLedMode resolves to "custom".
        await brightnessChar.triggerSet(50);

        assert.deepEqual(built.projection.updateCalls, [{ payload: { ispSettings: { icrCustomValue: 4, irLedMode: "custom" } } }],
          "the Brightness 50 set issued icrCustomValue 4 (Math.round((50-20)/7)) with irLedMode custom");

        // The success path reflects the SNAPPED LOCAL level (level = (4*7)+20 = 48), not a re-read, through the 50ms window.
        mock.timers.tick(50);

        assert.equal(brightnessChar.value, 48, "the snapped local level (4*7)+20 reflected onto Brightness after the 50ms window");
      } finally {

        mock.timers.reset();
      }
    });

    test("a Brightness set below the floor issues the irLedMode off write", async () => {

      built = await buildCamera({ featureFlags: { hasIcrSensitivity: true, hasInfrared: true }, userOptions: ["Enable.Device.NightVision.Dimmer"] });

      const dimmer = built.accessory.getServiceById(Service.Lightbulb, ProtectReservedNames.LIGHTBULB_NIGHTVISION);

      assert.ok(dimmer, "the night-vision dimmer exists");

      // Level 3 is below the <5 guard, so it snaps to 0 -> the off branch.
      await dimmer.getCharacteristic(Characteristic.Brightness).triggerSet(3);

      assert.deepEqual(built.projection.updateCalls, [{ payload: { ispSettings: { irLedMode: "off" } } }], "the Brightness 3 set snapped to 0 and issued irLedMode off");
    });

    test("a rejecting Brightness set captures the payload, logs the error, and does NOT reflect the snapped level (the no-revert contract)", async () => {

      built = await buildCamera({ featureFlags: { hasIcrSensitivity: true, hasInfrared: true }, userOptions: ["Enable.Device.NightVision.Dimmer"] });

      const dimmer = built.accessory.getServiceById(Service.Lightbulb, ProtectReservedNames.LIGHTBULB_NIGHTVISION);

      assert.ok(dimmer, "the night-vision dimmer exists");

      const brightnessChar = dimmer.getCharacteristic(Characteristic.Brightness);

      // Seed a distinct resting Brightness so a (wrongly-fired) reflect would be observable; the construction seed is 0 for the off mode.
      assert.equal(brightnessChar.value, 0, "the dimmer Brightness rests at 0 for the seeded off mode");

      built.projection.updateRejection = new Error("The camera is unreachable.");

      mock.timers.enable({ apis: ["setTimeout"] });

      try {

        await brightnessChar.triggerSet(50);

        // The command was attempted and the failure logged; production bare-returns BEFORE arming the reflect timer, so the no-revert contract holds: ticking the window
        // fires nothing and Brightness stays at the value triggerSet cached (50), never the snapped 48 a successful reflect would have written.
        assert.equal(built.projection.updateCalls.length, 1, "the rejecting Brightness set still attempted the command");
        assert.ok(loggedAt(built.logEntries, "error", "Unable to adjust the night vision settings: The camera is unreachable."),
          "the plain-error branch reported the failure");

        mock.timers.tick(50);

        assert.equal(brightnessChar.value, 50, "the failed Brightness set armed no reflect timer - Brightness holds the set value, never the snapped 48");
      } finally {

        mock.timers.reset();
      }
    });
  });

  describe("the UFP-recording switch onSet (camera.ts)", () => {

    test("activating ALWAYS spreads the read-through recordingSettings with the new mode, fans the siblings Off, and logs the mode", async () => {

      built = await buildCamera({ userOptions: ["Enable.Nvr.Recording.Switch"] });

      // HARD-assert all three switches exist FIRST: the gate is hasFeature("Nvr.Recording.Switch") with no featureFlag, so the userOption alone materializes them.
      const always = built.accessory.getServiceById(Service.Switch, ProtectReservedNames.SWITCH_UFP_RECORDING_ALWAYS);
      const detections = built.accessory.getServiceById(Service.Switch, ProtectReservedNames.SWITCH_UFP_RECORDING_DETECTIONS);
      const never = built.accessory.getServiceById(Service.Switch, ProtectReservedNames.SWITCH_UFP_RECORDING_NEVER);

      assert.ok(always, "Enable.Nvr.Recording.Switch materializes the ALWAYS recording switch");
      assert.ok(detections, "Enable.Nvr.Recording.Switch materializes the DETECTIONS recording switch");
      assert.ok(never, "Enable.Nvr.Recording.Switch materializes the NEVER recording switch");

      // Seed the whole recordingSettings slice with mode "detections" (so activating ALWAYS actually changes it) AND an extra sibling field (prePaddingSecs).
      // pushCameraPatch shallow-replaces the slice, so the pushed object IS the live recordingSettings the onSet spreads; the surviving sibling in the payload proves the
      // ...this.ufp.recordingSettings spread (a shallow { mode } mutation drops it). The observer wakes and re-derives the switch states (DETECTIONS On, ALWAYS Off).
      built.nvr.client.state.pushCameraPatch(built.cameraConfig.id, cameraPatch({ recordingSettings: { mode: "detections", prePaddingSecs: 5 } }));

      await settle();

      assert.equal(detections.getCharacteristic(Characteristic.On).value, true, "the detections-mode push drove the DETECTIONS switch On");

      await always.getCharacteristic(Characteristic.On).triggerSet(true);

      // The command spreads the live recordingSettings with mode overridden to always; the surviving prePaddingSecs proves the immutable spread preserved the wire shape.
      assert.deepEqual(built.projection.updateCalls, [{ payload: { recordingSettings: { mode: "always", prePaddingSecs: 5 } } }],
        "activating ALWAYS spread the read-through recordingSettings (prePaddingSecs survives) with mode overridden to always");

      // The success path fans the OTHER two switches Off inline.
      assert.equal(detections.getCharacteristic(Characteristic.On).value, false, "the DETECTIONS sibling was driven Off inline on success");
      assert.equal(never.getCharacteristic(Characteristic.On).value, false, "the NEVER sibling stayed Off");
      assert.ok(loggedAt(built.logEntries, "info", "UniFi Protect recording mode set to always."), "the success path logged the new recording mode");
    });

    test("a rejecting activation reports the error, fans no siblings, and logs no mode (the no-revert contract)", async () => {

      built = await buildCamera({ userOptions: ["Enable.Nvr.Recording.Switch"] });

      const always = built.accessory.getServiceById(Service.Switch, ProtectReservedNames.SWITCH_UFP_RECORDING_ALWAYS);
      const detections = built.accessory.getServiceById(Service.Switch, ProtectReservedNames.SWITCH_UFP_RECORDING_DETECTIONS);

      assert.ok(always, "the ALWAYS recording switch exists");
      assert.ok(detections, "the DETECTIONS recording switch exists");

      // Seed detections mode so DETECTIONS starts On; a successful ALWAYS activation flips it Off, so its survival proves the failure bare-returned before the fan-out.
      built.nvr.client.state.pushCameraPatch(built.cameraConfig.id, cameraPatch({ recordingSettings: { mode: "detections", prePaddingSecs: 5 } }));

      await settle();

      assert.equal(detections.getCharacteristic(Characteristic.On).value, true, "the DETECTIONS switch starts On for the seeded detections mode");

      built.projection.updateRejection = new Error("The camera is unreachable.");

      await always.getCharacteristic(Characteristic.On).triggerSet(true);

      // The command was attempted and failed; production bare-returns, so no sibling is flipped and no success line is logged - only the error line.
      assert.equal(built.projection.updateCalls.length, 1, "the rejecting activation still attempted the command");
      assert.equal(detections.getCharacteristic(Characteristic.On).value, true, "the failed activation flipped no sibling - DETECTIONS stays On");
      assert.ok(!loggedAt(built.logEntries, "info", "UniFi Protect recording mode set to"), "the failed activation logged no success line");
      assert.ok(loggedAt(built.logEntries, "error", "Unable to set the recording mode to always: The camera is unreachable."),
        "the plain-error branch reported the failure");
    });

    test("turning a recording switch Off issues no update - it is a meaningless state that only re-syncs", async () => {

      built = await buildCamera({ userOptions: ["Enable.Nvr.Recording.Switch"] });

      const always = built.accessory.getServiceById(Service.Switch, ProtectReservedNames.SWITCH_UFP_RECORDING_ALWAYS);

      assert.ok(always, "the ALWAYS recording switch exists");

      // makeCameraConfig seeds mode "always", so ALWAYS starts On. Turning it Off hits the !value branch: setTimeout(updateDevice, 50); return - no command issued. We
      // wrap in mock.timers so the deferred re-sync timer is discarded by reset rather than leaking past the test; we do not tick it (the re-sync is not under assertion
      // here).
      mock.timers.enable({ apis: ["setTimeout"] });

      try {

        await always.getCharacteristic(Characteristic.On).triggerSet(false);

        assert.equal(built.projection.updateCalls.length, 0, "turning a recording switch Off issues no device.update - it is an undefined state, not a command");
      } finally {

        mock.timers.reset();
      }
    });
  });

  describe("the status-LED switch onSet WIRING (configureStatusLedSwitch in device.ts -> setStatusLed -> statusLedCommand)", () => {

    test("a camera status-LED On set routes through statusLedCommand to the ledSettings isEnabled write", async () => {

      built = await buildCamera({ userOptions: ["Enable.Device.StatusLed.Switch"] });

      // HARD-assert the switch exists FIRST: the materialization gate is hasFeature("Device.StatusLed.Switch") alone (no hasLedStatus precondition), so the userOption
      // materializes it; an absent service would let the payload assertion pass vacuously.
      const statusLedSwitch = built.accessory.getServiceById(Service.Switch, ProtectReservedNames.SWITCH_STATUS_LED);

      assert.ok(statusLedSwitch, "Enable.Device.StatusLed.Switch materializes the SWITCH_STATUS_LED switch");

      // WIRING only: the camera modelKey routes statusLedCommand to device.update({ ledSettings: { isEnabled } }) (device.ts); we assert the camera issued the
      // ledSettings write, NOT the statusLedCommand internals (device-statusled.test.ts owns those, the two-layer architecture).
      await statusLedSwitch.getCharacteristic(Characteristic.On).triggerSet(true);

      assert.deepEqual(built.projection.updateCalls, [{ payload: { ledSettings: { isEnabled: true } } }],
        "the camera status-LED On set routed through statusLedCommand to the ledSettings isEnabled true write");
    });

    test("a rejecting camera status-LED set reports the failure through the shared helper and reverts no characteristic", async () => {

      built = await buildCamera({ userOptions: ["Enable.Device.StatusLed.Switch"] });

      const statusLedSwitch = built.accessory.getServiceById(Service.Switch, ProtectReservedNames.SWITCH_STATUS_LED);

      assert.ok(statusLedSwitch, "the status-LED switch exists");

      const onChar = statusLedSwitch.getCharacteristic(Characteristic.On);

      built.projection.updateRejection = new ProtectAuthorizationError("forbidden");

      await onChar.triggerSet(true);

      // setStatusLed's onSet routes through runDeviceCommand and does not revert the characteristic (the observer re-reflects on the next push), so the cached set value
      // stays and only the shared error line fires - the admin-role guidance for the authorization branch.
      assert.equal(built.projection.updateCalls.length, 1, "the rejecting status-LED set still attempted the command");
      assert.equal(onChar.value, true, "the camera status-LED onSet reverts no characteristic - the cached set value holds");
      assert.ok(loggedAt(built.logEntries, "error",
        "Unable to turn the status indicator light on. Please ensure this username has the full management role in UniFi Protect."),
      "the authorization branch reported the admin-role guidance through the shared helper");
    });
  });

  describe("doorbell trigger / mute construction ordering", () => {

    test("a plain camera with the doorbell trigger and mute both enabled materializes the mute switch on first construction", async () => {

      // A plain camera (isDoorbell false) has no Doorbell service until the trigger creates one. The trigger runs ahead of the mute switch in the construction tail,
      // so the mute switch's gate sees a present Doorbell service and materializes in the first session rather than only after a restart.
      built = await buildCamera({ userOptions: [ "Enable.Doorbell.Mute", "Enable.Doorbell.Trigger" ] });

      assert.ok(built.accessory.getServiceById(Service.Switch, ProtectReservedNames.SWITCH_DOORBELL_MUTE),
        "the plain camera's doorbell mute switch materializes on first construction");
    });
  });
});
