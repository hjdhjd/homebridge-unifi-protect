/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * nvr-removal-cascade.ts: The controller's device-removal cascade, as a companion the controller hands its facts and its actions.
 *
 * Removing one of the controller's accessories is more than taking it off the bridge. The accessory may belong to another controller or to an owner that manages it
 * itself, a camera takes its package camera with it, and the device behind it holds observers, dispatcher timers and livestream-episode entries the removal has to
 * release. This module owns that whole act: the guards that leave an accessory alone, the name the removal is logged under, the package-camera cascade, the device's
 * cleanup and retirement, and the shared tail every removal of one of the controller's accessories ends in. The design follows the controller's companion rule:
 *
 *   1. Facts in, actions out. The cascade holds no controller reference. The controller's MAC and its state store arrive as suppliers it pulls at use time, because
 *      neither exists until the controller connects, and the acts another companion owns - cancelling a pending delayed removal, reclaiming a camera's livestream
 *      episodes, stating a device's departure on the broker, retiring a device from the event dispatcher - are reached through the narrow
 *      {@link DeviceRemovalCascadeActions} surface handed at construction.
 *
 *   2. Removal, not its timing. The cascade holds no timers: every removal runs to completion when it is called. Whether and when a removal happens is the removal
 *      gate's decision, and the gate calls here once it has made it.
 */
import type { AccessoryPersistence, HomebridgePluginLogging } from "homebridge-plugin-utils";
import type { ProtectAccessory, ProtectDevices } from "../types.ts";
import type { ProtectDevice } from "../devices/device.ts";
import type { StoreReadSurface } from "./nvr-policy.ts";
import { describeDevice } from "../devices/device-descriptor.ts";
import { deviceConfigByMac } from "./nvr-policy.ts";
import { isPackageCameraContext } from "../types.ts";

/**
 * The acts a removal runs that belong to another companion, handed in at construction, so the cascade reaches them only through this surface.
 */
export interface DeviceRemovalCascadeActions {

  // Cancel the delayed removal pending for an accessory, if it holds one, so a grace armed before this removal never fires against an accessory it already removed.
  cancelPendingRemoval: (uuid: string) => void;

  // Reclaim the livestream-episode entries a removed camera leaves open, so an episode that never recovered does not outlive the camera.
  forgetCamera: (cameraId: string) => void;

  // State the retained offline a removed device leaves on the broker, by its MAC, so a subscriber attaching later does not read the online its last live statement left.
  publishRemoval: (mac: string) => void;

  // Settle and reclaim the event dispatcher's timers and enrichment marks for a removed device.
  retireDevice: (device: ProtectDevice) => void;
}

/**
 * Construction options for {@link DeviceRemovalCascade}.
 */
export interface DeviceRemovalCascadeOptions {

  // The platform's accessory list, which the cascade reads and removes from in place. The platform assigns it once, so the cascade holds the list itself.
  accessories: ProtectAccessory[];
  actions: DeviceRemovalCascadeActions;
  // The MAC of the controller the cascade removes for, pulled at use time because the controller reports it only once it has connected.
  controllerMac: () => string;
  // The controller's configured devices, keyed by accessory UUID, which a removal reads its device from and deletes it out of.
  devices: Map<string, ProtectDevices>;
  log: HomebridgePluginLogging;
  // The platform's accessory persistence, which takes an accessory off the bridge and drops any save still pending for it.
  persistence: AccessoryPersistence;
  // Let go of whichever owner holds a removed accessory's claim, so nothing answers for an accessory that has left.
  releaseAccessory: (accessory: ProtectAccessory) => void;
  // The controller's state store, pulled at use time because the controller establishes it only once it has connected.
  state: () => StoreReadSurface;
}

/**
 * The device-removal cascade for one controller: the guards, the package-camera cascade, the device's cleanup and retirement, and the shared removal tail.
 */
export class DeviceRemovalCascade {

  readonly #accessories: ProtectAccessory[];

  readonly #actions: DeviceRemovalCascadeActions;

  readonly #controllerMac: () => string;

  readonly #devices: Map<string, ProtectDevices>;

  readonly #log: HomebridgePluginLogging;

  readonly #persistence: AccessoryPersistence;

  readonly #releaseAccessory: (accessory: ProtectAccessory) => void;

  readonly #state: () => StoreReadSurface;

  public constructor(options: DeviceRemovalCascadeOptions) {

    this.#accessories = options.accessories;
    this.#actions = options.actions;
    this.#controllerMac = options.controllerMac;
    this.#devices = options.devices;
    this.#log = options.log;
    this.#persistence = options.persistence;
    this.#releaseAccessory = options.releaseAccessory;
    this.#state = options.state;
  }

