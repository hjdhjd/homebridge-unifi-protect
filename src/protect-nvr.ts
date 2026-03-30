/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-nvr.ts: NVR device class for UniFi Protect.
 */
import type { API, HAP, PlatformAccessory } from "homebridge";
import { type HomebridgePluginLogging, MqttClient, type Nullable, retry, sanitizeName, sleep } from "homebridge-plugin-utils";
import { PLATFORM_NAME, PLUGIN_NAME, PROTECT_CONTROLLER_REFRESH_INTERVAL, PROTECT_CONTROLLER_RETRY_INTERVAL, PROTECT_M3U_PLAYLIST_PORT,
  PROTECT_NVR_REBOOT_INTERVAL, PROTECT_NVR_REBOOT_MIN_INTERVAL, PROTECT_NVR_REBOOT_RECONNECT_DELAY } from "./settings.js";
import { ProtectCamera, ProtectChime, type ProtectDevice, ProtectDoorbell, ProtectLight, ProtectLiveviews, ProtectNvrSystemInfo, ProtectSensor,
  ProtectViewer } from "./devices/index.js";
import { ProtectDeviceCategories, exhaustiveGuard } from "./protect-types.js";
import type { ProtectDeviceConfigTypes, ProtectDeviceTypes, ProtectDevices } from "./protect-types.js";
import { APIEvent } from "homebridge";
import { ProtectApi } from "unifi-protect";
import { ProtectEvents } from "./protect-events.js";
import type { ProtectNvrConfig } from "unifi-protect";
import type { ProtectNvrOptions } from "./protect-options.js";
import type { ProtectPlatform } from "./protect-platform.js";
import http from "node:http";
import util from "node:util";

export class ProtectNvr {

  private api: API;
  private bootstrapRefreshTimer: Nullable<NodeJS.Timeout>;
  public readonly config: ProtectNvrOptions;
  public readonly configuredDevices: Map<string, ProtectDevices>;
  private deviceRemovalQueue: Map<string, number>;
  public readonly events: ProtectEvents;
  private featureLog: Record<string, boolean>;
  private hap: HAP;
  private liveviews: Nullable<ProtectLiveviews>;
  public readonly log: HomebridgePluginLogging;
  public logApiErrors: boolean;
  public mqtt: Nullable<MqttClient>;
  private name: string;
  private nvrRebootTimer: Nullable<NodeJS.Timeout>;
  public readonly platform: ProtectPlatform;
  public systemInfo: Nullable<ProtectNvrSystemInfo>;
  public ufp: ProtectNvrConfig;
  public readonly ufpApi: ProtectApi;
  private unsupportedDevices: Record<string, boolean>;

  constructor(platform: ProtectPlatform, nvrOptions: ProtectNvrOptions) {

    this.api = platform.api;
    this.bootstrapRefreshTimer = null;
    this.config = nvrOptions;
    this.configuredDevices = new Map();
    this.deviceRemovalQueue = new Map();
    this.featureLog = {};
    this.hap = this.api.hap;
    this.liveviews = null;
    this.logApiErrors = true;
    this.mqtt = null;
    this.name = nvrOptions.name ?? nvrOptions.address;
    this.nvrRebootTimer = null;
    this.platform = platform;
    this.systemInfo = null;
    this.ufp = {} as ProtectNvrConfig;
    this.unsupportedDevices = {};

    // Configure our API logging.
    const ufpLog = {

      debug: (message: string, ...parameters: unknown[]): void => { this.platform.debug(util.format(message, ...parameters)); },
      error: (message: string, ...parameters: unknown[]): void => {

        if(this.logApiErrors) {

          this.platform.log.error(util.format(message, ...parameters));
        }
      },
      info: (message: string, ...parameters: unknown[]): void => { this.platform.log.info(util.format(message, ...parameters)); },
      warn: (message: string, ...parameters: unknown[]): void => { this.platform.log.warn(util.format(message, ...parameters)); }
    };

    // Initialize our connection to the UniFi Protect API.
    this.ufpApi = new ProtectApi(ufpLog);

    // Configure our controller logging.
    this.log = {

      debug: (message: string, ...parameters: unknown[]): void => { this.platform.debug(util.format(this.name + ": " + message, ...parameters)); },
      error: (message: string, ...parameters: unknown[]): void => { this.platform.log.error(util.format(this.name + ": " + message, ...parameters)); },
      info: (message: string, ...parameters: unknown[]): void => { this.platform.log.info(util.format(this.name + ": " + message, ...parameters)); },
      warn: (message: string, ...parameters: unknown[]): void => { this.platform.log.warn(util.format(this.name + ": " + message, ...parameters)); }
    };

    // Initialize our UniFi Protect event handler.
    this.events = new ProtectEvents(this);

    // Validate our Protect address and login information.
    if(!nvrOptions.address || !nvrOptions.username || !nvrOptions.password) {

      return;
    }

    // Cleanly shut down on Homebridge exit.
    this.api.on(APIEvent.SHUTDOWN, () => {

      // Clear the scheduled reboot timer if it's running.
      if(this.nvrRebootTimer) {

        clearTimeout(this.nvrRebootTimer);
        this.nvrRebootTimer = null;
      }

      // Disconnect from the controller. This tears down active HomeKit streams, HKSV timeshift buffers, the bootstrap refresh timer, and the API connection.
      this.disconnect();
    });
  }

