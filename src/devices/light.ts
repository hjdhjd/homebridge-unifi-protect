/* Copyright(C) 2019-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-light.ts: Light device class for UniFi Protect.
 */
import type { Light, ProtectLightConfig } from "unifi-protect";
import type { CharacteristicValue } from "homebridge";
import type { ProtectAccessory } from "../types.ts";
import { ProtectDevice } from "./device.ts";
import type { ProtectNvr } from "../nvr/nvr.ts";
import { ProtectReservedNames } from "../types.ts";
import { selectLight } from "unifi-protect";

export class ProtectLight extends ProtectDevice {

  // Narrow the inherited projection handle to the light projection so the read-through config getter resolves to ProtectLightConfig.
  declare protected readonly device: Light;

  // Create an instance.
  constructor(nvr: ProtectNvr, accessory: ProtectAccessory, device: Light) {

    super(nvr, accessory, device);

    this.configureHints();
    this.configureDevice();
    this.spawnObservers();
  }

  // Read-through config, narrowed to the light projection's config record.
  public override get ufp(): Readonly<ProtectLightConfig> {

    return this.device.config;
  }

  // Initialize and configure the light accessory for HomeKit.
  private configureDevice(): boolean {

    // Clean out the context object in case it's been polluted somehow.
    this.accessory.context = {};
    this.accessory.context.mac = this.ufp.mac;
    this.accessory.context.nvr = this.nvr.ufp.mac;

    // Configure accessory information.
    this.configureInfo();

    // Configure the light.
    this.configureLightbulb();

    // Configure the motion sensor.
    this.configureMotionSensor();

    // Configure the occupancy sensor.
    this.configureOccupancySensor();

    // Configure the status indicator light switch.
    this.configureStatusLedSwitch();

    // Configure MQTT services.
    this.configureMqtt();

    return true;
  }

  // Configure the light for HomeKit.
  private configureLightbulb(): boolean {

    // Acquire the service.
    const service = this.acquireService(this.hap.Service.Lightbulb);

    // Add the switch to the device, if needed.
    if(!service) {

      this.log.error("Unable to add light.");

      return false;
    }

    // Turn the light on or off.
    service.getCharacteristic(this.hap.Characteristic.On).onGet(() => {

      return this.ufp.isLightOn;
    });

    service.getCharacteristic(this.hap.Characteristic.On).onSet(async (value: CharacteristicValue) => {

      const lightState = value === true;

      // Push the new power state to the controller, reporting any failure through the shared command-error helper.
      if(!(await this.runDeviceCommand("turn the light " + (lightState ? "on" : "off"), () => this.device.update({ lightOnSettings: { isLedForceOn: lightState } })))) {

        return;
      }

      // Publish our state.
      this.publish("light", lightState ? "true" : "false");
    });

    // Adjust the brightness of the light.
    service.getCharacteristic(this.hap.Characteristic.Brightness).onGet(() => {

      return this.ledLevelToBrightness(this.ufp.lightDeviceSettings.ledLevel);
    });

    service.getCharacteristic(this.hap.Characteristic.Brightness).onSet(async (value: CharacteristicValue) => {

      const brightness = this.brightnessToLedLevel(value as number);

      // Push the new brightness to the controller, reporting any failure through the shared command-error helper.
      if(!(await this.runDeviceCommand("adjust the brightness to " + (value as number).toString() + "%",
        () => this.device.update({ lightDeviceSettings: { ledLevel: brightness } })))) {

        return;
      }

      // Make sure we properly reflect what brightness we're actually at, given the differences in setting granularity between Protect and HomeKit.
      setTimeout(() => service.updateCharacteristic(this.hap.Characteristic.Brightness, this.ledLevelToBrightness(brightness)), 50);

      // Publish our state.
      this.publish("light/brightness", this.ledLevelToBrightness(brightness).toString());
    });

    // Initialize the light.
    service.updateCharacteristic(this.hap.Characteristic.On, this.ufp.isLightOn);
    service.updateCharacteristic(this.hap.Characteristic.Brightness, this.ledLevelToBrightness(this.ufp.lightDeviceSettings.ledLevel));

    return true;
  }

