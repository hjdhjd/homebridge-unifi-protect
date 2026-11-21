/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * timeshift.test.ts: Behavior coverage of the HKSV timeshift buffer - the first standalone net over ProtectTimeshiftBuffer.
 *
 * The timeshift buffer's public surface (the segment/discontinuity/firstKeyframe/terminated events, the start/stop/transmit lifecycle, the buffer/livePreload/
 * snapshotSource/getKeyframeAlignedStart read helpers, and the selfHeal reboot) has only ever been exercised indirectly through the recording-delegate suites. This suite
 * drives it as a STANDALONE unit - there is no recording delegate in the loop, so the timeshift's own emission decisions are asserted directly rather than conflated with
 * a consumer's.
 *
 * The SUT is fed by the harness's controllable livestream-subscription double, which a test pushes segments into one at a time (init / keyframe / non-keyframe /
 * discontinuity-marked) and can end or throw-into. The keyframe-staleness gate - the timeshift's only time-dependent behavior - is made deterministic by the injected
 * TestClock (the very clock the timeshift reads via platform.clock), advanced explicitly rather than real-waited. The CRITICAL precondition for every snapshotSource
 * freshness assertion is the nonzero clock base: snapshotSource's guard reads "empty" when _lastKeyframeTime is falsy (zero), so a keyframe pushed at TestClock
 * virtual-time 0 is indistinguishable from "no keyframe" - every snapshotSource-fresh (and staleness-boundary) test advances the clock to a nonzero base BEFORE pushing
 * its keyframe, or the staleness compare is never reached and the test is vacuous.
 *
 * All assertions are behavior-first: emitted events, returned buffers, recorded interface calls (livestreamCalls, rebootCalls, the double's reassessCalls/disposed), and
 * the public getters - never a private field (_segments, _pendingDiscontinuity, _isTransmitting, _lastKeyframeTime, subscription). Because both the per-push forward and
 * transmitStart's own concat emit the "segment" event, forwarding tests assert on the forwarded PAYLOAD (which fragment's data), never the event count.
 */
import type { ControllableLivestreamDouble, TestCameraHost } from "./testing.helpers.ts";
import { PROTECT_LIVESTREAM_API_IDR_INTERVAL, PROTECT_TIMESHIFT_BUFFER_MAXDURATION } from "../settings.ts";
import { ProtectClient, ProtectLivestreamUnavailableError } from "unifi-protect";
import type { SegmentRole, SnapshotSource } from "./timeshift.ts";
import type { TestClock, TestLogEntry } from "homebridge-plugin-utils/testing";
import { after, describe, test } from "node:test";
import { makeChannelProfile, makeControllableLivestreamDouble, makeKeyframeFragment, makeMediaSegment, makeNonKeyframeFragment, makeTestCameraHost,
  splitFragment } from "./testing.helpers.ts";
import { makeFragment, settle } from "homebridge-plugin-utils/testing";
import { AMCREST_INIT_SEGMENT } from "../camera.fixtures.ts";
import { ProtectTimeshiftBuffer } from "./timeshift.ts";
import { SAMPLE_FLAG_NON_SYNC } from "homebridge-plugin-utils";
import type { TestProtectNvr } from "../nvr/testing.helpers.ts";
import assert from "node:assert/strict";

// The keyframe-staleness threshold the timeshift compares against: PROTECT_LIVESTREAM_API_IDR_INTERVAL (5s) doubled, in milliseconds. A keyframe older than this makes
// snapshotSource read "stale"; younger reads "fresh". The suite drives the boundary deterministically by advancing the TestClock across exactly this much.
const STALENESS_THRESHOLD_MS = PROTECT_LIVESTREAM_API_IDR_INTERVAL * 2 * 1000;

// The live-view preload's window, PROTECT_LIVESTREAM_API_IDR_INTERVAL in milliseconds: the preload a caller asking for the whole window takes, and the one a preload
// falls back to when no buffered keyframe meets its floor.
const PRELOAD_FALLBACK_MS = PROTECT_LIVESTREAM_API_IDR_INTERVAL * 1000;

// Every host this suite builds shares its makeTestNvr AbortController. Aborting them in teardown releases the harness signals so no background consume loop (the
// timeshift drives one per start) outlives the suite.
const controllers: AbortController[] = [];

after(() => {

  for(const controller of controllers) {

    controller.abort();
  }
});

// A media fragment as the suite builds one: the whole fragment and its moof and mdat halves.
type MediaFragment = ReturnType<typeof makeKeyframeFragment>;

// A fragment whose keyframe is its second sample rather than its first, so it holds a keyframe without starting with one.
function makeLaterSampleKeyframeFragment(): MediaFragment {

  return splitFragment(makeFragment({ run: { includeDuration: true, includeSize: true, usePerSampleFlags: true },
    samples: [ { duration: 3000, flags: SAMPLE_FLAG_NON_SYNC, size: 8 }, { duration: 3000, flags: 0, size: 8 } ], trackId: 1 }));
}

// A fragment whose keyframe is its second sample behind a sample that takes no time, the layout a packager writes when it carries the parameter sets in a sample of
// their own ahead of each keyframe. A decoder handed it as its first shows the keyframe first, so it starts with a keyframe though the keyframe is not its first
// sample. It differs from makeLaterSampleKeyframeFragment in the first sample's duration alone.
function makeZeroDurationLeadKeyframeFragment(): MediaFragment {

  return splitFragment(makeFragment({ run: { includeDuration: true, includeSize: true, usePerSampleFlags: true },
    samples: [ { duration: 0, flags: SAMPLE_FLAG_NON_SYNC, size: 8 }, { duration: 3000, flags: 0, size: 8 } ], trackId: 1 }));
}

// The given number of fragments that hold no keyframe, for a row that fills the buffer past the live-view preload's fallback window.
function nonKeyframeFragments(count: number): MediaFragment[] {

  return Array.from({ length: count }, () => makeNonKeyframeFragment());
}

// The bytes the given fragments carry, which a live-view preload row sets its floor from.
function bytesOf(fragments: readonly MediaFragment[]): number {

  return fragments.reduce((total, fragment) => total + fragment.data.length, 0);
}

// The exact preload a live view expects from the given fragments: the init segment's bytes, then each fragment's in order.
function preloadOf(init: Buffer, fragments: readonly MediaFragment[]): Buffer {

  return Buffer.concat([ init, ...fragments.map((fragment) => fragment.data) ]);
}

// The arranged, started timeshift plus the handles a test asserts against. clock is the controllable TestClock the timeshift reads via platform.clock (advance it to
// drive the staleness gate); double is the controllable livestream the test pushes segments into; events captures every emitted segment/discontinuity/terminated; host
// exposes the interface call logs (livestreamCalls, rebootCalls, the settable hasFeature/isReachable); nvr is the settable TestProtectNvr (set nvr.phase for the
// shuttingDown variant); timeshift is the SUT.
interface StartedTimeshift {