  // Retrieve the bootstrap configuration from the Protect controller.
  private async bootstrapNvr(): Promise<boolean> {

    // Attempt to bootstrap the controller until we're successful.
    await retry(async () => this.ufpApi.getBootstrap(), PROTECT_CONTROLLER_RETRY_INTERVAL * 1000);

    return !!this.ufpApi.bootstrap;
  }

  // Establish a connection to the Protect controller. This method is safe to call multiple times — it handles authentication, bootstrap retrieval, and basic validation
  // without creating any one-time infrastructure (playlist servers, MQTT, etc.).
  private async connect(): Promise<boolean> {

    // Attempt to login to the Protect controller, retrying at reasonable intervals. This accounts for cases where the Protect controller or the network connection may
    // not be fully available when we startup.
    await retry(async () => this.ufpApi.login(this.config.address, this.config.username, this.config.password), PROTECT_CONTROLLER_RETRY_INTERVAL * 1000);

    // Now, let's get the bootstrap configuration from the Protect controller.
    for(let count = 0; !this.ufpApi.bootstrap && (count < 5); count++) {

      // eslint-disable-next-line no-await-in-loop
      await this.bootstrapNvr();
    }

    // Failsafe against an unresponsive controller.
    if(!this.ufpApi.bootstrap) {

      this.log.error("Unable to connect to the Protect controller. This may be due to the controller rebooting or becoming unavailable.");

      return false;
    }

    // Save the bootstrap to ease our device initialization below.
    const bootstrap = this.ufpApi.bootstrap;

    // Set our NVR configuration from the controller.
    this.ufp = bootstrap.nvr;

    // Assign our name if the user hasn't explicitly specified a preference.
    this.name = this.config.name ?? this.ufpApi.name;

    // If we are running an unsupported version of UniFi Protect, we're done.
    if(![ "6.", "7." ].some(v => this.ufp.version.startsWith(v))) {

      this.log.error("This version of HBUP requires running UniFi Protect v6.0 or above using the official Protect release channel only.");
      this.ufpApi.logout();

      return false;
    }

    // We successfully connected.
    this.log.info("Connected to %s (UniFi Protect %s running on UniFi OS %s).", this.config.address, this.ufp.version, this.ufp.firmwareVersion);

    return true;
  }

  // Cleanly disconnect from the Protect controller. This tears down all connection-dependent resources — active HomeKit streams, HKSV timeshift buffers, the bootstrap
  // refresh cycle, and the API connection — while preserving one-time infrastructure (playlist servers, MQTT, event listeners) and registered ProtectApi event listeners.
  private disconnect(): void {

    // Tear down all connection-dependent camera resources. Active HomeKit streaming sessions and HKSV timeshift buffers both depend on the controller connection.
    // Shutting them down proactively prevents error noise from livestream self-healing and FFmpeg processes communicating with a disconnected controller.
    for(const protectCamera of this.devices("camera")) {

      protectCamera.stream?.shutdown();
      protectCamera.stream?.hksv?.timeshift.stop();
      protectCamera.packageCamera?.stream?.shutdown();
      protectCamera.packageCamera?.stream?.hksv?.timeshift.stop();
    }

    // Clear the bootstrap refresh timer if it's running.
    if(this.bootstrapRefreshTimer) {

      clearTimeout(this.bootstrapRefreshTimer);
      this.bootstrapRefreshTimer = null;
    }

    // Disconnect from the Protect controller.
    this.ufpApi.reset();
  }

