/* Copyright(C) 2017-2023, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-nvr-events.ts: NVR device class for UniFi Protect.
 */
import { API, HAP, Service } from "homebridge";
import { ProtectApi, ProtectEventAdd, ProtectEventPacket, ProtectNvrConfig } from "unifi-protect";
import { ProtectDeviceConfigTypes, ProtectLogging, ProtectReservedNames } from "./protect-types.js";
import { EventEmitter } from "node:events";
import { ProtectCamera } from "./protect-camera.js";
import { ProtectDevice } from "./protect-device.js";
import { ProtectNvr } from "./protect-nvr.js";
import { ProtectPlatform } from "./protect-platform.js";

export class ProtectNvrEvents extends EventEmitter {

  private api: API;
  private hap: HAP;
  private lastMotion: { [index: string]: number };
  private lastRing: { [index: string]: number };
  private log: ProtectLogging;
  private motionDuration: number;
  private mqttPublishTelemetry: boolean;
  private nvr: ProtectNvr;
  private readonly eventTimers: { [index: string]: NodeJS.Timeout };
  private ufpApi: ProtectApi;
  private ufpDeviceState: { [index: string]: ProtectDeviceConfigTypes };
  private platform: ProtectPlatform;
  private ringDuration: number;
  private unsupportedDevices: { [index: string]: boolean };
  private eventsHandler: ((packet: ProtectEventPacket) => void) | null;
  private ufpUpdatesHandler:  ((packet: ProtectEventPacket) => void) | null;

  // Initialize an instance of our Protect events handler.
  constructor(nvr: ProtectNvr) {

    super();

    this.api = nvr.platform.api;
    this.eventTimers = {};
    this.hap = nvr.platform.api.hap;
    this.lastMotion = {};
    this.lastRing = {};
    this.log = nvr.log;
    this.mqttPublishTelemetry = nvr.hasFeature("Nvr.Publish.Telemetry");
    this.nvr = nvr;
    this.ufpApi = nvr.ufpApi;
    this.ufpDeviceState = {};
    this.motionDuration = nvr.platform.config.motionDuration;
    this.platform = nvr.platform;
    this.ringDuration = nvr.platform.config.ringDuration;
    this.unsupportedDevices = {};
    this.eventsHandler = null;
    this.ufpUpdatesHandler = null;

    // If we've enabled telemetry from the controller inform the user.
    if(this.mqttPublishTelemetry) {

      this.log.info("Protect controller telemetry enabled.");
    }

    this.configureEvents();
  }

  // Thanks to https://stackoverflow.com/a/48218209 for the foundation for this one.
  // Merge Protect JSON update payloads into the Protect configuration JSON for a device while dealing with deep objects.
  // @param {...object} objects - Objects to merge
  // @returns {object} New object with merged key/values
  private patchUfpConfigJson(...objects: Record<string, unknown>[]): Record<string, unknown> {

    const isObject = (x: unknown): boolean => (x && (typeof(x) === "object")) as boolean;

    return objects.reduce((prev, obj) => {

      for(const key of Object.keys(obj)) {

        const pVal = prev[key];
        const oVal = obj[key];

        if(Array.isArray(pVal) && Array.isArray(oVal)) {

          prev[key] = oVal;
        } else if(isObject(pVal) && isObject(oVal)) {

          prev[key] = this.patchUfpConfigJson(pVal as Record<string, unknown>, oVal as Record<string, unknown>);
        } else {

          prev[key] = oVal;
        }
      }

      return prev;
    }, {});
  }

  // Process Protect API update events.
  private ufpUpdates(packet: ProtectEventPacket): void {

    let protectDevice;

    switch(packet.header.modelKey) {

      case "nvr":

        this.nvr.ufp = this.patchUfpConfigJson(this.nvr.ufp, packet.payload as Record<string, unknown>) as ProtectNvrConfig;
        break;

      default:

        // Lookup the device.
        protectDevice = this.nvr.deviceLookup(packet.header.id);

        // Update our device state.
        if(protectDevice) {

          protectDevice.ufp = this.patchUfpConfigJson(protectDevice.ufp, packet.payload as Record<string, unknown>) as ProtectDeviceConfigTypes;
        }

        break;
    }

    // Update the internal list we maintain.
    this.ufpDeviceState[packet.header.id] = Object.assign(this.ufpDeviceState[packet.header.id] ?? {}, packet.payload);
  }

