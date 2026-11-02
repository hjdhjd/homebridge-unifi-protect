/* Copyright(C) 2019-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * sensor.ts: Sensor device class for UniFi Protect.
 */
import type { AcquireServiceTarget, CharacteristicTarget, MqttTopicEntry, Nullable } from "homebridge-plugin-utils";
import { DISABLED_THRESHOLD_SETTINGS, DISABLED_VAPE_SENSITIVITY, NOT_CAPABLE_AIR_QUALITY, NO_READING, airQualityLevel, airQualityMetricLive,
  airQualityMetricReading, airQualityReporting, airQualitySensorCapable, co2AlertDetected, environmentalReading, environmentalServiceGate,
  vapeDetected } from "./air-quality-policy.ts";
import type { HAP, Service, WithUUID } from "homebridge";
import type { ProtectAccessory, WithoutIdentity } from "../types.ts";
import type { ProtectAirQualityMetric, ProtectAirQualityThresholdSettings, ProtectSensorAirQuality, ProtectSensorConfig, ProtectSensorSmokeStatus,
  Sensor } from "unifi-protect";
import { SMOKE_ALARM_TYPES, carbonMonoxideDetected, carbonMonoxideFault, carbonMonoxideFaultReasons, smokeAlarmCapable, smokeDetected, smokeDetectorHardware,
  smokeFault, smokeFaultReasons } from "./smoke-policy.ts";
import type { SmokeAlarmType, SmokeFaultReason } from "./smoke-policy.ts";
import { capabilityGate, mqttGetTopic, presenceChanged, sameEntries, updatePresenceCharacteristic, updateServices } from "homebridge-plugin-utils";
import type { LeakChannelContext } from "./leak-policy.ts";
import type { ProtectConfigurePass } from "./device.ts";
import { ProtectDevice } from "./device.ts";
import type { ProtectNvr } from "../nvr/nvr.ts";
import { ProtectReservedNames } from "../types.ts";
import { leakChannelEnabled } from "./leak-policy.ts";
import { mqttTopics } from "../mqtt.ts";

/**
 * Map a sensor's tampering timestamp to its HomeKit StatusTampered state: tampered when the controller has recorded a tampering time, clear when it has not. The single
 * source of truth is the projection's tamperingDetectedAt; this pure mapping is shared by the StatusTampered onGet, the initial write, and the reactive tamper observer,
 * so the read-through and the push can never disagree on what "tampered" means.
 *
 * @param tamperingDetectedAt - The sensor's tamperingDetectedAt: the epoch-ms time tampering was last detected, or null when none has been.
 *
 * @returns true when the sensor should report tampering to HomeKit.
 */
export function sensorTamperState(tamperingDetectedAt: number | null): boolean {

  return tamperingDetectedAt !== null;
}

/**
 * Map an alarm-family row's latched timestamp to its HomeKit ContactSensorState: alarm when the controller has recorded a trigger time, clear when it has not. The
 * source of truth for a row is the projection field its descriptor names - alarmTriggeredAt for the alarm-sound contact, glassBreakTriggeredAt for the glass-break
 * contact - which the controller clears only on explicit user action in the Protect app, never automatically, and clears as a pair when the user clears from the
 * sensor's detail page. Every alarm-family row reads through this one predicate, so a row's read-through getter and its reactive push can never disagree on what "alarm"
 * means. Kept deliberately distinct from sensorTamperState because it reads a different family of fields and capability and may later honor alarmSilencedAt; it is not
 * collapsed into a generic latched-field predicate.
 *
 * @param triggeredAt - The row's latched timestamp: the epoch-ms time this alarm kind was last triggered, or null when none has been.
 *
 * @returns true when the sensor should report an alarm to HomeKit.
 */
export function sensorAlarmState(triggeredAt: number | null): boolean {

  return triggeredAt !== null;
}

/**
 * Decide whether a condition's current reading is worth a sentence, given the last reading we narrated for it.
 *
 * The rule every transition-logged condition on this accessory shares, in one place: on the FIRST reading of a service's lifetime we save the state silently when
 * nothing is happening and speak up when the condition is already under way - a user restarting Homebridge mid-detection should be told what the sensor is reporting -
 * and after that only a genuine change earns a line. The leak sensor, the vape sensor, and each of the smoke detector's narrated conditions read through here, so none
 * of them can drift into re-announcing a state on every reconcile (a busy sensor can see one every second or two in the field).
 *
 * Generic over the reading's type so a boolean condition (quiet false) and a fault-reason key (quiet the empty string) share one rule rather than a copy apiece. An
 * options object rather than positional arguments because a swapped pair of same-typed members would compile silently.
 *
 * @param options - previous: the last reading narrated, or undefined when nothing has been; quiet: the reading that means nothing is happening; value: the current
 *                  reading.
 *
 * @returns true when the reading should be narrated.
 */
export function narratesTransition<T>(options: { previous: T | undefined; quiet: T; value: T }): boolean {

  return (options.previous === undefined) ? (options.value !== options.quiet) : (options.value !== options.previous);
}

// The static description of the alarm family's HomeKit contact sensors - the single source for which alarm-family services exist and their latched record field, gate,
// display label, log subject, MQTT catalog entry, name suffix, and reserved subtype. Each row reads and watches the one field named by its own field member, so this
// descriptor is read by the create/gate path (configureAlarmContactSensors), the per-row reactive push (updateAlarmState), the per-row observer registration
// (spawnObservers), and the MQTT gets (configureMqtt), keeping the enabled-sensors log, the services actually created, the fields watched, and the topics registered
// from ever disagreeing. label is the enabled-sensors noun phrase and log is the transition-log subject word - two distinct display strings for two distinct sentences,
// so both are sourced here. A future alarm-family member is one more row, and its own latched field comes with it.
interface AlarmContactDescriptor {

  readonly field: "alarmTriggeredAt" | "glassBreakTriggeredAt";
  readonly gate: (config: Readonly<WithoutIdentity<ProtectSensorConfig>>) => boolean;
  readonly label: string;
  readonly log: string;
  readonly mqtt: MqttTopicEntry;
  readonly subtype: string;
  readonly suffix: string;
}

// The alarm-family rows, alarm sound first so its position in the enabled-sensors log stays stable. Each gate mirrors its twin's controller enable signal: the
// alarm-sound settings toggle, and the glass-break capability channel being present AND its own settings toggle enabled.
const SENSOR_ALARM_CONTACTS: readonly AlarmContactDescriptor[] = [

  { field: "alarmTriggeredAt", gate: (config) => config.alarmSettings.isEnabled, label: "alarm sound", log: "Alarm", mqtt: mqttTopics.alarm,
    subtype: ProtectReservedNames.CONTACT_SENSOR_ALARM_SOUND, suffix: " Alarm Sound" },
  { field: "glassBreakTriggeredAt", gate: (config) => (config.featureFlags.glassBreak !== undefined) && config.glassBreakSettings.isEnabled, label: "glass break",
    log: "Glass break", mqtt: mqttTopics.glassbreak, subtype: ProtectReservedNames.CONTACT_SENSOR_GLASS_BREAK, suffix: " Glass Break" }
];

// The noun phrases a fault sentence prints for each flag the smoke leaf hands back. Presentation lives here in the device layer because the leaf deals only in typed
// tags; a phrase is deliberately shared wherever the wire flag behind it would mean nothing to a user, who reads that a sensor is reporting a sensor fault and does not
// care which flag carried it. This is the same separation the alarm table's label / log pair draws one level up.
const SMOKE_FAULT_LABELS: Readonly<Record<SmokeFaultReason, string>> = { cleanSmokeSensor: "needs cleaning", coSensorFault: "sensor fault",
  endOfLife: "end of life", smokeSensorFault: "sensor fault" };

