/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * device.ts: ProtectDevice - the per-accessory device base (its shared spine, ProtectBase, lives in device-base.ts).
 */
import type { API, CharacteristicValue, Service } from "homebridge";
import type { AcquireServiceOptions, AcquireServiceResult, HomebridgePluginLogging, Nullable, ValidServiceOptions, ValidServiceResult } from "homebridge-plugin-utils";
import type { DeviceCollectionKey, ProtectCameraConfig, ProtectDeviceConfig, ProtectState } from "unifi-protect";
import { PROTECT_MOTION_DURATION, PROTECT_OCCUPANCY_DURATION} from "../settings.ts";
import type { ProtectAccessory, ProtectPersistedContextState, ProtectProjectionMap, ProtectServiceOptions, WithoutIdentity } from "../types.ts";
import { acquireService, mqttGetTopic, mqttSetTopic, setAccessoryName, updateServices, validService } from "homebridge-plugin-utils";
import { deviceSelectors, isDeviceOnline } from "unifi-protect";
import { legacyFamilyForOption, resolveLegacySelection } from "../options-legacy.ts";
import type { LegacyFamily } from "../options-legacy.ts";
import type { ObserverWakePayload } from "../diagnostics.ts";
import { ProtectBase } from "./device-base.ts";
import type { ProtectCapabilityHost } from "./device-capability.ts";
import type { ProtectNvr } from "../nvr/nvr.ts";
import type { ProtectPlatform } from "../platform.ts";
import { ProtectReservedNames } from "../types.ts";
import { channels } from "../diagnostics.ts";
import { describeDevice } from "./device-descriptor.ts";
import { mqttTopics } from "../mqtt.ts";
import { smartDetectLabel } from "../options.ts";

const RESERVED_NAMES = new Set(Object.values(ProtectReservedNames).map(x => x.toUpperCase()));

// Device-specific options and settings. Every field is resolved once from feature options and device capabilities at configure time, so consumers read a plain
// value rather than re-resolving a feature option on every access. This is the shape every device family carries; the camera family extends it with the streaming and
// media hints only a camera has (ProtectCameraHints, in camera.ts).
export interface ProtectHints {

  // Whether this device is exposed to HomeKit at all.
  enabled: boolean;

  // Whether motion events are logged.
  logMotion: boolean;

  // The minimum number of seconds a motion event stays active before it can be cleared.
  motionDuration: number;

  // The minimum number of seconds an occupancy event stays active before it can be cleared.
  occupancyDuration: number;

  /* Whether smart object detection is enabled for this camera. This field and smartOccupancy below belong to the base shape rather than the camera extension because the
   * SHARED machinery both reads AND writes them: configureOccupancySensor reads smartDetect and unconditionally rewrites smartOccupancy for every family, and the event
   * dispatcher's motion delivery reads both through a base-typed receiver. Narrowing those consumers to a camera-extended shape was considered and rejected - the shared
   * write site would then need a cast on every family's call path, re-minting the very cast class this shape retires. The camera family is the only writer that ever
   * sets them meaningfully, and the base derivation seeds them inert.
   */
  smartDetect: boolean;

  // The smart-detect object types selected to drive the occupancy sensor; populated only for cameras with smart detection enabled. On the base shape for the same
  // shared-machinery reason smartDetect above is.
  smartOccupancy: readonly string[];

  // Whether this accessory is published to HomeKit as a standalone accessory rather than bridged through the platform.
  standalone: boolean;

  // Whether the Protect device name is synced to HomeKit.
  syncName: boolean;
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

  // The owning platform (codec support, config, feature options).
  readonly platform: ProtectPlatform;

  // Toggles the recording-indicator status LED.
  setStatusLed(value: boolean): Promise<boolean>;
}

// The facts a configure pass runs with, which every configure method that takes one reads by name: whether what it configures should exist, and which pass this is.
// The first pass sets a service up in full, whether it created the service or found it restored from the accessory cache, which carries none of its handlers. A later
// pass - a runtime reconfigure or an observer's refresh - leaves the handlers and MQTT registrations of a service it finds standing as they are, since they are already
// in place. A method whose callers must always say which pass they run takes initialized as a required field, so no bare call can change its meaning.
export interface ProtectConfigurePass {

  // Whether the configured service should exist on this pass. Defaults to true where a method leaves it optional.
  readonly enabled?: boolean;

  // Whether an earlier pass already set the configured service up. Defaults to false, the first pass, where a method leaves it optional.
  readonly initialized?: boolean;
}

