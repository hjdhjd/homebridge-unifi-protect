/* Copyright(C) 2017-2023, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-nvr.ts: NVR device class for UniFi Protect.
 */
import { API, APIEvent, HAP, PlatformAccessory } from "homebridge";
import { PLATFORM_NAME, PLUGIN_NAME, PROTECT_CONTROLLER_REFRESH_INTERVAL, PROTECT_CONTROLLER_RETRY_INTERVAL } from "./settings.js";
import { ProtectApi, ProtectCameraConfig, ProtectChimeConfig, ProtectLightConfig, ProtectNvrBootstrap, ProtectNvrConfig,
  ProtectSensorConfig, ProtectViewerConfig } from "unifi-protect";
import { ProtectDeviceConfigTypes, ProtectDevices, ProtectLogging } from "./protect-types.js";
import { ProtectNvrOptions, optionEnabled } from "./protect-options.js";
import { ProtectCamera } from "./protect-camera.js";
import { ProtectChime } from "./protect-chime.js";
import { ProtectDevice } from "./protect-device.js";
import { ProtectDoorbell } from "./protect-doorbell.js";
import { ProtectLight } from "./protect-light.js";
import { ProtectLiveviews } from "./protect-liveviews.js";
import { ProtectMqtt } from "./protect-mqtt.js";
import { ProtectNvrEvents } from "./protect-nvr-events.js";
import { ProtectNvrSystemInfo } from "./protect-nvr-systeminfo.js";
import { ProtectPlatform } from "./protect-platform.js";
import { ProtectSensor } from "./protect-sensor.js";
import { ProtectViewer } from "./protect-viewer.js";
import util from "node:util";

export class ProtectNvr {

  private api: API;
  public config: ProtectNvrOptions;
  public readonly configuredDevices: { [index: string]: ProtectDevices };
  public events!: ProtectNvrEvents;
  private isEnabled: boolean;
  private hap: HAP;
  private lastMotion: { [index: string]: number };
  private lastRing: { [index: string]: number };
  private liveviews: ProtectLiveviews | null;
  public logApiErrors: boolean;
  public readonly log: ProtectLogging;
  public mqtt: ProtectMqtt | null;
  private name: string;
  public nvrOptions: ProtectNvrOptions;
  public ufpApi!: ProtectApi;
  public systemInfo: ProtectNvrSystemInfo | null;
  public platform: ProtectPlatform;
  public ufp: ProtectNvrConfig;
  private unsupportedDevices: { [index: string]: boolean };

  constructor(platform: ProtectPlatform, nvrOptions: ProtectNvrOptions) {

    this.api = platform.api;
    this.config = nvrOptions;
    this.configuredDevices = {};
    this.isEnabled = false;
    this.hap = this.api.hap;
    this.lastMotion = {};
    this.lastRing = {};
    this.liveviews = null;
    this.logApiErrors = true;
    this.mqtt = null;
    this.name = nvrOptions.name ?? nvrOptions.address;
    this.nvrOptions = nvrOptions;
    this.platform = platform;
    this.systemInfo = null;
    this.ufp = {} as ProtectNvrConfig;
    this.unsupportedDevices = {};

    // Configure our logging.
    this.log = {

      debug: (message: string, ...parameters: unknown[]): void => this.platform.debug(util.format(this.name + ": " + message, ...parameters)),
      error: (message: string, ...parameters: unknown[]): void => this.platform.log.error(util.format(this.name + ": " + message, ...parameters)),
      info: (message: string, ...parameters: unknown[]): void => this.platform.log.info(util.format(this.name + ": " + message, ...parameters)),
      warn: (message: string, ...parameters: unknown[]): void => this.platform.log.warn(util.format(this.name + ": " + message, ...parameters))
    };

    // Validate our Protect address and login information.
    if(!nvrOptions.address || !nvrOptions.username || !nvrOptions.password) {
      return;
    }

    // Make sure we cleanup any remaining streaming sessions on shutdown.
    this.api.on(APIEvent.SHUTDOWN, () => {

      for(const protectDevice of Object.values(this.configuredDevices)) {

        if(("ufp" in protectDevice) && (protectDevice.ufp.modelKey === "camera")) {

          protectDevice.log.debug("Shutting down all video stream processes.");
          void (protectDevice as ProtectCamera).stream?.shutdown();
        }
      }
    });
  }

