/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * nvr.ts: NVR device class for UniFi Protect.
 */
import type { API, HAP } from "homebridge";
import { APIEvent, MQTT_AVAILABILITY_OFFLINE, MQTT_AVAILABILITY_ONLINE, createMqttClient, debugGatedLog, formatErrorMessage, formatSeconds, loopFaultReporter,
  membershipDelta, mqttConnectionSettings, mqttTopic, prefixedLog, repeatDemotedLog, retry, superviseLoop } from "homebridge-plugin-utils";
import type { Camera, ConnectOptions, DeviceCollectionKey, LivestreamRecoveryExhaustedPayload, LivestreamRecoveryRecoveredPayload, LivestreamRecoveryStartedPayload,
  ProtectDeviceConfig, ProtectLogging, ProtectNvrConfig, StateStore } from "unifi-protect";
import type { ConnectFailure, ConnectFailureType } from "./nvr-policy.ts";
import { DEVICE_COLLECTION_KEYS, ProtectClient, maskAddressCredentials, channels as protectChannels } from "unifi-protect";
import type { HomebridgePluginLogging, MqttAvailabilityPayload, MqttClient, Nullable } from "homebridge-plugin-utils";
import { OVERRIDE_ADDRESS_ZONE_WARNING, UNREPORTED_CONTROLLER_RECORD, UNSUPPORTED_PROTECT_VERSION, canTransition, createConnectRetryPolicy, createLivestreamEpisodeLatch,
  deviceInventory, isDisruptionExpected, isSupportedProtectVersion, resolveOverrideAddress, shouldResumeFromInducedReboot } from "./nvr-policy.ts";
import { PLATFORM_NAME, PLUGIN_NAME, PROTECT_NVR_REBOOT_RECENCY_MS } from "../settings.ts";
import type { ProtectAccessory, ProtectAccessoryContext, ProtectDeviceTypes, ProtectDevices, ProtectProjectionMap } from "../types.ts";
import { countActiveHksvRecordings, deviceEndpoints } from "./nvr-endpoints.ts";
import { describeDevice, deviceDisplayName } from "../devices/device-descriptor.ts";
import { AmbientLightCapability } from "../devices/cameras/ambient-light.ts";
import { DeviceRemovalCascade } from "./nvr-removal-cascade.ts";
import { DiagnosticsHealthBridge } from "./nvr-health-bridge.ts";
import { DoorbellCapability } from "../devices/cameras/doorbell.ts";
import type { NvrLifecyclePayload } from "../diagnostics.ts";
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
import { RebootScheduler } from "./nvr-reboot.ts";
import { RemovalStabilityGate } from "./nvr-removal.ts";
import { StreamingCapability } from "../devices/cameras/streaming.ts";
import { channels } from "../diagnostics.ts";
import { configured } from "../devices/device-base.ts";
import { isolateAccessoryChange } from "./nvr-accessory-change.ts";
import { livestreamRecoveryDecision } from "../media/livestream-recovery-policy.ts";
import { mqttTopics } from "../mqtt.ts";
import { servePlaylist } from "./nvr-playlist.ts";

/**
 * The NVR's lifecycle phase. The single source of truth for "what is this NVR doing right now?", consulted by every component that needs to distinguish induced
 * disruptions (where the plugin is intentionally driving an outage and downstream noise should be suppressed) from organic disruptions (where something genuinely
 * unexpected happened and the noise IS the signal).
 *
 *   - `connecting`: initial setup, or post-disruption reconnection attempt. Real connection errors should still surface to the user (e.g., "invalid credentials"),
 *      but health-symptom observation is suspended because we have not yet established a baseline of "running" against which to weigh stress.
 *   - `running`: connected, normal steady-state operation. Errors are organic; health observation is active; consumers log unexpected events normally.
 *   - `rebooting`: the plugin initiated a controller reboot. The disruption is induced (we know the controller is going away); health observation is suspended;
 *      consumers suppress noise about the disruption. The client logger's own lines hide on the reboot scheduler's gate rather than on this phase, so they show until the
 *      controller accepts the command and again once a reboot is overdue.
 *   - `shuttingDown`: terminal. Homebridge is going away, or a login rejected past connect stopped this controller until a restart while Homebridge runs on. Consumers
 *      suppress noise as in `rebooting` and the client logger's errors stay hidden, but no recovery is expected.
 *
 * Transitions are owned by `ProtectNvr.transition()`. Components consume via `nvr.phase`. `logApiErrors` is a getter over this phase and the reboot scheduler's gate,
 * whose pending timer is its one value, so phase is the lone lifecycle axis and neither needs telling when the other moves.
 */
export type NvrPhase = "connecting" | "rebooting" | "running" | "shuttingDown";

// One device category's wiring: how to resolve its live unifi-protect projection from an id and how to build its HomeKit device from that projection. Correlated on K
// so a category's projection and class cannot drift apart in the descriptor table below.
interface DeviceDescriptor<K extends DeviceCollectionKey> {

  construct: (accessory: ProtectAccessory, projection: ProtectProjectionMap[K]) => ProtectDeviceTypes[K];
  projection: (client: ProtectClient, id: string) => ProtectProjectionMap[K] | undefined;
}

/**
 * The connect port: how a controller root reaches its Protect controller.
 *
 * This is the root's one external boundary, and it is named here rather than reached for inline so that standing a controller root up does not require a network.
 * The root transitively owns the whole accessory graph, its observe loops, and its connection lifecycle, and none of that can be exercised at all if the one call
 * that establishes a client cannot be answered.
 *
 * The port only decides WHAT connect is called. Everything around it - the startup-resilient retry, the shutdown checks, the version gate - is the root's own and is
 * unaffected by which implementation answers.
 */
export type ProtectNvrConnect = (options: ConnectOptions) => Promise<ProtectClient>;

// The default port: the real client. Wrapped rather than referenced so the static's own this binding stays with its class.
const defaultConnect: ProtectNvrConnect = async (options) => ProtectClient.connect(options);

/* The user-readable reason carried by a line of unifi-protect's in its structured context, or undefined where it carries none. Everything else a context holds is a raw
 * object or a value that means nothing outside a debug transcript, so a reason is the one member lifted out of one: unifi-protect composes it from the failure's own
 * cause chain, which makes it a sentence fragment already addressed to the user. The search walks every trailing parameter rather than the first alone, because a line is
 * free to attach its context behind parameters of its own.
 */
const contextReason = (parameters: readonly unknown[]): string | undefined => {

  for(const parameter of parameters) {

    if((typeof parameter !== "object") || (parameter === null) || !("reason" in parameter)) {

      continue;
    }

    const reason = parameter.reason;

    if((typeof reason === "string") && (reason.length > 0)) {

      return reason;
    }
  }

  return undefined;
};

export class ProtectNvr {

