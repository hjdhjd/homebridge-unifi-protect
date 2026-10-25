/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * package-defer-create.test.ts: The package camera's defer-create discipline - stream creation waits for the real package channel.
 *
 * This suite constructs a real doorbell-plus-package family against a controller that has NOT yet provisioned the package channel - the provisioning window a
 * just-adopted doorbell sits in - and pins the deferral contract: no streaming delegate is created and no HomeKit camera controller is registered for the package
 * until the channel exists, the deferral is narrated to the user exactly once at construction, and the package-channel observer then builds the stream from the
 * REAL channel (the golden-master advertised list) the moment the controller provisions it. The post-build rows pin parent parity: a dimension change wakes the
 * observer and returns at the gate that makes a re-derive safe to repeat (the advertised list stays frozen until a restart), and a channel-list rebuild with
 * identical package-channel dimensions never wakes the observer at all - the computed-primitive selector's value dedup is the change detection.
 */
import { G6_PRO_ENTRY_CHANNELS, PACKAGE_FIXTURES } from "../../camera.fixtures.ts";
import { Service, TestStateStore, controllerEvents, makeProtectState, makeTestAccessory } from "../../testing.helpers.ts";
import { TestCameraProjection, makeCameraConfig } from "../testing.helpers.ts";
import type { TestProtectAccessory, TestStreamingDelegateFactory, TestTimeshiftSupervisor } from "../../testing.helpers.ts";
import { after, before, describe, test } from "node:test";
import { formatLogEntry, logCount, settle } from "homebridge-plugin-utils/testing";
import type { Camera } from "unifi-protect";
import type { ObserverWakePayload } from "../../diagnostics.ts";
import { ProtectCamera } from "./camera.ts";
import type { ProtectNvr } from "../../nvr/nvr.ts";
import type { TestLogEntry } from "homebridge-plugin-utils/testing";
import type { TestProtectNvr } from "../../nvr/testing.helpers.ts";
import assert from "node:assert/strict";
import diagnosticsChannel from "node:diagnostics_channel";
import { makeTestNvr } from "../../nvr/testing.helpers.ts";

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
  let logEntries: readonly TestLogEntry[];
  let store: TestStateStore;

  // Count the user-facing deferral narrations logged so far.
  function deferralLineCount(): number {

    return logCount(logEntries, "info", DEFERRAL_FRAGMENT);
  }

  // The package camera's accessory, asserted live.
  function packageAccessory(): TestProtectAccessory {

    assert.ok(doorbell.packageCamera, "the package camera instance is live");

    return doorbell.packageCamera.accessory as unknown as TestProtectAccessory;
  }

  before(async () => {

    diagnosticsChannel.subscribe("hbup:observer:wake", onWake);

    const cameraConfig = makeCameraConfig({ channels: CHANNELS_WITHOUT_PACKAGE, featureFlags: { hasPackageCamera: true, isDoorbell: true }, name: "Front Door" });

    cameraId = cameraConfig.id;
    store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));

    let nvr: TestProtectNvr;

    ({ controller: harnessController, factory, logEntries, nvr } = makeTestNvr({ store }));

    doorbell = new ProtectCamera(nvr as unknown as ProtectNvr, makeTestAccessory("Front Door", "74ACB9000001"),
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
    assert.equal(controllerEvents(accessory).length, 0, "no HomeKit camera controller was registered on the package accessory");

    // The accessory itself is fully functional in the meantime.
    assert.ok(accessory.getService(Service.MotionSensor), "the package motion sensor is configured during the window");
    assert.equal(deferralLineCount(), 1, "the deferral is narrated to the user exactly once, at construction");
  });

  test("the family wires twenty-three observers: nineteen doorbell plus the package's four, including the package-channel observer", () => {

    // The doorbell-attached camera carries the always-armed isDoorbell observer, the bare-motion lastMotion observer, the capability-reconcile featureFlags
    // observer, the Access-lock supportUnlock observer, and the HomeKit Secure Video eligibility observer on top of its base set, and the package camera carries its
    // own bespoke set - the assertion below holds the exact tally fixed.
    assert.equal(store.observerCount, 23, "nineteen doorbell observers plus the package's four (name, firmware, state, and the package channel)");
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
    assert.deepEqual(controllerEvents(accessory).map((event) => event.kind), ["configure"], "exactly one controller registration, after the deferral");
    assert.equal(doorbell.packageCamera?.stream, packageCreate.delegate, "the package camera holds the delegate it built");

    // The success is silent: the construction-time narration remains the only deferral line.
    assert.equal(deferralLineCount(), 1, "the observer's successful re-attempt narrates nothing further");
  });

  test("a post-build dimension change wakes the observer and returns at the build-once gate - the advertised list stays frozen, parent parity", async () => {

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
    assert.equal(factory.createCalls.length, 2, "no second delegate is ever created - the build-once gate returned");
    assert.equal(controllerEvents(accessory).length, 1, "no second controller registration");
  });

  test("a channel-list rebuild with identical package-channel dimensions never wakes the observer - the computed primitive dedups it", async () => {

    const pushBaseline = wakeLog.length;
    const record = store.snapshot().cameras.get(cameraId);

    assert.ok(record, "the camera record is present");

    // A channel-list rebuild that moves a field OUTSIDE the package channel's dimensions: bitrate changes on every channel, so the parent's reference-keyed channels
    // observer wakes (re-deriving to the same result), but the package's computed primitive reads only width / height / fps and serializes to the same string, so the
    // value dedup keeps the package-channel observer parked. The moved field has to be a real change - the store reduces a rebuild that is merely a fresh set of
    // value-identical objects to no change at all, which would leave nothing awake to dedup against.
    store.pushCameraPatch(cameraId, { channels: record.channels.map((channel) => ({ ...channel, bitrate: channel.bitrate + 1 })) });

    await settle();

    const windowed = wakeLog.slice(pushBaseline);

    assert.equal(windowed.filter((wake) => wake.key === "camera.packageChannel").length, 0, "the identical-shape rebuild never wakes the package-channel observer");
    assert.ok(windowed.some((wake) => wake.key === "camera.channels"), "the parent's reference-keyed channels observer woke, proving the push itself was live");
    assert.equal(deferralLineCount(), 1, "the construction-time narration remains the only deferral line across every push");
  });

  test("family cleanup unwinds all twenty-three observers", async () => {

    const accessory = packageAccessory();

    doorbell.cleanup();

    await settle();

    assert.equal(store.observerCount, 0, "every family observer deregistered");
    assert.equal(controllerEvents(accessory).filter((event) => event.kind === "remove").length, 1,
      "the package's late-registered controller was unregistered at cleanup");
  });
});

