/* Copyright(C) 2019-2025, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-camera.ts: Camera device class for UniFi Protect.
 */
import type { CharacteristicValue, PlatformAccessory, Resolution, Service } from "homebridge";
import type { ProtectCameraChannelConfig, ProtectCameraConfig, ProtectCameraConfigPayload, ProtectEventAdd, ProtectEventPacket } from "unifi-protect";
import { ProtectReservedNames, toCamelCase } from "../protect-types.js";
import { LivestreamManager } from "../protect-livestream.js";
import type { MessageSwitchInterface } from "./protect-doorbell.js";
import type { Nullable } from "homebridge-plugin-utils";
import type { ProtectCameraPackage } from "./protect-camera-package.js";
import { ProtectDevice } from "./protect-device.js";
import type { ProtectNvr } from "../protect-nvr.js";
import { ProtectStreamingDelegate } from "../protect-stream.js";

export interface RtspEntry {

  channel: ProtectCameraChannelConfig,
  lens?: number,
  name: string,
  resolution: Resolution,
  url: string
}

// Options for tuning our RTSP lookups.
type RtspOptions = Partial<{

  biasHigher: boolean,
  default: string,
  maxPixels: number,
  rtspEntries: RtspEntry[]
}>;

export class ProtectCamera extends ProtectDevice {

  private accessUnlockTimer?: NodeJS.Timeout;
  private ambientLight: number;
  private ambientLightTimer?: NodeJS.Timeout;
  private isDeleted: boolean;
  public isRinging: boolean;
  public detectLicensePlate: string[];
  public readonly livestream: LivestreamManager;
  public messageSwitches: { [index: string]: MessageSwitchInterface };
  public packageCamera?: Nullable<ProtectCameraPackage>;
  private rtspEntries: RtspEntry[];
  private rtspQuality: { [index: string]: string };
  public stream!: ProtectStreamingDelegate;
  public ufp: ProtectCameraConfig;

  // Create an instance.
  constructor(nvr: ProtectNvr, device: ProtectCameraConfig, accessory: PlatformAccessory) {

    super(nvr, accessory);

    this.ambientLight = 0;
    this.isDeleted = false;
    this.isRinging = false;
    this.detectLicensePlate = [];
    this.livestream = new LivestreamManager(this);
    this.messageSwitches = {};
    this.rtspEntries = [];
    this.rtspQuality = {};
    this.ufp = device;

    this.configureHints();
    this.configureDevice();
  }

  // Configure device-specific settings for this device.
  protected configureHints(): boolean {

    // Configure our parent's hints.
    super.configureHints();

    this.hints.tsbStreaming = this.hasFeature("Video.Stream.UseApi");
    this.hints.crop = this.hasFeature("Video.Crop");
    this.hints.hardwareDecoding = true;
    this.hints.hardwareTranscoding = this.hasFeature("Video.Transcode.Hardware");
    this.hints.highResSnapshots = this.hasFeature("Video.HighResSnapshots");
    this.hints.hksvRecordingIndicator = this.hasFeature("Video.HKSV.StatusLedIndicator");
    this.hints.ledStatus = this.ufp.featureFlags.hasLedStatus && this.hasFeature("Device.StatusLed");
    this.hints.logDoorbell = this.hasFeature("Log.Doorbell");
    this.hints.logHksv = this.hasFeature("Log.HKSV");
    this.hints.nightVision = this.ufp.featureFlags.hasInfrared && this.hasFeature("Device.NightVision");
    this.hints.probesize = 16384;
    this.hints.smartDetect = this.ufp.featureFlags.hasSmartDetect && this.hasFeature("Motion.SmartDetect");
    this.hints.smartDetectSensors = this.hints.smartDetect && this.hasFeature("Motion.SmartDetect.ObjectSensors");
    this.hints.transcode = this.hasFeature("Video.Transcode");
    this.hints.transcodeBitrate = this.getFeatureNumber("Video.Transcode.Bitrate") as number;
    this.hints.transcodeHighLatency = this.hasFeature("Video.Transcode.HighLatency");
    this.hints.transcodeHighLatencyBitrate = this.getFeatureNumber("Video.Transcode.HighLatency.Bitrate") as number;
    this.hints.twoWayAudio = this.ufp.featureFlags.hasSpeaker && this.hasFeature("Audio") && this.hasFeature("Audio.TwoWay");
    this.hints.twoWayAudioDirect = this.ufp.featureFlags.hasSpeaker && this.hasFeature("Audio") && this.hasFeature("Audio.TwoWay.Direct");

    // Sanity check our target transcoding bitrates, if defined.
    if((this.hints.transcodeBitrate === null) || (this.hints.transcodeBitrate === undefined) || (this.hints.transcodeBitrate <= 0)) {

      this.hints.transcodeBitrate = -1;
    }

    if((this.hints.transcodeHighLatencyBitrate === null) || (this.hints.transcodeHighLatencyBitrate === undefined) || (this.hints.transcodeHighLatencyBitrate <= 0)) {

      this.hints.transcodeHighLatencyBitrate = -1;
    }

    return true;
  }

  // Configure a camera accessory for HomeKit.
  protected configureDevice(): boolean {

    // Save our context for reference before we recreate it.
    const savedContext = this.accessory.context;

    // Clean out the context object in case it's been polluted somehow.
    this.accessory.context = {};
    this.accessory.context.detectMotion = savedContext.detectMotion as boolean ?? true;
    this.accessory.context.hksvRecording = savedContext.hksvRecording as boolean ?? true;
    this.accessory.context.mac = this.ufp.mac;
    this.accessory.context.nvr = this.nvr.ufp.mac;

    // Inform the user that motion detection will suck.
    if(this.ufp.recordingSettings.mode === "never") {

      this.log.warn("Motion events will not be generated by the Protect controller when the controller's camera recording options are set to \"never\".");
    }

    // Check to see if we have smart motion events enabled on a supported camera.
    if(this.hints.smartDetect) {

      const smartDetectTypes = [...this.ufp.featureFlags.smartDetectAudioTypes, ...this.ufp.featureFlags.smartDetectTypes];

      // Inform the user of what smart detection object types we're configured for.
      this.log.info("Smart motion detection enabled%s.", smartDetectTypes.length ? ": " + smartDetectTypes.sort().join(", ") : "");
    }

    // Configure accessory information.
    this.configureInfo();

    // Configure MQTT services.
    this.configureMqtt();

    // Configure the motion sensor.
    this.configureMotionSensor(this.isHksvCapable);

    // Configure smart motion contact sensors.
    this.configureMotionSmartSensor();

    // Configure the occupancy sensor.
    this.configureOccupancySensor();

    // Configure UniFi Access specific features on supported devices such as lock mechanisms that cohabitate on the same controller as Protect.
    this.configureAccessFeatures();

    // Configure cropping.
    this.configureCrop();

    // Configure HomeKit Secure Video suport.
    this.configureHksv();
    this.configureHksvRecordingSwitch();

    // We use an IIFE here since we can't make the enclosing function asynchronous.
    (async (): Promise<void> => {

      // Configure the ambient light sensor.
      await this.configureAmbientLightSensor();

      // Configure our video stream.
      await this.configureVideoStream();

      // Configure our camera details.
      this.configureCameraDetails();

      // Configure our NVR recording switches.
      this.configureNvrRecordingSwitch();

      // Configure the status indicator light switch.
      this.configureStatusLedSwitch();

      // Configure the night vision indicator light switch.
      this.configureNightVisionDimmer();

      // Configure the doorbell trigger.
      this.configureDoorbellTrigger();

      // Listen for events.
      this.nvr.events.on("addEvent." + this.ufp.id, this.listeners["addEvent." + this.ufp.id] = this.addEventHandler.bind(this));
      this.nvr.events.on("updateEvent." + this.ufp.id, this.listeners["updateEvent." + this.ufp.id] = this.eventHandler.bind(this));
    })();

    return true;
  }

