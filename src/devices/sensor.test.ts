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
 * exactly like the light's lastMotion; the tamperingDetectedAt fan-out across every state-bearing service; the per-row alarm-family pushes, alarmTriggeredAt to the
 * alarm-sound contact and glassBreakTriggeredAt to the glass-break contact; the whole-record sensor.config reconcile); the GET MQTT subscriptions, the ambient light and
 * vape gets present only under their feature options, plus the model-aware leak GETs (registered per-channel, present-iff-enabled, once-guarded, and unsubscribed when
 * a channel is toggled off).
 *
 * The multi-wake: the whole-record observer (sensor.config) selects the WHOLE sensor record (client.state.selectors.sensor.byId(id)), and pushSensorPatch replaces it on
 * every patch that changes the record (a value-identical patch is a reducer no-op and wakes nothing at all), so sensor.config wakes on every such push - in ADDITION
 * to any narrow observer (sensor.motionDetectedAt / sensor.tamperingDetectedAt / sensor.alarmTriggeredAt / sensor.glassBreakTriggeredAt)
 * whose field changed. So a narrow-field push wakes exactly the changed narrow observer plus sensor.config, in registration order (the narrow observer precedes config):
 * a motionDetectedAt push wakes [sensor.motionDetectedAt, sensor.config] and a tamperingDetectedAt push wakes [sensor.tamperingDetectedAt, sensor.config], while each
 * alarm-family field wakes its own row's observer and sensor.config, and a settings-only push wakes sensor.config alone. The full registration order is device.name,
 * device.firmwareVersion, sensor.motionDetectedAt, sensor.tamperingDetectedAt, sensor.alarmTriggeredAt, sensor.glassBreakTriggeredAt, sensor.config, but a narrow push
 * never wakes the base observers or the unchanged narrow observer. A single-observer expectation would be wrong; every wake assertion is the registration-ordered set
 * including the accessoryId per payload.
 *
 * The falsy-motionDetectedAt case is a TWO-STEP: the carrier defaults motionDetectedAt to 0, so a bare 0 push is no change (no wake). We first push a truthy timestamp
 * (settle, snapshot+reset the wake window AND a recording baseline), THEN push 0 - the truthy->0 change genuinely wakes the observer while the production
 * if(motionDetectedAt) guard, not a dead observer, suppresses the firehose delivery (the light's falsy-motion non-vacuity, adapted).
 *
 * The isolation model mirrors the light reference: a beforeEach builds a fresh sensor so the recording calls, the characteristic state, the observer baselines, and
 * store.observerCount are clean every test, the wake log is windowed per push via a captured baseline, and an afterEach unwinds the sensor's per-accessory abort.
 */
import { Characteristic, Service, TestStateStore, makeProtectState, makeTestAccessory } from "../testing.helpers.ts";
import type { CharacteristicType, TestAccessory } from "../testing.helpers.ts";
import { ProtectSensor, narratesTransition } from "./sensor.ts";
import type { ProtectSensorAirQuality, Sensor } from "unifi-protect";
import type { TestLogEntry, TestMqttClient } from "homebridge-plugin-utils/testing";
import { TestRecordingDispatch, makeTestNvr } from "../nvr/testing.helpers.ts";
import { TestSensorProjection, makeSensorConfig, makeSmokeStatus } from "./testing.helpers.ts";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import { logCount, loggedAt, settle } from "homebridge-plugin-utils/testing";
import { NOT_CAPABLE_AIR_QUALITY } from "./air-quality-policy.ts";
import type { Nullable } from "homebridge-plugin-utils";
import type { ObserverWakePayload } from "../diagnostics.ts";
import type { ProtectAccessory } from "../types.ts";
import type { ProtectEventDispatch } from "../nvr/event-dispatch.ts";
import type { ProtectNvr } from "../nvr/nvr.ts";
import { ProtectReservedNames } from "../types.ts";
import assert from "node:assert/strict";
import diagnosticsChannel from "node:diagnostics_channel";

// The MAC-scoped tail the plugin composed, with the /get or /set suffix the MQTT client appends taken back off. These rows assert what the plugin addressed,
// which is the tail rather than the child topic the registration lands on.
const composedTail = (topic: string): string => topic.replace(/\/(get|set)$/, "");

// A full block of air-quality readings, quiet except the metrics a case names - the shape the controller always sends, where every metric is present whether or not the
// hardware measures it. Air-quality patches carry the WHOLE block, matching how this suite pushes every other nested settings object.
function airQualityBlock(overrides: Partial<ProtectSensorAirQuality>): ProtectSensorAirQuality {

  return { ...NOT_CAPABLE_AIR_QUALITY, ...overrides };
}

// The device-scoped topic tails the smoke detector owns. Rows proving a sensor that is no detector publishes nothing at all read the whole set through here rather
// than spelling each one out; the comparisons are exact, so the smoke tail never matches the detector-status one.
const SMOKE_TOPIC_TAILS = [ "/carbonmonoxide", "/smoke", "/smokedetector" ];

// Every harness controller this suite opens, drained in afterEach so the controller lifetime signal bounds each test's constructions rather than the file's. The builder
// is the single push site, so the many per-test variant builds are captured exactly as the fixture's is.
const controllers: AbortController[] = [];

// The reusable construction helper: build a REAL ProtectSensor against the harness doubles, with the recording dispatch injected through the NVR double's
// dispatch-injection point so the motionDetectedAt observer's firehose routing is asserted against the REAL ProtectEventDispatch contract (the recording subclass arms no
// reset timer). The casts are confined to where the class is constructed exactly as the light / chime suites do; the instance under test is the production class,
// running its real configureHints / configureDevice / spawnObservers paths. The accessory factory is injectable so the moisture mode-flip test can pre-seed a LeakSensor
// before construction. The injected recording dispatch is read off nvr.events after construction rather than captured from the factory closure - reading it back avoids
// both the assignment-expression smell and a TS2454 definite-assignment error on a factory-captured binding.
function buildSensor(configOptions: Parameters<typeof makeSensorConfig>[0] = {},
  harnessOptions: { accessory?: TestAccessory; disconnected?: boolean; userOptions?: string[] } = {}): {
  accessory: TestAccessory; logEntries: readonly TestLogEntry[]; mqtt: TestMqttClient; projection: TestSensorProjection; recording: TestRecordingDispatch;
  sensor: ProtectSensor; store: TestStateStore;
} {

  const sensorConfig = makeSensorConfig(configOptions);
  const store = new TestStateStore(makeProtectState({ sensors: [sensorConfig] }));
  const { controller, logEntries, mqtt, nvr } = makeTestNvr({ dispatch: (innerNvr: ProtectNvr): ProtectEventDispatch => new TestRecordingDispatch(innerNvr), mqtt: true,
    store, userOptions: harnessOptions.userOptions });

  controllers.push(controller);

  // A disconnected double is the production startup shape: the sensor is built before the broker acknowledges the first session.
  if(mqtt && harnessOptions.disconnected) {

    mqtt.connected = false;
  }

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
  let logEntries: readonly TestLogEntry[];
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

  test("seven observers register, construction wakes none, and the always-present Battery service carries its battery state", () => {

    assert.equal(store.observerCount, 7, "the two base observers plus the sensor's five are registered against the store double");
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

  test("cleanup unwinds all seven observers, and a value-changing push afterward wakes nothing", async () => {

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
    assert.ok(built.mqtt.published.some((entry) => (entry.topic === built.projection.config.mac + "/alarm") && (entry.payload === "true")),
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
    assert.ok(built.mqtt.published.some((entry) => (entry.topic === (mac + "/humidity")) && (entry.payload === "47.5")),
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
    assert.ok(built.mqtt.published.some((entry) => (entry.topic === (mac + "/temperature")) && (entry.payload === "18.25")), "the first reading published too");

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

  test("the leak narration speaks a condition already under way, then each edge once, and reads the moisture wording in moisture mode", async () => {

    // The transition-narration contract every logged sensor condition shares, characterized on the leak site: a leak already under way when the service first
    // materializes is spoken, each genuine edge is spoken once, and a reconcile that moved nothing about the leak says nothing about it. The moisture option changes
    // only the subject word, never the shape of the sentence.
    const built = buildSensor({ leakChannelNames: ["internal"], leakDetectedAt: 1700000000000, mountType: "leak" });

    await settle();

    assert.equal(logCount(built.logEntries, "info", "Leak detected."), 1, "a leak already under way at construction is narrated exactly once");

    built.store.pushSensorPatch("test-sensor-1", { leakDetectedAt: null });

    await settle();

    assert.equal(logCount(built.logEntries, "info", "Leak no longer detected."), 1, "the clearing edge is narrated exactly once");

    // The negative control, driven by an unrelated field change so a reconcile genuinely runs with the leak unmoved. A value-identical push is a no-op in the
    // controller's own reducer and would wake nothing at all, which would leave this row asserting against a pass that never happened.
    built.store.pushSensorPatch("test-sensor-1", { batteryStatus: { isLow: false, modelKey: "sensorBatteryStatus", percentage: 99 } });

    await settle();

    assert.equal(logCount(built.logEntries, "info", "Leak no longer detected."), 1, "a reconcile that changed nothing about the leak said nothing about it");
    assert.equal(logCount(built.logEntries, "info", "Leak detected."), 1, "the detection sentence never fired a second time either");

    built.sensor.cleanup();

    const moisture = buildSensor({ leakChannelNames: ["internal"], leakDetectedAt: 1700000000000, mountType: "leak" },
      { userOptions: ["Enable.Sensor.MoistureSensor"] });

    await settle();

    assert.equal(logCount(moisture.logEntries, "info", "Moisture detected."), 1, "moisture mode narrates the same first-run edge under its own subject word");
    assert.equal(logCount(moisture.logEntries, "info", "Leak detected."), 0, "moisture mode never speaks the leak wording");

    moisture.sensor.cleanup();
  });

  test("a truthy motionDetectedAt push wakes the motionDetectedAt and sensor.config observers and routes to the dispatch firehose once", async () => {

    const baseline = wakeLog.length;

    // A fixed truthy timestamp literal, so the push is deterministic.
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

    // Build with two enabled state-bearing services (humidity + temperature) so the tamper observer's sweep is non-vacuous - it must write more than one service.
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

  test("the six default GET MQTT subscriptions compose the device-MAC-scoped topic tails, and the default no-leak sensor registers NEITHER leak GET", () => {

    // The default carrier advertises no water-leak channels (channelNames []), so the leak-policy leaf gates both leak channels off and the per-channel MQTT fold-in
    // registers NEITHER leak GET. The ambient light GET registers under its default-on feature option, and the other sensor GETs here are registered unconditionally
    // in configureMqtt, including every alarm-family get (alarm sound and glass break) whether or not its service exists.
    const tails = mqtt.subscriptions.filter((subscription) => subscription.kind === "get").map((subscription) => composedTail(subscription.topic));
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
    const singleTails = single.mqtt.subscriptions.filter((subscription) => subscription.kind === "get").map((subscription) => composedTail(subscription.topic));
    const singleMac = single.projection.config.mac;

    assert.ok(singleTails.includes(singleMac + "/leak"), "a single-channel mount-role sensor registers the internal leak GET");
    assert.equal(singleTails.includes(singleMac + "/leak-external"), false, "a single-channel sensor never registers the external leak GET (channel not advertised)");

    single.sensor.cleanup();

    // Single-channel mount role OFF (the stuck-flag bug case): neither leak GET registers even though the stuck internal flag is true.
    const disabled = buildSensor({ leakChannelNames: ["internal"], leakInternalEnabled: true, mountType: "none" });
    const disabledTails = disabled.mqtt.subscriptions.filter((subscription) => subscription.kind === "get").map((subscription) => composedTail(subscription.topic));
    const disabledMac = disabled.projection.config.mac;

    assert.equal(disabledTails.includes(disabledMac + "/leak"), false,
      "a single-channel sensor with mountType none registers no internal leak GET despite the stuck flag");

    disabled.sensor.cleanup();

    // Multi-channel with the external flag on: the external leak GET registers.
    const multi = buildSensor({ leakChannelNames: [ "internal", "external" ], leakExternalEnabled: true, leakInternalEnabled: true });
    const multiTails = multi.mqtt.subscriptions.filter((subscription) => subscription.kind === "get").map((subscription) => composedTail(subscription.topic));
    const multiMac = multi.projection.config.mac;

    assert.ok(multiTails.includes(multiMac + "/leak"), "a multi-channel sensor with the internal flag on registers the internal leak GET");
    assert.ok(multiTails.includes(multiMac + "/leak-external"), "a multi-channel sensor with the external flag on registers the external leak GET");

    multi.sensor.cleanup();
  });

  test("re-running the reconcile does not register a second leak GET handler (the once-guard holds across config churn)", async () => {

    // subscribeGet accumulates a handler on every call rather than replacing one (homebridge-plugin-utils), so the leak GET registration is once-guarded behind
    // initialized. A re-run of updateDevice - driven here by a non-leak config push that wakes the whole-record sensor.config observer - must NOT register a second
    // leak GET. The TestMqttClient records every subscribeGet, so a duplicate is directly countable.
    const built = buildSensor({ leakChannelNames: ["internal"], mountType: "leak" });
    const mac = built.projection.config.mac;
    const leakGetCount = (): number => {

      return built.mqtt.subscriptions.filter((subscription) => (subscription.kind === "get") && (subscription.topic === mac + "/leak/get")).length;
    };

    await settle();

    assert.equal(leakGetCount(), 1, "the internal leak GET registered exactly once at construction");

    // A settings-only push wakes the whole-record sensor.config observer, which re-runs updateDevice with initialized true. The once-guard must suppress a second
    // registration.
    built.store.pushSensorPatch("test-sensor-1", { temperatureSettings: { highThreshold: 0, isEnabled: true, lowThreshold: 0, margin: 0 } });

    await settle();

    assert.equal(leakGetCount(), 1, "the re-run did NOT register a second internal leak GET - the initialized once-guard holds");

    built.sensor.cleanup();
  });

  test("a leak sensor restored from the accessory cache registers its channel's GET at construction", async () => {

    // The restart case: Homebridge restores the leak sensor from its accessory cache, so the gate keeps the service rather than attaching it. Construction is the first
    // configure pass, so it registers the channel's GET whether the gate keeps the service or attaches it...a construction that ran as a later pass would register
    // nothing for a kept channel, and the restored sensor would answer no MQTT get.
    const seeded = makeTestAccessory("Cached Leak Sensor", "uuid:cached-leak-sensor");
    const cached = new Service.LeakSensor("Cached Leak", ProtectReservedNames.LEAKSENSOR_INTERNAL);

    seeded.addService(cached);

    const built = buildSensor({ leakChannelNames: ["internal"], mountType: "leak" }, { accessory: seeded });
    const mac = built.projection.config.mac;

    await settle();

    assert.equal(seeded.getServiceById(Service.LeakSensor, ProtectReservedNames.LEAKSENSOR_INTERNAL), cached,
      "the gate kept the restored leak sensor rather than building a new one");
    assert.equal(built.mqtt.subscriptions.filter((subscription) => (subscription.kind === "get") && (subscription.topic === mac + "/leak/get")).length, 1,
      "the restored channel registered its leak GET once, at construction");

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

    // Push the external flag back ON. The leak-policy leaf re-enables the channel, and the attached transition its gate answers re-registers its GET rather than leaving
    // it dead until a restart. The untouched internal channel must NOT re-register - its own gate answers kept, and a pass-wide reset shared across the loop would leak
    // into the sibling and double-register its GET.
    const mac = built.projection.config.mac;
    const externalGets = (): number => built.mqtt.subscriptions.filter((entry) => (entry.kind === "get") && (entry.topic === (mac + "/leak-external/get"))).length;
    const internalGets = (): number => built.mqtt.subscriptions.filter((entry) => (entry.kind === "get") && (entry.topic === (mac + "/leak/get"))).length;
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

  test("a captured GET handler reads through the live config value", async () => {

    // Build a temperature-enabled sensor with a present stat, then invoke the captured temperature GET handler directly - the path the production subscribeGet handler
    // takes that the HomeKit onGet machinery does not exercise - and assert the string value the MQTT layer would publish.
    const built = buildSensor({ temperature: 19, temperatureEnabled: true });
    const mac = built.projection.config.mac;
    const temperatureGet = built.mqtt.subscriptions.find((subscription) => (subscription.kind === "get") && (subscription.topic === mac + "/temperature/get"));
    const contactGet = built.mqtt.subscriptions.find((subscription) => (subscription.kind === "get") && (subscription.topic === mac + "/contact/get"));

    assert.ok(temperatureGet, "the temperature GET subscription is registered");
    assert.equal(await built.mqtt.invokeGet(mac + "/temperature/get"), "19", "the temperature GET handler reads through the live stat value as a string");
    assert.ok(contactGet, "the contact GET subscription is registered");
    assert.equal(await built.mqtt.invokeGet(mac + "/contact/get"), "false", "the contact GET handler reads through isOpened ?? false as a string");

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

  test("a glass-break device lands the glassBreakTriggeredAt value and logs the transition exactly once on each edge", async () => {

    const built = buildSensor({ glassBreak: true, glassBreakEnabled: true });

    await settle();

    const glass = built.accessory.getServiceById(Service.ContactSensor, ProtectReservedNames.CONTACT_SENSOR_GLASS_BREAK);

    assert.ok(glass, "the glass-break ContactSensor exists");
    assert.equal(glass.getCharacteristic(Characteristic.ContactSensorState).value, false, "the glass-break sensor starts clear (glassBreakTriggeredAt null)");

    built.store.pushSensorPatch("test-sensor-1", { glassBreakTriggeredAt: 1700000000000 });

    await settle();

    assert.equal(glass.getCharacteristic(Characteristic.ContactSensorState).value, true,
      "the non-null glassBreakTriggeredAt landed on the glass-break ContactSensorState");
    assert.equal(logCount(built.logEntries, "info", "Glass break detected."), 1, "the detection logged the Glass-break transition exactly once");

    built.store.pushSensorPatch("test-sensor-1", { glassBreakTriggeredAt: null });

    await settle();

    assert.equal(glass.getCharacteristic(Characteristic.ContactSensorState).value, false, "clearing glassBreakTriggeredAt cleared the glass-break ContactSensorState");
    assert.equal(logCount(built.logEntries, "info", "Glass break no longer detected."), 1, "the clear logged the Glass-break transition exactly once");

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
    assert.equal(logCount(built.logEntries, "info", "Alarm detected."), 1, "the detection logged the Alarm transition exactly once with the alarm-sound label");

    built.store.pushSensorPatch("test-sensor-1", { alarmTriggeredAt: null });

    await settle();

    assert.equal(alarm.getCharacteristic(Characteristic.ContactSensorState).value, false, "clearing alarmTriggeredAt cleared the alarm-sound ContactSensorState");
    assert.equal(logCount(built.logEntries, "info", "Alarm no longer detected."), 1, "the clear logged the Alarm transition exactly once");

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

    built.store.pushSensorPatch("test-sensor-1", { glassBreakTriggeredAt: 1700000000000 });

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

    built.store.pushSensorPatch("test-sensor-1", { glassBreakTriggeredAt: 1700000000000 });

    await settle();

    assert.equal(glass.getCharacteristic(Characteristic.ContactSensorState).value, true, "a subsequent alarm value landed on the newly-created glass-break service");

    built.sensor.cleanup();
  });

  test("an alarm-sound contact restored from the accessory cache answers a pull from the live alarm state on the first pass", async () => {

    // The restart case: Homebridge restores the contact from its accessory cache with no handlers and a detection the controller has since cleared, so the gate keeps
    // the service rather than attaching it. Construction is the first configure pass, so it binds the read-through and seeds the value whatever the gate answers...a
    // construction that ran as a later pass would bind nothing on a kept service, and the pull would answer the stale cached detection.
    const seeded = makeTestAccessory("Cached Alarm Sensor", "uuid:cached-alarm-sensor");
    const cached = new Service.ContactSensor("Cached Alarm Sound", ProtectReservedNames.CONTACT_SENSOR_ALARM_SOUND);

    seeded.addService(cached);
    cached.updateCharacteristic(Characteristic.ContactSensorState, true);

    const built = buildSensor({ alarmEnabled: true }, { accessory: seeded });

    await settle();

    assert.equal(seeded.getServiceById(Service.ContactSensor, ProtectReservedNames.CONTACT_SENSOR_ALARM_SOUND), cached,
      "the gate kept the restored contact rather than building a new one");
    assert.equal(await cached.getCharacteristic(Characteristic.ContactSensorState).triggerGet(), false, "a pull answers the live clear state, not the cached detection");

    // Overwrite the cached value once more, so only a bound read-through, and not the seed write alone, can answer the live state.
    cached.getCharacteristic(Characteristic.ContactSensorState).updateValue(true);

    assert.equal(await cached.getCharacteristic(Characteristic.ContactSensorState).triggerGet(), false,
      "the read-through answers the live clear state over a re-planted cached detection");

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
    const latched = buildSensor({ glassBreak: true, glassBreakEnabled: true, glassBreakTriggeredAt: 1700000000000 });
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

    built.store.pushSensorPatch("test-sensor-1", { glassBreakTriggeredAt: 1700000000000 });

    await settle();

    assert.equal(glass.getCharacteristic(Characteristic.ContactSensorState).value, true, "first edge: detected");

    built.store.pushSensorPatch("test-sensor-1", { glassBreakTriggeredAt: null });

    await settle();

    assert.equal(glass.getCharacteristic(Characteristic.ContactSensorState).value, false, "second edge: cleared");

    built.store.pushSensorPatch("test-sensor-1", { glassBreakTriggeredAt: 1700000005000 });

    await settle();

    assert.equal(glass.getCharacteristic(Characteristic.ContactSensorState).value, true, "third edge: re-detected on a distinct timestamp");
    assert.equal(logCount(built.logEntries, "info", "Glass break detected."), 2, "each detection edge logged exactly once (two detections)");
    assert.equal(logCount(built.logEntries, "info", "Glass break no longer detected."), 1, "the single clear edge logged exactly once");

    built.sensor.cleanup();
  });

  test("the glass-break contact reads its own latched field and ignores the shared one", async () => {

    // The field the owner's unit actually moved on a real detection. A glass break advances glassBreakTriggeredAt while alarmTriggeredAt keeps whatever alarmed last, so
    // the glass-break contact must be deaf to the shared field and answer only to its own.
    const built = buildSensor({ glassBreak: true, glassBreakEnabled: true });

    await settle();

    const glass = built.accessory.getServiceById(Service.ContactSensor, ProtectReservedNames.CONTACT_SENSOR_GLASS_BREAK);

    assert.ok(glass, "the glass-break service exists");

    built.store.pushSensorPatch("test-sensor-1", { alarmTriggeredAt: 1700000000000 });

    await settle();

    assert.equal(glass.getCharacteristic(Characteristic.ContactSensorState).value, false, "a bare shared-field push left the glass-break ContactSensorState clear");
    assert.equal(logCount(built.logEntries, "info", "Glass break detected."), 0, "a bare shared-field push narrated no glass-break detection");
    assert.equal(built.mqtt.published.filter((entry) => entry.topic === built.projection.config.mac + "/glassbreak").length, 1,
      "a bare shared-field push published nothing beyond the create-time seed on the glassbreak topic");

    built.store.pushSensorPatch("test-sensor-1", { glassBreakTriggeredAt: 1700000000000 });

    await settle();

    assert.equal(glass.getCharacteristic(Characteristic.ContactSensorState).value, true, "the glass-break field tripped the glass-break ContactSensorState");
    assert.equal(logCount(built.logEntries, "info", "Glass break detected."), 1, "the glass-break detection logged exactly once");
    assert.ok(built.mqtt.published.some((entry) => (entry.topic === built.projection.config.mac + "/glassbreak") && (entry.payload === "true")),
      "the glass-break detection published true on its own topic");

    built.sensor.cleanup();
  });

  test("the alarm-sound contact reads its own latched field and ignores the glass-break one", async () => {

    const built = buildSensor({ alarmEnabled: true });

    await settle();

    const alarm = built.accessory.getServiceById(Service.ContactSensor, ProtectReservedNames.CONTACT_SENSOR_ALARM_SOUND);

    assert.ok(alarm, "the alarm-sound service exists");

    built.store.pushSensorPatch("test-sensor-1", { glassBreakTriggeredAt: 1700000000000 });

    await settle();

    assert.equal(alarm.getCharacteristic(Characteristic.ContactSensorState).value, false, "a bare glass-break push left the alarm-sound ContactSensorState clear");
    assert.equal(logCount(built.logEntries, "info", "Alarm detected."), 0, "a bare glass-break push narrated no alarm-sound detection");

    built.store.pushSensorPatch("test-sensor-1", { alarmTriggeredAt: 1700000000000 });

    await settle();

    assert.equal(alarm.getCharacteristic(Characteristic.ContactSensorState).value, true, "the alarm-sound field tripped the alarm-sound ContactSensorState");
    assert.equal(logCount(built.logEntries, "info", "Alarm detected."), 1, "the alarm-sound detection logged exactly once");

    built.sensor.cleanup();
  });

  test("a unit carrying both alarm kinds narrates each contact on its own field only", async () => {

    // The case the shared bookkeeping could not express: one accessory carrying both contacts, where each kind's transition must be measured against that kind's own
    // last reading rather than against whatever the other kind last did.
    const built = buildSensor({ alarmEnabled: true, glassBreak: true, glassBreakEnabled: true });

    await settle();

    const alarm = built.accessory.getServiceById(Service.ContactSensor, ProtectReservedNames.CONTACT_SENSOR_ALARM_SOUND);
    const glass = built.accessory.getServiceById(Service.ContactSensor, ProtectReservedNames.CONTACT_SENSOR_GLASS_BREAK);

    assert.ok(alarm, "the two-kind unit carries the alarm-sound service");
    assert.ok(glass, "the two-kind unit carries the glass-break service");

    built.store.pushSensorPatch("test-sensor-1", { glassBreakTriggeredAt: 1700000000000 });

    await settle();

    assert.equal(glass.getCharacteristic(Characteristic.ContactSensorState).value, true, "the glass-break push tripped the glass-break contact");
    assert.equal(alarm.getCharacteristic(Characteristic.ContactSensorState).value, false, "the glass-break push left the alarm-sound contact clear");
    assert.equal(logCount(built.logEntries, "info", "Glass break detected."), 1, "the glass-break detection logged exactly once");
    assert.equal(logCount(built.logEntries, "info", "Alarm detected."), 0, "the glass-break detection narrated nothing for the alarm-sound contact");

    built.store.pushSensorPatch("test-sensor-1", { alarmTriggeredAt: 1700000000000 });

    await settle();

    assert.equal(alarm.getCharacteristic(Characteristic.ContactSensorState).value, true, "the alarm-sound push tripped the alarm-sound contact");
    assert.equal(logCount(built.logEntries, "info", "Alarm detected."), 1, "the alarm-sound detection logged exactly once");
    assert.equal(logCount(built.logEntries, "info", "Glass break detected."), 1, "the alarm-sound detection left the glass-break count unchanged");

    built.sensor.cleanup();
  });

  test("a user clear nulling both latched fields in one patch clears each tripped contact once", async () => {

    // The shape of a real clear from the sensor's detail page: the controller nulls both fields in a single frame, so the one patch must retire both contacts and speak
    // once for each.
    // Distinct trip times per kind, as a real two-kind unit carries them: the shared field holds whatever alarmed last, which is not when the glass break happened.
    const built = buildSensor({ alarmEnabled: true, alarmTriggeredAt: 1690000000000, glassBreak: true, glassBreakEnabled: true,
      glassBreakTriggeredAt: 1700000000000 });

    await settle();

    const alarm = built.accessory.getServiceById(Service.ContactSensor, ProtectReservedNames.CONTACT_SENSOR_ALARM_SOUND);
    const glass = built.accessory.getServiceById(Service.ContactSensor, ProtectReservedNames.CONTACT_SENSOR_GLASS_BREAK);

    assert.ok(alarm, "the alarm-sound service exists");
    assert.ok(glass, "the glass-break service exists");
    assert.equal(alarm.getCharacteristic(Characteristic.ContactSensorState).value, true, "the alarm-sound contact starts tripped from its latched field");
    assert.equal(glass.getCharacteristic(Characteristic.ContactSensorState).value, true, "the glass-break contact starts tripped from its latched field");

    built.store.pushSensorPatch("test-sensor-1", { alarmTriggeredAt: null, glassBreakTriggeredAt: null });

    await settle();

    assert.equal(alarm.getCharacteristic(Characteristic.ContactSensorState).value, false, "the one clear frame retired the alarm-sound contact");
    assert.equal(glass.getCharacteristic(Characteristic.ContactSensorState).value, false, "the one clear frame retired the glass-break contact");
    assert.equal(logCount(built.logEntries, "info", "Alarm no longer detected."), 1, "the alarm-sound clear logged exactly once");
    assert.equal(logCount(built.logEntries, "info", "Glass break no longer detected."), 1, "the glass-break clear logged exactly once");

    built.sensor.cleanup();
  });

  test("seven observers register and a bare alarmTriggeredAt push wakes only its observer and sensor.config", async () => {

    assert.equal(store.observerCount, 7, "the two base observers plus the sensor's five are registered against the store double");

    const baseline = wakeLog.length;

    // A bare alarmTriggeredAt push (null -> a timestamp) changes the narrow slice and the whole record, so the alarm observer and sensor.config wake, in registration
    // order (the narrow observer precedes config); updateAlarmState is a safe no-op on this all-quiet sensor with no alarm-family service.
    store.pushSensorPatch("test-sensor-1", { alarmTriggeredAt: 1700000000000 });

    await settle();

    assert.deepEqual(wakeLog.slice(baseline),
      [ { accessoryId: accessory.UUID, key: "sensor.alarmTriggeredAt" }, { accessoryId: accessory.UUID, key: "sensor.config" } ],
      "the narrow alarmTriggeredAt observer AND the whole-record sensor.config observer woke, in registration order");
  });

  test("a bare glassBreakTriggeredAt push wakes only its observer and sensor.config", async () => {

    const baseline = wakeLog.length;

    // The glass-break field is a narrow slice of its own, registered after the alarm-sound row: a bare push wakes that one observer and sensor.config, never the
    // alarm-sound row's observer, which is watching a field this push did not touch.
    store.pushSensorPatch("test-sensor-1", { glassBreakTriggeredAt: 1700000000000 });

    await settle();

    assert.deepEqual(wakeLog.slice(baseline),
      [ { accessoryId: accessory.UUID, key: "sensor.glassBreakTriggeredAt" }, { accessoryId: accessory.UUID, key: "sensor.config" } ],
      "the narrow glassBreakTriggeredAt observer AND the whole-record sensor.config observer woke, in registration order");
  });

  test("a patch moving both latched fields wakes the two alarm-family observers in table order, then sensor.config", async () => {

    const baseline = wakeLog.length;

    // The registration order the descriptor table fixes: alarm sound first, glass break second, each on its own field, with the whole-record observer last. One patch
    // that moves both fields wakes exactly those three, in that order, which is the shape a real clear from the sensor's detail page takes on the wire.
    store.pushSensorPatch("test-sensor-1", { alarmTriggeredAt: 1700000000000, glassBreakTriggeredAt: 1700000000000 });

    await settle();

    assert.deepEqual(wakeLog.slice(baseline),
      [ { accessoryId: accessory.UUID, key: "sensor.alarmTriggeredAt" }, { accessoryId: accessory.UUID, key: "sensor.glassBreakTriggeredAt" },
        { accessoryId: accessory.UUID, key: "sensor.config" } ],
      "both narrow alarm-family observers woke in table order, then the whole-record observer");
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

  test("the glassbreak MQTT get reads through its own latched field, publishes on change, and the alarm get still registers", async () => {

    const built = buildSensor({ glassBreak: true, glassBreakEnabled: true });
    const mac = built.projection.config.mac;
    const glassGet = built.mqtt.subscriptions.find((subscription) => (subscription.kind === "get") && (subscription.topic === mac + "/glassbreak/get"));
    const alarmGet = built.mqtt.subscriptions.find((subscription) => (subscription.kind === "get") && (subscription.topic === mac + "/alarm/get"));

    await settle();

    assert.ok(glassGet, "the glassbreak GET subscription captured a getValue handler");
    assert.ok(alarmGet, "the alarm GET subscription still registers unconditionally");
    assert.equal(await built.mqtt.invokeGet(mac + "/glassbreak/get"), "false", "the glassbreak GET reads its own latched field as a string (clear at start)");

    built.store.pushSensorPatch("test-sensor-1", { glassBreakTriggeredAt: 1700000000000 });

    await settle();

    assert.equal(await built.mqtt.invokeGet(mac + "/glassbreak/get"), "true", "the glassbreak GET reads through the non-null glass-break timestamp after the push");
    assert.equal(await built.mqtt.invokeGet(mac + "/alarm/get"), "false",
      "the alarm-sound GET is untouched by a glass-break detection - it answers from its own field");
    assert.ok(built.mqtt.published.some((entry) => (entry.topic === mac + "/glassbreak") && (entry.payload === "true")),
      "the glass-break state published true on the device-scoped topic after detection");

    built.store.pushSensorPatch("test-sensor-1", { glassBreakTriggeredAt: null });

    await settle();

    assert.ok(built.mqtt.published.some((entry) => (entry.topic === mac + "/glassbreak") && (entry.payload === "false")),
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

  test("an unreachable device still writes a metric that reports a new value", async () => {

    // Reachability guards only the removal: a metric that carries a value is the sensor speaking, whatever the device's reachability reads. The pushed value differs
    // from the held reading, so a hold that also swallowed reported values leaves the old reading in place and fails here.
    const built = buildSensor({ airQuality: { aqi: { status: "neutral", value: 42 }, pm2p5: { status: "neutral", value: 3 } } });

    await settle();

    const service = built.accessory.getService(Service.AirQualitySensor);

    assert.ok(service, "the service exists before the device goes offline");

    built.store.pushSensorPatch("test-sensor-1", { airQuality: airQualityBlock({ aqi: { status: "neutral", value: 42 }, pm2p5: { status: "neutral", value: 7 } }),
      state: "DISCONNECTED" });

    await settle();

    assert.equal(service.getCharacteristic(Characteristic.StatusActive).value, false, "the device is genuinely unreachable for this pass");
    assert.equal(service.getCharacteristic(Characteristic.PM2_5Density).value, 7, "the reported density was written while the device was unreachable");
    assert.equal(service.getCharacteristic(Characteristic.PM2_5Density).writes.at(-1), 7, "the write log's latest entry is the newly reported value");

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
    assert.equal(logCount(built.logEntries, "info", "Vaping"), 0, "a quiet first reading is saved silently rather than narrated");
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
    assert.equal(logCount(built.logEntries, "info", "Vaping detected."), 1, "the transition was narrated exactly once");

    // The negative control: a reconcile driven by an unrelated field change, with the vape state unmoved. The state must not be re-narrated on every patch, and this
    // sensor sees one roughly every second and a half in the field.
    built.store.pushSensorPatch("test-sensor-1", { batteryStatus: { isLow: false, modelKey: "sensorBatteryStatus", percentage: 99 } });

    await settle();

    assert.equal(logCount(built.logEntries, "info", "Vaping detected."), 1, "a reconcile that changed nothing about vaping said nothing about it");
    assert.equal(service.getCharacteristic(Characteristic.ContactSensorState).value, true, "the contact still reports the ongoing detection");

    built.sensor.cleanup();
  });

  test("a sensor already detecting at construction narrates it once, while a quiet one narrates nothing", () => {

    // The first-pass seed. A user restarting Homebridge mid-detection should be told what the sensor is reporting; one that is quiet has nothing worth a sentence.
    const detecting = buildSensor({ airQuality: { vape: { status: "detected", value: null } }, vapeEnabled: true },
      { userOptions: ["Enable.Sensor.Vape"] });

    assert.equal(logCount(detecting.logEntries, "info", "Vaping detected."), 1, "an ongoing detection at construction is narrated exactly once");

    detecting.sensor.cleanup();

    const quiet = buildSensor({ airQuality: { vape: { status: "neutral", value: null } }, vapeEnabled: true }, { userOptions: ["Enable.Sensor.Vape"] });

    assert.equal(logCount(quiet.logEntries, "info", "Vaping"), 0, "a quiet sensor at construction narrates nothing");

    quiet.sensor.cleanup();
  });

  test("a vape liveness dropout holds the contact silently, and the returning detection is not narrated twice", async () => {

    const built = buildSensor({ airQuality: { vape: { status: "detected", value: null } }, vapeEnabled: true }, { userOptions: ["Enable.Sensor.Vape"] });

    await settle();

    const service = built.accessory.getServiceById(Service.ContactSensor, ProtectReservedNames.CONTACT_SENSOR_VAPE);

    assert.ok(service, "the vape contact sensor exists");
    assert.equal(logCount(built.logEntries, "info", "Vaping detected."), 1, "the ongoing detection was narrated once at construction");

    // The metric falls to the not-capable shape. Reading that as an all-clear would tell the user vaping stopped when the sensor simply stopped answering.
    built.store.pushSensorPatch("test-sensor-1", { airQuality: airQualityBlock({}) });

    await settle();

    assert.equal(logCount(built.logEntries, "info", "Vaping no longer detected."), 0, "the dropout narrated no all-clear the sensor never reported");
    assert.equal(service.getCharacteristic(Characteristic.ContactSensorState).value, true, "the contact held its last reported state through the dropout");
    assert.equal(await service.getCharacteristic(Characteristic.ContactSensorState).triggerGet(), true,
      "and a pull arriving mid-dropout answers that held state back rather than recomputing an all-clear");

    built.store.pushSensorPatch("test-sensor-1", { airQuality: airQualityBlock({ vape: { status: "detected", value: null } }) });

    await settle();

    assert.equal(logCount(built.logEntries, "info", "Vaping detected."), 1, "the returning detection was not narrated a second time - the state never changed");

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

    // The read side of the same guarantee, and the assertion that tells the held-value read apart from an in-process fallback: this process has narrated nothing, so a
    // fallback over its own bookkeeping would answer false here and hand that false straight back into HomeKit's cache on the very first pull after the restart.
    assert.equal(await service.getCharacteristic(Characteristic.ContactSensorState).triggerGet(), true, "a pull answers the value HomeKit restored, not an all-clear");
    assert.equal(logCount(built.logEntries, "info", "Vaping"), 0, "nothing was narrated about a metric that said nothing");
    assert.equal(built.mqtt.published.some((entry) => entry.topic === (built.projection.config.mac + "/vape")), false,
      "no vape state was published from a reading the sensor never gave");

    // Answering a get republishes on the parent topic, exactly as the real client does, so this reads the same held state one step after the no-publish assertion above.
    assert.equal(await built.mqtt.invokeGet(built.projection.config.mac + "/vape/get"), "true", "the vape get answers that same restored state");

    built.sensor.cleanup();
  });

  test("the vape bookkeeping clears with the service, so a re-enabled sensor re-seeds without narrating a stale all-clear", async () => {

    // The reset round-trip in the shape that tells a real reset from stale bookkeeping: detect, tear the service down through the controller's own vape enable, then
    // bring it back with a quiet reading. Bookkeeping that survived the teardown would read the quiet reading as a transition and wrongly announce an all-clear.
    const built = buildSensor({ airQuality: { vape: { status: "detected", value: null } }, vapeEnabled: true }, { userOptions: ["Enable.Sensor.Vape"] });

    await settle();

    assert.ok(built.accessory.getServiceById(Service.ContactSensor, ProtectReservedNames.CONTACT_SENSOR_VAPE), "the vape contact sensor exists while detecting");
    assert.equal(logCount(built.logEntries, "info", "Vaping detected."), 1, "the detection was narrated once");

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
    assert.equal(logCount(built.logEntries, "info", "Vaping no longer detected."), 0,
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

  test("the carbon dioxide level holds through a live-but-null reading, and a pull during the hold answers the held value", async () => {

    // The metric keeps a status and loses its number, the sensor momentarily between readings. The write log - not the cached value - proves nothing was written.
    const built = buildSensor({ airQuality: { co2: { status: "neutral", value: 800 } }, co2Enabled: true, co2Threshold: 1000 });

    await settle();

    const service = built.accessory.getService(Service.CarbonDioxideSensor);

    assert.ok(service, "the service exists before the patch");

    const writeBaseline = service.getCharacteristic(Characteristic.CarbonDioxideLevel).writes.length;

    built.store.pushSensorPatch("test-sensor-1", { airQuality: airQualityBlock({ co2: { status: "neutral", value: null } }) });

    await settle();

    assert.equal(service.testCharacteristic(Characteristic.CarbonDioxideLevel), true, "a live-but-null metric holds the level rather than shedding it");
    assert.equal(service.getCharacteristic(Characteristic.CarbonDioxideLevel).value, 800, "the held level still reports the last reading the sensor gave");
    assert.equal(service.getCharacteristic(Characteristic.CarbonDioxideLevel).writes.length, writeBaseline, "the hold wrote nothing at all");
    assert.equal(await service.getCharacteristic(Characteristic.CarbonDioxideLevel).triggerGet(), 800, "a pull during the hold answers with the held level");

    built.sensor.cleanup();
  });

  test("an unreachable device holds its carbon dioxide level even as the metric falls quiet", async () => {

    // The offline window: the removal rule waits for the device to be reachable before believing the metric stopped reporting.
    const built = buildSensor({ airQuality: { co2: { status: "neutral", value: 800 } }, co2Enabled: true, co2Threshold: 1000 });

    await settle();

    const service = built.accessory.getService(Service.CarbonDioxideSensor);

    assert.ok(service, "the service exists before the device goes offline");

    built.store.pushSensorPatch("test-sensor-1", { airQuality: airQualityBlock({}), state: "DISCONNECTED" });

    await settle();

    assert.equal(service.getCharacteristic(Characteristic.StatusActive).value, false, "the device is genuinely unreachable for this pass");
    assert.equal(service.testCharacteristic(Characteristic.CarbonDioxideLevel), true, "the level held through the offline window despite its metric reading quiet");
    assert.equal(service.getCharacteristic(Characteristic.CarbonDioxideLevel).value, 800, "the held level still reports the last reading");
    assert.ok(built.accessory.getService(Service.CarbonDioxideSensor), "the service itself held too");

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
    assert.equal(built.store.observerCount, 7, "the air-quality surface added no observer - it goes through the reconcile the whole-record observer already drives");

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

    const payload = JSON.parse(String(published.payload)) as Record<string, { status: string; value: Nullable<number> }>;

    assert.deepEqual(Object.keys(payload).sort(), [ "aqi", "co2", "humidity", "nox", "pm10p0", "pm1p0", "pm2p5", "pm4p0", "temperature", "tvoc", "vape", "voc" ].sort(),
      "the payload carries exactly the twelve metrics we document and nothing else");
    assert.deepEqual(payload["aqi"], { status: "neutral", value: 42 }, "each metric carries its status and value");
    assert.deepEqual(payload["voc"], { status: "neutral", value: 68 }, "the VOC index rides MQTT, having no HomeKit service to live on");
    assert.deepEqual(payload["nox"], { status: "unknown", value: null }, "a metric the sensor does not measure reports null rather than being dropped");

    const airQualityGet = built.mqtt.subscriptions.find((subscription) => (subscription.kind === "get") && (subscription.topic === (mac + "/airquality") + "/get"));

    assert.ok(airQualityGet, "the airquality GET registered");
    assert.equal(await built.mqtt.invokeGet(mac + "/airquality/get"), published.payload, "the GET answers with the same curated payload the publish carries");

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
    const vapeGet = built.mqtt.subscriptions.find((subscription) => (subscription.kind === "get") && (subscription.topic === (mac + "/vape") + "/get"));

    await settle();

    assert.ok(vapeGet, "the vape GET registered");
    assert.equal(await built.mqtt.invokeGet(mac + "/vape/get"), "false", "the GET reads through the vape state, clear at start");
    assert.ok(built.mqtt.published.some((entry) => (entry.topic === (mac + "/vape")) && (entry.payload === "false")), "the quiet state published");

    built.store.pushSensorPatch("test-sensor-1", { airQuality: airQualityBlock({ vape: { status: "detected", value: null } }) });

    await settle();

    assert.equal(await built.mqtt.invokeGet(mac + "/vape/get"), "true", "the GET reads through the detection");
    assert.ok(built.mqtt.published.some((entry) => (entry.topic === (mac + "/vape")) && (entry.payload === "true")), "the detection published");

    built.sensor.cleanup();
  });

  test("with Sensor.Vape off the vape topic has no GET, and a detection on reporting hardware publishes nothing", async () => {

    // The controller's own vape enable is on and the metric reports, so the user's option is the one condition held off and the topic's absence is that option's alone.
    const built = buildSensor({ airQuality: { vape: { status: "neutral", value: null } }, vapeEnabled: true });
    const mac = built.projection.config.mac;

    await settle();

    assert.equal(built.mqtt.subscriptions.some((subscription) => subscription.topic === (mac + "/vape/get")), false, "no vape GET is registered with the option off");

    built.store.pushSensorPatch("test-sensor-1", { airQuality: airQualityBlock({ vape: { status: "detected", value: null } }) });

    await settle();

    assert.equal(built.mqtt.publishedTo("/vape").length, 0, "neither the quiet state nor the detection publishes with the option off");

    built.sensor.cleanup();
  });

  test("with Device.AmbientLightSensor off the sensor's ambientlight topic has no GET, and a reading change publishes nothing", async () => {

    // The sensor's own light setting is on and it reports a reading, so the user's option is the one condition held off and the topic's absence is that option's alone.
    const built = buildSensor({ ambientLight: 120, lightEnabled: true }, { userOptions: ["Disable.Device.AmbientLightSensor"] });
    const mac = built.projection.config.mac;

    await settle();

    assert.equal(built.mqtt.subscriptions.some((subscription) => subscription.topic === (mac + "/ambientlight/get")), false,
      "no ambientlight GET is registered with the option off");

    built.store.pushSensorPatch("test-sensor-1", { stats: { light: { status: "", value: 250 } } });

    await settle();

    assert.equal(built.mqtt.publishedTo("/ambientlight").length, 0, "neither the first reading nor the change publishes with the option off");

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
    assert.ok(built.mqtt.published.some((entry) => (entry.topic === (mac + "/humidity")) && (entry.payload === "50.25")), "the humidity reading published");
    assert.ok(built.mqtt.published.some((entry) => (entry.topic === (mac + "/temperature")) && (entry.payload === "23.92")), "the temperature reading published");

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

  test("the humidity and temperature MQTT gets always answer, with the no-reading stand-in when no source reports", async () => {

    // The get contract is unconditional: a subscriber asking an all-quiet sensor still gets an answer, and the stand-in tells it apart from a real reading.
    const mac = projection.config.mac;
    const humidityGet = mqtt.subscriptions.find((subscription) => (subscription.kind === "get") && (subscription.topic === (mac + "/humidity") + "/get"));
    const temperatureGet = mqtt.subscriptions.find((subscription) => (subscription.kind === "get") && (subscription.topic === (mac + "/temperature") + "/get"));

    assert.ok(humidityGet, "the humidity GET registered on an all-quiet sensor");
    assert.ok(temperatureGet, "the temperature GET registered on an all-quiet sensor");
    assert.equal(await mqtt.invokeGet(mac + "/humidity/get"), "-1", "the humidity GET answers the no-reading stand-in rather than staying silent");
    assert.equal(await mqtt.invokeGet(mac + "/temperature/get"), "-1", "the temperature GET answers the no-reading stand-in rather than staying silent");
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

  test("the smoke services materialize per advertised alarm type on detector hardware, and never on a sensor that is no detector", async () => {

    // The gate is two questions asked once per service: is this model a detector, and does that detector advertise this alarm type.
    const both = buildSensor({ alarmTypes: [ "smoke", "CO" ], smokeStatus: makeSmokeStatus(), type: "USL-Smoke-US" });

    await settle();

    const smoke = both.accessory.getService(Service.SmokeSensor);
    const carbonMonoxide = both.accessory.getService(Service.CarbonMonoxideSensor);

    assert.ok(smoke, "advertising smoke materializes the SmokeSensor");
    assert.ok(carbonMonoxide, "advertising carbon monoxide materializes the CarbonMonoxideSensor");
    assert.equal(await smoke.getCharacteristic(Characteristic.SmokeDetected).triggerGet(), false, "the smoke onGet reads through the at-rest block");
    assert.equal(await carbonMonoxide.getCharacteristic(Characteristic.CarbonMonoxideDetected).triggerGet(), false,
      "the carbon monoxide onGet reads through the at-rest block");
    assert.equal(smoke.getCharacteristic(Characteristic.StatusActive).value, true, "the smoke service carries the shared state characteristics");
    assert.equal(smoke.getCharacteristic(Characteristic.StatusTampered).value, false, "and the shared tamper read-through");
    assert.equal(smoke.getCharacteristic(Characteristic.StatusFault).value, false, "an at-rest detector reports no smoke fault");
    assert.equal(carbonMonoxide.getCharacteristic(Characteristic.StatusFault).value, false, "and no carbon monoxide fault");

    both.sensor.cleanup();

    const smokeOnly = buildSensor({ alarmTypes: ["smoke"], smokeStatus: makeSmokeStatus(), type: "USL-Smoke-US" });

    await settle();

    assert.ok(smokeOnly.accessory.getService(Service.SmokeSensor), "a detector advertising smoke alone materializes the SmokeSensor");
    assert.equal(smokeOnly.accessory.getService(Service.CarbonMonoxideSensor), undefined, "and grows no CarbonMonoxideSensor");

    smokeOnly.sensor.cleanup();

    /* The negative controls, each a sensor that is no detector. The third is the row that tells an advertisement read apart from a block-presence read: it carries a
     * full block with BOTH alarms sounding and must still grow nothing, publish nothing, and answer false on both boolean gets - because the capability step, not the
     * block, decides what a non-detector reports. The fourth is the row that tells the model read apart from the advertisement read: a UP Sense carries a detector's
     * whole advertisement AND a full block, and only its model says it is a listener rather than a detector.
     */
    const assertNoSmokeSurface = async (config: Parameters<typeof makeSensorConfig>[0], label: string): Promise<void> => {

      const built = buildSensor(config);
      const mac = built.projection.config.mac;

      await settle();

      assert.equal(built.accessory.getService(Service.SmokeSensor), undefined, "no SmokeSensor for " + label);
      assert.equal(built.accessory.getService(Service.CarbonMonoxideSensor), undefined, "no CarbonMonoxideSensor for " + label);
      assert.equal(built.mqtt.published.some((entry) => SMOKE_TOPIC_TAILS.some((tail) => entry.topic === (mac + tail))), false,
        "none of the three smoke topics published for " + label);
      assert.equal(await built.mqtt.invokeGet(mac + "/smokedetector/get"), "null", "the telemetry get answers JSON null for " + label);
      assert.equal(await built.mqtt.invokeGet(mac + "/smoke/get"), "false", "the smoke get answers false for " + label);
      assert.equal(await built.mqtt.invokeGet(mac + "/carbonmonoxide/get"), "false", "the carbon monoxide get answers false for " + label);

      built.sensor.cleanup();
    };

    await assertNoSmokeSurface({}, "a sensor advertising no alarm types at all");
    await assertNoSmokeSurface({ alarmTypes: ["glassBreak"], smokeStatus: makeSmokeStatus(), type: "USL-GlassBreak-US" }, "the glass-break unit's own alarm-type list");
    await assertNoSmokeSurface({ smokeStatus: makeSmokeStatus({ coAlarm: true, smokeAlarm: true }) }, "a non-detector carrying a block with both alarms sounding");
    await assertNoSmokeSurface({ alarmTypes: [ "smoke", "CO" ], marketName: "UP Sense", smokeStatus: makeSmokeStatus(), type: "UFP-SENSE" },
      "a UP Sense advertising the alarm sounds it listens for, block and all");
  });

  test("the smoke labels join the enabled-sensors line in their family-group position", () => {

    const both = buildSensor({ alarmTypes: [ "smoke", "CO" ], smokeStatus: makeSmokeStatus(), type: "USL-Smoke-US" });

    assert.ok(loggedAt(both.logEntries, "info", "Enabled sensors: carbon monoxide, smoke."), "the two smoke labels reach the line in label order");

    both.sensor.cleanup();

    // With carbon dioxide reporting too, the pair lands after it - which is where the group's first label sorts.
    const withCo2 = buildSensor({ airQuality: { co2: { status: "neutral", value: 800 } }, alarmTypes: [ "smoke", "CO" ], smokeStatus: makeSmokeStatus(),
      type: "USL-Smoke-US" });

    assert.ok(loggedAt(withCo2.logEntries, "info", "Enabled sensors: carbon dioxide, carbon monoxide, smoke."), "the group lands in its alphabetical family position");

    withCo2.sensor.cleanup();
  });

  test("a capable detector that has reported no block carries both services while writing, narrating, and publishing nothing", async () => {

    const built = buildSensor({ alarmTypes: [ "smoke", "CO" ], type: "USL-Smoke-US" });
    const mac = built.projection.config.mac;

    await settle();

    const smoke = built.accessory.getService(Service.SmokeSensor);
    const carbonMonoxide = built.accessory.getService(Service.CarbonMonoxideSensor);

    assert.ok(smoke, "the SmokeSensor materializes on the advertisement alone, with no block in sight");
    assert.ok(carbonMonoxide, "the CarbonMonoxideSensor materializes on the advertisement alone");
    assert.equal(smoke.getCharacteristic(Characteristic.StatusActive).value, true, "the state characteristics still run for a detector that has not reported");
    assert.equal(smoke.getCharacteristic(Characteristic.SmokeDetected).writes.length, 0, "the detection characteristic never took a value");
    assert.equal(smoke.getCharacteristic(Characteristic.StatusFault).writes.length, 0, "nor did its fault characteristic");
    assert.equal(carbonMonoxide.getCharacteristic(Characteristic.CarbonMonoxideDetected).writes.length, 0, "nor did the carbon monoxide detection");
    assert.equal(carbonMonoxide.getCharacteristic(Characteristic.StatusFault).writes.length, 0, "nor its fault");
    assert.equal(await smoke.getCharacteristic(Characteristic.SmokeDetected).triggerGet(), false, "the read-through answers a never-written characteristic's held value");
    assert.equal(await smoke.getCharacteristic(Characteristic.StatusFault).triggerGet(), false, "and the fault read-through answers the same");
    assert.equal(await carbonMonoxide.getCharacteristic(Characteristic.CarbonMonoxideDetected).triggerGet(), false,
      "the carbon monoxide read-through answers its own never-written characteristic's held value");
    assert.equal(await carbonMonoxide.getCharacteristic(Characteristic.StatusFault).triggerGet(), false, "and so does its fault read-through");
    assert.equal(logCount(built.logEntries, "info", "Smoke"), 0, "nothing was narrated about a detector that said nothing");
    assert.equal(logCount(built.logEntries, "info", "Carbon monoxide"), 0, "nor about its sibling");
    assert.equal(built.mqtt.published.some((entry) => SMOKE_TOPIC_TAILS.some((tail) => entry.topic === (mac + tail))), false,
      "none of the three topics published from a block nobody gave");
    assert.equal(await built.mqtt.invokeGet(mac + "/smokedetector/get"), "null", "the telemetry get answers JSON null for a detector that has not reported");

    built.sensor.cleanup();
  });

  test("a smoke detection narrates once per edge and publishes when the detection changes", async () => {

    const built = buildSensor({ alarmTypes: [ "smoke", "CO" ], smokeStatus: makeSmokeStatus({ smokeAlarm: true }), type: "USL-Smoke-US" });
    const mac = built.projection.config.mac;

    await settle();

    const smoke = built.accessory.getService(Service.SmokeSensor);

    assert.ok(smoke, "the SmokeSensor exists");
    assert.equal(smoke.getCharacteristic(Characteristic.SmokeDetected).value, true, "an alarm already sounding at construction lands on the characteristic");
    assert.equal(logCount(built.logEntries, "info", "Smoke detected."), 1, "an alarm already under way at construction is narrated exactly once");
    assert.ok(built.mqtt.published.some((entry) => (entry.topic === (mac + "/smoke")) && (entry.payload === "true")), "the detection published");

    built.store.pushSensorPatch("test-sensor-1", { smokeStatus: makeSmokeStatus() });

    await settle();

    assert.equal(smoke.getCharacteristic(Characteristic.SmokeDetected).value, false, "the clearing block landed on the characteristic");
    assert.equal(logCount(built.logEntries, "info", "Smoke no longer detected."), 1, "the clearing edge was narrated exactly once");
    assert.ok(built.mqtt.published.some((entry) => (entry.topic === (mac + "/smoke")) && (entry.payload === "false")), "the all-clear published");

    // The cadence, and the negative control on the narration. A reconcile driven by an unrelated field change, with the detector's block unmoved, leaves the topic
    // unsent exactly as every other reconcile-pass publish in this family does, and says nothing at all about the alarm. A value-identical block push is a no-op in
    // the controller's own reducer, so an unrelated change is what genuinely drives a pass here.
    const publishBaseline = built.mqtt.publishedTo("/smoke").length;

    built.store.pushSensorPatch("test-sensor-1", { batteryStatus: { isLow: false, modelKey: "sensorBatteryStatus", percentage: 99 } });

    await settle();

    assert.equal(logCount(built.logEntries, "info", "Smoke no longer detected."), 1, "a pass that changed nothing about the alarm said nothing about it");
    assert.equal(logCount(built.logEntries, "info", "Smoke detected."), 1, "and never re-announced the detection either");
    assert.equal(built.mqtt.publishedTo("/smoke").length, publishBaseline, "while the topic stayed unsent on a pass that left the detection where it was");

    built.store.pushSensorPatch("test-sensor-1", { smokeStatus: makeSmokeStatus({ coAlarm: true }) });

    await settle();

    assert.equal(logCount(built.logEntries, "info", "Carbon monoxide detected."), 1, "the carbon monoxide edge narrates under its own subject word");
    assert.ok(built.mqtt.published.some((entry) => (entry.topic === (mac + "/carbonmonoxide")) && (entry.payload === "true")),
      "and publishes on its own topic");

    built.sensor.cleanup();
  });

  test("a fault warns on its reason set, warns again when that set changes, and clears once at info", async () => {

    const built = buildSensor({ alarmTypes: [ "smoke", "CO" ], smokeStatus: makeSmokeStatus({ cleanSmokeSensor: true }), type: "USL-Smoke-US" });

    await settle();

    const smoke = built.accessory.getService(Service.SmokeSensor);
    const carbonMonoxide = built.accessory.getService(Service.CarbonMonoxideSensor);

    assert.ok(smoke, "the SmokeSensor exists");
    assert.ok(carbonMonoxide, "the CarbonMonoxideSensor exists");
    assert.equal(smoke.getCharacteristic(Characteristic.StatusFault).value, true, "a chamber needing cleaning faults the smoke service");
    assert.equal(carbonMonoxide.getCharacteristic(Characteristic.StatusFault).value, false, "and leaves the carbon monoxide service clear");
    assert.equal(logCount(built.logEntries, "warn", "The smoke sensor is reporting a fault: needs cleaning."), 1, "the fault was warned exactly once");

    built.store.pushSensorPatch("test-sensor-1", { smokeStatus: makeSmokeStatus({ cleanSmokeSensor: true, endOfLife: true }) });

    await settle();

    assert.equal(logCount(built.logEntries, "warn", "The smoke sensor is reporting a fault: end of life, needs cleaning."), 1,
      "a second fault arriving while already faulted warns again, both reasons in table order");
    assert.equal(carbonMonoxide.getCharacteristic(Characteristic.StatusFault).value, true, "end of life faults the carbon monoxide service too");
    assert.equal(logCount(built.logEntries, "warn", "The carbon monoxide sensor is reporting a fault: end of life."), 1, "which warns under its own subject");

    built.store.pushSensorPatch("test-sensor-1", { batteryStatus: { isLow: false, modelKey: "sensorBatteryStatus", percentage: 99 } });

    await settle();

    assert.equal(logCount(built.logEntries, "warn", "The smoke sensor is reporting a fault:"), 2, "a pass that changed no fault flag warned nothing more");

    built.store.pushSensorPatch("test-sensor-1", { smokeStatus: makeSmokeStatus() });

    await settle();

    assert.equal(smoke.getCharacteristic(Characteristic.StatusFault).value, false, "clearing every flag cleared the smoke fault");
    assert.equal(logCount(built.logEntries, "info", "The smoke sensor is no longer reporting a fault."), 1, "the all-clear was said once, at info rather than warn");
    assert.equal(logCount(built.logEntries, "info", "The carbon monoxide sensor is no longer reporting a fault."), 1, "and once for the carbon monoxide sensor");

    built.sensor.cleanup();

    // Each sensor's own fault stays its own: the carbon monoxide sensor fault never reaches the smoke service.
    const coFault = buildSensor({ alarmTypes: [ "smoke", "CO" ], smokeStatus: makeSmokeStatus({ coSensorFault: true }), type: "USL-Smoke-US" });

    await settle();

    assert.equal(coFault.accessory.getService(Service.SmokeSensor)?.getCharacteristic(Characteristic.StatusFault).value, false,
      "the carbon monoxide sensor's own fault leaves the smoke service clear");
    assert.equal(coFault.accessory.getService(Service.CarbonMonoxideSensor)?.getCharacteristic(Characteristic.StatusFault).value, true,
      "while faulting its own service");
    assert.equal(logCount(coFault.logEntries, "warn", "The carbon monoxide sensor is reporting a fault: sensor fault."), 1, "under its own noun phrase");

    coFault.sensor.cleanup();
  });

  test("a detector that stops reporting holds every state, and every read answers that held state back", async () => {

    const built = buildSensor({ alarmTypes: [ "smoke", "CO" ], smokeStatus: makeSmokeStatus({ coSensorFault: true, smokeAlarm: true }), type: "USL-Smoke-US" });
    const mac = built.projection.config.mac;

    await settle();

    const smoke = built.accessory.getService(Service.SmokeSensor);
    const carbonMonoxide = built.accessory.getService(Service.CarbonMonoxideSensor);

    assert.ok(smoke, "the SmokeSensor exists");
    assert.ok(carbonMonoxide, "the CarbonMonoxideSensor exists");
    assert.equal(logCount(built.logEntries, "info", "Smoke detected."), 1, "the detection was narrated once at construction");

    const publishBaseline = built.mqtt.published.filter((entry) => SMOKE_TOPIC_TAILS.some((tail) => entry.topic === (mac + tail))).length;

    built.store.pushSensorPatch("test-sensor-1", { smokeStatus: null });

    await settle();

    assert.equal(smoke.getCharacteristic(Characteristic.SmokeDetected).value, true, "the detection held through the dropout");
    assert.equal(carbonMonoxide.getCharacteristic(Characteristic.StatusFault).value, true, "and so did the carbon monoxide fault");
    assert.equal(logCount(built.logEntries, "info", "Smoke no longer detected."), 0, "the dropout narrated no all-clear the detector never sent");
    assert.equal(logCount(built.logEntries, "info", "The carbon monoxide sensor is no longer reporting a fault."), 0, "nor any fault all-clear");
    assert.equal(built.mqtt.published.filter((entry) => SMOKE_TOPIC_TAILS.some((tail) => entry.topic === (mac + tail))).length, publishBaseline,
      "and published nothing at all from a block nobody gave");
    assert.equal(await smoke.getCharacteristic(Characteristic.SmokeDetected).triggerGet(), true, "a pull during the dropout answers the held detection");
    assert.equal(await carbonMonoxide.getCharacteristic(Characteristic.StatusFault).triggerGet(), true, "and a pull answers the held fault");
    assert.equal(await built.mqtt.invokeGet(mac + "/smoke/get"), "true", "the smoke get answers the held detection");
    assert.equal(await built.mqtt.invokeGet(mac + "/carbonmonoxide/get"), "false", "the carbon monoxide get answers its own held state, which was never an alarm");

    built.sensor.cleanup();

    /* The half that tells the mechanism apart from an in-process fallback. This process has narrated nothing and holds no bookkeeping at all, so only HomeKit's own
     * cached value can answer these reads: Homebridge restores both services still reporting and the detector's block is null. A fallback over an in-process field would
     * answer false here - and hand that false straight back into the cache on the first pull after the restart.
     */
    const seeded = makeTestAccessory("Cached Smoke Detector", "uuid:cached-smoke-detector");
    const cachedSmoke = new Service.SmokeSensor("Cached Smoke");
    const cachedCarbonMonoxide = new Service.CarbonMonoxideSensor("Cached Carbon Monoxide");

    seeded.addService(cachedSmoke);
    seeded.addService(cachedCarbonMonoxide);
    cachedSmoke.updateCharacteristic(Characteristic.SmokeDetected, true);
    cachedCarbonMonoxide.updateCharacteristic(Characteristic.CarbonMonoxideDetected, true);
    cachedCarbonMonoxide.updateCharacteristic(Characteristic.StatusFault, true);

    const restored = buildSensor({ alarmTypes: [ "smoke", "CO" ], type: "USL-Smoke-US" }, { accessory: seeded });
    const restoredMac = restored.projection.config.mac;

    await settle();

    assert.equal(cachedSmoke.getCharacteristic(Characteristic.SmokeDetected).value, true, "the restored smoke detection stands; no all-clear was written over it");
    assert.equal(cachedCarbonMonoxide.getCharacteristic(Characteristic.CarbonMonoxideDetected).value, true, "the restored carbon monoxide detection stands too");
    assert.equal(cachedCarbonMonoxide.getCharacteristic(Characteristic.StatusFault).value, true, "as does the restored fault");
    assert.equal(await cachedSmoke.getCharacteristic(Characteristic.SmokeDetected).triggerGet(), true, "a pull answers the value HomeKit restored, not an all-clear");
    assert.equal(await cachedCarbonMonoxide.getCharacteristic(Characteristic.CarbonMonoxideDetected).triggerGet(), true,
      "the carbon monoxide read-through answers the detection HomeKit restored");
    assert.equal(await cachedCarbonMonoxide.getCharacteristic(Characteristic.StatusFault).triggerGet(), true, "and the fault read-through answers the cached value");
    assert.equal(logCount(restored.logEntries, "info", "Smoke"), 0, "nothing was narrated about a detector that has said nothing to this process");
    assert.equal(restored.mqtt.published.some((entry) => SMOKE_TOPIC_TAILS.some((tail) => entry.topic === (restoredMac + tail))), false, "and nothing was published");

    // Answering a get republishes on the parent topic, exactly as the real client does, so the get reads come one step after the no-publish assertion above.
    assert.equal(await restored.mqtt.invokeGet(restoredMac + "/smoke/get"), "true", "the smoke get answers the cached detection");
    assert.equal(await restored.mqtt.invokeGet(restoredMac + "/carbonmonoxide/get"), "true", "the carbon monoxide get answers the cached detection");

    restored.sensor.cleanup();
  });

  test("the smoke bookkeeping clears with the services, so a returning detector re-seeds without a stale all-clear", async () => {

    const built = buildSensor({ alarmTypes: [ "smoke", "CO" ], smokeStatus: makeSmokeStatus({ cleanSmokeSensor: true, smokeAlarm: true, testing: true }),
      type: "USL-Smoke-US" });

    await settle();

    assert.equal(logCount(built.logEntries, "info", "Smoke detected."), 1, "the detection was narrated once");
    assert.equal(logCount(built.logEntries, "warn", "The smoke sensor is reporting a fault: needs cleaning."), 1, "the fault was warned once");
    assert.equal(logCount(built.logEntries, "info", "The smoke detector's self-test has started."), 1, "the running self-test was narrated once");

    built.store.pushSensorPatch("test-sensor-1", { featureFlags: { alarmTypes: [] } });

    await settle();

    assert.equal(built.accessory.getService(Service.SmokeSensor), undefined, "withdrawing the advertisement removed the SmokeSensor");
    assert.equal(built.accessory.getService(Service.CarbonMonoxideSensor), undefined, "and the CarbonMonoxideSensor");

    built.store.pushSensorPatch("test-sensor-1", { featureFlags: { alarmTypes: [ "smoke", "CO" ] }, smokeStatus: makeSmokeStatus() });

    await settle();

    assert.ok(built.accessory.getService(Service.SmokeSensor), "restoring the advertisement brought the SmokeSensor back");
    assert.equal(logCount(built.logEntries, "info", "Smoke no longer detected."), 0, "the fresh service seeded silently - stale bookkeeping would announce an all-clear");
    assert.equal(logCount(built.logEntries, "info", "The smoke sensor is no longer reporting a fault."), 0, "and would announce a stale fault all-clear here");
    assert.equal(logCount(built.logEntries, "info", "The smoke detector's self-test has ended."), 0, "and a stale end to a self-test nobody saw finish");

    built.sensor.cleanup();
  });

  test("one alarm type's removal leaves its sibling's bookkeeping standing, while a capability flicker re-seeds a detection already under way", async () => {

    const built = buildSensor({ alarmTypes: [ "smoke", "CO" ], smokeStatus: makeSmokeStatus({ smokeAlarm: true }), type: "USL-Smoke-US" });

    await settle();

    assert.ok(built.accessory.getService(Service.CarbonMonoxideSensor), "the carbon monoxide service exists to begin with");
    assert.equal(logCount(built.logEntries, "info", "Smoke detected."), 1, "the smoke detection was narrated once");

    built.store.pushSensorPatch("test-sensor-1", { featureFlags: { alarmTypes: ["smoke"] } });

    await settle();

    assert.equal(built.accessory.getService(Service.CarbonMonoxideSensor), undefined, "dropping one alarm type removed that service alone");
    assert.ok(built.accessory.getService(Service.SmokeSensor), "while its sibling stood");

    built.store.pushSensorPatch("test-sensor-1", { batteryStatus: { isLow: false, modelKey: "sensorBatteryStatus", percentage: 99 } });

    await settle();

    assert.equal(logCount(built.logEntries, "info", "Smoke detected."), 1, "the surviving service's bookkeeping outlived its sibling's removal");

    built.sensor.cleanup();

    /* The flicker, asserted so the count is deliberate rather than incidental: the advertisement goes away and comes back while the SAME alarm is still sounding, and
     * the recreated service speaks the detection again. That is the family's designed first-run behavior - a fresh service tells the user what the sensor is reporting
     * right now, exactly as the vape sensor does - rather than an accidental double-narration.
     */
    const flicker = buildSensor({ alarmTypes: [ "smoke", "CO" ], smokeStatus: makeSmokeStatus({ smokeAlarm: true }), type: "USL-Smoke-US" });

    await settle();

    assert.equal(logCount(flicker.logEntries, "info", "Smoke detected."), 1, "the alarm under way at construction was narrated once");

    flicker.store.pushSensorPatch("test-sensor-1", { featureFlags: { alarmTypes: [] } });

    await settle();

    flicker.store.pushSensorPatch("test-sensor-1", { featureFlags: { alarmTypes: [ "smoke", "CO" ] } });

    await settle();

    assert.equal(logCount(flicker.logEntries, "info", "Smoke detected."), 2, "the recreated service spoke the ongoing alarm once more, the designed first-run behavior");

    flicker.sensor.cleanup();
  });

  test("the smokedetector topic carries the curated status and its four timestamps, and the get answers the same payload", async () => {

    // Distinct timestamp values so a payload that mapped one to the wrong key would be caught by value rather than only by key set, and one key the wire type does not
    // declare, which the open index signature admits and the curated build must drop.
    const built = buildSensor({ alarmSilencedAt: 1, alarmTypes: [ "smoke", "CO" ], coAlarmTriggeredAt: 2, smokeAlarmTriggeredAt: 3,
      smokeStatus: makeSmokeStatus({ undocumentedFutureFlag: true }), troubleSilencedAt: 4, type: "USL-Smoke-US" });
    const mac = built.projection.config.mac;

    await settle();

    const published = built.mqtt.published.find((entry) => entry.topic === (mac + "/smokedetector"));

    assert.ok(published, "the telemetry published on the device-scoped topic");

    const payload = JSON.parse(String(published.payload)) as Record<string, unknown>;

    assert.deepEqual(Object.keys(payload).sort(), [ "alarmSilenced", "alarmSilencedAt", "batteryLow", "batteryVoltage", "cleanSmokeSensor", "coAlarm",
      "coAlarmTriggeredAt", "coSensorFault", "coValue", "enabled", "endOfLife", "ready", "smokeAlarm", "smokeAlarmTriggeredAt", "smokeSensorFault", "smokeValue",
      "testing", "troubleHushed", "troubleSilencedAt", "wasMounted" ].sort(), "the payload carries exactly the members we document and nothing else");
    assert.equal("undocumentedFutureFlag" in payload, false, "a key the wire type does not declare never reaches a subscriber");
    assert.equal(payload["alarmSilencedAt"], 1, "the alarm-silenced timestamp landed under its own name");
    assert.equal(payload["coAlarmTriggeredAt"], 2, "the carbon monoxide trip timestamp landed under its own name");
    assert.equal(payload["smokeAlarmTriggeredAt"], 3, "the smoke trip timestamp landed under its own name");
    assert.equal(payload["troubleSilencedAt"], 4, "the trouble-silenced timestamp landed under its own name");
    assert.equal(await built.mqtt.invokeGet(mac + "/smokedetector/get"), published.payload, "the get answers the identical payload the publish carries");
    assert.equal(await built.mqtt.invokeGet(mac + "/smoke/get"), "false", "the smoke get reads through the held state");
    assert.equal(await built.mqtt.invokeGet(mac + "/carbonmonoxide/get"), "false", "the carbon monoxide get reads through the held state");

    built.sensor.cleanup();
  });

  test("the detector's self-test narrates its start and its end, once each", async () => {

    const built = buildSensor({ alarmTypes: ["smoke"], smokeStatus: makeSmokeStatus(), type: "USL-Smoke-US" });

    await settle();

    assert.equal(logCount(built.logEntries, "info", "The smoke detector's self-test has started."), 0, "a detector at rest narrates no self-test");

    // The self-test as the field capture records it: testing flips true and both raw readings move, with every alarm and fault flag untouched.
    built.store.pushSensorPatch("test-sensor-1", { smokeStatus: makeSmokeStatus({ coValue: 1, smokeValue: 3410, testing: true }) });

    await settle();

    assert.equal(logCount(built.logEntries, "info", "The smoke detector's self-test has started."), 1, "the start was narrated exactly once");

    built.store.pushSensorPatch("test-sensor-1", { smokeStatus: makeSmokeStatus({ coValue: 1, smokeValue: 3400 }) });

    await settle();

    assert.equal(logCount(built.logEntries, "info", "The smoke detector's self-test has ended."), 1, "the end was narrated exactly once");

    built.sensor.cleanup();

    const testing = buildSensor({ alarmTypes: ["smoke"], smokeStatus: makeSmokeStatus({ testing: true }), type: "USL-Smoke-US" });

    await settle();

    assert.equal(logCount(testing.logEntries, "info", "The smoke detector's self-test has started."), 1, "a self-test already running at construction is narrated once");

    testing.sensor.cleanup();
  });

  test("both smoke services' StatusActive flips false when the detector goes offline on a reconcile", async () => {

    const built = buildSensor({ alarmTypes: [ "smoke", "CO" ], smokeStatus: makeSmokeStatus(), type: "USL-Smoke-US" });

    await settle();

    const smoke = built.accessory.getService(Service.SmokeSensor);
    const carbonMonoxide = built.accessory.getService(Service.CarbonMonoxideSensor);

    assert.ok(smoke, "the SmokeSensor exists");
    assert.ok(carbonMonoxide, "the CarbonMonoxideSensor exists");
    assert.equal(smoke.getCharacteristic(Characteristic.StatusActive).value, true, "the smoke StatusActive starts active (reachable)");

    built.store.pushSensorPatch("test-sensor-1", { state: "DISCONNECTED" });

    await settle();

    assert.equal(smoke.getCharacteristic(Characteristic.StatusActive).value, false, "the offline detector flipped the smoke service's StatusActive");
    assert.equal(carbonMonoxide.getCharacteristic(Characteristic.StatusActive).value, false, "and the carbon monoxide service's alongside it");

    built.sensor.cleanup();
  });

  test("StatusFault stays off every service outside the smoke family", () => {

    // The characteristic is written per smoke service and deliberately never through the shared state helper, which every sensor service passes through.
    const built = buildSensor({ alarmTypes: [ "smoke", "CO" ], smokeStatus: makeSmokeStatus(), temperatureEnabled: true, type: "USL-Smoke-US" });
    const temperature = built.accessory.getService(Service.TemperatureSensor);
    const smoke = built.accessory.getService(Service.SmokeSensor);

    assert.ok(temperature, "the TemperatureSensor exists");
    assert.ok(smoke, "the SmokeSensor exists");
    assert.equal(temperature.testCharacteristic(Characteristic.StatusFault), false, "no fault characteristic reached a service no fault flag can speak for");
    assert.equal(smoke.testCharacteristic(Characteristic.StatusFault), true, "while the smoke service carries its own");

    built.sensor.cleanup();
  });

  test("the sensor fixture reports an explicitly null smoke status, advertises no alarm types, and names no detector model by default", () => {

    const defaults = makeSensorConfig();

    assert.equal(defaults.smokeStatus, null, "a bare fixture reports no status block");
    assert.equal("smokeStatus" in defaults, true, "written explicitly, so a presence read cannot mistake an absent key for a reported block");
    assert.equal(defaults.featureFlags.alarmTypes, undefined, "a bare fixture advertises no alarm types, so it is no smoke detector");
    assert.equal("type" in defaults, false, "a bare fixture carries no type key at all, the shape the controller sends for a unit it does not type");
    assert.equal(defaults.marketName, "Test Sensor Model", "and a market name no model family claims");

    const detector = makeSensorConfig({ alarmTypes: [ "smoke", "CO" ], smokeStatus: makeSmokeStatus({ smokeAlarm: true }), type: "USL-Smoke-US" });

    assert.deepEqual(detector.featureFlags.alarmTypes, [ "smoke", "CO" ], "the advertisement override lands in featureFlags");
    assert.equal(detector.smokeStatus?.smokeAlarm, true, "the status override lands on the record");
    assert.equal(detector.type, "USL-Smoke-US", "the model override lands on the record, which is how a row says it represents detector hardware");
    assert.deepEqual(Object.keys(makeSmokeStatus()).sort(), [ "alarmSilenced", "batteryLow", "batteryVoltage", "cleanSmokeSensor", "coAlarm", "coSensorFault",
      "coValue", "enabled", "endOfLife", "ready", "smokeAlarm", "smokeSensorFault", "smokeValue", "testing", "troubleHushed", "wasMounted" ].sort(),
    "the at-rest block carries every member the wire type declares");
  });

  test("the shared narration rule seeds silently on a quiet first reading and speaks every genuine change", () => {

    // Over a boolean condition, where quiet is false: the leak, vape, detection, and self-test callers.
    assert.equal(narratesTransition({ previous: undefined, quiet: false, value: false }), false, "a first reading with nothing happening is saved silently");
    assert.equal(narratesTransition({ previous: undefined, quiet: false, value: true }), true, "a first reading of a condition already under way is spoken");
    assert.equal(narratesTransition({ previous: false, quiet: false, value: true }), true, "a genuine change is spoken");
    assert.equal(narratesTransition({ previous: true, quiet: false, value: true }), false, "an unchanged reading says nothing");

    // Over a fault-reason key, where quiet is the empty string. The last row is the one a boolean could never express: the set of reasons changed while the service
    // stayed faulted throughout, and that still earns a sentence.
    assert.equal(narratesTransition({ previous: undefined, quiet: "", value: "" }), false, "a first reading carrying no reasons is saved silently");
    assert.equal(narratesTransition({ previous: undefined, quiet: "", value: "endOfLife" }), true, "a first reading already carrying a reason is spoken");
    assert.equal(narratesTransition({ previous: "", quiet: "", value: "endOfLife" }), true, "a reason arriving is spoken");
    assert.equal(narratesTransition({ previous: "endOfLife", quiet: "", value: "endOfLife" }), false, "an unchanged reason set says nothing");
    assert.equal(narratesTransition({ previous: "endOfLife", quiet: "", value: "endOfLife,cleanSmokeSensor" }), true,
      "a reason set that changed while still non-empty is spoken");
  });

  test("each smoke service narrates its own alarm and says nothing about its sibling", async () => {

    const built = buildSensor({ alarmTypes: [ "smoke", "CO" ], smokeStatus: makeSmokeStatus(), type: "USL-Smoke-US" });

    await settle();

    built.store.pushSensorPatch("test-sensor-1", { smokeStatus: makeSmokeStatus({ smokeAlarm: true }) });

    await settle();

    assert.equal(logCount(built.logEntries, "info", "Smoke detected."), 1, "the smoke detection was narrated once");
    assert.equal(logCount(built.logEntries, "info", "Carbon monoxide detected."), 0, "and the carbon monoxide sensor said nothing about it");

    built.store.pushSensorPatch("test-sensor-1", { smokeStatus: makeSmokeStatus({ coAlarm: true, smokeAlarm: true }) });

    await settle();

    assert.equal(logCount(built.logEntries, "info", "Carbon monoxide detected."), 1, "the later carbon monoxide detection narrated its own line");
    assert.equal(logCount(built.logEntries, "info", "Smoke detected."), 1, "while the smoke line stayed at its single edge");

    built.sensor.cleanup();
  });

  // Each reconcile topic the sensor holds, with the configuration that gives it a value and the record patch that moves that value. One table drives the cadence rows
  // below, so every topic is held to the same change-gated rule rather than a sample of them.
  const RECONCILE_TOPICS: readonly { change: Parameters<TestStateStore["pushSensorPatch"]>[1]; config: Parameters<typeof makeSensorConfig>[0]; topic: string;
    userOptions?: string[]; }[] = [
    { change: { airQuality: airQualityBlock({ aqi: { status: "neutral", value: 50 } }) }, config: { airQuality: { aqi: { status: "neutral", value: 42 } } },
      topic: "airquality" },
    { change: { stats: { light: { status: "", value: 250 } } }, config: { ambientLight: 120, lightEnabled: true }, topic: "ambientlight" },
    { change: { isOpened: true }, config: { isOpened: false, mountType: "door" }, topic: "contact" },
    { change: { stats: { humidity: { status: "", value: 47.5 } } }, config: { humidity: 40, humidityEnabled: true }, topic: "humidity" },
    { change: { stats: { temperature: { status: "", value: 18.25 } } }, config: { temperature: 21.5, temperatureEnabled: true }, topic: "temperature" },
    { change: { leakDetectedAt: 1700000000000 }, config: { leakChannelNames: [ "internal", "external" ], leakDetectedAt: null, leakExternalEnabled: true,
      leakInternalEnabled: true }, topic: "leak" },
    { change: { externalLeakDetectedAt: 1700000000000 }, config: { externalLeakDetectedAt: null, leakChannelNames: [ "internal", "external" ], leakExternalEnabled: true,
      leakInternalEnabled: true }, topic: "leak-external" },
    { change: { smokeStatus: makeSmokeStatus({ smokeAlarm: true }) }, config: { alarmTypes: [ "smoke", "CO" ], smokeStatus: makeSmokeStatus(), type: "USL-Smoke-US" },
      topic: "smoke" },
    { change: { smokeStatus: makeSmokeStatus({ coAlarm: true }) }, config: { alarmTypes: [ "smoke", "CO" ], smokeStatus: makeSmokeStatus(), type: "USL-Smoke-US" },
      topic: "carbonmonoxide" },
    { change: { smokeStatus: makeSmokeStatus({ batteryLow: true }) }, config: { alarmTypes: [ "smoke", "CO" ], smokeStatus: makeSmokeStatus(), type: "USL-Smoke-US" },
      topic: "smokedetector" },
    { change: { airQuality: airQualityBlock({ vape: { status: "detected", value: null } }) }, config: { airQuality: { vape: { status: "neutral", value: null } },
      vapeEnabled: true }, topic: "vape", userOptions: ["Enable.Sensor.Vape"] }
  ];

  describe("reconcile topics publish when their value changes", () => {

    for(const row of RECONCILE_TOPICS) {

      test("the " + row.topic + " topic stays unsent on an unrelated wake and records one publish when its value changes", async () => {

        const built = buildSensor(row.config, { userOptions: row.userOptions });
        const tail = "/" + row.topic;

        await settle();

        assert.equal(built.mqtt.publishedTo(tail).length, 1, "the construction pass stated the topic once");

        // A record change that leaves this topic's value where it was still runs the whole reconcile pass.
        built.store.pushSensorPatch("test-sensor-1", { batteryStatus: { isLow: false, modelKey: "sensorBatteryStatus", percentage: 99 } });

        await settle();

        assert.equal(built.mqtt.publishedTo(tail).length, 1, "a pass that left the value unchanged published nothing for the topic");

        built.store.pushSensorPatch("test-sensor-1", row.change);

        await settle();

        const published = built.mqtt.publishedTo(tail);

        assert.equal(published.length, 2, "a pass that changed the value published it once");
        assert.equal(published[1]?.payload, await built.mqtt.invokeGet(tail + "/get"), "the published value is the one the topic's get answers");

        built.sensor.cleanup();
      });
    }
  });

  test("a fresh alarm trigger while the alarm is already sounding publishes true again", async () => {

    const built = buildSensor({ alarmEnabled: true });

    await settle();

    built.store.pushSensorPatch("test-sensor-1", { alarmTriggeredAt: 1700000000000 });

    await settle();

    built.store.pushSensorPatch("test-sensor-1", { alarmTriggeredAt: 1700000060000 });

    await settle();

    assert.deepEqual(built.mqtt.publishedTo("/alarm").map((entry) => entry.payload), [ "false", "true", "true" ],
      "the seed stated the clear alarm and each fresh trigger stated true, the repeat included");

    built.sensor.cleanup();
  });
});

describe("the sensor's held state restated per broker session", () => {

  test("a session restore restates each attached alarm row once, states no reading the sensor does not hold, and logs nothing at info or above", async () => {

    const built = buildSensor({ alarmEnabled: true });

    await settle();

    assert.deepEqual(built.mqtt.publishedTo("/alarm").map((entry) => entry.payload), ["false"], "the alarm row is stated once as the sensor is built, by its seed");

    const logged = built.logEntries.length;

    built.mqtt.connected = false;
    await settle();
    built.mqtt.connected = true;
    await settle();

    assert.deepEqual(built.mqtt.publishedTo("/alarm").map((entry) => entry.payload), [ "false", "false" ], "the restore restates the attached alarm row once");
    assert.equal(built.mqtt.publishedTo("/temperature").length, 0, "a reading the sensor does not hold is not restated");
    assert.equal(built.logEntries.slice(logged).filter((entry) => entry.level !== "debug").length, 0, "the restatement of an unchanged sensor logs nothing");
  });

  test("an alarm row the restatement's own pass attaches is stated once, by its seed", async () => {

    const built = buildSensor();

    await settle();

    // The enabling patch and the session edge land with no settle between them, so the restatement's pass is the one that attaches the row.
    built.store.pushSensorPatch("test-sensor-1", { alarmSettings: { isEnabled: true } });
    built.mqtt.connected = false;
    built.mqtt.connected = true;
    await settle();

    assert.deepEqual(built.mqtt.publishedTo("/alarm").map((entry) => entry.payload), ["false"], "the newly attached row is stated once");
  });

  // A sensor holding a temperature reading and an attached alarm row, one held state of each kind the sensor states.
  const heldState = { alarmEnabled: true, temperature: 21.5, temperatureEnabled: true };

  test("a sensor built into a held session states each reading it holds and each alarm row once", async () => {

    const built = buildSensor(heldState);

    await settle();

    assert.deepEqual(built.mqtt.publishedTo("/temperature").map((entry) => entry.payload), ["21.5"], "the reading is stated once as the sensor is built");
    assert.deepEqual(built.mqtt.publishedTo("/alarm").map((entry) => entry.payload), ["false"], "the alarm row is stated once as the sensor is built");
  });

  test("a sensor built while no session is held records nothing until the session starts, then each held state once", async () => {

    const built = buildSensor(heldState, { disconnected: true });

    await settle();

    assert.equal(built.mqtt.published.length, 0, "the statements made with no session held are refused");

    built.mqtt.connected = true;
    await settle();

    assert.deepEqual(built.mqtt.publishedTo("/temperature").map((entry) => entry.payload), ["21.5"], "the first session states the reading once");
    assert.deepEqual(built.mqtt.publishedTo("/alarm").map((entry) => entry.payload), ["false"], "the first session states the alarm row once");
  });

  test("a session restore restates the reading once and no event, and an unchanged wake after it adds nothing", async () => {

    const built = buildSensor(heldState);

    await settle();

    built.mqtt.connected = false;
    await settle();
    built.mqtt.connected = true;
    await settle();

    assert.deepEqual(built.mqtt.publishedTo("/temperature").map((entry) => entry.payload), [ "21.5", "21.5" ], "the restore restates the reading once");
    assert.equal(built.mqtt.publishedTo("/motion").length, 0, "no event topic is restated");

    const recorded = built.mqtt.published.length;

    built.store.pushSensorPatch("test-sensor-1", { batteryStatus: { isLow: false, modelKey: "sensorBatteryStatus", percentage: 99 } });
    await settle();

    assert.equal(built.mqtt.published.length, recorded, "an unchanged wake adds nothing, the gate holding the restated value");
  });

  test("a reading changed while the session is down is restated once, as the current value, when the session returns", async () => {

    const built = buildSensor(heldState);

    await settle();

    built.mqtt.connected = false;
    built.store.pushSensorPatch("test-sensor-1", { stats: { temperature: { status: "", value: 18.25 } } });
    await settle();

    const asBuilt = built.mqtt.publishedTo("/temperature").length;

    built.mqtt.connected = true;
    await settle();

    assert.deepEqual(built.mqtt.publishedTo("/temperature").slice(asBuilt).map((entry) => entry.payload), ["18.25"],
      "the returning session hears the current value once");
  });
});
