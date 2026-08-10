/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * testing.helpers.ts: The controller-subsystem test helpers for homebridge-unifi-protect.
 *
 * This file owns the controller half of the harness: TestProtectNvr, the NVR double every device test is constructed against, together with the platform double, the
 * recording MQTT client, the NVR config builder, and the family builder that assembles a whole accessory set. The NVR double mirrors the surfaces production reaches
 * for through its owner - the platform-accessory registration recorders, the device-removal machinery with its mutable stability gate and manually fired timers, the
 * managed-device registry - and carries the REAL ProtectEventDispatch as its events member, so a routed event travels the production path rather than a stub of it.
 * makeTestNvr is the composition root of the harness: it wires a store, a platform, a dispatch, and the streaming-delegate factory into a controller a real device
 * class can be constructed against end to end, with no FFmpeg and no live HAP.
 *
 * Fidelity to the cited contracts, not invention, is the line these doubles hold: the removal machinery is ProtectNvr's own and the MQTT surface is
 * homebridge-plugin-utils'. The cross-cutting core - the HAP double, the state store, and the streaming-delegate stub - lives in the root harness this file imports
 * from.
 */
import type { Camera, Chime, ProtectEventMetadata, ProtectNvrConfig, ProtectNvrLiveviewConfig, ProtectRingtoneConfig } from "unifi-protect";
import { Characteristic, Service, TestAccessory, TestCameraController, TestStreamingDelegateFactory } from "../testing.helpers.ts";
import type { Clock, HomebridgePluginLogging, Nullable, RecordingProcessFactory } from "homebridge-plugin-utils";
import { FeatureOptions, TestClock, TestRecordingProcessFactory } from "homebridge-plugin-utils";
import { PLATFORM_NAME, PLUGIN_NAME } from "../settings.ts";
import type { ProtectAccessory, ProtectDevices } from "../types.ts";
import type { ProtectNvrOptions, ProtectOptions } from "../options.ts";
import type { TestApiCall, TestLogEntry, TestStateStore } from "../testing.helpers.ts";
import { featureOptionCategories, featureOptions } from "../options.ts";
import { AmbientLightCapability } from "../devices/cameras/ambient-light.ts";
import { DoorbellCapability } from "../devices/cameras/doorbell.ts";
import { FIXTURE_RTSPS_PORT } from "../camera.fixtures.ts";
import type { HAP } from "homebridge";
import type { NvrPhase } from "./nvr.ts";
import type { ProtectCamera } from "../devices/cameras/camera.ts";
import { ProtectCameraPackage } from "../devices/cameras/camera-package.ts";
import type { ProtectDevice } from "../devices/device.ts";
import { ProtectEventDispatch } from "./event-dispatch.ts";
import type { ProtectNvr } from "./nvr.ts";
import { StreamingCapability } from "../devices/cameras/streaming.ts";
import type { TestChimeProjection } from "../devices/testing.helpers.ts";
import util from "node:util";

// One recorded MQTT subscription registration: the composed topic tail, the human-readable type label, the registration kind, the per-subscription init options
// production passed (the lifetime signal lives there, so a test can assert which signal scoped each registration and observe it abort with its owner), and the captured
// handler closure. getValue is present on a "get" registration, setValue on a "set" registration; both are captured so a test can FIND a subscription by topic / kind
// and INVOKE its handler directly - the path the production MQTT subscribeGet / subscribeSet handlers take that the HomeKit onSet machinery does not exercise (the
// chime's switch(value) tone dispatch and empty-payload default, the viewer's liveview name lookup and unknown-name error).
export interface TestMqttSubscription {

  getValue?: () => string;
  init?: { signal?: AbortSignal };
  kind: "get" | "set";
  setValue?: (value: string, rawValue: string) => Promise<void> | void;
  topic: string;
  type: string;
}

