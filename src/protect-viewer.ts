/* Copyright(C) 2019-2022, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-viewer.ts: Viewer device class for UniFi Protect.
 */
import { CharacteristicValue, Service } from "homebridge";
import { ProtectAccessory } from "./protect-accessory";
import { ProtectViewerConfig } from "unifi-protect";

export class ProtectViewer extends ProtectAccessory {

  // Initialize and configure the viewer accessory for HomeKit.
  protected async configureDevice(): Promise<boolean> {

    // Save the device object before we wipeout the context.
    const device = this.accessory.context.device as ProtectViewerConfig;

    // Clean out the context object in case it's been polluted somehow.
    this.accessory.context = {};
    this.accessory.context.device = device;
    this.accessory.context.nvr = this.nvr.nvrApi.bootstrap?.nvr.mac;

    // Configure accessory information.
    this.configureInfo();

    // Configure accessory services.
    const enabledLiveviews = this.updateDevice(true);

    // Configure MQTT services.
    this.configureMqtt();

    // Inform the user what we're enabling on startup.
    if(enabledLiveviews.length) {
      this.log.info("%s: Configured liveview%s: %s.", this.name(), enabledLiveviews.length > 1 ? "s" : "", enabledLiveviews.join(", "));
    }  else {
      this.log.info("%s: No liveviews configured.", this.name());
    }

    return Promise.resolve(true);
  }

  // Update accessory services and characteristics.
  public updateDevice(configureHandlers = false): string[] {

    // Grab the current list of liveview switches we know about.
    const currentLiveviewSwitches = this.accessory.services.filter(x => (x.UUID === this.hap.Service.Switch.UUID) && x.subtype);

    // Grab the current list of liveview identifiers from Protect.
    const nvrLiveviewIds = this.nvrApi?.bootstrap?.liveviews?.map(x => x.id);

    // Identify what's been removed on the NVR and remove it from the accessory as well.
    currentLiveviewSwitches.filter(x => !nvrLiveviewIds?.includes(x.subtype ?? "")).map(x => this.accessory.removeService(x));

    // Identify what needs to be added to HomeKit that isn't already there, and add them.
    this.addLiveviewSwitch(nvrLiveviewIds?.filter(x => !currentLiveviewSwitches.filter(liveviewSwitch => liveviewSwitch.subtype === x).length) ?? []);

    // Finally, reflect the state of the liveview that's currently enabled.
    // Loop through the list of services on our viewer accessory and sync the liveview switches.
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
      switchService.getCharacteristic(this.hap.Characteristic.On)
        ?.onGet(() => {
          return this.getLiveviewSwitchState(switchService);
        })
        .onSet((value: CharacteristicValue) => {
          return this.setLiveviewSwitchState(switchService, value);
        });
    }

    // Set the state to reflect Protect.
    switchService.updateCharacteristic(this.hap.Characteristic.On, switchService.subtype === (this.accessory.context.device as ProtectViewerConfig).liveview);

    return true;
  }

  // Return the current state of the liveview switch.
  private getLiveviewSwitchState(switchService: Service): CharacteristicValue {

    return ((this.accessory.context.device as ProtectViewerConfig).liveview !== null) &&
      ((this.accessory.context.device as ProtectViewerConfig).liveview === switchService.subtype);
  }

  // Set the current state of the liveview switch.
  private async setLiveviewSwitchState(switchService: Service, value: CharacteristicValue): Promise<void> {

    const viewState = value === true ? switchService.subtype as string : null;
    const newDevice = await this.setViewer(viewState);

    if(!newDevice) {

      if(viewState) {

        this.log.error("%s: Unable to set the liveview to: %s.", this.name(), switchService.displayName);

      } else {

        this.log.error("%s: Unable to clear the liveview.", this.name());

      }

      return;
    }

    // Set the context to our updated device configuration.
    this.accessory.context.device = newDevice;

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
      const liveviewName = this.nvrApi?.bootstrap?.liveviews?.find(x => x.id === liveviewId)?.name;

      // Grab the switch service associated with this liveview.
      const switchService = new this.hap.Service.Switch(liveviewName, liveviewId);

      if(!switchService) {

        this.log.error("%s: Unable to add liveview switch for %s.", this.name(), liveviewName);
        continue;
      }

      this.accessory.addService(switchService);
      this.configureLiveviewSwitch(switchService);
    }

    return true;
  }

  // Set the liveview on a viewer device in UniFi Protect.
  private async setViewer(newLiveview: string | null): Promise<ProtectViewerConfig> {

    // Set the liveview.
    const newDevice = (await this.nvr.nvrApi.updateViewer(this.accessory.context.device as ProtectViewerConfig, { liveview: newLiveview })) as ProtectViewerConfig;

    // Find the liveview name for MQTT.
    const liveview =  this.nvrApi?.bootstrap?.liveviews?.find(x => x.id === newLiveview);

    // Publish an MQTT event.
    if(liveview) {

      this.nvr.mqtt?.publish(this.accessory, "liveview", liveview.name);
    }

    return newDevice;
  }

  // Configure MQTT capabilities of this viewer.
  private configureMqtt(): boolean {

    // Trigger a motion event in MQTT, if requested to do so.
    this.nvr.mqtt?.subscribe(this.accessory, "liveview/set", (message: Buffer) => {

      const value = message.toString().toLowerCase();

      const liveview = this.nvrApi?.bootstrap?.liveviews?.find(x => x.name.toLowerCase() === value);

      if(!liveview) {
        this.log.error("%s: Unable to locate a liveview named %s.", this.name(), message.toString());
        return;
      }

      (async (): Promise<void> => {

        const newDevice = await this.setViewer(liveview.id);

        if(newDevice) {

          this.accessory.context.device = newDevice;
          this.log.info("%s: Liveview set via MQTT to %s.", this.name(), liveview.name);

        } else {

          this.log.error("%s: Unable to set liveview via MQTT to %s.", this.name(), message.toString());
        }

      })();
    });

    // Trigger a motion event in MQTT, if requested to do so.
    this.nvr.mqtt?.subscribeGet(this.accessory, this.name(), "liveview", "Liveview", () => {

      const liveview =  this.nvrApi?.bootstrap?.liveviews?.find(x => x.id === (this.accessory.context.device as ProtectViewerConfig).liveview);

      return liveview?.name ?? "None";
    });

    return true;
  }
}
