/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * device.ts: ProtectDevice - the per-accessory device base (its shared spine, ProtectBase, lives in device-base.ts).
 */
import type { API, CharacteristicValue, Service } from "homebridge";
import type { AcquireServiceOptions, AcquireServiceResult, HomebridgePluginLogging, LogFeatureArgs, MqttAvailabilityPayload, Nullable, ValidServiceOptions,
  ValidServiceResult } from "homebridge-plugin-utils";
import type { DeviceCollectionKey, ProtectDeviceConfig, ProtectState } from "unifi-protect";
import { MQTT_AVAILABILITY_OFFLINE, MQTT_AVAILABILITY_ONLINE, acquireService, getServiceName, mqttGetTopic, mqttSetTopic, mqttTopic, ownedName, presenceChanged,
  resolveNameOverride, sanitizeName, setAccessoryName, setServiceName, validCharacteristic, validService, watchServiceName } from "homebridge-plugin-utils";
import { PROTECT_MOTION_DURATION, PROTECT_OCCUPANCY_DURATION} from "../settings.ts";
import type { ProtectAccessory, ProtectPersistedContextState, ProtectProjectionMap, ProtectServiceNaming, ProtectServiceOptions, WithoutIdentity } from "../types.ts";
import { describeDevice, deviceDisplayNaming } from "./device-descriptor.ts";
import { isDeviceAdopted, isDeviceOnline } from "unifi-protect";
import { legacyFamilyForOption, resolveLegacySelection } from "../options-legacy.ts";
import type { DeviceDisplayNaming } from "./device-descriptor.ts";
import type { LegacyFamily } from "../options-legacy.ts";
import type { ObserverWakePayload } from "../diagnostics.ts";
import { ProtectBase } from "./device-base.ts";
import type { ProtectCapabilityHost } from "./device-capability.ts";
import type { ProtectNvr } from "../nvr/nvr.ts";
import type { ProtectPlatform } from "../platform.ts";
import { ProtectReservedNames } from "../types.ts";
import { channels } from "../diagnostics.ts";
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

  /* The custom HomeKit name the user set for this device, trimmed, or null when they set none HomeKit can carry, as HBPU's custom-name rule decides. It is resolved
   * here once, as every option is, because an option changes only at a restart, and because the option read goes through the device's record, which is gone for a
   * device lingering in the removal grace: a reader of the hint never reads that record at all.
   */
  nameOverride: Nullable<string>;

  // Whether the plugin owns this device's HomeKit name, as HBPU's family naming rule decides it from the custom name above and SyncName below: a custom name HomeKit
  // can carry owns it, SyncName on owns it otherwise, and with neither the user does. It is resolved once with the hints it reads, so the accessory and every part
  // named from it follow one answer for the life of the process.
  nameOwned: boolean;

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

  // Whether the plugin can vouch for this device's values, the verdict No Response reads.
  readonly isAvailable: boolean;

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

// A part held to the name the plugin owns for its device: its service, the suffix it adds to the device's name, and the watch that puts the owned name back after a
// rename in the Home app, or null for a kind HomeKit names with Name alone, which the Home app cannot rename.
interface OwnedPart {

  readonly service: Service;
  readonly suffix: string;
  readonly watch: Nullable<Disposable>;
}

