/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * testing.helpers.ts: The cross-cutting test helpers shared across every unit test in homebridge-unifi-protect.
 *
 * Every accessory, service and characteristic a suite touches is the real thing. This file loads the Homebridge runtime once, through HBPU's Homebridge double, so an
 * accessory is Homebridge's own PlatformAccessory over the hap-nodejs copy Homebridge loads, its services and characteristics are HAP's own, and the API the
 * controller double hands production is HBPU's TestHomebridgeApi, which runs Homebridge's bridge bookkeeping and records the calls Homebridge accepted. A suite's
 * assertion about HomeKit state therefore reads what production would leave there, and the harness restates no part of HAP or Homebridge to get it. The accessory
 * builder derives every identity through HAP's own UUID generator, the way production derives each accessory's UUID, and the read helpers below give suites the
 * views HAP keeps no log of: the values production wrote to one characteristic, the controller configurations and removals an accessory saw, and the options a camera
 * controller was built with.
 *
 * Alongside them this file holds the rest of the harness's cross-cutting core: TestStateStore, the facade over unifi-protect's real state store, with makeProtectState
 * to seed it; and the streaming and timeshift stubs every device family that constructs a real camera host shares: the streaming delegate with its controller
 * stand-in and its factory, which satisfies the platform's dependency-inversion contract so a REAL device can be constructed with no FFmpeg, and the timeshift buffer
 * and supervisor doubles.
 *
 * The per-subsystem helpers live beside the code they serve, each importing this file: devices/testing.helpers.ts owns the config builders, the projection doubles,
 * and TestBaseDevice; media/testing.helpers.ts owns TestCameraHost and the fragment and livestream doubles; nvr/testing.helpers.ts owns the NVR and platform doubles
 * and the makeTestNvr composition root. State needs no restating either: TestStateStore runs unifi-protect's own store (src/state/store.ts).
 *
 * Co-located with production code under src/ so the type-check pass covers this file alongside everything else, while tsconfig.build.json excludes every *.helpers.ts,
 * *.fixtures.ts, and *.test.ts from the emitted dist/, so none of the rig reaches the published package.
 */
import type { CameraController, CameraControllerOptions, ChangeReason, CharacteristicValue, Controller, ControllerServiceMap, Resolution, WithUUID } from "homebridge";
import type { ControllerIdentity, StreamingDelegate, StreamingDelegateFactory } from "./media/stream-delegate.ts";
import type { DeepPartial, DeviceSelectors, ProtectCameraConfig, ProtectChimeConfig, ProtectFobConfig, ProtectLightConfig, ProtectNvrBootstrap, ProtectNvrConfig,
  ProtectNvrLiveviewConfig, ProtectRelayConfig, ProtectRingtoneConfig, ProtectSensorConfig, ProtectState, ProtectStateRecord, ProtectViewerConfig, StateModelKey,
  StateStore } from "unifi-protect";
import type { ProtectAccessory, ProtectAccessoryContext } from "./types.ts";
import { TestHomebridgeApi, loadHomebridge } from "homebridge-plugin-utils/testing";
import type { AdvertisedStreams } from "./devices/cameras/camera.ts";
import type { ChannelProfile } from "./media/resolution.ts";
import type { Nullable } from "homebridge-plugin-utils";
import type { ProtectCameraHost } from "./media/camera-host.ts";
import type { SnapshotSource } from "./media/timeshift.ts";
import type { TestPlatformAccessory } from "homebridge-plugin-utils/testing";
import { controllerIdentityOf } from "./media/stream-delegate.ts";
import { createStateStore } from "unifi-protect";

/**
 * The Homebridge runtime every suite runs on: the hap-nodejs copy and the PlatformAccessory class Homebridge loads from this repository's tree, resolved once for the
 * whole process. The NVR and media helpers build their API doubles over this same runtime, so every accessory a suite meets shares one HAP.
 */
export const runtime = await loadHomebridge(import.meta.url);

/**
 * The runtime's HAP namespace, the one production reaches as `api.hap`.
 */
export const hap = runtime.hap;

/**
 * HAP's own Characteristic and Service classes, the namespaces a suite names a kind by (`Characteristic.On`, `Service.Switch`), each exported as a value and, below,
 * as the instance type, the way the class itself serves as both.
 */
export const { Characteristic, Service } = hap;

export type Characteristic = InstanceType<typeof hap.Characteristic>;

