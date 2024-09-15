/* Copyright(C) 2023-2024, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-chime.ts: Chime device class for UniFi Protect.
 */
import { CharacteristicValue, PlatformAccessory } from "homebridge";
import { ProtectChimeConfig, ProtectChimeConfigPayload, ProtectEventPacket } from "unifi-protect";
import { ProtectReservedNames, toCamelCase } from "../protect-types.js";
import { PROTECT_DOORBELL_CHIME_SPEAKER_DURATION } from "../settings.js";
import { ProtectDevice } from "./protect-device.js";
import { ProtectNvr } from "../protect-nvr.js";

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

    // Configure the chime as a light. We don't have volume accessories, so a dimmer is the best we can currently do within the constraints of HomeKit.
    this.configureLightbulb();

    // Configure the buzzer on the chime.
    this.configureChimeSwitch("buzzer", "play-buzzer", ProtectReservedNames.SWITCH_DOORBELL_CHIME_BUZZER);

    // Cleanup legacy switches.
    const chimeService = this.accessory.getServiceById(this.hap.Service.Switch, ProtectReservedNames.SWITCH_DOORBELL_CHIME_SPEAKER);

    if(chimeService) {

      this.accessory.removeService(chimeService);
    }

    // Configure ringtone-specific switches.
    this.configureRingtoneSwitches();

    // Configure MQTT services.
    this.configureMqtt();

    // Listen for events.
    this.nvr.events.on("updateEvent." + this.ufp.id, this.listeners["updateEvent." + this.ufp.id] = this.eventHandler.bind(this));

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

  // Configure the light for HomeKit.
  private configureLightbulb(): boolean {

    // Acquire the service.
    const service = this.acquireService(this.hap.Service.Lightbulb);

    if(!service) {

      this.log.error("Unable to add chime.");

      return false;
    }

    // Turn the chime on or off.
    service.getCharacteristic(this.hap.Characteristic.On)?.onGet(() => {

      return this.ufp.volume > 0;
    });

    service.getCharacteristic(this.hap.Characteristic.On)?.onSet(async (value: CharacteristicValue) => {

      // We really only want to act when the chime is turned off. Otherwise, it's handled by the brightness event.
      if(value) {

        return;
      }

      const newDevice = await this.nvr.ufpApi.updateDevice(this.ufp, { volume: 0 });

      if(!newDevice) {

        this.log.error("Unable to turn the volume off. Please ensure this username has the Administrator role in UniFi Protect.");

        return;
      }

      // Set the context to our updated device configuration.
      this.ufp = newDevice;
    });

    // Adjust the volume of the chime by adjusting brightness of the light.
    service.getCharacteristic(this.hap.Characteristic.Brightness)?.onGet(() => {

      // Return the volume level of the chime.
      return this.ufp.volume;
    });

    service.getCharacteristic(this.hap.Characteristic.Brightness)?.onSet(async (value: CharacteristicValue) => {

      const newDevice = await this.nvr.ufpApi.updateDevice(this.ufp, { volume: value as number });

      if(!newDevice) {

        this.log.error("Unable to adjust the volume to %s%. Please ensure this username has the Administrator role in UniFi Protect.", value);

        return;
      }

      // Set the context to our updated device configuration.
      this.ufp = newDevice;
      this.publish("chime", this.ufp.volume.toString());
    });

    // Initialize the chime.
    service.updateCharacteristic(this.hap.Characteristic.On, this.ufp.volume > 0);
    service.updateCharacteristic(this.hap.Characteristic.Brightness, this.ufp.volume);

    return true;
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

    // Get and set the chime volume.
    this.subscribeGet("chime", "chime volume", (): string => {

      return this.ufp.volume.toString();
    });

    this.subscribeSet("chime", "chime volume", (value: string) => {

      const volume = parseInt(value.toString());

      // Unknown message - ignore it.
      if(isNaN(volume) || (volume < 0) || (volume > 100)) {

        return;
      }

      // We explicitly want to trigger our set event handler, which will complete this action.
      this.accessory.getService(this.hap.Service.Lightbulb)?.getCharacteristic(this.hap.Characteristic.Brightness)?.setValue(volume);
      this.accessory.getService(this.hap.Service.Lightbulb)?.getCharacteristic(this.hap.Characteristic.On)?.setValue(volume > 0);
    });

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

  // Handle chime-related events.
  private eventHandler(packet: ProtectEventPacket): void {

    const payload = packet.payload as ProtectChimeConfigPayload;

    // It's a volume setting event - process it accordingly.
    if("volume" in payload) {

      // Update our volume setting.
      this.accessory.getService(this.hap.Service.Lightbulb)?.updateCharacteristic(this.hap.Characteristic.Brightness, payload.volume as number);
      this.accessory.getService(this.hap.Service.Lightbulb)?.updateCharacteristic(this.hap.Characteristic.On, (payload.volume as number) > 0);
      this.publish("chime", (payload.volume ?? 0).toString());
    }
  }
}
