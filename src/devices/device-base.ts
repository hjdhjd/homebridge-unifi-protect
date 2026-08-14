/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * device-base.ts: ProtectBase - the shared owner/lifetime/observe/MQTT/command spine for every Protect accessory class.
 *
 * The spine owns each owner's lifetime triple - its abort controller, the composed signal every observer, MQTT registration, and timer binds to, and the timer registry
 * that signal drains - so a device leaf, a controller-scoped accessory, and a capability composed onto a hosting device all inherit one lifecycle mechanism.
 */
import type { API, HAP } from "homebridge";
import type { ProtectDeviceConfig, ProtectNvrConfig, ProtectState } from "unifi-protect";
import { TimerRegistry, composeSignals, formatErrorMessage, loopFaultReporter, prefixedLog, superviseLoop } from "homebridge-plugin-utils";
import { guardedPublish, mqttTopic } from "../mqtt.ts";
import type { HomebridgePluginLogging } from "homebridge-plugin-utils";
import type { ProtectAccessory } from "../types.ts";
import { ProtectAuthorizationError } from "unifi-protect";
import type { ProtectNvr } from "../nvr/nvr.ts";
import type { ProtectPlatform } from "../platform.ts";

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
  // This owner's pacing timers, keyed by purpose. The registry is bound to the lifetime signal above, so teardown drains whatever is armed and a registration attempted
  // afterward is inert - a timer can never fire into a torn-down owner.
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

    // Derive this device's logger from the plugin logging root, prefixing every line with this.logName: the plain name on the base, overridden by ProtectDevice to the
    // full "Name [Model]" descriptor so device lines show which hardware they belong to. The prefix supplier is read on every call, so a device rename reaches the next
    // line. logName is deliberately separate from the bare `name` getter, which is the stable functional identity (it keys the livestream request id and the HomeKit
    // accessory) and must not carry the bracketed model. The debug channel is the one level that does not pass through unchanged: it carries this owner's own identity
    // to the platform's debug router, so whether a debug line speaks is decided at this owner's scope rather than plugin-wide.
    const debug = (message: string, ...parameters: unknown[]): void => nvr.platform.debugAt(this.debugScope, message, ...parameters);

    this.log = prefixedLog({ ...nvr.platform.pluginLog, debug }, () => this.logName);

    this.controller = new AbortController();
    this.signal = composeSignals(this.controller.signal, parentSignal ?? nvr.signal);
    this.timers = new TimerRegistry({ signal: this.signal });
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
    // marketName is optional at runtime despite its declared type, so the nullish fallback to device.type is real, not redundant.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    const deviceModel = device.marketName ?? device.type;

    if(deviceModel.length) {

      infoService?.updateCharacteristic(this.hap.Characteristic.Model, deviceModel);
    }

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
  // constructor's log seam notes, `name` is the stable functional identity (livestream request id, HomeKit accessory) and must never carry the bracketed model.
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
  // accessory-scoped wake milestone. Another of the seams the shared observeState varies by leaf.
  protected onObserverWake(_key: string): void {

    // No-op by default; the per-accessory wake milestone is published by ProtectDevice's override.
  }

  // Whether this owner's backing controller record is currently present. The base returns true unconditionally: a controller-scoped owner (system information, liveviews,
  // the security system) has no per-device record that can vanish - its backing controller record is present for the whole connection. ProtectDevice overrides this to
  // peek() !== undefined, and DoorbellCapability delegates to its camera, so the one observeState gate below neutralizes a vanished record on every owner. Another of the
  // protected variation points the shared observeState reads through, so an owner whose answer differs supplies its own.
  // eslint-disable-next-line @typescript-eslint/class-literal-property-style -- Polymorphic seam overridden by getters; the base cannot be a readonly field.
  protected get recordPresent(): boolean {

    return true;
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
  // overrides this to its own device MAC. It is the single seam the MQTT wrappers vary by, so the device-scoped-topic convention is defined in exactly one place.
  protected get mqttId(): string {

    return this.nvr.ufp.mac;
  }

  // Publish an MQTT event under this owner's scope: compose the owner's mqttId into the topic tail (homebridge-plugin-utils' MqttClient then prefixes the configured
  // topic) and route through the shared guardedPublish, so a rejected publish is logged under its own label rather than floating as an unhandled rejection.
  protected publish(topic: string, message: string): void {

    guardedPublish(this.log, this.nvr.mqtt, mqttTopic(this.mqttId, topic), message);
  }

  // Configure an MQTT get subscription under this owner's scope. The registration is bound to the owner-lifetime signal, so an owner's teardown (cleanup, removal,
  // reclassification) releases exactly this owner's handler - load-bearing on shared topics, where the package camera and its parent doorbell each hold handlers on
  // the same parent-MAC tuple and a tuple-wide unsubscribe would clobber the survivor's. The signal governs registration lifetime only; an in-flight handler runs to
  // completion under homebridge-plugin-utils' client-level signal, by design.
  protected subscribeGet(topic: string, type: string, getValue: () => string): void {

    this.nvr.mqtt?.subscribeGet(mqttTopic(this.mqttId, topic), type, getValue, { signal: this.observeSignal });
  }

  // Configure an MQTT set subscription under this owner's scope, bound to the owner-lifetime signal exactly as subscribeGet is.
  protected subscribeSet(topic: string, type: string, setValue: (value: string, rawValue: string) => Promise<void> | void): void {

    this.nvr.mqtt?.subscribeSet(mqttTopic(this.mqttId, topic), type, setValue, { signal: this.observeSignal });
  }

  // Remove an MQTT subscription under this owner's scope. The homebridge-plugin-utils unsubscribe takes the id and the topic tail as separate arguments (it reconstructs
  // {topicPrefix}/{id}/{topic} internally and does not append /get or /set), so the caller passes the full tail - for example "motion/get" - and we supply the mqttId.
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
}
