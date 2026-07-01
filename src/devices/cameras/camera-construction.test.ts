/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * camera-construction.test.ts: The first real-ProtectCamera construction test - the proof of the platform-held streaming-delegate factory seam.
 *
 * This suite constructs a REAL minimal ProtectCamera end to end - the base constructors, configureHints, configureDevice, the floating configure IIFE
 * (reconcileStreaming through the stub factory and accessory.configureController), and all fourteen state-observe loops - against the reusable construction
 * harness in testing.helpers.ts: the faithful store double, the read-through Camera projection double, the typed NVR / platform doubles, and the stub
 * StreamingDelegateFactory the dependency inversion exists to admit. It then drives a structural-sharing state push through a real observer reaction and
 * unwinds everything via cleanup(), asserting the wire-but-don't-fire observe contract at each phase through the observer-wake diagnostics channel.
 *
 * One honest infeasibility, recorded rather than papered over: asserting "no FFmpeg" directly is not meaningful, because camera.ts value-imports FFmpeg-adjacent
 * modules harmlessly at load. What the factory assertions prove is the real claim - the REAL streaming delegate class was never constructed, because the stub
 * factory satisfied the seam.
 *
 * The suite holds ONE observer-wake subscription across all phases (construction, push, teardown), windowing the wake log per phase; the zero-wake-during-
 * construction assertion is vacuity-proofed by the SAME subscription later observing the positive push wake. The subscription is removed once, in the suite's
 * unconditional teardown, because a leaked subscriber would flip hasSubscribers for every later test in the process.
 */
import { CAMERA_FIXTURES, G2_PRO_CHANNELS, G6_PRO_ENTRY_CHANNELS } from "../../camera.fixtures.ts";
import type { Camera, ProtectCameraConfig } from "unifi-protect";
import type { CameraFixture, EntryProjection } from "../../camera.fixtures.ts";
import { Characteristic, Service, TestCameraProjection, TestStateStore, makeCameraConfig, makeProtectState, makeTestAccessory, makeTestNvr, settle }
  from "../../testing.helpers.ts";
import type { TestAccessory, TestProtectNvr, TestStreamingDelegate, TestStreamingDelegateFactory } from "../../testing.helpers.ts";
import { after, before, describe, test } from "node:test";
import type { ObserverWakePayload } from "../../diagnostics.ts";
import type { ProtectAccessory } from "../../types.ts";
import { ProtectCamera } from "./camera.ts";
import type { ProtectNvr } from "../../nvr/nvr.ts";
import type { Resolution } from "homebridge";
import assert from "node:assert/strict";
import diagnosticsChannel from "node:diagnostics_channel";

// Resolve a named fixture from the golden-master corpus, failing loudly if the corpus ever renames it.
function fixtureByModel(model: string): CameraFixture {

  const fixture = CAMERA_FIXTURES.find((candidate) => candidate.model === model);

  assert.ok(fixture, "the golden-master corpus carries the " + model + " fixture");

  return fixture;
}

// Tuple equality for HomeKit resolutions.
function isSameResolution(a: Resolution, b: Resolution): boolean {

  return (a[0] === b[0]) && (a[1] === b[1]) && (a[2] === b[2]);
}

