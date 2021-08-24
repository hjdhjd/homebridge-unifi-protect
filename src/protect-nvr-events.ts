/* Copyright(C) 2017-2021, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-nvr-events.ts: NVR device class for UniFi Protect.
 */
import {
  API,
  HAP,
  Logging,
  PlatformAccessory,
  Service
} from "homebridge";
import {
  PROTECT_CONTACT_MOTION_SMARTDETECT,
  PROTECT_SWITCH_DOORBELL_TRIGGER,
  PROTECT_SWITCH_MOTION_TRIGGER
} from "./protect-camera";
import {
  ProtectApiUpdates,
  ProtectNvrUpdatePayloadCameraUpdate,
  ProtectNvrUpdatePayloadEventAdd
} from "unifi-protect";
import {
  ProtectCameraConfig,
  ProtectCameraLcdMessagePayload,
  ProtectNvrSystemEvent
} from "unifi-protect";
import { ProtectApi } from "unifi-protect";
import { ProtectDoorbell } from "./protect-doorbell";
import { ProtectNvr } from "./protect-nvr";
import { ProtectPlatform } from "./protect-platform";

export class ProtectNvrEvents {
  private api: API;
  private debug: (message: string, ...parameters: unknown[]) => void;
  private hap: HAP;
  private lastMotion: { [index: string]: number };
  private lastRing: { [index: string]: number };
  private log: Logging;
  private motionDuration: number;
  private nvr: ProtectNvr;
  private readonly eventTimers: { [index: string]: NodeJS.Timeout };
  private nvrApi: ProtectApi;
  private platform: ProtectPlatform;
  private unsupportedDevices: { [index: string]: boolean };

  constructor(nvr: ProtectNvr) {

    this.api = nvr.platform.api;
    this.debug = nvr.platform.debug.bind(nvr.platform);
    this.hap = nvr.platform.api.hap;
    this.lastMotion = {};
    this.lastRing = {};
    this.log = nvr.platform.log;
    this.nvr = nvr;
    this.nvrApi = nvr.nvrApi;
    this.motionDuration = nvr.platform.config.motionDuration;
    this.eventTimers = {};
    this.platform = nvr.platform;
    this.unsupportedDevices = {};
  }

  // Check for event updates.
  public update(): boolean {

    // Configure the updates API listener, if needed. This needs to be called
    // regularly because the connection to the update events websocket can be shutdown and reopened.
    this.configureUpdatesListener();

    return true;
  }

  // Configure the realtime system event API listener to trigger events on accessories, like motion.
  // This is now deprecated in favor of the realtime updates event API, which provides for more event types
  // than the realtime system events API.
  private configureSystemEventListener(): boolean {

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
      const foundCamera = Object.keys(this.nvr.configuredCameras).find(x =>
        (this.nvr.configuredCameras[x].accessory.context.camera as ProtectCameraConfig).host === controller.info.lastMotionCameraAddress);

      // Nothing here - we may have disabled this camera or it's associated NVR.
      if(!foundCamera) {
        return;
      }

      // Now grab the accessory associated with the Protect device.
      const accessory = this.nvr.configuredCameras[foundCamera].accessory;

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

    // Only configure the event listener if it exists and it's not already configured.
    if(!this.nvrApi.eventListener || this.nvrApi.eventListenerConfigured) {
      return true;
    }

    // Listen for any messages coming in from our listener.
    this.nvrApi.eventListener.on("message", (event: Buffer) => {

      const updatePacket = ProtectApiUpdates.decodeUpdatePacket(this.log, event);

      if(!updatePacket) {
        this.log.error("%s: Unable to process message from the realtime update events API.", this.nvrApi.getNvrName());
        return;
      }

      // The update actions that we care about (doorbell rings, motion detection) look like this:
      //
      // action: "update"
      // id: "someCameraId"
      // modelKey: "camera"
      // newUpdateId: "ignorethis"
      //
      // The payloads are what differentiate them - one updates lastMotion and the other lastRing.
      switch(updatePacket.action.modelKey) {

        case "camera": {

          // We listen for the following camera update actions:
          //   doorbell LCD updates
          //   doorbell rings
          //   motion detection

          // We're only interested in update actions.
          if(updatePacket.action.action !== "update") {
            return;
          }

          // Grab the right payload type, camera update payloads.
          const payload = updatePacket.payload as ProtectNvrUpdatePayloadCameraUpdate;

          // Now filter out payloads we aren't interested in. We only want motion detection and doorbell rings for now.
          if(!payload.isMotionDetected && !payload.lastRing && !payload.lcdMessage) {
            return;
          }

          // Lookup the accessory associated with this camera.
          const accessory = this.nvr.accessoryLookup(updatePacket.action.id);

          // We don't know about this camera - we're done.
          if(!accessory) {
            return;
          }

          // Grab the camera context.
          const camera = accessory.context.camera as ProtectCameraConfig;

          // Lookup the ProtectCamera instance associated with this accessory.
          const protectCamera = this.nvr.configuredCameras[accessory.UUID];

          if(!protectCamera) {
            return;
          }

          // It's a motion event - process it accordingly, but only if we're not configured for smart motion events - we handle those elsewhere.
          if(payload.isMotionDetected) {

            if(!protectCamera.smartDetectTypes.length && payload.lastMotion && this.nvr.optionEnabled(camera, "Motion.NvrEvents", true)) {

              this.motionEventHandler(accessory, payload.lastMotion);
            }
          }

          // It's a ring event - process it accordingly.
          if(payload.lastRing && this.nvr.optionEnabled(camera, "Doorbell.NvrEvents", true)) {

            this.doorbellEventHandler(accessory, payload.lastRing);
          }

          // It's a doorbell LCD message event - process it accordingly.
          if(payload.lcdMessage) {

            this.lcdMessageEventHandler(accessory, payload.lcdMessage);
          }

          break;
        }

        case "event": {

          // We listen for the following event actions:
          //   smart motion detection

          // We're only interested in add events.
          if(updatePacket.action.action !== "add") {
            return;
          }

          // Grab the right payload type, for event add payloads.
          const payload = updatePacket.payload as ProtectNvrUpdatePayloadEventAdd;

          // We're only interested in smart motion detection events.
          if(payload.type !== "smartDetectZone") {
            return;
          }

          // Lookup the accessory associated with this camera.
          const accessory = this.nvr.accessoryLookup(payload.camera);

          // We don't know about this camera - we're done.
          if(!accessory) {
            return;
          }

          // Grab the camera context.
          const camera = accessory.context.camera as ProtectCameraConfig;

          // Lookup the ProtectCamera instance associated with this accessory.
          const protectCamera = this.nvr.configuredCameras[accessory.UUID];

          if(!protectCamera) {
            return;
          }

          // Process the motion event.
          if(this.nvr.optionEnabled(camera, "Motion.SmartDetect.NvrEvents", true)) {

            this.motionEventHandler(accessory, payload.start, payload.smartDetectTypes);
          }

          return;

          break;
        }

        default:

          // It's not a modelKey we're interested in. We're done.
          return;
          break;
      }
    });

    // Mark the listener as configured.
    this.nvrApi.eventListenerConfigured = true;
    return true;
  }

