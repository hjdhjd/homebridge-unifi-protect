/* Copyright(C) 2017-2020, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-nvr.ts: NVR device class for UniFi Protect.
 */
import {
  API,
  HAP,
  Logging,
  PlatformAccessory
} from "homebridge";
import { ProtectApi } from "./protect-api";
import { ProtectCamera } from "./protect-camera";
import { ProtectPlatform } from "./protect-platform";
import { ProtectSecuritySystem } from "./protect-securitysystem";
import {
  ProtectCameraConfig,
  ProtectNvrLiveviewConfig,
  ProtectNvrOptions,
  ProtectNvrSystemEvent,
  ProtectNvrSystemEventController
} from "./protect-types";
import {
  PLATFORM_NAME,
  PLUGIN_NAME,
  PROTECT_NVR_UCK_REFRESH_INTERVAL,
  PROTECT_NVR_UNIFIOS_REFRESH_INTERVAL
} from "./settings";

let Accessory: typeof PlatformAccessory;

export class ProtectNvr {
  private api: API;
  private readonly configuredCameras: { [index: string]: ProtectCamera } = {};
  private debug: (message: string, ...parameters: any[]) => void;
  private hap: HAP;
  private lastMotion: { [index: string]: number } = {};
  private log: Logging;
  private motionDuration: number;
  private readonly motionEventTimers: { [index: string]: NodeJS.Timeout } = {};
  private realLastMotion: { [index: string]: number } = {};
  private name: string;
  private nvrAddress: string;
  nvrApi!: ProtectApi;
  platform: ProtectPlatform;
  private pollingTimer!: NodeJS.Timeout;
  private refreshInterval: number;
  private securityAccessory!: PlatformAccessory;
  private securitySystem!: ProtectSecuritySystem;
  private unsupportedDevices: { [index: string]: boolean } = {};

  constructor(platform: ProtectPlatform, nvrOptions: ProtectNvrOptions) {
    this.api = platform.api;
    this.debug = platform.debug.bind(platform);
    this.hap = this.api.hap;
    this.log = platform.log;
    this.name = nvrOptions.name;
    this.motionDuration = platform.config.motionDuration;
    this.nvrAddress = nvrOptions.address;
    this.platform = platform;
    this.refreshInterval = nvrOptions.refreshInterval;

    Accessory = this.api.platformAccessory;

    // Assign a name, if we don't have one.
    if(!this.name) {
      this.name = this.nvrAddress;
    }

    // Validate our Protect address and login information.
    if(!nvrOptions.address || !nvrOptions.username || !nvrOptions.password) {
      return;
    }

    // Initialize our connection to the UniFi Protect API.
    this.nvrApi = new ProtectApi(platform, nvrOptions.address, nvrOptions.username, nvrOptions.password);
  }

  // Discover new UniFi Protect devices.
  private async discoverAndSyncAccessories(): Promise<boolean> {
    // Iterate through the list of cameras that Protect has returned and sync them with what we show HomeKit.
    for(const camera of this.nvrApi.Cameras) {
      // If we have no MAC address, or this camera isn't being managed by Protect, we skip.
      if(!camera.mac || !camera.isManaged) {
        continue;
      }

      // We are only interested in cameras. Perhaps more types in the future.
      if(camera.modelKey !== "camera") {

        // If we've already informed the user about this one, we're done.
        if(this.unsupportedDevices[camera.mac]) {
          continue;
        }

        // Notify the user we see this camera, but we aren't adding it to HomeKit.
        this.unsupportedDevices[camera.mac] = true;

        this.log("UniFi Protect camera type '%s' is not currently supported, ignoring: %s.",
          camera.modelKey, this.nvrApi.getDeviceName(camera));

        continue;
      }

      // Exclude or include certain devices based on configuration parameters.
      if(!this.optionEnabled(camera)) {
        continue;
      }

      // Generate this camera's unique identifier.
      const uuid = this.hap.uuid.generate(camera.mac);

      let accessory: PlatformAccessory;

      // See if we already know about this accessory or if it's truly new. If it is new, add it to HomeKit.
      if((accessory = this.platform.accessories.find((x: PlatformAccessory) => x.UUID === uuid)!) === undefined) {
        accessory = new Accessory(camera.name, uuid);

        this.log("%s %s: Adding %s to HomeKit.",
          this.nvrApi.getNvrName(), this.nvrApi.getDeviceName(camera), camera.modelKey);

        // Register this accessory with homebridge and add it to the accessory array so we can track it.
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.platform.accessories.push(accessory);
      }

      // Link the accessory to it's camera object and it's hosting NVR.
      accessory.context.camera = camera;
      accessory.context.nvr = this.nvrApi.bootstrap.nvr.mac;

      // Setup the Protect camera if it hasn't been configured yet.
      if(!this.configuredCameras[accessory.UUID]) {
        // Eventually switch on multiple types of UniFi Protect cameras. For now, it's cameras only...
        this.configuredCameras[accessory.UUID] = new ProtectCamera(this, accessory);

        // Refresh the accessory cache with these values.
        this.api.updatePlatformAccessories([accessory]);
      } else {
        // Finally, check if we have changes to the exposed RTSP streams on our cameras.
        await this.updateDeviceStreams(accessory);
      }
    }

    // Remove Protect cameras that are no longer found on this Protect NVR, but we still have in HomeKit.
    await this.cleanupDevices();

    // Configure our security system accessory.
    await this.configureSecuritySystem();

    return true;
  }

