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
import { ProtectCamera } from "./protect-camera";
import { ProtectCameraConfig } from "./protect-types";

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

// JSON payload for the doorbell message.
interface ProtectMessageJSONInterface {
  lcdMessage: {
    duration?: number,
    resetAt?: number | null,
    text?: string,
    type?: string
  }
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

    // We only want to deal with the G4 Doorbell for now.
    if((this.accessory.context.camera as ProtectCameraConfig)?.type !== "UVC G4 Doorbell") {
      return false;
    }

    // The user has disabled the doorbell message functionality.
    if(!this.nvr.optionEnabled(this.accessory.context.camera, "Messages")) {
      this.isMessagesEnabled = false;
    }

    // The user has disabled the doorbell message functionality.
    if(!this.nvr.optionEnabled(this.accessory.context.camera, "Messages.FromDoorbell")) {
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

    if(doorbellService) {
      this.accessory.removeService(doorbellService);
    }

    // Add the doorbell service to this Protect doorbell. HomeKit requires the doorbell service to be
    // marked as the primary service on the accessory.
    doorbellService = new this.hap.Service.Doorbell(this.accessory.displayName);

    this.accessory.addService(doorbellService)
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
    const accessory = this.accessory;
    const hap = this.hap;

    // Clear out any previous contact sensor service.
    let contactService = accessory.getService(hap.Service.ContactSensor);

    if(contactService) {
      accessory.removeService(contactService);
    }

    // If we haven't asked for a contact sensor, we're done here.
    if(!this.nvr.optionEnabled(this.accessory.context.camera, "ContactSensor", false)) {
      return false;
    }

    this.log("%s: Enabling doorbell contact sensor. This sensor can be used for the automation of doorbell ring events in HomeKit.", this.name());

    // Add the contact sensor to the doorbell.
    contactService = new hap.Service.ContactSensor(accessory.displayName + " Doorbell");
    accessory.addService(contactService);

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
      if(value?.toUpperCase() !== "true".toUpperCase()) {
        return;
      }

      const camera = this.accessory.context.camera as ProtectCameraConfig;

      const doorbellMessage = camera.lcdMessage?.text ?? "";
      const doorbellDuration = (("resetAt" in camera.lcdMessage) && camera.lcdMessage.resetAt !== null) ?
        Math.round((camera.lcdMessage.resetAt - Date.now()) / 1000) : 0;

      // Publish the current message.
      this.nvr.mqtt?.publish(this.accessory, "message", JSON.stringify({ message: doorbellMessage, duration: doorbellDuration }));
      this.log("%s: Doorbell message information published via MQTT.", this.name());
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
          this.log("%s: Unable to process MQTT message: \"%s\". Error: %s.", this.name(), message.toString(), error.message);
        } else {
          this.log("%s: Unknown error has occurred: %s", this.name(), error);
        }