// The static description of the smoke detector's HomeKit sensors - the single source for which smoke-family services exist and their gate, display label, log subject,
// and MQTT catalog entry. It is read by the configure loop and by the MQTT gets, which keeps the enabled-sensors log, the services actually created, and the topics
// registered from ever disagreeing. label is the enabled-sensors noun phrase and log is the transition-log subject word - two distinct display strings for two distinct
// sentences, so both are sourced here, exactly as the alarm table keeps them apart. There is no subtype member: each of these service classes is acquired once on an
// accessory, so the class itself identifies the service. The service and characteristic classes are resolved through hap at call time because this table is
// module-scoped while hap is a per-accessory handle.
interface SmokeAlarmDescriptor {

  readonly alarmType: SmokeAlarmType;
  readonly characteristic: (hap: HAP) => CharacteristicTarget;
  readonly detected: (status: ProtectSensorSmokeStatus) => boolean;
  readonly fault: (status: ProtectSensorSmokeStatus) => boolean;
  readonly faultReasons: (status: ProtectSensorSmokeStatus) => SmokeFaultReason[];
  readonly label: string;
  readonly log: string;
  readonly mqtt: MqttTopicEntry;
  readonly service: (hap: HAP) => AcquireServiceTarget;
}

// The smoke-family rows, in label order so their pair reads alphabetically wherever the enabled-sensors line lists them together.
const SENSOR_SMOKE_ALARMS: readonly SmokeAlarmDescriptor[] = [

  { alarmType: SMOKE_ALARM_TYPES.carbonMonoxide, characteristic: (hap) => hap.Characteristic.CarbonMonoxideDetected, detected: carbonMonoxideDetected,
    fault: carbonMonoxideFault, faultReasons: carbonMonoxideFaultReasons, label: "carbon monoxide", log: "Carbon monoxide", mqtt: mqttTopics.carbonmonoxide,
    service: (hap) => hap.Service.CarbonMonoxideSensor },
  { alarmType: SMOKE_ALARM_TYPES.smoke, characteristic: (hap) => hap.Characteristic.SmokeDetected, detected: smokeDetected, fault: smokeFault,
    faultReasons: smokeFaultReasons, label: "smoke", log: "Smoke", mqtt: mqttTopics.smoke, service: (hap) => hap.Service.SmokeSensor }
];

// What we last narrated for one alarm type: the detection state, and the fault sentence's reason key - the typed reasons joined by a comma, the empty string when the
// service reports nothing wrong. One record per alarm type, so a service's two sentences are cleared together with the service and cannot drift apart.
interface SmokeNarration {

  detected: boolean;
  faults: string;
}

export class ProtectSensor extends ProtectDevice<Sensor> {

  private enabledSensors: string[];
  private lastAlarm: Partial<Record<AlarmContactDescriptor["field"], boolean>>;
  private lastLeak: Record<string, boolean | undefined>;
  private lastSmoke: Partial<Record<SmokeAlarmType, SmokeNarration>>;
  private lastSmokeTesting?: boolean;
  private lastVape?: boolean;

  // Create an instance.
  constructor(nvr: ProtectNvr, accessory: ProtectAccessory, device: Sensor) {

    super(nvr, accessory, device);

    this.enabledSensors = [];
    this.lastAlarm = {};
    this.lastLeak = {};
    this.lastSmoke = {};
  }

  // Initialize and configure the sensor accessory for HomeKit.
  protected override configureDevice(): boolean {

    // Reset the persisted context to a clean slate, discarding any stray keys left over from a prior configuration of this same accessory, while preserving the user's
    // motion-detection choice across the restart - a persisted detectMotion of false must survive rather than being wiped back to the default.
    this.resetAccessoryContext({ detectMotion: true });

    // Configure accessory information.
    this.configureInfo();

    // Configure the battery status.
    this.configureBatteryService();

    // Configure the sensor services that have been enabled.
    this.updateDevice({ initialized: false });

    // Configure the status indicator light switch.
    this.configureStatusLedSwitch();

    // Configure MQTT services.
    this.configureMqtt();

    return true;
  }

  // Configure the battery service for HomeKit.
  private configureBatteryService(): void {

    // Acquire the service.
    const { service } = this.acquireService({ serviceType: this.hap.Service.Battery });

    // Initialize the battery state.
    this.updateBatteryStatus();

    this.answerHeld(service, this.hap.Characteristic.BatteryLevel);
    this.answerHeld(service, this.hap.Characteristic.StatusLowBattery);
  }

  // Update accessory services and characteristics.
  private updateDevice({ initialized }: Required<Pick<ProtectConfigurePass, "initialized">>): void {

    const currentEnabledSensors: string[] = [];

    // Update the battery status for the accessory.
    this.updateBatteryStatus();

    // Configure the air quality sensor.
    if(this.configureAirQualitySensor()) {

      currentEnabledSensors.push("air quality");
    }

    // Publish the sensor's full air-quality telemetry when it changed. This follows the reporting capability alone: MQTT is the full-fidelity surface, carrying
    // every metric the controller reports - including the ones HomeKit has no service for - whatever set of HomeKit services this accessory happens to materialize.
    if(airQualityReporting(this.airQuality)) {

      this.publishState(mqttTopics.airquality.topic, this.airQualityPayload);
    }

    // Configure the alarm-family contact sensors (alarm sound and glass break), threading updateDevice's own initialized flag exactly as the leak and motion paths do.
    currentEnabledSensors.push(...this.configureAlarmContactSensors({ initialized }));

    // Configure the ambient light sensor.
    if(this.configureAmbientLightSensor()) {

      currentEnabledSensors.push("ambient light");
    }

    // Configure the carbon dioxide sensor.
    if(this.configureCo2Sensor()) {

      currentEnabledSensors.push("carbon dioxide");
    }

    // Configure the smoke detector's smoke and carbon monoxide sensors. The pair lands here because its first label sorts after carbon dioxide, the family-group
    // placement the alarm pair set.
    currentEnabledSensors.push(...this.configureSmokeDetector());

    // Configure the contact sensor.
    if(this.configureContactSensor()) {

      currentEnabledSensors.push("contact");
    }

    // Configure the humidity sensor.
    if(this.configureHumiditySensor()) {

      currentEnabledSensors.push("humidity");
    }

    // Configure the leak sensor.
    if(this.configureLeakSensor({ initialized })) {

      const sensorType = this.hasFeature("Sensor.MoistureSensor") ? "moisture" : "leak";

      // The enabled-sensors log reads the same leak-policy leaf as the service gate, so the log can never disagree with the services actually created.
      const context = this.leakContext;

      if(leakChannelEnabled(context, "internal")) {

        currentEnabledSensors.push(sensorType);
      }

      if(leakChannelEnabled(context, "external")) {

        currentEnabledSensors.push(sensorType + " (external)");
      }
    }

    // Configure the motion sensor.
    if(this.configureMotionSensor({ enabled: this.ufp.motionSettings.isEnabled, initialized })) {

      // Apply the tamper status characteristic to the motion service ourselves; battery status is handled separately by configureBatteryService.
      const motionService = this.accessory.getService(this.hap.Service.MotionSensor);

      if(motionService) {

        // Update the state characteristics.
        this.configureStateCharacteristics(motionService);
      }

      currentEnabledSensors.push("motion sensor");
    }

    // Configure the occupancy sensor.
    this.configureOccupancySensor({ enabled: this.ufp.motionSettings.isEnabled, initialized });

    // Configure the temperature sensor.
    if(this.configureTemperatureSensor()) {

      currentEnabledSensors.push("temperature");
    }

    // Configure the vape sensor.
    if(this.configureVapeSensor()) {

      currentEnabledSensors.push("vape");
    }

    // Update the status indicator light switch.
    this.accessory.getServiceById(this.hap.Service.Switch, ProtectReservedNames.SWITCH_STATUS_LED)?.updateCharacteristic(this.hap.Characteristic.On, this.statusLed);

    // Inform the user if we've had a change.
    if(!sameEntries(this.enabledSensors, currentEnabledSensors, (left, right) => left === right)) {

      this.enabledSensors = currentEnabledSensors;

      // Inform the user when the enabled-sensor set changes.
      if(this.enabledSensors.length) {

        this.log.info("Enabled sensor%s: %s.", this.enabledSensors.length > 1 ? "s" : "", this.enabledSensors.join(", "));
      } else {

        this.log.info("No sensors enabled.");
      }
    }
  }

