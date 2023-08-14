/* Copyright(C) 2017-2023, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-nvr.ts: NVR device class for UniFi Protect.
 */
import { API, APIEvent, HAP, PlatformAccessory } from "homebridge";
import { PLATFORM_NAME, PLUGIN_NAME, PROTECT_CONTROLLER_REFRESH_INTERVAL, PROTECT_CONTROLLER_RETRY_INTERVAL, PROTECT_M3U_PLAYLIST_PORT } from "./settings.js";
import { ProtectApi, ProtectCameraConfig, ProtectChimeConfig, ProtectLightConfig, ProtectNvrBootstrap, ProtectNvrConfig,
  ProtectSensorConfig, ProtectViewerConfig } from "unifi-protect";
import { ProtectDeviceConfigTypes, ProtectDevices, ProtectLogging } from "./protect-types.js";
import { ProtectNvrOptions, getOptionFloat, getOptionNumber, getOptionValue, isOptionEnabled } from "./protect-options.js";
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
import http from "node:http";
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
  public systemInfo: ProtectNvrSystemInfo | null;
  public platform: ProtectPlatform;
  public ufp: ProtectNvrConfig;
  public ufpApi!: ProtectApi;
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

    // Attempt to bootstrap the controller until we're successful.
    await this.retry(() => this.ufpApi.getBootstrap(), PROTECT_CONTROLLER_RETRY_INTERVAL * 1000);
  }

  // Initialize our connection to the UniFi Protect controller.
  public async login(): Promise<void> {

    // The plugin has been disabled globally. Let the user know that we're done here.
    if(!this.hasFeature("Device")) {

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
    await this.retry(() => this.ufpApi.login(this.nvrOptions.address, this.nvrOptions.username, this.nvrOptions.password), PROTECT_CONTROLLER_RETRY_INTERVAL * 1000);

    // We successfully logged in.
    this.log.info("Connected to the UniFi Protect API at %s.", this.config.address);

    // Now, let's get the bootstrap configuration from the Protect controller.
    await this.bootstrapNvr();

    // Save the bootstrap to ease our device initialization below.
    const bootstrap = this.ufpApi.bootstrap as ProtectNvrBootstrap;

    // Set our NVR configuration from the controller.
    this.ufp = bootstrap.nvr;

    // Assign our name if the user hasn't explicitly specified a preference.
    this.name = this.nvrOptions.name ?? (this.ufp.name ?? this.ufp.marketName);

    // Mark this NVR as enabled or disabled.
    this.isEnabled = this.hasFeature("Device");

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

    // Initialize our playlist service, if enabled.
    if(this.getFeatureNumber("Nvr.Service.Playlist") !== undefined) {

      this.servePlaylist();
    }

    // Inform the user about the devices we see.
    for(const device of [ this.ufp, ...bootstrap.cameras, ...bootstrap.chimes, ...bootstrap.lights, ...bootstrap.sensors, ...bootstrap.viewers ] ) {

      // Filter out any devices that aren't adopted by this Protect controller.
      if((device.modelKey !== "nvr") &&
        ((device as ProtectDeviceConfigTypes).isAdoptedByOther || (device as ProtectDeviceConfigTypes).isAdopting || !(device as ProtectDeviceConfigTypes).isAdopted)) {

        continue;
      }

      this.log.info("Discovered %s: %s.", device.modelKey, this.ufpApi.getDeviceName(device, device.name ?? device.marketName, true));
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

    // Warn users if they're running versions of UniFi OS below 3.0.
    const firmwareVersion = this.ufp.firmwareVersion.split(".");

    if(parseInt(firmwareVersion[0]) < 3) {

      this.log.error("Warning: your Protect controller firmware version is less than UniFi OS 3.0. Some features may not work correctly.");
    }

    // Configure the default doorbell message on the NVR.
    await this.configureDefaultDoorbellMessage();
    return true;
  }

  // Configure a default doorbell message on the Protect doorbell.
  private async configureDefaultDoorbellMessage(): Promise<boolean> {

    // If we aren't an admin user, don't attempt to set the default doorbell message.
    if(!this.ufpApi.isAdminUser) {

      return false;
    }

    // Set the default doorbell message to either what the user configured, or the Protect default.
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
        if((device as ProtectCameraConfig).featureFlags.isDoorbell) {

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

        this.log.error("Unknown device class `%s` detected for ``%s``", device.modelKey, device.name ?? device.marketName);

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
    if(!this.ufp?.mac || !device || !device.mac || device.isAdoptedByOther || !device.isAdopted) {

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

      accessory = new this.api.platformAccessory(device.name ?? device.marketName, uuid);

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

          // If it's not a package camera, we're done.
          if(!("packageCamera" in accessory.context)) {

            continue;
          }

          if((accessory.context.packageCamera as string).length) {

            const uuid = this.hap.uuid.generate(accessory.context.packageCamera as string);

            // If we have a matching parent camera for the package camera, we're done here. Otherwise, this is an orphan that we need to remove.
            if(this.platform.accessories.some(x => x.UUID === uuid)) {

              continue;
            }
          }
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

          if(this.ufpApi.bootstrap.cameras.some((x: ProtectCameraConfig) => x.mac === protectDevice.ufp.mac) && protectDevice.hasFeature("Device")) {

            continue;
          }

          break;

        case "chime":

          if(this.ufpApi.bootstrap.chimes.some((x: ProtectChimeConfig) => x.mac === protectDevice.ufp.mac) && protectDevice.hasFeature("Device")) {

            continue;
          }

          break;

        case "light":

          if(this.ufpApi.bootstrap.lights.some((x: ProtectLightConfig) => x.mac === protectDevice.ufp.mac) && protectDevice.hasFeature("Device")) {

            continue;
          }

          break;

        case "sensor":

          if(this.ufpApi.bootstrap.sensors.some((x: ProtectSensorConfig) => x.mac === protectDevice.ufp.mac) && protectDevice.hasFeature("Device")) {

            continue;
          }

          break;

        case "viewer":

          if(this.ufpApi.bootstrap.viewers.some((x: ProtectViewerConfig) => x.mac === protectDevice.ufp.mac) && protectDevice.hasFeature("Device")) {

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

  // Remove an individual Protect device from HomeKit.
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

      const uuid = this.hap.uuid.generate(protectDevice.accessory.context.packageCamera as string);

      // If we have a matching parent camera, we're done here. Otherwise, this is an orphan that we need to remove.
      if(this.platform.accessories.some(x => x.UUID === uuid)) {

        return;
      }
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

      const protectDoorbell = protectDevice as ProtectDoorbell;

      if(protectDoorbell && protectDoorbell.packageCamera) {

        // Ensure we delete the accessory and cleanup after ourselves.
        deletingAccessories.push(protectDoorbell.packageCamera.accessory);
        protectDoorbell.packageCamera.cleanup();
        protectDoorbell.packageCamera = null;
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

  // Create a web service to publish an M3U playlist of Protect camera livestreams.
  private servePlaylist(): void {

    const port = this.getFeatureNumber("Nvr.Service.Playlist") ?? PROTECT_M3U_PLAYLIST_PORT;
    const server = http.createServer();

    // Respond to requests for a Protect camera playlist.
    server.on("request", (request, response) => {

      // Set the right MIME type for M3U playlists.
      response.writeHead(200, { "Content-Type": "application/x-mpegURL" });

      // Output the M3U header.
      response.write("#EXTM3U\n");

      // Make sure we have access to the Protect API bootstrap before we begin.
      if(this.ufpApi.bootstrap) {

        // Find the RTSP aliases and publish them. We filter out any cameras that don't have RTSP aliases since they would be inaccessible in this context.
        for(const camera of this.ufpApi.bootstrap.cameras.filter(x => x.channels.some(channel => channel.isRtspEnabled)).sort((a, b) => {

          if(a.name < b.name) {

            return -1;
          }

          if(a.name > b.name) {

            return 1;
          }

          return 0;
        })) {

          // Publish a playlist entry, including guide information that's suitable for apps that support it, such as Channels DVR.
          const publishEntry = (name = camera.name, description = "camera", rtspAlias = camera.channels[0].rtspAlias): void => {

            response.write(util.format("#EXTINF:0 channel-id=\"%s\" tvc-stream-vcodec=\"h264\" tvc-stream-acodec=\"opus\" tvg-logo=\"%s\" ",
              name, "https://raw.githubusercontent.com/hjdhjd/homebridge-unifi-protect/main/images/homebridge-unifi-protect-4x3.png"));

            response.write(util.format("tvc-guide-title=\"%s Livestream\" tvc-guide-description=\"UniFi Protect %s %s livestream.\" ",
              name, camera.marketName, description));

            response.write(util.format("tvc-guide-art=\"%s\" tvc-guide-tags=\"HD, Live, New, UniFi Protect\", %s\n",
              "https://raw.githubusercontent.com/hjdhjd/homebridge-unifi-protect/main/images/homebridge-unifi-protect-4x3.png", name));

            // By convention, the first RTSP alias is always the highest quality on UniFi Protect cameras. Grab it and we're done. We might be tempted
            // to use the RTSPS stream here, but many apps only supports RTSP, and we'll opt for maximizing compatibility here.
            response.write(util.format("rtsp://%s:%s/%s\n", this.ufpApi.bootstrap?.nvr.host, this.ufpApi.bootstrap?.nvr.ports.rtsp, rtspAlias));
          };

          // Create a playlist entry for each camera.
          publishEntry();

          // Ensure we publish package cameras as well, when we have them.
          if(camera.featureFlags.hasPackageCamera) {

            const packageChannel = camera.channels.find(x => x.isRtspEnabled && (x.name === "Package Camera"));

            if(!packageChannel) {

              continue;
            }

            publishEntry(camera.name + " " + packageChannel.name, "package camera", packageChannel.rtspAlias);
          }
        }
      }

      // We're done with this response.
      response.end();
    });

    // Handle errors when they occur.
    server.on("error", (error) => {

      // Explicitly handle address in use errors, given their relative common nature. Everything else, we log and abandon.
      if((error as NodeJS.ErrnoException).code === "EADDRINUSE") {

        this.log.error("The address and port we are attempting to use is already in use by something else. Will retry again shortly.");

        setTimeout(() => {

          server.close();
          server.listen(port);
        }, 5000);

        return;
      }

      this.log.error("M3U playlist publisher error: %s", error);
      server.close();
    });

    // Let users know we're up and running.
    server.on("listening", () => {

      this.log.info("Publishing an M3U playlist of Protect camera livestream URLs on port %s.", port);
    });

    // Listen on the port we've configured.
    server.listen(port);
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

  // Utility function to return a floating point configuration parameter on a device.
  public getFeatureFloat(option: string): number | undefined {

    return getOptionFloat(getOptionValue(this.platform.configOptions, this.ufp, null, option));
  }

  // Utility function to return an integer configuration parameter on a device.
  public getFeatureNumber(option: string): number | undefined {

    return getOptionNumber(getOptionValue(this.platform.configOptions, this.ufp, null, option));
  }

  // Utility for checking feature options on the NVR.
  public hasFeature(option: string): boolean {

    return isOptionEnabled(this.platform.configOptions, this.ufp, null, option, this.platform.featureOptionDefault(option));
  }

  // Utility function to let us know if a device or feature should be enabled or not.
  public optionEnabled(device: ProtectDeviceConfigTypes | ProtectNvrConfig | null, option = "", defaultReturnValue = true): boolean {

    return isOptionEnabled(this.platform.configOptions, this.ufp, device, option, defaultReturnValue);
  }

  // Emulate a sleep function.
  public sleep(sleepTimer: number): Promise<NodeJS.Timeout> {

    return new Promise(resolve => setTimeout(resolve, sleepTimer));
  }

  // Retry an operation until we're successful.
  private async retry(operation: () => Promise<boolean>, retryInterval: number): Promise<boolean> {

    // Try the operation that was requested.
    if(!(await operation())) {

      // If the operation wasn't successful, let's sleep for the requested interval and try again.
      await this.sleep(retryInterval);
      return this.retry(operation, retryInterval);
    }

    // We were successful - we're done.
    return true;
  }
}
