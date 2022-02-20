/* Copyright(C) 2017-2022, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-accessory.ts: Base class for all UniFi Protect accessories.
 */
import {
  API,
  CharacteristicValue,
  HAP,
  Logging,
  PlatformAccessory
} from "homebridge";
import { ProtectCameraConfig, ProtectNvrConfigInterface } from "unifi-protect";
import { ProtectApi } from "unifi-protect";
import { ProtectNvr } from "./protect-nvr";
import { ProtectPlatform } from "./protect-platform";

export enum ProtectReservedNames {

  // Manage our contact sensor types.
  CONTACT_MOTION_SMARTDETECT = "ContactMotionSmartDetect",
  CONTACT_SENSOR = "ContactSensor",
  CONTACT_SENSOR_ALARM_SOUND = "ContactAlarmSound",

  // Manage our switch types.
  SWITCH_DOORBELL_TRIGGER = "DoorbellTrigger",
  SWITCH_DYNAMIC_BITRATE = "DynamicBitrate",
  SWITCH_HKSV_RECORDING = "HKSVRecordingSwitch",
  SWITCH_MOTION_SENSOR = "MotionSensorSwitch",
  SWITCH_MOTION_TRIGGER = "MotionSensorTrigger",
  SWITCH_UFP_RECORDING_ALWAYS = "UFPRecordingSwitch.always",
  SWITCH_UFP_RECORDING_DETECTIONS = "UFPRecordingSwitch.detections",
  SWITCH_UFP_RECORDING_NEVER = "UFPRecordingSwitch.never"
}

// List the optional methods of our subclasses that we want to expose commonly.
export interface ProtectAccessory {
  configureDoorbellLcdSwitch?(): boolean;
}

export abstract class ProtectBase {

  public readonly api: API;
  private debug: (message: string, ...parameters: unknown[]) => void;
  protected readonly hap: HAP;
  protected readonly log: Logging;
  public readonly nvr: ProtectNvr;
  public nvrApi: ProtectApi;
  public readonly platform: ProtectPlatform;

  // The constructor initializes key variables and calls configureDevice().
  constructor(nvr: ProtectNvr) {

    this.api = nvr.platform.api;
    this.debug = nvr.platform.debug.bind(this);
    this.hap = this.api.hap;
    this.log = nvr.platform.log;
    this.nvr = nvr;
    this.nvrApi = nvr.nvrApi;
    this.platform = nvr.platform;
  }

  // Configure the device device information for HomeKit.
  protected setInfo(accessory: PlatformAccessory, device: ProtectNvrConfigInterface | Record<string, string>): boolean {

    // If we don't have a device, we're done.
    if(!device) {
      return false;
    }

    // Update the manufacturer information for this device.
    accessory
      .getService(this.hap.Service.AccessoryInformation)
      ?.updateCharacteristic(this.hap.Characteristic.Manufacturer, "Ubiquiti Networks");

    // Update the model information for this device.
    if(device.type?.length) {
      accessory
        .getService(this.hap.Service.AccessoryInformation)
        ?.updateCharacteristic(this.hap.Characteristic.Model, device.type);
    }

    // Update the serial number for this device.
    if(device.mac?.length) {
      accessory
        .getService(this.hap.Service.AccessoryInformation)
        ?.updateCharacteristic(this.hap.Characteristic.SerialNumber, device.mac);
    }

    // Update the hardware revision for this device, if available.
    if(device.hardwareRevision?.length) {
      accessory
        .getService(this.hap.Service.AccessoryInformation)
        ?.updateCharacteristic(this.hap.Characteristic.HardwareRevision, device.hardwareRevision);
    }

    // Update the firmware revision for this device.
    if(device.firmwareVersion?.length) {
      accessory
        .getService(this.hap.Service.AccessoryInformation)
        ?.updateCharacteristic(this.hap.Characteristic.FirmwareRevision, device.firmwareVersion);
    }

    return true;
  }

  // Utility function to return the fully enumerated name of this camera.
  public name(): string {
    return this.nvr.nvrApi.getNvrName();
  }
}

export abstract class ProtectAccessory extends ProtectBase {

  public readonly accessory: PlatformAccessory;

  // The constructor initializes key variables and calls configureDevice().
  constructor(nvr: ProtectNvr, accessory: PlatformAccessory) {

    // Call the constructor of our base class.
    super(nvr);

    // Set the accessory.
    this.accessory = accessory;

    // Configure the device.
    void this.configureDevice();
  }

  // All accessories require a configureDevice function. This is where all the
  // accessory-specific configuration and setup happens.
  protected abstract configureDevice(): Promise<boolean>;