/* A minimal recording double of the homebridge-plugin-utils MqttClient surface ProtectBase's wrappers and the event dispatcher reach: publish, subscribeGet,
 * subscribeSet, and unsubscribe. Registration-recording, plus handler CAPTURE - delivering a message to a registered handler (and releasing it when its signal
 * aborts) is homebridge-plugin-utils' contract, pinned by its own tests, so the double does not stand up a broker; it captures each handler closure onto the
 * recorded subscription so a test can find it by topic / kind and invoke it directly. That lets a test exercise the plugin's own MQTT-specific dispatch (the
 * chime's switch(value) tone dispatch and empty-payload default, the viewer's liveview name lookup and unknown-name error) - the handler bodies that the
 * HomeKit onSet machinery never reaches. What THIS double proves is the plugin's side of the seam: which subscriptions a device registered, on which topics,
 * carrying which lifetime signal, what each handler does, and what was published.
 */
export class TestMqttClient {

  public readonly published: { message: string; topic: string }[] = [];
  // When set, publish() rejects with this error instead of recording, so a test can drive the guarded-publish failure path. Persistent for the double's per-test
  // lifetime; every test builds a fresh client, so there is no reset machinery.
  public publishRejection: Nullable<Error> = null;
  public readonly subscriptions: TestMqttSubscription[] = [];
  public readonly unsubscribes: { id: string; topic: string }[] = [];

  public async publish(topic: string, message: string): Promise<void> {

    if(this.publishRejection) {

      throw this.publishRejection;
    }

    this.published.push({ message, topic });
  }

  public subscribeGet(topic: string, type: string, getValue: () => string, init?: { signal?: AbortSignal }): void {

    this.subscriptions.push({ getValue, init, kind: "get", topic, type });
  }

  public subscribeSet(topic: string, type: string, setValue: (value: string, rawValue: string) => Promise<void> | void, init?: { signal?: AbortSignal }): void {

    this.subscriptions.push({ init, kind: "set", setValue, topic, type });
  }

  public unsubscribe(id: string, topic: string): void {

    this.unsubscribes.push({ id, topic });
  }
}

// The platform double's honest structural type. The members mirror what ProtectBase and the camera-family construction paths read off nvr.platform: the HAP
// namespaces plus the deterministic uuid generator, the injected wall-clock seam (the recording delegate reads platform.clock for its pacing-time primitives), the
// platform-accessory class and the four registration recorders (the doorbell's configurePackageCamera and the NVR removal tail drive them), the platform's mutable
// accessories array, a concrete codecSupport (the real platform getter throws before the FFmpeg probe - a concrete object with a non-raspbian hostSystem keeps the
// recording-default switch on its default branch), the ProtectOptions-shaped config, the REAL FeatureOptions engine, the log sinks, the recording-process factory seam
// (the recording delegate constructs its FFmpeg process through it), and the streaming-delegate factory seam.
export interface TestProtectPlatform {

  readonly accessories: TestAccessory[];
  readonly api: {

    hap: { CameraController: typeof TestCameraController; Characteristic: typeof Characteristic; Service: typeof Service; uuid: { generate: (seed: string) => string } };
    platformAccessory: typeof TestAccessory;
    publishExternalAccessories: (pluginName: string, accessories: TestAccessory[]) => void;
    registerPlatformAccessories: (pluginName: string, platformName: string, accessories: TestAccessory[]) => void;
    unregisterPlatformAccessories: (pluginName: string, platformName: string, accessories: TestAccessory[]) => void;
    updatePlatformAccessories: (accessories: TestAccessory[]) => void;
  };
  readonly clock: Clock;
  readonly codecSupport: { hostSystem: string };
  readonly config: ProtectOptions;
  readonly debug: (...parameters: unknown[]) => void;
  readonly featureOptions: FeatureOptions;
  readonly log: {

    debug: (...parameters: unknown[]) => void;
    error: (...parameters: unknown[]) => void;
    info: (...parameters: unknown[]) => void;
    warn: (...parameters: unknown[]) => void;
  };
  readonly pluginLog: HomebridgePluginLogging;
  readonly recordingProcessFactory: RecordingProcessFactory;
  readonly streamingDelegateFactory: TestStreamingDelegateFactory;
}

// The options scheduleDeviceRemoval accepts on the NVR double, mirroring the production chokepoint's widened options shape.
export interface TestScheduleDeviceRemovalOptions {