  // Cleanup after ourselves if we're being deleted.
  public cleanup(): void {

    // If we've got HomeKit Secure Video enabled and recording, disable it.
    if(this.stream?.hksv?.isRecording) {

      void this.stream.hksv.updateRecordingActive(false);
    }

    // Cleanup our livestream manager.
    this.livestream.shutdown();

    // Unregister our controller.
    if(this.stream?.controller) {

      this.accessory.removeController(this.stream.controller);
    }

    super.cleanup();

    this.isDeleted = true;
  }

  // Handle update-related events from the controller.
  protected eventHandler(packet: ProtectEventPacket): void {

    const payload = packet.payload as ProtectCameraConfigPayload;
    const hasProperty = (properties: string[]): boolean => properties.some(property => property in payload);

    // Process any RTSP stream or video codec updates.
    if(hasProperty(["channels", "videoCodec"])) {

      void this.configureVideoStream();
    }

    // Process motion events.
    if(hasProperty(["lastMotion"])) {

      // We only want to process the motion event if we have either:
      ///
      //  - HKSV recording enabled.
      //  - HKSV recording is disabled and we have smart motion events disabled (or a device without smart motion capabilities) since those are handled elsewhere.
      if(this.stream?.hksv?.isRecording || (!this.stream?.hksv?.isRecording &&
        ((!this.ufp.featureFlags.smartDetectAudioTypes.length && !this.ufp.featureFlags.smartDetectTypes.length) ||
          ((this.ufp.featureFlags.smartDetectAudioTypes.length || this.ufp.featureFlags.smartDetectTypes.length) && !this.hints.smartDetect)))) {

        this.nvr.events.motionEventHandler(this);
      }
    }

    // Process ring events.
    if(hasProperty(["lastRing"])) {

      this.nvr.events.doorbellEventHandler(this, payload.lastRing as number);
    }

    // Process smart detection events that have occurred on a non-realtime basis. Generally, this includes audio and video events that require more analysis by Protect.
    if(this.hints.smartDetect && ((payload as ProtectEventAdd).smartDetectTypes?.length || (payload as ProtectEventAdd).metadata?.detectedThumbnails?.length)) {

      this.nvr.events.motionEventHandler(this, (payload as ProtectEventAdd).smartDetectTypes, (payload as ProtectEventAdd).metadata);
    }

    // Process camera details updates:
    //   - availability state.
    //   - name change.
    //   - camera night vision.
    //   - camera status light.
    //   - camera recording settings.
    if(hasProperty(["isConnected", "ispSettings", "name", "ledSettings", "recordingSettings"])) {

      this.updateDevice();
    }
  }

  // Handle add-related events from the controller.
  protected addEventHandler(packet: ProtectEventPacket): void {

    const payload = packet.payload as ProtectEventAdd;

    // Detect UniFi Access unlock events surfaced in Protect.
    if((packet.header.modelKey === "event") && (payload.metadata?.action === "open_door") && payload.metadata?.openSuccess) {

      const lockService = this.accessory.getServiceById(this.hap.Service.LockMechanism, ProtectReservedNames.LOCK_ACCESS);

      if(!lockService) {

        return;
      }

      lockService.updateCharacteristic(this.hap.Characteristic.LockTargetState, this.hap.Characteristic.LockTargetState.UNSECURED);
      lockService.updateCharacteristic(this.hap.Characteristic.LockCurrentState, this.hap.Characteristic.LockCurrentState.UNSECURED);
      this.log.info("Unlocked.");

      if(this.accessUnlockTimer) {

        clearTimeout(this.accessUnlockTimer);
      }

      this.accessUnlockTimer = setTimeout(() => {

        lockService?.updateCharacteristic(this.hap.Characteristic.LockTargetState, this.hap.Characteristic.LockTargetState.SECURED);
        lockService?.updateCharacteristic(this.hap.Characteristic.LockCurrentState, this.hap.Characteristic.LockCurrentState.SECURED);

        this.accessUnlockTimer = undefined;
      }, 2000);

      return;
    }

    // We're only interested in smart motion detection events.
    if(!this.hints.smartDetect || ((packet.header.modelKey !== "smartDetectObject") &&
      ((packet.header.modelKey !== "event") || !["smartDetectLine", "smartDetectZone"].includes(payload.type) || !payload.smartDetectTypes.length))) {

      return;
    }

    // Process the motion event.
    this.nvr.events.motionEventHandler(this, (packet.header.modelKey === "smartDetectObject") ? [ payload.type ] : payload.smartDetectTypes, payload.metadata);
  }

