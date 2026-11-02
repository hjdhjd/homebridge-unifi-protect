/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * availability.test.ts: The No Response census, the one verdict behind it, the paths that go past it, StatusActive beside it, and the MQTT statement that reads the same
 * verdict, each driven against the REAL device, capability and controller-scoped owner classes.
 *
 * An unhandled characteristic shows in no diff: HomeKit reads it from what it holds and marks nothing, so an outage goes unseen on that accessory. The census is
 * therefore the instrument. Each row stands up one family with the flags and fixtures that give it every conditional service, settles the late binds, and reads EVERY
 * characteristic its accessory carries through HAP's own read path: refused while the controller is lost and while it is rebooting, and answered once it has recovered.
 * Under the same levers it writes every one of them HomeKit can write through HAP's own write path, each refused, because a handler bound bare accepts a write it cannot
 * deliver, which shows in no diff the same way. The characteristics outside the rule are named once, in the exemptions below, so a service a family gains is read without
 * anyone listing it here.
 *
 * The rows after the census hold the verdict to what it reads, and the paths that go past the refusal to what they keep: an MQTT set and the plugin's own writes reach
 * the device through an outage exactly as they always have, while the same characteristic refuses a HomeKit write.
 *
 * StatusActive stands on a camera's motion, occupancy and ambient light sensors and nowhere else, and it never reads from what the plugin can reach. Those rows run over
 * HAP's own camera controller, which holds the value on a recording camera's motion and occupancy sensors, and they read it through HAP's read path and from what the
 * characteristic holds.
 *
 * The MQTT rows cover each path a device's statement goes out by; the paths the controller root owns are in src/nvr/nvr.test.ts, which runs the real root.
 */
import type { Camera, Chime, Fob, Light, ProtectChimeConfig, ProtectNvrConfig, Relay, Sensor, Viewer } from "unifi-protect";
import { Characteristic, Service, TestStateStore, accessoryUuid, makeProtectState, makeTestAccessory, writesTo } from "../testing.helpers.ts";
import { G2_PRO_CHANNELS, G6_PRO_ENTRY_CHANNELS } from "../camera.fixtures.ts";
import { HAPStatus, Perms } from "homebridge-plugin-utils";
import type { ProtectAccessory, ProtectDevices } from "../types.ts";
import { TestBaseDevice, TestCameraProjection, TestChimeProjection, TestFobProjection, TestLightProjection, TestRelayProjection, TestSensorProjection,
  TestViewerProjection, makeCameraConfig, makeChimeConfig, makeFobConfig, makeLightConfig, makeLiveviewConfig, makeRelayConfig, makeRingtoneConfig, makeSensorConfig,
  makeSmokeStatus, makeViewerConfig } from "./testing.helpers.ts";
import { afterEach, describe, test } from "node:test";
import { hapStatus, loggedAt, settle, triggerGet, triggerSet } from "homebridge-plugin-utils/testing";
import { makeNvrConfig, makeTestNvr } from "../nvr/testing.helpers.ts";
import type { CharacteristicValue } from "homebridge";
import { PROTECT_DEVICE_REMOVAL_DELAY_INTERVAL } from "../settings.ts";
import { ProtectCamera } from "./cameras/camera.ts";
import { ProtectChime } from "./chime.ts";
import { ProtectFob } from "./fob.ts";
import { ProtectLight } from "./light.ts";
import { ProtectLiveviews } from "../liveviews/liveviews.ts";
import type { ProtectNvr } from "../nvr/nvr.ts";
import { ProtectNvrSystemInfo } from "../nvr/nvr-systeminfo.ts";
import { ProtectRelay } from "./relay.ts";
import { ProtectReservedNames } from "../types.ts";
import { ProtectSensor } from "./sensor.ts";
import { ProtectViewer } from "./viewer.ts";
import type { TestMqttClient } from "homebridge-plugin-utils/testing";
import type { TestProtectAccessory } from "../testing.helpers.ts";
import type { TestProtectNvr } from "../nvr/testing.helpers.ts";
import assert from "node:assert/strict";
import { configured } from "./device-base.ts";

// The controller MAC makeNvrConfig carries, which the controller-scoped accessories seed their UUIDs from.
const CONTROLLER_MAC = "74ACB9FFFFFF";

// The characteristics no owner refuses, wherever they sit: the names HomeKit reads as identity and the user edits, the air-quality readings HBPU's presence helper binds
// its own handler to, since the sensor's state characteristic refusing marks the whole accessory anyway, and the event HAP answers null for without asking anyone.
const EXEMPT_CHARACTERISTICS = new Set([ Characteristic.CarbonDioxideLevel.UUID, Characteristic.ConfiguredName.UUID, Characteristic.Name.UUID,
  Characteristic.PM10Density.UUID, Characteristic.PM2_5Density.UUID, Characteristic.ProgrammableSwitchEvent.UUID ]);

// The services HAP's camera controller owns outright, which it serves through handlers of its own, and those it shares, where only the characteristics named refuse. HAP
// takes a write to the rest of a shared service itself, the camera's operating-mode switches among them.
const HAP_SERVED_SERVICES = new Set([ Service.CameraRecordingManagement.UUID, Service.DataStreamTransportManagement.UUID, Service.Microphone.UUID,
  Service.Speaker.UUID ]);
const REFUSING_ON_HAP_SERVICES = new Map([ [ Service.CameraOperatingMode.UUID, [ Characteristic.CameraOperatingModeIndicator.UUID, Characteristic.NightVision.UUID ] ],
  [ Service.CameraRTPStreamManagement.UUID, [Characteristic.StreamingStatus.UUID] ] ]);

// A service kind as a row names one.
interface ServiceKind {

  readonly UUID: string;
  readonly name: string;
}

/* Every characteristic on an accessory the rule covers. HomeKit reads each of these and writes those carrying the paired-write permission, so each must refuse, and the
 * list comes from the accessory rather than from the row, so a characteristic a family gains is read with nobody naming it.
 *
 * @param accessory - The accessory to read.
 *
 * @returns Each covered characteristic, labeled with its service for a failure message.
 */
function coveredCharacteristics(accessory: ProtectAccessory): { characteristic: Characteristic; label: string }[] {

  return accessory.services.filter((service) => (service.UUID !== Service.AccessoryInformation.UUID) && !HAP_SERVED_SERVICES.has(service.UUID)).flatMap((service) => {

    const refusing = REFUSING_ON_HAP_SERVICES.get(service.UUID);

    return service.characteristics.filter(({ UUID }) => !EXEMPT_CHARACTERISTICS.has(UUID) && (!refusing || refusing.includes(UUID)))
      .map((characteristic) => ({ characteristic, label: accessory.displayName + " / " + service.displayName + " / " + characteristic.displayName }));
  });
}

/* Read every covered characteristic while the controller is lost and while it is rebooting, and write each one HomeKit can write, each refused with the status HomeKit
 * shows as No Response, then read each once it has recovered, answered. A write of the value it holds keeps a row's request valid whatever the characteristic's range, so
 * the refusal is the only thing it can meet. A row names the services its fixture is there to stand up, so a fixture that stopped standing one up reddens rather than
 * reading less.
 *
 * @param options             - The census to run.
 * @param options.accessories - The accessories to read.
 * @param options.nvr         - The controller double whose connection levers the row moves.
 * @param options.services    - The services the fixture stands up, each as its kind and, where it has one, its subtype.
 */
async function assertCensus({ accessories, nvr, services }: { accessories: ProtectAccessory[]; nvr: TestProtectNvr;
  services: [ ServiceKind, string? ][]; }): Promise<void> {

  for(const [ kind, subtype ] of services) {

    const stands = accessories.some((accessory) => accessory.services.some((service) => (service.UUID === kind.UUID) &&
      ((subtype === undefined) || (service.subtype === subtype))));

    assert.ok(stands, "the fixture stood up the " + kind.name + " service" + ((subtype === undefined) ? "" : " " + subtype));
  }

  const covered = accessories.flatMap(coveredCharacteristics);

  assert.ok(covered.length, "the census read something");

  for(const lever of [ "isLost", "isRebooting" ] as const) {

    nvr.client.connection[lever] = true;

    for(const { characteristic, label } of covered) {

      // eslint-disable-next-line no-await-in-loop -- Each read is its own assertion, and the order keeps a failure's message about the first characteristic it reached.
      await assert.rejects(triggerGet(characteristic), hapStatus(HAPStatus.SERVICE_COMMUNICATION_FAILURE), label + " refuses while the controller reads " + lever);

      if(characteristic.props.perms.includes(Perms.PAIRED_WRITE)) {

        // eslint-disable-next-line no-await-in-loop -- As above.
        await assert.rejects(triggerSet(characteristic, characteristic.value ?? false), hapStatus(HAPStatus.SERVICE_COMMUNICATION_FAILURE),
          label + " refuses a write while the controller reads " + lever);
      }
    }

    nvr.client.connection[lever] = false;
  }

  for(const { characteristic, label } of covered) {

    // eslint-disable-next-line no-await-in-loop -- As above.
    await assert.doesNotReject(triggerGet(characteristic), label + " answers once the controller has recovered");
  }
}

// Every harness controller this suite opens, drained after each test so its lifetime signal bounds each test's constructions.
const controllers: AbortController[] = [];

const abortControllers = (): void => {

  for(const controller of controllers.splice(0)) {

    controller.abort();
  }
};

// The handles a stood-up family hands back: its log, the MQTT double, and the controller double and store behind it.
type NvrHarness = Pick<ReturnType<typeof makeTestNvr>, "logEntries"> & { mqtt: TestMqttClient; nvr: TestProtectNvr; store: TestStateStore };

// Build the controller double a family stands on, the MQTT double always present, and hold its controller for the teardown above.
function standNvr(store: TestStateStore, options: Omit<Parameters<typeof makeTestNvr>[0], "mqtt" | "store"> = {}):
NvrHarness & { factory: ReturnType<typeof makeTestNvr>["factory"] } {

  const { controller, factory, logEntries, mqtt, nvr } = makeTestNvr({ ...options, mqtt: true, store });

  controllers.push(controller);

  if(!mqtt) {

    throw new Error("The MQTT recording double was not installed despite mqtt: true.");
  }

  return { factory, logEntries, mqtt, nvr, store };
}

/* Stand a REAL camera up against the harness doubles and settle its late binds, the reconcile and streaming block and the ambient light after its first read among them.
 * Its delegates carry HAP's own camera controller, so the accessory carries the services a real registration gives it.
 *
 * @param options - The camera's record and the options it runs under.
 *
 * @returns The camera and its handles.
 */
async function standCamera(options: { chimes?: ProtectChimeConfig[]; config?: Parameters<typeof makeCameraConfig>[0];
  doorbellSettings?: ProtectNvrConfig["doorbellSettings"]; restored?: TestProtectAccessory; seed?: (accessory: TestProtectAccessory) => void;
  userOptions?: string[]; } = {}): Promise<NvrHarness & { accessory: TestProtectAccessory; camera: ProtectCamera; chimeProjections: TestChimeProjection[] }> {

  const config = makeCameraConfig(options.config ?? { channels: G2_PRO_CHANNELS });
  const chimes = options.chimes ?? [];
  const store = new TestStateStore(makeProtectState({ cameras: [config], ...(chimes.length ? { chimes } : {}) }));
  const chimeProjections = chimes.map((chime) => new TestChimeProjection(chime.id, store));
  const { factory, logEntries, mqtt, nvr } = standNvr(store, { chimes: chimeProjections,
    ...(options.doorbellSettings !== undefined ? { doorbellSettings: options.doorbellSettings } : {}), userOptions: options.userOptions });

  factory.realControllers = true;

  const accessory = options.restored ?? makeTestAccessory(config.name ?? "Test Camera", config.mac);

  options.seed?.(accessory);

  const camera = configured(new ProtectCamera(nvr as unknown as ProtectNvr, accessory, new TestCameraProjection(config.id, store) as unknown as Camera));

  await settle();

  assert.equal(nvr.platform.claims.get(accessory.UUID), camera, "the camera claimed its accessory at the end of its configure");

  return { accessory, camera, chimeProjections, logEntries, mqtt, nvr, store };
}