describe("real ProtectCamera construction through the streaming-delegate factory seam", () => {

  // The construction fixture (G2 Pro) and the push fixture (G6 Pro Entry - fully RTSP-enabled, so the re-run never enters the write-through PATCH branch). Both
  // expected advertised lists come from the golden-master corpus, single-sourcing this suite with the resolution suite.
  const g2Fixture = fixtureByModel("G2 Pro");
  const g6Fixture = fixtureByModel("G6 Pro Entry");

  // The one observer-wake subscription for the whole suite, installed before construction and removed once in the unconditional teardown.
  const wakeLog: ObserverWakePayload[] = [];
  const onWake = (message: unknown): void => { wakeLog.push(message as ObserverWakePayload); };

  // The suite-scoped harness handles, assembled once in before() so every phase asserts against the SAME constructed camera.
  let accessory: TestAccessory;
  let camera: ProtectCamera;
  let cameraConfig: ProtectCameraConfig;
  let constructionWakes = 0;
  let factory: TestStreamingDelegateFactory;
  let harnessController: AbortController | undefined;
  let nvr: TestProtectNvr;
  let store: TestStateStore;

  before(async () => {

    diagnosticsChannel.subscribe("hbup:observer:wake", onWake);

    cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS });
    store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    ({ controller: harnessController, factory, nvr } = makeTestNvr({ store }));

    const projection = new TestCameraProjection(cameraConfig.id, store);

    accessory = makeTestAccessory("Test Camera", "11111111-2222-3333-4444-555555555555");

    // The construction under test: a REAL ProtectCamera against the harness doubles. The casts are confined to this seam; the instance itself is the production
    // class, and everything it runs - configureHints, configureDevice, the floating IIFE, spawnObservers - is the production code path.
    camera = new ProtectCamera(nvr as unknown as ProtectNvr, accessory as unknown as ProtectAccessory, projection as unknown as Camera);

    // Settle the floating configure IIFE and the observe loops' lazy registration before any phase asserts.
    await settle();

    constructionWakes = wakeLog.length;
  });

  after(() => {

    harnessController?.abort();
    diagnosticsChannel.unsubscribe("hbup:observer:wake", onWake);
  });

  test("construction completes and invokes the stub factory exactly once, with the camera itself and the golden-master advertised resolutions", () => {

    assert.equal(factory.createCalls.length, 1, "the factory seam was exercised exactly once");

    const call = factory.createCalls[0];

    assert.ok(call, "the factory recorded its create call");
    assert.equal(call.camera, camera, "the factory received the camera instance itself");
    assert.deepEqual(call.resolutions, g2Fixture.expected.map((entry) => entry.resolution),
      "the advertised resolutions handed to the factory equal the golden-master expectation for the construction corpus");
    assert.equal(camera.stream, call.delegate, "the camera holds the stub delegate the factory returned");
  });

  test("the accessory's controller registration received exactly the stub delegate's sentinel controller, exactly once", () => {

    const call = factory.createCalls[0];

    assert.ok(call, "the factory recorded its create call");
    assert.equal(accessory.configureControllerCalls.length, 1, "configureController was called exactly once");
    assert.equal(accessory.configureControllerCalls[0], call.delegate.controller, "the registered controller is the stub delegate's sentinel, by identity");
  });

  test("construction wires but does not fire: zero observer wakes, with exactly fourteen observers registered", () => {

    assert.equal(constructionWakes, 0, "no observer wake was published during construction - observers arm against the baseline and stay silent");
    assert.equal(store.observerCount, 14, "the two base observers plus the camera's twelve are all registered against the store double");
  });

  test("the motion sensor's HomeKit-visible surface is real: MotionDetected false, StatusActive true, StatusTampered removed", () => {

    const motionService = accessory.getService(Service.MotionSensor);

    assert.ok(motionService, "the minimal camera is HKSV-capable, so configureMotionSensor built the motion service through the real acquireService");
    assert.equal(motionService.getCharacteristic(Characteristic.MotionDetected).value, false, "MotionDetected initialized to false");
    assert.equal(motionService.getCharacteristic(Characteristic.StatusActive).value, true, "StatusActive initialized from isReachable, which is true");

    // The tamper-detection configure path reads prior existence side-effect-free through testCharacteristic and, with tamper detection unavailable on this camera, never
    // creates StatusTampered - the gate's prune branch has no prior characteristic to remove. The testCharacteristic predicate never lazily creates, so this is a pure
    // absence check.
    assert.equal(motionService.testCharacteristic(Characteristic.StatusTampered), false, "the tamper gate never created StatusTampered without the capability");
  });

  test("no service carries an undefined-keyed characteristic - the empty-UUID name-write pitfall stayed dead", () => {

    // If the service doubles ever grew a UUID that compared equal to the degenerate empty-string name sets inside homebridge-plugin-utils' service helpers,
    // setServiceName would write ConfiguredName / Name against undefined characteristic statics and silently pollute the double with undefined-keyed entries.
    for(const service of accessory.services) {

      assert.ok(service.characteristics.every((characteristic) => characteristic.type !== undefined),
        "every characteristic on " + service.displayName + " is keyed by a real kind");
    }
  });

  test("a structural-sharing channels push wakes exactly one observer and re-derives the advertised profiles through the real reaction", async () => {

    const pushBaseline = wakeLog.length;

    // Replace ONLY the channels slice with the second fixture's fully-RTSP-enabled channel set: every other field of the record spread-shares, every other state
    // slice keeps its reference, so the channels observer - and no other - must wake.
    store.pushCameraPatch(cameraConfig.id, { channels: G6_PRO_ENTRY_CHANNELS });

    await settle();

    const wakes = wakeLog.slice(pushBaseline);

    assert.equal(wakes.length, 1, "exactly one observer woke for the single-slice push");
    assert.deepEqual(wakes[0], { accessoryId: accessory.UUID, key: "camera.channels" }, "the wake is the channels observer, attributed to this accessory");

    // The reaction re-ran reconcileStreaming, which republished the advertised profiles from the NEW channel set. Pick a discriminating row - one advertised for
    // the G6 Pro Entry but absent from the G2 Pro list - and select it through the production selectChannel, proving the published profiles really moved.
    const discriminating: EntryProjection | undefined =
      g6Fixture.expected.find((entry) => !g2Fixture.expected.some((other) => isSameResolution(other.resolution, entry.resolution)));

    assert.ok(discriminating, "the two fixture models differ in at least one advertised resolution");

    const selected = camera.selectChannel(discriminating.resolution[0], discriminating.resolution[1]);

    assert.ok(selected, "selectChannel resolves the discriminating resolution against the re-derived profiles");
    assert.deepEqual(selected.resolution, discriminating.resolution, "the selected profile carries the new model's resolution");
    assert.equal(selected.url, discriminating.url, "the selected profile's URL matches the golden-master row");
    assert.equal(selected.channel.id, discriminating.channelId, "the selected profile maps to the golden-master channel");

    // The this.stream idempotency gate: the re-run republishes profiles and exits - no second delegate, no second controller registration.
    assert.equal(factory.createCalls.length, 1, "the factory was not invoked again on the re-run");
    assert.equal(accessory.configureControllerCalls.length, 1, "the controller was not registered again on the re-run");
  });

  test("cleanup unregisters the controller, unwinds all fourteen observers, and a further push wakes nothing", async () => {

    const call = factory.createCalls[0];

    assert.ok(call, "the factory recorded its create call");

    camera.cleanup();

    assert.equal(accessory.removeControllerCalls.length, 1, "removeController was called exactly once");
    assert.equal(accessory.removeControllerCalls[0], call.delegate.controller, "the removed controller is the same sentinel that was registered");

    // The per-accessory abort propagates through the composed signal into every observe loop; the store's drain-then-close completes each iterator, whose finally
    // deregisters it. Settle the microtask unwinding, then prove the registration set is empty.
    await settle();

    assert.equal(store.observerCount, 0, "every observer deregistered through the teardown");

    // The leak detector's positive half: a further push - one that WOULD wake the channels observer if anything survived - produces zero wakes.
    const teardownBaseline = wakeLog.length;

    store.pushCameraPatch(cameraConfig.id, { channels: G2_PRO_CHANNELS });

    await settle();

    assert.equal(wakeLog.length, teardownBaseline, "a push after cleanup wakes nothing");
  });
});

