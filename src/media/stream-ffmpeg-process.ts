/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * stream-ffmpeg-process.ts: The live view's answer to a failed FFmpeg process and the failed-teardown policy classifier it is built on.
 */
import type { FfmpegEnding, FfmpegEndingVerdict, HomebridgePluginLogging } from "homebridge-plugin-utils";
import { exhaustiveGuard } from "../types.ts";

// Known-benign FFmpeg error patterns unique to the UniFi Protect livestream API path. These occasional inconsistencies in the controller's livestream output are not
// actionable by the user, so on the API/TSB path we substitute a friendly message for the canonical stderr dump. We match with an array .some(...).includes(...) so the
// patterns read as plain substrings rather than an assembled regular expression.
const LIVESTREAM_API_ERROR_PATTERNS = [

  "Cannot determine format of input stream 0:0 after EOF",
  "Finishing stream without any data written to it",
  "could not find corresponding trex",
  "moov atom not found"
];

// The exact user-facing sentence we emit in place of the stderr dump when a known-benign livestream-API hiccup ends FFmpeg on the API/TSB path.
const LIVESTREAM_API_ERROR_MESSAGE = "FFmpeg ended unexpectedly due to issues processing the media stream provided by the UniFi Protect livestream API. This error can " +
  "be safely ignored - it will occur occasionally.";

// Classify a failed FFmpeg teardown on the live (HomeKit) video path into one of its policy verdicts, given the accumulated stderr and whether the live view suppresses
// livestream-API hiccups. The decision is a pure total function of those two observed values, with a fixed short-circuit precedence: first a known-benign livestream-API
// hiccup, but ONLY when suppression is enabled, because a genuine RTSP/transcode/crop failure must still produce the canonical dump rather than the friendly sentence;
// then an FFmpeg probesize-estimation failure, which is ungated because the probesize self-tune runs for every FFmpeg error regardless of source; otherwise the canonical
// verdict. The benign branch matches the known-benign livestream-API patterns; the order (benign before probesize) matters because both can match on the same teardown,
// and checking probesize first would mask the friendlier benign message. This function returns the protocol VERDICT only - the user-facing label
// (LIVESTREAM_API_ERROR_MESSAGE) and all I/O stay with the dispatcher that consumes it.
export function classifyTeardownFailure(stderrLog: readonly string[], suppressLivestreamApiErrors: boolean): "benign-api" | "canonical" | "probesize" {

  // benign-API suppression first (gated on the captured flag); then probesize self-tune (ungated); else canonical.
  if(suppressLivestreamApiErrors && stderrLog.some((line) => LIVESTREAM_API_ERROR_PATTERNS.some((pattern) => line.includes(pattern)))) {

    return "benign-api";
  }

  if(stderrLog.some((line) => line.includes("not enough frames to estimate rate; consider increasing probesize"))) {

    return "probesize";
  }

  return "canonical";
}

/**
 * The live view's answer to a failed FFmpeg process, handed to HBPU as the process's onFailed. HBPU asks it inside the abort that ends a failed process, ahead of the
 * live view's ready and exit bridges, with the stderr lines the process read, and the answer decides what the log says: a known livestream API hiccup on a
 * buffer-backed view logs the friendly sentence in place of HBPU's report, FFmpeg running out of probe size before it could estimate the stream's rate raises the
 * probe size for the next start through the callback, which says so itself, and anything else is left to HBPU's full report. The decision is
 * classifyTeardownFailure's and this turns its verdict into an effect, so each effect is reachable with no process behind it.
 *
 * @param options                             - The answer's inputs.
 * @param options.log                         - The logger the friendly sentence is written to, the live view's own.
 * @param options.onProbesizeError            - Called when FFmpeg could not estimate the stream's rate, to raise the probe size for the next start.
 * @param options.suppressLivestreamApiErrors - Whether a known livestream API hiccup is answered with the friendly sentence, which holds for a buffer-backed view.
 *
 * @returns The onFailed callback, answering "handled" when it reported the failure itself and "default" to leave it to HBPU's report.
 */
export function liveViewOnFailed(options: { log: HomebridgePluginLogging; onProbesizeError: () => void; suppressLivestreamApiErrors: boolean }):
(ending: FfmpegEnding) => FfmpegEndingVerdict {

  const { log, onProbesizeError, suppressLivestreamApiErrors } = options;

  return (ending: FfmpegEnding): FfmpegEndingVerdict => {

    const verdict = classifyTeardownFailure(ending.stderrLog, suppressLivestreamApiErrors);

    switch(verdict) {

      case "benign-api":

        log.error(LIVESTREAM_API_ERROR_MESSAGE);

        return "handled";

      case "probesize":

        onProbesizeError();

        return "handled";

      case "canonical":

        return "default";

      default:

        exhaustiveGuard(verdict);

        return "default";
    }
  };
}