// Stand a REAL sensor up against the harness doubles.
function standSensor(config: Parameters<typeof makeSensorConfig>[0], userOptions: string[] = []): NvrHarness & { accessory: TestProtectAccessory } {

  const record = makeSensorConfig(config);
  const store = new TestStateStore(makeProtectState({ sensors: [record] }));
  const { logEntries, mqtt, nvr } = standNvr(store, { userOptions });
  const accessory = makeTestAccessory("Test Sensor", record.mac);

  configured(new ProtectSensor(nvr as unknown as ProtectNvr, accessory, new TestSensorProjection(record.id, store) as unknown as Sensor));

  return { accessory, logEntries, mqtt, nvr, store };
}

// Stand a REAL relay up against the harness doubles.
function standRelay(config: ReturnType<typeof makeRelayConfig>, userOptions: string[] = []): NvrHarness & { accessory: TestProtectAccessory;
  projection: TestRelayProjection; } {

  const store = new TestStateStore(makeProtectState({ relays: [config] }));
  const { logEntries, mqtt, nvr } = standNvr(store, { userOptions });
  const accessory = makeTestAccessory("Test Relay", config.mac);
  const projection = new TestRelayProjection(config.id, store);

  configured(new ProtectRelay(nvr as unknown as ProtectNvr, accessory, projection as unknown as Relay));

  return { accessory, logEntries, mqtt, nvr, projection, store };
}

// Stand a REAL fob up against the harness doubles.
function standFob(config: ReturnType<typeof makeFobConfig>, userOptions: string[] = []): NvrHarness & { accessory: TestProtectAccessory; fob: ProtectFob } {

  const store = new TestStateStore(makeProtectState({ fobs: [config] }));
  const { logEntries, mqtt, nvr } = standNvr(store, { userOptions });
  const accessory = makeTestAccessory("Test Fob", config.mac);
  const fob = configured(new ProtectFob(nvr as unknown as ProtectNvr, accessory, new TestFobProjection(config.id, store) as unknown as Fob));

  return { accessory, fob, logEntries, mqtt, nvr, store };
}

// Stand the REAL liveviews owner up against the harness doubles, over a liveview that calls for a switch, one that calls for the security system, and any a row adds.
function standLiveviews(extraLiveviews: Parameters<typeof makeLiveviewConfig>[0][] = []): NvrHarness & { accessories: ProtectAccessory[]; owner: ProtectLiveviews } {

  const liveviews = [ makeLiveviewConfig({ id: "scene", name: "Protect-Scene" }), makeLiveviewConfig({ id: "away", name: "Protect-Away" }),
    ...extraLiveviews.map((options) => makeLiveviewConfig(options)) ];
  const store = new TestStateStore(makeProtectState({ liveviews, nvr: makeNvrConfig({ hardwareRevision: "1.0" }) }));
  const { logEntries, mqtt, nvr } = standNvr(store, { userOptions: ["Enable.SecuritySystem.Alarm"] });
  const owner = configured(new ProtectLiveviews(nvr as unknown as ProtectNvr));

  owner.configureLiveviews();

  return { accessories: nvr.platform.accessories, logEntries, mqtt, nvr, owner, store };
}

// The doorbell settings shell the controller sends, around one saved message.
const DOORBELL_SETTINGS = { allMessages: [{ text: "Back soon", type: "CUSTOM_MESSAGE" }], customImages: [], customMessages: [], defaultMessageResetTimeoutMs: 60000,
  defaultMessageText: "" } as unknown as ProtectNvrConfig["doorbellSettings"];

// The base switches and sensor every family that can carry them shares.
const BASE_SWITCHES = [ "Enable.Device.StatusLed.Switch", "Enable.Motion.OccupancySensor", "Enable.Motion.Switch", "Enable.Motion.Trigger" ];

