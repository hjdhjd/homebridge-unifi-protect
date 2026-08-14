/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * device-capability.ts: ProtectDeviceCapability - the contract for a capability composed onto a hosting device, and the host surface it reads through.
 */
import type { AcquireServiceTarget, Nullable } from "homebridge-plugin-utils";
import type { Service, WithUUID } from "homebridge";
import { acquireService, validService } from "homebridge-plugin-utils";
import type { ProtectAccessory } from "../types.ts";
import { ProtectBase } from "./device-base.ts";
import type { ProtectDeviceContext } from "./device.ts";
import type { ProtectNvr } from "../nvr/nvr.ts";

/* The slice of a hosting device that a composed capability genuinely reads through it. ProtectDevice implements it, so every device family is capability-host-capable by
 * compiler proof rather than by retrofit: the contract is structural, and its one implementation obligation beyond what a device already exposes is publishObserverWake,
 * a three-line pass-through onto a hook ProtectDevice already owns. Universal conformance therefore costs one thin method and buys any future capability - on a camera or
 * on any other family - a host that is ready by construction.
 *
 * The members it shares with ProtectDeviceContext are DERIVED through the Pick rather than re-spelled, so those signatures stay single-sourced and a widening in the
 * device context reaches here without a second edit. Reachability is one of them, and a capability reads it through the host deliberately: the composition of controller
 * health with the device's own online state lives at exactly one place, and a capability re-deriving it from its own projection would read a device online state that a
 * controller outage freezes at a stale value.
 *
 * This deliberately does NOT extend the whole ProtectDeviceContext the way ProtectCameraHost does. A capability inherits api, log, nvr, and platform from its own
 * ProtectBase ancestry, so it needs none of them from its host; what it needs is only what belongs to the host itself - the host's accessory, its feature-option scope,
 * its identity, its reachability, and its wake channel. The media layer's contract carries the whole device-context slice because it crosses a subsystem boundary and its
 * consumers hold no ProtectBase ancestry of their own; a capability's need is narrower, so its contract is narrower.
 */
export interface ProtectCapabilityHost extends Pick<ProtectDeviceContext, "accessory" | "accessoryName" | "hasFeature" | "isReachable"> {

  // Resolves a numeric feature option against the host's device and controller scope.
  getFeatureNumber(option: string): Nullable<number | undefined>;

  // Whether a proposed identifier collides with a reserved subtype name the plugin uses.
  isReservedName(name?: string): boolean;

  // The host's bare device MAC - the MQTT topic scope a capability's own topics ride, so its wire scope matches the host's.
  readonly mac: string;

  // The host's functional name, which a capability adopts for its log prefix and its diagnostics subject.
  readonly name: string;

  // Publishes an observer-wake milestone under the host's accessory identity. A capability has no accessory of its own, so it attributes its wakes here and one publisher
  // keyed on the host accessory serves both.
  publishObserverWake(key: string): void;

  // Whether the host's backing controller record is currently present, which gates a capability's observers exactly as it gates the host's own.
  readonly recordPresent: boolean;
}