  // Process device additions and removals from the Protect update events API.
  private manageDevices(packet: ProtectEventPacket): void {

    const payload = packet.payload as ProtectEventAdd;

    // We only want adoption-related events.
    if((packet.header.modelKey !== "event") || ((payload.type !== "deviceAdopted") && (payload.type !== "deviceUnadopted"))) {

      return;
    }

    // Make sure we have the right information to process the event.
    if(!("deviceId" in payload.metadata) || !("text" in (payload.metadata.deviceId as Record<string, unknown>))) {

      return;
    }

    // Lookup the device.
    const deviceId = (payload.metadata.deviceId as Record<string, unknown>).text as string;
    const protectDevice = this.nvr.deviceLookup(deviceId);

    // We're adopting.
    if(payload.type === "deviceAdopted") {

      if(protectDevice) {

        this.log.error("WE HAVE THE DEVICE ALREADY - WE ARE SCREWED!");
        return;
      }

      this.nvr.addHomeKitDevice(this.ufpDeviceState[deviceId]);
      return;
    }

    // We're unadopting.
    if(payload.type === "deviceUnadopted") {

      // If it's already gone, we're done.
      if(!protectDevice) {

        return;
      }

      // Remove the device.
      this.nvr.removeHomeKitDevice(protectDevice);
      return;
    }
  }

  // Listen to the UniFi Protect realtime updates API for updates we are interested in (e.g. motion).
  private configureEvents(): boolean {

    // Only configure the event listener if it exists and it's not already configured.
    if(this.eventsHandler && this.ufpUpdatesHandler) {

      return true;
    }

    // Ensure we update our UFP state before we process any other events.
    this.prependListener("updateEvent", this.ufpUpdatesHandler = this.ufpUpdates.bind(this));

    // Process remove events.
    this.prependListener("addEvent", this.manageDevices.bind(this));

    // Listen for any messages coming in from our listener. We route events to the appropriate handlers based on the type of event that comes across.
    this.ufpApi.on("message", this.eventsHandler = (packet: ProtectEventPacket): void => {

      switch(packet.header.action) {

        case "add":

          this.emit("addEvent", packet);

          if((packet.payload as ProtectEventAdd).camera) {

            this.emit("addEvent." + (packet.payload as ProtectEventAdd).camera, packet);
          }

          this.emit("addEvent." + packet.header.modelKey, packet);

          break;

        case "remove":

          this.emit("removeEvent", packet);
          this.emit("removeEvent." + packet.header.id, packet);
          this.emit("removeEvent." + packet.header.modelKey, packet);
          break;

        case "update":

          this.emit("updateEvent", packet);
          this.emit("updateEvent." + packet.header.id, packet);
          this.emit("updateEvent." + packet.header.modelKey, packet);
          break;

        default:

          break;
      }

      // If enabled, publish all the event traffic coming from the Protect controller to MQTT.
      if(this.mqttPublishTelemetry) {

        this.nvr.mqtt?.publish(this.nvr.ufp.mac, "telemetry", JSON.stringify(packet));
      }
    });

    return true;
  }

  // Motion event processing from UniFi Protect.
  public motionEventHandler(protectDevice: ProtectDevice, lastMotion: number, detectedObjects: string[] = []): void {

    if(!protectDevice || !lastMotion) {

      return;
    }

    // Have we seen this event before? If so...move along.
    if(this.lastMotion[protectDevice.ufp.mac] >= lastMotion) {

      this.log.debug("Skipping duplicate motion event.");
      return;
    }

    // Remember this event.
    this.lastMotion[protectDevice.ufp.mac] = lastMotion;

    // If we already have a motion event inflight, allow it to complete so we don't spam users.
    if(this.eventTimers[protectDevice.ufp.mac]) {

      return;
    }

    // Only notify the user if we have a motion sensor and it's active.
    const motionService = protectDevice.accessory.getService(this.hap.Service.MotionSensor);

    if(motionService) {

      this.motionEventDelivery(protectDevice, motionService, detectedObjects);
    }
  }