describe("the No Response census", () => {

  afterEach(abortControllers);

  // The camera's whole conditional surface but the doorbell's: the recording arm's services, the operating-mode characteristics, smart detection and plates, tamper, the
  // Access lock, the ambient light after its first read, the night vision dimmer, and the recording switches.
  test("an HKSV camera refuses on every characteristic, and StreamingStatus answers what HAP writes once the controller has recovered", async () => {

    const { accessory, nvr } = await standCamera({

      config: { accessDeviceMetadata: { featureFlags: { supportUnlock: true } }, channels: G2_PRO_CHANNELS, featureFlags: { hasIcrSensitivity: true, hasInfrared: true,
        hasLedStatus: true, hasLuxCheck: true, hasSmartDetect: true, hasTamperDetection: true, smartDetectTypes: [ "licensePlate", "person" ] },
      smartDetectSettings: { enableTamperDetection: true, objectTypes: [ "licensePlate", "person" ] } },
      userOptions: [ ...BASE_SWITCHES, "Enable.Device.NightVision.Dimmer", "Enable.Motion.SmartDetect", "Enable.Motion.SmartDetect.ObjectSensors",
        "Enable.Motion.SmartDetect.ObjectSensors.LicensePlate=ABC123", "Enable.Nvr.Recording.Switch", "Enable.Video.HKSV.Recording.Switch" ]
    });

    await assertCensus({ accessories: [accessory], nvr, services: [ [Service.CameraOperatingMode], [Service.CameraRTPStreamManagement],
      [Service.CameraRecordingManagement], [Service.LightSensor], [Service.LockMechanism], [Service.MotionSensor], [Service.OccupancySensor],
      [ Service.ContactSensor, ProtectReservedNames.CONTACT_MOTION_SMARTDETECT + ".person" ],
      [ Service.ContactSensor, ProtectReservedNames.CONTACT_MOTION_SMARTDETECT_LICENSE + ".ABC123" ],
      [ Service.Lightbulb, ProtectReservedNames.LIGHTBULB_NIGHTVISION ], [ Service.Switch, ProtectReservedNames.SWITCH_HKSV_RECORDING ],
      [ Service.Switch, ProtectReservedNames.SWITCH_MOTION_SENSOR ], [ Service.Switch, ProtectReservedNames.SWITCH_MOTION_TRIGGER ],
      [ Service.Switch, ProtectReservedNames.SWITCH_STATUS_LED ], [ Service.Switch, ProtectReservedNames.SWITCH_UFP_RECORDING_ALWAYS ] ] });

    // The motion sensor's tamper characteristic is optional, so its binding follows its gate, and the operating-mode characteristics are the plugin's on HAP's service.
    assert.ok(accessory.getService(Service.MotionSensor)?.testCharacteristic(Characteristic.StatusTampered), "tamper detection attached StatusTampered");
    assert.ok(accessory.getService(Service.CameraOperatingMode)?.testCharacteristic(Characteristic.NightVision), "the operating mode carries night vision");
    assert.ok(accessory.getService(Service.CameraOperatingMode)?.testCharacteristic(Characteristic.CameraOperatingModeIndicator), "and the status light");

    const stream = accessory.getService(Service.CameraRTPStreamManagement)?.getCharacteristic(Characteristic.StreamingStatus);

    assert.ok(stream, "a registration gives the accessory a stream-management service");

    // HAP writes IN_USE at a session's start through its own stream management, which is the path this drives. The TLV is the status tag, length one, then IN_USE.
    const { activeCameraController } = accessory._associatedHAPAccessory as unknown as { activeCameraController: { streamManagements: {
      _updateStreamStatus: (status: number) => void; }[]; }; };

    activeCameraController.streamManagements[0]?._updateStreamStatus(1);

    assert.equal(await triggerGet(stream), Buffer.from([ 1, 1, 1 ]).toString("base64"), "StreamingStatus answers the IN_USE HAP wrote there");
  });

  // A camera the controller reports no motion detection for stands up no motion sensor and no recording arm, so StreamingStatus is the one characteristic it has to
  // refuse with, which is why it binds wherever a controller registers.
  test("a camera with no motion detection still refuses, on StreamingStatus alone", async () => {

    const { accessory, nvr } = await standCamera({ config: { channels: G2_PRO_CHANNELS, featureFlags: { hasMotionDetection: false } } });

    assert.equal(accessory.getService(Service.MotionSensor), undefined, "the fixture is a camera with no motion sensor");

    await assertCensus({ accessories: [accessory], nvr, services: [[Service.CameraRTPStreamManagement]] });

    assert.deepEqual(coveredCharacteristics(accessory).map(({ characteristic }) => characteristic.UUID), [Characteristic.StreamingStatus.UUID],
      "StreamingStatus is the one characteristic standing between this camera and answering through an outage");
  });

  // The doorbell's services and its package camera's, each read on its own accessory, the package camera's flashlight and its controller among them.
  test("a doorbell and its package camera refuse on every characteristic", async () => {

    const { accessory, camera, nvr } = await standCamera({

      chimes: [makeChimeConfig({ cameraIds: ["test-camera-1"], ringSettings: [{ cameraId: "test-camera-1", volume: 50 }] })],
      config: { channels: G6_PRO_ENTRY_CHANNELS, enableNfc: true, featureFlags: { hasChime: true, hasFingerprintSensor: true, hasLcdScreen: true, hasPackageCamera: true,
        isDoorbell: true } },
      doorbellSettings: DOORBELL_SETTINGS,
      userOptions: [ "Enable.Doorbell.AuthSensor", "Enable.Doorbell.Messages", "Enable.Doorbell.Mute", "Enable.Doorbell.PhysicalChime", "Enable.Doorbell.Trigger",
        "Enable.Doorbell.Volume.Dimmer" ]
    });
    const packageAccessory = camera.doorbell?.packageCamera?.accessory;

    assert.ok(packageAccessory, "the doorbell stood its package camera up");
    assert.equal(nvr.platform.claims.get(packageAccessory.UUID), camera.doorbell?.packageCamera, "the package camera claimed its own accessory");

    await assertCensus({ accessories: [ accessory, packageAccessory ], nvr, services: [ [Service.Doorbell],
      [ Service.ContactSensor, ProtectReservedNames.CONTACT_AUTHSENSOR ], [ Service.Lightbulb, ProtectReservedNames.LIGHTBULB_DOORBELL_VOLUME ],
      [ Service.Lightbulb, ProtectReservedNames.LIGHTBULB_PACKAGE_FLASHLIGHT ], [ Service.Switch, "CUSTOM_MESSAGE.Back soon" ],
      [ Service.Switch, ProtectReservedNames.SWITCH_DOORBELL_CHIME_DIGITAL ], [ Service.Switch, ProtectReservedNames.SWITCH_DOORBELL_MUTE ],
      [ Service.Switch, ProtectReservedNames.SWITCH_DOORBELL_TRIGGER ] ] });

    assert.equal(coveredCharacteristics(packageAccessory).filter(({ characteristic }) => characteristic.UUID === Characteristic.StreamingStatus.UUID).length, 1,
      "the package camera's controller gave it a StreamingStatus of its own to refuse on");
  });

  // One sensor can carry most of its services at once, and the modes that exclude each other, or that read another model, take the rows behind this one.
  test("a sensor's contact, motion, environmental and alarm services refuse on every characteristic", async () => {

    const { accessory, nvr } = standSensor({ alarmEnabled: true, ambientLight: 250, glassBreak: true, glassBreakEnabled: true, humidity: 55, humidityEnabled: true,
      lightEnabled: true, motionEnabled: true, mountType: "door", temperature: 21.5, temperatureEnabled: true }, BASE_SWITCHES);

    await settle();

    await assertCensus({ accessories: [accessory], nvr, services: [ [Service.Battery], [Service.HumiditySensor], [Service.LightSensor], [Service.MotionSensor],
      [Service.OccupancySensor], [Service.TemperatureSensor], [ Service.ContactSensor, ProtectReservedNames.CONTACT_SENSOR ],
      [ Service.ContactSensor, ProtectReservedNames.CONTACT_SENSOR_ALARM_SOUND ], [ Service.ContactSensor, ProtectReservedNames.CONTACT_SENSOR_GLASS_BREAK ],
      [ Service.Switch, ProtectReservedNames.SWITCH_MOTION_SENSOR ], [ Service.Switch, ProtectReservedNames.SWITCH_MOTION_TRIGGER ],
      [ Service.Switch, ProtectReservedNames.SWITCH_STATUS_LED ] ] });
  });

  test("a sensor's leak service refuses on every characteristic, as a leak sensor and as its moisture variant", async () => {

    const leak = standSensor({ leakChannelNames: ["internal"], mountType: "leak" });
    const moisture = standSensor({ leakChannelNames: ["internal"], mountType: "leak" }, ["Enable.Sensor.MoistureSensor"]);

    await settle();

    await assertCensus({ accessories: [leak.accessory], nvr: leak.nvr, services: [[ Service.LeakSensor, ProtectReservedNames.LEAKSENSOR_INTERNAL ]] });
    await assertCensus({ accessories: [moisture.accessory], nvr: moisture.nvr, services: [[ Service.ContactSensor, ProtectReservedNames.LEAKSENSOR_INTERNAL ]] });
  });

  test("a smoke detector's smoke and carbon monoxide services refuse on every characteristic", async () => {

    const { accessory, nvr } = standSensor({ alarmTypes: [ "smoke", "CO" ], smokeStatus: makeSmokeStatus(), type: "USL-Smoke-US" });

    await settle();

    await assertCensus({ accessories: [accessory], nvr, services: [ [Service.CarbonMonoxideSensor], [Service.SmokeSensor] ] });
  });

  // The densities and the carbon dioxide level stay answerable, as the census's exemption says: the service's state characteristic refusing marks the accessory.
  test("an air quality sensor's air quality, carbon dioxide and vape services refuse on every characteristic but the readings HBPU binds", async () => {

    const metric = (value: number): { status: "neutral"; value: number } => ({ status: "neutral", value });
    const { accessory, nvr } = standSensor({ airQuality: { aqi: metric(42), co2: metric(600), pm10p0: metric(5), pm2p5: metric(3), vape: metric(0) }, co2Enabled: true,
      co2Threshold: 1000, vapeEnabled: true }, ["Enable.Sensor.Vape"]);

    await settle();

    await assertCensus({ accessories: [accessory], nvr, services: [ [Service.AirQualitySensor], [Service.CarbonDioxideSensor],
      [ Service.ContactSensor, ProtectReservedNames.CONTACT_SENSOR_VAPE ] ] });

    const quality = accessory.getService(Service.AirQualitySensor);

    assert.ok(quality, "the fixture stood up the air quality service");
    assert.ok(quality.testCharacteristic(Characteristic.PM2_5Density), "the fixture attached the density HBPU binds");

    nvr.client.connection.isLost = true;

    assert.equal(await triggerGet(quality.getCharacteristic(Characteristic.PM2_5Density)), 3, "HBPU's handler answers through the outage, as the standard accepts");
  });

  test("a light refuses on every characteristic", async () => {

    const config = makeLightConfig();
    const store = new TestStateStore(makeProtectState({ lights: [config] }));
    const { nvr } = standNvr(store, { userOptions: BASE_SWITCHES });
    const accessory = makeTestAccessory("Test Light", config.mac);
    const light = configured(new ProtectLight(nvr as unknown as ProtectNvr, accessory, new TestLightProjection(config.id, store) as unknown as Light));

    assert.equal(nvr.platform.claims.get(accessory.UUID), light, "the light claimed its accessory");

    await assertCensus({ accessories: [accessory], nvr, services: [ [Service.Lightbulb], [Service.MotionSensor], [Service.OccupancySensor],
      [ Service.Switch, ProtectReservedNames.SWITCH_STATUS_LED ] ] });
  });

  test("a chime refuses on every characteristic", async () => {

    const config = makeChimeConfig();
    const store = new TestStateStore(makeProtectState({ chimes: [config], ringtones: [makeRingtoneConfig()] }));
    const { nvr } = standNvr(store);
    const accessory = makeTestAccessory("Test Chime", config.mac);

    configured(new ProtectChime(nvr as unknown as ProtectNvr, accessory, new TestChimeProjection(config.id, store) as unknown as Chime));

    await assertCensus({ accessories: [accessory], nvr, services: [ [ Service.Switch, ProtectReservedNames.SWITCH_DOORBELL_CHIME_BUZZER ],
      [ Service.Switch, ProtectReservedNames.SWITCH_DOORBELL_CHIME_SPEAKER + ".test-ringtone-1" ] ] });
  });

  test("a relay refuses on every characteristic", async () => {

    const { accessory, nvr } = standRelay(makeRelayConfig(), ["Enable.Device.StatusLed.Switch"]);

    await assertCensus({ accessories: [accessory], nvr, services: [ [ Service.Switch, ProtectReservedNames.SWITCH_RELAY_OUTPUT + ".0" ],
      [ Service.Switch, ProtectReservedNames.SWITCH_RELAY_OUTPUT + ".1" ], [ Service.Switch, ProtectReservedNames.SWITCH_STATUS_LED ] ] });
  });

  test("a viewer refuses on every characteristic", async () => {

    const config = makeViewerConfig();
    const store = new TestStateStore(makeProtectState({ liveviews: [makeLiveviewConfig()], viewers: [config] }));
    const { nvr } = standNvr(store);
    const accessory = makeTestAccessory("Test Viewer", config.mac);

    configured(new ProtectViewer(nvr as unknown as ProtectNvr, accessory, new TestViewerProjection(config.id, store) as unknown as Viewer));

    await assertCensus({ accessories: [accessory], nvr, services: [[ Service.Switch, "test-liveview-1" ]] });
  });

  // A fob reads disconnected whenever it is idle, so each fob row reads a record the controller says that about: the fob answers until the controller itself is lost.
  for(const [ label, userOptions, services ] of [
    [ "lone-button", ["Enable.Fob.Buttons=arm"], [[Service.Battery]] ],
    [ "grouped", [], [ [Service.Battery], [Service.ServiceLabel] ] ]
  ] as [ string, string[], [ServiceKind][] ][]) {

    test("a " + label + " fob reading DISCONNECTED answers, and refuses on every characteristic once the controller is lost or rebooting", async () => {

      const { accessory, nvr, store } = standFob(makeFobConfig(), userOptions);

      store.pushFobPatch("test-fob-1", { state: "DISCONNECTED" });

      await assertCensus({ accessories: [accessory], nvr, services });

      assert.equal(accessory.getService(Service.ServiceLabel) !== undefined, label === "grouped", "the fixture is the " + label + " shape");

      const button = accessory.services.find(({ UUID }) => UUID === Service.StatelessProgrammableSwitch.UUID);

      assert.equal(button?.testCharacteristic(Characteristic.ServiceLabelIndex), label === "grouped", "the optional index binds only where the grouping kept it");
    });
  }

  test("a liveview switch and the security system refuse on every characteristic", async () => {

    const { accessories, nvr, owner } = standLiveviews();
    const security = accessories.find(({ UUID }) => UUID === accessoryUuid(CONTROLLER_MAC + ".Security"));
    const liveview = accessories.find(({ UUID }) => UUID === accessoryUuid(CONTROLLER_MAC + ".Liveview.SCENE"));

    assert.ok(security && liveview, "the liveviews stood up the security system and a switch");
    assert.equal(nvr.platform.claims.get(liveview.UUID), owner, "the liveview switch's owner claimed it");
    assert.ok(nvr.platform.claims.has(security.UUID), "and the security system claimed its own accessory");

    await assertCensus({ accessories: [ liveview, security ], nvr, services: [ [Service.SecuritySystem], [Service.Switch] ] });
  });

  test("the system information accessory refuses on every characteristic", async () => {

    const store = new TestStateStore(makeProtectState());
    const { nvr } = standNvr(store, { userOptions: ["Enable.Nvr.SystemInfo"] });
    const owner = configured(new ProtectNvrSystemInfo(nvr as unknown as ProtectNvr));
    const accessory = nvr.platform.accessories.find(({ UUID }) => UUID === accessoryUuid(CONTROLLER_MAC + ".NVRSystemInfo"));

    assert.ok(accessory, "the owner stood its accessory up");
    assert.equal(nvr.platform.claims.get(accessory.UUID), owner, "the owner claimed its accessory");

    await assertCensus({ accessories: [accessory], nvr, services: [[Service.TemperatureSensor]] });
  });
});

