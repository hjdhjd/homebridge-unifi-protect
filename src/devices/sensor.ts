/* Copyright(C) 2019-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * sensor.ts: Sensor device class for UniFi Protect.
 */
import type { ProtectAccessory, WithoutIdentity } from "../types.ts";
import type { ProtectSensorConfig, Sensor } from "unifi-protect";
import type { LeakChannelContext } from "./leak-policy.ts";
import { ProtectDevice } from "./device.ts";
import type { ProtectNvr } from "../nvr/nvr.ts";
import { ProtectReservedNames } from "../types.ts";
import type { Service } from "homebridge";
import { leakChannelEnabled } from "./leak-policy.ts";
import { selectSensor } from "unifi-protect";

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
// subject, MQTT topic, name suffix, and reserved subtype. The alarm-family contact sensors read the one alarmTriggeredAt field, so this descriptor is read by the
// create/gate path (configureAlarmContactSensors), the reactive push (updateAlarmState), and the MQTT gets (configureMqtt), keeping the enabled-sensors log, the
// services actually created, and the topics registered from ever disagreeing. label is the enabled-sensors noun phrase and log is the transition-log subject word - two
// distinct display strings for two distinct sentences, so both are sourced here. A future alarm-family member is one more row.
interface AlarmContactDescriptor {

  readonly gate: (config: Readonly<WithoutIdentity<ProtectSensorConfig>>) => boolean;
  readonly label: string;
  readonly log: string;
  readonly mqtt: string;
  readonly name: string;
  readonly subtype: string;
}

// The alarm-family rows, alarm sound first so its position in the enabled-sensors log stays stable. Each gate mirrors its twin's controller enable signal: the
// alarm-sound settings toggle, and the glass-break capability channel being present AND its own settings toggle enabled.
const SENSOR_ALARM_CONTACTS: readonly AlarmContactDescriptor[] = [

  { gate: (config) => config.alarmSettings.isEnabled, label: "alarm sound", log: "Alarm", mqtt: "alarm", name: " Alarm Sound",
    subtype: ProtectReservedNames.CONTACT_SENSOR_ALARM_SOUND },
  { gate: (config) => (config.featureFlags.glassBreak !== undefined) && config.glassBreakSettings.isEnabled, label: "glass break", log: "Glass break",
    mqtt: "glassbreak", name: " Glass Break", subtype: ProtectReservedNames.CONTACT_SENSOR_GLASS_BREAK }
];

export class ProtectSensor extends ProtectDevice {

  private enabledSensors: string[];
  private lastAlarm?: boolean;
  private lastLeak: Record<string, boolean | undefined>;
  // Narrow the inherited projection handle to the sensor projection so the read-through config getter resolves to ProtectSensorConfig.
  declare protected readonly device: Sensor;

  // Create an instance.
  constructor(nvr: ProtectNvr, accessory: ProtectAccessory, device: Sensor) {

    super(nvr, accessory, device);

    this.enabledSensors = [];
    this.lastLeak = {};

    this.configureHints();
    this.configureDevice();
    this.spawnObservers();
  }

  // Read-through to the sensor projection's live STATE, narrowed to drop device identity (id/mac/modelKey). Identity flows through the dedicated non-throwing accessors
  // (protectId/modelKey/.id/.mac), never this throwing config getter; this override mirrors the base getter's body and narrows only the surfaced return type. The leak
  // helper's untyped dynamic-key read (keyed on a variable field name) still resolves through the preserved index signature.
  public override get ufp(): Readonly<WithoutIdentity<ProtectSensorConfig>> {

    return this.device.config;
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

    // Configure the alarm-family contact sensors (alarm sound and glass break), threading updateDevice's own isInitialized exactly as the leak and motion paths do.
    currentEnabledSensors.push(...this.configureAlarmContactSensors(isInitialized));

    // Configure the ambient light sensor.
    if(this.configureAmbientLightSensor()) {

      currentEnabledSensors.push("ambient light");
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
        this.publish(descriptor.mqtt, detected.toString());
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
    this.publish("ambientlight", this.ambientLight.toString());

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
    this.publish("contact", this.contact.toString());

    return true;
  }

  // Configure the humidity sensor for HomeKit.
  private configureHumiditySensor(): boolean {

    // Validate whether we should have this service enabled.
    if(!this.validService(this.hap.Service.HumiditySensor, this.ufp.humiditySettings.isEnabled)) {

      return false;
    }

    // Acquire the service.
    const service = this.acquireService(this.hap.Service.HumiditySensor);

    // Fail gracefully.
    if(!service) {

      this.log.error("Unable to add humidity sensor.");

      return false;
    }

    // Retrieve the current humidity when requested.
    service.getCharacteristic(this.hap.Characteristic.CurrentRelativeHumidity).onGet(() => {

      return this.humidity < 0 ? 0 : this.humidity;
    });

    // Update the sensor.
    service.updateCharacteristic(this.hap.Characteristic.CurrentRelativeHumidity, this.humidity < 0 ? 0 : this.humidity);

    // Update the state characteristics.
    this.configureStateCharacteristics(service);

    // Publish the state.
    this.publish("humidity", this.humidity.toString());

    return true;
  }

  // The sensor facts the leak policy reads, extracted off the projection as primitives. channelNames is the controller's own water-leak capability statement (the
  // discriminator between the single-channel mount-role model and the multi-channel live-settings model); leakSettings and mountType carry the two enable signals.
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

      { channel: "external" as const, isDetected: "externalLeakDetectedAt", mqtt: "leak-external",
        name: " External " + (isMoistureSensor ? "Moisture" : "Leak") + " Sensor", subtype: ProtectReservedNames.LEAKSENSOR_EXTERNAL },
      { channel: "internal" as const, isDetected: "leakDetectedAt", mqtt: "leak", subtype: ProtectReservedNames.LEAKSENSOR_INTERNAL }
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

        this.unsubscribe(sensor.mqtt + "/get");
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

        this.publish(sensor.mqtt, this.leakDetected(sensor.isDetected).toString());
      }

