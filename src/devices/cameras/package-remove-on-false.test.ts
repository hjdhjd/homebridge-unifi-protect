/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * package-remove-on-false.test.ts: The package camera's remove-on-false lifecycle - the stability-gated, graced reconcile and detach.
 *
 * This suite drives the doorbell capability's reconcilePackageCamera - the single lifecycle chokepoint for both directions of the controller's hasPackageCamera
 * capability flag - against the REAL RemovalStabilityGate the harness NVR double carries, so the stability gating, the per-UUID first-deadline rule, the grace
 * resolved through the REAL feature-option engine, and the fire body's stillGone re-check are the production ones running on production timers. Every scenario the
 * reconcile must survive is pinned: the immediate observer-armed detach and its event-timer and MQTT hygiene, the default sixty-second grace, the standalone
 * accessory's bridged-gated tail and manual-deletion guidance, the across-restart ghost the stability sweep's per-device reconcile arm catches, the stability gating
 * and the re-arm after a disruption drops a pending grace, the capability flap that cancels its own pending detach, the absence-tolerant stillGone predicate against a
 * removed parent record, and the fire-after-cascade no-op the detach's own absent-target guard guarantees.
 *
 * A graced detach therefore needs the clock moved, not a recorded entry invoked: each such test builds its fixture under real time, enables node:test's mocked timers,
 * re-establishes stability against the mocked clock (the gate counts from now after its first stabilization), drives the reconcile, and ticks. What every assertion
 * reads is a real observable - the live package handle, the platform accessory array, the registration recorders, the narration.
 *
 * Honesty notes on scope: the root-side production machinery (removeHomeKitDevice's richer cascade with its per-accessory cancel, and the sweep's package pass) cannot
 * be unit-driven without standing up a real ProtectNvr, so the double wires the gate to its own thin removal tail and the doorbell-side behavior is what these tests
 * exercise end to end. The cascade in the fire-after-cascade scenario is likewise assembled from the doorbell's cleanup plus that tail, the same operations the
 * production cascade performs.
 */
import type { TestAccessory, TestApiCall } from "../../testing.helpers.ts";
import { TestCameraProjection, makeCameraConfig } from "../testing.helpers.ts";
import { TestStateStore, makeProtectState, makeTestAccessory, settle } from "../../testing.helpers.ts";
import { describe, mock, test } from "node:test";
import { makeTestAccessoryFamily, makeTestNvr } from "../../nvr/testing.helpers.ts";
import type { Camera } from "unifi-protect";
import type { DoorbellCapability } from "./doorbell.ts";
import { G6_PRO_ENTRY_CHANNELS } from "../../camera.fixtures.ts";
import type { Nullable } from "homebridge-plugin-utils";
import type { ObserverWakePayload } from "../../diagnostics.ts";
import type { ProtectAccessory } from "../../types.ts";
import { ProtectCamera } from "./camera.ts";
import type { ProtectNvr } from "../../nvr/nvr.ts";
import type { TestLogEntry } from "homebridge-plugin-utils/testing";
import type { TestMqttClient } from "homebridge-plugin-utils/testing";
import type { TestProtectNvr } from "../../nvr/testing.helpers.ts";
import assert from "node:assert/strict";
import diagnosticsChannel from "node:diagnostics_channel";
import { formatLogEntry } from "homebridge-plugin-utils/testing";

// The fixture identities, deliberately literal: the parent MAC and the package id the event timers key on.
const PARENT_MAC = "74ACB9000001";
const PACKAGE_ID = "74ACB9000001.PackageCamera";

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

// Every "Delaying device removal" line the gate narrated, as the harness rendered it. The line carries the resolved grace, so counting these lines is how an arm and a
// re-arm are told apart, and the text of one is the exact-interval pin.
function delayingLines(entries: TestLogEntry[]): string[] {

  return entries.filter((entry) => formatLogEntry(entry).includes("Delaying device removal")).map((entry) => formatLogEntry(entry));
}

