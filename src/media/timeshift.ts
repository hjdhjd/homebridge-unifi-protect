/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * timeshift.ts: UniFi Protect livestream timeshift buffer implementation - a standing, rolling fMP4 window over a camera's livestream.
 */
import type { Clock, HomebridgePluginLogging, Nullable } from "homebridge-plugin-utils";
import { PROTECT_LIVESTREAM_ACTIVE_TOLERANCE_MS, PROTECT_LIVESTREAM_API_IDR_INTERVAL, PROTECT_LIVESTREAM_IDLE_TOLERANCE_MS, PROTECT_SEGMENT_RESOLUTION }
  from "../settings.ts";
import type { ChannelProfile } from "./resolution.ts";
import { EventEmitter } from "node:events";
import { LIVE_SELF_HEAL_THRESHOLD } from "./livestream-recovery-policy.ts";
import type { LivestreamSubscription } from "./livestream.ts";
import type { ProtectCameraHost } from "./camera-host.ts";
import { ProtectLivestreamUnavailableError } from "unifi-protect";
import type { Segment } from "unifi-protect";
import { isKeyframe } from "homebridge-plugin-utils";
import { logLivestreamIterationError } from "./livestream.ts";

// Why the standing buffer stopped, carried by the `stopped` event. "ended" is a recoverable end - a deliberate stop, a codec-change restart, or an unexpected iterator
// death - that the supervisor re-establishes from immediately; "giveUp" is the recovery policy's exhaustion, which the supervisor leaves to the availability edge and
// self-heal rather than re-arming into a tight loop.
export type TimeshiftStopCause = "ended" | "giveUp";

// Typed event map for the timeshift buffer. The recording delegate listens for the transmit-session events; the supervisor listens for `stopped`.
//
// - `segment`: the next fMP4 fragment is ready for a transmitting consumer.
// - `discontinuity`: the underlying livestream dropped and recovered while transmitting; the buffer now has a clean keyframe, and the consumer should restart
//   its decoder with fresh data. Non-terminal - the subscription is still alive and will continue delivering segments.
// - `stopped`: the backing subscription has ended for any reason - a deliberate stop, an out-of-band iterator death, or the recovery give-up - carrying the cause so
//   the supervisor decides whether to re-establish immediately or leave the revival to the availability edge. Emitted unconditionally on every teardown, whether or
//   not a consumer was transmitting.
// - `terminated`: the backing subscription has ended while the consumer was transmitting - either via iterator-level termination (the recovery give-up, a codec
//   change, an unexpected error) or via an explicit stop() (controller disconnect, reconciler teardown). The buffer is empty and `isStarted` is now false.
//   Terminal for the current transmit session: the consumer should end its event cleanly rather than wait for downstream stall timeouts.
interface TimeshiftBufferEvents {

  discontinuity: [];
  segment: [Buffer];
  stopped: [cause: TimeshiftStopCause];
  terminated: [];
}

// Return shape of getKeyframeAlignedStart. Names the coordinates a caller needs to feed keyframe-aligned data into FFmpeg: the buffer index to begin
// reading from (starts on a keyframe), and the sub-segment seek offset to hand to FFmpeg's -ss parameter for fine alignment within that keyframe's window.
interface KeyframeAlignedStart {

  seekOffsetMs: number;
  startIndex: number;
}

// A single buffered timeshift entry. The fMP4 fragment and its keyframe classification are bound together in one struct so the segment and its keyframe flag are
// stored, trimmed, and cleared as an indivisible unit. This makes a desync between a fragment and its keyframe flag structurally unrepresentable rather than an
// invariant a caller must uphold by convention.
interface TimeshiftSegment {

  data: Buffer;
  isKeyframe: boolean;
}

// The freshness-aware snapshot source answer. The snapshot path reads this single three-state value instead of composing getLast/getLastKeyframe of its own: "fresh"
// carries the minimal keyframe buffer (init segment + the most recent keyframe fragment) and the capture fps the snapshot pipeline needs; "stale" declines because a
// keyframe was seen but is older than the staleness threshold, so the livestream has stalled and a served image would be frozen; "empty" declines because no fresh
// keyframe is buffered yet, WITHOUT claiming staleness (a fresh buffer with no keyframe, and a stalled buffer with an old keyframe, must not be conflated).
export type SnapshotSource = { data: Buffer; fps: number; kind: "fresh" } | { kind: "empty" } | { kind: "stale" };

