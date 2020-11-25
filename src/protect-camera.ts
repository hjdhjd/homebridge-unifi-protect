/* Copyright(C) 2019-2020, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-camera.ts: Camera device class for UniFi Protect.
 */
import {
  CharacteristicEventTypes,
  CharacteristicGetCallback,
  CharacteristicSetCallback,
  CharacteristicValue
} from "homebridge";
import { ProtectCameraChannelConfig, ProtectCameraConfig, ProtectNvrBootstrap } from "./protect-types";
import { ProtectAccessory } from "./protect-accessory";
import { ProtectApi } from "./protect-api";
import { ProtectNvr } from "./protect-nvr";
import { ProtectStreamingDelegate } from "./protect-stream";

// Manage our switch types.
export const PROTECT_SWITCH_DOORBELL_TRIGGER = "DoorbellTrigger";
export const PROTECT_SWITCH_MOTION_SENSOR = "MotionSensorSwitch";
export const PROTECT_SWITCH_MOTION_TRIGGER = "MotionSensorTrigger";

export interface RtspEntry {
  channel: ProtectCameraChannelConfig,
  name: string,
  resolution: [ number, number, number],
  url: string
}

export class ProtectCamera extends ProtectAccessory {
  private isDoorbellConfigured!: boolean;
  public isRinging!: boolean;
  public isSmartMotionEnabled!: boolean;
  private isVideoConfigured!: boolean;
  private rtspEntries!: RtspEntry[];
  private rtspQuality!: { [index: string]: string };
  public snapshotUrl!: string;
  public stream!: ProtectStreamingDelegate;
  public twoWayAudio!: boolean;

  // Configure a camera accessory for HomeKit.
  protected async configureDevice(): Promise<boolean> {

    this.isDoorbellConfigured = false;
    this.isRinging = false;
    this.isSmartMotionEnabled = false;
    this.isVideoConfigured = false;
    this.rtspQuality = {};

    // Save the camera object before we wipeout the context.
    const camera = this.accessory.context.camera as ProtectCameraConfig;

    // Default motion detection support to on.
    let detectMotion = true;

    // Save the motion sensor switch state before we wipeout the context.
    if(this.accessory.context.detectMotion !== undefined) {
      detectMotion = this.accessory.context.detectMotion as boolean;
    }

    // Clean out the context object in case it's been polluted somehow.
    this.accessory.context = {};
    this.accessory.context.camera = camera;
    this.accessory.context.nvr = this.nvr.nvrApi.bootstrap?.nvr.mac;
    this.accessory.context.detectMotion = detectMotion;

    // If we're on UniFi OS, and the camera supports it, check to see if we have smart motion events enabled.
    if(this.nvrApi.isUnifiOs && camera.featureFlags.hasSmartDetect && this.nvr?.optionEnabled(camera, "Motion.SmartDetect", false)) {

      this.log.info("%s: Smart motion detection enabled.", this.name());
      this.isSmartMotionEnabled = true;
    }

    // Configure accessory information.
    this.configureInfo();

    // Configure MQTT services.
    this.configureMqtt();

    // Configure the motion sensor.
    this.configureMotionSensor();
    this.configureMotionSwitch();
    this.configureMotionTrigger();

    // Configure two-way audio support and our video stream.
    this.configureTwoWayAudio();
    await this.configureVideoStream();

    // Configure the doorbell trigger.
    this.configureDoorbellTrigger();

    return true;
  }

  // Configure the camera device information for HomeKit.
  private configureInfo(): boolean {
    const accessory = this.accessory;
    const camera = accessory.context.camera as ProtectCameraConfig;
    const hap = this.hap;

    // Update the manufacturer information for this camera.
    accessory
      .getService(hap.Service.AccessoryInformation)
      ?.updateCharacteristic(hap.Characteristic.Manufacturer, "Ubiquiti Networks");

    // Update the model information for this camera.
    accessory
      .getService(hap.Service.AccessoryInformation)
      ?.updateCharacteristic(hap.Characteristic.Model, camera.type);

    // Update the serial number for this camera.
    accessory
      .getService(hap.Service.AccessoryInformation)
      ?.updateCharacteristic(hap.Characteristic.SerialNumber, camera.mac);

    // Update the hardware revision for this camera.
    accessory
      .getService(hap.Service.AccessoryInformation)
      ?.updateCharacteristic(hap.Characteristic.HardwareRevision, camera.hardwareRevision);

    // Update the firmware revision for this camera.
    accessory
      .getService(hap.Service.AccessoryInformation)
      ?.updateCharacteristic(hap.Characteristic.FirmwareRevision, camera.firmwareVersion);

    return true;
  }

