/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * testing.helpers.test.ts: Unit tests for the media-subsystem test helpers in testing.helpers.ts.
 *
 * The fragment builders and livestream doubles feed a REAL timeshift buffer, so a defect in one would be read as a parser or recovery bug in the code under test. These
 * rows hold the helpers to what they claim: fragments the production keyframe parse accepts and rejects, a controllable subscription whose segments, establishment,
 * init segment, state, and disposal a recovery test steers, a splitter whose halves are the fragment's own, and a teardown that ends every streaming process and
 * one-shot run double a row left running.
 */
import { TestExecProcessFactory, TestStreamingProcessFactory, expectAt, settle } from "homebridge-plugin-utils/testing";
import { describe, test } from "node:test";
import { endPendingProcesses, makeControllableLivestreamDouble, makeKeyframeFragment, makeLivestreamSubscriptionDouble, makeMediaSegment, makeNonKeyframeFragment,
  splitFragment } from "./testing.helpers.ts";
import type { FfmpegProcessExitInfo } from "homebridge-plugin-utils";
import type { Segment } from "unifi-protect";
import { TestStreamingDelegate } from "../testing.helpers.ts";
import assert from "node:assert/strict";
import { findKeyframe } from "homebridge-plugin-utils";

describe("harness growth: the recording transmit doubles", () => {

  // The keyframe-fragment box builder must synthesize a genuine fMP4 fragment that starts with a keyframe by the PRODUCTION check, findKeyframe answering zero - there
  // is no keyframe injection point to substitute a fake, so the transmit test exercises the real fMP4 keyframe coupling. If the builder ever drifts (a wrong box
  // nesting, a flipped TRUN flag, the NON_SYNC bit set), production would read these segments as non-keyframes and the timeshift's keyframe-aligned start would never
  // resolve.
  test("makeKeyframeFragment synthesizes a fragment the production findKeyframe check reads as starting with a keyframe", () => {

    assert.equal(findKeyframe(makeKeyframeFragment().data), 0, "the synthesized moof>traf>trun fragment's first sample reads as a sync sample (keyframe)");
  });

  // The established (segment-yielding) livestream double reports the live profile and yields one init segment then exactly the requested media segments. We drain the
  // iterator to the requested count rather than to completion, because the established iterator PARKS after its media loop (never returning done) - a finite drain would
  // hang. The drain therefore pulls exactly initCount + mediaSegments items and stops.
  test("makeLivestreamSubscriptionDouble established profile yields one init then the requested media segments", async () => {

    const subscription = makeLivestreamSubscriptionDouble({ mediaSegments: 3 });

    assert.equal(subscription.state, "live", "the established profile reports the live state");
    assert.ok(subscription.initSegment, "the established profile populates its init segment");
    assert.equal(await subscription.whenEstablished(), true, "the established profile resolves whenEstablished true");

    const segments: Segment[] = [];
    const iterator = subscription[Symbol.asyncIterator]();

    // Pull exactly four items - the init segment plus the three media segments - then stop, because the iterator parks rather than completing.
    for(let i = 0; i < 4; i++) {

      // eslint-disable-next-line no-await-in-loop -- The pulls are intentionally serial: we walk the async iterator one yield at a time up to its park point.
      const result = await iterator.next();

      assert.equal(result.done, false, "the iterator yields its init and media segments before parking");

      segments.push(result.value);
    }

    assert.equal(segments.filter((segment) => segment.type === "init").length, 1, "exactly one init segment was yielded");
    assert.equal(segments.filter((segment) => segment.type === "media").length, 3, "exactly three media segments were yielded");

    // Release the park so the iterator does not leak past the test.
    await subscription[Symbol.asyncDispose]();
  });

  // The inert (default) profile is unchanged: it backs the construction suites, which must stay on their segment-less path. A regression that accidentally made the
  // default established would fill those suites' timeshift buffers and change their behavior.
  test("makeLivestreamSubscriptionDouble default profile is the unchanged inert double", async () => {

    const subscription = makeLivestreamSubscriptionDouble();

    assert.equal(subscription.initSegment, null, "the inert profile has no init segment");
    assert.equal(subscription.state, "closed", "the inert profile reports the closed state");
    assert.equal(await subscription.whenEstablished(), false, "the inert profile resolves whenEstablished false");

    const segments: Segment[] = [];

    for await(const segment of subscription) {

      segments.push(segment);
    }

    assert.equal(segments.length, 0, "the inert profile's iterator yields nothing and completes");
  });
});

