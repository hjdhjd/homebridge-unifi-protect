/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * timeshift.test.ts: Behavior coverage of the HKSV timeshift buffer - the first standalone net over ProtectTimeshiftBuffer.
 *
 * The timeshift buffer's public surface (the segment/discontinuity/terminated events, the start/stop/transmit lifecycle, the buffer/getLast/getLastKeyframe/
 * getKeyframeAlignedStart read helpers, and the selfHeal reboot) has only ever been exercised indirectly through the recording-delegate suites. This suite drives it as a
 * STANDALONE unit - there is no recording delegate in the loop, so the timeshift's own emission decisions are asserted directly rather than conflated with a consumer's.
 *
 * The SUT is fed by the harness's controllable livestream-subscription double, which a test pushes segments into one at a time (init / keyframe / non-keyframe /
 * discontinuity-marked) and can end or throw-into. The keyframe-staleness gate - the timeshift's only time-dependent behavior - is made deterministic by the injected
 * TestClock (the very clock the timeshift reads via platform.clock), advanced explicitly rather than real-waited. The CRITICAL precondition for every getLastKeyframe
 * assertion is the nonzero clock base: getLastKeyframe's guard returns null when _lastKeyframeTime is falsy (zero), so a keyframe pushed at TestClock virtual-time 0 is
 * indistinguishable from "no keyframe" - every getLastKeyframe-non-null (and staleness-boundary) test advances the clock to a nonzero base BEFORE pushing its keyframe,
 * or the staleness compare is never reached and the test is vacuous.
 *
 * All assertions are behavior-first: emitted events, returned buffers, recorded seam calls (livestreamCalls, rebootCalls, the double's reassessCalls/disposed), and the
 * public getters - never a private field (_segments, _pendingDiscontinuity, _isTransmitting, _lastKeyframeTime, subscription). Because both the per-push forward and
 * transmitStart's own concat emit the "segment" event, forwarding tests assert on the forwarded PAYLOAD (which fragment's data), never the event count.
 */
import type { ControllableLivestreamDouble, TestCameraHost, TestLogEntry, TestProtectNvr } from "../testing.helpers.ts";
import { after, describe, test } from "node:test";
import { makeControllableLivestreamDouble, makeKeyframeFragment, makeNonKeyframeFragment, makeTestCameraHost, settle } from "../testing.helpers.ts";
import type { ChannelProfile } from "./resolution.ts";
import { PROTECT_LIVESTREAM_API_IDR_INTERVAL } from "../settings.ts";
import { ProtectLivestreamUnavailableError } from "unifi-protect";
import { ProtectTimeshiftBuffer } from "./timeshift.ts";
import type { Segment } from "unifi-protect";
import type { TestClock } from "homebridge-plugin-utils";
import assert from "node:assert/strict";

// The keyframe-staleness threshold the timeshift compares against: PROTECT_LIVESTREAM_API_IDR_INTERVAL (5s) doubled, in milliseconds. A keyframe older than this reads as
// stale and getLastKeyframe returns null; younger reads fresh. The suite drives the boundary deterministically by advancing the TestClock across exactly this much.
const STALENESS_THRESHOLD_MS = PROTECT_LIVESTREAM_API_IDR_INTERVAL * 2 * 1000;

// Every host this suite builds shares its makeTestNvr AbortController. Aborting them in teardown releases the harness signals so no background consume loop (the
// timeshift drives one per start) outlives the suite.
const controllers: AbortController[] = [];

after(() => {

  for(const controller of controllers) {

    controller.abort();
  }
});

// Build a minimal-but-truthy ChannelProfile from the host's first G2 Pro channel. start() only forwards this to the host's livestream() seam (which the controllable
// double ignores), so the profile needs only to type-check. We guard the indexed access because host.ufp.channels[0] widens to ProtectCameraChannelConfig | undefined
// under noUncheckedIndexedAccess.
function makeChannelProfile(host: TestCameraHost): ChannelProfile {

  const channel = host.ufp.channels[0];

  if(!channel) {

    throw new Error("The G2 Pro channel fixture is missing its first channel.");
  }

  return { channel, name: channel.name, resolution: [ 1920, 1080, 30 ], url: "rtsps://test" };
}

// Build one media Segment around a fragment's bytes. processSegment reads only type, discontinuity, and data; moof/mdat are type-required, so we supply the fragment's
// own. The optional discontinuity flag marks the first media after a reconnect (the v5 discontinuity:true), which the timeshift's discontinuity gate keys on.
function makeMediaSegment(fragment: { data: Buffer; mdat: Buffer; moof: Buffer }, options: { discontinuity?: boolean } = {}): Segment {

  if(options.discontinuity) {

    return { data: fragment.data, discontinuity: true, mdat: fragment.mdat, moof: fragment.moof, type: "media" };
  }

  return { data: fragment.data, mdat: fragment.mdat, moof: fragment.moof, type: "media" };
}

