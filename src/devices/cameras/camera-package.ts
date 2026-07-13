/* Copyright(C) 2019-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * camera-package.ts: Package camera device class for UniFi Protect.
 */
import { PACKAGE_CAMERA_NAME_SUFFIX, ProtectReservedNames, packageCameraId } from "../../types.ts";
import { buildAdvertisedResolutions, buildChannelProfile, formatResolution, isPackageChannel } from "../../media/resolution.ts";
import type { ChannelProfile } from "../../media/resolution.ts";
import type { CharacteristicValue } from "homebridge";
import type { Nullable } from "homebridge-plugin-utils";
import { ProtectCamera } from "./camera.ts";
import type { ProtectPersistedContextState } from "../../types.ts";
import type { ProtectState } from "unifi-protect";
import { describeDevice } from "../device-descriptor.ts";
import { retry } from "homebridge-plugin-utils";
import { selectCamera } from "unifi-protect";

// Package camera class. Extends ProtectCamera and represents the secondary camera channel on Protect doorbells that ship with one. The package camera is a HomeKit
// sub-view of its parent doorbell's shared camera projection, not a Protect device of its own - it is self-observing over that shared projection, deriving its identity
// and display name from the parent's, while its motion is driven by the parent camera's lastMotion leaf observer (the package has no motion signal of its own, so the
// parent's bare-motion observe forwards a recording package camera's motion for it).
export class ProtectCameraPackage extends ProtectCamera {

  // Whether the flashlight is currently lit. The literal initializer is safe under ES2024 field-define semantics precisely because it carries no constructor-chain-
  // computed state: the field defines to false after the base constructor returns, and every reader of the field runs post-construction (the onGet and onSet handlers).
  private flashlightState = false;

  // Spawn the package camera's bespoke observer set, deliberately REPLACING the camera set rather than extending it - no super call. The camera reactions must never
  // spawn here: the reclassification observer would arm a flap-triggered doorbell-capability attach against the package accessory (an isDoorbell flap on the shared
  // parent record would attach the doorbell capability onto the package - duplicate doorbell services and context corruption), and the channels/videoCodec observers
  // would run the parent-flavored reconcileStreaming against the package accessory. The base pair (name sync and device information) still spawns through the family
  // template, which is what lets the package track parent renames and firmware updates without any doorbell fan-out.
  protected override spawnCameraObservers(): void {

    // Bind the by-id camera selector once, as the parent does - the package shares the parent's projection, so the parent's id is ours too. We seed it from
    // the projection's non-throwing id rather than the throwing config, so the selector binding never depends on a present record.
    const cam = selectCamera(this.device.id);

    // The lifecycle state of the shared physical device drives the package accessory's availability, exactly as it drives the parent's - each side observes the same
    // slice and pushes its own narrow projection.
    this.observeState({ key: "camera.state", selector: state => cam(state)?.state, title: "availability" }, () => this.updateAvailability());

    // The package channel can be provisioned after adoption (a doorbell that was not fully provisioned when first adopted). We reduce the channel to a computed
    // primitive - its formatted dimension tuple, or undefined while absent - so the store's value dedup wakes this only when the package channel appears or genuinely
    // changes shape, never on unrelated channel-list churn. The string serialization is a consumer-side stand-in for a store value-equality option. On a wake the
    // handler re-attempts the idempotent stream configure: the arrival wake builds the stream from the real channel, and a post-build dimension change returns at the
    // idempotency gate, leaving the advertised list frozen until a restart - exact parent parity.
    const packageChannelShape = (state: ProtectState): string | undefined => {

      const channel = cam(state)?.channels.find(isPackageChannel);

      return channel ? formatResolution([ channel.width, channel.height, channel.fps ]) : undefined;
    };

    this.observeState({ key: "camera.packageChannel", selector: packageChannelShape, title: "video streaming" }, () => { this.configurePackageStream(); });
  }

  // The package camera's display name is the parent's synced name plus the display suffix, single-sourced from the shared live parent projection through the base
  // syncedName seam. Every name-sync path (configureInfo at configure time, syncNameFromController on a controller-side rename) reads this derivation, so the suffix
  // applies uniformly with name syncing on; with it off, the creation-time name persists untouched.
  protected override get syncedName(): string {

    return super.syncedName + PACKAGE_CAMERA_NAME_SUFFIX;
  }

