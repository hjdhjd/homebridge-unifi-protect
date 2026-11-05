/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * testing.helpers.ts: The controller-subsystem test helpers for homebridge-unifi-protect.
 *
 * This file owns the controller half of the harness: TestProtectNvr, the NVR double every device test is constructed against, together with the platform double, the
 * recording MQTT client, the NVR config builder, and the family builder that assembles a whole accessory set. The NVR double mirrors the surfaces production reaches
 * for through its owner - the Homebridge API and accessory persistence, the managed-device registry - and embeds the controller's companions as the REAL production
 * objects rather than stubs of them: the ProtectEventDispatch behind its events member, the DiagnosticsHealthBridge behind health, the RemovalStabilityGate behind
 * removals, the DeviceRemovalCascade behind every removal and the shared removal tail, and the RebootScheduler behind reboot. So a routed event, a removal decision and
 * the removal it runs, and a reboot attempt alike travel the production path. makeTestNvr is the composition root of the harness: it wires a store, a platform, a
 * dispatch, and the streaming-delegate factory into a controller a real device class can be constructed against end to end, with no FFmpeg, over HBPU's Homebridge
 * API double and the real HAP the root harness loads. A row that runs the real controller root itself builds it over the same double's platform through
 * makeRootPlatform, with a client double answering its connect port, makeConnectedClient's for a connected controller, and TestConnection as its connection monitor.
 *
 * Fidelity to the cited contracts, not invention, is the line these doubles hold: the removal decision IS ProtectNvr's own gate class and the removal it runs IS
 * ProtectNvr's own cascade class, the MQTT surface is homebridge-plugin-utils', and the API double is HBPU's own, running Homebridge's bridge bookkeeping over the
 * real accessories. The cross-cutting core - the Homebridge runtime, the state store, and the streaming-delegate stub - lives in the root harness this file imports
 * from.
 */
import { APIEvent, AccessoryPersistence, FeatureOptions, MQTT_AVAILABILITY_OFFLINE, mqttTopic, onAbort, prefixedLog } from "homebridge-plugin-utils";
import type { Camera, Chime, ProtectCameraConfig, ProtectClient, ProtectEventMetadata, ProtectNvrConfig, ProtectNvrLiveviewConfig,
  ProtectRingtoneConfig } from "unifi-protect";
import type { HomebridgePluginLogging, LivestreamProcessFactory, Nullable, RecordingProcessFactory } from "homebridge-plugin-utils";
import type { NvrPhase, ProtectNvr } from "./nvr.ts";
import { OVERRIDE_ADDRESS_ZONE_WARNING, isDisruptionExpected, resolveOverrideAddress } from "./nvr-policy.ts";
import { PLATFORM_NAME, PLUGIN_NAME, PROTECT_NVR_REBOOT_RECENCY_MS, PROTECT_NVR_REMOVAL_STABILITY_WINDOW } from "../settings.ts";
import type { ProtectAccessory, ProtectDevices } from "../types.ts";
import type { ProtectNvrOptions, ProtectOptions } from "../options.ts";
import { TestClock, TestLivestreamProcessFactory, TestMqttClient, TestRecordingProcessFactory, capturingLog } from "homebridge-plugin-utils/testing";
import type { TestHomebridgeApi, TestLogEntry } from "homebridge-plugin-utils/testing";
import type { TestProtectAccessory, TestStateStore } from "../testing.helpers.ts";
import { TestStreamingDelegateFactory, makeTestAccessory, makeTestApi } from "../testing.helpers.ts";
import { featureOptionCategories, featureOptions } from "../options.ts";
import { AmbientLightCapability } from "../devices/cameras/ambient-light.ts";
import { DeviceRemovalCascade } from "./nvr-removal-cascade.ts";
import { DiagnosticsHealthBridge } from "./nvr-health-bridge.ts";
import { DoorbellCapability } from "../devices/cameras/doorbell.ts";
import { FIXTURE_RTSPS_PORT } from "../camera.fixtures.ts";
import type { LegacyFeatureOptions } from "../options-legacy.ts";
import type { ProtectCamera } from "../devices/cameras/camera.ts";
import { ProtectCameraPackage } from "../devices/cameras/camera-package.ts";
import type { ProtectDevice } from "../devices/device.ts";
import { ProtectEventDispatch } from "./event-dispatch.ts";
import type { ProtectPlatform } from "../platform.ts";
import { RebootScheduler } from "./nvr-reboot.ts";
import { RemovalStabilityGate } from "./nvr-removal.ts";
import { StreamingCapability } from "../devices/cameras/streaming.ts";
import { TestCameraProjection } from "../devices/testing.helpers.ts";
import type { TestChimeProjection } from "../devices/testing.helpers.ts";
import { analyzeLegacyFeatureOptions } from "../options-legacy.ts";
import { countActiveHksvRecordings } from "./nvr-endpoints.ts";
import { mqttTopics } from "../mqtt.ts";

// The platform double's honest structural type. The members mirror what ProtectBase and the camera-family construction paths read off nvr.platform: HBPU's
// Homebridge API double, which carries the real HAP namespace, Homebridge's own platform-accessory class, the accessory calls the doorbell's configurePackageCamera
// and the NVR removal tail drive, and the lifecycle events Homebridge's API emits; the injected test clock (typed as the library's TestClock, so the double and every
// suite advance it with no cast); the platform's mutable accessories array; a concrete codecSupport (the real platform getter throws before the FFmpeg probe - a
// concrete object with a non-raspbian hostSystem keeps the recording-default switch on its default branch), the ProtectOptions-shaped config, the REAL FeatureOptions
// engine, the log sinks, the REAL accessory persistence built over the API double and the test clock, the scoped debug gate every owner's logger asks before it
// speaks, the livestream-process and recording-process factory interfaces (the RTSP debug adapter and the recording delegate construct their FFmpeg processes through
// them), and the streaming-delegate factory interface.
export interface TestProtectPlatform {