// UniFi Protect livestream timeshift buffer.
export class ProtectTimeshiftBuffer extends EventEmitter<TimeshiftBufferEvents> {

  // The channel profile backing the running livestream. Committed in start() in the same synchronous frame the subscription commits and cleared in
  // finalizeSubscription() on every teardown path, so it forms a matched pair with `isStarted`: external readers never observe a profile the buffer is not
  // actually running on, whether the buffer stopped deliberately or died out-of-band.
  private _channelProfile: Nullable<ChannelProfile>;
  private _isTransmitting: boolean;
  private _lastKeyframeTime: number;
  private _pendingDiscontinuity: boolean;
  // The cause the next `stopped` emit will carry. Defaults to "ended" (the recoverable case) and is raised to "giveUp" only when the iterator throws the recovery
  // policy's exhaustion error. Reset to "ended" at every start() head and after every emit, so a latched "giveUp" from an establishment-phase give-up (which never
  // reaches finalizeSubscription because the local subscription was never committed) can never mislabel the next out-of-band death.
  private _pendingStopCause: TimeshiftStopCause;
  private _segments: TimeshiftSegment[];
  // Segment resolution for the timeshift buffer. Fixed at PROTECT_SEGMENT_RESOLUTION (100ms) because a small value gives HKSV a better event recording experience
  // at a trivial CPU cost on modern systems.
  private readonly _segmentLength: number = PROTECT_SEGMENT_RESOLUTION;
  // The injected wall-clock seam (production systemClock, a controllable TestClock under test). The timeshift reads it for keyframe-staleness timing - the
  // _lastKeyframeTime write on each keyframe and the now-versus-then staleness compare in snapshotSource - so that path is test-deterministic without a real-time
  // wait. This mirrors the recording delegate's clock field-copy exactly (record.ts), reaching the clock through the platform handle the camera already carries.
  private readonly clock: Clock;
  private readonly log: HomebridgePluginLogging;
  private readonly protectCamera: ProtectCameraHost;
  private segmentCount: number;
  // The active livestream subscription. Its presence is the single source of truth for whether the timeshift buffer is running; the public `isStarted` getter
  // derives from `subscription !== undefined`.
  private subscription?: LivestreamSubscription;

  constructor(protectCamera: ProtectCameraHost) {

    // Initialize the event emitter.
    super();

    this._channelProfile = null;
    this._isTransmitting = false;
    this._lastKeyframeTime = 0;
    this._pendingDiscontinuity = false;
    this._pendingStopCause = "ended";
    this._segments = [];
    this.clock = protectCamera.platform.clock;
    this.log = protectCamera.log;
    this.protectCamera = protectCamera;
    this.segmentCount = 1;
  }

