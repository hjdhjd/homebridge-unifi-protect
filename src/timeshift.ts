/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-timeshift.ts: UniFi Protect livestream timeshift buffer implementation to support HomeKit Secure Video.
 */
import type { HomebridgePluginLogging, Nullable } from "homebridge-plugin-utils";
import { PROTECT_LIVESTREAM_ACTIVE_TOLERANCE_MS, PROTECT_LIVESTREAM_API_IDR_INTERVAL, PROTECT_LIVESTREAM_IDLE_TOLERANCE_MS, PROTECT_SEGMENT_RESOLUTION }
  from "./settings.ts";
import type { ChannelProfile } from "./devices/resolution.ts";
import { EventEmitter } from "node:events";
import { LIVE_SELF_HEAL_THRESHOLD } from "./livestream-recovery-policy.ts";
import type { LivestreamSubscription } from "./livestream.ts";
import type { ProtectCameraHost } from "./camera-host.ts";
import { ProtectLivestreamUnavailableError } from "unifi-protect";
import type { Segment } from "unifi-protect";
import { isKeyframe } from "homebridge-plugin-utils";
import { logLivestreamIterationError } from "./livestream.ts";

// Typed event map for the timeshift buffer. Consumers (recording delegate) listen for these.
//
// - `segment`: the next fMP4 fragment is ready for a transmitting consumer.
// - `discontinuity`: the underlying livestream dropped and recovered while transmitting; the buffer now has a clean keyframe, and the consumer should restart
//   its decoder with fresh data. Non-terminal - the subscription is still alive and will continue delivering segments.
// - `terminated`: the backing subscription has ended while the consumer was transmitting - either via iterator-level termination (ProtectLagError, the recovery
//   give-up, an unexpected error) or via an explicit stop() (controller disconnect, reconciler teardown). The buffer is empty and `isStarted` is now false.
//   Terminal for the current transmit session: the consumer should end its event cleanly rather than wait for downstream stall timeouts.
interface TimeshiftBufferEvents {

  discontinuity: [];
  segment: [Buffer];
  terminated: [];
}

// Return shape of getKeyframeAlignedStart. Names the two coordinates a caller needs to feed keyframe-aligned data into FFmpeg: the buffer index to begin
// reading from (starts on a keyframe), and the sub-segment seek offset to hand to FFmpeg's -ss parameter for fine alignment within that keyframe's window.
interface KeyframeAlignedStart {

  seekOffsetMs: number;
  startIndex: number;
}

// A single buffered timeshift entry. The fMP4 fragment and its keyframe classification are bound together in one struct so the segment and its keyframe flag are
// stored, trimmed, and cleared as an indivisible unit. This makes a desync between a fragment and its keyframe flag structurally unrepresentable, replacing the
// former pair of index-parallel arrays whose lockstep invariant was enforced only by convention.
interface TimeshiftSegment {

  data: Buffer;
  isKeyframe: boolean;
}

// UniFi Protect livestream timeshift buffer.
export class ProtectTimeshiftBuffer extends EventEmitter<TimeshiftBufferEvents> {

  private _isTransmitting: boolean;
  private _lastKeyframeTime: number;
  private _pendingDiscontinuity: boolean;
  private _segments: TimeshiftSegment[];
  // Segment resolution for the timeshift buffer. Fixed at PROTECT_SEGMENT_RESOLUTION (100ms) because a small value gives HKSV a better event recording experience
  // at a trivial CPU cost on modern systems.
  private readonly _segmentLength: number = PROTECT_SEGMENT_RESOLUTION;
  private readonly log: HomebridgePluginLogging;
  private readonly protectCamera: ProtectCameraHost;
  private segmentCount: number;
  // The active livestream subscription. Its presence is the single source of truth for whether the timeshift buffer is running; the public `isStarted` getter
  // derives from `subscription !== undefined`.
  private subscription?: LivestreamSubscription;

  constructor(protectCamera: ProtectCameraHost) {

    // Initialize the event emitter.
    super();

    this._isTransmitting = false;
    this._lastKeyframeTime = 0;
    this._pendingDiscontinuity = false;
    this._segments = [];
    this.log = protectCamera.log;
    this.protectCamera = protectCamera;
    this.segmentCount = 1;
  }

