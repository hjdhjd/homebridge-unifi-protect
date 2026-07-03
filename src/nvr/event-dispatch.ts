/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * event-dispatch.ts: Typed event-firehose router and HomeKit delivery for UniFi Protect.
 */
import type { AuthMethod, ProtectEventMetadata, ProtectEventMetadataDetectedThumbnail, TypedEvent } from "unifi-protect";
import type { HAP, Service } from "homebridge";
import type { HomebridgePluginLogging, Nullable } from "homebridge-plugin-utils";
import { PROTECT_DOORBELL_AUTHSENSOR_DURATION, PROTECT_DOORBELL_TRIGGER_DURATION } from "../settings.ts";
import type { FirehoseDispatchPayload } from "../diagnostics.ts";
import type { ProtectCamera } from "../devices/cameras/camera.ts";
import type { ProtectDevice } from "../devices/device.ts";
import type { ProtectNvr } from "./nvr.ts";
import { ProtectReservedNames } from "../types.ts";
import { SMART_DETECT_ENRICHERS } from "./smart-detect-metadata.ts";
import type { SmartDetectEventItem } from "./smart-detect-metadata.ts";
import { channels } from "../diagnostics.ts";
import { mqttTopic } from "../mqtt.ts";

/**
 * The controller's typed event surface, projected onto HomeKit. A thin router over the classified event firehose, plus the HomeKit delivery methods that router
 * drives. Controller-state merge, packet re-emit, and per-id fan-out belong to the unifi-protect library's reducer and observe loops; what lives here is purely the
 * routing and delivery.
 *
 *   - `run()` is one controller-level consumer of `client.events()` - the typed, classified firehose. It switches on the discriminated `kind` and dispatches each
 *     activity occurrence (smart detection, doorbell ring, tamper, Access doorbell ring, doorbell auth) to the addressed accessory's delivery method. State transitions
 *     (deviceAdded/devicePatched/...) are the NVR observe loops' concern and are ignored here. Bare camera motion is NOT routed here: the controller signals it only as a
 *     `lastMotion` device-state advance with no occurrence packet, so the camera leaf observes that field directly, exactly as the sensor and light families do.
 *   - `publishTelemetry()` is the controller telemetry republisher: every raw frame off `client.rawPackets()` is mirrored to MQTT when the user opts in.
 *   - the delivery methods (`motionEventHandler`, `doorbellEventHandler`) own the HomeKit-facing behavior - the characteristic writes, the reset timers, and the MQTT
 *     side-channels - while `accessEventHandler` maps a UniFi Access intercom doorbell press onto that same doorbell ring delivery rather than owning a path of its own.
 *     Their *trigger* is the typed firehose: each delivery fires on a discriminated event kind.
 *
 * A plain class, not an EventEmitter: nothing here emits. The accessory leaves call the delivery methods directly through `nvr.events`, and the router and telemetry
 * publisher are spawned as NVR observe loops, so no event bus survives. The controller's systemInfo is consumed the same way, through a narrow `client.state.observe`
 * loop over that slice rather than through an event subscriber.
 */
export class ProtectEventDispatch {

  private hap: HAP;
  private log: HomebridgePluginLogging;
  private nvr: ProtectNvr;
  private readonly eventTimers: Map<string, NodeJS.Timeout>;
  private readonly smartDetectLoggedAttributes: Map<string, number>;

  // Initialize an instance of our Protect event dispatcher.
  constructor(nvr: ProtectNvr) {

    // Structural wiring only. This constructor runs inside ProtectNvr's constructor, before connect(), where neither the controller mac nor a live client exists yet,
    // so controller-state-dependent setup cannot happen here - reading the telemetry feature option (which resolves against the controller mac) and binding the realtime
    // packet consumers both need a connected controller. That work lives in the NVR's loops - the typed firehose router (run) and the telemetry publisher
    // (publishTelemetry) below, both spawned post-connect and bound to the shutdown signal - so this stays a plain field-initializer and the controller-scoped work
    // happens when those loops start.
    this.eventTimers = new Map();
    this.hap = nvr.platform.api.hap;
    this.log = nvr.log;
    this.nvr = nvr;
    this.smartDetectLoggedAttributes = new Map();
  }

