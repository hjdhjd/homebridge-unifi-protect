/* Copyright(C) 2019-2022, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-sensor.ts: Sensor device class for UniFi Protect.
 */
import { PROTECT_CONTACT_SENSOR, PROTECT_CONTACT_SENSOR_ALARM_SOUND, ProtectAccessory } from "./protect-accessory";
import { ProtectSensorConfig } from "unifi-protect";
import { Service } from "homebridge";

export class ProtectSensor extends ProtectAccessory {

  private savedAlarmSound!: boolean;
  private savedContact!: boolean;

  // Initialize and configure the sensor accessory for HomeKit.
  protected async configureDevice(): Promise<boolean> {

    // Save the device object before we wipeout the context.
    const device = this.accessory.context.device as ProtectSensorConfig;

    // Clean out the context object in case it's been polluted somehow.
    this.accessory.context = {};
    this.accessory.context.device = device;
    this.accessory.context.nvr = this.nvr.nvrApi.bootstrap?.nvr.mac;

    // Configure accessory information.
    this.configureInfo();

    // Configure accessory services.
    const enabledSensors = this.updateDevice();

    // Configure MQTT services.
    this.configureMqtt();

    // Inform the user what we're enabling on startup.
    if(enabledSensors.length) {
      this.log.info("%s: Enabled sensor%s: %s.", this.name(), enabledSensors.length > 1 ? "s" : "", enabledSensors.join(", "));
    }  else {
      this.log.info("%s: No sensors enabled.", this.name());
    }

    return Promise.resolve(true);
  }

  // Update accessory services and characteristics.
  public updateDevice(): string[] {

    const enabledSensors: string[] = [];

    // Configure the alarm sound sensor.
    if(this.configureAlarmSoundSensor()) {

      enabledSensors.push("alarm sound");
    }

    // Configure the ambient light sensor.
    if(this.configureAmbientLightSensor()) {

      enabledSensors.push("ambient light");
    }

    // Configure the contact sensor.
    if(this.configureContactSensor()) {

      enabledSensors.push("contact");
    }

    // Configure the humidity sensor.
    if(this.configureHumiditySensor()) {

      enabledSensors.push("humidity");
    }

    // Configure the motion sensor.
    if(this.configureMotionSensor((this.accessory.context.device as ProtectSensorConfig)?.motionSettings?.isEnabled)) {

      // Sensor accessories also support battery, connection, and tamper status...we need to handle those ourselves.
      const motionService = this.accessory.getService(this.hap.Service.MotionSensor);

      if(motionService) {

        // Update the state characteristics.
        this.configureStateCharacteristics(motionService);
      }

      enabledSensors.push("motion sensor");
    }

    // Configure the temperature sensor.
    if(this.configureTemperatureSensor()) {

      enabledSensors.push("temperature");
    }

    return enabledSensors;
  }

  // Configure the alarm sound sensor for HomeKit.
  private configureAlarmSoundSensor(): boolean {

    const device = this.accessory.context.device as ProtectSensorConfig;

    // Find the service, if it exists.
    let contactService = this.accessory.getServiceById(this.hap.Service.ContactSensor, PROTECT_CONTACT_SENSOR_ALARM_SOUND);

    // Have we disabled the alarm sound sensor?
    if(!device?.alarmSettings?.isEnabled) {

      if(contactService) {

        this.accessory.removeService(contactService);
        this.log.info("%s: Disabling alarm sound contact sensor.", this.name());
      }

      return false;
    }

    // Add the service to the accessory, if needed.
    if(!contactService) {

      contactService = new this.hap.Service.ContactSensor(this.accessory.displayName + " Alarm Sound", PROTECT_CONTACT_SENSOR_ALARM_SOUND);

      if(!contactService) {

        this.log.error("%s: Unable to add alarm sound contact sensor.", this.name());
        return false;
      }

      this.accessory.addService(contactService);
      this.log.info("%s: Enabling alarm sound contact sensor.", this.name());
    }

    // Retrieve the current contact sensor state when requested.
    contactService.getCharacteristic(this.hap.Characteristic.ContactSensorState)?.onGet(() => {

      return this.getAlarmSound();
    });

    // Update the sensor.
    contactService.updateCharacteristic(this.hap.Characteristic.ContactSensorState, this.getAlarmSound());

    // Update the state characteristics.
    this.configureStateCharacteristics(contactService);

    return true;
  }

