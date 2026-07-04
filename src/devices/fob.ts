/* Copyright(C) 2019-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * fob.ts: Fob device class for UniFi Protect.
 */
import type { Fob, ProtectFobConfig } from "unifi-protect";
import type { ProtectAccessory, WithoutIdentity } from "../types.ts";
import type { Nullable } from "homebridge-plugin-utils";
import { ProtectDevice } from "./device.ts";
import type { ProtectNvr } from "../nvr/nvr.ts";
import { ProtectReservedNames } from "../types.ts";
import { selectFob } from "unifi-protect";

// One physical button on a UniFi Protect fob. index is the STABLE 1-based ServiceLabelIndex the button always carries in HomeKit (never a compacted visible-subset
// position, so a hidden earlier button never renumbers a later one); label is the title-cased human name that both names the HomeKit switch and derives the per-button
// feature-option identity; wireId is the lowercase protocol id the controller's buttonPressed occurrence carries in its `button` field. label and wireId are deliberately
// distinct derivations - the protocol id is not a display string and must never drift toward one.
interface FobButton {

  readonly index: number;
  readonly label: string;
  readonly wireId: string;
}

// The fixed, region-agnostic button table for the UniFi fob family. The controller config carries no per-button array (a fob is a pure-input device whose presses arrive
// only as firehose occurrences), so the plugin authors the button set from live-captured wire truth: six buttons, stable wire ids independent of the user's buttonLabels
// profile. The order matches the physical layout and fixes each button's 1-based ServiceLabelIndex.
const USL_FOB_BUTTONS: readonly FobButton[] = [

  { index: 1, label: "Panic", wireId: "panic" },
  { index: 2, label: "Disarm", wireId: "disarm" },
  { index: 3, label: "Night", wireId: "night" },
  { index: 4, label: "Arm", wireId: "arm" },
  { index: 5, label: "Right", wireId: "right" },
  { index: 6, label: "Left", wireId: "left" }
];

// The single region-agnostic chokepoint that decides which button table a fob record maps to, or null when the fob is not a recognized family. It is deliberately
// nullish-safe: marketName and type are declared non-optional but are runtime-optional (the same caution the base setInfo documents), so a record missing both resolves
// to null rather than throwing. A fob is recognized when its marketName is exactly "USL Fob" OR its type carries the "USL-Fob-" family prefix.
function resolveFobButtons(config: ProtectFobConfig): Nullable<readonly FobButton[]> {

  // marketName is optional at runtime despite its non-optional declared type, so the nullish handling below is real, not redundant.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  return ((config.marketName === "USL Fob") || (config.type?.startsWith("USL-Fob-") ?? false)) ? USL_FOB_BUTTONS : null;
}

export class ProtectFob extends ProtectDevice {

  // Narrow the inherited projection handle to the fob projection so the read-through config getter resolves to ProtectFobConfig.
  declare protected readonly device: Fob;

  // The fob's button table, resolved ONCE from the immutable model identity (marketName/type) at construction. This is a documented, principled exemption to the
  // read-live discipline: the button set is static MODEL identity, not cached live STATE - a fob never changes which physical buttons it has - so resolving it once from
  // the raw record is correct rather than a staleness hazard. An unrecognized fob resolves to an empty table and is exposed Battery-only.
  readonly #buttons: readonly FobButton[];

  // Create an instance.
  constructor(nvr: ProtectNvr, accessory: ProtectAccessory, device: Fob) {

    super(nvr, accessory, device);

    this.#buttons = resolveFobButtons(device.config) ?? [];

    this.configureHints();
    this.configureDevice();
    this.spawnObservers();
  }

  // Read-through to the fob projection's live STATE, narrowed to drop device identity (id/mac/modelKey). Identity flows through the dedicated non-throwing accessors
  // (protectId/modelKey/.id/.mac), never this throwing config getter; this override mirrors the base getter's body and narrows only the surfaced return type.
  public override get ufp(): Readonly<WithoutIdentity<ProtectFobConfig>> {

    return this.device.config;
  }