  readonly accessories: ProtectAccessory[];
  readonly api: TestHomebridgeApi;
  // The platform's claim on an accessory, mirrored over the map below, so a row reads which owner stands behind an accessory and a removal's release lands where it does
  // in production.
  readonly claimAccessory: (accessory: ProtectAccessory, owner: { readonly isAvailable: boolean }) => void;
  readonly claims: Map<string, { readonly isAvailable: boolean }>;
  readonly clock: TestClock;
  readonly codecSupport: { hostSystem: string };
  readonly config: ProtectOptions;
  readonly featureOptions: FeatureOptions;
  readonly isAccessoryClaimed: (accessory: ProtectAccessory) => boolean;
  readonly legacyOptions: LegacyFeatureOptions;
  readonly livestreamProcessFactory: LivestreamProcessFactory;
  readonly log: {

    debug: (message: string, ...params: unknown[]) => void;
    error: (message: string, ...params: unknown[]) => void;
    info: (message: string, ...params: unknown[]) => void;
    warn: (message: string, ...params: unknown[]) => void;
  };
  readonly persistence: AccessoryPersistence;
  readonly pluginLog: HomebridgePluginLogging;
  readonly recordingProcessFactory: RecordingProcessFactory;
  readonly releaseAccessory: (accessory: ProtectAccessory) => void;
  readonly streamingDelegateFactory: TestStreamingDelegateFactory;
  readonly testDebug: (context: { controller?: string; device?: string }) => boolean;
}

/* The instant every harness test clock starts at, unless a caller supplies its own clock. Production reads a zero epoch time as absent in several places - a
 * controller's upSince of 0, a timeshift buffer's first stamp - so the shared timeline starts at a realistic wall-clock instant, and a suite derives each fixture
 * timestamp from the clock's now() rather than seeding a timeline of its own.
 */
export const TEST_CLOCK_EPOCH = 1700000000000;

/* The shared recording event-dispatch double: a REAL ProtectEventDispatch whose motion delivery is overridden to record into an array rather than touch HomeKit or arm a
 * reset timer. The override's arity and parameter types mirror production's motionEventHandler (event-dispatch.ts) exactly, so it type-checks as a true override; the two
 * parameters the recording path deliberately does not read carry the underscore prefix the house no-unused-vars rule reserves for intentionally-unused arguments, and
 * their types still anchor the override against production. Recording arms NO reset timer, so a motion test leaves no reset pending.
 *
 * This serves every family and base-capability path whose motion routes through the firehose - the light family's lastMotion observer and the base motion trigger / the
 * base motion-set MQTT interface alike - injected through makeTestNvr's dispatch interface and read back off nvr.events. It is the SSOT for that recording shape: the
 * light suite and the device-motion concern net share this one definition rather than each carrying its own near-identical subclass.
 */
export class TestRecordingDispatch extends ProtectEventDispatch {

  public readonly calls: { id: string; kind: string }[] = [];

  public override motionEventHandler(protectDevice: ProtectDevice, _detectedObjects: string[] = [], _metadata?: ProtectEventMetadata): void {

    this.calls.push({ id: protectDevice.protectId, kind: "motion" });
  }
}

/* The NVR double, mirroring each member the camera-family construction and lifecycle paths read. The construction surface comprises the unifi-protect client shape
 * (connection health for isReachable, the controllerName fallback ProtectBase.name uses for controller-scoped owners, the nvr config record behind the ufp
 * read-through, and the store double as client.state), the controller options, the platform double, a REAL un-aborted AbortSignal (composeSignals input and the
 * harness-level teardown lever), and an mqtt that defaults to null (every MQTT wrapper optional-chains into a no-op) or, opt-in, the recording double. The events
 * member is the REAL ProtectEventDispatch, constructed against this double, so event-timer behavior in tests is the production implementation rather than a mirror.
 *
 * The removals member is the REAL RemovalStabilityGate, wired as ProtectNvr wires its own: the same DelayDeviceRemoval grace supplier read through the REAL
 * FeatureOptions engine, the double's recording log, the platform's test clock, and the controller lifetime signal its timers bind to. So a test drives the production
 * stability arithmetic and the production TimerRegistry graces, and a test that needs a grace to fire advances the platform's test clock rather than reaching for an
 * inspection surface. Facts go in through pushControllerStability / restabilizeController; what comes out is observable on the accessory graph, the API double's
 * calls, and the log. Its ergonomics are deliberate. A fresh double starts stable - the construction seed pushes a controller up longer than the stability window -
 * so a lifecycle test schedules without ceremony. And the sweep action is a bare counter: the seed arms a zero-delay sweep on the test clock, which fires on whichever
 * advance of the clock comes first, so it must touch nothing for that timing to be harmless.
 *
 * The removal itself is the REAL DeviceRemovalCascade, constructed over the double's suppliers: the gate's removeDevice action runs it, and so do the double's
 * removeHomeKitDevice and the shared tail every owner calls, so the guards, the package-camera cascade and the tail are production's. A removal therefore takes only
 * an accessory carrying this controller's context, as production's does.
 */
export class TestProtectNvr {

  public readonly client: {

    readonly cameras: readonly { config: ProtectCameraConfig }[];
    readonly chimes: readonly Chime[];
    connection: { isHealthy: boolean; isLost: boolean; isRebooting: boolean };
    controllerName: string | null;
    readonly liveviews: readonly ProtectNvrLiveviewConfig[];
    nvr: { config: ProtectNvrConfig };
    readonly ringtones: readonly ProtectRingtoneConfig[];
    state: TestStateStore;
  };

  public readonly config: ProtectNvrOptions;
  // How many streaming capabilities this root has been asked to construct. The instrument behind the non-creating-getter pin: a read of a camera's streaming handle must
  // leave this untouched.
  public createStreamingCapabilityCalls = 0;
  public readonly events: ProtectEventDispatch;
  public readonly health: DiagnosticsHealthBridge;
  // How many times the health bridge has asked this root to re-evaluate removal stability. The recorder behind the bridge's refreshRemovalStability action, which does
  // this and nothing else: a double's stability facts arrive through the explicit pushControllerStability path, so a health transition here counts itself and leaves
  // the gate's clock to the tests that drive it deliberately.
  public healthStabilityRefreshes = 0;
  // The platform clock's timestamp of the last observed controller reboot, settable and defaulting to "none observed this process", mirroring the private field the
  // production root stamps in onControllerRebooted. A test arranging a reboot's settling tail sets this alongside `phase`, stamping it from the platform's test clock,
  // and the two together are exactly the inputs the expectation classification below reads.
  public lastRebootObservedAt: Nullable<number> = null;
  public readonly log: {

    debug: (message: string, ...params: unknown[]) => void;
    error: (message: string, ...params: unknown[]) => void;
    info: (message: string, ...params: unknown[]) => void;
    warn: (message: string, ...params: unknown[]) => void;
  };

  public readonly mqtt: Nullable<TestMqttClient>;
  // The address override the camera's RTSP host chain reads, resolved once at construction through the same nvr-policy rule the production root resolves it by while
  // configuring the controller, so a test configures it through makeTestNvr's overrideAddress and userOptions alone.
  public readonly overrideAddress: Nullable<string>;