  // Update HomeKit with the latest status from Protect.
  private async updateAccessories(): Promise<boolean> {

    // Refresh the full device list from the Protect API.
    if(!(await this.nvrApi.refreshDevices())) {
      return false;
    }

    // Set a name for this NVR, if we haven't configured one for ourselves.
    if(!this.name && this.nvrApi && this.nvrApi.bootstrap && this.nvrApi.bootstrap.nvr) {
      this.name = this.nvrApi.bootstrap.nvr.name;
    }

    // If not already configured by the user, set the refresh interval here depending on whether we
    // have UniFi OS devices or not, since non-UniFi OS devices don't have a realtime API.
    if(!this.refreshInterval) {
      if(this.nvrApi.isUnifiOs) {
        this.refreshInterval = PROTECT_NVR_UNIFIOS_REFRESH_INTERVAL;
      } else {
        this.refreshInterval = PROTECT_NVR_UCK_REFRESH_INTERVAL;
      }

      // In case someone puts in an overly aggressive default value.
      if(this.refreshInterval < 2) {
        this.refreshInterval = 2;
      }
    }

    // Check for motion on non-UniFi OS devices since they lack the realtime event listener API.
    if(!this.nvrApi.isUnifiOs) {
      await this.checkCameraMotion();
    }

    // Setup our event listener, if needed.
    await this.setupEventListener();

    // Sync status and check for any new or removed accessories.
    await this.discoverAndSyncAccessories();

    return true;
  }

  // Check for motion events on Protect cameras for non-UniFi OS controllers.
  private async checkCameraMotion(): Promise<boolean> {
    // Only operate on non-UniFi OS devices. For UniFi OS, we have the realtime events API.
    if(this.nvrApi.isUnifiOs) {
      return false;
    }

    // Ensure we're up and running.
    if(!this.nvrApi || !this.nvrApi.Cameras) {
      return false;
    }

    // Iterate through the list of cameras, looking for the isMotionDetected event on each camera
    // in order to determine where there is motion.
    for(const camera of this.nvrApi.Cameras) {
      // We only want cameras that are managed where we're detected motion.
      if(!camera.isManaged || !camera.isMotionDetected) {
        continue;
      }

      // Find the accessory associated with this camera.
      const uuid = this.hap.uuid.generate(camera.mac);
      const accessory = this.platform.accessories.find((x: PlatformAccessory) => x.UUID === uuid);

      // If we don't have an accessory, it's probably because we've chosen to hide it. In that case,
      // just ignore and move on.
      if(!accessory) {
        continue;
      }

      await this.motionEventHandler(accessory, camera.lastMotion);
    }

    return true;
  }