  // Initialize our connection to the UniFi Protect controller. This is the one-time entry point called at startup that establishes the connection, creates all
  // infrastructure, and starts the bootstrap refresh cycle.
  public async login(): Promise<void> {

    // The plugin has been disabled globally. Let the user know that we're done here.
    if(!this.hasFeature("Device")) {

      this.log.info("Disabling this UniFi Protect controller.");

      return;
    }

    // Establish our connection to the Protect controller.
    if(!(await this.connect())) {

      return;
    }

    // Now that we know the NVR configuration, check to see if this Protect controller is disabled.
    if(!this.hasFeature("Device")) {

      this.ufpApi.logout();
      this.log.info("Disabling this UniFi Protect controller in HomeKit.");

      // Let's sleep for thirty seconds to give all the accessories a chance to load before disabling everything. Homebridge doesn't have a good mechanism to notify us
      // when all the cached accessories are loaded at startup.
      await sleep(30);

      // Unregister all the accessories for this controller from Homebridge that may have been restored already. Any additional ones will be automatically caught when
      // they are restored.
      for(const accessory of this.platform.accessories.filter(x => x.context.nvr === this.ufp.mac)) {

        this.removeHomeKitDevice(accessory, true);
      }

      return;
    }

    // Configure any NVR-specific settings.
    this.configureNvr();

    // Initialize our liveviews.
    this.liveviews = new ProtectLiveviews(this);

    // Initialize our NVR system information.
    this.systemInfo = new ProtectNvrSystemInfo(this);

    // Initialize MQTT, if needed.
    if(!this.mqtt && this.config.mqttUrl) {

      this.mqtt = new MqttClient(this.config.mqttUrl, this.config.mqttTopic, this.log);
    }

    // Initialize our playlist service, if enabled.
    if(this.hasFeature("Nvr.Service.Playlist")) {

      this.servePlaylist();
    }

    // Inform the user about the devices we see.
    const bootstrap = this.ufpApi.bootstrap;

    if(!bootstrap) {

      return;
    }

    for(const device of [ this.ufp, ...bootstrap.cameras, ...bootstrap.chimes, ...bootstrap.lights, ...bootstrap.sensors, ...bootstrap.viewers ]) {

      // Filter out any devices that aren't adopted by this Protect controller.
      if((device.modelKey !== "nvr") &&
        ((device as ProtectDeviceConfigTypes).isAdoptedByOther || (device as ProtectDeviceConfigTypes).isAdopting || !(device as ProtectDeviceConfigTypes).isAdopted)) {

        continue;
      }

      this.log.info("Discovered %s: %s.", device.modelKey, this.ufpApi.getDeviceName(device, device.name ?? device.marketName, true));
    }

    // Initialize our Protect controller device sync.
    this.syncDevices();

    // Set a listener to wait for bootstrap events to occur so we can keep ourselves in sync with the Protect controller. This listener is registered once and persists
    // across disconnect/connect cycles since ProtectApi does not remove event listeners on reset.
    this.ufpApi.on("bootstrap", () => {

      // Sync our device view.
      this.syncDevices();

      // Clear any existing bootstrap refresh timer before scheduling the next one.
      if(this.bootstrapRefreshTimer) {

        clearTimeout(this.bootstrapRefreshTimer);
      }

      // Schedule the next bootstrap refresh.
      this.bootstrapRefreshTimer = setTimeout(() => void this.bootstrapNvr(), PROTECT_CONTROLLER_REFRESH_INTERVAL * 1000);
    });

    // Kickoff our first round of bootstrap refreshes to ensure we stay in sync.
    this.bootstrapRefreshTimer = setTimeout(() => void this.bootstrapNvr(), PROTECT_CONTROLLER_REFRESH_INTERVAL * 1000);
  }

  // Configure NVR-specific settings.
  private configureNvr(): boolean {

    // Configure scheduled reboots if enabled.
    this.configureScheduledReboot();

    return true;
  }

