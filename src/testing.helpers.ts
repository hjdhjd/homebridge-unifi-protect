/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * testing.helpers.ts: Cross-cutting test helpers shared across every unit test in homebridge-unifi-protect.
 *
 * The plugin's production code reads and writes through Homebridge's HAP shapes (Service, Characteristic, Accessory) on every per-accessory configure path. We
 * never want a unit test to drag in the real homebridge package or stand up a live HAP runtime, so this file exposes a hand-built HAP test-double that mirrors
 * only the surface the plugin actually touches: Service identity and construction, Characteristic identity, getService / getServiceById / addService /
 * removeService / configureController on Accessory, getCharacteristic / updateCharacteristic / removeCharacteristic on Service, and onGet / onSet / value on
 * Characteristic.
 *
 * Alongside the HAP double, this file owns the reusable device-construction harness: a faithful double of the StateStore observe contract (TestStateStore),
 * typed builders for the camera and chime config records and the NVR / platform doubles, a read-through Camera projection double, and a stub
 * StreamingDelegateFactory that satisfies the platform's dependency-inversion seam so a REAL ProtectCamera - or a full doorbell-plus-package-camera family - can be
 * constructed end to end with no FFmpeg and no live HAP. The NVR double additionally mirrors the platform-accessory registration surface (a mutable accessories
 * array, the api registration recorders, a deterministic uuid generator) and the device-removal machinery (a mutable removalStable gate, recorded
 * scheduleDeviceRemoval timers a test fires manually, the presence-guarded removal tail), carries the REAL ProtectEventDispatch as its events member, and offers an
 * opt-in recording MQTT double so subscription-lifetime and publish assertions are possible. The doubles mirror contracts owned elsewhere - the observe semantics
 * are unifi-protect's (src/state/store.ts), the service/characteristic surface is HAP's as consumed by homebridge-plugin-utils' real service helpers, the removal
 * machinery is ProtectNvr's - and fidelity to those cited contracts, not invention, is the line this file holds.
 *
 * The surface is intentionally tight. The Service / Characteristic namespaces expand as the production code they exercise reaches for new kinds; adding a new
 * kind is a small constructible marker class plus an entry in the namespace object.
 *
 * Co-located with production code under src/, so the build type-checks this file alongside everything else and, today, compiles it into dist/ (the inherited
 * tsconfig carries no test or helper exclude, and the published package ships dist/ wholesale). Whether the compiled test rig should be pruned from the
 * published package is a publish-hygiene decision deliberately left out of scope here.
 */
import type { API, CameraController, HAP, Resolution } from "homebridge";
import type { AudioOptionsIdentity, StreamingDelegate, StreamingDelegateFactory } from "./media/stream-delegate.ts";
import { BOX_HEADER_SIZE, FeatureOptions, SAMPLE_FLAG_NON_SYNC, TRUN_FLAG_DATA_OFFSET, TRUN_FLAG_FIRST_SAMPLE_FLAGS, TestClock, TestRecordingProcessFactory }
  from "homebridge-plugin-utils";
import type { Camera, Chime, LivestreamSubscriptionState, PlaySpeakerOptions, ProtectCameraChannelConfig, ProtectCameraConfig, ProtectChimeConfig, ProtectEventMetadata,
  ProtectLightConfig, ProtectNvrConfig, ProtectNvrLiveviewConfig, ProtectRelayConfig, ProtectRingtoneConfig, ProtectSensorConfig, ProtectState, ProtectViewerConfig,
  Segment, Sensor, SnapshotOptions, TalkbackSession } from "unifi-protect";
import type { Clock, HomebridgePluginLogging, Nullable, RecordingProcessFactory } from "homebridge-plugin-utils";
import { FIXTURE_HOST, FIXTURE_RTSPS_PORT, G2_PRO_CHANNELS } from "./camera.fixtures.ts";
import type { NvrPhase, ProtectNvr } from "./nvr/nvr.ts";
import { PLATFORM_NAME, PLUGIN_NAME } from "./settings.ts";
import type { ProtectAccessory, ProtectDevices } from "./types.ts";
import type { ProtectNvrOptions, ProtectOptions } from "./options.ts";
import { featureOptionCategories, featureOptions } from "./options.ts";
import type { ChannelProfile } from "./media/resolution.ts";
import { DoorbellCapability } from "./devices/cameras/doorbell.ts";
import type { LivestreamSubscription } from "./media/livestream.ts";
import type { ProtectCamera } from "./devices/cameras/camera.ts";
import type { ProtectCameraHost } from "./media/camera-host.ts";
import { ProtectCameraPackage } from "./devices/cameras/camera-package.ts";
import { ProtectDevice } from "./devices/device.ts";
import { ProtectEventDispatch } from "./nvr/event-dispatch.ts";
import type { ProtectHints } from "./devices/device.ts";
import type { ProtectPlatform } from "./platform.ts";

// Identity class for a HAP Characteristic kind. Each characteristic kind is its own marker class; production code passes the class as a key to
// getCharacteristic / updateCharacteristic. Carries a hapKind instance property so test failures surface the kind directly in inspect output and so the class is
// meaningful enough to dodge the no-extraneous-class lint rule.
class OnCharacteristicType {

  public readonly hapKind = "On" as const;
}

class StatusActiveCharacteristicType {

  public readonly hapKind = "StatusActive" as const;
}

// The low-battery characteristic. The sensor's updateBatteryStatus writes StatusLowBattery onto the Battery service from batteryStatus.isLow; it is resolved on-demand
// from the namespace (not a service seed), so the kind must exist as a first-class key for that write to land on a distinct entry rather than collide on an undefined
// key.
class StatusLowBatteryCharacteristicType {

  public readonly hapKind = "StatusLowBattery" as const;
}

// The tamper-status characteristic. Added for the firehose tamper delivery and the sensor tamper push: the camera's tamperEventHandler and the sensor's tamper observer
// both write StatusTampered on a MotionSensor (and, for sensors, every state-bearing service), so an accessory carrying it exercises those reactions against the double.
class StatusTamperedCharacteristicType {

  public readonly hapKind = "StatusTampered" as const;
}

// The contact-sensor-state characteristic. Added for the auth-sensor delivery tests: the auth delivery trips the contact sensor between detected (resting / not
// authenticated) and not-detected (a recognized scan), so the double carries those two named states as statics, mirroring how real HAP exposes them as constructor
// constants.
class ContactSensorStateCharacteristicType {

  public static readonly CONTACT_DETECTED = 0;
  public static readonly CONTACT_NOT_DETECTED = 1;
  public readonly hapKind = "ContactSensorState" as const;
}

// The lock-state characteristics. The camera's UniFi Access lock writes both LockCurrentState and LockTargetState - the establishment stamp sets them SECURED at create
// or restart, and the LockTargetState onSet toggles each between SECURED and UNSECURED across a user unlock and its auto re-lock - so the double carries those two named
// states (the only ones the plugin reads) as statics on each marker, mirroring how real HAP exposes them as constructor constants.
class LockCurrentStateCharacteristicType {

  public static readonly SECURED = 1;
  public static readonly UNSECURED = 0;
  public readonly hapKind = "LockCurrentState" as const;
}

class LockTargetStateCharacteristicType {

  public static readonly SECURED = 1;
  public static readonly UNSECURED = 0;
  public readonly hapKind = "LockTargetState" as const;
}

/* The security-system state characteristics. The security-system owner reads the named arm states off these two characteristics on every state transition: the current
 * state carries five distinct values (the currentSecuritySystemState string map is keyed by them) and the target state carries four (the setProps validValues array
 * carries them, and the onSet maps a target to a current), so the double mirrors HAP's exact constants as statics on each marker. Distinct values are load-bearing -
 * a collision would collapse the Record<number, string> map and silently mis-key the MQTT state string. SecuritySystemCurrentState is also the seed characteristic the
 * SecuritySystem service marker constructs with (acquireService recovers the Characteristic constructor from the new service's first characteristic). The static members
 * are alphabetical per the house style; note the Current marker uses DISARMED=3 while the Target marker uses DISARM=3 - the same integer under two HAP-distinct names,
 * both of which the production code reaches by name.
 */
class SecuritySystemCurrentStateCharacteristicType {

  public static readonly ALARM_TRIGGERED = 4;
  public static readonly AWAY_ARM = 1;
  public static readonly DISARMED = 3;
  public static readonly NIGHT_ARM = 2;
  public static readonly STAY_ARM = 0;
  public readonly hapKind = "SecuritySystemCurrentState" as const;
}

class SecuritySystemTargetStateCharacteristicType {

  public static readonly AWAY_ARM = 1;
  public static readonly DISARM = 3;
  public static readonly NIGHT_ARM = 2;
  public static readonly STAY_ARM = 0;
  public readonly hapKind = "SecuritySystemTargetState" as const;
}

// The AccessoryInformation characteristics. Added for the camera-construction harness: ProtectBase.setInfo writes Manufacturer / Model / SerialNumber /
// FirmwareRevision onto the AccessoryInformation service at configure time, and the accessoryName getter reads the Name characteristic, so distinct kinds are
// required for each so the writes never collide on an undefined key.
class FirmwareRevisionCharacteristicType {

  public readonly hapKind = "FirmwareRevision" as const;
}

// The hardware-revision characteristic. The security-system owner's bespoke configureInfo writes HardwareRevision onto the AccessoryInformation service unconditionally
// (it bases it off nvr.ufp.hardwareRevision with no length guard), so the kind must be a distinct key for that write to land rather than collide on an undefined key.
// (ProtectBase.setInfo also writes it, but length-guarded behind a populated hardwareRevision the device-info concern net deliberately omits; the controller-owner net is
// the first to reach it.)
class HardwareRevisionCharacteristicType {

  public readonly hapKind = "HardwareRevision" as const;
}

class ManufacturerCharacteristicType {

  public readonly hapKind = "Manufacturer" as const;
}

class ModelCharacteristicType {

  public readonly hapKind = "Model" as const;
}

class NameCharacteristicType {

  public readonly hapKind = "Name" as const;
}

class SerialNumberCharacteristicType {

  public readonly hapKind = "SerialNumber" as const;
}

// The battery-level characteristic. The sensor's updateBatteryStatus writes BatteryLevel onto the Battery service from batteryStatus.percentage, and it is the seed
// characteristic the Battery service marker constructs with, so the kind must exist as a first-class key for the sensor family's real construction to reach it.
class BatteryLevelCharacteristicType {

  public readonly hapKind = "BatteryLevel" as const;
}

// The ambient-light characteristic. The sensor's ambient-light service binds onGet and pushes the current light level on CurrentAmbientLightLevel (with the 0.0001
// HomeKit floor), and it is the seed characteristic the LightSensor service marker constructs with, so the kind must be a distinct key for that path to read faithfully.
class CurrentAmbientLightLevelCharacteristicType {

  public readonly hapKind = "CurrentAmbientLightLevel" as const;
}

// The relative-humidity characteristic. The sensor's humidity service binds onGet and pushes the current humidity on CurrentRelativeHumidity (with the <0 floor), and it
// is the seed characteristic the HumiditySensor service marker constructs with, so the kind must be a distinct key for that path to read faithfully.
class CurrentRelativeHumidityCharacteristicType {

  public readonly hapKind = "CurrentRelativeHumidity" as const;
}

// The temperature characteristic. The sensor's temperature service binds onGet and pushes the current temperature on CurrentTemperature, and it is the seed
// characteristic the TemperatureSensor service marker constructs with, so the kind must be a distinct key for that path to read faithfully.
class CurrentTemperatureCharacteristicType {

  public readonly hapKind = "CurrentTemperature" as const;
}

// The leak-detected characteristic. The sensor's leak service binds onGet and pushes the leak state on LeakDetected, and it is the seed characteristic the LeakSensor
// service marker constructs with, so the kind must be a distinct key for that path to read faithfully.
class LeakDetectedCharacteristicType {

  public readonly hapKind = "LeakDetected" as const;
}

// The motion-detected characteristic. The camera's configureMotionSensor initializes MotionDetected to false on the motion service it acquires, and the motion
// delivery flips it, so the construction harness needs the kind as a first-class key (it is also the seed characteristic the MotionSensor marker constructs with).
class MotionDetectedCharacteristicType {

  public readonly hapKind = "MotionDetected" as const;
}

// The occupancy-detected characteristic. configureOccupancySensor initializes OccupancyDetected to false on the occupancy service it acquires (device.ts) and the
// occupancy MQTT getter reads it, so the kind must exist as a first-class key. device-motion is the first concern test to construct an occupancy sensor, so this is added
// here per the "expand as production reaches a new kind" pattern that grows MotionDetected and the rest above; before it the OccupancySensor service seeded the generic
// Name stand-in because OccupancyDetected was verified unreached.
class OccupancyDetectedCharacteristicType {

  public readonly hapKind = "OccupancyDetected" as const;
}

// The brightness characteristic. The doorbell's chime-volume Lightbulb and the camera's night-vision dimmer both bind onGet/onSet handlers and push updates on
// Brightness, so the kind must be a distinct key for those paths to exercise faithfully.
class BrightnessCharacteristicType {

  public readonly hapKind = "Brightness" as const;
}

// The camera-operating-mode characteristic pair. NightVision and CameraOperatingModeIndicator live on the SAME CameraOperatingMode service in production (the
// night-vision and status-indicator pushes), so without distinct keys the two writes would collide on one undefined-keyed entry and silently mask each other.
class CameraOperatingModeIndicatorCharacteristicType {

  public readonly hapKind = "CameraOperatingModeIndicator" as const;
}

class NightVisionCharacteristicType {

  public readonly hapKind = "NightVision" as const;
}

// The doorbell ring characteristic. The ring delivery fires sendEventNotification(SINGLE_PRESS) on the Doorbell service's ProgrammableSwitchEvent, so the marker
// carries the named press constant as a static, mirroring how real HAP exposes it as a constructor constant. It is also the Doorbell marker's seed characteristic.
class ProgrammableSwitchEventCharacteristicType {

  public static readonly SINGLE_PRESS = 0;
  public readonly hapKind = "ProgrammableSwitchEvent" as const;
}

// The HAP Characteristic namespace as the test-double exposes it. StatusActive is the load-bearing one...the isReachable rewire writes it across every device
// class, so the reachability tests pivot on this characteristic. On covers the toggle pair used by switches in the double's self-test. LockCurrentState /
// LockTargetState back the camera's UniFi Access lock onSet and the capability-reconcile lock self-heal tests. The AccessoryInformation kinds (Manufacturer / Model /
// SerialNumber / FirmwareRevision / Name) and MotionDetected back the real-construction harness; Brightness, NightVision, CameraOperatingModeIndicator, and
// ProgrammableSwitchEvent back the doorbell-family construction harness; OccupancyDetected backs the device-motion base-capability net, where configureOccupancySensor
// first reaches it. BatteryLevel / StatusLowBattery
// (the battery service updater) and CurrentAmbientLightLevel / CurrentRelativeHumidity / CurrentTemperature / LeakDetected (the sensor's per-mode services) back the
// sensor-family real-construction net, where ProtectSensor first reaches them. SecuritySystemCurrentState / SecuritySystemTargetState (the security-system state machine,
// the Current marker also the SecuritySystem service's seed) and HardwareRevision (the security-system's bespoke configureInfo) back the controller-owner net, where
// ProtectSecuritySystem first reaches them. Expand as the production code reaches for new kinds.
export const Characteristic = {

  BatteryLevel: BatteryLevelCharacteristicType,
  Brightness: BrightnessCharacteristicType,
  CameraOperatingModeIndicator: CameraOperatingModeIndicatorCharacteristicType,
  ContactSensorState: ContactSensorStateCharacteristicType,
  CurrentAmbientLightLevel: CurrentAmbientLightLevelCharacteristicType,
  CurrentRelativeHumidity: CurrentRelativeHumidityCharacteristicType,
  CurrentTemperature: CurrentTemperatureCharacteristicType,
  FirmwareRevision: FirmwareRevisionCharacteristicType,
  HardwareRevision: HardwareRevisionCharacteristicType,
  LeakDetected: LeakDetectedCharacteristicType,
  LockCurrentState: LockCurrentStateCharacteristicType,
  LockTargetState: LockTargetStateCharacteristicType,
  Manufacturer: ManufacturerCharacteristicType,
  Model: ModelCharacteristicType,
  MotionDetected: MotionDetectedCharacteristicType,
  Name: NameCharacteristicType,
  NightVision: NightVisionCharacteristicType,
  OccupancyDetected: OccupancyDetectedCharacteristicType,
  On: OnCharacteristicType,
  ProgrammableSwitchEvent: ProgrammableSwitchEventCharacteristicType,
  SecuritySystemCurrentState: SecuritySystemCurrentStateCharacteristicType,
  SecuritySystemTargetState: SecuritySystemTargetStateCharacteristicType,
  SerialNumber: SerialNumberCharacteristicType,
  StatusActive: StatusActiveCharacteristicType,
  StatusLowBattery: StatusLowBatteryCharacteristicType,
  StatusTampered: StatusTamperedCharacteristicType
} as const;

// Shorthand for the constructor-as-key shape both Service and Characteristic expose. We use the class itself (not an instance) as the Map key throughout, so
// these are constructor types whose argument list is intentionally permissive...the marker classes take no arguments (or, for the constructible service markers,
// the HAP (displayName?, subtype?) pair), and we want the alias to admit either.
export type ServiceType = abstract new (...args: never[]) => object;
export type CharacteristicType = abstract new (...args: never[]) => object;

// The props object production passes to Characteristic.setProps - the security-system owner narrows SecuritySystemTargetState's validValues this way. validValues is the
// only field the plugin sets and the only one a test asserts; the open index signature mirrors HAP's far wider PartialAllowingNull<CharacteristicProps> surface so any
// other prop production might set still type-checks at the call site. A named interface (not an inline intersection) keeps the field and the setProps parameter one
// source and reads cleanly under the house no-property-access-from-index-signature rule, where the explicitly-declared validValues stays dot-accessible.
export interface TestCharacteristicProps extends Record<string, unknown> {

  validValues?: number[];
}

// One characteristic backing instance, owned by a TestService. Holds the last value written, plus the optional onGet / onSet handlers production code installs.
// triggerGet / triggerSet are the test-side knobs that exercise the bound handlers without going through a real HAP request path.
export class TestCharacteristic {

  public readonly type: CharacteristicType;
  // The event-notification log, mirroring HAP's sendEventNotification semantics: an event is a transient occurrence pushed to subscribers (the doorbell ring's
  // SINGLE_PRESS), recorded in order here, and it deliberately never changes the characteristic's cached value.
  public readonly events: unknown[] = [];
  // The last props object production set via setProps, captured so a test can assert the security-system owner's updateDevice narrowed the target state's validValues.
  // Undefined until production calls setProps; a silent no-op double would make the arm-states reconcile net vacuous.
  public props: TestCharacteristicProps | undefined = undefined;
  private currentValue: unknown = null;
  private getHandler: (() => unknown) | undefined = undefined;
  private setHandler: ((value: unknown) => void | Promise<void>) | undefined = undefined;

  public constructor(type: CharacteristicType) {

    this.type = type;
  }

  // The most recently written value. Production code reads this after updateCharacteristic to confirm its own write landed.
  public get value(): unknown {

    return this.currentValue;
  }

