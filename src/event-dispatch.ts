/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * event-dispatch.ts: Typed event-firehose router and HomeKit delivery for UniFi Protect.
 */
import type { AuthMethod, ProtectEventMetadata, ProtectEventMetadataDetectedThumbnail, TypedEvent } from "unifi-protect";
import type { HAP, Service } from "homebridge";
import type { HomebridgePluginLogging, Nullable } from "homebridge-plugin-utils";
import { PROTECT_DOORBELL_AUTHSENSOR_DURATION, PROTECT_DOORBELL_TRIGGER_DURATION } from "./settings.ts";
import type { ProtectCamera, ProtectDevice } from "./devices/index.ts";
import type { FirehoseDispatchPayload } from "./diagnostics.ts";
import type { ProtectNvr } from "./nvr.ts";
import { ProtectReservedNames } from "./types.ts";
import { channels } from "./diagnostics.ts";
import { mqttTopic } from "./mqtt.ts";

// How long the HomeKit Access lock shows unlocked before we re-secure it, mirroring the v4 momentary-unlock behavior. UniFi Access emits no "relocked" occurrence,
// so this is a display-side timer that returns the lock to its resting state, not a reflection of the physical lock. Exported so the unlock delivery's timer window is
// referenced by name in tests rather than as a magic number.
export const ACCESS_UNLOCK_DURATION = 2000;

/**
 * The v4 bare-motion de-duplication policy, lifted to a pure predicate so the router's decision is exhaustively testable without standing up a camera accessory.
 *
 * Under v5 the controller classifies a raw motion start (`motionDetected`) and a smart-object detection (`smartDetect`) into two distinct firehose events, so HBUP no
 * longer hand-diffs `lastMotion` against the smart payload to avoid a double-fire. The *policy*, however, survives verbatim: we trip the HomeKit MotionSensor from a
 * bare `motionDetected` only when smart detection cannot be the authoritative source of motion - the camera is actively recording for HKSV (where every motion start
 * must drive the recording), the camera has no smart-detection capability at all, or the user has turned smart detection off. In every other case the matching
 * `smartDetect` event is the source of truth and firing here as well would double-report the same motion.
 *
 * @param inputs - The three camera facts the policy reads, named so the truth table is legible: whether HKSV is recording, whether the camera can smart-detect, and
 *                 whether the user enabled smart detection.
 *
 * @returns `true` when a bare `motionDetected` should trip the HomeKit MotionSensor, `false` when the `smartDetect` event owns motion for this camera.
 */
export function shouldDeliverBareMotion(inputs: { hksvRecording: boolean; smartCapable: boolean; smartDetectEnabled: boolean }): boolean {

  return inputs.hksvRecording || !inputs.smartCapable || !inputs.smartDetectEnabled;
}

/**
 * The controller's typed event surface, projected onto HomeKit. This is the surviving half of the v4 `ProtectEvents` class: the state-merge, packet re-emit, and
 * per-id EventEmitter fan-out all dissolved into v5's reducer and observe loops, and what remains is a thin router over the classified firehose plus the HomeKit
 * delivery methods that router drives.
 *
 *   - `run()` is one controller-level consumer of `client.events()` - the typed, classified firehose. It switches on the discriminated `kind` and dispatches each
 *     activity occurrence (motion, smart detection, doorbell ring, access unlock) to the addressed accessory's delivery method. State transitions
 *     (deviceAdded/devicePatched/...) are the NVR observe loops' concern and are ignored here.
 *   - `publishTelemetry()` is the controller telemetry republisher: every raw frame off `client.rawPackets()` is mirrored to MQTT when the user opts in.
 *   - the delivery methods (`motionEventHandler`, `doorbellEventHandler`, `accessEventHandler`) own the HomeKit-facing behavior - the characteristic writes, the reset
 *     timers, and the MQTT side-channels. They are unchanged from v4; only their *trigger* moved from a hand-diffed device-state payload to the typed firehose.
 *
 * A plain class, not an EventEmitter: nothing here emits, and the last `.on`/`.off` subscriber - ProtectNvrSystemInfo's `updateEvent.<nvrId>` listener, whose fan-out
 * source had already dissolved into v5's reducer - migrated to a narrow `client.state.observe` loop over the controller's systemInfo slice. No event bus
 * survives: the accessory leaves call the delivery methods directly through `nvr.events`, and the router and telemetry publisher are spawned as NVR observe loops.
 */
