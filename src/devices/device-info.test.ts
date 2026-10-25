/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * device-info.test.ts: The base-capability concern net for the shared ProtectDevice device-information surface, netted once family-agnostically.
 *
 * setInfo (device-base.ts), configureInfo (device.ts), and the universal observers spawnObservers (device.ts) registers are BASE ProtectDevice behaviors
 * shared by every device family: setInfo writes the unconditional Manufacturer and the length-guarded Model / SerialNumber / HardwareRevision / FirmwareRevision;
 * configureInfo, syncName-gated, syncs the accessory name and then writes that info; and the base observers react to controller-side changes - the device.name
 * observer propagates a controller-side rename into HomeKit (gated by Device.SyncName) through syncNameFromController, and the device.firmwareVersion observer refreshes
 * the FirmwareRevision characteristic on a Protect firmware update through setInfo alone. They are exercised only incidentally (family construction calls
 * configureInfo; the package camera's name-sync is asserted family-specifically in doorbell-construction.test.ts), so per the two-layer test architecture this suite nets
 * the BASE behaviors family-agnostically against the shared TestBaseDevice vehicle on the all-quiet makeSensorConfig carrier rather than re-asserting them inside each
 * family suite. The package-camera-specific name decoration (syncedName's display-suffix override) is family-owned and stays in doorbell-construction.test.ts.
 *
 * The wake mechanism: the base observers (device.name, device.firmwareVersion) read through deviceConfigSelector() -> client.state.selectors.sensor.byId(id) -> the
 * STORE's sensor record (not the projection), so pushSensorPatch - which updates that store record - is what wakes them, each NARROW (a name push wakes only the
 * device.name observer, a firmware push only the device.firmwareVersion observer). The rename reads this.syncedName, which resolves through the non-throwing peek()
 * accessor as peek()?.name ?? peek()?.marketName ?? this.accessoryName, observing the SAME store record, so after a name push both the selector and syncedName see the
 * new name. Observe registration is LAZY (each loop registers on iteration start, a microtask later), so every observerCount assertion and every wake assertion settles
 * first.
 *
 * The vacuity gates: the name-sync direction is split by the Device.SyncName feature (default FALSE). WITH Enable.Device.SyncName the rename test asserts a proven
 * before->after transition ("Test Sensor" -> "Renamed Sensor") across BOTH HomeKit-visible name characteristics - Name and the ConfiguredName the Home app lets a user
 * edit - plus the exact change log and the one save it asks for, beside the first sync's save of a fresh accessory's ConfiguredName, the firmware push that writes no
 * name and saves nothing, and the returning-record pair: a record that vanishes and returns unchanged writes, logs and saves nothing, and one that returns over a Home
 * app rename restores the controller's name and saves once with no rename line, each proving its return woke the name and firmware observers; WITHOUT it the test
 * captures the Name baseline immediately before the push and asserts the device.name observer STILL woke
 * (non-vacuous) but the Name characteristic is unchanged and no rename log fires - so the if(!syncName) return guard, not a dead observer, suppresses the rename
 * (mirroring light.test.ts's falsy-motion non-vacuity pattern). HardwareRevision is netted as a non-vacuous opt-in pair: makeSensorConfig omits hardwareRevision by
 * default, so setInfo's length-guard short-circuits; HAP builds the accessory's AccessoryInformation service with the characteristics it requires, and
 * HardwareRevision is an optional one, so beyond those the service holds exactly the kinds the configure path itself wrote and the HardwareRevision kind is never
 * materialized - the absent case is asserted with testCharacteristic so the read stays a pure predicate; passing hardwareRevision opts the value in so the
 * length-guarded write lands and is read back. The accessoryName getter's ?? "Unknown" fallback is unreachable here because the carrier's record name, read through
 * peek()?.name, is always "Test Sensor" (never nullish).
 *
 * The isolation model is per-test-fresh: a beforeEach rebuilds a fresh device so the characteristic state, the observer baselines, and store.observerCount are clean
 * every test, and the wake log is windowed per push via a captured baseline. An afterEach unwinds the device's per-accessory abort.
 */
import { ACCESSORY_SAVE_WINDOW_MS, setAccessoryName } from "homebridge-plugin-utils";
import { Characteristic, Service, TestStateStore, makeProtectState, makeTestAccessory, writesTo } from "../testing.helpers.ts";
import type { ProtectSensorConfig, Sensor } from "unifi-protect";
import { TestBaseDevice, TestSensorProjection, makeSensorConfig } from "./testing.helpers.ts";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import { formatLogEntry, logCount, loggedAt, settle } from "homebridge-plugin-utils/testing";
import { makeTestNvr, restoreAccessories } from "../nvr/testing.helpers.ts";
import type { ObserverWakePayload } from "../diagnostics.ts";
import type { ProtectNvr } from "../nvr/nvr.ts";
import type { TestLogEntry } from "homebridge-plugin-utils/testing";
import type { TestProtectAccessory } from "../testing.helpers.ts";
import type { TestProtectNvr } from "../nvr/testing.helpers.ts";
import assert from "node:assert/strict";
import diagnosticsChannel from "node:diagnostics_channel";

// Every harness controller this suite opens, drained in afterEach so the controller lifetime signal bounds each test's constructions rather than the file's. The builder
// is the single push site, so a construction inside a test body is captured exactly as the fixture's is.
const controllers: AbortController[] = [];

// The reusable construction helper: build a REAL TestBaseDevice (a concrete ProtectDevice leaf whose ctor only super()s) against the harness doubles, seeded with the
// all-quiet sensor carrier. The casts are confined to the point of construction exactly as the light / chime / device-statusled suites do; the instance under test is the
// production base, running its real configureHints / configureInfo / spawnObservers paths. We drive the wiring a family leaf would: configureHints first (configureInfo
// and syncNameFromController read this.hints.syncName), then configureInfo (the AccessoryInformation writes plus the syncName-gated name sync), then spawnObservers (the
// base observers). The userOptions thread into the REAL FeatureOptions engine, so Enable.Device.SyncName - and only it - flips hints.syncName true. The accessory is
// restored onto the bridge first, as a device's cached accessory is, so a save the name sync asks for reaches the API double's update calls.
function buildInfoDevice(configOptions: Parameters<typeof makeSensorConfig>[0] = {}, harnessOptions: { userOptions?: string[] } = {}): {
  accessory: TestProtectAccessory; device: TestBaseDevice; logEntries: readonly TestLogEntry[]; nvr: TestProtectNvr; store: TestStateStore;
} {

  const sensorConfig = makeSensorConfig(configOptions);
  const store = new TestStateStore(makeProtectState({ sensors: [sensorConfig] }));
  const { controller, logEntries, nvr } = makeTestNvr({ mqtt: true, store, userOptions: harnessOptions.userOptions });

  controllers.push(controller);

  const accessory = makeTestAccessory("Test Sensor", sensorConfig.mac);
  const projection = new TestSensorProjection(sensorConfig.id, store) as unknown as Sensor;

  restoreAccessories(nvr, [accessory]);

  const device = new TestBaseDevice(nvr as unknown as ProtectNvr, accessory, projection);

  // Wire the base capabilities the way a family leaf does: hints first, then device-info, then the observer spawn.
  device.configureHintsFor();
  device.configureInfoFor();
  device.spawnObserversFor();

  // The NVR double comes back too, so a test can steer the platform config the debug router reads - the legacy plugin-wide debug flag, which no feature option
  // expresses - and read the saves its accessory persistence sent.
  return { accessory, device, logEntries, nvr, store };
}

// The saves Homebridge's accessory cache received for a build's accessory: the API double's update calls that name it.
function savesOf(built: ReturnType<typeof buildInfoDevice>): number {

  return built.nvr.platform.api.calls.filter((call) => (call.kind === "update") && call.accessories.includes(built.accessory)).length;
}

describe("base ProtectDevice device-information capability (device-info concern net)", () => {

  // The one observer-wake subscription for the whole suite, installed before any construction and removed once in the unconditional teardown. A leaked subscriber would
  // flip hasSubscribers for every later test in the process, so it is removed exactly once.
  const wakeLog: ObserverWakePayload[] = [];
  const onWake = (message: unknown): void => { wakeLog.push(message as ObserverWakePayload); };

  // The per-test-fresh handles, rebuilt in beforeEach so every test starts from a clean device, clean characteristic state, and clean wake baseline.
  let accessory: TestProtectAccessory;
  let constructionWakes = 0;
  let device: TestBaseDevice | undefined;
  let logEntries: readonly TestLogEntry[];
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

    for(const controller of controllers) {

      controller.abort();
    }

    controllers.length = 0;
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

      // HARD-assert the service exists FIRST: HAP gives every accessory an AccessoryInformation service at construction, so an absent service throws here rather
      // than letting the later optional-chained value reads pass vacuously.
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

    test("setInfo falls back to the carrier's type for Model when the carrier reports no market name", () => {

      // The controller reports no market name for some units, so the Model write falls through to the hardware type. The carrier drives the EMPTY market name the
      // wire delivers, which is the falsy edge a nullish fallback would keep rather than fall through on, so a `??` regression in the model resolver reddens here.
      // We reassign the suite's device handle so afterEach unwinds this freshly-built device's per-accessory abort.
      const built = buildInfoDevice({ marketName: "", type: "UFP-Sense" });

      device = built.device;

      const info = built.accessory.getService(Service.AccessoryInformation);

      assert.ok(info, "the type-only carrier carries an AccessoryInformation service for setInfo to write");
      assert.equal(info.getCharacteristic(Characteristic.Model).value, "UFP-Sense", "Model is the carrier type when the carrier reports no market name");
    });

    test("setInfo writes \"unknown\" for Model when the carrier reports no model at all", () => {

      // A carrier reporting neither field - the fixture omits type unless a test supplies one - reads as the same "unknown" label every other model read renders for
      // such a unit, rather than leaving HomeKit's Model unwritten.
      const built = buildInfoDevice({ marketName: "" });

      device = built.device;

      const info = built.accessory.getService(Service.AccessoryInformation);

      assert.ok(info, "the model-less carrier carries an AccessoryInformation service for setInfo to write");
      assert.equal(info.getCharacteristic(Characteristic.Model).value, "unknown",
        "Model reads \"unknown\" when the carrier reports neither a market name nor a type");
    });

    test("setInfo's HardwareRevision length-guard writes when hardwareRevision is present and skips it when absent (a non-vacuous opt-in pair)", () => {

      // The absent half uses the default beforeEach build (the all-quiet carrier, which omits hardwareRevision). HAP builds the accessory's AccessoryInformation
      // service with the characteristics it requires, among them the Manufacturer, Model, SerialNumber and FirmwareRevision setInfo writes. HardwareRevision is an
      // optional characteristic, so it materializes ONLY if setInfo's length-guard wrote it; because the carrier omits hardwareRevision the guard short-circuits and
      // the kind is never created. We probe with testCharacteristic, a pure has-predicate that (unlike
      // getCharacteristic) does NOT lazily materialize the kind, so a false result is genuine evidence the write was skipped rather than an artifact of the read.
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

    test("with Device.SyncName, a name push wakes the device.name observer, renames the Name and ConfiguredName characteristics, and logs the change", async () => {

      // Rebuild with the syncName feature enabled so hints.syncName is true. configureInfo's syncName-gated branch renamed the accessory to the carrier name at
      // construction, so both name characteristics read "Test Sensor" BEFORE the push - the construction value, which makes each post-push read a proven before->after
      // transition. ConfiguredName is the name the Home app lets a user edit, so it must track the controller-side rename alongside Name rather than lag behind it.
      const built = buildInfoDevice({}, { userOptions: ["Enable.Device.SyncName"] });

      device = built.device;

      await settle();

      const info = built.accessory.getService(Service.AccessoryInformation);

      assert.ok(info, "the AccessoryInformation service exists");
      assert.equal(info.getCharacteristic(Characteristic.Name).value, "Test Sensor", "configureInfo synced the Name to the carrier name before the push");
      assert.equal(info.getCharacteristic(Characteristic.ConfiguredName).value, "Test Sensor", "configureInfo synced the ConfiguredName to the carrier name too");

      // Close the save window the construction's first sync opened, so the count below reads the rename's save alone.
      built.nvr.platform.clock.advance(ACCESSORY_SAVE_WINDOW_MS);

      const baseline = wakeLog.length;
      const savesBefore = savesOf(built);

      // The push moves only the name slice on the STORE record the device.name selector reads, so exactly that observer wakes; syncNameFromController re-reads syncedName
      // (this.ufp.name through the same store record) and, because syncName is enabled and the name differs, writes the new name, logs the change and saves.
      built.store.pushSensorPatch(built.device.protectId, { name: "Renamed Sensor" });

      await settle();

      built.nvr.platform.clock.advance(ACCESSORY_SAVE_WINDOW_MS);

      assert.deepEqual(wakeLog.slice(baseline), [{ accessoryId: built.accessory.UUID, key: "device.name" }], "exactly the device.name observer woke for this slice");
      assert.equal(info.getCharacteristic(Characteristic.Name).value, "Renamed Sensor", "the reaction renamed the Name characteristic (a before->after transition)");
      assert.equal(info.getCharacteristic(Characteristic.ConfiguredName).value, "Renamed Sensor",
        "the reaction renamed the ConfiguredName characteristic too, keeping the Home app's editable name in step");
      assert.equal(logCount(built.logEntries, "info", "Detected a name change on the controller; updating the HomeKit name to Renamed Sensor."), 1,
        "the controller-rename line logged once with the new name");
      assert.equal(savesOf(built), savesBefore + 1, "the rename saved the accessory once");
    });

    test("with Device.SyncName, a fresh accessory's first sync writes its ConfiguredName and saves the accessory once", async () => {

      // HAP seeds a fresh accessory's information Name from its display name, which already matches the carrier name, so only the ConfiguredName the Home app edits is
      // missing: the first sync adds it, and that write is what Homebridge's accessory cache has to learn. Nothing the controller reported changed, so no rename is
      // logged.
      const built = buildInfoDevice({}, { userOptions: ["Enable.Device.SyncName"] });

      device = built.device;

      await settle();

      const info = built.accessory.getService(Service.AccessoryInformation);

      assert.ok(info, "the AccessoryInformation service exists");
      assert.equal(savesOf(built), 0, "nothing is saved while the construction's save window is open");

      built.nvr.platform.clock.advance(ACCESSORY_SAVE_WINDOW_MS);

      assert.equal(info.getCharacteristic(Characteristic.ConfiguredName).value, "Test Sensor", "the first sync wrote the ConfiguredName");
      assert.equal(savesOf(built), 1, "the first sync saved the accessory once");
      assert.equal(loggedAt(built.logEntries, "info", "Detected a name change on the controller"), false, "the first sync logs no controller-side rename");
    });

    test("with Device.SyncName, a firmware push writes no name and saves nothing", async () => {

      // A firmware update refreshes device information through setInfo alone, so no name sync runs: neither name characteristic is written, and the accessory is not
      // marked for a save.
      const built = buildInfoDevice({}, { userOptions: ["Enable.Device.SyncName"] });

      device = built.device;

      await settle();

      built.nvr.platform.clock.advance(ACCESSORY_SAVE_WINDOW_MS);

      const info = built.accessory.getService(Service.AccessoryInformation);

      assert.ok(info, "the AccessoryInformation service exists");

      const savesBefore = savesOf(built);

      built.accessory.clearObservations();
      built.store.pushSensorPatch(built.device.protectId, { firmwareVersion: "5.1.0" });

      await settle();

      built.nvr.platform.clock.advance(ACCESSORY_SAVE_WINDOW_MS);

      assert.equal(info.getCharacteristic(Characteristic.FirmwareRevision).value, "5.1.0", "the firmware push refreshed the FirmwareRevision");
      assert.deepEqual(writesTo(built.accessory, info.getCharacteristic(Characteristic.Name)), [], "the firmware push wrote nothing to the Name");
      assert.deepEqual(writesTo(built.accessory, info.getCharacteristic(Characteristic.ConfiguredName)), [], "the firmware push wrote nothing to the ConfiguredName");
      assert.equal(savesOf(built), savesBefore, "the firmware push saved nothing");
    });

    test("with Device.SyncName, a sensor record that vanishes and returns with its name unchanged writes no name, logs no rename and saves nothing", async () => {

      // A record that leaves and returns within the removal grace moves the name slice twice: to undefined while it is gone, a yield the presence gate skips, and back
      // to the name on its return, which wakes the name observer and the firmware observer alike. The name is the one the first sync wrote, so HBPU's name helper finds
      // every name matching and writes nothing: no rename is logged and nothing is saved.
      const built = buildInfoDevice({}, { userOptions: ["Enable.Device.SyncName"] });

      device = built.device;

      await settle();

      // Close the save window the construction's first sync opened, so the count below reads the return's saves alone.
      built.nvr.platform.clock.advance(ACCESSORY_SAVE_WINDOW_MS);

      const info = built.accessory.getService(Service.AccessoryInformation);
      const record = built.store.snapshot().sensors.get(built.device.protectId);

      assert.ok(info, "the AccessoryInformation service exists");
      assert.ok(record, "the sensor record is in the store before it vanishes");

      const baseline = wakeLog.length;
      const savesBefore = savesOf(built);

      built.accessory.clearObservations();
      built.store.removeSensorRecord(record.id);

      await settle();

      built.store.addSensorRecord(record);

      await settle();

      built.nvr.platform.clock.advance(ACCESSORY_SAVE_WINDOW_MS);

      // Nothing depends on the order the name and firmware observers wake in, so their wakes compare as a set. A removal that removed nothing would leave each slice
      // as it stood through the re-add and wake neither observer.
      assert.deepEqual(new Set(wakeLog.slice(baseline)), new Set([ { accessoryId: built.accessory.UUID, key: "device.name" },
        { accessoryId: built.accessory.UUID, key: "device.firmwareVersion" } ]), "the return woke the name and firmware observers, and the removal woke neither");
      assert.deepEqual(writesTo(built.accessory, info.getCharacteristic(Characteristic.Name)), [], "the return wrote nothing to the Name");
      assert.deepEqual(writesTo(built.accessory, info.getCharacteristic(Characteristic.ConfiguredName)), [], "the return wrote nothing to the ConfiguredName");
      assert.equal(loggedAt(built.logEntries, "info", "Detected a name change on the controller"), false, "the return logs no controller rename");
      assert.equal(savesOf(built), savesBefore, "the return saved nothing");
      assert.equal(built.nvr.platform.api.calls.some((call) => (call.kind === "unregister") && call.accessories.includes(built.accessory)), false,
        "the record's absence unregistered nothing");
      assert.equal(built.accessory._associatedHAPAccessory.bridged, true, "the accessory is still on the bridge after the record's return");
    });

    test("with Device.SyncName, a returning record restores the controller's name over a Home app rename and saves once without logging a controller rename",
      async () => {

        // A Home app rename writes the ConfiguredName alone and leaves the platform accessory's display name, which only the plugin writes. A record returning within
        // the removal grace wakes the name sync, which restores the controller's name to the ConfiguredName and saves the accessory once. The display name never moved,
        // because the controller's name did not change, so no controller rename is logged.
        const built = buildInfoDevice({}, { userOptions: ["Enable.Device.SyncName"] });

        device = built.device;

        await settle();

        // Close the save window the construction's first sync opened, so the count below reads the restore's save alone.
        built.nvr.platform.clock.advance(ACCESSORY_SAVE_WINDOW_MS);

        const info = built.accessory.getService(Service.AccessoryInformation);
        const record = built.store.snapshot().sensors.get(built.device.protectId);

        assert.ok(info, "the AccessoryInformation service exists");
        assert.ok(record, "the sensor record is in the store before it vanishes");

        info.getCharacteristic(Characteristic.ConfiguredName).setValue("Kitchen Sensor");

        await settle();

        assert.equal(info.getCharacteristic(Characteristic.ConfiguredName).value, "Kitchen Sensor",
          "the Home app rename took the ConfiguredName before the record vanished");

        const baseline = wakeLog.length;
        const savesBefore = savesOf(built);

        built.store.removeSensorRecord(record.id);

        await settle();

        built.store.addSensorRecord(record);

        await settle();

        built.nvr.platform.clock.advance(ACCESSORY_SAVE_WINDOW_MS);

        // The wakes compare as a set, as the unchanged return's do.
        assert.deepEqual(new Set(wakeLog.slice(baseline)), new Set([ { accessoryId: built.accessory.UUID, key: "device.name" },
          { accessoryId: built.accessory.UUID, key: "device.firmwareVersion" } ]), "the return woke the name and firmware observers, and the removal woke neither");
        assert.equal(info.getCharacteristic(Characteristic.ConfiguredName).value, "Test Sensor", "the return restored the controller's name over the Home app rename");
        assert.equal(built.accessory.displayName, "Test Sensor", "the platform accessory's display name never moved");
        assert.equal(loggedAt(built.logEntries, "info", "Detected a name change on the controller"), false, "the restore logs no controller rename");
        assert.equal(savesOf(built), savesBefore + 1, "the restore saved the accessory once");
        assert.equal(built.nvr.platform.api.calls.some((call) => (call.kind === "unregister") && call.accessories.includes(built.accessory)), false,
          "the record's absence unregistered nothing");
        assert.equal(built.accessory._associatedHAPAccessory.bridged, true, "the accessory is still on the bridge after the record's return");
      });

    test("with Device.SyncName, a firmware update refreshes the device information and leaves a name the user set in the Home app", async () => {

      // A firmware update refreshes device information through setInfo alone, so a name the user set in the Home app stands until the controller-side name changes.
      const built = buildInfoDevice({}, { userOptions: ["Enable.Device.SyncName"] });

      device = built.device;

      await settle();

      built.nvr.platform.clock.advance(ACCESSORY_SAVE_WINDOW_MS);

      const info = built.accessory.getService(Service.AccessoryInformation);

      assert.ok(info, "the AccessoryInformation service exists");

      info.getCharacteristic(Characteristic.ConfiguredName).setValue("Kitchen Sensor");

      await settle();

      built.accessory.clearObservations();
      built.store.pushSensorPatch(built.device.protectId, { firmwareVersion: "5.1.0" });

      await settle();

      assert.equal(info.getCharacteristic(Characteristic.FirmwareRevision).value, "5.1.0", "the firmware update refreshed the FirmwareRevision");
      assert.equal(info.getCharacteristic(Characteristic.ConfiguredName).value, "Kitchen Sensor", "the name the user set in the Home app stands");
      assert.deepEqual(writesTo(built.accessory, info.getCharacteristic(Characteristic.Name)), [], "the firmware update wrote nothing to the Name");
      assert.deepEqual(writesTo(built.accessory, info.getCharacteristic(Characteristic.ConfiguredName)), [], "the firmware update wrote nothing to the ConfiguredName");
      assert.equal(loggedAt(built.logEntries, "info", "Detected a name change on the controller"), false, "the firmware update logs no controller rename");
    });

    test("without Device.SyncName, a name push wakes the device.name observer but the guard suppresses the rename and the log", async () => {

      // The default beforeEach build omits Enable.Device.SyncName, so hints.syncName is false, and configureInfo's syncName-gated branch did NOT write the Name
      // characteristic. We seed a STALE Name ("Stale Name", modeling the value Homebridge restored from the cached accessory) so it deliberately DIFFERS from the
      // post-push synced name ("Renamed Sensor"). This isolates the guard: with the stale value differing from synced, HBPU's name helper would write and answer
      // true if it were reached, so only the if(!this.hints.syncName) return guard - not the helper's own comparison, and not a dead observer - keeps the rename from
      // firing. (A captured baseline that equalled synced would let the helper's comparison suppress the write too, masking which one actually blocks the rename.)
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

  describe("HBPU's accessory naming over a real accessory", () => {

    test("the real setAccessoryName renames both display names and writes the information service's Name and ConfiguredName on a real accessory", () => {

      const named = makeTestAccessory("Original Name");
      const info = named.getService(Service.AccessoryInformation);

      assert.ok(info, "the accessory carries an information service from construction for the naming surface to find");

      // The before half, which is what makes every after-assertion a proven transition. HAP seeds the information service's Name from the display name at
      // construction, while ConfiguredName, an optional characteristic, does not exist until a name write creates it. The existence probe goes through
      // testCharacteristic, a pure has-predicate that (unlike getCharacteristic) never materializes the kind it reads.
      assert.equal(info.getCharacteristic(Characteristic.Name).value, "Original Name", "HAP seeds the information service's Name from the display name");
      assert.equal(info.testCharacteristic(Characteristic.ConfiguredName), false, "ConfiguredName is absent until the naming surface writes it");

      assert.equal(setAccessoryName(named, "Front Door"), true, "the helper reports that it wrote a name");
      assert.equal(named.displayName, "Front Door", "the platform wrapper's displayName took the rename");
      assert.equal(named._associatedHAPAccessory.displayName, "Front Door", "the HAP accessory's displayName took the rename");
      assert.equal(info.displayName, "Front Door", "setServiceName wrote the information service's own displayName");
      assert.equal(info.getCharacteristic(Characteristic.Name).value, "Front Door", "the Name characteristic carries the new name");
      assert.equal(info.getCharacteristic(Characteristic.ConfiguredName).value, "Front Door",
        "the ConfiguredName characteristic, the Home app's editable name, carries it too");

      // A second rename to the same name finds every name already matching, so the helper writes nothing and says so.
      named.clearObservations();

      assert.equal(setAccessoryName(named, "Front Door"), false, "a rename to the name every surface already carries reports no write");
      assert.deepEqual(writesTo(named, info.getCharacteristic(Characteristic.Name)), [], "and it writes nothing to the Name characteristic");
    });
  });

  describe("the firmware-refresh reaction (device.firmwareVersion -> setInfo)", () => {

    test("a firmwareVersion push wakes the device.firmwareVersion observer and refreshes the FirmwareRevision characteristic", async () => {

      const info = accessory.getService(Service.AccessoryInformation);

      assert.ok(info, "the AccessoryInformation service exists");
      assert.equal(info.getCharacteristic(Characteristic.FirmwareRevision).value, "5.0.0", "FirmwareRevision starts at the carrier firmwareVersion before the push");

      const baseline = wakeLog.length;

      // The push moves only the firmwareVersion slice on the STORE record the device.firmwareVersion selector reads, so exactly that observer wakes; its reaction calls
      // setInfo, which writes the new firmware to the FirmwareRevision characteristic.
      store.pushSensorPatch(sensorConfig.id, { firmwareVersion: "5.1.0" });

      await settle();

      assert.deepEqual(wakeLog.slice(baseline), [{ accessoryId: accessory.UUID, key: "device.firmwareVersion" }],
        "exactly the device.firmwareVersion observer woke for this slice");
      assert.equal(info.getCharacteristic(Characteristic.FirmwareRevision).value, "5.1.0", "the reaction refreshed the FirmwareRevision characteristic to the new value");
    });
  });

  describe("the device log prefix (prefixedLog derivation)", () => {

    test("a base device's log line is prefixed with its logName and the family separator", () => {

      assert.ok(device, "the device was built");

      // Emit a line through the device's own logger and read back the harness's rendered `formatted` - the line the real Homebridge sink would write. It must begin with
      // the device's "Name [Model]" descriptor and the family's ": " separator, the derivation prefixedLog applies at every device construction site.
      device.log.info("A base-device prefix probe.");

      const entry = logEntries.find((candidate) => (candidate.level === "info") && formatLogEntry(candidate).endsWith("A base-device prefix probe."));

      assert.ok(entry, "the probe line was captured");
      assert.ok(formatLogEntry(entry).startsWith("Test Sensor [Test Sensor Model]: "), "the line carries the device's logName prefix and the family separator");
      assert.equal(formatLogEntry(entry), "Test Sensor [Test Sensor Model]: A base-device prefix probe.", "the rendered line is exactly the prefix plus the message");
    });
  });

  /* The debug channel's own derivation, netted family-agnostically on the same vehicle. Every owner's debug line is routed to the platform's debug router carrying that
   * owner's identity, so whether it speaks is decided at the owner's own scope: a device-suffixed entry turns on one device, a bare entry turns on everything, and the
   * legacy plugin-wide flag still turns on everything. Debug output leaves through warn, so a spoken line lands in the harness capture at that level - and a silent one
   * lands nowhere, which is what the sibling arm proves.
   */
  describe("the device debug channel (per-owner scope resolution)", () => {

    // Build a device carrying a known MAC, seeding the accessory identity the configure path writes. TestBaseDevice's constructor only super()s, so the configure-time
    // identity seed a real family leaf performs never runs on this vehicle - and the device scope resolves from exactly that persisted MAC.
    function buildDebugDevice(mac: string, userOptions: string[]): ReturnType<typeof buildInfoDevice> {

      const built = buildInfoDevice({ mac }, { userOptions });

      built.accessory.context.mac = mac;

      return built;
    }

    // Emit a probe through the device's debug channel and report whether it reached the capture. The message is unique per call site, so a spoken line is unambiguous and
    // a silent one cannot be confused with any other warn output the construction path produced.
    function debugProbe(built: ReturnType<typeof buildInfoDevice>, probe: string): boolean {

      built.device.log.debug(probe);

      return built.logEntries.some((entry) => (entry.level === "warn") && formatLogEntry(entry).endsWith(probe));
    }

    test("a device-suffixed entry turns on that device's debug lines while a sibling stays silent", () => {

      // One entry, addressed to the first device's MAC, applied to both harnesses. A resolution that ignored the device scope would turn the sibling on too, which is
      // exactly what the second assertion catches.
      const userOptions = ["Enable.Log.Debug.74ACB9000401"];
      const addressed = buildDebugDevice("74ACB9000401", userOptions);
      const sibling = buildDebugDevice("74ACB9000402", userOptions);

      assert.equal(debugProbe(addressed, "The addressed device speaks."), true, "the addressed device's debug line is emitted through warn");
      assert.equal(debugProbe(sibling, "The sibling device speaks."), false, "its sibling carries no entry of its own, so its debug line stays silent");

      addressed.device.cleanup();
      sibling.device.cleanup();
    });

    test("a bare entry turns on every device's debug lines", () => {

      // The same option with no scope suffix resolves globally, so both devices speak - the plugin-wide debug posture expressed through the option surface.
      const userOptions = ["Enable.Log.Debug"];
      const first = buildDebugDevice("74ACB9000401", userOptions);
      const second = buildDebugDevice("74ACB9000402", userOptions);

      assert.equal(debugProbe(first, "The first device speaks."), true, "a bare entry reaches the first device");
      assert.equal(debugProbe(second, "The second device speaks."), true, "and it reaches the second device too");

      first.device.cleanup();
      second.device.cleanup();
    });

    test("the legacy plugin-wide debug property still turns everything on", () => {

      // The transition fallback: a configuration that never opens the webUI keeps the debug output it has always had, with no option configured anywhere.
      const built = buildDebugDevice("74ACB9000401", []);

      assert.equal(debugProbe(built, "The quiet device stays quiet."), false, "with neither source set, debug output is silent");

      built.nvr.platform.config.debugAll = true;

      assert.equal(debugProbe(built, "The legacy flag speaks."), true, "the legacy flag turns the same device's debug line on");

      built.device.cleanup();
    });
  });
});
