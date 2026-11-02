/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * device-base.ts: ProtectBase - the shared owner/lifetime/observe/MQTT/command spine for every Protect accessory class.
 *
 * The spine owns each owner's lifetime triple - its abort controller, the composed signal every observer, MQTT registration, and timer binds to, and the timer registry
 * that signal drains - so a device leaf, a controller-scoped accessory, and a capability composed onto a hosting device all inherit one lifecycle mechanism.
 */
import type { API, CharacteristicValue, HAP, Service } from "homebridge";
import type { CharacteristicTarget, HomebridgePluginLogging } from "homebridge-plugin-utils";
import type { ProtectDeviceConfig, ProtectNvrConfig, ProtectState } from "unifi-protect";
import { TimerRegistry, composeSignals, debugGatedLog, formatErrorMessage, loopFaultReporter, mqttTopic, notResponding, prefixedLog,
  superviseLoop } from "homebridge-plugin-utils";
import { PROTECT_HOMEKIT_REFLECT_DELAY } from "../settings.ts";
import type { ProtectAccessory } from "../types.ts";
import { ProtectAuthorizationError } from "unifi-protect";
import type { ProtectNvr } from "../nvr/nvr.ts";
import type { ProtectPlatform } from "../platform.ts";
import { describeDeviceModel } from "./device-descriptor.ts";

// An observed slice of controller state, expressed in the projections a single observer needs. `key` is a stable, dotted, machine-facing tag ("camera.ispSettings")
// that identifies the slice on the observer-wake diagnostics channel - it stays put across field renames so diagnostic filters keep working. `selector` reads the slice
// from a state snapshot. `title` is the plain-English capability the slice powers ("night vision"), interpolated into the user-facing fault report if the observer ever
// dies. The key and the title are deliberately separate facets rather than one string: the protocol field name and the product capability genuinely diverge - the
// `ispSettings` slice is what a user calls "night vision" - so neither can be derived from the other, and both are authored at the observe site, the one place that knows
// both the protocol slice and the product capability it serves.
interface ObservedSlice<T> {

  readonly key: string;
  readonly selector: (state: ProtectState) => T;
  readonly title: string;
}

export abstract class ProtectBase {

  // The wrapper a characteristic handler goes through: a read or a write HomeKit makes while this owner's isAvailable reads false is refused with the status HomeKit
  // shows as No Response, and the handler behind it never runs. The verdict is read on each call, so a recovery clears the refusal with nothing rewired. HomeKit marks a
  // whole accessory from one refusing characteristic, and a handler left unwrapped answers a value nobody can vouch for. An owner holding many accessories binds a
  // wrapper of its own for each one whose verdict reads more than this owner's, as the liveviews owner does for a switch, which also reads its liveview.
  protected readonly answering: ReturnType<typeof notResponding>;
  public readonly api: API;
  // This owner's own abort controller - the handle its cleanup() aborts. Aborting it unwinds exactly this owner's observe loops and MQTT registrations and drains its
  // timers, leaving every other owner untouched.
  protected readonly controller: AbortController;
  protected readonly hap: HAP;
  public readonly log: HomebridgePluginLogging;
  public readonly nvr: ProtectNvr;
  public readonly platform: ProtectPlatform;
  // This owner's lifetime signal, composed from its own controller and the lifetime it rides (see the constructor). Every observe loop, MQTT registration, and timer the
  // owner creates binds to it, so an abort at either level unwinds all of them.
  protected readonly signal: AbortSignal;
  // This owner's pacing timers, keyed by purpose. The registry arms on the platform's clock and is bound to the lifetime signal above, so teardown drains whatever is
  // armed and a registration attempted afterward is inert - a timer can never fire into a torn-down owner.
  protected readonly timers: TimerRegistry;

