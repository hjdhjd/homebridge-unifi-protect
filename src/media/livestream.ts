/* Copyright(C) 2019-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * livestream.ts: the HomeKit-side livestream surface for UniFi Protect.
 *
 * This module is the thin plugin-owned seam onto the unifi-protect library's pooled livestream. The library owns the livestream protocol entirely - the websocket,
 * decode, pooling, recovery, the fMP4 Segment shape, and the subscription lifecycle state. The plugin owns only the HomeKit projection: the minimal subscription surface
 * its FFmpeg consumers (the live streaming delegate and the HKSV timeshift buffer) actually depend on, and the RTSP-debug variant of that same surface.
 *
 * This module holds:
 *
 *   - LivestreamSubscription: the plugin-owned interface (dependency inversion). The unifi-protect library's pooled subscription class and the RTSP-debug adapter
 *     below are interchangeable implementations behind it. The camera seam (ProtectCamera.livestream) returns this type.
 *   - RtspLivestreamSubscription: the RTSP-debug adapter, a pure-FFmpeg plugin concern that produces the same Segment stream behind the same interface.
 *   - logLivestreamIterationError: the shared classification and logging for errors thrown from a livestream subscription iterator, used by every consumer.
 */
import type { FMp4AudioTarget, FfmpegOptions, HomebridgePluginLogging } from "homebridge-plugin-utils";
import { FfmpegLivestreamProcess, splitMoofMdat } from "homebridge-plugin-utils";
import type { LivestreamSubscriptionState, Segment } from "unifi-protect";
import { ProtectCodecChangeError, ProtectLivestreamUnavailableError } from "unifi-protect";

// Process-local monotonic counter used to mint stable RTSP-debug subscription ids. A counter is sufficient here (no cross-process uniqueness needed) and keeps
// ids cheap, comparable, and greppable in logs.
let rtspSubscriptionCounter = 0;

/**
 * The minimal livestream-subscription surface the plugin's FFmpeg consumers depend on. The plugin OWNS this abstraction (dependency inversion): the unifi-protect
 * library's pooled LivestreamSubscription class and the RTSP-debug adapter below are interchangeable implementations behind it. It is a deliberate subset of the
 * library's richer class (interface segregation) - the plugin needs the segment stream, the cached init, the coarse lifecycle state (the timeshift's `isRestarting` reads
 * it), the in-flight recovery re-decision (the timeshift's transmit-start escalation calls it), disposal, identity, and the establishment latch, and nothing more (no
 * stats/codec). The coupling is a feature: a unifi-protect library change that breaks this surface fails to compile at ProtectCamera.livestream()'s return.
 */
export interface LivestreamSubscription extends AsyncIterable<Segment>, AsyncDisposable {

  readonly id: string;
  readonly initSegment: { codec: string; data: Buffer } | null;
  readonly state: LivestreamSubscriptionState;
  reassess(): void;
  whenEstablished(): Promise<boolean>;
}

// The fully-resolved options the RTSP-debug adapter needs. Every value is derived from camera facts at the camera seam, so the adapter never re-narrows or uses
// non-null assertions. The audio target mirrors the livestream API's native delivery shape and is the adapter's sole audio-encode input - it carries no HKSV
// recording configuration.
interface RtspLivestreamSubscriptionOptions {

  audio: FMp4AudioTarget;
  enableAudio: boolean;
  ffmpegOptions: FfmpegOptions;
  segmentLength?: number;
  signal?: AbortSignal;
  url: string;
  videoCodec: string;
}

/**
 * The RTSP-debug adapter (Debug.Video.Timeshift.UseRtsp). It implements the plugin's LivestreamSubscription interface over a single FfmpegLivestreamProcess that
 * transcodes the camera's RTSP stream into the same fMP4 Segment stream the unifi-protect library's pool produces, feeding the standing timeshift buffer from RTSP
 * rather than the native livestream API. This is a pure-FFmpeg plugin concern, so it stays the plugin behind the seam, and it is the mechanical seed of a future
 * first-class RTSP-fed-buffer option.
 *
 * There is deliberately NO recovery loop here: a failed RTSP transcode simply ends. The lifecycle state is correspondingly simple - "connecting" before the init
 * segment resolves, "live" after, "closed" after disposal - and it never reports "recovering" (so a consumer's `isRestarting` is always false on this debug
 * path, consistent with there being no recovery here). The underlying process consumes its abort signal itself at the spawn level, so disposing the adapter (or
 * aborting the signal) tears the process down; the adapter adds no separate signal listener.
 */
export class RtspLivestreamSubscription implements LivestreamSubscription {

  public readonly id: string;
  readonly #initPromise: Promise<Buffer>;
  #initSegment: { codec: string; data: Buffer } | null;
  #disposed: boolean;
  readonly #proc: FfmpegLivestreamProcess;
  readonly #signal?: AbortSignal;
  #state: LivestreamSubscriptionState;
  readonly #videoCodec: string;