  // Configure MQTT capabilities of this light.
  private configureMqtt(): boolean {

    // Get the light state.
    this.subscribeGet("light", "light status", () => {

      return (this.ufp.isLightOn).toString();
    });

    this.subscribeGet("light/brightness", "light brightness", () => {

      return this.ledLevelToBrightness(this.ufp.lightDeviceSettings.ledLevel).toString();
    });

    // Control the light.
    this.subscribeSet("light", "light", (value: string) => {

      this.accessory.getService(this.hap.Service.Lightbulb)?.setCharacteristic(this.hap.Characteristic.On, value === "true");
    });

    this.subscribeSet("light/brightness", "light brightness", (value: string) => {

      const brightness = parseInt(value);

      // Unknown message - ignore it.
      if(isNaN(brightness) || (brightness < 0) || (brightness > 100)) {

        return;
      }

      this.accessory.getService(this.hap.Service.Lightbulb)?.setCharacteristic(this.hap.Characteristic.Brightness, brightness);
    });

    return true;
  }

  // Spawn the light's narrow-selector observers (Fork B). super spawns the universal name-sync observer; the light adds its four reactions, each waking only on its own
  // slice through the store's reference dedup.
  protected override spawnObservers(): void {

    super.spawnObservers();

    const light = selectLight(this.ufp.id);

    // Light motion, like sensor and camera motion, is a device-state field (lastMotion) the controller advances rather than a firehose occurrence, so observing the
    // timestamp is the single source for this device, firing only on a real (truthy) detection rather than re-synthesizing it from a held prior value.
    this.observeState({ key: "light.lastMotion", selector: state => light(state)?.lastMotion, title: "motion detection" }, lastMotion => {

      if(lastMotion) {

        this.nvr.events.motionEventHandler(this);
      }
    });

    // The light's power state drives the Lightbulb On characteristic.
    this.observeState({ key: "light.isLightOn", selector: state => light(state)?.isLightOn, title: "the light" }, () => {

      this.accessory.getService(this.hap.Service.Lightbulb)?.updateCharacteristic(this.hap.Characteristic.On, this.ufp.isLightOn);
    });

    // The light's LED level drives the Lightbulb Brightness, mapped from Protect's 1-6 scale to a HomeKit percentage.
    this.observeState({ key: "light.ledLevel", selector: state => light(state)?.lightDeviceSettings.ledLevel, title: "brightness" }, () => {

      const brightness = this.ledLevelToBrightness(this.ufp.lightDeviceSettings.ledLevel);

      this.accessory.getService(this.hap.Service.Lightbulb)?.updateCharacteristic(this.hap.Characteristic.Brightness, brightness);
    });

    // The light's indicator setting drives the status-indicator switch, when that switch is configured.
    this.observeState({ key: "light.isIndicatorEnabled", selector: state => light(state)?.lightDeviceSettings.isIndicatorEnabled, title: "the status light" }, () => {

      this.accessory.getServiceById(this.hap.Service.Switch, ProtectReservedNames.SWITCH_STATUS_LED)?.updateCharacteristic(this.hap.Characteristic.On, this.statusLed);
    });
  }

  // Build the write-through command that sets the status indicator on a Protect light, which uses lightDeviceSettings.isIndicatorEnabled rather than the ledSettings
  // field cameras and sensors expose. this.device is the narrowed Light projection here, so the update typechecks against the light config directly.
  protected override statusLedCommand(value: boolean): () => Promise<unknown> {

    return () => this.device.update({ lightDeviceSettings: { isIndicatorEnabled: value } });
  }

  // Utility function to return the current state of the status indicator light.
  public override get statusLed(): boolean {

    return this.ufp.lightDeviceSettings.isIndicatorEnabled;
  }

  // Convert a HomeKit brightness percentage (0-100) to a Protect LED level (1-6).
  private brightnessToLedLevel(brightness: number): number {

    return Math.round((brightness / 20) + 1);
  }

  // Convert a Protect LED level (1-6) to a HomeKit brightness percentage (0-100).
  private ledLevelToBrightness(ledLevel: number): number {

    return (ledLevel - 1) * 20;
  }
}
