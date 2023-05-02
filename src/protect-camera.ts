/* Copyright(C) 2019-2023, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-camera.ts: Camera device class for UniFi Protect.
 */
import { CharacteristicValue, PlatformAccessory } from "homebridge";
import { PLATFORM_NAME, PLUGIN_NAME, PROTECT_HOMEKIT_IDR_INTERVAL, PROTECT_SNAPSHOT_CACHE_REFRESH_INTERVAL } from "./settings.js";
import { ProtectCameraChannelConfig, ProtectCameraConfig, ProtectCameraConfigPayload, ProtectEventAdd, ProtectEventPacket } from "unifi-protect";
import { ProtectDevice } from "./protect-device.js";
import { ProtectNvr } from "./protect-nvr.js";
import { ProtectReservedNames } from "./protect-types.js";
import { ProtectStreamingDelegate } from "./protect-stream.js";

export interface RtspEntry {

  channel: ProtectCameraChannelConfig,
  name: string,
  resolution: [ number, number, number],
  url: string
}

export class ProtectCamera extends ProtectDevice {

  public hasHksv: boolean;
  public hasHwAccel: boolean;
  private isDeleted: boolean;
  private isDoorbellConfigured: boolean;
  public isRinging: boolean;
  private isVideoConfigured: boolean;
  public packageCamera: ProtectPackageCamera | null;
  private rtspEntries: RtspEntry[];
  private rtspQuality: { [index: string]: string };
  public snapshotUrl!: string;
  public stream!: ProtectStreamingDelegate;
  public ufp: ProtectCameraConfig;

  // Create an instance.
  constructor(nvr: ProtectNvr, device: ProtectCameraConfig, accessory: PlatformAccessory) {

    super(nvr, accessory);

    this.isDoorbellConfigured = false;
    this.hasHksv = false;
    this.hasHwAccel = false;
    this.isDeleted = false;
    this.isRinging = false;
    this.isVideoConfigured = false;
    this.packageCamera = null;
    this.rtspEntries = [];
    this.rtspQuality = {};
    this.ufp = device;

    this.configureHints();
    void this.configureDevice();
  }

  // Configure device-specific settings for this device.
  protected configureHints(): boolean {

    // Configure our parent's hints.
    super.configureHints();

    // Configure our device-class specific hints.
    this.hints.hardwareDecoding = this.hasFeature("Video.Decode.Hardware");
    this.hints.hardwareTranscoding = this.hasFeature("Video.Transcode.Hardware");
    this.hints.ledStatus = this.ufp.featureFlags.hasLedStatus && this.hasFeature("Device.StatusLed");
    this.hints.logDoorbell = this.hasFeature("Log.Doorbell");
    this.hints.logHksv = this.hasFeature("Log.HKSV");
    this.hints.probesize = 16384;
    this.hints.smartDetect = this.hasFeature("Motion.SmartDetect");
    this.hints.timeshift = this.hasFeature("Video.HKSV.TimeshiftBuffer");
    this.hints.transcode = this.hasFeature("Video.Transcode");
    this.hints.transcodeHighLatency = this.hasFeature("Video.Transcode.HighLatency");
    this.hints.twoWayAudio = this.ufp.hasSpeaker && this.hasFeature("Audio") && this.hasFeature("Audio.TwoWay");

    return true;
  }

  // Configure a camera accessory for HomeKit.
  protected async configureDevice(): Promise<boolean> {

    // Default to enabling motion detection.
    let detectMotion = true;

    // Save the motion detection switch state before we wipeout the context.
    if("detectMotion" in this.accessory.context) {

      detectMotion = this.accessory.context.detectMotion as boolean;
    }

    // Default to disabling the dynamic bitrate setting.
    let dynamicBitrate = false;

    // Save the dynamic bitrate switch state before we wipeout the context.
    if("dynamicBitrate" in this.accessory.context) {

      dynamicBitrate = this.accessory.context.dynamicBitrate as boolean;
    }

    // Default to enabling HKSV recording.
    let hksvRecording = true;

    // Save the HKSV recording switch state before we wipeout the context.
    if("hksvRecording" in this.accessory.context) {

      hksvRecording = this.accessory.context.hksvRecording as boolean;
    }

    // Clean out the context object in case it's been polluted somehow.
    this.accessory.context = {};
    this.accessory.context.detectMotion = detectMotion;
    this.accessory.context.dynamicBitrate = dynamicBitrate;
    this.accessory.context.hksvRecording = hksvRecording;
    this.accessory.context.mac = this.ufp.mac;
    this.accessory.context.nvr = this.nvr.ufp.mac;

    // Inform the user if we have enabled the dynamic bitrate setting.
    if(this.hasFeature("Video.DynamicBitrate")) {

      this.log.info("Dynamic streaming bitrate adjustment on the UniFi Protect controller enabled.");
    }

    // If the camera supports it, check to see if we have smart motion events enabled.
    if(this.ufp.featureFlags.hasSmartDetect && this.hints.smartDetect) {

      // We deal with smart motion detection options here and save them on the ProtectCamera instance because
      // we're trying to optimize and reduce the number of feature option lookups we do in realtime, when possible.
      // Reading a stream of constant events and having to perform a string comparison through a list of options multiple
      // times a second isn't an ideal use of CPU cycles, even if you have plenty of them to spare. Instead, we perform
      // that lookup once, here, and set the appropriate option booleans for faster lookup and use later in event
      // detection.

      // Inform the user of what smart detection object types we're configured for.
      this.log.info("Smart motion detection enabled%s.", this.ufp.featureFlags.smartDetectTypes.length ? ": " + this.ufp.featureFlags.smartDetectTypes.join(", ") : "");
    }

    // Configure accessory information.
    this.configureInfo();

    // Configure MQTT services.
    this.configureMqtt();

    // Configure the motion sensor.
    this.configureMotionSensor();

    // Configure smart motion contact sensors.
    this.configureMotionSmartSensor();

    // Configure HomeKit Secure Video suport.
    this.configureHksv();
    this.configureHksvRecordingSwitch();

    // Configure our video stream.
    await this.configureVideoStream();

    // Configure our snapshot updates.
    void this.configureSnapshotUpdates();

    // Configure our package camera.
    this.configurePackageCamera();

    // Configure our camera details.
    this.configureCameraDetails();

    // Configure our bitrate switch.
    this.configureDynamicBitrateSwitch();

    // Configure our NVR recording switches.
    this.configureNvrRecordingSwitch();

    // Configure the doorbell trigger.
    this.configureDoorbellTrigger();

    // Listen for events.
    this.nvr.events.on("updateEvent." + this.ufp.id, this.listeners["updateEvent." + this.ufp.id] = this.eventHandler.bind(this));

    if(this.ufp.featureFlags.hasSmartDetect && this.hints.smartDetect) {

      this.nvr.events.on("addEvent." + this.ufp.id, this.listeners["addEvent." + this.ufp.id] = this.smartMotionEventHandler.bind(this));
    }

    return true;
  }

