/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-timeshift.ts: UniFi Protect livestream timeshift buffer implementation to support HomeKit Secure Video.
 */
import type { FfmpegLivestreamProcess, HomebridgePluginLogging, Nullable } from "homebridge-plugin-utils";
import { PROTECT_LIVESTREAM_API_IDR_INTERVAL, PROTECT_SEGMENT_RESOLUTION } from "./settings.js";
import { isKeyframe, runWithTimeout } from "homebridge-plugin-utils";
import { EventEmitter } from "node:events";
import type { ProtectCamera } from "./devices/index.js";
import type { ProtectLivestream } from "unifi-protect";
import type { RtspEntry } from "./devices/protect-camera.js";

// UniFi Protect livestream timeshift buffer.
export class ProtectTimeshiftBuffer extends EventEmitter {

  private _buffer: Buffer[];
  private _isStarted: boolean;
  private _isTransmitting: boolean;
  private _keyframes: boolean[];
  private _lastKeyframeTime: number;
  private _pendingDiscontinuity: boolean;
  private _segmentLength: number;
  private eventHandlers: Record<string, ((segment: Buffer) => void) | (() => void)>;
  private livestream?: FfmpegLivestreamProcess | ProtectLivestream;
  private readonly log: HomebridgePluginLogging;
  private readonly protectCamera: ProtectCamera;
  private rtspEntry?: RtspEntry;
  private segmentCount: number;

  constructor(protectCamera: ProtectCamera) {

    // Initialize the event emitter.
    super();

    this._buffer = [];
    this._isStarted = false;
    this._isTransmitting = false;
    this._keyframes = [];
    this._lastKeyframeTime = 0;
    this._pendingDiscontinuity = false;
    this.eventHandlers = {};
    this.log = protectCamera.log;
    this.protectCamera = protectCamera;
    this.segmentCount = 1;

    // We use a small value for segment resolution in our timeshift buffer to ensure we provide an optimal timeshifting experience. It's a very small amount of additional
    // overhead for modern CPUs, but the result is a much better HKSV event recording experience.
    this._segmentLength = PROTECT_SEGMENT_RESOLUTION;

    // Now let's configure the timeshift buffer.
    this.configureTimeshiftBuffer();
  }

  // Configure the timeshift buffer.
  private configureTimeshiftBuffer(): void {

    // When the livestream connection closes during an active recording, the resumed stream will have discontinuous timestamps that corrupt FFmpeg's decoder reference
    // state. We flag the discontinuity so the segment handler can suppress forwarding until a clean keyframe arrives, giving the recording delegate a chance to restart
    // FFmpeg with valid data.
    this.eventHandlers.close = (): void => {

      if(this._isTransmitting) {

        this._pendingDiscontinuity = true;
        this.clearBuffer();
      }

      if(!this.isRestarting) {

        this.log.error("%s connection closed by the controller. Retrying shortly.",
          this.protectCamera.hasFeature("Debug.Video.HKSV.UseRtsp") ? "RTSP" : "Livestream API");
      }
    };

    // Listen for any segments sent by the UniFi Protect livestream in order to create our timeshift buffer.
    this.eventHandlers.segment = (segment: Buffer): void => {

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
    };
  }

  // Start the livestream and begin maintaining our timeshift buffer.
  public async start(rtspEntry: RtspEntry): Promise<boolean> {

    // Stop the timeshift buffer if it's already running.
    if(this.isStarted) {

      this.stop();
    }

    // Ensure we have sane values configured for the segment resolution. We check this here instead of in the constructor because we may not have an HKSV recording
    // configuration available to us immediately upon startup.
    if(this.protectCamera.stream?.hksv?.recordingConfiguration?.mediaContainerConfiguration.fragmentLength) {

      if((this._segmentLength < 100) || (this._segmentLength > 1500) ||
        (this._segmentLength > (this.protectCamera.stream.hksv.recordingConfiguration.mediaContainerConfiguration.fragmentLength / 2))) {

        this._segmentLength = PROTECT_SEGMENT_RESOLUTION;
      }
    }

    // Clear out the timeshift buffer, if it's been previously filled, and then fire up the timeshift buffer.
    this.clearBuffer();

    // Acquire our livestream.
    this.livestream = this.protectCamera.livestream.acquire(rtspEntry);

    // Setup our listeners.
    this.livestream.on("close", this.eventHandlers.close);
    this.livestream.on("segment", this.eventHandlers.segment);

    // Start the livestream and let's begin building our timeshift buffer.
    if(!(await this.protectCamera.livestream.start(rtspEntry, this._segmentLength))) {

      // Something went wrong, let's cleanup our event handlers and we're done.
      for(const eventName of Object.keys(this.eventHandlers)) {

        this.livestream.off(eventName, this.eventHandlers[eventName]);
      }

      return false;
    }

    this.rtspEntry = rtspEntry;
    this._isStarted = true;

    // Add the initialization segment to the beginning of the timeshift buffer, if we have it. If we don't, we're either starting up or something's wrong with the API.
    const initSegment = await this.getInitSegment();

    if(!initSegment) {

      this.stop();

      return false;
    }

    return true;
  }

  // Stop timeshifting the livestream.
  public stop(): boolean {

    if(this.isStarted) {

      // Stop the livestream and remove the listeners.
      if(this.rtspEntry) {

        this.protectCamera.livestream.stop(this.rtspEntry);
      }

      for(const eventName of Object.keys(this.eventHandlers)) {

        this.livestream?.off(eventName, this.eventHandlers[eventName]);
      }
    }

    this.clearBuffer();
    this._isStarted = false;
    this._pendingDiscontinuity = false;
    this.livestream = undefined;
    this.rtspEntry = undefined;

    return true;
  }