  // Retrieve the bootstrap configuration from the Protect controller.
  private async bootstrapNvr(): Promise<void> {

    // Gently bootstrap the Protect controller until we're successful.
    for(;;) {

      // Bootstrap the controller.
      // eslint-disable-next-line no-await-in-loop
      if(!(await this.ufpApi.getBootstrap())) {

        // We didn't succeed, let's sleep for a bit and try again.
        // eslint-disable-next-line no-await-in-loop
        await this.sleep(PROTECT_CONTROLLER_RETRY_INTERVAL * 1000);
        continue;
      }

      break;
    }
  }

  // Initialize our connection to the UniFi Protect controller.
  public async login(): Promise<void> {

    // The plugin has been disabled globally. Let the user know that we're done here.
    if(!this.optionEnabled(null, "Device")) {

      this.log.info("Disabling this UniFi Protect controller.");
      return;
    }

    // Initialize our connection to the UniFi Protect API.
    const ufpLog = {

      debug: (message: string, ...parameters: unknown[]): void => this.platform.debug(util.format(message, ...parameters)),
      error: (message: string, ...parameters: unknown[]): void => {

        if(this.logApiErrors) {

          this.platform.log.error(util.format(message, ...parameters));
        }
      },
      info: (message: string, ...parameters: unknown[]): void => this.platform.log.info(util.format(message, ...parameters)),
      warn: (message: string, ...parameters: unknown[]): void => this.platform.log.warn(util.format(message, ...parameters))
    };

    // Create our connection to the Protect API.
    this.ufpApi = new ProtectApi(ufpLog);

    // Attempt to login to the Protect controller, retrying at reasonable intervals. This accounts for cases where the Protect controller or the network connection
    // may not be fully available when we startup.
    for(;;) {

      // Let's attempt to login, retrying if we have an issue logging in.
      // eslint-disable-next-line no-await-in-loop
      if(!(await this.ufpApi.login(this.nvrOptions.address, this.nvrOptions.username, this.nvrOptions.password))) {

        // eslint-disable-next-line no-await-in-loop
        await this.sleep(PROTECT_CONTROLLER_RETRY_INTERVAL * 1000);
        continue;
      }

      // We logged in successfully.
      this.log.info("Connected to the UniFi Protect API at %s.", this.config.address);
      break;
    }

    // Now, let's get the bootstrap configuration from the Protect controller.
    await this.bootstrapNvr();

    // Save the bootstrap to ease our device initialization below.
    const bootstrap = this.ufpApi.bootstrap as ProtectNvrBootstrap;

    // Set our NVR configuration from the controller.
    this.ufp = bootstrap.nvr;

    // Assign our name if the user hasn't explicitly specified a preference.
    this.name = this.nvrOptions.name ?? this.ufp.name;

    // Mark this NVR as enabled or disabled.
    this.isEnabled = this.optionEnabled(this.ufp, "Device");

    // If the Protect controller is disabled, we're done.
    if(!this.isEnabled) {

      this.ufpApi.clearLoginCredentials();
      this.log.info("Disabling this UniFi Protect controller in HomeKit.");

      // Let's sleep for thirty seconds to give all the accessories a chance to load before disabling everything. Homebridge doesn't have a good mechanism to notify us
      // when all the cached accessories are loaded at startup.
      await this.sleep(30);

      // Unregister all the accessories for this controller from Homebridge that may have been restored already. Any additional ones will be automatically caught when
      // they are restored.
      this.removeHomeKitAccessories(this.platform.accessories.filter(x => x.context.nvr === this.ufp.mac));
      return;
    }

    // Initialize our UniFi Protect realtime event handler.
    this.events = new ProtectNvrEvents(this);

    // Configure any NVR-specific settings.
    void this.configureNvr();

    // Initialize our liveviews.
    this.liveviews = new ProtectLiveviews(this);

    // Initialize our NVR system information.
    this.systemInfo = new ProtectNvrSystemInfo(this);

    // Initialize MQTT, if needed.
    if(!this.mqtt && this.config.mqttUrl) {

      this.mqtt = new ProtectMqtt(this);
    }

    // Inform the user about the devices we see.
    this.log.info("Discovered %s: %s.", this.ufp.modelKey, this.ufpApi.getDeviceName(this.ufp, this.ufp.name, true));

    for(const device of [ ...bootstrap.cameras, ...bootstrap.chimes, ...bootstrap.lights, ...bootstrap.sensors, ...bootstrap.viewers ] ) {

      // Filter out any devices that aren't adopted by this Protect controller.
      if(device.isAdoptedByOther || device.isAdopting || !device.isAdopted) {

        continue;
      }

      this.log.info("Discovered %s: %s.", device.modelKey, this.ufpApi.getDeviceName(device, device.name, true));
    }

    // Sync the Protect controller's devices with HomeKit.
    const syncUfpHomeKit = (): void => {

      // Sync status and check for any new or removed accessories.
      this.discoverAndSyncAccessories();

      // Refresh the accessory cache.
      this.api.updatePlatformAccessories(this.platform.accessories);
    };

    // Initialize our Protect controller device sync.
    syncUfpHomeKit();

    // Let's set a listener to wait for bootstrap events to occur so we can keep ourselves in sync with the Protect controller.
    this.ufpApi.on("bootstrap", () => {

      // Sync our device view.
      syncUfpHomeKit();

      // Sleep until it's time to bootstrap again.
      setTimeout(() => void this.bootstrapNvr(), PROTECT_CONTROLLER_REFRESH_INTERVAL * 1000);
    });

    // Fire off the first round of regular bootstrap updates to ensure we stay in sync.
    setTimeout(() => void this.bootstrapNvr(), PROTECT_CONTROLLER_REFRESH_INTERVAL * 1000);
  }

