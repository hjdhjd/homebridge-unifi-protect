/* Copyright(C) 2019-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * doorbell.ts: Doorbell capability for UniFi Protect.
 */
import type { Camera, DeepPartial, ProtectCameraConfig, ProtectCameraLcdMessageConfig } from "unifi-protect";
import type { CharacteristicValue, HAP, Service } from "homebridge";
import type { HomebridgePluginLogging, Nullable } from "homebridge-plugin-utils";
import { PACKAGE_CAMERA_NAME_SUFFIX, ProtectReservedNames, packageCameraId } from "../../types.ts";
import { PLATFORM_NAME, PLUGIN_NAME, PROTECT_DOORBELL_CHIME_DURATION_DIGITAL } from "../../settings.ts";
import type { ProtectAccessory, ProtectAccessoryContext, WithoutIdentity } from "../../types.ts";
import { chimeRingFor, chimeVolumeFor } from "./chime-volume.ts";
import { mqttTopic, sanitizeName, toStartCase } from "homebridge-plugin-utils";
import type { ProtectCamera } from "./camera.ts";
import type { ProtectCameraPackage } from "./camera-package.ts";
import { ProtectDeviceCapability } from "../device-capability.ts";
import type { ProtectNvr } from "../../nvr/nvr.ts";
import { isFeatureFlagsDrain } from "./capability-reconcile-policy.ts";
import { mqttTopics } from "../../mqtt.ts";

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

/**
 * The effective LCD message for a doorbell, given the raw slice and the current time: an empty object once the message's resetAt deadline has passed, otherwise the
 * slice unchanged. The controller signals a message's expiry by patching lcdMessage rather than clearing it, and an empty-object patch is a no-op the store cannot
 * observe, so both the switch sync and the MQTT get consult this one predicate to treat a past resetAt as a clear. An absent resetAt (a non-expiring message), a
 * still-future resetAt, and an already-empty slice all pass through unchanged. Exported so its truth-table rows exercise it directly.
 *
 * @param options - The raw `lcdMessage` slice and the current time in milliseconds as `nowMs`.
 *
 * @returns The effective message slice, blanked to `{}` when expired.
 */
export function effectiveLcdMessage(options: { lcdMessage: DeepPartial<ProtectCameraLcdMessageConfig>; nowMs: number }): DeepPartial<ProtectCameraLcdMessageConfig> {

  const { lcdMessage, nowMs } = options;

  if((typeof lcdMessage.resetAt === "number") && (lcdMessage.resetAt <= nowMs)) {

    return {};
  }

  return lcdMessage;
}

/* The doorbell capability composed onto a ProtectCamera. It extends ProtectDeviceCapability - the composed-capability contract over the shared observe / MQTT / command
 * spine - rather than ProtectCamera, because doorbell-ness is temporally dynamic capability state, not a static identity: the camera the controller late-flips to a
 * doorbell stays the same instance, and this capability attaches to it live. The capability owns the doorbell services (LCD message switches, physical chimes, the
 * chime-volume lightbulb, the auth sensor), the read-through settings getters, the doorbell observers, the doorbell MQTT topics, and the package-camera lifecycle. Of the
 * contract's detachability policies it holds both: the capability itself is promotion-only, while the package camera it owns follows the
 * graced-cycle child-detach checklist, because a package camera genuinely comes and goes.
 */
export class DoorbellCapability extends ProtectDeviceCapability<ProtectCamera> {

  readonly #device: Camera;
  private messageSwitches = new Map<string, MessageSwitchInterface>();
  public packageCamera: Nullable<ProtectCameraPackage> = null;

  // Construct the capability against its owning camera. The camera passes itself, its own live projection handle, and its protected per-accessory signal from inside
  // its own class body, so no visibility widening is needed.
  constructor(nvr: ProtectNvr, init: { device: Camera; host: ProtectCamera; signal: AbortSignal }) {

    super(nvr, { host: init.host, signal: init.signal });

    this.#device = init.device;
  }

  /* The capability-held projection handle and the live-state view it serves. Every other device-level read a doorbell body performs - the accessory, the accessory name,
   * the feature-option scope, the service wrappers, the MQTT scope, the wake attribution - is inherited from the contract. What stays here is the one piece a capability
   * genuinely owns rather than borrows: each capability holds and types its own projection.
   */

