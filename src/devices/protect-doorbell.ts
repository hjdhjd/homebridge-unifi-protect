/* Copyright(C) 2019-2025, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-doorbell.ts: Doorbell device class for UniFi Protect.
 */
import { CharacteristicValue, PlatformAccessory, Service } from "homebridge";
import { Nullable, validateName } from "homebridge-plugin-utils";
import { PLATFORM_NAME, PLUGIN_NAME, PROTECT_DOORBELL_AUTHSENSOR_DURATION, PROTECT_DOORBELL_CHIME_DURATION_DIGITAL } from "../settings.js";
import { ProtectCameraConfig, ProtectCameraConfigPayload, ProtectCameraLcdMessagePayload, ProtectChimeConfigPayload, ProtectEventAdd, ProtectEventPacket,
  ProtectNvrConfigPayload } from "unifi-protect";
import { ProtectReservedNames, toCamelCase } from "../protect-types.js";
import { ProtectCamera } from "./protect-camera.js";
import { ProtectCameraPackage } from "./protect-camera-package.js";

// A doorbell message entry.
interface MessageInterface {

  duration: number,
  text: string,
  type: string,
}

// Extend the message interface to include a doorbell message switch.
export interface MessageSwitchInterface extends MessageInterface {

  service: Service,
  state: boolean
}

export class ProtectDoorbell extends ProtectCamera {

  private chimeDigitalDuration!: number;
  private contactAuthTimer?: NodeJS.Timeout;
  private defaultMessageDuration!: number;
  private isMessagesEnabled!: boolean;
  private isMessagesFromControllerEnabled!: boolean;
  public packageCamera?: Nullable<ProtectCameraPackage>;

  // Configure the doorbell for HomeKit.
  protected configureDevice(): boolean {

    this.chimeDigitalDuration = this.getFeatureNumber("Doorbell.PhysicalChime.Duration.Digital") ?? PROTECT_DOORBELL_CHIME_DURATION_DIGITAL;
    this.defaultMessageDuration = this.nvr.ufp.doorbellSettings?.defaultMessageResetTimeoutMs ?? 60000;
    this.isMessagesEnabled = this.hasFeature("Doorbell.Messages");
    this.isMessagesFromControllerEnabled = this.hasFeature("Doorbell.Messages.FromDoorbell");
    this.messageSwitches = {};
    this.packageCamera = null;

    // Ensure physical chimes that are digital have sane durations.
    if(this.chimeDigitalDuration < 1000) {

      this.chimeDigitalDuration = 1000;
    } else if(this.chimeDigitalDuration > 10000) {

      this.chimeDigitalDuration = 10000;
    }

    // We only want to deal with actual Protect doorbell devices.
    if(!this.ufp.featureFlags.isDoorbell) {

      return false;
    }

    // Call our parent to setup the camera portion of the doorbell.
    super.configureDevice();

    // Configure our package camera, if we have one.
    this.configurePackageCamera();

    // Let's setup the doorbell-specific attributes.
    this.configureVideoDoorbell();

    // Configure the authentication sensor, if enabled.
    this.configureAuthSensor();

    // Configure the doorbell LCD message capabilities.
    this.configureDoorbellLcdSwitch();

    // Configure physical chime switches, if enabled.
    this.configurePhysicalChimes();

    // Configure volume control, if enabled.
    this.configureProtectChimeLightbulb();

    // Register our event handlers.
    this.nvr.events.on("updateEvent." + this.nvr.ufp.id, this.listeners["updateEvent." + this.nvr.ufp.id] = this.nvrEventHandler.bind(this));
    this.nvr.events.on("updateEvent.chime", this.listeners["updateEvent.chime"] = this.chimeEventHandler.bind(this));

    return true;
  }

  // Cleanup after ourselves if we're being deleted.
  public cleanup(): void {

    if(this.packageCamera) {

      this.packageCamera.cleanup();
      this.packageCamera = null;
    }

    super.cleanup();
  }

