/* Copyright(C) 2019-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * light.ts: Light device class for UniFi Protect.
 */
import type { CharacteristicValue } from "homebridge";
import type { Light } from "unifi-protect";
import { ProtectDevice } from "./device.ts";
import { ProtectReservedNames } from "../types.ts";
import { mqttTopics } from "../mqtt.ts";

export class ProtectLight extends ProtectDevice<Light> {

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
  protected override configureDevice(): boolean {

    // Reset the persisted context to a clean slate, discarding any stray keys left over from a prior configuration of this same accessory, while preserving the user's
    // motion-detection choice across the restart - a persisted detectMotion of false must survive rather than being wiped back to the default.
    this.resetAccessoryContext({ detectMotion: true });

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
  private configureLightbulb(): void {

    // Acquire the service.
    const { service } = this.acquireService({ serviceType: this.hap.Service.Lightbulb });

    // Turn the light on or off.
    service.getCharacteristic(this.hap.Characteristic.On).onGet(this.answering(() => {

      return this.isLightOn;
    }));

    service.getCharacteristic(this.hap.Characteristic.On).onSet(this.answering(async (value: CharacteristicValue) => this.setPower(value)));

    // Adjust the brightness of the light.
    service.getCharacteristic(this.hap.Characteristic.Brightness).onGet(this.answering(() => {

      return this.ledBrightness;
    }));

    service.getCharacteristic(this.hap.Characteristic.Brightness).onSet(this.answering(async (value: CharacteristicValue) => this.setBrightness(value)));

    // Initialize the light.
    service.updateCharacteristic(this.hap.Characteristic.On, this.isLightOn);
    service.updateCharacteristic(this.hap.Characteristic.Brightness, this.ledBrightness);
  }

  // Turn the light on or off, the one body HomeKit's write and the MQTT set share.
  private async setPower(value: CharacteristicValue): Promise<void> {

    const lightState = value === true;

    // Push the new power state to the controller, reporting any failure through the shared command-error helper.
    await this.runDeviceCommand("turn the light " + (lightState ? "on" : "off"), () => this.device.update({ lightOnSettings: { isLedForceOn: lightState } }));
  }

  // Adjust the brightness of the light, the one body HomeKit's write and the MQTT set share.
  private async setBrightness(value: CharacteristicValue): Promise<void> {

    const brightness = this.brightnessToLedLevel(value as number);

    // Push the new brightness to the controller, reporting any failure through the shared command-error helper.
    if(!(await this.runDeviceCommand("adjust the brightness to " + (value as number).toString() + "%",
      () => this.device.update({ lightDeviceSettings: { ledLevel: brightness } })))) {

      return;
    }

    // Make sure we properly reflect what brightness we're actually at, given the differences in setting granularity between Protect and HomeKit.
    this.reflectAfterSet(() => this.accessory.getService(this.hap.Service.Lightbulb)?.updateCharacteristic(this.hap.Characteristic.Brightness,
      this.ledLevelToBrightness(brightness)));
  }

  // Publish the light's on state, the value its MQTT get answers, when it changed. The controller's reported change is the one publisher, so a change made here or in
  // the Protect app publishes once, from the observer.
  private publishLightState(): void {

    this.publishState(mqttTopics.light.topic, this.isLightOn.toString());
  }

  // Publish the light's brightness percentage, the value its MQTT get answers, when it changed, from the observer that carries the controller's change.
  private publishBrightnessState(): void {

    this.publishState(mqttTopics.lightBrightness.topic, this.ledBrightness.toString());
  }

  // Configure MQTT capabilities of this light.
  private configureMqtt(): boolean {

    // Get the light state.
    this.subscribeGet(mqttTopics.light.topic, mqttTopics.light.label, () => {

      return this.isLightOn.toString();
    });

    this.subscribeGet(mqttTopics.lightBrightness.topic, mqttTopics.lightBrightness.label, () => {

      return this.ledBrightness.toString();
    });

    // Control the light. A set reaches the controller whatever HomeKit is being told, so each runs its body directly rather than through the refusing handler.
    this.subscribeSet(mqttTopics.light.topic, mqttTopics.light.label, (value: string) => {

      void this.driveSet({ characteristic: this.hap.Characteristic.On, service: this.accessory.getService(this.hap.Service.Lightbulb),
        set: (lightState) => this.setPower(lightState), value: value === "true" });
    });

    this.subscribeSet(mqttTopics.lightBrightness.topic, mqttTopics.lightBrightness.label, (value: string) => {

      const brightness = parseInt(value);

      // Unparseable or out-of-range brightness - ignore it.
      if(isNaN(brightness) || (brightness < 0) || (brightness > 100)) {

        return;
      }

      void this.driveSet({ characteristic: this.hap.Characteristic.Brightness, service: this.accessory.getService(this.hap.Service.Lightbulb),
        set: (level) => this.setBrightness(level), value: brightness });
    });

    // State the light's held state as it is set up, since its setup publishes nothing else, and again at the start of every later broker session, through the methods
    // its observers publish with.
    const restate = (): void => {

      this.publishLightState();
      this.publishBrightnessState();
    };

    restate();
    this.restateOnConnect(restate);

    return true;
  }

  // Spawn the light's narrow-selector observers. super spawns the base class's universal observers (name sync and firmware/device-info refresh); the light adds its
  // own narrow reactions below, each waking only on its own slice through the store's reference dedup.
  protected override spawnObservers(): void {

    super.spawnObservers();

    const light = this.nvr.client.state.selectors.light.byId(this.device.id);

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
      this.publishLightState();
    });

    // The light's LED level drives the Lightbulb Brightness, mapped from Protect's 1-6 scale to a HomeKit percentage.
    this.observeState({ key: "light.ledLevel", selector: state => light(state)?.lightDeviceSettings.ledLevel, title: "brightness" }, () => {

      this.accessory.getService(this.hap.Service.Lightbulb)?.updateCharacteristic(this.hap.Characteristic.Brightness, this.ledBrightness);
      this.publishBrightnessState();
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
