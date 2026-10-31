/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * liveviews.ts: Liveviews class for UniFi Protect.
 */
import { PLATFORM_NAME, PLUGIN_NAME } from "../settings.ts";
import type { ProtectAccessory, ProtectAccessoryContext } from "../types.ts";
import { ProtectBase, configured } from "../devices/device-base.ts";
import { acquireService, membershipDelta, sanitizeName } from "homebridge-plugin-utils";
import type { CharacteristicValue } from "homebridge";
import type { Nullable } from "homebridge-plugin-utils";
import type { ProtectNvr } from "../nvr/nvr.ts";
import type { ProtectNvrLiveviewConfig } from "unifi-protect";
import { ProtectReservedNames } from "../types.ts";
import { ProtectSecuritySystem } from "./security-system.ts";
import { deviceDisplayName } from "../devices/device-descriptor.ts";
import { isolateAccessoryChange } from "../nvr/nvr-accessory-change.ts";
import { mqttTopics } from "../mqtt.ts";
import { selectLiveviews } from "unifi-protect";

// The liveviews the security system is built from. Any one of them calls for it, so they all collapse onto its one identity.
const SECURITY_SYSTEM_LIVEVIEW = /^Protect-(Away|Home|Night|Off)$/i;

// The liveviews that call for a switch: views beginning with Protect- whose name is not reserved for the security system. The capture is the switch's view name.
const LIVEVIEW_SWITCH = /^Protect-((?!Away$|Off$|Home$|Night$).+)$/i;

export class ProtectLiveviews extends ProtectBase {

  private isConfigured: Set<string>;
  private isMqttConfigured: boolean;
  private securityAccessory: Nullable<ProtectAccessory>;
  private securitySystem: Nullable<ProtectSecuritySystem>;

  // Create an instance.
  constructor(nvr: ProtectNvr) {

    super(nvr);

    this.isConfigured = new Set();
    this.isMqttConfigured = false;
    this.securityAccessory = null;
    this.securitySystem = null;
  }

  // Configure our liveviews capability.
  public override configure(): void {

    // Subject owns its reactivity: observe the controller's liveview collection and reconcile the liveview-derived accessories on each change. The store yields only on
    // change, so the initial population is seeded once by the NVR after device discovery (a liveview switch restores motion state onto its member cameras, which must
    // exist first); this observer handles every subsequent edit. It binds to the controller lifetime via ProtectBase.observeSignal.
    this.observeState({ key: "nvr.liveviews", selector: selectLiveviews, title: "live views" }, () => this.configureLiveviews());
  }

  // Read-through of the controller's live liveview collection. Every read reflects the current projection, so a liveview added, renamed, or removed in Protect is
  // visible the moment the NVR-level observe loop reconciles, with no field to reassign. Always an array post-connect.
  private get liveviews(): readonly ProtectNvrLiveviewConfig[] {

    return this.nvr.client.liveviews;
  }

  // Whether a platform accessory is a liveview switch this controller owns. Liveview accessories are scoped to their owning controller by the context MAC written at
  // reconcile time, so on a multi-controller install this owner reconciles, removes, and addresses only its own switches and never another controller's. This is the
  // one home for the scoping rule, consumed by the switch reconcile's membership delta and the MQTT get and set lookups.
  private isOwnedLiveviewSwitch(accessory: ProtectAccessory): boolean {

    return ("liveview" in accessory.context) && (accessory.context.nvr === this.nvr.ufp.mac);
  }

  /* The liveview switches the controller's liveviews call for, keyed by identity: the upper-cased view name, onto which every liveview of that name collapses, so
   * liveviews that share a name share one switch. Each identity carries the view name as the first such liveview spells it, which the switch is named with. The
   * switch reconcile diffs these identities against the switches this controller owns, and each pending removal re-reads them when its grace ends.
   */
  private get liveviewSwitchNames(): Map<string, string> {

    const names = new Map<string, string>();

    for(const liveview of this.liveviews) {

      const viewName = LIVEVIEW_SWITCH.exec(liveview.name)?.[1];

      if(!viewName || names.has(viewName.toUpperCase())) {

        continue;
      }

      names.set(viewName.toUpperCase(), viewName);
    }

    return names;
  }

