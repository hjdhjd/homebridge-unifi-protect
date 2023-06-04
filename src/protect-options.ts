/* Copyright(C) 2020-2023, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-options.ts: Type definitions for UniFi Protect.
 */
import { ProtectDeviceConfigTypes } from "./protect-types.js";
import { ProtectNvrConfig } from "unifi-protect";

// Plugin configuration options.
export interface ProtectOptions {

  controllers: ProtectNvrOptions[],
  debugAll: boolean,
  ffmpegOptions: string[],
  motionDuration: number,
  occupancyDuration: number,
  options: string[],
  ringDuration: number,
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

  { description: "Audio feature options.", name: "Audio", validFor: [ "camera" ] },
  { description: "Device feature options.", name: "Device", validFor: [ "all" ] },
  { description: "Doorbell feature options.", name: "Doorbell", validFor: [ "camera" ] },
  { description: "Logging feature options.", name: "Log", validFor: [ "camera", "light", "sensor" ] },
  { description: "Motion detection feature options.", name: "Motion", validFor: [ "camera", "light", "sensor" ] },
  { description: "NVR feature options.", name: "Nvr", validFor: [ "nvr" ] },
  { description: "Security system feature options.", name: "SecuritySystem", validFor: [ "nvr" ] },
  { description: "Video feature options.", name: "Video", validFor: [ "camera" ] },
  { description: "HomeKit Secure Video feature options.", name: "Video.HKSV", validFor: [ "camera" ] }
];

/* eslint-disable max-len */
// Individual feature options, broken out by category.
export const featureOptions: { [index: string]: FeatureOption[] } = {

  // Audio options.
  "Audio": [

    { default: true, description: "Audio support.", name: "" },
    { default: false, description: "Audio filter for ambient noise suppression.", hasFeature: [ "hasMotionZones" ], name: "Filter.Noise" },
    { default: true, description: "Two-way audio support on supported cameras.", hasFeature: [ "hasSpeaker" ], name: "TwoWay" }
  ],

  // Device options.
  "Device": [

    { default: true, description: "Make this device available in HomeKit.", name: "" },
    { default: false, description: "Enable the status LED for this device in HomeKit.", hasProperty: [ "ledSettings" ],  name: "StatusLed" }
  ],

  // Doorbell options.
  "Doorbell": [

    { default: true, description: "Enable the doorbell messages feature.", hasFeature: [ "hasChime" ], name: "Messages" },
    { default: true, description: "Use messages saved to the Protect NVR as message switches.", hasFeature: [ "hasChime" ], name: "Messages.FromDoorbell" },
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

    { default: false, description: "Add an occupancy sensor accessory using motion sensor activity to determine occupancy. By default, any motion will trigger occupancy. If the smart motion detection feature option is enabled, it will be used instead.", hasProperty: [ "isMotionDetected", "isPirMotionDetected" ], name: "OccupancySensor" },
    { default: true, description: "When using both the occupancy sensor and smart motion detection feature options, use UniFi Protect's person detection to trigger occupancy.", hasFeature: [ "hasSmartDetect" ], name: "OccupancySensor.Person" },
    { default: false, description: "When using both the occupancy sensor and smart motion detection feature options, use UniFi Protect's vehicle detection to trigger occupancy.", hasFeature: [ "hasSmartDetect" ], name: "OccupancySensor.Vehicle" },
    { default: false, description: "Use UniFi Protect smart motion detection for HomeKit motion events when on a supported device.", hasFeature: [ "hasSmartDetect" ], name: "SmartDetect" },
    { default: false, description: "Add contact sensor accessories for each smart motion object type that UniFi Protect supports.", hasFeature: [ "hasSmartDetect" ], name: "SmartDetect.ObjectSensors" },
    { default: false, description: "Add a switch accessory to activate or deactivate motion detection in HomeKit.", hasProperty: [ "isMotionDetected", "isPirMotionDetected" ], name: "Switch" },
    { default: false, description: "Add a switch accessory to manually trigger a motion detection event in HomeKit.", hasProperty: [ "isMotionDetected", "isPirMotionDetected" ], name: "Trigger" }
  ],

  // NVR options.
  "Nvr": [

    { default: false, description: "Publish all the realtime telemetry received from the Protect controller to MQTT.", name: "Publish.Telemetry" },
    { default: false, description: "Add switch accessories to control the native recording capabilities of the UniFi Protect NVR.", name: "Recording.Switch" },
    { default: false, description: "Add sensor accessories to display the Protect controller system information (currently only the temperature).", name: "SystemInfo" }
  ],

  // Security system options.
  "SecuritySystem": [

    { default: false, description: "Add a switch accessory to trigger the security system accessory, when using the liveview feature option.", name: "Alarm" }
  ],

  // Video options.
  "Video": [

    { default: false, description: "Dynamically adjust the bitrate on the UniFi Protect controller to accomodate HomeKit requests.", name: "DynamicBitrate" },
    { default: false, description: "Add a switch accessory to enable or disable dynamic bitrate support on the Protect controller.", name: "DynamicBitrate.Switch" },
    { default: false, description: "For viewing livestreams, force the use of the high quality video stream from the Protect controller.", name: "Stream.Only.High" },
    { default: false, description: "For viewing livestreams, force the use of the medium quality video stream from the Protect controller.", name: "Stream.Only.Medium" },
    { default: false, description: "For viewing livestreams, force the use of the low quality video stream from the Protect controller.", name: "Stream.Only.Low" },
    { default: false, description: "Transcode live video streams when viewing in the Home app instead of remuxing.", name: "Transcode" },
    { default: false, description: "Use hardware-accelerated transcoding when available (Apple Macs, Intel Quick Sync Video-enabled CPUs, Raspberry Pi 4).", name: "Transcode.Hardware" },
    { default: true, description: "When streaming to high-latency clients (e.g. cellular connections), transcode live video streams instead of remuxing them.", name: "Transcode.HighLatency" }
  ],

  // HomeKit Secure Video options.
  "Video.HKSV": [

    { default: true, description: "Enable the timeshift buffer for HomeKit Secure Video.", name: "TimeshiftBuffer" },
    { default: false, description: "Add a switch accessory to enable or disable HKSV event recording.", name: "Recording.Switch" },
    { default: false, description: "For HomeKit Secure Video recordings, force the use of the high quality video stream from the Protect controller.", name: "Record.Only.High" },
    { default: false, description: "For HomeKit Secure Video recordings, force the use of the medium quality video stream from the Protect controller.", name: "Record.Only.Medium" },
    { default: false, description: "For HomeKit Secure Video recordings, force the use of the low quality video stream from the Protect controller.", name: "Record.Only.Low" }
  ]

};
/* eslint-enable max-len */

