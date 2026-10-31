/* Copyright(C) 2019-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * viewer.ts: Viewer device class for UniFi Protect.
 */
import type { CharacteristicValue, Service } from "homebridge";
import type { Nullable } from "homebridge-plugin-utils";
import type { ProtectConfigurePass } from "./device.ts";
import { ProtectDevice } from "./device.ts";
import type { Viewer } from "unifi-protect";
import { membershipDelta } from "homebridge-plugin-utils";
import { mqttTopics } from "../mqtt.ts";
import { selectLiveviews } from "unifi-protect";

export class ProtectViewer extends ProtectDevice<Viewer> {

  // The viewer's currently-active liveview id, read non-throwing through the record. An absent record (a viewer lingering in the removal grace) reports no active
  // liveview rather than throwing; the switch state, the onGet, and the MQTT getValue all read this single source.
  private get activeLiveview(): Nullable<string> {

    return this.fromRecord((config) => config.liveview, null);
  }

  // Initialize and configure the viewer accessory for HomeKit.
  protected override configureDevice(): boolean {

    // Reset the persisted context to a clean slate and reseed identity. Homebridge persists this context across restarts, so a viewer recovered from an earlier plugin
    // version, or one whose UUID HomeKit reused for a different device, can still carry stale keys; resetting keeps key presence a reliable signal for this accessory's
    // current contract. The viewer persists no user state on the device-leaf context, so nothing is preserved across the reset.
    this.resetAccessoryContext();

    // Configure accessory information.
    this.configureInfo();

    // Configure accessory services.
    const enabledLiveviews = this.updateDevice({ initialized: false });

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

  // Update accessory services and characteristics. The first pass binds the handlers of every liveview switch, a switch restored from the accessory cache included,
  // and a later pass binds only the switches it adds.
  public updateDevice({ initialized }: Required<Pick<ProtectConfigurePass, "initialized">>): string[] {

    // Grab the current list of liveview switches we know about.
    const currentLiveviewSwitches = this.accessory.services.filter(x => (x.UUID === this.hap.Service.Switch.UUID) && x.subtype);

    // Compare the controller's current liveview identifiers, read through the live projection, against the liveview each switch's subtype names. client.liveviews is
    // always an array, so the comparison needs no presence guard.
    const { toAdd, toRemove } = membershipDelta(this.nvr.client.liveviews.map(x => x.id), currentLiveviewSwitches.map(x => x.subtype ?? ""));

    // Remove the switches whose liveview the controller no longer lists, marking the accessory for the next save, then add a switch for each liveview it newly lists.
    for(const service of currentLiveviewSwitches.filter(x => toRemove.includes(x.subtype ?? ""))) {

      this.removeService(service);
    }

    this.addLiveviewSwitch(toAdd);

    // Finally, reflect the state of the liveview that's currently enabled. We loop through the list of services on our viewer accessory and sync the liveview switches.
    this.updateLiveviewSwitchState({ initialized });

    // Return a list of our available liveviews for this device.
    return this.accessory.services.filter(x => (x.UUID === this.hap.Service.Switch.UUID) && x.subtype).map(x => x.displayName);
  }

  // Update the state of liveview switches for viewer devices.
  private updateLiveviewSwitchState({ initialized }: Required<Pick<ProtectConfigurePass, "initialized">>): boolean {

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
      this.configureLiveviewSwitch(switchService, { initialized });
    }

    return true;
  }

  // Configure the state and handlers of a liveview switch.
  private configureLiveviewSwitch(switchService: Service, { initialized }: Required<Pick<ProtectConfigurePass, "initialized">>): boolean {

    // If we're configuring a switch for the first time, we add our respective handlers.
    if(!initialized) {

      // Turn the liveview switch on or off.
      switchService.getCharacteristic(this.hap.Characteristic.On).onGet(() => {

        return this.getLiveviewSwitchState(switchService);
      });

      switchService.getCharacteristic(this.hap.Characteristic.On).onSet(async (value: CharacteristicValue) => {

        return this.setLiveviewSwitchState(switchService, value);
      });
    }

    // Set the state to reflect Protect.
    switchService.updateCharacteristic(this.hap.Characteristic.On, switchService.subtype === this.activeLiveview);

    return true;
  }

  // Return the current state of the liveview switch.
  private getLiveviewSwitchState(switchService: Service): CharacteristicValue {

    const liveview = this.activeLiveview;

    return (liveview !== null) && (liveview === switchService.subtype);
  }

