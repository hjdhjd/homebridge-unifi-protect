/* Copyright(C) 2019-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * relay.ts: Relay device class for UniFi Protect.
 */
import type { ProtectAccessory, WithoutIdentity } from "../types.ts";
import type { ProtectRelayConfig, Relay } from "unifi-protect";
import type { CharacteristicValue } from "homebridge";
import { PROTECT_RELAY_COMMAND_TIMEOUT } from "../settings.ts";
import { ProtectDevice } from "./device.ts";
import type { ProtectNvr } from "../nvr/nvr.ts";
import { ProtectReservedNames } from "../types.ts";
import { deviceSelectors } from "unifi-protect";

export class ProtectRelay extends ProtectDevice {

  // Narrow the inherited projection handle to the relay projection so the read-through config getter resolves to ProtectRelayConfig.
  declare protected readonly device: Relay;

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

  // Read-through to the relay projection's live STATE, narrowed to drop device identity (id/mac/modelKey). Identity flows through the dedicated non-throwing accessors
  // (protectId/modelKey/.id/.mac), never this throwing config getter; this override mirrors the base getter's body and narrows only the surfaced return type.
  public override get ufp(): Readonly<WithoutIdentity<ProtectRelayConfig>> {

    return this.device.config;
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

    return "relay/" + (id + 1).toString();
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

  // Configure a HomeKit switch for each output the controller reports, iterating the live outputs array rather than hardcoding a fixed pair. Each output is keyed by its
  // wire id (0-based, the stable identity) into a per-output service subtype, is user-visible as 1-based ("Output 1"), and is individually show/hide-able through its own
  // feature option - hiding one output prunes exactly its switch and leaves the others intact. The visibility catalog enumerates each output the supported relay
  // hardware reports; an output beyond the catalog has no per-output option and resolves hidden by the feature-option default, so a larger relay would need its catalog
  // entries extended alongside this iteration.
  private configureOutputs(): void {

    for(const output of this.ufp.outputs) {

      const id = output.id;
      const label = output.name ?? ("Output " + (id + 1).toString());
      const subtype = this.outputSubtype(id);

      // Validate whether we should have this output's switch enabled, gating on the 1-based per-output feature option. This prunes exactly this output's subtyped switch
      // when hidden, leaving the sibling outputs and the accessory intact.
      if(!this.validService(this.hap.Service.Switch, this.hasFeature("Relay.Output." + (id + 1).toString()), subtype)) {

        continue;
      }

      // Acquire the service.
      const service = this.acquireService(this.hap.Service.Switch, this.accessoryName + " " + label, subtype);

      // Fail gracefully.
      if(!service) {

        this.log.error("Unable to add the relay output switch for %s.", label);

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
  // rather than the pre-toggle controller value, which lags until the broadcast lands. This is what makes a rapid second tap resolve correctly. The toggle is not
  // idempotent, so we must never re-issue toward a state we are already in or heading to.
  private async setOutput(id: number, label: string, desired: boolean): Promise<void> {

    // Compare against the pending intent if one is outstanding, else the live controller state (both non-throwing reads).
    const current = this.#pendingDesired.get(id) ?? this.outputState(id);

    // We are already in, or heading to, the desired state - re-issuing the non-idempotent toggle here would flip us the wrong way, so there is nothing to do.
    if(desired === current) {

      return;
    }

    // Record intent BEFORE dispatch and arm a bounded safety timer that drops the intent if the controller never confirms, so a lost broadcast cannot wedge the tap
    // decision. No optimistic tile write is needed: HAP already holds the requested value on the characteristic through this non-throwing onSet, and the observe loop
    // reconciles to controller truth on the confirming broadcast.
    this.#pendingDesired.set(id, desired);
    this.registerTimeout(this.pendingTimerKey(id), () => this.#pendingDesired.delete(id), PROTECT_RELAY_COMMAND_TIMEOUT);

    // Dispatch the toggle through the shared command-error helper, reporting any failure there.
    if(!(await this.runDeviceCommand("turn " + label + " " + (desired ? "on" : "off"), () => this.device.toggleOutput(id)))) {

      // The command failed and the output never changed, so no broadcast will arrive to reconcile the tile. Drop the intent and cancel its safety timer, then reflect the
      // true controller state back to the tile through a brief deferred bounce: a synchronous write here would be clobbered by HAP writing the requested value to the
      // characteristic once this non-throwing onSet resolves, so we reflect just past that settle. The ~50ms cosmetic bounce is deliberately left out of this.timers, as
      // the motion trigger's is; it need not survive cleanup().
      this.#pendingDesired.delete(id);
      this.clearTimer(this.pendingTimerKey(id));

      const service = this.accessory.getServiceById(this.hap.Service.Switch, this.outputSubtype(id));

      setTimeout(() => service?.updateCharacteristic(this.hap.Characteristic.On, this.outputState(id)), 50);

      return;
    }

    // Publish our state on success.
    this.publish(this.outputTopic(id), desired ? "true" : "false");
  }

  // Configure MQTT capabilities of this relay. Each output exposes a get (the live output state) and a set (which drives the output switch's On characteristic,
  // re-entering the single set-to-toggle path). We register for every output the hardware reports; a hidden output's set is a safe no-op (no switch to drive) while its
  // get still reports the live controller state.
  private configureMqtt(): void {

    for(const output of this.ufp.outputs) {

      const id = output.id;

      this.subscribeGet(this.outputTopic(id), "relay output", () => this.outputState(id).toString());

      this.subscribeSet(this.outputTopic(id), "relay output", (value: string) => {

        this.accessory.getServiceById(this.hap.Service.Switch, this.outputSubtype(id))?.setCharacteristic(this.hap.Characteristic.On, value === "true");
      });
    }
  }

  // Spawn the relay's narrow-selector observers. super spawns the universal observers (name sync and firmware/device-info refresh); the relay adds one observer per
  // output plus the status-indicator mirror.
  protected override spawnObservers(): void {

    super.spawnObservers();

    const relay = deviceSelectors.relay.byId(this.device.id);

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
          this.clearTimer(this.pendingTimerKey(id));
        }

        // Push controller truth to this output's tile.
        this.accessory.getServiceById(this.hap.Service.Switch, this.outputSubtype(id))?.updateCharacteristic(this.hap.Characteristic.On, actual);
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