  // Configure the air quality sensor for HomeKit. The AirQuality characteristic is always present on the service - it reports unknown while the index has no reading,
  // which is what HomeKit shows for a sensor that cannot answer - while the densities are presence-driven, each appearing only while its own metric reports.
  private configureAirQualitySensor(): boolean {

    const airQuality = this.airQuality;

    // Validate whether we should have this service enabled, on the lifecycle rule every capability-driven sensor service shares, asked here of the metrics HomeKit's
    // air quality service can model. No feature option gates it: the service has a direct HomeKit analog, and the Protect app is where a user chooses what a sensor
    // measures.
    const { service } = this.validService({ serviceType: this.hap.Service.AirQualitySensor,
      validate: (hasService) => environmentalServiceGate({ capability: airQualitySensorCapable(airQuality), hasService, isReachable: this.isReachable }) });

    if(!service) {

      return false;
    }

    // Retrieve the current air quality when requested.
    service.getCharacteristic(this.hap.Characteristic.AirQuality).onGet(this.answering(() => airQualityLevel(this.airQuality.aqi)));

    // Update the sensor.
    service.updateCharacteristic(this.hap.Characteristic.AirQuality, airQualityLevel(airQuality.aqi));

    // The particulate densities each track their own metric independently: a sensor reporting one particulate size and not another carries only the density it can
    // actually answer for. The gas readings stay off this service entirely - Protect reports VOC, TVOC, and NOx as baseline-relative indexes carrying no unit, while
    // HomeKit's density characteristics describe a mass concentration, and there is no honest conversion from one to the other. They ride the MQTT telemetry instead,
    // where a subscriber sees them for what they are. Revisit the moment Protect reports a gas reading as a real concentration.
    const pm25 = updatePresenceCharacteristic({ characteristic: this.hap.Characteristic.PM2_5Density, reachable: this.isReachable,
      read: () => airQualityMetricReading(this.airQuality.pm2p5), service });
    const pm10 = updatePresenceCharacteristic({ characteristic: this.hap.Characteristic.PM10Density, reachable: this.isReachable,
      read: () => airQualityMetricReading(this.airQuality.pm10p0), service });

    // A density attached or removed changes the service Homebridge's accessory cache holds, so the accessory is marked for the next save. Every density reconciles
    // before the test reads any answer, so one density's change never skips another's reconcile.
    if([ pm25, pm10 ].some(presenceChanged)) {

      this.platform.persistence.persist(this.accessory);
    }

    // Update the state characteristics.
    this.configureStateCharacteristics(service);

    return true;
  }

  // Configure the alarm-family contact sensors (alarm sound and glass break) for HomeKit. Each row reads its own latched field through alarmDetected, so a single
  // steady-state VALUE writer per row - that row's dedicated field observer via updateAlarmState - owns its ContactSensorState after the create-time seed here. Each
  // descriptor row is validated and acquired independently; the returned labels feed the enabled-sensors log so it can never disagree with the services actually
  // created.
  private configureAlarmContactSensors({ initialized }: Required<Pick<ProtectConfigurePass, "initialized">>): string[] {

    const config = this.ufp;
    const enabled: string[] = [];

    for(const descriptor of SENSOR_ALARM_CONTACTS) {

      // Validate whether we should have this service enabled. The transition the gate answers is "attached" exactly when the service is new to its lifetime - the first
      // configure or a late capability creating it - and "kept" for a service restored across a restart or already present from an earlier reconcile. This drives the
      // once-per-lifetime VALUE seed below alongside the first-configure signal.
      const { service, transition } = this.validService({ serviceType: this.hap.Service.ContactSensor, subtype: descriptor.subtype, suffix: descriptor.suffix,
        validate: descriptor.gate(config) });

      if(!service) {

        continue;
      }

      // Apply the tamper status characteristic every reconcile, exactly like every other sensor service. It does not touch ContactSensorState, so the alarm VALUE is not
      // re-pushed.
      this.configureStateCharacteristics(service);

      // Seed the alarm VALUE bits exactly once per service lifetime - the first configure (initialized false) or a late capability creating the service (an
      // attached transition): the onGet read-through, the initial characteristic value from a guaranteed-boolean local, and the initial MQTT publish. Steady-state
      // updates are then owned by this row's dedicated field observer, so the alarm VALUE leaves the per-reconcile path entirely. The seeded baseline is recorded under
      // the row's own field, so the first observed transition on one kind cannot be measured against what the other kind was doing.
      if(!initialized || (transition === "attached")) {

        const detected = this.alarmDetected(descriptor);

        this.lastAlarm[descriptor.field] = detected;

        // Retrieve the current contact sensor state when requested.
        service.getCharacteristic(this.hap.Characteristic.ContactSensorState).onGet(this.answering(() => this.alarmDetected(descriptor)));

        // Seed the sensor and publish the initial state.
        service.updateCharacteristic(this.hap.Characteristic.ContactSensorState, detected);
        this.publish(descriptor.mqtt.topic, detected.toString());
      }

      enabled.push(descriptor.label);
    }

    return enabled;
  }

  // Configure the ambient light sensor for HomeKit.
  private configureAmbientLightSensor(): boolean {

    // Validate whether we should have this service enabled: the sensor must report ambient light AND the user must not have hidden it via Device.AmbientLightSensor.
    const { service } = this.validService({ serviceType: this.hap.Service.LightSensor,
      validate: this.ufp.lightSettings.isEnabled && this.hasFeature("Device.AmbientLightSensor") });

    if(!service) {

      return false;
    }

    // Retrieve the current light level when requested.
    service.getCharacteristic(this.hap.Characteristic.CurrentAmbientLightLevel).onGet(this.answering(() => {

      // The minimum value for ambient light in HomeKit is 0.0001. I have no idea why...but it is. Honor it.
      return this.ambientLight >= 0.0001 ? this.ambientLight : 0.0001;
    }));

    // Update the sensor. The minimum value for ambient light in HomeKit is 0.0001. I have no idea why...but it is. Honor it.
    service.updateCharacteristic(this.hap.Characteristic.CurrentAmbientLightLevel, this.ambientLight >= 0.0001 ? this.ambientLight : 0.0001);

    // Update the state characteristics.
    this.configureStateCharacteristics(service);

    // Publish the state when it changed.
    this.publishState(mqttTopics.ambientlight.topic, this.ambientLight.toString());

    return true;
  }