  // Cleanup after ourselves if we're being deleted.
  public cleanup(): void {

    super.cleanup();

    this.isDeleted = true;
  }

  // Handle camera-related events.
  protected eventHandler(packet: ProtectEventPacket): void {

    const payload = packet.payload as ProtectCameraConfigPayload;

    // Update the package camera, if we have one.
    if(this.packageCamera) {

      this.packageCamera.ufp = Object.assign({}, this.ufp, { name: this.ufp.name + " Package Camera"}) as ProtectCameraConfig;
    }

    // Process any RTSP stream updates.
    if(payload.channels) {

      void this.configureVideoStream();
    }

    // Process motion events.
    if(payload.isMotionDetected && payload.lastMotion) {

      // We only want to process the motion event if we have the right payload, and either HKSV recording is enabled, or
      // HKSV recording is disabled and we have smart motion events disabled (or a device without smart motion capabilities) since those are handled elsewhere.
      if(this.stream?.hksv?.isRecording || (!this.stream?.hksv?.isRecording &&
        (!this.ufp.featureFlags.smartDetectTypes.length || (this.ufp.featureFlags.smartDetectTypes.length && !this.hints.smartDetect)))) {

        this.nvr.events.motionEventHandler(this, payload.lastMotion);
      }
    }

    // Process ring events.
    if(payload.lastRing) {

      this.nvr.events.doorbellEventHandler(this, payload.lastRing);
    }

    // Process camera details updates:
    //   - camera status light.
    //   - camera recording settings.
    if((payload.ledSettings && ("isEnabled" in payload.ledSettings)) || (payload.recordingSettings && ("mode" in payload.recordingSettings))) {

      this.updateDevice();
    }
  }

  // Handle smart motion detection events.
  private smartMotionEventHandler(packet: ProtectEventPacket): void {

    const payload = packet.payload as ProtectEventAdd;

    // We're only interested in smart motion detection events.
    if((packet.header.modelKey !== "event") || ((payload.type !== "smartDetectZone") && (payload.type !== "smartDetectLine")) || !payload.smartDetectTypes.length) {

      return;
    }

    // Process the motion event.
    this.nvr.events.motionEventHandler(this, payload.start, payload.smartDetectTypes);
  }

  // Configure discrete smart motion contact sensors for HomeKit.
  private configureMotionSmartSensor(): boolean {

    // If we don't have smart motion detection, we're done.
    if(!this.ufp.featureFlags.hasSmartDetect) {

      return false;
    }

    // Check for object-centric contact sensors that are no longer enabled and remove them.
    for(const objectService of this.accessory.services.filter(x => x.subtype?.startsWith(ProtectReservedNames.CONTACT_MOTION_SMARTDETECT + "."))) {

      // If we have motion sensors as well as object contact sensors enabled, and we have this object type enabled on this camera, we're good here.
      if(this.hasFeature("Motion.SmartDetect.ObjectSensors")) {
        continue;
      }

      // We don't have this contact sensor enabled, remove it.
      this.accessory.removeService(objectService);
      this.log.info("Disabling smart motion contact sensor: %s.", objectService.subtype?.slice(objectService.subtype?.indexOf(".") + 1));
    }

    // Have we enabled discrete contact sensors for specific object types? If not, we're done here.
    if(!this.hasFeature("Motion.SmartDetect.ObjectSensors")) {

      return false;
    }

    // Add individual contact sensors for each object detection type, if needed.
    for(const smartDetectType of this.ufp.featureFlags.smartDetectTypes) {

      const contactName = this.accessory.displayName + " " + smartDetectType.charAt(0).toUpperCase() + smartDetectType.slice(1);

      // See if we already have this contact sensor configured.
      let contactService = this.accessory.getServiceById(this.hap.Service.ContactSensor, ProtectReservedNames.CONTACT_MOTION_SMARTDETECT + "." + smartDetectType);

      // If not, let's add it.
      if(!contactService) {

        contactService = new this.hap.Service.ContactSensor(contactName, ProtectReservedNames.CONTACT_MOTION_SMARTDETECT + "." + smartDetectType);

        // Something went wrong, we're done here.
        if(!contactService) {
          this.log.error("Unable to add smart motion contact sensor for %s detection.", smartDetectType);
          return false;
        }

        // Finally, add it to the camera.
        this.accessory.addService(contactService);
      }

      // Initialize the sensor.
      contactService.addOptionalCharacteristic(this.hap.Characteristic.ConfiguredName);
      contactService.updateCharacteristic(this.hap.Characteristic.ConfiguredName, contactName);
      contactService.updateCharacteristic(this.hap.Characteristic.ContactSensorState, false);
    }

    this.log.info("Smart motion contact sensor%s enabled: %s.",
      this.ufp.featureFlags.smartDetectTypes.length > 1 ? "s" : "", this.ufp.featureFlags.smartDetectTypes.join(", "));

    return true;
  }

