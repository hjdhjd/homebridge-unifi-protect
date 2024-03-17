/* Copyright(C) 2020-2024, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-types.ts: Interface and type definitions for UniFi Protect.
 */

import { ProtectCamera, ProtectChime, ProtectDoorbell, ProtectLight, ProtectSensor, ProtectViewer } from "./devices/index.js";
import { ProtectCameraConfig, ProtectChimeConfig, ProtectLightConfig, ProtectSensorConfig, ProtectViewerConfig } from "unifi-protect";

// Define Protect logging conventions.
export interface ProtectLogging {

  debug: (message: string, ...parameters: unknown[]) => void,
  error: (message: string, ...parameters: unknown[]) => void,
  info: (message: string, ...parameters: unknown[]) => void,
  warn: (message: string, ...parameters: unknown[]) => void
}

// Protect device categories that we support.
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

  // Manage our switch types.
  SWITCH_DOORBELL_CHIME_DIGITAL = "DoorbellChime.digital",
  SWITCH_DOORBELL_CHIME_MECHANICAL = "DoorbellChime.mechanical",
  SWITCH_DOORBELL_CHIME_NONE = "DoorbellChime.none",
  SWITCH_DOORBELL_TRIGGER = "DoorbellTrigger",
  SWITCH_DYNAMIC_BITRATE = "DynamicBitrate",
  SWITCH_HKSV_RECORDING = "HKSVRecordingSwitch",
  SWITCH_MOTION_SENSOR = "MotionSensorSwitch",
  SWITCH_MOTION_TRIGGER = "MotionSensorTrigger",
  SWITCH_UFP_RECORDING_ALWAYS = "UFPRecordingSwitch.always",
  SWITCH_UFP_RECORDING_DETECTIONS = "UFPRecordingSwitch.detections",
  SWITCH_UFP_RECORDING_NEVER = "UFPRecordingSwitch.never"
}
