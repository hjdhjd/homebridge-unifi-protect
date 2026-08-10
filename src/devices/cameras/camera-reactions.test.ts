/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * camera-reactions.test.ts: The camera-leaf observe-and-fire net - the uncovered device-state reactions and the bound read / pure-context handlers, against the
 * REAL constructed ProtectCamera.
 *
 * The camera leaf registers its state observers (camera.ts). Some are already netted by camera-construction.test.ts (camera.channels -> the streaming reconcile,
 * camera.state -> updateAvailability, and the camera.state.hksv both-edge timeshift reconcile). This suite nets the device-state reactions behavior-FIRST - each is a
 * structural-sharing store push (pushCameraPatch / pushCameraFeatureFlags) followed by a settle and an assertion on the effect the reaction produced (the characteristic
 * it WROTE, or the recording dispatch it routed to), never on the private updater that wrote it - plus the bound GET read-throughs and the two pure-context onSets (HKSV
 * recording, doorbell mute) whose handlers write only accessory.context and never touch the controller. The camera.lastMotion bare-motion observer is netted here through
 * the injected recording-dispatch seam, exactly as the sensor / light suites net their own lastMotion observe. Each reaction is constructed against a plain ProtectCamera
 * through the same camera-construction harness seam (the stub streaming-delegate factory), so the instance under test is the production class and the casts are confined
 * to the construction call. The smart-detect object sensors belong to capability-reconcile.test.ts, alongside the other gates the reconcile chokepoint drives.
 *
 * The vacuity gate is two-part, carried from the device-* law: a gated reaction needs both its HARDWARE precondition (a makeCameraConfig featureFlags flag) and, where a
 * sub-option defaults FALSE, the exact Enable.* userOption string. Every with-feature reaction HARD-asserts the gated service or characteristic EXISTS as its FIRST
 * discriminator (a non-optional assert.ok, so an absent service throws here rather than letting a later optional-chained assertion pass vacuously) and pairs with a
 * without-gate test that proves the same push produces nothing when the precondition is omitted.
 *
 * Two writes are honestly out of this suite's reach and left uncovered, NOT asserted: the night-vision operating-mode write (camera.ts, gated on
 * this.hints.nightVision through the CameraOperatingMode service) and the status-indicator operating-mode write (camera.ts, the CameraOperatingModeIndicator on
 * the same service). CameraOperatingMode is never created in this harness: the plugin never acquireService's it - it only ever getService-reads it - and the HAP
 * CameraController that does create it, as a side effect of configureController, is replaced by the stub streaming-delegate factory, so those writes target an absent
 * service and cannot be made non-vacuous here. The night-vision-dimmer onSet, the status-LED-switch onSet, and the
 * recording-switch onSet all route through runDeviceCommand -> device.update and belong to the projection command surface - this suite drives none of them.
 *
 * Each construction holds no observer-wake subscription except where a reaction's identity is the wake KEY itself (the videoCodec reaction, whose only observable output
 * is "the right observer woke and the streaming reconcile re-derived"); the rest assert the characteristic effect directly. Every constructed camera is unwound through
 * cleanup() in an afterEach so its per-accessory abort never outlives the test.
 */
import type { Camera, ProtectCameraConfig } from "unifi-protect";
import { Characteristic, Service, TestStateStore, makeProtectState, makeTestAccessory, settle } from "../../testing.helpers.ts";
import type { TestAccessory, TestLogEntry, TestStreamingDelegateFactory } from "../../testing.helpers.ts";
import { TestCameraProjection, makeCameraConfig } from "../testing.helpers.ts";
import { TestRecordingDispatch, makeTestNvr } from "../../nvr/testing.helpers.ts";
import { afterEach, describe, mock, test } from "node:test";
import { G2_PRO_CHANNELS } from "../../camera.fixtures.ts";
import type { ObserverWakePayload } from "../../diagnostics.ts";
import { PROTECT_NVR_REBOOT_RECENCY_MS } from "../../settings.ts";
import type { ProtectAccessory } from "../../types.ts";
import { ProtectCamera } from "./camera.ts";
import { ProtectCameraPackage } from "./camera-package.ts";
import type { ProtectEventDispatch } from "../../nvr/event-dispatch.ts";
import type { ProtectNvr } from "../../nvr/nvr.ts";
import { ProtectReservedNames } from "../../types.ts";
import type { TestProtectNvr } from "../../nvr/testing.helpers.ts";
import assert from "node:assert/strict";

// Confine the lone partial-config cast here, mirroring makeCameraConfig's single-confined-cast discipline: pushCameraPatch's patch is typed as a Partial of the full wire
// record, whose nested setting objects (smartDetectSettings, ispSettings, ledSettings, recordingSettings) carry many fields the camera's reactions never read. A test
// moves exactly the field under test, so the loose shape is cast once here rather than scattering casts (or over-specifying every wire field) through the reaction tests.
function cameraPatch(patch: Record<string, unknown>): Partial<ProtectCameraConfig> {

  return patch as Partial<ProtectCameraConfig>;
}

// The construction handles a test holds onto, so the afterEach can unwind the per-accessory abort regardless of which build helper produced them. Generic over the
// constructed camera class so a describe that needs to read an inherited protected projection can build a thin subclass and keep it fully typed; it defaults to the
// production ProtectCamera, which is what every arm outside the reboot-return watch builds.
interface BuiltCamera<C extends ProtectCamera = ProtectCamera> {

  accessory: TestAccessory;
  camera: C;
  cameraConfig: ProtectCameraConfig;
  controller: AbortController;
  factory: TestStreamingDelegateFactory;
  logEntries: TestLogEntry[];
  nvr: TestProtectNvr;
  recording: TestRecordingDispatch;
}