  // Configure scheduled reboots of the Protect controller.
  private configureScheduledReboot(): void {

    // Retrieve the reboot interval. A null return means the option is explicitly disabled.
    const rebootInterval = this.getFeatureFloat("Nvr.Reboot");

    if(rebootInterval === null) {

      return;
    }

    // Apply the reboot interval, defaulting to the configured default if the option is enabled without an explicit value. We enforce a minimum interval to prevent the
    // controller from entering a reboot loop.
    const intervalHours = Math.max(rebootInterval ?? PROTECT_NVR_REBOOT_INTERVAL, PROTECT_NVR_REBOOT_MIN_INTERVAL);

    this.log.info("Scheduled controller reboot enabled every %s hour%s.", intervalHours, (intervalHours === 1) ? "" : "s");

    // Schedule the reboot.
    this.nvrRebootTimer = setTimeout(() => void this.executeScheduledReboot(intervalHours), intervalHours * 60 * 60 * 1000);
  }

  // Execute a scheduled reboot of the Protect controller.
  private async executeScheduledReboot(intervalHours: number): Promise<void> {

    // Check if any cameras are actively recording HKSV events. If so, defer the reboot and check again in 60 seconds.
    const activeRecordings = this.devices("camera").filter(camera => camera.stream?.hksv?.isTransmitting);

    if(activeRecordings.length > 0) {

      this.log.info("Deferring scheduled controller reboot: %s camera%s actively recording HKSV events.", activeRecordings.length,
        (activeRecordings.length === 1) ? " is" : "s are");

      this.nvrRebootTimer = setTimeout(() => void this.executeScheduledReboot(intervalHours), 60 * 1000);

      return;
    }

    // Suppress API error logging and send the reboot command while we still have a valid authenticated session.
    this.logApiErrors = false;

    try {

      await this.ufpApi.retrieve("https://" + (this.config.overrideAddress ?? this.config.address) + "/api/system/reboot", { method: "POST" });
    } catch(error) {

      // The reboot command failed. Restore error logging and schedule the next attempt — there's no reboot in progress, so we don't need to disconnect or wait.
      this.logApiErrors = true;
      this.log.error("Unable to send reboot command to the Protect controller: %s.", error);

      this.nvrRebootTimer = setTimeout(() => void this.executeScheduledReboot(intervalHours), intervalHours * 60 * 60 * 1000);

      return;
    }

    this.log.info("Executing scheduled reboot of the Protect controller. Will resume connectivity in %s minutes.",
      parseFloat((PROTECT_NVR_REBOOT_RECONNECT_DELAY / 60).toFixed(1)));

    // Cleanly disconnect from the controller. This tears down active HomeKit streams, HKSV timeshift buffers, the bootstrap refresh timer, and the API connection,
    // preventing error noise during the reboot.
    this.disconnect();

    // Wait for the controller to reboot and come back online, then restore API error logging.
    await sleep(PROTECT_NVR_REBOOT_RECONNECT_DELAY * 1000);

    this.logApiErrors = true;

    // Reconnect to the controller. We attempt up to 5 times, since each connect() call already retries login indefinitely and makes up to 5 bootstrap attempts
    // internally. If we still can't reconnect after 5 attempts, something more fundamental is wrong and we fall through to the next scheduled reboot cycle as a natural
    // recovery opportunity.
    let reconnected = false;

    for(let attempt = 0; attempt < 5; attempt++) {

      // eslint-disable-next-line no-await-in-loop
      if(await this.connect()) {

        reconnected = true;

        break;
      }

      this.log.error("Reconnection attempt %s of 5 failed. Retrying.", attempt + 1);
    }

    if(!reconnected) {

      this.log.error("Unable to reconnect to the Protect controller after the scheduled reboot. Will attempt to reconnect on the next reboot cycle.");
    }

    // Schedule the next reboot. If we failed to reconnect, the next cycle will attempt to connect again before issuing the reboot command.
    this.nvrRebootTimer = setTimeout(() => void this.executeScheduledReboot(intervalHours), intervalHours * 60 * 60 * 1000);
  }

  // Sync the Protect controller's devices with HomeKit.
  private syncDevices(): void {

    // Sync status and check for any new or removed accessories.
    this.discoverAndSyncAccessories();

    // Refresh the accessory cache.
    this.api.updatePlatformAccessories(this.platform.accessories);
  }

