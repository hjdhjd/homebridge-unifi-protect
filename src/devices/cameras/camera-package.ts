/* Copyright(C) 2019-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * camera-package.ts: Package camera device class for UniFi Protect.
 */
import { PACKAGE_CAMERA_NAME_SUFFIX, ProtectReservedNames, packageCameraId } from "../../types.ts";
import { buildAdvertisedResolutions, buildChannelProfile, formatResolution, isPackageChannel } from "../../media/resolution.ts";
import { describeDevice, describeDeviceModel } from "../device-descriptor.ts";
import type { AdvertisedStreams } from "./camera.ts";
import type { ChannelProfile } from "../../media/resolution.ts";
import type { CharacteristicValue } from "homebridge";
import type { Nullable } from "homebridge-plugin-utils";
import { ProtectCamera } from "./camera.ts";
import type { ProtectPersistedContextState } from "../../types.ts";
import type { ProtectState } from "unifi-protect";
import { retry } from "homebridge-plugin-utils";

// Package camera class. Extends ProtectCamera and represents the secondary camera channel on Protect doorbells that ship with one. The package camera is a HomeKit
// sub-view of its parent doorbell's shared camera projection, not a Protect device of its own - it is self-observing over that shared projection, deriving its identity
// and display name from the parent's, while its motion is driven by the parent camera's lastMotion leaf observer (the package has no motion signal of its own, so the
// parent's bare-motion observe forwards a recording package camera's motion for it). Its controller follows the parent the same way: the parent's capability reconcile
// re-checks the package's frozen controller identity in the same pass, so a capability the controller reports late - HomeKit Secure Video eligibility among them -
// rebuilds the package's controller alongside the parent's.
export class ProtectCameraPackage extends ProtectCamera {

  // Whether the flashlight is currently lit. The literal initializer is safe under ES2024 field-define semantics precisely because it carries no constructor-chain-
  // computed state: the field defines to false after the base constructor returns, and every reader of the field runs post-construction (the onGet and onSet handlers).
  private flashlightState = false;

  // The monotonic generation of the latest flashlight intent, bumped on every on and off. Transient intent state, never persisted - the flashlight is a write-only
  // momentary command with no confirming observer, so only the capture-and-check half of the relay's pending-intent pattern applies: the truthy onSet captures the
  // generation it opened, and every deferred continuation of that activation (the retry resolution, the not-dark reset, the heartbeat-arming decision) re-checks its
  // captured generation before acting, so a superseding off or a newer on cleanly wins the race.
  #flashlightGeneration = 0;

  // Spawn the package camera's bespoke observer set, deliberately REPLACING the camera set rather than extending it - no super call. The camera reactions must never
  // spawn here: the reclassification observer would arm a flap-triggered doorbell-capability attach against the package accessory (an isDoorbell flap on the shared
  // parent record would attach the doorbell capability onto the package - duplicate doorbell services and context corruption), and the channels/videoCodec observers
  // would wake the package's own streaming reconcile on parent-channel churn that has nothing to do with the package channel. The base pair (name sync and device
  // information) still spawns through the family template, which is what lets the package track parent renames and firmware updates without any doorbell fan-out.
  protected override spawnCameraObservers(): void {

    // Bind the by-id camera selector once, as the parent does - the package shares the parent's projection, so the parent's id is ours too. We seed it from
    // the projection's non-throwing id rather than the throwing config, so the selector binding never depends on a present record.
    const cam = this.nvr.client.state.selectors.camera.byId(this.device.id);

    // The lifecycle state of the shared physical device drives the package accessory's availability, exactly as it drives the parent's - each side observes the same
    // slice and pushes its own narrow projection.
    this.observeState({ key: "camera.state", selector: state => cam(state)?.state, title: "availability" }, () => this.updateAvailability());

    // The package channel can be provisioned after adoption (a doorbell that was not fully provisioned when first adopted). We reduce the channel to a computed
    // primitive - its formatted dimension tuple, or undefined while absent - so the store's value dedup wakes this only when the package channel appears or genuinely
    // changes shape, never on unrelated channel-list churn. The string serialization is a consumer-side stand-in for a store value-equality option. On a wake the
    // handler re-attempts the streaming reconcile: the arrival wake builds the stream from the real channel, and a post-build dimension change returns at the
    // capability's create-once gate, leaving the advertised list frozen until a restart - exact parent parity.
    const packageChannelShape = (state: ProtectState): string | undefined => {

      const channel = cam(state)?.channels.find(isPackageChannel);

      return channel ? formatResolution([ channel.width, channel.height, channel.fps ]) : undefined;
    };

    this.observeState({ key: "camera.packageChannel", selector: packageChannelShape, title: "video streaming" }, () => void this.acquireStreaming().reconcile());
  }