  // Configure the camera motion sensor for HomeKit.
  private configureMotionSensor(): boolean {
    const accessory = this.accessory;
    const hap = this.hap;

    // Find the motion sensor service, if it exists.
    let motionService = accessory.getService(hap.Service.MotionSensor);

    // Have we disabled motion sensors?
    if(!this.nvr?.optionEnabled(accessory.context.camera as ProtectCameraConfig, "Motion.Sensor")) {

      if(motionService) {
        accessory.removeService(motionService);
      }

      this.log.info("%s: Disabling motion sensor.", this.name());
      return false;
    }

    // The motion sensor has already been configured.
    if(motionService) {
      return true;
    }

    // We don't have it, add the motion sensor to the camera.
    motionService = new hap.Service.MotionSensor(accessory.displayName);

    if(!motionService) {
      this.log.error("%s: Unable to add motion sensor.", this.name());
      return false;
    }

    accessory.addService(motionService);
    return true;
  }

  // Configure a switch to easily activate or deactivate motion sensor detection for HomeKit.
  private configureMotionSwitch(): boolean {

    // Find the switch service, if it exists.
    let switchService = this.accessory.getServiceById(this.hap.Service.Switch, PROTECT_SWITCH_MOTION_SENSOR);

    // Have we disabled motion sensors or the motion switch? Motion switches are disabled by default.
    if(!this.nvr?.optionEnabled(this.accessory.context.camera as ProtectCameraConfig, "Motion.Sensor") ||
      !this.nvr?.optionEnabled(this.accessory.context.camera as ProtectCameraConfig, "Motion.Switch", false)) {

      if(switchService) {
        this.accessory.removeService(switchService);
      }

      // If we disable the switch, make sure we fully reset it's state.
      this.accessory.context.detectMotion = true;
      return false;
    }

    this.log.info("%s: Enabling motion sensor switch.", this.name());

    // Add the switch to the camera, if needed.
    if(!switchService) {
      switchService = new this.hap.Service.Switch(this.accessory.displayName + " Motion Events", PROTECT_SWITCH_MOTION_SENSOR);

      if(!switchService) {
        this.log.error("%s: Unable to add motion sensor switch.", this.name());
        return false;
      }

      this.accessory.addService(switchService);
    }

    // Activate or deactivate motion detection.
    switchService
      .getCharacteristic(this.hap.Characteristic.On)
      ?.on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
        callback(null, this.accessory.context.detectMotion === true);
      })
      .on(CharacteristicEventTypes.SET, (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
        if(this.accessory.context.detectMotion !== value) {
          this.log.info("%s: Motion detection %s.", this.name(), (value === true) ? "enabled" : "disabled");
        }

        this.accessory.context.detectMotion = value === true;
        callback(null);
      });

    // Initialize the switch.
    switchService.updateCharacteristic(this.hap.Characteristic.On, this.accessory.context.detectMotion as boolean);

    return true;
  }

  // Configure a switch to manually trigger a motion sensor event for HomeKit.
  private configureMotionTrigger(): boolean {

    // Find the switch service, if it exists.
    let triggerService = this.accessory.getServiceById(this.hap.Service.Switch, PROTECT_SWITCH_MOTION_TRIGGER);

    // Motion triggers are disabled by default and primarily exist for automation purposes.
    if(!this.nvr?.optionEnabled(this.accessory.context.camera as ProtectCameraConfig, "Motion.Sensor") ||
      !this.nvr?.optionEnabled(this.accessory.context.camera as ProtectCameraConfig, "Motion.Trigger", false)) {

      if(triggerService) {
        this.accessory.removeService(triggerService);
      }

      return false;
    }

    // Add the switch to the camera, if needed.
    if(!triggerService) {
      triggerService = new this.hap.Service.Switch(this.accessory.displayName + " Motion Trigger", PROTECT_SWITCH_MOTION_TRIGGER);

      if(!triggerService) {
        this.log.error("%s: Unable to add motion sensor trigger.", this.name());
        return false;
      }

      this.accessory.addService(triggerService);
    }

    const motionService = this.accessory.getService(this.hap.Service.MotionSensor);
    const switchService = this.accessory.getServiceById(this.hap.Service.Switch, PROTECT_SWITCH_MOTION_SENSOR);

    // Activate or deactivate motion detection.
    triggerService
      .getCharacteristic(this.hap.Characteristic.On)
      ?.on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
        callback(null, motionService?.getCharacteristic(this.hap.Characteristic.MotionDetected).value);
      })
      .on(CharacteristicEventTypes.SET, (value: CharacteristicValue, callback: CharacteristicSetCallback) => {

        if(value) {

          // Check to see if motion events are disabled.
          if(switchService && !switchService.getCharacteristic(this.hap.Characteristic.On).value) {
            setTimeout(() => {
              triggerService?.updateCharacteristic(this.hap.Characteristic.On, false);
            }, 50);

          } else {

            // Trigger the motion event.
            this.nvr.events.motionEventHandler(this.accessory, Date.now());
            this.log.info("%s: Motion event triggered.", this.name());
          }

        } else {

          // If the motion sensor is still on, we should be as well.
          if(motionService?.getCharacteristic(this.hap.Characteristic.MotionDetected).value) {
            setTimeout(() => {
              triggerService?.updateCharacteristic(this.hap.Characteristic.On, true);
            }, 50);
          }
        }

        callback(null);
      });

    // Initialize the switch.
    triggerService.updateCharacteristic(this.hap.Characteristic.On, false);

    this.log.info("%s: Enabling motion sensor automation trigger.", this.name());

    return true;
  }

  // Configure a switch to manually trigger a doorbell ring event for HomeKit.
  private configureDoorbellTrigger(): boolean {

    const camera = (this.accessory.context.camera as ProtectCameraConfig);

    // Find the switch service, if it exists.
    let triggerService = this.accessory.getServiceById(this.hap.Service.Switch, PROTECT_SWITCH_DOORBELL_TRIGGER);

    // See if we have a doorbell service configured.
    let doorbellService = this.accessory.getService(this.hap.Service.Doorbell);

    // Doorbell switches are disabled by default and primarily exist for automation purposes.
    if(!this.nvr?.optionEnabled(this.accessory.context.camera as ProtectCameraConfig, "Doorbell.Trigger", false)) {

      if(triggerService) {
        this.accessory.removeService(triggerService);
      }

      // Since we aren't enabling the doorbell trigger on this camera, remove the doorbell service if the camera
      // isn't actually doorbell-capable hardware.
      if(!camera.featureFlags.hasChime && doorbellService) {
        this.accessory.removeService(doorbellService);
      }

      return false;
    }

    // We don't have a doorbell service configured, but since we've enabled a doorbell switch, we create the doorbell for
    // automation purposes.
    if(!doorbellService) {

      // Configure the doorbell service.
      if(!this.configureVideoDoorbell()) {
        return false;
      }

      // Now find the doorbell service.
      if(!(doorbellService = this.accessory.getService(this.hap.Service.Doorbell))) {
        this.log.error("%s: Unable to find the doorbell service.", this.name());
        return false;
      }
    }

    // Add the switch to the camera, if needed.
    if(!triggerService) {
      triggerService = new this.hap.Service.Switch(this.accessory.displayName + " Doorbell Trigger", PROTECT_SWITCH_DOORBELL_TRIGGER);

      if(!triggerService) {
        this.log.error("%s: Unable to add the doorbell trigger.", this.name());
        return false;
      }

      this.accessory.addService(triggerService);
    }

    // Trigger the doorbell.
    triggerService
      .getCharacteristic(this.hap.Characteristic.On)
      ?.on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
        callback(null, this.isRinging);
      })
      .on(CharacteristicEventTypes.SET, (value: CharacteristicValue, callback: CharacteristicSetCallback) => {

        if(value) {

          // Trigger the motion event.
          this.nvr.events.doorbellEventHandler(this.accessory, Date.now());
          this.log.info("%s: Doorbell ring event triggered.", this.name());

        } else {

          // If the doorbell ring event is still going, we should be as well.
          if(this.isRinging) {

            setTimeout(() => {
              triggerService?.updateCharacteristic(this.hap.Characteristic.On, true);
            }, 50);
          }
        }

        callback(null);
      });

    // Initialize the switch.
    triggerService.updateCharacteristic(this.hap.Characteristic.On, false);

    this.log.info("%s: Enabling doorbell automation trigger.", this.name());

    return true;
  }

  // Configure the doorbell service for HomeKit.
  protected configureVideoDoorbell(): boolean {

    // Only configure the doorbell service if we haven't configured it before.
    if(this.isDoorbellConfigured) {
      return true;
    }

    // Find the doorbell service, if it exists.
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
    this.isDoorbellConfigured = true;
    return true;
  }

  // Configure two-way audio support for HomeKit.
  private configureTwoWayAudio(): boolean {

    // Identify twoway-capable devices.
    if(!(this.accessory.context.camera as ProtectCameraConfig).hasSpeaker) {
      return this.twoWayAudio = false;
    }

    // Enabled by default unless disabled by the user.
    return this.twoWayAudio = this.nvr?.optionEnabled(this.accessory.context.camera as ProtectCameraConfig, "Audio") &&
      this.nvr?.optionEnabled(this.accessory.context.camera as ProtectCameraConfig, "Audio.TwoWay");
  }

  // Find an RTSP configuration for a given target resolution.
  public findRtsp(width: number, height: number, camera: ProtectCameraConfig | null = null, address = "", rtspEntries = this.rtspEntries): RtspEntry | null {

    // No RTSP entries to choose from, we're done.
    if(!rtspEntries || !rtspEntries.length) {
      return null;
    }

    // First, we check to see if we've set an explicit preference for the target address.
    if(camera && address) {

      // If we don't have this address cached, look it up and cache it.
      if(!this.rtspQuality[address]) {

        // Check to see if there's an explicit preference set and cache the result.
        if(this.nvr.optionEnabled(camera, "Video.Stream.Only.Low", false, address, true)) {
          this.rtspQuality[address] = "LOW";
        } else if(this.nvr.optionEnabled(camera, "Video.Stream.Only.Medium", false, address, true)) {
          this.rtspQuality[address] = "MEDIUM";
        } else if(this.nvr.optionEnabled(camera, "Video.Stream.Only.High", false, address, true)) {
          this.rtspQuality[address] = "HIGH";
        } else {
          this.rtspQuality[address] = "None";
        }
      }

      // If it's set to none, we default to our normal lookup logic.
      if(this.rtspQuality[address] !== "None") {
        return rtspEntries.find(x => x.channel.name.toUpperCase() === this.rtspQuality[address]) ?? null;
      }
    }

    // Second, we check to see if we've set an explicit preference for stream quality.
    if(this.rtspQuality.Default) {
      return rtspEntries.find(x => x.channel.name.toUpperCase() === this.rtspQuality.Default) ?? null;
    }

    // See if we have a match for our desired resolution on the camera. We ignore FPS - HomeKit clients seem
    // to be able to handle it just fine.
    const exactRtsp = rtspEntries.find(x => (x.resolution[0] === width) && (x.resolution[1] === height));

    if(exactRtsp) {
      return exactRtsp;
    }

    // No match found, let's see what we have that's closest. We try to be a bit smart about how we select our
    // stream - if it's an HD quality stream request (720p+), we want to try to return something that's HD quality
    // before looking for something lower resolution.
    if((width >= 1280) && (height >= 720)) {

      for(const entry of rtspEntries) {

        // Make sure we're looking at an HD resolution.
        if(entry.resolution[0] < 1280) {
          continue;
        }

        // Return the first one we find.
        return entry;
      }
    }

    // If we didn't request an HD resolution, or we couldn't find anything HD to use, we try to find whatever we
    // can find that's close.
    for(const entry of rtspEntries) {
      if(width >= entry.resolution[0]) {
        return entry;
      }
    }

    // We couldn't find a close match, return the lowest resolution we found.
    return rtspEntries[rtspEntries.length - 1];
  }

  // Configure a camera accessory for HomeKit.
  public async configureVideoStream(): Promise<boolean> {

    const bootstrap: ProtectNvrBootstrap | null = this.nvr.nvrApi.bootstrap;
    let camera = this.accessory.context.camera as ProtectCameraConfig;
    const nvr: ProtectNvr = this.nvr;
    const nvrApi: ProtectApi = this.nvr.nvrApi;
    const rtspEntries: RtspEntry[] = [];

    // No channels exist on this camera or we don't have access to the bootstrap configuration.
    if(!camera?.channels || !bootstrap) {
      return false;
    }

    // Enable RTSP on the camera if needed and get the list of RTSP streams we have ultimately configured.
    camera = await nvrApi.enableRtsp(camera) ?? camera;

    // Figure out which camera channels are RTSP-enabled, and user-enabled.
    const cameraChannels = camera.channels.filter(x => x.isRtspEnabled && nvr.optionEnabled(camera, "Video.Stream." + x.name));

    // Set the camera and shapshot URLs.
    const cameraUrl = "rtsp://" + bootstrap.nvr.host + ":" + bootstrap.nvr.ports.rtsp.toString() + "/";
    this.snapshotUrl = nvrApi.camerasUrl() + "/" + camera.id + "/snapshot";

    // No RTSP streams are available that meet our criteria - we're done.
    if(!cameraChannels.length) {
      this.log.info("%s: No RTSP stream profiles have been configured for this camera. %s",
        this.name(),
        "Enable at least one RTSP stream profile in the UniFi Protect webUI to resolve this issue or " +
        "assign the Administrator role to the user configured for this plugin to allow it to automatically configure itself."
      );

      return false;
    }

    // Now that we have our RTSP streams, create a list of supported resolutions for HomeKit.
    for(const channel of cameraChannels) {
      rtspEntries.push({ channel: channel,
        name: channel.width.toString() + "x" + channel.height.toString() + "@" + channel.fps.toString() + "fps (" + channel.name + ")",
        resolution: [ channel.width, channel.height, channel.fps ], url: cameraUrl + channel.rtspAlias });
    }

    // Sort the list of resolutions, from high to low.
    rtspEntries.sort(this.sortByResolutions.bind(this));

    // Next, ensure we have mandatory resolutions required by HomeKit, as well as special support for Apple TV and Apple Watch:
    //   3840x2160@30 (4k).
    //   1920x1080@30 (1080p).
    //   1280x720@30 (720p).
    //   320x240@15 (Apple Watch).
    for(const entry of [ [3840, 2160, 30], [1920, 1080, 30], [1280, 720, 30], [320, 240, 15] ] ) {

      // We already have this resolution in our list.
      if(rtspEntries.some(x => (x.resolution[0] === entry[0]) && (x.resolution[1] === entry[1]) && (x.resolution[2] === entry[2]))) {
        continue;
      }

      // Find the closest RTSP match for this resolution.
      const foundRtsp = this.findRtsp(entry[0], entry[1], undefined, undefined, rtspEntries);

      if(!foundRtsp) {
        continue;
      }

      // Add the resolution to the list of supported resolutions.
      rtspEntries.push({ channel: foundRtsp.channel, name: foundRtsp.name, resolution: [ entry[0], entry[1], entry[2] ], url: foundRtsp.url });

      // Since we added resolutions to the list, resort resolutions, from high to low.
      rtspEntries.sort(this.sortByResolutions.bind(this));
    }

    // Publish our updated list of supported resolutions and their URLs.
    this.rtspEntries = rtspEntries;

    // If we're already configured, we're done here.
    if(this.isVideoConfigured) {
      return true;
    }

    // Check to see if the user has requested a specific stream quality for this camera.
    if(nvr.optionEnabled(camera, "Video.Stream.Only.Low", false)) {
      this.rtspQuality.Default = "LOW";
    } else if(nvr.optionEnabled(camera, "Video.Stream.Only.Medium", false)) {
      this.rtspQuality.Default = "MEDIUM";
    } else if(nvr.optionEnabled(camera, "Video.Stream.Only.High", false)) {
      this.rtspQuality.Default = "HIGH";
    }

    // Inform the user if we've set a default.
    if(this.rtspQuality.Default) {
      this.log.info("%s: Configured to use only RTSP stream profile: %s.", this.name(),
        this.rtspQuality.Default.charAt(0) + this.rtspQuality.Default.slice(1).toLowerCase());
    }

    // Configure the video stream with our resolutions and inform HomeKit about it.
    this.stream = new ProtectStreamingDelegate(this, this.rtspEntries.map(x => x.resolution));
    this.accessory.configureController(this.stream.controller);
    this.isVideoConfigured = true;

    return true;
  }

  // Configure MQTT capabilities of this camera.
  protected configureMqtt(): boolean {
    const bootstrap: ProtectNvrBootstrap | null = this.nvr.nvrApi.bootstrap;
    const camera = (this.accessory.context.camera as ProtectCameraConfig);

    // Trigger a motion event in MQTT, if requested to do so.
    this.nvr.mqtt?.subscribe(this.accessory, "motion/trigger", (message: Buffer) => {
      const value = message.toString();

      // When we get the right message, we trigger the motion event.
      if(value?.toLowerCase() !== "true") {
        return;
      }

      // Trigger the motion event.
      this.nvr.events.motionEventHandler(this.accessory, Date.now());
      this.log.info("%s: Motion event triggered via MQTT.", this.name());
    });

    // Return the RTSP URLs when requested.
    this.nvr.mqtt?.subscribe(this.accessory, "rtsp/get", (message: Buffer) => {
      const value = message.toString();

      // When we get the right message, we trigger the snapshot request.
      if(value?.toLowerCase() !== "true") {
        return;
      }

      const urlInfo: { [index: string]: string } = {};

      // Grab all the available RTSP channels.
      for(const channel of camera.channels) {
        if(!bootstrap || !channel.isRtspEnabled) {
          continue;
        }

        urlInfo[channel.name] = "rtsp://" + bootstrap.nvr.host + ":" + bootstrap.nvr.ports.rtsp.toString() + "/" + channel.rtspAlias;
      }

      this.nvr.mqtt?.publish(this.accessory, "rtsp", JSON.stringify(urlInfo));
      this.log.info("%s: RTSP information published via MQTT.", this.name());
    });

    // Trigger snapshots when requested.
    this.nvr.mqtt?.subscribe(this.accessory, "snapshot/trigger", (message: Buffer) => {
      const value = message.toString();

      // When we get the right message, we trigger the snapshot request.
      if(value?.toLowerCase() !== "true") {
        return;
      }

      void this.stream?.getSnapshot();
      this.log.info("%s: Snapshot triggered via MQTT.", this.name());
    });

    return true;
  }

  // Utility function for sorting by resolution.
  private sortByResolutions(a: RtspEntry, b: RtspEntry): number {

    // Check width.
    if(a.resolution[0] < b.resolution[0]) {
      return 1;
    }

    if(a.resolution[0] > b.resolution[0]) {
      return -1;
    }

    // Check height.
    if(a.resolution[1] < b.resolution[1]) {
      return 1;
    }

    if(a.resolution[1] > b.resolution[1]) {
      return -1;
    }

    // Check FPS.
    if(a.resolution[2] < b.resolution[2]) {
      return 1;
    }

    if(a.resolution[2] > b.resolution[2]) {
      return -1;
    }

    return 0;
  }

  // Utility function for reserved identifiers for switches.
  protected isReservedName(name: string | undefined): boolean {
    return name === undefined ? false :
      [
        PROTECT_SWITCH_DOORBELL_TRIGGER.toUpperCase(),
        PROTECT_SWITCH_MOTION_SENSOR.toUpperCase(),
        PROTECT_SWITCH_MOTION_TRIGGER.toUpperCase()
      ].includes(name.toUpperCase());
  }
}
