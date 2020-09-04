/* Copyright(C) 2017-2020, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-liveviews.ts: Liveviews class for UniFi Protect.
 */
import {
  CharacteristicEventTypes,
  CharacteristicGetCallback,
  CharacteristicSetCallback,
  CharacteristicValue,
  PlatformAccessory
} from "homebridge";
import { ProtectBase } from "./protect-accessory";
import { ProtectNvr } from "./protect-nvr";
import { ProtectSecuritySystem } from "./protect-securitysystem";
import {
  ProtectCameraConfig,
  ProtectNvrLiveviewConfig
} from "./protect-types";
import {
  PLATFORM_NAME,
  PLUGIN_NAME
} from "./settings";

export class ProtectLiveviews extends ProtectBase {
  private isMqttConfigured: boolean;
  private liveviews: ProtectNvrLiveviewConfig[] | undefined;
  private liveviewSwitches: PlatformAccessory[];

  private securityAccessory: PlatformAccessory | null | undefined;
  private securitySystem: ProtectSecuritySystem | null;

  // Configure our liveviews capability.
  constructor(nvr: ProtectNvr) {

    // Let the base class get us set up.
    super(nvr);

    // Initialize the class.
    this.isMqttConfigured = false;
    this.liveviews = this.nvrApi?.bootstrap?.liveviews;
    this.liveviewSwitches = [];
    this.securityAccessory = null;
    this.securitySystem = null;
  }

  // Update security system accessory.
  public configureLiveviews(): void {

    // Do we have controller access?
    if(!this.nvrApi.bootstrap?.nvr) {
      return;
    }

    this.liveviews = this.nvrApi.bootstrap.liveviews;

    this.configureSecuritySystem();
    this.configureSwitches();
    this.configureMqtt();
  }

  // Configure the security system accessory.
  private configureSecuritySystem(): void {

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
  private configureSwitches(): void {

    // If we don't have any liveviews or the bootstrap configuration, there's nothing to configure.
    if(!this.liveviews || !this.nvrApi.bootstrap) {
      return;
    }

    // Iterate through the list of switches and see if we still have matching liveviews.
    for(const liveviewSwitch of this.liveviewSwitches) {
      // We found a switch matching this liveview. Move along...
      if(this.liveviews.some((x: ProtectNvrLiveviewConfig) => x.name.toUpperCase() === ("Protect-" + (liveviewSwitch.context?.liveview as string)).toUpperCase())) {
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
      if(this.liveviewSwitches.some((x: PlatformAccessory) => (x.context?.liveview as string).toUpperCase() === viewName.toUpperCase())) {
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

  // Configure MQTT capabilities for the security system.
  private configureMqtt(): void {

    if(this.isMqttConfigured || !this.nvrApi.bootstrap?.nvr.mac) {
      return;
    }

    this.isMqttConfigured = true;

    // Return the current status of all the liveviews.
    this.nvr.mqtt?.subscribe(this.nvrApi.bootstrap?.nvr.mac, "liveviews/get", (message: Buffer) => {

      const value = message.toString().toLowerCase();

      // When we get the right message, we return the list of liveviews.
      if(value !== "true") {
        return;
      }

      // Get the list of liveviews.
      const liveviews = this.liveviewSwitches.map(x =>
        ({ name: x.context.liveview as string, state: x.getService(this.hap.Service.Switch)?.getCharacteristic(this.hap.Characteristic.On).value }));

      this.nvr.mqtt?.publish(this.nvrApi.bootstrap?.nvr.mac ?? "", "liveviews", JSON.stringify(liveviews));
      this.log("%s: Liveview scenes list published via MQTT.", this.name());
    });

    // Set the status of one or more liveviews.
    this.nvr.mqtt?.subscribe(this.nvrApi.bootstrap?.nvr.mac, "liveviews/set", (message: Buffer) => {

      interface mqttLiveviewJSON {
        name: string,
        state: boolean
      }

      let incomingPayload;

      // Catch any errors in parsing what we get over MQTT.
      try {
        incomingPayload = JSON.parse(message.toString()) as mqttLiveviewJSON[];

        // Sanity check what comes in from MQTT to make sure it's what we want.
        if(!(incomingPayload instanceof Array)) {
          throw new Error("The JSON object is not in the expected format");
        }

      } catch(error) {

        if(error instanceof SyntaxError) {
          this.log("%s: Unable to process MQTT liveview setting: \"%s\". Error: %s.", this.name(), message.toString(), error.message);
        } else {
          this.log("%s: Unknown error has occurred: %s.", this.name(), error);
        }

        // Errors mean that we're done now.
        return;
      }

      // Update state on the liveviews.
      for(const entry of incomingPayload) {

        // Lookup this liveview.
        const accessory = this.liveviewSwitches.find((x: PlatformAccessory) => ((x.context?.liveview as string) ?? "").toUpperCase() === entry.name?.toUpperCase());

        // If we can't find it, move on.
        if(!accessory) {
          continue;
        }

        // Set the switch state and update the switch in HomeKit.
        this.setSwitchState(accessory, entry.state);
        accessory.getService(this.hap.Service.Switch)?.getCharacteristic(this.hap.Characteristic.On).updateValue(accessory.context.switchState);
        this.log("%s: Liveview scene updated via MQTT: %s.", this.name(), accessory.context.liveview);
      }
    });
  }

  // Get the current liveview switch state.
  private getSwitchState(accessory: PlatformAccessory, callback: CharacteristicGetCallback): void {
    callback(null, accessory.context.switchState);
  }

  // Toggle the liveview switch state.
  private setSwitchState(liveviewSwitch: PlatformAccessory, value: CharacteristicValue, callback?: CharacteristicSetCallback): void {

    // We don't have any liveviews or we're already at this state - we're done.
    if(!this.nvrApi.bootstrap || !this.liveviews || (liveviewSwitch.context.switchState === value)) {

      if(callback) {
        callback(null);
      }

      return;
    }

    // Get the complete list of cameras in the liveview we're interested in.
    // This cryptic line grabs the list of liveviews that have the name we're interested in
    // (turns out, you can define multiple liveviews in Protect with the same name...who knew!),
    // and then create a single list containing all of the cameras found.
    const targetCameraIds = this.liveviews.filter(view => view.name.toUpperCase() === ("Protect-" + (liveviewSwitch.context.liveview as string)).toUpperCase())
      .map(view => view.slots.map(slots => slots.cameras))
      .flat(2);

    // Nothing configured for this view. We're done.
    if(!targetCameraIds.length) {

      if(callback) {
        callback(null);
      }

      return;
    }

    // Iterate through the list of accessories and set the Protect scene.
    for(const targetAccessory of this.platform.accessories) {
      // We only want accessories associated with this Protect controller.
      if(!targetAccessory.context?.camera || targetAccessory.context.nvr !== this.nvrApi.bootstrap.nvr.mac) {
        continue;
      }

      // Check to see if this is one of the cameras we want to toggle motion detection for and the state is changing.
      if(targetCameraIds.some(thisCameraId =>
        thisCameraId === (targetAccessory.context.camera as ProtectCameraConfig).id) && (targetAccessory.context.detectMotion !== value)) {

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

    if(callback) {
      callback(null);
    }

    // Publish to MQTT, if configured.
    this.nvr.mqtt?.publish(this.nvrApi.bootstrap?.nvr.mac ?? "", "liveviews",
      JSON.stringify([{name: liveviewSwitch.context.liveview as string, state: liveviewSwitch.context.switchState as boolean}]));
  }
}
