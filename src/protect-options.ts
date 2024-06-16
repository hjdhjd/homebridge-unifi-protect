/* Copyright(C) 2020-2024, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-options.ts: Feature option and type definitions for UniFi Protect.
 */
import { PROTECT_DEVICE_REMOVAL_DELAY_INTERVAL, PROTECT_DOORBELL_CHIME_DURATION_DIGITAL, PROTECT_FFMPEG_AUDIO_FILTER_FFTNR, PROTECT_FFMPEG_AUDIO_FILTER_HIGHPASS,
  PROTECT_FFMPEG_AUDIO_FILTER_LOWPASS, PROTECT_M3U_PLAYLIST_PORT, PROTECT_MOTION_DURATION, PROTECT_OCCUPANCY_DURATION, PROTECT_TRANSCODE_BITRATE,
  PROTECT_TRANSCODE_HIGH_LATENCY_BITRATE } from "./settings.js";
import { FeatureOptionEntry } from "homebridge-plugin-utils";

// Plugin configuration options.
export interface ProtectOptions {

  controllers: ProtectNvrOptions[],
  debugAll: boolean,
  ffmpegOptions: string[],
  options: string[],
  ringDelay: number,
  verboseFfmpeg: boolean,
  videoEncoder: string,
  videoProcessor: string
}

// NVR configuration options.
export interface ProtectNvrOptions {

  address: string,
  doorbellMessages: {

    duration: number,
    message: string
  }[],
  mqttTopic: string,
  mqttUrl: string,
  name: string,
  overrideAddress: string,
  username: string,
  password: string
}

// HBUP's webUI makes use of additional metadata to only surface the feature options relevant for a particular device. These properties provide that metadata.
//
// hasFeature:          Properties in the featureFlags object that must be enabled for this option to be exposed.
// hasProperty:         Properties that must exist on the device object for this option to be exposed.
// hasSmartObjectType:  Smart object detection capability that must exist for this option to be exposed.
// modelKey:            Device categories that the option applies to, or "all" for any device type.
interface ProtectFeatureOption extends FeatureOptionEntry {

  hasFeature?: string[],
  hasProperty?: string[],
  hasSmartObjectType?: string[],
  modelKey?: string[]
}

// Feature option categories.
export const featureOptionCategories = [

  { description: "Audio feature options.", modelKey: [ "camera" ], name: "Audio" },
  { description: "Device feature options.", modelKey: [ "all" ], name: "Device" },
  { description: "Doorbell feature options.", modelKey: [ "camera" ], name: "Doorbell" },
  { description: "Logging feature options.", modelKey: [ "camera", "light", "sensor" ], name: "Log" },
  { description: "Motion detection feature options.", modelKey: [ "camera", "light", "sensor" ], name: "Motion" },
  { description: "NVR feature options.", modelKey: [ "camera", "nvr" ], name: "Nvr" },
  { description: "Security system feature options.", modelKey: [ "camera", "nvr" ], name: "SecuritySystem" },
  { description: "Video feature options.", modelKey: [ "camera" ], name: "Video" },
  { description: "HomeKit Secure Video feature options.", modelKey: [ "camera" ], name: "Video.HKSV" }
];