  // Motion event delivery to HomeKit.
  private motionEventDelivery(protectDevice: ProtectDevice, motionService: Service, detectedObjects: string[] = []): void {

    if(!protectDevice) {

      return;
    }

    // If we have disabled motion events, we're done here.
    if(("detectMotion" in protectDevice.accessory.context) && !protectDevice.accessory.context.detectMotion) {

      return;
    }

    const protectCamera = protectDevice as ProtectCamera;

    // Trigger the motion event in HomeKit.
    motionService.updateCharacteristic(this.hap.Characteristic.MotionDetected, true);

    // Check to see if we have a motion trigger switch configured. If we do, update it.
    const triggerService = protectDevice.accessory.getServiceById(this.hap.Service.Switch, ProtectReservedNames.SWITCH_MOTION_TRIGGER);

    if(triggerService) {

      triggerService.updateCharacteristic(this.hap.Characteristic.On, true);
    }

    // Publish the motion event to MQTT, if the user has configured it.
    this.nvr.mqtt?.publish(protectDevice.accessory, "motion", "true");

    // Log the event, if configured to do so.
    if(protectDevice.hints.logMotion) {

      protectDevice.log.info("Motion detected%s.",
        ((protectDevice.ufp.modelKey === "camera") && detectedObjects.length &&
        (!protectCamera.stream?.hksv?.isRecording ||
        protectCamera.hints.smartDetect || protectDevice.hasFeature("Motion.SmartDetect.ObjectSensors"))) ? ": " + detectedObjects.join(", ") : "");
    }

    // Trigger smart motion contact sensors, if configured.
    for(const detectedObject of detectedObjects) {

      const contactService = protectDevice.accessory.getServiceById(this.hap.Service.ContactSensor,
        ProtectReservedNames.CONTACT_MOTION_SMARTDETECT + "." + detectedObject);

      if(contactService) {

        contactService.updateCharacteristic(this.hap.Characteristic.ContactSensorState, true);
      }

      // Publish the smart motion event to MQTT, if the user has configured it.
      this.nvr.mqtt?.publish(protectDevice.accessory, "motion/smart/" + detectedObject, "true");
    }

    // Reset our motion event after motionDuration if we don't already have a reset timer inflight.
    if(!this.eventTimers[protectDevice.ufp.mac]) {

      this.eventTimers[protectDevice.ufp.mac] = setTimeout(() => {

        const thisMotionService = protectDevice.accessory.getService(this.hap.Service.MotionSensor);

        if(thisMotionService) {

          thisMotionService.updateCharacteristic(this.hap.Characteristic.MotionDetected, false);

          // Check to see if we have a motion trigger switch configured. If we do, update it.
          const thisTriggerService = protectDevice.accessory.getServiceById(this.hap.Service.Switch, ProtectReservedNames.SWITCH_MOTION_TRIGGER);

          if(thisTriggerService) {

            thisTriggerService.updateCharacteristic(this.hap.Characteristic.On, false);
          }

          this.log.debug("Resetting motion event.");
        }

        // Publish to MQTT, if the user has configured it.
        this.nvr.mqtt?.publish(protectDevice.accessory, "motion", "false");

        // Delete the timer from our motion event tracker.
        delete this.eventTimers[protectDevice.ufp.mac];
      }, this.motionDuration * 1000);
    }

    // Reset our smart motion contact sensors after motionDuration.
    if(!this.eventTimers[protectDevice.ufp.mac + ".Motion.SmartDetect.ObjectSensors"]) {

      this.eventTimers[protectDevice.ufp.mac + ".Motion.SmartDetect.ObjectSensors"] = setTimeout(() => {

        // Reset smart motion contact sensors, if configured.
        for(const detectedObject of detectedObjects) {

          const contactService = protectDevice.accessory.getServiceById(this.hap.Service.ContactSensor,
            ProtectReservedNames.CONTACT_MOTION_SMARTDETECT + "." + detectedObject);

          if(contactService) {

            contactService.updateCharacteristic(this.hap.Characteristic.ContactSensorState, false);
          }

          // Publish the smart motion event to MQTT, if the user has configured it.
          this.nvr.mqtt?.publish(protectDevice.accessory, "motion/smart/" + detectedObject, "false");

          this.log.debug("Resetting smart object motion event.");
        }

        // Delete the timer from our motion event tracker.
        delete this.eventTimers[protectDevice.ufp.mac + ".Motion.SmartDetect.ObjectSensors"];
      }, this.motionDuration * 1000);
    }
  }

