/* Copyright(C) 2017-2023, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-record.ts: Homebridge camera recording delegate implementation for UniFi Protect to support HomeKit Secure Video.
 *
 * The author would like to acknowledge and thank Supereg (https://github.com/Supereg) and Sunoo (https://github.com/Sunoo)
 * for being sounding boards as I worked through several ideas and iterations of this work. Their camaraderie and support was
 * deeply appreciated.
 */
import { API, CameraRecordingConfiguration, CameraRecordingDelegate, HAP, HDSProtocolSpecificErrorReason,
  PlatformAccessory, RecordingPacket } from "homebridge";
import { ProtectCamera, RtspEntry } from "./protect-camera.js";
import { FfmpegRecordingProcess } from "./protect-ffmpeg-record.js";
import { ProtectLogging } from "./protect-types.js";
import { ProtectNvr } from "./protect-nvr.js";
import { ProtectTimeshiftBuffer } from "./protect-timeshift.js";

// Camera recording delegate implementation for Protect.
export class ProtectRecordingDelegate implements CameraRecordingDelegate {

  private _isRecording: boolean;
  private readonly accessory: PlatformAccessory;
  private readonly api: API;
  private readonly hap: HAP;
  private ffmpegStream: FfmpegRecordingProcess | null;
  private isInitialized: boolean;
  private isTransmitting: boolean;
  private readonly log: ProtectLogging;
  private readonly maxRecordingDuration: number;
  private nvr: ProtectNvr;
  private readonly protectCamera: ProtectCamera;
  private recordingConfig: CameraRecordingConfiguration | undefined;
  private rtspEntry: RtspEntry | null;
  private transmittedSegments: number;
  private readonly timeshift: ProtectTimeshiftBuffer;
  private timeshiftedSegments: number;
  private transmitListener: ((segment: Buffer) => void) | null;

  // Create an instance of the HKSV recording delegate.
  constructor(protectCamera: ProtectCamera) {

    this._isRecording = false;
    this.accessory = protectCamera.accessory;
    this.api = protectCamera.api;
    this.hap = protectCamera.api.hap;
    this.ffmpegStream = null;
    this.isInitialized = false;
    this.isTransmitting = false;
    this.log = protectCamera.log;
    this.nvr = protectCamera.nvr;
    this.protectCamera = protectCamera;
    this.maxRecordingDuration = this.protectCamera.getFeatureNumber("Video.HKSV.Recording.MaxDuration") ?? 0;
    this.timeshiftedSegments = 0;
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

        this.log.info("Disabling HomeKit Secure Video event recording.");
      }

      // Disable recording.
      this._isRecording = active;

      // Turn off any potential inflight motion detection. Strictly speaking, this shouldn't be needed since any inflight
      // motion sensor events will clear themselves. That said, we play it safe just the same.
      this.accessory.getService(this.hap.Service.MotionSensor)?.updateCharacteristic(this.hap.Characteristic.MotionDetected, false);