  // Configure the device device information for HomeKit.
  protected configureInfo(): boolean {

    return this.setInfo(this.accessory, this.accessory.context.device as Record<string, string>);
  }

  // Configure the Protect motion sensor for HomeKit.
  protected configureMotionSensor(isEnabled = true): boolean {

    const device = this.accessory.context.device as ProtectCameraConfig;

    // Find the motion sensor service, if it exists.
    let motionService = this.accessory.getService(this.hap.Service.MotionSensor);

    // Have we disabled motion sensors?
    if(!isEnabled || !this.nvr?.optionEnabled(device, "Motion.Sensor")) {

      if(motionService) {

        this.accessory.removeService(motionService);
        this.nvr.mqtt?.unsubscribe(this.accessory, "motion/trigger");
        this.log.info("%s: Disabling motion sensor.", this.name());
      }

      return false;
    }

    // The motion sensor has already been configured.
    if(motionService) {

      // Initialize the state of the motion sensor.
      motionService.updateCharacteristic(this.hap.Characteristic.MotionDetected, false);
      motionService.updateCharacteristic(this.hap.Characteristic.StatusActive, device.state === "CONNECTED");

      this.configureMqttMotionTrigger();
      return true;
    }

    // We don't have it, add the motion sensor to the camera.
    motionService = new this.hap.Service.MotionSensor(this.accessory.displayName);

    if(!motionService) {

      this.log.error("%s: Unable to add motion sensor.", this.name());
      return false;
    }

    this.accessory.addService(motionService);
    this.configureMqttMotionTrigger();

    this.log.info("%s: Enabling motion sensor.", this.name());

    return true;
  }

  // Configure a switch to easily activate or deactivate motion sensor detection for HomeKit.
  protected configureMotionSwitch(): boolean {

    // Find the switch service, if it exists.
    let switchService = this.accessory.getServiceById(this.hap.Service.Switch, ProtectReservedNames.SWITCH_MOTION_SENSOR);

    // Have we disabled motion sensors or the motion switch? Motion switches are disabled by default.
    if(!this.nvr?.optionEnabled(this.accessory.context.device as ProtectCameraConfig, "Motion.Sensor") ||
      !this.nvr?.optionEnabled(this.accessory.context.device as ProtectCameraConfig, "Motion.Switch", false)) {

      if(switchService) {
        this.accessory.removeService(switchService);
      }

      // If we disable the switch, make sure we fully reset it's state.
      this.accessory.context.detectMotion = true;
      return false;
    }

    this.log.info("%s: Enabling motion sensor switch.", this.name());

    // Add the switch to the camera, if needed.
    if(!switchService) {
      switchService = new this.hap.Service.Switch(this.accessory.displayName + " Motion Events", ProtectReservedNames.SWITCH_MOTION_SENSOR);

      if(!switchService) {
        this.log.error("%s: Unable to add motion sensor switch.", this.name());
        return false;
      }

      this.accessory.addService(switchService);
    }

    // Activate or deactivate motion detection.
    switchService
      .getCharacteristic(this.hap.Characteristic.On)
      ?.onGet(() => {

        return this.accessory.context.detectMotion === true;
      })
      .onSet((value: CharacteristicValue) => {

        if(this.accessory.context.detectMotion !== value) {
          this.log.info("%s: Motion detection %s.", this.name(), (value === true) ? "enabled" : "disabled");
        }

        this.accessory.context.detectMotion = value === true;
      });


    // Initialize the switch.
    switchService.updateCharacteristic(this.hap.Characteristic.On, this.accessory.context.detectMotion as boolean);

    return true;
  }

  // Configure MQTT motion triggers.
  private configureMqttMotionTrigger(): boolean {

    // Trigger a motion event in MQTT, if requested to do so.
    this.nvr.mqtt?.subscribe(this.accessory, "motion/trigger", (message: Buffer) => {

      const value = message.toString();

      // When we get the right message, we trigger the motion event.
      if(value?.toLowerCase() !== "true") {
        return;
      }

      // Trigger the motion event.
      this.nvr.events.motionEventHandler(this.accessory, Date.now());
      this.log.info("%s: Motion event triggered via MQTT.", this.name());
    });

    return true;
  }

  // Utility function for reserved identifiers for switches.
  public isReservedName(name: string | undefined): boolean {

    return name === undefined ? false : Object.values(ProtectReservedNames).map(x => x.toUpperCase()).includes(name.toUpperCase());
  }

  // Utility function to return the fully enumerated name of this camera.
  public name(): string {
    return this.nvr.nvrApi.getFullName((this.accessory.context.device as ProtectCameraConfig) ?? null);
  }
}
