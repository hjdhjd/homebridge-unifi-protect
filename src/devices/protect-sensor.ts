/* Copyright(C) 2019-2025, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-sensor.ts: Sensor device class for UniFi Protect.
 */
import { PlatformAccessory, Service } from "homebridge";
import { ProtectEventPacket, ProtectSensorConfig, ProtectSensorConfigPayload } from "unifi-protect";
import { ProtectDevice } from "./protect-device.js";
import { ProtectNvr } from "../protect-nvr.js";
import { ProtectReservedNames } from "../protect-types.js";

export class ProtectSensor extends ProtectDevice {

  private enabledSensors: string[];
  private lastAlarm!: boolean;
  private lastContact!: boolean;
  private lastLeak!: boolean;
  public ufp: ProtectSensorConfig;

  // Create an instance.
  constructor(nvr: ProtectNvr, device: ProtectSensorConfig, accessory: PlatformAccessory) {

    super(nvr, accessory);

    this.enabledSensors = [];
    this.ufp = device;

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

    // Configure the alarm sound sensor.
    if(this.configureLeakSensor()) {

      currentEnabledSensors.push("leak");
    }

    // Configure the motion sensor.
    if(this.configureMotionSensor(this.ufp.motionSettings?.isEnabled, isInitialized)) {

      // Sensor accessories also support battery, connection, and tamper status...we need to handle those ourselves.
      const motionService = this.accessory.getService(this.hap.Service.MotionSensor);

      if(motionService) {

        // Update the state characteristics.
        this.configureStateCharacteristics(motionService);
      }

      currentEnabledSensors.push("motion sensor");
    }

    // Configure the occupancy sensor.
    this.configureOccupancySensor(this.ufp.motionSettings?.isEnabled, isInitialized);

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
    if(!this.validService(this.hap.Service.ContactSensor, () => {

      // Have we disabled the sensor?
      if(!this.ufp.alarmSettings?.isEnabled) {

        return false;
      }

      return true;
    }, ProtectReservedNames.CONTACT_SENSOR_ALARM_SOUND)) {

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
    service.getCharacteristic(this.hap.Characteristic.ContactSensorState)?.onGet(() => {

      return this.alarmDetected;
    });

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
    if(!this.validService(this.hap.Service.LightSensor, () => {

      // Have we disabled the sensor?
      if(!this.ufp.lightSettings?.isEnabled) {

        return false;
      }

      return true;
    })) {

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
    service.getCharacteristic(this.hap.Characteristic.CurrentAmbientLightLevel)?.onGet(() => {

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
    if(!this.validService(this.hap.Service.ContactSensor, () => {

      // Have we disabled the sensor or are we configured as a leak sensor?
      if(!this.ufp.mountType || (this.ufp.mountType === "leak") || (this.ufp.mountType === "none")) {

        return false;
      }

      return true;
    }, ProtectReservedNames.CONTACT_SENSOR)) {

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
    service.getCharacteristic(this.hap.Characteristic.ContactSensorState)?.onGet(() => {

      return this.contact;
    });

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
    if(!this.validService(this.hap.Service.HumiditySensor, () => {

      // Have we disabled the sensor?
      if(!this.ufp.humiditySettings?.isEnabled) {

        return false;
      }

      return true;
    })) {

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
    service.getCharacteristic(this.hap.Characteristic.CurrentRelativeHumidity)?.onGet(() => {

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

    // Validate whether we should have this service enabled.
    if(!this.validService(this.hap.Service.LeakSensor, () => {

      // Have we disabled the leak sensor?
      if(this.ufp.mountType !== "leak") {

        return false;
      }

      return true;
    })) {

      return false;
    }

    // Acquire the service.
    const service = this.acquireService(this.hap.Service.LeakSensor);

    // Fail gracefully.
    if(!service) {

      this.log.error("Unable to add leak sensor.");

      return false;
    }

    // Retrieve the current contact sensor state when requested.
    service.getCharacteristic(this.hap.Characteristic.LeakDetected)?.onGet(() => {

      return this.leakDetected;
    });

    // Update the sensor.
    service.updateCharacteristic(this.hap.Characteristic.LeakDetected, this.leakDetected);

    // Update the state characteristics.
    this.configureStateCharacteristics(service);

    // Publish the state.
    this.publish("leak", this.leakDetected.toString());

    return true;
  }

  // Configure the temperature sensor for HomeKit.
  private configureTemperatureSensor(): boolean {

    // Validate whether we should have this service enabled.
    if(!this.validService(this.hap.Service.TemperatureSensor, () => {

      // Have we disabled the sensor?
      if(!this.ufp.temperatureSettings?.isEnabled) {

        return false;
      }

      return true;
    })) {

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
    service.getCharacteristic(this.hap.Characteristic.CurrentTemperature)?.onGet(() => {

      return this.temperature < 0 ? 0 : this.temperature;
    });

    // Update the sensor.
    service.updateCharacteristic(this.hap.Characteristic.CurrentTemperature, this.temperature < 0 ? 0 : this.temperature);

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
    batteryService?.updateCharacteristic(this.hap.Characteristic.BatteryLevel, this.ufp.batteryStatus?.percentage ?? 0);
    batteryService?.updateCharacteristic(this.hap.Characteristic.StatusLowBattery, this.ufp.batteryStatus?.isLow);

    return true;
  }

  // Configure the additional state characteristics in HomeKit.
  private configureStateCharacteristics(service: Service): boolean {

    // Retrieve the current connection status when requested.
    service.getCharacteristic(this.hap.Characteristic.StatusActive)?.onGet(() => this.isOnline);

    // Update the current connection status.
    service.updateCharacteristic(this.hap.Characteristic.StatusActive, this.isOnline);

    // Retrieve the current tamper status when requested.
    service.getCharacteristic(this.hap.Characteristic.StatusTampered)?.onGet(() => this.ufp.tamperingDetectedAt !== null);

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

    return this.ufp.stats.light.value ?? -1;
  }

  // Get the current contact sensor information.
  private get contact(): boolean {

    // Save the state change and publish to MQTT.
    if(this.ufp.isOpened !== this.lastContact) {

      this.lastContact = this.ufp.isOpened;
    }

    return this.ufp.isOpened;
  }

  // Get the current humidity information.
  private get humidity(): number {

    return this.ufp.stats.humidity.value ?? -1;
  }

  // Get the current leak sensor information.
  private get leakDetected(): boolean {

    // Return true if we are not null, meaning a leak has been detected.
    const value = this.ufp.leakDetectedAt !== null;

    // If it's our first run, just save the state and we're done if we don't have a leak. If we do have a leak, make sure we inform the user.
    if((this.lastLeak === undefined) && !value) {

      this.lastLeak = value;

      return value;
    }

    // Save the state change and publish to MQTT.
    if(value !== this.lastLeak) {

      this.lastLeak = value;

      this.log.info("Leak %sdetected.", value ? "" : "no longer ");
    }

    return value;
  }

  // Get the current temperature information.
  private get temperature(): number {

    return this.ufp.stats.temperature.value ?? -1;
  }

  // Configure MQTT capabilities for sensors.
  private configureMqtt(): void {

    this.subscribeGet("alarm", "alarm detected", () => {

      return this.alarmDetected.toString();
    });

    this.subscribeGet("ambientlight", "ambient light", () => {

      return this.ambientLight.toString();
    });

    this.subscribeGet("contact", "contact sensor", () => {

      return this.contact.toString();
    });

    this.subscribeGet("humidity", "humidity", () => {

      return this.humidity.toString();
    });

    this.subscribeGet("leak", "leak detected", () => {

      return this.leakDetected.toString();
    });

    this.subscribeGet("temperature", "temperature", () => {

      return this.temperature.toString();
    });
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
