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
 * typed builders for the camera config record and the NVR / platform doubles, a read-through Camera projection double, and a stub StreamingDelegateFactory that
 * satisfies the platform's dependency-inversion seam so a REAL ProtectCamera can be constructed end to end with no FFmpeg and no live HAP. The doubles mirror
 * contracts owned elsewhere - the observe semantics are unifi-protect's (src/state/store.ts), the service/characteristic surface is HAP's as consumed by
 * homebridge-plugin-utils' real service helpers - and fidelity to those cited contracts, not invention, is the line this file holds.
 *
 * The surface is intentionally tight. The Service / Characteristic namespaces expand as the production code they exercise reaches for new kinds; adding a new
 * kind is a small constructible marker class plus an entry in the namespace object.
 *
 * Co-located with production code under src/, so the build type-checks this file alongside everything else and, today, compiles it into dist/ (the inherited
 * tsconfig carries no test or helper exclude, and the published package ships dist/ wholesale). Whether the compiled test rig should be pruned from the
 * published package is a publish-hygiene decision deliberately left out of scope here.
 */
import type { CameraController, Resolution } from "homebridge";
import { FIXTURE_HOST, FIXTURE_RTSPS_PORT } from "./resolution.fixtures.ts";
import type { ProtectCameraChannelConfig, ProtectCameraConfig, ProtectNvrConfig, ProtectState } from "unifi-protect";
import type { ProtectNvrOptions, ProtectOptions } from "./options.ts";
import type { StreamingDelegate, StreamingDelegateFactory } from "./stream-delegate.ts";
import { featureOptionCategories, featureOptions } from "./options.ts";
import { FeatureOptions } from "homebridge-plugin-utils";
import type { ProtectCamera } from "./devices/camera.ts";

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

