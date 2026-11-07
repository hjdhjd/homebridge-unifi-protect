/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * testing.helpers.ts: The device-family test helpers for homebridge-unifi-protect.
 *
 * This file owns the two halves every device-class test starts from: the typed config builders that mint a minimal-but-real wire record for each device family
 * (camera, chime, light, viewer, sensor, relay, fob, ringtone, liveview), and the read-through projection doubles that stand in for unifi-protect's DeviceProjection
 * contract. Each builder populates the exact field set its family's construction path reads and confines a single documented cast to the full wire type, so an
 * overridden record is as type-honest as a default one; each projection reads THROUGH the state store rather than holding a snapshot, so a push changes what the
 * device under test sees. TestBaseDevice rides on the sensor carrier as the vehicle for the shared base-device concerns.
 *
 * Fidelity to the cited contracts, not invention, is the line these doubles hold: the projection surface is unifi-protect's, and the record shapes are the
 * controller's own. The cross-cutting core - the Homebridge runtime, the state store, the streaming and timeshift stubs - lives in the root harness this file imports
 * from.
 */
import { DISABLED_THRESHOLD_SETTINGS, DISABLED_VAPE_SENSITIVITY, NOT_CAPABLE_AIR_QUALITY } from "./air-quality-policy.ts";
import type { LivestreamDescription, LivestreamInit, LivestreamOptions, LivestreamSubscriptionState, PlaySpeakerOptions, ProtectAirQualityThresholdSettings,
  ProtectCameraChannelConfig, ProtectCameraConfig, ProtectChimeConfig, ProtectFobConfig, ProtectLightConfig, ProtectNvrLiveviewConfig, ProtectRelayConfig,
  ProtectRingtoneConfig, ProtectSensorAirQuality, ProtectSensorConfig, ProtectSensorSmokeStatus, ProtectViewerConfig, Segment, Sensor } from "unifi-protect";
import { FIXTURE_HOST } from "../camera.fixtures.ts";
import type { LivestreamSubscription } from "../media/livestream.ts";
import type { Nullable } from "homebridge-plugin-utils";
import type { ProtectConfigurePass } from "./device.ts";
import { ProtectDevice } from "./device.ts";
import type { TestStateStore } from "../testing.helpers.ts";

// The quiet-default camera feature flags the config builder populates, expressed as a named shape so the builder's featureFlags override option is a typed Partial
// of exactly this surface rather than an unchecked record.
export interface TestCameraFeatureFlags {

  hasChime: boolean;
  hasFingerprintSensor: boolean;
  hasIcrSensitivity: boolean;
  hasInfrared: boolean;
  hasLcdScreen: boolean;
  hasLedStatus: boolean;
  hasLuxCheck: boolean;
  hasMic: boolean;
  hasMotionDetection: boolean;
  hasPackageCamera: boolean;
  hasSmartDetect: boolean;
  hasSpeaker: boolean;
  hasTamperDetection: boolean;
  isDoorbell: boolean;
  smartDetectAudioTypes: string[];
  smartDetectTypes: string[];
}

/**
 * Build a minimal-but-real camera config record for construction tests: every field the ProtectCamera construction path actually reads is populated with the
 * quiet-default shape (every feature flag false except the controller's motion report, recording mode "always", a CONNECTED state, and the fixture host so channel
 * URLs match the golden-master corpus), and the record is then cast once to the full wire type. This is the ONE confined cast boundary for the camera record: the
 * ProtectCameraConfig wire type carries many fields the construction path never touches, so we populate the verified read set and document the cast here rather than
 * scattering casts through tests - the same spirit as camera.fixtures.ts' makeChannel, carried as far as is practical for a much wider record. Every override merges
 * BEFORE the single cast, so an overridden record is exactly as type-honest as the default one.
 *
 * @param options - accessDeviceMetadata: seeds the paired Access reader's supportUnlock capability flag for the camera's UniFi Access lock construction tests;
 *                  channels: the typed channel array (reuse the camera.fixtures.ts corpus); featureFlags: per-flag overrides merged over the quiet defaults, where
 *                  every flag reads false except hasMotionDetection, which reads true so a default camera is one Protect exposes a motion sensor for (a doorbell test
 *                  sets isDoorbell, a package test adds hasPackageCamera, an eligibility test sets hasMotionDetection false); chimeDuration / enableNfc / isDark /
 *                  lcdMessage: the doorbell-adjacent fields its configure paths read; id / mac / name: optional identity overrides; isThirdPartyCamera: whether the
 *                  camera is a third-party camera (default false, the first-party camera every other suite assumes); smartDetectSettings: the controller-side
 *                  smart-detection settings, whose enabled-type lists default to mirroring the advertised capability (see below); videoCodec: the codec string
 *                  (default "h264"), overridable to "av1" so the playlist filter's codec exclusion can be exercised.
 *
 * @returns a camera config record the construction path reads as real.
 */
export function makeCameraConfig(options: { accessDeviceMetadata?: { featureFlags: { supportUnlock: boolean } }; channels: ProtectCameraChannelConfig[];
  chimeDuration?: number; enableNfc?: boolean; featureFlags?: Partial<TestCameraFeatureFlags>; id?: string; isDark?: boolean; isThirdPartyCamera?: boolean;
  lcdMessage?: { duration?: number; resetAt?: Nullable<number>; text?: string; type?: string }; mac?: string; name?: string;
  smartDetectSettings?: { audioTypes?: string[]; enableTamperDetection?: boolean; objectTypes?: string[] }; videoCodec?: string; }): ProtectCameraConfig {

  const name = options.name ?? "Test Camera";

  const populated = {

    channels: options.channels,
    chimeDuration: options.chimeDuration ?? 0,
    connectionHost: FIXTURE_HOST,
    displayName: name,
    enableNfc: options.enableNfc ?? false,
    featureFlags: {

      hasChime: false,
      hasFingerprintSensor: false,
      hasIcrSensitivity: false,
      hasInfrared: false,
      hasLcdScreen: false,
      hasLedStatus: false,
      hasLuxCheck: false,
      hasMic: false,

      // The controller's motion report defaults true: a default camera is one Protect exposes a motion sensor for, so it carries its motion sensor and can back
      // HomeKit Secure Video, while smart detection, like the other capabilities, stays off until a test reports it.
      hasMotionDetection: true,
      hasPackageCamera: false,
      hasSmartDetect: false,
      hasSpeaker: false,
      hasTamperDetection: false,
      isDoorbell: false,
      smartDetectAudioTypes: [],
      smartDetectTypes: [],
      ...options.featureFlags
    },
    firmwareVersion: "5.0.0",
    id: options.id ?? "test-camera-1",
    isAdopted: true,
    isAdoptedByAccessApp: false,
    isAdoptedByOther: false,
    isDark: options.isDark ?? false,
    isPairedWithAiPort: false,

    // Whether the camera is a third-party camera, overridable so a test can model one. It defaults to the first-party camera every other suite assumes.
    isThirdPartyCamera: options.isThirdPartyCamera ?? false,
    ispSettings: { icrCustomValue: 0, irLedMode: "off" },
    ledSettings: { isEnabled: false },
    mac: options.mac ?? "74ACB9000001",
    marketName: "Test Camera Model",
    name: name,
    recordingSettings: { mode: "always" },

    // The controller-side smart-detection settings. The two enabled-type lists default to MIRRORING the advertised capability, which is the ordinary field shape - a
    // camera whose supported detections the user has left switched on in Protect - so an arrangement that advertises a detection type gets a camera whose user has that
    // type enabled, and only a test about the user's own selection has to say otherwise. A test that narrows either list models the user switching a detection off.
    smartDetectSettings: {

      audioTypes: options.smartDetectSettings?.audioTypes ?? (options.featureFlags?.smartDetectAudioTypes ?? []),
      enableTamperDetection: options.smartDetectSettings?.enableTamperDetection ?? false,
      objectTypes: options.smartDetectSettings?.objectTypes ?? (options.featureFlags?.smartDetectTypes ?? [])
    },
    state: "CONNECTED",
    videoCodec: options.videoCodec ?? "h264",
    ...(options.accessDeviceMetadata !== undefined ? { accessDeviceMetadata: options.accessDeviceMetadata } : {}),
    ...(options.lcdMessage !== undefined ? { lcdMessage: options.lcdMessage } : {})
  };

  return populated as unknown as ProtectCameraConfig;
}

/**
 * Build a minimal-but-real chime config record, mirroring makeCameraConfig's discipline: the fields the doorbell's chime-volume derivation reads (cameraIds and the
 * per-doorbell ringSettings entries) are populated for real, plus the construction read-set the real ProtectChime now needs - displayName / firmwareVersion / marketName
 * are what setInfo reads (the model derivation prefers marketName, the firmware-revision write guards on firmwareVersion's presence), so they join the record now that
 * the chime is constructed for real rather than only modeled. type / hardwareRevision are omitted exactly as makeLightConfig omits them: marketName wins the model-name
 * derivation and the hardwareRevision guard short-circuits on absence, so the construction path stays type-honest without them. The rest of the wire type sits behind the
 * single documented cast.
 *
 * @param options - cameraIds: the doorbells this chime serves; id / mac / name: optional identity overrides; ringSettings: the per-doorbell ring entries (volume is
 *                  the field the derivation reads, repeatTimes / ringtoneId the play join reads).
 *
 * @returns a chime config record the chime-volume and construction paths read as real.
 */
