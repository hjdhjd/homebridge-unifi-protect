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
 * The three members it shares with ProtectDeviceContext are DERIVED through the Pick rather than re-spelled, so those signatures stay single-sourced and a widening in
 * the device context reaches here without a second edit.
 *
 * This deliberately does NOT extend the whole ProtectDeviceContext the way ProtectCameraHost does. A capability inherits api, log, nvr, and platform from its own
 * ProtectBase ancestry, so it needs none of them from its host; what it needs is only what belongs to the host itself - the host's accessory, its feature-option scope,
 * its identity, and its wake channel. The media layer's contract carries the whole device-context slice because it crosses a subsystem boundary and its consumers hold no
 * ProtectBase ancestry of their own; a capability's need is narrower, so its contract is narrower.
 */
export interface ProtectCapabilityHost extends Pick<ProtectDeviceContext, "accessory" | "accessoryName" | "hasFeature"> {

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

  // Stand this capability's HomeKit surface up. Called by the owner that decided to attach it, after construction.
  public abstract configure(): void;

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
