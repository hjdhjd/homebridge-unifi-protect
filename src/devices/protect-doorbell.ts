/* Copyright(C) 2019-2024, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-doorbell.ts: Doorbell device class for UniFi Protect.
 */
import { CharacteristicValue, PlatformAccessory, Service } from "homebridge";
import { PLATFORM_NAME, PLUGIN_NAME, PROTECT_DOORBELL_CHIME_DURATION_DIGITAL } from "../settings.js";
import { ProtectCameraConfig, ProtectCameraConfigPayload, ProtectCameraLcdMessagePayload, ProtectEventPacket, ProtectNvrConfigPayload } from "unifi-protect";
import { ProtectCamera } from "./protect-camera.js";
import { ProtectCameraPackage } from "./protect-camera-package.js";
import { ProtectNvr } from "../protect-nvr.js";
import { ProtectReservedNames } from "../protect-types.js";

// A doorbell message entry.
interface MessageInterface {

  duration: number,
  text: string,
  type: string,
}

// Extend the message interface to include a doorbell message switch.
interface MessageSwitchInterface extends MessageInterface {

  service: Service,
  state: boolean
}

export class ProtectDoorbell extends ProtectCamera {

  private chimeDigitalDuration: number;
  private defaultMessageDuration: number;
  private isMessagesEnabled: boolean;
  private isMessagesFromControllerEnabled: boolean;
  private messageSwitches: MessageSwitchInterface[];
  public packageCamera!: ProtectCameraPackage | null;

  // Create an instance.
  constructor(nvr: ProtectNvr, device: ProtectCameraConfig, accessory: PlatformAccessory) {

    super(nvr, device, accessory);

    this.chimeDigitalDuration = this.getFeatureNumber("Doorbell.PhysicalChime.Duration.Digital") ?? PROTECT_DOORBELL_CHIME_DURATION_DIGITAL;
    this.defaultMessageDuration = this.nvr.ufp.doorbellSettings?.defaultMessageResetTimeoutMs ?? 60000;
    this.isMessagesEnabled = this.hasFeature("Doorbell.Messages");
    this.isMessagesFromControllerEnabled = this.hasFeature("Doorbell.Messages.FromDoorbell");
    this.messageSwitches = [];

    // Ensure physical chimes that are digital have sane durations.
    if(this.chimeDigitalDuration < 1000) {

      this.chimeDigitalDuration = 1000;
    } else if(this.chimeDigitalDuration > 10000) {

      this.chimeDigitalDuration = 10000;
    }
  }

  // Configure the doorbell for HomeKit.
  protected async configureDevice(): Promise<boolean> {

    this.packageCamera = null;

    // We only want to deal with actual Protect doorbell devices.
    if(!this.ufp.featureFlags.isDoorbell) {

      return false;
    }

    // Call our parent to setup the camera portion of the doorbell.
    await super.configureDevice();

    // Configure our package camera, if we have one.
    this.configurePackageCamera();

    // Let's setup the doorbell-specific attributes.
    this.configureVideoDoorbell();

    // Now, make the doorbell LCD message functionality available.
    this.configureDoorbellLcdSwitch();

    // Configure physical chime switches, if configured.
    this.configurePhysicalChimes();

    // Register our event handlers.
    this.nvr.events.on("updateEvent." + this.nvr.ufp.id, this.listeners["updateEvent." + this.nvr.ufp.id] = this.nvrEventHandler.bind(this));

    return true;
  }

