/* Copyright(C) 2020-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * types.ts: Interface and type definitions for UniFi Protect.
 */

import type { CharacteristicValue, PlatformAccessory, PlatformConfig } from "homebridge";
import type { ProtectCameraConfig, ProtectChimeConfig, ProtectLightConfig, ProtectSensorConfig, ProtectViewerConfig } from "unifi-protect";
import type { ProtectCamera } from "./devices/cameras/camera.ts";
import type { ProtectChime } from "./devices/chime.ts";
import type { ProtectLight } from "./devices/light.ts";
import type { ProtectNvrOptions } from "./options.ts";
import type { ProtectSensor } from "./devices/sensor.ts";
import type { ProtectViewer } from "./devices/viewer.ts";

// Compile-time exhaustiveness check for discriminated unions. When all cases of a union are handled in a switch statement, TypeScript narrows the remaining type to
// `never`. Passing it to this function ensures the compiler will flag an error if a new variant is added to the union without a corresponding case. At runtime this is a
// no-op...the call site is responsible for graceful degradation (logging, returning null, etc.).
// eslint-disable-next-line @typescript-eslint/no-empty-function
export function exhaustiveGuard(_value: never): void {}

// Protect device categories that we support and the classes they correspond to.
export interface ProtectDeviceTypes {

  camera: ProtectCamera;
  chime: ProtectChime;
  light: ProtectLight;
  sensor: ProtectSensor;
  viewer: ProtectViewer;
}

export const ProtectDeviceCategories = [ "camera", "chime", "light", "sensor", "viewer" ];
export type ProtectDeviceConfigTypes = ProtectCameraConfig | ProtectChimeConfig | ProtectLightConfig | ProtectSensorConfig | ProtectViewerConfig;
export type ProtectDevices = ProtectCamera | ProtectChime | ProtectLight | ProtectSensor | ProtectViewer;

// The typed view of a Protect accessory's persisted HomeKit context. All keys are optional: the context is reset to {} and repopulated per accessory type (a camera
// carries mac + detectMotion, a liveview switch carries liveview + liveviewState + nvr, the controller's system-info accessory carries systemInfo + nvr, and so on), so
// presence is itself meaningful and several code paths test it with the `in` operator. This interface replaces homebridge's UnknownContext (Record<string, any>) index
// signature so every context.<key> access is a declared-property read, satisfying noPropertyAccessFromIndexSignature without a single cast.
export interface ProtectAccessoryContext {

  detectMotion?: boolean;
  doorbellMuted?: boolean;
  hksvRecordingDisabled?: boolean;
  liveview?: string;
  liveviewState?: boolean;
  mac?: string;
  nvr?: string;
  packageCamera?: string;
  securityState?: CharacteristicValue;
  systemInfo?: boolean;
}

// A Protect accessory: a homebridge PlatformAccessory whose context is our typed ProtectAccessoryContext. This alias is the single name threaded through every accessory
// field, parameter, and creation site, so the context contract lives in exactly one place.
export type ProtectAccessory = PlatformAccessory<ProtectAccessoryContext>;

/* The package-camera identity suffixes. A doorbell's package camera is a synthetic HomeKit accessory derived from its parent doorbell, and its identity is carried in two
 * distinct representations that must never be conflated: a protocol marker and a user-visible label are different jobs for different strings, so each gets its own
 * constant rather than one string doing both.
 */

// The protocol and persistence suffix appended to the parent doorbell's MAC address to form the package camera's unique device id. This value is persistence-critical
// identity: it seeds the package accessory's cached HomeKit UUID and keys the event dispatcher's per-device timers, so any drift here orphans every cached package camera
// accessory on every install in the field. Treat it as immutable.
export const PACKAGE_CAMERA_ID_SUFFIX = ".PackageCamera";

// Compose the unique package-camera device identifier from a parent camera's MAC address. This is the single identity derivation the package camera's id getter and
// accessory-UUID seed consume, and that the doorbell capability's package lifecycle (configure, reconcile, detach) consumes as a pure consumer of the package's identity.
// It lives here in the shared leaf - beside its persistence-critical suffix - rather than on the package class, so the doorbell capability can derive the id without a
// value-import of its sibling package-camera class (which would close a module-initialization cycle); the package class re-exposes it as its own public identity API.
export function packageCameraId(mac: string): string {

  return mac + PACKAGE_CAMERA_ID_SUFFIX;
}

