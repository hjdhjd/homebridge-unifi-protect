/* Copyright(C) 2019-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * camera.ts: Camera device class for UniFi Protect.
 */
import type { Camera, DeepPartial, LivestreamSource, ProtectCameraConfig, SnapshotOptions, TalkbackSession } from "unifi-protect";
import type { CharacteristicValue, Service } from "homebridge";
import { PROTECT_FFMPEG_AUDIO_FILTER_FFTNR, PROTECT_SEGMENT_RESOLUTION } from "../../settings.ts";
import type { ProtectAccessory, WithoutIdentity } from "../../types.ts";
import { buildAdvertisedProfiles, buildChannelProfile, capByPixels, formatResolution, isPrimaryChannel, rtspUrl, selectChannelProfile } from "../../media/resolution.ts";
import { capabilityGate, toStartCase } from "homebridge-plugin-utils";
import type { ChannelProfile } from "../../media/resolution.ts";
import type { DoorbellCapability } from "./doorbell.ts";
import type { LivestreamSubscription } from "../../media/livestream.ts";
import type { Nullable } from "homebridge-plugin-utils";
import type { ProtectCameraHost } from "../../media/camera-host.ts";
import type { ProtectCameraPackage } from "./camera-package.ts";
import { ProtectDevice } from "../device.ts";
import type { ProtectNvr } from "../../nvr/nvr.ts";
import { ProtectReservedNames } from "../../types.ts";
import { RtspLivestreamSubscription } from "../../media/livestream.ts";
import type { SelectRequest } from "../../media/resolution.ts";
import type { StreamingDelegate } from "../../media/stream-delegate.ts";
import { audioCapabilityAppeared } from "../../media/stream-delegate.ts";
import { doorbellReconcileAction } from "./doorbell-reconcile-policy.ts";
import { selectCamera } from "unifi-protect";
import { shouldDeliverBareMotion } from "./motion-policy.ts";

// The source discriminant threaded through the capability-reconcile and doorbell-capability methods: "construct" marks establishment (a fresh adoption or a Homebridge
// restart), "observe" a live reconcile. The establishment-only side effects - the Access lock's SECURED resting stamp, the night vision dimmer's value push and its
// "Enabling" log - branch on it; the members with no resting state ignore it.
type ReconcileSource = "construct" | "observe";

export class ProtectCamera extends ProtectDevice implements ProtectCameraHost {

  private ambientLight: number;
  private isDeleted: boolean;
  public isRinging: boolean;
  // The latched tamper state, set by the firehose router's tamper delivery (a one-way latch, like isRinging is set by the doorbell delivery) and read back by the
  // tamper-detection onGet and the availability projection. Public because its single writer is the NVR-level event dispatch, not this class.
  public isTampered: boolean;
  public detectLicensePlate: string[];
  // The composed doorbell capability, attached when (and only when) the controller reports this camera as a doorbell. Initialized to null so the field-init runs BEFORE
  // the ctor-body configureDevice that attaches it - declared and set by ProtectCamera itself, so the subclass field-wipe class does not apply.
  public doorbell: Nullable<DoorbellCapability> = null;
  private channelProfiles: ChannelProfile[];
  // Whether the doorbell ring-trigger MQTT subscription has been registered, so the one registration site (configureMqtt at construction) and the late-promotion attach
  // arm never double-register (homebridge-plugin-utils subscribe is not idempotent). Initialized to false through a field initializer, set by ProtectCamera's own
  // configureDoorbellRingMqtt after the gate passes - never inside a super constructor - so it carries no ctor-chain-computed state and the subclass field-wipe class
  // does not apply.
  #ringMqttRegistered = false;
  public stream?: StreamingDelegate;
  // Narrow the inherited projection handle to the camera projection so the read-through config getter and every this.ufp.<field> read resolve to ProtectCameraConfig.
  declare protected readonly device: Camera;

  // Create an instance.
  constructor(nvr: ProtectNvr, accessory: ProtectAccessory, device: Camera) {

    super(nvr, accessory, device);

    this.ambientLight = 0;
    this.isDeleted = false;
    this.isRinging = false;
    this.isTampered = false;
    this.detectLicensePlate = [];
    this.channelProfiles = [];

    this.configureHints();
    this.configureDevice();
    this.spawnObservers();
  }

  // Read-through to the camera projection's live STATE, narrowed to drop device identity (id/mac/modelKey). Identity flows through the dedicated non-throwing accessors
  // (protectId/modelKey/.id/.mac), never this throwing config getter; this override mirrors the base getter's body and narrows only the surfaced return type.
  public override get ufp(): Readonly<WithoutIdentity<ProtectCameraConfig>> {

    return this.device.config;
  }

  // The package camera, delegated to the doorbell capability that owns its lifecycle. Null when no doorbell capability is attached, or when an attached doorbell has no
  // package camera. This is the single seam the two external readers (event-dispatch's package-motion branch and the NVR's deviceEndpoints iterator) consume, so the
  // package's ownership can live entirely on the capability without touching either caller.
  public get packageCamera(): Nullable<ProtectCameraPackage> {

    return this.doorbell?.packageCamera ?? null;
  }

  // The host the camera's RTSP(S) URLs resolve against: the user's address override, else the camera's own controller-reported connection host, else the controller's
  // host. Protected so the package camera subclass resolves its own RTSP URLs through the exact same chain (replacing the package's former raw config.address, which
  // ignored both the override and the connection host).
  protected get rtspHost(): string {

    return this.nvr.config.overrideAddress ?? this.ufp.connectionHost ?? this.nvr.ufp.host;
  }

  // Configure device-specific settings for this device.
  protected override configureHints(): boolean {

    // Configure our parent's hints.
    super.configureHints();

    this.hints.tsbStreaming = this.hasFeature("Video.Stream.UseApi");
    this.hints.crop = this.hasFeature("Video.Crop");
    this.hints.hardwareDecoding = true;
    this.hints.hardwareTranscoding = this.hasFeature("Video.Transcode.Hardware");
    this.hints.highResSnapshots = this.hasFeature("Video.HighResSnapshots");
    this.hints.hksvRecordingIndicator = this.hasFeature("Video.HKSV.StatusLedIndicator");
    this.hints.ledStatus = this.ufp.featureFlags.hasLedStatus && this.hasFeature("Device.StatusLed");
    this.hints.logDoorbell = this.hasFeature("Log.Doorbell");
    this.hints.logHksv = this.hasFeature("Log.HKSV");
    this.hints.nightVision = this.ufp.featureFlags.hasInfrared && this.hasFeature("Device.NightVision");
    this.hints.probesize = 16384;
    this.hints.smartDetect = this.ufp.featureFlags.hasSmartDetect && this.hasFeature("Motion.SmartDetect");
    this.hints.smartDetectSensors = this.hints.smartDetect && this.hasFeature("Motion.SmartDetect.ObjectSensors");
    this.hints.transcode = this.hasFeature("Video.Transcode");
    this.hints.transcodeBitrate = this.getFeatureNumber("Video.Transcode.Bitrate") ?? -1;
    this.hints.transcodeHighLatency = this.hasFeature("Video.Transcode.HighLatency");
    this.hints.transcodeHighLatencyBitrate = this.getFeatureNumber("Video.Transcode.HighLatency.Bitrate") ?? -1;
    this.hints.twoWayAudio = this.ufp.featureFlags.hasSpeaker && this.hasFeature("Audio") && this.hasFeature("Audio.TwoWay");
    this.hints.twoWayAudioDirect = this.ufp.featureFlags.hasSpeaker && this.hasFeature("Audio") && this.hasFeature("Audio.TwoWay.Direct");

    // Sanity check our target transcoding bitrates, if defined.
    if(!this.hints.transcodeBitrate || (this.hints.transcodeBitrate <= 0)) {

      this.hints.transcodeBitrate = -1;
    }

    if(!this.hints.transcodeHighLatencyBitrate || (this.hints.transcodeHighLatencyBitrate <= 0)) {

      this.hints.transcodeHighLatencyBitrate = -1;
    }

    return true;
  }

  // Configure a camera accessory for HomeKit.
  protected configureDevice(): boolean {

    // Save our context for reference before we recreate it.
    const savedContext = this.accessory.context;

    // Clean out the context object in case it's been polluted somehow.
    this.accessory.context = {};
    this.accessory.context.detectMotion = savedContext.detectMotion ?? true;

    // Seed the identity source of truth (the persisted bare MAC) from the raw record at configure time, where the record is present - identity is not read through the
    // narrowed live-state projection.
    this.accessory.context.mac = this.device.config.mac;
    this.accessory.context.nvr = this.nvr.ufp.mac;

    if(this.hasFeature("Video.HKSV.Recording.Switch")) {

      this.accessory.context.hksvRecordingDisabled = savedContext.hksvRecordingDisabled ?? false;
    }

    if(this.hasFeature("Doorbell.Mute")) {

      this.accessory.context.doorbellMuted = savedContext.doorbellMuted ?? false;
    }

    // Inform the user that motion detection will suck.
    if(this.recordingMode === "never") {

      this.log.warn("Motion events will not be generated by the Protect controller when the controller's camera recording options are set to \"never\".");
    }

    // Check to see if we have smart motion events enabled on a supported camera.
    if(this.hints.smartDetect) {

      const smartDetectTypes = [ ...this.ufp.featureFlags.smartDetectAudioTypes, ...this.ufp.featureFlags.smartDetectTypes ];

      // Inform the user of what smart detection object types we're configured for.
      this.log.info("Smart motion detection enabled%s.", smartDetectTypes.length ? ": " + smartDetectTypes.toSorted().join(", ") : "");
    }

    // Configure accessory information.
    this.configureInfo();

    // Configure MQTT services.
    this.configureMqtt();

    // Configure the motion sensor.
    this.configureMotionSensor(this.isHksvCapable);

    // Configure smart motion contact sensors.
    this.configureMotionSmartSensor();

    // Configure the occupancy sensor.
    this.configureOccupancySensor();

    // Configure cropping.
    this.configureCrop();

    // Configure HomeKit Secure Video suport.
    this.configureHksv();
    this.configureHksvRecordingSwitch();

    // We use an IIFE here since we can't make the enclosing function asynchronous.
    (async (): Promise<void> => {

      // Reconcile the capability-gated services and the video streaming surface in parallel since they are independent operations. The construct source establishes the
      // capability resting states (it is the adoption-or-restart path), distinct from the live observe reconciles the capability observers drive later.
      await Promise.all([ this.reconcileCapabilities("construct"), this.reconcileStreaming() ]);

      // Configure our camera details.
      this.configureCameraDetails();

      // Configure our NVR recording switches.
      this.configureNvrRecordingSwitch();

      // Configure the status indicator light switch.
      this.configureStatusLedSwitch();

      // Configure the doorbell mute switch.
      this.configureDoorbellMuteSwitch();

      // Configure the doorbell trigger.
      this.configureDoorbellTrigger();
    })();

    // Attach the doorbell capability when the controller already reports this camera as a doorbell. This runs at the END of configureDevice's synchronous body, after
    // the IIFE statement: the IIFE's synchronous prefix has already kicked off reconcileStreaming, while its tail (the mute switch and trigger) runs on later
    // microtasks. The capability's configure synchronously stands up the Doorbell service (through configureDoorbellService), so the service exists before that
    // microtask tail reaches the mute-switch gate: standing up the Doorbell service synchronously ahead of the IIFE tail guarantees the mute switch sees a present
    // service. A camera the controller does not report as a doorbell attaches nothing here.
    this.reconcileDoorbellCapability("construct");

    return true;
  }

