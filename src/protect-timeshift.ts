/* Copyright(C) 2017-2022, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-timeshift.ts: UniFi Protect livestream timeshift buffer implementation to support HomeKit Secure Video.
 */
import { Logging, PlatformAccessory } from "homebridge";
import { ProtectCameraConfig, ProtectLivestream } from "unifi-protect";
import { EventEmitter } from "events";
import { PROTECT_HKSV_SEGMENT_RESOLUTION } from "./settings";
import { ProtectCamera } from "./protect-camera";
import { ProtectNvr } from "./protect-nvr";

// UniFi Protect livestream timeshift buffer.
export class ProtectTimeshiftBuffer extends EventEmitter {

  private accessory: PlatformAccessory;
  private buffer: Buffer[];
  private bufferSize: number;
  private livestream: ProtectLivestream;
  private readonly log: Logging;
  private readonly name: () => string;
  private readonly nvr: ProtectNvr;
  private protectCamera: ProtectCamera;
  private _segmentLength: number;
  private _isTransmitting: boolean;

  constructor(protectCamera: ProtectCamera) {

    // Initialize the event emitter.
    super();

    this.accessory = protectCamera.accessory;
    this.buffer = [];
    this.bufferSize = 1;
    this.livestream = new ProtectLivestream(protectCamera.nvr.nvrApi, protectCamera.platform.log);
    this.log = protectCamera.platform.log;
    this.name = protectCamera.name.bind(protectCamera);
    this.nvr = protectCamera.nvr;
    this.protectCamera = protectCamera;

    // We use 100ms in segment resolution for our timeshift buffer to ensure we provide an optimal
    // timeshifting experience. It's a very small amount of additional overhead for most modern CPUs,
    // but the result is a much better HKSV event recording. We may eventually allow for a larger segment
    // resolution in order to give devices at the lower end of the performance curve some added cushion,
    // albeit at the expense of a suboptimal user experience when reviewing HKSV recorded events.
    this._segmentLength = PROTECT_HKSV_SEGMENT_RESOLUTION;

    this._isTransmitting = false;
    this.configureTimeshiftBuffer();
  }

  // Configure the timeshift buffer.
  private configureTimeshiftBuffer(): void {

    let seenFtyp = false;
    let seenMoov = false;

    // First, we need to listen for any segments sent by the UniFi Protect livestream in order
    // to create our timeshift buffer.
    this.livestream.on("message", (segment: Buffer) => {

      // Crucially, we don't want to keep any FTYP or MOOV atoms in our timeshift buffer. The
      // reason for this is that these atoms are special in the MP4 world and must be transmitted
      // at the beginning of any new MP4 stream. So what do we do? The livestream saves these atoms
      // for us, so all we need to do is ensure we don't include them in our timeshift buffer. There
      // should only ever be a single FTYP or MOOV atom, so once we've seen one, we don't need to
      // worry about it again.
      if(!seenFtyp && this.livestream.ftyp?.equals(segment)) {

        seenFtyp = true;
        return;
      }

      if(!seenMoov && this.livestream.moov?.equals(segment)) {

        seenMoov = true;
        return;
      }

      // Add the livestream segment to the end of the timeshift buffer.
      this.buffer.push(segment);

      // At a minimum we always want to maintain a single segment buffer.
      if(this.bufferSize <= 0) {

        this.bufferSize = 1;
      }

      // Trim the beginning of the buffer to our configured size unless we are transmitting
      // to HomeKit, in which case, we queue up all the segments for consumption.
      if(!this.isTransmitting && (this.buffer.length >  this.bufferSize)) {

        this.buffer.splice(0, this.buffer.length - this.bufferSize);
      }

      // If we're transmitting, we want to send all the segments we can so FFmpeg can consume it.
      if(this.isTransmitting) {

        for(let nextOne = this.buffer.shift(); nextOne; nextOne = this.buffer.shift()) {

          this.emit("segment", nextOne);
        }
      }
    });
  }

  // Start the livestream and begin creating our timeshift buffer.
  public async start(channelId: number): Promise<boolean> {

    // Ensure we have sane values configured for the segment resolution.
    if(this.protectCamera.stream.hksv?.recordingConfiguration?.mediaContainerConfiguration.fragmentLength) {

      if((this.segmentLength < 100) ||
        (this.segmentLength > (this.protectCamera.stream.hksv?.recordingConfiguration?.mediaContainerConfiguration.fragmentLength / 2))) {

        this._segmentLength = this.protectCamera.stream.hksv?.recordingConfiguration?.mediaContainerConfiguration.fragmentLength / 2;

        this.log.error("%s: An invalid HomeKit Secure Video segment length was configured. " +
          "Choosing a safe value instead, though one that provides a less than ideal event clip viewing experience: %s.", this.name(), this.segmentLength);
      }
    }

    // Clear out the timeshift buffer, if it's been previously filled, and then fire up the timeshift buffer.
    this.buffer = [];

    // Start the livestream and start buffering.
    if(!(await this.livestream.start((this.accessory.context.device as ProtectCameraConfig).id, channelId, this.segmentLength))) {

      return false;
    }

    return true;
  }

  // Stop timeshifting the livestream.
  public stop(): boolean {

    this.livestream.stop();
    this.buffer = [];

    return true;
  }

  // Start or stop transmitting our timeshift buffer.
  public transmitStream(transmitState: boolean): void {

    // If we're done transmitting, flag it, and allow our buffer to resume maintaining itself.
    if(!transmitState) {

      this._isTransmitting = false;
      return;
    }

    // Add the FTYP and MOOV atoms to the beginning of the timeshift buffer, if we have them.
    // If we don't, FFmpeg will still be able to generate a valid fMP4 stream, albeit a slightly
    // less elegantly.
    if(this.livestream.ftyp && this.livestream.moov) {

      this.buffer.unshift(this.livestream.ftyp, this.livestream.moov);
    } else {

      this.log.debug("%s: Warning: no MP4 stream headers found. This error can be largely ignored - FFmpeg will compensate.",
        this.name());
    }

    // Signal our livestream listener that it's time to start transmitting our queued segments and timeshift.
    this._isTransmitting = true;
  }

  // Return the fMP4 stream header for an HKSV session.
  public async getStreamHeader(): Promise<Buffer | null> {

    // Keep looping until we see both, but don't loop for more than two seconds, as a failsafe.
    for(let i = 0; i < 20; i++) {

      // We have what we're looking for. We're done.
      if(this.livestream.ftyp && this.livestream.moov) {

        break;
      }

      // Let's try again shortly.
      // eslint-disable-next-line no-await-in-loop
      await this.nvr.sleep(100);
    }

    // We still don't have the boxes that make up the stream header. Time to give up.
    if(!this.livestream.ftyp || !this.livestream.moov) {

      return null;
    }

    // Return the header.
    return Buffer.concat([ this.livestream.ftyp, this.livestream.moov ]);
  }

  // Check if a segment is the FTYP box.
  public isFtyp(segment: Buffer): boolean {

    if(this.livestream.ftyp?.equals(segment)) {

      return true;
    }

    return false;
  }

  // Check if a segment is the MOOV box.
  public isMoov(segment: Buffer): boolean {

    if(this.livestream.moov?.equals(segment)) {

      return true;
    }

    return false;
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

    // Calculate how many segments we need to keep in order to have the appropriate number of seconds in
    // our buffer.
    this.bufferSize = bufferMillis / this.segmentLength;
  }

  // Return the recording length, in milliseconds, of an individual segment.
  public get segmentLength(): number {

    return this._segmentLength;
  }
}
