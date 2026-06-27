/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * record-init-stream.ts: The HKSV init-then-media segment generator - re-stitches the getInitSegment()/segments() split with the load-bearing pre-init-abort guard.
 *
 * The author would like to acknowledge and thank Supereg (https://github.com/Supereg) and Sunoo (https://github.com/Sunoo)
 * for being sounding boards as I worked through several ideas and iterations of this work. Their camaraderie and support was
 * deeply appreciated.
 */
import type { RecordingProcess } from "homebridge-plugin-utils";

// Re-stitch the homebridge-plugin-utils getInitSegment()/segments() split into a single init-then-media generator. The recording loop counts, paces, and break-checks
// the init segment like any media segment (then discounts it once at teardown), so it wants the init delivered inline as the first yielded item rather than fetched
// through a separate call. We yield the init first, then stream the media. The guard is load-bearing: getInitSegment() rejects with signal.reason when the stream
// aborts before the init arrives, so we catch that rejection and return, ending the for-await cleanly so the post-loop teardown yields its end-of-stream marker on a
// HAP-close or a thin discontinuity restart.
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
