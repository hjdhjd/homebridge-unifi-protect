/* Copyright(C) 2017-2025, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-timeshift.ts: UniFi Protect livestream timeshift buffer implementation to support HomeKit Secure Video.
 */
import { type FfmpegLivestreamProcess, type HomebridgePluginLogging, type Nullable, runWithTimeout } from "homebridge-plugin-utils";
import { EventEmitter } from "node:events";
import { PROTECT_HKSV_SEGMENT_RESOLUTION } from "./settings.js";
import type { PlatformAccessory } from "homebridge";
import type { ProtectCamera } from "./devices/index.js";
import type { ProtectLivestream } from "unifi-protect";
import type { ProtectNvr } from "./protect-nvr.js";
import type { RtspEntry } from "./devices/protect-camera.js";

// UniFi Protect livestream timeshift buffer.
export class ProtectTimeshiftBuffer extends EventEmitter {

  private _buffer: Buffer[];
  private _isStarted: boolean;
  private _isTransmitting: boolean;
  private _segmentLength: number;
  private readonly accessory: PlatformAccessory;
  private eventHandlers: { [index: string]: ((segment: Buffer) => void) | (() => void) };
  private livestream?: FfmpegLivestreamProcess | ProtectLivestream;
  private readonly log: HomebridgePluginLogging;
  private readonly nvr: ProtectNvr;
  private readonly protectCamera: ProtectCamera;
  private rtspEntry?: RtspEntry;
  private segmentCount: number;

  constructor(protectCamera: ProtectCamera) {

    // Initialize the event emitter.
    super();

    this._buffer = [];
    this._isStarted = false;
    this._isTransmitting = false;
    this.accessory = protectCamera.accessory;
    this.eventHandlers = {};
    this.log = protectCamera.log;
    this.nvr = protectCamera.nvr;
    this.protectCamera = protectCamera;
    this.segmentCount = 1;

    // We use a small value for segment resolution in our timeshift buffer to ensure we provide an optimal timeshifting experience. It's a very small amount of additional
    // overhead for modern CPUs, but the result is a much better HKSV event recording experience.
    this._segmentLength = PROTECT_HKSV_SEGMENT_RESOLUTION;

    // Now let's configure the timeshift buffer.
    this.configureTimeshiftBuffer();
  }

  // Configure the timeshift buffer.
  private configureTimeshiftBuffer(): void {

    // If the API connection has closed, let the user know.
    this.eventHandlers.close = (): void => {

      if(this.isRestarting) {

        return;
      }

      this.log.error("%s connection closed by the controller. Retrying shortly.", this.protectCamera.hasFeature("Debug.Video.HKSV.UseRtsp") ? "RTSP" : "Livestream API");
    };

    // Listen for any segments sent by the UniFi Protect livestream in order to create our timeshift buffer.
    this.eventHandlers.segment = (segment: Buffer): void => {

      // If we're transmitting, send the segment as quickly as we can so FFmpeg can consume it.
      if(this.isTransmitting) {

        this.emit("segment", segment);
      }

      // Add the livestream segment to the end of the timeshift buffer.
      this._buffer.push(segment);

      // Trim the beginning of the buffer to our configured size.
      if(this._buffer.length >  this.segmentCount) {

        this._buffer.shift();
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
    if(this.protectCamera.stream.hksv?.recordingConfiguration?.mediaContainerConfiguration.fragmentLength) {

      if((this._segmentLength < 100) || (this._segmentLength > 1500) ||
        (this._segmentLength > (this.protectCamera.stream.hksv?.recordingConfiguration?.mediaContainerConfiguration.fragmentLength / 2))) {

        this._segmentLength = PROTECT_HKSV_SEGMENT_RESOLUTION;
      }
    }

    // Clear out the timeshift buffer, if it's been previously filled, and then fire up the timeshift buffer.
    this._buffer = [];

    // Acquire our livestream.
    this.livestream = this.protectCamera.livestream.acquire(rtspEntry);

    // Something went wrong.
    if(!this.livestream) {

      return false;
    }

    // Setup our listeners.
    this.livestream?.on("close", this.eventHandlers.close);
    this.livestream?.on("segment", this.eventHandlers.segment);

    // Start the livestream and let's begin building our timeshift buffer.
    if(!(await this.protectCamera.livestream.start(rtspEntry, this._segmentLength))) {

      // Something went wrong, let's cleanup our event handlers and we're done.
      Object.keys(this.eventHandlers).map(eventName => this.livestream?.off(eventName, this.eventHandlers[eventName]));

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

      Object.keys(this.eventHandlers).map(eventName => this.livestream?.off(eventName, this.eventHandlers[eventName]));
    }

    this._buffer = [];
    this._isStarted = false;
    this.livestream = undefined;
    this.rtspEntry = undefined;

    return true;
  }

  // Restart the timeshift buffer and underlying livestream.
  public restart(): void {

    this.livestream?.emit("restart");
    this._buffer = [];
  }

  // Start transmitting our timeshift buffer.
  public async transmitStart(): Promise<boolean> {

    // If we haven't started the livestream, or it was closed for some reason, let's start it now.
    if((!this.isStarted && this.rtspEntry && !(await this.start(this.rtspEntry))) || !this.livestream?.initSegment) {

      this.log.error("Unable to connect to the Protect livestream API — usually occurs when the Protect controller or devices reboot. Retrying shortly.");

      return false;
    }

    // Transmit everything we have queued up to get started as quickly as possible.
    this.emit("segment", Buffer.concat([this.livestream.initSegment, ...this._buffer]));

    // Let our livestream listener know that we're now transmitting.
    this._isTransmitting = true;

    return true;
  }

  // Stop transmitting our timeshift buffer.
  public transmitStop(): boolean {

    // We're done transmitting, flag it, and allow our buffer to resume maintaining itself.
    this._isTransmitting = false;

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

    // If we have the initialization segment, return it.
    if(this.livestream?.initSegment) {

      return this.livestream.initSegment;
    }

    // We haven't seen it yet, wait for a couple of seconds and check an additional time.
    if(this.livestream) {

      return runWithTimeout(this.livestream.getInitSegment(), 2000);
    }

    return null;
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
    return (this.livestream?.initSegment && this._buffer.length) ? Buffer.concat([this.livestream.initSegment, ...this._buffer.slice(start * -1)]) : null;
  }

  // Return the current timeshift buffer, in full.
  public get buffer(): Nullable<Buffer> {

    // If we don't have our fMP4 initialization segment, we're done. Otherwise, return the current timeshift buffer in full.
    return (this.livestream?.initSegment && this._buffer.length) ? Buffer.concat([ this.livestream.initSegment, ...this._buffer ]) : null;
  }

  // Return whether the underlying livestream connection is currently restarting itself.
  public get isRestarting(): boolean {

    return this.rtspEntry ? this.protectCamera.livestream?.isRestarting(this.rtspEntry) : false;
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