  // Configure the carbon dioxide sensor for HomeKit. HomeKit splits CO2 into an alert state and a level: the alert answers to the threshold the user configured on the
  // controller, while the level is presence-driven like the densities, since a sensor can be reporting the metric without carrying a number at this instant.
  private configureCo2Sensor(): boolean {

    const airQuality = this.airQuality;

    // Validate whether we should have this service enabled, on the same shared lifecycle rule, asked here of the carbon dioxide metric alone. No feature option gates
    // it either: carbon dioxide is its own HomeKit service with its own direct analog, and the user chooses whether the sensor measures it in the Protect app.
    const { service } = this.validService({ serviceType: this.hap.Service.CarbonDioxideSensor,
      validate: (hasService) => environmentalServiceGate({ capability: airQualityMetricLive(airQuality.co2), hasService, isReachable: this.isReachable }) });

    if(!service) {

      return false;
    }

    // Retrieve the current carbon dioxide alert state when requested.
    service.getCharacteristic(this.hap.Characteristic.CarbonDioxideDetected).onGet(this.answering(() => co2AlertDetected(this.airQuality.co2, this.co2Settings)));

    // Update the sensor.
    service.updateCharacteristic(this.hap.Characteristic.CarbonDioxideDetected, co2AlertDetected(airQuality.co2, this.co2Settings));

    // The measured level, present only while the sensor is actually reporting a number.
    const co2 = updatePresenceCharacteristic({ characteristic: this.hap.Characteristic.CarbonDioxideLevel, reachable: this.isReachable,
      read: () => airQualityMetricReading(this.airQuality.co2), service });

    // A level attached or removed changes the service Homebridge's accessory cache holds, so the accessory is marked for the next save. A metric that stops reporting
    // fails the service gate above before the level is reached, and that gate removes the whole service and marks the accessory itself, so this mark is the one that
    // saves the level a live metric gains when its first reading arrives.
    if(presenceChanged(co2)) {

      this.platform.persistence.persist(this.accessory);
    }

    // Update the state characteristics.
    this.configureStateCharacteristics(service);

    return true;
  }

  // Configure the contact sensor for HomeKit.
  private configureContactSensor(): boolean {

    // Validate whether we should have this service enabled.
    const { service } = this.validService({ serviceType: this.hap.Service.ContactSensor, subtype: ProtectReservedNames.CONTACT_SENSOR,
      validate: !!this.ufp.mountType && (this.ufp.mountType !== "leak") && (this.ufp.mountType !== "none") });

    if(!service) {

      return false;
    }

    // Retrieve the current contact sensor state when requested.
    service.getCharacteristic(this.hap.Characteristic.ContactSensorState).onGet(this.answering(() => this.contact));

    // Update the sensor.
    service.updateCharacteristic(this.hap.Characteristic.ContactSensorState, this.contact);

    // Update the state characteristics.
    this.configureStateCharacteristics(service);

    // Publish the state when it changed.
    this.publishState(mqttTopics.contact.topic, this.contact.toString());

    return true;
  }

  // Configure the humidity sensor for HomeKit.
  private configureHumiditySensor(): boolean {

    // Validate whether we should have this service enabled, on the shared lifecycle rule: the user's Protect-side humidity toggle carries the USL family, while
    // air-quality hardware reports humidity through its own telemetry with no toggle at all.
    const { service } = this.validService({ serviceType: this.hap.Service.HumiditySensor,
      validate: (hasService) => environmentalServiceGate({ capability: airQualityMetricLive(this.airQuality.humidity), enabled: this.ufp.humiditySettings.isEnabled,
        hasService, isReachable: this.isReachable }) });

    if(!service) {

      return false;
    }

    // Wire the read-through, write the current reading, and publish it.
    this.updateEnvironmentalCharacteristic({ characteristic: this.hap.Characteristic.CurrentRelativeHumidity, read: () => this.humidity, service,
      topic: mqttTopics.humidity.topic });

    // Update the state characteristics.
    this.configureStateCharacteristics(service);

    return true;
  }

  // The sensor facts the leak policy reads, extracted off the projection as primitives. channelNames is the controller's own water-leak capability statement - the
  // field that tells apart the single-channel mount-role model from the multi-channel live-settings model; leakSettings and mountType carry the enable signals.
  private get leakContext(): LeakChannelContext {

    return { channelNames: this.ufp.featureFlags.waterLeak?.channelNames ?? [], leakSettings: this.ufp.leakSettings, mountType: this.ufp.mountType };
  }

  // Configure the leak sensor for HomeKit.
  private configureLeakSensor({ initialized }: Required<Pick<ProtectConfigurePass, "initialized">>): boolean {

    // Determine which service and characteristic types to use based on whether we are configured as a moisture sensor.
    const isMoistureSensor = this.hasFeature("Sensor.MoistureSensor");
    const characteristic = isMoistureSensor ? this.hap.Characteristic.ContactSensorState : this.hap.Characteristic.LeakDetected;
    const removeServiceType = isMoistureSensor ? this.hap.Service.LeakSensor : this.hap.Service.ContactSensor;
    const serviceType = isMoistureSensor ? this.hap.Service.ContactSensor : this.hap.Service.LeakSensor;

    // The single source of truth for which channels are enabled, read once per reconcile so the gate, the publish, and the MQTT registration all agree.
    const context = this.leakContext;

    let count = 0;

    for(const sensor of [

      { channel: "external" as const, isDetected: "externalLeakDetectedAt", mqtt: mqttTopics.leakExternal, subtype: ProtectReservedNames.LEAKSENSOR_EXTERNAL,
        suffix: " External " + (isMoistureSensor ? "Moisture" : "Leak") + " Sensor" },
      { channel: "internal" as const, isDetected: "leakDetectedAt", mqtt: mqttTopics.leak, subtype: ProtectReservedNames.LEAKSENSOR_INTERNAL }
    ]) {

      // The model-aware enablement decision, routed through the pure leak-policy leaf: the device must advertise the channel AND the model-correct enable signal must be
      // set (mountType "leak" for single-channel mount-role devices, the live leakSettings flag for multi-channel devices).
      const enabled = leakChannelEnabled(context, sensor.channel);

      // Remove the opposite sensor type if it exists since we are switching between sensor configurations, marking the accessory for the next save.
      const oldService = this.accessory.getServiceById(removeServiceType, sensor.subtype);

      if(oldService) {

        this.removeService(oldService);
      }

      // A channel toggled off releases its MQTT get handler BEFORE the validService continue skips the rest of the loop body, mirroring the occupancy / motion ordering.
      if(!enabled) {

        this.unsubscribe(mqttGetTopic(sensor.mqtt.topic));
      }

      // Validate whether we should have this service enabled. The transition the gate answers is "attached" exactly when this channel's service is newly created this
      // pass.
      const { service, transition } = this.validService({ serviceType, subtype: sensor.subtype, suffix: sensor.suffix, validate: enabled });

      if(!service) {

        continue;
      }

      // Retrieve the current sensor state when requested.
      service.getCharacteristic(characteristic).onGet(this.answering(() => this.leakDetected(sensor.isDetected)));

      // Update the sensor.
      service.updateCharacteristic(characteristic, this.leakDetected(sensor.isDetected));

      // Update the state characteristics.
      this.configureStateCharacteristics(service);

      // Publish the state when it changed.
      if(this.ufp.isConnected) {

        this.publishState(sensor.mqtt.topic, this.leakDetected(sensor.isDetected).toString());
      }

      // Register the MQTT get handler exactly once per channel: subscribeGet accumulates a handler on every call, so a second call would double-register the channel's
      // GET; we guard it on the first configure (initialized false) OR a channel enabled at runtime (an attached transition) - a channel toggled on after first
      // configure must register its GET now rather than stay dead until a restart. ONLY leak is folded onto this per-channel leaf gate, because only leak has the
      // model-aware per-channel enable signal. In configureMqtt the ambient light and vape GETs follow their feature options, and the remaining GETs are unconditional.
      if(!initialized || (transition === "attached")) {

        this.subscribeGet(sensor.mqtt.topic, sensor.mqtt.label, () => this.leakDetected(sensor.isDetected).toString());
      }

      count++;
    }

    return count > 0;
  }