// The key a part is held under: its service type and its subtype, where no subtype and an empty one name the same service, as HBPU's service lookup reads them.
function partKey({ UUID, subtype }: { readonly UUID: string; readonly subtype?: string }): string {

  return UUID + " " + (subtype ?? "");
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

// The per-accessory device base every device family extends: it owns the live projection handle, the resolved feature-option hints bag, the service lifecycle every
// part on its accessory goes through (acquireService/validService/removeService), the base motion/occupancy/status-LED capabilities, and the observers every family
// shares. The generic parameter D is the concrete live-projection type the family supplies on its own class header; it defaults to the full device-collection union
// so a bare ProtectDevice reference (the NVR's device iterator, a test stand-in) still type-checks against every category.
export abstract class ProtectDevice<D extends ProtectProjectionMap[DeviceCollectionKey] = ProtectProjectionMap[DeviceCollectionKey]> extends ProtectBase
  implements ProtectCapabilityHost, ProtectDeviceContext {

  public accessory: ProtectAccessory;
  // The live projection for this device. Holds (client, id), reads through to the store on every config access. Set once at construction; never reassigned -
  // the accessory's identity is its MAC, stable across reboots, so the handle never goes stale. The concrete projection type comes from this class's generic parameter,
  // supplied by each family's class header, and the NVR root injects the projection itself at adoption, where it knows the concrete type. The parameter defaults to the
  // full category union, so a bare ProtectDevice reference (the NVR's deviceEndpoints iterator, a test stand-in) reads the whole projection union.
  protected readonly device: D;
  // The per-device resolved feature-hint bag, declared with definite assignment rather than seeded: configure() calls configureHints() first, before configureDevice(),
  // spawnObservers() or any HomeKit callback can read this.hints, so no consumer ever observes the bag before it holds every hint. That template contract is what makes
  // the definite-assignment declaration sound, and it is the reason the derivation can build the bag as one literal below rather than filling a pre-seeded object field
  // by field.
  public hints!: ProtectHints;
  // The parts held to the name the plugin owns for this device, keyed by service type and subtype (see holdPartName). The registry assumes no subtype-less service is
  // acquired beside subtyped siblings of its kind, because HBPU makes room for one by detaching and re-adding those siblings, which clears the watch's listener from a
  // sibling the registry still holds as watched.
  private readonly ownedParts = new Map<string, OwnedPart>();

  // The constructor captures the accessory and the live projection handle. A device's lifetime is its accessory's: it supplies no parent signal, so the spine composes
  // its per-accessory controller against nvr.signal and the accessory's observers, MQTT registrations, and timers all bind to the result. The hints bag, the device's
  // configuration, and its observers are set up by configure() below, which the builder runs through configured() once construction returns.
  constructor(nvr: ProtectNvr, accessory: ProtectAccessory, device: D) {

    super(nvr);

    this.accessory = accessory;
    this.device = device;
  }

  /* Set this device up for HomeKit, the template every family shares: the hints first, because every service acquisition reads them to decide whether the plugin owns
   * the part's name, then the family's own configuration, then its observers. A family supplies configureDevice and extends spawnObservers; it never overrides this
   * order. The device claims its accessory last, so a restored accessory goes on refusing until the setup standing behind it has finished, and one whose setup threw
   * never stops. Its availability statement brackets the family's work: what keeps the statement current registers ahead of everything the family registers, so it opens
   * every later broker session's restatements, and the statement itself goes out once the claim has made it true.
   */
  public override configure(): void {

    this.configureHints();
    this.configureAvailability();
    this.configureDevice();
    this.spawnObservers();
    this.platform.claimAccessory(this.accessory, this);
    this.publishAvailability();
  }

  // Configure the family's HomeKit services, characteristics, and MQTT interface on this device's accessory, the family's half of the configure() template above.
  protected abstract configureDevice(): boolean;

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
   * exactly the identity-dropped view of each family's own config - proven at every concrete leaf and at the bare default by the type-identity assertions in
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

  /* The service lifecycle every part of this device goes through, a capability's parts included, since a capability composed onto the device reaches these through
   * its host: acquireService and validService below stand a part up on the accessory or reconcile its presence, and removeService takes one off. Keeping the one
   * lifecycle on the device is what lets every part the accessory carries be named and removed by one rule, whichever owner configures it: a part that declares a
   * suffix is held to the name the plugin owns for the device, as holdPartName below states, and a part that carries a name of its own is controller data the rule
   * leaves alone.
   *
   * Acquire a service on this device's accessory, creating it when the accessory carries none. The lifecycle supplies the accessory and composes the part's name, and
   * answers with the homebridge-plugin-utils result unchanged: the service, and the transition that says whether this call attached it or kept one already present.
   * A service it attaches changes what Homebridge's accessory cache holds, so the accessory is marked for the next save.
   */
  public acquireService<T extends Service>(options: ProtectServiceOptions<AcquireServiceOptions<T>>): AcquireServiceResult<T> {

    const acquired = acquireService(this.libraryOptions(options));

    if(acquired.transition === "attached") {

      this.platform.persistence.persist(this.accessory);
    }

    this.holdPartName({ part: options, service: acquired.service });

    return acquired;
  }

  // Reconcile a service's presence on this device's accessory from one verdict, supplying the accessory and composing the part's name the same way. The verdict is
  // either a plain boolean or a presence-aware predicate, mirroring the homebridge-plugin-utils free function this delegates to: the predicate receives the service's
  // current presence so a gate can keep an already-present service while refusing to create a new one (the additive-eager / subtractive-conservative capability
  // gates). The answer is the library's own: the service with an attached or kept transition when the verdict keeps it, or null with a removed or absent transition
  // when it does not. A service it attaches or removes changes what Homebridge's accessory cache holds, so the accessory is marked for the next save.
  public validService<T extends Service>(options: ProtectServiceOptions<ValidServiceOptions<T>>): ValidServiceResult<T> {

    const validated = validService(this.libraryOptions(options));

    if(presenceChanged(validated.transition)) {

      this.platform.persistence.persist(this.accessory);
    }

    this.holdPartName({ part: options, service: validated.service });

    return validated;
  }

  // Remove a part from this device's accessory, ending the watch that holds it to the name the plugin owns when it carries one, since a watch left on the device's
  // signal would keep the removed service reachable. Taking a service off changes what Homebridge's accessory cache holds, so the accessory is marked for the next
  // save.
  public removeService(service: Service): void {

    const key = partKey(service);
    const held = this.ownedParts.get(key);

    if(held?.service === service) {

      held.watch?.[Symbol.dispose]();
      this.ownedParts.delete(key);
    }

    this.accessory.removeService(service);
    this.platform.persistence.persist(this.accessory);
  }

  /* Hold a part named from this device to the name the plugin owns, or let go of one a verdict took off the accessory, each time the service lifecycle answers for it. A
   * part carrying a name of its own is controller data the rule leaves alone, and nothing is held while the user owns the device's name, so with neither a custom name
   * nor SyncName this costs one test of the hint. A held part is renamed to the owned name followed by its suffix when it is first held, marking the accessory for the
   * next save when that wrote anything, and watched so a rename in the Home app is put back at once; a kind HomeKit names with Name alone gives the Home app nothing
   * to rename, so it is renamed and never watched. A reconcile pass that hands back the service already held, the steady state, costs one lookup and writes nothing.
   *
   * An entry ends when its part is removed, by a verdict here or through removeService, when another instance takes its key, and when the device's signal aborts,
   * which ends every watch with the device's cleanup, its removal and the plugin's shutdown. Ownership and every suffix are fixed for the process, and a controller
   * rename moves only the owned name, which each watch reads afresh and syncNameFromController writes, so no entry needs anything more. The static doorbell sweep and
   * a streaming rebuild's controller removal each take only services this process never held, so neither passes through here.
   */
  private holdPartName({ part, service }: { part: ProtectServiceNaming & { readonly serviceType: { readonly UUID: string }; readonly subtype?: string };
    service: Nullable<Service>; }): void {

    if((part.name !== undefined) || !this.hints.nameOwned) {

      return;
    }

    const key = partKey({ UUID: part.serviceType.UUID, subtype: part.subtype });
    const held = this.ownedParts.get(key);

    if(held?.service === service) {

      return;
    }

    held?.watch?.[Symbol.dispose]();

    if(!service) {

      this.ownedParts.delete(key);

      return;
    }

    const suffix = part.suffix ?? "";

    if(setServiceName(service, this.homeKitName + suffix)) {

      this.platform.persistence.persist(this.accessory);
    }

    this.ownedParts.set(key, { service, suffix, watch: service.testCharacteristic(this.hap.Characteristic.ConfiguredName) ?
      watchServiceName({ log: this.log, name: () => this.ownedPartName(suffix), service, signal: this.signal }) : null });
  }

  // The name the plugin owns for a part named from this device, the owned name followed by the part's suffix, or null while the user owns the device's name.
  private ownedPartName(suffix: string): Nullable<string> {

    const owned = this.ownedHomeKitName;

    return (owned === null) ? null : (owned + suffix);
  }

  // The homebridge-plugin-utils options a part's lifecycle call hands the library: everything the part's options carry but its naming, with this device's accessory
  // supplied and the name the part is created with composed, the name it carries where it names itself, and otherwise this device's name as the accessory carries
  // it, followed by the suffix the part declares.
  private libraryOptions<O extends ProtectServiceNaming>({ name, suffix = "", ...options }: O): Omit<O, "name" | "suffix"> & { accessory: ProtectAccessory;
    name: string; } {

    return { ...options, accessory: this.accessory, name: name ?? (this.accessoryName + suffix) };
  }

  // Configure device-specific settings. The complete base bag is built as one literal and assigned, which is what lets the field be declared with definite assignment
  // rather than seeded with a lying empty object: the bag exists in full from its first moment. smartDetect and smartOccupancy seed inert here for every family; the
  // camera family's override derives their real values.
  protected configureHints(): boolean {

    // The custom name and SyncName are read first, so the naming rule decides ownership from the very values the hints carry. Its fallback reads the accessory alone
    // rather than homeKitName, which reads the hints this literal is still building, and a fallback never moves whether the rule answers null.
    const customName = this.getFeatureValue("Device.Name");
    const nameOverride = resolveNameOverride(customName);
    const syncName = this.hasFeature("Device.SyncName");

    this.hints = {

      enabled: this.hasFeature("Device"),
      logMotion: this.hasFeature("Log.Motion"),
      motionDuration: this.getFeatureNumber("Motion.Duration") ?? PROTECT_MOTION_DURATION,
      nameOverride,
      nameOwned: ownedName({ fallback: this.accessoryName, override: nameOverride, sync: syncName }) !== null,
      occupancyDuration: this.getFeatureNumber("Motion.OccupancySensor.Duration") ?? PROTECT_OCCUPANCY_DURATION,
      smartDetect: false,
      smartOccupancy: [],
      standalone: this.hasFeature("Device.Standalone"),
      syncName
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
    this.announceFeature({ label: "Protect name sync", option: "Device.SyncName" });

    // The line names the name the plugin applies, the custom name as HomeKit's naming rules clean it, with a package camera's display suffix where it applies. A value
    // HomeKit can carry nothing of is refused by HBPU's rule, and a refusal the user would otherwise never see is said once, here, with the value as the user set it.
    if(this.hints.nameOverride !== null) {

      this.log.info("Custom HomeKit name set to %s.", this.homeKitName);
    } else if(customName?.length) {

      this.log.warn("The custom name \"%s\" leaves nothing HomeKit can display, so it is not applied.", customName);
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

    /* Name the accessory as HomeKit should carry it while the plugin owns the name, a custom name the user set or name syncing, and hold it there: the information
     * service's watch puts the owned name back the moment the Home app renames the accessory's tile, reading the owned name afresh on each rename, so a controller
     * rename under SyncName reaches the next restore. With neither set the user owns the name, so the accessory keeps the name it carries, a Home app rename
     * included, and nothing watches it. HBPU's name helper writes only the names that differ and answers whether it wrote any, so the accessory is marked for the
     * next save exactly when the write changed what Homebridge's accessory cache holds - a fresh accessory's first write adds its ConfiguredName - and a steady start
     * saves nothing. This runs once per device object, so the information service carries one watch, which ends with the device's signal; it sits outside the
     * part registry because the accessory's information service is never removed while the device stands.
     */
    if(this.hints.nameOwned) {

      if(setAccessoryName(this.accessory, this.homeKitName)) {

        this.platform.persistence.persist(this.accessory);
      }

      const info = this.accessory.getService(this.hap.Service.AccessoryInformation);

      if(info) {

        watchServiceName({ log: this.log, name: () => this.ownedHomeKitName, service: info, signal: this.signal });
      }
    }

    /* Tell the user, once per device object, when the controller's name for this device has nothing HomeKit can display and the accessory carries the name the rule
     * fell back to in its place. An accessory carrying any other name, a Home app rename among them, is left unwarned, because the line would describe a name it does not
     * carry, and the controller sync never warns, so a rename later in the run does not repeat it. A custom name the user set names the device ahead of the controller's
     * name, so the rule passes nothing over and the line, which points the user at that setting, never speaks while one is in force.
     */
    const { name, passedOver } = this.homeKitNaming;

    if((passedOver !== null) && (getServiceName(this.accessory.getService(this.hap.Service.AccessoryInformation)) === name)) {

      this.log.warn("The name \"%s\" leaves nothing HomeKit can display, so this device is named %s until a Name set in the plugin's settings replaces it.",
        passedOver, name);
    }

    // setInfo reads the full identity-bearing record (marketName/type/mac/hardwareRevision/firmwareVersion), so it takes the raw record - present at configure time -
    // rather than the narrowed live-state projection, which carries no identity.
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
      this.settleStatusActive(service);

      this.answerHeld(service, this.hap.Characteristic.MotionDetected);

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

  // Settle StatusActive on a motion or occupancy sensor as it is set up. A light or a standalone sensor carries none, one restored from the accessory cache included, No
  // Response being what HomeKit shows when it cannot be reached. The camera family overrides this, because a camera's sensors carry it.
  protected settleStatusActive(service: Service): void {

    this.removeStatusActive(service);
  }

  // Take StatusActive off a service, the one a restored service carries from the accessory cache included, marking the accessory for the next save when that changed what
  // Homebridge's accessory cache holds. The gate reads presence without attaching, so a service that never carried it costs one lookup.
  protected removeStatusActive(service: Service): void {

    if(presenceChanged(validCharacteristic({ characteristic: this.hap.Characteristic.StatusActive, service, validate: false }))) {

      this.platform.persistence.persist(this.accessory);
    }
  }

  // Configure a switch to easily activate or deactivate motion sensor detection for HomeKit.
  private configureMotionSwitch({ enabled = true }: Pick<ProtectConfigurePass, "enabled"> = {}): boolean {

    // The switch stands exactly where the motion sensor does, so a device with no motion sensor says nothing about it.
    if(enabled) {

      this.announceFeature({ kindLabel: "Motion sensor switches", label: "Motion sensor switch", option: "Motion.Switch" });
    }

    // Validate whether we should have this service enabled.
    const { service } = this.validService({ serviceType: this.hap.Service.Switch, subtype: ProtectReservedNames.SWITCH_MOTION_SENSOR, suffix: " Motion Events",
      validate: enabled && this.hasFeature("Motion.Switch") });

    if(!service) {

      // If we disable the switch, make sure we fully reset its state. Otherwise, we can end up in a situation (e.g. liveview switches) where we have disabled motion
      // detection with no meaningful way to enable it again.
      this.accessory.context.detectMotion = true;

      return false;
    }

    // Activate or deactivate motion detection.
    service.getCharacteristic(this.hap.Characteristic.On).onGet(this.answering(() => !!this.accessory.context.detectMotion));

    service.getCharacteristic(this.hap.Characteristic.On).onSet(this.answering((value: CharacteristicValue) => {

      if(this.accessory.context.detectMotion !== value) {

        this.log.info("Motion detection %s.", value ? "enabled" : "disabled");
      }

      this.platform.persistence.persist(this.accessory, { detectMotion: !!value });
    }));

    // Initialize the switch state.
    if(!("detectMotion" in this.accessory.context)) {

      this.accessory.context.detectMotion = true;
    }

    service.updateCharacteristic(this.hap.Characteristic.On, this.accessory.context.detectMotion ?? true);

    return true;
  }

  // Configure a switch to manually trigger a motion sensor event for HomeKit.
  private configureMotionTrigger({ enabled = true }: Pick<ProtectConfigurePass, "enabled"> = {}): boolean {

    // The trigger stands exactly where the motion sensor does, so a device with no motion sensor says nothing about it.
    if(enabled) {

      this.announceFeature({ kindLabel: "Motion sensor automation triggers", label: "Motion sensor automation trigger", option: "Motion.Trigger" });
    }

    // Validate whether we should have this service enabled.
    const { service: triggerService } = this.validService({ serviceType: this.hap.Service.Switch, subtype: ProtectReservedNames.SWITCH_MOTION_TRIGGER,
      suffix: " Motion Trigger", validate: enabled && this.hasFeature("Motion.Trigger") });

    if(!triggerService) {

      return false;
    }

    const motionService = this.accessory.getService(this.hap.Service.MotionSensor);
    const switchService = this.accessory.getServiceById(this.hap.Service.Switch, ProtectReservedNames.SWITCH_MOTION_SENSOR);

    // Activate or deactivate motion detection.
    triggerService.getCharacteristic(this.hap.Characteristic.On).onGet(
      this.answering(() => !!motionService?.getCharacteristic(this.hap.Characteristic.MotionDetected).value));

    triggerService.getCharacteristic(this.hap.Characteristic.On).onSet(this.answering((isOn: CharacteristicValue) => {

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
    }));

    // Initialize the switch.
    triggerService.updateCharacteristic(this.hap.Characteristic.On, false);

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

      // Initialize the state of the occupancy sensor.
      service.updateCharacteristic(this.hap.Characteristic.OccupancyDetected, false);
      this.settleStatusActive(service);

      this.answerHeld(service, this.hap.Characteristic.OccupancyDetected);

      // Resolve which smart detection types determine occupancy through the family's one derivation. It answers a fresh list that is assigned whole, so a live
      // re-creation of the service starts from the current answer rather than adding to the previous one.
      this.hints.smartOccupancy = this.deriveSmartOccupancy();

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

  // The smart detection types that determine this device's occupancy. Only a camera reports smart detections, so the base answers none and the camera family overrides
  // this with the delivered types its owner selected. Every write of the hint goes through this one method - the occupancy configure above and the camera's live
  // reconcile alike - so the list has a single derivation.
  protected deriveSmartOccupancy(): readonly string[] {

    return [];
  }

  // Configure a switch to turn on or off the status indicator light for HomeKit.
  protected configureStatusLedSwitch({ enabled = true }: Pick<ProtectConfigurePass, "enabled"> = {}): boolean {

    // A device a caller says has no status light stands no switch, so it says nothing about one.
    if(enabled) {

      this.announceFeature({ kindLabel: "Status indicator light switches", label: "Status indicator light switch", option: "Device.StatusLed.Switch" });
    }

    // Validate whether we should have this service enabled.
    const { service } = this.validService({ serviceType: this.hap.Service.Switch, subtype: ProtectReservedNames.SWITCH_STATUS_LED, suffix: " Status Indicator",
      validate: enabled && this.hasFeature("Device.StatusLed.Switch") });

    if(!service) {

      return false;
    }

    // Enable or disable the status indicator light.
    service.getCharacteristic(this.hap.Characteristic.On).onGet(this.answering(() => this.statusLed));

    service.getCharacteristic(this.hap.Characteristic.On).onSet(this.answering(async (value: CharacteristicValue) => {

      if(this.statusLed !== value) {

        this.log.info("Status indicator light %s.", value ? "enabled" : "disabled");
      }

      // Push the new state to the controller. setStatusLed routes through the shared command-error helper, which is the single place a failure (including an
      // authorization failure) is reported, so there is nothing to branch on here.
      await this.setStatusLed(!!value);
    }));

    // Initialize the switch state.
    service.updateCharacteristic(this.hap.Characteristic.On, this.statusLed);

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

  // State a plain on or off feature option once, where it was set: on the plugin's log for a global entry, the controller's for a controller entry and this device's for
  // a device entry. The device's id is its record's MAC, the same one hasFeature reads, so a package camera answers to its parent doorbell's entries. Public because a
  // capability's features are its host's.
  public announceFeature(feature: Pick<LogFeatureArgs, "kindLabel" | "label" | "option">): void {

    this.platform.featureOptions.logFeature({ ...feature, controller: { id: this.nvr.ufp.mac, log: this.nvr.log }, device: { id: this.device.config.mac, log: this.log },
      log: this.platform.pluginLog });
  }

  // Utility function to check whether a proposed identifier collides with any reserved subtype name the plugin uses, spanning switches, sensors, lightbulbs, and locks.
  public isReservedName(name?: string): boolean {

    return name ? RESERVED_NAMES.has(name.toUpperCase()) : false;
  }

  // Two-scope reachability: controller health gates every device at once (a controller outage freezes device.isOnline at a stale value, so it cannot be trusted alone),
  // device.isOnline gates each device. This answers whether an operation is worth starting right now, the question the media paths ask, and isAvailable below answers
  // whether the plugin can vouch for the values HomeKit reads. Operation-initiation gates read this; HKSV composes its readiness gate (buffer >= 10s) at its call site,
  // never inside here. The library deliberately does NOT ship this composition (a deliberate design decision: isOnline is last-known device state) - the plugin is the
  // consumer that composes per-operation reachability.
  public get isReachable(): boolean {

    return this.nvr.client.connection.isHealthy && this.isOnline;
  }

  // Whether the plugin can vouch for this device's values, the verdict every handler's refusal and every MQTT availability statement read: the controller's verdict, and
  // this device's own record.
  public override get isAvailable(): boolean {

    return super.isAvailable && this.recordAvailable;
  }

  // The device half of availability: whether this device's record says it is here, adopted by this controller and connected to it. An absent record, a device lingering
  // in the removal grace, reads false. A family whose record reports no connection fact worth reading overrides this.
  protected get recordAvailable(): boolean {

    return this.fromRecord(isDeviceAdopted, false) && this.isOnline;
  }

  // The device half of reachability: whether this device's own controller record reports it connected, with no regard to the controller's health. Read non-throwing
  // through the record, so a vanished record (a device lingering in the removal grace) reports offline rather than throwing, the total form every path that consults
  // it needs. The camera family's capability reconcile reads it as its connected gate.
  public get isOnline(): boolean {

    return this.fromRecord(isDeviceOnline, false);
  }

  // Spawn this accessory's narrow-selector state observers: one for-await loop per reaction, each yielding only when its watched slice changes by reference, so
  // idle wake-ups are structurally zero (the store's Object.is dedup is upstream of the yield). Leaves override and call super to add their device-specific reactions;
  // the base owns the reactions every device class shares - syncing the controller's name into HomeKit and refreshing device information on a firmware update - so
  // each propagates whatever the device kind. Each loop binds to this.signal, so cleanup()/reconfigure/shutdown tear them all down through the per-accessory
  // controller abort.
  protected spawnObservers(): void {

    // Bind the by-id config selector once, as each device family does for its own observers, so every evaluation reuses the same closure.
    const config = this.deviceConfigSelector();

    // The universal reaction: when the controller-side name changes and the user opted into name syncing, push it to the HomeKit accessory. The selector is the name
    // slice itself, so this fires whenever that slice changes while the record is present, a record returning within the removal grace included, and never on
    // routine config churn.
    this.observeState({ key: "device.name", selector: state => config(state)?.name, title: "the device name" }, () => this.syncNameFromController());

    // Device information (model, serial, firmware) is set once at configure; the firmware revision is the only field that changes at runtime, on a Protect firmware
    // update. A narrow observe on that slice refreshes the AccessoryInformation service through setInfo alone when (and only when) firmware changes. The name is the
    // name observer's above, so a firmware update leaves a name the user set in the Home app standing.
    this.observeState({ key: "device.firmwareVersion", selector: state => config(state)?.firmwareVersion, title: "device information" },
      () => this.setInfo(this.accessory, this.device.config));
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

    return this.nvr.client.state.selectors[this.device.modelKey].byId(this.device.id);
  }

  /* The name the plugin applies to this device's accessory in HomeKit, and the device's own name the rule passed over to reach it: the custom name the user set where
   * HomeKit can carry it, and the controller's name for the device otherwise, through the one name rule the accessory is minted under, so the mint, every configure
   * pass, and the controller sync cannot name a device differently. The name is the one to apply rather than the name the accessory's information service carries
   * now, which accessoryName below reads: while the user owns the name nothing applies this one, so the two part once the controller's name for the device moves on,
   * or a custom name is cleared. This is the single derivation every name write and every restore reads - the accessory's and each part's alike - and a leaf decorates
   * it through homeKitNameSuffix below rather than by overriding it, so every write picks the decoration up without the parent fanning anything out. The record is read
   * non-throwing, so a vanished record falls back to the custom name and then to the name the accessory's information service carries now, which already carries any
   * decoration and so takes none of its own, and passes nothing over, since no record is read. configureInfo reads the whole answer, to tell the user when the
   * controller's name for the device has nothing HomeKit can display.
   */
  protected get homeKitNaming(): DeviceDisplayNaming {

    const config = this.device.peek();

    if(config) {

      const { name, passedOver } = deviceDisplayNaming(config, { override: this.hints.nameOverride });

      return { name: name + this.homeKitNameSuffix, passedOver };
    }

    return { name: (this.hints.nameOverride !== null) ? (sanitizeName(this.hints.nameOverride) + this.homeKitNameSuffix) : this.accessoryName, passedOver: null };
  }

  // The name the plugin applies to this device's accessory in HomeKit, the name homeKitNaming above answers.
  protected get homeKitName(): string {

    return this.homeKitNaming.name;
  }

  // The text a leaf adds to the name homeKitName derives from the record or the custom name, the one place a leaf decorates the name the plugin applies. The base adds
  // none, and the package camera adds its display suffix.
  // eslint-disable-next-line @typescript-eslint/class-literal-property-style -- Overridden by the package camera's getter; the base cannot be a readonly field.
  protected get homeKitNameSuffix(): string {

    return "";
  }

  // The name the plugin owns for this device's accessory, or null while the user owns it: homeKitName above while the nameOwned hint holds. Every holder of an owned
  // name reads this afresh on each rename it puts back, so a controller rename under SyncName reaches the next restore.
  protected get ownedHomeKitName(): Nullable<string> {

    return this.hints.nameOwned ? this.homeKitName : null;
  }

  // Sync the controller's device name into HomeKit when the user enabled name syncing. The name applied is the homeKitName derivation above, so a custom name the user
  // set holds through a controller-side rename, and HBPU's name helper writes only the names that differ and answers whether it wrote any, so a name-slice yield that
  // finds every name matching writes nothing and saves nothing. Every part held to the owned name follows the accessory to its new name, each written where it
  // differs, so a controller rename reaches every part named from the device, a capability's parts included.
  // Any write changes what Homebridge's accessory cache holds and marks the accessory for the next save, a record returning within the removal grace and restoring the
  // controller's name over one the user set in the Home app included. The rename line is logged only when the platform accessory's display name moved: the plugin alone
  // writes that name and the Home app never touches it, so a move means the controller-side name changed, while a restore over a Home app rename logs nothing. The line
  // names the name HomeKit carries after the write, the controller's name as HomeKit's naming rules clean it.
  protected syncNameFromController(): void {

    if(!this.hints.syncName) {

      return;
    }

    const name = this.homeKitName;
    const previousName = this.accessory.displayName;

    if(!setAccessoryName(this.accessory, name)) {

      return;
    }

    if(this.accessory.displayName !== previousName) {

      this.log.info("Detected a name change on the controller; updating the HomeKit name to %s.", this.accessory.displayName);
    }

    for(const { service, suffix } of this.ownedParts.values()) {

      setServiceName(service, name + suffix);
    }

    this.platform.persistence.persist(this.accessory);
  }

  // Pushed by the NVR's connection observe loop each time the connection moves, walking every device from one reader of that fact. The connection is half of what this
  // device's availability reads, so the statement is made again here, and a family with more that depends on the connection extends this.
  public noteConnectionChanged(): void {

    this.publishAvailability();
  }

  /* Keep this device's availability statement standing on the broker wherever the controller's MQTT is enabled, an MQTT that is not costing nothing at all.
   *
   * Each broker session restates it, since the client forgets what each topic last delivered when a session starts. This registers on the client directly rather than
   * through restateOnConnect, which skips a device whose record is absent: a device lingering in its removal grace still has this one thing to say, and with a statement
   * lost to a broker outage, the online it stated last would otherwise stand until the removal.
   *
   * The final word is stated inside the client's graceful end, so the broker holds the device offline while the plugin is not running. It publishes on the client under
   * the very signal the end hands it, the one signal the end admits, and it skips the change gate, because the broker has to hold offline whatever this device last
   * stated. The registration lives as long as this device does, so a device removed mid-run, whose removal states it or holds it for the next session, says nothing more.
   *
   * The observer follows the record's half of the verdict. Its selector reduces adoption and connection to one value, so it wakes on a change to either and on nothing
   * else in the record, and the change gate is what decides whether a wake says anything, which is how a family that ignores one of them stays quiet about it. A record
   * that vanishes wakes it into observeState's gate, which skips the handler, so the membership reconcile states that one, and the record's return wakes it again.
   */
  protected configureAvailability(): void {

    const mqtt = this.nvr.mqtt;

    if(!mqtt) {

      return;
    }

    const config = this.deviceConfigSelector();

    mqtt.onConnect(() => this.publishAvailability(), { signal: this.observeSignal });
    mqtt.onEnd(async (signal: AbortSignal): Promise<void> => mqtt.publish(mqttTopic(this.mqttId, mqttTopics.availability.topic), MQTT_AVAILABILITY_OFFLINE,
      { retain: true, signal }), { signal: this.observeSignal });

    this.observeState({ key: "device.availability", selector: (state) => {

      const record = config(state);

      return record && [ isDeviceAdopted(record), isDeviceOnline(record) ].join();
    }, title: "availability" }, () => this.publishAvailability());
  }

  /* State this device's availability on its own topic, read from the verdict every handler's refusal reads, so what HomeKit is shown and what the broker holds cannot
   * disagree. It is retained, so a subscriber attaching mid-session reads the last statement, and it composes with the plugin-level statement the client makes: a device
   * is available only when both read online. It is change-gated because more than one path restates it, so one that leaves the verdict where it stood publishes nothing.
   * Public because the controller states a device leaving its adopted set, whose record the device's own observer can no longer read.
   */
  public publishAvailability(): void {

    const availability: MqttAvailabilityPayload = this.isAvailable ? MQTT_AVAILABILITY_ONLINE : MQTT_AVAILABILITY_OFFLINE;

    this.publishState(mqttTopics.availability.topic, availability, { retain: true });
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

  // Utility function to return the current accessory name of this device: the name the accessory's information service carries now, where homeKitName above is the
  // name the plugin applies. The AccessoryInformation Name characteristic is the primary source and is always present; the secondary fallback reads the
  // controller-side name non-throwing through peek() so a vanished record does not throw.
  public get accessoryName(): string {

    return (this.accessory.getService(this.hap.Service.AccessoryInformation)?.getCharacteristic(this.hap.Characteristic.Name).value as string | undefined) ??
      (this.device.peek()?.name ?? "Unknown");
  }

  // A refused MQTT set names this device by the name its accessory carries, so a custom name reads as the user set it.
  protected override get mqttSetSubject(): string {

    return this.accessoryName;
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