  // Configure our access to the doorbell LCD screen.
  private configureDoorbellLcdSwitch(): boolean {

    // Make sure we're configuring a camera device with an LCD screen (aka a doorbell).
    if((this.ufp.modelKey !== "camera") || !this.ufp.featureFlags.hasLcdScreen) {

      return false;
    }

    // Grab the consolidated list of messages from the doorbell and our configuration.
    // Look through the combined messages from the doorbell and what the user has configured and tell HomeKit about it.
    for(const entry of this.getMessages()) {

      // Truncate anything longer than the character limit that the doorbell will accept.
      if(entry.text.length > 30) {

        entry.text = entry.text.slice(0, 30);
      }

      const switchIndex = entry.type + "." + entry.text;

      // In the unlikely event someone tries to use words we have reserved for our own use.
      if(this.isReservedName(switchIndex)) {

        continue;
      }

      // Check to see if we already have this message switch configured.
      if(this.messageSwitches[switchIndex]) {

        continue;
      }

      this.log.info("Enabled doorbell message switch%s: %s.", entry.duration ? " (" + (entry.duration / 1000).toString() + " seconds)" : "", entry.text);

      // Acquire the service. Each message cannot exceed 30 characters, but given that HomeKit allows for strings to be up to 64 characters long, this should be fine.
      const service = this.acquireService(this.hap.Service.Switch, entry.text, switchIndex);

      // Fail gracefully.
      if(!service) {

        this.log.error("Unable to add doorbell message switch: %s.", entry.text);

        return false;
      }

      const duration = "duration" in entry ? entry.duration : this.defaultMessageDuration;

      // Save the message switch in the list we maintain.
      this.messageSwitches[switchIndex] = { duration: duration, service: service, state: false, text: entry.text, type: entry.type };

      // Configure the message switch.
      service.getCharacteristic(this.hap.Characteristic.On)?.onSet(async (value: CharacteristicValue) => {

        // Lookup the message switch.
        const messageSwitch = this.messageSwitches[switchIndex];

        // If we're already in the state we want to be in, we're done.
        if(messageSwitch.state === value) {

          return;
        }

        // Set the message and sync our states.
        await this.setMessage((value === true) ? { duration: messageSwitch.duration, text: messageSwitch.text, type: messageSwitch.type } : { resetAt: Date.now() });
      });
    }

    // Update the message switch state in HomeKit.
    this.updateLcdSwitch(this.ufp.lcdMessage);

    // Check to see if any of our existing doorbell messages have disappeared.
    this.validateMessageSwitches();

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
      packageCameraAccessory = new this.api.platformAccessory(validateName(this.accessoryName + " Package Camera"), uuid);

      if(!packageCameraAccessory) {

        this.log.error("Unable to create the package camera accessory.");

        return false;
      }

      // Register this accessory with homebridge and add it to the accessory array so we can track it.
      if(this.hasFeature("Device.Standalone")) {

        this.api.publishExternalAccessories(PLUGIN_NAME, [ packageCameraAccessory ]);
      } else {

        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [ packageCameraAccessory ]);
      }

      this.platform.accessories.push(packageCameraAccessory);
      this.api.updatePlatformAccessories(this.platform.accessories);
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

      // Validate whether we should have this service enabled.
      if(!this.validService(this.hap.Service.Switch, () => {

        // If we don't have the physical capabilities or the feature option enabled, disable the switch and we're done.
        if(!this.ufp.featureFlags.hasChime || !this.hasFeature("Doorbell.PhysicalChime")) {

          return false;
        }

        return true;
      }, physicalChimeType)) {

        continue;
      }

      // Acquire the service.
      const service = this.acquireService(this.hap.Service.Switch, this.accessoryName + " Physical Chime " + toCamelCase(chimeSetting), physicalChimeType);

      // Fail gracefully.
      if(!service) {

        this.log.error("Unable to add physical chime switch: %s.", chimeSetting);

        continue;
      }

      // Get the current status of the physical chime mode on the doorbell.
      service.getCharacteristic(this.hap.Characteristic.On)?.onGet(() => {

        return this.ufp.chimeDuration === this.getPhysicalChimeDuration(physicalChimeType);
      });