  // Motion event processing from UniFi Protect.
  public motionEventHandler(accessory: PlatformAccessory, lastMotion: number, detectedObjects: string[] = []): void {

    const camera = accessory.context.camera as ProtectCameraConfig;

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
    if((Date.now() - lastMotion) > (this.nvr.refreshInterval * 2 * 1000)) {

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
    const motionService = accessory.getService(this.hap.Service.MotionSensor);

    if(motionService) {
      this.motionEventDelivery(accessory, motionService, detectedObjects);
    }
  }

  // Motion event delivery to HomeKit.
  private motionEventDelivery(accessory: PlatformAccessory, motionService: Service, detectedObjects: string[] = []): void {

    const camera = accessory.context.camera as ProtectCameraConfig;

    // Lookup the ProtectCamera instance associated with this accessory.
    const protectCamera = this.nvr.configuredCameras[accessory.UUID];

    if(!protectCamera) {
      return;
    }

    // If we have disabled motion events, we're done here.
    if(("detectMotion" in accessory.context) && !accessory.context.detectMotion) {
      return;
    }

    // Trigger the motion event If it's not a smart motion event or if it's a smart motion event that we are interested in.
    if(!detectedObjects.length || (detectedObjects.length && detectedObjects.filter(x => protectCamera.smartDetectTypes.includes(x)).length)) {

      // Trigger the motion event in HomeKit.
      motionService.updateCharacteristic(this.hap.Characteristic.MotionDetected, true);

      // Check to see if we have a motion trigger switch configured. If we do, update it.
      const triggerService = accessory.getServiceById(this.hap.Service.Switch, PROTECT_SWITCH_MOTION_TRIGGER);

      if(triggerService) {
        triggerService.updateCharacteristic(this.hap.Characteristic.On, true);
      }

      // Publish the motion event to MQTT, if the user has configured it.
      this.nvr.mqtt?.publish(accessory, "motion", "true");

      // Log the event, if configured to do so.
      if(this.nvr.optionEnabled(camera, "Log.Motion", false)) {
        this.log.info("%s: Motion detected%s.", this.nvrApi.getFullName(camera), detectedObjects.length ? ": " + detectedObjects.join(", ") : "");
      }
    }

    // Trigger smart motion contact sensors, if configured.
    for(const detectedObject of detectedObjects) {

      const contactService = accessory.getServiceById(this.hap.Service.ContactSensor, PROTECT_CONTACT_MOTION_SMARTDETECT + "." + detectedObject);

      if(contactService) {
        contactService.updateCharacteristic(this.hap.Characteristic.ContactSensorState, true);
      }

      // Publish the smart motion event to MQTT, if the user has configured it.
      this.nvr.mqtt?.publish(accessory, "motion/smart/" + detectedObject, "true");
    }

    // Reset our motion event after motionDuration.
    this.eventTimers[camera.mac] = setTimeout(() => {

      // Reset the motion sensor, if it's been triggered.
      if(!detectedObjects.length || (detectedObjects.length && detectedObjects.filter(x => protectCamera.smartDetectTypes.includes(x)).length)) {

        const thisMotionService = accessory.getService(this.hap.Service.MotionSensor);

        if(thisMotionService) {

          thisMotionService.updateCharacteristic(this.hap.Characteristic.MotionDetected, false);

          // Check to see if we have a motion trigger switch configured. If we do, update it.
          const thisTriggerService = accessory.getServiceById(this.hap.Service.Switch, PROTECT_SWITCH_MOTION_TRIGGER);

          if(thisTriggerService) {
            thisTriggerService.updateCharacteristic(this.hap.Characteristic.On, false);
          }

          this.debug("%s: Resetting motion event.", this.nvrApi.getFullName(camera));
        }

        // Publish to MQTT, if the user has configured it.
        this.nvr.mqtt?.publish(accessory, "motion", "false");
      }

      // Reset smart motion contact sensors, if configured.
      for(const detectedObject of detectedObjects) {

        const contactService = accessory.getServiceById(this.hap.Service.ContactSensor, PROTECT_CONTACT_MOTION_SMARTDETECT + "." + detectedObject);

        if(contactService) {
          contactService.updateCharacteristic(this.hap.Characteristic.ContactSensorState, false);
        }

        // Publish the smart motion event to MQTT, if the user has configured it.
        this.nvr.mqtt?.publish(accessory, "motion/smart/" + detectedObject, "false");

        this.debug("%s: Resetting smart object motion event.", this.nvrApi.getFullName(camera));
      }

      // Delete the timer from our motion event tracker.
      delete this.eventTimers[camera.mac];
    }, this.motionDuration * 1000);
  }

  // Doorbell event processing from UniFi Protect and delivered to HomeKit.
  public doorbellEventHandler(accessory: PlatformAccessory, lastRing: number | null): void {

    const camera = accessory.context.camera as ProtectCameraConfig;

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
    if((Date.now() - lastRing) > (this.nvr.refreshInterval * 2 * 1000)) {
      this.debug("%s: Skipping doorbell ring due to stale data.", this.nvrApi.getFullName(camera));
      return;
    }

    // Remember this event.
    this.lastRing[camera.mac] = lastRing;

    // Only notify the user if we have a doorbell.
    const doorbellService = accessory.getService(this.hap.Service.Doorbell);

    if(!doorbellService) {
      return;
    }

    // Trigger the doorbell.
    doorbellService.updateCharacteristic(this.hap.Characteristic.ProgrammableSwitchEvent, this.hap.Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS);

    // Check to see if we have a doorbell trigger switch configured. If we do, update it.
    const triggerService = accessory.getServiceById(this.hap.Service.Switch, PROTECT_SWITCH_DOORBELL_TRIGGER);

    if(triggerService) {

      // Kill any inflight trigger reset.
      if(this.eventTimers[camera.mac + ".DoorbellRing"]) {
        clearTimeout(this.eventTimers[camera.mac + ".DoorbellRing"]);
        delete this.eventTimers[camera.mac + ".DoorbellRing"];
      }

      const protectCamera = this.nvr.configuredCameras[accessory.UUID];

      // Flag that we're ringing.
      if(protectCamera) {
        protectCamera.isRinging = true;
      }

      triggerService.updateCharacteristic(this.hap.Characteristic.On, true);

      // Reset our doorbell trigger after two seconds.
      this.eventTimers[camera.mac + ".DoorbellRing"] = setTimeout(() => {

        if(protectCamera) {
          protectCamera.isRinging = false;
        }

        triggerService.updateCharacteristic(this.hap.Characteristic.On, false);
        this.debug("%s: Resetting doorbell ring trigger.", this.nvrApi.getFullName(camera));

        // Delete the timer from our motion event tracker.
        delete this.eventTimers[camera.mac + ".DoorbellRing"];
      }, 2 * 1000);
    }

    // Publish to MQTT, if the user has configured it.
    this.nvr.mqtt?.publish(accessory, "doorbell", "true");

    if(this.nvr.optionEnabled(camera, "Log.Doorbell", false)) {
      this.log.info("%s: Doorbell ring detected.", this.nvrApi.getFullName(camera));
    }
  }

  // LCD message event processing from UniFi Protect and delivered to HomeKit.
  private lcdMessageEventHandler(accessory: PlatformAccessory, lcdMessage: ProtectCameraLcdMessagePayload): void {

    const camera = accessory.context.camera as ProtectCameraConfig;

    if(!accessory || !camera) {
      return;
    }

    (this.nvr.configuredCameras[accessory.UUID] as ProtectDoorbell)?.updateLcdSwitch(lcdMessage);
  }
}