export function makeChimeConfig(options: { cameraIds?: string[]; id?: string; mac?: string; name?: string;
  ringSettings?: { cameraId: string; repeatTimes?: number; ringtoneId?: string; volume: number }[]; } = {}): ProtectChimeConfig {

  const name = options.name ?? "Test Chime";

  const populated = {

    cameraIds: options.cameraIds ?? [],
    displayName: name,
    firmwareVersion: "5.0.0",
    id: options.id ?? "test-chime-1",
    isAdopted: true,
    isAdoptedByOther: false,
    mac: options.mac ?? "74ACB9000101",
    marketName: "Test Chime Model",
    modelKey: "chime",
    name: name,
    ringSettings: (options.ringSettings ?? []).map((ring) => ({

      cameraId: ring.cameraId,
      repeatTimes: ring.repeatTimes ?? 1,
      ringtoneId: ring.ringtoneId ?? "default",
      volume: ring.volume
    })),
    state: "CONNECTED",
    volume: 100
  };

  return populated as unknown as ProtectChimeConfig;
}

/**
 * Build a minimal-but-real light config record, mirroring makeCameraConfig's single-confined-cast discipline: every field the ProtectLight construction and observe
 * paths actually read is populated for real (the power state, the nested lightDeviceSettings the brightness and status-indicator selectors read, the motion timestamp,
 * and the identity / connection fields), and the record is cast once to the full wire type. The ProtectLightConfig wire type carries many fields the light's paths
 * never touch, so we populate the verified read set and confine the lone cast here. type / hardwareRevision are omitted exactly as makeCameraConfig omits them: the
 * marketName wins the model-name derivation and the hardwareRevision guard short-circuits on absence, so the construction path stays type-honest without them.
 *
 * @param options - id: optional identity override (defaults to "test-light-1"); isIndicatorEnabled: the nested status-indicator setting the isIndicatorEnabled selector
 *                  reads (defaults to false); isLightOn: the power state the Lightbulb On characteristic mirrors (defaults to false); lastMotion: the motion timestamp
 *                  the lastMotion observer gates on (defaults to null); ledLevel: the nested Protect 1-6 LED level the Brightness selector reads (defaults to 1, which
 *                  maps to 0%); mac: optional MAC override (defaults to a light-distinct value); name: optional display name (defaults to "Test Light").
 *
 * @returns a light config record the construction and observe paths read as real.
 */
export function makeLightConfig(options: { id?: string; isIndicatorEnabled?: boolean; isLightOn?: boolean; lastMotion?: Nullable<number>; ledLevel?: number;
  mac?: string; name?: string; } = {}): ProtectLightConfig {

  const name = options.name ?? "Test Light";

  const populated = {

    displayName: name,
    firmwareVersion: "5.0.0",
    id: options.id ?? "test-light-1",
    isAdopted: true,
    isAdoptedByOther: false,
    isLightOn: options.isLightOn ?? false,
    lastMotion: options.lastMotion ?? null,
    lightDeviceSettings: { isIndicatorEnabled: options.isIndicatorEnabled ?? false, ledLevel: options.ledLevel ?? 1 },
    mac: options.mac ?? "74ACB9000201",
    marketName: "Test Light Model",
    modelKey: "light",
    name: name,
    state: "CONNECTED"
  };

  return populated as unknown as ProtectLightConfig;
}

/**
 * Build a minimal-but-real viewer config record, mirroring makeLightConfig's single-confined-cast discipline: every field the ProtectViewer construction and observe
 * paths read is populated for real (the active liveview the switch state mirrors, plus the identity / connection / info fields setInfo reads), and the record is cast
 * once to the full wire type. The ProtectViewerConfig wire type carries many fields the viewer's paths never touch (the feature-flag bag, the connection-state objects),
 * so we populate the verified read set and confine the lone cast here. type / hardwareRevision are omitted exactly as makeLightConfig omits them.
 *
 * @param options - id: optional identity override (defaults to "test-viewer-1"); liveview: the active liveview id the switch-on reflection reads (defaults to null, no
 *                  active liveview); mac: optional MAC override (defaults to a viewer-distinct value); name: optional display name (defaults to "Test Viewer").
 *
 * @returns a viewer config record the construction and observe paths read as real.
 */
export function makeViewerConfig(options: { id?: string; liveview?: Nullable<string>; mac?: string; name?: string } = {}): ProtectViewerConfig {

  const name = options.name ?? "Test Viewer";

  const populated = {

    displayName: name,
    firmwareVersion: "5.0.0",
    id: options.id ?? "test-viewer-1",
    isAdopted: true,
    isAdoptedByOther: false,
    liveview: options.liveview ?? null,
    mac: options.mac ?? "74ACB9000301",
    marketName: "Test Viewer Model",
    modelKey: "viewer",
    name: name,
    state: "CONNECTED"
  };

  return populated as unknown as ProtectViewerConfig;
}

/**
 * Build the status block a UniFi Protect smoke detector reports, at rest: every alarm and fault clear, both raw readings at zero, the unit enabled, ready, and mounted.
 * This is the shape the field capture shows a healthy detector sending, so a case that wants an alarm, a fault, or a self-test names only the members it moves.
 *
 * The controller sends the block WHOLE on every patch, so a case pushes the full result of this builder rather than a partial - which is also why the overrides are
 * spread over a complete block rather than folded into a sparse one. An override may carry a key the interface does not declare: the wire type's open index signature
 * admits it, and that is how a case proves the telemetry payload is built member by member rather than spread from the record.
 *
 * @param overrides - The block members to move off their at-rest values, keyed by member name.
 *
 * @returns a complete smoke status block the smoke-detector configure and telemetry paths read as real.
 */
export function makeSmokeStatus(overrides: Partial<ProtectSensorSmokeStatus> = {}): ProtectSensorSmokeStatus {

  return { alarmSilenced: false, batteryLow: false, batteryVoltage: 0, cleanSmokeSensor: false, coAlarm: false, coSensorFault: false, coValue: 0, enabled: true,
    endOfLife: false, ready: true, smokeAlarm: false, smokeSensorFault: false, smokeValue: 0, testing: false, troubleHushed: false, wasMounted: true, ...overrides };
}