  // The typed-firehose router. One controller-level consumer of the classified event stream: each event arrives already modeled (the unifi-protect library owns the
  // decode and classification), so we switch on the discriminated kind and route each activity occurrence to the addressed accessory's HomeKit delivery method. The
  // caller binds this to the NVR's terminal shutdown signal; the loop ends quietly when that signal aborts (the library smooths the caller's own abort into a clean
  // return).
  public async run(signal: AbortSignal): Promise<void> {

    for await (const event of this.nvr.client.events({ signal })) {

      switch(event.kind) {

        case "smartDetect": {

          // A smart-object detection, delivered as a motion event carrying the detected object types and metadata, but only when the user has smart detection enabled
          // and the occurrence still describes something after the thumbnail filter below - a populated object-type list or surviving thumbnail detections.
          const camera = this.cameraFor(event.cameraId);

          if(!camera?.hints.smartDetect) {

            break;
          }

          // The thumbnail filter: with "Create motion events" enabled on the camera, Protect tags some detections as plain "motion" inside a smart event's thumbnails;
          // those are not true smart detections, so we drop them - building a filtered copy rather than mutating the classifier's metadata - before both the has-anything
          // gate and the delivery. The firehose metadata structurally satisfies the plugin's richer ProtectEventMetadata shape (the one home that knows the delivery
          // reads detectedThumbnails off it), so it flows in without a cast.
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
          this.doorbellEventHandler(camera);

          break;
        }

        case "accessEvent": {

          // A UniFi Access occurrence surfaced through Protect. We route it to the access delivery, which surfaces an intercom doorbell press as a HomeKit doorbell ring.
          const camera = this.cameraFor(event.deviceId);

          if(!camera) {

            break;
          }

          this.publishDispatch(event.kind, event.deviceId);
          this.accessEventHandler(camera, event.action);

          break;
        }

        case "authDetected": {

          // A doorbell fingerprint match or NFC card tap. We route it to the auth delivery, which trips the doorbell's authentication contact sensor on a recognized
          // identity. The unifi-protect library owns classification; this is delivery only - the kind already tells us it is an auth scan, and the matched identity is a
          // metadata read below.
          const camera = this.cameraFor(event.cameraId);

          if(!camera) {

            break;
          }

          this.publishDispatch(event.kind, event.cameraId);
          this.authEventHandler(camera, event.method, event.metadata);

          break;
        }

        case "buttonPressed": {

          // A security-action button was pressed on a fob (or a sensor-with-button). A button press is a firehose occurrence, so the router delivers it - resolving the
          // target by id and addressing its subtyped StatelessProgrammableSwitch service, exactly as the smart-detect delivery addresses a subtyped contact sensor. The
          // delivery is device-family-agnostic and needs no device-class import: it reads only the base accessory / mac / log surface, so a future button-bearing device
          // rides the same path. A device lingering in the removal grace (recordPresent false) routes nothing.
          const device = this.nvr.getDeviceById(event.deviceId);

          if(!device?.recordPresent) {

            break;
          }

          this.publishDispatch(event.kind, event.deviceId);
          this.buttonEventHandler(device, event.button, event.pressType);

          break;
        }

        default: {

          // State transitions (deviceAdded / devicePatched / deviceRemoved / bootstrapLoaded) are the NVR observe loops' concern; the router ignores them. A firehose
          // motionDetected also lands here: bare camera motion is observed off the camera record's lastMotion device-state field, so the only motionDetected the
          // controller emits is the non-realtime event/type:motion thumbnail path, which carries no genuine smart detection and is correctly ignored here.
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

    // Address the camera only when its controller record is still present and it is a camera. A device lingering in the removal grace (recordPresent false) routes no
    // delivery - the firehose would otherwise address a record on its way out - and a non-camera match (or an unconfigured id) stays a clean no-op, both read through the
    // non-throwing identity accessors.
    if(!device || !device.recordPresent || (device.modelKey !== "camera")) {

      return null;
    }

    return device as ProtectCamera;
  }

  // Publish a firehose-dispatch milestone on the forward-only diagnostics channel when a routed activity event reaches a delivery method. Zero-cost when no subscriber
  // is attached (the Node-native sync check), mirroring the NVR's other diagnostics publishers.
  private publishDispatch(kind: TypedEvent["kind"], cameraId?: string): void {

    if(channels.firehoseDispatch.hasSubscribers) {

      channels.firehoseDispatch.publish({ cameraId, kind } satisfies FirehoseDispatchPayload);
    }
  }

  // Drop "motion"-tagged thumbnails from smart-detection metadata, returning a filtered copy and never mutating the classifier's object. When a camera has Protect's
  // "Create motion events" setting on, Protect emits motion-typed thumbnails alongside genuine smart detections; those are plain motion, not smart objects, so we strip
  // them before delivery. Metadata without thumbnails (or absent entirely) passes through untouched.
  private withoutMotionThumbnails(metadata?: ProtectEventMetadata): ProtectEventMetadata | undefined {

    if(!metadata?.detectedThumbnails) {

      return metadata;
    }

    return { ...metadata, detectedThumbnails: metadata.detectedThumbnails.filter(({ type }) => type !== "motion") };
  }

  /* Clear every event timer keyed to a device id, with exact-boundary semantics: a timer belongs to the device when its key IS the id or extends it as "id." -
   * never a bare prefix match. HAZARD, documented for every future caller: the package camera's id is itself the PARENT's id plus a ".PackageCamera" segment, which
   * matches the parent's own "id." subkey shape - so calling this with a PARENT id sweeps the package's timers too, and it must never be called with a parent id
   * expecting package isolation. Returns whether an inflight bare-motion timer existed for the id exactly - the fact the package detach needs in order to decide
   * whether the terminal MQTT motion reset must be published on the shared parent topic, since the cleared reset timer would otherwise have owned that publish.
   *
   * We sweep the smart-detection logged-attribute high-water marks under the same exact-boundary rule, so they share the timers' lifetime and never orphan across a
   * device detach and re-add - a stale high-water would otherwise suppress the first enriched log of the re-added device's next motion window.
   */
  public clearEventTimersForDevice(id: string): boolean {

    const hadInflightMotion = this.eventTimers.has(id);

    for(const [ key, timer ] of this.eventTimers) {

      if((key === id) || key.startsWith(id + ".")) {

        clearTimeout(timer);
        this.eventTimers.delete(key);
      }
    }

    for(const key of this.smartDetectLoggedAttributes.keys()) {

      if((key === id) || key.startsWith(id + ".")) {

        this.smartDetectLoggedAttributes.delete(key);
      }
    }

    return hadInflightMotion;
  }

  // Whether an inflight bare-motion timer exists for a device id exactly. The bare-motion timer is keyed by the id alone (subkeyed timers - smart detections,
  // occupancy, rings - never match), so this is precisely "is this device's MotionDetected latched with a pending reset". The package detach reads the PARENT's
  // state through this: when the parent holds its own inflight motion, the parent's reset timer will publish the shared topic's terminal "false" and the detach
  // must not publish a premature one.
  public hasInflightMotion(id: string): boolean {

    return this.eventTimers.has(id);
  }

  // Motion event processing from UniFi Protect.
  public motionEventHandler(protectDevice: ProtectDevice, detectedObjects: string[] = [], metadata?: ProtectEventMetadata): void {

    // Only proceed if a motion sensor service exists; the active/detectMotion gate is applied downstream in motionEventDelivery.
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
      void this.nvr.mqtt?.publish(mqttTopic(protectDevice.mac, "motion"), "true");

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
      void this.nvr.mqtt?.publish(mqttTopic(protectDevice.mac, "motion"), "false");

      // Delete the timer from our motion event tracker.
      this.eventTimers.delete(protectDevice.id);
    }, protectDevice.hints.motionDuration * 1000));

    // We build a unified list of the object events we're interested in: legacy smart detections first, followed by thumbnail-based detections.
    const smartEvents: SmartDetectEventItem[] = [];

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

    // Plain object types (no per-type enricher, or none with attributes yet) newly detected this delivery. We coalesce these onto one log line after the loop, so a
    // simultaneous animal/face/person detection reads as a single entry rather than three lines. Types that carry rich metadata log on their own enriched line instead,
    // so the coalesced line stays a clean list of bare object types - and we track which types produced an enriched line so the same type, when it arrives both bare (via
    // objectTypes) and enriched (via detectedThumbnails) in one firehose payload, is not also listed on the coalesced line.
    const coalescedTypes: string[] = [];
    const enrichedTypes = new Set<string>();

    // Iterate over the smart events that Protect has detected.
    for(const event of smartEvents) {

      const key = protectDevice.id + ".Motion.SmartDetect.ObjectSensors." + event.type;

      // A retrigger within the motion window must re-arm the reset timer below but never re-trip the sensor or re-announce on MQTT, so the once-per-window side
      // effects are gated on this being a newly-seen detection.
      const isNewDetection = !this.eventTimers.has(key);

      // We have a new event, let's make sure we trigger our sensors only once.
      if(isNewDetection) {

        // These sensors only get triggered if they actually exist on the accessory.
        protectDevice.accessory.getServiceById(this.hap.Service.ContactSensor, ProtectReservedNames.CONTACT_MOTION_SMARTDETECT + "." + event.type)?.
          updateCharacteristic(this.hap.Characteristic.ContactSensorState, this.hap.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED);

        // Publish the smart detection event to MQTT, if the user has configured it.
        void this.nvr.mqtt?.publish(mqttTopic(protectDevice.mac, "motion/smart/" + event.type), "true");
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
        void this.nvr.mqtt?.publish(mqttTopic(protectDevice.mac, "motion/smart/" + event.type), "false");
        protectDevice.log.debug("Resetting smart object motion event.");

        // Delete the timer and the logged-attribute high-water mark so the next motion window for this type starts fresh.
        this.eventTimers.delete(key);
        this.smartDetectLoggedAttributes.delete(key);
      }, protectDevice.hints.motionDuration * 1000));

