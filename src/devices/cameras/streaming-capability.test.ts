/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * streaming-capability.test.ts: The controller-side members of the camera family's streaming capability.
 *
 * The NVR reaches into every camera's streaming arm from several walks - the reboot-recovery probesize reset, the disconnect release, and the scheduled-reboot deferral
 * gate among them - and each walk speaks to the capability through one intent-named member rather than reaching into the delegate itself. This suite pins those members
 * against a REAL constructed doorbell-plus-package family: the release is exactly the pooled-subscription pair and deliberately NOT the full teardown (no recording-off,
 * no controller removal), the reboot recovery reaches parent and package alike, and the recording-transmitting gate answers safely at every level of absence.
 *
 * It also carries the non-creating-getter pin. A walk that constructed a capability merely by looking at one would build machinery for cameras it was only meant to
 * inspect, so the harness NVR counts every construction it is asked for and the pin asserts a read leaves that count alone.
 */
import type { TestAccessory, TestRecordingDelegate, TestStreamingDelegate, TestStreamingDelegateFactory, TestTimeshiftSupervisor } from "../../testing.helpers.ts";
import { TestCameraProjection, makeCameraConfig } from "../testing.helpers.ts";
import { TestStateStore, makeProtectState, makeRecordingDelegateDouble, makeTestAccessory } from "../../testing.helpers.ts";
import { after, describe, test } from "node:test";
import type { Camera } from "unifi-protect";
import { G6_PRO_ENTRY_CHANNELS } from "../../camera.fixtures.ts";
import type { ProtectAccessory } from "../../types.ts";
import { ProtectCamera } from "./camera.ts";
import type { ProtectNvr } from "../../nvr/nvr.ts";
import type { StreamingDelegate } from "../../media/stream-delegate.ts";
import type { TestProtectNvr } from "../../nvr/testing.helpers.ts";
import assert from "node:assert/strict";
import { makeTestNvr } from "../../nvr/testing.helpers.ts";
import { settle } from "homebridge-plugin-utils/testing";

// Every harness controller this file opens, aborted once at the end so no observe loop outlives the suite.
const openControllers: AbortController[] = [];

// The assembled family under test: a real doorbell with a real package camera, both holding delegates the stub factory returned, plus the harness handles the
// assertions read through.
interface Family {

  cameraId: string;
  doorbell: ProtectCamera;
  factory: TestStreamingDelegateFactory;
  nvr: TestProtectNvr;
  store: TestStateStore;
}

// Construct a real doorbell-plus-package family whose package channel is present from the start, so BOTH cameras hold a delegate. A stream-less camera would satisfy
// most of the assertions below vacuously, so the two-delegate precondition is what gives them meaning.
async function makeFamily(channels = G6_PRO_ENTRY_CHANNELS): Promise<Family> {

  const cameraConfig = makeCameraConfig({ channels: channels, featureFlags: { hasPackageCamera: true, isDoorbell: true }, name: "Back Door" });
  const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
  const { controller, factory, nvr } = makeTestNvr({ store });

  openControllers.push(controller);

  const doorbell = new ProtectCamera(nvr as unknown as ProtectNvr, makeTestAccessory("Back Door", "uuid:streaming-capability") as unknown as ProtectAccessory,
    new TestCameraProjection(cameraConfig.id, store) as unknown as Camera);

  await settle();

  return { cameraId: cameraConfig.id, doorbell, factory, nvr, store };
}

// The delegate the factory returned for one specific host - named by identity rather than by position, so an assertion cannot drift onto the other camera's delegate.
function delegateFor(factory: TestStreamingDelegateFactory, host: ProtectCamera): TestStreamingDelegate {

  const call = factory.createCalls.find((candidate) => candidate.camera === host);

  assert.ok(call, "the factory recorded a create for this host");

  return call.delegate;
}

// The accessory behind a device, for the controller-registration assertions.
function accessoryOf(device: ProtectCamera): TestAccessory {

  return device.accessory as unknown as TestAccessory;
}