  private api: API;
  // The unifi-protect client - the single owner of protocol truth (reduced state, realtime decode, refresh failsafe, connection health). Established by connect()
  // through the connect port and torn down through its Symbol.asyncDispose. Definite-assignment typed for the connected lifetime; it is genuinely undefined until a
  // connect succeeds, which a controller whose address can never work never does (guarded where that state is reachable, e.g. disconnect()).
  public client!: ProtectClient;
  public readonly config: ProtectNvrOptions;
  public readonly configuredDevices: Map<string, ProtectDevices>;
  // How this root reaches its Protect controller. The real client answers it in every configuration the plugin builds.
  readonly #connectClient: ProtectNvrConnect;
  // Every per-client connection subscription in one array: the health bridge's two throttle rails, joined with the controller-lost/rebooted/recovered lifecycle
  // listeners this root keeps. Re-wired on every connect() against the live client and disposed on disconnect(), so they never outlive the client whose connection
  // monitor they observe - and one home for all of them is what leaves that rule impossible to half-apply.
  private connectionSubscriptions: Disposable[];
  public readonly events: ProtectEventDispatch;
  private hap: HAP;
  public readonly health: DiagnosticsHealthBridge;
  // The platform clock's timestamp of the last controller reboot we observed via the library's jitter-thresholded `controllerRebooted` event, or null until one is
  // seen this process. It is the settling-tail half of the `isDisruptionExpected` classification and stays private to this root: callers ask whether a disruption is
  // expected, never how recently a reboot landed. Not a controller clock: it is when WE observed the reboot, on our own wall clock.
  private lastRebootObservedAt: Nullable<number>;
  // Per-episode quiet-classification latch for the per-camera livestream-disruption logs. The interruption edge records whether the episode should be logged quietly
  // (the tail of an induced disruption or a recently-observed reboot); the recovery edge - which can no longer read the phase reliably - consumes that classification.
  // Reclaimed on the camera's removal.
  private readonly livestreamEpisodes = createLivestreamEpisodeLatch();
  private liveviews: Nullable<ProtectLiveviews>;
  public readonly log: HomebridgePluginLogging;
  public mqtt: Nullable<MqttClient>;
  private name: string;
  // The address override this controller's cameras resolve their RTSP URLs against, or null when none is configured or the configured one was set aside. Resolved once,
  // while the controller is configured at login.
  #overrideAddress: Nullable<string>;
  // The scheduled reboot: when it fires, how long an active HKSV recording may hold it back, how a command that took no effect is recognized, and whether a reboot is
  // still on time, the gate the client logger reads. Handed the recording count, the connection health and the controller's availability as suppliers it pulls at its own
  // fire time; the reboot command itself and the phase moves run back here through its actions.
  public readonly reboot: RebootScheduler;
  // The device-removal cascade: the guards, the package-camera cascade, the device's cleanup and retirement, and the shared tail every removal of one of our
  // accessories runs. Handed the controller's MAC and its state store as suppliers it pulls at use time; the acts the removal gate, the livestream-episode ledger and
  // the event dispatcher own run back here through its actions.
  readonly #removalCascade: DeviceRemovalCascade;
  // The removal-stability decision: whether destructive removal is currently allowed, and the graced scheduling of the removals it permits. Fed the controller's
  // good-state through #pushRemovalStability; every act it decides on runs through the actions it was constructed with, a removal through the device-removal cascade
  // and the sweep back here.
  public readonly removals: RemovalStabilityGate;
  // Lifecycle phase. The SSOT for "what is this NVR doing right now?". Consumed by components that need to distinguish induced from organic disruption.
  // Mutated only through `transition()`, never directly.
  private _phase: NvrPhase;
  public readonly platform: ProtectPlatform;
  // The terminal shutdown abort. Aborted once, in transition("shuttingDown"); every NVR-level observe loop and every per-accessory controller composes against it, so a
  // shutdown tears the whole tree down as one cascade. Initialized in the constructor so it exists before any device is constructed.
  readonly #shutdownController: AbortController;
  // The one run of the shutdown sequence, null until something asks for it.
  #shutdownRun: Nullable<Promise<void>>;
  public systemInfo: Nullable<ProtectNvrSystemInfo>;
  // The MACs of the devices removed while no broker session stood, each stated once at the next session unless something serves it by then. They live as long as this
  // root does, so a plugin restart ahead of that session loses them.
  readonly #unheardRemovals = new Set<string>();
  private unsupportedDevices: Record<string, boolean>;
  // The unifi-protect client logger. Writes through this controller's own log, so every line unifi-protect writes names its controller, and hides warn and error output
  // while a scheduled reboot is on time, so the outage we induced stays quiet until it is overdue, and error output through shutdown. Typed as unifi-protect's own
  // ProtectLogging contract, single-sourced with what ProtectClient.connect() expects.
  private readonly clientLog: ProtectLogging;
  // The one place the device-category vocabulary is wired to its projections and constructors: adoption resolves the live unifi-protect projection through
  // `.projection` and builds the HomeKit device through `.construct`. Membership reads the client's own selector catalog through the same key: the membership observe
  // loops, the stability sweep, and the per-fire stillGone re-check each read the content-memoized adopted-id set as `client.state.selectors[key].adoptedIds`, because
  // that catalog belongs to the client's store, which connect() establishes after this table is built. A category added upstream is wired in exactly one place here
  // rather than re-listed at each reader.
  private readonly deviceDescriptors: { readonly [K in DeviceCollectionKey]: DeviceDescriptor<K> } = {

    // The camera row builds a ProtectCamera for both plain cameras and doorbells: a device the controller reports as a doorbell attaches its DoorbellCapability through
    // ProtectCamera's own setup-time reconcile, so there is one attach path for both arrival timings (doorbell-at-adoption and a late isDoorbell flip).
    camera: { construct: (accessory, camera) => new ProtectCamera(this, accessory, camera), projection: (client, id) => client.camera(id) },
    chime: { construct: (accessory, chime) => new ProtectChime(this, accessory, chime), projection: (client, id) => client.chime(id) },
    fob: { construct: (accessory, fob) => new ProtectFob(this, accessory, fob), projection: (client, id) => client.fob(id) },
    light: { construct: (accessory, light) => new ProtectLight(this, accessory, light), projection: (client, id) => client.light(id) },
    relay: { construct: (accessory, relay) => new ProtectRelay(this, accessory, relay), projection: (client, id) => client.relay(id) },
    sensor: { construct: (accessory, sensor) => new ProtectSensor(this, accessory, sensor), projection: (client, id) => client.sensor(id) },
    viewer: { construct: (accessory, viewer) => new ProtectViewer(this, accessory, viewer), projection: (client, id) => client.viewer(id) }
  };

  constructor(platform: ProtectPlatform, nvrOptions: ProtectNvrOptions, connect: ProtectNvrConnect = defaultConnect) {

    this.api = platform.api;
    this.config = nvrOptions;
    this.configuredDevices = new Map();
    this.#connectClient = connect;
    this.connectionSubscriptions = [];
    this.hap = this.api.hap;
    this.lastRebootObservedAt = null;
    this.liveviews = null;
    this.mqtt = null;
    // Every line this controller writes before it connects is prefixed with this name, so the address it starts from is named through unifi-protect's mask.
    this.name = maskAddressCredentials(nvrOptions.address);
    this.#overrideAddress = null;
    this._phase = "connecting";
    this.platform = platform;
    this.#shutdownController = new AbortController();
    this.#shutdownRun = null;
    this.systemInfo = null;
    this.unsupportedDevices = {};

    /* The controller half of this logger's per-call debug scope. The client field is definite-assigned at connect, so the unconnected state is real even though
     * the field's type says otherwise; the confined widening makes that state readable here without weakening the post-connect typing anywhere else. An
     * unconnected controller resolves its debug lines at global scope - the only scope that can name it before its identity is known. The record is peeked rather than
     * read through its config, because unifi-protect's own debug lines reach this gate from inside unifi-protect, where a throw on an absent record would land.
     */
    const controllerMac = (): string | undefined => (this.client as ProtectClient | undefined)?.nvr.peek()?.mac;

    // Derive our controller logger from the plugin logging root, prefixing every line with this.name so controller output is attributable at a glance. Debug lines
    // resolve at this controller's own scope, so a controller-suffixed Log.Debug entry turns on this controller alone.
    this.log = debugGatedLog(prefixedLog(this.platform.pluginLog, () => this.name), () => this.platform.testDebug({ controller: controllerMac() }));

    /* The unifi-protect client logger. unifi-protect logs complete sentences with structured context attached as trailing parameters, and rendering that context inline
     * would put raw object dumps in front of the user - so each non-debug level emits the sentence alone at its level and echoes the full line, context included, to
     * debug, where the forensic detail belongs. A string reason is the one member that comes out of the context and into the user's line, because it is the only one
     * that is already words for them: unifi-protect composes it from the failure's cause chain, so it joins the sentence in the same colon-then-reason form our own
     * connect-failure line uses. Every level goes through this controller's own logger, so a line of unifi-protect's is attributable to the controller that produced it
     * exactly as the lines we write ourselves are, and its debug lines and the echo answer to this controller's debug gate. Warn and error output each read the reboot
     * scheduler's one gate, so a line is hidden only while a reboot is on time and nothing is held or replayed, with no match on unifi-protect's wording, and
     * logApiErrors adds the terminal phase for errors; the echo stays outside those gates, so debug logging captures the full record even while the line is hidden.
     *
     * The composed line reaches write() as one finished string with no format parameters, so a percent sign inside a reason is text rather than a format directive.
     */
    const routeClientContext = (write: (message: string) => void): ((message: string, ...parameters: unknown[]) => void) => {

      return (message: string, ...parameters: unknown[]): void => {

        const reason = contextReason(parameters);

        write((reason === undefined) ? message : (message.replace(/\.$/, "") + ": " + reason + "."));

        if(parameters.length) {

          this.log.debug(message, ...parameters);
        }
      };
    };

    this.clientLog = {

      debug: (message: string, ...parameters: unknown[]): void => this.log.debug(message, ...parameters),
      error: routeClientContext((message: string): void => {

        if(this.logApiErrors) {

          this.log.error(message);
        }
      }),
      info: routeClientContext((message: string): void => this.log.info(message)),
      warn: routeClientContext((message: string): void => {

        if(!this.reboot.isRebootOnTime) {

          this.log.warn(message);
        }
      })
    };

    // Initialize the health bridge. It owns the whole diagnostics-to-health translation - the observer, the channel subscriptions that feed it, and the user-facing
    // narration of every state it moves through - while the one act that reaches back into controller territory, re-evaluating the removal-stability clock, runs here
    // through the action handed in below. Every subsystem that wants a stress-aware decision still reads `this.health.state`.
    this.health = new DiagnosticsHealthBridge({

      actions: { refreshRemovalStability: (): void => this.#pushRemovalStability() },
      address: this.config.address,
      clock: this.platform.clock,
      log: this.log,
      // The same ownership question the per-camera narration below asks of the same graph, handed over as a predicate so the graph itself stays here.
      ownsCamera: (cameraId: string): boolean => this.getDeviceById(cameraId) !== null,
      signal: this.signal
    });

    // Initialize the device-removal cascade. It owns the act of removing one of our accessories - the guards, the package-camera cascade, the device's cleanup and
    // retirement, and the shared tail - while the acts another companion owns run here through the actions handed in below. Each action is a closure that reads its
    // companion when it runs, because the removal gate and the event dispatcher are both constructed after the cascade.
    this.#removalCascade = new DeviceRemovalCascade({

      accessories: this.platform.accessories,
      actions: {

        cancelPendingRemoval: (uuid: string): void => this.removals.cancelFor(uuid),
        forgetCamera: (cameraId: string): void => this.livestreamEpisodes.forgetCamera(cameraId),
        publishRemoval: (mac: string): void => this.#publishRemoval(mac),
        retireDevice: (device: ProtectDevice): void => this.events.retireDevice(device)
      },
      controllerMac: (): string => this.ufp.mac,
      devices: this.configuredDevices,
      log: this.log,
      persistence: this.platform.persistence,
      releaseAccessory: (accessory: ProtectAccessory): void => this.platform.releaseAccessory(accessory),
      state: (): StateStore => this.client.state
    });