export class ProtectEventDispatch {

  private hap: HAP;
  private log: HomebridgePluginLogging;
  private nvr: ProtectNvr;
  private readonly eventTimers: Map<string, NodeJS.Timeout>;

  // Initialize an instance of our Protect event dispatcher.
  constructor(nvr: ProtectNvr) {

    // Structural wiring only. The controller-state-dependent setup the v4 constructor did here - reading the telemetry feature option (which resolves against the
    // controller mac, unknown before connect()) and binding the realtime packet listener on ufpApi - is gone: this constructor runs inside ProtectNvr's constructor,
    // before connect(), where neither the controller mac nor a live client exists yet. The realtime consumers it used to wire are now the NVR's loops - the typed
    // firehose router (run) and the telemetry publisher (publishTelemetry) below, both spawned post-connect and bound to the shutdown signal - so this stays a plain
    // field-initializer and the controller-scoped work happens when those loops start.
    this.eventTimers = new Map();
    this.hap = nvr.platform.api.hap;
    this.log = nvr.log;
    this.nvr = nvr;
  }

  // The typed-firehose router. One controller-level consumer of the classified event stream: each event arrives already modeled (v5 owns the decode and classification),
  // so we switch on the discriminated kind and route each activity occurrence to the addressed accessory's HomeKit delivery method. The caller binds this to the NVR's
  // terminal shutdown signal; the loop ends quietly when that signal aborts (the library smooths the caller's own abort into a clean return).
  public async run(signal: AbortSignal): Promise<void> {

    for await (const event of this.nvr.client.events({ signal })) {

      switch(event.kind) {

        case "motionDetected": {

          // A raw motion start. We resolve the addressed camera, then apply the bare-motion de-duplication policy: trip the HomeKit MotionSensor only when smart
          // detection is not the source of truth for this camera (see shouldDeliverBareMotion). When it owns motion, the matching smartDetect event fires instead.
          const camera = this.cameraFor(event.cameraId);

          if(!camera) {

            break;
          }

          // One read-through of the live camera config for the duration of this synchronous decision. The capability arrays are stable across the dedup read, so a
          // scope-local hoist keeps the bare-motion policy off the projection getter chain without ever caching state across an await.
          const featureFlags = camera.ufp.featureFlags;

          const fire = shouldDeliverBareMotion({

            hksvRecording: camera.stream?.hksv?.isRecording ?? false,
            smartCapable: (featureFlags.smartDetectAudioTypes.length > 0) || (featureFlags.smartDetectTypes.length > 0),
            smartDetectEnabled: camera.hints.smartDetect
          });

          if(fire) {

            this.publishDispatch(event.kind, event.cameraId);
            this.motionEventHandler(camera);
          }

          // A package camera is a secondary lens on this same physical device with no motion sensor of its own, so HKSV needs the parent's raw motion to trip the
          // package accessory's motion sensor for it to record. This is independent of the parent's bare-motion de-dup above (which governs only the parent's own
          // MotionSensor): when the package camera is recording, the parent's raw motion always drives it. Relocated from the doorbell leaf's now-deleted event handler.
          if(camera.packageCamera?.stream?.hksv?.isRecording) {

            this.motionEventHandler(camera.packageCamera);
          }

          break;
        }

        case "smartDetect": {

          // A smart-object detection, delivered as a motion event carrying the detected object types and metadata, but only when the user has smart detection enabled
          // and the occurrence still describes something after the thumbnail filter below - a populated object-type list or surviving thumbnail detections.
          const camera = this.cameraFor(event.cameraId);

          if(!camera?.hints.smartDetect) {

            break;
          }

          // Preserve the v4 thumbnail filter: with "Create motion events" enabled on the camera, Protect tags some detections as plain "motion" inside a smart event's
          // thumbnails; those are not true smart detections, so we drop them - building a filtered copy rather than mutating the classifier's metadata - before both the
          // has-anything gate and the delivery, matching the v4 leaf exactly. The firehose metadata structurally satisfies HBUP's richer ProtectEventMetadata shape (the
          // one home that knows the delivery reads detectedThumbnails off it), so it flows in without a cast.
          const metadata = this.withoutMotionThumbnails(event.metadata);

          if(!event.objectTypes.length && !metadata?.detectedThumbnails?.length) {

            break;
          }

          this.publishDispatch(event.kind, event.cameraId);
          this.motionEventHandler(camera, [...event.objectTypes], metadata);

          break;
        }

        case "tamperDetected": {

          // A camera reported tampering. We route it to the tamper delivery, which latches the camera tampered and trips StatusTampered. Tamper is a sibling of motion,
          // not a smart-detection variant - it carries no object types - so it has its own case and its own one-way delivery.
          const camera = this.cameraFor(event.cameraId);

          if(!camera) {

            break;
          }

          this.publishDispatch(event.kind, event.cameraId);
          this.tamperEventHandler(camera);

          break;
        }

        case "doorbellRing": {

          // A doorbell press. We route it to the doorbell delivery, which trips the HomeKit Doorbell programmable switch and its trigger/MQTT side-channels.
          const camera = this.cameraFor(event.cameraId);

          if(!camera) {

            break;
          }

          this.publishDispatch(event.kind, event.cameraId);
          this.doorbellEventHandler(camera, event.at);

          break;
        }

        case "accessEvent": {

          // A UniFi Access occurrence surfaced through Protect. We route it to the access delivery, which handles the door-unlock path on the camera's Access lock.
          const camera = this.cameraFor(event.deviceId);

          if(!camera) {

            break;
          }

          this.publishDispatch(event.kind, event.deviceId);
          this.accessEventHandler(camera, event.action, event.metadata);

          break;
        }

        case "authDetected": {

          // A doorbell fingerprint match or NFC card tap. We route it to the auth delivery, which trips the doorbell's authentication contact sensor on a recognized
          // identity. Classification is v5's; this is delivery only - the kind already tells us it is an auth scan, and the matched identity is a metadata read below.
          const camera = this.cameraFor(event.cameraId);

          if(!camera) {

            break;
          }

          this.publishDispatch(event.kind, event.cameraId);
          this.authEventHandler(camera, event.method, event.metadata);

          break;
        }

        default: {

          // State transitions (deviceAdded / devicePatched / deviceRemoved / bootstrapLoaded) are the NVR observe loops' concern; the router ignores them.
          break;
        }
      }
    }
  }

