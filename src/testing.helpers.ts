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
 * Alongside the HAP double, this file owns the reusable device-construction harness: a faithful double of the v5 StateStore observe contract (TestStateStore),
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
import type { Camera, ProtectCameraChannelConfig, ProtectCameraConfig, ProtectChimeConfig, ProtectNvrConfig, ProtectState, Segment, SnapshotOptions,
  TalkbackSession } from "unifi-protect";
import { FIXTURE_HOST, FIXTURE_RTSPS_PORT, G2_PRO_CHANNELS } from "./resolution.fixtures.ts";
import type { HomebridgePluginLogging, Nullable } from "homebridge-plugin-utils";
import { PLATFORM_NAME, PLUGIN_NAME } from "./settings.ts";
import type { ProtectNvrOptions, ProtectOptions } from "./options.ts";
import type { StreamingDelegate, StreamingDelegateFactory } from "./stream-delegate.ts";
import { featureOptionCategories, featureOptions } from "./options.ts";
import type { ChannelProfile } from "./devices/resolution.ts";
import { DoorbellCapability } from "./devices/doorbell.ts";
import { FeatureOptions } from "homebridge-plugin-utils";
import type { LivestreamSubscription } from "./livestream.ts";
import type { ProtectAccessory } from "./types.ts";
import type { ProtectCamera } from "./devices/camera.ts";
import type { ProtectCameraHost } from "./camera-host.ts";
import { ProtectCameraPackage } from "./devices/camera-package.ts";
import { ProtectEventDispatch } from "./event-dispatch.ts";
import type { ProtectHints } from "./devices/device.ts";
import type { ProtectNvr } from "./nvr.ts";
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

// The lock-state characteristics. The access-unlock delivery writes both LockCurrentState and LockTargetState, toggling each between SECURED and UNSECURED, so the
// double carries those two named states (the only ones the plugin reads) as statics on each marker, mirroring how real HAP exposes them as constructor constants.
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

// The AccessoryInformation characteristics. Added for the camera-construction harness: ProtectBase.setInfo writes Manufacturer / Model / SerialNumber /
// FirmwareRevision onto the AccessoryInformation service at configure time, and the accessoryName getter reads the Name characteristic, so distinct kinds are
// required for each so the writes never collide on an undefined key.
class FirmwareRevisionCharacteristicType {

  public readonly hapKind = "FirmwareRevision" as const;
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

// The motion-detected characteristic. The camera's configureMotionSensor initializes MotionDetected to false on the motion service it acquires, and the motion
// delivery flips it, so the construction harness needs the kind as a first-class key (it is also the seed characteristic the MotionSensor marker constructs with).
class MotionDetectedCharacteristicType {

  public readonly hapKind = "MotionDetected" as const;
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
// LockTargetState back the access-unlock delivery tests. The AccessoryInformation kinds (Manufacturer / Model / SerialNumber / FirmwareRevision / Name) and
// MotionDetected back the real-construction harness; Brightness, NightVision, CameraOperatingModeIndicator, and ProgrammableSwitchEvent back the doorbell-family
// construction harness. Expand as the production code reaches for new kinds.
export const Characteristic = {

  Brightness: BrightnessCharacteristicType,
  CameraOperatingModeIndicator: CameraOperatingModeIndicatorCharacteristicType,
  ContactSensorState: ContactSensorStateCharacteristicType,
  FirmwareRevision: FirmwareRevisionCharacteristicType,
  LockCurrentState: LockCurrentStateCharacteristicType,
  LockTargetState: LockTargetStateCharacteristicType,
  Manufacturer: ManufacturerCharacteristicType,
  Model: ModelCharacteristicType,
  MotionDetected: MotionDetectedCharacteristicType,
  Name: NameCharacteristicType,
  NightVision: NightVisionCharacteristicType,
  On: OnCharacteristicType,
  ProgrammableSwitchEvent: ProgrammableSwitchEventCharacteristicType,
  SerialNumber: SerialNumberCharacteristicType,
  StatusActive: StatusActiveCharacteristicType,
  StatusTampered: StatusTamperedCharacteristicType
} as const;

// Shorthand for the constructor-as-key shape both Service and Characteristic expose. We use the class itself (not an instance) as the Map key throughout, so
// these are constructor types whose argument list is intentionally permissive...the marker classes take no arguments (or, for the constructible service markers,
// the HAP (displayName?, subtype?) pair), and we want the alias to admit either.
export type ServiceType = abstract new (...args: never[]) => object;
export type CharacteristicType = abstract new (...args: never[]) => object;

// One characteristic backing instance, owned by a TestService. Holds the last value written, plus the optional onGet / onSet handlers production code installs.
// triggerGet / triggerSet are the test-side knobs that exercise the bound handlers without going through a real HAP request path.
export class TestCharacteristic {

