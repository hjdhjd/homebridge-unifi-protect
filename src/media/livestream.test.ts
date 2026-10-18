/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * livestream.test.ts: Behavior coverage of the RTSP debug livestream adapter, driven over homebridge-plugin-utils' livestream process double.
 *
 * The adapter builds its livestream process through the factory it is handed, so this suite hands it a TestLivestreamProcessFactory and drives the double the factory
 * returns one step at a time - resolving the init segment, feeding fragments, closing the source, failing - with no FFmpeg and no RTSP input behind it. The double's
 * agreement with the real FFmpeg livestream process on each lifecycle step is held by homebridge-plugin-utils' own suite, so what the adapter does over the double here
 * is what it does over the real process. Every row reads the adapter through its public surface - the create call it made, its establishment, its segment stream, its
 * state, and its teardown - and never a private field.
 */
import { AudioRecordingCodecType, AudioRecordingSamplerate } from "homebridge-plugin-utils";
import type { FMp4AudioTarget, FfmpegOptions } from "homebridge-plugin-utils";
import { TestLivestreamProcessFactory, assertNoUnhandledRejections, expectAt, settle } from "homebridge-plugin-utils/testing";
import { describe, test } from "node:test";
import { makeKeyframeFragment, makeNonKeyframeFragment } from "./testing.helpers.ts";
import { RtspLivestreamSubscription } from "./livestream.ts";
import type { TestLivestreamProcess } from "homebridge-plugin-utils/testing";
import assert from "node:assert/strict";

// The adapter's inputs, fixed so a row compares what reached the factory against them. The audio target is the shape the camera derives for a 16 kHz microphone, and
// the URL is the form the camera composes for an RTSP-enabled channel; the adapter hands each to its process without reading it.
const AUDIO_TARGET: FMp4AudioTarget = { channels: 1, codec: AudioRecordingCodecType.AAC_LC, samplerate: AudioRecordingSamplerate.KHZ_16 };
const SEGMENT_LENGTH = 100;
const STREAM_URL = "rtsps://camera.test:7441/alias0?enableSrtp";
const VIDEO_CODEC = "h264";

// The FFmpeg options the adapter hands its factory. Nothing here reads them - the adapter passes them through and the process double never operates on them - so an
// opaque sentinel matched by reference serves. FfmpegOptions is a class whose constructor takes a probed codec-support record and configures hardware acceleration,
// so the sentinel is cast once, here, at this confined boundary.
const FFMPEG_OPTIONS = { hbupTestSentinel: "ffmpeg-options" } as unknown as FfmpegOptions;

// The init segment bytes a row resolves the process double with. The adapter caches and yields them without parsing them, so plain bytes serve.
const INIT_SEGMENT = Buffer.from("rtsp-test-init-segment");

// Build an adapter over a fresh TestLivestreamProcessFactory and return it with the factory and the process double the factory built for it. The process is read off
// the factory's record rather than built ahead of the call, because the factory builds it over the signal the adapter hands to create, which is how the owner's abort
// reaches the process. The signal option is the owner's abort signal; omitted, the adapter has none and only its disposal ends it.
function makeSubscription(options: { signal?: AbortSignal } = {}):
{ factory: TestLivestreamProcessFactory; livestreamProcess: TestLivestreamProcess; subscription: RtspLivestreamSubscription } {

  const factory = new TestLivestreamProcessFactory();
  const subscription = new RtspLivestreamSubscription({ audio: AUDIO_TARGET, enableAudio: true, ffmpegOptions: FFMPEG_OPTIONS, processFactory: factory,
    segmentLength: SEGMENT_LENGTH, signal: options.signal, url: STREAM_URL, videoCodec: VIDEO_CODEC });

  return { factory, livestreamProcess: expectAt(factory.createCalls, 0, "the livestream process the adapter built").process, subscription };
}