  // Configure NVR-specific settings.
  private async configureNvr(): Promise<boolean> {

    // Configure the default doorbell message on the NVR.
    await this.configureDefaultDoorbellMessage();
    return true;
  }

  // Configure a default doorbell message on the Protect doorbell.
  private async configureDefaultDoorbellMessage(): Promise<boolean> {

    const defaultMessage = this.nvrOptions.defaultDoorbellMessage ?? "WELCOME";

    // Set the default message.
    const newUfp = await this.ufpApi.updateDevice(this.ufp, { doorbellSettings: { defaultMessageText: defaultMessage } });

    if(!newUfp) {

      this.log.error("Unable to set the default doorbell message. Please ensure this username has the Administrator role in UniFi Protect.");
      return false;
    }

    // Update our internal view of the NVR configuration.
    this.ufp = newUfp;

    // Inform the user.
    this.log.info("Default doorbell message set to: %s.", defaultMessage);

    return true;
  }

  // Create instances of Protect device types in our plugin.
  private addProtectDevice(accessory: PlatformAccessory, device: ProtectDeviceConfigTypes): boolean {

    if(!accessory || !device) {
      return false;
    }

    switch(device.modelKey) {

      case "camera":

        // We have a UniFi Protect camera or doorbell.
        if((device as ProtectCameraConfig).featureFlags.hasChime) {

          this.configuredDevices[accessory.UUID] = new ProtectDoorbell(this, device as ProtectCameraConfig, accessory);
        } else {

          this.configuredDevices[accessory.UUID] = new ProtectCamera(this, device as ProtectCameraConfig, accessory);
        }

        return true;

        break;

      case "chime":

        // We have a UniFi Protect chime.
        this.configuredDevices[accessory.UUID] = new ProtectChime(this, device as ProtectChimeConfig, accessory);

        return true;

        break;

      case "light":

        // We have a UniFi Protect light.
        this.configuredDevices[accessory.UUID] = new ProtectLight(this, device as ProtectLightConfig, accessory);

        return true;

        break;

      case "sensor":

        // We have a UniFi Protect sensor.
        this.configuredDevices[accessory.UUID] = new ProtectSensor(this, device as ProtectSensorConfig, accessory);

        return true;

        break;

      case "viewer":

        // We have a UniFi Protect viewer.
        this.configuredDevices[accessory.UUID] = new ProtectViewer(this, device as ProtectViewerConfig, accessory);

        return true;

        break;

      default:

        this.log.error("Unknown device class `%s` detected for ``%s``", device.modelKey, device.name);

        return false;
    }
  }

