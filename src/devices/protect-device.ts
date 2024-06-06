/* Copyright(C) 2017-2024, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-device.ts: Base class for all UniFi Protect devices.
 */
import { API, CharacteristicValue, HAP, PlatformAccessory, Service, WithUUID } from "homebridge";
import { PROTECT_MOTION_DURATION, PROTECT_OCCUPANCY_DURATION} from "../settings.js";
import { ProtectApi, ProtectCameraConfig, ProtectEventPacket, ProtectNvrConfig } from "unifi-protect";
import { ProtectDeviceConfigTypes, ProtectReservedNames } from "../protect-types.js";
import { HomebridgePluginLogging } from "homebridge-plugin-utils";
import { ProtectNvr } from "../protect-nvr.js";
import { ProtectPlatform } from "../protect-platform.js";
import util from "node:util";

/*
// List the optional methods of our subclasses that we want to expose commonly.
export interface ProtectDevice {

  eventHandler?(): void;
}
/* */

// Device-specific options and settings.
export interface ProtectHints {

  apiStreaming: boolean,
  crop: boolean,
  cropOptions: {

    height: number,
    width: number,
    x: number,
    y: number
  },
  enabled: boolean,
  hardwareDecoding: boolean,
  hardwareTranscoding: boolean,
  highResSnapshots: boolean,
  ledStatus: boolean,
  logDoorbell: boolean,
  logHksv: boolean,
  logMotion: boolean,
  motionDuration: number,
  occupancyDuration: number,
  probesize: number,
  recordingDefault: string,
  smartDetect: boolean,
  smartOccupancy: string[],
  standalone: boolean,
  streamingDefault: string,
  syncName: boolean,
  timeshift: boolean,
  transcode: boolean,
  transcodeBitrate: number,
  transcodeHighLatency: boolean,
  transcodeHighLatencyBitrate: number,
  twoWayAudio: boolean
}

export abstract class ProtectBase {

  public readonly api: API;
  private debug: (message: string, ...parameters: unknown[]) => void;
  protected readonly hap: HAP;
  public readonly log: HomebridgePluginLogging;
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

  // Configure the device information for HomeKit.
  protected setInfo(accessory: PlatformAccessory, device: ProtectDeviceConfigTypes | ProtectNvrConfig): boolean {

    // If we don't have a device, we're done.
    if(!device) {

      return false;
    }

    // Update the manufacturer information for this device.
    accessory.getService(this.hap.Service.AccessoryInformation)?.updateCharacteristic(this.hap.Characteristic.Manufacturer, "Ubiquiti Inc.");

    // Update the model information for this device.
    const deviceModel = device.marketName ?? device.type;

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

  // Utility function to return the fully enumerated name of this device.
  public get name(): string {

    return this.nvr.ufpApi.name;
  }
}

export abstract class ProtectDevice extends ProtectBase {

  public accessory!: PlatformAccessory;
  public hints: ProtectHints;
  protected listeners: { [index: string]: (packet: ProtectEventPacket) => void };
  public ufp: ProtectDeviceConfigTypes;

  // The constructor initializes key variables and calls configureDevice().
  constructor(nvr: ProtectNvr, accessory: PlatformAccessory) {

    // Call the constructor of our base class.
    super(nvr);

    this.hints = {} as ProtectHints;
    this.listeners = {};
    this.ufp = {} as ProtectDeviceConfigTypes;

    // Set the accessory, if we have it. Otherwise, we expect configureDevice to assign it.
    if(accessory) {

      this.accessory = accessory;
    }
  }

