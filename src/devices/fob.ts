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
import { deviceSelectors } from "unifi-protect";

// One physical button on a UniFi Protect fob. index is the STABLE 1-based ServiceLabelIndex the button always carries in HomeKit (never a compacted visible-subset
// position, so a hidden earlier button never renumbers a later one), following the controller's own button numbering. label is the security-action display name AND the
// stable per-button feature-option identity (Fob.Button.<label>); that identity never follows the controller's active button labeling. positionLabel is the display name
// the controller's position-hint labeling assigns the button. wireId is the lowercase protocol id the controller's buttonPressed occurrence carries in its `button`
// field. label and wireId are deliberately distinct derivations - the protocol id is not a display string and must never drift toward one.
interface FobButton {

  readonly index: number;
  readonly label: string;
  readonly positionLabel: string;
  readonly wireId: string;
}

// The fixed, region-agnostic button table for the UniFi fob family. The controller config carries no per-button array (a fob is a pure-input device whose presses arrive
// only as firehose occurrences), so the plugin authors the button set from live-captured wire truth: six buttons whose wire ids are stable across the controller's
// button-labeling modes. The indices follow the controller's own button numbering - the numbers its position-hint labeling assigns - so HomeKit's button ordering matches
// the controller's in both label modes. Because the wire ids are labeling-independent, this table, not the controller's labeling choice, is the button-identity source of
// truth, and it fixes each button's 1-based ServiceLabelIndex.
const USL_FOB_BUTTONS: readonly FobButton[] = [

  { index: 1, label: "Arm", positionLabel: "1", wireId: "arm" },
  { index: 2, label: "Night", positionLabel: "2", wireId: "night" },
  { index: 3, label: "Disarm", positionLabel: "3", wireId: "disarm" },
  { index: 4, label: "Panic", positionLabel: "4", wireId: "panic" },
  { index: 5, label: "Right", positionLabel: "Right", wireId: "right" },
  { index: 6, label: "Left", positionLabel: "Left", wireId: "left" }
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

  // Resolve one button's active HomeKit display name from the fob's live button labeling. The position-hint comparison is deliberately the only labeling mode this method
  // distinguishes: an absent or unrecognized value resolves to the security-action names, which is the forward-compatible default. The read is non-throwing, so a fob in
  // the removal grace resolves safely.
  private buttonName(button: FobButton): string {

    return (this.fromRecord((config) => config.buttonLabels, "securityActions") === "positionHint") ? button.positionLabel : button.label;
  }

  // Initialize and configure the fob accessory for HomeKit.
  private configureDevice(): boolean {

    // Reset the persisted context to a clean slate and reseed identity, discarding any stray keys a prior configuration of this same accessory left behind. The fob
    // persists no user state, so nothing is preserved across the reset.
    this.resetAccessoryContext();

    // Configure accessory information.
    this.configureInfo();

    // Configure the fob's button switches.
    this.configureButtons();

    // Configure the battery status.
    this.configureBatteryService();

    return true;
  }

  // Configure a HomeKit stateless-programmable-switch for each of the fob's buttons, grouped under a ServiceLabel when two or more are visible. A fob is a pure-input
  // device: the leaf creates the services here and the event-dispatch router delivers the presses, so there are no onGet/onSet handlers on this path. The button set is
  // fixed model identity, so this runs once at construction. Each button is individually show/hide-able through its own feature option, and hiding one prunes exactly its
  // switch. Repeat-safe across restarts and option flips: the ServiceLabel and every switch are validated against the current visibility before being acquired, and a
  // switch surviving from a prior grouped configure has its stale ServiceLabelIndex dropped when the fob regroups down to a lone visible button. Once the switches are in
  // place, a configure-time name reconcile brings every button's ConfiguredName to the controller's active button labeling, covering accessories restored from cache and
  // labeling changes that landed while Homebridge was down.
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

      // Acquire the service, named by the bare security-action label. displayName and the Name characteristic hold that label as the stable identity hap-nodejs
      // revalidates through checkName on every construction, including cache-restore, where a single-character name would trip it; ConfiguredName carries the label the
      // controller's active button labeling assigns, which is what the Home app shows for a grouped switch. The create callback initializes ConfiguredName so a fresh
      // button is born correctly named and the reconcile below stays silent. An unqualified label reads cleanest ("Arm", not "<Fob> Arm"); the accessory already supplies
      // the fob's context.
      const service = this.acquireService(this.hap.Service.StatelessProgrammableSwitch, button.label, subtype,
        (svc) => svc.updateCharacteristic(this.hap.Characteristic.ConfiguredName, this.buttonName(button)));

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

    // The configure-time name reconcile. It reconciles a restored accessory's button names and any labeling change that landed while Homebridge was down, since the
    // store's observe never replays on subscribe. A freshly created button is already at its active name from the create callback above, so this stays silent on a clean
    // start.
    this.updateButtonNames();
  }

  // Reconcile every visible button's ConfiguredName to the fob's active button labeling, honoring any name the user has assigned. The ownership test is stateless: a
  // button's current ConfiguredName belongs to the plugin exactly when it is a value the plugin itself would ever author for that button - the security-action label or
  // the position-hint label - or is absent entirely. A plugin-owned name that differs from the active one is rewritten and counted; anything else is a user rename and is
  // left untouched. One corollary follows by construction: a user who renames a button to exactly one of the plugin's own labels re-enters plugin management, because the
  // two cases are indistinguishable at read time, and that is the designed behavior. The absent-name branch initializes silently and is never counted as a rename - in
  // production every button is born with a ConfiguredName through the create callback, so it is a robustness net rather than a live path. This writes ConfiguredName
  // directly rather than renaming the whole service: displayName and the Name characteristic are the stable identity hap-nodejs revalidates through checkName, while
  // ConfiguredName is the display lever the Home app reads for a grouped switch.
  private updateButtonNames(): void {

    let renamed = 0;

    for(const button of this.#buttons) {

      // Resolve this button's switch; skip it when absent - hidden by its feature option, or a failed acquire.
      const service = this.accessory.getServiceById(this.hap.Service.StatelessProgrammableSwitch, this.buttonSubtype(button));

      if(!service) {

        continue;
      }

      // Read the current ConfiguredName without materializing it - the existence gate keeps a name-less service from gaining an empty characteristic just to be read.
      const current = service.testCharacteristic(this.hap.Characteristic.ConfiguredName) ?
        service.getCharacteristic(this.hap.Characteristic.ConfiguredName).value : undefined;
      const active = this.buttonName(button);

      // The steady state: the name already matches the active labeling, so touch nothing.
      if(current === active) {

        continue;
      }

      // A name-less service: initialize it silently, never counted as a rename.
      if(current === undefined) {

        service.updateCharacteristic(this.hap.Characteristic.ConfiguredName, active);

        continue;
      }

      // Plugin-authored: the current name is one the plugin itself would ever assign this button, so it is ours to bring to the active labeling, and we count the rename.
      if((current === button.label) || (current === button.positionLabel)) {

        service.updateCharacteristic(this.hap.Characteristic.ConfiguredName, active);
        renamed++;

        continue;
      }

      // Anything else is a name the user assigned: honor it and touch nothing.
      this.log.debug("Preserving the user-assigned name for the %s button: %s.", button.wireId, current);
    }

    // Log one line only on a real transition, chosen by the resolved labeling so the sentence reads plainly for what the controller reports.
    if(renamed > 0) {

      switch(this.fromRecord((config) => config.buttonLabels, "securityActions")) {

        case "positionHint":

          this.log.info("The controller labels the fob buttons by number; updating the button names in HomeKit to match.");

          break;

        case "securityActions":

          this.log.info("The controller labels the fob buttons by security action; updating the button names in HomeKit to match.");

          break;

        default:

          this.log.info("The controller reports a fob button labeling we do not recognize; using the security action button names.");

          break;
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

  // Spawn the fob's narrow-selector observers. super spawns the universal observers (name sync and firmware/device-info refresh); the fob adds battery observers, one per
  // battery field, each waking only on its own slice through the store's reference dedup and delegating to the shared battery updater, and - for a recognized model - a
  // button-label observer that reconciles the button names when the controller's active labeling changes. Button PRESSES have no observers: they are firehose occurrences
  // delivered by the event-dispatch router, not device-state fields observed here.
  protected override spawnObservers(): void {

    super.spawnObservers();

    const fob = deviceSelectors.fob.byId(this.device.id);

    // The battery-level reaction: when the controller's reported battery percentage changes, re-push BatteryLevel. The selector reads the primitive, so an unrelated fob
    // patch never wakes it.
    this.observeState({ key: "fob.battery.percentage", selector: (state) => fob(state)?.wirelessConnectionState.batteryStatus.percentage, title: "the battery level" },
      () => this.updateBatteryStatus());

    // The low-battery reaction: when the controller's low-battery flag flips, re-push StatusLowBattery. Kept a separate observer from the level above so each wakes only
    // on its own field.
    this.observeState({ key: "fob.battery.isLow", selector: (state) => fob(state)?.wirelessConnectionState.batteryStatus.isLow, title: "the battery status" },
      () => this.updateBatteryStatus());

    // The button-label reaction: when the controller's active button labeling changes, reconcile every plugin-managed button's ConfiguredName to the new labeling. Gated
    // on a non-empty button table - an unrecognized fob has no buttons to rename, so it subscribes to nothing. The selector reads the primitive labeling string, so an
    // unrelated fob patch never wakes it.
    if(this.#buttons.length) {

      this.observeState({ key: "fob.buttonLabels", selector: (state) => fob(state)?.buttonLabels, title: "the button labels" }, () => this.updateButtonNames());
    }
  }
}