  // Start the livestream and begin maintaining our timeshift buffer.
  public async start(channelProfile: ChannelProfile): Promise<boolean> {

    // Stop the timeshift buffer if it's already running.
    if(this.isStarted) {

      this.stop();
    }

    // Clear out the timeshift buffer, if it's been previously filled, and then fire up the timeshift buffer.
    this.clearBuffer();

    // Create the pooled livestream subscription via the camera seam. This call is synchronous: it returns the subscription handle immediately and begins
    // establishing the underlying connection in the background. We start consuming segments below within the same synchronous frame, which guarantees the consumer
    // is in place before any asynchronous segment can be delivered on the subscription.
    //
    // We declare a recovery urgency closure the v5 pool reads live when it derives its recovery-await window: zero while transmitting (latency-sensitive, so an
    // in-flight recording reconnects immediately rather than easing off a stressed controller) and the idle tolerance otherwise (latency-tolerant, so an idle
    // prebuffer eases off a stressed-but-reachable controller). The closure moves only the recovery tolerance; v5's media-stall detection floors at max(urgency,
    // 2000ms) regardless, so the prebuffer stays watched at the 2-second parity window either way. A genuine reconnect surfaces inline as a discontinuity-marked
    // segment (handled in processSegment), so there is no separate disconnect handler to attach.
    const subscription = this.protectCamera.livestream(channelProfile, { segmentLength: this._segmentLength,
      urgency: () => this._isTransmitting ? PROTECT_LIVESTREAM_ACTIVE_TOLERANCE_MS : PROTECT_LIVESTREAM_IDLE_TOLERANCE_MS });

    // Drive the segment iterator in the background. The for-await loop runs until the subscription is disposed (graceful return), terminated with a typed error
    // (ProtectLagError if our consumer queue overflowed, ProtectLivestreamUnavailableError if the recovery policy gave up, a codec change, or another unexpected
    // failure), or otherwise rejects. Errors are classified and logged and the loop exits cleanly...stop() is the single release point that disposes the
    // subscription.
    void this.consumeSegments(subscription);

    // Wait for the session to establish. v5's whenEstablished is MEDIA-keyed: it resolves true once the first media segment has been delivered (not merely on
    // init), false if the session terminated during provisioning.
    if(!(await subscription.whenEstablished())) {

      void subscription[Symbol.asyncDispose]();

      return false;
    }

    // v5 delivers the init segment before the first media segment, so by the time the media-keyed whenEstablished resolves true, the init segment is already
    // populated. A null init here violates the library contract and is treated as a hard failure. Dispose the local subscription directly; the instance field
    // only ever receives a subscription that has passed every validation, so `isStarted` never flips true during the validation window.
    if(!subscription.initSegment) {

      void subscription[Symbol.asyncDispose]();

      return false;
    }

    // Every check has passed. Commit the subscription as the backing state; isStarted flips from false to true atomically with this assignment.
    this.subscription = subscription;

    return true;
  }

  // Consume segments from the subscription's async iterator. Runs in the background for the lifetime of the subscription. Each segment is processed (buffered,
  // keyframe-tracked, optionally forwarded to the recording delegate). Termination is signaled by iterator return (graceful disposal) or a typed error thrown
  // into the iterator. Error classification is centralised in logLivestreamIterationError so every livestream consumer uses identical phrasing and suppression
  // rules.
  //
  // The finally block is the self-cleaning anchor for out-of-band iterator termination (ProtectLagError, the recovery give-up, unexpected errors). The id-based
  // identity guard discriminates four teardown paths with a single compare, and is resilient to future indirection (proxies, wrappers) because subscription ids
  // are stable strings rather than object references:
  //
  //   - stop() called externally: stop() cleared `this.subscription` before the iterator observed the queue close, so the id compare against undefined fails
  //     and we no-op (stop() already fired the terminated emit if applicable).
  //   - start() validation failed: the local subscription was disposed before `this.subscription` was committed to it, so the ids don't match and we no-op.
  //   - terminal typed error (e.g., ProtectLagError): the subscription was committed and is now disposed without our teardown running, so the ids match
  //     and we reset backing state to match reality via finalizeSubscription.
  //   - session-level termination (controller manager shutdown): the subscription's iterator closes from outside, the ids match, and we self-clean.
  //
  // This keeps `isStarted` honest...no observable window where the getter reports true against a dead subscription.
  private async consumeSegments(subscription: LivestreamSubscription): Promise<void> {

    try {

      for await (const segment of subscription) {

        this.processSegment(segment);
      }
    } catch(error) {

      // Logging and self-healing are separate concerns: classify and log the iterator error for the user, then decide whether this error is the recovery
      // policy's give-up and a wedged camera should be rebooted to reset its livestream endpoint.
      logLivestreamIterationError({ consumer: "Timeshift buffer", error, log: this.log });
      this.selfHeal(error);
    } finally {

      if(this.subscription?.id === subscription.id) {

        this.finalizeSubscription();
      }
    }
  }

