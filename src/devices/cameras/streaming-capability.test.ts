/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * streaming-capability.test.ts: The controller-side members of the camera family's streaming capability.
 *
 * The NVR reaches into every camera's streaming arm from several walks - the reboot-recovery probesize reset, the disconnect release, and the scheduled-reboot deferral
 * gate among them - and each walk speaks to the capability through one intent-named member rather than reaching into the delegate itself. This suite asserts those
 * members against a REAL constructed doorbell-plus-package family: the release is exactly the pooled-subscription pair and deliberately NOT the full teardown (no
 * recording-off, no controller removal), the reboot recovery reaches parent and package alike, and the recording-transmitting gate answers safely at every level of
 * absence.
 *
 * It also carries the non-creating-getter assertion. A walk that constructed a capability merely by looking at one would build machinery for cameras it was only meant
 * to inspect, so the harness NVR counts every construction it is asked for and the assertion proves a read leaves that count alone.
 */
import { AMCREST_INIT_SEGMENT, G2_PRO_CHANNELS, G6_PRO_ENTRY_CHANNELS } from "../../camera.fixtures.ts";
import { Characteristic, Service, TestStateStore, controllerEvents, makeProtectState, makeRecordingDelegateDouble, makeTestAccessory,
  writesTo } from "../../testing.helpers.ts";
