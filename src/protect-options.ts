/* Copyright(C) 2020-2025, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-options.ts: Feature option and type definitions for UniFi Protect.
 */
import { PROTECT_DEVICE_REMOVAL_DELAY_INTERVAL, PROTECT_DOORBELL_CHIME_DURATION_DIGITAL, PROTECT_FFMPEG_AUDIO_FILTER_FFTNR, PROTECT_FFMPEG_AUDIO_FILTER_HIGHPASS,
  PROTECT_FFMPEG_AUDIO_FILTER_LOWPASS, PROTECT_M3U_PLAYLIST_PORT, PROTECT_MOTION_DURATION, PROTECT_OCCUPANCY_DURATION, PROTECT_TRANSCODE_BITRATE,
  PROTECT_TRANSCODE_HIGH_LATENCY_BITRATE } from "./settings.js";
import type { FeatureOptionEntry } from "homebridge-plugin-utils";

// Plugin configuration options.
export type ProtectOptions = {

  controllers: ProtectNvrOptions[];
  debugAll: boolean;
  options: string[];
  ringDelay: number;
  verboseFfmpeg: boolean;
  videoProcessor: string;
};

// NVR configuration options.
export interface ProtectNvrOptions {

  address: string;
  doorbellMessages?: {

    duration: number;
    message: string;
  }[];
  mqttTopic: string;
  mqttUrl?: string;
  name?: string;
  overrideAddress?: string;
  username: string;
  password: string;
}

// HBUP's webUI makes use of additional metadata to only surface the feature options relevant for a particular device. These properties provide that metadata.
//
// hasAccessFeature:    Properties in the UniFi Access metadata featureFlags object that must be enabled for this option to be exposed.
// hasCameraFeature:    Properties in the featureFlags object on cameras that must be enabled for this option to be exposed.
// hasFeature:          Properties in the featureFlags object that must be enabled for this option to be exposed.
// hasLightProperty:    Properties that must exist on the device object for a light device for this option to be exposed.
// hasProperty:         Properties that must exist on the device object for this option to be exposed.
// hasSensorProperty:   Properties that must exist on the device object for a sensor device for this option to be exposed.
// hasSmartObjectType:  Smart object detection capability that must exist for this option to be exposed.
// isNotProperty:       Properties that must specifically not exist on the device object for this option to be exposed.
// modelKey:            Device categories that the option applies to, or "all" for any device type.
interface ProtectFeatureOption extends FeatureOptionEntry {

  hasAccessFeature?: string[];
  hasCameraFeature?: string[];
  hasFeature?: string[];
  hasLightProperty?: string[];
  hasProperty?: string[];
  hasSensorProperty?: string[];
  hasSmartObjectType?: string[];
  isNotProperty?: string[];
  modelKey?: string[];
}

/* eslint-disable @stylistic/max-len */

// Feature option categories.
export const featureOptionCategories = [

  { description: "Audio", modelKey: ["camera"], name: "Audio" },
  { description: "Device", modelKey: ["all"], name: "Device" },
  { description: "Doorbell", modelKey: ["camera"], name: "Doorbell" },
  { description: "Logging", modelKey: [ "camera", "light", "sensor" ], name: "Log" },
  { description: "Motion", isNotProperty: [ "isAdoptedByAccessApp", "isThirdPartyCamera" ], modelKey: [ "camera", "light", "sensor" ], name: "Motion" },
  { description: "NVR", modelKey: [ "camera", "nvr" ], name: "Nvr" },
  { description: "Security System", modelKey: ["nvr"], name: "SecuritySystem" },
  { description: "Sensor", modelKey: ["sensor"], name: "Sensor" },
  { description: "UniFi Access", modelKey: ["camera"], name: "UniFi.Access" },
  { description: "Video", modelKey: ["camera"], name: "Video" },
  { description: "HomeKit Secure Video", isNotProperty: ["isThirdPartyCamera"], modelKey: ["camera"], name: "Video.HKSV" }
];

