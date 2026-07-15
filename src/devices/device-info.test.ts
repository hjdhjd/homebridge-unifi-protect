/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * device-info.test.ts: The base-capability concern net for the shared ProtectDevice device-information surface, netted once family-agnostically.
 *
 * setInfo (device-base.ts), configureInfo (device.ts), and the universal observers spawnObservers (device.ts) registers are BASE ProtectDevice behaviors
 * shared by every device family: setInfo writes the unconditional Manufacturer and the length-guarded Model / SerialNumber / HardwareRevision / FirmwareRevision;
 * configureInfo, syncName-gated, syncs the accessory name and then writes that info; and the base observers react to controller-side changes - the device.name
 * observer propagates a controller-side rename into HomeKit (gated by Device.SyncName) through syncNameFromController, and the device.firmwareVersion observer refreshes
 * the FirmwareRevision characteristic on a Protect firmware update by re-running configureInfo. They are currently exercised only incidentally (family construction calls
 * configureInfo; the package camera's name-sync is asserted family-specifically in doorbell-construction.test.ts), so per the two-layer test architecture this suite nets
 * the BASE behaviors family-agnostically against the shared TestBaseDevice vehicle on the all-quiet makeSensorConfig carrier rather than re-asserting them inside each
 * family suite. The package-camera-specific name decoration (syncedName's display-suffix override) is family-owned and stays in doorbell-construction.test.ts.
 *
 * The wake mechanism: the base observers (device.name, device.firmwareVersion) read through deviceConfigSelector() -> deviceSelectors.sensor.byId(id) -> the STORE's
 * sensor record (not the projection), so pushSensorPatch - which updates that store record - is what wakes them, each NARROW (a name push wakes only the device.name
 * observer, a firmware push only the device.firmwareVersion observer). The rename reads this.syncedName, which resolves through the non-throwing peek() accessor as
 * peek()?.name ?? peek()?.marketName ?? this.accessoryName, observing the SAME store record, so after a name push both the selector and syncedName see the new name.
 * Observe registration is LAZY (each loop registers on iteration start, a microtask later), so every observerCount assertion and every wake assertion settles first.
 *
 * The vacuity gates: the name-sync direction is split by the Device.SyncName feature (default FALSE). WITH Enable.Device.SyncName the rename test asserts a proven
 * before->after Name transition ("Test Sensor" -> "Renamed Sensor") plus the exact change log; WITHOUT it the test captures the Name baseline immediately before the push
 * and asserts the device.name observer STILL woke (non-vacuous) but the Name characteristic is unchanged and no rename log fires - so the if(!syncName) return guard, not
 * a dead observer, suppresses the rename (mirroring light.test.ts's falsy-motion non-vacuity pattern). HardwareRevision is netted as a non-vacuous opt-in pair:
 * makeSensorConfig omits hardwareRevision by default, so setInfo's length-guard short-circuits; the accessory's AccessoryInformation service is a plain
 * characteristic-empty TestService that carries only the kinds setInfo itself wrote, so with the guard short-circuited the HardwareRevision kind is never materialized -
 * the absent case is asserted with testCharacteristic so the read stays a pure predicate; passing hardwareRevision opts the value in so the length-guarded write lands
 * and is read back. The accessoryName getter's ?? "Unknown" fallback is unreachable here because the carrier's record name, read through peek()?.name, is always "Test
 * Sensor" (never nullish).
 *
 * The isolation model is per-test-fresh: a beforeEach rebuilds a fresh device so the characteristic state, the observer baselines, and store.observerCount are clean
 * every test, and the wake log is windowed per push via a captured baseline. An afterEach unwinds the device's per-accessory abort.
 */
import { Characteristic, Service, TestBaseDevice, TestSensorProjection, TestStateStore, makeProtectState, makeSensorConfig, makeTestAccessory, makeTestNvr, settle }
  from "../testing.helpers.ts";
import type { ProtectSensorConfig, Sensor } from "unifi-protect";
import type { TestAccessory, TestLogEntry } from "../testing.helpers.ts";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import type { ObserverWakePayload } from "../diagnostics.ts";
import type { ProtectAccessory } from "../types.ts";
import type { ProtectNvr } from "../nvr/nvr.ts";
import assert from "node:assert/strict";
import diagnosticsChannel from "node:diagnostics_channel";

// The device log wrapper formats every line through util.format into a single string parameter prefixed with the device name (for example "Test Sensor: Detected a name
// change on the controller; updating the HomeKit name to Renamed Sensor."), so a log assertion matches a substring of that one formatted parameter at the given level,
// mirroring the device-motion / device-statusled suites' helper.
function loggedAt(entries: TestLogEntry[], level: TestLogEntry["level"], substring: string): boolean {

  return entries.some((entry) => (entry.level === level) && String(entry.parameters[0]).includes(substring));
}

// The reusable construction helper: build a REAL TestBaseDevice (a concrete ProtectDevice leaf whose ctor only super()s) against the harness doubles, seeded with the
// all-quiet sensor carrier. The casts are confined to the construction seam exactly as the light / chime / device-statusled suites do; the instance under test is the
// production base, running its real configureHints / configureInfo / spawnObservers paths. We drive the wiring a family leaf would: configureHints first (configureInfo
// and syncNameFromController read this.hints.syncName), then configureInfo (the AccessoryInformation writes plus the syncName-gated name sync), then spawnObservers (the
// base observers). The userOptions thread into the REAL FeatureOptions engine, so Enable.Device.SyncName - and only it - flips hints.syncName true.
function buildInfoDevice(configOptions: Parameters<typeof makeSensorConfig>[0] = {}, harnessOptions: { userOptions?: string[] } = {}): {
  accessory: TestAccessory; device: TestBaseDevice; logEntries: TestLogEntry[]; store: TestStateStore;
} {

  const sensorConfig = makeSensorConfig(configOptions);
  const store = new TestStateStore(makeProtectState({ sensors: [sensorConfig] }));
  const { logEntries, nvr } = makeTestNvr({ mqtt: true, store, userOptions: harnessOptions.userOptions });
  const accessory = makeTestAccessory("Test Sensor", "uuid:test-sensor");
  const projection = new TestSensorProjection(sensorConfig.id, store) as unknown as Sensor;
  const device = new TestBaseDevice(nvr as unknown as ProtectNvr, accessory as unknown as ProtectAccessory, projection);

  // Wire the base capabilities the way a family leaf does: hints first, then device-info, then the observer spawn.
  device.configureHintsFor();
  device.configureInfoFor();
  device.spawnObserversFor();

  return { accessory, device, logEntries, store };
}

describe("base ProtectDevice device-information capability (device-info concern net)", () => {

  // The one observer-wake subscription for the whole suite, installed before any construction and removed once in the unconditional teardown. A leaked subscriber would
  // flip hasSubscribers for every later test in the process, so it is removed exactly once.
  const wakeLog: ObserverWakePayload[] = [];
  const onWake = (message: unknown): void => { wakeLog.push(message as ObserverWakePayload); };

  // The per-test-fresh handles, rebuilt in beforeEach so every test starts from a clean device, clean characteristic state, and clean wake baseline.
  let accessory: TestAccessory;
  let constructionWakes = 0;
  let device: TestBaseDevice | undefined;
  let logEntries: TestLogEntry[];
  let sensorConfig: ProtectSensorConfig;
  let store: TestStateStore;

  before(() => {

    diagnosticsChannel.subscribe("hbup:observer:wake", onWake);
  });

  after(() => {

    diagnosticsChannel.unsubscribe("hbup:observer:wake", onWake);
  });

  afterEach(() => {

    device?.cleanup();
    device = undefined;
  });

  // The default build for tests that do not need a specific feature toggle: the all-quiet carrier with no userOptions (so Device.SyncName stays at its FALSE default).
  // Tests that need the rename direction rebuild with Enable.Device.SyncName themselves.
  beforeEach(async () => {

    const built = buildInfoDevice();

    ({ accessory, device, logEntries, store } = built);
    sensorConfig = makeSensorConfig();

    // Settle the observe loops' lazy registration before any test asserts, then snapshot the construction-wake count and reset the window so each test measures only its
    // own pushes.
    await settle();

    constructionWakes = wakeLog.length;
    wakeLog.length = 0;
  });

  describe("setInfo's AccessoryInformation writes (construction)", () => {

    test("setInfo writes Manufacturer, Model, SerialNumber, and FirmwareRevision from the carrier", () => {

      // HARD-assert the service exists FIRST: every TestAccessory carries an AccessoryInformation service from construction, so an absent service throws here rather than
      // letting the later optional-chained value reads pass vacuously.
      const info = accessory.getService(Service.AccessoryInformation);

      assert.ok(info, "the accessory carries an AccessoryInformation service for setInfo to write");

      // The writes setInfo performs against the all-quiet carrier. Manufacturer is unconditional; Model is the carrier marketName ("Test Sensor Model");
      // SerialNumber is the carrier mac; FirmwareRevision is the carrier firmwareVersion ("5.0.0"). HardwareRevision is NOT among them here because the all-quiet carrier
      // omits hardwareRevision, so setInfo's length-guard short-circuits that write; the dedicated opt-in test below nets that guard both ways.
      assert.equal(info.getCharacteristic(Characteristic.Manufacturer).value, "Ubiquiti Inc.", "Manufacturer is the unconditional Ubiquiti string");
      assert.equal(info.getCharacteristic(Characteristic.Model).value, "Test Sensor Model", "Model is the carrier marketName");
      assert.equal(info.getCharacteristic(Characteristic.SerialNumber).value, sensorConfig.mac, "SerialNumber is the carrier mac");
      assert.equal(info.getCharacteristic(Characteristic.FirmwareRevision).value, "5.0.0", "FirmwareRevision is the carrier firmwareVersion");
    });

    test("setInfo's HardwareRevision length-guard writes when hardwareRevision is present and skips it when absent (a non-vacuous opt-in pair)", () => {

      // The absent half rides the default beforeEach build (the all-quiet carrier, which omits hardwareRevision). The accessory's AccessoryInformation service is a plain
      // characteristic-empty TestService - it carries only the kinds setInfo itself wrote (Manufacturer/Model/SerialNumber/FirmwareRevision), nothing pre-seeded - so the
      // HardwareRevision characteristic materializes ONLY if setInfo's length-guard wrote it; because the carrier omits hardwareRevision the guard short-circuits and the
      // kind is never created. We probe with testCharacteristic, a pure has-predicate that (unlike getCharacteristic) does NOT lazily materialize the kind, so a false
      // result is genuine evidence the write was skipped rather than an artifact of the read.
      const absentInfo = accessory.getService(Service.AccessoryInformation);

      assert.ok(absentInfo, "the all-quiet build carries an AccessoryInformation service");
      assert.equal(absentInfo.testCharacteristic(Characteristic.HardwareRevision), false,
        "the absent carrier never materializes HardwareRevision - setInfo's length-guard short-circuited the write");

      // The present half opts a hardwareRevision into the carrier so the length-guard passes and the write lands. We reassign the suite's device handle so afterEach
      // unwinds this freshly-built device's per-accessory abort.
      const built = buildInfoDevice({ hardwareRevision: "REV-A1" });

      device = built.device;

      const presentInfo = built.accessory.getService(Service.AccessoryInformation);

      assert.ok(presentInfo, "the opted-in build carries an AccessoryInformation service");
      assert.equal(presentInfo.getCharacteristic(Characteristic.HardwareRevision).value, "REV-A1",
        "the length-guarded write lands the opted-in hardwareRevision on the HardwareRevision characteristic");
    });
  });

  describe("the two base observers (count and lifecycle)", () => {

    test("exactly two observers register, and construction wakes none", () => {

      assert.equal(store.observerCount, 2, "the two base observers (device.name, device.firmwareVersion) are registered against the store double");
      assert.equal(constructionWakes, 0, "no observer wake was published during construction - observers arm against the baseline and stay silent");
    });

    test("cleanup unwinds both observers, and a value-changing push afterward wakes nothing", async () => {

      assert.ok(device, "the device exists for the teardown test");

      device.cleanup();

      // The per-accessory abort propagates through every observe loop; each loop's finally deregisters it. Settle the microtask unwinding, then prove the set is empty.
      await settle();

      assert.equal(store.observerCount, 0, "every observer deregistered through the teardown");

      // The leak detector's positive half: a push that WOULD wake the device.name observer if anything survived produces zero wakes - proving the observers truly
      // deregistered rather than that the push was inert. The device is cleaned up, so afterEach's cleanup is a harmless no-op double-abort.
      const teardownBaseline = wakeLog.length;

      store.pushSensorPatch(sensorConfig.id, { name: "Post-Cleanup Name" });

      await settle();

      assert.equal(wakeLog.length, teardownBaseline, "a push after cleanup wakes nothing");

      device = undefined;
    });
  });

  describe("the name-sync reaction (device.name -> syncNameFromController)", () => {

    test("with Device.SyncName, a name push wakes the device.name observer, renames the Name characteristic, and logs the change", async () => {

      // Rebuild with the syncName feature enabled so hints.syncName is true. configureInfo's syncName-gated branch wrote the Name characteristic to the carrier name at
      // construction, so the Name reads "Test Sensor" BEFORE the push - the construction value, which makes the post-push read a proven before->after transition.
      const built = buildInfoDevice({}, { userOptions: ["Enable.Device.SyncName"] });

      device = built.device;

      await settle();

      const info = built.accessory.getService(Service.AccessoryInformation);

      assert.ok(info, "the AccessoryInformation service exists");
      assert.equal(info.getCharacteristic(Characteristic.Name).value, "Test Sensor", "configureInfo synced the Name to the carrier name before the push");

      const baseline = wakeLog.length;

      // The push moves only the name slice on the STORE record the device.name selector reads, so exactly that observer wakes; syncNameFromController re-reads syncedName
      // (this.ufp.name through the same store record) and, because syncName is enabled and the name differs, writes the new name and logs the change.
      built.store.pushSensorPatch(built.device.ufp.id, { name: "Renamed Sensor" });

      await settle();

      assert.deepEqual(wakeLog.slice(baseline), [{ accessoryId: built.accessory.UUID, key: "device.name" }], "exactly the device.name observer woke for this slice");
      assert.equal(info.getCharacteristic(Characteristic.Name).value, "Renamed Sensor", "the reaction renamed the Name characteristic (a before->after transition)");
      assert.ok(loggedAt(built.logEntries, "info", "Detected a name change on the controller; updating the HomeKit name to Renamed Sensor."),
        "the controller-rename line logged with the new name");
    });

    test("without Device.SyncName, a name push wakes the device.name observer but the guard suppresses the rename and the log", async () => {

      // The default beforeEach build omits Enable.Device.SyncName, so hints.syncName is false, and configureInfo's syncName-gated branch did NOT write the Name
      // characteristic. We seed a STALE Name ("Stale Name", modeling the value Homebridge restored from the cached accessory) so it deliberately DIFFERS from the
      // post-push synced name ("Renamed Sensor"). This isolates the first guard: with the stale value differing from synced, syncNameFromController's SECOND guard
      // (the accessoryName === synced change-gate) would NOT suppress, so only the if(!this.hints.syncName) return guard - not the change guard, and not a dead
      // observer - keeps the rename from firing. (A captured baseline that equalled synced would let the change guard suppress too, masking which guard is load-bearing.)
      const info = accessory.getService(Service.AccessoryInformation);

      assert.ok(info, "the AccessoryInformation service exists");

      info.updateCharacteristic(Characteristic.Name, "Stale Name");

      const before = info.getCharacteristic(Characteristic.Name).value;
      const baseline = wakeLog.length;

      // The push still moves the name slice, so the device.name observer WAKES (the wake half is what makes "Name unchanged" non-vacuous); but the syncName guard skips
      // the rename and the log, leaving the seeded stale Name untouched.
      store.pushSensorPatch(sensorConfig.id, { name: "Renamed Sensor" });

      await settle();

      const result = info.getCharacteristic(Characteristic.Name).value;

      assert.deepEqual(wakeLog.slice(baseline), [{ accessoryId: accessory.UUID, key: "device.name" }], "the device.name observer woke on the changed name");
      assert.equal(result, before, "the Name characteristic is unchanged (the syncName guard suppressed the rename despite synced differing from the current name)");
      assert.equal(loggedAt(logEntries, "info", "Detected a name change on the controller"), false, "no controller-rename line logged without Device.SyncName");
    });
  });

  describe("the firmware-refresh reaction (device.firmwareVersion -> configureInfo)", () => {

    test("a firmwareVersion push wakes the device.firmwareVersion observer and refreshes the FirmwareRevision characteristic", async () => {

      const info = accessory.getService(Service.AccessoryInformation);

      assert.ok(info, "the AccessoryInformation service exists");
      assert.equal(info.getCharacteristic(Characteristic.FirmwareRevision).value, "5.0.0", "FirmwareRevision starts at the carrier firmwareVersion before the push");

      const baseline = wakeLog.length;

      // The push moves only the firmwareVersion slice on the STORE record the device.firmwareVersion selector reads, so exactly that observer wakes; its reaction re-runs
      // configureInfo -> setInfo, which writes the new firmware to the FirmwareRevision characteristic.
      store.pushSensorPatch(sensorConfig.id, { firmwareVersion: "5.1.0" });

      await settle();

      assert.deepEqual(wakeLog.slice(baseline), [{ accessoryId: accessory.UUID, key: "device.firmwareVersion" }],
        "exactly the device.firmwareVersion observer woke for this slice");
      assert.equal(info.getCharacteristic(Characteristic.FirmwareRevision).value, "5.1.0", "the reaction refreshed the FirmwareRevision characteristic to the new value");
    });
  });
});
