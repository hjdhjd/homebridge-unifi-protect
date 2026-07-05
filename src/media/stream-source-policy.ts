/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * stream-source-policy.ts: the pure decision of which transport a live view draws from, for UniFi Protect.
 *
 * A HomeKit live view is served either from the camera's standing timeshift buffer (the pooled fMP4 socket shared with HomeKit Secure Video and snapshots) or directly
 * from the camera over RTSP. Which one, and whether the buffer needs a wake to revive it behind a transient fallback, is a small ordered decision with several
 * interacting inputs (the buffer-backed-livestreaming toggle, the recording demand, the buffer's liveness, the package-camera preference, the AV1 codec constraint,
 * and the internal A/B test). This module is that decision as a pure function - no `this`, no I/O - so every cell is exhaustively unit-testable with constructed inputs,
 * matching the pure-module voice of livestream-recovery-policy.ts and resolution.ts. The streaming delegate holds only the `this`-state reads that feed it and the
 * per-source wiring that consumes its result.
 *
 * The result is a discriminated source plus a `kick` flag:
 *
 *   - "buffer": adopt the running buffer's channel and ride the pooled socket.
 *   - "bufferDegraded": the buffer is wanted but not yet running and the codec cannot fall back to RTSP (AV1), so ride a transient pooled session on the substrate
 *     channel while the kick revives the standing buffer behind it.
 *   - "rtsp": a genuine direct-RTSP session (the explicit opt-out, a non-capable camera, or a buffer that is momentarily down for a codec that can fall back).
 *   - "unavailable": AV1 with no buffer path at all - the hard-error cell.
 *
 * `kick` asks the caller to fire the supervisor's reconcile (never awaited) so a buffer that should be running but is momentarily down re-establishes behind the
 * fallback that served this request.
 */

// The transport a live view draws from. See the module header for each variant's meaning.
export type StreamSource = "buffer" | "bufferDegraded" | "rtsp" | "unavailable";

// The resolved session-source decision: the chosen transport, plus whether the caller should wake the supervisor to revive a momentarily-down buffer behind a fallback.
export interface StreamSourceDecision {

  kick: boolean;
  source: StreamSource;
}

/**
 * Resolve which transport a live view draws from, given the camera's current facts. Pure and exhaustively testable.
 *
 * The ordered decision, first applicable step winning:
 *
 *   1. Seed: buffer-backed livestreaming serves live views when the toggle is on and the camera is capable; otherwise direct RTSP.
 *   2. A/B test (internal development only): swap the chosen transport.
 *   3. Package cameras prefer the buffered API path when recording, regardless of the toggle; it only matters when the seed picked RTSP.
 *   4. AV1 cannot stream over RTSP. If we would otherwise pick RTSP for an AV1 camera, redirect to the buffer path when one exists, else the stream is unavailable.
 *   5. Buffer-liveness fallback: when the buffer is wanted but not running, an AV1 camera rides a transient session on the substrate channel ("bufferDegraded") and
 *      any other codec falls back to RTSP; each wakes the supervisor to revive the standing buffer behind the fallback.
 *   6. Otherwise, direct RTSP.
 *
 * @param input.abTestFlip            - Whether the internal A/B test is active for this request (flips the chosen transport).
 * @param input.bufferStarted         - Whether the standing timeshift buffer is currently running.
 * @param input.hasRecordingDemand    - Whether HomeKit Secure Video recording is currently active.
 * @param input.isPackageCamera       - Whether this is the doorbell's package camera.
 * @param input.usesTimeshiftLivestream - Whether buffer-backed livestreaming is enabled and the camera is capable of it.
 * @param input.videoCodec            - The camera's negotiated video codec (only "av1" changes the decision).
 *
 * @returns The resolved {@link StreamSourceDecision}.
 */
export function resolveSessionSource(input: { abTestFlip: boolean; bufferStarted: boolean; hasRecordingDemand: boolean; isPackageCamera: boolean;
  usesTimeshiftLivestream: boolean; videoCodec: string; }): StreamSourceDecision {

  const isAv1 = input.videoCodec === "av1";

  // 1. Seed: the standing buffer serves live views when the toggle is on and the camera is capable; otherwise we stream directly over RTSP.
  let wantBuffer = input.usesTimeshiftLivestream;

  // 2. A/B test: swap the transport. Internal development only, gated by the caller.
  if(input.abTestFlip) {

    wantBuffer = !wantBuffer;
  }

  // 3. A package camera prefers the buffered API path when recording, regardless of the toggle; this only matters when the seed picked RTSP.
  if(!wantBuffer && input.hasRecordingDemand && input.isPackageCamera) {

    wantBuffer = true;
  }

  // 4. AV1 cannot stream over RTSP. If we would otherwise use RTSP for an AV1 camera, take the buffer path when a claim on it exists (the toggle is on or recording is
  //    active); with no buffer path there is no viable source and the stream is unavailable.
  if(isAv1 && !wantBuffer) {

    if(input.usesTimeshiftLivestream || input.hasRecordingDemand) {

      wantBuffer = true;
    } else {

      return { kick: false, source: "unavailable" };
    }
  }

  // 5. Buffer-liveness fallback: we want the buffer but it is not running. AV1 cannot fall back to RTSP, so it rides a transient pooled session on the substrate channel;
  //    any other codec falls back to RTSP. Both wake the supervisor to revive the standing buffer behind the fallback.
  if(wantBuffer) {

    if(input.bufferStarted) {

      return { kick: false, source: "buffer" };
    }

    if(isAv1) {

      return { kick: true, source: "bufferDegraded" };
    }

    return { kick: true, source: "rtsp" };
  }

  // 6. Direct RTSP.
  return { kick: false, source: "rtsp" };
}
