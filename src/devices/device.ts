/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * device.ts: ProtectDevice - the per-accessory device base (its shared spine, ProtectBase, lives in device-base.ts).
 */
import type { API, CharacteristicValue, Service, WithUUID } from "homebridge";
import type { AcquireServiceTarget, HomebridgePluginLogging, Nullable } from "homebridge-plugin-utils";
import type { Camera, Chime, Light, ProtectCameraConfig, ProtectState, Sensor, Viewer } from "unifi-protect";
import { PROTECT_MOTION_DURATION, PROTECT_OCCUPANCY_DURATION} from "../settings.ts";
import { ProtectReservedNames, exhaustiveGuard } from "../types.ts";
import { acquireService, composeSignals, sanitizeName, validService } from "homebridge-plugin-utils";
import { selectCamera, selectChime, selectLight, selectSensor, selectViewer } from "unifi-protect";
import type { ObserverWakePayload } from "../diagnostics.ts";
import type { ProtectAccessory } from "../types.ts";
import { ProtectBase } from "./device-base.ts";
import type { ProtectDeviceConfigTypes } from "../types.ts";
import type { ProtectNvr } from "../nvr/nvr.ts";
import type { ProtectPlatform } from "../platform.ts";
import { channels } from "../diagnostics.ts";
import { describeDevice } from "./device-descriptor.ts";

const RESERVED_NAMES = new Set(Object.values(ProtectReservedNames).map(x => x.toUpperCase()));

// Device-specific options and settings.
export interface ProtectHints {

  crop: boolean;
  cropOptions: {

    height: number;
    width: number;
    x: number;
    y: number;
  };
  enabled: boolean;
  hardwareDecoding: boolean;
  hardwareTranscoding: boolean;
  highResSnapshots: boolean;
  hksvRecordingIndicator: boolean;
  ledStatus: boolean;
  logDoorbell: boolean;
  logHksv: boolean;
  logMotion: boolean;
  motionDuration: number;
  nightVision: boolean;
  occupancyDuration: number;
  probesize: number;
  recordingDefault: string;
  smartDetect: boolean;
  smartDetectSensors: boolean;
  smartOccupancy: string[];
  standalone: boolean;
  streamingDefault: string;
  syncName: boolean;
  transcode: boolean;
  transcodeBitrate: number;
  transcodeHighLatency: boolean;
  transcodeHighLatencyBitrate: number;
  tsbStreaming: boolean;
  twoWayAudio: boolean;
  twoWayAudioDirect: boolean;
}

// The shared device-and-plugin-context surface the media delegates read off the camera they serve - the slice of ProtectDevice/ProtectBase that is genuinely
// device-level, distinct from the camera-specific media members in ProtectCameraHost (which extends this). ProtectDevice implements it, so the contract is
// guaranteed at the class; the media layer depends on it without naming the concrete device.
export interface ProtectDeviceContext {

  // The HAP platform accessory carrying this device's services and context.
  readonly accessory: ProtectAccessory;

  // The human-readable accessory name.
  readonly accessoryName: string;

  // The Homebridge API handle.
  readonly api: API;

  // Predicate for a resolved feature option.
  hasFeature(option: string): boolean;

  // The per-device resolved feature-hint bag.
  readonly hints: ProtectHints;

  // The composite reachability/online gate.
  readonly isReachable: boolean;

  // The per-device logger.
  readonly log: HomebridgePluginLogging;

  // The owning controller.
  readonly nvr: ProtectNvr;

  // The owning platform (codec support, config, verbose-FFmpeg flag).
  readonly platform: ProtectPlatform;

  // Toggles the recording-indicator status LED.
  setStatusLed(value: boolean): Promise<boolean>;
}

export abstract class ProtectDevice extends ProtectBase implements ProtectDeviceContext {

