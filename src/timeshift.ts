/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-timeshift.ts: UniFi Protect livestream timeshift buffer implementation to support HomeKit Secure Video.
 */
import { type HomebridgePluginLogging, type Nullable, isKeyframe } from "homebridge-plugin-utils";
import { type LivestreamSubscription, logLivestreamIterationError } from "./protect-livestream.ts";
import { PROTECT_LIVESTREAM_API_IDR_INTERVAL, PROTECT_SEGMENT_RESOLUTION } from "./settings.ts";
import { EventEmitter } from "node:events";
import type { ProtectCamera } from "./devices/index.ts";
import type { RtspEntry } from "./devices/camera.ts";

// Typed event map for the timeshift buffer. Consumers (recording delegate) listen for these.
//
// - `segment`: the next fMP4 fragment is ready for a transmitting consumer.
// - `discontinuity`: the underlying livestream dropped and recovered while transmitting; the buffer now has a clean keyframe, and the consumer should restart
//   its decoder with fresh data. Non-terminal - the subscription is still alive and will continue delivering segments.
// - `terminated`: the backing subscription has ended while the consumer was transmitting - either via iterator-level termination (SubscriberLagError,
//   unexpected error) or via an explicit stop() (NVR disconnect, reconciler teardown). The buffer is empty and `isStarted` is now false. Terminal for the
//   current transmit session: the consumer should end its event cleanly rather than wait for downstream stall timeouts.
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

// UniFi Protect livestream timeshift buffer.
export class ProtectTimeshiftBuffer extends EventEmitter<TimeshiftBufferEvents> {

  private _buffer: Buffer[];
  private _isTransmitting: boolean;
  private _keyframes: boolean[];
  private _lastKeyframeTime: number;
  private _pendingDiscontinuity: boolean;
  // Segment resolution for the timeshift buffer. Fixed at PROTECT_SEGMENT_RESOLUTION (100ms) because a small value gives HKSV a better event recording experience
  // at a trivial CPU cost on modern systems.
  private readonly _segmentLength: number = PROTECT_SEGMENT_RESOLUTION;
  // Outstanding subscription criticality elevation handle for the active transmission. Held while `_isTransmitting` is true; disposed in transmitStop and
  // finalizeSubscription to release the elevation. Stored as a field rather than a local because transmitStart and transmitStop are called from different code
  // paths in the recording delegate, so a `using` scope spanning the transmission isn't structurally available.
  private criticalityHandle?: Disposable;
  private readonly log: HomebridgePluginLogging;
  private readonly protectCamera: ProtectCamera;
  private segmentCount: number;
  // The active livestream subscription. Its presence is the single source of truth for whether the timeshift buffer is running; the public `isStarted` getter
  // derives from `subscription !== undefined`.
  private subscription?: LivestreamSubscription;

  constructor(protectCamera: ProtectCamera) {

    // Initialize the event emitter.
    super();

    this._buffer = [];
    this._isTransmitting = false;
    this._keyframes = [];
    this._lastKeyframeTime = 0;
    this._pendingDiscontinuity = false;
    this.log = protectCamera.log;
    this.protectCamera = protectCamera;
    this.segmentCount = 1;
  }