// The display suffix appended to the parent doorbell's name to form the package camera's user-visible HomeKit name. Purely presentational - the protocol id above never
// derives from it, so the display suffix can evolve without touching persisted identity.
export const PACKAGE_CAMERA_NAME_SUFFIX = " Package Camera";

// A typed view of this plugin's slice of the homebridge PlatformConfig. PlatformConfig carries an `[x: string]: any` index signature for arbitrary user config; declaring
// the six keys we actually read lets the platform constructor access them as typed properties (no index-signature dot-access, no per-key cast) while still satisfying the
// DynamicPlatformPlugin contract, since every added key is optional.
export interface ProtectPlatformConfig extends PlatformConfig {

  controllers?: ProtectNvrOptions[];
  debug?: boolean;
  options?: string[];
  ringDelay?: number;
  verboseFfmpeg?: boolean;
  videoProcessor?: string;
}

// A frozen lookup of the reserved subtype identifiers the plugin assigns to the HomeKit services it synthesizes. Modeled as an "as const" object rather than a TypeScript
// enum so the declaration is erasable...the project's test runner is "node --strip-types", which executes TypeScript by erasing types and cannot run a non-erasable
// enum (the shared tsconfig's erasableSyntaxOnly flag enforces this). The object literal carries the identical string values at the identical keys, so every
// ProtectReservedNames.X value read is unchanged; the companion type alias below preserves the type-position uses.
export const ProtectReservedNames = {

  // Manage our contact sensor types.
  CONTACT_AUTHSENSOR: "ContactAuthSensor",
  CONTACT_MOTION_SMARTDETECT: "ContactMotionSmartDetect",
  CONTACT_MOTION_SMARTDETECT_LICENSE: "ContactMotionSmartDetectLicense",
  CONTACT_SENSOR: "ContactSensor",
  CONTACT_SENSOR_ALARM_SOUND: "ContactAlarmSound",

  // Manage our leak sensor types.
  LEAKSENSOR_EXTERNAL: "External",
  LEAKSENSOR_INTERNAL: "Internal",

  // Manage our lightbulb types.
  LIGHTBULB_DOORBELL_VOLUME: "ChimeVolume",
  LIGHTBULB_NIGHTVISION: "NightVision",
  LIGHTBULB_PACKAGE_FLASHLIGHT: "PackageCamera.Flashlight",

  // Manage our lock types.
  LOCK_ACCESS: "Access",

  // Manage our switch types.
  SWITCH_DOORBELL_CHIME_BUZZER: "DoorbellChime.buzzer",
  SWITCH_DOORBELL_CHIME_DIGITAL: "DoorbellChime.digital",
  SWITCH_DOORBELL_CHIME_MECHANICAL: "DoorbellChime.mechanical",
  SWITCH_DOORBELL_CHIME_NONE: "DoorbellChime.none",
  SWITCH_DOORBELL_CHIME_SPEAKER: "DoorbellChime.speaker",
  SWITCH_DOORBELL_MUTE: "DoorbellMute",
  SWITCH_DOORBELL_TRIGGER: "DoorbellTrigger",
  SWITCH_HKSV_RECORDING: "HKSVRecordingSwitch",
  SWITCH_MOTION_SENSOR: "MotionSensorSwitch",
  SWITCH_MOTION_TRIGGER: "MotionSensorTrigger",
  SWITCH_STATUS_LED: "StatusLedSwitch",
  SWITCH_UFP_RECORDING_ALWAYS: "UFPRecordingSwitch.always",
  SWITCH_UFP_RECORDING_DETECTIONS: "UFPRecordingSwitch.detections",
  SWITCH_UFP_RECORDING_NEVER: "UFPRecordingSwitch.never"
} as const;

// The union of reserved-name values, replacing the enum's type identity so signatures like "param: ProtectReservedNames" keep compiling unchanged.
export type ProtectReservedNames = (typeof ProtectReservedNames)[keyof typeof ProtectReservedNames];