  public constructor(options: RtspLivestreamSubscriptionOptions) {

    this.id = "rtsp-livestream-" + (++rtspSubscriptionCounter).toString();
    this.#disposed = false;
    this.#initSegment = null;
    this.#signal = options.signal;
    this.#state = "connecting";
    this.#videoCodec = options.videoCodec;

    this.#proc = new FfmpegLivestreamProcess(options.ffmpegOptions, {

      audio: options.audio,
      livestream: { codec: options.videoCodec, enableAudio: options.enableAudio, url: options.url },
      segmentLength: options.segmentLength,
      signal: options.signal
    });

    // Drive initSegment and whenEstablished from the process's init segment. We cache the resolved buffer and flip to "live" on success. We attach a no-op catch
    // so a construct-then-dispose-without-iterating sequence cannot float an unhandled rejection; the genuine consumers read the resolved value through
    // whenEstablished() and the iterator, both of which observe the original promise's outcome.
    this.#initPromise = this.#proc.getInitSegment();
    this.#initPromise.then((data): void => {

      if(this.#disposed) {

        return;
      }

      this.#initSegment = { codec: this.#videoCodec, data: data };
      this.#state = "live";
    }, (): void => { /* No-op: the rejection is observed through whenEstablished() and the iterator. */ });
  }

  // Synchronous peek at the cached fMP4 initialization segment, or null until the process's init segment resolves.
  public get initSegment(): { codec: string; data: Buffer } | null {

    return this.#initSegment;
  }

  // The coarse lifecycle state. "connecting" before the init resolves, "live" after, "closed" after disposal. Never "recovering" - the debug path has no recovery.
  public get state(): LivestreamSubscriptionState {

    return this.#state;
  }

  // Re-decide an in-flight recovery. A no-op here because the debug path has no recovery loop to re-consult: a failed RTSP transcode simply ends rather than
  // entering a deferred-stall state that an urgency escalation could shorten. The unifi-protect library's subscription implements this against its recovery FSM.
  public reassess(): void { /* No-op: the RTSP-debug path has no recovery loop to re-decide. */ }

  // Resolves true once the init segment resolves (the establishment boundary), false if it rejects. This is INIT-keyed, whereas the unifi-protect library's
  // whenEstablished is MEDIA-keyed (resolves on first media); both satisfy the consumer's only post-establish need (a populated initSegment), and the debug path has
  // no media-keyed liveness gate.
  public async whenEstablished(): Promise<boolean> {

    try {

      await this.#initPromise;

      return true;
    } catch {

      return false;
    }
  }

  // The subscription is its own async iterable, yielding the init Segment first (matching the unifi-protect library's pool, which delivers init before media) then
  // the media stream.
  public [Symbol.asyncIterator](): AsyncIterator<Segment> {

    return this.#iterate();
  }

  // Yield the init Segment, then wrap each fMP4 fragment the process produces into a media Segment. Calling both getInitSegment() and segments() on the process is
  // the intended two-views-on-one-drain pattern and does not double-consume.
  async *#iterate(): AsyncGenerator<Segment> {

    // The init buffer; this also drives initSegment / whenEstablished via the cached promise above.
    const data = await this.#initPromise;

    yield { codec: this.#videoCodec, data: data, type: "init" };

    for await (const fragment of this.#proc.segments({ signal: this.#signal })) {

      const split = splitMoofMdat(fragment);

      // splitMoofMdat returns null only on a malformed fragment, which well-formed FFmpeg fMP4 does not produce; degrade safely (consumers read only .data) by
      // treating the whole fragment as the mdat with an empty moof view rather than dropping the segment.
      const moof = split?.moof ?? fragment.subarray(0, 0);
      const mdat = split?.mdat ?? fragment;

      yield { data: fragment, mdat: mdat, moof: moof, type: "media" };
    }
  }

  // Dispose the underlying process. Idempotent - subsequent disposes after the first are no-ops.
  public async [Symbol.asyncDispose](): Promise<void> {

    if(this.#disposed) {

      return;
    }

    this.#disposed = true;
    this.#state = "closed";

    await this.#proc[Symbol.asyncDispose]();
  }
}

/**
 * Shared classification and logging for errors thrown from a livestream subscription iterator. Used by every consumer so the handling lives in one place.
 * `consumer` is the subject of the log sentence (e.g. "Timeshift buffer", "Live streaming"). The `ProtectCodecChangeError` and `ProtectLivestreamUnavailableError`
 * typed iterator errors from the unifi-protect library carry a known meaning we phrase for the user rather than surfacing as an unexpected failure: a codec change
 * is a benign, self-correcting restart, and an exhausted recovery episode is the give-up the pool throws after repeated reconnect failures. Everything else is
 * genuinely unexpected and logged with the error for diagnosis.
 *
 * @param options.consumer - The subject of the log sentence.
 * @param options.error - The error thrown from the iterator.
 * @param options.log - The logger to write to.
 */
export function logLivestreamIterationError(options: { consumer: string; error: unknown; log: HomebridgePluginLogging }): void {

  const { consumer, error, log } = options;

  // A codec change is the controller renegotiating the stream format mid-flight. The pool tears the session down and re-establishes it on the new codec, so this
  // is an expected, self-correcting restart rather than a failure.
  if(error instanceof ProtectCodecChangeError) {

    log.info(consumer + " is restarting because the livestream video format changed.");

    return;
  }

  // The recovery episode exhausted its reconnect attempts and the policy gave up. We have already done what we can (the consumer's self-heal reboots a wedged
  // camera), so we tell the user the stream could not be recovered rather than dumping an unexpected error.
  if(error instanceof ProtectLivestreamUnavailableError) {

    log.warn(consumer + " could not be recovered after repeated attempts.");

    return;
  }

  log.error(consumer + " iteration terminated unexpectedly.", { error });
}
