/* Copyright(C) 2017-2024, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-device.ts: Base class for all UniFi Protect devices.
 */
import { API, CharacteristicValue, HAP, PlatformAccessory } from "homebridge";
import { PROTECT_MOTION_DURATION, PROTECT_OCCUPANCY_DURATION} from "./settings.js";
import { ProtectApi, ProtectCameraConfig, ProtectEventPacket, ProtectNvrConfig } from "unifi-protect";
import { ProtectDeviceConfigTypes, ProtectLogging, ProtectReservedNames } from "./protect-types.js";
import { getOptionFloat, getOptionNumber, getOptionValue, isOptionEnabled } from "./protect-options.js";
import { ProtectNvr } from "./protect-nvr.js";
import { ProtectPlatform } from "./protect-platform.js";
import util from "node:util";

/*
// List the optional methods of our subclasses that we want to expose commonly.
export interface ProtectDevice {

  eventHandler?(): void;
}
/* */

// Device-specific options and settings.
export interface ProtectHints {

  crop: boolean;
  cropOptions: {

    height: number,
    width: number,
    x: number,
    y: number
  },
  hardwareDecoding: boolean,
  hardwareTranscoding: boolean,
  ledStatus: boolean,
  logDoorbell: boolean,
  logHksv: boolean,
  logMotion: boolean,
  motionDuration: number,
  occupancyDuration: number,
  probesize: number,
  smartDetect: boolean,
  smartOccupancy: string[],
  syncName: boolean,
  timeshift: boolean,
  transcode: boolean,
  transcodeHighLatency: boolean,
  twoWayAudio: boolean
}

export abstract class ProtectBase {

  public readonly api: API;
  private debug: (message: string, ...parameters: unknown[]) => void;
  protected readonly hap: HAP;
  public readonly log: ProtectLogging;
  public readonly nvr: ProtectNvr;
  public ufpApi: ProtectApi;
  public readonly platform: ProtectPlatform;

  // The constructor initializes key variables and calls configureDevice().
  constructor(nvr: ProtectNvr) {

    this.api = nvr.platform.api;
    this.debug = nvr.platform.debug.bind(this);
    this.hap = this.api.hap;
    this.nvr = nvr;
    this.ufpApi = nvr.ufpApi;
    this.platform = nvr.platform;

    this.log = {

      debug: (message: string, ...parameters: unknown[]): void => nvr.platform.debug(util.format(this.name + ": " + message, ...parameters)),
      error: (message: string, ...parameters: unknown[]): void => nvr.platform.log.error(util.format(this.name + ": " + message, ...parameters)),
      info: (message: string, ...parameters: unknown[]): void => nvr.platform.log.info(util.format(this.name + ": " + message, ...parameters)),
      warn: (message: string, ...parameters: unknown[]): void => nvr.platform.log.warn(util.format(this.name + ": " + message, ...parameters))
    };
  }

  // Configure the device device information for HomeKit.
  protected setInfo(accessory: PlatformAccessory, device: ProtectDeviceConfigTypes | ProtectNvrConfig): boolean {

    // If we don't have a device, we're done.
    if(!device) {

      return false;
    }

    // Update the manufacturer information for this device.
    accessory.getService(this.hap.Service.AccessoryInformation)?.updateCharacteristic(this.hap.Characteristic.Manufacturer, "Ubiquiti Networks");

    // Update the model information for this device.
    let deviceModel = device.type;

    if("marketName" in device) {

      deviceModel = device.marketName;
    }

    if(deviceModel.length) {

      accessory.getService(this.hap.Service.AccessoryInformation)?.updateCharacteristic(this.hap.Characteristic.Model, deviceModel);
    }

    // Update the serial number for this device.
    if(device.mac?.length) {

      accessory.getService(this.hap.Service.AccessoryInformation)?.updateCharacteristic(this.hap.Characteristic.SerialNumber, device.mac);
    }

    // Update the hardware revision for this device, if available.
    if(device.hardwareRevision?.length) {

      accessory.getService(this.hap.Service.AccessoryInformation)?.updateCharacteristic(this.hap.Characteristic.HardwareRevision, device.hardwareRevision);
    }

    // Update the firmware revision for this device.
    if(device.firmwareVersion?.length) {

      accessory.getService(this.hap.Service.AccessoryInformation)?.updateCharacteristic(this.hap.Characteristic.FirmwareRevision, device.firmwareVersion);
    }

    return true;
  }

