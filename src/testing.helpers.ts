/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * testing.helpers.ts: The cross-cutting test helpers shared across every unit test in homebridge-unifi-protect.
 *
 * The plugin's production code reads and writes through Homebridge's HAP shapes (Service, Characteristic, Accessory) on every per-accessory configure path. We never
 * want a unit test to drag in the real homebridge package or stand up a live HAP runtime, so this file exposes a hand-built HAP test-double that mirrors only the
 * surface the plugin actually touches: Service identity and construction, Characteristic identity, getService / getServiceById / addService / removeService /
 * configureController on Accessory, getCharacteristic / updateCharacteristic / removeCharacteristic on Service, and onGet / onSet / value on Characteristic. That
 * surface is intentionally tight and expands as the production code it exercises reaches for new kinds; adding a kind is a small constructible marker class plus an
 * entry in the namespace object.
 *
 * Alongside the HAP double this file holds the rest of the harness's cross-cutting core: TestStateStore, the facade over unifi-protect's real state store, with
 * makeProtectState to seed it; the streaming and timeshift stubs every device family that constructs a real camera host shares (the streaming delegate and its factory,
 * which satisfies the platform's dependency-inversion contract so a REAL device can be constructed with no FFmpeg, and the timeshift buffer and supervisor doubles);
 * and the TestApiCall record shape the registration sink captures into.
 *
 * The per-subsystem helpers live beside the code they serve, each importing this file: devices/testing.helpers.ts owns the config builders, the projection doubles,
 * and TestBaseDevice; media/testing.helpers.ts owns TestCameraHost and the fragment and livestream doubles; nvr/testing.helpers.ts owns the NVR, platform, and MQTT
 * doubles and the makeTestNvr composition root. The doubles mirror contracts owned elsewhere - the service/characteristic surface is HAP's as consumed by
 * homebridge-plugin-utils' real service helpers, the removal machinery is ProtectNvr's - and fidelity to those cited contracts, not invention, is the line the harness
 * holds. State is the one concern that needs no mirroring at all: TestStateStore runs unifi-protect's own store (src/state/store.ts) rather than a restatement of it.
 *
 * Co-located with production code under src/ so the type-check pass covers this file alongside everything else, while tsconfig.build.json excludes every *.helpers.ts,
 * *.fixtures.ts, and *.test.ts from the emitted dist/, so none of the rig reaches the published package.
 */
import type { CameraController, CameraControllerOptions, Resolution } from "homebridge";
import type { ControllerIdentity, StreamingDelegate, StreamingDelegateFactory } from "./media/stream-delegate.ts";
import type { DeepPartial, DeviceSelectors, ProtectCameraConfig, ProtectChimeConfig, ProtectFobConfig, ProtectLightConfig, ProtectNvrBootstrap, ProtectNvrConfig,
  ProtectNvrLiveviewConfig, ProtectRelayConfig, ProtectRingtoneConfig, ProtectSensorConfig, ProtectState, ProtectStateRecord, ProtectViewerConfig, StateModelKey,
  StateStore } from "unifi-protect";
import type { AdvertisedStreams } from "./devices/cameras/camera.ts";
import type { ChannelProfile } from "./media/resolution.ts";
import type { Nullable } from "homebridge-plugin-utils";
import type { ProtectCameraHost } from "./media/camera-host.ts";
import type { SnapshotSource } from "./media/timeshift.ts";
import { controllerIdentityOf } from "./media/stream-delegate.ts";
import { createStateStore } from "unifi-protect";

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

// The configured-name characteristic. The Home app labels a ServiceLabel-grouped switch - the fob's buttons - by ConfiguredName rather than the plain Name, so the fob's
// button-label reconcile reads and writes exactly this kind, and the user-rename tests materialize it directly to stand in for a name the user assigned.
class ConfiguredNameCharacteristicType {

  public readonly hapKind = "ConfiguredName" as const;
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
 * carries them, and the onSet maps a target to a current), so the double mirrors HAP's exact constants as statics on each marker. Distinct values are required, not
 * incidental - a collision would collapse the Record<number, string> map and silently mis-key the MQTT state string. SecuritySystemCurrentState is also the seed
 * characteristic the SecuritySystem service marker constructs with (acquireService recovers the Characteristic constructor from the new service's first characteristic).
 * The static members are alphabetical per the house style; note the Current marker uses DISARMED=3 while the Target marker uses DISARM=3 - the same integer under two
 * HAP-distinct names, both of which the production code reaches by name.
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

/* The air-quality characteristic kinds, added together because the sensor's air quality and carbon dioxide services reach them as one surface. AirQuality is the level
 * the air quality service always carries and CarbonDioxideDetected the alert its own service always carries - each the seed characteristic its service marker
 * constructs with - while CarbonDioxideLevel and the three density kinds are PRESENCE-DRIVEN: the sensor adds and removes them as their metrics come and go, so each
 * must be a distinct key for a presence assertion (testCharacteristic) to tell one density's arrival from another's.
 *
 * HAP spells the fine particulate characteristic PM2_5Density, with an underscore production reads by that exact name. The namespace key below is quoted and the
 * backing class named without the underscore, which is what keeps the house camel-case rule satisfied while the key production reaches for stays byte-identical to
 * HAP's own.
 */
class AirQualityCharacteristicType {

  public readonly hapKind = "AirQuality" as const;
}

class CarbonDioxideDetectedCharacteristicType {

  public readonly hapKind = "CarbonDioxideDetected" as const;
}

class CarbonDioxideLevelCharacteristicType {

  public readonly hapKind = "CarbonDioxideLevel" as const;
}

class PM10DensityCharacteristicType {

  public readonly hapKind = "PM10Density" as const;
}

class PM25DensityCharacteristicType {

  public readonly hapKind = "PM2_5Density" as const;
}

class VOCDensityCharacteristicType {

  public readonly hapKind = "VOCDensity" as const;
}

/* The smoke-detector characteristic kinds, added together because the sensor's smoke and carbon monoxide services reach them as one surface. SmokeDetected and
 * CarbonMonoxideDetected are each the seed characteristic its own service marker constructs with, and the sensor binds a read-through and pushes a value on each from a
 * live status block.
 *
 * StatusFault joins them here rather than beside StatusActive and StatusTampered because the smoke pair is the only surface that carries it: the sensor writes it per
 * service from the detector's own fault flags and deliberately never through the shared state helper, so a presence assertion (testCharacteristic) on any other service
 * is what proves the characteristic stayed off the rest of the accessory.
 */
class CarbonMonoxideDetectedCharacteristicType {

  public readonly hapKind = "CarbonMonoxideDetected" as const;
}

class SmokeDetectedCharacteristicType {

  public readonly hapKind = "SmokeDetected" as const;
}

class StatusFaultCharacteristicType {

  public readonly hapKind = "StatusFault" as const;
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

// The programmable-switch-event characteristic. The doorbell ring delivery fires sendEventNotification(SINGLE_PRESS) and the fob button delivery fires the mapped
// single/double/long press on this characteristic, so the marker carries all three named press constants as statics, mirroring how real HAP exposes them as constructor
// constants. It is also the Doorbell and StatelessProgrammableSwitch markers' seed characteristic.
class ProgrammableSwitchEventCharacteristicType {

  public static readonly DOUBLE_PRESS = 1;
  public static readonly LONG_PRESS = 2;
  public static readonly SINGLE_PRESS = 0;
  public readonly hapKind = "ProgrammableSwitchEvent" as const;
}

// The service-label-index characteristic. The fob's grouped button switches carry their STABLE 1-based table index on this characteristic (and a lone visible button has
// its stale index removed), so the marker must be a distinct key the create/regroup paths write and remove.
class ServiceLabelIndexCharacteristicType {

  public readonly hapKind = "ServiceLabelIndex" as const;
}

// The service-label-namespace characteristic. The fob's ServiceLabel sets this to ARABIC_NUMERALS, so the marker carries the named namespace constants as statics
// (mirroring how real HAP exposes them as constructor constants) - else a "namespace === ARABIC_NUMERALS" assertion would be a vacuous undefined === undefined.
class ServiceLabelNamespaceCharacteristicType {

  public static readonly ARABIC_NUMERALS = 1;
  public static readonly DOTS = 0;
  public readonly hapKind = "ServiceLabelNamespace" as const;
}

// The HAP Characteristic namespace as the test-double exposes it. StatusActive is the one that matters most...the isReachable rewire writes it across every device
// class, so the reachability tests pivot on this characteristic. On covers the toggle pair used by switches in the double's self-test. LockCurrentState /
// LockTargetState back the camera's UniFi Access lock onSet and the capability-reconcile lock self-heal tests. ContactSensorState backs the auth-sensor delivery
// tests, where the firehose router's authEventHandler trips it on a recognized fingerprint/NFC scan, and StatusTampered backs the camera tamper-event handler and
// the sensor tamper observer tests. The AccessoryInformation kinds (Manufacturer / Model / SerialNumber / FirmwareRevision / Name) and MotionDetected back the
// real-construction harness; Brightness, NightVision, and CameraOperatingModeIndicator back the doorbell-family construction harness; ProgrammableSwitchEvent backs
// the doorbell ring and the fob button-press deliveries, and ServiceLabelIndex / ServiceLabelNamespace back the fob's grouped-button ServiceLabel while ConfiguredName
// backs the fob's button-label reconcile, where the Home app names a grouped button switch by that characteristic and a user rename writes it; OccupancyDetected
// backs the device-motion base-capability net, where configureOccupancySensor first reaches it. BatteryLevel / StatusLowBattery (the battery service updater) and
// CurrentAmbientLightLevel / CurrentRelativeHumidity / CurrentTemperature / LeakDetected (the sensor's per-mode services) back the sensor-family real-construction
// net, where ProtectSensor first reaches them, joined there by AirQuality / CarbonDioxideDetected and the presence-driven CarbonDioxideLevel / PM10Density /
// PM2_5Density / VOCDensity of the air quality and carbon dioxide services, and by SmokeDetected / CarbonMonoxideDetected / StatusFault of the smoke detector's own
// services, where configureSmokeDetector first reaches them. SecuritySystemCurrentState / SecuritySystemTargetState (the security-system state machine,
// the Current marker also
// the SecuritySystem service's seed) and HardwareRevision (the security-system's bespoke configureInfo) back the controller-owner net, where ProtectSecuritySystem
// first reaches them. Expand as the production code reaches for new kinds.
export const Characteristic = {

  AirQuality: AirQualityCharacteristicType,
  BatteryLevel: BatteryLevelCharacteristicType,
  Brightness: BrightnessCharacteristicType,
  CameraOperatingModeIndicator: CameraOperatingModeIndicatorCharacteristicType,
  CarbonDioxideDetected: CarbonDioxideDetectedCharacteristicType,
  CarbonDioxideLevel: CarbonDioxideLevelCharacteristicType,
  CarbonMonoxideDetected: CarbonMonoxideDetectedCharacteristicType,
  ConfiguredName: ConfiguredNameCharacteristicType,
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
  PM10Density: PM10DensityCharacteristicType,
  "PM2_5Density": PM25DensityCharacteristicType,
  ProgrammableSwitchEvent: ProgrammableSwitchEventCharacteristicType,
  SecuritySystemCurrentState: SecuritySystemCurrentStateCharacteristicType,
  SecuritySystemTargetState: SecuritySystemTargetStateCharacteristicType,
  SerialNumber: SerialNumberCharacteristicType,
  ServiceLabelIndex: ServiceLabelIndexCharacteristicType,
  ServiceLabelNamespace: ServiceLabelNamespaceCharacteristicType,
  SmokeDetected: SmokeDetectedCharacteristicType,
  StatusActive: StatusActiveCharacteristicType,
  StatusFault: StatusFaultCharacteristicType,
  StatusLowBattery: StatusLowBatteryCharacteristicType,
  StatusTampered: StatusTamperedCharacteristicType,
  VOCDensity: VOCDensityCharacteristicType
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

  // The two characteristic cross-references the naming surface reads: setServiceName recovers the characteristic namespace from an instance's constructor and writes
  // through its ConfiguredName and Name statics, mirroring real hap-nodejs. Only the naming pair is wired, matching the AccessoryInformation-scoped bridge on the
  // service side.
  public static readonly ConfiguredName = Characteristic.ConfiguredName;
  public static readonly Name = Characteristic.Name;
  public readonly type: CharacteristicType;
  // The event-notification log, mirroring HAP's sendEventNotification semantics: an event is a transient occurrence pushed to subscribers (the doorbell ring's
  // SINGLE_PRESS), recorded in order here, and it deliberately never changes the characteristic's cached value.
  public readonly events: unknown[] = [];
  // The last props object production set via setProps, captured so a test can assert the security-system owner's updateDevice narrowed the target state's validValues.
  // Undefined until production calls setProps; a silent no-op double would make the arm-states reconcile net vacuous.
  public props: TestCharacteristicProps | undefined = undefined;
  // An append-only log of every updateCharacteristic-driven write (each pushed by updateValue), alongside the single-value cache. A stale re-write of a value the
  // characteristic already holds cannot be told apart by the final cached value, so a test that must prove the code did NOT write to a sibling reads this log rather
  // than .value. triggerSet's own post-handler cache write does not append here - only production's updateCharacteristic pushes do.
  public readonly writes: unknown[] = [];
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
    this.writes.push(value);

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
 * helpers' name-set predicates (serviceHasName and friends) build their sets by looking up one static per service kind on a service's constructor, and
 * AccessoryInformation is the single kind the doubles wire (the static getter below), so every other kind's lookup misses and maps to the empty string - and a
 * service whose UUID resolved to "" would false-positive into setServiceName's ConfiguredName / Name writes against undefined characteristic statics, silently
 * polluting the double with undefined-keyed characteristics. Non-empty kind strings keep those degenerate predicates honestly false, while giving production code
 * that matches services by identity (the doorbell's validateMessageSwitches compares service.UUID against Service.Switch.UUID) real, distinct identities to match
 * on.
 *
 * AccessoryInformation is the one deliberately-wired exception, scoped to the surface the family exercises: its statics are real on both sides (the service kind
 * here, the ConfiguredName / Name pair on TestCharacteristic), so the library's accessory-naming surface - locating the information service, gating its name
 * writes behind the predicates, and performing them - behaves against the double the way it does against real HAP. Every other kind stays unwired, which is what
 * keeps the degenerate predicates false and the name writes off every service whose naming no test characterizes.
 */
export class TestService {

  // The one static cross-reference the doubles carry: homebridge-plugin-utils locates the AccessoryInformation service - and keys its name-write predicates -
  // through constructor statics, the way real hap-nodejs service classes expose the whole service registry on every subclass. AccessoryInformation alone is wired
  // so the library's accessory-naming surface behaves genuinely against the double; every other kind stays deliberately unwired, keeping the degenerate name
  // predicates honestly false outside the one service whose naming the family tests. A getter rather than an initializer because the Service namespace is declared
  // after this class; the getter reads it lazily, after both exist.
  public static get AccessoryInformation(): ServiceType {

    return Service.AccessoryInformation;
  }

  public readonly type: ServiceType;
  public displayName: string;
  // Whether production marked this the accessory's primary service (the camera's configureDoorbellService does), recorded by setPrimaryService below.
  public isPrimary = false;
  public readonly subtype: string | undefined;
  // The services production linked to this one via addLinkedService, mirroring HAP's Service.linkedServices. The fob's ServiceLabel links each grouped button switch, so
  // a test asserts exactly which switches were linked.
  public readonly linkedServices: TestService[] = [];
  private readonly characteristicsByType = new Map<CharacteristicType, TestCharacteristic>();

  public constructor(type: ServiceType, displayName: string, subtype: string | undefined) {

    this.type = type;
    this.displayName = displayName;
    this.subtype = subtype;
  }

  // The service kind's identity string, mirrored from the TYPE's static. this.type is the marker class on BOTH construction paths - the marker constructors pass
  // their own class and the legacy addService(type, ...) form passes the namespace entry - whereas this.constructor is the bare TestService on the legacy path and
  // carries no static. Real HAP identifies kinds by UUID; the double uses the kind string, which is just as unique within the namespace and far more legible in
  // assertion failures. The fallback is a non-empty sentinel for a hand-rolled type outside the namespace, preserving the never-empty rule documented above.
  public get UUID(): string {

    return (this.type as { UUID?: string }).UUID ?? "unidentified-service-kind";
  }

  // Record whether production designated this service as the accessory's primary service, mirroring HAP's Service.setPrimaryService.
  public setPrimaryService(isPrimary = true): void {

    this.isPrimary = isPrimary;
  }

  // Link another service to this one, mirroring HAP's Service.addLinkedService (a faithful mirror: a void push, includes-guarded so a repeat link is a no-op exactly
  // as real HAP dedups). The fob's ServiceLabel links each grouped button switch through this.
  public addLinkedService(service: TestService): void {

    if(!this.linkedServices.includes(service)) {

      this.linkedServices.push(service);
    }
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

  // Declare an optional characteristic on this service, mirroring HAP's Service.addOptionalCharacteristic. The camera's ambient light capability takes this path directly
  // from its acquire initializer (it permits StatusActive on the LightSensor before binding its onGet), a path no other construction route reaches - the real
  // acquireService's own addOptionalCharacteristic calls for ConfiguredName / Name stay gated off the markers by the degenerate name-set predicates (see the class doc).
  // HAP lazily materializes a permitted characteristic on first access, so the double materializes it now through getCharacteristic, keeping the later
  // getCharacteristic / onGet bind against the SAME instance and never throwing on the direct call.
  public addOptionalCharacteristic(charType: CharacteristicType): void {

    this.getCharacteristic(charType);
  }

  // Report whether the characteristic of the given kind has already been created on this service. Mirrors HAP's Service.testCharacteristic, which the
  // homebridge-plugin-utils sweep (updateServices, behind ProtectDevice.refreshReachability) calls to decide whether a service carries StatusActive before writing it,
  // and which the library's presence gates read before attaching or removing. Unlike getCharacteristic, this never lazily creates the characteristic - it is a pure
  // predicate over what has already been added.
  public testCharacteristic(charType: CharacteristicType): boolean {

    return this.characteristicsByType.has(charType);
  }

  // Remove a characteristic instance from this service, mirroring HAP's Service.removeCharacteristic. The homebridge-plugin-utils presence gates take this path to prune
  // a characteristic their verdict refuses, such as the camera's StatusTampered when tamper detection is turned off: they read prior existence side-effect-free through
  // testCharacteristic, so they never materialize a characteristic just to remove it. The double keys one instance per kind, so removal by the instance's kind is exact.
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

// The air-quality kind. Added for the sensor-family air quality net: ProtectSensor.configureAirQualitySensor acquires it when the sensor reports a metric HomeKit can
// model, then drives its AirQuality level and hangs the presence-driven densities off it. Seeds its primary AirQuality characteristic.
class AirQualitySensorServiceType extends TestService {

  public static readonly UUID = "AirQualitySensor";
  public readonly hapKind = "AirQualitySensor" as const;

  public constructor(displayName = "", subtype?: string) {

    super(AirQualitySensorServiceType, displayName, subtype);

    this.getCharacteristic(AirQualityCharacteristicType);
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

// The camera-operating-mode kind. Added for the camera-construction harness: configureCameraDetails and the per-field camera updaters resolve it by key (and do
// nothing when it is absent), so the kind must exist as a distinct key. Its HAP-required characteristics are not in the namespace, so it seeds the generic Name
// stand-in.
class CameraOperatingModeServiceType extends TestService {

  public static readonly UUID = "CameraOperatingMode";
  public readonly hapKind = "CameraOperatingMode" as const;

  public constructor(displayName = "", subtype?: string) {

    super(CameraOperatingModeServiceType, displayName, subtype);

    this.getCharacteristic(NameCharacteristicType);
  }
}

// The carbon-dioxide kind. Added for the sensor-family air quality net: ProtectSensor.configureCo2Sensor acquires it when the sensor reports carbon dioxide, driving
// the alert state from the controller's configured threshold and hanging the presence-driven level off it. Seeds its primary CarbonDioxideDetected characteristic.
class CarbonDioxideSensorServiceType extends TestService {

  public static readonly UUID = "CarbonDioxideSensor";
  public readonly hapKind = "CarbonDioxideSensor" as const;

  public constructor(displayName = "", subtype?: string) {

    super(CarbonDioxideSensorServiceType, displayName, subtype);

    this.getCharacteristic(CarbonDioxideDetectedCharacteristicType);
  }
}

// The carbon-monoxide kind. Added for the sensor-family smoke net: ProtectSensor.configureSmokeDetector acquires it when the controller advertises the CO alarm type,
// binds its read-through, and writes the alarm state and StatusFault from a live status block. Seeds its primary CarbonMonoxideDetected characteristic.
class CarbonMonoxideSensorServiceType extends TestService {

  public static readonly UUID = "CarbonMonoxideSensor";
  public readonly hapKind = "CarbonMonoxideSensor" as const;

  public constructor(displayName = "", subtype?: string) {

    super(CarbonMonoxideSensorServiceType, displayName, subtype);

    this.getCharacteristic(CarbonMonoxideDetectedCharacteristicType);
  }
}

// The contact-sensor kind. Added for the auth-sensor delivery tests: the firehose router's authEventHandler resolves an "Auth"-subtyped ContactSensor service and writes
// its ContactSensorState on a recognized fingerprint/NFC scan, so an accessory carrying one exercises the real auth trip/reset path; the same kind is also acquired by
// configureLeakSensor's opt-in moisture-sensor mode (Sensor.MoistureSensor), which the sensor-family leak suite exercises separately.
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

// The motion-sensor kind. Added for the base-capability net: ProtectDevice.configureMotionSensor acquires this service unconditionally when motion is enabled and
// the motion delivery flips MotionDetected on it, so the kind must exist as a distinct key. Seeds its primary MotionDetected characteristic.
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

// The service-label kind. Added for the fob-family real-construction net: ProtectFob.configureButtons acquires a ServiceLabel service to group two or more visible button
// switches and sets its ServiceLabelNamespace, so the kind must exist as a distinct key. Seeds its primary ServiceLabelNamespace characteristic so the real
// acquireService recovers the Characteristic constructor from the new service's first characteristic, the Battery / sensor precedent.
class ServiceLabelServiceType extends TestService {

  public static readonly UUID = "ServiceLabel";
  public readonly hapKind = "ServiceLabel" as const;

  public constructor(displayName = "", subtype?: string) {

    super(ServiceLabelServiceType, displayName, subtype);

    this.getCharacteristic(ServiceLabelNamespaceCharacteristicType);
  }
}

// The smoke kind. Added for the sensor-family smoke net: ProtectSensor.configureSmokeDetector acquires it when the controller advertises the smoke alarm type, binds its
// read-through, and writes the alarm state and StatusFault from a live status block. Seeds its primary SmokeDetected characteristic.
class SmokeSensorServiceType extends TestService {

  public static readonly UUID = "SmokeSensor";
  public readonly hapKind = "SmokeSensor" as const;

  public constructor(displayName = "", subtype?: string) {

    super(SmokeSensorServiceType, displayName, subtype);

    this.getCharacteristic(SmokeDetectedCharacteristicType);
  }
}

// The stateless-programmable-switch kind. Added for the fob-family real-construction net: ProtectFob.configureButtons acquires one per button and the event-dispatch
// router fires its ProgrammableSwitchEvent on a delivered press, so the kind must exist as a distinct key. Seeds its HAP-required ProgrammableSwitchEvent characteristic,
// which the button delivery fires event notifications on.
class StatelessProgrammableSwitchServiceType extends TestService {

  public static readonly UUID = "StatelessProgrammableSwitch";
  public readonly hapKind = "StatelessProgrammableSwitch" as const;

  public constructor(displayName = "", subtype?: string) {

    super(StatelessProgrammableSwitchServiceType, displayName, subtype);

    this.getCharacteristic(ProgrammableSwitchEventCharacteristicType);
  }
}

// The switch kind. Backs the double's own self-test plus every On/off accessory across the device families - the motion event and trigger switches, the
// status-indicator switch, the chime speaker and physical-chime switches, the HKSV and NVR recording switches, the doorbell mute and trigger switches, the relay
// outputs, the liveview switches, and the security-system alarm switch - so the kind must exist as a distinct key. Seeds its primary On characteristic.
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
  AirQualitySensor: AirQualitySensorServiceType,
  Battery: BatteryServiceType,
  CameraOperatingMode: CameraOperatingModeServiceType,
  CarbonDioxideSensor: CarbonDioxideSensorServiceType,
  CarbonMonoxideSensor: CarbonMonoxideSensorServiceType,
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
  ServiceLabel: ServiceLabelServiceType,
  SmokeSensor: SmokeSensorServiceType,
  StatelessProgrammableSwitch: StatelessProgrammableSwitchServiceType,
  Switch: SwitchServiceType,
  TemperatureSensor: TemperatureSensorServiceType
} as const;

// The HAP CameraController the streaming delegate constructs at the tail of its own constructor. A constructible marker is what lets that delegate be unit-constructed
// at all, and recording the options argument lets a construction test read the wiring the delegate composed - its own delegate handle, the streaming options, the
// recording arm when one is present - off the object HAP would have received. The surface is deliberately the constructor alone: prepareStream reaches for the static
// generateSynchronisationSource, which lands here with the first test that drives a stream request, per this file's grow-on-need principle. Named TestCameraController
// rather than CameraController because the file type-imports homebridge's CameraController above; the hap namespace key below is the production name.
export class TestCameraController {

  public readonly options: CameraControllerOptions;

  public constructor(options: CameraControllerOptions) {

    this.options = options;
  }
}

/* One accessory. Carries an AccessoryInformation service from construction (every HomeKit accessory has one); subsequent addService calls append additional
 * services. getService / getServiceById mirror HAP's distinction between "the bare service of this type" and "the service of this type with a specific subtype".
 *
 * The construction-harness growth: a mutable context record (the camera's configureDevice reassigns it wholesale, then writes keys), the ordered controller-event
 * log with HAP's one-controller-per-accessory rule enforced (the double records identity and order, and never operates on the controller's innards),
 * removeService (the faithful removal homebridge-plugin-utils' validService performs when an existing service fails validation), and the _associatedHAPAccessory
 * mirror with a mutable displayName (the accessoryName setter writes both) plus the bridged flag the accessory persistence gates its saves and unregisters on - true
 * by default (a registered or restored accessory is bridged), flipped false by the platform double's publishExternalAccessories and unregisterPlatformAccessories
 * recorders, exactly as standalone publication and a removal from the bridge leave a real accessory unbridged.
 */
export class TestAccessory {

  public context: Record<string, unknown> = {};
  public displayName: string;
  public readonly UUID: string;
  // Exposed so code that iterates every service on the accessory (the homebridge-plugin-utils updateServices sweep walks accessory.services) sees the same surface HAP's
  // PlatformAccessory.services offers.
  public readonly services: TestService[] = [];
  // The ordered controller-event log: every configureController / removeController call in arrival order, each stamped with its sequence number, so a test can
  // assert not just identity and count but ordering across a configure / remove / re-configure lifecycle.
  public readonly controllerEvents: { controller: unknown; kind: "configure" | "remove"; seq: number }[] = [];
  // The single configured controller - the chokepoint mirroring HAP's one-camera-controller-per-accessory registry, which throws on a same-id double configure.
  public configuredController: Nullable<unknown> = null;
  // The internal HAP accessory mirror the accessoryName setter writes alongside the platform accessory's own displayName, carrying the bridged flag the accessory
  // persistence's saves and unregisters and the package camera's detach guidance read.
  public readonly _associatedHAPAccessory: { bridged: boolean; displayName: string };

  public constructor(displayName: string, uuid: string) {

    this.displayName = displayName;
    this.UUID = uuid;
    this._associatedHAPAccessory = { bridged: true, displayName };

    // Construct the information service through its marker so it is born carrying the Name characteristic real HAP always gives it. The seed is what the real name
    // helpers destructure to recover the Characteristic constructor, and a device's syncName-gated rename runs before setInfo seeds anything, so an empty
    // information service would throw on the very first rename of a fresh accessory.
    this.services.push(new Service.AccessoryInformation(displayName));
  }

  // Update the accessory display-name pair the way Homebridge's own setter does: the platform wrapper's displayName and the underlying HAP accessory's move
  // together, so a production path that renames through the documented API leaves the double in the same state the real platform would carry.
  public updateDisplayName(name: string): void {

    this.displayName = name;
    this._associatedHAPAccessory.displayName = name;
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
   * characteristic - so existing tests that assert on freshly-added services being characteristic-empty stay valid. The instanceof test is sound
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
  // Accessory.configureController); the double enforces the same rule through the configuredController chokepoint, so a production path that double-registers
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

/* A thin facade over unifi-protect's real state store. This double owns no observe, queue, dedup, or reduction mechanics of its own: it constructs the genuine
 * StateStore through createStateStore - the package's one documented value-export, published for exactly this harness use - and delegates its reads to it, so the engine
 * a test drives is the library's own and cannot drift from a contract restated here. Dispatch is package-internal except through that factory, so reaching it from a
 * harness is the sanctioned path rather than a way around the export law.
 *
 * The ergonomic write helpers stay, re-expressed as event synthesizers: each resolves its record, then dispatches the TypedEvent the controller would have sent, so a
 * test still writes in per-slice terms while the reducer decides what actually changed. Two semantics therefore come from the real engine rather than from this file.
 * A write that changes nothing by value leaves the state reference untouched, so it notifies no observer at all. A patch carrying a nested object deep-merges into that
 * subtree rather than replacing it, so keys the patch omits keep their stored values.
 *
 * observerCount wraps the generator protocol rather than reading a registration set: the wrapper repeats the real store's pre-registration abort check, then counts one
 * live iteration per instance. The async-generator protocol runs a generator's finally exactly once on every exit path - abort, break, or return() - so a bare counter is
 * exact and needs no identity set behind it.
 */
export class TestStateStore {

  private observers = 0;
  private readonly store: StateStore;

  public constructor(initialState: ProtectState) {

    this.store = createStateStore({ initialState, refresh: disabledRefresh, refreshIntervalMs: false });
  }

  // The number of live observe iterations. Nonzero after a minimal camera construction settles (the base observers plus the camera's own); zero after cleanup.
  public get observerCount(): number {

    return this.observers;
  }

  // The current state - the same synchronous read surface production code calls as client.state.snapshot().
  public snapshot(): ProtectState {

    return this.store.snapshot();
  }

  // The device-collection selector catalog - the same read surface production code reaches as client.state.selectors, the real store's own catalog.
  public get selectors(): DeviceSelectors {

    return this.store.selectors;
  }

  // Patch a camera record, exactly as the controller's realtime update packet would.
  public pushCameraPatch(id: string, patch: Partial<ProtectCameraConfig>): void {

    this.requirePresent({ id, label: "camera", record: this.snapshot().cameras.get(id) });
    this.patchRecord("camera", id, patch);
  }

  // Push a partial featureFlags patch. A one-level patch is all this needs: the reducer merges key-wise into the stored featureFlags, so every flag the test did not name
  // keeps its value. This is the shared composing helper the doorbell promotion and package-capability flip tests use.
  public pushCameraFeatureFlags(id: string, flags: Partial<ProtectCameraConfig["featureFlags"]>): void {

    this.requirePresent({ id, label: "camera", record: this.snapshot().cameras.get(id) });
    this.patchRecord("camera", id, { featureFlags: flags });
  }

  // Push the controller's drain frame for a camera: every top-level boolean in its featureFlags reads false, with the lists left as they stand, as the controller
  // delivers the block on a deep re-adopt before the real values follow. The frame derives from the camera's own record, so it covers every flag the record carries.
  public pushCameraFeatureFlagsDrain(id: string): void {

    const record = this.requirePresent({ id, label: "camera", record: this.snapshot().cameras.get(id) });
    const drain = Object.fromEntries(Object.entries(record.featureFlags).filter((entry) => typeof entry[1] === "boolean").map((entry) => [ entry[0], false ]));

    this.patchRecord("camera", id, { featureFlags: drain });
  }

  // Push the paired Access reader's supportUnlock capability live. accessDeviceMetadata is OPTIONAL - a camera with no paired reader carries none - and the reducer
  // replaces an absent subtree wholesale while merging a present one key-wise, so this single patch shape serves both the first appearance and a later flip.
  public pushCameraSupportUnlock(id: string, supportUnlock: boolean): void {

    this.requirePresent({ id, label: "camera", record: this.snapshot().cameras.get(id) });
    this.patchRecord("camera", id, { accessDeviceMetadata: { featureFlags: { supportUnlock } } });
  }

  // Patch a light record - the slice the light's brightness and status-indicator reactions read.
  public pushLightPatch(id: string, patch: Partial<ProtectLightConfig>): void {

    this.requirePresent({ id, label: "light", record: this.snapshot().lights.get(id) });
    this.patchRecord("light", id, patch);
  }

  // Push a partial lightDeviceSettings patch. The light's ledLevel and isIndicatorEnabled selectors both read into that one nested object, so a test moves exactly one of
  // them and the reducer's key-wise merge leaves the sibling - and therefore the sibling's observer - alone.
  public pushLightDeviceSettings(id: string, settings: Partial<ProtectLightConfig["lightDeviceSettings"]>): void {

    this.requirePresent({ id, label: "light", record: this.snapshot().lights.get(id) });
    this.patchRecord("light", id, { lightDeviceSettings: settings });
  }

  // Patch a sensor record - the carrier the base device-info observers and the whole sensor family ride.
  public pushSensorPatch(id: string, patch: Partial<ProtectSensorConfig>): void {

    this.requirePresent({ id, label: "sensor", record: this.snapshot().sensors.get(id) });
    this.patchRecord("sensor", id, patch);
  }

  // Patch a relay record. A patch carrying a fresh outputs array wakes the outputs observer, while a ledSettings-only patch leaves the outputs array untouched so that
  // observer stays parked - the reducer's copy-on-write replacing only the subtree it actually changed.
  public pushRelayPatch(id: string, patch: Partial<ProtectRelayConfig>): void {

    this.requirePresent({ id, label: "relay", record: this.snapshot().relays.get(id) });
    this.patchRecord("relay", id, patch);
  }

  // Push a fresh outputs array for a relay, composing each simplified { id, name?, state } into the full output record shape makeRelayConfig builds. This is the
  // broadcast a real per-output state change delivers, so a test can move output state without hand-building the wire record. The lone cast is confined here, exactly as
  // makeRelayConfig confines its own, since the simplified output is not the full wire shape.
  public pushRelayOutputs(id: string, outputs: { id: number; name?: Nullable<string>; state: "off" | "on" }[]): void {

    this.pushRelayPatch(id, { outputs: outputs.map((output) => ({ id: output.id, name: output.name ?? null, state: output.state })) as ProtectRelayConfig["outputs"] });
  }

  // Patch a fob record - the slice the battery and identity observers read.
  public pushFobPatch(id: string, patch: Partial<ProtectFobConfig>): void {

    this.requirePresent({ id, label: "fob", record: this.snapshot().fobs.get(id) });
    this.patchRecord("fob", id, patch);
  }

  // Push a fresh battery status for a fob. The reducer merges into the stored wirelessConnectionState, so the LoRa link state around the battery survives and exactly the
  // fob's battery observers wake, each deduped on its own primitive.
  public pushFobBattery(id: string, batteryStatus: { isLow: boolean; percentage: Nullable<number> }): void {

    this.requirePresent({ id, label: "fob", record: this.snapshot().fobs.get(id) });
    this.patchRecord("fob", id, { wirelessConnectionState: { batteryStatus } });
  }

  // Patch a chime record - the slice the doorbell's chime-volume reduction reads.
  public pushChimePatch(id: string, patch: Partial<ProtectChimeConfig>): void {

    this.requirePresent({ id, label: "chime", record: this.snapshot().chimes.get(id) });
    this.patchRecord("chime", id, patch);
  }

  // Patch a viewer record - how the suite drives the observer-driven active-liveview reflection, since the projection double records rather than folds.
  public pushViewerPatch(id: string, patch: Partial<ProtectViewerConfig>): void {

    this.requirePresent({ id, label: "viewer", record: this.snapshot().viewers.get(id) });
    this.patchRecord("viewer", id, patch);
  }

  // Patch the NVR record - the one slice that is a single nullable record rather than a map, so it carries no id. When a test moves systemInfo it passes a FRESH
  // systemInfo object, so the nvr-systeminfo owner's narrow reaction wakes and its re-read returns the new value.
  public pushNvrPatch(patch: Partial<ProtectNvrConfig>): void {

    this.requirePresent({ label: "nvr", record: this.snapshot().nvr ?? undefined });
    this.patchRecord("nvr", "", patch);
  }

  // Replace the controller's ringtone library. Ringtones are reduced BOOTSTRAP-ONLY - the controller broadcasts no ringtone realtime packet - so a bootstrap is the only
  // event that can write this slice at all.
  public pushRingtones(ringtones: ProtectRingtoneConfig[]): void {

    this.store.dispatch({ data: this.bootstrapReplacing({ ringtones }), kind: "bootstrapLoaded" });
  }

  // Replace the controller's saved liveviews. This rides the same bootstrap as the ringtone library, for a different reason: replacing a whole collection is ONE atomic
  // transition, and a bootstrap reconciles every slice in a single dispatch, so one push wakes the collection's observer exactly once. Per-id events would reduce the
  // same end state through one dispatch per added and removed record, waking that observer once per record.
  public pushLiveviews(liveviews: ProtectNvrLiveviewConfig[]): void {

    this.store.dispatch({ data: this.bootstrapReplacing({ liveviews }), kind: "bootstrapLoaded" });
  }

  // Remove a camera record outright. Presence-free by design, mirroring the reducer's own tolerance for a removal naming an id it does not hold. The fixture for
  // absence-tolerance tests - a projection's config getter throws once its record is gone, and predicates that must survive that are exercised against exactly this.
  public removeCameraRecord(id: string): void {

    this.store.dispatch({ id, kind: "deviceRemoved", modelKey: "camera" });
  }

  // Add a camera record outright, exactly as the controller's realtime add packet would - the counterpart to removeCameraRecord, so a test can model a record that
  // vanishes and returns within the removal grace and assert what the camera's observers do across the gap.
  public addCameraRecord(config: ProtectCameraConfig): void {

    this.store.dispatch({ data: config, id: config.id, kind: "deviceAdded", modelKey: "camera" });
  }

  /* Observe a selector over the state. The real store owns the semantics - lazy registration when iteration begins, a baseline seeded at that moment, an unbounded
   * in-order queue, drain-then-close on abort, and deregistration on every exit path - and this wrapper adds only the count. It repeats the store's own already-aborted
   * check first so the count never moves for an iteration the store declines to register, which keeps observerCount equal to real registration rather than merely
   * netting to zero.
   */
  public async *observe<T>(selector: (state: ProtectState) => T, opts: { signal?: AbortSignal } = {}): AsyncGenerator<T> {

    if(opts.signal?.aborted) {

      return;
    }

    this.observers++;

    try {

      yield* this.store.observe(selector, opts);
    } finally {

      this.observers--;
    }
  }

  /* Build the bootstrap that carries one replaced collection and changes nothing else - the write path for both whole-collection helpers. Every modeled collection is
   * rebuilt from the current snapshot, one line per slice with no selectivity, and nvr and authUserId are carried across verbatim, so applyBootstrap's reconciliation is
   * the identity on every slice the caller did not replace: reconcileMap re-keys each collection against its own records, finds no addition, removal, or value change,
   * and returns the very map it was handed, records and all. The nvr line preserves an unchanged record by reference and carries a null through unchanged, and the
   * adoption normalization ahead of it reads the controller MAC off that same nvr, going inert when it is null.
   *
   * The single cast is what lets that work. ProtectNvrBootstrap describes the controller's full bootstrap document: it requires a non-nullable nvr, which the store
   * legitimately holds as null before a controller identity exists, plus the further fields it requires that ProtectState does not model and applyBootstrap never reads -
   * accessKey, lastUpdateId, the group and unmodeled-device collections among them. Fabricating them would be invention, and fabricating the nvr in particular would
   * silently overwrite the null slice these fixtures depend on, so the literal carries exactly the fields the reducer consumes and the cast confines the gap, in the same
   * wire-shape idiom the config builders use.
   */
  private bootstrapReplacing(replacements: { liveviews?: ProtectNvrLiveviewConfig[]; ringtones?: ProtectRingtoneConfig[] }): ProtectNvrBootstrap {

    const state = this.snapshot();

    return {

      authUserId: state.authUserId,
      cameras: [...state.cameras.values()],
      chimes: [...state.chimes.values()],
      fobs: [...state.fobs.values()],
      lights: [...state.lights.values()],
      liveviews: replacements.liveviews ?? [...state.liveviews.values()],
      nvr: state.nvr,
      relays: [...state.relays.values()],
      ringtones: replacements.ringtones ?? [...state.ringtones.values()],
      sensors: [...state.sensors.values()],
      users: [...state.users.values()],
      viewers: [...state.viewers.values()]
    } as unknown as ProtectNvrBootstrap;
  }

  /* Dispatch one device patch. Each per-slice helper above holds a precise Partial of its own record type, but a TypedEvent pairs a model key with a patch typed against
   * the whole record union and the two carry no typed correlation, so the widening lands here once rather than at every helper.
   */
  private patchRecord(modelKey: StateModelKey, id: string, patch: object): void {

    this.store.dispatch({ id, kind: "devicePatched", modelKey, patch: patch as DeepPartial<ProtectStateRecord> });
  }

  // The one presence guard behind every write helper. The reducer no-ops a patch naming an id it does not hold, which would let a mistargeted push silently do nothing;
  // throwing here keeps a test's own mistake loud. The nvr singleton carries no id, so its message names no record.
  private requirePresent<T>(options: { id?: string; label: string; record: T | undefined }): T {

    if(options.record === undefined) {

      throw new Error("The " + options.label + " record to patch is not present in the store double" + ((options.id === undefined) ? "." : ": " + options.id + "."));
    }

    return options.record;
  }
}

// The refresh callback the real store's options require. Constructing the double with refreshIntervalMs false disables the bootstrap-refresh failsafe outright, so the
// loop never starts, nothing here ever runs, and there is no timer or resource for a test to dispose. It throws rather than fabricating a bootstrap so that were the
// failsafe ever enabled by accident, the harness would fail loudly instead of quietly reducing an invented document.
async function disabledRefresh(): Promise<ProtectNvrBootstrap> {

  throw new Error("The store double disables the bootstrap refresh failsafe, so its refresh callback is never called.");
}

/**
 * Build a complete ProtectState for the store double, populated with whichever device-slice records the caller supplies and empty collections everywhere else.
 * Mirrors the real reduced state's shape (unifi-protect's reducer), so the real memoized selectors read it natively. Every slice keys its records by their own id,
 * exactly as the reducer does; the lone nvr slice is a single nullable record rather than a map. Omitting any option yields the empty starting value for that slice
 * (an empty Map, or null for nvr), so a bare makeProtectState() is the empty-everywhere baseline the observe and selector tests seed.
 *
 * @param options - cameras / chimes / fobs / lights / liveviews / relays / ringtones / sensors / viewers: the config records to key into the matching map slice, each
 *                  keyed by its own id; nvr: the single controller config record set on the nvr slice (defaults to null). The users slice is intentionally not exposed:
 *                  no test seeds it (it is not surfaced in HomeKit), so it stays the empty Map the reducer starts from.
 *
 * @returns a full ProtectState ready to seed a TestStateStore.
 */
export function makeProtectState(options: { cameras?: ProtectCameraConfig[]; chimes?: ProtectChimeConfig[]; fobs?: ProtectFobConfig[]; lights?: ProtectLightConfig[];
  liveviews?: ProtectNvrLiveviewConfig[]; nvr?: Nullable<ProtectNvrConfig>; relays?: ProtectRelayConfig[]; ringtones?: ProtectRingtoneConfig[];
  sensors?: ProtectSensorConfig[]; viewers?: ProtectViewerConfig[]; } = {}): ProtectState {

  return {

    authUserId: null,
    bootstrapId: 1,
    cameras: new Map((options.cameras ?? []).map((camera): [string, ProtectCameraConfig] => [ camera.id, camera ])),
    chimes: new Map((options.chimes ?? []).map((chime): [string, ProtectChimeConfig] => [ chime.id, chime ])),
    fobs: new Map((options.fobs ?? []).map((fob): [string, ProtectFobConfig] => [ fob.id, fob ])),
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

// The steerable recording face of a streaming-delegate double: the narrow HomeKit Secure Video slice the camera family reads off this.stream.hksv - whether a recording
// is open, whether it is actively transmitting, and the recording-off command the delegate teardown issues. Every recording-active command is recorded, so a test can
// assert both that a teardown disabled recording and that a connection-release deliberately did not.
export interface TestRecordingDelegate {

  isRecording: boolean;
  isTransmitting: boolean;
  updateRecordingActive: (isActive: boolean) => void;
  updateRecordingActiveCalls: boolean[];
}

// Build a recording-delegate double in a chosen recording state, defaulting to idle. A test installs it on a TestStreamingDelegate's hksv arrangement point through the
// harness's confined double-to-production cast, exactly as the factory installs the timeshift supervisor double.
export function makeRecordingDelegateDouble(state: { isRecording?: boolean; isTransmitting?: boolean } = {}): TestRecordingDelegate {

  const hksv: TestRecordingDelegate = {

    isRecording: state.isRecording ?? false,
    isTransmitting: state.isTransmitting ?? false,
    updateRecordingActive: (isActive: boolean): void => { hksv.updateRecordingActiveCalls.push(isActive); },
    updateRecordingActiveCalls: []
  };

  return hksv;
}

// The steerable buffer face of the timeshift-supervisor double: the members the session-source and snapshot paths read off the running buffer.
export interface TestTimeshiftBuffer {

  channelProfile: Nullable<ChannelProfile>;
  getLast: (duration: number) => Nullable<Buffer>;
  isStarted: boolean;
  snapshotSource: () => SnapshotSource;
}

// A steerable timeshift-supervisor double the streaming-delegate factory installs at create time, so the construction-time activation kick and the per-lifecycle-edge
// availability kicks land on a spy rather than an inert stand-in. reconcileCalls tallies every reconcile the camera fires; the buffer members are steerable so the
// session-source and snapshot tests drive the buffer-liveness and empty-read branches.
export interface TestTimeshiftSupervisor {

  readonly buffer: TestTimeshiftBuffer;
  reconcile: () => Promise<void>;
  reconcileCalls: number;
  shutdown: () => void;
  shutdownCalls: number;
}

// Build a fresh timeshift-supervisor double. Every reconcile increments reconcileCalls (the per-edge tally the availability/activation/snapshot kick tests read), and the
// steerable buffer members default to "not running, nothing to give" - the quiet default the construction paths read against.
export function makeTimeshiftSupervisorDouble(): TestTimeshiftSupervisor {

  const buffer: TestTimeshiftBuffer = {

    channelProfile: null,
    getLast: (): Nullable<Buffer> => null,
    isStarted: false,
    snapshotSource: (): SnapshotSource => ({ kind: "empty" })
  };

  const supervisor: TestTimeshiftSupervisor = {

    buffer,
    reconcile: (): Promise<void> => {

      supervisor.reconcileCalls++;

      return Promise.resolve();
    },
    reconcileCalls: 0,
    shutdown: (): void => { supervisor.shutdownCalls++; },
    shutdownCalls: 0
  };

  return supervisor;
}

/* The stub StreamingDelegate, typed as the abstraction and entirely FFmpeg-free. The controller is a distinct sentinel object tests can identity-match
 * through the accessory's controller-event log; ffmpegOptions is the one documented cast boundary on this class - the camera family reads maxSourcePixels off it (via
 * selectSubstrateChannel, never at construction) and hardwareEncodes off it (the HKSV acknowledgment marker), with the ceiling injectable and the encoder answer
 * configurable so the substrate-channel pixel cap and the hardware marker are both exercisable; hksv is null, the correct pre-HKSV-configuration state cleanup reads
 * through this.stream?.hksv?.isRecording; shutdown records its calls; and resetProbesizeOverride is a recordable no-op.
 */
export class TestStreamingDelegate implements StreamingDelegate {

  // The controller identity this stub controller was built for, mirroring production's ProtectStreamingDelegate.builtFor so the live capability reconcile's staleness
  // check (rebuild only when a term has appeared since this.stream.builtFor) exercises against the real value the factory recorded at create time.
  public readonly builtFor: ControllerIdentity;
  public controller: CameraController;
  public readonly ffmpegOptions: StreamingDelegate["ffmpegOptions"];
  // Whether this stub reports the host running its hardware encoder, read through the ffmpegOptions.hardwareEncodes closure. Defaults false, the software-neutral state
  // that suppresses the HKSV hardware marker, so a marker test opts in by setting it true before the acknowledgment fires.
  public hardwareEncodes = false;
  public hksv: StreamingDelegate["hksv"];
  public readonly probesize: number;
  // How many times production wound this delegate's probesize self-tuning back - the controller-reboot recovery walk calls it.
  public resetProbesizeOverrideCalls = 0;
  // How many times production tore this delegate down - cleanup and the NVR disconnect walk both call shutdown.
  public shutdownCalls = 0;
  public timeshift: StreamingDelegate["timeshift"];

  // The default identity, which no host stands behind, is the record with every term false: a delegate built for nothing, so any term a test raises is an appearance.
  public constructor(builtFor: ControllerIdentity = { hksvCapable: false, isDoorbell: false, twoWayAudio: false },
    maxSourcePixels = Infinity) {

    this.builtFor = builtFor;

    // The identity sentinel: a plain object the test matches by reference. The double never operates on the controller's innards - HAP's controller is opaque to
    // the camera beyond registration.
    this.controller = { hbupTestSentinel: "camera-controller" } as unknown as CameraController;

    // The confined cast boundary: the camera family reads maxSourcePixels and hardwareEncodes off ffmpegOptions. An Infinity ceiling means "no hardware pixel cap" - the
    // pass-everything-through default - while a finite injected ceiling lets the recording-channel cap path select against a real constraint. The hardwareEncodes closure
    // reads the configurable field, which defaults false so the HKSV hardware marker is absent unless a test opts in.
    this.ffmpegOptions = {

      hardwareEncodes: (): boolean => this.hardwareEncodes,
      maxSourcePixels: (): number => maxSourcePixels
    } as unknown as StreamingDelegate["ffmpegOptions"];
    this.hksv = null;

    // The fixed probesize the stub advertises - consumers read it through camera.stream.probesize; an inert test value with no behavioral role in the suites.
    this.probesize = 16384;
    this.timeshift = null;
  }

  // The snapshot entry point is void fire-and-forget on the paths that reach it; the stub does nothing.
  public handleSnapshotRequest(): void {

    // Nothing to do - the stub takes no snapshots.
  }

  public resetProbesizeOverride(): void {

    // Nothing to reset - the stub holds no probesize override state, so the call is recorded and nothing else happens.
    this.resetProbesizeOverrideCalls++;
  }

  public shutdown(): void {

    // Nothing to tear down beyond the record - the stub holds no FFmpeg sessions.
    this.shutdownCalls++;
  }
}

// The stub StreamingDelegateFactory satisfying the platform's dependency-inversion interface. Records every create call (the camera identity, the resolutions array,
// the recording audio format and the probe the derivation handed it, the delegate it returned, and whether the accessory carried a MotionSensor service at that moment)
// so tests can assert the interface was exercised exactly once with exactly the advertised resolutions, read what the derivation's probe produced, prove a motion
// sensor stood before the controller that captures it was built, and hand back the recorded delegate's sentinel controller for identity assertions. The
// maxSourcePixels ceiling is forwarded into every delegate it creates - set it before construction to exercise the recording-channel pixel cap with a finite value.
export class TestStreamingDelegateFactory implements StreamingDelegateFactory {

  public readonly createCalls: { audioFormat: AdvertisedStreams["audioFormat"]; camera: ProtectCameraHost; delegate: TestStreamingDelegate; motionSensorPresent: boolean;
    probe: AdvertisedStreams["probe"]; resolutions: Resolution[]; }[] = [];

  public maxSourcePixels = Infinity;

  public create(camera: ProtectCameraHost, derived: AdvertisedStreams): StreamingDelegate {

    // Capture the camera's controller identity through the same derivation production's ProtectStreamingDelegate reads at its own construction. This makes a
    // construction whose capabilities are present yield a delegate already built for the current identity, so the capability reconcile's staleness check is a no-op
    // (zero controller churn), and only a genuine late capability - a delegate built before it appeared - rebuilds.
    const delegate = new TestStreamingDelegate(controllerIdentityOf(camera), this.maxSourcePixels);

    // Install the timeshift-supervisor double at create time - before the camera's construction-time activation kick reads it - so the kick and the per-edge availability
    // kicks land on a spy rather than an inert stand-in. Cast at the confined double->production boundary the harness uses throughout.
    delegate.timeshift = makeTimeshiftSupervisorDouble() as unknown as StreamingDelegate["timeshift"];

    this.createCalls.push({ audioFormat: derived.audioFormat, camera, delegate,
      motionSensorPresent: camera.accessory.getService(camera.api.hap.Service.MotionSensor) !== undefined, probe: derived.probe, resolutions: derived.resolutions });

    return delegate;
  }
}

// One recorded homebridge API registration call: which registration verb production invoked and the accessories it carried (snapshotted for the update verb, which
// receives the whole live array).
export interface TestApiCall {

  accessories: TestAccessory[];
  kind: "publishExternal" | "register" | "unregister" | "update";
}
