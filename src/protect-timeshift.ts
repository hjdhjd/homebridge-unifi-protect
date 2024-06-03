/* Copyright(C) 2017-2024, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-timeshift.ts: UniFi Protect livestream timeshift buffer implementation to support HomeKit Secure Video.
 */
import { HomebridgePluginLogging, retry, sleep } from "homebridge-plugin-utils";
import { EventEmitter } from "node:events";
import { PROTECT_HKSV_SEGMENT_RESOLUTION } from "./settings.js";
import { PlatformAccessory } from "homebridge";
import { ProtectCamera } from "./devices/index.js";
import { ProtectLivestream } from "unifi-protect";
import { ProtectNvr } from "./protect-nvr.js";

// UniFi Protect livestream timeshift buffer.
export class ProtectTimeshiftBuffer extends EventEmitter {

  private readonly accessory: PlatformAccessory;
  private _buffer: Buffer[];
  private bufferSize: number;
  private channelId: number;
  private lens: number | undefined;
  private readonly livestream: ProtectLivestream;
  private readonly log: HomebridgePluginLogging;
  private readonly nvr: ProtectNvr;
  private readonly protectCamera: ProtectCamera;
  private _isLivestreaming: boolean;
  private _isStarted: boolean;
  private _isTransmitting: boolean;
  private _segmentLength: number;

  constructor(protectCamera: ProtectCamera) {

    // Initialize the event emitter.
    super();

    this._buffer = [];
    this._isLivestreaming = false;
    this._isStarted = false;
    this._isTransmitting = false;
    this.accessory = protectCamera.accessory;
    this.bufferSize = 1;
    this.channelId = 0;
    this.lens = undefined;
    this.livestream = protectCamera.nvr.ufpApi.createLivestream();
    this.log = protectCamera.log;
    this.nvr = protectCamera.nvr;
    this.protectCamera = protectCamera;

    // We use a small value for segment resolution in our timeshift buffer to ensure we provide an optimal timeshifting experience. It's a very small amount of additional
    // overhead for modern CPUs, but the result is a much better HKSV event recording experience.
    this._segmentLength = PROTECT_HKSV_SEGMENT_RESOLUTION;

    this.configureTimeshiftBuffer();
  }

  // Configure the timeshift buffer.
  private configureTimeshiftBuffer(): void {

    // If the livestream API has closed, stop what we're doing.
    this.livestream.on("close", () => {

      this.log.error("The livestream API connection was unexpectedly closed by the Protect controller: " +
        "this is typically due to device restarts or issues with Protect controller firmware versions, and can be safely ignored. Will retry again shortly.");
      this.stop();
    });

    // First, we need to listen for any segments sent by the UniFi Protect livestream in order to create our timeshift buffer.
    this.livestream.on("segment", (segment: Buffer) => {

      // If we're livestreaming, notify our listeners.
      if(this._isLivestreaming) {

        this.emit("livestream", segment);
      }

      // Add the livestream segment to the end of the timeshift buffer.
      this._buffer.push(segment);

      // At a minimum we always want to maintain a single segment in our buffer.
      if(this.bufferSize <= 0) {

        this.bufferSize = 1;
      }

      // Trim the beginning of the buffer to our configured size unless we are transmitting to HomeKit, in which case, we queue up all the segments for consumption.
      if(!this.isTransmitting && (this._buffer.length >  this.bufferSize)) {

        this._buffer.shift();
      }

      // If we're transmitting, we want to send all the segments we can so FFmpeg can consume it.
      if(this.isTransmitting) {

        this.transmit();
      }
    });
  }

  // Start the livestream and begin maintaining our timeshift buffer.
  public async start(channelId = this.channelId, lens = this.lens): Promise<boolean> {

    // If we're using a secondary lens, the channel must always be 0.
    if(lens !== undefined) {

      channelId = 0;
    }

    // Stop the timeshift buffer if it's already running.
    this.stop();

    // Ensure we have sane values configured for the segment resolution. We check this here instead of in the constructor because we may not have an HKSV recording
    // configuration available to us immediately upon startup.
    if(this.protectCamera.stream.hksv?.recordingConfiguration?.mediaContainerConfiguration.fragmentLength) {

      if((this.segmentLength < 100) || (this.segmentLength > 1500) ||
        (this.segmentLength > (this.protectCamera.stream.hksv?.recordingConfiguration?.mediaContainerConfiguration.fragmentLength / 2))) {

        this._segmentLength = PROTECT_HKSV_SEGMENT_RESOLUTION;
      }
    }

    // Clear out the timeshift buffer, if it's been previously filled, and then fire up the timeshift buffer.
    this._buffer = [];

    // Start the livestream and start buffering. We set this to reattempt establishing the livestream up to three times before giving up due to occasional controller
    // glitches.
    if(!(await retry(() => this.livestream.start(this.protectCamera.ufp.id, channelId, lens, this.segmentLength) , 1000, 3))) {

      // Something went wrong in communicating with the controller.
      return false;
    }

    this.channelId = channelId;
    this.lens = lens;
    this._isStarted = true;

    return true;
  }

  // Stop timeshifting the livestream.
  public stop(): boolean {

    this.livestream.stop();
    this._buffer = [];
    this._isStarted = false;

    return true;
  }

