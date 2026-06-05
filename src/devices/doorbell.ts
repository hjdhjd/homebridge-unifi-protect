/* Copyright(C) 2019-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-doorbell.ts: Doorbell device class for UniFi Protect.
 */
import type { Camera, DeepPartial, ProtectCameraLcdMessageConfig, ProtectChimeConfig } from "unifi-protect";
import type { CharacteristicValue, PlatformAccessory, Service } from "homebridge";
import { PLATFORM_NAME, PLUGIN_NAME, PROTECT_DOORBELL_CHIME_DURATION_DIGITAL } from "../settings.ts";
import { sanitizeName, toStartCase } from "homebridge-plugin-utils";
import { selectCamera, selectChimes } from "unifi-protect";
import type { Nullable } from "homebridge-plugin-utils";
import { ProtectCamera } from "./camera.ts";
import { ProtectCameraPackage } from "./camera-package.ts";
import type { ProtectNvr } from "../nvr.ts";
import { ProtectReservedNames } from "../types.ts";

// A doorbell message entry.
interface MessageInterface {

  duration: number;
  text: string;
  type: string;
}

// Extend the message interface to include a doorbell message switch.
export interface MessageSwitchInterface extends MessageInterface {

  service: Service;
  state: boolean;
}

// Compute a doorbell's effective chime volume: the mean of the per-doorbell ring volume across every chime assigned to it (a chime can serve multiple doorbells), or 0
// when none is assigned. Pure over config records so the read-through getter and the volume observer share one definition of "this doorbell's volume".
const chimeVolumeFor = (chimes: readonly ProtectChimeConfig[], cameraId: string): number => {

  let total = 0;
  let count = 0;

  for(const chime of chimes) {

    const ring = chime.cameraIds.includes(cameraId) ? chime.ringSettings.find(setting => setting.cameraId === cameraId) : undefined;

    if(!ring) {

      continue;
    }

    total += ring.volume;
    count++;
  }

  return count ? (total / count) : 0;
};

export class ProtectDoorbell extends ProtectCamera {

  private chimeDigitalDuration: number;
  private defaultMessageDuration: number;
  private isMessagesEnabled: boolean;
  private isMessagesFromControllerEnabled: boolean;

  constructor(nvr: ProtectNvr, accessory: PlatformAccessory, device: Camera) {

    super(nvr, accessory, device);

    /* eslint-disable @typescript-eslint/no-unnecessary-condition */
    this.chimeDigitalDuration ??= PROTECT_DOORBELL_CHIME_DURATION_DIGITAL;
    this.defaultMessageDuration ??= 60000;
    this.isMessagesEnabled ??= false;
    this.isMessagesFromControllerEnabled ??= false;
    /* eslint-enable @typescript-eslint/no-unnecessary-condition */
  }

