/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * nvr.ts: NVR device class for UniFi Protect.
 */
import type { API, HAP } from "homebridge";
import { APIEvent, MqttClient, formatErrorMessage, formatSeconds, loopFaultReporter, retry, sanitizeName, superviseLoop } from "homebridge-plugin-utils";
import type { Camera, HttpRequestEndPayload, LivestreamRecoveryRecoveredPayload, LivestreamRecoveryStartedPayload, ProtectLogging, ProtectNvrConfig,
  ProtectState } from "unifi-protect";
import type { HomebridgePluginLogging, Nullable } from "homebridge-plugin-utils";
import type { NvrLifecyclePayload, ReachabilityFanoutPayload } from "../diagnostics.ts";
import { PLATFORM_NAME, PLUGIN_NAME, PROTECT_NVR_CONTROLLER_DISABLED_SETTLE_DELAY, PROTECT_NVR_REBOOT_CONFIRM_GRACE_MS, PROTECT_NVR_REBOOT_DEFERRAL_MAX,
  PROTECT_NVR_REBOOT_INTERVAL, PROTECT_NVR_REBOOT_MIN_INTERVAL, PROTECT_NVR_REBOOT_RECENCY_MS, PROTECT_NVR_REMOVAL_STABILITY_WINDOW } from "../settings.ts";
import type { ProtectAccessory, ProtectAccessoryContext, ProtectDeviceConfigTypes, ProtectDeviceTypes, ProtectDevices } from "../types.ts";
import { ProtectClient, channels as protectChannels, selectAdoptedCameraIds, selectAdoptedChimeIds, selectAdoptedFobIds, selectAdoptedLightIds,
  selectAdoptedRelayIds, selectAdoptedSensorIds, selectAdoptedViewerIds } from "unifi-protect";
import { ProtectDeviceCategories, exhaustiveGuard } from "../types.ts";
import { canTransition, computeStableSince, createConnectRetryPolicy, createLivestreamEpisodeLatch, isInducedDisruption, isStabilityWindowElapsed,
  isSuccessfulRequest, isWithinRebootRecency, membershipDelta, shouldResumeFromInducedReboot } from "./nvr-policy.ts";
import { DoorbellCapability } from "../devices/cameras/doorbell.ts";
import { NvrHealth } from "./nvr-health.ts";
import { ProtectCamera } from "../devices/cameras/camera.ts";
import { ProtectCameraPackage } from "../devices/cameras/camera-package.ts";
import { ProtectChime } from "../devices/chime.ts";
import type { ProtectDevice } from "../devices/device.ts";
import { ProtectEventDispatch } from "./event-dispatch.ts";
import { ProtectFob } from "../devices/fob.ts";
import { ProtectLight } from "../devices/light.ts";
import { ProtectLiveviews } from "../liveviews/liveviews.ts";
import type { ProtectNvrOptions } from "../options.ts";
import { ProtectNvrSystemInfo } from "./nvr-systeminfo.ts";
import type { ProtectPlatform } from "../platform.ts";
import { ProtectRelay } from "../devices/relay.ts";
import { ProtectSensor } from "../devices/sensor.ts";
import { ProtectViewer } from "../devices/viewer.ts";
import { channels } from "../diagnostics.ts";
import { describeDevice } from "../devices/device-descriptor.ts";
import { livestreamRecoveryDecision } from "../media/livestream-recovery-policy.ts";
import { servePlaylist } from "./nvr-playlist.ts";
import { setTimeout as sleep } from "node:timers/promises";
import util from "node:util";

/**
 * The NVR's lifecycle phase. The single source of truth for "what is this NVR doing right now?", consulted by every component that needs to distinguish induced
 * disruptions (where the plugin is intentionally driving an outage and downstream noise should be suppressed) from organic disruptions (where something genuinely
 * unexpected happened and the noise IS the signal).
 *
 *   - `connecting`: initial setup, or post-disruption reconnection attempt. Real connection errors should still surface to the user (e.g., "invalid credentials"),
 *      but health-symptom observation is suspended because we have not yet established a baseline of "running" against which to weigh stress.
 *   - `running`: connected, normal steady-state operation. Errors are organic; health observation is active; consumers log unexpected events normally.
 *   - `rebooting`: the plugin initiated a controller reboot. Errors are induced (we know the controller is going away); health observation is suspended; consumers
 *      suppress noise about the disruption.
 *   - `shuttingDown`: terminal. The plugin or the host process is going away. Same suppression as `rebooting` but no recovery is expected.
 *
 * Transitions are owned by `ProtectNvr.transition()`. Components consume via `nvr.phase`. Derived predicates (currently `logApiErrors`) are getters that project
 * from phase, so phase is the lone mutable axis.
 */
export type NvrPhase = "connecting" | "rebooting" | "running" | "shuttingDown";

export class ProtectNvr {

  private api: API;
  // The unifi-protect client - the single owner of protocol truth (reduced state, realtime decode, refresh failsafe, connection health). Established by connect() via
  // ProtectClient.connect() and torn down through its Symbol.asyncDispose. Definite-assignment typed for the connected lifetime; it is genuinely undefined only in the
  // narrow window before the first connect() (guarded where that window is reachable, e.g. disconnect()).
  public client!: ProtectClient;
  public readonly config: ProtectNvrOptions;
  public readonly configuredDevices: Map<string, ProtectDevices>;
  // The per-client connection-health subscriptions (throttle rails and controller-lost/recovered lifecycle). Re-wired on every connect() against the live client and
  // disposed on disconnect(), so they never outlive the client whose connection monitor they observe.
  private connectionSubscriptions: Disposable[];
  // The instant the controller entered its current continuous good state (running + reachable + healthy), or null when it is not good. Backdated by the controller's
  // uptime at the first good-state entry so a long-up controller is trusted immediately; reset on any disruption. The clock the removal stability gate reads.
  private controllerStableSince: Nullable<number>;
  // Pending delayed device removals, keyed by accessory UUID (the one key that resolves both a membership-leave AND a startup cache-orphan, since an orphan has no live
  // device id). Scheduled only when the controller is stable; cleared wholesale on any disruption; the fire re-checks live controller state through the caller-supplied
  // predicate (see scheduleDeviceRemoval's own documentation for the full set of checks a predicate can perform).
  private deviceRemovalTimers: Map<string, NodeJS.Timeout>;
  public readonly events: ProtectEventDispatch;
  private featureLog: Record<string, boolean>;
  private hap: HAP;
  // True once the controller has reached good-state at least once. Distinguishes the initial startup entry (uptime-backdated) from a later recovery (counted from now).
  private hasStabilizedOnce: boolean;
  public readonly health: NvrHealth;
  // The plugin's own-clock timestamp (Date.now()) of the last controller reboot we observed via the library's jitter-thresholded `controllerRebooted` event, or null
  // until one is seen this process. The per-camera livestream-disruption logs read this to recognize a blip that is the tail of a recent reboot - which fires after the
  // plugin has left the induced phase - and quiet it, distinct from a genuine single-camera drop. Not a controller clock: it is when WE observed the reboot, on our own
  // wall clock.
  private lastRebootObservedAt: Nullable<number>;
  // Per-episode quiet-classification latch for the per-camera livestream-disruption logs. The interruption edge records whether the episode should be logged quietly
  // (the tail of an induced disruption or a recently-observed reboot); the recovery edge - which can no longer read the phase reliably - consumes that classification.
  // Reclaimed on the camera's removal.
  private readonly livestreamEpisodes = createLivestreamEpisodeLatch();
  private liveviews: Nullable<ProtectLiveviews>;
  public readonly log: HomebridgePluginLogging;
  public mqtt: Nullable<MqttClient>;
  private name: string;
  private nvrRebootTimer: Nullable<NodeJS.Timeout>;
  // The post-reboot no-op confirmation timer. Armed after a successful reboot command to catch a controller that accepted the command but never actually restarted.
  private rebootConfirmTimer: Nullable<NodeJS.Timeout>;
  // Lifecycle phase. The SSOT for "what is this NVR doing right now?". Consumed by components that need to distinguish induced from organic disruption.
  // Mutated only through `transition()`, never directly.
  private _phase: NvrPhase;
  public readonly platform: ProtectPlatform;
  // The terminal plugin-shutdown abort. Aborted once, in transition("shuttingDown"); every NVR-level observe loop and every per-accessory controller composes against
  // it, so plugin shutdown tears the whole tree down as one cascade. Initialized in the constructor so it exists before any device is constructed.
  readonly #shutdownController: AbortController;
  // One-shot timer that fires when the stability window first elapses for the current good-state period, triggering the membership + orphan sweep. Cleared on disruption.
  private stabilityReachedTimer: Nullable<NodeJS.Timeout>;
  public systemInfo: Nullable<ProtectNvrSystemInfo>;
  private unsupportedDevices: Record<string, boolean>;
  // The unifi-protect client logger. Shares the controller-log destination but gates error output through `logApiErrors` so induced-disruption noise is suppressed. Typed
  // as the unifi-protect library's own ProtectLogging seam so it is single-sourced with the contract ProtectClient.connect() expects.
  private readonly clientLog: ProtectLogging;
  // The device-category -> adopted-id-selector SSOT. The membership observe loops, the stability sweep, and the per-fire stillGone re-check all read the live adopted
  // set through this one map, so the content-memoized selectors are wired in exactly one place rather than re-listed at each reader.
  private readonly adoptedIdSelectors: Record<keyof ProtectDeviceTypes, (state: ProtectState) => readonly string[]> = {

    camera: selectAdoptedCameraIds,
    chime: selectAdoptedChimeIds,
    fob: selectAdoptedFobIds,
    light: selectAdoptedLightIds,
    relay: selectAdoptedRelayIds,
    sensor: selectAdoptedSensorIds,
    viewer: selectAdoptedViewerIds
  };