  /* Initialize the shared owner fields (api, hap, nvr, platform), build the device-prefixed log wrapper, and wire the owner-lifetime triple: this owner's own abort
   * controller, the composed signal every observer, MQTT registration, and timer it creates binds to, and the timer registry that signal drains.
   *
   * parentSignal names the lifetime this owner's controller composes against. A device or a controller-scoped accessory supplies none and composes against nvr.signal,
   * the controller connection itself; a capability composed onto a hosting device supplies that host's already-composed signal, so the capability sits one level below
   * its host and an abort at any level tears it down. An owner that never aborts its own controller - the controller-scoped accessories that live and die with the
   * connection - rides a signal that fires exactly when the lifetime it composed against fires, so the uniform triple costs it nothing behaviorally: one abort
   * controller, one composed signal, and one empty registry per owner is a deliberate and negligible price for giving every owner the same lifecycle machinery.
   *
   * That uniformity has a consequence for identity comparisons. composeSignals derives a fresh signal whenever more than one of its inputs is defined, which is always
   * the case here, so an owner's lifetime signal is behaviorally equivalent to the lifetime it composed against without ever being the same object as it.
   */
  constructor(nvr: ProtectNvr, parentSignal?: AbortSignal) {

    this.api = nvr.platform.api;
    this.hap = this.api.hap;
    this.nvr = nvr;
    this.platform = nvr.platform;

    /* Derive this device's logger from the plugin logging root, prefixing every line with this.logName: the plain name on the base, overridden by ProtectDevice to the
     * full "Name [Model]" descriptor so device lines show which hardware they belong to. The prefix supplier is read on every call, so a device rename reaches the
     * next line. logName is deliberately separate from the bare `name` getter, which is the stable functional identity (it keys the livestream request id and the
     * HomeKit accessory) and must not carry the bracketed model.
     *
     * The debug channel is the one level that does not pass through unchanged: it resolves at this owner's own scope through the platform's gate and emits through
     * warn, so whether a debug line speaks is decided here rather than plugin-wide. The gate sits outermost, so a suppressed line pays for one predicate call and no
     * prefix work at all.
     */
    this.log = debugGatedLog(prefixedLog(nvr.platform.pluginLog, () => this.logName), () => nvr.platform.testDebug(this.debugScope));

    this.answering = notResponding({ errorClass: this.hap.HapStatusError, unavailable: () => !this.isAvailable });
    this.controller = new AbortController();
    this.signal = composeSignals(this.controller.signal, parentSignal ?? nvr.signal);
    this.timers = new TimerRegistry({ clock: nvr.platform.clock, signal: this.signal });
  }

  // Stand this owner's HomeKit surface up: the attach-once moment, run through configured() by whatever built the owner, straight after construction. It is deliberately
  // NOT re-runnable, so it is the home for work that registers something exactly once - spawning observers, registering MQTT handlers, standing up a service that must
  // exist once. Keeping that work out of the constructor is what lets a setup that throws part way be released, since a constructor that throws leaves no instance whose
  // cleanup() could end what it started. An owner with no attach-once work leaves this default alone, and a capability whose whole body is convergence overrides
  // reconcile() instead.
  public configure(): void {

    // No-op by default; an owner with nothing to register once has nothing to stand up here.
  }

  // Tear this owner down. Aborting the owner controller unwinds every observe loop and MQTT registration bound to the composed signal and drains the timer registry, so
  // teardown releases exactly this owner's state and nothing another owner holds. An owner that also holds owned children or latched state of its own overrides this and
  // calls super.
  public cleanup(): void {

    this.controller.abort();
  }

  // Configure the device information for HomeKit.
  protected setInfo(accessory: ProtectAccessory, device: ProtectDeviceConfig | ProtectNvrConfig): boolean {

    const infoService = accessory.getService(this.hap.Service.AccessoryInformation);

    // Update the manufacturer information for this device.
    infoService?.updateCharacteristic(this.hap.Characteristic.Manufacturer, "Ubiquiti Inc.");

    // Update the model information for this device.
    infoService?.updateCharacteristic(this.hap.Characteristic.Model, describeDeviceModel(device));

    // Update the serial number for this device.
    if(device.mac.length) {

      infoService?.updateCharacteristic(this.hap.Characteristic.SerialNumber, device.mac);
    }

    // Update the hardware revision for this device, if available.
    if(device.hardwareRevision?.length) {

      infoService?.updateCharacteristic(this.hap.Characteristic.HardwareRevision, device.hardwareRevision);
    }

    // Update the firmware revision for this device.
    if(device.firmwareVersion?.length) {

      infoService?.updateCharacteristic(this.hap.Characteristic.FirmwareRevision, device.firmwareVersion);
    }

    return true;
  }

  // Utility function to return the fully enumerated name of this device. We default it to the controller but expect it to be overridden downstream. The controller
  // label is single-sourced from the unifi-protect library's selectControllerName (client.controllerName). controllerName is null only pre-bootstrap; the empty-string
  // fallback keeps log lines producing "" before bootstrap rather than "null".
  public get name(): string {

    return this.nvr.client.controllerName ?? "";
  }

  // The log-line prefix for this owner. The base returns the bare name because a controller-scoped owner (system information, liveviews) has no hardware model to
  // surface. ProtectDevice overrides this to append "[Model]", so each device line shows its hardware model. It is deliberately a separate accessor from `name`: as the
  // constructor's log setup notes, `name` is the stable functional identity (livestream request id, HomeKit accessory) and must never carry the bracketed model.
  protected get logName(): string {

    return this.name;
  }