// Build a REAL plain ProtectCamera against the harness doubles, exactly as camera-construction.test.ts assembles it: a camera config (optionally carrying feature
// flags), the store double over it, the typed NVR / platform doubles with the test's userOptions threaded into the REAL FeatureOptions engine, the read-through camera
// projection, and a fresh accessory. The casts are confined to this seam - the instance is the production ProtectCamera and everything it runs is the production path.
// The returned controller is the harness AbortController the afterEach aborts to unwind the observe loops. seedLastMotion, when supplied, is committed to the store
// record BEFORE the camera is constructed, so the lastMotion observer seeds its baseline against an already-present value - the bootstrap-hydration case where a value
// present at subscribe must never fire.
async function buildCamera<C extends ProtectCamera = ProtectCamera>(options: { construct?: (nvr: ProtectNvr, accessory: ProtectAccessory, device: Camera) => C;
  featureFlags?: Partial<ProtectCameraConfig["featureFlags"]>; seedLastMotion?: number; userOptions?: string[]; } = {}): Promise<BuiltCamera<C>> {

  const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, ...(options.featureFlags ? { featureFlags: options.featureFlags } : {}) });
  const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));

  // Seed a hydrated lastMotion onto the store record before any observer exists, so the observer's baseline at subscribe carries it. No observer is registered yet, so
  // this push only commits the state - it wakes nothing.
  if(options.seedLastMotion !== undefined) {

    store.pushCameraPatch(cameraConfig.id, { lastMotion: options.seedLastMotion });
  }

  // Inject the recording dispatch through the NVR double's dispatch seam so the lastMotion observer's firehose routing is asserted against the REAL ProtectEventDispatch
  // contract (the recording subclass captures the delivery without arming the real reset timer or touching HAP), exactly as the sensor / light suites do. The recording
  // double is read back off nvr.events rather than captured from the factory closure - the same posture sensor.test.ts uses to avoid the assignment-expression smell.
  const { controller, factory, logEntries, nvr } = makeTestNvr({ dispatch: (innerNvr: ProtectNvr): ProtectEventDispatch => new TestRecordingDispatch(innerNvr), store,
    userOptions: options.userOptions });
  const recording = nvr.events as TestRecordingDispatch;
  const accessory = makeTestAccessory("Test Camera", "uuid:74ACB9000001");

  // How the camera under test is constructed, mirroring makeTestNvr's own dispatch factory: omitted, it is the plain production ProtectCamera every other arm builds,
  // so those are unchanged. The reboot-return watch's describe supplies a subclass that adds one read over an inherited protected member and overrides no behavior, so
  // the instance under test is still the production class running production paths.
  const construct = options.construct ?? ((innerNvr: ProtectNvr, innerAccessory: ProtectAccessory, innerDevice: Camera): C => {

    return new ProtectCamera(innerNvr, innerAccessory, innerDevice) as C;
  });
  const camera = construct(nvr as unknown as ProtectNvr, accessory as unknown as ProtectAccessory, new TestCameraProjection(cameraConfig.id, store) as unknown as
    Camera);

  // Settle the floating configure IIFE and the observe loops' lazy registration before any push so the camera is fully wired when the reaction is driven.
  await settle();

  return { accessory, camera, cameraConfig, controller, factory, logEntries, nvr, recording };
}