  public accessory: ProtectAccessory;
  // Per-accessory abort controller, composed against the NVR signal via composeSignals (the homebridge-plugin-utils primitive). Aborting it (cleanup, device removal)
  // tears down every observe loop this accessory spawned.
  protected readonly controller: AbortController;
  // The live projection for this device. Holds (client, id), reads through to the store on every config access. Set once at construction; never reassigned -
  // the accessory's identity is its MAC, stable across reboots, so the handle never goes stale. Injected by the NVR root when constructing the accessory, which
  // knows the concrete projection type at the point of adoption (Camera | Light | Sensor | Chime | Viewer); subclasses narrow at their own constructor.
  protected readonly device: Camera | Light | Sensor | Chime | Viewer;
  public hints: ProtectHints;
  // The per-accessory abort signal. Composed: aborts when EITHER the per-accessory controller is aborted OR the NVR's terminal shutdown signal fires. Use this when
  // spawning per-accessory observe loops, so plugin shutdown and per-accessory teardown both unwind the loop cleanly.
  protected readonly signal: AbortSignal;
  protected timers: Map<string, NodeJS.Timeout>;

  // The constructor captures the accessory and live projection handle, wires the per-accessory abort controller and its composed signal, and seeds the hints and timers
  // state; device configuration is wired separately by the NVR root after construction.
  constructor(nvr: ProtectNvr, accessory: ProtectAccessory, device: Camera | Light | Sensor | Chime | Viewer) {

    super(nvr);

    this.accessory = accessory;
    this.controller = new AbortController();
    this.device = device;
    this.hints = {} as ProtectHints;
    this.signal = composeSignals(this.controller.signal, nvr.signal);
    this.timers = new Map();
  }

  // Read-through config. The live projection delivers the current config on every access - no held snapshot, no merge, no reassignment. Subclasses reading
  // this.ufp.<field> at HomeKit-callback rates pay one getter chain in nanoseconds; if profiling later names a hot read site, scope-local-hoist the read-through
  // once into a local at the top of the scope and read fields off the local for the duration. Never cache as an accessory field - that re-introduces the held-state
  // model we deliberately do not keep, which would violate the single source of truth.
  public get ufp(): Readonly<ProtectDeviceConfigTypes> {

    return this.device.config;
  }

  // Retrieve an existing service from an accessory, creating it if necessary.
  protected acquireService(serviceType: AcquireServiceTarget, name = this.accessoryName, subtype?: string, onServiceCreate?: (svc: Service) => void):
  Nullable<Service> {

    return acquireService(this.accessory, serviceType, name, subtype, onServiceCreate);
  }

  // Validate whether a service should exist, removing it if necessary.
  protected validService(serviceType: WithUUID<typeof Service>, validate: boolean, subtype?: string): boolean {

    return validService(this.accessory, serviceType, validate, subtype);
  }

  // Configure device-specific settings.
  protected configureHints(): boolean {

    this.hints.enabled = this.hasFeature("Device");
    this.hints.logMotion = this.hasFeature("Log.Motion");
    this.hints.motionDuration = this.getFeatureNumber("Motion.Duration") ?? PROTECT_MOTION_DURATION;
    this.hints.occupancyDuration = this.getFeatureNumber("Motion.OccupancySensor.Duration") ?? PROTECT_OCCUPANCY_DURATION;
    this.hints.smartOccupancy = [];
    this.hints.standalone = this.hasFeature("Device.Standalone");
    this.hints.syncName = this.hasFeature("Device.SyncName");

    // Sanity check motion detection duration. Make sure it's never less than 2 seconds so we can actually alert the user.
    if(this.hints.motionDuration < 2) {

      this.hints.motionDuration = 2;
    }

    // Sanity check occupancy detection duration. Make sure it's never less than 60 seconds so we can actually alert the user.
    if(this.hints.occupancyDuration < 60) {

      this.hints.occupancyDuration = 60;
    }

    // Inform the user if we've opted for something other than the defaults.
    if(this.hints.syncName) {

      this.logFeature("Device.SyncName", "Syncing Protect device name to HomeKit.", "Syncing Protect device names to HomeKit.");
    } else if(this.isDeviceFeature("Device.SyncName")) {

      this.log.info("Not syncing this Protect device name to HomeKit.");
    }

    if(this.hints.motionDuration !== PROTECT_MOTION_DURATION) {

      this.log.info("Motion event duration set to %s seconds.", this.hints.motionDuration);
    }

    if(this.hints.occupancyDuration !== PROTECT_OCCUPANCY_DURATION) {

      this.log.info("Occupancy event duration set to %s seconds.", this.hints.occupancyDuration);
    }

    return true;
  }

