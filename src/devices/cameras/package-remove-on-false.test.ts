/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * package-remove-on-false.test.ts: The package camera's remove-on-false lifecycle - the stability-gated, graced reconcile and detach.
 *
 * This suite drives the doorbell capability's reconcilePackageCamera - the single lifecycle chokepoint for both directions of the controller's hasPackageCamera
 * capability flag - against the harness NVR double's recorded removal machinery, which mirrors the production chokepoint (the stability gate, the per-UUID
 * idempotency, the grace interval resolved through the REAL feature-option engine, and the production fire body re-checking stability and stillGone) without real
 * timers. Every scenario the reconcile must survive is pinned: the immediate observer-armed detach and its event-timer and MQTT hygiene, the default sixty-second
 * grace, the standalone accessory's bridged-gated tail and manual-deletion guidance, the across-restart ghost the stability sweep's per-device reconcile arm catches,
 * the stability gating and the re-arm after a cancel-all, the capability flap that cancels its own pending detach, the absence-tolerant stillGone predicate against a
 * removed parent record, and the stale-fire-after-cascade no-op the presence-guarded tail and accessory re-derivation guarantee.
 *
 * Honesty notes on scope: the production nvr.ts machinery itself (scheduleDeviceRemoval's widened chokepoint, the extracted removeAccessoryFromHomeKit tail,
 * removeHomeKitDevice's per-accessory cancel, and the sweep's package pass) cannot be unit-driven without standing up a real ProtectNvr, so the double mirrors its
 * specification and the doorbell-side behavior is what these tests exercise end to end - the production wiring is verified by inspection and the type system. The
 * cascade in the stale-fire scenario is likewise simulated through the double's tail plus the doorbell's cleanup, the same operations the production cascade
 * performs.
 */
import type { TestAccessory, TestApiCall, TestLogEntry, TestMqttClient, TestProtectNvr } from "../../testing.helpers.ts";
import { TestCameraProjection, TestStateStore, makeCameraConfig, makeProtectState, makeTestAccessory, makeTestAccessoryFamily, makeTestNvr,
  settle } from "../../testing.helpers.ts";
import { describe, test } from "node:test";
import type { Camera } from "unifi-protect";
import type { DoorbellCapability } from "./doorbell.ts";
import { G6_PRO_ENTRY_CHANNELS } from "../../camera.fixtures.ts";
import type { Nullable } from "homebridge-plugin-utils";
import type { ObserverWakePayload } from "../../diagnostics.ts";
import type { ProtectAccessory } from "../../types.ts";
import { ProtectCamera } from "./camera.ts";
import type { ProtectNvr } from "../../nvr/nvr.ts";
import assert from "node:assert/strict";
import diagnosticsChannel from "node:diagnostics_channel";

// The fixture identities, deliberately literal: the parent MAC, the package id the event timers key on, and the package accessory's deterministic UUID.
const PARENT_MAC = "74ACB9000001";
const PACKAGE_ID = "74ACB9000001.PackageCamera";
const PACKAGE_UUID = "uuid:74ACB9000001.PackageCamera";

// One assembled doorbell-plus-package family and its harness handles. The doorbell is a real ProtectCamera that construction-attached its capability; the capability is
// exposed directly so the suite can drive its reconcilePackageCamera (the package lifecycle lives on the capability).
interface FamilyHarness {

  apiCalls: TestApiCall[];
  cameraId: string;
  capability: DoorbellCapability;
  controller: AbortController;
  doorbell: ProtectCamera;
  logEntries: TestLogEntry[];
  mqtt: Nullable<TestMqttClient>;
  nvr: TestProtectNvr;
  store: TestStateStore;
}

