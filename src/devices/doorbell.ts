/* Copyright(C) 2019-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-doorbell.ts: Doorbell capability for UniFi Protect.
 */
import type { AcquireServiceTarget, HomebridgePluginLogging, Nullable } from "homebridge-plugin-utils";
import type { Camera, DeepPartial, ProtectCameraConfig, ProtectCameraLcdMessageConfig } from "unifi-protect";
import type { CharacteristicValue, HAP, Service, WithUUID } from "homebridge";
import { PACKAGE_CAMERA_NAME_SUFFIX, ProtectReservedNames, packageCameraId } from "../types.ts";
import { PLATFORM_NAME, PLUGIN_NAME, PROTECT_DOORBELL_CHIME_DURATION_DIGITAL } from "../settings.ts";
import type { ProtectAccessory, ProtectAccessoryContext } from "../types.ts";
import { acquireService, composeSignals, sanitizeName, toStartCase, validService } from "homebridge-plugin-utils";
import { selectCamera, selectChimes } from "unifi-protect";
import { ProtectBase } from "./device.ts";
import type { ProtectCamera } from "./camera.ts";
import type { ProtectCameraPackage } from "./camera-package.ts";
import type { ProtectNvr } from "../nvr.ts";
import { chimeVolumeFor } from "./chime-volume.ts";
import { mqttTopic } from "../mqtt.ts";

// A doorbell message entry.
interface MessageInterface {

  duration: number;
  text: string;
  type: string;
}

// Extend the message interface to include a doorbell message switch.
export interface MessageSwitchInterface extends MessageInterface {

  service: Service;
  state: boolean;
}

// The doorbell-only reserved service subtypes the capability owns and that no other code path removes: the three physical-chime mode switches, the chime-volume
// lightbulb, and the authentication contact sensor. Defined once so the sweep-stale removal (DoorbellCapability.removeServices) and any future reader share one
// definition of "the doorbell-only reserved service set". Deliberately EXCLUDES the Doorbell service (configureDoorbellTrigger owns its removal), the mute switch, the
// HKSV-recording switch, and the UFP-recording switches - those are camera-level or owned elsewhere.
const DOORBELL_RESERVED_SUBTYPES: readonly string[] = [ ProtectReservedNames.CONTACT_AUTHSENSOR, ProtectReservedNames.LIGHTBULB_DOORBELL_VOLUME,
  ProtectReservedNames.SWITCH_DOORBELL_CHIME_DIGITAL, ProtectReservedNames.SWITCH_DOORBELL_CHIME_MECHANICAL, ProtectReservedNames.SWITCH_DOORBELL_CHIME_NONE ];

// The reserved-name lookup the message-switch sweep consults, so a non-reserved Switch subtype on a camera-family accessory (the only such subtype is a message switch,
// shaped "type.text") is the removal target while every reserved subtype is left to its own owner.
const RESERVED_NAMES = new Set(Object.values(ProtectReservedNames).map(x => x.toUpperCase()));

/* The doorbell capability composed onto a ProtectCamera. It extends ProtectBase - the shared observe / MQTT / command spine - rather than ProtectCamera, because
 * doorbell-ness is temporally dynamic capability state, not a static identity: the camera the controller late-flips to a doorbell stays the same instance, and this
 * capability attaches to it live. Everything the dissolved doorbell subclass owned lives here - the doorbell services (LCD message switches, physical chimes,
 * the chime-volume lightbulb, the auth sensor), the four read-through settings getters, the four doorbell observers, the doorbell MQTT topics, and the package-camera
 * lifecycle. The camera-coupling is localized to a private block of delegating accessors below, so each moved body resolves its this.ufp / this.accessory /
 * this.hasFeature reads through the camera with minimal change. The capability holds its own composed AbortController so a future detach unwinds exactly its observers
 * and MQTT registrations, the 2b owner-lifetime idiom one level up.
 */
export class DoorbellCapability extends ProtectBase {

  readonly #controller = new AbortController();
  readonly camera: ProtectCamera;
  readonly #device: Camera;
  private messageSwitches = new Map<string, MessageSwitchInterface>();
  public packageCamera: Nullable<ProtectCameraPackage> = null;
  readonly #signal: AbortSignal;

  // Construct the capability against its owning camera. The camera passes itself, its own live projection handle, and its protected per-accessory signal from inside
  // its own class body, so no visibility widening is needed. The capability's signal composes its own controller with the camera's, so aborting either tears the
  // capability down.
  constructor(nvr: ProtectNvr, init: { camera: ProtectCamera; device: Camera; signal: AbortSignal }) {

    super(nvr);

    this.camera = init.camera;
    this.#device = init.device;
    this.#signal = composeSignals(this.#controller.signal, init.signal);
  }

  /* The delegating accessors: the resolution to the member-access census. Each moved doorbell body read off this.ufp / this.accessory / this.hasFeature and the rest,
   * which ProtectBase does not provide. Routing them through these private accessors over the camera localizes the camera-coupling to one block and keeps the moved
   * bodies a near-verbatim re-route. The acquireService / validService wrappers are thin re-bindings to the HBPU free functions over the camera's accessory (the same
   * HBPU SSOT the camera's own wrappers delegate to), not logic duplication.
   */

  // The live camera projection's config record, narrowed to the camera projection. The moved bodies read this.ufp.<field> exactly as the subclass did.
  private get ufp(): Readonly<ProtectCameraConfig> {

    return this.#device.config;
  }

  // The owning camera's accessory.
  private get accessory(): ProtectAccessory {

    return this.camera.accessory;
  }