// The delay line the gate emits for an accessory at the registered sixty-second default.
function defaultDelayLine(accessory: TestAccessory): string {

  return accessory.displayName + ": Delaying device removal for at least 60 seconds.";
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
    const motionPublishes = mqtt.published.filter((entry) => entry.topic === PARENT_MAC + "/motion").map((entry) => entry.payload);

    assert.deepEqual(motionPublishes, [ "true", "false" ], "exactly one terminal motion reset follows the latched motion on the shared topic");

    // The flow's one user-facing message is the schedule-time reason.
    assert.equal(logEntries.filter((entry) => formatLogEntry(entry).includes("no longer reports a package camera")).length, 1,
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
    const { doorbell, logEntries, nvr } = harness;

    assert.ok(doorbell.packageCamera, "the package camera starts live");

    const accessory = doorbell.packageCamera.accessory as unknown as TestAccessory;

    mock.timers.enable({ apis: [ "Date", "setTimeout" ] });

    try {

      nvr.restabilizeController((ms) => mock.timers.tick(ms));
      pushPackageFlag(harness, false);

      await settle();

      // The withdrawal deferred rather than detaching, and the narration carries the interval it resolved - the exact-value pin a coarse tick-then-observe would miss.
      assert.ok(doorbell.packageCamera, "the package camera stays live until the grace fires");
      assert.deepEqual(delayingLines(logEntries), [defaultDelayLine(accessory)], "the grace resolves to the registered DelayDeviceRemoval default of sixty seconds");
      assert.ok(nvr.platform.accessories.includes(accessory), "the package accessory is still on the platform inside the grace");

      mock.timers.tick(60000);

      assert.equal(doorbell.packageCamera, null, "the elapsed grace detached the package camera");
      assert.equal(nvr.platform.accessories.includes(accessory), false, "the detach removed the package accessory through the tail");
    } finally {

      mock.timers.reset();
    }

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
    assert.equal(logEntries.filter((entry) => formatLogEntry(entry).includes("manually delete the package camera accessory")).length, 1,
      "the manual-deletion guidance is emitted exactly once");

    doorbell.cleanup();
    harness.controller.abort();
  });

  test("the across-restart ghost: a cached bridged package accessory with the capability withdrawn is detached by the sweep's per-device reconcile arm", async () => {

    // The restart shape: both cached accessories restored bridged, the controller reporting the capability withdrawn, the doorbell constructed against the cached
    // parent - so no live package instance ever exists, and the cached package accessory is unreachable by any other removal path.
    const cameraConfig = makeCameraConfig({ channels: G6_PRO_ENTRY_CHANNELS, featureFlags: { hasPackageCamera: false, isDoorbell: true }, name: "Front Door" });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { apiCalls, controller, logEntries, nvr } = makeTestNvr({ store });
    const { packageAccessory, parentAccessory } = makeTestAccessoryFamily({ nvr });
    const doorbell = new ProtectCamera(nvr as unknown as ProtectNvr, parentAccessory as unknown as ProtectAccessory,
      new TestCameraProjection(cameraConfig.id, store) as unknown as Camera);

    await settle();

    assert.ok(doorbell.doorbell, "the doorbell capability attached even with the package capability withdrawn");
    assert.equal(doorbell.packageCamera, null, "no live package instance exists with the capability withdrawn");

    mock.timers.enable({ apis: [ "Date", "setTimeout" ] });

    try {

      nvr.restabilizeController((ms) => mock.timers.tick(ms));

      // The stability sweep's package pass calls reconcilePackageCamera on every doorbell's capability; this is that per-device arm.
      doorbell.doorbell.reconcilePackageCamera();

      assert.deepEqual(delayingLines(logEntries), [defaultDelayLine(packageAccessory)],
        "the reconcile found the cached ghost through the platform lookup and armed its detach at the same default grace");
      assert.ok(nvr.platform.accessories.includes(packageAccessory), "the ghost is still on the platform inside the grace");

      mock.timers.tick(60000);

      assert.equal(nvr.platform.accessories.includes(packageAccessory), false, "the elapsed grace removed the cached ghost");
      assert.equal(apiCalls.filter((call) => (call.kind === "unregister") && call.accessories.includes(packageAccessory)).length, 1, "the bridged ghost unregistered");
      assert.ok(nvr.platform.accessories.includes(parentAccessory), "the live parent accessory is untouched");
      assert.equal(doorbell.packageCamera, null, "no instance was ever conjured for the ghost");
    } finally {

      mock.timers.reset();
    }

    doorbell.cleanup();
    controller.abort();
  });

  test("the stability gate suppresses the reconcile's schedule, and the sweep re-arms a detach a disruption dropped", async () => {

    const cameraConfig = makeCameraConfig({ channels: G6_PRO_ENTRY_CHANNELS, featureFlags: { hasPackageCamera: false, isDoorbell: true }, name: "Front Door" });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { controller, logEntries, nvr } = makeTestNvr({ store });
    const { packageAccessory, parentAccessory } = makeTestAccessoryFamily({ nvr });
    const doorbell = new ProtectCamera(nvr as unknown as ProtectNvr, parentAccessory as unknown as ProtectAccessory,
      new TestCameraProjection(cameraConfig.id, store) as unknown as Camera);

    await settle();

    assert.ok(doorbell.doorbell, "the doorbell capability attached");

    mock.timers.enable({ apis: [ "Date", "setTimeout" ] });

    try {

      // An unstable controller schedules nothing - the chokepoint's gate, not caller discipline, is what holds the policy. The gate checks stability ahead of any
      // narration, so the absent line is the observable, and nothing is left armed to fire later either.
      nvr.pushControllerStability(false);
      doorbell.doorbell.reconcilePackageCamera();

      assert.deepEqual(delayingLines(logEntries), [], "no detach is scheduled or narrated while the controller is unstable");

      mock.timers.tick(600000);

      assert.ok(nvr.platform.accessories.includes(packageAccessory), "nothing was removed across the unstable window");

      // Stability returns: the sweep's reconcile arm schedules the detach.
      nvr.restabilizeController((ms) => mock.timers.tick(ms));
      doorbell.doorbell.reconcilePackageCamera();

      assert.deepEqual(delayingLines(logEntries), [defaultDelayLine(packageAccessory)], "the stability return armed the detach");

      // The disruption: leaving good state drops the clock and drains every pending grace as one act, so the armed detach never fires.
      nvr.pushControllerStability(false);

      mock.timers.tick(600000);

      assert.ok(nvr.platform.accessories.includes(packageAccessory), "the disruption dropped the pending detach before it could fire");

      // The next stability return's sweep re-arms it, and this time it lands: the second narration line is the arm-then-re-arm observable.
      nvr.restabilizeController((ms) => mock.timers.tick(ms));
      doorbell.doorbell.reconcilePackageCamera();

      assert.deepEqual(delayingLines(logEntries), [ defaultDelayLine(packageAccessory), defaultDelayLine(packageAccessory) ], "the re-arm schedules the detach again");

      mock.timers.tick(60000);

      assert.equal(nvr.platform.accessories.includes(packageAccessory), false, "the re-armed grace fired and removed the ghost");
      assert.ok(nvr.platform.accessories.includes(parentAccessory), "the live parent accessory is untouched");
    } finally {

      mock.timers.reset();
    }

    doorbell.cleanup();
    controller.abort();
  });

  test("a capability flap cancels its own pending detach, so only the deadline the flap-back armed ever fires", async () => {

    const harness = await makeFamily();
    const { apiCalls, doorbell, logEntries, nvr } = harness;

    assert.ok(doorbell.packageCamera, "the package camera starts live");

    const instance = doorbell.packageCamera;
    const accessory = instance.accessory as unknown as TestAccessory;

    mock.timers.enable({ apis: [ "Date", "setTimeout" ] });

    try {

      nvr.restabilizeController((ms) => mock.timers.tick(ms));

      // The withdrawal arms the graced detach at the sixty-second deadline...
      pushPackageFlag(harness, false);

      await settle();

      assert.deepEqual(delayingLines(logEntries), [defaultDelayLine(accessory)], "the withdrawal armed the detach");

      // ...and the flap back cancels it through the reconcile's true arm, ahead of configurePackageCamera's instance guard. Cancellation narrates nothing, so the
      // observable that tells a broken cancel apart is WHICH deadline fires - which needs the two deadlines separated in time, and only an explicit advance does that
      // (a settle never moves the mocked clock). Half the grace is spent here, so the flap-back detach below lands thirty seconds after the stale one would have.
      pushPackageFlag(harness, true);

      await settle();

      assert.equal(doorbell.packageCamera, instance, "the live instance rode the flap untouched - a second configurePackageCamera is a no-op");

      mock.timers.tick(30000);

      // The second withdrawal arms a FRESH detach, thirty seconds later than the cancelled one. A broken cancelFor would instead leave the stale timer armed and this
      // schedule would dedup against it silently, putting the deadline back at the earlier instant.
      pushPackageFlag(harness, false);

      await settle();

      assert.equal(delayingLines(logEntries).length, 2, "the second withdrawal armed a fresh detach rather than riding the cancelled one");

      // Past the CANCELLED deadline: nothing fires. A stale timer would fire here with stillGone reading true (the flag is false again) and remove the accessory early.
      mock.timers.tick(31000);

      assert.equal(doorbell.packageCamera, instance, "the cancelled deadline passed without detaching anything");
      assert.ok(nvr.platform.accessories.includes(accessory), "the accessory survives past the deadline the flap cancelled");

      // The fresh deadline: the detach lands, exactly once.
      mock.timers.tick(29000);

      assert.equal(doorbell.packageCamera, null, "the flap-back deadline detached the package camera");
      assert.equal(apiCalls.filter((call) => (call.kind === "unregister") && call.accessories.includes(accessory)).length, 1, "the accessory unregistered exactly once");
    } finally {

      mock.timers.reset();
    }

    doorbell.cleanup();
    harness.controller.abort();
  });

  test("stillGone is absence-tolerant: a removed parent record reads as gone, so the fire detaches rather than throwing", async () => {

    const harness = await makeFamily();
    const { doorbell, logEntries, nvr, store } = harness;

    assert.ok(doorbell.packageCamera, "the package camera starts live");

    const accessory = doorbell.packageCamera.accessory as unknown as TestAccessory;

    mock.timers.enable({ apis: [ "Date", "setTimeout" ] });

    try {

      nvr.restabilizeController((ms) => mock.timers.tick(ms));
      pushPackageFlag(harness, false);

      await settle();

      assert.deepEqual(delayingLines(logEntries), [defaultDelayLine(accessory)], "the withdrawal armed the detach");

      // Unwind the doorbell's observers before removing the record - hygiene that isolates the armed fire from any live observer reaction. The predicate the fire runs
      // must hold its absence tolerance independently of any live instance. (Every doorbell selector hoists its plain id at spawn, including the chime-volume
      // selector, so the live instance does not throw against a removed record either.)
      doorbell.cleanup();

      await settle();

      // The parent record leaves the store entirely - the projection's config getter now throws, but the predicate reads through the selector against the captured
      // plain id and must simply report gone.
      store.removeCameraRecord(harness.cameraId);

      await settle();

      // The fire runs synchronously inside the tick and the timer registry's callback carries no catch of its own, so a throwing predicate propagates straight out of
      // this call. Reading true, the predicate lets the detach run - which is the correct outcome for a parent that is genuinely gone.
      assert.doesNotThrow(() => mock.timers.tick(60000), "the fire's predicate never throws against an absent parent");
      assert.equal(nvr.platform.accessories.includes(accessory), false, "an absent parent reads as gone, so the detach proceeded");
    } finally {

      mock.timers.reset();
    }

    harness.controller.abort();
  });

  test("a detach fire after the cascade already removed the accessory is a no-op - the platform array is never corrupted", async () => {

    const harness = await makeFamily();
    const { apiCalls, doorbell, logEntries, nvr } = harness;

    assert.ok(doorbell.packageCamera, "the package camera starts live");

    const accessory = doorbell.packageCamera.accessory as unknown as TestAccessory;

    // A bystander accessory seeded LAST in the platform array: the exact victim an unguarded splice(indexOf = -1) would silently delete.
    const bystander = makeTestAccessory("Bystander", "uuid:bystander");

    nvr.platform.accessories.push(bystander);

    mock.timers.enable({ apis: [ "Date", "setTimeout" ] });

    try {

      nvr.restabilizeController((ms) => mock.timers.tick(ms));
      pushPackageFlag(harness, false);

      await settle();

      assert.deepEqual(delayingLines(logEntries), [defaultDelayLine(accessory)], "the detach grace is armed");

      // The cascade arrives first: the parent's removal tears the family down and removes the package accessory through the same tail (production's
      // removeHomeKitDevice additionally cancels the pending timer - the fire below exercises the backstop for a fire already in flight).
      doorbell.cleanup();
      nvr.removeAccessoryFromHomeKit(accessory);

      const survivors = [...nvr.platform.accessories];
      const unregisters = apiCalls.filter((call) => call.kind === "unregister").length;

      // The package flag is still false, so this fire finds stillGone TRUE and genuinely runs the detach. What makes it harmless is the detach's own absent-target
      // guard: the live instance is already gone and the cached accessory is no longer on the platform, so it reaches no removal at all.
      assert.doesNotThrow(() => mock.timers.tick(60000), "the fire against an already-removed target never throws");
      assert.deepEqual(nvr.platform.accessories, survivors, "the fire removed nothing further");
      assert.equal(apiCalls.filter((call) => call.kind === "unregister").length, unregisters, "no second unregister was recorded for the already-removed accessory");
      assert.ok(nvr.platform.accessories.includes(bystander), "the bystander - the splice(-1) victim of an unguarded tail - survives");
    } finally {

      mock.timers.reset();
    }

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
    assert.equal(mqtt.published.filter((entry) => (entry.topic === PARENT_MAC + "/motion") && (entry.payload === "false")).length, 0,
      "no premature terminal reset is published while the parent's motion is live");

    // Teardown hygiene: clear the parent's real reset timer so nothing outlives the test (a parent-id clear sweeps everything, which is exactly right here).
    nvr.events.clearEventTimersForDevice(PARENT_MAC);
    doorbell.cleanup();
    harness.controller.abort();
  });
});