export interface FeatureOption {

  default: boolean,           // Default feature option setting.
  description: string,        // Description of the feature option.
  hasFeature?: string[],      // What hardware-specific features, if any, is this feature option dependent on.
  hasProperty?: string[],     // What UFP JSON property, if any, is this feature option dependent on.
  name: string                // Name of the feature option.
}

// Utility function to let us know if a device or feature should be enabled or not.
export function optionEnabled(configOptions: string[], nvrUfp: ProtectNvrConfig | null, device: ProtectDeviceConfigTypes | ProtectNvrConfig | null,
  option = "", defaultReturnValue = true, address = "", addressOnly = false): boolean {

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

  // Upper case parameters for easier checks.
  option = option ? option.toUpperCase() : "";
  address = address ? address.toUpperCase() : "";

  const deviceMac = device?.mac ? device.mac.toUpperCase() : "";

  let optionSetting;

  // If we've specified an address parameter - we check for device and address-specific options before
  // anything else.
  if(address && option) {

    // Test for device-specific and address-specific option settings, used together.
    if(deviceMac) {

      optionSetting = option + "." + deviceMac + "." + address;

      // We've explicitly enabled this option for this device and address combination.
      if(configOptions.indexOf("ENABLE." + optionSetting) !== -1) {

        return true;
      }

      // We've explicitly disabled this option for this device and address combination.
      if(configOptions.indexOf("DISABLE." + optionSetting) !== -1) {

        return false;
      }
    }

    // Test for address-specific option settings only.
    optionSetting = option + "." + address;

    // We've explicitly enabled this option for this address.
    if(configOptions.indexOf("ENABLE." + optionSetting) !== -1) {

      return true;
    }

    // We've explicitly disabled this option for this address.
    if(configOptions.indexOf("DISABLE." + optionSetting) !== -1) {

      return false;
    }

    // We're only interested in address-specific options.
    if(addressOnly) {

      return false;
    }
  }

  // If we've specified a device, check for device-specific options first. Otherwise, we're dealing
  // with an NVR-specific or global option.
  if(deviceMac) {

    // First we test for camera-level option settings.
    // No option specified means we're testing to see if this device should be shown in HomeKit.
    optionSetting = option ? option + "." + deviceMac : deviceMac;

    // We've explicitly enabled this option for this device.
    if(configOptions.indexOf("ENABLE." + optionSetting) !== -1) {

      return true;
    }

    // We've explicitly disabled this option for this device.
    if(configOptions.indexOf("DISABLE." + optionSetting) !== -1) {

      return false;
    }
  }

  // If we don't have a managing device attached, we're done here.
  if(!nvrUfp?.mac) {

    return defaultReturnValue;
  }

  // Now we test for NVR-level option settings.
  // No option specified means we're testing to see if this NVR (and it's attached devices) should be shown in HomeKit.
  const nvrMac = nvrUfp.mac.toUpperCase();
  optionSetting = option ? option + "." + nvrMac : nvrMac;

  // We've explicitly enabled this option for this NVR and all the devices attached to it.
  if(configOptions.indexOf("ENABLE." + optionSetting) !== -1) {

    return true;
  }

  // We've explicitly disabled this option for this NVR and all the devices attached to it.
  if(configOptions.indexOf("DISABLE." + optionSetting) !== -1) {

    return false;
  }

  // Finally, let's see if we have a global option here.
  // No option means we're done - it's a special case for testing if an NVR or camera should be hidden in HomeKit.
  if(!option) {

    return defaultReturnValue;
  }

  // We've explicitly enabled this globally for all devices.
  if(configOptions.indexOf("ENABLE." + option) !== -1) {

    return true;
  }

  // We've explicitly disabled this globally for all devices.
  if(configOptions.indexOf("DISABLE." + option) !== -1) {

    return false;
  }

  // Nothing special to do - assume the option is defaultReturnValue.
  return defaultReturnValue;
}