  // Reconfigure a camera as a doorbell. Cameras and doorbells share the same modelKey in Protect...the only differentiator is featureFlags.isDoorbell, which may not be
  // populated when the device is first adopted. We tear down the ProtectCamera instance and replace it with a ProtectDoorbell against the same HomeKit accessory.
  public reconfigureAsDoorbell(protectDevice: ProtectDevice): void {

    // Tear down the existing device instance...listeners, timers, HKSV, and livestream resources.
    protectDevice.cleanup();

    // Remove the old instance from our configured devices and recreate it with the correct class.
    this.configuredDevices.delete(protectDevice.accessory.UUID);
    this.addProtectDevice(protectDevice.accessory, protectDevice.ufp);
  }

  // Create instances of Protect device types in our plugin.
  private addProtectDevice(accessory: PlatformAccessory, device: ProtectDeviceConfigTypes): Nullable<ProtectDevice> {

    const deviceName = device.name ?? device.marketName;

    switch(device.modelKey) {

      case "camera":

        // We have a UniFi Protect camera or doorbell.
        if(device.featureFlags.isDoorbell) {

          this.configuredDevices.set(accessory.UUID, new ProtectDoorbell(this, device, accessory));
        } else {

          this.configuredDevices.set(accessory.UUID, new ProtectCamera(this, device, accessory));
        }

        break;

      case "chime":

        // We have a UniFi Protect chime.
        this.configuredDevices.set(accessory.UUID, new ProtectChime(this, device, accessory));

        break;

      case "light":

        // We have a UniFi Protect light.
        this.configuredDevices.set(accessory.UUID, new ProtectLight(this, device, accessory));

        break;

      case "sensor":

        // We have a UniFi Protect sensor.
        this.configuredDevices.set(accessory.UUID, new ProtectSensor(this, device, accessory));

        break;

      case "viewer":

        // We have a UniFi Protect viewer.
        this.configuredDevices.set(accessory.UUID, new ProtectViewer(this, device, accessory));

        break;

      default:

        // Ensure we handle every device type the Protect API can send us. If a new device category is added upstream, this will flag it at compile time rather
        // than silently ignoring it at runtime.
        exhaustiveGuard(device);
        this.log.error("Unknown device class detected for %s.", deviceName);

        return null;
    }

    // Return our newly created device.
    return this.configuredDevices.get(accessory.UUID) ?? null;
  }

  // Add a newly detected Protect device to HomeKit.
  public addHomeKitDevice(device: ProtectDeviceConfigTypes): boolean {

    // If we have no MAC address, name, or this camera isn't being managed by this Protect controller, we're done.
    if(!this.ufp.mac || !device.mac || device.isAdoptedByOther || !device.isAdopted) {

      return false;
    }

    // We only support certain devices.
    if(!ProtectDeviceCategories.includes(device.modelKey)) {

      // If we've already informed the user about this one, we're done.
      if(this.unsupportedDevices[device.mac]) {

        return false;
      }

      // Notify the user we see this device, but we aren't adding it to HomeKit.
      this.unsupportedDevices[device.mac] = true;

      this.log.info("UniFi Protect device type %s is not currently supported, ignoring: %s.", device.modelKey, this.ufpApi.getDeviceName(device));

      return false;
    }

    // Generate this device's unique identifier.
    const uuid = this.hap.uuid.generate(device.mac);

    // See if we already know about this accessory.
    let accessory = this.platform.accessories.find(x => x.UUID === uuid);

    // Enable or disable certain devices based on configuration parameters.
    if(!this.hasFeature("Device", device)) {

      if(accessory) {

        this.removeHomeKitDevice(accessory, true);
      }

      return false;
    }

    // We've got a new device, let's add it to HomeKit.
    if(!accessory) {

      accessory = new this.api.platformAccessory(sanitizeName(device.name ?? device.marketName), uuid);

      this.log.info("%s: Adding %s to HomeKit%s.", this.ufpApi.getDeviceName(device), device.modelKey,
        this.hasFeature("Device.Standalone", device) ? " as a standalone device" : "");

      // Register this accessory with homebridge and add it to the accessory array so we can track it.
      if(this.hasFeature("Device.Standalone", device)) {

        this.api.publishExternalAccessories(PLUGIN_NAME, [accessory]);
      } else {

        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }

      this.platform.accessories.push(accessory);
      this.api.updatePlatformAccessories(this.platform.accessories);
    }

    // Setup the accessory as a new Protect device in HBUP if we haven't configured it yet.
    if(!this.configuredDevices.has(accessory.UUID)) {

      this.addProtectDevice(accessory, device);

      return true;
    }

    // Update the configuration on an existing Protect device.
    this.events.emit("updateEvent", { header: { action: "update", hbupBootstrap: true, id: device.id, modelKey: device.modelKey }, payload: device });

    return true;
  }