describe("camera-family observer reactions and bound read handlers (camera-reactions concern net)", () => {

  // The per-test handle, torn down in afterEach so each test's per-accessory abort unwinds and no observe loop outlives the test.
  let built: BuiltCamera | undefined;

  afterEach(() => {

    built?.camera.cleanup();
    built?.controller.abort();
    built = undefined;
  });

  describe("the videoCodec reaction (shares the streaming reconcile with channels)", () => {

    test("a videoCodec push wakes exactly the camera.videoCodec observer and re-derives streaming without re-creating the delegate", async () => {

      built = await buildCamera();

      // The plain-camera census: the base observers (name, firmware) plus the camera's narrow observers. A drift here means an extra or missing observer slipped in.
      const store = built.nvr.client.state;

      assert.equal(store.observerCount, 14, "the plain camera wires exactly fourteen observers (the base pair plus the camera's twelve)");

      // The videoCodec reaction is identical to the (already-netted) channels reaction: both drive the streaming reconcile. Its only observable output is the WAKE KEY
      // re-derive side effect (the factory is not invoked again), so a one-shot wake subscription windows the single push and the create-call count proves the re-run
      // republished profiles and exited through the this.stream idempotency gate rather than building a second delegate.
      const wakes: ObserverWakePayload[] = [];
      const onWake = (message: unknown): void => { wakes.push(message as ObserverWakePayload); };

      const diagnosticsChannel = await import("node:diagnostics_channel");

      diagnosticsChannel.subscribe("hbup:observer:wake", onWake);

      try {

        const createCallsBeforePush = built.factory.createCalls.length;

        // makeCameraConfig seeds videoCodec "h264"; replace ONLY that slice, so every other field spread-shares and only the camera.videoCodec observer wakes.
        store.pushCameraPatch(built.cameraConfig.id, { videoCodec: "h265" });

        await settle();

        assert.equal(wakes.length, 1, "exactly one observer woke for the single-slice videoCodec push");
        assert.deepEqual(wakes[0], { accessoryId: built.accessory.UUID, key: "camera.videoCodec" },
          "the wake is the camera.videoCodec observer, attributed to this accessory");
        assert.equal(built.factory.createCalls.length, createCallsBeforePush,
          "the videoCodec re-run re-derived streaming through the capability and exited its create-once gate - no second delegate was created");
      } finally {

        diagnosticsChannel.unsubscribe("hbup:observer:wake", onWake);
      }
    });

    test("a connectionHost change re-derives the published profile URLs against the new host", async () => {

      built = await buildCamera();

      // The published channel profiles bake their RTSP URLs against the connection host at derivation time, so a profile selected before the change carries the seeded
      // host and one selected after the change must carry the new one - the connectionHost observer re-runs the reconcile that re-bakes them.
      const before = built.camera.selectChannel(1200, 1600)?.url;

      assert.ok(before && !before.includes("10.0.0.5"), "the initial baked profile URL does not carry the new host");

      built.nvr.client.state.pushCameraPatch(built.cameraConfig.id, { connectionHost: "10.0.0.5" });

      await settle();

      const after = built.camera.selectChannel(1200, 1600)?.url;

      assert.ok(after?.includes("10.0.0.5"), "the connectionHost observer re-derived the profile URL against the changed connection host");
    });
  });

  describe("the lastMotion -> bare-motion reaction (observe-and-fire through the gated policy)", () => {

    test("a truthy lastMotion advance fires motionEventHandler when the policy says bare motion is the source of truth", async () => {

      // The plain camera carries no smart-detection capability (smartDetectTypes empty) and is not recording, so shouldDeliverBareMotion returns true: bare motion is the
      // source of truth and the advance must trip the parent's MotionSensor.
      built = await buildCamera();

      // makeCameraConfig seeds no lastMotion, so the observer's baseline is undefined; this first truthy advance is a genuine change that wakes it.
      built.nvr.client.state.pushCameraPatch(built.cameraConfig.id, { lastMotion: 1700000000000 });

      await settle();

      assert.deepEqual(built.recording.calls, [{ id: built.cameraConfig.id, kind: "motion" }],
        "the truthy lastMotion advance routed to motionEventHandler exactly once for the non-smart camera");
    });

    test("a truthy lastMotion advance does NOT fire when smart detection owns motion (smart-capable, smart-enabled, not recording)", async () => {

      // A smart-capable camera with smart detection enabled and HKSV not recording is the lone suppression case: the matching smartDetect firehose event owns motion, so
      // the bare-motion advance must not also fire. The smartDetect hint is hasSmartDetect AND the Motion.SmartDetect option (which defaults OFF), so both halves of the
      // gate must be present; smartDetectTypes makes the camera capable.
      built = await buildCamera({ featureFlags: { hasSmartDetect: true, smartDetectTypes: ["person"] }, userOptions: ["Enable.Motion.SmartDetect"] });

      built.nvr.client.state.pushCameraPatch(built.cameraConfig.id, { lastMotion: 1700000000000 });

      await settle();

      assert.deepEqual(built.recording.calls, [],
        "a smart-capable, smart-enabled, not-recording camera suppresses bare motion - the smartDetect event is the source of truth");
    });

    test("a falsy lastMotion value does NOT fire even though it changed", async () => {

      // Two-step, mirroring the sensor suite's falsy case: the baseline is undefined, so a bare 0 push is a genuine undefined->0 change that wakes the observer; the
      // production if(!lastMotion) guard, not a dead observer, is what suppresses the delivery for the falsy value.
      built = await buildCamera();

      built.nvr.client.state.pushCameraPatch(built.cameraConfig.id, { lastMotion: 1700000000000 });

      await settle();

      const recordingBaseline = built.recording.calls.length;

      assert.equal(recordingBaseline, 1, "the truthy advance fired once, so the falsy step measures a real change off a fired baseline");

      built.nvr.client.state.pushCameraPatch(built.cameraConfig.id, { lastMotion: 0 });

      await settle();

      assert.equal(built.recording.calls.length, recordingBaseline, "the truthy->0 change woke the observer but the if(!lastMotion) guard suppressed the delivery");
    });

    test("a lastMotion already present at subscribe (bootstrap hydration) never fires", async () => {

      // The structural hydration safety: the store seeds the observer's baseline at subscribe, so a value already present when the observer arms is the baseline and
      // yields nothing on its own. seedLastMotion commits a truthy lastMotion to the store record BEFORE the camera is constructed, so the observer baselines against it.
      built = await buildCamera({ seedLastMotion: 1700000000000 });

      assert.deepEqual(built.recording.calls, [],
        "a hydrated lastMotion present at subscribe is the baseline and never fires - the hydration safety is structural, not a guard");
    });
  });

  describe("the smartDetect -> tamper reaction (materializes / removes StatusTampered)", () => {

    test("with hasTamperDetection, enabling tamper detection materializes StatusTampered and the onGet reads isTampered; disabling removes it", async () => {

      built = await buildCamera({ featureFlags: { hasTamperDetection: true } });

      // HARD-assert the MotionSensor exists FIRST: the tamper characteristic materializes onto it, so an absent motion service would make the materialize/remove check
      // meaningless. The minimal camera is HKSV-capable, so configureMotionSensor builds it through the real acquireService.
      const motionService = built.accessory.getService(Service.MotionSensor);

      assert.ok(motionService, "the camera carries its motion sensor, the host of the StatusTampered characteristic");

      // At construction the camera seeds enableTamperDetection false, so the tamper gate prunes; with no prior StatusTampered to remove it never creates one, and the
      // characteristic is absent (testCharacteristic never lazily creates, so this is a pure absence check, not a value read).
      assert.equal(motionService.testCharacteristic(Characteristic.StatusTampered), false, "with tamper detection disabled, StatusTampered is absent at construction");

      // The reaction: pushing enableTamperDetection true wakes the smartDetectSettings observer, which drives reconcileCapabilities, so configureTamperDetection
      // materializes StatusTampered and binds its onGet to isTampered.
      built.nvr.client.state.pushCameraPatch(built.cameraConfig.id, cameraPatch({ smartDetectSettings: { enableTamperDetection: true } }));

      await settle();

      assert.equal(motionService.testCharacteristic(Characteristic.StatusTampered), true, "enabling tamper detection materialized the StatusTampered characteristic");

      // The bound read-through: the onGet reads this.isTampered (the latched router-delivered state), which is false at rest.
      assert.equal(await motionService.getCharacteristic(Characteristic.StatusTampered).triggerGet(), false, "the StatusTampered onGet reads isTampered (false at rest)");

      // The inverse reaction: pushing enableTamperDetection false wakes the observer again, which drives reconcileCapabilities, so the tamper gate prunes StatusTampered
      // (the removal branch) and clears isTampered on the setting-off path.
      built.nvr.client.state.pushCameraPatch(built.cameraConfig.id, cameraPatch({ smartDetectSettings: { enableTamperDetection: false } }));

      await settle();

      assert.equal(motionService.testCharacteristic(Characteristic.StatusTampered), false, "disabling tamper detection removed the StatusTampered characteristic");
    });

    test("without hasTamperDetection, an enableTamperDetection push never materializes StatusTampered", async () => {

      built = await buildCamera();

      const motionService = built.accessory.getService(Service.MotionSensor);

      assert.ok(motionService, "the camera carries its motion sensor");

      // The hardware precondition is the other half of the gate (capabilityGate keeps the characteristic only when the setting is on AND the characteristic exists or
      // hasTamperDetection reports): without the capability and with no existing characteristic, the push wakes the observer but the gate never creates StatusTampered.
      built.nvr.client.state.pushCameraPatch(built.cameraConfig.id, cameraPatch({ smartDetectSettings: { enableTamperDetection: true } }));

      await settle();

      assert.equal(motionService.testCharacteristic(Characteristic.StatusTampered), false,
        "without hasTamperDetection the enableTamperDetection push never materializes StatusTampered - the hardware half of the gate held");
    });
  });

  describe("the isp -> night-vision DIMMER reaction (On + Brightness)", () => {

    test("with the infrared hardware and the dimmer option, an ispSettings push reflects the irLedMode onto the dimmer On + Brightness", async () => {

      built = await buildCamera({ featureFlags: { hasIcrSensitivity: true, hasInfrared: true }, userOptions: ["Enable.Device.NightVision.Dimmer"] });

      // HARD-assert the dimmer exists FIRST: the gate is hasInfrared && hasIcrSensitivity && hasFeature("Device.NightVision.Dimmer") (camera.ts), so an absent
      // service would let the value assertions pass vacuously.
      const dimmer = built.accessory.getServiceById(Service.Lightbulb, ProtectReservedNames.LIGHTBULB_NIGHTVISION);

      assert.ok(dimmer, "the infrared hardware plus Enable.Device.NightVision.Dimmer materializes the night-vision dimmer Lightbulb");

      // makeCameraConfig seeds irLedMode "off"; push "auto", which wakes the ispSettings observer -> updateNightVision -> the dimmer write. nightVision is irLedMode !==
      // "off" (true), and nightVisionBrightness maps "auto" -> 10.
      built.nvr.client.state.pushCameraPatch(built.cameraConfig.id, cameraPatch({ ispSettings: { icrCustomValue: 0, irLedMode: "auto" } }));

      await settle();

      assert.equal(dimmer.getCharacteristic(Characteristic.On).value, true, "irLedMode auto drove the dimmer On true (night vision is not off)");
      assert.equal(dimmer.getCharacteristic(Characteristic.Brightness).value, 10, "irLedMode auto mapped to a brightness of 10");

      // The inverse: pushing irLedMode "off" wakes the observer again and drives On false / Brightness 0.
      built.nvr.client.state.pushCameraPatch(built.cameraConfig.id, cameraPatch({ ispSettings: { icrCustomValue: 0, irLedMode: "off" } }));

      await settle();

      assert.equal(dimmer.getCharacteristic(Characteristic.On).value, false, "irLedMode off drove the dimmer On false");
      assert.equal(dimmer.getCharacteristic(Characteristic.Brightness).value, 0, "irLedMode off mapped to a brightness of 0");

      // The bound read-through: the On onGet reads this.nightVision, now false after the off push.
      assert.equal(await dimmer.getCharacteristic(Characteristic.On).triggerGet(), false, "the dimmer On onGet reads nightVision (false after the off push)");
    });

    test("without hasIcrSensitivity, the dimmer is absent and an ispSettings push writes nothing", async () => {

      // Drop hasIcrSensitivity (keep hasInfrared and the option) so the gate's hardware half fails and the dimmer never materializes.
      built = await buildCamera({ featureFlags: { hasInfrared: true }, userOptions: ["Enable.Device.NightVision.Dimmer"] });

      assert.equal(built.accessory.getServiceById(Service.Lightbulb, ProtectReservedNames.LIGHTBULB_NIGHTVISION), undefined,
        "without hasIcrSensitivity the night-vision dimmer is not materialized, even with the option enabled");

      // The push wakes the observer, but updateNightVision's dimmer branch finds no service, so there is nothing to assert beyond the absence holding through the push.
      built.nvr.client.state.pushCameraPatch(built.cameraConfig.id, cameraPatch({ ispSettings: { icrCustomValue: 0, irLedMode: "auto" } }));

      await settle();

      assert.equal(built.accessory.getServiceById(Service.Lightbulb, ProtectReservedNames.LIGHTBULB_NIGHTVISION), undefined,
        "the ispSettings push materialized no dimmer when the hardware gate held");
    });
  });

  describe("the led -> status-LED SWITCH reaction (On)", () => {

    test("with the status-LED switch option, a ledSettings push reflects isEnabled onto the switch On", async () => {

      built = await buildCamera({ userOptions: ["Enable.Device.StatusLed.Switch"] });

      // HARD-assert the switch exists FIRST: the materialization gate is hasFeature("Device.StatusLed.Switch") alone (device.ts - isEnabled defaults true at the
      // unconditional camera.ts call site, with NO hasLedStatus and NO ledSettings precondition), so the userOption alone materializes it. An absent service would
      // let the value assertion pass vacuously.
      const statusLedSwitch = built.accessory.getServiceById(Service.Switch, ProtectReservedNames.SWITCH_STATUS_LED);

      assert.ok(statusLedSwitch, "Enable.Device.StatusLed.Switch materializes the SWITCH_STATUS_LED switch (no hasLedStatus precondition)");

      // makeCameraConfig seeds ledSettings.isEnabled false; push true, which wakes the ledSettings observer -> updateStatusIndicator -> the switch write. statusLed is
      // ledSettings.isEnabled.
      built.nvr.client.state.pushCameraPatch(built.cameraConfig.id, cameraPatch({ ledSettings: { isEnabled: true } }));

      await settle();

      assert.equal(statusLedSwitch.getCharacteristic(Characteristic.On).value, true, "ledSettings.isEnabled true drove the status-LED switch On true");

      // The bound read-through: the On onGet reads this.statusLed, now true.
      assert.equal(await statusLedSwitch.getCharacteristic(Characteristic.On).triggerGet(), true, "the status-LED switch On onGet reads statusLed (true after the push)");

      // The inverse: pushing isEnabled false wakes the observer again and drives On false.
      built.nvr.client.state.pushCameraPatch(built.cameraConfig.id, cameraPatch({ ledSettings: { isEnabled: false } }));

      await settle();

      assert.equal(statusLedSwitch.getCharacteristic(Characteristic.On).value, false, "ledSettings.isEnabled false drove the status-LED switch On false");
    });

    test("without the status-LED switch option, the switch is absent and a ledSettings push writes nothing", async () => {

      built = await buildCamera();

      assert.equal(built.accessory.getServiceById(Service.Switch, ProtectReservedNames.SWITCH_STATUS_LED), undefined,
        "omitting Enable.Device.StatusLed.Switch materializes no status-LED switch");

      built.nvr.client.state.pushCameraPatch(built.cameraConfig.id, cameraPatch({ ledSettings: { isEnabled: true } }));

      await settle();

      assert.equal(built.accessory.getServiceById(Service.Switch, ProtectReservedNames.SWITCH_STATUS_LED), undefined,
        "the ledSettings push materialized no status-LED switch when the option was omitted");
    });
  });

  describe("the recording -> UFP recording switches reaction (mutually-exclusive fan-out)", () => {

    test("with the recording-switch option, a recordingSettings push fans the mode across the three switches", async () => {

      built = await buildCamera({ userOptions: ["Enable.Nvr.Recording.Switch"] });

      // HARD-assert all three switches exist FIRST: the gate is hasFeature("Nvr.Recording.Switch") with no featureFlag, so the userOption alone materializes them.
      const always = built.accessory.getServiceById(Service.Switch, ProtectReservedNames.SWITCH_UFP_RECORDING_ALWAYS);
      const detections = built.accessory.getServiceById(Service.Switch, ProtectReservedNames.SWITCH_UFP_RECORDING_DETECTIONS);
      const never = built.accessory.getServiceById(Service.Switch, ProtectReservedNames.SWITCH_UFP_RECORDING_NEVER);

      assert.ok(always, "Enable.Nvr.Recording.Switch materializes the ALWAYS recording switch");
      assert.ok(detections, "Enable.Nvr.Recording.Switch materializes the DETECTIONS recording switch");
      assert.ok(never, "Enable.Nvr.Recording.Switch materializes the NEVER recording switch");

      // makeCameraConfig seeds recordingSettings.mode "always", so the ALWAYS switch starts On. Push "detections", which wakes the recordingSettings observer ->
      // updateRecordingSwitches -> the fan-out write across all three (On === (suffix === mode)).
      assert.equal(always.getCharacteristic(Characteristic.On).value, true, "the ALWAYS switch initialized On for the seeded always mode");

      built.nvr.client.state.pushCameraPatch(built.cameraConfig.id, cameraPatch({ recordingSettings: { mode: "detections" } }));

      await settle();

      assert.equal(always.getCharacteristic(Characteristic.On).value, false, "the mode push drove the ALWAYS switch Off");
      assert.equal(detections.getCharacteristic(Characteristic.On).value, true, "the mode push drove the DETECTIONS switch On");
      assert.equal(never.getCharacteristic(Characteristic.On).value, false, "the mode push left the NEVER switch Off");
    });

    test("without the recording-switch option, no recording switches are materialized", async () => {

      built = await buildCamera();

      assert.equal(built.accessory.getServiceById(Service.Switch, ProtectReservedNames.SWITCH_UFP_RECORDING_ALWAYS), undefined,
        "omitting Enable.Nvr.Recording.Switch materializes no recording switches");

      built.nvr.client.state.pushCameraPatch(built.cameraConfig.id, cameraPatch({ recordingSettings: { mode: "detections" } }));

      await settle();

      assert.equal(built.accessory.getServiceById(Service.Switch, ProtectReservedNames.SWITCH_UFP_RECORDING_ALWAYS), undefined,
        "the recordingSettings push materialized no recording switches when the option was omitted");
    });
  });

  describe("the pure-context onSets (write accessory.context, never the controller)", () => {

    test("the HKSV-recording switch onSet toggles accessory.context.hksvRecordingDisabled both ways and the onGet reflects it", async () => {

      built = await buildCamera({ userOptions: ["Enable.Video.HKSV.Recording.Switch"] });

      // HARD-assert the switch exists FIRST: the gate is hasFeature("Video.HKSV.Recording.Switch").
      const hksvSwitch = built.accessory.getServiceById(Service.Switch, ProtectReservedNames.SWITCH_HKSV_RECORDING);

      assert.ok(hksvSwitch, "Enable.Video.HKSV.Recording.Switch materializes the HKSV recording switch");

      const onChar = hksvSwitch.getCharacteristic(Characteristic.On);

      // The switch initializes On true (recording enabled = context flag unset/false), and the onGet reads !context.hksvRecordingDisabled.
      assert.equal(onChar.value, true, "the HKSV recording switch initialized On true (recording enabled)");
      assert.equal(await onChar.triggerGet(), true, "the On onGet reads !context.hksvRecordingDisabled (true)");

      // onSet false: the handler writes context.hksvRecordingDisabled = !false = true and logs the disabled line. No controller write - this is a pure context toggle.
      await onChar.triggerSet(false);

      assert.equal(built.accessory.context["hksvRecordingDisabled"], true, "onSet false disabled HKSV recording by setting the context flag true");
      assert.equal(await onChar.triggerGet(), false, "the onGet now reflects the disabled state (!true)");

      // onSet true restores recording: context.hksvRecordingDisabled = !true = false.
      await onChar.triggerSet(true);

      assert.equal(built.accessory.context["hksvRecordingDisabled"], false, "onSet true re-enabled HKSV recording by clearing the context flag");
      assert.equal(await onChar.triggerGet(), true, "the onGet reflects the re-enabled state");
    });

    test("the doorbell-mute switch onSet toggles accessory.context.doorbellMuted both ways and the onGet reflects it", async () => {

      // The doorbell-mute switch also requires a Doorbell service (camera.ts), so the camera must be doorbell hardware; the Doorbell.Mute option gates the switch.
      built = await buildCamera({ featureFlags: { isDoorbell: true }, userOptions: ["Enable.Doorbell.Mute"] });

      // HARD-assert the switch exists FIRST.
      const muteSwitch = built.accessory.getServiceById(Service.Switch, ProtectReservedNames.SWITCH_DOORBELL_MUTE);

      assert.ok(muteSwitch, "Enable.Doorbell.Mute on a doorbell materializes the doorbell-mute switch");

      const onChar = muteSwitch.getCharacteristic(Characteristic.On);

      // The switch initializes On false (not muted), and the onGet reads context.doorbellMuted ?? false.
      assert.equal(onChar.value, false, "the doorbell-mute switch initialized On false (not muted)");
      assert.equal(await onChar.triggerGet(), false, "the On onGet reads context.doorbellMuted ?? false (false)");

      // onSet true mutes: the handler writes context.doorbellMuted = !!true = true. No controller write.
      await onChar.triggerSet(true);

      assert.equal(built.accessory.context["doorbellMuted"], true, "onSet true muted the doorbell by setting the context flag");
      assert.equal(await onChar.triggerGet(), true, "the onGet now reflects the muted state");

      // onSet false un-mutes.
      await onChar.triggerSet(false);

      assert.equal(built.accessory.context["doorbellMuted"], false, "onSet false un-muted the doorbell by clearing the context flag");
      assert.equal(await onChar.triggerGet(), false, "the onGet reflects the un-muted state");
    });
  });

  /* The reboot-return watch: the camera-owned answer to "did this camera come back after the controller rebooted?".
   *
   * The watch is timer-backed for ABSENCE, because nothing fires when a camera simply fails to reappear, and kicked for the RETURN through both reachability paths.
   * That split is what these arms drive: the keyed one-shot under a mocked clock for the absence half, and the state observe / reachability override for the return
   * half. The mock clock is installed AFTER the camera is built, so construction's own real timers (the harness's stability sweep among them) stay under real time and
   * only the watch armed afterward is mock-armed; each arm aborts its controller INSIDE its own finally BEFORE resetting the mock, so the mock-armed drain runs while
   * the mock that armed it is still installed. The suite's shared afterEach abort then lands as a harmless second call.
   */
  describe("the reboot-return watch (the never-came-back narration and its paired all-clear)", () => {

    // This file arms no mocked clock anywhere else, so the epoch is defined here rather than shared: the value is the removal suite's, and only this describe's tests
    // run under it.
    const MOCK_EPOCH = 1700000000000;

    // A thin read over the inherited timer registry, mirroring the InspectableSupervisor idiom the media suites use for a protected projection: it adds one getter and
    // overrides nothing, so the instance under test runs the production paths exactly. The registry's armed state is what tells a CANCELLED watch from one that fired
    // and found nothing worth saying - the absence of a warn cannot tell those two apart on its own.
    class InspectableCamera extends ProtectCamera {

      public get hasRebootReturnWatch(): boolean {

        return this.timers.has("rebootReturn");
      }
    }

    // The same read for the package camera, whose whole claim here is that it arms nothing at all.
    class InspectablePackageCamera extends ProtectCameraPackage {

      public get hasRebootReturnWatch(): boolean {

        return this.timers.has("rebootReturn");
      }
    }

    // How many times the watch has told the user this camera never came back, and how many times it has announced the return. Both are counted rather than tested for
    // presence, because the behavior under assertion is "exactly once per outage" - a boolean would pass the moment the first line landed, whatever followed it.
    function countWarns(entries: TestLogEntry[], fragment: string): number {

      return entries.filter((entry) => (entry.level === "warn") && (typeof entry.parameters[0] === "string") && entry.parameters[0].includes(fragment)).length;
    }

    const ABSENCE_LINE = "has not come back online since the controller rebooted";
    const RETURN_LINE = "The camera is back online.";

    // Build a camera whose watch can be inspected. The construction factory hands the subclass back fully typed, so an arm reads the armed state without a cast.
    async function buildWatchCamera(): Promise<BuiltCamera<InspectableCamera>> {

      const construct = (nvr: ProtectNvr, accessory: ProtectAccessory, device: Camera): InspectableCamera => new InspectableCamera(nvr, accessory, device);

      return buildCamera({ construct });
    }

    // Drive the camera's own device state, exactly as a controller realtime packet would. Offline is what gives the watch something to find missing at its expiry.
    async function setCameraOnline(watch: BuiltCamera<InspectableCamera>, online: boolean): Promise<void> {

      watch.nvr.client.state.pushCameraPatch(watch.cameraConfig.id, { state: online ? "CONNECTED" : "DISCONNECTED" });

      await settle();
    }

    // (c-a) The absence half, and the once-per-outage rule against a repeated reboot. A camera that is still gone when the window expires is told once; a second reboot
    // arriving mid-outage restarts the wait, and its expiry finds the same unresolved story rather than a new one, so it says nothing.
    test("an unreachable camera is called out once at the window's expiry, and a second reboot mid-outage re-arms without repeating it", async () => {

      const watch = await buildWatchCamera();

      built = watch;

      await setCameraOnline(watch, false);

      mock.timers.enable({ apis: [ "Date", "setTimeout" ], now: MOCK_EPOCH });

      try {

        watch.camera.noteControllerRebooted();

        assert.equal(watch.camera.hasRebootReturnWatch, true, "the reboot armed the watch");

        mock.timers.tick(PROTECT_NVR_REBOOT_RECENCY_MS);

        assert.equal(countWarns(watch.logEntries, ABSENCE_LINE), 1, "the camera that never came back was called out at the window's expiry");

        // A second reboot while the camera is still gone. The watch re-arms, but the story it would tell is already open.
        watch.camera.noteControllerRebooted();

        assert.equal(watch.camera.hasRebootReturnWatch, true, "the second reboot re-armed the watch");

        mock.timers.tick(PROTECT_NVR_REBOOT_RECENCY_MS);

        assert.equal(countWarns(watch.logEntries, ABSENCE_LINE), 1, "the second window's expiry did not repeat the line for the same unresolved outage");
        assert.equal(countWarns(watch.logEntries, RETURN_LINE), 0, "no all-clear was announced for a camera that never returned");
      } finally {

        watch.controller.abort();
        mock.timers.reset();
      }
    });

    // (c-b) The return half through the camera's own state observe. The armed watch is CANCELLED rather than left to fire and decline, which is why this asserts the
    // registry key itself: a silent expiry would look identical from the log alone.
    test("a camera that returns inside the window cancels the watch outright", async () => {

      const watch = await buildWatchCamera();

      built = watch;

      await setCameraOnline(watch, false);

      mock.timers.enable({ apis: [ "Date", "setTimeout" ], now: MOCK_EPOCH });

      try {

        watch.camera.noteControllerRebooted();

        assert.equal(watch.camera.hasRebootReturnWatch, true, "the watch is armed before the camera returns");

        await setCameraOnline(watch, true);

        assert.equal(watch.camera.hasRebootReturnWatch, false, "the camera's return cleared the armed watch rather than leaving it to expire");

        mock.timers.tick(PROTECT_NVR_REBOOT_RECENCY_MS * 2);

        assert.equal(countWarns(watch.logEntries, ABSENCE_LINE), 0, "a camera that came back inside the window was never called out");
        assert.equal(countWarns(watch.logEntries, RETURN_LINE), 0, "a return that closed nothing announced nothing");
      } finally {

        watch.controller.abort();
        mock.timers.reset();
      }
    });

    // (c-c) The paired close, and the watch re-arming for a genuinely new outage. The all-clear rides the SAME level as the alert, so an operator scanning warn sees
    // both halves of the story; once it has closed, a later reboot the camera again fails to survive is a fresh story and is told afresh.
    test("a warned camera's return announces the all-clear at warn, and a later reboot it does not survive is called out again", async () => {

      const watch = await buildWatchCamera();

      built = watch;

      await setCameraOnline(watch, false);

      mock.timers.enable({ apis: [ "Date", "setTimeout" ], now: MOCK_EPOCH });

      try {

        watch.camera.noteControllerRebooted();
        mock.timers.tick(PROTECT_NVR_REBOOT_RECENCY_MS);

        assert.equal(countWarns(watch.logEntries, ABSENCE_LINE), 1, "the absent camera was called out");

        // The camera comes back. The open story closes at the same level it opened.
        await setCameraOnline(watch, true);

        assert.equal(countWarns(watch.logEntries, RETURN_LINE), 1, "the return announced the all-clear");

        // A later reboot that this camera again fails to come back from is a genuinely new outage, so it is told afresh.
        await setCameraOnline(watch, false);

        watch.camera.noteControllerRebooted();
        mock.timers.tick(PROTECT_NVR_REBOOT_RECENCY_MS);

        assert.equal(countWarns(watch.logEntries, ABSENCE_LINE), 2, "the closed story left the watch free to speak for the next outage");
        assert.equal(countWarns(watch.logEntries, RETURN_LINE), 1, "the second outage has not been resolved, so no second all-clear was announced");
      } finally {

        watch.controller.abort();
        mock.timers.reset();
      }
    });

    // (c-d) The package camera arms nothing. Both polarities matter: the key is never registered, and ticking a full window past the call produces no line - which is
    // what an inherited (un-overridden) watch on this offline camera would have produced.
    test("the package camera's watch is inert - it arms nothing and says nothing", async () => {

      const watch = await buildWatchCamera();

      built = watch;

      await setCameraOnline(watch, false);

      // A package camera over the SAME physical device, built as the controller root builds it. Its parent's watch is deliberately never armed here, so any line the
      // tick produces could only have come from the package.
      const packageCamera = new InspectablePackageCamera(watch.nvr as unknown as ProtectNvr,
        makeTestAccessory("Test Camera Package", "uuid:74ACB9000001:package") as unknown as ProtectAccessory,
        new TestCameraProjection(watch.cameraConfig.id, watch.nvr.client.state) as unknown as Camera);

      await settle();

      mock.timers.enable({ apis: [ "Date", "setTimeout" ], now: MOCK_EPOCH });

      try {

        packageCamera.noteControllerRebooted();

        assert.equal(packageCamera.hasRebootReturnWatch, false, "the package camera registered no watch timer");

        mock.timers.tick(PROTECT_NVR_REBOOT_RECENCY_MS * 2);

        assert.equal(countWarns(watch.logEntries, ABSENCE_LINE), 0, "the package camera never speaks for the hardware its parent already speaks for");
      } finally {

        packageCamera.cleanup();
        watch.controller.abort();
        mock.timers.reset();
      }
    });

    // (c-e) The return half through the CONTROLLER-HEALTH path, both polarities. A whole-controller recovery never wakes the camera's state observe - the device state
    // was frozen through the outage and the store dedups on the selected value - so the reachability override is the path that has to carry the cancel. The negative
    // polarity is what proves the cancel is reachability-gated rather than firing on any push at all.
    test("a controller-health recovery alone cancels the watch, and an unhealthy push does not", async () => {

      const watch = await buildWatchCamera();

      built = watch;

      // The camera's own device state stays ONLINE throughout: only the controller's health moves, so the state observe never fires and the override is the only path
      // that can reach the watch.
      watch.nvr.client.connection.isHealthy = false;

      mock.timers.enable({ apis: [ "Date", "setTimeout" ], now: MOCK_EPOCH });

      try {

        watch.camera.noteControllerRebooted();

        assert.equal(watch.camera.hasRebootReturnWatch, true, "the reboot armed the watch");

        // The negative polarity: a reachability push while the controller is STILL unhealthy must leave the watch armed.
        watch.camera.refreshReachability();

        assert.equal(watch.camera.hasRebootReturnWatch, true, "a reachability push on an unreachable camera left the watch armed");

        // The controller returns. Nothing pushes the camera's device state, so this is the health path alone.
        watch.nvr.client.connection.isHealthy = true;
        watch.camera.refreshReachability();

        assert.equal(watch.camera.hasRebootReturnWatch, false, "the controller-health recovery alone cancelled the watch");

        mock.timers.tick(PROTECT_NVR_REBOOT_RECENCY_MS * 2);

        assert.equal(countWarns(watch.logEntries, ABSENCE_LINE), 0, "a camera that was never actually absent was never called out");
        assert.equal(countWarns(watch.logEntries, RETURN_LINE), 0, "a cancel that closed no open story announced nothing");
      } finally {

        watch.controller.abort();
        mock.timers.reset();
      }
    });

    // (c-f) A controller that is itself still away at the expiry. The camera cannot be blamed for the controller's absence, so the watch extends by another window
    // instead of speaking - and once the controller is back with the camera still missing, the next expiry says so.
    test("an expiry while the controller is still unhealthy extends the watch, and the next one speaks once the controller is back", async () => {

      const watch = await buildWatchCamera();

      built = watch;

      await setCameraOnline(watch, false);

      watch.nvr.client.connection.isHealthy = false;

      mock.timers.enable({ apis: [ "Date", "setTimeout" ], now: MOCK_EPOCH });

      try {

        watch.camera.noteControllerRebooted();
        mock.timers.tick(PROTECT_NVR_REBOOT_RECENCY_MS);

        assert.equal(countWarns(watch.logEntries, ABSENCE_LINE), 0, "the camera was not blamed while the controller itself was still away");
        assert.equal(watch.camera.hasRebootReturnWatch, true, "the expiry extended the watch by another window rather than ending it");

        // The controller comes back, and this camera is still gone. Now the absence is the camera's own.
        watch.nvr.client.connection.isHealthy = true;
        mock.timers.tick(PROTECT_NVR_REBOOT_RECENCY_MS);

        assert.equal(countWarns(watch.logEntries, ABSENCE_LINE), 1, "the camera still missing behind a recovered controller was called out");
      } finally {

        watch.controller.abort();
        mock.timers.reset();
      }
    });

    // (c-g) The once-per-outage rule across THREE reboot cycles. Two cycles alone cannot see a latch that resets on every other call; three can.
    test("a camera that stays gone across three reboots is called out exactly once", async () => {

      const watch = await buildWatchCamera();

      built = watch;

      await setCameraOnline(watch, false);

      mock.timers.enable({ apis: [ "Date", "setTimeout" ], now: MOCK_EPOCH });

      try {

        for(let cycle = 0; cycle < 3; cycle++) {

          watch.camera.noteControllerRebooted();
          mock.timers.tick(PROTECT_NVR_REBOOT_RECENCY_MS);
        }

        assert.equal(countWarns(watch.logEntries, ABSENCE_LINE), 1, "three reboots over one unbroken outage told the user once");
      } finally {

        watch.controller.abort();
        mock.timers.reset();
      }
    });

    // (c-h) A camera whose controller record has vanished is being removed, which is not a failure to come back. The watch declines silently rather than announcing a
    // camera the user has already taken away.
    test("a camera whose controller record has vanished declines silently", async () => {

      const watch = await buildWatchCamera();

      built = watch;

      await setCameraOnline(watch, false);

      mock.timers.enable({ apis: [ "Date", "setTimeout" ], now: MOCK_EPOCH });

      try {

        watch.camera.noteControllerRebooted();

        assert.equal(watch.camera.hasRebootReturnWatch, true, "the watch is armed before the record vanishes");

        watch.nvr.client.state.removeCameraRecord(watch.cameraConfig.id);

        await settle();

        mock.timers.tick(PROTECT_NVR_REBOOT_RECENCY_MS);

        assert.equal(countWarns(watch.logEntries, ABSENCE_LINE), 0, "a camera being removed was not reported as failing to come back");
      } finally {

        watch.controller.abort();
        mock.timers.reset();
      }
    });

    // (c-i) An open story closed through the controller-health path. The camera's own state comes back mid-outage, but the controller is still down so the camera is
    // not yet reachable and nothing closes; the controller's return is what completes it. This is the arm that proves the all-clear is reachable through EITHER path,
    // not only through the state observe that happens to be easiest to drive.
    test("a warned camera's all-clear can arrive through the controller-health path", async () => {

      const watch = await buildWatchCamera();

      built = watch;

      await setCameraOnline(watch, false);

      mock.timers.enable({ apis: [ "Date", "setTimeout" ], now: MOCK_EPOCH });

      try {

        watch.camera.noteControllerRebooted();
        mock.timers.tick(PROTECT_NVR_REBOOT_RECENCY_MS);

        assert.equal(countWarns(watch.logEntries, ABSENCE_LINE), 1, "the absent camera was called out");

        // The controller drops, and the camera's own state comes back underneath it. The camera is still not reachable, so the story stays open.
        watch.nvr.client.connection.isHealthy = false;

        await setCameraOnline(watch, true);

        assert.equal(countWarns(watch.logEntries, RETURN_LINE), 0, "a device-state return behind an unhealthy controller does not yet close the story");

        // The controller returns. The reachability push is now the only thing that moves, and it completes the pair.
        watch.nvr.client.connection.isHealthy = true;
        watch.camera.refreshReachability();

        assert.equal(countWarns(watch.logEntries, RETURN_LINE), 1, "the controller-health path announced the all-clear and closed the story");
        assert.equal(countWarns(watch.logEntries, ABSENCE_LINE), 1, "closing the story re-told nothing");
      } finally {

        watch.controller.abort();
        mock.timers.reset();
      }
    });
  });

});
