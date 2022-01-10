/* Copyright(C) 2019-2022, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-nvr-systeminfo.ts: NVR System Information device class for UniFi Protect.
 */
import {
  PLATFORM_NAME,
  PLUGIN_NAME
} from "./settings";
import {
  PlatformAccessory
} from "homebridge";
import { ProtectBase } from "./protect-accessory";
import { ProtectNvr } from "./protect-nvr";
import { ProtectNvrSystemInfoConfig } from "unifi-protect";

export class ProtectNvrSystemInfo extends ProtectBase {

  private isConfigured: boolean;
  private accessory: PlatformAccessory | null | undefined;
  private systemInfo: ProtectNvrSystemInfoConfig | null | undefined;

  // Configure our NVR sensor capability.
  constructor(nvr: ProtectNvr) {

    // Let the base class get us set up.
    super(nvr);

    // Initialize the class.
    this.isConfigured = false;
    this.systemInfo = null;
    this.accessory = null;

    this.configureAccessory();
  }

  // Configure the NVR system information accessory.
  public configureAccessory(): void {

    // If we don't have the bootstrap configuration, we're done here.
    if(!this.nvrApi.bootstrap) {
      return;
    }

    // We've already configured our system information, we're done.
    if(this.isConfigured) {
      return;
    }

    const uuid = this.hap.uuid.generate(this.nvrApi.bootstrap.nvr.mac + ".NVRSystemInfo");

    // See if we already have this accessory defined.
    if(!this.accessory) {

      if((this.accessory = this.platform.accessories.find((x: PlatformAccessory) => x.UUID === uuid)) === undefined) {
        this.accessory = null;
      }
    }

    // If we've disabled NVR system information, remove the accessory if it exists.
    if(!this.nvr.optionEnabled(null, "NVR.SystemInfo", false)) {

      if(this.accessory) {

        this.log.info("%s: Removing UniFi Protect controller system information sensors.", this.name());

        // Unregister the accessory and delete it's remnants from HomeKit and the plugin.
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [this.accessory]);
        this.platform.accessories.splice(this.platform.accessories.indexOf(this.accessory), 1);
      }

      this.accessory = null;
      this.systemInfo = null;
      this.isConfigured = true;
      return;
    }

    // Create the accessory if it doesn't already exist.
    if(!this.accessory) {

      // We will use the NVR MAC address + ".NVRSystemInfo" to create our UUID. That should provide the guaranteed uniqueness we need.
      this.accessory = new this.api.platformAccessory(this.nvrApi.bootstrap.nvr.name, uuid);

      if(!this.accessory) {
        this.log.error("%s: Unable to create the system information accessory.", this.name());
        this.isConfigured = true;
        return;
      }

      // Register this accessory with homebridge and add it to the platform accessory array so we can track it.
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [this.accessory]);
      this.platform.accessories.push(this.accessory);
    }

    // We have the system information accessory, now let's configure it.
    // Clean out the context object in case it's been polluted somehow.
    this.accessory.context = {};
    this.accessory.context.nvr = this.nvr.nvrApi.bootstrap?.nvr.mac;
    this.accessory.context.systemInfo = true;

    // Verify the NVR has been bootstrapped, and finish our configuration.
    if(this.nvr.nvrApi.bootstrap) {

      // Initialize our system information.
      this.systemInfo = this.nvr.nvrApi.bootstrap.nvr.systemInfo;

      // Configure accessory information.
      this.setInfo(this.accessory, this.nvr.nvrApi.bootstrap.nvr);
    }

    // Configure accessory services.
    const enabledSensors = this.updateDevice(true);

    // Inform the user what we're enabling on startup.
    if(enabledSensors.length) {
      this.log.info("%s: Enabled system information sensor%s: %s.", this.name(), enabledSensors.length > 1 ? "s" : "", enabledSensors.join(", "));
    }  else {
      this.log.info("%s: No system information sensors enabled.", this.name());
    }

    this.configureMqtt();
    this.isConfigured = true;
  }

  // Update accessory services and characteristics.
  public updateDevice(configureHandler = false, updatedInfo?: ProtectNvrSystemInfoConfig): string[] {

    const enabledSensors: string[] = [];

    if(updatedInfo !== undefined) {
      this.systemInfo = updatedInfo;
    }

    // Configure the temperature sensor.
    if(this.configureTemperatureSensor(configureHandler)) {

      enabledSensors.push("cpu temperature");
    }

    // Configure MQTT services.
    // this.configureMqtt();

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
    if(!this.nvr?.optionEnabled(null, "NVR.SystemInfo.Temperature")) {

      if(temperatureService) {

        this.accessory.removeService(temperatureService);
        this.log.info("%s: Disabling CPU temperature sensor.", this.name());
      }

      return false;
    }

    // Add the service to the accessory, if needed.
    if(!temperatureService) {

      temperatureService = new this.hap.Service.TemperatureSensor("CPU Temperature");

      if(!temperatureService) {

        this.log.error("%s: Unable to add CPU temperature sensor.", this.name());
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

    let cpuTemp = this.systemInfo?.cpu.temperature;

    // No data available from the Protect NVR, so we default to a starting point.
    if(cpuTemp === undefined) {
      return 0;
    }

    // HomeKit wants temperature values in Celsius, so we need to convert accordingly, if needed.
    if(this.nvrApi.bootstrap?.nvr?.temperatureUnit === "F") {
      cpuTemp = (cpuTemp - 32) * (5 / 9);
    }

    return cpuTemp;
  }

  // Configure MQTT capabilities for the security system.
  private configureMqtt(): void {

    if(!this.nvrApi.bootstrap?.nvr.mac) {
      return;
    }

    // Return the current status of all sensors.
    this.nvr.mqtt?.subscribe(this.nvrApi.bootstrap?.nvr.mac, "systeminfo/get", (message: Buffer) => {

      const value = message.toString().toLowerCase();

      // When we get the right message, we return the system information JSON.
      if(value !== "true") {
        return;
      }

      this.nvr.mqtt?.publish(this.nvrApi.bootstrap?.nvr.mac ?? "", "systeminfo", JSON.stringify(this.systemInfo));
      this.log.info("%s: System information published via MQTT.", this.name());
    });
  }
}
