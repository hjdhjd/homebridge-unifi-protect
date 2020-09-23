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
import { PROTECT_SWITCH_TRIGGER, ProtectCamera } from "./protect-camera";
import {
  ProtectCameraConfig,
  ProtectCameraConfigPayload,
  ProtectNvrOptions,
  ProtectNvrSystemEvent
} from "./protect-types";
import { ProtectApi } from "./protect-api";
import { ProtectDoorbell } from "./protect-doorbell";
import { ProtectLiveviews } from "./protect-liveviews";
import { ProtectMqtt } from "./protect-mqtt";
import { ProtectPlatform } from "./protect-platform";
import { ProtectUpdatesApi } from "./protect-updates-api";

export class ProtectNvr {
  private api: API;
  public config: ProtectNvrOptions;
  private readonly configuredCameras: { [index: string]: ProtectCamera | ProtectDoorbell };
  private debug: (message: string, ...parameters: unknown[]) => void;
  public doorbellCount: number;
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
  private refreshInterval: number;
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
      if(!camera.mac || !camera.name || !camera.isManaged) {
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
      return false;
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

    // For non-UniFi OS controllers, poll for doorbell and motion events.
    this.checkProtectEvents();

    // Configure our updates API listener, if needed.
    this.configureUpdatesListener();

    // Sync status and check for any new or removed accessories.
    this.discoverAndSyncAccessories();

    // Refresh the accessory cache.
    this.api.updatePlatformAccessories(this.platform.accessories);

    return true;
  }

  // Check for doorbell and motion events for non-UniFi OS controllers.
  private checkProtectEvents(): boolean {

    // Ensure we're not a UniFi OS controller and that we're up and running.
    if(this.nvrApi.isUnifiOs || !this.nvrApi.Cameras) {
      return false;
    }

    // Iterate through the list of cameras, looking for the isMotionDetected event on each camera
    // in order to determine where there is motion.
    for(const camera of this.nvrApi.Cameras) {

      // We only want cameras that are managed.
      if(!camera.isManaged) {
        continue;
      }

      // Find the accessory associated with this camera.
      const uuid = this.hap.uuid.generate(camera.mac);
      const accessory = this.platform.accessories.find(x => x.UUID === uuid);

      // If we don't have an accessory, it's probably because we've chosen to hide it. In that case,
      // just ignore and move on.
      if(!accessory) {
        continue;
      }

      // Handle motion events.
      void this.motionEventHandler(accessory, camera.lastMotion);

      // Handle doorbell events.
      void this.doorbellEventHandler(accessory, camera.lastRing);
    }

    return true;
  }

  // Configure the realtime system event API listener to trigger events on accessories, like motion.
  // This is now deprecated in favor of the realtime updates event API, which provides for more event types
  // than the realtime system events API.
  private configureSystemEventListener(): boolean {

    // The event listener API only works on UniFi OS devices.
    if(!this.nvrApi.isUnifiOs) {
      return false;
    }

    // Only configure the event listener if it exists and it's not already configured.
    if(!this.nvrApi.eventListener || this.nvrApi.eventListenerConfigured) {
      return true;
    }

    // Listen for any messages coming in from our listener.
    this.nvrApi.eventListener.on("message", (event: string) => {

      let nvrEvent;

      try {

        nvrEvent = JSON.parse(event) as ProtectNvrSystemEvent;

      } catch(error) {

        if(error instanceof SyntaxError) {
          this.log.error("%s: Unable to process message from the realtime system events API: \"%s\". Error: %s.", this.nvrApi.getNvrName(), event, error.message);
        } else {
          this.log.error("%s: Unknown error has occurred: %s.", this.nvrApi.getNvrName(), error);
        }

        // Errors mean that we're done now.
        return;

      }

      // We're interested in device state change events.
      if(nvrEvent?.type !== "DEVICE_STATE_CHANGED") {
        return;
      }

      // We only want Protect controllers.
      const controller = nvrEvent.apps?.controllers?.find(x => x.name === "protect");

      if(!controller) {
        return;
      }

      // Find the camera in our list of accessories so we can fire off the motion event.
      const foundCamera = Object.keys(this.configuredCameras).find(x =>
        (this.configuredCameras[x].accessory.context.camera as ProtectCameraConfig).host === controller.info.lastMotionCameraAddress);

      // Nothing here - we may have disabled this camera or it's associated NVR.
      if(!foundCamera) {
        return;
      }

      // Now grab the accessory associated with the Protect device.
      const accessory = this.configuredCameras[foundCamera].accessory;

      // If we don't have an accessory, it's probably because we've chosen to hide it. In that case,
      // just ignore and move on. Alternatively, it could be a new camera that we just don't know about yet,
      // In either case, we keep ignore it.
      if(!accessory) {
        return;
      }

      // The UniFi OS system events realtime API returns lastMotion in seconds rather than milliseconds.
      this.motionEventHandler(accessory, controller.info.lastMotion * 1000);
    });

    // Mark the listener as configured.
    this.nvrApi.eventListenerConfigured = true;
    return true;
  }