  // Configure a switch to manually trigger a doorbell ring event for HomeKit.
  private configureDoorbellTrigger(): boolean {

    // Find the switch service, if it exists.
    let triggerService = this.accessory.getServiceById(this.hap.Service.Switch, ProtectReservedNames.SWITCH_DOORBELL_TRIGGER);

    // See if we have a doorbell service configured.
    let doorbellService = this.accessory.getService(this.hap.Service.Doorbell);

    // Doorbell switches are disabled by default and primarily exist for automation purposes.
    if(!this.hasFeature("Doorbell.Trigger")) {

      if(triggerService) {

        this.accessory.removeService(triggerService);
      }

      // Since we aren't enabling the doorbell trigger on this camera, remove the doorbell service if the camera
      // isn't actually doorbell-capable hardware.
      if(!this.ufp.featureFlags.hasChime && doorbellService) {

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
        this.log.error("Unable to find the doorbell service.");
        return false;
      }
    }

    const triggerName = this.accessory.displayName + " Doorbell Trigger";

    // Add the switch to the camera, if needed.
    if(!triggerService) {
      triggerService = new this.hap.Service.Switch(triggerName, ProtectReservedNames.SWITCH_DOORBELL_TRIGGER);

      if(!triggerService) {
        this.log.error("Unable to add the doorbell trigger.");
        return false;
      }

      this.accessory.addService(triggerService);
    }

    // Trigger the doorbell.
    triggerService
      .getCharacteristic(this.hap.Characteristic.On)
      ?.onGet(() => {

        return this.isRinging;
      })
      .onSet((value: CharacteristicValue) => {

        if(value) {

          // Trigger the motion event.
          this.nvr.events.doorbellEventHandler(this, Date.now());
          this.log.info("Doorbell ring event triggered.");

        } else {

          // If the doorbell ring event is still going, we should be as well.
          if(this.isRinging) {

            setTimeout(() => {
              triggerService?.updateCharacteristic(this.hap.Characteristic.On, true);
            }, 50);
          }
        }
      });

    // Initialize the switch.
    triggerService.addOptionalCharacteristic(this.hap.Characteristic.ConfiguredName);
    triggerService.updateCharacteristic(this.hap.Characteristic.ConfiguredName, triggerName);
    triggerService.updateCharacteristic(this.hap.Characteristic.On, false);

    this.log.info("Enabling doorbell automation trigger.");

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
        this.log.error("Unable to add doorbell.");
        return false;
      }

