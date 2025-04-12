/* Copyright(C) 2017-2025, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-record.ts: Homebridge camera recording delegate implementation for UniFi Protect to support HomeKit Secure Video.
 *
 * The author would like to acknowledge and thank Supereg (https://github.com/Supereg) and Sunoo (https://github.com/Sunoo)
 * for being sounding boards as I worked through several ideas and iterations of this work. Their camaraderie and support was
 * deeply appreciated.
 */
import { API, CameraRecordingConfiguration, CameraRecordingDelegate, HAP, HDSProtocolSpecificErrorReason,
  PlatformAccessory, RecordingPacket } from "homebridge";
import { HomebridgePluginLogging, Nullable, formatBps } from "homebridge-plugin-utils";
import { ProtectCamera, RtspEntry } from "./devices/index.js";
import { FfmpegRecordingProcess } from "./ffmpeg/index.js";
import { PROTECT_HKSV_TIMESHIFT_BUFFER_MAXDURATION } from "./settings.js";
import { ProtectNvr } from "./protect-nvr.js";
import { ProtectTimeshiftBuffer } from "./protect-timeshift.js";

// Camera recording delegate implementation for Protect.
export class ProtectRecordingDelegate implements CameraRecordingDelegate {

  private _isRecording: boolean;
  private readonly accessory: PlatformAccessory;
  private readonly api: API;
  private closedReason?: HDSProtocolSpecificErrorReason;
  private readonly hap: HAP;
  private ffmpegStream?: FfmpegRecordingProcess;
  private hksvRequestedClose: boolean;
  private isInitialized: boolean;
  private isTransmitting: boolean;
  private readonly log: HomebridgePluginLogging;
  private nvr: ProtectNvr;
  private readonly protectCamera: ProtectCamera;
  private recordingConfig?: CameraRecordingConfiguration;
  public rtspEntry: Nullable<RtspEntry>;
  public readonly timeshift: ProtectTimeshiftBuffer;
  private timeshiftedSegments: number;
  private transmitListener?: ((segment: Buffer) => void);
  private transmittedSegments: number;

  // Create an instance of the HKSV recording delegate.
  constructor(protectCamera: ProtectCamera) {

    this._isRecording = false;
    this.accessory = protectCamera.accessory;
    this.api = protectCamera.api;
    this.closedReason = undefined;
    this.hap = protectCamera.api.hap;
    this.hksvRequestedClose = false;
    this.isInitialized = false;
    this.isTransmitting = false;
    this.log = protectCamera.log;
    this.nvr = protectCamera.nvr;
    this.protectCamera = protectCamera;
    this.timeshiftedSegments = 0;
    this.transmittedSegments = 0;
    this.rtspEntry = null;
    this.timeshift = new ProtectTimeshiftBuffer(protectCamera);
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

      // Turn off any potential inflight motion detection. Strictly speaking, this shouldn't be needed since any inflight motion sensor events will clear themselves.
      // That said, we play it safe just the same.
      this.accessory.getService(this.hap.Service.MotionSensor)?.updateCharacteristic(this.hap.Characteristic.MotionDetected, false);

      // We're done.
      return;
    }

    // We're recording - update our recording state internally. We set this regardless of whether or not we succeed at starting the timeshift buffer in order to maintain
    // our state consistent with HKSV.
    this._isRecording = active;

    // Begin maintaining a timeshift buffer, if configured to do so.
    if(!(await this.configureTimeshifting())) {

      return;
    }

    // Inform the user of the state change, if needed.
    if(this.isInitialized) {

      return;
    }

    this.isInitialized = true;

