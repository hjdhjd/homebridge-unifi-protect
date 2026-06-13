/* Copyright(C) 2019-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-camera.ts: Camera device class for UniFi Protect.
 */
import type { Camera, DeepPartial, LivestreamSource, ProtectCameraConfig, SnapshotOptions, TalkbackSession } from "unifi-protect";
import type { CharacteristicValue, Service } from "homebridge";
import { PROTECT_FFMPEG_AUDIO_FILTER_FFTNR, PROTECT_SEGMENT_RESOLUTION } from "../settings.ts";
import { ProtectReservedNames, doorbellReconcileAction } from "../types.ts";
import { buildAdvertisedProfiles, buildChannelProfile, capByPixels, formatResolution, isPrimaryChannel, selectChannelProfile } from "./resolution.ts";
import type { ChannelProfile } from "./resolution.ts";
import type { DoorbellCapability } from "./doorbell.ts";
import type { LivestreamSubscription } from "../livestream.ts";
import type { Nullable } from "homebridge-plugin-utils";
import type { ProtectAccessory } from "../types.ts";
import type { ProtectCameraHost } from "../camera-host.ts";
import type { ProtectCameraPackage } from "./camera-package.ts";
import { ProtectDevice } from "./device.ts";
import type { ProtectNvr } from "../nvr.ts";
import { RtspLivestreamSubscription } from "../livestream.ts";
import type { SelectRequest } from "./resolution.ts";
import type { StreamingDelegate } from "../stream-delegate.ts";
import { selectCamera } from "unifi-protect";
import { toStartCase } from "homebridge-plugin-utils";

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
  // arm never double-register (HBPU subscribe is not idempotent). Initialized to false through a field initializer, set by ProtectCamera's own configureDoorbellRingMqtt
  // after the gate passes - never inside a super constructor - so it carries no ctor-chain-computed state and the subclass field-wipe class does not apply.
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

  // Read-through config, narrowed to the camera projection's config record.
  public override get ufp(): Readonly<ProtectCameraConfig> {

    return this.device.config;
  }

  // The package camera, delegated to the doorbell capability that owns its lifecycle. Null when no doorbell capability is attached, or when an attached doorbell has no
  // package camera. This is the single seam the two external readers (event-dispatch's package-motion branch and the NVR's deviceEndpoints iterator) consume, so the
  // package's ownership can live entirely on the capability without touching either caller.
  public get packageCamera(): Nullable<ProtectCameraPackage> {

    return this.doorbell?.packageCamera ?? null;
  }

  // The host the camera's RTSP(S) URLs resolve against: the user's address override, else the camera's own controller-reported connection host, else the controller's
  // host. Protected so the package camera subclass resolves its own RTSP URLs through the exact same chain (the 3b-iii URL-host reconcile, replacing the package's
  // former raw config.address, which ignored both the override and the connection host).
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
    this.accessory.context.mac = this.ufp.mac;
    this.accessory.context.nvr = this.nvr.ufp.mac;

    if(this.hasFeature("Video.HKSV.Recording.Switch")) {

      this.accessory.context.hksvRecordingDisabled = savedContext.hksvRecordingDisabled ?? false;
    }

    if(this.hasFeature("Doorbell.Mute")) {

      this.accessory.context.doorbellMuted = savedContext.doorbellMuted ?? false;
    }

    // Inform the user that motion detection will suck.
    if(this.ufp.recordingSettings.mode === "never") {

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

    // Configure tamper detection.
    this.configureTamperDetection();

    // Configure smart motion contact sensors.
    this.configureMotionSmartSensor();

    // Configure the occupancy sensor.
    this.configureOccupancySensor();

    // Configure UniFi Access specific features on supported devices such as lock mechanisms that cohabitate on the same controller as Protect.
    this.configureAccessFeatures();

    // Configure cropping.
    this.configureCrop();

    // Configure HomeKit Secure Video suport.
    this.configureHksv();
    this.configureHksvRecordingSwitch();

    // We use an IIFE here since we can't make the enclosing function asynchronous.
    (async (): Promise<void> => {

      // Configure the ambient light sensor and video stream in parallel since they are independent operations.
      await Promise.all([ this.configureAmbientLightSensor(), this.reconcileStreaming() ]);

      // Configure our camera details.
      this.configureCameraDetails();

      // Configure our NVR recording switches.
      this.configureNvrRecordingSwitch();

      // Configure the status indicator light switch.
      this.configureStatusLedSwitch();

      // Configure the night vision indicator light switch.
      this.configureNightVisionDimmer();

      // Configure the doorbell mute switch.
      this.configureDoorbellMuteSwitch();

      // Configure the doorbell trigger.
      this.configureDoorbellTrigger();
    })();

    // Attach the doorbell capability when the controller already reports this camera as a doorbell. This runs at the END of configureDevice's synchronous body, after
    // the IIFE statement: the IIFE's synchronous prefix has already kicked off reconcileStreaming, while its tail (the mute switch and trigger) runs on later
    // microtasks. The capability's configure synchronously stands up the Doorbell service (through configureDoorbellService), so the service exists before that
    // microtask tail reaches the mute-switch gate - exactly the ordering the pre-collapse doorbell subclass guaranteed by standing up the Doorbell service synchronously
    // ahead of the IIFE. A camera the controller does not report as a doorbell attaches nothing here.
    this.reconcileDoorbellCapability("construct");

    return true;
  }

  /* Reconcile this camera's doorbell capability against the controller's live state - the single chokepoint the construction-time arm and the always-armed isDoorbell
   * observer both route through, driven by the pure doorbellReconcileAction over (hasCapability, isDoorbell). The live-attach replaces the former teardown+recreate: a
   * promotion composes the capability onto the running instance in place, rebuilding only the one HAP object that cannot change in place (the CameraController) and only
   * when it was genuinely built for the wrong doorbell-ness. The source discriminant separates the two attach contexts: at construction the normal flow (the pending
   * IIFE building the stream with the now-true flag, the IIFE tail running mute/trigger, configureMqtt registering ring) covers the camera-side wiring, so the construct
   * arm does only the capability compose; a live promotion ("observe") must additionally re-run that camera-side wiring because the construction flow already ran with
   * the flag false.
   */
  private reconcileDoorbellCapability(source: "construct" | "observe"): void {

    switch(doorbellReconcileAction({ hasCapability: this.doorbell !== null, isDoorbell: this.ufp.featureFlags.isDoorbell })) {

      case "attach":

        this.attachDoorbellCapability(source);

        break;

      case "report-withdrawn":

        // Promotion-only by HJD ruling: the controller no longer reports this camera as a doorbell, but its doorbell accessories remain until HBUP restarts. We narrate
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

        // Steady state - a doorbell with its capability, or a plain camera with none.
        break;
    }
  }

  /* Compose the doorbell capability onto this live camera and, for a genuine live promotion, re-run the camera-side doorbell wiring the construction flow would have run
   * had the flag been true at adoption. The construct arm does only the capability compose: the normal construction flow covers everything else. The observe arm, a
   * promotion of a running plain camera, additionally: recomputes the two hasSpeaker-derived hints the controller rebuild reads (NOT full configureHints, which re-emits
   * startup INFO); rebuilds the streaming delegate when - and only when - the existing controller was built for the wrong doorbell-ness (so a stream built before the
   * flag flipped is refreshed, while a construction-attach with a correctly-built stream performs zero controller churn); re-runs the mute switch and trigger (the
   * construction IIFE tail already ran them while the flag was false, and the Doorbell service now exists); registers the ring-trigger MQTT (a late promotion the
   * construction configureMqtt could not have registered); and narrates the promotion once.
   */
  private attachDoorbellCapability(source: "construct" | "observe"): void {

    // Construction is graph-assembly, so the camera does not new the capability itself - it asks the NVR composition root to build one (which holds zero policy, just the
    // one new) and keeps the lifecycle decision here. The camera reaches the NVR through an inherited field, never a value-import, so this call forms no module import
    // edge and the device layer stays structurally cycle-proof. The capability's configure stands up the Doorbell service through configureDoorbellService.
    this.doorbell = this.nvr.createDoorbellCapability(this, this.device, this.signal);
    this.doorbell.configure();

    // At construction the normal flow handles the camera-side wiring; only a live promotion runs the rest.
    if(source === "construct") {

      return;
    }

    // Recompute exactly the two hasSpeaker-derived hints the controller rebuild reads. We do NOT re-run full configureHints, which would re-emit the startup INFO lines.
    this.hints.twoWayAudio = this.ufp.featureFlags.hasSpeaker && this.hasFeature("Audio") && this.hasFeature("Audio.TwoWay");
    this.hints.twoWayAudioDirect = this.ufp.featureFlags.hasSpeaker && this.hasFeature("Audio") && this.hasFeature("Audio.TwoWay.Direct");

    // Rebuild the CameraController only when the existing stream was built for the wrong doorbell-ness - a genuine late flip. A construction-attach whose stream was
    // built with the flag already true leaves builtAsDoorbell matching, so this is a no-op and there is zero controller churn.
    if(this.stream && (this.stream.builtAsDoorbell !== this.ufp.featureFlags.isDoorbell)) {

      this.rebuildStreamingDelegate();
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

  // Spawn the camera's narrow-selector state observers (Fork B). Each loop fires only when its watched slice changes by reference - the store's Object.is dedup is the
  // trigger, so there is no hand-diff and no held snapshot. Activity (motion, ring, smart detection, tamper) is delivered by the NVR firehose router and is deliberately
  // never re-synthesized here from device-state.
  protected spawnCameraObservers(): void {

    // Bind the by-id camera selector once and read fields off it, so each per-dispatch selector evaluation reuses the same closure rather than re-deriving it.
    const cam = selectCamera(this.ufp.id);

    // The RTSP channel set and the negotiated video codec both shape the HomeKit streaming surface, so a change to either re-derives it. Two observers, not one tuple: a
    // fresh tuple would never dedup on Object.is, whereas each field dedups natively as its own slice.
    this.observeState({ key: "camera.channels", selector: state => cam(state)?.channels, title: "video streaming" }, () => void this.reconcileStreaming());
    this.observeState({ key: "camera.videoCodec", selector: state => cam(state)?.videoCodec, title: "video streaming" }, () => void this.reconcileStreaming());

    // The lifecycle state enum drives two independent reactions, so each gets its own observer on the same slice. We watch state because isOnline - and therefore the
    // device-online half of isReachable - derives from it; the controller-health half is pushed by the NVR connection loop, not observed here.
    this.observeState({ key: "camera.state", selector: state => cam(state)?.state, title: "availability" }, () => this.updateAvailability());
    this.observeState({ key: "camera.state.hksv", selector: state => cam(state)?.state, title: "HKSV" }, () => {

      // A camera offline at startup could not start its timeshift buffer; when it comes back online with HKSV recording still enabled, retry the buffer init the initial
      // configure could not complete. This replaces the v4 synthetic-bootstrap self-heal with a reaction to the actual online transition.
      if(this.isReachable && this.stream?.hksv?.isRecording && !this.stream.hksv.timeshift.isStarted) {

        void this.stream.hksv.updateRecordingActive(true);
      }
    });

    // The tamper-detection setting governs whether the StatusTampered characteristic exists at all; the tamper occurrence itself is a firehose event the router delivers.
    this.observeState({ key: "camera.smartDetectSettings", selector: state => cam(state)?.smartDetectSettings, title: "tamper detection" },
      () => void this.configureTamperDetection());

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
  }

  // Configure the ambient light sensor for HomeKit.
  private async configureAmbientLightSensor(): Promise<boolean> {

    // Configure the ambient light sensor only if it exists on the camera.
    if(!this.ufp.featureFlags.hasLuxCheck) {

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

    // Initialize the sensor.
    this.ambientLight = await getLux();

    if(this.ambientLight === -1) {

      this.ambientLight = 0.0001;
    }

    // Retrieve the current light level when requested.
    service.getCharacteristic(this.hap.Characteristic.CurrentAmbientLightLevel).onGet(() => this.ambientLight);

    service.updateCharacteristic(this.hap.Characteristic.CurrentAmbientLightLevel, this.ambientLight);
    service.updateCharacteristic(this.hap.Characteristic.StatusActive, this.isReachable);

    return true;
  }

  // Capture a JPEG snapshot of this camera from the controller. This is the narrow public seam onto the v5 camera projection's snapshot command - the camera owns "take a
  // snapshot of me" while keeping the device projection encapsulated. ProtectSnapshot calls this as the Protect-API source in its multi-source acquisition. The command
  // throws on failure (a non-2xx, or a ProtectUnsupportedError when a package snapshot is requested on a camera without a package sensor); the caller treats a throw as
  // "this source failed" and falls through to the next source.
  public async snapshotFromController(opts: SnapshotOptions = {}): Promise<Buffer> {

    return this.device.snapshot(opts);
  }

  // The narrow public seam onto the v5 camera projection's pooled livestream, mirroring snapshotFromController. We map our ChannelProfile to the v5 `source` selector
  // (the lens=>channel-0 coercion now lives in v5), default the segment length to our 100 ms resolution (matching the old subscribe default - the native pool
  // also floors at 100, but the RTSP adapter would otherwise default to 1000), declare HBUP's livestream defaults (a 16384-byte chunk for lower fragmentation and
  // per-segment timestamps - both enter the pool's sharing key, so they must be passed explicitly or two HBUP subscribers would silently fail to share a session),
  // preserve the friendly controller-side request label (the camera name + channel/lens, as the old manager sent), and pass the consumer's urgency closure straight
  // through to the pool's recovery/detection policy. The RTSP-debug variant is a pure-FFmpeg HBUP path that produces the same Segment stream behind the same interface.
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

    // The native v5 pooled livestream. requestId preserves the old friendly label the controller logs (name + channel, or name + "0." + lens for a secondary lens).
    const source: LivestreamSource = (channelProfile.lens !== undefined) ? { lens: channelProfile.lens, type: "lens" } :
      { channel: channelProfile.channel.id, type: "channel" };
    const requestId = this.name + ":" + ((channelProfile.lens !== undefined) ? "0." + channelProfile.lens.toString() : channelProfile.channel.id.toString());

    return this.device.livestream({ chunkSize: 16384, requestId: requestId, segmentLength: segmentLength, signal: opts.signal, source: source, timestamps: true,
      urgency: opts.urgency });
  }

  // Reboot this camera through the controller. This is the narrow public seam onto the v5 camera projection's reboot command, mirroring snapshotFromController - the
  // camera owns "reboot me" while keeping the device projection encapsulated. The HKSV timeshift's livestream self-heal calls this to reset a wedged camera's
  // livestream endpoint after the recovery policy gives up. The command throws on failure; the caller decides how to handle a failed reboot.
  public async reboot(): Promise<void> {

    return this.device.reboot();
  }

  // Open a send-direction two-way-audio (talkback) channel to this camera's speaker. The narrow public seam onto the v5 camera projection's talkback command, mirroring
  // snapshotFromController - the camera owns "talk to me" while keeping the device projection encapsulated. The streaming delegate's two-way-audio path opens this, then
  // drains the return-audio FFmpeg's stdout into the returned session. The command negotiates the WebSocket and connects atomically (returns a live session or throws),
  // and throws a ProtectUnsupportedError for a camera with no speaker; the caller treats a throw as "no talkback" and tears down its return-audio plumbing.
  public async talkback(opts: { signal?: AbortSignal } = {}): Promise<TalkbackSession> {

    return this.device.talkback(opts);
  }

  // Configure UniFi Access specific features for devices that are made available in Protect.
  private configureAccessFeatures(): boolean {

    // If the Access device doesn't have unlock capabilities, we're done.
    if(!this.ufp.accessDeviceMetadata?.featureFlags.supportUnlock) {

      return false;
    }

    // Validate whether we should have this service enabled.
    if(!this.validService(this.hap.Service.LockMechanism, this.hasFeature("UniFi.Access.Lock"), ProtectReservedNames.LOCK_ACCESS)) {

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

    service.updateCharacteristic(this.hap.Characteristic.LockTargetState, this.hap.Characteristic.LockTargetState.SECURED);
    service.updateCharacteristic(this.hap.Characteristic.LockCurrentState, this.hap.Characteristic.LockCurrentState.SECURED);

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

  // Configure tampering detection for devices that support it.
  private configureTamperDetection(): boolean {

    const service = this.accessory.getService(this.hap.Service.MotionSensor);
    const characteristic = service?.getCharacteristic(this.hap.Characteristic.StatusTampered);

    if(!this.ufp.featureFlags.hasTamperDetection || !this.ufp.smartDetectSettings.enableTamperDetection) {

      if(characteristic) {

        service?.removeCharacteristic(characteristic);
      }

      this.isTampered = false;

      return false;
    }

    // Retrieve the current tamper status when requested.
    characteristic?.onGet(() => this.isTampered);

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
        this.nvr.events.doorbellEventHandler(this, Date.now());
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

      // Initialize the status light state.
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
    // request-time concern selectChannel applies, not a list-construction input (D1-heal, 3b-ii). The all-channels-fail-sanity empty result re-asserts HEAD's device
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
  // one drain. The isDeleted guard covers the rebuild path (step 10), which can fire reconcileStreaming on an accessory mid-removal: a being-removed camera must not
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
          // selectChannel - because the recording default must not inherit the streaming-quality preference (D1-heal, 3b-ii); a user can still pin a specific channel.
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

  // Tear down this camera's streaming delegate and unregister its CameraController. Extracted verbatim from cleanup's teardown block so both cleanup (on deletion) and
  // the live-attach rebuild (step 10) tear the delegate down through one path: HKSV recording off, the live and timeshift consumers shut down (releasing their v5 pool
  // subscriptions), and the controller removed from HomeKit.
  private teardownStreamingDelegate(): void {

    // If we've got HomeKit Secure Video enabled and recording, disable it.
    if(this.stream?.hksv?.isRecording) {

      void this.stream.hksv.updateRecordingActive(false);
    }

    // Tear down this camera's livestream consumers so their v5 pool subscriptions are released. The camera no longer owns livestream sessions - the stream (live) and
    // timeshift (HKSV) consumers own the subscriptions, and disposing them decrements the pool refcount to zero. Mirrors nvr.disconnect()'s per-camera teardown.
    this.stream?.shutdown();
    this.stream?.hksv?.timeshift.stop();

    // Unregister our controller.
    if(this.stream) {

      this.accessory.removeController(this.stream.controller);
    }
  }

  /* Rebuild the streaming delegate and its CameraController in place - the one HAP object the live-attach cannot mutate (its audio options, the twoWayAudio/Speaker
   * service, and the supported-configuration TLVs are constructor-frozen). The teardown's removeController runs synchronously; clearing this.stream re-opens the
   * create-once gate; reconcileStreaming's create-half (configureStreamingDelegate) lands on the next microtask after refreshChannelProfiles resolves, so the
   * remove-before-configure ordering holds, and exactly one removeController plus one configureController fire at this event. This is today's shipped reclassification
   * semantics - the HKSV factory reset (removeController) and the supported-config hash change - preserved at exactly this transition, no longer carried by a
   * teardown+recreate of the whole instance. The create-half's isDeleted guard prevents a re-register if the accessory is removed in the window. (It inherits today's
   * benign fire-and-forget updateRecordingActive(false) teardown race - parity, not introduced here.)
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

  // Configure a dimmer to turn on or off the night vision capabilities for HomeKit.
  private configureNightVisionDimmer(): boolean {

    // Validate whether we should have this service enabled.
    if(!this.validService(this.hap.Service.Lightbulb, this.ufp.featureFlags.hasInfrared && this.ufp.featureFlags.hasIcrSensitivity &&
      this.hasFeature("Device.NightVision.Dimmer"), ProtectReservedNames.LIGHTBULB_NIGHTVISION)) {

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

    // Initialize the dimmer state.
    service.updateCharacteristic(this.hap.Characteristic.On, this.nightVision);
    service.updateCharacteristic(this.hap.Characteristic.Brightness, this.nightVisionBrightness);

    this.log.info("Enabling night vision dimmer.");

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
      service.getCharacteristic(this.hap.Characteristic.On).onGet(() => this.ufp.recordingSettings.mode === ufpRecordingSetting);

      service.getCharacteristic(this.hap.Characteristic.On).onSet(async (value: CharacteristicValue) => {

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
      service.updateCharacteristic(this.hap.Characteristic.On, this.ufp.recordingSettings.mode === ufpRecordingSetting);
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

      // Grab all the available RTSP channels and return them as a JSON.
      return JSON.stringify(Object.assign({}, ...this.ufp.channels.filter(channel => channel.isRtspEnabled)
        .map(channel => ({ [channel.name]: "rtsps://" + (this.nvr.config.overrideAddress ?? this.ufp.connectionHost ?? this.nvr.ufp.host) + ":" +
          this.nvr.ufp.ports.rtsp.toString() + "/" + channel.rtspAlias + "?enableSrtp" }))));
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

  // Register the doorbell ring-trigger MQTT subscription, exactly once, when the camera is a Protect doorbell or the user enabled the doorbell trigger. HBPU subscribe is
  // not idempotent, so the registered-once guard prevents a double-subscription across the two call sites (configureMqtt at construction, and the attach arm for a late
  // promotion). The guard is set ONLY after the gate passes and the registration happens, so a no-op construction call on a plain camera (gate false) does not latch it -
  // the later attach-time registration must not be suppressed.
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

      this.nvr.events.doorbellEventHandler(this, Date.now());
    });

    this.#ringMqttRegistered = true;
  }

  // Refresh camera-specific characteristics. Composes the per-concern updaters below; retained as the public entry point for external callers (the recording-switch and
  // physical-chime onSet handlers) and as the "refresh everything" sweep. The per-field observers call the individual updaters directly, so each wakes and writes only
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

  // Push the availability projection: StatusActive on the motion and light sensors (the device-online half of reachability), plus a re-apply of the latched tamper
  // state. Driven by the lifecycle-state observer; doorbells extend this to fan StatusActive out to their package camera.
  protected updateAvailability(): void {

    this.accessory.getService(this.hap.Service.MotionSensor)?.updateCharacteristic(this.hap.Characteristic.StatusActive, this.isReachable);
    this.accessory.getService(this.hap.Service.MotionSensor)?.updateCharacteristic(this.hap.Characteristic.StatusTampered, this.isTampered);
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
        updateCharacteristic(this.hap.Characteristic.On, ufpRecordingSetting === this.ufp.recordingSettings.mode);
    }
  }

  // Find a streaming RTSP configuration for a given target resolution. This is the device wrapper over the pure selectChannelProfile: it injects our published entries
  // and our this-state (the streaming default, which pins to a named channel, and the optional hardware pixel cap), then delegates the selection mathematics. The pixel
  // cap is applied as a mode-agnostic pre-filter BEFORE selection - intentionally a pre-filter, not part of the request, so it filters the name branch too (matching
  // HEAD, where a constrained request with an explicit profile preference still drops profiles above the cap); a future reader should not move it into the request.
  public selectChannel(width: number, height: number, opts?: { biasHigher?: boolean; maxPixels?: number }): Nullable<ChannelProfile> {

    const entries = capByPixels(this.channelProfiles, opts?.maxPixels);
    const request: SelectRequest = this.hints.streamingDefault ? { mode: "name", name: this.hints.streamingDefault } :
      { bias: opts?.biasHigher ? "higher" : "lower", height: height, mode: "nearest", width: width };

    return selectChannelProfile(entries, request);
  }

  // Find a recording RTSP configuration for a given target resolution. The recording wrapper biases higher (transcoding wants a higher-quality input), pins on the
  // recording default rather than the streaming default, and applies the "record"-context hardware source ceiling from FfmpegOptions (D7 - single-sourced with the
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

  // Utility property to return the current night vision state of a camera. It's a blunt instrument due to HomeKit constraints.
  private get nightVision(): boolean {

    return this.ufp.ispSettings.irLedMode !== "off";
  }

  // Utility property to return the current night vision state of a camera, mapped to a brightness characteristic.
  private get nightVisionBrightness(): number {

    switch(this.ufp.ispSettings.irLedMode) {

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
        return (this.ufp.ispSettings.icrCustomValue * 7) + 20;

      default:

        this.log.error("Unknown night vision value detected: %s.", this.ufp.ispSettings.irLedMode);

        return 0;
    }
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
