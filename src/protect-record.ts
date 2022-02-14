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
  HAP,
  HDSProtocolSpecificErrorReason,
  Logging,
  PlatformAccessory,
  RecordingPacket
} from "homebridge";
import { ProtectCamera, RtspEntry } from "./protect-camera";
import { FfmpegRecordingProcess } from "./protect-ffmpeg-record";
import { ProtectCameraConfig } from "unifi-protect";
import { ProtectNvr } from "./protect-nvr";
import { ProtectTimeshiftBuffer } from "./protect-timeshift";

// Camera recording delegate implementation for Protect.
export class ProtectRecordingDelegate implements CameraRecordingDelegate {

  private _isRecording: boolean;
  private readonly accessory: PlatformAccessory;
  private readonly api: API;
  private readonly hap: HAP;
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
  private transmittedSegments: number;
  private readonly timeshift: ProtectTimeshiftBuffer;
  private transmitListener: ((segment: Buffer) => void) | null;

  constructor(protectCamera: ProtectCamera) {

    this.accessory = protectCamera.accessory;
    this.api = protectCamera.api;
    this.hap = protectCamera.api.hap;
    this.debug = protectCamera.platform.debug.bind(protectCamera.platform);
    this.ffmpegStream = null;
    this.isInitialized = false;
    this._isRecording = false;
    this.log = protectCamera.platform.log;
    this.name = protectCamera.name.bind(protectCamera);
    this.nvr = protectCamera.nvr;
    this.protectCamera = protectCamera;
    this.maxRecordingDuration = parseInt(this.nvr.optionGet(this.accessory.context.device as ProtectCameraConfig, "Video.HKSV.Recording.MaxDuration") ?? "0");
    this.transmittedSegments = 0;
    this.rtspEntry = null;
    this.timeshift = new ProtectTimeshiftBuffer(protectCamera);
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

      // Disable recording.
      this._isRecording = active;

      // Turn off any potential inflight motion detection. Strictly speaking, this shouldn't be needed since any inflight
      // motion sensor events will clear themselves. That said, we play it safe just the same.
      this.accessory.getService(this.hap.Service.MotionSensor)?.updateCharacteristic(this.hap.Characteristic.MotionDetected, false);

      // We're done.
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

    // If we've explicitly disabled HKSV recording, we're done right now. Otherwise, start transmitting our timeshift
    // buffer and process it through FFmpeg.
    if(!this.accessory.context.hksvRecording || !this.startTransmitting() || !this.ffmpegStream) {

      // Stop transmitting, if needed. If HKSV recording has been disabled explicitly, it should never start in the first place.
      this.stopTransmitting();

      // Something's gone wrong, or we've disabled HKSV recording. In either event, we send an fMP4 stream header
      // back to HKSV and exit as cleanly as we can. If we can't get the stream header, we still send an empty segment
      // to HKSV - this will still generate a warning in Homebridge that can be ignored.
      const streamHeader = (await this.timeshift.getStreamHeader()) ?? Buffer.alloc(0);

      yield { data: streamHeader, isLast: true };
      return;
    }

    let isLastSegment = false;
    let segmentCount = 0;

    // Process our FFmpeg-generated segments and send them back to HKSV.
    for await (const segment of this.ffmpegStream.segmentGenerator()) {

      isLastSegment = false;

      // If we've stopped transmitting, we're done.
      if(!this.timeshift.isTransmitting) {

        return;
      }

      // No segment doesn't mean we're done necessarily, but it does mean we need to wait for FFmpeg to catch up.
      if(!segment) {

        continue;
      }

      // If we've exceeded a user-configured maximum recording duration, let HomeKit know we're stopping.
      if(this.maxRecordingDuration && ((this.transmittedSegments * this.timeshift.segmentLength) / 1000) > this.maxRecordingDuration) {

        isLastSegment = true;
      }

      // Send HKSV the segment.
      yield {

        data: segment,
        isLast: isLastSegment
      };

      // Keep track of how many segments we've sent to HKSV.
      segmentCount++;

      // If we've sent the last segment, we're done.
      if(isLastSegment) {

        return;
      }
    }

    // If we're done transmitting, we're done returning segments to HKSV.
    if(!this.timeshift.isTransmitting) {

      return;
    }

    // Something's gone wrong and we've sent HKSV no segments. Let's send an fMP4 stream header back to HKSV and exit
    // as cleanly as we can. If we can't get the stream header, we send an empty segment to HKSV - this will still
    //generate a warning in Homebridge that can be ignored.
    if(!segmentCount) {

      const streamHeader = (await this.timeshift.getStreamHeader()) ?? Buffer.alloc(0);
      yield { data: streamHeader, isLast: true };
      return;
    }

    // Something likely happened to FFmpeg and we didn't send out a final segment. Tell HKSV we're really done.
    if(!isLastSegment) {

      yield { data: Buffer.alloc(0), isLast: true };
      return;
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
    this.transmittedSegments = 0;


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

      // We don't want the fMP4 ftyp or moov boxes accounted for in our recording statistics so
      // let's filter them out.
      if(!seenFtyp && this.timeshift.isFtyp(segment)) {

        seenFtyp = true;
        this.ffmpegStream?.stdin?.write(segment);
        return;
      }

      if(!seenMoov && this.timeshift.isMoov(segment)) {

        seenMoov = true;
        this.ffmpegStream?.stdin?.write(segment);
        return;
      }

      // We don't want to send the ftyp or moov boxes more than once - FFmpeg will get confused if you do, plus
      // it's wrong and you should only send the fMP4 stream header information once.
      if(this.timeshift.isFtyp(segment) || this.timeshift.isMoov(segment)) {

        return;
      }

      // Send the segment to FFmpeg for processing and update our statistics.
      this.ffmpegStream?.stdin?.write(segment);
      this.transmittedSegments++;
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
    if(this.accessory.context.hksvRecording) {

      // Calculate approximately how many seconds we've recorded.
      const recordedSeconds = (this.transmittedSegments * this.timeshift.segmentLength) / 1000;

      this.log.info("%s: HomeKit Secure Video has recorded a %s second motion event.",
        this.name(), recordedSeconds < 1 ? recordedSeconds : Math.round(recordedSeconds));
    }

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

    if((reason !== undefined) && (reason !== HDSProtocolSpecificErrorReason.NORMAL)) {

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