  /* Reconcile this camera's doorbell capability against the controller's live state - the single chokepoint the construction-time arm and the always-armed isDoorbell
   * observer both route through, driven by the pure doorbellReconcileAction over (hasCapability, isDoorbell). A promotion composes the capability onto the running
   * instance in place; the one HAP object that cannot change in place (the CameraController) is rebuilt by reconcileStreamingAudioCapabilities, not here, since a late
   * doorbell-ness is one of the frozen audio capabilities that reconcile watches for. The source discriminant separates the two attach contexts: at
   * construction the normal flow (the pending IIFE building the stream with the now-true flag, the IIFE tail running mute/trigger, configureMqtt registering ring) covers
   * the camera-side wiring, so the construct arm does only the capability compose; a live promotion ("observe") must additionally re-run that camera-side wiring because
   * the construction flow already ran with the flag false.
   */
  private reconcileDoorbellCapability(source: ReconcileSource): void {

    switch(doorbellReconcileAction({ hasCapability: this.doorbell !== null, isDoorbell: this.ufp.featureFlags.isDoorbell })) {

      case "attach":

        this.attachDoorbellCapability(source);

        break;

      case "report-withdrawn":

        // Promotion-only: the controller no longer reports this camera as a doorbell, but its doorbell accessories remain until the plugin restarts. We narrate
        // the withdrawal once (a settled demotion; a within-drain flap self-collapses because the reconcile re-reads live state) and remove nothing.
        this.log.warn("The controller no longer reports this camera as a doorbell; its doorbell accessories remain until UniFi Protect for HomeKit restarts.");

        break;

      case "sweep-stale":

        // A demoted-while-down doorbell reconstructs as a plain camera with no capability: remove the doorbell-only services it left behind (idempotent - a no-op on a
        // steady plain camera). The removal routes through the NVR composition root so the camera never value-imports the sibling capability class (the device-layer
        // structural-cycle-proof invariant); the Doorbell service itself is left to configureDoorbellTrigger's existing removal arm.
        this.nvr.removeStaleDoorbellServices(this.accessory);

        break;

      case "none":

        // Steady state - a doorbell with its capability (the steady plain camera resolves to the no-op "sweep-stale" instead).
        break;
    }
  }

  /* Compose the doorbell capability onto this live camera and, for a genuine live promotion, re-run the camera-side doorbell wiring the construction flow would have run
   * had the flag been true at adoption. The construct arm does only the capability compose: the normal construction flow covers everything else. The observe arm, a
   * promotion of a running plain camera, additionally: re-runs the mute switch and trigger (the construction IIFE tail already ran them while the flag was false, and the
   * Doorbell service now exists); registers the ring-trigger MQTT (a late promotion the construction configureMqtt could not have registered); and narrates the promotion
   * once. The controller rebuild a late doorbell-ness needs is no longer driven here: an isDoorbell change also wakes the featureFlags observer, so the capability
   * reconcile's reconcileStreamingAudioCapabilities rebuilds the streaming delegate when a frozen audio capability has appeared (a late doorbell-ness or a late speaker),
   * single-sourcing that rebuild across both late inputs.
   */
  private attachDoorbellCapability(source: ReconcileSource): void {

    // Construction is graph-assembly, so the camera does not new the capability itself - it asks the NVR composition root to build one (which holds zero policy, just the
    // one new) and keeps the lifecycle decision here. The camera reaches the NVR through an inherited field, never a value-import, so this call forms no module import
    // edge and the device layer stays structurally cycle-proof. The capability's configure stands up the Doorbell service through configureDoorbellService.
    this.doorbell = this.nvr.createDoorbellCapability(this, this.device, this.signal);
    this.doorbell.configure();

    // At construction the normal flow handles the camera-side wiring; only a live promotion runs the rest.
    if(source === "construct") {

      return;
    }

    // Re-run the camera's doorbell-adjacent configures now that the Doorbell service exists (the construction IIFE tail ran them while the flag was false).
    // acquireService is idempotent, so a re-run that finds the service in place is harmless.
    this.configureDoorbellMuteSwitch();
    this.configureDoorbellTrigger();

    // Register the ring-trigger MQTT subscription, which the construction configureMqtt could not have registered while the flag was false (the once-guard makes a
    // later duplicate registration a no-op).
    this.configureDoorbellRingMqtt();

    // Narrate the promotion once - today's reclassification is completely silent.
    this.log.info("The controller now reports this camera as a doorbell; its doorbell features are now available in HomeKit.");
  }

  // Publish the per-accessory observer-wake milestone for a slice the attached doorbell capability watches. The capability has no accessory identity of its own (it
  // extends ProtectBase, not ProtectDevice), so it delegates its wake attribution here. This is a thin public seam onto the inherited ProtectDevice.onObserverWake,
  // which is the single publisher - the hasSubscribers-guarded publish keyed on this camera's accessory UUID - so the capability's wakes and the camera's own wakes
  // share one publication idiom, single-sourced. Zero-cost when no diagnostics subscriber is attached.
  public publishObserverWake(key: string): void {

    this.onObserverWake(key);
  }

  // Cleanup after ourselves if we're being deleted.
  public override cleanup(): void {

    // Tear down the doorbell capability first when one is attached - releasing its package camera, its observers, and exactly its MQTT handlers - then null the handle,
    // mirroring today's doorbell.cleanup ordering (package first).
    this.doorbell?.cleanup();
    this.doorbell = null;

    // Tear down the streaming delegate and unregister its controller through the shared extraction.
    this.teardownStreamingDelegate();

    super.cleanup();

    this.isDeleted = true;
  }

  /* The camera family's observer template, effectively final: super spawns the universal base observers (name sync and device information), then spawnCameraObservers
   * spawns the family-specific set. Camera-family leaves extend spawnCameraObservers, never this template - a deliberate asymmetry with the other device families, which
   * extend spawnObservers directly. Only the camera family has a leaf-of-a-leaf (the package camera under the doorbell) that must suppress part of its parent's observer
   * set, and the seam is what lets it replace exactly the camera reactions while still inheriting the base pair. The package replaces spawnCameraObservers without a
   * super call (its own bespoke set); the doorbell's own reactions are no longer a camera subclass - they spawn through the composed DoorbellCapability's own configure,
   * keyed on the capability's signal - so the camera's set is the plain-camera set and the per-class observer count pins in the construction tests are the enforcement.
   */
  protected override spawnObservers(): void {

    super.spawnObservers();
    this.spawnCameraObservers();
  }

  // Spawn the camera's narrow-selector state observers. Each loop fires only when its watched slice changes by reference - the store's Object.is dedup is the
  // trigger, so there is no hand-diff and no held snapshot. Activity (motion, ring, smart detection, tamper) is delivered by the NVR firehose router and is deliberately
  // never re-synthesized here from device-state.
  protected spawnCameraObservers(): void {

    // Bind the by-id camera selector once and read fields off it, so each per-dispatch selector evaluation reuses the same closure rather than re-deriving it. We seed it
    // from the projection's non-throwing id rather than the throwing config, so the selector binding never depends on a present record.
    const cam = selectCamera(this.device.id);

    // The RTSP channel set and the negotiated video codec both shape the HomeKit streaming surface, so a change to either re-derives it. Two observers, not one tuple: a
    // fresh tuple would never dedup on Object.is, whereas each field dedups natively as its own slice.
    this.observeState({ key: "camera.channels", selector: state => cam(state)?.channels, title: "video streaming" }, () => void this.reconcileStreaming());
    this.observeState({ key: "camera.videoCodec", selector: state => cam(state)?.videoCodec, title: "video streaming" }, () => void this.reconcileStreaming());

    // The lifecycle state enum drives two independent reactions, so each gets its own observer on the same slice. We watch state because isOnline - and therefore the
    // device-online half of isReachable - derives from it; the controller-health half is pushed by the NVR connection loop, not observed here.
    this.observeState({ key: "camera.state", selector: state => cam(state)?.state, title: "availability" }, () => this.updateAvailability());
    this.observeState({ key: "camera.state.hksv", selector: state => cam(state)?.state, title: "HKSV" }, () => {

      // The camera's lifecycle state changed. Reconcile the timeshift against current reachability so ONE edge handles both directions: on the offline edge the
      // reconciler stops an in-flight recording through the honest terminated path (a clean isLast marker, no stall-watchdog WARN) and logs the deferred-until-online
      // notice; on the online edge it re-establishes the buffer an offline-at-startup configure could not. configureTimeshifting is concurrency-safe and idempotent - its
      // own configureRequested coalescing collapses a within-drain flap to the final value - so an already-correct state is a no-op.
      void this.stream?.hksv?.configureTimeshifting();
    });

    // The tamper-detection setting governs whether the StatusTampered characteristic exists at all; the tamper occurrence itself is a firehose event the router delivers.
    // The setting slice wakes the one capability reconcile, so a user toggling tamper detection and the controller reporting hasTamperDetection late share the same
    // chokepoint the featureFlags observer drives, rather than driving the tamper characteristic alone.
    this.observeState({ key: "camera.smartDetectSettings", selector: state => cam(state)?.smartDetectSettings, title: "tamper detection" },
      () => void this.reconcileCapabilities("observe"));

    // The remaining device-detail reactions, decomposed per field so each updates only its own characteristics and wakes only on its own slice.
    this.observeState({ key: "camera.ispSettings", selector: state => cam(state)?.ispSettings, title: "night vision" }, () => this.updateNightVision());
    this.observeState({ key: "camera.ledSettings", selector: state => cam(state)?.ledSettings, title: "the status light" }, () => this.updateStatusIndicator());
    this.observeState({ key: "camera.recordingSettings", selector: state => cam(state)?.recordingSettings, title: "recording" },
      () => this.updateRecordingSwitches());

    // A camera's doorbell-ness is temporally dynamic: the controller can provision featureFlags.isDoorbell late (a promotion) or withdraw it (a demotion). The observer
    // is always armed - it routes every flag change through the live-attach reconcile chokepoint, which composes the capability onto the running instance on a promotion
    // and narrates a settled demotion - so a construction-time doorbell and a late flip share ONE code path. The reconcile re-reads live state on each wake, so a
    // within-drain flap (true->false->true delivered in one notify) self-collapses to the final value with no churn. The package camera stays un-armed by its no-super
    // spawnCameraObservers, never spawning this observer against the shared parent record.
    this.observeState({ key: "camera.isDoorbell", selector: state => cam(state)?.featureFlags.isDoorbell, title: "doorbell status" },
      () => this.reconcileDoorbellCapability("observe"));

    // The controller can finish reporting a camera's hardware capabilities AFTER adoption - a fresh add bootstraps featureFlags incrementally. The whole-featureFlags
    // slice drives the one capability reconcile, so a capability the controller reports late is reflected live without a restart. One observer over the object slice, not
    // one per flag: the flags complete together in a single bootstrap drain, the reconcile is idempotent, and the store's structural sharing yields a new featureFlags
    // reference only on a real change. The value-selecting isDoorbell observer above dedups independently, so a flag change that does not touch isDoorbell wakes
    // only this observer.
    this.observeState({ key: "camera.featureFlags", selector: state => cam(state)?.featureFlags, title: "device capabilities" },
      () => void this.reconcileCapabilities("observe"));

    // The paired UniFi Access reader's unlock capability lives in accessDeviceMetadata, a TOP-LEVEL sibling of the camera's own featureFlags, and can complete AFTER
    // adoption (the reader pairs, or its capability finishes reporting, later). A VALUE selector over the one gating boolean - mirroring the isDoorbell observer above -
    // routes the change through the same capability reconcile chokepoint, so the lock surfaces live without a restart. A value selector, not a whole-accessDeviceMetadata
    // selector: the latter would over-fire on every bootstrap refresh that replaces the camera record wholesale, while the value dedups to the one boolean that gates the
    // lock.
    this.observeState({ key: "camera.supportUnlock", selector: state => cam(state)?.accessDeviceMetadata?.featureFlags.supportUnlock, title: "Access lock support" },
      () => void this.reconcileCapabilities("observe"));

    // Bare motion is a device-state field, not a firehose occurrence: the controller signals a raw motion start by advancing the camera record's lastMotion timestamp, so
    // the camera observes it here exactly like the sensor and light families observe their own motion state. The store seeds this observer's baseline at subscribe and
    // yields only on a subsequent advance, so a bootstrap-hydrated value or a reconnect-unchanged value never fires - the truthy guard only screens the 0/never-detected
    // case. Whether the advance actually trips the parent's MotionSensor is the bare-motion policy's decision: we fire only when smart detection is not the source of
    // truth for this camera (see shouldDeliverBareMotion). The package forward is INDEPENDENT of the parent's bare-motion de-dup above - a recording package camera has
    // no motion signal of its own, so the parent's raw motion always trips it whenever the package is recording for HKSV, regardless of whether the parent itself fired.
    this.observeState({ key: "camera.lastMotion", selector: state => cam(state)?.lastMotion, title: "motion detection" }, lastMotion => {

      if(!lastMotion) {

        return;
      }

      const featureFlags = this.ufp.featureFlags;

      const fire = shouldDeliverBareMotion({

        hksvRecording: this.stream?.hksv?.isRecording ?? false,
        smartCapable: (featureFlags.smartDetectAudioTypes.length > 0) || (featureFlags.smartDetectTypes.length > 0),
        smartDetectEnabled: this.hints.smartDetect
      });

      if(fire) {

        this.nvr.events.motionEventHandler(this);
      }

      if(this.packageCamera?.stream?.hksv?.isRecording) {

        this.nvr.events.motionEventHandler(this.packageCamera);
      }
    });
  }