  /* Configure the smoke detector's HomeKit sensors: a SmokeSensor and a CarbonMonoxideSensor, each present only on model-identified detector hardware and only when the
   * controller advertises that alarm type, each reading the detector's live status block and each carrying its own StatusFault composed from the detector's fault flags.
   * Neither carries a feature option: both have a direct HomeKit analog, and a smoke or carbon monoxide alarm belongs to HomeKit's life-safety alert class, so whether
   * the hardware exists is the only question worth asking.
   *
   * StatusFault is written here, per service, and deliberately never through the shared state helper: routing it there would hang the characteristic on every sensor
   * service the accessory carries, including the ones no fault flag can ever speak for. The returned labels feed the enabled-sensors log, so it can never disagree with
   * the services actually created.
   */
  private configureSmokeDetector(): string[] {

    const status = this.smokeStatus;
    const enabled: string[] = [];

    for(const descriptor of SENSOR_SMOKE_ALARMS) {

      const serviceType = descriptor.service(this.hap);

      // Validate whether we should have this service enabled, on the sensor's model-identified detector hardware and that hardware's own alarm-type advertisement. Both
      // are stable hardware facts rather than readings that flap, so it is a plain boolean rather than one of the conservative capability gates the measurement-driven
      // services use.
      const { service } = this.validService({ serviceType, validate: smokeAlarmCapable(this.smokeAlarmTypes, descriptor.alarmType) });

      if(!service) {

        // With no service on the accessory there is no state to hold, so the bookkeeping clears: an alarm type that goes away and later returns re-seeds from its first
        // live reading rather than narrating a transition against a state nobody has seen since. Cleared by writing undefined, which the record's own value type admits
        // and every read already treats as nothing-narrated, exactly as the leak bookkeeping beside it does.
        this.lastSmoke[descriptor.alarmType] = undefined;

        continue;
      }

      const characteristic = descriptor.characteristic(this.hap);

      // Retrieve the current alarm and fault states when requested.
      service.getCharacteristic(characteristic).onGet(this.answering(() => this.smokeAlarmState(descriptor)));
      service.getCharacteristic(this.hap.Characteristic.StatusFault).onGet(this.answering(() => this.smokeFaultState(descriptor)));

      // The VALUE path writes only from a LIVE block. While the detector has not given us one - a dropout, or a unit that has yet to report - the characteristics keep
      // whatever they hold, nothing is narrated, and nothing is published, so a gap can never manufacture an all-clear over an alarm the detector really sent.
      if(status) {

        const detected = this.smokeAlarmState(descriptor);
        const fault = this.smokeFaultState(descriptor);
        const reasons = descriptor.faultReasons(status);
        const faults = reasons.join(",");
        const previous = this.lastSmoke[descriptor.alarmType];

        if(narratesTransition({ previous: previous?.detected, quiet: false, value: detected })) {

          this.log.info("%s %sdetected.", descriptor.log, detected ? "" : "no longer ");
        }

        // The fault sentence turns on the REASON SET rather than on the fault boolean, so a detector that picks up a second fault while already faulted says so instead
        // of staying silent until everything clears.
        if(narratesTransition({ previous: previous?.faults, quiet: "", value: faults })) {

          if(fault) {

            this.log.warn("The %s sensor is reporting a fault: %s.", descriptor.label, reasons.map((reason) => SMOKE_FAULT_LABELS[reason]).join(", "));
          } else {

            this.log.info("The %s sensor is no longer reporting a fault.", descriptor.label);
          }
        }

        this.lastSmoke[descriptor.alarmType] = { detected, faults };

        // Update the sensor and publish the state when it changed.
        service.updateCharacteristic(characteristic, detected);
        service.updateCharacteristic(this.hap.Characteristic.StatusFault, fault);
        this.publishState(descriptor.mqtt.topic, detected.toString());
      }

      // Update the state characteristics.
      this.configureStateCharacteristics(service);

      enabled.push(descriptor.label);
    }

    // A sensor that is no detector holds nothing about a self-test, so that bookkeeping clears alongside the per-service records above.
    if(!this.smokeDetectorCapable) {

      this.lastSmokeTesting = undefined;

      return enabled;
    }

    // The per-device tail, which speaks for the detector rather than for either service: the self-test narration and the full telemetry topic, both on the same live
    // block the services read.
    if(status) {

      if(narratesTransition({ previous: this.lastSmokeTesting, quiet: false, value: status.testing })) {

        this.log.info("The smoke detector's self-test has %s.", status.testing ? "started" : "ended");
      }

      this.lastSmokeTesting = status.testing;

      const telemetry = this.smokeDetectorTelemetry;

      if(telemetry !== null) {

        this.publishState(mqttTopics.smokedetector.topic, telemetry);
      }
    }

    return enabled;
  }

  // Configure the temperature sensor for HomeKit.
  private configureTemperatureSensor(): boolean {

    // Validate whether we should have this service enabled, on the shared lifecycle rule: the user's Protect-side temperature toggle carries the USL family, while
    // air-quality hardware reports temperature through its own telemetry with no toggle at all.
    const { service } = this.validService({ serviceType: this.hap.Service.TemperatureSensor,
      validate: (hasService) => environmentalServiceGate({ capability: airQualityMetricLive(this.airQuality.temperature), enabled: this.ufp.temperatureSettings.isEnabled,
        hasService, isReachable: this.isReachable }) });

    if(!service) {

      return false;
    }

    // Wire the read-through, write the current reading, and publish it.
    this.updateEnvironmentalCharacteristic({ characteristic: this.hap.Characteristic.CurrentTemperature, read: () => this.temperature, service,
      topic: mqttTopics.temperature.topic });

    // Update the state characteristics.
    this.configureStateCharacteristics(service);

    return true;
  }

  // Configure the vape sensor for HomeKit. Vaping has no HomeKit service of its own, so we project it as a contact sensor that opens on a detection - an opt-in surface
  // a user turns on deliberately. The controller's own vape enable rides the absolute half of the gate alongside the user's option: it is a setting someone changes in
  // the Protect app, not a wire reading that flaps, so turning it off there should take the sensor away immediately.
  private configureVapeSensor(): boolean {

    const { service } = this.validService({ serviceType: this.hap.Service.ContactSensor, subtype: ProtectReservedNames.CONTACT_SENSOR_VAPE, suffix: " Vape",
      validate: capabilityGate({ capability: airQualityMetricLive(this.airQuality.vape), toggle: this.hasFeature("Sensor.Vape") && this.vapeSensitivity.isEnabled }) });

    if(!service) {

      // With no service on the accessory there is no state to hold, so the bookkeeping clears: a sensor turned off and later back on re-seeds from its first live
      // reading rather than narrating a transition against a state nobody has seen since.
      this.lastVape = undefined;

      return false;
    }

    // Retrieve the current vape state when requested.
    service.getCharacteristic(this.hap.Characteristic.ContactSensorState).onGet(this.answering(() => this.vapeState));

    // The VALUE path writes only from a LIVE reading. While the metric is quiet - the sensor between readings, or a record that has vanished - the characteristic keeps
    // whatever it holds and nothing is narrated, so a dropout can never manufacture an all-clear the sensor never reported.
    if(airQualityMetricLive(this.airQuality.vape)) {

      const detected = this.vapeState;

      // Inform the user on a genuine transition, through the shared narration rule: the first live reading of this service's lifetime is saved silently when nothing is
      // happening and spoken when a detection is already under way, and after that only a real change is worth a sentence.
      if(narratesTransition({ previous: this.lastVape, quiet: false, value: detected })) {

        this.log.info("Vaping %sdetected.", detected ? "" : "no longer ");
      }

      this.lastVape = detected;

      // Update the sensor.
      service.updateCharacteristic(this.hap.Characteristic.ContactSensorState, detected);

      // Publish the state when it changed.
      this.publishState(mqttTopics.vape.topic, detected.toString());
    }

    // Update the state characteristics.
    this.configureStateCharacteristics(service);

    return true;
  }

