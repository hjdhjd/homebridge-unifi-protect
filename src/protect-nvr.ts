/* Copyright(C) 2017-2020, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-nvr.ts: NVR device class for UniFi Protect.
 */
import {
  API,
  APIEvent,
  HAP,
  Logging,
  PlatformAccessory
} from "homebridge";
import {
  PLATFORM_NAME,
  PLUGIN_NAME,
  PROTECT_NVR_DOORBELL_REFRESH_INTERVAL,
  PROTECT_NVR_UCK_REFRESH_INTERVAL,
  PROTECT_NVR_UNIFIOS_REFRESH_INTERVAL
} from "./settings";
import {
  ProtectCameraConfig,
  ProtectNvrOptions
} from "./protect-types";
import { ProtectApi } from "./protect-api";
import { ProtectCamera } from "./protect-camera";
import { ProtectDoorbell } from "./protect-doorbell";
import { ProtectLiveviews } from "./protect-liveviews";
import { ProtectMqtt } from "./protect-mqtt";
import { ProtectNvrEvents } from "./protect-nvr-events";
import { ProtectPlatform } from "./protect-platform";

export class ProtectNvr {
  private api: API;
  public config: ProtectNvrOptions;
  public readonly configuredCameras: { [index: string]: ProtectCamera | ProtectDoorbell };
  private debug: (message: string, ...parameters: unknown[]) => void;
  public doorbellCount: number;
  public events!: ProtectNvrEvents;
  private isEnabled: boolean;
  private hap: HAP;
  private lastMotion: { [index: string]: number };
  private lastRing: { [index: string]: number };
  private liveviews: ProtectLiveviews | null;
  private log: Logging;
  private motionDuration: number;
  public mqtt: ProtectMqtt | null;
  private readonly eventTimers: { [index: string]: NodeJS.Timeout };
  private name: string;
  private nvrAddress: string;
  public nvrApi!: ProtectApi;
  public platform: ProtectPlatform;
  private pollingTimer!: NodeJS.Timeout;
  public refreshInterval: number;
  private unsupportedDevices: { [index: string]: boolean };

  constructor(platform: ProtectPlatform, nvrOptions: ProtectNvrOptions) {
    this.api = platform.api;
    this.config = nvrOptions;
    this.configuredCameras = {};
    this.debug = platform.debug.bind(platform);
    this.doorbellCount = 0;
    this.isEnabled = false;
    this.hap = this.api.hap;
    this.lastMotion = {};
    this.lastRing = {};
    this.liveviews = null;
    this.log = platform.log;
    this.mqtt = null;
    this.name = nvrOptions.name;
    this.motionDuration = platform.config.motionDuration;
    this.eventTimers = {};
    this.nvrAddress = nvrOptions.address;
    this.platform = platform;
    this.refreshInterval = nvrOptions.refreshInterval;
    this.unsupportedDevices = {};

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

    // Initialize our event handlers.
    this.events = new ProtectNvrEvents(this);

    // Initialize our liveviews.
    this.liveviews = new ProtectLiveviews(this);

    // Cleanup any stray ffmpeg sessions on shutdown.
    this.api.on(APIEvent.SHUTDOWN, () => {
      for(const protectCamera of Object.values(this.configuredCameras)) {
        this.debug("%s: Shutting down all video stream processes.", protectCamera.name());
        protectCamera.stream?.shutdown();
      }
    });
  }