  // Discover and sync UniFi Protect devices between HomeKit and the Protect controller.
  private discoverAndSyncAccessories(): boolean {

    // If the Protect controller's not bootstrapped, or it's experiencing a meltdown, we're done.
    if(!this.ufpApi.bootstrap || this.ufpApi.isThrottled) {

      // Clear out the device removal queue since we can't trust the Protect controller at the moment.
      if(this.deviceRemovalQueue.size) {

        this.log.info("Communication with the controller has been lost. Clearing out the device removal queue as a precaution until connectivity returns.");
        this.deviceRemovalQueue.clear();
      }

      return false;
    }

    // Iterate through the list of device categories we know about and add them to HomeKit.
    for(const category of ProtectDeviceCategories) {

      for(const device of ((this.ufpApi.bootstrap[category + "s"] as ProtectDeviceConfigTypes[] | undefined) ?? [])) {

        this.addHomeKitDevice(device);
      }
    }

    // Remove Protect devices that are no longer found on this Protect NVR, but we still have in HomeKit.
    this.cleanupDevices();

    // Configure our chime accessories.
    for(const chime of this.devices("chime")) {

      chime.updateDevice();
    }

    // Configure our liveview-based accessories.
    this.liveviews?.configureLiveviews();

    // Update our viewer accessories.
    for(const viewer of this.devices("viewer")) {

      viewer.updateDevice();
    }

    // Update our device information.
    for(const device of this.devicelist) {

      device.configureInfo();
    }

    return true;
  }

  // Cleanup removed Protect devices from HomeKit.
  private cleanupDevices(): void {

    // Process the device removal queue before we do anything else.
    for(const accessory of this.platform.accessories.filter(x => this.deviceRemovalQueue.has(x.UUID))) {

      this.removeHomeKitDevice(accessory, !this.platform.featureOptions.test("Device",
        ((accessory.getService(this.hap.Service.AccessoryInformation)?.getCharacteristic(this.hap.Characteristic.SerialNumber).value) ?? "") as string, this.ufp.mac));
    }

    // Cleanup our accessories.
    for(const accessory of this.platform.accessories.filter(x => x.context.nvr === this.ufp.mac)) {

      const protectDevice = this.configuredDevices.get(accessory.UUID);

      // Check to see if we have an orphan - where we haven't configured this in the plugin, but the accessory still exists in HomeKit. One example of when this might
      // happen is when Homebridge might be shutdown and a camera is then removed. When we start back up, the camera still exists in HomeKit but not in Protect. We
      // catch those orphan devices here.
      if(!protectDevice) {

        this.removeHomeKitDevice(accessory, !this.platform.featureOptions.test("Device",
          ((accessory.getService(this.hap.Service.AccessoryInformation)?.getCharacteristic(this.hap.Characteristic.SerialNumber).value) ?? "") as string));

        continue;
      }

      // If we don't have the Protect bootstrap JSON available, we're done. We need to know what's on the Protect controller in order to determine what to do with the
      // accessories we know about.
      if(!this.ufpApi.bootstrap) {

        continue;
      }

      // Check to see if the device still exists on the Protect controller, is properly adopted, and the user has not chosen to hide it, or the user has chosen to make
      // this a standalone accessory rather than a bridged one.
      if((this.ufpApi.bootstrap[protectDevice.ufp.modelKey + "s"] as ProtectDeviceConfigTypes[] | undefined)
        ?.some(x => (x.mac === protectDevice.ufp.mac) && x.isAdopted && !x.isAdoptedByOther) &&
        protectDevice.hints.enabled && ((accessory._associatedHAPAccessory.bridged && !protectDevice.hints.standalone) ||
         (!accessory._associatedHAPAccessory.bridged && protectDevice.hints.standalone))) {

        // In case we have previously queued a device for deletion, let's remove it from the queue since it's reappeared.
        this.deviceRemovalQueue.delete(protectDevice.accessory.UUID);

        continue;
      }

      // Remove and then add the device back to HomeKit if we're really just transitioning between bridged and standalone devices.
      if(protectDevice.hints.enabled && ((!accessory._associatedHAPAccessory.bridged && !protectDevice.hints.standalone) ||
        (accessory._associatedHAPAccessory.bridged && protectDevice.hints.standalone))) {

        this.removeHomeKitDevice(accessory, true);
        this.addHomeKitDevice(protectDevice.ufp);

        continue;
      }

      // Process the device removal.
      this.removeHomeKitDevice(accessory, !this.hasFeature("Device", protectDevice.ufp));
    }
  }

