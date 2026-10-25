/* Copyright(C) 2019-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * nvr-systeminfo.ts: NVR System Information device class for UniFi Protect.
 */
import { PLATFORM_NAME, PLUGIN_NAME } from "../settings.ts";
import type { ProtectAccessory, ProtectAccessoryContext } from "../types.ts";
import { presenceChanged, validService } from "homebridge-plugin-utils";
import type { Nullable } from "homebridge-plugin-utils";
import { ProtectBase } from "../devices/device-base.ts";
import type { ProtectConfigurePass } from "../devices/device.ts";
import type { ProtectNvr } from "./nvr.ts";
import { deviceDisplayName } from "../devices/device-descriptor.ts";
import { mqttTopics } from "../mqtt.ts";
import { selectNvr } from "unifi-protect";

/* Represents the NVR controller's system information as a controller-owned accessory, not a device-backed one. It creates and keys its own accessory directly
 * from the controller's MAC address (the MAC plus ".NVRSystemInfo") rather than receiving one from device discovery, and its lifetime is the whole controller
 * connection: nothing invokes the cleanup() it inherits from the spine, because the accessory lives and dies with the controller and the controller's own shutdown
 * ends this owner's composed lifetime. That inherited method is reachable in principle, so a caller that invoked it would sever exactly this owner's observer and MQTT
 * registrations while the controller kept running - the accepted price of giving every owner the same lifecycle machinery. After construction, its only source of
 * reactivity is the systemInfo observer set up below, which refreshes the temperature sensor whenever the controller's system information changes. Turning off the
 * feature option removes the accessory outright rather than merely hiding it.
 */
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
    this.observeState({ key: "nvr.systemInfo", selector: state => selectNvr(state)?.systemInfo, title: "system information" },
      () => this.updateDevice({ initialized: true }));
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

        // Remove the accessory through the controller root's shared removal tail, which drops any save still pending for it, takes it off the bridge, and forgets it.
        this.nvr.removeAccessoryFromHomeKit(this.accessory);
      }

      this.accessory = null;
      this.isConfigured = true;

      return;
    }

    // Create the accessory if it doesn't already exist.
    if(!this.accessory) {

      // We will use the NVR MAC address + ".NVRSystemInfo" to create our UUID. That should provide the guaranteed uniqueness we need.
      this.accessory = new this.api.platformAccessory<ProtectAccessoryContext>(deviceDisplayName(this.nvr.ufp), uuid);

      // Register this accessory with homebridge and add it to the platform accessory array so we can track it.
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [this.accessory]);
      this.platform.accessories.push(this.accessory);
    }

    // We have the system information accessory, now let's configure it. We clean out the context object in case it's been polluted somehow, write our bookkeeping
    // into it, and mark the accessory, so the save that closes this window carries the context and the services this pass configures.
    this.accessory.context = {};
    this.platform.persistence.persist(this.accessory, { nvr: this.nvr.ufp.mac, systemInfo: true });

    // Configure accessory information.
    this.setInfo(this.accessory, this.nvr.ufp);

    // Configure accessory services.
    const enabledSensors = this.updateDevice({ initialized: false });

    // Inform the user what we're enabling on startup.
    if(enabledSensors.length) {

      this.log.info("Enabled system information sensor%s: %s.", enabledSensors.length > 1 ? "s" : "", enabledSensors.join(", "));
    } else {

      this.log.info("No system information sensors enabled.");
    }

    this.isConfigured = true;
  }

  // Update accessory services and characteristics. Private: every caller is this class - the constructor's initial pass, which binds the handlers, and this owner's
  // own systemInfo observer, a later pass that refreshes the characteristic on each change.
  private updateDevice({ initialized }: Required<Pick<ProtectConfigurePass, "initialized">>): string[] {

    const enabledSensors: string[] = [];

    // Configure the temperature sensor.
    if(this.configureTemperatureSensor({ initialized })) {

      enabledSensors.push("cpu temperature");
    }

    return enabledSensors;
  }

  // Configure the temperature sensor for HomeKit.
  private configureTemperatureSensor({ initialized }: Required<Pick<ProtectConfigurePass, "initialized">>): boolean {

    // Ensure we have an accessory before we do anything else.
    if(!this.accessory) {

      return false;
    }

    // Validate the service. A service the gate attached or removed changes what Homebridge's accessory cache holds, so the accessory is marked for the next save.
    const { service, transition } = validService({ accessory: this.accessory, name: this.accessory.displayName + " CPU Temperature",
      serviceType: this.hap.Service.TemperatureSensor, validate: this.nvr.hasFeature("NVR.SystemInfo") });

    if(presenceChanged(transition)) {

      this.platform.persistence.persist(this.accessory);
    }

    if(!service) {

      return false;
    }

    // If we're configuring for the first time, we add our respective handlers.
    if(!initialized) {

      // Retrieve the current temperature when requested.
      service.getCharacteristic(this.hap.Characteristic.CurrentTemperature).onGet(() => this.nvr.ufp.systemInfo.cpu.temperature);
    }

    // Update the sensor.
    service.updateCharacteristic(this.hap.Characteristic.CurrentTemperature, this.nvr.ufp.systemInfo.cpu.temperature);

    return true;
  }

  // Configure MQTT capabilities for the controller system information, only while the feature is on, because a feature the user has not enabled has no MQTT topic.
  private configureMqtt(): void {

    if(!this.nvr.hasFeature("NVR.SystemInfo")) {

      return;
    }

    // Return the controller's current system information.
    this.subscribeGet(mqttTopics.systeminfo.topic, mqttTopics.systeminfo.label, () => JSON.stringify(this.nvr.ufp.systemInfo));
  }
}