/* The base every capability composed onto a hosting device extends. A capability is not a device: it owns no accessory, holds no HomeKit identity of its own, and its
 * whole existence is a slice of behavior attached to a host that does. What it does own is the spine - observe loops, MQTT registrations, timers, device commands, and
 * the lifetime that scopes them - which it inherits from ProtectBase, and a host reference through which every device-level read resolves.
 *
 * The lifecycle has three moments and one member expressing each: configure() attaches, reconcile() converges, and cleanup() releases. Each carries a default, so a
 * capability overrides exactly the moments where it has work and its own shape declares which discipline it follows.
 *
 * THE LIFETIME. The constructor composes the capability's own controller against the HOST's already-composed signal, so the lifetime nests three deep: the controller
 * connection, then the host device, then the capability. An abort at any level unwinds every level below it, and the capability's own cleanup unwinds only itself.
 *
 * THE ATTACH LIFECYCLE. A capability is CONSTRUCTED at the composition root (the NVR builds it; a sibling device class never does, which is what keeps the device layer's
 * value-import graph free of construction edges), while the DECISION to attach belongs to the owner that observes the capability-bearing state. Where a capability's
 * shape is frozen at construction and the state it was frozen against goes stale, the owner rebuilds rather than mutates.
 *
 * THE RECONCILE LIFECYCLE. A capability that gates services on controller-reported capabilities reconciles them through ONE chokepoint that runs at attach and again
 * whenever a capability-bearing slice changes, over a small fixed observer set. Reconcile is re-runnable, additive-eager (a capability the controller starts reporting
 * appears without a restart) and subtractive-conservative (a capability the controller stops reporting is narrated, not silently torn down).
 *
 * THE CLEANUP LIFECYCLE. cleanup() is inherited: aborting the capability's controller releases its observers, its MQTT registrations, and its timers together. A
 * capability that owns a detachable CHILD overrides cleanup() to tear that child down first and then calls super.
 *
 * THE TWO DISCIPLINES EVERY CAPABILITY FOLLOWS, recorded here rather than at any one consumer so the next implementer inherits them from the contract:
 *
 *   - Teardown detection is the capability's OWN signal, never a presence flag borrowed from the host. The host's recordPresent reports the temporary removal grace, not
 *     permanent deletion, and the inherited observeState gate already skips a handler while it is false - so a capability that stopped its own timers on that flag would
 *     tear them down on a transient blip and silence the very observers that would re-arm them. What stops a capability's timers is the signal-bound registry drain, and
 *     what stops a continuation already suspended at an await is a signal.aborted check after it.
 *   - A host reaches its capability through a get-or-create accessor whose body is a single ??= assignment, so double construction under a re-entrant reconcile is
 *     unrepresentable. The guarantee rides the assignment operator itself rather than where the call sits, which keeps it true after a future edit moves a caller past an
 *     await.
 *
 * THE TWO DETACHABILITY POLICIES, as documentation rather than runtime artifacts, because which methods a capability implements is what expresses its policy and nothing
 * consumes a policy field:
 *
 *   - Promotion-only own-detach. The capability attaches once and never detaches itself: a controller-side demotion is warned about and the capability is kept, and its
 *     teardown rides the host's own cascade. A capability with this policy implements configure() and inherits cleanup() unchanged.
 *   - Graced-cycle child-detach. The capability owns a child that genuinely comes and goes, so it runs the full detach checklist against the shared NVR machinery -
 *     cancel any pending detach on a re-appearance, gate the detach on controller stability, and remove the child's accessory, its registrations, and its handle
 *     together. A capability with this policy overrides cleanup() and drives its child's lifecycle from its own reconcile.
 */
export abstract class ProtectDeviceCapability<H extends ProtectCapabilityHost = ProtectCapabilityHost> extends ProtectBase {

  // The hosting device this capability is composed onto, and the single reference every device-level read below resolves through.
  protected readonly host: H;

  // Construct the capability against its host. The host passes itself and its own lifetime signal from inside its own class body, so no visibility widening is needed,
  // and the spine composes this capability's controller against that signal - aborting either tears the capability down.
  constructor(nvr: ProtectNvr, init: { host: H; signal: AbortSignal }) {

    super(nvr, init.signal);

    this.host = init.host;
  }

  // Stand this capability's HomeKit surface up: the attach-once moment, called by the owner that decided to attach it, after construction. It is deliberately NOT
  // re-runnable, so it is the home for work that registers something exactly once - spawning observers, registering MQTT handlers, standing up a service that must exist
  // once. A capability with no attach-once work leaves this default alone and overrides reconcile() instead.
  public configure(): void {

    // No-op by default; a capability whose whole body is convergence has nothing to register once.
  }