  // Configure the ambient light sensor for HomeKit.
  private async configureAmbientLightSensor(): Promise<boolean> {

    // Configure the ambient light sensor only if it exists on the camera.
    if(!this.ufp.featureFlags.hasLuxCheck) {

      return false;
    }

    // Acquire the service.
    const service = this.acquireService(this.hap.Service.LightSensor, undefined, undefined, (lightSensorService: Service) => {

      lightSensorService.addOptionalCharacteristic(this.hap.Characteristic.StatusActive);
    });

    // Fail gracefully.
    if(!service) {

      this.log.error("Unable to add ambient light sensor.");

      return false;
    }

    const getLux = async (): Promise<number> => {

      if(!this.isOnline) {

        return -1;
      }

      const response = await this.nvr.ufpApi.retrieve(this.nvr.ufpApi.getApiEndpoint(this.ufp.modelKey) + "/" + this.ufp.id + "/lux");

      if(!response?.ok) {

        return -1;
      }

      try {

        let lux = (await response.json() as Record<string, number>).illuminance ?? -1;

        // The minimum value for ambient light in HomeKit is 0.0001. I have no idea why...but it is. Honor it.
        if(!lux) {

          lux = 0.0001;
        }

        return lux;
      // eslint-disable-next-line @stylistic/keyword-spacing
      } catch {

        // We're intentionally ignoring any errors parsing a response and will fall through.
      }

      return -1;
    };

    // Update the ambient light sensor at regular intervals
    this.ambientLightTimer = setInterval(async () => {

      // Stop updating if we no longer exist.
      if(this.isDeleted) {

        clearInterval(this.ambientLightTimer);

        return;
      }

      // Grab the current ambient light level.
      const lux = await getLux();

      // Nothing to update, we're done.
      if((this.ambientLight === lux) || (lux === -1)) {

        return;
      }

      // Update the sensor.
      service.updateCharacteristic(this.hap.Characteristic.CurrentAmbientLightLevel, this.ambientLight = lux);

      // Publish the state.
      this.publish("ambientlight", this.ambientLight.toString());
    }, 60 * 1000);

    // Retrieve the active state when requested.
    service.getCharacteristic(this.hap.Characteristic.StatusActive)?.onGet(() => this.isOnline);

    // Initialize the sensor.
    this.ambientLight = await getLux();

    if(this.ambientLight === -1) {

      this.ambientLight = 0.0001;
    }

    // Retrieve the current light level when requested.
    service.getCharacteristic(this.hap.Characteristic.CurrentAmbientLightLevel)?.onGet(() => this.ambientLight);

    service.updateCharacteristic(this.hap.Characteristic.CurrentAmbientLightLevel, this.ambientLight);
    service.updateCharacteristic(this.hap.Characteristic.StatusActive, this.isOnline);

    return true;
  }

  // Configure UniFi Access specific features for devices that are made available in Protect.
  private configureAccessFeatures(): boolean {

    // If the Access device doesn't have unlock capabilities, we're done.
    if(!this.ufp.accessDeviceMetadata?.featureFlags?.supportUnlock) {

      return false;
    }

    // Validate whether we should have this service enabled.
    if(!this.validService(this.hap.Service.LockMechanism, this.hasFeature("UniFi.Access.Lock"), ProtectReservedNames.LOCK_ACCESS)) {

      return false;
    }

    // Acquire the service.
    const service = this.acquireService(this.hap.Service.LockMechanism, this.accessoryName, ProtectReservedNames.LOCK_ACCESS);

    // Fail gracefully.
    if(!service) {

      this.log.error("Unable to add lock.");

      return false;
    }

    // Configure the lock current and target state characteristics.
    service.getCharacteristic(this.hap.Characteristic.LockTargetState).onSet(async (value: CharacteristicValue) => {

      // Protect currently only supports unlocking.
      if(value === this.hap.Characteristic.LockTargetState.SECURED) {

        // Let's make sure we revert the lock to it's prior state.
        setTimeout(() => {

          service?.updateCharacteristic(this.hap.Characteristic.LockTargetState, this.hap.Characteristic.LockTargetState.UNSECURED);
          service?.updateCharacteristic(this.hap.Characteristic.LockCurrentState, this.hap.Characteristic.LockCurrentState.UNSECURED);
        }, 50);

        return;
      }

      // Unlock the Access device.
      const response = await this.nvr.ufpApi.retrieve(this.nvr.ufpApi.getApiEndpoint(this.ufp.modelKey) + "/" + this.ufp.id + "/unlock", { method: "POST" });

      if(response?.ok) {

        // Something went wrong, revert to our prior state.
        setTimeout(() => {

          service?.updateCharacteristic(this.hap.Characteristic.LockTargetState, this.hap.Characteristic.LockTargetState.UNSECURED);
          service?.updateCharacteristic(this.hap.Characteristic.LockCurrentState, this.hap.Characteristic.LockCurrentState.UNSECURED);
        }, 50);

        return;
      }
    });

    service.updateCharacteristic(this.hap.Characteristic.LockTargetState, this.hap.Characteristic.LockTargetState.SECURED);
    service.updateCharacteristic(this.hap.Characteristic.LockCurrentState, this.hap.Characteristic.LockCurrentState.SECURED);

    return true;
  }