  // Configure the doorbell for HomeKit.
  protected configureDevice(): boolean {

    this.chimeDigitalDuration = this.getFeatureNumber("Doorbell.PhysicalChime.Duration.Digital") ?? PROTECT_DOORBELL_CHIME_DURATION_DIGITAL;
    this.defaultMessageDuration = this.nvr.ufp.doorbellSettings?.defaultMessageResetTimeoutMs ?? 60000;
    this.isMessagesEnabled = this.hasFeature("Doorbell.Messages");
    this.isMessagesFromControllerEnabled = this.hasFeature("Doorbell.Messages.FromDoorbell");
    this.messageSwitches = new Map();
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

  // This accessory already runs as a doorbell, so the inherited camera-to-doorbell reclassification reaction is a no-op for us and does not spawn.
  protected override get isDoorbellAccessory(): boolean {

    return true;
  }

  // Spawn the doorbell's narrow-selector observers on top of the camera's. The camera reactions (video, availability, night vision, status indicator, recording, tamper
  // setting) are inherited through super; the doorbell adds its own device-state reactions. Doorbell-ring delivery and the package camera's motion are firehose
  // occurrences the router handles, not observed here.
  protected override spawnObservers(): void {

    super.spawnObservers();

    const cam = selectCamera(this.ufp.id);

    // Reflect the controller's current LCD message across the doorbell's message switches.
    this.observeState({ key: "doorbell.lcdMessage", selector: state => cam(state)?.lcdMessage, title: "the doorbell message" }, () => {

      if(this.ufp.lcdMessage) {

        this.updateLcdSwitch(this.ufp.lcdMessage);
      }
    });

    // The package camera capability can be provisioned after adoption (a doorbell that was not fully provisioned when first adopted); bring the package camera into
    // being the first time the controller reports it.
    this.observeState({ key: "doorbell.hasPackageCamera", selector: state => cam(state)?.featureFlags.hasPackageCamera, title: "the package camera" }, () => {

      if(!this.packageCamera && this.ufp.featureFlags.hasPackageCamera) {

        this.configurePackageCamera();
      }
    });

    // Reflect the active physical-chime mode across the chime switches.
    this.observeState({ key: "doorbell.chimeDuration", selector: state => cam(state)?.chimeDuration, title: "the chime" }, () => this.updatePhysicalChimes());

    // Restore the cross-device volume reactivity v4's chimeEventHandler provided: when this doorbell's effective chime volume changes on the controller (a ring-volume
    // edit on any assigned chime), push it to the volume Lightbulb. The selector returns the computed volume, so the store's value dedup wakes this only on a real
    // change, not on every unrelated chime patch. A blessed refinement over v4, which pushed one chime's volume, not the mean - now consistent with the onGet.
    this.observeState({ key: "doorbell.chimeVolume", selector: state => chimeVolumeFor(selectChimes(state), this.ufp.id), title: "the chime volume" },
      () => this.updateChimeVolume());
  }

  // Configure our access to the doorbell LCD screen.
  private configureDoorbellLcdSwitch(): boolean {

    // Make sure we're configuring a doorbell with an LCD screen.
    if(!this.ufp.featureFlags.hasLcdScreen) {

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
      if(this.messageSwitches.has(switchIndex)) {

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
      this.messageSwitches.set(switchIndex, { duration: duration, service: service, state: false, text: entry.text, type: entry.type });

      // Configure the message switch.
      service.getCharacteristic(this.hap.Characteristic.On).onSet(async (value: CharacteristicValue) => {

        // Lookup the message switch.
        const messageSwitch = this.messageSwitches.get(switchIndex);

        // If we're already in the state we want to be in, we're done.
        if(!messageSwitch || (messageSwitch.state === value)) {

          return;
        }

        // Set the message and sync our states.
        await this.setMessage((value === true) ? { duration: messageSwitch.duration, text: messageSwitch.text, type: messageSwitch.type } : { resetAt: Date.now() });
      });
    }

    // Update the message switch state in HomeKit.
    if(this.ufp.lcdMessage) {

      this.updateLcdSwitch(this.ufp.lcdMessage);
    }

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
    let packageCameraAccessory = this.platform.accessories.find((x: PlatformAccessory) => x.UUID === uuid);

    // We can't find the accessory. Let's create it.
    if(!packageCameraAccessory) {

      // We use the camera's MAC address + ".PackageCamera" to create our UUID. That should provide the guaranteed uniqueness we need.
      packageCameraAccessory = new this.api.platformAccessory(sanitizeName(this.accessoryName + " Package Camera"), uuid);

      // Register this accessory with homebridge and add it to the accessory array so we can track it.
      if(this.hasFeature("Device.Standalone")) {

        this.api.publishExternalAccessories(PLUGIN_NAME, [packageCameraAccessory]);
      } else {

        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [packageCameraAccessory]);
      }

      this.platform.accessories.push(packageCameraAccessory);
      this.api.updatePlatformAccessories(this.platform.accessories);
    }

    // Now create the package camera accessory. The package camera is a HomeKit sub-view of this same physical device, so it shares our live camera projection rather
    // than holding a synthesized config snapshot. Its display name is the parent's name plus a " Package Camera" suffix, single-sourced from that projection and applied
    // by the package camera's own configureInfo override, then fanned out from this doorbell's configureInfo (firmware) and syncNameFromController (rename) so it tracks
    // the parent live, replacing v4's synthesized-suffixed-config snapshot.
    this.packageCamera = new ProtectCameraPackage(this.nvr, packageCameraAccessory, this.device);

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
      // If we don't have the physical capabilities or the feature option enabled, disable the switch and we're done.
      if(!this.validService(this.hap.Service.Switch, this.ufp.featureFlags.hasChime && this.hasFeature("Doorbell.PhysicalChime"), physicalChimeType)) {

        continue;
      }

      // Acquire the service.
      const service = this.acquireService(this.hap.Service.Switch, this.accessoryName + " Physical Chime " + toStartCase(chimeSetting), physicalChimeType);

      // Fail gracefully.
      if(!service) {

        this.log.error("Unable to add physical chime switch: %s.", chimeSetting);

        continue;
      }

      // Get the current status of the physical chime mode on the doorbell.
      service.getCharacteristic(this.hap.Characteristic.On).onGet(() => {

        return this.ufp.chimeDuration === this.getPhysicalChimeDuration(physicalChimeType);
      });

      // Activate the appropriate physical chime mode on the doorbell.
      service.getCharacteristic(this.hap.Characteristic.On).onSet(async (value: CharacteristicValue) => {

        // We only want to do something if we're being activated. Turning off the switch would really be an undefined state given that there are three different settings
        // one can choose from. Instead, we do nothing and leave it to the user to choose what state they really want to set.
        if(!value) {

          setTimeout(() => this.updateDevice(), 50);

          return;
        }

        // Push the new physical chime duration to the controller, reporting any failure through the shared command-error helper.
        if(!(await this.runDeviceCommand("set the physical chime mode to " + chimeSetting,
          () => this.device.update({ chimeDuration: this.getPhysicalChimeDuration(physicalChimeType) })))) {

          return;
        }

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
    if(!this.validService(this.hap.Service.Lightbulb, this.hasFeature("Doorbell.Volume.Dimmer"), ProtectReservedNames.LIGHTBULB_DOORBELL_VOLUME)) {

      return false;
    }

    // Acquire the service.
    const service = this.acquireService(this.hap.Service.Lightbulb, this.accessoryName + " Chime Volume", ProtectReservedNames.LIGHTBULB_DOORBELL_VOLUME);

    if(!service) {

      this.log.error("Unable to add chime volume control.");

      return false;
    }

    // Turn the chime on or off.
    service.getCharacteristic(this.hap.Characteristic.On).onGet(() => this.chimeVolume > 0);

    service.getCharacteristic(this.hap.Characteristic.On).onSet(async (value: CharacteristicValue) => {

      // We really only want to act when the volume is zero. Otherwise, it's handled by the brightness event.
      if(value) {

        return;
      }

      await this.setChimeVolume(0);
    });

    // Return the volume level of the chime.
    service.getCharacteristic(this.hap.Characteristic.Brightness).onGet(() => this.chimeVolume);

    // Adjust the volume of the chime by adjusting brightness of the light.
    service.getCharacteristic(this.hap.Characteristic.Brightness).onSet(async (value: CharacteristicValue) => this.setChimeVolume(value as number));

    // Initialize the chime.
    service.updateCharacteristic(this.hap.Characteristic.On, this.chimeVolume > 0);
    service.updateCharacteristic(this.hap.Characteristic.Brightness, this.chimeVolume);

    this.log.info("Enabling Protect chime volume control.");

    return true;
  }

  // Configure the contact sensor to indicate authentication success.
  private configureAuthSensor(): boolean {

    // Validate whether we should have this service enabled.
    // The authentication contact sensor is disabled by default unless the user enables it. We only make it available if we have at least one of the
    // fingerprint sensor or the NFC sensor available.
    if(!this.validService(this.hap.Service.ContactSensor, this.hasFeature("Doorbell.AuthSensor") && (this.ufp.enableNfc || this.ufp.featureFlags.hasFingerprintSensor),
      ProtectReservedNames.CONTACT_AUTHSENSOR)) {

      return false;
    }

    // Acquire the service.
    const service = this.acquireService(this.hap.Service.ContactSensor, this.accessoryName + " Authenticated", ProtectReservedNames.CONTACT_AUTHSENSOR);

    if(!service) {

      this.log.error("Unable to add authentication sensor.");

      return false;
    }

    // Initialize the authentication contact sensor.
    service.updateCharacteristic(this.hap.Characteristic.ContactSensorState, this.hap.Characteristic.ContactSensorState.CONTACT_DETECTED);

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

      const volume = parseInt(value);

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

      if(!this.ufp.lcdMessage) {

        return "";
      }

      const doorbellDuration = (typeof this.ufp.lcdMessage.resetAt === "number") ? Math.round((this.ufp.lcdMessage.resetAt - Date.now()) / 1000) : 0;

      // Return the current message.
      return JSON.stringify({ duration: doorbellDuration, message: this.ufp.lcdMessage.text ?? "" });
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

        message: string;
        duration: number;
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

      // At a minimum, make sure a message was specified. If we have a duration, make sure it's a valid number.
      if(!("message" in inboundPayload) || (("duration" in inboundPayload) && Number.isNaN(inboundPayload.duration))) {

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

  // Refresh doorbell-specific characteristics. Composes the inherited camera updaters (through super) with the doorbell's physical-chime update; the package camera's
  // availability is fanned out by the updateAvailability override below, which super.updateDevice() invokes.
  public override updateDevice(): boolean {

    super.updateDevice();

    this.updatePhysicalChimes();

    return true;
  }

  // Push the doorbell's availability projection: the inherited camera/light-sensor StatusActive plus the package camera's StatusActive, since the package camera is a
  // HomeKit sub-view of this same physical device and shares its reachability. Driven (through super.updateDevice / the lifecycle-state observer) by a connection change.
  protected override updateAvailability(): void {

    super.updateAvailability();

    this.packageCamera?.accessory.getService(this.hap.Service.MotionSensor)?.updateCharacteristic(this.hap.Characteristic.StatusActive, this.isReachable);
  }

  // Fan controller-health reachability out to the package camera as well as this accessory's own services. The package camera is a separate HomeKit accessory not held
  // in the NVR's configuredDevices, so the NVR connection-observe loop only ever calls this on the doorbell; we forward the same reachability to the package camera here
  // so a controller outage drives its StatusActive inactive too, matching the device-state fan-out in updateAvailability. We return the doorbell's own transition
  // unchanged for the reachability-fanout diagnostics.
  public override refreshReachability(): Nullable<{ now: boolean; was: boolean }> {

    const transition = super.refreshReachability();

    this.packageCamera?.accessory.getService(this.hap.Service.MotionSensor)?.updateCharacteristic(this.hap.Characteristic.StatusActive, this.isReachable);

    return transition;
  }

  // Fan the information refresh out to the package-camera sub-view, exactly as updateAvailability and refreshReachability fan out reachability. The base firmware-version
  // observer drives configureInfo on a controller firmware update; because the package camera shares this doorbell's physical device (and firmware) and observes nothing
  // itself, we drive its own configureInfo here so its suffixed display name and AccessoryInformation firmware revision track the shared device without a restart.
  // Null-safe for the construction window before configurePackageCamera runs - the package camera also refreshes its own info in its constructor.
  public override configureInfo(): boolean {

    const result = super.configureInfo();

    this.packageCamera?.configureInfo();

    return result;
  }

  // Fan a controller-side name change out to the package-camera sub-view - the fourth parent-to-sub-view fan-out alongside configureInfo, updateAvailability, and
  // refreshReachability. The base name observer drives syncNameFromController on the doorbell; the package camera re-derives its own suffixed name from the shared
  // projection in its configureInfo, so re-running it here keeps the sub-view's display name tracking parent renames live, without the package camera observing anything.
  protected override syncNameFromController(): void {

    super.syncNameFromController();

    this.packageCamera?.configureInfo();
  }

  // Push the physical-chime switch states from the doorbell's current chime duration, when the doorbell has a chime and the switches are configured. Driven by the
  // chimeDuration observer.
  private updatePhysicalChimes(): void {

    if(!this.ufp.featureFlags.hasChime || !this.hasFeature("Doorbell.PhysicalChime")) {

      return;
    }

    // Reflect the active physical-chime mode across the three mutually-exclusive switches.
    for(const physicalChimeType of
      [ ProtectReservedNames.SWITCH_DOORBELL_CHIME_NONE, ProtectReservedNames.SWITCH_DOORBELL_CHIME_MECHANICAL, ProtectReservedNames.SWITCH_DOORBELL_CHIME_DIGITAL ]) {

      this.accessory.getServiceById(this.hap.Service.Switch, physicalChimeType)?.
        updateCharacteristic(this.hap.Characteristic.On, this.ufp.chimeDuration === this.getPhysicalChimeDuration(physicalChimeType));
    }
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
    for(const [ key, entry ] of this.messageSwitches) {

      // This exists on the doorbell...move along.
      if(this.messageSwitches.has(entry.type + "." + entry.text)) {

        continue;
      }

      this.log.info("Removing saved doorbell message: %s.", entry.text);

      // The message has been deleted on the doorbell, remove it in HomeKit.
      this.accessory.removeService(entry.service);
      this.messageSwitches.delete(key);
    }

    // Loop through the list of services on our doorbell accessory and sync the message switches. We do this to catch the scenario where Homebridge was shutdown, and the
    // list of saved messages on the controller changes.
    for(const switchService of this.accessory.services.filter(service => (service.UUID === this.hap.Service.Switch.UUID) && service.subtype &&
      !this.isReservedName(service.subtype) && !this.messageSwitches.has(service.subtype))) {

      // The message has been deleted on the doorbell - remove it from HomeKit and inform the user about it.
      this.log.info("Removing saved doorbell message: %s.", switchService.subtype?.slice(switchService.subtype.indexOf(".") + 1));
      this.accessory.removeService(switchService);
    }
  }

  // Update the message switch state in HomeKit.
  private updateLcdSwitch(payload: DeepPartial<ProtectCameraLcdMessageConfig>): void {

    // The message has been cleared on the doorbell, turn off all message switches in HomeKit.
    if(!Object.keys(payload).length) {

      for(const entry of this.messageSwitches.values()) {

        entry.state = false;
        entry.service.updateCharacteristic(this.hap.Characteristic.On, false);
      }

      return;
    }

    // Sanity check.
    if(!("type" in payload) || !("text" in payload)) {

      return;
    }

    // The message has been set on the doorbell. Update HomeKit accordingly.
    for(const [ key, entry ] of this.messageSwitches) {

      // If it's not the message we're interested in, make sure it's off and keep going.
      if(key !== ((payload.type ?? "") + "." + (payload.text ?? ""))) {

        entry.state = false;
        entry.service.updateCharacteristic(this.hap.Characteristic.On, false);

        continue;
      }

      // If the message switch is already on, we're done.
      if(entry.state) {

        continue;
      }

      // Set the message state and update HomeKit.
      entry.state = true;
      entry.service.updateCharacteristic(this.hap.Characteristic.On, true);

      this.log.info("Doorbell message set%s: %s.",
        payload.resetAt !== null ? " (" + Math.round(((payload.resetAt ?? 0) - Date.now()) / 1000).toString() + " seconds)" : "", payload.text);

      // Publish to MQTT, if the user has configured it.
      this.publish("message", JSON.stringify({ duration: entry.duration / 1000, message: entry.text }));
    }
  }

  // Set the message on the doorbell.
  private async setMessage(payload: DeepPartial<ProtectCameraLcdMessageConfig> = {}): Promise<boolean> {

    // We take the duration and save it for MQTT and then translate the payload into what Protect is expecting from us.
    if("duration" in payload) {

      payload.resetAt = payload.duration ? Date.now() + payload.duration : null;
      delete payload.duration;
    }

    // Push the update to the doorbell, reporting any failure through the shared command-error helper. An empty payload resets the LCD message back to its default.
    return this.runDeviceCommand("set the doorbell message", () => this.device.update({ lcdMessage: payload }));
  }

  // This doorbell's effective chime volume, read through the live v5 chime projections. We delegate to the shared chimeVolumeFor helper over selectChimes of the current
  // snapshot - the identical input the volume observer reduces - so the read-through getter and the reactive push share one definition of "this doorbell's volume".
  // selectChimes is always an array post-connect, so the old bootstrap-missing guard is gone.
  private get chimeVolume(): number {

    return chimeVolumeFor(selectChimes(this.nvr.client.state.snapshot()), this.ufp.id);
  }

  private async setChimeVolume(value: number): Promise<void> {

    // Clamp to a non-negative volume.
    value = Math.max(value, 0);

    // A chime can be assigned to multiple doorbells, so update the ring entry for THIS doorbell on every chime that serves it. Write-through: each update PATCHes the
    // controller and the change is reflected once the reducer's stream delivers it - we no longer fold the response back into local state (v5 state is immutable and
    // single-sourced in the reducer), nor mutate the ring in place. We send a single-entry ringSettings array carrying only the modified ring, matching v4's payload.
    for(const chime of this.nvr.client.chimes.filter(chime => chime.config.cameraIds.includes(this.ufp.id))) {

      const ring = chime.config.ringSettings.find(setting => setting.cameraId === this.ufp.id);

      if(!ring) {

        continue;
      }

      // eslint-disable-next-line no-await-in-loop
      if(!(await this.runDeviceCommand("set the chime volume", () => chime.update({ ringSettings: [{ ...ring, volume: value }] })))) {

        return;
      }
    }

    this.publish("chime", value.toString());
  }

  // Push the chime-volume projection onto the doorbell's volume Lightbulb. Shares the read path (chimeVolume / chimeVolumeFor) with the onGet handlers, so the displayed
  // volume and the live value never disagree. Idempotent - HomeKit coalesces an unchanged write.
  private updateChimeVolume(): void {

    const volume = this.chimeVolume;
    const service = this.accessory.getServiceById(this.hap.Service.Lightbulb, ProtectReservedNames.LIGHTBULB_DOORBELL_VOLUME);

    service?.updateCharacteristic(this.hap.Characteristic.Brightness, volume);
    service?.updateCharacteristic(this.hap.Characteristic.On, volume > 0);
  }
}