  // Discover new UniFi Protect devices.
  private discoverAndSyncAccessories(): boolean {

    // Iterate through the list of cameras that Protect has returned and sync them with what we show HomeKit.
    for(const camera of this.nvrApi.Cameras ?? []) {

      // If we have no MAC address, name, or this camera isn't being managed by Protect, we skip.
      if(!camera.mac || !camera.name || camera.isAdopting || !camera.isAdopted || !camera.isManaged) {
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

        this.log.info("%s: UniFi Protect camera type '%s' is not currently supported, ignoring: %s.",
          this.nvrApi.getNvrName(), camera.modelKey, this.nvrApi.getDeviceName(camera));

        continue;
      }

      // Exclude or include certain devices based on configuration parameters.
      if(!this.optionEnabled(camera)) {
        continue;
      }

      // Generate this camera's unique identifier.
      const uuid = this.hap.uuid.generate(camera.mac);

      let accessory: PlatformAccessory | undefined;

      // See if we already know about this accessory or if it's truly new. If it is new, add it to HomeKit.
      if((accessory = this.platform.accessories.find(x => x.UUID === uuid)) === undefined) {
        accessory = new this.api.platformAccessory(camera.name, uuid);

        this.log.info("%s: Adding %s to HomeKit.", this.nvrApi.getFullName(camera), camera.modelKey);

        // Register this accessory with homebridge and add it to the accessory array so we can track it.
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.platform.accessories.push(accessory);
      }

      // Link the accessory to it's camera object and it's hosting NVR.
      accessory.context.camera = camera;
      accessory.context.nvr = this.nvrApi.bootstrap?.nvr.mac;

      // Setup the Protect camera if it hasn't been configured yet.
      if(!this.configuredCameras[accessory.UUID]) {

        // Eventually switch on multiple types of UniFi Protect devices. For now, it's cameras only...
        if(camera.featureFlags.hasChime) {
          this.configuredCameras[accessory.UUID] = new ProtectDoorbell(this, accessory);
        } else {
          this.configuredCameras[accessory.UUID] = new ProtectCamera(this, accessory);
        }

      } else {

        // Finally, check if we have changes to the exposed RTSP streams on our cameras.
        void this.configuredCameras[accessory.UUID].configureVideoStream();

        // Check for changes to the doorbell LCD as well.
        if(camera.featureFlags.hasLcdScreen) {
          void (this.configuredCameras[accessory.UUID] as ProtectDoorbell).configureDoorbellLcdSwitch();
        }

      }
    }

    // Remove Protect cameras that are no longer found on this Protect NVR, but we still have in HomeKit.
    this.cleanupDevices();

    // Configure our liveview-based accessories.
    this.liveviews?.configureLiveviews();

    return true;
  }

  // Update HomeKit with the latest status from Protect.
  private async updateAccessories(): Promise<boolean> {

    // Refresh the full device list from the Protect API.
    if(!(await this.nvrApi.refreshDevices())) {
      return false;
    }

    // This NVR has been disabled. Stop polling for updates and let the user know that we're done here.
    // Only run this check once, since we don't need to repeat it again.
    if(!this.isEnabled && !this.optionEnabled(null)) {
      this.log.info("%s: Disabling this Protect controller.", this.nvrApi.getNvrName());
      this.nvrApi.clearLoginCredentials();
      return true;
    }

    // Set a name for this NVR, if we haven't configured one for ourselves.
    if(!this.name && this.nvrApi.bootstrap?.nvr) {
      this.name = this.nvrApi.bootstrap.nvr.name;
    }

    // If not already configured by the user, set the refresh interval here depending on whether we
    // have UniFi OS devices or not, since non-UniFi OS devices don't have a realtime API. We also
    // check to see whether doorbell devices have been removed and restore the prior refresh interval, if needed.
    let refreshUpdated = false;

    if(!this.refreshInterval || (!this.doorbellCount && (this.refreshInterval !== this.config.refreshInterval))) {

      if(!this.refreshInterval) {
        this.refreshInterval = this.config.refreshInterval = this.nvrApi.isUnifiOs ? PROTECT_NVR_UNIFIOS_REFRESH_INTERVAL : PROTECT_NVR_UCK_REFRESH_INTERVAL;
      } else {
        this.refreshInterval = this.config.refreshInterval;
      }

      // In case someone puts in an overly aggressive default value.
      if(this.refreshInterval < 2) {
        this.refreshInterval = this.config.refreshInterval = 2;
      }

      refreshUpdated = true;
    }

    // If we have doorbells on non-UniFi OS controllers, we need to poll more frequently.
    if(!this.nvrApi.isUnifiOs && this.doorbellCount && (this.refreshInterval !== PROTECT_NVR_DOORBELL_REFRESH_INTERVAL)) {

      this.refreshInterval = PROTECT_NVR_DOORBELL_REFRESH_INTERVAL;
      this.log.info("%s: A doorbell has been detected. Setting the controller refresh interval to %s seconds.", this.nvrApi.getNvrName(), this.refreshInterval);

    } else if(refreshUpdated || !this.isEnabled) {

      // On startup or refresh interval change, we want to notify the user.
      this.log.info("%s: Controller refresh interval set to %s seconds.", this.nvrApi.getNvrName(), this.refreshInterval);

    }

    this.isEnabled = true;

    // Create an MQTT connection, if needed.
    if(!this.mqtt && this.config.mqttUrl) {
      this.mqtt = new ProtectMqtt(this);
    }

    // Poll for events (in non-UniFi OS controllers) and check for any updates to the events API connection.
    this.events.update();

    // Sync status and check for any new or removed accessories.
    this.discoverAndSyncAccessories();

    // Refresh the accessory cache.
    this.api.updatePlatformAccessories(this.platform.accessories);

    return true;
  }