  public readonly type: CharacteristicType;
  // The event-notification log, mirroring HAP's sendEventNotification semantics: an event is a transient occurrence pushed to subscribers (the doorbell ring's
  // SINGLE_PRESS), recorded in order here, and it deliberately never changes the characteristic's cached value.
  public readonly events: unknown[] = [];
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

  // Report whether the characteristic of the given kind has already been created on this service. Mirrors HAP's Service.testCharacteristic, which the production
  // reachability fan-out (ProtectDevice.refreshReachability) calls to decide whether a service carries StatusActive before writing it. Unlike getCharacteristic, this
  // never lazily creates the characteristic - it is a pure predicate over what has already been added.
  public testCharacteristic(charType: CharacteristicType): boolean {

    return this.characteristicsByType.has(charType);
  }

  // Remove a characteristic instance from this service, mirroring HAP's Service.removeCharacteristic. The camera's configureTamperDetection takes this path on a
  // camera without tamper detection: it lazily materializes StatusTampered through getCharacteristic, then removes it. The double keys one instance per kind, so
  // removal by the instance's kind is exact.
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

// The lock-mechanism kind. Added for the access-unlock delivery tests: the firehose router's accessEventHandler resolves an "Access"-subtyped LockMechanism service and
// toggles its lock characteristics, so an accessory carrying one exercises the real unlock/re-secure path.
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

// The occupancy sensor kind. Added for the reachability fan-out tests: an accessory carrying both a MotionSensor and an OccupancySensor exercises refreshReachability
// writing StatusActive across every service that declares it. Its HAP-required OccupancyDetected characteristic is verified unreached by the construction harness,
// so it seeds the generic Name stand-in rather than growing the Characteristic namespace speculatively.
class OccupancySensorServiceType extends TestService {

  public static readonly UUID = "OccupancySensor";
  public readonly hapKind = "OccupancySensor" as const;