  // Set the current state of the liveview switch.
  private async setLiveviewSwitchState(switchService: Service, value: CharacteristicValue): Promise<void> {

    const viewState = value === true ? switchService.subtype ?? null : null;
    const action = viewState ? "set the liveview to " + switchService.displayName : "clear the liveview";

    // setViewer reports any failure through the shared command-error helper, naming this operation via the action phrase. On success we do NOT re-read the switch layout
    // synchronously: the tapped switch's own On value is HAP's post-onSet write, and every OTHER switch reflects when the viewer.liveview observer sees the controller's
    // broadcast - the same shape the MQTT set path already has. The projection's update() is write-through and never folds the command into the store, so a synchronous
    // re-read here would re-assert the pre-command state that the observer will correctly replace once the broadcast lands.
    await this.setViewer(action, viewState);
  }

  // Add liveview switches to HomeKit for viewer devices.
  private addLiveviewSwitch(newLiveviewIds: string[]): void {

    // Loop through the list of liveview identifiers and add them to HomeKit as switches.
    for(const liveviewId of newLiveviewIds) {

      // Empty or invalid liveview identifier.
      if(!liveviewId) {

        continue;
      }

      // Retrieve the name assigned to this liveview.
      const liveviewName = this.nvr.client.liveviews.find(x => x.id === liveviewId)?.name;

      // Acquire the service, named for its liveview, which is controller data, so the switch carries a name of its own: the viewer's name stands in only for a
      // liveview the controller names nothing.
      const { service } = this.acquireService({ name: liveviewName ?? this.accessoryName, serviceType: this.hap.Service.Switch, subtype: liveviewId });

      this.configureLiveviewSwitch(service, { initialized: false });
    }
  }

  // Set the liveview on a viewer device in UniFi Protect. Returns true when the controller accepted the command. The action phrase is supplied by the caller so the
  // shared command-error helper can name the specific operation (a switch toggle versus an MQTT set) in any failure it reports. The liveview topic follows the
  // controller's reported change rather than the command, so the observers publish it once the controller's broadcast lands.
  private async setViewer(action: string, newLiveview: Nullable<string>): Promise<boolean> {

    if(!(await this.runDeviceCommand(action, () => this.device.update({ liveview: newLiveview })))) {

      return false;
    }

    return true;
  }

  // The active liveview's name, or "None" when the viewer shows none, which is what the liveview topic carries on its get and its state publish alike.
  private get activeLiveviewName(): string {

    return this.nvr.client.liveviews.find(x => x.id === this.activeLiveview)?.name ?? "None";
  }

  // Publish the active liveview's name when it changed. Each observer that can move the name calls this, the viewer's own liveview and the controller's list, which
  // carries a rename of the active one. A dispatch that wakes them together states the name once, because the second statement of an unchanged name is not sent.
  private publishLiveviewState(): void {

    this.publishState(mqttTopics.liveview.topic, this.activeLiveviewName);
  }

  // Configure MQTT capabilities of this viewer.
  private configureMqtt(): boolean {

    // Get the current liveview state via MQTT.
    this.subscribeGet(mqttTopics.liveview.topic, mqttTopics.liveview.label, () => {

      return this.activeLiveviewName;
    });

    // Set the liveview state via MQTT.
    this.subscribeSet(mqttTopics.liveview.topic, mqttTopics.liveview.label, async (value: string) => {

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

    // State the active liveview as the viewer is set up, since its setup publishes nothing else, and again at the start of every later broker session, through the
    // method its observers publish with.
    this.publishLiveviewState();
    this.restateOnConnect(() => this.publishLiveviewState());

    return true;
  }

  // Spawn the viewer's narrow-selector observers. super spawns the universal observers (name sync and firmware/device-info refresh); the viewer adds
  // its reactions (the active-liveview and the liveview-collection observes).
  protected override spawnObservers(): void {

    super.spawnObservers();

    const viewer = this.nvr.client.state.selectors.viewer.byId(this.device.id);

    // The viewer's active liveview drives which liveview switch reads on. This observe reflects only the active selection - the single switch that shows as on - by
    // re-running updateLiveviewSwitchState; the set of switches itself is reconciled by the liveview-collection observe below.
    this.observeState({ key: "viewer.liveview", selector: state => viewer(state)?.liveview, title: "the active live view" }, () => {

      this.updateLiveviewSwitchState({ initialized: true });
      this.publishLiveviewState();
    });

    // The controller's liveview collection drives which switches this viewer exposes. Re-run the full reconcile whenever that collection changes, so the switch set
    // stays in step with the liveviews the controller offers. (The viewer.liveview observe above handles the active-selection reflection.)
    this.observeState({ key: "nvr.liveviews", selector: selectLiveviews, title: "the live view list" }, () => {

      this.updateDevice({ initialized: true });
      this.publishLiveviewState();
    });
  }
}
