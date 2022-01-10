/* Copyright(C) 2019-2022, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-light.ts: Light device class for UniFi Protect.
 */
import { CharacteristicValue } from "homebridge";
import { ProtectAccessory } from "./protect-accessory";
import { ProtectLightConfig } from "unifi-protect";

export class ProtectLight extends ProtectAccessory {

  private lightState!: boolean;

  // Initialize and configure the light accessory for HomeKit.
  protected async configureDevice(): Promise<boolean> {

    this.lightState = false;

    // Save the device object before we wipeout the context.
    const device = this.accessory.context.device as ProtectLightConfig;

    // Clean out the context object in case it's been polluted somehow.
    this.accessory.context = {};
    this.accessory.context.device = device;
    this.accessory.context.nvr = this.nvr.nvrApi.bootstrap?.nvr.mac;

    // Configure accessory information.
    this.configureInfo();

    // Configure the light.
    this.configureLightbulb();

    // Configure the motion sensor.
    this.configureMotionSensor();

    // Configure MQTT services.
    this.configureMqtt();

    return Promise.resolve(true);
  }

  // Configure the light for HomeKit.
  private configureLightbulb(): boolean {

    // Find the service, if it exists.
    let lightService = this.accessory.getService(this.hap.Service.Lightbulb);

    // Add the service to the accessory, if needed.
    if(!lightService) {

      lightService = new this.hap.Service.Lightbulb(this.accessory.displayName);

      if(!lightService) {

        this.log.error("%s: Unable to add light.", this.name());
        return false;
      }

      this.accessory.addService(lightService);
    }

    // Turn the light on or off.
    lightService.getCharacteristic(this.hap.Characteristic.On)
      ?.onGet(() => {
        return (this.accessory.context.device as ProtectLightConfig).isLightOn === true;
      })
      .onSet(async (value: CharacteristicValue) => {

        const lightState = value === true;
        const newDevice = await this.nvr.nvrApi.updateLight(this.accessory.context.device as ProtectLightConfig, { lightOnSettings: { isLedForceOn: lightState } });

        if(!newDevice) {

          this.log.error("%s: Unable to turn the light %s. Please ensure this username has the Administrator role in UniFi Protect.",
            this.name(), lightState ? "on" : "off");
          return;
        }

        // Set the context to our updated device configuration.
        this.accessory.context.device = newDevice;
      });

    // Adjust the brightness of the light.
    lightService.getCharacteristic(this.hap.Characteristic.Brightness)
      ?.onGet(() => {

        // The Protect ledLevel settings goes from 1 - 6. HomeKit expects percentages, so we convert it like so.
        return ((this.accessory.context.device as ProtectLightConfig).lightDeviceSettings.ledLevel - 1) * 20;
      })
      .onSet(async (value: CharacteristicValue) => {

        const brightness = Math.round(((value as number) / 20) + 1);
        const newDevice = await this.nvr.nvrApi.updateLight(this.accessory.context.device as ProtectLightConfig, { lightDeviceSettings: { ledLevel: brightness } });

        if(!newDevice) {

          this.log.error("%s: Unable to adjust the brightness to %s%. Please ensure this username has the Administrator role in UniFi Protect.",
            this.name(), value);
          return;
        }

        // Set the context to our updated device configuration.
        this.accessory.context.device = newDevice;

        // Make sure we properly reflect what brightness we're actually at.
        setTimeout(() => {
          lightService?.updateCharacteristic(this.hap.Characteristic.Brightness, (brightness - 1) * 20);
        }, 50);
      });

    // Initialize the light.
    lightService.updateCharacteristic(this.hap.Characteristic.On, (this.accessory.context.device as ProtectLightConfig).isLightOn);
    lightService.updateCharacteristic(this.hap.Characteristic.Brightness, ((this.accessory.context.device as ProtectLightConfig).lightDeviceSettings.ledLevel - 1) * 20);

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
          this.log.info("%s: Light turned off via MQTT.", this.name());
          break;

        case "on":

          lightService.getCharacteristic(this.hap.Characteristic.On)?.setValue(true);
          this.log.info("%s: Light turned on via MQTT.", this.name());
          break;

        default:

          // Unknown message - ignore it.
          if(isNaN(brightness) || (brightness < 0) || (brightness > 100)) {
            return;
          }

          lightService.getCharacteristic(this.hap.Characteristic.Brightness)?.setValue(brightness);
          this.log.info("%s: Light set to %s% via MQTT.", this.name(), brightness);

          break;
      }
    });

    return true;
  }
}