  // Write a value into the characteristic. Returns this so it chains in the production-typical "service.updateCharacteristic(...)" pattern.
  public updateValue(value: unknown): this {

    this.currentValue = value;

    return this;
  }

  // Record the props production set on this characteristic, mirroring HAP's Characteristic.setProps, which returns the characteristic so production chains it off
  // getCharacteristic (the security-system owner's updateDevice narrows SecuritySystemTargetState's validValues this way). The double captures the last props object so
  // a test can assert the exact validValues array landed; the recordable-double discipline (capture-then-return-this) mirrors onSet / updateValue.
  public setProps(props: TestCharacteristicProps): this {

    this.props = props;

    return this;
  }

  // Install the production read handler. Tests inspect what was bound via triggerGet; the handler itself stays opaque to the test surface.
  public onGet(handler: () => unknown): this {

    this.getHandler = handler;

    return this;
  }

  // Install the production write handler. Tests drive it via triggerSet; the production code's handler runs as if HomeKit invoked it.
  public onSet(handler: (value: unknown) => void | Promise<void>): this {

    this.setHandler = handler;

    return this;
  }

  // Record an event notification, mirroring HAP's transient-event push (the doorbell ring delivery). The cached value is deliberately untouched - events are not
  // state writes in HAP, and a test asserting .value after a ring must see whatever was last written, not the press constant.
  public sendEventNotification(value: unknown): void {

    this.events.push(value);
  }

  // Test-side trigger for the installed onGet handler. Falls through to the last-written value when no handler is bound, matching HAP's read-from-cache
  // semantics when the production code never installs a custom getter.
  public async triggerGet(): Promise<unknown> {

    if(!this.getHandler) {

      return this.currentValue;
    }

    return this.getHandler();
  }

  // Test-side trigger for the installed onSet handler. After the handler resolves, the supplied value becomes the new cached value, mirroring HAP's behavior
  // where a successful set updates the characteristic's read cache.
  public async triggerSet(value: unknown): Promise<void> {

    if(this.setHandler) {

      await this.setHandler(value);
    }

    this.currentValue = value;
  }
}

/* One service instance attached to a TestAccessory. Holds a Map of characteristic-kind -> TestCharacteristic so getCharacteristic returns the same instance
 * across calls...production code binds onGet once and expects the binding to stay attached on the next read.
 *
 * Two pieces of this shape are dictated by homebridge-plugin-utils' REAL service helpers, which run unmodified against the double on the construction paths:
 *
 * - characteristics is a PUBLIC ARRAY view (the Map stays private backing), because acquireService's getCharacteristicConstructor destructures the first element
 *   of service.characteristics to recover the Characteristic constructor - and throws when no first element exists, which is why the constructible service
 *   markers below seed one characteristic at construction.
 *
 * - displayName is MUTABLE, because setServiceName assigns it on every acquire.
 *
 * UUID is the kind's identity string, mirrored from the marker class's static (see the UUID getter below). It must NEVER resolve to the empty string: the real
 * helpers' name-set predicates (serviceHasName and friends) build their sets from static properties the marker classes do not carry, so every set degenerates to
 * containing only the empty string - and a service whose UUID resolved to "" would false-positive into setServiceName's ConfiguredName / Name writes against
 * undefined characteristic statics, silently polluting the double with undefined-keyed characteristics. Non-empty kind strings keep every degenerate predicate
 * honestly false, while giving production code that matches services by identity (the doorbell's validateMessageSwitches compares service.UUID against
 * Service.Switch.UUID) real, distinct identities to match on.
 */
export class TestService {

  public readonly type: ServiceType;
  public displayName: string;
  // Whether production marked this the accessory's primary service (the camera's configureDoorbellService does), recorded by setPrimaryService below.
  public isPrimary = false;
  public readonly subtype: string | undefined;
  private readonly characteristicsByType = new Map<CharacteristicType, TestCharacteristic>();

  public constructor(type: ServiceType, displayName: string, subtype: string | undefined) {

    this.type = type;
    this.displayName = displayName;
    this.subtype = subtype;
  }

  // The service kind's identity string, mirrored from the TYPE's static. this.type is the marker class on BOTH construction paths - the marker constructors pass
  // their own class and the legacy addService(type, ...) form passes the namespace entry - whereas this.constructor is the bare TestService on the legacy path and
  // carries no static. Real HAP identifies kinds by UUID; the double uses the kind string, which is just as unique within the namespace and far more legible in
  // assertion failures. The fallback is a non-empty sentinel for a hand-rolled type outside the namespace, preserving the never-empty invariant documented above.
  public get UUID(): string {

    return (this.type as { UUID?: string }).UUID ?? "unidentified-service-kind";
  }

  // Record whether production designated this service as the accessory's primary service, mirroring HAP's Service.setPrimaryService.
  public setPrimaryService(isPrimary = true): void {

    this.isPrimary = isPrimary;
  }

  // The public array view of the materialized characteristics, mirroring HAP's Service.characteristics surface. Order is insertion order, so a marker's seed
  // characteristic is always the first element - exactly what the real getCharacteristicConstructor destructures.
  public get characteristics(): TestCharacteristic[] {

    return [...this.characteristicsByType.values()];
  }

  // Fetch or lazily create the characteristic of the given kind. Lazy creation matches HAP, which instantiates required characteristics on first access.
  public getCharacteristic(charType: CharacteristicType): TestCharacteristic {

    let char = this.characteristicsByType.get(charType);

    if(!char) {

      char = new TestCharacteristic(charType);
      this.characteristicsByType.set(charType, char);
    }

    return char;
  }

  // Write a value to the characteristic of the given kind. Returns this so production code's chained updates compile.
  public updateCharacteristic(charType: CharacteristicType, value: unknown): this {

    this.getCharacteristic(charType).updateValue(value);

    return this;
  }

  // Mirror HAP's Service.setCharacteristic(type, value), which routes to Characteristic.setValue and therefore FIRES the bound onSet handler - the path the
  // production MQTT subscribeSet handlers use to drive a device command through HomeKit's own set machinery. This is deliberately distinct from
  // updateCharacteristic above, which is a status push (updateValue) that does NOT run the handler. The handler is fired and not awaited, mirroring HAP's
  // synchronous, fire-and-forget setCharacteristic; a rejection is swallowed because HAP does not surface the set-handler's failure to the setCharacteristic caller
  // (the device handlers route through runDeviceCommand and resolve rather than throw, so this catch is the faithful-and-robust belt, not a masked error). A test
  // settles past one tick to let the handler run, then asserts the effect; triggerSet caches the value after the handler resolves, so the read cache stays correct.
  public setCharacteristic(charType: CharacteristicType, value: unknown): this {

    void this.getCharacteristic(charType).triggerSet(value).catch((): void => { /* HAP does not surface the set-handler's rejection to the caller. */ });

    return this;
  }

  // Declare an optional characteristic on this service, mirroring HAP's Service.addOptionalCharacteristic. The camera's configureAmbientLightSensor acquire initializer
  // takes this path directly (it permits StatusActive on the LightSensor before binding its onGet), a seam no other construction path reaches - the real acquireService's
  // own addOptionalCharacteristic calls for ConfiguredName / Name stay gated off the markers by the degenerate name-set predicates (see the class doc). HAP lazily
  // materializes a permitted characteristic on first access, so the double materializes it now through getCharacteristic, keeping the later getCharacteristic / onGet
  // bind against the SAME instance and never throwing on the direct call.
  public addOptionalCharacteristic(charType: CharacteristicType): void {

    this.getCharacteristic(charType);
  }

  // Report whether the characteristic of the given kind has already been created on this service. Mirrors HAP's Service.testCharacteristic, which the production
  // reachability fan-out (ProtectDevice.refreshReachability) calls to decide whether a service carries StatusActive before writing it. Unlike getCharacteristic, this
  // never lazily creates the characteristic - it is a pure predicate over what has already been added.
  public testCharacteristic(charType: CharacteristicType): boolean {

    return this.characteristicsByType.has(charType);
  }

  // Remove a characteristic instance from this service, mirroring HAP's Service.removeCharacteristic. The camera's configureTamperDetection takes this path only to prune
  // an existing StatusTampered when tamper detection is turned off: it reads prior existence side-effect-free through testCharacteristic, so it never materializes the
  // characteristic just to remove it. The double keys one instance per kind, so removal by the instance's kind is exact.
  public removeCharacteristic(characteristic: TestCharacteristic): void {

    this.characteristicsByType.delete(characteristic.type);
  }
}

/* Identity class for a HAP Service kind. HAP exposes each service kind (MotionSensor, OccupancySensor, Switch, ...) as a distinct constructor; production code
 * passes that constructor as a key into accessory.getService / addService and into service.getCharacteristic. We mirror that contract with one marker class per
 * kind, exposed through the Service namespace below.
 *
 * Each marker is a CONSTRUCTIBLE subclass of TestService carrying HAP's (displayName?, subtype?) constructor, because homebridge-plugin-utils' real acquireService
 * instantiates the namespace entry directly on its create branch - "new serviceType(name, subtype)" - and then immediately recovers the Characteristic constructor
 * from the new service's first characteristic. Every marker therefore seeds exactly one characteristic at construction: the kind's primary required characteristic
 * where the namespace already carries it (MotionDetected for MotionSensor, On for Switch and Lightbulb, Name for AccessoryInformation, ContactSensorState for
 * ContactSensor, LockCurrentState for LockMechanism, ProgrammableSwitchEvent for Doorbell), and Name as the documented generic stand-in for kinds whose required
 * characteristic is not in the namespace yet (the seed exists to satisfy getCharacteristicConstructor; it upgrades to the kind-true characteristic when a test
 * first exercises that kind). The seed applies ONLY when a marker is constructed - the legacy addService(type, name?, subtype?) form still produces a plain,
 * characteristic-empty TestService, which existing tests rely on. Each marker carries its hapKind property so test failures surface the kind directly in inspect
 * output, plus a static UUID (the kind string) that the TestService instance UUID mirrors - real, distinct, never-empty identities for production code that
 * matches services by UUID (see the TestService doc comment for why empty would be hazardous).
 */
class AccessoryInformationServiceType extends TestService {

  public static readonly UUID = "AccessoryInformation";
  public readonly hapKind = "AccessoryInformation" as const;

  public constructor(displayName = "", subtype?: string) {

    super(AccessoryInformationServiceType, displayName, subtype);

    this.getCharacteristic(NameCharacteristicType);
  }
}

// The battery kind. Added for the sensor-family real-construction net: ProtectSensor.configureBatteryService unconditionally acquires a Battery service and
// updateBatteryStatus writes its BatteryLevel / StatusLowBattery, so the kind must exist as a distinct key. Seeds its primary BatteryLevel characteristic.
class BatteryServiceType extends TestService {

  public static readonly UUID = "Battery";
  public readonly hapKind = "Battery" as const;

  public constructor(displayName = "", subtype?: string) {

    super(BatteryServiceType, displayName, subtype);

    this.getCharacteristic(BatteryLevelCharacteristicType);
  }
}

// The camera-operating-mode kind. Added for the camera-construction harness: configureCameraDetails and the per-field camera updaters resolve it by key (and
// no-op through optional chains when absent), so the kind must exist as a distinct key. Its HAP-required characteristics are not in the namespace, so it seeds the
// generic Name stand-in.
class CameraOperatingModeServiceType extends TestService {

  public static readonly UUID = "CameraOperatingMode";
  public readonly hapKind = "CameraOperatingMode" as const;

  public constructor(displayName = "", subtype?: string) {

    super(CameraOperatingModeServiceType, displayName, subtype);

    this.getCharacteristic(NameCharacteristicType);
  }
}

// The contact-sensor kind. Added for the auth-sensor delivery tests: the firehose router's authEventHandler resolves an "Auth"-subtyped ContactSensor service and writes
// its ContactSensorState on a recognized fingerprint/NFC scan, so an accessory carrying one exercises the real auth trip/reset path.
class ContactSensorServiceType extends TestService {

  public static readonly UUID = "ContactSensor";
  public readonly hapKind = "ContactSensor" as const;

  public constructor(displayName = "", subtype?: string) {

    super(ContactSensorServiceType, displayName, subtype);

    this.getCharacteristic(ContactSensorStateCharacteristicType);
  }
}

// The doorbell kind. Added for the camera-construction harness: configureDoorbellTrigger reads accessory.getService(Service.Doorbell) unconditionally, so the kind
// must exist as a distinct key. Seeds its HAP-required ProgrammableSwitchEvent characteristic, which the ring delivery fires event notifications on.
class DoorbellServiceType extends TestService {

  public static readonly UUID = "Doorbell";
  public readonly hapKind = "Doorbell" as const;

  public constructor(displayName = "", subtype?: string) {

    super(DoorbellServiceType, displayName, subtype);

    this.getCharacteristic(ProgrammableSwitchEventCharacteristicType);
  }
}

// The humidity-sensor kind. Added for the sensor-family real-construction net: ProtectSensor.configureHumiditySensor acquires a HumiditySensor service when humidity is
// enabled, binds onGet, and pushes CurrentRelativeHumidity, so the kind must exist as a distinct key. Seeds its primary CurrentRelativeHumidity characteristic.
class HumiditySensorServiceType extends TestService {

  public static readonly UUID = "HumiditySensor";
  public readonly hapKind = "HumiditySensor" as const;

  public constructor(displayName = "", subtype?: string) {

    super(HumiditySensorServiceType, displayName, subtype);

    this.getCharacteristic(CurrentRelativeHumidityCharacteristicType);
  }
}

// The leak-sensor kind. Added for the sensor-family real-construction net: ProtectSensor.configureLeakSensor acquires LeakSensor services (internal / external subtypes)
// in the default leak mode, binds onGet, and pushes LeakDetected, so the kind must exist as a distinct key. Seeds its primary LeakDetected characteristic.
class LeakSensorServiceType extends TestService {

  public static readonly UUID = "LeakSensor";
  public readonly hapKind = "LeakSensor" as const;

  public constructor(displayName = "", subtype?: string) {

    super(LeakSensorServiceType, displayName, subtype);

    this.getCharacteristic(LeakDetectedCharacteristicType);
  }
}

// The light-sensor kind. Added for the sensor-family real-construction net: ProtectSensor.configureAmbientLightSensor acquires a LightSensor service when ambient light
// is enabled, binds onGet, and pushes CurrentAmbientLightLevel, so the kind must exist as a distinct key. Seeds its primary CurrentAmbientLightLevel characteristic.
class LightSensorServiceType extends TestService {

  public static readonly UUID = "LightSensor";
  public readonly hapKind = "LightSensor" as const;

  public constructor(displayName = "", subtype?: string) {

    super(LightSensorServiceType, displayName, subtype);

    this.getCharacteristic(CurrentAmbientLightLevelCharacteristicType);
  }
}

// The lightbulb kind. Added for the camera-construction harness: configureNightVisionDimmer validates a Lightbulb service by key (a no-op at defaults), so the
// kind must exist as a distinct key.
class LightbulbServiceType extends TestService {

  public static readonly UUID = "Lightbulb";
  public readonly hapKind = "Lightbulb" as const;

  public constructor(displayName = "", subtype?: string) {

    super(LightbulbServiceType, displayName, subtype);

    this.getCharacteristic(OnCharacteristicType);
  }
}

// The lock-mechanism kind. The camera's configureAccessFeatures acquires an "Access"-subtyped LockMechanism service and the capability-reconcile suite drives its
// LockTargetState onSet and self-heals it from a late supportUnlock, so an accessory carrying one exercises the real unlock / re-secure / establishment-stamp path.
class LockMechanismServiceType extends TestService {

  public static readonly UUID = "LockMechanism";
  public readonly hapKind = "LockMechanism" as const;

  public constructor(displayName = "", subtype?: string) {

    super(LockMechanismServiceType, displayName, subtype);

    this.getCharacteristic(LockCurrentStateCharacteristicType);
  }
}

class MotionSensorServiceType extends TestService {

  public static readonly UUID = "MotionSensor";
  public readonly hapKind = "MotionSensor" as const;

  public constructor(displayName = "", subtype?: string) {

    super(MotionSensorServiceType, displayName, subtype);

    this.getCharacteristic(MotionDetectedCharacteristicType);
  }
}

// The occupancy sensor kind. The service constructs with its kind-true OccupancyDetected characteristic because production's configureOccupancySensor initializes
// OccupancyDetected to false on the occupancy service it acquires, exactly as the marker doc comment describes.
class OccupancySensorServiceType extends TestService {

  public static readonly UUID = "OccupancySensor";
  public readonly hapKind = "OccupancySensor" as const;

  public constructor(displayName = "", subtype?: string) {

    super(OccupancySensorServiceType, displayName, subtype);

    this.getCharacteristic(OccupancyDetectedCharacteristicType);
  }
}

// The security-system kind. Added for the controller-owner net: ProtectSecuritySystem.configureSecuritySystem acquires a SecuritySystem service (else construction
// throws at acquireService), reads/writes its SecuritySystemCurrentState / SecuritySystemTargetState, and updateDevice sets the target's validValues, so the kind must
// exist as a distinct key. Seeds its primary SecuritySystemCurrentState characteristic so the real acquireService recovers the Characteristic constructor from the new
// service's first characteristic, the Battery / sensor precedent.
class SecuritySystemServiceType extends TestService {

  public static readonly UUID = "SecuritySystem";
  public readonly hapKind = "SecuritySystem" as const;

  public constructor(displayName = "", subtype?: string) {

    super(SecuritySystemServiceType, displayName, subtype);

    this.getCharacteristic(SecuritySystemCurrentStateCharacteristicType);
  }
}

class SwitchServiceType extends TestService {

  public static readonly UUID = "Switch";
  public readonly hapKind = "Switch" as const;

  public constructor(displayName = "", subtype?: string) {

    super(SwitchServiceType, displayName, subtype);

    this.getCharacteristic(OnCharacteristicType);
  }
}

// The temperature-sensor kind. Added for the sensor-family real-construction net: ProtectSensor.configureTemperatureSensor acquires a TemperatureSensor service when
// temperature is enabled, binds onGet, and pushes CurrentTemperature, so the kind must exist as a distinct key. Seeds its primary CurrentTemperature characteristic.
class TemperatureSensorServiceType extends TestService {

  public static readonly UUID = "TemperatureSensor";
  public readonly hapKind = "TemperatureSensor" as const;

  public constructor(displayName = "", subtype?: string) {

    super(TemperatureSensorServiceType, displayName, subtype);

    this.getCharacteristic(CurrentTemperatureCharacteristicType);
  }
}

// The HAP Service namespace as the test-double exposes it. Add new kinds here when a test reaches for one the production code touches. Alphabetical, per the
// house style for object property order.
export const Service = {

  AccessoryInformation: AccessoryInformationServiceType,
  Battery: BatteryServiceType,
  CameraOperatingMode: CameraOperatingModeServiceType,
  ContactSensor: ContactSensorServiceType,
  Doorbell: DoorbellServiceType,
  HumiditySensor: HumiditySensorServiceType,
  LeakSensor: LeakSensorServiceType,
  LightSensor: LightSensorServiceType,
  Lightbulb: LightbulbServiceType,
  LockMechanism: LockMechanismServiceType,
  MotionSensor: MotionSensorServiceType,
  OccupancySensor: OccupancySensorServiceType,
  SecuritySystem: SecuritySystemServiceType,
  Switch: SwitchServiceType,
  TemperatureSensor: TemperatureSensorServiceType
} as const;