  // Configure the device information details for HomeKit.
  public configureInfo(): boolean {

    // Sync the Protect name with HomeKit, if configured.
    if(this.hints.syncName) {

      this.accessoryName = this.syncedName;
    }

    return this.setInfo(this.accessory, this.ufp);
  }

  // Cleanup our observe loops, timers, and any other activities as needed. Aborting the per-accessory controller tears down every observe loop this accessory
  // spawned through this.signal; the timers Map is HomeKit-side pacing state and is cleared alongside.
  public cleanup(): void {

    this.controller.abort();

    for(const timer of this.timers.values()) {

      clearTimeout(timer);
    }

    this.timers.clear();
  }

  // Register a timeout, storing it for cleanup on device removal. If a timer with the same key already exists, it is cleared before the new one is set.
  protected registerTimeout(key: string, callback: () => void, delay: number): void {

    const existing = this.timers.get(key);

    if(existing) {

      clearTimeout(existing);
    }

    this.timers.set(key, setTimeout(() => {

      this.timers.delete(key);
      callback();
    }, delay));
  }

  // Register an interval, storing it for cleanup on device removal. If an interval with the same key already exists, it is cleared before the new one is set.
  protected registerInterval(key: string, callback: () => void, interval: number): void {

    const existing = this.timers.get(key);

    if(existing) {

      clearInterval(existing);
    }

    this.timers.set(key, setInterval(callback, interval));
  }

  // Clear a previously registered timer by key.
  protected clearTimer(key: string): void {

    const timer = this.timers.get(key);

    if(timer) {

      clearTimeout(timer);
      this.timers.delete(key);
    }
  }

  // The device-leaf MQTT scope: a device's MAC is its leading topic path segment, so every device publish / subscribe / unsubscribe scopes under
  // {topicPrefix}/{mac}/{subtopic}. This overrides the controller-scoped base default; the four MQTT wrappers themselves are inherited from ProtectBase, varying only by
  // this id.
  protected override get mqttId(): string {

    return this.ufp.mac;
  }

  // Configure the Protect motion sensor for HomeKit.
  protected configureMotionSensor(isEnabled = true, isInitialized = false): boolean {

    // Have we disabled the motion sensor?
    if(!isEnabled) {

      this.unsubscribe("motion/get");
      this.unsubscribe("motion/set");
      this.configureMotionSwitch(isEnabled);
      this.configureMotionTrigger(isEnabled);
    }

    // Validate whether we should have this service enabled.
    if(!this.validService(this.hap.Service.MotionSensor, isEnabled)) {

      return false;
    }

    // Acquire the service.
    const service = this.acquireService(this.hap.Service.MotionSensor, undefined, undefined, () => {

      isInitialized = false;
    });

    if(!service) {

      this.log.error("Unable to add motion sensor.");

      return false;
    }

    // Have we previously initialized this sensor? We assume not by default, but this allows for scenarios where you may be dynamically reconfiguring a sensor at
    // runtime (e.g. UniFi sensors can be reconfigured for various sensor modes in realtime).
    if(!isInitialized) {

      // Initialize the state of the motion sensor.
      service.updateCharacteristic(this.hap.Characteristic.MotionDetected, false);
      service.updateCharacteristic(this.hap.Characteristic.StatusActive, this.isReachable);

      service.getCharacteristic(this.hap.Characteristic.StatusActive).onGet(() => this.isReachable);

      // Configure our MQTT support.
      this.subscribeGet("motion", "motion", () => service.getCharacteristic(this.hap.Characteristic.MotionDetected).value ? "true" : "false");

      this.subscribeSet("motion", "motion event trigger", (value: string) => {

        // When we get the right message, we trigger the motion event.
        if(value !== "true") {

          return;
        }

        // Trigger the motion event.
        this.nvr.events.motionEventHandler(this);
      });

      // Configure any motion switches or triggers the user may have enabled or disabled.
      this.configureMotionSwitch(isEnabled);
      this.configureMotionTrigger(isEnabled);
    }

    return true;
  }