describe("the streaming capability's controller-side members", () => {

  after(() => {

    for(const controller of openControllers) {

      controller.abort();
    }
  });

  /* The disconnect walk's release. It is a strict SUBSET of the capability's own teardown, and the subset is the point: the connection is going away, not the camera, so
   * what must happen before the client is disposed is the release of the pooled livestream subscriptions - and nothing else. Turning HomeKit Secure Video recording off
   * here would fight a recording the reconnect will resume, and removing the controller would factory-reset the camera's HKSV configuration on every disconnect.
   */
  test("releaseForShutdown releases exactly the pooled machinery on parent and package, with no recording-off and no controller removal", async () => {

    const { doorbell, factory } = await makeFamily();

    assert.ok(doorbell.packageCamera, "the package camera was composed");

    const parentDelegate = delegateFor(factory, doorbell);
    const packageDelegate = delegateFor(factory, doorbell.packageCamera);

    // Arrange a live recording on each delegate, so a release that wrongly reached for the recording-off command would have something real to turn off.
    const parentHksv = makeRecordingDelegateDouble({ isRecording: true, isTransmitting: true });
    const packageHksv = makeRecordingDelegateDouble({ isRecording: true, isTransmitting: true });

    parentDelegate.hksv = parentHksv as unknown as StreamingDelegate["hksv"];
    packageDelegate.hksv = packageHksv as unknown as StreamingDelegate["hksv"];

    const parentTimeshift = parentDelegate.timeshift as unknown as TestTimeshiftSupervisor;
    const packageTimeshift = packageDelegate.timeshift as unknown as TestTimeshiftSupervisor;
    const parentShutdowns = parentDelegate.shutdownCalls;
    const packageShutdowns = packageDelegate.shutdownCalls;
    const parentTimeshiftShutdowns = parentTimeshift.shutdownCalls;
    const packageTimeshiftShutdowns = packageTimeshift.shutdownCalls;

    doorbell.streaming?.releaseForShutdown();
    doorbell.packageCamera.streaming?.releaseForShutdown();

    // The live consumers, released exactly once each on each camera.
    assert.equal(parentDelegate.shutdownCalls - parentShutdowns, 1, "the parent's own delegate was shut down exactly once");
    assert.equal(packageDelegate.shutdownCalls - packageShutdowns, 1, "the package's own delegate was shut down exactly once");
    assert.equal(parentTimeshift.shutdownCalls - parentTimeshiftShutdowns, 1, "the parent's timeshift supervision was shut down exactly once");
    assert.equal(packageTimeshift.shutdownCalls - packageTimeshiftShutdowns, 1, "the package's timeshift supervision was shut down exactly once");

    // The two things the release deliberately does NOT do. Widening it into the full teardown leaves both of these RED.
    assert.deepEqual(parentHksv.updateRecordingActiveCalls, [], "the parent's release issued no recording-off command");
    assert.deepEqual(packageHksv.updateRecordingActiveCalls, [], "the package's release issued no recording-off command");
    assert.equal(accessoryOf(doorbell).removeControllerCalls.length, 0, "the parent's controller stayed registered across the release");
    assert.equal(accessoryOf(doorbell.packageCamera).removeControllerCalls.length, 0, "the package's controller stayed registered across the release");
  });

  // The machinery-less arm. A camera whose derivation never yielded holds a capability but no delegate, and the walk must pass over it silently rather than throw - the
  // controller walks every camera it manages, including ones that never advertised a stream.
  test("releaseForShutdown on a capability that never built machinery is a silent no-op", async () => {

    // No channels at all, so the derivation returns nothing and the create half is never reached.
    const { doorbell, factory } = await makeFamily([]);

    assert.equal(factory.createCalls.length, 0, "no delegate was ever built for this camera");
    assert.ok(doorbell.streaming, "the camera still acquired its streaming capability on the construct pass");

    doorbell.streaming.releaseForShutdown();

    assert.equal(factory.createCalls.length, 0, "the release built nothing and threw nothing");
  });

  /* One capability per camera, no matter how many times the camera asks for it. The acquire accessor's whole body is a ??= assignment, which is what makes double
   * construction unrepresentable rather than merely unlikely - the construct pass, the capability reconcile, and every streaming observer each call it, and a
   * second construction would strand the first capability's delegate with a registered HomeKit controller nothing would ever release. Turning that ??= into a plain
   * assignment leaves this RED on the very first observer wake.
   *
   * The second assertion is the weaker companion: a controller-side walk reads the handle through the non-creating getter, and a read must not move the counter. Said
   * honestly, it cannot tell a getter that acquires apart from one that does not - every camera has already acquired by the time any walk can reach it, so the ??= hands
   * back the held capability either way. What it does guard is a future regression that makes acquisition lazy while the walks keep reading through a creating getter.
   */
  test("a camera constructs exactly one streaming capability across every acquire, and reading the handle constructs nothing", async () => {

    const { cameraId, doorbell, nvr, store } = await makeFamily();

    assert.equal(nvr.createStreamingCapabilityCalls, 2, "exactly two capabilities exist - the parent's and the package's");

    // One channel-list push that genuinely changes a field outside the advertised shape, so the streaming observers wake and call the acquire accessor again.
    const wakeStreamingObservers = async (): Promise<void> => {

      const record = store.snapshot().cameras.get(cameraId);

      assert.ok(record, "the camera record is present");

      store.pushCameraPatch(cameraId, { channels: record.channels.map((channel) => ({ ...channel, bitrate: channel.bitrate + 1 })) });

      await settle();
    };

    // Three sequential wakes, each settled before the next so every reconcile completes against a live capability.
    await wakeStreamingObservers();
    await wakeStreamingObservers();
    await wakeStreamingObservers();

    assert.equal(nvr.createStreamingCapabilityCalls, 2, "the repeated acquires converged on the capabilities that already existed");

    const constructions = nvr.createStreamingCapabilityCalls;

    // Read the handle the way every controller-side walk does, repeatedly.
    const reads: (boolean | undefined)[] = [];

    for(let read = 0; read < 3; read++) {

      reads.push(doorbell.streaming?.isRecordingTransmitting);
    }

    assert.deepEqual(reads, [ false, false, false ], "each read answered through the live capability");
    assert.equal(nvr.createStreamingCapabilityCalls, constructions, "reading the streaming handle constructed nothing");
  });

  // The reboot-recovery walk. Every controller reboot re-adopts and restarts each camera's stream from scratch, so the accumulated probesize self-tuning is stale on
  // both the parent and its package view - the endpoints iterator walks them together, and the capability answers for each.
  test("recoverFromControllerReboot winds the probesize self-tuning back on parent and package", async () => {

    const { doorbell, factory } = await makeFamily();

    assert.ok(doorbell.packageCamera, "the package camera was composed");

    const parentDelegate = delegateFor(factory, doorbell);
    const packageDelegate = delegateFor(factory, doorbell.packageCamera);

    assert.equal(parentDelegate.resetProbesizeOverrideCalls, 0, "nothing has reset the parent's probesize yet");
    assert.equal(packageDelegate.resetProbesizeOverrideCalls, 0, "nothing has reset the package's probesize yet");

    doorbell.streaming?.recoverFromControllerReboot();
    doorbell.packageCamera.streaming?.recoverFromControllerReboot();

    assert.equal(parentDelegate.resetProbesizeOverrideCalls, 1, "the parent's probesize self-tuning was wound back exactly once");
    assert.equal(packageDelegate.resetProbesizeOverrideCalls, 1, "the package's probesize self-tuning was wound back exactly once");
  });
});