  // Configure discrete smart motion contact sensors for HomeKit.
  private configureMotionSmartSensor(): boolean {

    // Get any license plates the user has configured for detection, if any.
    this.detectLicensePlate = this.getFeatureValue("Motion.SmartDetect.ObjectSensors.LicensePlate")?.split("-").filter(x => x.length).map(x => x.toUpperCase()) ?? [];

    // Check if we have disabled specific license plate smart motion object contact sensors, and if so, remove them.
    for(const objectService of this.accessory.services.filter(x => x.subtype?.startsWith(ProtectReservedNames.CONTACT_MOTION_SMARTDETECT_LICENSE + "."))) {

      // Do we have smart motion detection as well as license plate telemetry available to us and is this license plate configured? If so, move on.
      if(this.ufp.featureFlags.hasSmartDetect && this.ufp.featureFlags.smartDetectTypes.includes("licensePlate") && objectService.subtype &&
        this.detectLicensePlate.includes(objectService.subtype.slice(objectService.subtype.indexOf(".") + 1))) {

        continue;
      }

      // We don't have this contact sensor enabled, remove it.
      this.accessory.removeService(objectService);
      this.log.info("Disabling smart motion license plate contact sensor: %s.", objectService.subtype?.slice(objectService.subtype?.indexOf(".") + 1));
    }

    // If we don't have smart motion detection available or we have smart motion object contact sensors disabled, let's remove them.
    if(!this.hints.smartDetectSensors) {

      // Check for object-centric contact sensors that are no longer enabled and remove them.
      for(const objectService of this.accessory.services.filter(x => x.subtype?.startsWith(ProtectReservedNames.CONTACT_MOTION_SMARTDETECT + "."))) {

        // We don't have this contact sensor enabled, remove it.
        this.accessory.removeService(objectService);
        this.log.info("Disabling smart motion contact sensor: %s.", objectService.subtype?.slice(objectService.subtype?.indexOf(".") + 1));
      }
    }

    // If we don't have smart motion detection, we're done.
    if(!this.ufp.featureFlags.hasSmartDetect) {

      return false;
    }

    // A utility for us to add contact sensors.
    const addSmartDetectContactSensor = (name: string, serviceId: string, errorMessage: string): boolean => {

      // Acquire the service.
      const service = this.acquireService(this.hap.Service.ContactSensor, name, serviceId);

      // Fail gracefully.
      if(!service) {

        this.log.error(errorMessage);

        return false;
      }

      // Initialize the sensor.
      service.updateCharacteristic(this.hap.Characteristic.ContactSensorState, this.hap.Characteristic.ContactSensorState.CONTACT_DETECTED);

      return true;
    };

    let enabledContactSensors = [];

    // Add individual contact sensors for each object detection type, if needed.
    if(this.hints.smartDetectSensors) {

      for(const smartDetectType of [...this.ufp.featureFlags.smartDetectAudioTypes, ...this.ufp.featureFlags.smartDetectTypes].sort()) {

        if(addSmartDetectContactSensor(this.accessoryName + " " + toCamelCase(smartDetectType),
          ProtectReservedNames.CONTACT_MOTION_SMARTDETECT + "." + smartDetectType, "Unable to add smart motion contact sensor for " + smartDetectType + " detection.")) {

          enabledContactSensors.push(smartDetectType);
        }
      }

      this.log.info("Smart motion contact sensor%s enabled: %s.", enabledContactSensors.length > 1 ? "s" : "", enabledContactSensors.join(", "));
    }

    enabledContactSensors = [];

    // Now process license plate contact sensors for individual detections.
    if(this.ufp.featureFlags.smartDetectTypes.includes("licensePlate")) {

      // Get the list of plates.
      for(const licenseOption of this.detectLicensePlate.filter(plate => plate.length)) {

        if(addSmartDetectContactSensor(this.accessoryName + " License Plate " + licenseOption,
          ProtectReservedNames.CONTACT_MOTION_SMARTDETECT_LICENSE + "." + licenseOption,
          "Unable to add smart motion license plate contact sensor for " + licenseOption + ".")) {

          enabledContactSensors.push(licenseOption);
        }
      }

      if(enabledContactSensors.length) {

        this.log.info("Smart motion license plate contact sensor%s enabled: %s.", enabledContactSensors.length > 1 ? "s" : "", enabledContactSensors.join(", "));
      }
    }

    return true;
  }

  // Configure a switch to manually trigger a doorbell ring event for HomeKit.
  private configureDoorbellTrigger(): boolean {

    // See if we have a doorbell service configured.
    let doorbellService = this.accessory.getService(this.hap.Service.Doorbell);

    // Validate whether we should have this service enabled.
    if(!this.validService(this.hap.Service.Switch, this.hasFeature("Doorbell.Trigger"), ProtectReservedNames.SWITCH_DOORBELL_TRIGGER)) {

      // Since we aren't enabling the doorbell trigger on this camera, remove the doorbell service if the camera isn't actually doorbell-capable hardware.
      if(!this.ufp.featureFlags.isDoorbell && doorbellService) {

        this.accessory.removeService(doorbellService);
      }

      return false;
    }

    // We don't have a doorbell service configured, but since we've enabled a doorbell switch, we create the doorbell for automation purposes.
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

    // Add the switch to the camera, if needed.
    const triggerService = this.acquireService(this.hap.Service.Switch, this.accessoryName + " Doorbell Trigger", ProtectReservedNames.SWITCH_DOORBELL_TRIGGER);

    // Fail gracefully.
    if(!triggerService) {

      this.log.error("Unable to add the doorbell trigger.");

      return false;
    }

    // Trigger the doorbell.
    triggerService.getCharacteristic(this.hap.Characteristic.On)?.onGet(() => {

      return this.isRinging;
    });

    triggerService.getCharacteristic(this.hap.Characteristic.On)?.onSet((value: CharacteristicValue) => {

      if(value) {

        // Trigger the ring event.
        this.nvr.events.doorbellEventHandler(this, Date.now());
        this.log.info("Doorbell ring event triggered.");

      } else {

        // If the doorbell ring event is still going, we should be as well.
        if(this.isRinging) {

          setTimeout(() => triggerService?.updateCharacteristic(this.hap.Characteristic.On, true), 50);
        }
      }
    });

    // Initialize the switch.
    triggerService.updateCharacteristic(this.hap.Characteristic.On, false);

    this.log.info("Enabling doorbell automation trigger.");

    return true;
  }

  // Configure the doorbell service for HomeKit.
  protected configureVideoDoorbell(): boolean {

    // Acquire the service.
    const service = this.acquireService(this.hap.Service.Doorbell);

    // Fail gracefully.
    if(!service) {

      this.log.error("Unable to add doorbell.");

      return false;
    }

    // Add the doorbell service to this Protect doorbell. HomeKit requires the doorbell service to be marked as the primary service on the accessory.
    service.setPrimaryService(true);

    return true;
  }

  // Configure additional camera-specific characteristics for HomeKit.
  private configureCameraDetails(): boolean {

    // Find the service, if it exists.
    const service = this.accessory.getService(this.hap.Service.CameraOperatingMode);

    // Retrieve the camera status light if we have it enabled.
    const statusLight = service?.getCharacteristic(this.hap.Characteristic.CameraOperatingModeIndicator);

    if(!this.isHksvCapable || !this.hints.ledStatus) {

      if(statusLight) {

        service?.removeCharacteristic(statusLight);
      }
    } else {

      // Turn the status light on or off.
      statusLight?.onGet(() => this.statusLed);
      statusLight?.onSet(async (value: CharacteristicValue) => this.setStatusLed(!!value));

      // Initialize the status light state.
      service?.updateCharacteristic(this.hap.Characteristic.CameraOperatingModeIndicator, this.statusLed);
    }

    // Retrieve the night vision indicator if we have it enabled.
    const nightVision = service?.getCharacteristic(this.hap.Characteristic.NightVision);

    if(!this.isHksvCapable || !this.hints.nightVision) {

      if(nightVision) {

        service?.removeCharacteristic(nightVision);
      }
    } else {

      service?.getCharacteristic(this.hap.Characteristic.NightVision)?.onGet(() => this.nightVision);
      service?.getCharacteristic(this.hap.Characteristic.NightVision)?.onSet(async (value: CharacteristicValue) => {

        // Update the night vision setting in Protect.
        const newUfp = await this.nvr.ufpApi.updateDevice(this.ufp, { ispSettings: { irLedMode: value ? "auto" : "off" } });

        if(!newUfp) {

          this.log.error("Unable to set night vision to %s. Please ensure this username has the Administrator role in UniFi Protect.", value ? "auto" : "off");

          setTimeout(() => service?.updateCharacteristic(this.hap.Characteristic.NightVision, !value), 50);

          return;
        }

        // Update our internal view of the device configuration.
        this.ufp = newUfp;
      });

      // Initialize the status light state.
      service?.updateCharacteristic(this.hap.Characteristic.NightVision, this.nightVision);
    }

    return true;
  }

