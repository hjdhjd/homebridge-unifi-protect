/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * package-defer-create.test.ts: The package camera's defer-create discipline - stream creation waits for the real package channel.
 *
 * This suite constructs a real doorbell-plus-package family against a controller that has NOT yet provisioned the package channel - the provisioning window a
 * just-adopted doorbell sits in - and pins the deferral contract: no streaming delegate is created and no HomeKit camera controller is registered for the package
 * until the channel exists, the deferral is narrated to the user exactly once at construction, and the package-channel observer then builds the stream from the
 * REAL channel (the golden-master advertised list) the moment the controller provisions it. The post-build rows pin parent parity: a dimension change wakes the
 * observer and returns at the idempotency gate (the advertised list stays frozen until a restart), and a channel-list rebuild with identical package-channel
 * dimensions never wakes the observer at all - the computed-primitive selector's value dedup is the change detection.
 */
import { G6_PRO_ENTRY_CHANNELS, PACKAGE_FIXTURES } from "../../camera.fixtures.ts";
import { Service, TestCameraProjection, TestStateStore, makeCameraConfig, makeProtectState, makeTestAccessory, makeTestNvr, settle } from "../../testing.helpers.ts";
import type { TestAccessory, TestLogEntry, TestProtectNvr } from "../../testing.helpers.ts";
import { after, before, describe, test } from "node:test";
import type { Camera } from "unifi-protect";
import type { ObserverWakePayload } from "../../diagnostics.ts";
import type { ProtectAccessory } from "../../types.ts";
import { ProtectCamera } from "./camera.ts";
import type { ProtectNvr } from "../../nvr/nvr.ts";
import type { TestStreamingDelegateFactory } from "../../testing.helpers.ts";
import assert from "node:assert/strict";
import diagnosticsChannel from "node:diagnostics_channel";

// The deferral sentence's distinguishing fragment, used to count the user-facing narration exactly once.
const DEFERRAL_FRAGMENT = "provisioning the package camera channel";

// The provisioning-window channel set: the G6 Pro Entry's three primary channels, with the package channel deliberately absent.
const CHANNELS_WITHOUT_PACKAGE = G6_PRO_ENTRY_CHANNELS.filter((channel) => channel.name !== "Package Camera");

