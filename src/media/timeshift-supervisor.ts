/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * timeshift-supervisor.ts: UniFi Protect timeshift buffer supervisor - the lifecycle authority for a camera's standing timeshift buffer.
 */
import type { CameraRecordingConfiguration } from "homebridge";
import type { HomebridgePluginLogging } from "homebridge-plugin-utils";
import { PROTECT_TIMESHIFT_BUFFER_MAXDURATION } from "../settings.ts";
import type { ProtectCameraHost } from "./camera-host.ts";
import { ProtectTimeshiftBuffer } from "./timeshift.ts";
import { formatBps } from "homebridge-plugin-utils";
import { isInducedDisruption } from "../nvr/nvr-policy.ts";

// Lightning-bolt emoji (U+26A1 HIGH VOLTAGE SIGN + U+FE0F VARIATION SELECTOR-16) used to prefix the HKSV configuration log when the host supports
// hardware-accelerated transcoding.
const HKSV_HARDWARE_TRANSCODE_MARKER = "\u26A1\uFE0F ";

// The recording demand the HKSV recording delegate pushes into the supervisor: the recording configuration HomeKit has selected (undefined when HomeKit cannot
// produce one, which the reconciler treats as "desired state is stopped") and whether HomeKit wants recording active.
export interface RecordingDemand {

  config: CameraRecordingConfiguration | undefined;
  isRecording: boolean;
}

/* UniFi Protect timeshift buffer supervisor.
 *
 * The supervisor owns the standing timeshift buffer's lifecycle: it constructs and holds the buffer, reconciles the buffer's running state against its demand arms -
 * buffer-backed livestreaming (the camera's live-view toggle) and HomeKit Secure Video recording - together with the camera's live reachability, narrates the
 * deferral / resumption / acknowledgment story of that reconciliation, and carries the terminal shutdown latch the controller-disconnect and camera-teardown paths
 * arm. The buffer runs whenever either arm demands it, so the same pooled socket feeds live views, HomeKit Secure Video, and snapshots under one quality policy. The
 * streaming delegate constructs one supervisor per livestream-capable camera, before the recording delegate that may consume it - a recording delegate cannot exist
 * without its supervisor, so buffer supervision has exactly one owner and one construction path.
 */
export class ProtectTimeshiftSupervisor {

  public readonly buffer: ProtectTimeshiftBuffer;
  private configurePromise?: Promise<boolean>;
  private configureRequested: boolean;
  // The pushed recording demand - the supervisor's input register, not a second source of truth. The recording delegate's _isRecording and recordingConfig fields
  // remain the single sources of truth for HAP intent; every mutation there pushes a fresh demand here through setRecordingDemand, so this register always mirrors
  // the delegate's state and the reconciler reads its inputs without reaching back into the delegate.
  private demand: RecordingDemand;
  private hasAcknowledgedRecording: boolean;
  // The once-per-episode latch for the "no valid stream profile" selection failure. Under the streaming arm the reconcile is kicked frequently (activation,
  // availability, and snapshot wakes), so an unresolvable selection would otherwise re-log on every kick. The latch suppresses repeats; it clears on a successful
  // selection and on any pushed demand change, so a genuine change re-arms the report.
  private hasReportedSelectionFailure: boolean;
  // The terminal shutdown latch. Once armed, no reconcile pass can start the buffer again; a torn-down camera constructs a fresh, unlatched supervisor if it is
  // ever rebuilt.
  private isShutdown: boolean;
  private readonly log: HomebridgePluginLogging;
  private readonly protectCamera: ProtectCameraHost;
  private wasDeferredOffline: boolean;
  // The captured induced-origin of the current deferral episode. The deferral edge fires while the camera is offline (during an induced reboot the phase reads
  // "rebooting"), but the resolution - logged later at the successful-start path, after the phase has already returned to "running" - can no longer read the phase
  // reliably, so it consults what the deferral edge recorded here. Reset on the resolution (the episode closed) and on the disable demand edge (the episode ended).
  private wasDeferredWhileInduced: boolean;