// The per-accessory device base every device family extends: it owns the live projection handle, the resolved feature-option hints bag, the shared HomeKit service
// helpers (acquireService/validService), the base motion/occupancy/status-LED capabilities, and the observers every family shares. The generic parameter D is the
// concrete live-projection type the family supplies on its own class header; it defaults to the full device-collection union so a bare ProtectDevice reference (the
// NVR's device iterator, a test stand-in) still type-checks against every category.
export abstract class ProtectDevice<D extends ProtectProjectionMap[DeviceCollectionKey] = ProtectProjectionMap[DeviceCollectionKey]> extends ProtectBase
  implements ProtectCapabilityHost, ProtectDeviceContext {

  public accessory: ProtectAccessory;
  // The live projection for this device. Holds (client, id), reads through to the store on every config access. Set once at construction; never reassigned -
  // the accessory's identity is its MAC, stable across reboots, so the handle never goes stale. The concrete projection type rides this class's generic parameter,
  // supplied by each family's class header, and the NVR root injects the projection itself at adoption, where it knows the concrete type. The parameter defaults to the
  // full category union, so a bare ProtectDevice reference (the NVR's deviceEndpoints iterator, a test stand-in) reads the whole projection union.
  protected readonly device: D;
  // The per-device resolved feature-hint bag, declared with definite assignment rather than seeded: every device leaf's constructor calls configureHints() synchronously
  // right after super(), before spawnObservers() or any HomeKit callback can read this.hints, so no consumer ever observes the bag before it holds every hint. That
  // template contract is what makes the definite-assignment declaration sound, and it is the reason the derivation can build the bag as one literal below rather than
  // filling a pre-seeded object field by field.
  public hints!: ProtectHints;

  // The constructor captures the accessory and the live projection handle. A device's lifetime is its accessory's: it supplies no parent signal, so the spine composes
  // its per-accessory controller against nvr.signal and the accessory's observers, MQTT registrations, and timers all ride the result. The hints bag is derived by the
  // leaf's own configureHints() call, and device configuration is wired separately by the NVR root after construction.
  constructor(nvr: ProtectNvr, accessory: ProtectAccessory, device: D) {

    super(nvr);

    this.accessory = accessory;
    this.device = device;
  }

  /* Read-through to the live STATE projection, narrowed to drop device identity (id/mac/modelKey): identity is immutable and flows through the dedicated non-throwing
   * accessors (protectId/modelKey/.id/.mac), never this throwing getter, so narrowing makes a this.ufp.<identity> dot-access a compile error rather than a latent throw
   * once the record is gone. The live projection delivers the current config on every access - no held snapshot, no merge, no reassignment. Subclasses reading
   * this.ufp.<state-field> at HomeKit-callback rates pay one getter chain in nanoseconds; if profiling later names a hot read site, scope-local-hoist the read-through
   * once into a local at the top of the scope and read fields off the local for the duration. Never cache as an accessory field - that re-introduces the held-state
   * model we deliberately do not keep, which would violate the single source of truth.
   *
   * The two-step cast is a compiler-reduction bridge, not a type claim. TypeScript cannot reduce a mapped type applied to an unresolved generic parameter constrained to
   * a union, and it rejects even the direct cast's overlap check between the parameter's apparent config union and the deferred mapped type, so the step through unknown
   * is what lets the body express a reduction the compiler cannot perform. Nothing is asserted by hand: the declared type is machine-derived from D, and it resolves to
   * exactly the identity-dropped view of each family's own config - proven at every concrete leaf and at the bare default by the type-identity pins in
   * device-ufp-typing.test.ts, which go red if a future edit ever lets this cast mask a real shift.
   */
  public get ufp(): Readonly<WithoutIdentity<D["config"]>> {

    return this.device.config as unknown as Readonly<WithoutIdentity<D["config"]>>;
  }

  // The controller device id, read non-throwing from the projection's own stable id field. This is the immutable IDENTITY of the device on the controller - distinct
  // from the HomeKit/eventTimer identity (the .id getter) and the bare MAC (.mac) - and it never reads the live config, so it survives a vanished record. Membership and
  // every controller-side lookup (reconcileMembership/membershipDelta, getDeviceById's find, the latch reclaim, cameraFor) key off this rather than the throwing ufp.id.
  public get protectId(): string {

    return this.device.id;
  }

  // The device category tag, read non-throwing from the projection's own modelKey field. Like protectId it never reads the live config, so the devices() filter and
  // cameraFor can classify a device whose record has vanished without throwing. Deriving the return type from the generic parameter narrows a leaf's modelKey to its own
  // category literal for free, while a bare ProtectDevice reference still reads the full category union.
  public get modelKey(): D["modelKey"] {

    return this.device.modelKey;
  }

  // Whether this device's controller record is currently present. Overrides the ProtectBase default (which is always true for a controller-scoped owner) with the
  // library's documented presence idiom - peek() !== undefined - so the one observeState gate neutralizes a vanished record during the DelayDeviceRemoval grace. PUBLIC
  // because the membership/removal/sweep chokepoints and the security-system fan-out gate their per-device reads on it.
  public override get recordPresent(): boolean {

    return this.device.peek() !== undefined;
  }

  // Read a STATE field through the live record non-throwing, returning the supplied default ONLY when the record is absent (a device lingering in the removal grace). A
  // present-but-offline record reads through normally, so HomeKit shows last-known state while offline and a graceful default only once the record itself has vanished.
  // peek() once, default-when-absent: the single chokepoint per fact that makes every pull-path STATE read (HAP onGet, MQTT getValue) unrepresentable-throwing. The
  // generic parameter narrows this["ufp"] to the leaf's concrete config, so the read lambda sees that exact type with no per-leaf generics and no call-site type
  // arguments. The cast on the peek is the same compiler-reduction bridge the ufp getter above documents - the deferred mapped type is what the compiler cannot relate to
  // the parameter's apparent config union - and it asserts nothing the getter's own declared type does not already establish.
  protected fromRecord<T>(read: (config: this["ufp"]) => T, absent: T): T {

    const config = this.device.peek() as this["ufp"] | undefined;

    return config === undefined ? absent : read(config);
  }

  // Acquire a service on this device's accessory, creating it when the accessory carries none. The wrapper supplies the accessory and defaults the name to the
  // accessory name, and answers with the homebridge-plugin-utils result unchanged: the service, and the transition that says whether this call attached it or kept one
  // already present.
  protected acquireService<T extends Service>(options: ProtectServiceOptions<AcquireServiceOptions<T>>): AcquireServiceResult<T> {

    return acquireService({ ...options, accessory: this.accessory, name: options.name ?? this.accessoryName });
  }

  // Reconcile a service's presence on this device's accessory from one verdict, supplying the accessory and the default name the same way. The verdict is either a
  // plain boolean or a presence-aware predicate, mirroring the homebridge-plugin-utils free function this delegates to: the predicate receives the service's current
  // presence so a gate can keep an already-present service while refusing to create a new one (the additive-eager / subtractive-conservative capability gates). The
  // answer is the library's own: the service with an attached or kept transition when the verdict keeps it, or null with a removed or absent transition when it does not.
  protected validService<T extends Service>(options: ProtectServiceOptions<ValidServiceOptions<T>>): ValidServiceResult<T> {

    return validService({ ...options, accessory: this.accessory, name: options.name ?? this.accessoryName });
  }

  // Configure device-specific settings. The complete base bag is built as one literal and assigned, which is what lets the field be declared with definite assignment
  // rather than seeded with a lying empty object: the bag exists in full from its first moment. smartDetect and smartOccupancy seed inert here for every family; the
  // camera family's override derives their real values.
  protected configureHints(): boolean {

    this.hints = {

      enabled: this.hasFeature("Device"),
      logMotion: this.hasFeature("Log.Motion"),
      motionDuration: this.getFeatureNumber("Motion.Duration") ?? PROTECT_MOTION_DURATION,
      occupancyDuration: this.getFeatureNumber("Motion.OccupancySensor.Duration") ?? PROTECT_OCCUPANCY_DURATION,
      smartDetect: false,
      smartOccupancy: [],
      standalone: this.hasFeature("Device.Standalone"),
      syncName: this.hasFeature("Device.SyncName")
    };

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

    // setInfo reads the full identity-bearing record (marketName/type/mac/hardwareRevision/firmwareVersion), so it takes the raw record - present at configure time -
    // rather than the narrowed live-state projection that no longer carries identity.
    return this.setInfo(this.accessory, this.device.config);
  }

  // Reset the accessory's persisted HomeKit context to a clean slate, preserving only the user-state keys that must survive across restarts. Homebridge persists the
  // context in its own on-disk cache, so we discard any stray keys a prior configuration of this same accessory left behind rather than trust the cache, then restore
  // each preserved key from what was actually saved (falling back to the passed default when nothing was persisted) and reseed the identity keys. The preserved
  // parameter is the narrowed ProtectPersistedContextState, so the direct per-key write below is sound: the homogeneous boolean type sidesteps the correlated-union
  // failure the wide context type exhibits under a plain loop.
  protected resetAccessoryContext(preserved: ProtectPersistedContextState = {}): void {

    const savedContext = this.accessory.context;

    this.accessory.context = {};

    for(const key of Object.keys(preserved) as (keyof ProtectPersistedContextState)[]) {

      this.accessory.context[key] = savedContext[key] ?? preserved[key];
    }

    this.seedContextIdentity();
  }

  // Seed the accessory's identity keys from the raw record at configure time, where the record is present - identity is not read through the narrowed live-state
  // projection, and it is re-derived every configure, never preserved across a context reset. The base seeds the persisted bare MAC and the controller MAC; the package
  // camera - the one family whose identity is synthetic - overrides this to seed its parent-derived identity instead.
  protected seedContextIdentity(): void {

    this.accessory.context.mac = this.device.config.mac;
    this.accessory.context.nvr = this.nvr.ufp.mac;
  }

  // The device-leaf MQTT scope: a device's MAC is its leading topic path segment, so every device publish / subscribe / unsubscribe scopes under
  // {topicPrefix}/{mac}/{subtopic}. This overrides the controller-scoped base default; the MQTT wrappers inherited from ProtectBase all vary only by this id.
  protected override get mqttId(): string {

    return this.mac;
  }

  // Configure the Protect motion sensor for HomeKit.
  protected configureMotionSensor({ enabled = true, initialized = false }: ProtectConfigurePass = {}): boolean {

    // Have we disabled the motion sensor?
    if(!enabled) {

      this.unsubscribe(mqttGetTopic(mqttTopics.motion.topic));
      this.unsubscribe(mqttSetTopic(mqttTopics.motion.topic));
      this.configureMotionSwitch({ enabled });
      this.configureMotionTrigger({ enabled });
    }

    // Validate whether we should have this service enabled.
    const { service, transition } = this.validService({ serviceType: this.hap.Service.MotionSensor, validate: enabled });

    if(!service) {

      return false;
    }

    // Set the sensor up on the first pass, or on any later pass that created it. A runtime reconfigure (UniFi sensors can switch sensor modes in realtime) that finds
    // the sensor already standing leaves its handlers and MQTT registrations as they are, since registering them again would stack a second MQTT handler, while one
    // that created the sensor sets it up in full.
    const dressing = !initialized || (transition === "attached");

    if(dressing) {

      // Initialize the state of the motion sensor.
      service.updateCharacteristic(this.hap.Characteristic.MotionDetected, false);
      service.updateCharacteristic(this.hap.Characteristic.StatusActive, this.isReachable);

      service.getCharacteristic(this.hap.Characteristic.StatusActive).onGet(() => this.isReachable);

      // Configure our MQTT support.
      this.subscribeGet(mqttTopics.motion.topic, mqttTopics.motion.label,
        () => service.getCharacteristic(this.hap.Characteristic.MotionDetected).value ? "true" : "false");

      this.subscribeSet(mqttTopics.motion.topic, mqttTopics.motion.label, (value: string) => {

        // When we get the right message, we trigger the motion event.
        if(value !== "true") {

          return;
        }

        // Trigger the motion event.
        this.nvr.events.motionEventHandler(this);
      });

      // Configure any motion switches or triggers the user may have enabled or disabled.
      this.configureMotionSwitch({ enabled });
      this.configureMotionTrigger({ enabled });
    }

    return true;
  }

  // Configure a switch to easily activate or deactivate motion sensor detection for HomeKit.
  private configureMotionSwitch({ enabled = true }: Pick<ProtectConfigurePass, "enabled"> = {}): boolean {

    // Validate whether we should have this service enabled.
    const { service } = this.validService({ name: this.accessoryName + " Motion Events", serviceType: this.hap.Service.Switch,
      subtype: ProtectReservedNames.SWITCH_MOTION_SENSOR, validate: enabled && this.hasFeature("Motion.Switch") });

    if(!service) {

      // If we disable the switch, make sure we fully reset its state. Otherwise, we can end up in a situation (e.g. liveview switches) where we have disabled motion
      // detection with no meaningful way to enable it again.
      this.accessory.context.detectMotion = true;

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
  private configureMotionTrigger({ enabled = true }: Pick<ProtectConfigurePass, "enabled"> = {}): boolean {

    // Validate whether we should have this service enabled.
    const { service: triggerService } = this.validService({ name: this.accessoryName + " Motion Trigger", serviceType: this.hap.Service.Switch,
      subtype: ProtectReservedNames.SWITCH_MOTION_TRIGGER, validate: enabled && this.hasFeature("Motion.Trigger") });

    if(!triggerService) {

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

          // Motion is disabled, so snap the trigger back off.
          this.reflectAfterSet(() => triggerService.updateCharacteristic(this.hap.Characteristic.On, false));

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

        // Re-arm the trigger to track the still-active motion sensor.
        this.reflectAfterSet(() => triggerService.updateCharacteristic(this.hap.Characteristic.On, true));
      }
    });

    // Initialize the switch.
    triggerService.updateCharacteristic(this.hap.Characteristic.On, false);

    this.log.info("Enabling motion sensor automation trigger.");

    return true;
  }

  // Configure the Protect occupancy sensor for HomeKit.
  protected configureOccupancySensor({ enabled = true, initialized = false }: ProtectConfigurePass = {}): boolean {

    // Occupancy sensors are disabled by default and primarily exist for automation purposes.
    if(!enabled || !this.hasFeature("Motion.OccupancySensor")) {

      this.unsubscribe(mqttGetTopic(mqttTopics.occupancy.topic));
    }

    // Validate whether we should have this service enabled.
    const { service, transition } = this.validService({ serviceType: this.hap.Service.OccupancySensor, validate: enabled && this.hasFeature("Motion.OccupancySensor") });

    if(!service) {

      return false;
    }

    // Set the sensor up on the first pass, or on any later pass that created it, the same rule configureMotionSensor follows: a sensor stood up during a steady-state
    // reconcile runs the full setup below rather than being left half-configured, and one already standing does not register its MQTT handler a second time.
    const dressing = !initialized || (transition === "attached");

    if(dressing) {

      // Reset the resolved smart-occupancy type list before rebuilding it, so a live re-creation of the service repopulates from empty rather than accumulating
      // duplicates across runs.
      this.hints.smartOccupancy = [];

      // Initialize the state of the occupancy sensor.
      service.updateCharacteristic(this.hap.Characteristic.OccupancyDetected, false);
      service.updateCharacteristic(this.hap.Characteristic.StatusActive, this.isReachable);

      service.getCharacteristic(this.hap.Characteristic.StatusActive).onGet(() => {

        return this.isReachable;
      });

      // If we have smart motion detection, allow users to choose which object types determine occupancy.
      if(this.hints.smartDetect) {

        // The smart-occupancy object types live on the camera-specific feature flags. We read them off the live STATE view narrowed to the camera config; device identity
        // still flows only through the dedicated accessors. Hoisting to one local reads the side-effect-free getter once and single-sources the narrowed cast. This
        // method is shared by every device family, but this branch is reachable only when hints.smartDetect is true, and hints.smartDetect is set exclusively by
        // ProtectCamera's own configureHints override - no light or sensor ever sets it - so this.ufp is guaranteed to be a camera config whenever this line runs.
        const cameraConfig = this.ufp as Readonly<WithoutIdentity<ProtectCameraConfig>>;

        // The detection types the user selected, read against everything this camera reports it can detect. The wrapper answers in the domain's own spelling, which is
        // the wire casing the firehose delivers, so the occupancy gate can match a delivered event's type against this list directly.
        this.hints.smartOccupancy = this.getFeatureList("Motion.OccupancySensor",
          [ ...cameraConfig.featureFlags.smartDetectAudioTypes, ...cameraConfig.featureFlags.smartDetectTypes ]);
      }

      // Configure our MQTT support.
      this.subscribeGet(mqttTopics.occupancy.topic, mqttTopics.occupancy.label,
        () => service.getCharacteristic(this.hap.Characteristic.OccupancyDetected).value ? "true" : "false");

      // Keep smartOccupancy a pure list of detection types - a display name in that set would be a label living in a protocol set the occupancy gate tests membership
      // against. Both the display names and the all-types-disabled case are rendered here at the log site instead, so what the reader sees is names while the set
      // stays type-only.
      this.log.info("Enabling occupancy sensor%s.", this.hints.smartDetect ? " using smart motion detection: " +
        (this.hints.smartOccupancy.length ? this.hints.smartOccupancy.map((type) => smartDetectLabel(type)).join(", ") :
          "no smart motion detection object type configured") : "");
    }

    return true;
  }

  // Configure a switch to turn on or off the status indicator light for HomeKit.
  protected configureStatusLedSwitch({ enabled = true }: Pick<ProtectConfigurePass, "enabled"> = {}): boolean {

    // Validate whether we should have this service enabled.
    const { service } = this.validService({ name: this.accessoryName + " Status Indicator", serviceType: this.hap.Service.Switch,
      subtype: ProtectReservedNames.SWITCH_STATUS_LED, validate: enabled && this.hasFeature("Device.StatusLed.Switch") });

    if(!service) {

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

  // Set the status indicator light on a device. statusLedCommand resolves the device-appropriate write-through update (cameras, sensors, and relays use ledSettings;
  // Protect lights override it), and the shared command-error helper turns its throw-or-succeed contract into the boolean the status-indicator switch onSet and the
  // camera operating-mode indicator branch on.
  public async setStatusLed(value: boolean): Promise<boolean> {

    return this.runDeviceCommand("turn the status indicator light " + (value ? "on" : "off"), this.statusLedCommand(value));
  }

  // Utility function to return a floating point configuration parameter on a device. The device-scope mac is the raw record's bare MAC (identity, not read through the
  // narrowed live-state projection); the controller-scope mac is the separate controller projection. Every feature-option accessor resolves scope the same way.
  public getFeatureFloat(option: string): Nullable<number | undefined> {

    return this.platform.featureOptions.getFloat(option, this.device.config.mac, this.nvr.ufp.mac);
  }

  // Utility function to return an integer configuration parameter on a device.
  public getFeatureNumber(option: string): Nullable<number | undefined> {

    return this.platform.featureOptions.getInteger(option, this.device.config.mac, this.nvr.ufp.mac);
  }

  // Utility function to return a configuration parameter on a device.
  public getFeatureValue(option: string): Nullable<string | undefined> {

    return this.platform.featureOptions.value(option, this.device.config.mac, this.nvr.ufp.mac);
  }

  /* Resolve a multiple-choice feature option's selected values against the domain this device offers right now.
   *
   * The engine's own list read is the single authority for what a stored value selects - the list grammar, the domain ordering, the all-choices wildcard, the case
   * folding that answers in the domain's own spelling, and the registered default a bare enable resolves all belong to it. What this read adds is the overlay below
   * and the scope identifiers this device resolves at. The three readings the engine tells apart are what make it worth naming here. An option disabled at some scope
   * selects nothing. An option enabled with no stored value keeps the meaning a bare enable has always had, resolving the registered default. An explicit empty
   * payload is a different state entirely - the user emptied the picker on purpose - and it reads as the empty selection rather than falling back.
   *
   * While a family's retired entries are still in the configuration, the selection resolves through the overlay instead, which answers with the retired
   * per-member grammar's exact three-level precedence over this device's own device and controller.
   *
   * @param option - The feature option to read.
   * @param domain - The values the option offers on this device right now.
   *
   * @returns The selected values, in the domain's own spelling and order.
   */
  public getFeatureList(option: string, domain: readonly string[]): readonly string[] {

    const overlaid = this.overlaidFamily(option);

    if(overlaid) {

      return resolveLegacySelection({ controller: this.nvr.ufp.mac, device: this.device.config.mac, domain, family: overlaid,
        options: this.platform.config.options });
    }

    return this.platform.featureOptions.valueList({ controller: this.nvr.ufp.mac, defaultWhenUnset: true, device: this.device.config.mac, domain, option });
  }

  /* The retired family whose overlay must still answer for a feature option at this device, or null once the configuration has converged - which is also the answer
   * for any option that supersedes nothing.
   *
   * Every selection read asks this one question before deciding where to resolve, so "does the retired grammar still own this answer?" has one expression. On a
   * migrated configuration the families set is empty and the whole question costs one set-membership test.
   */
  protected overlaidFamily(option: string): Nullable<LegacyFamily> {

    const family = legacyFamilyForOption(option);

    return (family && this.platform.legacyOptions.families.has(family)) ? family : null;
  }

  // Utility for checking feature options on a device.
  public hasFeature(option: string): boolean {

    return this.platform.featureOptions.test(option, this.device.config.mac, this.nvr.ufp.mac);
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

  // Utility function to check whether a proposed identifier collides with any reserved subtype name the plugin uses, spanning switches, sensors, lightbulbs, and locks.
  public isReservedName(name?: string): boolean {

    return name ? RESERVED_NAMES.has(name.toUpperCase()) : false;
  }

  // Two-scope reachability: controller health gates every device at once (a controller outage freezes device.isOnline at a stale value, so it cannot be trusted alone),
  // device.isOnline gates each device. This is the plugin's single availability helper - there is no parallel mechanism. StatusActive characteristics across the
  // accessory read this; operation-initiation gates read this; HKSV composes its readiness gate (buffer >= 10s) at its call site, never inside here. The library
  // deliberately does NOT ship this composition (a deliberate design decision: isOnline is last-known device state) - the plugin is the consumer that composes
  // per-operation reachability.
  public get isReachable(): boolean {

    // Controller health gates every device at once. Then the device's own online state - read non-throwing through peek() so a vanished record (a device lingering in the
    // removal grace) reports unreachable rather than throwing, the total form this single availability helper needs to be safe on every path that consults it.
    if(!this.nvr.client.connection.isHealthy) {

      return false;
    }

    const config = this.device.peek();

    return (config !== undefined) && isDeviceOnline(config);
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
    // update. A narrow observe on that slice refreshes the AccessoryInformation service when (and only when) firmware changes, re-running configureInfo at
    // firmware-change cadence.
    this.observeState({ key: "device.firmwareVersion", selector: state => this.deviceConfigSelector()(state)?.firmwareVersion, title: "device information" },
      () => this.configureInfo());
  }

  // Publish the per-accessory observer-wake milestone for a slice a composed capability watches. A capability has no accessory identity of its own (it extends the spine,
  // not ProtectDevice), so it attributes its wakes to its hosting device here. This is a thin public window onto onObserverWake below, which is the single publisher -
  // the hasSubscribers-guarded publish keyed on this accessory's UUID - so a capability's wakes and the device's own share one publication idiom, single-sourced.
  // Zero-cost when no diagnostics subscriber is attached.
  public publishObserverWake(key: string): void {

    this.onObserverWake(key);
  }

  // Publish the per-accessory observer-wake milestone on the forward-only diagnostics channel, keyed by accessory UUID. Zero-cost when no subscriber is attached
  // (the Node-native sync check). This is the per-accessory specialization of the base no-op hook; the key names the watched slice.
  protected override onObserverWake(key: string): void {

    if(channels.observerWake.hasSubscribers) {

      channels.observerWake.publish({ accessoryId: this.accessory.UUID, key } satisfies ObserverWakePayload);
    }
  }

  // Resolve the by-id config selector for this device's category, so the base can observe a shared field (the name) without each leaf re-declaring the selector. The
  // projection already carries its modelKey and id, and the library's catalog is keyed by that same category vocabulary, so the category indexes straight into the
  // matching memoized by-id selector. Every device projection is a device-collection member (never the NVR singleton), so this.device.modelKey is a DeviceCollectionKey
  // and the lookup is total.
  private deviceConfigSelector(): (state: ProtectState) => Readonly<ProtectDeviceConfig> | undefined {

    return deviceSelectors[this.device.modelKey].byId(this.device.id);
  }

  // The controller-side display name this device syncs into HomeKit: the user-assigned name, falling back to the model's market name. This is the single derivation the
  // two name-sync consumers (configureInfo and syncNameFromController) read, and the one place a leaf overrides to decorate its synced name - the package camera
  // appends its display suffix here, so every sync path picks the decoration up without the parent fanning anything out.
  protected get syncedName(): string {

    const config = this.device.peek();

    return config?.name ?? config?.marketName ?? this.accessoryName;
  }

  // Sync the controller's device name into HomeKit when the user enabled name syncing. The cooked display name is the syncedName derivation above, and we only touch
  // HomeKit (and log) when it actually differs from the current accessory name, so a re-read on an unrelated name-slice yield is a harmless no-op.
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

  // Pushed by the NVR's connection observe loop when controller-level reachability changes. Rewrites StatusActive from isReachable on every service on the accessory
  // that carries that characteristic, through the homebridge-plugin-utils sweep. Single source: one read of isReachable, one push to every relevant service; no second
  // list of services, no parallel registry.
  //
  // Returns the reachability transition (the prior and new StatusActive value) when the accessory's HomeKit-visible reachability actually flipped, or null when it
  // was unchanged or the accessory carries no StatusActive characteristic. The prior value is read from the first StatusActive-bearing service - the characteristic
  // itself is the single source of "what HomeKit was last shown", so no flag is held on the accessory to remember it. The NVR connection loop forwards a non-null
  // transition to its reachability-fanout diagnostics channel; the StatusActive write happens here regardless of whether anyone is observing that channel.
  public refreshReachability(): Nullable<{ now: boolean; was: boolean }> {

    const now = this.isReachable;

    // The first StatusActive-bearing service supplies the representative prior value: every such service is driven from the same isReachable, so they share one
    // transition. We read it before the sweep writes the new value to every service that carries the characteristic.
    const carrier = this.accessory.services.find((service) => service.testCharacteristic(this.hap.Characteristic.StatusActive));

    if(!carrier) {

      return null;
    }

    const was = carrier.getCharacteristic(this.hap.Characteristic.StatusActive).value === true;

    updateServices(this.accessory, this.hap.Characteristic.StatusActive, now);

    return (was === now) ? null : { now, was };
  }

  // The HomeKit / event-timer identity of this device, sourced from the persisted accessory-context MAC rather than the live config so it survives a vanished record. For
  // a real device this equals the bare .mac below; the package camera overrides it to its suffixed identity. It keys the event dispatcher's timers; the HomeKit
  // accessory UUID is generated independently from the raw adoption config, so this read-source change is UUID-safe.
  public get id(): string {

    return this.accessory.context.mac ?? "";
  }

  // The bare device MAC, sourced from the persisted accessory context so it never reads the live config. For a real device this equals .id; the package camera overrides
  // it to its parent's bare MAC, which DIVERGES from its suffixed .id. The MQTT delivery topics and mqttId scope under this bare MAC.
  public get mac(): string {

    return this.accessory.context.mac ?? "";
  }

  // Utility function to return the fully enumerated name of this device. The projection's name getter resolves config.name ?? config.displayName per the DeviceProjection
  // convention; we read it non-throwing through peek() so a vanished record (a device in the removal grace) falls back to the persisted MAC rather than throwing
  // into a detached firehose timer callback.
  public override get name(): string {

    const config = this.device.peek();

    return config?.name ?? config?.displayName ?? this.mac;
  }

  // The log-line prefix for a device, decorated with the model - "Name [Model]" - so every device-scoped line shows which hardware produced it. The format is
  // single-sourced through describeDevice (plain mode) reading the live projection, so a device rename reflects immediately; the functional `name` above is left bare and
  // untouched. We read non-throwing through peek() so a detached timer or removal log line on a vanished record falls back to the persisted MAC rather than throwing.
  protected override get logName(): string {

    const config = this.device.peek();

    return config ? describeDevice(config) : (this.accessory.context.mac ?? "Unknown");
  }

  // The debug scope for a device: its own MAC alongside the controller's, so a Log.Debug entry suffixed with this device turns on its debug lines alone while its
  // siblings stay quiet, and a controller-suffixed entry still reaches it. We read the public mac getter rather than the projection, which drops identity fields by
  // design, and the controller's mac through the NVR - a device exists only once the controller has bootstrapped, so both halves are always resolvable here.
  protected override get debugScope(): { controller?: string; device?: string } {

    return { controller: this.nvr.ufp.mac, device: this.mac };
  }

  // Utility function to return the current accessory name of this device. The AccessoryInformation Name characteristic is the primary source and is always present; the
  // secondary fallback reads the controller-side name non-throwing through peek() so a vanished record does not throw.
  public get accessoryName(): string {

    return (this.accessory.getService(this.hap.Service.AccessoryInformation)?.getCharacteristic(this.hap.Characteristic.Name).value as string | undefined) ??
      (this.device.peek()?.name ?? "Unknown");
  }

  // Utility function to set the current accessory name of this device.
  public set accessoryName(name: string) {

    setAccessoryName(this.accessory, name);
  }

  // Build the write-through command that sets this device's status indicator light. The command is returned as a thunk so the update is issued against a narrowed
  // projection: cameras, sensors, and relays all carry ledSettings.isEnabled, so the base serves them by narrowing this.device through its modelKey tag; the
  // light projection has no ledSettings and overrides this with its lightDeviceSettings command. Returning the thunk (rather than a bare payload) is what lets each
  // device kind issue a typed update against its own config - the base's device union, spanning every supported device kind, could not.
  protected statusLedCommand(value: boolean): () => Promise<unknown> {

    // The local is typed as the full category union rather than the generic parameter, because comparing the category tag narrows a union but cannot narrow a generic
    // parameter; widening once here is what lets the branch below read as the plain tag comparison it is.
    const device: ProtectProjectionMap[DeviceCollectionKey] = this.device;

    // Cameras, sensors, and relays share the ledSettings.isEnabled command; lights override this method. Chime and viewer projections expose no status indicator and
    // never reach here, so the fall-through is an inert no-op that keeps the signature total.
    if((device.modelKey === "camera") || (device.modelKey === "sensor") || (device.modelKey === "relay")) {

      return () => device.update({ ledSettings: { isEnabled: value } });
    }

    return () => Promise.resolve();
  }

  // Structural type guard for devices that have LED settings. We check structurally rather than by device type so that future devices with ledSettings are handled
  // automatically. This future-proofing covers only the read side backing the statusLed getter below; the write side, statusLedCommand, still gates on an explicit
  // modelKey allow-list, so a new device kind whose config carries ledSettings would read correctly here but silently no-op when someone tries to set it, until that
  // kind's modelKey is added to statusLedCommand's allow-list.
  private hasLedSettings(): this is { ufp: { ledSettings: { isEnabled: boolean } } } {

    const config = this.device.peek();

    return (config !== undefined) && ("ledSettings" in config);
  }

  // Utility function to return the current state of the device status indicator. This works for cameras, sensors, and relays, but Protect lights control it differently.
  public get statusLed(): boolean {

    if(!this.hasLedSettings()) {

      return false;
    }

    return this.ufp.ledSettings.isEnabled;
  }
}