      this.accessory.addService(doorbellService);
    }

    doorbellService.setPrimaryService(true);
    this.isDoorbellConfigured = true;
    return true;
  }

  // Configure additional camera-specific characteristics for HomeKit.
  private configureCameraDetails(): boolean {

    // Find the service, if it exists.
    const statusLedService = this.accessory.getService(this.hap.Service.CameraOperatingMode);

    // Have we enabled the camera status LED?
    if(this.hints.ledStatus && statusLedService) {

      // Turn the status light on or off.
      statusLedService.getCharacteristic(this.hap.Characteristic.CameraOperatingModeIndicator)
        ?.onGet(() => {

          return this.ufp.ledSettings?.isEnabled === true;
        })
        .onSet(async (value: CharacteristicValue) => {

          const ledState = value === true;

          // Update the status light in Protect.
          const newDevice = await this.nvr.ufpApi.updateDevice(this.ufp, { ledSettings: { isEnabled: ledState } });

          if(!newDevice) {

            this.log.error("Unable to turn the status light %s. Please ensure this username has the Administrator role in UniFi Protect.", ledState ? "on" : "off");
            return;
          }

          // Update our internal view of the device configuration.
          this.ufp = newDevice;
        });


      // Initialize the status light state.
      statusLedService.updateCharacteristic(this.hap.Characteristic.CameraOperatingModeIndicator, this.ufp.ledSettings.isEnabled === true);
    } else if(statusLedService) {

      // Remove the camera status light if we have it.
      const statusLight = statusLedService.getCharacteristic(this.hap.Characteristic.CameraOperatingModeIndicator);

      if(statusLight) {

        statusLedService.removeCharacteristic(statusLight);
      }
    }

    return true;
  }

  // Configure a camera accessory for HomeKit.
  private async configureVideoStream(): Promise<boolean> {

    const rtspEntries: RtspEntry[] = [];

    // No channels exist on this camera or we don't have access to the bootstrap configuration.
    if(!this.ufp.channels) {

      return false;
    }

    // Enable RTSP on the camera if needed and get the list of RTSP streams we have ultimately configured.
    this.ufp = await this.nvr.ufpApi.enableRtsp(this.ufp) ?? this.ufp;

    // Figure out which camera channels are RTSP-enabled, and user-enabled.
    const cameraChannels = this.ufp.channels.filter(x => x.isRtspEnabled && this.hasFeature("Video.Stream." + x.name));

    // Make sure we've got a HomeKit compatible IDR frame interval. If not, let's take care of that.
    let idrChannels = cameraChannels.filter(x => x.idrInterval !== PROTECT_HOMEKIT_IDR_INTERVAL);

    if(idrChannels.length) {

      // Edit the channel map.
      idrChannels = idrChannels.map(x => {

        x.idrInterval = PROTECT_HOMEKIT_IDR_INTERVAL;
        return x;
      });

      this.ufp = await this.nvr.ufpApi.updateDevice(this.ufp, { channels: idrChannels }) ?? this.ufp;
    }

    // Set the camera and shapshot URLs.
    const cameraUrl = "rtsps://" + this.nvr.nvrOptions.address + ":" + this.nvr.ufp.ports.rtsps.toString() + "/";
    this.snapshotUrl = this.nvr.ufpApi.getApiEndpoint(this.ufp.modelKey) + "/" + this.ufp.id + "/snapshot";

    // No RTSP streams are available that meet our criteria - we're done.
    if(!cameraChannels.length) {

      this.log.info("No RTSP stream profiles have been configured for this camera. " +
        "Enable at least one RTSP stream profile in the UniFi Protect webUI to resolve this issue or " +
        "assign the Administrator role to the user configured for this plugin to allow it to automatically configure itself."
      );

      return false;
    }

    // Now that we have our RTSP streams, create a list of supported resolutions for HomeKit.
    for(const channel of cameraChannels) {

      // Sanity check in case Protect reports nonsensical resolutions.
      if(!channel.name || (channel.width <= 0) || (channel.width > 65535) || (channel.height <= 0) || (channel.height > 65535)) {

        continue;
      }

      rtspEntries.push({ channel: channel,
        name: this.getResolution([channel.width, channel.height, channel.fps]) + " (" + channel.name + ")",
        resolution: [ channel.width, channel.height, channel.fps ], url: cameraUrl + channel.rtspAlias + "?enableSrtp" });
    }

    // Sort the list of resolutions, from high to low.
    rtspEntries.sort(this.sortByResolutions.bind(this));

    // Next, ensure we have mandatory resolutions required by HomeKit, as well as special support for Apple TV and Apple Watch:
    //   3840x2160@30 (4k).
    //   1920x1080@30 (1080p).
    //   1280x720@30 (720p).
    //   320x240@30 (Apple Watch).
    //   320x240@15 (Apple Watch).
    //   320x180@30 (Apple Watch).
    //   320x180@15 (Apple Watch).
    for(const entry of [
      [3840, 2160, 30], [1920, 1080, 30], [1280, 960, 30], [1280, 720, 30], [1024, 768, 30], [640, 480, 30],
      [640, 360, 30], [480, 360, 30], [480, 270, 30], [320, 240, 30], [320, 240, 15], [320, 180, 30], [320, 180, 15]
    ] ) {

      // We already have this resolution in our list.
      if(rtspEntries.some(x => (x.resolution[0] === entry[0]) && (x.resolution[1] === entry[1]) && (x.resolution[2] === entry[2]))) {

        continue;
      }

      // Find the closest RTSP match for this resolution.
      const foundRtsp = this.findRtsp(entry[0], entry[1], undefined, rtspEntries);

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

    // Inform users about our RTSP entry mapping, if we're debugging.
    if(this.nvr.optionEnabled(this.ufp, "Debug.Video.Startup", false)) {

      for(const entry of this.rtspEntries) {

        this.log.info("Mapping resolution: %s.", this.getResolution(entry.resolution) + " => " + entry.name);
      }
    }

    // Canary to ensure we stop once we find.
    let onlyStreamFound = false;
    let onlyRecordFound = false;

    // Check for explicit RTSP profile preferences at the device level.
    for(const rtspProfile of [ "LOW", "MEDIUM", "HIGH" ]) {

      // Check to see if the user has requested a specific streaming profile for this camera.
      if(this.nvr.optionEnabled(this.ufp, "Video.Stream.Only." + rtspProfile + "." + this.ufp.mac, false)) {

        this.rtspQuality.StreamingDefault = rtspProfile;
        onlyStreamFound = true;
      }

      // Check to see if the user has requested a specific recording profile for this camera.
      if(this.nvr.optionEnabled(this.ufp, "Video.HKSV.Record.Only." + rtspProfile + "." + this.ufp.mac, false)) {

        this.rtspQuality.RecordingDefault = rtspProfile;
        onlyRecordFound = true;
      }
    }

    // Check for explicit RTSP profile preferences at the controller level.
    for(const rtspProfile of [ "LOW", "MEDIUM", "HIGH" ]) {

      // Check to see if the user has requested a specific streaming profile for this camera.
      if(!onlyStreamFound && this.nvr.optionEnabled(this.ufp, "Video.Stream.Only." + rtspProfile + "." + this.nvr.ufp.mac, false)) {

        this.rtspQuality.StreamingDefault = rtspProfile;
        onlyStreamFound = true;
      }

      // Check to see if the user has requested a specific recording profile for this camera.
      if(!onlyRecordFound && this.nvr.optionEnabled(this.ufp, "Video.HKSV.Record.Only." + rtspProfile + "." + this.nvr.ufp.mac, false)) {

        this.rtspQuality.RecordingDefault = rtspProfile;
        onlyRecordFound = true;
      }
    }

    // Check for explicit RTSP profile preferences globally.
    for(const rtspProfile of [ "LOW", "MEDIUM", "HIGH" ]) {

      // Check to see if the user has requested a specific streaming profile for this camera.
      if(!onlyStreamFound && this.hasFeature("Video.Stream.Only." + rtspProfile)) {

        this.rtspQuality.StreamingDefault = rtspProfile;
        onlyStreamFound = true;
      }

      // Check to see if the user has requested a specific recording profile for this camera.
      if(!onlyRecordFound && this.hasFeature("Video.HKSV.Record.Only." + rtspProfile)) {

        this.rtspQuality.RecordingDefault = rtspProfile;
        onlyRecordFound = true;
      }
    }

    // Inform the user if we've set a streaming default.
    if(this.rtspQuality.StreamingDefault) {

      this.log.info("Video streaming configured to use only: %s.",
        this.rtspQuality.StreamingDefault.charAt(0) + this.rtspQuality.StreamingDefault.slice(1).toLowerCase());
    }

    // Inform the user if we've set a recording default.
    if(this.rtspQuality.RecordingDefault) {

      this.log.info("HomeKit Secure Video event recording configured to use only: %s.",
        this.rtspQuality.RecordingDefault.charAt(0) + this.rtspQuality.RecordingDefault.slice(1).toLowerCase());
    }

    // Configure the video stream with our resolutions.
    this.stream = new ProtectStreamingDelegate(this, this.rtspEntries.map(x => x.resolution));

    // Fire up the controller and inform HomeKit about it.
    this.accessory.configureController(this.stream.controller);
    this.isVideoConfigured = true;

    return true;
  }

  // Configure a periodic refresh of our snapshot images.
  protected async configureSnapshotUpdates(): Promise<boolean> {

    for(;;) {

      // If we've removed the device, make sure we stop refreshing.
      if(this.isDeleted) {

        return true;
      }

      // Refresh our snapshot cache.
      // eslint-disable-next-line no-await-in-loop
      await this.stream?.getSnapshot(undefined, false);

      // Sleep for 59 seconds.
      // eslint-disable-next-line no-await-in-loop
      await this.nvr.sleep(PROTECT_SNAPSHOT_CACHE_REFRESH_INTERVAL * 1000);
    }

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
    let packageCameraAccessory = this.platform.accessories.find((x: PlatformAccessory) => x.UUID === uuid) ?? (null as unknown as PlatformAccessory);

    // We can't find the accessory. Let's create it.
    if(!packageCameraAccessory) {

      // We will use the NVR MAC address + ".NVRSystemInfo" to create our UUID. That should provide the guaranteed uniqueness we need.
      packageCameraAccessory = new this.api.platformAccessory(this.accessory.displayName + " Package Camera", uuid);

      if(!packageCameraAccessory) {

        this.log.error("Unable to create the package camera accessory.");
        return false;
      }

      // Register this accessory with homebridge and add it to the platform accessory array so we can track it.
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [ packageCameraAccessory ]);
      this.platform.accessories.push(packageCameraAccessory);
    }

    // Now create the package camera accessory. We do want to modify the camera name to ensure things look pretty.
    this.packageCamera = new ProtectPackageCamera(this.nvr, Object.assign({}, this.ufp, { name: this.ufp.name + " Package Camera"}), packageCameraAccessory);
    return true;
  }

  // Configure HomeKit Secure Video support.
  private configureHksv(): boolean {

    this.hasHksv = true;

    // If we have smart motion events enabled, let's warn the user that things will not work quite the way they expect.
    if(this.ufp.featureFlags.hasSmartDetect && this.hints.smartDetect) {

      this.log.info("WARNING: Smart motion detection and HomeKit Secure Video provide overlapping functionality. " +
        "Only HomeKit Secure Video, when event recording is enabled in the Home app, will be used to trigger motion event notifications for this camera." +
        (this.hasFeature("Motion.SmartDetect.ObjectSensors") ? " Smart motion contact sensors will continue to function using telemetry from UniFi Protect." : ""));
    }

    return true;
  }

  // Configure a switch to manually enable or disable HKSV recording for a camera.
  private configureHksvRecordingSwitch(): boolean {

    // Find the switch service, if it exists.
    let switchService = this.accessory.getServiceById(this.hap.Service.Switch, ProtectReservedNames.SWITCH_HKSV_RECORDING);

    // If we don't have HKSV or the HKSV recording switch enabled, disable it and we're done.
    if(!this.hasFeature("Video.HKSV.Recording.Switch")) {

      if(switchService) {

        this.accessory.removeService(switchService);
      }

      // We want to default this back to recording whenever we disable the recording switch.
      this.accessory.context.hksvRecording = true;

      return false;
    }

    const switchName = this.accessory.displayName + " HKSV Recording";

    // Add the switch to the camera, if needed.
    if(!switchService) {

      switchService = new this.hap.Service.Switch(switchName, ProtectReservedNames.SWITCH_HKSV_RECORDING);

      if(!switchService) {

        this.log.error("Unable to add the HomeKit Secure Video recording switch.");
        return false;
      }

      this.accessory.addService(switchService);
    }

    // Activate or deactivate HKSV recording.
    switchService
      .getCharacteristic(this.hap.Characteristic.On)
      ?.onGet(() => {

        return this.accessory.context.hksvRecording as boolean;
      })
      .onSet((value: CharacteristicValue) => {

        if(this.accessory.context.hksvRecording !== value) {

          this.log.info("HomeKit Secure Video event recording has been %s.", value === true ? "enabled" : "disabled");
        }

        this.accessory.context.hksvRecording = value === true;
      });

    // Initialize the switch.
    switchService.addOptionalCharacteristic(this.hap.Characteristic.ConfiguredName);
    switchService.updateCharacteristic(this.hap.Characteristic.ConfiguredName, switchName);
    switchService.updateCharacteristic(this.hap.Characteristic.On, this.accessory.context.hksvRecording as boolean);

    this.log.info("Enabling HomeKit Secure Video recording switch.");

    return true;
  }

  // Configure a switch to manually enable or disable dynamic bitrate capabilities for a camera.
  private configureDynamicBitrateSwitch(): boolean {

    // Find the switch service, if it exists.
    let switchService = this.accessory.getServiceById(this.hap.Service.Switch, ProtectReservedNames.SWITCH_DYNAMIC_BITRATE);

    // If we don't want a dynamic bitrate switch, disable it and we're done.
    if(!this.hasFeature("Video.DynamicBitrate.Switch")) {

      if(switchService) {

        this.accessory.removeService(switchService);
      }

      // We want to default this back to off by default whenever we disable the dynamic bitrate switch.
      this.accessory.context.dynamicBitrate = false;

      return false;
    }

    const switchName = this.accessory.displayName + " Dynamic Bitrate";

    // Add the switch to the camera, if needed.
    if(!switchService) {

      switchService = new this.hap.Service.Switch(switchName, ProtectReservedNames.SWITCH_DYNAMIC_BITRATE);

      if(!switchService) {

        this.log.error("Unable to add the dynamic bitrate switch.");
        return false;
      }

      this.accessory.addService(switchService);
    }

    // Activate or deactivate dynamic bitrate for this device.
    switchService
      .getCharacteristic(this.hap.Characteristic.On)
      ?.onGet(() => {

        return this.accessory.context.dynamicBitrate as boolean;
      })
      .onSet(async (value: CharacteristicValue) => {

        if(this.accessory.context.dynamicBitrate === value) {

          return;
        }

        // We're enabling dynamic bitrate for this device.
        if(value) {

          this.accessory.context.dynamicBitrate = true;
          this.log.info("Dynamic streaming bitrate adjustment on the UniFi Protect controller enabled.");
          return;
        }

        // We're disabling dynamic bitrate for this device.
        const updatedChannels = this.ufp.channels;

        // Update the channels JSON.
        for(const channel of updatedChannels) {

          channel.bitrate = channel.maxBitrate;
        }

        // Send the channels JSON to Protect.
        const newDevice = await this.nvr.ufpApi.updateDevice(this.ufp, { channels: updatedChannels });

        // We failed.
        if(!newDevice) {

          this.log.error("Unable to set the streaming bitrate to %s.", value);
        } else {

          this.ufp = newDevice;
        }

        this.accessory.context.dynamicBitrate = false;
        this.log.info("Dynamic streaming bitrate adjustment on the UniFi Protect controller disabled.");
      });

    // Initialize the switch.
    switchService.addOptionalCharacteristic(this.hap.Characteristic.ConfiguredName);
    switchService.updateCharacteristic(this.hap.Characteristic.ConfiguredName, switchName);
    switchService.updateCharacteristic(this.hap.Characteristic.On, this.accessory.context.dynamicBitrate as boolean);

    this.log.info("Enabling the dynamic streaming bitrate adjustment switch.");

    return true;
  }

  // Configure a series of switches to manually enable or disable recording on the UniFi Protect controller for a camera.
  private configureNvrRecordingSwitch(): boolean {

    const switchesEnabled = [];

    // The Protect controller supports three modes for recording on a camera: always, detections, and never. We create switches for each of the modes.
    for(const ufpRecordingSwitchType of
      [  ProtectReservedNames.SWITCH_UFP_RECORDING_ALWAYS, ProtectReservedNames.SWITCH_UFP_RECORDING_DETECTIONS, ProtectReservedNames.SWITCH_UFP_RECORDING_NEVER ]) {

      const ufpRecordingSetting = ufpRecordingSwitchType.slice(ufpRecordingSwitchType.lastIndexOf(".") + 1);

      // Find the switch service, if it exists.
      let switchService = this.accessory.getServiceById(this.hap.Service.Switch, ufpRecordingSwitchType);

      // If we don't have the feature option enabled, disable the switch and we're done.
      if(!this.hasFeature("Nvr.Recording.Switch")) {

        if(switchService) {

          this.accessory.removeService(switchService);
        }

        continue;
      }

      const switchName = this.accessory.displayName + " UFP Recording " + ufpRecordingSetting.charAt(0).toUpperCase() + ufpRecordingSetting.slice(1);

      // Add the switch to the camera, if needed.
      if(!switchService) {

        switchService = new this.hap.Service.Switch(switchName, ufpRecordingSwitchType);

        if(!switchService) {

          this.log.error("Unable to add the UniFi Protect recording switches.");
          continue;
        }

        this.accessory.addService(switchService);
      }

      // Activate or deactivate the appropriate recording mode on the Protect controller.
      switchService
        .getCharacteristic(this.hap.Characteristic.On)
        ?.onGet(() => {

          return this.ufp.recordingSettings.mode === ufpRecordingSetting;
        })
        .onSet(async (value: CharacteristicValue) => {

          // We only want to do something if we're being activated. Turning off the switch would really be an undefined state given that
          // there are three different settings one can choose from. Instead, we do nothing and leave it to the user to choose what state
          // they really want to set.
          if(!value) {

            setTimeout(() => {

              this.updateDevice();
            }, 50);

            return;
          }

          // Set our recording mode.
          this.ufp.recordingSettings.mode = ufpRecordingSetting;

          // Tell Protect about it.
          const newDevice = await this.nvr.ufpApi.updateDevice(this.ufp, { recordingSettings: this.ufp.recordingSettings });

          if(!newDevice) {

            this.log.error("Unable to set the UniFi Protect recording mode to %s.", ufpRecordingSetting);
            return false;
          }

          // Save our updated device context.
          this.ufp = newDevice;

          // Update all the other recording switches.
          for(const otherUfpSwitch of
            [ ProtectReservedNames.SWITCH_UFP_RECORDING_ALWAYS, ProtectReservedNames.SWITCH_UFP_RECORDING_DETECTIONS, ProtectReservedNames.SWITCH_UFP_RECORDING_NEVER ]) {

            // Don't update ourselves a second time.
            if(ufpRecordingSwitchType === otherUfpSwitch) {

              continue;
            }

            // Update the other recording switches.
            this.accessory.getServiceById(this.hap.Service.Switch, otherUfpSwitch)?.updateCharacteristic(this.hap.Characteristic.On, false);
          }

          // Inform the user, and we're done.
          this.log.info("UniFi Protect recording mode set to %s.", ufpRecordingSetting);
        });

      // Initialize the recording switch state.
      switchService.addOptionalCharacteristic(this.hap.Characteristic.ConfiguredName);
      switchService.updateCharacteristic(this.hap.Characteristic.ConfiguredName, switchName);
      switchService.updateCharacteristic(this.hap.Characteristic.On, this.ufp.recordingSettings.mode === ufpRecordingSetting);
      switchesEnabled.push(ufpRecordingSetting);
    }

    if(switchesEnabled.length) {

      this.log.info("Enabling UniFi Protect recording switches: %s.", switchesEnabled.join(", "));
    }

    return true;
  }

  // Configure MQTT capabilities of this camera.
  protected configureMqtt(): boolean {

    // Return the RTSP URLs when requested.
    this.nvr.mqtt?.subscribe(this.accessory, "rtsp/get", (message: Buffer) => {
      const value = message.toString();

      // When we get the right message, we trigger the snapshot request.
      if(value?.toLowerCase() !== "true") {

        return;
      }

      const urlInfo: { [index: string]: string } = {};

      // Grab all the available RTSP channels.
      for(const channel of this.ufp.channels) {

        if(!channel.isRtspEnabled) {

          continue;
        }

        urlInfo[channel.name] = "rtsps://" + this.nvr.ufp.host + ":" + this.nvr.ufp.ports.rtsp.toString() + "/" + channel.rtspAlias + "?enableSrtp";
      }

      this.nvr.mqtt?.publish(this.accessory, "rtsp", JSON.stringify(urlInfo));
      this.log.info("RTSP information published via MQTT.");
    });

    // Trigger snapshots when requested.
    this.nvr.mqtt?.subscribe(this.accessory, "snapshot/trigger", (message: Buffer) => {

      const value = message.toString();

      // When we get the right message, we trigger the snapshot request.
      if(value?.toLowerCase() !== "true") {

        return;
      }

      void this.stream?.handleSnapshotRequest();
      this.log.info("Snapshot triggered via MQTT.");
    });

    return true;
  }

  // Refresh camera-specific characteristics.
  public updateDevice(): boolean {

    // Update the camera state.
    this.accessory.getService(this.hap.Service.MotionSensor)?.updateCharacteristic(this.hap.Characteristic.StatusActive, this.ufp.state === "CONNECTED");

    // Check to see if this device has a status light.
    if(this.hints.ledStatus) {

      this.accessory.getService(this.hap.Service.CameraOperatingMode)?.
        updateCharacteristic(this.hap.Characteristic.CameraOperatingModeIndicator, this.ufp.ledSettings.isEnabled === true);
    }

    // Check for updates to the recording state, if we have the switches configured.
    if(this.hasFeature("Nvr.Recording.Switch")) {

      // Update all the switch states.
      for(const ufpRecordingSwitchType of
        [  ProtectReservedNames.SWITCH_UFP_RECORDING_ALWAYS, ProtectReservedNames.SWITCH_UFP_RECORDING_DETECTIONS, ProtectReservedNames.SWITCH_UFP_RECORDING_NEVER ]) {

        const ufpRecordingSetting = ufpRecordingSwitchType.slice(ufpRecordingSwitchType.lastIndexOf(".") + 1);

        // Update state based on the recording mode.
        this.accessory.getServiceById(this.hap.Service.Switch, ufpRecordingSwitchType)?.
          updateCharacteristic(this.hap.Characteristic.On, ufpRecordingSetting === this.ufp.recordingSettings.mode);
      }
    }

    return true;
  }

  // Get the current bitrate for a specific camera channel.
  public getBitrate(channelId: number): number {

    // Find the right channel.
    const channel = this.ufp.channels.find(x => x.id === channelId);

    return channel?.bitrate ?? -1;
  }

  // Set the bitrate for a specific camera channel.
  public async setBitrate(channelId: number, value: number): Promise<boolean> {

    // If we've disabled the ability to set the bitrate dynamically, silently fail. We prioritize switches over the global
    // setting here, in case the user enabled both, using the principle that the most specific setting always wins. If the
    // user has both the global setting and the switch enabled, the switch setting will take precedence.
    if((!this.accessory.context.dynamicBitrate && !this.hasFeature("Video.DynamicBitrate")) ||
      (!this.accessory.context.dynamicBitrate && this.hasFeature("Video.DynamicBitrate") && this.hasFeature("Video.DynamicBitrate.Switch"))) {

      return true;
    }

    // Find the right channel.
    const channel = this.ufp.channels.find(x => x.id === channelId);

    // No channel, we're done.
    if(!channel) {

      return false;
    }

    // If our correct bitrate is already set, we're done.
    if(channel.bitrate === value) {

      return true;
    }

    // Make sure the requested bitrate fits within the constraints of what this channel can do.
    channel.bitrate = Math.min(channel.maxBitrate, Math.max(channel.minBitrate, value));

    // Tell Protect about it.
    const newDevice = await this.nvr.ufpApi.updateDevice(this.ufp, { channels: this.ufp.channels });

    if(!newDevice) {

      this.log.error("Unable to set the streaming bitrate to %s.", value);
      return false;
    }

    // Save our updated device context.
    this.ufp = newDevice;

    return true;
  }

  // Find an RTSP configuration for a given target resolution.
  private findRtspEntry(width: number, height: number, address: string, rtspEntries: RtspEntry[],
    defaultStream = this.rtspQuality.StreamingDefault): RtspEntry | null {

    // No RTSP entries to choose from, we're done.
    if(!rtspEntries || !rtspEntries.length) {

      return null;
    }

    // First, we check to see if we've set an explicit preference for the target address.
    if(address) {

      // If we don't have this address cached, look it up and cache it.
      if(!this.rtspQuality[address]) {

        // Check to see if there's an explicit preference set and cache the result.
        if(this.hasFeature("Video.Stream.Only.Low", address, true)) {

          this.rtspQuality[address] = "LOW";
        } else if(this.hasFeature("Video.Stream.Only.Medium", address, true)) {

          this.rtspQuality[address] = "MEDIUM";
        } else if(this.hasFeature("Video.Stream.Only.High", address, true)) {

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
    if(defaultStream) {

      return rtspEntries.find(x => x.channel.name.toUpperCase() === defaultStream) ?? null;
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

      const entry = rtspEntries.find(x => x.resolution[0] >= 1280);

      if(entry) {

        return entry;
      }
    }

    // If we didn't request an HD resolution, or we couldn't find anything HD to use, we try to find the highest resolution we can find
    // that's at least our requested width or larger. If we can't find anything that matches, we return the lowest resolution we have available.
    return rtspEntries.find(x => width >= x.resolution[0]) ?? rtspEntries[rtspEntries.length - 1];
  }

  // Find a streaming RTSP configuration for a given target resolution.
  public findRtsp(width: number, height: number, address = "", rtspEntries = this.rtspEntries): RtspEntry | null {

    return this.findRtspEntry(width, height, address, rtspEntries);
  }

  // Find a recording RTSP configuration for a given target resolution.
  public findRecordingRtsp(width: number, height: number, rtspEntries = this.rtspEntries): RtspEntry | null {

    return this.findRtspEntry(width, height, "", rtspEntries, this.rtspQuality.RecordingDefault);
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

  // Utility function to format resolution entries.
  private getResolution(resolution: [number, number, number]): string {

    return resolution[0].toString() + "x" + resolution[1].toString() + "@" + resolution[2].toString() + "fps";
  }
}

// Package camera class.
export class ProtectPackageCamera extends ProtectCamera {

  // Configure the package camera.
  protected async configureDevice(): Promise<boolean> {

    this.hints.probesize = 32768;
    this.hasHksv = false;

    // Clean out the context object in case it's been polluted somehow.
    this.accessory.context = {};

    // We explicitly avoid adding the MAC address of the camera - that's reserved for real Protect devices, not synthetic ones we create.
    this.accessory.context.nvr = this.nvr.ufp.mac;
    this.accessory.context.packageCamera = true;

    // Configure accessory information.
    this.configureInfo();

    // Set the snapshot URL.
    this.snapshotUrl = this.nvr.ufpApi.getApiEndpoint(this.ufp.modelKey) + "/" + this.ufp.id + "/package-snapshot";

    // Configure the video stream with our required resolutions. No, package cameras don't really support any of these resolutions, but they're required
    // by HomeKit in order to stream video.
    this.stream = new ProtectStreamingDelegate(this, [ [3840, 2160, 30], [1920, 1080, 30], [1280, 960, 30], [1280, 720, 30], [1024, 768, 30], [640, 480, 30],
      [640, 360, 30], [480, 360, 30], [480, 270, 30], [320, 240, 30], [320, 240, 15], [320, 180, 30] ]);

    // Fire up the controller and inform HomeKit about it.
    this.accessory.configureController(this.stream.controller);

    // Periodically refresh our snapshot cache.
    void this.configureSnapshotUpdates();

    // We're done.
    return Promise.resolve(true);
  }

  // Make our RTSP stream findable.
  public findRtsp(): RtspEntry | null {

    const channel = this.ufp.channels.find(x => x.name === "Package Camera");

    if(!channel) {

      return null;
    }

    return {

      channel: channel,
      name: channel.name,
      resolution: [ channel.width, channel.height, channel.fps ],
      url:  "rtsps://" + this.nvr.nvrOptions.address + ":" + this.nvr.ufp.ports.rtsps.toString() + "/" + channel.rtspAlias + "?enableSrtp"
    };
  }

  // Get the current bitrate for a specific camera channel.
  public getBitrate(channelId: number): number {

    // Find the right channel.
    const channel = this.ufp.channels.find(x => x.id === channelId);

    return channel?.bitrate ?? -1;
  }

  // Set the bitrate for a specific camera channel.
  public setBitrate(): Promise<boolean> {

    return Promise.resolve(true);
  }
}
