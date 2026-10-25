/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * timeshift-supervisor.ts: UniFi Protect timeshift buffer supervisor - the lifecycle authority for a camera's standing timeshift buffer.
 */
import { CoalescingTask, HbpuAbortError, formatBps, formatErrorMessage } from "homebridge-plugin-utils";
import type { HomebridgePluginLogging, Nullable } from "homebridge-plugin-utils";
import { RECORDING_AUDIO_STAND_IN, describeAudioFormat, recordingAdvertisementOf } from "./stream-delegate.ts";
import type { CameraRecordingConfiguration } from "homebridge";
import type { ChannelProfile } from "./resolution.ts";
import type { LivestreamAudioFormat } from "./stream-delegate.ts";
import type { LivestreamSubscription } from "./livestream.ts";
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

// Whether a candidate channel profile is the same buffer entry as another: the same channel, and the same lens when the candidate names one. The reconcile pass asks it
// of the running profile, to tell a buffer already in the desired state, and of an adopted subscription's profile, to tell whether that subscription serves the entry
// the pass wants.
function isSameEntry(candidate: ChannelProfile, other: Nullable<ChannelProfile>): boolean {

  return (candidate.channel.id === other?.channel.id) && ((candidate.lens === undefined) || (candidate.lens === other.lens));
}

/* UniFi Protect timeshift buffer supervisor.
 *
 * The supervisor owns the standing timeshift buffer's lifecycle: it constructs and holds the buffer, reconciles the buffer's running state against its demand arms -
 * buffer-backed livestreaming (the camera's live-view toggle) and HomeKit Secure Video recording - together with the camera's live reachability, narrates the
 * deferral / resumption / acknowledgment story of that reconciliation, and owns the lifetime signal whose abort, on the controller-disconnect and camera-teardown
 * paths, ends supervision for good. The buffer runs whenever either arm demands it, so the same pooled socket feeds live views, HomeKit Secure Video, and snapshots
 * under one quality policy. The streaming delegate constructs one supervisor for every camera, before the recording delegate that may consume it - a
 * recording delegate cannot exist without its supervisor, so buffer supervision has exactly one owner and one construction path.
 */
export class ProtectTimeshiftSupervisor {

  // The subscription the camera's derivation opened to read its recording audio format, with the channel profile it was opened on, held until the first reconcile pass
  // takes it. That pass hands it to the buffer when it serves the entry the pass wants and disposes it otherwise, and shutdown disposes it when no pass ever took it.
  private adopted: Nullable<{ profile: ChannelProfile; subscription: LivestreamSubscription }>;
  // The advertisement this camera's controller was built with, the recording audio format HomeKit Secure Video was told. A buffer start compares the advertisement
  // its stream would compute against it.
  private readonly advertised: LivestreamAudioFormat;
  public readonly buffer: ProtectTimeshiftBuffer;
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
  // Whether a stream whose advertisement differs from the controller's has already been narrated. A start whose stream would advertise the controller's format again
  // resets it, so each transition away from that format is said once rather than on every start.
  private hasReportedAudioFormatChange: boolean;
  // The once-per-episode latch for the "no valid stream profile" selection failure. Under the streaming arm the reconcile is kicked frequently (activation,
  // availability, and the live-view stream-source kick), so an unresolvable selection would otherwise re-log on every kick. The latch suppresses repeats; it clears
  // on a successful selection and on any pushed demand change, so a genuine change re-arms the report.
  private hasReportedSelectionFailure: boolean;
  // The supervisor's lifetime, aborted once by shutdown and never reset. Once its signal has aborted no reconcile pass can start the buffer again, and the buffer
  // holds the same signal for its livestream calls and its start's commit point. A torn-down camera constructs a fresh supervisor, with a fresh lifetime, if it is
  // ever rebuilt.
  private readonly lifetime: AbortController;
  private readonly log: HomebridgePluginLogging;
  private readonly protectCamera: ProtectCameraHost;
  private readonly task: CoalescingTask;
  // The camera's deferred-offline state observed on the previous pass - the edge-detect input alone. isDeferredOffline (recording requested while the camera is
  // unreachable) is compared against this to detect the deferral-OPEN edge, and it is re-derived from live inputs every pass. Whether an opened deferral still owes its
  // resolution narration is the separate, persistent concern the deferral episode above carries, for the reason stated there.
  private wasDeferredOffline: boolean;