  // Utility function to return the fully enumerated name of this camera.
  public get name(): string {

    return this.nvr.ufpApi.name;
  }
}

export abstract class ProtectDevice extends ProtectBase {

  public accessory!: PlatformAccessory;
  public hints: ProtectHints;
  protected listeners: { [index: string]: (packet: ProtectEventPacket) => void };
  public abstract ufp: ProtectDeviceConfigTypes;

  // The constructor initializes key variables and calls configureDevice().
  constructor(nvr: ProtectNvr, accessory: PlatformAccessory) {

    // Call the constructor of our base class.
    super(nvr);

    this.hints = {} as ProtectHints;
    this.listeners = {};

    // Set the accessory, if we have it. Otherwise, we expect configureDevice to assign it.
    if(accessory) {

      this.accessory = accessory;
    }
  }

  // Configure device-specific settings.
  protected configureHints(): boolean {

    this.hints.logMotion = this.hasFeature("Log.Motion");
    this.hints.motionDuration = this.getFeatureNumber("Motion.Duration") ?? PROTECT_MOTION_DURATION;
    this.hints.occupancyDuration = this.getFeatureNumber("Motion.OccupancySensor.Duration") ?? PROTECT_OCCUPANCY_DURATION;
    this.hints.smartOccupancy = [];
    this.hints.syncName = this.hasFeature("Device.SyncName");

    // Sanity check motion detection duration. Make sure it's never less than 2 seconds so we can actually alert the user.
    if(this.hints.motionDuration < 2 ) {

      this.hints.motionDuration = 2;
    }

    // Sanity check occupancy detection duration. Make sure it's never less than 60 seconds so we can actually alert the user.
    if(this.hints.occupancyDuration < 60 ) {

      this.hints.occupancyDuration = 60;
    }

    // Inform the user if we've opted for something other than the defaults.
    if(this.hints.syncName) {

      this.log.info("Syncing Protect device name to HomeKit.");
    }

    if(this.hints.motionDuration !== PROTECT_MOTION_DURATION) {

      this.log.info("Motion event duration set to %s seconds", this.hints.motionDuration);
    }

    if(this.hints.occupancyDuration !== PROTECT_OCCUPANCY_DURATION) {

      this.log.info("Occupancy event duration set to %s seconds", this.hints.occupancyDuration);
    }

    return true;
  }

  // Configure the device information details for HomeKit.
  public configureInfo(): boolean {

    // Sync the Protect name with HomeKit, if configured.
    if(this.hints.syncName) {

      this.accessoryName = this.ufp.name;
    }

    return this.setInfo(this.accessory, this.ufp);
  }

  // Cleanup our event handlers and any other activities as needed.
  public cleanup(): void {

    for(const eventName of Object.keys(this.listeners)) {

      this.nvr.events.removeListener(eventName, this.listeners[eventName]);
      delete this.listeners[eventName];
    }
  }