// The HAP Characteristic namespace as the test-double exposes it. StatusActive is the load-bearing one...the isReachable rewire writes it across every device
// class, so the reachability tests pivot on this characteristic. On covers the toggle pair used by switches in the double's self-test. LockCurrentState /
// LockTargetState back the access-unlock delivery tests. The AccessoryInformation kinds (Manufacturer / Model / SerialNumber / FirmwareRevision / Name) and
// MotionDetected back the real-construction harness. Expand as the production code reaches for new kinds.
export const Characteristic = {

  ContactSensorState: ContactSensorStateCharacteristicType,
  FirmwareRevision: FirmwareRevisionCharacteristicType,
  LockCurrentState: LockCurrentStateCharacteristicType,
  LockTargetState: LockTargetStateCharacteristicType,
  Manufacturer: ManufacturerCharacteristicType,
  Model: ModelCharacteristicType,
  MotionDetected: MotionDetectedCharacteristicType,
  Name: NameCharacteristicType,
  On: OnCharacteristicType,
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
 * Deliberately ABSENT, and load-bearing in its absence: a UUID property. The real helpers' name-set predicates (serviceHasName and friends) build their sets from
 * static properties the marker classes do not carry, so every set degenerates to containing only the empty string - and a service whose UUID resolved to "" would
 * then false-positive into setServiceName's ConfiguredName / Name writes against undefined characteristic statics, silently polluting the double with
 * undefined-keyed characteristics. With UUID left undefined, every predicate is honestly false and those branches stay dead.
 */
export class TestService {

  public readonly type: ServiceType;
  public displayName: string;
  public readonly subtype: string | undefined;
  private readonly characteristicsByType = new Map<CharacteristicType, TestCharacteristic>();

  public constructor(type: ServiceType, displayName: string, subtype: string | undefined) {

    this.type = type;
    this.displayName = displayName;
    this.subtype = subtype;
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
 * ContactSensor, LockCurrentState for LockMechanism), and Name as the documented generic stand-in for kinds whose required characteristic is not in the namespace
 * yet (the seed exists to satisfy getCharacteristicConstructor; it upgrades to the kind-true characteristic when a test first exercises that kind). The seed
 * applies ONLY when a marker is constructed - the legacy addService(type, name?, subtype?) form still produces a plain, characteristic-empty TestService, which
 * existing tests rely on. Each marker still carries its hapKind property so test failures surface the kind directly in inspect output.
 */
class AccessoryInformationServiceType extends TestService {

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

  public readonly hapKind = "CameraOperatingMode" as const;

  public constructor(displayName = "", subtype?: string) {

    super(CameraOperatingModeServiceType, displayName, subtype);

    this.getCharacteristic(NameCharacteristicType);
  }
}

// The contact-sensor kind. Added for the auth-sensor delivery tests: the firehose router's authEventHandler resolves an "Auth"-subtyped ContactSensor service and writes
// its ContactSensorState on a recognized fingerprint/NFC scan, so an accessory carrying one exercises the real auth trip/reset path.
class ContactSensorServiceType extends TestService {

  public readonly hapKind = "ContactSensor" as const;

  public constructor(displayName = "", subtype?: string) {

    super(ContactSensorServiceType, displayName, subtype);

    this.getCharacteristic(ContactSensorStateCharacteristicType);
  }
}

// The doorbell kind. Added for the camera-construction harness: configureDoorbellTrigger reads accessory.getService(Service.Doorbell) unconditionally, so the kind
// must exist as a distinct key. Its HAP-required ProgrammableSwitchEvent characteristic is not in the namespace, so it seeds the generic Name stand-in.
class DoorbellServiceType extends TestService {

  public readonly hapKind = "Doorbell" as const;

  public constructor(displayName = "", subtype?: string) {

    super(DoorbellServiceType, displayName, subtype);

    this.getCharacteristic(NameCharacteristicType);
  }
}

// The lightbulb kind. Added for the camera-construction harness: configureNightVisionDimmer validates a Lightbulb service by key (a no-op at defaults), so the
// kind must exist as a distinct key.
class LightbulbServiceType extends TestService {

  public readonly hapKind = "Lightbulb" as const;

  public constructor(displayName = "", subtype?: string) {

    super(LightbulbServiceType, displayName, subtype);

    this.getCharacteristic(OnCharacteristicType);
  }
}

// The lock-mechanism kind. Added for the access-unlock delivery tests: the firehose router's accessEventHandler resolves an "Access"-subtyped LockMechanism service and
// toggles its lock characteristics, so an accessory carrying one exercises the real unlock/re-secure path.
class LockMechanismServiceType extends TestService {

  public readonly hapKind = "LockMechanism" as const;

  public constructor(displayName = "", subtype?: string) {

    super(LockMechanismServiceType, displayName, subtype);

    this.getCharacteristic(LockCurrentStateCharacteristicType);
  }
}

class MotionSensorServiceType extends TestService {

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

  public readonly hapKind = "OccupancySensor" as const;

  public constructor(displayName = "", subtype?: string) {

    super(OccupancySensorServiceType, displayName, subtype);

    this.getCharacteristic(NameCharacteristicType);
  }
}

class SwitchServiceType extends TestService {

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
 * The construction-harness growth: a mutable context record (the camera's configureDevice reassigns it wholesale, then writes keys), record-only
 * configureController / removeController call logs (HAP registers a camera controller once and unregisters it at teardown - the double records identity and
 * count, and never operates on the controller's innards), removeService (the faithful removal homebridge-plugin-utils' validService performs when an existing
 * service fails validation), and the _associatedHAPAccessory mirror with a mutable displayName (the accessoryName setter writes both).
 */
export class TestAccessory {

  public context: Record<string, unknown> = {};
  public displayName: string;
  public readonly UUID: string;
  // Exposed so production code that iterates every service on the accessory (ProtectDevice.refreshReachability walks accessory.services) sees the same surface HAP's
  // PlatformAccessory.services offers.
  public readonly services: TestService[] = [];
  // The record-only controller registration logs. Production calls configureController(stream.controller) once per camera at stream configuration and
  // removeController at cleanup; tests assert on call identity and count.
  public readonly configureControllerCalls: unknown[] = [];
  public readonly removeControllerCalls: unknown[] = [];
  // The internal HAP accessory mirror the accessoryName setter writes alongside the platform accessory's own displayName.
  public readonly _associatedHAPAccessory: { displayName: string };

  public constructor(displayName: string, uuid: string) {

    this.displayName = displayName;
    this.UUID = uuid;
    this._associatedHAPAccessory = { displayName };
    this.services.push(new TestService(Service.AccessoryInformation, displayName, undefined));
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

  // Record a controller registration. HAP registers a camera controller exactly once per accessory; the double records the registration so tests can assert both
  // the identity of what was registered and that it happened exactly once.
  public configureController(controller: unknown): void {

    this.configureControllerCalls.push(controller);
  }

  // Record a controller removal, the cleanup-side mirror of configureController.
  public removeController(controller: unknown): void {

    this.removeControllerCalls.push(controller);
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
 * Build a complete ProtectState for the store double, populated with the supplied camera records and empty collections everywhere else. Mirrors the real reduced
 * state's shape (unifi-protect's reducer), so the real memoized selectors read it natively.
 *
 * @param options - cameras: the camera config records to key into the cameras map, each keyed by its own id.
 *
 * @returns a full ProtectState ready to seed a TestStateStore.
 */
export function makeProtectState(options: { cameras?: ProtectCameraConfig[] } = {}): ProtectState {

  return {

    authUserId: null,
    bootstrapId: 1,
    cameras: new Map((options.cameras ?? []).map((camera): [string, ProtectCameraConfig] => [ camera.id, camera ])),
    chimes: new Map(),
    lights: new Map(),
    liveviews: new Map(),
    nvr: null,
    ringtones: new Map(),
    sensors: new Map(),
    users: new Map(),
    viewers: new Map()
  };
}

/**
 * Build a minimal-but-real camera config record for construction tests: every field the ProtectCamera construction path actually reads is populated with the
 * quiet-default shape (every feature flag false, recording mode "always", a CONNECTED state, and the fixture host so channel URLs match the golden-master
 * corpus), and the record is then cast once to the full wire type. This is the ONE confined cast seam for the camera record: the ProtectCameraConfig wire type
 * carries many fields the construction path never touches, so we populate the verified read set and document the cast here rather than scattering casts through
 * tests - the same spirit as resolution.fixtures.ts' makeChannel, carried as far as is practical for a much wider record.
 *
 * @param options - channels: the typed channel array (reuse the resolution.fixtures.ts corpus); id / mac / name: optional identity overrides.
 *
 * @returns a camera config record the construction path reads as real.
 */
export function makeCameraConfig(options: { channels: ProtectCameraChannelConfig[]; id?: string; mac?: string; name?: string }): ProtectCameraConfig {

  const name = options.name ?? "Test Camera";

  const populated = {

    channels: options.channels,
    connectionHost: FIXTURE_HOST,
    displayName: name,
    featureFlags: {

      hasIcrSensitivity: false,
      hasInfrared: false,
      hasLedStatus: false,
      hasLuxCheck: false,
      hasPackageCamera: false,
      hasSmartDetect: false,
      hasSpeaker: false,
      hasTamperDetection: false,
      isDoorbell: false,
      smartDetectAudioTypes: [],
      smartDetectTypes: []
    },
    firmwareVersion: "5.0.0",
    id: options.id ?? "test-camera-1",
    isAdoptedByAccessApp: false,
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
    videoCodec: "h264"
  };

  return populated as unknown as ProtectCameraConfig;
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
 * through the accessory's configureController / removeController call logs; ffmpegOptions is the one documented cast seam on this class (only maxSourcePixels is
 * read on the camera family's paths, and only via selectRecordingChannel - never at construction); hksv is null, the correct pre-HKSV-configuration state cleanup
 * reads through this.stream?.hksv?.isRecording; and shutdown / resetProbesizeOverride are recordable no-ops.
 */
export class TestStreamingDelegate implements StreamingDelegate {

  public controller: CameraController;
  public readonly ffmpegOptions: StreamingDelegate["ffmpegOptions"];
  public hksv: StreamingDelegate["hksv"];
  public readonly probesize: number;

  public constructor() {

    // The identity sentinel: a plain object the test matches by reference. The double never operates on the controller's innards - HAP's controller is opaque to
    // the camera beyond registration.
    this.controller = { hbupTestSentinel: "camera-controller" } as unknown as CameraController;

    // The confined cast seam: the camera family reads only maxSourcePixels off ffmpegOptions, and an Infinity ceiling means "no hardware pixel cap" - the
    // pass-everything-through default.
    this.ffmpegOptions = { maxSourcePixels: (): number => Infinity } as unknown as StreamingDelegate["ffmpegOptions"];
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

    // Nothing to tear down - the stub holds no FFmpeg sessions.
  }
}

// The stub StreamingDelegateFactory satisfying the platform's dependency-inversion seam. Records every create call (the camera identity, the resolutions array,
// and the delegate it returned) so tests can assert the seam was exercised exactly once with exactly the advertised resolutions, then hand back the recorded
// delegate's sentinel controller for identity assertions.
export class TestStreamingDelegateFactory implements StreamingDelegateFactory {

  public readonly createCalls: { camera: ProtectCamera; delegate: TestStreamingDelegate; resolutions: Resolution[] }[] = [];

  public create(camera: ProtectCamera, resolutions: Resolution[]): StreamingDelegate {

    const delegate = new TestStreamingDelegate();

    this.createCalls.push({ camera, delegate, resolutions });

    return delegate;
  }
}

// One captured log line from the harness's recording sinks: the level it was emitted at and the raw parameters, so a test can assert on (or ignore) whatever the
// construction path logged.
export interface TestLogEntry {

  level: "debug" | "error" | "info" | "warn";
  parameters: unknown[];
}

// The platform double's honest structural type. The members mirror what ProtectBase and the camera construction path read off nvr.platform: the HAP namespaces,
// a concrete codecSupport (the real platform getter throws before the FFmpeg probe - a concrete object with a non-raspbian hostSystem keeps the recording-default
// switch on its default branch), the ProtectOptions-shaped config, the REAL FeatureOptions engine with an empty user configuration (every option at its default),
// the log sinks, and the streaming-delegate factory seam.
export interface TestProtectPlatform {

  readonly api: { hap: { Characteristic: typeof Characteristic; Service: typeof Service } };
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

// The NVR double's honest structural type, mirroring each member the construction path reads: the v5 client surface (connection health for isReachable, the
// controllerName fallback ProtectBase.name uses for controller-scoped owners, the nvr config record behind the ufp read-through, and the store double as
// client.state), the controller options (overrideAddress deliberately unset so rtspHost resolves the camera's connectionHost), a null mqtt (every MQTT wrapper
// optional-chains into a no-op), the platform double, a REAL un-aborted AbortSignal (composeSignals input and the harness-level teardown lever), and the ufp
// read-through getter.
export interface TestProtectNvr {

  readonly client: {

    connection: { isHealthy: boolean };
    controllerName: string | null;
    nvr: { config: ProtectNvrConfig };
    state: TestStateStore;
  };
  readonly config: ProtectNvrOptions;
  readonly mqtt: null;
  readonly platform: TestProtectPlatform;
  readonly signal: AbortSignal;
  readonly ufp: Readonly<ProtectNvrConfig>;
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
 * @param options - controllerName: the v5 controller label (defaults to "Test Controller"); store: the state-store double backing client.state.
 *
 * @returns controller: the AbortController behind nvr.signal (abort it in suite teardown); factory: the stub streaming-delegate factory; logEntries: every line
 *          the construction path logged; nvr: the NVR double.
 */
export function makeTestNvr(options: { controllerName?: string; store: TestStateStore }):
{ controller: AbortController; factory: TestStreamingDelegateFactory; logEntries: TestLogEntry[]; nvr: TestProtectNvr } {

  const controller = new AbortController();
  const factory = new TestStreamingDelegateFactory();
  const logEntries: TestLogEntry[] = [];
  const sink = (level: TestLogEntry["level"]): ((...parameters: unknown[]) => void) => (...parameters: unknown[]): void => { logEntries.push({ level, parameters }); };
  const client = {

    connection: { isHealthy: true },
    controllerName: options.controllerName ?? "Test Controller",
    nvr: { config: makeNvrConfig() },
    state: options.store
  };

  const nvr: TestProtectNvr = {

    client: client,
    config: { address: "nvr.test", mqttTopic: "test/protect", password: "test-password", username: "test-user" },
    mqtt: null,
    platform: {

      api: { hap: { Characteristic: Characteristic, Service: Service } },
      codecSupport: { hostSystem: "macOS" },
      config: { controllers: [], debugAll: false, options: [], ringDelay: 0, verboseFfmpeg: false, videoProcessor: "ffmpeg" },
      debug: sink("debug"),
      featureOptions: new FeatureOptions(featureOptionCategories, featureOptions, []),
      log: { debug: sink("debug"), error: sink("error"), info: sink("info"), warn: sink("warn") },
      streamingDelegateFactory: factory
    },
    signal: controller.signal,

    // Read-through to the controller record, mirroring the production getter.
    get ufp(): Readonly<ProtectNvrConfig> {

      return client.nvr.config;
    }
  };

  return { controller, factory, logEntries, nvr };
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
