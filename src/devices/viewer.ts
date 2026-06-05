/* Copyright(C) 2019-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-viewer.ts: Viewer device class for UniFi Protect.
 */
import type { CharacteristicValue, PlatformAccessory, Service } from "homebridge";
import type { ProtectViewerConfig, Viewer } from "unifi-protect";
import { selectLiveviews, selectViewer } from "unifi-protect";
import type { Nullable } from "homebridge-plugin-utils";
import { ProtectDevice } from "./device.ts";
import type { ProtectNvr } from "../nvr.ts";

export class ProtectViewer extends ProtectDevice {

  // Narrow the inherited projection handle to the viewer projection so the read-through config getter resolves to ProtectViewerConfig.
  declare protected readonly device: Viewer;

  // Create an instance.
  constructor(nvr: ProtectNvr, accessory: PlatformAccessory, device: Viewer) {

    super(nvr, accessory, device);

    this.configureHints();
    this.configureDevice();
    this.spawnObservers();
  }

  // Read-through config, narrowed to the viewer projection's config record.
  public override get ufp(): Readonly<ProtectViewerConfig> {

    return this.device.config;
  }

  // Initialize and configure the viewer accessory for HomeKit.
  private configureDevice(): boolean {

    // Clean out the context object in case it's been polluted somehow.
    this.accessory.context = {};
    this.accessory.context.mac = this.ufp.mac;
    this.accessory.context.nvr = this.nvr.ufp.mac;

    // Configure accessory information.
    this.configureInfo();

    // Configure accessory services.
    const enabledLiveviews = this.updateDevice(true);

    // Configure MQTT services.
    this.configureMqtt();

    // Inform the user what we're enabling on startup.
    if(enabledLiveviews.length) {

      this.log.info("Configured liveview%s: %s.", enabledLiveviews.length > 1 ? "s" : "", enabledLiveviews.join(", "));
    }  else {

      this.log.info("No liveviews configured.");
    }

    return true;
  }

  // Update accessory services and characteristics.
  public updateDevice(configureHandlers = false): string[] {

    // Grab the current list of liveview switches we know about.
    const currentLiveviewSwitches = this.accessory.services.filter(x => (x.UUID === this.hap.Service.Switch.UUID) && x.subtype);

    // Grab the current list of liveview identifiers from the controller, read through the live v5 projection. client.liveviews is always an array, so the list operations
    // below need no presence guard.
    const nvrLiveviewIds = this.nvr.client.liveviews.map(x => x.id);

    // Identify what's been removed on the controller and remove it from the accessory as well.
    for(const service of currentLiveviewSwitches.filter(x => !nvrLiveviewIds.includes(x.subtype ?? ""))) {

      this.accessory.removeService(service);
    }

    // Identify what needs to be added to HomeKit that isn't already there, and add them.
    this.addLiveviewSwitch(nvrLiveviewIds.filter(x => !currentLiveviewSwitches.filter(liveviewSwitch => liveviewSwitch.subtype === x).length));

    // Finally, reflect the state of the liveview that's currently enabled. We loop through the list of services on our viewer accessory and sync the liveview switches.
    this.updateLiveviewSwitchState(configureHandlers);

    // Return a list of our available liveviews for this device.
    return this.accessory.services.filter(x => (x.UUID === this.hap.Service.Switch.UUID) && x.subtype).map(x => x.displayName);
  }

  // Update the state of liveview switches for viewer devices.
  private updateLiveviewSwitchState(configureHandlers = false): boolean {

    for(const switchService of this.accessory.services) {

      // We only want to look at switches.
      if(switchService.UUID !== this.hap.Service.Switch.UUID) {

        continue;
      }

      // We only want switches with subtypes.
      if(!switchService.subtype) {

        continue;
      }

      // Configure the switch and update the state.
      this.configureLiveviewSwitch(switchService, configureHandlers);
    }

    return true;
  }

  // Configure the state and handlers of a liveview switch.
  private configureLiveviewSwitch(switchService: Service, configureHandlers = true): boolean {

    // If we're configuring a switch for the first time, we add our respective handlers.
    if(configureHandlers) {

      // Turn the liveview switch on or off.
      switchService.getCharacteristic(this.hap.Characteristic.On).onGet(() => {

        return this.getLiveviewSwitchState(switchService);
      });

      switchService.getCharacteristic(this.hap.Characteristic.On).onSet(async (value: CharacteristicValue) => {

        return this.setLiveviewSwitchState(switchService, value);
      });
    }

    // Set the state to reflect Protect.
    switchService.updateCharacteristic(this.hap.Characteristic.On, switchService.subtype === this.ufp.liveview);

    return true;
  }