  // Create an instance of the timeshift buffer supervisor. The options carry the probe subscription the buffer adopts and the recording audio format the controller
  // advertises; their default, nothing to adopt and the stand-in advertised, is the supervisor of a camera whose derivation read nothing.
  constructor(protectCamera: ProtectCameraHost, options: { adopt: Nullable<{ profile: ChannelProfile; subscription: LivestreamSubscription }>;
    advertised: LivestreamAudioFormat; } = { adopt: null, advertised: RECORDING_AUDIO_STAND_IN.format }) {

    // The lifetime is assigned first, ahead of its alphabetical place, because the buffer is constructed with its signal.
    this.lifetime = new AbortController();
    this.adopted = options.adopt;
    this.advertised = options.advertised;
    this.buffer = new ProtectTimeshiftBuffer(protectCamera, { signal: this.lifetime.signal });
    this.deferralEpisode = "none";
    this.demand = { config: undefined, isRecording: false };
    this.hasAcknowledgedRecording = false;
    this.hasReportedAudioFormatChange = false;
    this.hasReportedSelectionFailure = false;
    this.log = protectCamera.log;
    this.protectCamera = protectCamera;

    // The reconcile passes run on homebridge-plugin-utils' coalescing task, under the supervisor's own lifetime: once shutdown aborts it, the task begins no pass and
    // abandons a pass queued behind the one in flight. The task runs the guarded pass, which turns a fault into one logged line itself, so the task's own failed-pass
    // line, the one place it reads the label, never fires.
    this.task = new CoalescingTask({

      label: "timeshift reconcile",
      log: this.log,
      run: (): Promise<void> => this.runGuardedReconcilePass(),
      signal: this.lifetime.signal
    });

    this.wasDeferredOffline = false;

    // Ask for a reconcile whenever the buffer stops for a recoverable reason - a codec-change restart, an unexpected out-of-band death, or a stop the supervisor made
    // itself - because the availability edge is not guaranteed to fire for these. A "giveUp" is left alone: the recovery policy's exhaustion is resolved by the
    // availability edge and self-heal's reboot bounce, not by re-arming into a tight loop. A stop made inside a pass asks from inside that pass, which queues one further
    // pass behind it: after a restart whose new start failed, that pass is the immediate retry, and after any other stop it finds the desired state already reached. The
    // listener reads no lifetime of its own, because reconcile answers an ended lifetime itself and runs nothing, which is what the stop inside shutdown meets.
    this.buffer.on("stopped", (cause): void => {

      if(cause === "ended") {

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
  // rather than inside a coalesced reconcile pass - a disable and an enable arriving while another pass is running are served by one queued pass, so no pass
  // ever observes the disabled demand, yet the resets at the edge still close the old enable episode here, on the disable edge, and the subsequent enable
  // re-acknowledges exactly once. Returns the reconcile promise so a caller can await the pass this demand triggered.
  public setRecordingDemand(demand: RecordingDemand): Promise<void> {

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
  // concurrently. The coalescing task holds the rules that make this correct:
  //
  //   1. One pass runs at a time.
  //   2. Every request is honored. A request that arrives during a pass queues one further pass against the latest inputs, however many requests arrive, so no
  //      input change is silently dropped by joining the pass in flight.
  //
  // The returned promise never rejects, which matters because most callers discard it and a rejection would float unhandled. While the lifetime lasts, it settles
  // when the task's drain ends, after any follow-up pass a request during the pass queued. The guarded pass turns every fault into one logged line before the task
  // sees it, and a lifetime that ends mid-pass ends the drain when that pass ends. Once the lifetime is over, the task refuses a request with a rejection, so we
  // answer a resolved promise ourselves and run nothing. A plain-Promise return is intentional: the task's promise is handed back as it is, with no async wrapper,
  // so every caller of a pass in flight holds the identical promise.
  public reconcile(): Promise<void> {

    if(this.lifetime.signal.aborted) {

      return Promise.resolve();
    }

    return this.task.request();
  }

  // Run one reconcile pass with its fault converted here, the pass the coalescing task runs. A reconcile pass can throw - the buffer's start, or any other step inside
  // the pass. The reconcile is reached through many fire-and-forget void kicks (camera availability, the buffer's own restart, the live-view stream-source kick), so a
  // rejection that escaped would float as an unhandled rejection, and would reach every caller holding the promise of the pass in flight. We convert the throw to one
  // logged line, so the task never sees a fault. A pass that threw is not retried here: the next request runs a pass, and a request that arrived during this one has
  // already queued it. The pass's own bookkeeping (the deferred-offline fields) runs before any throw point inside the pass, so it is preserved.
  private async runGuardedReconcilePass(): Promise<void> {

    try {

      await this.runReconcilePass();
    } catch(error) {

      this.log.error("The timeshift buffer could not be updated and will be retried automatically: %s.", formatErrorMessage(error));
    }
  }

  /* Invoked after every successful pass settles its buffer state and before the pass narrates - the settle window, whose real occupants are an organic death and a
   * shutdown landing after a start has committed. Each leaves the buffer stopped before the guard below reads it, which is why that guard reads the started state
   * alone. On a coalesced pass (the buffer already running) no await separates the state check from this call, so the window is real only when a fresh start preceded
   * it; firing unconditionally keeps the call site simple. The test suite overrides it to land exactly-timed events inside the window.
   *
   * What it does in production is say when a restart would advertise something else, comparing the advertisement the running stream would compute against the one
   * the controller was built with. HAP froze that advertisement when the controller was built, so a stream whose format changes after a reconnect or a controller
   * firmware update keeps recording correctly - every recording transcodes its audio to the selected format - but HomeKit only learns the new format at a restart,
   * which is what the line says, once per transition away from the advertised format. A buffer that died in the settle window has no format to compare, and a camera
   * with no recording arm has nothing to narrate.
   */
  protected onStartSettled(): void {

    const current = this.buffer.audioFormat;

    if(!current || !this.protectCamera.stream?.hksv) {

      return;
    }

    const expected = recordingAdvertisementOf(current).format;
    const matches = (expected.codec === this.advertised.codec) && (expected.sampleRate === this.advertised.sampleRate) &&
      (expected.channels === this.advertised.channels);

    if(matches) {

      this.hasReportedAudioFormatChange = false;

      return;
    }

    if(this.hasReportedAudioFormatChange) {

      return;
    }

    this.hasReportedAudioFormatChange = true;
    this.log.info("This camera's livestream audio is now %s, while HomeKit Secure Video records at %s. Recordings transcode the audio to match; " +
      "restart HBUP to let HomeKit learn the new format.", describeAudioFormat(current), describeAudioFormat(this.advertised));
  }

  /* The reconcile pass the coalescing task runs, framed by the ownership of the subscription the camera's derivation handed on. The pass takes that subscription off
   * its field at its head, so exactly one pass ever decides it: the body hands it to the buffer's start when it serves the entry the pass wants, and on every other
   * outcome - no demand, a different entry, a subscription already closed, or a pass that throws - the finally disposes it, since nothing else holds it.
   */
  private async runReconcilePass(): Promise<void> {

    const adoption = { pending: this.adopted };

    this.adopted = null;

    try {

      await this.reconcileBufferState(adoption);
    } finally {

      if(adoption.pending) {

        void adoption.pending.subscription[Symbol.asyncDispose]();
      }
    }
  }

  // The reconciliation body. Computes desired state from current inputs and brings the actual state into alignment. The adoption holder carries the subscription the
  // pass took, which the body clears when it hands that subscription to the buffer's start.
  //
  // The channel profile lives on the buffer as a matched pair with its subscription: the buffer commits it only when a start actually succeeds and clears it on
  // every teardown path, so external readers (ProtectStreamingDelegate, ProtectSnapshot) always see an entry that actually backs a running timeshift.
  private async reconcileBufferState(adoption: { pending: Nullable<{ profile: ChannelProfile; subscription: LivestreamSubscription }> }): Promise<void> {

    // The buffer runs when either arm demands it. The streaming arm is a live read of the camera's buffer-backed-livestreaming capability; the recording arm needs
    // both an active HomeKit request and a configuration to record with. Desired state is "running with the correct channel profile" iff either arm demands it, the
    // camera is online, and the controller is not shutting down. The supervisor's lifetime is not a term, because no pass begins once it has ended, and a start in
    // flight when it ends is declined at the buffer's commit point or stopped by shutdown. The local binding of the demanded configuration gives TypeScript a stable
    // reference (instance-field narrowing does not survive async boundaries).
    const streamingDemand = this.protectCamera.usesTimeshiftLivestream;
    const recordingConfig = this.demand.config;
    const recordingDemand = this.demand.isRecording && (recordingConfig !== undefined);
    const shouldRun = (streamingDemand || recordingDemand) && this.protectCamera.isReachable && (this.protectCamera.nvr.phase !== "shuttingDown");

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
      // readers observe the matched (isStarted=false, channelProfile=null) output state.
      if(this.buffer.isStarted) {

        this.buffer.stop();
        this.log.debug("Timeshift buffer stopped.");
      }

      return;
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

      return;
    }

    // A valid selection clears the once-per-episode failure latch, so a later failure reports afresh.
    this.hasReportedSelectionFailure = false;

    // If the timeshift is already running on the correct channel and lens, it is already in the desired state - the common case under the standing buffer, where an
    // enabling recording arm finds the streaming arm's buffer already up. The buffer's channelProfile holds the currently-backing entry, so comparing against it
    // answers "is the running timeshift on the entry we want?".
    const alreadyRunning = this.buffer.isStarted && isSameEntry(desiredRtspEntry, this.buffer.channelProfile);

    // Whether this pass performed a fresh start rather than finding the buffer already running. The streaming-arm start line narrates below the liveness guard, so this
    // local carries the fact across the guard - a coalesced pass leaves it false and narrates nothing new.
    let freshlyStarted = false;

    if(!alreadyRunning) {

      // Bring the actual state into alignment. Size the buffer immediately before every start - the supervisor is the single source of truth for the buffer depth, so a
      // config-less start can never leave the wart of a minimal one-segment buffer. A successful start commits desiredRtspEntry as the buffer's backing channel profile.
      this.buffer.configuredDuration = PROTECT_TIMESHIFT_BUFFER_MAXDURATION;

      // The subscription the derivation handed on takes the place of a fresh one when it serves the entry we want and is still open, so the stream opened to read the
      // recording audio format is the stream the buffer runs on. Handing it to the start passes its ownership there, so the pass's frame leaves it alone.
      const adopted = adoption.pending;
      const adoptable = (adopted && isSameEntry(desiredRtspEntry, adopted.profile) && (adopted.subscription.state !== "closed")) ? adopted.subscription : undefined;

      if(adoptable) {

        adoption.pending = null;
      }

      if(!(await this.buffer.start(desiredRtspEntry, adoptable))) {

        return;
      }

      freshlyStarted = true;
    }

    // The start, if one ran, has settled the buffer state. Fire the settle hook (the audio-format comparison in production) at the one point a test can land an event
    // in the settle window, then guard before any narration.
    this.onStartSettled();

    // Narrating now would celebrate a buffer that is already gone, so the started state gates every line below. The settle window is real - the consume loop runs
    // detached from the start commit, so a subscription can die in the microtask gap between the commit and this read, and a shutdown can land in the same gap - but
    // the buffer never stays started through it. An organic death drops the started state on its way out, a shutdown stops a committed buffer synchronously, and a
    // start the buffer's commit point declined never committed at all and returned through the start's failure path above, so no buffer any of them ended reads as
    // started here. A dead buffer returns here, a buffer that died as "ended" has its retry in the pass its stopped event's request queued, and the acknowledgment
    // below never latches for an episode that never ran.
    if(!this.buffer.isStarted) {

      return;
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
  }

  // Shut buffer supervision down for good - the terminal teardown the controller-disconnect and camera-removal paths call. Aborts the lifetime so no subsequent or
  // in-flight reconcile pass can start the buffer again, then stops the buffer synchronously, releasing a committed subscription's pool seat inside this call. The
  // abort comes first because the stop emits its stopped event synchronously, and the reconcile the listener asks for must already find the lifetime over, so it
  // answers without running a pass. A pass in flight when the lifetime ends runs to its end, and the coalescing task runs no pass queued behind it. A start still
  // mid-establishment when the lifetime ends cannot commit: the abort ends the subscription that start opened, so its establishment wait usually answers false and
  // the start declines there; where that wait still answers true, the start reads the aborted signal at the buffer's own commit point and disposes its subscription.
  // So no start ever hands a live subscription to a torn-down owner. Produces no narration of its own: the paths that call this have already narrated the disruption
  // at the controller or camera level. Terminal per instance by design - a camera whose streaming delegate is ever rebuilt constructs a fresh supervisor with a fresh
  // lifetime. A repeat call returns at the aborted signal - a no-op by design, not by accident of ordering - so the paths that pair a delegate and supervisor teardown
  // can both run without either one tearing down twice.
  public shutdown(): void {

    if(this.lifetime.signal.aborted) {

      return;
    }

    this.lifetime.abort(new HbpuAbortError("shutdown"));
    this.buffer.stop();

    // A shutdown before the first pass abandons the pass queued behind it, so the subscription the derivation handed on is still held here and nothing else will ever
    // take it.
    if(this.adopted) {

      void this.adopted.subscription[Symbol.asyncDispose]();
      this.adopted = null;
    }
  }
}