  // The NVR lifecycle phase, settable and defaulting to the organic "running" state. The recording delegate reads nvr.phase to suppress its induced-disruption (reboot /
  // shutdown) error logs, so a transmit test that asserts the early-end telemetry log fires needs this to be "running".
  public phase: NvrPhase = "running";
  public readonly platform: TestProtectPlatform;
  // The REAL RebootScheduler, wired as ProtectNvr wires its own. It arms nothing until a test calls schedule(), which is what keeps it inert for every other suite.
  public readonly reboot: RebootScheduler;
  // How many reboot commands the scheduler has issued through the double's action.
  public rebootCalls = 0;
  // Set by a test to make the NEXT commanded reboot fail. Single-shot: the action consumes and clears it as it throws, so a failure-then-success chain needs no manual
  // reset between the two.
  public rebootError: Nullable<Error> = null;
  // The REAL device-removal cascade, constructed over the double's suppliers as ProtectNvr constructs its own.
  readonly #removalCascade: DeviceRemovalCascade;
  public readonly removals: RemovalStabilityGate;
  public readonly signal: AbortSignal;
  // How many stability sweeps the gate has asked this root to run. The recorder behind the gate's runSweep action, which does this and nothing else: the seed arms a
  // zero-delay sweep at construction, so the callback fires on the first advance of the platform's test clock in whatever test happens to advance it, and touching
  // nothing is what makes that harmless.
  public sweepRequests = 0;

  // The managed-device registry, mirroring ProtectNvr.configuredDevices: a Map keyed by accessory UUID whose values are the constructed device objects. The
  // controller-owner motion fanouts resolve a member camera through it - the security-system fanout reads configuredDevices.get(accessory.UUID)?.protectId, the liveviews
  // fanout reaches it through getDeviceById. A test seeds a minimal member double through the ProtectDevices cast at the construction boundary, exactly as the
  // device-class doubles are cast elsewhere. Both fanouts read only a narrow slice of the device (protectId for the security path, accessory / accessoryName for the
  // liveviews path), so the seeded double carries just that slice.
  public readonly configuredDevices = new Map<string, ProtectDevices>();

