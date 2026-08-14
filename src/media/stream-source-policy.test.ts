/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * stream-source-policy.test.ts: Exhaustive red-green coverage of the pure session-source decision and the pure streaming-samplerate helper.
 *
 * Each is a pure function - no `this`, no I/O - so every cell is provable against constructed inputs, the property that makes pure decision modules exhaustively testable
 * in a way `this`-bound logic is not. The session-source table walks the seed, the A/B test flip, the recording-demand overrides, and the buffer-liveness fallback across
 * the codec and package axes; the samplerate table walks the doorbell and capability axes.
 */
import { describe, test } from "node:test";
import { AudioStreamingSamplerate } from "homebridge-plugin-utils";
import assert from "node:assert/strict";
import { resolveSessionSource } from "./stream-source-policy.ts";
import { streamingSamplerates } from "./stream-delegate.ts";

// The neutral session-source input: buffer-backed livestreaming off, no recording, buffer down, a plain camera on H.264 that can reach the livestream API and has an
// RTSP-enabled stream to dial, no A/B flip. Each test overrides only the axes it exercises, so the single variable per cell is the input under test. The capability
// defaults (canUseBuffer, hasRtspStream) are true because that is the ordinary camera every pre-existing cell below was written against, which is what makes those cells
// the parity floor.
function input(overrides: Partial<Parameters<typeof resolveSessionSource>[0]> = {}): Parameters<typeof resolveSessionSource>[0] {

  return { abTestFlip: false, bufferStarted: false, canUseBuffer: true, hasRecordingDemand: false, hasRtspStream: true, isPackageCamera: false,
    usesTimeshiftLivestream: false, videoCodec: "h264", ...overrides };
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

  // The AV1 floor cell. An AV1 camera with the toggle off and nothing recording has no buffer CLAIM, but it can still reach the livestream API - so it degrades to the
  // buffer path rather than erroring, which is the whole point of treating the toggle as a transport preference. The kick is a deliberate no-op when no standing-buffer
  // demand exists; the supervisor's own shouldRun still answers that question.
  test("AV1 with the toggle off and no recording degrades to the buffer path wherever the API is reachable", () => {

    assert.deepEqual(resolveSessionSource(input({ hasRecordingDemand: false, usesTimeshiftLivestream: false, videoCodec: "av1" })),
      { kick: true, source: "bufferDegraded" });
  });
});

describe("resolveSessionSource - the no-RTSP-stream grid (the camera can reach the API)", () => {

  test("the toggle on with the buffer running adopts the buffer, RTSP state irrelevant", () => {

    assert.deepEqual(resolveSessionSource(input({ bufferStarted: true, hasRtspStream: false, usesTimeshiftLivestream: true })), { kick: false, source: "buffer" });
  });

  test("the toggle on with the buffer down rides a degraded transient session rather than falling back to RTSP it cannot dial", () => {

    assert.deepEqual(resolveSessionSource(input({ hasRtspStream: false, usesTimeshiftLivestream: true })), { kick: true, source: "bufferDegraded" });
  });

  test("the toggle on with the buffer down on AV1 rides a degraded transient session", () => {

    assert.deepEqual(resolveSessionSource(input({ hasRtspStream: false, usesTimeshiftLivestream: true, videoCodec: "av1" })),
      { kick: true, source: "bufferDegraded" });
  });

  // The floor cell for the ordinary no-RTSP camera: the user asked for direct RTSP, nothing is recording, and there is no RTSP stream to dial. The camera can still
  // reach the livestream API, so its live views come from the buffer path rather than failing - the whole point of treating the toggle as a preference.
  test("the toggle off with no RTSP stream degrades to the buffer path rather than failing", () => {

    assert.deepEqual(resolveSessionSource(input({ hasRtspStream: false, usesTimeshiftLivestream: false })), { kick: true, source: "bufferDegraded" });
  });

  test("the toggle off while recording with the buffer down rides a degraded transient session", () => {

    assert.deepEqual(resolveSessionSource(input({ hasRecordingDemand: true, hasRtspStream: false, usesTimeshiftLivestream: false })),
      { kick: true, source: "bufferDegraded" });
  });

  test("the toggle off while recording with the buffer running adopts the buffer", () => {

    assert.deepEqual(resolveSessionSource(input({ bufferStarted: true, hasRecordingDemand: true, hasRtspStream: false, usesTimeshiftLivestream: false })),
      { kick: false, source: "buffer" });
  });

  test("a package camera recording with the buffer down and no RTSP stream rides a degraded transient session", () => {

    assert.deepEqual(resolveSessionSource(input({ hasRecordingDemand: true, hasRtspStream: false, isPackageCamera: true, usesTimeshiftLivestream: false })),
      { kick: true, source: "bufferDegraded" });
  });

  // The A/B flip swaps a buffer choice to RTSP, and the floor then catches it: a camera with no RTSP stream cannot honor the swap, so it comes back to the buffer path.
  test("the A/B flip off the buffer comes back to the buffer path when there is no RTSP stream to swap to", () => {

    assert.deepEqual(resolveSessionSource(input({ abTestFlip: true, hasRtspStream: false, usesTimeshiftLivestream: true })), { kick: true, source: "bufferDegraded" });
  });
});

