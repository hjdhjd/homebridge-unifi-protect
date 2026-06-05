/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * testing.helpers.ts: Cross-cutting test helpers shared across every unit test in homebridge-unifi-protect.
 *
 * The plugin's production code reads and writes through Homebridge's HAP shapes (Service, Characteristic, Accessory) on every per-accessory configure path. We
 * never want a unit test to drag in the real homebridge package or stand up a live HAP runtime, so this file exposes a hand-built HAP test-double that mirrors
 * only the surface the plugin actually touches: Service identity, Characteristic identity, getService / getServiceById / addService on Accessory,
 * getCharacteristic / updateCharacteristic on Service, and onGet / onSet / value on Characteristic.
 *
 * The surface is intentionally tight. The reachability rewire writes StatusActive across every device class - that is the load-bearing path the double exists
 * to cover. The Service / Characteristic namespaces expand as the production code they exercise reaches for new kinds; adding a new kind is a one-line marker
 * class plus an entry in the namespace object.
 *
 * Co-located with production code under src/ so it ships with the rig. The build excludes *.test.ts and *.helpers.ts via the inherited tsconfig pattern, so
 * this file never reaches the published dist/ tree.
 */

// Identity class for a HAP Service kind. HAP exposes each service kind (MotionSensor, OccupancySensor, Switch, ...) as a distinct constructor; production code
// passes that constructor as a key into accessory.getService / addService and into service.getCharacteristic. We mirror that contract with one marker class per
// kind, exposed through the Service namespace below. The classes are not instantiated by production code (the constructor reference is the identity), but each
// carries a hapKind instance property so test failures surface the kind directly in inspect output and so the class is meaningful enough to dodge the
// no-extraneous-class lint rule.
class AccessoryInformationServiceType {

  public readonly hapKind = "AccessoryInformation" as const;
}

class MotionSensorServiceType {

  public readonly hapKind = "MotionSensor" as const;
}

// The occupancy sensor kind. Added for the reachability fan-out tests: an accessory carrying both a MotionSensor and an OccupancySensor exercises refreshReachability
// writing StatusActive across every service that declares it.
class OccupancySensorServiceType {

  public readonly hapKind = "OccupancySensor" as const;
}

class SwitchServiceType {

  public readonly hapKind = "Switch" as const;
}

// The contact-sensor kind. Added for the auth-sensor delivery tests: the firehose router's authEventHandler resolves an "Auth"-subtyped ContactSensor service and writes
// its ContactSensorState on a recognized fingerprint/NFC scan, so an accessory carrying one exercises the real auth trip/reset path.
class ContactSensorServiceType {

  public readonly hapKind = "ContactSensor" as const;
}

// The lock-mechanism kind. Added for the access-unlock delivery tests: the firehose router's accessEventHandler resolves an "Access"-subtyped LockMechanism service and
// toggles its lock characteristics, so an accessory carrying one exercises the real unlock/re-secure path.
class LockMechanismServiceType {

  public readonly hapKind = "LockMechanism" as const;
}

// The HAP Service namespace as the test-double exposes it. Add new kinds here when a test reaches for one the production code touches. Alphabetical, per the
// house style for object property order.
export const Service = {

  AccessoryInformation: AccessoryInformationServiceType,
  ContactSensor: ContactSensorServiceType,
  LockMechanism: LockMechanismServiceType,
  MotionSensor: MotionSensorServiceType,
  OccupancySensor: OccupancySensorServiceType,
  Switch: SwitchServiceType
} as const;

// Identity class for a HAP Characteristic kind. Same pattern as Service: each characteristic kind is its own marker class; production code passes the class as
// a key to getCharacteristic / updateCharacteristic. Carries a hapKind instance property for the same reasons documented on the Service marker classes.
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

// The HAP Characteristic namespace as the test-double exposes it. StatusActive is the load-bearing one...the isReachable rewire writes it across every device
// class, so the reachability tests pivot on this characteristic. On covers the toggle pair used by switches in the double's self-test. LockCurrentState /
// LockTargetState back the access-unlock delivery tests. Expand as the production code reaches for new kinds.
export const Characteristic = {

  ContactSensorState: ContactSensorStateCharacteristicType,
  LockCurrentState: LockCurrentStateCharacteristicType,
  LockTargetState: LockTargetStateCharacteristicType,
  On: OnCharacteristicType,
  StatusActive: StatusActiveCharacteristicType,
  StatusTampered: StatusTamperedCharacteristicType
} as const;

// Shorthand for the constructor-as-key shape both Service and Characteristic expose. We use the class itself (not an instance) as the Map key throughout, so
// these are constructor types whose argument list is intentionally permissive...the marker classes take no arguments, but a future expansion that fronts a real
// HAP class would carry its own signature, and we want the alias to admit either.
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

// One service instance attached to a TestAccessory. Holds a Map of characteristic-kind -> TestCharacteristic so getCharacteristic returns the same instance
// across calls...production code binds onGet once and expects the binding to stay attached on the next read.
export class TestService {

  public readonly type: ServiceType;
  public readonly displayName: string;
  public readonly subtype: string | undefined;
  private readonly characteristics = new Map<CharacteristicType, TestCharacteristic>();

  public constructor(type: ServiceType, displayName: string, subtype: string | undefined) {

    this.type = type;
    this.displayName = displayName;
    this.subtype = subtype;
  }

  // Fetch or lazily create the characteristic of the given kind. Lazy creation matches HAP, which instantiates required characteristics on first access.
  public getCharacteristic(charType: CharacteristicType): TestCharacteristic {

    let char = this.characteristics.get(charType);

    if(!char) {

      char = new TestCharacteristic(charType);
      this.characteristics.set(charType, char);
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

    return this.characteristics.has(charType);
  }
}

// One accessory. Carries an AccessoryInformation service from construction (every HomeKit accessory has one); subsequent addService calls append additional
// services. getService / getServiceById mirror HAP's distinction between "the bare service of this type" and "the service of this type with a specific subtype".
export class TestAccessory {

  public readonly displayName: string;
  public readonly UUID: string;
  // Exposed so production code that iterates every service on the accessory (ProtectDevice.refreshReachability walks accessory.services) sees the same surface HAP's
  // PlatformAccessory.services offers.
  public readonly services: TestService[] = [];

  public constructor(displayName: string, uuid: string) {

    this.displayName = displayName;
    this.UUID = uuid;
    this.services.push(new TestService(Service.AccessoryInformation, displayName, undefined));
  }

  // Add a new service to the accessory. Returns the new TestService so production code can immediately bind characteristics on it.
  public addService(type: ServiceType, name?: string, subtype?: string): TestService {

    const service = new TestService(type, name ?? this.displayName, subtype);

    this.services.push(service);

    return service;
  }

  // Find the first service of the given type with no subtype. Production code uses this for the "primary" service of a type.
  public getService(type: ServiceType): TestService | undefined {

    return this.services.find((service) => (service.type === type) && (service.subtype === undefined));
  }

  // Find the service of the given type AND subtype. Production code uses subtypes to disambiguate among multiple Switch services on one accessory.
  public getServiceById(type: ServiceType, subtype: string): TestService | undefined {

    return this.services.find((service) => (service.type === type) && (service.subtype === subtype));
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