/* One accessory. Carries an AccessoryInformation service from construction (every HomeKit accessory has one); subsequent addService calls append additional
 * services. getService / getServiceById mirror HAP's distinction between "the bare service of this type" and "the service of this type with a specific subtype".
 *
 * The construction-harness growth: a mutable context record (the camera's configureDevice reassigns it wholesale, then writes keys), the ordered controller-event
 * log with HAP's one-controller-per-accessory invariant enforced (the double records identity and order, and never operates on the controller's innards),
 * removeService (the faithful removal homebridge-plugin-utils' validService performs when an existing service fails validation), and the _associatedHAPAccessory
 * mirror with a mutable displayName (the accessoryName setter writes both) plus the bridged flag the NVR's removal tail gates its unregister on - true by default
 * (a registered or restored accessory is bridged), flipped false by the platform double's publishExternalAccessories recorder, exactly as standalone publication
 * leaves a real accessory unbridged.
 */
export class TestAccessory {

  public context: Record<string, unknown> = {};
  public displayName: string;
  public readonly UUID: string;
  // Exposed so production code that iterates every service on the accessory (ProtectDevice.refreshReachability walks accessory.services) sees the same surface HAP's
  // PlatformAccessory.services offers.
  public readonly services: TestService[] = [];
  // The ordered controller-event log: every configureController / removeController call in arrival order, each stamped with its sequence number, so a test can
  // assert not just identity and count but ordering across a configure / remove / re-configure lifecycle.
  public readonly controllerEvents: { controller: unknown; kind: "configure" | "remove"; seq: number }[] = [];
  // The single configured controller - the chokepoint mirroring HAP's one-camera-controller-per-accessory registry, which throws on a same-id double configure.
  public configuredController: Nullable<unknown> = null;
  // The internal HAP accessory mirror the accessoryName setter writes alongside the platform accessory's own displayName, carrying the bridged flag production's
  // removal tail reads.
  public readonly _associatedHAPAccessory: { bridged: boolean; displayName: string };

  public constructor(displayName: string, uuid: string) {

    this.displayName = displayName;
    this.UUID = uuid;
    this._associatedHAPAccessory = { bridged: true, displayName };
    this.services.push(new TestService(Service.AccessoryInformation, displayName, undefined));
  }

  // The configure-side view of the controller-event log, derived so existing identity-and-count assertions keep working against the unified ordered log.
  public get configureControllerCalls(): unknown[] {

    return this.controllerEvents.filter((event) => event.kind === "configure").map((event) => event.controller);
  }

  // The remove-side view of the controller-event log, derived for the same reason.
  public get removeControllerCalls(): unknown[] {

    return this.controllerEvents.filter((event) => event.kind === "remove").map((event) => event.controller);
  }

  /* Add a new service to the accessory, in either of the two forms HAP's real addService accepts: a service INSTANCE (what acquireService passes after
   * constructing a namespace marker), or the legacy (type, name?, subtype?) form, which keeps its exact original semantics - a plain TestService with no seeded
   * characteristic - so existing tests that assert on freshly-added services being characteristic-empty stay valid. The instanceof discrimination is sound
   * because a marker CLASS (a constructor object) is never an instance of TestService - only constructed services are. Returns the service so production code can
   * immediately bind characteristics on it.
   */
  public addService(service: TestService): TestService;
  public addService(type: ServiceType, name?: string, subtype?: string): TestService;
  public addService(typeOrService: ServiceType | TestService, name?: string, subtype?: string): TestService {

    const service = (typeOrService instanceof TestService) ? typeOrService : new TestService(typeOrService, name ?? this.displayName, subtype);

    this.services.push(service);

    return service;
  }

  // Record a controller registration. HAP permits exactly one camera controller per accessory and throws on a same-id double configure (hap-nodejs
  // Accessory.configureController); the double enforces the same invariant through the configuredController chokepoint, so a production path that double-registers
  // fails a test as loudly as it would fail live.
  public configureController(controller: unknown): void {

    if(this.configuredController !== null) {

      throw new Error("A controller was already added to the accessory " + this.displayName + ".");
    }

    this.configuredController = controller;
    this.controllerEvents.push({ controller: controller, kind: "configure", seq: this.controllerEvents.length });
  }

  // Record a controller removal, the cleanup-side mirror of configureController. Removing the configured controller clears the chokepoint, mirroring HAP's registry
  // delete, so a later re-configure succeeds exactly as it would live.
  public removeController(controller: unknown): void {

    this.controllerEvents.push({ controller: controller, kind: "remove", seq: this.controllerEvents.length });

    if(this.configuredController === controller) {

      this.configuredController = null;
    }
  }

  // Find the first service of the given type with no subtype. Production code uses this for the "primary" service of a type.
  public getService(type: ServiceType): TestService | undefined {

    return this.services.find((service) => (service.type === type) && (service.subtype === undefined));
  }

  // Find the service of the given type AND subtype. Production code uses subtypes to disambiguate among multiple Switch services on one accessory.
  public getServiceById(type: ServiceType, subtype: string): TestService | undefined {

    return this.services.find((service) => (service.type === type) && (service.subtype === subtype));
  }

  // Remove a service instance from the accessory, mirroring HAP's PlatformAccessory.removeService. This is the removal path homebridge-plugin-utils' validService
  // takes when an existing service fails validation, and the camera's smart-detect sensor pruning calls it directly.
  public removeService(service: TestService): void {

    const index = this.services.indexOf(service);

    if(index !== -1) {

      this.services.splice(index, 1);
    }
  }
}

/**
 * Build a TestAccessory with a sensible default name and UUID. Pass overrides when a test needs a specific identity (for example, comparing two accessories by
 * UUID to verify a routing decision).
 *
 * @param displayName - the accessory's display name. Defaults to "Test Accessory".
 * @param uuid        - the accessory's UUID. Defaults to a stable all-zero value so tests get reproducible identity by default.
 *
 * @returns a fresh TestAccessory pre-populated with an AccessoryInformation service.
 */
export function makeTestAccessory(displayName = "Test Accessory", uuid = "00000000-0000-0000-0000-000000000000"): TestAccessory {

  return new TestAccessory(displayName, uuid);
}

/* One consumer's live view of a selector over the store double - a faithful mirror of unifi-protect's StateObserver (src/state/store.ts), where the load-bearing
 * observe mechanics live. The pinned semantics, each mirrored deliberately: the baseline is seeded from the state at iteration start (observers never fire at
 * subscription - they yield only on a later change); dedup happens at ENQUEUE time against the last ENQUEUED value, so a parked consumer facing pushes A then B
 * then A receives B then A; the queue is unbounded and in-order (no conflation, no latest-value-only); close is drain-then-close (already-queued values still
 * yield before the iterator returns - exactly what the production trailing-yield guard exists for); and the parked iterator wakes through Promise.withResolvers,
 * never a timer, so wakes resolve through the microtask queue and the tests' settle-tick discipline stays deterministic.
 */
class TestStateObserver<T> {

  private closed = false;
  private lastEnqueued: T;
  private queue: T[] = [];
  private readonly selector: (state: ProtectState) => T;
  private wake: (() => void) | null = null;

  constructor(selector: (state: ProtectState) => T, initialState: ProtectState) {

    this.selector = selector;

    // Seed the baseline from the state at iteration time, so the observer yields on the first subsequent change rather than re-emitting the current value (which
    // the consumer already has via snapshot()). This is the "yields when X changes" contract.
    this.lastEnqueued = selector(initialState);
  }

  // Called by the store on every committed push. Re-run the selector against the new state; enqueue (and wake any parked iterator) only when the derived value is
  // a different reference than the one last enqueued.
  public evaluate(state: ProtectState): void {

    const next = this.selector(state);

    if(Object.is(next, this.lastEnqueued)) {

      return;
    }

    this.lastEnqueued = next;
    this.queue.push(next);
    this.signal();
  }

  // Terminate the iteration. The iterator drains whatever is already queued, then returns.
  public close(): void {

    this.closed = true;
    this.signal();
  }

  // The async iteration itself. Drains the queue in batches (swapping in a fresh array so values arriving mid-yield are picked up on the next pass), then parks on
  // a Promise.withResolvers() until the next evaluate / close wakes it. No timers, no EventEmitter, no listener bookkeeping - mirroring the real iterate exactly.
  public async *iterate(): AsyncGenerator<T> {

    for(;;) {

      if(this.queue.length > 0) {

        const batch = this.queue;

        this.queue = [];

        for(const value of batch) {

          yield value;
        }

        continue;
      }

      if(this.closed) {

        return;
      }

      const { promise, resolve } = Promise.withResolvers<undefined>();

      // The wake is a zero-argument signal; we close over the resolver so the queue-side signal never needs to know the gate carries an (ignored) value.
      this.wake = (): void => resolve(undefined);

      // Parking on the next signal is the whole point of this loop - the await is intentional and sequential, not an accidental serialization of independent work.
      // eslint-disable-next-line no-await-in-loop
      await promise;
    }
  }

  // Wake a parked iterator exactly once. A no-op when the iterator is mid-drain (no resolver registered), because it will re-check the queue on its next pass anyway.
  private signal(): void {

    const wake = this.wake;

    this.wake = null;
    wake?.();
  }
}

/* A faithful test double of the StateStore observe contract. The real StateStore is a type-only export, constructed solely by ProtectClient.connect(), so a
 * test cannot stand one up - this double implements the documented contract instead, mirroring both halves of the real implementation: the observe() wrapper
 * (lazy registration when iteration begins, the already-aborted check inside the generator body, abort wired to a drain-then-close, deregistration in the
 * generator's finally on ANY exit - abort, break, or return) and the StateObserver mechanics (see TestStateObserver above).
 *
 * Test-side knobs beyond the production surface: push commits a new state and notifies every registered observer (each observer's own reference dedup decides
 * whether it actually wakes, exactly as the real dispatch's notify does); pushCameraPatch is the structural-sharing push helper that replaces ONLY the targeted
 * camera record - the patched record spread-shares every untouched field and every other state slice keeps its reference, mirroring the real reducer's structural
 * sharing so exactly the observers watching the patched fields wake; and observerCount derives from the registration set itself (never a close-side decrement),
 * so a leaked or hung iterator keeps the count nonzero and teardown assertions stay meaningful.
 */
export class TestStateStore {

  private readonly observers = new Set<TestStateObserver<unknown>>();
  private state: ProtectState;

  public constructor(initialState: ProtectState) {

    this.state = initialState;
  }

  // The number of currently registered observers, derived from the registration set. Fourteen after a minimal camera construction settles (the two base observers plus
  // the camera's twelve); zero after cleanup.
  public get observerCount(): number {

    return this.observers.size;
  }

  // The current state - the same synchronous read surface production code calls as client.state.snapshot().
  public snapshot(): ProtectState {

    return this.state;
  }

  // Commit a new state and notify every registered observer. Each observer re-runs its selector and enqueues only on a reference change, so a push that left a
  // slice untouched never wakes that slice's consumer.
  public push(next: ProtectState): void {

    this.state = next;

    for(const observer of this.observers) {

      observer.evaluate(next);
    }
  }

  // The structural-sharing push helper: replace only the targeted camera record, spread-sharing its untouched fields, while every other slice of the state keeps
  // its reference. This mirrors the real reducer's structural sharing, which is what makes the narrow observers' Object.is dedup meaningful - a test push that
  // rebuilt every slice would wake every observer and prove nothing.
  public pushCameraPatch(id: string, patch: Partial<ProtectCameraConfig>): void {

    const previous = this.state;
    const record = previous.cameras.get(id);

    if(!record) {

      throw new Error("The camera record to patch is not present in the store double: " + id + ".");
    }

    const cameras = new Map(previous.cameras);

    cameras.set(id, { ...record, ...patch });
    this.push({ ...previous, cameras });
  }

  // Push a partial featureFlags patch, composing it over the targeted camera record's LIVE featureFlags so nothing else on the flags object moves. pushCameraPatch's
  // shallow merge would otherwise REPLACE the whole featureFlags object, dropping every flag the test did not name; this is the shared composing helper the doorbell
  // promotion / package-capability flip tests use (graduated from the local pushPackageFlag idiom).
  public pushCameraFeatureFlags(id: string, flags: Partial<ProtectCameraConfig["featureFlags"]>): void {

    const record = this.state.cameras.get(id);

    if(!record) {

      throw new Error("The camera record to patch is not present in the store double: " + id + ".");
    }

    this.pushCameraPatch(id, { featureFlags: { ...record.featureFlags, ...flags } });
  }

  // Push the paired Access reader's supportUnlock capability live, composing it over the targeted camera record's accessDeviceMetadata so nothing else on the metadata
  // object moves - the accessDeviceMetadata mirror of pushCameraFeatureFlags. accessDeviceMetadata is OPTIONAL (a camera with no paired reader has none), so an
  // undefined-to-present flip synthesizes the minimal metadata shape makeCameraConfig builds (only the gating featureFlags), while a present-metadata flip spreads the
  // live object and overrides only supportUnlock. The lone cast is confined here, as makeCameraConfig confines its own, since the minimal metadata is not the full wire
  // shape.
  public pushCameraSupportUnlock(id: string, supportUnlock: boolean): void {

    const record = this.state.cameras.get(id);

    if(!record) {

      throw new Error("The camera record to patch is not present in the store double: " + id + ".");
    }

    const metadata = record.accessDeviceMetadata;
    const accessDeviceMetadata = { ...metadata, featureFlags: { ...metadata?.featureFlags, supportUnlock } } as unknown as ProtectCameraConfig["accessDeviceMetadata"];

    this.pushCameraPatch(id, { accessDeviceMetadata });
  }

  // The light-slice mirror of pushCameraPatch: replace only the targeted light record, spread-sharing its untouched fields, while every other slice of the state keeps
  // its reference - so exactly the observers watching light-derived selectors (the light's four narrow reactions) wake. The plain per-slice form, because a key-generic
  // push cannot correlate a slice's record type cast-free against the ReadonlyMap slices, so each slice carries its own typed helper.
  public pushLightPatch(id: string, patch: Partial<ProtectLightConfig>): void {

    const previous = this.state;
    const record = previous.lights.get(id);

    if(!record) {

      throw new Error("The light record to patch is not present in the store double: " + id + ".");
    }

    const lights = new Map(previous.lights);

    lights.set(id, { ...record, ...patch });
    this.push({ ...previous, lights });
  }

  // Push a partial lightDeviceSettings patch, composing it over the targeted light record's LIVE lightDeviceSettings so nothing else on the nested object moves. The
  // light's ledLevel and isIndicatorEnabled selectors both read into lightDeviceSettings, so pushLightPatch's shallow merge would otherwise REPLACE the whole nested
  // object and spuriously wake the sibling selector (or corrupt its state); composing here lets a test move exactly one nested field, mirroring pushCameraFeatureFlags.
  public pushLightDeviceSettings(id: string, settings: Partial<ProtectLightConfig["lightDeviceSettings"]>): void {

    const record = this.state.lights.get(id);

    if(!record) {

      throw new Error("The light record to patch is not present in the store double: " + id + ".");
    }

    this.pushLightPatch(id, { lightDeviceSettings: { ...record.lightDeviceSettings, ...settings } });
  }

  // The sensor-slice mirror of pushCameraPatch: replace only the targeted sensor record, spread-sharing its untouched fields, while every other slice keeps its
  // reference - so exactly the observers watching sensor-derived selectors wake. Lands here as the device-info concern net's first consumer (the base device.name /
  // device.firmwareVersion observers read the sensor record through selectSensor, so a name push wakes the name observer and a firmware push wakes the firmware observer)
  // and is reused by the later sensor family. The plain per-slice form, because a key-generic push cannot correlate a slice's record type cast-free against the
  // ReadonlyMap slices, so each slice carries its own typed helper.
  public pushSensorPatch(id: string, patch: Partial<ProtectSensorConfig>): void {

    const previous = this.state;
    const record = previous.sensors.get(id);

    if(!record) {

      throw new Error("The sensor record to patch is not present in the store double: " + id + ".");
    }

    const sensors = new Map(previous.sensors);

    sensors.set(id, { ...record, ...patch });
    this.push({ ...previous, sensors });
  }

  // The relay-slice mirror of pushCameraPatch: replace only the targeted relay record, spread-sharing its untouched fields, while every other slice keeps its reference -
  // so exactly the observers watching relay-derived selectors wake. The shallow merge is what makes the relay observers' reference dedup meaningful: a patch carrying a
  // fresh outputs array wakes the outputs observer, while a ledSettings-only patch leaves the outputs array reference untouched (so the outputs observer stays parked),
  // mirroring the real reducer's copy-on-write that only replaces the sub-object it actually changed. The plain per-slice form, for the same reason the other
  // slice helpers are (a key-generic push cannot correlate a slice's record type cast-free against the ReadonlyMap slices).
  public pushRelayPatch(id: string, patch: Partial<ProtectRelayConfig>): void {

    const previous = this.state;
    const record = previous.relays.get(id);

    if(!record) {

      throw new Error("The relay record to patch is not present in the store double: " + id + ".");
    }

    const relays = new Map(previous.relays);

    relays.set(id, { ...record, ...patch });
    this.push({ ...previous, relays });
  }

  // Push a fresh outputs array for a relay, composing each simplified { id, name?, state } into a full output record shape (mirroring makeRelayConfig) and replacing the
  // whole outputs reference through pushRelayPatch - so exactly the relay's outputs observer wakes. This is the broadcast a real per-output state change delivers: the
  // reducer replaces the outputs array on a genuine output change, and this helper reproduces that reference swap so a test can move output state without hand-building
  // the full wire output record. The lone cast is confined here, exactly as makeRelayConfig confines its own, since the simplified output is not the full wire shape.
  public pushRelayOutputs(id: string, outputs: { id: number; name?: Nullable<string>; state: "off" | "on" }[]): void {

    this.pushRelayPatch(id, { outputs: outputs.map((output) => ({ id: output.id, name: output.name ?? null, state: output.state })) as ProtectRelayConfig["outputs"] });
  }

  // The chime-slice mirror of pushCameraPatch: replace only the targeted chime record, spread-sharing its untouched fields, while every other slice keeps its
  // reference - so exactly the observers watching chime-derived selectors (the doorbell's chime-volume reduction) wake.
  public pushChimePatch(id: string, patch: Partial<ProtectChimeConfig>): void {

    const previous = this.state;
    const record = previous.chimes.get(id);

    if(!record) {

      throw new Error("The chime record to patch is not present in the store double: " + id + ".");
    }

    const chimes = new Map(previous.chimes);

    chimes.set(id, { ...record, ...patch });
    this.push({ ...previous, chimes });
  }

  // The viewer-slice mirror of pushChimePatch: replace only the targeted viewer record, spread-sharing its untouched fields, while every other slice keeps its
  // reference - so exactly the observers watching viewer-derived selectors (the viewer's active-liveview reflection) wake. This is how the suite drives the
  // observer-driven active-liveview reflection, since the projection double's update records rather than folding.
  public pushViewerPatch(id: string, patch: Partial<ProtectViewerConfig>): void {

    const previous = this.state;
    const record = previous.viewers.get(id);

    if(!record) {

      throw new Error("The viewer record to patch is not present in the store double: " + id + ".");
    }

    const viewers = new Map(previous.viewers);

    viewers.set(id, { ...record, ...patch });
    this.push({ ...previous, viewers });
  }