describe("the availability verdict", () => {

  afterEach(abortControllers);

  // The verdict reads the library's loss and reboot facts and nothing else about the connection. isHealthy is false at the first fault, through a re-bootstrap and while
  // the request breaker is open, and refusing on those would mark every accessory for a blip the library is already handling.
  test("a controller that is degraded answers, where one that is lost or rebooting refuses", async () => {

    const { accessory, fob, nvr } = standFob(makeFobConfig());
    const battery = accessory.getService(Service.Battery)?.getCharacteristic(Characteristic.BatteryLevel);

    assert.ok(battery, "the fob carries its battery");

    nvr.client.connection.isHealthy = false;

    assert.equal(fob.isAvailable, true, "an unhealthy connection that has not concluded a loss leaves the verdict standing");

    await assert.doesNotReject(triggerGet(battery));

    nvr.client.connection.isLost = true;

    assert.equal(fob.isAvailable, false, "a concluded loss turns it");

    await assert.rejects(triggerGet(battery), hapStatus(HAPStatus.SERVICE_COMMUNICATION_FAILURE));

    nvr.client.connection.isLost = false;
    nvr.client.connection.isRebooting = true;

    assert.equal(fob.isAvailable, false, "and so does a reboot");
  });

  // Every family but the fob reads the controller's connection report on the device: a viewer or a camera reporting disconnected is really offline.
  test("a viewer and a camera reading DISCONNECTED refuse behind a reachable controller, and answer once they read connected", async () => {

    const viewerConfig = makeViewerConfig();
    const viewerStore = new TestStateStore(makeProtectState({ liveviews: [makeLiveviewConfig()], viewers: [viewerConfig] }));
    const { nvr: viewerNvr } = standNvr(viewerStore);
    const viewerAccessory = makeTestAccessory("Test Viewer", viewerConfig.mac);
    const viewer = configured(new ProtectViewer(viewerNvr as unknown as ProtectNvr, viewerAccessory,
      new TestViewerProjection(viewerConfig.id, viewerStore) as unknown as Viewer));
    const viewerSwitch = viewerAccessory.getServiceById(Service.Switch, "test-liveview-1")?.getCharacteristic(Characteristic.On);

    assert.ok(viewerSwitch, "the viewer carries its liveview switch");

    viewerStore.pushViewerPatch(viewerConfig.id, { state: "DISCONNECTED" });

    assert.equal(viewer.isAvailable, false, "a disconnected viewer is offline");

    await assert.rejects(triggerGet(viewerSwitch), hapStatus(HAPStatus.SERVICE_COMMUNICATION_FAILURE));

    viewerStore.pushViewerPatch(viewerConfig.id, { state: "CONNECTED" });

    assert.equal(viewer.isAvailable, true, "and answers again once it is back");

    const { accessory, camera, store } = await standCamera();
    const motion = accessory.getService(Service.MotionSensor)?.getCharacteristic(Characteristic.MotionDetected);

    assert.ok(motion, "the camera carries its motion sensor");

    store.pushCameraPatch("test-camera-1", { state: "DISCONNECTED" });

    await settle();

    assert.equal(camera.isAvailable, false, "a disconnected camera is offline");

    await assert.rejects(triggerGet(motion), hapStatus(HAPStatus.SERVICE_COMMUNICATION_FAILURE));
  });

  // A record gone from the store, and one another controller adopted or this one let go of, are each no device the plugin can vouch for.
  test("a vanished record and an unadopted one each refuse", async () => {

    const { accessory, camera, store } = await standCamera();
    const motion = accessory.getService(Service.MotionSensor)?.getCharacteristic(Characteristic.MotionDetected);

    assert.ok(motion, "the camera carries its motion sensor");

    store.pushCameraPatch("test-camera-1", { isAdopted: false });

    assert.equal(camera.isAvailable, false, "a device this controller no longer holds as adopted refuses");

    store.pushCameraPatch("test-camera-1", { isAdopted: true, isAdoptedByOther: true });

    assert.equal(camera.isAvailable, false, "and so does one another controller adopted");

    await assert.rejects(triggerGet(motion), hapStatus(HAPStatus.SERVICE_COMMUNICATION_FAILURE));

    store.pushCameraPatch("test-camera-1", { isAdoptedByOther: false });

    assert.equal(camera.isAvailable, true, "the adoption flags are what moved it");

    store.removeCameraRecord("test-camera-1");

    assert.equal(camera.isAvailable, false, "and a record that has vanished refuses rather than throwing");

    await assert.rejects(triggerGet(motion), hapStatus(HAPStatus.SERVICE_COMMUNICATION_FAILURE));
  });

  // The fob's exemption is from the connection report alone: its adoption still reads, and so does the controller's verdict.
  test("an unadopted fob refuses, whatever its connection reads", async () => {

    const { accessory, fob, store } = standFob(makeFobConfig());
    const battery = accessory.getService(Service.Battery)?.getCharacteristic(Characteristic.BatteryLevel);

    assert.ok(battery, "the fob carries its battery");

    store.pushFobPatch("test-fob-1", { state: "DISCONNECTED" });

    assert.equal(fob.isAvailable, true, "an idle fob reading disconnected is still there");

    store.pushFobPatch("test-fob-1", { isAdopted: false });

    assert.equal(fob.isAvailable, false, "an unadopted fob is not");

    await assert.rejects(triggerGet(battery), hapStatus(HAPStatus.SERVICE_COMMUNICATION_FAILURE));
  });

  // The package camera's record is its parent's, which stays standing through the package camera's own detach, so the pending removal is what turns its verdict.
  test("a package camera refuses while its detach is pending, its parent answering, and answers again if the detach is cancelled", async () => {

    const { camera, nvr, store } = await standCamera({ config: { channels: G6_PRO_ENTRY_CHANNELS, featureFlags: { hasMic: true, hasPackageCamera: true,
      isDoorbell: true } } });
    const packageCamera = camera.doorbell?.packageCamera;

    assert.ok(packageCamera, "the doorbell stood its package camera up");
    assert.equal(packageCamera.isAvailable, true, "a package camera with no detach pending answers");

    store.pushCameraFeatureFlags("test-camera-1", { hasPackageCamera: false });

    await settle();

    assert.equal(nvr.removals.isPending(packageCamera.accessory.UUID), true, "the withdrawal scheduled the graced detach");
    assert.equal(packageCamera.isAvailable, false, "the package camera refuses through its grace");
    assert.equal(camera.isAvailable, true, "its parent keeps answering, since nothing about the parent is leaving");

    const motion = packageCamera.accessory.getService(Service.MotionSensor)?.getCharacteristic(Characteristic.MotionDetected);

    assert.ok(motion, "the package camera carries its motion sensor");

    await assert.rejects(triggerGet(motion), hapStatus(HAPStatus.SERVICE_COMMUNICATION_FAILURE));

    store.pushCameraFeatureFlags("test-camera-1", { hasPackageCamera: true });

    await settle();

    assert.equal(packageCamera.isAvailable, true, "a capability that returns within the grace cancels the detach, and the verdict with it");
  });

  // A capability's services live on its host's accessory, so a capability answers its host's verdict, the camera's own connection report included, rather than the
  // controller's. The census moves only the controller's levers, so this row is what reads the difference.
  test("a doorbell reading DISCONNECTED refuses on a capability's characteristic behind a reachable controller, and answers once it reads connected", async () => {

    const { accessory, store } = await standCamera({

      chimes: [makeChimeConfig({ cameraIds: ["test-camera-1"], ringSettings: [{ cameraId: "test-camera-1", volume: 50 }] })],
      config: { channels: G2_PRO_CHANNELS, featureFlags: { isDoorbell: true } },
      userOptions: ["Enable.Doorbell.Volume.Dimmer"]
    });
    const brightness = accessory.getServiceById(Service.Lightbulb, ProtectReservedNames.LIGHTBULB_DOORBELL_VOLUME)?.getCharacteristic(Characteristic.Brightness);

    assert.ok(brightness, "the doorbell capability stood its volume dimmer up");

    await assert.doesNotReject(triggerGet(brightness), "a connected doorbell answers");

    store.pushCameraPatch("test-camera-1", { state: "DISCONNECTED" });

    await settle();

    await assert.rejects(triggerGet(brightness), hapStatus(HAPStatus.SERVICE_COMMUNICATION_FAILURE), "the capability refuses a read with its camera");
    await assert.rejects(triggerSet(brightness, 20), hapStatus(HAPStatus.SERVICE_COMMUNICATION_FAILURE), "and a write");

    store.pushCameraPatch("test-camera-1", { state: "CONNECTED" });

    await settle();

    await assert.doesNotReject(triggerGet(brightness), "and answers once the camera is back");
  });

  // The media gates keep their own question: a camera whose controller is merely unhealthy is not reachable for a new stream, and is available for a read.
  test("isReachable keeps reading controller health, and isAvailable does not", async () => {

    const { camera, nvr } = await standCamera();

    nvr.client.connection.isHealthy = false;

    assert.equal(camera.isReachable, false, "an unhealthy controller is no place to start an operation");
    assert.equal(camera.isAvailable, true, "and its last values are still ones the plugin can vouch for");
  });
});

// The base device with its protected driven set in reach, the shape a row needs to hold a body the families' routes can only reach by a failure they cannot arrange.
class DrivingDevice extends TestBaseDevice {

  public async drive(options: Parameters<TestBaseDevice["driveSet"]>[0]): Promise<void> {

    return this.driveSet(options);
  }
}

