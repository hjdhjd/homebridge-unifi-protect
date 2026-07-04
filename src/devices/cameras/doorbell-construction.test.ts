/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * doorbell-construction.test.ts: Real doorbell (a ProtectCamera with its composed DoorbellCapability) and doorbell-plus-package-camera family construction through the
 * harness.
 *
 * Two suites prove the capability collapse end to end against real production classes. Suite A constructs a REAL ProtectCamera against an isDoorbell-true config so it
 * construction-attaches its DoorbellCapability - the base constructors, the camera's configureDevice chain, the floating configure IIFE, the capability's configure
 * (the Doorbell service, LCD, physical chimes, chime volume), and the observers (the camera's plain-camera set, now including the always-armed isDoorbell
 * observer, the bare-motion lastMotion observer, and the capability-reconcile featureFlags observer, plus the capability's own). Suite B constructs
 * the full doorbell-plus-package family and pins the self-observing package camera: its exact persisted context, its
 * suffixed display name through the syncedName seam, its observer census, and the death of every doorbell-to-package fan-out (firmware, name, availability,
 * and reachability all now flow through the package's own observers or the NVR's endpoints iterator). The reclassification-flap regression and the
 * deleted-copy-forward hints-equality pin guard the two known hazards of the reshape, and the UUID-seed pin guards the persistence-critical identity suffix against
 * drift. The pure-test unlocks ride along: the package selectChannel lens-2/URL-host rows and the parent selectRecordingChannel pixel-ceiling row.
 *
 * Each suite holds ONE observer-wake subscription across all its phases, windowing the wake log per phase; the zero-wake-during-construction assertions are
 * vacuity-proofed by the same subscription later observing positive wakes. Test files run in separate processes under the node:test runner, so the subscriptions
 * never cross-talk with other suites.
 */
import { Characteristic, Service, TestAccessory, TestCameraProjection, TestRecordingDispatch, TestStateStore, makeCameraConfig, makeChimeConfig, makeProtectState,
  makeTestAccessory, makeTestNvr, settle } from "../../testing.helpers.ts";
import { G2_PRO_CHANNELS, G6_INSTANT_CHANNELS, G6_PRO_ENTRY_CHANNELS } from "../../camera.fixtures.ts";
import type { TestApiCall, TestLogEntry, TestProtectNvr, TestStreamingDelegate, TestStreamingDelegateFactory } from "../../testing.helpers.ts";
import { after, afterEach, before, describe, test } from "node:test";
import type { Camera } from "unifi-protect";
import type { ObserverWakePayload } from "../../diagnostics.ts";
import type { ProtectAccessory } from "../../types.ts";
import { ProtectCamera } from "./camera.ts";
import type { ProtectEventDispatch } from "../../nvr/event-dispatch.ts";
import type { ProtectNvr } from "../../nvr/nvr.ts";
import assert from "node:assert/strict";
import diagnosticsChannel from "node:diagnostics_channel";

// Construct a real ProtectCamera against an isDoorbell-true config so it construction-attaches its DoorbellCapability, with the casts confined to this seam - the
// instance under test is the production ProtectCamera and its composed capability.
function constructDoorbell(nvr: TestProtectNvr, accessory: TestAccessory, projection: TestCameraProjection): ProtectCamera {

  return new ProtectCamera(nvr as unknown as ProtectNvr, accessory as unknown as ProtectAccessory, projection as unknown as Camera);
}

describe("real doorbell construction (suite A)", () => {

  const wakeLog: ObserverWakePayload[] = [];
  const onWake = (message: unknown): void => { wakeLog.push(message as ObserverWakePayload); };

  let accessory: TestAccessory;
  let constructionWakes = 0;
  let doorbell: ProtectCamera;
  let factory: TestStreamingDelegateFactory;
  let harnessController: AbortController | undefined;
  let store: TestStateStore;

  before(async () => {

    diagnosticsChannel.subscribe("hbup:observer:wake", onWake);

    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { isDoorbell: true }, name: "Front Door" });

    store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));

    let nvr: TestProtectNvr;

    ({ controller: harnessController, factory, nvr } = makeTestNvr({ store }));

    accessory = makeTestAccessory("Front Door", "uuid:74ACB9000001");
    doorbell = constructDoorbell(nvr, accessory, new TestCameraProjection(cameraConfig.id, store));

    await settle();

    constructionWakes = wakeLog.length;
  });

  after(() => {

    harnessController?.abort();
    diagnosticsChannel.unsubscribe("hbup:observer:wake", onWake);
  });

  test("construction completes, creates one streaming delegate, and marks the Doorbell service primary", () => {

    assert.equal(factory.createCalls.length, 1, "the doorbell's stream was created exactly once");

    const doorbellService = accessory.getService(Service.Doorbell);

    assert.ok(doorbellService, "the video doorbell service exists");
    assert.equal(doorbellService.isPrimary, true, "configureDoorbellService marked the Doorbell service primary");
  });

  test("the doorbell wires eighteen observers - the camera's plain-camera set plus the capability's four - and fires none at construction", () => {

    // The census: the base observers (name, firmware) + the camera set (the always-armed isDoorbell observer, the bare-motion lastMotion observer, the
    // capability-reconcile featureFlags observer, and the Access-lock supportUnlock observer all join the doorbell-attached camera's set) + the capability observers
    // (lcdMessage, hasPackageCamera, chimeDuration, chimeVolume) = the doorbell's full observer set.
    assert.equal(store.observerCount, 18, "the eighteen-observer census holds across the capability collapse and the always-armed isDoorbell observer");
    assert.equal(constructionWakes, 0, "observers arm against the baseline and stay silent at construction");
  });

  test("the capability is attached, its name delegates to the camera's, and messageSwitches stays capability-private (no camera field)", () => {

    // The composition seam: the camera carries the live capability, attached at construction because the config reports isDoorbell.
    assert.ok(doorbell.doorbell, "the camera carries an attached DoorbellCapability");

    // Log-prefix parity: the capability's name override resolves to the camera's name (the live controller projection name), the exact value the pre-collapse doorbell
    // logged with - not accessoryName (the cached HomeKit Name), which would diverge.
    assert.equal(doorbell.doorbell.name, doorbell.name, "the capability's name delegates to the camera's name for exact log-prefix parity");

    // Census privacy: messageSwitches moved off the camera entirely (zero readers outside the capability), so the camera carries no such field - it lives only on the
    // capability, where it is private.
    assert.equal("messageSwitches" in doorbell, false, "the camera carries no messageSwitches field after the collapse");
  });

  test("each of the capability's four observers wakes on its own slice, keyed verbatim to the camera's accessory UUID through publishObserverWake", async () => {

    // A self-contained construction so the slice pushes never perturb the shared suite state: a doorbell plus a chime that serves it, so the chime-volume slice is live.
    const localWakes: ObserverWakePayload[] = [];
    const onLocalWake = (message: unknown): void => { localWakes.push(message as ObserverWakePayload); };

    diagnosticsChannel.subscribe("hbup:observer:wake", onLocalWake);

    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { hasLcdScreen: true, isDoorbell: true }, name: "Front Door" });
    const chimeConfig = makeChimeConfig({ cameraIds: [cameraConfig.id], ringSettings: [{ cameraId: cameraConfig.id, volume: 50 }] });
    const localStore = new TestStateStore(makeProtectState({ cameras: [cameraConfig], chimes: [chimeConfig] }));
    const { controller: localController, nvr: localNvr } = makeTestNvr({ store: localStore });
    const localAccessory = makeTestAccessory("Front Door", "uuid:74ACB9000099");
    const localDoorbell = constructDoorbell(localNvr, localAccessory, new TestCameraProjection(cameraConfig.id, localStore));

    await settle();

    // The wake assertion for one key: push the slice that drives the keyed observer, settle, and assert a wake carrying that verbatim key under the camera's accessory
    // UUID - which proves the key is preserved, the capability's observer is armed, AND the publishObserverWake delegation seam attributes it to the camera.
    const assertWake = async (key: string, push: () => void): Promise<void> => {

      const baseline = localWakes.length;

      push();

      await settle();

      assert.ok(localWakes.slice(baseline).some((wake) => (wake.key === key) && (wake.accessoryId === localAccessory.UUID)),
        "the " + key + " observer woke, attributed by its verbatim key to the camera's accessory UUID");
    };

    await assertWake("doorbell.lcdMessage",
      () => localStore.pushCameraPatch(cameraConfig.id, { lcdMessage: { resetAt: null, text: "GO AWAY", type: "CUSTOM_MESSAGE" } }));
    await assertWake("doorbell.chimeDuration", () => localStore.pushCameraPatch(cameraConfig.id, { chimeDuration: 300 }));
    await assertWake("doorbell.hasPackageCamera", () => localStore.pushCameraFeatureFlags(cameraConfig.id, { hasPackageCamera: true }));
    await assertWake("doorbell.chimeVolume",
      () => localStore.pushChimePatch(chimeConfig.id, { ringSettings: [{ cameraId: cameraConfig.id, repeatTimes: 1, ringtoneId: "default", volume: 75 }] }));

    localDoorbell.cleanup();
    localController.abort();
    diagnosticsChannel.unsubscribe("hbup:observer:wake", onLocalWake);
  });

  test("cleanup unwinds every observer and a further push wakes nothing", async () => {

    doorbell.cleanup();

    await settle();

    assert.equal(store.observerCount, 0, "every observer deregistered through the per-accessory abort");

    const teardownBaseline = wakeLog.length;
    const record = store.snapshot().cameras.get("test-camera-1");

    assert.ok(record, "the camera record is still present");

    store.pushCameraPatch(record.id, { name: "Renamed After Cleanup" });

    await settle();

    assert.equal(wakeLog.length, teardownBaseline, "a push after cleanup wakes nothing");
  });
});

