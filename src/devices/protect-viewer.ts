/* Copyright(C) 2019-2024, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-viewer.ts: Viewer device class for UniFi Protect.
 */
import { CharacteristicValue, PlatformAccessory, Service } from "homebridge";
import { ProtectEventPacket, ProtectViewerConfig, ProtectViewerConfigPayload } from "unifi-protect";
import { Nullable } from "homebridge-plugin-utils";
import { ProtectDevice } from "./protect-device.js";
import { ProtectNvr } from "../protect-nvr.js";

export class ProtectViewer extends ProtectDevice {

  public ufp: ProtectViewerConfig;

  // Create an instance.
  constructor(nvr: ProtectNvr, device: ProtectViewerConfig, accessory: PlatformAccessory) {

    super(nvr, accessory);

    this.ufp = device;

    this.configureHints();
    this.configureDevice();
  }

  // Initialize and configure the viewer accessory for HomeKit.
  private configureDevice(): boolean {

    // Clean out the context object in case it's been polluted somehow.
    this.accessory.context = {};
    this.accessory.context.mac = this.ufp.mac;
    this.accessory.context.nvr = this.nvr.ufp.mac;

    // Configure accessory information.
    this.configureInfo();

    // Configure accessory services.
    const enabledLiveviews = this.updateDevice(true);

    // Configure MQTT services.
    this.configureMqtt();

    // Listen for events.
    this.nvr.events.on("updateEvent." + this.ufp.id, this.listeners["updateEvent." + this.ufp.id] = this.eventHandler.bind(this));

    // Inform the user what we're enabling on startup.
    if(enabledLiveviews.length) {

      this.log.info("Configured liveview%s: %s.", enabledLiveviews.length > 1 ? "s" : "", enabledLiveviews.join(", "));
    }  else {

      this.log.info("No liveviews configured.");
    }

    return true;
  }

  // Update accessory services and characteristics.
  public updateDevice(configureHandlers = false): string[] {

    // Grab the current list of liveview switches we know about.
    const currentLiveviewSwitches = this.accessory.services.filter(x => (x.UUID === this.hap.Service.Switch.UUID) && x.subtype);

    // Grab the current list of liveview identifiers from Protect.
    const nvrLiveviewIds = this.ufpApi.bootstrap?.liveviews?.map(x => x.id);

    // Identify what's been removed on the NVR and remove it from the accessory as well.
    currentLiveviewSwitches.filter(x => !nvrLiveviewIds?.includes(x.subtype ?? "")).map(x => this.accessory.removeService(x));

    // Identify what needs to be added to HomeKit that isn't already there, and add them.
    this.addLiveviewSwitch(nvrLiveviewIds?.filter(x => !currentLiveviewSwitches.filter(liveviewSwitch => liveviewSwitch.subtype === x).length) ?? []);

    // Finally, reflect the state of the liveview that's currently enabled. We loop through the list of services on our viewer accessory and sync the liveview switches.
    this.updateLiveviewSwitchState(configureHandlers);

    // Return a list of our available liveviews for this device.
    return this.accessory.services.filter(x => (x.UUID === this.hap.Service.Switch.UUID) && x.subtype).map(x => x.displayName);
  }

  // Update the state of liveview switches for viewer devices.
  private updateLiveviewSwitchState(configureHandlers = false): boolean {

    for(const switchService of this.accessory.services) {

      // We only want to look at switches.
      if(switchService.UUID !== this.hap.Service.Switch.UUID) {

        continue;
      }

      // We only want switches with subtypes.
      if(!switchService.subtype) {

        continue;
      }

      // Configure the switch and update the state.
      this.configureLiveviewSwitch(switchService, configureHandlers);
    }

    return true;
  }

