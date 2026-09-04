/* Copyright(C) 2019-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * sensor.ts: Sensor device class for UniFi Protect.
 */
import type { Characteristic, Service, WithUUID } from "homebridge";
import { DISABLED_THRESHOLD_SETTINGS, DISABLED_VAPE_SENSITIVITY, NOT_CAPABLE_AIR_QUALITY, NO_READING, airQualityLevel, airQualityMetricLive,
  airQualityMetricReported, airQualityReporting, airQualitySensorCapable, co2AlertDetected, environmentalReading, environmentalServiceGate,
  vapeDetected } from "./air-quality-policy.ts";
import type { MqttTopicEntry, Nullable } from "homebridge-plugin-utils";
import type { ProtectAccessory, WithoutIdentity } from "../types.ts";
import type { ProtectAirQualityMetric, ProtectAirQualityThresholdSettings, ProtectSensorAirQuality, ProtectSensorConfig, Sensor } from "unifi-protect";
import { capabilityGate, mqttGetTopic } from "homebridge-plugin-utils";
import type { LeakChannelContext } from "./leak-policy.ts";
import { ProtectDevice } from "./device.ts";
import type { ProtectNvr } from "../nvr/nvr.ts";
import { ProtectReservedNames } from "../types.ts";
import { deviceSelectors } from "unifi-protect";
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
 * Map a sensor's alarm-trigger timestamp to its HomeKit ContactSensorState: alarm when the controller has recorded a trigger time, clear when it has not. The single
 * source of truth is the projection's alarmTriggeredAt, which the controller clears only on explicit user action in the Protect app (never automatically). The
 * alarm-family contact sensors read through this one predicate, so their read-through getter and reactive push can never disagree on what "alarm" means. Kept
 * deliberately distinct from sensorTamperState because it reads a different field and capability and may later honor alarmSilencedAt; it is not collapsed into a generic
 * latched-field predicate.
 *
 * @param alarmTriggeredAt - The sensor's alarmTriggeredAt: the epoch-ms time an alarm was last triggered, or null when none has been.
 *
 * @returns true when the sensor should report an alarm to HomeKit.
 */
export function sensorAlarmState(alarmTriggeredAt: number | null): boolean {

  return alarmTriggeredAt !== null;
}

// The static description of the alarm family's HomeKit contact sensors - the single source for which alarm-family services exist and their gate, display label, log
// subject, MQTT catalog entry, name suffix, and reserved subtype. The alarm-family contact sensors read the one alarmTriggeredAt field, so this descriptor is read by the
// create/gate path (configureAlarmContactSensors), the reactive push (updateAlarmState), and the MQTT gets (configureMqtt), keeping the enabled-sensors log, the
// services actually created, and the topics registered from ever disagreeing. label is the enabled-sensors noun phrase and log is the transition-log subject word - two
// distinct display strings for two distinct sentences, so both are sourced here. A future alarm-family member is one more row.
interface AlarmContactDescriptor {

  readonly gate: (config: Readonly<WithoutIdentity<ProtectSensorConfig>>) => boolean;
  readonly label: string;
  readonly log: string;
  readonly mqtt: MqttTopicEntry;
  readonly name: string;
  readonly subtype: string;
}

// The alarm-family rows, alarm sound first so its position in the enabled-sensors log stays stable. Each gate mirrors its twin's controller enable signal: the
// alarm-sound settings toggle, and the glass-break capability channel being present AND its own settings toggle enabled.
const SENSOR_ALARM_CONTACTS: readonly AlarmContactDescriptor[] = [

  { gate: (config) => config.alarmSettings.isEnabled, label: "alarm sound", log: "Alarm", mqtt: mqttTopics.alarm, name: " Alarm Sound",
    subtype: ProtectReservedNames.CONTACT_SENSOR_ALARM_SOUND },
  { gate: (config) => (config.featureFlags.glassBreak !== undefined) && config.glassBreakSettings.isEnabled, label: "glass break", log: "Glass break",
    mqtt: mqttTopics.glassbreak, name: " Glass Break", subtype: ProtectReservedNames.CONTACT_SENSOR_GLASS_BREAK }
];

// The characteristic-class shape the reconcile helpers below accept. Service.getCharacteristic and updateCharacteristic want a constructor signature while
// testCharacteristic wants the static class shape, so the intersection of the two is the only type that satisfies every call they make - the same intersection
// homebridge-plugin-utils uses to type its own service-acquisition target. Every real characteristic class satisfies it.
type CharacteristicClass = WithUUID<typeof Characteristic> & (new () => Characteristic);

export class ProtectSensor extends ProtectDevice<Sensor> {

