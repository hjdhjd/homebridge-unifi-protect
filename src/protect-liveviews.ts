/* Copyright(C) 2017-2020, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-liveviews.ts: Liveviews class for UniFi Protect.
 */
import {
  API,
  CharacteristicEventTypes,
  CharacteristicGetCallback,
  CharacteristicSetCallback,
  CharacteristicValue,
  HAP,
  Logging,
  PlatformAccessory
} from "homebridge";
import { ProtectApi } from "./protect-api";
import { ProtectNvr } from "./protect-nvr";
import { ProtectPlatform } from "./protect-platform";
import { ProtectSecuritySystem } from "./protect-securitysystem";
import {
  ProtectNvrLiveviewConfig,
  ProtectNvrOptions
} from "./protect-types";
import {
  PLATFORM_NAME,
  PLUGIN_NAME
} from "./settings";

export class ProtectLiveviews {
  private api: API;
  private config: ProtectNvrOptions;
  private debug: (message: string, ...parameters: any[]) => void;
  private hap: HAP;
  private liveviews: ProtectNvrLiveviewConfig[] | undefined;
  private liveviewSwitches: PlatformAccessory[];
  private log: Logging;
  private nvr: ProtectNvr;
  private nvrApi: ProtectApi;
  private platform: ProtectPlatform;
  private securityAccessory: PlatformAccessory | null | undefined;
  private securitySystem: ProtectSecuritySystem | null;

  // Create an instance of our liveviews capability.
  constructor(protectNvr: ProtectNvr) {
    this.api = protectNvr.platform.api;
    this.config = protectNvr.config;
    this.debug = protectNvr.platform.debug.bind(protectNvr.platform);
    this.hap = protectNvr.platform.api.hap;
    this.liveviews = protectNvr.nvrApi?.bootstrap?.liveviews;
    this.liveviewSwitches = [];
    this.log = protectNvr.platform.log;
    this.nvr = protectNvr;
    this.nvrApi = protectNvr.nvrApi;
    this.platform = protectNvr.platform;
    this.securityAccessory = null;
    this.securitySystem = null;
  }

  // Update security system accessory.
  public async configureLiveviews(): Promise<void> {

    // Do we have controller access?
    if(!this.nvrApi?.bootstrap?.nvr) {
      return;
    }

    this.liveviews = this.nvrApi.bootstrap.liveviews;

    this.configureSecuritySystem();
    this.configureSwitches();
  }

  // Configure the security system accessory.
  private async configureSecuritySystem(): Promise<void> {

    // If we don't have the bootstrap configuration, we're done here.
    if(!this.nvrApi.bootstrap) {
      return;
    }

    const reLiveviewScene = /^Protect-(Away|Home|Night|Off)$/i;
    const uuid = this.hap.uuid.generate(this.nvrApi.bootstrap.nvr.mac + ".Security");

    // If the user removed the last Protect-centric liveview for the security system, we remove the security system accessory.
    if(!this.liveviews?.some((x: ProtectNvrLiveviewConfig) => reLiveviewScene.test(x.name))) {
      const oldAccessory = this.platform.accessories.find((x: PlatformAccessory) => x.UUID === uuid);

      if(oldAccessory) {
        this.log("%s: No plugin-specific liveviews found. Disabling the security system accessory associated with this UniFi Protect controller.",
          this.nvrApi.getNvrName());

        // Unregister the accessory and delete it's remnants from HomeKit and the plugin.
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [oldAccessory]);
        this.platform.accessories.splice(this.platform.accessories.indexOf(oldAccessory), 1);
      }

      this.securityAccessory = null;
      this.securitySystem = null;
      return;
    }

    // Create the security system accessory if it doesn't already exist.
    if(!this.securityAccessory) {
      // See if we already have this accessory defined.
      if((this.securityAccessory = this.platform.accessories.find((x: PlatformAccessory) => x.UUID === uuid)) === undefined) {
        // We will use the NVR MAC address + ".Security" to create our UUID. That should provide guaranteed uniqueness we need.
        this.securityAccessory = new this.api.platformAccessory(this.nvrApi.bootstrap.nvr.name, uuid);

        // Register this accessory with homebridge and add it to the platform accessory array so we can track it.
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [this.securityAccessory]);
        this.platform.accessories.push(this.securityAccessory);
      }

      if(!this.securityAccessory) {
        this.log("%s: Unable to create the security system accessory.", this.nvrApi.getNvrName());
        return;
      }

