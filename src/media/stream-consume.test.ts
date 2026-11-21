/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * stream-consume.test.ts: Behavior coverage of the path a buffer-backed live view's video takes into FFmpeg - the segment consumer and the frame feed it writes through.
 *
 * A row here reads each write FFmpeg's stdin receives with the virtual time it arrived, which the streaming process double's record of its stdin does not carry, so
 * this suite drives the private members a live view's input runs through directly, on the real delegate: the consumer that reads the pooled livestream, and the
 * builder of the frame feed that paces each fragment's frames, reached together through one confined cast. A Writable stands for FFmpeg's stdin and records every
 * write with the virtual time it arrived, the livestream is the controllable double with a readable init segment, and the writer is a real BackpressureWriter on the
 * host's TestClock, so the pacing runs on virtual time and each row reads the bytes FFmpeg would receive and when it would receive them. Every fragment is built from
 * invented samples with homebridge-plugin-utils' fMP4 builders.
 */
import { BackpressureWriter, HDLR_TYPE_VIDE } from "homebridge-plugin-utils";
import type { Mp4FrameFeed, Nullable } from "homebridge-plugin-utils";
import type { TestClock, TestLogEntry } from "homebridge-plugin-utils/testing";
import { after, describe, test } from "node:test";
import { logCount, makeFragment, makeInitSegment, settle } from "homebridge-plugin-utils/testing";
import { makeControllableLivestreamDouble, makeMediaSegment, makeTestCameraHost, splitFragment } from "./testing.helpers.ts";
import type { ControllableLivestreamDouble } from "./testing.helpers.ts";
import type { LivestreamSubscription } from "./livestream.ts";
import { ProtectStreamingDelegate } from "./stream.ts";
import { Writable } from "node:stream";
import assert from "node:assert/strict";

// Every host this suite builds holds its own makeTestNvr AbortController, which also bounds each rig's writer. Aborting them at the end tears down every writer, so no
// paced hold outlives the suite.
const controllers: AbortController[] = [];

after(() => {

  for(const controller of controllers) {

    controller.abort();
  }
});

// The stream's header: an init segment naming one video track at a 90 kHz timescale, the track the frame feed cuts every fragment at.
const INIT = makeInitSegment([{ handler: HDLR_TYPE_VIDE, id: 1, timescale: 90000 }]);

// A frame of 3600 ticks at 90 kHz lasts 40 milliseconds, so the frames of a fragment built from these samples are due 40 milliseconds of virtual time apart.
const FRAME_TICKS = 3600;
const FRAME_MS = 40;

// The warning a live view logs when its camera's fragments cannot be read frame by frame.
const UNREADABLE_WARNING = "Some of this camera's video could not be read frame by frame, so it was sent to HomeKit as it arrived. Live views may look less smooth.";

// The debug note a live view logs when a fragment holds no video for the frame feed to pace.
const NO_VIDEO_NOTE = "A livestream fragment with no video in it was sent to HomeKit as it arrived.";

// A fragment of video frames of the given sizes, each lasting one frame's duration, in the layout the frame feed reads.
function framesOf(sizes: number[]): Buffer {

  return makeFragment({ samples: sizes.map((size) => ({ duration: FRAME_TICKS, size })), trackId: 1 });
}

// A fragment of video the frame feed cannot cut: its track fragment header does not measure data offsets from the moof, which is not a layout the reader knows.
function unreadableOf(sizes: number[]): Buffer {

  return makeFragment({ header: { defaultBaseIsMoof: false }, samples: sizes.map((size) => ({ duration: FRAME_TICKS, size })), trackId: 1 });
}

// A fragment with no video in it: its samples belong to a track the header does not name as its video track, as a fragment of audio alone would.
function soundOf(sizes: number[]): Buffer {

  return makeFragment({ samples: sizes.map((size) => ({ duration: FRAME_TICKS, size })), trackId: 2 });
}

