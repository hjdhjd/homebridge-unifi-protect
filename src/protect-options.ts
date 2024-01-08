/* Copyright(C) 2020-2023, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-options.ts: Feature option and type definitions for UniFi Protect.
 */
import { PROTECT_DEVICE_REMOVAL_DELAY_INTERVAL, PROTECT_DOORBELL_CHIME_DURATION_DIGITAL, PROTECT_FFMPEG_AUDIO_FILTER_FFTNR, PROTECT_FFMPEG_AUDIO_FILTER_HIGHPASS,
  PROTECT_FFMPEG_AUDIO_FILTER_LOWPASS, PROTECT_M3U_PLAYLIST_PORT, PROTECT_MOTION_DURATION, PROTECT_OCCUPANCY_DURATION } from "./settings.js";
import { ProtectDeviceConfigTypes } from "./protect-types.js";
import { ProtectNvrConfig } from "unifi-protect";

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
  defaultDoorbellMessage: string,
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

/* eslint-disable max-len */
// Individual feature options, broken out by category.
export const featureOptions: { [index: string]: FeatureOption[] } = {

  // Audio options.
  "Audio": [

    { default: true, description: "Audio support.", hasFeature: [ "hasMic" ], name: "" },
    { default: false, description: "Audio filter for ambient noise suppression.", group: "", hasFeature: [ "hasMic" ], name: "Filter.Noise" },
    { default: false, defaultValue: PROTECT_FFMPEG_AUDIO_FILTER_FFTNR, description: "Noise reduction amount, in decibels, for the FFmpeg afftdn filter.", group: "Filter.Noise", name: "Filter.Noise.FftNr" },
    { default: false, defaultValue: PROTECT_FFMPEG_AUDIO_FILTER_HIGHPASS, description: "Frequency, in Hertz, for the FFmpeg highpass filter.", group: "Filter.Noise", name: "Filter.Noise.HighPass" },
    { default: false, defaultValue: PROTECT_FFMPEG_AUDIO_FILTER_LOWPASS, description: "Frequency, in Hertz, for the FFmpeg lowpass filter.", group: "Filter.Noise", name: "Filter.Noise.LowPass" },
    { default: true, description: "Two-way audio support on supported cameras.", group: "", hasFeature: [ "hasSpeaker" ], name: "TwoWay" }
  ],

  // Device options.
  "Device": [

    { default: true, description: "Make this device available in HomeKit.", name: "" },
    { default: false, description: "Synchronize the UniFi Protect name of this device with HomeKit. Synchronization is one-way only, syncing the device name from UniFi Protect to HomeKit.",  name: "SyncName" },
    { default: false, description: "Enable the status LED for this device in HomeKit.", hasProperty: [ "ledSettings" ],  name: "StatusLed" }
  ],

  // Doorbell options.
  "Doorbell": [

    { default: true, description: "Enable the doorbell messages feature.", hasFeature: [ "isDoorbell" ], name: "Messages" },
    { default: true, description: "Use messages saved to the Protect NVR as message switches.", group: "Messages", hasFeature: [ "isDoorbell" ], name: "Messages.FromDoorbell" },
    { default: false, description: "Add switch accessories to control the physical chimes attached to a Protect doorbell.", hasFeature: [ "hasChime" ], name: "PhysicalChime" },
    { default: false, defaultValue: PROTECT_DOORBELL_CHIME_DURATION_DIGITAL, description: "Chime duration, in milliseconds, of a digital physical chime attached to a Protect doorbell.", group: "PhysicalChime", hasFeature: [ "hasChime" ], name: "PhysicalChime.Duration.Digital" },
    { default: false, description: "Add a switch accessory to trigger doorbell ring events on a Protect camera or doorbell.", hasFeature: [ "hasMotionZones" ], name: "Trigger" }
  ],

  // Logging options.
  "Log": [

    { default: true, description: "Log doorbell ring events in Homebridge.", hasFeature: [ "hasMotionZones" ], name: "Doorbell" },
    { default: true, description: "Log HomeKit Secure Video recording events in Homebridge.", hasFeature: [ "hasMotionZones" ], name: "HKSV" },
    { default: false, description: "Log motion events in Homebridge.", hasProperty: [ "isMotionDetected", "isPirMotionDetected" ], name: "Motion" }
  ],

  // Motion options.
  "Motion": [

    { default: false, defaultValue: PROTECT_MOTION_DURATION, description: "Duration, in seconds, of a single motion event, before allowing a new one.", name: "Duration" },
    { default: false, description: "Add an occupancy sensor accessory using motion sensor activity to determine occupancy. By default, any motion will trigger occupancy. If the smart motion detection feature option is enabled, it will be used instead.", hasProperty: [ "isMotionDetected", "isPirMotionDetected" ], name: "OccupancySensor" },
    { default: false, defaultValue: PROTECT_OCCUPANCY_DURATION, description: "Duration, in seconds, to wait without receiving a motion event to determine when occupancy is no longer detected.", group: "OccupancySensor", name: "OccupancySensor.Duration" },
    { default: true, description: "When using both the occupancy sensor and smart motion detection feature options, use UniFi Protect's person detection to trigger occupancy.", group: "OccupancySensor", hasFeature: [ "hasSmartDetect" ], name: "OccupancySensor.Person" },
    { default: false, description: "When using both the occupancy sensor and smart motion detection feature options, use UniFi Protect's vehicle detection to trigger occupancy.", group: "OccupancySensor", hasFeature: [ "hasSmartDetect" ], name: "OccupancySensor.Vehicle" },
    { default: false, description: "Use UniFi Protect smart motion detection for HomeKit motion events when on a supported device.", hasFeature: [ "hasSmartDetect" ], name: "SmartDetect" },
    { default: false, description: "Add contact sensor accessories for each smart motion object type that UniFi Protect supports.", group: "SmartDetect", hasFeature: [ "hasSmartDetect" ], name: "SmartDetect.ObjectSensors" },
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
    { default: false, description: "When streaming to local clients (e.g. at home), always transcode livestreams, instead of transmuxing them.", name: "Transcode" },
    { default: true, description: "When streaming to high-latency clients (e.g. cellular connections), transcode livestreams instead of transmuxing them.", name: "Transcode.HighLatency" },
    { default: false, description: "When viewing livestreams, force the use of the high quality video stream from the Protect controller.", name: "Stream.Only.High" },
    { default: false, description: "When viewing livestreams, force the use of the medium quality video stream from the Protect controller.", name: "Stream.Only.Medium" },
    { default: false, description: "When viewing livestreams, force the use of the low quality video stream from the Protect controller.", name: "Stream.Only.Low" },
    { default: false, description: "Dynamically adjust the image quality of the camera directly on the UniFi Protect controller to accomodate HomeKit requests.", name: "DynamicBitrate" },
    { default: false, description: "Add a switch accessory to enable or disable dynamic bitrate support on the Protect controller.", name: "DynamicBitrate.Switch" },
    { default: false, description: "Crop streams and snapshots (note: this forces all streams to be transcoded).", name: "Crop"},
    { default: false, defaultValue: 0, description: "Left crop position % (0-100)", group: "Crop", name: "Crop.X"},
    { default: false, defaultValue: 0, description: "Top crop position % (0-100)", group: "Crop", name: "Crop.Y"},
    { default: false, defaultValue: 100, description: "Crop Width % (0-100)", group: "Crop", name: "Crop.Width"},
    { default: false, defaultValue: 100, description: "Crop Height % (0-100)", group: "Crop", name: "Crop.Height"}
  ],

  // HomeKit Secure Video options.
  "Video.HKSV": [

    { default: false, defaultValue: 0, description: "Maximum HomeKit Secure Video event duration, in seconds.", name: "Recording.MaxDuration" },
    { default: false, description: "Add a switch accessory to enable or disable HKSV event recording.", name: "Recording.Switch" },
    { default: false, description: "When recording HomeKit Secure Video events, force the use of the high quality video stream from the Protect controller.", name: "Record.Only.High" },
    { default: false, description: "When recording HomeKit Secure Video events, force the use of the medium quality video stream from the Protect controller.", name: "Record.Only.Medium" },
    { default: false, description: "When recording HomeKit Secure Video events, force the use of the low quality video stream from the Protect controller.", name: "Record.Only.Low" },
    { default: true, description: "Enable the timeshift buffer for HomeKit Secure Video.", name: "TimeshiftBuffer" }
  ]

};
/* eslint-enable max-len */