describe("the paths that go past the refusal", () => {

  afterEach(abortControllers);

  // One set route and the HomeKit write on the same characteristic, the controller lost for both. The route's command reaches the projection and fails as it always has,
  // through the failure line, and its characteristic states the value set. A route left on the characteristic's own set entry point records no command at all.
  test("a light's /set routes each reach the controller and log their failure through an outage, while a HomeKit write refuses and records no command", async () => {

    const config = makeLightConfig({ ledLevel: 1 });
    const store = new TestStateStore(makeProtectState({ lights: [config] }));
    const { logEntries, mqtt, nvr } = standNvr(store);
    const accessory = makeTestAccessory("Test Light", config.mac);
    const projection = new TestLightProjection(config.id, store);

    configured(new ProtectLight(nvr as unknown as ProtectNvr, accessory, projection as unknown as Light));

    const lightbulb = accessory.getService(Service.Lightbulb);

    assert.ok(lightbulb, "the light carries its Lightbulb");

    nvr.client.connection.isLost = true;
    projection.updateRejection = new Error("The controller cannot be reached.");

    await mqtt.invokeSet(config.mac + "/light/set", "true");
    await settle();

    assert.deepEqual(projection.updateCalls, [{ payload: { lightOnSettings: { isLedForceOn: true } } }], "the /set reached its command");
    assert.ok(loggedAt(logEntries, "error", "Unable to turn the light on"), "and logged its failure as it always has");
    assert.equal(lightbulb.getCharacteristic(Characteristic.On).value, true, "the characteristic states the value set");

    await mqtt.invokeSet(config.mac + "/light/brightness/set", "75");
    await settle();

    assert.deepEqual(projection.updateCalls[1], { payload: { lightDeviceSettings: { ledLevel: 5 } } }, "the brightness /set reached its command too");
    assert.ok(loggedAt(logEntries, "error", "Unable to adjust the brightness to 75%"), "and logged its failure");
    assert.equal(lightbulb.getCharacteristic(Characteristic.Brightness).value, 75, "the characteristic states the value set");

    await assert.rejects(triggerSet(lightbulb.getCharacteristic(Characteristic.On), false), hapStatus(HAPStatus.SERVICE_COMMUNICATION_FAILURE));
    await assert.rejects(triggerSet(lightbulb.getCharacteristic(Characteristic.Brightness), 20), hapStatus(HAPStatus.SERVICE_COMMUNICATION_FAILURE));

    assert.equal(projection.updateCalls.length, 2, "the HomeKit writes recorded no command");
  });

  test("a relay output whose state differs reaches its toggle and logs its failure through an outage, while a HomeKit write refuses and records no toggle", async () => {

    const { accessory, logEntries, mqtt, nvr, projection } = standRelay(makeRelayConfig());
    const output = accessory.getServiceById(Service.Switch, ProtectReservedNames.SWITCH_RELAY_OUTPUT + ".0")?.getCharacteristic(Characteristic.On);

    assert.ok(output, "the relay carries its first output");

    nvr.client.connection.isLost = true;
    projection.toggleRejection = new Error("The controller cannot be reached.");

    await mqtt.invokeSet("74ACB9000501/relay/1/set", "true");
    await settle();

    assert.deepEqual(projection.toggleCalls, [{ outputId: 0 }], "the /set reached its toggle");
    assert.ok(loggedAt(logEntries, "error", "Unable to turn Output 1 on"), "and logged its failure as it always has");
    assert.equal(output.value, true, "the characteristic states the value set");

    await assert.rejects(triggerSet(output, true), hapStatus(HAPStatus.SERVICE_COMMUNICATION_FAILURE));

    assert.equal(projection.toggleCalls.length, 1, "the HomeKit write recorded no toggle");
  });

  // A HomeKit write and the /set share one body, so they share one label: the one the switch was set up under. A label read live on the route would name the rename.
  test("a relay renamed after configure logs the label its switch was set up under on the /set route", async () => {

    const { logEntries, mqtt, projection, store } = standRelay(makeRelayConfig({ outputs: [{ id: 0, name: "Gate", state: "off" }] }));

    store.pushRelayOutputs("test-relay-1", [{ id: 0, name: "Renamed", state: "off" }]);
    projection.toggleRejection = new Error("The controller cannot be reached.");

    await mqtt.invokeSet("74ACB9000501/relay/1/set", "true");
    await settle();

    assert.ok(loggedAt(logEntries, "error", "Unable to turn Gate on"), "the failure line names the label the switch was set up under");
    assert.equal(loggedAt(logEntries, "error", "Unable to turn Renamed on"), false, "not the name the controller moved it to");
  });

  test("a doorbell's chime /set reaches the chime that carries its ring through an outage, while a HomeKit write refuses and records no command", async () => {

    const { accessory, chimeProjections, logEntries, mqtt, nvr } = await standCamera({

      chimes: [makeChimeConfig({ cameraIds: ["test-camera-1"], ringSettings: [{ cameraId: "test-camera-1", volume: 50 }] })],
      config: { channels: G2_PRO_CHANNELS, featureFlags: { isDoorbell: true } },
      userOptions: ["Enable.Doorbell.Volume.Dimmer"]
    });
    const dimmer = accessory.getServiceById(Service.Lightbulb, ProtectReservedNames.LIGHTBULB_DOORBELL_VOLUME);
    const [chime] = chimeProjections;

    assert.ok(dimmer && chime, "the doorbell carries its volume dimmer and a chime serves it");

    nvr.client.connection.isLost = true;
    chime.updateRejection = new Error("The controller cannot be reached.");

    await mqtt.invokeSet("74ACB9000001/chime/set", "70");
    await settle();

    assert.equal(chime.updateCalls.length, 1, "the /set reached the chime that carries this doorbell's ring");
    assert.ok(loggedAt(logEntries, "error", "Unable to set the chime volume"), "and logged its failure as it always has");
    assert.equal(dimmer.getCharacteristic(Characteristic.Brightness).value, 70, "the dimmer states the volume set");
    assert.equal(dimmer.getCharacteristic(Characteristic.On).value, true, "and that it is on");

    await assert.rejects(triggerSet(dimmer.getCharacteristic(Characteristic.Brightness), 20), hapStatus(HAPStatus.SERVICE_COMMUNICATION_FAILURE));

    assert.equal(chime.updateCalls.length, 1, "the HomeKit write recorded no command");
  });

  // A tone was never on the characteristic's set path, so this row holds it there: it reaches the chime through an outage untouched.
  test("a chime's tone /set reaches the chime and logs its failure through an outage", async () => {

    const config = makeChimeConfig();
    const store = new TestStateStore(makeProtectState({ chimes: [config] }));
    const { logEntries, mqtt, nvr } = standNvr(store);
    const projection = new TestChimeProjection(config.id, store);

    configured(new ProtectChime(nvr as unknown as ProtectNvr, makeTestAccessory("Test Chime", config.mac), projection as unknown as Chime));

    nvr.client.connection.isLost = true;
    projection.playRejection = new Error("The controller cannot be reached.");

    await mqtt.invokeSet(config.mac + "/tone/set", "buzzer");
    await settle();

    assert.equal(projection.playBuzzerCalls.length, 1, "the /set reached its command");
    assert.ok(loggedAt(logEntries, "error", "Unable to play buzzer"), "and logged its failure as it always has");
  });

  // A scene issues no command, so what a set moves is the member camera's motion detection. The HomeKit write on the same switch moves nothing.
  test("a liveview /set moves the member camera's motion detection and states the value through an outage, while a HomeKit write refuses", async () => {

    const { accessories, mqtt, nvr } = standLiveviews([{ cameras: ["member"], id: "member-view", name: "Protect-Member" }]);
    const member = makeTestAccessory("Member", "74ACB9000099");
    const liveview = accessories.find(({ UUID }) => UUID === accessoryUuid(CONTROLLER_MAC + ".Liveview.MEMBER"));
    const on = liveview?.getService(Service.Switch)?.getCharacteristic(Characteristic.On);

    assert.ok(on, "the liveview's switch stands");

    member.context.detectMotion = true;
    nvr.configuredDevices.set(member.UUID, { accessory: member, accessoryName: "Member", protectId: "member" } as unknown as ProtectDevices);
    nvr.client.connection.isLost = true;

    await mqtt.invokeSet(CONTROLLER_MAC + "/liveviews/set", JSON.stringify([{ name: "Member", state: false }]));
    await settle();

    assert.equal(member.context.detectMotion, false, "the /set applied the scene to the member camera");
    assert.equal(on.value, false, "the switch states the value set");

    await assert.rejects(triggerSet(on, true), hapStatus(HAPStatus.SERVICE_COMMUNICATION_FAILURE));

    assert.equal(member.context.detectMotion, false, "the HomeKit write moved nothing");
  });

  // A body running with no one waiting on it has no one to report to, so its fault is said where it runs, and the route's loop goes on to its next entry.
  test("a liveview /set whose body throws states nothing, logs one error line and leaves the next entry running", async () => {

    const { accessories, logEntries, mqtt, nvr } = standLiveviews([ { cameras: ["broken"], id: "broken-view", name: "Protect-Broken" },
      { cameras: ["member"], id: "member-view", name: "Protect-Member" } ]);
    const member = makeTestAccessory("Member", "74ACB9000099");
    const liveview = accessories.find(({ UUID }) => UUID === accessoryUuid(CONTROLLER_MAC + ".Liveview.BROKEN"));
    const on = liveview?.getService(Service.Switch)?.getCharacteristic(Characteristic.On);

    assert.ok(on, "the broken liveview's switch stands");

    member.context.detectMotion = true;
    nvr.configuredDevices.set(member.UUID, { accessory: member, accessoryName: "Member", protectId: "member" } as unknown as ProtectDevices);

    // A member whose accessory cannot be read is the fault the scene's body meets on its first read of the member.
    nvr.configuredDevices.set("broken", { get accessory(): never { throw new Error("The member is unreadable."); }, protectId: "broken" } as unknown as ProtectDevices);

    const held = on.value;
    const errorLines = (): number => logEntries.filter(({ level }) => level === "error").length;
    const errorsAtStart = errorLines();

    await mqtt.invokeSet(CONTROLLER_MAC + "/liveviews/set", JSON.stringify([ { name: "Broken", state: false }, { name: "Member", state: false } ]));
    await settle();

    assert.equal(on.value, held, "the faulted body states nothing");
    assert.equal(errorLines(), errorsAtStart + 1, "and logs one error line");
    assert.ok(loggedAt(logEntries, "error", "The member is unreadable"), "naming the fault");
    assert.equal(member.context.detectMotion, false, "the next entry ran");
  });

  test("a driven set runs no body for a service that is gone, runs it once for one that stands, and states one change", async () => {

    const config = makeSensorConfig();
    const store = new TestStateStore(makeProtectState({ sensors: [config] }));
    const { nvr } = standNvr(store);
    const accessory = makeTestAccessory("Test Sensor", config.mac);
    const device = new DrivingDevice(nvr as unknown as ProtectNvr, accessory, new TestSensorProjection(config.id, store) as unknown as Sensor);
    const service = accessory.addService(new Service.Switch("Driven"));
    const values: CharacteristicValue[] = [];
    const set = (value: CharacteristicValue): void => void values.push(value);

    await device.drive({ characteristic: Characteristic.On, service: undefined, set, value: true });

    assert.deepEqual(values, [], "a service that is gone runs nothing");

    nvr.client.connection.isLost = true;

    await device.drive({ characteristic: Characteristic.On, service, set, value: true });

    assert.deepEqual(values, [true], "a service that stands runs the body once, whatever the verdict reads");
    assert.deepEqual(writesTo(accessory, service.getCharacteristic(Characteristic.On)), [true], "and states the value it set in one change");
  });
});

// HAP's camera controller on an accessory, as far as these rows drive it: what it saves, and the factory reset it runs on its recording arm.
interface CameraControllerHandle {

  activeCameraController: { handleFactoryReset: () => void; serialize: () => unknown };
}

// HAP's accessory as these rows restart it: Homebridge's cache writes it through serialize and reads it back through deserialize, and HAP's own storage holds what the
// camera controller saved.
interface RestorableAccessory {

  _associatedHAPAccessory: { controllerStorage: { controllerData: Record<string, unknown>; enqueueSaveRequest: () => void; initialized: boolean } };
  _associatedPlatform: string;
  _associatedPlugin: string;
}

// The class Homebridge's cache reads an accessory back through.
interface AccessoryCache {

  deserialize: (json: unknown) => TestProtectAccessory;
  serialize: (accessory: TestProtectAccessory) => unknown;
}

/* Restart an accessory as Homebridge's cache and HAP's storage do it: every characteristic comes back holding the value the last run left, and the camera controller's
 * saved state waits in HAP's storage for the next registration.
 *
 * @param accessory - The accessory the last run left.
 * @param adjust    - A change to what the cache holds, for a row whose value the last run did not write.
 *
 * @returns The restored accessory, ready for a camera to stand on.
 */
function restartAccessory(accessory: TestProtectAccessory, adjust?: (restored: TestProtectAccessory) => void): TestProtectAccessory {

  const cache = accessory.constructor as unknown as AccessoryCache;
  const saved = (accessory._associatedHAPAccessory as unknown as CameraControllerHandle).activeCameraController.serialize();
  const old = accessory as unknown as RestorableAccessory;

  old._associatedPlugin = "test-plugin";
  old._associatedPlatform = "test-platform";

  const restored = cache.deserialize(JSON.parse(JSON.stringify(cache.serialize(accessory))));
  const { controllerStorage } = (restored as unknown as RestorableAccessory)._associatedHAPAccessory;

  // These rows publish nothing, so there is no store for HAP's storage to write what the restored controller saves to.
  controllerStorage.enqueueSaveRequest = (): void => undefined;
  controllerStorage.initialized = true;
  controllerStorage.controllerData = { camera: { data: saved } };
  adjust?.(restored);

  return restored;
}

// Every service on an accessory carrying StatusActive, read without materializing one.
function statusActiveCarriers(accessory: ProtectAccessory): string[] {

  return accessory.services.filter((service) => service.testCharacteristic(Characteristic.StatusActive)).map(({ UUID }) => UUID);
}

// What the motion and occupancy sensors read, in that order, "none" for a sensor that carries no StatusActive and "gone" for one that does not stand.
function sensorActives(accessory: ProtectAccessory): (CharacteristicValue | null | string)[] {

  return [ Service.MotionSensor, Service.OccupancySensor ].map((kind) => {

    const service = accessory.getService(kind);

    return !service ? "gone" : service.testCharacteristic(Characteristic.StatusActive) ? service.getCharacteristic(Characteristic.StatusActive).value : "none";
  });
}

// Set a sensor's StatusActive on an accessory as the cache restored it.
function restoreActive(accessory: TestProtectAccessory, kind: typeof Service.MotionSensor, value: boolean): void {

  (accessory.getService(kind) ?? accessory.addService(kind, accessory.displayName)).updateCharacteristic(Characteristic.StatusActive, value);
}

// Stand a recording camera up with its occupancy sensor and read out both sensors' StatusActive and HAP's camera switch.
async function standSwitchedCamera(options: Parameters<typeof standCamera>[0] = {}): Promise<Awaited<ReturnType<typeof standCamera>> & { actives: Characteristic[];
  home: Characteristic; motionEvents: Characteristic; }> {

  const harness = await standCamera({ ...options, userOptions: [ "Enable.Motion.OccupancySensor", "Enable.Motion.Switch", ...(options.userOptions ?? []) ] });
  const motion = harness.accessory.getService(Service.MotionSensor)?.getCharacteristic(Characteristic.StatusActive);
  const occupancy = harness.accessory.getService(Service.OccupancySensor)?.getCharacteristic(Characteristic.StatusActive);
  const home = harness.accessory.getService(Service.CameraOperatingMode)?.getCharacteristic(Characteristic.HomeKitCameraActive);
  const motionEvents = harness.accessory.getServiceById(Service.Switch, ProtectReservedNames.SWITCH_MOTION_SENSOR)?.getCharacteristic(Characteristic.On);

  assert.ok(motion && occupancy && home && motionEvents, "the fixture stood up both sensors, HAP's camera switch and the Motion Events switch");

  return { ...harness, actives: [ motion, occupancy ], home, motionEvents };
}

