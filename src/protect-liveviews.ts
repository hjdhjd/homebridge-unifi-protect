/* Copyright(C) 2017-2023, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-liveviews.ts: Liveviews class for UniFi Protect.
 */
import { CharacteristicValue, PlatformAccessory } from "homebridge";
import { PLATFORM_NAME, PLUGIN_NAME } from "./settings.js";
import { ProtectBase } from "./protect-device.js";
import { ProtectNvr } from "./protect-nvr.js";
import { ProtectNvrLiveviewConfig } from "unifi-protect";
import { ProtectSecuritySystem } from "./protect-securitysystem.js";

export class ProtectLiveviews extends ProtectBase {

  private isConfigured: { [index: string]: boolean };
  private isMqttConfigured: boolean;
  private liveviews: ProtectNvrLiveviewConfig[];
  private securityAccessory: PlatformAccessory | null | undefined;
  private securitySystem: ProtectSecuritySystem | null;

  // Configure our liveviews capability.
  constructor(nvr: ProtectNvr) {

    // Let the base class get us set up.
    super(nvr);

    // Initialize the class.
    this.isConfigured = {};
    this.isMqttConfigured = false;
    this.liveviews = this.ufpApi.bootstrap?.liveviews ?? [];
    this.securityAccessory = null;
    this.securitySystem = null;
  }

  // Update security system accessory.
  public configureLiveviews(): void {

    // Do we have controller access?
    if(!this.ufpApi.bootstrap?.nvr) {

      return;
    }

    this.liveviews = this.ufpApi.bootstrap.liveviews;

    this.configureSecuritySystem();
    this.configureSwitches();
    this.configureMqtt();
  }

  // Configure the security system accessory.
  private configureSecuritySystem(): void {

    // If we don't have the bootstrap configuration, we're done here.
    if(!this.ufpApi.bootstrap) {

      return;
    }

    const regexSecuritySystemLiveview = /^Protect-(Away|Home|Night|Off)$/i;
    const uuid = this.hap.uuid.generate(this.nvr.ufp.mac + ".Security");

    // If the user removed the last Protect-centric liveview for the security system, we remove the security system accessory.
    if(!this.liveviews?.some(x => regexSecuritySystemLiveview.test(x.name))) {

      if(this.securityAccessory) {

        this.log.info("No plugin-specific liveviews found. Disabling the security system accessory associated with this UniFi Protect controller.");

        // Unregister the accessory and delete it's remnants from HomeKit and the plugin.
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [this.securityAccessory]);
        this.platform.accessories.splice(this.platform.accessories.indexOf(this.securityAccessory), 1);
      }

      this.securityAccessory = null;
      this.securitySystem = null;
      return;
    }

    // Create the security system accessory if it doesn't already exist.
    if(!this.securityAccessory) {

      // See if we already have this accessory defined.
      if((this.securityAccessory = this.platform.accessories.find(x => x.UUID === uuid)) === undefined) {

        // We will use the NVR MAC address + ".Security" to create our UUID. That should provide the guaranteed uniqueness we need.
        this.securityAccessory = new this.api.platformAccessory(this.ufpApi.bootstrap.nvr.name, uuid);

        // Register this accessory with homebridge and add it to the platform accessory array so we can track it.
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [ this.securityAccessory ]);
        this.platform.accessories.push(this.securityAccessory);
      }

      if(!this.securityAccessory) {

        this.log.error("Unable to create the security system accessory.");
        return;
      }