    // Initialize the removal-stability gate. It owns the entire destructive-removal decision - the good-state clock, the settling window, and the grace timers - while
    // every act that touches the accessory graph is reached through the actions handed in below: a removal runs the device-removal cascade, and the sweep runs here at
    // the root. Constructed exactly once and never rebuilt per reconnect: its first-stabilization latch records that this process has stabilized before, which no later
    // disruption undoes.
    this.removals = new RemovalStabilityGate({

      actions: { removeDevice: (accessory: ProtectAccessory): void => this.#removalCascade.removeDevice(accessory), runSweep: (): void => this.sweepRemovableDevices() },
      clock: this.platform.clock,
      graceSeconds: (): number => this.getFeatureNumber("Nvr.DelayDeviceRemoval") ?? 0,
      log: this.log,
      signal: this.signal
    });

    // Initialize the reboot scheduler. It owns the whole scheduled-reboot choreography - the cadence, the deferral chain while cameras are recording, and the
    // confirmation that catches a command the controller silently ignored - while commanding the controller and moving its lifecycle phase stay here at the root,
    // reached through the actions handed in below. The facts it decides on arrive as suppliers it pulls at its own fire time. The client reads below are lazy by
    // design: the schedule is entered only after a successful connect, so the definite-assignment client is established well before any of them runs.
    this.reboot = new RebootScheduler({

      actions: {

        beginReboot: (): void => this.transition("rebooting"),
        reboot: async (): Promise<void> => this.client.reboot(),
        resumeRunning: (): void => this.transition("running")
      },
      activeRecordings: (): number => countActiveHksvRecordings(this.configuredDevices),
      clock: this.platform.clock,
      isConnectionHealthy: (): boolean => this.client.connection.isHealthy,
      isControllerAvailable: (): boolean => this.isAvailable,
      log: this.log,
      phase: (): NvrPhase => this._phase,
      signal: this.signal
    });

    // Initialize our UniFi Protect event handler.
    this.events = new ProtectEventDispatch(this);

    // Validate our Protect address and login information.
    if(!nvrOptions.address || !nvrOptions.username || !nvrOptions.password) {

      return;
    }

    // Attach the health bridge's diagnostics feeds. Here - past the address guard - is what keeps a misconfigured controller from ever subscribing, and the bridge
    // detaches on the terminal shutdown signal (which the SHUTDOWN handler below guarantees fires).
    this.health.wireDiagnostics();

    // Wire the per-camera livestream-disruption narration and its episode ledger. Same once-per-NVR setup site as the health feeds above: past the address guard and
    // detached on the terminal shutdown signal. The unifi-protect library's livestream-recovery channels are process-global, so this subscribes exactly once and never
    // re-wires per reconnect.
    this.wireLivestreamNarration();

    // Cleanly shut down on Homebridge exit.
    this.api.on(APIEvent.SHUTDOWN, () => void this.shutdown());
  }