  public constructor(init: { client: TestProtectNvr["client"]; config: ProtectNvrOptions; dispatch?: (nvr: ProtectNvr) => ProtectEventDispatch;
    log: TestProtectNvr["log"]; mqtt: Nullable<TestMqttClient>; platform: TestProtectPlatform; signal: AbortSignal; }) {

    this.client = init.client;
    this.config = init.config;
    this.log = init.log;
    this.mqtt = init.mqtt;
    this.platform = init.platform;
    this.signal = init.signal;

    // Resolve the address override through the production rule, and say the production warning when the rule refuses the configured address.
    const override = resolveOverrideAddress({ legacy: this.config.overrideAddress, option: this.getFeatureValue("Nvr.OverrideAddress") });

    if(override.kind === "refused") {

      this.log.warn(OVERRIDE_ADDRESS_ZONE_WARNING, override.address);
    }

    this.overrideAddress = (override.kind === "resolved") ? override.address : null;

    /* The REAL health bridge, wired the way ProtectNvr wires its own (nvr.ts): the double's controller address scoping the request feed, its recording log carrying
     * the narration, its configured-device registry answering the camera-ownership question, the platform's test clock every symptom is stamped from, and the
     * controller lifetime signal the channel subscriptions detach on.
     * The diagnostics feeds are attached immediately, because the double models a well-configured controller - production wires them past its credential guard, which
     * a double with an address and credentials would clear. They are inert in a device-test process: nothing publishes on the library's channels outside the bridge's
     * own suite, and the teardown-abort discipline every constructing file carries is what detaches them when the controller's signal fires.
     *
     * The bridge stays suspended here. Nothing calls notePhase, and the settable `phase` field above deliberately drives nothing - the two are independent by design,
     * so a test that moves `phase` to exercise induced-disruption suppression does not silently open health observation. Suspended means `state` reads healthy and
     * every observed symptom is dropped, which is what keeps this member from perturbing any existing test.
     */
    this.health = new DiagnosticsHealthBridge({

      actions: { refreshRemovalStability: (): void => { this.healthStabilityRefreshes++; } },
      address: init.config.address,
      clock: init.platform.clock,
      log: this.log,
      ownsCamera: (cameraId: string): boolean => this.getDeviceById(cameraId) !== null,
      signal: init.signal
    });

    this.health.wireDiagnostics();

    /* The REAL device-removal cascade, constructed the way ProtectNvr constructs its own (nvr.ts): the platform's accessory list and persistence, the double's
     * configured-device registry and recording log, and the controller MAC and the store double as suppliers it pulls at use time. Its actions are closures for the
     * same reason production's are: the gate and the event dispatcher are both constructed after it. So a removal the gate fires and every owner's call of the shared
     * tail run production's guards, package-camera cascade and tail.
     */
    this.#removalCascade = new DeviceRemovalCascade({

      accessories: init.platform.accessories,
      actions: {

        cancelPendingRemoval: (uuid: string): void => this.removals.cancelFor(uuid),
        forgetCamera: (): void => {

          // No-op: the double runs no livestream narration and holds no episode latch, so there is no episode to reclaim.
        },
        publishRemoval: (mac: string): void => {

          // Production's disabled test, without its hold: the double restates nothing at a session, so a removal it meets with no session holds nothing for a later one.
          if(init.platform.featureOptions.test("Device", mac, this.ufp.mac)) {

            this.mqtt?.publishGuarded(mqttTopic(mac, mqttTopics.availability.topic), MQTT_AVAILABILITY_OFFLINE, { ifChanged: true, retain: true });
          }
        },
        retireDevice: (device: ProtectDevice): void => this.events.retireDevice(device)
      },
      controllerMac: (): string => this.ufp.mac,
      devices: this.configuredDevices,
      log: this.log,
      persistence: init.platform.persistence,
      releaseAccessory: (accessory: ProtectAccessory): void => init.platform.releaseAccessory(accessory),
      state: (): TestStateStore => this.client.state
    });

    /* The REAL removal-stability gate, wired the way ProtectNvr wires its own (nvr.ts): the grace resolved per request through the REAL FeatureOptions engine, the
     * double's recording log, the platform's test clock, and the controller lifetime signal its TimerRegistry binds to, with the device-removal cascade above as the
     * removal its decisions run.
     */
    this.removals = new RemovalStabilityGate({

      actions: {

        removeDevice: (accessory: ProtectAccessory): void => this.#removalCascade.removeDevice(accessory),
        runSweep: (): void => { this.sweepRequests++; }
      },
      clock: init.platform.clock,
      graceSeconds: (): number => this.getFeatureNumber("Nvr.DelayDeviceRemoval") ?? 0,
      log: this.log,
      signal: init.signal
    });

    /* The REAL reboot scheduler, wired the way ProtectNvr wires its own (nvr.ts): the recording count, the connection health and the controller's availability as
     * suppliers it pulls at its own fire time, the double's recording log, the platform's test clock, and the controller lifetime signal its TimerRegistry binds to. The
     * phase actions move the double's bare settable `phase` - the same field the recording delegate already reads - so the confirmation's still-rebooting guard and any
     * induced-suppression read see the phase the choreography set, and the reboot action records its calls and consumes a test's injected failure.
     *
     * The scheduler arms NOTHING at construction: entering the schedule is an explicit call, so this member fires nothing in any suite that does not ask it to. That is
     * what keeps the embedding inert for every existing test, unlike the removal gate above whose construction seed arms a sweep.
     */
    this.reboot = new RebootScheduler({

      actions: {

        beginReboot: (): void => { this.phase = "rebooting"; },
        reboot: async (): Promise<void> => {

          this.rebootCalls++;

          const error = this.rebootError;

          if(error) {

            this.rebootError = null;

            throw error;
          }
        },
        resumeRunning: (): void => { this.phase = "running"; }
      },
      activeRecordings: (): number => countActiveHksvRecordings(this.configuredDevices),
      clock: init.platform.clock,
      isConnectionHealthy: (): boolean => this.client.connection.isHealthy,
      isControllerAvailable: (): boolean => this.isAvailable,
      log: this.log,
      phase: (): NvrPhase => this.phase,
      signal: init.signal
    });

    // The real event dispatcher, wired against this double - its constructor reads only the platform's HAP namespace and clock, the log, and the NVR handle itself.
    // The optional dispatch factory is the reusable injection point: when omitted, the default factory builds the real ProtectEventDispatch(this); a test injects a
    // recording subclass (overriding motionEventHandler to record without arming the real reset timer) to assert the device observers' firehose routing. The factory
    // runs as the last write in the constructor, so nothing reads events before this line.
    this.events = (init.dispatch ?? ((nvr: ProtectNvr): ProtectEventDispatch => new ProtectEventDispatch(nvr)))(this as unknown as ProtectNvr);

    /* Seed the trusted long-up posture: a controller up past the stability window is stable the instant it is pushed, so a fresh double schedules a removal without
     * ceremony. The uptime is stamped from the platform's test clock, so the seed, every later stability read, and every grace share one timeline.
     *
     * This also arms the gate's one-shot sweep at a zero delay on that clock, whose action is the recording counter above. It stays pending until a test first
     * advances the clock, fires the counter on that advance, and touches nothing else; the controller signal's abort drains it with the rest of the gate's timers.
     */
    this.pushControllerStability(true);
  }

  /* Whether a disruption right now is expected, derived exactly as the production root derives it: the very same shared nvr-policy classification, over this double's
   * two settable inputs and the same production window constant. Only the INPUTS are the double's; the decision is production's, so a consumer reading
   * nvr.isDisruptionExpected against this double can never drift from what the controller would have answered.
   */
  public get isDisruptionExpected(): boolean {

    return isDisruptionExpected({ lastRebootMs: this.lastRebootObservedAt, nowMs: this.platform.clock.now(), phase: this.phase,
      windowMs: PROTECT_NVR_REBOOT_RECENCY_MS });
  }

  // The verdict every owner starts from, read as the production root reads it, over the double's settable connection levers.
  public get isAvailable(): boolean {

    return !this.client.connection.isLost && !this.client.connection.isRebooting;
  }

  // Read-through to the controller record, mirroring the production getter.
  public get ufp(): Readonly<ProtectNvrConfig> {

    return this.client.nvr.config;
  }

  // The production controller-scoped feature-number read: the REAL FeatureOptions engine resolves the option against the controller MAC, returning the registered
  // default when unconfigured and null when a test's user options disabled it.
  public getFeatureNumber(option: string): Nullable<number | undefined> {

    return this.platform.featureOptions.getInteger(option, this.ufp.mac);
  }

  // The production controller-scoped feature-value read, mirrored down to the argument slot: the mac rides the controller argument, because the options this serves
  // declare controller scope and resolve through that slot alone. The override-address resolution reaches it, so every camera-family test resolves its override
  // through the real engine.
  public getFeatureValue(option: string): Nullable<string | undefined> {

    return this.platform.featureOptions.value(option, undefined, this.ufp.mac);
  }

  // Return the managed Protect device whose protectId matches, or null - the production one-liner (nvr.ts), mirrored so the liveviews motion fanout resolves a member
  // camera against the seeded configuredDevices registry as production does. We match on the non-throwing protectId, so a wrapper whose store-backed record has
  // been removed still resolves (and reports unavailable) rather than throwing - the property the recovery policy and firehose lookups depend on.
  public getDeviceById(deviceId: string): Nullable<ProtectDevices> {

    return [...this.configuredDevices.values()].find((device) => device.protectId === deviceId) ?? null;
  }

  // The production controller-scoped feature test, mirrored for any double-side caller that consults controller scope.
  public hasFeature(option: string, device?: { mac?: string }): boolean {

    return this.platform.featureOptions.test(option, device?.mac, this.ufp.mac);
  }

  /* Push a controller-stability fact into the gate, the way ProtectNvr's own health path does. A good push carries an uptime a full stability window deep, so the very
   * first one - the construction seed - reads stable immediately.
   *
   * After that first stabilization the gate counts from now on every later good push, because its first-stabilization latch is a fact about the whole process life
   * rather than about the current connection. So a test that destabilizes and then restabilizes must let the full window elapse before removalStable reads true again,
   * which is exactly what restabilizeController does.
   *
   * @param good - Whether the controller is in good state.
   */
  public pushControllerStability(good: boolean): void {

    this.removals.refresh(good ? { good: true, upSince: this.platform.clock.now() - PROTECT_NVR_REMOVAL_STABILITY_WINDOW } : { good: false });
  }

  /* Take the controller through a disruption and back to stable: the not-good push drops the gate's good-state stamp and drains every timer the gate holds, the good
   * push restamps from the current instant, and advancing the platform's test clock by the stability window makes removalStable read true again. The double owns both
   * the gate-policy knowledge - the count-from-now latch and the window-sized advance it implies - and the clock it advances, so a caller passes nothing. The advance
   * fires every entry due on the shared clock within the window, whichever subsystem armed it.
   */
  public restabilizeController(): void {

    this.pushControllerStability(false);
    this.pushControllerStability(true);
    this.platform.clock.advance(PROTECT_NVR_REMOVAL_STABILITY_WINDOW);
  }

  // The composition-root construction methods, mirroring production: each constructs the REAL device-family class, faithful to ProtectNvr (the harness already constructs
  // real device objects). The double sits ABOVE the device layer exactly as the real NVR does - it value-imports the device classes - so routing construction through it
  // forms no module-initialization cycle, the property the live attach relies on.
  public createDoorbellCapability(camera: ProtectCamera, device: Camera, signal: AbortSignal): DoorbellCapability {

    return new DoorbellCapability(this as unknown as ProtectNvr, { device: device, host: camera, signal: signal });
  }

  public createPackageCamera(accessory: ProtectAccessory, device: Camera): ProtectCameraPackage {

    return new ProtectCameraPackage(this as unknown as ProtectNvr, accessory, device);
  }

  public createAmbientLightCapability(camera: ProtectCamera, device: Camera, signal: AbortSignal): AmbientLightCapability {

    return new AmbientLightCapability(this as unknown as ProtectNvr, { device: device, host: camera, signal: signal });
  }

  // The streaming capability's construction, mirroring production - and the one create method that carries a call counter. The counter is what lets a test prove a
  // camera builds exactly one capability no matter how many times it asks for one, and that a controller-side read of the handle asks the root for nothing.
  public createStreamingCapability(camera: ProtectCamera, signal: AbortSignal): StreamingCapability {

    this.createStreamingCapabilityCalls++;

    return new StreamingCapability(this as unknown as ProtectNvr, { host: camera, signal: signal });
  }

  // The sweep-stale removal interface, mirroring production: route the camera's request to the REAL DoorbellCapability.removeServices SSOT, with the platform's HAP
  // namespace and the double's log - so suite D exercises the actual removal logic, not a stand-in. The log shape already satisfies HomebridgePluginLogging
  // structurally. A sweep that removed something marks the accessory for the next save, as production's does.
  public removeStaleDoorbellServices(accessory: ProtectAccessory): void {

    if(DoorbellCapability.removeServices(accessory, this.platform.api.hap, this.log)) {

      this.platform.persistence.persist(accessory);
    }
  }

  // The production removal, through the device-removal cascade: every guard, the package-camera cascade and the shared tail.
  public removeHomeKitDevice(accessory: ProtectAccessory): void {

    this.#removalCascade.removeDevice(accessory);
  }

  // The production removal tail, through the device-removal cascade: the presence guard, the platform persistence's unregister and the splice.
  public removeAccessoryFromHomeKit(accessory: ProtectAccessory): void {

    this.#removalCascade.removeAccessory(accessory);
  }
}

