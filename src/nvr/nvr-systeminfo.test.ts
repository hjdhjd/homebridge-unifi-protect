/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * nvr-systeminfo.test.ts: The first controller-owner behavior net - tests over a REAL constructed ProtectNvrSystemInfo.
 *
 * ProtectNvrSystemInfo is the lightest of the three controller owners (system information, liveviews, the security system), and it shares NOTHING with the other two
 * except the ProtectBase shape, so it is the right place to establish the controller-owner test pattern in isolation. This suite constructs a REAL
 * ProtectNvrSystemInfo(nvr) through the makeTestNvr double and nets its full public surface behavior-first: construction (the self-created accessory, the
 * unconditional-on-feature TemperatureSensor CPU-temp service, the initial CurrentTemperature read-through, the singular enabled-sensors log), the NVR.SystemInfo
 * feature gate (the with-feature service plus the without-feature removal and silent no-op paths), the single nvr.systemInfo observer's refresh reaction, the
 * systeminfo MQTT GET, and the controller-scoped mqttId / signal lifetime.
 *
 * The shape DIFFERS from the device families and this suite respects every departure:
 *
 * - It extends ProtectBase, not ProtectDevice: ctor is (nvr) only, with no per-accessory abort, no device projection, no hints, and no base name-sync / device-info
 *   observer pair. Teardown is aborting the AbortController behind nvr.signal (the controller terminal-shutdown signal), not a per-accessory cleanup().
 * - It publishes NOTHING on the hbup:observer:wake diagnostics channel (onObserverWake is the ProtectBase no-op), so this suite does NOT reuse the viewer / sensor
 *   wake-count scaffold - a constructionWakes === 0 assertion would pass trivially and mislead. The single nvr.systemInfo observer is netted by its REACTION (the
 *   temperature characteristic refreshes after a store push). store.observerCount IS a real registration-count surface the owner's observer joins, used here only as the
 *   complementary teardown leak check.
 * - It self-creates its accessory: the test supplies none; it reads the created accessory back off nvr.platform.accessories and asserts the platform double recorded the
 *   register call. The accessory UUID is deterministic: hap.uuid.generate(nvr.ufp.mac + ".NVRSystemInfo") = "uuid:74ACB9FFFFFF.NVRSystemInfo".
 * - nvr.ufp reads THROUGH the store (the harness's read-through client.nvr.config getter), so seeding the store's nvr slice IS how the construction record reaches
 *   nvr.ufp, and a pushNvrPatch that moves systemInfo by reference changes both selectNvr(state) and nvr.ufp at once.
 *
 * The observer non-vacuity trap (load-bearing): the onGet is bound only on the initial pass (the configureHandler guard) and reads live nvr.ufp, so after a push
 * triggerGet returns the NEW temperature REGARDLESS of whether the observer fired - it cannot prove the reaction. The discriminator is the characteristic's CACHED
 * .value, which is written ONLY by the observer-driven updateCharacteristic: a non-firing observer leaves .value at the initial-pass write. So the observer test asserts
 * CurrentTemperature.value === NEW after pushNvrPatch moves a FRESH systemInfo by reference, never triggerGet.
 */
import { Characteristic, Service, TestStateStore, makeNvrConfig, makeProtectState, makeTestNvr, settle } from "../testing.helpers.ts";
import type { TestAccessory, TestLogEntry, TestMqttClient, TestProtectNvr } from "../testing.helpers.ts";
import { afterEach, describe, test } from "node:test";
import type { ProtectNvr } from "./nvr.ts";
import { ProtectNvrSystemInfo } from "./nvr-systeminfo.ts";
import assert from "node:assert/strict";

// The deterministic accessory UUID the owner composes: the platform double's uuid generator is (seed) => "uuid:" + seed, and the owner generates from
// nvr.ufp.mac + ".NVRSystemInfo" against the makeNvrConfig mac, so the UUID is fixed. A literal rather than a derivation so a drift in the UUID composition breaks
// loudly.
const SYSTEMINFO_UUID = "uuid:74ACB9FFFFFF.NVRSystemInfo";

// The device log wrapper formats every line through util.format into a single string parameter prefixed with the controller name (for example "Test Controller: Enabled
// system information sensor: cpu temperature."), so a log assertion matches a substring of that one formatted parameter at the given level, mirroring the sensor /
// device-motion suites' helper.
function loggedAt(entries: TestLogEntry[], level: TestLogEntry["level"], substring: string): boolean {

  return entries.some((entry) => (entry.level === level) && String(entry.parameters[0]).includes(substring));
}

// The reusable construction helper: build a REAL ProtectNvrSystemInfo against the harness doubles, taking ONLY an nvr (the owner extends ProtectBase, so its ctor is
// (nvr)). makeNvrConfig carries the systemInfo the initial pass dereferences; the store's nvr slice is seeded NON-NULL so nvr.ufp - which reads through the store -
// returns that record. The casts are confined to the construction seam exactly as the family suites do; the instance under test is the production class running its real
// configureAccessory / configureMqtt / observe paths. The owner SELF-CREATES its accessory, so there is no accessory pass-in; the test reads it back off
// nvr.platform.accessories. The returned controller is the AbortController behind nvr.signal, aborted in teardown to tear down the owner's observe loop and its MQTT
// subscriptions (a ProtectBase owner has no per-accessory cleanup()).
function buildSystemInfo(configOptions: Parameters<typeof makeNvrConfig>[0] = {}, harnessOptions: { seedCachedAccessory?: boolean; userOptions?: string[] } = {}): {
  accessory: TestAccessory | undefined; apiCalls: ReturnType<typeof makeTestNvr>["apiCalls"]; controller: AbortController; logEntries: TestLogEntry[];
  mqtt: TestMqttClient; nvr: TestProtectNvr; owner: ProtectNvrSystemInfo; store: TestStateStore;
} {

  const nvrConfig = makeNvrConfig(configOptions);
  const store = new TestStateStore(makeProtectState({ nvr: nvrConfig }));
  const { apiCalls, controller, logEntries, mqtt, nvr } = makeTestNvr({ mqtt: true, store, userOptions: harnessOptions.userOptions });

  // makeTestNvr was called with mqtt: true, so the recording double is present; a guard narrows Nullable<TestMqttClient> to the non-null type without an assertion or a
  // same-type cast (either of which the house lint preset forbids in opposite directions), and fails loudly if the opt-in ever stops installing the double.
  if(!mqtt) {

    throw new Error("The MQTT recording double was not installed despite mqtt: true.");
  }

  // The disabled-removal path pre-seeds a cached accessory at the deterministic UUID BEFORE construction, so the feature-off branch actually removes one rather than
  // no-opping vacuously. The double's TestAccessory is reached through the platform's api.platformAccessory class so the seeded accessory is the same kind the owner
  // would create.
  if(harnessOptions.seedCachedAccessory) {

    const PlatformAccessory = nvr.platform.api.platformAccessory;

    nvr.platform.accessories.push(new PlatformAccessory("Cached System Info", SYSTEMINFO_UUID));
  }

  const owner = new ProtectNvrSystemInfo(nvr as unknown as ProtectNvr);
  const accessory = nvr.platform.accessories.find((candidate) => candidate.UUID === SYSTEMINFO_UUID);

  return { accessory, apiCalls, controller, logEntries, mqtt, nvr, owner, store };
}

describe("real ProtectNvrSystemInfo construction and controller-owner behavior", () => {

  // The per-test controller, tracked so afterEach aborts whichever build the test made (the ProtectBase owner has no per-accessory cleanup; aborting the controller
  // behind nvr.signal is the teardown). A test that builds more than one owner aborts each explicitly; this catches the single-build common case.
  let activeController: AbortController | undefined;

  afterEach(() => {

    activeController?.abort();
    activeController = undefined;
  });

  test("the feature-enabled construction self-creates the accessory, materializes the CPU-temp service, and logs the singular enabled line", async () => {

    const built = buildSystemInfo({ temperature: 36 }, { userOptions: ["Enable.Nvr.SystemInfo"] });

    activeController = built.controller;

    await settle();

    // The owner self-created its accessory at the deterministic UUID and registered it - both the platform array and the register-call recorder must show it.
    const accessory = built.accessory;

    assert.ok(accessory, "the owner self-created an accessory at the deterministic UUID and pushed it onto the platform accessories array");
    assert.equal(accessory.UUID, SYSTEMINFO_UUID, "the self-created accessory carries the mac-derived NVRSystemInfo UUID");
    assert.ok(built.apiCalls.some((call) => (call.kind === "register") && call.accessories.includes(accessory)),
      "the platform double recorded a register call carrying the self-created accessory");

    // HARD-assert the TemperatureSensor service exists FIRST (non-optional), the feature-gate non-vacuity discipline.
    const temperature = accessory.getService(Service.TemperatureSensor);

    assert.ok(temperature, "the NVR.SystemInfo feature on materializes the CPU-temperature TemperatureSensor service");
    assert.equal(temperature.displayName, accessory.displayName + " CPU Temperature", "the temperature service is named off the accessory display name");

    // The initial pass wrote CurrentTemperature off systemInfo.cpu.temperature, and bound the onGet that reads it live.
    assert.equal(temperature.getCharacteristic(Characteristic.CurrentTemperature).value, 36, "CurrentTemperature initialized from systemInfo.cpu.temperature");
    assert.equal(await temperature.getCharacteristic(Characteristic.CurrentTemperature).triggerGet(), 36, "the onGet reads through systemInfo.cpu.temperature live");

    // setInfo wired the controller-branded identity (the device-info concern owns the per-field writes; here we assert only that setInfo ran against the accessory).
    const info = accessory.getService(Service.AccessoryInformation);

    assert.equal(info?.getCharacteristic(Characteristic.Model).value, "UniFi Dream Machine SE", "setInfo wired the Model from the controller marketName");
    assert.equal(info?.getCharacteristic(Characteristic.SerialNumber).value, "74ACB9FFFFFF", "setInfo wired the SerialNumber from the controller mac");

    // The singular enabled-sensors log (one sensor, so the %s plural marker is empty).
    assert.ok(loggedAt(built.logEntries, "info", "Enabled system information sensor: cpu temperature."), "the one enabled sensor logs the singular enabled-sensor line");
  });

  test("construction with the feature disabled and a cached accessory present unregisters it, splices it out, and logs the removal", async () => {

    const built = buildSystemInfo({}, { seedCachedAccessory: true });

    activeController = built.controller;

    await settle();

    // The cached accessory was removed: gone from the platform array, AND the platform double recorded an unregister call.
    assert.equal(built.accessory, undefined, "the cached system-information accessory was spliced out of the platform accessories array");
    assert.ok(built.apiCalls.some((call) => (call.kind === "unregister") && call.accessories.some((candidate) => candidate.UUID === SYSTEMINFO_UUID)),
      "the platform double recorded an unregister call for the cached accessory");
    assert.ok(loggedAt(built.logEntries, "info", "Removing UniFi Protect controller system information sensors."), "the removal path logged the removal line");
  });

  test("construction with the feature disabled and no cached accessory is a silent no-op - no accessory, no service, no register call", async () => {

    const built = buildSystemInfo();

    activeController = built.controller;

    await settle();

    assert.equal(built.accessory, undefined, "no accessory is created when the feature is off and none is cached");
    assert.equal(built.nvr.platform.accessories.length, 0, "the platform accessories array stays empty - nothing was created or restored");
    assert.equal(built.apiCalls.some((call) => call.kind === "register"), false, "the silent no-op path records no register call");
    assert.equal(built.apiCalls.some((call) => call.kind === "unregister"), false, "the silent no-op path records no unregister call");
  });

  test("the nvr.systemInfo observer refreshes the CACHED CurrentTemperature value after a reference-changing pushNvrPatch", async () => {

    const built = buildSystemInfo({ temperature: 20 }, { userOptions: ["Enable.Nvr.SystemInfo"] });

    activeController = built.controller;

    await settle();

    const temperature = built.accessory?.getService(Service.TemperatureSensor);

    assert.ok(temperature, "the temperature service exists before the push");
    assert.equal(temperature.getCharacteristic(Characteristic.CurrentTemperature).value, 20, "the cached value starts at the seeded OLD temperature");

    // Push a FRESH systemInfo object so selectNvr(state)?.systemInfo changes by reference (the narrow observer's Object.is dedup wakes only on a reference change), and -
    // because client.nvr.config reads through the same slice - nvr.ufp.systemInfo becomes that same new object so the reaction's re-read returns NEW.
    built.store.pushNvrPatch({ systemInfo: { ...built.nvr.ufp.systemInfo, cpu: { ...built.nvr.ufp.systemInfo.cpu, temperature: 47 } } });

    await settle();

    // Assert the CACHED .value, NOT triggerGet: the initial-pass onGet reads live nvr.ufp and would return 47 even if the observer never fired, so it cannot prove the
    // reaction; the cached .value is written ONLY by the observer-driven updateCharacteristic, so a non-firing observer would leave it at 20 - that is the discriminator.
    assert.equal(temperature.getCharacteristic(Characteristic.CurrentTemperature).value, 47,
      "the observer's updateDevice refreshed the cached CurrentTemperature to the pushed value");
  });

  test("a non-systemInfo nvr patch does NOT refresh the temperature - the narrow selector ignores it", async () => {

    const built = buildSystemInfo({ temperature: 20 }, { userOptions: ["Enable.Nvr.SystemInfo"] });

    activeController = built.controller;

    await settle();

    const temperature = built.accessory?.getService(Service.TemperatureSensor);

    assert.ok(temperature, "the temperature service exists");

    // A patch that moves a non-systemInfo field (name) leaves systemInfo's reference unchanged, so the narrow nvr.systemInfo selector does not wake.
    built.store.pushNvrPatch({ name: "Renamed Controller" });

    await settle();

    assert.equal(temperature.getCharacteristic(Characteristic.CurrentTemperature).value, 20, "a non-systemInfo patch leaves the cached temperature untouched");
  });

  test("the systeminfo MQTT GET composes the controller-MAC topic and reads through the live systemInfo", async () => {

    const built = buildSystemInfo({ temperature: 33 }, { userOptions: ["Enable.Nvr.SystemInfo"] });

    activeController = built.controller;

    await settle();

    // The mqttId is the controller MAC (the ProtectBase base default), so the GET subscription composes {controllerMAC}/systeminfo.
    const subscription = built.mqtt.subscriptions.find((entry) => (entry.kind === "get") && (entry.topic === "74ACB9FFFFFF/systeminfo"));

    assert.ok(subscription?.getValue, "the systeminfo GET subscription composed the controller-MAC topic and captured a getValue handler");

    // Assert against an INDEPENDENT expected built from the KNOWN seeded temperature, not === JSON.stringify(nvr.ufp.systemInfo) (which re-reads the same handler input
    // and is a tautology). The handler stringifies the whole systemInfo, so parsing it back and reading cpu.temperature proves the read-through. The parse result is
    // typed to the one field under assertion at this confined boundary, exactly as JSON.parse's any would otherwise leak into an unsafe member access.
    const payload = JSON.parse(subscription.getValue()) as { cpu: { temperature: number } };

    assert.equal(payload.cpu.temperature, 33, "the GET handler stringifies the live systemInfo, carrying the seeded temperature");

    // The subscription is scoped to the controller signal (nvr.signal), the controller-owner lifetime.
    assert.equal(subscription.init?.signal, built.nvr.signal, "the GET registration carries the controller lifetime signal");
  });

  test("aborting the controller signal deregisters the observer and ends the MQTT subscription lifetime, and a later push no longer refreshes", async () => {

    const built = buildSystemInfo({ temperature: 20 }, { userOptions: ["Enable.Nvr.SystemInfo"] });

    activeController = built.controller;

    await settle();

    assert.equal(built.store.observerCount, 1, "the single nvr.systemInfo observer is registered against the store double");

    const subscription = built.mqtt.subscriptions.find((entry) => (entry.kind === "get") && (entry.topic === "74ACB9FFFFFF/systeminfo"));

    assert.equal(subscription?.init?.signal?.aborted, false, "the GET registration's lifetime is live before the controller abort");

    const temperature = built.accessory?.getService(Service.TemperatureSensor);

    assert.ok(temperature, "the temperature service exists before teardown");

    // Tear down via the controller signal (the ProtectBase owner-lifetime), the only teardown a controller owner has.
    built.controller.abort();

    await settle();

    assert.equal(built.store.observerCount, 0, "the observer deregistered through the controller signal");
    assert.equal(subscription?.init?.signal?.aborted, true, "the GET registration's lifetime ended with the controller abort");

    // The positive half of the leak detector: a systemInfo push that WOULD refresh the cached value if the observer survived produces no change, proving the observer
    // truly deregistered rather than that the push was inert.
    built.store.pushNvrPatch({ systemInfo: { ...built.nvr.ufp.systemInfo, cpu: { ...built.nvr.ufp.systemInfo.cpu, temperature: 99 } } });

    await settle();

    assert.equal(temperature.getCharacteristic(Characteristic.CurrentTemperature).value, 20, "a push after teardown does not refresh - the reaction is gone");
  });
});