  // Reboot a wedged camera to recover its livestream, the consumer half of the recovery policy's self-heal (pre-v5 parity). The v5 recovery policy gives up - and
  // the iterator throws ProtectLivestreamUnavailableError carrying the attempt count - only after LIVE_SELF_HEAL_THRESHOLD consecutive failed reconnects on a
  // reachable controller (a drowning controller waits indefinitely without ever giving up, so this is never reached for an overloaded controller). When that
  // give-up arrives, self-healing is enabled, the camera is reachable, and we are not tearing the controller down ourselves, we reboot the camera to reset its
  // livestream endpoint. The reconciler re-establishes the timeshift once the camera comes back online, so there is nothing to resubscribe here. The reboot is
  // naturally rate-limited: each successful re-establish resets the pool's attempt counter to zero, so a flapping camera cannot reboot in a tight loop.
  private selfHeal(error: unknown): void {

    if(!(error instanceof ProtectLivestreamUnavailableError) || (error.attempts < LIVE_SELF_HEAL_THRESHOLD)) {

      return;
    }

    if(!this.protectCamera.hasFeature("Device.SelfHealing") || !this.protectCamera.isReachable || (this.protectCamera.nvr.phase === "shuttingDown")) {

      return;
    }

    this.log.warn("Rebooting the camera to recover its livestream after %s failed reconnection attempts.", error.attempts.toString());

    this.protectCamera.reboot().catch((rebootError: unknown) => this.log.error("The camera could not be rebooted during livestream self-healing.",
      { error: rebootError }));
  }

  // Reset transmit-session state after the backing subscription has ended. Called from both stop() (explicit teardown) and the consumeSegments finally
  // (out-of-band iterator termination). Having a single anchor for "subscription is done" state mutations is the reason we cannot forget to emit `terminated`
  // on some code paths but not others...every route that ends a transmit-active subscription flows through here.
  //
  // When `_isTransmitting` was true at entry, we emit `terminated` so the consumer (recording delegate) can end its event immediately rather than waiting for
  // downstream stall timeouts (FFmpeg's internal timeout is 6-8 seconds). When not transmitting, no consumer cares and the emit would be noise.
  private finalizeSubscription(): void {

    const wasTransmitting = this._isTransmitting;

    this._isTransmitting = false;
    this._pendingDiscontinuity = false;
    this.subscription = undefined;
    this.clearBuffer();

    if(wasTransmitting) {

      this.emit("terminated");
    }
  }

  // Process a single segment delivered by the iterator. Buffers the media, tracks keyframe boundaries for discontinuity recovery and snapshot extraction, and
  // forwards to the recording delegate when transmitting. The v5 pool delivers a typed Segment: an init segment (read separately through the cached
  // subscription.initSegment getter, so we skip it here) followed by media segments.
  private processSegment(segment: Segment): void {

    // The init segment is consumed via the cached initSegment getter, not buffered as media. Skip it.
    if(segment.type === "init") {

      return;
    }

    // The first media segment after a genuine reconnect carries discontinuity:true. The resumed stream has discontinuous timestamps that corrupt FFmpeg's decoder
    // reference state, so while transmitting we drop the pre-reconnect buffer and arm the discontinuity signal to suppress forwarding until a clean keyframe
    // arrives. The discontinuity-marked segment is NOT guaranteed to be a keyframe (v5 stamps it on the first media after a reconnect without a keyframe check), so
    // the keyframe gate below is LOAD-BEARING: it defers the discontinuity emit until a clean keyframe arrives, reproducing pre-v5's suppress-until-keyframe
    // behavior. Do NOT remove the gate.
    if(segment.discontinuity && this._isTransmitting) {

      this._pendingDiscontinuity = true;
      this.clearBuffer();
    }

    // Add the livestream segment to the end of the timeshift buffer and track whether it's a keyframe. We parse the fMP4 TRUN sample flags to detect sync samples
    // rather than relying on timing heuristics, giving us a definitive answer on every segment. The fragment and its keyframe flag are pushed as one struct, so the
    // two can never drift out of lockstep.
    const isKeyframeSegment = isKeyframe(segment.data);

    this._segments.push({ data: segment.data, isKeyframe: isKeyframeSegment });

    // Trim the beginning of the buffer to our configured size. A single shift removes the fragment and its keyframe flag together.
    if(this._segments.length > this.segmentCount) {

      this._segments.shift();
    }

    // Track when we last saw a keyframe for staleness detection in snapshot extraction.
    if(isKeyframeSegment) {

      this._lastKeyframeTime = Date.now();

      // If we were waiting for a keyframe after a discontinuity, the buffer now has a clean starting point. Signal the recording delegate to restart FFmpeg.
      if(this._pendingDiscontinuity) {

        this._pendingDiscontinuity = false;
        this.emit("discontinuity");
      }
    }

    // If we're transmitting and not suppressing due to a pending discontinuity, forward the segment to the recording delegate for FFmpeg consumption.
    if(this._isTransmitting && !this._pendingDiscontinuity) {

      this.emit("segment", segment.data);
    }
  }