  // Restart the timeshift buffer and underlying livestream. This is called by the recording delegate when FFmpeg times out, not during discontinuity recovery...we
  // clear the discontinuity flag to prevent a spurious "discontinuity" event from firing after the recording has already ended.
  public restart(): void {

    this._pendingDiscontinuity = false;
    this.livestream?.emit("restart");
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
  public async transmitStart(startIndex?: number): Promise<boolean> {

    // If we haven't started the livestream, or it was closed for some reason, let's start it now.
    if((!this.isStarted && this.rtspEntry && !(await this.start(this.rtspEntry))) || !this.livestream?.initSegment) {

      this.log.error("Unable to connect to the Protect livestream API — usually occurs when the Protect controller or devices reboot. Retrying shortly.");

      return false;
    }

    // Transmit the timeshift buffer, starting from the keyframe-aligned index if provided, or the entire buffer otherwise.
    const slicedBuffer = ((startIndex !== undefined) && (startIndex > 0) && (startIndex < this._buffer.length)) ? this._buffer.slice(startIndex) : this._buffer;

    this.emit("segment", Buffer.concat([ this.livestream.initSegment, ...slicedBuffer ]));

    // Let our livestream listener know that we're now transmitting.
    this._isTransmitting = true;

    return true;
  }

  // Stop transmitting our timeshift buffer.
  public transmitStop(): boolean {

    // We're done transmitting, flag it, and allow our buffer to resume maintaining itself.
    this._isTransmitting = false;
    this._pendingDiscontinuity = false;

    return true;
  }

  // Check if this is the fMP4 initialization segment.
  public isInitSegment(segment: Buffer): boolean {

    if(this.livestream?.initSegment?.equals(segment)) {

      return true;
    }

    return false;
  }

  // Get the fMP4 initialization segment from the livestream API.
  public async getInitSegment(): Promise<Nullable<Buffer>> {

    // No livestream - we're done.
    if(!this.livestream) {

      return null;
    }

    // If we have the initialization segment, return it. If we haven't seen it yet, wait for a couple of seconds and check an additional time.
    return this.livestream.initSegment ?? await runWithTimeout(this.livestream.getInitSegment(), 2000);
  }

  // Return the last duration milliseconds of the buffer, with an initialization segment.
  public getLast(duration: number): Nullable<Buffer> {

    // No duration, return nothing.
    if(!duration) {

      return null;
    }

    // Figure out where in the timeshift buffer we want to slice.
    const start = (duration / this._segmentLength);

    // We're really trying to get the whole buffer, so let's do that.
    if(start >= this._buffer.length) {

      return this.buffer;
    }

    // If we don't have our fMP4 initialization segment, we're done. Otherwise, return the duration requested, starting from the end.
    return (this.livestream?.initSegment && this._buffer.length) ? Buffer.concat([ this.livestream.initSegment, ...this._buffer.slice(start * -1) ]) : null;
  }

  // Return the most recent keyframe segment with its initialization segment, for efficient snapshot extraction. This produces a minimal buffer (init segment + one
  // fMP4 fragment) instead of the multi-second buffer from getLast(). Returns null if no keyframe has been detected yet or if the last keyframe is stale (older than
  // 2x the IDR interval), indicating the livestream may have stalled.
  public getLastKeyframe(): Nullable<Buffer> {

    if(!this._lastKeyframeTime || !this.livestream?.initSegment) {

      return null;
    }

    // If the last keyframe is older than 2x the IDR interval, the livestream is likely stalled and we should let the caller fall through to other snapshot sources.
    if((Date.now() - this._lastKeyframeTime) > (PROTECT_LIVESTREAM_API_IDR_INTERVAL * 2 * 1000)) {

      return null;
    }

    // Walk backwards through the keyframe tracking array to find the most recent keyframe segment in the buffer.
    for(let i = this._keyframes.length - 1; i >= 0; i--) {

      if(this._keyframes[i]) {

        return Buffer.concat([ this.livestream.initSegment, this._buffer[i] ]);
      }
    }

    return null;
  }

  // Find the nearest keyframe at or before the prebuffer start point in the timeshift buffer. This enables keyframe-aligned emission to FFmpeg...instead of sending
  // the entire buffer and relying solely on -ss to seek past excess data, we identify the optimal starting point where FFmpeg's decoder can initialize from a clean
  // keyframe. Returns the buffer index to start from and the seek offset (time from the keyframe to the prebuffer start point) for FFmpeg's -ss parameter, or null
  // if no keyframe is found in the buffer.
  public getKeyframeAlignedStart(prebufferMs: number): { seekOffsetMs: number; startIndex: number } | null {

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
    return (this.livestream?.initSegment && this._buffer.length) ? Buffer.concat([ this.livestream.initSegment, ...this._buffer ]) : null;
  }

  // Return whether the underlying livestream connection is currently restarting itself.
  public get isRestarting(): boolean {

    return this.rtspEntry ? this.protectCamera.livestream.isRestarting(this.rtspEntry) : false;
  }

  // Return whether or not we have started the timeshift buffer.
  public get isStarted(): boolean {

    return this._isStarted;
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

    // Calculate how many segments we need to keep in order to have the appropriate number of seconds in our buffer. At a minimum we always want to maintain a single
    // segment in our buffer.
    this.segmentCount = Math.max(bufferMillis / this._segmentLength, 1);
  }

  // Return the recording length, in milliseconds, of an individual segment.
  public get segmentLength(): number {

    return this._segmentLength;
  }
}