  // Retrieve an existing service from an accessory, creating it if necessary.
  protected acquireService(serviceType: WithUUID<typeof Service>, name = this.accessoryName, subtype?: string, onServiceCreate?: (svc: Service) => void): Service | null {

    // Services that need the ConfiguredName characteristic added and maintained.
    const configuredNameServices = [ this.hap.Service.ContactSensor, this.hap.Service.Lightbulb, this.hap.Service.MotionSensor, this.hap.Service.OccupancySensor,
      this.hap.Service.Switch ];

    // Services that need the Name characteristic maintained.
    const nameServices = [ this.hap.Service.Battery, this.hap.Service.ContactSensor, this.hap.Service.HumiditySensor, this.hap.Service.LeakSensor,
      this.hap.Service.Lightbulb, this.hap.Service.LightSensor, this.hap.Service.MotionSensor, this.hap.Service.TemperatureSensor ];

    // Find the service, if it exists.
    let service = subtype ? this.accessory.getServiceById(serviceType, subtype) : this.accessory.getService(serviceType);

    // Add the service to the accessory, if needed.
    if(!service) {

      // @ts-expect-error TypeScript tries to associate this with an overloaded version of the addService method. However, Homebridge/HAP-NodeJS isn't exporting
      // a version of the method that implements the unexposed interface that's been defined for each service class (e.g. Lightbulb). The constructor on the
      // service-type-specific version of the service takes the following arguments: constructor(displayName?: string, subtype?: string). We're safe, but because
      // the type definitions are missing, we need to override it here.
      service = new serviceType(name, subtype);

      if(!service) {

        return null;
      }

      this.accessory.addService(service);

      if(onServiceCreate) {

        onServiceCreate(service);
      }
    }

    // Update our name.
    service.displayName = name;

    if(configuredNameServices.includes(serviceType)) {

      // Add the characteristic if we don't already have it. We do this here instead of at service creation to ensure we catch legacy situations where we may have
      // already created the service previously without adding the optional characteristics we want.
      if(!service.optionalCharacteristics.some(x => (x.UUID === this.hap.Characteristic.ConfiguredName.UUID))) {

        service.addOptionalCharacteristic(this.hap.Characteristic.ConfiguredName);
      }

      service.updateCharacteristic(this.hap.Characteristic.ConfiguredName, name);
    }

    if(nameServices.includes(serviceType)) {

      service.updateCharacteristic(this.hap.Characteristic.Name, name);
    }

    return service;
  }

  // Validate whether a service should exist, removing it if necessary.
  protected validService(serviceType: WithUUID<typeof Service>, validate: () => boolean, subtype?: string): boolean {

    // Find the switch service, if it exists.
    const service = subtype ? this.accessory.getServiceById(serviceType, subtype) : this.accessory.getService(serviceType);

    // Validate whether we should have the service. If not, remove it.
    if(!validate()) {

      if(service) {

        this.accessory.removeService(service);
      }

      return false;
    }

    // We have a valid service.
    return true;
  }

  // Configure device-specific settings.
  protected configureHints(): boolean {

    this.hints.enabled = this.hasFeature("Device");
    this.hints.logMotion = this.hasFeature("Log.Motion");
    this.hints.motionDuration = this.getFeatureNumber("Motion.Duration") ?? PROTECT_MOTION_DURATION;
    this.hints.occupancyDuration = this.getFeatureNumber("Motion.OccupancySensor.Duration") ?? PROTECT_OCCUPANCY_DURATION;
    this.hints.smartOccupancy = [];
    this.hints.standalone = this.hasFeature("Device.Standalone");
    this.hints.syncName = this.hasFeature("Device.SyncName");

    // Sanity check motion detection duration. Make sure it's never less than 2 seconds so we can actually alert the user.
    if(this.hints.motionDuration < 2) {

      this.hints.motionDuration = 2;
    }

    // Sanity check occupancy detection duration. Make sure it's never less than 60 seconds so we can actually alert the user.
    if(this.hints.occupancyDuration < 60) {

      this.hints.occupancyDuration = 60;
    }

    // Inform the user if we've opted for something other than the defaults.
    if(this.hints.syncName) {

      this.logFeature("Device.SyncName", "Syncing Protect device name to HomeKit.", "Syncing Protect device names to HomeKit.");
    } else if(this.isDeviceFeature("Device.SyncName")) {

      this.log.info("Not syncing this Protect device name to HomeKit.");
    }

    if(this.hints.motionDuration !== PROTECT_MOTION_DURATION) {

      this.log.info("Motion event duration set to %s seconds.", this.hints.motionDuration);
    }

    if(this.hints.occupancyDuration !== PROTECT_OCCUPANCY_DURATION) {

      this.log.info("Occupancy event duration set to %s seconds.", this.hints.occupancyDuration);
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

      this.nvr.events.off(eventName, this.listeners[eventName]);
      delete this.listeners[eventName];
    }
  }

  // Utility to ease publishing of MQTT events.
  protected publish(topic: string, message: string): void {

    this.nvr.mqtt?.publish(this.ufp.mac, topic, message);
  }

  // Configure our MQTT get subscriptions.
  protected subscribeGet(topic: string, type: string, getValue: () => string): void {

    this.nvr.mqtt?.subscribeGet(this.ufp.mac, topic, type, getValue);
  }

  // Configure our MQTT set subscriptions.
  protected subscribeSet(topic: string, type: string, setValue: (value: string, rawValue: string) => Promise<void> | void): void {

    this.nvr.mqtt?.subscribeSet(this.ufp.mac, topic, type, setValue);
  }