/**
 * Build the NVR config record the construction path reads through nvr.ufp: the host (the last fallback in the camera's RTSP host chain), the controller MAC (the
 * feature-option controller scope key, and the chime / ringtone nvrMac filter key), the RTSP(S) ports (the RTSPS port pinned to the fixture value so channel profile
 * URLs match the golden-master corpus), plus the controller-owner read set: a marketName / name / type for setInfo's Model and the system-info accessory's display
 * name, and a populated systemInfo so the nvr-systeminfo owner's initial pass (which dereferences systemInfo.cpu.temperature with no optional chaining) and its
 * MQTT JSON.stringify read meaningfully. The single confined cast point for the controller record, mirroring makeCameraConfig's discipline.
 *
 * @param options - doorbellSettings: OPT-IN only, kept absent by default - the raw doorbell settings record the message-switch net seeds so getMessages reads a
 *                  truthy source and its builtin-message list; hardwareRevision: OPT-IN with no default (stays undefined) - the security-system owner writes
 *                  nvr.ufp.hardwareRevision onto HardwareRevision unconditionally, so buildSecuritySystem (in security-system.test.ts) opts a value in to net that
 *                  write non-vacuously, while the default omission keeps ProtectBase.setInfo's HardwareRevision length-guard short-circuited for the device-info
 *                  concern net; mac: the controller MAC override (defaults to "74ACB9FFFFFF"), so a multi-controller test seeds two stores with distinct controller
 *                  identities and the owners scope their accessories apart; marketName / name / type: identity overrides setInfo and the system-info accessory
 *                  read; temperature: the optional systemInfo.cpu.temperature override, so the observer's reactive refresh can be asserted on a known value.
 *
 * @returns an NVR config record the construction path reads as real.
 */
export function makeNvrConfig(options: { doorbellSettings?: ProtectNvrConfig["doorbellSettings"]; hardwareRevision?: string; mac?: string; marketName?: string;
  name?: string; temperature?: number; type?: string; } = {}): ProtectNvrConfig {

  const populated = {

    host: "nvr.test",
    mac: options.mac ?? "74ACB9FFFFFF",
    marketName: options.marketName ?? "UniFi Dream Machine SE",
    name: options.name ?? "Test Controller",
    ports: { rtsp: 7447, rtsps: FIXTURE_RTSPS_PORT },
    systemInfo: {

      cpu: { averageLoad: 12.5, temperature: options.temperature ?? 40 },
      memory: { available: 2048, free: 1024, total: 4096 },
      storage: { available: 500, devices: [], isRecycling: false, size: 1000, type: "hdd", used: 500 }
    },
    type: options.type ?? "UDMPRO",

    // OPT-IN only: the doorbell settings the message-switch net seeds so getMessages sees a truthy source and its builtin-message list. Kept absent by default (the
    // conditional spread keeps the key missing rather than present-as-undefined) so every non-doorbell consumer reads the same shape as before.
    ...(options.doorbellSettings !== undefined ? { doorbellSettings: options.doorbellSettings } : {}),

    // OPT-IN only: when the caller passes a value (the security-system owner does), it lands on the record; otherwise the field stays absent so setInfo's length-guard
    // remains short-circuited and the committed device-info default-omission assertion stays accurate. The conditional spread keeps the key absent rather than
    // present-as-undefined, so an `in` check or a length read sees the same shape as when the option is omitted.
    ...(options.hardwareRevision !== undefined ? { hardwareRevision: options.hardwareRevision } : {})
  };

  return populated as unknown as ProtectNvrConfig;
}