  // Every liveview switch this controller owns with its current state, as the MQTT topic carries the whole list. The get answers it and the session restatement
  // publishes it, so the get and the restatement read one derivation.
  private get liveviewsPayload(): string {

    const liveviews = this.platform.accessories.filter(x => this.isOwnedLiveviewSwitch(x))
      .map(x => ({ name: x.context.liveview ?? "", state: x.getService(this.hap.Service.Switch)?.getCharacteristic(this.hap.Characteristic.On).value }));

    return JSON.stringify(liveviews);
  }

  // Reconcile the liveview-derived accessories against the controller's current liveview collection. The NVR-level observe loop drives this on each change to the live
  // liveview projection, and once at startup for the initial population.
  public configureLiveviews(): void {

    this.configureSecuritySystem();
    this.configureSwitches();
    this.configureMqtt();
  }

  // Configure the security system accessory.
  private configureSecuritySystem(): void {

    const uuid = this.hap.uuid.generate(this.nvr.ufp.mac + ".Security");
    const isCalledFor = (): boolean => this.liveviews.some(x => SECURITY_SYSTEM_LIVEVIEW.test(x.name));
    const present = this.securityAccessory ?? this.platform.accessories.find(x => x.UUID === uuid);

    /* The membership delta over the security system's one identity. Every plugin-specific liveview projects onto the accessory's UUID, and the accessory present is the
     * one this owner built or the one Homebridge restored from its cache, so an accessory whose liveviews were deleted while Homebridge was down is found here too.
     *
     * The user removed the last plugin-specific liveview: the removal goes through the controller's removal gate, which waits for the controller to be stable and for
     * the user's removal delay, then re-reads the liveviews before it acts. Until then the security system stays as it is, its MQTT handlers still answering.
     */
    const { toRemove } = membershipDelta(isCalledFor() ? [uuid] : [], present ? [present.UUID] : []);

    if(present && toRemove.length) {

      this.nvr.removals.schedule({ accessory: present,
        reason: "No plugin-specific liveviews found. Disabling the security system accessory associated with this UniFi Protect controller.",
        remove: () => this.removeSecuritySystem(present), stillGone: () => !isCalledFor() });

      return;
    }

    if(!isCalledFor()) {

      return;
    }

    // A plugin-specific liveview calls for the security system, so a removal an earlier pass scheduled, if any, is cancelled.
    this.nvr.removals.cancelFor(uuid);

    /* Add the security system when we hold none, its accessory's creation and the instance on it together, through the shared isolation: a bridge already holding as
     * many accessories as HomeKit allows refuses the registration with a throw, and every caller is a pass a throw would cost far more than the security system - the
     * startup liveviews reconcile inside login(), the liveviews observer's loop, and the stability sweep's timer. A failed add leaves the instance null, so the next
     * liveviews reconcile retries it.
     */
    this.securitySystem ??= isolateAccessoryChange({ act: "add", change: () => this.#addSecuritySystem(uuid), log: this.log, name: "the security system" });

    if(!this.securitySystem) {

      return;
    }

    // Update our NVR reference, and save the accessory's context.
    this.platform.persistence.persist(this.securitySystem.accessory, { nvr: this.nvr.ufp.mac });

    // Refresh the available arm states from the current liveview collection, so adding or removing a Protect-Away/Home/Night liveview re-scopes the security system's
    // valid target states. The owner drives this on every reconcile because it owns the security accessory's lifecycle and its refresh.
    this.securitySystem.updateDevice();
  }

  /* Find or create the security system's accessory, registering one it creates, and stand the security system up on it. The accessory is held only once its
   * registration returns, so a registration that throws leaves none held and the retry creates it afresh rather than configuring an accessory HomeKit never took. The
   * instance is returned only once configured() returns, so one whose setup threw is released there, and the retry reuses the accessory held here.
   */
  #addSecuritySystem(uuid: string): ProtectSecuritySystem {

    // Create the security system accessory if it doesn't already exist.
    if(!this.securityAccessory) {

      // See if we already have this accessory defined.
      let accessory = this.platform.accessories.find(x => x.UUID === uuid);

      if(!accessory) {

        // We will use the NVR MAC address + ".Security" to create our UUID. That should provide the guaranteed uniqueness we need.
        accessory = new this.api.platformAccessory<ProtectAccessoryContext>(deviceDisplayName(this.nvr.ufp), uuid);

        // Register this accessory with homebridge and add it to the platform accessory array so we can track it.
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.platform.accessories.push(accessory);
      }

      this.securityAccessory = accessory;
      this.log.info("Plugin-specific liveviews have been detected. Enabling the security system accessory.");
    }

    // We have the security system accessory, now let's configure it.
    return configured(new ProtectSecuritySystem(this.nvr, this.securityAccessory));
  }

  // Remove the security system, the removal a granted removal-gate decision runs. Its MQTT registrations are released before the instance is dropped, so its get and
  // set handlers no longer command this controller's cameras once its accessory is gone, and a later re-add builds a fresh instance that subscribes anew. The accessory
  // leaves through the shared removal tail, which unregisters a bridged accessory and splices it out of the platform list.
  private removeSecuritySystem(accessory: ProtectAccessory): void {

    this.securitySystem?.cleanup();
    this.securityAccessory = null;
    this.securitySystem = null;
    this.nvr.removeAccessoryFromHomeKit(accessory);
  }

  // Configure any liveview-associated switches.
  private configureSwitches(): void {

    const identity = (accessory: ProtectAccessory): string => (accessory.context.liveview ?? "").toUpperCase();
    const names = this.liveviewSwitchNames;

    /* The membership delta over the switch identities: a switch this controller owns that no liveview calls for any longer - its liveview was removed or renamed on the
     * controller, whether this session or while Homebridge was down - is removed through the controller's removal gate, which waits for the controller to be stable and
     * for the user's removal delay, then re-reads the liveviews before it acts. Until then the switch stays, its MQTT get and set still answering. We diff a filtered
     * SNAPSHOT of this controller's own switches (the scoping predicate keys on the context MAC), so the reconcile never disturbs another controller's switches and a
     * removal splice never races an iterator walking the live list.
     */
    const owned = this.platform.accessories.filter(x => this.isOwnedLiveviewSwitch(x));
    const toRemove = new Set(membershipDelta([...names.keys()], owned.map(identity)).toRemove);

    for(const accessory of owned.filter(x => toRemove.has(identity(x)))) {

      const id = identity(accessory);

      this.nvr.removals.schedule({ accessory,
        reason: "Removing plugin-specific liveview switch: " + (accessory.context.liveview ?? "") + ". The liveview has been either removed or renamed in UniFi Protect.",
        remove: () => {

          // Forget the configured name and remove the accessory through the shared removal tail, which unregisters a bridged accessory and splices it out of the
          // platform list.
          this.isConfigured.delete(id);
          this.nvr.removeAccessoryFromHomeKit(accessory);
        },
        stillGone: () => !this.liveviewSwitchNames.has(id) });
    }

    // Configure every switch the liveviews call for. By design, liveviews of the same name share a single switch, which the identity projection above provides.
    for(const [ id, viewName ] of names) {

      // We use the NVR MAC address + ".Liveview." + viewname to create our unique UUID for our switches.
      const uuid = this.hap.uuid.generate(this.nvr.ufp.mac + ".Liveview." + id);

      // A liveview calls for this switch, so a removal an earlier pass scheduled, if any, is cancelled.
      this.nvr.removals.cancelFor(uuid);

      if(this.isConfigured.has(id)) {

        continue;
      }

      // Each switch is added through the shared isolation, so a switch that cannot be added, a full bridge refusing its registration among the causes, costs the
      // switches behind it and the pass running this reconcile nothing. A failed switch is not marked configured, so the next liveviews reconcile retries it.
      isolateAccessoryChange({ act: "add", change: () => this.#addLiveviewSwitch({ uuid, viewName }), log: this.log, name: "the " + viewName + " liveview switch" });
    }
  }

  /* Find or create one liveview switch's accessory, registering one it creates, and configure the switch on it, marking the switch configured once it stands.
   *
   * @param options          - The switch to add.
   * @param options.uuid     - The UUID of the switch's accessory.
   * @param options.viewName - The view name the switch carries, as the first liveview of its identity spells it.
   */
  #addLiveviewSwitch({ uuid, viewName }: { uuid: string; viewName: string }): void {

    // Check to see if the accessory already exists before we create it.
    let liveviewState = true;
    let newAccessory;

    if((newAccessory = this.platform.accessories.find(x => x.UUID === uuid)) === undefined) {

      // The switch is named for its controller and its view together, the join rendering an absent controller name as nothing, and the whole name is sanitized at
      // once, so a character HomeKit refuses only at a name's end stays when the view name follows it. Only a switch whose controller and view names each sanitize to
      // nothing takes the controller's display name, because HAP refuses an accessory whose display name is empty.
      const switchName = sanitizeName([ this.nvr.ufp.name, viewName ].join(" ")) || deviceDisplayName(this.nvr.ufp);

      newAccessory = new this.api.platformAccessory<ProtectAccessoryContext>(switchName, uuid);

      // Register this accessory with homebridge and add it to the platform accessory array so we can track it.
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [newAccessory]);
      this.platform.accessories.push(newAccessory);
    }

    // Configure our accessory.
    if("liveviewState" in newAccessory.context) {

      liveviewState = newAccessory.context.liveviewState ?? false;
    }

    // Rewrite the context from a clean slate, marking the accessory as one the liveviews owner derives so the controller's device removal passes leave it to us, and
    // save it.
    newAccessory.context = {};
    this.platform.persistence.persist(newAccessory, { liveview: viewName, liveviewDerived: true, liveviewState, nvr: this.nvr.ufp.mac });

    // Acquire the liveview switch under the accessory's name, marking the accessory for the next save when the switch is new to it. HBPU's helper names a new
    // switch in every name characteristic its kind supports, the one the Home app edits included, and leaves the names of a switch the accessory already carries
    // as they stand.
    const { service: switchService, transition } = acquireService({ accessory: newAccessory, name: newAccessory.displayName, serviceType: this.hap.Service.Switch });

    if(transition === "attached") {

      this.platform.persistence.persist(newAccessory);
    }

    // Activate or deactivate motion detection.
    switchService.getCharacteristic(this.hap.Characteristic.On)
      .onGet(this.getSwitchState.bind(this, newAccessory.context.liveview ?? ""))
      .onSet(this.setSwitchState.bind(this, newAccessory));

    // Initialize the switch. We keep a saved liveview switch state because we want to account for edge cases where liveviews can disappear and we end up in a
    // situation where motion detection is disabled without a way to enable it. By saving the switch state on the accessory, we can always initialize all
    // motion-related accessories at startup as having motion enabled, and explicitly disable them here at startup when we restore state.
    switchService.updateCharacteristic(this.hap.Characteristic.On, liveviewState);
    this.setSwitchState(newAccessory, liveviewState);
    this.isConfigured.add((newAccessory.context.liveview ?? "").toUpperCase());

    // Inform the user.
    this.log.info("Configuring plugin-specific liveview switch: %s.", viewName);
  }

  // Configure MQTT capabilities for the liveview switches.
  private configureMqtt(): void {

    if(this.isMqttConfigured) {

      return;
    }

    this.isMqttConfigured = true;

    // Return the current status of all the liveviews.
    this.subscribeGet(mqttTopics.liveviews.topic, mqttTopics.liveviews.label, () => this.liveviewsPayload);

    // Restate the whole list at the start of every later broker session. The owner is built in the same synchronous run that creates the MQTT client, so no session is
    // held as it is built and it states nothing more then; registering behind the guard above keeps it to one registration however often the liveviews reconfigure.
    this.restateOnConnect(() => this.publish(mqttTopics.liveviews.topic, this.liveviewsPayload));

    // Set the status of one or more liveviews.
    this.subscribeSet(mqttTopics.liveviews.topic, mqttTopics.liveviews.label, (_value: string, rawValue: string) => {

      interface mqttLiveviewJSON {

        name: string;
        state: unknown;
      }

      let incomingPayload: unknown;

      // Catch any errors in parsing what we get over MQTT.
      try {

        incomingPayload = JSON.parse(rawValue);
      } catch {

        this.log.error("Unable to process MQTT message: \"%s\". Invalid JSON.", rawValue);

        // Errors mean that we're done now.
        return;
      }

      // The payload must be a non-empty array of liveview entries. A top-level null, primitive, or object is the same handled failure as malformed JSON - we reject it
      // here rather than reaching the length read on a non-array value.
      if(!Array.isArray(incomingPayload) || !incomingPayload.length) {

        this.log.error("Unable to process MQTT message: \"%s\". The payload contained no liveviews.", rawValue);

        return;
      }

      // Update state on the liveviews. The array check above confirms the payload's outer shape; individual entries are trusted as mqttLiveviewJSON without a
      // per-entry shape guard, so a malformed entry (a missing name) surfaces as an unhandled exception rather than the validation error above.
      for(const entry of incomingPayload as mqttLiveviewJSON[]) {

        // Lookup this controller's liveview matching the requested name.
        const accessory = this.platform.accessories.find(x => this.isOwnedLiveviewSwitch(x) && ((x.context.liveview ?? "").toUpperCase() === entry.name.toUpperCase()));

        // If we can't find it, move on.
        if(!accessory) {

          continue;
        }

        // Drive the switch's own onSet with the coerced state so the scene actually applies to the member cameras, exactly as a HomeKit tap would - a status-only
        // updateCharacteristic never runs the handler and cannot apply a scene.
        accessory.getService(this.hap.Service.Switch)?.setCharacteristic(this.hap.Characteristic.On, !!entry.state);
        this.log.info("Liveview scene updated via MQTT: %s.", accessory.context.liveview);
      }
    });
  }

  // Toggle the liveview switch state.
  private setSwitchState(liveviewSwitch: ProtectAccessory, targetState: CharacteristicValue): void {

    // We don't have any liveviews or we're already at this state - we're done.
    if(!this.liveviews.length || (this.getSwitchState(liveviewSwitch.context.liveview ?? "") === targetState)) {

      return;
    }

    // Resolve the member camera ids for this liveview.
    const targetCameraIds = this.getLiveviewCameras(liveviewSwitch.context.liveview ?? "");

    // Nothing configured for this view. We're done.
    if(!targetCameraIds.length) {

      return;
    }

    // Iterate through the cameras in this liveview.
    for(const targetCameraId of targetCameraIds) {

      const protectDevice = this.nvr.getDeviceById(targetCameraId);

      // No camera found or we're already at the target state - we're done.
      if(!protectDevice || (protectDevice.accessory.context.detectMotion === targetState)) {

        continue;
      }

      // Update the member camera's motion-sensor switch, if it exists. We target the SWITCH_MOTION_SENSOR subtype so the write always lands on the motion switch and
      // never on some other Switch service that happens to sit first on the camera accessory.
      protectDevice.accessory.getServiceById(this.hap.Service.Switch, ProtectReservedNames.SWITCH_MOTION_SENSOR)?.
        updateCharacteristic(this.hap.Characteristic.On, targetState);

      // Set the motion detection state. We do this after setting any motion detection switch in order to ensure we fire events in the right order for the motion
      // detection switch.
      this.platform.persistence.persist(protectDevice.accessory, { detectMotion: !!targetState });

      // Inform the user.
      this.log.info("%s -> %s: Motion detection %s.", liveviewSwitch.context.liveview, protectDevice.accessoryName,
        protectDevice.accessory.context.detectMotion ? "enabled" : "disabled");
    }

    // Save our new state.
    this.platform.persistence.persist(liveviewSwitch, { liveviewState: !!targetState });

    // Publish to MQTT, if configured.
    this.publish(mqttTopics.liveviews.topic, JSON.stringify([{ name: liveviewSwitch.context.liveview ?? "", state: targetState }]));
  }

  // Get the current liveview switch state.
  private getSwitchState(liveviewName: string): boolean {

    // Get the list of unique motion-detection states across this liveview's cameras. A camera we cannot resolve to a managed accessory yields `undefined`, which we
    // deliberately keep as a distinct state so the switch reads off - a signal that this user-grouped liveview references a camera that is missing or offline.
    const detectedStates = [...new Set(this.getLiveviewCameras(liveviewName).map(x => this.nvr.getDeviceById(x)?.accessory.context.detectMotion))];

    // If we have more than one element in the array or an empty array (meaning we don't have a liveview we know about),
    // we don't have consistent states across all the devices, so we assume it's false.
    if(detectedStates.length !== 1) {

      return false;
    }

    // Return the state we've detected. An all-unresolvable liveview leaves the lone element undefined; we report off, consistent with the missing-camera signal above.
    return detectedStates[0] ?? false;
  }

  // Get the devices associated with a particular liveview.
  private getLiveviewCameras(liveviewName: string): string[] {

    // Collect every camera across every liveview matching this name - Protect allows multiple liveviews with the same name, so this returns the union of their
    // member cameras rather than assuming a single match.
    return this.liveviews.filter(view => view.name.toUpperCase() === ("Protect-" + liveviewName).toUpperCase())
      .map(view => view.slots.map(slots => slots.cameras)).flat(2);
  }
}