export const featureOptions: { [index: string]: ProtectFeatureOption[] } = {

  // Audio options.
  "Audio": [

    { default: true, description: "Audio support.", hasFeature: ["hasMic"], name: "" },
    { default: false, description: "Audio filter for ambient noise suppression.", hasFeature: ["hasMic"], name: "Filter.Noise" },
    { default: true, defaultValue: PROTECT_FFMPEG_AUDIO_FILTER_FFTNR, description: "Noise reduction amount, in decibels, for the FFmpeg afftdn filter.", group: "Filter.Noise", name: "Filter.Noise.FftNr" },
    { default: true, defaultValue: PROTECT_FFMPEG_AUDIO_FILTER_HIGHPASS, description: "Frequency, in Hertz, for the FFmpeg highpass filter.", group: "Filter.Noise", name: "Filter.Noise.HighPass" },
    { default: true, defaultValue: PROTECT_FFMPEG_AUDIO_FILTER_LOWPASS, description: "Frequency, in Hertz, for the FFmpeg lowpass filter.", group: "Filter.Noise", name: "Filter.Noise.LowPass" },
    { default: true, description: "Two-way audio support on supported cameras.", hasFeature: ["hasSpeaker"], name: "TwoWay" },
    { default: false, description: "Send two-way audio directly to supported cameras, bypassing the controller. Useful for working around bugs in some Protect controller firmware versions.", group: "TwoWay", hasFeature: ["hasSpeaker"], name: "TwoWay.Direct" }
  ],

  // Device options.
  "Device": [

    { default: true, description: "Make this device available in HomeKit.", name: "" },
    { default: true, description: "Enable the status indicator light for this device in HomeKit.", hasFeature: ["hasLedStatus"], modelKey: ["camera"], name: "StatusLed" },
    { default: false, description: "Add a switch accessory to control the status indicator light in HomeKit.", hasCameraFeature: ["hasLedStatus"], hasLightProperty: ["lightDeviceSettings"], hasSensorProperty: ["ledSettings"], modelKey: [ "camera", "light", "sensor" ], name: "StatusLed.Switch" },
    { default: true, description: "Enable the night vision indicator light for this device in HomeKit.", hasFeature: ["hasLedIr"], modelKey: ["camera"], name: "NightVision" },
    { default: false, description: "Add a dimmer accessory to control the night vision state in HomeKit.", hasFeature: ["hasLedIr"], modelKey: ["camera"], name: "NightVision.Dimmer" },
    { default: false, description: "Make this a standalone device in HomeKit that will need to be added to HomeKit through the Home app.", name: "Standalone" },
    { default: true, description: "Attempt to restart misbehaving devices. This is always done very conservatively and only after periods of extended device-specific issues.", modelKey: ["camera"], name: "SelfHealing" },
    { default: false, description: "Synchronize the UniFi Protect name of this device with HomeKit. Synchronization is one-way only, syncing the device name from UniFi Protect to HomeKit.", name: "SyncName" }
  ],

  // Doorbell options.
  "Doorbell": [

    { default: false, description: "Add a contact sensor that gets activates when a fingerprint or NFC successfully authenticates on a Protect doorbell.", hasFeature: ["hasFingerprintSensor"], name: "AuthSensor" },
    { default: false, description: "Add a switch accessory to control whether HomeKit will chime when the doorbell is pressed.", name: "Mute" },
    { default: false, description: "Enable the doorbell messages feature.", hasFeature: ["isDoorbell"], name: "Messages" },
    { default: true, description: "Use messages saved to the Protect NVR as message switches.", group: "Messages", hasFeature: ["isDoorbell"], name: "Messages.FromDoorbell" },
    { default: false, description: "Add a dimmer accessory to control the Protect chime volume in HomeKit.", hasFeature: ["isDoorbell"], name: "Volume.Dimmer" },
    { default: false, description: "Add switch accessories to control the physical chimes attached to a Protect doorbell.", hasFeature: ["hasChime"], name: "PhysicalChime" },
    { default: true, defaultValue: PROTECT_DOORBELL_CHIME_DURATION_DIGITAL, description: "Chime duration, in milliseconds, of a digital physical chime attached to a Protect doorbell.", group: "PhysicalChime", hasFeature: ["hasChime"], name: "PhysicalChime.Duration.Digital" },
    { default: true, description: "Add a light accessory to control the flashlight on a Protect doorbell package camera.", hasFeature: ["hasPackageCamera"], name: "PackageCamera.Flashlight" },
    { default: false, description: "Add a switch accessory to trigger doorbell ring events on a Protect camera or doorbell.", name: "Trigger" }
  ],

  // Logging options.
  "Log": [

    { default: true, description: "Log doorbell ring events in Homebridge.", modelKey: ["camera"], name: "Doorbell" },
    { default: false, description: "Log HomeKit Secure Video recording events in Homebridge.", isNotProperty: ["isThirdPartyCamera"], modelKey: ["camera"], name: "HKSV" },
    { default: false, description: "Log motion events in Homebridge.", hasProperty: [ "isMotionDetected", "isPirMotionDetected" ], isNotProperty: ["isThirdPartyCamera"], name: "Motion" }
  ],

  // Motion options.
  "Motion": [

    { default: true, defaultValue: PROTECT_MOTION_DURATION, description: "Duration, in seconds, of a single motion event, before allowing a new one.", name: "Duration" },
    { default: false, description: "Add an occupancy sensor accessory using motion sensor activity to determine occupancy. By default, any motion will trigger occupancy. If the smart detection feature option is enabled, it will be used instead.", hasProperty: [ "isMotionDetected", "isPirMotionDetected" ], name: "OccupancySensor" },
    { default: true, defaultValue: PROTECT_OCCUPANCY_DURATION, description: "Duration, in seconds, to wait without receiving a motion event to determine when occupancy is no longer detected.", group: "OccupancySensor", name: "OccupancySensor.Duration" },
    { default: false, description: "When using both the occupancy sensor and smart detection feature options, use UniFi Protect's animal detection to trigger occupancy.", group: "OccupancySensor", hasFeature: ["hasSmartDetect"], name: "OccupancySensor.Animal" },
    { default: true, description: "When using both the occupancy sensor and smart detection feature options, use UniFi Protect's face detection to trigger occupancy.", group: "OccupancySensor", hasFeature: ["hasSmartDetect"], name: "OccupancySensor.Face" },
    { default: false, description: "When using both the occupancy sensor and smart detection feature options, use UniFi Protect's license plate detection to trigger occupancy.", group: "OccupancySensor", hasFeature: ["hasSmartDetect"], name: "OccupancySensor.LicensePlate" },
    { default: false, description: "When using both the occupancy sensor and smart detection feature options, use UniFi Protect's package detection to trigger occupancy.", group: "OccupancySensor", hasFeature: ["hasSmartDetect"], name: "OccupancySensor.Package" },
    { default: true, description: "When using both the occupancy sensor and smart detection feature options, use UniFi Protect's person detection to trigger occupancy.", group: "OccupancySensor", hasFeature: ["hasSmartDetect"], name: "OccupancySensor.Person" },
    { default: false, description: "When using both the occupancy sensor and smart detection feature options, use UniFi Protect's vehicle detection to trigger occupancy.", group: "OccupancySensor", hasFeature: ["hasSmartDetect"], name: "OccupancySensor.Vehicle" },
    { default: false, description: "When using both the occupancy sensor and smart detection feature options, use UniFi Protect's baby crying audio detection to trigger occupancy.", group: "OccupancySensor", hasFeature: ["hasSmartDetect"], name: "OccupancySensor.AlrmBabyCry" },
    { default: false, description: "When using both the occupancy sensor and smart detection feature options, use UniFi Protect's bark audio detection to trigger occupancy.", group: "OccupancySensor", hasFeature: ["hasSmartDetect"], name: "OccupancySensor.AlrmBark" },
    { default: false, description: "When using both the occupancy sensor and smart detection feature options, use UniFi Protect's car alarm audio detection to trigger occupancy.", group: "OccupancySensor", hasFeature: ["hasSmartDetect"], name: "OccupancySensor.AlrmBurglar" },
    { default: false, description: "When using both the occupancy sensor and smart detection feature options, use UniFi Protect's car horn audio detection to trigger occupancy.", group: "OccupancySensor", hasFeature: ["hasSmartDetect"], name: "OccupancySensor.AlrmCarHorn" },
    { default: false, description: "When using both the occupancy sensor and smart detection feature options, use UniFi Protect's CO alarm audio detection to trigger occupancy.", group: "OccupancySensor", hasFeature: ["hasSmartDetect"], name: "OccupancySensor.AlrmCmonx" },
    { default: false, description: "When using both the occupancy sensor and smart detection feature options, use UniFi Protect's glass break audio detection to trigger occupancy.", group: "OccupancySensor", hasFeature: ["hasSmartDetect"], name: "OccupancySensor.alrmGlassBreak" },
    { default: false, description: "When using both the occupancy sensor and smart detection feature options, use UniFi Protect's siren audio detection to trigger occupancy.", group: "OccupancySensor", hasFeature: ["hasSmartDetect"], name: "OccupancySensor.AlrmSiren" },
    { default: false, description: "When using both the occupancy sensor and smart detection feature options, use UniFi Protect's smoke alarm audio detection to trigger occupancy.", group: "OccupancySensor", hasFeature: ["hasSmartDetect"], name: "OccupancySensor.AlrmSmoke" },
    { default: false, description: "When using both the occupancy sensor and smart detection feature options, use UniFi Protect's speaking audio detection to trigger occupancy.", group: "OccupancySensor", hasFeature: ["hasSmartDetect"], name: "OccupancySensor.AlrmSpeak" },
    { default: false, description: "When using both the occupancy sensor and smart detection feature options, use UniFi Protect's CO and smoke alarm audio detection to trigger occupancy.", group: "OccupancySensor", hasFeature: ["hasSmartDetect"], name: "OccupancySensor.Smoke_cmonx" },
    { default: false, description: "Use UniFi Protect smart detection for HomeKit motion events when on a supported device.", hasFeature: ["hasSmartDetect"], name: "SmartDetect" },
    { default: false, description: "Add contact sensors for each smart detection object type that UniFi Protect supports.", group: "SmartDetect", hasFeature: ["hasSmartDetect"], name: "SmartDetect.ObjectSensors" },
    { default: false, defaultValue: "", description: "Add a contact sensor accessory that will match a specific license plate detected by UniFi Protect. You may specify multiple license plates by using hyphens to distinguish unique license plates (e.g. PLATE1-PLATE2-PLATE3).", group: "SmartDetect", hasSmartObjectType: ["licensePlate"], inputSize: 20 , name: "SmartDetect.ObjectSensors.LicensePlate" },
    { default: false, description: "Add a switch accessory to activate or deactivate motion detection in HomeKit.", hasProperty: [ "isMotionDetected", "isPirMotionDetected" ], name: "Switch" },
    { default: false, description: "Add a switch accessory to manually trigger a motion detection event in HomeKit.", hasProperty: [ "isMotionDetected", "isPirMotionDetected" ], name: "Trigger" }
  ],

  // NVR options.
  "Nvr": [

    { default: false, defaultValue: PROTECT_M3U_PLAYLIST_PORT, description: "Publish an M3U playlist of Protect cameras on the specified port of this Homebridge server that is suitable for use in apps (e.g. Channels DVR) that can make camera livestreams available through them.", modelKey: ["nvr"], name: "Service.Playlist" },
    { default: true, defaultValue: PROTECT_DEVICE_REMOVAL_DELAY_INTERVAL, description: "Delay, in seconds, before removing devices that are no longer detected on the Protect controller. If disabled, devices are removed in realtime when the Protect controller does so.", modelKey: ["nvr"], name: "DelayDeviceRemoval" },
    { default: false, description: "Publish all the realtime telemetry received from the Protect controller to MQTT.", modelKey: ["nvr"], name: "Publish.Telemetry" },
    { default: false, description: "Add switch accessories to control the native recording capabilities of the UniFi Protect NVR.", modelKey: ["camera"], name: "Recording.Switch" },
    { default: false, description: "Add sensor accessories to display the Protect controller system information (currently only the temperature).", modelKey: ["nvr"], name: "SystemInfo" }
  ],

  // Security system options.
  "SecuritySystem": [

    { default: false, description: "Add a switch accessory to trigger the security system accessory, when using the liveview feature option.", name: "Alarm" }
  ],

  // Sensor options.
  "Sensor": [

    { default: false, description: "Use the Protect leak sensor as a moisture sensor instead and expose it as a contact sensor.", name: "MoistureSensor" }
  ],

  // HomeKit Secure Video options.
  "UniFi.Access": [

    { default: true, description: "Add a lock accessory to unlock. Currently, Protect only supports unlocking Access readers with a camera on the same controller as Protect.", hasAccessFeature: ["supportUnlock"], name: "Lock" }
  ],

  // Video options.
  "Video": [

    { default: true, description: "Use hardware-accelerated transcoding when available (Apple Macs, Intel Quick Sync Video-enabled CPUs, Raspberry Pi 4).", name: "Transcode.Hardware" },
    { default: true, description: "Use the native Protect livestream API to view livestreams.", isNotProperty: ["isThirdPartyCamera"], name: "Stream.UseApi" },
    { default: true, description: "When streaming to low-latency clients (e.g. at home), transcode livestreams, instead of transmuxing them.", name: "Transcode" },
    { default: true, defaultValue: PROTECT_TRANSCODE_BITRATE, description: "Bitrate, in kilobits per second, to use when transcoding to low-latency (e.g. at home) clients, ignoring the bitrate HomeKit requests. HomeKit typically requests lower video quality than you may desire in your environment.", group: "Transcode", name: "Transcode.Bitrate" },
    { default: true, description: "When streaming to high-latency clients (e.g. cellular connections), transcode livestreams instead of transmuxing them.", name: "Transcode.HighLatency" },
    { default: true, defaultValue: PROTECT_TRANSCODE_HIGH_LATENCY_BITRATE, description: "Bitrate, in kilobits per second, to use when transcoding to high-latency (e.g. cellular) clients, ignoring the bitrate HomeKit requests. HomeKit typically requests lower video quality than you may desire in your environment.", group: "Transcode.HighLatency", name: "Transcode.HighLatency.Bitrate" },
    { default: false, description: "When viewing livestreams, force the use of the high quality video stream from the Protect controller.", name: "Stream.Only.High" },
    { default: false, description: "When viewing livestreams, force the use of the medium quality video stream from the Protect controller.", name: "Stream.Only.Medium" },
    { default: false, description: "When viewing livestreams, force the use of the low quality video stream from the Protect controller.", name: "Stream.Only.Low" },
    { default: false, description: "Crop the camera video stream. Enabling this option will also force transcoding of livestreams.", name: "Crop" },
    { default: true, defaultValue: 0, description: "Left offset of the crop window, as a percentage of the original image width.", group: "Crop", name: "Crop.X" },
    { default: true, defaultValue: 0, description: "Top offset of the crop window, as a percentage of the original image height.", group: "Crop", name: "Crop.Y" },
    { default: true, defaultValue: 100, description: "Width of the crop window, as a percentage of original image width.", group: "Crop", name: "Crop.Width" },
    { default: true, defaultValue: 100, description: "Height of the crop window, as a percentage of original image height.", group: "Crop", name: "Crop.Height" },
    { default: true, description: "Enable higher quality snapshots.", name: "HighResSnapshots" }
  ],

  // HomeKit Secure Video options.
  "Video.HKSV": [

    { default: false, description: "Use the camera status indicator light to show when an HKSV event is being recorded.", name: "StatusLedIndicator" },
    { default: false, description: "Add a switch accessory to enable or disable HKSV event recording.", name: "Recording.Switch" },
    { default: false, description: "When recording HomeKit Secure Video events, force the use of the high quality video stream from the Protect controller.", name: "Record.Only.High" },
    { default: false, description: "When recording HomeKit Secure Video events, force the use of the medium quality video stream from the Protect controller.", name: "Record.Only.Medium" },
    { default: false, description: "When recording HomeKit Secure Video events, force the use of the low quality video stream from the Protect controller.", name: "Record.Only.Low" }
  ]
};
/* eslint-enable @stylistic/max-len */
