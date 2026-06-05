/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-nvr.ts: NVR device class for UniFi Protect.
 */
import type { API, HAP, PlatformAccessory } from "homebridge";
import { APIEvent, MqttClient, loopFaultReporter, retry, sanitizeName, superviseLoop } from "homebridge-plugin-utils";
import type { HomebridgePluginLogging, Nullable } from "homebridge-plugin-utils";
import type { HttpRequestEndPayload, ProtectLogging, ProtectNvrConfig, ProtectState } from "unifi-protect";
import type { NvrLifecyclePayload, ReachabilityFanoutPayload } from "./diagnostics.ts";
import { PLATFORM_NAME, PLUGIN_NAME, PROTECT_M3U_PLAYLIST_PORT, PROTECT_NVR_REBOOT_DEFERRAL_MAX, PROTECT_NVR_REBOOT_INTERVAL, PROTECT_NVR_REBOOT_MIN_INTERVAL,
  PROTECT_NVR_REBOOT_RECONNECT_DELAY } from "./settings.ts";
import { ProtectCamera, ProtectChime, ProtectDoorbell, ProtectLight, ProtectLiveviews, ProtectNvrSystemInfo, ProtectSensor, ProtectViewer } from "./devices/index.ts";
import { ProtectClient, channels as protectChannels, selectAdoptedCameraIds, selectAdoptedChimeIds, selectAdoptedLightIds, selectAdoptedSensorIds,
  selectAdoptedViewerIds } from "unifi-protect";
import { ProtectDeviceCategories, exhaustiveGuard } from "./types.ts";
import type { ProtectDeviceConfigTypes, ProtectDeviceTypes, ProtectDevices } from "./types.ts";
import { createConnectRetryPolicy, isSuccessfulRequest, membershipDelta } from "./nvr-policy.ts";
import { NvrHealth } from "./nvr-health.ts";
import type { ProtectDevice } from "./devices/index.ts";
import { ProtectEventDispatch } from "./event-dispatch.ts";
import type { ProtectNvrOptions } from "./options.ts";
import type { ProtectPlatform } from "./platform.ts";
import { channels } from "./diagnostics.ts";
import http from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import util from "node:util";