// The arranged, started timeshift plus the handles a test asserts against. clock is the controllable TestClock the timeshift reads via platform.clock (advance it to
// drive the staleness gate); double is the controllable livestream the test pushes segments into; events captures every emitted segment/discontinuity/terminated; host
// exposes the seam call logs (livestreamCalls, rebootCalls, the settable hasFeature/isReachable); nvr is the settable TestProtectNvr (set nvr.phase for the shuttingDown
// variant); timeshift is the SUT.
interface StartedTimeshift {

  clock: TestClock;
  double: ControllableLivestreamDouble;
  events: { discontinuity: number; segment: Buffer[]; terminated: number };
  host: TestCameraHost;
  logEntries: TestLogEntry[];
  nvr: TestProtectNvr;
  timeshift: ProtectTimeshiftBuffer;
}

// Arrange a started timeshift driven by a controllable livestream double. Builds the host, installs the supplied subscription queue (default a single fresh controllable
// double), sets the configured buffer duration, subscribes event recorders, and awaits start() so the subscription is committed and isStarted is true. The clock starts
// at the TestClock default (zero) - a getLastKeyframe test advances it to a nonzero base BEFORE pushing its keyframe (the falsy-zero guard trap). configuredDuration
// defaults generously (1000ms = 10 segments) so trim tests can set a smaller value explicitly.
async function buildStartedTimeshift(
  options: { configuredDuration?: number; double?: ControllableLivestreamDouble; subscriptions?: ControllableLivestreamDouble[] } = {}): Promise<StartedTimeshift> {

  const { clock, controller, host, logEntries, nvr } = makeTestCameraHost();

  controllers.push(controller);

  const double = options.double ?? makeControllableLivestreamDouble();
  const subscriptions = options.subscriptions ?? [double];

  host.livestreamSubscriptions = [...subscriptions];

  const timeshift = new ProtectTimeshiftBuffer(host);

  timeshift.configuredDuration = options.configuredDuration ?? 1000;

  const events: { discontinuity: number; segment: Buffer[]; terminated: number } = { discontinuity: 0, segment: [], terminated: 0 };

  timeshift.on("discontinuity", (): void => { events.discontinuity++; });
  timeshift.on("segment", (segment: Buffer): void => { events.segment.push(segment); });
  timeshift.on("terminated", (): void => { events.terminated++; });

  await timeshift.start(makeChannelProfile(host));

  return { clock, double, events, host, logEntries, nvr, timeshift };
}