  // The owning camera's accessory name.
  private get accessoryName(): string {

    return this.camera.accessoryName;
  }

  // Feature-option reads delegate to the camera, which scopes against the camera MAC and the controller MAC.
  private hasFeature(option: string): boolean {

    return this.camera.hasFeature(option);
  }

  private getFeatureNumber(option: string): Nullable<number | undefined> {

    return this.camera.getFeatureNumber(option);
  }

  // Reserved-name check delegates to the camera's public helper.
  private isReservedName(name?: string): boolean {

    return this.camera.isReservedName(name);
  }

  // Acquire a service on the camera's accessory, a thin re-binding to the HBPU free function (the SSOT the camera's own wrapper also delegates to).
  private acquireService(serviceType: AcquireServiceTarget, name = this.accessoryName, subtype?: string, onServiceCreate?: (svc: Service) => void): Nullable<Service> {

    return acquireService(this.accessory, serviceType, name, subtype, onServiceCreate);
  }

  // Validate a service on the camera's accessory, the same thin re-binding to the HBPU free function.
  private validService(serviceType: WithUUID<typeof Service>, validate: boolean, subtype?: string): boolean {

    return validService(this.accessory, serviceType, validate, subtype);
  }

  /* The seam overrides, each varying exactly what ProtectBase's shared spine reads by leaf. */

  // The log prefix and diagnostics name: delegate to the camera's name. The camera's name getter resolves to the live controller projection name - the exact value
  // today's doorbell logged with - so log prefixes are identical to the pre-collapse doorbell. NOT accessoryName (the cached HomeKit Name), which would diverge.
  public override get name(): string {

    return this.camera.name;
  }

  // The owner-lifetime signal scoping the capability's observers and MQTT registrations: the composed signal (the capability's own controller plus the camera's), so a
  // capability cleanup or a camera teardown unwinds exactly the capability's loops and releases exactly its MQTT handlers.
  protected override get observeSignal(): AbortSignal {

    return this.#signal;
  }

  // The MQTT topic scope: the camera's MAC, so the doorbell topics (chime, message) ride the same wire scope as the camera - identical to the pre-collapse doorbell,
  // which scoped under its own (the camera's) MAC.
  protected override get mqttId(): string {

    return this.camera.ufp.mac;
  }

  // Wake attribution: the capability has no accessory identity of its own, so it delegates to the camera's single publishObserverWake seam, keeping one publisher keyed
  // on the camera's accessory UUID. The four doorbell.* keys are preserved verbatim and remain diagnostics-visible under the camera's accessory.
  protected override onObserverWake(key: string): void {

    this.camera.publishObserverWake(key);
  }

  /* The doorbell settings below are live read-through getters rather than stored fields, deliberately. Deriving each setting on read from its single source of truth -
   * the feature options and the live controller projection - eliminates the staleness class entirely: there is no stored copy to wipe, and a controller-side settings
   * change is reflected on the next read without a restart.
   */

  // The duration of a digital physical chime ring, in milliseconds: the user's feature-option setting, clamped to the range of durations Protect accepts.
  private get chimeDigitalDuration(): number {

    return Math.min(Math.max(this.getFeatureNumber("Doorbell.PhysicalChime.Duration.Digital") ?? PROTECT_DOORBELL_CHIME_DURATION_DIGITAL, 1000), 10000);
  }

  // The default duration of a doorbell message, in milliseconds, read live from the controller's doorbell settings.
  private get defaultMessageDuration(): number {

    return this.nvr.ufp.doorbellSettings?.defaultMessageResetTimeoutMs ?? 60000;
  }

  // Whether the user has enabled doorbell messages on this doorbell.
  private get isMessagesEnabled(): boolean {

    return this.hasFeature("Doorbell.Messages");
  }

  // Whether messages saved on the doorbell itself are included in the message switches we expose.
  private get isMessagesFromControllerEnabled(): boolean {

    return this.hasFeature("Doorbell.Messages.FromDoorbell");
  }

  // Configure the doorbell capability for HomeKit, preserving the pre-collapse configure order: the package camera, the Doorbell service (through the camera's seam, at
  // the package-to-service point), the auth sensor, the LCD messages, the physical chimes, the chime volume, then the MQTT topics and the four observers. The Doorbell
  // service is stood up through the camera's configureDoorbellService seam here, so the camera does not separately call it on attach.
  public configure(): void {

    // Configure our package camera, if we have one.
    this.configurePackageCamera();

    // Ensure the camera's Doorbell service exists and is primary.
    this.camera.configureDoorbellService();

    // Configure the authentication sensor, if enabled.
    this.configureAuthSensor();

    // Configure the doorbell LCD message capabilities.
    this.configureDoorbellLcdSwitch();

    // Configure physical chime switches, if enabled.
    this.configurePhysicalChimes();

    // Configure volume control, if enabled.
    this.configureProtectChimeLightbulb();

    // Configure the doorbell MQTT topics (chime and message get/set). These ride the capability's observeSignal through the inherited subscribe wrappers; the camera
    // registers its own MQTT separately, so there is no super-MQTT to resolve here.
    this.configureMqtt();

    // Spawn the four doorbell observers on the capability's own signal.
    this.spawnObservers();
  }

  // Cleanup the capability: tear down the package camera first (mirroring the pre-collapse doorbell.cleanup ordering), then abort the capability's own controller,
  // which releases its four observers and exactly its MQTT handlers on the shared parent-MAC tuple.
  public cleanup(): void {

    if(this.packageCamera) {

      this.packageCamera.cleanup();
      this.packageCamera = null;
    }

    this.#controller.abort();
  }

