/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * record-init-stream.ts: The HKSV init-then-media segment generator - re-stitches the v2 getInitSegment()/segments() split with the load-bearing pre-init-abort guard.
 *
 * The author would like to acknowledge and thank Supereg (https://github.com/Supereg) and Sunoo (https://github.com/Sunoo)
 * for being sounding boards as I worked through several ideas and iterations of this work. Their camaraderie and support was
 * deeply appreciated.
 */
import type { RecordingProcess } from "homebridge-plugin-utils";

// Reproduce the HBPU-v1 segmentGenerator contract on top of the v2 split surface. In v1 the FFmpeg process yielded the fMP4 initialization segment as the first item of
// a single generator, so the recording loop counted, paced, and break-checked it like any media segment (then discounted it once at teardown). The v2 surface splits
// getInitSegment() from segments(), so we re-stitch them here: yield the init first, then stream the media. The guard is load-bearing - v1's generator returned cleanly
// when the stream aborted before the init arrived (it never threw out of the HAP generator), but v2's getInitSegment() rejects with signal.reason on a pre-init abort.
// We catch that rejection and return, ending the for-await cleanly so the post-loop teardown yields its end-of-stream marker exactly as v1 did on a HAP-close or a thin
// discontinuity restart.
export async function *initThenMedia(proc: RecordingProcess, signal: AbortSignal): AsyncGenerator<Buffer> {

  let init: Buffer;

  try {

    init = await proc.getInitSegment();
  } catch {

    return;
  }

  yield init;
  yield* proc.segments({ signal });
}