  // Configure the Protect motion sensor for HomeKit.
  protected configureMotionSensor(isEnabled = true, isInitialized = false): boolean {

    // Find the motion sensor service, if it exists.
    let motionService = this.accessory.getService(this.hap.Service.MotionSensor);

    // Have we disabled the motion sensor?
    if(!isEnabled) {

      if(motionService) {

        this.accessory.removeService(motionService);
        this.nvr.mqtt?.unsubscribe(this.id, "motion/trigger");
        this.log.info("Disabling motion sensor.");
      }

      this.configureMotionSwitch(isEnabled);
      this.configureMotionTrigger(isEnabled);

      return false;
    }

    // We don't have a motion sensor, let's add it to the device.
    if(!motionService) {

      // We don't have it, add the motion sensor to the device.
      motionService = new this.hap.Service.MotionSensor(this.accessoryName);

      if(!motionService) {

        this.log.error("Unable to add motion sensor.");
        return false;
      }

      this.accessory.addService(motionService);
      isInitialized = false;

      this.log.info("Enabling motion sensor.");
    }

    // Have we previously initialized this sensor? We assume not by default, but this allows for scenarios where you may be dynamically reconfiguring a sensor at
    // runtime (e.g. UniFi sensors can be reconfigured for various sensor modes in realtime).
    if(!isInitialized) {

      // Initialize the state of the motion sensor.
      motionService.displayName = this.accessoryName;
      motionService.updateCharacteristic(this.hap.Characteristic.Name, this.accessoryName);
      motionService.updateCharacteristic(this.hap.Characteristic.MotionDetected, false);
      motionService.updateCharacteristic(this.hap.Characteristic.StatusActive, this.isOnline);

      motionService.getCharacteristic(this.hap.Characteristic.StatusActive).onGet(() => {

        return this.isOnline;
      });

      // Configure our MQTT support.
      this.configureMqttMotionTrigger();

      // Configure any motion switches or triggers the user may have enabled or disabled.
      this.configureMotionSwitch(isEnabled);
      this.configureMotionTrigger(isEnabled);
    }

    return true;
  }

  // Configure a switch to easily activate or deactivate motion sensor detection for HomeKit.
  private configureMotionSwitch(isEnabled = true): boolean {

    // Find the switch service, if it exists.
    let switchService = this.accessory.getServiceById(this.hap.Service.Switch, ProtectReservedNames.SWITCH_MOTION_SENSOR);

    // Motion switches are disabled by default unless the user enables them.
    if(!isEnabled || !this.hasFeature("Motion.Switch")) {

      if(switchService) {

        this.accessory.removeService(switchService);
      }

      // If we disable the switch, make sure we fully reset it's state. Otherwise, we can end up in a situation (e.g. liveview switches) where we have
      // disabled motion detection with no meaningful way to enable it again.
      this.accessory.context.detectMotion = true;

      return false;
    }

    this.log.info("Enabling motion sensor switch.");

    const switchName = this.accessoryName + " Motion Events";

    // Add the switch to the camera, if needed.
    if(!switchService) {

      switchService = new this.hap.Service.Switch(switchName, ProtectReservedNames.SWITCH_MOTION_SENSOR);

      if(!switchService) {

        this.log.error("Unable to add motion sensor switch.");
        return false;
      }

      this.accessory.addService(switchService);
    }

    // Activate or deactivate motion detection.
    switchService.getCharacteristic(this.hap.Characteristic.On)
      ?.onGet(() => {

        return this.accessory.context.detectMotion === true;
      })
      .onSet((value: CharacteristicValue) => {

        if(this.accessory.context.detectMotion !== value) {

          this.log.info("Motion detection %s.", (value === true) ? "enabled" : "disabled");
        }

        this.accessory.context.detectMotion = value === true;
      });

    // Initialize the switch state.
    if(!("detectMotion" in this.accessory.context)) {

      this.accessory.context.detectMotion = true;
    }

    switchService.addOptionalCharacteristic(this.hap.Characteristic.ConfiguredName);
    switchService.updateCharacteristic(this.hap.Characteristic.ConfiguredName, switchName);
    switchService.updateCharacteristic(this.hap.Characteristic.On, this.accessory.context.detectMotion as boolean);

    return true;
  }