  // Doorbell event processing from UniFi Protect and delivered to HomeKit.
  public doorbellEventHandler(protectDevice: ProtectCamera, lastRing: number | null): void {

    if(!protectDevice || !lastRing) {

      return;
    }

    // Have we seen this event before? If so...move along. It's unlikely we hit this in a doorbell scenario, but just in case.
    if(this.lastRing[protectDevice.ufp.mac] >= lastRing) {

      this.log.debug("Skipping duplicate doorbell ring.");
      return;
    }

    // Remember this event.
    this.lastRing[protectDevice.ufp.mac] = lastRing;

    // Only notify the user if we have a doorbell.
    const doorbellService = protectDevice.accessory.getService(this.hap.Service.Doorbell);

    if(!doorbellService) {

      return;
    }

    // Trigger the doorbell. We delay this slightly to workaround what appears to be a race
    // condition bug in HomeKit. Inelegant, but effective.
    setTimeout(() => {

      doorbellService.getCharacteristic(this.hap.Characteristic.ProgrammableSwitchEvent)
        ?.sendEventNotification(this.hap.Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS);
    }, 500);

    // Check to see if we have a doorbell trigger switch configured. If we do, update it.
    const triggerService = protectDevice.accessory.getServiceById(this.hap.Service.Switch, ProtectReservedNames.SWITCH_DOORBELL_TRIGGER);

    if(triggerService) {

      // Kill any inflight trigger reset.
      if(this.eventTimers[protectDevice.ufp.mac + ".Doorbell.Ring.Trigger"]) {

        clearTimeout(this.eventTimers[protectDevice.ufp.mac + ".Doorbell.Ring.Trigger"]);
        delete this.eventTimers[protectDevice.ufp.mac + ".Doorbell.Ring.Trigger"];
      }

      // Flag that we're ringing.
      protectDevice.isRinging = true;

      // Update the trigger switch state.
      triggerService.updateCharacteristic(this.hap.Characteristic.On, true);

      // Reset our doorbell trigger after ringDuration.
      this.eventTimers[protectDevice.ufp.mac + ".Doorbell.Ring.Trigger"] = setTimeout(() => {

        protectDevice.isRinging = false;

        triggerService.updateCharacteristic(this.hap.Characteristic.On, false);
        this.log.debug("Resetting doorbell ring trigger.");

        // Delete the timer from our motion event tracker.
        delete this.eventTimers[protectDevice.ufp.mac + ".Doorbell.Ring.Trigger"];
      }, this.ringDuration * 1000);
    }

    // Publish to MQTT, if the user has configured it.
    this.nvr.mqtt?.publish(protectDevice.accessory, "doorbell", "true");

    if(protectDevice.hints.logDoorbell) {

      protectDevice.log.info("Doorbell ring detected.");
    }

    // Kill any inflight ring reset.
    if(this.eventTimers[protectDevice.ufp.mac + ".Doorbell.Ring"]) {

      clearTimeout(this.eventTimers[protectDevice.ufp.mac + ".Doorbell.Ring"]);
      delete this.eventTimers[protectDevice.ufp.mac + ".Doorbell.Ring"];
    }

    // Fire off our MQTT doorbell ring event after ringDuration.
    this.eventTimers[protectDevice.ufp.mac + ".Doorbell.Ring"] = setTimeout(() => {

      this.nvr.mqtt?.publish(protectDevice.accessory, "doorbell", "false");

      // Delete the timer from our event tracker.
      delete this.eventTimers[protectDevice.ufp.mac + ".Doorbell.Ring"];
    }, this.ringDuration * 1000);
  }
}
