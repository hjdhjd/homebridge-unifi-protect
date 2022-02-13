/* Copyright(C) 2017-2022, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-record.ts: Homebridge camera recording delegate implementation for UniFi Protect to support HomeKit Secure Video.
 *
 * The author would like to acknowledge and thank Supereg (https://github.com/Supereg) and Sunoo (https://github.com/Sunoo)
 * for being sounding boards as I worked through several ideas and iterations of this work. Their camaraderie and support was
 * deeply appreciated.
 */
import {
  API,
  CameraRecordingConfiguration,
  CameraRecordingDelegate,
  HDSProtocolSpecificErrorReason,
  Logging,
  PlatformAccessory,
  RecordingPacket
} from "homebridge";
import { ProtectCamera, RtspEntry } from "./protect-camera";
import { FfmpegRecordingProcess } from "./protect-ffmpeg";
import { ProtectCameraConfig } from "unifi-protect";
import { ProtectNvr } from "./protect-nvr";
import { ProtectTimeshiftBuffer } from "./protect-timeshift";

// Camera recording delegate implementation for Protect.
export class ProtectRecordingDelegate implements CameraRecordingDelegate {

  private _isRecording: boolean;
  private readonly accessory: PlatformAccessory;
  private readonly api: API;
  private timeshift: ProtectTimeshiftBuffer;
  private debug: (message: string, ...parameters: unknown[]) => void;
  private ffmpegStream: FfmpegRecordingProcess | null;
  private isInitialized: boolean;
  private readonly log: Logging;
  private readonly maxRecordingDuration: number;
  private readonly name: () => string;
  private nvr: ProtectNvr;
  private readonly protectCamera: ProtectCamera;
  private recordingConfig: CameraRecordingConfiguration | undefined;
  private rtspEntry: RtspEntry | null;
  private recordedSegments: number;
  private transmitListener: ((segment: Buffer) => void) | null;

  constructor(protectCamera: ProtectCamera) {

    this.accessory = protectCamera.accessory;
    this.api = protectCamera.api;
    this.timeshift = new ProtectTimeshiftBuffer(protectCamera);
    this.debug = protectCamera.platform.debug.bind(protectCamera.platform);
    this.ffmpegStream = null;
    this.isInitialized = false;
    this._isRecording = false;
    this.log = protectCamera.platform.log;
    this.name = protectCamera.name.bind(protectCamera);
    this.nvr = protectCamera.nvr;
    this.protectCamera = protectCamera;
    this.maxRecordingDuration = parseInt(this.nvr.optionGet(this.accessory.context.device as ProtectCameraConfig, "Video.HKSV.Recording.MaxDuration") ?? "0");
    this.recordedSegments = 0;
    this.rtspEntry = null;
    this.transmitListener = null;
  }

  // Process HomeKit requests to activate or deactivate HKSV recording capabilities for a camera.
  public async updateRecordingActive(active: boolean): Promise<void> {

    // If we are no longer recording, stop the livestream.
    if(!active) {

      this.timeshift.stop();

      // Inform the user of the state change, if needed.
      if(this.isRecording !== active) {

        this.log.info("%s: Disabling HomeKit Secure Video event recording.", this.name());
      }

      this._isRecording = active;
      return;
    }

    // We have no recording configuration available yet. Set our desired state and we're done.
    // Once we have a recording configuration, we'll get called again and be able to begin timeshifting.
    if(!this.recordingConfig) {

      this._isRecording = active;
      return;
    }

    // Figure out which camera channel we should use for the livestream based on the requested resolution.
    this.rtspEntry = this.protectCamera.findRtsp(this.recordingConfig.videoCodec.resolution[0], this.recordingConfig.videoCodec.resolution[1],
      this.accessory.context.device as ProtectCameraConfig);

    if(!this.rtspEntry) {

      this._isRecording = false;
      this.log.error("%s: Unable to start the HomeKit Secure Video timeshift buffer: no valid RTSP stream profile was found.", this.name());
      return;
    }

    // Set the bitrate to what HomeKit is looking for. This is particularly useful when we occasionally have
    // to livestream to a user, where bitrates can be different and even get reconfigured in realtime. By
    // contrast, HomeKit Secure Video has a consistent bitrate it accepts, and we want to try to match it as
    // closely as posible.
    if(!(await this.protectCamera.setBitrate(this.rtspEntry.channel.id, this.recordingConfig.videoCodec.parameters.bitRate * 1000))) {

      this.log.error("%s: Unable to set the bitrate to %skbps for HomeKit Secure Video event recording.",
        this.name(), this.recordingConfig.videoCodec.parameters.bitRate);
      return;
    }

    // Fire up the timeshift buffer.
    if(!(await this.timeshift.start(this.rtspEntry.channel.id))) {

      this.log.error("%s: Unable to start the timeshift buffer for HomeKit Secure Video.", this.name());
      return;
    }

    // Inform the user of the state change, if needed.
    if((this._isRecording !== active) || !this.isInitialized) {

      this.isInitialized = true;

      this.log.info("%s: Enabling HomeKit Secure Video event recording: %sx%s@%sfps, %s kbps with a %s second timeshift buffer.",
        this.name(), this.rtspEntry.resolution[0], this.rtspEntry.resolution[1], this.rtspEntry.resolution[2],
        this.recordingConfig.videoCodec.parameters.bitRate, this.timeshift.length / 1000);

      // Inform the user if there's a maximum event recording duration set.
      if(this.maxRecordingDuration) {

        this.log.info("%s: HomeKit Secure Video recordings will be no longer than ~%s seconds.",
          this.name(), this.maxRecordingDuration);
      }
    }

    // Update our recording state internally.
    this._isRecording = active;
  }