      // We're done.
      return;
    }

    // We're recording - update our recording state internally. We set this regardless of whether or not we succeed at starting the
    // timeshift buffer in order to maintain our state consistent with HKSV.
    this._isRecording = active;

    // Begin maintaining a timeshift buffer, if configured to do so.
    if(!(await this.configureTimeshifting())) {

      return;
    }

    // Inform the user of the state change, if needed.
    if(!this.isInitialized) {

      this.isInitialized = true;

      this.log.info("HomeKit Secure Video %sevent recording enabled: %s, %s kbps with %s",
        this.protectCamera.hints.hardwareTranscoding ? "hardware-accelerated " : "",
        this.rtspEntry?.name, this.recordingConfig?.videoCodec.parameters.bitRate,
        this.protectCamera.hints.timeshift ?
          "a " + (this.timeshift.length / 1000).toString() + " second timeshift buffer." :
          "no timeshift buffer. This will provide a suboptimal HKSV experience."
      );

      // Inform the user if there's a maximum event recording duration set.
      if(this.maxRecordingDuration) {

        this.log.info("HomeKit Secure Video recordings will be no longer than ~%s seconds.", this.maxRecordingDuration);
      }
    }
  }

  // Process updated recording configuration settings from HomeKit Secure Video.
  public updateRecordingConfiguration(configuration: CameraRecordingConfiguration | undefined): void {

    // If we're set to an undefined state, it's because HomeKit can't figure out a valid configuration to use. This is
    // typically due to a factory reset of the camera or a similar edge case. We choose to handle it by stopping our
    // timeshift buffer.
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

    let isLastSegment = false;
    this.transmittedSegments = 0;

    // If we are recording HKSV events and we haven't fully initialized our timeshift buffer (e.g. offline cameras preventing us
    // from doing so), then do so now.
    if(this.accessory.context.hksvRecording && this.isRecording && !this.isInitialized) {

      await this.updateRecordingActive(this.isRecording);
    }

    // If we've explicitly disabled HKSV recording, or we have issues setting up our timeshift buffer, we're done right now. Otherwise,
    // start transmitting our timeshift buffer and process it through FFmpeg.
    if(!this.accessory.context.hksvRecording || !this.isInitialized || !(await this.startTransmitting()) || !this.ffmpegStream) {

      // Stop transmitting, if needed. If HKSV recording has been disabled explicitly, it should never start in the first place.
      await this.stopTransmitting();

      // Something's gone wrong, or we've disabled HKSV recording. In either event, we send an fMP4 stream header
      // back to HKSV and exit as cleanly as we can. If we can't get the stream header, we still send an empty segment
      // to HKSV - this will still generate a warning in Homebridge that can be ignored.
      yield { data: (await this.timeshift.getInitSegment()) ?? Buffer.alloc(0), isLast: true };

      return;
    }

    // Process our FFmpeg-generated segments and send them back to HKSV.
    for await (const segment of this.ffmpegStream.segmentGenerator()) {

      // If we've not transmitting, we're done.
      if(!this.isTransmitting) {

        break;
      }

      // No segment doesn't mean we're done necessarily, but it does mean we need to wait for FFmpeg to catch up.
      if(!segment) {

        continue;
      }

      // If we've exceeded a user-configured maximum recording duration, let HomeKit know we're stopping. We imperfectly calculate
      // our recording duration by using the fact that each transmitted segment will contain a single I-frame. The method is imperfect because
      // partial segments happen, as well as other edge cases, but it's more than good enough for our purposes.
      if(this.maxRecordingDuration && this.rtspEntry && ((this.transmittedSegments * this.rtspEntry.channel.idrInterval) > this.maxRecordingDuration)) {

        isLastSegment = true;
      }

      // Keep track of how many segments we're sending to HKSV.
      this.transmittedSegments++;

      // Send HKSV the fMP4 segment.
      yield { data: segment, isLast: isLastSegment };

      // If we're at the last segment, we're done.
      if(isLastSegment) {

        break;
      }
    }
  }

  // Receive an acknowledgement from HomeKit that it's seen an end-of-stream packet from us.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async acknowledgeStream(streamId: number): Promise<void> {

    // Since HomeKit knows our transmission is ending, it's safe to do so now.
    await this.stopTransmitting();
  }

  // Process HomeKit requests to end the transmission of the recording stream.
  public async closeRecordingStream(streamId: number, reason: HDSProtocolSpecificErrorReason | undefined): Promise<void> {

    await this.stopTransmitting(reason);
  }

  // Maintain a timeshift buffer and which Protect streams to use for HKSV.
  private async configureTimeshifting(): Promise<boolean> {

    // We have no recording configuration available yet. Even though HKSV recording is technically active, we can't do anything without
    // a valid HKSV recording configuration, which HomeKit hasn't sent us yet.
    if(!this.recordingConfig) {

      return false;
    }

    const timeshiftError = "Unable to configure HomeKit Secure Video event recording support";

    // If the camera isn't connected, don't attempt to do anything with the timeshift buffer or HKSV quite yet.
    if(this.protectCamera.ufp.state !== "CONNECTED") {

      this.log.error("%s: the camera is not currently connected to the Protect controller." +
        " HomeKit Secure Video event recording will resume once the camera reconnects to the Protect controller.", timeshiftError);
      return false;
    }

    const oldRtspEntry = this.rtspEntry;

    // Figure out which camera channel we should use for the based on the HKSV-requested resolution.
    this.rtspEntry = this.protectCamera.findRecordingRtsp(this.recordingConfig.videoCodec.resolution[0], this.recordingConfig.videoCodec.resolution[1]);

    if(!this.rtspEntry) {

      this.log.error("%s: no valid RTSP stream profile was found for this camera.", timeshiftError);
      return false;
    }

    // If we haven't enabled the timeshift buffer or HKSV hasn't asked us to record, we're done with everything we need to configure.
    if(!this.protectCamera.hints.timeshift || !this.isRecording) {

      return true;
    }

    // Set the bitrate to what HomeKit is looking for. This is particularly useful when we occasionally have to livestream to a user, where bitrates
    // can be different and even get reconfigured in realtime. By contrast, HomeKit Secure Video has a consistent bitrate it accepts, and we want to
    // try to match it as closely as posible, assuming dynamic bitrates are enabled.
    if(!(await this.protectCamera.setBitrate(this.rtspEntry.channel.id, this.recordingConfig.videoCodec.parameters.bitRate * 1000))) {

      this.log.error("%s: unable to set the bitrate to %skbps.", timeshiftError, this.recordingConfig.videoCodec.parameters.bitRate);
      return false;
    }

    // If we haven't changed the camera channel or lens we're using, and we've already started timeshifting, we're done.
    if(this.timeshift.isStarted && (this.rtspEntry.channel.id === oldRtspEntry?.channel.id) &&
      ((this.rtspEntry.lens === undefined) || (this.rtspEntry.lens === oldRtspEntry?.lens))) {

      return true;
    }

    // Fire up the timeshift buffer. If we've got multiple lenses, we use the first channel and explicitly request the lens we want.
    if(!(await this.timeshift.start((this.rtspEntry.lens === undefined) ? this.rtspEntry.channel.id : 0, this.rtspEntry.lens))) {

      this.log.error("%s.", timeshiftError);
      return false;
    }

    return true;
  }

  // Start transmitting to the HomeKit hub our timeshifted fMP4 stream.
  private async startTransmitting(): Promise<boolean> {

    // If there's a prior instance of FFmpeg, clean up after ourselves.
    if(this.ffmpegStream) {

      this.ffmpegStream.stop(false);
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

    // We want to keep feeding HomeKit until it tells us it's finished, or we decide we don't want to send anymore fMP4 packets. We
    // treat this in a similar way to how a DVR works where you can pause live television, but it continues to buffer what's being
    // broadcast until you're ready to watch it. This is the same idea.

    // Keep track of how many fMP4 segments we are feeding FFmpeg.
    this.transmittedSegments = 0;

    // Check to see if the user has audio enabled or disabled for recordings.
    const isAudioActive = (this.protectCamera.ufp.featureFlags.hasMic && this.protectCamera.hasFeature("Audio") &&
      (this.protectCamera.stream.controller.recordingManagement?.recordingManagementService
        .getCharacteristic(this.api.hap.Characteristic.RecordingAudioActive).value === 1)) ? true : false;

    // Start a new FFmpeg instance to transcode using HomeKit's requirements.
    this.ffmpegStream = new FfmpegRecordingProcess(this.protectCamera, this.recordingConfig, this.rtspEntry, isAudioActive);
    this.isTransmitting = true;

    // Let the timeshift buffer know it's time to transmit and continue timeshifting.
    if(this.protectCamera.hints.timeshift) {

      this.timeshiftedSegments = 0;

      // Check to make sure something didn't go wrong when we start transmitting the stream.
      if(!(await this.timeshift.startTransmitting())) {

        // Stop our FFmpeg process and our timeshift buffer.
        this.ffmpegStream.stop();
        this.timeshift.stop();

        // Ensure we cleanup.
        this.ffmpegStream = null;
        this.isTransmitting = false;

        // Restart our timeshift buffer.
        await this.restartTimeshifting();

        return false;
      }

      let seenInitSegment = false;

      // Listen in for events from the timeshift buffer and feed FFmpeg. This looks simple, conceptually,
      // but there's a lot going on here.
      this.transmitListener = (segment: Buffer): void => {

        // We don't want to send the initialization segment more than once - FFmpeg will get confused if you do, plus
        // it's wrong and you should only send the fMP4 stream header information once.
        if(this.timeshift.isInitSegment(segment)) {

          if(!seenInitSegment) {

            seenInitSegment = true;
            this.ffmpegStream?.stdin?.write(segment);
          }

          return;
        }

        // Send the segment to FFmpeg for processing.
        this.ffmpegStream?.stdin?.write(segment);
        this.timeshiftedSegments++;
      };

      this.timeshift.on("segment", this.transmitListener);
    }

    // Inform the user.
    this.log.debug("Beginning a HomeKit Secure Video recording event.");

    return true;
  }

  // Stop transmitting the HomeKit hub our timeshifted fMP4 stream.
  private async stopTransmitting(reason?: HDSProtocolSpecificErrorReason): Promise<void> {

    // We're done transmitting, so we can go back to maintaining our timeshift buffer for HomeKit.
    if(this.protectCamera.hints.timeshift) {

      this.timeshift.stopTransmitting();
    }

    let ffmpegError = false;

    // Kill any FFmpeg sessions.
    if(this.ffmpegStream) {

      this.ffmpegStream.stop(((reason !== undefined) && (reason !== HDSProtocolSpecificErrorReason.NORMAL)) ? false : undefined);
      ffmpegError = this.ffmpegStream.hasError;
      this.ffmpegStream = null;
    }

    this.isTransmitting = false;

    if(this.transmitListener) {

      this.timeshift.removeListener("segment", this.transmitListener);
      this.transmitListener = null;
    }

    // We actually have one less segment than we think we do since we counted the fMP4 stream header as well, which
    // shouldn't count toward our total of transmitted video segments.
    if(this.transmittedSegments) {

      this.transmittedSegments--;
    }

    // Inform the user if we've recorded something.
    if(this.accessory.context.hksvRecording && this.transmittedSegments && this.rtspEntry) {

      // Calculate approximately how many seconds we've recorded. We have more accuracy in timeshifted segments, so we'll use the more
      // accurate statistics when we can. Otherwise, we use the number of segments transmitted to HomeKit as a close proxy.
      const recordedSeconds = this.timeshiftedSegments ?
        ((this.timeshiftedSegments * this.timeshift.segmentLength) / 1000) : (this.transmittedSegments / this.rtspEntry?.channel.idrInterval);

      let recordedTime = "";

      // Create a nicely formatted string for end users. Yes, the author recognizes this isn't essential, but it does bring a smile to their face.
      if(recordedSeconds < 1) {

        recordedTime = recordedSeconds.toString();
      } else if(recordedSeconds < 60) {

        recordedTime = Math.round(recordedSeconds).toString();
      } else {

        // Calculate the time elements.
        const hours = Math.floor(recordedSeconds / 3600);
        const minutes = Math.floor((recordedSeconds % 3600)/ 60);
        const seconds = Math.floor((recordedSeconds % 3600) % 60);

        // Build the string.
        if(hours > 9) {

          recordedTime = hours.toString() + ":";
        } else if(hours > 0) {

          recordedTime = "0" + hours.toString() + ":";
        }

        if(minutes > 9) {

          recordedTime += minutes.toString() + ":";
        } else if(minutes > 0) {

          recordedTime += (hours > 0) ? "0" : "" + minutes.toString() + ":";
        }

        if(recordedTime.length && (seconds < 10)) {

          recordedTime += "0" + seconds.toString();
        } else {

          recordedTime += seconds ? seconds.toString() : recordedSeconds.toString();
        }
      }

      let timeUnit;

      switch(recordedTime.split(":").length - 1) {

        case 1:
          timeUnit = "minute";
          break;

        case 2:
          timeUnit = "hour";
          break;

        default:

          timeUnit = "second";
          break;
      }

      // Inform the user if they've enabled logging. We log HKSV events by default, for now.
      if(this.protectCamera.hints.logHksv || this.protectCamera.hints.logMotion) {

        this.log.info("HomeKit Secure Video has recorded %s %s %s motion event.", this.timeshiftedSegments ? "a" : "an approximately", recordedTime, timeUnit);
      }
    }

    // Let's figure out the reason why we're stopping, if we have one, and it's noteworthy.
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

    // Inform the user when things stopped unexpectedly, and reset the timeshift buffer for good measure.
    if((reason !== undefined) && (reason !== HDSProtocolSpecificErrorReason.NORMAL)) {

      this.log.error("HomeKit Secure Video event recording ended early: %s", reasonDescription);

      if(this.protectCamera.hints.timeshift && ffmpegError) {

        await this.restartTimeshifting();
      }
    }
  }

  // Restart timeshifting for a camera.
  public async restartTimeshifting(): Promise<void> {

    this.timeshift.stop();
    await this.configureTimeshifting();
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
