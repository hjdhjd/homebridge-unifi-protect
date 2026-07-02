/* Copyright(C) 2019-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * light.ts: Light device class for UniFi Protect.
 */
import type { Light, ProtectLightConfig } from "unifi-protect";
import type { ProtectAccessory, WithoutIdentity } from "../types.ts";
import type { CharacteristicValue } from "homebridge";
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

  // Read-through to the light projection's live STATE, narrowed to drop device identity (id/mac/modelKey). Identity flows through the dedicated non-throwing accessors
  // (protectId/modelKey/.id/.mac), never this throwing config getter; this override mirrors the base getter's body and narrows only the surfaced return type.
  public override get ufp(): Readonly<WithoutIdentity<ProtectLightConfig>> {

    return this.device.config;
  }

  // The light's power state, read non-throwing through the record. An absent record (a light lingering in the removal grace) reports off rather than throwing.
  private get isLightOn(): boolean {

    return this.fromRecord((config) => config.isLightOn, false);
  }

  // The light's HomeKit brightness, read non-throwing through the record. An absent record reports 0%; we default the MAPPED brightness output, not the raw LED level,
  // because a raw ledLevel default of 0 would map to a brightness of -20, which HomeKit cannot represent.
  private get ledBrightness(): number {

    return this.fromRecord((config) => this.ledLevelToBrightness(config.lightDeviceSettings.ledLevel), 0);
  }

  // Initialize and configure the light accessory for HomeKit.
  private configureDevice(): boolean {

    // Clean out the context object in case it's been polluted somehow.
    this.accessory.context = {};

    // Seed the identity source of truth (the persisted bare MAC) from the raw record at configure time, where the record is present - identity is not read through the
    // narrowed live-state projection.
    this.accessory.context.mac = this.device.config.mac;
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

    // Fail gracefully.
    if(!service) {

      this.log.error("Unable to add light.");

      return false;
    }

    // Turn the light on or off.
    service.getCharacteristic(this.hap.Characteristic.On).onGet(() => {

      return this.isLightOn;
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

      return this.ledBrightness;
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
    service.updateCharacteristic(this.hap.Characteristic.On, this.isLightOn);
    service.updateCharacteristic(this.hap.Characteristic.Brightness, this.ledBrightness);

    return true;
  }

  // Configure MQTT capabilities of this light.
  private configureMqtt(): boolean {

    // Get the light state.
    this.subscribeGet("light", "light status", () => {

      return this.isLightOn.toString();
    });

    this.subscribeGet("light/brightness", "light brightness", () => {

      return this.ledBrightness.toString();
    });

    // Control the light.
    this.subscribeSet("light", "light", (value: string) => {

      this.accessory.getService(this.hap.Service.Lightbulb)?.setCharacteristic(this.hap.Characteristic.On, value === "true");
    });

    this.subscribeSet("light/brightness", "light brightness", (value: string) => {

      const brightness = parseInt(value);

      // Unparseable or out-of-range brightness - ignore it.
      if(isNaN(brightness) || (brightness < 0) || (brightness > 100)) {

        return;
      }

      this.accessory.getService(this.hap.Service.Lightbulb)?.setCharacteristic(this.hap.Characteristic.Brightness, brightness);
    });

    return true;
  }

  // Spawn the light's narrow-selector observers. super spawns the two universal observers (name sync and firmware/device-info refresh); the light adds its four
  // reactions, each waking only on its own slice through the store's reference dedup.
  protected override spawnObservers(): void {

    super.spawnObservers();

    const light = selectLight(this.device.id);

    // Light motion, like sensor and camera motion, is a device-state field (lastMotion) the controller advances rather than a firehose occurrence, so observing the
    // timestamp is the single source for this device, firing only on a real (truthy) detection rather than re-synthesizing it from a held prior value.
    this.observeState({ key: "light.lastMotion", selector: state => light(state)?.lastMotion, title: "motion detection" }, lastMotion => {

      if(lastMotion) {

        this.nvr.events.motionEventHandler(this);
      }
    });

    // The light's power state drives the Lightbulb On characteristic.
    this.observeState({ key: "light.isLightOn", selector: state => light(state)?.isLightOn, title: "the light" }, () => {

      this.accessory.getService(this.hap.Service.Lightbulb)?.updateCharacteristic(this.hap.Characteristic.On, this.isLightOn);
    });

    // The light's LED level drives the Lightbulb Brightness, mapped from Protect's 1-6 scale to a HomeKit percentage.
    this.observeState({ key: "light.ledLevel", selector: state => light(state)?.lightDeviceSettings.ledLevel, title: "brightness" }, () => {

      this.accessory.getService(this.hap.Service.Lightbulb)?.updateCharacteristic(this.hap.Characteristic.Brightness, this.ledBrightness);
    });

    // The light's indicator setting drives the status-indicator switch, when that switch is configured.
    this.observeState({ key: "light.isIndicatorEnabled", selector: state => light(state)?.lightDeviceSettings.isIndicatorEnabled, title: "the status light" }, () => {

      this.accessory.getServiceById(this.hap.Service.Switch, ProtectReservedNames.SWITCH_STATUS_LED)?.updateCharacteristic(this.hap.Characteristic.On, this.statusLed);
    });
  }

  // Build the write-through command that sets the status indicator on a Protect light, which uses lightDeviceSettings.isIndicatorEnabled rather than the ledSettings
  // field cameras, sensors, and relays expose. this.device is the narrowed Light projection here, so the update typechecks against the light config directly.
  protected override statusLedCommand(value: boolean): () => Promise<unknown> {

    return () => this.device.update({ lightDeviceSettings: { isIndicatorEnabled: value } });
  }

  // Utility function to return the current state of the status indicator light. An absent record reports off rather than throwing.
  public override get statusLed(): boolean {

    return this.fromRecord((config) => config.lightDeviceSettings.isIndicatorEnabled, false);
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