  // Configure the realtime update events API listener to trigger events on accessories, like motion.
  private configureUpdatesListener(): boolean {

    // The event listener API only works on UniFi OS devices.
    if(!this.nvrApi.isUnifiOs) {
      return false;
    }

    // Only configure the event listener if it exists and it's not already configured.
    if(!this.nvrApi.eventListener || this.nvrApi.eventListenerConfigured) {
      return true;
    }

    // Listen for any messages coming in from our listener.
    this.nvrApi.eventListener.on("message", (event: Buffer) => {

      const updatePacket = ProtectUpdatesApi.decodeUpdatePacket(this.log, event);

      if(!updatePacket) {
        this.log.error("%s: Unable to process message from the realtime update events API.", this.nvrApi.getNvrName());
        return;
      }

      // Update actions that we care about (doorbell rings, motion detection) look like this:
      //
      // action: "update"
      // id: "someCameraId"
      // modelKey: "camera"
      // newUpdateId: "ignorethis"
      //
      // The payloads are what differentiate them - one updates lastMotion and the other lastRing.

      // Filter on what actions we're interested in only.
      if((updatePacket.action.action !== "update") || (updatePacket.action.modelKey !== "camera")) {
        return;
      }

      // Grab the payload - it should be a subset of the camera configuration JSON.
      const payload = updatePacket.payload as ProtectCameraConfigPayload;

      // Now filter out payloads we aren't interested in. We only want motion detection and doorbell rings for now.
      if(!payload.isMotionDetected && !payload.lastRing) {
        return;
      }

      // Lookup the accessory associated with this camera.
      const accessory = this.accessoryLookup(updatePacket.action.id);

      // We don't know about this camera - we're done.
      if(!accessory) {
        return;
      }

      // It's a motion event - process it accordingly.
      if(payload.isMotionDetected) {

        // Call our motion handler and we're done.
        if(payload.lastMotion) {
          this.motionEventHandler(accessory, payload.lastMotion);
        }

        return;
      }

      // It's a ring event - process it accordingly.
      if(payload.lastRing) {

        // Call our doorbell handler and we're done.
        this.doorbellEventHandler(accessory, payload.lastRing);
        return;
      }
    });

    // Mark the listener as configured.
    this.nvrApi.eventListenerConfigured = true;
    return true;
  }