      this.log.info("Plugin-specific liveviews have been detected. Enabling the security system accessory.");
    }

    // We have the security system accessory, now let's configure it.
    if(!this.securitySystem) {

      this.securitySystem = new ProtectSecuritySystem(this.nvr, this.securityAccessory);

      if(!this.securitySystem) {

        this.log.error("Unable to configure the security system accessory.");
        return;
      }
    }

    // Update our NVR reference.
    this.securityAccessory.context.nvr = this.nvr.ufp.mac;
  }

  // Configure any liveview-associated switches.
  private configureSwitches(): void {

    // If we don't have any liveviews or the bootstrap configuration, there's nothing to configure.
    if(!this.liveviews || !this.ufpApi.bootstrap) {

      return;
    }

    // Iterate through the list of accessories and remove any orphan liveviews due to removal or renaming on the Protect controller.
    for(const accessory of this.platform.accessories) {

      // We're only interested in liveview accessories.
      if(!("liveview" in accessory.context)) {

        continue;
      }

      // We found a switch matching this liveview. Move along...
      if(this.liveviews.some(x => x.name.toUpperCase() === ("Protect-" + (accessory.context.liveview as string)).toUpperCase())) {

        continue;
      }

      // The switch has no associated liveview - let's get rid of it.
      this.log.info("Removing plugin-specific liveview switch: %s. The liveview has been either removed or renamed in UniFi Protect.", accessory.context.liveview);

      // Unregister the accessory and delete it's remnants from HomeKit and the plugin.
      delete this.isConfigured[(accessory.context.liveview as string).toUpperCase()];
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [ accessory ]);
      this.platform.accessories.splice(this.platform.accessories.indexOf(accessory), 1);
    }

    // Initialize the regular expression here so we don't have to reinitialize it in each iteration below.
    const regexLiveview = /^Protect-((?!Away$|Off$|Home$|Night$).+)$/i;

    // Check for any new plugin-specific liveviews.
    for(const liveview of [...new Set(this.liveviews.map(x => x.name))]) {

      // Only match on views beginning with Protect- that are not reserved for the security system.
      const viewMatch = regexLiveview.exec(liveview);

      // No match found, we're not interested in it.
      if(!viewMatch) {

        continue;
      }

      // Grab the name of our new switch for reference.
      const viewName = viewMatch[1];

      // By design, we want to avoid configuring multiple liveview switches with the same name. Instead we combine all liveviews of the same name into a single switch.
      if(this.isConfigured[viewName.toUpperCase()]) {

        continue;
      }

      // We use the NVR MAC address + ".Liveview." + viewname to create our unique UUID for our switches.
      const uuid = this.hap.uuid.generate(this.nvr.ufp.mac + ".Liveview." + viewName.toUpperCase());

      // Check to see if the accessory already exists before we create it.
      let liveviewState = true;
      let newAccessory;

      if((newAccessory = this.platform.accessories.find(x => x.UUID === uuid)) === undefined) {

        newAccessory = new this.api.platformAccessory(this.ufpApi.bootstrap.nvr.name + " " + viewName, uuid);

        // Register this accessory with homebridge and add it to the platform accessory array so we can track it.
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [ newAccessory ]);
        this.platform.accessories.push(newAccessory);
      }

      if(!newAccessory) {

        this.log.error("Unable to create the switch for liveview: %s.", viewName);
        return;
      }

      // Configure our accessory.
      if("liveviewState" in newAccessory.context) {

        liveviewState = newAccessory.context.liveviewState as boolean;
      }

      newAccessory.context = {};
      newAccessory.context.liveview = viewName;
      newAccessory.context.liveviewState = liveviewState;
      newAccessory.context.nvr = this.nvr.ufp.mac;

      // Find the existing liveview switch, if we have one.
      let switchService = newAccessory.getService(this.hap.Service.Switch);

      // Add the liveview switch to the accessory.
      if(!switchService) {

        switchService = new this.hap.Service.Switch(newAccessory.displayName);

        if(!switchService) {

          this.log.error("Unable to create the switch for liveview: %s.", viewName);
          return;
        }

        newAccessory.addService(switchService);
      }

      // Activate or deactivate motion detection.
      switchService.getCharacteristic(this.hap.Characteristic.On)
        .onGet(this.getSwitchState.bind(this, newAccessory.context.liveview as string))
        .onSet(this.setSwitchState.bind(this, newAccessory));

      // Initialize the switch. We keep a saved liveview switch state because we want to account for edge cases where liveviews can disappear and we end up in a
      // situation where motion detection is disabled without a way to enable it. By saving the switch state on the accessory, we can always initialize all
      // motion-related accessories at startup as having motion enabled, and explicitly disable them here at startup when we restore state.
      switchService.updateCharacteristic(this.hap.Characteristic.On, newAccessory.context.liveviewState as boolean);
      this.setSwitchState(newAccessory, newAccessory.context.liveviewState as boolean);
      this.isConfigured[(newAccessory.context.liveview as string).toUpperCase()] = true;

      // Inform the user.
      this.log.info("Configuring plugin-specific liveview switch: %s.", viewName);
    }
  }

  // Configure MQTT capabilities for the security system.
  private configureMqtt(): void {

    if(this.isMqttConfigured) {

      return;
    }

    this.isMqttConfigured = true;

    // Return the current status of all the liveviews.
    this.nvr.mqtt?.subscribe(this.nvr.ufp.mac, "liveviews/get", (message: Buffer) => {

      const value = message.toString().toLowerCase();

      // When we get the right message, we return the list of liveviews.
      if(value !== "true") {

        return;
      }

      // Get the list of liveviews.
      const liveviews = this.platform.accessories.filter(x => "liveview" in x.context).map(x =>
        ({ name: x.context.liveview as string, state: x.getService(this.hap.Service.Switch)?.getCharacteristic(this.hap.Characteristic.On).value }));

      this.nvr.mqtt?.publish(this.nvr.ufp.mac ?? "", "liveviews", JSON.stringify(liveviews));
      this.log.info("Liveview scenes list published via MQTT.");
    });

    // Set the status of one or more liveviews.
    this.nvr.mqtt?.subscribe(this.nvr.ufp.mac, "liveviews/set", (message: Buffer) => {

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

          this.log.error("Unable to process MQTT liveview setting: \"%s\". Error: %s.", message.toString(), error.message);
        } else {

          this.log.error("Unknown error has occurred: %s.", error);
        }

        // Errors mean that we're done now.
        return;
      }

      // Update state on the liveviews.
      for(const entry of incomingPayload) {

        // Lookup this liveview.
        const accessory = this.platform.accessories.find(x => ("liveview" in x.context) && (x.context.liveview as string).toUpperCase() === entry.name.toUpperCase());

        // If we can't find it, move on.
        if(!accessory) {

          continue;
        }

        // Set the switch state and update the switch in HomeKit.
        accessory.getService(this.hap.Service.Switch)?.updateCharacteristic(this.hap.Characteristic.On, entry.state === true);
        this.log.info("Liveview scene updated via MQTT: %s.", accessory.context.liveview);
      }
    });
  }

  // Toggle the liveview switch state.
  private setSwitchState(liveviewSwitch: PlatformAccessory, targetState: CharacteristicValue): void {

    // We don't have any liveviews or we're already at this state - we're done.
    if(!this.ufpApi.bootstrap || !this.liveviews || (this.getSwitchState(liveviewSwitch.context.liveview as string) === targetState)) {

      return;
    }

    // Get the complete list of cameras in the liveview we're interested in. This cryptic line grabs the list of liveviews that have the name we're interested in (turns
    // out, you can define multiple liveviews in Protect with the same name...who knew!), and then create a single list containing all of the cameras found.
    const targetCameraIds = this.getLiveviewCameras(liveviewSwitch.context.liveview as string);

    // Nothing configured for this view. We're done.
    if(!targetCameraIds.length) {

      return;
    }

    // Iterate through the cameras in this liveview.
    for(const targetCameraId of targetCameraIds) {

      const protectDevice = this.nvr.deviceLookup(targetCameraId);

      // No camera found or we're already at the target state - we're done.
      if(!protectDevice || (protectDevice.accessory.context.detectMotion === targetState)) {

        continue;
      }

      // Update the motion sensor switch, if it exists.
      protectDevice.accessory.getService(this.hap.Service.Switch)?.updateCharacteristic(this.hap.Characteristic.On, targetState);

      // Set the motion detection state. We do this after setting any motion detection switch in order to ensure we fire events in the right order for the motion
      // detection switch.
      protectDevice.accessory.context.detectMotion = targetState as boolean;

      // Inform the user.
      this.log.info("%s -> %s: Motion detection %s.", liveviewSwitch.context.liveview, protectDevice.accessoryName,
        (protectDevice.accessory.context.detectMotion === true) ? "enabled" : "disabled");
    }

    // Save our new state.
    liveviewSwitch.context.liveviewState = targetState;

    // Publish to MQTT, if configured.
    this.nvr.mqtt?.publish(this.nvr.ufp.mac ?? "", "liveviews",
      JSON.stringify([{ name: liveviewSwitch.context.liveview as string, state: targetState }]));
  }

  // Get the current liveview switch state.
  private getSwitchState(liveviewName: string): boolean {

    // Get the list of unique states that exist across all liveview-specified cameras.
    const detectedStates = [ ...new Set(this.getLiveviewCameras(liveviewName).map(x => this.nvr.deviceLookup(x)?.accessory.context.detectMotion as boolean)) ];

    // If we have more than one element in the array or an empty array (meaning we don't have a liveview we know about),
    // we don't have consistent states across all the devices, so we assume it's false.
    if(detectedStates.length !== 1) {

      return false;
    }

    // Return the state we've detected.
    return detectedStates[0];
  }

  // Get the devices associated with a particular liveview.
  private getLiveviewCameras(liveviewName: string): string[] {

    // Get the complete list of cameras in the liveview we're interested in. This cryptic line grabs the list of liveviews
    // that have the name we're interested in (turns out, you can define multiple liveviews in Protect with the same name...who knew!),
    // and then create a single list containing all of the cameras found.
    return this.liveviews.filter(view => view.name.toUpperCase() === ("Protect-" + liveviewName).toUpperCase())
      .map(view => view.slots.map(slots => slots.cameras)).flat(2);
  }
}