  // Start the livestream and begin maintaining our timeshift buffer.
  public async start(channelProfile: ChannelProfile): Promise<boolean> {

    // Reset the pending stop cause at the head of every start. An establishment-phase give-up (whenEstablished false) disposes a local subscription that was never
    // committed, so it never reaches finalizeSubscription to emit and clear the cause; without this reset a latched "giveUp" would mislabel the next out-of-band death
    // and wrongly suppress its re-establish.
    this._pendingStopCause = "ended";

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
    // We declare a recovery urgency closure the unifi-protect library's pool reads live when it derives its recovery-await window: zero while transmitting
    // (latency-sensitive, so an in-flight recording reconnects immediately rather than easing off a stressed controller) and the idle tolerance otherwise
    // (latency-tolerant, so an idle prebuffer eases off a stressed-but-reachable controller). The closure moves only the recovery tolerance; the library's media-stall
    // detection floors at max(urgency, 2000ms) regardless, so the prebuffer stays watched at the 2-second floor either way. A genuine reconnect surfaces inline as a
    // discontinuity-marked segment (handled in processSegment), so there is no separate disconnect handler to attach.
    const subscription = this.protectCamera.livestream(channelProfile, { discardOnDispose: true, segmentLength: this._segmentLength,
      urgency: () => this._isTransmitting ? PROTECT_LIVESTREAM_ACTIVE_TOLERANCE_MS : PROTECT_LIVESTREAM_IDLE_TOLERANCE_MS });

    // Drive the segment iterator in the background. The for-await loop runs until the subscription is disposed (graceful return), terminated with a typed error
    // (ProtectLivestreamUnavailableError if the recovery policy gave up, ProtectCodecChangeError if the stream format changed, or another unexpected failure), or
    // otherwise rejects. Errors are classified and logged and the loop exits cleanly...stop() is the single release point that disposes the subscription.
    void this.consumeSegments(subscription);

    // Wait for the session to establish. The unifi-protect library's whenEstablished is MEDIA-keyed: it resolves true once the first media segment has been delivered
    // (not merely on init), false if the session terminated during provisioning.
    if(!(await subscription.whenEstablished())) {

      void subscription[Symbol.asyncDispose]();

      return false;
    }

    // The unifi-protect library delivers the init segment before the first media segment, so by the time the media-keyed whenEstablished resolves true, the init
    // segment is already populated. A null init here violates the library contract and is treated as a hard failure. Dispose the local subscription directly; the
    // instance field only ever receives a subscription that has passed every validation, so `isStarted` never flips true during the validation window.
    if(!subscription.initSegment) {

      void subscription[Symbol.asyncDispose]();

      return false;
    }

    // Every check has passed. Commit the subscription as the backing state; isStarted flips from false to true atomically with this assignment, and the channel
    // profile commits in the same synchronous frame, so the (isStarted, channelProfile) pair is never observable out of sync. The failed-start paths above never
    // assign the profile, so external readers never see an entry whose start did not succeed.
    this.subscription = subscription;
    this._channelProfile = channelProfile;

    return true;
  }