  // Refresh the doorbell's physical-chime switch states. Composed by the camera's updateDevice, which calls this when a capability is attached.
  public updateDevice(): void {

    this.updatePhysicalChimes();
  }

  // Spawn the doorbell's narrow-selector observers. The capability does not inherit ProtectDevice.spawnObservers (it extends ProtectBase), so there is no base template
  // to extend and no base name / info pair to worry about - the name and information observers belong to the camera. The keys are preserved verbatim. Doorbell-ring
  // delivery and the package camera's motion are firehose occurrences the router handles, not observed here.
  private spawnObservers(): void {

    const cam = selectCamera(this.ufp.id);
    const id = this.ufp.id;

    // Reflect the controller's current LCD message across the doorbell's message switches.
    this.observeState({ key: "doorbell.lcdMessage", selector: state => cam(state)?.lcdMessage, title: "the doorbell message" }, () => {

      if(this.ufp.lcdMessage) {

        this.updateLcdSwitch(this.ufp.lcdMessage);
      }
    });

    // The package camera capability can be provisioned after adoption (a doorbell that was not fully provisioned when first adopted) - and withdrawn: reconcile the
    // package camera's lifecycle in both directions whenever the controller's capability flag changes. The reconcile cancels any pending detach grace on a true flip
    // (ahead of configurePackageCamera's instance guard, so a flap back actually cancels the timer) and schedules a stability-gated, graced detach on a false flip.
    this.observeState({ key: "doorbell.hasPackageCamera", selector: state => cam(state)?.featureFlags.hasPackageCamera, title: "the package camera" },
      () => this.reconcilePackageCamera());

    // Reflect the active physical-chime mode across the chime switches.
    this.observeState({ key: "doorbell.chimeDuration", selector: state => cam(state)?.chimeDuration, title: "the chime" }, () => this.updatePhysicalChimes());

    // Restore the cross-device volume reactivity v4's chimeEventHandler provided: when this doorbell's effective chime volume changes on the controller (a ring-volume
    // edit on any assigned chime), push it to the volume Lightbulb. The selector returns the computed volume, so the store's value dedup wakes this only on a real
    // change, not on every unrelated chime patch. A blessed refinement over v4, which pushed one chime's volume, not the mean - now consistent with the onGet. The id is
    // hoisted to the plain string here, alongside cam, because a selector runs inside the store's dispatch, where a projection read against a removed record throws.
    this.observeState({ key: "doorbell.chimeVolume", selector: state => chimeVolumeFor(selectChimes(state), id), title: "the chime volume" },
      () => this.updateChimeVolume());
  }

  // Configure our access to the doorbell LCD screen.
  private configureDoorbellLcdSwitch(): boolean {

    // Make sure we're configuring a doorbell with an LCD screen.
    if(!this.ufp.featureFlags.hasLcdScreen) {

      return false;
    }

    // Grab the consolidated list of messages from the doorbell and our configuration.
    // Look through the combined messages from the doorbell and what the user has configured and tell HomeKit about it.
    for(const entry of this.getMessages()) {

      // Truncate anything longer than the character limit that the doorbell will accept.
      if(entry.text.length > 30) {

        entry.text = entry.text.slice(0, 30);
      }

      const switchIndex = entry.type + "." + entry.text;

      // In the unlikely event someone tries to use words we have reserved for our own use.
      if(this.isReservedName(switchIndex)) {

        continue;
      }

      // Check to see if we already have this message switch configured.
      if(this.messageSwitches.has(switchIndex)) {

        continue;
      }

      this.log.info("Enabled doorbell message switch%s: %s.", entry.duration ? " (" + (entry.duration / 1000).toString() + " seconds)" : "", entry.text);

      // Acquire the service. Each message cannot exceed 30 characters, but given that HomeKit allows for strings to be up to 64 characters long, this should be fine.
      const service = this.acquireService(this.hap.Service.Switch, entry.text, switchIndex);

      // Fail gracefully.
      if(!service) {

        this.log.error("Unable to add doorbell message switch: %s.", entry.text);

        return false;
      }

      const duration = "duration" in entry ? entry.duration : this.defaultMessageDuration;

      // Save the message switch in the list we maintain.
      this.messageSwitches.set(switchIndex, { duration: duration, service: service, state: false, text: entry.text, type: entry.type });

      // Configure the message switch.
      service.getCharacteristic(this.hap.Characteristic.On).onSet(async (value: CharacteristicValue) => {

        // Lookup the message switch.
        const messageSwitch = this.messageSwitches.get(switchIndex);

        // If we're already in the state we want to be in, we're done.
        if(!messageSwitch || (messageSwitch.state === value)) {

          return;
        }

        // Set the message and sync our states.
        await this.setMessage((value === true) ? { duration: messageSwitch.duration, text: messageSwitch.text, type: messageSwitch.type } : { resetAt: Date.now() });
      });
    }

    // Update the message switch state in HomeKit.
    if(this.ufp.lcdMessage) {

      this.updateLcdSwitch(this.ufp.lcdMessage);
    }

    // Check to see if any of our existing doorbell messages have disappeared.
    this.validateMessageSwitches();

    return true;
  }

