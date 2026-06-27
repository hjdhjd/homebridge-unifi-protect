/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * stream-ffmpeg-process.ts: The live-path FFmpeg streaming process specialization and its failed-teardown policy classifier.
 */
import type { FfmpegOptions, HbpuAbortError, IpFamily } from "homebridge-plugin-utils";
import { FfmpegStreamingProcess } from "homebridge-plugin-utils";
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

// Classify a failed FFmpeg teardown on the live (HomeKit) video path into one of three policy verdicts, given the accumulated stderr and whether this instance suppresses
// livestream-API hiccups. The decision is a pure total function of those two observed values, with a fixed short-circuit precedence: first a known-benign livestream-API
// hiccup, but ONLY when suppression is enabled, because a genuine RTSP/transcode/crop failure must still produce the canonical dump rather than the friendly sentence;
// then an FFmpeg probesize-estimation failure, which is ungated because the probesize self-tune runs for every FFmpeg error regardless of source; otherwise the
// canonical verdict. The benign branch matches the known-benign livestream-API patterns; the order (benign before probesize) is load-bearing because both can match on
// the same teardown. This function returns the protocol VERDICT only - the user-facing label (LIVESTREAM_API_ERROR_MESSAGE) and all I/O stay with the dispatcher that
// consumes it.
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

// An FFmpeg streaming process specialization for the live (HomeKit) video path. The homebridge-plugin-utils base does not expose a teardown error-callback hook, so
// we implement the failed-teardown logging order through the overridable logFailedTeardown hook: the override classifies the failure via
// classifyTeardownFailure and dispatches each verdict to its I/O - a benign livestream-API hiccup substitutes a friendly sentence, a probesize-estimation failure
// self-tunes the probesize for the next run, and anything else falls through to the canonical ERROR dump. The suppression flag is captured from useTsb at construction
// and passed to the classifier. The return-audio FFmpeg uses the plain FfmpegStreamingProcess (no suppression, no probesize, no return-port watchdog) because it is
// outbound.
export class ProtectStreamingFfmpegProcess extends FfmpegStreamingProcess {

  readonly #onProbesizeError: () => void;
  readonly #suppressLivestreamApiErrors: boolean;

  constructor(options: FfmpegOptions, init: { args?: string[]; onProbesizeError: () => void; returnPort?: { ipFamily: IpFamily; port: number }; signal?: AbortSignal;
    suppressLivestreamApiErrors: boolean; }) {

    super(options, { args: init.args, returnPort: init.returnPort, signal: init.signal });

    this.#onProbesizeError = init.onProbesizeError;
    this.#suppressLivestreamApiErrors = init.suppressLivestreamApiErrors;
  }

  protected override logFailedTeardown(reason: HbpuAbortError): void {

    const verdict = classifyTeardownFailure(this.stderrLog, this.#suppressLivestreamApiErrors);

    switch(verdict) {

      case "benign-api":

        this.log.error(LIVESTREAM_API_ERROR_MESSAGE);

        return;

      case "probesize":

        this.#onProbesizeError();

        return;

      case "canonical":

        super.logFailedTeardown(reason);

        return;

      default:

        exhaustiveGuard(verdict);
    }
  }
}