  // Configure the ambient light sensor for HomeKit.
  private async configureAmbientLightSensor(): Promise<boolean> {

    // Gate the ambient light sensor on the camera's lux capability (conservative) and the user's Device.AmbientLightSensor toggle (absolute) via capabilityGate; the gate
    // sits above the poll registration below, so a hidden sensor registers no interval.
    if(!this.validService(this.hap.Service.LightSensor,
      capabilityGate({ capability: this.ufp.featureFlags.hasLuxCheck, toggle: this.hasFeature("Device.AmbientLightSensor") }))) {

      return false;
    }

    // Acquire the service.
    const service = this.acquireService(this.hap.Service.LightSensor, undefined, undefined, (lightSensorService: Service) => {

      lightSensorService.addOptionalCharacteristic(this.hap.Characteristic.StatusActive);
    });

    // Fail gracefully.
    if(!service) {

      this.log.error("Unable to add ambient light sensor.");

      return false;
    }

    // We wire the sensor on every configure rather than only on first creation. Re-binding an onGet replaces the single handler (they do not stack) and registerInterval
    // self-replaces its timer, so re-running the wiring is idempotent. That is exactly what re-establishes the handlers and the poll after a Homebridge restart, which
    // restores the cached LightSensor service but never its runtime wiring - a within-session reconcile re-run simply re-issues one cheap controller read.
    const getLux = async (): Promise<number> => {

      // Skip the query when the controller or camera is unreachable; the request would only fail.
      if(!this.isReachable) {

        return -1;
      }

      try {

        // The library validates the reading and throws on a malformed body, so any failure - unreachable mid-flight, a non-2xx, or a non-numeric reading - means "no
        // reading" and we skip the update; a genuine zero reading is floored to HomeKit's 0.0001 minimum.
        let lux = await this.device.lux();

        lux ||= 0.0001;

        return lux;
      } catch {

        return -1;
      }
    };

    // Update the ambient light sensor at regular intervals.
    const updateAmbientLight = async (): Promise<void> => {

      // Stop updating if we no longer exist.
      if(this.isDeleted) {

        this.clearTimer("ambientLight");

        return;
      }

      // Grab the current ambient light level.
      const lux = await getLux();

      // Nothing to update, we're done.
      if((this.ambientLight === lux) || (lux === -1)) {

        return;
      }

      // Update the sensor.
      service.updateCharacteristic(this.hap.Characteristic.CurrentAmbientLightLevel, this.ambientLight = lux);

      // Publish the state.
      this.publish("ambientlight", this.ambientLight.toString());
    };

    this.registerInterval("ambientLight", () => void updateAmbientLight(), 60 * 1000);

    // Retrieve the active state when requested.
    service.getCharacteristic(this.hap.Characteristic.StatusActive).onGet(() => this.isReachable);

    // Initialize the sensor's reading. We adopt only a genuine reading: a failed read (-1 - the camera unreachable, or the lux capability transiently withdrawn during a
    // controller reconnect) leaves the last-known value in place rather than stamping the HomeKit display to the floor, mirroring the 60-second poll's skip-on-(-1) guard
    // above. On the first configure there is no prior reading - the constructor seeds 0, which HomeKit cannot represent - so we floor to the minimum only in that case.
    const reading = await getLux();

    if(reading !== -1) {

      this.ambientLight = reading;
    } else if(this.ambientLight === 0) {

      this.ambientLight = 0.0001;
    }

    // Retrieve the current light level when requested.
    service.getCharacteristic(this.hap.Characteristic.CurrentAmbientLightLevel).onGet(() => this.ambientLight);

    service.updateCharacteristic(this.hap.Characteristic.CurrentAmbientLightLevel, this.ambientLight);
    service.updateCharacteristic(this.hap.Characteristic.StatusActive, this.isReachable);

    return true;
  }

  // Capture a JPEG snapshot of this camera from the controller. This is the narrow public seam onto the camera projection's snapshot command - the camera owns "take a
  // snapshot of me" while keeping the device projection encapsulated. ProtectSnapshot calls this as the Protect-API source in its multi-source acquisition. The command
  // throws on failure (a non-2xx, or a ProtectUnsupportedError when a package snapshot is requested on a camera without a package sensor); the caller treats a throw as
  // "this source failed" and falls through to the next source.
  public async snapshotFromController(opts: SnapshotOptions = {}): Promise<Buffer> {

    return this.device.snapshot(opts);
  }

  // The narrow public seam onto the camera projection's pooled livestream, mirroring snapshotFromController. We map our ChannelProfile to the `source` selector
  // (the lens=>channel-0 coercion now lives in the library), default the segment length to our 100 ms resolution (the native pool
  // also floors at 100, but the RTSP adapter would otherwise default to 1000), declare the plugin's livestream defaults (a 16384-byte chunk for lower fragmentation and
  // per-segment timestamps - both enter the pool's sharing key, so they must be passed explicitly or two plugin subscribers would silently fail to share a session),
  // preserve the friendly controller-side request label (the camera name + channel/lens), and pass the consumer's urgency closure straight
  // through to the pool's recovery/detection policy. The RTSP-debug variant is a pure-FFmpeg plugin path that produces the same Segment stream behind the same interface.
  public livestream(channelProfile: ChannelProfile, opts: { segmentLength?: number; signal?: AbortSignal; urgency?: () => number } = {}): LivestreamSubscription {

    const segmentLength = opts.segmentLength ?? PROTECT_SEGMENT_RESOLUTION;

    // The RTSP-debug path (Debug.Video.HKSV.UseRtsp) transcodes the camera's RTSP stream through FFmpeg instead of the controller's native livestream. The
    // hksv.recordingConfiguration guard establishes the precondition the adapter needs; within this block this.stream and this.stream.hksv are non-null.
    if(this.hasFeature("Debug.Video.HKSV.UseRtsp") && this.stream?.hksv?.recordingConfiguration) {

      return new RtspLivestreamSubscription({

        enableAudio: this.stream.hksv.isAudioActive,
        ffmpegOptions: this.stream.ffmpegOptions,
        recordingConfig: this.stream.hksv.recordingConfiguration,
        segmentLength: segmentLength,
        signal: opts.signal,
        url: channelProfile.url,
        videoCodec: this.ufp.videoCodec
      });
    }

    // The native pooled livestream. requestId preserves the friendly label the controller logs (name + channel, or name + "0." + lens for a secondary lens).
    const source: LivestreamSource = (channelProfile.lens !== undefined) ? { lens: channelProfile.lens, type: "lens" } :
      { channel: channelProfile.channel.id, type: "channel" };
    const requestId = this.name + ":" + ((channelProfile.lens !== undefined) ? "0." + channelProfile.lens.toString() : channelProfile.channel.id.toString());

    return this.device.livestream({ chunkSize: 16384, requestId: requestId, segmentLength: segmentLength, signal: opts.signal, source: source, timestamps: true,
      urgency: opts.urgency });
  }

  // Reboot this camera through the controller. This is the narrow public seam onto the camera projection's reboot command, mirroring snapshotFromController - the
  // camera owns "reboot me" while keeping the device projection encapsulated. The HKSV timeshift's livestream self-heal calls this to reset a wedged camera's
  // livestream endpoint after the recovery policy gives up. The command throws on failure; the caller decides how to handle a failed reboot.
  public async reboot(): Promise<void> {

    return this.device.reboot();
  }

  // Open a send-direction two-way-audio (talkback) channel to this camera's speaker. The narrow public seam onto the camera projection's talkback command, mirroring
  // snapshotFromController - the camera owns "talk to me" while keeping the device projection encapsulated. The streaming delegate's two-way-audio path opens this, then
  // drains the return-audio FFmpeg's stdout into the returned session. The command negotiates the WebSocket and connects atomically (returns a live session or throws),
  // and throws a ProtectUnsupportedError for a camera with no speaker; the caller treats a throw as "no talkback" and tears down its return-audio plumbing.
  public async talkback(opts: { signal?: AbortSignal } = {}): Promise<TalkbackSession> {

    return this.device.talkback(opts);
  }