  // The owning camera projection's live STATE, narrowed to drop device identity (id/mac/modelKey) - that immutable identity flows through the dedicated accessors, never
  // the throwing config projection.
  private get ufp(): Readonly<WithoutIdentity<ProtectCameraConfig>> {

    return this.#device.config;
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

  // The doorbell's current physical-chime duration, read non-throwing through the live camera record. An absent record (a doorbell in the removal grace) reports
  // 0 rather than throwing; the physical-chime onGet, the initial switch write, and the reactive push all read this single source.
  private get chimeDuration(): number {

    return this.#device.peek()?.chimeDuration ?? 0;
  }

  // Configure the doorbell capability for HomeKit. The configure order is: the package camera, the Doorbell service (through the camera's own configureDoorbellService
  // call, at the package-to-service point), the auth sensor, the LCD messages, the physical chimes, the chime volume, then the MQTT topics and the observers. The
  // Doorbell service is stood up through the camera's configureDoorbellService call here, so the camera does not separately call it on attach.
  public override configure(): void {

    // Configure our package camera, if we have one.
    this.configurePackageCamera();

    // Ensure the camera's Doorbell service exists and is primary.
    this.host.configureDoorbellService();

    // Configure the authentication sensor, if enabled.
    this.configureAuthSensor();

    // Configure the doorbell LCD message capabilities.
    this.configureDoorbellLcdSwitch();

    // Configure physical chime switches, if enabled.
    this.configurePhysicalChimes();

    // Configure volume control, if enabled.
    this.configureProtectChimeLightbulb();

    // Configure the doorbell MQTT topics (chime and message get/set). These go through the inherited subscribe wrappers on the capability's observeSignal, and each is
    // registered only while its feature stands; the camera registers its own MQTT separately, so there is no super-MQTT to resolve here.
    this.configureMqtt();

    // Spawn the doorbell observers on the capability's own signal.
    this.spawnObservers();
  }

  // Cleanup the capability: tear down the owned package camera first, then let the contract's cleanup abort this capability's controller, which releases its observers,
  // exactly its MQTT handlers on the shared parent-MAC tuple, and its timers together. The message expiry timer needs no explicit clear because it lives in the inherited
  // registry, which that same abort drains.
  public override cleanup(): void {

    if(this.packageCamera) {

      this.packageCamera.cleanup();
      this.packageCamera = null;
    }

    super.cleanup();
  }

  // Refresh the doorbell's physical-chime switch states. Composed by the camera's updateDevice, which calls this when a capability is attached.
  public updateDevice(): void {

    this.updatePhysicalChimes();
  }

  // Spawn the doorbell's narrow-selector observers. The capability does not inherit ProtectDevice.spawnObservers (it extends ProtectBase), so there is no base template
  // to extend and no base name / info pair to worry about - the name and information observers belong to the camera. Doorbell-ring delivery and the package camera's
  // motion are firehose occurrences the router handles, not observed here.
  private spawnObservers(): void {

    const cam = this.nvr.client.state.selectors.camera.byId(this.#device.id);
    const chimes = this.nvr.client.state.selectors.chime.all;
    const id = this.#device.id;

    // Reflect the controller's current LCD message across the doorbell's message switches, re-deriving expiry each time the message slice changes.
    this.observeState({ key: "doorbell.lcdMessage", selector: state => cam(state)?.lcdMessage, title: "the doorbell message" }, () => this.syncLcdMessageState());

    // The package camera capability can be provisioned after adoption (a doorbell that was not fully provisioned when first adopted) - and withdrawn: reconcile the
    // package camera's lifecycle in both directions whenever the controller's capability flag changes. The reconcile cancels any pending detach grace on a true flip
    // (ahead of configurePackageCamera's instance guard, so a flap back actually cancels the timer) and schedules a stability-gated, graced detach on a false flip.
    this.observeState({ key: "doorbell.hasPackageCamera", selector: state => cam(state)?.featureFlags.hasPackageCamera, title: "the package camera" },
      () => this.reconcilePackageCamera());

    // Reflect the active physical-chime mode across the chime switches.
    this.observeState({ key: "doorbell.chimeDuration", selector: state => cam(state)?.chimeDuration, title: "the chime" }, () => this.updatePhysicalChimes());

    // Reflect cross-device volume changes: when this doorbell's effective chime volume changes on the controller (a ring-volume edit on any assigned chime), push it to
    // the volume Lightbulb. The selector returns the computed mean volume across the doorbell's assigned chimes, so the store's value dedup wakes this only on a real
    // ring-volume change, not on every unrelated chime patch, and the push keeps the volume Lightbulb consistent with the onGet. The id is hoisted to the plain string
    // here, alongside cam, because a selector runs inside the store's dispatch, where a projection read against a removed record throws.
    this.observeState({ key: "doorbell.chimeVolume", selector: state => chimeVolumeFor(chimes(state), id), title: "the chime volume" }, () => {

      this.updateChimeVolume();
      this.publishChimeVolumeState();
    });
  }

  // Configure our access to the doorbell LCD screen.
  private configureDoorbellLcdSwitch(): boolean {

    // Make sure we're configuring a doorbell with an LCD screen.
    if(!this.ufp.featureFlags.hasLcdScreen) {

      return false;
    }

    // Walk the doorbell's saved messages from the controller, registering a switch in HomeKit for each.
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
      const { service } = this.acquireService({ name: entry.text, serviceType: this.hap.Service.Switch, subtype: switchIndex });

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
        await this.setMessage((value === true) ? { duration: messageSwitch.duration, text: messageSwitch.text, type: messageSwitch.type } :
          { resetAt: this.platform.clock.now() });
      });
    }