  // Remove an individual Protect accessory from HomeKit.
  public removeHomeKitDevice(accessory: PlatformAccessory, noRemovalDelay = false): void {

    // Ensure that this accessory hasn't already been removed.
    if(!this.platform.accessories.some(x => x.UUID === accessory.UUID)) {

      return;
    }

    // We only remove devices if they're on the Protect controller we're interested in.
    if(accessory.context.nvr !== this.ufp.mac) {

      return;
    }

    // The NVR system information accessory is handled elsewhere.
    if(accessory.context.systemInfo) {

      return;
    }

    // Liveview-centric accessories are handled elsewhere.
    if(accessory.context.liveview || accessory.getService(this.hap.Service.SecuritySystem)) {

      return;
    }

    // We only store MAC addresses on devices that exist on the Protect controller. Any other accessories created are ones we created ourselves and are managed
    // elsewhere, with one exception - package cameras. If we have a matching parent camera for the package camera, we're done here. Package cameras are dealt with
    // when we remove the parent camera. If the parent doesn't exist, this is an orphan that we need to remove.
    if(!accessory.context.mac &&
      (!accessory.context.packageCamera || (this.platform.accessories.some(x => x.context.mac === accessory.context.packageCamera)))) {

      return;
    }

    const delayInterval = this.getFeatureNumber("Nvr.DelayDeviceRemoval") ?? 0;

    // For certain use cases, we may want to defer removal of a Protect device where Protect may lose track of devices for a brief period of time. This prevents a
    // potential back-and-forth where devices are removed momentarily only to be readded later.
    if(!noRemovalDelay && delayInterval) {

      // Have we seen this device queued for removal previously? If not, let's add it to the queue and come back after our specified delay.
      if(!this.deviceRemovalQueue.has(accessory.UUID)) {

        this.deviceRemovalQueue.set(accessory.UUID, Date.now());

        this.log.info("%s: Delaying device removal for at least %s second%s.", accessory.displayName, delayInterval, delayInterval > 1 ? "s" : "");

        return;
      }

      // Is it time to process this device removal?
      const removalTimestamp = this.deviceRemovalQueue.get(accessory.UUID) ?? 0;

      if((delayInterval * 1000) > (Date.now() - removalTimestamp)) {

        return;
      }
    }

    // Cleanup after ourselves.
    this.deviceRemovalQueue.delete(accessory.UUID);

    // Grab our instance of the Protect device, if it exists.
    const protectDevice = this.configuredDevices.get(accessory.UUID);

    // See if we can pull the device's configuration details from our Protect device instance or the controller.
    const device = protectDevice?.ufp ??
      ProtectDeviceCategories.flatMap<ProtectDeviceConfigTypes>(category => (this.ufpApi.bootstrap?.[category + "s"] as ProtectDeviceConfigTypes[] | undefined) ?? [])
        .find(d => d.mac === accessory.context.mac);

    this.log.info("%s: Removing %s from HomeKit.%s",
      device ? this.ufpApi.getDeviceName(device) : protectDevice?.accessoryName ?? accessory.displayName,
      device?.modelKey ?? "device",
      accessory._associatedHAPAccessory.bridged ? "" : " You will need to manually delete the device in the Home app to complete the removal.");

    const deletingAccessories = [accessory];

    // If it's an unknown device or a camera, look for a corresponding package camera if we have one and remove it as well.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if(!device || (device?.modelKey === "camera")) {

      const packageCameraAccessory = this.platform.accessories.find(x => x.context.packageCamera === accessory.context.mac);

      // Remove the package camera, if it exists, and cleanup the device if it's been confgured.
      if(packageCameraAccessory) {

        deletingAccessories.push(packageCameraAccessory);
      }
    }