/**
 * Build a minimal-but-real sensor config record, mirroring makeCameraConfig's wide-read-set discipline: every field the ProtectSensor construction, the base
 * device-capability paths (motion / occupancy / status-LED), and the later sensor-family configure paths actually read is populated for real, and the record is cast
 * once to the full wire type. A bare makeSensorConfig() is an all-quiet sensor - every *Settings.isEnabled is false, the LED indicator is off, the mount type is "none",
 * a battery is present and healthy, no air-quality stats are present, and every air-quality metric reads the not-capable unknown/null shape a sensor without that
 * hardware sends - and isMotionDetected defaults to TRUE so the Motion.* feature options satisfy their hasProperty
 * applicability gate (which makes the option visible to FeatureOptions; it is NOT the runtime service gate - that is the Enable.Motion.* userOptions string, since every
 * Motion.* option defaults to false). This is the ONE carrier the base-capability concern tests ride on AND the sensor-family fixture, so it is the single source for
 * the sensor shape - there is no second "base config" builder. type is absent unless a test supplies one, exactly as makeLightConfig omits it: marketName wins the
 * model-name derivation either way, so the construction path stays type-honest without it, while a supplied type serves the smoke leaf's model-family read.
 * hardwareRevision is OPT-IN with no default (stays absent), mirroring makeNvrConfig: a bare call omits the key so ProtectBase.setInfo's HardwareRevision length-guard
 * short-circuits, while passing a value lands it so the device-info HardwareRevision write nets non-vacuously. The air-quality stats sub-objects are
 * ProtectAirQualityMetricInterface ({ status, value }) shapes built only for the metrics a test supplies; the lone confined cast to ProtectSensorConfig carries the
 * whole record's type honesty (the ProtectThresholdSettings and ProtectAirQualityMetricInterface shapes are populated faithfully behind it rather than imported
 * separately).
 *
 * Two levels of the record carry same-named settings members with DIFFERENT shapes, and they must never be cross-wired: the record's TOP-LEVEL humiditySettings /
 * temperatureSettings are the margin-bearing environmental thresholds the humidity and temperature services read, while airQualitySettings nests its own
 * humiditySettings / temperatureSettings in the nullable, margin-less air-quality threshold shape. Each level is built by its own helper for exactly that reason.
 *
 * @param options - airQuality: per-metric readings folded over the not-capable defaults, keyed by metric name (defaults to none, every metric quiet); alarmEnabled: the
 *                  alarm settings toggle (defaults false); alarmSilencedAt: the alarm-silenced timestamp the smoke telemetry carries (defaults null);
 *                  alarmTriggeredAt: the alarm-trip timestamp (defaults null); alarmTypes: the alarm types the controller advertises in featureFlags.alarmTypes, which
 *                  the smoke leaf honors only on detector hardware (see marketName / type) - folded in ONLY when supplied, so a bare fixture is no smoke detector;
 *                  ambientLight: the ambient light reading folded into stats.light.value (omitted, no light stat); batteryLow / batteryPercentage: the battery status
 *                  (default false / 100);
 *                  co2Enabled: the carbon dioxide alert toggle folded into airQualitySettings.co2Settings.isEnabled (defaults false); co2Threshold: the carbon dioxide
 *                  alert level folded into airQualitySettings.co2Settings.highThreshold (defaults null, nothing configured); coAlarmTriggeredAt: the carbon monoxide
 *                  trip timestamp the smoke telemetry carries (defaults null);
 *                  externalLeakDetectedAt: the external-leak timestamp the leak path index-reads (defaults null); glassBreak: whether the controller advertises the
 *                  glass-break capability channel in featureFlags.glassBreak - the flag the alarm-family glass-break gate reads (defaults false, channel
 *                  absent); glassBreakEnabled: the glass-break settings toggle folded into glassBreakSettings.isEnabled (defaults false);
 *                  glassBreakTriggeredAt: the glass-break trip timestamp the glass-break contact reads (defaults null); hardwareRevision: the hardware
 *                  revision the device-info HardwareRevision write reads (OPT-IN, omitted by default so setInfo's length-guard short-circuits); humidity: the humidity
 *                  reading folded into stats.humidity.value (omitted, no humidity stat); humidityEnabled: the humidity settings toggle (defaults false); id: identity
 *                  override (defaults "test-sensor-1"); isConnected: the connection flag (defaults true); isMotionDetected: the Motion.* applicability property (defaults
 *                  true); isOpened: the contact state (defaults null); leakChannelNames: the water-leak channels the controller advertises in
 *                  featureFlags.waterLeak.channelNames - the flag the leak-policy leaf reads (defaults [], no leak capability); leakDetectedAt: the
 *                  internal-leak timestamp (defaults null); leakExternalEnabled / leakInternalEnabled: the leak settings toggles (default false); ledEnabled: the
 *                  status-indicator LED toggle (defaults false); lightEnabled: the light settings toggle (defaults false); mac: identity override (defaults a
 *                  sensor-distinct value); marketName: the controller's display model, which wins the model-name derivation and which the smoke leaf's model-family
 *                  read matches exactly (defaults "Test Sensor Model"); motionDetectedAt: the motion timestamp the sensor motion observer gates on (defaults 0);
 *                  motionEnabled: the motion settings toggle (defaults false); mountType: the sensor mount type (defaults "none"); name: display name (defaults
 *                  "Test Sensor"); smokeAlarmTriggeredAt: the
 *                  smoke-trip timestamp the smoke telemetry carries (defaults null); smokeStatus: the detector's status block, written EXPLICITLY as null when omitted
 *                  so a presence read never mistakes an absent key for a reported block (defaults null); tamperingDetectedAt: the
 *                  tamper timestamp (defaults null); temperature: the temperature reading folded into stats.temperature.value (omitted, no temperature stat);
 *                  temperatureEnabled: the temperature settings toggle (defaults false); troubleSilencedAt: the trouble-silenced timestamp the smoke telemetry carries
 *                  (defaults null); type: the family type the smoke leaf's model-family read matches by prefix (OPT-IN, omitted by default so a bare fixture carries no
 *                  type key at all); vapeEnabled: the controller's own vape detection toggle folded into airQualitySettings.vapeSensitivitySettings.isEnabled (defaults
 *                  false).
 *
 * @returns a sensor config record the construction, base-capability, and sensor-family paths read as real.
 */
export function makeSensorConfig(options: { airQuality?: Partial<ProtectSensorAirQuality>; alarmEnabled?: boolean; alarmSilencedAt?: Nullable<number>;
  alarmTriggeredAt?: Nullable<number>; alarmTypes?: string[];
  ambientLight?: number; batteryLow?: boolean; batteryPercentage?: Nullable<number>; co2Enabled?: boolean; co2Threshold?: Nullable<number>;
  coAlarmTriggeredAt?: Nullable<number>;
  externalLeakDetectedAt?: Nullable<number>; glassBreak?: boolean; glassBreakEnabled?: boolean; glassBreakTriggeredAt?: Nullable<number>; hardwareRevision?: string;
  humidity?: number; humidityEnabled?: boolean; id?: string; isConnected?: boolean; isMotionDetected?: boolean; isOpened?: Nullable<boolean>; leakChannelNames?: string[];
  leakDetectedAt?: Nullable<number>; leakExternalEnabled?: boolean; leakInternalEnabled?: boolean; ledEnabled?: boolean; lightEnabled?: boolean; mac?: string;
  marketName?: string; motionDetectedAt?: number; motionEnabled?: boolean; mountType?: string;
  name?: string; smokeAlarmTriggeredAt?: Nullable<number>; smokeStatus?: Nullable<ProtectSensorSmokeStatus>; tamperingDetectedAt?: Nullable<number>;
  temperature?: number; temperatureEnabled?: boolean; troubleSilencedAt?: Nullable<number>; type?: string; vapeEnabled?: boolean; } = {}): ProtectSensorConfig {

  const name = options.name ?? "Test Sensor";

  // A ProtectThresholdSettings shape ({ highThreshold, isEnabled, lowThreshold, margin }) keyed only by the isEnabled toggle a test cares about; the threshold numbers
  // are quiet, valid defaults the construction path never inspects.
  const thresholdSettings = (isEnabled: boolean): { highThreshold: number; isEnabled: boolean; lowThreshold: number; margin: number } => ({ highThreshold: 0, isEnabled,
    lowThreshold: 0, margin: 0 });

  // The air-quality per-metric threshold shape, which is NULLABLE and carries no margin - a different shape from the environmental thresholds above, so the two are
  // never interchangeable even where the member names collide. The defaults derive from the policy leaf's disabled constant, so the fixture and production agree on
  // what "nothing configured" looks like, and only the carbon dioxide alert a test drives departs from it.
  const airQualityThreshold = (isEnabled = DISABLED_THRESHOLD_SETTINGS.isEnabled, highThreshold = DISABLED_THRESHOLD_SETTINGS.highThreshold):
  ProtectAirQualityThresholdSettings => ({ highThreshold, isEnabled, lowThreshold: DISABLED_THRESHOLD_SETTINGS.lowThreshold });

  // Build the air-quality stats record only with the metrics a test supplies; each present metric is a ProtectAirQualityMetricInterface ({ status, value }) shape, so the
  // status string is carried alongside the value rather than overloading a bare { value }. An all-quiet sensor supplies no metrics, so stats is absent entirely.
  const stats: { humidity?: { status: string; value: number }; light?: { status: string; value: number }; temperature?: { status: string; value: number } } = {};

  if(options.humidity !== undefined) {

    stats.humidity = { status: "", value: options.humidity };
  }

  if(options.ambientLight !== undefined) {

    stats.light = { status: "", value: options.ambientLight };
  }

  if(options.temperature !== undefined) {

    stats.temperature = { status: "", value: options.temperature };
  }

  const populated = {

    // Every metric quiet unless a test names one: the controller sends the full block on every sensor, so the fixture does too, and a metric a test supplies simply
    // replaces its not-capable default.
    airQuality: { ...NOT_CAPABLE_AIR_QUALITY, ...options.airQuality },

    // The controller sends a threshold member for every metric with no exceptions - vape and voc included - alongside the reading cadence, the ring LED, the night-mode
    // schedule, and the vape sensitivity. All quiet by default; carbon dioxide and the vape enable are the levers a test reaches for.
    airQualitySettings: {

      alertInterval: 300,
      aqiSettings: airQualityThreshold(),
      co2Settings: airQualityThreshold(options.co2Enabled, options.co2Threshold),
      humiditySettings: airQualityThreshold(),
      nightModeBrightness: 0,
      nightModeEnabled: false,
      nightModeEndTime: "07:00",
      nightModeStartTime: "22:00",
      noxSettings: airQualityThreshold(),
      pm10p0Settings: airQualityThreshold(),
      pm1p0Settings: airQualityThreshold(),
      pm2p5Settings: airQualityThreshold(),
      pm4p0Settings: airQualityThreshold(),
      readingInterval: 60,
      ringLedBrightness: 0,
      ringLedMetric: 0,
      temperatureSettings: airQualityThreshold(),
      tvocSettings: airQualityThreshold(),
      vapeSensitivitySettings: { isEnabled: options.vapeEnabled ?? DISABLED_VAPE_SENSITIVITY.isEnabled, sensitivity: DISABLED_VAPE_SENSITIVITY.sensitivity },
      vapeSettings: airQualityThreshold(),
      vocSettings: airQualityThreshold()
    },
    alarmSettings: { isEnabled: options.alarmEnabled ?? false },
    alarmSilencedAt: options.alarmSilencedAt ?? null,
    alarmTriggeredAt: options.alarmTriggeredAt ?? null,
    batteryStatus: { isLow: options.batteryLow ?? false, percentage: options.batteryPercentage ?? 100 },
    coAlarmTriggeredAt: options.coAlarmTriggeredAt ?? null,
    displayName: name,
    externalLeakDetectedAt: options.externalLeakDetectedAt ?? null,

    // The minimal sensor featureFlags the leak-policy leaf, the alarm-family gate, and the smoke-policy leaf read: the water-leak capability the controller advertises
    // (keyed by channelNames, defaulting to [] so the all-quiet carrier exposes no leak service and registers no leak MQTT get), plus the glass-break channel and the
    // advertised alarm types, each folded in ONLY when a test opts in, so the alarm-family glass-break gate (featureFlags.glassBreak !== undefined) and the smoke gate's
    // advertisement half (the alarm type appearing in featureFlags.alarmTypes) both stay absent by default and present-with-capability on demand. The smoke gate's other
    // half is detector hardware, which the marketName / type model options carry rather than featureFlags, because no flag anywhere distinguishes a detector from a unit
    // that merely listens for its alarm sounds. The water-leak key is always emitted, so a genuinely empty featureFlags object - the shape UP Air Quality hardware
    // sends - is not a fixture this builder produces; the smoke leaf's own truth table covers that input directly.
    featureFlags: { waterLeak: { channelCount: (options.leakChannelNames ?? []).length, channelNames: options.leakChannelNames ?? [] },
      ...(options.alarmTypes ? { alarmTypes: options.alarmTypes } : {}),
      ...(options.glassBreak ? { glassBreak: { channelCount: 1 } } : {}) },
    firmwareVersion: "5.0.0",

    // The glass-break sensitivity settings are a REQUIRED wire field, so they are emitted UNCONDITIONALLY: the alarm-family glass-break gate reads
    // glassBreakSettings.isEnabled, which would throw a TypeError were the object absent the moment a test set the glassBreak channel present. Quiet defaults keep every
    // existing baseline unchanged; the isEnabled toggle is the only per-test lever.
    glassBreakSettings: { isEnabled: options.glassBreakEnabled ?? false, sensitivity: 0, sensitivityWhenArmed: 0 },

    // Emitted explicitly as null rather than left absent, exactly like alarmTriggeredAt: the wire always carries the key, and an absent key would read as a non-null
    // timestamp through sensorAlarmState and start every glass-break fixture tripped.
    glassBreakTriggeredAt: options.glassBreakTriggeredAt ?? null,
    humiditySettings: thresholdSettings(options.humidityEnabled ?? false),
    id: options.id ?? "test-sensor-1",
    isAdopted: true,
    isAdoptedByOther: false,
    isConnected: options.isConnected ?? true,
    isMotionDetected: options.isMotionDetected ?? true,
    isOpened: options.isOpened ?? null,
    leakDetectedAt: options.leakDetectedAt ?? null,
    leakSettings: { isExternalEnabled: options.leakExternalEnabled ?? false, isInternalEnabled: options.leakInternalEnabled ?? false },
    ledSettings: { isEnabled: options.ledEnabled ?? false },
    lightSettings: thresholdSettings(options.lightEnabled ?? false),
    mac: options.mac ?? "74ACB9000401",
    marketName: options.marketName ?? "Test Sensor Model",
    modelKey: "sensor",
    motionDetectedAt: options.motionDetectedAt ?? 0,
    motionSettings: { isEnabled: options.motionEnabled ?? false, sensitivity: 0 },
    mountType: options.mountType ?? "none",
    name: name,
    smokeAlarmTriggeredAt: options.smokeAlarmTriggeredAt ?? null,

    // Written EXPLICITLY as null rather than left off the record, because the smoke paths read the block's PRESENCE: an absent key and a reported block are the same
    // shape to a truthiness read, so the quiet default has to be a real null a detector-less sensor genuinely sends.
    smokeStatus: options.smokeStatus ?? null,
    state: "CONNECTED",
    tamperingDetectedAt: options.tamperingDetectedAt ?? null,
    temperatureSettings: thresholdSettings(options.temperatureEnabled ?? false),
    troubleSilencedAt: options.troubleSilencedAt ?? null,
    ...(Object.keys(stats).length ? { stats } : {}),

    // OPT-IN only, mirroring makeNvrConfig's hardwareRevision exactly: when the caller passes a value the device-info HardwareRevision write nets it on the record;
    // otherwise the field stays absent so ProtectBase.setInfo's length-guard short-circuits. The conditional spread keeps the key absent rather than
    // present-as-undefined, so an `in` check sees the same shape as when the option is omitted. type follows the same idiom for the same reason: the controller omits
    // it on some units, so a bare fixture has to reproduce a record that genuinely carries no type key for the smoke leaf's model-family read to be exercised honestly.
    ...(options.hardwareRevision !== undefined ? { hardwareRevision: options.hardwareRevision } : {}),
    ...(options.type !== undefined ? { type: options.type } : {})
  };

  return populated as unknown as ProtectSensorConfig;
}