  // Periodically poll the Protect API for status.
  public async poll(): Promise<void> {

    // Loop forever.
    for(;;) {

      // Sleep until our next update.
      // eslint-disable-next-line no-await-in-loop
      await this.sleep(this.refreshInterval * 1000);

      // Refresh our Protect device information and gracefully handle Protect errors.
      // eslint-disable-next-line no-await-in-loop
      if(await this.updateAccessories()) {

        // Our Protect NVR is disabled. We're done.
        if(!this.isEnabled) {
          return;
        }
      }
    }
  }

  // Cleanup removed Protect devices from HomeKit.
  private cleanupDevices(): void {
    const nvr = this.nvrApi.bootstrap?.nvr;

    // If we don't have a valid bootstrap configuration, we're done here.
    if(!nvr) {
      return;
    }

    for(const oldAccessory of this.platform.accessories) {
      const oldCamera = oldAccessory.context.camera as ProtectCameraConfig;
      const oldNvr = oldAccessory.context.nvr as string;

      // Since we're accessing the shared accessories list for the entire platform, we need to ensure we
      // are only touching our cameras and not another NVR's.
      if(oldNvr !== nvr.mac) {
        continue;
      }

      // Liveview-centric accessories are handled elsewhere.
      if(("liveview" in oldAccessory.context) || oldAccessory.getService(this.hap.Service.SecuritySystem)) {
        continue;
      }

      // We found this accessory and it's for this NVR. Figure out if we really want to see it in HomeKit.
      // Keep it if it still exists on the NVR and the user has not chosen to hide it.
      if(oldCamera &&
        this.nvrApi.Cameras?.some((x: ProtectCameraConfig) => x.mac === oldCamera.mac) &&
        this.optionEnabled(oldCamera)) {
        continue;
      }

      // Decrement our doorbell count.
      if(oldAccessory.getService(this.hap.Service.Doorbell)) {
        this.doorbellCount--;
      }

      // Remove this device.
      this.log.info("%s %s: Removing %s from HomeKit.", this.nvrApi.getNvrName(),
        oldCamera ? this.nvrApi.getDeviceName(oldCamera) : oldAccessory.displayName,
        oldCamera ? oldCamera.modelKey : "device");

      // Unregister the accessory and delete it's remnants from HomeKit and the plugin.
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [oldAccessory]);

      delete this.configuredCameras[oldAccessory.UUID];
      this.platform.accessories.splice(this.platform.accessories.indexOf(oldAccessory), 1);
    }
  }

  // Lookup a camera by it's identifier and return the associated accessory, if any.
  public accessoryLookup(cameraId: string | undefined | null): PlatformAccessory | undefined {

    if(!cameraId) {
      return undefined;
    }

    // Find the camera in our list of accessories.
    const foundCamera = Object.keys(this.configuredCameras).find(x => (this.configuredCameras[x].accessory.context.camera as ProtectCameraConfig).id === cameraId);

    return foundCamera ? this.configuredCameras[foundCamera].accessory : undefined;
  }

  // Utility function to let us know if a device or feature should be enabled or not.
  public optionEnabled(device: ProtectCameraConfig | null, option = "", defaultReturnValue = true, address = ""): boolean {

    // There are a couple of ways to enable and disable options. The rules of the road are:
    //
    // 1. Explicitly disabling, or enabling an option on the NVR propogates to all the devices
    //    that are managed by that NVR. Why might you want to do this? Because...
    //
    // 2. Explicitly disabling, or enabling an option on a device by its MAC address will always
    //    override the above. This means that it's possible to disable an option for an NVR,
    //    and all the cameras that are managed by it, and then override that behavior on a single
    //    camera that it's managing.
    const configOptions = this.platform?.configOptions;

    // Make sure our option is upper case for easier checks.
    if(option) {
      option = option.toUpperCase();
    }

    // Nothing configured - we assume the default return value.
    if(!configOptions) {
      return defaultReturnValue;
    }

    let optionSetting;

    // If we've specified an address parameter - we check for device and address-specific options before
    // anything else.
    if(address && option) {

      // Test for device-specific and address-specific option settings, used together.
      if(device?.mac) {

        optionSetting = option + "." + device.mac.toUpperCase() + "." + address.toUpperCase();

        // We've explicitly enabled this option for this device and address combination.
        if(configOptions.indexOf("ENABLE." + optionSetting) !== -1) {
          return true;
        }

        // We've explicitly disabled this option for this device and address combination.
        if(configOptions.indexOf("DISABLE." + optionSetting) !== -1) {
          return false;
        }
      }

      // Test for address-specific option settings only.
      optionSetting = option + "." + address.toUpperCase();

      // We've explicitly enabled this option for this address.
      if(configOptions.indexOf("ENABLE." + optionSetting) !== -1) {
        return true;
      }

      // We've explicitly disabled this option for this address.
      if(configOptions.indexOf("DISABLE." + optionSetting) !== -1) {
        return false;
      }
    }

    // If we've specified a device, check for device-specific options first. Otherwise, we're dealing
    // with an NVR-specific or global option.
    if(device?.mac) {

      // First we test for camera-level option settings.
      // No option specified means we're testing to see if this device should be shown in HomeKit.
      optionSetting = option ? option + "." + device.mac.toUpperCase() : device.mac.toUpperCase();

      // We've explicitly enabled this option for this device.
      if(configOptions.indexOf("ENABLE." + optionSetting) !== -1) {
        return true;
      }

      // We've explicitly disabled this option for this device.
      if(configOptions.indexOf("DISABLE." + optionSetting) !== -1) {
        return false;
      }
    }

    // If we don't have a managing device attached, we're done here.
    if(!this.nvrApi.bootstrap?.nvr?.mac) {
      return defaultReturnValue;
    }

    // Now we test for NVR-level option settings.
    // No option specified means we're testing to see if this NVR (and it's attached devices) should be shown in HomeKit.
    optionSetting = option ? option + "." + this.nvrApi.bootstrap.nvr.mac.toUpperCase() : this.nvrApi.bootstrap.nvr.mac.toUpperCase();

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
      return defaultReturnValue;
    }

    // We've explicitly enabled this globally for all devices.
    if(configOptions.indexOf("ENABLE." + option) !== -1) {
      return true;
    }

    // We've explicitly disabled this globally for all devices.
    if(configOptions.indexOf("DISABLE." + option) !== -1) {
      return false;
    }

    // Nothing special to do - assume the option is defaultReturnValue.
    return defaultReturnValue;
  }

  // Utility function to return a configuration parameter for a Protect device.
  public optionGet(device: ProtectCameraConfig | null, option: string): string | undefined {

    // Using the same rules as we do to test for whether an option is enabled, retrieve options with parameters and
    // return them. If we don't find anything, we return undefined.
    const configOptions = this.platform?.configOptions;
    option = option.toUpperCase();

    // Nothing configured - we assume the default return value.
    if(!configOptions) {
      return undefined;
    }

    let foundOption;
    let optionSetting: string;

    // If we've specified a device, check for device-specific options first. Otherwise, we're dealing
    // with an NVR-specific or global option.
    if(device?.mac) {

      // First we test for camera-level option settings.
      // No option specified means we're testing to see if this device should be shown in HomeKit.
      optionSetting = "ENABLE." + option + "." + device.mac.toUpperCase() + ".";

      // We've explicitly enabled this option for this device.
      if((foundOption = configOptions.find(x => optionSetting === x.slice(0, optionSetting.length))) !== undefined) {
        return foundOption.slice(optionSetting.length);
      }

      // We've explicitly disabled this option for this device.
      if(configOptions.indexOf("DISABLE." + optionSetting) !== -1) {
        return undefined;
      }
    }

    // If we don't have a managing device attached, we're done here.
    if(!this.nvrApi.bootstrap?.nvr?.mac) {
      return undefined;
    }

    // Now we test for NVR-level option settings.
    // No option specified means we're testing to see if this NVR (and it's attached devices) should be shown in HomeKit.
    optionSetting = "ENABLE." + option + "." + this.nvrApi.bootstrap.nvr.mac.toUpperCase() + ".";

    // We've explicitly enabled this option for this NVR and all the devices attached to it.
    if((foundOption = configOptions.find(x => optionSetting === x.slice(0, optionSetting.length))) !== undefined) {
      return foundOption.slice(optionSetting.length);
    }

    // We've explicitly disabled this option for this NVR and all the devices attached to it.
    if(configOptions.indexOf("DISABLE." + optionSetting) !== -1) {
      return undefined;
    }

    // Finally, let's see if we have a global option here.
    optionSetting = "ENABLE." + option + ".";

    // We've explicitly enabled this globally for all devices.
    if((foundOption = configOptions.find(x => optionSetting === x.slice(0, optionSetting.length))) !== undefined) {
      return foundOption.slice(optionSetting.length);
    }

    // Nothing special to do - assume the option is defaultReturnValue.
    return undefined;
  }

  // Emulate a sleep function.
  private sleep(ms: number): Promise<NodeJS.Timeout> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