export interface FeatureOption {

  default: boolean,                   // Default feature option state.
  defaultValue?: number | string,     // Default value for value-based feature options.
  description: string,                // Description of the feature option.
  group?: string,                     // Feature option grouping for related options.
  hasFeature?: string[],              // What hardware-specific features, if any, is this feature option dependent on.
  hasProperty?: string[],             // What UFP JSON property, if any, is this feature option dependent on.
  hasSmartObjectType?: string[],      // What smart object detection capability, is any, is this feature option dependent on.
  modelKey?: string[],              // Which Protect hardware is this feature option applicable to.
  name: string                        // Name of the feature option.
}

// Utility function to let us know whether a feature option should be enabled or not, traversing the scope hierarchy.
export function isOptionEnabled(configOptions: string[], nvrUfp: ProtectNvrConfig | null, device: ProtectDeviceConfigTypes | ProtectNvrConfig | null, option = "",
  defaultReturnValue = true): boolean {

  // There are a couple of ways to enable and disable options. The rules of the road are:
  //
  // 1. Explicitly disabling, or enabling an option on the NVR propogates to all the devices
  //    that are managed by that NVR. Why might you want to do this? Because...
  //
  // 2. Explicitly disabling, or enabling an option on a device by its MAC address will always
  //    override the above. This means that it's possible to disable an option for an NVR,
  //    and all the devices that are managed by it, and then override that behavior on a single
  //    device that it's managing.

  // Nothing configured - we assume the default return value.
  if(!configOptions.length) {

    return defaultReturnValue;
  }

  const isOptionSet = (checkOption: string, checkMac: string | undefined = undefined): boolean | undefined => {

    // This regular expression is a bit more intricate than you might think it should be due to the need to ensure we capture values at the very end of the option.
    const optionRegex = new RegExp("^(Enable|Disable)\\." + checkOption + (!checkMac ? "" : "\\." + checkMac) + "$", "gi");

    // Get the option value, if we have one.
    for(const entry of configOptions) {

      const regexMatch = optionRegex.exec(entry);

      if(regexMatch) {

        return regexMatch[1].toLowerCase() === "enable";
      }
    }

    return undefined;
  };

  // Escape out our option to ensure we have no inadvertent issues in matching the regular expression.
  option = option.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // Check to see if we have a device-level option first.
  if(device?.mac) {

    const value = isOptionSet(option, device.mac);

    if(value !== undefined) {

      return value;
    }
  }

  // Now check to see if we have an NVR-level option.
  if(nvrUfp?.mac) {

    const value = isOptionSet(option, nvrUfp.mac);

    if(value !== undefined) {

      return value;
    }
  }

  // Finally, we check for a global-level value.
  const value = isOptionSet(option);

  if(value !== undefined) {

    return value;
  }

  // The option hasn't been set at any scope, return our default value.
  return defaultReturnValue;
}