  // The scope this owner's debug lines resolve at. The base carries the controller alone, because a controller-scoped owner (system information, liveviews, the security
  // system) has no device identity of its own to name. ProtectDevice overrides this to add the device, and ProtectDeviceCapability delegates to its host, the same
  // identity split mqttId makes. It is read on every debug call, so a line always resolves against the identity the owner holds at the moment it speaks.
  protected get debugScope(): { controller?: string; device?: string } {

    return { controller: this.nvr.ufp.mac };
  }

  // The lifetime signal that scopes this owner's state observers and its MQTT subscriptions, and the signal the MQTT subscribe wrappers below thread to
  // homebridge-plugin-utils. The default is the owner's own composed lifetime, so an owner whose controller is never aborted rides it for the whole controller
  // connection. It remains a protected variation point that an owner whose lifetime is scoped differently overrides.
  protected get observeSignal(): AbortSignal {

    return this.signal;
  }

  // Hook fired each time a state observer wakes, so a leaf can attribute the wake to a diagnostics subject. The base is a deliberate no-op: controller-scoped owners have
  // no single accessory identity to key a wake to, mirroring the NVR's own observe loops which likewise publish nothing here. ProtectDevice overrides this to publish the
  // accessory-scoped wake milestone. Another of the points the shared observeState varies by leaf.
  protected onObserverWake(_key: string): void {

    // No-op by default; the per-accessory wake milestone is published by ProtectDevice's override.
  }

  // Whether this owner's backing controller record is currently present. The base returns true unconditionally: a controller-scoped owner (system information, liveviews,
  // the security system) has no per-device record that can vanish - its backing controller record is present for the whole connection. ProtectDevice overrides this to
  // peek() !== undefined, and DoorbellCapability delegates to its camera, so the one observeState gate below neutralizes a vanished record on every owner. Another of the
  // protected variation points the shared observeState reads through, so an owner whose answer differs supplies its own.
  // eslint-disable-next-line @typescript-eslint/class-literal-property-style -- Overridden by getters in every leaf; the base cannot be a readonly field.
  protected get recordPresent(): boolean {

    return true;
  }

  // Whether the plugin can vouch for what this owner shows, the verdict No Response reads at every scope. A controller-scoped owner has no record of its own, so it
  // answers the controller's verdict, and the security system adds whether a liveview still calls for it; a liveview switch adds its own liveview through the wrapper it
  // binds, on top of this verdict. ProtectDevice adds the device's record to it, and a capability answers its host's.
  public get isAvailable(): boolean {

    return this.nvr.isAvailable;
  }

  // The single narrow-selector state-observe primitive, shared by every HomeKit-projection owner - device leaves and controller-scoped owners alike. The loop wakes only
  // when its reduced slice changes by reference (the store's Object.is dedup is upstream of the yield), the handler re-reads through the owner's live projection rather
  // than trusting the yielded value so a multi-read reaction always sees a coherent snapshot, and what an owner supplies for itself it supplies through the protected
  // variation points this body reads. The slice descriptor's names route to separate consumers: its key tags the wake on the diagnostics channel, its title
  // names the capability in the user-facing fault report. The detached-loop resilience envelope (swallow on abort, surface a fault once) is delegated to
  // homebridge-plugin-utils' superviseLoop and the fault report to its loopFaultReporter; both single-sourced. What remains here is just the observe-specific body
  // superviseLoop supervises.
  protected observeState<T>(slice: ObservedSlice<T>, handler: (value: T) => void): void {

    const { key, selector, title } = slice;
    const signal = this.observeSignal;

    void superviseLoop({

      loop: async () => {

        for await (const value of this.nvr.client.state.observe(selector, { signal })) {

          // A value can still drain from the store's queue after teardown aborted our signal (the iterator empties its queue before it closes). Reacting then would run
          // a handler against a record the membership loop is removing, so we drop the trailing yield and let the loop end.
          if(signal.aborted) {

            break;
          }

          // The owner's controller record can vanish while its observe loops stay subscribed: a device unadopted at the controller lingers for the DelayDeviceRemoval
          // grace, during which a wake on the removal dispatch (its slices going undefined) would re-read a vanished record and throw. We skip this wake and stay
          // subscribed - a re-adoption within the grace resumes the handler with no respawn. CONTINUE, not break: the loop's lifetime is the owner signal, not the
          // record's presence. The gate and the handler's synchronous prefix run in one microtask, so the presence read cannot go stale before the handler acts.
          if(!this.recordPresent) {

            continue;
          }

          this.onObserverWake(key);

          handler(value);
        }
      },
      onError: loopFaultReporter(this.log, title),
      signal
    });
  }