  public constructor(displayName = "", subtype?: string) {

    super(OccupancySensorServiceType, displayName, subtype);

    this.getCharacteristic(NameCharacteristicType);
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

// The HAP Service namespace as the test-double exposes it. Add new kinds here when a test reaches for one the production code touches. Alphabetical, per the
// house style for object property order.
export const Service = {

  AccessoryInformation: AccessoryInformationServiceType,
  CameraOperatingMode: CameraOperatingModeServiceType,
  ContactSensor: ContactSensorServiceType,
  Doorbell: DoorbellServiceType,
  Lightbulb: LightbulbServiceType,
  LockMechanism: LockMechanismServiceType,
  MotionSensor: MotionSensorServiceType,
  OccupancySensor: OccupancySensorServiceType,
  Switch: SwitchServiceType
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

/* A faithful test double of the v5 StateStore observe contract. The real StateStore is a type-only export, constructed solely by ProtectClient.connect(), so a
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

  // The number of currently registered observers, derived from the registration set. Eleven after a minimal camera construction settles; zero after cleanup.
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
 * Build a complete ProtectState for the store double, populated with the supplied camera and chime records and empty collections everywhere else. Mirrors the real
 * reduced state's shape (unifi-protect's reducer), so the real memoized selectors read it natively.
 *
 * @param options - cameras: the camera config records to key into the cameras map, each keyed by its own id; chimes: the chime config records, likewise.
 *
 * @returns a full ProtectState ready to seed a TestStateStore.
 */
export function makeProtectState(options: { cameras?: ProtectCameraConfig[]; chimes?: ProtectChimeConfig[] } = {}): ProtectState {

  return {

    authUserId: null,
    bootstrapId: 1,
    cameras: new Map((options.cameras ?? []).map((camera): [string, ProtectCameraConfig] => [ camera.id, camera ])),
    chimes: new Map((options.chimes ?? []).map((chime): [string, ProtectChimeConfig] => [ chime.id, chime ])),
    lights: new Map(),
    liveviews: new Map(),
    nvr: null,
    ringtones: new Map(),
    sensors: new Map(),
    users: new Map(),
    viewers: new Map()
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
 * tests - the same spirit as resolution.fixtures.ts' makeChannel, carried as far as is practical for a much wider record. Every override merges BEFORE the single
 * cast, so an overridden record is exactly as type-honest as the default one.
 *
 * @param options - channels: the typed channel array (reuse the resolution.fixtures.ts corpus); featureFlags: per-flag overrides merged over the all-false
 *                  defaults (a doorbell test sets isDoorbell, a package test adds hasPackageCamera); chimeDuration / enableNfc / isDark / lcdMessage: the
 *                  doorbell-adjacent fields its configure paths read; id / mac / name: optional identity overrides.
 *
 * @returns a camera config record the construction path reads as real.
 */
export function makeCameraConfig(options: { channels: ProtectCameraChannelConfig[]; chimeDuration?: number; enableNfc?: boolean;
  featureFlags?: Partial<TestCameraFeatureFlags>; id?: string; isDark?: boolean; lcdMessage?: { duration?: number; resetAt?: Nullable<number>; text?: string;
    type?: string; }; mac?: string; name?: string; }): ProtectCameraConfig {

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
    videoCodec: "h264",
    ...(options.lcdMessage !== undefined ? { lcdMessage: options.lcdMessage } : {})
  };

  return populated as unknown as ProtectCameraConfig;
}

/**
 * Build a minimal-but-real chime config record, mirroring makeCameraConfig's discipline: the fields the doorbell's chime-volume derivation reads (cameraIds and the
 * per-doorbell ringSettings entries) are populated for real, the rest of the wire type sits behind the single documented cast.
 *
 * @param options - cameraIds: the doorbells this chime serves; id / mac / name: optional identity overrides; ringSettings: the per-doorbell ring entries (volume is
 *                  the field the derivation reads).
 *
 * @returns a chime config record the chime-volume paths read as real.
 */
export function makeChimeConfig(options: { cameraIds?: string[]; id?: string; mac?: string; name?: string;
  ringSettings?: { cameraId: string; repeatTimes?: number; ringtoneId?: string; volume: number }[]; } = {}): ProtectChimeConfig {

  const populated = {

    cameraIds: options.cameraIds ?? [],
    id: options.id ?? "test-chime-1",
    mac: options.mac ?? "74ACB9000101",
    modelKey: "chime",
    name: options.name ?? "Test Chime",
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

/* The Camera projection double, mirroring unifi-protect's DeviceProjection contract for the members the construction path reads: a stable id, the "camera"
 * modelKey discriminant, a READ-THROUGH config getter into the store double's CURRENT state (never a held snapshot - a push must change what this.ufp returns, or
 * an end-to-end push test proves nothing), and the derived name / isOnline getters using the projection's own definitions (name ?? displayName, and
 * state === "CONNECTED" per the library's isDeviceOnline). The projection METHODS (update, lux, livestream, talkback, snapshot, reboot) sit behind gates the
 * minimal construction scenario never opens and are deliberately omitted - a test that reaches one fails loudly on the missing member instead of silently
 * succeeding against a stub.
 */
export class TestCameraProjection {

  public readonly id: string;
  public readonly modelKey = "camera" as const;
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

  // Whether the device is currently connected, per the library's isDeviceOnline definition.
  public get isOnline(): boolean {

    return this.config.state === "CONNECTED";
  }

  // The device's display name - its user-assigned name when set, otherwise the controller's displayName, per the DeviceProjection convention.
  public get name(): string {

    return this.config.name ?? this.config.displayName;
  }
}

/* The stub StreamingDelegate, typed as the 2a-i abstraction and entirely FFmpeg-free. The controller is a distinct sentinel object tests can identity-match
 * through the accessory's controller-event log; ffmpegOptions is the one documented cast seam on this class (only maxSourcePixels is read on the camera family's
 * paths, and only via selectRecordingChannel - never at construction), with the ceiling injectable so the recording-channel pixel cap is exercisable with a finite
 * value; hksv is null, the correct pre-HKSV-configuration state cleanup reads through this.stream?.hksv?.isRecording; shutdown records its calls; and
 * resetProbesizeOverride is a recordable no-op.
 */
export class TestStreamingDelegate implements StreamingDelegate {

  // The doorbell-ness this stub controller was built for, mirroring production's ProtectStreamingDelegate.builtAsDoorbell so the live-attach's staleness check
  // (rebuild only when this.stream.builtAsDoorbell disagrees with the live isDoorbell) exercises against the real value the factory recorded at create time.
  public readonly builtAsDoorbell: boolean;
  public controller: CameraController;
  public readonly ffmpegOptions: StreamingDelegate["ffmpegOptions"];
  public hksv: StreamingDelegate["hksv"];
  public readonly probesize: number;
  // How many times production tore this delegate down - cleanup and the NVR disconnect walk both call shutdown.
  public shutdownCalls = 0;

  public constructor(builtAsDoorbell = false, maxSourcePixels = Infinity) {

    this.builtAsDoorbell = builtAsDoorbell;

    // The identity sentinel: a plain object the test matches by reference. The double never operates on the controller's innards - HAP's controller is opaque to
    // the camera beyond registration.
    this.controller = { hbupTestSentinel: "camera-controller" } as unknown as CameraController;

    // The confined cast seam: the camera family reads only maxSourcePixels off ffmpegOptions, and an Infinity ceiling means "no hardware pixel cap" - the
    // pass-everything-through default. A finite injected ceiling lets the recording-channel cap path select against a real constraint.
    this.ffmpegOptions = { maxSourcePixels: (): number => maxSourcePixels } as unknown as StreamingDelegate["ffmpegOptions"];
    this.hksv = null;
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

    // Capture the constructed camera's doorbell-ness, exactly as production's ProtectStreamingDelegate reads featureFlags.isDoorbell at its own construction. This makes
    // a flag-true construction yield a delegate already built for a doorbell, so the live-attach's staleness check is a no-op (zero controller churn) when the flag was
    // already true at construction, and only a genuine late flip - a delegate built when the flag was false - triggers a rebuild.
    const delegate = new TestStreamingDelegate(camera.ufp.featureFlags.isDoorbell, this.maxSourcePixels);

    this.createCalls.push({ camera, delegate, resolutions });

    return delegate;
  }
}

/* The reusable camera-host test double: the small stand-in every media-delegate test constructs a delegate against, in place of a full ProtectCamera. The
 * ProtectCameraHost interface segregation (the dependency-inversion seam on the camera side of the media stack) exists precisely so the streaming, recording,
 * snapshot, and timeshift delegates type their camera handle as this narrow contract rather than the concrete class - and this double is what cashes that in: it
 * structurally satisfies all 21 members of ProtectCameraHost (the same compile-time proof the production ProtectCamera passes), so a delegate constructs against it
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
 * 21 members is present and interface-typed, so the completeness proof holds.
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
  public log: HomebridgePluginLogging;
  public nvr: ProtectNvr;
  public platform: ProtectPlatform;
  public readonly rebootCalls: number[] = [];

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

  // The recordable livestream seam. NOT exercised by A1 - it records its arguments and hands back a type-complete LivestreamSubscription double whose iterator
  // yields nothing and whose dispose is a no-op, so the surface compiles against the production interface without standing up a real pooled session.
  public livestream(channelProfile: ChannelProfile, opts?: { segmentLength?: number; signal?: AbortSignal; urgency?: () => number }): LivestreamSubscription {

    this.livestreamCalls.push({ channelProfile, opts });

    return makeLivestreamSubscriptionDouble();
  }

  // The recordable reboot seam; records the call count and resolves.
  public async reboot(): Promise<void> {

    this.rebootCalls.push(this.rebootCalls.length + 1);
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

  // The recordable talkback seam. NOT exercised by A1 - TalkbackSession has a private constructor and #private fields, so there is no constructible literal; the
  // never-called stub returns a confined sentinel cast, the same harness pattern TestStreamingDelegate uses for its opaque CameraController sentinel.
  public async talkback(opts?: { signal?: AbortSignal }): Promise<TalkbackSession> {

    this.talkbackCalls.push(opts ?? {});

    // The opaque sentinel: TalkbackSession is uninstantiable from a test, and A1 never calls talkback, so the return is a confined cast no path reads.
    return { hbupTestSentinel: "talkback-session" } as unknown as TalkbackSession;
  }
}

// Build a type-complete LivestreamSubscription double for the camera-host stub's livestream seam. It satisfies the full interface (the five named members plus the
// two symbol-keyed methods AsyncIterable<Segment> and AsyncDisposable require) with inert behavior: the iterator yields nothing, dispose is a no-op, and the state
// reports "closed". A1 never exercises it - the double exists only so the host's livestream return type-checks against the production interface.
function makeLivestreamSubscriptionDouble(): LivestreamSubscription {

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

/**
 * Build a TestCameraHost wired to a real makeTestNvr context, returning the host plus its test-side handles. This is the media-delegate counterpart to makeTestNvr:
 * it composes the existing doubles (a TestStateStore-backed makeTestNvr context and a TestAccessory) into the camera-host seam every media-delegate test constructs
 * against, so a delegate is unit-constructed with no real camera. The single seam casts live inside TestCameraHost's constructor (the doubles are not the
 * production handle types); the host returned here is the production-interface-typed double.
 *
 * @param options - userOptions: feature-option config strings forwarded to the makeTestNvr context's REAL FeatureOptions engine (for a later behavior test that
 *                  steers a feature-gated delegate path); the default empty context is the quiet-default host.
 *
 * @returns accessory: the TestAccessory backing the host; controller: the AbortController behind the context's signal (abort it in suite teardown); host: the
 *          TestCameraHost double under test; nvr: the NVR double backing the context.
 */
export function makeTestCameraHost(options: { userOptions?: string[] } = {}):
{ accessory: TestAccessory; controller: AbortController; host: TestCameraHost; nvr: TestProtectNvr } {

  const store = new TestStateStore(makeProtectState());
  const { controller, nvr } = makeTestNvr({ store, userOptions: options.userOptions });
  const accessory = makeTestAccessory();
  const host = new TestCameraHost({ accessory, nvr });

  return { accessory, controller, host, nvr };
}

// One captured log line from the harness's recording sinks: the level it was emitted at and the raw parameters, so a test can assert on (or ignore) whatever the
// construction path logged.
export interface TestLogEntry {

  level: "debug" | "error" | "info" | "warn";
  parameters: unknown[];
}

// One recorded MQTT subscription registration: the composed topic tail, the human-readable type label, the registration kind, and the per-subscription init options
// production passed - the lifetime signal lives there, so a test can assert which signal scoped each registration and observe it abort with its owner.
export interface TestMqttSubscription {

  init?: { signal?: AbortSignal };
  kind: "get" | "set";
  topic: string;
  type: string;
}

/* A minimal recording double of the HBPU MqttClient surface ProtectBase's wrappers and the event dispatcher reach: publish, subscribeGet, subscribeSet, and
 * unsubscribe. Registration-recording only - handlers are recorded but never invoked, because delivering a message to a registered handler (and releasing it when
 * its signal aborts) is HBPU's contract, pinned by HBPU's own tests. What THIS double proves is HBUP's side of the seam: which subscriptions a device registered,
 * on which topics, carrying which lifetime signal, and what was published.
 */
export class TestMqttClient {

  public readonly published: { message: string; topic: string }[] = [];
  public readonly subscriptions: TestMqttSubscription[] = [];
  public readonly unsubscribes: { id: string; topic: string }[] = [];

  public async publish(topic: string, message: string): Promise<void> {

    this.published.push({ message, topic });
  }

  public subscribeGet(topic: string, type: string, _getValue: () => string, init?: { signal?: AbortSignal }): void {

    this.subscriptions.push({ init, kind: "get", topic, type });
  }

  public subscribeSet(topic: string, type: string, _setValue: (value: string, rawValue: string) => Promise<void> | void, init?: { signal?: AbortSignal }): void {

    this.subscriptions.push({ init, kind: "set", topic, type });
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
// namespaces plus the deterministic uuid generator, the platform-accessory class and the four registration recorders (the doorbell's configurePackageCamera and the
// NVR removal tail drive them), the platform's mutable accessories array, a concrete codecSupport (the real platform getter throws before the FFmpeg probe - a
// concrete object with a non-raspbian hostSystem keeps the recording-default switch on its default branch), the ProtectOptions-shaped config, the REAL
// FeatureOptions engine, the log sinks, and the streaming-delegate factory seam.
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
  readonly streamingDelegateFactory: TestStreamingDelegateFactory;
}

// The options scheduleDeviceRemoval accepts on the NVR double, mirroring the production chokepoint's widened options shape.
export interface TestScheduleDeviceRemovalOptions {

  accessory: TestAccessory;
  reason?: string;
  remove?: () => void;
  stillGone: () => boolean;
}

/* The NVR double, mirroring each member the camera-family construction and lifecycle paths read. The construction surface is the 2a-ii set: the v5 client shape
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

    connection: { isHealthy: boolean };
    controllerName: string | null;
    nvr: { config: ProtectNvrConfig };
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
  public readonly platform: TestProtectPlatform;
  public removalStable = true;
  public readonly signal: AbortSignal;

  // The recorded machinery: every cancelled removal UUID, the pending manually-fireable removal timers keyed by accessory UUID, and every schedule decision with its
  // resolved interval.
  public readonly cancelledRemovals: string[] = [];
  public readonly removalTimers = new Map<string, { fire: () => void }>();
  public readonly scheduledRemovals: { interval: number; options: TestScheduleDeviceRemovalOptions }[] = [];

  // The once-per-option feature log gate, mirroring ProtectNvr.logFeature's featureLog record.
  readonly #featureLog: Record<string, boolean> = {};

  public constructor(init: { client: TestProtectNvr["client"]; config: ProtectNvrOptions; log: TestProtectNvr["log"]; mqtt: Nullable<TestMqttClient>;
    platform: TestProtectPlatform; signal: AbortSignal; }) {

    this.client = init.client;
    this.config = init.config;
    this.log = init.log;
    this.mqtt = init.mqtt;
    this.platform = init.platform;
    this.signal = init.signal;

    // The real event dispatcher, wired against this double - its constructor reads only the platform's HAP namespace, the log, and the NVR handle itself.
    this.events = new ProtectEventDispatch(this as unknown as ProtectNvr);
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

// Build the minimal NVR config record the construction path reads through nvr.ufp: the host (the last fallback in the camera's RTSP host chain), the controller
// MAC (the feature-option controller scope key), and the RTSP(S) ports - the RTSPS port pinned to the fixture value so channel profile URLs match the
// golden-master corpus. The single confined cast seam for the controller record, mirroring makeCameraConfig's discipline.
function makeNvrConfig(): ProtectNvrConfig {

  const populated = { host: "nvr.test", mac: "74ACB9FFFFFF", ports: { rtsp: 7447, rtsps: FIXTURE_RTSPS_PORT } };

  return populated as unknown as ProtectNvrConfig;
}

/**
 * Build the NVR / platform double pair for real device construction, returning the double plus its test-side handles. The double is honestly typed as
 * TestProtectNvr; the single cast to ProtectNvr is confined to the construction seam in the test itself, mirroring the reachability suite's discipline - the
 * casts live at the seam, and the instance under test is the production class.
 *
 * @param options - controllerName: the v5 controller label (defaults to "Test Controller"); mqtt: pass true to install the recording MQTT double (the default null
 *                  makes every MQTT wrapper a no-op, matching an unconfigured broker); overrideAddress: the controller-level address override for rtspHost-chain
 *                  tests; store: the state-store double backing client.state; userOptions: feature-option config strings (the production options array shape, e.g.
 *                  "Enable.Device.SyncName" or "Disable.Nvr.DelayDeviceRemoval") applied to the REAL FeatureOptions engine.
 *
 * @returns apiCalls: every homebridge accessory-registration call the platform double recorded; controller: the AbortController behind nvr.signal (abort it in
 *          suite teardown); factory: the stub streaming-delegate factory; logEntries: every line the construction path logged; mqtt: the recording MQTT double when
 *          requested, else null; nvr: the NVR double.
 */
export function makeTestNvr(options: { controllerName?: string; mqtt?: boolean; overrideAddress?: string; store: TestStateStore; userOptions?: string[] }):
{ apiCalls: TestApiCall[]; controller: AbortController; factory: TestStreamingDelegateFactory; logEntries: TestLogEntry[]; mqtt: Nullable<TestMqttClient>;
  nvr: TestProtectNvr; } {

  const accessories: TestAccessory[] = [];
  const apiCalls: TestApiCall[] = [];
  const controller = new AbortController();
  const factory = new TestStreamingDelegateFactory();
  const logEntries: TestLogEntry[] = [];
  const mqtt = options.mqtt ? new TestMqttClient() : null;
  const sink = (level: TestLogEntry["level"]): ((...parameters: unknown[]) => void) => (...parameters: unknown[]): void => { logEntries.push({ level, parameters }); };
  const log = { debug: sink("debug"), error: sink("error"), info: sink("info"), warn: sink("warn") };
  const client = {

    connection: { isHealthy: true },
    controllerName: options.controllerName ?? "Test Controller",
    nvr: { config: makeNvrConfig() },
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
    log: log,
    mqtt: mqtt,
    platform: {

      accessories: accessories,
      api: api,
      codecSupport: { hostSystem: "macOS" },
      config: { controllers: [], debugAll: false, options: [], ringDelay: 0, verboseFfmpeg: false, videoProcessor: "ffmpeg" },
      debug: sink("debug"),
      featureOptions: new FeatureOptions(featureOptionCategories, featureOptions, options.userOptions ?? []),
      log: log,
      streamingDelegateFactory: factory
    },
    signal: controller.signal
  });

  return { apiCalls, controller, factory, logEntries, mqtt, nvr };
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