/**
 * Build the NVR / platform double pair for real device construction, returning the double plus its test-side handles. The double is honestly typed as
 * TestProtectNvr; the single cast to ProtectNvr is confined to the construction point in the test itself, mirroring the reachability suite's discipline - the
 * casts live at that point, and the instance under test is the production class.
 *
 * @param options - chimes: the HELD chime projection doubles client.chimes exposes (omitted, the empty default), kept as the same instances across every access so the
 *                  doorbell's cross-device setChimeVolume write hits, and a test's updateRejection lever is set on, ONE projection - a per-access rebuild would silently
 *                  break the rejection drive; clock: an optional controllable TestClock installed as the platform double's clock and returned so a test advances
 *                  the virtual time every timer armed on that clock reads (omitted, a fresh TestClock seeded at TEST_CLOCK_EPOCH is created); controllerName:
 *                  the controller label (defaults to "Test Controller"); controllerPrefix: a prefix the controller's logger writes over the one recorder, as the
 *                  production root's logger carries the controller's name, for a row that tells the controller's lines from the plugin's (omitted, the controller's
 *                  logger is the plugin's); dispatch: an optional event-dispatch factory threaded into the NVR double's events interface
 *                  (omitted, the default builds the real ProtectEventDispatch unchanged; a test injects a recording subclass to assert the device observers' firehose
 *                  routing without arming the real reset timer); doorbellSettings: the raw doorbell settings record forwarded to the store's default NVR config fallback
 *                  (omitted, the fallback carries no doorbell settings); livestreamProcessFactory: an optional test livestream-process factory installed on the platform
 *                  double's livestreamProcessFactory interface (omitted, a fresh default factory is created so the RTSP debug adapter constructs its FFmpeg process
 *                  through the test double); mqtt: pass true to install the recording MQTT double (the default null makes every MQTT wrapper
 *                  a no-op, matching an unconfigured broker); overrideAddress: the controller-level address override for rtspHost-chain tests; recordingProcessFactory:
 *                  an optional test recording-process factory installed on the platform double's recordingProcessFactory interface (omitted, a fresh default factory is
 *                  created so the recording delegate constructs its FFmpeg process through the test double); sharedPlatform: an optional { accessories, api } pair
 *                  captured from a double built earlier, so a second controller reconciles over the SAME platform accessories array and Homebridge API double as
 *                  the first, mirroring production's one shared ProtectPlatform - the shared state a multi-controller test uses to prove one controller's reconcile
 *                  leaves the other's switches untouched (omitted, each call builds its own fresh accessories array and API double); store: the state-store double
 *                  backing client.state; userOptions: feature-option config strings (the production options array shape, e.g. "Enable.Device.SyncName" or
 *                  "Disable.Nvr.DelayDeviceRemoval") applied to the REAL FeatureOptions engine.
 *
 * @returns api: the platform's Homebridge API double, whose calls record every accessory call Homebridge accepted; clock: the controllable TestClock installed on the
 *          platform double (the instance everything built against the double reads through platform.clock, so a test advances it to fire what is due); controller: the
 *          AbortController behind nvr.signal (abort it in suite teardown); factory: the stub streaming-delegate factory; logEntries: every line the construction path
 *          logged; mqtt: the recording MQTT double when requested, else null; nvr: the NVR double.
 */
