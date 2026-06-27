/* Copyright(C) 2019-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * nvr-systeminfo.ts: NVR System Information device class for UniFi Protect.
 */
import { PLATFORM_NAME, PLUGIN_NAME } from "../settings.ts";
import type { ProtectAccessory, ProtectAccessoryContext } from "../types.ts";
import { acquireService, sanitizeName, validService } from "homebridge-plugin-utils";
import type { Nullable } from "homebridge-plugin-utils";
import { ProtectBase } from "../devices/device-base.ts";
import type { ProtectNvr } from "./nvr.ts";
import { selectNvr } from "unifi-protect";

export class ProtectNvrSystemInfo extends ProtectBase {

  private accessory: Nullable<ProtectAccessory> | undefined;
  private isConfigured: boolean;

  // Configure our NVR sensor capability.
  constructor(nvr: ProtectNvr) {

    // Let the base class get us set up.
    super(nvr);

    // Initialize the class. The constructor owns the initial configuration; subsequent refreshes are driven by this owner's own narrow observer below.
    this.accessory = null;
    this.isConfigured = false;

    this.configureAccessory();
    this.configureMqtt();

    // Subject owns its reactivity: observe the controller record's systemInfo slice and refresh the temperature sensor on each change. The narrow selector wakes only on
    // a systemInfo change - never on the lastSeen/storage churn the whole NVR record carries - and the store yields only on change, so the constructor's initial pass
    // above stands on its own and this loop handles only subsequent updates. It binds to the controller lifetime (ProtectBase.observeSignal) and re-reads through
    // this.nvr.ufp rather than trusting the yielded slice.
    this.observeState({ key: "nvr.systemInfo", selector: state => selectNvr(state)?.systemInfo, title: "system information" }, () => this.updateDevice(false));
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

      if((this.accessory = this.platform.accessories.find(x => x.UUID === uuid)) === undefined) {

        this.accessory = null;
      }
    }

    // If we've disabled NVR system information, remove the accessory if it exists.
    if(!this.nvr.hasFeature("NVR.SystemInfo")) {

      if(this.accessory) {

        this.log.info("Removing UniFi Protect controller system information sensors.");

        // Unregister the accessory and delete its remnants from HomeKit and the plugin.
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
      this.accessory = new this.api.platformAccessory<ProtectAccessoryContext>(sanitizeName(this.nvr.ufp.name ?? this.nvr.ufp.marketName), uuid);

      // Register this accessory with homebridge and add it to the platform accessory array so we can track it.
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [this.accessory]);
      this.platform.accessories.push(this.accessory);
    }

    // We have the system information accessory, now let's configure it.
    // Clean out the context object in case it's been polluted somehow.
    this.accessory.context = {};
    this.accessory.context.nvr = this.nvr.ufp.mac;
    this.accessory.context.systemInfo = true;

    // Configure accessory information.
    this.setInfo(this.accessory, this.nvr.ufp);

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

  // Update accessory services and characteristics. Private: both callers are this class - the constructor's initial pass (handler flag set) and this owner's own
  // systemInfo observer (handler flag clear, for the per-change characteristic refresh).
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

    // Validate the service.
    if(!validService(this.accessory, this.hap.Service.TemperatureSensor, this.nvr.hasFeature("NVR.SystemInfo"))) {

      return false;
    }

    // Acquire the service.
    const service = acquireService(this.accessory, this.hap.Service.TemperatureSensor, this.accessory.displayName + " CPU Temperature");

    if(!service) {

      this.log.error("Unable to add CPU temperature sensor.");

      return false;
    }

    // If we're configuring for the first time, we add our respective handlers.
    if(configureHandler) {

      // Retrieve the current temperature when requested.
      service.getCharacteristic(this.hap.Characteristic.CurrentTemperature).onGet(() => this.nvr.ufp.systemInfo.cpu.temperature);
    }

    // Update the sensor.
    service.updateCharacteristic(this.hap.Characteristic.CurrentTemperature, this.nvr.ufp.systemInfo.cpu.temperature);

    return true;
  }

  // Configure MQTT capabilities for the controller system information.
  private configureMqtt(): void {

    // Return the controller's current system information.
    this.subscribeGet("systeminfo", "system information", () => JSON.stringify(this.nvr.ufp.systemInfo));
  }
}