/**
 * The legacy v4 command surface. Under v5 there is no `ProtectApi` god-object: device configuration writes are `camera.update(...)` / `light.update(...)` etc.,
 * snapshots are a camera operation, controller reboot is `client.reboot()`, and raw requests go through `client.transport`. The ~13 device files that still issue
 * v4-shaped commands (`this.nvr.ufpApi.updateDevice`, `.getSnapshot`, `.retrieve`, `.responseOk`, `.enableRtsp`, `.bootstrap`, ...) are migrated to those v5 homes in
 * Phase 2 (commands) and Phase 3 (media). Until then this field is the name they reference.
 *
 * It is typed `unknown`-free `any` deliberately - **not** as a faithful interface. Its members migrate to disparate v5 surfaces, so there is no single honest type to
 * give it; authoring a faithful stub would re-type the entire v4 command and bootstrap shape (cascading into the consumer logic that traverses those return values) -
 * gold-plating a corpse and pulling Phase-2/3 typing forward, the very work the phase boundary defers. The pre-existing `no-unsafe-*` lint findings at those call sites
 * are the honest, compiler-tracked markers of that remaining work; each clears when its caller migrates, and this field is deleted with its last consumer.
 *
 * It is never constructed: `new ProtectApi()` is gone, so this is permanently `undefined` at runtime. Every legacy command therefore throws until it migrates - correct,
 * because the plugin does not function intra-migration (the gates measure type-check and test correctness, not runtime), and each call site is rewritten before it ships.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ProtectLegacyApi = any;

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
  // The v5 client - the single owner of protocol truth (reduced state, realtime decode, refresh failsafe, connection health). Established by connect() via
  // ProtectClient.connect() and torn down through its Symbol.asyncDispose. Definite-assignment typed for the connected lifetime; it is genuinely undefined only in the
  // narrow window before the first connect() (guarded where that window is reachable, e.g. disconnect()).
  public client!: ProtectClient;
  public readonly config: ProtectNvrOptions;
  public readonly configuredDevices: Map<string, ProtectDevices>;
  // The per-client connection-health subscriptions (throttle rails and controller-lost/recovered lifecycle). Re-wired on every connect() against the live client and
  // disposed on disconnect(), so they never outlive the client whose connection monitor they observe.
  private connectionSubscriptions: Disposable[];
  private deviceRemovalQueue: Map<string, number>;
  public readonly events: ProtectEventDispatch;
  private featureLog: Record<string, boolean>;
  private hap: HAP;
  public readonly health: NvrHealth;
  private liveviews: Nullable<ProtectLiveviews>;
  public readonly log: HomebridgePluginLogging;
  public mqtt: Nullable<MqttClient>;
  private name: string;
  private nvrRebootTimer: Nullable<NodeJS.Timeout>;
  // Lifecycle phase. The SSOT for "what is this NVR doing right now?". Consumed by components that need to distinguish induced from organic disruption.
  // Mutated only through `transition()`, never directly.
  private _phase: NvrPhase;
  public readonly platform: ProtectPlatform;
  // The terminal plugin-shutdown abort. Aborted once, in transition("shuttingDown"); every Phase-1 observe loop and every per-accessory controller composes against
  // it, so plugin shutdown tears the whole tree down as one cascade. Initialized in the constructor so it exists before any device is constructed.
  readonly #shutdownController: AbortController;
  public systemInfo: Nullable<ProtectNvrSystemInfo>;
  public readonly ufpApi: ProtectLegacyApi;
  private unsupportedDevices: Record<string, boolean>;
  // The v5 client logger. Shares the controller-log destination but gates error output through `logApiErrors` so induced-disruption noise is suppressed, exactly as the
  // v4 ProtectApi logger did. Typed as v5's own ProtectLogging seam so it is single-sourced with the contract ProtectClient.connect() expects.
  private readonly clientLog: ProtectLogging;

  constructor(platform: ProtectPlatform, nvrOptions: ProtectNvrOptions) {

    this.api = platform.api;
    this.config = nvrOptions;
    this.configuredDevices = new Map();
    this.connectionSubscriptions = [];
    this.deviceRemovalQueue = new Map();
    this.featureLog = {};
    this.hap = this.api.hap;
    this.liveviews = null;
    this.mqtt = null;
    this.name = nvrOptions.name ?? nvrOptions.address;
    this.nvrRebootTimer = null;
    this._phase = "connecting";
    this.platform = platform;
    this.#shutdownController = new AbortController();
    this.systemInfo = null;
    this.unsupportedDevices = {};

    // Configure the v5 client logging. Error output is gated by `logApiErrors` so induced disruptions stay quiet.
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
    // inputs are wired below (request outcomes) and in connect() (throttle rails), so they flow from the v5 client's observability surface without each call site
    // needing its own hook.
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
    });

    // Initialize our UniFi Protect event handler.
    this.events = new ProtectEventDispatch(this);

    // Validate our Protect address and login information.
    if(!nvrOptions.address || !nvrOptions.username || !nvrOptions.password) {

      return;
    }

    // Wire the NVR-health request-outcome inputs from v5's process-global HTTP diagnostics channel. The channel carries every request from every client in the
    // process, so we filter by this controller's host to keep each NVR's health scoped to its own controller. A 2xx is recovery evidence; everything else (an error,
    // or a non-2xx status) is a stress symptom. Wired here - past the address guard, so a misconfigured controller never subscribes - and detached on the terminal
    // shutdown signal (which the SHUTDOWN handler below guarantees fires). Observation is gated by the health observer's own suspend/resume, so symptoms during
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

    // Cleanly shut down on Homebridge exit.
    this.api.on(APIEvent.SHUTDOWN, () => {

      // Clear the scheduled reboot timer if it's running.
      if(this.nvrRebootTimer) {

        clearTimeout(this.nvrRebootTimer);
        this.nvrRebootTimer = null;
      }

      // Mark the lifecycle phase before tearing down. This is the single chokepoint that aborts the terminal shutdown signal, so every observe loop unwinds as one
      // cascade. Components that surface "unexpected teardown" warnings (e.g., the recording delegate) consult `nvr.phase` to suppress noise during induced
      // disruptions; without this transition the disconnect below would fan out as if cameras were failing unexpectedly.
      this.transition("shuttingDown");

      // Disconnect from the controller. This tears down active HomeKit streams, HKSV timeshift buffers, and the v5 client connection.
      void this.disconnect();
    });
  }

  /**
   * Current lifecycle phase. Components that need to distinguish induced disruption (rebooting, shutting down) from organic operation (running) consult this
   * property. Pure read - mutation goes through {@link transition} only.
   */
  public get phase(): NvrPhase {

    return this._phase;
  }

  /**
   * The terminal plugin-shutdown abort signal. Aborted exactly once, in `transition("shuttingDown")`. Every Phase-1 observe loop and every per-accessory abort
   * controller composes against it, so plugin shutdown tears the whole tree down as one cascade. Pure read - the controller is private and aborted only through the
   * transition chokepoint.
   */
  public get signal(): AbortSignal {

    return this.#shutdownController.signal;
  }

  /**
   * Read-through NVR configuration. Replaces the held bootstrap snapshot with the live v5 projection, so every `nvr.ufp.<field>` read across the plugin reflects the
   * current reduced state with no merge and no reassignment. A read before the first successful connect() throws (the getter dereferences `this.client`, which is unset
   * until connect() assigns it) - this is deliberate: a too-early read should fail loudly, not silently return a stale snapshot, which is the held-state footgun this
   * migration removes. No code path reaches that throw: the constructor and the only other pre-connect path (`login()`'s global enable gate) both avoid `ufp` - the
   * gate consults feature options by global scope, not the controller mac, and `ProtectEventDispatch` construction is now structural-only (it no longer reads
   * `hasFeature`/`ufp`).
   */
  public get ufp(): Readonly<ProtectNvrConfig> {

    return this.client.nvr.config;
  }

  /**
   * Whether API error logging is currently surfaced to the user. Derived from phase: errors are visible during `connecting` (so credential or address problems
   * reach the user) and `running` (organic errors are real signal), but suppressed during `rebooting` and `shuttingDown` where the errors are induced by our own
   * teardown. Read by the v5 client logger callback in this NVR's constructor.
   */
  public get logApiErrors(): boolean {

    return (this._phase === "running") || (this._phase === "connecting");
  }

  // Move the NVR to a new lifecycle phase. The single chokepoint that keeps every derived effect aligned: it updates `_phase`, aborts the terminal shutdown signal on
  // entry to `shuttingDown`, then drives `health.suspend()` / `health.resume()` so the symptom observer matches whether we're in an induced disruption or organic
  // operation. The `logApiErrors` getter is pure-derived from `_phase` and needs no explicit update here.
  //
  // Idempotent on same-phase transitions. Components that need to react to phase changes can subscribe via the existing API or query `phase` directly.
  private transition(next: NvrPhase): void {

    if(this._phase === next) {

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
  }

  // Publish an NVR-level lifecycle milestone on the forward-only diagnostics channel. Zero-cost when no subscriber is attached (the Node-native sync check).
  private publishLifecycle(event: NvrLifecyclePayload["event"]): void {

    if(channels.nvrLifecycle.hasSubscribers) {

      channels.nvrLifecycle.publish({ event } satisfies NvrLifecyclePayload);
    }
  }

  // Establish a connection to the Protect controller. v5's ProtectClient.connect() is atomic - it logs in, fetches the initial bootstrap, seeds the reducer, and
  // brings up the realtime events channel as one ready-or-throws operation, owning retry/backoff and the periodic refresh failsafe internally. We wrap it in a
  // startup-resilient retry: authentication faults get a small consecutive budget so a controller still sorting out its own auth recovers, but genuinely-wrong
  // credentials fail fast rather than looping forever (the v4 defect); any non-auth fault resets the budget and retries unbounded until the controller appears or
  // the shutdown signal aborts. Safe to call multiple times - each call establishes a fresh client.
  private async connect(): Promise<boolean> {

    const { shouldRetry } = createConnectRetryPolicy();

    try {

      this.client = await retry((signal) => ProtectClient.connect({ host: this.config.address, log: this.clientLog, password: this.config.password, signal,
        username: this.config.username }), { attempts: Infinity, shouldRetry, signal: this.signal });
    } catch(error) {

      // The shutdown signal aborting the retry is an orderly teardown, not a failure to report. A genuine auth budget exhaustion (wrong credentials) surfaces here.
      if(this.signal.aborted) {

        return false;
      }

      this.log.error("Unable to connect to the Protect controller: %s.", (error instanceof Error) ? error.message : String(error));

      return false;
    }

    const version = this.client.nvr.config.version;

    // If we are running an unsupported version of UniFi Protect, we're done. The version gate stays HBUP-side, reading the live projection post-connect.
    if(![ "6.", "7." ].some(v => version.startsWith(v))) {

      this.log.error("This version of HBUP requires running UniFi Protect v6.0 or above using the official Protect release channel only.");
      await this.client[Symbol.asyncDispose]();

      return false;
    }

    // Assign our name if the user hasn't explicitly specified a preference.
    this.name = this.config.name ?? this.client.controllerName ?? this.config.address;

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
      this.client.connection.on("controllerRecovered", () => this.publishLifecycle("controllerRecovered"))
    ];
  }

  // Cleanly disconnect from the Protect controller. This tears down all connection-dependent resources (active HomeKit streams, HKSV timeshift buffers, the
  // connection-health subscriptions, and the v5 client itself) while preserving one-time infrastructure (playlist servers, MQTT, event listeners).
  private async disconnect(): Promise<void> {

    // Tear down all connection-dependent camera resources. Active HomeKit streaming sessions and HKSV timeshift buffers both depend on the controller connection.
    // Shutting them down proactively prevents error noise from livestream self-healing and FFmpeg processes communicating with a disconnected controller. After
    // the per-consumer teardowns, we forcibly shut down each camera's LivestreamManager so any subscriptions that didn't release themselves (e.g., a stuck
    // session whose consumers leaked their handles) are guaranteed to be cleared before the controller comes back. NVR teardown is the right anchor for this:
    // when the controller goes away, all livestream state must go with it.
    for(const protectCamera of this.devices("camera")) {

      protectCamera.stream?.shutdown();
      protectCamera.stream?.hksv?.timeshift.stop();
      protectCamera.packageCamera?.stream?.shutdown();
      protectCamera.packageCamera?.stream?.hksv?.timeshift.stop();

      protectCamera.livestream.shutdown();
      protectCamera.packageCamera?.livestream.shutdown();
    }

    // Detach the connection-health subscriptions so they do not outlive the client whose connection monitor they observe.
    for(const subscription of this.connectionSubscriptions) {

      subscription[Symbol.dispose]();
    }

    this.connectionSubscriptions = [];

    // Dispose the v5 client - tearing down the connection monitor, livestream pool, state store, session, and transport pool, in that order. The client is
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
      await sleep(30);

      // Unregister all the accessories for this controller from Homebridge that may have been restored already. Any additional ones will be automatically caught when
      // they are restored.
      for(const accessory of this.platform.accessories.filter(x => x.context.nvr === this.ufp.mac)) {

        this.removeHomeKitDevice(accessory, true);
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

      this.servePlaylist();
    }

    // Inform the user about the devices we see, reading the live v5 projections.
    this.log.info("Discovered controller: %s.", this.client.controllerName ?? this.ufp.marketName);

    for(const config of this.deviceConfigs) {

      // Filter out any devices that aren't adopted by this Protect controller.
      if(!config.isAdopted || config.isAdoptedByOther) {

        continue;
      }

      this.log.info("Discovered %s: %s.", config.modelKey, config.name ?? config.marketName);
    }

    // Sweep any cached accessories that are no longer present on the controller, then perform the initial device population and spawn the observe loops that keep us
    // in sync. The bootstrap-refresh timer and the synthetic re-emit the v4 model used are gone: membership is now an observe over the content-memoized adopted-id
    // selectors, controller health an observe over the connection monitor, and the controller-scoped accessories (system information, liveviews) each observe their own
    // slice of the v5 projection from their own constructors - the subject owns its reactivity, the same model the per-device leaves use.
    this.sweepOrphans();
    this.startDeviceObservers();

    // Seed the initial liveview population now that the device accessories exist. A liveview switch restores its saved motion-detection state onto its member cameras, so
    // this first reconcile must run after startDeviceObservers; every subsequent liveview-collection change is handled by the observer ProtectLiveviews spawns itself.
    this.liveviews.configureLiveviews();

    this.startConnectionObserver();

    // Spawn the typed event-firehose router and the controller telemetry publisher. The router is the one controller-level consumer of the classified activity firehose,
    // dispatching each motion / smart-detect / doorbell-ring / access occurrence to the addressed accessory's HomeKit delivery; the telemetry publisher mirrors every raw
    // frame to MQTT and is a no-op unless the user opted in. Both are bound to the terminal shutdown signal and unwind with the rest of the observe tree.
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

    // Anchor the schedule to the controller's actual uptime so HBUP restarts don't reset the reboot cadence. If the controller has been up longer than the interval,
    // we schedule a reboot shortly after startup to let everything settle first.
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
  // This retains its v4-shaped reboot command (the `ufpApi.retrieve` / `responseOk` legacy surface) and its manual disconnect/sleep/reconnect window. Under v5 the
  // ConnectionMonitor auto-recovers a rebooting controller without recreating the client, so Phase 4 (lifecycle) collapses this loop into that recovery and migrates
  // the command to `client.reboot()`. It is left here compiling and correct-enough against the new connect()/disconnect() until then.
  private async executeScheduledReboot(intervalHours: number, cycleStart?: number): Promise<void> {

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

    let response;

    try {

      response = await this.ufpApi.retrieve("https://" + (this.config.overrideAddress ?? this.config.address) + "/api/system/reboot", { method: "POST" });
    } catch(error) {

      // The reboot command threw. Roll back to `running` so error logging and health observation come back on for the retry, and reschedule at the same cadence
      // as the deferral check - failure is just another reason to "try again the next time we check." We propagate the cycle start so the ceiling continues to
      // count cumulative time across deferrals and retries.
      this.transition("running");
      this.log.error("Unable to send reboot command to the Protect controller: %s.", error);

      this.nvrRebootTimer = setTimeout(() => void this.executeScheduledReboot(intervalHours, nextCycleStart), 60 * 1000);

      return;
    }

    // Validate the controller actually accepted the reboot. retrieve() returns null on every silent failure mode (timeout, throttle, 4xx, 5xx, network error,
    // throttle-suppressed request), so a non-OK response here means the reboot did not happen and we must not assume it did. Without this check we would
    // disconnect, sleep, and reconnect to a controller that never rebooted - exactly the silent-no-op failure the user asked us to close. Reschedule on the
    // same deferral cadence rather than waiting an entire reboot interval; the next check should naturally pick up where this one left off.
    if(!this.ufpApi.responseOk(response?.statusCode)) {

      this.transition("running");
      this.log.error("The Protect controller did not accept the reboot command (status: %s). Will retry shortly.", response?.statusCode ?? "no response");

      this.nvrRebootTimer = setTimeout(() => void this.executeScheduledReboot(intervalHours, nextCycleStart), 60 * 1000);

      return;
    }

    this.log.info("Executing scheduled reboot of the Protect controller. Will resume connectivity in %s minutes.",
      parseFloat((PROTECT_NVR_REBOOT_RECONNECT_DELAY / 60).toFixed(1)));

    // try/finally is the safety net: regardless of how we exit the disconnect/sleep/reconnect window (success, failure, unexpected throw), the finally
    // guarantees the phase ends at `running` so organic monitoring resumes for the next cycle. connect() handles the success path by transitioning to `running`
    // itself; the finally only acts when connect() didn't succeed or didn't run.
    let reconnected = false;

    try {

      // Cleanly disconnect from the controller. This tears down active HomeKit streams, HKSV timeshift buffers, and the client connection, preventing error noise
      // during the reboot.
      await this.disconnect();

      // Wait for the controller to reboot and come back online.
      await sleep(PROTECT_NVR_REBOOT_RECONNECT_DELAY * 1000);

      // Move into the `connecting` phase: we are about to attempt reconnect. Real errors from this point (e.g., bad credentials, hostname unreachable) should
      // surface, but health observation stays suspended until we have a successful connection to baseline against - connect() transitions to `running` on
      // success.
      this.transition("connecting");

      // Reconnect to the controller. connect() now retries to success-or-throw internally (its startup-resilient retry policy), so a single call suffices; a
      // genuine failure (wrong credentials, or the shutdown signal aborting) returns false and we fall through to the next scheduled cycle as a natural recovery
      // opportunity.
      reconnected = await this.connect();

      if(!reconnected) {

        this.log.error("Unable to reconnect to the Protect controller after the scheduled reboot. Will attempt to reconnect on the next reboot cycle.");
      }
    } finally {

      // Ensure we never leave the NVR stranded in `rebooting` or `connecting`. connect() transitions to `running` on success; this picks up the failure paths
      // (no successful reconnect, or an exception during the disconnect/sleep window).
      if(this._phase !== "running") {

        this.transition("running");
      }
    }

    // Schedule the next reboot. If we failed to reconnect, the next cycle will attempt to connect again before issuing the reboot command.
    this.nvrRebootTimer = setTimeout(() => void this.executeScheduledReboot(intervalHours), intervalHours * 60 * 60 * 1000);
  }

  // The live v5 device config records across every category, flattened. The single read path for the discovery dump, the by-mac lookup, and the orphan sweep, so
  // those three readers never re-derive the controller's device inventory from a held snapshot - each is a thin map off the client's live projection collections.
  private get deviceConfigs(): ProtectDeviceConfigTypes[] {

    return [ ...this.client.cameras.map(c => c.config), ...this.client.chimes.map(c => c.config), ...this.client.lights.map(c => c.config),
      ...this.client.sensors.map(c => c.config), ...this.client.viewers.map(c => c.config) ];
  }

  // Resolve the live config record for a device id within a category, from the v5 projection. The single read path the membership reconcile uses to turn a freshly-
  // adopted id into the record it feeds to addHomeKitDevice.
  private deviceConfig(category: keyof ProtectDeviceTypes, id: string): Nullable<ProtectDeviceConfigTypes> {

    switch(category) {

      case "camera":

        return this.client.camera(id)?.config ?? null;

      case "chime":

        return this.client.chime(id)?.config ?? null;

      case "light":

        return this.client.light(id)?.config ?? null;

      case "sensor":

        return this.client.sensor(id)?.config ?? null;

      case "viewer":

        return this.client.viewer(id)?.config ?? null;

      default:

        exhaustiveGuard(category);

        return null;
    }
  }

  // Resolve a device's config record by MAC from the live projections. Used by the removal log to name a device the controller still reports, replacing the v4
  // bootstrap scan.
  private deviceConfigByMac(mac: string): Nullable<ProtectDeviceConfigTypes> {

    return this.deviceConfigs.find(config => config.mac === mac) ?? null;
  }

  // Reconcile one device category's HomeKit membership against the controller's current adopted-id set. This subsumes the v4 poll-driven syncDevices and the
  // event-driven adopt/unadopt handling into one engine: an adopted id we have not configured is added; a configured device whose id has left the adopted set is
  // removed. The content-memoized adopted-id selectors wake the observe loop only on a genuine membership change (add, removal, or adoption flip), never on the
  // continuous lastSeen/stats churn, so the reconcile cost scales with real membership deltas rather than with refresh frequency. Called once at login with the
  // current snapshot (initial population) and on each subsequent observe yield (ongoing deltas) - one function, both roles.
  private reconcileMembership(category: keyof ProtectDeviceTypes, adoptedIds: readonly string[]): void {

    const { toAdd, toRemove } = membershipDelta(adoptedIds, this.devices(category).map(device => device.ufp.id));

    // Add any adopted id we have not yet configured, resolving its live config record from the projection.
    for(const id of toAdd) {

      const config = this.deviceConfig(category, id);

      if(config) {

        this.addHomeKitDevice(config);
      }
    }

    // Remove any configured device whose id has left the adopted set. We remove without the deferral delay: under v5 membership rides the content-memoized adopted-id
    // selector, which yields only on an authoritative adoption flip and deliberately ignores transient disconnect / re-provisioning churn (a disconnected-but-adopted
    // device stays in the set and is handled by reachability, not membership). The deferral existed to smooth v4's poll-driven flap, where a bootstrap refresh could
    // transiently show a device missing; that flap is structurally absent here, so the memoized membership IS the debounce. (This leaves Nvr.DelayDeviceRemoval
    // dormant - its queue was re-processed by the now-dissolved bootstrap poll. It is kept, not dropped: Phase 4 re-implements it event-driven, scheduling a delayed
    // removal when a device leaves the adopted set and cancelling it if the device reappears before the timer fires.)
    for(const id of toRemove) {

      const device = this.getDeviceById(id);

      if(device) {

        this.removeHomeKitDevice(device.accessory, true);
      }
    }
  }

  // Sweep cached accessories that are no longer present on the controller. Homebridge restores previously-registered accessories at startup; any belonging to this
  // controller whose device the controller no longer reports as adopted is an orphan we remove. This replaces the v4 cleanupDevices orphan pass, reading the live
  // projection inventory rather than a held bootstrap. Liveview, security-system, and system-information accessories are managed elsewhere and skipped.
  private sweepOrphans(): void {

    const knownMacs = new Set(this.deviceConfigs.filter(config => config.isAdopted && !config.isAdoptedByOther).map(config => config.mac));

    for(const accessory of this.platform.accessories.filter(x => x.context.nvr === this.ufp.mac)) {

      if(accessory.context.systemInfo || accessory.context.liveview || accessory.getService(this.hap.Service.SecuritySystem)) {

        continue;
      }

      const mac = accessory.context.mac as string | undefined;

      if(mac && !knownMacs.has(mac)) {

        this.removeHomeKitDevice(accessory, true);
      }
    }
  }

  // Spawn the per-category device-membership observe loops, seeding each with an initial population pass. v5's observe() yields on change, not the current value, so
  // each loop reconciles once against the current snapshot before awaiting deltas. The loops are bound to the terminal shutdown signal and assume a stable client for
  // the plugin's connected lifetime - the v5 invariant, since the ConnectionMonitor recovers an outage without recreating the client. (The Phase-4 scheduled-reboot
  // loop, which does recreate the client, is the one exception, and is itself superseded by that auto-recovery; it is out of this phase's cut line.)
  private startDeviceObservers(): void {

    const collections: { ids: (state: ProtectState) => readonly string[]; key: keyof ProtectDeviceTypes }[] = [

      { ids: selectAdoptedCameraIds, key: "camera" },
      { ids: selectAdoptedChimeIds, key: "chime" },
      { ids: selectAdoptedLightIds, key: "light" },
      { ids: selectAdoptedSensorIds, key: "sensor" },
      { ids: selectAdoptedViewerIds, key: "viewer" }
    ];

    for(const { ids, key } of collections) {

      // Initial population from the current snapshot, then react to membership deltas.
      this.reconcileMembership(key, ids(this.client.state.snapshot()));

      this.spawnLoop("the " + key + " list", async () => {

        for await (const adoptedIds of this.client.state.observe(ids, { signal: this.signal })) {

          this.reconcileMembership(key, adoptedIds);
        }
      });
    }
  }

  // Spawn the connection-health observe loop. Controller health is one fact with one reader: on each connection-state transition this loop walks the configured
  // accessories and pushes the recomputed reachability to each, rather than having N accessories each subscribe to the connection monitor (which would be 2N
  // iterators and N readers of a single fact). An accessory whose HomeKit-visible reachability actually flipped is published on the reachability-fanout diagnostics
  // channel. Pull where the fact is per-device (the per-device leaf observers); push where the fact is controller-wide (here).
  private startConnectionObserver(): void {

    this.spawnLoop("the controller connection", async () => {

      for await (const _transition of this.client.connection.observe({ signal: this.signal })) {

        for(const device of this.configuredDevices.values()) {

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

  // Reconfigure a camera as a doorbell. Cameras and doorbells share the same modelKey in Protect...the only differentiator is featureFlags.isDoorbell, which may not be
  // populated when the device is first adopted. We tear down the ProtectCamera instance and replace it with a ProtectDoorbell against the same HomeKit accessory.
  public reconfigureAsDoorbell(protectDevice: ProtectDevice): void {

    // Tear down the existing device instance...listeners, timers, HKSV, and livestream resources.
    protectDevice.cleanup();

    // Remove the old instance from our configured devices and recreate it with the correct class.
    this.configuredDevices.delete(protectDevice.accessory.UUID);
    this.addProtectDevice(protectDevice.accessory, protectDevice.ufp);
  }

  // Create instances of Protect device types in our plugin.
  private addProtectDevice(accessory: PlatformAccessory, device: ProtectDeviceConfigTypes): Nullable<ProtectDevice> {

    const deviceName = device.name ?? device.marketName;

    switch(device.modelKey) {

      case "camera": {

        // We have a UniFi Protect camera or doorbell. We resolve the live v5 projection for this id and inject it into the accessory; the projection-acquisition
        // policy lives here at the composition root, which knows the concrete type at the point of adoption. The handle is null only when the record has not yet
        // reduced, in which case there is nothing to adopt.
        const camera = this.client.camera(device.id);

        if(!camera) {

          break;
        }

        this.configuredDevices.set(accessory.UUID,
          device.featureFlags.isDoorbell ? new ProtectDoorbell(this, accessory, camera) : new ProtectCamera(this, accessory, camera));

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

      case "light": {

        // We have a UniFi Protect light.
        const light = this.client.light(device.id);

        if(!light) {

          break;
        }

        this.configuredDevices.set(accessory.UUID, new ProtectLight(this, accessory, light));

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

    // If we have no MAC address, name, or this camera isn't being managed by this Protect controller, we're done.
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

      this.log.info("UniFi Protect device type %s is not currently supported, ignoring: %s.", device.modelKey, device.name ?? device.marketName);

      return false;
    }

    // Generate this device's unique identifier.
    const uuid = this.hap.uuid.generate(device.mac);

    // See if we already know about this accessory.
    let accessory = this.platform.accessories.find(x => x.UUID === uuid);

    // Enable or disable certain devices based on configuration parameters.
    if(!this.hasFeature("Device", device)) {

      if(accessory) {

        this.removeHomeKitDevice(accessory, true);
      }

      return false;
    }

    // We've got a new device, let's add it to HomeKit.
    if(!accessory) {

      accessory = new this.api.platformAccessory(sanitizeName(device.name ?? device.marketName), uuid);

      this.log.info("%s: Adding %s to HomeKit%s.", device.name ?? device.marketName, device.modelKey,
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

    // Setup the accessory as a new Protect device in HBUP if we haven't configured it yet. A device we already track needs no action here: its state now arrives
    // through the per-device observe loops, not a synthetic refresh re-emit, so there is nothing to re-merge.
    if(!this.configuredDevices.has(accessory.UUID)) {

      this.addProtectDevice(accessory, device);
    }

    return true;
  }

  // Remove an individual Protect accessory from HomeKit.
  public removeHomeKitDevice(accessory: PlatformAccessory, noRemovalDelay = false): void {

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

    const delayInterval = this.getFeatureNumber("Nvr.DelayDeviceRemoval") ?? 0;

    // For certain use cases, we may want to defer removal of a Protect device where Protect may lose track of devices for a brief period of time. This prevents a
    // potential back-and-forth where devices are removed momentarily only to be readded later.
    if(!noRemovalDelay && delayInterval) {

      // Have we seen this device queued for removal previously? If not, let's add it to the queue and come back after our specified delay.
      if(!this.deviceRemovalQueue.has(accessory.UUID)) {

        this.deviceRemovalQueue.set(accessory.UUID, Date.now());

        this.log.info("%s: Delaying device removal for at least %s second%s.", accessory.displayName, delayInterval, delayInterval > 1 ? "s" : "");

        return;
      }

      // Is it time to process this device removal?
      const removalTimestamp = this.deviceRemovalQueue.get(accessory.UUID) ?? 0;

      if((delayInterval * 1000) > (Date.now() - removalTimestamp)) {

        return;
      }
    }

    // Cleanup after ourselves.
    this.deviceRemovalQueue.delete(accessory.UUID);

    // Grab our instance of the Protect device, if it exists.
    const protectDevice = this.configuredDevices.get(accessory.UUID);

    // See if we can pull the device's configuration details from our Protect device instance or the live controller projection.
    const device = protectDevice?.ufp ?? (accessory.context.mac ? this.deviceConfigByMac(accessory.context.mac as string) : null);

    this.log.info("%s: Removing %s from HomeKit.%s",
      device ? (device.name ?? device.marketName) : protectDevice?.accessoryName ?? accessory.displayName,
      device?.modelKey ?? "device",
      accessory._associatedHAPAccessory.bridged ? "" : " You will need to manually delete the device in the Home app to complete the removal.");

    const deletingAccessories = [accessory];

    // If it's an unknown device or a camera, look for a corresponding package camera if we have one and remove it as well.
    if(!device || (device.modelKey === "camera")) {

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

    // Update our internal list of all the accessories we know about.
    for(const targetAccessory of deletingAccessories) {

      // Unregister the accessory from HomeKit if we have a bridged accessory. Unbridged accessories are managed directly by users in the Home app.
      if(targetAccessory._associatedHAPAccessory.bridged) {

        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [targetAccessory]);
      }

      this.platform.accessories.splice(this.platform.accessories.indexOf(targetAccessory), 1);
    }

    // Tell Homebridge to save the updated list of accessories.
    this.api.updatePlatformAccessories(this.platform.accessories);
  }

  // Create a web service to publish an M3U playlist of Protect camera livestreams.
  private servePlaylist(): void {

    const port = this.getFeatureNumber("Nvr.Service.Playlist") ?? PROTECT_M3U_PLAYLIST_PORT;
    const server = http.createServer();

    // Respond to requests for a Protect camera playlist.
    server.on("request", (_request, response) => {

      // Set the right MIME type for M3U playlists.
      response.writeHead(200, { "Content-Type": "application/x-mpegURL" });

      // Output the M3U header.
      response.write("#EXTM3U\n");

      // Read the host and RTSP port from the live NVR projection.
      const nvr = this.ufp;

      // Find the RTSP aliases and publish them. We filter out any cameras that don't have RTSP aliases since they would be inaccessible in this context.
      const cameras = this.client.cameras.map(projection => projection.config)
        .filter(camera => (camera.videoCodec !== "av1") && camera.channels.some(channel => channel.isRtspEnabled))
        .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));

      for(const camera of cameras) {

        // By convention, the first channel is the highest quality on UniFi Protect cameras, and our filter above guarantees this camera has at least one channel.
        // We still capture it through a guard rather than indexing blind, so a camera that somehow reports no channels is skipped cleanly instead of crashing.
        const primaryChannel = camera.channels[0];

        if(!primaryChannel) {

          continue;
        }

        // Publish a playlist entry, including guide information that's suitable for apps that support it, such as Channels DVR.
        const publishEntry = (name = camera.name, description = "camera", rtspAlias = primaryChannel.rtspAlias): void => {

          response.write(util.format("#EXTINF:0 channel-id=\"%s\" tvc-stream-vcodec=\"h264\" tvc-stream-acodec=\"opus\" tvg-logo=\"%s\" ",
            name, "https://raw.githubusercontent.com/hjdhjd/homebridge-unifi-protect/main/images/homebridge-unifi-protect-4x3.png"));

          response.write(util.format("tvc-guide-title=\"%s Livestream\" tvc-guide-description=\"UniFi Protect %s %s livestream.\" ",
            name, camera.marketName, description));

          response.write(util.format("tvc-guide-art=\"%s\" tvc-guide-placeholders=\"86400\" tvc-guide-tags=\"HD, Live, New, UniFi Protect\", %s\n",
            "https://raw.githubusercontent.com/hjdhjd/homebridge-unifi-protect/main/images/homebridge-unifi-protect-4x3.png", name));

          // By convention, the first RTSP alias is always the highest quality on UniFi Protect cameras. Grab it and we're done. We might be tempted
          // to use the RTSPS stream here, but many apps only supports RTSP, and we'll opt for maximizing compatibility here.
          response.write(util.format("rtsp://%s:%s/%s\n", nvr.host, nvr.ports.rtsp, rtspAlias));
        };

        // Create a playlist entry for each camera.
        publishEntry();

        // Ensure we publish package cameras as well, when we have them.
        if(camera.featureFlags.hasPackageCamera) {

          const packageChannel = camera.channels.find(x => x.isRtspEnabled && (x.name === "Package Camera"));

          if(!packageChannel) {

            continue;
          }

          publishEntry((camera.name ?? "") + " " + packageChannel.name, "package camera", packageChannel.rtspAlias);
        }
      }

      // We're done with this response.
      response.end();
    });

    // Handle errors when they occur.
    server.on("error", (error) => {

      // Explicitly handle address in use errors, given their relative common nature. Everything else, we log and abandon.
      if((error as NodeJS.ErrnoException).code === "EADDRINUSE") {

        this.log.error("The address and port we are attempting to use is already in use by something else. Will retry again shortly.");

        setTimeout(() => {

          server.close();
          server.listen(port);
        }, 5000);

        return;
      }

      this.log.error("M3U playlist publisher error: %s", error);
      server.close();
    });

    // Let users know we're up and running.
    server.on("listening", () => {

      this.log.info("Publishing an M3U playlist of Protect camera livestream URLs on port %s.", port);
    });

    // Listen on the port we've configured.
    server.listen(port);
  }

  // Return all devices of a particular modelKey.
  private devices<T extends keyof ProtectDeviceTypes>(model?: T): ProtectDeviceTypes[T][] {

    return [...this.configuredDevices.values()].filter(device => device.ufp.modelKey === model) as ProtectDeviceTypes[T][];
  }

  // Return the Protect device object based on its unique device identifier, if it exists.
  public getDeviceById(deviceId: string): Nullable<ProtectDevices> {

    // Find the device.
    return [...this.configuredDevices.values()].find(device => device.ufp.id === deviceId) ?? null;
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
