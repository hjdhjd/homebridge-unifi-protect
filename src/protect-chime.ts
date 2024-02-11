/* Copyright(C) 2023-2024, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-chime.ts: Chime device class for UniFi Protect.
 */
import { CharacteristicValue, PlatformAccessory } from "homebridge";
import { ProtectChimeConfig, ProtectChimeConfigPayload, ProtectEventPacket } from "unifi-protect";
import { ProtectDevice } from "./protect-device.js";
import { ProtectNvr } from "./protect-nvr.js";

export class ProtectChime extends ProtectDevice {

  public ufp: ProtectChimeConfig;

  // Create an instance.
  constructor(nvr: ProtectNvr, device: ProtectChimeConfig, accessory: PlatformAccessory) {

    super(nvr, accessory);

    this.ufp = device;

    this.configureHints();
    this.configureDevice();
  }

  // Initialize and configure the chime accessory for HomeKit.
  private configureDevice(): boolean {

    // Clean out the context object in case it's been polluted somehow.
    this.accessory.context = {};
    this.accessory.context.mac = this.ufp.mac;
    this.accessory.context.nvr = this.nvr.ufp.mac;

    // Configure accessory information.
    this.configureInfo();

    // Configure the chime as a light. We don't have volume accessories, so a dimmer is the best we can currently do within the constraints of HomeKit.
    this.configureLightbulb();

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

        this.log.error("Unable to add chime.");
        return false;
      }

      this.accessory.addService(lightService);
    }

    // Turn the chime on or off.
    lightService.getCharacteristic(this.hap.Characteristic.On)?.onGet(() => {

      return this.ufp.volume > 0;
    });

    lightService.getCharacteristic(this.hap.Characteristic.On)?.onSet(async (value: CharacteristicValue) => {

      // We really only want to act when the chime is turned off. Otherwise, it's handled by the brightness event.
      if(value) {

        return;
      }

      const newDevice = await this.nvr.ufpApi.updateDevice(this.ufp, { volume: 0 });

      if(!newDevice) {

        this.log.error("Unable to turn the volume off. Please ensure this username has the Administrator role in UniFi Protect.");
        return;
      }

      // Set the context to our updated device configuration.
      this.ufp = newDevice;
    });

    // Adjust the volume of the chime by adjusting brightness of the light.
    lightService.getCharacteristic(this.hap.Characteristic.Brightness)?.onGet(() => {

      // Return the volume level of the chime.
      return this.ufp.volume;
    });

    lightService.getCharacteristic(this.hap.Characteristic.Brightness)?.onSet(async (value: CharacteristicValue) => {

      const newDevice = await this.nvr.ufpApi.updateDevice(this.ufp, { volume: value as number });

      if(!newDevice) {

        this.log.error("Unable to adjust the volume to %s%. Please ensure this username has the Administrator role in UniFi Protect.", value);
        return;
      }

      // Set the context to our updated device configuration.
      this.ufp = newDevice;
    });

    // Initialize the chime.
    lightService.displayName = this.accessoryName;
    lightService.updateCharacteristic(this.hap.Characteristic.Name, this.accessoryName);
    lightService.updateCharacteristic(this.hap.Characteristic.On, this.ufp.volume > 0);
    lightService.updateCharacteristic(this.hap.Characteristic.Brightness, this.ufp.volume);

    return true;
  }

  // Configure MQTT capabilities of this chime.
  private configureMqtt(): boolean {

    const lightService = this.accessory.getService(this.hap.Service.Lightbulb);

    if(!lightService) {
      return false;
    }

    // Trigger a motion event in MQTT, if requested to do so.
    this.nvr.mqtt?.subscribe(this.accessory, "chime", (message: Buffer) => {

      const volume = parseInt(message.toString());

      // Unknown message - ignore it.
      if(isNaN(volume) || (volume < 0) || (volume > 100)) {

        return;
      }

      lightService.getCharacteristic(this.hap.Characteristic.Brightness)?.setValue(volume);
      lightService.getCharacteristic(this.hap.Characteristic.On)?.setValue(volume > 0);
      this.log.info("Chime volume set to %s% via MQTT.", volume);
    });

    return true;
  }

  // Handle chime-related events.
  private eventHandler(packet: ProtectEventPacket): void {

    const payload = packet.payload as ProtectChimeConfigPayload;

    // It's a volume setting event - process it accordingly.
    if("volume" in payload) {

      // Update our volume setting.
      this.accessory.getService(this.hap.Service.Lightbulb)?.updateCharacteristic(this.hap.Characteristic.Brightness, payload.volume as number);
      this.accessory.getService(this.hap.Service.Lightbulb)?.updateCharacteristic(this.hap.Characteristic.On, (payload.volume as number) > 0);
    }
  }
}
