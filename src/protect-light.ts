/* Copyright(C) 2019-2024, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-light.ts: Light device class for UniFi Protect.
 */
import { CharacteristicValue, PlatformAccessory } from "homebridge";
import { ProtectEventPacket, ProtectLightConfig, ProtectLightConfigPayload } from "unifi-protect";
import { ProtectDevice } from "./protect-device.js";
import { ProtectNvr } from "./protect-nvr.js";

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

    // Configure MQTT services.
    this.configureMqtt();

    // Listen for events.
    this.nvr.events.on("updateEvent." + this.ufp.id, this.listeners["updateEvent." + this.ufp.id] = this.eventHandler.bind(this));

    return true;
  }

  // Configure the light for HomeKit.
  private configureLightbulb(): boolean {

    // Find the service, if it exists.
    let lightService = this.accessory.getService(this.hap.Service.Lightbulb);

    // Add the service to the accessory, if needed.
    if(!lightService) {

      lightService = new this.hap.Service.Lightbulb(this.accessoryName);

      if(!lightService) {

        this.log.error("Unable to add light.");
        return false;
      }

      this.accessory.addService(lightService);
    }

    // Turn the light on or off.
    lightService.getCharacteristic(this.hap.Characteristic.On)?.onGet(() => {

      return this.ufp.isLightOn === true;
    });

    lightService.getCharacteristic(this.hap.Characteristic.On)?.onSet(async (value: CharacteristicValue) => {

      const lightState = value === true;
      const newDevice = await this.nvr.ufpApi.updateDevice(this.ufp, { lightOnSettings: { isLedForceOn: lightState } });

      if(!newDevice) {

        this.log.error("Unable to turn the light %s. Please ensure this username has the Administrator role in UniFi Protect.", lightState ? "on" : "off");
        return;
      }

      // Set the context to our updated device configuration.
      this.ufp = newDevice;
    });

    // Adjust the brightness of the light.
    lightService.getCharacteristic(this.hap.Characteristic.Brightness)?.onGet(() => {

      // The Protect ledLevel settings goes from 1 - 6. HomeKit expects percentages, so we convert it like so.
      return (this.ufp.lightDeviceSettings.ledLevel - 1) * 20;
    });

    lightService.getCharacteristic(this.hap.Characteristic.Brightness)?.onSet(async (value: CharacteristicValue) => {

      const brightness = Math.round(((value as number) / 20) + 1);
      const newDevice = await this.nvr.ufpApi.updateDevice(this.ufp, { lightDeviceSettings: { ledLevel: brightness } });

      if(!newDevice) {

        this.log.error("Unable to adjust the brightness to %s%. Please ensure this username has the Administrator role in UniFi Protect.", value);
        return;
      }

      // Set the context to our updated device configuration.
      this.ufp = newDevice;

      // Make sure we properly reflect what brightness we're actually at, given the differences in setting granularity between Protect and HomeKit.
      setTimeout(() => {

        lightService?.updateCharacteristic(this.hap.Characteristic.Brightness, (brightness - 1) * 20);
      }, 50);
    });

    // Initialize the light.
    lightService.displayName = this.accessoryName;
    lightService.updateCharacteristic(this.hap.Characteristic.Name, this.accessoryName);
    lightService.updateCharacteristic(this.hap.Characteristic.On, this.ufp.isLightOn);
    lightService.updateCharacteristic(this.hap.Characteristic.Brightness, (this.ufp.lightDeviceSettings.ledLevel - 1) * 20);

    return true;
  }

  // Configure MQTT capabilities of this light.
  private configureMqtt(): boolean {

    const lightService = this.accessory.getService(this.hap.Service.Lightbulb);

    if(!lightService) {

      return false;
    }

    // Trigger a motion event in MQTT, if requested to do so.
    this.nvr.mqtt?.subscribe(this.accessory, "light", (message: Buffer) => {

      const value = message.toString();
      const brightness = parseInt(value);

      switch(value?.toLowerCase()) {

        case "off":

          lightService.getCharacteristic(this.hap.Characteristic.On)?.setValue(false);
          this.log.info("Light turned off via MQTT.");
          break;

        case "on":

          lightService.getCharacteristic(this.hap.Characteristic.On)?.setValue(true);
          this.log.info("Light turned on via MQTT.");
          break;

        default:

          // Unknown message - ignore it.
          if(isNaN(brightness) || (brightness < 0) || (brightness > 100)) {
            return;
          }

          lightService.getCharacteristic(this.hap.Characteristic.Brightness)?.setValue(brightness);
          this.log.info("Light set to %s% via MQTT.", brightness);

          break;
      }
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
    if(payload.lightDeviceSettings && ("ledLevel" in payload.lightDeviceSettings)) {

      // Update our brightness.
      this.accessory.getService(this.hap.Service.Lightbulb)?.
        updateCharacteristic(this.hap.Characteristic.Brightness, ((payload.lightDeviceSettings.ledLevel as number) - 1) * 20);
    }
  }
}