  // Stop timeshifting the livestream. Dispose the subscription (the subscription's internal disposal handles its own listeners, decrements the reference count
  // on the shared session, and tears down the underlying connection if we were the last subscriber) then route through finalizeSubscription to reset state and
  // fire the terminated emit if a transmit session was active.
  public stop(): boolean {

    if(this.subscription) {

      void this.subscription[Symbol.asyncDispose]();
    }

    this.finalizeSubscription();

    return true;
  }

  // Clear the timeshift buffer and associated keyframe tracking state.
  private clearBuffer(): void {

    this._segments = [];
    this._lastKeyframeTime = 0;
  }

  // Start transmitting our timeshift buffer. When startIndex is provided, we emit only the buffer slice from that index forward rather than the entire buffer. This
  // enables keyframe-aligned emission...we send FFmpeg data starting from a known keyframe boundary for clean decoder initialization.
  public transmitStart(startIndex?: number): boolean {

    // Precondition: the timeshift buffer must already be started and have received its initialization segment before transmission can begin. The HKSV recording
    // delegate reconciles via configureTimeshifting before invoking transmitStart, so reaching this method without the timeshift running indicates a contract
    // violation or a livestream that failed to establish. Surfacing this as an error preserves the single-entry invariant the reconciler relies on.
    if(!this.subscription?.initSegment) {

      this.log.error("HKSV event recording unavailable: the livestream connection is not ready. This can occur when the Protect controller or camera is " +
        "rebooting, and usually resolves on its own.");

      return false;
    }

    // Transmit the timeshift buffer, starting from the keyframe-aligned index if provided, or the entire buffer otherwise. We map the segment structs to their
    // fragments for the concat; this is the transmit cadence, not a per-segment hot path, so the allocation is immaterial.
    const slicedSegments = ((startIndex !== undefined) && (startIndex > 0) && (startIndex < this._segments.length)) ? this._segments.slice(startIndex) :
      this._segments;

    this.emit("segment", Buffer.concat([ this.subscription.initSegment.data, ...slicedSegments.map((s) => s.data) ]));

    // Mark ourselves transmitting FIRST, then re-decide any in-flight recovery. The urgency closure we declared at subscribe reads `_isTransmitting` live, so the
    // flag must be set before reassess() so the pool reads the active tolerance (zero) when it re-evaluates. reassess() escalates a recovery currently easing off
    // an idle stall to reconnect immediately now that a latency-sensitive recording has started; it is a no-op when the subscription is not recovering. This
    // restores pre-v5's synchronous deferred-stall escalation - without it the escalation would lag up to one ease-off re-poll.
    this._isTransmitting = true;
    this.subscription.reassess();

    return true;
  }

  // Stop transmitting our timeshift buffer.
  public transmitStop(): boolean {

    // We're done transmitting, flag it, and allow our buffer to resume maintaining itself. The urgency closure now reads the idle tolerance on the next recovery
    // re-decision, so subsequent stalls can ease off again; there is no explicit elevation handle to release.
    this._isTransmitting = false;
    this._pendingDiscontinuity = false;

    return true;
  }

  // Return the last duration milliseconds of the buffer, with an initialization segment.
  public getLast(duration: number): Nullable<Buffer> {

    // No duration, return nothing.
    if(!duration) {

      return null;
    }

    // Translate the requested duration into an integer segment count. Math.ceil ensures we cover at least `duration` milliseconds...a non-multiple request
    // rounds up rather than under-delivering.
    const segmentsRequested = Math.ceil(duration / this._segmentLength);

    // If the request covers more than we have, just hand back the whole buffer.
    if(segmentsRequested >= this._segments.length) {

      return this.buffer;
    }

    // If we don't have our fMP4 initialization segment, we're done. Otherwise, return the duration requested, starting from the end.
    return (this.subscription?.initSegment && this._segments.length) ?
      Buffer.concat([ this.subscription.initSegment.data, ...this._segments.slice(-segmentsRequested).map((s) => s.data) ]) : null;
  }