// Stand a camera on an accessory without settling, so a row reads what its configure alone left, its registration still to come.
function constructCamera(accessory: TestProtectAccessory, config: Parameters<typeof makeCameraConfig>[0], userOptions: string[] = ["Enable.Motion.OccupancySensor"]):
{ camera: ProtectCamera; nvr: TestProtectNvr; projection: TestCameraProjection; store: TestStateStore } {

  const record = makeCameraConfig(config);
  const store = new TestStateStore(makeProtectState({ cameras: [record] }));
  const { factory, nvr } = standNvr(store, { userOptions });
  const projection = new TestCameraProjection(record.id, store);

  factory.realControllers = true;

  const camera = configured(new ProtectCamera(nvr as unknown as ProtectNvr, accessory, projection as unknown as Camera));

  return { camera, nvr, projection, store };
}

describe("StatusActive on a camera's sensors", () => {

  afterEach(abortControllers);

  test("a fresh camera's sensors carry it reading active from their setup, through the recording audio probe's wait, to the controller's build", async () => {

    const accessory = makeTestAccessory("Test Camera", "74ACB9000010");
    const record = makeCameraConfig({ channels: G2_PRO_CHANNELS });
    const store = new TestStateStore(makeProtectState({ cameras: [record] }));
    const { factory, nvr } = standNvr(store, { userOptions: ["Enable.Motion.OccupancySensor"] });
    const projection = new TestCameraProjection(record.id, store);
    let release = (): void => undefined;

    projection.livestreamGate = new Promise((resolve) => {

      release = resolve;
    });
    factory.realControllers = true;

    configured(new ProtectCamera(nvr as unknown as ProtectNvr, accessory, projection as unknown as Camera));

    await settle();

    assert.equal(projection.livestreamCalls.length, 1, "the probe is waiting on the camera's stream");
    assert.equal(accessory.getService(Service.CameraOperatingMode), undefined, "and no controller is built yet");
    assert.deepEqual(sensorActives(accessory), [ true, true ], "both sensors read active through the wait");

    const motion = accessory.getService(Service.MotionSensor)?.getCharacteristic(Characteristic.StatusActive);
    const occupancy = accessory.getService(Service.OccupancySensor)?.getCharacteristic(Characteristic.StatusActive);

    assert.ok(motion && occupancy, "both sensors carry it");
    assert.deepEqual([ await triggerGet(motion), await triggerGet(occupancy) ], [ true, true ], "as HomeKit reads it");

    release();

    await settle();

    assert.ok(accessory.getService(Service.CameraOperatingMode), "the build landed");
    assert.deepEqual(sensorActives(accessory), [ true, true ], "and both still read active");
  });

  test("on a recording camera each follows HAP's camera switch alone, and neither the Motion Events switch nor the connection moves it", async () => {

    const { actives, camera, home, motionEvents, nvr, store } = await standSwitchedCamera();

    const expectAll = async (expected: boolean, label: string): Promise<void> => {

      for(const active of actives) {

        assert.equal(active.value, expected, label + ", as the characteristic holds it");
        // eslint-disable-next-line no-await-in-loop -- Each read is its own assertion.
        assert.equal(await triggerGet(active), expected, label + ", as HomeKit reads it");
      }
    };

    await expectAll(true, "a camera on in Home reads active");

    await triggerSet(home, false);
    await expectAll(false, "off in Home reads inactive");

    await triggerSet(home, true);
    await expectAll(true, "and on again reads active");

    let writes = 0;

    for(const active of actives) {

      active.on("change", () => writes++);
    }

    await triggerSet(motionEvents, false);
    await expectAll(true, "the Motion Events switch moves nothing");

    await triggerSet(motionEvents, true);

    nvr.client.connection.isHealthy = false;
    nvr.client.connection.isLost = true;
    camera.noteConnectionChanged();

    nvr.client.connection.isHealthy = true;
    nvr.client.connection.isLost = false;
    store.pushCameraPatch("test-camera-1", { state: "DISCONNECTED" });

    await settle();

    assert.equal(writes, 0, "nothing the plugin holds wrote to either sensor");
  });

  /* A restart through Homebridge's cache and HAP's storage, with a real camera on the restored accessory. The configure reads first, ahead of the registration, because
   * that is where a plugin write would land, and HAP's restore follows in the registration itself, so what it saved is what stands.
   */
  test("a restart leaves a camera off in Home reading inactive, and the plugin writes neither sensor ahead of HAP's restore", async () => {

    const { accessory, home } = await standSwitchedCamera({ config: { channels: G2_PRO_CHANNELS } });

    await triggerSet(home, false);

    const restored = restartAccessory(accessory);

    assert.deepEqual(sensorActives(restored), [ false, false ], "the cache restored both inactive");

    const { accessory: standing, actives, home: restoredHome } = await standSwitchedCamera({ config: { channels: G2_PRO_CHANNELS }, restored });

    assert.equal(standing, restored, "the camera stood on the restored accessory");
    assert.ok(!restoredHome.value, "HAP restored the camera switch off");
    assert.deepEqual(actives.map(({ value }) => value), [ false, false ], "and both sensors read what it saved");

    await triggerSet(restoredHome, true);

    assert.deepEqual(actives.map(({ value }) => value), [ true, true ], "and the mirror still moves them");
  });

  test("the configure leaves a restored value for HAP where the camera can record, inactive included, and HAP's build writes what it saved", async () => {

    const { accessory } = await standSwitchedCamera({ config: { channels: G2_PRO_CHANNELS } });
    const restored = restartAccessory(accessory, (restoring) => {

      restoreActive(restoring, Service.MotionSensor, false);
      restoreActive(restoring, Service.OccupancySensor, false);
    });

    constructCamera(restored, { channels: G2_PRO_CHANNELS });

    assert.deepEqual(sensorActives(restored), [ false, false ], "the configure wrote neither sensor");

    await settle();

    assert.deepEqual(sensorActives(restored), [ true, true ], "the camera is on in what HAP saved, so its build clears the stale value");
  });

  test("HAP's factory reset sets both sensors active", async () => {

    const { accessory, actives, home } = await standSwitchedCamera();
    const { activeCameraController: controller } = accessory._associatedHAPAccessory as unknown as CameraControllerHandle;

    await triggerSet(home, false);

    assert.deepEqual(actives.map(({ value }) => value), [ false, false ], "the camera is off in Home");

    controller.handleFactoryReset();

    assert.deepEqual(actives.map(({ value }) => value), [ true, true ], "and the reset set both back");
  });

  test("during an outage each refuses, and on recovery answers what HAP holds", async () => {

    const { actives, home, nvr } = await standSwitchedCamera();

    await triggerSet(home, false);

    nvr.client.connection.isLost = true;

    for(const active of actives) {

      // eslint-disable-next-line no-await-in-loop -- Each read is its own assertion.
      await assert.rejects(triggerGet(active), hapStatus(HAPStatus.SERVICE_COMMUNICATION_FAILURE));
    }

    nvr.client.connection.isLost = false;

    assert.deepEqual(await Promise.all(actives.map(triggerGet)), [ false, false ], "the value HAP holds, the camera still off");
  });

  test("a camera with no recording arm reads active for good, which clears a restored inactive, and refuses while lost", async () => {

    const { accessory, camera, nvr, store } = await standCamera({ config: { channels: G2_PRO_CHANNELS, featureFlags: { hasMotionDetection: false } },
      seed: (seeded) => restoreActive(seeded, Service.OccupancySensor, false), userOptions: ["Enable.Motion.OccupancySensor"] });

    assert.equal(accessory.getService(Service.CameraOperatingMode), undefined, "the build gave it no recording arm");

    const active = accessory.getService(Service.OccupancySensor)?.getCharacteristic(Characteristic.StatusActive);

    assert.ok(active, "the occupancy sensor carries it");
    assert.equal(active.value, true, "the restored inactive reads active");

    let writes = 0;

    active.on("change", () => writes++);

    nvr.client.connection.isHealthy = false;
    nvr.client.connection.isLost = true;
    camera.noteConnectionChanged();

    await assert.rejects(triggerGet(active), hapStatus(HAPStatus.SERVICE_COMMUNICATION_FAILURE));

    nvr.client.connection.isHealthy = true;
    nvr.client.connection.isLost = false;
    store.pushCameraPatch("test-camera-1", { state: "DISCONNECTED" });

    await settle();

    assert.equal(writes, 0, "nothing wrote it through the outage or the state change");
    assert.equal(active.value, true, "and it still reads active");
  });

  // The connection is No Response's to report, so a camera its controller reports away at its setup reads active all the same, with a recording arm or without one.
  test("a camera set up while it reads DISCONNECTED reads active, and its reads refuse", async () => {

    for(const featureFlags of [ {}, { hasMotionDetection: false } ]) {

      const record = { ...makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags }), state: "DISCONNECTED" as const };
      const store = new TestStateStore(makeProtectState({ cameras: [record] }));
      const { factory, nvr } = standNvr(store, { userOptions: ["Enable.Motion.OccupancySensor"] });
      const accessory = makeTestAccessory("Test Camera", "74ACB9000014");

      factory.realControllers = true;

      configured(new ProtectCamera(nvr as unknown as ProtectNvr, accessory, new TestCameraProjection(record.id, store) as unknown as Camera));

      const active = accessory.getService(Service.OccupancySensor)?.getCharacteristic(Characteristic.StatusActive);

      assert.ok(active, "the occupancy sensor carries it");
      assert.equal(active.value, true, "and it reads active from its setup");

      // eslint-disable-next-line no-await-in-loop -- Each camera is its own assertion.
      await settle();

      assert.equal(active.value, true, "and through its registration");

      // eslint-disable-next-line no-await-in-loop -- As above.
      await assert.rejects(triggerGet(active), hapStatus(HAPStatus.SERVICE_COMMUNICATION_FAILURE));
    }
  });

  // No controller registers for a camera with no channels, so the configure is all there is to clear what the cache restored.
  test("a camera that cannot record and registers no controller reads active from its configure", () => {

    const accessory = makeTestAccessory("Test Camera", "74ACB9000011");

    restoreActive(accessory, Service.OccupancySensor, false);
    constructCamera(accessory, { channels: [], featureFlags: { hasMotionDetection: false } });

    assert.deepEqual(sensorActives(accessory), [ "gone", true ], "the occupancy sensor reads active");
  });

  /* A camera can lose its eligibility between its configure and its registration, which builds a controller with no recording arm over sensors the configure left.
   * HAP writes nothing on them, so a value restored inactive would stand with nothing left to move it.
   */
  test("a registration with no recording arm sets active what the configure left for one", async () => {

    const accessory = makeTestAccessory("Test Camera", "74ACB9000012");

    restoreActive(accessory, Service.MotionSensor, false);
    restoreActive(accessory, Service.OccupancySensor, false);

    const { store } = constructCamera(accessory, { channels: G2_PRO_CHANNELS });

    assert.deepEqual(sensorActives(accessory), [ false, false ], "the configure left both for HAP");

    store.pushCameraFeatureFlags("test-camera-1", { hasMotionDetection: false });

    await settle();

    assert.equal(accessory.getService(Service.CameraOperatingMode), undefined, "the build grew no recording arm");
    assert.deepEqual(sensorActives(accessory), [ true, true ], "and both read active");
  });

  test("a camera that gains recording while running hands HAP its sensors through the rebuild, each carrying it throughout", async () => {

    const { accessory, nvr, store } = await standCamera({ config: { channels: G2_PRO_CHANNELS, featureFlags: { hasMotionDetection: false } },
      userOptions: ["Enable.Motion.OccupancySensor"] });

    assert.deepEqual(sensorActives(accessory), [ "gone", true ], "the occupancy sensor reads active ahead of the gain");

    store.pushCameraFeatureFlags("test-camera-1", { hasMotionDetection: true });

    assert.deepEqual(sensorActives(accessory), [ "gone", true ], "and through it");

    await settle();

    const motion = accessory.getService(Service.MotionSensor)?.getCharacteristic(Characteristic.StatusActive);
    const occupancy = accessory.getService(Service.OccupancySensor)?.getCharacteristic(Characteristic.StatusActive);
    const home = accessory.getService(Service.CameraOperatingMode)?.getCharacteristic(Characteristic.HomeKitCameraActive);

    assert.ok(motion && occupancy && home, "the gain stood the motion sensor up and built HAP's camera switch");
    assert.deepEqual([ motion.value, occupancy.value ], [ true, true ], "both read active");

    await triggerSet(home, false);

    assert.deepEqual([ motion.value, occupancy.value ], [ false, false ], "and HAP mirrors the switch onto both");

    nvr.client.connection.isLost = true;

    await assert.rejects(triggerGet(motion), hapStatus(HAPStatus.SERVICE_COMMUNICATION_FAILURE));
    await assert.rejects(triggerGet(occupancy), hapStatus(HAPStatus.SERVICE_COMMUNICATION_FAILURE));
  });

  test("a recording camera losing eligibility while running keeps its controller, and HAP still holds both sensors", async () => {

    const { actives, home, store } = await standSwitchedCamera();

    store.pushCameraFeatureFlags("test-camera-1", { hasMotionDetection: false });

    await settle();

    await triggerSet(home, false);

    assert.deepEqual(actives.map(({ value }) => value), [ false, false ], "the standing controller still mirrors the switch");
  });

  test("a rebuild sets both active ahead of the rebuilt controller, through the probe's wait, on the characteristic that stood", async () => {

    const accessory = makeTestAccessory("Test Camera", "74ACB9000013");
    const { projection, store } = constructCamera(accessory, { channels: G2_PRO_CHANNELS });

    await settle();

    const actives = [ Service.MotionSensor, Service.OccupancySensor ].map((kind) => accessory.getService(kind)?.getCharacteristic(Characteristic.StatusActive));
    const home = accessory.getService(Service.CameraOperatingMode)?.getCharacteristic(Characteristic.HomeKitCameraActive);

    assert.ok(home, "the build gave the accessory HAP's camera switch");

    await triggerSet(home, false);

    assert.deepEqual(sensorActives(accessory), [ false, false ], "the camera is off in Home");

    let release = (): void => undefined;

    projection.livestreamGate = new Promise((resolve) => {

      release = resolve;
    });

    store.pushCameraFeatureFlags("test-camera-1", { hasSpeaker: true });

    await settle();

    assert.equal(accessory.getService(Service.CameraOperatingMode), undefined, "the teardown took the controller down and the probe holds the rebuild");
    assert.deepEqual(sensorActives(accessory), [ true, true ], "HAP's factory reset set both active");

    release();

    await settle();

    const rebuilt = accessory.getService(Service.CameraOperatingMode)?.getCharacteristic(Characteristic.HomeKitCameraActive);

    assert.ok(rebuilt, "the rebuild built its own camera switch");
    assert.deepEqual(sensorActives(accessory), [ true, true ], "both still read active");
    assert.deepEqual([ Service.MotionSensor, Service.OccupancySensor ].map((kind) => accessory.getService(kind)?.getCharacteristic(Characteristic.StatusActive)), actives,
      "on the characteristics that stood");

    await triggerSet(rebuilt, false);

    assert.deepEqual(sensorActives(accessory), [ false, false ], "and the rebuilt controller mirrors its switch");
  });

  test("a package camera carries it from its setup, ahead of a deferred registration, and follows its own camera switch once it records", async () => {

    const channels = G6_PRO_ENTRY_CHANNELS.filter(({ name }) => name !== "Package Camera");
    const { camera: deferred, store } = await standCamera({ config: { channels, featureFlags: { hasMic: true, hasPackageCamera: true, isDoorbell: true } } });
    const waiting = deferred.doorbell?.packageCamera?.accessory;

    assert.ok(waiting, "the doorbell stood its package camera up");
    assert.equal(waiting.getService(Service.CameraOperatingMode), undefined, "the package camera's registration is deferred");
    assert.deepEqual(sensorActives(waiting), [ true, "gone" ], "its motion sensor reads active with no controller");

    store.pushCameraPatch("test-camera-1", { channels: G6_PRO_ENTRY_CHANNELS });

    await settle();

    const active = waiting.getService(Service.MotionSensor)?.getCharacteristic(Characteristic.StatusActive);
    const home = waiting.getService(Service.CameraOperatingMode)?.getCharacteristic(Characteristic.HomeKitCameraActive);
    const parent = deferred.accessory.getService(Service.MotionSensor)?.getCharacteristic(Characteristic.StatusActive);

    assert.ok(active && home && parent, "the channel's arrival registered the package camera's controller");
    assert.equal(active.value, true, "it reads active");

    await triggerSet(home, false);

    assert.equal(active.value, false, "the package's switch moved its sensor");
    assert.equal(parent.value, true, "and not its parent's");
  });

  test("a package camera that cannot record reads active for good", async () => {

    const { camera, nvr } = await standCamera({ config: { channels: G6_PRO_ENTRY_CHANNELS, featureFlags: { hasMic: true, hasMotionDetection: false,
      hasPackageCamera: true, isDoorbell: true } } });
    const lone = camera.doorbell?.packageCamera?.accessory;
    const active = lone?.getService(Service.MotionSensor)?.getCharacteristic(Characteristic.StatusActive);

    assert.ok(active, "a package camera stands its motion sensor whether or not it can record, carrying it");
    assert.equal(lone?.getService(Service.CameraOperatingMode), undefined, "its build grew no recording arm");
    assert.equal(active.value, true, "it reads active");

    nvr.client.connection.isLost = true;

    await assert.rejects(triggerGet(active), hapStatus(HAPStatus.SERVICE_COMMUNICATION_FAILURE));
  });

  test("a camera's ambient light sensor reads active for good, which clears a restored inactive, refuses while lost, and follows nothing", async () => {

    const { accessory, actives: [motion], home, nvr } = await standSwitchedCamera({ config: { channels: G2_PRO_CHANNELS, featureFlags: { hasLuxCheck: true } },
      seed: (seeded) => restoreActive(seeded, Service.LightSensor, false) });
    const active = accessory.getService(Service.LightSensor)?.getCharacteristic(Characteristic.StatusActive);

    assert.ok(active, "the light sensor carries it");
    assert.equal(active.value, true, "the restored inactive reads active");

    await triggerSet(home, false);

    assert.equal(motion?.value, false, "the camera switch moved the motion sensor");
    assert.equal(active.value, true, "and not the light sensor");

    nvr.client.connection.isLost = true;

    await assert.rejects(triggerGet(active), hapStatus(HAPStatus.SERVICE_COMMUNICATION_FAILURE));

    nvr.client.connection.isLost = false;

    assert.equal(await triggerGet(active), true, "it answers active once the controller has recovered");
  });

  // A camera's motion, occupancy and ambient light sensors carry it. Everything else loses it, a service restored from the cache carrying it included.
  test("no service of a light or a standalone sensor carries it, one restored with it included, and on a camera only its sensors do", async () => {

    const restore = (accessory: TestProtectAccessory, kinds: (typeof Service.MotionSensor)[]): void => {

      for(const kind of kinds) {

        accessory.addService(kind, accessory.displayName).getCharacteristic(Characteristic.StatusActive);
      }
    };

    const { accessory: cameraAccessory } = await standCamera({ config: { channels: G2_PRO_CHANNELS, featureFlags: { hasLuxCheck: true } }, userOptions: BASE_SWITCHES });

    assert.deepEqual(statusActiveCarriers(cameraAccessory).toSorted(), [ Service.LightSensor.UUID, Service.MotionSensor.UUID, Service.OccupancySensor.UUID ].toSorted(),
      "a camera's motion, occupancy and ambient light sensors are the carriers");

    const record = makeSensorConfig({ alarmEnabled: true, ambientLight: 250, glassBreak: true, glassBreakEnabled: true, humidity: 55, humidityEnabled: true,
      lightEnabled: true, motionEnabled: true, mountType: "door", temperature: 21.5, temperatureEnabled: true });
    const sensorStore = new TestStateStore(makeProtectState({ sensors: [record] }));
    const { nvr: sensorNvr } = standNvr(sensorStore, { userOptions: BASE_SWITCHES });
    const sensorAccessory = makeTestAccessory("Test Sensor", record.mac);

    restore(sensorAccessory, [ Service.HumiditySensor, Service.LightSensor, Service.MotionSensor, Service.OccupancySensor, Service.TemperatureSensor ]);

    configured(new ProtectSensor(sensorNvr as unknown as ProtectNvr, sensorAccessory, new TestSensorProjection(record.id, sensorStore) as unknown as Sensor));

    await settle();

    assert.ok(sensorAccessory.getService(Service.MotionSensor) && sensorAccessory.getService(Service.TemperatureSensor), "the sensor kept what it was restored with");
    assert.deepEqual(statusActiveCarriers(sensorAccessory), [], "no service of a sensor carries it");

    const lightRecord = makeLightConfig();
    const lightStore = new TestStateStore(makeProtectState({ lights: [lightRecord] }));
    const { nvr: lightNvr } = standNvr(lightStore, { userOptions: BASE_SWITCHES });
    const lightAccessory = makeTestAccessory("Test Light", lightRecord.mac);

    restore(lightAccessory, [ Service.MotionSensor, Service.OccupancySensor ]);

    configured(new ProtectLight(lightNvr as unknown as ProtectNvr, lightAccessory, new TestLightProjection(lightRecord.id, lightStore) as unknown as Light));

    assert.ok(lightAccessory.getService(Service.MotionSensor), "the light kept the sensor it was restored with");
    assert.deepEqual(statusActiveCarriers(lightAccessory), [], "and no service of a light carries it");
  });
});