describe("doorbell + package camera family construction (suite B)", () => {

  const wakeLog: ObserverWakePayload[] = [];
  const onWake = (message: unknown): void => { wakeLog.push(message as ObserverWakePayload); };

  let apiCalls: TestApiCall[];
  let cameraId = "";
  let constructionWakes = 0;
  let doorbell: ProtectCamera;
  let harnessController: AbortController | undefined;
  let logEntries: TestLogEntry[];
  let nvr: TestProtectNvr;
  let store: TestStateStore;

  // The package camera's accessory, asserted live.
  function packageAccessory(): TestAccessory {

    assert.ok(doorbell.packageCamera, "the package camera instance is live");

    return doorbell.packageCamera.accessory as unknown as TestAccessory;
  }

  before(async () => {

    diagnosticsChannel.subscribe("hbup:observer:wake", onWake);

    // Name syncing is enabled for this family so the suffixed-name seam and the rename reaction are exercised; everything else sits at its default.
    const cameraConfig = makeCameraConfig({ channels: G6_PRO_ENTRY_CHANNELS, featureFlags: { hasPackageCamera: true, isDoorbell: true }, name: "Front Door" });

    cameraId = cameraConfig.id;
    store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    ({ apiCalls, controller: harnessController, logEntries, nvr } = makeTestNvr({ store, userOptions: ["Enable.Device.SyncName"] }));

    doorbell = constructDoorbell(nvr, makeTestAccessory("Front Door", "uuid:74ACB9000001"), new TestCameraProjection(cameraId, store));

    await settle();

    constructionWakes = wakeLog.length;
  });

  after(() => {

    harnessController?.abort();
    diagnosticsChannel.unsubscribe("hbup:observer:wake", onWake);
  });

  test("the package camera accessory is created, registered bridged, and carries exactly the production context keys - never a mac", () => {

    const accessory = packageAccessory();

    assert.equal(accessory.UUID, "uuid:74ACB9000001.PackageCamera", "the accessory UUID derives from the parent MAC plus the identity suffix");
    assert.ok(nvr.platform.accessories.includes(accessory), "the accessory is tracked in the platform's accessories array");
    assert.equal(apiCalls.filter((call) => (call.kind === "register") && call.accessories.includes(accessory)).length, 1, "the accessory registered as bridged");
    assert.deepEqual(Object.keys(accessory.context).sort(), [ "detectMotion", "nvr", "packageCamera" ], "the persisted context carries exactly the production keys");
    assert.equal(accessory.context["packageCamera"], "74ACB9000001", "the packageCamera context key carries the parent MAC");
    assert.equal(accessory.context["detectMotion"], true, "motion awareness defaults on");
  });

  test("the package camera's display name flows through the syncedName seam with the display suffix applied", () => {

    const accessory = packageAccessory();

    assert.equal(accessory.displayName, "Front Door Package Camera", "the platform accessory display name carries the suffix");
    assert.equal(accessory._associatedHAPAccessory.displayName, "Front Door Package Camera", "the HAP-side mirror carries the suffix");
    assert.equal(accessory.getService(Service.AccessoryInformation)?.getCharacteristic(Characteristic.Name).value, "Front Door Package Camera",
      "the HomeKit-visible name carries the suffix");
  });

  test("the family wires but does not fire: eighteen doorbell observers plus four package observers, zero construction wakes", () => {

    // The package census: the inherited base observers (name, firmware) plus its bespoke camera.state availability and package-channel observers - and nothing from the
    // camera set. The doorbell-attached camera contributes its full observer set (its plain-camera set, now including the always-armed isDoorbell observer, the
    // bare-motion lastMotion observer, the capability-reconcile featureFlags observer, and the Access-lock supportUnlock observer, plus the capability's own plus the
    // base observers).
    assert.equal(store.observerCount, 22, "eighteen doorbell observers plus the package's four");
    assert.equal(constructionWakes, 0, "no observer fired during family construction");
  });

  test("the package camera's hints equal the parent's - the deleted copy-forward was provably redundant", () => {

    assert.ok(doorbell.packageCamera, "the package camera instance is live");

    // The hints the package computes independently through its own configureHints from the shared parent MAC scope.
    for(const hint of [ "tsbStreaming", "hardwareDecoding", "hardwareTranscoding", "highResSnapshots", "logHksv", "transcode", "transcodeBitrate",
      "transcodeHighLatency", "transcodeHighLatencyBitrate" ] as const) {

      assert.equal(doorbell.packageCamera.hints[hint], doorbell.hints[hint], "the package independently derives the identical " + hint + " hint");
    }
  });

  test("a firmware push drives the package camera's own configureInfo - the doorbell fan-out is dead", async () => {

    const pushBaseline = wakeLog.length;

    store.pushCameraPatch(cameraId, { firmwareVersion: "9.9.9" });

    await settle();

    const accessory = packageAccessory();

    assert.equal(accessory.getService(Service.AccessoryInformation)?.getCharacteristic(Characteristic.FirmwareRevision).value, "9.9.9",
      "the package accessory's firmware revision tracks the shared device");
    assert.ok(wakeLog.slice(pushBaseline).some((wake) => (wake.accessoryId === accessory.UUID) && (wake.key === "device.firmwareVersion")),
      "the refresh is attributed to the package's OWN firmware observer, not a parent fan-out");
  });

  test("a controller-side rename drives the package camera's own suffixed rename and logs its own line", async () => {

    store.pushCameraPatch(cameraId, { name: "New Door" });

    await settle();

    const accessory = packageAccessory();

    assert.equal(accessory.displayName, "New Door Package Camera", "the package display name re-derives with the suffix");
    assert.equal(accessory.getService(Service.AccessoryInformation)?.getCharacteristic(Characteristic.Name).value, "New Door Package Camera",
      "the HomeKit-visible name re-derives with the suffix");

    // The package camera carries its OWN decorated "Name [Model]" log prefix - the parent's name with the Package Camera suffix - so its log lines are attributable
    // rather than colliding with the doorbell's. It shares the underlying projection and market name, so only the suffix on the name keeps the two prefixes distinct.
    const renameLines = logEntries.filter((entry) => (entry.level === "info") && String(entry.parameters[0]).includes("updating the HomeKit name to"));

    assert.equal(renameLines.filter((entry) => String(entry.parameters[0]).includes("New Door Package Camera.")).length, 1,
      "the package logs exactly one rename line of its own");
    assert.ok(renameLines.some((entry) => String(entry.parameters[0]).startsWith("New Door Package Camera [Test Camera Model]: ")),
      "the package's rename line carries its own suffixed \"Name [Model]\" prefix, distinct from the doorbell's");
  });

  test("a device-state push drives the package's narrow availability projection: StatusActive only, StatusTampered never appears", async () => {

    store.pushCameraPatch(cameraId, { state: "DISCONNECTED" });

    await settle();

    const motionService = packageAccessory().getService(Service.MotionSensor);

    assert.ok(motionService, "the package carries its motion sensor");
    assert.equal(motionService.getCharacteristic(Characteristic.StatusActive).value, false, "the package's own state observer drove StatusActive inactive");
    assert.equal(motionService.testCharacteristic(Characteristic.StatusTampered), false,
      "the guarded base availability projection never sprouts StatusTampered onto the package motion sensor");

    // Restore the connected state for the suites that follow.
    store.pushCameraPatch(cameraId, { state: "CONNECTED" });

    await settle();

    assert.equal(motionService.getCharacteristic(Characteristic.StatusActive).value, true, "the return to CONNECTED restores StatusActive");
  });

  test("an isDoorbell flap within one drain self-collapses: no WARN, the capability stays attached, and the controller never churns", async () => {

    // The isDoorbell observer is now always armed (the spawn guard died with the live-attach), so it may wake on the flap -
    // but the reconcile re-reads LIVE state on each wake, and the flap (isDoorbell drops then returns before any consumer drains) leaves live state at its final value.
    const accessory = doorbell.accessory as unknown as TestAccessory;
    const warnBaseline = logEntries.filter((entry) => entry.level === "warn").length;
    const churnBaseline = accessory.controllerEvents.length;

    // The flap: isDoorbell drops and returns before any consumer drains.
    store.pushCameraFeatureFlags(cameraId, { isDoorbell: false });
    store.pushCameraFeatureFlags(cameraId, { isDoorbell: true });

    await settle();

    // The reconcile reads live state (isDoorbell true, the capability still attached) and resolves to "none": no withdrawal WARN, no detach, the capability intact. The
    // package leaf stays un-armed (its no-super spawnCameraObservers never spawns this observer against the shared parent record).
    assert.equal(logEntries.filter((entry) => entry.level === "warn").length, warnBaseline, "the within-drain flap raises no withdrawal warning - it self-collapsed");
    assert.ok(doorbell.doorbell, "the doorbell capability survives the flap, never detached");

    // No controller churn: the self-collapse leaves isDoorbell at the value the controller was already built for, so the capability reconcile's audio rebuild sees no
    // frozen audio capability appeared and skips rebuildStreamingDelegate - no removeController/configureController fired at the flap.
    assert.equal(accessory.controllerEvents.length, churnBaseline, "the flap drove zero controller churn - no rebuild");
  });

  test("controller-health reachability: the doorbell no longer fans out to the package, whose endpoint surface is first-class", async () => {

    nvr.client.connection.isHealthy = false;

    // The doorbell's own refresh runs first, exactly as the NVR endpoints iterator would drive it - and must no longer touch the package accessory.
    const doorbellTransition = doorbell.refreshReachability();

    assert.deepEqual(doorbellTransition, { now: false, was: true }, "the doorbell reports its own reachability flip");

    const motionService = packageAccessory().getService(Service.MotionSensor);

    assert.equal(motionService?.getCharacteristic(Characteristic.StatusActive).value, true, "the deleted override no longer fans reachability into the package");

    // The package endpoint the iterator yields right after its parent: the base refreshReachability writes the identical StatusActive surface and reports the flip
    // for the reachability-fanout diagnostics.
    assert.ok(doorbell.packageCamera, "the package camera instance is live");

    const packageTransition = doorbell.packageCamera.refreshReachability();

    assert.deepEqual(packageTransition, { now: false, was: true }, "the package reports its own reachability flip for the fanout diagnostics");
    assert.equal(motionService?.getCharacteristic(Characteristic.StatusActive).value, false, "the package endpoint write landed on its motion sensor");

    // Restore controller health for any suite that follows.
    nvr.client.connection.isHealthy = true;
    doorbell.refreshReachability();
    doorbell.packageCamera.refreshReachability();

    assert.equal(motionService?.getCharacteristic(Characteristic.StatusActive).value, true, "the restored health reads back active");
  });

  test("family cleanup unwinds the doorbell and the package together", async () => {

    const accessory = packageAccessory();

    doorbell.cleanup();

    await settle();

    assert.equal(doorbell.packageCamera, null, "cleanup nulls the package camera handle");
    assert.equal(store.observerCount, 0, "every family observer deregistered");
    assert.equal(accessory.removeControllerCalls.length, 1, "the package's controller was unregistered at cleanup");

    const teardownBaseline = wakeLog.length;

    store.pushCameraPatch(cameraId, { state: "DISCONNECTED" });

    await settle();

    assert.equal(wakeLog.length, teardownBaseline, "a push after family cleanup wakes nothing");
  });
});

