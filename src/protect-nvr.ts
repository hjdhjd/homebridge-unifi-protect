/* Copyright(C) 2017-2022, HJD (https://github.com/hjdhjd). All rights reserved.
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
  PROTECT_NVR_UNIFIOS_REFRESH_INTERVAL
} from "./settings";
import {
  ProtectApi,
  ProtectCameraConfig,
  ProtectLightConfig,
  ProtectSensorConfig,
  ProtectViewerConfig
} from "unifi-protect";
import { ProtectCamera } from "./protect-camera";
import { ProtectDoorbell } from "./protect-doorbell";
import { ProtectLight } from "./protect-light";
import { ProtectLiveviews } from "./protect-liveviews";
import { ProtectMqtt } from "./protect-mqtt";
import { ProtectNvrEvents } from "./protect-nvr-events";
import { ProtectNvrOptions } from "./protect-options";
import { ProtectNvrSystemInfo } from "./protect-nvr-systeminfo";
import { ProtectPlatform } from "./protect-platform";
import { ProtectSensor } from "./protect-sensor";
import { ProtectViewer } from "./protect-viewer";

// Some type aliases to signify what we support.
type ProtectDeviceConfigTypes = ProtectCameraConfig | ProtectLightConfig | ProtectSensorConfig | ProtectViewerConfig;
type ProtectDevices = ProtectCamera | ProtectDoorbell | ProtectLight | ProtectSensor | ProtectViewer;

export class ProtectNvr {
  private api: API;
  public config: ProtectNvrOptions;
  public readonly configuredDevices: { [index: string]: ProtectDevices };
  private debug: (message: string, ...parameters: unknown[]) => void;
  public doorbellCount: number;
  public events!: ProtectNvrEvents;
  private isEnabled: boolean;
  private hap: HAP;
  private lastMotion: { [index: string]: number };
  private lastRing: { [index: string]: number };
  private liveviews: ProtectLiveviews | null;
  private log: Logging;
  public mqtt: ProtectMqtt | null;
  private readonly eventTimers: { [index: string]: NodeJS.Timeout };
  private name: string;
  public nvrAddress: string;
  public nvrApi!: ProtectApi;
  public systemInfo!: ProtectNvrSystemInfo | null;
  public platform: ProtectPlatform;
  private pollingTimer!: NodeJS.Timeout;
  public refreshInterval: number;
  private unsupportedDevices: { [index: string]: boolean };

  constructor(platform: ProtectPlatform, nvrOptions: ProtectNvrOptions) {
    this.api = platform.api;
    this.config = nvrOptions;
    this.configuredDevices = {};
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
    this.eventTimers = {};
    this.nvrAddress = nvrOptions.address;
    this.platform = platform;
    this.refreshInterval = nvrOptions.refreshInterval;
    this.systemInfo = null;
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
    this.nvrApi = new ProtectApi(nvrOptions.address, nvrOptions.username, nvrOptions.password, this.log);

    // Initialize our event handlers.
    this.events = new ProtectNvrEvents(this);

    // Initialize our liveviews.
    this.liveviews = new ProtectLiveviews(this);

    // Initialize our NVR system information.
    this.systemInfo = new ProtectNvrSystemInfo(this);

    // Cleanup any stray ffmpeg sessions on shutdown.
    this.api.on(APIEvent.SHUTDOWN, () => {

      for(const protectCamera of Object.values(this.configuredDevices)) {
        if(protectCamera instanceof ProtectCamera) {
          this.debug("%s: Shutting down all video stream processes.", protectCamera.name());
          protectCamera.stream?.shutdown();
        }
      }
    });
  }

  // Configure a UniFi Protect device in HomeKit.
  private configureDevice(accessory: PlatformAccessory, device: ProtectDeviceConfigTypes): boolean {

    if(!accessory || !device) {
      return false;
    }

    switch(device.modelKey) {

      case "camera":

        // We have a UniFi Protect camera or doorbell.
        if((device as ProtectCameraConfig).featureFlags.hasChime) {
          this.configuredDevices[accessory.UUID] = new ProtectDoorbell(this, accessory);
        } else {
          this.configuredDevices[accessory.UUID] = new ProtectCamera(this, accessory);
        }

        return true;

        break;

      case "light":

        // We have a UniFi Protect light.
        this.configuredDevices[accessory.UUID] = new ProtectLight(this, accessory);

        return true;

        break;

      case "sensor":

        // We have a UniFi Protect sensor.
        this.configuredDevices[accessory.UUID] = new ProtectSensor(this, accessory);

        return true;

        break;

      case "viewer":

        // We have a UniFi Protect viewer.
        this.configuredDevices[accessory.UUID] = new ProtectViewer(this, accessory);

        return true;

        break;

      default:

        this.log.error("%s: Unknown device class `%s` detected for ``%s``", this.nvrApi.getNvrName(), device.modelKey, device.name);

        return false;
    }
  }

  // Discover UniFi Protect devices that may have been added to the NVR since we last checked.
  private discoverDevices(devices: ProtectDeviceConfigTypes[]): boolean {

    // Iterate through the list of cameras that Protect has returned and sync them with what we show HomeKit.
    for(const device of devices ?? []) {

      // If we have no MAC address, name, or this camera isn't being managed by Protect, we skip.
      if(!device.mac || !device.name || device.isAdopting || !device.isAdopted) {
        continue;
      }

      // We only support certain devices.
      switch(device.modelKey) {
        case "camera":
        case "light":
        case "sensor":
        case "viewer":
          break;

        default:

          // If we've already informed the user about this one, we're done.
          if(this.unsupportedDevices[device.mac]) {
            continue;
          }

          // Notify the user we see this device, but we aren't adding it to HomeKit.
          this.unsupportedDevices[device.mac] = true;

          this.log.info("%s: UniFi Protect device type '%s' is not currently supported, ignoring: %s.",
            this.nvrApi.getNvrName(), device.modelKey, this.nvrApi.getDeviceName(device));

          continue;

      }

      // Exclude or include certain devices based on configuration parameters.
      if(!this.optionEnabled(device)) {
        continue;
      }

      // Generate this device's unique identifier.
      const uuid = this.hap.uuid.generate(device.mac);

      let accessory: PlatformAccessory | undefined;

      // See if we already know about this accessory or if it's truly new. If it is new, add it to HomeKit.
      if((accessory = this.platform.accessories.find(x => x.UUID === uuid)) === undefined) {

        accessory = new this.api.platformAccessory(device.name, uuid);

        this.log.info("%s: Adding %s to HomeKit.", this.nvrApi.getFullName(device), device.modelKey);

        // Register this accessory with homebridge and add it to the accessory array so we can track it.
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.platform.accessories.push(accessory);
      }

      // Link the accessory to it's device object and it's hosting NVR.
      accessory.context.device = device;
      accessory.context.nvr = this.nvrApi.bootstrap?.nvr.mac;

      // Setup the Protect device if it hasn't been configured yet.
      if(!this.configuredDevices[accessory.UUID]) {

        this.configureDevice(accessory, device);

      } else {

        // Device-specific periodic reconfiguration. We need to do this to reflect state changes in
        // the Protect NVR (e.g. device settings changes) that we want to catch. Many of the realtime
        // changes are sent through the realtime update API, but a few things aren't, so we deal with that
        // here.
        switch(device.modelKey) {

          case "camera":

            // Check if we have changes to the exposed RTSP streams on our cameras.
            void (this.configuredDevices[accessory.UUID] as ProtectCamera).configureVideoStream();

            // Check for changes to the doorbell LCD as well.
            if((device as ProtectCameraConfig).featureFlags.hasLcdScreen) {
              void (this.configuredDevices[accessory.UUID] as ProtectDoorbell).configureDoorbellLcdSwitch();
            }

            break;

          case "viewer":

            // Sync the viewer state with HomeKit.
            void (this.configuredDevices[accessory.UUID] as ProtectViewer).updateDevice();

            break;

          default:

            break;
        }
      }
    }

    return true;

  }

  // Discover and sync UniFi Protect devices between HomeKit and the Protect NVR.
  private discoverAndSyncAccessories(): boolean {

    if(this.nvrApi.cameras && !this.discoverDevices(this.nvrApi.cameras)) {
      this.log.error("%s: Error discovering camera devices.", this.nvrApi.getNvrName());
    }

    if(this.nvrApi.lights && !this.discoverDevices(this.nvrApi.lights)) {
      this.log.error("%s: Error discovering light devices.", this.nvrApi.getNvrName());
    }

    if(this.nvrApi.sensors && !this.discoverDevices(this.nvrApi.sensors)) {
      this.log.error("%s: Error discovering sensor devices.", this.nvrApi.getNvrName());
    }

    if(this.nvrApi.viewers && !this.discoverDevices(this.nvrApi.viewers)) {
      this.log.error("%s: Error discovering viewer devices.", this.nvrApi.getNvrName());
    }

    // Remove Protect devices that are no longer found on this Protect NVR, but we still have in HomeKit.
    this.cleanupDevices();

    // Configure our liveview-based accessories.
    this.liveviews?.configureLiveviews();

    // Configure our NVR system information-related accessories.
    this.systemInfo?.configureAccessory();

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
        this.refreshInterval = this.config.refreshInterval = PROTECT_NVR_UNIFIOS_REFRESH_INTERVAL;
      } else {
        this.refreshInterval = this.config.refreshInterval;
      }

      // In case someone puts in an overly aggressive default value.
      if(this.refreshInterval < 2) {
        this.refreshInterval = this.config.refreshInterval = 2;
      }

      refreshUpdated = true;
    }

    if(refreshUpdated || !this.isEnabled) {

      // On startup or refresh interval change, we want to notify the user.
      this.log.info("%s: Controller refresh interval set to %s seconds.", this.nvrApi.getNvrName(), this.refreshInterval);

    }

    this.isEnabled = true;

    // Create an MQTT connection, if needed.
    if(!this.mqtt && this.config.mqttUrl) {
      this.mqtt = new ProtectMqtt(this);
    }

    // Check for any updates to the events API connection.
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

      const oldDevice = oldAccessory.context.device as ProtectCameraConfig;
      const oldNvr = oldAccessory.context.nvr as string;

      // Since we're accessing the shared accessories list for the entire platform, we need to ensure we
      // are only touching our cameras and not another NVR's.
      if(oldNvr !== nvr.mac) {
        continue;
      }

      // The NVR system information accessory is handled elsewhere.
      if(("systemInfo" in oldAccessory.context)) {
        continue;
      }

      // Liveview-centric accessories are handled elsewhere.
      if(("liveview" in oldAccessory.context) || oldAccessory.getService(this.hap.Service.SecuritySystem)) {
        continue;
      }

      // We found this accessory and it's for this NVR. Figure out if we really want to see it in HomeKit.
      if(oldDevice) {

        // Check to see if the device still exists on the NVR and the user has not chosen to hide it.
        switch(oldDevice.modelKey) {
          case "camera":

            if(this.nvrApi.cameras?.some((x: ProtectCameraConfig) => x.mac === oldDevice.mac) &&
              this.optionEnabled(oldDevice)) {

              continue;
            }

            break;

          case "light":

            if(this.nvrApi.lights?.some((x: ProtectLightConfig) => x.mac === oldDevice.mac) &&
              this.optionEnabled(oldDevice)) {

              continue;
            }

            break;

          case "sensor":

            if(this.nvrApi.sensors?.some((x: ProtectSensorConfig) => x.mac === oldDevice.mac) &&
              this.optionEnabled(oldDevice)) {

              continue;
            }

            break;

          case "viewer":

            if(this.nvrApi.viewers?.some((x: ProtectViewerConfig) => x.mac === oldDevice.mac) &&
              this.optionEnabled(oldDevice)) {

              continue;
            }

            break;

          default:
            break;
        }

      }

      // Decrement our doorbell count.
      if(oldAccessory.getService(this.hap.Service.Doorbell)) {
        this.doorbellCount--;
      }

      // Remove this device.
      this.log.info("%s %s: Removing %s from HomeKit.", this.nvrApi.getNvrName(),
        oldDevice ? this.nvrApi.getDeviceName(oldDevice) : oldAccessory.displayName,
        oldDevice ? oldDevice.modelKey : "device");

      // Unregister the accessory and delete it's remnants from HomeKit and the plugin.
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [oldAccessory]);

      delete this.configuredDevices[oldAccessory.UUID];
      this.platform.accessories.splice(this.platform.accessories.indexOf(oldAccessory), 1);
    }
  }

  // Lookup a device by it's identifier and return the associated accessory, if any.
  public accessoryLookup(deviceId: string | undefined | null): PlatformAccessory | undefined {

    if(!deviceId) {
      return undefined;
    }

    // Find the device in our list of accessories.
    const foundDevice = Object.keys(this.configuredDevices).find(x => (this.configuredDevices[x].accessory.context.device as ProtectCameraConfig).id === deviceId);

    return foundDevice ? this.configuredDevices[foundDevice].accessory : undefined;
  }

  // Utility function to let us know if a device or feature should be enabled or not.
  public optionEnabled(device: ProtectDeviceConfigTypes | null, option = "", defaultReturnValue = true, address = "", addressOnly = false): boolean {

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

    // Nothing configured - we assume the default return value.
    if(!configOptions) {
      return defaultReturnValue;
    }

    // Upper case parameters for easier checks.
    option = option ? option.toUpperCase() : "";
    address = address ? address.toUpperCase() : "";

    const deviceMac = device?.mac ? device.mac.toUpperCase() : "";

    let optionSetting;

    // If we've specified an address parameter - we check for device and address-specific options before
    // anything else.
    if(address && option) {

      // Test for device-specific and address-specific option settings, used together.
      if(deviceMac) {

        optionSetting = option + "." + deviceMac + "." + address;

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
      optionSetting = option + "." + address;

      // We've explicitly enabled this option for this address.
      if(configOptions.indexOf("ENABLE." + optionSetting) !== -1) {
        return true;
      }

      // We've explicitly disabled this option for this address.
      if(configOptions.indexOf("DISABLE." + optionSetting) !== -1) {
        return false;
      }

      // We're only interested in address-specific options.
      if(addressOnly) {
        return false;
      }
    }

    // If we've specified a device, check for device-specific options first. Otherwise, we're dealing
    // with an NVR-specific or global option.
    if(deviceMac) {

      // First we test for camera-level option settings.
      // No option specified means we're testing to see if this device should be shown in HomeKit.
      optionSetting = option ? option + "." + deviceMac : deviceMac;

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
    const nvrMac = this.nvrApi.bootstrap.nvr.mac.toUpperCase();
    optionSetting = option ? option + "." + nvrMac : nvrMac;

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
  public optionGet(device: ProtectDeviceConfigTypes | null, option: string, address = ""): string | undefined {

    // Using the same rules as we do to test for whether an option is enabled, retrieve options with parameters and
    // return them. If we don't find anything, we return undefined.
    const configOptions = this.platform?.configOptions;

    // Nothing configured - we assume there's nothing.
    if(!configOptions || !option) {
      return undefined;
    }

    // Upper case parameters for easier checks.
    address = address ? address.toUpperCase() : "";
    option = option.toUpperCase();
    const deviceMac = device?.mac.toUpperCase() ?? null;

    let foundOption;
    let optionSetting: string;

    // If we've specified an address parameter - we check for device and address-specific options before
    // anything else.
    if(address) {

      // Test for device-specific and address-specific option settings, used together.
      if(deviceMac) {

        // We've explicitly enabled this option for this device and address combination.
        optionSetting = "ENABLE." + option + "." + deviceMac + "." + address + ".";

        if((foundOption = configOptions.find(x => optionSetting === x.slice(0, optionSetting.length))) !== undefined) {
          return foundOption.slice(optionSetting.length);
        }

        // We've explicitly disabled this option for this device and address combination.
        optionSetting = "DISABLE." + option + "." + deviceMac + "." + address;

        if(configOptions.indexOf(optionSetting) !== -1) {
          return undefined;
        }
      }

      // We've explicitly enabled this option for this address.
      optionSetting = "ENABLE." + option + "." + address + ".";

      if((foundOption = configOptions.find(x => optionSetting === x.slice(0, optionSetting.length))) !== undefined) {
        return foundOption.slice(optionSetting.length);
      }

      // We've explicitly disabled this option for this address.
      optionSetting = "DISABLE." + option + "." + address;

      if(configOptions.indexOf(optionSetting) !== -1) {
        return undefined;
      }
    }

    // If we've specified a device, check for device-specific options first. Otherwise, we're dealing
    // with an NVR-specific or global option.
    if(deviceMac) {

      // First we test for camera-level option settings.
      // No option specified means we're testing to see if this device should be shown in HomeKit.
      optionSetting = "ENABLE." + option + "." + deviceMac + ".";

      // We've explicitly enabled this option for this device.
      if((foundOption = configOptions.find(x => optionSetting === x.slice(0, optionSetting.length))) !== undefined) {
        return foundOption.slice(optionSetting.length);
      }

      // We've explicitly disabled this option for this device.
      optionSetting = "DISABLE." + option + "." + deviceMac;

      if(configOptions.indexOf(optionSetting) !== -1) {
        return undefined;
      }
    }

    // If we don't have a managing device attached, we're done here.
    if(!this.nvrApi.bootstrap?.nvr?.mac) {
      return undefined;
    }

    // Now we test for NVR-level option settings.
    // No option specified means we're testing to see if this NVR (and it's attached devices) should be shown in HomeKit.
    const nvrMac = this.nvrApi.bootstrap.nvr.mac.toUpperCase();
    optionSetting = "ENABLE." + option + "." + nvrMac + ".";

    // We've explicitly enabled this option for this NVR and all the devices attached to it.
    if((foundOption = configOptions.find(x => optionSetting === x.slice(0, optionSetting.length))) !== undefined) {
      return foundOption.slice(optionSetting.length);
    }

    // We've explicitly disabled this option for this NVR and all the devices attached to it.
    optionSetting = "DISABLE." + option + "." + nvrMac;

    if(configOptions.indexOf(optionSetting) !== -1) {
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