  // Resolve a firehose camera/device id to the addressed camera accessory, or null when it is absent or not a camera. Doorbells share the camera model key and extend
  // ProtectCamera, so this narrows to both. Cameras are the only accessories the activity firehose addresses, so a non-camera match (or an unconfigured id) is a clean
  // no-op at the call site.
  private cameraFor(id: string): Nullable<ProtectCamera> {

    const device = this.nvr.getDeviceById(id);

    return (device?.ufp.modelKey === "camera") ? (device as ProtectCamera) : null;
  }

  // Publish a firehose-dispatch milestone on the forward-only diagnostics channel when a routed activity event reaches a delivery method. Zero-cost when no subscriber
  // is attached (the Node-native sync check), mirroring the NVR's other diagnostics publishers.
  private publishDispatch(kind: TypedEvent["kind"], cameraId?: string): void {

    if(channels.firehoseDispatch.hasSubscribers) {

      channels.firehoseDispatch.publish({ cameraId, kind } satisfies FirehoseDispatchPayload);
    }
  }

  // Drop "motion"-tagged thumbnails from smart-detection metadata, returning a filtered copy and never mutating the classifier's object. When a camera has Protect's
  // "Create motion events" setting on, Protect emits motion-typed thumbnails alongside genuine smart detections; those are plain motion, not smart objects, so the v4
  // leaf stripped them before delivery and this preserves that exactly. Metadata without thumbnails (or absent entirely) passes through untouched.
  private withoutMotionThumbnails(metadata?: ProtectEventMetadata): ProtectEventMetadata | undefined {

    if(!metadata?.detectedThumbnails) {

      return metadata;
    }

    return { ...metadata, detectedThumbnails: metadata.detectedThumbnails.filter(({ type }) => type !== "motion") };
  }

  // Motion event processing from UniFi Protect.
  public motionEventHandler(protectDevice: ProtectDevice, detectedObjects: string[] = [], metadata?: ProtectEventMetadata): void {

    // Only notify the user if we have a motion sensor and it's active.
    const motionService = protectDevice.accessory.getService(this.hap.Service.MotionSensor);

    if(motionService) {

      this.motionEventDelivery(protectDevice, motionService, detectedObjects, metadata);
    }
  }

