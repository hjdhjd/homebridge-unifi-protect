/* Copyright(C) 2023-2025, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-chime.ts: Chime device class for UniFi Protect.
 */
import type { CharacteristicValue, PlatformAccessory } from "homebridge";
import { ProtectReservedNames, toCamelCase } from "../protect-types.js";
import { PROTECT_DOORBELL_CHIME_SPEAKER_DURATION } from "../settings.js";
import type { ProtectChimeConfig } from "unifi-protect";
import { ProtectDevice } from "./protect-device.js";
import type { ProtectNvr } from "../protect-nvr.js";

export class ProtectChime extends ProtectDevice {

  private readonly eventTimers: { [index: string]: NodeJS.Timeout };
  public ufp: ProtectChimeConfig;

  // Create an instance.
  constructor(nvr: ProtectNvr, device: ProtectChimeConfig, accessory: PlatformAccessory) {

    super(nvr, accessory);

    this.eventTimers = {};
    this.ufp = device;

    this.configureHints();
    this.configureDevice();
  }

  // Initialize and configure the chime accessory for HomeKit.
  private configureDevice(): boolean {

    // Clean out the context object in case it's been polluted somehow.
    this.accessory.context = {};
    this.accessory.context.mac = this.ufp.mac;
    this.accessory.context.nvr = this.nvr.ufp.mac;

    // Configure accessory information.
    this.configureInfo();

    // Protect v5 has relocated the chime volume control to the doorbell. Remove any legacy volume service.
    let service = this.accessory.getService(this.hap.Service.Lightbulb);

    if(service) {

      this.accessory.removeService(service);
    }

    // Configure the buzzer on the chime.
    this.configureChimeSwitch("buzzer", "play-buzzer", ProtectReservedNames.SWITCH_DOORBELL_CHIME_BUZZER);

    // Cleanup legacy switches.
    service = this.accessory.getServiceById(this.hap.Service.Switch, ProtectReservedNames.SWITCH_DOORBELL_CHIME_SPEAKER);

    if(service) {

      this.accessory.removeService(service);
    }

    // Configure ringtone-specific switches.
    this.configureRingtoneSwitches();

    // Configure MQTT services.
    this.configureMqtt();

    return true;
  }

  // Configure ringtone-specific switches.
  private configureRingtoneSwitches(): void {

    const ringtones = this.nvr.ufpApi.bootstrap?.ringtones.filter(tone => tone.nvrMac === this.nvr.ufp.mac);

    ringtones?.map(track => this.configureChimeSwitch(track.name, "play-speaker", ProtectReservedNames.SWITCH_DOORBELL_CHIME_SPEAKER + "." + track.id));

    // Remove ringtones that no longer exist.
    this.accessory.services.filter(service => service.subtype?.startsWith(ProtectReservedNames.SWITCH_DOORBELL_CHIME_SPEAKER + ".") &&
      !ringtones?.some(tone => tone.id === service.subtype?.slice(ProtectReservedNames.SWITCH_DOORBELL_CHIME_SPEAKER.length + 1)))
      .map(service => this.accessory.removeService(service));
  }

  // Configure chime speaker switches for HomeKit.
  private configureChimeSwitch(name: string, endpoint: string, subtype: string): boolean {

    // Acquire the service.
    const service = this.acquireService(this.hap.Service.Switch, this.accessoryName + " " + toCamelCase(name), subtype);

    if(!service) {

      this.log.error("Unable to add " + name + " switch.");

      return false;
    }

    // Turn the speaker on or off.
    service.getCharacteristic(this.hap.Characteristic.On)?.onGet(() => {

      return !!this.eventTimers[endpoint];
    });

    service.getCharacteristic(this.hap.Characteristic.On)?.onSet(async (value: CharacteristicValue) => {

      // We only want to do something if we're being activated and we don't have an active speaker event inflight. Turning off the switch would really be a meaningless
      // state given you can't undo the play command to the chime.
      if(!value) {

        setTimeout(() => service.updateCharacteristic(this.hap.Characteristic.On, !!this.eventTimers[endpoint]), 50);

        return;
      }

      let tone;

      // See if we've selected a specific tone.
      if(subtype.startsWith(ProtectReservedNames.SWITCH_DOORBELL_CHIME_SPEAKER + ".")) {

        tone = subtype.slice(ProtectReservedNames.SWITCH_DOORBELL_CHIME_SPEAKER.length + 1);
      }

      // Play the tone.
      if(!(await this.playTone(name, endpoint, tone))) {

        this.log.error("Unable to play " + name + ".");

        setTimeout(() => service.updateCharacteristic(this.hap.Characteristic.On, !!this.eventTimers[endpoint]), 50);
      }

      this.eventTimers[endpoint] = setTimeout(() => {

        delete this.eventTimers[endpoint];
        service.updateCharacteristic(this.hap.Characteristic.On, !!this.eventTimers[endpoint]);
      }, PROTECT_DOORBELL_CHIME_SPEAKER_DURATION);

      // Inform the user.
      this.log.info("Playing %s.", name);
    });

    // Initialize the switch.
    service.updateCharacteristic(this.hap.Characteristic.On, false);

    return true;
  }

  // Play the specified tone on the chime.
  private async playTone(name: string, endpoint: string, tone?: string): Promise<boolean> {

    if(!endpoint) {

      return false;
    }

    let payload = {};

    if(tone) {

      const ringSettings = this.ufp.ringSettings.find(ring => ring.ringtoneId === tone) ?? this.ufp.ringSettings[0];

      // We couldn't find the playback settings for this ringtone, we're done.
      if(!ringSettings) {

        return false;
      }

      payload = { repeatTimes: ringSettings.repeatTimes, ringtoneId: tone, volume: ringSettings.volume };
    }

    // Execute teh action on the chime.
    const response = await this.nvr.ufpApi.retrieve(this.nvr.ufpApi.getApiEndpoint(this.ufp.modelKey) + "/" + this.ufp.id + "/" + endpoint, {

      body: JSON.stringify(payload),
      method: "POST"
    });

    // Something went wrong.
    if(!response?.ok) {

      return false;
    }

    // Publish what we're playing.
    this.publish("tone", name);

    return true;
  }

  // Configure MQTT capabilities of this chime.
  private configureMqtt(): boolean {

    // Play a tone on the chime.
    this.subscribeSet("tone", "chime tone", (value: string) => {

      switch(value) {

        case "chime":

          void this.playTone("chime", "play-speaker");

          break;

        case "buzzer":

          void this.playTone("buzzer", "play-buzzer");

          break;

        default:

          this.log.error("Unknown chime tone.");

          break;
      }
    });

    return true;
  }

  // Update device settings when Protect refreshes it's configuration.
  public updateDevice(): void {

    this.configureRingtoneSwitches();
  }
}