  // Configure cropping characteristics.
  private configureCrop(): boolean {

    // We haven't enabled cropping.
    if(!this.hints.crop) {

      return true;
    }

    // Set our cropping parameters.
    this.hints.cropOptions = {

      height: this.getFeatureNumber("Video.Crop.Height") ?? 100,
      width: this.getFeatureNumber("Video.Crop.Width") ?? 100,
      x: this.getFeatureNumber("Video.Crop.X") ?? 0,
      y: this.getFeatureNumber("Video.Crop.Y") ?? 0
    };

    // Ensure we have sane values for our crop window.
    if((this.hints.cropOptions.height < 0) || (this.hints.cropOptions.height > 100)) {

      this.hints.cropOptions.height = 100;
    }

    if((this.hints.cropOptions.width < 0) || (this.hints.cropOptions.width > 100)) {

      this.hints.cropOptions.width = 100;
    }

    if((this.hints.cropOptions.x < 0) || (this.hints.cropOptions.x > 100)) {

      this.hints.cropOptions.x = 0;
    }

    if((this.hints.cropOptions.y < 0) || (this.hints.cropOptions.y > 100)) {

      this.hints.cropOptions.y = 0;
    }

    // Inform the user.
    this.log.info("Cropping the video stream to %sx%s% starting at %sx%s%.",
      this.hints.cropOptions.width, this.hints.cropOptions.height, this.hints.cropOptions.x, this.hints.cropOptions.y);

    // Transform our percentages into decimal form for FFmpeg.
    this.hints.cropOptions.height /= 100;
    this.hints.cropOptions.width /= 100;
    this.hints.cropOptions.x /= 100;
    this.hints.cropOptions.y /= 100;

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

    // Figure out which camera channels are RTSP-enabled, and user-enabled. We also filter out any package camera entries. We deal with those independently elsewhere.
    const cameraChannels = this.ufp.channels.filter(channel => channel.isRtspEnabled && (channel.name !== "Package Camera"));

    // Set the camera and shapshot URLs.
    const cameraUrl = "rtsps://" + (this.nvr.config.overrideAddress ?? this.ufp.connectionHost ?? this.nvr.ufp.host) + ":" + this.nvr.ufp.ports.rtsps.toString() + "/";

    // No RTSP streams are available that meet our criteria - we're done.
    if(!cameraChannels.length) {

      this.log.info("No RTSP profiles found for this camera. " +
        "Enable at least one RTSP profile in the UniFi Protect webUI or assign an admin role to the local Protect user you configured for use with this plugin.");

      return false;
    }

    // Now that we have our RTSP streams, create a list of supported resolutions for HomeKit.
    for(const channel of cameraChannels) {

      // Sanity check in case Protect reports nonsensical resolutions.
      if(!channel.name || (channel.width <= 0) || (channel.width > 65535) || (channel.height <= 0) || (channel.height > 65535)) {

        continue;
      }

      rtspEntries.push({

        channel: channel,
        name: this.getResolution([channel.width, channel.height, channel.fps]) + " (" + channel.name + ") [" +
          (this.ufp.videoCodec.replace("h265", "hevc")).toUpperCase() + "]",
        resolution: [ channel.width, channel.height, channel.fps ],
        url: cameraUrl + channel.rtspAlias + "?enableSrtp"
      });
    }

    // Sort the list of resolutions, from high to low.
    rtspEntries.sort(this.sortByResolutions.bind(this));

    let validResolutions = [];

    // Next, ensure we have mandatory resolutions required by HomeKit, as well as special support for Apple TV and Apple Watch, while respecting aspect ratios.
    // We use the frame rate of the first entry, which should be our highest resolution option that's native to the camera as the upper bound for frame rate.
    //
    // Our supported resolutions range from 4K through 320p.
    if((rtspEntries[0].resolution[0] / rtspEntries[0].resolution[1]) === (4 / 3)) {

      validResolutions = [

        [ 3840, 2880 ], [ 2560, 1920 ],
        [ 1920, 1440 ], [ 1280, 960 ],
        [ 640, 480 ], [ 480, 360 ],
        [ 320, 240 ]
      ];
    } else {

      validResolutions = [

        [ 3840, 2160 ], [ 2560, 1440 ],
        [ 1920, 1080 ], [ 1280, 720 ],
        [ 640, 360 ], [ 480, 270 ],
        [ 320, 180 ]
      ];
    }

    // Generate a list of valid resolutions that support both 30 and 15fps.
    validResolutions = validResolutions.flatMap(([ width, height ]) => [ 30, 15 ].map(fps => [ width, height, fps ]));

    // Validate and add our entries to the list of what we make available to HomeKit. We map these resolutions to the channels we have available to us on the camera.
    for(const entry of validResolutions) {

      // This resolution is larger than the highest resolution on the camera, natively. We make an exception for 1080p and 720p resolutions since HomeKit explicitly
      // requires them.
      if((entry[0] >= rtspEntries[0].resolution[0]) && ![ 1920, 1280 ].includes(entry[0])) {

        continue;
      }

      // Find the closest RTSP match for this resolution.
      const foundRtsp = this.findRtsp(entry[0], entry[1], { rtspEntries: rtspEntries });

      if(!foundRtsp) {

        continue;
      }

      // We already have this resolution in our list.
      if(rtspEntries.some(x => (x.resolution[0] === entry[0]) && (x.resolution[1] === entry[1]) && (x.resolution[2] === foundRtsp.channel.fps))) {

        continue;
      }

      // Add the resolution to the list of supported resolutions, but use the selected camera channel's native frame rate.
      rtspEntries.push({ channel: foundRtsp.channel, name: foundRtsp.name, resolution: [ entry[0], entry[1], foundRtsp.channel.fps ], url: foundRtsp.url });

      // Since we added resolutions to the list, resort resolutions, from high to low.
      rtspEntries.sort(this.sortByResolutions.bind(this));
    }

    // Ensure we've got at least one entry that can be used for HomeKit Secure Video. Some Protect cameras (e.g. G3 Flex) don't have a native frame rate that maps to
    // HomeKit's specific requirements for event recording, so we ensure there's at least one. This doesn't directly affect which stream is used to actually record
    // something, but it does determine whether HomeKit even attempts to use the camera for HomeKit Secure Video.
    if(![15, 24, 30].includes(rtspEntries[0].resolution[2])) {

      // Iterate through the list of RTSP entries we're providing to HomeKit and ensure we have at least one that will meet HomeKit's requirements for frame rate.
      for(let i = 0; i < rtspEntries.length; i++) {

        // We're only interested in the first 1080p or 1440p entry.
        if((rtspEntries[i].resolution[0] !== 1920) || ![ 1080, 1440 ].includes(rtspEntries[i].resolution[1])) {

          continue;
        }

        // Determine the best frame rate to use that's closest to what HomeKit wants to see.
        if(rtspEntries[i].resolution[2] > 24) {

          rtspEntries[i].resolution[2] = 30;
        } else if(rtspEntries[i].resolution[2] > 15) {

          rtspEntries[i].resolution[2] = 24;
        } else {

          rtspEntries[i].resolution[2] = 15;
        }

        break;
      }
    }

    // Publish our updated list of supported resolutions and their URLs.
    this.rtspEntries = rtspEntries;

    // If we've already configured the HomeKit video streaming delegate, we're done here.
    if(this.stream) {

      return true;
    }

    // Inform users about our RTSP entry mapping, if we're debugging.
    if(this.hasFeature("Debug.Video.Startup")) {

      for(const entry of this.rtspEntries) {

        this.log.info("Mapping resolution: %s.", this.getResolution(entry.resolution) + " => " + entry.name);
      }
    }

    // Check for explicit RTSP profile preferences.
    for(const rtspProfile of [ "LOW", "MEDIUM", "HIGH" ]) {

      // Check to see if the user has requested a specific streaming profile for this camera.
      if(this.hasFeature("Video.Stream.Only." + rtspProfile)) {

        this.hints.streamingDefault = rtspProfile;
      }

      // Check to see if the user has requested a specific recording profile for this camera.
      if(this.hasFeature("Video.HKSV.Record.Only." + rtspProfile)) {

        this.hints.recordingDefault = rtspProfile;
      }
    }

    // Inform the user if we've set a streaming default.
    if(this.hints.streamingDefault) {

      this.log.info("Video streaming configured to use only: %s.", toCamelCase(this.hints.streamingDefault.toLowerCase()));
    }

    // Inform the user if they've selected the legacy snapshot API.
    if(!this.hints.highResSnapshots) {

      this.log.info("Disabling the use of higher quality snapshots.");
    }

    // Configure the video stream with our resolutions.
    this.stream = new ProtectStreamingDelegate(this, this.rtspEntries.map(x => x.resolution));

    // If the user hasn't overriden our defaults, make sure we account for constrained hardware environments.
    if(!this.hints.recordingDefault) {

      switch(this.platform.codecSupport.hostSystem) {

        case "raspbian":

          // For constrained CPU environments like Raspberry Pi, we default to recording from the highest quality channel we can, that's at or below 1080p. That provides
          // a reasonable default, while still allowing users who really want to, to be able to specify something else.
          this.hints.recordingDefault = (this.findRtsp(1920, 1080, { maxPixels: this.stream.ffmpegOptions.hostSystemMaxPixels })?.channel.name ?? undefined) as string;

          break;

        default:

          // We default to no preference for the default Protect camera channel.
          this.hints.recordingDefault = (this.hints.hardwareTranscoding ? "High" : undefined) as string;

          break;
      }
    } else {

      // Inform the user if we've set a recording default.
      this.log.info("HomeKit Secure Video event recording configured to use only: %s.", toCamelCase(this.hints.recordingDefault.toLowerCase()));
    }

    // Fire up the controller and inform HomeKit about it.
    this.accessory.configureController(this.stream.controller);

    return true;
  }