  // The package camera's HomeKit name is the parent's plus the display suffix, single-sourced from the shared live parent projection and the parent's custom name,
  // which the package's hints resolve from the parent MAC's scope, through the base homeKitName accessor, which adds the suffix to the name it derives from the record
  // or the custom name. Every name write and every restore reads that derivation, so the suffix applies uniformly wherever the plugin owns the name, and a vanished
  // record falls back to the package accessory's own name, which already carries the suffix once; with neither a custom name nor name syncing, the accessory keeps
  // the name it carries.
  protected override get homeKitNameSuffix(): string {

    return PACKAGE_CAMERA_NAME_SUFFIX;
  }

  // The package camera's log prefix is the parent's "Name [Model]" descriptor with the Package Camera suffix on the name, so the package's log lines are attributable
  // instead of colliding with the parent doorbell's (they share the same projection, so the base logName would render identically). While the record stands the prefix
  // carries the name the controller reports, as every device's log prefix does, and once the record is gone it carries the package accessory's own name, a custom name
  // included.
  protected override get logName(): string {

    // Derive from the live record when present, the name falling back to the model as the parent's descriptor does; when the parent record has vanished (in the
    // removal grace), fall back to the package accessory's own name, which already carries the suffix and reads nothing from the record, so a detached package timer
    // callback names the device instead of throwing.
    const config = this.device.peek();

    return config ? describeDevice(config, { name: ((config.name ?? "") || describeDeviceModel(config)) + PACKAGE_CAMERA_NAME_SUFFIX }) : this.accessoryName;
  }

  // Configure the package camera.
  protected override configureDevice(): boolean {

    // The package camera inherits configureHints, which already computed every streaming hint in its own constructor pass from the shared parent MAC's feature-option
    // scope, so the only hint set here is the package-specific probesize floor - package camera streams are sparse enough that FFmpeg needs a deeper probe to lock on.
    this.hints.probesize = 32768;

    // Preserve the persisted user-state keys across the context reset: motion detection, and no HKSV recording state, since the package builds no recording switch. The
    // values here are the resting defaults; resetAccessoryContext keeps whatever was actually persisted and falls back to these only when nothing was. The
    // seedContextIdentity override below seeds the package's synthetic identity rather than a real MAC.
    const preserved: ProtectPersistedContextState = { detectMotion: true };

    this.resetAccessoryContext(preserved);

    // Configure accessory information.
    this.configureInfo();

    // Configure the motion sensor.
    this.configureMotionSensor();

    // Configure the flashlight.
    this.configureFlashlight();

    // Configure the video stream when the controller has provisioned the package channel, deferring until then otherwise. configureDevice is the one caller that
    // narrates the deferral to the user - the package-channel observer's later re-attempts stay silent until one succeeds. Reading the outcome off this.stream right
    // after the reconcile is sound because the package's derivation is synchronous: the capability's whole derive-establish-register chain has already run inside this
    // call frame, so the delegate either exists by now or the deferral is genuine.
    void this.acquireStreaming().reconcile();

    if(!this.stream) {

      this.log.info("The package camera accessory is ready, but its video stream will become available once the controller finishes provisioning the package " +
        "camera channel.");
    }

    // We're done.
    return true;
  }

  // The package camera arms no reboot-return watch of its own, deliberately doing nothing here. The package is a second HomeKit view of the parent's hardware, not a
  // second piece of hardware, and the parent's watch already speaks for the physical camera - two watches over one device would tell the user the same camera is
  // missing twice, and announce its return twice. The controller's post-reboot walk reaches package cameras alongside their parents, so the inert override is what
  // keeps that walk uniform rather than making the caller ask which kind of camera it holds.
  public override noteControllerRebooted(): void {

    // Deliberately empty: the parent camera's watch speaks for the shared hardware.
  }