describe("timeshift buffer behavior", () => {

  // Lifecycle / start.

  // Target (a): a successful start (whenEstablished true, initSegment present, the parked double) returns true and isStarted is true - the parked iterator never
  // completes, so it keeps the subscription committed.
  test("start succeeds and reports started against the parked double", async () => {

    const { double, host, timeshift } = await buildStartedTimeshift();

    assert.equal(timeshift.isStarted, true, "start commits the subscription and isStarted is true");
    assert.equal(host.livestreamCalls.length, 1, "livestream was opened exactly once");
    assert.equal(double.disposed, false, "the committed subscription is not disposed");
  });

  // Target (b): start with whenEstablished false returns false, isStarted stays false, and the double is disposed (start's whenEstablished-false arm disposes the local
  // subscription before committing).
  test("start fails and disposes when whenEstablished resolves false", async () => {

    const double = makeControllableLivestreamDouble({ whenEstablished: false });
    const { clock, controller, host, nvr } = makeTestCameraHost();

    controllers.push(controller);
    host.livestreamSubscriptions = [double];

    const timeshift = new ProtectTimeshiftBuffer(host);
    const started = await timeshift.start(makeChannelProfile(host));

    await settle();

    assert.equal(started, false, "start returns false when whenEstablished resolves false");
    assert.equal(timeshift.isStarted, false, "isStarted stays false");
    assert.equal(double.disposed, true, "the local subscription is disposed");
    assert.ok(nvr, "the nvr handle is threaded out for the selfHeal targets");
    assert.ok(clock, "the clock handle is threaded out for the staleness targets");
  });

  // Target (c): start with a null initSegment returns false, isStarted stays false, and the double is disposed (start's initSegment-null arm). whenEstablished must be
  // true so start reaches the initSegment check rather than declining earlier.
  test("start fails and disposes when the init segment is null", async () => {

    const double = makeControllableLivestreamDouble({ initSegment: null });
    const { controller, host } = makeTestCameraHost();

    controllers.push(controller);
    host.livestreamSubscriptions = [double];

    const timeshift = new ProtectTimeshiftBuffer(host);
    const started = await timeshift.start(makeChannelProfile(host));

    await settle();

    assert.equal(started, false, "start returns false when the init segment is null");
    assert.equal(timeshift.isStarted, false, "isStarted stays false");
    assert.equal(double.disposed, true, "the local subscription is disposed");
  });

  // Target (d): starting an already-started timeshift disposes the prior subscription and commits the new one. Two DISTINCT-id doubles are supplied via the queue; the
  // second start runs start's if(isStarted) stop() path, disposing doubleA, then commits doubleB. This is ALSO the genuine discriminator of the consumeSegments
  // id-identity guard (the finally's this.subscription?.id === subscription.id): start() commits doubleB BEFORE doubleA's iterator finally runs, so that finally reaches
  // the distinct-id arm (this.subscription is doubleB, doubleB.id !== doubleA.id) and no-ops. A guard-removed timeshift instead tears doubleB down here, flipping
  // isStarted false - so the isStarted assertion below is what pins the guard.
  test("starting again disposes the prior subscription and commits the new one", async () => {

    const doubleA = makeControllableLivestreamDouble();
    const doubleB = makeControllableLivestreamDouble();
    const { host, timeshift } = await buildStartedTimeshift({ double: doubleA, subscriptions: [ doubleA, doubleB ] });

    await timeshift.start(makeChannelProfile(host));
    await settle();

    assert.notEqual(doubleA.id, doubleB.id, "the two doubles have distinct ids");
    assert.equal(doubleA.disposed, true, "the prior subscription is disposed");
    assert.equal(doubleB.disposed, false, "the new subscription is committed and not disposed");
    assert.equal(timeshift.isStarted, true, "isStarted remains true after the restart");
    assert.equal(host.livestreamCalls.length, 2, "the second start opened a second livestream");
  });

  // Target (e): stop on a started timeshift flips isStarted false and disposes the subscription.
  test("stop disposes the subscription and reports not started", async () => {

    const { double, timeshift } = await buildStartedTimeshift();

    timeshift.stop();

    await settle();

    assert.equal(timeshift.isStarted, false, "isStarted is false after stop");
    assert.equal(double.disposed, true, "the subscription is disposed after stop");
  });

  // Emission / processSegment.

  // Target (f): an init segment is skipped - it is read via the cached initSegment getter, not buffered. time stays 0 and the buffer does not include it.
  test("an init segment is skipped, not buffered", async () => {

    const { double, timeshift } = await buildStartedTimeshift();

    double.push({ codec: "h264", data: Buffer.from("init"), type: "init" });

    await settle();

    assert.equal(timeshift.time, 0, "the init segment does not add buffer time");
  });

  // Target (g): a media keyframe is buffered and keyframe-tracked. time advances by one segment, and - with a nonzero clock base - getLastKeyframe returns non-null. The
  // nonzero base is the falsy-zero guard precondition: a keyframe at clock 0 sets _lastKeyframeTime 0, which getLastKeyframe's guard treats as "no keyframe".
  test("a media keyframe is buffered and keyframe-tracked", async () => {

    const { clock, double, timeshift } = await buildStartedTimeshift();

    clock.advance(1000);
    double.push(makeMediaSegment(makeKeyframeFragment()));

    await settle();

    assert.equal(timeshift.time, 100, "the keyframe adds one segment of buffer time");
    assert.ok(timeshift.getLastKeyframe(), "getLastKeyframe returns the keyframe at a nonzero clock base");
  });

  // Target (h): the buffer trims at its configured segment count. With a small configured duration (200ms = 2 segments), pushing more than two media segments caps time
  // at the configured duration - asserted via time, not a private field.
  test("the buffer trims at the configured segment count", async () => {

    const { double, timeshift } = await buildStartedTimeshift({ configuredDuration: 200 });

    for(let i = 0; i < 5; i++) {

      double.push(makeMediaSegment(makeKeyframeFragment()));

      // eslint-disable-next-line no-await-in-loop -- Each push is settled before the next so the trim runs per segment, exercising the steady-state cap.
      await settle();
    }

    assert.equal(timeshift.time, 200, "time caps at the configured duration despite five pushes");
  });

  // Target (i): while transmitting, a pushed media segment is forwarded as a "segment" event whose PAYLOAD is that segment's data. We distinguish it from transmitStart's
  // own concat emit by asserting the forwarded payload equals the single fragment's bytes (the concat carries init + buffer, never a bare fragment), not by event count.
  test("a pushed segment is forwarded by payload while transmitting", async () => {

    const { double, events, timeshift } = await buildStartedTimeshift();
    const keyframe = makeKeyframeFragment();

    double.push(makeMediaSegment(keyframe));

    await settle();
    timeshift.transmitStart();

    const pushed = makeMediaSegment(makeNonKeyframeFragment());

    double.push(pushed);

    await settle();

    assert.ok(events.segment.some((payload) => payload.equals(pushed.data)), "a forwarded segment carries the pushed fragment's payload");
  });

  // Target (j): the per-push forward does NOT fire while not transmitting. Pushing media without transmitStart yields no "segment" event carrying that fragment's data.
  // This is the negative contrast to (i), which proves the forward CAN fire.
  test("a pushed segment is not forwarded while not transmitting", async () => {

    const { double, events, timeshift } = await buildStartedTimeshift();
    const pushed = makeMediaSegment(makeKeyframeFragment());

    double.push(pushed);

    await settle();

    assert.equal(timeshift.isTransmitting, false, "the timeshift is not transmitting");
    assert.equal(events.segment.some((payload) => payload.equals(pushed.data)), false, "no segment event carries the pushed fragment while not transmitting");
  });

  // Target (k): the LOAD-BEARING discontinuity keyframe-gate. While transmitting, a discontinuity-marked NON-keyframe segment defers the discontinuity emit and
  // suppresses forwarding until a clean keyframe arrives. We settle after EACH push so the intermediate deferred state is observable (multiple pushes + one settle would
  // drain all in one macrotask and hide the defer). The non-keyframe choice is deliberate: a discontinuity-marked keyframe emits immediately and the gate is untested.
  test("the discontinuity emit is deferred until a clean keyframe after a discontinuity-marked non-keyframe", async () => {

    const { double, events, timeshift } = await buildStartedTimeshift();

    // Fill a keyframe and start transmitting, so the discontinuity arm (which requires _isTransmitting) is armed.
    double.push(makeMediaSegment(makeKeyframeFragment()));

    await settle();
    timeshift.transmitStart();

    // A discontinuity-marked non-keyframe: the gate arms but defers the emit, and forwarding is suppressed.
    const discontinuityNonKeyframe = makeMediaSegment(makeNonKeyframeFragment(), { discontinuity: true });

    double.push(discontinuityNonKeyframe);

    await settle();

    assert.equal(events.discontinuity, 0, "no discontinuity event yet after the discontinuity-marked non-keyframe");
    assert.equal(events.segment.some((payload) => payload.equals(discontinuityNonKeyframe.data)), false, "the discontinuity-marked non-keyframe is not forwarded");

    // Another non-keyframe: still deferred, still suppressed.
    const secondNonKeyframe = makeMediaSegment(makeNonKeyframeFragment());

    double.push(secondNonKeyframe);

    await settle();

    assert.equal(events.discontinuity, 0, "still no discontinuity event after a second non-keyframe");
    assert.equal(events.segment.some((payload) => payload.equals(secondNonKeyframe.data)), false, "the second non-keyframe is still suppressed");

    // A clean keyframe: the discontinuity emit fires now, and forwarding resumes with the keyframe's payload.
    const cleanKeyframe = makeMediaSegment(makeKeyframeFragment());

    double.push(cleanKeyframe);

    await settle();

    assert.equal(events.discontinuity, 1, "the discontinuity event fires on the clean keyframe");
    assert.ok(events.segment.some((payload) => payload.equals(cleanKeyframe.data)), "forwarding resumes with the clean keyframe's payload");
  });

  // Target (l): the discontinuity arm requires transmitting. While NOT transmitting, a discontinuity-marked segment then a keyframe emit NO discontinuity event - the
  // arm's _isTransmitting conjunct is false, so the gate never arms off-transmit. This is the negative contrast to (k).
  test("the discontinuity gate does not arm while not transmitting", async () => {

    const { double, events, timeshift } = await buildStartedTimeshift();

    double.push(makeMediaSegment(makeNonKeyframeFragment(), { discontinuity: true }));

    await settle();

    double.push(makeMediaSegment(makeKeyframeFragment()));

    await settle();

    assert.equal(timeshift.isTransmitting, false, "the timeshift is not transmitting");
    assert.equal(events.discontinuity, 0, "no discontinuity event fires off-transmit");
  });

  // finalizeSubscription single-anchor / terminated.

  // Target (m): terminated fires exactly once when the iterator ends while transmitting. transmitStart, then double.end() ends the iterator, whose consumeSegments
  // finally runs finalizeSubscription and (since it was transmitting) emits terminated once.
  test("terminated fires once when the iterator ends while transmitting", async () => {

    const { double, events, timeshift } = await buildStartedTimeshift();

    double.push(makeMediaSegment(makeKeyframeFragment()));

    await settle();
    timeshift.transmitStart();
    double.end();

    await settle();

    assert.equal(events.terminated, 1, "exactly one terminated event fires on iterator end while transmitting");
  });

  // Target (n): terminated fires exactly once via stop() while transmitting. stop routes through finalizeSubscription, which emits terminated since it was transmitting.
  test("terminated fires once via stop while transmitting", async () => {

    const { double, events, timeshift } = await buildStartedTimeshift();

    double.push(makeMediaSegment(makeKeyframeFragment()));

    await settle();
    timeshift.transmitStart();
    timeshift.stop();

    await settle();

    assert.equal(events.terminated, 1, "exactly one terminated event fires on stop while transmitting");
  });

  // Target (o): NO terminated fires when not transmitting. Ending the iterator (or stopping) without transmitStart emits zero terminated - finalizeSubscription's
  // wasTransmitting guard is false. The negative contrast to (m)/(n).
  test("no terminated fires when not transmitting", async () => {

    const { double, events } = await buildStartedTimeshift();

    double.push(makeMediaSegment(makeKeyframeFragment()));

    await settle();
    double.end();

    await settle();

    assert.equal(events.terminated, 0, "no terminated event fires when not transmitting");
  });

  // Target (p): an explicit stop() while transmitting emits exactly one terminated, and a subsequent restart commits the new subscription cleanly with no spurious second
  // terminated. This is the explicit-stop teardown path - the first of the four consumeSegments teardown identities: stop() synchronously clears the subscription and
  // fires the one terminated, and doubleA's iterator finally then runs while the subscription is undefined, so it no-ops via the undefined short-circuit. (The
  // id-identity guard's distinct-id arm - a prior subscription's finally running while a NEW subscription is committed - is the SEPARATE path that target (d) genuinely
  // discriminates; here doubleA's teardown completes before doubleB starts, so this test exercises the explicit-stop path, not the distinct-id arm.)
  test("an explicit stop while transmitting emits one terminated and the restart commits cleanly", async () => {

    const doubleA = makeControllableLivestreamDouble();
    const doubleB = makeControllableLivestreamDouble();
    const { events, host, timeshift } = await buildStartedTimeshift({ double: doubleA, subscriptions: [ doubleA, doubleB ] });

    // Transmit on A, then stop A: one terminated, A disposed. stop() disposes A (enqueuing its iterator's end) and synchronously clears the subscription.
    doubleA.push(makeMediaSegment(makeKeyframeFragment()));

    await settle();
    timeshift.transmitStart();
    timeshift.stop();

    await settle();

    assert.equal(events.terminated, 1, "A's stop fired exactly one terminated");
    assert.equal(doubleA.disposed, true, "A is disposed");

    // Start B and transmit on it. B is a distinct subscription with a distinct id.
    await timeshift.start(makeChannelProfile(host));
    await settle();
    doubleB.push(makeMediaSegment(makeKeyframeFragment()));

    await settle();
    timeshift.transmitStart();

    // doubleA's iterator already ended at stop, and its finally already ran while the subscription was undefined (so it no-oped). Settle again to be certain any late
    // microtask has run. doubleB must still be started and the terminated count unchanged - the explicit stop produced exactly one terminated, and the restart adds none.
    await settle();

    assert.equal(timeshift.isStarted, true, "the restarted subscription remains started");
    assert.equal(events.terminated, 1, "exactly one terminated - the explicit stop fired it and the restart adds no spurious second");
    assert.notEqual(doubleA.id, doubleB.id, "the queue handed out two distinct subscriptions");
  });

  // transmitStart / transmitStop.

  // Target (q): transmitStart on a NOT-started timeshift returns false and logs the error - subscription is undefined, so the !this.subscription?.initSegment
  // precondition is true. The committed-subscription-with-null-initSegment state is unreachable-by-construction (start validates initSegment before committing), so the
  // not-started path is the only reachable arm of the precondition.
  test("transmitStart on a not-started timeshift declines and logs", async () => {

    const { controller, host, logEntries } = makeTestCameraHost();

    controllers.push(controller);

    const timeshift = new ProtectTimeshiftBuffer(host);
    const result = timeshift.transmitStart();

    assert.equal(result, false, "transmitStart declines when not started");
    assert.ok(logEntries.some((entry) => (entry.level === "error") && String(entry.parameters[0]).includes("HKSV event recording unavailable")),
      "transmitStart logs the not-ready error");
  });

  // Target (r): transmitStart success. With a started, buffer-filled timeshift, transmitStart emits a "segment" event whose payload is the init + buffer concat, flips
  // isTransmitting true, and calls reassess once.
  test("transmitStart emits the init-plus-buffer concat and escalates recovery", async () => {

    const { double, events, timeshift } = await buildStartedTimeshift();
    const first = makeKeyframeFragment();
    const second = makeKeyframeFragment();

    double.push(makeMediaSegment(first));

    await settle();
    double.push(makeMediaSegment(second));

    await settle();

    const result = timeshift.transmitStart();

    assert.equal(result, true, "transmitStart succeeds on a started, filled timeshift");
    assert.equal(timeshift.isTransmitting, true, "isTransmitting is true after transmitStart");
    assert.equal(double.reassessCalls, 1, "transmitStart escalates recovery exactly once");

    // The emitted concat is the init segment plus the two buffered fragments - longer than either fragment alone, and it leads with the init bytes.
    const concat = events.segment.find((payload) => payload.length > first.data.length);

    assert.ok(concat, "transmitStart emitted a concat segment");
    assert.ok(concat.length > (first.data.length + second.data.length), "the concat carries the init segment plus both buffered fragments");
  });

  // Target (s): transmitStart with a valid startIndex in (0, length) emits init + the SLICED buffer (from startIndex), shorter than the whole-buffer concat. The false
  // branch - an out-of-range startIndex - falls back to the whole buffer. We assert both arms: a startIndex of 1 over a two-segment buffer yields init + one fragment,
  // shorter than the whole-buffer concat over the same buffer.
  test("transmitStart slices from a valid startIndex and falls back to the whole buffer otherwise", async () => {

    const sliced = await buildStartedTimeshift();

    sliced.double.push(makeMediaSegment(makeKeyframeFragment()));

    await settle();
    sliced.double.push(makeMediaSegment(makeKeyframeFragment()));

    await settle();
    sliced.timeshift.transmitStart(1);

    const slicedConcat = sliced.events.segment.at(-1);

    const whole = await buildStartedTimeshift();

    whole.double.push(makeMediaSegment(makeKeyframeFragment()));

    await settle();
    whole.double.push(makeMediaSegment(makeKeyframeFragment()));

    await settle();

    // An out-of-range startIndex (>= length) falls back to the whole buffer - the ternary's false branch.
    whole.timeshift.transmitStart(99);

    const wholeConcat = whole.events.segment.at(-1);

    assert.ok(slicedConcat, "the sliced transmitStart emitted a concat");
    assert.ok(wholeConcat, "the whole-buffer transmitStart emitted a concat");
    assert.ok(slicedConcat.length < wholeConcat.length, "the startIndex slice is shorter than the whole-buffer fallback");
  });

  // Target (t): transmitStop flips isTransmitting false, and it clears the pending discontinuity - a discontinuity-marked push followed by transmitStop then a keyframe
  // does not emit discontinuity (the pending flag was cleared at transmitStop).
  test("transmitStop stops transmitting and clears the pending discontinuity", async () => {

    const { double, events, timeshift } = await buildStartedTimeshift();

    double.push(makeMediaSegment(makeKeyframeFragment()));

    await settle();
    timeshift.transmitStart();
    double.push(makeMediaSegment(makeNonKeyframeFragment(), { discontinuity: true }));

    await settle();
    timeshift.transmitStop();

    assert.equal(timeshift.isTransmitting, false, "isTransmitting is false after transmitStop");

    double.push(makeMediaSegment(makeKeyframeFragment()));

    await settle();

    assert.equal(events.discontinuity, 0, "transmitStop cleared the pending discontinuity, so the later keyframe does not emit discontinuity");
  });

  // Read helpers.

  // Target (u): the buffer getter returns the init + segments concat when started and non-empty, and null on a started-but-EMPTY buffer (the reachable null arm). The
  // no-initSegment null arm is unreachable after a successful start (start commits only a non-null-initSegment subscription) - acknowledged, not faked.
  test("the buffer getter concatenates init plus segments, and is null when empty", async () => {

    const { double, timeshift } = await buildStartedTimeshift();

    assert.equal(timeshift.buffer, null, "the buffer is null on a started-but-empty buffer");

    double.push(makeMediaSegment(makeKeyframeFragment()));

    await settle();

    assert.ok(timeshift.buffer, "the buffer is non-null once a segment is buffered");
  });

  // Target (v): getLast returns the last N segments plus init, the whole buffer when the request exceeds the buffer, and null on a 0 duration. getLast's no-initSegment
  // ternary-false arm (segments present but no init segment) is unreachable-by-construction (start commits only a non-null init) - acknowledged, not faked.
  test("getLast returns a duration-bounded buffer, the whole buffer when over-requested, and null on zero", async () => {

    const { double, timeshift } = await buildStartedTimeshift();

    for(let i = 0; i < 3; i++) {

      double.push(makeMediaSegment(makeKeyframeFragment()));

      // eslint-disable-next-line no-await-in-loop -- Each push is settled before the next so the buffer fills one segment at a time.
      await settle();
    }

    assert.equal(timeshift.getLast(0), null, "getLast returns null on a zero duration");

    const last = timeshift.getLast(100);
    const whole = timeshift.getLast(100000);

    assert.ok(last, "getLast returns a buffer for a one-segment duration");
    assert.ok(whole, "getLast returns the whole buffer when the request exceeds the buffer");
    assert.ok(whole.length > last.length, "the over-requested buffer is larger than the one-segment slice");
  });

  // Target (w): getKeyframeAlignedStart returns the nearest keyframe at or before the prebuffer start as { seekOffsetMs, startIndex }, and null when no keyframe precedes
  // the start point. A single keyframe buffered yields a start at index 0; an all-non-keyframe buffer yields null.
  test("getKeyframeAlignedStart finds the nearest keyframe or returns null", async () => {

    const aligned = await buildStartedTimeshift();

    aligned.double.push(makeMediaSegment(makeKeyframeFragment()));

    await settle();

    const start = aligned.timeshift.getKeyframeAlignedStart(100);

    assert.ok(start, "getKeyframeAlignedStart finds the buffered keyframe");
    assert.equal(start.startIndex, 0, "the keyframe is at index 0");

    const none = await buildStartedTimeshift();

    none.double.push(makeMediaSegment(makeNonKeyframeFragment()));

    await settle();

    assert.equal(none.timeshift.getKeyframeAlignedStart(100), null, "getKeyframeAlignedStart is null when no keyframe precedes the start");
  });

  // Target (x): getLastKeyframe fresh - with a nonzero clock base, a buffered keyframe yields a non-null result (init + the keyframe fragment); null when no keyframe has
  // been buffered (started-but-empty, the reachable arm). The nonzero base is the falsy-zero guard precondition.
  test("getLastKeyframe returns the fresh keyframe at a nonzero clock base, and null when none buffered", async () => {

    const { clock, double, timeshift } = await buildStartedTimeshift();

    assert.equal(timeshift.getLastKeyframe(), null, "getLastKeyframe is null with no keyframe buffered");

    clock.advance(1000);
    double.push(makeMediaSegment(makeKeyframeFragment()));

    await settle();

    assert.ok(timeshift.getLastKeyframe(), "getLastKeyframe returns the fresh keyframe at a nonzero clock base");
  });

  // Target (y): the staleness gate (the Clock payoff). Advance the clock to a nonzero base T, push a keyframe (_lastKeyframeTime = T, nonzero), then advance so
  // clock.now() - T crosses the threshold - getLastKeyframe returns null VIA THE STALENESS COMPARE (not the falsy-zero guard). A control just under the threshold reads
  // non-null. The keyframe MUST be pushed at nonzero T or the test is vacuous (the guard would mask the compare).
  test("getLastKeyframe goes stale past the threshold and stays fresh under it", async () => {

    // Fresh control: advance to a nonzero base, push the keyframe, advance to just UNDER the threshold - the keyframe reads fresh via the staleness compare.
    const fresh = await buildStartedTimeshift();

    fresh.clock.advance(1000);
    fresh.double.push(makeMediaSegment(makeKeyframeFragment()));

    await settle();
    fresh.clock.advance(STALENESS_THRESHOLD_MS - 1);

    assert.ok(fresh.timeshift.getLastKeyframe(), "getLastKeyframe is non-null just under the staleness threshold");

    // Stale case: same nonzero-base keyframe, then advance to just OVER the threshold - the keyframe reads stale via the compare, returning null.
    const stale = await buildStartedTimeshift();

    stale.clock.advance(1000);
    stale.double.push(makeMediaSegment(makeKeyframeFragment()));

    await settle();
    stale.clock.advance(STALENESS_THRESHOLD_MS + 1);

    assert.equal(stale.timeshift.getLastKeyframe(), null, "getLastKeyframe is null just over the staleness threshold, via the staleness compare");
  });

  // Target (x-trim): getLastKeyframe returns null when the only keyframe has been trimmed out of the buffer even though _lastKeyframeTime is still fresh. The buffer trim
  // shifts the oldest segment without resetting the keyframe time, so this reaches getLastKeyframe's final return - the guard and the staleness compare both pass, but
  // the backward walk finds no keyframe in the buffer. A reachable branch distinct from the no-keyframe-yet and stale arms.
  test("getLastKeyframe returns null when its only keyframe has been trimmed out of a fresh buffer", async () => {

    const { clock, double, timeshift } = await buildStartedTimeshift({ configuredDuration: 200 });

    // Buffer one keyframe at a nonzero base, then push two non-keyframes so the keyframe is evicted (configuredDuration 200ms caps the buffer at two 100ms segments). The
    // clock stays at the nonzero base, so the keyframe time is fresh and only the empty backward walk returns null. Non-keyframes never update the keyframe time.
    clock.advance(1000);
    double.push(makeMediaSegment(makeKeyframeFragment()));

    await settle();
    double.push(makeMediaSegment(makeNonKeyframeFragment()));

    await settle();
    double.push(makeMediaSegment(makeNonKeyframeFragment()));

    await settle();

    assert.equal(timeshift.getLastKeyframe(), null, "getLastKeyframe is null once its only keyframe has been trimmed out, despite a fresh keyframe time");
  });

  // getters.

  // Target (z): isRestarting reflects the double's state (recovering -> true, live -> false); the configuredDuration round-trip is discriminating (set 250 -> get 300 via
  // Math.ceil(250/100)=3 segments; set 0 -> get 100, floored at one segment); segmentLength is 100; time is 0 on a started-but-empty buffer.
  test("the getters reflect state, configured duration, segment length, and empty time", async () => {

    const recovering = await buildStartedTimeshift({ double: makeControllableLivestreamDouble({ state: "recovering" }) });

    assert.equal(recovering.timeshift.isRestarting, true, "isRestarting is true when the subscription state is recovering");

    const { timeshift } = await buildStartedTimeshift();

    assert.equal(timeshift.isRestarting, false, "isRestarting is false on the default live state");

    timeshift.configuredDuration = 250;
    assert.equal(timeshift.configuredDuration, 300, "configuredDuration rounds 250ms up to three 100ms segments");

    timeshift.configuredDuration = 0;
    assert.equal(timeshift.configuredDuration, 100, "configuredDuration floors at one 100ms segment");

    assert.equal(timeshift.segmentLength, 100, "segmentLength is the fixed 100ms resolution");
    assert.equal(timeshift.time, 0, "time is zero on a started-but-empty buffer");
  });

  // selfHeal.

  // Target (aa): reboot fires on the recovery give-up. On a started timeshift, throwing a ProtectLivestreamUnavailableError with attempts at the threshold, with
  // self-healing enabled, the camera reachable, and the nvr running, reboots the camera exactly once and announces it with a warn carrying the failed-attempt count.
  test("selfHeal reboots the camera and announces it on the recovery give-up", async () => {

    const { double, host, logEntries } = await buildStartedTimeshift();

    host.hasFeature = (option: string): boolean => option === "Device.SelfHealing";
    host.isReachable = true;

    double.throwError(new ProtectLivestreamUnavailableError("the livestream gave up", { attempts: 10, phase: "recovering" }));

    await settle();

    assert.equal(host.rebootCalls.length, 1, "the camera was rebooted exactly once");
    assert.ok(logEntries.some((entry) => (entry.level === "warn") && String(entry.parameters[0]).includes("Rebooting the camera to recover its livestream") &&
      (entry.parameters[1] === "10")), "the reboot is announced with a warn carrying the failed-attempt count");
  });

  // Target (bb): reboot does NOT fire on the recovery give-up's negatives. attempts below the threshold takes the first early return; the second early-return guard's
  // three disjuncts - self-healing disabled, the camera unreachable, and the nvr shutting down - each independently suppress the reboot. Each leaves rebootCalls empty.
  // (The reboot().catch rejection path is a deeper defensive branch not exercised here; the host's reboot stub does not reject - acknowledged as a gap.)
  test("selfHeal does not reboot below the threshold, with self-healing off, when unreachable, or while shutting down", async () => {

    const belowThreshold = await buildStartedTimeshift();

    belowThreshold.host.hasFeature = (option: string): boolean => option === "Device.SelfHealing";
    belowThreshold.host.isReachable = true;
    belowThreshold.double.throwError(new ProtectLivestreamUnavailableError("not yet at the give-up", { attempts: 9, phase: "recovering" }));

    await settle();

    assert.equal(belowThreshold.host.rebootCalls.length, 0, "no reboot below the self-heal threshold");

    const featureOff = await buildStartedTimeshift();

    featureOff.host.hasFeature = (): boolean => false;
    featureOff.host.isReachable = true;
    featureOff.double.throwError(new ProtectLivestreamUnavailableError("the livestream gave up", { attempts: 10, phase: "recovering" }));

    await settle();

    assert.equal(featureOff.host.rebootCalls.length, 0, "no reboot when self-healing is disabled");

    const unreachable = await buildStartedTimeshift();

    unreachable.host.hasFeature = (option: string): boolean => option === "Device.SelfHealing";
    unreachable.host.isReachable = false;
    unreachable.double.throwError(new ProtectLivestreamUnavailableError("the livestream gave up", { attempts: 10, phase: "recovering" }));

    await settle();

    assert.equal(unreachable.host.rebootCalls.length, 0, "no reboot when the camera is unreachable");

    // The shuttingDown disjunct, set through the threaded TestProtectNvr - production ProtectNvr.phase is getter-only, so the host's nvr handle cannot set it, but the
    // TestProtectNvr the harness threads out is the same instance the timeshift reads via protectCamera.nvr.phase.
    const shuttingDown = await buildStartedTimeshift();

    shuttingDown.host.hasFeature = (option: string): boolean => option === "Device.SelfHealing";
    shuttingDown.host.isReachable = true;
    shuttingDown.nvr.phase = "shuttingDown";
    shuttingDown.double.throwError(new ProtectLivestreamUnavailableError("the livestream gave up", { attempts: 10, phase: "recovering" }));

    await settle();

    assert.equal(shuttingDown.host.rebootCalls.length, 0, "no reboot while the nvr is shutting down");
  });

  // Target (cc): selfHeal ignores an iterator error that is NOT the recovery give-up. A plain error thrown into the iterator is classified and logged by the shared
  // handler but takes selfHeal's first early return (the !instanceof ProtectLivestreamUnavailableError arm), so no reboot is attempted even with self-healing enabled and
  // the camera reachable. This pins the give-up-only gating of the reboot.
  test("selfHeal does not reboot on an iterator error that is not the recovery give-up", async () => {

    const { double, host } = await buildStartedTimeshift();

    host.hasFeature = (option: string): boolean => option === "Device.SelfHealing";
    host.isReachable = true;
    double.throwError(new Error("an unexpected iterator failure"));

    await settle();

    assert.equal(host.rebootCalls.length, 0, "no reboot on a non-give-up iterator error");
  });

  // Target (dd): the reboot-failure path. When the recovery give-up fires the reboot but reboot() rejects, the timeshift records the attempted reboot and logs that the
  // camera could not be rebooted (the reboot().catch handler). We drive it via the host's settable rebootError and assert both the attempted call and the captured error
  // log - the deeper defensive branch the give-up happy path (aa) does not reach.
  test("selfHeal logs when the camera reboot fails during the give-up", async () => {

    const { double, host, logEntries } = await buildStartedTimeshift();

    host.hasFeature = (option: string): boolean => option === "Device.SelfHealing";
    host.isReachable = true;
    host.rebootError = new Error("the reboot command failed");
    double.throwError(new ProtectLivestreamUnavailableError("the livestream gave up", { attempts: 10, phase: "recovering" }));

    await settle();

    assert.equal(host.rebootCalls.length, 1, "the reboot was attempted before it failed");
    assert.ok(logEntries.some((entry) => (entry.level === "error") && String(entry.parameters[0]).includes("could not be rebooted")), "the failed reboot is logged");
  });
});