  // Configure the ambient light sensor for HomeKit.
  private configureAmbientLightSensor(): boolean {

    const device = this.accessory.context.device as ProtectSensorConfig;

    // Find the service, if it exists.
    let lightService = this.accessory.getService(this.hap.Service.LightSensor);

    // Have we disabled the light sensor?
    if(!device?.lightSettings?.isEnabled) {

      if(lightService) {

        this.accessory.removeService(lightService);
        this.log.info("%s: Disabling ambient light sensor.", this.name());
      }

      return false;
    }

    // Add the service to the accessory, if needed.
    if(!lightService) {

      lightService = new this.hap.Service.LightSensor(this.accessory.displayName);

      if(!lightService) {

        this.log.error("%s: Unable to add ambient light sensor.", this.name());
        return false;
      }

      this.accessory.addService(lightService);
      this.log.info("%s: Enabling ambient light sensor.", this.name());
    }

    // Retrieve the current light level when requested.
    lightService.getCharacteristic(this.hap.Characteristic.CurrentAmbientLightLevel)?.onGet(() => {

      // The minimum value for ambient light in HomeKit is 0.0001. I have no idea why...but it is. Honor it.
      const value = this.getAmbientLight();
      return value >= 0.0001 ? value : 0.0001;
    });

    // Update the sensor. The minimum value for ambient light in HomeKit is 0.0001. I have no idea why...but it is. Honor it.
    const value = this.getAmbientLight();
    lightService.updateCharacteristic(this.hap.Characteristic.CurrentAmbientLightLevel, value >= 0.0001 ? value : 0.0001);

    // Update the state characteristics.
    this.configureStateCharacteristics(lightService);

    return true;
  }

  // Configure the contact sensor for HomeKit.
  private configureContactSensor(): boolean {

    const device = this.accessory.context.device as ProtectSensorConfig;

    // Find the service, if it exists.
    let contactService = this.accessory.getServiceById(this.hap.Service.ContactSensor, PROTECT_CONTACT_SENSOR);

    // Have we disabled the sensor?
    if(!device?.mountType || (device.mountType === "none")) {

      if(contactService) {

        this.accessory.removeService(contactService);
        this.log.info("%s: Disabling contact sensor.", this.name());
      }

      return false;
    }

    // Add the service to the accessory, if needed.
    if(!contactService) {

      contactService = new this.hap.Service.ContactSensor(this.accessory.displayName, PROTECT_CONTACT_SENSOR);

      if(!contactService) {

        this.log.error("%s: Unable to add contact sensor.", this.name());
        return false;
      }

      this.accessory.addService(contactService);
      this.log.info("%s: Enabling contact sensor.", this.name());
    }

    // Retrieve the current contact sensor state when requested.
    contactService.getCharacteristic(this.hap.Characteristic.ContactSensorState)?.onGet(() => {

      return this.getContact();
    });

    // Update the sensor.
    contactService.updateCharacteristic(this.hap.Characteristic.ContactSensorState, this.getContact());

    // Update the state characteristics.
    this.configureStateCharacteristics(contactService);

    return true;
  }

  // Configure the humidity sensor for HomeKit.
  private configureHumiditySensor(): boolean {

    const device = this.accessory.context.device as ProtectSensorConfig;

    // Find the service, if it exists.
    let humidityService = this.accessory.getService(this.hap.Service.HumiditySensor);

    // Have we disabled the sensor?
    if(!device?.humiditySettings?.isEnabled) {

      if(humidityService) {

        this.accessory.removeService(humidityService);
        this.log.info("%s: Disabling humidity sensor.", this.name());
      }

      return false;
    }

    // Add the service to the accessory, if needed.
    if(!humidityService) {

      humidityService = new this.hap.Service.HumiditySensor(this.accessory.displayName);

      if(!humidityService) {

        this.log.error("%s: Unable to add humidity sensor.", this.name());
        return false;
      }

      this.accessory.addService(humidityService);
      this.log.info("%s: Enabling humidity sensor.", this.name());
    }

    // Retrieve the current humidity when requested.
    humidityService.getCharacteristic(this.hap.Characteristic.CurrentRelativeHumidity)?.onGet(() => {

      const value = this.getHumidity();
      return value < 0 ? 0 : value;
    });

    // Update the sensor.
    const value = this.getHumidity();
    humidityService.updateCharacteristic(this.hap.Characteristic.CurrentRelativeHumidity, value < 0 ? 0 : value);

    // Update the state characteristics.
    this.configureStateCharacteristics(humidityService);

    return true;
  }

  // Configure the temperature sensor for HomeKit.
  private configureTemperatureSensor(): boolean {

    const device = this.accessory.context.device as ProtectSensorConfig;

    // Find the service, if it exists.
    let temperatureService = this.accessory.getService(this.hap.Service.TemperatureSensor);

    // Have we disabled the temperature sensor?
    if(!device?.temperatureSettings?.isEnabled) {

      if(temperatureService) {

        this.accessory.removeService(temperatureService);
        this.log.info("%s: Disabling temperature sensor.", this.name());
      }

      return false;
    }

    // Add the service to the accessory, if needed.
    if(!temperatureService) {

      temperatureService = new this.hap.Service.TemperatureSensor(this.accessory.displayName);

      if(!temperatureService) {

        this.log.error("%s: Unable to add temperature sensor.", this.name());
        return false;
      }

      this.accessory.addService(temperatureService);
      this.log.info("%s: Enabling temperature sensor.", this.name());
    }

    // Retrieve the current temperature when requested.
    temperatureService.getCharacteristic(this.hap.Characteristic.CurrentTemperature)?.onGet(() => {

      const value = this.getTemperature();
      return value < 0 ? 0 : value;
    });

    // Update the sensor.
    const value = this.getTemperature();
    temperatureService.updateCharacteristic(this.hap.Characteristic.CurrentTemperature, value < 0 ? 0 : value);

    // Update the state characteristics.
    this.configureStateCharacteristics(temperatureService);

    return true;
  }