  // Configure HomeKit Secure Video support.
  private configureHksv(): boolean {

    // If we've enabled RTSP-based HKSV recording, warn that this is unsupported.
    if(this.hasFeature("Debug.Video.HKSV.UseRtsp")) {

      this.log.warn("Enabling RTSP-based HKSV events are for debugging purposes only and unsupported." +
        " It consumes more resources on both the Protect controller and the system running HBUP.");
    }

    // If we have smart motion events enabled, let's warn the user that things will not work quite the way they expect.
    if(this.isHksvCapable && this.hints.smartDetect) {

      this.log.warn("WARNING: Smart motion detection and HomeKit Secure Video provide overlapping functionality. " +
        "Only HomeKit Secure Video, when event recording is enabled in the Home app, will be used to trigger motion event notifications for this camera." +
        (this.hints.smartDetectSensors ? " Smart motion contact sensors will continue to function using telemetry from UniFi Protect." : ""));
    }

    return true;
  }

  // Configure a switch to manually enable or disable HKSV recording for a camera.
  private configureHksvRecordingSwitch(): boolean {

    // Validate whether we should have this service enabled.
    if(!this.validService(this.hap.Service.Switch, this.hasFeature("Video.HKSV.Recording.Switch"), ProtectReservedNames.SWITCH_HKSV_RECORDING)) {

      // We want to default this back to recording whenever we disable the recording switch.
      this.accessory.context.hksvRecording = true;

      return false;
    }

    // Acquire the service.
    const service = this.acquireService(this.hap.Service.Switch, this.accessoryName + " HKSV Recording", ProtectReservedNames.SWITCH_HKSV_RECORDING);

    // Fail gracefully.
    if(!service) {

      this.log.error("Unable to add HKSV recording switch.");

      return false;
    }

    // Activate or deactivate HKSV recording.
    service.getCharacteristic(this.hap.Characteristic.On)?.onGet(() => {

      return this.accessory.context.hksvRecording as boolean ?? true;
    });

    service.getCharacteristic(this.hap.Characteristic.On)?.onSet((value: CharacteristicValue) => {

      if(this.accessory.context.hksvRecording !== value) {

        this.log.info("HKSV event recording %s.", value ? "enabled" : "disabled");
      }

      this.accessory.context.hksvRecording = !!value;
    });

    // Initialize the switch.
    service.updateCharacteristic(this.hap.Characteristic.On, this.accessory.context.hksvRecording as boolean);

    this.log.info("Enabling HKSV recording switch.");

    return true;
  }