// Suite C drives the parent doorbell's bare-motion lastMotion observer for its package-forward effect against the REAL ProtectEventDispatch contract, with the recording
// dispatch injected through the NVR double's seam (the recording subclass captures the delivery without arming a reset timer or touching HAP). A plain camera has
// no packageCamera, so this case can only live in the doorbell-plus-package family harness. The parent owns the single forward: when the package camera is recording for
// HKSV, the parent's raw motion always trips the package's motion sensor (the package has no motion signal of its own), independent of whether the parent itself
// fired. The parent is built smart-capable and smart-enabled (and is not itself recording), so shouldDeliverBareMotion SUPPRESSES the parent's own delivery - which is
// what isolates the package forward: the package shares the parent's projection, so both record the same ufp.id, and suppressing the parent makes any motion delivery on
// the advance unambiguously the package forward. Each test builds a fresh family and unwinds it in afterEach so no observe loop outlives the test.
describe("doorbell bare-motion package forward (suite C)", () => {

  let doorbell: ProtectCamera | undefined;
  let harnessController: AbortController | undefined;

  // Build a real doorbell-plus-package family with the package channel provisioned (so the package camera holds a stub stream), wiring the recording dispatch through the
  // dispatch seam. The doorbell is smart-capable and smart-enabled so its OWN bare motion is suppressed by the policy, isolating the package forward. Returns the family
  // handles the tests drive: the shared parent record id, the recording dispatch, and the store.
  async function buildFamily(): Promise<{ cameraId: string; recording: TestRecordingDispatch; store: TestStateStore }> {

    const cameraConfig = makeCameraConfig({ channels: G6_PRO_ENTRY_CHANNELS,
      featureFlags: { hasPackageCamera: true, hasSmartDetect: true, isDoorbell: true, smartDetectTypes: ["person"] }, name: "Front Door" });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { controller, nvr } = makeTestNvr({ dispatch: (innerNvr: ProtectNvr): ProtectEventDispatch => new TestRecordingDispatch(innerNvr), store,
      userOptions: ["Enable.Motion.SmartDetect"] });

    harnessController = controller;

    const recording = nvr.events as TestRecordingDispatch;

    doorbell = new ProtectCamera(nvr as unknown as ProtectNvr, makeTestAccessory("Front Door", "uuid:74ACB9000001") as unknown as ProtectAccessory,
      new TestCameraProjection(cameraConfig.id, store) as unknown as Camera);

    await settle();

    return { cameraId: cameraConfig.id, recording, store };
  }

  afterEach(() => {

    doorbell?.cleanup();
    harnessController?.abort();
    doorbell = undefined;
    harnessController = undefined;
  });

  test("a recording package camera receives the parent's bare motion through the parent's lastMotion observer", async () => {

    const { cameraId, recording, store } = await buildFamily();

    assert.ok(doorbell?.packageCamera?.stream, "the package camera holds its stub stream with the channel provisioned");

    // Mark the package camera recording for HKSV: the production forward reads packageCamera.stream.hksv.isRecording. The afterEach cleanup also reads hksv through
    // teardownStreamingDelegate (isRecording -> updateRecordingActive, then timeshift.stop), so the stub carries those no-ops - the same shape the camera-construction
    // self-heal test seeds, cast once through the confined seam.
    (doorbell.packageCamera.stream as TestStreamingDelegate).hksv = { isRecording: true,
      timeshift: { isStarted: false, stop: (): void => { /* No-op: the double owns no buffer to release on teardown. */ } },
      updateRecordingActive: (): void => { /* No-op: the double records no HKSV state. */ } } as unknown as TestStreamingDelegate["hksv"];

    // The parent's own bare motion is suppressed (it is smart-capable, smart-enabled, and not recording), so the lone delivery on the advance is the package forward,
    // recorded against the shared ufp.id.
    store.pushCameraPatch(cameraId, { lastMotion: 1700000000000 });

    await settle();

    assert.deepEqual(recording.calls, [{ id: doorbell.protectId, kind: "motion" }],
      "with the parent suppressed, the bare-motion advance delivered exactly once - the forward to the recording package camera");
  });

  test("a non-recording package camera receives no forward, and the suppressed parent delivers nothing either", async () => {

    const { cameraId, recording, store } = await buildFamily();

    assert.ok(doorbell?.packageCamera?.stream, "the package camera holds its stub stream");

    // The package stub's hksv defaults to null, so stream?.hksv?.isRecording is falsy: the forward gate is closed. The parent is suppressed too, so the advance delivers
    // nothing at all - proving the forward gates on the package's own recording state, not merely on the parent's advance.
    store.pushCameraPatch(cameraId, { lastMotion: 1700000000000 });

    await settle();

    assert.deepEqual(recording.calls, [],
      "a non-recording package receives no forward, and the suppressed parent delivers nothing - the advance produced zero deliveries");
  });
});

