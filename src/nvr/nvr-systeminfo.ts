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
import { isolateAccessoryChange } from "./nvr-accessory-change.ts";
import { mqttTopics } from "../mqtt.ts";
import { selectNvr } from "unifi-protect";

/* Represents the NVR controller's system information as a controller-owned accessory, not a device-backed one. It creates and keys its own accessory directly
 * from the controller's MAC address (the MAC plus ".NVRSystemInfo") rather than receiving one from device discovery, and its lifetime is the whole controller
 * connection: nothing invokes the cleanup() it inherits from the spine, because the accessory lives and dies with the controller and the controller's own shutdown
 * ends this owner's composed lifetime. That inherited method is reachable in principle, so a caller that invoked it would sever exactly this owner's observer and MQTT
 * registrations while the controller kept running - the accepted price of giving every owner the same lifecycle machinery. After its configure pass, its only source
 * of reactivity is the systemInfo observer set up there, which refreshes the temperature sensor whenever the controller's system information changes. Turning off the
 * feature option removes the accessory outright rather than merely hiding it.
 */
export class ProtectNvrSystemInfo extends ProtectBase {

  private accessory: Nullable<ProtectAccessory> | undefined;
  private isConfigured: boolean;

  // Create an instance.
  constructor(nvr: ProtectNvr) {

    // Let the base class get us set up.
    super(nvr);

    // Initialize the class. configure() below owns the initial configuration; subsequent refreshes are driven by this owner's own narrow observer.
    this.accessory = null;
    this.isConfigured = false;
  }

  // Configure our NVR sensor capability.
  public override configure(): void {

    this.configureAccessory();
    this.configureMqtt();

    // Subject owns its reactivity: observe the controller record's systemInfo slice and refresh the temperature sensor on each change. The narrow selector wakes only on
    // a systemInfo change - never on the lastSeen/storage churn the whole NVR record carries - and the store yields only on change, so the initial pass above stands
    // on its own and this loop handles only subsequent updates. It binds to the controller lifetime (ProtectBase.observeSignal) and re-reads through this.nvr.ufp
    // rather than trusting the yielded slice.
    this.observeState({ key: "nvr.systemInfo", selector: state => selectNvr(state)?.systemInfo, title: "system information" },
      () => this.updateDevice({ initialized: true }));
  }

  // Configure the NVR system information accessory.
  private configureAccessory(): void {

    // We've already configured our system information, we're done.
    if(this.isConfigured) {

      return;
    }

    this.platform.featureOptions.logFeature({ controller: { id: this.nvr.ufp.mac, log: this.nvr.log }, label: "System information sensors", log: this.platform.pluginLog,
      option: "NVR.SystemInfo" });

    const uuid = this.hap.uuid.generate(this.nvr.ufp.mac + ".NVRSystemInfo");

    // See if we already have this accessory defined.
    if(!this.accessory) {

      if((this.accessory = this.platform.accessories.find(x => x.UUID === uuid)) === undefined) {

        this.accessory = null;
      }
    }

    /* If we've disabled NVR system information, remove the accessory if it exists, and otherwise add it. Each branch runs its change to HomeKit through the shared
     * isolation, so a removal or an add that throws is said once and the controller's login() goes on to its devices and its liveviews rather than ending there.
     * Nothing constructs this owner again while the controller runs, so a failed change is retried at the next restart.
     */
    if(!this.nvr.hasFeature("NVR.SystemInfo")) {

      if(this.accessory) {

        const accessory = this.accessory;

        this.log.info("Removing UniFi Protect controller system information sensors.");

        // Remove the accessory through the controller root's shared removal tail, which drops any save still pending for it, takes it off the bridge, and forgets it.
        isolateAccessoryChange({ act: "remove", change: () => this.nvr.removeAccessoryFromHomeKit(accessory), log: this.log, name: "the system information sensors" });
      }

      this.accessory = null;
      this.isConfigured = true;

      return;
    }

    isolateAccessoryChange({ act: "add", change: () => this.#addAccessory(uuid), log: this.log, name: "the system information sensors" });
  }

  // Find or create the system information accessory, registering one it creates, and configure the sensors on it. The accessory is held only once its registration
  // returns, so a registration that throws leaves none held, and this owner's observer refreshes no sensor on an accessory HomeKit never took.
  #addAccessory(uuid: string): void {

    // Create the accessory if it doesn't already exist.
    if(!this.accessory) {

      // We will use the NVR MAC address + ".NVRSystemInfo" to create our UUID. That should provide the guaranteed uniqueness we need.
      const accessory = new this.api.platformAccessory<ProtectAccessoryContext>(deviceDisplayName(this.nvr.ufp), uuid);

      // Register this accessory with homebridge and add it to the platform accessory array so we can track it.
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.platform.accessories.push(accessory);
      this.accessory = accessory;
    }

    // We have the system information accessory, now let's configure it. We clean out the context object in case it's been polluted somehow, write our bookkeeping
    // into it, and mark the accessory, so the save that closes this window carries the context and the services this pass configures.
    this.accessory.context = {};
    this.platform.persistence.persist(this.accessory, { nvr: this.nvr.ufp.mac, systemInfo: true });

    // Configure accessory information.
    this.setInfo(this.accessory, this.nvr.ufp);

    // Configure accessory services.
    this.updateDevice({ initialized: false });

    this.isConfigured = true;
    this.platform.claimAccessory(this.accessory, this);
  }

  // Update accessory services and characteristics. Private: every caller is this class - configure()'s initial pass, which binds the handlers, and this owner's own
  // systemInfo observer, a later pass that refreshes the characteristic on each change.
  private updateDevice({ initialized }: Required<Pick<ProtectConfigurePass, "initialized">>): void {

    // Configure the temperature sensor.
    this.configureTemperatureSensor({ initialized });
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

      // We report the CPU temperature in whole degrees. Its ordinary jitter crosses HomeKit's default tenth-of-a-degree step several times a minute, and a tenth of a
      // degree tells no one anything useful about a controller's CPU. HAP rounds every value we push and every read it answers to the characteristic's step, which keeps
      // both the read below and the update that follows in whole degrees while MQTT carries the controller's full-precision reading.
      service.getCharacteristic(this.hap.Characteristic.CurrentTemperature).setProps({ minStep: 1 })
        .onGet(this.answering(() => this.nvr.ufp.systemInfo.cpu.temperature));
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
