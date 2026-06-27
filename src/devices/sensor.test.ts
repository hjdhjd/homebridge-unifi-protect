/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * sensor.test.ts: The A2 family-layer capstone - behavior tests over a REAL constructed ProtectSensor.
 *
 * ProtectSensor is the last simple ProtectDevice family with no real-construction coverage, so this suite is the device-* sequence's capstone: it constructs a REAL
 * ProtectSensor against the harness doubles and nets its full sensor-SPECIFIC public surface plus the COMPOSITION of the base capabilities it wires - never the base
 * internals. The base-capability concern nets (device-motion / device-statusled / device-info / device-hints) own the motion switch / trigger / occupancy, the
 * status-LED routing, the info writes / observers, and the hints derivation; this suite asserts only that the sensor family wires them (for example, the MotionSensor
 * service appears when motionSettings.isEnabled and the userOptions opt in) - it does not re-net their internals.
 *
 * The sensor-specific surface: the always-present Battery service (configureBatteryService is unconditional, and updateBatteryStatus writes BatteryLevel /
 * StatusLowBattery), the five per-mode services (alarm sound / ambient light / contact-via-mountType / humidity / temperature) with their read-through getters, the
 * ambient 0.0001 and humidity <0 HomeKit floors, the StatusActive / StatusTampered state characteristics each carries, and the per-mode MQTT publishes; the leak (default
 * LeakSensor, internal / external subtypes) plus the moisture variant (Sensor.MoistureSensor swaps to a subtyped ContactSensor, and the mode-flip cleanup removes the
 * opposite-type service); the three sensor observers (the motionDetectedAt firehose routed through the injected TestRecordingDispatch exactly like the light's
 * lastMotion; the tamperingDetectedAt fan-out across every state-bearing service; the whole-record sensor.config reconcile); the five always-on GET MQTT subscriptions
 * plus the model-aware leak GETs (registered per-channel, present-iff-enabled, once-guarded, and unsubscribed when a channel is toggled off).
 *
 * The LOAD-BEARING multi-wake: the third observer (sensor.config) selects the WHOLE sensor record (selectSensor(id)), and pushSensorPatch replaces that record on every
 * patch, so sensor.config wakes on EVERY push - in ADDITION to any narrow observer (sensor.motionDetectedAt / sensor.tamperingDetectedAt) whose field changed. So a
 * narrow-field push wakes a SET in registration order: the base two (device.name, device.firmwareVersion), then sensor.motionDetectedAt, sensor.tamperingDetectedAt,
 * sensor.config. A single-observer expectation would be wrong; every wake assertion is the registration-ordered set including the accessoryId on each payload.
 *
 * The falsy-motionDetectedAt case is a TWO-STEP: the carrier defaults motionDetectedAt to 0, so a bare 0 push is no change (no wake). We first push a truthy timestamp
 * (settle, snapshot+reset the wake window AND a recording baseline), THEN push 0 - the truthy->0 change genuinely wakes the observer while the production
 * if(motionDetectedAt) guard, not a dead observer, suppresses the firehose delivery (the light's falsy-motion non-vacuity, adapted).
 *
 * The isolation model mirrors the light reference: a beforeEach builds a fresh sensor so the recording calls, the characteristic state, the observer baselines, and
 * store.observerCount are clean every test, the wake log is windowed per push via a captured baseline, and an afterEach unwinds the sensor's per-accessory abort.
 */
import { Characteristic, Service, TestRecordingDispatch, TestSensorProjection, TestStateStore, makeProtectState, makeSensorConfig, makeTestAccessory, makeTestNvr,
  settle } from "../testing.helpers.ts";
import type { TestAccessory, TestLogEntry, TestMqttClient } from "../testing.helpers.ts";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import type { ObserverWakePayload } from "../diagnostics.ts";
import type { ProtectAccessory } from "../types.ts";
import type { ProtectEventDispatch } from "../nvr/event-dispatch.ts";
import type { ProtectNvr } from "../nvr/nvr.ts";
import { ProtectReservedNames } from "../types.ts";
import { ProtectSensor } from "./sensor.ts";
import type { Sensor } from "unifi-protect";
import assert from "node:assert/strict";
import diagnosticsChannel from "node:diagnostics_channel";

// The device log wrapper formats every line through util.format into a single string parameter prefixed with the device name (for example "Test Sensor: Enabled sensor:
// temperature."), so a log assertion matches a substring of that one formatted parameter at the given level, mirroring the chime / device-motion suites' helper.
function loggedAt(entries: TestLogEntry[], level: TestLogEntry["level"], substring: string): boolean {

  return entries.some((entry) => (entry.level === level) && String(entry.parameters[0]).includes(substring));
}

// The reusable construction helper: build a REAL ProtectSensor against the harness doubles, with the recording dispatch injected through the NVR double's dispatch seam
// so the motionDetectedAt observer's firehose routing is asserted against the REAL ProtectEventDispatch contract (the recording subclass arms no reset timer). The
// casts are confined to the construction seam exactly as the light / chime suites do; the instance under test is the production class, running its real configureHints /
// configureDevice / spawnObservers paths. The accessory factory is injectable so the moisture mode-flip test can pre-seed a LeakSensor before construction. The injected
// recording dispatch is read off nvr.events after construction rather than captured from the factory closure - reading it back avoids both the assignment-expression
// smell and a TS2454 definite-assignment error on a factory-captured binding.
function buildSensor(configOptions: Parameters<typeof makeSensorConfig>[0] = {}, harnessOptions: { accessory?: TestAccessory; userOptions?: string[] } = {}): {
  accessory: TestAccessory; logEntries: TestLogEntry[]; mqtt: TestMqttClient; projection: TestSensorProjection; recording: TestRecordingDispatch; sensor: ProtectSensor;
  store: TestStateStore;
} {

  const sensorConfig = makeSensorConfig(configOptions);
  const store = new TestStateStore(makeProtectState({ sensors: [sensorConfig] }));
  const { logEntries, mqtt, nvr } = makeTestNvr({ dispatch: (innerNvr: ProtectNvr): ProtectEventDispatch => new TestRecordingDispatch(innerNvr), mqtt: true, store,
    userOptions: harnessOptions.userOptions });
  const recording = nvr.events as TestRecordingDispatch;
  const accessory = harnessOptions.accessory ?? makeTestAccessory("Test Sensor", "uuid:test-sensor");
  const projection = new TestSensorProjection(sensorConfig.id, store);
  const sensor = new ProtectSensor(nvr as unknown as ProtectNvr, accessory as unknown as ProtectAccessory, projection as unknown as Sensor);

  // makeTestNvr was called with mqtt: true, so the recording double is present; a guard narrows Nullable<TestMqttClient> to the non-null type without an assertion or a
  // same-type cast (either of which the house lint preset forbids in opposite directions), and fails loudly if the opt-in ever stops installing the double.
  if(!mqtt) {

    throw new Error("The MQTT recording double was not installed despite mqtt: true.");
  }

  return { accessory, logEntries, mqtt, projection, recording, sensor, store };
}

describe("real ProtectSensor construction and family behavior", () => {

  // The one observer-wake subscription for the whole suite, installed before any construction and removed once in the unconditional teardown. A leaked subscriber would
  // flip hasSubscribers for every later test in the process, so it is removed exactly once.
  const wakeLog: ObserverWakePayload[] = [];
  const onWake = (message: unknown): void => { wakeLog.push(message as ObserverWakePayload); };

  // The per-test-fresh handles, rebuilt in beforeEach so every test starts from a clean sensor, clean captures, and clean wake baseline.
  let accessory: TestAccessory;
  let constructionWakes = 0;
  let logEntries: TestLogEntry[];
  let mqtt: TestMqttClient;
  let projection: TestSensorProjection;
  let recording: TestRecordingDispatch;
  let sensor: ProtectSensor | undefined;
  let store: TestStateStore;

  before(() => {

    diagnosticsChannel.subscribe("hbup:observer:wake", onWake);
  });

  after(() => {

    diagnosticsChannel.unsubscribe("hbup:observer:wake", onWake);
  });

  // The default fixture is the all-quiet sensor (every *Settings.isEnabled false, mountType "none", a healthy battery, no stats), so the construction test asserts the
  // no-per-mode baseline and the "No sensors enabled." log. The per-mode / leak / observer tests build their own variants with the relevant settings flipped.
  beforeEach(async () => {

    ({ accessory, logEntries, mqtt, projection, recording, sensor, store } = buildSensor());

    // Settle the observe loops' lazy registration before any test asserts, then snapshot the construction-wake count and reset the window so each test measures only its
    // own pushes.
    await settle();

    constructionWakes = wakeLog.length;
    wakeLog.length = 0;
  });

  afterEach(() => {

    sensor?.cleanup();
  });

  test("five observers register, construction wakes none, and the always-present Battery service carries its battery state", () => {

    assert.equal(store.observerCount, 5, "the two base observers plus the sensor's three are registered against the store double");
    assert.equal(constructionWakes, 0, "no observer wake was published during construction - observers arm against the baseline and stay silent");

    const battery = accessory.getService(Service.Battery);

    assert.ok(battery, "configureBatteryService is unconditional, so an all-quiet sensor still carries the Battery service");
    assert.equal(battery.getCharacteristic(Characteristic.BatteryLevel).value, 100, "BatteryLevel initialized from batteryStatus.percentage");
    assert.equal(battery.getCharacteristic(Characteristic.StatusLowBattery).value, false, "StatusLowBattery initialized from batteryStatus.isLow");
  });

  test("an all-quiet sensor carries no per-mode services and emits no enabled-diff log at construction", () => {

    assert.equal(accessory.getServiceById(Service.ContactSensor, ProtectReservedNames.CONTACT_SENSOR_ALARM_SOUND), undefined,
      "no alarm-sound ContactSensor at all-quiet");
    assert.equal(accessory.getService(Service.LightSensor), undefined, "no ambient LightSensor at all-quiet");
    assert.equal(accessory.getServiceById(Service.ContactSensor, ProtectReservedNames.CONTACT_SENSOR), undefined, "no mount-type ContactSensor at all-quiet");
    assert.equal(accessory.getService(Service.HumiditySensor), undefined, "no HumiditySensor at all-quiet");
    assert.equal(accessory.getService(Service.TemperatureSensor), undefined, "no TemperatureSensor at all-quiet");
    assert.equal(accessory.getServiceById(Service.LeakSensor, ProtectReservedNames.LEAKSENSOR_INTERNAL), undefined, "no internal LeakSensor at all-quiet");
    assert.equal(accessory.getServiceById(Service.LeakSensor, ProtectReservedNames.LEAKSENSOR_EXTERNAL), undefined, "no external LeakSensor at all-quiet");

    // The enabled-sensors log is DIFF-GATED (sensor's updateDevice): it fires only when the new enabled set differs from the held enabledSensors. The constructor seeds
    // enabledSensors to [] and an all-quiet construction derives [], so there is no diff and NEITHER the "Enabled sensor%s" nor the "No sensors enabled." line fires at
    // construction. This is correct production behavior - the "No sensors enabled." line is the transition-to-empty message, exercised non-vacuously in the next test.
    assert.equal(loggedAt(logEntries, "info", "No sensors enabled."), false,
      "an all-quiet construction emits no enabled-diff log (the held and derived sets both start empty)");
    assert.equal(loggedAt(logEntries, "info", "Enabled sensor"), false, "an all-quiet construction enables nothing, so no Enabled-sensor line fires either");
  });

  test("a transition from an enabled sensor back to empty fires the No-sensors-enabled diff log", async () => {

    // The "No sensors enabled." line is reachable only as a transition: build a temperature-enabled sensor (so enabledSensors holds ["temperature"]), then push
    // temperatureSettings disabled so the reconcile derives an empty set that DIFFERS from the held set, firing the transition-to-empty log non-vacuously.
    const built = buildSensor({ temperatureEnabled: true });

    await settle();

    assert.ok(built.accessory.getService(Service.TemperatureSensor), "the temperature service exists before the transition");

    built.store.pushSensorPatch("test-sensor-1", { temperatureSettings: { highThreshold: 0, isEnabled: false, lowThreshold: 0, margin: 0 } });

    await settle();

    assert.equal(built.accessory.getService(Service.TemperatureSensor), undefined, "the reconcile removed the now-disabled temperature service");
    assert.ok(loggedAt(built.logEntries, "info", "No sensors enabled."), "the transition from a held non-empty set to empty fired the No-sensors-enabled line");

    built.sensor.cleanup();
  });

  test("cleanup unwinds all five observers, and a value-changing push afterward wakes nothing", async () => {

    sensor?.cleanup();

    // The per-accessory abort propagates through every observe loop; each loop's finally deregisters it. Settle the microtask unwinding, then prove the set is empty.
    await settle();

    assert.equal(store.observerCount, 0, "every observer deregistered through the teardown");

    // The leak detector's positive half: a push that WOULD wake the motionDetectedAt + config observers if anything survived produces zero wakes - proving the observers
    // truly deregistered rather than that the push was inert.
    const teardownBaseline = wakeLog.length;

    store.pushSensorPatch("test-sensor-1", { motionDetectedAt: 1700000000000 });

    await settle();

    assert.equal(wakeLog.length, teardownBaseline, "a push after cleanup wakes nothing");
  });

  test("the alarm-sound sensor materializes a subtyped ContactSensor with read-through, state characteristics, MQTT publish, and the singular enabled log", async () => {

    const built = buildSensor({ alarmEnabled: true, alarmTriggeredAt: 1700000000000 });

    const alarm = built.accessory.getServiceById(Service.ContactSensor, ProtectReservedNames.CONTACT_SENSOR_ALARM_SOUND);

    assert.ok(alarm, "enabling alarm settings materializes the alarm-sound ContactSensor at its subtype");
    assert.equal(alarm.getCharacteristic(Characteristic.ContactSensorState).value, true, "ContactSensorState initialized from a non-null alarmTriggeredAt");
    assert.equal(await alarm.getCharacteristic(Characteristic.ContactSensorState).triggerGet(), true, "the alarm onGet reads through alarmTriggeredAt !== null");
    assert.equal(alarm.getCharacteristic(Characteristic.StatusActive).value, true, "StatusActive carried from isReachable");
    assert.equal(alarm.getCharacteristic(Characteristic.StatusTampered).value, false, "StatusTampered carried from sensorTamperState(null)");
    assert.ok(built.mqtt.published.some((entry) => (entry.topic === built.projection.config.mac + "/alarm") && (entry.message === "true")),
      "the alarm state published on the device-scoped topic");
    assert.ok(loggedAt(built.logEntries, "info", "Enabled sensor: alarm sound."), "one enabled sensor logs the SINGULAR enabled-sensor line");

    built.sensor.cleanup();
  });

  test("the ambient-light sensor reads through CurrentAmbientLightLevel and honors the 0.0001 floor when the stat is absent", async () => {

    // No ambientLight option, so stats.light is absent and the getter returns -1, floored to 0.0001.
    const built = buildSensor({ lightEnabled: true });

    const light = built.accessory.getService(Service.LightSensor);

    assert.ok(light, "enabling light settings materializes the LightSensor");
    assert.equal(light.getCharacteristic(Characteristic.CurrentAmbientLightLevel).value, 0.0001, "an absent light stat floors the initialized value to 0.0001");
    assert.equal(await light.getCharacteristic(Characteristic.CurrentAmbientLightLevel).triggerGet(), 0.0001, "the onGet floors -1 to the 0.0001 HomeKit minimum");
    assert.ok(built.mqtt.published.some((entry) => entry.topic === built.projection.config.mac + "/ambientlight"),
      "the ambient state published on the device-scoped topic");

    built.sensor.cleanup();
  });

  test("the ambient-light sensor reads through a present stat value above the floor", async () => {

    const built = buildSensor({ ambientLight: 250, lightEnabled: true });

    const light = built.accessory.getService(Service.LightSensor);

    assert.ok(light, "the LightSensor exists");
    assert.equal(await light.getCharacteristic(Characteristic.CurrentAmbientLightLevel).triggerGet(), 250, "a present stat above the floor reads through unchanged");

    built.sensor.cleanup();
  });

  test("the contact sensor materializes for a present mountType door with read-through and state characteristics", async () => {

    const built = buildSensor({ mountType: "door" });

    const contact = built.accessory.getServiceById(Service.ContactSensor, ProtectReservedNames.CONTACT_SENSOR);

    assert.ok(contact, "a door mountType materializes the mount-type ContactSensor at its subtype");
    assert.equal(await contact.getCharacteristic(Characteristic.ContactSensorState).triggerGet(), false, "the contact onGet reads through isOpened ?? false");
    assert.equal(contact.getCharacteristic(Characteristic.StatusActive).value, true, "StatusActive carried from isReachable");
    assert.ok(built.mqtt.published.some((entry) => entry.topic === built.projection.config.mac + "/contact"), "the contact state published on the device-scoped topic");

    built.sensor.cleanup();
  });

  test("the contact sensor stays absent for the leak and none mount types", () => {

    const leak = buildSensor({ mountType: "leak" });

    assert.equal(leak.accessory.getServiceById(Service.ContactSensor, ProtectReservedNames.CONTACT_SENSOR), undefined,
      "a leak mountType creates no mount-type ContactSensor");

    leak.sensor.cleanup();

    const none = buildSensor({ mountType: "none" });

    assert.equal(none.accessory.getServiceById(Service.ContactSensor, ProtectReservedNames.CONTACT_SENSOR), undefined,
      "a none mountType creates no mount-type ContactSensor");

    none.sensor.cleanup();
  });

  test("a single-channel UP-Sense exposes the internal LeakSensor iff its mount role is leak, ignoring the stuck leakSettings flag", () => {

    // The single-channel UP-Sense (featureFlags.waterLeak.channelNames ["internal"]) drives leak via the physical mount role: mountType "leak" exposes the internal
    // LeakSensor. Its leakSettings.isInternalEnabled is a stuck capability echo, so the leak-policy leaf deliberately ignores it on a single-channel device.
    const enabled = buildSensor({ leakChannelNames: ["internal"], mountType: "leak" });

    assert.ok(enabled.accessory.getServiceById(Service.LeakSensor, ProtectReservedNames.LEAKSENSOR_INTERNAL),
      "a single-channel sensor with mountType leak materializes the internal LeakSensor");

    enabled.sensor.cleanup();

    // The REGRESSION case: the stuck internal flag is true but the mount role is off. The old gate keyed on the flag and wrongly exposed the LeakSensor; the leaf reads
    // mountType on a single-channel device, so no leak service materializes.
    const stuckFlag = buildSensor({ leakChannelNames: ["internal"], leakInternalEnabled: true, mountType: "none" });

    assert.equal(stuckFlag.accessory.getServiceById(Service.LeakSensor, ProtectReservedNames.LEAKSENSOR_INTERNAL), undefined,
      "a single-channel sensor with mountType none exposes NO internal LeakSensor even though the stuck leakSettings flag is true");

    stuckFlag.sensor.cleanup();
  });

  test("a single-channel UP-Sense never exposes the external LeakSensor regardless of the leak flags or mount role", () => {

    // The single-channel device advertises only "internal", so the external channel is never a service - the capability gate in the leak-policy leaf short-circuits it
    // before any flag or mount role is consulted.
    const built = buildSensor({ leakChannelNames: ["internal"], leakExternalEnabled: true, leakInternalEnabled: true, mountType: "leak" });

    assert.equal(built.accessory.getServiceById(Service.LeakSensor, ProtectReservedNames.LEAKSENSOR_EXTERNAL), undefined,
      "a single-channel sensor advertises no external channel, so the external LeakSensor never materializes");

    built.sensor.cleanup();
  });

  test("the humidity sensor reads through CurrentRelativeHumidity and floors a negative reading to zero", async () => {

    // No humidity option, so stats.humidity is absent and the getter returns -1, floored to 0.
    const built = buildSensor({ humidityEnabled: true });

    const humidity = built.accessory.getService(Service.HumiditySensor);

    assert.ok(humidity, "enabling humidity settings materializes the HumiditySensor");
    assert.equal(humidity.getCharacteristic(Characteristic.CurrentRelativeHumidity).value, 0, "an absent humidity stat floors the initialized value to 0");
    assert.equal(await humidity.getCharacteristic(Characteristic.CurrentRelativeHumidity).triggerGet(), 0, "the onGet floors a negative reading to 0");
    assert.ok(built.mqtt.published.some((entry) => entry.topic === built.projection.config.mac + "/humidity"), "the humidity state published on the device-scoped topic");

    built.sensor.cleanup();
  });

  test("the humidity sensor reads through a present non-negative stat value", async () => {

    const built = buildSensor({ humidity: 55, humidityEnabled: true });

    const humidity = built.accessory.getService(Service.HumiditySensor);

    assert.ok(humidity, "the HumiditySensor exists");
    assert.equal(await humidity.getCharacteristic(Characteristic.CurrentRelativeHumidity).triggerGet(), 55, "a present non-negative stat reads through unchanged");

    built.sensor.cleanup();
  });

  test("the temperature sensor reads through CurrentTemperature from the stat value with state characteristics and MQTT publish", async () => {

    const built = buildSensor({ temperature: 21.5, temperatureEnabled: true });

    const temperature = built.accessory.getService(Service.TemperatureSensor);

    assert.ok(temperature, "enabling temperature settings materializes the TemperatureSensor");
    assert.equal(temperature.getCharacteristic(Characteristic.CurrentTemperature).value, 21.5, "CurrentTemperature initialized from stats.temperature.value");
    assert.equal(await temperature.getCharacteristic(Characteristic.CurrentTemperature).triggerGet(), 21.5, "the temperature onGet reads through the stat value");
    assert.equal(temperature.getCharacteristic(Characteristic.StatusActive).value, true, "StatusActive carried from isReachable");
    assert.equal(temperature.getCharacteristic(Characteristic.StatusTampered).value, false, "StatusTampered carried from sensorTamperState(null)");
    assert.ok(built.mqtt.published.some((entry) => entry.topic === built.projection.config.mac + "/temperature"),
      "the temperature state published on the device-scoped topic");
    assert.ok(loggedAt(built.logEntries, "info", "Enabled sensor: temperature."), "one enabled sensor logs the SINGULAR enabled-sensor line");

    built.sensor.cleanup();
  });

  test("two enabled sensors log the PLURAL enabled-sensors line", () => {

    const built = buildSensor({ humidityEnabled: true, temperatureEnabled: true });

    assert.ok(loggedAt(built.logEntries, "info", "Enabled sensors: humidity, temperature."), "two enabled sensors log the plural enabled-sensors line in order");

    built.sensor.cleanup();
  });

  test("a multi-channel sensor materializes internal and external LeakSensor services with read-through and the isConnected-gated publishes", async () => {

    // A multi-channel USL-Environmental (channelNames ["internal","external"]) drives each leak channel via its live leakSettings flag, so both flags enabled exposes
    // both LeakSensor services - the path the leak-policy leaf preserves byte-for-byte from the pre-fix behavior.
    const built = buildSensor({ leakChannelNames: [ "internal", "external" ], leakDetectedAt: 1700000000000, leakExternalEnabled: true, leakInternalEnabled: true });

    const internal = built.accessory.getServiceById(Service.LeakSensor, ProtectReservedNames.LEAKSENSOR_INTERNAL);
    const external = built.accessory.getServiceById(Service.LeakSensor, ProtectReservedNames.LEAKSENSOR_EXTERNAL);

    assert.ok(internal, "the internal LeakSensor materializes at its subtype");
    assert.ok(external, "the external LeakSensor materializes at its subtype");
    assert.equal(await internal.getCharacteristic(Characteristic.LeakDetected).triggerGet(), true, "the internal leak onGet reads through leakDetectedAt !== null");
    assert.equal(await external.getCharacteristic(Characteristic.LeakDetected).triggerGet(), false,
      "the external leak onGet reads through a null externalLeakDetectedAt");
    assert.ok(built.mqtt.published.some((entry) => entry.topic === built.projection.config.mac + "/leak"),
      "the internal leak state published (isConnected gate is true)");
    assert.ok(built.mqtt.published.some((entry) => entry.topic === built.projection.config.mac + "/leak-external"),
      "the external leak state published (isConnected gate is true)");

    built.sensor.cleanup();
  });

  test("a disconnected sensor suppresses the leak MQTT publishes but still materializes the services", () => {

    const built = buildSensor({ isConnected: false, leakChannelNames: [ "internal", "external" ], leakInternalEnabled: true });

    assert.ok(built.accessory.getServiceById(Service.LeakSensor, ProtectReservedNames.LEAKSENSOR_INTERNAL),
      "the internal LeakSensor still materializes when disconnected");
    assert.equal(built.mqtt.published.some((entry) => entry.topic === built.projection.config.mac + "/leak"), false,
      "the leak publish is suppressed by the isConnected gate when the sensor is disconnected");

    built.sensor.cleanup();
  });

  test("the moisture variant swaps to a subtyped ContactSensor and the mode-flip removes a pre-seeded LeakSensor on a single-channel mount-role sensor", () => {

    // Pre-seed a LeakSensor at the internal subtype BEFORE constructing the moisture-mode sensor so the mode-flip cleanup (which removes the opposite-type service) is
    // exercised genuinely rather than vacuously - a fresh accessory carries no LeakSensor, so without the pre-seed the removal would be a no-op.
    const seeded = makeTestAccessory("Moisture Sensor", "uuid:moisture-sensor");

    seeded.addService(new Service.LeakSensor("Legacy Leak", ProtectReservedNames.LEAKSENSOR_INTERNAL));

    assert.ok(seeded.getServiceById(Service.LeakSensor, ProtectReservedNames.LEAKSENSOR_INTERNAL), "the legacy LeakSensor was seeded before construction");

    // The realistic moisture scenario is a single-channel UP-Sense at the mount-role path: channelNames ["internal"] with mountType "leak", so the leak-policy leaf
    // returns true for internal via the mount role and the moisture swap materializes the subtyped ContactSensor with the opposite-type cleanup firing.
    const built = buildSensor({ leakChannelNames: ["internal"], mountType: "leak" }, { accessory: seeded, userOptions: ["Enable.Sensor.MoistureSensor"] });

    assert.equal(seeded.getServiceById(Service.LeakSensor, ProtectReservedNames.LEAKSENSOR_INTERNAL), undefined,
      "the mode-flip removed the opposite-type LeakSensor when switching to moisture mode");

    const contact = seeded.getServiceById(Service.ContactSensor, ProtectReservedNames.LEAKSENSOR_INTERNAL);

    assert.ok(contact, "moisture mode materializes a ContactSensor at the internal subtype");
    assert.ok(contact.testCharacteristic(Characteristic.ContactSensorState), "the moisture ContactSensor carries ContactSensorState, not LeakDetected");

    built.sensor.cleanup();
  });

  test("a truthy motionDetectedAt push wakes the motionDetectedAt and sensor.config observers and routes to the dispatch firehose once", async () => {

    const baseline = wakeLog.length;

    // A fixed truthy timestamp literal rather than Date.now(), so the push is deterministic.
    store.pushSensorPatch("test-sensor-1", { motionDetectedAt: 1700000000000 });

    await settle();

    assert.deepEqual(wakeLog.slice(baseline), [ { accessoryId: accessory.UUID, key: "sensor.motionDetectedAt" }, { accessoryId: accessory.UUID, key: "sensor.config" } ],
      "the narrow motionDetectedAt observer AND the whole-record sensor.config observer woke, in registration order");
    assert.deepEqual(recording.calls, [{ id: "test-sensor-1", kind: "motion" }], "the truthy detection routed to motionEventHandler exactly once");
  });

  test("a falsy-but-changed motionDetectedAt push wakes both observers yet the if-guard suppresses the firehose delivery", async () => {

    // Two-step: the carrier defaults motionDetectedAt to 0, so a bare 0 push is no change. First push a truthy timestamp so the second push is a real truthy->0 change.
    store.pushSensorPatch("test-sensor-1", { motionDetectedAt: 1700000000000 });

    await settle();

    // Snapshot and reset BOTH the wake window and the recording baseline so the second step measures only its own effect.
    const baseline = wakeLog.length;
    const recordingBaseline = recording.calls.length;

    store.pushSensorPatch("test-sensor-1", { motionDetectedAt: 0 });

    await settle();

    assert.deepEqual(wakeLog.slice(baseline), [ { accessoryId: accessory.UUID, key: "sensor.motionDetectedAt" }, { accessoryId: accessory.UUID, key: "sensor.config" } ],
      "the truthy->0 change woke the motionDetectedAt observer (and sensor.config), not a dead observer");
    assert.equal(recording.calls.length, recordingBaseline, "the if(motionDetectedAt) guard suppressed the firehose delivery for the falsy timestamp");
  });

  test("a tamperingDetectedAt push wakes its observer and fans StatusTampered across every state-bearing service", async () => {

    // Build with two enabled state-bearing services (humidity + temperature) so updateTamperState's fan-out is non-vacuous - it must write more than one service.
    const built = buildSensor({ humidityEnabled: true, temperatureEnabled: true });

    await settle();

    const humidity = built.accessory.getService(Service.HumiditySensor);
    const temperature = built.accessory.getService(Service.TemperatureSensor);

    assert.ok(humidity, "the HumiditySensor exists");
    assert.ok(temperature, "the TemperatureSensor exists");
    assert.equal(humidity.getCharacteristic(Characteristic.StatusTampered).value, false, "StatusTampered starts clear on the humidity service");
    assert.equal(temperature.getCharacteristic(Characteristic.StatusTampered).value, false, "StatusTampered starts clear on the temperature service");

    const baseline = wakeLog.length;

    built.store.pushSensorPatch("test-sensor-1", { tamperingDetectedAt: 1700000000000 });

    await settle();

    assert.deepEqual(wakeLog.slice(baseline),
      [ { accessoryId: built.accessory.UUID, key: "sensor.tamperingDetectedAt" }, { accessoryId: built.accessory.UUID, key: "sensor.config" } ],
      "the narrow tamperingDetectedAt observer AND the whole-record sensor.config observer woke, in registration order");
    assert.equal(humidity.getCharacteristic(Characteristic.StatusTampered).value, true, "the fan-out wrote StatusTampered on the humidity service");
    assert.equal(temperature.getCharacteristic(Characteristic.StatusTampered).value, true,
      "the fan-out wrote StatusTampered on the temperature service - a second service");

    built.sensor.cleanup();
  });

  test("a settings-only push wakes only sensor.config and reconciles a newly-enabled service", async () => {

    // The all-quiet default carries no temperature service. A settings-only push flipping temperatureSettings to enabled changes no narrow-observed field, so only the
    // whole-record sensor.config observer wakes, and its updateDevice reconcile materializes the temperature service.
    assert.equal(accessory.getService(Service.TemperatureSensor), undefined, "no temperature service before the settings push");

    const baseline = wakeLog.length;

    store.pushSensorPatch("test-sensor-1", { temperatureSettings: { highThreshold: 0, isEnabled: true, lowThreshold: 0, margin: 0 } });

    await settle();

    assert.deepEqual(wakeLog.slice(baseline), [{ accessoryId: accessory.UUID, key: "sensor.config" }],
      "only the whole-record sensor.config observer woke for a settings-only change");
    assert.ok(accessory.getService(Service.TemperatureSensor), "the sensor.config reconcile materialized the newly-enabled temperature service");
  });

  test("the five always-on GET MQTT subscriptions compose the device-MAC-scoped topic tails, and the default no-leak sensor registers NEITHER leak GET", () => {

    // The default carrier advertises no water-leak channels (channelNames []), so the leak-policy leaf gates both leak channels off and the per-channel MQTT fold-in
    // registers NEITHER leak GET. The other five sensor GETs are always-on and registered unconditionally in configureMqtt.
    const tails = mqtt.subscriptions.filter((subscription) => subscription.kind === "get").map((subscription) => subscription.topic);
    const mac = projection.config.mac;

    for(const tail of [ "alarm", "ambientlight", "contact", "humidity", "temperature" ]) {

      assert.ok(tails.includes(mac + "/" + tail), "the " + tail + " GET subscription composed the device-scoped tail");
    }

    assert.equal(tails.includes(mac + "/leak"), false, "the no-leak default registers no internal leak GET");
    assert.equal(tails.includes(mac + "/leak-external"), false, "the no-leak default registers no external leak GET");
  });

  test("the leak GET subscriptions register present-iff-enabled, mirroring the leak-policy leaf", () => {

    // Single-channel mount-role enabled: the internal leak GET registers, the external never (the channel is not advertised).
    const single = buildSensor({ leakChannelNames: ["internal"], mountType: "leak" });
    const singleTails = single.mqtt.subscriptions.filter((subscription) => subscription.kind === "get").map((subscription) => subscription.topic);
    const singleMac = single.projection.config.mac;

    assert.ok(singleTails.includes(singleMac + "/leak"), "a single-channel mount-role sensor registers the internal leak GET");
    assert.equal(singleTails.includes(singleMac + "/leak-external"), false, "a single-channel sensor never registers the external leak GET (channel not advertised)");

    single.sensor.cleanup();

    // Single-channel mount role OFF (the stuck-flag bug case): neither leak GET registers even though the stuck internal flag is true.
    const disabled = buildSensor({ leakChannelNames: ["internal"], leakInternalEnabled: true, mountType: "none" });
    const disabledTails = disabled.mqtt.subscriptions.filter((subscription) => subscription.kind === "get").map((subscription) => subscription.topic);
    const disabledMac = disabled.projection.config.mac;

    assert.equal(disabledTails.includes(disabledMac + "/leak"), false,
      "a single-channel sensor with mountType none registers no internal leak GET despite the stuck flag");

    disabled.sensor.cleanup();

    // Multi-channel with the external flag on: the external leak GET registers.
    const multi = buildSensor({ leakChannelNames: [ "internal", "external" ], leakExternalEnabled: true, leakInternalEnabled: true });
    const multiTails = multi.mqtt.subscriptions.filter((subscription) => subscription.kind === "get").map((subscription) => subscription.topic);
    const multiMac = multi.projection.config.mac;

    assert.ok(multiTails.includes(multiMac + "/leak"), "a multi-channel sensor with the internal flag on registers the internal leak GET");
    assert.ok(multiTails.includes(multiMac + "/leak-external"), "a multi-channel sensor with the external flag on registers the external leak GET");

    multi.sensor.cleanup();
  });

  test("re-running the reconcile does not register a second leak GET handler (the once-guard holds across config churn)", async () => {

    // subscribeGet is NOT idempotent (homebridge-plugin-utils accumulates a handler per call), so the leak GET registration is once-guarded behind isInitialized. A
    // re-run of updateDevice - driven here by a non-leak config push that wakes the whole-record sensor.config observer - must NOT register a second leak GET. The
    // TestMqttClient records every subscribeGet, so a duplicate is directly countable.
    const built = buildSensor({ leakChannelNames: ["internal"], mountType: "leak" });
    const mac = built.projection.config.mac;
    const leakGetCount = (): number => built.mqtt.subscriptions.filter((subscription) => (subscription.kind === "get") && (subscription.topic === mac + "/leak")).length;

    await settle();

    assert.equal(leakGetCount(), 1, "the internal leak GET registered exactly once at construction");

    // A settings-only push wakes the whole-record sensor.config observer, which re-runs updateDevice() (isInitialized defaults true). The once-guard must suppress a
    // second registration.
    built.store.pushSensorPatch("test-sensor-1", { temperatureSettings: { highThreshold: 0, isEnabled: true, lowThreshold: 0, margin: 0 } });

    await settle();

    assert.equal(leakGetCount(), 1, "the re-run did NOT register a second internal leak GET - the isInitialized once-guard holds");

    built.sensor.cleanup();
  });

  test("a channel toggled off unsubscribes its leak GET before the validService removal, mirroring the occupancy / motion ordering", async () => {

    // A multi-channel sensor with the external flag on registers the external leak GET at construction. Pushing the external flag off wakes the sensor.config reconcile,
    // which runs the leak-policy leaf for the now-disabled channel and unsubscribes its GET BEFORE the validService continue removes the service.
    const built = buildSensor({ leakChannelNames: [ "internal", "external" ], leakExternalEnabled: true, leakInternalEnabled: true });

    await settle();

    assert.ok(built.accessory.getServiceById(Service.LeakSensor, ProtectReservedNames.LEAKSENSOR_EXTERNAL), "the external LeakSensor exists before the toggle-off");

    const unsubBaseline = built.mqtt.unsubscribes.filter((entry) => entry.topic === "leak-external/get").length;

    built.store.pushSensorPatch("test-sensor-1", { leakSettings: { isExternalEnabled: false, isInternalEnabled: true } });

    await settle();

    assert.equal(built.accessory.getServiceById(Service.LeakSensor, ProtectReservedNames.LEAKSENSOR_EXTERNAL), undefined,
      "toggling the external flag off removed the external LeakSensor");
    assert.ok(built.mqtt.unsubscribes.filter((entry) => entry.topic === "leak-external/get").length > unsubBaseline,
      "the disabled external channel unsubscribed its leak GET on the topic tail");

    built.sensor.cleanup();
  });

  test("a captured GET handler reads through the live config value", () => {

    // Build a temperature-enabled sensor with a present stat, then invoke the captured temperature GET handler directly - the path the production subscribeGet handler
    // takes that the HomeKit onGet machinery does not exercise - and assert the string value the MQTT layer would publish.
    const built = buildSensor({ temperature: 19, temperatureEnabled: true });
    const mac = built.projection.config.mac;
    const temperatureGet = built.mqtt.subscriptions.find((subscription) => (subscription.kind === "get") && (subscription.topic === mac + "/temperature"));
    const contactGet = built.mqtt.subscriptions.find((subscription) => (subscription.kind === "get") && (subscription.topic === mac + "/contact"));

    assert.ok(temperatureGet?.getValue, "the temperature GET subscription captured a getValue handler");
    assert.equal(temperatureGet.getValue(), "19", "the temperature GET handler reads through the live stat value as a string");
    assert.ok(contactGet?.getValue, "the contact GET subscription captured a getValue handler");
    assert.equal(contactGet.getValue(), "false", "the contact GET handler reads through isOpened ?? false as a string");

    built.sensor.cleanup();
  });
});