  // Configure UniFi Access specific features for devices that are made available in Protect. The single chokepoint reconcileCapabilities routes the lock through, so a
  // paired Access reader the controller finishes reporting only after adoption surfaces the lock live, without a restart. The source separates establishment
  // (construct: a fresh adoption or a Homebridge restart) from a live reconcile (observe), which governs the resting-state stamp below.
  private configureAccessFeatures(source: ReconcileSource): boolean {

    // Read whether the lock already exists BEFORE we touch it. This is the resting-state-stamp decision input only - it does NOT gate the wiring below (the onSet
    // re-binds on every configure, which re-establishes the handler after a Homebridge restart restores the cached service but never its runtime wiring).
    const existing = this.accessory.getServiceById(this.hap.Service.LockMechanism, ProtectReservedNames.LOCK_ACCESS);

    // Whether the paired Access reader reports the unlock capability. A single optional chain: the controller reports accessDeviceMetadata only for a camera with a
    // paired reader, and the nested featureFlags is always present when the metadata is.
    const supportsUnlock = Boolean(this.ufp.accessDeviceMetadata?.featureFlags.supportUnlock);

    // Gate the lock on the paired-reader capability (conservative) and the user toggle (absolute) via capabilityGate.
    if(!this.validService(this.hap.Service.LockMechanism,
      capabilityGate({ capability: supportsUnlock, toggle: this.hasFeature("UniFi.Access.Lock") }), ProtectReservedNames.LOCK_ACCESS)) {

      return false;
    }

    // Acquire the service.
    const service = this.acquireService(this.hap.Service.LockMechanism, this.accessoryName, ProtectReservedNames.LOCK_ACCESS);

    // Fail gracefully.
    if(!service) {

      this.log.error("Unable to add lock.");

      return false;
    }

    // Configure the lock current and target state characteristics.
    service.getCharacteristic(this.hap.Characteristic.LockTargetState).onSet(async (value: CharacteristicValue) => {

      // Protect only supports unlocking. If the user taps lock while we're in the momentary unlock window, revert the optimistic SECURED target back to UNSECURED. We
      // guard on the auto re-lock timer being pending so we don't stomp a SECURED state that our own timer just wrote...registerTimeout deletes the timer map entry
      // before invoking its callback, so by the time we check, a just-fired timer is already gone and we correctly become a no-op.
      if(value === this.hap.Characteristic.LockTargetState.SECURED) {

        setTimeout(() => {

          if(!this.timers.has("accessUnlock")) {

            return;
          }

          service.updateCharacteristic(this.hap.Characteristic.LockTargetState, this.hap.Characteristic.LockTargetState.UNSECURED);
          service.updateCharacteristic(this.hap.Characteristic.LockCurrentState, this.hap.Characteristic.LockCurrentState.UNSECURED);
        }, 50);

        return;
      }

      // Unlock the Access device through the shared command-error helper.
      if(!(await this.runDeviceCommand("unlock the Access device", () => this.device.unlock()))) {

        // The command failed (the helper already reported it); revert HomeKit to its prior locked state.
        setTimeout(() => {

          service.updateCharacteristic(this.hap.Characteristic.LockTargetState, this.hap.Characteristic.LockTargetState.SECURED);
          service.updateCharacteristic(this.hap.Characteristic.LockCurrentState, this.hap.Characteristic.LockCurrentState.SECURED);
        }, 50);

        return;
      }

      // The unlock succeeded. Protect v7 no longer fires a feedback event for user-directed Access unlocks, so we drive the auto re-lock from here. HomeKit already
      // set the lock to UNSECURED as part of the set request that brought us into this handler, so we just need to schedule the re-lock.
      this.log.info("Unlocked.");

      this.registerTimeout("accessUnlock", () => {

        service.updateCharacteristic(this.hap.Characteristic.LockTargetState, this.hap.Characteristic.LockTargetState.SECURED);
        service.updateCharacteristic(this.hap.Characteristic.LockCurrentState, this.hap.Characteristic.LockCurrentState.SECURED);
      }, 2000);
    });

    // Establish the SECURED resting state on creation (a fresh adoption or a live self-heal, where no lock existed) or on the construct path (a Homebridge restart
    // restoring a cached lock, whose runtime SECURED/UNSECURED state HAP does not serialize). A LIVE reconcile over an existing lock deliberately never re-stamps the
    // display - the onSet owns it - so the reconcile can never truncate a momentary user unlock, whose optimistic UNSECURED shows with no relock timer yet armed during
    // the command round-trip (the timer arms only after the awaited unlock command resolves).
    if(!existing || (source === "construct")) {

      service.updateCharacteristic(this.hap.Characteristic.LockTargetState, this.hap.Characteristic.LockTargetState.SECURED);
      service.updateCharacteristic(this.hap.Characteristic.LockCurrentState, this.hap.Characteristic.LockCurrentState.SECURED);
    }

    return true;
  }

  // Configure discrete smart motion contact sensors for HomeKit.
  private configureMotionSmartSensor(): boolean {

    // Get any license plates the user has configured for detection, if any.
    this.detectLicensePlate = this.getFeatureValue("Motion.SmartDetect.ObjectSensors.LicensePlate")?.split("-").filter(x => x.length).map(x => x.toUpperCase()) ?? [];

    // Check if we have disabled specific license plate smart motion object contact sensors, and if so, remove them.
    for(const objectService of this.accessory.services.filter(x => x.subtype?.startsWith(ProtectReservedNames.CONTACT_MOTION_SMARTDETECT_LICENSE + "."))) {

      // Do we have smart motion detection as well as license plate telemetry available to us and is this license plate configured? If so, move on.
      if(this.ufp.featureFlags.hasSmartDetect && this.ufp.featureFlags.smartDetectTypes.includes("licensePlate") && objectService.subtype &&
        this.detectLicensePlate.includes(objectService.subtype.slice(objectService.subtype.indexOf(".") + 1))) {

        continue;
      }

      // We don't have this contact sensor enabled, remove it.
      this.accessory.removeService(objectService);
      this.log.info("Disabling smart motion license plate contact sensor: %s.", objectService.subtype?.slice(objectService.subtype.indexOf(".") + 1));
    }

    // If we don't have smart motion detection available or we have smart motion object contact sensors disabled, let's remove them.
    if(!this.hints.smartDetectSensors) {

      // Check for object-centric contact sensors that are no longer enabled and remove them.
      for(const objectService of this.accessory.services.filter(x => x.subtype?.startsWith(ProtectReservedNames.CONTACT_MOTION_SMARTDETECT + "."))) {

        // We don't have this contact sensor enabled, remove it.
        this.accessory.removeService(objectService);
        this.log.info("Disabling smart motion contact sensor: %s.", objectService.subtype?.slice(objectService.subtype.indexOf(".") + 1));
      }
    }

    // If we don't have smart motion detection, we're done.
    if(!this.ufp.featureFlags.hasSmartDetect) {

      return false;
    }

    // A utility for us to add contact sensors.
    const addSmartDetectContactSensor = (name: string, serviceId: string, errorMessage: string): boolean => {

      // Acquire the service.
      const service = this.acquireService(this.hap.Service.ContactSensor, name, serviceId);

      // Fail gracefully.
      if(!service) {

        this.log.error(errorMessage);

        return false;
      }

      // Initialize the sensor.
      service.updateCharacteristic(this.hap.Characteristic.ContactSensorState, this.hap.Characteristic.ContactSensorState.CONTACT_DETECTED);

      return true;
    };

    let enabledContactSensors = [];

    // Add individual contact sensors for each object detection type, if needed.
    if(this.hints.smartDetectSensors) {

      for(const smartDetectType of [ ...this.ufp.featureFlags.smartDetectAudioTypes, ...this.ufp.featureFlags.smartDetectTypes ].toSorted()) {

        if(addSmartDetectContactSensor(this.accessoryName + " " + toStartCase(smartDetectType),
          ProtectReservedNames.CONTACT_MOTION_SMARTDETECT + "." + smartDetectType, "Unable to add smart motion contact sensor for " + smartDetectType + " detection.")) {

          enabledContactSensors.push(smartDetectType);
        }
      }

      this.log.info("Smart motion contact sensor%s enabled: %s.", enabledContactSensors.length > 1 ? "s" : "", enabledContactSensors.join(", "));
    }

    enabledContactSensors = [];

    // Now process license plate contact sensors for individual detections.
    if(this.ufp.featureFlags.smartDetectTypes.includes("licensePlate")) {

      // Get the list of plates.
      for(const licenseOption of this.detectLicensePlate.filter(plate => plate.length)) {

        if(addSmartDetectContactSensor(this.accessoryName + " License Plate " + licenseOption,
          ProtectReservedNames.CONTACT_MOTION_SMARTDETECT_LICENSE + "." + licenseOption,
          "Unable to add smart motion license plate contact sensor for " + licenseOption + ".")) {

          enabledContactSensors.push(licenseOption);
        }
      }

      if(enabledContactSensors.length) {

        this.log.info("Smart motion license plate contact sensor%s enabled: %s.", enabledContactSensors.length > 1 ? "s" : "", enabledContactSensors.join(", "));
      }
    }

    return true;
  }

  // Reconcile the StatusTampered characteristic on the camera's motion sensor against the controller-reported tamper capability and the user setting. A
  // reconcileCapabilities leaf, so a hasTamperDetection the controller reports only after adoption surfaces the characteristic without a restart, and a user toggling
  // tamper detection prunes it.
  private configureTamperDetection(): boolean {

    const service = this.accessory.getService(this.hap.Service.MotionSensor);

    if(!service) {

      return false;
    }

    // Read prior existence side-effect-free; getCharacteristic would lazily materialize StatusTampered, defeating the conservative existence check.
    const existing = service.testCharacteristic(this.hap.Characteristic.StatusTampered);

    // Gate the characteristic with the shared additive-eager / subtractive-conservative asymmetry: the enableTamperDetection setting is the absolute toggle, the
    // hasTamperDetection hardware capability is conservative for an already-present characteristic. capabilityGate is service-agnostic, so we apply it to the
    // characteristic's existence.
    if(!capabilityGate({ capability: this.ufp.featureFlags.hasTamperDetection, toggle: this.ufp.smartDetectSettings.enableTamperDetection })(existing)) {

      if(existing) {

        service.removeCharacteristic(service.getCharacteristic(this.hap.Characteristic.StatusTampered));
      }

      // Clear the one-way tamper latch only on the genuine user toggle-off (the documented clear path); a transient capability-false must never clear an active tamper.
      if(!this.ufp.smartDetectSettings.enableTamperDetection) {

        this.isTampered = false;
      }

      return false;
    }

    // Retrieve the current tamper status when requested; materializing StatusTampered here is intentional once the gate keeps it.
    service.getCharacteristic(this.hap.Characteristic.StatusTampered).onGet(() => this.isTampered);

    return true;
  }

  // Configure a switch to mute doorbell ring events in HomeKit.
  private configureDoorbellMuteSwitch(): boolean {

    // Validate whether we should have this service enabled.
    if(!this.validService(this.hap.Service.Switch, this.hasFeature("Doorbell.Mute"), ProtectReservedNames.SWITCH_DOORBELL_MUTE) ||
      !this.accessory.getService(this.hap.Service.Doorbell)) {

      delete this.accessory.context.doorbellMuted;

      return false;
    }

    // Add the switch to the camera, if needed.
    const service = this.acquireService(this.hap.Service.Switch, this.accessoryName + " Doorbell Mute", ProtectReservedNames.SWITCH_DOORBELL_MUTE);

    // Fail gracefully.
    if(!service) {

      this.log.error("Unable to add the doorbell mute switch.");

      return false;
    }

    // Configure the switch.
    service.getCharacteristic(this.hap.Characteristic.On).onGet(() => this.accessory.context.doorbellMuted ?? false);

    service.getCharacteristic(this.hap.Characteristic.On).onSet((value: CharacteristicValue) => {

      this.accessory.context.doorbellMuted = !!value;

      this.log.info("Doorbell chime %s.", value ? "disabled" : "enabled");
    });

    // Initialize the switch.
    service.updateCharacteristic(this.hap.Characteristic.On, this.accessory.context.doorbellMuted ?? false);

    this.log.info("Enabling doorbell mute switch.");

    return true;
  }