  // Start transmitting our timeshift buffer.
  public async livestreamStart(): Promise<boolean> {

    // If we haven't started the livestream, or it was closed for some reason, let's start it now.
    if(!this.isStarted && !(await this.start())) {

      this.log.error("Unable to access the Protect livestream API: this is typically due to the Protect controller or camera rebooting.");

      await this.nvr.resetNvrConnection();

      return false;
    }

    // Add the initialization segment to the beginning of the timeshift buffer, if we have it. If we don't, FFmpeg will still be able to generate a valid fMP4 stream,
    // albeit a slightly less elegantly.
    const initSegment = await this.getInitSegment();

    if(!initSegment) {

      this.log.error("Unable to begin the livestream: unable to retrieve initialization data from the UniFi Protect controller. " +
        "This error is typically due to either an issue connecting to the Protect controller, or a problem on the Protect controller.");

      await this.nvr.resetNvrConnection();

      return false;
    }

    // Livestream everything we have queued up to get started as quickly as possible.
    this.emit("livestream", this.buffer ?? initSegment);

    // Let our livestream listener know that we're now transmitting.
    this._isLivestreaming = true;

    return true;
  }

  // Stop transmitting our timeshift buffer.
  public livestreamStop(): boolean {

    // We're done livestreaming, flag it accordingly.
    this._isLivestreaming = false;

    return true;
  }

  // Start transmitting our timeshift buffer.
  public async transmitStart(): Promise<boolean> {

    // If we haven't started the livestream, or it was closed for some reason, let's start it now.
    if(!this.isStarted && !(await this.start())) {

      this.log.error("Unable to access the Protect livestream API: this is typically due to the Protect controller or camera rebooting. Will retry again.");

      await this.nvr.resetNvrConnection();

      return false;
    }

    // Add the initialization segment to the beginning of the timeshift buffer, if we have it. If we don't, FFmpeg will still be able to generate a valid fMP4 stream,
    // albeit a slightly less elegantly.
    const initSegment = await this.getInitSegment();

    if(initSegment) {

      this._buffer.unshift(initSegment);
    } else {

      this.log.error("Unable to begin transmitting the stream to HomeKit Secure Video: unable to retrieve initialization data from the UniFi Protect controller. " +
        "This error is typically due to either an issue connecting to the Protect controller, or a problem on the Protect controller.");

      await this.nvr.resetNvrConnection();

      return false;
    }

    // Transmit everything we have queued up to get started as quickly as possible.
    this.transmit();

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

  // Transmit the contents of our timeshift buffer.
  private transmit(): void {

    this.emit("segment", Buffer.concat(this._buffer));
    this._buffer = [];
  }

  private isIFrame(segment: Buffer): boolean {

    // This function should parse the fMP4 segment and determine if it contains an I-frame.
    // For simplicity, this example assumes the segment starts with an I-frame and checks the first NAL unit.

    const NAL_UNIT_TYPE_I_FRAME_H264 = 5;  // For H.264, IDR frames have NAL unit type 5
    const NAL_UNIT_TYPE_I_FRAME_H265 = 19; // For H.265, IDR frames have NAL unit type 19

    const index = segment.findIndex((byte, i) => (i <= (segment.length - 4)) && [0x00, 0x00, 0x00, 0x01].every((prefixByte, j) => segment[i + j] === prefixByte));

    if(index === -1) {

      return false;
    }

    // H.264 NAL unit type is in the first byte after the start code
    return [NAL_UNIT_TYPE_I_FRAME_H264, NAL_UNIT_TYPE_I_FRAME_H264].includes(segment[index + 4] & 0x1F);
  }

  // Check if this is the fMP4 initialization segment.
  public isInitSegment(segment: Buffer): boolean {

    if(this.livestream.initSegment?.equals(segment)) {

      return true;
    }

    return false;
  }

  // Get the fMP4 initialization segment from the livestream API.
  public async getInitSegment(): Promise<Buffer | null> {

    // If we have the initialization segment, return it.
    if(this.livestream.initSegment) {

      return this.livestream.initSegment;
    }

    // We haven't seen it yet, wait for a couple of seconds and check an additional time.
    await sleep(2000);

    // We either have it or we don't - we can't afford to wait too long for this - HKSV is time-sensitive and we need to ensure we have a reasonable upper bound on how
    // long we wait for data from the Protect API.
    return this.livestream.initSegment;
  }

  // Return the current timeshift buffer, in full.
  public get buffer(): Buffer | null {

    // If we don't have our fMP4 initialization segment, we're done. Otherwise, return the current timeshift buffer in full.
    return (this.livestream.initSegment && this._buffer.length) ? Buffer.concat([ this.livestream.initSegment, ...this._buffer ]) : null;
  }

  // Return whether or not we have started the timeshift buffer.
  public get isStarted(): boolean {

    return this._isStarted;
  }

  // Return whether we are transmitting our timeshift buffer or not.
  public get isTransmitting(): boolean {

    return this._isTransmitting;
  }

  // Retrieve the current size of the timeshift buffer, in milliseconds.
  public get length(): number {

    return (this.bufferSize * this.segmentLength);
  }

  // Set the size of the timeshift buffer, in milliseconds.
  public set length(bufferMillis: number) {

    // Calculate how many segments we need to keep in order to have the appropriate number of seconds in our buffer.
    this.bufferSize = bufferMillis / this.segmentLength;
  }

  // Return the recording length, in milliseconds, of an individual segment.
  public get segmentLength(): number {

    return this._segmentLength;
  }
}