  // Motion event delivery to HomeKit.
  private motionEventDelivery(protectDevice: ProtectDevice, motionService: Service, detectedObjects: string[], metadata: ProtectEventMetadata = {}): void {

    // If we have disabled motion events, we're done here.
    if(protectDevice.accessory.context.detectMotion === false) {

      return;
    }

    // Only update HomeKit if we don't have a motion event inflight.
    if(!this.eventTimers.has(protectDevice.id)) {

      // Trigger the motion event in HomeKit.
      motionService.updateCharacteristic(this.hap.Characteristic.MotionDetected, true);

      // If we have a motion trigger switch configured, update it.
      protectDevice.accessory.getServiceById(this.hap.Service.Switch, ProtectReservedNames.SWITCH_MOTION_TRIGGER)?.updateCharacteristic(this.hap.Characteristic.On, true);

      // Publish the motion event to MQTT, if the user has configured it.
      void this.nvr.mqtt?.publish(mqttTopic(protectDevice.ufp.mac, "motion"), "true");

      // Log the event, if configured to do so.
      if(protectDevice.hints.logMotion) {

        protectDevice.log.info("Motion detected.");
      }
    } else {

      // Clear out the inflight motion event timer.
      clearTimeout(this.eventTimers.get(protectDevice.id));
    }

    // Reset our motion event after motionDuration.
    this.eventTimers.set(protectDevice.id, setTimeout(() => {

      motionService.updateCharacteristic(this.hap.Characteristic.MotionDetected, false);

      // If we have a motion trigger switch configured, update it.
      protectDevice.accessory.getServiceById(this.hap.Service.Switch, ProtectReservedNames.SWITCH_MOTION_TRIGGER)
        ?.updateCharacteristic(this.hap.Characteristic.On, false);

      protectDevice.log.debug("Resetting motion event.");

      // Publish to MQTT, if the user has configured it.
      void this.nvr.mqtt?.publish(mqttTopic(protectDevice.ufp.mac, "motion"), "false");

      // Delete the timer from our motion event tracker.
      this.eventTimers.delete(protectDevice.id);
    }, protectDevice.hints.motionDuration * 1000));

    // We build a unified list of the object events we're interested in: legacy smart detections first, followed by thumbnail-based detections.
    interface EventItem {

      type: string;
      name?: string;
      confidence?: number;
      payload?: ProtectEventMetadataDetectedThumbnail;
    }

    const smartEvents: EventItem[] = [];

    // Only look for smart detections if we're configured to do so.
    if(protectDevice.hints.smartDetect) {

      // Add our legacy smart detections.
      smartEvents.push(...detectedObjects.map(type => ({ type })));

      // Now add our thumbnail-based detections.
      if(metadata.detectedThumbnails) {

        smartEvents.push(...metadata.detectedThumbnails.filter(thumbnail => thumbnail.type).map(detection => ({

          confidence: detection.confidence,
          name: detection.name,
          payload: detection as ProtectEventMetadataDetectedThumbnail,
          type: detection.type ?? ""
        })));
      }
    }

    // Iterate over the smart events that Protect has detected.
    for(const event of smartEvents) {

      const key = protectDevice.id + ".Motion.SmartDetect.ObjectSensors." + event.type;

      // We have a new event, let's make sure we trigger our sensors only once.
      if(!this.eventTimers.has(key)) {

        // These sensors only get triggered if they actually exist on the accessory.
        protectDevice.accessory.getServiceById(this.hap.Service.ContactSensor, ProtectReservedNames.CONTACT_MOTION_SMARTDETECT + "." + event.type)?.
          updateCharacteristic(this.hap.Characteristic.ContactSensorState, this.hap.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED);

        // Publish the smart detection event to MQTT, if the user has configured it.
        void this.nvr.mqtt?.publish(mqttTopic(protectDevice.ufp.mac, "motion/smart/" + event.type), "true");

        // Inform the user. We handle logging for vehicle-related events below.
        if(protectDevice.hints.logMotion && (event.type !== "vehicle")) {

          protectDevice.log.info("Smart motion detected: %s.", event.type);
        }
      } else {

        // Clear out the inflight motion event timer.
        clearTimeout(this.eventTimers.get(key));
      }

      // Reset our smart detection contact sensors after motionDuration.
      this.eventTimers.set(key, setTimeout(() => {

        // Reset our smart detection contact sensor.
        protectDevice.accessory.getServiceById(this.hap.Service.ContactSensor, ProtectReservedNames.CONTACT_MOTION_SMARTDETECT + "." + event.type)?.
          updateCharacteristic(this.hap.Characteristic.ContactSensorState, this.hap.Characteristic.ContactSensorState.CONTACT_DETECTED);

        // Publish the smart detection event to MQTT, if the user has configured it.
        void this.nvr.mqtt?.publish(mqttTopic(protectDevice.ufp.mac, "motion/smart/" + event.type), "false");
        protectDevice.log.debug("Resetting smart object motion event.");

        // Delete the timer from our motion event tracker.
        this.eventTimers.delete(key);
      }, protectDevice.hints.motionDuration * 1000));

      // Vehicles have additional attributes that can be associated with their smart detections. We process those here.
      if(event.type === "vehicle") {

        // We have a license plate. Let's see if we have a match with what the user has configured.
        if(event.name) {

          const plate = event.name.toUpperCase();
          const plateKey = key + "." + plate;

          // We have a new plate detection.
          if(!this.eventTimers.has(plateKey)) {

            protectDevice.accessory.getServiceById(this.hap.Service.ContactSensor,
              ProtectReservedNames.CONTACT_MOTION_SMARTDETECT_LICENSE + "." + plate)?.
              updateCharacteristic(this.hap.Characteristic.ContactSensorState, this.hap.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED);
          } else {

            clearTimeout(this.eventTimers.get(plateKey));
          }

          // Reset our license plate smart detection contact sensor after motionDuration.
          this.eventTimers.set(plateKey, setTimeout(() => {

            protectDevice.accessory.getServiceById(this.hap.Service.ContactSensor,
              ProtectReservedNames.CONTACT_MOTION_SMARTDETECT_LICENSE + "." + plate)?.
              updateCharacteristic(this.hap.Characteristic.ContactSensorState, this.hap.Characteristic.ContactSensorState.CONTACT_DETECTED);

            // Delete the timer from our motion event tracker.
            this.eventTimers.delete(plateKey);
          }, protectDevice.hints.motionDuration * 1000));
        }

        // Publish event metadata when we see it. Currently, Protect publishes additional telemetry for vehicle types.
        if(protectDevice.hints.logMotion) {

          const attributes: string[] = [];

          // We have a license plate.
          if(event.name) {

            attributes.push("license plate: " + event.name + " [" + String(event.confidence ?? 0) + "% confidence]");
          }

          // Look at the color and vehicle type.
          for(const attribute of [ "color", "vehicleType" ] as const) {

            if(event.payload?.attributes?.[attribute]) {

              attributes.push(attribute + ": " + (event.payload.attributes[attribute].val ?? "") + " [" + String(event.payload.attributes[attribute].confidence ?? 0) +
                "% confidence]");
            }
          }

          // Inform the user.
          if(attributes.length) {

            void this.nvr.mqtt?.publish(mqttTopic(protectDevice.ufp.mac, "motion/smart/" + event.type + "/metadata"), JSON.stringify({

              ...(Number.isFinite(event.confidence) && { confidence: event.confidence }),
              ...(event.name?.length && { name: event.name }),
              type: event.type,
              ...(event.payload?.attributes?.color && { color: event.payload.attributes.color }),
              ...(event.payload?.attributes?.vehicleType && { vehicleType: event.payload.attributes.vehicleType })
            }));
          }

          protectDevice.log.info("Smart motion detected: %s%s.", event.type, attributes.length ? (" (" + attributes.join(", ") + ")") : "");
        }
      }
    }

    // If we don't have smart detection enabled, or if we do have it enabled and we have a smart detection event that's detected something of interest, let's process
    // our occupancy event updates.
    if(!protectDevice.hints.smartDetect || detectedObjects.some(x => protectDevice.hints.smartOccupancy.includes(x))) {

      // First, let's determine if the user has an occupancy sensor configured, before we process anything.
      const occupancyService = protectDevice.accessory.getService(this.hap.Service.OccupancySensor);

      if(occupancyService) {

        // Kill any inflight reset timer.
        if(this.eventTimers.has(protectDevice.id + ".Motion.OccupancySensor")) {

          clearTimeout(this.eventTimers.get(protectDevice.id + ".Motion.OccupancySensor"));
        }

        // If the occupancy sensor isn't already triggered, let's do so now.
        if(occupancyService.getCharacteristic(this.hap.Characteristic.OccupancyDetected).value !== true) {

          // Trigger the occupancy event in HomeKit.
          occupancyService.updateCharacteristic(this.hap.Characteristic.OccupancyDetected, true);

          // Publish the occupancy event to MQTT, if the user has configured it.
          void this.nvr.mqtt?.publish(mqttTopic(protectDevice.ufp.mac, "occupancy"), "true");

          // Log the event, if configured to do so.
          if(protectDevice.hints.logMotion) {

            protectDevice.log.info("Occupancy detected%s.",
              protectDevice.hints.smartDetect ? ": " + protectDevice.hints.smartOccupancy.filter(x => detectedObjects.includes(x)).join(", ") : "");
          }
        }

        // Reset our occupancy state after occupancyDuration.
        this.eventTimers.set(protectDevice.id + ".Motion.OccupancySensor", setTimeout(() => {

          // Reset the occupancy sensor.
          occupancyService.updateCharacteristic(this.hap.Characteristic.OccupancyDetected, false);

          // Publish to MQTT, if the user has configured it.
          void this.nvr.mqtt?.publish(mqttTopic(protectDevice.ufp.mac, "occupancy"), "false");

          // Log the event, if configured to do so.
          if(protectDevice.hints.logMotion) {

            protectDevice.log.info("Occupancy no longer detected.");
          }

          // Delete the timer from our occupancy event tracker.
          this.eventTimers.delete(protectDevice.id + ".Motion.OccupancySensor");
        }, protectDevice.hints.occupancyDuration * 1000));
      }
    }
  }