  // Configure a switch to manually trigger a doorbell ring event for HomeKit.
  private configureDoorbellTrigger(): boolean {

    // See if we have a doorbell service configured.
    let doorbellService = this.accessory.getService(this.hap.Service.Doorbell);

    // Validate whether we should have this service enabled.
    if(!this.validService(this.hap.Service.Switch, this.hasFeature("Doorbell.Trigger"), ProtectReservedNames.SWITCH_DOORBELL_TRIGGER)) {

      // Since we aren't enabling the doorbell trigger on this camera, remove the doorbell service if the camera isn't actually doorbell-capable hardware.
      if(!this.ufp.featureFlags.isDoorbell && doorbellService) {

        this.accessory.removeService(doorbellService);
      }

      return false;
    }

    // We don't have a doorbell service configured, but since we've enabled a doorbell switch, we create the doorbell for automation purposes.
    if(!doorbellService) {

      // Configure the doorbell service.
      if(!this.configureDoorbellService()) {

        return false;
      }

      // Now find the doorbell service.
      if(!(doorbellService = this.accessory.getService(this.hap.Service.Doorbell))) {

        this.log.error("Unable to find the doorbell service.");

        return false;
      }
    }

    // Add the switch to the camera, if needed.
    const triggerService = this.acquireService(this.hap.Service.Switch, this.accessoryName + " Doorbell Trigger", ProtectReservedNames.SWITCH_DOORBELL_TRIGGER);

    // Fail gracefully.
    if(!triggerService) {

      this.log.error("Unable to add the doorbell trigger.");

      return false;
    }

    // Trigger the doorbell.
    triggerService.getCharacteristic(this.hap.Characteristic.On).onGet(() => this.isRinging);

    triggerService.getCharacteristic(this.hap.Characteristic.On).onSet((value: CharacteristicValue) => {

      if(value) {

        // Trigger the ring event.
        this.nvr.events.doorbellEventHandler(this);
        this.log.info("Doorbell ring event triggered.");

      } else {

        // If the doorbell ring event is still going, we should be as well.
        if(this.isRinging) {

          setTimeout(() => triggerService.updateCharacteristic(this.hap.Characteristic.On, true), 50);
        }
      }
    });

    // Initialize the switch.
    triggerService.updateCharacteristic(this.hap.Characteristic.On, false);

    this.log.info("Enabling doorbell automation trigger.");

    return true;
  }

  // The camera's "ensure my Doorbell service exists and is primary" seam, public so both the trigger path (configureDoorbellTrigger, when a plain camera enables the
  // automation trigger) and - from the attached capability - the doorbell attach sequence consume the one definition. HomeKit requires the Doorbell service to be the
  // primary service on the accessory.
  public configureDoorbellService(): boolean {

    // Acquire the service.
    const service = this.acquireService(this.hap.Service.Doorbell);

    // Fail gracefully.
    if(!service) {

      this.log.error("Unable to add doorbell.");

      return false;
    }

    // Add the doorbell service to this Protect doorbell. HomeKit requires the doorbell service to be marked as the primary service on the accessory.
    service.setPrimaryService(true);

    return true;
  }

  // Configure additional camera-specific characteristics for HomeKit.
  private configureCameraDetails(): boolean {

    // Find the service, if it exists.
    const service = this.accessory.getService(this.hap.Service.CameraOperatingMode);

    // Retrieve the camera status light if we have it enabled.
    const statusLight = service?.getCharacteristic(this.hap.Characteristic.CameraOperatingModeIndicator);

    if(!this.isHksvCapable || !this.hints.ledStatus) {

      if(statusLight) {

        service?.removeCharacteristic(statusLight);
      }
    } else {

      // Turn the status light on or off.
      statusLight?.onGet(() => this.statusLed);
      statusLight?.onSet(async (value: CharacteristicValue) => this.setStatusLed(!!value));

      // Initialize the status light state.
      service?.updateCharacteristic(this.hap.Characteristic.CameraOperatingModeIndicator, this.statusLed);
    }

    // Retrieve the night vision indicator if we have it enabled.
    const nightVision = service?.getCharacteristic(this.hap.Characteristic.NightVision);

    if(!this.isHksvCapable || !this.hints.nightVision) {

      if(nightVision) {

        service?.removeCharacteristic(nightVision);
      }
    } else {

      service?.getCharacteristic(this.hap.Characteristic.NightVision)?.onGet(() => this.nightVision);
      service?.getCharacteristic(this.hap.Characteristic.NightVision)?.onSet(async (value: CharacteristicValue) => {

        // Push the new night vision setting to the controller, reporting any failure through the shared command-error helper and reverting the characteristic on failure.
        if(!(await this.runDeviceCommand("set night vision to " + (value ? "auto" : "off"),
          () => this.device.update({ ispSettings: { irLedMode: value ? "auto" : "off" } })))) {

          setTimeout(() => service.updateCharacteristic(this.hap.Characteristic.NightVision, !value), 50);

          return;
        }
      });

      // Initialize the night vision state.
      service?.updateCharacteristic(this.hap.Characteristic.NightVision, this.nightVision);
    }

    return true;
  }

  // Configure cropping characteristics.
  private configureCrop(): boolean {

    // We haven't enabled cropping.
    if(!this.hints.crop) {

      return true;
    }

    // Set our cropping parameters.
    this.hints.cropOptions = {

      height: this.getFeatureNumber("Video.Crop.Height") ?? 100,
      width: this.getFeatureNumber("Video.Crop.Width") ?? 100,
      x: this.getFeatureNumber("Video.Crop.X") ?? 0,
      y: this.getFeatureNumber("Video.Crop.Y") ?? 0
    };

    // Ensure we have sane values for our crop window.
    if((this.hints.cropOptions.height < 0) || (this.hints.cropOptions.height > 100)) {

      this.hints.cropOptions.height = 100;
    }

    if((this.hints.cropOptions.width < 0) || (this.hints.cropOptions.width > 100)) {

      this.hints.cropOptions.width = 100;
    }

    if((this.hints.cropOptions.x < 0) || (this.hints.cropOptions.x > 100)) {

      this.hints.cropOptions.x = 0;
    }

    if((this.hints.cropOptions.y < 0) || (this.hints.cropOptions.y > 100)) {

      this.hints.cropOptions.y = 0;
    }

    // Inform the user.
    this.log.info("Cropping the video stream to %sx%s% starting at %sx%s%.",
      this.hints.cropOptions.width, this.hints.cropOptions.height, this.hints.cropOptions.x, this.hints.cropOptions.y);

    // Transform our percentages into decimal form for FFmpeg.
    this.hints.cropOptions.height /= 100;
    this.hints.cropOptions.width /= 100;
    this.hints.cropOptions.x /= 100;
    this.hints.cropOptions.y /= 100;

    return true;
  }

  // Reconcile the capability-gated services this camera advertises against the controller's currently-reported capabilities. The single chokepoint that runs once at
  // adoption AND live whenever a capability-bearing slice changes, so a capability the controller reports only after adoption is reflected without a restart. Today it
  // reconciles the UniFi Access lock, the night vision dimmer, the ambient light sensor, the tamper-detection characteristic, and the streaming delegate's frozen audio
  // surface (two-way audio and the doorbell sample rates, rebuilt in place when a late speaker or doorbell-ness appears); the remaining camera-family capability gates
  // fold in here as they gain their own observers. It is deliberately observeState-free - the capability observers that drive it are registered once, in
  // spawnCameraObservers. The source separates establishment (construct: a fresh adoption or a Homebridge restart) from a live reconcile (observe), which the Access
  // lock's resting-state stamp and the night vision dimmer's establishment-only push consume; the ambient light sensor, the tamper-detection characteristic, and the
  // streaming-audio reconcile ignore it. The isDeleted guard mirrors the streaming delegate's create-half: a being-removed camera must not reconcile against a vanishing
  // record.
  protected async reconcileCapabilities(source: ReconcileSource): Promise<void> {

    if(this.isDeleted) {

      return;
    }

    this.configureAccessFeatures(source);

    this.configureNightVisionDimmer(source);

    this.configureTamperDetection();

    this.reconcileStreamingAudioCapabilities();

    await this.configureAmbientLightSensor();
  }

  // Reconcile the streaming delegate's constructor-frozen audio surface against the controller's live capabilities. The CameraController's two-way audio support and its
  // recording/streaming sample rates are baked from two live-volatile inputs - the speaker-derived two-way audio hint and isDoorbell - so a camera the controller reports
  // as having a speaker (or as a doorbell) only after adoption carries a controller built for the wrong audio surface, with the talk button baked off until a restart.
  // This reconcile refreshes those hints and rebuilds the controller in place when a frozen audio capability has appeared, single-sourcing the late-doorbell controller
  // rebuild. It takes no source: the additive predicate is correct on both construct (no-op, the controller is freshly built) and observe.
  private reconcileStreamingAudioCapabilities(): void {

    // Additively refresh the speaker-derived hints, mirroring the additive rebuild below: a capability appearing raises the hint (so a deferred first stream build and
    // the runtime talkback path read it), while a transient incomplete-bootstrap drain that reports the speaker absent leaves an established hint untouched - the same
    // subtractive-conservative discipline, so a reconnect blip never disturbs two-way audio. configureHints establishes the baseline at construction; this is the only
    // live refresher. Running before the no-stream guard is what closes the deferred-build window.
    this.hints.twoWayAudio ||= this.ufp.featureFlags.hasSpeaker && this.hasFeature("Audio") && this.hasFeature("Audio.TwoWay");
    this.hints.twoWayAudioDirect ||= this.ufp.featureFlags.hasSpeaker && this.hasFeature("Audio") && this.hasFeature("Audio.TwoWay.Direct");

    // No delegate yet: the create-once path builds it from the just-refreshed hints, so there is nothing to rebuild. This also covers construction.
    if(!this.stream) {

      return;
    }

    // Rebuild the controller in place only when a frozen audio capability has appeared since it was built - the additive-eager, subtractive-conservative rising edge. A
    // capability reading false (the all-false featureFlags drain a camera delivers on every reconnect, a settled demotion) never rebuilds, so a routine reconnect
    // never flickers the controller (an HKSV reset and a stream interruption).
    if(!audioCapabilityAppeared(this.stream.builtFor, { isDoorbell: this.ufp.featureFlags.isDoorbell, twoWayAudio: this.hints.twoWayAudio })) {

      return;
    }

    this.rebuildStreamingDelegate();
  }

  // Reconcile the camera's HomeKit streaming surface: compose the always-run channel-profile derivation with the create-once delegate build. This is the single entry
  // point the channels / videoCodec observers and the construction IIFE call, so a channel or codec change re-derives the advertised list and, the first time the list
  // is non-empty, stands up the streaming delegate. A false from refreshChannelProfiles (no channels, an RTSP-enable write-through that must reconcile first, no valid
  // entries) short-circuits before any delegate build; otherwise we hand off to the synchronous create-once half.
  protected async reconcileStreaming(): Promise<boolean> {

    if(!(await this.refreshChannelProfiles())) {

      return false;
    }

    return this.configureStreamingDelegate();
  }

