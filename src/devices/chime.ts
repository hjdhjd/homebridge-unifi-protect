/* Copyright(C) 2023-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-chime.ts: Chime device class for UniFi Protect.
 */
import type { Chime, PlaySpeakerOptions, ProtectChimeConfig } from "unifi-protect";
import type { CharacteristicValue } from "homebridge";
import { PROTECT_DOORBELL_CHIME_SPEAKER_DURATION } from "../settings.ts";
import type { ProtectAccessory } from "../types.ts";
import { ProtectDevice } from "./device.ts";
import type { ProtectNvr } from "../nvr.ts";
import { ProtectReservedNames } from "../types.ts";
import { selectRingtones } from "unifi-protect";
import { toStartCase } from "homebridge-plugin-utils";

export class ProtectChime extends ProtectDevice {

  // Narrow the inherited projection handle to the chime projection so the read-through config getter resolves to ProtectChimeConfig.
  declare protected readonly device: Chime;

  // Create an instance.
  constructor(nvr: ProtectNvr, accessory: ProtectAccessory, device: Chime) {

    super(nvr, accessory, device);

    this.configureHints();
    this.configureDevice();

    // Spawn the base name-sync and device-information observers plus the chime's own ringtone-collection observer (see the spawnObservers override below).
    this.spawnObservers();
  }

  // Read-through config, narrowed to the chime projection's config record.
  public override get ufp(): Readonly<ProtectChimeConfig> {

    return this.device.config;
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
    this.configureChimeSwitch("buzzer", "buzzer", ProtectReservedNames.SWITCH_DOORBELL_CHIME_BUZZER);

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

    // The controller's ringtone collection, read through the live v5 projection and scoped to this controller. Always an array post-connect, so the configuration
    // pass and the prune below operate on it directly.
    const ringtones = this.nvr.client.ringtones.filter(tone => tone.nvrMac === this.nvr.ufp.mac);

    for(const track of ringtones) {

      this.configureChimeSwitch(track.name, "speaker", ProtectReservedNames.SWITCH_DOORBELL_CHIME_SPEAKER + "." + track.id);
    }

    // Remove ringtones that no longer exist.
    for(const service of this.accessory.services.filter(x => x.subtype?.startsWith(ProtectReservedNames.SWITCH_DOORBELL_CHIME_SPEAKER + ".") &&
      !ringtones.some(tone => tone.id === x.subtype?.slice(ProtectReservedNames.SWITCH_DOORBELL_CHIME_SPEAKER.length + 1)))) {

      this.accessory.removeService(service);
    }
  }

  // Configure chime speaker switches for HomeKit. The kind discriminant ("buzzer" or "speaker") names the chime's two sound sources directly and doubles as the
  // per-switch timer key, so all ringtone speaker switches share the one "speaker" timer exactly as they shared the "play-speaker" endpoint string before the migration.
  private configureChimeSwitch(name: string, kind: "buzzer" | "speaker", subtype: string): boolean {

    // Acquire the service.
    const service = this.acquireService(this.hap.Service.Switch, this.accessoryName + " " + toStartCase(name), subtype);

    if(!service) {

      this.log.error("Unable to add " + name + " switch.");

      return false;
    }

    // Turn the speaker on or off.
    service.getCharacteristic(this.hap.Characteristic.On).onGet(() => {

      return this.timers.has(kind);
    });

    service.getCharacteristic(this.hap.Characteristic.On).onSet(async (value: CharacteristicValue) => {

      // We only want to do something if we're being activated and we don't have an active speaker event inflight. Turning off the switch would really be a meaningless
      // state given you can't undo the play command to the chime.
      if(!value) {

        setTimeout(() => service.updateCharacteristic(this.hap.Characteristic.On, this.timers.has(kind)), 50);

        return;
      }

      let tone;

      // See if we've selected a specific tone.
      if(subtype.startsWith(ProtectReservedNames.SWITCH_DOORBELL_CHIME_SPEAKER + ".")) {

        tone = subtype.slice(ProtectReservedNames.SWITCH_DOORBELL_CHIME_SPEAKER.length + 1);
      }

      // Play the tone. The shared command-error helper that playTone routes through is the single failure log, so on failure we only revert the switch to its real state.
      if(!(await this.playTone(name, kind, tone))) {

        setTimeout(() => service.updateCharacteristic(this.hap.Characteristic.On, this.timers.has(kind)), 50);
      }

      this.registerTimeout(kind,
        () => service.updateCharacteristic(this.hap.Characteristic.On, this.timers.has(kind)), PROTECT_DOORBELL_CHIME_SPEAKER_DURATION);

      // Inform the user.
      this.log.info("Playing %s.", name);
    });

    // Initialize the switch.
    service.updateCharacteristic(this.hap.Characteristic.On, false);

    return true;
  }

  // Play the specified tone on the chime - a ringtone through the speaker or the piezo buzzer, selected by the typed kind discriminant. v5 split these into two distinct
  // commands (playSpeaker / playBuzzer), so we dispatch on kind rather than reconstructing a controller path string.
  private async playTone(name: string, kind: "buzzer" | "speaker", tone?: string): Promise<boolean> {

    // For a speaker tone, source the configured playback (repeat count and volume) for the selected ringtone from this chime's own ringSettings - the join the library
    // deliberately leaves to the consumer (the chime recipe). The buzzer takes no payload. We resolve this before issuing the command so a missing ringtone is a clean
    // no-op rather than a failed call.
    let options: PlaySpeakerOptions = {};

    if((kind === "speaker") && tone) {

      const ring = this.ufp.ringSettings.find(setting => setting.ringtoneId === tone) ?? this.ufp.ringSettings[0];

      if(!ring) {

        return false;
      }

      options = { repeatTimes: ring.repeatTimes, ringtoneId: tone, volume: ring.volume };
    }

    // Route the user-initiated command through the shared command-error helper, which is the single failure log (admin guidance on an authorization failure). We publish
    // only on success.
    const played = await this.runDeviceCommand("play " + name, () => (kind === "buzzer") ? this.device.playBuzzer() : this.device.playSpeaker(options));

    if(played) {

      this.publish("tone", name);
    }

    return played;
  }

  // Configure MQTT capabilities of this chime.
  private configureMqtt(): boolean {

    // Play a tone on the chime.
    this.subscribeSet("tone", "chime tone", (value: string) => {

      switch(value) {

        case "chime":

          void this.playTone("chime", "speaker");

          break;

        case "buzzer":

          void this.playTone("buzzer", "buzzer");

          break;

        default:

          this.log.error("Unknown chime tone.");

          break;
      }
    });

    return true;
  }

  // Update device settings when Protect refreshes its configuration.
  public updateDevice(): void {

    this.configureRingtoneSwitches();
  }

  // Spawn the chime's narrow-selector observers. super spawns the universal name-sync and device-information observers; the chime adds its single ringtone-collection
  // reaction.
  protected override spawnObservers(): void {

    super.spawnObservers();

    // The ringtone library is a controller-wide collection; when it changes (a ringtone added/removed in Protect, which advances on the StateStore refresh), re-run the
    // chime's ringtone-switch reconcile. Restores the refresh-cadence reactivity the v4 syncDevices loop gave chimes.
    this.observeState({ key: "nvr.ringtones", selector: selectRingtones, title: "the chime ringtones" }, () => this.updateDevice());
  }
}