  // Configure a switch to easily activate or deactivate motion sensor detection for HomeKit.
  private configureMotionSwitch(isEnabled = true): boolean {

    // Validate whether we should have this service enabled.
    if(!this.validService(this.hap.Service.Switch, isEnabled && this.hasFeature("Motion.Switch"), ProtectReservedNames.SWITCH_MOTION_SENSOR)) {

      // If we disable the switch, make sure we fully reset its state. Otherwise, we can end up in a situation (e.g. liveview switches) where we have disabled motion
      // detection with no meaningful way to enable it again.
      this.accessory.context.detectMotion = true;

      return false;
    }

    // Acquire the service.
    const service = this.acquireService(this.hap.Service.Switch, this.accessoryName + " Motion Events", ProtectReservedNames.SWITCH_MOTION_SENSOR);

    // Fail gracefully.
    if(!service) {

      this.log.error("Unable to add motion sensor switch.");

      return false;
    }

    // Activate or deactivate motion detection.
    service.getCharacteristic(this.hap.Characteristic.On).onGet(() => !!this.accessory.context.detectMotion);

    service.getCharacteristic(this.hap.Characteristic.On).onSet((value: CharacteristicValue) => {

      if(this.accessory.context.detectMotion !== value) {

        this.log.info("Motion detection %s.", value ? "enabled" : "disabled");
      }

      this.accessory.context.detectMotion = !!value;
    });

    // Initialize the switch state.
    if(!("detectMotion" in this.accessory.context)) {

      this.accessory.context.detectMotion = true;
    }

    service.updateCharacteristic(this.hap.Characteristic.On, this.accessory.context.detectMotion ?? true);

    this.log.info("Enabling motion sensor switch.");

    return true;
  }

  // Configure a switch to manually trigger a motion sensor event for HomeKit.
  private configureMotionTrigger(isEnabled = true): boolean {

    // Validate whether we should have this service enabled.
    if(!this.validService(this.hap.Service.Switch, isEnabled && this.hasFeature("Motion.Trigger"), ProtectReservedNames.SWITCH_MOTION_TRIGGER)) {

      return false;
    }

    // Acquire the service.
    const triggerService = this.acquireService(this.hap.Service.Switch, this.accessoryName + " Motion Trigger", ProtectReservedNames.SWITCH_MOTION_TRIGGER);

    // Fail gracefully.
    if(!triggerService) {

      this.log.error("Unable to add motion sensor trigger.");

      return false;
    }

    const motionService = this.accessory.getService(this.hap.Service.MotionSensor);
    const switchService = this.accessory.getServiceById(this.hap.Service.Switch, ProtectReservedNames.SWITCH_MOTION_SENSOR);

    // Activate or deactivate motion detection.
    triggerService.getCharacteristic(this.hap.Characteristic.On).onGet(() => !!motionService?.getCharacteristic(this.hap.Characteristic.MotionDetected).value);

    triggerService.getCharacteristic(this.hap.Characteristic.On).onSet((isOn: CharacteristicValue) => {

      if(isOn) {

        // Check to see if motion events are disabled.
        if(switchService && !switchService.getCharacteristic(this.hap.Characteristic.On).value) {

          // Motion is disabled, so snap the trigger back off. The ~50ms cosmetic bounce is deliberately left out of this.timers; it need not survive cleanup().
          setTimeout(() => triggerService.updateCharacteristic(this.hap.Characteristic.On, false), 50);

        } else {

          // Trigger the motion event.
          this.nvr.events.motionEventHandler(this);

          // Inform the user.
          this.log.info("Motion event triggered.");
        }

        return;
      }

      // If the motion sensor is still on, we should be as well.
      if(motionService?.getCharacteristic(this.hap.Characteristic.MotionDetected).value) {

        // Re-arm the trigger to track the still-active motion sensor. Same ~50ms cosmetic bounce, deliberately left out of this.timers; it need not survive cleanup().
        setTimeout(() => triggerService.updateCharacteristic(this.hap.Characteristic.On, true), 50);
      }
    });

    // Initialize the switch.
    triggerService.updateCharacteristic(this.hap.Characteristic.On, false);

    this.log.info("Enabling motion sensor automation trigger.");

    return true;
  }

