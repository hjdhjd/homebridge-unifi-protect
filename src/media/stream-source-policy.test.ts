/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * stream-source-policy.test.ts: Exhaustive red-green coverage of the pure session-source decision and the pure streaming-samplerate helper.
 *
 * Both are pure functions - no `this`, no I/O - so every cell is provable against constructed inputs, the property that makes pure decision modules exhaustively testable
 * in a way `this`-bound logic is not. The session-source table walks the seed, the A/B test flip, the recording-demand overrides, and the buffer-liveness fallback across
 * the codec and package axes; the samplerate table walks the doorbell and capability axes.
 */
import { describe, test } from "node:test";
import { AudioStreamingSamplerate } from "homebridge-plugin-utils";
import assert from "node:assert/strict";
import { resolveSessionSource } from "./stream-source-policy.ts";
import { streamingSamplerates } from "./stream-delegate.ts";

// The neutral session-source input: buffer-backed livestreaming off, no recording, buffer down, a plain camera on H.264, no A/B flip. Each test overrides only the axes
// it exercises, so the single variable per cell is the input under test.
function input(overrides: Partial<Parameters<typeof resolveSessionSource>[0]> = {}): Parameters<typeof resolveSessionSource>[0] {

  return { abTestFlip: false, bufferStarted: false, hasRecordingDemand: false, isPackageCamera: false, usesTimeshiftLivestream: false, videoCodec: "h264", ...overrides };
}

describe("resolveSessionSource - the seed and the buffer-liveness fallback", () => {

  test("the toggle on with the buffer running adopts the buffer without a kick", () => {

    assert.deepEqual(resolveSessionSource(input({ bufferStarted: true, usesTimeshiftLivestream: true })), { kick: false, source: "buffer" });
  });

  test("the toggle on with the buffer down falls back to RTSP and kicks the buffer to revive", () => {

    assert.deepEqual(resolveSessionSource(input({ bufferStarted: false, usesTimeshiftLivestream: true })), { kick: true, source: "rtsp" });
  });

  test("the toggle off streams directly over RTSP with no kick, even while recording keeps the buffer running", () => {

    assert.deepEqual(resolveSessionSource(input({ usesTimeshiftLivestream: false })), { kick: false, source: "rtsp" });
    assert.deepEqual(resolveSessionSource(input({ bufferStarted: true, hasRecordingDemand: true, usesTimeshiftLivestream: false })), { kick: false, source: "rtsp" });
  });
});

describe("resolveSessionSource - the A/B test flip", () => {

  test("the flip swaps the buffer choice to RTSP", () => {

    assert.deepEqual(resolveSessionSource(input({ abTestFlip: true, bufferStarted: true, usesTimeshiftLivestream: true })), { kick: false, source: "rtsp" });
  });

  test("the flip swaps the direct-RTSP choice to the buffer", () => {

    assert.deepEqual(resolveSessionSource(input({ abTestFlip: true, bufferStarted: true, usesTimeshiftLivestream: false })), { kick: false, source: "buffer" });
  });
});

describe("resolveSessionSource - the package-camera recording override", () => {

  test("a package camera prefers the buffer when recording, even with the toggle off", () => {

    assert.deepEqual(resolveSessionSource(input({ bufferStarted: true, hasRecordingDemand: true, isPackageCamera: true, usesTimeshiftLivestream: false })),
      { kick: false, source: "buffer" });
  });

  test("a package camera recording with the buffer down falls back to RTSP and kicks", () => {

    assert.deepEqual(resolveSessionSource(input({ bufferStarted: false, hasRecordingDemand: true, isPackageCamera: true, usesTimeshiftLivestream: false })),
      { kick: true, source: "rtsp" });
  });
});

describe("resolveSessionSource - the AV1 codec constraint", () => {

  test("AV1 with the toggle on and the buffer running adopts the buffer", () => {

    assert.deepEqual(resolveSessionSource(input({ bufferStarted: true, usesTimeshiftLivestream: true, videoCodec: "av1" })), { kick: false, source: "buffer" });
  });

  test("AV1 with a buffer claim but the buffer down rides a degraded transient session on the substrate channel and kicks", () => {

    assert.deepEqual(resolveSessionSource(input({ bufferStarted: false, usesTimeshiftLivestream: true, videoCodec: "av1" })), { kick: true, source: "bufferDegraded" });
    assert.deepEqual(resolveSessionSource(input({ bufferStarted: false, hasRecordingDemand: true, usesTimeshiftLivestream: false, videoCodec: "av1" })),
      { kick: true, source: "bufferDegraded" });
  });

  test("AV1 recording with the buffer running adopts the buffer even with the toggle off", () => {

    assert.deepEqual(resolveSessionSource(input({ bufferStarted: true, hasRecordingDemand: true, usesTimeshiftLivestream: false, videoCodec: "av1" })),
      { kick: false, source: "buffer" });
  });

  test("AV1 with no buffer claim at all is unavailable - the hard-error cell", () => {

    assert.deepEqual(resolveSessionSource(input({ hasRecordingDemand: false, usesTimeshiftLivestream: false, videoCodec: "av1" })),
      { kick: false, source: "unavailable" });
  });
});

describe("streamingSamplerates - the doorbell and capability axes", () => {

  test("a doorbell advertises both 16 and 24 kHz in every population", () => {

    assert.deepEqual(streamingSamplerates({ isDoorbell: true, usesTimeshiftLivestream: true }),
      [ AudioStreamingSamplerate.KHZ_16, AudioStreamingSamplerate.KHZ_24 ]);
    assert.deepEqual(streamingSamplerates({ isDoorbell: true, usesTimeshiftLivestream: false }),
      [ AudioStreamingSamplerate.KHZ_16, AudioStreamingSamplerate.KHZ_24 ]);
  });

  test("a buffer-backed non-doorbell advertises just 16 kHz", () => {

    assert.equal(streamingSamplerates({ isDoorbell: false, usesTimeshiftLivestream: true }), AudioStreamingSamplerate.KHZ_16);
  });

  test("a non-doorbell streamed directly over RTSP (toggle off or not capable) advertises both 16 and 24 kHz", () => {

    assert.deepEqual(streamingSamplerates({ isDoorbell: false, usesTimeshiftLivestream: false }),
      [ AudioStreamingSamplerate.KHZ_16, AudioStreamingSamplerate.KHZ_24 ]);
  });
});