  // The derivation half: compute and publish the advertised channel-profile list HomeKit consumes. Always run (every channel / codec change re-derives), returns true
  // only after a non-empty list is published, false on every early-out exactly as the pre-decomposition flow did.
  private async refreshChannelProfiles(): Promise<boolean> {

    // No channels exist on this camera or we don't have access to the bootstrap configuration.
    if(!this.ufp.channels.length) {

      return false;
    }

    // Ensure RTSP is enabled on every channel. This is a write-through config change with no read-after-write: if any channel still needs RTSP, enable them all and
    // return, then let the channels observer (wired in spawnCameraObservers) re-run this method once the change reconciles, at which point every channel reads back
    // enabled and we build the stream entries below. When RTSP is already on - the common case for any existing camera and every restart - we skip the PATCH and fall
    // through synchronously, exactly as before. The reducer dedups a no-op patch, so a redundant enable could never loop the observer regardless.
    if(this.ufp.channels.some(channel => !channel.isRtspEnabled)) {

      await this.runDeviceCommand("enable RTSP on the camera's channels",
        () => this.device.update({ channels: this.ufp.channels.map(channel => ({ ...channel, isRtspEnabled: true })) }));

      return false;
    }

    // Figure out which camera channels are RTSP-enabled, and user-enabled. We also filter out any package camera entries. We deal with those independently elsewhere.
    const cameraChannels = this.ufp.channels.filter(isPrimaryChannel);

    // No RTSP streams are available that meet our criteria - we're done.
    if(!cameraChannels.length) {

      this.log.info("No RTSP profiles found for this camera. " +
        "Enable at least one RTSP profile in the UniFi Protect webUI or assign an admin role to the local Protect user you configured for use with this plugin.");

      return false;
    }

    // Build the native RTSP entries from the user-enabled primary channels, skipping any channel Protect reports with nonsensical dimensions. The resolution module
    // owns the entry construction (the friendly name, the native resolution tuple, and the SRTP URL composed against our host chain).
    const nativeEntries: ChannelProfile[] = [];

    for(const channel of cameraChannels) {

      // Sanity check in case Protect reports nonsensical resolutions.
      if(!channel.name || (channel.width <= 0) || (channel.width > 65535) || (channel.height <= 0) || (channel.height > 65535)) {

        continue;
      }

      nativeEntries.push(buildChannelProfile(channel, { rtspPort: this.nvr.ufp.ports.rtsps, urlHost: this.rtspHost }));
    }

    // Synthesize the full advertised resolution list HomeKit consumes from the native entries. The list build is preference-free: the streaming-quality preference is a
    // request-time concern selectChannel applies, not a list-construction input. The all-channels-fail-sanity empty result re-asserts the device
    // short-circuit: an advertised list of zero entries must NOT construct a streaming delegate or call configureController - we return false before reaching either.
    const advertised = buildAdvertisedProfiles(nativeEntries);

    if(!advertised.length) {

      return false;
    }

    // Publish our updated list of supported resolutions and their URLs.
    this.channelProfiles = advertised;

    return true;
  }

  // The create-once half: stand up the HomeKit streaming delegate and register its CameraController, exactly once per instance. This half is SYNCHRONOUS by design -
  // there is no await between the this.stream gate and configureController, so two concurrent callers can never both pass the gate while this.stream is undefined
  // (nothing yields between the gate and the assignment). That race-freedom invariant is load-bearing for the channels / videoCodec observers, which can both fire in
  // one drain. The isDeleted guard covers the rebuild path, which can fire reconcileStreaming on an accessory mid-removal: a being-removed camera must not
  // re-register a controller.
  private configureStreamingDelegate(): boolean {

    // If we've already configured the HomeKit video streaming delegate, we're done here.
    if(this.stream) {

      return true;
    }

    // The accessory is being removed - do not stand up a controller on it.
    if(this.isDeleted) {

      return false;
    }

    // Inform users about our RTSP entry mapping, if we're debugging.
    if(this.hasFeature("Debug.Video.Startup")) {

      for(const entry of this.channelProfiles) {

        this.log.info("Mapping resolution: %s.", formatResolution(entry.resolution) + " => " + entry.name + " [" + this.videoCodecName + "]");
      }
    }

    // Check for explicit RTSP profile preferences.
    for(const rtspProfile of [ "LOW", "MEDIUM", "HIGH" ]) {

      // Check to see if the user has requested a specific streaming profile for this camera.
      if(this.hasFeature("Video.Stream.Only." + rtspProfile)) {

        this.hints.streamingDefault = rtspProfile;
      }

      // Check to see if the user has requested a specific recording profile for this camera.
      if(this.hasFeature("Video.HKSV.Record.Only." + rtspProfile)) {

        this.hints.recordingDefault = rtspProfile;
      }
    }

    // Inform the user if we've set a streaming default.
    if(this.hints.streamingDefault) {

      this.log.info("Video streaming configured to use only: %s.", toStartCase(this.hints.streamingDefault.toLowerCase()));
    }

    // Inform the user if they've selected the legacy snapshot API.
    if(!this.hints.highResSnapshots) {

      this.log.info("Disabling the use of higher quality snapshots.");
    }

    // Configure the video stream with our resolutions.
    this.stream = this.platform.streamingDelegateFactory.create(this, this.channelProfiles.map(x => x.resolution));

    // If the user hasn't overriden our defaults, make sure we account for constrained hardware environments.
    if(!this.hints.recordingDefault) {

      switch(this.platform.codecSupport.hostSystem) {

        case "raspbian":

          // On constrained hosts like a Raspberry Pi, we default to recording from the highest-quality channel at or below 1080p. The 1920x1080 target with the
          // downward (bias-lower) nearest selection bounds the default to exactly that, so no extra pixel cap is needed. We select preference-free, not via
          // selectChannel - because the recording default must not inherit the streaming-quality preference; a user can still pin a specific channel.
          this.hints.recordingDefault = selectChannelProfile(this.channelProfiles, { bias: "lower", height: 1080, mode: "nearest", width: 1920 })?.channel.name ?? "";

          break;

        default:

          // We default to no preference for the default Protect camera channel.
          this.hints.recordingDefault = this.hints.hardwareTranscoding ? "High" : "";

          break;
      }
    } else {

      // Inform the user if we've set a recording default.
      this.log.info("HomeKit Secure Video event recording configured to use only: %s.", toStartCase(this.hints.recordingDefault.toLowerCase()));
    }

    // Fire up the controller and inform HomeKit about it.
    this.accessory.configureController(this.stream.controller);

    return true;
  }

  // Tear down this camera's streaming delegate and unregister its CameraController. Both cleanup (on deletion) and the audio-capability rebuild tear the delegate down
  // through one path: HKSV recording off, the live and timeshift consumers shut down (releasing their pool subscriptions), and the controller removed from HomeKit.
  private teardownStreamingDelegate(): void {

    // If we've got HomeKit Secure Video enabled and recording, disable it.
    if(this.stream?.hksv?.isRecording) {

      void this.stream.hksv.updateRecordingActive(false);
    }

    // Tear down this camera's livestream consumers so their pool subscriptions are released. The camera no longer owns livestream sessions - the stream (live) and
    // timeshift (HKSV) consumers own the subscriptions, and disposing them decrements the pool refcount to zero. Mirrors nvr.disconnect()'s per-camera teardown.
    this.stream?.shutdown();
    this.stream?.hksv?.timeshift.stop();

    // Unregister our controller.
    if(this.stream) {

      this.accessory.removeController(this.stream.controller);
    }
  }

  /* Rebuild the streaming delegate and its CameraController in place - the one HAP object the audio reconcile cannot mutate (its audio options, the twoWayAudio/Speaker
   * service, and the supported-configuration TLVs are constructor-frozen). reconcileStreamingAudioCapabilities calls this when a frozen audio capability has appeared - a
   * late doorbell-ness or a late speaker. The teardown's removeController runs synchronously; clearing this.stream re-opens the create-once gate; reconcileStreaming's
   * create-half (configureStreamingDelegate) lands on the next microtask after refreshChannelProfiles resolves, so remove-before-configure ordering holds, and exactly
   * one removeController plus one configureController fire here. This is today's shipped reclassification semantics - the HKSV factory reset (removeController) and
   * the supported-config hash change - preserved at exactly this transition, no longer carried by a teardown+recreate of the whole instance. The create-half's isDeleted
   * guard prevents a re-register if the accessory is removed mid-window. (It inherits today's benign fire-and-forget updateRecordingActive(false) teardown race - parity,
   * not introduced here.)
   */
  private rebuildStreamingDelegate(): void {

    this.teardownStreamingDelegate();
    this.stream = undefined;
    void this.reconcileStreaming();
  }

  // Configure HomeKit Secure Video support.
  private configureHksv(): boolean {

    // If we've enabled RTSP-based HKSV recording, warn that this is unsupported.
    if(this.hasFeature("Debug.Video.HKSV.UseRtsp")) {

      this.log.warn("Enabling RTSP-based HKSV events are for debugging purposes only and unsupported." +
        " It consumes more resources on both the Protect controller and the system running HBUP.");
    }

    // If we have smart motion events enabled, let's warn the user that things will not work quite the way they expect.
    if(this.isHksvCapable && this.hints.smartDetect) {

      this.log.warn("WARNING: Smart motion detection and HomeKit Secure Video provide overlapping functionality. " +
        "Only HomeKit Secure Video, when event recording is enabled in the Home app, will be used to trigger motion event notifications for this camera." +
        (this.hints.smartDetectSensors ? " Smart motion contact sensors will continue to function using telemetry from UniFi Protect." : ""));
    }

    return true;
  }

  // Configure a switch to manually enable or disable HKSV recording for a camera.
  private configureHksvRecordingSwitch(): boolean {

    // Validate whether we should have this service enabled.
    if(!this.validService(this.hap.Service.Switch, this.hasFeature("Video.HKSV.Recording.Switch"), ProtectReservedNames.SWITCH_HKSV_RECORDING)) {

      // Remove our stateful context since it's unneeded.
      delete this.accessory.context.hksvRecordingDisabled;

      return false;
    }

    // Acquire the service.
    const service = this.acquireService(this.hap.Service.Switch, this.accessoryName + " HKSV Recording", ProtectReservedNames.SWITCH_HKSV_RECORDING);

    // Fail gracefully.
    if(!service) {

      this.log.error("Unable to add HKSV recording switch.");

      return false;
    }

    // Activate or deactivate HKSV recording.
    service.getCharacteristic(this.hap.Characteristic.On).onGet(() => !this.accessory.context.hksvRecordingDisabled);

    service.getCharacteristic(this.hap.Characteristic.On).onSet((value: CharacteristicValue) => {

      if(this.accessory.context.hksvRecordingDisabled !== !value) {

        this.log.info("HKSV event recording %s.", value ? "enabled" : "disabled");
      }

      this.accessory.context.hksvRecordingDisabled = !value;
    });

    // Initialize the switch.
    service.updateCharacteristic(this.hap.Characteristic.On, !(this.accessory.context.hksvRecordingDisabled ?? false));

    this.log.info("Enabling HKSV recording switch.");

    return true;
  }

