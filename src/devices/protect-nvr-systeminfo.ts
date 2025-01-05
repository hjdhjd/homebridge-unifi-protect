/* Copyright(C) 2019-2025, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-nvr-systeminfo.ts: NVR System Information device class for UniFi Protect.
 */
import { Nullable, validateName } from "homebridge-plugin-utils";
import { PLATFORM_NAME, PLUGIN_NAME } from "../settings.js";
import { PlatformAccessory } from "homebridge";
import { ProtectBase } from "./protect-device.js";
import { ProtectEventPacket } from "unifi-protect";
import { ProtectNvr } from "../protect-nvr.js";

export class ProtectNvrSystemInfo extends ProtectBase {

  private accessory: Nullable<PlatformAccessory> | undefined;
  private eventListener: Nullable<(packet: ProtectEventPacket) => void>;
  private isConfigured: boolean;
  private lastTemp: number;

  // Configure our NVR sensor capability.
  constructor(nvr: ProtectNvr) {

    // Let the base class get us set up.
    super(nvr);

    // Initialize the class.
    this.accessory = null;
    this.eventListener = null;
    this.isConfigured = false;
    this.lastTemp = 0;

    this.configureAccessory();
    this.configureMqtt();

    this.nvr.events.on("updateEvent." + this.nvr.ufp.id, this.eventListener = this.eventHandler.bind(this));
  }

  // Configure the NVR system information accessory.
  private configureAccessory(): void {

    // We've already configured our system information, we're done.
    if(this.isConfigured) {

      return;
    }

    const uuid = this.hap.uuid.generate(this.nvr.ufp.mac + ".NVRSystemInfo");

    // See if we already have this accessory defined.
    if(!this.accessory) {

      if((this.accessory = this.platform.accessories.find((x: PlatformAccessory) => x.UUID === uuid)) === undefined) {

        this.accessory = null;
      }
    }

    // If we've disabled NVR system information, remove the accessory if it exists.
    if(!this.nvr.hasFeature("NVR.SystemInfo")) {

      if(this.accessory) {

        this.log.info("Removing UniFi Protect controller system information sensors.");

        // Unregister the accessory and delete it's remnants from HomeKit and the plugin.
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [this.accessory]);
        this.platform.accessories.splice(this.platform.accessories.indexOf(this.accessory), 1);
      }

      this.accessory = null;
      this.isConfigured = true;

      return;
    }

    // Create the accessory if it doesn't already exist.
    if(!this.accessory) {

      // We will use the NVR MAC address + ".NVRSystemInfo" to create our UUID. That should provide the guaranteed uniqueness we need.
      this.accessory = new this.api.platformAccessory(validateName(this.nvr.ufp.name ?? this.nvr.ufp.marketName), uuid);

      if(!this.accessory) {

        this.isConfigured = true;
        this.log.error("Unable to create the system information accessory.");

        return;
      }

      // Register this accessory with homebridge and add it to the platform accessory array so we can track it.
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [this.accessory]);
      this.platform.accessories.push(this.accessory);
    }

    // We have the system information accessory, now let's configure it.
    // Clean out the context object in case it's been polluted somehow.
    this.accessory.context = {};
    this.accessory.context.nvr = this.nvr.ufp.mac;
    this.accessory.context.systemInfo = true;

    // Verify the NVR has been bootstrapped, and finish our configuration.
    if(this.nvr.ufp.systemInfo) {

      // Configure accessory information.
      this.setInfo(this.accessory, this.nvr.ufp);
    }

    // Configure accessory services.
    const enabledSensors = this.updateDevice(true);

    // Inform the user what we're enabling on startup.
    if(enabledSensors.length) {

      this.log.info("Enabled system information sensor%s: %s.", enabledSensors.length > 1 ? "s" : "", enabledSensors.join(", "));
    } else {

      this.log.info("No system information sensors enabled.");
    }

    this.isConfigured = true;
  }

  // Configure the events we're interested in from the Protect controller.
  private eventHandler(packet: ProtectEventPacket): void {

    // Filter out payloads we aren't interested in. We only want NVR system information updates.
    if("systemInfo" in (packet.payload as JSON)) {

      // Process it.
      this.updateDevice(false);
    }
  }

  // Cleanup our listeners.
  private cleanupEvents(): void {

    if(this.eventListener) {

      this.nvr.events.off("updateEvent." + this.nvr.ufp.id, this.eventListener);
      this.eventListener = null;
    }
  }

  // Update accessory services and characteristics.
  private updateDevice(configureHandler = false): string[] {

    const enabledSensors: string[] = [];

    // Configure the temperature sensor.
    if(this.configureTemperatureSensor(configureHandler)) {

      enabledSensors.push("cpu temperature");
    }

    return enabledSensors;
  }

  // Configure the temperature sensor for HomeKit.
  private configureTemperatureSensor(configureHandler: boolean): boolean {

    // Ensure we have an accessory before we do anything else.
    if(!this.accessory) {

      return false;
    }

    // Find the service, if it exists.
    let temperatureService = this.accessory.getService(this.hap.Service.TemperatureSensor);

    // Have we disabled the temperature sensor?
    if(!this.nvr?.hasFeature("NVR.SystemInfo.Temperature")) {

      if(temperatureService) {

        this.accessory.removeService(temperatureService);
        this.log.info("Disabling CPU temperature sensor.");
      }

      return false;
    }

    // Add the service to the accessory, if needed.
    if(!temperatureService) {

      temperatureService = new this.hap.Service.TemperatureSensor("CPU Temperature");

      if(!temperatureService) {

        this.log.error("Unable to add CPU temperature sensor.");

        return false;
      }

      this.accessory.addService(temperatureService);
    }

    // If we're configuring for the first time, we add our respective handlers.
    if(configureHandler) {

      // Retrieve the current temperature when requested.
      temperatureService.getCharacteristic(this.hap.Characteristic.CurrentTemperature)?.onGet(() => {

        return this.getCpuTemp();
      });
    }

    // Update the sensor.
    temperatureService.updateCharacteristic(this.hap.Characteristic.CurrentTemperature, this.getCpuTemp());

    return true;
  }

  // Retrieve the CPU temperature of the Protect NVR for HomeKit.
  private getCpuTemp(): number {

    let cpuTemp = this.nvr.ufp?.systemInfo?.cpu?.temperature;

    // No data available from the Protect NVR, so we default to a starting point.
    if(cpuTemp === undefined) {

      return this.lastTemp;
    }

    // HomeKit wants temperature values in Celsius, so we need to convert accordingly, if needed.
    if(this.nvr.ufp.temperatureUnit === "F") {

      cpuTemp = (cpuTemp - 32) * (5 / 9);
    }

    return this.lastTemp = cpuTemp;
  }

  // Configure MQTT capabilities for the security system.
  private configureMqtt(): void {

    // Return the current status of all sensors.
    this.nvr.mqtt?.subscribeGet(this.nvr.ufp.mac, "systeminfo", "system information", () => {

      return JSON.stringify(this.nvr.ufp.systemInfo);
    });
  }
}