describe("the streaming capability's recording-transmitting gate", () => {

  after(() => {

    for(const controller of openControllers) {

      controller.abort();
    }
  });

  /* The scheduled-reboot deferral gate reads this on every camera, so it has to answer at every level of absence: no capability machinery at all, machinery whose HKSV
   * delegate has not been configured (the resting production state - the stub's hksv is null), and a configured delegate in each transmit state. Dropping either
   * optional hop turns two of these rows into a throw rather than a false.
   */
  test("isRecordingTransmitting answers false through every level of absence and true only while transmitting", async () => {

    const streamless = await makeFamily([]);

    assert.ok(streamless.doorbell.streaming, "the stream-less camera still holds a capability");
    assert.equal(streamless.doorbell.streaming.isRecordingTransmitting, false, "no machinery reads as not transmitting");

    const { doorbell, factory } = await makeFamily();
    const delegate = delegateFor(factory, doorbell);

    assert.equal(delegate.hksv, null, "the delegate's recording arm is unconfigured, the resting production state");
    assert.equal(doorbell.streaming?.isRecordingTransmitting, false, "an unconfigured recording arm reads as not transmitting");

    const hksv: TestRecordingDelegate = makeRecordingDelegateDouble({ isTransmitting: false });

    delegate.hksv = hksv as unknown as StreamingDelegate["hksv"];

    assert.equal(doorbell.streaming.isRecordingTransmitting, false, "a configured but idle recording arm reads as not transmitting");

    hksv.isTransmitting = true;

    assert.equal(doorbell.streaming.isRecordingTransmitting, true, "a transmitting recording arm reads as transmitting");
  });

  /* The same member read on the package INSTANCE class. The deferral counts every camera view the controller manages, so a package has to answer this as reliably as
   * its parent does - and the package's capability is wired by its own path, which is what this arm holds against drift. What the count DOES with the answer is pinned
   * in the harness suite; this pins the answer itself on the package.
   */
  test("isRecordingTransmitting answers through the package camera's own capability", async () => {

    const { doorbell, factory } = await makeFamily();

    assert.ok(doorbell.packageCamera, "the package camera was composed");

    const packageDelegate = delegateFor(factory, doorbell.packageCamera);

    assert.equal(packageDelegate.hksv, null, "the package's recording arm is unconfigured, the resting production state");
    assert.equal(doorbell.packageCamera.streaming?.isRecordingTransmitting, false, "an unconfigured recording arm reads as not transmitting");

    const hksv: TestRecordingDelegate = makeRecordingDelegateDouble({ isTransmitting: false });

    packageDelegate.hksv = hksv as unknown as StreamingDelegate["hksv"];

    assert.equal(doorbell.packageCamera.streaming.isRecordingTransmitting, false, "a configured but idle recording arm reads as not transmitting");

    hksv.isTransmitting = true;

    assert.equal(doorbell.packageCamera.streaming.isRecordingTransmitting, true, "a transmitting recording arm reads as transmitting");
  });
});