  // The package camera's log prefix mirrors the syncedName seam: the parent's "Name [Model]" descriptor with the Package Camera suffix on the name, so the package's log
  // lines are attributable instead of colliding with the parent doorbell's (they share the same projection, so the base logName would render identically).
  protected override get logName(): string {

    // Derive from the live record when present, decorated with the suffixed package name; when the parent record has vanished (in the removal grace), fall back
    // to the suffixed name alone - itself non-throwing through the base syncedName seam - so a detached package timer callback names the device instead of throwing.
    const config = this.device.peek();

    return config ? describeDevice(config, { name: this.syncedName }) : this.syncedName;
  }

  // Configure the package camera.
  protected override configureDevice(): boolean {

    // The package camera inherits configureHints, which already computed every streaming hint in its own constructor pass from the shared parent MAC's feature-option
    // scope, so the only hint set here is the package-specific probesize floor - package camera streams are sparse enough that FFmpeg needs a deeper probe to lock on.
    this.hints.probesize = 32768;

    // Preserve the persisted user-state keys across the context reset: motion detection always, plus the HKSV-recording switch state when its feature is enabled. The
    // values here are the resting defaults; resetAccessoryContext keeps whatever was actually persisted and falls back to these only when nothing was. The
    // seedContextIdentity override below seeds the package's synthetic identity rather than a real MAC.
    const preserved: ProtectPersistedContextState = { detectMotion: true };

    if(this.hasFeature("Video.HKSV.Recording.Switch")) {

      preserved.hksvRecordingDisabled = false;
    }

    this.resetAccessoryContext(preserved);

    // Configure accessory information.
    this.configureInfo();

    // Configure the motion sensor.
    this.configureMotionSensor();

    // Configure the flashlight.
    this.configureFlashlight();

    // Configure the video stream when the controller has provisioned the package channel, deferring until then otherwise. configureDevice is the one caller that
    // narrates the deferral to the user - the package-channel observer's later re-attempts stay silent until one succeeds.
    if(!this.configurePackageStream()) {

      this.log.info("The package camera accessory is ready, but its video stream will become available once the controller finishes provisioning the package " +
        "camera channel.");
    }

    // We're done.
    return true;
  }

  // Seed the package camera's synthetic identity. Unlike a real device, the package camera carries no MAC of its own - it is reserved for real Protect devices - so we
  // seed the controller MAC and the parent's bare MAC as the packageCamera identity instead. Identity is re-derived every configure from the raw record, never preserved
  // across a context reset; the package is the one family whose identity is synthetic, which is why it overrides the base seeding.
  protected override seedContextIdentity(): void {

    this.accessory.context.nvr = this.nvr.ufp.mac;
    this.accessory.context.packageCamera = this.device.config.mac;
  }

  /* Configure the package camera's HomeKit video stream from the real package channel, deferring when the controller has not yet provisioned it. Idempotent through
   * the this.stream gate, exactly the parent's create-once discipline (configureStreamingDelegate): the package-channel observer re-runs this on channel arrival, and a
   * post-build dimension change wakes it too, where the gate returns and the advertised list stays frozen until a restart - the parent's identical staleness
   * envelope. Deferral also means the accessory's HomeKit camera controller is registered only once the channel exists; if a session ends before it ever arrives,
   * hap-nodejs marks the controller's persisted state purge-on-next-load, so the package's saved HKSV configuration can be purged across two such restarts - an
   * accepted, narrow caveat of defer-create (the alternative, re-registering a controller mid-life, factory-resets HKSV unconditionally). Returns whether the
   * stream is configured.
   */
  private configurePackageStream(): boolean {

    // The stream is already configured - nothing to do.
    if(this.stream) {

      return true;
    }

    // The controller has not provisioned the package channel yet. The accessory itself (motion, flashlight) is fully functional in the meantime; it simply
    // advertises no video stream until the channel arrives and the observer re-attempts.
    const profile = this.selectChannel();

    if(!profile) {

      return false;
    }

    // Synthesize the HomeKit resolution list from the package channel's fixed native top. The package camera is a single fixed channel - the resolution module seeds the
    // list with the native top itself and appends the aspect-appropriate mandated resolutions at the package frame rate, so we pass the seed once and do NOT prepend it.
    const validResolutions = buildAdvertisedResolutions({ fpsSet: [15], nativeTop: profile.resolution });

    // Inform users about our RTSP entry mapping, if we're debugging.
    if(this.hasFeature("Debug.Video.Startup")) {

      for(const entry of validResolutions) {

        this.log.info("Mapping resolution: %s.", formatResolution(entry) + " => " + formatResolution(profile.resolution));
      }
    }

    // Configure the video stream with our required resolutions. No, package cameras don't really support any of these resolutions, but they're required
    // by HomeKit in order to stream video.
    this.stream = this.platform.streamingDelegateFactory.create(this, validResolutions);

    // Fire up the controller and inform HomeKit about it.
    this.accessory.configureController(this.stream.controller);

    // Kick the supervisor so the standing timeshift buffer establishes for the package camera's streaming arm, mirroring the primary camera's stream configure.
    void this.stream.timeshift?.reconcile();

    return true;
  }

