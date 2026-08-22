/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * sensor.test.ts: Behavior tests over a REAL constructed ProtectSensor.
 *
 * This suite constructs a REAL ProtectSensor against the harness doubles and nets its full sensor-SPECIFIC public surface plus the COMPOSITION of the base capabilities
 * it wires - never the base internals. The base-capability concern nets (device-motion / device-statusled / device-info / device-hints) own the motion switch / trigger /
 * occupancy, the status-LED routing, the info writes / observers, and the hints derivation; this suite asserts only that the sensor family wires them (for example, the
 * MotionSensor service appears when motionSettings.isEnabled and the userOptions opt in) - it does not re-net their internals.
 *
 * The sensor-specific surface: the always-present Battery service (configureBatteryService is unconditional, and updateBatteryStatus writes BatteryLevel /
 * StatusLowBattery), the per-mode services (the alarm family's alarm sound and glass-break twins / ambient light / contact-via-mountType / humidity / temperature) with
 * their read-through getters, the ambient 0.0001 HomeKit floor and the two-source read-select behind temperature and humidity (the stats block for the USL family, the
 * air-quality block for UP Air Quality hardware) with its resolve-else-hold write path, the StatusActive / StatusTampered state characteristics each carries, and the
 * per-mode MQTT publishes; the leak (default LeakSensor, internal / external subtypes) plus the moisture variant (Sensor.MoistureSensor swaps to a subtyped
 * ContactSensor, and the mode-flip cleanup removes the opposite-type service); the air-quality surface (the AirQualitySensor with its always-present level and its
 * presence-driven densities, the CarbonDioxideSensor with the controller-configured alert threshold and its presence-driven level, the opt-in vape ContactSensor at its
 * own subtype, and the curated air-quality telemetry topic that publishes on capability alone), where a service holds through an offline window and sheds when its
 * measurements read the off signature on a device we can see, and the characteristic set never shrinks while the device is unreachable; the sensor observers (the
 * motionDetectedAt firehose routed through the injected TestRecordingDispatch
 * exactly like the light's lastMotion; the tamperingDetectedAt fan-out across every state-bearing service; the alarmTriggeredAt push across each present alarm-family
 * contact sensor; the whole-record sensor.config reconcile); the always-on GET MQTT subscriptions plus the model-aware leak GETs (registered per-channel,
 * present-iff-enabled, once-guarded, and unsubscribed when a channel is toggled off).
 *
 * The multi-wake: the whole-record observer (sensor.config) selects the WHOLE sensor record (deviceSelectors.sensor.byId(id)), and pushSensorPatch replaces it on
 * every patch, so sensor.config wakes on EVERY push - in ADDITION to any narrow observer (sensor.motionDetectedAt / sensor.tamperingDetectedAt / sensor.alarmTriggeredAt)
 * whose field changed. So a narrow-field push wakes exactly the changed narrow observer plus sensor.config, in registration order (the narrow observer precedes config):
 * a motionDetectedAt push wakes [sensor.motionDetectedAt, sensor.config], a tamperingDetectedAt push wakes [sensor.tamperingDetectedAt, sensor.config], and an
 * alarmTriggeredAt push wakes [sensor.alarmTriggeredAt, sensor.config], while a settings-only push wakes sensor.config alone. The full registration order is device.name,
 * device.firmwareVersion, sensor.motionDetectedAt, sensor.tamperingDetectedAt, sensor.alarmTriggeredAt, sensor.config, but a narrow push never wakes the base observers
 * or the unchanged narrow observer. A single-observer expectation would be wrong; every wake assertion is the registration-ordered set including the accessoryId per
 * payload.
 *
 * The falsy-motionDetectedAt case is a TWO-STEP: the carrier defaults motionDetectedAt to 0, so a bare 0 push is no change (no wake). We first push a truthy timestamp
 * (settle, snapshot+reset the wake window AND a recording baseline), THEN push 0 - the truthy->0 change genuinely wakes the observer while the production
 * if(motionDetectedAt) guard, not a dead observer, suppresses the firehose delivery (the light's falsy-motion non-vacuity, adapted).
 *
 * The isolation model mirrors the light reference: a beforeEach builds a fresh sensor so the recording calls, the characteristic state, the observer baselines, and
 * store.observerCount are clean every test, the wake log is windowed per push via a captured baseline, and an afterEach unwinds the sensor's per-accessory abort.
 */
import { Characteristic, Service, TestStateStore, makeProtectState, makeTestAccessory, settle } from "../testing.helpers.ts";
import type { CharacteristicType, TestAccessory, TestLogEntry } from "../testing.helpers.ts";
import type { ProtectSensorAirQuality, Sensor } from "unifi-protect";
import { TestRecordingDispatch, makeTestNvr } from "../nvr/testing.helpers.ts";
import { TestSensorProjection, makeSensorConfig } from "./testing.helpers.ts";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import { NOT_CAPABLE_AIR_QUALITY } from "./air-quality-policy.ts";
import type { Nullable } from "homebridge-plugin-utils";
import type { ObserverWakePayload } from "../diagnostics.ts";
import type { ProtectAccessory } from "../types.ts";
import type { ProtectEventDispatch } from "../nvr/event-dispatch.ts";
import type { ProtectNvr } from "../nvr/nvr.ts";
import { ProtectReservedNames } from "../types.ts";
import { ProtectSensor } from "./sensor.ts";
import type { TestMqttClient } from "../nvr/testing.helpers.ts";
import assert from "node:assert/strict";
import diagnosticsChannel from "node:diagnostics_channel";

// The device logger prefixes every line with the device name; the harness renders what the real Homebridge logger would emit into entry.formatted (for example
// "Test Sensor: Enabled sensor: temperature."), so a log assertion matches a substring of that rendered line at the given level, mirroring the chime / device-motion
// suites' helper.
function loggedAt(entries: TestLogEntry[], level: TestLogEntry["level"], substring: string): boolean {

  return entries.some((entry) => (entry.level === level) && entry.formatted.includes(substring));
}

// The count companion to loggedAt: how MANY log lines at the given level contain the substring. The alarm-family transition assertions need an exact count (a transition
// must log EXACTLY once per edge), which the presence-only loggedAt cannot express; loggedAt stays fine for absence assertions.
function countLoggedAt(entries: TestLogEntry[], level: TestLogEntry["level"], substring: string): number {

  return entries.filter((entry) => (entry.level === level) && entry.formatted.includes(substring)).length;
}

// A full block of air-quality readings, quiet except the metrics a case names - the shape the controller always sends, where every metric is present whether or not the
// hardware measures it. Air-quality patches carry the WHOLE block, matching how this suite pushes every other nested settings object.
function airQualityBlock(overrides: Partial<ProtectSensorAirQuality>): ProtectSensorAirQuality {

  return { ...NOT_CAPABLE_AIR_QUALITY, ...overrides };
}

// Every harness controller this suite opens, drained in afterEach so the controller lifetime signal bounds each test's constructions rather than the file's. The builder
// is the single push site, so the many per-test variant builds are captured exactly as the fixture's is.
const controllers: AbortController[] = [];

// The reusable construction helper: build a REAL ProtectSensor against the harness doubles, with the recording dispatch injected through the NVR double's
// dispatch-injection point so the motionDetectedAt observer's firehose routing is asserted against the REAL ProtectEventDispatch contract (the recording subclass arms no
// reset timer). The casts are confined to where the class is constructed exactly as the light / chime suites do; the instance under test is the production class,
// running its real configureHints / configureDevice / spawnObservers paths. The accessory factory is injectable so the moisture mode-flip test can pre-seed a LeakSensor
// before construction. The injected recording dispatch is read off nvr.events after construction rather than captured from the factory closure - reading it back avoids
// both the assignment-expression smell and a TS2454 definite-assignment error on a factory-captured binding.
function buildSensor(configOptions: Parameters<typeof makeSensorConfig>[0] = {}, harnessOptions: { accessory?: TestAccessory; userOptions?: string[] } = {}): {
  accessory: TestAccessory; logEntries: TestLogEntry[]; mqtt: TestMqttClient; projection: TestSensorProjection; recording: TestRecordingDispatch; sensor: ProtectSensor;
  store: TestStateStore;
} {

  const sensorConfig = makeSensorConfig(configOptions);
  const store = new TestStateStore(makeProtectState({ sensors: [sensorConfig] }));
  const { controller, logEntries, mqtt, nvr } = makeTestNvr({ dispatch: (innerNvr: ProtectNvr): ProtectEventDispatch => new TestRecordingDispatch(innerNvr), mqtt: true,
    store, userOptions: harnessOptions.userOptions });

  controllers.push(controller);

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
  // no-per-mode baseline and the ABSENCE of any enabled-diff log at construction, reserving the "No sensors enabled." line for the transition test. The per-mode /
  // leak / observer tests build their own variants with the relevant settings flipped.
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

    for(const controller of controllers) {

      controller.abort();
    }

    controllers.length = 0;
  });

  test("six observers register, construction wakes none, and the always-present Battery service carries its battery state", () => {

    assert.equal(store.observerCount, 6, "the two base observers plus the sensor's four are registered against the store double");
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

  test("preserves a persisted detectMotion of false across the context reset", async () => {

    // Fold C27: the motion sensor and its Motion.Switch must both be enabled so configureMotionSwitch takes its service branch rather than its disabled branch, whose
    // force-reset would stamp detectMotion back to true and mask the fix. Pre-seed the accessory as if the user had turned motion detection off in a prior session; the
    // context reset must carry that choice across the restart rather than wiping it back to the default.
    const seeded = makeTestAccessory("Test Sensor", "uuid:test-sensor");

    seeded.context["detectMotion"] = false;

    const built = buildSensor({ motionEnabled: true }, { accessory: seeded, userOptions: ["Enable.Motion.Switch"] });

    await settle();

    try {

      assert.equal(built.accessory.context["detectMotion"], false, "a persisted detectMotion of false survives the context reset rather than being wiped back to true");
    } finally {

      built.sensor.cleanup();
    }
  });

  test("cleanup unwinds all six observers, and a value-changing push afterward wakes nothing", async () => {

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

  test("the Device.AmbientLightSensor option off hides the sensor's ambient light sensor (the user toggle)", async () => {

    // The sensor reports ambient light, but the user disabled the Device.AmbientLightSensor toggle, so validService prunes the LightSensor. The toggle defaults on, so
    // every other ambient-light test (no userOptions) keeps the sensor; only an explicit Disable removes it. Dropping the && this.hasFeature("Device.AmbientLightSensor")
    // half from the gate leaves this RED - the LightSensor would materialize despite the disabled option.
    const built = buildSensor({ lightEnabled: true }, { userOptions: ["Disable.Device.AmbientLightSensor"] });

    assert.equal(built.accessory.getService(Service.LightSensor), undefined, "the disabled Device.AmbientLightSensor option hides the sensor's ambient light sensor");

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

    // This single-channel sensor advertises the stuck internal leakSettings flag as true while its mount role is off. The leaf reads mountType (not leakSettings) for
    // single-channel devices, so no leak service materializes here.
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

  test("the humidity sensor materializes from its toggle with nothing to say, then writes and publishes once a reading arrives", async () => {

    // A service carried by its Protect toggle alone, walked through both phases. No humidity option and no air-quality hardware, so neither source resolves a reading:
    // nothing is written and nothing is published, leaving HomeKit on its own default rather than being told a made-up number. Then a stats reading arrives, and the
    // service writes it to the characteristic and publishes it on the device-scoped topic.
    const built = buildSensor({ humidityEnabled: true });
    const mac = built.projection.config.mac;

    await settle();

    const humidity = built.accessory.getService(Service.HumiditySensor);

    assert.ok(humidity, "enabling humidity settings materializes the HumiditySensor");
    assert.equal(humidity.getCharacteristic(Characteristic.CurrentRelativeHumidity).writes.length, 0,
      "no source reporting means no write at all - no sentinel, no floor");
    assert.equal(built.mqtt.published.some((entry) => entry.topic === (mac + "/humidity")), false, "nothing was published for a reading the sensor never gave");

    built.store.pushSensorPatch("test-sensor-1", { stats: { humidity: { status: "", value: 47.5 } } });

    await settle();

    assert.equal(humidity.getCharacteristic(Characteristic.CurrentRelativeHumidity).value, 47.5, "the arriving stats reading landed on the characteristic");
    assert.equal(await humidity.getCharacteristic(Characteristic.CurrentRelativeHumidity).triggerGet(), 47.5, "the onGet reads through the live stat value");
    assert.ok(built.mqtt.published.some((entry) => (entry.topic === (mac + "/humidity")) && (entry.message === "47.5")),
      "the humidity state published on the device-scoped topic");

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

  test("a temperature service materialized by its toggle alone holds HomeKit's own default until the first reading arrives", async () => {

    // The first-materialization case for a service whose toggle is on before any reading exists. A dropout must never manufacture a number, and neither must a service
    // that has simply never heard one: the characteristic goes unwritten and the topic stays silent, so HomeKit shows its own default rather than a sentinel.
    const built = buildSensor({ temperatureEnabled: true });
    const mac = built.projection.config.mac;

    await settle();

    const temperature = built.accessory.getService(Service.TemperatureSensor);

    assert.ok(temperature, "the toggle alone materializes the TemperatureSensor with no reading in sight");
    assert.equal(temperature.getCharacteristic(Characteristic.CurrentTemperature).writes.length, 0, "the unwritten characteristic never took a sentinel value");
    assert.equal(built.mqtt.published.some((entry) => entry.topic === (mac + "/temperature")), false, "no temperature was published for a reading nobody gave");

    built.store.pushSensorPatch("test-sensor-1", { stats: { temperature: { status: "", value: 18.25 } } });

    await settle();

    assert.equal(temperature.getCharacteristic(Characteristic.CurrentTemperature).value, 18.25, "the first arriving reading landed on the characteristic");
    assert.ok(built.mqtt.published.some((entry) => (entry.topic === (mac + "/temperature")) && (entry.message === "18.25")), "the first reading published too");

    built.sensor.cleanup();
  });

  test("two enabled sensors log the PLURAL enabled-sensors line", () => {

    const built = buildSensor({ humidityEnabled: true, temperatureEnabled: true });

    assert.ok(loggedAt(built.logEntries, "info", "Enabled sensors: humidity, temperature."), "two enabled sensors log the plural enabled-sensors line in order");

    built.sensor.cleanup();
  });

  test("a multi-channel sensor materializes internal and external LeakSensor services with read-through and the isConnected-gated publishes", async () => {

    // A multi-channel USL-Environmental (channelNames ["internal","external"]) drives each leak channel via its live leakSettings flag, so both flags enabled exposes
    // both LeakSensor services, matching the documented multi-channel leak-policy behavior.
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

  test("the six always-on GET MQTT subscriptions compose the device-MAC-scoped topic tails, and the default no-leak sensor registers NEITHER leak GET", () => {

    // The default carrier advertises no water-leak channels (channelNames []), so the leak-policy leaf gates both leak channels off and the per-channel MQTT fold-in
    // registers NEITHER leak GET. The other sensor GETs are always-on and registered unconditionally in configureMqtt, including both alarm-family gets (alarm sound
    // and glass break) regardless of whether either service exists.
    const tails = mqtt.subscriptions.filter((subscription) => subscription.kind === "get").map((subscription) => subscription.topic);
    const mac = projection.config.mac;

    for(const tail of [ "alarm", "ambientlight", "contact", "glassbreak", "humidity", "temperature" ]) {

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

    // subscribeGet accumulates a handler on every call rather than replacing one (homebridge-plugin-utils), so the leak GET registration is once-guarded behind
    // isInitialized. A re-run of updateDevice - driven here by a non-leak config push that wakes the whole-record sensor.config observer - must NOT register a second
    // leak GET. The TestMqttClient records every subscribeGet, so a duplicate is directly countable.
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

  test("a channel toggled off unsubscribes its leak GET, and toggled back on re-registers it without disturbing its sibling", async () => {

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

    // Push the external flag back ON. The leak-policy leaf re-enables the channel, and the created-probe re-registers its GET rather than leaving it dead until a
    // restart. The untouched internal channel must NOT re-register - a forbidden onServiceCreate closure-flip would leak the reset into the sibling and double-register
    // its GET.
    const mac = built.projection.config.mac;
    const externalGets = (): number => built.mqtt.subscriptions.filter((entry) => (entry.kind === "get") && (entry.topic === (mac + "/leak-external"))).length;
    const internalGets = (): number => built.mqtt.subscriptions.filter((entry) => (entry.kind === "get") && (entry.topic === (mac + "/leak"))).length;
    const externalBefore = externalGets();
    const internalBefore = internalGets();

    built.store.pushSensorPatch("test-sensor-1", { leakSettings: { isExternalEnabled: true, isInternalEnabled: true } });

    await settle();

    assert.ok(built.accessory.getServiceById(Service.LeakSensor, ProtectReservedNames.LEAKSENSOR_EXTERNAL),
      "toggling the external flag back on re-created the external LeakSensor");
    assert.ok(externalGets() > externalBefore, "the re-enabled external channel re-registered its leak GET rather than staying dead until a restart");
    assert.equal(internalGets(), internalBefore, "the untouched internal channel did not re-register its GET - no closure-flip leak into the sibling");

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

  test("a glass-break-capable enabled sensor exposes a subtyped Glass Break ContactSensor; without the capability it exposes none", () => {

    const withCap = buildSensor({ glassBreak: true, glassBreakEnabled: true });
    const glass = withCap.accessory.getServiceById(Service.ContactSensor, ProtectReservedNames.CONTACT_SENSOR_GLASS_BREAK);

    assert.ok(glass, "glassBreak present and enabled materializes the Glass Break ContactSensor at its subtype");
    assert.equal(glass.displayName, "Test Sensor Glass Break", "the glass-break service is named accessoryName + ' Glass Break'");

    withCap.sensor.cleanup();

    const withoutCap = buildSensor();

    assert.equal(withoutCap.accessory.getServiceById(Service.ContactSensor, ProtectReservedNames.CONTACT_SENSOR_GLASS_BREAK), undefined,
      "a sensor with no glass-break capability exposes no glass-break service");

    withoutCap.sensor.cleanup();

    // The capability channel present but its settings toggle off: the gate's second half (glassBreakSettings.isEnabled) must still prune the service.
    const capDisabled = buildSensor({ glassBreak: true });

    assert.equal(capDisabled.accessory.getServiceById(Service.ContactSensor, ProtectReservedNames.CONTACT_SENSOR_GLASS_BREAK), undefined,
      "a glass-break-capable but disabled sensor exposes no glass-break service");

    capDisabled.sensor.cleanup();
  });

  test("twin exclusivity: a glass-break device carries only the glass-break twin, an audio-alarm device only the alarm-sound twin", () => {

    const glassOnly = buildSensor({ glassBreak: true, glassBreakEnabled: true });

    assert.ok(glassOnly.accessory.getServiceById(Service.ContactSensor, ProtectReservedNames.CONTACT_SENSOR_GLASS_BREAK),
      "the glass-break device carries the glass-break service");
    assert.equal(glassOnly.accessory.getServiceById(Service.ContactSensor, ProtectReservedNames.CONTACT_SENSOR_ALARM_SOUND), undefined,
      "the glass-break device carries NO alarm-sound service");

    glassOnly.sensor.cleanup();

    const alarmOnly = buildSensor({ alarmEnabled: true });

    assert.ok(alarmOnly.accessory.getServiceById(Service.ContactSensor, ProtectReservedNames.CONTACT_SENSOR_ALARM_SOUND),
      "the audio-alarm device carries the alarm-sound service");
    assert.equal(alarmOnly.accessory.getServiceById(Service.ContactSensor, ProtectReservedNames.CONTACT_SENSOR_GLASS_BREAK), undefined,
      "the audio-alarm device carries NO glass-break service");

    alarmOnly.sensor.cleanup();
  });

  test("a glass-break device lands the alarmTriggeredAt value and logs the transition exactly once on each edge", async () => {

    const built = buildSensor({ glassBreak: true, glassBreakEnabled: true });

    await settle();

    const glass = built.accessory.getServiceById(Service.ContactSensor, ProtectReservedNames.CONTACT_SENSOR_GLASS_BREAK);

    assert.ok(glass, "the glass-break ContactSensor exists");
    assert.equal(glass.getCharacteristic(Characteristic.ContactSensorState).value, false, "the glass-break sensor starts clear (alarmTriggeredAt null)");

    built.store.pushSensorPatch("test-sensor-1", { alarmTriggeredAt: 1700000000000 });

    await settle();

    assert.equal(glass.getCharacteristic(Characteristic.ContactSensorState).value, true, "the non-null alarmTriggeredAt landed on the glass-break ContactSensorState");
    assert.equal(countLoggedAt(built.logEntries, "info", "Glass break detected."), 1, "the detection logged the Glass-break transition exactly once");

    built.store.pushSensorPatch("test-sensor-1", { alarmTriggeredAt: null });

    await settle();

    assert.equal(glass.getCharacteristic(Characteristic.ContactSensorState).value, false, "clearing alarmTriggeredAt cleared the glass-break ContactSensorState");
    assert.equal(countLoggedAt(built.logEntries, "info", "Glass break no longer detected."), 1, "the clear logged the Glass-break transition exactly once");

    built.sensor.cleanup();
  });

  test("an audio-alarm device lands the alarmTriggeredAt value and logs the Alarm transition exactly once on each edge", async () => {

    const built = buildSensor({ alarmEnabled: true });

    await settle();

    const alarm = built.accessory.getServiceById(Service.ContactSensor, ProtectReservedNames.CONTACT_SENSOR_ALARM_SOUND);

    assert.ok(alarm, "the alarm-sound ContactSensor exists");

    built.store.pushSensorPatch("test-sensor-1", { alarmTriggeredAt: 1700000000000 });

    await settle();

    assert.equal(alarm.getCharacteristic(Characteristic.ContactSensorState).value, true, "the non-null alarmTriggeredAt landed on the alarm-sound ContactSensorState");
    assert.equal(countLoggedAt(built.logEntries, "info", "Alarm detected."), 1, "the detection logged the Alarm transition exactly once with the alarm-sound label");

    built.store.pushSensorPatch("test-sensor-1", { alarmTriggeredAt: null });

    await settle();

    assert.equal(alarm.getCharacteristic(Characteristic.ContactSensorState).value, false, "clearing alarmTriggeredAt cleared the alarm-sound ContactSensorState");
    assert.equal(countLoggedAt(built.logEntries, "info", "Alarm no longer detected."), 1, "the clear logged the Alarm transition exactly once");

    built.sensor.cleanup();
  });

  test("the targeted alarm push moves only the alarm-family subtype and never the plain mount-type contact sensor", async () => {

    // A device with BOTH a plain mount-type contact sensor (mountType door) and a glass-break service. The targeted push must move the glass-break ContactSensorState
    // while leaving the plain CONTACT_SENSOR-subtype service's ContactSensorState false - guarding against a future fan-across-all-ContactSensor refactor.
    const built = buildSensor({ glassBreak: true, glassBreakEnabled: true, mountType: "door" });

    await settle();

    const glass = built.accessory.getServiceById(Service.ContactSensor, ProtectReservedNames.CONTACT_SENSOR_GLASS_BREAK);
    const plain = built.accessory.getServiceById(Service.ContactSensor, ProtectReservedNames.CONTACT_SENSOR);

    assert.ok(glass, "the glass-break service exists");
    assert.ok(plain, "the plain mount-type contact sensor exists");
    assert.equal(plain.getCharacteristic(Characteristic.ContactSensorState).value, false, "the plain contact sensor starts closed");

    built.store.pushSensorPatch("test-sensor-1", { alarmTriggeredAt: 1700000000000 });

    await settle();

    assert.equal(glass.getCharacteristic(Characteristic.ContactSensorState).value, true, "the alarm push moved the glass-break ContactSensorState");
    assert.equal(plain.getCharacteristic(Characteristic.ContactSensorState).value, false, "the alarm push left the plain contact sensor's ContactSensorState untouched");

    built.sensor.cleanup();
  });

  test("a late glass-break capability creates the service with StatusActive and onGet wired, then lands a subsequent alarm value", async () => {

    const built = buildSensor();

    await settle();

    assert.equal(built.accessory.getServiceById(Service.ContactSensor, ProtectReservedNames.CONTACT_SENSOR_GLASS_BREAK), undefined,
      "the all-quiet sensor carries no glass-break service before the capability arrives");

    // A config patch enabling the glass-break channel and its settings toggle wakes the whole-record sensor.config observer, whose reconcile creates the service through
    // the create-seed path (created true).
    built.store.pushSensorPatch("test-sensor-1", { featureFlags: { glassBreak: { channelCount: 1 }, isBidirectional: false,
      waterLeak: { channelCount: 0, channelNames: [] } }, glassBreakSettings: { isEnabled: true, sensitivity: 0, sensitivityWhenArmed: 0 } });

    await settle();

    const glass = built.accessory.getServiceById(Service.ContactSensor, ProtectReservedNames.CONTACT_SENSOR_GLASS_BREAK);

    assert.ok(glass, "the late capability created the glass-break ContactSensor");
    assert.equal(glass.getCharacteristic(Characteristic.StatusActive).value, true, "the created service seeded StatusActive from isReachable");
    assert.equal(await glass.getCharacteristic(Characteristic.ContactSensorState).triggerGet(), false, "the created service wired its onGet read-through (clear)");

    built.store.pushSensorPatch("test-sensor-1", { alarmTriggeredAt: 1700000000000 });

    await settle();

    assert.equal(glass.getCharacteristic(Characteristic.ContactSensorState).value, true, "a subsequent alarm value landed on the newly-created glass-break service");

    built.sensor.cleanup();
  });

  test("a fresh alarm-enabled or glass-break sensor logs nothing alarm-related at configure, even when already latched", () => {

    const idleAlarm = buildSensor({ alarmEnabled: true });

    assert.equal(loggedAt(idleAlarm.logEntries, "info", "Alarm detected."), false, "an idle alarm-enabled sensor logs no Alarm detection at configure");
    assert.equal(loggedAt(idleAlarm.logEntries, "info", "Alarm no longer detected."), false, "an idle alarm-enabled sensor logs no spurious Alarm-cleared line");

    idleAlarm.sensor.cleanup();

    const idleGlass = buildSensor({ glassBreak: true, glassBreakEnabled: true });

    assert.equal(loggedAt(idleGlass.logEntries, "info", "Glass break detected."), false, "an idle glass-break sensor logs no Glass-break detection at configure");
    assert.equal(loggedAt(idleGlass.logEntries, "info", "Glass break no longer detected."), false, "an idle glass-break sensor logs no spurious cleared line");

    idleGlass.sensor.cleanup();

    // A sensor already latched at configure shows detected with NO startup log line: the create-seed sets the baseline so the observer never sees a transition.
    const latched = buildSensor({ alarmTriggeredAt: 1700000000000, glassBreak: true, glassBreakEnabled: true });
    const glass = latched.accessory.getServiceById(Service.ContactSensor, ProtectReservedNames.CONTACT_SENSOR_GLASS_BREAK);

    assert.ok(glass, "the latched glass-break service exists");
    assert.equal(glass.getCharacteristic(Characteristic.ContactSensorState).value, true, "the latched-at-configure sensor shows detected");
    assert.equal(loggedAt(latched.logEntries, "info", "Glass break detected."), false, "the latched-at-configure sensor logs no startup transition line");

    latched.sensor.cleanup();
  });

  test("the glass-break sensor re-fires across multiple distinct transitions, logging exactly once per edge", async () => {

    const built = buildSensor({ glassBreak: true, glassBreakEnabled: true });

    await settle();

    const glass = built.accessory.getServiceById(Service.ContactSensor, ProtectReservedNames.CONTACT_SENSOR_GLASS_BREAK);

    assert.ok(glass, "the glass-break service exists");

    built.store.pushSensorPatch("test-sensor-1", { alarmTriggeredAt: 1700000000000 });

    await settle();

    assert.equal(glass.getCharacteristic(Characteristic.ContactSensorState).value, true, "first edge: detected");

    built.store.pushSensorPatch("test-sensor-1", { alarmTriggeredAt: null });

    await settle();

    assert.equal(glass.getCharacteristic(Characteristic.ContactSensorState).value, false, "second edge: cleared");

    built.store.pushSensorPatch("test-sensor-1", { alarmTriggeredAt: 1700000005000 });

    await settle();

    assert.equal(glass.getCharacteristic(Characteristic.ContactSensorState).value, true, "third edge: re-detected on a distinct timestamp");
    assert.equal(countLoggedAt(built.logEntries, "info", "Glass break detected."), 2, "each detection edge logged exactly once (two detections)");
    assert.equal(countLoggedAt(built.logEntries, "info", "Glass break no longer detected."), 1, "the single clear edge logged exactly once");

    built.sensor.cleanup();
  });

  test("six observers register and a bare alarmTriggeredAt push wakes only its observer and sensor.config", async () => {

    assert.equal(store.observerCount, 6, "the two base observers plus the sensor's four are registered against the store double");

    const baseline = wakeLog.length;

    // A bare alarmTriggeredAt push (null -> a timestamp) changes the narrow slice and the whole record, so the alarm observer and sensor.config wake, in registration
    // order (the narrow observer precedes config); updateAlarmState is a safe no-op on this all-quiet sensor with no alarm-family service.
    store.pushSensorPatch("test-sensor-1", { alarmTriggeredAt: 1700000000000 });

    await settle();

    assert.deepEqual(wakeLog.slice(baseline),
      [ { accessoryId: accessory.UUID, key: "sensor.alarmTriggeredAt" }, { accessoryId: accessory.UUID, key: "sensor.config" } ],
      "the narrow alarmTriggeredAt observer AND the whole-record sensor.config observer woke, in registration order");
  });

  test("the alarm-family service's StatusActive flips offline alongside the motion service every reconcile", async () => {

    // A glass-break device with motion enabled: both services carry StatusActive seeded true (reachable). Driving the device offline via a state push wakes the
    // whole-record reconcile, whose UNCONDITIONAL configureStateCharacteristics must flip the glass-break service's StatusActive false alongside the motion service's -
    // proving the state characteristics run for the alarm family every reconcile, not only at create.
    const built = buildSensor({ glassBreak: true, glassBreakEnabled: true, motionEnabled: true });

    await settle();

    const glass = built.accessory.getServiceById(Service.ContactSensor, ProtectReservedNames.CONTACT_SENSOR_GLASS_BREAK);
    const motion = built.accessory.getService(Service.MotionSensor);

    assert.ok(glass, "the glass-break service exists");
    assert.ok(motion, "the motion service exists");
    assert.equal(glass.getCharacteristic(Characteristic.StatusActive).value, true, "the glass-break StatusActive starts active (reachable)");
    assert.equal(motion.getCharacteristic(Characteristic.StatusActive).value, true, "the motion StatusActive starts active (reachable)");

    built.store.pushSensorPatch("test-sensor-1", { state: "DISCONNECTED" });

    await settle();

    assert.equal(motion.getCharacteristic(Characteristic.StatusActive).value, false, "the offline device flipped the motion service's StatusActive");
    assert.equal(glass.getCharacteristic(Characteristic.StatusActive).value, false,
      "the offline device flipped the alarm-family service's StatusActive too, proving configureStateCharacteristics runs every reconcile");

    built.sensor.cleanup();
  });

  test("the glassbreak MQTT get reads through alarmDetected, publishes on change, and the alarm get still registers", async () => {

    const built = buildSensor({ glassBreak: true, glassBreakEnabled: true });
    const mac = built.projection.config.mac;
    const glassGet = built.mqtt.subscriptions.find((subscription) => (subscription.kind === "get") && (subscription.topic === mac + "/glassbreak"));
    const alarmGet = built.mqtt.subscriptions.find((subscription) => (subscription.kind === "get") && (subscription.topic === mac + "/alarm"));

    await settle();

    assert.ok(glassGet?.getValue, "the glassbreak GET subscription captured a getValue handler");
    assert.ok(alarmGet?.getValue, "the alarm GET subscription still registers unconditionally");
    assert.equal(glassGet.getValue(), "false", "the glassbreak GET reads through alarmDetected as a string (clear at start)");

    built.store.pushSensorPatch("test-sensor-1", { alarmTriggeredAt: 1700000000000 });

    await settle();

    assert.equal(glassGet.getValue(), "true", "the glassbreak GET reads through the non-null alarmTriggeredAt after the push");
    assert.ok(built.mqtt.published.some((entry) => (entry.topic === mac + "/glassbreak") && (entry.message === "true")),
      "the glass-break state published true on the device-scoped topic after detection");

    built.store.pushSensorPatch("test-sensor-1", { alarmTriggeredAt: null });

    await settle();

    assert.ok(built.mqtt.published.some((entry) => (entry.topic === mac + "/glassbreak") && (entry.message === "false")),
      "the glass-break state published false on the device-scoped topic after the clear");

    built.sensor.cleanup();
  });

  test("a glass-break device logs the singular enabled-sensor line with the glass break label", () => {

    const built = buildSensor({ glassBreak: true, glassBreakEnabled: true });

    assert.ok(loggedAt(built.logEntries, "info", "Enabled sensor: glass break."), "one enabled glass-break sensor logs the singular enabled-sensor line");

    built.sensor.cleanup();
  });

  test("a sensor reporting an air-quality index materializes the AirQualitySensor with the mapped level, its state characteristics, and the enabled-sensor label", () => {

    // An index of 42 sits inside the EPA's first band, which maps to HomeKit's excellent. Only the index reports here, so the service carries AirQuality and none of the
    // presence-driven densities - the per-metric independence the next test walks in full.
    const built = buildSensor({ airQuality: { aqi: { status: "neutral", value: 42 } } });
    const service = built.accessory.getService(Service.AirQualitySensor);

    assert.ok(service, "a reporting index materializes the AirQualitySensor service");
    assert.equal(service.getCharacteristic(Characteristic.AirQuality).value, 1, "AirQuality initialized to excellent from an index of 42");
    assert.equal(service.getCharacteristic(Characteristic.StatusActive).value, true, "StatusActive carried from isReachable");
    assert.equal(service.getCharacteristic(Characteristic.StatusTampered).value, false, "StatusTampered carried from the tamper read-through");
    assert.equal(service.testCharacteristic(Characteristic.PM2_5Density), false, "an index-only sensor carries no PM2.5 density");
    assert.equal(service.testCharacteristic(Characteristic.PM10Density), false, "an index-only sensor carries no PM10 density");
    assert.equal(service.testCharacteristic(Characteristic.VOCDensity), false,
      "no reading projects onto VOCDensity at all - Protect's gas readings are unitless indexes, and HomeKit's density characteristic wants a concentration");
    assert.ok(loggedAt(built.logEntries, "info", "Enabled sensor: air quality."), "the air quality label reached the enabled-sensors log");

    built.sensor.cleanup();
  });

  test("each density characteristic tracks its own metric independently, carrying that metric's own value", () => {

    // The per-metric matrix: a sensor reporting exactly one particulate carries exactly that density and not the other, and the value on it is its own metric's -
    // presence alone would pass even if every density read the same source.
    const cases: { characteristic: CharacteristicType; label: string; metric: string; value: number }[] = [

      { characteristic: Characteristic.PM2_5Density, label: "PM2.5", metric: "pm2p5", value: 3 },
      { characteristic: Characteristic.PM10Density, label: "PM10", metric: "pm10p0", value: 5 }
    ];

    for(const { characteristic, label, metric, value } of cases) {

      const built = buildSensor({ airQuality: { [metric]: { status: "neutral", value } } });
      const service = built.accessory.getService(Service.AirQualitySensor);

      assert.ok(service, "the " + label + "-only sensor materializes the AirQualitySensor service");
      assert.equal(service.getCharacteristic(characteristic).value, value, "the " + label + " density carries its own metric's value");

      for(const other of cases.filter((entry) => entry.characteristic !== characteristic)) {

        assert.equal(service.testCharacteristic(other.characteristic), false, "the " + label + "-only sensor carries no " + other.label + " density");
      }

      assert.equal(service.getCharacteristic(Characteristic.AirQuality).value, 0, "with no index reading the level reports unknown");

      built.sensor.cleanup();
    }
  });

  test("an all-quiet sensor creates none of the air quality, carbon dioxide, or vape services", () => {

    // The fleet gate. Every Protect sensor carries the air-quality block whether or not its hardware measures anything, so a sensor without that hardware reads
    // unknown/null on all twelve metrics - and must grow nothing, even with the vape option turned on.
    const built = buildSensor({ vapeEnabled: true }, { userOptions: ["Enable.Sensor.Vape"] });

    assert.equal(built.accessory.getService(Service.AirQualitySensor), undefined, "no AirQualitySensor on a sensor with no air-quality hardware");
    assert.equal(built.accessory.getService(Service.CarbonDioxideSensor), undefined, "no CarbonDioxideSensor on a sensor with no air-quality hardware");
    assert.equal(built.accessory.getServiceById(Service.ContactSensor, ProtectReservedNames.CONTACT_SENSOR_VAPE), undefined,
      "no vape ContactSensor even with both the option and the controller's own vape enable on, because the metric never reports");
    assert.equal(loggedAt(built.logEntries, "info", "air quality"), false, "nothing air-quality reached the enabled-sensors log");

    built.sensor.cleanup();
  });

  test("cached air quality and carbon dioxide services over a block that never reports are removed on the first pass", async () => {

    // The cached-restore form: Homebridge restores a service from its accessory cache before the plugin runs, so a sensor whose hardware never measured any of this -
    // one whose accessory carries the services from an earlier configuration, or from hardware that has since been swapped - must have them REMOVED rather than merely
    // not created. Without the pre-seed this would pass vacuously. The device is reachable throughout, which is what makes the quiet readings believable.
    const seeded = makeTestAccessory("Cached Sensor", "uuid:cached-sensor");

    seeded.addService(new Service.AirQualitySensor("Cached Air Quality"));
    seeded.addService(new Service.CarbonDioxideSensor("Cached Carbon Dioxide"));

    assert.ok(seeded.getService(Service.AirQualitySensor), "the cached AirQualitySensor was seeded before construction");
    assert.ok(seeded.getService(Service.CarbonDioxideSensor), "the cached CarbonDioxideSensor was seeded before construction");

    const restored = buildSensor({}, { accessory: seeded });

    await settle();

    assert.equal(seeded.getService(Service.AirQualitySensor), undefined, "the cached air quality service was removed on the first reconcile");
    assert.equal(seeded.getService(Service.CarbonDioxideSensor), undefined, "the cached carbon dioxide service was removed on the first reconcile");

    restored.sensor.cleanup();
  });

  test("a gating metric falling quiet sheds its density, and every gating metric falling quiet sheds the service itself while the device is reachable", async () => {

    // The two levels of the same rule, staged so both are observable. First a patch that leaves ONE gating metric reporting: the service stands, the metric that left
    // liveness sheds exactly its own density, and the level reports unknown with no index. Then a patch turning everything quiet: the service itself goes, because on a
    // device we can see, the not-capable signature is how the controller says the user turned that measurement off in the Protect app.
    const built = buildSensor({ airQuality: { aqi: { status: "neutral", value: 42 }, pm10p0: { status: "neutral", value: 5 }, pm2p5: { status: "neutral", value: 3 } } });

    await settle();

    const service = built.accessory.getService(Service.AirQualitySensor);

    assert.ok(service, "the service exists before the patch");
    assert.equal(service.testCharacteristic(Characteristic.PM2_5Density), true, "the PM2.5 density exists before the patch");

    built.store.pushSensorPatch("test-sensor-1", { airQuality: airQualityBlock({ pm10p0: { status: "neutral", value: 5 } }) });

    await settle();

    assert.ok(built.accessory.getService(Service.AirQualitySensor), "one gating metric still reporting keeps the service standing");
    assert.equal(service.testCharacteristic(Characteristic.PM2_5Density), false, "the PM2.5 density was shed, its metric having left liveness while the device is here");
    assert.equal(service.getCharacteristic(Characteristic.AirQuality).value, 0, "the level reports unknown with no index reading");

    built.store.pushSensorPatch("test-sensor-1", { airQuality: airQualityBlock({}) });

    await settle();

    assert.equal(built.accessory.getService(Service.AirQualitySensor), undefined,
      "every gating metric reading the off signature on a reachable device sheds the service itself");

    built.sensor.cleanup();
  });

  test("a metric that goes live-but-null holds its characteristic and its value, while one that leaves liveness entirely sheds it", async () => {

    // The two halves of the hold rule, in one patch: pm2p5 keeps a status but loses its number (still reporting, momentarily between readings) and must neither be
    // written nor removed; pm10p0 goes fully quiet and must be removed. The write log - not the cached value - is what proves nothing was written, since a re-write of
    // the same value is invisible in the value alone.
    const built = buildSensor({ airQuality: { pm10p0: { status: "neutral", value: 5 }, pm2p5: { status: "neutral", value: 3 } } });

    await settle();

    const service = built.accessory.getService(Service.AirQualitySensor);

    assert.ok(service, "the service exists before the patch");

    const writeBaseline = service.getCharacteristic(Characteristic.PM2_5Density).writes.length;

    built.store.pushSensorPatch("test-sensor-1", { airQuality: airQualityBlock({ pm2p5: { status: "neutral", value: null } }) });

    await settle();

    assert.equal(service.testCharacteristic(Characteristic.PM2_5Density), true, "a live-but-null metric holds its characteristic rather than shedding it");
    assert.equal(service.getCharacteristic(Characteristic.PM2_5Density).value, 3, "the held characteristic still reports the last reading the sensor gave");
    assert.equal(service.getCharacteristic(Characteristic.PM2_5Density).writes.length, writeBaseline, "the hold wrote nothing at all");
    assert.equal(await service.getCharacteristic(Characteristic.PM2_5Density).triggerGet(), 3, "a pull during the hold answers with the held value, not a dead reading");
    assert.equal(service.testCharacteristic(Characteristic.PM10Density), false, "the metric that left liveness entirely shed exactly its own characteristic");

    built.sensor.cleanup();
  });

  test("an unreachable device holds its whole characteristic set even as its metrics fall quiet", async () => {

    // The offline window. Everything the sensor last said stays put: a controller outage or a battery sensor dropping off must never churn the accessory's
    // configuration, so the removal rule waits for the device to be reachable before believing a metric has stopped reporting.
    const built = buildSensor({ airQuality: { aqi: { status: "neutral", value: 42 }, pm2p5: { status: "neutral", value: 3 } } });

    await settle();

    const service = built.accessory.getService(Service.AirQualitySensor);

    assert.ok(service, "the service exists before the device goes offline");

    built.store.pushSensorPatch("test-sensor-1", { airQuality: airQualityBlock({}), state: "DISCONNECTED" });

    await settle();

    assert.equal(service.getCharacteristic(Characteristic.StatusActive).value, false, "the device is genuinely unreachable for this pass");
    assert.equal(service.testCharacteristic(Characteristic.PM2_5Density), true, "the density held through the offline window despite its metric reading quiet");
    assert.equal(service.getCharacteristic(Characteristic.PM2_5Density).value, 3, "the held density still reports the last reading");
    assert.ok(built.accessory.getService(Service.AirQualitySensor), "the service itself held too");

    built.sensor.cleanup();
  });

  test("the vape sensor appears only with all three of its conjuncts, each one falsifying on its own", () => {

    // A falsifying row per conjunct, each with the other two satisfied, so no single condition can be carrying the gate: the user's option, the controller's own vape
    // enable, and the metric actually reporting.
    const live = { vape: { status: "neutral", value: null } };
    const vapeOption = ["Enable.Sensor.Vape"];

    const cases: { config: Parameters<typeof makeSensorConfig>[0]; label: string; present: boolean; userOptions: string[] }[] = [

      { config: { airQuality: live, vapeEnabled: true }, label: "all three satisfied", present: true, userOptions: vapeOption },
      { config: { airQuality: live, vapeEnabled: true }, label: "the user's option off alone", present: false, userOptions: [] },
      { config: { airQuality: live, vapeEnabled: false }, label: "the controller's own vape enable off alone", present: false, userOptions: vapeOption },
      { config: { airQuality: {}, vapeEnabled: true }, label: "the metric not reporting alone", present: false, userOptions: vapeOption }
    ];

    for(const { config, label, present, userOptions } of cases) {

      const built = buildSensor(config, { userOptions });
      const service = built.accessory.getServiceById(Service.ContactSensor, ProtectReservedNames.CONTACT_SENSOR_VAPE);

      assert.equal(service !== undefined, present, "the vape contact sensor with " + label);

      built.sensor.cleanup();
    }
  });

  test("a reporting vape metric reading its all-clear status opens no contact and narrates nothing", async () => {

    const built = buildSensor({ airQuality: { vape: { status: "neutral", value: null } }, vapeEnabled: true }, { userOptions: ["Enable.Sensor.Vape"] });

    await settle();

    const service = built.accessory.getServiceById(Service.ContactSensor, ProtectReservedNames.CONTACT_SENSOR_VAPE);

    assert.ok(service, "the vape contact sensor exists");
    assert.equal(service.getCharacteristic(Characteristic.ContactSensorState).value, false, "the all-clear status leaves the contact closed");
    assert.equal(service.getCharacteristic(Characteristic.StatusActive).value, true, "the vape sensor carries the shared state characteristics");
    assert.equal(countLoggedAt(built.logEntries, "info", "Vaping"), 0, "a quiet first reading is saved silently rather than narrated");
    assert.ok(loggedAt(built.logEntries, "info", "vape"), "the vape label reached the enabled-sensors log");

    built.sensor.cleanup();
  });

  test("a vape detection opens the contact and logs once, while a later reconcile holding the same state logs nothing", async () => {

    const built = buildSensor({ airQuality: { vape: { status: "neutral", value: null } }, vapeEnabled: true }, { userOptions: ["Enable.Sensor.Vape"] });

    await settle();

    const service = built.accessory.getServiceById(Service.ContactSensor, ProtectReservedNames.CONTACT_SENSOR_VAPE);

    assert.ok(service, "the vape contact sensor exists");

    built.store.pushSensorPatch("test-sensor-1", { airQuality: airQualityBlock({ vape: { status: "detected", value: null } }) });

    await settle();

    assert.equal(service.getCharacteristic(Characteristic.ContactSensorState).value, true, "the detection opened the contact");
    assert.equal(countLoggedAt(built.logEntries, "info", "Vaping detected."), 1, "the transition was narrated exactly once");

    // The negative control: a reconcile driven by an unrelated field change, with the vape state unmoved. The state must not be re-narrated on every patch, and this
    // sensor sees one roughly every second and a half in the field.
    built.store.pushSensorPatch("test-sensor-1", { batteryStatus: { isLow: false, percentage: 99 } });

    await settle();

    assert.equal(countLoggedAt(built.logEntries, "info", "Vaping detected."), 1, "a reconcile that changed nothing about vaping said nothing about it");
    assert.equal(service.getCharacteristic(Characteristic.ContactSensorState).value, true, "the contact still reports the ongoing detection");

    built.sensor.cleanup();
  });

  test("a sensor already detecting at construction narrates it once, while a quiet one narrates nothing", () => {

    // The first-pass seed. A user restarting Homebridge mid-detection should be told what the sensor is reporting; one that is quiet has nothing worth a sentence.
    const detecting = buildSensor({ airQuality: { vape: { status: "detected", value: null } }, vapeEnabled: true },
      { userOptions: ["Enable.Sensor.Vape"] });

    assert.equal(countLoggedAt(detecting.logEntries, "info", "Vaping detected."), 1, "an ongoing detection at construction is narrated exactly once");

    detecting.sensor.cleanup();

    const quiet = buildSensor({ airQuality: { vape: { status: "neutral", value: null } }, vapeEnabled: true }, { userOptions: ["Enable.Sensor.Vape"] });

    assert.equal(countLoggedAt(quiet.logEntries, "info", "Vaping"), 0, "a quiet sensor at construction narrates nothing");

    quiet.sensor.cleanup();
  });

  test("a vape liveness dropout holds the contact silently, and the returning detection is not narrated twice", async () => {

    const built = buildSensor({ airQuality: { vape: { status: "detected", value: null } }, vapeEnabled: true }, { userOptions: ["Enable.Sensor.Vape"] });

    await settle();

    const service = built.accessory.getServiceById(Service.ContactSensor, ProtectReservedNames.CONTACT_SENSOR_VAPE);

    assert.ok(service, "the vape contact sensor exists");
    assert.equal(countLoggedAt(built.logEntries, "info", "Vaping detected."), 1, "the ongoing detection was narrated once at construction");

    // The metric falls to the not-capable shape. Reading that as an all-clear would tell the user vaping stopped when the sensor simply stopped answering.
    built.store.pushSensorPatch("test-sensor-1", { airQuality: airQualityBlock({}) });

    await settle();

    assert.equal(countLoggedAt(built.logEntries, "info", "Vaping no longer detected."), 0, "the dropout narrated no all-clear the sensor never reported");
    assert.equal(service.getCharacteristic(Characteristic.ContactSensorState).value, true, "the contact held its last reported state through the dropout");

    built.store.pushSensorPatch("test-sensor-1", { airQuality: airQualityBlock({ vape: { status: "detected", value: null } }) });

    await settle();

    assert.equal(countLoggedAt(built.logEntries, "info", "Vaping detected."), 1, "the returning detection was not narrated a second time - the state never changed");

    built.sensor.cleanup();
  });

  test("a cached vape sensor restored while the metric is quiet keeps its state rather than being written to an all-clear", async () => {

    // The restart-during-a-dropout case, and the one that proves the value path is gated on a LIVE reading rather than merely reading through a held state: Homebridge
    // restores the contact from its accessory cache still reporting a detection, and this process has no held state of its own yet. Writing at all here would push an
    // all-clear the sensor never sent, to HomeKit and to any MQTT subscriber, purely because the metric happened to be quiet at startup.
    const seeded = makeTestAccessory("Cached Vape Sensor", "uuid:cached-vape-sensor");
    const cached = new Service.ContactSensor("Cached Vape", ProtectReservedNames.CONTACT_SENSOR_VAPE);

    seeded.addService(cached);
    cached.updateCharacteristic(Characteristic.ContactSensorState, true);

    // The metric is NOT live, so only the gate's conservative half - an already-present service is kept - can hold this sensor in place.
    const built = buildSensor({ vapeEnabled: true }, { accessory: seeded, userOptions: ["Enable.Sensor.Vape"] });

    await settle();

    const service = seeded.getServiceById(Service.ContactSensor, ProtectReservedNames.CONTACT_SENSOR_VAPE);

    assert.ok(service, "the cached vape sensor survives a quiet metric - only the toggles remove it");
    assert.equal(service.getCharacteristic(Characteristic.ContactSensorState).value, true, "the restored detection stands; no all-clear was manufactured over it");
    assert.equal(countLoggedAt(built.logEntries, "info", "Vaping"), 0, "nothing was narrated about a metric that said nothing");
    assert.equal(built.mqtt.published.some((entry) => entry.topic === (built.projection.config.mac + "/vape")), false,
      "no vape state was published from a reading the sensor never gave");

    built.sensor.cleanup();
  });

  test("the vape bookkeeping clears with the service, so a re-enabled sensor re-seeds without narrating a stale all-clear", async () => {

    // The reset round-trip in the shape that tells a real reset from stale bookkeeping: detect, tear the service down through the controller's own vape enable, then
    // bring it back with a quiet reading. Bookkeeping that survived the teardown would read the quiet reading as a transition and wrongly announce an all-clear.
    const built = buildSensor({ airQuality: { vape: { status: "detected", value: null } }, vapeEnabled: true }, { userOptions: ["Enable.Sensor.Vape"] });

    await settle();

    assert.ok(built.accessory.getServiceById(Service.ContactSensor, ProtectReservedNames.CONTACT_SENSOR_VAPE), "the vape contact sensor exists while detecting");
    assert.equal(countLoggedAt(built.logEntries, "info", "Vaping detected."), 1, "the detection was narrated once");

    const settings = built.projection.config.airQualitySettings;

    built.store.pushSensorPatch("test-sensor-1", { airQualitySettings: { ...settings, vapeSensitivitySettings: { isEnabled: false, sensitivity: 0 } } });

    await settle();

    assert.equal(built.accessory.getServiceById(Service.ContactSensor, ProtectReservedNames.CONTACT_SENSOR_VAPE), undefined,
      "turning vape detection off on the controller removed the sensor immediately");

    built.store.pushSensorPatch("test-sensor-1", { airQuality: airQualityBlock({ vape: { status: "neutral", value: null } }),
      airQualitySettings: { ...settings, vapeSensitivitySettings: { isEnabled: true, sensitivity: 0 } } });

    await settle();

    const service = built.accessory.getServiceById(Service.ContactSensor, ProtectReservedNames.CONTACT_SENSOR_VAPE);

    assert.ok(service, "re-enabling brought the sensor back");
    assert.equal(service.getCharacteristic(Characteristic.ContactSensorState).value, false, "the returning sensor reports the quiet reading");
    assert.equal(countLoggedAt(built.logEntries, "info", "Vaping no longer detected."), 0,
      "the fresh service seeded silently - stale bookkeeping would have announced an all-clear here");

    built.sensor.cleanup();
  });

  test("carbon dioxide alerts on the controller's configured threshold, and its level moves with a pushed reading", async () => {

    // The alert answers to the number the user set in the Protect app, so HomeKit fires exactly when Protect does. The level is proven by a PUSH rather than by the
    // construction-time read alone, which is what shows the reconcile keeps it current.
    const built = buildSensor({ airQuality: { co2: { status: "neutral", value: 800 } }, co2Enabled: true, co2Threshold: 1000 });

    await settle();

    const service = built.accessory.getService(Service.CarbonDioxideSensor);

    assert.ok(service, "a reporting carbon dioxide metric materializes the CarbonDioxideSensor service");
    assert.equal(service.getCharacteristic(Characteristic.CarbonDioxideDetected).value, false, "a reading below the configured threshold is not an alert");
    assert.equal(service.getCharacteristic(Characteristic.CarbonDioxideLevel).value, 800, "the level carries the reading");
    assert.equal(service.getCharacteristic(Characteristic.StatusActive).value, true, "the carbon dioxide service carries the shared state characteristics");
    assert.ok(loggedAt(built.logEntries, "info", "carbon dioxide"), "the carbon dioxide label reached the enabled-sensors log");

    built.store.pushSensorPatch("test-sensor-1", { airQuality: airQualityBlock({ co2: { status: "neutral", value: 1200 } }) });

    await settle();

    assert.equal(service.getCharacteristic(Characteristic.CarbonDioxideDetected).value, true, "crossing the configured threshold raised the alert");
    assert.equal(service.getCharacteristic(Characteristic.CarbonDioxideLevel).value, 1200, "the level moved with the pushed reading");

    built.sensor.cleanup();
  });

  test("the air-quality threshold fixture mints the nullable, margin-less shape and lands its carbon dioxide overrides", () => {

    // The air-quality thresholds are a DIFFERENT shape from the record's top-level environmental thresholds, which carry a margin and no nulls. The two are
    // structurally assignable to each other, so only a shape assertion catches a fixture that reached for the wrong helper.
    const defaults = makeSensorConfig();

    assert.deepEqual(defaults.airQualitySettings.co2Settings, { highThreshold: null, isEnabled: false, lowThreshold: null },
      "the air-quality threshold defaults are nullable and carry no margin key");
    assert.equal("margin" in defaults.airQualitySettings.co2Settings, false, "the margin key belongs to the top-level environmental thresholds, not these");
    assert.deepEqual(defaults.airQualitySettings.vapeSettings, { highThreshold: null, isEnabled: false, lowThreshold: null },
      "every metric carries a threshold member, vape included");
    assert.deepEqual(defaults.airQualitySettings.vocSettings, { highThreshold: null, isEnabled: false, lowThreshold: null },
      "every metric carries a threshold member, voc included");
    assert.equal(defaults.airQualitySettings.vapeSensitivitySettings.isEnabled, false, "the controller's vape detection defaults off");
    assert.deepEqual(defaults.airQuality.aqi, { status: "unknown", value: null }, "every metric defaults to the not-capable shape");

    const configured = makeSensorConfig({ co2Enabled: true, co2Threshold: 1000, vapeEnabled: true });

    assert.deepEqual(configured.airQualitySettings.co2Settings, { highThreshold: 1000, isEnabled: true, lowThreshold: null }, "the carbon dioxide overrides land");
    assert.equal(configured.airQualitySettings.vapeSensitivitySettings.isEnabled, true, "the vape enable override lands");
  });

  test("an air-quality patch reaches the characteristics through the existing sensor.config wake, adding no observer of its own", async () => {

    const built = buildSensor({ airQuality: { aqi: { status: "neutral", value: 42 } } });

    await settle();

    const service = built.accessory.getService(Service.AirQualitySensor);

    assert.ok(service, "the service exists before the patch");
    assert.equal(built.store.observerCount, 6, "the air-quality surface added no observer - it rides the reconcile the whole-record observer already drives");

    const baseline = wakeLog.length;

    built.store.pushSensorPatch("test-sensor-1", { airQuality: airQualityBlock({ aqi: { status: "neutral", value: 175 } }) });

    await settle();

    assert.deepEqual(wakeLog.slice(baseline), [{ accessoryId: built.accessory.UUID, key: "sensor.config" }],
      "an air-quality patch wakes the whole-record observer alone, exactly as every other settings change does");
    assert.equal(service.getCharacteristic(Characteristic.AirQuality).value, 4, "the pushed index of 175 mapped to inferior");

    built.sensor.cleanup();
  });

  test("the airquality topic carries the curated twelve-metric JSON, published on capability alone", async () => {

    // MQTT is the full-fidelity surface: it publishes whenever the sensor reports anything, whatever set of HomeKit services the accessory materializes, because the
    // metrics HomeKit cannot model - the VOC index, NOx, vape, and the finer particulate sizes - reach a user only here.
    const built = buildSensor({ airQuality: { aqi: { status: "neutral", value: 42 }, voc: { status: "neutral", value: 68 } } });
    const mac = built.projection.config.mac;

    await settle();

    const published = built.mqtt.published.find((entry) => entry.topic === (mac + "/airquality"));

    assert.ok(published, "the telemetry published on the device-scoped topic");

    const payload = JSON.parse(published.message) as Record<string, { status: string; value: Nullable<number> }>;

    assert.deepEqual(Object.keys(payload).sort(), [ "aqi", "co2", "humidity", "nox", "pm10p0", "pm1p0", "pm2p5", "pm4p0", "temperature", "tvoc", "vape", "voc" ].sort(),
      "the payload carries exactly the twelve metrics we document and nothing else");
    assert.deepEqual(payload["aqi"], { status: "neutral", value: 42 }, "each metric carries its status and value");
    assert.deepEqual(payload["voc"], { status: "neutral", value: 68 }, "the VOC index rides MQTT, having no HomeKit service to live on");
    assert.deepEqual(payload["nox"], { status: "unknown", value: null }, "a metric the sensor does not measure reports null rather than being dropped");

    const airQualityGet = built.mqtt.subscriptions.find((subscription) => (subscription.kind === "get") && (subscription.topic === (mac + "/airquality")));

    assert.ok(airQualityGet?.getValue, "the airquality GET registered");
    assert.equal(airQualityGet.getValue(), published.message, "the GET answers with the same curated payload the publish carries");

    built.sensor.cleanup();

    // The capability gate's negative control: a sensor with no air-quality hardware publishes nothing at all on the topic.
    const quiet = buildSensor();

    await settle();

    assert.equal(quiet.mqtt.published.some((entry) => entry.topic === (quiet.projection.config.mac + "/airquality")), false,
      "a sensor with no air-quality hardware never publishes the telemetry topic");

    quiet.sensor.cleanup();
  });

  test("the vape topic carries the boolean state through both the publish and the GET", async () => {

    const built = buildSensor({ airQuality: { vape: { status: "neutral", value: null } }, vapeEnabled: true }, { userOptions: ["Enable.Sensor.Vape"] });
    const mac = built.projection.config.mac;
    const vapeGet = built.mqtt.subscriptions.find((subscription) => (subscription.kind === "get") && (subscription.topic === (mac + "/vape")));

    await settle();

    assert.ok(vapeGet?.getValue, "the vape GET registered");
    assert.equal(vapeGet.getValue(), "false", "the GET reads through the vape state, clear at start");
    assert.ok(built.mqtt.published.some((entry) => (entry.topic === (mac + "/vape")) && (entry.message === "false")), "the quiet state published");

    built.store.pushSensorPatch("test-sensor-1", { airQuality: airQualityBlock({ vape: { status: "detected", value: null } }) });

    await settle();

    assert.equal(vapeGet.getValue(), "true", "the GET reads through the detection");
    assert.ok(built.mqtt.published.some((entry) => (entry.topic === (mac + "/vape")) && (entry.message === "true")), "the detection published");

    built.sensor.cleanup();
  });

  test("air-quality hardware lands its temperature and humidity in HomeKit with no toggle and no option", async () => {

    // The delivered feature, on a fixture shaped like the field: a UP Air Quality unit reports temperature and humidity through its air-quality telemetry while both
    // top-level threshold toggles read false and the stats block stays at the not-capable signature. Both services must materialize on the readings alone.
    const built = buildSensor({ airQuality: { humidity: { status: "neutral", value: 50.25 }, temperature: { status: "neutral", value: 23.92 } } });
    const mac = built.projection.config.mac;

    await settle();

    const humidity = built.accessory.getService(Service.HumiditySensor);
    const temperature = built.accessory.getService(Service.TemperatureSensor);

    assert.ok(humidity, "the air-quality humidity reading materialized the HumiditySensor with the top-level toggle off");
    assert.ok(temperature, "the air-quality temperature reading materialized the TemperatureSensor with the top-level toggle off");
    assert.equal(humidity.getCharacteristic(Characteristic.CurrentRelativeHumidity).value, 50.25, "CurrentRelativeHumidity carries the air-quality reading");
    assert.equal(temperature.getCharacteristic(Characteristic.CurrentTemperature).value, 23.92, "CurrentTemperature carries the air-quality reading");
    assert.equal(await humidity.getCharacteristic(Characteristic.CurrentRelativeHumidity).triggerGet(), 50.25, "the humidity onGet reads through the same source");
    assert.equal(await temperature.getCharacteristic(Characteristic.CurrentTemperature).triggerGet(), 23.92, "the temperature onGet reads through the same source");
    assert.ok(built.mqtt.published.some((entry) => (entry.topic === (mac + "/humidity")) && (entry.message === "50.25")), "the humidity reading published");
    assert.ok(built.mqtt.published.some((entry) => (entry.topic === (mac + "/temperature")) && (entry.message === "23.92")), "the temperature reading published");

    built.sensor.cleanup();
  });

  test("a live-but-null environmental reading holds the characteristic and publishes nothing", async () => {

    // The dropout. A metric that keeps its status but loses its number is still reporting, so the service stands and HomeKit keeps the last thing the sensor said - and
    // no subscriber is told a dropout was a reading. The write log, not the cached value, is what proves nothing was written: a re-write of the same number would be
    // invisible in the value alone.
    const built = buildSensor({ airQuality: { humidity: { status: "neutral", value: 50.25 } } });
    const mac = built.projection.config.mac;

    await settle();

    const humidity = built.accessory.getService(Service.HumiditySensor);

    assert.ok(humidity, "the service exists before the dropout");

    const writeBaseline = humidity.getCharacteristic(Characteristic.CurrentRelativeHumidity).writes.length;
    const publishBaseline = built.mqtt.published.filter((entry) => entry.topic === (mac + "/humidity")).length;

    built.store.pushSensorPatch("test-sensor-1", { airQuality: airQualityBlock({ humidity: { status: "neutral", value: null } }) });

    await settle();

    assert.ok(built.accessory.getService(Service.HumiditySensor), "a live-but-null reading holds the service");
    assert.equal(humidity.getCharacteristic(Characteristic.CurrentRelativeHumidity).value, 50.25, "the characteristic still reports the last reading the sensor gave");
    assert.equal(humidity.getCharacteristic(Characteristic.CurrentRelativeHumidity).writes.length, writeBaseline, "the hold wrote nothing at all");
    assert.equal(await humidity.getCharacteristic(Characteristic.CurrentRelativeHumidity).triggerGet(), 50.25, "a pull during the hold answers with the held reading");
    assert.equal(built.mqtt.published.filter((entry) => entry.topic === (mac + "/humidity")).length, publishBaseline, "nothing was published during the hold");

    built.sensor.cleanup();
  });

  test("turning a measurement off and back on in the Protect app takes the service away and brings it back", async () => {

    // The realtime requirement, in both directions - the air-quality twin of the USL toggle transition. A measurement the user disables in the Protect app arrives as
    // the not-capable signature on a device we can plainly see, which is what sheds the service; re-enabling it brings the service back with a fresh reading rather
    // than leaving it dead until a restart.
    const built = buildSensor({ airQuality: { humidity: { status: "neutral", value: 50.25 } } });

    await settle();

    assert.ok(built.accessory.getService(Service.HumiditySensor), "the reporting measurement carries the service");

    built.store.pushSensorPatch("test-sensor-1", { airQuality: airQualityBlock({}) });

    await settle();

    assert.equal(built.accessory.getService(Service.HumiditySensor), undefined, "the measurement reading the off signature took the service away on that pass");

    built.store.pushSensorPatch("test-sensor-1", { airQuality: airQualityBlock({ humidity: { status: "neutral", value: 58.65 } }) });

    await settle();

    const humidity = built.accessory.getService(Service.HumiditySensor);

    assert.ok(humidity, "re-enabling the measurement brought the service back");
    assert.equal(humidity.getCharacteristic(Characteristic.CurrentRelativeHumidity).value, 58.65, "the returning service carries the fresh reading");

    built.sensor.cleanup();
  });

  test("the humidity and temperature MQTT gets always answer, with the no-reading stand-in when no source reports", () => {

    // The get contract is unconditional: a subscriber asking an all-quiet sensor still gets an answer, and the stand-in tells it apart from a real reading.
    const mac = projection.config.mac;
    const humidityGet = mqtt.subscriptions.find((subscription) => (subscription.kind === "get") && (subscription.topic === (mac + "/humidity")));
    const temperatureGet = mqtt.subscriptions.find((subscription) => (subscription.kind === "get") && (subscription.topic === (mac + "/temperature")));

    assert.ok(humidityGet?.getValue, "the humidity GET registered on an all-quiet sensor");
    assert.ok(temperatureGet?.getValue, "the temperature GET registered on an all-quiet sensor");
    assert.equal(humidityGet.getValue(), "-1", "the humidity GET answers the no-reading stand-in rather than staying silent");
    assert.equal(temperatureGet.getValue(), "-1", "the temperature GET answers the no-reading stand-in rather than staying silent");
  });

  test("a fully-reporting air-quality sensor logs every one of its services in the enabled-sensors line, in order", async () => {

    // The whole air-quality family live at once, which is what a UP Air Quality unit looks like in the field. This pins the single rendered log line - its exact
    // membership and its order - and, with temperature and humidity now materializing on this hardware, it also exercises the shared state characteristics on the two
    // services that newly reach them.
    const built = buildSensor({ airQuality: { aqi: { status: "neutral", value: 42 }, co2: { status: "neutral", value: 800 },
      humidity: { status: "neutral", value: 50.25 }, temperature: { status: "neutral", value: 23.92 }, vape: { status: "neutral", value: null } }, vapeEnabled: true },
    { userOptions: ["Enable.Sensor.Vape"] });

    await settle();

    assert.ok(loggedAt(built.logEntries, "info", "Enabled sensors: air quality, carbon dioxide, humidity, temperature, vape."),
      "every service the sensor grew reached the enabled-sensors line, in the order updateDevice configures them");

    const humidity = built.accessory.getService(Service.HumiditySensor);
    const temperature = built.accessory.getService(Service.TemperatureSensor);

    assert.ok(humidity, "the humidity service exists");
    assert.ok(temperature, "the temperature service exists");
    assert.equal(humidity.getCharacteristic(Characteristic.StatusActive).value, true, "the humidity service carries the shared state characteristics");
    assert.equal(temperature.getCharacteristic(Characteristic.StatusActive).value, true, "the temperature service carries the shared state characteristics");
    assert.equal(humidity.getCharacteristic(Characteristic.StatusTampered).value, false, "the humidity service carries the tamper read-through too");

    built.sensor.cleanup();
  });
});