  // The nvr-slice mirror of the per-slice push helpers, adapted for the one slice that is a SINGLE nullable record rather than a Map: replace the nvr record with the
  // patch spread over its untouched fields, while every other slice keeps its reference - so exactly the observers watching nvr-derived selectors (the nvr-systeminfo
  // owner's narrow nvr.systemInfo reaction) wake. When a test moves systemInfo it passes a FRESH systemInfo object, so selectNvr(state)?.systemInfo changes by reference
  // AND - because client.nvr.config reads through this same slice - nvr.ufp.systemInfo becomes that same new object, so the observer wakes and its re-read returns the
  // new value. The plain per-slice form, not a key-generic, for the same reason the Map push helpers are. Guards the slice non-null because the
  // patch composes over the live record.
  public pushNvrPatch(patch: Partial<ProtectNvrConfig>): void {

    const previous = this.state;

    if(!previous.nvr) {

      throw new Error("The nvr record to patch is not present in the store double.");
    }

    this.push({ ...previous, nvr: { ...previous.nvr, ...patch } });
  }

  // The controller-wide ringtone-collection push: rebuild only the ringtones slice from the supplied array, sharing every other slice's reference - so exactly the
  // nvr.ringtones collection observer (the chime's ringtone-switch reconcile) wakes. A plain per-slice function, not a key-generic, because a key-generic cannot
  // correlate a slice's record type cast-free against the ReadonlyMap slices.
  public pushRingtones(ringtones: ProtectRingtoneConfig[]): void {

    const next = new Map(ringtones.map((ringtone): [string, ProtectRingtoneConfig] => [ ringtone.id, ringtone ]));

    this.push({ ...this.state, ringtones: next });
  }

  // The controller-wide liveview-collection push: rebuild only the liveviews slice from the supplied array, sharing every other slice's reference - so exactly the
  // nvr.liveviews collection observer (the viewer's switch-set reconcile) wakes. A plain per-slice function, for the same reason pushRingtones is.
  public pushLiveviews(liveviews: ProtectNvrLiveviewConfig[]): void {

    const next = new Map(liveviews.map((liveview): [string, ProtectNvrLiveviewConfig] => [ liveview.id, liveview ]));

    this.push({ ...this.state, liveviews: next });
  }

  // Remove a camera record outright, mirroring the reducer's device-removed reduction: the cameras map is rebuilt without the record while every other slice keeps
  // its reference. The fixture for absence-tolerance tests - a projection's config getter throws once its record is gone, and predicates that must survive that
  // (the package detach's stillGone) are exercised against exactly this state.
  public removeCameraRecord(id: string): void {

    const cameras = new Map(this.state.cameras);

    cameras.delete(id);
    this.push({ ...this.state, cameras });
  }