// Every statement made on a device's availability topic, as its word and whether it was retained, in order.
function statements(mqtt: TestMqttClient, mac: string): string[] {

  return mqtt.published.filter(({ topic }) => topic === (mac + "/availability")).map(({ payload, retain }) => String(payload) + (retain ? " retained" : ""));
}

describe("a device's MQTT availability statement", () => {

  afterEach(abortControllers);

  test("a device states online, retained, at the end of its configure, and a path that leaves the verdict where it stood says nothing", () => {

    const config = makeFobConfig();
    const { fob, mqtt } = standFob(config);

    assert.deepEqual(statements(mqtt, config.mac), ["online retained"], "the configure's statement");

    fob.noteConnectionChanged();

    assert.deepEqual(statements(mqtt, config.mac), ["online retained"], "a refresh that finds nothing moved says nothing");
  });

  // The controller's verdict is half of every device's, and the connection loop's push is how a device hears of it.
  test("the controller's loss and its recovery each reach a device's statement through the connection loop's push", () => {

    const config = makeFobConfig();
    const { fob, mqtt, nvr } = standFob(config);

    nvr.client.connection.isLost = true;
    fob.noteConnectionChanged();

    assert.deepEqual(statements(mqtt, config.mac), [ "online retained", "offline retained" ], "a lost controller reads offline");

    nvr.client.connection.isLost = false;
    nvr.client.connection.isRebooting = true;
    fob.noteConnectionChanged();

    assert.equal(statements(mqtt, config.mac).length, 2, "a reboot reads offline too, which has already been said");

    nvr.client.connection.isRebooting = false;
    fob.noteConnectionChanged();

    assert.equal(statements(mqtt, config.mac).at(-1), "online retained", "and the recovery reads online");
  });

  // The record's half moves on its own, with no connection transition to carry it, so the device's own observer states it.
  test("a device's connection and adoption each reach its statement through its own observer", async () => {

    const { accessory, mqtt, store } = await standCamera();
    const mac = accessory.context.mac ?? "";

    store.pushCameraPatch("test-camera-1", { state: "DISCONNECTED" });

    await settle();

    assert.equal(statements(mqtt, mac).at(-1), "offline retained", "a camera going away reads offline");

    store.pushCameraPatch("test-camera-1", { state: "CONNECTED" });

    await settle();

    assert.equal(statements(mqtt, mac).at(-1), "online retained", "and coming back reads online");

    store.pushCameraPatch("test-camera-1", { isAdopted: false });

    await settle();

    assert.equal(statements(mqtt, mac).at(-1), "offline retained", "and one no longer adopted reads offline");
  });

  // The verdict's own exemption reaches the broker: the controller's connection report says nothing about a fob and everything about any other family.
  test("a DISCONNECTED fob states online until the controller is lost, and a DISCONNECTED viewer states offline", async () => {

    const fobConfig = makeFobConfig();
    const { fob, mqtt: fobMqtt, nvr: fobNvr, store: fobStore } = standFob(fobConfig);

    fobStore.pushFobPatch("test-fob-1", { state: "DISCONNECTED" });

    await settle();

    assert.deepEqual(statements(fobMqtt, fobConfig.mac), ["online retained"], "an idle fob stays online");

    fobNvr.client.connection.isLost = true;
    fob.noteConnectionChanged();

    assert.equal(statements(fobMqtt, fobConfig.mac).at(-1), "offline retained", "until its controller is lost");

    const viewerConfig = makeViewerConfig();
    const viewerStore = new TestStateStore(makeProtectState({ liveviews: [makeLiveviewConfig()], viewers: [viewerConfig] }));
    const { mqtt: viewerMqtt, nvr: viewerNvr } = standNvr(viewerStore);

    configured(new ProtectViewer(viewerNvr as unknown as ProtectNvr, makeTestAccessory("Test Viewer", viewerConfig.mac),
      new TestViewerProjection(viewerConfig.id, viewerStore) as unknown as Viewer));

    viewerStore.pushViewerPatch(viewerConfig.id, { state: "DISCONNECTED" });

    await settle();

    assert.deepEqual(statements(viewerMqtt, viewerConfig.mac), [ "online retained", "offline retained" ], "a disconnected viewer is offline");
  });

  // A vanished record wakes the observer into its record gate, so the root's membership reconcile states that one, and the record's return is the observer's again.
  test("a record that vanishes says nothing through the observer, and its return within the grace states online", async () => {

    const { accessory, camera, mqtt, store } = await standCamera();
    const mac = accessory.context.mac ?? "";
    const record = store.snapshot().cameras.get("test-camera-1");

    assert.ok(record, "the fixture holds the camera's record");

    store.removeCameraRecord("test-camera-1");

    await settle();

    assert.deepEqual(statements(mqtt, mac), ["online retained"], "the observer's gate skipped the vanished record");

    camera.publishAvailability();

    assert.equal(statements(mqtt, mac).at(-1), "offline retained", "and the statement the membership reconcile asks for reads it offline");

    store.addCameraRecord(record);

    await settle();

    assert.equal(statements(mqtt, mac).at(-1), "online retained", "and the record's return reads online");
  });

  // A device's statement finds the plugin's already on the wire, as HBPU's order holds it, and a family's own restatement finds the device's: availability reads first.
  test("each broker session restates a device's availability ahead of everything else its family restates", () => {

    const config = makeLightConfig();
    const store = new TestStateStore(makeProtectState({ lights: [config] }));
    const { mqtt, nvr } = standNvr(store);

    configured(new ProtectLight(nvr as unknown as ProtectNvr, makeTestAccessory("Test Light", config.mac),
      new TestLightProjection(config.id, store) as unknown as Light));

    mqtt.connected = false;

    const mark = mqtt.published.length;

    mqtt.connected = true;

    assert.deepEqual(mqtt.published.slice(mark, mark + 3).map(({ topic }) => topic), [ "availability", config.mac + "/availability", config.mac + "/light" ],
      "HBPU's statement, then the device's, then its state");
  });

  // The record gate on the restatements every family registers has no business here, since a device lingering in its grace still has this to say.
  test("a device in its removal grace whose statement fell in a broker outage states offline on the next session", async () => {

    const { accessory, camera, mqtt, store } = await standCamera();
    const mac = accessory.context.mac ?? "";

    mqtt.connected = false;
    store.removeCameraRecord("test-camera-1");

    await settle();

    camera.publishAvailability();

    assert.deepEqual(statements(mqtt, mac), ["online retained"], "the broker is away, so the online stands on it");

    mqtt.connected = true;

    assert.equal(statements(mqtt, mac).at(-1), "offline retained", "and the next session replaces it");
  });

  test("a device states offline, retained, inside the client's end, and one cleaned up mid-run says nothing there", async () => {

    const standing = makeFobConfig({ mac: "74ACB9000601" });
    const released = makeFobConfig({ id: "test-fob-2", mac: "74ACB9000602" });
    const store = new TestStateStore(makeProtectState({ fobs: [ standing, released ] }));
    const { logEntries, mqtt, nvr } = standNvr(store);

    configured(new ProtectFob(nvr as unknown as ProtectNvr, makeTestAccessory("Standing Fob", standing.mac),
      new TestFobProjection(standing.id, store) as unknown as Fob));
    configured(new ProtectFob(nvr as unknown as ProtectNvr, makeTestAccessory("Released Fob", released.mac),
      new TestFobProjection(released.id, store) as unknown as Fob)).cleanup();

    await mqtt.end();

    assert.deepEqual(statements(mqtt, standing.mac), [ "online retained", "offline retained" ], "the standing fob's final word");
    assert.deepEqual(statements(mqtt, released.mac), ["online retained"], "and the one cleaned up has none left to say");
    assert.equal(logEntries.some(({ message }) => message.includes("went unsaid")), false, "with no word left unsaid");
  });

  // HBPU weighs a change-gated publish against whatever the topic last said, so a final word through that gate would say nothing here, and a subscriber reading the end
  // of the session would never see the word that ends it.
  test("a device's final word goes out past the change gate, on a topic that already reads offline", async () => {

    const config = makeFobConfig();
    const { fob, mqtt, nvr } = standFob(config);

    nvr.client.connection.isLost = true;
    fob.noteConnectionChanged();

    assert.deepEqual(statements(mqtt, config.mac), [ "online retained", "offline retained" ], "the loss is already on the topic");

    await mqtt.end();

    assert.deepEqual(statements(mqtt, config.mac), [ "online retained", "offline retained", "offline retained" ], "and the final word says so again");
  });

  // The removal's statement is change-gated, so it adds nothing where the device already said so, and writes the gate's memory, so a device re-adopted under the same
  // identity is heard saying online.
  test("a removal states the device offline, retained and change-gated, and what is re-adopted under its MAC is heard saying online", () => {

    const config = makeFobConfig();
    const { accessory, fob, mqtt, nvr, store } = standFob(config);

    nvr.platform.accessories.push(accessory);
    nvr.configuredDevices.set(accessory.UUID, fob);
    nvr.removeHomeKitDevice(accessory);

    assert.deepEqual(statements(mqtt, config.mac), [ "online retained", "offline retained" ], "the removal's statement");

    configured(new ProtectFob(nvr as unknown as ProtectNvr, makeTestAccessory("Test Fob", config.mac), new TestFobProjection(config.id, store) as unknown as Fob));

    assert.equal(statements(mqtt, config.mac).at(-1), "online retained", "the next device on that topic is heard");
  });

  test("a removal of a device that already said so adds nothing", () => {

    const config = makeFobConfig();
    const { accessory, fob, mqtt, nvr } = standFob(config);

    nvr.client.connection.isLost = true;
    fob.noteConnectionChanged();
    nvr.platform.accessories.push(accessory);

    const said = statements(mqtt, config.mac).length;

    nvr.removeHomeKitDevice(accessory);

    assert.equal(nvr.platform.accessories.includes(accessory), false, "the removal ran");
    assert.equal(statements(mqtt, config.mac).length, said, "and its statement found the topic already there");
  });

  // A package camera's topics sit under its parent's MAC, so a statement of its own would speak over the parent that stands for the shared hardware.
  test("a doorbell and the package camera standing beside it say one final word between them", async () => {

    const { accessory, camera, mqtt } = await standCamera({ config: { channels: G6_PRO_ENTRY_CHANNELS, featureFlags: { hasMic: true, hasPackageCamera: true,
      isDoorbell: true } } });

    assert.ok(camera.doorbell?.packageCamera, "the doorbell stood its package camera up");

    await mqtt.end();

    assert.deepEqual(statements(mqtt, accessory.context.mac ?? ""), [ "online retained", "offline retained" ], "the parent's word, and none from the package camera");
  });

  test("a package camera states nothing of its own, through its detach, its push and the client's end, and its parent speaks for the topic", async () => {

    const { accessory, camera, mqtt, nvr, store } = await standCamera({ config: { channels: G6_PRO_ENTRY_CHANNELS, featureFlags: { hasMic: true, hasPackageCamera: true,
      isDoorbell: true } } });
    const mac = accessory.context.mac ?? "";
    const packageCamera = camera.doorbell?.packageCamera;

    assert.ok(packageCamera, "the doorbell stood its package camera up");
    assert.deepEqual(statements(mqtt, mac), ["online retained"], "the doorbell and its package camera stated once between them");

    nvr.client.connection.isLost = true;
    packageCamera.noteConnectionChanged();

    assert.deepEqual(statements(mqtt, mac), ["online retained"], "the package camera's push says nothing");

    nvr.client.connection.isLost = false;

    assert.equal(packageCamera.accessory.context.mac, undefined, "a package camera's accessory carries no MAC of its own");

    store.pushCameraFeatureFlags("test-camera-1", { hasPackageCamera: false });

    await settle();

    nvr.platform.clock.advance(PROTECT_DEVICE_REMOVAL_DELAY_INTERVAL * 1000);

    assert.equal(nvr.platform.accessories.includes(packageCamera.accessory), false, "the package camera's detach ran");
    assert.deepEqual(statements(mqtt, mac), ["online retained"], "and said nothing over its parent");

    await mqtt.end();

    assert.deepEqual(statements(mqtt, mac), [ "online retained", "offline retained" ], "the end's word is the parent's alone");
  });
});

