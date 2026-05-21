/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-record.ts: Homebridge camera recording delegate implementation for UniFi Protect to support HomeKit Secure Video.
 *
 * The author would like to acknowledge and thank Supereg (https://github.com/Supereg) and Sunoo (https://github.com/Sunoo)
 * for being sounding boards as I worked through several ideas and iterations of this work. Their camaraderie and support was
 * deeply appreciated.
 */
import type { API, CameraRecordingConfiguration, CameraRecordingDelegate, HAP, PlatformAccessory, RecordingPacket } from "homebridge";
import { BackpressureWriter, FfmpegRecordingProcess, type HomebridgePluginLogging, type Nullable, formatBps } from "homebridge-plugin-utils";
import { PROTECT_HKSV_TIMEOUT, PROTECT_HKSV_TIMESHIFT_BUFFER_MAXDURATION } from "./settings.js";
import type { ProtectCamera, RtspEntry } from "./devices/index.js";
import { HDSProtocolSpecificErrorReason } from "homebridge";
import { ProtectTimeshiftBuffer } from "./protect-timeshift.js";
import { setTimeout as delay } from "node:timers/promises";

// HKSV end-of-stream marker. A single zero byte yielded with `isLast=true` signals the end of a recording stream to HomeKit. Module-scoped so we allocate once
// per process rather than per yield.
const HKSV_END_OF_STREAM_MARKER = Buffer.alloc(1, 0);

// Lightning-bolt emoji (U+26A1 HIGH VOLTAGE SIGN + U+FE0F VARIATION SELECTOR-16) used to prefix the HKSV configuration log when the host supports
// hardware-accelerated transcoding.
const HKSV_HARDWARE_TRANSCODE_MARKER = "\u26A1\uFE0F ";

// Camera recording delegate implementation for Protect.
export class ProtectRecordingDelegate implements CameraRecordingDelegate {

  private _isRecording: boolean;
  private _isTransmitting: boolean;
  private abortController?: AbortController;
  private readonly accessory: PlatformAccessory;
  private readonly api: API;
  private configurePromise?: Promise<boolean>;
  private configureRequested: boolean;
  private eventId: number;
  private ffmpegStream?: FfmpegRecordingProcess;
  private readonly hap: HAP;
  private hasLoggedConfig: boolean;
  private lastPacingDelay: number;
  private lastStreamId: number;
  private readonly log: HomebridgePluginLogging;
  private maxPacingDelay: number;
  private pacingStartTime: number;
  private readonly protectCamera: ProtectCamera;
  private recordingConfig?: CameraRecordingConfiguration;
  private recordingDeclined: boolean;
  public rtspEntry: Nullable<RtspEntry>;
  private segmentWriter?: BackpressureWriter;
  public readonly timeshift: ProtectTimeshiftBuffer;
  private timeshiftedSegments: number;
  private transmitListener?: ((segment: Buffer) => void);
  private transmittedSegments: number;
  private wasDeferredOffline: boolean;

  // Create an instance of the HKSV recording delegate.
  constructor(protectCamera: ProtectCamera) {

    this._isRecording = false;
    this._isTransmitting = false;
    this.accessory = protectCamera.accessory;
    this.api = protectCamera.api;
    this.configureRequested = false;
    this.eventId = 0;
    this.hap = protectCamera.api.hap;
    this.hasLoggedConfig = false;
    this.lastPacingDelay = 0;
    this.lastStreamId = -1;
    this.log = protectCamera.log;
    this.maxPacingDelay = 0;
    this.pacingStartTime = 0;
    this.protectCamera = protectCamera;
    this.recordingDeclined = false;
    this.rtspEntry = null;
    this.timeshift = new ProtectTimeshiftBuffer(protectCamera);
    this.timeshiftedSegments = 0;
    this.transmittedSegments = 0;
    this.wasDeferredOffline = false;
  }

  // Process HomeKit requests to activate or deactivate HKSV recording capabilities for a camera.
  // eslint-disable-next-line @typescript-eslint/no-misused-promises -- Async implementation of a void-returning Homebridge interface method.
  public async updateRecordingActive(active: boolean): Promise<void> {

    // Log only on the active-to-inactive transition, not on idempotent "already inactive" calls. `this.isRecording` is still the pre-update value here since we
    // haven't written `_isRecording` yet.
    if(!active && this.isRecording) {

      this.log.info("Disabling HomeKit Secure Video event recording.");
    }

    // The single source of truth for "does HomeKit want us to be recording?". The reconciler reads it to compute desired timeshift state. Set it regardless of
    // whether reconciliation succeeds so our view stays consistent with HomeKit's.
    this._isRecording = active;

    // If we are disabling recording, force MotionDetected=false immediately. An inflight motion event would otherwise hold MotionDetected=true until its own
    // reset timer fires, leaving HomeKit's view inconsistent with the just-disabled state for up to the motion-duration window.
    if(!active) {

      this.accessory.getService(this.hap.Service.MotionSensor)?.updateCharacteristic(this.hap.Characteristic.MotionDetected, false);
    }

    // Reconcile the timeshift buffer against the updated recording state. The reconciler is bidirectional, concurrency-safe, and idempotent...see
    // configureTimeshifting for the invariants.
    if(!(await this.configureTimeshifting())) {

      return;
    }

    // Nothing further to do when disabling recording...the reconciler has handled the teardown.
    if(!active) {

      return;
    }

    // Log the HKSV configuration once per delegate lifetime for user visibility.
    if(this.hasLoggedConfig) {

      return;
    }

    this.hasLoggedConfig = true;

    this.log.info("HKSV: %s%s [%s], %s.",
      (this.protectCamera.hints.hardwareTranscoding && (this.protectCamera.platform.codecSupport.hostSystem !== "raspbian")) ? HKSV_HARDWARE_TRANSCODE_MARKER : "",
      this.rtspEntry?.name, this.protectCamera.videoCodecName, formatBps((this.recordingConfig?.videoCodec.parameters.bitRate ?? 0) * 1000));
  }

  // Process updated recording configuration settings from HomeKit Secure Video.
  public updateRecordingConfiguration(configuration: CameraRecordingConfiguration | undefined): void {

    // The single source of truth for "what recording configuration has HomeKit selected?". Undefined is a valid value (HomeKit can't always produce a
    // configuration...typically post-factory-reset) and the reconciler treats it as "desired state is stopped".
    this.recordingConfig = configuration;

    if(configuration) {

      // Tell our timeshift buffer how many seconds HomeKit has requested we prebuffer. We intentionally want a relatively large buffer to account for some
      // Protect quirks.
      this.timeshift.configuredDuration = PROTECT_HKSV_TIMESHIFT_BUFFER_MAXDURATION;
    }

    // Reconcile the timeshift buffer against the updated configuration. A new valid config on an active recording triggers a start (or a restart if the
    // channel/lens changed); an undefined config triggers a stop.
    void this.configureTimeshifting();
  }

  // Handle the actual recording stream request. HAP-nodejs provides an AbortSignal that fires when the recording stream closes, allowing us to interrupt pending async
  // operations (like pacing delays) immediately rather than waiting for closeRecordingStream to propagate through our code.
  public async *handleRecordingStreamRequest(_streamId: number, signal: AbortSignal): AsyncGenerator<RecordingPacket> {

    // Track when the recording request arrived from HomeKit's perspective. HomeKit's timeout clock starts when it sends the request, so we initialize lastYieldTime here
    // to represent the moment HomeKit's timer began...the first segment will be due pacingInterval after this point.
    this.eventId++;
    this.pacingStartTime = Date.now();

    let lastYieldTime = this.pacingStartTime;

    // The first transmitted segment in an fMP4 stream is always the initialization segment and contains no video, so we don't count it.
    this.recordingDeclined = false;
    this.transmittedSegments = this.timeshiftedSegments = 0;

    // If we are recording HKSV events but the timeshift buffer is not currently running, reconcile now. This covers cases where an earlier configureTimeshifting
    // attempt failed (offline camera, establishment timeout) and no subsequent lifecycle event re-triggered the reconciler.
    if(!this.accessory.context.hksvRecordingDisabled && this.isRecording && !this.timeshift.isStarted) {

      await this.configureTimeshifting();
    }

    // If HKSV is disabled, the camera is offline, the buffer isn't full, or transmission setup fails, we're done. The timeshift.time check covers both "timeshift
    // never started" (time is zero) and "timeshift started but prebuffer not yet filled". The trailing !this.ffmpegStream is load-bearing for TypeScript narrowing
    // at subsequent direct accesses (segmentGenerator invocation)...TypeScript does not track field assignments across method calls.
    if(this.accessory.context.hksvRecordingDisabled || this.timeshift.isRestarting || !this.protectCamera.isOnline ||
      (this.timeshift.time < this.timeshift.configuredDuration) || !this.startTransmitting() || !this.ffmpegStream) {

      // Stop transmitting.
      if(this._isTransmitting) {

        this.stopTransmitting();
      }

      // Mark that we intentionally chose not to respond to this recording event so stopTransmitting doesn't log it as an error.
      this.recordingDeclined = true;

      // Send a single byte packet and mark it as our last.
      yield { data: HKSV_END_OF_STREAM_MARKER, isLast: true };

      return;
    }

    // We pace our segment yields to HKSV relative to the last delivery...each segment is yielded pacingInterval after the previous one was actually sent. This ensures
    // HomeKit's timeout is satisfied while building a buffer of pre-produced segments from FFmpeg. When the Protect controller's livestream API stalls, we continue
    // yielding pre-produced segments, absorbing stalls that would otherwise cause recording timeouts. While we wait between yields, segmentGenerator() is paused and
    // FFmpeg's output accumulates in its internal recording buffer.
    const pacingInterval = PROTECT_HKSV_TIMEOUT - 500;

    // Reset per-event pacing telemetry. lastPacingDelay and maxPacingDelay accumulate across the life of a single recording event and are surfaced in the
    // HKSV.Telemetry teardown log, so they need a clean slate here rather than carrying residual values from the previous event.
    this.lastPacingDelay = 0;
    this.maxPacingDelay = 0;

    // Create an AbortController for interrupting pacing delays. HAP's signal handles stream closure, but we also need to abort when a livestream discontinuity is
    // detected so we can restart FFmpeg without waiting for the current pacing delay to expire.
    this.abortController = new AbortController();

    let combinedSignal = AbortSignal.any([ signal, this.abortController.signal ]);

    // Listen for lifecycle events from the timeshift buffer:
    //
    //   - "discontinuity": the underlying livestream dropped and recovered with a clean keyframe. Non-terminal...we stop FFmpeg and the outer do-while loop
    //     restarts it with post-reconnect data.
    //   - "terminated": the subscription died out-of-band (e.g., SubscriberLagError). Terminal...we stop FFmpeg and exit the event. The timeshift has already
    //     self-cleaned its state, so there is no subscription to recover onto.
    //
    // Both handlers call ffmpegStream.stop(false) and abort the combined signal to interrupt any in-flight pacing delay. The discriminator between "restart the
    // loop" and "exit the loop" is which local flag the handler sets...the outer do-while's condition gates on isDiscontinuity, not isTerminated.
    let isDiscontinuity = false;
    let isTerminated = false;

    const discontinuityListener = (): void => {

      if(this.protectCamera.hasFeature("Debug.Video.HKSV.Telemetry")) {

        this.log.warn("Livestream discontinuity detected during recording event %s. Restarting FFmpeg with clean data.", this.eventId.toString());
      }

      isDiscontinuity = true;
      this.ffmpegStream?.stop(false);
      this.abortController?.abort();
    };

    const terminatedListener = (): void => {

      // Suppress the "unexpected teardown" warn when the NVR is in an induced-disruption phase (rebooting, shutting down). The recording is ending because the
      // plugin is intentionally tearing down, not because something went wrong - the operator already saw the NVR-level message that explains it.
      if((this.protectCamera.nvr.phase === "running") && this.protectCamera.hasFeature("Debug.Video.HKSV.Telemetry")) {

        this.log.warn("Timeshift subscription terminated during recording event %s. Ending HKSV recording.", this.eventId.toString());
      }

      isTerminated = true;
      this.ffmpegStream?.stop(false);
      this.abortController?.abort();
    };

    this.timeshift.on("discontinuity", discontinuityListener);
    this.timeshift.on("terminated", terminatedListener);

    // Outer loop to handle FFmpeg restarts on livestream discontinuity. Under normal operation this executes once. When a discontinuity is detected, we stop the current
    // FFmpeg instance and restart it with clean data from the timeshift buffer, preserving the recording session across the livestream reconnection. The try/finally
    // ensures both event listeners are removed even if the generator throws during a yield or await.
    try {

      do {

        // If this is a discontinuity restart, reinitialize FFmpeg. The timeshift buffer has already accumulated fresh post-reconnection data starting from a keyframe, so
        // startTransmitting will create a new FFmpeg instance with keyframe-aligned input.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- isDiscontinuity is mutated asynchronously by the discontinuity event listener.
        if(isDiscontinuity) {

          isDiscontinuity = false;
          this.abortController = new AbortController();
          combinedSignal = AbortSignal.any([ signal, this.abortController.signal ]);

          this.timeshift.transmitStop();

          if(!this.startTransmitting(true)) {

            if(this.protectCamera.hasFeature("Debug.Video.HKSV.Telemetry")) {

              this.log.warn("Discontinuity recovery failed for recording event %s. Unable to restart FFmpeg.", this.eventId.toString());
            }

            // Recovery failed. Route through the terminated exit path so HAP gets a clean isLast=true marker rather than a silent generator return...the
            // downstream semantics are identical ("this recording event is ending abnormally") regardless of whether the subscription fired `terminated` or
            // the recovery attempt itself failed.
            isTerminated = true;

            break;
          }

          if(this.protectCamera.hasFeature("Debug.Video.HKSV.Telemetry")) {

            this.log.warn("Discontinuity recovery succeeded for recording event %s. Resuming HKSV recording.", this.eventId.toString());
          }
        }

        // Process our FFmpeg-generated segments and send them back to HKSV.
        // eslint-disable-next-line no-await-in-loop -- Intentional: the outer loop handles FFmpeg restarts on discontinuity.
        for await (const segment of this.ffmpegStream.segmentGenerator()) {

          // If we've stopped transmitting, a discontinuity fired, or the recording is terminating, exit the segment loop. isDiscontinuity and isTerminated
          // are mutated asynchronously by the event listeners above.
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
          if(!this._isTransmitting || isDiscontinuity || isTerminated) {

            break;
          }

          // Keep track of how many segments we're sending to HKSV.
          this.transmittedSegments++;

          // Pace segment delivery to HomeKit relative to the last yield, then yield the segment.
          await this.paceSegmentDelivery(lastYieldTime, pacingInterval, combinedSignal);

          // If the recording stream was closed while we were waiting on our pacing schedule, we're done. We check HAP's signal directly rather than the combined signal
          // because a discontinuity abort should not prevent yielding...the current segment is valid pre-stall data that must be delivered before restarting FFmpeg.
          // `_isTransmitting` and `signal.aborted` can both mutate during the paceSegmentDelivery await above; TS flow narrows them after the earlier break check
          // and does not re-widen across the await.
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
          if(!this._isTransmitting || signal.aborted) {

            break;
          }

          // Send HKSV the fMP4 segment. The delivery time anchors the next pacing delay.
          yield { data: segment, isLast: false };

          lastYieldTime = Date.now();
        }

      // isDiscontinuity and isTerminated are mutated asynchronously by the event listeners above.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      } while(isDiscontinuity && !isTerminated && this._isTransmitting);
    } finally {

      this.timeshift.off("discontinuity", discontinuityListener);
      this.timeshift.off("terminated", terminatedListener);
    }

    // Post-loop teardown. Two exit states can require a final end-of-stream marker:
    //
    //   - isTerminated: the recording event ended abnormally - either the subscription died while we were transmitting (timeshift emitted `terminated`) or
    //     the discontinuity-recovery restart attempt failed. In both cases the timeshift is either self-cleaned or unrecoverable for this event, so there's
    //     nothing to restart...just yield a final marker so HAP sees a clean close rather than an abrupt generator end.
    //   - FFmpeg timed out: typically a Protect controller stall. Restart the timeshift's underlying connection to try to clear whatever upstream issue
    //     triggered the timeout, then yield the final marker.
    //
    // Normal completion (HAP-initiated close via signal.aborted or _isTransmitting false) falls through both branches...HAP already knows the stream is done
    // and doesn't need a marker. The optional chain on ffmpegStream is load-bearing: the discontinuity-recovery path's startTransmitting(true) call inside
    // the do/while above may have cleared the field, and TS does not track that across the method call.
    if(isTerminated) {

      yield { data: HKSV_END_OF_STREAM_MARKER, isLast: true };
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    } else if(this.ffmpegStream?.isTimedOut) {

      this.timeshift.restart();

      yield { data: HKSV_END_OF_STREAM_MARKER, isLast: true };
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

  // Reconcile the HKSV timeshift buffer against the current desired state. The single reconciliation entry point for the HKSV timeshift lifecycle, invoked from
  // any trigger that might have changed an input (recording active/inactive, configuration change, camera online/offline, controller reconnect). Safe to call
  // from any caller, any number of times, concurrently. Two invariants make this correct:
  //
  //   1. At most one reconciliation runs at a time (shared-promise serialization).
  //   2. Every request is honored. If inputs change mid-flight, a follow-up pass runs against the new inputs. The request-flag-and-loop pattern ensures no
  //      input change is silently dropped by a promise-join.
  //
  // A plain-Promise return is intentional here: it preserves the synchronous atomicity of the check-and-set on configurePromise below. An async wrapper would
  // introduce a microtask boundary that defeats that atomicity.
  // eslint-disable-next-line @typescript-eslint/promise-function-async
  public configureTimeshifting(): Promise<boolean> {

    // Flag that a reconciliation was requested. An in-flight loop observes this flag after its current iteration completes and runs another pass against the
    // latest inputs. If no loop is running, the loop below consumes the flag on its first iteration.
    this.configureRequested = true;

    // Atomic check-and-set. If a reconciliation is already in flight, return its promise and let the caller join it. The synchronous read-and-assign of
    // configurePromise cannot be interleaved with another call in single-threaded JavaScript, so exactly one reconciliation loop runs at a time.
    if(this.configurePromise) {

      return this.configurePromise;
    }

    this.configurePromise = this.runConfigureLoop().finally((): void => { this.configurePromise = undefined; });

    return this.configurePromise;
  }

  // The request-coalescing loop. Runs `runConfigureTimeshifting` in sequence while `configureRequested` is set, so any input change that fires during an
  // in-flight iteration causes another pass against the latest state. When a full iteration completes with no concurrent request, the loop exits and the
  // wrapper promise resolves.
  private async runConfigureLoop(): Promise<boolean> {

    let result = false;

    while(this.configureRequested) {

      this.configureRequested = false;
      // eslint-disable-next-line no-await-in-loop -- Intentional: each iteration reconciles against the state observed at iteration start.
      result = await this.runConfigureTimeshifting();
    }

    return result;
  }

  // The reconciliation body. Computes desired state from current inputs and brings the actual state into alignment.
  //
  // `rtspEntry` is committed to instance state only after a successful start, so external readers (ProtectStreamingDelegate, ProtectSnapshot) always see an
  // entry that actually backs a running timeshift. On stop, `rtspEntry` is cleared. The field stays coupled to `timeshift.isStarted` as a matched pair.
  private async runConfigureTimeshifting(): Promise<boolean> {

    // Desired state is "running with the correct rtspEntry" iff we have a configuration, the camera is online, and HomeKit has asked us to record. The local
    // binding of recordingConfig gives TypeScript a non-null reference to work with (instance field narrowing does not survive async boundaries).
    const recordingConfig = this.recordingConfig;
    const shouldRun = this._isRecording && (recordingConfig !== undefined) && this.protectCamera.isOnline;

    // Observability for the "user asked us to record but the camera is offline" case. isDeferredOffline is derived purely from current inputs (single source of
    // truth); comparing against the previous observation detects the transition edge so we log exactly once per offline episode. The flag is updated after the
    // check and is naturally reset by any reconcile where we are no longer deferred (e.g. recording succeeds, user disables HKSV, camera comes back online).
    const isDeferredOffline = this._isRecording && !this.protectCamera.isOnline;

    if(isDeferredOffline && !this.wasDeferredOffline) {

      this.log.warn("HomeKit Secure Video event recording is deferred until the camera is online.");
    }

    this.wasDeferredOffline = isDeferredOffline;

    if(!shouldRun) {

      // Desired state is stopped. If the timeshift is running, stop it and clear the backing rtspEntry so external readers observe the matched
      // (isStarted=false, rtspEntry=null) output state. Return value: true if "stopped" was the desired outcome (caller asked us to stop), false if the caller
      // wanted us running but prerequisites were not met.
      if(this.timeshift.isStarted) {

        this.timeshift.stop();
        this.rtspEntry = null;
      }

      return !this._isRecording;
    }

    // Compute the desired RTSP entry for the HKSV-requested resolution. Held as a local until the start succeeds, at which point it is committed to
    // this.rtspEntry. External readers must never see an entry whose start failed.
    const desiredRtspEntry = this.protectCamera.findRecordingRtsp(recordingConfig.videoCodec.resolution[0], recordingConfig.videoCodec.resolution[1]);

    if(!desiredRtspEntry) {

      this.log.error("Unable to configure HKSV event recording support: no valid RTSP stream profile was found for this camera.");

      return false;
    }

    // If the timeshift is already running on the correct channel and lens, we are already in the desired state. this.rtspEntry holds the currently-backing
    // entry, so comparing against it answers "is the running timeshift on the entry we want?".
    if(this.timeshift.isStarted && (desiredRtspEntry.channel.id === this.rtspEntry?.channel.id) &&
      ((desiredRtspEntry.lens === undefined) || (desiredRtspEntry.lens === this.rtspEntry.lens))) {

      return true;
    }

    // Bring the actual state into alignment with the desired state.
    if(!(await this.timeshift.start(desiredRtspEntry))) {

      return false;
    }

    // Commit the new backing entry now that the timeshift is actually running on it.
    this.rtspEntry = desiredRtspEntry;

    return true;
  }

  // Start transmitting to the HomeKit hub our timeshifted fMP4 stream. When isRestart is true, the buffer duration check is skipped because the buffer was recently
  // cleared by a discontinuity and only contains fresh post-reconnection data starting from a keyframe.
  private startTransmitting(isRestart = false): boolean {

    // If there's a prior instance of FFmpeg, clean up after ourselves.
    if(this.ffmpegStream) {

      this.ffmpegStream.stop(false);
      this.ffmpegStream = undefined;
    }

    // If there's a prior instance of our transmit handler, clean it up.
    this.segmentWriter?.close();
    this.segmentWriter = undefined;

    if(this.transmitListener) {

      this.timeshift.off("segment", this.transmitListener);
      this.transmitListener = undefined;
    }

    if(!this.protectCamera.stream) {

      return false;
    }

    // If we don't have a recording configuration from HomeKit, a valid RTSP profile, or not enough time in our timeshift buffer, we can't continue. On a discontinuity
    // restart, we skip the buffer duration check because the buffer was recently cleared and only contains fresh post-reconnection data.
    if(!this.recordingConfig || !this.rtspEntry || this.timeshift.isRestarting ||
      (!isRestart && (this.timeshift.time < this.timeshift.configuredDuration))) {

      return false;
    }

    // So how do we feed HKSV what it's looking for and how does timeshifting work in practice?
    //
    // We want to keep feeding HomeKit until it tells us it's finished, or we decide we don't want to send anymore fMP4 packets. We treat this in a similar way to how a
    // DVR works where you can pause live television, but it continues to buffer what's being broadcast until you're ready to watch it. This is the same idea. Segment
    // counters accumulate across the full recording session for telemetry...pacing lives in handleRecordingStreamRequest and doesn't care about FFmpeg's lifecycle.

    // Find the nearest keyframe at or before the prebuffer start point. By starting FFmpeg's input from a keyframe boundary, the decoder initializes cleanly rather than
    // having to recover from mid-GOP data. The seek offset tells FFmpeg's -ss exactly how far to advance from the keyframe to the prebuffer start point.
    const alignment = this.timeshift.getKeyframeAlignedStart(this.recordingConfig.prebufferLength);

    // Start a new FFmpeg instance to transcode using HomeKit's requirements.
    this.ffmpegStream = new FfmpegRecordingProcess(this.protectCamera.stream.ffmpegOptions, this.recordingConfig, {

      // The Protect livestream API delivers audio at 16000 Hz (16-bit mono AAC). This is the input sample rate that FFmpeg's audio filters operate on.
      audioFilters: this.protectCamera.getAudioFilters(16000),
      audioStream: 0,
      codec: this.protectCamera.ufp.videoCodec,
      enableAudio: this.isAudioActive,
      fps: this.rtspEntry.channel.fps,
      timeshift: alignment?.seekOffsetMs ?? Math.max(this.timeshift.time - this.recordingConfig.prebufferLength, 0),
      transcodeAudio: false
    }, this.protectCamera.hasFeature("Debug.Video.HKSV"));

    this.ffmpegStream.start();
    this._isTransmitting = true;

    // Feed segments to FFmpeg with backpressure handling...if FFmpeg can't keep up, segments are queued and written when it's ready.
    this.segmentWriter = new BackpressureWriter(() => this.ffmpegStream?.stdin ?? null, () => this.timeshiftedSegments++);

    // Listen in for events from the timeshift buffer and feed FFmpeg.
    this.timeshift.on("segment", this.transmitListener = (segment: Buffer): void => { this.segmentWriter?.write(segment); });

    // Check to make sure something didn't go wrong when we start transmitting the stream. If there is, we're resetting our connectivity to the Protect controller.
    if(!this.timeshift.transmitStart(alignment?.startIndex)) {

      // Stop our FFmpeg process and our timeshift buffer.
      this.segmentWriter.close();
      this.ffmpegStream.stop();
      this.timeshift.stop();
      this.timeshift.off("segment", this.transmitListener);

      // Ensure we cleanup.
      this.ffmpegStream = undefined;
      this.segmentWriter = undefined;
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

  // Wait until the pacing interval has elapsed since the last segment was yielded to HomeKit. HomeKit resets its timeout each time it receives a segment, so the
  // only constraint is the interval since the last delivery, not an absolute schedule. The sleep is abortable via the combined signal so that either an HKSV stream
  // closure or a livestream discontinuity can interrupt it immediately. Pacing delay metrics are tracked for telemetry.
  private async paceSegmentDelivery(lastYieldTime: number, pacingInterval: number, signal: AbortSignal): Promise<void> {

    this.lastPacingDelay = (lastYieldTime + pacingInterval) - Date.now();
    this.maxPacingDelay = Math.max(this.maxPacingDelay, this.lastPacingDelay);

    if(this.lastPacingDelay > 0) {

      await delay(this.lastPacingDelay, undefined, { signal }).catch((): void => { /* Expected on stream close or discontinuity. */ });
    }
  }

  // Stop transmitting the HomeKit hub our timeshifted fMP4 stream.
  private stopTransmitting(reason?: HDSProtocolSpecificErrorReason): void {

    // Guard against being called multiple times for the same recording event. This can occur when HAP-nodejs processes multiple close-related messages
    // from the same TCP chunk, each independently triggering closeRecordingStream.
    if(!this._isTransmitting) {

      return;
    }

    // We're done transmitting, so we can go back to maintaining our timeshift buffer for HomeKit.
    this.timeshift.transmitStop();

    // Kill any FFmpeg sessions, capturing process state before we clear the reference.
    const ffmpegEnded = this.ffmpegStream?.isEnded ?? true;
    const ffmpegStderrLog = this.ffmpegStream?.stderrLog ?? [];
    const ffmpegTimedOut = this.ffmpegStream?.isTimedOut ?? false;

    if(this.ffmpegStream) {

      this.ffmpegStream.stop((((reason !== undefined) && (reason !== HDSProtocolSpecificErrorReason.NORMAL)) || this.timeshift.isRestarting) ? false : undefined);
      this.ffmpegStream = undefined;
    }

    this._isTransmitting = false;

    this.segmentWriter?.close();
    this.segmentWriter = undefined;

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
    if(!this.protectCamera.stream || this.recordingDeclined) {

      return;
    }

    // We actually have one less segment than we think we do since we counted the fMP4 stream header as well, which shouldn't count toward our total of transmitted video
    // segments.
    this.timeshiftedSegments = Math.max(--this.timeshiftedSegments, 0);
    this.transmittedSegments = Math.max(--this.transmittedSegments, 0);

    // Inform the user if we've recorded something.
    if(!this.accessory.context.hksvRecordingDisabled && this.timeshiftedSegments && this.transmittedSegments && this.rtspEntry) {

      // Calculate approximately how many seconds we've recorded. We have more accuracy in timeshifted segments, so we'll use the more accurate statistics when we can.
      const recordedSeconds = (this.timeshiftedSegments * this.timeshift.segmentLength) / 1000;

      let recordedTime;
      let timeUnit;

      // Format the duration for the user...we show raw seconds for sub-second durations, rounded seconds for short events, and a clock-style format for longer ones.
      if(recordedSeconds < 1) {

        recordedTime = recordedSeconds.toString();
        timeUnit = "second";
      } else if(recordedSeconds < 60) {

        recordedTime = Math.round(recordedSeconds).toString();
        timeUnit = "second";
      } else {

        const hours = Math.floor(recordedSeconds / 3600);
        const minutes = Math.floor((recordedSeconds % 3600) / 60);
        const seconds = Math.floor(recordedSeconds % 60);

        if(hours > 0) {

          recordedTime = hours.toString().padStart(2, "0") + ":" + minutes.toString().padStart(2, "0") + ":" + seconds.toString().padStart(2, "0");
          timeUnit = "hour";
        } else {

          recordedTime = minutes.toString() + ":" + seconds.toString().padStart(2, "0");
          timeUnit = "minute";
        }
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

    // Inform the user when things stopped unexpectedly, accounting for known factors like the camera being online, the timeshift buffer restarting, or the NVR
    // being in an induced-disruption phase (rebooting, shutting down). We suppress errors for sub-100ms durations...these are HomeKit protocol-level events
    // where the recording stream is opened and immediately closed before we can respond, and are not actionable.
    const recordingDuration = Date.now() - this.pacingStartTime;

    if((reason !== undefined) && (reason !== HDSProtocolSpecificErrorReason.NORMAL) && (recordingDuration >= 100) &&
      !this.timeshift.isRestarting && this.protectCamera.isOnline && (this.protectCamera.nvr.phase === "running") &&
      (this.timeshift.time >= (this.recordingConfig?.prebufferLength ?? 0))) {

      const telemetry = this.protectCamera.hasFeature("Debug.Video.HKSV.Telemetry") ?
        " (event: " + this.eventId.toString() + ", stream: " + this.lastStreamId.toString() +
        ", duration: " + (recordingDuration / 1000).toFixed(3) +
        "s, segments yielded: " + this.transmittedSegments.toString() + ", segments to FFmpeg: " + this.timeshiftedSegments.toString() +
        ", FFmpeg ended: " + ffmpegEnded.toString() + ", FFmpeg timeout: " + ffmpegTimedOut.toString() +
        ", pacing delay: " + Math.round(this.lastPacingDelay).toString() +
        "/" + Math.round(this.maxPacingDelay).toString() + "ms last/peak)" : "";

      this.log.error("HKSV recording event ended early: %s%s", reasonDescription, telemetry);

      // Dump FFmpeg's stderr output for post-mortem analysis. This is gated behind the telemetry feature flag to avoid log noise for normal users.
      if(this.protectCamera.hasFeature("Debug.Video.HKSV.Telemetry") && ffmpegStderrLog.length) {

        for(const line of ffmpegStderrLog) {

          this.log.error("FFmpeg: %s", line);
        }
      }
    }
  }

  // Return whether the user has audio enabled or disabled for recordings.
  public get isAudioActive(): boolean {

    return this.protectCamera.ufp.featureFlags.hasMic && this.protectCamera.hasFeature("Audio") &&
      (this.protectCamera.stream?.controller.recordingManagement?.recordingManagementService
        .getCharacteristic(this.api.hap.Characteristic.RecordingAudioActive).value === 1);
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
