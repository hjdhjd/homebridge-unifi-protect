/* Copyright(C) 2019-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * fob.ts: Fob device class for UniFi Protect.
 */
import { USL_FOB_BUTTONS, resolveFobButtons } from "./fob-buttons.ts";
import type { Fob } from "unifi-protect";
import type { FobButton } from "./fob-buttons.ts";
import type { ProtectAccessory } from "../types.ts";
import { ProtectDevice } from "./device.ts";
import type { ProtectNvr } from "../nvr/nvr.ts";
import { ProtectReservedNames } from "../types.ts";
import { describeDeviceModel } from "./device-descriptor.ts";
import { validCharacteristic } from "homebridge-plugin-utils";

// Projects one UniFi Protect LoRa fob's fixed button set and battery state onto a HomeKit accessory.
export class ProtectFob extends ProtectDevice<Fob> {

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

  // The stable HomeKit service subtype for one button's stateless-programmable-switch service, keyed by the LOWERCASE wire id - the same identity the buttons selection
  // stores. Single-sourced so the create site here and the router's delivery address (SWITCH_FOB_BUTTON + "." + event.button) name the identical service; a
  // create/address divergence would make getServiceById silently return undefined and no press would ever fire.
  private buttonSubtype(button: FobButton): string {

    return ProtectReservedNames.SWITCH_FOB_BUTTON + "." + button.wireId;
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
  // fixed model identity, so this runs once at construction. Which buttons appear is a single selection the user edits as one list, and leaving one out prunes exactly
  // its switch. Repeat-safe across restarts and option flips: the ServiceLabel and every switch are validated against the current visibility before being acquired, and a
  // switch surviving from a prior grouped configure has its stale ServiceLabelIndex dropped when the fob regroups down to a lone visible button. Once the switches are in
  // place, a configure-time name reconcile brings every button's ConfiguredName to the controller's active button labeling, covering accessories restored from cache and
  // labeling changes that landed while Homebridge was down.
  private configureButtons(): void {

    // An unrecognized fob has no button table, so we expose it Battery-only and surface one actionable line - never a silent adoption. The model read is non-throwing: an
    // absent record (a fob lingering in the removal grace) resolves the "unknown" sentinel rather than throwing.
    if(!this.#buttons.length) {

      // The "unknown" default covers an absent record; a present one renders its model through the shared resolver, so the warning names the fob exactly as every
      // other line naming that hardware does.
      const model = this.fromRecord(describeDeviceModel, "unknown");

      this.log.warn("This fob (%s) is not a recognized model, so its buttons were not added to HomeKit. Please open an issue with a capture of a button press so " +
        "support can be added.", model);

      return;
    }

    // The buttons the user selected, resolved once for the whole pass so the grouping decision below and the per-button gate in the loop read one answer. The domain is
    // this fob's own button table, addressed by wire id, so a selection naming a button this model does not have simply does not appear.
    const selected = new Set(this.getFeatureList("Fob.Buttons", USL_FOB_BUTTONS.map((button) => button.wireId)));

    // The visible subset drives the grouping decision. HAP models a multi-button remote as a ServiceLabel plus one StatelessProgrammableSwitch per button (spec 8.21),
    // but a lone button needs no label, so we group only when two or more buttons are actually visible.
    const visible = this.#buttons.filter((button) => selected.has(button.wireId));
    const grouped = visible.length >= 2;

    // Validate the ServiceLabel against the grouping decision - a fob that drops below two visible buttons (an option flip across a restart) has its label removed, and a
    // grouped fob acquires it - then set its namespace when grouped. The grouping decision is also the verdict each button's label index follows in the loop below, so
    // the label is present exactly when the buttons carry an index to link to it.
    const { service: serviceLabel } = this.validService({ serviceType: this.hap.Service.ServiceLabel, validate: grouped });

    if(serviceLabel) {

      serviceLabel.updateCharacteristic(this.hap.Characteristic.ServiceLabelNamespace, this.hap.Characteristic.ServiceLabelNamespace.ARABIC_NUMERALS);
    }

    // Iterate the full fixed table, gating each button's switch on the selection. Leaving a button out prunes exactly its subtyped switch and leaves the siblings and the
    // accessory intact.
    for(const button of this.#buttons) {

      const subtype = this.buttonSubtype(button);

      // Validate whether this button's switch should exist, gating on the selection resolved above. This prunes exactly this button's subtyped switch when it is left
      // out of the list, and otherwise acquires it, named by the bare security-action label. displayName and the Name characteristic hold that label as the stable
      // identity hap-nodejs revalidates through checkName on every construction, including cache-restore, where a single-character name would trip it; ConfiguredName
      // carries the label the controller's active button labeling assigns, which is what the Home app shows for a grouped switch. The create callback initializes
      // ConfiguredName so a fresh button is born correctly named and the reconcile below stays silent. An unqualified label reads cleanest ("Arm", not "<Fob> Arm"); the
      // accessory already supplies the fob's context.
      const { service } = this.validService({ name: button.label,
        onServiceCreate: (svc) => svc.updateCharacteristic(this.hap.Characteristic.ConfiguredName, this.buttonName(button)),
        serviceType: this.hap.Service.StatelessProgrammableSwitch, subtype, validate: selected.has(button.wireId) });

      if(!service) {

        continue;
      }

      // Validate the switch's ServiceLabelIndex against the same grouping decision. Lone visible, a switch restored from a prior grouped configure has its stale index
      // removed, while a freshly created lone switch is left untouched, so a single-button fob presents no index and links to no label.
      const transition = validCharacteristic({ characteristic: this.hap.Characteristic.ServiceLabelIndex, service, validate: grouped });

      // Grouped: stamp the STABLE fixed table index (never the visible-subset position, so hiding an earlier button never renumbers a later one) and link the switch to
      // the label so HomeKit renders them as one remote. The label exists exactly when the fob is grouped, so a kept or attached index always has one to link to.
      if(serviceLabel && ((transition === "attached") || (transition === "kept"))) {

        service.updateCharacteristic(this.hap.Characteristic.ServiceLabelIndex, button.index);
        serviceLabel.addLinkedService(service);
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

      // Resolve this button's switch; skip it when absent - hidden by its feature option.
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
  private configureBatteryService(): void {

    // Acquire the service.
    this.acquireService({ serviceType: this.hap.Service.Battery });

    // Initialize the battery state.
    this.updateBatteryStatus();
  }

  // Update the battery status in HomeKit. The fob's battery lives under wirelessConnectionState.batteryStatus (the LoRa link telemetry), NOT the top-level batteryStatus
  // a wired sensor reads - so the read path is nested here. Both reads are non-throwing: an absent record reports a full, not-low battery rather than throwing.
  private updateBatteryStatus(): void {

    // Find the battery service, if it exists.
    const batteryService = this.accessory.getService(this.hap.Service.Battery);

    // Read the nested battery facts non-throwing, defaulting a fob in the removal grace to a full, not-low battery.
    const isLow = this.fromRecord((config) => config.wirelessConnectionState.batteryStatus.isLow, false);
    const percentage = this.fromRecord((config) => config.wirelessConnectionState.batteryStatus.percentage ?? 0, 0);

    // Update the battery status.
    batteryService?.updateCharacteristic(this.hap.Characteristic.BatteryLevel, percentage);
    batteryService?.updateCharacteristic(this.hap.Characteristic.StatusLowBattery, isLow);
  }

  // Spawn the fob's narrow-selector observers. super spawns the universal observers (name sync and firmware/device-info refresh); the fob adds battery observers, one per
  // battery field, each waking only on its own slice through the store's reference dedup and delegating to the shared battery updater, and - for a recognized model - a
  // button-label observer that reconciles the button names when the controller's active labeling changes. Button PRESSES have no observers: they are firehose occurrences
  // delivered by the event-dispatch router, not device-state fields observed here.
  protected override spawnObservers(): void {

    super.spawnObservers();

    const fob = this.nvr.client.state.selectors.fob.byId(this.device.id);

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