  accessory: TestAccessory;
  reason?: string;
  remove?: () => void;
  stillGone: () => boolean;
}

/* The shared recording event-dispatch double: a REAL ProtectEventDispatch whose motion delivery is overridden to record into an array rather than touch HomeKit or arm a
 * reset timer. The override's arity and parameter types mirror production's motionEventHandler (event-dispatch.ts) exactly, so it type-checks as a true override; the two
 * parameters the recording path deliberately does not read carry the underscore prefix the house no-unused-vars rule reserves for intentionally-unused arguments, and
 * their types still anchor the override against production. Recording arms NO reset timer, so a motion test leaks no handle.
 *
 * This serves every family and base-capability path whose motion routes through the firehose - the light family's lastMotion observer and the base motion trigger / the
 * base motion-set MQTT seam alike - injected through makeTestNvr's dispatch seam and read back off nvr.events. It is the SSOT for that recording shape: the
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
 * The removal machinery mirrors ProtectNvr's stability-gated, graced device removal faithfully but without real timers: removalStable is a mutable gate (defaulting
 * to true so lifecycle tests schedule without ceremony), scheduleDeviceRemoval applies the production gate / idempotency / interval resolution (the interval comes
 * from the REAL FeatureOptions through getFeatureNumber, so the registered DelayDeviceRemoval default governs unless a test overrides it) and either removes
 * immediately or records a manually-fireable timer entry whose fire body is the production fire body (delete, re-check stability and stillGone, remove); the
 * removal tail is the production presence-guarded splice with the bridged-gated unregister recording. Every call is recorded so tests assert decisions, not just
 * outcomes.
 */
export class TestProtectNvr {