/* The channel-present-at-adoption arm of the same discipline: a doorbell whose package channel exists in the INITIAL fixture never defers at all. These rows pin the
 * properties the deferring arm above cannot see - that the package's whole build completes inside the constructor's own call frame, that its supervisor is kicked
 * exactly once there, and that the construction gate (not the channel) is what declines a build on a controller already shutting down.
 */
describe("package camera create-at-adoption (the channel-present arm)", () => {

  const adoptionControllers: AbortController[] = [];

  after(() => {

    for(const controller of adoptionControllers) {

      controller.abort();
    }
  });

  // Construct a real doorbell-plus-package family whose package channel is present from the start, optionally against a controller that has already entered shutdown.
  // Nothing is settled here: the caller decides whether to assert on the constructor's own call frame or after the microtasks drain.
  function constructFamily(phase?: TestProtectNvr["phase"]): { doorbell: ProtectCamera; factory: TestStreamingDelegateFactory; logEntries: readonly TestLogEntry[] } {

    const cameraConfig = makeCameraConfig({ channels: G6_PRO_ENTRY_CHANNELS, featureFlags: { hasPackageCamera: true, isDoorbell: true }, name: "Side Door" });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { controller, factory, logEntries, nvr } = makeTestNvr({ store });

    adoptionControllers.push(controller);

    if(phase) {

      nvr.phase = phase;
    }

    const doorbell = new ProtectCamera(nvr as unknown as ProtectNvr, makeTestAccessory("Side Door", "74ACB9000002"),
      new TestCameraProjection(cameraConfig.id, store) as unknown as Camera);

    return { doorbell, factory, logEntries };
  }

  /* The same-tick pin. The package's derivation is synchronous, so its whole derive-narrate-create-register chain runs inside the constructor's call frame - which is
   * what lets configureDevice read the outcome off this.stream immediately and narrate a deferral only when one is real. We assert BEFORE any await: an await introduced
   * anywhere in the package's construction chain (an async derivation, an unconditional await in the capability's reconcile) pushes the registration onto a later
   * microtask and leaves this RED, and the narration arm goes RED alongside it because the outcome check would then read a stream that does not exist yet.
   */
  test("with the channel present at adoption, the package registers its controller inside the constructor's call frame and narrates no deferral", async () => {

    const { doorbell, factory, logEntries } = constructFamily();

    // Read synchronously - no settle, no await - so this observes the state the constructor itself left behind.
    const accessory = doorbell.packageCamera?.accessory as unknown as TestProtectAccessory | undefined;

    assert.ok(accessory, "the package camera was composed during construction");
    assert.equal(controllerEvents(accessory).filter((event) => event.kind === "configure").length, 1,
      "the package registered its HomeKit camera controller inside the constructor's own call frame");
    assert.equal(logEntries.filter((entry) => formatLogEntry(entry).includes(DEFERRAL_FRAGMENT)).length, 0,
      "a package whose channel is already provisioned narrates no deferral");

    // Exactly one delegate exists at this instant, and it is the PACKAGE'S. The parent's derivation is declared async, so even with every channel already RTSP-enabled
    // its result comes back as a promise the capability must await, landing the parent's build on a later microtask - the asymmetry this pin depends on, and the reason
    // the count is one rather than two.
    assert.equal(factory.createCalls.length, 1, "one delegate exists inside the constructor's call frame");
    assert.equal(factory.createCalls[0]?.camera, doorbell.packageCamera, "the synchronously-built delegate is the package's, not the parent's");

    await settle();

    doorbell.cleanup();

    await settle();
  });

  // The package's construction-time activation kick, mirroring the parent camera's: the capability's establishment wakes the supervisor right after it stands up the
  // controller, so the package's standing buffer establishes for its streaming arm independent of any recording demand.
  test("the package's construction kicks its own supervisor exactly once", async () => {

    const { doorbell, factory } = constructFamily();

    await settle();

    const packageCreate = factory.createCalls.find((call) => call.camera === doorbell.packageCamera);

    assert.ok(packageCreate, "the factory recorded a create for the package camera");

    const timeshift = packageCreate.delegate.timeshift as unknown as TestTimeshiftSupervisor;

    assert.ok(timeshift, "the factory installed a timeshift double on the package's delegate");
    assert.equal(timeshift.reconcileCalls, 1, "the package's establishment kicked its supervisor exactly once at construction");

    doorbell.cleanup();

    await settle();
  });

  /* The construction gate on the package, with the channel PRESENT so the gate is the only thing that can decline. The deferring suite above cannot pin this: a package
   * with no channel builds nothing for a reason that has nothing to do with the controller's phase. Here the derivation succeeds and the build still does not happen.
   */
  test("a package whose controller has begun shutting down builds nothing, though its derivation succeeds", async () => {

    const { doorbell, factory } = constructFamily("shuttingDown");

    await settle();

    const packageCamera = doorbell.packageCamera;

    assert.ok(packageCamera, "the package camera was composed even under shutdown");

    // The half that tells the two causes apart: the channel is there and the derivation answers with it, so nothing upstream of the gate declined.
    assert.ok(packageCamera.deriveAdvertisedStreams(), "the package's derivation yields an advertised surface - the channel is present");

    assert.equal(factory.createCalls.length, 0, "no delegate was built for either camera on a shutting-down controller");
    assert.equal(controllerEvents(packageCamera.accessory).length, 0, "no controller was registered on the package accessory");
    assert.equal(packageCamera.stream, undefined, "the package camera holds no delegate");

    doorbell.cleanup();

    await settle();
  });

  /* The package advertises the recording audio stand-in. Its derivation is synchronous by contract, so it runs no probe: the one livestream the shared projection
   * records is the parent's probe, handed to the parent's delegate, and the package's delegate is handed no format and no probe. A package recording whose stream
   * differs from the stand-in is transcoded to it at recording time.
   */
  test("the package's derivation runs no probe and hands its delegate no format, so the stand-in is advertised", async () => {

    const cameraConfig = makeCameraConfig({ channels: G6_PRO_ENTRY_CHANNELS, featureFlags: { hasPackageCamera: true, isDoorbell: true }, name: "Back Door" });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { controller, factory, nvr } = makeTestNvr({ store });
    const projection = new TestCameraProjection(cameraConfig.id, store);

    adoptionControllers.push(controller);

    const doorbell = new ProtectCamera(nvr as unknown as ProtectNvr, makeTestAccessory("Back Door", "74ACB9000003"),
      projection as unknown as Camera);

    await settle();

    const packageCreate = factory.createCalls.find((call) => call.camera === doorbell.packageCamera);
    const parentCreate = factory.createCalls.find((call) => call.camera === doorbell);

    assert.ok(packageCreate, "the factory recorded a create for the package camera");
    assert.equal(packageCreate.audioFormat, null, "the package's delegate was handed no format, so it advertises the stand-in");
    assert.equal(packageCreate.probe, null, "the package's delegate was handed no probe");
    assert.equal(projection.livestreamCalls.length, 1, "the shared projection opened one livestream, the parent's probe");
    assert.equal(parentCreate?.probe?.subscription, projection.livestreamCalls[0]?.subscription, "that livestream is the parent's probe, handed to the parent");

    doorbell.cleanup();

    await settle();
  });
});