  // Configure a light accessory to turn on or off the flashlight.
  private configureFlashlight(): boolean {

    // Validate whether we should have this service enabled.
    if(!this.validService(this.hap.Service.Lightbulb, this.hasFeature("Doorbell.PackageCamera.Flashlight"), ProtectReservedNames.LIGHTBULB_PACKAGE_FLASHLIGHT)) {

      return false;
    }

    // Acquire the service.
    const service = this.acquireService(this.hap.Service.Lightbulb, this.accessoryName + " Flashlight", ProtectReservedNames.LIGHTBULB_PACKAGE_FLASHLIGHT);

    // Fail gracefully.
    if(!service) {

      this.log.error("Unable to add flashlight.");

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

      // Stop heartbeating the flashlight to allow it to turn off.
      if(!value) {

        this.clearTimer("flashlight");
        this.flashlightState = false;

        return;
      }

      // Utility function to activate the package camera's flashlight.
      const activateFlashlight = async (): Promise<boolean> => {

        // The flashlight is momentary, so this heartbeat re-issues the pulse on a timer. We assume the pulse lands and unset only if every attempt fails.
        // turnOnFlashlight throws on a failed pulse (a non-2xx, or an unreachable controller), so a failure drives a re-attempt directly - reachability is the
        // command's to report, not a second check here. We retry up to three times at a fixed one-second cadence, swallow a persistent failure to a reflected-off
        // switch (the timer re-issues), and bind this.signal so a teardown aborts an in-flight backoff and pulse.
        let lit = true;

        try {

          await retry((signal) => this.device.turnOnFlashlight({ signal }), { attempts: 3, backoff: () => 1000, signal: this.signal });
        } catch {

          lit = false;
        }

        this.flashlightState = lit;

        // Update the flashlight switch.
        service.updateCharacteristic(this.hap.Characteristic.On, this.flashlightState);

        // Stop if we've been told to turn off.
        if(!this.flashlightState) {

          this.clearTimer("flashlight");
        }

        return this.flashlightState;
      };

      // Clear out any interval we have.
      this.clearTimer("flashlight");

      // If it's not dark, the flashlight will not engage - reset the switch to off and we're done.
      if(!this.ufp.isDark) {

        // We defer the reset ~50ms so HomeKit settles the value it just set through this onSet before we reflect it back off. A synchronous
        // same-characteristic write inside its own onSet would be clobbered.
        setTimeout(() => service.updateCharacteristic(this.hap.Characteristic.On, false), 50);

        return;
      }

      // Activate the flashlight.
      await activateFlashlight();

      // Heartbeat the flashlight at regular intervals to keep it on. The controller exposes no off endpoint for this momentary command - the light
      // self-extinguishes on its own roughly 25 seconds after the last activation - so a twenty-second cadence, matching Protect's own apps, keeps
      // re-pulsing it with a five-second margin before that natural timeout.
      this.registerInterval("flashlight", () => void activateFlashlight(), 20 * 1000);
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

  // Make our RTSP stream findable.
  public override selectChannel(): Nullable<ChannelProfile> {

    const channel = this.ufp.channels.find(isPackageChannel);

    if(!channel) {

      return null;
    }

    // Return the information we need for package camera channel access. We pin lens 2 and resolve the URL host through the inherited rtspHost chain
    // (overrideAddress ?? connectionHost ?? host), so the package's RTSP URLs resolve through the same override/connection-host/controller-host
    // chain as the parent's, rather than the controller's raw address.
    return buildChannelProfile(channel, { lens: 2, rtspPort: this.nvr.ufp.ports.rtsps, urlHost: this.rtspHost });
  }

  // Resolve the channel that populates the timeshift buffer. The package camera is a single fixed channel, so it delegates to selectChannel.
  public override selectSubstrateChannel(): Nullable<ChannelProfile> {

    return this.selectChannel();
  }
}