  // Configure the Protect occupancy sensor for HomeKit.
  protected configureOccupancySensor(isEnabled = true, isInitialized = false): boolean {

    // Occupancy sensors are disabled by default and primarily exist for automation purposes.
    if(!isEnabled || !this.hasFeature("Motion.OccupancySensor")) {

      this.unsubscribe("occupancy/get");
    }

    // Validate whether we should have this service enabled.
    if(!this.validService(this.hap.Service.OccupancySensor, isEnabled && this.hasFeature("Motion.OccupancySensor"))) {

      return false;
    }

    // Acquire the service.
    const service = this.acquireService(this.hap.Service.OccupancySensor);

    if(!service) {

      this.log.error("Unable to add occupancy sensor.");

      return false;
    }

    // Have we previously initialized this sensor? We assume not by default, but this allows for scenarios where you may be dynamically reconfiguring a sensor at
    // runtime (e.g. UniFi sensors can be reconfigured for various sensor modes in realtime).
    if(!isInitialized) {

      // Initialize the state of the occupancy sensor.
      service.updateCharacteristic(this.hap.Characteristic.OccupancyDetected, false);
      service.updateCharacteristic(this.hap.Characteristic.StatusActive, this.isReachable);

      service.getCharacteristic(this.hap.Characteristic.StatusActive).onGet(() => {

        return this.isReachable;
      });

      // If we have smart motion detection, allow users to choose which object types determine occupancy.
      if(this.hints.smartDetect) {

        // Iterate through all the individual object detection types Protect has configured.
        for(const smartDetectType of
          [ ...(this.ufp as ProtectCameraConfig).featureFlags.smartDetectAudioTypes, ...(this.ufp as ProtectCameraConfig).featureFlags.smartDetectTypes ]) {

          if(this.hasFeature("Motion.OccupancySensor." + smartDetectType)) {

            this.hints.smartOccupancy.push(smartDetectType);
          }
        }

        // If the user has disabled all the object types, warn them.
        if(!this.hints.smartOccupancy.length) {

          this.hints.smartOccupancy.push("no smart motion detection object type configured");
        }
      }

      // Configure our MQTT support.
      this.subscribeGet("occupancy", "occupancy", () => service.getCharacteristic(this.hap.Characteristic.OccupancyDetected).value ? "true" : "false");

      this.log.info("Enabling occupancy sensor%s.", this.hints.smartDetect ? " using smart motion detection: " + this.hints.smartOccupancy.join(", ")  : "");
    }

    return true;
  }

  // Configure a switch to turn on or off the status indicator light for HomeKit.
  protected configureStatusLedSwitch(isEnabled = true): boolean {

    // Validate whether we should have this service enabled.
    if(!this.validService(this.hap.Service.Switch, isEnabled && this.hasFeature("Device.StatusLed.Switch"), ProtectReservedNames.SWITCH_STATUS_LED)) {

      return false;
    }

    // Acquire the service.
    const service = this.acquireService(this.hap.Service.Switch, this.accessoryName + " Status Indicator", ProtectReservedNames.SWITCH_STATUS_LED);

    // Fail gracefully.
    if(!service) {

      this.log.error("Unable to add the status indicator light switch.");

      return false;
    }

    // Enable or disable the status indicator light.
    service.getCharacteristic(this.hap.Characteristic.On).onGet(() => this.statusLed);

    service.getCharacteristic(this.hap.Characteristic.On).onSet(async (value: CharacteristicValue) => {

      if(this.statusLed !== value) {

        this.log.info("Status indicator light %s.", value ? "enabled" : "disabled");
      }

      // Push the new state to the controller. setStatusLed routes through the shared command-error helper, which is the single place a failure (including an
      // authorization failure) is reported, so there is nothing to branch on here.
      await this.setStatusLed(!!value);
    });

    // Initialize the switch state.
    service.updateCharacteristic(this.hap.Characteristic.On, this.statusLed);

    this.log.info("Enabling status indicator light switch.");

    return true;
  }