    // Synchronize the message switch state with the controller's current LCD message, arming the expiry timer if the current message is still active. On a restart after
    // a message expired while the plugin was down, this reads the past resetAt as a clear and latches no switch on.
    this.syncLcdMessageState();

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
    // The bare MAC comes from the raw record (present at configure time), not the narrowed live-state projection, which carries no identity.
    const uuid = this.hap.uuid.generate(packageCameraId(this.#device.config.mac));

    // Let's find it if we've already created it.
    let packageCameraAccessory = this.platform.accessories.find(x => x.UUID === uuid);

    // We can't find the accessory. Let's create it.
    if(!packageCameraAccessory) {

      // The camera's MAC address plus the identity suffix gives our UUID seed the guaranteed uniqueness we need.
      packageCameraAccessory = new this.api.platformAccessory<ProtectAccessoryContext>(sanitizeName(this.accessoryName + PACKAGE_CAMERA_NAME_SUFFIX), uuid);

      // Register this accessory with homebridge and add it to the accessory array so we can track it. We mark it as well, so the save that closes this window carries
      // what the package camera's configure pass below sets up on it.
      if(this.hasFeature("Device.Standalone")) {

        this.api.publishExternalAccessories(PLUGIN_NAME, [packageCameraAccessory]);
      } else {

        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [packageCameraAccessory]);
      }

      this.platform.accessories.push(packageCameraAccessory);
      this.platform.persistence.persist(packageCameraAccessory);
    }

    // Now create the package camera accessory through the NVR composition root. The package camera is a HomeKit sub-view of this same physical device, so it shares our
    // live camera projection rather than holding a synthesized config snapshot. It is self-observing: its display name is the parent's name plus the display suffix,
    // applied through its homeKitName delegation, and its own name, firmware, and availability observers keep it tracking the shared device live - this capability owns
    // only its lifecycle (the WHEN, the observers, the sweep triggers), never its construction; only the new lives at the composition root, so no sibling-class
    // value-import.
    this.packageCamera = this.nvr.createPackageCamera(packageCameraAccessory, this.#device);

    return true;
  }

  /* Reconcile the package camera's lifecycle against the controller's live capability flag, as a no-op in both directions when nothing has changed. The
   * hasPackageCamera observer drives this on a flag change, and the NVR's stability sweep drives it at every stability return - the sweep is both the construction-time
   * arm (a capability withdrawn while the plugin was down leaves a cached BRIDGED package accessory that no other removal path can ever reach, since the orphan sweep
   * keys on a mac the package deliberately lacks and the orphan guard refuses parent-alive packages) and the re-arm (a detach grace dropped by a stability loss, or a
   * fire that failed its stability re-check, is re-scheduled once the controller settles). STANDALONE EXCLUSION: homebridge never restores external accessories at
   * startup, so a standalone package ghost after a restart is invisible here - we cannot know one existed, its HomeKit-side pairing cleanup is inherently the user's,
   * and no speculative guidance is emitted.
   */
  public reconcilePackageCamera(): void {

    // The bare MAC comes from the raw record, not the narrowed live-state projection, which carries no identity.
    const uuid = this.hap.uuid.generate(packageCameraId(this.#device.config.mac));

    // The capability is present: cancel any pending detach grace first (a flap back during the grace window must actually cancel the timer - configurePackageCamera's
    // instance guard would otherwise short-circuit before any cancellation could happen), then bring the package camera into being if it is not already.
    if(this.ufp.featureFlags.hasPackageCamera) {

      this.nvr.removals.cancelFor(uuid);
      this.configurePackageCamera();

      return;
    }

    // The controller's drain frame reads the package camera absent alongside every other flag, so an all-false block is no reading and schedules nothing. The real
    // values follow it, and the attach arm above already cancels a grace a genuine withdrawal had pending when they report the package camera again.
    if(isFeatureFlagsDrain(this.ufp.featureFlags)) {

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

    this.nvr.removals.schedule({

      accessory: accessory,
      reason: "The controller no longer reports a package camera on " + this.accessoryName + "; removing its package camera accessory.",
      remove: () => this.detachPackageCamera(),
      stillGone: () => !this.nvr.client.state.selectors.camera.byId(id)(this.nvr.client.state.snapshot())?.featureFlags.hasPackageCamera
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

      this.nvr.mqtt?.publishGuarded(mqttTopic(mac, mqttTopics.motion.topic), "false");
    }

    // Tear down the live instance, if any.
    this.packageCamera?.cleanup();
    this.packageCamera = null;

    if(!accessory) {

      return;
    }

    // Remove the accessory through the shared, presence-guarded tail. Where it lived is read first, because unregistering a bridged accessory takes it off the bridge.
    const bridged = accessory._associatedHAPAccessory.bridged;

    this.nvr.removeAccessoryFromHomeKit(accessory);

    if(!bridged) {

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
      const { service } = this.validService({ serviceType: this.hap.Service.Switch, subtype: physicalChimeType, suffix: " Physical Chime " + toStartCase(chimeSetting),
        validate: this.ufp.featureFlags.hasChime && this.hasFeature("Doorbell.PhysicalChime") });

      if(!service) {

        continue;
      }

      // Get the current status of the physical chime mode on the doorbell.
      service.getCharacteristic(this.hap.Characteristic.On).onGet(() => {

        return this.chimeDuration === this.getPhysicalChimeDuration(physicalChimeType);
      });

      // Activate the appropriate physical chime mode on the doorbell.
      service.getCharacteristic(this.hap.Characteristic.On).onSet(async (value: CharacteristicValue) => {

        // We only want to do something if we're being activated. Turning off the switch would really be an undefined state given that there are three different settings
        // one can choose from. Instead, we do nothing and leave it to the user to choose what state they really want to set.
        if(!value) {

          // Re-assert the switches' real state through updateDevice.
          this.reflectAfterSet(() => this.updateDevice());

          return;
        }

        // Push the new physical chime duration to the controller, reporting any failure through the shared command-error helper.
        if(!(await this.runDeviceCommand("set the physical chime mode to " + chimeSetting,
          () => this.#device.update({ chimeDuration: this.getPhysicalChimeDuration(physicalChimeType) })))) {

          return;
        }

        // Force the other physical chime switches off - the three modes are mutually exclusive, so only one can be on at a time.
        for(const otherChimeSwitch of [ ProtectReservedNames.SWITCH_DOORBELL_CHIME_NONE, ProtectReservedNames.SWITCH_DOORBELL_CHIME_MECHANICAL,
          ProtectReservedNames.SWITCH_DOORBELL_CHIME_DIGITAL ]) {

          // Don't update ourselves a second time.
          if(physicalChimeType === otherChimeSwitch) {

            continue;
          }

          this.accessory.getServiceById(this.hap.Service.Switch, otherChimeSwitch)?.updateCharacteristic(this.hap.Characteristic.On, false);
        }

        // Inform the user, and we're done.
        this.log.info("Physical chime type set to %s.", chimeSetting);
      });

      // Initialize the physical chime switch state.
      service.updateCharacteristic(this.hap.Characteristic.On, this.chimeDuration === this.getPhysicalChimeDuration(physicalChimeType));
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
    const { service } = this.validService({ serviceType: this.hap.Service.Lightbulb, subtype: ProtectReservedNames.LIGHTBULB_DOORBELL_VOLUME, suffix: " Chime Volume",
      validate: this.hasFeature("Doorbell.Volume.Dimmer") });

    if(!service) {

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
    const { service } = this.validService({ serviceType: this.hap.Service.ContactSensor, subtype: ProtectReservedNames.CONTACT_AUTHSENSOR, suffix: " Authenticated",
      validate: this.hasFeature("Doorbell.AuthSensor") && (this.ufp.enableNfc || this.ufp.featureFlags.hasFingerprintSensor) });

    if(!service) {

      return false;
    }

    // Initialize the authentication contact sensor.
    service.updateCharacteristic(this.hap.Characteristic.ContactSensorState, this.hap.Characteristic.ContactSensorState.CONTACT_DETECTED);

    this.log.info("Enabling Protect authentication contact sensor.");

    return true;
  }

  // Configure MQTT capabilities for the doorbell: the chime volume and the doorbell message get/set. These go through the inherited subscribe wrappers, bound to the
  // capability's observeSignal and scoped under the camera's MAC. The camera registers its own MQTT separately, so there is no parent camera-MQTT to resolve here.
  private configureMqtt(): boolean {

    this.configureChimeVolumeMqtt();
    this.configureMessageMqtt();

    // State the chime volume as the doorbell is built, since its construction publishes nothing for it. The message switch sync that ran earlier in construction has
    // already stated a showing message that matches a configured switch, so the current message is stated here only when no switch is on, which covers a message that
    // matches none and keeps one that does to a single statement.
    this.publishChimeVolumeState();

    if(![...this.messageSwitches.values()].some(entry => entry.state)) {

      this.publishLcdMessageState();
    }

    // Restate the chime volume and the current message at the start of every later broker session, through the same methods.
    this.restateOnConnect(() => {

      this.publishChimeVolumeState();
      this.publishLcdMessageState();
    });

    return true;
  }

  // Whether the chime volume dimmer stands, the condition Doorbell.Volume.Dimmer creates it under. The chime volume's MQTT topic is part of the same capability, so its
  // get, its set and its publishes all follow this one answer.
  private get hasVolumeDimmer(): boolean {

    return this.accessory.getServiceById(this.hap.Service.Lightbulb, ProtectReservedNames.LIGHTBULB_DOORBELL_VOLUME) !== undefined;
  }

  // Get and set the chime volume, only while the volume dimmer stands, because a feature the user has not enabled in HomeKit has no MQTT topic.
  private configureChimeVolumeMqtt(): void {

    if(!this.hasVolumeDimmer) {

      return;
    }

    this.subscribeGet(mqttTopics.chime.topic, mqttTopics.chime.label, (): string => {

      return this.chimeVolume.toString();
    });

    this.subscribeSet(mqttTopics.chime.topic, mqttTopics.chime.label, (value: string) => {

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
  }

  // Get and set the doorbell message, only while Doorbell.Messages is on, because a feature the user has not enabled in HomeKit has no MQTT topic. Setting a message
  // from MQTT is part of that feature, so with it off no MQTT message reaches the doorbell's screen.
  private configureMessageMqtt(): void {

    if(!this.isMessagesEnabled) {

      return;
    }

    // Get the current message on the doorbell.
    this.subscribeGet(mqttTopics.message.topic, mqttTopics.message.label, (): string => this.lcdMessagePayload);

    // We support the ability to set the doorbell message like so:
    //
    //   { "message": "some message", "duration": 30 }
    //
    // If duration is omitted, we assume the default duration.
    // If duration is 0, we assume it's not expiring.
    // If the message is blank, we assume we're resetting the doorbell message.
    this.subscribeSet(mqttTopics.message.topic, mqttTopics.message.label, (_value: string, rawValue: string) => {

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

      // Validate the payload's runtime types - the JSON.parse cast is compile-time only. The message must be a string (which subsumes the presence check), and any
      // duration present must be a real number: a non-numeric duration, INCLUDING a numeric-looking string like "30", is rejected per the documented numeric contract
      // rather than silently coerced through arithmetic.
      if((typeof inboundPayload.message !== "string") ||
        (("duration" in inboundPayload) && ((typeof inboundPayload.duration !== "number") || Number.isNaN(inboundPayload.duration)))) {

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

        outboundPayload = { resetAt: this.platform.clock.now() };
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
  }

  /* The doorbell's current message as its MQTT topic carries it: JSON holding the message text and the seconds remaining before it clears, `0` for a message that
   * never expires, or the empty string when no message shows. The get answers it and every publish of the topic carries it, so the topic has one payload shape
   * wherever it is read. The LCD message is read non-throwing through the live camera record, so an absent record (a doorbell lingering in the removal grace) reads as
   * no message, and through the shared expiry predicate, so an expired message reads as none rather than a stale negative duration.
   */
  private get lcdMessagePayload(): string {

    const nowMs = this.platform.clock.now();
    const lcdMessage = effectiveLcdMessage({ lcdMessage: this.#device.peek()?.lcdMessage ?? {}, nowMs });

    if(!Object.keys(lcdMessage).length) {

      return "";
    }

    const duration = (typeof lcdMessage.resetAt === "number") ? Math.round((lcdMessage.resetAt - nowMs) / 1000) : 0;

    return JSON.stringify({ duration, message: lcdMessage.text ?? "" });
  }

  // State the doorbell's current message while the Doorbell.Messages feature is on and a message shows. The topic belongs to the message feature, so a doorbell
  // without it states nothing, and a doorbell with no message states nothing rather than an empty payload.
  private publishLcdMessageState(): void {

    const payload = this.lcdMessagePayload;

    if(!this.isMessagesEnabled || !payload) {

      return;
    }

    this.publish(mqttTopics.message.topic, payload);
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
        updateCharacteristic(this.hap.Characteristic.On, this.chimeDuration === this.getPhysicalChimeDuration(physicalChimeType));
    }
  }

  // Return the physical chime duration, in milliseconds.
  private getPhysicalChimeDuration(physicalChimeType: ProtectReservedNames): number {

    // Set the physical chime duration to correspond to the settings that Protect configures when selecting different physical chime types.
    switch(physicalChimeType) {

      case ProtectReservedNames.SWITCH_DOORBELL_CHIME_DIGITAL:

        return this.chimeDigitalDuration;

      case ProtectReservedNames.SWITCH_DOORBELL_CHIME_MECHANICAL:

        // Mechanical chimes use a fixed duration, unlike the digital case above, which reads a user-configurable setting.
        return 300;

      case ProtectReservedNames.SWITCH_DOORBELL_CHIME_NONE:
      default:

        return 0;
    }
  }

  // Get the list of messages saved on the controller, which is where a doorbell's message set lives.
  private getMessages(): MessageInterface[] {

    // The controller's doorbell settings, the source for its saved messages.
    const doorbellSettings = this.nvr.ufp.doorbellSettings;

    // Something's not right with the configuration...we're done.
    if(!doorbellSettings || !this.isMessagesEnabled) {

      return [];
    }

    let doorbellMessages: MessageInterface[] = [];

    // If we've got messages on the controller, let's configure those, unless the user has disabled that feature.
    if(this.isMessagesFromControllerEnabled) {

      /* The controller's allMessages may omit the duration field that MessageInterface declares; the switch-build loop tolerates that with its "duration" in entry
       * fallback to defaultMessageDuration, which is what makes this cast safe. concat rather than a direct assignment because it hands back a fresh array: the
       * controller's own message array is the library's to own, and a caller that reorders or trims what we return must never reach into it.
       */
      doorbellMessages = (doorbellSettings.allMessages as MessageInterface[]).concat(doorbellMessages);
    }

    // Return the list of doorbell messages.
    return doorbellMessages;
  }

  // Validate our existing HomeKit message switch list, syncing it against the controller's current message set. This runs at configure time only: it is the
  // across-restart sync, catching the scenario where Homebridge was shut down and the list of saved messages on the controller changed.
  private validateMessageSwitches(): void {

    // The filter below selects switches whose subtype is not one of our reserved names and is not already tracked in messageSwitches - the doorbell messages that
    // have disappeared from the controller's current set.
    for(const switchService of this.accessory.services.filter(service => (service.UUID === this.hap.Service.Switch.UUID) && service.subtype &&
      !this.isReservedName(service.subtype) && !this.messageSwitches.has(service.subtype))) {

      // The message has been deleted on the doorbell - remove it from HomeKit, mark the accessory for the next save, and inform the user about it.
      this.log.info("Removing saved doorbell message: %s.", switchService.subtype?.slice(switchService.subtype.indexOf(".") + 1));
      this.host.removeService(switchService);
    }
  }

  /* Synchronize the message switches with the controller's current LCD message, re-deriving expiry each time. Invoked by the lcdMessage observer, by the configure-time
   * sync, and by the expiry timer's own callback, so all three read one truth. The live slice is read non-throwing - an absent record (a doorbell in the removal grace)
   * reads as a clear, which is exactly right mid-removal - and passes through the shared expiry predicate, so an expired message blanks the switches while an active one
   * sets them. We then arm or clear the keyed expiry timer in the capability's own registry from the effective payload: the controller signals expiry by patching
   * lcdMessage, but the store cannot observe an empty-object patch (its structural sharing returns the same record), so the plugin re-synchronizes itself at the resetAt
   * deadline it already knows. Because the timer's callback re-enters here, an expiry fires as a re-read of live truth: an already-replaced message re-asserts the
   * replacement rather than blanking, an expired one clears, and a wire clear that landed first makes the re-sync a harmless repeat. The timer waits the full time
   * remaining until the deadline, however far off it lies, because the platform's clock carries a delay of any length.
   */
  private syncLcdMessageState(): void {

    const nowMs = this.platform.clock.now();
    const effective = effectiveLcdMessage({ lcdMessage: this.#device.peek()?.lcdMessage ?? {}, nowMs });

    this.updateLcdSwitch(effective);

    // Clear unconditionally, then arm when the effective message carries a deadline. The registry's own replace-on-register would make the clear redundant on the arming
    // path, but the clearing path is real: an effective message with no deadline must leave nothing armed. The timer drains structurally through the capability's
    // composed lifetime, so teardown safety does not depend on this clear.
    this.timers.clear("lcdMessageExpiry");

    if(typeof effective.resetAt === "number") {

      this.timers.setTimeout("lcdMessageExpiry", () => this.syncLcdMessageState(), effective.resetAt - nowMs);
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
        (typeof payload.resetAt === "number") ? " (" + Math.round((payload.resetAt - this.platform.clock.now()) / 1000).toString() + " seconds)" : "", payload.text);

      // Publish to MQTT, if the user has configured it, in the shape the topic's get answers.
      this.publish(mqttTopics.message.topic, this.lcdMessagePayload);
    }
  }

  // Set the message on the doorbell.
  private async setMessage(payload: DeepPartial<ProtectCameraLcdMessageConfig> = {}): Promise<boolean> {

    // If a duration was given, translate it into the resetAt timestamp Protect expects and drop the duration field, which the controller does not understand.
    if("duration" in payload) {

      payload.resetAt = payload.duration ? this.platform.clock.now() + payload.duration : null;
      delete payload.duration;
    }

    // Push the update to the doorbell, reporting any failure through the shared command-error helper. An empty payload resets the LCD message back to its default.
    return this.runDeviceCommand("set the doorbell message", () => this.#device.update({ lcdMessage: payload }));
  }

  // This doorbell's effective chime volume, read through the live chime projections. We delegate to the shared chimeVolumeFor helper over
  // client.state.selectors.chime.all of the current snapshot - the identical input the volume observer reduces - so the read-through getter and the reactive push share
  // one definition of "this doorbell's volume". The catalog's chime.all is always an array post-connect.
  private get chimeVolume(): number {

    return chimeVolumeFor(this.nvr.client.state.selectors.chime.all(this.nvr.client.state.snapshot()), this.#device.id);
  }

  private async setChimeVolume(value: number): Promise<void> {

    // A chime can be assigned to multiple doorbells, so update the ring entry for THIS doorbell on every chime that serves it. The controller is the single,
    // immutable source of state, so each update is write-through only: we send the PATCH and let the reducer's stream reflect the change once it arrives. We send a
    // single-entry ringSettings array carrying only the modified ring, matching the controller's expected payload.
    for(const chime of this.nvr.client.chimes) {

      const ring = chimeRingFor(chime.config, this.#device.id);

      if(!ring) {

        continue;
      }

      // eslint-disable-next-line no-await-in-loop -- The chimes are updated one at a time by intent, and the first failed command ends the loop.
      if(!(await this.runDeviceCommand("set the chime volume", () => chime.update({ ringSettings: [{ ...ring, volume: value }] })))) {

        return;
      }
    }
  }

  // Publish this doorbell's chime volume, the value its MQTT get answers, when it changed. The controller's reported change is the one publisher, so a volume set here,
  // in the Protect app, or on a chime shared with another doorbell publishes from the observer once each assigned chime confirms it. The topic belongs to the volume
  // dimmer, so a doorbell without the Doorbell.Volume.Dimmer feature publishes nothing, and a volume needs a chime that rings for this doorbell, so with none assigned
  // the 0 the volume reads stands for no setting and publishes nothing either.
  private publishChimeVolumeState(): void {

    if(!this.hasVolumeDimmer || !this.hasChimeRing) {

      return;
    }

    this.publishState(mqttTopics.chime.topic, this.chimeVolume.toString());
  }

  // Whether any chime assigned to this doorbell carries a ring for it, read over the same chime projection the volume reduces and through the same ring lookup.
  private get hasChimeRing(): boolean {

    return this.nvr.client.state.selectors.chime.all(this.nvr.client.state.snapshot()).some(chime => chimeRingFor(chime, this.#device.id) !== undefined);
  }

  // Push the chime-volume projection onto the doorbell's volume Lightbulb. Shares the read path (chimeVolume / chimeVolumeFor) with the onGet handlers, so the displayed
  // volume and the live value never disagree. A no-op on an unchanged write - HomeKit coalesces it.
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
   * removal for non-doorbell hardware), the mute switch, the HKSV-recording switch, or the UFP-recording switches - those are camera-level or owned elsewhere.
   * Static and accessory-scoped because it runs without a live capability (none is attached when this fires). It answers whether it removed anything, so the caller
   * marks the accessory for a save only when the sweep changed it, and a steady plain camera's sweep marks nothing.
   */
  public static removeServices(accessory: ProtectAccessory, hap: HAP, log: HomebridgePluginLogging): boolean {

    let removed = false;

    // Remove the reserved doorbell-only subtypes.
    for(const subtype of DOORBELL_RESERVED_SUBTYPES) {

      const service = accessory.getServiceById(hap.Service.Switch, subtype) ?? accessory.getServiceById(hap.Service.Lightbulb, subtype) ??
        accessory.getServiceById(hap.Service.ContactSensor, subtype);

      if(service) {

        log.info("Removing stale doorbell service: %s.", subtype);
        accessory.removeService(service);
        removed = true;
      }
    }

    // Remove the non-reserved message-switch services: a Switch with a subtype that is not a reserved name (the message-switch "type.text" shape).
    for(const switchService of accessory.services.filter(service => (service.UUID === hap.Service.Switch.UUID) && service.subtype &&
      !RESERVED_NAMES.has(service.subtype.toUpperCase()))) {

      log.info("Removing stale doorbell message switch: %s.", switchService.subtype?.slice(switchService.subtype.indexOf(".") + 1));
      accessory.removeService(switchService);
      removed = true;
    }

    return removed;
  }
}