  // Configure our access to the doorbell LCD screen.
  private configureDoorbellLcdSwitch(): boolean {

    // Make sure we're configuring a camera device with an LCD screen (aka a doorbell).
    if((this.ufp.modelKey !== "camera") || !this.ufp.featureFlags.hasLcdScreen) {

      return false;
    }

    // Grab the consolidated list of messages from the doorbell and our configuration.
    const doorbellMessages = this.getMessages();

    // Look through the combined messages from the doorbell and what the user has configured and tell HomeKit about it.
    for(const entry of doorbellMessages) {

      // Truncate anything longer than the character limit that the doorbell will accept.
      if(entry.text.length > 30) {

        entry.text = entry.text.slice(0, 30);
      }

      // In the unlikely event someone tries to use words we have reserved for our own use.
      if(this.isReservedName(entry.text)) {

        continue;
      }

      // Check to see if we already have this message switch configured.
      if(this.messageSwitches?.some(x => (x.type === entry.type) && (x.text === entry.text))) {

        continue;
      }

      this.log.info("Enabled doorbell message switch%s: %s.", entry.duration ? " (" + (entry.duration / 1000).toString() + " seconds)" : "", entry.text);

      // Use the message switch, if it already exists.
      let switchService = this.accessory.getServiceById(this.hap.Service.Switch, entry.type + "." + entry.text);

      // It's a new message, let's create the service for it. Each message cannot exceed 30 characters, but
      // given that HomeKit allows for strings to be up to 64 characters long, this should be fine.
      if(!switchService) {

        switchService = new this.hap.Service.Switch(entry.text, entry.type + "." + entry.text);

        if(!switchService) {

          this.log.error("Unable to add doorbell message switch: %s.", entry.text);
          continue;
        }

        switchService.addOptionalCharacteristic(this.hap.Characteristic.ConfiguredName);
        this.accessory.addService(switchService);
      }

      const duration = "duration" in entry ? entry.duration : this.defaultMessageDuration;

      // Save the message switch in the list we maintain.
      this.messageSwitches.push({ duration: duration, service: switchService, state: false, text: entry.text, type: entry.type }) - 1;

      // Configure the message switch.
      switchService.updateCharacteristic(this.hap.Characteristic.ConfiguredName, entry.text);
      switchService
        .getCharacteristic(this.hap.Characteristic.On)
        ?.onGet(this.getSwitchState.bind(this, this.messageSwitches[this.messageSwitches.length - 1]))
        .onSet(this.setSwitchState.bind(this, this.messageSwitches[this.messageSwitches.length - 1]));
    }

    // Update the message switch state in HomeKit.
    this.updateLcdSwitch(this.ufp.lcdMessage);

    // Check to see if any of our existing doorbell messages have disappeared.
    this.validateMessageSwitches(doorbellMessages);

    return true;
  }

  // Configure a package camera, if one exists.
  private configurePackageCamera(): boolean {

    // First, confirm the device has a package camera.
    if(!this.ufp.featureFlags.hasPackageCamera) {

      return false;
    }

    // If we've already setup the package camera, we're done.
    if(this.packageCamera) {

      return true;
    }

    // Generate a UUID for the package camera.
    const uuid = this.hap.uuid.generate(this.ufp.mac + ".PackageCamera");

    // Let's find it if we've already created it.
    let packageCameraAccessory = this.platform.accessories.find((x: PlatformAccessory) => x.UUID === uuid) ?? (null as unknown as PlatformAccessory);

    // We can't find the accessory. Let's create it.
    if(!packageCameraAccessory) {

      // We will use the NVR MAC address + ".NVRSystemInfo" to create our UUID. That should provide the guaranteed uniqueness we need.
      packageCameraAccessory = new this.api.platformAccessory(this.accessoryName + " Package Camera", uuid);

      if(!packageCameraAccessory) {

        this.log.error("Unable to create the package camera accessory.");
        return false;
      }

      // Register this accessory with homebridge and add it to the platform accessory array so we can track it.
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [ packageCameraAccessory ]);
      this.platform.accessories.push(packageCameraAccessory);
    }