  // Discover UniFi Protect devices that may have been added to the NVR since we last checked.
  private discoverDevices(devices: ProtectDeviceConfigTypes[]): boolean {

    // Iterate through the list of cameras that Protect has returned and sync them with what we show HomeKit.
    for(const device of devices) {

      this.addHomeKitDevice(device);
    }

    return true;
  }

  // Add a newly detected Protect device to HomeKit.
  public addHomeKitDevice(device: ProtectDeviceConfigTypes): ProtectDevice | null {

    // If we have no MAC address, name, or this camera isn't being managed by this Protect controller, we're done.
    if(!this.ufp?.mac || !device || !device.mac || !device.name || device.isAdoptedByOther || !device.isAdopted) {

      return null;
    }

    // We only support certain devices.
    switch(device.modelKey) {

      case "camera":
      case "chime":
      case "light":
      case "sensor":
      case "viewer":

        break;

      default:

        // If we've already informed the user about this one, we're done.
        if(this.unsupportedDevices[device.mac]) {

          return null;
        }

        // Notify the user we see this device, but we aren't adding it to HomeKit.
        this.unsupportedDevices[device.mac] = true;

        this.log.info("UniFi Protect device type '%s' is not currently supported, ignoring: %s.", device.modelKey, this.ufpApi.getDeviceName(device));
        return null;

        break;
    }

    // Exclude or include certain devices based on configuration parameters.
    if(!this.optionEnabled(device, "Device")) {

      return null;
    }

    // Generate this device's unique identifier.
    const uuid = this.hap.uuid.generate(device.mac);

    let accessory: PlatformAccessory | undefined;

    // See if we already know about this accessory or if it's truly new. If it is new, add it to HomeKit.
    if((accessory = this.platform.accessories.find(x => x.UUID === uuid)) === undefined) {

      accessory = new this.api.platformAccessory(device.name, uuid);

      this.log.info("%s: Adding %s to HomeKit.", this.ufpApi.getFullName(device), device.modelKey);

      // Register this accessory with homebridge and add it to the accessory array so we can track it.
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.platform.accessories.push(accessory);
      this.api.updatePlatformAccessories(this.platform.accessories);
    }

    // Link the accessory to it's device object and it's hosting NVR.
    accessory.context.nvr = this.ufp.mac;

    // Locate our existing Protect device instance, if we have one.
    const protectDevice = this.configuredDevices[accessory.UUID];

    // Setup the Protect device if it hasn't been configured yet.
    if(!protectDevice) {

      this.addProtectDevice(accessory, device);
    }

    return protectDevice;
  }

  // Discover and sync UniFi Protect devices between HomeKit and the Protect controller.
  private discoverAndSyncAccessories(): boolean {

    if(!this.ufpApi.bootstrap) {

      return false;
    }

    if(this.ufpApi.bootstrap.cameras && !this.discoverDevices(this.ufpApi.bootstrap?.cameras)) {

      this.log.error("Error discovering camera devices.");
    }

    if(this.ufpApi.bootstrap.chimes && !this.discoverDevices(this.ufpApi.bootstrap?.chimes)) {

      this.log.error("Error discovering chime devices.");
    }

    if(this.ufpApi.bootstrap.lights && !this.discoverDevices(this.ufpApi.bootstrap?.lights)) {

      this.log.error("Error discovering light devices.");
    }

    if(this.ufpApi.bootstrap.sensors && !this.discoverDevices(this.ufpApi.bootstrap?.sensors)) {

      this.log.error("Error discovering sensor devices.");
    }

    if(this.ufpApi.bootstrap.viewers && !this.discoverDevices(this.ufpApi.bootstrap?.viewers)) {

      this.log.error("Error discovering viewer devices.");
    }

    // Remove Protect devices that are no longer found on this Protect NVR, but we still have in HomeKit.
    this.cleanupDevices();

    // Configure our liveview-based accessories.
    this.liveviews?.configureLiveviews();

    // Update our viewer accessories.
    Object.keys(this.configuredDevices)
      .filter(x => this.configuredDevices[x].ufp.modelKey === "viewer")
      .map(x => (this.configuredDevices[x] as ProtectViewer).updateDevice());

    return true;
  }