  // The MQTT topic-scope identifier for this owner - the leading path segment under homebridge-plugin-utils' configured topic prefix, yielding the wire topic
  // {topicPrefix}/{mqttId}/{topic}. Controller-scoped owners (system information, liveviews, the security system) scope under the controller's MAC; ProtectDevice
  // overrides this to its own device MAC. It is the single point the MQTT wrappers vary by, so the device-scoped-topic convention is defined in exactly one place.
  protected get mqttId(): string {

    return this.nvr.ufp.mac;
  }

  // Publish an MQTT event under this owner's scope: compose the owner's mqttId into the topic tail (homebridge-plugin-utils' MqttClient then prefixes the configured
  // topic) and hand delivery to the client's guarded path, which is fire-and-forget by design and reports a failed publish on its own logger.
  protected publish(topic: string, message: string): void {

    this.nvr.mqtt?.publishGuarded(mqttTopic(this.mqttId, topic), message);
  }

  // Publish a value this owner holds under its scope, sent only when it differs from the last value that topic delivered in this broker session. The client's change
  // gate remembers what each topic last carried and forgets it when a session starts, so an unchanged reading costs no broker traffic while a fresh session is told
  // the value again. Events and confirmations stay on publish, because a repeat of one of those is a new occurrence rather than the same state stated twice.
  protected publishState(topic: string, value: string): void {

    this.nvr.mqtt?.publishGuarded(mqttTopic(this.mqttId, topic), value, { ifChanged: true });
  }

  // Configure an MQTT get subscription under this owner's scope. The registration is bound to the owner-lifetime signal, so an owner's teardown (cleanup, removal,
  // reclassification) releases exactly this owner's handler - required on shared topics, where the package camera and its parent doorbell each hold handlers on
  // the same parent-MAC tuple and a tuple-wide unsubscribe would clobber the survivor's. The signal governs registration lifetime only; an in-flight handler runs to
  // completion under homebridge-plugin-utils' client-level signal, by design.
  protected subscribeGet(topic: string, type: string, getValue: () => string): void {

    this.nvr.mqtt?.subscribeGet(mqttTopic(this.mqttId, topic), type, getValue, { signal: this.observeSignal });
  }

  // Configure an MQTT set subscription under this owner's scope, bound to the owner-lifetime signal exactly as subscribeGet is.
  protected subscribeSet(topic: string, type: string, setValue: (value: string, rawValue: string) => Promise<void> | void): void {

    this.nvr.mqtt?.subscribeSet(mqttTopic(this.mqttId, topic), type, setValue, { signal: this.observeSignal });
  }

  /* Register this owner's restatement of its held state, run at the start of every broker session that begins after the owner is built. The client forgets what
   * each topic last delivered when a session starts, so held state is stated again then, and an owner restates by calling the code that already publishes it, so
   * the restated set is the published set. Registering runs nothing: the session an owner is built into is covered by what the owner states as it is
   * built. It is bound to the owner-lifetime signal, so an owner's teardown releases exactly its own registration, and a run is skipped while the record is absent,
   * because a device lingering in its removal grace has no record to restate. With no broker configured there is nothing to register.
   */
  protected restateOnConnect(restate: () => void): void {

    this.nvr.mqtt?.onConnect(() => {

      if(!this.recordPresent) {

        return;
      }

      restate();
    }, { signal: this.observeSignal });
  }

  // Remove an MQTT subscription under this owner's scope. The homebridge-plugin-utils unsubscribe takes the id and the topic tail as separate arguments (it reconstructs
  // {topicPrefix}/{id}/{topic} internally and does not append /get or /set), so the caller passes the full tail - the child it composed through mqttGetTopic or
  // mqttSetTopic - and we supply the mqttId.
  protected unsubscribe(topic: string): void {

    this.nvr.mqtt?.unsubscribe(this.mqttId, topic);
  }

