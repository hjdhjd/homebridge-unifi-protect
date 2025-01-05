/* Copyright(C) 2020-2025, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-types.ts: Interface and type definitions for UniFi Protect.
 */

import { ProtectCamera, ProtectChime, ProtectDoorbell, ProtectLight, ProtectSensor, ProtectViewer } from "./devices/index.js";
import { ProtectCameraConfig, ProtectChimeConfig, ProtectLightConfig, ProtectSensorConfig, ProtectViewerConfig } from "unifi-protect";

// Useful utilities.
export function toCamelCase(input: string): string {

  return input.replace(/(^\w|\s+\w)/g, match => match.toUpperCase());
}

// Protect device categories that we support and the classes they correspond to.
export type ProtectDeviceTypes = {

  camera: ProtectCamera,
  chime: ProtectChime,
  light: ProtectLight,
  sensor: ProtectSensor,
  viewer: ProtectViewer
};

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

  // Manage our lightbulb types.
  LIGHTBULB_DOORBELL_VOLUME = "ChimeVolume",
  LIGHTBULB_NIGHTVISION = "NightVision",
  LIGHTBULB_PACKAGE_FLASHLIGHT = "PackageCamera.Flashlight",

  // Manage our switch types.
  SWITCH_DOORBELL_CHIME_BUZZER = "DoorbellChime.buzzer",
  SWITCH_DOORBELL_CHIME_DIGITAL = "DoorbellChime.digital",
  SWITCH_DOORBELL_CHIME_MECHANICAL = "DoorbellChime.mechanical",
  SWITCH_DOORBELL_CHIME_NONE = "DoorbellChime.none",
  SWITCH_DOORBELL_CHIME_SPEAKER = "DoorbellChime.speaker",
  SWITCH_DOORBELL_TRIGGER = "DoorbellTrigger",
  SWITCH_HKSV_RECORDING = "HKSVRecordingSwitch",
  SWITCH_MOTION_SENSOR = "MotionSensorSwitch",
  SWITCH_MOTION_TRIGGER = "MotionSensorTrigger",
  SWITCH_STATUS_LED = "StatusLedSwitch",
  SWITCH_UFP_RECORDING_ALWAYS = "UFPRecordingSwitch.always",
  SWITCH_UFP_RECORDING_DETECTIONS = "UFPRecordingSwitch.detections",
  SWITCH_UFP_RECORDING_NEVER = "UFPRecordingSwitch.never"
}