      // Activate the appropriate physical chime mode on the doorbell.
      service.getCharacteristic(this.hap.Characteristic.On)?.onSet(async (value: CharacteristicValue) => {

        // We only want to do something if we're being activated. Turning off the switch would really be an undefined state given that there are three different settings
        // one can choose from. Instead, we do nothing and leave it to the user to choose what state they really want to set.
        if(!value) {

          setTimeout(() => this.updateDevice(), 50);

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
        for(const otherChimeSwitch of [ ProtectReservedNames.SWITCH_DOORBELL_CHIME_NONE, ProtectReservedNames.SWITCH_DOORBELL_CHIME_MECHANICAL,
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
      service.updateCharacteristic(this.hap.Characteristic.On, this.ufp.chimeDuration === this.getPhysicalChimeDuration(physicalChimeType));
      switchesEnabled.push(chimeSetting);
    }

    if(switchesEnabled.length) {

      this.log.info("Enabling physical chime switches: %s (digital chime duration: %s ms).", switchesEnabled.join(", "),
        this.chimeDigitalDuration.toLocaleString("en-US"));
    }

    return true;
  }

  // Configure the dimmer for HomeKit to control the volume.
  private configureProtectChimeLightbulb(): boolean {

    // Validate whether we should have this service enabled.
    if(!this.validService(this.hap.Service.Lightbulb, () => {

      // The volume dimmer is disabled by default unless the user enables it.
      if(!this.hasFeature("Doorbell.Volume.Dimmer")) {

        return false;
      }

      return true;
    }, ProtectReservedNames.LIGHTBULB_DOORBELL_VOLUME)) {

      return false;
    }

    // Acquire the service.
    const service = this.acquireService(this.hap.Service.Lightbulb, this.accessoryName + " Chime Volume", ProtectReservedNames.LIGHTBULB_DOORBELL_VOLUME);

    if(!service) {

      this.log.error("Unable to add chime volume control.");

      return false;
    }

    // Turn the chime on or off.
    service.getCharacteristic(this.hap.Characteristic.On)?.onGet(() => this.chimeVolume > 0);

    service.getCharacteristic(this.hap.Characteristic.On)?.onSet(async (value: CharacteristicValue) => {

      // We really only want to act when the volume is zero. Otherwise, it's handled by the brightness event.
      if(value) {

        return;
      }

      await this.setChimeVolume(0);
    });

    // Return the volume level of the chime.
    service.getCharacteristic(this.hap.Characteristic.Brightness)?.onGet(() => this.chimeVolume);

    // Adjust the volume of the chime by adjusting brightness of the light.
    service.getCharacteristic(this.hap.Characteristic.Brightness)?.onSet(async (value: CharacteristicValue) => this.setChimeVolume(value as number));

    // Initialize the chime.
    service.updateCharacteristic(this.hap.Characteristic.On, this.chimeVolume > 0);
    service.updateCharacteristic(this.hap.Characteristic.Brightness, this.chimeVolume);

    this.log.info("Enabling Protect chime volume control.");

    return true;
  }

  // Configure the contact sensor to indicate authentication success.
  private configureAuthSensor(): boolean {

    // Validate whether we should have this service enabled.
    if(!this.validService(this.hap.Service.ContactSensor, () => {

      // The authentication contact sensor is disabled by default unless the user enables it. We only make it available if we have at least one of the
      // fingerprint sensor or the NFC sensor available.
      if(!this.hasFeature("Doorbell.AuthSensor") || (!this.ufp.enableNfc && !this.ufp.featureFlags.hasFingerprintSensor)) {

        return false;
      }

      return true;
    }, ProtectReservedNames.CONTACT_AUTHSENSOR)) {

      return false;
    }

    // Acquire the service.
    const service = this.acquireService(this.hap.Service.ContactSensor, this.accessoryName + " Authenticated", ProtectReservedNames.CONTACT_AUTHSENSOR);

    if(!service) {

      this.log.error("Unable to add authentication sensor.");

      return false;
    }

    // Initialize the authentication contact sensor.
    service.updateCharacteristic(this.hap.Characteristic.ContactSensorState, false);

    this.log.info("Enabling Protect authentication contact sensor.");

    return true;
  }

  // Configure MQTT capabilities for the doorbell.
  protected configureMqtt(): boolean {

    // Call our parent to setup the general camera MQTT capabilities.
    super.configureMqtt();

    // Get and set the chime volume.
    this.subscribeGet("chime", "chime volume", (): string => {

      return this.chimeVolume.toString();
    });

    this.subscribeSet("chime", "chime volume", (value: string) => {

      const volume = parseInt(value.toString());

      // Unknown message - ignore it.
      if(isNaN(volume) || (volume < 0) || (volume > 100)) {

        return;
      }

      // We explicitly want to trigger our set event handler, which will complete this action.
      this.accessory.getServiceById(this.hap.Service.Lightbulb, ProtectReservedNames.LIGHTBULB_DOORBELL_VOLUME)
        ?.setCharacteristic(this.hap.Characteristic.Brightness, volume);
      this.accessory.getServiceById(this.hap.Service.Lightbulb, ProtectReservedNames.LIGHTBULB_DOORBELL_VOLUME)
        ?.setCharacteristic(this.hap.Characteristic.On, volume > 0);
    });

    // Get the current message on the doorbell.
    this.subscribeGet("message", "doorbell message", (): string => {

      const doorbellDuration = (("resetAt" in this.ufp.lcdMessage) && (this.ufp.lcdMessage.resetAt !== null)) ?
        Math.round((this.ufp.lcdMessage.resetAt - Date.now()) / 1000) : 0;

      // Return the current message.
      return JSON.stringify({ duration: doorbellDuration, message: this.ufp.lcdMessage?.text ?? "" });
    });

    // We support the ability to set the doorbell message like so:
    //
    //   { "message": "some message", "duration": 30 }
    //
    // If duration is omitted, we assume the default duration.
    // If duration is 0, we assume it's not expiring.
    // If the message is blank, we assume we're resetting the doorbell message.
    this.subscribeSet("message", "doorbell message", (value: string, rawValue: string) => {

      interface mqttMessageJSON {

        message: string,
        duration: number
      }

      let inboundPayload;

      // Catch any errors in parsing what we get over MQTT.
      try {

        inboundPayload = JSON.parse(rawValue) as mqttMessageJSON;
      } catch(error) {

        this.log.error("Unable to process MQTT message: \"%s\". Invalid JSON.", rawValue);

        // Errors mean that we're done now.
        return;
      }

      // At a minimum, make sure a message was specified. If we have specified duration, make sure it's a number. Our NaN test may seem strange - that's because NaN is
      // the only JavaScript value that is treated as unequal to itself. Meaning, you can always test if a value is NaN by checking it for equality to itself. Weird huh?
      if(!inboundPayload || !("message" in inboundPayload) || (("duration" in inboundPayload) && (inboundPayload.duration !== inboundPayload.duration))) {

        this.log.error("Unable to process MQTT message: \"%s\".", inboundPayload);

        return;
      }

      // If no duration specified, or a negative duration, we assume the default duration.
      if(!("duration" in inboundPayload) || (("duration" in inboundPayload) && (inboundPayload.duration < 0))) {

        inboundPayload.duration = this.defaultMessageDuration;
      } else {

        inboundPayload.duration = inboundPayload.duration * 1000;
      }

      let outboundPayload;

      // No message defined...we assume we're resetting the message.
      if(!inboundPayload.message.length) {

        outboundPayload = { resetAt: Date.now() };
        this.log.info("Received MQTT doorbell message reset.");
      } else {

        outboundPayload = { duration: inboundPayload.duration, text: inboundPayload.message, type: "CUSTOM_MESSAGE" };
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

      case ProtectReservedNames.SWITCH_DOORBELL_CHIME_MECHANICAL:

        return 300;

      case ProtectReservedNames.SWITCH_DOORBELL_CHIME_NONE:
      default:

        return 0;
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
  private validateMessageSwitches(): void {

    // Figure out if there's anything that's disappeared in the canonical list from the doorbell.
    for(const entry of Object.values(this.messageSwitches)) {

      // This exists on the doorbell...move along.
      if(this.messageSwitches[entry.type + "." + entry.text]) {

        continue;
      }

      this.log.info("Removing saved doorbell message: %s.", entry.text);

      // The message has been deleted on the doorbell, remove it in HomeKit.
      this.accessory.removeService(entry.service);
      delete this.messageSwitches[entry.type + "." + entry.text];
    }

    // Loop through the list of services on our doorbell accessory and sync the message switches. We do this to catch the scenario where Homebridge was shutdown, and the
    // list of saved messages on the controller changes.
    for(const switchService of this.accessory.services.filter(service => (service.UUID === this.hap.Service.Switch.UUID) && service.subtype &&
      !this.isReservedName(service.subtype) && !this.messageSwitches[service.subtype])) {

      // The message has been deleted on the doorbell - remove it from HomeKit and inform the user about it.
      this.log.info("Removing saved doorbell message: %s.", switchService.subtype?.slice(switchService.subtype.indexOf(".") + 1));
      this.accessory.removeService(switchService);
    }
  }

  // Update the message switch state in HomeKit.
  private updateLcdSwitch(payload: ProtectCameraLcdMessagePayload): void {

    // The message has been cleared on the doorbell, turn off all message switches in HomeKit.
    if(!Object.keys(payload).length) {

      for(const entry of Object.keys(this.messageSwitches)) {

        this.messageSwitches[entry].state = false;
        this.messageSwitches[entry].service.updateCharacteristic(this.hap.Characteristic.On, false);
      }

      return;
    }

    // Sanity check.
    if(!("type" in payload) || !("text" in payload)) {

      return;
    }

    // The message has been set on the doorbell. Update HomeKit accordingly.
    for(const entry of Object.keys(this.messageSwitches)) {

      // If it's not the message we're interested in, make sure it's off and keep going.
      if(entry !== ((payload.type as string) + "." + (payload.text as string))) {

        this.messageSwitches[entry].state = false;
        this.messageSwitches[entry].service.updateCharacteristic(this.hap.Characteristic.On, false);

        continue;
      }

      // If the message switch is already on, we're done.
      if(this.messageSwitches[entry].state) {

        continue;
      }

      // Set the message state and update HomeKit.
      this.messageSwitches[entry].state = true;
      this.messageSwitches[entry].service.updateCharacteristic(this.hap.Characteristic.On, true);

      this.log.info("Doorbell message set%s: %s.",
        payload.resetAt !== null ? " (" + Math.round(((payload.resetAt ?? 0) - Date.now()) / 1000).toString() + " seconds)" : "", payload.text);

      // Publish to MQTT, if the user has configured it.
      this.publish("message", JSON.stringify({ duration: this.messageSwitches[entry].duration / 1000, message: this.messageSwitches[entry].text }));
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

  // Handle add-related events from the controller.
  protected addEventHandler(packet: ProtectEventPacket): void {

    const payload = packet.payload as ProtectEventAdd;

    super.eventHandler(packet);

    // Process any authentication events.
    if(payload.type && ["fingerprintIdentified", "nfcCardScanned"].includes(payload.type)) {

      // Clear out the contact sensor timer.
      if(this.contactAuthTimer) {

        clearTimeout(this.contactAuthTimer);
        this.contactAuthTimer = undefined;
      }

      // Grab the service, if we've configured it.
      const service = this.accessory.getServiceById(this.hap.Service.ContactSensor, ProtectReservedNames.CONTACT_AUTHSENSOR);

      // We've failed to authenticate, we're done.
      if(!payload.metadata?.fingerprint?.ulpId && !payload.metadata?.nfc?.ulpId) {

        service?.updateCharacteristic(this.hap.Characteristic.ContactSensorState, false);

        return;
      }

      // We've successfully authenticated either a fingerprint or an NFC card.
      service?.updateCharacteristic(this.hap.Characteristic.ContactSensorState, true);

      // Publish to MQTT, if the user has configured it.
      const authInfo: Record<string, string> = { type: "fingerprint" };

      // We publish a bit more information if we have an NFC card.
      if(payload.type === "nfcCardScanned") {

        authInfo.id = payload.metadata.nfc.nfcId;
        authInfo.type = "nfc";
      }

      this.publish("authenticate", JSON.stringify(authInfo));

      // Reset our contact sensor after our auth sensor duration.
      this.contactAuthTimer = setTimeout(() => {

        service?.updateCharacteristic(this.hap.Characteristic.ContactSensorState, false);
        this.contactAuthTimer = undefined;
      }, PROTECT_DOORBELL_AUTHSENSOR_DURATION);
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

  // Handle chime volume updates on the Protect controller.
  private chimeEventHandler(packet: ProtectEventPacket): void {

    const payload = packet.payload as ProtectChimeConfigPayload;

    // We're only interested in events for this Protect controller and this doorbell.
    if(!this.nvr.ufpApi.bootstrap || (payload.nvrMac !== this.nvr.ufp.mac) || !payload.cameraIds?.includes(this.ufp.id) || !("ringSettings" in payload)) {

      return;
    }

    const chime = this.nvr.ufpApi.bootstrap.chimes.find(device => packet.header.id === device.id);

    if(chime) {

      this.nvr.ufpApi.bootstrap.chimes = [...this.nvr.ufpApi.bootstrap.chimes.filter(device => payload.id !== device.id), Object.assign(chime, payload)];

      const ring = payload.ringSettings?.find(tone => tone.cameraId === this.ufp.id);

      if(ring && ("volume" in ring)) {

        const service = this.accessory.getServiceById(this.hap.Service.Lightbulb, ProtectReservedNames.LIGHTBULB_DOORBELL_VOLUME);

        service?.updateCharacteristic(this.hap.Characteristic.Brightness, ring.volume as number);
        service?.updateCharacteristic(this.hap.Characteristic.On, (ring.volume as number) > 0);
      }
    }
  }

  private get chimeVolume(): number {

    let volume = 0;
    let chimes = 0;

    // If the bootstrap is missing, we're done.
    if(!this.nvr.ufpApi.bootstrap) {

      return 0;
    }

    for(const chime of this.nvr.ufpApi.bootstrap.chimes.filter(chime => chime.cameraIds.includes(this.ufp.id))) {

      const ring = chime.ringSettings.find(ring => ring.cameraId === this.ufp.id);

      if(!ring) {

        continue;
      }

      volume += ring.volume;
      chimes++;
    }

    return chimes ? (volume / chimes) : 0;
  }

  private async setChimeVolume(value: number): Promise<void> {

    // If the bootstrap is missing, we're done.
    if(!this.nvr.ufpApi.bootstrap) {

      return;
    }

    // Ensure we don't have any negative values.
    value = Math.max(value, 0);

    // Find all the chimes configured for this doorbell so we can sync their volume.
    for(const chime of this.nvr.ufpApi.bootstrap.chimes.filter(chime => chime.cameraIds.includes(this.ufp.id))) {

      // Given that chimes can be assigned to multiple doorbells, find the specific entry for this doorbell.
      const ring = chime.ringSettings.find(ring => ring.cameraId === this.ufp.id);

      if(!ring) {

        continue;
      }

      // Set the volume and update the chime device.
      ring.volume = value;

      // eslint-disable-next-line no-await-in-loop
      const newDevice = await this.nvr.ufpApi.updateDevice(chime, { ringSettings: [ ring ] });

      if(!newDevice) {

        this.log.error("Unable to turn the volume off. Please ensure this username has the Administrator role in UniFi Protect.");

        return;
      }

      // Set the context to our updated device configuration.
      const newChimes = this.nvr.ufpApi.bootstrap.chimes.filter(newChime => newChime.mac !== chime.mac);

      newChimes.push(newDevice);
      this.nvr.ufpApi.bootstrap.chimes = newChimes;
    }

    this.publish("chime", value.toString());
  }
}
