/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * timeshift-supervisor.ts: UniFi Protect timeshift buffer supervisor - the lifecycle authority for a camera's standing timeshift buffer.
 */
import { formatBps, formatErrorMessage } from "homebridge-plugin-utils";
import type { CameraRecordingConfiguration } from "homebridge";
import type { HomebridgePluginLogging } from "homebridge-plugin-utils";
import { PROTECT_TIMESHIFT_BUFFER_MAXDURATION } from "../settings.ts";
import type { ProtectCameraHost } from "./camera-host.ts";
import { ProtectTimeshiftBuffer } from "./timeshift.ts";

// Lightning-bolt emoji (U+26A1 HIGH VOLTAGE SIGN + U+FE0F VARIATION SELECTOR-16) used to prefix the HKSV configuration log when this camera's HKSV recording encode
// runs on the host's hardware encoder.
const HKSV_HARDWARE_TRANSCODE_MARKER = "\u26A1\uFE0F ";

// The recording demand the HKSV recording delegate pushes into the supervisor: the recording configuration HomeKit has selected (undefined when HomeKit cannot
// produce one, which the reconciler treats as "desired state is stopped") and whether HomeKit wants recording active.
export interface RecordingDemand {

  config: CameraRecordingConfiguration | undefined;
  isRecording: boolean;
}