    this.log.info("HKSV: %s%s, %s.", this.protectCamera.hints.hardwareTranscoding ? "hardware-accelerated " : "", this.rtspEntry?.name,
      formatBps((this.recordingConfig?.videoCodec.parameters.bitRate ?? 0) * 1000));
  }

  // Process updated recording configuration settings from HomeKit Secure Video.
  public updateRecordingConfiguration(configuration: CameraRecordingConfiguration | undefined): void {

    // If we're set to an undefined state, it's because HomeKit can't figure out a valid configuration to use. This is typically due to a factory reset of the camera or
    // a similar edge case. We choose to handle it by stopping our timeshift buffer.
    if(!configuration) {

      this.recordingConfig = configuration;
      this.timeshift.stop();

      return;
    }

    // Save the new recording configuration.
    this.recordingConfig = configuration;

    // Tell our timeshift buffer how many seconds HomeKit has requested we prebuffer. We intentionally want a relatively large buffer to account for some Protect quirks.
    this.timeshift.configuredDuration = PROTECT_HKSV_TIMESHIFT_BUFFER_MAXDURATION;

    // Start or restart our timeshift buffer based on our updated configuration.
    void this.updateRecordingActive(this.isRecording);
  }

  // Handle the actual recording stream request.
  public async *handleRecordingStreamRequest(): AsyncGenerator<RecordingPacket> {

    // The first transmitted segment in an fMP4 stream is always the initialization segment and contains no video, so we don't count it.
    this.transmittedSegments = 0;

    // If we are recording HKSV events and we haven't fully initialized our timeshift buffer (e.g. offline cameras preventing us from doing so), then do so now.
    if(this.accessory.context.hksvRecording && this.isRecording && !this.isInitialized) {

      await this.updateRecordingActive(this.isRecording);
    }

    // If we've explicitly disabled HKSV recording, or we have issues setting up our timeshift buffer, we're done right now. Otherwise, start transmitting our timeshift
    // buffer and process it through FFmpeg.
    if(!this.accessory.context.hksvRecording || !this.isInitialized || this.timeshift.isRestarting || !(await this.startTransmitting()) || !this.ffmpegStream) {

      // Stop transmitting.
      if(this.isTransmitting) {

        this.stopTransmitting();
      }

      // Send a single byte packet and mark it as our last.
      yield { data: Buffer.alloc(1, 0), isLast: true };

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

      // Keep track of how many segments we're sending to HKSV.
      this.transmittedSegments++;

      // Send HKSV the fMP4 segment.
      yield { data: segment, isLast: false };
    }

    // If FFmpeg timed out it's typically due to the quality of the video coming from the Protect controller. Restart the livestream API to see if we can improve things.
    if(this.ffmpegStream?.isTimedOut) {

      this.timeshift.restart();

      // Send HKSV a final segment to cleanly wrap up.
      yield { data: Buffer.alloc(1, 0), isLast: true };
    }
  }

  // Receive an acknowledgement from HomeKit that it's seen an end-of-stream packet from us.
  public acknowledgeStream(): void {

    // Since HomeKit knows our transmission is ending, it's safe to do so now.
    this.stopTransmitting();
    this.hksvRequestedClose = true;
  }

  // Process HomeKit requests to end the transmission of the recording stream.
  public closeRecordingStream(streamId: number, reason?: HDSProtocolSpecificErrorReason): void {

    this.stopTransmitting(reason);
    this.hksvRequestedClose = true;
  }

  // Maintain a timeshift buffer and which Protect streams to use for HKSV.
  private async configureTimeshifting(): Promise<boolean> {

    // We have no recording configuration available yet. Even though HKSV recording is technically active, we can't do anything without a valid HKSV recording
    // configuration, which HomeKit hasn't sent us yet.
    if(!this.recordingConfig) {

      return false;
    }

    const timeshiftError = "Unable to configure HomeKit Secure Video event recording support";

    // If the camera isn't connected, don't attempt to do anything with the timeshift buffer or HKSV quite yet.
    if(!this.protectCamera.isOnline) {

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

    // If HKSV hasn't asked us to record, we're done with everything we need to configure.
    if(!this.isRecording) {

      return true;
    }

    // If we haven't changed the camera channel or lens we're using, and we've already started timeshifting, we're done.
    if(this.timeshift.isStarted && (this.rtspEntry.channel.id === oldRtspEntry?.channel.id) &&
      ((this.rtspEntry.lens === undefined) || (this.rtspEntry.lens === oldRtspEntry?.lens))) {

      return true;
    }

    // Fire up the timeshift buffer. If we've got multiple lenses, we use the first channel and explicitly request the lens we want.
    if(!(await this.timeshift.start(this.rtspEntry.channel.id, this.rtspEntry.lens))) {

      return false;
    }

    return true;
  }

  // Start transmitting to the HomeKit hub our timeshifted fMP4 stream.
  private async startTransmitting(): Promise<boolean> {

    // If there's a prior instance of FFmpeg, clean up after ourselves.
    if(this.ffmpegStream) {

      this.ffmpegStream.stop(false);
      this.ffmpegStream = undefined;
    }

    // If there's a prior instance of our transmit handler, clean it up.
    if(this.transmitListener) {

      this.timeshift.off("segment", this.transmitListener);
      this.transmitListener = undefined;
    }

    // If we don't have a recording configuration from HomeKit or an RTSP profile, we can't continue.
    if(!this.recordingConfig || !this.rtspEntry || this.timeshift.isRestarting) {

      return false;
    }

    // So how do we feed HKSV what it's looking for and how does timeshifting work in practice?
    //
    // We want to keep feeding HomeKit until it tells us it's finished, or we decide we don't want to send anymore fMP4 packets. We treat this in a similar way to how a
    // DVR works where you can pause live television, but it continues to buffer what's being broadcast until you're ready to watch it. This is the same idea.

    // Keep track of how many fMP4 segments we are feeding FFmpeg.
    this.transmittedSegments = this.timeshiftedSegments = 0;

    // Check to see if the user has audio enabled or disabled for recordings.
    const isAudioActive = (this.protectCamera.ufp.featureFlags.hasMic && this.protectCamera.hasFeature("Audio") &&
      (this.protectCamera.stream.controller.recordingManagement?.recordingManagementService
        .getCharacteristic(this.api.hap.Characteristic.RecordingAudioActive).value === 1)) ? true : false;

    // Start a new FFmpeg instance to transcode using HomeKit's requirements.
    this.ffmpegStream = new FfmpegRecordingProcess(this.protectCamera, this.recordingConfig, this.rtspEntry, isAudioActive);
    this.closedReason = undefined;
    this.hksvRequestedClose = false;
    this.isTransmitting = true;

    // We maintain a queue to manage segment writes to FFmpeg. Why? We need to be prepared for backpressure when writing to FFmpeg.
    const segmentQueue: Buffer[] = [];
    let isWriting = false;

    // Segment queue manager.
    const processSegmentQueue = (segment?: Buffer): void => {

      // Add the segment to the queue.
      if(segment) {

        segmentQueue.push(segment);
      }

      // If we already have a write in progress, or nothing left to write, we're done.
      if(isWriting || !segmentQueue.length) {

        return;
      }

      // Dequeue and write.
      isWriting = true;
      segment = segmentQueue.shift();

      // Send the segment to FFmpeg for processing.
      if(!this.ffmpegStream?.stdin?.write(segment)) {

        // FFmpeg isn't ready to read more data yet, queue the segment until we are.
        this.ffmpegStream?.stdin?.once("drain", () => {

          // Mark us available to write and process the write queue.
          isWriting = false;
          processSegmentQueue();
        });
      } else {

        // Update our statistics and process the next segment.
        this.timeshiftedSegments++;
        isWriting = false;
        processSegmentQueue();
      }
    };

    // Listen in for events from the timeshift buffer and feed FFmpeg. This looks simple, conceptually, but there's a lot going on here.
    this.timeshift.on("segment", this.transmitListener = (segment: Buffer): void => {

      // If stdin has been closed, we're done.
      if(!this.ffmpegStream?.stdin?.writable) {

        return;
      }

      // Queue the segment for processing.
      processSegmentQueue(segment);
    });

    // Check to make sure something didn't go wrong when we start transmitting the stream. If there is, we're resetting our connectivity to the Protect controller.
    if(!(await this.timeshift.transmitStart())) {

      // Stop our FFmpeg process and our timeshift buffer.
      this.ffmpegStream?.stop();
      this.timeshift.stop();

      if(this.transmitListener) {

        this.timeshift.off("segment", this.transmitListener);
        this.transmitListener = undefined;
      }

      // Ensure we cleanup.
      this.ffmpegStream = undefined;
      this.isTransmitting = false;

      return false;
    }

    // Indicate we are recording, if configured to do so.
    if(this.protectCamera.hints.hksvRecordingIndicator && !this.protectCamera.ufp.ledSettings.isEnabled) {

      // We aren't going to wait for this to return in order to ensure we are handling the HKSV request as quickly as we can.
      void this.protectCamera.setStatusLed(true);
    }

    // Inform the user.
    this.log.debug("Beginning a HomeKit Secure Video recording event.");

    return true;
  }

  // Stop transmitting the HomeKit hub our timeshifted fMP4 stream.
  private stopTransmitting(reason?: HDSProtocolSpecificErrorReason): void {

    // We're done transmitting, so we can go back to maintaining our timeshift buffer for HomeKit.
    this.timeshift.transmitStop();

    // Kill any FFmpeg sessions.
    if(this.ffmpegStream) {

      this.ffmpegStream.stop(((reason !== undefined) && (reason !== HDSProtocolSpecificErrorReason.NORMAL)) ? false : undefined);
      this.ffmpegStream = undefined;
    }

    this.isTransmitting = false;

    if(this.transmitListener) {

      this.timeshift.off("segment", this.transmitListener);
      this.transmitListener = undefined;
    }

    // Indicate we are no longer recording, if configured to do so.
    if(this.protectCamera.hints.hksvRecordingIndicator && this.protectCamera.ufp.ledSettings.isEnabled) {

      // We aren't going to wait for this to return in order to ensure we are handling the HKSV request as quickly as we can.
      void this.protectCamera.setStatusLed(false);
    }

    // We actually have one less segment than we think we do since we counted the fMP4 stream header as well, which shouldn't count toward our total of transmitted video
    // segments.
    this.timeshiftedSegments = Math.max(--this.timeshiftedSegments, 0);
    this.transmittedSegments = Math.max(--this.transmittedSegments, 0);

    // Inform the user if we've recorded something.
    if(this.accessory.context.hksvRecording && this.timeshiftedSegments && this.transmittedSegments && this.rtspEntry) {

      // Calculate approximately how many seconds we've recorded. We have more accuracy in timeshifted segments, so we'll use the more accurate statistics when we can.
      // Otherwise, we use the number of segments transmitted to HomeKit as a close proxy.
      const recordedSeconds = (this.timeshiftedSegments * this.timeshift.segmentLength) / 1000;

      let recordedTime = "";

      // Calculate the time elements.
      const hours = Math.floor(recordedSeconds / 3600);
      const minutes = Math.floor((recordedSeconds % 3600) / 60);
      const seconds = Math.floor((recordedSeconds % 3600) % 60);

      // Create a nicely formatted string for end users. Yes, the author recognizes this isn't essential, but it does bring a smile to their face.
      if(recordedSeconds < 1) {

        recordedTime = recordedSeconds.toString();
      } else if(recordedSeconds < 60) {

        recordedTime = Math.round(recordedSeconds).toString();
      } else {

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
      if((reason === HDSProtocolSpecificErrorReason.NORMAL) && (this.protectCamera.hints.logHksv || this.protectCamera.hints.logMotion)) {

        this.log.info("HKSV: %s %s event.", recordedTime, timeUnit);
      }
    }

    // Let's figure out the reason why we're stopping, if we have one, and it's noteworthy.
    let reasonDescription;

    switch(reason) {

      case HDSProtocolSpecificErrorReason.CANCELLED:

        reasonDescription = "HomeKit canceled the request.";

        break;

      case HDSProtocolSpecificErrorReason.UNEXPECTED_FAILURE:

        reasonDescription = "the request was slow to respond. This error can be safely ignored - it will occur occasionally.";

        break;

      case HDSProtocolSpecificErrorReason.TIMEOUT:

        reasonDescription = "the request timed out. This error can be safely ignored - it will occur occasionally.";

        break;

      default:

        break;
    }

    this.closedReason = reason;

    // Inform the user when things stopped unexpectedly, and reset the timeshift buffer for good measure.
    if((reason !== undefined) && (reason !== HDSProtocolSpecificErrorReason.NORMAL) && !this.timeshift.isRestarting) {

      this.log.error("HKSV recording event ended early: %s", reasonDescription);
    }
  }

  // Return our HomeKit Secure Video recording state. This effectively tells us if HKSV has been configured and is on.
  public get isRecording(): boolean {

    return this._isRecording;
  }

  // Return our current HomeKit Secure Video recording configuration.
  public get recordingConfiguration(): Nullable<CameraRecordingConfiguration> {

    return this.recordingConfig ?? null;
  }
}