      // Vehicles can carry a license plate. If the user has configured a contact sensor for a specific plate, trip the matching one. This per-plate contact-sensor
      // feature (the SmartDetect.ObjectSensors.LicensePlate option) is independent of the log and MQTT metadata rendering below, which the per-type enricher owns.
      if((event.type === "vehicle") && event.name) {

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

      // Render this detection's rich metadata through its per-type enricher, if one exists. A type with no enricher - or an enricher that has produced nothing yet - is a
      // plain detection: we coalesce its bare type name onto the shared line below, once per window, recording a zero high-water mark so an enrichment-capable type that
      // starts bare can still grow past it and log its attributes when they arrive.
      const enricher = SMART_DETECT_ENRICHERS.get(event.type);
      const attributes = enricher?.attributes(event) ?? [];

      if(!attributes.length) {

        if(isNewDetection) {

          this.smartDetectLoggedAttributes.set(key, 0);
          coalescedTypes.push(event.type);
        }

        continue;
      }

      // We have rich metadata. To suppress the in-window noise while still surfacing the fullest telemetry, we act only when the attribute set strictly grows beyond what
      // we last rendered for this detection (the first detection included, since the high-water mark is absent until then). The controller commonly reads a vehicle's
      // plate, color, and type a beat after the initial detection, so this logs the enriched line as it fills in rather than on every update.
      if(attributes.length <= (this.smartDetectLoggedAttributes.get(key) ?? 0)) {

        continue;
      }

      this.smartDetectLoggedAttributes.set(key, attributes.length);

      // This type now owns an enriched line for the delivery, so it must be excluded from the coalesced bare line below even if it was also seen bare via objectTypes.
      enrichedTypes.add(event.type);

      // Publish the structured metadata to MQTT on the same footing as the other motion/smart MQTT topics: gated on MQTT being configured, NOT on the console-logging
      // hint. The strictly-grows dedup above is what keeps the channel quiet; logMotion governs only the human-facing log line below.
      const mqttPayload = enricher?.mqtt(event);

      if(mqttPayload) {

        void this.nvr.mqtt?.publish(mqttTopic(protectDevice.mac, "motion/smart/" + event.type + "/metadata"), JSON.stringify(mqttPayload));
      }

      // Log the enriched line, if the user has opted into motion logging.
      if(protectDevice.hints.logMotion) {

        protectDevice.log.info("Smart motion detected: %s (%s).", event.type, attributes.join(", "));
      }
    }