// The first piece the feed cuts from a fragment of framesOf: everything up to the end of its first frame, which sits after the moof and the mdat's eight-byte header.
function firstFrameOf(fragment: Buffer, firstSize: number): Buffer {

  return fragment.subarray(0, splitFragment(fragment).moof.length + 8 + firstSize);
}

// The private members of the streaming delegate a live view's input runs through. The consumer reads nothing of the FFmpeg process it is handed but its stdin, so the
// suite hands it a stand-in carrying a stdin alone.
interface LiveViewInput {

  consumeStreamSegments: (ffmpegStream: { stdin: Writable }, subscription: LivestreamSubscription, feed: Mp4FrameFeed, header: Nullable<Buffer>) => Promise<void>;
  createFrameFeed: (writer: BackpressureWriter) => Mp4FrameFeed;
}

// A running consumer and the handles a row reads: the clock the writer paces on, the livestream double a row pushes segments into, the feed the consumer writes
// through, whether the consumer has returned, the captured log, the stdin stand-in, and every write that reached it with the virtual time it arrived.
interface LiveViewRig {

  clock: TestClock;
  double: ControllableLivestreamDouble;
  feed: Mp4FrameFeed;
  finished: () => boolean;
  logEntries: readonly TestLogEntry[];
  stdin: Writable;
  writes: { at: number; bytes: Buffer }[];
}

// The bytes every write after the first carried, joined in order: what FFmpeg has read past the header.
function afterHeader(rig: LiveViewRig): Buffer {

  return Buffer.concat(rig.writes.slice(1).map(({ bytes }) => bytes));
}

// Start the real delegate's consumer over a controllable livestream whose init is the readable INIT, or none when the row asks for a missing one, with the header the
// row hands in as the preload, or none.
function startLiveView(options: { header?: Buffer; init?: Nullable<Buffer> } = {}): LiveViewRig {

  const { clock, controller, host, logEntries } = makeTestCameraHost();

  controllers.push(controller);

  const writes: { at: number; bytes: Buffer }[] = [];
  const stdin = new Writable({

    write: (chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Nullable<Error>) => void): void => {

      writes.push({ at: clock.monotonic(), bytes: chunk });
      callback();
    }
  });

  const init = (options.init === undefined) ? INIT : options.init;
  const double = makeControllableLivestreamDouble({ initSegment: (init === null) ? null : { codec: "h264", data: init, description: { tracks: [] } } });

  // The one confined cast this suite makes, reaching the consumer and the feed builder the delegate keeps private.
  const input = new ProtectStreamingDelegate(host, [[ 1920, 1080, 30 ]]) as unknown as LiveViewInput;
  const feed = input.createFrameFeed(new BackpressureWriter(() => stdin, { clock: host.platform.clock, signal: controller.signal }));

  let finished = false;

  void input.consumeStreamSegments({ stdin }, double, feed, options.header ?? null).then(() => { finished = true; });

  return { clock, double, feed, finished: (): boolean => finished, logEntries, stdin, writes };
}