describe("camera HKSV self-heal observer", () => {

  // The one harness AbortController this suite builds; aborted in teardown so its observe loops never outlive the suite.
  let healController: AbortController | undefined;

  after(() => {

    healController?.abort();
  });

  // Behavior-first coverage of the both-edge HKSV reconcile observer (camera.state.hksv, camera.ts): every camera lifecycle-state edge reconciles the timeshift against
  // current reachability through configureTimeshifting, so ONE observer handles both directions - the offline edge ends an in-flight recording through the honest
  // terminated path, and the online edge re-establishes the buffer an offline-at-startup configure could not. We build our OWN camera here rather than reuse the
  // suite-scoped one (that suite uses before(), not beforeEach(), so its camera must not be mutated), set the factory-returned delegate's hksv to a recording double the
  // observer drives via configureTimeshifting, then drive a genuine offline->online state edge. The DISCONNECTED push must come first: makeCameraConfig seeds state
  // "CONNECTED", so pushing CONNECTED straight onto an already-CONNECTED record dedups to a no-op and the observer never fires.
  test("reconciles the timeshift on every lifecycle edge, ending on offline and re-establishing on online", async () => {

    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { controller, factory, nvr } = makeTestNvr({ store });

    healController = controller;

    const projection = new TestCameraProjection(cameraConfig.id, store);
    const accessory = makeTestAccessory("HKSV Reconcile Camera", "22222222-3333-4444-5555-666666666666");
    const camera = new ProtectCamera(nvr as unknown as ProtectNvr, accessory as unknown as ProtectAccessory, projection as unknown as Camera);

    await settle();

    // The observer calls stream.hksv.configureTimeshifting() on every lifecycle edge; we count each call so the assertions observe the reconcile firing per edge rather
    // than a private field. The double also retains isRecording, timeshift.stop, and updateRecordingActive: all three are load-bearing at teardown, where
    // teardownStreamingDelegate calls updateRecordingActive(false) (gated on isRecording: true) then timeshift.stop() - the optional chain stops at hksv, so a missing
    // timeshift would throw a TypeError at cleanup. The confined cast bridges the recording double to the StreamingDelegate["hksv"] type the field is declared as.
    const configureTimeshiftingCalls: boolean[] = [];
    const delegate = factory.createCalls[0]?.delegate;

    assert.ok(delegate, "the factory recorded its create call so the camera holds a stub delegate");

    // The configureTimeshifting spy records one entry per call and resolves true; the count of entries is the per-edge reconcile tally the assertions read.
    const configureTimeshifting = (): Promise<boolean> => Promise.resolve(configureTimeshiftingCalls.push(true) > 0);

    delegate.hksv = { configureTimeshifting, isRecording: true,
      timeshift: { isStarted: false, stop: (): void => { /* No-op: the double owns no buffer to release on teardown. */ } },
      updateRecordingActive: (): void => { /* No-op: only reached at teardown, not by the observer. */ } } as unknown as TestStreamingDelegate["hksv"];

    // The offline edge: the observer now reconciles unconditionally, so the reconcile fires here (was: a no-op gated on !isReachable). Asserted per-edge - exactly one
    // call immediately after the DISCONNECTED push, BEFORE the CONNECTED push - so the assertion discriminates the offline edge rather than an end-of-test aggregate.
    store.pushCameraPatch(cameraConfig.id, { state: "DISCONNECTED" });

    await settle();

    assert.equal(configureTimeshiftingCalls.length, 1, "the offline edge reconciled the timeshift (ending an in-flight recording honestly) rather than no-oping");

    // The online edge: the observer reconciles again, re-establishing the buffer an offline-at-startup configure could not. Pin the cumulative tally to exactly two - one
    // reconcile per edge - so the assertion states the exact count rather than a vague "fired again".
    store.pushCameraPatch(cameraConfig.id, { state: "CONNECTED" });

    await settle();

    assert.equal(configureTimeshiftingCalls.length, 2, "the online edge reconciled again, so the observer fired exactly once per lifecycle edge");

    camera.cleanup();

    await settle();
  });
});