  // Motion event processing from UniFi Protect and delivered to HomeKit.
  public motionEventHandler(accessory: PlatformAccessory, lastMotion: number): void {
    const camera = accessory.context.camera as ProtectCameraConfig;
    const hap = this.hap;

    if(!accessory || !camera || !lastMotion) {
      return;
    }

    // Have we seen this event before? If so...move along.
    if(this.lastMotion[camera.mac] >= lastMotion) {
      this.debug("%s: Skipping duplicate motion event.", this.nvrApi.getFullName(camera));
      return;
    }

    // We only consider events that have happened within the last two refresh intervals. Otherwise, we assume
    // it's stale data and don't inform the user.
    if((Date.now() - lastMotion) > (this.refreshInterval * 2 * 1000)) {
      this.debug("%s: Skipping motion event due to stale data.", this.nvrApi.getFullName(camera));
      return;
    }

    // Remember this event.
    this.lastMotion[camera.mac] = lastMotion;

    // If we already have a motion event inflight, allow it to complete so we don't spam users.
    if(this.eventTimers[camera.mac]) {
      return;
    }

    // Only notify the user if we have a motion sensor and it's active.
    const motionService = accessory.getService(hap.Service.MotionSensor);

    if(!motionService) {
      return;
    }

    // If we have disabled motion events, we're done here.
    if(("detectMotion" in accessory.context) && !accessory.context.detectMotion) {
      return;
    }

    // Trigger the motion event in HomeKit.
    motionService.getCharacteristic(hap.Characteristic.MotionDetected).updateValue(true);

    // Check to see if we have a motion trigger switch configured. If we do, update it.
    const triggerService = accessory.getServiceById(hap.Service.Switch, PROTECT_SWITCH_TRIGGER);

    if(triggerService) {
      triggerService.getCharacteristic(hap.Characteristic.On).updateValue(true);
    }

    // Publish to MQTT, if the user has configured it.
    this.mqtt?.publish(accessory, "motion", "true");

    // Log the event, if configured to do so.
    if(this.optionEnabled(camera, "LogMotion", false)) {
      this.log.info("%s: Motion detected.", this.nvrApi.getFullName(camera));
    }

    // Reset our motion event after motionDuration.
    this.eventTimers[camera.mac] = setTimeout(() => {
      const thisMotionService = accessory.getService(hap.Service.MotionSensor);

      if(thisMotionService) {
        thisMotionService.getCharacteristic(hap.Characteristic.MotionDetected).updateValue(false);

        // Check to see if we have a motion trigger switch configured. If we do, update it.
        const triggerService = accessory.getServiceById(hap.Service.Switch, PROTECT_SWITCH_TRIGGER);

        if(triggerService) {
          triggerService.getCharacteristic(hap.Characteristic.On).updateValue(false);
        }

        // Publish to MQTT, if the user has configured it.
        this.mqtt?.publish(accessory, "motion", "false");

        this.debug("%s: Resetting motion event.", this.nvrApi.getFullName(camera));
      }

      // Delete the timer from our motion event tracker.
      delete this.eventTimers[camera.mac];
    }, this.motionDuration * 1000);
  }