  // Start the livestream and begin maintaining our timeshift buffer.
  public async start(rtspEntry: RtspEntry): Promise<boolean> {

    // Stop the timeshift buffer if it's already running.
    if(this.isStarted) {

      this.stop();
    }

    // Clear out the timeshift buffer, if it's been previously filled, and then fire up the timeshift buffer.
    this.clearBuffer();

    // Create the pooled livestream subscription. This call is synchronous: it returns the subscription handle immediately and begins establishing the underlying
    // connection in the background. We attach our disconnect handler and start consuming segments below within the same synchronous frame, which guarantees they
    // are in place before any asynchronous event can fire on the subscription.
    const subscription = this.protectCamera.livestream.subscribe(rtspEntry, this._segmentLength);

    // Handle disconnect notifications from the underlying livestream. When the connection drops during an active recording, the resumed stream will have
    // discontinuous timestamps that corrupt FFmpeg's decoder reference state. We flag the discontinuity so the segment handler can suppress forwarding until a
    // clean keyframe arrives, giving the recording delegate a chance to restart FFmpeg with valid data. We log only on controller-initiated closes...internal
    // stall recoveries are already announced by the manager's recovery log, so a second log here would be noise.
    subscription.onDisconnect((info): void => {

      if(this._isTransmitting) {

        this._pendingDiscontinuity = true;
        this.clearBuffer();
      }

      if(info.external) {

        this.log.error("%s connection closed by the controller. Retrying shortly.",
          this.protectCamera.hasFeature("Debug.Video.HKSV.UseRtsp") ? "RTSP" : "Livestream API");
      }
    });

    // Drive the segment iterator in the background. The for-await loop runs until the subscription is disposed (graceful return), terminated with a typed error
    // (SessionEstablishmentError if provisioning never delivered a segment, SubscriberLagError if our queue overflowed), or otherwise rejects. Errors are logged
    // and the loop exits cleanly...stop() is the single release point that disposes the subscription.
    void this.consumeSegments(subscription);

    // Wait for the session to establish. Resolves true once the first segment has been delivered, false if the session terminated during provisioning.
    if(!(await subscription.whenEstablished())) {

      void subscription[Symbol.asyncDispose]();

      return false;
    }

    // The unifi-protect library delivers the init segment before any regular segment, so by the time whenEstablished resolves true, the init segment is
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
  // The finally block is the self-healing anchor for out-of-band iterator termination (SubscriberLagError, unexpected errors). The id-based identity guard
  // discriminates four teardown paths with a single compare, and is resilient to future indirection (proxies, wrappers) because subscription ids are stable
  // strings rather than object references:
  //
  //   - stop() called externally: stop() cleared `this.subscription` before the iterator observed the queue close, so the id compare against undefined fails
  //     and we no-op (stop() already fired the terminated emit if applicable).
  //   - start() validation failed: the local subscription was disposed before `this.subscription` was committed to it, so the ids don't match and we no-op.
  //   - terminal typed error (e.g., SubscriberLagError): the subscription was committed and is now disposed without our teardown running, so the ids match
  //     and we reset backing state to match reality via finalizeSubscription.
  //   - session-level termination (NVR manager shutdown): the subscription's iterator closes from outside, the ids match, and we self-clean.
  //
  // This keeps `isStarted` honest...no observable window where the getter reports true against a dead subscription.
  private async consumeSegments(subscription: LivestreamSubscription): Promise<void> {

    try {

      for await (const segment of subscription) {

        this.processSegment(segment);
      }
    } catch(error) {

      logLivestreamIterationError(error, this.log, "Timeshift buffer");
    } finally {

      if(this.subscription?.id === subscription.id) {

        this.finalizeSubscription();
      }
    }
  }

  // Reset transmit-session state after the backing subscription has ended. Called from both stop() (explicit teardown) and the consumeSegments finally
  // (out-of-band iterator termination). Having a single anchor for "subscription is done" state mutations is the reason we cannot forget to emit `terminated`
  // on some code paths but not others...every route that ends a transmit-active subscription flows through here.
  //
  // When `_isTransmitting` was true at entry, we emit `terminated` so the consumer (recording delegate) can end its event immediately rather than waiting for
  // downstream stall timeouts (FFmpeg's internal timeout is 6-8 seconds). When not transmitting, no consumer cares and the emit would be noise.
  private finalizeSubscription(): void {

    const wasTransmitting = this._isTransmitting;

    // Release any criticality elevation held for the active transmission. Out-of-band iterator termination (SubscriberLagError, manager shutdown) ends the
    // transmission without transmitStop being called, so this is the cleanup anchor for that path.
    this.criticalityHandle?.[Symbol.dispose]();
    this.criticalityHandle = undefined;

    this._isTransmitting = false;
    this._pendingDiscontinuity = false;
    this.subscription = undefined;
    this.clearBuffer();

    if(wasTransmitting) {

      this.emit("terminated");
    }
  }

  // Process a single segment delivered by the iterator. Buffers it, tracks keyframe boundaries for discontinuity recovery and snapshot extraction, and forwards
  // to the recording delegate when transmitting.
  private processSegment(segment: Buffer): void {

    // Add the livestream segment to the end of the timeshift buffer and track whether it's a keyframe. We parse the fMP4 TRUN sample flags to detect sync samples
    // rather than relying on timing heuristics, giving us a definitive answer on every segment.
    const isKeyframeSegment = isKeyframe(segment);

    this._buffer.push(segment);
    this._keyframes.push(isKeyframeSegment);

    // Trim the beginning of the buffer to our configured size.
    if(this._buffer.length > this.segmentCount) {

      this._buffer.shift();
      this._keyframes.shift();
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

      this.emit("segment", segment);
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

  // Request a fresh livestream connection after an FFmpeg timeout. subscription.requestRestart() drives the manager's recovery cycle: the onDisconnect callback
  // runs synchronously in this call stack, and the underlying drop-and-reconnect happens asynchronously afterward. clearBuffer() is idempotent with the
  // onDisconnect callback's buffer clear when _isTransmitting is true, and handles the non-transmitting case where the callback would otherwise no-op.
  public restart(): void {

    this.subscription?.requestRestart();
    this.clearBuffer();
  }

  // Clear the timeshift buffer and associated keyframe tracking state.
  private clearBuffer(): void {

    this._buffer = [];
    this._keyframes = [];
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

    // Transmit the timeshift buffer, starting from the keyframe-aligned index if provided, or the entire buffer otherwise.
    const slicedBuffer = ((startIndex !== undefined) && (startIndex > 0) && (startIndex < this._buffer.length)) ? this._buffer.slice(startIndex) : this._buffer;

    this.emit("segment", Buffer.concat([ this.subscription.initSegment, ...slicedBuffer ]));

    // Elevate the subscription's criticality for the duration of this transmission. The livestream manager reads `active` criticality across all subscribers when
    // deciding recovery policy on a stall...this is what guarantees that an HKSV recording in flight never gets a deferred reconnect.
    this.criticalityHandle = this.subscription.elevateCriticality();

    // Let our livestream listener know that we're now transmitting.
    this._isTransmitting = true;

    return true;
  }

  // Stop transmitting our timeshift buffer.
  public transmitStop(): boolean {

    // Release the criticality elevation we acquired in transmitStart. Disposing here returns the subscription to `idle` if no other elevation handles are held,
    // which lets the recovery policy resume considering deferred-stall behavior on subsequent stalls.
    this.criticalityHandle?.[Symbol.dispose]();
    this.criticalityHandle = undefined;

    // We're done transmitting, flag it, and allow our buffer to resume maintaining itself.
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
    if(segmentsRequested >= this._buffer.length) {

      return this.buffer;
    }

    // If we don't have our fMP4 initialization segment, we're done. Otherwise, return the duration requested, starting from the end.
    return (this.subscription?.initSegment && this._buffer.length) ?
      Buffer.concat([ this.subscription.initSegment, ...this._buffer.slice(-segmentsRequested) ]) : null;
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

    // Walk backwards through the keyframe tracking array to find the most recent keyframe segment in the buffer.
    for(let i = this._keyframes.length - 1; i >= 0; i--) {

      if(this._keyframes[i]) {

        return Buffer.concat([ this.subscription.initSegment, this._buffer[i] ]);
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
    const prebufferStartIndex = Math.max(this._buffer.length - Math.ceil(prebufferMs / this._segmentLength), 0);

    // Walk backwards from the prebuffer start to find the nearest keyframe. Starting from a keyframe gives FFmpeg a clean decoder state from the very first frame.
    for(let i = prebufferStartIndex; i >= 0; i--) {

      if(this._keyframes[i]) {

        return { seekOffsetMs: (prebufferStartIndex - i) * this._segmentLength, startIndex: i };
      }
    }

    // No keyframe found before the prebuffer start point...the caller should fall back to the current behavior of emitting the full buffer.
    return null;
  }

  // Return the current timeshift buffer, in full.
  public get buffer(): Nullable<Buffer> {

    // If we don't have our fMP4 initialization segment, we're done. Otherwise, return the current timeshift buffer in full.
    return (this.subscription?.initSegment && this._buffer.length) ? Buffer.concat([ this.subscription.initSegment, ...this._buffer ]) : null;
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

    return this._buffer.length * this._segmentLength;
  }

  // Retrieve the configured duration of the timeshift buffer, in milliseconds.
  public get configuredDuration(): number {

    return (this.segmentCount * this._segmentLength);
  }

  // Set the configured duration of the timeshift buffer, in milliseconds.
  public set configuredDuration(bufferMillis: number) {

    // Calculate how many segments we need to keep in order to have the appropriate number of seconds in our buffer. Math.ceil keeps segmentCount integer even
    // when bufferMillis is not a multiple of segment length, so the comparison against _buffer.length stays unambiguous. At a minimum we always want to maintain
    // a single segment in our buffer.
    this.segmentCount = Math.max(Math.ceil(bufferMillis / this._segmentLength), 1);
  }

  // Return the recording length, in milliseconds, of an individual segment.
  public get segmentLength(): number {

    return this._segmentLength;
  }
}