  private enabledSensors: string[];
  private lastAlarm?: boolean;
  private lastLeak: Record<string, boolean | undefined>;
  private lastVape?: boolean;

  // Create an instance.
  constructor(nvr: ProtectNvr, accessory: ProtectAccessory, device: Sensor) {

    super(nvr, accessory, device);

    this.enabledSensors = [];
    this.lastLeak = {};

    this.configureHints();
    this.configureDevice();
    this.spawnObservers();
  }

  // Initialize and configure the sensor accessory for HomeKit.
  private configureDevice(): boolean {

    // Reset the persisted context to a clean slate, discarding any stray keys left over from a prior configuration of this same accessory, while preserving the user's
    // motion-detection choice across the restart - a persisted detectMotion of false must survive rather than being wiped back to the default.
    this.resetAccessoryContext({ detectMotion: true });

    // Configure accessory information.
    this.configureInfo();

    // Configure the battery status.
    this.configureBatteryService();

    // Configure the sensor services that have been enabled.
    this.updateDevice(false);

    // Configure the status indicator light switch.
    this.configureStatusLedSwitch();

    // Configure MQTT services.
    this.configureMqtt();

    return true;
  }

  // Configure the battery service for HomeKit.
  private configureBatteryService(): boolean {

    // Acquire the service.
    const service = this.acquireService(this.hap.Service.Battery);

    // Fail gracefully.
    if(!service) {

      this.log.error("Unable to add the battery service.");

      return false;
    }

    // Initialize the battery state.
    this.updateBatteryStatus();

    return true;
  }