  // Configure the API event listener to trigger events on accessories, like motion.
  private async setupEventListener(): Promise<boolean> {

    // The event listener API only works on UniFi OS devices.
    if(!this.nvrApi.isUnifiOs) {
      return false;
    }

    // Only configure the event listener if it exists and it's not already configured.
    if(!this.nvrApi.eventListener || this.nvrApi.eventListenerConfigured) {
      return true;
    }

    // Listen for any messages coming in from our listener.
    this.nvrApi.eventListener.on("message", async (event) => {
      const nvrEvent: ProtectNvrSystemEvent = JSON.parse(event as string);

      // We're interested in device state change events.
      if(nvrEvent.type !== "DEVICE_STATE_CHANGED" || !nvrEvent.apps) {
        return;
      }

      // We only want Protect controllers.
      const controller = nvrEvent.apps.controllers.find((x: ProtectNvrSystemEventController) => x.name === "protect");

      if(!controller) {
        return;
      }

      // Find the camera in our list of accessories so we can fire off the motion event.
      const foundCamera = Object.keys(this.configuredCameras).find((x: string) =>
        this.configuredCameras[x].accessory.context.camera.host === controller.info.lastMotionCameraAddress);

      // Now grab the accessory associated with the Protect device.
      const accessory = this.configuredCameras[foundCamera!].accessory;

      // If we don't have an accessory, it's probably because we've chosen to hide it. In that case,
      // just ignore and move on. Alternatively, it could be a new camera that we just don't know about yet,
      // In either case, we keep ignore it.
      if(!accessory) {
        return;
      }

      await this.motionEventHandler(accessory, controller.info.lastMotion);
    });

    // Mark the listener as configured.
    this.nvrApi.eventListenerConfigured = true;
    return true;
  }

  // Motion event processing from UniFi Protect and delivered to HomeKit.
  private async motionEventHandler(accessory: PlatformAccessory, lastMotion: number): Promise<void> {
    const camera = accessory.context.camera;
    const hap = this.hap;

    if(!accessory || !camera) {
      return;
    }

    // We only consider events that have happened within the last two refresh intervals. Otherwise,
    // we assume it's stale data and don't inform the user.
    if(Date.now() - (lastMotion * 1000) > (this.refreshInterval * 2 * 1000)) {
      this.debug("%s: Skipping motion due to stale data.", accessory.displayName);
      return;
    }

    // Have we seen this event before? If so...move along.
    if(this.lastMotion[camera.mac] >= lastMotion) {
      this.debug("%s: Skipping duplicate motion detected.", accessory.displayName);
      return;
    }

    this.lastMotion[camera.mac] = lastMotion;

    // If we already have a motion inflight, allow the event to complete so we don't spam users.
    if(this.motionEventTimers[camera.mac]) {
      return;
    }

    // Only notify the user if we have a motion sensor and it's active.
    const motionService = accessory.getService(hap.Service.MotionSensor);

    if(!motionService) {
      return;
    }

    // If we have a motion switch, and it's set to off, we're done here.
    if(accessory.getService(hap.Service.Switch) &&
      (accessory.context.detectMotion !== undefined) && !accessory.context.detectMotion) {
      return;
    }

    // Trigger the motion event.
    motionService.getCharacteristic(hap.Characteristic.MotionDetected).updateValue(true);
    this.log("%s: Motion detected.", accessory.displayName);

    // Reset our motion event after motionDuration.
    const self = this;
    this.motionEventTimers[camera.mac] = setTimeout(() => {
      const motionService = accessory.getService(hap.Service.MotionSensor);

      if(motionService) {
        motionService.getCharacteristic(hap.Characteristic.MotionDetected).updateValue(false);
        self.debug("%s: Resetting motion event.", accessory.displayName);
      }

      // Delete the timer from our motion event tracker.
      delete self.motionEventTimers[camera.mac];
    }, this.motionDuration * 1000);
  }

  // Periodically poll the Protect API for status.
  poll(refresh: number): void {
    // Clear the last polling interval out.
    clearTimeout(this.pollingTimer);

    // Setup periodic update with our polling interval.
    const self = this;

    this.pollingTimer = setTimeout(async () => {
      // Refresh our Protect device information and gracefully handle Protect errors.
      await self.updateAccessories();

      // Fire off the next polling interval.
      self.poll(self.refreshInterval);
    }, refresh * 1000);
  }