/**
 * Build a minimal-but-real relay config record, mirroring makeLightConfig's single-confined-cast discipline: every field the ProtectRelay construction and observe paths
 * actually read is populated for real (the per-output on/off state the switches mirror, the LED indicator setting the status-LED switch reads, and the identity / info
 * fields setInfo and the base observers read), and the record is cast once to the full wire type. A bare makeRelayConfig() is a two-output relay, both outputs off, both
 * named null (so the "Output N" fallback naming is exercised) and the indicator off. The ProtectRelayConfig wire type carries fields the relay's paths never touch (the
 * inputs array, the LoRa connection state, host); we populate the verified read set and confine the lone cast here. Each output record likewise populates only the id /
 * name / state the plugin reads and rides the same single cast. type / hardwareRevision are omitted exactly as makeLightConfig omits them.
 *
 * @param options - id: optional identity override (defaults to "test-relay-1"); ledEnabled: the status-indicator setting the statusLed getter and ledSettings observer
 *                  read (defaults to false); mac: optional MAC override (defaults to a relay-distinct value); name: optional display name (defaults to "Test Relay");
 *                  outputs: the per-output records the switches, the observe reconcile, and MQTT read (defaults to two outputs, ids 0 and 1, both off and unnamed).
 *
 * @returns a relay config record the construction and observe paths read as real.
 */
export function makeRelayConfig(options: { id?: string; ledEnabled?: boolean; mac?: string; name?: string;
  outputs?: { id: number; name?: Nullable<string>; state?: "off" | "on" }[]; } = {}): ProtectRelayConfig {

  const name = options.name ?? "Test Relay";

  const populated = {

    displayName: name,
    firmwareVersion: "5.0.0",
    id: options.id ?? "test-relay-1",
    isAdopted: true,
    isAdoptedByOther: false,
    ledSettings: { isEnabled: options.ledEnabled ?? false },
    mac: options.mac ?? "74ACB9000501",
    marketName: "Test Relay Model",
    modelKey: "relay",
    name: name,
    outputs: (options.outputs ?? [ { id: 0, name: null, state: "off" }, { id: 1, name: null, state: "off" } ]).map((output) => ({ id: output.id,
      name: output.name ?? null, state: output.state ?? "off" })),
    state: "CONNECTED"
  };

  return populated as unknown as ProtectRelayConfig;
}

/**
 * Build a minimal-but-real fob config record, mirroring makeRelayConfig's single-confined-cast discipline: every field the ProtectFob construction and observe paths
 * actually read is populated for real (the marketName / type family identity resolveFobButtons reads, the buttonLabels labeling the button-name resolver reads, the
 * nested wirelessConnectionState.batteryStatus the battery service and its observers read, and the identity / info fields setInfo and the base observers read), and the
 * record is cast once to the full wire type. A bare makeFobConfig() is a recognized "USL Fob" with a full, not-low battery whose buttons carry the security-action
 * labeling; overriding buttonLabels to "positionHint" drives the numeric-name paths. The ProtectFobConfig wire type carries fields the fob's paths never touch (the
 * away/arm state, the pending arm action, the wireless connection settings); we populate the verified read set and confine the lone cast here.
 *
 * @param options - batteryLow: the low-battery flag the StatusLowBattery read and its observer read (defaults to false); batteryPercentage: the battery percentage the
 *                  BatteryLevel read and its observer read (defaults to 100, nullable so the percentage-absent fallback can be exercised); buttonLabels: the button
 *                  labeling the button-name resolver reads (defaults to "securityActions"; override to "positionHint" to drive the numeric names); id: optional identity
 *                  override (defaults to "test-fob-1"); mac: optional MAC override (defaults to a fob-distinct value); marketName: the marketName resolveFobButtons
 *                  matches (defaults to "USL Fob"; override alongside type to force the unrecognized-model path); name: optional display name (defaults to "Test Fob");
 *                  type: the family type prefix resolveFobButtons matches (defaults to "USL-Fob-US"; override alongside marketName to force the unrecognized-model path).
 *
 * @returns a fob config record the construction and observe paths read as real.
 */
