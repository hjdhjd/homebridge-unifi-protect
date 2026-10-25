/* Copyright(C) 2019-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * relay.ts: Relay device class for UniFi Protect.
 */
import type { CharacteristicValue } from "homebridge";
import { PROTECT_RELAY_COMMAND_TIMEOUT } from "../settings.ts";
import type { ProtectAccessory } from "../types.ts";
import { ProtectDevice } from "./device.ts";
import type { ProtectNvr } from "../nvr/nvr.ts";
import { ProtectReservedNames } from "../types.ts";
import type { Relay } from "unifi-protect";
import { mqttTopics } from "../mqtt.ts";
import { resolveMqttTopic } from "homebridge-plugin-utils";

export class ProtectRelay extends ProtectDevice<Relay> {

  // The output id we most recently commanded, mapped to the state we are driving it toward. It exists to make the set-to-toggle decision latency-aware: a rapid second
  // tap compares against where the output is headed, not the pre-toggle controller value that lags until the broadcast lands. Cleared when the controller confirms the
  // intent (or a bounded safety timer fires), so a lost broadcast can never wedge the switch. This is transient runtime state, deliberately NOT persisted to
  // accessory.context.
  readonly #pendingDesired = new Map<number, boolean>();

  // Create an instance.
  constructor(nvr: ProtectNvr, accessory: ProtectAccessory, device: Relay) {

    super(nvr, accessory, device);

    this.configureHints();
    this.configureDevice();
    this.spawnObservers();
  }

  // The current on/off state of one relay output, read non-throwing through the record. An absent record (a relay lingering in the removal grace) reports off rather than
  // throwing, and an unknown output id likewise reports off.
  private outputState(id: number): boolean {

    return this.fromRecord((config) => config.outputs.find((output) => output.id === id)?.state === "on", false);
  }

  // The stable timer key for one output's pending-intent safety timer, single-sourced so the arm, the confirm-cancel, and the failure-cancel all name the same timer.
  private pendingTimerKey(id: number): string {

    return "relay.output." + id.toString() + ".pending";
  }

  // The stable HomeKit service subtype for one output's switch, keyed by the 0-based wire id. Single-sourced so the create site and every getServiceById lookup (the
  // observer push, the failure bounce, the MQTT set) name the identical service; a create/lookup divergence would make getServiceById silently return undefined.
  private outputSubtype(id: number): string {

    return ProtectReservedNames.SWITCH_RELAY_OUTPUT + "." + id.toString();
  }

  // The stable MQTT topic tail for one output, user-facing as 1-based. Single-sourced so the publish and the get/set subscriptions all address the identical topic.
  private outputTopic(id: number): string {

    return resolveMqttTopic(mqttTopics.relayOutput.topic, { output: (id + 1).toString() });
  }

  // Initialize and configure the relay accessory for HomeKit.
  private configureDevice(): boolean {

    // Reset the persisted context to a clean slate and reseed identity. This accessory may be the object Homebridge restored from its persisted accessory cache, which
    // can still carry context keys left behind by an earlier plugin version or a different accessory type sharing this device's cached identity; the relay persists no
    // user state, so nothing is preserved across the reset.
    this.resetAccessoryContext();

    // Configure accessory information.
    this.configureInfo();

    // Configure a switch for each of the relay's outputs.
    this.configureOutputs();

    // Configure the status indicator light switch.
    this.configureStatusLedSwitch();

    // Configure MQTT services.
    this.configureMqtt();

    return true;
  }