// Assemble a real doorbell family against a fresh store and NVR double, settled and ready to drive.
async function makeFamily(options: { hasPackageCamera?: boolean; userOptions?: string[] } = {}): Promise<FamilyHarness> {

  const cameraConfig = makeCameraConfig({ channels: G6_PRO_ENTRY_CHANNELS, featureFlags: { hasPackageCamera: options.hasPackageCamera ?? true, isDoorbell: true },
    name: "Front Door" });
  const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
  const { apiCalls, controller, logEntries, mqtt, nvr } = makeTestNvr({ mqtt: true, store, userOptions: options.userOptions });
  const doorbell = new ProtectCamera(nvr as unknown as ProtectNvr, makeTestAccessory("Front Door", "uuid:" + PARENT_MAC) as unknown as ProtectAccessory,
    new TestCameraProjection(cameraConfig.id, store) as unknown as Camera);

  await settle();

  assert.ok(doorbell.doorbell, "the camera construction-attached its doorbell capability");

  return { apiCalls, cameraId: cameraConfig.id, capability: doorbell.doorbell, controller, doorbell, logEntries, mqtt, nvr, store };
}

// Push the hasPackageCamera capability flag through the shared featureFlags-composing helper so nothing else on the flags object moves.
function pushPackageFlag(harness: FamilyHarness, value: boolean): void {

  harness.store.pushCameraFeatureFlags(harness.cameraId, { hasPackageCamera: value });
}