  // Set the status indicator light on a device. statusLedCommand resolves the device-appropriate write-through update (cameras and sensors use ledSettings; Protect
  // lights override it), and the shared command-error helper turns its throw-or-succeed contract into the boolean the status-indicator switch onSet and the camera
  // operating-mode indicator branch on.
  public async setStatusLed(value: boolean): Promise<boolean> {

    return this.runDeviceCommand("turn the status indicator light " + (value ? "on" : "off"), this.statusLedCommand(value));
  }

  // Utility function to return a floating point configuration parameter on a device.
  public getFeatureFloat(option: string): Nullable<number | undefined> {

    return this.platform.featureOptions.getFloat(option, this.ufp.mac, this.nvr.ufp.mac);
  }

  // Utility function to return an integer configuration parameter on a device.
  public getFeatureNumber(option: string): Nullable<number | undefined> {

    return this.platform.featureOptions.getInteger(option, this.ufp.mac, this.nvr.ufp.mac);
  }

  // Utility function to return a configuration parameter on a device.
  public getFeatureValue(option: string): Nullable<string | undefined> {

    return this.platform.featureOptions.value(option, this.ufp.mac, this.nvr.ufp.mac);
  }

  // Utility for checking feature options on a device.
  public hasFeature(option: string): boolean {

    return this.platform.featureOptions.test(option, this.ufp.mac, this.nvr.ufp.mac);
  }

  // Utility for returning the scope of a feature option.
  public isDeviceFeature(option: string): boolean {

    return this.platform.featureOptions.scope(option) === "device";
  }

  // Utility for logging feature option availability.
  public logFeature(option: string, message: string, nvrMessage = message): void {

    if(this.isDeviceFeature(option)) {

      this.log.info(message);

      return;
    }

    this.nvr.logFeature(option, nvrMessage);
  }

  // Utility function for reserved identifiers for switches.
  public isReservedName(name?: string): boolean {

    return name ? RESERVED_NAMES.has(name.toUpperCase()) : false;
  }

  // Two-scope reachability: controller health gates every device at once (a controller outage freezes device.isOnline at a stale value, so it cannot be trusted alone),
  // device.isOnline gates each device. This is the plugin's single availability helper - there is no parallel mechanism. StatusActive characteristics across the
  // accessory read this; operation-initiation gates read this; HKSV composes its readiness gate (buffer >= 10s) at its call site, never inside here. The library
  // deliberately does NOT ship this composition (a deliberate design decision: isOnline is last-known device state) - the plugin is the consumer that composes
  // per-operation reachability.
  public get isReachable(): boolean {

    return this.nvr.client.connection.isHealthy && this.device.isOnline;
  }

  // Spawn this accessory's narrow-selector state observers: one for-await loop per reaction, each yielding only when its watched slice changes by reference, so
  // idle wake-ups are structurally zero (the store's Object.is dedup is upstream of the yield). Leaves override and call super to add their device-specific reactions;
  // the base owns the one reaction every device class shares - syncing the controller's name into HomeKit - so a rename propagates whatever the device kind. Each loop
  // binds to this.signal, so cleanup()/reconfigure/shutdown tear them all down through the per-accessory controller abort.
  protected spawnObservers(): void {

    // The universal reaction: when the controller-side name changes and the user opted into name syncing, push it to the HomeKit accessory. The selector is the name
    // slice itself, so this fires only on an actual rename, never on routine config churn.
    this.observeState({ key: "device.name", selector: state => this.deviceConfigSelector()(state)?.name, title: "the device name" },
      () => this.syncNameFromController());

    // Device information (model, serial, firmware) is set once at configure; the firmware revision is the only field that changes at runtime, on a Protect firmware
    // update. A narrow observe on that slice refreshes the AccessoryInformation service when (and only when) firmware changes - restoring the per-refresh
    // configureInfo the syncDevices loop ran.
    this.observeState({ key: "device.firmwareVersion", selector: state => this.deviceConfigSelector()(state)?.firmwareVersion, title: "device information" },
      () => this.configureInfo());
  }