  // Doorbell event processing from UniFi Protect and delivered to HomeKit.
  private doorbellEventHandler(accessory: PlatformAccessory, lastRing: number | null): void {
    const camera = accessory.context.camera as ProtectCameraConfig;
    const hap = this.hap;

    if(!accessory || !camera || !lastRing) {
      return;
    }

    // Have we seen this event before? If so...move along. It's unlikely we hit this in a doorbell scenario, but just in case.
    if(this.lastRing[camera.mac] >= lastRing) {
      this.debug("%s: Skipping duplicate doorbell ring.", this.nvrApi.getFullName(camera));
      return;
    }

    // We only consider events that have happened within the last two refresh intervals. Otherwise, we assume it's stale
    // data and don't inform the user.
    if((Date.now() - lastRing) > (this.refreshInterval * 2 * 1000)) {
      this.debug("%s: Skipping doorbell ring due to stale data.", this.nvrApi.getFullName(camera));
      return;
    }

    // Remember this event.
    this.lastRing[camera.mac] = lastRing;

    // Only notify the user if we have a doorbell.
    const doorbellService = accessory.getService(hap.Service.Doorbell);

    if(!doorbellService) {
      return;
    }

    // Trigger the doorbell.
    doorbellService
      .getCharacteristic(this.hap.Characteristic.ProgrammableSwitchEvent)
      .setValue(this.hap.Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS);

    // Trigger the doorbell ring contact sensor, if one is configured.
    const contactService = accessory.getService(hap.Service.ContactSensor);

    if(contactService) {

      // Kill any inflight contact reset.
      if(this.eventTimers[camera.mac + ".DoorbellRing"]) {
        clearTimeout(this.eventTimers[camera.mac + ".DoorbellRing"]);
        delete this.eventTimers[camera.mac + ".DoorbellRing"];
      }

      // Trigger the contact event in HomeKit.
      contactService.getCharacteristic(hap.Characteristic.ContactSensorState).updateValue(hap.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED);

      // Reset our contact event after two seconds.
      this.eventTimers[camera.mac + ".DoorbellRing"] = setTimeout(() => {
        const thisContactService = accessory.getService(hap.Service.ContactSensor);

        if(thisContactService) {
          contactService.getCharacteristic(hap.Characteristic.ContactSensorState).updateValue(hap.Characteristic.ContactSensorState.CONTACT_DETECTED);
          this.debug("%s: Resetting contact sensor event.", this.nvrApi.getFullName(camera));
        }

        // Delete the timer from our motion event tracker.
        delete this.eventTimers[camera.mac + ".DoorbellRing"];
      }, 2 * 1000);
    }

    // Publish to MQTT, if the user has configured it.
    this.mqtt?.publish(accessory, "doorbell", "true");

    if(this.optionEnabled(camera, "LogDoorbell", false)) {
      this.log.info("%s: Doorbell ring detected.", this.nvrApi.getFullName(camera));
    }
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
      await this.updateAccessories();

      // Our Protect NVR is disabled. We're done.
      if(!this.isEnabled) {
        return;
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
  private accessoryLookup(cameraId: string | undefined | null): PlatformAccessory | undefined {

    if(!cameraId) {
      return undefined;
    }

    // Find the camera in our list of accessories.
    const foundCamera = Object.keys(this.configuredCameras).find(x => (this.configuredCameras[x].accessory.context.camera as ProtectCameraConfig).id === cameraId);

    return foundCamera ? this.configuredCameras[foundCamera].accessory : undefined;
  }

  // Utility function to let us know if a device or feature should be enabled or not.
  public optionEnabled(device: ProtectCameraConfig | null, option = "", defaultReturnValue = true): boolean {

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

    let optionSetting;

    // If we've specified a device, check for device-specific options first. Otherwise, we're dealing
    // with an NVR-specific or global option.
    if(device?.mac) {

      // First we test for camera-level option settings.
      // No option specified means we're testing to see if this device should be shown in HomeKit.
      optionSetting = option ? (option + "." + device.mac).toUpperCase() : device.mac.toUpperCase();

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
    optionSetting = option ? (option + "." + this.nvrApi.bootstrap.nvr.mac).toUpperCase() : this.nvrApi.bootstrap.nvr.mac.toUpperCase();

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

    optionSetting = option.toUpperCase();

    // We've explicitly enabled this globally for all devices.
    if(configOptions.indexOf("ENABLE." + optionSetting) !== -1) {
      return true;
    }

    // We've explicitly disabled this globally for all devices.
    if(configOptions.indexOf("DISABLE." + optionSetting) !== -1) {
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
      optionSetting = (option + "." + device.mac + ".").toUpperCase();

      // We've explicitly enabled this option for this device.
      if((foundOption = configOptions.find(x => optionSetting === x.slice(0, optionSetting.length).toUpperCase())) !== undefined) {
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
    optionSetting = (option + "." + this.nvrApi.bootstrap.nvr.mac + ".").toUpperCase();

    // We've explicitly enabled this option for this NVR and all the devices attached to it.
    if((foundOption = configOptions.find(x => optionSetting === x.slice(0, optionSetting.length).toUpperCase())) !== undefined) {
      return foundOption.slice(optionSetting.length);
    }

    // We've explicitly disabled this option for this NVR and all the devices attached to it.
    if(configOptions.indexOf("DISABLE." + optionSetting) !== -1) {
      return undefined;
    }

    // Finally, let's see if we have a global option here.
    optionSetting = option.toUpperCase();

    // We've explicitly enabled this globally for all devices.
    if((foundOption = configOptions.find(x => optionSetting === x.slice(0, optionSetting.length).toUpperCase())) !== undefined) {
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