  /* Configure a HomeKit switch for each output the controller reports, iterating the live outputs array rather than hardcoding a fixed pair. Each output is keyed by its
   * wire id (0-based, the stable identity) into a per-output service subtype and is user-visible as 1-based ("Output 1").
   *
   * Which outputs appear is a single selection over the relay's OWN reported outputs: the domain the user picks from is derived from the hardware in front of them, so
   * a relay of any size offers every output it reports and defaults to showing all of them. Leaving one out prunes exactly its switch and leaves the others intact.
   */
  private configureOutputs(): void {

    // The outputs the user selected, resolved once for the whole pass against this relay's live output list, addressed by the 1-based numbers the user sees.
    const visible = new Set(this.getFeatureList("Relay.Outputs", this.ufp.outputs.map((output) => (output.id + 1).toString())));

    for(const output of this.ufp.outputs) {

      const id = output.id;
      const label = output.name ?? ("Output " + (id + 1).toString());
      const subtype = this.outputSubtype(id);

      // Validate whether we should have this output's switch enabled, gating on the selection resolved above. This prunes exactly this output's subtyped switch when it
      // is left out, leaving the sibling outputs and the accessory intact.
      const { service } = this.validService({ name: this.accessoryName + " " + label, serviceType: this.hap.Service.Switch, subtype,
        validate: visible.has((id + 1).toString()) });

      if(!service) {

        continue;
      }

      // Read the live controller output state when requested (controller is authority; the observe loop keeps the tile current between reads).
      service.getCharacteristic(this.hap.Characteristic.On).onGet(() => this.outputState(id));

      // Drive the output toward the requested state through the set-to-toggle guard.
      service.getCharacteristic(this.hap.Characteristic.On).onSet(async (value: CharacteristicValue) => {

        await this.setOutput(id, label, value === true);
      });

      // Initialize the switch from controller truth.
      service.updateCharacteristic(this.hap.Characteristic.On, this.outputState(id));
    }
  }