  // Configure the Protect motion sensor for HomeKit.
  protected configureMotionSensor(isEnabled = true, isInitialized = false): boolean {

    // Validate whether we should have this service enabled.
    if(!this.validService(this.hap.Service.MotionSensor, () => {

      // Have we disabled the motion sensor?
      if(!isEnabled) {

        this.nvr.mqtt?.unsubscribe(this.ufp.mac, "motion/get");
        this.nvr.mqtt?.unsubscribe(this.ufp.mac, "motion/set");
        this.configureMotionSwitch(isEnabled);
        this.configureMotionTrigger(isEnabled);

        return false;
      }

      return true;
    })) {

      return false;
    }

    // Acquire the service.
    const service = this.acquireService(this.hap.Service.MotionSensor, undefined, undefined, () => {

      isInitialized = false;
    });

    if(!service) {

      this.log.error("Unable to add motion sensor.");

      return false;
    }

    // Have we previously initialized this sensor? We assume not by default, but this allows for scenarios where you may be dynamically reconfiguring a sensor at
    // runtime (e.g. UniFi sensors can be reconfigured for various sensor modes in realtime).
    if(!isInitialized) {

      // Initialize the state of the motion sensor.
      service.updateCharacteristic(this.hap.Characteristic.MotionDetected, false);
      service.updateCharacteristic(this.hap.Characteristic.StatusActive, this.isOnline);

      service.getCharacteristic(this.hap.Characteristic.StatusActive).onGet(() => {

        return this.isOnline;
      });

      // Configure our MQTT support.
      this.subscribeGet("motion", "motion", () => {

        return service.getCharacteristic(this.hap.Characteristic.MotionDetected).value === true ? "true" : "false";
      });

      this.subscribeSet("motion", "motion event trigger", (value: string) => {

        // When we get the right message, we trigger the motion event.
        if(value !== "true") {

          return;
        }

        // Trigger the motion event.
        this.nvr.events.motionEventHandler(this);
      });

      // Configure any motion switches or triggers the user may have enabled or disabled.
      this.configureMotionSwitch(isEnabled);
      this.configureMotionTrigger(isEnabled);
    }

    return true;
  }

  // Configure a switch to easily activate or deactivate motion sensor detection for HomeKit.
  private configureMotionSwitch(isEnabled = true): boolean {

    // Validate whether we should have this service enabled.
    if(!this.validService(this.hap.Service.Switch, () => {

      // Motion switches are disabled by default unless the user enables them.
      if(!isEnabled || !this.hasFeature("Motion.Switch")) {

        return false;
      }

      return true;
    }, ProtectReservedNames.SWITCH_MOTION_SENSOR)) {

      // If we disable the switch, make sure we fully reset it's state. Otherwise, we can end up in a situation (e.g. liveview switches) where we have disabled motion
      // detection with no meaningful way to enable it again.
      this.accessory.context.detectMotion = true;

      return false;
    }

    // Acquire the service.
    const service = this.acquireService(this.hap.Service.Switch, this.accessoryName + " Motion Events", ProtectReservedNames.SWITCH_MOTION_SENSOR);

    // Fail gracefully.
    if(!service) {

      this.log.error("Unable to add motion sensor switch.");

      return false;
    }

    // Activate or deactivate motion detection.
    service.getCharacteristic(this.hap.Characteristic.On)?.onGet(() => {

      return this.accessory.context.detectMotion === true;
    });

    service.getCharacteristic(this.hap.Characteristic.On)?.onSet((value: CharacteristicValue) => {

      if(this.accessory.context.detectMotion !== value) {

        this.log.info("Motion detection %s.", (value === true) ? "enabled" : "disabled");
      }

      this.accessory.context.detectMotion = value === true;
    });

    // Initialize the switch state.
    if(!("detectMotion" in this.accessory.context)) {

      this.accessory.context.detectMotion = true;
    }

    service.updateCharacteristic(this.hap.Characteristic.On, this.accessory.context.detectMotion as boolean);

    this.log.info("Enabling motion sensor switch.");

    return true;
  }

  // Configure a switch to manually trigger a motion sensor event for HomeKit.
  private configureMotionTrigger(isEnabled = true): boolean {

    // Validate whether we should have this service enabled.
    if(!this.validService(this.hap.Service.Switch, () => {

      // Motion triggers are disabled by default and primarily exist for automation purposes.
      if(!isEnabled || !this.hasFeature("Motion.Trigger")) {

        return false;
      }

      return true;
    }, ProtectReservedNames.SWITCH_MOTION_TRIGGER)) {

      return false;
    }

    // Acquire the service.
    const triggerService = this.acquireService(this.hap.Service.Switch, this.accessoryName + " Motion Trigger", ProtectReservedNames.SWITCH_MOTION_TRIGGER);

    // Fail gracefully.
    if(!triggerService) {

      this.log.error("Unable to add motion sensor trigger.");

      return false;
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

          setTimeout(() => triggerService?.updateCharacteristic(this.hap.Characteristic.On, false), 50);

        } else {

          // Trigger the motion event.
          this.nvr.events.motionEventHandler(this);

          // Inform the user.
          this.log.info("Motion event triggered.");
        }

        return;
      }