  // Configure a switch to manually trigger a motion sensor event for HomeKit.
  private configureMotionTrigger(isEnabled = true): boolean {

    // Find the switch service, if it exists.
    let triggerService = this.accessory.getServiceById(this.hap.Service.Switch, ProtectReservedNames.SWITCH_MOTION_TRIGGER);

    // Motion triggers are disabled by default and primarily exist for automation purposes.
    if(!isEnabled || !this.hasFeature("Motion.Trigger")) {

      if(triggerService) {

        this.accessory.removeService(triggerService);
      }

      return false;
    }

    const triggerName = this.accessoryName + " Motion Trigger";

    // Add the switch to the camera, if needed.
    if(!triggerService) {

      triggerService = new this.hap.Service.Switch(triggerName, ProtectReservedNames.SWITCH_MOTION_TRIGGER);

      if(!triggerService) {

        this.log.error("Unable to add motion sensor trigger.");
        return false;
      }

      this.accessory.addService(triggerService);
    }

    const motionService = this.accessory.getService(this.hap.Service.MotionSensor);
    const switchService = this.accessory.getServiceById(this.hap.Service.Switch, ProtectReservedNames.SWITCH_MOTION_SENSOR);

    // Activate or deactivate motion detection.
    triggerService.getCharacteristic(this.hap.Characteristic.On)?.onGet(() => {

      return motionService?.getCharacteristic(this.hap.Characteristic.MotionDetected).value === true;
    });

    triggerService.getCharacteristic(this.hap.Characteristic.On)?.onSet((isOn: CharacteristicValue) => {

      if(isOn) {

        // Check to see if motion events are disabled.
        if(switchService && !switchService.getCharacteristic(this.hap.Characteristic.On).value) {

          setTimeout(() => {

            triggerService?.updateCharacteristic(this.hap.Characteristic.On, false);
          }, 50);

        } else {

          // Trigger the motion event.
          this.nvr.events.motionEventHandler(this, Date.now());

          // Inform the user.
          this.log.info("Motion event triggered.");
        }

        return;
      }

      // If the motion sensor is still on, we should be as well.
      if(motionService?.getCharacteristic(this.hap.Characteristic.MotionDetected).value) {

        setTimeout(() => {

          triggerService?.updateCharacteristic(this.hap.Characteristic.On, true);
        }, 50);
      }
    });

    // Initialize the switch.
    triggerService.addOptionalCharacteristic(this.hap.Characteristic.ConfiguredName);
    triggerService.updateCharacteristic(this.hap.Characteristic.ConfiguredName, triggerName);
    triggerService.updateCharacteristic(this.hap.Characteristic.On, false);

    this.log.info("Enabling motion sensor automation trigger.");

    return true;
  }

  // Configure MQTT motion triggers.
  private configureMqttMotionTrigger(): boolean {

    // Trigger a motion event in MQTT, if requested to do so.
    this.nvr.mqtt?.subscribe(this.id, "motion/trigger", (message: Buffer) => {

      const value = message.toString();

      // When we get the right message, we trigger the motion event.
      if(value?.toLowerCase() !== "true") {
        return;
      }

      // Trigger the motion event.
      this.nvr.events.motionEventHandler(this, Date.now());
      this.log.info("Motion event triggered via MQTT.");
    });

    return true;
  }