  // Configure the active connection status in HomeKit.
  private configureActiveStatus(service: Service): boolean {

    const device = this.accessory.context.device as ProtectSensorConfig;

    // Retrieve the current connection status when requested.
    service.getCharacteristic(this.hap.Characteristic.StatusActive)?.onGet(() => {

      return (this.accessory.context.device as ProtectSensorConfig).state === "CONNECTED";
    });

    // Update the current connection status.
    service.updateCharacteristic(this.hap.Characteristic.StatusActive, device.state === "CONNECTED");

    return true;
  }

  // Configure the battery status in HomeKit.
  private configureBatteryStatus(service: Service): boolean {

    const device = this.accessory.context.device as ProtectSensorConfig;

    // Retrieve the current battery status when requested.
    service.getCharacteristic(this.hap.Characteristic.StatusLowBattery)?.onGet(() => {

      return (this.accessory.context.device as ProtectSensorConfig).batteryStatus?.isLow;
    });

    // Update the battery status.
    service.updateCharacteristic(this.hap.Characteristic.StatusLowBattery, device.batteryStatus?.isLow);

    return true;
  }

  // Configure the tamper status in HomeKit.
  private configureTamperedStatus(service: Service): boolean {

    const device = this.accessory.context.device as ProtectSensorConfig;

    // Retrieve the current tamper status when requested.
    service.getCharacteristic(this.hap.Characteristic.StatusTampered)?.onGet(() => {

      return (this.accessory.context.device as ProtectSensorConfig).tamperingDetectedAt !== null;
    });

    // Update the tamper status.
    service.updateCharacteristic(this.hap.Characteristic.StatusTampered, device.tamperingDetectedAt !== null);

    return true;
  }

  // Configure the additional state characteristics in HomeKit.
  private configureStateCharacteristics(service: Service): boolean {

    // Update the active connection status.
    this.configureActiveStatus(service);

    // Update the battery status.
    this.configureBatteryStatus(service);

    // Update the tamper status.
    this.configureTamperedStatus(service);

    return true;
  }

  // Get the current alarm sound information.
  private getAlarmSound(): boolean {

    // Return true if we are not null, meaning the alarm has sounded.
    const value = (this.accessory.context.device as ProtectSensorConfig).alarmTriggeredAt !== null;

    // Save the state change and publish to MQTT.
    if(value !== this.savedAlarmSound) {

      this.savedAlarmSound = value;
      this.nvr.mqtt?.publish(this.accessory, "alarmsound", value.toString());
    }

    return value;
  }

  // Get the current ambient light information.
  private getAmbientLight(): number {

    return (this.accessory.context.device as ProtectSensorConfig).stats.light.value ?? -1;
  }

  // Get the current contact sensor information.
  private getContact(): boolean {

    // Return true if we are open.
    const value = (this.accessory.context.device as ProtectSensorConfig).isOpened;

    // Save the state change and publish to MQTT.
    if(value !== this.savedContact) {

      this.savedContact = value;
      this.nvr.mqtt?.publish(this.accessory, "contact", value.toString());
    }

    return value;
  }

  // Get the current humidity information.
  private getHumidity(): number {

    return (this.accessory.context.device as ProtectSensorConfig).stats.humidity.value ?? -1;
  }

  // Get the current temperature information.
  private getTemperature(): number {

    return (this.accessory.context.device as ProtectSensorConfig).stats.temperature.value ?? -1;
  }

  // Configure MQTT capabilities for sensors.
  private configureMqtt(): void {

    if(!this.nvrApi.bootstrap?.nvr.mac) {
      return;
    }

    this.nvr.mqtt?.subscribeGet(this.accessory, this.name(), "alarmsound", "Alarm sound", () => {
      return this.getAlarmSound().toString();
    });

    this.nvr.mqtt?.subscribeGet(this.accessory, this.name(), "ambientlight", "Ambient light", () => {
      return this.getAmbientLight().toString();
    });

    this.nvr.mqtt?.subscribeGet(this.accessory, this.name(), "contact", "Contact sensor", () => {
      return this.getContact().toString();
    });

    this.nvr.mqtt?.subscribeGet(this.accessory, this.name(), "humidity", "Humidity", () => {
      return this.getHumidity().toString();
    });

    this.nvr.mqtt?.subscribeGet(this.accessory, this.name(), "temperature", "Temperature", () => {
      return this.getTemperature().toString();
    });
  }
}