export function makeTestNvr(options: { chimes?: TestChimeProjection[]; clock?: TestClock; controllerName?: string; controllerPrefix?: string;
  dispatch?: (nvr: ProtectNvr) => ProtectEventDispatch;
  doorbellSettings?: ProtectNvrConfig["doorbellSettings"];
  livestreamProcessFactory?: LivestreamProcessFactory;
  mqtt?: boolean; overrideAddress?: string;
  recordingProcessFactory?: RecordingProcessFactory;
  sharedPlatform?: { accessories: ProtectAccessory[]; api: TestHomebridgeApi }; store: TestStateStore; userOptions?: string[]; }):
{ api: TestHomebridgeApi; clock: TestClock; controller: AbortController; factory: TestStreamingDelegateFactory; logEntries: readonly TestLogEntry[];
  mqtt: Nullable<TestMqttClient>; nvr: TestProtectNvr; } {

  // Reuse the caller-supplied accessories array and API double when sharing a platform across controllers, so a second controller sees and reconciles over the first's
  // switches; otherwise each call gets its own fresh pair over the one runtime every suite shares.
  const accessories = options.sharedPlatform?.accessories ?? [];
  const api = options.sharedPlatform?.api ?? makeTestApi();

  // The HELD chime projection doubles client.chimes returns: the SAME instances captured once here, never a per-access rebuild. The doorbell's setChimeVolume filters
  // client.chimes and calls update() on the matching projection, and a test asserts that projection's updateCalls / sets its updateRejection lever, so they must be
  // one instance. A rebuild getter would hand the write a fresh projection each pass and a test's rejection would go unseen, so the failure drive would pass vacuously.
  const chimes = options.chimes ?? [];
  const clock = options.clock ?? new TestClock(TEST_CLOCK_EPOCH);
  const controller = new AbortController();

  // The stable fallback the client.nvr.config getter returns when the store carries no nvr slice, built once so every fallback read is the SAME reference (the existing
  // camera consumers - which never seed the nvr slice - keep reading a fixed record with a stable reference). The doorbell settings the message-switch net seeds ride
  // this fallback, since the camera-family store the doorbell tests build never seeds an nvr slice.
  const defaultNvrConfig = makeNvrConfig(options.doorbellSettings !== undefined ? { doorbellSettings: options.doorbellSettings } : {});
  const factory = new TestStreamingDelegateFactory();

  // The capturing logger from homebridge-plugin-utils records what each call was actually handed - the level, the message, and the arguments beside it - which is the
  // shape the shared testing helpers read and render. A test wanting the line the real Homebridge sink would emit renders the entry; one wanting a structured object
  // argument reads it straight off params.
  const log = capturingLog();
  const livestreamProcessFactory = options.livestreamProcessFactory ?? new TestLivestreamProcessFactory();
  const recordingProcessFactory = options.recordingProcessFactory ?? new TestRecordingProcessFactory();

  // The MQTT double reports through the same capturing logger, so a guarded publish that fails or is cancelled lands in the log's entries alongside every other line
  // the construction path emits. It is built after the log for that reason.
  const mqtt = options.mqtt ? new TestMqttClient({ log }) : null;

  /* The platform double's config, legacy analysis, and feature-option engine, hoisted out of the literal below so the debug gate can resolve against the very
   * instances the double exposes - a test steering platform.config.debugAll or seeding a scoped Log.Debug entry then drives the same resolution production performs.
   * The local names deliberately avoid `featureOptions`, which would shadow the module-level catalog import the constructor call below reads.
   *
   * The three travel together exactly as they do in the platform constructor: the userOptions run through the legacy analysis, the engine is built on the analysis's
   * view of them, and the RAW array lands on the double's config.options where the runtime overlay reads it. A double that handed the engine the raw array and left
   * config.options empty would let every legacy-grammar test pass or fail for the wrong reason - the overlay would find nothing to read, and the engine would see the
   * shapes the analysis exists to keep away from it.
   */
  const userOptions = options.userOptions ?? [];
  const legacyOptions = analyzeLegacyFeatureOptions(userOptions);
  const platformConfig: ProtectOptions = { controllers: [], debugAll: false, options: userOptions, ringDelay: 0, verboseFfmpeg: false, videoProcessor: "ffmpeg" };
  const platformFeatureOptions = new FeatureOptions(featureOptionCategories, featureOptions, [...legacyOptions.engineOptions]);
  const client = {

    // The controller-wide camera projections, read through the store double's CURRENT state, mirroring the production client.cameras array the M3U playlist composes
    // its catalog from. A getter closing over options.store so a pushCameraPatch changes what the next playlist request reads, exactly as the live projection does.
    get cameras(): readonly { config: ProtectCameraConfig }[] {

      return [...options.store.snapshot().cameras.values()].map((config) => ({ config }));
    },

    // The HELD chime projections, exposed as the production client.chimes array the doorbell's setChimeVolume filters by cameraIds and writes through. A plain held
    // property (not a store-rebuild getter like liveviews / ringtones below): the volume write and the test's assertion / rejection lever must see the SAME instance, so
    // the projections are captured once above. Projected to the library's Chime shape through the confined structural cast, exactly as the other client members project.
    chimes: chimes as unknown as Chime[],
    connection: { isHealthy: true, isLost: false, isRebooting: false },
    controllerName: options.controllerName ?? "Test Controller",

    // The controller-wide liveview collection, read through the store double's CURRENT state, mirroring the production client.liveviews array the viewer reconciles its
    // switches against. A getter (not a held array) closing over options.store so a pushLiveviews changes what the viewer reads, exactly as the live projection does.
    get liveviews(): readonly ProtectNvrLiveviewConfig[] {

      return [...options.store.snapshot().liveviews.values()];
    },

    // The controller record, read THROUGH the store double's CURRENT nvr slice rather than a held value, so nvr.ufp (the production getter reads client.nvr.config) and
    // selectNvr(state) are ONE source: a pushNvrPatch that moves systemInfo by reference changes both at once, which is what lets the nvr-systeminfo owner's observer
    // reaction be asserted non-vacuously. Falls back to the stable default when the store carries no nvr slice, preserving every non-seeding consumer (the sole prior
    // reader, the camera family, never seeds it). Mirrors the liveviews / ringtones store-backed getters above.
    nvr: { get config(): ProtectNvrConfig {

      return options.store.snapshot().nvr ?? defaultNvrConfig;
    } },

    // The controller-wide ringtone collection, read through the store double's CURRENT state, mirroring the production client.ringtones array the chime filters its
    // speaker switches against. A getter closing over options.store so a pushRingtones changes what the chime reads, exactly as the live projection does.
    get ringtones(): readonly ProtectRingtoneConfig[] {

      return [...options.store.snapshot().ringtones.values()];
    },
    state: options.store
  };

  // The REAL accessory persistence, built over the API double and the test clock as the platform builds its own over Homebridge's API and the system clock, so every
  // save production asks for lands among the API double's update calls once its window comes due. The persistence reaches only the API members HBPU names for it,
  // which the API double carries, so it takes the double as it is. Nothing here emits Homebridge's shutdown, so a save the persistence holds leaves only when its window
  // comes due on the test clock.
  const persistence = new AccessoryPersistence({ api, clock, platformName: PLATFORM_NAME, pluginIdentifier: PLUGIN_NAME });
  const claims = new Map<string, { readonly isAvailable: boolean }>();

  const nvr = new TestProtectNvr({

    client: client,
    config: { address: "nvr.test", mqttTopic: "test/protect", password: "test-password", username: "test-user",
      ...(options.overrideAddress !== undefined ? { overrideAddress: options.overrideAddress } : {}) },
    dispatch: options.dispatch,
    log: (options.controllerPrefix === undefined) ? log : prefixedLog(log, () => options.controllerPrefix ?? ""),
    mqtt: mqtt,
    platform: {

      accessories: accessories,
      api: api,
      claimAccessory: (accessory: ProtectAccessory, owner: { readonly isAvailable: boolean }): void => void claims.set(accessory.UUID, owner),
      claims: claims,
      clock: clock,
      codecSupport: { hostSystem: "macOS" },
      config: platformConfig,
      featureOptions: platformFeatureOptions,
      isAccessoryClaimed: (accessory: ProtectAccessory): boolean => claims.has(accessory.UUID),
      legacyOptions: legacyOptions,
      livestreamProcessFactory: livestreamProcessFactory,
      log: log,
      persistence: persistence,
      pluginLog: log,
      recordingProcessFactory: recordingProcessFactory,
      releaseAccessory: (accessory: ProtectAccessory): void => void claims.delete(accessory.UUID),
      streamingDelegateFactory: factory,

      // The production predicate, mirrored exactly: the legacy plugin-wide flag, else a Log.Debug entry resolved at the caller's own device and controller scope. It
      // is the gate alone and emits nothing - the composed loggers own emission, exactly as they do in production.
      testDebug: (context: { controller?: string; device?: string }): boolean => {

        return platformConfig.debugAll || platformFeatureOptions.test("Log.Debug", context.device, context.controller);
      }
    },
    signal: controller.signal
  });

  return { api, clock, controller, factory, logEntries: log.entries, mqtt, nvr };
}

/**
 * Place cached accessories on the platform the way Homebridge does at startup: the API double restores each one, writing Homebridge's FirmwareRevision placeholder,
 * handing it to the platform's configureAccessory, which keeps it in the accessories array, and only then bridging it. An accessory staged this way is bridged, as a
 * cached accessory is in production, so the accessory persistence saves and unregisters it, while an accessory pushed without a restore stays off the bridge as a
 * never-registered one does. The placeholder's write is the one change a restored accessory carries before production touches it.
 *
 * @param nvr         - The NVR double whose platform receives the accessories.
 * @param accessories - The cached accessories to restore, in the order Homebridge hands them over.
 */
export function restoreAccessories(nvr: TestProtectNvr, accessories: ProtectAccessory[]): void {

  // The platform double is no ProtectPlatform, so the restore hands its accessories to a stand-in carrying the one method Homebridge calls, which keeps each in the
  // double's array as production's configureAccessory keeps it in the platform's.
  const platform = { configureAccessory: (accessory: ProtectAccessory): void => void nvr.platform.accessories.push(accessory) };

  nvr.platform.api.restorePlatformAccessories({ accessories, platform, platformName: PLATFORM_NAME, pluginIdentifier: PLUGIN_NAME });
}

