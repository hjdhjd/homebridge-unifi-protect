/* Copyright(C) 2019-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-sensor.ts: Sensor device class for UniFi Protect.
 */
import type { DeepIndexable, ProtectEventPacket, ProtectSensorConfig, ProtectSensorConfigPayload } from "unifi-protect";
import type { PlatformAccessory, Service } from "homebridge";
import { ProtectDevice } from "./protect-device.js";
import type { ProtectNvr } from "../protect-nvr.js";
import { ProtectReservedNames } from "../protect-types.js";

export class ProtectSensor extends ProtectDevice {

  private enabledSensors: string[];
  private lastAlarm?: boolean;
  private lastLeak: { [index: string]: boolean | undefined };
  public ufp: DeepIndexable<ProtectSensorConfig>;

  // Create an instance.
  constructor(nvr: ProtectNvr, device: ProtectSensorConfig, accessory: PlatformAccessory) {

    super(nvr, accessory);

    this.enabledSensors = [];
    this.lastLeak = {};
    this.ufp = device as DeepIndexable<ProtectSensorConfig>;

    this.configureHints();
    this.configureDevice();
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

    // Listen for events.
    this.nvr.events.on("updateEvent." + this.ufp.id, this.listeners["updateEvent." + this.ufp.id] = this.eventHandler.bind(this));

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
    if(this.configureLeakSensor()) {

      const sensorType = this.hasFeature("Sensor.MoistureSensor") ? "moisture" : "leak";

      if(this.ufp.leakSettings.isInternalEnabled) {

        currentEnabledSensors.push(sensorType);
      }

      if(this.ufp.leakSettings.isExternalEnabled) {

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

  // Configure the leak sensor for HomeKit.
  private configureLeakSensor(): boolean {

    // Determine which service and characteristic types to use based on whether we are configured as a moisture sensor.
    const isMoistureSensor = this.hasFeature("Sensor.MoistureSensor");
    const characteristic = isMoistureSensor ? this.hap.Characteristic.ContactSensorState : this.hap.Characteristic.LeakDetected;
    const removeServiceType = isMoistureSensor ? this.hap.Service.LeakSensor : this.hap.Service.ContactSensor;
    const sensorType = isMoistureSensor ? "contact sensor" : "leak sensor";
    const serviceType = isMoistureSensor ? this.hap.Service.ContactSensor : this.hap.Service.LeakSensor;

    let count = 0;

    for(const sensor of [

      { isDetected: "externalLeakDetectedAt", isEnabled: "isExternalEnabled", mqtt: "leak-enternal",
        name: " External " + (isMoistureSensor ? "Moisture" : "Leak") + " Sensor", subtype: ProtectReservedNames.LEAKSENSOR_EXTERNAL },
      { isDetected: "leakDetectedAt", isEnabled: "isInternalEnabled", mqtt: "leak", subtype: ProtectReservedNames.LEAKSENSOR_INTERNAL }
    ]) {

      // Remove the opposite sensor type if it exists since we are switching between sensor configurations.
      const oldService = this.accessory.getServiceById(removeServiceType, sensor.subtype);

      if(oldService) {

        this.accessory.removeService(oldService);
      }

      // Validate whether we should have this service enabled.
      if(!this.validService(serviceType, this.ufp.leakSettings[sensor.isEnabled], sensor.subtype)) {

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

        this.publish(sensor.mqtt, this.leakDetected.toString());
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

      this.log.error("Unable to add humidity sensor.");

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
    service.getCharacteristic(this.hap.Characteristic.StatusActive).onGet(() => this.isOnline);

    // Update the current connection status.
    service.updateCharacteristic(this.hap.Characteristic.StatusActive, this.isOnline);

    // Retrieve the current tamper status when requested.
    service.getCharacteristic(this.hap.Characteristic.StatusTampered).onGet(() => this.ufp.tamperingDetectedAt !== null);

    // Update the tamper status.
    service.updateCharacteristic(this.hap.Characteristic.StatusTampered, this.ufp.tamperingDetectedAt !== null);

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

    return !!this.ufp.isOpened;
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

  // Configure MQTT capabilities for sensors.
  private configureMqtt(): void {

    this.subscribeGet("alarm", "alarm detected", () => this.alarmDetected.toString());
    this.subscribeGet("ambientlight", "ambient light", () => this.ambientLight.toString());
    this.subscribeGet("contact", "contact sensor", () => this.contact.toString());
    this.subscribeGet("humidity", "humidity", () => this.humidity.toString());
    this.subscribeGet("leak", "leak detected", () => this.leakDetected().toString());
    this.subscribeGet("leak-external", "leak detected", () => this.leakDetected("externalLeakDetectedAt").toString());
    this.subscribeGet("temperature", "temperature", () => this.temperature.toString());
  }

  // Handle sensor-related events.
  private eventHandler(packet: ProtectEventPacket): void {

    const payload = packet.payload as ProtectSensorConfigPayload;

    // It's a motion event - process it accordingly.
    if(payload.motionDetectedAt) {

      this.nvr.events.motionEventHandler(this);
    }

    // Process it.
    this.updateDevice();
  }
}
