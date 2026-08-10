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
 * The result is the chosen transport plus a `kick` flag:
 *
 *   - "buffer": adopt the running buffer's channel and ride the pooled socket.
 *   - "bufferDegraded": the buffer is wanted but not yet running and the camera cannot fall back to RTSP (AV1, or no RTSP-enabled stream to dial), so ride a transient
 *     pooled session on the substrate channel while the kick revives the standing buffer behind it.
 *   - "rtsp": a genuine direct-RTSP session, which requires an RTSP-enabled stream to exist (the explicit opt-out, a camera that cannot reach the livestream API, or a
 *     buffer that is momentarily down for a camera that can fall back).
 *   - "unavailable": a camera that can reach neither transport - it cannot use the livestream API and has nothing to dial over RTSP. The hard-error cell.
 *
 * The buffer-backed-livestreaming toggle is a live-view transport PREFERENCE, not a requirement: a camera that can reach the livestream API but cannot stream over RTSP
 * serves its live views from the buffer path whatever the toggle says, because degrading gracefully beats refusing to stream.
 *
 * `kick` asks the caller to fire the supervisor's reconcile (never awaited) so a buffer that should be running but is momentarily down re-establishes behind the
 * fallback that served this request.
 */

/* The resolved session-source decision: the chosen transport, plus whether the caller should wake the supervisor to revive a momentarily-down buffer behind a fallback.
 * See the module header for each transport's meaning.
 *
 * The two variants split on whether a transport was found. A served decision carries no cause, because there is nothing to explain; an unavailable one always carries
 * the cause, which is what picks the remedy the caller narrates. Writing it as a union rather than one shape with an optional cause is what makes both illegal states -
 * a cause on a served decision, and an unavailable decision without one - unrepresentable rather than merely unexpected.
 */
export type StreamSourceDecision = { kick: boolean; source: "buffer" | "bufferDegraded" | "rtsp" } |
  { cause: "av1" | "noRtspStream"; kick: false; source: "unavailable" };

// Whether a camera can reach the UniFi Protect livestream API - the transport-capability fact the session-source decision, the camera's derivation terminal, the
// camera's own buffer-arm gate, and the supervisor's construction all read. A first-party camera always can; a third-party camera can only when it is paired with an
// AiPort, which is what puts it on the controller's own livestream path.
export function canUseLivestreamApi(config: { isPairedWithAiPort: boolean; isThirdPartyCamera: boolean }): boolean {

  return !config.isThirdPartyCamera || config.isPairedWithAiPort;
}

/**
 * Resolve which transport a live view draws from, given the camera's current facts. Pure and exhaustively testable.
 *
 * The ordered decision, first applicable step winning:
 *
 *   1. Seed: buffer-backed livestreaming serves live views when the toggle is on and the camera is capable; otherwise direct RTSP.
 *   2. A/B test (internal development only): swap the chosen transport.
 *   3. Package cameras prefer the buffered API path when recording, regardless of the toggle; it only matters when the seed picked RTSP.
 *   4. The floor: a camera that cannot fall back to RTSP - AV1, which FFmpeg cannot carry that way, or no RTSP-enabled stream to dial - takes the buffer path wherever
 *      it can reach the livestream API, whatever the toggle says. Only a camera that can reach neither transport is unavailable.
 *   5. Buffer-liveness fallback: when the buffer is wanted but not running, a camera that cannot fall back to RTSP rides a transient session on the substrate channel
 *      ("bufferDegraded") and any other falls back to RTSP; each wakes the supervisor to revive the standing buffer behind the fallback.
 *   6. Otherwise, direct RTSP.
 *
 * @param input.abTestFlip            - Whether the internal A/B test is active for this request (flips the chosen transport).
 * @param input.bufferStarted         - Whether the standing timeshift buffer is currently running.
 * @param input.canUseBuffer          - Whether this camera can reach the UniFi Protect livestream API that fills the buffer.
 * @param input.hasRecordingDemand    - Whether HomeKit Secure Video recording is currently active.
 * @param input.hasRtspStream         - Whether an RTSP-enabled stream exists to draw a direct session from.
 * @param input.isPackageCamera       - Whether this is the doorbell's package camera.
 * @param input.usesTimeshiftLivestream - Whether buffer-backed livestreaming is enabled and the camera is capable of it.
 * @param input.videoCodec            - The camera's negotiated video codec (only "av1" changes the decision).
 *
 * @returns The resolved {@link StreamSourceDecision}.
 */
export function resolveSessionSource(input: { abTestFlip: boolean; bufferStarted: boolean; canUseBuffer: boolean; hasRecordingDemand: boolean; hasRtspStream: boolean;
  isPackageCamera: boolean; usesTimeshiftLivestream: boolean; videoCodec: string; }): StreamSourceDecision {

  const isAv1 = input.videoCodec === "av1";

  // Whether a direct-RTSP session is available to this camera at all: FFmpeg cannot carry AV1 over RTSP, and a camera with no RTSP-enabled stream has nothing to draw a
  // direct session from. Both take the pooled-API path wherever the camera can reach it.
  const cannotFallBackToRtsp = isAv1 || !input.hasRtspStream;

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

  /* 4. The floor. If we would otherwise stream directly over RTSP but this camera cannot, take the buffer path wherever the camera can reach the livestream API. The
   *    toggle does not gate the redirect: a user who prefers direct RTSP is expressing a transport preference, and honoring it by refusing to stream at all would serve
   *    nobody, so such a camera degrades to the buffer path instead. Only a camera that can reach neither transport has no viable source, and its cause picks the remedy
   *    the caller narrates - AV1 wins the label when both hold, because enabling an RTSP stream cannot help a camera FFmpeg could not carry that way regardless.
   */
  if(cannotFallBackToRtsp && !wantBuffer) {

    if(input.canUseBuffer) {

      wantBuffer = true;
    } else {

      return { cause: isAv1 ? "av1" : "noRtspStream", kick: false, source: "unavailable" };
    }
  }

  // 5. Buffer-liveness fallback: we want the buffer but it is not running. A camera that cannot fall back to RTSP rides a transient pooled session on the substrate
  //    channel; any other falls back to RTSP. Both wake the supervisor to revive the standing buffer behind the fallback.
  if(wantBuffer) {

    if(input.bufferStarted) {

      return { kick: false, source: "buffer" };
    }

    if(cannotFallBackToRtsp) {

      return { kick: true, source: "bufferDegraded" };
    }

    return { kick: true, source: "rtsp" };
  }

  // 6. Direct RTSP.
  return { kick: false, source: "rtsp" };
}