describe("the package camera UUID-seed pin", () => {

  test("a cached accessory keyed by the literal MAC + .PackageCamera seed is found, not re-registered", async () => {

    const cameraConfig = makeCameraConfig({ channels: G6_PRO_ENTRY_CHANNELS, featureFlags: { hasPackageCamera: true, isDoorbell: true }, name: "Front Door" });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { apiCalls, controller, nvr } = makeTestNvr({ store });

    // The pin is the LITERAL seed string, deliberately not derived from the production constant: cached accessories in the field were keyed by exactly this value,
    // so any drift in the persistence-critical identity suffix must break this fixture loudly.
    const cached = new TestAccessory("Cached Package", "uuid:" + cameraConfig.mac + ".PackageCamera");

    nvr.platform.accessories.push(cached);

    const doorbell = constructDoorbell(nvr, makeTestAccessory("Front Door", "uuid:74ACB9000001"), new TestCameraProjection(cameraConfig.id, store));

    await settle();

    assert.equal(doorbell.packageCamera?.accessory, cached, "the doorbell adopted the cached accessory by its persisted UUID");
    assert.equal(apiCalls.filter((call) => (call.kind === "register") || (call.kind === "publishExternal")).length, 0, "no new accessory was ever registered");

    doorbell.cleanup();

    await settle();

    controller.abort();
  });
});