  // Configure a dimmer to turn on or off the night vision capabilities for HomeKit.
  private configureNightVisionDimmer(): boolean {

    // Validate whether we should have this service enabled.
    if(!this.validService(this.hap.Service.Lightbulb, this.ufp.featureFlags.hasInfrared && this.ufp.featureFlags.hasIcrSensitivity &&
      this.hasFeature("Device.NightVision.Dimmer"), ProtectReservedNames.LIGHTBULB_NIGHTVISION)) {

      return false;
    }

    // Acquire the service.
    const service = this.acquireService(this.hap.Service.Lightbulb, this.accessoryName + " Night Vision", ProtectReservedNames.LIGHTBULB_NIGHTVISION);

    // Fail gracefully.
    if(!service) {

      this.log.error("Unable to add the night vision dimmer.");

      return false;
    }

    // Adjust night vision capabilities.
    service.getCharacteristic(this.hap.Characteristic.On)?.onGet(() => this.nightVision);

    service.getCharacteristic(this.hap.Characteristic.On)?.onSet(async (value: CharacteristicValue) => {

      if(this.nightVision !== value) {

        this.log.info("Night vision %s.", value ? "enabled" : "disabled");
      }

      const mode = service.getCharacteristic(this.hap.Characteristic.Brightness).value === 10 ? "auto" : "custom";

      // Update the night vision setting in Protect.
      const newUfp = await this.nvr.ufpApi.updateDevice(this.ufp, { ispSettings: { irLedMode: value ? mode : "off" } });

      if(!newUfp) {

        this.log.error("Unable to set night vision to %s. Please ensure this username has the Administrator role in UniFi Protect.", value ? "custom" : "off");

        setTimeout(() => service?.updateCharacteristic(this.hap.Characteristic.On, !value), 50);

        return;
      }

      // Update our internal view of the device configuration.
      this.ufp = newUfp;
    });

    // Adjust the sensitivity of night vision.
    service.getCharacteristic(this.hap.Characteristic.Brightness)?.onGet(() => this.nightVisionBrightness);

    service.getCharacteristic(this.hap.Characteristic.Brightness)?.onSet(async (value: CharacteristicValue) => {

      let level = value as number;
      let nightvision = {};

      // If we're less than 10% in brightness, assume we want to disable night vision.
      if(level < 10) {

        level = 0;
      }

      // If we're greater than 10%, but less than 20%, assume we want to set night vision to auto.
      if((level > 10) && (level < 20)) {

        level = 10;
      }

      // If we're more than 90% in brightness, assume we want to force night vision to be always on.
      if(level > 90) {

        level = 100;
      }

      // Let's determine what we're setting on the Protect device.
      switch(level) {

        case 0:

          nightvision = { ispSettings:{ irLedMode: "off" } };

          break;

        case 10:

          nightvision = { ispSettings:{ irLedMode: "auto" } };

          break;

        case 100:

          nightvision = { ispSettings:{ irLedMode: "on" } };

          break;

        default:

          level = Math.round((level - 20) / 7);
          nightvision = { ispSettings:{ icrCustomValue: level, irLedMode: "custom" } };
          level = (level * 7) + 20;

          break;
      }

      const newUfp = await this.nvr.ufpApi.updateDevice(this.ufp, nightvision);

      if(!newUfp) {

        this.log.error("Unable to adjust night vision settings. Please ensure this username has the Administrator role in UniFi Protect.");

        return;
      }

      // Set the context to our updated device configuration.
      this.ufp = newUfp;

      // Make sure we properly reflect what brightness we're actually at, given the differences in setting granularity between Protect and HomeKit.
      setTimeout(() => service?.updateCharacteristic(this.hap.Characteristic.Brightness, level), 50);
    });

    // Initialize the dimmer state.
    service.updateCharacteristic(this.hap.Characteristic.On, this.nightVision);
    service.updateCharacteristic(this.hap.Characteristic.Brightness, this.nightVisionBrightness);

    this.log.info("Enabling night vision dimmer.");

    return true;
  }