  // Process updated recording configuration settings from HomeKit Secure Video.
  public updateRecordingConfiguration(configuration: CameraRecordingConfiguration | undefined): void {

    // If we're set to an undefined state, it's because HomeKit can't figure out a valid configuration to use.
    // This is typically due to a factory reset of the camera or a similar edge case. We choose to handle it
    // by stopping our timeshift buffer.
    if(!configuration) {

      this.recordingConfig = configuration;
      this.timeshift.stop();
      return;
    }

    // Save the new recording configuration.
    this.recordingConfig = configuration;

    // Tell our timeshift buffer how many seconds HomeKit has requested we prebuffer.
    this.timeshift.length = this.recordingConfig.prebufferLength;

    // Start or restart our timeshift buffer based on our updated configuration.
    void this.updateRecordingActive(this.isRecording);
  }

  // Handle the actual recording stream request.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async *handleRecordingStreamRequest(streamId: number): AsyncGenerator<RecordingPacket> {

    // Start transmitting our timeshift buffer and process it through FFmpeg.
    if(!this.startTransmitting() || !this.ffmpegStream) {

      // Something went wrong, so we gracefully tell HomeKit we have no packets to transmit and return.
      this.stopTransmitting();
      yield { data: Buffer.alloc(0), isLast: true };
      return;
    }

