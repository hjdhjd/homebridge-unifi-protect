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

  private lastAlarm!: boolean;
  private lastContact!: boolean;
  private lastLeak!: boolean;
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

    // Configure the battery status.
    this.configureBatteryService();

    // Configure the sensor services that have been enabled.
    const enabledSensors = this.updateDevice(false);

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

  // Update battery status information for HomeKit.
  private configureBatteryService(): boolean {

    // Find the battery service, if it exists.
    let batteryService = this.accessory.getService(this.hap.Service.Battery);

    // We don't have the battery service, let's add it to the sensor.
    if(!batteryService) {

      // We don't have it, add it to the sensor.
      batteryService = new this.hap.Service.Battery(this.accessory.displayName);

      if(!batteryService) {

        this.log.error("Unable to add the battery service.");
        return false;
      }

      this.accessory.addService(batteryService);
    }

    // Retrieve the current battery status when requested.
    batteryService.getCharacteristic(this.hap.Characteristic.StatusLowBattery)?.onGet(() => {

      return this.ufp.batteryStatus?.percentage ?? 0;
    });

    batteryService.getCharacteristic(this.hap.Characteristic.StatusLowBattery)?.onGet(() => {

      return this.ufp.batteryStatus?.isLow ?? false;
    });

    // Initialize the battery state.
    this.updateBatteryStatus();

    return true;
  }

  // Update accessory services and characteristics.
  public updateDevice(isInitialized = true): string[] {

    const enabledSensors: string[] = [];

    // Update the battery status for the accessory.
    this.updateBatteryStatus();

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

    // Configure the alarm sound sensor.
    if(this.configureLeakSensor()) {

      enabledSensors.push("leak");
    }

    // Configure the motion sensor.
    if(this.configureMotionSensor(this.ufp.motionSettings?.isEnabled, isInitialized)) {

      // Sensor accessories also support battery, connection, and tamper status...we need to handle those ourselves.
      const motionService = this.accessory.getService(this.hap.Service.MotionSensor);

      if(motionService) {

        // Update the state characteristics.
        this.configureStateCharacteristics(motionService);
      }

      enabledSensors.push("motion sensor");
    }

    // Configure the occupancy sensor.
    this.configureOccupancySensor(this.ufp.motionSettings?.isEnabled, isInitialized);

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

      const contactName = this.accessory.displayName + " Alarm Sound";
      contactService = new this.hap.Service.ContactSensor(contactName, ProtectReservedNames.CONTACT_SENSOR_ALARM_SOUND);

      if(!contactService) {

        this.log.error("Unable to add alarm sound contact sensor.");
        return false;
      }

      contactService.addOptionalCharacteristic(this.hap.Characteristic.ConfiguredName);
      contactService.updateCharacteristic(this.hap.Characteristic.ConfiguredName, contactName);
      this.accessory.addService(contactService);

      this.log.info("Enabling alarm sound contact sensor.");
    }

    // Retrieve the current contact sensor state when requested.
    contactService.getCharacteristic(this.hap.Characteristic.ContactSensorState)?.onGet(() => {

      return this.alarmDetected;
    });

    // Update the sensor.
    contactService.updateCharacteristic(this.hap.Characteristic.ContactSensorState, this.alarmDetected);

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
      const value = this.ambientLight;
      return value >= 0.0001 ? value : 0.0001;
    });

    // Update the sensor. The minimum value for ambient light in HomeKit is 0.0001. I have no idea why...but it is. Honor it.
    const value = this.ambientLight;
    lightService.updateCharacteristic(this.hap.Characteristic.CurrentAmbientLightLevel, value >= 0.0001 ? value : 0.0001);

    // Update the state characteristics.
    this.configureStateCharacteristics(lightService);

    return true;
  }

  // Configure the contact sensor for HomeKit.
  private configureContactSensor(): boolean {

    // Find the service, if it exists.
    let contactService = this.accessory.getServiceById(this.hap.Service.ContactSensor, ProtectReservedNames.CONTACT_SENSOR);

    // Have we disabled the sensor or are we configured as a leak sensor?
    if(!this.ufp.mountType || (this.ufp.mountType === "leak") || (this.ufp.mountType === "none")) {

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

      return this.contact;
    });

    // Update the sensor.
    contactService.updateCharacteristic(this.hap.Characteristic.ContactSensorState, this.contact);

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

      const value = this.humidity;
      return value < 0 ? 0 : value;
    });

    // Update the sensor.
    const value = this.humidity;
    humidityService.updateCharacteristic(this.hap.Characteristic.CurrentRelativeHumidity, value < 0 ? 0 : value);

    // Update the state characteristics.
    this.configureStateCharacteristics(humidityService);

    return true;
  }

  // Configure the leak sensor for HomeKit.
  private configureLeakSensor(): boolean {

    // Find the service, if it exists.
    let leakService = this.accessory.getService(this.hap.Service.LeakSensor);

    // Have we disabled the leak sensor?
    if(this.ufp.mountType !== "leak") {

      if(leakService) {

        this.accessory.removeService(leakService);
        this.log.info("Disabling leak sensor.");
      }

      return false;
    }

    // Add the service to the accessory, if needed.
    if(!leakService) {

      leakService = new this.hap.Service.LeakSensor(this.accessory.displayName);

      if(!leakService) {

        this.log.error("Unable to add leak sensor.");
        return false;
      }

      this.accessory.addService(leakService);

      this.log.info("Enabling leak sensor.");
    }

    // Retrieve the current contact sensor state when requested.
    leakService.getCharacteristic(this.hap.Characteristic.LeakDetected)?.onGet(() => {

      return this.leakDetected;
    });

    // Update the sensor.
    leakService.updateCharacteristic(this.hap.Characteristic.LeakDetected, this.leakDetected);

    // Update the state characteristics.
    this.configureStateCharacteristics(leakService);

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

      const value = this.temperature;
      return value < 0 ? 0 : value;
    });

    // Update the sensor.
    const value = this.temperature;
    temperatureService.updateCharacteristic(this.hap.Characteristic.CurrentTemperature, value < 0 ? 0 : value);

    // Update the state characteristics.
    this.configureStateCharacteristics(temperatureService);

    return true;
  }

  // Configure the active connection status in HomeKit.
  private configureActiveStatus(service: Service): boolean {

    // Retrieve the current connection status when requested.
    service.getCharacteristic(this.hap.Characteristic.StatusActive)?.onGet(() => {

      return this.isOnline;
    });

    // Update the current connection status.
    service.updateCharacteristic(this.hap.Characteristic.StatusActive, this.isOnline);

    return true;
  }

  // Update the battery status in HomeKit.
  private updateBatteryStatus(): boolean {

    // Find the battery service, if it exists.
    const batteryService = this.accessory.getService(this.hap.Service.Battery);

    // We don't have the battery service, we're done.
    if(!batteryService) {

      return false;
    }

    // Update the battery status.
    batteryService.updateCharacteristic(this.hap.Characteristic.BatteryLevel, this.ufp.batteryStatus?.percentage ?? 0);
    batteryService.updateCharacteristic(this.hap.Characteristic.StatusLowBattery, this.ufp.batteryStatus?.isLow);

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

    // Update the tamper status.
    this.configureTamperedStatus(service);

    return true;
  }

  // Get the current alarm alert detection information.
  private get alarmDetected(): boolean {

    // Return true if we are not null, meaning the alarm has sounded.
    const value = this.ufp.alarmTriggeredAt !== null;

    // Save the state change and publish to MQTT.
    if(value !== this.lastAlarm) {

      this.lastAlarm = value;
      this.nvr.mqtt?.publish(this.accessory, "alarm", value.toString());

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

    // Return true if we are open.
    const value = this.ufp.isOpened;

    // Save the state change and publish to MQTT.
    if(value !== this.lastContact) {

      this.lastContact = value;
      this.nvr.mqtt?.publish(this.accessory, "contact", value.toString());
    }

    return value;
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
      this.nvr.mqtt?.publish(this.accessory, "leak", value.toString());

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

    this.nvr.mqtt?.subscribeGet(this.accessory, this.name, "alarm", "Alarm detected", () => {

      return this.alarmDetected.toString();
    });

    this.nvr.mqtt?.subscribeGet(this.accessory, this.name, "ambientlight", "Ambient light", () => {

      return this.ambientLight.toString();
    });

    this.nvr.mqtt?.subscribeGet(this.accessory, this.name, "contact", "Contact sensor", () => {

      return this.contact.toString();
    });

    this.nvr.mqtt?.subscribeGet(this.accessory, this.name, "humidity", "Humidity", () => {

      return this.humidity.toString();
    });

    this.nvr.mqtt?.subscribeGet(this.accessory, this.name, "leak", "Leak detected", () => {

      return this.leakDetected.toString();
    });

    this.nvr.mqtt?.subscribeGet(this.accessory, this.name, "temperature", "Temperature", () => {

      return this.temperature.toString();
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
