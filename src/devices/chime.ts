/* Copyright(C) 2023-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * chime.ts: Chime device class for UniFi Protect.
 */
import type { Chime, PlaySpeakerOptions, ProtectChimeConfig } from "unifi-protect";
import type { ProtectAccessory, WithoutIdentity } from "../types.ts";
import type { CharacteristicValue } from "homebridge";
import { PROTECT_DOORBELL_CHIME_SPEAKER_DURATION } from "../settings.ts";
import { ProtectDevice } from "./device.ts";
import type { ProtectNvr } from "../nvr/nvr.ts";
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

  // Read-through to the chime projection's live STATE, narrowed to drop device identity (id/mac/modelKey). Identity flows through the dedicated non-throwing accessors
  // (protectId/modelKey/.id/.mac), never this throwing config getter; this override mirrors the base getter's body and narrows only the surfaced return type.
  public override get ufp(): Readonly<WithoutIdentity<ProtectChimeConfig>> {

    return this.device.config;
  }

  // Initialize and configure the chime accessory for HomeKit.
  private configureDevice(): boolean {

    // Reset the persisted context to a clean slate and reseed identity. Homebridge persists the context to disk across restarts, and a UUID this accessory reuses from a
    // prior incarnation - a different device or an older plugin schema - could still carry stray keys that do not apply to this chime, which persists no user state.
    this.resetAccessoryContext();

    // Configure accessory information.
    this.configureInfo();

    // Newer UniFi Protect controllers relocated the chime volume control to the doorbell's settings. Remove any legacy volume service.
    let service = this.accessory.getService(this.hap.Service.Lightbulb);

    if(service) {

      this.accessory.removeService(service);
    }

    // Configure the buzzer on the chime.
    this.configureChimeSwitch("buzzer", "buzzer", ProtectReservedNames.SWITCH_DOORBELL_CHIME_BUZZER);

    // A chime's persisted accessory can still carry a speaker switch registered under this flat, un-suffixed subtype, predating the per-ringtone switches that
    // configureRingtoneSwitches creates below. That method's own prune only tracks switches carrying a per-ringtone id suffix, so a lingering flat-subtype switch is
    // never reachable from there and must be removed here, unconditionally, on every configure pass.
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

    // The controller's ringtone collection, read through the live projection and scoped to this controller. Always an array post-connect, so the configuration
    // pass and the prune below operate on it directly.
    const ringtones = this.nvr.client.ringtones.filter(tone => tone.nvrMac === this.nvr.ufp.mac);

    for(const track of ringtones) {

      this.configureChimeSwitch(track.name, "speaker", ProtectReservedNames.SWITCH_DOORBELL_CHIME_SPEAKER + "." + track.id);
    }

    // Remove ringtones that no longer exist.
    for(const service of this.accessory.services.filter(x => x.subtype?.startsWith(ProtectReservedNames.SWITCH_DOORBELL_CHIME_SPEAKER + ".") &&
      !ringtones.some(tone => tone.id === x.subtype?.slice(ProtectReservedNames.SWITCH_DOORBELL_CHIME_SPEAKER.length + 1)))) {

      // Clear the pruned ringtone's auto-reset timer before removing its service, so a ringtone deleted mid-playback leaves no pending timer to later fire against a
      // detached service. HAP's Service.subtype is string | undefined, so bind and guard it before passing it as the timer key.
      const subtype = service.subtype;

      if(subtype) {

        this.clearTimer(subtype);
      }

      this.accessory.removeService(service);
    }
  }

  // Configure one chime switch (the buzzer or a ringtone speaker) for HomeKit. The kind ("buzzer" or "speaker") names the chime's sound source for playTone; the
  // auto-reset timer is keyed by the switch's OWN subtype, not by kind, so concurrent ringtone plays never displace each other's reset - registerTimeout's same-key
  // replacement silently drops the displaced callback, which a shared "speaker" key would trigger, stranding every-but-the-last ringtone's tile on forever.
  private configureChimeSwitch(name: string, kind: "buzzer" | "speaker", subtype: string): boolean {

    // Acquire the service.
    const service = this.acquireService(this.hap.Service.Switch, this.accessoryName + " " + toStartCase(name), subtype);

    if(!service) {

      this.log.error("Unable to add " + name + " switch.");

      return false;
    }

    // Reflect and drive the play state for this sound source (buzzer or ringtone speaker).
    service.getCharacteristic(this.hap.Characteristic.On).onGet(() => {

      return this.timers.has(subtype);
    });

    service.getCharacteristic(this.hap.Characteristic.On).onSet(async (value: CharacteristicValue) => {

      // We only act on an activating set. A falsy set is meaningless here: you cannot undo a play command to the chime, so we just revert the switch to its real state
      // and return.
      if(!value) {

        // Let HomeKit's optimistic write settle, then re-assert the switch's real play state. The 50ms is a cosmetic revert nudge, not a functional delay.
        setTimeout(() => service.updateCharacteristic(this.hap.Characteristic.On, this.timers.has(subtype)), 50);

        return;
      }

      let tone;

      // See if we've selected a specific tone.
      if(subtype.startsWith(ProtectReservedNames.SWITCH_DOORBELL_CHIME_SPEAKER + ".")) {

        tone = subtype.slice(ProtectReservedNames.SWITCH_DOORBELL_CHIME_SPEAKER.length + 1);
      }

      // Play the tone. The shared command-error helper that playTone routes through is the single failure log, so on failure we only revert the switch to its real state
      // and return - arming the auto-reset timer or logging playback past this point would leave a failed play showing as "playing" for the full duration.
      if(!(await this.playTone(name, kind, tone))) {

        setTimeout(() => service.updateCharacteristic(this.hap.Characteristic.On, this.timers.has(subtype)), 50);

        return;
      }

      // The play started, so hold the switch on for the playback window and then auto-reset it to its real state.
      this.registerTimeout(subtype,
        () => service.updateCharacteristic(this.hap.Characteristic.On, this.timers.has(subtype)), PROTECT_DOORBELL_CHIME_SPEAKER_DURATION);

      // Inform the user.
      this.log.info("Playing %s.", name);
    });

    // Initialize the switch.
    service.updateCharacteristic(this.hap.Characteristic.On, false);

    return true;
  }

  // Play the specified tone on the chime - a ringtone through the speaker or the piezo buzzer, selected by the typed kind discriminant. The unifi-protect library
  // exposes these as two distinct commands (playSpeaker / playBuzzer), so we dispatch on kind rather than reconstructing a controller path string.
  private async playTone(name: string, kind: "buzzer" | "speaker", tone?: string): Promise<boolean> {

    // A tone targeting a chime whose controller record has vanished (an unadopt lingering in the removal grace) cannot be fulfilled, so we no-op gracefully rather than
    // throwing on the ringSettings read below.
    if(!this.recordPresent) {

      return false;
    }

    // For a speaker tone, source the configured playback (repeat count and volume) for the selected ringtone from this chime's own ringSettings - the join the library
    // deliberately leaves to the consumer (the chime recipe). The buzzer takes no payload. When the requested ringtone id has no match, we fall back to the first entry
    // in ringSettings for its repeat count and volume while still reporting the originally requested id to the controller; only an empty ringSettings array (no
    // ringtones configured at all) is treated as a no-op below.
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
    // chime's ringtone-switch reconcile. Because the collection advances only on the StateStore refresh, this observer re-runs the reconcile at that refresh cadence.
    this.observeState({ key: "nvr.ringtones", selector: selectRingtones, title: "the chime ringtones" }, () => this.updateDevice());
  }
}