describe("resolveSessionSource - the unavailable terminal (the camera cannot reach the API)", () => {

  test("no buffer and no RTSP stream is unavailable, and the cause names the RTSP remedy", () => {

    assert.deepEqual(resolveSessionSource(input({ canUseBuffer: false, hasRtspStream: false, usesTimeshiftLivestream: false })),
      { cause: "noRtspStream", kick: false, source: "unavailable" });
  });

  // AV1 wins the cause label when both hold: enabling an RTSP stream cannot help a camera FFmpeg could not carry that way regardless, so the remedy would mislead.
  test("no buffer, no RTSP stream, and AV1 is unavailable with the AV1 cause", () => {

    assert.deepEqual(resolveSessionSource(input({ canUseBuffer: false, hasRtspStream: false, usesTimeshiftLivestream: false, videoCodec: "av1" })),
      { cause: "av1", kick: false, source: "unavailable" });
  });

  test("no buffer and AV1 is unavailable even with an RTSP stream available, since FFmpeg cannot carry AV1 that way", () => {

    assert.deepEqual(resolveSessionSource(input({ canUseBuffer: false, usesTimeshiftLivestream: false, videoCodec: "av1" })),
      { cause: "av1", kick: false, source: "unavailable" });
  });

  test("no buffer but an RTSP stream on H.264 dials RTSP exactly as it always has", () => {

    assert.deepEqual(resolveSessionSource(input({ canUseBuffer: false, usesTimeshiftLivestream: false })), { kick: false, source: "rtsp" });
  });
});

describe("streamingSamplerates - the doorbell and capability axes", () => {

  test("a doorbell advertises both 16 and 24 kHz in every population", () => {

    assert.deepEqual(streamingSamplerates({ canUseLivestreamApi: true, isDoorbell: true }),
      [ AudioStreamingSamplerate.KHZ_16, AudioStreamingSamplerate.KHZ_24 ]);
    assert.deepEqual(streamingSamplerates({ canUseLivestreamApi: false, isDoorbell: true }),
      [ AudioStreamingSamplerate.KHZ_16, AudioStreamingSamplerate.KHZ_24 ]);
  });

  // The capability, not the user's transport preference, is what decides: a camera that can reach the livestream API may serve any given session from the 16 kHz buffer
  // track whatever the toggle says, so it advertises only what every one of its sessions can actually deliver.
  test("a non-doorbell that can reach the livestream API advertises just 16 kHz", () => {

    assert.equal(streamingSamplerates({ canUseLivestreamApi: true, isDoorbell: false }), AudioStreamingSamplerate.KHZ_16);
  });

  test("a non-doorbell that cannot reach the livestream API is RTSP-served and advertises both 16 and 24 kHz", () => {

    assert.deepEqual(streamingSamplerates({ canUseLivestreamApi: false, isDoorbell: false }),
      [ AudioStreamingSamplerate.KHZ_16, AudioStreamingSamplerate.KHZ_24 ]);
  });
});