  // Configure the Protect occupancy sensor for HomeKit.
  protected configureOccupancySensor(isEnabled = true, isInitialized = false): boolean {

    // Find the occupancy sensor service, if it exists.
    let occupancyService = this.accessory.getService(this.hap.Service.OccupancySensor);

    // Occupancy sensors are disabled by default and primarily exist for automation purposes.
    if(!isEnabled || !this.hasFeature("Motion.OccupancySensor")) {

      if(occupancyService) {

        this.accessory.removeService(occupancyService);
        this.log.info("Disabling occupancy sensor.");
      }

      return false;
    }

    // We don't have an occupancy sensor, let's add it to the device.
    if(!occupancyService) {

      // We don't have it, add the occupancy sensor to the device.
      occupancyService = new this.hap.Service.OccupancySensor(this.accessoryName);

      if(!occupancyService) {

        this.log.error("Unable to add occupancy sensor.");
        return false;
      }

      this.accessory.addService(occupancyService);
    }

    // Have we previously initialized this sensor? We assume not by default, but this allows for scenarios where you may be dynamically reconfiguring a sensor at
    // runtime (e.g. UniFi sensors can be reconfigured for various sensor modes in realtime).
    if(!isInitialized) {

      // Initialize the state of the occupancy sensor.
      occupancyService.updateCharacteristic(this.hap.Characteristic.OccupancyDetected, false);
      occupancyService.updateCharacteristic(this.hap.Characteristic.StatusActive, this.isOnline);

      occupancyService.getCharacteristic(this.hap.Characteristic.StatusActive).onGet(() => {

        return this.isOnline;
      });

      // If we have smart motion detection, allow users to choose which object types determine occupancy.
      if(this.hints.smartDetect) {

        // Iterate through all the individual object detection types Protect has configured.
        for(const smartDetectType of (this.ufp as ProtectCameraConfig).featureFlags.smartDetectTypes) {

          if(this.hasFeature("Motion.OccupancySensor." + smartDetectType)) {

            this.hints.smartOccupancy.push(smartDetectType);
          }
        }

        // If the user has disabled all the object types, warn them.
        if(!this.hints.smartOccupancy.length) {

          this.hints.smartOccupancy.push("no smart motion detection object type configured");
        }
      }

      this.log.info("Enabling occupancy sensor%s.",
        this.hints.smartDetect ? " using smart motion detection: " + this.hints.smartOccupancy.join(", ")  : "");
    }

    return true;
  }

  // Utility function to return a floating point configuration parameter on a device.
  public getFeatureFloat(option: string): number | undefined {

    return getOptionFloat(this.getFeatureValue(option));
  }

  // Utility function to return an integer configuration parameter on a device.
  public getFeatureNumber(option: string): number | undefined {

    return getOptionNumber(this.getFeatureValue(option));
  }

  // Utility function to return a configuration parameter on a device.
  public getFeatureValue(option: string): string | undefined {

    return getOptionValue(this.platform.featureOptions, this.nvr.ufp, this.ufp, option);
  }

  // Utility for checking feature options on a device.
  public hasFeature(option: string, defaultReturnValue?: boolean): boolean {

    return isOptionEnabled(this.platform.featureOptions, this.nvr.ufp, this.ufp, option, defaultReturnValue ?? this.platform.featureOptionDefault(option));
  }

  // Utility function for reserved identifiers for switches.
  public isReservedName(name: string | undefined): boolean {

    return name === undefined ? false : Object.values(ProtectReservedNames).map(x => x.toUpperCase()).includes(name.toUpperCase());
  }

  // Utility function to determine whether or not a device is currently online.
  public get isOnline(): boolean {

    return this.ufp?.state === "CONNECTED";
  }

  // Return a unique identifier for a Protect device. We need this for package cameras in particular, since they present multiple cameras in a single physical device.
  public get id(): string {

    return this.ufp.mac;
  }

  // Utility function to return the fully enumerated name of this device.
  public get name(): string {

    return this.nvr.ufpApi.getFullName(this.ufp);
  }

  // Utility function to return the current accessory name of this device.
  public get accessoryName(): string {

    return (this.accessory.getService(this.hap.Service.AccessoryInformation)?.getCharacteristic(this.hap.Characteristic.Name).value as string) ??
      (this.ufp?.name ?? "Unknown");
  }

  public set accessoryName(name: string) {

    // Set all the internally managed names within Homebridge to the new accessory name.
    this.accessory.displayName = name;
    this.accessory._associatedHAPAccessory.displayName = name;

    // Set all the HomeKit-visible names.
    this.accessory.getService(this.hap.Service.AccessoryInformation)?.updateCharacteristic(this.hap.Characteristic.Name, name);
  }
}