  // The stable HomeKit service subtype for one button's stateless-programmable-switch service, keyed by the LOWERCASE wire id. Single-sourced so the create site here and
  // the router's delivery address (SWITCH_FOB_BUTTON + "." + event.button) name the identical service; a create/address divergence would make getServiceById silently
  // return undefined and no press would ever fire.
  private buttonSubtype(button: FobButton): string {

    return ProtectReservedNames.SWITCH_FOB_BUTTON + "." + button.wireId;
  }

  // The per-button feature-option identity, keyed by the TITLE-CASED display label so the config reads as "Fob.Button.Panic". Distinct from buttonSubtype by design: the
  // subtype speaks the protocol (lowercase wire id), the option speaks to the user (title-cased label). Single-sourced so the create-time gate and the option-resolution
  // test address the identical option string.
  private buttonOption(button: FobButton): string {

    return "Fob.Button." + button.label;
  }

  // Initialize and configure the fob accessory for HomeKit.
  private configureDevice(): boolean {

    // Clean out the context object in case it's been polluted somehow.
    this.accessory.context = {};

    // Seed the identity source of truth (the persisted bare MAC) from the raw record at configure time, where the record is present - identity is not read through the
    // narrowed live-state projection.
    this.accessory.context.mac = this.device.config.mac;
    this.accessory.context.nvr = this.nvr.ufp.mac;

    // Configure accessory information.
    this.configureInfo();

    // Configure the fob's button switches.
    this.configureButtons();

    // Configure the battery status.
    this.configureBatteryService();

    return true;
  }

  // Configure a HomeKit stateless-programmable-switch for each of the fob's buttons, grouped under a ServiceLabel when two or more are visible. A fob is a pure-input
  // device: the leaf creates the services here and the event-dispatch router delivers the presses, so there are no onGet/onSet handlers and no observers on this path.
  // The button set is fixed model identity, so this runs once at construction. Each button is individually show/hide-able through its own feature option, and hiding one
  // prunes exactly its switch. Idempotent across restarts and option flips: the ServiceLabel and every switch are validated against the current visibility before being
  // acquired, and a switch surviving from a prior grouped configure has its stale ServiceLabelIndex dropped when the fob regroups down to a lone visible button.
  private configureButtons(): void {

    // An unrecognized fob has no button table, so we expose it Battery-only and surface one actionable line - never a silent adoption. The model read is non-throwing: an
    // absent record (a fob lingering in the removal grace) resolves the "unknown" sentinel rather than throwing.
    if(!this.#buttons.length) {

      // marketName is optional at runtime despite its non-optional declared type, so the nullish fallback to type is real, not redundant.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      const model = this.fromRecord((config) => config.marketName ?? config.type, "unknown");

      this.log.warn("This fob (%s) is not a recognized model, so its buttons were not added to HomeKit. Please open an issue with a capture of a button press so " +
        "support can be added.", model);

      return;
    }

    // The visible subset drives the grouping decision. HAP models a multi-button remote as a ServiceLabel plus one StatelessProgrammableSwitch per button (spec 8.21),
    // but a lone button needs no label, so we group only when two or more buttons are actually visible.
    const visible = this.#buttons.filter((button) => this.hasFeature(this.buttonOption(button)));
    const grouped = visible.length >= 2;

    // Validate the ServiceLabel against the grouping decision - a fob that drops below two visible buttons (an option flip across a restart) has its label removed - then
    // acquire it and set its namespace when grouped. serviceLabel non-null is the single source of truth for "grouped" through the loop below.
    this.validService(this.hap.Service.ServiceLabel, grouped);

    const serviceLabel = grouped ? this.acquireService(this.hap.Service.ServiceLabel) : null;

    if(serviceLabel) {

      serviceLabel.updateCharacteristic(this.hap.Characteristic.ServiceLabelNamespace, this.hap.Characteristic.ServiceLabelNamespace.ARABIC_NUMERALS);
    }

    // Iterate the full fixed table, gating each button's switch on its own feature option. Hiding a button prunes exactly its subtyped switch and leaves the siblings and
    // the accessory intact.
    for(const button of this.#buttons) {

      const subtype = this.buttonSubtype(button);

      // Validate whether this button's switch should exist, gating on the per-button feature option. This prunes exactly this button's subtyped switch when hidden.
      if(!this.validService(this.hap.Service.StatelessProgrammableSwitch, this.hasFeature(this.buttonOption(button)), subtype)) {

        continue;
      }

      // Acquire the service, named by the bare button label. The switch is grouped under the fob accessory and acquireService sets its ConfiguredName - which the Home
      // app honors as the button's name - so an unqualified label reads cleanest ("Panic", not "<Fob> Panic"); the accessory already supplies the fob's context.
      const service = this.acquireService(this.hap.Service.StatelessProgrammableSwitch, button.label, subtype);

      // Fail gracefully.
      if(!service) {

        this.log.error("Unable to add the fob button switch for %s.", button.label);

        continue;
      }

      if(serviceLabel) {

        // Grouped: stamp the STABLE fixed table index (never the visible-subset position, so hiding an earlier button never renumbers a later one) and link the switch to
        // the label so HomeKit renders them as one remote.
        service.updateCharacteristic(this.hap.Characteristic.ServiceLabelIndex, button.index);
        serviceLabel.addLinkedService(service);
      } else if(service.testCharacteristic(this.hap.Characteristic.ServiceLabelIndex)) {

        // Lone visible: a switch restored from a prior grouped configure carries a stale ServiceLabelIndex, so we drop it. A single-button fob presents no index and
        // links to no label. The testCharacteristic guard keeps this side-effect-free when no stale index is present, so a freshly-created lone switch is untouched.
        service.removeCharacteristic(service.getCharacteristic(this.hap.Characteristic.ServiceLabelIndex));
      }
    }
  }