export type Service = InstanceType<typeof hap.Service>;

/**
 * A characteristic kind as a suite names one, such as `Characteristic.On`: a class HAP's service methods take where they build or write a characteristic
 * (`getCharacteristic`, `updateCharacteristic`) and where they test for one (`testCharacteristic`), which type the class in each of those roles.
 */
export type CharacteristicKind = WithUUID<new () => Characteristic> & WithUUID<typeof Characteristic>;

/**
 * The accessory every harness builder hands back: Homebridge's own PlatformAccessory over the runtime's HAP, carrying the plugin's typed context, made through an API
 * double so it records every value change and characteristic warning HAP raises on it.
 */
export type TestProtectAccessory = TestPlatformAccessory<ProtectAccessoryContext>;

// The API double whose accessory class builds every accessory makeTestAccessory hands back. An accessory made here is placed on another API's bridge by that API's
// own restore or registration, because each API double runs on the one runtime above and accepts any accessory of its PlatformAccessory class.
const constructionApi = new TestHomebridgeApi(runtime);

// The counter behind each default accessory identity, so accessories built without a seed, same-named or not, never share a UUID: Homebridge skips a registration
// whose UUID it already holds, which would leave a later accessory off the bridge in silence.
let accessorySeeds = 0;

// The next default seed, unique within the process.
function nextSeed(): string {

  accessorySeeds++;

  return "homebridge-unifi-protect.test-accessory." + accessorySeeds.toString();
}

/**
 * The UUID an accessory seeded by `seed` carries, derived through HAP's own generator exactly as production derives each accessory's UUID, so a suite seeds a device's
 * accessory by the same identity production composes for it: the MAC, the MAC plus a suffix, or the controller's MAC plus an owner's suffix.
 *
 * @param seed - The identity the accessory's UUID derives from.
 *
 * @returns The UUID HAP generates for that seed.
 */
export function accessoryUuid(seed: string): string {

  return hap.uuid.generate(seed);
}

/**
 * Build an accessory through the construction API: Homebridge's own PlatformAccessory, born off the bridge as every new accessory is, with the AccessoryInformation
 * service HAP gives it at construction and its Name set to the display name.
 *
 * @param displayName - The accessory's display name. Defaults to "Test Accessory".
 * @param seed        - The identity its UUID derives from through {@link accessoryUuid}. Defaults to a seed unique within the process, so accessories a row builds
 *                      without one never collide.
 *
 * @returns A fresh accessory, typed with the plugin's context.
 */
export function makeTestAccessory(displayName = "Test Accessory", seed = nextSeed()): TestProtectAccessory {

  return new constructionApi.platformAccessory<ProtectAccessoryContext>(displayName, accessoryUuid(seed));
}

// The reasons HAP stamps on the changes its event notifications and its update path raise, each checked against the member of HAP's own const enum that names it,
// the form HBPU's Homebridge double checks HAP's event names by, so a value that drifts from upstream fails the build here. The enum itself is out of reach at runtime
// under this project's module syntax.
const EVENT_REASON = "event" satisfies `${ChangeReason.EVENT}`;
const UPDATE_REASON = "update" satisfies `${ChangeReason.UPDATE}`;

// The new values of the changes one characteristic raised for one reason, in the order HAP raised them. HAP's reason enum is a string enum, so each change's reason
// widens to the string it carries for the comparison.
function changeValues(accessory: TestPlatformAccessory, characteristic: Characteristic, reason: string): Nullable<CharacteristicValue>[] {

  const matches = (change: { characteristic: Characteristic; reason: string }): boolean => (change.characteristic === characteristic) && (change.reason === reason);

  return accessory.changes.filter(matches).map((change) => change.newValue);
}

/**
 * The values production wrote to one characteristic through HAP's update path (`updateValue` and `updateCharacteristic`), in the order it wrote them. HAP raises a
 * change for every such write, a write of an unchanged value included, so a row proving production did NOT rewrite a value reads this rather than the final value.
 * HomeKit's own writes and reads and the event notifications the characteristic sent carry other reasons and stay out, as does any write to another instance of
 * the same kind elsewhere on the accessory.
 *
 * @param accessory      - The accessory whose recorded changes to read.
 * @param characteristic - The characteristic instance whose writes to select.
 *
 * @returns The new value of each update the characteristic raised.
 */
export function writesTo(accessory: TestPlatformAccessory, characteristic: Characteristic): Nullable<CharacteristicValue>[] {

  return changeValues(accessory, characteristic, UPDATE_REASON);
}