  // Configure a dimmer to turn the camera's night vision on or off and adjust its sensitivity for HomeKit. The single chokepoint reconcileCapabilities routes the dimmer
  // through, so the adjustable infrared hardware the controller finishes reporting only after adoption surfaces the dimmer live, without a restart. The source separates
  // establishment (construct: a fresh adoption or a Homebridge restart) from a live reconcile (observe), which governs the establishment-only value push below.
  private configureNightVisionDimmer(source: ReconcileSource): boolean {

    // Read whether the dimmer already exists BEFORE we touch it. This is the establishment-push decision input only - it does NOT gate the wiring below (the onGet/onSet
    // re-bind on every configure, which re-establishes the handlers after a Homebridge restart restores the cached service but never its runtime wiring).
    const existing = this.accessory.getServiceById(this.hap.Service.Lightbulb, ProtectReservedNames.LIGHTBULB_NIGHTVISION);

    // The camera's adjustable night vision hardware: an infrared cut filter plus the ICR sensitivity control. Both must be present for the dimmer to mean anything.
    const hasNightVisionHardware = this.ufp.featureFlags.hasInfrared && this.ufp.featureFlags.hasIcrSensitivity;

    // Gate the dimmer on the camera's adjustable night vision hardware (conservative) and the user's Device.NightVision.Dimmer toggle (absolute) via capabilityGate.
    if(!this.validService(this.hap.Service.Lightbulb,
      capabilityGate({ capability: hasNightVisionHardware, toggle: this.hasFeature("Device.NightVision.Dimmer") }), ProtectReservedNames.LIGHTBULB_NIGHTVISION)) {

      return false;
    }

    // Acquire the service.
    const service = this.acquireService(this.hap.Service.Lightbulb, this.accessoryName + " Night Vision", ProtectReservedNames.LIGHTBULB_NIGHTVISION);

    // Fail gracefully.
    if(!service) {

      this.log.error("Unable to add the night vision dimmer.");

      return false;
    }

    // Adjust night vision capabilities.
    service.getCharacteristic(this.hap.Characteristic.On).onGet(() => this.nightVision);

    service.getCharacteristic(this.hap.Characteristic.On).onSet(async (value: CharacteristicValue) => {

      // A command targeting a camera whose controller record has vanished (an unadopt lingering in the removal grace) cannot be fulfilled, so we no-op gracefully rather
      // than throwing on the live-config read below.
      if(!this.recordPresent) {

        return;
      }

      if(this.nightVision !== value) {

        this.log.info("Night vision %s.", value ? "enabled" : "disabled");
      }

      let mode: string;

      switch(service.getCharacteristic(this.hap.Characteristic.Brightness).value) {

        case 5:

          mode = "autoFilterOnly";

          break;

        case 10:

          mode = "auto";

          break;

        default:

          mode = [ "autoFilterOnly", "customFilterOnly" ].includes(this.ufp.ispSettings.irLedMode) ? "customFilterOnly" : "custom";

          break;
      }

      // Push the new night vision setting to the controller, reporting any failure through the shared command-error helper and reverting the characteristic on failure.
      if(!(await this.runDeviceCommand("set night vision to " + (value ? mode : "off"),
        () => this.device.update({ ispSettings: { irLedMode: value ? mode : "off" } })))) {

        setTimeout(() => service.updateCharacteristic(this.hap.Characteristic.On, !value), 50);

        return;
      }
    });

    // Adjust the sensitivity of night vision.
    service.getCharacteristic(this.hap.Characteristic.Brightness).onGet(() => this.nightVisionBrightness);

    service.getCharacteristic(this.hap.Characteristic.Brightness).onSet(async (value: CharacteristicValue) => {

      // A command targeting a camera whose controller record has vanished cannot be fulfilled, so we no-op gracefully rather than throwing on the live-config read below.
      if(!this.recordPresent) {

        return;
      }

      let level = value as number;
      let nightvision: DeepPartial<ProtectCameraConfig> = {};

      // If we're less than 5% in brightness, assume we want to disable night vision.
      if(level < 5) {

        level = 0;
      }

      // If we're greater than 5%, but less than 10%, assume we want to set night vision to autoFilterOnly.
      if((level > 5) && (level < 10)) {

        level = 5;
      }

      // If we're greater than 10%, but less than 20%, assume we want to set night vision to auto.
      if((level > 10) && (level < 20)) {

        level = 10;
      }

      // If we're more than 90% in brightness, assume we want to force night vision to be always on.
      if(level > 90) {

        level = 100;
      }

      // Let's determine what we're setting on the Protect device.
      switch(level) {

        case 0:

          nightvision = { ispSettings:{ irLedMode: "off" } };

          break;

        case 5:

          nightvision = { ispSettings:{ irLedMode: "autoFilterOnly" } };

          break;

        case 10:

          nightvision = { ispSettings:{ irLedMode: "auto" } };

          break;

        case 100:

          nightvision = { ispSettings:{ irLedMode: "on" } };

          break;

        default:

          level = Math.round((level - 20) / 7);
          nightvision = {

            ispSettings: {

              icrCustomValue: level,
              irLedMode: [ "autoFilterOnly", "customFilterOnly" ].includes(this.ufp.ispSettings.irLedMode) ? "customFilterOnly" : "custom"
            }
          };
          level = (level * 7) + 20;

          break;
      }

      // Push the new night vision settings to the controller, reporting any failure through the shared command-error helper.
      if(!(await this.runDeviceCommand("adjust the night vision settings", () => this.device.update(nightvision)))) {

        return;
      }

      // Make sure we properly reflect what brightness we're actually at, given the differences in setting granularity between Protect and HomeKit.
      setTimeout(() => service.updateCharacteristic(this.hap.Characteristic.Brightness, level), 50);
    });

    // Establish the dimmer at startup (a fresh adoption or create, or a restart's construct) only - never on a live reconcile re-run. The camera.ispSettings observer
    // already maintains the displayed value, and re-pushing the device's reading during an in-flight night-vision command would momentarily stomp the user's optimistic
    // setting; the once-per-boot "Enabling" log (a default-off feature the user turned on) rides the same gate so it prints at every startup but never on a reconnect.
    if(!existing || (source === "construct")) {

      service.updateCharacteristic(this.hap.Characteristic.On, this.nightVision);
      service.updateCharacteristic(this.hap.Characteristic.Brightness, this.nightVisionBrightness);

      this.log.info("Enabling night vision dimmer.");
    }

    return true;
  }

  // Configure a series of switches to manually enable or disable recording on the UniFi Protect controller for a camera.
  private configureNvrRecordingSwitch(): boolean {

    const switchesEnabled = [];

    // The Protect controller supports three modes for recording on a camera: always, detections, and never. We create switches for each of the modes.
    for(const ufpRecordingSwitchType of
      [  ProtectReservedNames.SWITCH_UFP_RECORDING_ALWAYS, ProtectReservedNames.SWITCH_UFP_RECORDING_DETECTIONS, ProtectReservedNames.SWITCH_UFP_RECORDING_NEVER ]) {

      const ufpRecordingSetting = ufpRecordingSwitchType.slice(ufpRecordingSwitchType.lastIndexOf(".") + 1);

      // Validate whether we should have this service enabled.
      if(!this.validService(this.hap.Service.Switch, this.hasFeature("Nvr.Recording.Switch"), ufpRecordingSwitchType)) {

        continue;
      }

      const switchName = this.accessoryName + " UFP Recording " + toStartCase(ufpRecordingSetting);

      // Acquire the service.
      const service = this.acquireService(this.hap.Service.Switch, switchName, ufpRecordingSwitchType);

      // Fail gracefully.
      if(!service) {

        this.log.error("Unable to add UniFi Protect recording switches.");

        continue;
      }

      // Activate or deactivate the appropriate recording mode on the Protect controller.
      service.getCharacteristic(this.hap.Characteristic.On).onGet(() => this.recordingMode === ufpRecordingSetting);

      service.getCharacteristic(this.hap.Characteristic.On).onSet(async (value: CharacteristicValue) => {

        // A command targeting a camera whose controller record has vanished cannot be fulfilled, so we no-op gracefully rather than throwing on the live-config reads
        // below.
        if(!this.recordPresent) {

          return;
        }

        // We only want to do something if we're being activated. Turning off the switch would really be an undefined state given that there are three different
        // settings one can choose from. Instead, we do nothing and leave it to the user to choose what state they really want to set.
        if(!value) {

          setTimeout(() => this.updateDevice(), 50);

          return;
        }

        // Push the new recording mode to the controller, reporting any failure through the shared command-error helper. We build the payload immutably - spreading the
        // read-through recordingSettings with mode overridden preserves the exact wire shape the controller expects without mutating the live (read-only) config record.
        if(!(await this.runDeviceCommand("set the recording mode to " + ufpRecordingSetting,
          () => this.device.update({ recordingSettings: { ...this.ufp.recordingSettings, mode: ufpRecordingSetting } })))) {

          return;
        }

        // Update all the other recording switches.
        for(const otherUfpSwitch of
          [ ProtectReservedNames.SWITCH_UFP_RECORDING_ALWAYS, ProtectReservedNames.SWITCH_UFP_RECORDING_DETECTIONS, ProtectReservedNames.SWITCH_UFP_RECORDING_NEVER ]) {

          // Don't update ourselves a second time.
          if(ufpRecordingSwitchType === otherUfpSwitch) {

            continue;
          }

          // Update the other recording switches.
          this.accessory.getServiceById(this.hap.Service.Switch, otherUfpSwitch)?.updateCharacteristic(this.hap.Characteristic.On, false);
        }

        // Inform the user, and we're done.
        this.log.info("UniFi Protect recording mode set to %s.", ufpRecordingSetting);
      });

      // Initialize the recording switch state.
      service.updateCharacteristic(this.hap.Characteristic.On, this.recordingMode === ufpRecordingSetting);
      switchesEnabled.push(ufpRecordingSetting);
    }

    if(switchesEnabled.length) {

      this.log.info("Enabling UniFi Protect recording switches: %s.", switchesEnabled.join(", "));
    }

    return true;
  }

  // Configure MQTT capabilities of this camera.
  protected configureMqtt(): boolean {

    // Return the RTSP URLs when requested.
    this.subscribeGet("rtsp", "RTSP information", (): string => {

      // Grab all the available RTSP channels and return them as a JSON. The SRTP-enabled RTSPS URL is composed through the shared rtspUrl SSOT (secure by default) over
      // the secure rtsps port - the same composer and host chain the streaming path uses, so the published catalog cannot drift from the URL FFmpeg actually connects to.
      return JSON.stringify(Object.assign({}, ...this.fromRecord((config) => config.channels, []).filter(channel => channel.isRtspEnabled)
        .map(channel => ({ [channel.name]: rtspUrl(channel, this.rtspHost, this.nvr.ufp.ports.rtsps) }))));
    });

    // Trigger snapshots when requested.
    this.subscribeSet("snapshot", "snapshot trigger", (value: string) => {

      // When we get the right message, we trigger the snapshot request.
      if(value !== "true") {

        return;
      }

      void this.stream?.handleSnapshotRequest();
    });

    // Register the doorbell ring-trigger subscription, gated and once-guarded so a late promotion can register it without the construction call double-subscribing.
    this.configureDoorbellRingMqtt();

    return true;
  }