describe("a buffer-backed live view's input to FFmpeg", () => {

  test("the subscription's init segment is the header when no preload is handed in, written whole ahead of the first fragment", async () => {

    const rig = startLiveView();

    rig.double.push(makeMediaSegment(splitFragment(framesOf([ 40, 12, 18 ]))));

    await settle();

    assert.ok(rig.writes[0]?.bytes.equals(INIT), "the first write is the init segment, whole");
    assert.equal(rig.writes.length, 2, "the header and the fragment's first frame are all that has gone out");
  });

  test("a preload handed in is the header, written whole as one write", async () => {

    const preload = Buffer.concat([ INIT, framesOf([ 30, 20 ]) ]);
    const rig = startLiveView({ header: preload });

    rig.double.push(makeMediaSegment(splitFragment(framesOf([ 40, 12, 18 ]))));

    await settle();

    assert.ok(rig.writes[0]?.bytes.equals(preload), "the first write is the preload, whole");
  });

  test("a fragment reaches FFmpeg as its frames, a frame's duration apart, joining back to the fragment byte for byte", async () => {

    const rig = startLiveView();
    const fragment = framesOf([ 40, 12, 18 ]);

    rig.double.push(makeMediaSegment(splitFragment(fragment)));

    await settle();

    assert.ok(afterHeader(rig).equals(firstFrameOf(fragment, 40)), "only the first frame has gone out before its successor is due");

    rig.clock.advance(FRAME_MS);
    await settle();

    assert.equal(rig.writes.length, 3, "the second frame goes out when it is due");

    rig.clock.advance(FRAME_MS);
    await settle();

    const start = rig.writes[1]?.at ?? Number.NaN;

    assert.deepEqual(rig.writes.slice(1).map(({ at }) => at - start), [ 0, FRAME_MS, FRAME_MS * 2 ], "each frame went out a frame's duration after the one before");
    assert.ok(afterHeader(rig).equals(fragment), "the frames join back to the fragment byte for byte");
    assert.equal(logCount(rig.logEntries, "warn", UNREADABLE_WARNING), 0, "a fragment the feed can read raises no warning");
  });

  // The second fragment arrives a frame early, and the feed holds its first frame until the video's own time says it is due. The feed measures that arrival on the
  // platform's clock, the one the writer holds the frame on: a feed reading any other clock would see no virtual time pass between the two fragments, and would hold
  // the second one long past its place.
  test("a fragment that arrives early waits for its place, so two fragments reach FFmpeg as one evenly spaced run of frames", async () => {

    const rig = startLiveView();
    const first = framesOf([ 40, 12, 18 ]);
    const second = framesOf([ 25, 35, 15 ]);

    rig.double.push(makeMediaSegment(splitFragment(first)));

    // Virtual time moves a frame at a time, so each write is recorded at the moment it was due.
    await settle();
    rig.clock.advance(FRAME_MS);
    await settle();
    rig.clock.advance(FRAME_MS);
    await settle();

    rig.double.push(makeMediaSegment(splitFragment(second)));

    await settle();

    assert.ok(afterHeader(rig).equals(first), "the first fragment's frames went out at their own pace, and the second fragment is waiting for its place in the video");

    rig.clock.advance(FRAME_MS);
    await settle();

    assert.ok(afterHeader(rig).equals(Buffer.concat([ first, firstFrameOf(second, 25) ])), "the second fragment's first frame goes out a frame after the first's last");

    rig.clock.advance(FRAME_MS);
    await settle();
    rig.clock.advance(FRAME_MS);
    await settle();

    const start = rig.writes[1]?.at ?? Number.NaN;

    assert.deepEqual(rig.writes.slice(1).map(({ at }) => at - start), [ 0, FRAME_MS, FRAME_MS * 2, FRAME_MS * 3, FRAME_MS * 4, FRAME_MS * 5 ],
      "the second fragment's frames follow the first's with a frame's duration between every two");
    assert.ok(afterHeader(rig).equals(Buffer.concat([ first, second ])), "the frames join back to the two fragments byte for byte");
    assert.equal(rig.writes.filter(({ bytes }) => bytes.equals(INIT)).length, 1, "the header went out once");
  });

  test("an init-typed segment is skipped, so the header is the only init FFmpeg reads", async () => {

    const rig = startLiveView();
    const fragment = framesOf([ 40, 12, 18 ]);

    rig.double.push({ codec: "h264", data: INIT, description: { tracks: [] }, type: "init" });
    rig.double.push(makeMediaSegment(splitFragment(fragment)));

    await settle();
    rig.clock.advance(FRAME_MS * 2);
    await settle();

    assert.ok(Buffer.concat(rig.writes.map(({ bytes }) => bytes)).equals(Buffer.concat([ INIT, fragment ])), "FFmpeg read the header and the fragment, and nothing else");
  });

  test("a discontinuity ends FFmpeg's stdin before the rebased fragment is written, and the frames still waiting are dropped", async () => {

    const rig = startLiveView();
    const fragment = framesOf([ 40, 12, 18 ]);

    rig.double.push(makeMediaSegment(splitFragment(fragment)));

    await settle();

    rig.double.push(makeMediaSegment(splitFragment(framesOf([ 25, 35, 15 ])), { discontinuity: true }));

    await settle();

    assert.equal(rig.stdin.writableEnded, true, "the discontinuity ended FFmpeg's stdin");
    assert.equal(rig.finished(), true, "the consumer returned at the discontinuity");

    rig.clock.advance(FRAME_MS * 2);
    await settle();

    assert.ok(afterHeader(rig).equals(firstFrameOf(fragment, 40)), "neither the rebased fragment nor the frames still waiting reached FFmpeg");
    assert.equal(logCount(rig.logEntries, "debug", "Live stream backpressure write dropped."), 1, "the dropped frames' write was caught at debug");
  });

  test("a livestream that fails mid-view ends FFmpeg's stdin, and the frames still waiting are dropped", async () => {

    const rig = startLiveView();
    const fragment = framesOf([ 40, 12, 18 ]);

    rig.double.push(makeMediaSegment(splitFragment(fragment)));

    await settle();

    rig.double.throwError(new Error("The livestream ended."));

    await settle();

    assert.equal(rig.stdin.writableEnded, true, "the failed livestream ended FFmpeg's stdin");
    assert.equal(rig.finished(), true, "the consumer returned once the livestream failed");

    rig.clock.advance(FRAME_MS * 2);
    await settle();

    assert.ok(afterHeader(rig).equals(firstFrameOf(fragment, 40)), "the frames still waiting never reached FFmpeg");
  });

  test("a first fragment with no header to write ahead of it logs its error and ends FFmpeg's stdin without writing anything", async () => {

    const rig = startLiveView({ init: null });

    rig.double.push(makeMediaSegment(splitFragment(framesOf([ 40, 12, 18 ]))));

    await settle();

    assert.equal(logCount(rig.logEntries, "error", "Live streaming aborted: the livestream API delivered its first segment before the initialization segment."), 1,
      "the missing header is logged as an error");
    assert.equal(rig.stdin.writableEnded, true, "FFmpeg's stdin is ended");
    assert.equal(rig.finished(), true, "the consumer returned");
    assert.equal(rig.writes.length, 0, "nothing was written");
  });

  test("the warning comes once for one header's unreadable fragments, which go out whole, and again after a second header", async () => {

    const rig = startLiveView();
    const first = unreadableOf([ 40, 12 ]);
    const second = unreadableOf([ 25, 35 ]);

    rig.double.push(makeMediaSegment(splitFragment(first)));
    rig.double.push(makeMediaSegment(splitFragment(second)));

    await settle();

    assert.equal(logCount(rig.logEntries, "warn", UNREADABLE_WARNING), 1, "one header's unreadable fragments warn once");
    assert.ok(afterHeader(rig).equals(Buffer.concat([ first, second ])), "each unreadable fragment went out whole, with no time passing");

    await rig.feed.writeHeader(INIT);
    await rig.feed.writeFragment(unreadableOf([ 15, 10 ]));

    assert.equal(logCount(rig.logEntries, "warn", UNREADABLE_WARNING), 2, "a second header warns again for its own unreadable fragment");
  });

  test("a fragment with no video in it goes out whole with a debug note and no warning", async () => {

    const rig = startLiveView();
    const first = soundOf([ 7, 9 ]);
    const second = soundOf([11]);

    rig.double.push(makeMediaSegment(splitFragment(first)));
    rig.double.push(makeMediaSegment(splitFragment(second)));

    await settle();

    assert.ok(afterHeader(rig).equals(Buffer.concat([ first, second ])), "each fragment went out whole, with no time passing");
    assert.equal(logCount(rig.logEntries, "debug", NO_VIDEO_NOTE), 1, "one header's fragments with no video are noted once");
    assert.equal(logCount(rig.logEntries, "warn", UNREADABLE_WARNING), 0, "a fragment with no video in it raises no warning");
  });
});