  // Create an instance of the timeshift buffer supervisor.
  constructor(protectCamera: ProtectCameraHost) {

    this.buffer = new ProtectTimeshiftBuffer(protectCamera);
    this.configureRequested = false;
    this.demand = { config: undefined, isRecording: false };
    this.hasAcknowledgedRecording = false;
    this.hasReportedSelectionFailure = false;
    this.isShutdown = false;
    this.log = protectCamera.log;
    this.protectCamera = protectCamera;
    this.wasDeferredOffline = false;
    this.wasDeferredWhileInduced = false;

    // Re-establish the buffer immediately when it stops for a recoverable reason (a codec-change restart or an unexpected out-of-band death) - the availability edge
    // that a deliberate teardown rides is not guaranteed to fire for these. A "giveUp" is left alone: the recovery policy's exhaustion is resolved by the availability
    // edge and self-heal's reboot bounce, not by re-arming into a tight loop. The subscription is supervisor-lifetime; the shutdown latch is the only guard it needs.
    this.buffer.on("stopped", (cause): void => {

      if((cause === "ended") && !this.isShutdown) {

        void this.reconcile();
      }
    });
  }

  // Push an updated recording demand and reconcile against it. The demand write and the per-episode resets are synchronous, so they land at the demand edge itself
  // rather than inside a coalesced reconcile pass - a disable-then-enable flap that collapses into a single reconcile loop still closes the old enable episode
  // here, on the disable edge, and the subsequent enable re-acknowledges exactly once. Returns the reconcile promise so a caller can await the pass this demand
  // triggered.
  public setRecordingDemand(demand: RecordingDemand): Promise<boolean> {

    if(this.demand.isRecording && !demand.isRecording) {

      // Disabling ends the current enable episode, so clear the acknowledgment flag. The next enable then re-acknowledges its configuration through the reconcile's
      // successful-start path, restoring the per-enable symmetry with the delegate's disable log.
      this.hasAcknowledgedRecording = false;

      // Disabling also ends any in-flight deferral episode, so drop the captured deferral-origin. Otherwise a later re-enable could inherit a stale level and announce
      // its resolution at the wrong verbosity. This keeps the field symmetric with hasAcknowledgedRecording, which is reset here for the same reason.
      this.wasDeferredWhileInduced = false;
    }

    // A pushed demand change is a genuine state change, so re-arm the selection-failure report: if the buffer still cannot find a valid profile after the change, the
    // user should hear about it once more.
    this.hasReportedSelectionFailure = false;

    this.demand = { config: demand.config, isRecording: demand.isRecording };

    return this.reconcile();
  }

  // Reconcile the timeshift buffer against the current desired state. The single reconciliation entry point for the timeshift lifecycle, invoked from any trigger
  // that might have changed an input (a recording demand push, camera online/offline, controller reconnect). Safe to call from any caller, any number of times,
  // concurrently. Two invariants make this correct:
  //
  //   1. At most one reconciliation runs at a time (shared-promise serialization).
  //   2. Every request is honored. If inputs change mid-flight, a follow-up pass runs against the new inputs. The request-flag-and-loop pattern ensures no
  //      input change is silently dropped by a promise-join.
  //
  // A plain-Promise return is intentional here: it preserves the synchronous atomicity of the check-and-set on configurePromise below. An async wrapper would
  // introduce a microtask boundary that defeats that atomicity.
  public reconcile(): Promise<boolean> {

    // Flag that a reconciliation was requested. An in-flight loop observes this flag after its current iteration completes and runs another pass against the
    // latest inputs. If no loop is running, the loop below consumes the flag on its first iteration.
    this.configureRequested = true;

    // Atomic check-and-set. If a reconciliation is already in flight, return its promise and let the caller join it. The synchronous read-and-assign of
    // configurePromise cannot be interleaved with another call in single-threaded JavaScript, so exactly one reconciliation loop runs at a time.
    if(this.configurePromise) {

      return this.configurePromise;
    }

    this.configurePromise = this.runReconcileLoop().finally((): void => { this.configurePromise = undefined; });

    return this.configurePromise;
  }

  // The request-coalescing loop. Runs `runReconcilePass` in sequence while `configureRequested` is set, so any input change that fires during an in-flight
  // iteration causes another pass against the latest state. When a full iteration completes with no concurrent request, the loop exits and the wrapper promise
  // resolves.
  private async runReconcileLoop(): Promise<boolean> {

    let result = false;

    while(this.configureRequested) {

      this.configureRequested = false;
      // eslint-disable-next-line no-await-in-loop -- Intentional: each iteration reconciles against the state observed at iteration start.
      result = await this.runReconcilePass();
    }

    return result;
  }