  public readonly client: {

    readonly chimes: readonly Chime[];
    connection: { isHealthy: boolean };
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
  public readonly log: {

    debug: (...parameters: unknown[]) => void;
    error: (...parameters: unknown[]) => void;
    info: (...parameters: unknown[]) => void;
    warn: (...parameters: unknown[]) => void;
  };

  public readonly mqtt: Nullable<TestMqttClient>;

  // The NVR lifecycle phase, settable and defaulting to the organic "running" state. The recording delegate reads nvr.phase to suppress its induced-disruption (reboot /
  // shutdown) error logs, so a transmit test that asserts the early-end telemetry log fires needs this to be "running".
  public phase: NvrPhase = "running";
  public readonly platform: TestProtectPlatform;
  public removalStable = true;
  public readonly signal: AbortSignal;

  // The managed-device registry, mirroring ProtectNvr.configuredDevices: a Map keyed by accessory UUID whose values are the constructed device objects. The
  // controller-owner motion fanouts resolve a member camera through it - the security-system fanout reads configuredDevices.get(accessory.UUID)?.protectId, the liveviews
  // fanout reaches it through getDeviceById. A test seeds a minimal member double through the ProtectDevices cast at the construction seam, exactly as the device-class
  // doubles are cast elsewhere. Both fanouts read only a narrow slice of the device (protectId for the security path, accessory / accessoryName for the liveviews path),
  // so the seeded double carries just that slice.
  public readonly configuredDevices = new Map<string, ProtectDevices>();

  // The recorded machinery: every cancelled removal UUID, the pending manually-fireable removal timers keyed by accessory UUID, and every schedule decision with its
  // resolved interval.
  public readonly cancelledRemovals: string[] = [];
  public readonly removalTimers = new Map<string, { fire: () => void }>();
  public readonly scheduledRemovals: { interval: number; options: TestScheduleDeviceRemovalOptions }[] = [];

  // The once-per-option feature log gate, mirroring ProtectNvr.logFeature's featureLog record.
  readonly #featureLog: Record<string, boolean> = {};

  public constructor(init: { client: TestProtectNvr["client"]; config: ProtectNvrOptions; dispatch?: (nvr: ProtectNvr) => ProtectEventDispatch;
    log: TestProtectNvr["log"]; mqtt: Nullable<TestMqttClient>; platform: TestProtectPlatform; signal: AbortSignal; }) {

    this.client = init.client;
    this.config = init.config;
    this.log = init.log;
    this.mqtt = init.mqtt;
    this.platform = init.platform;
    this.signal = init.signal;

    // The real event dispatcher, wired against this double - its constructor reads only the platform's HAP namespace, the log, and the NVR handle itself. The optional
    // dispatch factory is the reusable injection seam: when omitted, the default factory is byte-identical to today's new ProtectEventDispatch(this), so every existing
    // consumer is unchanged; a test injects a recording subclass (overriding motionEventHandler to record without arming the real reset timer) to assert the device
    // observers' firehose routing without leaking a dangling timer handle. The factory runs at exactly the point this.events was assigned before, the last write in
    // the constructor, so nothing reads events before this line either way.
    this.events = (init.dispatch ?? ((nvr: ProtectNvr): ProtectEventDispatch => new ProtectEventDispatch(nvr)))(this as unknown as ProtectNvr);
  }

  // Read-through to the controller record, mirroring the production getter.
  public get ufp(): Readonly<ProtectNvrConfig> {

    return this.client.nvr.config;
  }

  // Cancel every pending delayed removal, mirroring the production all-bets-are-off rule when the controller leaves good-state.
  public cancelAllDeviceRemovals(): void {

    this.removalTimers.clear();
  }

  // Cancel a single pending delayed removal by accessory UUID, recording the cancellation. Idempotent, like production.
  public cancelDeviceRemovalFor(uuid: string): void {

    this.removalTimers.delete(uuid);
    this.cancelledRemovals.push(uuid);
  }

  // The production controller-scoped feature-number read: the REAL FeatureOptions engine resolves the option against the controller MAC, returning the registered
  // default when unconfigured and null when a test's user options disabled it.
  public getFeatureNumber(option: string): Nullable<number | undefined> {

    return this.platform.featureOptions.getInteger(option, this.ufp.mac);
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

  // Mirror ProtectNvr.logFeature: log a controller- or globally-scoped feature message once per option.
  public logFeature(option: string, message: string): void {

    option = option.toLowerCase();

    if(this.#featureLog[option] || ![ "global", "controller" ].includes(this.platform.featureOptions.scope(option, undefined, this.ufp.mac))) {

      return;
    }

    this.#featureLog[option] = true;
    this.log.info(message);
  }

  // The composition-root construction seams, mirroring production: each constructs the REAL device-family class, faithful to ProtectNvr (the harness already constructs
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

  // The sweep-stale removal seam, mirroring production: route the camera's request to the REAL DoorbellCapability.removeServices SSOT, with the platform's HAP namespace
  // and the double's log - so suite D exercises the actual removal logic, not a stand-in. The double's structural HAP shape is cast to the production parameter type
  // through unknown, the same confined-cast discipline every other harness seam uses; the log shape already satisfies HomebridgePluginLogging structurally.
  public removeStaleDoorbellServices(accessory: ProtectAccessory): void {

    DoorbellCapability.removeServices(accessory, this.platform.api.hap as unknown as HAP, this.log);
  }

  // The production removal tail, mirrored: a presence guard so a stale double-fire is a no-op (never a splice(-1) corruption), the bridged-gated unregister, the
  // splice, and the cache persist.
  public removeAccessoryFromHomeKit(accessory: TestAccessory): void {

    const index = this.platform.accessories.indexOf(accessory);

    if(index === -1) {

      return;
    }

    if(accessory._associatedHAPAccessory.bridged) {

      this.platform.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }

    this.platform.accessories.splice(index, 1);
    this.platform.api.updatePlatformAccessories(this.platform.accessories);
  }

  // The production removal chokepoint, mirrored without real timers: gate on stability, dedup per accessory UUID, resolve the grace interval through the real
  // feature-option engine, then either remove immediately (interval disabled) or record a manually-fireable timer entry whose fire body is the production fire body.
  public scheduleDeviceRemoval(options: TestScheduleDeviceRemovalOptions): void {

    const { accessory, reason, stillGone } = options;
    const remove = options.remove ?? ((): void => this.removeAccessoryFromHomeKit(accessory));

    if(!this.removalStable) {

      return;
    }

    if(this.removalTimers.has(accessory.UUID)) {

      return;
    }

    const interval = this.getFeatureNumber("Nvr.DelayDeviceRemoval") ?? 0;

    this.scheduledRemovals.push({ interval, options });

    if(reason) {

      this.log.info(reason);
    }

    if(interval <= 0) {

      remove();

      return;
    }

    this.removalTimers.set(accessory.UUID, { fire: (): void => {

      this.removalTimers.delete(accessory.UUID);

      if(this.removalStable && stillGone()) {

        remove();
      }
    } });
  }
}

/**
 * Build the NVR config record the construction path reads through nvr.ufp: the host (the last fallback in the camera's RTSP host chain), the controller MAC (the
 * feature-option controller scope key, and the chime / ringtone nvrMac filter key), the RTSP(S) ports (the RTSPS port pinned to the fixture value so channel profile
 * URLs match the golden-master corpus), plus the controller-owner read set: a marketName / name / type for setInfo's Model and the system-info accessory's display
 * name, and a populated systemInfo so the nvr-systeminfo owner's initial pass (which dereferences systemInfo.cpu.temperature with no optional chaining) and its
 * MQTT JSON.stringify read meaningfully. The single confined cast seam for the controller record, mirroring makeCameraConfig's discipline.
 *
 * @param options - hardwareRevision: OPT-IN with no default (stays undefined) - the security-system owner writes nvr.ufp.hardwareRevision onto HardwareRevision
 *                  unconditionally, so buildSecuritySystem (in security-system.test.ts) opts a value in to net that write non-vacuously, while the default omission
 *                  keeps ProtectBase.setInfo's HardwareRevision length-guard short-circuited for the device-info concern net; mac: the controller MAC override
 *                  (defaults to "74ACB9FFFFFF"), so a multi-controller test seeds two stores with distinct controller identities and the owners scope their accessories
 *                  apart; marketName / name / type: identity overrides setInfo and the system-info accessory read; temperature: the optional systemInfo.cpu.temperature
 *                  override, so the observer's reactive refresh can be asserted on a known value.
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
 * TestProtectNvr; the single cast to ProtectNvr is confined to the construction seam in the test itself, mirroring the reachability suite's discipline - the
 * casts live at the seam, and the instance under test is the production class.
 *
 * @param options - chimes: the HELD chime projection doubles client.chimes exposes (omitted, the empty default), kept as the same instances across every access so the
 *                  doorbell's cross-device setChimeVolume write hits, and a test's updateRejection lever is set on, ONE projection - a per-access rebuild would silently
 *                  break the rejection drive; clock: an optional controllable TestClock installed on the platform double's clock seam and returned so a transmit test can
 *                  advance virtual time to drive the recording delegate's pacing (omitted, a fresh default TestClock seeded at 0 is created); controllerName: the
 *                  controller label (defaults
 *                  to "Test Controller"); dispatch: an optional event-dispatch factory threaded into the NVR double's events seam (omitted, the default builds the real
 *                  ProtectEventDispatch unchanged; a test injects a recording subclass to assert the device observers' firehose routing without arming the real reset
 *                  timer); mqtt: pass true to install the recording MQTT double (the default null makes every MQTT wrapper a no-op, matching an unconfigured broker);
 *                  overrideAddress: the controller-level address override for rtspHost-chain tests; recordingProcessFactory: an optional test recording-process factory
 *                  installed on the platform double's recordingProcessFactory seam (omitted, a fresh default factory is created so the recording delegate constructs its
 *                  FFmpeg process through the test double); sharedPlatform: an optional { accessories, apiCalls } pair captured from a previously built double, so a
 *                  second controller reconciles over the SAME platform accessories array and registration recorder as the first, mirroring production's one shared
 *                  ProtectPlatform - the seam a multi-controller test uses to prove one controller's reconcile leaves the other's switches untouched (omitted, each call
 *                  builds its own fresh accessories array and apiCalls recorder); store: the state-store double backing client.state; userOptions: feature-option config
 *                  strings (the production options array shape, e.g. "Enable.Device.SyncName" or "Disable.Nvr.DelayDeviceRemoval") applied to the REAL FeatureOptions
 *                  engine.
 *
 * @returns apiCalls: every homebridge accessory-registration call the platform double recorded; clock: the controllable TestClock installed on the platform double (the
 *          same instance the recording delegate reads via platform.clock, so a transmit test advances it to release pacing); controller: the AbortController behind
 *          nvr.signal (abort it in suite teardown); factory: the stub streaming-delegate factory; logEntries: every line the construction path logged; mqtt: the
 *          recording MQTT double when requested, else null; nvr: the NVR double.
 */
export function makeTestNvr(options: { chimes?: TestChimeProjection[]; clock?: TestClock; controllerName?: string; dispatch?: (nvr: ProtectNvr) => ProtectEventDispatch;
  doorbellMessages?: ProtectNvrOptions["doorbellMessages"]; doorbellSettings?: ProtectNvrConfig["doorbellSettings"]; mqtt?: boolean; overrideAddress?: string;
  recordingProcessFactory?: RecordingProcessFactory;
  sharedPlatform?: { accessories: TestAccessory[]; apiCalls: TestApiCall[] }; store: TestStateStore; userOptions?: string[]; }):
{ apiCalls: TestApiCall[]; clock: TestClock; controller: AbortController; factory: TestStreamingDelegateFactory; logEntries: TestLogEntry[];
  mqtt: Nullable<TestMqttClient>; nvr: TestProtectNvr; } {

  // Reuse the caller-supplied accessories array and registration recorder when sharing a platform across controllers, so a second controller sees and reconciles over
  // the first's switches; otherwise each call gets its own fresh pair, keeping every existing single-controller call unchanged.
  const accessories = options.sharedPlatform?.accessories ?? [];
  const apiCalls = options.sharedPlatform?.apiCalls ?? [];

  // The HELD chime projection doubles client.chimes returns: the SAME instances captured once here, never a per-access rebuild. The doorbell's setChimeVolume filters
  // client.chimes and calls update() on the matching projection, and a test asserts that projection's updateCalls / sets its updateRejection lever, so they must be
  // one instance. A rebuild getter would hand the write a fresh projection each pass and a test's rejection would go unseen, so the failure drive would pass vacuously.
  const chimes = options.chimes ?? [];
  const clock = options.clock ?? new TestClock();
  const controller = new AbortController();

  // The stable fallback the client.nvr.config getter returns when the store carries no nvr slice, built once so every fallback read is the SAME reference (the existing
  // camera consumers - which never seed the nvr slice - keep reading a fixed record with a stable reference). The doorbell settings the message-switch net seeds ride
  // this fallback, since the camera-family store the doorbell tests build never seeds an nvr slice.
  const defaultNvrConfig = makeNvrConfig(options.doorbellSettings !== undefined ? { doorbellSettings: options.doorbellSettings } : {});
  const factory = new TestStreamingDelegateFactory();
  const logEntries: TestLogEntry[] = [];
  const recordingProcessFactory = options.recordingProcessFactory ?? new TestRecordingProcessFactory();
  const mqtt = options.mqtt ? new TestMqttClient() : null;
  const sink = (level: TestLogEntry["level"]): ((...parameters: unknown[]) => void) => (...parameters: unknown[]): void => {

    // Capture both channels: the raw argument list for media tests that read a structured object argument, and the util.format line the real Homebridge sink would emit.
    logEntries.push({ formatted: util.format(...parameters as [string, ...unknown[]]), level, parameters });
  };
  const log = { debug: sink("debug"), error: sink("error"), info: sink("info"), warn: sink("warn") };
  const client = {

    // The HELD chime projections, exposed as the production client.chimes array the doorbell's setChimeVolume filters by cameraIds and writes through. A plain held
    // property (not a store-rebuild getter like liveviews / ringtones below): the volume write and the test's assertion / rejection lever must see the SAME instance, so
    // the projections are captured once above. Projected to the library's Chime shape through the confined seam cast, exactly as the other client members project.
    chimes: chimes as unknown as Chime[],
    connection: { isHealthy: true },
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

  // The homebridge API double: a deterministic, injective uuid generator (a pure function of the seed, so tests can pre-compute cached-accessory UUIDs), the
  // platform-accessory class, and the four registration recorders. The publish / register recorders also maintain the bridged flag, mirroring how standalone
  // publication leaves a real accessory unbridged while bridge registration marks it bridged.
  const api = {

    hap: { CameraController: TestCameraController, Characteristic: Characteristic, Service: Service,
      uuid: { generate: (seed: string): string => "uuid:" + seed } },
    platformAccessory: TestAccessory,
    publishExternalAccessories: (_pluginName: string, published: TestAccessory[]): void => {

      for(const accessory of published) {

        accessory._associatedHAPAccessory.bridged = false;
      }

      apiCalls.push({ accessories: published, kind: "publishExternal" });
    },
    registerPlatformAccessories: (_pluginName: string, _platformName: string, registered: TestAccessory[]): void => {

      for(const accessory of registered) {

        accessory._associatedHAPAccessory.bridged = true;
      }

      apiCalls.push({ accessories: registered, kind: "register" });
    },
    unregisterPlatformAccessories: (_pluginName: string, _platformName: string, unregistered: TestAccessory[]): void => {

      apiCalls.push({ accessories: unregistered, kind: "unregister" });
    },
    updatePlatformAccessories: (updated: TestAccessory[]): void => {

      apiCalls.push({ accessories: [...updated], kind: "update" });
    }
  };

  const nvr = new TestProtectNvr({

    client: client,
    config: { address: "nvr.test", ...(options.doorbellMessages !== undefined ? { doorbellMessages: options.doorbellMessages } : {}), mqttTopic: "test/protect",
      password: "test-password", username: "test-user", ...(options.overrideAddress !== undefined ? { overrideAddress: options.overrideAddress } : {}) },
    dispatch: options.dispatch,
    log: log,
    mqtt: mqtt,
    platform: {

      accessories: accessories,
      api: api,
      clock: clock,
      codecSupport: { hostSystem: "macOS" },
      config: { controllers: [], debugAll: false, options: [], ringDelay: 0, verboseFfmpeg: false, videoProcessor: "ffmpeg" },
      debug: sink("debug"),
      featureOptions: new FeatureOptions(featureOptionCategories, featureOptions, options.userOptions ?? []),
      log: log,
      pluginLog: log,
      recordingProcessFactory: recordingProcessFactory,
      streamingDelegateFactory: factory
    },
    signal: controller.signal
  });

  return { apiCalls, clock, controller, factory, logEntries, mqtt, nvr };
}

/**
 * Build a pre-linked doorbell-plus-package accessory pair shaped like a bridged restart restore, pushed into the platform double's accessories array. Homebridge
 * restores BRIDGED cached accessories at startup; external (standalone) accessories are never restored, so a standalone package has no restart-shaped fixture -
 * mirroring the production exclusion. The identity values are deliberate fixture literals rather than derivations from the production constants: like the
 * golden-master corpus, they pin what persisted state in the field actually looks like, so a drift in the persistence-critical identity suffix breaks these
 * fixtures loudly instead of silently following along.
 *
 * @param options - mac: the parent doorbell's MAC (defaults to the camera builder's default); name: the parent's display name; nvr: the NVR double whose platform
 *                  accessories array receives the pair.
 *
 * @returns packageAccessory: the cached package camera accessory; parentAccessory: the cached parent doorbell accessory.
 */
export function makeTestAccessoryFamily(options: { mac?: string; name?: string; nvr: TestProtectNvr }):
{ packageAccessory: TestAccessory; parentAccessory: TestAccessory } {

  const mac = options.mac ?? "74ACB9000001";
  const name = options.name ?? "Test Doorbell";
  const parentAccessory = new TestAccessory(name, "uuid:" + mac);

  parentAccessory.context = { mac: mac, nvr: options.nvr.ufp.mac };

  const packageAccessory = new TestAccessory(name + " Package Camera", "uuid:" + mac + ".PackageCamera");

  packageAccessory.context = { nvr: options.nvr.ufp.mac, packageCamera: mac };

  options.nvr.platform.accessories.push(parentAccessory, packageAccessory);

  return { packageAccessory, parentAccessory };
}