  // Configure a package camera, if one exists.
  private configurePackageCamera(): boolean {

    // First, confirm the device has a package camera.
    if(!this.ufp.featureFlags.hasPackageCamera) {

      return false;
    }

    // If we've already setup the package camera, we're done.
    if(this.packageCamera) {

      return true;
    }

    // Generate a UUID for the package camera, seeded by the package camera's identity - the parent's MAC address plus the persistence-critical identity suffix. We derive
    // the id through the shared leaf function rather than the package class, so the capability consumes the package's identity without value-importing its sibling class.
    const uuid = this.hap.uuid.generate(packageCameraId(this.ufp.mac));

    // Let's find it if we've already created it.
    let packageCameraAccessory = this.platform.accessories.find(x => x.UUID === uuid);

    // We can't find the accessory. Let's create it.
    if(!packageCameraAccessory) {

      // The camera's MAC address plus the identity suffix gives our UUID seed the guaranteed uniqueness we need.
      packageCameraAccessory = new this.api.platformAccessory<ProtectAccessoryContext>(sanitizeName(this.accessoryName + PACKAGE_CAMERA_NAME_SUFFIX), uuid);

      // Register this accessory with homebridge and add it to the accessory array so we can track it.
      if(this.hasFeature("Device.Standalone")) {

        this.api.publishExternalAccessories(PLUGIN_NAME, [packageCameraAccessory]);
      } else {

        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [packageCameraAccessory]);
      }

      this.platform.accessories.push(packageCameraAccessory);
      this.api.updatePlatformAccessories(this.platform.accessories);
    }

    // Now create the package camera accessory through the NVR composition root. The package camera is a HomeKit sub-view of this same physical device, so it shares our
    // live camera projection rather than holding a synthesized config snapshot. It is self-observing: its display name is the parent's name plus the display suffix,
    // applied through its syncedName seam, and its own name, firmware, and availability observers keep it tracking the shared device live - this capability owns only its
    // lifecycle (the WHEN, the observers, the sweep triggers), never its construction; only the new lives at the composition root, so no sibling-class value-import.
    this.packageCamera = this.nvr.createPackageCamera(packageCameraAccessory, this.#device);

    return true;
  }

  /* Reconcile the package camera's lifecycle against the controller's live capability flag, idempotently in both directions. The hasPackageCamera observer drives
   * this on a flag change, and the NVR's stability sweep drives it at every stability return - the sweep is both the construction-time arm (a capability withdrawn
   * while HBUP was down leaves a cached BRIDGED package accessory that no other removal path can ever reach, since the orphan sweep keys on a mac the package
   * deliberately lacks and the orphan guard refuses parent-alive packages) and the re-arm (a detach grace dropped by a stability loss, or a fire that failed its
   * stability re-check, is re-scheduled once the controller settles). STANDALONE EXCLUSION: homebridge never restores external accessories at startup, so a
   * standalone package ghost after a restart is invisible here - we cannot know one existed, its HomeKit-side pairing cleanup is inherently the user's, and no
   * speculative guidance is emitted.
   */
  public reconcilePackageCamera(): void {

    const uuid = this.hap.uuid.generate(packageCameraId(this.ufp.mac));

    // The capability is present: cancel any pending detach grace first (a flap back during the grace window must actually cancel the timer - configurePackageCamera's
    // instance guard would otherwise short-circuit before any cancellation could happen), then bring the package camera into being if it is not already.
    if(this.ufp.featureFlags.hasPackageCamera) {

      this.nvr.cancelDeviceRemovalFor(uuid);
      this.configurePackageCamera();

      return;
    }

    // The capability is withdrawn. Is there anything to detach? A live instance, or a cached accessory restored from a prior session (the across-restart ghost).
    const accessory = this.packageCamera?.accessory ?? this.platform.accessories.find(x => x.UUID === uuid);

    if(!accessory) {

      return;
    }

    // Schedule the graced, stability-gated detach through the NVR's removal chokepoint. The stillGone predicate must be absence-tolerant: the fire runs on a bare
    // timer where a throw would crash Homebridge, and the parent projection's config getter throws once the parent record itself has been removed - so we capture the
    // projection's plain id field at schedule time and re-read the record through the selector, treating an absent parent as gone.
    const id = this.#device.id;

    this.nvr.scheduleDeviceRemoval({

      accessory: accessory,
      reason: "The controller no longer reports a package camera on " + this.accessoryName + "; removing its package camera accessory.",
      remove: () => this.detachPackageCamera(),
      stillGone: () => !selectCamera(id)(this.nvr.client.state.snapshot())?.featureFlags.hasPackageCamera
    });
  }