  // Update accessory services and characteristics.
  private updateDevice(isInitialized = true): void {

    const currentEnabledSensors: string[] = [];

    // Update the battery status for the accessory.
    this.updateBatteryStatus();

    // Configure the air quality sensor.
    if(this.configureAirQualitySensor()) {

      currentEnabledSensors.push("air quality");
    }

    // Publish the sensor's full air-quality telemetry. This rides the reporting capability alone: MQTT is the full-fidelity surface, carrying every metric the
    // controller reports - including the ones HomeKit has no service for - whatever set of HomeKit services this accessory happens to materialize.
    if(airQualityReporting(this.airQuality)) {

      this.publish(mqttTopics.airquality.topic, this.airQualityPayload);
    }

    // Configure the alarm-family contact sensors (alarm sound and glass break), threading updateDevice's own isInitialized exactly as the leak and motion paths do.
    currentEnabledSensors.push(...this.configureAlarmContactSensors(isInitialized));

    // Configure the ambient light sensor.
    if(this.configureAmbientLightSensor()) {

      currentEnabledSensors.push("ambient light");
    }

    // Configure the carbon dioxide sensor.
    if(this.configureCo2Sensor()) {

      currentEnabledSensors.push("carbon dioxide");
    }

    // Configure the contact sensor.
    if(this.configureContactSensor()) {

      currentEnabledSensors.push("contact");
    }

    // Configure the humidity sensor.
    if(this.configureHumiditySensor()) {

      currentEnabledSensors.push("humidity");
    }

    // Configure the leak sensor.
    if(this.configureLeakSensor(isInitialized)) {

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
    if(this.configureMotionSensor(this.ufp.motionSettings.isEnabled, isInitialized)) {

      // Apply the connection and tamper status characteristics to the motion service ourselves; battery status is handled separately by configureBatteryService.
      const motionService = this.accessory.getService(this.hap.Service.MotionSensor);

      if(motionService) {

        // Update the state characteristics.
        this.configureStateCharacteristics(motionService);
      }

      currentEnabledSensors.push("motion sensor");
    }

    // Configure the occupancy sensor.
    this.configureOccupancySensor(this.ufp.motionSettings.isEnabled, isInitialized);

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
    if(this.enabledSensors.join(" ") !== currentEnabledSensors.join(" ")) {

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
    if(!this.validService(this.hap.Service.AirQualitySensor,
      (hasService) => environmentalServiceGate({ capability: airQualitySensorCapable(airQuality), hasService, isReachable: this.isReachable }))) {

      return false;
    }

    // Acquire the service.
    const service = this.acquireService(this.hap.Service.AirQualitySensor);

    // Fail gracefully.
    if(!service) {

      this.log.error("Unable to add air quality sensor.");

      return false;
    }

    // Retrieve the current air quality when requested.
    service.getCharacteristic(this.hap.Characteristic.AirQuality).onGet(() => airQualityLevel(this.airQuality.aqi));

    // Update the sensor.
    service.updateCharacteristic(this.hap.Characteristic.AirQuality, airQualityLevel(airQuality.aqi));

    // The particulate densities each track their own metric independently: a sensor reporting one particulate size and not another carries only the density it can
    // actually answer for. The gas readings stay off this service entirely - Protect reports VOC, TVOC, and NOx as baseline-relative indexes carrying no unit, while
    // HomeKit's density characteristics describe a mass concentration, and there is no honest conversion from one to the other. They ride the MQTT telemetry instead,
    // where a subscriber sees them for what they are. Revisit the moment Protect reports a gas reading as a real concentration.
    this.updatePresenceCharacteristic({ characteristic: this.hap.Characteristic.PM2_5Density, read: () => this.airQuality.pm2p5, service });
    this.updatePresenceCharacteristic({ characteristic: this.hap.Characteristic.PM10Density, read: () => this.airQuality.pm10p0, service });

    // Update the state characteristics.
    this.configureStateCharacteristics(service);

    return true;
  }

  // Configure the alarm-family contact sensors (alarm sound and glass break) for HomeKit. Each reads the single alarmTriggeredAt field through the shared alarmDetected
  // getter, so a single steady-state VALUE writer - the dedicated alarmTriggeredAt observer via updateAlarmState - owns their ContactSensorState after the create-time
  // seed here. Each descriptor row is validated and acquired independently; the returned labels feed the enabled-sensors log so it can never disagree with the services
  // actually created.
  private configureAlarmContactSensors(isInitialized = true): string[] {

    const config = this.ufp;
    const enabled: string[] = [];

    for(const descriptor of SENSOR_ALARM_CONTACTS) {

      // Validate whether we should have this service enabled.
      if(!this.validService(this.hap.Service.ContactSensor, descriptor.gate(config), descriptor.subtype)) {

        continue;
      }

      // Detect creation by presence before we acquire: a subtype not yet on this accessory will be created by acquireService, so this is true exactly when the service is
      // new to its lifetime - the first configure or a late capability creating it - and false for a service restored across a restart or already present from an earlier
      // reconcile. This drives the once-per-lifetime VALUE seed below alongside the first-configure signal.
      const created = !this.accessory.getServiceById(this.hap.Service.ContactSensor, descriptor.subtype);
      const service = this.acquireService(this.hap.Service.ContactSensor, this.accessoryName + descriptor.name, descriptor.subtype);

      // Fail gracefully.
      if(!service) {

        this.log.error("Unable to add " + descriptor.label + " contact sensor.");

        continue;
      }

      // Apply the connection and tamper status characteristics every reconcile, exactly like every other sensor service: this unconditional call is the sole per-device
      // StatusActive driver when a device goes offline while the controller stays healthy. It does not touch ContactSensorState, so the alarm VALUE is not re-pushed.
      this.configureStateCharacteristics(service);

      // Seed the alarm VALUE bits exactly once per service lifetime - the first configure (isInitialized false) or a late capability creating the service (created): the
      // onGet read-through, the initial characteristic value from a guaranteed-boolean local, and the initial MQTT publish. Steady-state updates are then owned by the
      // dedicated alarmTriggeredAt observer, so the alarm VALUE leaves the per-reconcile path entirely.
      if(!isInitialized || created) {

        const detected = this.alarmDetected;

        this.lastAlarm = detected;

        // Retrieve the current contact sensor state when requested.
        service.getCharacteristic(this.hap.Characteristic.ContactSensorState).onGet(() => this.alarmDetected);

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
    if(!this.validService(this.hap.Service.LightSensor, this.ufp.lightSettings.isEnabled && this.hasFeature("Device.AmbientLightSensor"))) {

      return false;
    }

    // Acquire the service.
    const service = this.acquireService(this.hap.Service.LightSensor);

    // Fail gracefully.
    if(!service) {

      this.log.error("Unable to add ambient light sensor.");

      return false;
    }

    // Retrieve the current light level when requested.
    service.getCharacteristic(this.hap.Characteristic.CurrentAmbientLightLevel).onGet(() => {

      // The minimum value for ambient light in HomeKit is 0.0001. I have no idea why...but it is. Honor it.
      return this.ambientLight >= 0.0001 ? this.ambientLight : 0.0001;
    });

    // Update the sensor. The minimum value for ambient light in HomeKit is 0.0001. I have no idea why...but it is. Honor it.
    service.updateCharacteristic(this.hap.Characteristic.CurrentAmbientLightLevel, this.ambientLight >= 0.0001 ? this.ambientLight : 0.0001);

    // Update the state characteristics.
    this.configureStateCharacteristics(service);

    // Publish the state.
    this.publish(mqttTopics.ambientlight.topic, this.ambientLight.toString());

    return true;
  }

  // Configure the carbon dioxide sensor for HomeKit. HomeKit splits CO2 into an alert state and a level: the alert answers to the threshold the user configured on the
  // controller, while the level is presence-driven like the densities, since a sensor can be reporting the metric without carrying a number at this instant.
  private configureCo2Sensor(): boolean {

    const airQuality = this.airQuality;

    // Validate whether we should have this service enabled, on the same shared lifecycle rule, asked here of the carbon dioxide metric alone. No feature option gates
    // it either: carbon dioxide is its own HomeKit service with its own direct analog, and the user chooses whether the sensor measures it in the Protect app.
    if(!this.validService(this.hap.Service.CarbonDioxideSensor,
      (hasService) => environmentalServiceGate({ capability: airQualityMetricLive(airQuality.co2), hasService, isReachable: this.isReachable }))) {

      return false;
    }

    // Acquire the service.
    const service = this.acquireService(this.hap.Service.CarbonDioxideSensor);

    // Fail gracefully.
    if(!service) {

      this.log.error("Unable to add carbon dioxide sensor.");

      return false;
    }

    // Retrieve the current carbon dioxide alert state when requested.
    service.getCharacteristic(this.hap.Characteristic.CarbonDioxideDetected).onGet(() => co2AlertDetected(this.airQuality.co2, this.co2Settings));

    // Update the sensor.
    service.updateCharacteristic(this.hap.Characteristic.CarbonDioxideDetected, co2AlertDetected(airQuality.co2, this.co2Settings));

    // The measured level, present only while the sensor is actually reporting a number.
    this.updatePresenceCharacteristic({ characteristic: this.hap.Characteristic.CarbonDioxideLevel, read: () => this.airQuality.co2, service });

    // Update the state characteristics.
    this.configureStateCharacteristics(service);

    return true;
  }

  // Configure the contact sensor for HomeKit.
  private configureContactSensor(): boolean {

    // Validate whether we should have this service enabled.
    if(!this.validService(this.hap.Service.ContactSensor, !!this.ufp.mountType && (this.ufp.mountType !== "leak") && (this.ufp.mountType !== "none"),
      ProtectReservedNames.CONTACT_SENSOR)) {

      return false;
    }

    // Acquire the service.
    const service = this.acquireService(this.hap.Service.ContactSensor, undefined, ProtectReservedNames.CONTACT_SENSOR);

    // Fail gracefully.
    if(!service) {

      this.log.error("Unable to add contact sensor.");

      return false;
    }

    // Retrieve the current contact sensor state when requested.
    service.getCharacteristic(this.hap.Characteristic.ContactSensorState).onGet(() => this.contact);

    // Update the sensor.
    service.updateCharacteristic(this.hap.Characteristic.ContactSensorState, this.contact);

    // Update the state characteristics.
    this.configureStateCharacteristics(service);

    // Publish the state.
    this.publish(mqttTopics.contact.topic, this.contact.toString());

    return true;
  }

  // Configure the humidity sensor for HomeKit.
  private configureHumiditySensor(): boolean {

    // Validate whether we should have this service enabled, on the shared lifecycle rule: the user's Protect-side humidity toggle carries the USL family, while
    // air-quality hardware reports humidity through its own telemetry with no toggle at all.
    if(!this.validService(this.hap.Service.HumiditySensor, (hasService) => environmentalServiceGate({ capability: airQualityMetricLive(this.airQuality.humidity),
      enabled: this.ufp.humiditySettings.isEnabled, hasService, isReachable: this.isReachable }))) {

      return false;
    }

    // Acquire the service.
    const service = this.acquireService(this.hap.Service.HumiditySensor);

    // Fail gracefully.
    if(!service) {

      this.log.error("Unable to add humidity sensor.");

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
  private configureLeakSensor(isInitialized = true): boolean {

    // Determine which service and characteristic types to use based on whether we are configured as a moisture sensor.
    const isMoistureSensor = this.hasFeature("Sensor.MoistureSensor");
    const characteristic = isMoistureSensor ? this.hap.Characteristic.ContactSensorState : this.hap.Characteristic.LeakDetected;
    const removeServiceType = isMoistureSensor ? this.hap.Service.LeakSensor : this.hap.Service.ContactSensor;
    const sensorType = isMoistureSensor ? "contact sensor" : "leak sensor";
    const serviceType = isMoistureSensor ? this.hap.Service.ContactSensor : this.hap.Service.LeakSensor;

    // The single source of truth for which channels are enabled, read once per reconcile so the gate, the publish, and the MQTT registration all agree.
    const context = this.leakContext;

    let count = 0;

    for(const sensor of [

      { channel: "external" as const, isDetected: "externalLeakDetectedAt", mqtt: mqttTopics.leakExternal,
        name: " External " + (isMoistureSensor ? "Moisture" : "Leak") + " Sensor", subtype: ProtectReservedNames.LEAKSENSOR_EXTERNAL },
      { channel: "internal" as const, isDetected: "leakDetectedAt", mqtt: mqttTopics.leak, subtype: ProtectReservedNames.LEAKSENSOR_INTERNAL }
    ]) {

      // The model-aware enablement decision, routed through the pure leak-policy leaf: the device must advertise the channel AND the model-correct enable signal must be
      // set (mountType "leak" for single-channel mount-role devices, the live leakSettings flag for multi-channel devices).
      const enabled = leakChannelEnabled(context, sensor.channel);

      // Remove the opposite sensor type if it exists since we are switching between sensor configurations.
      const oldService = this.accessory.getServiceById(removeServiceType, sensor.subtype);

      if(oldService) {

        this.accessory.removeService(oldService);
      }

      // A channel toggled off releases its MQTT get handler BEFORE the validService continue skips the rest of the loop body, mirroring the occupancy / motion ordering.
      if(!enabled) {

        this.unsubscribe(mqttGetTopic(sensor.mqtt.topic));
      }

      // Validate whether we should have this service enabled.
      if(!this.validService(serviceType, enabled, sensor.subtype)) {

        continue;
      }

      // Detect creation by presence before we acquire: a subtype not yet on this accessory will be created by acquireService below, so this reads true exactly when the
      // channel's service is newly created this pass. We use a presence probe here, NOT an onServiceCreate closure flip: the loop shares one isInitialized parameter
      // across channels, and a closure flip on one channel would leak the reset into the next channel's iteration and double-register its GET.
      const created = !this.accessory.getServiceById(serviceType, sensor.subtype);

      // Acquire the service.
      const service = this.acquireService(serviceType, this.accessoryName + (sensor.name ?? ""), sensor.subtype);

      // Fail gracefully.
      if(!service) {

        this.log.error("Unable to add " + sensorType + ".");

        continue;
      }

      // Retrieve the current sensor state when requested.
      service.getCharacteristic(characteristic).onGet(() => this.leakDetected(sensor.isDetected));

      // Update the sensor.
      service.updateCharacteristic(characteristic, this.leakDetected(sensor.isDetected));

      // Update the state characteristics.
      this.configureStateCharacteristics(service);

      // Publish the state.
      if(this.ufp.isConnected) {

        this.publish(sensor.mqtt.topic, this.leakDetected(sensor.isDetected).toString());
      }

      // Register the MQTT get handler exactly once per channel: subscribeGet accumulates a handler on every call, so a second call would double-register the channel's
      // GET; we guard it on the first configure (isInitialized false) OR a channel enabled at runtime (created) - a channel toggled on after first configure must
      // register its GET now rather than stay dead until a restart. ONLY leak is folded onto this per-channel leaf gate, because only leak has the model-aware
      // per-channel enable signal; the other sensor GETs remain unconditional in configureMqtt - a pre-existing, accepted inconsistency that is out of scope here.
      if(!isInitialized || created) {

        this.subscribeGet(sensor.mqtt.topic, sensor.mqtt.label, () => this.leakDetected(sensor.isDetected).toString());
      }

      count++;
    }

    return count > 0;
  }

  // Configure the temperature sensor for HomeKit.
  private configureTemperatureSensor(): boolean {

    // Validate whether we should have this service enabled, on the shared lifecycle rule: the user's Protect-side temperature toggle carries the USL family, while
    // air-quality hardware reports temperature through its own telemetry with no toggle at all.
    if(!this.validService(this.hap.Service.TemperatureSensor, (hasService) => environmentalServiceGate({ capability:
      airQualityMetricLive(this.airQuality.temperature), enabled: this.ufp.temperatureSettings.isEnabled, hasService, isReachable: this.isReachable }))) {

      return false;
    }

    // Acquire the service.
    const service = this.acquireService(this.hap.Service.TemperatureSensor);

    // Fail gracefully.
    if(!service) {

      this.log.error("Unable to add temperature sensor.");

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

    if(!this.validService(this.hap.Service.ContactSensor, capabilityGate({ capability: airQualityMetricLive(this.airQuality.vape),
      toggle: this.hasFeature("Sensor.Vape") && this.vapeSensitivity.isEnabled }), ProtectReservedNames.CONTACT_SENSOR_VAPE)) {

      // With no service on the accessory there is no state to hold, so the bookkeeping clears: a sensor turned off and later back on re-seeds from its first live
      // reading rather than narrating a transition against a state nobody has seen since.
      this.lastVape = undefined;

      return false;
    }

    // Acquire the service.
    const service = this.acquireService(this.hap.Service.ContactSensor, this.accessoryName + " Vape", ProtectReservedNames.CONTACT_SENSOR_VAPE);

    // Fail gracefully.
    if(!service) {

      this.log.error("Unable to add vape contact sensor.");

      return false;
    }

    // Retrieve the current vape state when requested.
    service.getCharacteristic(this.hap.Characteristic.ContactSensorState).onGet(() => this.vapeState);

    // The VALUE path writes only from a LIVE reading. While the metric is quiet - the sensor between readings, or a record that has vanished - the characteristic keeps
    // whatever it holds and nothing is narrated, so a dropout can never manufacture an all-clear the sensor never reported.
    if(airQualityMetricLive(this.airQuality.vape)) {

      const detected = this.vapeState;

      // On the first live reading of this service's lifetime we save the state silently when nothing is happening, and speak up when a detection is already underway -
      // the same first-run shape the leak sensor uses. After that, only genuine changes are worth a sentence.
      if((this.lastVape === undefined) && !detected) {

        this.lastVape = detected;
      } else if(detected !== this.lastVape) {

        this.lastVape = detected;

        this.log.info("Vaping %sdetected.", detected ? "" : "no longer ");
      }

      // Update the sensor.
      service.updateCharacteristic(this.hap.Characteristic.ContactSensorState, detected);

      // Publish the state.
      this.publish(mqttTopics.vape.topic, detected.toString());
    }

    // Update the state characteristics.
    this.configureStateCharacteristics(service);

    return true;
  }

  // Update the battery status in HomeKit.
  private updateBatteryStatus(): boolean {

    // Find the battery service, if it exists.
    const batteryService = this.accessory.getService(this.hap.Service.Battery);

    // Update the battery status.
    batteryService?.updateCharacteristic(this.hap.Characteristic.BatteryLevel, this.ufp.batteryStatus.percentage ?? 0);
    batteryService?.updateCharacteristic(this.hap.Characteristic.StatusLowBattery, this.ufp.batteryStatus.isLow);

    return true;
  }

  /* Reconcile one environmental characteristic - the temperature or humidity a sensor reports - against whichever of the two sources this hardware reports through,
   * and publish what it says. The same resolve-else-hold shape updatePresenceCharacteristic applies to the densities, minus the removal half: these two services own
   * their characteristic for their whole lifetime, so the only question is whether there is a reading to write.
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
  private updateEnvironmentalCharacteristic(options: { characteristic: CharacteristicClass; read: () => Nullable<number>; service: Service; topic: string }): void {

    // Retrieve the current reading when requested, honoring a hold.
    options.service.getCharacteristic(options.characteristic).onGet(() => options.read() ?? options.service.getCharacteristic(options.characteristic).value);

    const reading = options.read();

    if(reading === null) {

      return;
    }

    // Update the sensor and publish the state.
    options.service.updateCharacteristic(options.characteristic, reading);
    this.publish(options.topic, reading.toString());
  }

  /* Reconcile one presence-driven characteristic against the metric behind it, applying the same additive-eager / subtractive-conservative asymmetry capabilityGate
   * applies to services, one level down. Four outcomes, from one read of the metric:
   *
   * ADD or UPDATE - the metric carries a reading, so the characteristic appears (HomeKit vends it on first access) and takes the current value. There is deliberately no
   * reachability gate on this half: the guarantee we want is asymmetric, in that the characteristic set never shrinks outside a real loss of the metric, while growth is
   * welcome the moment data arrives.
   *
   * HOLD - the metric is still reporting but has no number at this instant, or the device is unreachable. Nothing is written and nothing is removed, so a momentary null
   * or an offline window leaves HomeKit showing the last thing the sensor actually said.
   *
   * REMOVE - the metric has left liveness entirely while the device is reachable, meaning it genuinely stopped reporting (disabled, failed, or withdrawn by a firmware
   * update) rather than merely going quiet. Only then does the characteristic go, which keeps the accessory's configuration stable across the transient cases.
   *
   * The metric arrives as a read-through rather than a value so the bound handler answers from the record at pull time, exactly as every other characteristic on this
   * accessory does.
   */
  private updatePresenceCharacteristic(options: { characteristic: CharacteristicClass; read: () => ProtectAirQualityMetric; service: Service }): void {

    const metric = options.read();

    if(airQualityMetricReported(metric)) {

      // Retrieve the current reading when requested, honoring a hold: a pull arriving while the metric is between readings answers with what HomeKit already holds
      // rather than recomputing a value the sensor has not given us.
      options.service.getCharacteristic(options.characteristic).onGet(() => {

        const current = options.read();

        return airQualityMetricReported(current) ? current.value : options.service.getCharacteristic(options.characteristic).value;
      });

      // Update the characteristic.
      options.service.updateCharacteristic(options.characteristic, metric.value);

      return;
    }

    // A metric that is still reporting, or a device we cannot currently see, holds whatever HomeKit has.
    if(airQualityMetricLive(metric) || !this.isReachable) {

      return;
    }

    // Read prior existence side-effect-free; getCharacteristic would lazily materialize the characteristic we are about to remove.
    if(options.service.testCharacteristic(options.characteristic)) {

      options.service.removeCharacteristic(options.service.getCharacteristic(options.characteristic));
    }
  }

  // Configure the additional state characteristics in HomeKit.
  private configureStateCharacteristics(service: Service): boolean {

    // Retrieve the current connection status when requested.
    service.getCharacteristic(this.hap.Characteristic.StatusActive).onGet(() => this.isReachable);

    // Update the current connection status.
    service.updateCharacteristic(this.hap.Characteristic.StatusActive, this.isReachable);

    // Retrieve the current tamper status when requested.
    service.getCharacteristic(this.hap.Characteristic.StatusTampered).onGet(() => this.tampered);

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

  // The sensor's HomeKit alarm-family state, read non-throwing through the record. An absent record (a sensor lingering in the removal grace) reports no alarm rather
  // than throwing; the projection's alarmTriggeredAt is mapped through the shared sensorAlarmState predicate so the onGet, the create-time seed, the MQTT get, and the
  // reactive push can never disagree on what "alarm" means. A pure read-through: the transition log and the lastAlarm bookkeeping live in updateAlarmState.
  private get alarmDetected(): boolean {

    return sensorAlarmState(this.fromRecord((config) => config.alarmTriggeredAt, null));
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

    // If it's our first run, just save the state and we're done if we don't have a leak. If we do have a leak, make sure we inform the user.
    if((this.lastLeak[type] === undefined) && !value) {

      this.lastLeak[type] = value;

      return value;
    }

    // Save the state change and inform the user.
    if(value !== this.lastLeak[type]) {

      this.lastLeak[type] = value;

      this.log.info("%s %sdetected.", this.hasFeature("Sensor.MoistureSensor") ? "Moisture" : "Leak", value ? "" : "no longer ");
    }

    return value;
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
  // it is the last state we saw, defaulting to no detection for a sensor that has never reported. The characteristic's onGet, the MQTT get, and the reconcile's own push
  // all read through here, so a pull arriving during a dropout can never report an all-clear the sensor did not send.
  private get vapeState(): boolean {

    const vape = this.airQuality.vape;

    return airQualityMetricLive(vape) ? vapeDetected(vape) : (this.lastVape ?? false);
  }

  // Configure MQTT capabilities for sensors. The leak get handlers are NOT registered here: leak is the one sensor mode whose per-channel enablement is model-aware, so
  // its get registration is folded into configureLeakSensor's per-channel loop (once-guarded, and released by the channel's own unsubscribe when it is disabled). The
  // remaining GETs are always-on and registered unconditionally here; the alarm-family gets (alarm sound and glass break) are driven from the shared descriptor, so
  // their topics and labels are single-sourced with the services they read - each reading through the one alarmDetected getter.
  private configureMqtt(): void {

    for(const descriptor of SENSOR_ALARM_CONTACTS) {

      this.subscribeGet(descriptor.mqtt.topic, descriptor.mqtt.label, () => this.alarmDetected.toString());
    }

    this.subscribeGet(mqttTopics.airquality.topic, mqttTopics.airquality.label, () => this.airQualityPayload);
    this.subscribeGet(mqttTopics.ambientlight.topic, mqttTopics.ambientlight.label, () => this.ambientLight.toString());
    this.subscribeGet(mqttTopics.contact.topic, mqttTopics.contact.label, () => this.contact.toString());
    this.subscribeGet(mqttTopics.humidity.topic, mqttTopics.humidity.label, () => (this.humidity ?? NO_READING).toString());
    this.subscribeGet(mqttTopics.temperature.topic, mqttTopics.temperature.label, () => (this.temperature ?? NO_READING).toString());
    this.subscribeGet(mqttTopics.vape.topic, mqttTopics.vape.label, () => this.vapeState.toString());
  }

  // Spawn the sensor's narrow-selector observers. super spawns the base device's universal observers (currently name sync and firmware/device-info refresh); the sensor
  // adds further reactions, each waking only on its own slice through the store's reference dedup.
  protected override spawnObservers(): void {

    super.spawnObservers();

    const sensor = deviceSelectors.sensor.byId(this.device.id);

    // Sensor motion is a device-state field, not a firehose occurrence: the controller surfaces a UP Sense motion as a fresh motionDetectedAt timestamp on the sensor
    // record, with no `event`-channel counterpart. So the single source for "did this sensor see motion?" is the timestamp itself, and observing it is the honest
    // single-source reaction - the selector's dedup is the diff, with no held #prev snapshot and nothing re-synthesized. We deliver only on a truthy timestamp (a real
    // detection), never on a clear back to null. The camera and light families observe their own lastMotion the same way.
    this.observeState({ key: "sensor.motionDetectedAt", selector: state => sensor(state)?.motionDetectedAt, title: "motion detection" }, motionDetectedAt => {

      if(motionDetectedAt) {

        this.nvr.events.motionEventHandler(this);
      }
    });

    // The reactive tamper push: when the controller's tamperingDetectedAt changes, re-write StatusTampered across every state-bearing sensor service. The onGet already
    // reads through, so this is purely the push that keeps HomeKit current between reads.
    this.observeState({ key: "sensor.tamperingDetectedAt", selector: state => sensor(state)?.tamperingDetectedAt, title: "tamper detection" },
      () => this.updateTamperState());

    // The reactive alarm-family push: when the controller's alarmTriggeredAt changes, re-write ContactSensorState across each present alarm-family contact sensor. The
    // alarm family joins tamper as a dedicated-observer latched field the controller clears only on explicit user action; registered unconditionally so it is live
    // the instant a late capability creates the service (updateAlarmState is a safe no-op while no alarm-family service exists). The onGet already reads through, so this
    // is purely the push that keeps HomeKit current between reads.
    this.observeState({ key: "sensor.alarmTriggeredAt", selector: state => sensor(state)?.alarmTriggeredAt, title: "alarm detection" }, () => this.updateAlarmState());

    // The remaining sensor reactions are a full service reconciliation (battery, the per-mode sensor services, the status indicator, StatusActive). They key off many
    // settings sub-objects and live stat values, so we observe the whole sensor record and re-derive - reproducing a refresh-on-any-change, but now structurally silent
    // when nothing changed (the store's reference dedup). The alarm family and tamper own their VALUE pushes through their dedicated observers above; what this broad
    // observer still uniquely provides is each service's per-device StatusActive push (via the unconditional configureStateCharacteristics) and the runtime
    // capability-flip existence reconcile. Decomposing this into per-service observers - which would also retire the StatusTampered re-apply - safe to run more than once
    // - the dedicated tamper observer already owns - is a tracked follow-up; any such retirement MUST first add a sensor.state -> refreshReachability availability
    // observer to preserve the per-device StatusActive push this broad observer currently provides.
    this.observeState({ key: "sensor.config", selector: sensor, title: "sensor settings" }, () => this.updateDevice());
  }

  // Push the tamper state across every sensor service that carries StatusTampered, mirroring how refreshReachability fans StatusActive out. One read of the projection
  // field, one write per state-bearing service; no second copy of "are we tampered?" is held anywhere.
  private updateTamperState(): void {

    const tampered = this.tampered;

    for(const service of this.accessory.services) {

      if(service.testCharacteristic(this.hap.Characteristic.StatusTampered)) {

        service.updateCharacteristic(this.hap.Characteristic.StatusTampered, tampered);
      }
    }
  }

  // Push the alarm-family state across each present alarm-family contact sensor, the twin-in-idiom of updateTamperState but TARGETED by subtype rather than fanned across
  // every service. One read of the projection field, one write per present descriptor's service; the transition log is sourced from the PRESENT descriptor's subject word
  // so the sentence is correct-by-construction (never a featureFlags.glassBreak probe, which is present even for a glass-break-DISABLED device) and fires only when a
  // service exists (a device with no alarm-family service never logs). The subtype-scoped getServiceById NEVER touches the plain mount-type contact sensor or a moisture
  // ContactSensor, so the targeted push cannot corrupt them.
  private updateAlarmState(): void {

    const detected = this.alarmDetected;

    for(const descriptor of SENSOR_ALARM_CONTACTS) {

      const service = this.accessory.getServiceById(this.hap.Service.ContactSensor, descriptor.subtype);

      if(!service) {

        continue;
      }

      // Inform the user on a state change, from the present descriptor's subject word.
      if(detected !== this.lastAlarm) {

        this.log.info("%s %sdetected.", descriptor.log, detected ? "" : "no longer ");
      }

      service.updateCharacteristic(this.hap.Characteristic.ContactSensorState, detected);
      this.publish(descriptor.mqtt.topic, detected.toString());
    }

    this.lastAlarm = detected;
  }
}
