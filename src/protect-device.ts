/* Copyright(C) 2017-2023, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-device.ts: Base class for all UniFi Protect devices.
 */
import { API, CharacteristicValue, HAP, PlatformAccessory } from "homebridge";
import { ProtectApi, ProtectEventPacket } from "unifi-protect";
import { ProtectDeviceConfigTypes, ProtectLogging, ProtectReservedNames } from "./protect-types.js";
import { ProtectNvr } from "./protect-nvr.js";
import { ProtectNvrConfig } from "unifi-protect";
import { ProtectPlatform } from "./protect-platform.js";
import { optionEnabled } from "./protect-options.js";
import util from "node:util";

/*
// List the optional methods of our subclasses that we want to expose commonly.
export interface ProtectDevice {

  eventHandler?(): void;
}
/* */

// Device-specific options and settings.
export interface ProtectHints {

  hardwareTranscoding: boolean,
  ledStatus: boolean,
  logDoorbell: boolean,
  logHksv: boolean,
  logMotion: boolean,
  probesize: number,
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
    accessory
      .getService(this.hap.Service.AccessoryInformation)
      ?.updateCharacteristic(this.hap.Characteristic.Manufacturer, "Ubiquiti Networks");

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

    this.hints.logMotion = this.nvr.optionEnabled(this.ufp, "Log.Motion", false);
    return true;
  }

  // Configure the device information details for HomeKit.
  protected configureInfo(): boolean {

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
  protected configureMotionSensor(isEnabled = true): boolean {

    // Find the motion sensor service, if it exists.
    let motionService = this.accessory.getService(this.hap.Service.MotionSensor);

    // Have we disabled motion sensors?
    if(!isEnabled) {

      if(motionService) {

        this.accessory.removeService(motionService);
        this.nvr.mqtt?.unsubscribe(this.accessory, "motion/trigger");
        this.log.info("Disabling motion sensor.");
      }

      return false;
    }

    // We don't have a motion sensor, let's add it to the camera.
    if(!motionService) {

      // We don't have it, add the motion sensor to the camera.
      motionService = new this.hap.Service.MotionSensor(this.accessory.displayName);

      if(!motionService) {

        this.log.error("Unable to add motion sensor.");
        return false;
      }

      this.accessory.addService(motionService);

      this.log.info("Enabling motion sensor.");
    }

    // Initialize the state of the motion sensor.
    motionService.updateCharacteristic(this.hap.Characteristic.MotionDetected, false);
    motionService.updateCharacteristic(this.hap.Characteristic.StatusActive, this.ufp.state === "CONNECTED");

    motionService.getCharacteristic(this.hap.Characteristic.StatusActive).onGet(() => {

      return this.ufp.state === "CONNECTED";
    });

    // Configure our MQTT support.
    this.configureMqttMotionTrigger();

    return true;
  }

  // Configure a switch to easily activate or deactivate motion sensor detection for HomeKit.
  protected configureMotionSwitch(): boolean {

    // Find the switch service, if it exists.
    let switchService = this.accessory.getServiceById(this.hap.Service.Switch, ProtectReservedNames.SWITCH_MOTION_SENSOR);

    // Have we disabled motion sensors or the motion switch? Motion switches are disabled by default.
    if(!this.nvr?.optionEnabled(this.ufp, "Motion.Switch", false)) {

      if(switchService) {

        this.accessory.removeService(switchService);
      }

      // If we disable the switch, make sure we fully reset it's state. Otherwise, we can end up in a situation (e.g. liveview switches) where we have
      // disabled motion detection with no meaningful way to enable it again.
      this.accessory.context.detectMotion = true;

      return false;
    }

    this.log.info("Enabling motion sensor switch.");

    // Add the switch to the camera, if needed.
    if(!switchService) {

      switchService = new this.hap.Service.Switch(this.accessory.displayName + " Motion Events", ProtectReservedNames.SWITCH_MOTION_SENSOR);

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
      this.nvr.events.motionEventHandler(this, Date.now());
      this.log.info("Motion event triggered via MQTT.");
    });

    return true;
  }

  public isOptionEnabled(option: string, defaultReturnValue = true, address = "", addressOnly = false): boolean {

    return optionEnabled(this.platform.configOptions, this.nvr.ufp, this.ufp, option, defaultReturnValue, address, addressOnly);
  }

  // Utility function for reserved identifiers for switches.
  public isReservedName(name: string | undefined): boolean {

    return name === undefined ? false : Object.values(ProtectReservedNames).map(x => x.toUpperCase()).includes(name.toUpperCase());
  }

  // Utility function to return the fully enumerated name of this camera.
  public get name(): string {

    return this.nvr.ufpApi.getFullName(this.ufp ?? null);
  }
}