  /* Detach the package camera - the removal action a reconciled detach decision runs. Everything derives from persisted identity (the accessory context's MAC)
   * rather than the live projection, because the fire can run after the parent's record has left the store, where every projection config read throws. The accessory
   * derives from the live instance else the platform lookup, so a divergent accessory/instance pair is unrepresentable. In order: clear the dispatcher's event
   * timers for the package id, publishing the terminal MQTT motion reset on the shared parent topic when the cleared package reset timer would have owned it and the
   * parent holds no inflight motion of its own (without this, the shared topic latches "true" on the live parent until its next motion); tear down the live
   * instance, which releases its observers and - through the owner-lifetime MQTT scoping - exactly its handlers on the shared tuple; then remove the accessory
   * through the NVR's shared, presence-guarded removal tail. The schedule-time reason line is the flow's one user-facing message; the only addition is the
   * manual-deletion guidance for a standalone (unbridged) accessory, whose HomeKit-side removal we cannot perform ourselves.
   */
  private detachPackageCamera(): void {

    const mac = this.accessory.context.mac;

    if(!mac) {

      return;
    }

    const packageId = packageCameraId(mac);
    const accessory = this.packageCamera?.accessory ?? this.platform.accessories.find(x => x.UUID === this.hap.uuid.generate(packageId));

    // Clear the package's event timers, taking over the cleared reset timer's terminal publish when the parent's own inflight motion would not cover it. The topic
    // composes from the persisted MAC rather than the publish wrapper, whose topic scope reads the live projection.
    if(this.nvr.events.clearEventTimersForDevice(packageId) && !this.nvr.events.hasInflightMotion(mac)) {

      void this.nvr.mqtt?.publish(mqttTopic(mac, "motion"), "false");
    }

    // Tear down the live instance, if any.
    this.packageCamera?.cleanup();
    this.packageCamera = null;

    if(!accessory) {

      return;
    }

    // Remove the accessory through the shared, presence-guarded tail.
    this.nvr.removeAccessoryFromHomeKit(accessory);

    if(!accessory._associatedHAPAccessory.bridged) {

      this.log.info("You will need to manually delete the package camera accessory in the Home app to complete the removal.");
    }
  }