  // Doorbell event processing from UniFi Protect and delivered to HomeKit.
  public doorbellEventHandler(protectDevice: ProtectCamera, lastRing: Nullable<number>): void {

    if(!lastRing) {

      return;
    }

    // If we have an inflight ring event, and we're enforcing a ring duration, we're done.
    if(this.eventTimers.has(protectDevice.id + ".Doorbell.Ring")) {

      return;
    }

    // Only notify the user if we have a doorbell.
    const doorbellService = protectDevice.accessory.getService(this.hap.Service.Doorbell);

    if(!doorbellService) {

      return;
    }

    // Trigger the doorbell event in HomeKit, if we're configured to do so.
    if(!protectDevice.accessory.context.doorbellMuted) {

      doorbellService.getCharacteristic(this.hap.Characteristic.ProgrammableSwitchEvent)
        .sendEventNotification(this.hap.Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS);
    }

    // Check to see if we have a doorbell trigger switch configured. If we do, update it.
    const triggerService = protectDevice.accessory.getServiceById(this.hap.Service.Switch, ProtectReservedNames.SWITCH_DOORBELL_TRIGGER);

    if(triggerService) {

      // Kill any inflight trigger reset.
      if(this.eventTimers.has(protectDevice.id + ".Doorbell.Ring.Trigger")) {

        clearTimeout(this.eventTimers.get(protectDevice.id + ".Doorbell.Ring.Trigger"));
        this.eventTimers.delete(protectDevice.id + ".Doorbell.Ring.Trigger");
      }

      // Flag that we're ringing.
      protectDevice.isRinging = true;

      // Update the trigger switch state.
      triggerService.updateCharacteristic(this.hap.Characteristic.On, true);

      // Reset our doorbell trigger.
      this.eventTimers.set(protectDevice.id + ".Doorbell.Ring.Trigger", setTimeout(() => {

        protectDevice.isRinging = false;

        triggerService.updateCharacteristic(this.hap.Characteristic.On, false);
        this.log.debug("Resetting doorbell ring trigger.");

        // Delete the timer from our motion event tracker.
        this.eventTimers.delete(protectDevice.id + ".Doorbell.Ring.Trigger");
      }, PROTECT_DOORBELL_TRIGGER_DURATION));
    }

    // Publish to MQTT, if the user has configured it.
    void this.nvr.mqtt?.publish(mqttTopic(protectDevice.ufp.mac, "doorbell"), "true");

    if(protectDevice.hints.logDoorbell) {

      protectDevice.log.info("Doorbell ring detected.");
    }

    // Kill any inflight MQTT reset.
    if(this.eventTimers.has(protectDevice.id + ".Doorbell.Ring.MQTT")) {

      clearTimeout(this.eventTimers.get(protectDevice.id + ".Doorbell.Ring.MQTT"));
      this.eventTimers.delete(protectDevice.id + ".Doorbell.Ring.MQTT");
    }

    // Fire off our MQTT doorbell ring event.
    this.eventTimers.set(protectDevice.id + ".Doorbell.Ring.MQTT", setTimeout(() => {

      void this.nvr.mqtt?.publish(mqttTopic(protectDevice.ufp.mac, "doorbell"), "false");

      // Delete the timer from our event tracker.
      this.eventTimers.delete(protectDevice.id + ".Doorbell.Ring.MQTT");
    }, PROTECT_DOORBELL_TRIGGER_DURATION));

    // If we don't have a ring duration defined, we're done.
    if(!this.nvr.platform.config.ringDelay) {

      return;
    }

    // Reset our ring threshold.
    this.eventTimers.set(protectDevice.id + ".Doorbell.Ring", setTimeout(() => {

      // Delete the timer from our event tracker.
      this.eventTimers.delete(protectDevice.id + ".Doorbell.Ring");
    }, this.nvr.platform.config.ringDelay * 1000));
  }