  // Configure the state and handlers of a liveview switch.
  private configureLiveviewSwitch(switchService: Service, configureHandlers = true): boolean {

    // If we're configuring a switch for the first time, we add our respective handlers.
    if(configureHandlers) {

      // Turn the liveview switch on or off.
      switchService.getCharacteristic(this.hap.Characteristic.On)?.onGet(() => {

        return this.getLiveviewSwitchState(switchService);
      });

      switchService.getCharacteristic(this.hap.Characteristic.On)?.onSet(async (value: CharacteristicValue) => {

        return this.setLiveviewSwitchState(switchService, value);
      });
    }

    // Set the state to reflect Protect.
    switchService.updateCharacteristic(this.hap.Characteristic.On, switchService.subtype === this.ufp.liveview);

    return true;
  }

  // Return the current state of the liveview switch.
  private getLiveviewSwitchState(switchService: Service): CharacteristicValue {

    return (this.ufp.liveview !== null) && (this.ufp.liveview === switchService.subtype);
  }

  // Set the current state of the liveview switch.
  private async setLiveviewSwitchState(switchService: Service, value: CharacteristicValue): Promise<void> {

    const viewState = value === true ? switchService.subtype as string : null;
    const newDevice = await this.setViewer(viewState);

    if(!newDevice) {

      if(viewState) {

        this.log.error("Unable to set the liveview to: %s.", switchService.displayName);

      } else {

        this.log.error("Unable to clear the liveview.");

      }

      return;
    }

    // Set the context to our updated device configuration.
    this.ufp = newDevice;

    // Update all the other liveview switches.
    this.updateLiveviewSwitchState();
  }

  // Add liveview switches to HomeKit for viewer devices.
  private addLiveviewSwitch(newLiveviewIds: string[]): boolean {

    // Loop through the list of liveview identifiers and add them to HomeKit as switches.
    for(const liveviewId of newLiveviewIds) {

      // Empty or invalid liveview identifier.
      if(!liveviewId) {

        continue;
      }

      // Retrieve the name assigned to this liveview.
      const liveviewName = this.ufpApi.bootstrap?.liveviews?.find(x => x.id === liveviewId)?.name;

      // Acquire the service.
      const service = this.acquireService(this.hap.Service.Switch, liveviewName, liveviewId);

      // Fail gracefully.
      if(!service) {

        this.log.error("Unable to add liveview switch: %s.", liveviewName);

        return false;
      }

      this.configureLiveviewSwitch(service);
    }

    return true;
  }

  // Set the liveview on a viewer device in UniFi Protect.
  private async setViewer(newLiveview: Nullable<string>): Promise<ProtectViewerConfig> {

    // Set the liveview.
    const newDevice = (await this.nvr.ufpApi.updateDevice(this.ufp, { liveview: newLiveview })) as ProtectViewerConfig;

    // Find the liveview name for MQTT.
    const liveview =  this.ufpApi.bootstrap?.liveviews?.find(x => x.id === newLiveview);

    // Publish an MQTT event.
    if(liveview) {

      this.publish("liveview", liveview.name);
    }

    return newDevice;
  }

  // Configure MQTT capabilities of this viewer.
  private configureMqtt(): boolean {

    // Trigger a motion event in MQTT, if requested to do so.
    this.subscribeGet("liveview", "liveview", () => {

      return this.ufpApi.bootstrap?.liveviews?.find(x => x.id === this.ufp.liveview)?.name ?? "None";
    });

    // Trigger a motion event in MQTT, if requested to do so.
    this.subscribeSet("liveview", "liveview", async (value: string) => {

      const liveview = this.ufpApi.bootstrap?.liveviews?.find(x => x.name.toLowerCase() === value);

      if(!liveview) {

        this.log.error("Unable to locate a liveview named %s.", value);

        return;
      }

      const newDevice = await this.setViewer(liveview.id);

      if(!newDevice) {

        this.log.error("Unable to set liveview via MQTT to %s.", value);

        return;
      }

      this.ufp = newDevice;
      this.log.info("Liveview set via MQTT to %s.", liveview.name);
    });

    return true;
  }

  // Handle viewer-related events.
  private eventHandler(packet: ProtectEventPacket): void {

    const payload = packet.payload as ProtectViewerConfigPayload;

    // It's a liveview update event - process it accordingly.
    if(payload.liveview) {

      this.updateDevice();
    }
  }
}