  // Cleanup removed Protect devices from HomeKit.
  private cleanupDevices(): void {

    for(const accessory of this.platform.accessories) {

      const protectDevice = this.configuredDevices[accessory.UUID];

      // Check to see if we have an orphan - where we haven't configured this in the plugin, but the accessory still exists in HomeKit. One example of
      // when this might happen is when Homebridge might be shutdown and a camera removed. When we start back up, the camera still exists in HomeKit but
      // not in Protect. We catch those orphan devices here.
      if(!protectDevice) {

        // We only remove devices if they're on the Protect controller we're interested in.
        if(("nvr" in accessory.context) && (accessory.context.nvr !== this.ufp.mac)) {

          continue;
        }

        // We only store MAC addresses on devices that exist on the Protect controller. Any other accessories created are ones we created ourselves
        // and are managed elsewhere.
        if(!("mac" in accessory.context)) {

          continue;
        }

        this.log.info("%s: Removing device from HomeKit.", accessory.displayName);

        // Unregister the accessory and delete it's remnants from HomeKit.
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [ accessory ]);
        this.platform.accessories.splice(this.platform.accessories.indexOf(accessory), 1);
        this.api.updatePlatformAccessories(this.platform.accessories);

        continue;
      }

      // If we don't have the Protect bootstrap JSON available, we're done. We need to know what's on the Protect controller in order to determine what
      // to do with the accessories we know about.
      if(!this.ufpApi.bootstrap) {

        continue;
      }

      // Check to see if the device still exists on the Protect controller and the user has not chosen to hide it.
      switch(protectDevice.ufp.modelKey) {

        case "camera":

          if(this.ufpApi.bootstrap.cameras.some((x: ProtectCameraConfig) => x.mac === protectDevice.ufp.mac) && this.optionEnabled(protectDevice.ufp, "Device")) {

            continue;
          }

          break;

        case "chime":

          if(this.ufpApi.bootstrap.chimes.some((x: ProtectChimeConfig) => x.mac === protectDevice.ufp.mac) && this.optionEnabled(protectDevice.ufp, "Device")) {

            continue;
          }

          break;

        case "light":

          if(this.ufpApi.bootstrap.lights.some((x: ProtectLightConfig) => x.mac === protectDevice.ufp.mac) && this.optionEnabled(protectDevice.ufp, "Device")) {

            continue;
          }

          break;

        case "sensor":

          if(this.ufpApi.bootstrap.sensors.some((x: ProtectSensorConfig) => x.mac === protectDevice.ufp.mac) && this.optionEnabled(protectDevice.ufp, "Device")) {

            continue;
          }

          break;

        case "viewer":

          if(this.ufpApi.bootstrap.viewers.some((x: ProtectViewerConfig) => x.mac === protectDevice.ufp.mac) && this.optionEnabled(protectDevice.ufp, "Device")) {

            continue;
          }

          break;

        default:
          break;
      }

      // Process the device removal.
      this.removeHomeKitDevice(this.configuredDevices[accessory.UUID]);
    }
  }

  // Cleanup removed Protect devices from HomeKit.
  public removeHomeKitDevice(protectDevice: ProtectDevice): void {

    // Sanity check.
    if(!protectDevice) {

      return;
    }

    // We only remove devices if they're on the Protect controller we're interested in.
    if(protectDevice.accessory.context.nvr !== this.ufp.mac) {

      return;
    }

    // Package cameras are handled elsewhere.
    if("packageCamera" in protectDevice.accessory.context) {

      return;
    }

    // The NVR system information accessory is handled elsewhere.
    if("systemInfo" in protectDevice.accessory.context) {

      return;
    }

    // Liveview-centric accessories are handled elsewhere.
    if(("liveview" in protectDevice.accessory.context) || protectDevice.accessory.getService(this.hap.Service.SecuritySystem)) {

      return;
    }

    // Remove this device.
    this.log.info("%s: Removing %s from HomeKit.",
      protectDevice.ufp.name ? this.ufpApi.getDeviceName(protectDevice.ufp) : protectDevice.accessory.displayName,
      protectDevice.ufp.modelKey ? protectDevice.ufp.modelKey : "device");

    const deletingAccessories = [ protectDevice.accessory ];

    // Check to see if we're removing a camera device that has a package camera as well.
    if(protectDevice.ufp.modelKey === "camera") {

      const protectCamera = protectDevice as ProtectCamera;

      if(protectCamera && protectCamera.packageCamera) {

        // Ensure we delete the accessory and cleanup after ourselves.
        deletingAccessories.push(protectCamera.packageCamera.accessory);
        protectCamera.packageCamera.cleanup();
        protectCamera.packageCamera = null;
      }
    }

    // Cleanup our event handlers.
    protectDevice.cleanup();

    // Unregister the accessory and delete it's remnants from HomeKit and the plugin.
    delete this.configuredDevices[protectDevice.accessory.UUID];
    this.removeHomeKitAccessories(deletingAccessories);
  }

  // Remove accessories from HomeKit and Homebridge.
  private removeHomeKitAccessories(deletingAccessories: PlatformAccessory[]): void {

    // Sanity check.
    if(!deletingAccessories || (deletingAccessories.length <= 0)) {

      return;
    }

    // Unregister the accessories from Homebridge and HomeKit.
    this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, deletingAccessories);

    // Update our internal list of all the accessories we know about.
    for(const accessory of deletingAccessories) {

      this.platform.accessories.splice(this.platform.accessories.indexOf(accessory), 1);
    }

    // Tell Homebridge to save the updated list of accessories.
    this.api.updatePlatformAccessories(this.platform.accessories);
  }

  // Reauthenticate with the NVR and reset any HKSV timeshift buffers, as needed.
  public async resetNvrConnection(): Promise<void> {

    // Clear our login credentials.
    this.ufpApi.clearLoginCredentials();

    // Bootstrap the Protect NVR.
    if(!(await this.ufpApi.getBootstrap())) {

      return;
    }

    // Inform all HKSV-enabled devices that are using a timeshift buffer to reset.
    // protectCamera.hints.timeshift for timeshift buffer enablement.
    //
    for(const accessory of this.platform.accessories) {

      // Retrieve the HBUP object for this device.
      const protectDevice = this.configuredDevices[accessory.UUID] as ProtectCamera;

      // Ensure it's a camera device and that we have HKSV as well as timeshifting enabled.
      if((protectDevice?.ufp?.modelKey !== "camera") || !protectDevice.hasHksv || !protectDevice.hints.timeshift) {

        continue;
      }

      // Restart the timeshift buffer.
      // eslint-disable-next-line no-await-in-loop
      await protectDevice.stream.hksv?.restartTimeshifting();
    }
  }

  // Lookup a device by it's identifier and return it if it exists.
  public deviceLookup(deviceId: string): ProtectDevices | null {

    // Find the device.
    const foundDevice = Object.keys(this.configuredDevices).find(x => (this.configuredDevices[x].ufp).id === deviceId);

    return foundDevice ? this.configuredDevices[foundDevice] : null;
  }

  // Utility function to let us know if a device or feature should be enabled or not.
  public optionEnabled(device: ProtectDeviceConfigTypes | ProtectNvrConfig | null, option = "", defaultReturnValue = true, address = "", addressOnly = false): boolean {

    return optionEnabled(this.platform.configOptions, this.ufp, device, option, defaultReturnValue, address, addressOnly);
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
    if(!this.ufp.mac) {

      return undefined;
    }

    // Now we test for NVR-level option settings.
    // No option specified means we're testing to see if this NVR (and it's attached devices) should be shown in HomeKit.
    const nvrMac = this.ufp.mac.toUpperCase();
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
  public sleep(ms: number): Promise<NodeJS.Timeout> {

    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