  // Access unlock delivery, relocated from the camera leaf's add-event handler (since removed). A UniFi Access door-open occurrence that succeeded drops the
  // camera's Access lock to unlocked, then re-secures it after a brief window so HomeKit reflects the momentary unlock - UniFi Access has no relock occurrence to drive
  // the return. Other access actions (NFC, fingerprint, keypad reads) are not yet modeled and are deliberately ignored here; they arrive with the Access unlock work.
  public accessEventHandler(protectDevice: ProtectCamera, action: string, metadata?: Record<string, unknown>): void {

    // We only act on a successful door-open occurrence; everything else is a no-op until the broader Access unlock plumbing lands.
    if((action !== "open_door") || !metadata?.["openSuccess"]) {

      return;
    }

    // Only notify the user if we have an Access lock service.
    const lockService = protectDevice.accessory.getServiceById(this.hap.Service.LockMechanism, ProtectReservedNames.LOCK_ACCESS);

    if(!lockService) {

      return;
    }

    lockService.updateCharacteristic(this.hap.Characteristic.LockTargetState, this.hap.Characteristic.LockTargetState.UNSECURED);
    lockService.updateCharacteristic(this.hap.Characteristic.LockCurrentState, this.hap.Characteristic.LockCurrentState.UNSECURED);
    protectDevice.log.info("Unlocked.");

    // Re-secure after a brief window. We track the timer in eventTimers, keyed per device, so a rapid second unlock cancels the pending re-lock rather than racing it.
    const key = protectDevice.id + ".Access.Unlock";

    if(this.eventTimers.has(key)) {

      clearTimeout(this.eventTimers.get(key));
    }

    this.eventTimers.set(key, setTimeout(() => {

      lockService.updateCharacteristic(this.hap.Characteristic.LockTargetState, this.hap.Characteristic.LockTargetState.SECURED);
      lockService.updateCharacteristic(this.hap.Characteristic.LockCurrentState, this.hap.Characteristic.LockCurrentState.SECURED);

      // Delete the timer from our event tracker.
      this.eventTimers.delete(key);
    }, ACCESS_UNLOCK_DURATION));
  }