      // If the motion sensor is still on, we should be as well.
      if(motionService?.getCharacteristic(this.hap.Characteristic.MotionDetected).value) {

        setTimeout(() => triggerService?.updateCharacteristic(this.hap.Characteristic.On, true), 50);
      }
    });

    // Initialize the switch.
    triggerService.updateCharacteristic(this.hap.Characteristic.On, false);

    this.log.info("Enabling motion sensor automation trigger.");

    return true;
  }

  // Configure the Protect occupancy sensor for HomeKit.
  protected configureOccupancySensor(isEnabled = true, isInitialized = false): boolean {

    // Validate whether we should have this service enabled.
    if(!this.validService(this.hap.Service.OccupancySensor, () => {

      // Occupancy sensors are disabled by default and primarily exist for automation purposes.
      if(!isEnabled || !this.hasFeature("Motion.OccupancySensor")) {

        this.nvr.mqtt?.unsubscribe(this.ufp.mac, "occupancy/get");

        return false;
      }

      return true;
    })) {

      return false;
    }

    // Acquire the service.
    const service = this.acquireService(this.hap.Service.OccupancySensor);

    if(!service) {

      this.log.error("Unable to add occupancy sensor.");

      return false;
    }

    // Have we previously initialized this sensor? We assume not by default, but this allows for scenarios where you may be dynamically reconfiguring a sensor at
    // runtime (e.g. UniFi sensors can be reconfigured for various sensor modes in realtime).
    if(!isInitialized) {

      // Initialize the state of the occupancy sensor.
      service.updateCharacteristic(this.hap.Characteristic.OccupancyDetected, false);
      service.updateCharacteristic(this.hap.Characteristic.StatusActive, this.isOnline);

      service.getCharacteristic(this.hap.Characteristic.StatusActive).onGet(() => {

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

      // Configure our MQTT support.
      this.subscribeGet("occupancy", "occupancy", () => {

        return service.getCharacteristic(this.hap.Characteristic.OccupancyDetected).value === true ? "true" : "false";
      });

      this.log.info("Enabling occupancy sensor%s.", this.hints.smartDetect ? " using smart motion detection: " + this.hints.smartOccupancy.join(", ")  : "");
    }

    return true;
  }

  // Utility function to return a floating point configuration parameter on a device.
  public getFeatureFloat(option: string): number | undefined {

    return this.platform.featureOptions.getFloat(option, this.ufp.mac, this.nvr.ufp.mac);
  }

  // Utility function to return an integer configuration parameter on a device.
  public getFeatureNumber(option: string): number | undefined {

    return this.platform.featureOptions.getInteger(option, this.ufp.mac, this.nvr.ufp.mac);
  }

  // Utility function to return a configuration parameter on a device.
  public getFeatureValue(option: string): string | undefined {

    return this.platform.featureOptions.value(option, this.ufp.mac, this.nvr.ufp.mac);
  }

  // Utility for checking feature options on a device.
  public hasFeature(option: string): boolean {

    return this.platform.featureOptions.test(option, this.ufp.mac, this.nvr.ufp.mac);
  }

  // Utility for returning the scope of a feature option.
  public isDeviceFeature(option: string): boolean {

    return this.platform.featureOptions.scope(option) === "device";
  }

  // Utility for logging feature option availability.
  public logFeature(option: string, message: string, nvrMessage = message): void {

    if(this.isDeviceFeature(option)) {

      this.log.info(message);

      return;
    }

    this.nvr.logFeature(option, nvrMessage);
  }

  // Utility function for reserved identifiers for switches.
  public isReservedName(name?: string): boolean {

    return name ? Object.values(ProtectReservedNames).map(x => x.toUpperCase()).includes(name.toUpperCase()) : false;
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

    return this.nvr.ufpApi.getDeviceName(this.ufp);
  }

  // Utility function to return the current accessory name of this device.
  public get accessoryName(): string {

    return (this.accessory.getService(this.hap.Service.AccessoryInformation)?.getCharacteristic(this.hap.Characteristic.Name).value as string) ??
      (this.ufp?.name ?? "Unknown");
  }

  // Utility function to set the current accessory name of this device.
  public set accessoryName(name: string) {

    // Set all the internally managed names within Homebridge to the new accessory name.
    this.accessory.displayName = name;
    this.accessory._associatedHAPAccessory.displayName = name;

    // Set all the HomeKit-visible names.
    this.accessory.getService(this.hap.Service.AccessoryInformation)?.updateCharacteristic(this.hap.Characteristic.Name, name);
  }
}
