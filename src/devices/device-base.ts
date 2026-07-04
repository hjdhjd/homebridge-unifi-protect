/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * device-base.ts: ProtectBase - the shared owner/observe/MQTT/command spine for every Protect accessory class.
 */
import type { API, HAP } from "homebridge";
import type { ProtectAccessory, ProtectDeviceConfigTypes } from "../types.ts";
import type { ProtectNvrConfig, ProtectState } from "unifi-protect";
import { loopFaultReporter, superviseLoop } from "homebridge-plugin-utils";
import type { HomebridgePluginLogging } from "homebridge-plugin-utils";
import { ProtectAuthorizationError } from "unifi-protect";
import type { ProtectNvr } from "../nvr/nvr.ts";
import type { ProtectPlatform } from "../platform.ts";
import { mqttTopic } from "../mqtt.ts";
import util from "node:util";

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
  protected readonly hap: HAP;
  public readonly log: HomebridgePluginLogging;
  public readonly nvr: ProtectNvr;
  public readonly platform: ProtectPlatform;

  // Initialize the shared owner fields (api, hap, nvr, platform) and build the device-prefixed log wrapper.
  constructor(nvr: ProtectNvr) {

    this.api = nvr.platform.api;
    this.hap = this.api.hap;
    this.nvr = nvr;
    this.platform = nvr.platform;

    // Every log line is prefixed with this.logName: the plain name on the base, overridden by ProtectDevice to the full "Name [Model]" descriptor so device lines show
    // which hardware they belong to. logName is deliberately separate from the bare `name` getter, which is the stable functional identity
    // (it keys the livestream request id and the HomeKit accessory) and must not carry the bracketed model.
    this.log = {

      debug: (message: string, ...parameters: unknown[]): void => { nvr.platform.debug(util.format(this.logName + ": " + message, ...parameters)); },
      error: (message: string, ...parameters: unknown[]): void => { nvr.platform.log.error(util.format(this.logName + ": " + message, ...parameters)); },
      info: (message: string, ...parameters: unknown[]): void => { nvr.platform.log.info(util.format(this.logName + ": " + message, ...parameters)); },
      warn: (message: string, ...parameters: unknown[]): void => { nvr.platform.log.warn(util.format(this.logName + ": " + message, ...parameters)); }
    };
  }

  // Configure the device information for HomeKit.
  protected setInfo(accessory: ProtectAccessory, device: ProtectDeviceConfigTypes | ProtectNvrConfig): boolean {

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

  // The owner-lifetime signal that scopes this owner's state observers AND its MQTT subscriptions. The base binds to the controller's terminal shutdown signal, which
  // is the correct lifetime for the controller-scoped owners (system information, liveviews) whose existence spans the whole controller connection. ProtectDevice
  // overrides this with its per-accessory composed signal, so a single accessory's teardown unwinds only its own observers and releases exactly its own MQTT handlers.
  // This is one of the seams the shared observeState varies by leaf, and the signal the MQTT subscribe wrappers below thread to homebridge-plugin-utils.
  protected get observeSignal(): AbortSignal {

    return this.nvr.signal;
  }

  // Hook fired each time a state observer wakes, so a leaf can attribute the wake to a diagnostics subject. The base is a deliberate no-op: controller-scoped owners have
  // no single accessory identity to key a wake to, mirroring the NVR's own observe loops which likewise publish nothing here. ProtectDevice overrides this to publish the
  // accessory-scoped wake milestone. Another of the seams the shared observeState varies by leaf.
  protected onObserverWake(_key: string): void {

    // No-op by default; the per-accessory wake milestone is published by ProtectDevice's override.
  }

  // Whether this owner's backing controller record is currently present. The base returns true unconditionally: a controller-scoped owner (system information, liveviews,
  // the security system) has no per-device record that can vanish - its backing controller record is present for the whole connection. ProtectDevice overrides this to
  // peek() !== undefined, and DoorbellCapability delegates to its camera, so the one observeState gate below neutralizes a vanished record on every owner. Another of
  // the seams the shared observeState varies by leaf, alongside observeSignal and onObserverWake.
  // eslint-disable-next-line @typescript-eslint/class-literal-property-style -- Polymorphic seam overridden by getters; the base cannot be a readonly field.
  protected get recordPresent(): boolean {

    return true;
  }

  // The single narrow-selector state-observe primitive, shared by every HomeKit-projection owner - device leaves and controller-scoped owners alike. The loop wakes only
  // when its reduced slice changes by reference (the store's Object.is dedup is upstream of the yield), the handler re-reads through the owner's live projection rather
  // than trusting the yielded value so a multi-read reaction always sees a coherent snapshot, and the seams leaves vary are the lifetime signal (observeSignal) and
  // the wake attribution (onObserverWake). The slice descriptor's names route to separate consumers: its key tags the wake on the diagnostics channel, its title
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

  // Publish an MQTT event under this owner's scope. The wrappers compose the owner's mqttId into the topic tail that homebridge-plugin-utils' MqttClient then prefixes
  // with the configured topic. publish is async under homebridge-plugin-utils and these wrappers are fire-and-forget, so we void the returned promise.
  protected publish(topic: string, message: string): void {

    void this.nvr.mqtt?.publish(mqttTopic(this.mqttId, topic), message);
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

  // Run a device command and report whether it succeeded. Device commands are write-through: they PATCH the controller and throw the classified FatalError on failure
  // (rather than returning null), so this is the single place that converts a thrown command error into the boolean a HomeKit onSet handler branches on, and the single
  // place a command failure is reported. The command is supplied as a thunk by the caller, where this.device is narrowed to the concrete projection, so the update
  // typechecks against its own config; a helper that called this.device.update() itself would face the contravariance of the base's Camera | Light | Sensor | Chime |
  // Viewer union. An authorization failure is the one actionable case for the user - the account lacks the Administrator role - so it earns specific guidance; any other
  // failure is reported with its underlying cause. The action is a verb phrase ("turn the light on") interpolated into the message. This lives on ProtectBase, the lowest
  // common ancestor of every command-issuer (every ProtectDevice subclass plus the DoorbellCapability), so the one copy serves them all; the controller-scoped
  // ProtectBase-only owners (the security system, the system-info owner, and liveviews) issue no Protect write commands and inherit it unused - a deliberate, accepted
  // consequence of placing it at the common ancestor.
  protected async runDeviceCommand(action: string, command: () => Promise<unknown>): Promise<boolean> {

    try {

      await command();

      return true;
    } catch(error) {

      if(error instanceof ProtectAuthorizationError) {

        this.log.error("Unable to %s. Please ensure this username has the Administrator role in UniFi Protect.", action);

        return false;
      }

      // Report the failure with its underlying cause. The format string already supplies the terminal period, so we strip any trailing periods the error's own message
      // carries (a classified error is a full sentence ending in a period) so the line reads as one clean sentence rather than ending in a doubled period.
      this.log.error("Unable to %s: %s.", action, ((error instanceof Error) ? error.message : String(error)).replace(/\.+$/, ""));

      return false;
    }
  }
}