describe("an accessory's claim", () => {

  afterEach(abortControllers);

  // The claim is the last act of a configure, so an accessory whose owner failed part way goes on refusing rather than following an owner that was released.
  test("an owner whose configure throws claims nothing", () => {

    class ThrowingDevice extends TestBaseDevice {

      protected override configureDevice(): boolean {

        throw new Error("The setup failed.");
      }
    }

    const config = makeSensorConfig();
    const store = new TestStateStore(makeProtectState({ sensors: [config] }));
    const { nvr } = standNvr(store);
    const accessory = makeTestAccessory("Test Sensor", config.mac);

    assert.throws(() => configured(new ThrowingDevice(nvr as unknown as ProtectNvr, accessory, new TestSensorProjection(config.id, store) as unknown as Sensor)));
    assert.equal(nvr.platform.claims.has(accessory.UUID), false, "the accessory stays unclaimed");
  });

  // The cascade's shared tail is the one way out, so a removal by any path leaves no claim to answer for an accessory of the same identity added later.
  test("the removal tail releases the accessory's claim", () => {

    const { accessory, nvr } = standSensor({});

    nvr.platform.accessories.push(accessory);

    assert.equal(nvr.platform.claims.has(accessory.UUID), true, "the sensor claimed its accessory");

    nvr.removeAccessoryFromHomeKit(accessory);

    assert.equal(nvr.platform.claims.has(accessory.UUID), false, "the removal released it");
  });
});