// Utility function to return a value-based feature option for a Protect device.
export function getOptionValue(configOptions: string[], nvrUfp: ProtectNvrConfig | null, device: ProtectDeviceConfigTypes | null, option: string): string | undefined {

  // Nothing configured - we assume there's nothing.
  if(!configOptions.length || !option) {

    return undefined;
  }

  const getValue = (checkOption: string, checkMac: string | undefined = undefined): string | undefined => {

    // This regular expression is a bit more intricate than you might think it should be due to the need to ensure we capture values at the very end of the option.
    const optionRegex = new RegExp("^Enable\\." + checkOption + (!checkMac ? "" : "\\." + checkMac) + "\\.([^\\.]+)$", "gi");

    // Get the option value, if we have one.
    for(const entry of configOptions) {

      const regexMatch = optionRegex.exec(entry);

      if(regexMatch) {

        return regexMatch[1];
      }
    }

    return undefined;
  };

  // Escape out our option to ensure we have no inadvertent issues in matching the regular expression.
  option = option.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // Check to see if we have a device-level value first.
  if(device?.mac) {

    const value = getValue(option, device.mac);

    if(value) {

      return value;
    }
  }

  // Now check to see if we have an NVR-level value.
  if(nvrUfp?.mac) {

    const value = getValue(option, nvrUfp.mac);

    if(value) {

      return value;
    }
  }

  // Finally, we check for a global-level value.
  return getValue(option);
}

// Utility function to parse and return a numeric configuration parameter.
function parseOptionNumeric(optionValue: string | undefined, convert: (value: string) => number): number | undefined {

  // We don't have the option configured -- we're done.
  if(optionValue === undefined) {

    return undefined;
  }

  // Convert it to a number, if needed.
  const convertedValue = convert(optionValue);

  // Let's validate to make sure it's really a number.
  if(isNaN(convertedValue) || (convertedValue < 0)) {

    return undefined;
  }

  // Return the value.
  return convertedValue;
}

// Utility function to return a floating point configuration parameter.
export function getOptionFloat(optionValue: string | undefined): number | undefined {

  return parseOptionNumeric(optionValue, (value: string) => {

    return parseFloat(value);
  });
}

// Utility function to return an integer configuration parameter on a device.
export function getOptionNumber(optionValue: string | undefined): number | undefined {

  return parseOptionNumeric(optionValue, (value: string) => {

    return parseInt(value);
  });
}