describe("pure-test unlocks: package channel selection and the recording pixel ceiling", () => {

  test("the package selectChannel pins lens 2 and resolves its URL through the rtspHost chain", async () => {

    // The connectionHost leg of the chain: no override configured, so the URL resolves against the camera's own connection host (the fixture host).
    const cameraConfig = makeCameraConfig({ channels: G6_PRO_ENTRY_CHANNELS, featureFlags: { hasPackageCamera: true, isDoorbell: true } });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { controller, nvr } = makeTestNvr({ store });
    const doorbell = constructDoorbell(nvr, makeTestAccessory(), new TestCameraProjection(cameraConfig.id, store));

    await settle();

    const profile = doorbell.packageCamera?.selectChannel();

    assert.ok(profile, "the package channel resolves");
    assert.equal(profile.lens, 2, "the package profile pins lens 2");
    assert.deepEqual(profile.resolution, [ 1600, 1200, 3 ], "the profile carries the package channel's native resolution");
    assert.equal(profile.url, "rtsps://camera.test:7441/alias3?enableSrtp", "the URL resolves through the connectionHost leg of the rtspHost chain");

    doorbell.cleanup();

    await settle();

    controller.abort();

    // The overrideAddress leg: a configured controller address override wins over the connection host.
    const overrideConfig = makeCameraConfig({ channels: G6_PRO_ENTRY_CHANNELS, featureFlags: { hasPackageCamera: true, isDoorbell: true } });
    const overrideStore = new TestStateStore(makeProtectState({ cameras: [overrideConfig] }));
    const overrideHarness = makeTestNvr({ overrideAddress: "override.example", store: overrideStore });
    const overrideDoorbell = constructDoorbell(overrideHarness.nvr, makeTestAccessory(), new TestCameraProjection(overrideConfig.id, overrideStore));

    await settle();

    assert.equal(overrideDoorbell.packageCamera?.selectChannel()?.url, "rtsps://override.example:7441/alias3?enableSrtp",
      "the URL resolves through the overrideAddress leg of the rtspHost chain");

    overrideDoorbell.cleanup();

    await settle();

    overrideHarness.controller.abort();
  });

  test("a finite recording pixel ceiling drops channels above the cap from selectRecordingChannel", async () => {

    // The capped camera, with hardware transcoding disabled so no recording default pins a named channel: a 720p ceiling drops the 4K High channel, so a 4K
    // recording request lands on Medium through the bias-higher nearest selection over what survives the cap.
    const cappedConfig = makeCameraConfig({ channels: G6_INSTANT_CHANNELS });
    const cappedStore = new TestStateStore(makeProtectState({ cameras: [cappedConfig] }));
    const capped = makeTestNvr({ store: cappedStore, userOptions: ["Disable.Video.Transcode.Hardware"] });

    capped.factory.maxSourcePixels = 1280 * 720;

    const cappedCamera = new ProtectCamera(capped.nvr as unknown as ProtectNvr, makeTestAccessory() as unknown as ProtectAccessory,
      new TestCameraProjection(cappedConfig.id, cappedStore) as unknown as Camera);

    await settle();

    assert.equal(cappedCamera.selectRecordingChannel(3840, 2160)?.channel.name, "Medium", "the ceiling drops High, so the request selects Medium");

    cappedCamera.cleanup();

    await settle();

    capped.controller.abort();

    // The name-branch parity row: at defaults, hardware transcoding pins the recording default to the named High channel, and the cap pre-filter applies to the
    // name branch too - so a capped request against a pinned-but-dropped channel honestly selects nothing rather than silently substituting.
    const pinnedConfig = makeCameraConfig({ channels: G6_INSTANT_CHANNELS });
    const pinnedStore = new TestStateStore(makeProtectState({ cameras: [pinnedConfig] }));
    const pinned = makeTestNvr({ store: pinnedStore });

    pinned.factory.maxSourcePixels = 1280 * 720;

    const pinnedCamera = new ProtectCamera(pinned.nvr as unknown as ProtectNvr, makeTestAccessory() as unknown as ProtectAccessory,
      new TestCameraProjection(pinnedConfig.id, pinnedStore) as unknown as Camera);

    await settle();

    assert.equal(pinnedCamera.selectRecordingChannel(3840, 2160), null, "the cap pre-filter applies to the name-pinned branch, matching HEAD's selection semantics");

    pinnedCamera.cleanup();

    await settle();

    pinned.controller.abort();

    // The uncapped control: the default Infinity ceiling passes everything through, so the same request selects High.
    const openConfig = makeCameraConfig({ channels: G6_INSTANT_CHANNELS });
    const openStore = new TestStateStore(makeProtectState({ cameras: [openConfig] }));
    const open = makeTestNvr({ store: openStore });
    const openCamera = new ProtectCamera(open.nvr as unknown as ProtectNvr, makeTestAccessory() as unknown as ProtectAccessory,
      new TestCameraProjection(openConfig.id, openStore) as unknown as Camera);

    await settle();

    assert.equal(openCamera.selectRecordingChannel(3840, 2160)?.channel.name, "High", "the uncapped control selects the native High channel");

    openCamera.cleanup();

    await settle();

    open.controller.abort();
  });
});