/* eslint-disable @stylistic/max-len */
export const featureOptions: { [index: string]: ProtectFeatureOption[] } = {

  // Audio options.
  "Audio": [

    { default: true, description: "Audio support.", hasFeature: [ "hasMic" ], name: ""},
    { default: false, description: "Audio filter for ambient noise suppression.", group: "", hasFeature: [ "hasMic" ], name: "Filter.Noise"},
    { default: false, defaultValue: PROTECT_FFMPEG_AUDIO_FILTER_FFTNR, description: "Noise reduction amount, in decibels, for the FFmpeg afftdn filter.", group: "Filter.Noise", name: "Filter.Noise.FftNr" },
    { default: false, defaultValue: PROTECT_FFMPEG_AUDIO_FILTER_HIGHPASS, description: "Frequency, in Hertz, for the FFmpeg highpass filter.", group: "Filter.Noise", name: "Filter.Noise.HighPass" },
    { default: false, defaultValue: PROTECT_FFMPEG_AUDIO_FILTER_LOWPASS, description: "Frequency, in Hertz, for the FFmpeg lowpass filter.", group: "Filter.Noise", name: "Filter.Noise.LowPass" },
    { default: true, description: "Two-way audio support on supported cameras.", group: "", hasFeature: [ "hasSpeaker" ], name: "TwoWay"}
  ],

  // Device options.
  "Device": [

    { default: true, description: "Make this device available in HomeKit.", name: "" },
    { default: false, description: "Enable the status LED for this device in HomeKit.", hasProperty: [ "ledSettings" ], name: "StatusLed" },
    { default: false, description: "Make this a standalone device in HomeKit that will need to be added to HomeKit through the Home app.", name: "Standalone" },
    { default: false, description: "Synchronize the UniFi Protect name of this device with HomeKit. Synchronization is one-way only, syncing the device name from UniFi Protect to HomeKit.", name: "SyncName" }
  ],

  // Doorbell options.
  "Doorbell": [

    { default: true, description: "Enable the doorbell messages feature.", hasFeature: [ "isDoorbell" ], name: "Messages"},
    { default: true, description: "Use messages saved to the Protect NVR as message switches.", group: "Messages", hasFeature: [ "isDoorbell" ], name: "Messages.FromDoorbell"},
    { default: false, description: "Add switch accessories to control the physical chimes attached to a Protect doorbell.", hasFeature: [ "hasChime" ], name: "PhysicalChime"},
    { default: false, defaultValue: PROTECT_DOORBELL_CHIME_DURATION_DIGITAL, description: "Chime duration, in milliseconds, of a digital physical chime attached to a Protect doorbell.", group: "PhysicalChime", hasFeature: [ "hasChime" ], name: "PhysicalChime.Duration.Digital"},
    { default: false, description: "Add a switch accessory to trigger doorbell ring events on a Protect camera or doorbell.", hasFeature: [ "hasMotionZones" ], name: "Trigger"}
  ],

  // Logging options.
  "Log": [

    { default: true, description: "Log doorbell ring events in Homebridge.", hasFeature: [ "hasMotionZones" ], name: "Doorbell"},
    { default: false, description: "Log HomeKit Secure Video recording events in Homebridge.", hasFeature: [ "hasMotionZones" ], name: "HKSV"},
    { default: false, description: "Log motion events in Homebridge.", hasProperty: [ "isMotionDetected", "isPirMotionDetected" ], name: "Motion" }
  ],

  // Motion options.
  "Motion": [

    { default: false, defaultValue: PROTECT_MOTION_DURATION, description: "Duration, in seconds, of a single motion event, before allowing a new one.", name: "Duration" },
    { default: false, description: "Add an occupancy sensor accessory using motion sensor activity to determine occupancy. By default, any motion will trigger occupancy. If the smart motion detection feature option is enabled, it will be used instead.", hasProperty: [ "isMotionDetected", "isPirMotionDetected" ], name: "OccupancySensor" },
    { default: false, defaultValue: PROTECT_OCCUPANCY_DURATION, description: "Duration, in seconds, to wait without receiving a motion event to determine when occupancy is no longer detected.", group: "OccupancySensor", name: "OccupancySensor.Duration" },
    { default: false, description: "When using both the occupancy sensor and smart motion detection feature options, use UniFi Protect's animal detection to trigger occupancy.", group: "OccupancySensor", hasFeature: [ "hasSmartDetect" ], name: "OccupancySensor.Animal"},
    { default: false, description: "When using both the occupancy sensor and smart motion detection feature options, use UniFi Protect's face detection to trigger occupancy.", group: "OccupancySensor", hasFeature: [ "hasSmartDetect" ], name: "OccupancySensor.Face"},
    { default: false, description: "When using both the occupancy sensor and smart motion detection feature options, use UniFi Protect's license plate detection to trigger occupancy.", group: "OccupancySensor", hasFeature: [ "hasSmartDetect" ], name: "OccupancySensor.LicensePlate"},
    { default: false, description: "When using both the occupancy sensor and smart motion detection feature options, use UniFi Protect's package detection to trigger occupancy.", group: "OccupancySensor", hasFeature: [ "hasSmartDetect" ], name: "OccupancySensor.Package"},
    { default: true, description: "When using both the occupancy sensor and smart motion detection feature options, use UniFi Protect's person detection to trigger occupancy.", group: "OccupancySensor", hasFeature: [ "hasSmartDetect" ], name: "OccupancySensor.Person"},
    { default: false, description: "When using both the occupancy sensor and smart motion detection feature options, use UniFi Protect's vehicle detection to trigger occupancy.", group: "OccupancySensor", hasFeature: [ "hasSmartDetect" ], name: "OccupancySensor.Vehicle"},
    { default: false, description: "Use UniFi Protect smart motion detection for HomeKit motion events when on a supported device.", hasFeature: [ "hasSmartDetect" ], name: "SmartDetect"},
    { default: false, description: "Add contact sensor accessories for each smart motion object type that UniFi Protect supports.", group: "SmartDetect", hasFeature: [ "hasSmartDetect" ], name: "SmartDetect.ObjectSensors"},
    { default: false, defaultValue: "", description: "Add a contact sensor accessory that will match a specific license plate detected by UniFi Protect. You may specify multiple license plates by using hyphens to distinguish unique license plates (e.g. PLATE1-PLATE2-PLATE3).", group: "SmartDetect", hasSmartObjectType: [ "licensePlate" ], name: "SmartDetect.ObjectSensors.LicensePlate" },
    { default: false, description: "Add a switch accessory to activate or deactivate motion detection in HomeKit.", hasProperty: [ "isMotionDetected", "isPirMotionDetected" ], name: "Switch" },
    { default: false, description: "Add a switch accessory to manually trigger a motion detection event in HomeKit.", hasProperty: [ "isMotionDetected", "isPirMotionDetected" ], name: "Trigger" }
  ],

  // NVR options.
  "Nvr": [

    { default: false, defaultValue: PROTECT_M3U_PLAYLIST_PORT, description: "Publish an M3U playlist of Protect cameras on the specified port of this Homebridge server that is suitable for use in apps (e.g. Channels DVR) that can make camera livestreams available through them.", modelKey: [ "nvr" ], name: "Service.Playlist" },
    { default: false, defaultValue: PROTECT_DEVICE_REMOVAL_DELAY_INTERVAL, description: "Delay, in seconds, before removing devices that are no longer detected on the Protect controller. By default, devices are added and removed in realtime.", modelKey: [ "nvr" ], name: "DelayDeviceRemoval" },
    { default: false, description: "Publish all the realtime telemetry received from the Protect controller to MQTT.", modelKey: [ "nvr" ], name: "Publish.Telemetry" },
    { default: false, description: "Add switch accessories to control the native recording capabilities of the UniFi Protect NVR.", modelKey: [ "camera" ], name: "Recording.Switch" },
    { default: false, description: "Add sensor accessories to display the Protect controller system information (currently only the temperature).", modelKey: [ "nvr" ], name: "SystemInfo" }
  ],

  // Security system options.
  "SecuritySystem": [

    { default: false, description: "Add a switch accessory to trigger the security system accessory, when using the liveview feature option.", name: "Alarm" }
  ],

  // Video options.
  "Video": [

    { default: false, description: "Use hardware-accelerated transcoding when available (Apple Macs, Intel Quick Sync Video-enabled CPUs, Raspberry Pi 4).", name: "Transcode.Hardware" },
    { default: false, description: "Use the native Protect livestream API to view livestreams (Experimental).", name: "Stream.UseApi" },
    { default: true, description: "When streaming to local clients (e.g. at home), transcode livestreams, instead of transmuxing them.", name: "Transcode" },
    { default: false, defaultValue: PROTECT_TRANSCODE_BITRATE, description: "Bitrate, in kilobits per second, to use when transcoding to local clients, ignoring the bitrate HomeKit requests. HomeKit typically requests lower video quality than you may desire in your environment.", group: "Transcode", name: "Transcode.Bitrate" },
    { default: true, description: "When streaming to high-latency clients (e.g. cellular connections), transcode livestreams instead of transmuxing them.", name: "Transcode.HighLatency" },
    { default: false, defaultValue: PROTECT_TRANSCODE_HIGH_LATENCY_BITRATE, description: "Bitrate, in kilobits per second, to use when transcoding to high-latency (e.g. cellular) clients, ignoring the bitrate HomeKit requests. HomeKit typically requests lower video quality than you may desire in your environment.", group: "Transcode.HighLatency", name: "Transcode.HighLatency.Bitrate" },
    { default: false, description: "When viewing livestreams, force the use of the high quality video stream from the Protect controller.", name: "Stream.Only.High" },
    { default: false, description: "When viewing livestreams, force the use of the medium quality video stream from the Protect controller.", name: "Stream.Only.Medium" },
    { default: false, description: "When viewing livestreams, force the use of the low quality video stream from the Protect controller.", name: "Stream.Only.Low" },
    { default: false, description: "Crop the camera video stream. Enabling this option will also force transcoding of livestreams.", name: "Crop" },
    { default: false, defaultValue: 0, description: "Left offset of the crop window, as a percentage of the original image width.", group: "Crop", name: "Crop.X" },
    { default: false, defaultValue: 0, description: "Top offset of the crop window, as a percentage of the original image height.", group: "Crop", name: "Crop.Y" },
    { default: false, defaultValue: 100, description: "Width of the crop window, as a percentage of original image width.", group: "Crop", name: "Crop.Width" },
    { default: false, defaultValue: 100, description: "Height of the crop window, as a percentage of original image height.", group: "Crop", name: "Crop.Height" },
    { default: true, description: "Enable higher quality snapshots using the timeshift buffer or the livestream.", name: "HighResSnapshots" }
  ],

  // HomeKit Secure Video options.
  "Video.HKSV": [

    { default: true, description: "Enable the timeshift buffer for HomeKit Secure Video.", name: "TimeshiftBuffer" },
    { default: false, description: "Add a switch accessory to enable or disable HKSV event recording.", name: "Recording.Switch" },
    { default: false, defaultValue: 0, description: "Maximum HomeKit Secure Video event duration, in seconds.", name: "Recording.MaxDuration" },
    { default: false, description: "When recording HomeKit Secure Video events, force the use of the high quality video stream from the Protect controller.", name: "Record.Only.High" },
    { default: false, description: "When recording HomeKit Secure Video events, force the use of the medium quality video stream from the Protect controller.", name: "Record.Only.Medium" },
    { default: false, description: "When recording HomeKit Secure Video events, force the use of the low quality video stream from the Protect controller.", name: "Record.Only.Low" }
  ]
};
/* eslint-enable @stylistic/max-len */