  // Update the battery status in HomeKit.
  private updateBatteryStatus(): void {

    // Find the battery service, if it exists.
    const batteryService = this.accessory.getService(this.hap.Service.Battery);

    // Update the battery status.
    batteryService?.updateCharacteristic(this.hap.Characteristic.BatteryLevel, this.ufp.batteryStatus.percentage ?? 0);
    batteryService?.updateCharacteristic(this.hap.Characteristic.StatusLowBattery, this.ufp.batteryStatus.isLow);
  }

  /* Reconcile one environmental characteristic - the temperature or humidity a sensor reports - against whichever of the two sources this hardware reports through,
   * and publish what it says. The same resolve-else-hold shape the library's updatePresenceCharacteristic applies to the densities, minus the removal half: the
   * temperature and humidity services own their characteristic for their whole lifetime, so the only question is whether there is a reading to write.
   *
   * WRITE - a source is reporting a number, so the characteristic takes it and the reading goes out on its MQTT topic.
   *
   * HOLD - neither source is reporting. Nothing is written and nothing is published, so HomeKit and every subscriber keep the last thing the sensor actually said
   * rather than being told a dropout was a reading of its own. On a service's FIRST materialization - a Protect toggle enabled before any reading has arrived - that
   * means the characteristic reads HomeKit's own default, zero for both of these, until the first reading lands.
   *
   * The reading arrives as a read-through rather than a value so the bound handler answers from the record at pull time, exactly as every other characteristic on
   * this accessory does; a pull arriving mid-hold answers with what HomeKit already holds. Re-registering the handler on every pass is the file's established idiom -
   * registration replaces rather than accumulates.
   */
  private updateEnvironmentalCharacteristic(options: { characteristic: CharacteristicTarget; read: () => Nullable<number>; service: Service; topic: string }): void {

    // Retrieve the current reading when requested, honoring a hold.
    options.service.getCharacteristic(options.characteristic).onGet(
      this.answering(() => options.read() ?? options.service.getCharacteristic(options.characteristic).value));

    const reading = options.read();

    if(reading === null) {

      return;
    }

    // Update the sensor and publish the state when it changed.
    options.service.updateCharacteristic(options.characteristic, reading);
    this.publishState(options.topic, reading.toString());
  }

  /* Read what HomeKit currently holds for one characteristic, resolving the service by type and, where one is given, by subtype.
   *
   * HomeKit's own cached value IS the held state, and this is the single place a read-through reaches for it. hap-nodejs writes a GET handler's answer straight back into
   * that cached value (Characteristic.handleGetRequest assigns this.value from the handler), so a read-through that answered from an in-process field while a sensor was
   * quiet would do more than report the wrong thing once: on the first pull after a restart, when this process holds no state of its own, it would overwrite the
   * detection Homebridge restored from the accessory cache with an all-clear the sensor never sent.
   *
   * There is no testCharacteristic probe here, because every caller reads a characteristic its own configure pass has already bound a handler to, or one the service
   * requires - nothing is ever lazily created by this read. A missing service and a never-written characteristic both answer false, which is what HomeKit itself shows
   * for a sensor that has said nothing yet.
   */
  private heldCharacteristicValue(options: { characteristic: CharacteristicTarget; service: WithUUID<typeof Service>; subtype?: string }): boolean {

    const service = options.subtype ? this.accessory.getServiceById(options.service, options.subtype) : this.accessory.getService(options.service);

    return Boolean(service?.getCharacteristic(options.characteristic).value);
  }

  // Configure the additional state characteristics in HomeKit. No service of a sensor carries StatusActive, one restored from the accessory cache included, No Response
  // being what HomeKit shows when the sensor cannot be reached.
  private configureStateCharacteristics(service: Service): boolean {

    this.removeStatusActive(service);

    // Retrieve the current tamper status when requested.
    service.getCharacteristic(this.hap.Characteristic.StatusTampered).onGet(this.answering(() => this.tampered));

    // Update the tamper status.
    service.updateCharacteristic(this.hap.Characteristic.StatusTampered, this.tampered);

    return true;
  }

  // The sensor's HomeKit tamper state, read non-throwing through the record. An absent record (a sensor lingering in the removal grace) reports untampered rather than
  // throwing; the projection's tamperingDetectedAt is mapped through the shared sensorTamperState predicate so the onGet, the initial write, and the reactive push can
  // never disagree on what "tampered" means.
  private get tampered(): boolean {

    return sensorTamperState(this.fromRecord((config) => config.tamperingDetectedAt, null));
  }

  // The sensor's air-quality readings, read non-throwing through the record. An absent record (a sensor lingering in the removal grace) reports the shape a sensor with
  // no air-quality hardware sends - every metric quiet - so every gate and every characteristic reads not-capable rather than throwing.
  private get airQuality(): Readonly<ProtectSensorAirQuality> {

    return this.fromRecord((config) => config.airQuality, NOT_CAPABLE_AIR_QUALITY);
  }

  // The air-quality telemetry payload: the twelve metrics the controller reports, each as its status and value. Built member by member rather than passed through from
  // the record, because the wire shape carries an open index signature and a subscriber's topic should carry exactly the metrics we document, whatever a future
  // firmware adds alongside them. This is where the metrics HomeKit has no service for - the VOC index, NOx, vape, and the finer particulate sizes - reach a user.
  private get airQualityPayload(): string {

    const airQuality = this.airQuality;
    const reading = (metric: ProtectAirQualityMetric): { status: string; value: Nullable<number> } => ({ status: metric.status, value: metric.value });

    return JSON.stringify({ aqi: reading(airQuality.aqi), co2: reading(airQuality.co2), humidity: reading(airQuality.humidity), nox: reading(airQuality.nox),
      pm10p0: reading(airQuality.pm10p0), pm1p0: reading(airQuality.pm1p0), pm2p5: reading(airQuality.pm2p5), pm4p0: reading(airQuality.pm4p0),
      temperature: reading(airQuality.temperature), tvoc: reading(airQuality.tvoc), vape: reading(airQuality.vape), voc: reading(airQuality.voc) });
  }

  // One alarm-family row's HomeKit state, read non-throwing through the record. An absent record (a sensor lingering in the removal grace) reports no alarm rather than
  // throwing; the row's own latched field is mapped through the shared sensorAlarmState predicate so that row's onGet, create-time seed, MQTT get, and reactive push can
  // never disagree on what "alarm" means. Taking the descriptor rather than the field name keeps every caller reading the same single source the table declares. A pure
  // read-through: the transition log and the lastAlarm bookkeeping live in updateAlarmState.
  private alarmDetected(descriptor: AlarmContactDescriptor): boolean {

    return sensorAlarmState(this.fromRecord((config) => config[descriptor.field], null));
  }

  // Get the current ambient light information. An absent record reports the stats sentinel rather than throwing.
  private get ambientLight(): number {

    return this.fromRecord((config) => config.stats?.light?.value ?? -1, -1);
  }

  // The carbon dioxide alert threshold the user configured on the controller, read non-throwing through the record. An absent record reports nothing configured, so the
  // alert cannot fire on a sensor whose record has vanished.
  private get co2Settings(): Readonly<ProtectAirQualityThresholdSettings> {

    return this.fromRecord((config) => config.airQualitySettings.co2Settings, DISABLED_THRESHOLD_SETTINGS);
  }

  // Get the current contact sensor information. An absent record reports closed rather than throwing.
  private get contact(): boolean {

    return this.fromRecord((config) => config.isOpened ?? false, false);
  }

  // Get the current humidity reading, from whichever of the two sources this sensor reports through. An absent record - a sensor lingering in the removal grace -
  // reports no reading rather than throwing, exactly as a live record with both sources quiet does.
  private get humidity(): Nullable<number> {

    return this.fromRecord((config) => environmentalReading({ metric: config.airQuality.humidity, stat: config.stats?.humidity }), null);
  }