/**
 * The event notifications one characteristic sent HomeKit through HAP's `sendEventNotification`, in the order it sent them. HAP stores each notified value as the
 * characteristic's value and raises a change for it, so a row reads what HomeKit was told from this rather than from the final value, and a notification on another
 * instance of the same kind elsewhere on the accessory stays out.
 *
 * @param accessory      - The accessory whose recorded changes to read.
 * @param characteristic - The characteristic instance whose notifications to select.
 *
 * @returns The value of each notification the characteristic sent.
 */
export function eventsFrom(accessory: TestPlatformAccessory, characteristic: Characteristic): Nullable<CharacteristicValue>[] {

  return changeValues(accessory, characteristic, EVENT_REASON);
}

/**
 * One entry of an accessory's controller log: a controller a streaming-delegate stub handed production, configured onto the accessory or removed from it, numbered by
 * its place in the log.
 */
export interface ControllerEvent {

  readonly controller: unknown;
  readonly kind: "configure" | "remove";
  readonly seq: number;
}

// The controller log of every accessory a stand-in controller was configured onto, keyed weakly so an accessory a suite lets go of leaves no entry behind.
const controllerLogs = new WeakMap<ProtectAccessory, ControllerEvent[]>();

// The live controller log of one accessory, created empty on first reach.
function controllerLog(accessory: ProtectAccessory): ControllerEvent[] {

  let log = controllerLogs.get(accessory);

  if(!log) {

    log = [];
    controllerLogs.set(accessory, log);
  }

  return log;
}

/**
 * The ordered log of every configuration and removal of a streaming-delegate stub's controller on an accessory, in the order HAP ran them. HAP runs the controller's
 * own hooks from inside `configureController` and `removeController`, and only for a removal of the controller it holds, so the log records what HAP did rather than
 * what production asked of it.
 *
 * @param accessory - The accessory whose controller log to read.
 *
 * @returns The live log, so a reference taken before the events it will hold still reads them.
 */
export function controllerEvents(accessory: ProtectAccessory): readonly ControllerEvent[] {

  return controllerLog(accessory);
}

// HAP's camera controller option fields, which its declaration marks private and its own methods read at runtime: what the controller was constructed with.
interface CameraControllerFields {

  readonly delegate: CameraControllerOptions["delegate"];
  readonly recording?: CameraControllerOptions["recording"];
  readonly sensorOptions?: CameraControllerOptions["sensors"];
}

/**
 * The options a real camera controller was built with, read from the fields HAP keeps them in, which its declaration marks private, so one harness function reads
 * them rather than each suite reaching into HAP, the way HBPU's handler accessors read HAP's handler fields. HAP clears the recording and sensor options once the
 * controller initializes its services, so a row reads them before the controller is configured onto an accessory.
 *
 * @param controller - The camera controller to read.
 *
 * @returns The streaming delegate, the recording arm and the sensor links the controller was constructed with.
 */