  // Drive one relay output toward a desired on/off state, reconciling HomeKit's set-state semantics against the controller's faithful toggle primitive. The controller
  // offers only toggleOutput - a flip that is write-through - so we record the state we are driving the output toward in #pendingDesired and decide against that intent
  // rather than the pre-toggle controller value, which lags until the broadcast lands. This is what makes a rapid second tap resolve correctly. Calling
  // toggleOutput twice flips the output back to where it started, so we must never re-issue toward a state we are already in or heading to.
  private async setOutput(id: number, label: string, desired: boolean): Promise<void> {

    // Compare against the pending intent if one is outstanding, else the live controller state (both non-throwing reads).
    const current = this.#pendingDesired.get(id) ?? this.outputState(id);

    // We are already in, or heading to, the desired state - re-issuing the toggle here would flip the output the wrong way, since a second call reverses it,
    // so there is nothing to do.
    if(desired === current) {

      return;
    }

    // Record intent BEFORE dispatch and arm a bounded safety timer that drops the intent if the controller never confirms, so a lost broadcast cannot wedge the tap
    // decision. No optimistic tile write is needed: HAP already holds the requested value on the characteristic through this non-throwing onSet, and the observe loop
    // reconciles to controller truth on the confirming broadcast.
    this.#pendingDesired.set(id, desired);
    this.timers.setTimeout(this.pendingTimerKey(id), () => this.#pendingDesired.delete(id), PROTECT_RELAY_COMMAND_TIMEOUT);

    // Dispatch the toggle through the shared command-error helper, reporting any failure there.
    if(!(await this.runDeviceCommand("turn " + label + " " + (desired ? "on" : "off"), () => this.device.toggleOutput(id)))) {

      // The command failed and the output never changed, so no broadcast will arrive to reconcile the tile. Drop the intent and cancel its safety timer, then reflect the
      // true controller state back to the tile.
      this.#pendingDesired.delete(id);
      this.timers.clear(this.pendingTimerKey(id));

      const service = this.accessory.getServiceById(this.hap.Service.Switch, this.outputSubtype(id));

      this.reflectAfterSet(() => service?.updateCharacteristic(this.hap.Characteristic.On, this.outputState(id)));

      return;
    }
  }

  // Publish one output's on state, the value its MQTT get answers, when it changed. The controller's reported change is the one publisher of this topic, so a toggle
  // made here, in the Protect app, or by a momentary output's self-revert each publishes once, from the observer. An output the user left out of Relay.Outputs has no
  // switch, and with it no MQTT topic, so it publishes nothing.
  private publishOutputState(id: number): void {

    if(!this.hasOutputSwitch(id)) {

      return;
    }

    this.publishState(this.outputTopic(id), this.outputState(id).toString());
  }

  // Whether an output's Switch stands, the condition Relay.Outputs creates it under. An output's MQTT topic is part of the same capability, so its get, its set and its
  // publishes all follow this one answer.
  private hasOutputSwitch(id: number): boolean {

    return this.accessory.getServiceById(this.hap.Service.Switch, this.outputSubtype(id)) !== undefined;
  }

  // Configure MQTT capabilities of this relay. Each output whose Switch stands exposes a get (the live output state) and a set (which drives the output switch's On
  // characteristic, re-entering the single set-to-toggle path). An output the user left out of Relay.Outputs has no switch and no MQTT topic, so it registers neither.
  private configureMqtt(): void {

    for(const output of this.ufp.outputs) {

      const id = output.id;

      if(!this.hasOutputSwitch(id)) {

        continue;
      }

      this.subscribeGet(this.outputTopic(id), mqttTopics.relayOutput.label, () => this.outputState(id).toString());

      this.subscribeSet(this.outputTopic(id), mqttTopics.relayOutput.label, (value: string) => {

        this.accessory.getServiceById(this.hap.Service.Switch, this.outputSubtype(id))?.setCharacteristic(this.hap.Characteristic.On, value === "true");
      });
    }

    // State each output's held state as the relay is built, since its construction publishes nothing else, and again at the start of every later broker session,
    // through the method its observers publish with.
    const restate = (): void => {

      for(const output of this.ufp.outputs) {

        this.publishOutputState(output.id);
      }
    };

    restate();
    this.restateOnConnect(restate);
  }

  // Spawn the relay's narrow-selector observers. super spawns the universal observers (name sync and firmware/device-info refresh); the relay adds one observer per
  // output plus the status-indicator mirror.
  protected override spawnObservers(): void {

    super.spawnObservers();

    const relay = this.nvr.client.state.selectors.relay.byId(this.device.id);

    // One observer per output, each selecting that output's own state. Because the store yields only on an Object.is change of the selected value, an observer wakes ONLY
    // when its own output's state changes: a sibling output's change (or any unrelated device patch) leaves this output's state primitive untouched and never wakes it.
    // The controller is the authority, and we push its truth to this output's tile with no window in which we could see a stale value or override this output's own in-
    // flight tap. When the controller confirms a pending intent we drop that intent and cancel its safety timer. A momentary output (one with a configured pulseDuration)
    // self-reverts on the controller, and mirroring that back to the switch (on, then off) is correct behavior - we deliberately do not fight it.
    for(const output of this.ufp.outputs) {

      const id = output.id;

      this.observeState({ key: "relay.output." + id.toString(), selector: state => relay(state)?.outputs.find(entry => entry.id === id)?.state,
        title: "relay output " + (id + 1).toString() }, () => {

        const actual = this.outputState(id);

        // The controller confirmed our intent for this output: drop the pending entry and cancel its safety timer.
        if(this.#pendingDesired.get(id) === actual) {

          this.#pendingDesired.delete(id);
          this.timers.clear(this.pendingTimerKey(id));
        }

        // Push controller truth to this output's tile, and on to MQTT.
        this.accessory.getServiceById(this.hap.Service.Switch, this.outputSubtype(id))?.updateCharacteristic(this.hap.Characteristic.On, actual);
        this.publishOutputState(id);
      });
    }

    // The relay's indicator setting drives the status-indicator switch, when that switch is configured.
    this.observeState({ key: "relay.ledSettings", selector: state => relay(state)?.ledSettings.isEnabled, title: "the status light" }, () => {

      this.accessory.getServiceById(this.hap.Service.Switch, ProtectReservedNames.SWITCH_STATUS_LED)?.updateCharacteristic(this.hap.Characteristic.On, this.statusLed);
    });
  }

  // Tear down this relay's runtime state alongside the base teardown. The base cleanup aborts the observe loops and clears every registered timer (including the pending-
  // intent safety timers), but the #pendingDesired intent map is a separate structure it does not own, so we clear it here. It latches on this persistent object, so it
  // must not survive a device removal, which is the path that invokes this override. A controller reboot does NOT tear the device down (the observe loops ride the
  // surviving connection), so the bounded safety timer - not cleanup - is what self-heals a stale intent across a reboot, dropping any unconfirmed intent within its
  // window so a post-reboot output reset can never be shadowed by a lingering lie.
  public override cleanup(): void {

    super.cleanup();

    this.#pendingDesired.clear();
  }
}