    // Emit the coalesced line once for everything newly detected this delivery that carries no rich metadata, excluding any type that already logged its own enriched
    // line.
    const coalescedLine = coalescedTypes.filter(type => !enrichedTypes.has(type));

    if(coalescedLine.length && protectDevice.hints.logMotion) {

      protectDevice.log.info("Smart motion detected: %s.", coalescedLine.join(", "));
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
          void this.nvr.mqtt?.publish(mqttTopic(protectDevice.mac, "occupancy"), "true");

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
          void this.nvr.mqtt?.publish(mqttTopic(protectDevice.mac, "occupancy"), "false");

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
  public doorbellEventHandler(protectDevice: ProtectCamera): void {

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
    void this.nvr.mqtt?.publish(mqttTopic(protectDevice.mac, "doorbell"), "true");

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

      void this.nvr.mqtt?.publish(mqttTopic(protectDevice.mac, "doorbell"), "false");

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

  // Deliver a UniFi Access occurrence to HomeKit. The only modeled Access occurrence today is a door_bell intercom press, which we surface as a doorbell ring through the
  // shared doorbell delivery (the HomeKit ding, the trigger switch, and the MQTT side-channel), exactly as a native Protect doorbell ring.
  public accessEventHandler(protectDevice: ProtectCamera, action: string): void {

    if(action === "door_bell") {

      this.doorbellEventHandler(protectDevice);
    }
  }

  // Doorbell authentication delivery. A fingerprint match or NFC card tap trips the doorbell's authentication contact sensor when the scan resolved a known identity,
  // then resets it to its detected (resting) state after a brief window. The unifi-protect library owns the classification - which method this scan used - so we consume
  // event.method rather than re-derive it, the single source for fingerprint-vs-NFC. The delivery policy stays ours: whether the scan resolved an identity is a
  // metadata read here, and the "authenticate" MQTT publish fires regardless of whether the contact service is configured - the service is off by default, but the
  // side-channel is not gated on it, so only the characteristic writes are service-gated.
  public authEventHandler(protectDevice: ProtectCamera, method: AuthMethod, metadata?: ProtectEventMetadata): void {

    // Resolve the authentication contact sensor, if the user configured it. The optional-chained characteristic writes below make a disabled sensor a clean no-op while
    // the MQTT publish still fires.
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

    // Publish the credential to MQTT regardless of the sensor's presence. The method is the classifier's; a card tap additionally carries its card id, read from the
    // metadata here at delivery.
    const authInfo = (method === "nfc") ? { id: metadata.nfc?.nfcId ?? "", type: "nfc" } : { type: "fingerprint" };

    void this.nvr.mqtt?.publish(mqttTopic(protectDevice.mac, "authenticate"), JSON.stringify(authInfo));

    // Reset the sensor to its resting state after the auth window, so HomeKit shows a momentary authentication rather than a latched one.
    this.eventTimers.set(key, setTimeout(() => {

      authService?.updateCharacteristic(this.hap.Characteristic.ContactSensorState, this.hap.Characteristic.ContactSensorState.CONTACT_DETECTED);
      this.eventTimers.delete(key);
    }, PROTECT_DOORBELL_AUTHSENSOR_DURATION));
  }

  // Camera tamper delivery. A tamper occurrence latches the camera tampered and trips StatusTampered on its motion sensor. The latch is one-way - UniFi Protect emits no
  // paired "tamper cleared" occurrence and the camera config carries no tamper-state field, so the occurrence is its only source - and it clears only when the user
  // toggles tamper detection in Protect (which resets isTampered through configureTamperDetection) or restarts the plugin. We set a public flag on the camera, mirroring
  // how the doorbell-ring delivery sets isRinging, so the camera's own tamper-detection onGet and availability projection read back a single source of truth.
  public tamperEventHandler(protectDevice: ProtectCamera): void {

    // Idempotent: once latched, a repeat tamper occurrence is a no-op until the state is cleared - we act only on the false-to-true edge.
    if(protectDevice.isTampered) {

      return;
    }

    protectDevice.isTampered = true;

    // Guard the StatusTampered push behind testCharacteristic: updateCharacteristic lazily materializes an absent optional characteristic, so an unguarded write on a
    // camera without tamper detection would sprout an always-false phantom. The isTampered latch above stays the single source of truth - the camera's tamper-detection
    // onGet and its availability projection both read it back - so a camera with no StatusTampered characteristic still records the latch even though we skip the push.
    const motionSensor = protectDevice.accessory.getService(this.hap.Service.MotionSensor);

    if(motionSensor?.testCharacteristic(this.hap.Characteristic.StatusTampered)) {

      motionSensor.updateCharacteristic(this.hap.Characteristic.StatusTampered, true);
    }

    protectDevice.log.info("Tamper event detected. To clear the indicator, toggle tamper detection in the Protect web UI or restart HBUP.");
  }

  // Fob button-press delivery. A press fires the addressed button's programmable-switch event in HomeKit, mapping the wire gesture to a single/double/long press value.
  // The MQTT publish comes FIRST and is faithful to the firehose: it fires for every delivered press, including a hidden or unrecognized button and an unmapped gesture,
  // so an automation on the raw press is never gated on which HomeKit switches happen to exist. The button subtype is addressed by the LOWERCASE wire id - the identical
  // convention the fob leaf creates its switches under - so a hidden or unknown button resolves no service and the optional-chained notification is a clean no-op. We use
  // sendEventNotification, never updateCharacteristic: a stateless programmable switch carries no persistent value, so this pushes the notification without caching
  // state, and identical rapid presses each notify.
  public buttonEventHandler(protectDevice: ProtectDevice, button: string, pressType: string): void {

    // Publish the raw press first, faithful to the firehose - hidden and unknown buttons and unmapped gestures all publish.
    void this.nvr.mqtt?.publish(mqttTopic(protectDevice.mac, "button"), JSON.stringify({ button, pressType }));

    // Map the wire gesture to a HomeKit press value. An unrecognized gesture is field-diagnosable, so we surface it at info (not debug) - a wrong wire assumption would
    // otherwise silently no-op the HomeKit half - and deliver nothing further.
    const value = this.pressValue(pressType);

    if(value === null) {

      protectDevice.log.info("Received an unrecognized fob button gesture: %s.", pressType);

      return;
    }

    // Fire the addressed button's programmable-switch event. An absent service (a hidden or unknown button) makes the optional chain a clean no-op.
    protectDevice.accessory.getServiceById(this.hap.Service.StatelessProgrammableSwitch, ProtectReservedNames.SWITCH_FOB_BUTTON + "." + button)?.
      getCharacteristic(this.hap.Characteristic.ProgrammableSwitchEvent).sendEventNotification(value);
  }

  // Map a fob's wire press gesture to HomeKit's ProgrammableSwitchEvent value, or null for an unrecognized gesture. The null sentinel is load-bearing: SINGLE_PRESS is 0,
  // which is falsy, so the caller MUST test the result against null rather than truthiness or every single press would be swallowed. The unifi-protect library owns the
  // classification; this is the plugin's translation of that classification onto HomeKit's fixed press values.
  private pressValue(pressType: string): Nullable<number> {

    switch(pressType) {

      case "doublePress": {

        return this.hap.Characteristic.ProgrammableSwitchEvent.DOUBLE_PRESS;
      }

      case "longPress": {

        return this.hap.Characteristic.ProgrammableSwitchEvent.LONG_PRESS;
      }

      case "press": {

        return this.hap.Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS;
      }

      default: {

        return null;
      }
    }
  }

  // Controller telemetry republisher. Every frame the controller emits is republished verbatim to the controller's "telemetry" MQTT topic when the user has opted in. We
  // consume client.rawPackets() - the raw realtime firehose - rather than the classified client.events() stream deliberately: rawPackets carries the valid-but-unmodeled
  // frames the classifier drops, so the typed stream would silently narrow telemetry. Self-gated on the controller-scoped feature option, resolved post-connect (the
  // controller mac it resolves against is unknown before connect): a disabled controller returns immediately and never opens the raw iterator. The caller binds this to
  // the NVR's terminal shutdown signal; the loop ends quietly on abort.
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