  // The reconciliation body. Computes desired state from current inputs and brings the actual state into alignment.
  //
  // The channel profile lives on the buffer as a matched pair with its subscription: the buffer commits it only when a start actually succeeds and clears it on
  // every teardown path, so external readers (ProtectStreamingDelegate, ProtectSnapshot) always see an entry that actually backs a running timeshift.
  private async runReconcilePass(): Promise<boolean> {

    // The buffer runs when either arm demands it. The streaming arm is a live read of the camera's buffer-backed-livestreaming capability; the recording arm needs
    // both an active HomeKit request and a configuration to record with. Desired state is "running with the correct channel profile" iff either arm demands it, the
    // camera is online, the shutdown latch is unarmed, and the controller is not shutting down. The local binding of the demanded configuration gives TypeScript a
    // stable reference (instance-field narrowing does not survive async boundaries).
    const streamingDemand = this.protectCamera.usesTimeshiftLivestream;
    const recordingConfig = this.demand.config;
    const recordingDemand = this.demand.isRecording && (recordingConfig !== undefined);
    const shouldRun = (streamingDemand || recordingDemand) && this.protectCamera.isReachable && !this.isShutdown && (this.protectCamera.nvr.phase !== "shuttingDown");

    // Observability for the "user asked us to record but the camera is offline" case. Only the recording arm defers loudly; a streaming-only camera going offline is
    // already covered by the controller/camera narration, so its deferral is silent (this block stays gated on the recording request). isDeferredOffline is derived
    // purely from current inputs; comparing against the previous observation detects the transition edge so we log exactly once per offline episode. The flag is
    // updated after the check and is naturally reset by any reconcile where we are no longer deferred.
    const isDeferredOffline = this.demand.isRecording && !this.protectCamera.isReachable;

    // Capture whether we were deferred-offline coming into this reconcile, before the update below clears it. The resumption close consults this to announce a genuine
    // resumption: the camera-back-online edge alone over-claims, since a reachable camera may still fail to start, have no configuration, or have been disabled in the
    // gap.
    const wasDeferred = this.wasDeferredOffline;

    if(isDeferredOffline && !this.wasDeferredOffline) {

      // The camera went offline while HomeKit asked us to record. Capture whether this is a disruption we induced (our own reboot/shutdown) so the resolution - logged
      // later when recording actually re-establishes, after the phase has returned to running - gates the same way. An induced disruption is expected (the
      // controller-level narration already covers it) and logs at debug; an organic single-camera offline is a genuine "we wanted to record but cannot" signal and stays
      // at warn.
      this.wasDeferredWhileInduced = isInducedDisruption(this.protectCamera.nvr.phase);

      if(this.wasDeferredWhileInduced) {

        this.log.debug("HomeKit Secure Video event recording is deferred until the camera is online.");
      } else {

        this.log.warn("HomeKit Secure Video event recording is deferred until the camera is online.");
      }
    }

    this.wasDeferredOffline = isDeferredOffline;

    if(!shouldRun) {

      // Desired state is stopped. If the timeshift is running, stop it; the buffer clears its backing channel profile inside the same synchronous stop, so external
      // readers observe the matched (isStarted=false, channelProfile=null) output state. Return value: true if "stopped" was the desired outcome (caller asked us to
      // stop), false if the caller wanted us running but prerequisites were not met.
      if(this.buffer.isStarted) {

        this.buffer.stop();
        this.log.debug("Timeshift buffer stopped.");
      }

      return !this.demand.isRecording;
    }

    // Compute the substrate channel that populates the buffer. Selection is HKSV-state-independent by construction: the demanded resolution is not a selection input, so
    // the same channel backs the buffer whichever arm asked for it. The buffer commits the entry as its backing channel profile only when the start succeeds, so
    // external readers never see an entry whose start failed.
    const desiredRtspEntry = this.protectCamera.selectSubstrateChannel();

    if(!desiredRtspEntry) {

      // Report the selection failure once per episode. Under the streaming arm the reconcile is kicked frequently, so an unresolvable selection would otherwise repeat
      // on every kick; the latch clears on a successful selection below and on any pushed demand change.
      if(!this.hasReportedSelectionFailure) {

        this.hasReportedSelectionFailure = true;
        this.log.error("Unable to start the timeshift buffer: no valid video stream profile was found for this camera.");
      }

      return false;
    }

    // A valid selection clears the once-per-episode failure latch, so a later failure reports afresh.
    this.hasReportedSelectionFailure = false;

    // If the timeshift is already running on the correct channel and lens, it is already in the desired state - the common case under the standing buffer, where an
    // enabling recording arm finds the streaming arm's buffer already up. The buffer's channelProfile holds the currently-backing entry, so comparing against it
    // answers "is the running timeshift on the entry we want?". The local binding gives TypeScript a stable reference through the compound comparison.
    const runningProfile = this.buffer.channelProfile;
    const alreadyRunning = this.buffer.isStarted && (desiredRtspEntry.channel.id === runningProfile?.channel.id) &&
      ((desiredRtspEntry.lens === undefined) || (desiredRtspEntry.lens === runningProfile.lens));

    if(!alreadyRunning) {

      // Bring the actual state into alignment. Size the buffer immediately before every start - the supervisor is the single source of truth for the buffer depth, so a
      // config-less start can never leave the wart of a minimal one-segment buffer. A successful start commits desiredRtspEntry as the buffer's backing channel profile.
      this.buffer.configuredDuration = PROTECT_TIMESHIFT_BUFFER_MAXDURATION;

      if(!(await this.buffer.start(desiredRtspEntry))) {

        return false;
      }

      // A streaming-arm-only start narrates its lifecycle at debug; a start that also satisfies a recording request is announced by the HKSV acknowledgment below.
      if(!recordingDemand) {

        this.log.debug("Timeshift buffer started for livestreaming.");
      }
    }

    // The buffer is now running on the desired channel, whether it was already up or freshly started. Both the resumption close and the acknowledgment run here so the
    // standing-buffer common case (an enabling recording arm finding the buffer already running) narrates identically to a fresh start.
    //
    // A recording that had been deferred-offline has now actually re-established. Close the story the deferral opened, at the level its origin warranted. wasDeferred
    // can only be true under a recording request, so this is inherently HKSV narration; the guard is explicit rather than inherited from a fresh-start-only structure.
    if(wasDeferred) {

      if(this.wasDeferredWhileInduced) {

        this.log.debug("HomeKit Secure Video event recording has started now that the camera is online.");
      } else {

        this.log.warn("HomeKit Secure Video event recording has started now that the camera is online.");
      }

      this.wasDeferredWhileInduced = false;
    }

    // Acknowledge the HKSV recording configuration once per enable episode, now that the timeshift is actually running - and only for the recording arm, since a
    // streaming-only start must never emit HKSV narration. The demanded config is bound to a local so the bitrate read narrows cleanly; under the OR the field is no
    // longer narrowed by shouldRun alone. The flag is reset only on the disable demand edge, so a mid-episode offline blip does not re-acknowledge on its return.
    const acknowledgeConfig = recordingDemand ? recordingConfig : undefined;

    if(acknowledgeConfig && !this.hasAcknowledgedRecording) {

      this.hasAcknowledgedRecording = true;
      this.log.info("HKSV: %s%s [%s], %s.",
        (this.protectCamera.hints.hardwareTranscoding && (this.protectCamera.platform.codecSupport.hostSystem !== "raspbian")) ? HKSV_HARDWARE_TRANSCODE_MARKER : "",
        desiredRtspEntry.name, this.protectCamera.videoCodecName, formatBps(acknowledgeConfig.videoCodec.parameters.bitRate * 1000));
    }

    // Return value contract for the recording arm's callers (updateRecordingActive reads it as an early-return gate): on the running path a live recording request
    // returns true, while a request with no recording demand (a streaming-only run, or the {isRecording true, config undefined} cell) returns !this.demand.isRecording,
    // matching the stopped path's return for that same cell so a caller reads one consistent result whichever path ran.
    return recordingDemand ? true : !this.demand.isRecording;
  }

  // Shut buffer supervision down for good - the terminal teardown the controller-disconnect and camera-removal paths call. Arms the latch so no subsequent or
  // in-flight reconcile pass can start the buffer again, then stops the buffer synchronously - the disconnect path's hard ordering invariant: the buffer's pool
  // subscription is released before the unifi-protect client is disposed. Produces no narration of its own: the paths that call this have already narrated the
  // disruption at the controller or camera level. Terminal per instance by design - a camera whose streaming delegate is ever rebuilt constructs a fresh, unlatched
  // supervisor.
  public shutdown(): void {

    this.isShutdown = true;
    this.buffer.stop();

    // Wake the coalescing loop. An in-flight pass may have been awaiting a start when the latch armed and could commit a running buffer after our stop; setting the
    // request flag guarantees the loop runs one more pass, which now observes the latch and settles on stopped. When no loop is running, the flag is simply
    // consumed by the next reconcile request.
    this.configureRequested = true;
  }
}