  // Return the most recent keyframe segment with its initialization segment, for efficient snapshot extraction. This produces a minimal buffer (init segment + one
  // fMP4 fragment) instead of the multi-second buffer from getLast(). Returns null if no keyframe has been detected yet or if the last keyframe is stale (older than
  // 2x the IDR interval), indicating the livestream may have stalled.
  public getLastKeyframe(): Nullable<Buffer> {

    if(!this._lastKeyframeTime || !this.subscription?.initSegment) {

      return null;
    }

    // If the last keyframe is older than 2x the IDR interval, the livestream is likely stalled and we should let the caller fall through to other snapshot sources.
    if((Date.now() - this._lastKeyframeTime) > (PROTECT_LIVESTREAM_API_IDR_INTERVAL * 2 * 1000)) {

      return null;
    }

    // Walk backwards through the buffer to find the most recent keyframe segment. Each entry binds its fragment to its keyframe flag in one struct, so a keyframe
    // entry always carries its matching fragment; the local read satisfies noUncheckedIndexedAccess without a non-null assertion and degrades safely to null when
    // the index is out of range.
    for(let i = this._segments.length - 1; i >= 0; i--) {

      const seg = this._segments[i];

      if(seg?.isKeyframe) {

        return Buffer.concat([ this.subscription.initSegment.data, seg.data ]);
      }
    }

    return null;
  }

  // Find the nearest keyframe at or before the prebuffer start point in the timeshift buffer. This enables keyframe-aligned emission to FFmpeg...instead of sending
  // the entire buffer and relying solely on -ss to seek past excess data, we identify the optimal starting point where FFmpeg's decoder can initialize from a clean
  // keyframe. Returns the buffer index to start from and the seek offset (time from the keyframe to the prebuffer start point) for FFmpeg's -ss parameter, or null
  // if no keyframe is found in the buffer.
  public getKeyframeAlignedStart(prebufferMs: number): Nullable<KeyframeAlignedStart> {

    // Calculate where the prebuffer window begins in the buffer. Everything from this index to the end of the buffer is the prebuffer that HKSV expects. We clamp to
    // zero to handle the case where the buffer is shorter than the requested prebuffer duration.
    const prebufferStartIndex = Math.max(this._segments.length - Math.ceil(prebufferMs / this._segmentLength), 0);

    // Walk backwards from the prebuffer start to find the nearest keyframe. Starting from a keyframe gives FFmpeg a clean decoder state from the very first frame.
    for(let i = prebufferStartIndex; i >= 0; i--) {

      if(this._segments[i]?.isKeyframe) {

        return { seekOffsetMs: (prebufferStartIndex - i) * this._segmentLength, startIndex: i };
      }
    }

    // No keyframe found before the prebuffer start point...the caller should fall back to the current behavior of emitting the full buffer.
    return null;
  }

  // Return the current timeshift buffer, in full.
  public get buffer(): Nullable<Buffer> {

    // If we don't have our fMP4 initialization segment, we're done. Otherwise, return the current timeshift buffer in full.
    return (this.subscription?.initSegment && this._segments.length) ?
      Buffer.concat([ this.subscription.initSegment.data, ...this._segments.map((s) => s.data) ]) : null;
  }

  // Return whether the underlying livestream connection is currently restarting itself.
  public get isRestarting(): boolean {

    return this.subscription?.state === "recovering";
  }

  // Return whether the timeshift buffer has been started. The subscription's lifetime is the timeshift buffer's lifetime, so we derive from
  // `subscription !== undefined`.
  public get isStarted(): boolean {

    return this.subscription !== undefined;
  }

  // Return whether we are transmitting our timeshift buffer or not.
  public get isTransmitting(): boolean {

    return this._isTransmitting;
  }

  // Retrieve how much time is currently in the timeshift buffer, in milliseconds.
  public get time(): number {

    return this._segments.length * this._segmentLength;
  }

  // Retrieve the configured duration of the timeshift buffer, in milliseconds.
  public get configuredDuration(): number {

    return (this.segmentCount * this._segmentLength);
  }

  // Set the configured duration of the timeshift buffer, in milliseconds.
  public set configuredDuration(bufferMillis: number) {

    // Calculate how many segments we need to keep in order to have the appropriate number of seconds in our buffer. Math.ceil keeps segmentCount integer even
    // when bufferMillis is not a multiple of segment length, so the comparison against _segments.length stays unambiguous. At a minimum we always want to maintain
    // a single segment in our buffer.
    this.segmentCount = Math.max(Math.ceil(bufferMillis / this._segmentLength), 1);
  }

  // Return the recording length, in milliseconds, of an individual segment.
  public get segmentLength(): number {

    return this._segmentLength;
  }
}