  constructor(platform: ProtectPlatform, nvrOptions: ProtectNvrOptions) {

    this.api = platform.api;
    this.config = nvrOptions;
    this.configuredDevices = new Map();
    this.connectionSubscriptions = [];
    this.controllerStableSince = null;
    this.deviceRemovalTimers = new Map();
    this.featureLog = {};
    this.hap = this.api.hap;
    this.hasStabilizedOnce = false;
    this.lastRebootObservedAt = null;
    this.liveviews = null;
    this.mqtt = null;
    this.name = nvrOptions.name ?? nvrOptions.address;
    this.nvrRebootTimer = null;
    this.rebootConfirmTimer = null;
    this._phase = "connecting";
    this.platform = platform;
    this.#shutdownController = new AbortController();
    this.stabilityReachedTimer = null;
    this.systemInfo = null;
    this.unsupportedDevices = {};

    // Configure the unifi-protect client logging. Error output is gated by `logApiErrors` so induced disruptions stay quiet.
    this.clientLog = {

      debug: (message: string, ...parameters: unknown[]): void => { this.platform.debug(util.format(message, ...parameters)); },
      error: (message: string, ...parameters: unknown[]): void => {

        if(this.logApiErrors) {

          this.platform.log.error(util.format(message, ...parameters));
        }
      },
      info: (message: string, ...parameters: unknown[]): void => { this.platform.log.info(util.format(message, ...parameters)); },
      warn: (message: string, ...parameters: unknown[]): void => { this.platform.log.warn(util.format(message, ...parameters)); }
    };

    // Configure our controller logging.
    this.log = {

      debug: (message: string, ...parameters: unknown[]): void => { this.platform.debug(util.format(this.name + ": " + message, ...parameters)); },
      error: (message: string, ...parameters: unknown[]): void => { this.platform.log.error(util.format(this.name + ": " + message, ...parameters)); },
      info: (message: string, ...parameters: unknown[]): void => { this.platform.log.info(util.format(this.name + ": " + message, ...parameters)); },
      warn: (message: string, ...parameters: unknown[]): void => { this.platform.log.warn(util.format(this.name + ": " + message, ...parameters)); }
    };

    // Initialize the NVR-health observer. This is the single source of truth across the plugin for the NVR's current operating condition. Every subsystem that
    // wants to make a stress-aware decision reads `this.health.state`; every subsystem that observes a symptom calls `this.health.observe(...)`. Its connection
    // inputs are wired below (request outcomes) and in connect() (throttle rails), so they flow from the unifi-protect client's observability surface without each
    // call site needing its own hook.
    this.health = new NvrHealth();

    // Apply initial-phase side effects. Phase is `connecting` until the first successful connect(); during connecting, health observation is suspended (we have
    // not established a baseline against which to weigh stress, and any errors during initial credential validation are real but should not feed into stress
    // metrics). Subsequent phase changes go through `transition()` which keeps health.suspend / health.resume aligned with phase.
    this.health.suspend();

    // Surface health transitions at the NVR level. Per-component logs (per-camera stalls, per-request errors) are demoted to debug under non-healthy state...the
    // user already has the explanatory NVR-level signal and does not need an N-camera fan-out of correlated noise.
    //
    // Two direction-aware rules keep the narrative coherent for an operator scanning warn-level logs:
    //
    //   1. Recovery is logged at warn (not info) so the entry warn and the closing warn pair visibly. An operator grepping warn for "is anything currently
    //      broken?" sees both the alert and its resolution at the same level.
    //   2. The hysteresis step from `stressed` back to `degraded` is silent. That transition means recovery is in progress, not that things are getting worse,
    //      and logging "responding slowly..." on the way down would read as a fresh alert. The next transition (`degraded` -> `healthy`) is the one worth
    //      surfacing.
    this.health.on("stateChange", (next, previous) => {

      switch(next) {

        case "healthy":

          this.log.warn("The Protect controller is responsive again.");

          break;

        case "degraded":

          if(previous === "stressed") {

            // Hysteresis step on the way down. The closing warn fires when we hit healthy.
            break;
          }

          this.log.warn("The Protect controller is responding slowly or with intermittent errors. Reducing reconnect attempts until conditions improve.");

          break;

        case "stressed":

          this.log.warn("The Protect controller is under sustained load. Pausing background operations until conditions improve. Active recordings and live " +
            "streams continue.");

          break;

        default:

          exhaustiveGuard(next);
      }

      // Re-evaluate the removal stability clock - health is one of the facts `good` depends on. A drop out of healthy resets the clock and cancels every pending
      // removal; a return to healthy (with phase running and the connection healthy) re-stamps it and re-arms the sweep.
      this.refreshRemovalStability();
    });

    // Initialize our UniFi Protect event handler.
    this.events = new ProtectEventDispatch(this);

    // Validate our Protect address and login information.
    if(!nvrOptions.address || !nvrOptions.username || !nvrOptions.password) {

      return;
    }

    // Wire the NVR-health request-outcome inputs from the unifi-protect library's process-global HTTP diagnostics channel. The channel carries every request from every
    // client in the process, so we filter by this controller's host to keep each NVR's health scoped to its own controller. A 2xx is recovery evidence; everything else
    // (an error, or a non-2xx status) is a stress symptom. Wired here - past the address guard, so a misconfigured controller never subscribes - and detached on the
    // terminal shutdown signal (which the SHUTDOWN handler below guarantees fires). Observation is gated by the health observer's own suspend/resume, so symptoms during
    // connecting or induced disruptions are dropped.
    const onRequestEnd = (message: unknown): void => {

      const payload = message as HttpRequestEndPayload;

      if(!payload.url.includes(this.config.address)) {

        return;
      }

      this.health.observe({ at: Date.now(), kind: isSuccessfulRequest(payload) ? "apiSuccess" : "apiError" });
    };

    protectChannels.httpRequestEnd.subscribe(onRequestEnd);
    this.signal.addEventListener("abort", () => protectChannels.httpRequestEnd.unsubscribe(onRequestEnd), { once: true });

    // Wire the livestream stall/recovery health and log feeds. Same once-per-NVR setup site as the API-health feed above: past the address guard and detached on the
    // terminal shutdown signal. The unifi-protect library's livestream-recovery channels are process-global, so this subscribes exactly once and never re-wires per
    // reconnect.
    this.wireLivestreamHealth();

    // Cleanly shut down on Homebridge exit.
    this.api.on(APIEvent.SHUTDOWN, () => {

      // Clear the scheduled reboot timer if it's running.
      if(this.nvrRebootTimer) {

        clearTimeout(this.nvrRebootTimer);
        this.nvrRebootTimer = null;
      }

      // Clear the post-reboot no-op confirmation timer if it's running. Like the reboot timer above, it is an induced-lifecycle timer that must not survive teardown.
      if(this.rebootConfirmTimer) {

        clearTimeout(this.rebootConfirmTimer);
        this.rebootConfirmTimer = null;
      }

      // Tear down the device-removal timers unconditionally. The stability-sweep one-shot and every pending delayed removal are deferred destructive actions that must
      // not fire against a disposed client; clearing them here - alongside the reboot timers - makes teardown the removal SSOT rather than leaving it contingent on the
      // transition("shuttingDown") below also running refreshRemovalStability. Both clears are idempotent, so the belt-and-suspenders overlap is harmless.
      if(this.stabilityReachedTimer) {

        clearTimeout(this.stabilityReachedTimer);
        this.stabilityReachedTimer = null;
      }

      this.cancelAllDeviceRemovals();

      // Mark the lifecycle phase before tearing down. This is the single chokepoint that aborts the terminal shutdown signal, so every observe loop unwinds as one
      // cascade. Components that surface "unexpected teardown" warnings (e.g., the recording delegate) consult `nvr.phase` to suppress noise during induced
      // disruptions; without this transition the disconnect below would fan out as if cameras were failing unexpectedly.
      this.transition("shuttingDown");

      // Disconnect from the controller. This tears down active HomeKit streams, HKSV timeshift buffers, and the unifi-protect client connection.
      void this.disconnect();
    });
  }

  /**
   * Wire the NVR-health and user-facing log feeds for livestream disruptions, sourced from the unifi-protect library's process-global livestream-recovery diagnostics
   * channels. The library owns the recovery protocol and publishes each episode's lifecycle on these channels; the plugin translates them into its own health model and
   * its own per-camera logs, scoped to this controller's cameras.
   *
   * We subscribe the two episode-boundary channels - `recovery:started` (a stream was disrupted; the episode begins) and `recovery:recovered` (it resumed). These are
   * the stall/recovery health feed: one stress symptom per disruption episode, one recovery symptom per recovery, so a recovered episode
   * nets zero and a failed one (started, never recovered) stays +1 - correct stress accounting with no double count. The other livestream channels are deliberately not
   * consumed here: `stall:detected` is a subset of `recovery:started` (every detected stall begins an episode) and consuming both would double-count;
   * `recovery:exhausted` is the consumer-side self-heal's concern; `session:closed`/`codec:changed` are neither health nor log signals.
   *
   * The channels are process-global - shared by every `ProtectNvr` in this process - so each handler filters to this controller's cameras via `getDeviceById(cameraId)`
   * and drops the rest (another controller's camera, or one we do not configure). A package-camera stream carries its PARENT camera's device id, so the lookup resolves
   * the parent `ProtectCamera` and the log names the parent - correct, since there is no separate package-camera device to name.
   */
  private wireLivestreamHealth(): void {

    // A livestream was disrupted and an episode begins. Feed the +1 stress symptom (keyed on the episode start, so it also catches socket-close disruptions the narrow
    // stall channel misses) and surface it to the user at the level the classification below decides, so a stream in genuine trouble is visible while it is happening.
    const onRecoveryStarted = (message: unknown): void => {

      const payload = message as LivestreamRecoveryStartedPayload;
      const camera = this.getDeviceById(payload.cameraId);

      if(!camera) {

        return;
      }

      // Classify whether to log this episode quietly, and record that so the recovery edge - which cannot read the phase reliably, the controller having returned by then
      // - consults the same classification. Quiet is the SUPERSET of the cases the phase alone cannot cover: an interruption observed while still rebooting/shutting down
      // (induced), AND the post-return re-establishment blip of a controller reboot, whose recovery:started fires at episode entry seconds after the controller returned,
      // by which point the plugin has already concluded the reboot and resumed running - so isInducedDisruption(this.phase) reads false here and the recency half
      // catches it. This sits AFTER the ownership guard above: the unifi-protect library's recovery channels are process-global, so recording before the guard would
      // latch every OTHER controller's cameras too, and our own forgetCamera (scoped to our removals) could never reclaim a foreign started-never-recovered entry.
      const quiet = isInducedDisruption(this.phase) ||
        isWithinRebootRecency({ lastRebootMs: this.lastRebootObservedAt, nowMs: Date.now(), windowMs: PROTECT_NVR_REBOOT_RECENCY_MS });

      this.livestreamEpisodes.record(payload.key, payload.cameraId, quiet);
      this.health.observe({ at: Date.now(), cameraId: payload.cameraId, kind: "livestreamStall" });

      // A reboot blips every camera and is already narrated once at the controller level, so the per-camera flurry drops to debug whether the reboot was induced or
      // organic; a genuine single-camera drop on a controller that has not recently rebooted stays at warn - that one is in trouble and the noise is the signal.
      if(quiet) {

        camera.log.debug("The livestream was interrupted and is recovering.");
      } else {

        camera.log.warn("The livestream was interrupted and is recovering.");
      }
    };

    // The disrupted livestream recovered. Feed the -1 recovery symptom and report the resolution and how long media was absent. `Math.max(1, ...)` avoids a nonsensical
    // "0 s" on a sub-second recovery.
    const onRecoveryRecovered = (message: unknown): void => {

      const payload = message as LivestreamRecoveryRecoveredPayload;
      const camera = this.getDeviceById(payload.cameraId);

      if(!camera) {

        return;
      }

      // The current phase is not a reliable classification proxy here (the controller has returned), so the quiet/loud value latched at the interruption edge - not
      // this.phase - decides the level. Consume drains the entry; a never-recovered episode is reclaimed by forgetCamera on the camera's removal.
      const quiet = this.livestreamEpisodes.consume(payload.key);
      const recoveredAfter = formatSeconds(Math.max(1, Math.round(payload.downtimeMs / 1000)));

      this.health.observe({ at: Date.now(), cameraId: payload.cameraId, kind: "livestreamRecovery" });

      // Mirror the interruption edge: the per-camera recovery of a reboot's tail (induced or recently observed) is debug, since the library narrates the controller-level
      // recovery; a genuine single-camera drop stays warn.
      if(quiet) {

        camera.log.debug("The livestream has recovered after %s.", recoveredAfter);
      } else {

        camera.log.warn("The livestream has recovered after %s.", recoveredAfter);
      }
    };

    protectChannels.livestreamRecoveryStarted.subscribe(onRecoveryStarted);
    protectChannels.livestreamRecoveryRecovered.subscribe(onRecoveryRecovered);

    // Detach both on the terminal shutdown signal, mirroring the API-health feed. The unifi-protect library's channels are global and outlive any single client, so an
    // explicit unsubscribe on shutdown is what keeps these subscriptions leak-free.
    this.signal.addEventListener("abort", () => {

      protectChannels.livestreamRecoveryStarted.unsubscribe(onRecoveryStarted);
      protectChannels.livestreamRecoveryRecovered.unsubscribe(onRecoveryRecovered);
    }, { once: true });
  }

