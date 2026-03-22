/* Copyright(C) 2020-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-types.ts: Interface and type definitions for UniFi Protect.
 */

import type { ProtectCamera, ProtectChime, ProtectDoorbell, ProtectLight, ProtectSensor, ProtectViewer } from "./devices/index.js";
import type { ProtectCameraConfig, ProtectChimeConfig, ProtectLightConfig, ProtectSensorConfig, ProtectViewerConfig } from "unifi-protect";

// Useful utilities.
export function toCamelCase(input: string): string {

  return input.replace(/(^\w|\s+\w)/g, match => match.toUpperCase());
}

// Compile-time exhaustiveness check for discriminated unions. When all cases of a union are handled in a switch statement, TypeScript narrows the remaining type to
// `never`. Passing it to this function ensures the compiler will flag an error if a new variant is added to the union without a corresponding case. At runtime this is a
// no-op...the call site is responsible for graceful degradation (logging, returning null, etc.).
// eslint-disable-next-line @typescript-eslint/no-empty-function, @typescript-eslint/no-unused-vars
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
export type ProtectDevices = ProtectCamera | ProtectChime | ProtectDoorbell | ProtectLight | ProtectSensor | ProtectViewer;

// HBUP reserved names.
export enum ProtectReservedNames {

  // Manage our contact sensor types.
  CONTACT_AUTHSENSOR = "ContactAuthSensor",
  CONTACT_MOTION_SMARTDETECT = "ContactMotionSmartDetect",
  CONTACT_MOTION_SMARTDETECT_LICENSE = "ContactMotionSmartDetectLicense",
  CONTACT_SENSOR = "ContactSensor",
  CONTACT_SENSOR_ALARM_SOUND = "ContactAlarmSound",

  // Manage our leak sensor types.
  LEAKSENSOR_EXTERNAL = "External",
  LEAKSENSOR_INTERNAL = "Internal",

  // Manage our lightbulb types.
  LIGHTBULB_DOORBELL_VOLUME = "ChimeVolume",
  LIGHTBULB_NIGHTVISION = "NightVision",
  LIGHTBULB_PACKAGE_FLASHLIGHT = "PackageCamera.Flashlight",

  // Manage our lock types.
  LOCK_ACCESS = "Access",

  // Manage our switch types.
  SWITCH_DOORBELL_CHIME_BUZZER = "DoorbellChime.buzzer",
  SWITCH_DOORBELL_CHIME_DIGITAL = "DoorbellChime.digital",
  SWITCH_DOORBELL_CHIME_MECHANICAL = "DoorbellChime.mechanical",
  SWITCH_DOORBELL_CHIME_NONE = "DoorbellChime.none",
  SWITCH_DOORBELL_CHIME_SPEAKER = "DoorbellChime.speaker",
  SWITCH_DOORBELL_MUTE = "DoorbellMute",
  SWITCH_DOORBELL_TRIGGER = "DoorbellTrigger",
  SWITCH_HKSV_RECORDING = "HKSVRecordingSwitch",
  SWITCH_MOTION_SENSOR = "MotionSensorSwitch",
  SWITCH_MOTION_TRIGGER = "MotionSensorTrigger",
  SWITCH_STATUS_LED = "StatusLedSwitch",
  SWITCH_UFP_RECORDING_ALWAYS = "UFPRecordingSwitch.always",
  SWITCH_UFP_RECORDING_DETECTIONS = "UFPRecordingSwitch.detections",
  SWITCH_UFP_RECORDING_NEVER = "UFPRecordingSwitch.never"
}