  // Configure a series of switches to manually enable or disable chimes on Protect doorbells that support attached physical chimes.
  private configurePhysicalChimes(): boolean {

    const switchesEnabled = [];

    // The Protect controller supports three modes for attached, physical chimes on a doorbell: none, mechanical, and digital. We create switches for each of the modes.
    for(const physicalChimeType of
      [ ProtectReservedNames.SWITCH_DOORBELL_CHIME_NONE, ProtectReservedNames.SWITCH_DOORBELL_CHIME_MECHANICAL, ProtectReservedNames.SWITCH_DOORBELL_CHIME_DIGITAL ]) {

      const chimeSetting = physicalChimeType.slice(physicalChimeType.lastIndexOf(".") + 1);

      // Validate whether we should have this service enabled.
      // If we don't have the physical capabilities or the feature option enabled, disable the switch and we're done.
      if(!this.validService(this.hap.Service.Switch, this.ufp.featureFlags.hasChime && this.hasFeature("Doorbell.PhysicalChime"), physicalChimeType)) {

        continue;
      }

      // Acquire the service.
      const service = this.acquireService(this.hap.Service.Switch, this.accessoryName + " Physical Chime " + toStartCase(chimeSetting), physicalChimeType);

      // Fail gracefully.
      if(!service) {

        this.log.error("Unable to add physical chime switch: %s.", chimeSetting);

        continue;
      }

      // Get the current status of the physical chime mode on the doorbell.
      service.getCharacteristic(this.hap.Characteristic.On).onGet(() => {

        return this.ufp.chimeDuration === this.getPhysicalChimeDuration(physicalChimeType);
      });

      // Activate the appropriate physical chime mode on the doorbell.
      service.getCharacteristic(this.hap.Characteristic.On).onSet(async (value: CharacteristicValue) => {

        // We only want to do something if we're being activated. Turning off the switch would really be an undefined state given that there are three different settings
        // one can choose from. Instead, we do nothing and leave it to the user to choose what state they really want to set.
        if(!value) {

          setTimeout(() => this.updateDevice(), 50);

          return;
        }

        // Push the new physical chime duration to the controller, reporting any failure through the shared command-error helper.
        if(!(await this.runDeviceCommand("set the physical chime mode to " + chimeSetting,
          () => this.#device.update({ chimeDuration: this.getPhysicalChimeDuration(physicalChimeType) })))) {

          return;
        }

        // Update all the other physical chime switches.
        for(const otherChimeSwitch of [ ProtectReservedNames.SWITCH_DOORBELL_CHIME_NONE, ProtectReservedNames.SWITCH_DOORBELL_CHIME_MECHANICAL,
          ProtectReservedNames.SWITCH_DOORBELL_CHIME_DIGITAL ]) {

          // Don't update ourselves a second time.
          if(physicalChimeType === otherChimeSwitch) {

            continue;
          }

          // Update the other physical chime switches.
          this.accessory.getServiceById(this.hap.Service.Switch, otherChimeSwitch)?.updateCharacteristic(this.hap.Characteristic.On, false);
        }

        // Inform the user, and we're done.
        this.log.info("Physical chime type set to %s.", chimeSetting);
      });

      // Initialize the physical chime switch state.
      service.updateCharacteristic(this.hap.Characteristic.On, this.ufp.chimeDuration === this.getPhysicalChimeDuration(physicalChimeType));
      switchesEnabled.push(chimeSetting);
    }

    if(switchesEnabled.length) {

      this.log.info("Enabling physical chime switches: %s (digital chime duration: %s ms).", switchesEnabled.join(", "),
        this.chimeDigitalDuration.toLocaleString("en-US"));
    }

    return true;
  }

  // Configure the dimmer for HomeKit to control the volume.
  private configureProtectChimeLightbulb(): boolean {

    // Validate whether we should have this service enabled.
    if(!this.validService(this.hap.Service.Lightbulb, this.hasFeature("Doorbell.Volume.Dimmer"), ProtectReservedNames.LIGHTBULB_DOORBELL_VOLUME)) {

      return false;
    }

    // Acquire the service.
    const service = this.acquireService(this.hap.Service.Lightbulb, this.accessoryName + " Chime Volume", ProtectReservedNames.LIGHTBULB_DOORBELL_VOLUME);

    if(!service) {

      this.log.error("Unable to add chime volume control.");

      return false;
    }

    // Turn the chime on or off.
    service.getCharacteristic(this.hap.Characteristic.On).onGet(() => this.chimeVolume > 0);

    service.getCharacteristic(this.hap.Characteristic.On).onSet(async (value: CharacteristicValue) => {

      // We really only want to act when the volume is zero. Otherwise, it's handled by the brightness event.
      if(value) {

        return;
      }

      await this.setChimeVolume(0);
    });

    // Return the volume level of the chime.
    service.getCharacteristic(this.hap.Characteristic.Brightness).onGet(() => this.chimeVolume);

    // Adjust the volume of the chime by adjusting brightness of the light.
    service.getCharacteristic(this.hap.Characteristic.Brightness).onSet(async (value: CharacteristicValue) => this.setChimeVolume(value as number));

    // Initialize the chime.
    service.updateCharacteristic(this.hap.Characteristic.On, this.chimeVolume > 0);
    service.updateCharacteristic(this.hap.Characteristic.Brightness, this.chimeVolume);

    this.log.info("Enabling Protect chime volume control.");

    return true;
  }

  // Configure the contact sensor to indicate authentication success.
  private configureAuthSensor(): boolean {

    // Validate whether we should have this service enabled.
    // The authentication contact sensor is disabled by default unless the user enables it. We only make it available if we have at least one of the
    // fingerprint sensor or the NFC sensor available.
    if(!this.validService(this.hap.Service.ContactSensor, this.hasFeature("Doorbell.AuthSensor") && (this.ufp.enableNfc || this.ufp.featureFlags.hasFingerprintSensor),
      ProtectReservedNames.CONTACT_AUTHSENSOR)) {

      return false;
    }

    // Acquire the service.
    const service = this.acquireService(this.hap.Service.ContactSensor, this.accessoryName + " Authenticated", ProtectReservedNames.CONTACT_AUTHSENSOR);

    if(!service) {

      this.log.error("Unable to add authentication sensor.");

      return false;
    }

    // Initialize the authentication contact sensor.
    service.updateCharacteristic(this.hap.Characteristic.ContactSensorState, this.hap.Characteristic.ContactSensorState.CONTACT_DETECTED);

    this.log.info("Enabling Protect authentication contact sensor.");

    return true;
  }

  // Configure MQTT capabilities for the doorbell: the chime volume and the doorbell message get/set. These ride the capability's observeSignal through the inherited
  // subscribe wrappers, scoped under the camera's MAC. The camera registers its own MQTT separately, so there is no parent camera-MQTT to resolve here.
  private configureMqtt(): boolean {

    // Get and set the chime volume.
    this.subscribeGet("chime", "chime volume", (): string => {

      return this.chimeVolume.toString();
    });

    this.subscribeSet("chime", "chime volume", (value: string) => {

      const volume = parseInt(value);

      // Unknown message - ignore it.
      if(isNaN(volume) || (volume < 0) || (volume > 100)) {

        return;
      }

      // We explicitly want to trigger our set event handler, which will complete this action.
      this.accessory.getServiceById(this.hap.Service.Lightbulb, ProtectReservedNames.LIGHTBULB_DOORBELL_VOLUME)
        ?.setCharacteristic(this.hap.Characteristic.Brightness, volume);
      this.accessory.getServiceById(this.hap.Service.Lightbulb, ProtectReservedNames.LIGHTBULB_DOORBELL_VOLUME)
        ?.setCharacteristic(this.hap.Characteristic.On, volume > 0);
    });

    // Get the current message on the doorbell.
    this.subscribeGet("message", "doorbell message", (): string => {

      if(!this.ufp.lcdMessage) {

        return "";
      }

      const doorbellDuration = (typeof this.ufp.lcdMessage.resetAt === "number") ? Math.round((this.ufp.lcdMessage.resetAt - Date.now()) / 1000) : 0;

      // Return the current message.
      return JSON.stringify({ duration: doorbellDuration, message: this.ufp.lcdMessage.text ?? "" });
    });

    // We support the ability to set the doorbell message like so:
    //
    //   { "message": "some message", "duration": 30 }
    //
    // If duration is omitted, we assume the default duration.
    // If duration is 0, we assume it's not expiring.
    // If the message is blank, we assume we're resetting the doorbell message.
    this.subscribeSet("message", "doorbell message", (_value: string, rawValue: string) => {

      interface mqttMessageJSON {

        message: string;
        duration: number;
      }

      let inboundPayload;

      // Catch any errors in parsing what we get over MQTT.
      try {

        inboundPayload = JSON.parse(rawValue) as mqttMessageJSON;
      } catch {

        this.log.error("Unable to process MQTT message: \"%s\". Invalid JSON.", rawValue);

        // Errors mean that we're done now.
        return;
      }

      // At a minimum, make sure a message was specified. If we have a duration, make sure it's a valid number.
      if(!("message" in inboundPayload) || (("duration" in inboundPayload) && Number.isNaN(inboundPayload.duration))) {

        this.log.error("Unable to process MQTT message: \"%s\". The message must include a \"message\" field and any duration must be numeric.", rawValue);

        return;
      }

      // If no duration specified, or a negative duration, we assume the default duration.
      if(!("duration" in inboundPayload) || (("duration" in inboundPayload) && (inboundPayload.duration < 0))) {

        inboundPayload.duration = this.defaultMessageDuration;
      } else {

        inboundPayload.duration = inboundPayload.duration * 1000;
      }

      let outboundPayload;

      // No message defined...we assume we're resetting the message.
      if(!inboundPayload.message.length) {

        outboundPayload = { resetAt: Date.now() };
        this.log.info("Received MQTT doorbell message reset.");
      } else {

        outboundPayload = { duration: inboundPayload.duration, text: inboundPayload.message, type: "CUSTOM_MESSAGE" };
        this.log.info("Received MQTT doorbell message%s: %s.",
          outboundPayload.duration ? " (" + (outboundPayload.duration / 1000).toString() + " seconds)" : "",
          outboundPayload.text);
      }

      // Send it to the doorbell and we're done.
      void this.setMessage(outboundPayload);
    });

    return true;
  }

  // Push the physical-chime switch states from the doorbell's current chime duration, when the doorbell has a chime and the switches are configured. Driven by the
  // chimeDuration observer and composed into the camera's updateDevice.
  private updatePhysicalChimes(): void {

    if(!this.ufp.featureFlags.hasChime || !this.hasFeature("Doorbell.PhysicalChime")) {

      return;
    }

    // Reflect the active physical-chime mode across the three mutually-exclusive switches.
    for(const physicalChimeType of
      [ ProtectReservedNames.SWITCH_DOORBELL_CHIME_NONE, ProtectReservedNames.SWITCH_DOORBELL_CHIME_MECHANICAL, ProtectReservedNames.SWITCH_DOORBELL_CHIME_DIGITAL ]) {

      this.accessory.getServiceById(this.hap.Service.Switch, physicalChimeType)?.
        updateCharacteristic(this.hap.Characteristic.On, this.ufp.chimeDuration === this.getPhysicalChimeDuration(physicalChimeType));
    }
  }

  // Return the physical chime duration, in milliseconds.
  private getPhysicalChimeDuration(physicalChimeType: ProtectReservedNames): number {

    // Set the physical chime duration to correspond to the settings that Protect configures when selecting different physical chime types.
    switch(physicalChimeType) {

      case ProtectReservedNames.SWITCH_DOORBELL_CHIME_DIGITAL:

        return this.chimeDigitalDuration;

      case ProtectReservedNames.SWITCH_DOORBELL_CHIME_MECHANICAL:

        return 300;

      case ProtectReservedNames.SWITCH_DOORBELL_CHIME_NONE:
      default:

        return 0;
    }
  }

  // Get the list of messages from the doorbell and the user configuration.
  private getMessages(): MessageInterface[] {

    // First, we get our builtin and configured messages from the controller.
    const doorbellSettings = this.nvr.ufp.doorbellSettings;

    // Something's not right with the configuration...we're done.
    if(!doorbellSettings || !this.isMessagesEnabled) {

      return [];
    }

    let doorbellMessages: MessageInterface[] = [];

    // Grab any messages that the user has configured.
    if(this.nvr.config.doorbellMessages) {

      for(const configEntry of this.nvr.config.doorbellMessages) {

        let duration = this.defaultMessageDuration;

        // If we've set a duration, let's honor it. If it's less than zero, use the default duration.
        if(("duration" in configEntry) && !isNaN(configEntry.duration) && (configEntry.duration >= 0)) {

          duration = configEntry.duration * 1000;
        }

        // Add it to our list.
        doorbellMessages.push({ duration: duration, text: configEntry.message, type: "CUSTOM_MESSAGE" });
      }
    }

    // If we've got messages on the controller, let's configure those, unless the user has disabled that feature.
    if(this.isMessagesFromControllerEnabled) {

      doorbellMessages = (doorbellSettings.allMessages as MessageInterface[]).concat(doorbellMessages);
    }

    // Return the list of doorbell messages.
    return doorbellMessages;
  }

  // Validate our existing HomeKit message switch list, syncing it against the controller's current message set. This runs at configure time only: the first loop the
  // pre-collapse code carried was provably dead (it tested membership of the exact key every entry was stored under, so its removal branch was unreachable) and is
  // gone; this loop is the real across-restart sync, catching the scenario where Homebridge was shut down and the list of saved messages on the controller changed.
  private validateMessageSwitches(): void {

    // Loop through the list of services on our doorbell accessory and sync the message switches. We do this to catch the scenario where Homebridge was shutdown, and the
    // list of saved messages on the controller changes.
    for(const switchService of this.accessory.services.filter(service => (service.UUID === this.hap.Service.Switch.UUID) && service.subtype &&
      !this.isReservedName(service.subtype) && !this.messageSwitches.has(service.subtype))) {

      // The message has been deleted on the doorbell - remove it from HomeKit and inform the user about it.
      this.log.info("Removing saved doorbell message: %s.", switchService.subtype?.slice(switchService.subtype.indexOf(".") + 1));
      this.accessory.removeService(switchService);
    }
  }

  // Update the message switch state in HomeKit.
  private updateLcdSwitch(payload: DeepPartial<ProtectCameraLcdMessageConfig>): void {

    // The message has been cleared on the doorbell, turn off all message switches in HomeKit.
    if(!Object.keys(payload).length) {

      for(const entry of this.messageSwitches.values()) {

        entry.state = false;
        entry.service.updateCharacteristic(this.hap.Characteristic.On, false);
      }

      return;
    }

    // Sanity check.
    if(!("type" in payload) || !("text" in payload)) {

      return;
    }

    // The message has been set on the doorbell. Update HomeKit accordingly.
    for(const [ key, entry ] of this.messageSwitches) {

      // If it's not the message we're interested in, make sure it's off and keep going.
      if(key !== ((payload.type ?? "") + "." + (payload.text ?? ""))) {

        entry.state = false;
        entry.service.updateCharacteristic(this.hap.Characteristic.On, false);

        continue;
      }

      // If the message switch is already on, we're done.
      if(entry.state) {

        continue;
      }

      // Set the message state and update HomeKit.
      entry.state = true;
      entry.service.updateCharacteristic(this.hap.Characteristic.On, true);

      this.log.info("Doorbell message set%s: %s.",
        payload.resetAt !== null ? " (" + Math.round(((payload.resetAt ?? 0) - Date.now()) / 1000).toString() + " seconds)" : "", payload.text);

      // Publish to MQTT, if the user has configured it.
      this.publish("message", JSON.stringify({ duration: entry.duration / 1000, message: entry.text }));
    }
  }

  // Set the message on the doorbell.
  private async setMessage(payload: DeepPartial<ProtectCameraLcdMessageConfig> = {}): Promise<boolean> {

    // We take the duration and save it for MQTT and then translate the payload into what Protect is expecting from us.
    if("duration" in payload) {

      payload.resetAt = payload.duration ? Date.now() + payload.duration : null;
      delete payload.duration;
    }

    // Push the update to the doorbell, reporting any failure through the shared command-error helper. An empty payload resets the LCD message back to its default.
    return this.runDeviceCommand("set the doorbell message", () => this.#device.update({ lcdMessage: payload }));
  }

  // This doorbell's effective chime volume, read through the live v5 chime projections. We delegate to the shared chimeVolumeFor helper over selectChimes of the current
  // snapshot - the identical input the volume observer reduces - so the read-through getter and the reactive push share one definition of "this doorbell's volume".
  // selectChimes is always an array post-connect, so the old bootstrap-missing guard is gone.
  private get chimeVolume(): number {

    return chimeVolumeFor(selectChimes(this.nvr.client.state.snapshot()), this.ufp.id);
  }

  private async setChimeVolume(value: number): Promise<void> {

    // Clamp to a non-negative volume.
    value = Math.max(value, 0);

    // A chime can be assigned to multiple doorbells, so update the ring entry for THIS doorbell on every chime that serves it. Write-through: each update PATCHes the
    // controller and the change is reflected once the reducer's stream delivers it - we no longer fold the response back into local state (v5 state is immutable and
    // single-sourced in the reducer), nor mutate the ring in place. We send a single-entry ringSettings array carrying only the modified ring, matching v4's payload.
    for(const chime of this.nvr.client.chimes.filter(chime => chime.config.cameraIds.includes(this.ufp.id))) {

      const ring = chime.config.ringSettings.find(setting => setting.cameraId === this.ufp.id);

      if(!ring) {

        continue;
      }

      // eslint-disable-next-line no-await-in-loop
      if(!(await this.runDeviceCommand("set the chime volume", () => chime.update({ ringSettings: [{ ...ring, volume: value }] })))) {

        return;
      }
    }

    this.publish("chime", value.toString());
  }

  // Push the chime-volume projection onto the doorbell's volume Lightbulb. Shares the read path (chimeVolume / chimeVolumeFor) with the onGet handlers, so the displayed
  // volume and the live value never disagree. Idempotent - HomeKit coalesces an unchanged write.
  private updateChimeVolume(): void {

    const volume = this.chimeVolume;
    const service = this.accessory.getServiceById(this.hap.Service.Lightbulb, ProtectReservedNames.LIGHTBULB_DOORBELL_VOLUME);

    service?.updateCharacteristic(this.hap.Characteristic.Brightness, volume);
    service?.updateCharacteristic(this.hap.Characteristic.On, volume > 0);
  }

  /* Remove the doorbell-only services from a camera accessory that the controller no longer reports as a doorbell - the SSOT removal a camera-owned sweep-stale arm
   * runs when a demoted-while-down doorbell reconstructs as a plain camera, where today's doorbell-only services would otherwise linger forever. Removes the reserved
   * doorbell subtypes (the three physical-chime switches, the chime-volume lightbulb, the auth contact sensor) and the non-reserved message-switch Switch services
   * (whose subtype is shaped "type.text", never a reserved name). Deliberately does NOT remove the Doorbell service (configureDoorbellTrigger's existing arm owns its
   * removal for non-doorbell hardware), the mute switch, the HKSV-recording switch, or the three UFP-recording switches - those are camera-level or owned elsewhere.
   * Static and accessory-scoped because it runs without a live capability (none is attached when this fires).
   */
  public static removeServices(accessory: ProtectAccessory, hap: HAP, log: HomebridgePluginLogging): void {

    // Remove the reserved doorbell-only subtypes.
    for(const subtype of DOORBELL_RESERVED_SUBTYPES) {

      const service = accessory.getServiceById(hap.Service.Switch, subtype) ?? accessory.getServiceById(hap.Service.Lightbulb, subtype) ??
        accessory.getServiceById(hap.Service.ContactSensor, subtype);

      if(service) {

        log.info("Removing stale doorbell service: %s.", subtype);
        accessory.removeService(service);
      }
    }

    // Remove the non-reserved message-switch services: a Switch with a subtype that is not a reserved name (the message-switch "type.text" shape).
    for(const switchService of accessory.services.filter(service => (service.UUID === hap.Service.Switch.UUID) && service.subtype &&
      !RESERVED_NAMES.has(service.subtype.toUpperCase()))) {

      log.info("Removing stale doorbell message switch: %s.", switchService.subtype?.slice(switchService.subtype.indexOf(".") + 1));
      accessory.removeService(switchService);
    }
  }
}