      this.log("%s: Plugin-specific liveviews have been detected. Enabling the security system accessory.", this.nvrApi.getNvrName());
    }

    // We have the security system accessory, now let's configure it.
    if(!this.securitySystem) {
      this.securitySystem = new ProtectSecuritySystem(this.nvr, this.securityAccessory);

      if(!this.securitySystem) {
        this.log("%s: Unable to configure the security system accessory.", this.nvrApi.getNvrName());
        return;
      }
    }

    // Update our NVR reference.
    this.securityAccessory.context.nvr = this.nvrApi.bootstrap.nvr.mac;
  }

  // Configure any liveview-associated switches.
  private async configureSwitches(): Promise<void> {

    // If we don't have any liveviews or the bootstrap configuration, there's nothing to configure.
    if(!this.liveviews || !this.nvrApi.bootstrap) {
      return;
    }

    // Iterate through the list of switches and see if we still have matching liveviews.
    for(const liveviewSwitch of this.liveviewSwitches) {
      // We found a switch matching this liveview. Move along...
      if(this.liveviews.some((x: ProtectNvrLiveviewConfig) => x.name.toUpperCase() === ("Protect-" + liveviewSwitch.context?.liveview).toUpperCase())) {
        continue;
      }

      // The switch has no associated liveview - let's get rid of it.
      this.log("%s: The plugin-specific liveview %s has been removed or renamed. Removing the switch associated with this liveview.",
        this.nvrApi.getNvrName(), liveviewSwitch.context.liveview);

      // Unregister the accessory and delete it's remnants from HomeKit and the plugin.
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [liveviewSwitch]);
      this.platform.accessories.splice(this.platform.accessories.indexOf(liveviewSwitch), 1);
      this.liveviewSwitches.splice(this.liveviewSwitches.indexOf(liveviewSwitch), 1);
    }

    // Check for any new plugin-specific liveviews.
    for(const liveview of this.liveviews) {
      const reLiveviewScene = /^Protect-((?!Away$|Off$|Home$|Night$).+)$/i;

      // Only match on views beginning with Protect- that are not reserved for the security system.
      const viewMatch = liveview.name.match(reLiveviewScene);

      // No match found, we're not interested in it.
      if(!viewMatch) {
        continue;
      }

      // Grab the name of our new switch for reference.
      const viewName = viewMatch[1];

      // See if we already have this accessory defined.
      if(this.liveviewSwitches.some((x: PlatformAccessory) => x.context?.liveview.toUpperCase() === viewName.toUpperCase())) {
        continue;
      }

      // We use the NVR MAC address + ".Liveview." + viewname to create our unique UUID for our switches.
      const uuid = this.hap.uuid.generate(this.nvrApi.bootstrap.nvr.mac + ".Liveview." + viewName.toUpperCase());

      // Check to see if the accessory already exists before we create it.
      let newAccessory;

      if((newAccessory = this.platform.accessories.find((x: PlatformAccessory) => x.UUID === uuid)) === undefined) {

        newAccessory = new this.api.platformAccessory(this.nvrApi.bootstrap.nvr.name + " " + viewName, uuid);

        // Register this accessory with homebridge and add it to the platform accessory array so we can track it.
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [newAccessory]);
        this.platform.accessories.push(newAccessory);
      }

      if(!newAccessory) {
        this.log("%s: Unable to create the switch for liveview: %s.", this.nvrApi.getNvrName(), viewName);
        return;
      }

      // Configure our accessory.
      newAccessory.context.liveview = viewName;
      newAccessory.context.nvr = this.nvrApi.bootstrap.nvr.mac;
      newAccessory.context.switchState = false;
      this.liveviewSwitches.push(newAccessory);

      // Clear out any previous switch service.
      let switchService = newAccessory.getService(this.hap.Service.Switch);

      if(switchService) {
        newAccessory.removeService(switchService);
      }

      // Add the switch to the accessory.
      switchService = new this.hap.Service.Switch(newAccessory.displayName);

      // Activate or deactivate motion detection.
      newAccessory.addService(switchService)
        .getCharacteristic(this.hap.Characteristic.On)
        ?.on(CharacteristicEventTypes.GET, this.getSwitchState.bind(this, newAccessory))
        .on(CharacteristicEventTypes.SET, this.setSwitchState.bind(this, newAccessory))
        .updateValue(newAccessory.context.switchState);

      this.log("%s: Plugin-specific liveview %s has been detected. Configuring a switch accessory for it.", this.nvrApi.getNvrName(), viewName);
    }
  }

  // Get the current liveview switch state.
  private async getSwitchState(accessory: PlatformAccessory, callback: CharacteristicGetCallback): Promise<void> {
    callback(null, accessory.context.switchState);
  }

  // Toggle the liveview switch state.
  private async setSwitchState(liveviewSwitch: PlatformAccessory, value: CharacteristicValue, callback: CharacteristicSetCallback): Promise<void> {

    // We don't have any liveviews or we're already at this state - we're done.
    if(!this.nvrApi.bootstrap || !this.liveviews || (liveviewSwitch.context.switchState === value)) {
      callback(null);
      return;
    }

    // Get the complete list of cameras in the liveview we're interested in.
    // This cryptic line grabs the list of liveviews that have the name we're interested in
    // (turns out, you can define multiple liveviews in Protect with the same name...who knew!),
    // and then create a single list containing all of the cameras found.
    const targetCameraIds = this.liveviews.filter(view => view.name.toUpperCase() === ("Protect-" + liveviewSwitch.context.liveview).toUpperCase())
      .map(view => view.slots.map(slots => slots.cameras))
      .flat(2);

    // Nothing configured for this view. We're done.
    if(!targetCameraIds.length) {
      callback(null);
      return;
    }

    // Iterate through the list of accessories and set the Protect scene.
    for(const targetAccessory of this.platform.accessories) {
      // We only want accessories associated with this Protect controller.
      if(!targetAccessory.context?.camera || targetAccessory.context.nvr !== this.nvrApi.bootstrap.nvr.mac) {
        continue;
      }

      // Check to see if this is one of the cameras we want to toggle motion detection for and the state is changing.
      if(targetCameraIds.some(thisCameraId => thisCameraId === targetAccessory.context.camera.id) && (targetAccessory.context.detectMotion !== value)) {

        targetAccessory.context.detectMotion = value;

        // Update the switch service, if present.
        const motionSwitch = targetAccessory.getService(this.hap.Service.Switch);

        if(motionSwitch) {
          motionSwitch.getCharacteristic(this.hap.Characteristic.On)?.updateValue(targetAccessory.context.detectMotion);
        }

        this.log("%s: %s -> %s: Motion detection %s.", this.nvrApi.getNvrName(), liveviewSwitch.context.liveview, targetAccessory.displayName,
          targetAccessory.context.detectMotion === true ? "enabled" : "disabled");
      }
    }

    liveviewSwitch.context.switchState = value === true;
    callback(null);
  }
}
