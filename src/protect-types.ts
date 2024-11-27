/* Copyright(C) 2020-2024, HJD (https://github.com/hjdhjd). All rights reserved.
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
  CONTACT_MOTION_SMARTDETECT = "ContactMotionSmartDetect",
  CONTACT_MOTION_SMARTDETECT_LICENSE = "ContactMotionSmartDetectLicense",
  CONTACT_SENSOR = "ContactSensor",
  CONTACT_SENSOR_ALARM_SOUND = "ContactAlarmSound",

  // Manage our lightbulb types.
  LIGHTBULB_DOORBELL_VOLUME = "ChimeVolume",
  LIGHTBULB_NIGHTVISION = "NightVision",

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
  SWITCH_UFP_RECORDING_NEVER = "UFPRecordingSwitch.never",
  SWITCH_PTZ_PRESET_HOME = "PtzPresetSwitch.-1",
  SWITCH_PTZ_PRESET_1 = "PtzPresetSwitch.0",
  SWITCH_PTZ_PRESET_2 = "PtzPresetSwitch.1",
  SWITCH_PTZ_PRESET_3 = "PtzPresetSwitch.2",
  SWITCH_PTZ_PRESET_4 = "PtzPresetSwitch.3",
  SWITCH_PTZ_PRESET_5 = "PtzPresetSwitch.4",
  SWITCH_PTZ_PRESET_6 = "PtzPresetSwitch.5",
  SWITCH_PTZ_PRESET_7 = "PtzPresetSwitch.6",
  SWITCH_PTZ_PRESET_8 = "PtzPresetSwitch.7",
  SWITCH_PTZ_PRESET_9 = "PtzPresetSwitch.8"
}