  // Configure the battery service for HomeKit.
  private configureBatteryService(): boolean {

    // Acquire the service.
    const service = this.acquireService(this.hap.Service.Battery);

    // Fail gracefully.
    if(!service) {

      this.log.error("Unable to add the battery service.");

      return false;
    }

    // Initialize the battery state.
    this.updateBatteryStatus();

    return true;
  }

  // Update the battery status in HomeKit. The fob's battery lives under wirelessConnectionState.batteryStatus (the LoRa link telemetry), NOT the top-level batteryStatus
  // a wired sensor reads - so the read path is nested here. Both reads are non-throwing: an absent record reports a full, not-low battery rather than throwing.
  private updateBatteryStatus(): boolean {

    // Find the battery service, if it exists.
    const batteryService = this.accessory.getService(this.hap.Service.Battery);

    // Read the nested battery facts non-throwing, defaulting a fob in the removal grace to a full, not-low battery.
    const isLow = this.fromRecord((config) => config.wirelessConnectionState.batteryStatus.isLow, false);
    const percentage = this.fromRecord((config) => config.wirelessConnectionState.batteryStatus.percentage ?? 0, 0);

    // Update the battery status.
    batteryService?.updateCharacteristic(this.hap.Characteristic.BatteryLevel, percentage);
    batteryService?.updateCharacteristic(this.hap.Characteristic.StatusLowBattery, isLow);

    return true;
  }

  // Spawn the fob's narrow-selector observers. super spawns the universal observers (name sync and firmware/device-info refresh); the fob adds battery observers,
  // one per battery field, each waking only on its own slice through the store's reference dedup and delegating to the shared battery updater. There are NO per-button
  // observers: button presses are firehose occurrences delivered by the event-dispatch router, not device-state fields observed here.
  protected override spawnObservers(): void {

    super.spawnObservers();

    const fob = selectFob(this.device.id);

    // The battery-level reaction: when the controller's reported battery percentage changes, re-push BatteryLevel. The selector reads the primitive, so an unrelated fob
    // patch never wakes it.
    this.observeState({ key: "fob.battery.percentage", selector: (state) => fob(state)?.wirelessConnectionState.batteryStatus.percentage, title: "the battery level" },
      () => this.updateBatteryStatus());

    // The low-battery reaction: when the controller's low-battery flag flips, re-push StatusLowBattery. Kept a separate observer from the level above so each wakes only
    // on its own field.
    this.observeState({ key: "fob.battery.isLow", selector: (state) => fob(state)?.wirelessConnectionState.batteryStatus.isLow, title: "the battery status" },
      () => this.updateBatteryStatus());
  }
}