  // Doorbell authentication delivery, relocated from the doorbell leaf's now-deleted add-event handler. A fingerprint match or NFC card tap trips the doorbell's
  // authentication contact sensor when the scan resolved a known identity, then resets it to its detected (resting) state after a brief window. The classification -
  // which method this scan used - is v5's: we consume event.method rather than re-derive it, the single source for fingerprint-vs-NFC (this restores v4 parity exactly,
  // where the leaf keyed the method off the wire type). The delivery policy stays ours: whether the scan resolved an identity is a metadata read here, and the
  // "authenticate" MQTT publish fires regardless of whether the contact service is configured - the service is off by default, but the side-channel is not gated on it,
  // so only the characteristic writes are service-gated.
  public authEventHandler(protectDevice: ProtectCamera, method: AuthMethod, metadata?: ProtectEventMetadata): void {

    // Resolve the authentication contact sensor, if the user configured it. The optional-chained characteristic writes below make a disabled sensor a clean no-op while
    // the MQTT publish still fires - the v4 parity this delivery must preserve.
    const authService = protectDevice.accessory.getServiceById(this.hap.Service.ContactSensor, ProtectReservedNames.CONTACT_AUTHSENSOR);

    // A new scan supersedes any pending reset, so we clear the inflight timer before acting - the same debounce the access delivery uses.
    const key = protectDevice.id + ".Doorbell.Auth";

    if(this.eventTimers.has(key)) {

      clearTimeout(this.eventTimers.get(key));
      this.eventTimers.delete(key);
    }

    // A scan that resolved no known identity - neither a matched fingerprint nor a matched card - leaves the sensor in its detected (not-authenticated) resting state and
    // publishes nothing: it is an attempt, not an authentication.
    if(!metadata?.fingerprint?.ulpId && !metadata?.nfc?.ulpId) {

      authService?.updateCharacteristic(this.hap.Characteristic.ContactSensorState, this.hap.Characteristic.ContactSensorState.CONTACT_DETECTED);

      return;
    }

    // A recognized identity: trip the sensor to its not-detected (authenticated) state.
    authService?.updateCharacteristic(this.hap.Characteristic.ContactSensorState, this.hap.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED);

    // Publish the credential to MQTT regardless of the sensor's presence (v4 parity). The method is the classifier's; a card tap additionally carries its card id, read
    // from the metadata here at delivery.
    const authInfo = (method === "nfc") ? { id: metadata.nfc?.nfcId ?? "", type: "nfc" } : { type: "fingerprint" };

    void this.nvr.mqtt?.publish(mqttTopic(protectDevice.ufp.mac, "authenticate"), JSON.stringify(authInfo));

    // Reset the sensor to its resting state after the auth window, so HomeKit shows a momentary authentication rather than a latched one.
    this.eventTimers.set(key, setTimeout(() => {

      authService?.updateCharacteristic(this.hap.Characteristic.ContactSensorState, this.hap.Characteristic.ContactSensorState.CONTACT_DETECTED);
      this.eventTimers.delete(key);
    }, PROTECT_DOORBELL_AUTHSENSOR_DURATION));
  }