  /**
   * Remove an individual Protect accessory from HomeKit. The pure immediate remover: every guard and the package-camera cascade run here. The DelayDeviceRemoval grace
   * is decided by the removal gate before this method runs, so by the time it is called the decision to remove was already made and graced.
   *
   * @param accessory - The accessory to remove.
   */
  public removeDevice(accessory: ProtectAccessory): void {

    // Ensure that this accessory hasn't already been removed.
    if(!this.#accessories.some(x => x.UUID === accessory.UUID)) {

      return;
    }

    // We only remove devices if they're on the Protect controller we're interested in.
    if(accessory.context.nvr !== this.#controllerMac()) {

      return;
    }

    // The NVR system information accessory is handled elsewhere.
    if(accessory.context.systemInfo) {

      return;
    }

    // The accessories the liveviews owner derives - the liveview switches and the security system - are handled elsewhere.
    if(accessory.context.liveviewDerived) {

      return;
    }

    // We only store MAC addresses on devices that exist on the Protect controller. Any other accessories created are ones we created ourselves and are managed
    // elsewhere, with one exception - package cameras. If we have a matching parent camera for the package camera, we're done here. Package cameras are dealt with
    // when we remove the parent camera. If the parent doesn't exist, this is an orphan that we need to remove.
    if(!accessory.context.mac &&
      (!isPackageCameraContext(accessory.context) || (this.#accessories.some(x => x.context.mac === accessory.context.packageCamera)))) {

      return;
    }

    // Grab our instance of the Protect device, if it exists.
    const protectDevice = this.#devices.get(accessory.UUID);

    // Reclaim any livestream-episode latch entries for the camera being removed (a started-but-never-recovered episode would otherwise never drain). Keyed off the
    // device's id, which is the cameraId the latch entries carry; a non-camera device's id matches nothing, so this is a no-op scan of a small map for them.
    if(protectDevice?.protectId) {

      this.#actions.forgetCamera(protectDevice.protectId);
    }

    // See if we can pull the device's configuration details from our Protect device instance or the controller projection.
    //
    // The by-MAC controller projection backs the removal descriptor only when the wrapper's record has vanished (or there is no wrapper). While the record is
    // present, the wrapper's own live config carries the descriptor, so the projection lookup is never evaluated on that path - it is lazy by construction.
    const byMac = (!protectDevice?.recordPresent && accessory.context.mac) ? deviceConfigByMac({ mac: accessory.context.mac, state: this.#state() }) : null;

    // The removal descriptor: the wrapper's live config while its record is present, recombining the bare MAC the narrowed state view no longer carries. The mac is
    // recombined ONLY to satisfy the descriptor's required-field type - the plain-mode log line below does not read it (mac would surface only under includeNetwork).
    const descriptor = (protectDevice?.recordPresent ? { ...protectDevice.ufp, mac: protectDevice.mac } : null) ?? byMac;

    // The model category drives the log label and the package-camera cascade; read it non-throwing from the wrapper while its record is present, else the by-MAC lookup.
    const modelKey = (protectDevice?.recordPresent ? protectDevice.modelKey : null) ?? byMac?.modelKey;

    this.#log.info("%s: Removing %s from HomeKit.%s",
      descriptor ? describeDevice(descriptor) : protectDevice?.accessoryName ?? accessory.displayName,
      modelKey ?? "device",
      accessory._associatedHAPAccessory.bridged ? "" : " You will need to manually delete the device in the Home app to complete the removal.");

    const deletingAccessories = [accessory];

    // If it's an unknown device or a camera, look for a corresponding package camera if we have one and remove it as well. The lookup runs only for an accessory
    // carrying a MAC of its own: an orphan package camera carries none and has no package of its own, and a lookup by an absent MAC would match every accessory that
    // is not a package camera.
    if(accessory.context.mac && (!descriptor || (modelKey === "camera"))) {

      const packageCameraAccessory = this.#accessories.find(x => x.context.packageCamera === accessory.context.mac);

      // Remove the package camera, if it exists, and cleanup the device if it has been configured.
      if(packageCameraAccessory) {

        deletingAccessories.push(packageCameraAccessory);
      }
    }

    // Cleanup our device instance.
    protectDevice?.cleanup();

    // Settle and reclaim the dispatcher's timers and enrichment marks for this device. They are keyed by the persisted device id and outlive the wrapper otherwise, so
    // removal both settles every latched boolean topic they own and reclaims the timers themselves; the exact-boundary sweep also reclaims the cascaded package
    // camera's timers through the parent-id prefix, by design here where the package accessory is already in deletingAccessories.
    if(protectDevice) {

      this.#actions.retireDevice(protectDevice);
    }

    // Leave the device's retained offline behind it, its registrations having ended above so nothing states over it. An accessory carrying no MAC of its own - a package
    // camera, whose topic is its parent's - speaks for no topic, so its removal says nothing.
    if(accessory.context.mac) {

      this.#actions.publishRemoval(accessory.context.mac);
    }

    // Finally, remove it from our list of configured devices and HomeKit.
    this.#devices.delete(accessory.UUID);

    // Remove each accessory through the shared tail. Cancelling any pending delayed removal per accessory first kills the cascade-then-stale-timer double fire: a
    // cascade-removed package camera may hold its own pending detach grace, which must never fire against an accessory this removal already handled.
    for(const targetAccessory of deletingAccessories) {

      this.#actions.cancelPendingRemoval(targetAccessory.UUID);
      this.removeAccessory(targetAccessory);
    }
  }

  /**
   * Remove an accessory from HomeKit and the platform's accessory list - the shared removal tail every removal of one of the controller's accessories ends in, the
   * cascade above and the package camera's graced detach among them. The unregister goes through the platform's accessory persistence, which drops any save still
   * pending for the accessory, so no later save returns it to the cache, and hands Homebridge only an accessory its bridge holds: hap-nodejs throws on unregistering a
   * never-bridged (standalone) accessory, whose HomeKit-side removal is the user's in the Home app. The presence guard makes a stale double-fire a harmless no-op - an
   * indexOf miss would otherwise splice(-1) and silently delete the LAST accessory in the platform array. Being the one way out, it is also where the accessory's claim
   * is released, so no removal path has to remember to. Logs nothing: the caller owns the user-facing narration.
   *
   * @param accessory - The accessory to remove.
   */
  public removeAccessory(accessory: ProtectAccessory): void {

    const index = this.#accessories.indexOf(accessory);

    if(index === -1) {

      return;
    }

    this.#persistence.unregister([accessory]);
    this.#accessories.splice(index, 1);
    this.#releaseAccessory(accessory);
  }
}