  // Per-accessory lifetime: this accessory's composed signal scopes its observers and its MQTT subscriptions, so cleanup / reconfigure / shutdown each unwind only
  // this accessory's loops - and release exactly this accessory's MQTT handlers - through the controller abort. Overrides the base default (the controller's terminal
  // shutdown signal) that the controller-scoped owners use.
  protected override get observeSignal(): AbortSignal {

    return this.signal;
  }

  // Publish the per-accessory observer-wake milestone on the forward-only diagnostics channel, keyed by accessory UUID. Zero-cost when no subscriber is attached
  // (the Node-native sync check). This is the per-accessory specialization of the base no-op hook; the key names the watched slice.
  protected override onObserverWake(key: string): void {

    if(channels.observerWake.hasSubscribers) {

      channels.observerWake.publish({ accessoryId: this.accessory.UUID, key } satisfies ObserverWakePayload);
    }
  }

  // Resolve the by-id config selector for this device's category, so the base can observe a shared field (the name) without each leaf re-declaring the selector. The
  // projection already carries its modelKey and id; we map that to the matching memoized by-id selector. The device projection is never the NVR singleton, so the five
  // device categories are exhaustive and the default is unreachable.
  private deviceConfigSelector(): (state: ProtectState) => Readonly<ProtectDeviceConfigTypes> | undefined {

    // Switch on a local copy so the exhaustive cases narrow only the discriminant, not this.device itself (which would leave this.device as never in the unreachable
    // default, where we still read its id).
    const modelKey = this.device.modelKey;

    switch(modelKey) {

      case "camera":

        return selectCamera(this.device.id);

      case "chime":

        return selectChime(this.device.id);

      case "light":

        return selectLight(this.device.id);

      case "sensor":

        return selectSensor(this.device.id);

      case "viewer":

        return selectViewer(this.device.id);

      default:

        exhaustiveGuard(modelKey);

        return () => undefined;
    }
  }

  // The controller-side display name this device syncs into HomeKit: the user-assigned name, falling back to the model's market name. This is the single derivation the
  // two name-sync consumers (configureInfo and syncNameFromController) read, and the one variation seam a leaf overrides to decorate its synced name - the package camera
  // appends its display suffix here, so every sync path picks the decoration up without the parent fanning anything out.
  protected get syncedName(): string {

    return this.ufp.name ?? this.ufp.marketName;
  }

  // Sync the controller's device name into HomeKit when the user enabled name syncing. Restores the controller-side-rename propagation that the dissolved event
  // pipeline used to perform: the cooked display name is the syncedName derivation above, and we only touch HomeKit (and log) when it actually differs from the current
  // accessory name, so the idempotent re-read on an unrelated name-slice yield is silent.
  protected syncNameFromController(): void {

    if(!this.hints.syncName) {

      return;
    }

    const synced = this.syncedName;

    if(this.accessoryName === synced) {

      return;
    }

    this.log.info("Detected a name change on the controller; updating the HomeKit name to %s.", synced);

    this.accessoryName = synced;
  }