      // Register the MQTT get handler exactly once per channel: subscribeGet accumulates a handler on every call, so a second call would double-register the channel's
      // GET; we guard it on the first configure (isInitialized false) OR a channel enabled at runtime (created) - a channel toggled on after first configure must
      // register its GET now rather than stay dead until a restart. ONLY leak is folded onto this per-channel leaf gate, because only leak has the model-aware
      // per-channel enable signal; the other sensor GETs remain unconditional in configureMqtt - a pre-existing, accepted inconsistency that is out of scope here.
      if(!isInitialized || created) {

        this.subscribeGet(sensor.mqtt, "leak detected", () => this.leakDetected(sensor.isDetected).toString());
      }

      count++;
    }

    return count > 0;
  }

  // Configure the temperature sensor for HomeKit.
  private configureTemperatureSensor(): boolean {

    // Validate whether we should have this service enabled.
    if(!this.validService(this.hap.Service.TemperatureSensor, this.ufp.temperatureSettings.isEnabled)) {

      return false;
    }

    // Acquire the service.
    const service = this.acquireService(this.hap.Service.TemperatureSensor);

    // Fail gracefully.
    if(!service) {

      this.log.error("Unable to add temperature sensor.");

      return false;
    }

    // Retrieve the current temperature when requested.
    service.getCharacteristic(this.hap.Characteristic.CurrentTemperature).onGet(() => this.temperature);

    // Update the sensor.
    service.updateCharacteristic(this.hap.Characteristic.CurrentTemperature, this.temperature);

    // Update the state characteristics.
    this.configureStateCharacteristics(service);

    // Publish the state.
    this.publish("temperature", this.temperature.toString());

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

  // Get the current contact sensor information. An absent record reports closed rather than throwing.
  private get contact(): boolean {

    return this.fromRecord((config) => config.isOpened ?? false, false);
  }

  // Get the current humidity information. An absent record reports the stats sentinel rather than throwing.
  private get humidity(): number {

    return this.fromRecord((config) => config.stats?.humidity?.value ?? -1, -1);
  }

  // Get the current leak sensor information. The record read is non-throwing - an absent record reports no leak - while the lastLeak bookkeeping and log stay outside the
  // read lambda.
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

  // Get the current temperature information. An absent record reports the stats sentinel rather than throwing.
  private get temperature(): number {

    return this.fromRecord((config) => config.stats?.temperature?.value ?? -1, -1);
  }

  // Configure MQTT capabilities for sensors. The leak get handlers are NOT registered here: leak is the one sensor mode whose per-channel enablement is model-aware, so
  // its get registration is folded into configureLeakSensor's per-channel loop (once-guarded, and released by the channel's own unsubscribe when it is disabled). The
  // remaining GETs are always-on and registered unconditionally here; the alarm-family gets (alarm sound and glass break) are driven from the shared descriptor, so
  // their topics and labels are single-sourced with the services they read - each reading through the one alarmDetected getter.
  private configureMqtt(): void {

    for(const descriptor of SENSOR_ALARM_CONTACTS) {

      this.subscribeGet(descriptor.mqtt, descriptor.label + " detected", () => this.alarmDetected.toString());
    }

    this.subscribeGet("ambientlight", "ambient light", () => this.ambientLight.toString());
    this.subscribeGet("contact", "contact sensor", () => this.contact.toString());
    this.subscribeGet("humidity", "humidity", () => this.humidity.toString());
    this.subscribeGet("temperature", "temperature", () => this.temperature.toString());
  }

  // Spawn the sensor's narrow-selector observers. super spawns the universal observers (name sync and firmware/device-info refresh); the sensor adds further reactions,
  // each waking only on its own slice through the store's reference dedup.
  protected override spawnObservers(): void {

    super.spawnObservers();

    const sensor = selectSensor(this.device.id);

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
    // capability-flip existence reconcile. Decomposing this into per-service observers - which would also retire the idempotent StatusTampered re-apply the dedicated
    // tamper observer already owns - is a tracked follow-up; any such retirement MUST first add a sensor.state -> refreshReachability availability observer to preserve
    // the per-device StatusActive push this broad observer currently provides.
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
      this.publish(descriptor.mqtt, detected.toString());
    }

    this.lastAlarm = detected;
  }
}