  // Consume segments from the subscription's async iterator. Runs in the background for the lifetime of the subscription. Each segment is processed (buffered,
  // keyframe-tracked, optionally forwarded to the recording delegate). Termination is signaled by iterator return (graceful disposal) or a typed error thrown
  // into the iterator. Error classification is centralised in logLivestreamIterationError so every livestream consumer uses identical phrasing and suppression
  // rules.
  //
  // The finally block is the self-cleaning anchor for out-of-band iterator termination (the recovery give-up, a codec change, unexpected errors). The id-based
  // identity guard discriminates the teardown paths with a single compare, and is resilient to future indirection (proxies, wrappers) because subscription ids
  // are stable strings rather than object references:
  //
  //   - stop() called externally: stop() cleared `this.subscription` before the iterator observed the queue close, so the id compare against undefined fails
  //     and we no-op (stop() already fired the terminated emit if applicable).
  //   - start() validation failed: the local subscription was disposed before `this.subscription` was committed to it, so the ids don't match and we no-op.
  //   - terminal typed error (e.g., ProtectLivestreamUnavailableError): the subscription was committed and is now disposed without our teardown running, so the ids
  //     match and we reset backing state to match reality via finalizeSubscription.
  //   - session-level termination (controller manager shutdown): the subscription's iterator closes from outside, the ids match, and we self-clean.
  //
  // This keeps `isStarted` honest...no observable window where the getter reports true against a dead subscription.
  private async consumeSegments(subscription: LivestreamSubscription): Promise<void> {

    try {

      for await (const segment of subscription) {

        // Identity guard in the loop body, mirroring the finally's guard. A segment can still drain from THIS subscription's queue after it has been replaced: the pool
        // delivers already-queued segments before honoring disposal, so a restart (dispose old, commit new) can hand this loop a stale segment from the old subscription.
        // Admitting it would contaminate the freshly-committed buffer with the old subscription's timeline, so we skip it. We continue rather than break - this loop's
        // lifetime belongs to its own subscription's terminal, and breaking here would abandon draining it to that terminal cleanly.
        if(this.subscription?.id !== subscription.id) {

          continue;
        }

        this.processSegment(segment);
      }
    } catch(error) {

      // Classify the cause the finalize below will emit: the recovery policy's exhaustion is a "giveUp" the supervisor must not re-arm into a tight loop, while any
      // other iterator death (a codec change, an unexpected error) is a recoverable "ended" the supervisor re-establishes from immediately.
      this._pendingStopCause = (error instanceof ProtectLivestreamUnavailableError) ? "giveUp" : "ended";

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

  // Reboot a wedged camera to recover its livestream, the consumer half of the recovery policy's self-heal. The recovery policy gives up - and
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
  // on some code paths but not others...every route that ends a transmit-active subscription flows through here. The channel profile clears here too, before the
  // `terminated` emit, so every listener already observes the cleared (isStarted false, channelProfile null) matched pair when the emit fires.
  //
  // When `_isTransmitting` was true at entry, we emit `terminated` so the consumer (recording delegate) can end its event immediately rather than waiting for
  // downstream stall timeouts (FFmpeg's internal timeout is 6-8 seconds). When not transmitting, no consumer cares and the emit would be noise.
  private finalizeSubscription(): void {

    const wasTransmitting = this._isTransmitting;
    const cause = this._pendingStopCause;

    this._channelProfile = null;
    this._isTransmitting = false;
    this._pendingDiscontinuity = false;
    this.subscription = undefined;
    this.clearBuffer();

    if(wasTransmitting) {

      this.emit("terminated");
    }

    // The supervisor listens for this on every teardown, transmitting or not, so it can decide whether to re-establish immediately ("ended") or leave the revival to
    // the availability edge ("giveUp"). Reset the pending cause afterward so the next teardown defaults to the recoverable case unless the iterator raises it again.
    this.emit("stopped", cause);
    this._pendingStopCause = "ended";
  }

  // Process a single segment delivered by the iterator. Buffers the media, tracks keyframe boundaries for discontinuity recovery and snapshot extraction, and
  // forwards to the recording delegate when transmitting. The unifi-protect library's pool delivers a typed Segment: an init segment (read separately through the
  // cached subscription.initSegment getter, so we skip it here) followed by media segments.
  private processSegment(segment: Segment): void {

    // The init segment is consumed via the cached initSegment getter, not buffered as media. Skip it.
    if(segment.type === "init") {

      return;
    }

    // Buffer hygiene runs on EVERY reconnect, transmitting or not. The first media segment after a genuine reconnect carries discontinuity:true, and its timeline is
    // discontinuous from the pre-reconnect buffer - retaining the old segments would leave the standing buffer mixed-timeline for live views, HKSV, and snapshots alike,
    // not only while an HKSV session happens to be transmitting. We drop the stale-timeline segments and arm _pendingDiscontinuity so the buffer resumes admitting only
    // once a clean recovery keyframe arrives. Clearing while idle is the intended trade: a fresh HKSV landing right after the clear gets a short, clean prebuffer rather
    // than a corrupt mixed-timeline one.
    if(segment.discontinuity) {

      this._pendingDiscontinuity = true;
      this.clearBuffer();
    }

    // Parse the fMP4 TRUN sample flags to classify this fragment as a keyframe (sync sample) rather than relying on timing heuristics, giving a definitive answer on
    // every segment.
    const isKeyframeSegment = isKeyframe(segment.data);

    // Track when we last saw a keyframe for staleness detection, and disarm the discontinuity suppression on the recovery keyframe. This disarm runs BEFORE the
    // admission-suppression check below, so the recovery keyframe itself both ends suppression AND is admitted; gating admission before the disarm would skip the very
    // keyframe the buffer is waiting to resume on. The discontinuity-marked segment is NOT guaranteed to be a keyframe (the unifi-protect library stamps it on the first
    // media after a reconnect without a keyframe check), so this keyframe gate is required, not incidental - it is what defers the resume until a clean keyframe arrives.
    if(isKeyframeSegment) {

      this._lastKeyframeTime = this.clock.now();

      if(this._pendingDiscontinuity) {

        this._pendingDiscontinuity = false;

        // Consumer notification stays transmit-gated: only an active HKSV transmitter needs to restart its decoder on the clean keyframe. An idle reconnect cleans the
        // buffer without notifying anyone.
        if(this._isTransmitting) {

          this.emit("discontinuity");
        }
      }
    }

    // Admission suppression: while _pendingDiscontinuity is still armed, this is a pre-keyframe mid-GOP fragment from the resumed stream. Admitting it would put
    // discontinuous-timeline data back into the just-cleared buffer, so we drop it and wait. The recovery keyframe disarmed above, so it falls through and is admitted.
    if(this._pendingDiscontinuity) {

      return;
    }

    // Admit the segment: append it with its keyframe flag as one struct (so the fragment and its flag never drift), then trim the front to the configured window. A
    // single shift removes a fragment and its keyframe flag together.
    this._segments.push({ data: segment.data, isKeyframe: isKeyframeSegment });

    if(this._segments.length > this.segmentCount) {

      this._segments.shift();
    }

    // Forward the admitted segment to a transmitting consumer (the recording delegate) for FFmpeg consumption. Suppression is already handled above: reaching here means
    // _pendingDiscontinuity is false.
    if(this._isTransmitting) {

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
    // provides synchronous deferred-stall escalation - without it the escalation would lag up to one ease-off re-poll.
    this._isTransmitting = true;
    this.subscription.reassess();

    return true;
  }

  // Stop transmitting our timeshift buffer.
  public transmitStop(): boolean {

    // We're done transmitting, flag it, and allow our buffer to resume maintaining itself. The urgency closure now reads the idle tolerance on the next recovery
    // re-decision, so subsequent stalls can ease off again; there is no explicit elevation handle to release.
    //
    // We deliberately do NOT clear _pendingDiscontinuity here. It now governs buffer admission independent of transmit state, so an HKSV session closing mid-reconnect
    // must not end the suppression - the buffer stays suppressed until the recovery keyframe arrives, keeping the standing buffer timeline-clean for the next consumer.
    // _pendingDiscontinuity is cleared only by that recovery keyframe (in processSegment) or by a full teardown (finalizeSubscription).
    this._isTransmitting = false;

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

  // The freshness-aware snapshot source: the single owner of the "is the buffer fresh enough to snapshot from?" decision. Returns fresh content (the minimal init +
  // most-recent-keyframe buffer and the capture fps), a stale decline (a keyframe was seen but is older than 2x the IDR interval, so the livestream has likely stalled
  // and a served image would be frozen), or an empty decline (no fresh keyframe buffered yet, no staleness to claim). This folds the retired getLastKeyframe's staleness
  // compare and keyframe walk, so the snapshot path composes no fallback of its own and never serves the staleness-blind getLast window.
  public snapshotSource(): SnapshotSource {

    // No init segment, or no keyframe seen yet: nothing to give and no staleness to claim.
    if(!this.subscription?.initSegment || !this._lastKeyframeTime) {

      return { kind: "empty" };
    }

    // A keyframe was seen but is older than 2x the IDR interval: the livestream has likely stalled, so decline rather than serve a frozen image.
    if((this.clock.now() - this._lastKeyframeTime) > (PROTECT_LIVESTREAM_API_IDR_INTERVAL * 2 * 1000)) {

      return { kind: "stale" };
    }

    // Walk backwards to the most recent keyframe fragment and hand back the minimal init + keyframe buffer plus the capture fps. Each entry binds its fragment to its
    // keyframe flag in one struct, so a keyframe entry always carries its matching fragment; the local read satisfies noUncheckedIndexedAccess and degrades to the empty
    // answer when no keyframe fragment remains (the only keyframe was trimmed out of the window even though the staleness clock still reads fresh).
    for(let i = this._segments.length - 1; i >= 0; i--) {

      const seg = this._segments[i];

      if(seg?.isKeyframe) {

        return { data: Buffer.concat([ this.subscription.initSegment.data, seg.data ]), fps: this._channelProfile?.channel.fps ?? 30, kind: "fresh" };
      }
    }

    return { kind: "empty" };
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

  // Return the channel profile the running livestream is backed by, or null when the buffer is not running. Kept as a matched pair with `isStarted` on every start
  // and teardown path, so a non-null read always describes the entry actually behind the buffer.
  public get channelProfile(): Nullable<ChannelProfile> {

    return this._channelProfile;
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