describe("the RTSP debug livestream adapter over a driven livestream process", () => {

  // The create call is read before anything awaits. Production spawns FFmpeg inside the factory's create, so a construction moved behind an await would leave the
  // record empty here, and the init is compared whole so a field added to or dropped from it fails the row.
  test("construction builds the process through the factory at once, handing over the FFmpeg options and the init derived from the adapter's options", async () => {

    const controller = new AbortController();
    const { factory, subscription } = makeSubscription({ signal: controller.signal });

    assert.equal(factory.createCalls.length, 1, "the constructor called the factory exactly once, before anything awaited");

    const { init, options } = expectAt(factory.createCalls, 0, "the create call the constructor made");

    assert.equal(options, FFMPEG_OPTIONS, "the factory received the adapter's FFmpeg options by reference");
    assert.deepEqual(init, { audio: AUDIO_TARGET, livestream: { codec: VIDEO_CODEC, enableAudio: true, url: STREAM_URL }, segmentLength: SEGMENT_LENGTH,
      signal: controller.signal }, "the init carries exactly the audio target, the livestream source, the segment length, and the signal");
    assert.equal(init.audio, AUDIO_TARGET, "the audio target is the adapter's own, by reference");
    assert.equal(init.signal, controller.signal, "the signal is the owner's, so the owner's abort ends the process");

    await subscription[Symbol.asyncDispose]();
  });

  test("a resolved init segment establishes the adapter: whenEstablished answers true, the init segment is cached with its codec, and the state reads live", async () => {

    const { livestreamProcess, subscription } = makeSubscription();

    assert.equal(subscription.state, "connecting", "the adapter reads connecting before its init segment");
    assert.equal(subscription.initSegment, null, "no init segment is cached before the process produces one");

    livestreamProcess.resolveInit(INIT_SEGMENT);

    assert.equal(await subscription.whenEstablished(), true, "the resolved init segment establishes the adapter");
    assert.deepEqual(subscription.initSegment, { codec: VIDEO_CODEC, data: INIT_SEGMENT }, "the cached init segment carries the camera's codec and the process's bytes");
    assert.equal(subscription.state, "live", "the adapter reads live once established");

    await subscription[Symbol.asyncDispose]();
  });

  // The process ends on its own here rather than at the owner's hand, so the adapter is not closed and its state stays where it was.
  test("a process that ends before its init segment leaves the adapter unestablished and still connecting, whether its source closes or it aborts", async () => {

    const closed = makeSubscription();
    const aborted = makeSubscription();

    closed.livestreamProcess.end();
    aborted.livestreamProcess.abort();

    assert.equal(await closed.subscription.whenEstablished(), false, "a source that closes before the init segment leaves the adapter unestablished");
    assert.equal(await aborted.subscription.whenEstablished(), false, "a process that aborts before the init segment leaves the adapter unestablished");

    for(const { subscription } of [ closed, aborted ]) {

      assert.equal(subscription.state, "connecting", "the state stays connecting, because the adapter's owner has not ended it");
      assert.equal(subscription.initSegment, null, "no init segment is cached");
    }

    await closed.subscription[Symbol.asyncDispose]();
    await aborted.subscription[Symbol.asyncDispose]();
  });

  test("iteration yields the init segment first, then one media segment per fed fragment, each split into its moof and its mdat", async () => {

    const keyframe = makeKeyframeFragment();
    const nonKeyframe = makeNonKeyframeFragment();
    const { livestreamProcess, subscription } = makeSubscription();

    livestreamProcess.resolveInit(INIT_SEGMENT);
    livestreamProcess.feed(keyframe.data);
    livestreamProcess.feed(nonKeyframe.data);

    const iterator = subscription[Symbol.asyncIterator]();

    assert.deepEqual(await iterator.next(), { done: false, value: { codec: VIDEO_CODEC, data: INIT_SEGMENT, type: "init" } }, "the init segment comes first");
    assert.deepEqual(await iterator.next(), { done: false, value: { data: keyframe.data, mdat: keyframe.mdat, moof: keyframe.moof, type: "media" } },
      "the first fed fragment follows, split where the fragment builder joined its moof and mdat");
    assert.deepEqual(await iterator.next(), { done: false, value: { data: nonKeyframe.data, mdat: nonKeyframe.mdat, moof: nonKeyframe.moof, type: "media" } },
      "the second fed fragment follows, in the order it was fed");

    // Disposal ends the media loop once the queue is empty, so a next read that finds nothing shows no extra segment was produced.
    await subscription[Symbol.asyncDispose]();

    assert.deepEqual(await iterator.next(), { done: true, value: undefined }, "each fed fragment produced exactly one media segment, and nothing more followed");
  });

  // A moof on its own carries no mdat box, which is the malformed fragment the adapter degrades rather than drops.
  test("a fragment with no mdat box is passed through whole as the mdat behind an empty moof rather than dropped", async () => {

    const malformed = makeKeyframeFragment().moof;
    const { livestreamProcess, subscription } = makeSubscription();

    livestreamProcess.resolveInit(INIT_SEGMENT);
    livestreamProcess.feed(malformed);
    livestreamProcess.end();

    // The source ends after the one fragment, so the iteration ends with it, and a dropped fragment shows as a missing segment rather than a read left waiting.
    const segments = await Array.fromAsync(subscription);

    assert.deepEqual(segments, [ { codec: VIDEO_CODEC, data: INIT_SEGMENT, type: "init" }, { data: malformed, mdat: malformed, moof: Buffer.alloc(0), type: "media" } ],
      "the malformed fragment follows the init segment whole, as the mdat behind an empty moof");

    await subscription[Symbol.asyncDispose]();
  });

  test("a source that ends after its init segment hands over every fed segment and then ends the iteration by a return", async () => {

    const first = makeKeyframeFragment();
    const second = makeNonKeyframeFragment();
    const { livestreamProcess, subscription } = makeSubscription();

    livestreamProcess.resolveInit(INIT_SEGMENT);
    livestreamProcess.feed(first.data);
    livestreamProcess.feed(second.data);
    livestreamProcess.end();

    // Array.fromAsync reads the iteration to its end, so a throw anywhere in it fails the row.
    const segments = await Array.fromAsync(subscription);

    assert.deepEqual(segments.map((segment) => segment.data), [ INIT_SEGMENT, first.data, second.data ], "the init segment and every fed fragment arrived, in order");

    await subscription[Symbol.asyncDispose]();
  });

  test("an abort while establishing ends the iteration by a return, with the state closed and the adapter unestablished", async () => {

    const controller = new AbortController();
    const { subscription } = makeSubscription({ signal: controller.signal });
    const iteration = Array.fromAsync(subscription);

    controller.abort();

    assert.deepEqual(await iteration, [], "the iteration returned with nothing yielded rather than throwing");
    assert.equal(subscription.state, "closed", "the owner's abort closes the adapter");
    assert.equal(await subscription.whenEstablished(), false, "the adapter never established");
  });

  test("a disposal while establishing ends the iteration by a return, closes the state, and disposes the process once", async () => {

    const { livestreamProcess, subscription } = makeSubscription();
    const iteration = Array.fromAsync(subscription);

    await subscription[Symbol.asyncDispose]();

    assert.deepEqual(await iteration, [], "the iteration returned with nothing yielded rather than throwing");
    assert.equal(subscription.state, "closed", "the disposal closes the adapter");
    assert.equal(livestreamProcess.disposeCalls, 1, "the adapter disposed its process exactly once");
  });

  // Neither ending comes from the adapter's owner, so each is a genuine failure its consumer has to narrate, and the iteration throws the very reason the process
  // ended for. The rejections are awaited together, so none waits unobserved while another is checked.
  test("a genuine failure before the init segment rethrows its reason from the iteration, whether the source closes or the process fails", async () => {

    const closed = makeSubscription();
    const failed = makeSubscription();
    const failure = new Error("FFmpeg exited before its first segment.");
    const closedIteration = Array.fromAsync(closed.subscription);
    const failedIteration = Array.fromAsync(failed.subscription);

    closed.livestreamProcess.end();
    failed.livestreamProcess.abort(failure);

    await Promise.all([
      assert.rejects(closedIteration, (error: unknown) => error === closed.livestreamProcess.signal.reason, "a closed source rethrows the reason it closed with"),
      assert.rejects(failedIteration, (error: unknown) => error === failure, "a failed process rethrows its failure")
    ]);

    await closed.subscription[Symbol.asyncDispose]();
    await failed.subscription[Symbol.asyncDispose]();
  });

  test("an abort after the init segment ends the media loop by a return", async () => {

    const controller = new AbortController();
    const keyframe = makeKeyframeFragment();
    const { livestreamProcess, subscription } = makeSubscription({ signal: controller.signal });

    livestreamProcess.resolveInit(INIT_SEGMENT);
    livestreamProcess.feed(keyframe.data);

    const iterator = subscription[Symbol.asyncIterator]();

    // Read the init segment and the one fed fragment, which leaves the queue empty, so the next read parks in the media loop until something ends it.
    assert.deepEqual(await iterator.next(), { done: false, value: { codec: VIDEO_CODEC, data: INIT_SEGMENT, type: "init" } }, "the init segment was read first");
    assert.deepEqual(await iterator.next(), { done: false, value: { data: keyframe.data, mdat: keyframe.mdat, moof: keyframe.moof, type: "media" } },
      "the fed fragment was read next");

    const parked = iterator.next();

    await settle();

    controller.abort();

    assert.deepEqual(await parked, { done: true, value: undefined }, "the parked read returned rather than throwing");
    assert.equal(subscription.state, "closed", "the owner's abort closes the adapter");
  });

  test("disposing twice disposes the process once and leaves the state closed", async () => {

    const { livestreamProcess, subscription } = makeSubscription();

    await subscription[Symbol.asyncDispose]();
    await subscription[Symbol.asyncDispose]();

    assert.equal(livestreamProcess.disposeCalls, 1, "the second disposal was a no-op");
    assert.equal(subscription.state, "closed", "the adapter reads closed");
  });

  // The init segment resolves and the adapter is disposed in the same turn, so the disposal lands before the resolution reaches the adapter's handler, which then keeps
  // the init segment out. Establishment answering true shows the init segment did resolve, so the empty cache is the handler's decision and not a resolution that never
  // came.
  test("a disposal in the same turn as a resolved init segment leaves no init segment cached and the state closed", async () => {

    const { livestreamProcess, subscription } = makeSubscription();

    livestreamProcess.resolveInit(INIT_SEGMENT);

    await subscription[Symbol.asyncDispose]();

    assert.equal(await subscription.whenEstablished(), true, "the init segment did resolve");
    assert.equal(subscription.initSegment, null, "the disposed adapter cached no init segment");
    assert.equal(subscription.state, "closed", "the adapter reads closed");
  });

  test("constructing an adapter and disposing it without iterating leaves no unhandled rejection", async () => {

    await assertNoUnhandledRejections(async () => {

      const { subscription } = makeSubscription();

      await subscription[Symbol.asyncDispose]();
    });
  });

  test("each adapter carries its own id, reassess changes nothing, and the state never reads recovering", async () => {

    const first = makeSubscription();
    const second = makeSubscription();

    assert.match(first.subscription.id, /^rtsp-livestream-\d+$/, "the id names the RTSP debug path and a sequence number");
    assert.match(second.subscription.id, /^rtsp-livestream-\d+$/, "the id names the RTSP debug path and a sequence number");
    assert.notEqual(first.subscription.id, second.subscription.id, "each adapter's id is its own");

    // Walk one adapter through its whole lifecycle, calling reassess at each stage and recording the state it reads after.
    const states = [first.subscription.state];

    first.subscription.reassess();
    states.push(first.subscription.state);
    first.livestreamProcess.resolveInit(INIT_SEGMENT);

    await first.subscription.whenEstablished();

    first.subscription.reassess();
    states.push(first.subscription.state);

    assert.equal(first.livestreamProcess.signal.aborted, false, "reassess left the process running");
    assert.equal(first.factory.createCalls.length, 1, "reassess built no second process");

    await first.subscription[Symbol.asyncDispose]();

    first.subscription.reassess();
    states.push(first.subscription.state);

    assert.deepEqual(states, [ "connecting", "connecting", "live", "closed" ], "reassess moved no state, and the walk never read recovering");

    await second.subscription[Symbol.asyncDispose]();
  });

  test("whenEstablished still answers true after a disposal that follows a resolved init segment", async () => {

    const { livestreamProcess, subscription } = makeSubscription();

    livestreamProcess.resolveInit(INIT_SEGMENT);

    assert.equal(await subscription.whenEstablished(), true, "the resolved init segment establishes the adapter");

    await subscription[Symbol.asyncDispose]();

    assert.equal(subscription.state, "closed", "the disposal closes the adapter");
    assert.equal(await subscription.whenEstablished(), true, "establishment answers from the init segment alone, so the disposal does not withdraw it");
  });

  test("iterating an adapter disposed after its init segment resolved yields the init segment and then returns", async () => {

    const { livestreamProcess, subscription } = makeSubscription();

    livestreamProcess.resolveInit(INIT_SEGMENT);

    await subscription.whenEstablished();
    await subscription[Symbol.asyncDispose]();

    assert.deepEqual(await Array.fromAsync(subscription), [{ codec: VIDEO_CODEC, data: INIT_SEGMENT, type: "init" }],
      "the cached init segment is still delivered, and the media loop ends at once under the ended process");
  });
});