  // Converge this capability's HomeKit surface against the controller's live state: the recurring moment, called by the owner's reconcile chokepoint at attach and again
  // whenever a slice the capability reads may have changed. Re-runnable by contract, which makes every operation in an override a get-or-create or a replace rather than
  // an add. The return type is a uniform promise rather than a void union deliberately: a union compiles at a call site whether or not it is awaited, so nothing would
  // force the await, whereas a promise makes a forgotten await a lint finding.
  public async reconcile(): Promise<void> {

    // No-op by default; a capability whose work is all attach-once has nothing to converge.
  }

  // The host's accessory: a capability's services all live on the accessory its host owns.
  protected get accessory(): ProtectAccessory {

    return this.host.accessory;
  }

  // The host's accessory name, the default name a capability's own services take.
  protected get accessoryName(): string {

    return this.host.accessoryName;
  }

  // Feature-option reads resolve through the host, which scopes them against its own device MAC and the controller MAC.
  protected hasFeature(option: string): boolean {

    return this.host.hasFeature(option);
  }

  // Numeric feature-option reads resolve through the host, the same delegation hasFeature uses.
  protected getFeatureNumber(option: string): Nullable<number | undefined> {

    return this.host.getFeatureNumber(option);
  }

  // The reserved-name check resolves through the host's own helper, so a capability and its host agree on the reserved set.
  protected isReservedName(name?: string): boolean {

    return this.host.isReservedName(name);
  }

  // Acquire a service on the host's accessory, a thin re-binding to the homebridge-plugin-utils free function - the same single source ProtectDevice's own wrapper
  // delegates to. It lives here rather than on the spine because the spine also serves owners with no single accessory (liveviews manages a set) or a nullable one (the
  // controller's system-information owner), so an accessory contract there would be dishonest; here a non-null accessory genuinely exists.
  protected acquireService(serviceType: AcquireServiceTarget, name = this.accessoryName, subtype?: string, onServiceCreate?: (svc: Service) => void): Nullable<Service> {

    return acquireService(this.accessory, serviceType, name, subtype, onServiceCreate);
  }

  // Validate a service on the host's accessory, the same thin re-binding. The validate argument accepts either a plain boolean or a presence-aware predicate, mirroring
  // the free function: the predicate receives the service's current presence so a gate can keep an already-present service while refusing to create a new one.
  protected validService(serviceType: WithUUID<typeof Service>, validate: boolean | ((hasService: boolean) => boolean), subtype?: string): boolean {

    return validService(this.accessory, serviceType, validate, subtype);
  }

  // The log prefix and diagnostics name: the host's functional name, which resolves to the live controller projection name so a log prefix tracks the controller's
  // current name for the device. NOT the accessory name (the cached HomeKit Name), which would diverge.
  public override get name(): string {

    return this.host.name;
  }

  // The MQTT topic scope: the host's MAC, so a capability's topics ride the same wire scope as its host's.
  protected override get mqttId(): string {

    return this.host.mac;
  }

  // The debug scope: the host's identity, so a capability's debug lines answer to the same Log.Debug entry that turns on the device hosting it. A capability has no
  // identity of its own on the controller, so resolving anywhere but its host's scope would leave its lines unreachable from the webUI.
  protected override get debugScope(): { controller?: string; device?: string } {

    return { controller: this.nvr.ufp.mac, device: this.host.mac };
  }

  // Whether the host is currently reachable, delegated to the host - the two-scope composition of controller health with the device's own online state. A capability
  // consults this before issuing a controller read that would only fail, and reflects it onto any StatusActive characteristic its own services carry.
  protected get isReachable(): boolean {

    return this.host.isReachable;
  }

  // Whether the backing controller record is present, delegated to the host - a capability extends the spine rather than ProtectDevice, so it has no record of its own.
  // This drives the inherited observeState gate, so a capability's observers no-op during the host's removal grace exactly as the host's own do.
  protected override get recordPresent(): boolean {

    return this.host.recordPresent;
  }

  // Wake attribution: a capability has no accessory identity of its own, so it delegates to the host's single publish window, keeping one publisher keyed on the host's
  // accessory UUID. A capability's own slice keys stay diagnostics-visible under that accessory.
  protected override onObserverWake(key: string): void {

    this.host.publishObserverWake(key);
  }
}