  // Configure a series of switches to manually enable or disable recording on the UniFi Protect controller for a camera.
  private configureNvrRecordingSwitch(): boolean {

    const switchesEnabled = [];

    // The Protect controller supports three modes for recording on a camera: always, detections, and never. We create switches for each of the modes.
    for(const ufpRecordingSwitchType of
      [  ProtectReservedNames.SWITCH_UFP_RECORDING_ALWAYS, ProtectReservedNames.SWITCH_UFP_RECORDING_DETECTIONS, ProtectReservedNames.SWITCH_UFP_RECORDING_NEVER ]) {

      const ufpRecordingSetting = ufpRecordingSwitchType.slice(ufpRecordingSwitchType.lastIndexOf(".") + 1);

      // Validate whether we should have this service enabled.
      if(!this.validService(this.hap.Service.Switch, this.hasFeature("Nvr.Recording.Switch"), ufpRecordingSwitchType)) {

        continue;
      }

      const switchName = this.accessoryName + " UFP Recording " + toCamelCase(ufpRecordingSetting);

      // Acquire the service.
      const service = this.acquireService(this.hap.Service.Switch, switchName, ufpRecordingSwitchType);

      // Fail gracefully.
      if(!service) {

        this.log.error("Unable to add UniFi Protect recording switches.");

        continue;
      }

      // Activate or deactivate the appropriate recording mode on the Protect controller.
      service.getCharacteristic(this.hap.Characteristic.On)?.onGet(() => {

        return this.ufp.recordingSettings.mode === ufpRecordingSetting;
      });

      service.getCharacteristic(this.hap.Characteristic.On)?.onSet(async (value: CharacteristicValue) => {

        // We only want to do something if we're being activated. Turning off the switch would really be an undefined state given that there are three different
        // settings one can choose from. Instead, we do nothing and leave it to the user to choose what state they really want to set.
        if(!value) {

          setTimeout(() => this.updateDevice(), 50);

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
      service.updateCharacteristic(this.hap.Characteristic.On, this.ufp.recordingSettings.mode === ufpRecordingSetting);
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
    this.subscribeGet("rtsp", "RTSP information", (): string => {

      // Grab all the available RTSP channels and return them as a JSON.
      return JSON.stringify(Object.assign({}, ...this.ufp.channels.filter(channel => channel.isRtspEnabled)
        .map(channel => ({ [channel.name]: "rtsps://" + (this.nvr.config.overrideAddress ?? this.ufp.connectionHost ?? this.nvr.ufp.host) + ":" +
          this.nvr.ufp.ports.rtsp + "/" + channel.rtspAlias + "?enableSrtp" }))));
    });

    // Trigger snapshots when requested.
    this.subscribeSet("snapshot", "snapshot trigger", (value: string) => {

      // When we get the right message, we trigger the snapshot request.
      if(value !== "true") {

        return;
      }

      void this.stream?.handleSnapshotRequest();
    });

    // Enable doorbell-specific MQTT capabilities only when we have a Protect doorbell or a doorbell trigger enabled.
    if(this.ufp.featureFlags.isDoorbell || this.hasFeature("Doorbell.Trigger")) {

      // Trigger doorbell when requested.
      this.subscribeSet("doorbell", "doorbell ring trigger", (value: string) => {

        // When we get the right message, we trigger the doorbell request.
        if(value !== "true") {

          return;
        }

        this.nvr.events.doorbellEventHandler(this, Date.now());
      });
    }

    return true;
  }

  // Refresh camera-specific characteristics.
  public updateDevice(): boolean {

    // Update the camera state.
    this.accessory.getService(this.hap.Service.MotionSensor)?.updateCharacteristic(this.hap.Characteristic.StatusActive, this.isOnline);
    this.accessory.getService(this.hap.Service.LightSensor)?.updateCharacteristic(this.hap.Characteristic.StatusActive, this.isOnline);

    // Check to see if this device has a status light.
    if(this.hints.ledStatus) {

      this.accessory.getService(this.hap.Service.CameraOperatingMode)?.updateCharacteristic(this.hap.Characteristic.CameraOperatingModeIndicator, this.statusLed);
    }

    // Check to see if this device has a status light.
    if(this.hints.nightVision) {

      this.accessory.getService(this.hap.Service.CameraOperatingMode)?.updateCharacteristic(this.hap.Characteristic.NightVision, this.nightVision);
    }

    if(this.hasFeature("Device.NightVision.Dimmer")) {

      this.accessory.getServiceById(this.hap.Service.Lightbulb, ProtectReservedNames.LIGHTBULB_NIGHTVISION)?.
        updateCharacteristic(this.hap.Characteristic.On, this.nightVision);

      this.accessory.getServiceById(this.hap.Service.Lightbulb, ProtectReservedNames.LIGHTBULB_NIGHTVISION)?.
        updateCharacteristic(this.hap.Characteristic.Brightness, this.nightVisionBrightness);
    }

    // Update the status indicator light switch.
    if(this.hasFeature("Device.StatusLed.Switch")) {

      this.accessory.getServiceById(this.hap.Service.Switch, ProtectReservedNames.SWITCH_STATUS_LED)?.
        updateCharacteristic(this.hap.Characteristic.On, this.statusLed);
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

  // Find an RTSP configuration for a given target resolution.
  private findRtspEntry(width: number, height: number, options?: RtspOptions): Nullable<RtspEntry> {

    const rtspEntries = options?.rtspEntries ?? this.rtspEntries;

    // No RTSP entries to choose from, we're done.
    if(!rtspEntries || !rtspEntries.length) {

      return null;
    }

    // Second, we check to see if we've set an explicit preference for stream quality.
    if(options?.default) {

      options.default = options.default.toUpperCase();

      return rtspEntries.find(x => x.channel.name.toUpperCase() === options.default) ?? null;
    }

    // See if we have a match for our desired resolution on the camera. We ignore FPS - HomeKit clients seem to be able to handle it just fine.
    const exactRtsp = rtspEntries.find(x => (x.channel.width === width) && (x.channel.height === height));

    if(exactRtsp) {

      return exactRtsp;
    }

    // If we haven't found an exact match, by default, we bias ourselves to the next lower resolution we find or the lowest resolution we have available as a backstop.
    if(!options?.biasHigher) {

      return rtspEntries.find(x => x.channel.width < width) ?? rtspEntries[rtspEntries.length - 1];
    }

    // If we're biasing ourselves toward higher resolutions (primarily used when transcoding so we start with a higher quality input), we look for the first entry that's
    // larger than our requested width and if not found, we return the highest resolution we have available.
    return rtspEntries.filter(x => x.channel.width > width).pop() ?? rtspEntries[0];
  }

  // Find a streaming RTSP configuration for a given target resolution.
  public findRtsp(width: number, height: number, options?: RtspOptions): Nullable<RtspEntry> {

    // Create our options JSON if needed.
    options = options ?? {};

    // Set our default stream, if we've configured one.
    options.default = this.hints.streamingDefault;

    // See if we've been given RTSP entries or whether we should default to our own.
    options.rtspEntries = options.rtspEntries ?? this.rtspEntries;

    // If we've imposed a constraint on the maximum dimensions of what we want due to a hardware limitation, filter out those entries.
    if(options.maxPixels !== undefined) {

      options.rtspEntries = options.rtspEntries.filter(x => (x.channel.width * x.channel.height) <= (options.maxPixels ?? Infinity));
    }

    return this.findRtspEntry(width, height, options);
  }

  // Find a recording RTSP configuration for a given target resolution.
  public findRecordingRtsp(width: number, height: number): Nullable<RtspEntry> {

    return this.findRtspEntry(width, height, { biasHigher: true, default: this.hints.recordingDefault });
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
  protected getResolution(resolution: Resolution): string {

    return resolution[0].toString() + "x" + resolution[1].toString() + "@" + resolution[2].toString() + "fps";
  }

  // Utility property to return whether the camera is HKSV capable or not.
  public get isHksvCapable(): boolean {

    return (!this.ufp.isThirdPartyCamera && !this.ufp.isAdoptedByAccessApp) || (this.ufp.isThirdPartyCamera && this.ufp.isPairedWithAiPort);
  }

  // Utility property to return the current night vision state of a camera. It's a blunt instrument due to HomeKit constraints.
  private get nightVision(): boolean {

    return (this.ufp as ProtectCameraConfig)?.ispSettings?.irLedMode !== "off";
  }

  // Utility property to return the current night vision state of a camera, mapped to a brightness characteristic.
  private get nightVisionBrightness(): number {

    switch(this.ufp.ispSettings.irLedMode) {

      case "off":

        return 0;

      case "auto":
        return 10;

      case "on":

        return 100;

      case "custom":

        // The Protect infrared cutoff removal setting ranges from 0 - 10. HomeKit expects percentages, so we convert it like so.
        return (this.ufp.ispSettings.icrCustomValue * 7) + 20;

      default:

        this.log.error("Unknown night vision value detected.");

        return 0;
    }
  }
}