  // The package camera configures neither the status light nor night vision when its controller registers, deliberately doing nothing here. Its controller carries a
  // recording arm, so the registration gives the package accessory an operating-mode service too, but the status light and night vision are the parent camera's
  // hardware, controlled from the parent's tile alone. The package's own streaming capability sends it the same notice the parent receives, so the inert override is
  // what keeps them off the package's tile.
  public override onControllerRegistered(): void {

    // Deliberately empty: the parent camera's tile controls the shared hardware.
  }

  // Seed the package camera's synthetic identity. Unlike a real device, the package camera carries no MAC of its own - it is reserved for real Protect devices - so we
  // seed the controller MAC and the parent's bare MAC as the packageCamera identity instead. Identity is re-derived every configure from the raw record, never preserved
  // across a context reset; the package is the one family whose identity is synthetic, which is why it overrides the base seeding.
  protected override seedContextIdentity(): void {

    this.accessory.context.nvr = this.nvr.ufp.mac;
    this.accessory.context.packageCamera = this.device.config.mac;
  }

  /* The package camera's derivation, overriding the parent's: its one fixed channel, or null while the controller has not yet provisioned that channel. SYNCHRONOUS -
   * the package reads its channel straight off the shared parent projection with no controller round trip, so it returns the value arm of the parent's declared union
   * rather than a promise. That is what keeps the package's whole derive-establish-register chain inside its caller's own call frame, and a behavioral pin guards the
   * tick placement: making this derivation asynchronous would silently defer the controller registration and the deferral narration that reads its outcome.
   *
   * A null return is the defer-until-provisioned answer, and the capability's create-once gate is what makes the re-attempts safe: the package-channel observer re-runs
   * the reconcile on channel arrival, and a post-build dimension change wakes it too, where the gate returns and the advertised list stays frozen until a restart - the
   * parent's identical staleness envelope. Deferral also means the accessory's HomeKit camera controller is registered only once the channel exists; if a session ends
   * before it ever arrives, hap-nodejs marks the controller's persisted state purge-on-next-load, so the package's saved HKSV configuration can be purged across two such
   * restarts - an accepted, narrow caveat of defer-create (the alternative, re-registering a controller mid-life, factory-resets HKSV unconditionally).
   */
  public override deriveAdvertisedStreams(): Nullable<AdvertisedStreams> {

    // The controller has not provisioned the package channel yet. The accessory itself (motion, flashlight) is fully functional in the meantime; it simply
    // advertises no video stream until the channel arrives and the observer re-attempts. Advertisement turns on the channel's EXISTENCE, not on its RTSP state.
    const profile = this.packageProfile();

    if(!profile) {

      return null;
    }

    // Synthesize the HomeKit resolution list from the package channel's fixed native top. The package camera is a single fixed channel - the resolution module seeds the
    // list with the native top itself and appends the aspect-appropriate mandated resolutions at the package frame rate, so we pass the seed once and do NOT prepend it.
    //
    // The package advertises the recording audio stand-in and runs no probe, because its derivation is synchronous by contract and a probe would await the stream. A
    // package recording whose stream differs from the stand-in is transcoded to it.
    return { audioFormat: null, probe: null, profiles: [profile], resolutions: buildAdvertisedResolutions({ fpsSet: [15], nativeTop: profile.resolution }) };
  }

  // The package camera's establishment narration, overriding the parent's: its debug mapping lines have a shape of their own, because the package advertises a
  // synthesized list against one fixed native top rather than a set of named channels. It carries none of the parent's profile pins - the package has a single channel,
  // so there is nothing for a profile preference to select between.
  public override onStreamingEstablish(derived: AdvertisedStreams): void {

    // The package derivation supplies exactly one profile, and the guarded read is what the index-access typing requires of any caller.
    const nativeTop = derived.profiles[0]?.resolution;

    if(!nativeTop) {

      return;
    }

    // Inform users about our RTSP entry mapping, if we're debugging.
    if(this.hasFeature("Debug.Video.Startup")) {

      for(const entry of derived.resolutions) {

        this.log.info("Mapping resolution: %s.", formatResolution(entry) + " => " + formatResolution(nativeTop));
      }
    }
  }

