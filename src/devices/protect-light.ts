/* Copyright(C) 2019-2025, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-light.ts: Light device class for UniFi Protect.
 */
import type { CharacteristicValue, PlatformAccessory } from "homebridge";
import type { ProtectEventPacket, ProtectLightConfig, ProtectLightConfigPayload } from "unifi-protect";
import { ProtectDevice } from "./protect-device.js";
import type { ProtectNvr } from "../protect-nvr.js";
import { ProtectReservedNames } from "../protect-types.js";

export class ProtectLight extends ProtectDevice {

  private lightState: boolean;
  public ufp: ProtectLightConfig;

  // Create an instance.
  constructor(nvr: ProtectNvr, device: ProtectLightConfig, accessory: PlatformAccessory) {

    super(nvr, accessory);

    this.lightState = false;
    this.ufp = device;

    this.configureHints();
    this.configureDevice();
  }

  // Initialize and configure the light accessory for HomeKit.
  private configureDevice(): boolean {

    this.lightState = false;

    // Clean out the context object in case it's been polluted somehow.
    this.accessory.context = {};
    this.accessory.context.mac = this.ufp.mac;
    this.accessory.context.nvr = this.nvr.ufp.mac;

    // Configure accessory information.
    this.configureInfo();

    // Configure the light.
    this.configureLightbulb();

    // Configure the motion sensor.
    this.configureMotionSensor();

    // Configure the occupancy sensor.
    this.configureOccupancySensor();

    // Configure the status indicator light switch.
    this.configureStatusLedSwitch();

    // Configure MQTT services.
    this.configureMqtt();

    // Listen for events.
    this.nvr.events.on("updateEvent." + this.ufp.id, this.listeners["updateEvent." + this.ufp.id] = this.eventHandler.bind(this));

    return true;
  }

  // Configure the light for HomeKit.
  private configureLightbulb(): boolean {

    // Acquire the service.
    const service = this.acquireService(this.hap.Service.Lightbulb);

    // Add the switch to the device, if needed.
    if(!service) {

      this.log.error("Unable to add light.");

      return false;
    }

    // Turn the light on or off.
    service.getCharacteristic(this.hap.Characteristic.On)?.onGet(() => {

      return this.ufp.isLightOn === true;
    });

    service.getCharacteristic(this.hap.Characteristic.On)?.onSet(async (value: CharacteristicValue) => {

      const lightState = value === true;
      const newDevice = await this.nvr.ufpApi.updateDevice(this.ufp, { lightOnSettings: { isLedForceOn: lightState } });

      if(!newDevice) {

        this.log.error("Unable to turn the light %s. Please ensure this username has the Administrator role in UniFi Protect.", lightState ? "on" : "off");

        return;
      }

      // Set the context to our updated device configuration.
      this.ufp = newDevice;

      // Publish our state.
      this.publish("light", lightState ? "true" : "false");
    });

    // Adjust the brightness of the light.
    service.getCharacteristic(this.hap.Characteristic.Brightness)?.onGet(() => {

      // The Protect ledLevel settings goes from 1 - 6. HomeKit expects percentages, so we convert it like so.
      return (this.ufp.lightDeviceSettings.ledLevel - 1) * 20;
    });

    service.getCharacteristic(this.hap.Characteristic.Brightness)?.onSet(async (value: CharacteristicValue) => {

      const brightness = Math.round(((value as number) / 20) + 1);
      const newDevice = await this.nvr.ufpApi.updateDevice(this.ufp, { lightDeviceSettings: { ledLevel: brightness } });

      if(!newDevice) {

        this.log.error("Unable to adjust the brightness to %s%. Please ensure this username has the Administrator role in UniFi Protect.", value);

        return;
      }

      // Set the context to our updated device configuration.
      this.ufp = newDevice;

      // Make sure we properly reflect what brightness we're actually at, given the differences in setting granularity between Protect and HomeKit.
      setTimeout(() => service?.updateCharacteristic(this.hap.Characteristic.Brightness, (brightness - 1) * 20), 50);

      // Publish our state.
      this.publish("light/brightness", ((brightness - 1) * 20).toString());
    });

    // Initialize the light.
    service.updateCharacteristic(this.hap.Characteristic.On, this.ufp.isLightOn);
    service.updateCharacteristic(this.hap.Characteristic.Brightness, (this.ufp.lightDeviceSettings.ledLevel - 1) * 20);

    return true;
  }

  // Configure MQTT capabilities of this light.
  private configureMqtt(): boolean {

    // Get the light state.
    this.subscribeGet("light", "light status", () => {

      return (this.ufp.isLightOn === true).toString();
    });

    this.subscribeGet("light/brightness", "light brightness", () => {

      return ((this.ufp.lightDeviceSettings.ledLevel - 1) * 20).toString();
    });

    // Control the light.
    this.subscribeSet("light", "light", (value: string) => {

      this.accessory.getService(this.hap.Service.Lightbulb)?.setCharacteristic(this.hap.Characteristic.On, value === "true");
    });

    this.subscribeSet("light/brightness", "light brightness", (value: string) => {

      const brightness = parseInt(value);

      // Unknown message - ignore it.
      if(isNaN(brightness) || (brightness < 0) || (brightness > 100)) {

        return;
      }

      this.accessory.getService(this.hap.Service.Lightbulb)?.setCharacteristic(this.hap.Characteristic.Brightness, brightness);
    });

    return true;
  }

  // Handle light-related events.
  private eventHandler(packet: ProtectEventPacket): void {

    const payload = packet.payload as ProtectLightConfigPayload;

    // It's a motion event - process it accordingly.
    if(payload.lastMotion) {

      this.nvr.events.motionEventHandler(this);
    }

    // It's a light power event - process it accordingly.
    if("isLightOn" in payload) {

      // Update our power state.
      this.accessory.getService(this.hap.Service.Lightbulb)?.updateCharacteristic(this.hap.Characteristic.On, payload.isLightOn as boolean);
    }

    // It's light brightness event - process it accordingly.
    if(payload.lightDeviceSettings) {

      if("ledLevel" in payload.lightDeviceSettings) {

        // Update our brightness.
        this.accessory.getService(this.hap.Service.Lightbulb)?.
          updateCharacteristic(this.hap.Characteristic.Brightness, ((payload.lightDeviceSettings.ledLevel as number) - 1) * 20);
      }

      if("isIndicatorEnabled" in payload.lightDeviceSettings) {

        // Update our status indicator light.
        this.accessory.getServiceById(this.hap.Service.Switch, ProtectReservedNames.SWITCH_STATUS_LED)?.
          updateCharacteristic(this.hap.Characteristic.On, payload.lightDeviceSettings.isIndicatorEnabled === true);
      }
    }
  }

  // Utility to return the command to set the device LED status on a Protect light.
  protected statusLedCommand(value: boolean): object {

    return { lightDeviceSettings: { isIndicatorEnabled: value === true } };
  }

  // Utility function to return the current state of the status indicator light.
  public get statusLed(): boolean {

    return this.ufp.lightDeviceSettings?.isIndicatorEnabled;
  }
}