    // Cleanup our device instance.
    protectDevice?.cleanup();

    // Finally, remove it from our list of configured devices and HomeKit.
    this.configuredDevices.delete(accessory.UUID);

    // Update our internal list of all the accessories we know about.
    for(const targetAccessory of deletingAccessories) {

      // Unregister the accessory from HomeKit if we have a bridged accessory. Unbridged accessories are managed directly by users in the Home app.
      if(targetAccessory._associatedHAPAccessory.bridged) {

        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [targetAccessory]);
      }

      this.platform.accessories.splice(this.platform.accessories.indexOf(targetAccessory), 1);
    }

    // Tell Homebridge to save the updated list of accessories.
    this.api.updatePlatformAccessories(this.platform.accessories);
  }

  // Create a web service to publish an M3U playlist of Protect camera livestreams.
  private servePlaylist(): void {

    const port = this.getFeatureNumber("Nvr.Service.Playlist") ?? PROTECT_M3U_PLAYLIST_PORT;
    const server = http.createServer();

    // Respond to requests for a Protect camera playlist.
    server.on("request", (_request, response) => {

      // Set the right MIME type for M3U playlists.
      response.writeHead(200, { "Content-Type": "application/x-mpegURL" });

      // Output the M3U header.
      response.write("#EXTM3U\n");

      // Make sure we have access to the Protect API bootstrap before we begin.
      if(this.ufpApi.bootstrap) {

        // Find the RTSP aliases and publish them. We filter out any cameras that don't have RTSP aliases since they would be inaccessible in this context.
        for(const camera of this.ufpApi.bootstrap.cameras.filter(x => (x.videoCodec !== "av1") && x.channels.some(channel => channel.isRtspEnabled)).sort((a, b) => {

          if(!a.name || !b.name) {

            return 0;
          }

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

            publishEntry((camera.name ?? "") + " " + packageChannel.name, "package camera", packageChannel.rtspAlias);
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

  // Return all configured devices.
  private get devicelist(): ProtectDevices[] {

    return [...this.configuredDevices.values()];
  }

  // Return all devices of a particular modelKey.
  private devices<T extends keyof ProtectDeviceTypes>(model?: T): ProtectDeviceTypes[T][] {

    return [...this.configuredDevices.values()].filter(device => device.ufp.modelKey === model) as ProtectDeviceTypes[T][];
  }

  // Return the Protect device object based on it's unique device identifier, if it exists.
  public getDeviceById(deviceId: string): Nullable<ProtectDevices> {

    // Find the device.
    return [...this.configuredDevices.values()].find(device => device.ufp.id === deviceId) ?? null;
  }

  // Utility function to return a floating point configuration parameter on a device.
  public getFeatureFloat(option: string): Nullable<number | undefined> {

    return this.platform.featureOptions.getFloat(option, this.ufp.mac);
  }

  // Utility function to return an integer configuration parameter on a device.
  public getFeatureNumber(option: string): Nullable<number | undefined> {

    return this.platform.featureOptions.getInteger(option, this.ufp.mac);
  }

  // Utility for checking the scope of feature options on the NVR.
  public isNvrFeature(option: string, device?: ProtectDeviceConfigTypes | ProtectNvrConfig): boolean {

    return [ "global", "controller" ].includes(this.platform.featureOptions.scope(option, device?.mac, this.ufp.mac));
  }

  // Utility for checking feature options on the NVR.
  public hasFeature(option: string, device?: ProtectDeviceConfigTypes | ProtectNvrConfig): boolean {

    return this.platform.featureOptions.test(option, device?.mac, this.ufp.mac);
  }

  // Utility for logging feature option availability on the NVR.
  public logFeature(option: string, message: string): void {

    option = option.toLowerCase();

    // Only log something if we haven't already informed the user about it previously and it's scoped to the NVR or globally.
    if(this.featureLog[option] || !this.isNvrFeature(option)) {

      return;
    }

    this.featureLog[option] = true;

    this.log.info(message);
  }
}