  // Configure a light accessory to turn on or off the flashlight.
  private configureFlashlight(): boolean {

    // Validate whether we should have this service enabled.
    const { service } = this.validService({ serviceType: this.hap.Service.Lightbulb, subtype: ProtectReservedNames.LIGHTBULB_PACKAGE_FLASHLIGHT, suffix: " Flashlight",
      validate: this.hasFeature("Doorbell.PackageCamera.Flashlight") });

    if(!service) {

      return false;
    }

    // Activate or deactivate the package camera flashlight.
    service.getCharacteristic(this.hap.Characteristic.On).onGet(() => this.flashlightState);

    service.getCharacteristic(this.hap.Characteristic.On).onSet(async (value: CharacteristicValue) => {

      // A command targeting the package camera whose shared controller record has vanished cannot be fulfilled, so we no-op gracefully rather than throwing on the
      // live-config read below.
      if(!this.recordPresent) {

        return;
      }

      // Stop heartbeating the flashlight to allow it to turn off. Bump the intent generation so any in-flight activation's deferred continuations see themselves
      // superseded and bail; the off path defers nothing of its own, so it does not capture the generation it opened.
      if(!value) {

        this.timers.clear("flashlight");
        this.flashlightState = false;
        this.#flashlightGeneration++;

        return;
      }

      // Open a new activation intent and capture its generation. Every deferred continuation below compares against this captured value, so a superseding off or a newer
      // on that bumps the counter makes this activation's continuations no-op.
      const generation = ++this.#flashlightGeneration;

      // Utility function to activate the package camera's flashlight.
      const activateFlashlight = async (): Promise<boolean> => {

        // The flashlight is momentary, so this heartbeat re-issues the pulse on a timer. We assume the pulse lands and unset only if every attempt fails.
        // turnOnFlashlight throws on a failed pulse (a non-2xx, or an unreachable controller), so a failure drives a re-attempt directly - reachability is the
        // command's to report, not a second check here. We retry the pulse a bounded number of times on a fixed cadence, swallow a persistent failure to a
        // reflected-off switch (the timer re-issues), and bind this.signal so a teardown aborts an in-flight backoff and pulse.
        let lit = true;

        try {

          await retry((signal) => this.device.turnOnFlashlight({ signal }), { attempts: 3, backoff: () => 1000, clock: this.platform.clock, signal: this.signal });
        } catch {

          lit = false;
        }

        // A superseding off or newer on landed while the retry was in flight, so this activation is stale: latch nothing, push nothing, and leave the timer to whichever
        // action superseded us.
        if(generation !== this.#flashlightGeneration) {

          return false;
        }

        this.flashlightState = lit;

        // Update the flashlight switch.
        service.updateCharacteristic(this.hap.Characteristic.On, this.flashlightState);

        // Stop if we've been told to turn off.
        if(!this.flashlightState) {

          this.timers.clear("flashlight");
        }

        return this.flashlightState;
      };

      // Clear out any interval we have.
      this.timers.clear("flashlight");

      // If it's not dark, the flashlight will not engage - reset the switch to off and we're done.
      if(!this.ufp.isDark) {

        // The captured-generation re-check keeps a legitimate later activation (isDark flipped true before the reflect fires) from being stomped off by this stale reset.
        this.reflectAfterSet(() => {

          if(generation === this.#flashlightGeneration) {

            service.updateCharacteristic(this.hap.Characteristic.On, false);
          }
        });

        return;
      }

      // Activate the flashlight.
      await activateFlashlight();

      // A superseding off or newer on landed while the first activation was in flight, so this intent is stale: do not arm the heartbeat. Gate on the generation, not on
      // activateFlashlight's return value - a failed FIRST activation of a still-current intent still arms the heartbeat by design (the retry's swallow-and-re-issue
      // semantics), and only a superseded intent skips it.
      if(generation !== this.#flashlightGeneration) {

        return;
      }

      // Heartbeat the flashlight at regular intervals to keep it on. The controller exposes no off endpoint for this momentary command - the light
      // self-extinguishes on its own roughly 25 seconds after the last activation - so a twenty-second cadence, matching Protect's own apps, keeps
      // re-pulsing it with a five-second margin before that natural timeout.
      this.timers.setInterval("flashlight", () => void activateFlashlight(), 20 * 1000);
    });

    // Initialize the flashlight to its resting off state. We write the literal rather than reading the field: this line runs inside the construction chain, before our
    // subclass field initializer has defined flashlightState (ES2024 define semantics), and the momentary flashlight is always off at construction regardless.
    service.updateCharacteristic(this.hap.Characteristic.On, false);

    return true;
  }