  /**
   * Stop this controller: every loop, timer and connection it stood up ends, and its accessories stay and refuse until a restart. Homebridge's shutdown asks for this,
   * and so does the platform for a login rejected past connect, so the first call runs the sequence and every later call reads that one run and repeats nothing. A stop
   * that itself rejects is said here, once, whichever caller asked first. So the run held here cannot reject, and the promise Homebridge's listener voids has nothing to
   * float...a rejection that floats ends the process.
   *
   * @returns A promise that settles once the one run of the shutdown sequence has.
   */
  public async shutdown(): Promise<void> {

    await (this.#shutdownRun ??= this.#runShutdown().catch((error: unknown): void => {

      this.log.error("Unable to finish stopping the Protect controller: %s.", formatErrorMessage(error));
    }));
  }

  /* The shutdown sequence, in the order HBPU's graceful MQTT end asks for. Homebridge emits its shutdown without awaiting a listener and exits a few seconds later, so on
   * that path this runs inside that window. A login rejected past connect runs the same sequence while the process runs on, so what it ends stays ended until a restart.
   * A controller with no MQTT client has no words to wait on, so it runs straight through in its caller's own turn.
   */
  async #runShutdown(): Promise<void> {

    // Tear down the scheduled reboot's timers, each induced-lifecycle work that must not survive teardown - the cycle would command a controller we are disposing, and
    // the no-op confirmation and the expected return would narrate a reboot nobody is waiting on any more. Ending the expected return also lets a library warn show.
    this.reboot.reset();

    // Tear down the device-removal timers unconditionally, ahead of the MQTT end below. The stability-sweep one-shot and every pending delayed removal are deferred
    // destructive actions that must not fire against a controller going away, and a login rejected past connect on a long-up controller has a sweep armed and already
    // due, so leaving this to the transition below would let that sweep run inside the end's hold. The transition's own push clears the same state once it lands, and
    // each companion's lifetime binding is the last backstop: the transition's abort disposes its timer registry, which drains anything still armed - and by then
    // these resets have already emptied them, while the terminal shuttingDown phase means no push can ever ask a disposed registry to arm again.
    this.removals.reset();

    // End the MQTT client gracefully, which states every registered final word, each device's retained offline and this controller's, while the broker session still
    // holds. It comes ahead of the transition below, because aborting the signal the client and those words live on leaves the words unsaid. The rest of the plugin is
    // not quieted for this bounded grace: anything that publishes meanwhile is refused at debug, and a removal clock that re-arms is cancelled by the transition. A login
    // rejected past connect has had no turn in which to open a session, so there the client simply ends, and a retained value stands as the last run left it.
    if(this.mqtt) {

      await this.mqtt.end();
    }

    // Mark the lifecycle phase before tearing down. This is the single chokepoint that aborts the terminal shutdown signal, so every observe loop unwinds as one
    // cascade. Components that surface "unexpected teardown" warnings (e.g., the recording delegate) consult `nvr.phase` to suppress noise during induced
    // disruptions; without this transition the disconnect below would fan out as if cameras were failing unexpectedly.
    this.transition("shuttingDown");

    // Disconnect from the controller. This tears down active HomeKit streams, HKSV timeshift buffers, and the unifi-protect client connection.
    await this.disconnect();
  }

  /**
   * Wire the user-facing per-camera narration of livestream disruptions and the episode ledger behind it, sourced from the unifi-protect library's process-global
   * livestream-recovery diagnostics channels. The library owns the recovery protocol and publishes each episode's lifecycle on these channels; what this root does with
   * them is decide how loudly each episode is told to the user and keep the ledger that keeps the two edges of one episode consistent.
   *
   * We subscribe each episode-terminal channel the library publishes for this concern. `recovery:started` (a stream was disrupted; the episode begins) opens the
   * narration and latches the episode's quiet-or-loud classification, `recovery:recovered` (it resumed) closes it by consuming that classification, and
   * `recovery:exhausted` (the policy gave up) is consumed for ledger hygiene alone - it drains the episode's latch entry so the ledger holds only episodes in flight;
   * the give-up's narration belongs to the buffer's consume loop and its retry to the availability edge and the demand kicks, so that handler logs nothing. The health
   * symptoms these same episodes feed ride the health bridge's own subscriptions, whose doc carries the channel-choice rationale.
   *
   * The channels are process-global - shared by every `ProtectNvr` in this process - so each handler filters to this controller's cameras via `getDeviceById(cameraId)`
   * and drops the rest (another controller's camera, or one we do not configure). A package-camera stream carries its PARENT camera's device id, so the lookup resolves
   * the parent `ProtectCamera` and the log names the parent - correct, since there is no separate package-camera device to name.
   */
  private wireLivestreamNarration(): void {

    // A livestream was disrupted and an episode begins. Surface it to the user at the level the classification below decides, so a stream in genuine trouble is
    // visible while it is happening.
    const onRecoveryStarted = (message: unknown): void => {

      const payload = message as LivestreamRecoveryStartedPayload;
      const camera = this.getDeviceById(payload.cameraId);

      if(!camera) {

        return;
      }

      // Classify whether to log this episode quietly, and record that so the recovery edge - which cannot read the phase reliably, the controller having returned by then
      // - consults the same classification. The root's own expectation decision answers it, which is what keeps this episode's level and the recording arm's deferral
      // level in agreement: an interruption observed while we are rebooting or shutting down is expected, and so is the post-return re-establishment blip of a controller
      // reboot, whose recovery:started fires at episode entry seconds after the controller returned. This sits AFTER the ownership guard above: the unifi-protect
      // library's recovery channels are process-global, so recording before the guard would latch every OTHER controller's cameras too, and our own forgetCamera (scoped
      // to our removals) could never reclaim a foreign started-never-recovered entry.
      const quiet = this.isDisruptionExpected;

      this.livestreamEpisodes.record(payload.key, payload.cameraId, quiet);

      // A reboot blips every camera and is already narrated once at the controller level, so the per-camera flurry drops to debug whether the reboot was induced or
      // organic; a genuine single-camera drop on a controller that has not recently rebooted stays at warn - that one is in trouble and the noise is the signal.
      if(quiet) {

        camera.log.debug("The livestream was interrupted and is recovering.");
      } else {

        camera.log.warn("The livestream was interrupted and is recovering.");
      }
    };

    // The disrupted livestream recovered. Report the resolution and how long media was absent. `Math.max(1, ...)` avoids a nonsensical "0 s" on a sub-second recovery.
    const onRecoveryRecovered = (message: unknown): void => {

      const payload = message as LivestreamRecoveryRecoveredPayload;
      const camera = this.getDeviceById(payload.cameraId);

      if(!camera) {

        return;
      }

      // The current phase is not a reliable classification proxy here (the controller has returned), so the quiet/loud value latched at the interruption edge - not
      // this.phase - decides the level. Consume drains the entry; a never-recovered episode is reclaimed by forgetCamera on the camera's removal.
      const quiet = this.livestreamEpisodes.consume(payload.key);
      const recoveredAfter = formatSeconds(Math.max(1, payload.downtimeMs / 1000));

      // Mirror the interruption edge: the per-camera recovery of a reboot's tail (induced or recently observed) is debug, since the library narrates the controller-level
      // recovery; a genuine single-camera drop stays warn.
      if(quiet) {

        camera.log.debug("The livestream has recovered after %s.", recoveredAfter);
      } else {

        camera.log.warn("The livestream has recovered after %s.", recoveredAfter);
      }
    };

    // The recovery policy gave up on the episode - the third episode terminal. The buffer's consume loop already narrates the give-up to the user, and the retry
    // belongs to the availability edge and the demand kicks, so this handler's only duty is draining the episode's latch entry; otherwise an exhausted episode would
    // linger in the ledger until the camera's removal. Entries are recorded only for our own cameras behind the started-edge ownership guard, so a foreign
    // controller's key is simply absent here and the consume is a no-op - the drain needs no guard of its own to stay scoped.
    const onRecoveryExhausted = (message: unknown): void => {

      this.livestreamEpisodes.consume((message as LivestreamRecoveryExhaustedPayload).key);
    };

    protectChannels.livestreamRecoveryStarted.subscribe(onRecoveryStarted);
    protectChannels.livestreamRecoveryRecovered.subscribe(onRecoveryRecovered);
    protectChannels.livestreamRecoveryExhausted.subscribe(onRecoveryExhausted);

    // Detach every subscription on the terminal shutdown signal, mirroring the API-health feed. The unifi-protect library's channels are global and outlive any single
    // client, so an explicit unsubscribe on shutdown is what keeps these subscriptions leak-free.
    this.signal.addEventListener("abort", () => {

      protectChannels.livestreamRecoveryStarted.unsubscribe(onRecoveryStarted);
      protectChannels.livestreamRecoveryRecovered.unsubscribe(onRecoveryRecovered);
      protectChannels.livestreamRecoveryExhausted.unsubscribe(onRecoveryExhausted);
    }, { once: true });
  }

  /**
   * Whether a disruption happening right now is one we expect - the plugin induced it, or it lands inside the settling tail of a reboot we observed. Every narration
   * that tells a disruption story consults this one member, so the same blip reads the same way whichever story tells it. {@link isDisruptionExpected} in the policy
   * module is the definition; the reboot observation feeding its tail half stays private here, because the classification is what consumers need and the timestamp is
   * how it happens to be reached.
   */
  public get isDisruptionExpected(): boolean {

    return isDisruptionExpected({ lastRebootMs: this.lastRebootObservedAt, nowMs: this.platform.clock.now(), phase: this._phase,
      windowMs: PROTECT_NVR_REBOOT_RECENCY_MS });
  }

  /**
   * Current lifecycle phase. Components that need to distinguish induced disruption (rebooting, shutting down) from organic operation (running) consult this
   * property. Pure read - mutation goes through {@link transition} only.
   */
  public get phase(): NvrPhase {

    return this._phase;
  }

  /**
   * The terminal shutdown abort signal. Aborted exactly once, in `transition("shuttingDown")`. Every NVR-level observe loop and every per-accessory abort controller
   * composes against it, so a shutdown tears the whole tree down as one cascade. Pure read - the controller is private and aborted only through the transition
   * chokepoint.
   */
  public get signal(): AbortSignal {

    return this.#shutdownController.signal;
  }

  // Whether the terminal shutdown signal has fired - this controller is tearing down and no deferred wake may act against a disposed client. The single predicate this
  // root's post-await bails consult (connect()'s, after its retry and after a late-resolving client), read through a method so each caller re-reads the live signal
  // rather than a stale snapshot an earlier bail on the same path could have pinned.
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
   * The address this controller's cameras are reached at for their RTSP streams when the user overrides it, or null when no usable override is configured. The camera's
   * RTSP host chain reads it ahead of the address the controller reports for each camera. It is the answer configureOverrideAddress settled on at login, so a read
   * costs nothing and never checks the configuration again.
   */
  public get overrideAddress(): Nullable<string> {

    return this.#overrideAddress;
  }

  /**
   * Whether the plugin can vouch for what this controller feeds, the verdict every accessory's No Response starts from: unavailable once unifi-protect has concluded
   * the connection lost, or while the controller is rebooting, each until recovery. It reads those facts and never isHealthy, which is false at the library's first
   * fault, while it re-bootstraps a controller it has already proven reachable and while its request breaker is open: none of those mean the values have gone stale, and
   * refusing on them would mark every accessory No Response for a blip the library is already handling. Only the owners a connected controller builds read this.
   *
   * A controller whose signal has aborted is unavailable until a restart. Its client is disposed, and a disposed client's connection reads neither lost nor rebooting, so
   * its accessories would otherwise go on answering from a client with nothing left to tell them.
   */
  public get isAvailable(): boolean {

    return !this.signal.aborted && !this.client.connection.isLost && !this.client.connection.isRebooting;
  }

  /**
   * Whether API error logging is currently surfaced to the user. Errors are hidden during `shuttingDown`, where they are induced by our own teardown, and while a
   * scheduled reboot is on time, the gate the client logger's warn output reads too. Everywhere else they are visible: credential or address problems during
   * `connecting`, organic errors during `running`, and during `rebooting` a failure of the command itself or a controller that refuses the sign-in once the reboot is
   * overdue. Read by the unifi-protect client logger callback in this NVR's constructor.
   */
  public get logApiErrors(): boolean {

    return (this._phase !== "shuttingDown") && !this.reboot.isRebootOnTime;
  }

  // Move the NVR to a new lifecycle phase. The single chokepoint that keeps every derived effect aligned: it updates `_phase`, aborts the terminal shutdown signal on
  // entry to `shuttingDown`, then hands the phase to the health bridge so symptom observation matches whether we're in an induced disruption or organic operation.
  // The `logApiErrors` getter derives from `_phase` and the reboot scheduler's gate and needs no explicit update here.
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

    // Hand the new phase to the health bridge, which opens observation only in `running`. Every other phase is either initial setup, an induced disruption, or
    // termination - none are organic baselines against which stress can be meaningfully measured.
    this.health.notePhase(this._phase);

    // Re-evaluate the removal stability clock now that phase changed - one of the facts `good` depends on. Unconditional and last so the shuttingDown path always
    // runs the cancel-all (good becomes false, every pending removal is cleared) before disconnect() disposes the client. The notePhase above ran first, so on the
    // connect() path into running, health is already healthy when this stamps the startup good-state.
    this.#pushRemovalStability();
  }

  /* Recompute the controller's good-state and push it into the removal gate. Good means running AND reachable AND healthy AND the Device feature enabled; the phase
   * conjunct short-circuits first because the client is unset until the first connect resolves, and the good arm alone carries the uptime fact because the projection
   * is readable only once the client exists.
   *
   * phase===running excludes induced disruptions, connection.isHealthy is the unifi-protect library's authoritative reachability fact (it closes the gate promptly on
   * a socket-dropping outage - reboot, network loss, TCP RST - where the symptom-rate health model alone would drift back to healthy during a quiet outage, so we
   * must read the connection fact directly), and health.state===healthy excludes a reachable-but-stressed controller. The hasFeature("Device") conjunct means a
   * feature-disabled controller never reaches good-state: it returns from login() with its phase still running, so this conjunct is what keeps the sweep unarmed for
   * the life of the process. A library throttle makes connection.isHealthy false, since it derives the throttled state, so a throttle conservatively resets the clock.
   *
   * Each of these facts has its own trigger: transition() moves phase, the health stateChange handler moves health, and the connection observe loop moves reachability.
   * Every trigger calls here rather than assembling the conjunction itself, so the conjunction has exactly one definition.
   */
  #pushRemovalStability(): void {

    const good = (this._phase === "running") && this.client.connection.isHealthy && (this.health.state === "healthy") && this.hasFeature("Device");

    this.removals.refresh(good ? { good, upSince: this.ufp.upSince } : { good });
  }

  // Publish an NVR-level lifecycle milestone on the forward-only diagnostics channel. Zero-cost when no subscriber is attached (the Node-native sync check).
  private publishLifecycle(event: NvrLifecyclePayload["event"]): void {

    if(channels.nvrLifecycle.hasSubscribers) {

      channels.nvrLifecycle.publish({ event } satisfies NvrLifecyclePayload);
    }
  }

  /* Establish a connection to the Protect controller. The unifi-protect library's ProtectClient.connect() is atomic - it logs in, fetches the initial bootstrap, seeds
   * the reducer, and brings up the realtime events channel as one operation that throws when a step fails, owning retry/backoff and the periodic refresh failsafe
   * internally. What it resolves with is what the controller answered, which the attempt below reads before the client counts as connected. We
   * wrap it in a startup-resilient retry that waits by the library's own recovery schedules: its slower refusal schedule while the controller refuses our sign-in,
   * the privilege it needs or the rate of our requests, and its recovery schedule for every other fault. The retry runs until the controller accepts us or we shut
   * down, so a sign-in the controller starts accepting again is picked up by a later attempt rather than by a restart. The waits run on the platform's clock, so a
   * suite walks the whole ladder on virtual time. Safe to call more than once - each call establishes a fresh client under a fresh policy.
   *
   * The one exception is an address no URL can carry. The library refuses it before anything is sent, and refuses it the same way on every attempt, so the policy
   * vetoes it, the retry ends on the first attempt, and we say once that the address needs correcting. Nothing on the controller can change that answer.
   *
   * The policy tells us why every retried attempt failed, and we say so at the level the policy read: an unbounded retry that reports nothing leaves a user with no way
   * to tell a controller that is slow to appear from one that refuses us on every attempt. Each report runs through one repeat-demoting log, so a type of failure is said
   * in full the first time and again whenever the type changes, and an unchanged type goes to debug. A rate limit is said by its type alone, whichever spelling its 429
   * arrives in, because it is the controller asking to be asked less often and the retry already waits it out on the slower refusal schedule. The attempt wraps the
   * report rather than the failing call, because a rejection inside an attempt releases its lines at full level and remembers nothing. An attempt torn down by our own
   * shutdown is an orderly teardown rather than a reason to report, which is why the shutdown is read ahead of the attempt...inside it, a teardown would write a line at
   * its level for a new type and a debug line for a repeat.
   */
  private async connect(): Promise<boolean> {

    const failures = repeatDemotedLog<ConnectFailureType>(this.log);
    const { backoff, shouldRetry } = createConnectRetryPolicy({

      onFailure: ({ level, reason, type }: ConnectFailure): void => {

        if(this.#isShuttingDown()) {

          return;
        }

        failures.attempt((log: HomebridgePluginLogging): void => {

          const severity = (level === "error") ? "error" : "warn";

          if(type === "rate-limit") {

            log[severity]("Unable to connect to the Protect controller because it is rate limiting requests, and will keep trying on the slower refusal schedule.");

            return;
          }

          log[severity]("Unable to connect to the Protect controller, and will keep trying: %s.", reason);
        }, (): ConnectFailureType => type);
      }
    });

    try {

      this.client = await retry(async (signal): Promise<ProtectClient> => {

        const client = await this.#connectClient({ host: this.config.address, log: this.clientLog, password: this.config.password,
          recoveryPolicy: (context) => livestreamRecoveryDecision(context,
            { healthState: this.health.state, isHealthy: this.client.connection.isHealthy, isThrottled: this.client.connection.isThrottled, phase: this.phase },
            this.episodeCameraReachable(context.cameraId)), signal,
          username: this.config.username });

        /* A controller can answer its bootstrap with no record, or a record with no version or a MAC that is no string, and the client resolves with what it was given. A
         * MAC that is no string makes the debug gate throw from inside unifi-protect's own lines. The record is read here, inside the attempt, so that answer is a failed
         * attempt like any other: the attempt disposes what it built, the policy reads and reports it, and the retry waits on the recovery schedule. Read after the
         * retry, the same answer would reject the login and stop a controller that a later attempt could still connect.
         */
        const record = client.nvr.peek();

        if((typeof record?.version !== "string") || (typeof record.mac !== "string")) {

          await client[Symbol.asyncDispose]();

          throw new Error(UNREPORTED_CONTROLLER_RECORD);
        }

        return client;
      }, { attempts: Infinity, backoff, clock: this.platform.clock, shouldRetry, signal: this.signal });
    } catch(error) {

      /* The attempts are unbounded, so the retry rejects only on our own shutdown, which is an orderly teardown rather than a failure to report, or on the policy's
       * veto of an address no URL can carry. The shutdown is read first, so a refused address meeting a shutdown in progress stays as quiet as every other attempt a
       * shutdown ends. The veto is said here and nowhere else, because the policy reports nothing for it, and the line carries no credential: the library's message
       * names the address masked, and so does this controller's prefix.
       */
      if(!this.#isShuttingDown()) {

        this.log.error("Unable to connect to the Protect controller, and will not keep trying until its address is corrected in the plugin settings: %s.",
          formatErrorMessage(error));
      }

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
    if(!isSupportedProtectVersion(version)) {

      this.log.error(UNSUPPORTED_PROTECT_VERSION);
      await this.client[Symbol.asyncDispose]();

      return false;
    }

    // Assign our log-prefix name, decorated with the controller model - "Name [Model]" via describeDevice - so every controller-scoped line shows the hardware
    // in its prefix. The name is the controller's own reported name, falling back to its address when the controller has not reported one; describeDevice only appends
    // the bracketed model, and is reached here post-bootstrap where this.ufp is populated. Early, pre-bootstrap logs keep the bare name set in the constructor.
    this.name = describeDevice(this.ufp, { name: this.client.controllerName ?? this.config.address });

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

  // Wire every per-client connection subscription against the freshly-established client. The health bridge translates the throttle rails into its own symptoms and
  // hands both subscriptions back for this array to own; the controller-lost/rebooted/recovered listeners are the root's own and drive lifecycle telemetry. We dispose
  // any prior subscriptions first so a reconnect (which builds a fresh client) never leaves a listener bound to a disposed connection monitor. All of them are bound to
  // the client's lifetime, not the shutdown signal, because the client - and therefore its connection monitor - is itself replaced on a reconnect.
  private wireConnectionHealth(): void {

    for(const subscription of this.connectionSubscriptions) {

      subscription[Symbol.dispose]();
    }

    this.connectionSubscriptions = [

      ...this.health.wireClient(this.client.connection),
      this.client.connection.on("controllerLost", () => this.publishLifecycle("controllerLost")),
      this.client.connection.on("controllerRebooted", () => this.onControllerRebooted()),
      this.client.connection.on("controllerRecovered", () => this.onControllerRecovered())
    ];
  }

  // React to a controller reboot detection, whether we induced it or it happened organically. This handler records the observation (our own-clock recency anchor),
  // publishes the lifecycle milestone (the unifi-protect library already logs the detection at info, so we do not duplicate it), and resets each camera's probesize
  // self-tuning; the induced-reboot resume is driven separately by the connection's recovery edge in startConnectionObserver, so it is not this handler's concern.
  private onControllerRebooted(): void {

    // Record our own-clock observation of this reboot. This is the SSOT moment the plugin learns a reboot happened (induced or organic), so it anchors the settling
    // window `isDisruptionExpected` weighs when a disruption lands after the plugin has already concluded the reboot and resumed running.
    this.lastRebootObservedAt = this.platform.clock.now();

    this.publishLifecycle("controllerRebooted");

    // Every reboot re-adopts and restarts each camera's stream from scratch, so clear each camera's accumulated probesize self-tuning - a per-camera latch that at its
    // permanent ceiling arms no auto-reset and otherwise persists for the life of the delegate. We accept one baseline re-tune per reboot on a chronically-flaky camera
    // rather than a forever-elevated probesize. The endpoints iterator walks package cameras alongside their parents, so the package's delegate resets here too. The
    // same walk starts each camera watching for its own return, so a camera that never comes back from this reboot is called out instead of disappearing quietly;
    // package cameras take an inert override there, because their parent's watch already speaks for the shared hardware.
    for(const device of deviceEndpoints(this.configuredDevices)) {

      if(!(device instanceof ProtectCamera)) {

        continue;
      }

      device.streaming?.recoverFromControllerReboot();
      device.noteControllerRebooted();
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
  // We clear the no-op confirmation and the expected return (a real recovery edge proves the reboot took effect) and reset the pre-reboot health history: the
  // controller is freshly booted, so any stress or library-throttle state latched before the reboot is no longer relevant. The suspend held across the whole rebooting
  // phase kept induced symptoms out of the buffer, but the latched state enum and the throttle flag clear only on a reset or a fresh clearing observation, so we reset
  // explicitly here - restoring the clean baseline the connect()-driven reset gives us. The library already narrates the recovery itself, so this method does not log a
  // duplicate "back online" line. (The no-op path produces no recovery edge and resumes through the scheduler's own no-op confirmation instead, which deliberately does
  // NOT reset: a controller that never actually rebooted keeps its still-relevant health history.)
  private resumeFromInducedReboot(): void {

    if(this._phase !== "rebooting") {

      return;
    }

    this.reboot.noteRebootConfirmed();
    this.health.reset();
    this.transition("running");
  }

  // Cleanly disconnect from the Protect controller. This tears down all connection-dependent resources (active HomeKit streams, HKSV timeshift buffers, the
  // connection-health subscriptions, and the unifi-protect client itself) while preserving one-time infrastructure (playlist servers, MQTT, event listeners).
  private async disconnect(): Promise<void> {

    // Tear down all connection-dependent camera resources. Active HomeKit streaming sessions and HKSV timeshift buffers both depend on the controller connection.
    // Shutting them down proactively prevents error noise from livestream self-healing and FFmpeg processes communicating with a disconnected controller. The camera
    // does not own its own session manager, so disposing these consumers is what releases their underlying unifi-protect livestream pool subscriptions. This
    // is a STRICT ORDERING REQUIREMENT - the connection-dependent consumers (and the pool subscriptions they hold) are torn down in this loop BEFORE the
    // unifi-protect client is disposed below, so no subscription outlives the client it draws from. The endpoints iterator walks package cameras alongside their parents.
    for(const device of deviceEndpoints(this.configuredDevices)) {

      if(!(device instanceof ProtectCamera)) {

        continue;
      }

      device.streaming?.releaseForShutdown();
    }

    // Detach the connection-health subscriptions so they do not outlive the client whose connection monitor they observe.
    for(const subscription of this.connectionSubscriptions) {

      subscription[Symbol.dispose]();
    }

    this.connectionSubscriptions = [];

    // Dispose the unifi-protect client - tearing down the connection monitor, livestream pool, state store, session, and transport pool, in that order. The client is
    // definite-assignment typed for the connected lifetime, but a controller that has not connected, whatever kept it from connecting, reaches here with nothing
    // assigned; the cast guards that state without widening the field's type for every connected-path read.
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

      // Unregister all the accessories for this controller from Homebridge. Homebridge restores every cached accessory before it signals that launching has finished,
      // and we log in only after that signal, so the platform's accessory list is complete when we get here...the sweep runs at once, and none of ours arrive later.
      // Each removal runs through the shared isolation, so one accessory that cannot leave HomeKit is said once and costs the accessories behind it nothing, where a
      // throw would otherwise end the sweep and reject login().
      for(const accessory of this.platform.accessories.filter(x => x.context.nvr === this.ufp.mac)) {

        isolateAccessoryChange({ act: "remove", change: () => this.removeHomeKitDevice(accessory), log: this.log, name: accessory.displayName });
      }

      // removeHomeKitDevice's ownership guards early-return the system-information, liveview, and security-system accessories, deferring their removal to
      // ProtectNvrSystemInfo and ProtectLiveviews. On the disabled path those owners are never constructed, so nothing else will ever reclaim those accessories - this
      // sweep is their removal path, and it also takes any accessory a failed removal above left on the platform. The filter yields an independent snapshot to iterate,
      // so the shared tail is free to splice the live platform list as it removes each one. The narration is deliberately short: these accessories are always bridged
      // and carry no model key, so removeHomeKitDevice's fuller "Removing <model> from HomeKit" line would render malformed here.
      for(const accessory of this.platform.accessories.filter(x => x.context.nvr === this.ufp.mac)) {

        this.log.info("%s: Removing from HomeKit.", accessory.displayName);
        isolateAccessoryChange({ act: "remove", change: () => this.removeAccessoryFromHomeKit(accessory), log: this.log, name: accessory.displayName });
      }

      // A controller disabled in HomeKit serves nothing, so it holds no console session either. The sweep above needed the live client to know which accessories are
      // ours; once it is done, disconnecting disposes the client and detaches its connection-health subscriptions, so the controller neither keeps an idle
      // authenticated session open nor narrates its connection health for the life of the process.
      await this.disconnect();

      return;
    }

    // Configure any NVR-specific settings.
    this.configureNvr();

    /* Initialize MQTT before building the accessory owners. The MQTT subscriptions they make as they are configured (system information, and liveviews on its initial
     * reconcile) bind through nvr.mqtt, so the client must exist first or those subscriptions would silently no-op against a not-yet-created client and never be
     * retried. The client binds to the NVR's terminal shutdown signal, so it is an AsyncDisposable whose connection ends on a shutdown rather than leaking past it.
     * The resolution runs post-connect, where this.ufp is safe to read for the controller scope it resolves at.
     *
     * The library resolves both settings in one place, applying the rule that a configured option answers in every state it can be in: an option the user turned
     * off, or enabled without giving it a value, is the user saying MQTT is off for this controller, the controller's own configuration properties answer only
     * where no option speaks, and a null answer means there is nothing to connect to and no client is constructed at all.
     */
    const mqttSettings = mqttConnectionSettings({ config: this.config, controller: this.ufp.mac, featureOptions: this.platform.featureOptions });

    this.mqtt ??= mqttSettings && createMqttClient({ ...mqttSettings, log: this.log }, { signal: this.signal });

    this.#configureAvailability();

    // Initialize our liveviews.
    this.liveviews = configured(new ProtectLiveviews(this));

    // Initialize our NVR system information.
    this.systemInfo = configured(new ProtectNvrSystemInfo(this));

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
    // unifi-protect projection from their own configure passes - the subject owns its reactivity, the same model the per-device leaves use. Orphan cleanup does not run
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

  /* Register this controller's own availability statement with the client, the one registration ahead of every owner's, so its connect restatement opens each session's.
   * The controller's MAC is the scope its liveview, security system and system information topics sit under, so this statement speaks for all of them. The final word is
   * what the graceful end states while its session holds, published under the very signal the end hands it, the one signal it admits, and with no change gate, because
   * the broker has to hold offline whatever this controller last stated.
   */
  #configureAvailability(): void {

    const mqtt = this.mqtt;

    mqtt?.onConnect(() => this.#restateAvailability(), { signal: this.signal });
    mqtt?.onEnd(async (signal: AbortSignal): Promise<void> => mqtt.publish(mqttTopic(this.ufp.mac, mqttTopics.availability.topic), MQTT_AVAILABILITY_OFFLINE,
      { retain: true, signal }), { signal: this.signal });
  }

  // State an availability on a MAC's topic, retained so a subscriber attaching later reads it, and change-gated so a path that leaves it standing publishes nothing.
  #publishAvailability(mac: string, availability: MqttAvailabilityPayload): void {

    this.mqtt?.publishGuarded(mqttTopic(mac, mqttTopics.availability.topic), availability, { ifChanged: true, retain: true });
  }

  // State this controller's availability from its verdict, the root's half of what every accessory it feeds reads.
  #publishControllerAvailability(): void {

    this.#publishAvailability(this.ufp.mac, this.isAvailable ? MQTT_AVAILABILITY_ONLINE : MQTT_AVAILABILITY_OFFLINE);
  }

  // State the retained offline of a device of this controller that nothing serves. A device the user disabled has no MQTT surface, this statement included.
  #publishUnserved(mac: string): void {

    if(this.platform.featureOptions.test("Device", mac, this.ufp.mac)) {

      this.#publishAvailability(mac, MQTT_AVAILABILITY_OFFLINE);
    }
  }

  // State a removed device's retained offline, or with no broker session standing hold it for the next one, because a statement issued with no session is refused and
  // never repeated, which would leave the online it last stated retained for good.
  #publishRemoval(mac: string): void {

    if(this.mqtt?.connected === false) {

      this.#unheardRemovals.add(mac);

      return;
    }

    this.#publishUnserved(mac);
  }

  /* What a new broker session is told about availability from here: this controller's statement, then a retained offline for each removal no session heard, then one for
   * each restored accessory of this controller no owner has claimed, one whose setup threw among them. A statement issued with no session is refused and never repeated,
   * and login adopts its devices ahead of any session, so this is what reaches a subscriber for an accessory that stands with nothing answering for it. A device claims
   * its accessory ahead of the statement its configure makes, so every live device falls outside this and states its own on the same session.
   *
   * A held removal is said once and a removal a session heard is not said again. This is the one place that reads who serves a held MAC, rather than a delete where a
   * device is adopted as well. The cascade takes a device out of configuredDevices ahead of its tail, so a removal that failed reads as unserved and is said, while a
   * device adopted again reads as served and speaks for itself. An accessory standing under another controller is that controller's to state, and a word said over it
   * would stand until that controller's next statement.
   */
  #restateAvailability(): void {

    this.#publishControllerAvailability();

    for(const mac of this.#unheardRemovals) {

      const uuid = this.hap.uuid.generate(mac);
      const controller = this.platform.accessories.find(x => x.UUID === uuid)?.context.nvr;

      if(!this.configuredDevices.has(uuid) && (!controller || (controller === this.ufp.mac))) {

        this.#publishUnserved(mac);
      }
    }

    this.#unheardRemovals.clear();

    for(const accessory of this.platform.accessories) {

      if(accessory.context.mac && (accessory.context.nvr === this.ufp.mac) && !this.platform.isAccessoryClaimed(accessory)) {

        this.#publishUnserved(accessory.context.mac);
      }
    }
  }

  // Configure NVR-specific settings.
  private configureNvr(): boolean {

    // Configure scheduled reboots if enabled.
    this.configureScheduledReboot();

    // Resolve the address override our cameras' RTSP URLs are composed against.
    this.configureOverrideAddress();

    return true;
  }

  /* Resolve the address override for this controller's cameras through the shared rule, resolveOverrideAddress, which reads the address override option ahead of the
   * legacy per-controller property. An override the rule refuses, an IPv6 address carrying a zone that cannot stand in a URL, is set aside with one warning naming it,
   * and each camera resolves its RTSP URLs against the address the controller reports for it instead.
   *
   * This runs once per login, after the connect that makes the controller-scoped option readable and before any camera is adopted. The configuration is fixed for the
   * life of the process, so one resolution serves every channel-profile derivation and RTSP URL request that follows, and the warning is said once per controller.
   */
  private configureOverrideAddress(): void {

    const resolution = resolveOverrideAddress({ legacy: this.config.overrideAddress, option: this.getFeatureValue("Nvr.OverrideAddress") });

    if(resolution.kind === "refused") {

      this.log.warn(OVERRIDE_ADDRESS_ZONE_WARNING, resolution.address);
    }

    this.#overrideAddress = (resolution.kind === "resolved") ? resolution.address : null;
  }

  // Configure scheduled reboots of the Protect controller.
  private configureScheduledReboot(): void {

    // Retrieve the reboot interval. A null return means the option is explicitly disabled.
    const rebootInterval = this.getFeatureFloat("Nvr.Reboot");

    if(rebootInterval === null) {

      return;
    }

    // Enter the schedule. Past the null gate the value is either the user's explicit interval or undefined for the enabled-without-a-value case, and the scheduler owns
    // the default and the minimum clamp alike, so it travels through as it stands.
    this.reboot.schedule({ requestedIntervalHours: rebootInterval, upSince: this.ufp.upSince });
  }

  // The live unifi-protect device config records across every category, flattened by the policy module's device inventory read. The read path for the discovery dump
  // and the adopted-MAC set the orphan sweep reads, so neither re-derives the controller's device inventory from a held snapshot.
  private get deviceConfigs(): ProtectDeviceConfig[] {

    return deviceInventory(this.client.state);
  }

  // Resolve the live config record for a device id within a category, from the unifi-protect projection. The single read path the membership reconcile uses to turn a
  // freshly-adopted id into the record it feeds to addHomeKitDevice.
  private deviceConfig(category: DeviceCollectionKey, id: string): Nullable<ProtectDeviceConfig> {

    return this.client.state.selectors[category].byId(id)(this.client.state.snapshot()) ?? null;
  }

  // Reconcile one device category's HomeKit membership against the controller's current adopted-id set. One engine handles both membership and adoption changes: an
  // adopted id we have not configured is added; a configured device whose id has left the adopted set is
  // removed. The content-memoized adopted-id selectors wake the observe loop only on a genuine membership change (add, removal, or adoption flip), never on the
  // continuous lastSeen/stats churn, so the reconcile cost scales with real membership deltas rather than with refresh frequency. Called once at login with the
  // current snapshot (initial population) and on each subsequent observe yield (ongoing deltas) - one function, both roles.
  private reconcileMembership(category: DeviceCollectionKey, adoptedIds: readonly string[]): void {

    const { toAdd, toRemove } = membershipDelta(adoptedIds, this.devices(category).map(device => device.protectId));

    /* Add any adopted id we have not yet configured, resolving its live config record from the projection. Each add runs through the shared isolation, so one device's
     * fault costs its siblings nothing: a throw would otherwise unwind the whole pass, out of login() for the startup seed, through superviseLoop's terminal catch for an
     * observer pass, which ends that category's adds and removals until a restart, and out of the stability sweep's bare timer. A device whose add failed is still
     * outside the configured set, so the next pass over its category retries it.
     */
    for(const id of toAdd) {

      const config = this.deviceConfig(category, id);

      if(config) {

        isolateAccessoryChange({ act: "add", change: () => this.addHomeKitDevice(config), log: this.log, name: describeDevice(config) });
      }
    }

    // A device leaving the adopted set is no longer available, whether or not it is removed, and the observer that follows its own record skips a vanished one, so its
    // statement is made here, ahead of the stability gate below.
    for(const id of toRemove) {

      this.getDeviceById(id)?.publishAvailability();
    }

    // Mark for removal any configured device that has left the adopted set - but ONLY when the controller is stable (good for >= the window). During or right after a
    // disruption we mark nothing; the controller may merely be re-adopting, and the stability sweep re-evaluates once it settles. The content-memoized adopted-id
    // selector already ignores transient disconnect churn (a disconnected-but-adopted device stays in the set), so a toRemove id is a genuine unadopt; the stability gate
    // adds the destructive-action safety on top. Marking honors the user's DelayDeviceRemoval grace before the actual removal.
    if(this.removals.removalStable) {

      for(const id of toRemove) {

        const device = this.getDeviceById(id);

        if(device) {

          this.removals.schedule({ accessory: device.accessory,
            stillGone: () => !this.client.state.selectors[category].adoptedIds(this.client.state.snapshot()).includes(id) });
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

      if(accessory.context.systemInfo || accessory.context.liveviewDerived) {

        continue;
      }

      const mac = accessory.context.mac;

      if(mac && !knownMacs.has(mac)) {

        this.removals.schedule({ accessory: accessory, stillGone: () => !this.currentAdoptedMacs().has(mac) });
      }
    }
  }

  // Spawn the per-category device-membership observe loops, seeding each with an initial population pass. The unifi-protect client's observe() yields on change, not
  // the current value, so each loop reconciles once against the current snapshot before awaiting deltas. The loops are bound to the terminal shutdown signal and
  // assume a stable client for the plugin's connected lifetime - a rule the unifi-protect library guarantees, since the ConnectionMonitor recovers an outage without
  // recreating the client. The scheduled reboot rides that same surviving client (it POSTs client.reboot() and lets the connection monitor auto-recover, recreating
  // nothing), so the stable-client assumption holds across a reboot too and the loops never need re-spawning.
  private startDeviceObservers(): void {

    for(const key of DEVICE_COLLECTION_KEYS) {

      const ids = this.client.state.selectors[key].adoptedIds;

      // Initial population from the current snapshot, then react to membership deltas.
      this.reconcileMembership(key, ids(this.client.state.snapshot()));

      this.spawnLoop("the " + key + " list", async () => {

        for await (const adoptedIds of this.client.state.observe(ids, { signal: this.signal })) {

          this.reconcileMembership(key, adoptedIds);
        }
      });
    }
  }

  // Re-assess the full device inventory now that the controller is stable, marking for (graced) removal anything genuinely gone. The one-time sweep on reaching
  // stability: immediate at startup for a controller already up past the window (the uptime backdate), the window after any recovery otherwise. Cache cleanup is
  // stability-gated along with membership removal, so a cached orphan is removed only once the controller has held good for the window.
  private sweepRemovableDevices(): void {

    if(!this.removals.removalStable) {

      return;
    }

    for(const key of DEVICE_COLLECTION_KEYS) {

      this.reconcileMembership(key, this.client.state.selectors[key].adoptedIds(this.client.state.snapshot()));
    }

    this.sweepOrphans();

    // The package-camera pass: reconcile each doorbell's package camera against the live capability flag. This sweep is both the construction-time arm (it runs at
    // the first post-startup stability, catching a capability withdrawn while the plugin was down - the across-restart ghost a cached BRIDGED package accessory would
    // otherwise be forever, since the orphan sweep keys on a mac the package deliberately lacks) and the re-arm (a detach grace dropped when the gate left good-state,
    // or a fire that failed its stability re-check, is re-scheduled when stability returns).
    for(const device of this.devices("camera")) {

      // Gate the package reconcile on the parent record being present: reconcilePackageCamera reads the parent's featureFlags and MAC, which would
      // throw for a camera lingering in the removal grace. A device with a vanished record is on its way out, so skipping it is correct.
      if(device.recordPresent) {

        device.doorbell?.reconcilePackageCamera();
      }
    }

    // The liveviews pass, re-armed the way the package-camera pass is: a liveview switch or the security system whose liveviews are gone, and whose removal the gate
    // refused or dropped while the controller was unsettled, is scheduled again now that stability has returned. On a controller still settling when the plugin starts,
    // that includes an accessory whose liveviews were deleted while the plugin was down: the gate refused the removal the startup reconcile asked for, and with no
    // liveview change to reconcile again, this pass is what schedules it at the first stability. A controller already up past the window is stable at login, where the
    // startup reconcile schedules that removal itself.
    this.liveviews?.configureLiveviews();
  }

  // Spawn the connection-state observe loop - the single consumer of connection.observe(), carrying the controller-wide duties of each transition. First it concludes an
  // induced reboot on the connection's recovery edge (so the resume goes through this existing iterator rather than a second subscription); then it re-evaluates the
  // removal stability clock, states this controller's availability, and tells every device the connection moved. The connection is one fact with one reader: rather than
  // N devices each subscribing to the connection monitor (which would be 2N iterators and N readers of a single fact), this loop walks the configured devices and calls
  // each one's noteConnectionChanged. Pull where the fact is per-device (the per-device leaf observers); push where the fact is controller-wide (here). The endpoints
  // iterator walks package cameras, so each is told first-class rather than fanned out by the parent doorbell.
  private startConnectionObserver(): void {

    this.spawnLoop("the controller connection", async () => {

      for await (const transition of this.client.connection.observe({ signal: this.signal })) {

        // Conclude an induced reboot the moment the connection recovers - a non-healthy -> healthy edge while rebooting. The decision is the pure
        // shouldResumeFromInducedReboot; this is the single existing consumer of the connection-state stream, so the check lives here rather than a second subscription.
        // We do it before the stability re-evaluation below so a resume's transition("running") + health.reset() land first, and that step sees the running phase.
        if(shouldResumeFromInducedReboot({ from: transition.from, phase: this._phase, to: transition.to })) {

          this.resumeFromInducedReboot();
        }

        // Re-evaluate the removal stability clock - reachability is the third fact `good` depends on, and this loop is what drives that fact. An organic outage publishes
        // only a lifecycle event (controllerLost emits no phase or health change) and the symptom-rate health model drifts back to healthy during a quiet outage, so
        // without re-evaluating here on every connection-state transition a grace timer could fire mid-outage. connection.observe() yields on every state change
        // (degraded / lost / reconnecting / healthy), so reading connection.isHealthy here is what closes the gate the moment a socket-dropping outage begins.
        this.#pushRemovalStability();

        this.#publishControllerAvailability();

        for(const device of deviceEndpoints(this.configuredDevices)) {

          device.noteConnectionChanged();
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
   * holds zero policy: one new, on request, by the decision-owner, which configures what it receives. Routing construction upward follows the codebase rule that
   * device-layer objects reach the NVR only through inherited fields, never value-imports - so the camera calling this DURING its own setup forms no module import edge,
   * and the device layer is structurally cycle-proof. It is safe to call mid-setup because the method has no dependence on NVR state being mutated at that time.
   */
  public createDoorbellCapability(camera: ProtectCamera, device: Camera, signal: AbortSignal): DoorbellCapability {

    return new DoorbellCapability(this, { device: device, host: camera, signal: signal });
  }

  // Construct a package camera for a doorbell capability that has provisioned one. The same graph-assembly reasoning as createDoorbellCapability: the capability keeps
  // the entire lazy decision (the package-flag observer, the stability sweep, the private parent projection), and only the new moves here. The capability passes the
  // accessory it created or found plus its own parent projection; this method holds one new and no policy.
  public createPackageCamera(accessory: ProtectAccessory, device: Camera): ProtectCameraPackage {

    return new ProtectCameraPackage(this, accessory, device);
  }

  // Construct an ambient light capability for a camera. The same graph-assembly reasoning as createDoorbellCapability: the camera keeps the entire lifecycle decision
  // (its reconcile chokepoint asks for the capability the first time it reconciles, and the capability itself decides whether the sensor exists), and only the one new
  // lands here, holding no policy.
  public createAmbientLightCapability(camera: ProtectCamera, device: Camera, signal: AbortSignal): AmbientLightCapability {

    return new AmbientLightCapability(this, { device: device, host: camera, signal: signal });
  }

  // Construct a streaming capability for a camera. The same graph-assembly reasoning as createDoorbellCapability: the camera keeps the entire lifecycle decision (it
  // acquires the capability when it is configured and drives every reconcile from its own observers), and only the one new lands here, holding no policy. It takes no
  // projection handle because the capability reads the camera's own live projection through its host.
  public createStreamingCapability(camera: ProtectCamera, signal: AbortSignal): StreamingCapability {

    return new StreamingCapability(this, { host: camera, signal: signal });
  }

  // Remove the doorbell-only services a demoted-while-down doorbell left on a now-plain camera accessory - the sweep-stale removal the camera's reconcile runs when the
  // controller does not report a doorbell and no capability is attached. The removal logic is the DoorbellCapability's own SSOT (it owns the doorbell-only service
  // set); this interface routes the camera's request through the composition root so the camera never value-imports the sibling capability class - the same
  // removal-machinery-at-the-root rule the package sweep follows, keeping the device layer structurally cycle-proof (sibling device classes are type-only in the
  // device leaves).
  public removeStaleDoorbellServices(accessory: ProtectAccessory): void {

    // Only a sweep that removed something changed what Homebridge's accessory cache holds for the accessory, so only that sweep marks it for the next save.
    if(DoorbellCapability.removeServices(accessory, this.hap, this.log)) {

      this.platform.persistence.persist(accessory);
    }
  }

  // Construct and configure the HomeKit device for a freshly-adopted id in one category, wiring its live unifi-protect projection into the accessory. The
  // projection-acquisition and construction policy lives here at the composition root, which knows the concrete type at the point of adoption; both come off the
  // category's descriptor row. The projection handle is undefined only when the record has not yet reduced, in which case there is nothing to adopt yet, so we bail
  // without configuring the accessory. The device is recorded only once configured() returns, so the map holds configured devices alone and one whose setup threw is
  // released rather than recorded.
  #adoptDevice<K extends DeviceCollectionKey>(key: K, id: string, accessory: ProtectAccessory): Nullable<ProtectDeviceTypes[K]> {

    const descriptor = this.deviceDescriptors[key];
    const projection = descriptor.projection(this.client, id);

    if(projection === undefined) {

      return null;
    }

    const device = configured(descriptor.construct(accessory, projection));

    this.configuredDevices.set(accessory.UUID, device);

    return device;
  }

  // Add a newly detected Protect device to HomeKit.
  public addHomeKitDevice(device: ProtectDeviceConfig): boolean {

    // If we have no controller MAC, no device MAC, or this device isn't adopted by this controller, we're done.
    if(!this.ufp.mac || !device.mac || device.isAdoptedByOther || !device.isAdopted) {

      return false;
    }

    // The runtime vocabulary gate: a wire category outside the supported device-collection set is filtered here, so the typed adoption lookup below stays total. A device
    // whose modelKey is not a supported category is announced once and skipped.
    if(!DEVICE_COLLECTION_KEYS.includes(device.modelKey)) {

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
    this.removals.cancelFor(uuid);

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

      // The accessory is minted under the custom name the user set where HomeKit can carry it, the name its configure pass applies, because a standalone device is
      // published under the name it is minted with before that pass runs.
      const name = deviceDisplayName(device, { override: this.platform.featureOptions.value("Device.Name", device.mac, this.ufp.mac) });

      accessory = new this.api.platformAccessory<ProtectAccessoryContext>(name, uuid);

      this.log.info("%s: Adding %s to HomeKit%s.", describeDevice(device), device.modelKey,
        this.hasFeature("Device.Standalone", device) ? " as a standalone device" : "");

      // Register this accessory with homebridge and add it to the accessory array so we can track it. We mark it as well, so the save that closes this window carries
      // what the device's configure pass below sets up on it.
      if(this.hasFeature("Device.Standalone", device)) {

        this.api.publishExternalAccessories(PLUGIN_NAME, [accessory]);
      } else {

        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }

      this.platform.accessories.push(accessory);
      this.platform.persistence.persist(accessory);
    }

    // Setup the accessory as a new Protect device in the plugin if we haven't configured it yet. A device we already track needs no action here: its state now arrives
    // through the per-device observe loops, not a synthetic refresh re-emit, so there is nothing to re-merge.
    if(!this.configuredDevices.has(accessory.UUID)) {

      this.#adoptDevice(device.modelKey, device.id, accessory);
    }

    return true;
  }

  // Remove an individual Protect accessory from HomeKit, every guard and the package-camera cascade included, through the device-removal cascade. The disabled-controller
  // sweep and the self-reject in addHomeKitDevice call through here, and a fired removal grace reaches the same cascade through the removal gate's action.
  public removeHomeKitDevice(accessory: ProtectAccessory): void {

    this.#removalCascade.removeDevice(accessory);
  }

  // Remove an accessory from HomeKit and the platform's accessory list through the device-removal cascade's shared tail, which every removal of one of our accessories
  // ends in. The owners that manage their own accessories - the liveviews, the doorbell's package camera, the system information - remove them through here.
  public removeAccessoryFromHomeKit(accessory: ProtectAccessory): void {

    this.#removalCascade.removeAccessory(accessory);
  }

  // Return all configured devices of a particular category. The category is required: an omitted argument would filter every device's modelKey against undefined and
  // silently return nothing, so an optional argument here would advertise a "return everything" the filter cannot deliver.
  private devices<T extends DeviceCollectionKey>(model: T): ProtectDeviceTypes[T][] {

    // The type guard narrows each device to the category's concrete class off its modelKey, so the filtered array is ProtectDeviceTypes[T][] without a cast; every
    // device's modelKey is set consistently with its class per the ProtectDeviceTypes mapping, which the guard restates for the compiler.
    return [...this.configuredDevices.values()].filter((device): device is ProtectDeviceTypes[T] => device.modelKey === model);
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

  // Utility to return a value-centric feature option for this controller. The mac rides the controller argument: the options this helper serves declare
  // controller scope, which resolves only through that slot.
  public getFeatureValue(option: string): Nullable<string | undefined> {

    return this.platform.featureOptions.value(option, undefined, this.ufp.mac);
  }

  // Utility for checking feature options on the NVR.
  public hasFeature(option: string, device?: ProtectDeviceConfig | ProtectNvrConfig): boolean {

    return this.platform.featureOptions.test(option, device?.mac, this.ufp.mac);
  }
}