export function cameraControllerOptions(controller: CameraController): Pick<CameraControllerOptions, "delegate" | "recording" | "sensors"> {

  const fields = controller as unknown as CameraControllerFields;

  return { delegate: fields.delegate, recording: fields.recording, sensors: fields.sensorOptions };
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

  // Patch a sensor record - the carrier the base device-info observers and the whole sensor family run on.
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

  // Replace the controller's saved liveviews. This goes through the same bootstrap as the ringtone library, for a different reason: replacing a whole collection is ONE
  // atomic transition, and a bootstrap reconciles every slice in a single dispatch, so one push wakes the collection's observer exactly once. Per-id events would reduce
  // the same end state through one dispatch per added and removed record, waking that observer once per record.
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

/* The controller a TestStreamingDelegate hands the camera: a stand-in HAP's own configureController and removeController accept, so a camera's controller lifecycle runs
 * through the real accessory. Its id is the real camera controller's, so HAP's one-controller-per-id rule refuses a second configure on an accessory exactly as it
 * refuses a second camera controller. It builds no services. HAP calls its configureServices from inside configureController and its handleControllerRemoved from
 * inside removeController, and each appends to the controller log of the accessory the delegate was built for, so a row reads the configure and remove order across a
 * rebuild through controllerEvents.
 */
class TestStreamingController implements Controller {

  readonly #accessory: Nullable<ProtectAccessory>;

  public constructor(accessory: Nullable<ProtectAccessory>) {

    this.#accessory = accessory;
  }

  public configureServices(): void {

    this.#record("configure");
  }

  public constructServices(): ControllerServiceMap {

    return {};
  }

  public controllerId(): string {

    return "camera";
  }

  public handleControllerRemoved(): void {

    this.#record("remove");
  }

  public initWithServices(): void {

    // Nothing to restore: the stand-in builds no services, so HAP holds no saved service map for it.
  }

  // Append one lifecycle event to the log of the accessory the delegate was built for. A delegate the media suites build for a host takes no accessory, and its
  // controller is never configured, so a configure reaching one is a rig mistake and says so.
  #record(kind: ControllerEvent["kind"]): void {

    if(!this.#accessory) {

      throw new Error("A streaming delegate built without an accessory has no controller log to record a " + kind + " in.");
    }

    const log = controllerLog(this.#accessory);

    log.push({ controller: this, kind, seq: log.length });
  }
}

/* The stub StreamingDelegate, typed as the abstraction and entirely FFmpeg-free. The controller is the stand-in above, which tests identity-match through the
 * accessory's controller log; ffmpegOptions is the one documented cast boundary on this class - the camera family reads maxSourcePixels off it (via
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

  /**
   * Build a stub delegate.
   *
   * @param options                 - Delegate inputs.
   * @param options.accessory       - The accessory whose controller log the stub's controller records into. Defaults to none, for a host whose controller is never
   *                                  configured.
   * @param options.builtFor        - The controller identity the stub was built for. Defaults to the record with every term false: a delegate built for nothing, so
   *                                  any term a test raises is an appearance.
   * @param options.maxSourcePixels - The hardware pixel ceiling ffmpegOptions reports. Defaults to no ceiling.
   */
  public constructor({ accessory = null, builtFor = { hksvCapable: false, isDoorbell: false, twoWayAudio: false }, maxSourcePixels = Infinity }:
  { accessory?: Nullable<ProtectAccessory>; builtFor?: ControllerIdentity; maxSourcePixels?: number } = {}) {

    this.builtFor = builtFor;

    // The stand-in controller, which HAP configures and removes through its own controller registry. The delegate contract types the field as HAP's camera controller,
    // which the stand-in is not, so the crossing takes this one cast; HAP's configureController and removeController take the stand-in as it is.
    this.controller = new TestStreamingController(accessory) as unknown as CameraController;

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
// sensor stood before the controller that captures it was built, and hand back the recorded delegate's stand-in controller for identity assertions. The
// maxSourcePixels ceiling is forwarded into every delegate it creates - set it before construction to exercise the recording-channel pixel cap with a finite value.
export class TestStreamingDelegateFactory implements StreamingDelegateFactory {

  public readonly createCalls: { audioFormat: AdvertisedStreams["audioFormat"]; camera: ProtectCameraHost; delegate: TestStreamingDelegate; motionSensorPresent: boolean;
    probe: AdvertisedStreams["probe"]; resolutions: Resolution[]; }[] = [];

  public maxSourcePixels = Infinity;

  public create(camera: ProtectCameraHost, derived: AdvertisedStreams): StreamingDelegate {

    // Capture the camera's controller identity through the same derivation production's ProtectStreamingDelegate reads at its own construction. This makes a
    // construction whose capabilities are present yield a delegate already built for the current identity, so the capability reconcile's staleness check is a no-op
    // (zero controller churn), and only a genuine late capability - a delegate built before it appeared - rebuilds. The camera's own accessory is the one production
    // configures the delegate's controller onto, so its controller log is the one the stand-in records into.
    const delegate = new TestStreamingDelegate({ accessory: camera.accessory, builtFor: controllerIdentityOf(camera), maxSourcePixels: this.maxSourcePixels });

    // Install the timeshift-supervisor double at create time - before the camera's construction-time activation kick reads it - so the kick and the per-edge availability
    // kicks land on a spy rather than an inert stand-in. Cast at the confined double->production boundary the harness uses throughout.
    delegate.timeshift = makeTimeshiftSupervisorDouble() as unknown as StreamingDelegate["timeshift"];

    this.createCalls.push({ audioFormat: derived.audioFormat, camera, delegate,
      motionSensorPresent: camera.accessory.getService(camera.api.hap.Service.MotionSensor) !== undefined, probe: derived.probe, resolutions: derived.resolutions });

    return delegate;
  }
}