  // Pushed by the NVR's connection observe loop when controller-level reachability changes. Walks every service on the accessory and rewrites StatusActive from
  // isReachable on any service that carries that characteristic. Single source: one read of isReachable, one push to every relevant service; no second list of
  // services, no parallel registry.
  //
  // Returns the reachability transition (the prior and new StatusActive value) when the accessory's HomeKit-visible reachability actually flipped, or null when it
  // was unchanged or the accessory carries no StatusActive characteristic. The prior value is read from the first StatusActive-bearing service - the characteristic
  // itself is the single source of "what HomeKit was last shown", so no flag is held on the accessory to remember it. The NVR connection loop forwards a non-null
  // transition to its reachability-fanout diagnostics channel; the StatusActive write happens here regardless of whether anyone is observing that channel.
  public refreshReachability(): Nullable<{ now: boolean; was: boolean }> {

    const now = this.isReachable;
    let transition: Nullable<{ now: boolean; was: boolean }> = null;
    let captured = false;

    for(const service of this.accessory.services) {

      if(!service.testCharacteristic(this.hap.Characteristic.StatusActive)) {

        continue;
      }

      // The first StatusActive-bearing service supplies the representative prior value: every such service is driven from the same isReachable, so they share one
      // transition. We capture it before the write, then write the new value to every service that carries the characteristic.
      if(!captured) {

        captured = true;

        const was = service.getCharacteristic(this.hap.Characteristic.StatusActive).value === true;

        if(was !== now) {

          transition = { now, was };
        }
      }

      service.updateCharacteristic(this.hap.Characteristic.StatusActive, now);
    }

    return transition;
  }

  // Return a unique identifier for a Protect device. We need this for package cameras in particular, since they present multiple cameras in a single physical device.
  public get id(): string {

    return this.ufp.mac;
  }

  // Utility function to return the fully enumerated name of this device. The projection's name getter resolves config.name ?? config.displayName per the
  // DeviceProjection convention. This is one read path, single-sourced through the projection.
  public override get name(): string {

    return this.device.name;
  }

  // The log-line prefix for a device, decorated with the model - "Name [Model]" - so every device-scoped line shows which hardware produced it. The format is
  // single-sourced through describeDevice (plain mode) reading the live projection via this.ufp, so a device rename reflects immediately; the functional `name` above
  // is left bare and untouched.
  protected override get logName(): string {

    return describeDevice(this.ufp);
  }

  // Utility function to return the current accessory name of this device.
  public get accessoryName(): string {

    return (this.accessory.getService(this.hap.Service.AccessoryInformation)?.getCharacteristic(this.hap.Characteristic.Name).value as string | undefined) ??
      (this.ufp.name ?? "Unknown");
  }

  // Utility function to set the current accessory name of this device.
  public set accessoryName(name: string) {

    const cleanedName = sanitizeName(name);

    // Set all the internally managed names within Homebridge to the new accessory name.
    this.accessory.displayName = cleanedName;
    this.accessory._associatedHAPAccessory.displayName = cleanedName;

    // Set all the HomeKit-visible names.
    this.accessory.getService(this.hap.Service.AccessoryInformation)?.updateCharacteristic(this.hap.Characteristic.Name, cleanedName);
  }

  // Build the write-through command that sets this device's status indicator light. The command is returned as a thunk so the update is issued against a narrowed
  // projection: cameras and sensors both carry ledSettings.isEnabled, so the base serves both by narrowing this.device through its modelKey discriminant; the light
  // projection has no ledSettings and overrides this with its lightDeviceSettings command. Returning the thunk (rather than a bare payload) is what lets each device kind
  // issue a typed update against its own config - the base's five-way device union could not.
  protected statusLedCommand(value: boolean): () => Promise<unknown> {

    const device = this.device;

    // Cameras and sensors share the ledSettings.isEnabled command; lights override this method. Chime and viewer projections expose no status indicator and never reach
    // here, so the fall-through is an inert no-op that keeps the signature total.
    if((device.modelKey === "camera") || (device.modelKey === "sensor")) {

      return () => device.update({ ledSettings: { isEnabled: value } });
    }

    return () => Promise.resolve();
  }

  // Structural type guard for devices that have LED settings. We check structurally rather than by device type so that future devices with ledSettings are handled
  // automatically.
  private hasLedSettings(): this is { ufp: { ledSettings: { isEnabled: boolean } } } {

    return "ledSettings" in this.ufp;
  }

  // Utility function to return the current state of the device status indicator. This works for cameras and sensors, but Protect lights control it differently.
  public get statusLed(): boolean {

    if(!this.hasLedSettings()) {

      return false;
    }

    return this.ufp.ledSettings.isEnabled;
  }
}