  // The package camera's public identity API: the unique device identifier derived from a parent doorbell's MAC address. The derivation itself lives in the shared types
  // leaf (packageCameraId) so the doorbell capability - a pure consumer of the package's identity, never a co-author - can derive it without value-importing this sibling
  // class. This static re-exposes that single derivation as the package class's own identity surface, consumed by the id getter and the accessory-UUID seed.
  public static packageCameraId(mac: string): string {

    return packageCameraId(mac);
  }

  // Return a unique identifier for package cameras based on the parent device's MAC address. Sourced from the persisted accessory context (the parent's bare MAC) rather
  // than the live config, so it survives a vanished parent record. The SUFFIXED form keys the event dispatcher's package timers; the package accessory UUID is generated
  // independently from the same packageCameraId derivation, so this read-source change is UUID-safe, mirroring the base id getter.
  public override get id(): string {

    return ProtectCameraPackage.packageCameraId(this.accessory.context.packageCamera ?? "");
  }

  // The bare device MAC for the package camera: the parent doorbell's MAC, persisted in the accessory context. This DIVERGES from the suffixed .id above - the package's
  // MQTT delivery topics ride the parent's BARE MAC (the package shares the parent's wire scope), while its event timers key off the suffixed .id.
  public override get mac(): string {

    return this.accessory.context.packageCamera ?? "";
  }

  /* The package channel's profile, if the controller has provisioned the channel. This is the pure EXISTENCE lookup - it says nothing about RTSP - and it is what the
   * advertisement and the buffer substrate both read, because the livestream API that feeds them serves the channel whether or not RTSP is enabled on it.
   *
   * A prototype method rather than an ES-private one, mirroring configureFlashlight above, because the derivation that calls it runs from configureDevice inside the
   * BASE constructor: an ES-private member is branded onto the instance only after super() returns, so a `#` spelling here throws on every package construction.
   */
  private packageProfile(): Nullable<ChannelProfile> {

    const channel = this.ufp.channels.find(isPackageChannel);

    if(!channel) {

      return null;
    }

    // Return the information we need for package camera channel access. We pin lens 2 and resolve the URL host through the inherited rtspHost chain
    // (overrideAddress ?? connectionHost ?? host), so the package's RTSP URLs resolve through the same override/connection-host/controller-host
    // chain as the parent's, rather than the controller's raw address.
    return buildChannelProfile(channel, { lens: 2, rtspPort: this.nvr.ufp.ports.rtsps, urlHost: this.rtspHost });
  }

  // Make our RTSP stream findable. This is the RTSP-consuming view of the package channel: a direct session dials the channel over RTSP, so a channel the controller
  // has not enabled has no stream to offer and we answer nothing rather than handing back a URL that cannot connect.
  public override selectChannel(): Nullable<ChannelProfile> {

    const profile = this.packageProfile();

    return profile?.channel.isRtspEnabled ? profile : null;
  }

  // Resolve the channel that populates the timeshift buffer. The package camera is a single fixed channel, and the buffer draws it through the livestream API, so this
  // answers from the existence lookup rather than the RTSP-consuming view above.
  public override selectSubstrateChannel(): Nullable<ChannelProfile> {

    return this.packageProfile();
  }

  // Whether the package channel currently has RTSP enabled. The parent's forward through the streaming capability is wrong here: the package's published list is its own
  // single profile, and this fact must read live off the shared projection. Read non-throwing, so a package whose record has vanished in the removal grace answers false
  // rather than throwing.
  public override get hasRtspStream(): boolean {

    return this.fromRecord((config) => config.channels.find(isPackageChannel)?.isRtspEnabled ?? false, false);
  }
}