describe("harness growth: the timeshift behavior doubles", () => {

  // The non-keyframe builder is the negative counterpart to the held keyframe self-test: it must synthesize a fragment the PRODUCTION findKeyframe check finds no
  // keyframe in, so the timeshift suite's discontinuity keyframe-gate (a discontinuity-marked non-keyframe must defer until a clean keyframe) is genuinely exercised and
  // its live-view preload rows read the fragment as holding no keyframe at all. There is no keyframe injection point to substitute a fake, so the only way to drive the
  // non-keyframe path is real bytes with the SAMPLE_FLAG_NON_SYNC bit set.
  test("makeNonKeyframeFragment synthesizes a fragment the production findKeyframe check finds no keyframe in", () => {

    assert.equal(findKeyframe(makeNonKeyframeFragment().data), null, "the synthesized non-sync fragment reads as holding no keyframe");
  });

  // The controllable double, pushed once then iterated, yields exactly that pushed segment. The first next() runs the generator from the top, drains the one queued
  // segment, and yields it. We release the park afterwards so the iterator does not leak past the test.
  test("makeControllableLivestreamDouble yields a pushed segment", async () => {

    const double = makeControllableLivestreamDouble();
    const segment = makeMediaSegment(makeKeyframeFragment());

    double.push(segment);

    const iterator = double[Symbol.asyncIterator]();
    const result = await iterator.next();

    assert.equal(result.done, false, "the iterator yields rather than completing");
    assert.equal(result.value, segment, "the iterator yields the exact pushed segment");

    await double[Symbol.asyncDispose]();
  });

  // The lost-wakeup guard, exercising the genuine park-then-wake hazard: the iterator first PARKS on an empty queue (the kicked-off next() suspends), THEN two segments
  // are pushed synchronously under that single wake, and BOTH must be yielded. A naive park/yield-one/re-park iterator strands the second (it wakes, yields the first,
  // and re-parks before re-checking the queue); the drain-loop re-checks the queue on wake and yields the whole queue across the two pulls. We kick off the first pull
  // WITHOUT awaiting (so the generator runs to its park), settle to let it reach the park, then push both and pull both.
  test("makeControllableLivestreamDouble does not strand a second segment queued under one wake", async () => {

    const double = makeControllableLivestreamDouble();
    const first = makeMediaSegment(makeKeyframeFragment());
    const second = makeMediaSegment(makeNonKeyframeFragment());
    const iterator = double[Symbol.asyncIterator]();

    // Kick off the first pull and let the generator run to its park on the empty queue (it has nothing to yield yet).
    const firstPull = iterator.next();

    await settle();

    // Both pushes land under a single wake while the generator is parked.
    double.push(first);
    double.push(second);

    const firstResult = await firstPull;
    const secondResult = await iterator.next();

    assert.equal(firstResult.value, first, "the first push is yielded after the wake");
    assert.equal(secondResult.value, second, "the second push queued under the same wake is not stranded");

    await double[Symbol.asyncDispose]();
  });

  // whenEstablished defaults true (so start() commits) and is configurable false (so a start-validation test drives the failure arm).
  test("makeControllableLivestreamDouble whenEstablished defaults true and is configurable false", async () => {

    assert.equal(await makeControllableLivestreamDouble().whenEstablished(), true, "whenEstablished defaults true");
    assert.equal(await makeControllableLivestreamDouble({ whenEstablished: false }).whenEstablished(), false, "whenEstablished is configurable false");
  });

  // initSegment defaults to a populated init (so start() passes its initSegment check) and is configurable null (so the start initSegment-null validation arm is
  // reachable).
  test("makeControllableLivestreamDouble initSegment defaults populated and is configurable null", () => {

    assert.ok(makeControllableLivestreamDouble().initSegment, "initSegment defaults to a populated init segment");
    assert.equal(makeControllableLivestreamDouble({ initSegment: null }).initSegment, null, "initSegment is configurable null");
  });

  // state defaults live and is configurable recovering (so the timeshift's isRestarting getter, which reads state === "recovering", is drivable both ways).
  test("makeControllableLivestreamDouble state defaults live and is configurable recovering", () => {

    assert.equal(makeControllableLivestreamDouble().state, "live", "state defaults live");
    assert.equal(makeControllableLivestreamDouble({ state: "recovering" }).state, "recovering", "state is configurable recovering");
  });

  // end() completes the iterator: the for-await runs to completion (rather than parking forever), which is what feeds the timeshift's consumeSegments finally. Iterating
  // with for-await terminates because end() returns from the generator.
  test("makeControllableLivestreamDouble end completes the iterator", async () => {

    const double = makeControllableLivestreamDouble();

    double.end();

    const segments: Segment[] = [];

    for await(const segment of double) {

      segments.push(segment);
    }

    assert.equal(segments.length, 0, "end with no queued segments completes the iterator immediately");
  });

  // Distinct ids per instance are required for the timeshift restart / id-identity targets - two default-id doubles must not collide.
  test("makeControllableLivestreamDouble mints a distinct id per instance", () => {

    assert.notEqual(makeControllableLivestreamDouble().id, makeControllableLivestreamDouble().id, "two doubles have distinct ids");
  });

  // The behavior-first recording surface: reassess() increments reassessCalls (the timeshift's transmit-start escalation), and dispose records disposed. A test asserts
  // these rather than reaching into private fields.
  test("makeControllableLivestreamDouble records reassessCalls and disposed", async () => {

    const double = makeControllableLivestreamDouble();

    assert.equal(double.reassessCalls, 0, "reassessCalls starts at zero");
    assert.equal(double.disposed, false, "disposed starts false");

    double.reassess();

    assert.equal(double.reassessCalls, 1, "reassess increments reassessCalls");

    await double[Symbol.asyncDispose]();

    assert.equal(double.disposed, true, "dispose records disposed");
  });
});