export function makeFobConfig(options: { batteryLow?: boolean; batteryPercentage?: Nullable<number>; buttonLabels?: string; id?: string; mac?: string;
  marketName?: string; name?: string; type?: string; } = {}): ProtectFobConfig {

  const name = options.name ?? "Test Fob";

  const populated = {

    buttonLabels: options.buttonLabels ?? "securityActions",
    displayName: name,
    firmwareVersion: "1.0.0",
    id: options.id ?? "test-fob-1",
    isAdopted: true,
    isAdoptedByOther: false,
    mac: options.mac ?? "74ACB9000601",
    marketName: options.marketName ?? "USL Fob",
    modelKey: "fob",
    name: name,
    state: "CONNECTED",
    type: options.type ?? "USL-Fob-US",
    wirelessConnectionState: { batteryStatus: { isLow: options.batteryLow ?? false, percentage: options.batteryPercentage ?? 100 } }
  };

  return populated as unknown as ProtectFobConfig;
}

/**
 * Build a minimal-but-real ringtone config record. The chime scopes its speaker switches to the ringtones whose nvrMac matches this controller's MAC, so nvrMac
 * defaults to the makeNvrConfig MAC ("74ACB9FFFFFF"): any other default would fail the chime's tone.nvrMac === nvr.ufp.mac filter and create zero speaker switches,
 * silently emptying the chime suite. The rest of the wire type sits behind the single documented cast.
 *
 * @param options - id: optional identity override (defaults to "test-ringtone-1"); name: optional display name (defaults to "Test Ringtone"); nvrMac: the controller
 *                  MAC the chime filters on (defaults to the makeNvrConfig MAC so seeded ringtones survive the filter).
 *
 * @returns a ringtone config record the chime's ringtone-switch reconcile reads as real.
 */
export function makeRingtoneConfig(options: { id?: string; name?: string; nvrMac?: string } = {}): ProtectRingtoneConfig {

  const populated = {

    id: options.id ?? "test-ringtone-1",
    isDefault: false,
    modelKey: "ringtone",
    name: options.name ?? "Test Ringtone",
    nvrMac: options.nvrMac ?? "74ACB9FFFFFF",
    size: 0
  };

  return populated as unknown as ProtectRingtoneConfig;
}

/**
 * Build a minimal-but-real liveview config record. The viewer reads a liveview's id (to reconcile its switch set) and name (the switch display name, the MQTT label),
 * so those are populated for real; the rest of the wire type (layout, ownership flags) sits behind the single documented cast. slots defaults to empty (the viewer never
 * reads it), but the controller-owner net's motion fanouts flatten slots[].cameras (the security-system's setSecurityState and the liveviews' getLiveviewCameras), so a
 * cameras option populates a single slot with those member ids - a no-cameras call preserves the empty-slots default. DISTINCT-ID DISCIPLINE: makeProtectState keys the
 * liveviews map by id and the id default is the constant "test-liveview-1", so any test seeding MULTIPLE liveviews must pass a distinct id per record or they collapse to
 * one map entry, silently vacating the multi-state setProps reconcile and the per-name fanout lookups (the viewer.test.ts precedent passes distinct ids).
 *
 * @param options - cameras: optional member-camera ids populated into a single slot (defaults to no slot, preserving slots: []); id: optional identity override (defaults
 *                  to "test-liveview-1"); name: optional display name (defaults to "Test Liveview").
 *
 * @returns a liveview config record the viewer's switch reconcile and the controller-owner fanouts read as real.
 */
export function makeLiveviewConfig(options: { cameras?: string[]; id?: string; name?: string } = {}): ProtectNvrLiveviewConfig {

  const populated = {

    id: options.id ?? "test-liveview-1",
    isDefault: false,
    isGlobal: false,
    layout: 0,
    modelKey: "liveview",
    name: options.name ?? "Test Liveview",
    owner: "test-owner",
    slots: options.cameras ? [{ cameras: options.cameras, cycleInterval: 0, cycleMode: "motion" }] : []
  };

  return populated as unknown as ProtectNvrLiveviewConfig;
}

/* The Camera projection double, mirroring unifi-protect's DeviceProjection contract for the members the construction path reads: a stable id, the "camera"
 * modelKey, a READ-THROUGH config getter into the store double's CURRENT state (never a held snapshot - a push must change what this.ufp returns, or
 * an end-to-end push test proves nothing), and the derived name / isOnline getters using the projection's own definitions (name ?? displayName, and
 * state === "CONNECTED" per the library's isDeviceOnline). It now exposes the write-through update the camera's bound onSets dispatch (the night-vision dimmer's
 * ispSettings write, the recording switch's recordingSettings write, the camera-routed status-LED's ledSettings write), RECORDING the payload and resolving by
 * default with a settable updateRejection so a test drives the real runDeviceCommand failure path. It also exposes the best-effort, runDeviceCommand-bypassing
 * commands the camera issues on a cadence - the ambient-light lux query (a reading the configure path reads at setup and on a 60-second poll) and the
 * package-camera flashlight pulse (the dark-guarded retry-and-heartbeat) - each RECORDING its calls and resolving by default with a settable rejection so a test
 * drives the real sentinel-swallowing failure paths. It also exposes the recorded UniFi Access unlock command (unlockCalls / unlockRejection) the lock's
 * LockTargetState onSet dispatches, resolving by default with a settable rejection so a test drives the runDeviceCommand failure -> optimistic-revert path.
 * It also exposes the pooled livestream the camera's derivation opens to read its recording audio format, RECORDING each call with the subscription double it
 * answered, so every device suite that builds a reachable camera able to back HomeKit Secure Video completes its derivation, and a probe test reads the calls.
 * The remaining METHODS (talkback, snapshot, reboot) sit behind gates the minimal construction scenario never opens and are deliberately omitted - a test that
 * reaches one fails loudly on the missing member instead of silently succeeding against a stub.
 */
export class TestCameraProjection {

  public readonly id: string;
  // The recorded livestream calls: the options the camera handed the pool (the source it selected, the urgency closure, the signal) and the subscription double each
  // call answered, whose disposal a test reads.
  public readonly livestreamCalls: { options: LivestreamOptions; subscription: TestLivestreamSubscription }[] = [];
  // The description each answered subscription's init carries once it establishes. No tracks by default - a stream with no readable audio track - so a construction
  // derives no audio format unless a test scripts one before construction.
  public livestreamDescription: LivestreamDescription = { tracks: [] };
  // Whether each answered subscription establishes. True by default; a test sets it false to drive the stream that never establishes.
  public livestreamEstablishes = true;
  // When set, each answered subscription's establishment waits on this promise before it answers, so a test can land an event - a removal, a shutdown, a second
  // reconcile - while the derivation is still waiting on its stream.
  public livestreamGate: Nullable<Promise<void>> = null;
  public readonly modelKey = "camera" as const;
  // The recorded update payloads the camera's real onSet write-through commands dispatch, so a test asserts the exact payload (the ispSettings / recordingSettings /
  // ledSettings the bound handlers issue). The shape stays general because the camera issues distinct payload shapes through this one member.
  public readonly updateCalls: { payload: unknown }[] = [];
  // The settable rejection: when set, the next update rejects with it, so a test drives the real runDeviceCommand failure branch (a plain Error or a
  // ProtectAuthorizationError).
  public updateRejection: Nullable<Error> = null;
  // The ambient-light reading lux() resolves with - a benign positive default, only reached when featureFlags.hasLuxCheck opens the ambient light capability's reconcile.
  // A test sets it (zero for the floor sentinel, a positive value for the passthrough) before construction or before a poll. luxRejection drives the throw -> -1
  // sentinel, and luxCalls is the proof the unreachable arm never issues the doomed query (the reconcile short-circuits to -1 without calling lux at all when offline).
  public luxReading = 100;
  public luxRejection: Nullable<Error> = null;
  public readonly luxCalls: { opts?: { signal?: AbortSignal } }[] = [];
  // The recorded UniFi Access unlock commands the lock's LockTargetState onSet dispatches when the user drives it to UNSECURED, so a test proves the onSet was actually
  // bound (a restart re-wire records exactly one call) rather than fired by the establishment stamp alone. unlockRejection drives the runDeviceCommand failure branch
  // (the optimistic UNSECURED reverts to SECURED), mirroring the luxRejection / updateRejection levers.
  public unlockRejection: Nullable<Error> = null;
  public readonly unlockCalls: { opts?: { signal?: AbortSignal } }[] = [];
  // The recorded flashlight pulses turnOnFlashlight() resolves into, so a test asserts the retry budget by count (one on a success or a heartbeat re-pulse, three on the
  // exhausted failure). flashlightRejection drives the retry-exhaustion failure path, where the catch swallows the pulse to a reflected-off switch.
  public flashlightRejection: Nullable<Error> = null;
  public readonly flashlightCalls: { opts?: { signal?: AbortSignal } }[] = [];
  private readonly store: TestStateStore;

  public constructor(id: string, store: TestStateStore) {

    this.id = id;
    this.store = store;
  }

  // Read-through config into the store double's current state, mirroring the real projection's absent-record guard.
  public get config(): Readonly<ProtectCameraConfig> {

    const config = this.store.snapshot().cameras.get(this.id);

    if(!config) {

      throw new ReferenceError("The camera record is not present in the store double: " + this.id + ".");
    }

    return config;
  }

  // The non-throwing companion to config, mirroring the real projection's peek(): the current config, or undefined when the record is absent from the store double.
  public peek(): Readonly<ProtectCameraConfig> | undefined {

    return this.store.snapshot().cameras.get(this.id) ?? undefined;
  }

