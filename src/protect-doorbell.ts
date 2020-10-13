/* Copyright(C) 2019-2020, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-doorbell.ts: Doorbell device class for UniFi Protect.
 */
import {
  CharacteristicEventTypes,
  CharacteristicGetCallback,
  CharacteristicSetCallback,
  CharacteristicValue,
  Service
} from "homebridge";
import { ProtectCameraConfig, ProtectCameraLcdMessagePayload } from "./protect-types";
import { ProtectCamera } from "./protect-camera";

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
  private defaultDuration!: number;
  private isMessagesEnabled!: boolean;
  private isMessagesFromControllerEnabled!: boolean;
  private messageSwitches!: MessageSwitchInterface[];

  // Configure the doorbell for HomeKit.
  protected async configureDevice(): Promise<boolean> {

    this.defaultDuration = this.nvr?.nvrApi?.bootstrap?.nvr?.doorbellSettings?.defaultMessageResetTimeoutMs === undefined ? 60000 :
      this.nvr.nvrApi.bootstrap.nvr.doorbellSettings.defaultMessageResetTimeoutMs;
    this.isMessagesEnabled = true;
    this.isMessagesFromControllerEnabled = true;
    this.messageSwitches = [];

    // We only want to deal with cameras with chimes.
    if(!(this.accessory.context.camera as ProtectCameraConfig)?.featureFlags.hasChime) {
      return false;
    }

    // The user has disabled the doorbell message functionality.
    if(!this.nvr.optionEnabled(this.accessory.context.camera as ProtectCameraConfig, "Messages")) {
      this.isMessagesEnabled = false;
    }

    // The user has disabled the doorbell message functionality.
    if(!this.nvr.optionEnabled(this.accessory.context.camera as ProtectCameraConfig, "Messages.FromDoorbell")) {
      this.isMessagesFromControllerEnabled = false;
    }

    // Call our parent to setup the camera portion of the doorbell.
    await super.configureDevice();

    // Let's setup the doorbell-specific attributes.
    this.configureVideoDoorbell();
    this.nvr.doorbellCount++;

    // Configure the contact sensor, if we have one.
    this.configureContactSensor();

    // Now, make the doorbell LCD message functionality available.
    return this.configureDoorbellLcdSwitch();

  }

  // Configure the doorbell service for HomeKit.
  private configureVideoDoorbell(): boolean {

    // Clear out any previous doorbell service.
    let doorbellService = this.accessory.getService(this.hap.Service.Doorbell);

    // Add the doorbell service to this Protect doorbell. HomeKit requires the doorbell service to be
    // marked as the primary service on the accessory.
    if(!doorbellService) {
      doorbellService = new this.hap.Service.Doorbell(this.accessory.displayName);

      if(!doorbellService) {
        this.log.error("%s: Unable to add doorbell.", this.name());
        return false;
      }

      this.accessory.addService(doorbellService);
    }

    doorbellService
      .getCharacteristic(this.hap.Characteristic.ProgrammableSwitchEvent)
      .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {

        // Provide the status of this doorbell. This must always return null, per the HomeKit spec.
        callback(null, null);
      });

    doorbellService.setPrimaryService(true);
    return true;
  }

  // Configure a contact sensor for HomeKit to be used for automation purposes.
  private configureContactSensor(): boolean {

    // Clear out any previous contact sensor service.
    let contactService = this.accessory.getService(this.hap.Service.ContactSensor);

    // Contact sensors are primarily used for automation scenarios and are disabled by default.
    if(!this.nvr.optionEnabled(this.accessory.context.camera as ProtectCameraConfig, "ContactSensor", false)) {

      if(contactService) {
        this.accessory.removeService(contactService);
      }

      return false;
    }

    this.log.info("%s: Enabling doorbell contact sensor. This sensor can be used for the automation of doorbell ring events in HomeKit.", this.name());

    // We already have the contact sensor configured.
    if(contactService) {
      return true;
    }

    // Add the contact sensor to the doorbell.
    contactService = new this.hap.Service.ContactSensor(this.accessory.displayName + " Doorbell");

    if(!contactService) {
      this.log.error("%s: Unable to add contact sensor.", this.name());
      return false;
    }

    this.accessory.addService(contactService);

    return true;
  }

  // Configure our access to the Doorbell LCD screen.
  public configureDoorbellLcdSwitch(): boolean {

    const camera = this.accessory?.context.camera as ProtectCameraConfig;

    // If the user has disabled the doorbell message functionality - we're done.
    if(!this.isMessagesEnabled) {
      return false;
    }

    // Make sure we're configuring a camera device with an LCD screen (aka a doorbell).
    if((camera?.modelKey !== "camera") || !camera?.featureFlags.hasLcdScreen) {
      return false;
    }

    // Grab the consolidated list of messages from the doorbell and our configuration.
    const doorbellMessages = this.getMessages();

    // Check to see if any of our existing doorbell messages have disappeared.
    this.validateMessageSwitches(doorbellMessages);

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

      this.log.info("%s: Discovered doorbell message switch%s: %s.",
        this.name(), entry.duration ? " (" + (entry.duration / 1000).toString() + " seconds)" : "", entry.text);

      // Use the message switch, if it already exists.
      let switchService = this.accessory.getServiceById(this.hap.Service.Switch, entry.type + "." + entry.text);

      // It's a new message, let's create the service for it. Each message cannot exceed 30 characters, but
      // given that HomeKit allows for strings to be up to 64 characters long, this should be fine.
      if(!switchService) {
        switchService = new this.hap.Service.Switch(entry.text, entry.type + "." + entry.text);

        if(!switchService) {
          this.log.error("%s: Unable to add doorbell message switch: %s.", this.name(), entry.text);
          continue;
        }

        this.accessory.addService(switchService);
      }

      const duration = "duration" in entry ? entry.duration : this.defaultDuration;

      // Save the message switch in the list we maintain.
      this.messageSwitches.push({ duration: duration, service: switchService, state: false, text: entry.text, type: entry.type }) - 1;

      // Configure the message switch.
      switchService
        .getCharacteristic(this.hap.Characteristic.On)
        ?.on(CharacteristicEventTypes.GET, this.getSwitchState.bind(this, this.messageSwitches[this.messageSwitches.length - 1]))
        .on(CharacteristicEventTypes.SET, this.setSwitchState.bind(this, this.messageSwitches[this.messageSwitches.length - 1]));
    }

    // Update the message switch state in HomeKit.
    this.updateLcdSwitch(camera.lcdMessage);

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

      const camera = this.accessory.context.camera as ProtectCameraConfig;

      const doorbellMessage = camera.lcdMessage?.text ?? "";
      const doorbellDuration = (("resetAt" in camera.lcdMessage) && camera.lcdMessage.resetAt !== null) ?
        Math.round((camera.lcdMessage.resetAt - Date.now()) / 1000) : 0;

      // Publish the current message.
      this.nvr.mqtt?.publish(this.accessory, "message", JSON.stringify({ duration: doorbellDuration, message: doorbellMessage }));
      this.log.info("%s: Doorbell message information published via MQTT.", this.name());
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
          this.log.error("%s: Unable to process MQTT message: \"%s\". Error: %s.", this.name(), message.toString(), error.message);
        } else {
          this.log.error("%s: Unknown error has occurred: %s.", this.name(), error);
        }

        // Errors mean that we're done now.
        return;
      }

      // At a minimum, make sure a message was specified. If we have specified duration, make sure it's a number.
      // Our NaN test may seem strange - that's because NaN is the only JavaScript value that is treated as unequal
      // to itself. Meaning, you can always test if a value is NaN by checking it for equality to itself. Weird huh?
      if(!("message" in incomingPayload) || (("duration" in incomingPayload) && (incomingPayload.duration !== incomingPayload.duration))) {
        this.log.error("%s: Unable to process MQTT message: \"%s\".", this.name(), incomingPayload);
        return;
      }

      // If no duration specified, or a negative duration, we assume the default duration.
      if(!("duration" in incomingPayload) || (("duration" in incomingPayload) && (incomingPayload.duration < 0))) {
        incomingPayload.duration = this.defaultDuration;
      } else {
        incomingPayload.duration = incomingPayload.duration * 1000;
      }

      // No message defined...we assume we're resetting the message.
      if(!incomingPayload.message.length) {
        outboundPayload = { resetAt: 0 };
        this.log.info("%s: Received MQTT doorbell message reset.", this.name());
      } else {
        outboundPayload = { duration: incomingPayload.duration, text: incomingPayload.message, type: "CUSTOM_MESSAGE" };
        this.log.info("%s: Received MQTT doorbell message%s: %s.",
          this.name(),
          outboundPayload.duration ? " (" + (outboundPayload.duration / 1000).toString() + " seconds)" : "",
          outboundPayload.text);
      }

      // Send it to the doorbell and we're done.
      void this.setMessage(outboundPayload);
    });

    return true;
  }

  // Get the list of messages from the doorbell and the user configuration.
  private getMessages(): MessageInterface[] {

    // First, we get our builtin and configured messages from the controller.
    const doorbellSettings = this.nvr?.nvrApi?.bootstrap?.nvr?.doorbellSettings;

    // Something's not right with the configuration...we're done.
    if(!doorbellSettings) {
      return [];
    }

    let doorbellMessages: MessageInterface[] = [];

    // Grab any messages that the user has configured.
    if(this.nvr.config.doorbellMessages) {
      for(const configEntry of this.nvr?.config?.doorbellMessages) {
        let duration = this.defaultDuration;

        // If we've set a duration, let's honor it. If it's less than zero, use the default duration.
        if(("duration" in configEntry) && !isNaN(configEntry.duration) && (configEntry.duration >= 0)) {
          duration = configEntry.duration * 1000;
        }

        // Add it to our list.
        doorbellMessages.push({ duration: duration, text: configEntry.message, type: "CUSTOM_MESSAGE" });
      }
    }

    // If we've got messages on the controller, let's configure those, unless the user has disabled that feature.
    if(this.isMessagesFromControllerEnabled && doorbellSettings.allMessages.length) {
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

      this.log.info("%s: Removing saved doorbell message: %s.", this.name(), entry.text);

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
      this.log.info("%s: Removing saved doorbell message: %s.", this.name(), switchService.subtype?.slice(switchService.subtype.indexOf(".") + 1));
      this.accessory.removeService(switchService);
    }
  }

  // Update the message switch state in HomeKit.
  public updateLcdSwitch(lcdMessage: ProtectCameraLcdMessagePayload): void {

    // The message has been cleared on the doorbell, turn off all message switches in HomeKit.
    if(!Object.keys(lcdMessage).length) {
      for(const lcdEntry of this.messageSwitches) {
        lcdEntry.state = false;
        lcdEntry.service.getCharacteristic(this.hap.Characteristic.On).updateValue(false);
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
        lcdEntry.service.getCharacteristic(this.hap.Characteristic.On).updateValue(false);
        continue;
      }

      // If the message switch is already on, we're done.
      if(lcdEntry.state) {
        continue;
      }

      // Set the message state and update HomeKit.
      lcdEntry.state = true;
      lcdEntry.service.getCharacteristic(this.hap.Characteristic.On).updateValue(true);

      this.log.info("%s: Doorbell message set%s: %s.", this.name(), lcdEntry.duration ? " (" + (lcdEntry.duration / 1000).toString() + " seconds)" : "", lcdEntry.text);

      // Publish to MQTT, if the user has configured it.
      this.nvr.mqtt?.publish(this.accessory, "message", JSON.stringify({ duration: lcdEntry.duration / 1000, message: lcdEntry.text }));
    }
  }

  // Get the current state of this message switch.
  private getSwitchState(messageSwitch: MessageSwitchInterface, callback: CharacteristicGetCallback): void {
    callback(null, messageSwitch.state);
  }

  // Toggle the message on the doorbell.
  private setSwitchState(messageSwitch: MessageSwitchInterface, value: CharacteristicValue, callback: CharacteristicSetCallback): void {

    // Tell the doorbell to display our message.
    if(messageSwitch.state !== value) {
      const payload: ProtectCameraLcdMessagePayload = (value === true) ?
        { duration: messageSwitch.duration, text: messageSwitch.text, type: messageSwitch.type } :
        { resetAt: 0 };

      // Set the message and sync our states.
      void this.setMessage(payload);
    }

    callback(null);
  }

  // Set the message on the doorbell.
  private async setMessage(payload: ProtectCameraLcdMessagePayload = { resetAt: 0 }): Promise<boolean> {

    // We take the duration and save it for MQTT and then translate the payload into what Protect is expecting from us.
    if("duration" in payload) {
      payload.resetAt = (payload.duration ? Date.now() + payload.duration : null);
      delete payload.duration;
    }

    // An empty payload means we're resetting. Set the reset timer to 0 and we're done.
    if(!Object.keys(payload).length) {
      payload.resetAt = 0;
    }

    // Push the update to the doorbell.
    const newCamera = await this.nvr.nvrApi.updateCamera(this.accessory.context.camera as ProtectCameraConfig, { lcdMessage: payload });

    if(!newCamera) {
      this.log.error("%s: Unable to set doorbell message. Please ensure this username has the Administrator role in UniFi Protect.", this.name());
      return false;
    }

    // Set the context to our updated camera configuration.
    this.accessory.context.camera = newCamera;
    return true;
  }
}