  /* Observe a selector over the state, mirroring the real StateStore.observe contract exactly: a native async generator, so registration is LAZY (it happens when
   * iteration begins, and an un-iterated observe registers nothing); an already-aborted signal yields nothing; the baseline is seeded at iteration start; abort
   * closes the observer (drain-then-close); and the finally deregisters on every exit path - abort, break, or return().
   */
  public async *observe<T>(selector: (state: ProtectState) => T, opts: { signal?: AbortSignal } = {}): AsyncGenerator<T> {

    const signal = opts.signal;

    // Nothing to observe if the caller handed us an already-aborted signal.
    if(signal?.aborted) {

      return;
    }

    const observer = new TestStateObserver<T>(selector, this.state);
    const onAbort = (): void => observer.close();

    this.observers.add(observer);
    signal?.addEventListener("abort", onAbort, { once: true });

    try {

      yield* observer.iterate();
    } finally {

      this.observers.delete(observer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
}

/**
 * Build a complete ProtectState for the store double, populated with whichever device-slice records the caller supplies and empty collections everywhere else.
 * Mirrors the real reduced state's shape (unifi-protect's reducer), so the real memoized selectors read it natively. Every slice keys its records by their own id,
 * exactly as the reducer does; the lone nvr slice is a single nullable record rather than a map. Omitting any option yields the empty starting value for that slice
 * (an empty Map, or null for nvr), so a bare makeProtectState() is the empty-everywhere baseline the observe and selector tests seed.
 *
 * @param options - cameras / chimes / lights / liveviews / relays / ringtones / sensors / viewers: the config records to key into the matching map slice, each keyed by
 *                  its own id; nvr: the single controller config record set on the nvr slice (defaults to null). The users and fobs slices are intentionally not exposed:
 *                  no test seeds them (neither is surfaced in HomeKit), so they stay the empty Map the reducer starts from.
 *
 * @returns a full ProtectState ready to seed a TestStateStore.
 */
export function makeProtectState(options: { cameras?: ProtectCameraConfig[]; chimes?: ProtectChimeConfig[]; lights?: ProtectLightConfig[];
  liveviews?: ProtectNvrLiveviewConfig[]; nvr?: Nullable<ProtectNvrConfig>; relays?: ProtectRelayConfig[]; ringtones?: ProtectRingtoneConfig[];
  sensors?: ProtectSensorConfig[]; viewers?: ProtectViewerConfig[]; } = {}): ProtectState {

  return {

    authUserId: null,
    bootstrapId: 1,
    cameras: new Map((options.cameras ?? []).map((camera): [string, ProtectCameraConfig] => [ camera.id, camera ])),
    chimes: new Map((options.chimes ?? []).map((chime): [string, ProtectChimeConfig] => [ chime.id, chime ])),
    fobs: new Map(),
    lights: new Map((options.lights ?? []).map((light): [string, ProtectLightConfig] => [ light.id, light ])),
    liveviews: new Map((options.liveviews ?? []).map((liveview): [string, ProtectNvrLiveviewConfig] => [ liveview.id, liveview ])),
    nvr: options.nvr ?? null,
    relays: new Map((options.relays ?? []).map((relay): [string, ProtectRelayConfig] => [ relay.id, relay ])),
    ringtones: new Map((options.ringtones ?? []).map((ringtone): [string, ProtectRingtoneConfig] => [ ringtone.id, ringtone ])),
    sensors: new Map((options.sensors ?? []).map((sensor): [string, ProtectSensorConfig] => [ sensor.id, sensor ])),
    users: new Map(),
    viewers: new Map((options.viewers ?? []).map((viewer): [string, ProtectViewerConfig] => [ viewer.id, viewer ]))
  };
}

// The quiet-default camera feature flags the config builder populates, expressed as a named shape so the builder's featureFlags override option is a typed Partial
// of exactly this surface rather than an unchecked record.
export interface TestCameraFeatureFlags {

  hasChime: boolean;
  hasFingerprintSensor: boolean;
  hasIcrSensitivity: boolean;
  hasInfrared: boolean;
  hasLcdScreen: boolean;
  hasLedStatus: boolean;
  hasLuxCheck: boolean;
  hasPackageCamera: boolean;
  hasSmartDetect: boolean;
  hasSpeaker: boolean;
  hasTamperDetection: boolean;
  isDoorbell: boolean;
  smartDetectAudioTypes: string[];
  smartDetectTypes: string[];
}

/**
 * Build a minimal-but-real camera config record for construction tests: every field the ProtectCamera construction path actually reads is populated with the
 * quiet-default shape (every feature flag false, recording mode "always", a CONNECTED state, and the fixture host so channel URLs match the golden-master
 * corpus), and the record is then cast once to the full wire type. This is the ONE confined cast seam for the camera record: the ProtectCameraConfig wire type
 * carries many fields the construction path never touches, so we populate the verified read set and document the cast here rather than scattering casts through
 * tests - the same spirit as camera.fixtures.ts' makeChannel, carried as far as is practical for a much wider record. Every override merges BEFORE the single
 * cast, so an overridden record is exactly as type-honest as the default one.
 *
 * @param options - channels: the typed channel array (reuse the camera.fixtures.ts corpus); featureFlags: per-flag overrides merged over the all-false
 *                  defaults (a doorbell test sets isDoorbell, a package test adds hasPackageCamera); chimeDuration / enableNfc / isDark / lcdMessage: the
 *                  doorbell-adjacent fields its configure paths read; id / mac / name: optional identity overrides; videoCodec: the codec string (default "h264"),
 *                  overridable to "av1" so the playlist filter's codec exclusion can be exercised.
 *
 * @returns a camera config record the construction path reads as real.
 */
export function makeCameraConfig(options: { accessDeviceMetadata?: { featureFlags: { supportUnlock: boolean } }; channels: ProtectCameraChannelConfig[];
  chimeDuration?: number; enableNfc?: boolean; featureFlags?: Partial<TestCameraFeatureFlags>; id?: string; isDark?: boolean; lcdMessage?: { duration?: number;
    resetAt?: Nullable<number>; text?: string; type?: string; }; mac?: string; name?: string; videoCodec?: string; }): ProtectCameraConfig {

  const name = options.name ?? "Test Camera";

  const populated = {

    channels: options.channels,
    chimeDuration: options.chimeDuration ?? 0,
    connectionHost: FIXTURE_HOST,
    displayName: name,
    enableNfc: options.enableNfc ?? false,
    featureFlags: {

      hasChime: false,
      hasFingerprintSensor: false,
      hasIcrSensitivity: false,
      hasInfrared: false,
      hasLcdScreen: false,
      hasLedStatus: false,
      hasLuxCheck: false,
      hasPackageCamera: false,
      hasSmartDetect: false,
      hasSpeaker: false,
      hasTamperDetection: false,
      isDoorbell: false,
      smartDetectAudioTypes: [],
      smartDetectTypes: [],
      ...options.featureFlags
    },
    firmwareVersion: "5.0.0",
    id: options.id ?? "test-camera-1",
    isAdoptedByAccessApp: false,
    isDark: options.isDark ?? false,
    isPairedWithAiPort: false,
    isThirdPartyCamera: false,
    ispSettings: { icrCustomValue: 0, irLedMode: "off" },
    ledSettings: { isEnabled: false },
    mac: options.mac ?? "74ACB9000001",
    marketName: "Test Camera Model",
    name: name,
    recordingSettings: { mode: "always" },
    smartDetectSettings: { enableTamperDetection: false },
    state: "CONNECTED",
    videoCodec: options.videoCodec ?? "h264",
    ...(options.accessDeviceMetadata !== undefined ? { accessDeviceMetadata: options.accessDeviceMetadata } : {}),
    ...(options.lcdMessage !== undefined ? { lcdMessage: options.lcdMessage } : {})
  };

  return populated as unknown as ProtectCameraConfig;
}

/**
 * Build a minimal-but-real chime config record, mirroring makeCameraConfig's discipline: the fields the doorbell's chime-volume derivation reads (cameraIds and the
 * per-doorbell ringSettings entries) are populated for real, plus the construction read-set the real ProtectChime now needs - displayName / firmwareVersion / marketName
 * are what setInfo reads (the model derivation prefers marketName, the firmware-revision write guards on firmwareVersion's presence), so they join the record now that
 * the chime is constructed for real rather than only modeled. type / hardwareRevision are omitted exactly as makeLightConfig omits them: marketName wins the model-name
 * derivation and the hardwareRevision guard short-circuits on absence, so the construction path stays type-honest without them. The rest of the wire type sits behind the
 * single documented cast.
 *
 * @param options - cameraIds: the doorbells this chime serves; id / mac / name: optional identity overrides; ringSettings: the per-doorbell ring entries (volume is
 *                  the field the derivation reads, repeatTimes / ringtoneId the play join reads).
 *
 * @returns a chime config record the chime-volume and construction paths read as real.
 */
export function makeChimeConfig(options: { cameraIds?: string[]; id?: string; mac?: string; name?: string;
  ringSettings?: { cameraId: string; repeatTimes?: number; ringtoneId?: string; volume: number }[]; } = {}): ProtectChimeConfig {

  const name = options.name ?? "Test Chime";

  const populated = {

    cameraIds: options.cameraIds ?? [],
    displayName: name,
    firmwareVersion: "5.0.0",
    id: options.id ?? "test-chime-1",
    mac: options.mac ?? "74ACB9000101",
    marketName: "Test Chime Model",
    modelKey: "chime",
    name: name,
    ringSettings: (options.ringSettings ?? []).map((ring) => ({

      cameraId: ring.cameraId,
      repeatTimes: ring.repeatTimes ?? 1,
      ringtoneId: ring.ringtoneId ?? "default",
      volume: ring.volume
    })),
    state: "CONNECTED",
    volume: 100
  };

  return populated as unknown as ProtectChimeConfig;
}

/**
 * Build a minimal-but-real light config record, mirroring makeCameraConfig's single-confined-cast discipline: every field the ProtectLight construction and observe
 * paths actually read is populated for real (the power state, the nested lightDeviceSettings the brightness and status-indicator selectors read, the motion timestamp,
 * and the identity / connection fields), and the record is cast once to the full wire type. The ProtectLightConfig wire type carries many fields the light's paths
 * never touch, so we populate the verified read set and confine the lone cast here. type / hardwareRevision are omitted exactly as makeCameraConfig omits them: the
 * marketName wins the model-name derivation and the hardwareRevision guard short-circuits on absence, so the construction path stays type-honest without them.
 *
 * @param options - id: optional identity override (defaults to "test-light-1"); isIndicatorEnabled: the nested status-indicator setting the isIndicatorEnabled selector
 *                  reads (defaults to false); isLightOn: the power state the Lightbulb On characteristic mirrors (defaults to false); lastMotion: the motion timestamp
 *                  the lastMotion observer gates on (defaults to null); ledLevel: the nested Protect 1-6 LED level the Brightness selector reads (defaults to 1, which
 *                  maps to 0%); mac: optional MAC override (defaults to a light-distinct value); name: optional display name (defaults to "Test Light").
 *
 * @returns a light config record the construction and observe paths read as real.
 */
export function makeLightConfig(options: { id?: string; isIndicatorEnabled?: boolean; isLightOn?: boolean; lastMotion?: Nullable<number>; ledLevel?: number;
  mac?: string; name?: string; } = {}): ProtectLightConfig {

  const name = options.name ?? "Test Light";

  const populated = {

    displayName: name,
    firmwareVersion: "5.0.0",
    id: options.id ?? "test-light-1",
    isLightOn: options.isLightOn ?? false,
    lastMotion: options.lastMotion ?? null,
    lightDeviceSettings: { isIndicatorEnabled: options.isIndicatorEnabled ?? false, ledLevel: options.ledLevel ?? 1 },
    mac: options.mac ?? "74ACB9000201",
    marketName: "Test Light Model",
    modelKey: "light",
    name: name,
    state: "CONNECTED"
  };

  return populated as unknown as ProtectLightConfig;
}

/**
 * Build a minimal-but-real viewer config record, mirroring makeLightConfig's single-confined-cast discipline: every field the ProtectViewer construction and observe
 * paths read is populated for real (the active liveview the switch state mirrors, plus the identity / connection / info fields setInfo reads), and the record is cast
 * once to the full wire type. The ProtectViewerConfig wire type carries many fields the viewer's paths never touch (the feature-flag bag, the connection-state objects),
 * so we populate the verified read set and confine the lone cast here. type / hardwareRevision are omitted exactly as makeLightConfig omits them.
 *
 * @param options - id: optional identity override (defaults to "test-viewer-1"); liveview: the active liveview id the switch-on reflection reads (defaults to null, no
 *                  active liveview); mac: optional MAC override (defaults to a viewer-distinct value); name: optional display name (defaults to "Test Viewer").
 *
 * @returns a viewer config record the construction and observe paths read as real.
 */
export function makeViewerConfig(options: { id?: string; liveview?: Nullable<string>; mac?: string; name?: string } = {}): ProtectViewerConfig {

  const name = options.name ?? "Test Viewer";

  const populated = {

    displayName: name,
    firmwareVersion: "5.0.0",
    id: options.id ?? "test-viewer-1",
    liveview: options.liveview ?? null,
    mac: options.mac ?? "74ACB9000301",
    marketName: "Test Viewer Model",
    modelKey: "viewer",
    name: name,
    state: "CONNECTED"
  };

  return populated as unknown as ProtectViewerConfig;
}

/**
 * Build a minimal-but-real sensor config record, mirroring makeCameraConfig's wide-read-set discipline: every field the ProtectSensor construction, the base
 * device-capability paths (motion / occupancy / status-LED), and the later sensor-family configure paths actually read is populated for real, and the record is cast
 * once to the full wire type. A bare makeSensorConfig() is an all-quiet sensor - every *Settings.isEnabled is false, the LED indicator is off, the mount type is "none",
 * a battery is present and healthy, no air-quality stats are present - and isMotionDetected defaults to TRUE so the Motion.* feature options satisfy their hasProperty
 * applicability gate (which makes the option visible to FeatureOptions; it is NOT the runtime service gate - that is the Enable.Motion.* userOptions string, since all
 * three Motion options default to false). This is the ONE carrier the base-capability concern tests ride on AND the sensor-family fixture, so it is the single source for
 * the sensor shape - there is no second "base config" builder. type is omitted exactly as makeLightConfig omits it: marketName wins the model-name derivation, so the
 * construction path stays type-honest without it. hardwareRevision is OPT-IN with no default (stays absent), mirroring makeNvrConfig: a bare call omits the key so
 * ProtectBase.setInfo's HardwareRevision length-guard short-circuits, while passing a value lands it so the device-info HardwareRevision write nets non-vacuously. The
 * air-quality stats sub-objects are ProtectAirQualityMetricInterface ({ status, value }) shapes built only for the metrics a test supplies; the lone confined cast to
 * ProtectSensorConfig carries the whole record's type honesty (the ProtectThresholdSettings and ProtectAirQualityMetricInterface shapes are populated faithfully behind
 * it rather than imported separately).
 *
 * @param options - alarmEnabled: the alarm settings toggle (defaults false); alarmTriggeredAt: the alarm-trip timestamp (defaults null); ambientLight: the ambient
 *                  light reading folded into stats.light.value (omitted, no light stat); batteryLow / batteryPercentage: the battery status (default false / 100);
 *                  externalLeakDetectedAt: the external-leak timestamp the leak path index-reads (defaults null); hardwareRevision: the hardware revision the device-info
 *                  HardwareRevision write reads (OPT-IN, omitted by default so setInfo's length-guard short-circuits); humidity: the humidity reading folded into
 *                  stats.humidity.value (omitted, no humidity stat); humidityEnabled: the humidity settings toggle (defaults false); id: identity override (defaults
 *                  "test-sensor-1"); isConnected: the connection flag (defaults true); isMotionDetected: the Motion.* applicability property (defaults true); isOpened:
 *                  the contact state (defaults null); leakChannelNames: the water-leak channels the controller advertises in featureFlags.waterLeak.channelNames - the
 *                  leak-policy leaf's capability discriminator (defaults [], no leak capability); leakDetectedAt: the internal-leak timestamp (defaults null);
 *                  leakExternalEnabled / leakInternalEnabled: the leak settings toggles (default false); ledEnabled: the status-indicator LED toggle (defaults false);
 *                  lightEnabled: the light settings toggle (defaults
 *                  false); mac: identity override (defaults a sensor-distinct value); motionDetectedAt: the motion timestamp the sensor motion observer gates on
 *                  (defaults 0); motionEnabled: the motion settings toggle (defaults false); mountType: the sensor mount type (defaults "none"); name: display name
 *                  (defaults "Test Sensor"); tamperingDetectedAt: the tamper timestamp (defaults null); temperature: the temperature reading folded into
 *                  stats.temperature.value (omitted, no temperature stat); temperatureEnabled: the temperature settings toggle (defaults false).
 *
 * @returns a sensor config record the construction, base-capability, and sensor-family paths read as real.
 */
export function makeSensorConfig(options: { alarmEnabled?: boolean; alarmTriggeredAt?: Nullable<number>; ambientLight?: number; batteryLow?: boolean;
  batteryPercentage?: Nullable<number>; externalLeakDetectedAt?: Nullable<number>; hardwareRevision?: string; humidity?: number; humidityEnabled?: boolean; id?: string;
  isConnected?: boolean; isMotionDetected?: boolean; isOpened?: Nullable<boolean>; leakChannelNames?: string[]; leakDetectedAt?: Nullable<number>;
  leakExternalEnabled?: boolean; leakInternalEnabled?: boolean; ledEnabled?: boolean; lightEnabled?: boolean; mac?: string; motionDetectedAt?: number;
  motionEnabled?: boolean; mountType?: string;
  name?: string; tamperingDetectedAt?: Nullable<number>; temperature?: number; temperatureEnabled?: boolean; } = {}): ProtectSensorConfig {

  const name = options.name ?? "Test Sensor";

  // A ProtectThresholdSettings shape ({ highThreshold, isEnabled, lowThreshold, margin }) keyed only by the isEnabled toggle a test cares about; the threshold numbers
  // are quiet, valid defaults the construction path never inspects.
  const thresholdSettings = (isEnabled: boolean): { highThreshold: number; isEnabled: boolean; lowThreshold: number; margin: number } => ({ highThreshold: 0, isEnabled,
    lowThreshold: 0, margin: 0 });

  // Build the air-quality stats record only with the metrics a test supplies; each present metric is a ProtectAirQualityMetricInterface ({ status, value }) shape, so the
  // status string is carried alongside the value rather than overloading a bare { value }. An all-quiet sensor supplies no metrics, so stats is absent entirely.
  const stats: { humidity?: { status: string; value: number }; light?: { status: string; value: number }; temperature?: { status: string; value: number } } = {};

  if(options.humidity !== undefined) {

    stats.humidity = { status: "", value: options.humidity };
  }

  if(options.ambientLight !== undefined) {

    stats.light = { status: "", value: options.ambientLight };
  }

  if(options.temperature !== undefined) {

    stats.temperature = { status: "", value: options.temperature };
  }

  const populated = {

    alarmSettings: { isEnabled: options.alarmEnabled ?? false },
    alarmTriggeredAt: options.alarmTriggeredAt ?? null,
    batteryStatus: { isLow: options.batteryLow ?? false, percentage: options.batteryPercentage ?? 100 },
    displayName: name,
    externalLeakDetectedAt: options.externalLeakDetectedAt ?? null,

    // The minimal sensor featureFlags the leak-policy leaf reads: the water-leak capability the controller advertises, keyed by channelNames. Defaults to [] (no leak
    // capability), so the all-quiet carrier exposes no leak service and registers no leak MQTT get, matching a no-leak device (USL-Entry) with zero per-test edits.
    featureFlags: { waterLeak: { channelCount: (options.leakChannelNames ?? []).length, channelNames: options.leakChannelNames ?? [] } },
    firmwareVersion: "5.0.0",
    humiditySettings: thresholdSettings(options.humidityEnabled ?? false),
    id: options.id ?? "test-sensor-1",
    isConnected: options.isConnected ?? true,
    isMotionDetected: options.isMotionDetected ?? true,
    isOpened: options.isOpened ?? null,
    leakDetectedAt: options.leakDetectedAt ?? null,
    leakSettings: { isExternalEnabled: options.leakExternalEnabled ?? false, isInternalEnabled: options.leakInternalEnabled ?? false },
    ledSettings: { isEnabled: options.ledEnabled ?? false },
    lightSettings: thresholdSettings(options.lightEnabled ?? false),
    mac: options.mac ?? "74ACB9000401",
    marketName: "Test Sensor Model",
    modelKey: "sensor",
    motionDetectedAt: options.motionDetectedAt ?? 0,
    motionSettings: { isEnabled: options.motionEnabled ?? false, sensitivity: 0 },
    mountType: options.mountType ?? "none",
    name: name,
    state: "CONNECTED",
    tamperingDetectedAt: options.tamperingDetectedAt ?? null,
    temperatureSettings: thresholdSettings(options.temperatureEnabled ?? false),
    ...(Object.keys(stats).length ? { stats } : {}),

    // OPT-IN only, mirroring makeNvrConfig's hardwareRevision exactly: when the caller passes a value the device-info HardwareRevision write nets it on the record;
    // otherwise the field stays absent so ProtectBase.setInfo's length-guard short-circuits. The conditional spread keeps the key absent rather than
    // present-as-undefined, so an `in` check sees the same shape as when the option is omitted.
    ...(options.hardwareRevision !== undefined ? { hardwareRevision: options.hardwareRevision } : {})
  };

  return populated as unknown as ProtectSensorConfig;
}

/**
 * Build a minimal-but-real relay config record, mirroring makeLightConfig's single-confined-cast discipline: every field the ProtectRelay construction and observe paths
 * actually read is populated for real (the per-output on/off state the switches mirror, the LED indicator setting the status-LED switch reads, and the identity / info
 * fields setInfo and the base observers read), and the record is cast once to the full wire type. A bare makeRelayConfig() is a two-output relay, both outputs off, both
 * named null (so the "Output N" fallback naming is exercised) and the indicator off. The ProtectRelayConfig wire type carries fields the relay's paths never touch (the
 * inputs array, the LoRa connection state, host); we populate the verified read set and confine the lone cast here. Each output record likewise populates only the id /
 * name / state the plugin reads and rides the same single cast. type / hardwareRevision are omitted exactly as makeLightConfig omits them.
 *
 * @param options - id: optional identity override (defaults to "test-relay-1"); ledEnabled: the status-indicator setting the statusLed getter and ledSettings observer
 *                  read (defaults to false); mac: optional MAC override (defaults to a relay-distinct value); name: optional display name (defaults to "Test Relay");
 *                  outputs: the per-output records the switches, the observe reconcile, and MQTT read (defaults to two outputs, ids 0 and 1, both off and unnamed).
 *
 * @returns a relay config record the construction and observe paths read as real.
 */
export function makeRelayConfig(options: { id?: string; ledEnabled?: boolean; mac?: string; name?: string;
  outputs?: { id: number; name?: Nullable<string>; state?: "off" | "on" }[]; } = {}): ProtectRelayConfig {

  const name = options.name ?? "Test Relay";

  const populated = {

    displayName: name,
    firmwareVersion: "5.0.0",
    id: options.id ?? "test-relay-1",
    ledSettings: { isEnabled: options.ledEnabled ?? false },
    mac: options.mac ?? "74ACB9000501",
    marketName: "Test Relay Model",
    modelKey: "relay",
    name: name,
    outputs: (options.outputs ?? [ { id: 0, name: null, state: "off" }, { id: 1, name: null, state: "off" } ]).map((output) => ({ id: output.id,
      name: output.name ?? null, state: output.state ?? "off" })),
    state: "CONNECTED"
  };

  return populated as unknown as ProtectRelayConfig;
}

/**
 * Build a minimal-but-real ringtone config record. The chime scopes its speaker switches to the ringtones whose nvrMac matches this controller's MAC, so nvrMac
 * defaults to the makeNvrConfig MAC ("74ACB9FFFFFF"): any other default would fail the chime's tone.nvrMac === nvr.ufp.mac filter and create zero speaker switches,
 * silently emptying the chime suite. The rest of the wire type sits behind the single documented cast.
 *
 * @param options - id: optional identity override (defaults to "test-ringtone-1"); name: optional display name (defaults to "Test Ringtone"); nvrMac: the controller
 *                  MAC the chime filters on (defaults to the makeNvrConfig MAC so seeded ringtones survive the filter).
 *
 * @returns a ringtone config record the chime's ringtone-switch reconcile reads as real.
 */
export function makeRingtoneConfig(options: { id?: string; name?: string; nvrMac?: string } = {}): ProtectRingtoneConfig {

  const populated = {

    id: options.id ?? "test-ringtone-1",
    isDefault: false,
    modelKey: "ringtone",
    name: options.name ?? "Test Ringtone",
    nvrMac: options.nvrMac ?? "74ACB9FFFFFF",
    size: 0
  };

  return populated as unknown as ProtectRingtoneConfig;
}

/**
 * Build a minimal-but-real liveview config record. The viewer reads a liveview's id (to reconcile its switch set) and name (the switch display name, the MQTT label),
 * so those are populated for real; the rest of the wire type (layout, ownership flags) sits behind the single documented cast. slots defaults to empty (the viewer never
 * reads it), but the controller-owner net's motion fanouts flatten slots[].cameras (the security-system's setSecurityState and the liveviews' getLiveviewCameras), so a
 * cameras option populates a single slot with those member ids - a no-cameras call preserves the empty-slots default. DISTINCT-ID DISCIPLINE: makeProtectState keys the
 * liveviews map by id and the id default is the constant "test-liveview-1", so any test seeding MULTIPLE liveviews must pass a distinct id per record or they collapse to
 * one map entry, silently vacating the multi-state setProps reconcile and the per-name fanout lookups (the viewer.test.ts precedent passes distinct ids).
 *
 * @param options - cameras: optional member-camera ids populated into a single slot (defaults to no slot, preserving slots: []); id: optional identity override (defaults
 *                  to "test-liveview-1"); name: optional display name (defaults to "Test Liveview").
 *
 * @returns a liveview config record the viewer's switch reconcile and the controller-owner fanouts read as real.
 */
export function makeLiveviewConfig(options: { cameras?: string[]; id?: string; name?: string } = {}): ProtectNvrLiveviewConfig {

  const populated = {

    id: options.id ?? "test-liveview-1",
    isDefault: false,
    isGlobal: false,
    layout: 0,
    modelKey: "liveview",
    name: options.name ?? "Test Liveview",
    owner: "test-owner",
    slots: options.cameras ? [{ cameras: options.cameras, cycleInterval: 0, cycleMode: "motion" }] : []
  };

  return populated as unknown as ProtectNvrLiveviewConfig;
}

/* The Camera projection double, mirroring unifi-protect's DeviceProjection contract for the members the construction path reads: a stable id, the "camera"
 * modelKey discriminant, a READ-THROUGH config getter into the store double's CURRENT state (never a held snapshot - a push must change what this.ufp returns, or
 * an end-to-end push test proves nothing), and the derived name / isOnline getters using the projection's own definitions (name ?? displayName, and
 * state === "CONNECTED" per the library's isDeviceOnline). It now exposes the write-through update the camera's bound onSets dispatch (the night-vision dimmer's
 * ispSettings write, the recording switch's recordingSettings write, the camera-routed status-LED's ledSettings write), RECORDING the payload and resolving by
 * default with a settable updateRejection so a test drives the real runDeviceCommand failure path. It also exposes the two best-effort, runDeviceCommand-bypassing
 * commands the camera issues on a cadence - the ambient-light lux query (a reading the configure path reads at construction and on a 60-second poll) and the
 * package-camera flashlight pulse (the dark-guarded retry-and-heartbeat) - each RECORDING its calls and resolving by default with a settable rejection so a test
 * drives the real sentinel-swallowing failure paths. The remaining METHODS (livestream, talkback, snapshot, reboot) sit behind gates the minimal construction
 * scenario never opens and are deliberately omitted - a test that reaches one fails loudly on the missing member instead of silently succeeding against a stub.
 */
export class TestCameraProjection {

  public readonly id: string;
  public readonly modelKey = "camera" as const;
  // The recorded update payloads the camera's real onSet write-through commands dispatch, so a test asserts the exact payload (the ispSettings / recordingSettings /
  // ledSettings the four bound handlers issue). The shape stays general because the camera issues three distinct payload shapes through this one member.
  public readonly updateCalls: { payload: unknown }[] = [];
  // The settable rejection: when set, the next update rejects with it, so a test drives the real runDeviceCommand failure branch (a plain Error or a
  // ProtectAuthorizationError).
  public updateRejection: Nullable<Error> = null;
  // The ambient-light reading lux() resolves with - a benign positive default, only reached when featureFlags.hasLuxCheck opens configureAmbientLightSensor. A test sets
  // it (zero for the floor sentinel, a positive value for the passthrough) before construction or before a poll. luxRejection drives the throw -> -1 sentinel, and
  // luxCalls is the proof the unreachable arm never issues the doomed query (the configure path short-circuits to -1 without calling lux at all when offline).
  public luxReading = 100;
  public luxRejection: Nullable<Error> = null;
  public readonly luxCalls: { opts?: { signal?: AbortSignal } }[] = [];
  // The recorded UniFi Access unlock commands the lock's LockTargetState onSet dispatches when the user drives it to UNSECURED, so a test proves the onSet was actually
  // bound (a restart re-wire records exactly one call) rather than fired by the establishment stamp alone. unlockRejection drives the runDeviceCommand failure branch
  // (the optimistic UNSECURED reverts to SECURED), mirroring the luxRejection / updateRejection levers.
  public unlockRejection: Nullable<Error> = null;
  public readonly unlockCalls: { opts?: { signal?: AbortSignal } }[] = [];
  // The recorded flashlight pulses turnOnFlashlight() resolves into, so a test asserts the retry budget by count (one on a success or a heartbeat re-pulse, three on the
  // exhausted failure). flashlightRejection drives the retry-exhaustion failure path, where the catch swallows the pulse to a reflected-off switch.
  public flashlightRejection: Nullable<Error> = null;
  public readonly flashlightCalls: { opts?: { signal?: AbortSignal } }[] = [];
  private readonly store: TestStateStore;

  public constructor(id: string, store: TestStateStore) {

    this.id = id;
    this.store = store;
  }

  // Read-through config into the store double's current state, mirroring the real projection's absent-record guard.
  public get config(): Readonly<ProtectCameraConfig> {

    const config = this.store.snapshot().cameras.get(this.id);

    if(!config) {

      throw new ReferenceError("The camera record is not present in the store double: " + this.id + ".");
    }

    return config;
  }

  // The non-throwing companion to config, mirroring the real projection's peek(): the current config, or undefined when the record is absent from the store double.
  public peek(): Readonly<ProtectCameraConfig> | undefined {

    return this.store.snapshot().cameras.get(this.id) ?? undefined;
  }

  // Whether the device is currently connected, per the library's isDeviceOnline definition.
  public get isOnline(): boolean {

    return this.config.state === "CONNECTED";
  }

  // The device's display name - its user-assigned name when set, otherwise the controller's displayName, per the DeviceProjection convention.
  public get name(): string {

    return this.config.name ?? this.config.displayName;
  }

  // Record an update payload and resolve with this projection, or reject with the settable rejection so a test drives the failure path. It RECORDS ONLY - it does NOT
  // fold the payload into the store, so every reflection stays inline-local (the dimmer Brightness snaps its own local level, the recording switch flips its siblings
  // inline) or observer-driven (a test pushes the reflection through pushCameraPatch), keeping the command and the reflection independently asserted.
  public async update(payload: unknown): Promise<this> {

    this.updateCalls.push({ payload });

    if(this.updateRejection) {

      throw this.updateRejection;
    }

    return this;
  }

  // Record a lux query and resolve with the settable reading, or reject with the settable rejection so a test drives the catch -> -1 throw sentinel. It RECORDS the call
  // (luxCalls) so a test proves the unreachable arm never queries, and returns the raw reading - the camera's getLux closure owns the 0 -> 0.0001 floor and the -1
  // sentinel mapping, so this double stays a faithful library projection and does no sentinel logic of its own.
  public async lux(opts?: { signal?: AbortSignal }): Promise<number> {

    this.luxCalls.push({ opts });

    if(this.luxRejection) {

      throw this.luxRejection;
    }

    return this.luxReading;
  }

  // Record an Access unlock command and resolve, or reject with the settable rejection so a test drives the runDeviceCommand failure -> optimistic-revert path. RECORDS
  // the call (unlockCalls) so a test proves the lock's onSet bound and dispatched exactly one unlock - the observable proxy for the wire-every-configure re-bind a
  // Homebridge restart relies on - and does no lock-state logic of its own, staying a faithful library projection (the controller's Access bridge is one-way and
  // fire-and-forget).
  public async unlock(opts?: { signal?: AbortSignal }): Promise<void> {

    this.unlockCalls.push({ opts });

    if(this.unlockRejection) {

      throw this.unlockRejection;
    }
  }

  // Record a flashlight pulse and resolve, or reject with the settable rejection so a test drives the retry-exhaustion failure path (the package camera's
  // activateFlashlight retries three times, then swallows a persistent rejection to a reflected-off switch). RECORDS the call so a test asserts the retry budget.
  public async turnOnFlashlight(opts?: { signal?: AbortSignal }): Promise<void> {

    this.flashlightCalls.push({ opts });

    if(this.flashlightRejection) {

      throw this.flashlightRejection;
    }
  }
}

/* The Light projection double, the exact analog of TestCameraProjection for the light family: a stable id, the "light" modelKey discriminant, a READ-THROUGH config
 * getter into the store double's CURRENT state (never a held snapshot - a push must change what this.ufp returns, or an end-to-end observe test proves nothing), and
 * the derived name / isOnline getters using the projection's own definitions (name ?? displayName, and state === "CONNECTED" per the library's isDeviceOnline). It now
 * exposes the write-through update the light's bound onSets dispatch (the lightOnSettings.isLedForceOn power write the On onSet issues, and the lightDeviceSettings
 * .ledLevel brightness write the Brightness onSet issues), RECORDING the payload and resolving by default with a settable updateRejection so a test drives the real
 * runDeviceCommand failure path. It mirrors TestCameraProjection: the read-through config getter PLUS the recording update member, the resolve-by-default idiom.
 */
export class TestLightProjection {

  public readonly id: string;
  public readonly modelKey = "light" as const;
  // The recorded update payloads the light's real onSet write-through commands dispatch (the lightOnSettings.isLedForceOn power write and the lightDeviceSettings
  // .ledLevel brightness write), so a test asserts the exact payload. The shape stays general because the light issues two distinct payload shapes through this member.
  public readonly updateCalls: { payload: unknown }[] = [];
  // The settable rejection: when set, the next update rejects with it, so a test drives the real runDeviceCommand failure branch (a plain Error or a
  // ProtectAuthorizationError).
  public updateRejection: Nullable<Error> = null;
  private readonly store: TestStateStore;

  public constructor(id: string, store: TestStateStore) {

    this.id = id;
    this.store = store;
  }

  // Read-through config into the store double's current state, mirroring the real projection's absent-record guard.
  public get config(): Readonly<ProtectLightConfig> {

    const config = this.store.snapshot().lights.get(this.id);

    if(!config) {

      throw new ReferenceError("The light record is not present in the store double: " + this.id + ".");
    }

    return config;
  }

  // The non-throwing companion to config, mirroring the real projection's peek(): the current config, or undefined when the record is absent from the store double.
  public peek(): Readonly<ProtectLightConfig> | undefined {

    return this.store.snapshot().lights.get(this.id) ?? undefined;
  }

  // Whether the device is currently connected, per the library's isDeviceOnline definition.
  public get isOnline(): boolean {

    return this.config.state === "CONNECTED";
  }

  // The device's display name - its user-assigned name when set, otherwise the controller's displayName, per the DeviceProjection convention.
  public get name(): string {

    return this.config.name ?? this.config.displayName;
  }

  // Record an update payload and resolve with this projection, or reject with the settable rejection so a test drives the failure path. It RECORDS ONLY - it does NOT
  // fold the payload into the store, so the command (the captured updateCalls payload) and any reflection (the 50ms Brightness re-reflect, the publish) stay
  // independently asserted, exactly as TestCameraProjection.update does.
  public async update(payload: unknown): Promise<this> {

    this.updateCalls.push({ payload });

    if(this.updateRejection) {

      throw this.updateRejection;
    }

    return this;
  }
}

/* The Chime projection double, the chime-family analog of TestLightProjection: a stable id, the "chime" modelKey discriminant, a READ-THROUGH config getter into the
 * store double's CURRENT state (never a held snapshot - a push must change what this.ufp returns, or an end-to-end observe test proves nothing), and the derived name /
 * isOnline getters using the projection's own definitions. Unlike the read-only Light / Camera projections, the chime exposes a COMMAND surface: the real ProtectChime's
 * playTone dispatches to playBuzzer / playSpeaker, so this double records every play call and resolves by default, with a settable playRejection so a test can drive the
 * real runDeviceCommand failure (and, for a ProtectAuthorizationError, the admin-guidance) path. It also exposes the write-through update the doorbell's cross-device
 * setChimeVolume drives through client.chimes (the per-doorbell ring-volume PATCH), RECORDING the payload and resolving by default with a settable updateRejection - kept
 * DISTINCT from playRejection so the volume-write failure drive and the play failure drive are two independent levers - so a test drives the real runDeviceCommand
 * failure path on the volume write.
 */
export class TestChimeProjection {

  public readonly id: string;
  public readonly modelKey = "chime" as const;
  // The recorded play commands the real playTone dispatches into, so a test asserts the exact dispatch (buzzer vs speaker) and, for the speaker, the joined payload.
  public readonly playBuzzerCalls: { opts?: { signal?: AbortSignal } }[] = [];
  public readonly playSpeakerCalls: { opts: PlaySpeakerOptions }[] = [];
  // The settable rejection: when set, the next play command rejects with it, so a test drives the real runDeviceCommand failure (a plain Error) or the admin-guidance
  // (a ProtectAuthorizationError) branch.
  public playRejection: Nullable<Error> = null;
  // The recorded update payloads the doorbell's cross-device setChimeVolume dispatches into (the single-entry ringSettings PATCH for this doorbell's ring), so a test
  // asserts the exact write payload. The shape stays general because the write carries the per-doorbell ring PATCH.
  public readonly updateCalls: { payload: unknown }[] = [];
  // The settable rejection for the volume write, kept DISTINCT from playRejection (two independent levers, never overloaded): when set, the next update rejects with it,
  // so a test drives the real runDeviceCommand failure branch (a plain Error or a ProtectAuthorizationError) on the chime-volume write specifically.
  public updateRejection: Nullable<Error> = null;
  private readonly store: TestStateStore;

  public constructor(id: string, store: TestStateStore) {

    this.id = id;
    this.store = store;
  }

  // Read-through config into the store double's current state, mirroring the real projection's absent-record guard.
  public get config(): Readonly<ProtectChimeConfig> {

    const config = this.store.snapshot().chimes.get(this.id);

    if(!config) {

      throw new ReferenceError("The chime record is not present in the store double: " + this.id + ".");
    }

    return config;
  }

  // The non-throwing companion to config, mirroring the real projection's peek(): the current config, or undefined when the record is absent from the store double.
  public peek(): Readonly<ProtectChimeConfig> | undefined {

    return this.store.snapshot().chimes.get(this.id) ?? undefined;
  }

  // Whether the device is currently connected, per the library's isDeviceOnline definition.
  public get isOnline(): boolean {

    return this.config.state === "CONNECTED";
  }

  // The device's display name - its user-assigned name when set, otherwise the controller's displayName, per the DeviceProjection convention.
  public get name(): string {

    return this.config.name ?? this.config.displayName;
  }

  // Record a buzzer play and resolve, or reject with the settable rejection so a test drives the failure path.
  public async playBuzzer(opts?: { signal?: AbortSignal }): Promise<void> {

    this.playBuzzerCalls.push({ opts });

    if(this.playRejection) {

      throw this.playRejection;
    }
  }

  // Record a speaker play with its joined payload and resolve, or reject with the settable rejection so a test drives the failure path.
  public async playSpeaker(opts: PlaySpeakerOptions = {}): Promise<void> {

    this.playSpeakerCalls.push({ opts });

    if(this.playRejection) {

      throw this.playRejection;
    }
  }

  // Record a volume-write update payload and resolve with this projection, or reject with the settable updateRejection so a test drives the real runDeviceCommand failure
  // path on the doorbell's cross-device chime-volume write. It RECORDS ONLY - it does NOT fold the payload into the store, so the volume reflection stays observer-driven
  // and the command and the reflection are independently asserted.
  public async update(payload: unknown): Promise<this> {

    this.updateCalls.push({ payload });

    if(this.updateRejection) {

      throw this.updateRejection;
    }

    return this;
  }
}

/* The Viewer projection double, the viewer-family analog of TestLightProjection: a stable id, the "viewer" modelKey discriminant, a READ-THROUGH config getter into the
 * store double's CURRENT state (never a held snapshot - a push must change what this.ufp returns, or an end-to-end observe test proves nothing), and the derived name /
 * isOnline getters. Unlike the read-only Light / Camera projections, the viewer drives its controller through the write-through update command, so this double exposes an
 * update that RECORDS its payload and resolves by default, with a settable updateRejection so a test can drive the real runDeviceCommand failure path. It records only -
 * it deliberately does NOT fold the payload back into the store, because the viewer's active-liveview reflection is observer-driven (setViewer does not update the local
 * config); a test drives that reflection through pushViewerPatch, keeping the command and the reflection independently asserted.
 */
export class TestViewerProjection {

  public readonly id: string;
  public readonly modelKey = "viewer" as const;
  // The recorded update payloads the real setViewer dispatches, so a test asserts the exact write-through liveview payload.
  public readonly updateCalls: { liveview: Nullable<string> }[] = [];
  // The settable rejection: when set, the next update rejects with it, so a test drives the real runDeviceCommand failure branch.
  public updateRejection: Nullable<Error> = null;
  private readonly store: TestStateStore;

  public constructor(id: string, store: TestStateStore) {

    this.id = id;
    this.store = store;
  }

  // Read-through config into the store double's current state, mirroring the real projection's absent-record guard.
  public get config(): Readonly<ProtectViewerConfig> {

    const config = this.store.snapshot().viewers.get(this.id);

    if(!config) {

      throw new ReferenceError("The viewer record is not present in the store double: " + this.id + ".");
    }

    return config;
  }

  // The non-throwing companion to config, mirroring the real projection's peek(): the current config, or undefined when the record is absent from the store double.
  public peek(): Readonly<ProtectViewerConfig> | undefined {

    return this.store.snapshot().viewers.get(this.id) ?? undefined;
  }

  // Whether the device is currently connected, per the library's isDeviceOnline definition.
  public get isOnline(): boolean {

    return this.config.state === "CONNECTED";
  }

  // The device's display name - its user-assigned name when set, otherwise the controller's displayName, per the DeviceProjection convention.
  public get name(): string {

    return this.config.name ?? this.config.displayName;
  }

  // Record an update payload and resolve with this projection, or reject with the settable rejection so a test drives the failure path. The payload is recorded only;
  // it is NOT folded into the store, so the active-liveview reflection stays observer-driven (a test pushes the reflection through pushViewerPatch).
  public async update(payload: { liveview: Nullable<string> }): Promise<this> {

    this.updateCalls.push({ liveview: payload.liveview });

    if(this.updateRejection) {

      throw this.updateRejection;
    }

    return this;
  }
}

/* The Sensor projection double, the sensor-family analog of TestViewerProjection: a stable id, the "sensor" modelKey discriminant, a READ-THROUGH config getter into the
 * store double's CURRENT state (never a held snapshot - a push must change what this.ufp returns, or an end-to-end observe test proves nothing), and the derived name /
 * isOnline getters using the projection's own definitions. Like the viewer it exposes a write-through update that RECORDS its payload and resolves by default, with a
 * settable updateRejection so a test drives the real runDeviceCommand failure path (the sensor's status-LED command writes ledSettings through it). It RECORDS only - it
 * deliberately does NOT fold the payload back into the store, mirroring the viewer: the device-statusled concern test and the sensor family exercise that recorder later,
 * while the device-motion base-capability net rides on it purely as the read-through carrier. The payload is recorded as the raw value so the recorder is general across
 * every command shape driven through it.
 */
export class TestSensorProjection {

  public readonly id: string;
  public readonly modelKey = "sensor" as const;
  // The recorded update payloads the real write-through commands dispatch, so a test asserts the exact payload (the status-LED ledSettings write, for example).
  public readonly updateCalls: { payload: unknown }[] = [];
  // The settable rejection: when set, the next update rejects with it, so a test drives the real runDeviceCommand failure branch.
  public updateRejection: Nullable<Error> = null;
  private readonly store: TestStateStore;

  public constructor(id: string, store: TestStateStore) {

    this.id = id;
    this.store = store;
  }

  // Read-through config into the store double's current state, mirroring the real projection's absent-record guard.
  public get config(): Readonly<ProtectSensorConfig> {

    const config = this.store.snapshot().sensors.get(this.id);

    if(!config) {

      throw new ReferenceError("The sensor record is not present in the store double: " + this.id + ".");
    }

    return config;
  }

  // The non-throwing companion to config, mirroring the real projection's peek(): the current config, or undefined when the record is absent from the store double.
  public peek(): Readonly<ProtectSensorConfig> | undefined {

    return this.store.snapshot().sensors.get(this.id) ?? undefined;
  }

  // Whether the device is currently connected, per the library's isDeviceOnline definition.
  public get isOnline(): boolean {

    return this.config.state === "CONNECTED";
  }

  // The device's display name - its user-assigned name when set, otherwise the controller's displayName, per the DeviceProjection convention.
  public get name(): string {

    return this.config.name ?? this.config.displayName;
  }

  // Record an update payload and resolve with this projection, or reject with the settable rejection so a test drives the failure path. The payload is recorded only; it
  // is NOT folded into the store, mirroring the viewer projection - a reactive reflection that stays observer-driven through a push helper.
  public async update(payload: unknown): Promise<this> {

    this.updateCalls.push({ payload });

    if(this.updateRejection) {

      throw this.updateRejection;
    }

    return this;
  }
}

/* The Relay projection double, the relay-family analog of TestSensorProjection: a stable id, the "relay" modelKey discriminant, a READ-THROUGH config getter into the
 * store double's CURRENT state (never a held snapshot - a push must change what this.ufp returns, or an end-to-end observe test proves nothing), and the derived name /
 * isOnline getters using the projection's own definitions. Unlike the read-only Light / Sensor projections it exposes TWO command surfaces the real ProtectRelay drives:
 * the write-through update the status-LED switch issues (recording its ledSettings payload), and the faithful toggleOutput primitive the set-to-toggle guard dispatches
 * (recording each toggled output id). Each records-but-does-not-fold and resolves by default, with a settable updateRejection / toggleRejection kept DISTINCT - so the
 * LED-write failure drive and the toggle failure drive are two independent levers, never overloaded - so a test drives the real runDeviceCommand failure path on either.
 * The output-state reflection stays observer-driven: a test moves it through pushRelayPatch, keeping the toggle command and its reflection independently asserted.
 */
export class TestRelayProjection {

  public readonly id: string;
  public readonly modelKey = "relay" as const;
  // The recorded output ids the real set-to-toggle guard dispatches into via toggleOutput, so a test asserts exactly which outputs were toggled (and how many times).
  public readonly toggleCalls: { outputId: number }[] = [];
  // The settable rejection for the toggle command, kept DISTINCT from updateRejection: when set, the next toggleOutput rejects with it, so a test drives the real
  // runDeviceCommand failure branch on the toggle specifically.
  public toggleRejection: Nullable<Error> = null;
  // The recorded update payloads the status-LED switch's write-through command dispatches (the ledSettings.isEnabled write), so a test asserts the exact payload.
  public readonly updateCalls: { payload: unknown }[] = [];
  // The settable rejection for the LED write, kept DISTINCT from toggleRejection: when set, the next update rejects with it, so a test drives the real runDeviceCommand
  // failure branch on the status-LED write specifically.
  public updateRejection: Nullable<Error> = null;
  private readonly store: TestStateStore;

  public constructor(id: string, store: TestStateStore) {

    this.id = id;
    this.store = store;
  }

  // Read-through config into the store double's current state, mirroring the real projection's absent-record guard.
  public get config(): Readonly<ProtectRelayConfig> {

    const config = this.store.snapshot().relays.get(this.id);

    if(!config) {

      throw new ReferenceError("The relay record is not present in the store double: " + this.id + ".");
    }

    return config;
  }

  // The non-throwing companion to config, mirroring the real projection's peek(): the current config, or undefined when the record is absent from the store double.
  public peek(): Readonly<ProtectRelayConfig> | undefined {

    return this.store.snapshot().relays.get(this.id) ?? undefined;
  }

  // Whether the device is currently connected, per the library's isDeviceOnline definition.
  public get isOnline(): boolean {

    return this.config.state === "CONNECTED";
  }

  // The device's display name - its user-assigned name when set, otherwise the controller's displayName, per the DeviceProjection convention.
  public get name(): string {

    return this.config.name ?? this.config.displayName;
  }

  // Toggle one output: record the output id and resolve, or reject with the settable rejection so a test drives the real runDeviceCommand failure path. It records ONLY -
  // it deliberately does NOT fold the flip into the store, mirroring the controller's write-through grain; a test reflects the resulting output state through
  // pushRelayPatch so the command and its reflection stay independently asserted.
  public async toggleOutput(outputId: number): Promise<void> {

    this.toggleCalls.push({ outputId });

    if(this.toggleRejection) {

      throw this.toggleRejection;
    }
  }

  // Record an update payload (the status-LED ledSettings write) and resolve with this projection, or reject with the settable rejection so a test drives the failure
  // path. Records only; it does NOT fold the payload into the store, mirroring the sensor projection.
  public async update(payload: unknown): Promise<this> {

    this.updateCalls.push({ payload });

    if(this.updateRejection) {

      throw this.updateRejection;
    }

    return this;
  }
}

/* The shared minimal base-capability vehicle: a concrete ProtectDevice leaf whose constructor ONLY super()s, so it stands up the real base with no family configureDevice
 * confound, and which exposes the protected base capability methods as public test windows. It generalizes the command-error suite's TestProtectDevice (which exposes
 * runDeviceCommand as runCommand) into the ONE vehicle every device-<capability> concern test reuses: each concern test drives the one base capability it owns against
 * this leaf, so the cross-cutting base behaviors (the motion switch / trigger, the occupancy sensor, the status-LED switch, device info, hints,
 * and the observer spawn) are netted family-agnostically rather than inside any family suite.
 *
 * The windows grow additively, each added and exercised alongside the capability it serves, so the vehicle never ships an exposed method no test drives: the motion
 * and hints windows landed first (configureHintsFor, which a concern test populates this.hints through before the motion configurators read it; configureMotionSensorFor;
 * configureOccupancySensorFor), the status-indicator window (configureStatusLedSwitchFor) joined them netted by device-statusled.test.ts, and the device-information and
 * observer-spawn windows (configureInfoFor; spawnObserversFor) joined netted by device-info.test.ts. Any remaining windows join the same way.
 *
 * The device handle is narrowed to a Sensor projection (the all-quiet makeSensorConfig carrier rides on TestSensorProjection), and ufp is overridden to read through it,
 * mirroring how each family leaf narrows its own projection at construction.
 */
export class TestBaseDevice extends ProtectDevice {

  declare protected readonly device: Sensor;

  // Read-through to the sensor projection, narrowing the base's union getter to the concrete Sensor config the carrier supplies.
  public override get ufp(): Readonly<ProtectSensorConfig> {

    return this.device.config;
  }

  // Public window onto the base configureHints, so a concern test populates this.hints (the motion configurators read this.hints) before driving a capability.
  public configureHintsFor(): boolean {

    return this.configureHints();
  }

  // Public window onto the base configureMotionSensor (the motion sensor service plus the motion switch / trigger and the motion get/set MQTT seam).
  public configureMotionSensorFor(isEnabled = true, isInitialized = false): boolean {

    return this.configureMotionSensor(isEnabled, isInitialized);
  }

  // Public window onto the base configureOccupancySensor (the occupancy service plus its StatusActive / OccupancyDetected characteristics and the occupancy MQTT get).
  public configureOccupancySensorFor(isEnabled = true, isInitialized = false): boolean {

    return this.configureOccupancySensor(isEnabled, isInitialized);
  }

  // Public window onto the base configureStatusLedSwitch (the Device.StatusLed.Switch accessory: its On onGet/onSet reading and writing the status indicator light
  // through setStatusLed -> statusLedCommand -> device.update({ ledSettings })). This joins the motion / hints windows above as additive growth - each capability
  // window added and tested with the change that needs it; the deep status-LED nets live in device-statusled.test.ts.
  public configureStatusLedSwitchFor(isEnabled = true): boolean {

    return this.configureStatusLedSwitch(isEnabled);
  }

  // Public window onto the base configureInfo (the AccessoryInformation Manufacturer / Model / SerialNumber / FirmwareRevision writes via setInfo, plus the
  // syncName-gated accessoryName sync). This joins the motion / hints / status-LED windows above as additive growth - each capability window added and tested with
  // the change that needs it; the deep device-info nets live in device-info.test.ts.
  public configureInfoFor(): boolean {

    return this.configureInfo();
  }

  // Public window onto the base spawnObservers (the two universal device observers: device.name -> syncNameFromController and device.firmwareVersion -> configureInfo).
  // A concern test calls this after configureHintsFor / configureInfoFor to register the observers, then settles the lazy registration before asserting the reactions.
  public spawnObserversFor(): void {

    this.spawnObservers();
  }
}

/* The stub StreamingDelegate, typed as the abstraction and entirely FFmpeg-free. The controller is a distinct sentinel object tests can identity-match
 * through the accessory's controller-event log; ffmpegOptions is the one documented cast seam on this class (only maxSourcePixels is read on the camera family's
 * paths, and only via selectRecordingChannel - never at construction), with the ceiling injectable so the recording-channel pixel cap is exercisable with a finite
 * value; hksv is null, the correct pre-HKSV-configuration state cleanup reads through this.stream?.hksv?.isRecording; shutdown records its calls; and
 * resetProbesizeOverride is a recordable no-op.
 */
export class TestStreamingDelegate implements StreamingDelegate {

  // The frozen audio-options identity this stub controller was built for, mirroring production's ProtectStreamingDelegate.builtFor so the live capability reconcile's
  // staleness check (rebuild only when a frozen audio capability has appeared since this.stream.builtFor) exercises against the real value the factory recorded at create
  // time.
  public readonly builtFor: AudioOptionsIdentity;
  public controller: CameraController;
  public readonly ffmpegOptions: StreamingDelegate["ffmpegOptions"];
  public hksv: StreamingDelegate["hksv"];
  public readonly probesize: number;
  // How many times production tore this delegate down - cleanup and the NVR disconnect walk both call shutdown.
  public shutdownCalls = 0;

  public constructor(builtFor: AudioOptionsIdentity = { isDoorbell: false, twoWayAudio: false }, maxSourcePixels = Infinity) {

    this.builtFor = builtFor;

    // The identity sentinel: a plain object the test matches by reference. The double never operates on the controller's innards - HAP's controller is opaque to
    // the camera beyond registration.
    this.controller = { hbupTestSentinel: "camera-controller" } as unknown as CameraController;

    // The confined cast seam: the camera family reads only maxSourcePixels off ffmpegOptions, and an Infinity ceiling means "no hardware pixel cap" - the
    // pass-everything-through default. A finite injected ceiling lets the recording-channel cap path select against a real constraint.
    this.ffmpegOptions = { maxSourcePixels: (): number => maxSourcePixels } as unknown as StreamingDelegate["ffmpegOptions"];
    this.hksv = null;

    // The fixed probesize the stub advertises - consumers read it through camera.stream.probesize; an inert test value with no behavioral role in the suites.
    this.probesize = 16384;
  }

  // The snapshot entry point is async fire-and-forget on the paths that reach it; the stub resolves immediately.
  public async handleSnapshotRequest(): Promise<void> {

    // Nothing to do - the stub takes no snapshots.
  }

  public resetProbesizeOverride(): void {

    // Nothing to reset - the stub holds no probesize override state.
  }

  public shutdown(): void {

    // Nothing to tear down beyond the record - the stub holds no FFmpeg sessions.
    this.shutdownCalls++;
  }
}

// The stub StreamingDelegateFactory satisfying the platform's dependency-inversion seam. Records every create call (the camera identity, the resolutions array,
// and the delegate it returned) so tests can assert the seam was exercised exactly once with exactly the advertised resolutions, then hand back the recorded
// delegate's sentinel controller for identity assertions. The maxSourcePixels ceiling is forwarded into every delegate it creates - set it before construction to
// exercise the recording-channel pixel cap with a finite value.
export class TestStreamingDelegateFactory implements StreamingDelegateFactory {

  public readonly createCalls: { camera: ProtectCameraHost; delegate: TestStreamingDelegate; resolutions: Resolution[] }[] = [];
  public maxSourcePixels = Infinity;

  public create(camera: ProtectCameraHost, resolutions: Resolution[]): StreamingDelegate {

    // Capture the camera's frozen audio identity - both isDoorbell and the speaker-derived two-way audio hint - exactly as production's ProtectStreamingDelegate
    // reads them at its own construction. This makes a construction whose capabilities are present yield a delegate already built for the current identity, so the
    // capability reconcile's staleness check is a no-op (zero controller churn), and only a genuine late capability - a delegate built before it appeared - rebuilds.
    const delegate = new TestStreamingDelegate({ isDoorbell: camera.ufp.featureFlags.isDoorbell, twoWayAudio: camera.hints.twoWayAudio }, this.maxSourcePixels);

    this.createCalls.push({ camera, delegate, resolutions });

    return delegate;
  }
}

/* The reusable camera-host test double: the small stand-in every media-delegate test constructs a delegate against, in place of a full ProtectCamera. The
 * ProtectCameraHost interface segregation (the dependency-inversion seam on the camera side of the media stack) exists precisely so the streaming, recording,
 * snapshot, and timeshift delegates type their camera handle as this narrow contract rather than the concrete class - and this double is what cashes that in: it
 * structurally satisfies all 22 members of ProtectCameraHost (the same compile-time proof the production ProtectCamera passes), so a delegate constructs against it
 * with no FFmpeg and no live camera.
 *
 * The shape mirrors TestStreamingDelegate's discipline: controllable fields a test sets to steer a branch (isReachable is the behavior-bearing one - the snapshot
 * delegate's reachability gate reads it), recordable call logs the behavior-bearing seams push their arguments into (so a later test asserts a seam was invoked),
 * and settable seam returns (snapshotResult is the Buffer snapshotFromController resolves, the value the two-sided snapshot test threads through the delegate).
 *
 * The context half composes the EXISTING harness doubles rather than reinventing them: accessory is a real TestAccessory, and nvr/platform/api/log all flow from a
 * real makeTestNvr context (so the very next behavior step, which reads platform.codecSupport and nvr.mqtt, finds real doubles there, not sentinels that would
 * throw). The four context handles (accessory/api/nvr/platform) plus ufp are typed as their production types by the interface, which the intentionally-partial
 * doubles do not structurally satisfy, so each is bridged with a confined `as unknown as <ProductionType>` seam cast - the same honest harness pattern the
 * construction suites use at their own construction-arg boundaries. The casts bridge the deliberate double->production gap only; tsc still verifies every one of the
 * 22 members is present and interface-typed, so the completeness proof holds.
 *
 * Member order mirrors TestStreamingDelegate: the fields group alphabetized, then the methods group alphabetized (not one global run). The settable seam predicates
 * hasFeature / selectChannel / selectRecordingChannel are public arrow-function fields so a test can reassign them, satisfying the interface's method members.
 */
export class TestCameraHost implements ProtectCameraHost {

  public accessory: ProtectAccessory;
  public accessoryName = "Test Camera";
  public api: API;

  // The settable feature predicate; defaults to "no feature enabled", the quiet default the delegate construction paths read against.
  public hasFeature: (option: string) => boolean = () => false;

  // A complete neutral ProtectHints literal - every boolean false, every number 0, every string empty, the nested cropOptions zeroed - so a delegate reads a fully
  // populated hint bag with no behavior turned on (crop false is load-bearing for the two-sided snapshot test, which must NOT enter the crop pass).
  public hints: ProtectHints = {

    crop: false,
    cropOptions: { height: 0, width: 0, x: 0, y: 0 },
    enabled: false,
    hardwareDecoding: false,
    hardwareTranscoding: false,
    highResSnapshots: false,
    hksvRecordingIndicator: false,
    ledStatus: false,
    logDoorbell: false,
    logHksv: false,
    logMotion: false,
    motionDuration: 0,
    nightVision: false,
    occupancyDuration: 0,
    probesize: 0,
    recordingDefault: "",
    smartDetect: false,
    smartDetectSensors: false,
    smartOccupancy: [],
    standalone: false,
    streamingDefault: "",
    syncName: false,
    transcode: false,
    transcodeBitrate: 0,
    transcodeHighLatency: false,
    transcodeHighLatencyBitrate: 0,
    tsbStreaming: false,
    twoWayAudio: false,
    twoWayAudioDirect: false
  };

  // Whether this camera can back HomeKit Secure Video. Settable so a recording-behavior test can flip it; defaults false.
  public isHksvCapable = false;

  // The behavior-bearing reachability gate: the snapshot delegate returns null before any pipeline when this is false, so the two-sided snapshot test sets it both
  // ways. Defaults true.
  public isReachable = true;

  // Recordable call logs: each behavior-bearing seam pushes its arguments here so a later test can assert the seam was invoked exactly as expected.
  public readonly livestreamCalls: { channelProfile: ChannelProfile; opts?: { segmentLength?: number; signal?: AbortSignal; urgency?: () => number } }[] = [];

  // The segment-count knob the transmit test sets to fill the timeshift buffer: the number of keyframe-bearing media segments livestream() yields. Defaults 0, which
  // returns the inert (segment-less) livestream double so the construction suites stay on their unchanged path.
  public livestreamMediaSegments = 0;

  // The queue of test-provided subscriptions livestream() hands out in order: each call shifts the head, so a single start consumes one, and a start-twice or
  // id-identity test supplies two DISTINCT-id controllable doubles. When the queue is empty, livestream() falls back to the livestreamMediaSegments-selected parking /
  // inert double - the unchanged path the construction and recording-transmit suites stay on (they never set this queue).
  public livestreamSubscriptions: LivestreamSubscription[] = [];
  public log: HomebridgePluginLogging;

  // The bare device MAC for topic addressing, read through the device projection so it stays consistent with the ufp fixture's mac even if a test reassigns ufp. This is
  // the identity the narrowed live-state view no longer carries; a delegate reads it (the MQTT snapshot topic) through protectCamera.mac.
  public get mac(): string {

    return this.ufp.mac;
  }

  public nvr: ProtectNvr;
  public platform: ProtectPlatform;
  public readonly rebootCalls: number[] = [];

  // The error reboot() rejects with when set (default undefined = reboot resolves). A self-heal test sets this to drive the reboot-failure branch, where the timeshift
  // logs that the camera could not be rebooted; the call is still recorded in rebootCalls before the rejection, matching production's invoke-then-fail ordering.
  public rebootError?: Error;

  // The settable channel selectors; default null (no profile resolved), so the snapshot RTSP source - which would call selectChannel - never proceeds past its own
  // !stream guard anyway, keeping the two-sided test on the controller path.
  public selectChannel: (width: number, height: number, opts?: { biasHigher?: boolean; maxPixels?: number }) => Nullable<ChannelProfile> = () => null;
  public selectRecordingChannel: (width: number, height: number) => Nullable<ChannelProfile> = () => null;
  public readonly setStatusLedCalls: boolean[] = [];

  // The settable Buffer snapshotFromController resolves - the value the two-sided snapshot test threads through the delegate's controller source.
  public snapshotResult: Buffer = Buffer.from("test-snapshot");
  public readonly snapshotFromControllerCalls: SnapshotOptions[] = [];

  // The streaming delegate handle the snapshot/recording/timeshift consumers read; default undefined so the snapshot timeshift/RTSP sources early-return on their
  // !stream guards and the pipeline falls through to the controller source.
  public stream: StreamingDelegate | undefined = undefined;
  public readonly talkbackCalls: { signal?: AbortSignal }[] = [];

  // The camera-narrowed Protect device projection; settable, default a G2 Pro config so featureFlags / videoCodec reads resolve to a real record.
  public ufp: Readonly<ProtectCameraConfig>;
  public videoCodecName = "h264";

  // Compose the context half from real harness doubles, bridging each to its interface-required production type at the confined seam.
  public constructor(init: { accessory: TestAccessory; nvr: TestProtectNvr }) {

    // The double is a partial TestAccessory; the interface requires the production ProtectAccessory. The confined seam cast bridges the deliberate gap.
    this.accessory = init.accessory as unknown as ProtectAccessory;

    // The api/log/platform/nvr handles all flow from the real makeTestNvr context. Each is a partial double the interface types as a production handle, so each
    // takes the same confined seam cast.
    this.api = init.nvr.platform.api as unknown as API;
    this.log = init.nvr.log;
    this.nvr = init.nvr as unknown as ProtectNvr;
    this.platform = init.nvr.platform as unknown as ProtectPlatform;

    // The ufp record is the ONE confined cast makeCameraConfig already documents (it populates the verified read set and casts once to the full wire type), reused
    // here verbatim for the host's device projection.
    this.ufp = makeCameraConfig({ channels: G2_PRO_CHANNELS });
  }

  // The FFmpeg audio-filter chain; the stub builds none.
  public getAudioFilters(): string[] {

    return [];
  }

  // The recordable livestream seam. It records its arguments and hands back a LivestreamSubscription double whose profile is selected by this host's
  // livestreamMediaSegments knob: the default 0 yields the inert double (empty iterator, no-op dispose, "closed" state) the construction suites stay on, while a
  // positive count yields the established segment-yielding double (one init then that many keyframe-bearing media segments, then a parked iterator) the transmit net
  // fills its timeshift buffer from.
  public livestream(channelProfile: ChannelProfile, opts?: { segmentLength?: number; signal?: AbortSignal; urgency?: () => number }): LivestreamSubscription {

    this.livestreamCalls.push({ channelProfile, opts });

    // Hand out the next test-provided subscription from the queue, if any; otherwise fall back to the livestreamMediaSegments-selected parking / inert double. The queue
    // path is how a standalone timeshift test drives the SUT with a controllable double (and supplies two distinct doubles for the restart / id-identity targets); the
    // fallback preserves the unchanged behavior the construction and recording-transmit suites depend on (they never set the queue).
    return this.livestreamSubscriptions.shift() ?? makeLivestreamSubscriptionDouble({ mediaSegments: this.livestreamMediaSegments });
  }

  // The recordable reboot seam; records the call, then rejects with rebootError when one is set (the self-heal reboot-failure path) or resolves otherwise.
  public async reboot(): Promise<void> {

    this.rebootCalls.push(this.rebootCalls.length + 1);

    if(this.rebootError !== undefined) {

      throw this.rebootError;
    }
  }

  // The recordable status-LED seam; records every requested value and resolves true.
  public async setStatusLed(value: boolean): Promise<boolean> {

    this.setStatusLedCalls.push(value);

    return true;
  }

  // The behavior-bearing controller-snapshot seam: records the options and resolves the settable snapshotResult Buffer - the value the two-sided snapshot test
  // observes flow through the delegate's controller source.
  public async snapshotFromController(opts?: SnapshotOptions): Promise<Buffer> {

    this.snapshotFromControllerCalls.push(opts ?? {});

    return this.snapshotResult;
  }

  // The recordable talkback seam. NOT exercised by the construction suites - TalkbackSession has a private constructor and #private fields, so there is no
  // constructible literal; the never-called stub returns a confined sentinel cast, the same harness pattern TestStreamingDelegate uses for its opaque
  // CameraController sentinel.
  public async talkback(opts?: { signal?: AbortSignal }): Promise<TalkbackSession> {

    this.talkbackCalls.push(opts ?? {});

    // The opaque sentinel: TalkbackSession is uninstantiable from a test, and the construction suites never call talkback, so the return is a confined cast no
    // path reads.
    return { hbupTestSentinel: "talkback-session" } as unknown as TalkbackSession;
  }
}

// Write a single ISO BMFF box: a BOX_HEADER_SIZE-byte header (a 4-byte big-endian size covering the whole box, then the 4-byte ASCII type) followed by the
// body. We import BOX_HEADER_SIZE from homebridge-plugin-utils rather than hardcoding 8 so the offset is single-sourced with the very constant the real
// isKeyframe parse uses to walk these boxes.
function makeBox(type: string, body: Buffer): Buffer {

  const header = Buffer.alloc(BOX_HEADER_SIZE);

  header.writeUInt32BE(BOX_HEADER_SIZE + body.length, 0);
  header.write(type, 4, "ascii");

  return Buffer.concat([ header, body ]);
}

// Synthesize a genuine fMP4 media fragment so the production isKeyframe TRUN-flag parse runs against REAL bytes on the REAL path - no isKeyframe injection seam, so the
// test exercises the actual fMP4 keyframe coupling rather than a test-only divergence. The fragment is moof>traf>trun with a 16-byte trun body: the fullbox version/flags
// word sets TRUN_FLAG_DATA_OFFSET and TRUN_FLAG_FIRST_SAMPLE_FLAGS so the parse reads a first_sample_flags field, sample_count is 1, and data_offset is 0. The ONLY
// difference between a keyframe and a non-keyframe fragment is that first_sample_flags word (offset 12): 0 leaves the SAMPLE_FLAG_NON_SYNC bit clear, marking a sync
// sample (a keyframe), while SAMPLE_FLAG_NON_SYNC sets it, marking a non-sync sample (a non-keyframe) the production parse rejects. The mdat carries an empty body - the
// timeshift never decodes the payload, it only parses the moof for keyframe-ness and concatenates the bytes. The returned data buffer is the moof+mdat pair a media
// Segment delivers. This is the single source of truth for both fragment kinds; makeKeyframeFragment and makeNonKeyframeFragment are the two thin selectors over it.
function makeMediaFragment(options: { keyframe?: boolean } = {}): { data: Buffer; mdat: Buffer; moof: Buffer } {

  const keyframe = options.keyframe ?? true;
  const trunBody = Buffer.alloc(16);

  trunBody.writeUInt32BE(TRUN_FLAG_DATA_OFFSET | TRUN_FLAG_FIRST_SAMPLE_FLAGS, 0);
  trunBody.writeUInt32BE(1, 4);
  trunBody.writeUInt32BE(0, 8);
  trunBody.writeUInt32BE(keyframe ? 0 : SAMPLE_FLAG_NON_SYNC, 12);

  const moof = makeBox("moof", makeBox("traf", makeBox("trun", trunBody)));
  const mdat = makeBox("mdat", Buffer.alloc(0));

  return { data: Buffer.concat([ moof, mdat ]), mdat, moof };
}

// The keyframe-bearing fragment: makeMediaFragment with its default keyframe-true selection, so the production isKeyframe parse returns true. This is a thin
// wrapper whose default keyframe path writes first_sample_flags 0, so the KEYFRAME_FRAGMENT const, the segment-yielding parking double, and the keyframe
// self-test all read the identical bytes.
export function makeKeyframeFragment(): { data: Buffer; mdat: Buffer; moof: Buffer } {

  return makeMediaFragment();
}

// The non-keyframe-bearing fragment: makeMediaFragment with keyframe false, so the trun first_sample_flags carries SAMPLE_FLAG_NON_SYNC and the production isKeyframe
// parse returns false on the REAL path. The timeshift suite pushes this through the controllable double to exercise the discontinuity keyframe-gate (a
// discontinuity-marked non-keyframe must defer the discontinuity emit until a clean keyframe arrives) and to drive any non-keyframe classification. Built at the use
// site rather than cached in a module const so there is no unused-when-the-suite-changes SSOT cruft to drift.
export function makeNonKeyframeFragment(): { data: Buffer; mdat: Buffer; moof: Buffer } {

  return makeMediaFragment({ keyframe: false });
}

// The one keyframe fragment and init buffer the segment-yielding double reuses across every yield. The timeshift never mutates segment bytes (it parses and concatenates
// them), so sharing one instance is safe and avoids re-synthesizing the boxes per call.
const KEYFRAME_FRAGMENT = makeKeyframeFragment();
const INIT_SEGMENT_DATA = Buffer.from("test-init-segment");

/* Build a LivestreamSubscription double for the camera-host stub's livestream seam, in one of two profiles selected by the requested media-segment count:
 *
 *   - mediaSegments === 0 (the default): the byte-identical INERT profile the construction tests rely on - initSegment null, state "closed", whenEstablished resolves
 *     false, an empty iterator, no-op reassess/dispose. The construction suites never exercise it; it exists only so the host's livestream return type-checks
 *     against the production type.
 *   - mediaSegments > 0: the ESTABLISHED segment-yielding profile - initSegment populated, state "live", whenEstablished resolves true, and an iterator yielding one init
 *     segment then mediaSegments keyframe-bearing media segments so the timeshift fills its buffer with real fMP4 the production isKeyframe parse accepts.
 *
 * LOAD-BEARING: after yielding its media segments the established iterator MUST PARK, never completing. A finite generator returns done, which ends the timeshift's
 * consumeSegments for-await, runs its finally -> finalizeSubscription -> clearBuffer, and wipes the just-filled buffer (the this.subscription?.id === subscription.id
 * guard is true by then, because start() commits this.subscription mid-drain) - so timeshift.time falls back to zero and the transmit gate would always decline. We park
 * by owning an internal AbortController: [Symbol.asyncDispose] aborts it, and the generator, after its media loop, awaits a promise that resolves on that abort (resolves
 * immediately if already aborted, else via a one-shot "abort" listener). The for-await therefore never completes while filling, the buffer survives, and a real
 * timeshift.stop()/dispose still releases it cleanly. whenEstablished resolves true immediately while the consumer fills its buffer by draining the parking iterator to
 * its park point; a single settle() in the test drains all the microtask-resolved yields before the park, because the generator crosses no macrotask/timer boundary (were
 * one ever added, a single settle() would silently under-drain).
 */
export function makeLivestreamSubscriptionDouble(options: { mediaSegments?: number } = {}): LivestreamSubscription {

  const mediaSegments = options.mediaSegments ?? 0;

  // The inert profile: preserved byte-for-byte so the construction suites stay green.
  if(mediaSegments === 0) {

    return {

      id: "test-livestream-subscription",
      initSegment: null,
      reassess: (): void => { /* No-op: the double has no recovery loop to re-decide. */ },
      state: "closed",
      whenEstablished: async (): Promise<boolean> => false,
      [Symbol.asyncIterator]: async function *(): AsyncGenerator<Segment> { /* The double delivers no segments. */ },
      [Symbol.asyncDispose]: async (): Promise<void> => { /* No-op: the double owns no resources to release. */ }
    };
  }

  // The established profile owns a dispose-abort controller so its iterator can park after the media loop. Disposing aborts it, releasing the park.
  const disposed = new AbortController();

  return {

    id: "test-livestream-subscription",
    initSegment: { codec: "h264", data: INIT_SEGMENT_DATA },
    reassess: (): void => { /* No-op: the double has no recovery loop to re-decide. */ },
    state: "live",
    whenEstablished: async (): Promise<boolean> => true,
    [Symbol.asyncIterator]: async function *(): AsyncGenerator<Segment> {

      yield { codec: "h264", data: INIT_SEGMENT_DATA, type: "init" };

      for(let i = 0; i < mediaSegments; i++) {

        yield { data: KEYFRAME_FRAGMENT.data, mdat: KEYFRAME_FRAGMENT.mdat, moof: KEYFRAME_FRAGMENT.moof, type: "media" };
      }

      // Park: await the dispose-abort so the consumer's for-await never completes and the filled buffer survives. Resolve immediately if already disposed, else on the
      // one-shot abort.
      await new Promise<void>((resolve) => {

        if(disposed.signal.aborted) {

          resolve();

          return;
        }

        disposed.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    },
    [Symbol.asyncDispose]: async (): Promise<void> => { disposed.abort(); }
  };
}

// A process-local monotonic counter minting a distinct default id per controllable double. Distinct ids are LOAD-BEARING: the timeshift's consumeSegments finally guards
// teardown on this.subscription?.id === subscription.id, so a restart test (start A, then start B) and the id-identity guard test need two doubles whose ids genuinely
// differ - or the guard cannot discriminate and the test is vacuous.
let controllableLivestreamCounter = 0;

/**
 * The controllable livestream-subscription double: a queue-driven LivestreamSubscription a test feeds segments into one at a time and can end or throw-into, plus a
 * recording surface for behavior-first assertions. It generalizes makeLivestreamSubscriptionDouble's drain-loop/park iterator so a standalone ProtectTimeshiftBuffer test
 * can drive the SUT's full emission/lifecycle surface (an init segment, keyframe and non-keyframe media, a discontinuity-marked segment, a graceful end, and an iterator
 * error) without a recording delegate in the loop.
 *
 * @property disposed       - True once the double's asyncDispose ran; a test asserts a start-validation failure or a stop disposed the subscription.
 * @property end            - Enqueue a graceful end. Processed AFTER any already-queued segments (drain-then-close), so queued media is never dropped, then the iterator
 *                            returns and the timeshift's consumeSegments finally runs.
 * @property push           - Enqueue one media (or init) segment and wake the iterator. One push plus one settle() processes exactly that one segment; MULTIPLE pushes
 *                            plus one settle() drain all of them in a single macrotask, so an intermediate-state test must settle() after EACH push.
 * @property reassessCalls  - The number of times the timeshift called reassess() (its transmit-start recovery escalation).
 * @property throwError     - Enqueue an iterator error. Processed after queued segments, then thrown into the for-await so the timeshift classifies it (and self-heals).
 */
export interface ControllableLivestreamDouble extends LivestreamSubscription {

  readonly disposed: boolean;
  end(): void;
  push(segment: Segment): void;
  readonly reassessCalls: number;
  throwError(error: unknown): void;
}

/* Build a controllable LivestreamSubscription double for a standalone timeshift behavior test.
 *
 * The iterator is the lost-wakeup-safe drain-loop the parking double established, generalized to a runtime-fed queue: it holds a queue of items
 * ({ kind: "segment" } | { kind: "end" } | { kind: "error" }), and on each turn it DRAINS THE WHOLE QUEUE - shifting and acting on every queued item (yield a segment,
 * return on end, throw on error) - and ONLY parks on a fresh one-shot resolver when the queue is empty and the double is not yet terminated; on wake it RE-CHECKS the
 * queue and continues the drain. Draining the whole queue per wake is load-bearing: a naive park/yield-one/re-park strands a second segment pushed under one wake
 * (empirically reproduced), so a two-push-then-drain self-test would observe only the first.
 *
 * The park keeps isStarted true: while the queue is open and the double is not ended/disposed the generator NEVER completes (it parks), so the timeshift's
 * consumeSegments for-await stays open, its finally does not run, the subscription stays committed, and timeshift.isStarted reports true. end()/throwError()/dispose are
 * the iterator-termination drivers that feed that finally: each enqueues its terminal item AFTER any queued segments (drain-then-close, so queued media is not
 * dropped) and wakes the iterator. whenEstablished resolves immediately (default true) so start() commits the subscription before the test pushes media.
 *
 * The terminal transition is one-shot and idempotent: once the generator has returned (end/dispose) or thrown (error), the double is terminated and push/end/throwError
 * and a second dispose are NO-OPS, and the parking resolver is resolved at most once (guarded so no double-resolve). asyncDispose records disposed = true and signals a
 * graceful end if the double is not already terminated.
 */
export function makeControllableLivestreamDouble(options: { id?: string; initSegment?: { codec: string; data: Buffer } | null; state?: LivestreamSubscriptionState;
  whenEstablished?: boolean; } = {}): ControllableLivestreamDouble {

  // The runtime-fed item queue and the lifecycle flags. terminated latches once the generator returns or throws, after which every control method no-ops.
  const queue: ({ kind: "segment"; segment: Segment } | { kind: "end" } | { kind: "error"; error: unknown })[] = [];
  let terminated = false;
  let disposed = false;
  let reassessCalls = 0;

  // Resolve the init segment, distinguishing "option omitted" (default to a populated init so start() commits) from "option explicitly null" (the start-validation arm
  // the timeshift declines on). A plain ?? cannot make that distinction - it treats an explicit null as nullish and would override it with the default - so we branch on
  // strict undefined.
  const initSegment = (options.initSegment === undefined) ? { codec: "h264", data: INIT_SEGMENT_DATA } : options.initSegment;

  // The one-shot park resolver: the generator stores its resolver here before awaiting, and wake() resolves and clears it. Holding at most one resolver and clearing it
  // on resolve guarantees no double-resolve and no stale wake.
  let wakeResolver: (() => void) | null = null;

  // Wake a parked generator, if one is parked. Resolving and clearing in one step keeps the resolver one-shot.
  const wake = (): void => {

    const resolve = wakeResolver;

    wakeResolver = null;
    resolve?.();
  };

  // Enqueue an item and wake the iterator, unless the double has already terminated (in which case every control method is a no-op).
  const enqueue = (item: { kind: "segment"; segment: Segment } | { kind: "end" } | { kind: "error"; error: unknown }): void => {

    if(terminated) {

      return;
    }

    queue.push(item);
    wake();
  };

  return {

    get disposed(): boolean {

      return disposed;
    },
    end: (): void => enqueue({ kind: "end" }),
    id: options.id ?? ("controllable-livestream-" + (++controllableLivestreamCounter).toString()),
    initSegment,
    push: (segment: Segment): void => enqueue({ kind: "segment", segment }),
    reassess: (): void => { reassessCalls++; },
    get reassessCalls(): number {

      return reassessCalls;
    },
    state: options.state ?? "live",
    throwError: (error: unknown): void => enqueue({ error, kind: "error" }),
    whenEstablished: async (): Promise<boolean> => options.whenEstablished ?? true,
    [Symbol.asyncIterator]: async function *(): AsyncGenerator<Segment> {

      // The drain-loop: process the whole queue, then park only when it is empty and we have not yet terminated. On wake, the outer while re-checks the queue.
      while(!terminated) {

        // Drain every queued item before considering a park, so no item pushed under a single wake is stranded.
        while(queue.length > 0) {

          const item = queue.shift();

          if(!item) {

            break;
          }

          switch(item.kind) {

            case "end": {

              terminated = true;

              return;
            }

            case "error": {

              terminated = true;

              throw item.error;
            }

            case "segment": {

              yield item.segment;

              break;
            }

            default: {

              throw new Error("The controllable livestream double received an unknown queue item kind.");
            }
          }
        }

        // The queue is empty and we have not terminated: park on a fresh one-shot resolver until a control method wakes us, then re-check the queue.
        if(!terminated) {

          // eslint-disable-next-line no-await-in-loop -- The park is intentionally serial: the generator suspends here until a push/end/throwError/dispose wakes it.
          await new Promise<void>((resolve) => { wakeResolver = resolve; });
        }
      }
    },
    [Symbol.asyncDispose]: async (): Promise<void> => {

      // Record the dispose and, if the double has not already terminated, signal a graceful end so the parked iterator completes its finally. Idempotent: a second
      // dispose after termination no-ops via the enqueue terminated-guard.
      disposed = true;
      enqueue({ kind: "end" });
    }
  };
}

/**
 * Build a TestCameraHost wired to a real makeTestNvr context, returning the host plus its test-side handles. This is the media-delegate counterpart to makeTestNvr:
 * it composes the existing doubles (a TestStateStore-backed makeTestNvr context and a TestAccessory) into the camera-host seam every media-delegate test constructs
 * against, so a delegate is unit-constructed with no real camera. The single seam casts live inside TestCameraHost's constructor (the doubles are not the
 * production handle types); the host returned here is the production-interface-typed double.
 *
 * @param options - clock: an optional controllable TestClock forwarded into the makeTestNvr platform double's clock seam and re-returned, so a transmit test holds the
 *                  exact instance the recording delegate reads via platform.clock and advances it to release pacing (omitted, a fresh default TestClock is created);
 *                  recordingProcessFactory: the test recording-process factory injected into the makeTestNvr platform double's recordingProcessFactory seam, so a
 *                  transmit test's delegate constructs its FFmpeg process through the test double (omitted, makeTestNvr installs a fresh default factory); userOptions:
 *                  feature-option config strings forwarded to the makeTestNvr context's REAL FeatureOptions engine (for a later behavior test that steers a feature-gated
 *                  delegate path); the default empty context is the quiet-default host.
 *
 * @returns accessory: the TestAccessory backing the host; clock: the controllable TestClock installed on the platform double (the same instance the recording delegate
 *          reads, so a transmit test advances it to release pacing); controller: the AbortController behind the context's signal (abort it in suite teardown); host: the
 *          TestCameraHost double under test; logEntries: every line the construction and transmit paths logged (so a transmit test can assert on captured telemetry);
 *          nvr: the NVR double backing the context.
 */
export function makeTestCameraHost(options: { clock?: TestClock; recordingProcessFactory?: RecordingProcessFactory; userOptions?: string[] } = {}):
{ accessory: TestAccessory; clock: TestClock; controller: AbortController; host: TestCameraHost; logEntries: TestLogEntry[]; nvr: TestProtectNvr } {

  const store = new TestStateStore(makeProtectState());
  const { clock, controller, logEntries, nvr } = makeTestNvr({ clock: options.clock, recordingProcessFactory: options.recordingProcessFactory, store,
    userOptions: options.userOptions });
  const accessory = makeTestAccessory();
  const host = new TestCameraHost({ accessory, nvr });

  return { accessory, clock, controller, host, logEntries, nvr };
}

// One captured log line from the harness's recording sinks: the level it was emitted at and the raw parameters, so a test can assert on (or ignore) whatever the
// construction path logged.
export interface TestLogEntry {

  level: "debug" | "error" | "info" | "warn";
  parameters: unknown[];
}

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
  public readonly subscriptions: TestMqttSubscription[] = [];
  public readonly unsubscribes: { id: string; topic: string }[] = [];

  public async publish(topic: string, message: string): Promise<void> {

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

// One recorded homebridge API registration call: which registration verb production invoked and the accessories it carried (snapshotted for the update verb, which
// receives the whole live array).
export interface TestApiCall {

  accessories: TestAccessory[];
  kind: "publishExternal" | "register" | "unregister" | "update";
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

    hap: { Characteristic: typeof Characteristic; Service: typeof Service; uuid: { generate: (seed: string) => string } };
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

    return new DoorbellCapability(this as unknown as ProtectNvr, { camera: camera, device: device, signal: signal });
  }

  public createPackageCamera(accessory: ProtectAccessory, device: Camera): ProtectCameraPackage {

    return new ProtectCameraPackage(this as unknown as ProtectNvr, accessory, device);
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

// Build the NVR config record the construction path reads through nvr.ufp: the host (the last fallback in the camera's RTSP host chain), the controller MAC (the
// feature-option controller scope key, and the chime / ringtone nvrMac filter key), the RTSP(S) ports (the RTSPS port pinned to the fixture value so channel profile
// URLs match the golden-master corpus), plus the controller-owner read set: a marketName / name / type for setInfo's Model and the system-info accessory's display name,
// and a populated systemInfo so the nvr-systeminfo owner's initial pass (which dereferences systemInfo.cpu.temperature with no optional chaining) and its MQTT
// JSON.stringify read meaningfully. The optional temperature override moves systemInfo.cpu.temperature so the observer's reactive refresh can be asserted on a known
// value. hardwareRevision is OPT-IN with no default (stays undefined): the security-system owner writes nvr.ufp.hardwareRevision onto HardwareRevision unconditionally,
// so buildSecuritySystem opts a value in to net that write non-vacuously, while the DEFAULT still omits the field - which keeps ProtectBase.setInfo's HardwareRevision
// length-guard short-circuited for the device-info concern net. The single confined
// cast seam for the controller record, mirroring makeCameraConfig's discipline.
export function makeNvrConfig(options: { hardwareRevision?: string; marketName?: string; name?: string; temperature?: number; type?: string } = {}): ProtectNvrConfig {

  const populated = {

    host: "nvr.test",
    mac: "74ACB9FFFFFF",
    marketName: options.marketName ?? "UniFi Dream Machine SE",
    name: options.name ?? "Test Controller",
    ports: { rtsp: 7447, rtsps: FIXTURE_RTSPS_PORT },
    systemInfo: {

      cpu: { averageLoad: 12.5, temperature: options.temperature ?? 40 },
      memory: { available: 2048, free: 1024, total: 4096 },
      storage: { available: 500, devices: [], isRecycling: false, size: 1000, type: "hdd", used: 500 }
    },
    type: options.type ?? "UDMPRO",

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
 *                  FFmpeg process through the test double); store: the state-store double backing client.state; userOptions: feature-option config strings (the
 *                  production options array shape, e.g. "Enable.Device.SyncName" or "Disable.Nvr.DelayDeviceRemoval") applied to the REAL FeatureOptions engine.
 *
 * @returns apiCalls: every homebridge accessory-registration call the platform double recorded; clock: the controllable TestClock installed on the platform double (the
 *          same instance the recording delegate reads via platform.clock, so a transmit test advances it to release pacing); controller: the AbortController behind
 *          nvr.signal (abort it in suite teardown); factory: the stub streaming-delegate factory; logEntries: every line the construction path logged; mqtt: the
 *          recording MQTT double when requested, else null; nvr: the NVR double.
 */
export function makeTestNvr(options: { chimes?: TestChimeProjection[]; clock?: TestClock; controllerName?: string; dispatch?: (nvr: ProtectNvr) => ProtectEventDispatch;
  mqtt?: boolean; overrideAddress?: string; recordingProcessFactory?: RecordingProcessFactory; store: TestStateStore; userOptions?: string[]; }):
{ apiCalls: TestApiCall[]; clock: TestClock; controller: AbortController; factory: TestStreamingDelegateFactory; logEntries: TestLogEntry[];
  mqtt: Nullable<TestMqttClient>; nvr: TestProtectNvr; } {

  const accessories: TestAccessory[] = [];
  const apiCalls: TestApiCall[] = [];

  // The HELD chime projection doubles client.chimes returns: the SAME instances captured once here, never a per-access rebuild. The doorbell's setChimeVolume filters
  // client.chimes and calls update() on the matching projection, and a test asserts that projection's updateCalls / sets its updateRejection lever, so they must be
  // one instance. A rebuild getter would hand the write a fresh projection each pass and a test's rejection would go unseen, so the failure drive would pass vacuously.
  const chimes = options.chimes ?? [];
  const clock = options.clock ?? new TestClock();
  const controller = new AbortController();

  // The stable fallback the client.nvr.config getter returns when the store carries no nvr slice, built once so every fallback read is the SAME reference (the existing
  // camera consumers - which never seed the nvr slice - keep reading a fixed record with a stable reference).
  const defaultNvrConfig = makeNvrConfig();
  const factory = new TestStreamingDelegateFactory();
  const logEntries: TestLogEntry[] = [];
  const recordingProcessFactory = options.recordingProcessFactory ?? new TestRecordingProcessFactory();
  const mqtt = options.mqtt ? new TestMqttClient() : null;
  const sink = (level: TestLogEntry["level"]): ((...parameters: unknown[]) => void) => (...parameters: unknown[]): void => { logEntries.push({ level, parameters }); };
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

    hap: { Characteristic: Characteristic, Service: Service, uuid: { generate: (seed: string): string => "uuid:" + seed } },
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
    config: { address: "nvr.test", mqttTopic: "test/protect", password: "test-password", username: "test-user",
      ...(options.overrideAddress !== undefined ? { overrideAddress: options.overrideAddress } : {}) },
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

/**
 * Settle the asynchronous machinery a construction or push sets in motion: one macrotask tick, which lets every pending microtask chain - the floating configure
 * IIFE, the observe loops' lazy registration, a store wake's drain-and-react - run to quiescence before a test asserts. The store double wakes exclusively
 * through the microtask queue (no timers), so a single setImmediate is a complete settle.
 *
 * @returns a promise that resolves after one macrotask turn.
 */
export async function settle(): Promise<void> {

  await new Promise<void>((resolve) => setImmediate(resolve));
}