    // Now create the package camera accessory. We do want to modify the camera name to ensure things look pretty.
    this.packageCamera = new ProtectCameraPackage(this.nvr,
      Object.assign({}, this.ufp, { name: (this.ufp.name ?? this.ufp.marketName) + " Package Camera"}), packageCameraAccessory);
    return true;
  }

  // Configure a series of switches to manually enable or disable chimes on Protect doorbells that support attached physical chimes.
  private configurePhysicalChimes(): boolean {

    const switchesEnabled = [];

    // The Protect controller supports three modes for attached, physical chimes on a doorbell: none, mechanical, and digital. We create switches for each of the modes.
    for(const physicalChimeType of
      [ ProtectReservedNames.SWITCH_DOORBELL_CHIME_NONE, ProtectReservedNames.SWITCH_DOORBELL_CHIME_MECHANICAL, ProtectReservedNames.SWITCH_DOORBELL_CHIME_DIGITAL ]) {

      const chimeSetting = physicalChimeType.slice(physicalChimeType.lastIndexOf(".") + 1);

      // Find the switch service, if it exists.
      let switchService = this.accessory.getServiceById(this.hap.Service.Switch, physicalChimeType);

      // If we don't have the physical capabilities or the feature option enabled, disable the switch and we're done.
      if(!this.ufp.featureFlags.hasChime || !this.hasFeature("Doorbell.PhysicalChime")) {

        if(switchService) {

          this.accessory.removeService(switchService);
        }

        continue;
      }

      const switchName = this.accessoryName + " Physical Chime " + chimeSetting.charAt(0).toUpperCase() + chimeSetting.slice(1);

      // Add the switch to the doorbell, if needed.
      if(!switchService) {

        switchService = new this.hap.Service.Switch(switchName, physicalChimeType);

        if(!switchService) {

          this.log.error("Unable to add the physical chime switches.");
          continue;
        }

        switchService.addOptionalCharacteristic(this.hap.Characteristic.ConfiguredName);
        this.accessory.addService(switchService);
      }

      // Get the current status of the physical chime mode on the doorbell.
      switchService.getCharacteristic(this.hap.Characteristic.On)?.onGet(() => {

        return this.ufp.chimeDuration === this.getPhysicalChimeDuration(physicalChimeType);
      });

      // Activate the appropriate physical chime mode on the doorbell.
      switchService.getCharacteristic(this.hap.Characteristic.On)?.onSet(async (value: CharacteristicValue) => {

        // We only want to do something if we're being activated. Turning off the switch would really be an undefined state given that
        // there are three different settings one can choose from. Instead, we do nothing and leave it to the user to choose what state
        // they really want to set.
        if(!value) {

          setTimeout(() => {

            this.updateDevice();
          }, 50);

          return;
        }

        // Set our physical chime duration.
        const newDevice = await this.nvr.ufpApi.updateDevice(this.ufp, { chimeDuration: this.getPhysicalChimeDuration(physicalChimeType) });

        if(!newDevice) {

          this.log.error("Unable to set the physical chime mode to %s.", chimeSetting);
          return false;
        }

        // Save our updated device context.
        this.ufp = newDevice;

        // Update all the other physical chime switches.
        for(const otherChimeSwitch of
          [ ProtectReservedNames.SWITCH_DOORBELL_CHIME_NONE, ProtectReservedNames.SWITCH_DOORBELL_CHIME_MECHANICAL,
            ProtectReservedNames.SWITCH_DOORBELL_CHIME_DIGITAL ]) {

          // Don't update ourselves a second time.
          if(physicalChimeType === otherChimeSwitch) {

            continue;
          }

          // Update the other physical chime switches.
          this.accessory.getServiceById(this.hap.Service.Switch, otherChimeSwitch)?.updateCharacteristic(this.hap.Characteristic.On, false);
        }

        // Inform the user, and we're done.
        this.log.info("Physical chime type set to %s.", chimeSetting);
      });

      // Initialize the physical chime switch state.
      switchService.updateCharacteristic(this.hap.Characteristic.ConfiguredName, switchName);
      switchService.updateCharacteristic(this.hap.Characteristic.On, this.ufp.chimeDuration === this.getPhysicalChimeDuration(physicalChimeType));
      switchesEnabled.push(chimeSetting);
    }

    if(switchesEnabled.length) {

      this.log.info("Enabling physical chime switches: %s (digital chime duration: %s ms).", switchesEnabled.join(", "),
        this.chimeDigitalDuration.toLocaleString("en-US"));
    }

    return true;
  }

  // Configure MQTT capabilities for the doorbell.
  protected configureMqtt(): boolean {

    // Call our parent to setup the general camera MQTT capabilities.
    super.configureMqtt();

    // Get the current message on the doorbell.
    this.nvr.mqtt?.subscribe(this.accessory, "message/get", (message: Buffer) => {

      const value = message.toString();

      // When we get the right message, we return the current message set on the doorbell.
      if(value?.toLowerCase() !== "true") {

        return;
      }

      const doorbellMessage = this.ufp.lcdMessage?.text ?? "";
      const doorbellDuration = (("resetAt" in this.ufp.lcdMessage) && this.ufp.lcdMessage.resetAt !== null) ?
        Math.round((this.ufp.lcdMessage.resetAt - Date.now()) / 1000) : 0;

      // Publish the current message.
      this.nvr.mqtt?.publish(this.accessory, "message", JSON.stringify({ duration: doorbellDuration, message: doorbellMessage }));
      this.log.info("Doorbell message information published via MQTT.");
    });

    // We support the ability to set the doorbell message like so:
    //
    //   { "message": "some message", "duration": 30 }
    //
    // If duration is omitted, we assume the default duration.
    // If duration is 0, we assume it's not expiring.
    // If the message is blank, we assume we're resetting the doorbell message.
    this.nvr.mqtt?.subscribe(this.accessory, "message/set", (message: Buffer) => {

      interface mqttMessageJSON {

        message: string,
        duration: number
      }

      let incomingPayload;
      let outboundPayload;

      // Catch any errors in parsing what we get over MQTT.
      try {

        incomingPayload = JSON.parse(message.toString()) as mqttMessageJSON;

        // Sanity check what comes in from MQTT to make sure it's what we want.
        if(!(incomingPayload instanceof Object)) {

          throw new Error("The JSON object is not in the expected format");
        }
      } catch(error) {

        if(error instanceof SyntaxError) {

          this.log.error("Unable to process MQTT message: \"%s\". Error: %s.", message.toString(), error.message);
        } else {

          this.log.error("Unknown error has occurred: %s.", error);
        }

        // Errors mean that we're done now.
        return;
      }

      // At a minimum, make sure a message was specified. If we have specified duration, make sure it's a number.
      // Our NaN test may seem strange - that's because NaN is the only JavaScript value that is treated as unequal
      // to itself. Meaning, you can always test if a value is NaN by checking it for equality to itself. Weird huh?
      if(!("message" in incomingPayload) || (("duration" in incomingPayload) && (incomingPayload.duration !== incomingPayload.duration))) {

        this.log.error("Unable to process MQTT message: \"%s\".", incomingPayload);
        return;
      }

      // If no duration specified, or a negative duration, we assume the default duration.
      if(!("duration" in incomingPayload) || (("duration" in incomingPayload) && (incomingPayload.duration < 0))) {

        incomingPayload.duration = this.defaultMessageDuration;
      } else {

        incomingPayload.duration = incomingPayload.duration * 1000;
      }

      // No message defined...we assume we're resetting the message.
      if(!incomingPayload.message.length) {

        outboundPayload = { resetAt: 0 };
        this.log.info("Received MQTT doorbell message reset.");
      } else {

        outboundPayload = { duration: incomingPayload.duration, text: incomingPayload.message, type: "CUSTOM_MESSAGE" };
        this.log.info("Received MQTT doorbell message%s: %s.",
          outboundPayload.duration ? " (" + (outboundPayload.duration / 1000).toString() + " seconds)" : "",
          outboundPayload.text);
      }

      // Send it to the doorbell and we're done.
      void this.setMessage(outboundPayload);
    });

    return true;
  }

  // Refresh doorbell-specific characteristics.
  public updateDevice(): boolean {

    super.updateDevice();

    // Update the package camera state, if we have one.
    if(this.packageCamera) {

      this.packageCamera.accessory.getService(this.hap.Service.MotionSensor)?.updateCharacteristic(this.hap.Characteristic.StatusActive, this.isOnline);
    }

    // Check for updates to the physical chime state, if we have the switches configured on doorbell that supports chimes.
    if(this.ufp.featureFlags.hasChime && this.hasFeature("Doorbell.PhysicalChime")) {

      // Update all the switch states.
      for(const physicalChimeType of
        [ ProtectReservedNames.SWITCH_DOORBELL_CHIME_NONE, ProtectReservedNames.SWITCH_DOORBELL_CHIME_MECHANICAL, ProtectReservedNames.SWITCH_DOORBELL_CHIME_DIGITAL ]) {

        // Update state based on the physical chime mode.
        this.accessory.getServiceById(this.hap.Service.Switch, physicalChimeType)?.
          updateCharacteristic(this.hap.Characteristic.On, this.ufp.chimeDuration === this.getPhysicalChimeDuration(physicalChimeType));
      }
    }

    return true;
  }

  // Return the physical chime duration, in milliseconds.
  private getPhysicalChimeDuration(physicalChimeType: ProtectReservedNames): number {

    // Set the physical chime duration to correspond to the settings that Protect configures when selecting different physical chime types.
    switch(physicalChimeType) {

      case ProtectReservedNames.SWITCH_DOORBELL_CHIME_DIGITAL:

        return this.chimeDigitalDuration;
        break;

      case ProtectReservedNames.SWITCH_DOORBELL_CHIME_MECHANICAL:

        return 300;
        break;

      case ProtectReservedNames.SWITCH_DOORBELL_CHIME_NONE:
      default:

        return 0;
        break;
    }
  }

  // Get the list of messages from the doorbell and the user configuration.
  private getMessages(): MessageInterface[] {

    // First, we get our builtin and configured messages from the controller.
    const doorbellSettings = this.nvr.ufp.doorbellSettings;

    // Something's not right with the configuration...we're done.
    if(!doorbellSettings || !this.isMessagesEnabled) {

      return [];
    }

    let doorbellMessages: MessageInterface[] = [];

    // Grab any messages that the user has configured.
    if(this.nvr.config.doorbellMessages) {

      for(const configEntry of this.nvr.config.doorbellMessages) {

        let duration = this.defaultMessageDuration;

        // If we've set a duration, let's honor it. If it's less than zero, use the default duration.
        if(("duration" in configEntry) && !isNaN(configEntry.duration) && (configEntry.duration >= 0)) {

          duration = configEntry.duration * 1000;
        }

        // Add it to our list.
        doorbellMessages.push({ duration: duration, text: configEntry.message, type: "CUSTOM_MESSAGE" });
      }
    }

    // If we've got messages on the controller, let's configure those, unless the user has disabled that feature.
    if(this.isMessagesFromControllerEnabled) {

      doorbellMessages = (doorbellSettings.allMessages as MessageInterface[]).concat(doorbellMessages);
    }

    // Return the list of doorbell messages.
    return doorbellMessages;
  }

  // Validate our existing HomeKit message switch list.
  private validateMessageSwitches(messageList: MessageInterface[]): void {

    // Figure out if there's anything that's disappeared in the canonical list from the doorbell.
    for(const entry of this.messageSwitches) {

      // This exists on the doorbell...move along.
      if(messageList?.some(x => (x.type === entry.type) && (x.text === entry.text))) {
        continue;
      }

      this.log.info("Removing saved doorbell message: %s.", entry.text);

      // The message has been deleted on the doorbell, remove it in HomeKit.
      this.accessory.removeService(entry.service);
      this.messageSwitches.splice(this.messageSwitches.indexOf(entry), 1);
    }

    // Loop through the list of services on our doorbell accessory and sync the message switches.
    // We do this to catch the scenario where Homebridge was shutdown, and the list of saved messages
    // on the controller changes.
    for(const switchService of this.accessory.services) {

      // We only want to look at switches.
      if(switchService.UUID !== this.hap.Service.Switch.UUID) {
        continue;
      }

      // We don't want to touch any reserved switch types here. If it's a non-reserved type, it's fair game.
      if(this.isReservedName(switchService.subtype)) {
        continue;
      }

      // The message exists on the doorbell.
      if(this.messageSwitches?.some(x => (x.type + "." + x.text) === switchService.subtype)) {
        continue;
      }

      // The message has been deleted on the doorbell - remove it from HomeKit and inform the user about it.
      this.log.info("Removing saved doorbell message: %s.", switchService.subtype?.slice(switchService.subtype.indexOf(".") + 1));
      this.accessory.removeService(switchService);
    }
  }

  // Update the message switch state in HomeKit.
  private updateLcdSwitch(lcdMessage: ProtectCameraLcdMessagePayload): void {

    // The message has been cleared on the doorbell, turn off all message switches in HomeKit.
    if(!Object.keys(lcdMessage).length) {

      for(const lcdEntry of this.messageSwitches) {

        lcdEntry.state = false;
        lcdEntry.service.updateCharacteristic(this.hap.Characteristic.On, false);
      }

      return;
    }

    // Sanity check.
    if(!("type" in lcdMessage) || !("text" in lcdMessage)) {

      return;
    }

    // The message has been set on the doorbell. Update HomeKit accordingly.
    for(const lcdEntry of this.messageSwitches) {

      // If it's not the message we're interested in, make sure it's off and keep going.
      if(lcdEntry.service.subtype !== ((lcdMessage.type as string) + "." + (lcdMessage.text as string))) {

        lcdEntry.state = false;
        lcdEntry.service.updateCharacteristic(this.hap.Characteristic.On, false);
        continue;
      }

      // If the message switch is already on, we're done.
      if(lcdEntry.state) {

        continue;
      }

      // Set the message state and update HomeKit.
      lcdEntry.state = true;
      lcdEntry.service.updateCharacteristic(this.hap.Characteristic.On, true);

      this.log.info("Doorbell message set%s: %s.",
        lcdMessage.resetAt !== null ? " (" + Math.round(((lcdMessage.resetAt ?? 0) - Date.now()) / 1000).toString() + " seconds)" : "", lcdMessage.text);

      // Publish to MQTT, if the user has configured it.
      this.nvr.mqtt?.publish(this.accessory, "message", JSON.stringify({ duration: lcdEntry.duration / 1000, message: lcdEntry.text }));
    }
  }

  // Get the current state of this message switch.
  private getSwitchState(messageSwitch: MessageSwitchInterface): CharacteristicValue {

    return messageSwitch.state;
  }

  // Toggle the message on the doorbell.
  private async setSwitchState(messageSwitch: MessageSwitchInterface, value: CharacteristicValue): Promise<void> {

    // Tell the doorbell to display our message.
    if(messageSwitch.state !== value) {

      const payload: ProtectCameraLcdMessagePayload = (value === true) ? { duration: messageSwitch.duration, text: messageSwitch.text, type: messageSwitch.type } : {};

      // Set the message and sync our states.
      await this.setMessage(payload);
    }
  }

  // Set the message on the doorbell.
  private async setMessage(payload: ProtectCameraLcdMessagePayload = {}): Promise<boolean> {

    // We take the duration and save it for MQTT and then translate the payload into what Protect is expecting from us.
    if("duration" in payload) {

      payload.resetAt = payload.duration ? Date.now() + payload.duration : null;
      delete payload.duration;
    }

    // Push the update to the doorbell. If we have an empty payload, it means we're resetting the LCD message back to it's default.
    const newDevice = await this.nvr.ufpApi.updateDevice(this.ufp, { lcdMessage: payload });

    if(!newDevice) {

      this.log.error("Unable to set doorbell message. Please ensure this username has the Administrator role in UniFi Protect.");
      return false;
    }

    // Set our updated device configuration.
    this.ufp = newDevice;
    return true;
  }

  // Handle doorbell-related events.
  protected eventHandler(packet: ProtectEventPacket): void {

    const payload = packet.payload as ProtectCameraConfigPayload;

    super.eventHandler(packet);

    // Update the package camera, if we have one.
    if(this.packageCamera) {

      this.packageCamera.ufp = Object.assign({}, this.ufp, { name: (this.ufp.name ?? this.ufp.marketName) + " Package Camera"}) as ProtectCameraConfig;
    }

    // If we have a package camera that has HKSV enabled, we'll trigger it's motion sensor here. Why? HKSV requires a motion sensor attached to that camera accessory,
    // and since a package camera is actually a secondary camera on a device with a single motion sensor, we use that motion sensor to trigger the package camera's HKSV
    // event recording.
    if(payload.lastMotion && this.packageCamera?.stream?.hksv?.isRecording) {

      this.nvr.events.motionEventHandler(this.packageCamera);
    }

    // Process LCD message events.
    if(payload.lcdMessage) {

      this.updateLcdSwitch(payload.lcdMessage);
    }
  }

  // Handle doorbell saved message updates on the Protect controller.
  private nvrEventHandler(packet: ProtectEventPacket): void {

    const payload = packet.payload as ProtectNvrConfigPayload;

    // Process doorbell message save events.
    if(payload.doorbellSettings) {

      // We need to proactively update the allMessages object. This feels like a UniFi Protect bug, but all we can do is work around it.
      if(payload.doorbellSettings.customMessages) {

        const builtinMessages = this.nvr.ufp.doorbellSettings.allMessages.filter(x => x.type !== "CUSTOM_MESSAGE");
        const customMessages = payload.doorbellSettings.customMessages.map(x => ({ text: x, type: "CUSTOM_MESSAGE" }));

        this.nvr.ufp.doorbellSettings.allMessages = builtinMessages.concat(customMessages);
      }

      this.configureDoorbellLcdSwitch();
    }
  }
}
