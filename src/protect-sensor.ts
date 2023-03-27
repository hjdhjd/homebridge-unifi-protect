/* Copyright(C) 2019-2023, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-sensor.ts: Sensor device class for UniFi Protect.
 */
import { PlatformAccessory, Service } from "homebridge";
import { ProtectEventPacket, ProtectSensorConfig, ProtectSensorConfigPayload } from "unifi-protect";
import { ProtectDevice } from "./protect-device.js";
import { ProtectNvr } from "./protect-nvr.js";
import { ProtectReservedNames } from "./protect-types.js";

export class ProtectSensor extends ProtectDevice {

  private savedAlarmSound!: boolean;
  private savedContact!: boolean;
  public ufp: ProtectSensorConfig;

  // Create an instance.
  constructor(nvr: ProtectNvr, device: ProtectSensorConfig, accessory: PlatformAccessory) {

    super(nvr, accessory);

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

    // Configure accessory services.
    const enabledSensors = this.updateDevice();

    // Configure MQTT services.
    this.configureMqtt();

    // Listen for events.
    this.nvr.events.on("updateEvent." + this.ufp.id, this.listeners["updateEvent." + this.ufp.id] = this.eventHandler.bind(this));

    // Inform the user what we're enabling on startup.
    if(enabledSensors.length) {

      this.log.info("Enabled sensor%s: %s.", enabledSensors.length > 1 ? "s" : "", enabledSensors.join(", "));
    } else {

      this.log.info("No sensors enabled.");
    }

    return true;
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
    if(this.configureMotionSensor(this.ufp.motionSettings?.isEnabled)) {

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

    // Find the service, if it exists.
    let contactService = this.accessory.getServiceById(this.hap.Service.ContactSensor, ProtectReservedNames.CONTACT_SENSOR_ALARM_SOUND);

    // Have we disabled the alarm sound sensor?
    if(!this.ufp.alarmSettings?.isEnabled) {

      if(contactService) {

        this.accessory.removeService(contactService);
        this.log.info("Disabling alarm sound contact sensor.");
      }

      return false;
    }

    // Add the service to the accessory, if needed.
    if(!contactService) {

      contactService = new this.hap.Service.ContactSensor(this.accessory.displayName + " Alarm Sound", ProtectReservedNames.CONTACT_SENSOR_ALARM_SOUND);

      if(!contactService) {

        this.log.error("Unable to add alarm sound contact sensor.");
        return false;
      }

      this.accessory.addService(contactService);
      this.log.info("Enabling alarm sound contact sensor.");
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

    // Find the service, if it exists.
    let lightService = this.accessory.getService(this.hap.Service.LightSensor);

    // Have we disabled the light sensor?
    if(!this.ufp.lightSettings?.isEnabled) {

      if(lightService) {

        this.accessory.removeService(lightService);
        this.log.info("Disabling ambient light sensor.");
      }

      return false;
    }

    // Add the service to the accessory, if needed.
    if(!lightService) {

      lightService = new this.hap.Service.LightSensor(this.accessory.displayName);

      if(!lightService) {

        this.log.error("Unable to add ambient light sensor.");
        return false;
      }

      this.accessory.addService(lightService);
      this.log.info("Enabling ambient light sensor.");
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

    // Find the service, if it exists.
    let contactService = this.accessory.getServiceById(this.hap.Service.ContactSensor, ProtectReservedNames.CONTACT_SENSOR);

    // Have we disabled the sensor?
    if(!this.ufp.mountType || (this.ufp.mountType === "none")) {

      if(contactService) {

        this.accessory.removeService(contactService);
        this.log.info("Disabling contact sensor.");
      }

      return false;
    }

    // Add the service to the accessory, if needed.
    if(!contactService) {

      contactService = new this.hap.Service.ContactSensor(this.accessory.displayName, ProtectReservedNames.CONTACT_SENSOR);

      if(!contactService) {

        this.log.error("Unable to add contact sensor.");
        return false;
      }

      this.accessory.addService(contactService);
      this.log.info("Enabling contact sensor.");
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

    // Find the service, if it exists.
    let humidityService = this.accessory.getService(this.hap.Service.HumiditySensor);

    // Have we disabled the sensor?
    if(!this.ufp.humiditySettings?.isEnabled) {

      if(humidityService) {

        this.accessory.removeService(humidityService);
        this.log.info("Disabling humidity sensor.");
      }

      return false;
    }

    // Add the service to the accessory, if needed.
    if(!humidityService) {

      humidityService = new this.hap.Service.HumiditySensor(this.accessory.displayName);

      if(!humidityService) {

        this.log.error("Unable to add humidity sensor.");
        return false;
      }

      this.accessory.addService(humidityService);
      this.log.info("Enabling humidity sensor.");
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

    // Find the service, if it exists.
    let temperatureService = this.accessory.getService(this.hap.Service.TemperatureSensor);

    // Have we disabled the temperature sensor?
    if(!this.ufp.temperatureSettings?.isEnabled) {

      if(temperatureService) {

        this.accessory.removeService(temperatureService);
        this.log.info("Disabling temperature sensor.");
      }

      return false;
    }

    // Add the service to the accessory, if needed.
    if(!temperatureService) {

      temperatureService = new this.hap.Service.TemperatureSensor(this.accessory.displayName);

      if(!temperatureService) {

        this.log.error("Unable to add temperature sensor.");
        return false;
      }

      this.accessory.addService(temperatureService);
      this.log.info("Enabling temperature sensor.");
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

    // Retrieve the current connection status when requested.
    service.getCharacteristic(this.hap.Characteristic.StatusActive)?.onGet(() => {

      return this.ufp.state === "CONNECTED";
    });

    // Update the current connection status.
    service.updateCharacteristic(this.hap.Characteristic.StatusActive, this.ufp.state === "CONNECTED");

    return true;
  }

  // Configure the battery status in HomeKit.
  private configureBatteryStatus(service: Service): boolean {

    // Retrieve the current battery status when requested.
    service.getCharacteristic(this.hap.Characteristic.StatusLowBattery)?.onGet(() => {

      return this.ufp.batteryStatus?.isLow;
    });

    // Update the battery status.
    service.updateCharacteristic(this.hap.Characteristic.StatusLowBattery, this.ufp.batteryStatus?.isLow);

    return true;
  }

  // Configure the tamper status in HomeKit.
  private configureTamperedStatus(service: Service): boolean {

    // Retrieve the current tamper status when requested.
    service.getCharacteristic(this.hap.Characteristic.StatusTampered)?.onGet(() => {

      return this.ufp.tamperingDetectedAt !== null;
    });

    // Update the tamper status.
    service.updateCharacteristic(this.hap.Characteristic.StatusTampered, this.ufp.tamperingDetectedAt !== null);

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
    const value = this.ufp.alarmTriggeredAt !== null;

    // Save the state change and publish to MQTT.
    if(value !== this.savedAlarmSound) {

      this.savedAlarmSound = value;
      this.nvr.mqtt?.publish(this.accessory, "alarmsound", value.toString());
    }

    return value;
  }

  // Get the current ambient light information.
  private getAmbientLight(): number {

    return this.ufp.stats.light.value ?? -1;
  }

  // Get the current contact sensor information.
  private getContact(): boolean {

    // Return true if we are open.
    const value = this.ufp.isOpened;

    // Save the state change and publish to MQTT.
    if(value !== this.savedContact) {

      this.savedContact = value;
      this.nvr.mqtt?.publish(this.accessory, "contact", value.toString());
    }

    return value;
  }

  // Get the current humidity information.
  private getHumidity(): number {

    return this.ufp.stats.humidity.value ?? -1;
  }

  // Get the current temperature information.
  private getTemperature(): number {

    return this.ufp.stats.temperature.value ?? -1;
  }

  // Configure MQTT capabilities for sensors.
  private configureMqtt(): void {

    this.nvr.mqtt?.subscribeGet(this.accessory, this.name, "alarmsound", "Alarm sound", () => {
      return this.getAlarmSound().toString();
    });

    this.nvr.mqtt?.subscribeGet(this.accessory, this.name, "ambientlight", "Ambient light", () => {
      return this.getAmbientLight().toString();
    });

    this.nvr.mqtt?.subscribeGet(this.accessory, this.name, "contact", "Contact sensor", () => {
      return this.getContact().toString();
    });

    this.nvr.mqtt?.subscribeGet(this.accessory, this.name, "humidity", "Humidity", () => {
      return this.getHumidity().toString();
    });

    this.nvr.mqtt?.subscribeGet(this.accessory, this.name, "temperature", "Temperature", () => {
      return this.getTemperature().toString();
    });
  }

  // Handle sensor-related events.
  private eventHandler(packet: ProtectEventPacket): void {

    const payload = packet.payload as ProtectSensorConfigPayload;

    // It's a motion event - process it accordingly.
    if(payload.isMotionDetected && payload.motionDetectedAt) {

      this.nvr.events.motionEventHandler(this, payload.motionDetectedAt);
    }

    // Process it.
    this.updateDevice();
  }
}