    for await (const segment of this.ffmpegStream.generator()) {

      let isLastSegment = false;

      // If we've stopped transmitting - make sure we don't send anything else.
      if(!this.timeshift.isTransmitting) {

        return;
      }

      // No segment doesn't mean we're done necessarily, but it does mean we need to wait for FFmpeg to catch up.
      if(!segment) {

        continue;
      }

      // If we've exceeded a user-configured maximum recording duration, let HomeKit know we're stopping.
      if(this.maxRecordingDuration && ((this.recordedSegments * this.timeshift.segmentLength) / 1000) > this.maxRecordingDuration) {

        isLastSegment = true;
      }

      yield {

        data: segment,
        isLast: isLastSegment
      };

      if(isLastSegment) {

        return;
      }
    }
  }

  // Receive an acknowledgement from HomeKit that it's seen an end-of-stream packet from us.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public acknowledgeStream(streamId: number): void {

    // Since HomeKit knows our transmission is ending, it's safe to do so now.
    this.stopTransmitting();
  }

  // Process HomeKit requests to end the transmission of the recording stream.
  public closeRecordingStream(streamId: number, reason: HDSProtocolSpecificErrorReason | undefined): void {

    this.stopTransmitting(reason);
  }

  // Start transmitting to the HomeKit hub our timeshifted fMP4 stream.
  private startTransmitting(): boolean {

    // If there's a prior instance of FFmpeg, clean up after ourselves.
    if(this.ffmpegStream) {

      this.ffmpegStream.stop();
      this.ffmpegStream = null;
    }

    // If there's a prior instance of our transmit handler, clean it up.
    if(this.transmitListener) {

      this.timeshift.removeListener("segment", this.transmitListener);
      this.transmitListener = null;
    }

    // If we don't have a recording configuration from HomeKit or an RTSP profile, we can't continue.
    if(!this.recordingConfig || !this.rtspEntry) {

      return false;
    }

    // Start a new FFmpeg instance to transcode using HomeKit's requirements.

    // We want to keep feeding HomeKit until it tells us it's finished, or we decide we don't want to send anymore
    // fMP4 packets. We treat this the same was a DVR works where you can pause live television, but it continues to
    // buffer what's being broadcast until you're ready to watch it. This is the same idea.

    // Keep track of how many fMP4 segments we are feeding FFmpeg.
    this.recordedSegments = 0;


    // Check to see if the user has audio enabled or disabled for recordings.
    const isAudioActive = this.protectCamera.stream.controller.recordingManagement?.recordingManagementService
      .getCharacteristic(this.api.hap.Characteristic.RecordingAudioActive).value === 1 ? true : false;

    this.ffmpegStream = new FfmpegRecordingProcess(this.protectCamera, this.recordingConfig, isAudioActive);

    // Start the livestream.
    const timeshiftedSeconds = this.timeshift.length / 1000;

    // Let the timeshift buffer know it's time to transmit and continue timeshifting.
    this.timeshift.transmitStream(true);

    let seenFtyp = false;
    let seenMoov = false;

    // Listen in for events from the timeshift buffer and feed FFmpeg. This looks simple, conceptually,
    // but there's a lot going on here.
    this.transmitListener = (segment: Buffer): void => {

      this.ffmpegStream?.stdin?.write(segment);

      // We don't want the fMP4 ftyp or moov boxes accounted for in our recording statistics so
      // let's filter them out.
      if(!seenFtyp && this.timeshift.isFtyp(segment)) {

        seenFtyp = true;
        return;
      }

      if(!seenMoov && this.timeshift.isMoov(segment)) {

        seenMoov = true;
        return;
      }

      this.recordedSegments++;
    };

    this.timeshift.on("segment", this.transmitListener);

    // Inform the user.
    this.log.debug("%s: Beginning a HomeKit Secure Video recording event with a timeshift buffer of %s seconds.",
      this.name(), timeshiftedSeconds);

    return true;
  }

  // Stop transmitting the HomeKit hub our timeshifted fMP4 stream.
  private stopTransmitting(reason?: HDSProtocolSpecificErrorReason): void {

    // We're done transmitting, so we can go back to maintaining our timeshift buffer for HomeKit.
    this.timeshift.transmitStream(false);

    // Kill any FFmpeg sessions.
    if(this.ffmpegStream) {

      this.ffmpegStream.stop();
      this.ffmpegStream = null;
    }

    if(this.transmitListener) {

      this.timeshift.removeListener("segment", this.transmitListener);
      this.transmitListener = null;
    }

    // Inform the user.
    this.log.info("%s: HomeKit Secure Video has recorded a %s second motion event.",
      this.name(), Math.round((this.recordedSegments * this.timeshift.segmentLength) / 1000));

    // If we have a reason for stopping defined, and it's noteworthy, inform the user.
    let reasonDescription;

    switch(reason) {

      case HDSProtocolSpecificErrorReason.CANCELLED:
        reasonDescription = "HomeKit canceled the request.";
        break;

      case HDSProtocolSpecificErrorReason.UNEXPECTED_FAILURE:
        reasonDescription = "An unexpected protocol failure has occured.";
        break;

      case HDSProtocolSpecificErrorReason.TIMEOUT:
        reasonDescription = "The request timed out.";
        break;

      default:
        break;
    }

    if(reason !== HDSProtocolSpecificErrorReason.NORMAL) {

      this.log.error("%s: HomeKit Secure Video event recording ended abnormally: %s", this.name(), reasonDescription);
    }
  }

  // Return our HomeKit Secure Video recording state. This effectively tells us if HKSV has been configured and is on.
  public get isRecording(): boolean {

    return this._isRecording;
  }

  // Return our current HomeKit Secure Video recording configuration.
  public get recordingConfiguration(): CameraRecordingConfiguration | null {

    return this.recordingConfig ?? null;
  }
}