  // Whether the device is currently connected, per the library's isDeviceOnline definition.
  public get isOnline(): boolean {

    return this.config.state === "CONNECTED";
  }

  // The device's display name - its user-assigned name when set, otherwise the controller's displayName, per the DeviceProjection convention.
  public get name(): string {

    return this.config.name ?? this.config.displayName;
  }

  // Record an update payload and resolve with this projection, or reject with the settable rejection so a test drives the failure path. It RECORDS ONLY - it does NOT
  // fold the payload into the store, so every reflection stays inline-local (the dimmer Brightness snaps its own local level, the recording switch flips its siblings
  // inline) or observer-driven (a test pushes the reflection through pushCameraPatch), keeping the command and the reflection independently asserted.
  public async update(payload: unknown): Promise<this> {

    this.updateCalls.push({ payload });

    if(this.updateRejection) {

      throw this.updateRejection;
    }

    return this;
  }

  // Record a lux query and resolve with the settable reading, or reject with the settable rejection so a test drives the catch -> -1 throw sentinel. It RECORDS the call
  // (luxCalls) so a test proves the unreachable arm never queries, and returns the raw reading - the camera's getLux closure owns the 0 -> 0.0001 floor and the -1
  // sentinel mapping, so this double stays a faithful library projection and does no sentinel logic of its own.
  public async lux(opts?: { signal?: AbortSignal }): Promise<number> {

    this.luxCalls.push({ opts });

    if(this.luxRejection) {

      throw this.luxRejection;
    }

    return this.luxReading;
  }

  // Record an Access unlock command and resolve, or reject with the settable rejection so a test drives the runDeviceCommand failure -> optimistic-revert path. RECORDS
  // the call (unlockCalls) so a test proves the lock's onSet bound and dispatched exactly one unlock - the observable proxy for the wire-every-configure re-bind a
  // Homebridge restart relies on - and does no lock-state logic of its own, staying a faithful library projection (the controller's Access bridge is one-way and
  // fire-and-forget).
  public async unlock(opts?: { signal?: AbortSignal }): Promise<void> {

    this.unlockCalls.push({ opts });

    if(this.unlockRejection) {

      throw this.unlockRejection;
    }
  }

  // Record a flashlight pulse and resolve, or reject with the settable rejection so a test drives the retry-exhaustion failure path (the package camera's
  // activateFlashlight retries three times, then swallows a persistent rejection to a reflected-off switch). RECORDS the call so a test asserts the retry budget.
  public async turnOnFlashlight(opts?: { signal?: AbortSignal }): Promise<void> {

    this.flashlightCalls.push({ opts });

    if(this.flashlightRejection) {

      throw this.flashlightRejection;
    }
  }

  // Open a pooled livestream subscription, mirroring the projection's one-argument contract: RECORDS the options and answers a subscription double scripted by the
  // levers above, read at the moment of the call.
  public livestream(options: LivestreamOptions): TestLivestreamSubscription {

    const subscription = new TestLivestreamSubscription({ description: this.livestreamDescription, establishes: this.livestreamEstablishes, gate: this.livestreamGate,
      signal: options.signal });

    this.livestreamCalls.push({ options, subscription });

    return subscription;
  }
}

/* The subscription double the camera projection double's livestream answers, satisfying the plugin's LivestreamSubscription contract. It establishes promptly with an
 * init carrying its scripted description (or declines when scripted to), waiting first on an optional gate so a test can hold the establishment open. Its init is null
 * until it establishes, as the pool's cached init is, and a disposal - directly, or through the signal it was handed, as the pool's subscription binds it - records
 * disposed, reads "closed", and answers any later establishment false. Its iterator delivers nothing: the device suites' streaming delegate is a stub whose
 * supervisor never consumes it.
 */
export class TestLivestreamSubscription implements LivestreamSubscription {

  public disposed = false;
  public readonly id: string;
  #init: Nullable<LivestreamInit> = null;
  readonly #description: LivestreamDescription;
  readonly #establishes: boolean;
  readonly #gate: Nullable<Promise<void>>;
  static #counter = 0;

  public constructor(options: { description: LivestreamDescription; establishes: boolean; gate: Nullable<Promise<void>>; signal?: AbortSignal }) {

    this.id = "test-projection-livestream-" + (++TestLivestreamSubscription.#counter).toString();
    this.#description = options.description;
    this.#establishes = options.establishes;
    this.#gate = options.gate;
    options.signal?.addEventListener("abort", () => void this[Symbol.asyncDispose](), { once: true });
  }

  public get initSegment(): Nullable<LivestreamInit> {

    return this.#init;
  }

  public get state(): LivestreamSubscriptionState {

    if(this.disposed) {

      return "closed";
    }

    return this.#init ? "live" : "connecting";
  }

  public reassess(): void {

    // Nothing to re-decide - the double has no recovery loop.
  }

  public async whenEstablished(): Promise<boolean> {

    await this.#gate;

    if(this.disposed || !this.#establishes) {

      return false;
    }

    this.#init = { codec: "avc1.4d4032", data: Buffer.from("test-projection-init"), description: this.#description };

    return true;
  }

  public async *[Symbol.asyncIterator](): AsyncGenerator<Segment> {

    // The double delivers no segments.
  }

  public async [Symbol.asyncDispose](): Promise<void> {

    this.disposed = true;
  }
}

/* The Light projection double, the exact analog of TestCameraProjection for the light family: a stable id, the "light" modelKey, a READ-THROUGH config
 * getter into the store double's CURRENT state (never a held snapshot - a push must change what this.ufp returns, or an end-to-end observe test proves nothing), and
 * the derived name / isOnline getters using the projection's own definitions (name ?? displayName, and state === "CONNECTED" per the library's isDeviceOnline). It now
 * exposes the write-through update the light's bound onSets dispatch (the lightOnSettings.isLedForceOn power write the On onSet issues, and the lightDeviceSettings
 * .ledLevel brightness write the Brightness onSet issues), RECORDING the payload and resolving by default with a settable updateRejection so a test drives the real
 * runDeviceCommand failure path. It mirrors TestCameraProjection: the read-through config getter PLUS the recording update member, the resolve-by-default idiom.
 */
export class TestLightProjection {

  public readonly id: string;
  public readonly modelKey = "light" as const;
  // The recorded update payloads the light's real onSet write-through commands dispatch (the lightOnSettings.isLedForceOn power write and the lightDeviceSettings
  // .ledLevel brightness write), so a test asserts the exact payload. The shape stays general because the light issues two distinct payload shapes through this member.
  public readonly updateCalls: { payload: unknown }[] = [];
  // The settable rejection: when set, the next update rejects with it, so a test drives the real runDeviceCommand failure branch (a plain Error or a
  // ProtectAuthorizationError).
  public updateRejection: Nullable<Error> = null;
  private readonly store: TestStateStore;

  public constructor(id: string, store: TestStateStore) {

    this.id = id;
    this.store = store;
  }

  // Read-through config into the store double's current state, mirroring the real projection's absent-record guard.
  public get config(): Readonly<ProtectLightConfig> {

    const config = this.store.snapshot().lights.get(this.id);

    if(!config) {

      throw new ReferenceError("The light record is not present in the store double: " + this.id + ".");
    }

    return config;
  }

  // The non-throwing companion to config, mirroring the real projection's peek(): the current config, or undefined when the record is absent from the store double.
  public peek(): Readonly<ProtectLightConfig> | undefined {

    return this.store.snapshot().lights.get(this.id) ?? undefined;
  }

  // Whether the device is currently connected, per the library's isDeviceOnline definition.
  public get isOnline(): boolean {

    return this.config.state === "CONNECTED";
  }

  // The device's display name - its user-assigned name when set, otherwise the controller's displayName, per the DeviceProjection convention.
  public get name(): string {

    return this.config.name ?? this.config.displayName;
  }

  // Record an update payload and resolve with this projection, or reject with the settable rejection so a test drives the failure path. It RECORDS ONLY - it does NOT
  // fold the payload into the store, so the command (the captured updateCalls payload) and any reflection (the 50ms Brightness re-reflect, the publish) stay
  // independently asserted, exactly as TestCameraProjection.update does.
  public async update(payload: unknown): Promise<this> {

    this.updateCalls.push({ payload });

    if(this.updateRejection) {

      throw this.updateRejection;
    }

    return this;
  }
}

/* The Chime projection double, the chime-family analog of TestLightProjection: a stable id, the "chime" modelKey, a READ-THROUGH config getter into the
 * store double's CURRENT state (never a held snapshot - a push must change what this.ufp returns, or an end-to-end observe test proves nothing), and the derived name /
 * isOnline getters using the projection's own definitions. Unlike the read-only Light / Camera projections, the chime exposes a COMMAND surface: the real ProtectChime's
 * playTone dispatches to playBuzzer / playSpeaker, so this double records every play call and resolves by default, with a settable playRejection so a test can drive the
 * real runDeviceCommand failure (and, for a ProtectAuthorizationError, the admin-guidance) path. It also exposes the write-through update the doorbell's cross-device
 * setChimeVolume drives through client.chimes (the per-doorbell ring-volume PATCH), RECORDING the payload and resolving by default with a settable updateRejection - kept
 * DISTINCT from playRejection so the volume-write failure drive and the play failure drive are two independent levers - so a test drives the real runDeviceCommand
 * failure path on the volume write.
 */
export class TestChimeProjection {