  // Return the current state of the liveview switch.
  private getLiveviewSwitchState(switchService: Service): CharacteristicValue {

    return (this.ufp.liveview !== null) && (this.ufp.liveview === switchService.subtype);
  }

  // Set the current state of the liveview switch.
  private async setLiveviewSwitchState(switchService: Service, value: CharacteristicValue): Promise<void> {

    const viewState = value === true ? switchService.subtype ?? null : null;
    const action = viewState ? "set the liveview to " + switchService.displayName : "clear the liveview";

    // setViewer reports any failure through the shared command-error helper, naming this operation via the action phrase, so we only handle the success side-effect here.
    if(!(await this.setViewer(action, viewState))) {

      return;
    }

    // Update all the other liveview switches.
    this.updateLiveviewSwitchState();
  }

  // Add liveview switches to HomeKit for viewer devices.
  private addLiveviewSwitch(newLiveviewIds: string[]): boolean {

    // Loop through the list of liveview identifiers and add them to HomeKit as switches.
    for(const liveviewId of newLiveviewIds) {

      // Empty or invalid liveview identifier.
      if(!liveviewId) {

        continue;
      }

      // Retrieve the name assigned to this liveview.
      const liveviewName = this.nvr.client.liveviews.find(x => x.id === liveviewId)?.name;

      // Acquire the service.
      const service = this.acquireService(this.hap.Service.Switch, liveviewName, liveviewId);

      // Fail gracefully.
      if(!service) {

        this.log.error("Unable to add liveview switch: %s.", liveviewName);

        return false;
      }

      this.configureLiveviewSwitch(service);
    }

    return true;
  }

  // Set the liveview on a viewer device in UniFi Protect. Returns true when the controller accepted the command. The action phrase is supplied by the caller so the
  // shared command-error helper can name the specific operation (a switch toggle versus an MQTT set) in any failure it reports, and the liveview-name MQTT event is
  // published only once the controller has accepted the change rather than unconditionally as the v4 path did.
  private async setViewer(action: string, newLiveview: Nullable<string>): Promise<boolean> {

    if(!(await this.runDeviceCommand(action, () => this.device.update({ liveview: newLiveview })))) {

      return false;
    }

    // Find the liveview name and publish the MQTT event now that the change has been accepted.
    const liveview = this.nvr.client.liveviews.find(x => x.id === newLiveview);

    if(liveview) {

      this.publish("liveview", liveview.name);
    }

    return true;
  }

  // Configure MQTT capabilities of this viewer.
  private configureMqtt(): boolean {

    // Get the current liveview state via MQTT.
    this.subscribeGet("liveview", "liveview", () => {

      return this.nvr.client.liveviews.find(x => x.id === this.ufp.liveview)?.name ?? "None";
    });

    // Set the liveview state via MQTT.
    this.subscribeSet("liveview", "liveview", async (value: string) => {

      const liveview = this.nvr.client.liveviews.find(x => x.name.toLowerCase() === value);

      if(!liveview) {

        this.log.error("Unable to locate a liveview named %s.", value);

        return;
      }

      // setViewer reports any failure through the shared command-error helper, naming the MQTT operation via the action phrase; on success we confirm the change.
      if(!(await this.setViewer("set the liveview via MQTT to " + liveview.name, liveview.id))) {

        return;
      }

      this.log.info("Liveview set via MQTT to %s.", liveview.name);
    });

    return true;
  }

  // Spawn the viewer's narrow-selector observers (Fork B). super spawns the universal name-sync observer; the viewer adds its single state reaction.
  protected override spawnObservers(): void {

    super.spawnObservers();

    const viewer = selectViewer(this.ufp.id);

    // The viewer's active liveview drives which liveview switch reads on. This observe reflects only the active selection - the single switch that shows as on - by
    // re-running updateLiveviewSwitchState; the set of switches itself is reconciled by the liveview-collection observe below.
    this.observeState({ key: "viewer.liveview", selector: state => viewer(state)?.liveview, title: "the active live view" }, () => this.updateLiveviewSwitchState());

    // The controller's liveview collection drives which switches this viewer exposes. Re-run the full reconcile when it changes - restoring the per-refresh
    // viewer.updateDevice the v4 syncDevices loop ran. (The viewer.liveview observe above handles the active-selection reflection.)
    this.observeState({ key: "nvr.liveviews", selector: selectLiveviews, title: "the live view list" }, () => this.updateDevice());
  }
}