// The camera's current recording-deferral episode: "none" when no resolution narration is owed, and otherwise the origin captured at the moment the deferral opened.
// An "expected" origin is a disruption the controller told us to expect - one the plugin induced, or one inside the settling tail of a reboot it observed - while an
// "organic" origin is this one camera unexpectedly going away. The resolution fires much later - on the pass that finally re-establishes, by which time the
// controller's phase has typically returned to running - so it cannot classify for itself. The single value therefore answers both questions the narration asks:
// whether a resolution is owed (any origin at all) and which level it narrates at (which origin).
type DeferralEpisode = "expected" | "none" | "organic";

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
  // The deferral episode in flight. Opened when the deferral edge fires and closed only when the resolution actually narrates (recording has re-established) or the
  // episode is explicitly ended (recording disabled) - it PERSISTS in between, never re-derived from live inputs, so a failed first post-online start cannot cost the
  // later successful start its resumption narration. That persistence is why the edge-detect input below (wasDeferredOffline) stays a separate per-pass rolling
  // comparison: a pass that clears the input because the camera came back must never be able to drop a resolution the episode still owes.
  private deferralEpisode: DeferralEpisode;
  // The pushed recording demand - the supervisor's input register, not a second source of truth. The recording delegate's _isRecording and recordingConfig fields
  // remain the single sources of truth for HAP intent; every mutation there pushes a fresh demand here through setRecordingDemand, so this register always mirrors
  // the delegate's state and the reconciler reads its inputs without reaching back into the delegate.
  private demand: RecordingDemand;
  // Whether the current recording episode has already logged its HKSV configuration acknowledgment; reset on the disable edge so the next enable re-acknowledges.
  private hasAcknowledgedRecording: boolean;
  // The once-per-episode latch for the "no valid stream profile" selection failure. Under the streaming arm the reconcile is kicked frequently (activation,
  // availability, and the live-view stream-source kick), so an unresolvable selection would otherwise re-log on every kick. The latch suppresses repeats; it clears
  // on a successful selection and on any pushed demand change, so a genuine change re-arms the report.
  private hasReportedSelectionFailure: boolean;
  // The terminal shutdown latch. Once armed, no reconcile pass can start the buffer again; a torn-down camera constructs a fresh, unlatched supervisor if it is
  // ever rebuilt.
  private isShutdown: boolean;
  private readonly log: HomebridgePluginLogging;
  private readonly protectCamera: ProtectCameraHost;
  // The camera's deferred-offline state observed on the previous pass - the edge-detect input alone. isDeferredOffline (recording requested while the camera is
  // unreachable) is compared against this to detect the deferral-OPEN edge, and it is re-derived from live inputs every pass. Whether an opened deferral still owes its
  // resolution narration is the separate, persistent concern the deferral episode above carries, for the reason stated there.
  private wasDeferredOffline: boolean;

  // Create an instance of the timeshift buffer supervisor.
  constructor(protectCamera: ProtectCameraHost) {

    this.buffer = new ProtectTimeshiftBuffer(protectCamera, { isStartStale: (): boolean => this.isShutdown });
    this.configureRequested = false;
    this.deferralEpisode = "none";
    this.demand = { config: undefined, isRecording: false };
    this.hasAcknowledgedRecording = false;
    this.hasReportedSelectionFailure = false;
    this.isShutdown = false;
    this.log = protectCamera.log;
    this.protectCamera = protectCamera;
    this.wasDeferredOffline = false;

    // Re-establish the buffer immediately when it stops for a recoverable reason (a codec-change restart or an unexpected out-of-band death) - the availability edge
    // that a deliberate teardown rides is not guaranteed to fire for these. A "giveUp" is left alone: the recovery policy's exhaustion is resolved by the availability
    // edge and self-heal's reboot bounce, not by re-arming into a tight loop. The subscription is supervisor-lifetime; the shutdown latch is the only guard it needs.
    this.buffer.on("stopped", (cause): void => {

      if((cause === "ended") && !this.isShutdown) {

        void this.reconcile();
      }
    });
  }

  // Whether the deferral episode in flight still owes its resolution narration. Every read of the episode's "is anything owed" question routes through here, so the
  // comparison against the empty episode lives at exactly one site. Protected rather than private so a negative-control test can read it directly: the demand-disable
  // reset's effect is not observable through a log, whose absence is coincidentally green whether or not the reset ran.
  protected get deferralResolutionOwed(): boolean {

    return this.deferralEpisode !== "none";
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

      // Disabling also ends any deferral episode in flight, so drop the episode with the origin it captured. Otherwise a later re-enable could inherit a stale level and
      // announce a resolution the disabled episode no longer owes. This stays symmetric with hasAcknowledgedRecording, reset here for the same reason.
      this.deferralEpisode = "none";
    }

    // A pushed demand change is a genuine state change, so re-arm the selection-failure report: if the buffer still cannot find a valid profile after the change, the
    // user should hear about it once more.
    this.hasReportedSelectionFailure = false;

    this.demand = { config: demand.config, isRecording: demand.isRecording };

    return this.reconcile();
  }

  // Reconcile the timeshift buffer against the current desired state. The single reconciliation entry point for the timeshift lifecycle, invoked from any trigger
  // that might have changed an input (a recording demand push, camera online/offline, controller reconnect). Safe to call from any caller, any number of times,
  // concurrently. Two rules make this correct:
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

    this.configurePromise = this.runReconcileLoop().finally((): void => {

      this.configurePromise = undefined;

      // Exit-window coalesce: a reconcile() that landed in the microtask gap between the loop's exit and this clear saw configurePromise still truthy and joined it,
      // setting the request flag but leaving no loop to consume it. Now that the clear has run, re-check the flag and start a fresh loop if a request is pending, so no
      // input change is silently dropped by a promise-join. This is the single clear site; the re-check rides it rather than adding a second clear path. A failing pass
      // does not re-arm the flag itself, so a persistent fault cannot turn this re-entry into a tight loop - only a genuine pending request restarts the loop.
      if(this.configureRequested) {

        void this.reconcile();
      }
    });

    return this.configurePromise;
  }

  // The request-coalescing loop. Runs `runReconcilePass` in sequence while `configureRequested` is set, so any input change that fires during an in-flight
  // iteration causes another pass against the latest state. When a full iteration completes with no concurrent request, the loop exits and the wrapper promise
  // resolves.
  private async runReconcileLoop(): Promise<boolean> {

    let result = false;

    while(this.configureRequested) {

      this.configureRequested = false;

      try {

        // eslint-disable-next-line no-await-in-loop -- Intentional: each iteration reconciles against the state observed at iteration start.
        result = await this.runReconcilePass();
      } catch(error) {

        // A reconcile pass threw - the buffer's start, or any other step inside the pass. This chokepoint is reached through many fire-and-forget void kicks (camera
        // availability, the buffer's own restart, the live-view stream-source kick), so an escaping rejection would float as an unhandled rejection and, worse, poison
        // the shared configurePromise every joined caller reads. We convert the throw to a false verdict - never a stale-truthy success - and log one line. We
        // deliberately do NOT re-arm the request flag ourselves: a self-set flag would, once the exit-window coalesce re-entry runs, spin a tight retry loop against a
        // persistent fault. The next organic kick re-runs the reconcile against fresh inputs, and a concurrent kick that arrived during this pass already set the flag
        // and re-runs the loop here. The pass's own bookkeeping (the deferred-offline fields) runs before any throw point inside the pass, so it is preserved. One
        // logged line per failing pass.
        result = false;
        this.log.error("The timeshift buffer could not be updated and will be retried automatically: %s.", formatErrorMessage(error));
      }
    }

    // Test sequencing hook: fires at the loop's exit, before the wrapper promise settles and its .finally clears configurePromise. Production leaves it a no-op.
    this.onReconcileLoopExit();

    return result;
  }

  // Test sequencing hook invoked at the reconcile loop's exit, before the wrapper promise settles. A no-op in production; a test subclass overrides it to land a
  // reconcile() request in the exit window - the single-microtask gap between the loop's return and the .finally that clears configurePromise - which no coarser timing
  // primitive can hit deterministically.
  protected onReconcileLoopExit(): void {

    // No-op in production.
  }

  // Invoked after every successful pass settles its buffer state and before the pass narrates - the settle window, whose real occupants are an organic death and a
  // shutdown landing after a start has committed. Each leaves the buffer stopped before the guard below reads it, which is why that guard reads the started state
  // alone. On a coalesced pass (the buffer already running) no await separates the state check from this call, so the window is real only when a fresh start preceded
  // it; firing unconditionally keeps the call site simple. A no-op in production; the test suite overrides it to land exactly-timed events inside the window, the same
  // role onReconcileLoopExit plays for the loop's exit edge.
  protected onStartSettled(): void {

    // No-op in production.
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

    if(isDeferredOffline && !this.wasDeferredOffline) {

      // The camera went offline while HomeKit asked us to record. Open the deferral episode: one write records both that its resolution narration is owed and whether the
      // controller expected this disruption, so the resolution gates the same way the deferral did. The controller root owns that classification, so this deferral and
      // the per-camera livestream narration agree on what a given blip means. An expected disruption is already covered by the controller-level narration and logs at
      // debug; an organic single-camera offline is a genuine "we wanted to record but cannot" signal and stays at warn.
      this.deferralEpisode = this.protectCamera.nvr.isDisruptionExpected ? "expected" : "organic";

      if(this.deferralEpisode === "expected") {

        this.log.debug("HomeKit Secure Video event recording is deferred until the camera is online.");
      } else {

        this.log.warn("HomeKit Secure Video event recording is deferred until the camera is online.");
      }
    }

    // Update the edge-detect input from live state. This is role 1 only: whether an opened deferral still owes its resolution lives in the persistent episode value, so
    // clearing this here (the camera came back) never drops a pending narration.
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

    // Whether this pass performed a fresh start rather than finding the buffer already running. The streaming-arm start line narrates below the liveness guard, so this
    // local carries the fact across the guard - a coalesced pass leaves it false and narrates nothing new.
    let freshlyStarted = false;

    if(!alreadyRunning) {

      // Bring the actual state into alignment. Size the buffer immediately before every start - the supervisor is the single source of truth for the buffer depth, so a
      // config-less start can never leave the wart of a minimal one-segment buffer. A successful start commits desiredRtspEntry as the buffer's backing channel profile.
      this.buffer.configuredDuration = PROTECT_TIMESHIFT_BUFFER_MAXDURATION;

      if(!(await this.buffer.start(desiredRtspEntry))) {

        return false;
      }

      freshlyStarted = true;
    }

    // The start, if one ran, has settled the buffer state. Fire the test-timing hook (a no-op in production) at the one point a test can land an event in the settle
    // window, then guard before any narration.
    this.onStartSettled();

    // Narrating now would celebrate a buffer that is already gone, so the started state gates every line below. The settle window is real - the consume loop runs
    // detached from the start commit, so a subscription can die in the microtask gap between the commit and this read, and a shutdown can land in the same gap - but
    // the buffer never stays started through it. An organic death drops the started state on its way out, and a shutdown either stops a committed buffer synchronously
    // or is observed at the buffer's own commit point, which declines the start rather than committing it; so this read covers every condemned path. A dead buffer
    // returns through the failure path and the coalescing loop's re-arm owns the retry, and the acknowledgment below never latches for an episode that never ran.
    if(!this.buffer.isStarted) {

      return false;
    }

    // A streaming-arm-only start narrates its lifecycle at debug; a start that also satisfies a recording request is announced by the HKSV acknowledgment below.
    if(freshlyStarted && !recordingDemand) {

      this.log.debug("Timeshift buffer started for livestreaming.");
    }

    // The buffer is now running on the desired channel, whether it was already up or freshly started. Both the resumption close and the acknowledgment run here so the
    // standing-buffer common case (an enabling recording arm finding the buffer already running) narrates identically to a fresh start.
    //
    // A recording that had been deferred-offline has now actually re-established. Close the story the deferral opened, at the level its captured origin warrants. This
    // consults the PERSISTENT episode value, not the per-pass edge-detect input, so a first post-online start that failed does not lose the resolution - it fires on this
    // pass, the one that finally re-established. An episode is only ever opened under a recording request, so this is inherently HKSV narration.
    if(this.deferralResolutionOwed) {

      if(this.deferralEpisode === "expected") {

        this.log.debug("HomeKit Secure Video event recording has started now that the camera is online.");
      } else {

        this.log.warn("HomeKit Secure Video event recording has started now that the camera is online.");
      }

      this.deferralEpisode = "none";
    }

    // Acknowledge the HKSV recording configuration once per enable episode, now that the timeshift is actually running - and only for the recording arm, since a
    // streaming-only start must never emit HKSV narration. The demanded config is bound to a local so the bitrate read narrows cleanly, the OR that admits the
    // streaming arm leaving shouldRun unable to narrow the field on its own.
    //
    // The gate consults the LIVE recording demand at this commit point, exactly as the resolution block above it does. A start can be suspended across its await while
    // HomeKit disables recording underneath it, and the pass-start locals still describe the demand as it stood when the pass began; announcing against them would
    // acknowledge a recording that is already over, and would latch the flag so the next genuine enable stayed silent. The config itself stays derived from those
    // locals on purpose - the configuration the buffer actually started with is the one a still-live demand is acknowledged at. The flag is otherwise cleared only on
    // the disable demand edge, so a mid-episode offline blip does not re-acknowledge on its return.
    const acknowledgeConfig = recordingDemand ? recordingConfig : undefined;

    if(acknowledgeConfig && this.demand.isRecording && !this.hasAcknowledgedRecording) {

      this.hasAcknowledgedRecording = true;
      this.log.info("HKSV: %s%s [%s], %s.",
        this.protectCamera.stream?.ffmpegOptions.hardwareEncodes("record") ? HKSV_HARDWARE_TRANSCODE_MARKER : "",
        desiredRtspEntry.name, this.protectCamera.videoCodecName, formatBps(acknowledgeConfig.videoCodec.parameters.bitRate * 1000));
    }

    // Return value contract for the recording arm's callers (updateRecordingActive reads it as an early-return gate), derived live-first to match the gate above it.
    // The caller asks how this pass answers against the demand as it stands at the commit point: a demand that has gone away by now is owed nothing and answers true,
    // which is exactly what the stopped path answers for that same cell, while a demand still live answers whether this pass actually served it (a streaming-only run,
    // and the {isRecording true, config undefined} cell, both answer false). One consistent result whichever path ran.
    return this.demand.isRecording ? recordingDemand : true;
  }

  // Shut buffer supervision down for good - the terminal teardown the controller-disconnect and camera-removal paths call. Arms the latch so no subsequent or
  // in-flight reconcile pass can start the buffer again, then stops the buffer synchronously, releasing a committed subscription's pool seat inside this call. A start
  // still mid-establishment when the latch arms cannot commit: it reads the latch at the buffer's own commit point and disposes its subscription when its establishment
  // settles, so no start ever hands a live subscription to a torn-down owner. Produces no narration of its own: the paths that call this have already narrated the
  // disruption at the controller or camera level. Terminal per instance by design - a camera whose streaming delegate is ever rebuilt constructs a fresh, unlatched
  // supervisor. A repeat call returns at the latch - a no-op by design, not by accident of ordering - so the paths that pair a delegate and supervisor teardown can
  // both run without either one tearing down twice.
  public shutdown(): void {

    if(this.isShutdown) {

      return;
    }

    this.isShutdown = true;
    this.buffer.stop();

    // Wake the coalescing loop, the cheap backstop on a terminal path. When a pass was in flight, this guarantees one further pass runs, and that pass settles a buffer
    // the stop above already stopped - or finds nothing to do at all. When no loop is running, the flag is simply consumed by the next reconcile request.
    this.configureRequested = true;
  }
}