  clock: TestClock;
  double: ControllableLivestreamDouble;
  events: { discontinuity: number; segment: Buffer[]; terminated: number };
  host: TestCameraHost;
  logEntries: readonly TestLogEntry[];
  nvr: TestProtectNvr;
  timeshift: ProtectTimeshiftBuffer;
}

// Arrange a started timeshift driven by a controllable livestream double. Builds the host, installs the supplied subscription queue (default a single fresh controllable
// double), sets the configured buffer duration, subscribes event recorders, and awaits start() so the subscription is committed and isStarted is true. The clock starts
// at the TestClock default (zero) - a snapshotSource test advances it to a nonzero base BEFORE pushing its keyframe (the falsy-zero guard trap). configuredDuration
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

// Arrange a started timeshift at the production buffer depth holding the given fragments, oldest first, and hand back the init segment's bytes beside it so a
// live-view preload row builds the exact preload it expects. The clock moves to a nonzero base first, so a snapshotSource read in the same row finds its keyframe
// fresh. The double drains its whole queue on one wake and the buffer admits each segment as it arrives, so one settle admits every fragment, which the time
// assertion confirms before any row reads the buffer.
async function bufferFragments(fragments: readonly MediaFragment[]): Promise<{ init: Buffer; timeshift: ProtectTimeshiftBuffer }> {

  const { clock, double, timeshift } = await buildStartedTimeshift({ configuredDuration: PROTECT_TIMESHIFT_BUFFER_MAXDURATION });

  clock.advance(1000);

  for(const fragment of fragments) {

    double.push(makeMediaSegment(fragment));
  }

  await settle();

  assert.equal(timeshift.time, fragments.length * timeshift.segmentLength, "the buffer holds every fragment pushed into it");
  assert.ok(double.initSegment, "the started double carries its init segment");

  return { init: double.initSegment.data, timeshift };
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

  // The owner's commit-point check. A deferred establishment holds the start in flight; the owner's signal aborts in that window, so the start reaches its commit point
  // with its owner's lifetime already over and declines instead of committing, disposing the subscription it opened. The decline is SILENT - no "stopped" emit, exactly
  // like the establishment-failure paths, which never reach finalizeSubscription either. Against a buffer that commits regardless, this start resolves true with
  // isStarted true. The controllable double ignores the signal, so its establishment answers true after the abort, which is the one case this check exists for.
  test("start declines at the commit point when its owner's signal aborts mid-establishment", async () => {

    const double = makeControllableLivestreamDouble({ deferEstablishment: true });
    const { controller, host } = makeTestCameraHost();

    controllers.push(controller);
    host.livestreamSubscriptions = [double];

    // The owner's lifetime, aborted while the establishment is held so the start meets the aborted signal at the commit point.
    const owner = new AbortController();

    let stoppedEmits = 0;

    const timeshift = new ProtectTimeshiftBuffer(host, { signal: owner.signal });

    timeshift.on("stopped", (): void => { stoppedEmits++; });

    const startPromise = timeshift.start(makeChannelProfile(host));

    await settle();

    assert.equal(timeshift.isStarted, false, "the start is held in flight, not yet committed");

    owner.abort();
    double.releaseEstablishment();

    assert.equal(await startPromise, false, "the start whose owner's signal aborted declines rather than committing");

    await settle();

    assert.equal(timeshift.isStarted, false, "isStarted stays false");
    assert.equal(timeshift.channelProfile, null, "no channel profile committed");
    assert.equal(double.disposed, true, "the local subscription is disposed");
    assert.equal(stoppedEmits, 0, "the decline is silent, like the establishment-failure paths");
  });

  // The other side of the check: an owner's signal left unaborted throughout must leave the commit path exactly as it is. This is the wiring guard for the owner's
  // signal rather than a behavioral value - what it catches is a signal read with the wrong sense or at the wrong moment.
  test("an owner signal that never aborts leaves the commit path undisturbed", async () => {

    const double = makeControllableLivestreamDouble({ deferEstablishment: true });
    const { controller, host } = makeTestCameraHost();

    controllers.push(controller);
    host.livestreamSubscriptions = [double];

    // The owner's lifetime, left unaborted for the whole of this start's life.
    const owner = new AbortController();
    const timeshift = new ProtectTimeshiftBuffer(host, { signal: owner.signal });
    const profile = makeChannelProfile(host);
    const startPromise = timeshift.start(profile);

    await settle();

    double.releaseEstablishment();

    assert.equal(await startPromise, true, "the start whose owner's signal never aborted commits");

    await settle();

    assert.equal(timeshift.isStarted, true, "isStarted is true");
    assert.equal(timeshift.channelProfile, profile, "the channel profile committed alongside the subscription");
    assert.equal(double.disposed, false, "the committed subscription is not disposed");
  });

  // The owner's signal reaches the livestream call, which is what lets the owner's abort end the subscription. The read is by identity: the
  // options the host recorded carry the very signal the buffer was built with, rather than merely some signal, and a buffer built with no owner passes none.
  test("start hands its owner's signal to the livestream call, and an ownerless buffer passes none", async () => {

    const { controller, host } = makeTestCameraHost();

    controllers.push(controller);
    host.livestreamSubscriptions = [ makeControllableLivestreamDouble(), makeControllableLivestreamDouble() ];

    const owner = new AbortController();

    assert.equal(await new ProtectTimeshiftBuffer(host, { signal: owner.signal }).start(makeChannelProfile(host)), true, "the owned buffer started");
    assert.equal(await new ProtectTimeshiftBuffer(host).start(makeChannelProfile(host)), true, "the ownerless buffer started");

    assert.equal(host.livestreamCalls[0]?.opts?.signal, owner.signal, "the owned buffer's livestream call carries the very signal the buffer was built with");
    assert.equal(host.livestreamCalls[1]?.opts?.signal, undefined, "the ownerless buffer's livestream call carries no signal");
  });

  // The teardown report is honest: "stopped" reports every genuine teardown and only those. A stop on a buffer that never started tore nothing down, so it reports
  // nothing - while still answering true, so callers may stop unconditionally without checking first. The committed side is what proves the gate narrowed the report
  // rather than silencing the event: the same buffer, once started, reports its teardown exactly once.
  test("stop reports a teardown only when there was one to report", async () => {

    const double = makeControllableLivestreamDouble();
    const { controller, host } = makeTestCameraHost();

    controllers.push(controller);
    host.livestreamSubscriptions = [double];

    const timeshift = new ProtectTimeshiftBuffer(host);

    let stoppedEmits = 0;

    timeshift.on("stopped", (): void => { stoppedEmits++; });

    // Side one: a buffer that never started. The stop resets state already at rest, reports nothing, and still answers true.
    assert.equal(timeshift.stop(), true, "a stop on a never-started buffer still answers true");
    assert.equal(stoppedEmits, 0, "a teardown that never happened is not reported");

    // Side two: the same buffer after a committed start. Now there IS a teardown, and it is reported exactly once.
    assert.equal(await timeshift.start(makeChannelProfile(host)), true, "the start committed");

    await settle();

    assert.equal(timeshift.stop(), true, "the committed buffer stops");
    assert.equal(stoppedEmits, 1, "the genuine teardown was reported exactly once");
  });

  // Target (d): starting an already-started timeshift disposes the prior subscription and commits the new one. Two DISTINCT-id doubles are supplied via the queue; the
  // second start runs start's if(isStarted) stop() path, disposing doubleA, then commits doubleB. This is ALSO the genuine distinguishing case of the consumeSegments
  // id-identity guard (the finally's this.subscription?.id === subscription.id): start() commits doubleB BEFORE doubleA's iterator finally runs, so that finally reaches
  // the distinct-id arm (this.subscription is doubleB, doubleB.id !== doubleA.id) and no-ops. A guard-removed timeshift instead tears doubleB down here, flipping
  // isStarted false - so the isStarted assertion below is what fails when the guard is removed.
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

  // A segment still draining from a REPLACED subscription must not contaminate the restarted buffer. We queue a segment on doubleA, then restart WITHOUT settling -
  // start() disposes doubleA (which drains its queued segment before honoring disposal) and commits doubleB, so doubleA's stale segment reaches consumeSegments' loop
  // body while doubleA is no longer this.subscription. The loop-body identity guard skips it (continue), so it never enters doubleB's buffer. This is the double-restart
  // interleaving the finally-only guard does not cover: the naive single-restart is already saved by the finally, so it would not turn red.
  test("a segment draining from a replaced subscription does not contaminate the restarted buffer", async () => {

    const doubleA = makeControllableLivestreamDouble();
    const doubleB = makeControllableLivestreamDouble();
    const { host, timeshift } = await buildStartedTimeshift({ double: doubleA, subscriptions: [ doubleA, doubleB ] });

    // Queue a segment on doubleA, then restart in the same synchronous frame (no settle between) so doubleA's segment drains after doubleB is committed.
    doubleA.push(makeMediaSegment(makeKeyframeFragment()));

    await timeshift.start(makeChannelProfile(host));

    await settle();

    assert.equal(timeshift.time, 0, "the stale segment from the replaced subscription did not enter the restarted buffer");

    // The new subscription delivers a segment: only doubleB's segment is admitted, so the buffer holds exactly one segment.
    doubleB.push(makeMediaSegment(makeKeyframeFragment()));

    await settle();

    assert.equal(timeshift.time, timeshift.segmentLength, "only the new subscription's segment is buffered");
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

    double.push({ codec: "h264", data: Buffer.from("init"), description: { tracks: [] }, type: "init" });

    await settle();

    assert.equal(timeshift.time, 0, "the init segment does not add buffer time");
  });

  // Target (g): a media keyframe is buffered and keyframe-tracked. time advances by one segment, and - with a nonzero clock base - snapshotSource reads "fresh". The
  // nonzero base is the falsy-zero guard precondition: a keyframe at clock 0 sets _lastKeyframeTime 0, which snapshotSource's guard treats as "no keyframe" (empty).
  test("a media keyframe is buffered and keyframe-tracked", async () => {

    const { clock, double, timeshift } = await buildStartedTimeshift();

    clock.advance(1000);
    double.push(makeMediaSegment(makeKeyframeFragment()));

    await settle();

    assert.equal(timeshift.time, 100, "the keyframe adds one segment of buffer time");
    assert.equal(timeshift.snapshotSource().kind, "fresh", "snapshotSource reads fresh with a keyframe at a nonzero clock base");
  });

  // A fragment whose keyframe is a later sample is buffered, and the snapshot and the recording start, which count only a fragment that starts with a keyframe, are
  // served from neither it nor its keyframe. A live view's preload may start at it, which the livePreload rows cover.
  test("a fragment whose keyframe is not its first sample serves no snapshot and no recording start", async () => {

    const { clock, double, timeshift } = await buildStartedTimeshift();

    clock.advance(1000);
    double.push(makeMediaSegment(makeLaterSampleKeyframeFragment()));

    await settle();

    assert.equal(timeshift.time, 100, "the fragment adds one segment of buffer time");
    assert.equal(timeshift.snapshotSource().kind, "empty", "snapshotSource reads empty because no buffered fragment starts with a keyframe");
    assert.equal(timeshift.getKeyframeAlignedStart(0), null, "the recording start finds no keyframe to align to");
  });

  // The decisions processSegment makes count only a fragment that starts with a keyframe, so a fragment whose keyframe is a later sample announces no first keyframe,
  // arms no staleness clock and ends no reconnect's admission suppression, even though the buffer notes that it holds a keyframe for a live view's preload.
  test("a fragment whose keyframe is a later sample leaves the first-keyframe event, the staleness clock and the discontinuity resume untouched", async () => {

    const { clock, double, timeshift } = await buildStartedTimeshift();

    let fired = 0;

    timeshift.on("firstKeyframe", (): void => { fired++; });

    clock.advance(1000);
    double.push(makeMediaSegment(makeLaterSampleKeyframeFragment()));

    await settle();
    clock.advance(STALENESS_THRESHOLD_MS + 1);

    assert.equal(fired, 0, "the later-sample keyframe announces no first keyframe");
    assert.equal(timeshift.snapshotSource().kind, "empty", "the later-sample keyframe arms no staleness clock, so the buffer reads empty rather than stale");

    double.push(makeMediaSegment(makeNonKeyframeFragment(), { discontinuity: true }));

    await settle();
    double.push(makeMediaSegment(makeLaterSampleKeyframeFragment()));

    await settle();

    assert.equal(timeshift.time, 0, "the later-sample keyframe after a reconnect stays suppressed until a fragment that starts with a keyframe arrives");
  });

  // A fragment whose keyframe follows only a sample that takes no time starts with its keyframe, so the snapshot and the recording start are served from it as they
  // are from a fragment whose first sample is the keyframe. The row before the last holds the other side: a sample that takes time ahead of the keyframe serves neither.
  test("a fragment whose keyframe follows a zero-duration sample serves the snapshot and the recording start", async () => {

    const { clock, double, timeshift } = await buildStartedTimeshift();
    const fragment = makeZeroDurationLeadKeyframeFragment();

    clock.advance(1000);
    double.push(makeMediaSegment(makeNonKeyframeFragment()));
    double.push(makeMediaSegment(fragment));

    await settle();

    const source = timeshift.snapshotSource();

    assert.equal(source.kind, "fresh", "snapshotSource reads fresh because the buffered fragment starts with its keyframe");
    assert.ok(source.data.subarray(-fragment.data.length).equals(fragment.data), "the snapshot is served from that fragment");
    assert.deepEqual(timeshift.getKeyframeAlignedStart(100), { seekOffsetMs: 0, startIndex: 1 }, "a recording with one segment of prebuffer starts at that fragment");
  });

  // The decisions processSegment makes count a fragment whose keyframe follows only a sample that takes no time: it announces the first keyframe, arms the staleness
  // clock and ends a reconnect's admission suppression, as a fragment whose first sample is the keyframe does.
  test("a fragment whose keyframe follows a zero-duration sample announces the first keyframe, arms the staleness clock and resumes after a reconnect", async () => {

    const { clock, double, timeshift } = await buildStartedTimeshift();

    let fired = 0;

    timeshift.on("firstKeyframe", (): void => { fired++; });

    clock.advance(1000);
    double.push(makeMediaSegment(makeZeroDurationLeadKeyframeFragment()));

    await settle();
    clock.advance(STALENESS_THRESHOLD_MS + 1);

    assert.equal(fired, 1, "the fragment announces the first keyframe");
    assert.equal(timeshift.snapshotSource().kind, "stale", "the fragment arms the staleness clock, so the buffer reads stale rather than empty once it ages");

    double.push(makeMediaSegment(makeNonKeyframeFragment(), { discontinuity: true }));

    await settle();

    assert.equal(timeshift.time, 0, "the reconnect clears the buffer and suppresses admission");

    double.push(makeMediaSegment(makeZeroDurationLeadKeyframeFragment()));

    await settle();

    assert.equal(timeshift.time, 100, "the fragment ends the reconnect's suppression and is admitted");
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

    // Capture each emission's role directly, locking in the producer side of the tagging contract: transmitStart's prebuffer concat must carry "blob" and a per-fragment
    // forward must carry "live". The recording delegate's counting split branches on these tags - the mutation that turns this red is flipping processSegment's forward
    // to "blob" (or transmitStart's emit to "live"), which would silently corrupt the transmitted-video tally.
    const roles: SegmentRole[] = [];

    timeshift.on("segment", (_data, role) => roles.push(role));

    double.push(makeMediaSegment(keyframe));

    await settle();
    timeshift.transmitStart();

    const pushed = makeMediaSegment(makeNonKeyframeFragment());

    double.push(pushed);

    await settle();

    assert.ok(events.segment.some((payload) => payload.equals(pushed.data)), "a forwarded segment carries the pushed fragment's payload");
    assert.deepEqual(roles, [ "blob", "live" ], "the prebuffer emission is tagged blob and the per-fragment forward is tagged live");
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

  // Target (k): the discontinuity keyframe-gate, required for correctness. While transmitting, a discontinuity-marked NON-keyframe segment defers the discontinuity
  // emit and suppresses forwarding until a clean keyframe arrives. We settle after EACH push so the intermediate deferred state is observable (multiple pushes + one
  // settle would drain all in one macrotask and hide the defer). The non-keyframe choice is deliberate: a discontinuity-marked keyframe emits immediately and the gate
  // is untested.
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

  // Target (l): the discontinuity EVENT is transmit-gated. Buffer hygiene arms and clears on every reconnect, transmitting or not, but the consumer-facing discontinuity
  // notification only fires while transmitting. While NOT transmitting, a discontinuity-marked segment then a keyframe run the buffer hygiene and disarm silently - no
  // discontinuity event fires, because no consumer is listening for a decoder restart. This is the negative contrast to (k).
  test("the discontinuity event stays transmit-gated on an idle reconnect", async () => {

    const { double, events, timeshift } = await buildStartedTimeshift();

    double.push(makeMediaSegment(makeNonKeyframeFragment(), { discontinuity: true }));

    await settle();

    double.push(makeMediaSegment(makeKeyframeFragment()));

    await settle();

    assert.equal(timeshift.isTransmitting, false, "the timeshift is not transmitting");
    assert.equal(events.discontinuity, 0, "no discontinuity event fires off-transmit");
  });

  // Buffer hygiene runs on EVERY reconnect: a non-empty IDLE buffer is cleared on a discontinuity, and admission is suppressed until the recovery keyframe, so
  // the standing buffer never holds mixed-timeline or pre-keyframe data even when no HKSV session is transmitting. A NON-empty buffer is used deliberately - clearing an
  // already-empty one is observationally vacuous.
  test("an idle reconnect clears the standing buffer and suppresses admission until the recovery keyframe", async () => {

    const { double, timeshift } = await buildStartedTimeshift();

    // Fill the idle buffer (not transmitting) with a keyframe and a following fragment.
    double.push(makeMediaSegment(makeKeyframeFragment()));

    await settle();

    double.push(makeMediaSegment(makeNonKeyframeFragment()));

    await settle();

    assert.ok(timeshift.buffer, "the idle buffer holds pre-reconnect segments");

    // A discontinuity-marked non-keyframe: buffer hygiene clears the stale timeline and admission suppression drops this mid-GOP fragment.
    double.push(makeMediaSegment(makeNonKeyframeFragment(), { discontinuity: true }));

    await settle();

    assert.equal(timeshift.buffer, null, "the idle reconnect cleared the buffer and the mid-GOP fragment was not admitted");

    // A further pre-keyframe fragment stays suppressed.
    double.push(makeMediaSegment(makeNonKeyframeFragment()));

    await settle();

    assert.equal(timeshift.buffer, null, "admission stays suppressed until the recovery keyframe");

    // The recovery keyframe is admitted, resuming the buffer.
    double.push(makeMediaSegment(makeKeyframeFragment()));

    await settle();

    assert.ok(timeshift.buffer, "the recovery keyframe is admitted and the buffer resumes");
  });

  // Admission suppression survives a mid-window HKSV session close: transmitStop does not clear the pending discontinuity, so a session ending between the
  // reconnect and the recovery keyframe leaves suppression in force and the standing buffer timeline-clean for the next consumer.
  test("admission suppression survives a mid-window HKSV session close", async () => {

    const { double, timeshift } = await buildStartedTimeshift();

    double.push(makeMediaSegment(makeKeyframeFragment()));

    await settle();
    timeshift.transmitStart();

    // A discontinuity-marked non-keyframe arms suppression and clears the buffer while transmitting.
    double.push(makeMediaSegment(makeNonKeyframeFragment(), { discontinuity: true }));

    await settle();

    assert.equal(timeshift.buffer, null, "the discontinuity cleared the buffer and the mid-GOP fragment was not admitted");

    // The HKSV session closes mid-window. Suppression must survive it.
    timeshift.transmitStop();

    // A further non-keyframe after the close stays suppressed.
    double.push(makeMediaSegment(makeNonKeyframeFragment()));

    await settle();

    assert.equal(timeshift.buffer, null, "admission stayed suppressed across the session close");

    // The recovery keyframe is admitted.
    double.push(makeMediaSegment(makeKeyframeFragment()));

    await settle();

    assert.ok(timeshift.buffer, "the recovery keyframe is admitted after the session close");
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
  // terminated. This is the explicit-stop teardown path - the first of the consumeSegments teardown identities: stop() synchronously clears the subscription and
  // fires the one terminated, and doubleA's iterator finally then runs while the subscription is undefined, so it no-ops via the undefined short-circuit. (The
  // id-identity guard's distinct-id arm - a prior subscription's finally running while a NEW subscription is committed - is the SEPARATE path that target (d) genuinely
  // tells apart; here doubleA's teardown completes before doubleB starts, so this test exercises the explicit-stop path, not the distinct-id arm.)
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

    assert.equal(result, null, "transmitStart returns null (declines) when not started");
    assert.ok(logEntries.some((entry) => (entry.level === "error") && entry.message.includes("HKSV event recording unavailable")),
      "transmitStart logs the not-ready error");
  });

  // Target (r): transmitStart success. With a started, buffer-filled timeshift (two buffered fragments), transmitStart emits a "segment" event whose payload is the
  // init + buffer concat, returns the real blob fragment count (two, the whole buffer with no startIndex), flips isTransmitting true, and calls reassess once.
  test("transmitStart emits the init-plus-buffer concat, returns the blob fragment count, and escalates recovery", async () => {

    const { double, events, timeshift } = await buildStartedTimeshift();
    const first = makeKeyframeFragment();
    const second = makeKeyframeFragment();

    double.push(makeMediaSegment(first));

    await settle();
    double.push(makeMediaSegment(second));

    await settle();

    const result = timeshift.transmitStart();

    assert.equal(result, 2, "transmitStart returns the two-fragment blob count on a started, filled timeshift");
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

  // Target (t): transmitStop flips isTransmitting false but does NOT clear the pending discontinuity - admission suppression survives a session close so the standing
  // buffer stays timeline-clean for the next consumer. A discontinuity-marked push, then transmitStop, then a keyframe emits no discontinuity event: the keyframe disarms
  // suppression, but the event is transmit-gated and we are no longer transmitting.
  test("transmitStop stops transmitting without emitting a later discontinuity", async () => {

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

    assert.equal(events.discontinuity, 0, "the later keyframe emits no discontinuity: the event is transmit-gated and transmitStop stopped transmitting");
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

  // The live-view preload rows each assert the exact preload: the init segment, then every fragment from the start livePreload picks.

  // The preload starts at the latest fragment holding a keyframe and carries every fragment after it. A zero floor is met from any keyframe, so the start is the
  // latest keyframe rather than an older one.
  test("livePreload starts at the latest keyframe and carries every fragment after it", async () => {

    const fragments = [ makeKeyframeFragment(), makeNonKeyframeFragment(), makeKeyframeFragment(), makeNonKeyframeFragment(), makeNonKeyframeFragment() ];
    const { init, timeshift } = await bufferFragments(fragments);

    assert.deepEqual(timeshift.livePreload(0), preloadOf(init, fragments.slice(2)), "the preload is the init segment, the latest keyframe and every fragment after it");
  });

  // A fragment whose keyframe is a later sample is a live-view start, because FFmpeg drops the samples ahead of the keyframe. A snapshot hands FFmpeg its fragment from
  // the first byte, so in the same buffer it still comes from the older fragment that starts with a keyframe.
  test("livePreload starts at a fragment whose keyframe is a later sample while snapshotSource serves the older first-sample keyframe", async () => {

    const startsWithKeyframe = makeKeyframeFragment();
    const fragments = [ startsWithKeyframe, makeNonKeyframeFragment(), makeLaterSampleKeyframeFragment(), makeNonKeyframeFragment() ];
    const { init, timeshift } = await bufferFragments(fragments);
    const source = timeshift.snapshotSource();

    assert.deepEqual(timeshift.livePreload(0), preloadOf(init, fragments.slice(2)), "the preload starts at the fragment whose keyframe is its second sample");
    assert.equal(source.kind, "fresh", "snapshotSource reads fresh from the older fragment that starts with a keyframe");
    assert.deepEqual(source.data, preloadOf(init, [startsWithKeyframe]), "the snapshot is the init segment and the fragment that starts with a keyframe");
  });

  // With no keyframe buffered, the preload is the last PROTECT_LIVESTREAM_API_IDR_INTERVAL seconds of fragments, or the whole buffer when it is shorter. The oldest
  // fragments of the longer buffer differ in their bytes from the newer ones, so the exact preload shows the window keeps the newest fragments and drops the oldest.
  test("livePreload with no keyframe buffered is the last keyframe interval of fragments, or the whole buffer when shorter", async () => {

    const older = splitFragment(makeFragment({ run: { includeDuration: true, includeSize: true, sampleFlagsValue: SAMPLE_FLAG_NON_SYNC, useFirstSampleFlags: true },
      samples: [{ duration: 3000, size: 8 }], trackId: 1 }));
    const longer = [ ...Array.from({ length: 10 }, () => older), ...nonKeyframeFragments(50) ];
    const long = await bufferFragments(longer);
    const windowFragments = PRELOAD_FALLBACK_MS / long.timeshift.segmentLength;

    assert.ok(long.timeshift.time > PRELOAD_FALLBACK_MS, "the longer buffer holds more than the fallback window");
    assert.deepEqual(long.timeshift.livePreload(0), preloadOf(long.init, longer.slice(-windowFragments)),
      "the longer buffer's preload is the init segment and its newest fragments across the fallback window");

    const shorter = [ older, makeNonKeyframeFragment(), makeNonKeyframeFragment() ];
    const short = await bufferFragments(shorter);

    assert.deepEqual(short.timeshift.livePreload(0), preloadOf(short.init, shorter), "the shorter buffer's preload is the init segment and the whole buffer");
  });

  // The preload is null with nothing buffered: on a started buffer before its first fragment, and once a stop has cleared the buffer and released its init segment.
  test("livePreload is null with nothing buffered", async () => {

    const { double, timeshift } = await buildStartedTimeshift();

    assert.equal(timeshift.livePreload(0), null, "the preload is null on a started buffer before its first fragment");

    double.push(makeMediaSegment(makeKeyframeFragment()));

    await settle();

    assert.ok(timeshift.livePreload(0), "the preload carries the buffered fragment before the stop");

    timeshift.stop();

    assert.equal(timeshift.livePreload(0), null, "the preload is null once a stop has cleared the buffer");
  });

  // A latest keyframe whose fragments to the buffer's end fall short of the floor stays the first picture FFmpeg decodes. The start backs up from it a fragment at a
  // time and stops at the first fragment from which the bytes meet the floor, because FFmpeg discards the frames ahead of the keyframe and still reads them toward its
  // probe. Each floor sits one byte past what the fragment after the expected start leaves, so a floor that counted the init segment would stop a fragment short, and
  // the second start lies past an older keyframe, which the start does not stop at.
  test("livePreload backs up from the latest keyframe only as far as the floor needs", async () => {

    const fragments = [ makeNonKeyframeFragment(), makeKeyframeFragment(), makeNonKeyframeFragment(), makeKeyframeFragment(), makeNonKeyframeFragment(),
      makeKeyframeFragment(), makeNonKeyframeFragment() ];
    const { init, timeshift } = await bufferFragments(fragments);

    assert.deepEqual(timeshift.livePreload(bytesOf(fragments.slice(5)) + 1), preloadOf(init, fragments.slice(4)),
      "the start backs up one fragment when the latest keyframe leaves one byte less than the floor");
    assert.deepEqual(timeshift.livePreload(bytesOf(fragments.slice(3)) + 1), preloadOf(init, fragments.slice(2)),
      "the start backs up past an older keyframe to the first fragment that meets the floor");
  });

  // The latest keyframe is the start however far back it sits, and backing up applies only inside the fallback window. Here the keyframe sits older than that window:
  // the preload starts at it when the floor is met, and stays there under a floor nothing meets rather than moving forward to the window.
  test("livePreload starts at the latest keyframe when it sits older than the fallback window", async () => {

    const fragments = [ makeKeyframeFragment(), ...nonKeyframeFragments(59) ];
    const { init, timeshift } = await bufferFragments(fragments);

    assert.ok(timeshift.time > PRELOAD_FALLBACK_MS, "the buffer holds more than the fallback window");
    assert.deepEqual(timeshift.livePreload(0), preloadOf(init, fragments), "the preload starts at the keyframe, beyond the fallback window");
    assert.deepEqual(timeshift.livePreload(bytesOf(fragments) + 1), preloadOf(init, fragments), "a floor nothing meets leaves the start at the keyframe");
  });

  // The start never backs up past the fallback window. When the floor is more than that window holds, the preload is the window a buffer with no keyframe gets: the
  // last PROTECT_LIVESTREAM_API_IDR_INTERVAL seconds of fragments, or the whole buffer when it is shorter. The longer buffer's window starts between its keyframes, so
  // it differs from a start at any of them.
  test("livePreload backs up no further than the last keyframe interval of fragments when the floor is more than it holds", async () => {

    const longer = [ makeKeyframeFragment(), ...nonKeyframeFragments(29), makeKeyframeFragment(), ...nonKeyframeFragments(29) ];
    const long = await bufferFragments(longer);
    const windowFragments = PRELOAD_FALLBACK_MS / long.timeshift.segmentLength;

    assert.ok(long.timeshift.time > PRELOAD_FALLBACK_MS, "the longer buffer holds more than the fallback window");
    assert.deepEqual(long.timeshift.livePreload(bytesOf(longer) + 1), preloadOf(long.init, longer.slice(-windowFragments)),
      "the longer buffer's preload is the init segment and its newest fragments across the fallback window");

    const shorter = [ makeNonKeyframeFragment(), makeKeyframeFragment(), makeNonKeyframeFragment() ];
    const short = await bufferFragments(shorter);

    assert.deepEqual(short.timeshift.livePreload(bytesOf(shorter) + 1), preloadOf(short.init, shorter),
      "the shorter buffer's preload is the init segment and the whole buffer");
  });

  // A floor equal to the bytes from the latest keyframe to the buffer's end is met, so the latest keyframe is the start.
  test("livePreload takes the latest keyframe when its fragments meet the floor exactly", async () => {

    const fragments = [ makeNonKeyframeFragment(), makeKeyframeFragment(), makeNonKeyframeFragment(), makeKeyframeFragment(), makeNonKeyframeFragment() ];
    const { init, timeshift } = await bufferFragments(fragments);

    assert.deepEqual(timeshift.livePreload(bytesOf(fragments.slice(3))), preloadOf(init, fragments.slice(3)),
      "the preload starts at the latest keyframe when its fragments carry exactly the floor");
  });

  // The whole-window rows each assert the exact preload a caller asking for the whole window is handed: the init segment, then every fragment from the window's
  // start to the buffer's end.

  // The whole window starts at the window's own start whatever the keyframes around it. This buffer's latest keyframe sits mid-window and an older one sits before
  // the window, so a start at any keyframe it holds differs from the window's, and the keyframe start a view that does not ask for the window takes is read beside it.
  test("livePreload with the whole window asked for starts at the window's start, wherever the keyframes sit", async () => {

    const fragments = [ ...nonKeyframeFragments(10), makeKeyframeFragment(), ...nonKeyframeFragments(29), makeKeyframeFragment(), ...nonKeyframeFragments(29) ];
    const { init, timeshift } = await bufferFragments(fragments);
    const windowFragments = PRELOAD_FALLBACK_MS / timeshift.segmentLength;

    assert.ok(timeshift.time > PRELOAD_FALLBACK_MS, "the buffer holds more than the window");
    assert.deepEqual(timeshift.livePreload(0), preloadOf(init, fragments.slice(40)), "the vacuity guard: without the whole window the preload starts at the keyframe");
    assert.deepEqual(timeshift.livePreload(0, { wholeWindow: true }), preloadOf(init, fragments.slice(-windowFragments)),
      "the whole window is the init segment and the newest fragments across the window, from its start rather than from a keyframe");
  });

  // With no keyframe buffered, the whole window is still the window: the newest fragments across it, never the whole buffer and never nothing.
  test("livePreload with the whole window asked for and no keyframe buffered is the window's fragments", async () => {

    const fragments = nonKeyframeFragments(60);
    const { init, timeshift } = await bufferFragments(fragments);
    const windowFragments = PRELOAD_FALLBACK_MS / timeshift.segmentLength;

    assert.ok(timeshift.time > PRELOAD_FALLBACK_MS, "the buffer holds more than the window");
    assert.deepEqual(timeshift.livePreload(0, { wholeWindow: true }), preloadOf(init, fragments.slice(-windowFragments)),
      "the whole window is the init segment and the newest fragments across the window");
  });

  // A buffer shorter than the window is the whole window entire, though its latest keyframe would give a view that does not ask for the window a shorter preload.
  test("livePreload with the whole window asked for is the whole buffer when the buffer is shorter than the window", async () => {

    const fragments = [ makeNonKeyframeFragment(), makeKeyframeFragment(), makeNonKeyframeFragment(), makeKeyframeFragment(), makeNonKeyframeFragment() ];
    const { init, timeshift } = await bufferFragments(fragments);

    assert.deepEqual(timeshift.livePreload(0), preloadOf(init, fragments.slice(3)), "the vacuity guard: without the whole window the preload starts at the keyframe");
    assert.deepEqual(timeshift.livePreload(0, { wholeWindow: true }), preloadOf(init, fragments), "the whole window is the init segment and the whole buffer");
  });

  // The floor plays no part in the whole window. This buffer's only keyframe sits older than the window, where a view that does not ask for the window starts under
  // any floor, so a floor more than the window carries, or more than the whole buffer carries, would back the start up past the window if it counted.
  test("livePreload with the whole window asked for takes no account of the floor", async () => {

    const fragments = [ makeKeyframeFragment(), ...nonKeyframeFragments(59) ];
    const { init, timeshift } = await bufferFragments(fragments);
    const windowFragments = PRELOAD_FALLBACK_MS / timeshift.segmentLength;
    const windowPreload = preloadOf(init, fragments.slice(-windowFragments));

    assert.deepEqual(timeshift.livePreload(bytesOf(fragments) + 1), preloadOf(init, fragments),
      "the vacuity guard: without the whole window the preload starts at the keyframe, beyond the window");
    assert.deepEqual(timeshift.livePreload(bytesOf(fragments.slice(-windowFragments)) + 1, { wholeWindow: true }), windowPreload,
      "a floor one byte past what the window carries leaves the whole window as it is");
    assert.deepEqual(timeshift.livePreload(bytesOf(fragments) + 1, { wholeWindow: true }), windowPreload,
      "a floor past what the whole buffer carries leaves the whole window as it is");
  });

  // The whole window is null with nothing buffered, as every preload is: on a started buffer before its first fragment, and once a stop has cleared the buffer.
  test("livePreload with the whole window asked for is null with nothing buffered", async () => {

    const { double, timeshift } = await buildStartedTimeshift();

    assert.equal(timeshift.livePreload(0, { wholeWindow: true }), null, "the whole window is null on a started buffer before its first fragment");

    double.push(makeMediaSegment(makeKeyframeFragment()));

    await settle();

    assert.ok(timeshift.livePreload(0, { wholeWindow: true }), "the whole window carries the buffered fragment before the stop");

    timeshift.stop();

    assert.equal(timeshift.livePreload(0, { wholeWindow: true }), null, "the whole window is null once a stop has cleared the buffer");
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

  // Target (x): snapshotSource fresh serves - with a nonzero clock base, a buffered keyframe yields a "fresh" answer carrying the minimal init + keyframe buffer and the
  // capture fps; "empty" when no keyframe has been buffered (started-but-empty, no staleness to claim). The nonzero base is the falsy-zero guard precondition.
  test("snapshotSource reads fresh with content and fps at a nonzero clock base, and empty when none buffered", async () => {

    const { clock, double, timeshift } = await buildStartedTimeshift();

    assert.equal(timeshift.snapshotSource().kind, "empty", "snapshotSource is empty with no keyframe buffered");

    clock.advance(1000);
    double.push(makeMediaSegment(makeKeyframeFragment()));

    await settle();

    const source = timeshift.snapshotSource();

    assert.equal(source.kind, "fresh", "snapshotSource reads fresh with a keyframe at a nonzero clock base");
    assert.ok(source.data.length > 0, "the fresh answer carries the init + keyframe buffer content");
    assert.ok(source.fps > 0, "the fresh answer carries the capture fps");
  });

  // Target (y): the staleness gate (the Clock payoff). Advance the clock to a nonzero base T, push a keyframe (_lastKeyframeTime = T, nonzero), then advance so
  // clock.now() - T crosses the threshold - snapshotSource reads "stale" VIA THE STALENESS COMPARE (not the falsy-zero guard). A control just under the threshold reads
  // "fresh". The keyframe MUST be pushed at nonzero T or the test is vacuous (the guard would mask the compare).
  test("snapshotSource goes stale past the threshold and stays fresh under it", async () => {

    // Fresh control: advance to a nonzero base, push the keyframe, advance to just UNDER the threshold - the keyframe reads fresh via the staleness compare.
    const fresh = await buildStartedTimeshift();

    fresh.clock.advance(1000);
    fresh.double.push(makeMediaSegment(makeKeyframeFragment()));

    await settle();
    fresh.clock.advance(STALENESS_THRESHOLD_MS - 1);

    assert.equal(fresh.timeshift.snapshotSource().kind, "fresh", "snapshotSource reads fresh just under the staleness threshold");

    // Stale case: same nonzero-base keyframe, then advance to just OVER the threshold - the keyframe reads stale via the compare.
    const stale = await buildStartedTimeshift();

    stale.clock.advance(1000);
    stale.double.push(makeMediaSegment(makeKeyframeFragment()));

    await settle();
    stale.clock.advance(STALENESS_THRESHOLD_MS + 1);

    assert.equal(stale.timeshift.snapshotSource().kind, "stale", "snapshotSource reads stale just over the staleness threshold, via the staleness compare");
  });

  // Target (x-trim): snapshotSource reads "empty" when the only keyframe has been trimmed out of the buffer even though _lastKeyframeTime is still fresh. The buffer trim
  // shifts the oldest segment without resetting the keyframe time, so this reaches snapshotSource's final return - the guard and the staleness compare both pass, but the
  // backward walk finds no keyframe in the buffer, so it declines as "empty" (there is content, but none of it is decodable, and no staleness to claim). A reachable
  // branch distinct from the no-keyframe-yet and stale arms.
  test("snapshotSource reads empty when its only keyframe has been trimmed out of a fresh buffer", async () => {

    const { clock, double, timeshift } = await buildStartedTimeshift({ configuredDuration: 200 });

    // Buffer one keyframe at a nonzero base, then push two non-keyframes so the keyframe is evicted (configuredDuration 200ms caps the buffer at two 100ms segments). The
    // clock stays at the nonzero base, so the keyframe time is fresh and only the empty backward walk declines. Non-keyframes never update the keyframe time.
    clock.advance(1000);
    double.push(makeMediaSegment(makeKeyframeFragment()));

    await settle();
    double.push(makeMediaSegment(makeNonKeyframeFragment()));

    await settle();
    double.push(makeMediaSegment(makeNonKeyframeFragment()));

    await settle();

    assert.equal(timeshift.snapshotSource().kind, "empty", "snapshotSource reads empty once its only keyframe has been trimmed out, despite a fresh keyframe time");
  });

  // firstKeyframe.

  // The event keys on the first keyframe a start admits, not on the first segment, and fires once: a non-keyframe admitted ahead of it fires nothing, and a later
  // keyframe on the same start fires nothing more.
  test("firstKeyframe fires once at the first keyframe a start admits, and not for a later keyframe", async () => {

    const { clock, double, timeshift } = await buildStartedTimeshift();

    let fired = 0;

    timeshift.on("firstKeyframe", (): void => { fired++; });
    clock.advance(1000);
    double.push(makeMediaSegment(makeNonKeyframeFragment()));

    await settle();

    assert.equal(fired, 0, "a non-keyframe admitted first fires nothing");

    double.push(makeMediaSegment(makeKeyframeFragment()));

    await settle();

    assert.equal(fired, 1, "the first keyframe the start admits fires the event");

    double.push(makeMediaSegment(makeKeyframeFragment()));

    await settle();

    assert.equal(fired, 1, "a later keyframe on the same start fires nothing more");
  });

  // Each start announces its own first keyframe, so a stop and a new start fire the event again at the new subscription's first keyframe.
  test("firstKeyframe fires again at the first keyframe after a stop and a new start", async () => {

    const doubleA = makeControllableLivestreamDouble();
    const doubleB = makeControllableLivestreamDouble();
    const { clock, host, timeshift } = await buildStartedTimeshift({ double: doubleA, subscriptions: [ doubleA, doubleB ] });

    let fired = 0;

    timeshift.on("firstKeyframe", (): void => { fired++; });
    clock.advance(1000);
    doubleA.push(makeMediaSegment(makeKeyframeFragment()));

    await settle();

    assert.equal(fired, 1, "the first start's first keyframe fired the event");

    timeshift.stop();

    await settle();

    assert.equal(await timeshift.start(makeChannelProfile(host)), true, "the new start committed");

    doubleB.push(makeMediaSegment(makeKeyframeFragment()));

    await settle();

    assert.equal(fired, 2, "the new start's first keyframe fired the event again");
  });

  // The event fires once the keyframe is in the buffer, so a listener reading snapshotSource() inside it is served that keyframe fresh: the init segment followed by the
  // keyframe fragment's own bytes. An event fired ahead of the admission would read empty here.
  test("a firstKeyframe listener reads the keyframe through a fresh snapshotSource", async () => {

    const { clock, double, timeshift } = await buildStartedTimeshift();
    const fragment = makeKeyframeFragment();
    const sources: SnapshotSource[] = [];

    timeshift.on("firstKeyframe", (): void => { sources.push(timeshift.snapshotSource()); });
    clock.advance(1000);
    double.push(makeMediaSegment(fragment));

    await settle();

    const [source] = sources;

    assert.equal(sources.length, 1, "the listener ran once");
    assert.equal(source?.kind, "fresh", "the listener's snapshotSource reads fresh");
    assert.ok(source.data.subarray(-fragment.data.length).equals(fragment.data), "the fresh source ends with the admitted keyframe's bytes");
  });

  // getters.

  // Target (z): isRestarting reflects the double's state (recovering -> true, live -> false); the configuredDuration round-trip is what tells the two arms apart (set
  // 250 -> get 300 via Math.ceil(250/100)=3 segments; set 0 -> get 100, floored at one segment); segmentLength is 100; time is 0 on a started-but-empty buffer.
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
    assert.ok(logEntries.some((entry) => (entry.level === "warn") && entry.message.includes("Rebooting the camera to recover its livestream") &&
      (entry.params[0] === "10")), "the reboot is announced with a warn carrying the failed-attempt count");
  });

  // Target (bb): reboot does NOT fire on the recovery give-up's negatives. attempts below the threshold takes the first early return; the second early-return guard's
  // disjuncts - self-healing disabled, the camera unreachable, and the nvr shutting down - each independently suppress the reboot. Each leaves rebootCalls empty.
  // (The reboot().catch rejection path is exercised separately below, by the test that sets rebootError.)
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
  // the camera reachable. This locks in the give-up-only gating of the reboot.
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
    assert.ok(logEntries.some((entry) => (entry.level === "error") && entry.message.includes("could not be rebooted")), "the failed reboot is logged");
  });
});

describe("the timeshift buffer's stream formats and its adopted subscription", () => {

  // The Amcrest's init, described by unifi-protect: the description a started buffer reports its audio and video formats from.
  const AMCREST_DESCRIPTION = ProtectClient.describeInitSegment(AMCREST_INIT_SEGMENT);

  test("audioFormat reads the started subscription's init description, and nothing before a start", async () => {

    const { controller, host } = makeTestCameraHost();

    controllers.push(controller);

    const timeshift = new ProtectTimeshiftBuffer(host);

    assert.equal(timeshift.audioFormat, null, "a buffer that never started reports no audio format");

    host.livestreamSubscriptions = [makeControllableLivestreamDouble({ description: AMCREST_DESCRIPTION })];

    assert.equal(await timeshift.start(makeChannelProfile(host)), true, "the buffer started");
    assert.deepEqual(timeshift.audioFormat, { channels: 1, codec: "aac", sampleRate: 8000 }, "the started buffer reports the Amcrest's audio format");

    timeshift.stop();

    assert.equal(timeshift.audioFormat, null, "a stopped buffer reports no audio format");
  });

  test("videoFormat reads the started subscription's init description, and nothing before a start or after a stop", async () => {

    const { controller, host } = makeTestCameraHost();

    controllers.push(controller);

    const timeshift = new ProtectTimeshiftBuffer(host);

    assert.equal(timeshift.videoFormat, null, "a buffer that never started reports no video format");

    host.livestreamSubscriptions = [makeControllableLivestreamDouble({ description: AMCREST_DESCRIPTION })];

    assert.equal(await timeshift.start(makeChannelProfile(host)), true, "the buffer started");
    assert.deepEqual(timeshift.videoFormat, { codec: "h264", height: 1944, width: 2592 }, "the started buffer reports the Amcrest's video format");

    timeshift.stop();

    assert.equal(timeshift.videoFormat, null, "a stopped buffer reports no video format");
  });

  // The subscription the camera's derivation opened is handed to the start, which commits it in place of a fresh one, so no second subscribe reaches the host.
  test("a start with an adopted subscription commits it without subscribing, and declines one whose init is null", async () => {

    const { controller, host } = makeTestCameraHost();

    controllers.push(controller);

    const timeshift = new ProtectTimeshiftBuffer(host);
    const adopted = makeControllableLivestreamDouble({ description: AMCREST_DESCRIPTION });

    assert.equal(await timeshift.start(makeChannelProfile(host), adopted), true, "the adopted subscription committed");
    assert.equal(host.livestreamCalls.length, 0, "the start opened no subscription of its own");
    assert.equal(timeshift.isStarted, true, "the buffer runs on the adopted subscription");
    assert.deepEqual(timeshift.audioFormat, { channels: 1, codec: "aac", sampleRate: 8000 }, "the buffer reads its format from the adopted subscription");

    timeshift.stop();

    assert.equal(adopted.disposed, true, "a stop disposes the adopted subscription it committed");

    const initless = makeControllableLivestreamDouble({ initSegment: null });

    assert.equal(await timeshift.start(makeChannelProfile(host), initless), false, "an adopted subscription with no init declines, as a fresh one does");
    assert.equal(host.livestreamCalls.length, 0, "the declined start opened no subscription of its own either");
    assert.equal(initless.disposed, true, "the declined adopted subscription is disposed");
    assert.equal(timeshift.isStarted, false, "the buffer stays stopped");
  });
});