        // Errors mean that we're done now.
        return;
      }

      // At a minimum, make sure a message was specified. If we have specified duration, make sure it's a number.
      // Our NaN test may seem strange - that's because NaN is the only JavaScript value that is treated as unequal
      // to itself. Meaning, you can always test if a value is NaN by checking it for equality to itself. Weird huh?
      if(!("message" in incomingPayload) || (("duration" in incomingPayload) && (incomingPayload.duration !== incomingPayload.duration))) {
        this.log("%s: Unable to process MQTT message: \"%s\".", this.name(), incomingPayload);
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
        outboundPayload = { lcdMessage: {} };
        this.log("%s: Received MQTT doorbell message reset.", this.name());
      } else {
        outboundPayload = { lcdMessage: { duration: incomingPayload.duration, text: incomingPayload.message, type: "CUSTOM_MESSAGE" } };
        this.log("%s: Received MQTT doorbell message%s: %s.",
          this.name(),
          outboundPayload.lcdMessage.duration ? " (" + (outboundPayload.lcdMessage.duration / 1000).toString() + " seconds)" : "",
          outboundPayload.lcdMessage.text);
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

      this.log("%s: Removing saved doorbell message: %s.", this.name(), entry.text);

      // This entry is now stale, delete it.
      this.accessory.removeService(entry.service);
      this.messageSwitches.splice(this.messageSwitches.indexOf(entry), 1);
    }
  }

  // Sync our HomeKit switch states with what we see on the doorbell.
  private syncSwitches(): void {
    const camera = this.accessory.context.camera as ProtectCameraConfig;

    // Loop through the list of services on our doorbell accessory.
    for(const switchService of this.accessory.services) {

      // We only want to look at switches.
      if(!(switchService instanceof this.hap.Service.Switch)) {
        continue;
      }

      // We don't want to touch any reserved switch types here. If it's a non-reserved type, it's fair game.
      if(this.isReservedName(switchService.subtype)) {
        continue;
      }

      // Find this entry in the list we maintain.
      const lcdEntry = this.messageSwitches?.find(x => (x.type + "." + x.text) === switchService.subtype);

      // We've no longer got this message - remove it and inform the user about it.
      if(!lcdEntry) {
        this.log("%s: Removing saved doorbell message: %s.",
          this.name(), switchService.subtype?.slice(switchService.subtype.indexOf(".") + 1));
        this.accessory.removeService(switchService);
        continue;
      }

      // We have this one in our known list of messages. Compare it with the message on the doorbell, and sync.
      const switchState = switchService.subtype === (camera.lcdMessage?.type + "." + camera.lcdMessage?.text);

      // Update the switch state, but only if needed.
      if(switchService.getCharacteristic(this.hap.Characteristic.On).value !== switchState) {
        switchService.getCharacteristic(this.hap.Characteristic.On).updateValue(switchState);
      }

      // Update our state information in our known list of messages.
      if(lcdEntry.state !== switchState) {

        lcdEntry.state = switchState;

        // Inform the user that the message has been set.
        if(switchState) {

          this.log("%s: Doorbell message set%s: %s.",
            this.name(), lcdEntry.duration ? " (" + (lcdEntry.duration / 1000).toString() + " seconds)" : "", lcdEntry.text);

          // Publish to MQTT, if the user has configured it.
          this.nvr.mqtt?.publish(this.accessory, "message", JSON.stringify({ message: lcdEntry.text, duration: lcdEntry.duration / 1000 }));
        }
      }
    }
  }

  // Configure our access to the Doorbell LCD screen.
  public configureDoorbellLcdSwitch(): boolean {

    const camera = this.accessory?.context.camera as ProtectCameraConfig;

    // If the user has disabled the doorbell message functionality - we're done.
    if(!this.isMessagesEnabled) {
      return false;
    }

    // At the moment, we only know about doing this for the G4 Doorbell.
    if((camera?.modelKey !== "camera") || (camera?.type !== "UVC G4 Doorbell")) {
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

      this.log("%s: Discovered doorbell message switch%s: %s.",
        this.name(), entry.duration ? " (" + (entry.duration / 1000).toString() + " seconds)" : "", entry.text);

      // Clear out any previous instance of this service.
      let switchService = this.accessory.getServiceById(this.hap.Service.Switch, entry.text);

      if(switchService) {
        this.accessory.removeService(switchService);
      }

      // It's a new message, let's create the service for it. Each message cannot exceed 30 characters, but
      // given that HomeKit allows for strings to be up to 64 characters long, this should be fine.
      switchService = new this.hap.Service.Switch(entry.text, entry.type + "." + entry.text);

      const duration = "duration" in entry ? entry.duration : this.defaultDuration;

      // Save the message switch in the list we maintain.
      this.messageSwitches.push({ duration: duration, service: switchService, state: false, text: entry.text, type: entry.type }) - 1;

      // Configure the message switch.
      this.accessory.addService(switchService)
        .getCharacteristic(this.hap.Characteristic.On)
        ?.on(CharacteristicEventTypes.GET, this.getSwitchState.bind(this, this.messageSwitches[this.messageSwitches.length - 1]))
        .on(CharacteristicEventTypes.SET, this.setSwitchState.bind(this, this.messageSwitches[this.messageSwitches.length - 1]));
    }

    // Sync message switch states between HomeKit and the doorbell.
    this.syncSwitches();

    return true;
  }

  // Get the current state of this message switch.
  private getSwitchState(messageSwitch: MessageSwitchInterface, callback: CharacteristicGetCallback): void {
    callback(null, messageSwitch.state);
  }

  // Toggle the message on the doorbell.
  private setSwitchState(messageSwitch: MessageSwitchInterface, value: CharacteristicValue, callback: CharacteristicSetCallback): void {

    // Tell the doorbell to display our message.
    if(messageSwitch.state !== value) {
      const payload: ProtectMessageJSONInterface = (value === true) ?
        { lcdMessage: { duration: messageSwitch.duration, text: messageSwitch.text, type: messageSwitch.type } } :
        { lcdMessage: {} };

      // Set the message and sync our states.
      void this.setMessage(payload);
    }

    callback(null);
  }

  // Set the message on the doorbell.
  private async setMessage(payload: ProtectMessageJSONInterface = { lcdMessage: {} }): Promise<boolean> {

    // We take the duration and save it for MQTT and then translate the payload into what Protect is expecting from us.
    if("duration" in payload.lcdMessage) {
      payload.lcdMessage.resetAt = (payload.lcdMessage.duration ? Date.now() + payload.lcdMessage.duration : null);
      delete payload.lcdMessage.duration;
    }

    // Push the update to the doorbell.
    const newCamera = await this.nvr.nvrApi.updateCamera(this.accessory.context.camera, payload);

    if(!newCamera) {
      this.log("%s: Unable to set doorbell message. Please ensure this username has the Administrator role in UniFi Protect.", this.name());
      return false;
    }

    // Set the context to our updated camera configuration.
    this.accessory.context.camera = newCamera;
    return true;
  }
}