/**
 * Build a pre-linked doorbell-plus-package accessory pair shaped like a bridged restart restore, restored onto the platform double's bridge and into its accessories
 * array. Homebridge restores BRIDGED cached accessories at startup; external (standalone) accessories are never restored, so a standalone package has no
 * restart-shaped fixture - mirroring the production exclusion. The identity seeds are deliberate fixture literals rather than derivations from the production
 * constants: like the golden-master corpus, they hold fixed what persisted state in the field actually looks like, so a drift in the persistence-critical identity
 * suffix breaks these fixtures loudly instead of silently following along.
 *
 * @param options - mac: the parent doorbell's MAC (defaults to the camera builder's default); name: the parent's display name; nvr: the NVR double whose platform
 *                  accessories array receives the pair.
 *
 * @returns packageAccessory: the cached package camera accessory; parentAccessory: the cached parent doorbell accessory.
 */
export function makeTestAccessoryFamily(options: { mac?: string; name?: string; nvr: TestProtectNvr }):
{ packageAccessory: TestProtectAccessory; parentAccessory: TestProtectAccessory } {

  const mac = options.mac ?? "74ACB9000001";
  const name = options.name ?? "Test Doorbell";
  const parentAccessory = makeTestAccessory(name, mac);

  parentAccessory.context = { mac: mac, nvr: options.nvr.ufp.mac };

  const packageAccessory = makeTestAccessory(name + " Package Camera", mac + ".PackageCamera");

  packageAccessory.context = { nvr: options.nvr.ufp.mac, packageCamera: mac };

  restoreAccessories(options.nvr, [ parentAccessory, packageAccessory ]);

  return { packageAccessory, parentAccessory };
}

// One state transition of the connection monitor, in the states the root's recovery edge reads.
export interface TestConnectionTransition {

  readonly from: string;
  readonly to: string;
}

/* The connection monitor a client double hands a real controller root: healthy by default, its health and its loss and reboot verdicts each a lever a row moves, with
 * each subscription kept under its event until the disposable handed back for it is disposed, so a row reads how many of the root's subscriptions are still attached and
 * delivers an event exactly as a live monitor would. The monitor makes no state transition of its own, so the transitions a connected root observes are the ones a row
 * delivers through its lever, moving whichever verdict the transition stands for first.
 */
export class TestConnection {

  public isHealthy = true;
  public isLost = false;
  public isRebooting = false;
  readonly #listeners = new Map<string, Set<() => void>>();
  readonly #transitions: TestConnectionTransition[] = [];
  #wake: Nullable<() => void> = null;

  public get listenerCount(): number {

    return [...this.#listeners.values()].reduce((count, listeners) => count + listeners.size, 0);
  }

  public emit(event: string): void {

    for(const listener of [...(this.#listeners.get(event) ?? [])]) {

      listener();
    }
  }

  // Deliver a state transition to the root's connection loop.
  public transition(transition: TestConnectionTransition): void {

    this.#transitions.push(transition);
    this.#wake?.();
  }

  // The state transitions the root's connection loop reads, each one a row delivers, until the loop's signal aborts.
  public async *observe({ signal }: { signal: AbortSignal }): AsyncGenerator<TestConnectionTransition> {

    using _release = onAbort(signal, () => this.#wake?.());

    while(!signal.aborted) {

      const next = this.#transitions.shift();

      if(next) {

        yield next;

        continue;
      }

      const { promise, resolve }: PromiseWithResolvers<void> = Promise.withResolvers();

      this.#wake = resolve;

      // eslint-disable-next-line no-await-in-loop -- The loop waits for one delivery at a time, as a live monitor's stream does.
      await promise;
    }
  }

  public on(event: string, listener: () => void): Disposable {

    const listeners = this.#listeners.get(event) ?? new Set<() => void>();

    listeners.add(listener);
    this.#listeners.set(event, listeners);

    return { [Symbol.dispose]: (): void => void listeners.delete(listener) };
  }
}

/**
 * Build the client a connected controller root reads, for a row that runs the real root through its connect port: the controller record, the store, the liveview
 * collection and each camera's projection read through that store, a TestConnection as its connection monitor, an activity stream that carries no event, so the root's
 * router finds none and ends, and a reboot command the controller accepts, which a row replaces to hold or refuse it. The client owns no resources, so its disposal does
 * nothing.
 *
 * @param options           - Client inputs.
 * @param options.nvrConfig - The controller record the root reads through client.nvr.config.
 * @param options.store     - The state-store double the root reads its devices and liveviews through.
 *
 * @returns The client, presented as the library's, for the connect port to answer with.
 */
export function makeConnectedClient(options: { nvrConfig: ProtectNvrConfig; store: TestStateStore }): ProtectClient {

  const { nvrConfig, store } = options;
  const client = {

    [Symbol.asyncDispose]: async (): Promise<void> => {

      // No-op: the double owns no resources to release.
    },
    camera: (id: string): TestCameraProjection => new TestCameraProjection(id, store),
    connection: new TestConnection(),
    controllerName: "Test Controller",
    async *events(): AsyncGenerator<never> {

      // None: the activity stream carries no event.
    },
    get liveviews(): readonly ProtectNvrLiveviewConfig[] {

      return [...store.snapshot().liveviews.values()];
    },
    nvr: { config: nvrConfig },
    reboot: async (): Promise<void> => {

      // No-op: the double's controller accepts the command, and a row moves the connection levers for whatever follows.
    },
    state: store
  };

  return client as unknown as ProtectClient;
}

/**
 * Build the platform a real controller root is constructed over: the controller double's own, whose Homebridge API double is the API the root registers its shutdown
 * listener on. The double is handed over as the instance itself, because its accessory calls and its event methods live on its prototype. Shutdown is one shutdown
 * event on that API, the way Homebridge's exit raises it, so the root's listener and the accessory persistence's run together and no process-global diagnostics
 * subscription the root attached outlives the row.
 *
 * @param double - The controller double whose platform the root is built over.
 *
 * @returns platform: the platform to construct the root with; shutdown: emits Homebridge's shutdown once, so a second call does nothing.
 */
export function makeRootPlatform(double: TestProtectNvr): { platform: ProtectPlatform; shutdown: () => void } {

  let shutDown = false;

  return {

    platform: double.platform as unknown as ProtectPlatform,
    shutdown: (): void => {

      if(shutDown) {

        return;
      }

      shutDown = true;
      double.platform.api.emit(APIEvent.SHUTDOWN);
    }
  };
}
