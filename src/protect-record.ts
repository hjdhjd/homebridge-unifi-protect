/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-record.ts: Homebridge camera recording delegate implementation for UniFi Protect to support HomeKit Secure Video.
 *
 * The author would like to acknowledge and thank Supereg (https://github.com/Supereg) and Sunoo (https://github.com/Sunoo)
 * for being sounding boards as I worked through several ideas and iterations of this work. Their camaraderie and support was
 * deeply appreciated.
 */
import type { API, CameraRecordingConfiguration, CameraRecordingDelegate, HAP, PlatformAccessory, RecordingPacket } from "homebridge";
import { FfmpegRecordingProcess, type HomebridgePluginLogging, type Nullable, formatBps } from "homebridge-plugin-utils";
import { PROTECT_HKSV_TIMEOUT, PROTECT_HKSV_TIMESHIFT_BUFFER_MAXDURATION } from "./settings.js";
import type { ProtectCamera, RtspEntry } from "./devices/index.js";
import { HDSProtocolSpecificErrorReason } from "homebridge";
import { ProtectTimeshiftBuffer } from "./protect-timeshift.js";
import { setTimeout as delay } from "node:timers/promises";

// Camera recording delegate implementation for Protect.
export class ProtectRecordingDelegate implements CameraRecordingDelegate {

  private _isRecording: boolean;
  private _isTransmitting: boolean;
  private abortController?: AbortController;
  private readonly accessory: PlatformAccessory;
  private readonly api: API;
  private eventId: number;
  private ffmpegStream?: FfmpegRecordingProcess;
  private readonly hap: HAP;
  private isInitialized: boolean;
  private lastPacingDelay: number;
  private lastStreamId: number;
  private readonly log: HomebridgePluginLogging;
  private maxPacingDelay: number;
  private pacingStartTime: number;
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
    this._isTransmitting = false;
    this.accessory = protectCamera.accessory;
    this.api = protectCamera.api;
    this.eventId = 0;
    this.hap = protectCamera.api.hap;
    this.isInitialized = false;
    this.lastPacingDelay = 0;
    this.lastStreamId = -1;
    this.log = protectCamera.log;
    this.maxPacingDelay = 0;
    this.pacingStartTime = 0;
    this.protectCamera = protectCamera;
    this.rtspEntry = null;
    this.timeshift = new ProtectTimeshiftBuffer(protectCamera);
    this.timeshiftedSegments = 0;
    this.transmittedSegments = 0;
  }

  // Process HomeKit requests to activate or deactivate HKSV recording capabilities for a camera.
  // eslint-disable-next-line @typescript-eslint/no-misused-promises -- Async implementation of a void-returning Homebridge interface method.
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

    // We're recording - update our recording state internally. We set this regardless of whether or not we succeed at starting the timeshift buffer in order to keep
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

    this.log.info("HKSV: %s%s, %s.",
      (this.protectCamera.hints.hardwareTranscoding && (this.protectCamera.platform.codecSupport.hostSystem !== "raspbian")) ? "\u26A1\uFE0F " : "",
      this.rtspEntry?.name, formatBps((this.recordingConfig?.videoCodec.parameters.bitRate ?? 0) * 1000));
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

  // Handle the actual recording stream request. The optional signal parameter is for forward compatibility with an upcoming HAP-nodejs release that will pass an
  // AbortSignal when the recording stream closes, allowing us to interrupt pending async operations (like pacing delays) immediately rather than waiting for
  // closeRecordingStream to propagate through our code. Until then, signal is undefined and the abort wiring below is a no-op.
  public async *handleRecordingStreamRequest(_streamId: number, signal?: AbortSignal): AsyncGenerator<RecordingPacket> {

    // Track when the recording request arrived from HomeKit's perspective. This is used for pacing calculations below...we set it here rather than at the
    // start of the pacing loop because HomeKit's timeout clock starts when it sends the request, not when we finish our setup.
    this.eventId++;
    this.pacingStartTime = Date.now();

    // The first transmitted segment in an fMP4 stream is always the initialization segment and contains no video, so we don't count it.
    this.transmittedSegments = 0;

    // If we are recording HKSV events and we haven't fully initialized our timeshift buffer (e.g. offline cameras preventing us from doing so), then do so now.
    if(!this.accessory.context.hksvRecordingDisabled && this.isRecording && !this.isInitialized) {

      await this.updateRecordingActive(this.isRecording);
    }

    // If we've explicitly disabled HKSV recording, or we have issues setting up our timeshift buffer, we're done right now. Otherwise, start transmitting our timeshift
    // buffer and process it through FFmpeg.
    if(this.accessory.context.hksvRecordingDisabled || !this.isInitialized || this.timeshift.isRestarting || !this.protectCamera.isOnline ||
      (this.timeshift.time < this.timeshift.configuredDuration) || !(await this.startTransmitting()) || !this.ffmpegStream) {

      // Stop transmitting.
      if(this._isTransmitting) {

        this.stopTransmitting();
      }

      // Indicate to ourselves that we've intentionally chosen not to respond to this recording event so we don't inadvertently log an error.
      this.transmittedSegments = -1;

      // Send a single byte packet and mark it as our last.
      yield { data: Buffer.alloc(1, 0), isLast: true };

      return;
    }

    // We pace our segment yields to HKSV to build a buffer of pre-produced segments from FFmpeg. By yielding one segment every ~4 seconds - just
    // under the 4.5-second HKSV timeout - FFmpeg's output accumulates ahead of what we've delivered. When the Protect controller's livestream API
    // stalls, we continue yielding pre-produced segments, absorbing stalls that would otherwise cause recording timeouts. While we wait between
    // yields, segmentGenerator() is paused and FFmpeg's output accumulates in its internal recording buffer.
    const pacingInterval = PROTECT_HKSV_TIMEOUT - 500;

    this.abortController = new AbortController();

    // If HAP-nodejs provides an AbortSignal, wire it to our own AbortController. HAP aborts in handleClosed() before calling closeRecordingStream, so this
    // gives us the earliest possible notification that the recording stream is closing...our pacing sleep is interrupted before stopTransmitting even runs.
    signal?.addEventListener("abort", () => this.abortController?.abort(), { once: true });

    this.lastPacingDelay = 0;
    this.maxPacingDelay = 0;

    // Process our FFmpeg-generated segments and send them back to HKSV.
    for await (const segment of this.ffmpegStream.segmentGenerator()) {

      // If we've not transmitting, we're done.
      if(!this._isTransmitting) {

        break;
      }

      // Keep track of how many segments we're sending to HKSV.
      this.transmittedSegments++;

      // Wait until our pacing schedule allows this segment to be yielded. Each segment is spaced pacingInterval apart from the recording start. The sleep is
      // abortable via the AbortController so that stopTransmitting() can interrupt it immediately when HomeKit closes the recording stream, rather than
      // waiting for the full pacing delay to expire.
      this.lastPacingDelay = (this.pacingStartTime + (this.transmittedSegments * pacingInterval)) - Date.now();
      this.maxPacingDelay = Math.max(this.maxPacingDelay, this.lastPacingDelay);

      if(this.lastPacingDelay > 0) {

        await delay(this.lastPacingDelay, undefined, { signal: this.abortController.signal }).catch(() => { /* Expected when recording stream closes. */ });
      }

      // If the recording stream was closed while we were waiting on our pacing schedule, we're done.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if(!this._isTransmitting) {

        break;
      }

      // Send HKSV the fMP4 segment.
      yield { data: segment, isLast: false };
    }

    // If FFmpeg timed out it's typically due to issues with the video coming from the Protect controller. Restart the timeshift buffer to see if we can improve things.
    // We only restart on genuine FFmpeg timeouts (stall-related), not on zero-segment exits (HomeKit closing early or bad data). Restarting on zero-segment
    // exits tears down a healthy livestream connection and empties the timeshift buffer, causing a cascading failure cycle for subsequent recording requests.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
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
  }

  // Process HomeKit requests to end the transmission of the recording stream.
  public closeRecordingStream(streamId: number, reason?: HDSProtocolSpecificErrorReason): void {

    this.lastStreamId = streamId;
    this.stopTransmitting(reason);
  }

  // Maintain a timeshift buffer and which Protect streams to use for HKSV. This is safe to call at any time — it validates recording state and avoids restarting the
  // timeshift buffer if it's already running on the correct channel and lens.
  public async configureTimeshifting(): Promise<boolean> {

    // We have no recording configuration available yet. Even though HKSV recording is technically active, we can't do anything without a valid HKSV recording
    // configuration, which HomeKit hasn't sent us yet.
    if(!this.recordingConfig) {

      return false;
    }

    const timeshiftError = "Unable to configure HKSV event recording support";

    // If the camera isn't connected, don't attempt to do anything with the timeshift buffer or HKSV quite yet.
    if(!this.protectCamera.isOnline) {

      this.log.error("%s: the camera is offline or unavailable. Event recording will resume after the camera is online.", timeshiftError);

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
      ((this.rtspEntry.lens === undefined) || (this.rtspEntry.lens === oldRtspEntry.lens))) {

      return true;
    }

    // Fire up the timeshift buffer. If we've got multiple lenses, we use the first channel and explicitly request the lens we want.
    if(!(await this.timeshift.start(this.rtspEntry))) {

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

    if(!this.protectCamera.stream) {

      return false;
    }

    // If we don't have a recording configuration from HomeKit, a valid RTSP profile, or not enough time in our timeshift buffer, we can't continue.
    if(!this.recordingConfig || !this.rtspEntry || this.timeshift.isRestarting ||
      ((this.protectCamera.stream.hksv?.timeshift.time ?? -1) < (this.protectCamera.stream.hksv?.timeshift.configuredDuration ?? 0))) {

      return false;
    }

    // So how do we feed HKSV what it's looking for and how does timeshifting work in practice?
    //
    // We want to keep feeding HomeKit until it tells us it's finished, or we decide we don't want to send anymore fMP4 packets. We treat this in a similar way to how a
    // DVR works where you can pause live television, but it continues to buffer what's being broadcast until you're ready to watch it. This is the same idea.

    // Keep track of how many fMP4 segments we are feeding FFmpeg.
    this.transmittedSegments = this.timeshiftedSegments = 0;

    // Find the nearest keyframe at or before the prebuffer start point. By starting FFmpeg's input from a keyframe boundary, the decoder initializes cleanly rather than
    // having to recover from mid-GOP data. The seek offset tells FFmpeg's -ss exactly how far to advance from the keyframe to the prebuffer start point.
    const alignment = this.timeshift.getKeyframeAlignedStart(this.recordingConfig.prebufferLength);

    // Start a new FFmpeg instance to transcode using HomeKit's requirements.
    this.ffmpegStream = new FfmpegRecordingProcess(this.protectCamera.stream.ffmpegOptions, this.recordingConfig, {

      audioFilters: this.protectCamera.audioFilters,
      audioStream: 0,
      codec: this.protectCamera.ufp.videoCodec,
      enableAudio: this.isAudioActive,
      fps: this.rtspEntry.channel.fps,
      timeshift: alignment?.seekOffsetMs ?? Math.max((this.protectCamera.stream.hksv?.timeshift.time ?? 0) - this.recordingConfig.prebufferLength, 0),
      transcodeAudio: false
    }, this.protectCamera.hasFeature("Debug.Video.HKSV"));

    this.ffmpegStream.start();
    this._isTransmitting = true;

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
    if(!(await this.timeshift.transmitStart(alignment?.startIndex))) {

      // Stop our FFmpeg process and our timeshift buffer.
      this.ffmpegStream.stop();
      this.timeshift.stop();
      this.timeshift.off("segment", this.transmitListener);

      // Ensure we cleanup.
      this.ffmpegStream = undefined;
      this.transmitListener = undefined;
      this._isTransmitting = false;

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

    // Guard against being called multiple times for the same recording event. This can occur when HAP-nodejs processes multiple close-related messages
    // from the same TCP chunk, each independently triggering closeRecordingStream.
    if(!this._isTransmitting) {

      return;
    }

    // Abort any in-progress pacing sleep so the recording generator can exit immediately without yielding to a closed stream.
    this.abortController?.abort();

    // We're done transmitting, so we can go back to maintaining our timeshift buffer for HomeKit.
    this.timeshift.transmitStop();

    // Kill any FFmpeg sessions, capturing process state before we clear the reference.
    const ffmpegEnded = this.ffmpegStream?.isEnded ?? true;
    const ffmpegTimedOut = this.ffmpegStream?.isTimedOut ?? false;

    if(this.ffmpegStream) {

      this.ffmpegStream.stop((((reason !== undefined) && (reason !== HDSProtocolSpecificErrorReason.NORMAL)) || this.timeshift.isRestarting) ? false : undefined);
      this.ffmpegStream = undefined;
    }

    this._isTransmitting = false;

    if(this.transmitListener) {

      this.timeshift.off("segment", this.transmitListener);
      this.transmitListener = undefined;
    }

    // Indicate we are no longer recording, if configured to do so.
    if(this.protectCamera.hints.hksvRecordingIndicator && this.protectCamera.ufp.ledSettings.isEnabled) {

      // We aren't going to wait for this to return in order to ensure we are handling the HKSV request as quickly as we can.
      void this.protectCamera.setStatusLed(false);
    }

    // If we have intentionally declined to respond to a recording event, we're done.
    if(!this.protectCamera.stream || (this.transmittedSegments === -1)) {

      return;
    }

    // We actually have one less segment than we think we do since we counted the fMP4 stream header as well, which shouldn't count toward our total of transmitted video
    // segments.
    this.timeshiftedSegments = Math.max(--this.timeshiftedSegments, 0);
    this.transmittedSegments = Math.max(--this.transmittedSegments, 0);

    // Inform the user if we've recorded something.
    if(!this.accessory.context.hksvRecordingDisabled && this.timeshiftedSegments && this.transmittedSegments && this.rtspEntry) {

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

          recordedTime += ((hours > 0) ? "0" : "") + minutes.toString() + ":";
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

      // Inform the user if they've enabled logging.
      if((reason === HDSProtocolSpecificErrorReason.NORMAL) && this.protectCamera.hints.logHksv) {

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

    // Inform the user when things stopped unexpectedly, accounting for known factors like the camera being online or the timeshift buffer restarting. We suppress
    // errors for sub-100ms durations...these are HomeKit protocol-level events where the recording stream is opened and immediately closed before we can respond,
    // and are not actionable.
    const recordingDuration = Date.now() - this.pacingStartTime;

    if((reason !== undefined) && (reason !== HDSProtocolSpecificErrorReason.NORMAL) && (recordingDuration >= 100) &&
      !this.timeshift.isRestarting && this.protectCamera.isOnline &&
      ((this.protectCamera.stream.hksv?.timeshift.time ?? -1) >= (this.recordingConfig?.prebufferLength ?? 0))) {

      const telemetry = this.protectCamera.hasFeature("Debug.Video.HKSV.Telemetry") ?
        " (event: " + this.eventId.toString() + ", stream: " + this.lastStreamId.toString() +
        ", duration: " + (recordingDuration / 1000).toFixed(3) +
        "s, segments yielded: " + this.transmittedSegments.toString() + ", segments to FFmpeg: " + this.timeshiftedSegments.toString() +
        ", FFmpeg ended: " + ffmpegEnded.toString() + ", FFmpeg timeout: " + ffmpegTimedOut.toString() +
        ", pacing delay: " + Math.round(this.lastPacingDelay).toString() +
        "/" + Math.round(this.maxPacingDelay).toString() + "ms last/peak)" : "";

      this.log.error("HKSV recording event ended early: %s%s", reasonDescription, telemetry);
    }
  }

  // Return whether the user has audio enabled or disabled for recordings.
  public get isAudioActive(): boolean {

    return (this.protectCamera.ufp.featureFlags.hasMic && this.protectCamera.hasFeature("Audio") &&
      (this.protectCamera.stream?.controller.recordingManagement?.recordingManagementService
        .getCharacteristic(this.api.hap.Characteristic.RecordingAudioActive).value === 1)) ? true : false;
  }

  // Return whether we are actively transmitting an HKSV recording event to HomeKit.
  public get isTransmitting(): boolean {

    return this._isTransmitting;
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