  // Get the current leak sensor information. The record read is non-throwing - an absent record reports no leak - while the lastLeak bookkeeping and log stay outside the
  // read lambda. The untyped dynamic-key read below (keyed on a variable field name rather than a literal) resolves through the index signature that the
  // identity-dropping config view preserves.
  private leakDetected(type = "leakDetectedAt"): boolean {

    // Return true if we are not null, meaning a leak has been detected.
    const value = this.fromRecord((config) => config[type] !== null, false);

    // Inform the user on a genuine transition, through the shared narration rule: the first read of a quiet channel is saved silently, a channel already leaking when we
    // first see it is spoken, and after that only a real change is worth a sentence.
    if(narratesTransition({ previous: this.lastLeak[type], quiet: false, value })) {

      this.log.info("%s %sdetected.", this.hasFeature("Sensor.MoistureSensor") ? "Moisture" : "Leak", value ? "" : "no longer ");
    }

    this.lastLeak[type] = value;

    return value;
  }

  /* The sensor's HomeKit alarm state for one smoke-family service, and the single answer every read path gives. Three steps, in order.
   *
   * A sensor whose hardware does not detect this alarm type reports nothing at all. The smoke gets register on every sensor, exactly as the alarm family's do, so a unit
   * that is no detector yet carries a zeroed status block must never surface that block's raw flags to a subscriber.
   *
   * While the detector is reporting a block, the leaf's own predicate over it - the same one the reconcile writes from, so the pull and the push cannot disagree.
   *
   * Otherwise, whatever HomeKit already holds. Never an in-process field: a pull arriving during a dropout answers the held state back unchanged, which is what keeps a
   * restart mid-alarm from turning a cached detection into an all-clear.
   */
  private smokeAlarmState(descriptor: SmokeAlarmDescriptor): boolean {

    if(!smokeAlarmCapable(this.smokeAlarmTypes, descriptor.alarmType)) {

      return false;
    }

    const status = this.smokeStatus;

    if(status) {

      return descriptor.detected(status);
    }

    return this.heldCharacteristicValue({ characteristic: descriptor.characteristic(this.hap), service: descriptor.service(this.hap) });
  }

  // The alarm types this sensor's detector hardware advertises: the model family first, because a unit that only listens for alarm sounds advertises the same types for
  // the sounds it hears, then the controller's own list. Read non-throwing through the record, and an absent record (a sensor lingering in the removal grace) advertises
  // nothing, so every smoke gate and every read-through reads not-a-detector rather than throwing.
  private get smokeAlarmTypes(): readonly string[] {

    return this.fromRecord((config) => smokeDetectorHardware(config) ? (config.featureFlags.alarmTypes ?? []) : [], []);
  }

  // Whether this sensor is a smoke detector at all: its hardware is a detector's and the controller advertises at least one of the alarm types we project. The single
  // statement of that question, read by the configure method's per-device tail and by the telemetry getter.
  private get smokeDetectorCapable(): boolean {

    return SENSOR_SMOKE_ALARMS.some((descriptor) => smokeAlarmCapable(this.smokeAlarmTypes, descriptor.alarmType));
  }

  /* The detector's full telemetry payload: every member of the status block alongside the four latched timestamps the controller keeps beside it, each `null` until its
   * event first occurs. Built member by member rather than passed through from the record, because the wire shape carries an open index signature and a subscriber's
   * topic should carry exactly what we document, whatever a future firmware adds beside it - the same discipline the air-quality payload follows. The block and its
   * timestamps come from a single record read so they can never describe two different moments.
   *
   * A sensor that is no detector answers null even when it carries a zeroed block, matching the fact that it publishes nothing on this topic; so does a detector that
   * has yet to report. The configure method publishes this getter's value and the MQTT get answers it, so the publish and the get carry one payload.
   */
  private get smokeDetectorTelemetry(): Nullable<string> {

    if(!this.smokeDetectorCapable) {

      return null;
    }

    return this.fromRecord((config) => {

      const status = config.smokeStatus;

      if(!status) {

        return null;
      }

      return JSON.stringify({ alarmSilenced: status.alarmSilenced, alarmSilencedAt: config.alarmSilencedAt, batteryLow: status.batteryLow,
        batteryVoltage: status.batteryVoltage, cleanSmokeSensor: status.cleanSmokeSensor, coAlarm: status.coAlarm, coAlarmTriggeredAt: config.coAlarmTriggeredAt,
        coSensorFault: status.coSensorFault, coValue: status.coValue, enabled: status.enabled, endOfLife: status.endOfLife, ready: status.ready,
        smokeAlarm: status.smokeAlarm, smokeAlarmTriggeredAt: config.smokeAlarmTriggeredAt, smokeSensorFault: status.smokeSensorFault, smokeValue: status.smokeValue,
        testing: status.testing, troubleHushed: status.troubleHushed, troubleSilencedAt: config.troubleSilencedAt, wasMounted: status.wasMounted });
    }, null);
  }

  // The sensor's HomeKit fault state for one smoke-family service, over the same steps smokeAlarmState takes - the capability question first, the leaf's fault
  // rule while the detector is reporting, and HomeKit's held StatusFault otherwise.
  private smokeFaultState(descriptor: SmokeAlarmDescriptor): boolean {

    if(!smokeAlarmCapable(this.smokeAlarmTypes, descriptor.alarmType)) {

      return false;
    }

    const status = this.smokeStatus;

    if(status) {

      return descriptor.fault(status);
    }

    return this.heldCharacteristicValue({ characteristic: this.hap.Characteristic.StatusFault, service: descriptor.service(this.hap) });
  }

  // The detector's status block, read non-throwing through the record. An absent record (a sensor lingering in the removal grace) reports no block, which every smoke
  // path already treats as a detector that has not spoken: nothing is written, narrated, or published, and the read-throughs answer what HomeKit holds.
  private get smokeStatus(): Nullable<ProtectSensorSmokeStatus> {

    return this.fromRecord((config) => config.smokeStatus, null);
  }

  // Get the current temperature reading, from whichever of the two sources this sensor reports through. An absent record - a sensor lingering in the removal grace -
  // reports no reading rather than throwing, exactly as a live record with both sources quiet does.
  private get temperature(): Nullable<number> {

    return this.fromRecord((config) => environmentalReading({ metric: config.airQuality.temperature, stat: config.stats?.temperature }), null);
  }

  // The controller's vape detection setting, read non-throwing through the record. An absent record reports detection turned off, so a vanished sensor's contact sensor
  // is removed rather than left standing on a record nobody can read.
  private get vapeSensitivity(): Readonly<{ isEnabled: boolean; sensitivity: number }> {

    return this.fromRecord((config) => config.airQualitySettings.vapeSensitivitySettings, DISABLED_VAPE_SENSITIVITY);
  }

  // The sensor's HomeKit vape state, and the single answer every read path gives. While the metric is live it is the predicate over the current status; while it is not,
  // it is whatever HomeKit already holds on the vape contact. The characteristic's onGet, the MQTT get, and the reconcile's own push all read through here, so a pull
  // arriving during a dropout can never report an all-clear the sensor did not send - not even the first pull after a restart, when this process holds no state of its
  // own and Homebridge has restored the contact from the accessory cache. The lastVape field is narration bookkeeping alone and no read path consults it.
  private get vapeState(): boolean {

    const vape = this.airQuality.vape;

    return airQualityMetricLive(vape) ? vapeDetected(vape) : this.heldCharacteristicValue({ characteristic: this.hap.Characteristic.ContactSensorState,
      service: this.hap.Service.ContactSensor, subtype: ProtectReservedNames.CONTACT_SENSOR_VAPE });
  }