  public readonly id: string;
  public readonly modelKey = "chime" as const;
  // The recorded play commands the real playTone dispatches into, so a test asserts the exact dispatch (buzzer vs speaker) and, for the speaker, the joined payload.
  public readonly playBuzzerCalls: { opts?: { signal?: AbortSignal } }[] = [];
  public readonly playSpeakerCalls: { opts: PlaySpeakerOptions }[] = [];
  // The settable rejection: when set, the next play command rejects with it, so a test drives the real runDeviceCommand failure (a plain Error) or the admin-guidance
  // (a ProtectAuthorizationError) branch.
  public playRejection: Nullable<Error> = null;
  // The recorded update payloads the doorbell's cross-device setChimeVolume dispatches into (the single-entry ringSettings PATCH for this doorbell's ring), so a test
  // asserts the exact write payload. The shape stays general because the write carries the per-doorbell ring PATCH.
  public readonly updateCalls: { payload: unknown }[] = [];
  // The settable rejection for the volume write, kept DISTINCT from playRejection (two independent levers, never overloaded): when set, the next update rejects with it,
  // so a test drives the real runDeviceCommand failure branch (a plain Error or a ProtectAuthorizationError) on the chime-volume write specifically.
  public updateRejection: Nullable<Error> = null;
  private readonly store: TestStateStore;

  public constructor(id: string, store: TestStateStore) {

    this.id = id;
    this.store = store;
  }

  // Read-through config into the store double's current state, mirroring the real projection's absent-record guard.
  public get config(): Readonly<ProtectChimeConfig> {

    const config = this.store.snapshot().chimes.get(this.id);

    if(!config) {

      throw new ReferenceError("The chime record is not present in the store double: " + this.id + ".");
    }

    return config;
  }

  // The non-throwing companion to config, mirroring the real projection's peek(): the current config, or undefined when the record is absent from the store double.
  public peek(): Readonly<ProtectChimeConfig> | undefined {

    return this.store.snapshot().chimes.get(this.id) ?? undefined;
  }

  // Whether the device is currently connected, per the library's isDeviceOnline definition.
  public get isOnline(): boolean {

    return this.config.state === "CONNECTED";
  }

  // The device's display name - its user-assigned name when set, otherwise the controller's displayName, per the DeviceProjection convention.
  public get name(): string {

    return this.config.name ?? this.config.displayName;
  }

  // Record a buzzer play and resolve, or reject with the settable rejection so a test drives the failure path.
  public async playBuzzer(opts?: { signal?: AbortSignal }): Promise<void> {

    this.playBuzzerCalls.push({ opts });

    if(this.playRejection) {

      throw this.playRejection;
    }
  }

  // Record a speaker play with its joined payload and resolve, or reject with the settable rejection so a test drives the failure path.
  public async playSpeaker(opts: PlaySpeakerOptions = {}): Promise<void> {

    this.playSpeakerCalls.push({ opts });

    if(this.playRejection) {

      throw this.playRejection;
    }
  }

  // Record a volume-write update payload and resolve with this projection, or reject with the settable updateRejection so a test drives the real runDeviceCommand failure
  // path on the doorbell's cross-device chime-volume write. It RECORDS ONLY - it does NOT fold the payload into the store, so the volume reflection stays observer-driven
  // and the command and the reflection are independently asserted.
  public async update(payload: unknown): Promise<this> {

    this.updateCalls.push({ payload });

    if(this.updateRejection) {

      throw this.updateRejection;
    }

    return this;
  }
}

/* The Viewer projection double, the viewer-family analog of TestLightProjection: a stable id, the "viewer" modelKey, a READ-THROUGH config getter into the
 * store double's CURRENT state (never a held snapshot - a push must change what this.ufp returns, or an end-to-end observe test proves nothing), and the derived name /
 * isOnline getters. Unlike the read-only Light / Camera projections, the viewer drives its controller through the write-through update command, so this double exposes an
 * update that RECORDS its payload and resolves by default, with a settable updateRejection so a test can drive the real runDeviceCommand failure path. It records only -
 * it deliberately does NOT fold the payload back into the store, because the viewer's active-liveview reflection is observer-driven (setViewer does not update the local
 * config); a test drives that reflection through pushViewerPatch, keeping the command and the reflection independently asserted.
 */
export class TestViewerProjection {

  public readonly id: string;
  public readonly modelKey = "viewer" as const;
  // The recorded update payloads the real setViewer dispatches, so a test asserts the exact write-through liveview payload.
  public readonly updateCalls: { liveview: Nullable<string> }[] = [];
  // The settable rejection: when set, the next update rejects with it, so a test drives the real runDeviceCommand failure branch.
  public updateRejection: Nullable<Error> = null;
  private readonly store: TestStateStore;

  public constructor(id: string, store: TestStateStore) {

    this.id = id;
    this.store = store;
  }

  // Read-through config into the store double's current state, mirroring the real projection's absent-record guard.
  public get config(): Readonly<ProtectViewerConfig> {

    const config = this.store.snapshot().viewers.get(this.id);

    if(!config) {

      throw new ReferenceError("The viewer record is not present in the store double: " + this.id + ".");
    }

    return config;
  }

  // The non-throwing companion to config, mirroring the real projection's peek(): the current config, or undefined when the record is absent from the store double.
  public peek(): Readonly<ProtectViewerConfig> | undefined {

    return this.store.snapshot().viewers.get(this.id) ?? undefined;
  }

  // Whether the device is currently connected, per the library's isDeviceOnline definition.
  public get isOnline(): boolean {

    return this.config.state === "CONNECTED";
  }

  // The device's display name - its user-assigned name when set, otherwise the controller's displayName, per the DeviceProjection convention.
  public get name(): string {

    return this.config.name ?? this.config.displayName;
  }

  // Record an update payload and resolve with this projection, or reject with the settable rejection so a test drives the failure path. The payload is recorded only;
  // it is NOT folded into the store, so the active-liveview reflection stays observer-driven (a test pushes the reflection through pushViewerPatch).
  public async update(payload: { liveview: Nullable<string> }): Promise<this> {

    this.updateCalls.push({ liveview: payload.liveview });

    if(this.updateRejection) {

      throw this.updateRejection;
    }

    return this;
  }
}

/* The Sensor projection double, the sensor-family analog of TestViewerProjection: a stable id, the "sensor" modelKey, a READ-THROUGH config getter into the
 * store double's CURRENT state (never a held snapshot - a push must change what this.ufp returns, or an end-to-end observe test proves nothing), and the derived name /
 * isOnline getters using the projection's own definitions. Like the viewer it exposes a write-through update that RECORDS its payload and resolves by default, with a
 * settable updateRejection so a test drives the real runDeviceCommand failure path (the sensor's status-LED command writes ledSettings through it). It RECORDS only - it
 * deliberately does NOT fold the payload back into the store, mirroring the viewer: the device-statusled concern test and the sensor family exercise that recorder later,
 * while the device-motion base-capability net rides on it purely as the read-through carrier. The payload is recorded as the raw value so the recorder is general across
 * every command shape driven through it.
 */
export class TestSensorProjection {

  public readonly id: string;
  public readonly modelKey = "sensor" as const;
  // The recorded update payloads the real write-through commands dispatch, so a test asserts the exact payload (the status-LED ledSettings write, for example).
  public readonly updateCalls: { payload: unknown }[] = [];
  // The settable rejection: when set, the next update rejects with it, so a test drives the real runDeviceCommand failure branch.
  public updateRejection: Nullable<Error> = null;
  private readonly store: TestStateStore;

  public constructor(id: string, store: TestStateStore) {

    this.id = id;
    this.store = store;
  }

  // Read-through config into the store double's current state, mirroring the real projection's absent-record guard.
  public get config(): Readonly<ProtectSensorConfig> {

    const config = this.store.snapshot().sensors.get(this.id);

    if(!config) {

      throw new ReferenceError("The sensor record is not present in the store double: " + this.id + ".");
    }

    return config;
  }

  // The non-throwing companion to config, mirroring the real projection's peek(): the current config, or undefined when the record is absent from the store double.
  public peek(): Readonly<ProtectSensorConfig> | undefined {

    return this.store.snapshot().sensors.get(this.id) ?? undefined;
  }

  // Whether the device is currently connected, per the library's isDeviceOnline definition.
  public get isOnline(): boolean {

    return this.config.state === "CONNECTED";
  }

  // The device's display name - its user-assigned name when set, otherwise the controller's displayName, per the DeviceProjection convention.
  public get name(): string {

    return this.config.name ?? this.config.displayName;
  }