  // Camera tamper delivery, relocated from the camera leaf's now-deleted add-event handler. A tamper occurrence latches the camera tampered and trips StatusTampered on
  // its motion sensor. The latch is one-way - UniFi Protect emits no paired "tamper cleared" occurrence and the camera config carries no tamper-state field, so the
  // occurrence is its only source - and it clears only when the user toggles tamper detection in Protect (which resets isTampered through configureTamperDetection) or
  // restarts HBUP. We set a public flag on the camera, mirroring how the doorbell-ring delivery sets isRinging, so the camera's own tamper-detection onGet and
  // availability projection read back a single source of truth.
  public tamperEventHandler(protectDevice: ProtectCamera): void {

    // Idempotent: once latched, a repeat tamper occurrence is a no-op until the state is cleared, matching the v4 leaf's "only act on the false-to-true edge".
    if(protectDevice.isTampered) {

      return;
    }

    protectDevice.isTampered = true;
    protectDevice.accessory.getService(this.hap.Service.MotionSensor)?.updateCharacteristic(this.hap.Characteristic.StatusTampered, true);
    protectDevice.log.info("Tamper event detected. To clear the indicator, toggle tamper detection in the Protect web UI or restart HBUP.");
  }

  // Controller telemetry republisher. Mirrors v4's telemetry publish: every frame the controller emits is republished verbatim to the controller's "telemetry" MQTT
  // topic when the user has opted in. We consume client.rawPackets() - the raw realtime firehose - rather than the classified client.events() stream deliberately:
  // rawPackets carries the valid-but-unmodeled frames the classifier drops, so this preserves v4 parity where the typed stream would silently narrow telemetry. Self-
  // gated on the controller-scoped feature option, resolved post-connect (reading it pre-connect, against an unknown controller mac, was the v4 crash): a disabled
  // controller returns immediately and never opens the raw iterator. The caller binds this to the NVR's terminal shutdown signal; the loop ends quietly on abort.
  public async publishTelemetry(signal: AbortSignal): Promise<void> {

    if(!this.nvr.hasFeature("Nvr.Publish.Telemetry")) {

      return;
    }

    // Telemetry is off by default, so opting in is a user deviation worth surfacing once when the publisher starts.
    this.log.info("Protect controller telemetry enabled.");

    for await (const packet of this.nvr.client.rawPackets({ signal })) {

      void this.nvr.mqtt?.publish(mqttTopic(this.nvr.ufp.mac, "telemetry"), JSON.stringify(packet));
    }
  }
}