import { PROTECT_LIVESTREAM_ACTIVE_TOLERANCE_MS, PROTECT_LIVESTREAM_IDLE_TOLERANCE_MS } from "../../settings.ts";
import type { TestCameraFeatureFlags, TestLivestreamSubscription } from "../testing.helpers.ts";
import { TestCameraProjection, makeCameraConfig } from "../testing.helpers.ts";
import type { TestProtectAccessory, TestRecordingDelegate, TestStreamingDelegate, TestStreamingDelegateFactory, TestTimeshiftSupervisor } from "../../testing.helpers.ts";
import { after, describe, test } from "node:test";
import { assertNoUnhandledRejections, expectAt, logCount, settle } from "homebridge-plugin-utils/testing";
import { makeTestNvr, restoreAccessories } from "../../nvr/testing.helpers.ts";
import { ACCESSORY_SAVE_WINDOW_MS } from "homebridge-plugin-utils";
import type { Camera } from "unifi-protect";
import { ProtectCamera } from "./camera.ts";
import { ProtectClient } from "unifi-protect";
import type { ProtectNvr } from "../../nvr/nvr.ts";
import { ProtectReservedNames } from "../../types.ts";
import type { StreamingDelegate } from "../../media/stream-delegate.ts";
import type { TestLogEntry } from "homebridge-plugin-utils/testing";
import type { TestProtectNvr } from "../../nvr/testing.helpers.ts";
import assert from "node:assert/strict";
import { configured } from "../device-base.ts";

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

  const doorbell = configured(new ProtectCamera(nvr as unknown as ProtectNvr, makeTestAccessory("Back Door", cameraConfig.mac),
    new TestCameraProjection(cameraConfig.id, store) as unknown as Camera));

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
function accessoryOf(device: ProtectCamera): TestProtectAccessory {

  return device.accessory as unknown as TestProtectAccessory;
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
    assert.equal(controllerEvents(accessoryOf(doorbell)).filter((event) => event.kind === "remove").length, 0,
      "the parent's controller stayed registered across the release");
    assert.equal(controllerEvents(accessoryOf(doorbell.packageCamera)).filter((event) => event.kind === "remove").length, 0,
      "the package's controller stayed registered across the release");
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
   * its parent does - and the package's capability is wired by its own path, which is what this arm holds against drift. What the count DOES with the answer is
   * asserted in the harness suite; this asserts the answer itself on the package.
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

/* The derivation's recording-audio probe. Before a camera's first controller is built, its derivation opens the livestream the buffer will run on and reads the
 * recording audio format from the stream's init, then hands the subscription to the delegate for the buffer to adopt. These rows hold the probe's gate term by term,
 * the subscription's ownership across every way a build can fail to happen, the one line an unread stream earns, and the save a build asks for once it registers the
 * controller. Each camera is a real ProtectCamera over the projection double, whose livestream records every call with the subscription double it answered.
 */
describe("the derivation's recording-audio probe", () => {

  const STAND_IN_LINE = "Unable to read this camera's livestream audio format before publishing it to HomeKit.";

  // A real camera under the given options, its construction started but not settled, so a row can land an event before the derivation finishes, plus the handles the
  // rows read. The configure hook runs before construction, with the accessory, so a row can seed what a restart restores from the accessory cache.
  function constructCamera(options: { configure?: (projection: TestCameraProjection, nvr: TestProtectNvr, accessory: TestProtectAccessory) => void;
    featureFlags?: Partial<TestCameraFeatureFlags>; userOptions?: string[]; } = {}): { accessory: TestProtectAccessory; camera: ProtectCamera; cameraId: string;
    factory: TestStreamingDelegateFactory; logEntries: readonly TestLogEntry[]; nvr: TestProtectNvr; projection: TestCameraProjection; store: TestStateStore; } {

    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: options.featureFlags, name: "Driveway" });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { controller, factory, logEntries, nvr } = makeTestNvr({ store, userOptions: options.userOptions });
    const projection = new TestCameraProjection(cameraConfig.id, store);
    const accessory = makeTestAccessory("Driveway", cameraConfig.mac);

    openControllers.push(controller);
    options.configure?.(projection, nvr, accessory);

    const camera = configured(new ProtectCamera(nvr as unknown as ProtectNvr, accessory, projection as unknown as Camera));

    return { accessory, camera, cameraId: cameraConfig.id, factory, logEntries, nvr, projection, store };
  }

  // The number of times the camera said its stream could not be read.
  const standInLines = (entries: readonly TestLogEntry[]): number => logCount(entries, "info", STAND_IN_LINE);

  // The subscriptions the probe opened that nothing has disposed.
  const live = (projection: TestCameraProjection): TestLivestreamSubscription[] => projection.livestreamCalls.map((call) => call.subscription).
    filter((subscription) => !subscription.disposed);

  after(() => {

    for(const controller of openControllers) {

      controller.abort();
    }
  });

  test("a probe opens the buffer's channel with the recording urgency, and the format and the probe reach the factory", async () => {

    const { camera, factory, projection } = constructCamera({ configure: (projection) => {

      projection.livestreamDescription = ProtectClient.describeInitSegment(AMCREST_INIT_SEGMENT);
    } });

    await settle();

    assert.equal(projection.livestreamCalls.length, 1, "the derivation opened exactly one livestream");

    const call = expectAt(projection.livestreamCalls, 0, "the probe's livestream call");
    const substrate = camera.selectSubstrateChannel();

    assert.ok(substrate, "the camera selects a substrate channel");
    assert.deepEqual(call.options.source, { channel: substrate.channel.id, type: "channel" }, "the probe opened the channel the buffer selects");

    const created = expectAt(factory.createCalls, 0, "the delegate the derivation built");

    assert.deepEqual(created.audioFormat, { channels: 1, codec: "aac", sampleRate: 8000 }, "the factory was handed the Amcrest's audio format");
    assert.equal(created.probe?.subscription, call.subscription, "the factory was handed the probe's own subscription for the buffer to adopt");
    assert.equal(call.subscription.disposed, false, "the handed-on subscription is still open");

    // The urgency closure is the recording's: the idle tolerance while nothing transmits, and the active one once the delegate's recording arm transmits.
    const urgency = call.options.urgency;

    assert.ok(urgency, "the probe handed the pool an urgency closure");
    assert.equal(urgency(), PROTECT_LIVESTREAM_IDLE_TOLERANCE_MS, "the probe's urgency reads idle while no recording transmits");

    created.delegate.hksv = makeRecordingDelegateDouble({ isTransmitting: true }) as unknown as StreamingDelegate["hksv"];

    assert.equal(urgency(), PROTECT_LIVESTREAM_ACTIVE_TOLERANCE_MS, "the probe's urgency reads active while the recording transmits");
  });

  test("the gate: no probe for a camera that cannot back HomeKit Secure Video, nor for one whose buffer the RTSP-debug adapter feeds", async () => {

    const ineligible = constructCamera({ featureFlags: { hasMotionDetection: false } });

    await settle();

    assert.equal(ineligible.camera.isHksvCapable, false, "the vacuity guard: the camera cannot back HomeKit Secure Video");
    assert.equal(ineligible.projection.livestreamCalls.length, 0, "no probe for a camera with no recording arm");
    assert.equal(ineligible.factory.createCalls.length, 1, "the camera still built its controller");
    assert.equal(standInLines(ineligible.logEntries), 0, "an unmet gate term says nothing");

    const debug = constructCamera({ userOptions: ["Enable.Debug.Video.Timeshift.UseRtsp"] });

    await settle();

    assert.equal(debug.camera.selectSubstrateChannel()?.channel.isRtspEnabled, true, "the vacuity guard: the substrate channel is RTSP-enabled");
    assert.equal(debug.projection.livestreamCalls.length, 0, "no probe when the RTSP-debug adapter would feed the buffer");
    assert.equal(standInLines(debug.logEntries), 0, "an unmet gate term says nothing");
  });

  test("an unreachable camera advertises the stand-in and says so once, opening nothing", async () => {

    const { camera, factory, logEntries, projection } = constructCamera({ configure: (_projection, nvr) => {

      nvr.client.connection.isHealthy = false;
    } });

    await settle();
    await camera.streaming?.reconcile();

    assert.equal(projection.livestreamCalls.length, 0, "an unreachable camera opens no livestream");
    assert.equal(expectAt(factory.createCalls, 0, "the delegate").audioFormat, null, "the factory was handed no format, so the stand-in is advertised");
    assert.equal(standInLines(logEntries), 1, "the stand-in line was said once, though the derivation ran again");
  });

  // Two derivations that both reach the stand-in path say the line once. The controller has begun shutting down, so the construction gate declines each build and no
  // delegate ever stands to turn the second derivation away ahead of the reachability term.
  test("two derivations that both reach the stand-in path before any delegate exists say the stand-in line once", async () => {

    const { camera, factory, logEntries, projection } = constructCamera({ configure: (_projection, nvr) => {

      nvr.client.connection.isHealthy = false;
      nvr.phase = "shuttingDown";
    } });

    await settle();
    await camera.streaming?.reconcile();

    assert.equal(camera.isHksvCapable, true, "the vacuity guard: the camera can back HomeKit Secure Video, so each derivation reaches the probe");
    assert.equal(camera.stream, undefined, "the vacuity guard: the construction gate declined every build, so no delegate stands");
    assert.equal(factory.createCalls.length, 0, "nothing was built");
    assert.equal(projection.livestreamCalls.length, 0, "an unreachable camera opens no livestream");
    assert.equal(standInLines(logEntries), 1, "the stand-in line was said once, though each derivation reached the stand-in path");
  });

  test("a stream that does not establish is released and advertises the stand-in with one line", async () => {

    const { factory, logEntries, projection } = constructCamera({ configure: (projection) => {

      projection.livestreamEstablishes = false;
    } });

    await settle();

    assert.equal(projection.livestreamCalls.length, 1, "the probe opened its livestream");
    assert.equal(live(projection).length, 0, "the subscription that never established was released");
    assert.equal(expectAt(factory.createCalls, 0, "the delegate").probe, null, "no probe reached the factory");
    assert.equal(standInLines(logEntries), 1, "the stand-in line was said once");
  });

  test("a stream with no audio track derives no format, says nothing, and keeps its probe for the buffer", async () => {

    const { factory, logEntries, projection } = constructCamera();

    await settle();

    const created = expectAt(factory.createCalls, 0, "the delegate");

    assert.equal(created.audioFormat, null, "a stream with no audio track derives no format");
    assert.ok(created.probe, "the probe still reached the factory for the buffer to adopt");
    assert.equal(live(projection).length, 1, "its subscription stays open");
    assert.equal(standInLines(logEntries), 0, "nothing is said, since a recording from it has no audio to mislabel");
  });

  test("a re-derive with the delegate built opens no probe", async () => {

    const { camera, projection } = constructCamera();

    await settle();

    assert.equal(projection.livestreamCalls.length, 1, "the first derivation probed once");

    await camera.streaming?.reconcile();
    await settle();

    assert.equal(projection.livestreamCalls.length, 1, "the re-derive with a controller in place opened nothing");
  });

  test("two derivations that overlap before the build leave one live subscription, the one the delegate was handed", async () => {

    const gate = Promise.withResolvers<undefined>();
    const { camera, factory, projection } = constructCamera({ configure: (projection) => {

      projection.livestreamGate = gate.promise;
    } });

    await settle();

    const second = camera.streaming?.reconcile();

    await settle();

    assert.equal(projection.livestreamCalls.length, 2, "both derivations opened a probe while the first was still waiting");

    gate.resolve(undefined);
    await second;
    await settle();

    assert.equal(factory.createCalls.length, 1, "exactly one delegate was built");
    assert.deepEqual(live(projection), [expectAt(factory.createCalls, 0, "the delegate").probe?.subscription], "the one live subscription is the delegate's");
  });

  test("a build the construction gate declines releases the probe", async () => {

    const gate = Promise.withResolvers<undefined>();
    const { factory, nvr, projection } = constructCamera({ configure: (projection) => {

      projection.livestreamGate = gate.promise;
    } });

    await settle();

    nvr.phase = "shuttingDown";
    gate.resolve(undefined);
    await settle();

    assert.equal(factory.createCalls.length, 0, "no delegate was built while the controller shuts down");
    assert.equal(projection.livestreamCalls.length, 1, "the probe had opened its livestream");
    assert.equal(live(projection).length, 0, "the declined build's probe was released");
  });

  /* The capability marks the accessory for a save once it hands HomeKit the controller, because the controller's services are part of what Homebridge's accessory cache
   * holds. Construction's own marks share one save window, and a window carries one save however many marks join it, so a controller mark inside that window could go
   * missing without the count moving. The probe is held at its gate until construction's window has closed, so the window the build opens counts the controller mark
   * alone. The camera is restored onto the bridge the way Homebridge restores a cached accessory, because the accessory persistence saves only an accessory the bridge
   * holds.
   */
  test("a camera's controller build marks the accessory for a save of its own once construction's save window has closed", async () => {

    const gate = Promise.withResolvers<undefined>();
    const { accessory, factory, nvr } = constructCamera({ configure: (projection, nvr, accessory) => {

      projection.livestreamGate = gate.promise;
      restoreAccessories(nvr, [accessory]);
    } });

    const saves = (): number => nvr.platform.api.calls.filter((call) => (call.kind === "update") && call.accessories.includes(accessory)).length;

    await settle();

    assert.equal(factory.createCalls.length, 0, "the vacuity guard: the derivation still waits on its probe");

    nvr.platform.clock.advance(ACCESSORY_SAVE_WINDOW_MS);

    const constructed = saves();

    gate.resolve(undefined);
    await settle();

    assert.equal(factory.createCalls.length, 1, "the probe settled and the controller was built");
    assert.deepEqual(controllerEvents(accessory).map((event) => event.kind), ["configure"], "the build registered the controller once, with no removal beside it");

    nvr.platform.clock.advance(ACCESSORY_SAVE_WINDOW_MS - 1);

    assert.equal(saves(), constructed, "nothing is saved while the build's window is open");

    nvr.platform.clock.advance(1);

    assert.equal(saves(), constructed + 1, "exactly one update names the camera once the build's window closes");
  });

  /* A camera removed while its probe waits has nothing left to configure. The operating-mode service is seeded with the camera details the way a restart restores it
   * from the accessory cache, so a camera-details pass run against the vanished record would act on it, and the row reads that each was left as it was.
   */
  test("a camera removed while its probe waits throws nothing, says nothing, builds nothing, leaves its cached camera details untouched, and leaves no live " +
    "subscription", async () => {

    await assertNoUnhandledRejections(async () => {

      const gate = Promise.withResolvers<undefined>();
      const details = [ Characteristic.CameraOperatingModeIndicator, Characteristic.NightVision ];
      const { accessory, cameraId, factory, logEntries, projection, store } = constructCamera({ configure: (projection, _nvr, accessory) => {

        projection.livestreamGate = gate.promise;

        const seeded = accessory.addService(Service.CameraOperatingMode, "Driveway");

        for(const characteristic of details) {

          seeded.getCharacteristic(characteristic);
        }
      } });

      await settle();

      store.removeCameraRecord(cameraId);
      gate.resolve(undefined);
      await settle();

      assert.equal(projection.livestreamCalls.length, 1, "the probe had opened its livestream");
      assert.equal(live(projection).length, 0, "the removed camera's probe was released");
      assert.equal(factory.createCalls.length, 0, "nothing was built for the removed camera");
      assert.equal(standInLines(logEntries), 0, "nothing was said");

      const operatingMode = accessory.getService(Service.CameraOperatingMode);

      assert.ok(operatingMode, "the seeded operating-mode service is on the accessory");

      for(const characteristic of details) {

        assert.equal(operatingMode.testCharacteristic(characteristic), true, "a cached camera detail is still on the service");
        assert.deepEqual(writesTo(accessory, operatingMode.getCharacteristic(characteristic)), [], "a cached camera detail was never written");
      }
    });
  });

  // The switches the construction tail stands up, each enabled by its option, with the subtype that names its service on the accessory. A plain camera's doorbell
  // trigger stands up the Doorbell service the mute switch requires, so a camera that is not a doorbell carries all of them.
  const constructionSwitches = [

    { label: "NVR recording switch for always", subtype: ProtectReservedNames.SWITCH_UFP_RECORDING_ALWAYS },
    { label: "NVR recording switch for detections", subtype: ProtectReservedNames.SWITCH_UFP_RECORDING_DETECTIONS },
    { label: "NVR recording switch for never", subtype: ProtectReservedNames.SWITCH_UFP_RECORDING_NEVER },
    { label: "status indicator light switch", subtype: ProtectReservedNames.SWITCH_STATUS_LED },
    { label: "doorbell trigger", subtype: ProtectReservedNames.SWITCH_DOORBELL_TRIGGER },
    { label: "doorbell mute switch", subtype: ProtectReservedNames.SWITCH_DOORBELL_MUTE }
  ];

  const constructionSwitchOptions = [ "Enable.Device.StatusLed.Switch", "Enable.Doorbell.Mute", "Enable.Doorbell.Trigger", "Enable.Nvr.Recording.Switch" ];

  /* The construction tail waits on the probe for the streaming controller alone. The probe's stream is held at its gate and never establishes, so every switch has to
   * stand while the derivation still waits on it, and the camera details, which a registered controller runs itself, follow only once the probe settles and the
   * controller is built with the stand-in. The operating-mode service is seeded the way a restart restores it from the accessory cache, so the status indicator the
   * camera details attach to it is what tells the pass apart.
   */
  test("the construction switches configure while the probe waits, and the camera details follow once it settles", async () => {

    const gate = Promise.withResolvers<undefined>();
    const { accessory, factory, projection } = constructCamera({ configure: (projection, _nvr, accessory) => {

      projection.livestreamEstablishes = false;
      projection.livestreamGate = gate.promise;
      accessory.addService(Service.CameraOperatingMode, "Driveway");
    }, featureFlags: { hasLedStatus: true }, userOptions: constructionSwitchOptions });

    await settle();

    assert.equal(projection.livestreamCalls.length, 1, "the probe opened its livestream");
    assert.equal(factory.createCalls.length, 0, "the vacuity guard: the derivation still waits on its probe");

    for(const { label, subtype } of constructionSwitches) {

      assert.ok(accessory.getServiceById(Service.Switch, subtype), "the " + label + " is configured while the probe waits");
    }

    const operatingMode = accessory.getService(Service.CameraOperatingMode);

    assert.ok(operatingMode, "the seeded operating-mode service is on the accessory");
    assert.equal(operatingMode.testCharacteristic(Characteristic.CameraOperatingModeIndicator), false, "the camera details wait on the probe");

    gate.resolve(undefined);
    await settle();

    assert.equal(factory.createCalls.length, 1, "the probe settled and the controller was built");
    assert.equal(operatingMode.testCharacteristic(Characteristic.CameraOperatingModeIndicator), true, "the camera details configured once the probe settled");
  });

  // A camera whose record vanishes while the capability reconcile awaits has nothing to configure: configured() returns with that reconcile still pending, so the
  // removal lands ahead of the continuation that runs the switches, which then configures none of them and throws nothing.
  test("a camera removed during the capability reconcile configures none of the construction switches", async () => {

    await assertNoUnhandledRejections(async () => {

      const { accessory, cameraId, store } = constructCamera({ userOptions: constructionSwitchOptions });

      store.removeCameraRecord(cameraId);
      await settle();

      for(const { label, subtype } of constructionSwitches) {

        assert.equal(accessory.getServiceById(Service.Switch, subtype), undefined, "the " + label + " was not configured for the removed camera");
      }
    });
  });
});