  // Run a user-initiated device command and report whether it succeeded. Device commands are write-through: they PATCH the controller and throw the classified
  // FatalError on failure (rather than returning null), so this is the single place that converts a thrown command error into the boolean a HomeKit onSet handler
  // branches on, and the single place a user-initiated command failure is reported - autoconfiguration writes narrate their own outcomes at their call sites, the one
  // place the consequence and the remedy are known. The command is supplied as a thunk by the caller, where this.device is narrowed to the concrete projection, so the
  // update typechecks against its own config; a helper that called this.device.update() itself would face the contravariance of the base's full device-projection union.
  // An authorization failure is the one actionable case for the user - the account lacks the full management role - so it earns specific guidance; any other failure is
  // reported with its underlying cause. The action is a verb phrase ("turn the light on") interpolated into the message. This lives on ProtectBase, the lowest common
  // ancestor of every command-issuer (every ProtectDevice subclass plus the DoorbellCapability), so the one copy serves them all; the controller-scoped ProtectBase-only
  // owners (the security system, the system-info owner, and liveviews) issue no Protect write commands and inherit it unused - a deliberate, accepted consequence of
  // placing it at the common ancestor.
  protected async runDeviceCommand(action: string, command: () => Promise<unknown>): Promise<boolean> {

    try {

      await command();

      return true;
    } catch(error) {

      if(error instanceof ProtectAuthorizationError) {

        this.log.error("Unable to %s. Please ensure this username has the full management role in UniFi Protect.", action);

        return false;
      }

      // Report the failure with its underlying cause. The format string supplies the terminal period, and formatErrorMessage strips the trailing period a classified
      // error's own full-sentence message carries, so the line reads as one clean sentence rather than ending in a doubled period.
      this.log.error("Unable to %s: %s.", action, formatErrorMessage(error));

      return false;
    }
  }

  /* Bind a refusing read handler that answers the value a characteristic holds, for a characteristic the plugin only ever writes. HomeKit reads one with no handler
   * without asking anyone, so it would answer a stale value through an outage. The read hands back what is already held, so it changes nothing while this owner is
   * available, and binding again on a later pass replaces the handler rather than stacking a second one.
   */
  protected answerHeld(service: Service, characteristic: CharacteristicTarget): void {

    const held = service.getCharacteristic(characteristic);

    held.onGet(this.answering(() => held.value));
  }

  /* Run a set handler's body on the plugin's own behalf and state the value it set, the path an MQTT set and the plugin's own writes take past the refusal a HomeKit
   * write meets. A characteristic's own set entry point would run the wrapped handler and drop its refusal, so a command would silently go nowhere through an outage;
   * calling the body directly reaches the device and lets the command fail the way it fails with the controller away, through the same failure log. The value is stated
   * only once the body resolves, the moment a HomeKit write takes effect, so a reflection the body arms still lands after it. The caller resolves the service ahead of
   * the call, and a service that is gone runs nothing.
   *
   * A caller never waits on this: the body begins in the caller's turn and finishes on its own. So a body that rejects or throws has no one to report to, which is why
   * the fault is said here and stays here, states nothing, and costs the caller's own loop nothing.
   *
   * @param options                - The set to run.
   * @param options.characteristic - The characteristic the body sets.
   * @param options.service        - The service carrying the characteristic, as the caller resolved it.
   * @param options.set            - The set handler's body.
   * @param options.value          - The value to set.
   */
  protected async driveSet({ characteristic, service, set, value }: { characteristic: CharacteristicTarget; service: Service | undefined;
    set: (value: CharacteristicValue) => unknown; value: CharacteristicValue; }): Promise<void> {

    if(!service) {

      return;
    }

    try {

      await set(value);
    } catch(error) {

      this.log.error("Unable to complete the request to update %s: %s.", service.displayName, formatErrorMessage(error));

      return;
    }

    service.updateCharacteristic(characteristic, value);
  }

  /* Reflect a characteristic's true state back to HomeKit once the set handler that changed it has returned. HAP writes the requested value onto the characteristic
   * when the handler resolves, so a write made inside the handler - a momentary trigger snapping back, a failed command reverting, a level the controller quantizes -
   * would be overwritten by it. We arm the write on the platform's clock just past that point instead.
   *
   * The reflect stays outside the keyed registry, so teardown leaves a pending one to fire: it is a single write at most one delay after the owner's last set handler,
   * and it re-asserts state rather than starting anything that would need to be stopped.
   */
  protected reflectAfterSet(reflect: () => void): void {

    this.platform.clock.schedule(reflect, PROTECT_HOMEKIT_REFLECT_DELAY);
  }
}

/* Configure a freshly built owner and hand it back, the one way every builder takes an owner into service. A setup that throws part way has already started observers,
 * MQTT handlers, timers or a camera controller bound to the owner's lifetime, and the builder never receives the instance to end them, so the owner is released through
 * its own cleanup() before the error leaves here unchanged. That release is what keeps a later attempt on the same accessory from standing a second live owner beside
 * the one that failed.
 */
export function configured<T extends ProtectBase>(owner: T): T {

  try {

    owner.configure();
  } catch(error) {

    owner.cleanup();

    throw error;
  }

  return owner;
}