describe("harness growth: the fragment splitter", () => {

  // A fragment HBPU's builder makes reaches a suite through the splitter, so a split that put a box on the wrong side, or lost bytes between the halves, would hand a
  // consumer a segment no pool delivers.
  test("splitFragment carries a fragment as its moof and mdat halves, which together are the whole fragment", () => {

    const fragment = makeKeyframeFragment();
    const split = splitFragment(fragment.data);

    assert.equal(split.data, fragment.data, "the whole fragment is carried as it was handed");
    assert.ok(split.moof.equals(fragment.moof), "the first half is the fragment's moof");
    assert.ok(split.mdat.equals(fragment.mdat), "the second half is the fragment's mdat");
    assert.ok(Buffer.concat([ split.moof, split.mdat ]).equals(fragment.data), "the halves together are the whole fragment");
  });
});

describe("harness growth: the shared process teardown", () => {

  // A row that starts a streaming process or a one-shot run double ends through this teardown, so a sweep that skipped a factory, left a process running, or read a
  // process's ending from a stdin its caller had already ended would carry that process into the next row unseen. A process the row ended itself keeps the ending it
  // had, since the double refuses a second exit.
  test("endPendingProcesses ends each process its factories left running as a killed child, one whose stdin was ended among them, and leaves an ended one as it ended",
    async () => {

      const exec = new TestExecProcessFactory();
      const streaming = new TestStreamingProcessFactory();
      const { ffmpegOptions } = new TestStreamingDelegate();
      const endings: { ended?: FfmpegProcessExitInfo; run?: FfmpegProcessExitInfo; running?: FfmpegProcessExitInfo; stdinEnded?: FfmpegProcessExitInfo } = {};

      streaming.create(ffmpegOptions, { args: [] });
      streaming.create(ffmpegOptions, { args: [] });
      streaming.create(ffmpegOptions, { args: [] });
      exec.create(ffmpegOptions, { args: [] });

      const running = expectAt(streaming.createCalls, 0, "the streaming process left running").process;
      const stdinEnded = expectAt(streaming.createCalls, 1, "the streaming process whose stdin was ended").process;
      const ended = expectAt(streaming.createCalls, 2, "the streaming process the row ended").process;
      const run = expectAt(exec.createCalls, 0, "the one-shot run left pending").process;

      void running.exited.then((info): void => { endings.running = info; });
      void stdinEnded.exited.then((info): void => { endings.stdinEnded = info; });
      void ended.exited.then((info): void => { endings.ended = info; });
      void run.result().then(({ exitCode, exitSignal }): void => { endings.run = { exitCode, exitSignal }; });

      stdinEnded.stdin.end("an invented session description");
      ended.exit({ exitCode: 0, exitSignal: null });
      await settle();

      assert.equal(stdinEnded.stdin.destroyed, true, "the vacuity guard: the ended stdin is destroyed while its process runs on");
      assert.deepEqual(endings, { ended: { exitCode: 0, exitSignal: null } }, "the vacuity guard: only the process the row ended has ended");

      await endPendingProcesses([ exec, streaming ]);

      const killed: FfmpegProcessExitInfo = { exitCode: null, exitSignal: "SIGKILL" };

      assert.deepEqual(endings, { ended: { exitCode: 0, exitSignal: null }, run: killed, running: killed, stdinEnded: killed },
        "each process left running ended as a killed child and the ended one kept its ending, read with no settle after the teardown");
    });
});