  // Record an update payload and resolve with this projection, or reject with the settable rejection so a test drives the failure path. The payload is recorded only; it
  // is NOT folded into the store, mirroring the viewer projection - a reactive reflection that stays observer-driven through a push helper.
  public async update(payload: unknown): Promise<this> {

    this.updateCalls.push({ payload });

    if(this.updateRejection) {

      throw this.updateRejection;
    }

    return this;
  }
}

/* The Relay projection double, the relay-family analog of TestSensorProjection: a stable id, the "relay" modelKey, a READ-THROUGH config getter into the
 * store double's CURRENT state (never a held snapshot - a push must change what this.ufp returns, or an end-to-end observe test proves nothing), and the derived name /
 * isOnline getters using the projection's own definitions. Unlike the read-only Light / Sensor projections it exposes TWO command surfaces the real ProtectRelay drives:
 * the write-through update the status-LED switch issues (recording its ledSettings payload), and the faithful toggleOutput primitive the set-to-toggle guard dispatches
 * (recording each toggled output id). Each records-but-does-not-fold and resolves by default, with a settable updateRejection / toggleRejection kept DISTINCT - so the
 * LED-write failure drive and the toggle failure drive are two independent levers, never overloaded - so a test drives the real runDeviceCommand failure path on either.
 * The output-state reflection stays observer-driven: a test moves it through pushRelayPatch, keeping the toggle command and its reflection independently asserted.
 */
export class TestRelayProjection {

  public readonly id: string;
  public readonly modelKey = "relay" as const;
  // The recorded output ids the real set-to-toggle guard dispatches into via toggleOutput, so a test asserts exactly which outputs were toggled (and how many times).
  public readonly toggleCalls: { outputId: number }[] = [];
  // The settable rejection for the toggle command, kept DISTINCT from updateRejection: when set, the next toggleOutput rejects with it, so a test drives the real
  // runDeviceCommand failure branch on the toggle specifically.
  public toggleRejection: Nullable<Error> = null;
  // The recorded update payloads the status-LED switch's write-through command dispatches (the ledSettings.isEnabled write), so a test asserts the exact payload.
  public readonly updateCalls: { payload: unknown }[] = [];
  // The settable rejection for the LED write, kept DISTINCT from toggleRejection: when set, the next update rejects with it, so a test drives the real runDeviceCommand
  // failure branch on the status-LED write specifically.
  public updateRejection: Nullable<Error> = null;
  private readonly store: TestStateStore;

  public constructor(id: string, store: TestStateStore) {

    this.id = id;
    this.store = store;
  }

  // Read-through config into the store double's current state, mirroring the real projection's absent-record guard.
  public get config(): Readonly<ProtectRelayConfig> {

    const config = this.store.snapshot().relays.get(this.id);

    if(!config) {

      throw new ReferenceError("The relay record is not present in the store double: " + this.id + ".");
    }

    return config;
  }

  // The non-throwing companion to config, mirroring the real projection's peek(): the current config, or undefined when the record is absent from the store double.
  public peek(): Readonly<ProtectRelayConfig> | undefined {

    return this.store.snapshot().relays.get(this.id) ?? undefined;
  }

  // Whether the device is currently connected, per the library's isDeviceOnline definition.
  public get isOnline(): boolean {

    return this.config.state === "CONNECTED";
  }

  // The device's display name - its user-assigned name when set, otherwise the controller's displayName, per the DeviceProjection convention.
  public get name(): string {

    return this.config.name ?? this.config.displayName;
  }

  // Toggle one output: record the output id and resolve, or reject with the settable rejection so a test drives the real runDeviceCommand failure path. It records ONLY -
  // it deliberately does NOT fold the flip into the store, mirroring the controller's write-through grain; a test reflects the resulting output state through
  // pushRelayPatch so the command and its reflection stay independently asserted.
  public async toggleOutput(outputId: number): Promise<void> {

    this.toggleCalls.push({ outputId });

    if(this.toggleRejection) {

      throw this.toggleRejection;
    }
  }

  // Record an update payload (the status-LED ledSettings write) and resolve with this projection, or reject with the settable rejection so a test drives the failure
  // path. Records only; it does NOT fold the payload into the store, mirroring the sensor projection.
  public async update(payload: unknown): Promise<this> {

    this.updateCalls.push({ payload });

    if(this.updateRejection) {

      throw this.updateRejection;
    }

    return this;
  }
}

/* The Fob projection double, the fob-family analog of TestRelayProjection but MINUS the command levers: a fob is a pure-input device (its button presses arrive as
 * firehose occurrences, its away/arm state is read-only), so the real ProtectFob issues no write-through commands and this double exposes none. What remains is the
 * read-only surface the construction and observe paths read: a stable id, the "fob" modelKey, a READ-THROUGH config getter into the store double's CURRENT
 * state (never a held snapshot - a push must change what this.config returns, or an end-to-end observe test proves nothing), the non-throwing peek() companion, and the
 * derived name / isOnline getters using the projection's own definitions.
 */
export class TestFobProjection {

  public readonly id: string;
  public readonly modelKey = "fob" as const;
  private readonly store: TestStateStore;

  public constructor(id: string, store: TestStateStore) {

    this.id = id;
    this.store = store;
  }

  // Read-through config into the store double's current state, mirroring the real projection's absent-record guard.
  public get config(): Readonly<ProtectFobConfig> {

    const config = this.store.snapshot().fobs.get(this.id);

    if(!config) {

      throw new ReferenceError("The fob record is not present in the store double: " + this.id + ".");
    }

    return config;
  }

  // The non-throwing companion to config, mirroring the real projection's peek(): the current config, or undefined when the record is absent from the store double.
  public peek(): Readonly<ProtectFobConfig> | undefined {

    return this.store.snapshot().fobs.get(this.id) ?? undefined;
  }

  // Whether the device is currently connected, per the library's isDeviceOnline definition.
  public get isOnline(): boolean {

    return this.config.state === "CONNECTED";
  }

  // The device's display name - its user-assigned name when set, otherwise the controller's displayName, per the DeviceProjection convention.
  public get name(): string {

    return this.config.name ?? this.config.displayName;
  }
}

/* The shared minimal base-capability vehicle: a concrete ProtectDevice leaf whose constructor ONLY super()s, so it stands up the real base with no family configureDevice
 * confound, and which exposes the protected base capability methods as public test windows. It generalizes the command-error suite's TestProtectDevice (which exposes
 * runDeviceCommand as runCommand) into the ONE vehicle every device-<capability> concern test reuses: each concern test drives the one base capability it owns against
 * this leaf, so the cross-cutting base behaviors (the motion switch / trigger, the occupancy sensor, the status-LED switch, device info, hints,
 * and the observer spawn) are netted family-agnostically rather than inside any family suite.
 *
 * Each exposed window is added alongside the capability it serves, so the vehicle never ships an exposed method no test drives: the motion and hints windows
 * (configureHintsFor, which a concern test populates this.hints through before the motion configurators read it; configureMotionSensorFor; configureOccupancySensorFor),
 * the status-indicator window (configureStatusLedSwitchFor, whose deep tests live in device-statusled.test.ts), and the device-information and observer-spawn windows
 * (configureInfoFor; spawnObserversFor, whose deep tests live in device-info.test.ts) all follow the same pattern.
 *
 * The device handle is narrowed to a Sensor projection (the all-quiet makeSensorConfig carrier rides on TestSensorProjection) through the class's projection parameter,
 * mirroring how each family leaf narrows its own projection at construction.
 */
export class TestBaseDevice extends ProtectDevice<Sensor> {

  // The family half of the configure() template, which the vehicle leaves empty: no suite configures it, so each window drives exactly the base capability it names.
  protected override configureDevice(): boolean {

    return true;
  }

  // Public window onto the base configureHints, so a concern test populates this.hints (the motion configurators read this.hints) before driving a capability.
  public configureHintsFor(): boolean {

    return this.configureHints();
  }

  // Public window onto the base configureMotionSensor (the motion sensor service plus the motion switch / trigger and the motion get/set MQTT interface).
  public configureMotionSensorFor(pass: ProtectConfigurePass = {}): boolean {

    return this.configureMotionSensor(pass);
  }

  // Public window onto the base configureOccupancySensor (the occupancy service plus its OccupancyDetected characteristic and the occupancy MQTT get).
  public configureOccupancySensorFor(pass: ProtectConfigurePass = {}): boolean {

    return this.configureOccupancySensor(pass);
  }

  // Public window onto the base configureStatusLedSwitch (the Device.StatusLed.Switch accessory: its On onGet/onSet reading and writing the status indicator light
  // through setStatusLed -> statusLedCommand -> device.update({ ledSettings })). Its deep tests live in device-statusled.test.ts.
  public configureStatusLedSwitchFor(pass: Pick<ProtectConfigurePass, "enabled"> = {}): boolean {

    return this.configureStatusLedSwitch(pass);
  }

  // Public window onto the base configureInfo (the AccessoryInformation Manufacturer / Model / SerialNumber / FirmwareRevision writes via setInfo, plus the name
  // write, the display name always and the HomeKit names where a custom name or name syncing owns them). Its deep tests live in device-info.test.ts.
  public configureInfoFor(): boolean {

    return this.configureInfo();
  }

  // Public window onto the base spawnObservers (the universal device observers: device.name -> syncNameFromController and device.firmwareVersion -> setInfo).
  // A concern test calls this after configureHintsFor / configureInfoFor to register the observers, then settles the lazy registration before asserting the reactions.
  public spawnObserversFor(): void {

    this.spawnObservers();
  }
}