  // Update security system accessory.
  private async configureSecuritySystem(): Promise<boolean> {
    // Have we disabled the security system accessory?
    // Check it here.
    if(!this.nvrApi || !this.nvrApi.bootstrap || !this.nvrApi.bootstrap.nvr) {
      return false;
    }

    const nvr = this.nvrApi.bootstrap.nvr;
    const uuid = this.hap.uuid.generate(nvr.mac + ".Security");

    // If the user has created plugin-specific liveviews, we make a security system accessory available to allow for some
    // convenient actions like enabling and disabling motion detection on a set of cameras at once. Otherwise, don't make
    // this available.
    const liveviews = this.nvrApi.bootstrap.liveviews;

    if(liveviews) {
      const reLiveviewScene = /^Protect-(Away|Home|Night|Off)$/gi;

      // If we have a security system accessory already configured, we delete it now. The user likely removed the last
      // liveview that we look for.
      if(!liveviews.some((x: ProtectNvrLiveviewConfig) => x.name.search(reLiveviewScene) !== -1 ? true : false)) {
        const oldAccessory = this.platform.accessories.find((x: PlatformAccessory) => x.UUID === uuid);

        if(oldAccessory) {
          this.log("%s: No plugin-specific liveviews found. Disabling the security system accessory associated with this UniFi Protect controller. ",
            this.nvrApi.getNvrName());

          // Unregister the accessory and delete it's remnants from HomeKit and the plugin.
          this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [oldAccessory]);
          this.platform.accessories.splice(this.platform.accessories.indexOf(oldAccessory), 1);
        }

        if(this.securitySystem) {
          delete this.securitySystem;
        }

        this.securityAccessory = null as any;
        this.securitySystem = null as any;
        return false;
      }
    }

    // Create the security system accessory if it doesn't already exist.
    if(!this.securityAccessory) {
      // See if we already have this accessory defined.
      if((this.securityAccessory = this.platform.accessories.find((x: PlatformAccessory) => x.UUID === uuid)!) === undefined) {
        // We will use the NVR MAC address + ".Security" to create our UUID. That should provide guaranteed uniqueness we need.
        this.securityAccessory = new Accessory(nvr.name, uuid);

        // Register this accessory with homebridge and add it to the platform accessory array so we can track it.
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [this.securityAccessory]);
        this.platform.accessories.push(this.securityAccessory);
      }

      if(!this.securityAccessory) {
        this.log("%s: Umable to create the security system accessory.");
        return false;
      }