  // Configure MQTT capabilities for sensors. The leak get handlers are NOT registered here: leak is the one sensor mode whose per-channel enablement is model-aware, so
  // its get registration is folded into configureLeakSensor's per-channel loop (once-guarded, and released by the channel's own unsubscribe when it is disabled). The
  // remaining GETs are registered here, the ambient light and vape gets under their feature options and every other one unconditionally; the alarm-family gets (alarm
  // sound and glass break) and the smoke-family gets (smoke and carbon monoxide) are each driven from their shared descriptor, so their topics and labels are
  // single-sourced with the services they read - each alarm row through alarmDetected on its own latched field, the smoke pair through smokeAlarmState, which answers
  // false on a sensor that is no detector. The detector's telemetry get always answers too, with JSON null standing in for a detector that has not reported and for a
  // sensor that has no detector hardware at all.
  private configureMqtt(): void {

    for(const descriptor of SENSOR_ALARM_CONTACTS) {

      this.subscribeGet(descriptor.mqtt.topic, descriptor.mqtt.label, () => this.alarmDetected(descriptor).toString());
    }

    for(const descriptor of SENSOR_SMOKE_ALARMS) {

      this.subscribeGet(descriptor.mqtt.topic, descriptor.mqtt.label, () => this.smokeAlarmState(descriptor).toString());
    }

    this.subscribeGet(mqttTopics.airquality.topic, mqttTopics.airquality.label, () => this.airQualityPayload);

    // The ambient light and vape topics belong to features the user turns on in HomeKit, so each get exists only while its feature option is on, the option its
    // publish already reads. The option is read once here because configureMqtt runs once, while the live capability half of each publish's condition is read per pass.
    if(this.hasFeature("Device.AmbientLightSensor")) {

      this.subscribeGet(mqttTopics.ambientlight.topic, mqttTopics.ambientlight.label, () => this.ambientLight.toString());
    }

    this.subscribeGet(mqttTopics.contact.topic, mqttTopics.contact.label, () => this.contact.toString());
    this.subscribeGet(mqttTopics.humidity.topic, mqttTopics.humidity.label, () => (this.humidity ?? NO_READING).toString());
    this.subscribeGet(mqttTopics.smokedetector.topic, mqttTopics.smokedetector.label, () => this.smokeDetectorTelemetry ?? "null");
    this.subscribeGet(mqttTopics.temperature.topic, mqttTopics.temperature.label, () => (this.temperature ?? NO_READING).toString());

    if(this.hasFeature("Sensor.Vape")) {

      this.subscribeGet(mqttTopics.vape.topic, mqttTopics.vape.label, () => this.vapeState.toString());
    }

    // Restate the sensor's held state at the start of every later broker session, through the code that already publishes it. Each alarm row whose service stands
    // is stated first by its own push, then the reconcile pass runs exactly as a record wake runs it and states every reconcile topic it holds a value for. The order
    // keeps a row the pass itself attaches to one statement, its seed. The setup pass that precedes this method is the sensor's statement as it is set up.
    this.restateOnConnect(() => {

      for(const descriptor of SENSOR_ALARM_CONTACTS) {

        this.updateAlarmState(descriptor);
      }

      this.updateDevice({ initialized: true });
    });
  }

  // Spawn the sensor's narrow-selector observers. super spawns the base device's universal observers (currently name sync and firmware/device-info refresh); the sensor
  // adds further reactions, each waking only on its own slice through the store's reference dedup.
  protected override spawnObservers(): void {

    super.spawnObservers();

    const sensor = this.nvr.client.state.selectors.sensor.byId(this.device.id);

    // Sensor motion is a device-state field, not a firehose occurrence: the controller surfaces a UP Sense motion as a fresh motionDetectedAt timestamp on the sensor
    // record, with no `event`-channel counterpart. So the single source for "did this sensor see motion?" is the timestamp itself, and observing it is the honest
    // single-source reaction - the selector's dedup is the diff, with no held #prev snapshot and nothing re-synthesized. We deliver only on a truthy timestamp (a real
    // detection), never on a clear back to null. The camera and light families observe their own lastMotion the same way.
    this.observeState({ key: "sensor.motionDetectedAt", selector: state => sensor(state)?.motionDetectedAt, title: "motion detection" }, motionDetectedAt => {

      if(motionDetectedAt) {

        this.nvr.events.motionEventHandler(this);
      }
    });

    // The reactive tamper push: when the controller's tamperingDetectedAt changes, re-write StatusTampered across every sensor service that carries it. One read of the
    // projection field, one write per state-bearing service; no second copy of "are we tampered?" is held anywhere. The onGet already reads through, so this is purely
    // the push that keeps HomeKit current between reads.
    this.observeState({ key: "sensor.tamperingDetectedAt", selector: state => sensor(state)?.tamperingDetectedAt, title: "tamper detection" },
      () => updateServices(this.accessory, this.hap.Characteristic.StatusTampered, this.tampered));

    // The reactive alarm-family push: one dedicated observer per alarm-family row, each watching the single latched field its descriptor names and pushing only its own
    // ContactSensorState. Per row rather than one observer over both fields because the controller moves them independently - a glass break advances
    // glassBreakTriggeredAt while alarmTriggeredAt sits at whatever alarmed last - so a row that watched the other kind's field would miss its own detection and wake on
    // events that are not its own. Each field joins tamper as a dedicated-observer latched field the controller clears only on explicit user action; registered
    // unconditionally in table order so both are live the instant a late capability creates a service (updateAlarmState is a safe no-op while that row's service is
    // absent). The onGet already reads through, so this is purely the push that keeps HomeKit current between reads.
    for(const descriptor of SENSOR_ALARM_CONTACTS) {

      this.observeState({ key: "sensor." + descriptor.field, selector: state => sensor(state)?.[descriptor.field], title: descriptor.label + " detection" },
        () => this.updateAlarmState(descriptor));
    }

    // The remaining sensor reactions are a full service reconciliation (battery, the per-mode sensor services, the status indicator). They key off many settings
    // sub-objects and live stat values, so we observe the whole sensor record and re-derive - reproducing a refresh-on-any-change, but structurally silent when
    // nothing changed (the store's reference dedup). The alarm family and tamper own their VALUE pushes through their dedicated observers above; what this broad observer
    // still uniquely provides is the runtime capability-flip existence reconcile. Decomposing this into per-service observers - which would also retire the
    // StatusTampered re-apply - safe to run more than once - the dedicated tamper observer already owns - is a tracked follow-up.
    this.observeState({ key: "sensor.config", selector: sensor, title: "sensor settings" }, () => this.updateDevice({ initialized: true }));
  }

  // Push one alarm-family row's state to its own contact sensor, TARGETED by subtype rather than swept across every service the way the tamper push is.
  // One read of that row's latched field, one write to that row's service; the transition log is sourced from the row's own subject word so the sentence is
  // correct-by-construction (never a featureFlags.glassBreak probe, which is present even for a glass-break-DISABLED device) and fires only when the service exists (a
  // device with no service for this row never logs). Each row's last narrated reading is held under its own field, so a unit carrying both alarm kinds narrates each
  // contact on its own edges and neither kind can silence or double-announce the other. The subtype-scoped getServiceById NEVER touches the plain mount-type contact
  // sensor or a moisture ContactSensor, so the targeted push cannot corrupt them.
  private updateAlarmState(descriptor: AlarmContactDescriptor): void {

    const service = this.accessory.getServiceById(this.hap.Service.ContactSensor, descriptor.subtype);

    if(!service) {

      return;
    }

    const detected = this.alarmDetected(descriptor);

    // Inform the user on a state change, from this row's subject word.
    if(detected !== this.lastAlarm[descriptor.field]) {

      this.log.info("%s %sdetected.", descriptor.log, detected ? "" : "no longer ");
    }

    service.updateCharacteristic(this.hap.Characteristic.ContactSensorState, detected);
    this.publish(descriptor.mqtt.topic, detected.toString());

    this.lastAlarm[descriptor.field] = detected;
  }
}