  /**
   * Current lifecycle phase. Components that need to distinguish induced disruption (rebooting, shutting down) from organic operation (running) consult this
   * property. Pure read - mutation goes through {@link transition} only.
   */
  public get phase(): NvrPhase {

    return this._phase;
  }

  /**
   * The terminal plugin-shutdown abort signal. Aborted exactly once, in `transition("shuttingDown")`. Every NVR-level observe loop and every per-accessory abort
   * controller composes against it, so plugin shutdown tears the whole tree down as one cascade. Pure read - the controller is private and aborted only through the
   * transition chokepoint.
   */
  public get signal(): AbortSignal {

    return this.#shutdownController.signal;
  }

  // Whether the terminal shutdown signal has fired - the plugin is tearing down and no deferred wake may act against a disposed client. The single predicate every
  // post-await bail consults (a late-resolving connect, a scheduled-reboot timer firing, the disabled-controller settle sleep), read through a method so each caller
  // re-reads the live signal rather than a stale snapshot an earlier bail on the same path could have pinned.
  #isShuttingDown(): boolean {

    return this.signal.aborted;
  }

  /**
   * Read-through NVR configuration. Replaces the held bootstrap snapshot with the live unifi-protect projection, so every `nvr.ufp.<field>` read across the plugin
   * reflects the current reduced state with no merge and no reassignment. A read before the first successful connect() throws (the getter dereferences
   * `this.client`, which is unset until connect() assigns it) - this is deliberate: a too-early read should fail loudly, not silently return a stale snapshot, which
   * is the held-state footgun this read-through design avoids. No code path reaches that throw: the constructor and the only other pre-connect path (`login()`'s
   * global enable gate) both avoid `ufp` - the gate consults feature options by global scope, not the controller mac, and `ProtectEventDispatch` construction is
   * structural-only and does not read `hasFeature`/`ufp`.
   */
  public get ufp(): Readonly<ProtectNvrConfig> {

    return this.client.nvr.config;
  }

  /**
   * Whether API error logging is currently surfaced to the user. Derived from phase: errors are visible during `connecting` (so credential or address problems
   * reach the user) and `running` (organic errors are real signal), but suppressed during `rebooting` and `shuttingDown` where the errors are induced by our own
   * teardown. Read by the unifi-protect client logger callback in this NVR's constructor.
   */
  public get logApiErrors(): boolean {

    return (this._phase === "running") || (this._phase === "connecting");
  }

  // Move the NVR to a new lifecycle phase. The single chokepoint that keeps every derived effect aligned: it updates `_phase`, aborts the terminal shutdown signal on
  // entry to `shuttingDown`, then drives `health.suspend()` / `health.resume()` so the symptom observer matches whether we're in an induced disruption or organic
  // operation. The `logApiErrors` getter is pure-derived from `_phase` and needs no explicit update here.
  //
  // A no-op on same-phase transitions, and a no-op on any attempt to leave `shuttingDown` - that phase is terminal, so a stale reboot timer, a late-resolving
  // connect, or any other deferred wake that fires after teardown cannot resurrect the lifecycle. `canTransition` owns both rules. `shuttingDown` is observable
  // through `nvr.signal`'s abort event; every other phase change is observed by polling `phase` directly.
  private transition(next: NvrPhase): void {

    if(!canTransition({ from: this._phase, to: next })) {

      return;
    }

    this._phase = next;

    // Entering the terminal phase fires the lifecycle telemetry and aborts the shutdown signal - the one place the whole observe/firehose tree is torn down. We
    // publish before aborting so the lifecycle event is not lost to the abort cascade that detaches our diagnostics subscriptions.
    if(next === "shuttingDown") {

      this.publishLifecycle("shuttingDown");
      this.#shutdownController.abort();
    }

    // Health observation is active only in `running`. Every other phase is either initial setup, an induced disruption, or termination - none are organic
    // baselines against which stress can be meaningfully measured.
    if(this._phase === "running") {

      this.health.resume();
    } else {

      this.health.suspend();
    }

    // Re-evaluate the removal stability clock now that phase changed - one of the facts `good` depends on. Unconditional and last so the shuttingDown path always
    // runs the cancel-all (good becomes false, every pending removal is cleared) before disconnect() disposes the client. The health.resume() above ran first, so on the
    // connect() path into running, health is already healthy when this stamps the startup good-state.
    this.refreshRemovalStability();
  }

  // Publish an NVR-level lifecycle milestone on the forward-only diagnostics channel. Zero-cost when no subscriber is attached (the Node-native sync check).
  private publishLifecycle(event: NvrLifecyclePayload["event"]): void {

    if(channels.nvrLifecycle.hasSubscribers) {

      channels.nvrLifecycle.publish({ event } satisfies NvrLifecyclePayload);
    }
  }

  // Establish a connection to the Protect controller. The unifi-protect library's ProtectClient.connect() is atomic - it logs in, fetches the initial bootstrap, seeds
  // the reducer, and brings up the realtime events channel as one ready-or-throws operation, owning retry/backoff and the periodic refresh failsafe internally. We wrap
  // it in a startup-resilient retry: authentication faults get a small consecutive budget so a controller still sorting out its own auth recovers, but genuinely-wrong
  // credentials fail fast rather than looping forever; any non-auth fault resets the budget and retries unbounded until the controller appears or the shutdown signal
  // aborts. Safe to call multiple times - each call establishes a fresh client.
  private async connect(): Promise<boolean> {

    const { shouldRetry } = createConnectRetryPolicy();

    try {

      this.client = await retry((signal) => ProtectClient.connect({ host: this.config.address, log: this.clientLog, password: this.config.password,
        recoveryPolicy: (context) => livestreamRecoveryDecision(context,
          { healthState: this.health.state, isHealthy: this.client.connection.isHealthy, isThrottled: this.client.connection.isThrottled, phase: this.phase },
          this.episodeCameraReachable(context.cameraId)), signal,
        username: this.config.username }), { attempts: Infinity, shouldRetry, signal: this.signal });
    } catch(error) {

      // The shutdown signal aborting the retry is an orderly teardown, not a failure to report. A genuine auth budget exhaustion (wrong credentials) surfaces here.
      if(this.#isShuttingDown()) {

        return false;
      }

      this.log.error("Unable to connect to the Protect controller: %s.", formatErrorMessage(error));

      return false;
    }

    // A connect attempt that resolves after shutdown must not resurrect the controller's lifecycle. The SHUTDOWN handler's disconnect() captured and disposed the
    // PREVIOUS client before this reassignment, so the freshly-established client is otherwise orphaned - dispose it and bail before the version gate,
    // wireConnectionHealth, health.reset, or the transition into running.
    if(this.#isShuttingDown()) {

      await this.client[Symbol.asyncDispose]();

      return false;
    }

    const version = this.client.nvr.config.version;

    // If we are running an unsupported version of UniFi Protect, we're done. The version gate stays plugin-side, reading the live projection post-connect.
    if(![ "6.", "7." ].some(v => version.startsWith(v))) {

      this.log.error("This version of HBUP requires running UniFi Protect v6.0 or above using the official Protect release channel only.");
      await this.client[Symbol.asyncDispose]();

      return false;
    }

    // Assign our log-prefix name, decorated with the controller model - "Name [Model]" via describeDevice - so every controller-scoped line shows the hardware
    // in its prefix. The name resolution follows the established precedence (a user preference wins, then the controller's reported name, then its address);
    // describeDevice only appends the bracketed model, and is reached here post-bootstrap where this.ufp is populated. Early, pre-bootstrap logs keep the bare name set
    // in the constructor.
    this.name = describeDevice(this.ufp, { name: this.config.name ?? this.client.controllerName ?? this.config.address });

    // Wire the per-client connection-health inputs (throttle rails, controller-lost/recovered lifecycle) against the freshly-established client.
    this.wireConnectionHealth();

    // Reset NVR-health state on every successful connect. After a disconnect/reconnect cycle (planned or otherwise), pre-disruption symptoms are no longer
    // relevant...the controller we're now talking to is the canonical truth, and starting clean prevents stale state from biasing post-reconnect decisions. The
    // first connect at startup is healthy by construction, so this is a no-op there; the reset earns its keep on every reconnect after.
    this.health.reset();

    // Transition into the `running` phase. This re-enables organic health observation (suspend was applied during `connecting`), keeps `logApiErrors` true, and
    // tells every consumer of `nvr.phase` that the plugin is back to normal steady-state operation.
    this.transition("running");
    this.publishLifecycle("connected");

    // We successfully connected.
    this.log.info("Connected to %s (UniFi Protect %s running on UniFi OS %s).", this.config.address, version, this.ufp.firmwareVersion);

    return true;
  }

  // Wire the per-client NVR-health connection inputs. The throttle rails feed the library-throttle symptoms; the controller-lost/recovered rails drive lifecycle
  // telemetry. We dispose any prior subscriptions first so a reconnect (which builds a fresh client) never leaves a listener bound to a disposed connection monitor.
  // Bound to the client's lifetime, not the shutdown signal, because the client - and therefore its connection monitor - is itself replaced on a reconnect.
  private wireConnectionHealth(): void {

    for(const subscription of this.connectionSubscriptions) {

      subscription[Symbol.dispose]();
    }

    this.connectionSubscriptions = [

      this.client.connection.on("throttleEntered", () => this.health.observe({ at: Date.now(), kind: "libraryThrottleEntered" })),
      this.client.connection.on("throttleExited", () => this.health.observe({ at: Date.now(), kind: "libraryThrottleReleased" })),
      this.client.connection.on("controllerLost", () => this.publishLifecycle("controllerLost")),
      this.client.connection.on("controllerRebooted", () => this.onControllerRebooted()),
      this.client.connection.on("controllerRecovered", () => this.onControllerRecovered())
    ];
  }

  // React to a controller reboot detection, whether we induced it or it happened organically. This handler records the observation (our own-clock recency anchor),
  // publishes the lifecycle milestone (the unifi-protect library already logs the detection at warn, so we do not duplicate it), and resets each camera's probesize
  // self-tuning; the induced-reboot resume is driven separately by the connection's recovery edge in startConnectionObserver, so it is not this handler's concern.
  private onControllerRebooted(): void {

    // Record our own-clock observation of this reboot. This is the SSOT moment the plugin learns a reboot happened (induced or organic), so it anchors the recency window
    // the per-camera livestream-disruption logs consult to quiet a re-establishment blip that lands after the plugin has already concluded the reboot and
    // resumed running.
    this.lastRebootObservedAt = Date.now();

    this.publishLifecycle("controllerRebooted");

    // Every reboot re-adopts and restarts each camera's stream from scratch, so clear each camera's accumulated probesize self-tuning - a per-camera latch that at its
    // permanent ceiling arms no auto-reset and otherwise persists for the life of the delegate. We accept one baseline re-tune per reboot on a chronically-flaky camera
    // rather than a forever-elevated probesize. The endpoints iterator walks package cameras alongside their parents, so the package's delegate resets here too.
    for(const device of this.deviceEndpoints()) {

      if(!(device instanceof ProtectCamera)) {

        continue;
      }

      device.stream?.resetProbesizeOverride();
    }
  }

  // The connection returned to healthy after a loss. This handler's sole duty is publishing the controllerRecovered lifecycle milestone; the induced-reboot resume is
  // driven by the connection's recovery edge in startConnectionObserver (the same non-healthy -> healthy edge this recovery represents).
  private onControllerRecovered(): void {

    this.publishLifecycle("controllerRecovered");
  }

  // Return from our own induced reboot to steady-state operation, called by startConnectionObserver on the connection's recovery edge (a non-healthy -> healthy
  // transition while rebooting). The `_phase === "rebooting"` guard is a defensive method-boundary precondition: the recovery-edge predicate is the SSOT decision and
  // this guard asserts the contract, so an organic recovery while `running` is a no-op here. The un-strand property is inherent to the recovery edge - a real reboot
  // always drops then recovers the connection, so the edge always fires, depending on nothing but the connection's own health journey and no separate detection event.
  // We clear the no-op confirmation timer (a real recovery edge proves the reboot took effect) and reset the pre-reboot health history: the controller is freshly
  // booted, so any stress or library-throttle state latched before the reboot is no longer relevant. The suspend held across the whole rebooting phase kept induced
  // symptoms out of the buffer, but the latched state enum and the throttle flag clear only on a reset or a fresh clearing observation, so we reset explicitly here -
  // restoring the clean baseline the connect()-driven reset gives us. The library already narrates the recovery itself, so this method does not log a duplicate
  // "back online" line. (The no-op path produces no recovery edge and resumes via the rebootConfirmTimer instead, which deliberately does NOT reset: a controller
  // that never actually rebooted keeps its still-relevant health history.)
  private resumeFromInducedReboot(): void {

    if(this._phase !== "rebooting") {

      return;
    }

    if(this.rebootConfirmTimer) {

      clearTimeout(this.rebootConfirmTimer);
      this.rebootConfirmTimer = null;
    }

    this.health.reset();
    this.transition("running");
  }

  // Cleanly disconnect from the Protect controller. This tears down all connection-dependent resources (active HomeKit streams, HKSV timeshift buffers, the
  // connection-health subscriptions, and the unifi-protect client itself) while preserving one-time infrastructure (playlist servers, MQTT, event listeners).
  private async disconnect(): Promise<void> {

    // Tear down all connection-dependent camera resources. Active HomeKit streaming sessions and HKSV timeshift buffers both depend on the controller connection.
    // Shutting them down proactively prevents error noise from livestream self-healing and FFmpeg processes communicating with a disconnected controller. The camera
    // does not own its own session manager, so disposing these consumers is what releases their underlying unifi-protect livestream pool subscriptions. This is a HARD
    // ORDERING INVARIANT - the connection-dependent consumers (and the pool subscriptions they hold) are torn down in this loop BEFORE the unifi-protect client is
    // disposed below, so no subscription outlives the client it draws from. The endpoints iterator walks package cameras alongside their parents.
    for(const device of this.deviceEndpoints()) {

      if(!(device instanceof ProtectCamera)) {

        continue;
      }

      device.stream?.shutdown();
      device.stream?.timeshift?.shutdown();
    }

    // Detach the connection-health subscriptions so they do not outlive the client whose connection monitor they observe.
    for(const subscription of this.connectionSubscriptions) {

      subscription[Symbol.dispose]();
    }

    this.connectionSubscriptions = [];

    // Dispose the unifi-protect client - tearing down the connection monitor, livestream pool, state store, session, and transport pool, in that order. The client is
    // definite-assignment typed for the connected lifetime, but a shutdown during the initial connect can reach here before connect() assigned it; the cast guards
    // that window without widening the field's type for every connected-path read.
    const client = this.client as ProtectClient | undefined;

    if(client) {

      await client[Symbol.asyncDispose]();
    }
  }

  // Initialize our connection to the UniFi Protect controller. This is the one-time entry point called at startup that establishes the connection, creates all
  // infrastructure, performs the initial device population, and spawns the NVR-level observe loops that keep us in sync with the controller.
  public async login(): Promise<void> {

    // The plugin has been disabled globally. The controller mac is unknown until we connect, so this pre-connect gate consults global feature-option scope directly
    // rather than `hasFeature` (which would read the not-yet-known controller mac); the per-controller gate runs post-connect below.
    if(!this.platform.featureOptions.test("Device")) {

      this.log.info("Disabling this UniFi Protect controller.");

      return;
    }

    // Establish our connection to the Protect controller.
    if(!(await this.connect())) {

      return;
    }

    // Now that we know the NVR configuration, check to see if this Protect controller is disabled.
    if(!this.hasFeature("Device")) {

      this.log.info("Disabling this UniFi Protect controller in HomeKit.");

      // Let's sleep for thirty seconds to give all the accessories a chance to load before disabling everything. Homebridge doesn't have a good mechanism to notify us
      // when all the cached accessories are loaded at startup.
      await sleep(PROTECT_NVR_CONTROLLER_DISABLED_SETTLE_DELAY);

      // A teardown that landed during the settle sleep must not run a removal sweep against a disposed platform - bail before touching any accessory.
      if(this.#isShuttingDown()) {

        return;
      }

      // Unregister all the accessories for this controller from Homebridge that may have been restored already. Any additional ones will be automatically caught when
      // they are restored.
      for(const accessory of this.platform.accessories.filter(x => x.context.nvr === this.ufp.mac)) {

        this.removeHomeKitDevice(accessory);
      }

      return;
    }

    // Configure any NVR-specific settings.
    this.configureNvr();

    // Initialize MQTT before constructing the accessory owners. Their constructor-time MQTT subscriptions (system information, and liveviews on its initial reconcile)
    // bind through nvr.mqtt, so the client must exist first or those subscriptions would silently no-op against a not-yet-created client and never be retried. The client
    // binds to the NVR's terminal shutdown signal, so it is an AsyncDisposable whose connection ends on plugin shutdown rather than leaking past it.
    if(!this.mqtt && this.config.mqttUrl) {

      this.mqtt = new MqttClient({ brokerUrl: this.config.mqttUrl, log: this.log, topicPrefix: this.config.mqttTopic }, { signal: this.signal });
    }

    // Initialize our liveviews.
    this.liveviews = new ProtectLiveviews(this);

    // Initialize our NVR system information.
    this.systemInfo = new ProtectNvrSystemInfo(this);

    // Initialize our playlist service, if enabled.
    if(this.hasFeature("Nvr.Service.Playlist")) {

      servePlaylist(this);
    }

    // Inform the user about the devices we see, reading the live unifi-protect projections.
    this.log.info("Discovered controller: %s.", describeDevice(this.ufp, { includeNetwork: true, name: this.client.controllerName }));

    for(const config of this.deviceConfigs) {

      // Filter out any devices that aren't adopted by this Protect controller.
      if(!config.isAdopted || config.isAdoptedByOther) {

        continue;
      }

      this.log.info("Discovered %s: %s.", config.modelKey, describeDevice(config, { includeNetwork: true }));
    }

    // Perform the initial device population and spawn the observe loops that keep us in sync. Membership is an observe over the content-memoized adopted-id selectors,
    // controller health an observe over the connection monitor, and the controller-scoped accessories (system information, liveviews) each observe their own slice of the
    // unifi-protect projection from their own constructors - the subject owns its reactivity, the same model the per-device leaves use. Orphan cleanup does not run
    // here: the stability sweep owns it, so a cached accessory is removed only once the controller has been good for the stability window (immediately at startup for a
    // controller already up past it, via the uptime backdate).
    this.startDeviceObservers();

    // Seed the initial liveview population now that the device accessories exist. A liveview switch restores its saved motion-detection state onto its member cameras, so
    // this first reconcile must run after startDeviceObservers; every subsequent liveview-collection change is handled by the observer ProtectLiveviews spawns itself.
    this.liveviews.configureLiveviews();

    this.startConnectionObserver();

    // Spawn the typed event-firehose router and the controller telemetry publisher. The router is the one controller-level consumer of the classified activity firehose,
    // dispatching each smart-detect / doorbell-ring / access / tamper / auth occurrence to the addressed accessory's HomeKit delivery; the telemetry publisher mirrors
    // every raw frame to MQTT and is a no-op unless the user opted in. Both are bound to the terminal shutdown signal and unwind with the rest of the observe tree.
    this.spawnLoop("live events", () => this.events.run(this.signal));
    this.spawnLoop("controller telemetry", () => this.events.publishTelemetry(this.signal));
  }

  // Configure NVR-specific settings.
  private configureNvr(): boolean {

    // Configure scheduled reboots if enabled.
    this.configureScheduledReboot();

    return true;
  }

  // Configure scheduled reboots of the Protect controller.
  private configureScheduledReboot(): void {

    // Retrieve the reboot interval. A null return means the option is explicitly disabled.
    const rebootInterval = this.getFeatureFloat("Nvr.Reboot");

    if(rebootInterval === null) {

      return;
    }

    // Apply the reboot interval, defaulting to the configured default if the option is enabled without an explicit value. We enforce a minimum interval to prevent the
    // controller from entering a reboot loop.
    const intervalHours = Math.max(rebootInterval ?? PROTECT_NVR_REBOOT_INTERVAL, PROTECT_NVR_REBOOT_MIN_INTERVAL);
    const intervalMs = intervalHours * 60 * 60 * 1000;

    // Anchor the schedule to the controller's actual uptime so plugin restarts don't reset the reboot cadence. If the controller has been up longer than the
    // interval, we schedule a reboot shortly after startup to let everything settle first.
    const uptimeMs = this.ufp.upSince ? (Date.now() - this.ufp.upSince) : 0;
    const delayMs = Math.max(intervalMs - uptimeMs, 60 * 1000);

    this.log.info("Scheduled controller reboot enabled every %s hour%s.", intervalHours, (intervalHours === 1) ? "" : "s");

    // Schedule the reboot.
    this.nvrRebootTimer = setTimeout(() => void this.executeScheduledReboot(intervalHours), delayMs);
  }

  // Execute a scheduled reboot of the Protect controller. The optional `cycleStart` is undefined on the originally-scheduled fire and carries the timestamp of
  // the first reschedule (deferral or post-failure retry) on every subsequent call. This makes the deferral ceiling a pure function of the call chain rather
  // than separate mutable state on the NVR, and it lets failure-retry naturally accumulate cycle time the same way deferrals do.
  //
  // The reboot rides the unifi-protect client's `reboot()` and its surviving connection layer: we POST the reboot and let the connection monitor, store, and livestream
  // pool ride the outage and auto-recover without recreating the client. The rebooting -> running transition is driven by the connection's recovery edge (a
  // non-healthy -> healthy transition observed in startConnectionObserver), with the no-op confirmation timer the only other exit.
  private async executeScheduledReboot(intervalHours: number, cycleStart?: number): Promise<void> {

    // A teardown that landed between this timer being armed and now makes the whole reboot moot: the shutdown signal has aborted the lifecycle and the timers are
    // being cleared. Bail before any deferral accounting or sending a command against a disposing client.
    if(this.#isShuttingDown()) {

      return;
    }

    // Check if any cameras are actively recording HKSV events. We defer if so, but only up to PROTECT_NVR_REBOOT_DEFERRAL_MAX cumulatively...past that ceiling we
    // force the reboot regardless. An open-ended series of HKSV events would otherwise let the deferral chain run indefinitely, which defeats the point of having
    // a scheduled reboot in the first place.
    const activeRecordings = this.devices("camera").filter(camera => camera.stream?.hksv?.isTransmitting);
    const elapsedCycleMs = (cycleStart !== undefined) ? (Date.now() - cycleStart) : 0;
    const deferralCeilingMs = PROTECT_NVR_REBOOT_DEFERRAL_MAX * 1000;

    // Stamp the cycle start on the first reschedule; propagate it unchanged on subsequent ones so the ceiling is measured from the first attempt, not the last.
    const nextCycleStart = cycleStart ?? Date.now();

    if((activeRecordings.length > 0) && (elapsedCycleMs < deferralCeilingMs)) {

      this.log.info("Deferring scheduled controller reboot: %s camera%s actively recording HKSV events.", activeRecordings.length,
        (activeRecordings.length === 1) ? " is" : "s are");

      this.nvrRebootTimer = setTimeout(() => void this.executeScheduledReboot(intervalHours, nextCycleStart), 60 * 1000);

      return;
    }

    // Surface the ceiling-forced case so an operator can see why the reboot fired despite active recordings. This is rare; an info log keeps the signal visible
    // without turning a benign event into a warning.
    if(activeRecordings.length > 0) {

      this.log.info("Proceeding with scheduled controller reboot after %s minutes of deferrals; %s camera%s still recording HKSV events but the deferral limit " +
        "has been reached.", Math.round(deferralCeilingMs / 60000), activeRecordings.length, (activeRecordings.length === 1) ? " is" : "s are");
    }

    // Move into the `rebooting` phase before sending the command. From this point until we know the outcome, any API errors are induced by our own action and
    // should be suppressed (per `logApiErrors`'s phase derivation), and any livestream-stall or apiError symptoms are dropped by NvrHealth (which suspends in
    // every non-`running` phase). On a failed attempt below we transition back to `running` so the next retry surfaces real errors organically.
    this.transition("rebooting");

    try {

      // Reboot the controller through the unifi-protect client. POSTs the UniFi-OS reboot and throws a classified error on a non-2xx response; the surviving connection
      // monitor and store ride the outage and auto-recover without recreating the client, so we do NOT tear anything down here. The rebooting -> running transition is
      // driven by the connection's recovery edge (a non-healthy -> healthy transition observed in startConnectionObserver), with the no-op confirmation below as the only
      // other exit.
      await this.client.reboot();
    } catch(error) {

      // A reboot rejection while the shutdown signal is aborted is induced by our own disposal, not a controller failure. Return without rolling the phase back,
      // logging an error, or re-arming: the phase is already terminal and the timers are being torn down.
      if(this.#isShuttingDown()) {

        this.log.debug("Abandoning the scheduled reboot; the controller is shutting down.");

        return;
      }

      // The reboot command failed (a non-2xx, or a transport-level error). Roll back to `running` so error logging and health observation resume for the retry, and
      // reschedule at the deferral cadence - a failure is just another reason to try again the next time we check. Propagate the cycle start so the ceiling keeps
      // counting cumulative time across deferrals and retries.
      this.transition("running");
      this.log.error("Unable to reboot the Protect controller: %s.", formatErrorMessage(error));

      this.nvrRebootTimer = setTimeout(() => void this.executeScheduledReboot(intervalHours, nextCycleStart), 60 * 1000);

      return;
    }

    // A shutdown that landed while the reboot POST was in flight makes the confirmation and next-cycle arming moot, and the "connectivity will resume" promise would
    // be false against a controller we are disposing. Bail before the info log and before arming either timer.
    if(this.#isShuttingDown()) {

      return;
    }

    this.log.info("Rebooting the Protect controller; connectivity will resume automatically once it returns.");

    // Confirm the reboot actually took effect. A genuine reboot drops the controller's realtime connection within seconds - it arrives as an unsolicited socket close
    // that the unifi-protect library routes straight onto its recovery rail, so connection.isHealthy goes false promptly and stays false for the minutes the controller
    // takes to return. If, after the grace window, we are still `rebooting` AND the connection never went unhealthy, the controller never actually restarted (a silent
    // no-op accept) and we must not stay suppressed on a perfectly healthy controller, so we resume normal monitoring. For a genuine reboot this check is inert - the
    // connection is unhealthy well within the grace, and the recovery edge drives the return instead. The grace is generous headroom over the seconds-scale real drop (a
    // pathologically slow-to-drop controller is the one case this could misread, and it self-heals: the late drop is then handled as an organic disruption). Cleared on
    // the recovery edge and on shutdown.
    this.rebootConfirmTimer = setTimeout(() => {

      this.rebootConfirmTimer = null;

      if((this._phase === "rebooting") && this.client.connection.isHealthy) {

        this.log.warn("The controller did not restart after the reboot command; resuming normal monitoring.");
        this.transition("running");
      }
    }, PROTECT_NVR_REBOOT_CONFIRM_GRACE_MS);

    // Schedule the next reboot cycle at the full interval. We do not block on the outage; the recovery edge returns us to `running` asynchronously.
    this.nvrRebootTimer = setTimeout(() => void this.executeScheduledReboot(intervalHours), intervalHours * 60 * 60 * 1000);
  }

  // The live unifi-protect device config records across every category, flattened. The single read path for the discovery dump, the by-mac lookup, and the orphan sweep,
  // so those readers never re-derive the controller's device inventory from a held snapshot - each is a thin map off the client's live projection collections.
  private get deviceConfigs(): ProtectDeviceConfigTypes[] {

    return [ ...this.client.cameras.map(c => c.config), ...this.client.chimes.map(c => c.config), ...this.client.fobs.map(f => f.config),
      ...this.client.lights.map(c => c.config), ...this.client.relays.map(r => r.config), ...this.client.sensors.map(c => c.config),
      ...this.client.viewers.map(c => c.config) ];
  }

  // Resolve the live config record for a device id within a category, from the unifi-protect projection. The single read path the membership reconcile uses to turn a
  // freshly-adopted id into the record it feeds to addHomeKitDevice.
  private deviceConfig(category: keyof ProtectDeviceTypes, id: string): Nullable<ProtectDeviceConfigTypes> {

    switch(category) {

      case "camera":

        return this.client.camera(id)?.config ?? null;

      case "chime":

        return this.client.chime(id)?.config ?? null;

      case "fob":

        return this.client.fob(id)?.config ?? null;

      case "light":

        return this.client.light(id)?.config ?? null;

      case "relay":

        return this.client.relay(id)?.config ?? null;

      case "sensor":

        return this.client.sensor(id)?.config ?? null;

      case "viewer":

        return this.client.viewer(id)?.config ?? null;

      default:

        exhaustiveGuard(category);

        return null;
    }
  }

  // Resolve a device's config record by MAC from the live projections. Used by the removal log to name a device the controller still reports.
  private deviceConfigByMac(mac: string): Nullable<ProtectDeviceConfigTypes> {

    return this.deviceConfigs.find(config => config.mac === mac) ?? null;
  }

  // Reconcile one device category's HomeKit membership against the controller's current adopted-id set. One engine handles both membership and adoption changes: an
  // adopted id we have not configured is added; a configured device whose id has left the adopted set is
  // removed. The content-memoized adopted-id selectors wake the observe loop only on a genuine membership change (add, removal, or adoption flip), never on the
  // continuous lastSeen/stats churn, so the reconcile cost scales with real membership deltas rather than with refresh frequency. Called once at login with the
  // current snapshot (initial population) and on each subsequent observe yield (ongoing deltas) - one function, both roles.
  private reconcileMembership(category: keyof ProtectDeviceTypes, adoptedIds: readonly string[]): void {

    const { toAdd, toRemove } = membershipDelta(adoptedIds, this.devices(category).map(device => device.protectId));

    // Add any adopted id we have not yet configured, resolving its live config record from the projection.
    for(const id of toAdd) {

      const config = this.deviceConfig(category, id);

      if(config) {

        this.addHomeKitDevice(config);
      }
    }

    // Mark for removal any configured device that has left the adopted set - but ONLY when the controller is stable (good for >= the window). During or right after a
    // disruption we mark nothing; the controller may merely be re-adopting, and the stability sweep re-evaluates once it settles. The content-memoized adopted-id
    // selector already ignores transient disconnect churn (a disconnected-but-adopted device stays in the set), so a toRemove id is a genuine unadopt; the stability gate
    // adds the destructive-action safety on top. Marking honors the user's DelayDeviceRemoval grace before the actual removal.
    if(this.removalStable) {

      for(const id of toRemove) {

        const device = this.getDeviceById(id);

        if(device) {

          this.scheduleDeviceRemoval({ accessory: device.accessory, stillGone: () => !this.adoptedIdSelectors[category](this.client.state.snapshot()).includes(id) });
        }
      }
    }
  }

  // The set of MACs the controller currently reports as adopted by us (not adopted-by-other), from the live unifi-protect projection. The SSOT for "is this device still
  // ours?", read by the orphan sweep's known-set and re-read by each orphan-removal grace predicate so the fire-time check sees the live adopted set, not a stale
  // snapshot.
  private currentAdoptedMacs(): Set<string> {

    return new Set(this.deviceConfigs.filter(config => config.isAdopted && !config.isAdoptedByOther).map(config => config.mac));
  }

  // Sweep cached accessories that are no longer present on the controller. Homebridge restores previously-registered accessories at startup; any belonging to this
  // controller whose device the controller no longer reports as adopted is an orphan we remove. It reads the live adopted-mac projection rather than a held bootstrap.
  // Liveview, security-system, and system-information accessories are managed elsewhere and skipped. Removal runs through the same DelayDeviceRemoval grace as a
  // membership leave, with a fire-time predicate that re-reads the live adopted-mac set so an orphan re-adopted during the grace is not removed.
  private sweepOrphans(): void {

    const knownMacs = this.currentAdoptedMacs();

    for(const accessory of this.platform.accessories.filter(x => x.context.nvr === this.ufp.mac)) {

      if(accessory.context.systemInfo || accessory.context.liveview || accessory.getService(this.hap.Service.SecuritySystem)) {

        continue;
      }

      const mac = accessory.context.mac;

      if(mac && !knownMacs.has(mac)) {

        this.scheduleDeviceRemoval({ accessory: accessory, stillGone: () => !this.currentAdoptedMacs().has(mac) });
      }
    }
  }

  // Spawn the per-category device-membership observe loops, seeding each with an initial population pass. The unifi-protect client's observe() yields on change, not the
  // current value, so each loop reconciles once against the current snapshot before awaiting deltas. The loops are bound to the terminal shutdown signal and assume a
  // stable client for the plugin's connected lifetime - a unifi-protect library invariant, since the ConnectionMonitor recovers an outage without recreating the client.
  // The scheduled reboot rides that same surviving client (it POSTs client.reboot() and lets the connection monitor auto-recover, recreating nothing), so the
  // stable-client assumption holds across a reboot too and the loops never need re-spawning.
  private startDeviceObservers(): void {

    for(const key of Object.keys(this.adoptedIdSelectors) as (keyof ProtectDeviceTypes)[]) {

      const ids = this.adoptedIdSelectors[key];

      // Initial population from the current snapshot, then react to membership deltas.
      this.reconcileMembership(key, ids(this.client.state.snapshot()));

      this.spawnLoop("the " + key + " list", async () => {

        for await (const adoptedIds of this.client.state.observe(ids, { signal: this.signal })) {

          this.reconcileMembership(key, adoptedIds);
        }
      });
    }
  }

  // Recompute the controller's good-state and drive the removal stability clock. Good means running AND reachable AND healthy: phase===running excludes induced
  // disruptions, connection.isHealthy is the unifi-protect library's authoritative reachability fact (it closes the gate promptly on a socket-dropping outage - reboot,
  // network loss, TCP RST - and the symptom-rate health model alone drifts back to healthy during a quiet outage, so we must read the connection fact directly), and
  // health.state===healthy excludes a reachable-but-stressed controller. The remaining conjunct, hasFeature("Device"), means a feature-disabled controller never reaches
  // good-state, so the stability sweep never arms during the disabled-controller startup path (login's sleep window). The conjunct ordering is LOAD-BEARING:
  // this._phase==="running" short-circuits BEFORE this.client.connection.isHealthy, guarding the pre-connect window where this.client is unset (do not reorder).
  // A library throttle makes connection.isHealthy false (it derives the throttled state), so a throttle conservatively resets the clock. On entering good-state we stamp
  // controllerStableSince (uptime-backdated only on the first entry) and arm the one-shot stability sweep; on leaving it we clear the clock, the sweep timer, and EVERY
  // pending removal - the "all bets are off, no destructive action" rule. Idempotent: re-entrant and same-state calls are no-ops. Called from transition() (phase), the
  // health stateChange handler (health), and the connection observe loop (reachability) - the facts good depends on.
  private refreshRemovalStability(): void {

    const good = (this._phase === "running") && this.client.connection.isHealthy && (this.health.state === "healthy") && this.hasFeature("Device");

    if(good && (this.controllerStableSince === null)) {

      const nowMs = Date.now();
      const uptimeMs = this.ufp.upSince ? (nowMs - this.ufp.upSince) : 0;

      this.controllerStableSince = computeStableSince({ hasStabilizedBefore: this.hasStabilizedOnce, nowMs, uptimeMs,
        windowMs: PROTECT_NVR_REMOVAL_STABILITY_WINDOW });
      this.hasStabilizedOnce = true;

      const delay = Math.max(0, (this.controllerStableSince + PROTECT_NVR_REMOVAL_STABILITY_WINDOW) - nowMs);

      // Arm the one-shot sweep. At startup a zero delay re-runs reconcileMembership in a later macrotask, after startDeviceObservers' initial population - that double-
      // reconcile is benign: reconcileMembership is idempotent and sweepOrphans reads the live adopted-mac projection (deviceConfigs), not configuredDevices, so it
      // cannot evict an adopted-but-not-yet-configured accessory regardless of ordering.
      this.stabilityReachedTimer = setTimeout(() => {

        this.stabilityReachedTimer = null;
        this.sweepRemovableDevices();
      }, delay);

      return;
    }

    if(!good && (this.controllerStableSince !== null)) {

      this.controllerStableSince = null;

      if(this.stabilityReachedTimer) {

        clearTimeout(this.stabilityReachedTimer);
        this.stabilityReachedTimer = null;
      }

      this.cancelAllDeviceRemovals();
    }
  }

  // Whether the controller has been continuously good for at least the stability window - the gate every destructive removal must pass.
  private get removalStable(): boolean {

    return isStabilityWindowElapsed({ nowMs: Date.now(), stableSinceMs: this.controllerStableSince, windowMs: PROTECT_NVR_REMOVAL_STABILITY_WINDOW });
  }

  // Re-assess the full device inventory now that the controller is stable, marking for (graced) removal anything genuinely gone. The one-time sweep on reaching
  // stability: immediate at startup for a controller already up past the window (the uptime backdate), the window after any recovery otherwise. Cache cleanup is
  // stability-gated along with membership removal, so a cached orphan is removed only once the controller has held good for the window.
  private sweepRemovableDevices(): void {

    if(!this.removalStable) {

      return;
    }

    for(const key of Object.keys(this.adoptedIdSelectors) as (keyof ProtectDeviceTypes)[]) {

      this.reconcileMembership(key, this.adoptedIdSelectors[key](this.client.state.snapshot()));
    }

    this.sweepOrphans();

    // The package-camera pass: reconcile each doorbell's package camera against the live capability flag. This sweep is both the construction-time arm (it runs at
    // the first post-startup stability, catching a capability withdrawn while the plugin was down - the across-restart ghost a cached BRIDGED package accessory would
    // otherwise be forever, since the orphan sweep keys on a mac the package deliberately lacks) and the re-arm (a detach grace dropped by cancelAllDeviceRemovals,
    // or a fire that failed its stability re-check, is re-scheduled when stability returns).
    for(const device of this.devices("camera")) {

      // Gate the package reconcile on the parent record being present: reconcilePackageCamera reads the parent's featureFlags and MAC, which would
      // throw for a camera lingering in the removal grace. A device with a vanished record is on its way out, so skipping it is correct.
      if(device.recordPresent) {

        device.doorbell?.reconcilePackageCamera();
      }
    }
  }

  /* Mark an accessory for removal, honoring the DelayDeviceRemoval grace. This is the single removal chokepoint every controller-state-driven removal routes
   * through, and the stability policy lives here: nothing schedules unless the controller has been continuously good for the stability window. The membership and
   * orphan callers pre-gate on removalStable before calling, so the in-chokepoint gate is deliberately redundant for them - it exists so the policy holds for every
   * caller by construction rather than by caller discipline. Idempotent per accessory (a re-yield while it stays gone keeps the original deadline). With the grace
   * disabled (interval 0) we remove immediately - the stability gate already provided the safety. The stillGone predicate is re-evaluated at fire against live state
   * (the caller supplies it: the category selector for a membership leave, the adopted-mac set for a cache orphan, the capability flag for a package detach), and we
   * re-confirm stability at fire, so a device that returned during the grace is not removed. Keyed by accessory UUID - the one id shared by a membership leave, an
   * id-less orphan, and a package camera.
   *
   * @param options - accessory: the accessory to remove; reason: an optional user-facing sentence logged once at schedule time, on both the immediate and the
   *                  deferred paths; remove: the removal action the decision runs, defaulting to removeHomeKitDevice; stillGone: the fire-time re-check against
   *                  live controller state.
   */
  public scheduleDeviceRemoval(options: { accessory: ProtectAccessory; reason?: string; remove?: () => void; stillGone: () => boolean }): void {

    const { accessory, reason, stillGone } = options;
    const remove = options.remove ?? ((): void => this.removeHomeKitDevice(accessory));

    if(!this.removalStable) {

      return;
    }

    if(this.deviceRemovalTimers.has(accessory.UUID)) {

      return;
    }

    const delayInterval = this.getFeatureNumber("Nvr.DelayDeviceRemoval") ?? 0;

    // Narrate the removal decision once, at schedule time, when the caller supplied a reason - the one user-facing message for the whole removal flow.
    if(reason) {

      this.log.info(reason);
    }

    if(delayInterval <= 0) {

      remove();

      return;
    }

    this.log.info("%s: Delaying device removal for at least %s second%s.", accessory.displayName, delayInterval, delayInterval > 1 ? "s" : "");

    this.deviceRemovalTimers.set(accessory.UUID, setTimeout(() => {

      this.deviceRemovalTimers.delete(accessory.UUID);

      if(this.removalStable && stillGone()) {

        remove();
      }
    }, delayInterval * 1000));
  }

  // Cancel a single pending delayed removal by accessory UUID (a returning orphan via addHomeKitDevice, or a package-capability return via the doorbell's
  // reconcile). Idempotent.
  public cancelDeviceRemovalFor(uuid: string): void {

    const timer = this.deviceRemovalTimers.get(uuid);

    if(timer) {

      clearTimeout(timer);
      this.deviceRemovalTimers.delete(uuid);
    }
  }

  // Cancel every pending delayed removal. Called when the controller leaves good-state (no destructive action during a disruption). Idempotent.
  private cancelAllDeviceRemovals(): void {

    for(const timer of this.deviceRemovalTimers.values()) {

      clearTimeout(timer);
    }

    this.deviceRemovalTimers.clear();
  }

  // Spawn the connection-state observe loop - the single consumer of connection.observe(), carrying two controller-wide duties on each transition. First it concludes an
  // induced reboot on the connection's recovery edge (so the resume rides this existing iterator rather than a second subscription); then it pushes recomputed
  // reachability to every accessory. Controller health is one fact with one reader: rather than N accessories each subscribing to the connection monitor (which would be
  // 2N iterators and N readers of a single fact), this loop walks the configured accessories and pushes each its recomputed reachability. An accessory whose
  // HomeKit-visible reachability actually flipped is published on the reachability-fanout diagnostics channel. Pull where the fact is per-device (the per-device leaf
  // observers); push where the fact is controller-wide (here). Package cameras ride the endpoints iterator, so their reachability is pushed - and published on the
  // fanout channel - first-class rather than fanned out by the parent doorbell.
  private startConnectionObserver(): void {

    this.spawnLoop("the controller connection", async () => {

      for await (const transition of this.client.connection.observe({ signal: this.signal })) {

        // Conclude an induced reboot the moment the connection recovers - a non-healthy -> healthy edge while rebooting. The decision is the pure
        // shouldResumeFromInducedReboot; this is the single existing consumer of the connection-state stream, so the check rides here rather than a second subscription.
        // We do it before the stability re-evaluation below so a resume's transition("running") + health.reset() land first, and that step sees the running phase.
        if(shouldResumeFromInducedReboot({ from: transition.from, phase: this._phase, to: transition.to })) {

          this.resumeFromInducedReboot();
        }

        // Re-evaluate the removal stability clock - reachability is the third fact `good` depends on, and this is the load-bearing driver. An organic outage publishes
        // only a lifecycle event (controllerLost emits no phase or health change) and the symptom-rate health model drifts back to healthy during a quiet outage, so
        // without re-evaluating here on every connection-state transition a grace timer could fire mid-outage. connection.observe() yields on every state change
        // (degraded / lost / reconnecting / healthy), so reading connection.isHealthy here is what closes the gate the moment a socket-dropping outage begins.
        this.refreshRemovalStability();

        for(const device of this.deviceEndpoints()) {

          const flip = device.refreshReachability();

          if(flip && channels.reachabilityFanout.hasSubscribers) {

            channels.reachabilityFanout.publish({ accessoryId: device.accessory.UUID, now: flip.now, was: flip.was } satisfies ReachabilityFanoutPayload);
          }
        }
      }
    });
  }

  // Fire-and-forget an NVR-level background loop. superviseLoop owns the detached resilience envelope - swallow on shutdown abort, surface a fault once via
  // loopFaultReporter; this method binds every loop to the terminal shutdown signal and voids the result deliberately - a loop's lifetime is that signal, not an await.
  private spawnLoop(title: string, loop: () => Promise<void>): void {

    void superviseLoop({ loop, onError: loopFaultReporter(this.log, title), signal: this.signal });
  }

  /* Construct a doorbell capability for a camera that the controller reports as a doorbell. Constructing a device-family object is graph-assembly knowledge, which lives
   * at the composition root - the camera keeps the entire lifecycle DECISION (it observes the flag and decides WHEN to attach), and only the new lands here. This method
   * holds zero policy: one new, on request, by the decision-owner. Routing construction upward rides the codebase invariant that device-layer objects reach the NVR only
   * through inherited fields, never value-imports - so the camera calling this DURING its own construction forms no module import edge, and the device layer is
   * structurally cycle-proof. It is safe to call mid-construction because the method has no dependence on NVR state being mutated at that time.
   */
  public createDoorbellCapability(camera: ProtectCamera, device: Camera, signal: AbortSignal): DoorbellCapability {

    return new DoorbellCapability(this, { camera: camera, device: device, signal: signal });
  }

  // Construct a package camera for a doorbell capability that has provisioned one. The same graph-assembly reasoning as createDoorbellCapability: the capability keeps
  // the entire lazy decision (the package-flag observer, the stability sweep, the private parent projection), and only the new moves here. The capability passes the
  // accessory it created or found plus its own parent projection; this method holds one new and no policy.
  public createPackageCamera(accessory: ProtectAccessory, device: Camera): ProtectCameraPackage {

    return new ProtectCameraPackage(this, accessory, device);
  }

  // Remove the doorbell-only services a demoted-while-down doorbell left on a now-plain camera accessory - the sweep-stale removal the camera's reconcile runs when the
  // controller does not report a doorbell and no capability is attached. The removal logic is the DoorbellCapability's own SSOT (it owns the doorbell-only service set);
  // this seam routes the camera's request through the composition root so the camera never value-imports the sibling capability class - the same removal-machinery-at-the
  // -root rule the package sweep follows, keeping the device layer structurally cycle-proof (sibling device classes are type-only in the device leaves).
  public removeStaleDoorbellServices(accessory: ProtectAccessory): void {

    DoorbellCapability.removeServices(accessory, this.hap, this.log);
  }

  // Create instances of Protect device types in our plugin.
  private addProtectDevice(accessory: ProtectAccessory, device: ProtectDeviceConfigTypes): Nullable<ProtectDevice> {

    const deviceName = device.name ?? device.marketName;

    switch(device.modelKey) {

      case "camera": {

        // We have a UniFi Protect camera or doorbell. We resolve the live unifi-protect projection for this id and inject it into the accessory;
        // the projection-acquisition policy lives here at the composition root, which knows the concrete type at the point of adoption. The handle is null only when the
        // record has not yet reduced, in which case there is nothing to adopt.
        const camera = this.client.camera(device.id);

        if(!camera) {

          break;
        }

        // Always a ProtectCamera. A device the controller reports as a doorbell attaches its DoorbellCapability through the camera's own construction-time reconcile,
        // so there is one construction path for both arrival timings (doorbell-at-adoption and a late isDoorbell flip).
        this.configuredDevices.set(accessory.UUID, new ProtectCamera(this, accessory, camera));

        break;
      }

      case "chime": {

        // We have a UniFi Protect chime.
        const chime = this.client.chime(device.id);

        if(!chime) {

          break;
        }

        this.configuredDevices.set(accessory.UUID, new ProtectChime(this, accessory, chime));

        break;
      }

      case "fob": {

        // We have a UniFi Protect fob.
        const fob = this.client.fob(device.id);

        if(!fob) {

          break;
        }

        this.configuredDevices.set(accessory.UUID, new ProtectFob(this, accessory, fob));

        break;
      }

      case "light": {

        // We have a UniFi Protect light.
        const light = this.client.light(device.id);

        if(!light) {

          break;
        }

        this.configuredDevices.set(accessory.UUID, new ProtectLight(this, accessory, light));

        break;
      }

      case "relay": {

        // We have a UniFi Protect relay.
        const relay = this.client.relay(device.id);

        if(!relay) {

          break;
        }

        this.configuredDevices.set(accessory.UUID, new ProtectRelay(this, accessory, relay));

        break;
      }

      case "sensor": {

        // We have a UniFi Protect sensor.
        const sensor = this.client.sensor(device.id);

        if(!sensor) {

          break;
        }

        this.configuredDevices.set(accessory.UUID, new ProtectSensor(this, accessory, sensor));

        break;
      }

      case "viewer": {

        // We have a UniFi Protect viewer.
        const viewer = this.client.viewer(device.id);

        if(!viewer) {

          break;
        }

        this.configuredDevices.set(accessory.UUID, new ProtectViewer(this, accessory, viewer));

        break;
      }

      default:

        // Ensure we handle every device type the Protect API can send us. If a new device category is added upstream, this will flag it at compile time rather
        // than silently ignoring it at runtime.
        exhaustiveGuard(device);
        this.log.error("Unknown device class detected for %s.", deviceName);

        return null;
    }

    // Return our newly created device.
    return this.configuredDevices.get(accessory.UUID) ?? null;
  }

  // Add a newly detected Protect device to HomeKit.
  public addHomeKitDevice(device: ProtectDeviceConfigTypes): boolean {

    // If we have no controller MAC, no device MAC, or this device isn't adopted by this controller, we're done.
    if(!this.ufp.mac || !device.mac || device.isAdoptedByOther || !device.isAdopted) {

      return false;
    }

    // We only support certain devices.
    if(!ProtectDeviceCategories.includes(device.modelKey)) {

      // If we've already informed the user about this one, we're done.
      if(this.unsupportedDevices[device.mac]) {

        return false;
      }

      // Notify the user we see this device, but we aren't adding it to HomeKit.
      this.unsupportedDevices[device.mac] = true;

      this.log.info("UniFi Protect device type %s is not currently supported, ignoring: %s.", device.modelKey, describeDevice(device));

      return false;
    }

    // Generate this device's unique identifier.
    const uuid = this.hap.uuid.generate(device.mac);

    // A device arriving here is being (re)adopted, so cancel any pending delayed removal keyed on its accessory UUID - the orphan-return path: an accessory whose grace
    // was armed by the startup orphan sweep, then re-adopted before the grace fired. We key on the always-defined `uuid` (not the find() below, which is undefined for a
    // brand-new device and would throw), and we cancel here, ahead of the feature-disabled reject and the add, so the return path is covered regardless of which branch
    // it takes. A membership-leave grace needs no eager cancel: such a device stays in configuredDevices while pending, so on return it is in neither toAdd nor toRemove
    // and never reaches here; its fire-time stillGone() re-check is the authoritative no-op.
    this.cancelDeviceRemovalFor(uuid);

    // See if we already know about this accessory.
    let accessory = this.platform.accessories.find(x => x.UUID === uuid);

    // Enable or disable certain devices based on configuration parameters.
    if(!this.hasFeature("Device", device)) {

      if(accessory) {

        this.removeHomeKitDevice(accessory);
      }

      return false;
    }

    // We've got a new device, let's add it to HomeKit.
    if(!accessory) {

      accessory = new this.api.platformAccessory<ProtectAccessoryContext>(sanitizeName(device.name ?? device.marketName), uuid);

      this.log.info("%s: Adding %s to HomeKit%s.", describeDevice(device), device.modelKey,
        this.hasFeature("Device.Standalone", device) ? " as a standalone device" : "");

      // Register this accessory with homebridge and add it to the accessory array so we can track it.
      if(this.hasFeature("Device.Standalone", device)) {

        this.api.publishExternalAccessories(PLUGIN_NAME, [accessory]);
      } else {

        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }

      this.platform.accessories.push(accessory);
      this.api.updatePlatformAccessories(this.platform.accessories);
    }

    // Setup the accessory as a new Protect device in the plugin if we haven't configured it yet. A device we already track needs no action here: its state now arrives
    // through the per-device observe loops, not a synthetic refresh re-emit, so there is nothing to re-merge.
    if(!this.configuredDevices.has(accessory.UUID)) {

      this.addProtectDevice(accessory, device);
    }

    return true;
  }

  // Remove an individual Protect accessory from HomeKit. The pure immediate remover: every guard and the package-camera cascade run here. The DelayDeviceRemoval grace
  // is decided in scheduleDeviceRemoval before this method runs, so by the time removeHomeKitDevice is called the decision to remove was already made and graced. The
  // disabled-controller sweep, the self-reject in addHomeKitDevice, and a fired removal grace all call straight through here.
  public removeHomeKitDevice(accessory: ProtectAccessory): void {

    // Ensure that this accessory hasn't already been removed.
    if(!this.platform.accessories.some(x => x.UUID === accessory.UUID)) {

      return;
    }

    // We only remove devices if they're on the Protect controller we're interested in.
    if(accessory.context.nvr !== this.ufp.mac) {

      return;
    }

    // The NVR system information accessory is handled elsewhere.
    if(accessory.context.systemInfo) {

      return;
    }

    // Liveview-centric accessories are handled elsewhere.
    if(accessory.context.liveview || accessory.getService(this.hap.Service.SecuritySystem)) {

      return;
    }

    // We only store MAC addresses on devices that exist on the Protect controller. Any other accessories created are ones we created ourselves and are managed
    // elsewhere, with one exception - package cameras. If we have a matching parent camera for the package camera, we're done here. Package cameras are dealt with
    // when we remove the parent camera. If the parent doesn't exist, this is an orphan that we need to remove.
    if(!accessory.context.mac &&
      (!accessory.context.packageCamera || (this.platform.accessories.some(x => x.context.mac === accessory.context.packageCamera)))) {

      return;
    }

    // Grab our instance of the Protect device, if it exists.
    const protectDevice = this.configuredDevices.get(accessory.UUID);

    // Reclaim any livestream-episode latch entries for the camera being removed (a started-but-never-recovered episode would otherwise never drain). Keyed off the
    // device's id, which is the cameraId the latch entries carry; a non-camera device's id matches nothing, so this is a no-op scan of a small map for them.
    if(protectDevice?.protectId) {

      this.livestreamEpisodes.forgetCamera(protectDevice.protectId);
    }

    // See if we can pull the device's configuration details from our Protect device instance or the controller projection.
    //
    // The by-MAC controller projection backs the removal descriptor only when the wrapper's record has vanished (or there is no wrapper). While the record is
    // present, the wrapper's own live config carries the descriptor, so the projection lookup is never evaluated on that path - it is lazy by construction.
    const byMac = (!protectDevice?.recordPresent && accessory.context.mac) ? this.deviceConfigByMac(accessory.context.mac) : null;

    // The removal descriptor: the wrapper's live config while its record is present, recombining the bare MAC the narrowed state view no longer carries. The mac is
    // recombined ONLY to satisfy the descriptor's required-field type - the plain-mode log line below does not read it (mac would surface only under includeNetwork).
    const descriptor = (protectDevice?.recordPresent ? { ...protectDevice.ufp, mac: protectDevice.mac } : null) ?? byMac;

    // The model category drives the log label and the package-camera cascade; read it non-throwing from the wrapper while its record is present, else the by-MAC lookup.
    const modelKey = (protectDevice?.recordPresent ? protectDevice.modelKey : null) ?? byMac?.modelKey;

    this.log.info("%s: Removing %s from HomeKit.%s",
      descriptor ? describeDevice(descriptor) : protectDevice?.accessoryName ?? accessory.displayName,
      modelKey ?? "device",
      accessory._associatedHAPAccessory.bridged ? "" : " You will need to manually delete the device in the Home app to complete the removal.");

    const deletingAccessories = [accessory];

    // If it's an unknown device or a camera, look for a corresponding package camera if we have one and remove it as well.
    if(!descriptor || (modelKey === "camera")) {

      const packageCameraAccessory = this.platform.accessories.find(x => x.context.packageCamera === accessory.context.mac);

      // Remove the package camera, if it exists, and cleanup the device if it has been configured.
      if(packageCameraAccessory) {

        deletingAccessories.push(packageCameraAccessory);
      }
    }

    // Cleanup our device instance.
    protectDevice?.cleanup();

    // Finally, remove it from our list of configured devices and HomeKit.
    this.configuredDevices.delete(accessory.UUID);

    // Remove each accessory through the shared tail. Cancelling any pending delayed removal per accessory first kills the cascade-then-stale-timer double fire: a
    // cascade-removed package camera may hold its own pending detach grace, which must never fire against an accessory this removal already handled.
    for(const targetAccessory of deletingAccessories) {

      this.cancelDeviceRemovalFor(targetAccessory.UUID);
      this.removeAccessoryFromHomeKit(targetAccessory);
    }
  }

  /* Remove an accessory from HomeKit and the platform's accessory list - the shared removal tail that removeHomeKitDevice and the package camera's graced detach
   * both end in. Unregistration is gated on the accessory actually being bridged: hap-nodejs throws on unregistering a never-bridged (standalone) accessory, whose
   * HomeKit-side removal is the user's in the Home app. The presence guard makes a stale double-fire a harmless no-op - an indexOf miss would otherwise splice(-1)
   * and silently delete the LAST accessory in the platform array. Logs nothing: the caller owns the user-facing narration.
   */
  public removeAccessoryFromHomeKit(accessory: ProtectAccessory): void {

    const index = this.platform.accessories.indexOf(accessory);

    if(index === -1) {

      return;
    }

    // Unregister the accessory from HomeKit if we have a bridged accessory. Unbridged accessories are managed directly by users in the Home app.
    if(accessory._associatedHAPAccessory.bridged) {

      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }

    this.platform.accessories.splice(index, 1);

    // Tell Homebridge to save the updated list of accessories.
    this.api.updatePlatformAccessories(this.platform.accessories);
  }

  // Return all devices of a particular modelKey.
  private devices<T extends keyof ProtectDeviceTypes>(model?: T): ProtectDeviceTypes[T][] {

    // The cast is safe because every device's modelKey is set consistently with its concrete class per the ProtectDeviceTypes mapping, so the runtime filter above
    // and the type-level narrowing below agree even though TypeScript cannot infer that relationship through the generic parameter on its own.
    return [...this.configuredDevices.values()].filter(device => device.modelKey === model) as ProtectDeviceTypes[T][];
  }

  // Iterate every HomeKit device endpoint this controller manages: each configured device and, immediately after a camera-family device that carries one, its package
  // camera. Package cameras hang off the doorbell capability composed on their parent camera rather than configuredDevices, so any controller-wide push (the reachability
  // fan-out, the probesize reset, the disconnect teardown) walks this iterator instead of hand-fanning the package at each site. Consumers that need camera-typed members
  // narrow with instanceof ProtectCamera - sound and cast-free, since package cameras are ProtectCamera subclasses, and the parent's packageCamera getter delegates to
  // the capability.
  private *deviceEndpoints(): Generator<ProtectDevice> {

    for(const device of this.configuredDevices.values()) {

      yield device;

      if((device instanceof ProtectCamera) && device.packageCamera) {

        yield device.packageCamera;
      }
    }
  }

  // Resolve the reachability of the camera whose livestream recovery is being decided, for the recovery policy's unavailable-defer gate (step 3). Both getDeviceById and
  // the total isReachable are non-throwing, so a camera whose controller record has vanished (unadopted, lingering in the removal grace) or whose id is unresolvable
  // reports unavailable rather than throwing into the policy closure. That routes the episode to the bounded unavailable-defer: the policy never reboots the camera and
  // never tears the session down, so a re-adopt within the grace resumes the stream seamlessly, and a genuine removal is cleaned up by the subscription disposal at
  // the grace's end, not by the policy. A package-camera substream carries its PARENT camera's id, so this resolves the parent and reads the parent's reachability,
  // which is correct since there is no separate package device.
  private episodeCameraReachable(cameraId: string): boolean {

    return this.getDeviceById(cameraId)?.isReachable ?? false;
  }

  // Return the Protect device object based on its unique device identifier, if it exists.
  public getDeviceById(deviceId: string): Nullable<ProtectDevices> {

    // Find the device. We match on the non-throwing projection id (protectId), so a wrapper whose controller record has vanished (a device in the removal grace)
    // resolves without throwing - the property every firehose lookup, the membership engine, and the recovery policy depend on being total.
    return [...this.configuredDevices.values()].find(device => device.protectId === deviceId) ?? null;
  }

  // Utility function to return a floating point configuration parameter on a device.
  public getFeatureFloat(option: string): Nullable<number | undefined> {

    return this.platform.featureOptions.getFloat(option, this.ufp.mac);
  }

  // Utility function to return an integer configuration parameter on a device.
  public getFeatureNumber(option: string): Nullable<number | undefined> {

    return this.platform.featureOptions.getInteger(option, this.ufp.mac);
  }

  // Utility for checking the scope of feature options on the NVR.
  public isNvrFeature(option: string, device?: ProtectDeviceConfigTypes | ProtectNvrConfig): boolean {

    return [ "global", "controller" ].includes(this.platform.featureOptions.scope(option, device?.mac, this.ufp.mac));
  }

  // Utility for checking feature options on the NVR.
  public hasFeature(option: string, device?: ProtectDeviceConfigTypes | ProtectNvrConfig): boolean {

    return this.platform.featureOptions.test(option, device?.mac, this.ufp.mac);
  }

  // Utility for logging feature option availability on the NVR.
  public logFeature(option: string, message: string): void {

    option = option.toLowerCase();

    // Only log something if we haven't already informed the user about it previously and it's scoped to the NVR or globally.
    if(this.featureLog[option] || !this.isNvrFeature(option)) {

      return;
    }

    this.featureLog[option] = true;

    this.log.info(message);
  }
}