      this.log("%s: Plugin-specific liveviews have been detected. Enabling the security system accessory.", this.nvrApi.getNvrName());
    }

    // We have the security system accessory, now let's configure it.
    if(!this.securitySystem) {
      this.securitySystem = new ProtectSecuritySystem(this, this.securityAccessory);

      if(!this.securitySystem) {
        this.log("%s: Unable to configure the security system accessory", this.nvrApi.getNvrName());
        return false;
      }
    }

    // Update our NVR reference.
    this.securityAccessory.context.nvr = nvr.mac;
    return true;
  }

  // Cleanup removed Protect devices from HomeKit.
  private async cleanupDevices(): Promise<void> {
    for(const oldAccessory of this.platform.accessories) {
      const oldCamera = oldAccessory.context.camera;
      const oldNvr = oldAccessory.context.nvr;
      const nvr = this.nvrApi.bootstrap.nvr;

      // Since we're accessing the shared accessories list for the entire platform, we need to ensure we
      // are only touching our cameras and not another NVR's.
      if(oldNvr !== nvr.mac) {
        continue;
      }

      // Security system accessories are handled elsewhere.
      if(oldAccessory.getService(this.hap.Service.SecuritySystem)) {
        continue;
      }

      // We found this accessory and it's for this NVR. Figure out if we really want to see it in HomeKit.
      // Keep it if it still exists on the NVR and the user has not chosen to hide it.
      if(oldCamera &&
        this.nvrApi.Cameras.some((x: ProtectCameraConfig) => x.mac === oldCamera.mac) &&
        this.optionEnabled(oldCamera)) {
        continue;
      }

      // Remove this device.
      this.log("%s %s: Removing %s from HomeKit.", this.nvrApi.getNvrName(),
        oldCamera ? this.nvrApi.getDeviceName(oldCamera) : oldAccessory.displayName,
        oldCamera ? oldCamera.modelKey : "device");

      // Unregister the accessory and delete it's remnants from HomeKit and the plugin.
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [oldAccessory]);

      delete this.configuredCameras[oldAccessory.UUID];
      this.platform.accessories.splice(this.platform.accessories.indexOf(oldAccessory), 1);
    }
  }

  // Check devices for any updates to the configured RTSP streams.
  private async updateDeviceStreams(accessory: PlatformAccessory): Promise<void> {
    // Find our camera object and reconfigure our RTSP stream, if we can.
    const camera = this.configuredCameras[accessory.UUID] as ProtectCamera;

    if(!camera) {
      return;
    }

    // Attempt to reconfigure the video stream to potentially take advantage of any new RTSP streams.
    await camera.configureVideoStream();
  }

  // Utility function to let us know if a Protect device or feature should be enabled in HomeKit or not.
  optionEnabled(device: ProtectCameraConfig, option = "", defaultReturn = true): boolean {
    // There are a couple of ways to enable and disable options. The rules of the road are:
    //
    // 1. Explicitly disabling, or enabling an option on the NVR propogates to all the devices
    //    that are managed by that NVR. Why might you want to do this? Because...
    //
    // 2. Explicitly disabling, or enabling an option on a device by its MAC address will always
    //    override the above. This means that it's possible to disable an option for an NVR,
    //    and all the cameras that are managed by it, and then override that behavior on a single
    //    camera that it's managing.
    const configOptions = this.platform.configOptions;

    // Nothing configured - we show all Protect devices to HomeKit.
    if(!configOptions) {
      return true;
    }

    // No valid device passed to us, assume the option is enabled.
    if(!device || !device.mac) {
      return true;
    }

    let optionSetting;

    // First we test for camera-level option settings.
    // No option specified means we're testing to see if this device should be shown in HomeKit.
    if(!option) {
      optionSetting = device.mac;
    } else {
      optionSetting = option + "." + device.mac;
    }

    optionSetting = optionSetting.toUpperCase();

    // We've explicitly enabled this option for this device.
    if(configOptions.indexOf("ENABLE." + optionSetting) !== -1) {
      return true;
    }

    // We've explicitly disabled this option for this device.
    if(configOptions.indexOf("DISABLE." + optionSetting) !== -1) {
      return false;
    }

    // If we don't have a managing device attached, we're done here.
    if(!this.nvrApi.bootstrap.nvr.mac) {
      return defaultReturn;
    }

    // Now we test for NVR-level option settings.
    // No option specified means we're testing to see if this NVR (and it's attached devices) should be shown in HomeKit.
    if(!option) {
      optionSetting = this.nvrApi.bootstrap.nvr.mac;
    } else {
      optionSetting = option + "." + this.nvrApi.bootstrap.nvr.mac;
    }

    optionSetting = optionSetting.toUpperCase();

    // We've explicitly enabled this option for this NVR and all the devices attached to it.
    if(configOptions.indexOf("ENABLE." + optionSetting) !== -1) {
      return true;
    }

    // We've explicitly disabled this option for this NVR and all the devices attached to it.
    if(configOptions.indexOf("DISABLE." + optionSetting) !== -1) {
      return false;
    }

    // Finally, let's see if we have a global option here.
    // No option means we're done - it's a special case for testing if an NVR or camera should be hidden in HomeKit.
    if(!option) {
      return defaultReturn;
    }

    optionSetting = option.toUpperCase();

    // We've explicitly enabled this globally for all devices.
    if(configOptions.indexOf("ENABLE." + optionSetting) !== -1) {
      return true;
    }

    // We've explicitly disabled this globally for all devices.
    if(configOptions.indexOf("DISABLE." + optionSetting) !== -1) {
      return false;
    }

    // Nothing special to do - assume the option is defaultReturn.
    return defaultReturn;
  }
}