describe("package camera remove-on-false (BC2)", () => {

  test("a capability withdrawal with the grace disabled detaches immediately: teardown, guarded tail, event-timer and MQTT hygiene, and silence afterward", async () => {

    const harness = await makeFamily({ userOptions: ["Disable.Nvr.DelayDeviceRemoval"] });
    const { apiCalls, doorbell, logEntries, mqtt, nvr, store } = harness;

    assert.ok(doorbell.packageCamera, "the package camera starts live");
    assert.ok(mqtt, "the recording MQTT double is installed");

    const accessory = doorbell.packageCamera.accessory as unknown as TestAccessory;

    // An inflight package motion event: the dispatcher latches MotionDetected, publishes "true" on the shared parent topic, and parks the reset timer.
    nvr.events.motionEventHandler(doorbell.packageCamera);

    assert.equal(nvr.events.hasInflightMotion(PACKAGE_ID), true, "the package's bare-motion reset timer is inflight");

    // The capability withdrawal: the observer reconciles, the disabled grace removes immediately, and the detach runs inside the same drain.
    pushPackageFlag(harness, false);

    await settle();

    assert.equal(doorbell.packageCamera, null, "the detach nulled the package camera handle");
    assert.equal(nvr.platform.accessories.includes(accessory), false, "the accessory left the platform array through the guarded tail");
    assert.equal(apiCalls.filter((call) => (call.kind === "unregister") && call.accessories.includes(accessory)).length, 1, "the bridged accessory unregistered");
    assert.equal(accessory.removeControllerCalls.length, 1, "the package's HomeKit camera controller was removed at teardown");
    assert.equal(nvr.events.hasInflightMotion(PACKAGE_ID), false, "the package's event timers were cleared");

    // The terminal publish: the cleared reset timer would have published the shared topic's motion "false"; with no parent inflight, the detach owns it.
    const motionPublishes = mqtt.published.filter((entry) => entry.topic === PARENT_MAC + "/motion").map((entry) => entry.message);

    assert.deepEqual(motionPublishes, [ "true", "false" ], "exactly one terminal motion reset follows the latched motion on the shared topic");

    // The flow's one user-facing message is the schedule-time reason.
    assert.equal(logEntries.filter((entry) => String(entry.parameters[0]).includes("no longer reports a package camera")).length, 1,
      "the removal decision is narrated exactly once");

    // Post-detach, the package is gone reactively too: only the doorbell's own observers remain and a state push wakes nothing attributed to the package.
    const wakes: ObserverWakePayload[] = [];
    const onWake = (message: unknown): void => { wakes.push(message as ObserverWakePayload); };

    diagnosticsChannel.subscribe("hbup:observer:wake", onWake);

    try {

      assert.equal(store.observerCount, 18, "only the doorbell's observers survive the detach");
      store.pushCameraPatch(harness.cameraId, { state: "DISCONNECTED" });

      await settle();

      assert.equal(wakes.filter((wake) => wake.accessoryId === accessory.UUID).length, 0, "no wake is ever attributed to the detached package accessory");
    } finally {

      diagnosticsChannel.unsubscribe("hbup:observer:wake", onWake);
    }

    doorbell.cleanup();
    harness.controller.abort();
  });

  test("with no option configured, the registered default applies: the detach schedules with a sixty-second grace rather than firing immediately", async () => {

    const harness = await makeFamily();
    const { doorbell, nvr } = harness;

    pushPackageFlag(harness, false);

    await settle();

    assert.equal(nvr.scheduledRemovals.length, 1, "the withdrawal scheduled exactly one removal");
    assert.equal(nvr.scheduledRemovals[0]?.interval, 60, "the grace resolves to the registered DelayDeviceRemoval default of sixty seconds");
    assert.ok(nvr.removalTimers.has(PACKAGE_UUID), "the detach is pending, keyed by the package accessory's UUID");
    assert.ok(doorbell.packageCamera, "the package camera stays live until the grace fires");

    doorbell.cleanup();
    harness.controller.abort();
  });

  test("a standalone package camera detaches without an unregister and the user receives the manual-deletion guidance", async () => {

    const harness = await makeFamily({ userOptions: [ "Enable.Device.Standalone", "Disable.Nvr.DelayDeviceRemoval" ] });
    const { apiCalls, doorbell, logEntries, nvr } = harness;

    assert.ok(doorbell.packageCamera, "the package camera starts live");

    const accessory = doorbell.packageCamera.accessory as unknown as TestAccessory;

    assert.equal(accessory._associatedHAPAccessory.bridged, false, "the standalone package published external and is unbridged");

    pushPackageFlag(harness, false);

    await settle();

    assert.equal(nvr.platform.accessories.includes(accessory), false, "the accessory left the platform array");
    assert.equal(apiCalls.filter((call) => call.kind === "unregister").length, 0, "an unbridged accessory is never unregistered - hap-nodejs would throw");
    assert.equal(logEntries.filter((entry) => String(entry.parameters[0]).includes("manually delete the package camera accessory")).length, 1,
      "the manual-deletion guidance is emitted exactly once");

    doorbell.cleanup();
    harness.controller.abort();
  });

  test("the across-restart ghost: a cached bridged package accessory with the capability withdrawn is detached by the sweep's per-device reconcile arm", async () => {

    // The restart shape: both cached accessories restored bridged, the controller reporting the capability withdrawn, the doorbell constructed against the cached
    // parent - so no live package instance ever exists, and the cached package accessory is unreachable by any other removal path.
    const cameraConfig = makeCameraConfig({ channels: G6_PRO_ENTRY_CHANNELS, featureFlags: { hasPackageCamera: false, isDoorbell: true }, name: "Front Door" });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { apiCalls, controller, nvr } = makeTestNvr({ store });
    const { packageAccessory, parentAccessory } = makeTestAccessoryFamily({ nvr });
    const doorbell = new ProtectCamera(nvr as unknown as ProtectNvr, parentAccessory as unknown as ProtectAccessory,
      new TestCameraProjection(cameraConfig.id, store) as unknown as Camera);

    await settle();

    assert.ok(doorbell.doorbell, "the doorbell capability attached even with the package capability withdrawn");
    assert.equal(doorbell.packageCamera, null, "no live package instance exists with the capability withdrawn");

    // The stability sweep's package pass calls reconcilePackageCamera on every doorbell's capability; this is that per-device arm.
    doorbell.doorbell.reconcilePackageCamera();

    assert.equal(nvr.scheduledRemovals.length, 1, "the reconcile found the cached ghost through the platform lookup and scheduled its detach");
    assert.equal(nvr.scheduledRemovals[0]?.interval, 60, "the ghost detach honors the same default grace");

    nvr.removalTimers.get(packageAccessory.UUID)?.fire();

    assert.equal(nvr.platform.accessories.includes(packageAccessory), false, "the fired grace removed the cached ghost");
    assert.equal(apiCalls.filter((call) => (call.kind === "unregister") && call.accessories.includes(packageAccessory)).length, 1, "the bridged ghost unregistered");
    assert.ok(nvr.platform.accessories.includes(parentAccessory), "the live parent accessory is untouched");
    assert.equal(doorbell.packageCamera, null, "no instance was ever conjured for the ghost");

    doorbell.cleanup();
    controller.abort();
  });

  test("the stability gate suppresses the reconcile's schedule, and the sweep re-arms a detach dropped by a cancel-all", async () => {

    const cameraConfig = makeCameraConfig({ channels: G6_PRO_ENTRY_CHANNELS, featureFlags: { hasPackageCamera: false, isDoorbell: true }, name: "Front Door" });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { controller, nvr } = makeTestNvr({ store });
    const { packageAccessory, parentAccessory } = makeTestAccessoryFamily({ nvr });
    const doorbell = new ProtectCamera(nvr as unknown as ProtectNvr, parentAccessory as unknown as ProtectAccessory,
      new TestCameraProjection(cameraConfig.id, store) as unknown as Camera);

    await settle();

    assert.ok(doorbell.doorbell, "the doorbell capability attached");

    // An unstable controller schedules nothing - the chokepoint's gate, not caller discipline, is what holds the policy.
    nvr.removalStable = false;
    doorbell.doorbell.reconcilePackageCamera();

    assert.equal(nvr.scheduledRemovals.length, 0, "no detach schedules while the controller is unstable");

    // Stability returns: the sweep's reconcile arm schedules the detach.
    nvr.removalStable = true;
    doorbell.doorbell.reconcilePackageCamera();

    assert.equal(nvr.scheduledRemovals.length, 1, "the stability return arms the detach");

    // A disruption cancels every pending removal; the next stability return's sweep re-arms it.
    nvr.cancelAllDeviceRemovals();

    assert.equal(nvr.removalTimers.size, 0, "the disruption dropped the pending detach");

    doorbell.doorbell.reconcilePackageCamera();

    assert.equal(nvr.scheduledRemovals.length, 2, "the re-arm schedules the detach again");
    assert.ok(nvr.removalTimers.has(packageAccessory.UUID), "the detach is pending once more");

    doorbell.cleanup();
    controller.abort();
  });

  test("a capability flap cancels its own pending detach, and a stale fire finds stillGone false and removes nothing", async () => {

    const harness = await makeFamily();
    const { doorbell, nvr } = harness;

    assert.ok(doorbell.packageCamera, "the package camera starts live");

    const instance = doorbell.packageCamera;
    const accessory = instance.accessory as unknown as TestAccessory;

    // The withdrawal arms the graced detach...
    pushPackageFlag(harness, false);

    await settle();

    const staleEntry = nvr.removalTimers.get(PACKAGE_UUID);

    assert.ok(staleEntry, "the detach grace is pending");

    // ...and the flap back cancels it through the reconcile's true arm, ahead of configurePackageCamera's instance guard.
    pushPackageFlag(harness, true);

    await settle();

    assert.ok(nvr.cancelledRemovals.includes(PACKAGE_UUID), "the true flip cancelled the pending detach");
    assert.equal(nvr.removalTimers.size, 0, "no detach remains pending");
    assert.equal(doorbell.packageCamera, instance, "the live instance rode the flap untouched - configurePackageCamera is idempotent");

    // A stale fire that somehow survived the cancel re-reads live state: stillGone is false, so nothing is removed.
    staleEntry.fire();

    assert.equal(doorbell.packageCamera, instance, "the stale fire detached nothing");
    assert.ok(nvr.platform.accessories.includes(accessory), "the accessory survives the stale fire");

    doorbell.cleanup();
    harness.controller.abort();
  });

  test("stillGone is absence-tolerant: a removed parent record reads as gone without throwing", async () => {

    const harness = await makeFamily();
    const { nvr, store } = harness;

    pushPackageFlag(harness, false);

    await settle();

    const stillGone = nvr.scheduledRemovals[0]?.options.stillGone;

    assert.ok(stillGone, "the scheduled detach recorded its stillGone predicate");

    // Unwind the doorbell's observers before removing the record - hygiene that isolates the captured stillGone closure from any live observer reaction. The captured
    // closure is exactly what the production fire would run, and it must hold its absence tolerance independently of any live instance. (Every doorbell selector
    // hoists its plain id at spawn, including the chime-volume selector, so the live instance does not throw against a removed record either.)
    harness.doorbell.cleanup();

    await settle();

    // The parent record leaves the store entirely - the projection's config getter now throws, but the predicate reads through the selector against the captured
    // plain id and must simply report gone.
    store.removeCameraRecord(harness.cameraId);

    await settle();

    assert.doesNotThrow(() => stillGone(), "the predicate never throws against an absent parent");
    assert.equal(stillGone(), true, "an absent parent reads as gone");

    harness.controller.abort();
  });

  test("a stale detach fire after the cascade already removed the accessory is a no-op - the platform array is never corrupted", async () => {

    const harness = await makeFamily();
    const { doorbell, nvr } = harness;

    assert.ok(doorbell.packageCamera, "the package camera starts live");

    const accessory = doorbell.packageCamera.accessory as unknown as TestAccessory;

    // A bystander accessory seeded LAST in the platform array: the exact victim an unguarded splice(indexOf = -1) would silently delete.
    const bystander = makeTestAccessory("Bystander", "uuid:bystander");

    nvr.platform.accessories.push(bystander);
    pushPackageFlag(harness, false);

    await settle();

    const staleEntry = nvr.removalTimers.get(PACKAGE_UUID);

    assert.ok(staleEntry, "the detach grace is pending");

    // The cascade arrives first: the parent's removal tears the family down and removes the package accessory through the same tail (production's
    // removeHomeKitDevice additionally cancels the pending timer - the stale fire below exercises the backstop for a fire already in flight).
    doorbell.cleanup();
    nvr.removeAccessoryFromHomeKit(accessory);

    const survivors = [...nvr.platform.accessories];

    staleEntry.fire();

    assert.deepEqual(nvr.platform.accessories, survivors, "the stale fire removed nothing further");
    assert.ok(nvr.platform.accessories.includes(bystander), "the bystander - the splice(-1) victim of an unguarded tail - survives");

    harness.controller.abort();
  });

  test("event-timer clearing is exact-boundary: the detach clears only the package's timers, and a parent inflight motion suppresses the terminal publish", async () => {

    const harness = await makeFamily({ userOptions: ["Disable.Nvr.DelayDeviceRemoval"] });
    const { doorbell, mqtt, nvr } = harness;

    assert.ok(doorbell.packageCamera, "the package camera starts live");
    assert.ok(mqtt, "the recording MQTT double is installed");

    // Both the parent and the package latch inflight motion: two reset timers, the parent's keyed by the bare MAC, the package's by the suffixed id.
    nvr.events.motionEventHandler(doorbell);
    nvr.events.motionEventHandler(doorbell.packageCamera);

    assert.equal(nvr.events.hasInflightMotion(PARENT_MAC), true, "the parent's bare-motion timer is inflight");
    assert.equal(nvr.events.hasInflightMotion(PACKAGE_ID), true, "the package's bare-motion timer is inflight");

    pushPackageFlag(harness, false);

    await settle();

    // The exact boundary: the detach cleared the package's timers and left the parent's untouched - the package id is the parent id plus a "." segment, the very
    // shape a naive prefix clear would conflate.
    assert.equal(nvr.events.hasInflightMotion(PACKAGE_ID), false, "the package's timers are cleared");
    assert.equal(nvr.events.hasInflightMotion(PARENT_MAC), true, "the parent's inflight motion survives the package-scoped clear");

    // With the parent inflight, its own reset timer owns the shared topic's terminal "false" - the detach publishes nothing.
    assert.equal(mqtt.published.filter((entry) => (entry.topic === PARENT_MAC + "/motion") && (entry.message === "false")).length, 0,
      "no premature terminal reset is published while the parent's motion is live");

    // Teardown hygiene: clear the parent's real reset timer so nothing outlives the test (a parent-id clear sweeps everything, which is exactly right here).
    nvr.events.clearEventTimersForDevice(PARENT_MAC);
    doorbell.cleanup();
    harness.controller.abort();
  });
});
