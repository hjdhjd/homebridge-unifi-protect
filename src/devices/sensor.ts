/* Copyright(C) 2019-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-sensor.ts: Sensor device class for UniFi Protect.
 */
import type { ProtectSensorConfig, Sensor } from "unifi-protect";
import type { LeakChannelContext } from "./leak-policy.ts";
import type { ProtectAccessory } from "../types.ts";
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

  // Read-through config, narrowed to the sensor projection's config record.
  public override get ufp(): Readonly<ProtectSensorConfig> {

    return this.device.config;
  }

  // Initialize and configure the sensor accessory for HomeKit.
  private configureDevice(): boolean {

    // Clean out the context object in case it's been polluted somehow.
    this.accessory.context = {};
    this.accessory.context.mac = this.ufp.mac;
    this.accessory.context.nvr = this.nvr.ufp.mac;

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

  // Update battery status information for HomeKit.
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

    // Configure the alarm sound sensor.
    if(this.configureAlarmSoundSensor()) {

      currentEnabledSensors.push("alarm sound");
    }

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

      // Sensor accessories also support battery, connection, and tamper status...we need to handle those ourselves.
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

      // Inform the user what we're enabling on startup.
      if(this.enabledSensors.length) {

        this.log.info("Enabled sensor%s: %s.", this.enabledSensors.length > 1 ? "s" : "", this.enabledSensors.join(", "));
      } else {

        this.log.info("No sensors enabled.");
      }
    }
  }

  // Configure the alarm sound sensor for HomeKit.
  private configureAlarmSoundSensor(): boolean {

    // Validate whether we should have this service enabled.
    if(!this.validService(this.hap.Service.ContactSensor, this.ufp.alarmSettings.isEnabled, ProtectReservedNames.CONTACT_SENSOR_ALARM_SOUND)) {

      return false;
    }

    // Acquire the service.
    const service = this.acquireService(this.hap.Service.ContactSensor, this.accessoryName + " Alarm Sound", ProtectReservedNames.CONTACT_SENSOR_ALARM_SOUND);

    // Fail gracefully.
    if(!service) {

      this.log.error("Unable to add alarm sound contact sensor.");

      return false;
    }

    // Retrieve the current contact sensor state when requested.
    service.getCharacteristic(this.hap.Characteristic.ContactSensorState).onGet(() => this.alarmDetected);

    // Update the sensor.
    service.updateCharacteristic(this.hap.Characteristic.ContactSensorState, this.alarmDetected);

    // Update the state characteristics.
    this.configureStateCharacteristics(service);

    // Publish the state.
    this.publish("alarm", this.alarmDetected.toString());

    return true;
  }

  // Configure the ambient light sensor for HomeKit.
  private configureAmbientLightSensor(): boolean {

    // Validate whether we should have this service enabled.
    if(!this.validService(this.hap.Service.LightSensor, this.ufp.lightSettings.isEnabled)) {

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

      // Register the MQTT get handler exactly once per channel: subscribeGet is NOT idempotent (it accumulates handlers per call), so we guard it behind the
      // first-run flag exactly as the occupancy / motion sensors do. ONLY leak is folded onto this per-channel leaf gate, because only leak has the model-aware
      // per-channel enable signal; the other five sensor GETs remain unconditional in configureMqtt - a pre-existing, accepted inconsistency that is out of scope here.
      if(!isInitialized) {

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
    service.getCharacteristic(this.hap.Characteristic.StatusTampered).onGet(() => sensorTamperState(this.ufp.tamperingDetectedAt));

    // Update the tamper status.
    service.updateCharacteristic(this.hap.Characteristic.StatusTampered, sensorTamperState(this.ufp.tamperingDetectedAt));

    return true;
  }

  // Get the current alarm alert detection information.
  private get alarmDetected(): boolean {

    // Return true if we are not null, meaning the alarm has sounded.
    const value = this.ufp.alarmTriggeredAt !== null;

    // Save the state change and publish to MQTT.
    if(value !== this.lastAlarm) {

      this.lastAlarm = value;

      this.log.info("Alarm %sdetected.", value ? "" : "no longer ");
    }

    return value;
  }

  // Get the current ambient light information.
  private get ambientLight(): number {

    return this.ufp.stats?.light?.value ?? -1;
  }

  // Get the current contact sensor information.
  private get contact(): boolean {

    return this.ufp.isOpened ?? false;
  }

  // Get the current humidity information.
  private get humidity(): number {

    return this.ufp.stats?.humidity?.value ?? -1;
  }

  // Get the current leak sensor information.
  private leakDetected(type = "leakDetectedAt"): boolean {

    // Return true if we are not null, meaning a leak has been detected.
    const value = this.ufp[type] !== null;

    // If it's our first run, just save the state and we're done if we don't have a leak. If we do have a leak, make sure we inform the user.
    if((this.lastLeak[type] === undefined) && !value) {

      this.lastLeak[type] = value;

      return value;
    }

    // Save the state change and publish to MQTT.
    if(value !== this.lastLeak[type]) {

      this.lastLeak[type] = value;

      this.log.info("%s %sdetected.", this.hasFeature("Sensor.MoistureSensor") ? "Moisture" : "Leak", value ? "" : "no longer ");
    }

    return value;
  }

  // Get the current temperature information.
  private get temperature(): number {

    return this.ufp.stats?.temperature?.value ?? -1;
  }

  // Configure MQTT capabilities for sensors. The leak get handlers are NOT registered here: leak is the one sensor mode whose per-channel enablement is model-aware, so
  // its get registration is folded into configureLeakSensor's per-channel loop (once-guarded, and released by the channel's own unsubscribe when it is disabled). The
  // remaining five GETs are always-on and registered unconditionally here.
  private configureMqtt(): void {

    this.subscribeGet("alarm", "alarm detected", () => this.alarmDetected.toString());
    this.subscribeGet("ambientlight", "ambient light", () => this.ambientLight.toString());
    this.subscribeGet("contact", "contact sensor", () => this.contact.toString());
    this.subscribeGet("humidity", "humidity", () => this.humidity.toString());
    this.subscribeGet("temperature", "temperature", () => this.temperature.toString());
  }

  // Spawn the sensor's narrow-selector observers (Fork B). super spawns the universal name-sync observer; the sensor adds three reactions, each waking only on its own
  // slice through the store's reference dedup.
  protected override spawnObservers(): void {

    super.spawnObservers();

    const sensor = selectSensor(this.ufp.id);

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

    // The remaining sensor reactions are a full service reconciliation (battery, the per-mode sensor services, the status indicator, StatusActive). They key off many
    // settings sub-objects and live stat values, so we observe the whole sensor record and re-derive - matching v4's refresh-on-any-change, but now structurally silent
    // when nothing changed (the store's reference dedup). Decomposing this into per-service observers, which would also retire the idempotent StatusTampered re-apply the
    // dedicated tamper observer above already owns, is a tracked follow-up.
    this.observeState({ key: "sensor.config", selector: sensor, title: "sensor settings" }, () => this.updateDevice());
  }

  // Push the tamper state across every sensor service that carries StatusTampered, mirroring how refreshReachability fans StatusActive out. One read of the projection
  // field, one write per state-bearing service; no second copy of "are we tampered?" is held anywhere.
  private updateTamperState(): void {

    const tampered = sensorTamperState(this.ufp.tamperingDetectedAt);

    for(const service of this.accessory.services) {

      if(service.testCharacteristic(this.hap.Characteristic.StatusTampered)) {

        service.updateCharacteristic(this.hap.Characteristic.StatusTampered, tampered);
      }
    }
  }
}