describe("package camera defer-create (BC1)", () => {

  const wakeLog: ObserverWakePayload[] = [];
  const onWake = (message: unknown): void => { wakeLog.push(message as ObserverWakePayload); };

  let cameraId = "";
  let doorbell: ProtectCamera;
  let factory: TestStreamingDelegateFactory;
  let harnessController: AbortController | undefined;
  let logEntries: TestLogEntry[];
  let store: TestStateStore;

  // Count the user-facing deferral narrations logged so far.
  function deferralLineCount(): number {

    return logEntries.filter((entry) => (entry.level === "info") && entry.formatted.includes(DEFERRAL_FRAGMENT)).length;
  }

  // The package camera's accessory, asserted live.
  function packageAccessory(): TestAccessory {

    assert.ok(doorbell.packageCamera, "the package camera instance is live");

    return doorbell.packageCamera.accessory as unknown as TestAccessory;
  }

  before(async () => {

    diagnosticsChannel.subscribe("hbup:observer:wake", onWake);

    const cameraConfig = makeCameraConfig({ channels: CHANNELS_WITHOUT_PACKAGE, featureFlags: { hasPackageCamera: true, isDoorbell: true }, name: "Front Door" });

    cameraId = cameraConfig.id;
    store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));

    let nvr: TestProtectNvr;

    ({ controller: harnessController, factory, logEntries, nvr } = makeTestNvr({ store }));

    doorbell = new ProtectCamera(nvr as unknown as ProtectNvr, makeTestAccessory("Front Door", "uuid:74ACB9000001") as unknown as ProtectAccessory,
      new TestCameraProjection(cameraId, store) as unknown as Camera);

    await settle();
  });

  after(() => {

    harnessController?.abort();
    diagnosticsChannel.unsubscribe("hbup:observer:wake", onWake);
  });

  test("with no package channel, the accessory exists but no delegate is created and no controller is registered - and the deferral is narrated exactly once", () => {

    const accessory = packageAccessory();

    // The parent doorbell's own stream is the only delegate in existence; the package camera deferred.
    assert.equal(factory.createCalls.length, 1, "exactly one delegate exists - the parent's");
    assert.equal(factory.createCalls[0]?.camera, doorbell, "the one delegate belongs to the parent doorbell");
    assert.equal(doorbell.packageCamera?.stream, undefined, "the package camera holds no stream during the provisioning window");
    assert.equal(accessory.controllerEvents.length, 0, "no HomeKit camera controller was registered on the package accessory");

    // The accessory itself is fully functional in the meantime.
    assert.ok(accessory.getService(Service.MotionSensor), "the package motion sensor is configured during the window");
    assert.equal(deferralLineCount(), 1, "the deferral is narrated to the user exactly once, at construction");
  });

  test("the family wires twenty-two observers: eighteen doorbell plus the package's four, including the package-channel observer", () => {

    // The doorbell-attached camera carries eighteen (the always-armed isDoorbell observer, the bare-motion lastMotion observer, the capability-reconcile featureFlags
    // observer, and the Access-lock supportUnlock observer all joined the set), and the package camera its bespoke four.
    assert.equal(store.observerCount, 22, "eighteen doorbell observers plus the package's four (name, firmware, state, and the package channel)");
  });

  test("the channel's arrival wakes the package-channel observer and builds the stream from the REAL channel, silently", async () => {

    const pushBaseline = wakeLog.length;

    // The controller finishes provisioning: the full channel set, package channel included, lands in one patch.
    store.pushCameraPatch(cameraId, { channels: G6_PRO_ENTRY_CHANNELS });

    await settle();

    const accessory = packageAccessory();
    const packageFixture = PACKAGE_FIXTURES.find((fixture) => fixture.model === "G6 Pro Entry Package");

    assert.ok(packageFixture, "the golden-master corpus carries the G6 Pro Entry package fixture");
    assert.ok(wakeLog.slice(pushBaseline).some((wake) => (wake.accessoryId === accessory.UUID) && (wake.key === "camera.packageChannel")),
      "the package-channel observer woke on the channel's arrival");

    // One create, against the real channel's golden-master advertised list, and one ordered controller registration.
    assert.equal(factory.createCalls.length, 2, "the package delegate is the second and final create");

    const packageCreate = factory.createCalls[1];

    assert.ok(packageCreate, "the package create call was recorded");
    assert.equal(packageCreate.camera, doorbell.packageCamera, "the delegate was created for the package camera instance");
    assert.deepEqual(packageCreate.resolutions, packageFixture.expected, "the advertised list derives from the REAL channel - the golden-master package expectation");
    assert.deepEqual(accessory.controllerEvents.map((event) => event.kind), ["configure"], "exactly one controller registration, after the deferral");
    assert.equal(doorbell.packageCamera?.stream, packageCreate.delegate, "the package camera holds the delegate it built");

    // The success is silent: the construction-time narration remains the only deferral line.
    assert.equal(deferralLineCount(), 1, "the observer's successful re-attempt narrates nothing further");
  });

  test("a post-build dimension change wakes the observer and returns at the idempotency gate - the advertised list stays frozen, parent parity", async () => {

    const pushBaseline = wakeLog.length;
    const record = store.snapshot().cameras.get(cameraId);

    assert.ok(record, "the camera record is present");

    // The package channel changes shape after the build (a hypothetical firmware-side reconfiguration).
    const reshaped = record.channels.map((channel) => (channel.name === "Package Camera") ? { ...channel, fps: 2, height: 960, width: 1280 } : channel);

    store.pushCameraPatch(cameraId, { channels: reshaped });

    await settle();

    const accessory = packageAccessory();

    assert.ok(wakeLog.slice(pushBaseline).some((wake) => (wake.accessoryId === accessory.UUID) && (wake.key === "camera.packageChannel")),
      "the dimension change wakes the package-channel observer");
    assert.equal(factory.createCalls.length, 2, "no second delegate is ever created - the idempotency gate returned");
    assert.equal(accessory.controllerEvents.length, 1, "no second controller registration");
  });

  test("a channel-list rebuild with identical package-channel dimensions never wakes the observer - the computed primitive dedups it", async () => {

    const pushBaseline = wakeLog.length;
    const record = store.snapshot().cameras.get(cameraId);

    assert.ok(record, "the camera record is present");

    // A fresh channels array of fresh channel objects with identical values: the parent's reference-keyed channels observer wakes (and idempotently re-derives),
    // but the package's computed primitive serializes to the same string, so the value dedup keeps the package-channel observer parked.
    store.pushCameraPatch(cameraId, { channels: record.channels.map((channel) => ({ ...channel })) });

    await settle();

    const windowed = wakeLog.slice(pushBaseline);

    assert.equal(windowed.filter((wake) => wake.key === "camera.packageChannel").length, 0, "the identical-shape rebuild never wakes the package-channel observer");
    assert.ok(windowed.some((wake) => wake.key === "camera.channels"), "the parent's reference-keyed channels observer woke, proving the push itself was live");
    assert.equal(deferralLineCount(), 1, "the construction-time narration remains the only deferral line across every push");
  });

  test("family cleanup unwinds all twenty-two observers", async () => {

    const accessory = packageAccessory();

    doorbell.cleanup();

    await settle();

    assert.equal(store.observerCount, 0, "every family observer deregistered");
    assert.equal(accessory.removeControllerCalls.length, 1, "the package's late-registered controller was unregistered at cleanup");
  });
});