  // Register the doorbell ring-trigger MQTT subscription, exactly once, when the camera is a Protect doorbell or the user enabled the doorbell trigger.
  // homebridge-plugin-utils subscribe is not idempotent, so the registered-once guard prevents a double-subscription across the two call sites (configureMqtt at
  // construction, and the attach arm for a late promotion). The guard is set ONLY after the gate passes and the registration happens, so a no-op construction call on a
  // plain camera (gate false) does not latch it - the later attach-time registration must not be suppressed.
  private configureDoorbellRingMqtt(): void {

    if(this.#ringMqttRegistered) {

      return;
    }

    if(!(this.ufp.featureFlags.isDoorbell || this.hasFeature("Doorbell.Trigger"))) {

      return;
    }

    // Trigger doorbell when requested.
    this.subscribeSet("doorbell", "doorbell ring trigger", (value: string) => {

      // When we get the right message, we trigger the doorbell request.
      if(value !== "true") {

        return;
      }

      this.nvr.events.doorbellEventHandler(this);
    });

    this.#ringMqttRegistered = true;
  }

  // Refresh camera-specific characteristics. Composes the per-concern updaters below; retained as the public entry point for external callers (the recording-switch
  // onSet handler) and as the "refresh everything" sweep. The per-field observers call the individual updaters directly, so each wakes and writes only
  // its own slice; this composition re-applies them all at once.
  public updateDevice(): boolean {

    this.updateAvailability();
    this.updateNightVision();
    this.updateStatusIndicator();
    this.updateRecordingSwitches();

    // Compose the attached doorbell capability's refresh (the physical-chime push) when one is present.
    this.doorbell?.updateDevice();

    return true;
  }

  // Push the availability projection: StatusActive on the motion and light sensors (the device-online half of reachability), plus a re-apply of the latched
  // tamper state when the motion sensor actually carries StatusTampered. We guard that re-apply behind testCharacteristic because updateCharacteristic routes
  // through getCharacteristic, which lazily materializes an absent optional characteristic - an unguarded write would sprout an always-false phantom
  // StatusTampered onto a camera without tamper detection. Guarding it mirrors how the sensor family fans StatusTampered out, and it lets this one base
  // projection serve the package camera too: the package configures no tamper characteristic and carries no light sensor, so the guarded base produces exactly
  // the package's surface and the package needs no override of its own. Driven by the lifecycle-state observer, which the package camera spawns independently
  // against the shared physical device's state.
  protected updateAvailability(): void {

    const motionSensor = this.accessory.getService(this.hap.Service.MotionSensor);

    motionSensor?.updateCharacteristic(this.hap.Characteristic.StatusActive, this.isReachable);

    if(motionSensor?.testCharacteristic(this.hap.Characteristic.StatusTampered)) {

      motionSensor.updateCharacteristic(this.hap.Characteristic.StatusTampered, this.isTampered);
    }

    this.accessory.getService(this.hap.Service.LightSensor)?.updateCharacteristic(this.hap.Characteristic.StatusActive, this.isReachable);
  }

  // Push the night-vision characteristics from the camera's ISP settings: the operating-mode indicator and, when the dimmer is enabled, its on/brightness state. Driven
  // by the ispSettings observer.
  protected updateNightVision(): void {

    if(this.hints.nightVision) {

      this.accessory.getService(this.hap.Service.CameraOperatingMode)?.updateCharacteristic(this.hap.Characteristic.NightVision, this.nightVision);
    }

    if(this.hasFeature("Device.NightVision.Dimmer")) {

      this.accessory.getServiceById(this.hap.Service.Lightbulb, ProtectReservedNames.LIGHTBULB_NIGHTVISION)?.
        updateCharacteristic(this.hap.Characteristic.On, this.nightVision);

      this.accessory.getServiceById(this.hap.Service.Lightbulb, ProtectReservedNames.LIGHTBULB_NIGHTVISION)?.
        updateCharacteristic(this.hap.Characteristic.Brightness, this.nightVisionBrightness);
    }
  }

  // Push the status-indicator state from the camera's LED settings: the operating-mode indicator and the standalone status-LED switch. Driven by the ledSettings
  // observer.
  protected updateStatusIndicator(): void {

    if(this.hints.ledStatus) {

      this.accessory.getService(this.hap.Service.CameraOperatingMode)?.updateCharacteristic(this.hap.Characteristic.CameraOperatingModeIndicator, this.statusLed);
    }

    if(this.hasFeature("Device.StatusLed.Switch")) {

      this.accessory.getServiceById(this.hap.Service.Switch, ProtectReservedNames.SWITCH_STATUS_LED)?.
        updateCharacteristic(this.hap.Characteristic.On, this.statusLed);
    }
  }

  // Push the UniFi Protect recording-mode switch states from the camera's recording settings, when those switches are configured. Driven by the recordingSettings
  // observer.
  protected updateRecordingSwitches(): void {

    if(!this.hasFeature("Nvr.Recording.Switch")) {

      return;
    }

    // Reflect the active recording mode across the three mutually-exclusive switches.
    for(const ufpRecordingSwitchType of
      [ ProtectReservedNames.SWITCH_UFP_RECORDING_ALWAYS, ProtectReservedNames.SWITCH_UFP_RECORDING_DETECTIONS, ProtectReservedNames.SWITCH_UFP_RECORDING_NEVER ]) {

      const ufpRecordingSetting = ufpRecordingSwitchType.slice(ufpRecordingSwitchType.lastIndexOf(".") + 1);

      this.accessory.getServiceById(this.hap.Service.Switch, ufpRecordingSwitchType)?.
        updateCharacteristic(this.hap.Characteristic.On, ufpRecordingSetting === this.recordingMode);
    }
  }

  // Find a streaming RTSP configuration for a given target resolution. This is the device wrapper over the pure selectChannelProfile: it injects our published entries
  // and our this-state (the streaming default, which pins to a named channel, and the optional hardware pixel cap), then delegates the selection mathematics. The pixel
  // cap is applied as a mode-agnostic pre-filter BEFORE selection - intentionally a pre-filter, not part of the request, so it filters the name branch too (a
  // constrained request with an explicit profile preference still drops profiles above the cap); a future reader should not move it into the request.
  public selectChannel(width: number, height: number, opts?: { biasHigher?: boolean; maxPixels?: number }): Nullable<ChannelProfile> {

    const entries = capByPixels(this.channelProfiles, opts?.maxPixels);
    const request: SelectRequest = this.hints.streamingDefault ? { mode: "name", name: this.hints.streamingDefault } :
      { bias: opts?.biasHigher ? "higher" : "lower", height: height, mode: "nearest", width: width };

    return selectChannelProfile(entries, request);
  }

  // Find a recording RTSP configuration for a given target resolution. The recording wrapper biases higher (transcoding wants a higher-quality input), pins on the
  // recording default rather than the streaming default, and applies the "record"-context hardware source ceiling from FfmpegOptions (single-sourced with the
  // recording encoder choice). Inert today: maxSourcePixels("record") is Infinity on every host (HKSV software-encodes wherever a pixel cap would apply), so capByPixels
  // passes everything through; it engages only when a future predicate change hardware-encodes recording on a pixel-limited host, flipping with the encoder.
  public selectRecordingChannel(width: number, height: number): Nullable<ChannelProfile> {

    const entries = capByPixels(this.channelProfiles, this.stream?.ffmpegOptions.maxSourcePixels("record"));
    const request: SelectRequest = this.hints.recordingDefault ? { mode: "name", name: this.hints.recordingDefault } :
      { bias: "higher", height: height, mode: "nearest", width: width };

    return selectChannelProfile(entries, request);
  }

  // Utility property to return the camera's current video codec, formatted for display.
  public get videoCodecName(): string {

    return (this.ufp.videoCodec.replace("h265", "hevc")).toUpperCase();
  }

  // Utility property to return whether the camera is HKSV capable or not.
  public get isHksvCapable(): boolean {

    return (!this.ufp.isThirdPartyCamera && !this.ufp.isAdoptedByAccessApp) || (this.ufp.isThirdPartyCamera && this.ufp.isPairedWithAiPort);
  }

  // The active recording mode, read non-throwing through the record. An absent record (a camera in the removal grace) reports an empty mode - which matches none
  // of the three recording switches - rather than throwing; the onGet, the initial write, and the reactive push all read this single source.
  private get recordingMode(): string {

    return this.fromRecord((config) => config.recordingSettings.mode, "");
  }

  // Utility property to return the current night vision state of a camera. It's a blunt instrument due to HomeKit constraints. An absent record reports off rather than
  // throwing.
  private get nightVision(): boolean {

    return this.fromRecord((config) => config.ispSettings.irLedMode !== "off", false);
  }

  // Utility property to return the current night vision state of a camera, mapped to a brightness characteristic. An absent record reports 0 rather than throwing.
  private get nightVisionBrightness(): number {

    return this.fromRecord((config) => {

      switch(config.ispSettings.irLedMode) {

        case "off":

          return 0;

        case "autoFilterOnly":

          return 5;

        case "auto":

          return 10;

        case "on":

          return 100;

        case "custom":
        case "customFilterOnly":

          // The Protect infrared cutoff removal setting ranges from 0 - 10. HomeKit expects percentages, so we convert it like so.
          return (config.ispSettings.icrCustomValue * 7) + 20;

        default:

          this.log.error("Unknown night vision value detected: %s.", config.ispSettings.irLedMode);

          return 0;
      }
    }, 0);
  }

  // Return the audio filter pipeline for this camera. The optional sampleRate parameter (in Hz) is used to validate that filter frequencies don't exceed the Nyquist
  // limit (half the sample rate)...filters above Nyquist are physically impossible to apply and cause FFmpeg to reject them.
  public getAudioFilters(sampleRate?: number): string[] {

    // If we don't have audio filtering enabled, we're done.
    if(!this.hasFeature("Audio.Filter.Noise")) {

      return [];
    }

    const afOptions: string[] = [];
    const nyquist = sampleRate ? sampleRate / 2 : undefined;

    // See what the user has set for the afftdn filter for this camera.
    let fftNr = this.getFeatureFloat("Audio.Filter.Noise.FftNr") ?? PROTECT_FFMPEG_AUDIO_FILTER_FFTNR;

    // If we have an invalid setting, use the defaults.
    fftNr = Math.max(0.01, Math.min(97, fftNr));

    const highpass = this.getFeatureNumber("Audio.Filter.Noise.HighPass");
    const lowpass = this.getFeatureNumber("Audio.Filter.Noise.LowPass");

    // We use the following order of operations for our filter: highpass, then lowpass, and finally afftdn. Filters at or above the Nyquist limit are skipped...there's no
    // representable frequency content to operate on.
    if((typeof highpass === "number") && (!nyquist || (highpass < nyquist))) {

      afOptions.push("highpass=p=2:f=" + highpass.toString());
    }

    if((typeof lowpass === "number") && (!nyquist || (lowpass < nyquist))) {

      afOptions.push("lowpass=p=2:f=" + lowpass.toString());
    }

    // The afftdn filter options we use are:
    //
    // nt=c  Use the custom noise profile that we've measured for two seconds at the beginning of our session.
    // tn=1  Enable noise tracking.
    // nr=X  Noise reduction value in decibels.
    afOptions.push("asendcmd=c='1.0 afftdn sn start ; 3.0 afftdn sn stop', afftdn=nt=c:tn=1:nr=" + fftNr.toString());

    return afOptions;
  }
}
