/* Copyright(C) 2019-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * camera.ts: Camera device class for UniFi Protect.
 */
import { AudioRecordingCodecType, AudioRecordingSamplerate, capabilityGate, formatErrorMessage, parseValueList, toStartCase } from "homebridge-plugin-utils";
import type { Camera, LivestreamSource, SnapshotOptions, TalkbackSession } from "unifi-protect";
import type { CharacteristicValue, Resolution } from "homebridge";
import type { LivestreamHostOptions, ProtectCameraHost } from "../../media/camera-host.ts";
import { PROTECT_FFMPEG_AUDIO_FILTER_FFTNR, PROTECT_NVR_REBOOT_RECENCY_MS, PROTECT_SEGMENT_RESOLUTION } from "../../settings.ts";
import type { ProtectAccessory, ProtectPersistedContextState } from "../../types.ts";
import { ProtectAuthorizationError, deviceSelectors, livestreamAudioSampleRate } from "unifi-protect";
import { STREAM_QUALITY_TIERS, smartDetectLabel } from "../../options.ts";
import { buildAdvertisedProfiles, buildChannelProfile, formatResolution, isPrimaryChannel, rtspUrl } from "../../media/resolution.ts";
import { nightVisionActive, nightVisionBrightnessForMode, nightVisionCommandForLevel, nightVisionModeForToggleOn, nightVisionToggleCommand,
  parseNightVisionMode } from "./night-vision-policy.ts";
import type { AmbientLightCapability } from "./ambient-light.ts";
import type { ChannelProfile } from "../../media/resolution.ts";
import type { DoorbellCapability } from "./doorbell.ts";
import type { LivestreamSubscription } from "../../media/livestream.ts";
import type { NightVisionCommand } from "./night-vision-policy.ts";
import type { Nullable } from "homebridge-plugin-utils";
import type { ProtectCameraPackage } from "./camera-package.ts";
import { ProtectDevice } from "../device.ts";
import type { ProtectHints } from "../device.ts";
import type { ProtectNvr } from "../../nvr/nvr.ts";
import { ProtectReservedNames } from "../../types.ts";
import { RtspLivestreamSubscription } from "../../media/livestream.ts";
import type { StreamQualityTier } from "../../options.ts";
import type { StreamingCapability } from "./streaming.ts";
import type { StreamingDelegate } from "../../media/stream-delegate.ts";
import { canUseLivestreamApi } from "../../media/stream-source-policy.ts";
import { doorbellReconcileAction } from "./doorbell-reconcile-policy.ts";
import { mqttTopics } from "../../mqtt.ts";
import { resolveLegacySelection } from "../../options-legacy.ts";
import { shouldDeliverBareMotion } from "./motion-policy.ts";

// The source tag threaded through the capability-reconcile and doorbell-capability methods: "construct" marks establishment (a fresh adoption or a Homebridge
// restart), "observe" a live reconcile. The establishment-only side effects - the Access lock's SECURED resting stamp, the night vision dimmer's value push and its
// "Enabling" log - branch on it; the members with no resting state ignore it.
type ReconcileSource = "construct" | "observe";

/* The streaming surface a camera derives for HomeKit: the advertised channel-profile list its selectors choose from, and the HomeKit resolution list its
 * CameraController is built with. The two travel together as one derivation RESULT rather than as separate held state, so the narration that reads the profiles and the
 * create call that consumes the resolutions can never disagree about which derivation they are working from.
 *
 * It is declared here, in the camera family, rather than in the media layer: both the member that produces it and the members that consume it are camera host surface,
 * and the media layer's contracts take only a plain resolution list.
 */
export interface AdvertisedStreams {

  profiles: ChannelProfile[];
  resolutions: Resolution[];
}

// The camera family's hint bag: the shared device hints every family carries, extended with the streaming, transcoding, snapshot, and media hints only a camera has.
// Three fields are declared optional because their honest lifecycle is unset-until-their-own-configure-pass-runs rather than absent-means-broken: cropOptions is written
// only by configureCrop and only when cropping is enabled, so its ABSENCE is the crop-off state the media layer's truthiness gate reads (a required field would force the
// configure-time literal to invent a concrete object, and an object has no falsy value, which would read as permanently-on crop for every camera); rtspDefault and
// substrateDefault are written only by onStreamingEstablish, and every read of all three is truthiness-gated.
export interface ProtectCameraHints extends ProtectHints {

  // Whether snapshot and stream cropping is enabled for this camera.
  crop: boolean;

  // The crop window, expressed as percentages of the source frame (x/y offset, width/height).
  cropOptions?: {

    height: number;
    width: number;
    x: number;
    y: number;
  };

  // Whether hardware-accelerated decoding is used for this camera's incoming stream.
  hardwareDecoding: boolean;

  // Whether hardware-accelerated encoding is used when transcoding this camera's stream.
  hardwareTranscoding: boolean;

  // Whether snapshots are pulled from the camera's high-resolution stream rather than its default profile.
  highResSnapshots: boolean;

  // Whether the status LED lights while an HKSV recording is in progress.
  hksvRecordingIndicator: boolean;

  // Whether the status LED feature is enabled for this camera, gated on the camera actually reporting a status LED.
  ledStatus: boolean;

  // Whether doorbell ring events are logged.
  logDoorbell: boolean;

  // Whether HomeKit Secure Video recording activity is logged.
  logHksv: boolean;

  // Whether night vision (infrared) control is exposed to HomeKit for this camera.
  nightVision: boolean;

  // The FFmpeg probe size, in bytes, used when opening this camera's stream.
  probesize: number;

  // The single RTSP stream profile (LOW, MEDIUM, or HIGH) pinned for direct RTSP livestreaming; unset when Protect is left to negotiate the best available profile.
  rtspDefault?: string;

  // Whether smart-detect object types are also exposed to HomeKit as individual contact sensors.
  smartDetectSensors: boolean;

  // The single RTSP stream profile (LOW, MEDIUM, or HIGH) pinned to feed the timeshift buffer; unset when Protect is left to negotiate the best available profile.
  substrateDefault?: string;

  // Whether the camera's video stream is transcoded rather than passed through.
  transcode: boolean;

  // The target bitrate, in kilobits per second, used when transcoding; -1 leaves the bitrate unconstrained.
  transcodeBitrate: number;

  // Whether high-latency transcoding settings apply to this camera's stream.
  transcodeHighLatency: boolean;

  // The target bitrate, in kilobits per second, used when transcoding under high-latency conditions; -1 leaves the bitrate unconstrained.
  transcodeHighLatencyBitrate: number;

  // Whether live viewing reads through the standing timeshift buffer rather than a direct RTSP connection to the camera.
  tsbStreaming: boolean;

  // Whether two-way audio is available for this camera.
  twoWayAudio: boolean;

  // Whether two-way audio is sent directly to the camera over UDP rather than through the Protect controller's talkback channel.
  twoWayAudioDirect: boolean;
}

export class ProtectCamera extends ProtectDevice<Camera> implements ProtectCameraHost {

  private isDeleted: boolean;
  public isRinging: boolean;
  // The latched tamper state, set by the firehose router's tamper delivery (a one-way latch, like isRinging is set by the doorbell delivery) and read back by the
  // tamper-detection onGet and the availability projection. Public because its single writer is the NVR-level event dispatch, not this class.
  public isTampered: boolean;
  public detectLicensePlate: string[];
  // The composed doorbell capability, attached when (and only when) the controller reports this camera as a doorbell. Initialized to null so the field-init runs BEFORE
  // the ctor-body configureDevice that attaches it - declared and set by ProtectCamera itself, so the subclass field-wipe class does not apply.
  public doorbell: Nullable<DoorbellCapability> = null;
  // Whether the doorbell ring-trigger MQTT subscription has been registered, so the one registration site (configureMqtt at construction) and the late-promotion attach
  // arm never double-register (homebridge-plugin-utils subscribe is not safe to call twice). Initialized to false through a field initializer, set by ProtectCamera's own
  // configureDoorbellRingMqtt after the gate passes - never inside a super constructor - so it carries no ctor-chain-computed state and the subclass field-wipe class
  // does not apply.
  #ringMqttRegistered = false;
  // The composed ambient light capability, built the first time this camera reconciles and held for the rest of its life. Nullable and initialized through a field
  // initializer (so it exists before the constructor body's configureDevice can reach the accessor below), which is also what makes the availability delegation total: a
  // camera whose capability was never built - and one already torn down - optional-chains to a no-op.
  #ambientLight: Nullable<AmbientLightCapability> = null;
  // The composed streaming capability, acquired on this camera's construct pass and held for the rest of its life. Nullable and initialized through a field initializer
  // so it exists before the constructor body's configureDevice can reach the accessor below, which is also what makes the NVR-walk reads total: a camera whose capability
  // was never acquired - and one already torn down - optional-chains to a no-op.
  #streaming: Nullable<StreamingCapability> = null;
  // The once-per-episode latch for the RTSP-debug buffer feed's missing-stream narration. livestream() runs on every buffer establish, so a recovery cycle must not
  // re-narrate a standing misconfiguration; the latch clears the moment the debug branch runs against an RTSP-enabled profile, so an admin who disables RTSP again
  // after fixing it is narrated afresh rather than silently swallowed. Its grain is per-camera on purpose: the supervisor's buffer starts and the per-view pooled
  // sessions both route through livestream(), and they narrate one camera-level misconfiguration between them.
  #reportedRtspDebugFallback = false;
  // Whether this camera's failure to return from a controller reboot has already been told. It opens one exception and holds it open: a camera that is still gone at a
  // later reboot is the same unresolved story, not a fresh one, so the watch speaks once per outage and the return is what closes it. Initialized through a field
  // initializer and written only by the watch's own two methods below.
  #rebootReturnWarned = false;
  // Narrow the inherited hint bag to the camera family's shape. The bag is not projection-derived, so it cannot ride the class's projection parameter the way the device
  // handle and the config view do; a type-only re-declaration is the honest mechanism, and it costs one line because nothing is emitted for it.
  declare public hints: ProtectCameraHints;

  // Create an instance.
  constructor(nvr: ProtectNvr, accessory: ProtectAccessory, device: Camera) {

    super(nvr, accessory, device);

    this.isDeleted = false;
    this.isRinging = false;
    this.isTampered = false;
    this.detectLicensePlate = [];

    this.configureHints();
    this.configureDevice();
    this.spawnObservers();
  }

  // The package camera, delegated to the doorbell capability that owns its lifecycle. Null when no doorbell capability is attached, or when an attached doorbell has no
  // package camera. This is the single interface the external readers (event-dispatch's package-motion branch and the NVR's deviceEndpoints iterator) consume, so the
  // package's ownership can live entirely on the capability without touching either caller.
  public get packageCamera(): Nullable<ProtectCameraPackage> {

    return this.doorbell?.packageCamera ?? null;
  }

  // The host the camera's RTSP(S) URLs resolve against: the address override feature option for this controller, else the legacy per-controller override property, else
  // the camera's own controller-reported connection host, else the controller's host. An override that is enabled but left empty counts as absent, so an emptied field
  // falls through the rest of the chain rather than resolving against nothing. Protected so the package camera subclass resolves its own RTSP URLs through the exact
  // same chain as the parent's, rather than the controller's raw address.
  protected get rtspHost(): string {

    const override = this.nvr.getFeatureValue("Nvr.OverrideAddress");

    return (override?.length ? override : undefined) ?? this.nvr.config.overrideAddress ?? this.ufp.connectionHost ?? this.nvr.ufp.host;
  }

  // Whether a streaming delegate may be stood up for this camera at all. A delegate is never built for a camera that is being removed, nor once the controller has begun
  // shutting down: the shutdown teardown walk visits each camera exactly once, so a delegate built after it has passed would hold a registered CameraController and a
  // pooled livestream seat that no path would ever tear down. Public for the same reason configureDoorbellService is: the composed streaming capability consults this
  // rule across the composition boundary, where a protected member is unreadable, and it is the one consumer - both camera views reach it through their capability.
  public get canConfigureStream(): boolean {

    return !this.isDeleted && (this.nvr.phase !== "shuttingDown");
  }

  // The streaming delegate this camera advertises, forwarded from the composed streaming capability that owns it. The media layer reads it through the host contract,
  // where its absence is the honest "no delegate has been built" state, so a camera whose capability has not yet derived anything reads undefined.
  public get stream(): StreamingDelegate | undefined {

    return this.#streaming?.stream ?? undefined;
  }

  /* The composed streaming capability, acquired on first use. Construction is graph-assembly, so the camera asks the NVR composition root for the object rather than
   * newing a sibling class itself, and it reaches the root through an inherited field, so this forms no module import edge and the device layer stays structurally
   * cycle-proof.
   *
   * The whole body is one ??= assignment, which is what makes double construction unrepresentable rather than merely unlikely: the accessor is safe to call from
   * anywhere, including after a future edit moves a caller past an await, so two overlapping reconcile passes converge on one capability by the operator's own semantics.
   *
   * PROTECTED rather than private: the package camera subclass acquires its own capability through it, and a private member is unreachable from a subclass body.
   */
  protected acquireStreaming(): StreamingCapability {

    return this.#streaming ??= this.nvr.createStreamingCapability(this, this.signal);
  }

  // The composed streaming capability, or null when this camera has not acquired one. Deliberately NON-CREATING, unlike the accessor above: the controller-side walks
  // read this to reach a camera's streaming arm, and a walk that constructed a capability as a side effect of looking would build machinery for cameras it was only
  // meant to inspect.
  public get streaming(): Nullable<StreamingCapability> {

    return this.#streaming;
  }

  /* Configure device-specific settings for this device. The base derives the shared hints and assigns them, then this pass spreads that bag into the camera's own
   * literal, so the camera family's complete shape exists in one expression. Smart detection is the one hint whose type lives on the base while its real value is derived
   * here, and it is hoisted into a local first because more than one key needs the same freshly-computed value: an object literal's value expressions all evaluate
   * against the PRE-assignment bag, so a sibling key reading this.hints.smartDetect would see the base's inert seed rather than the camera's answer.
   *
   * The literal deliberately omits cropOptions, rtspDefault, and substrateDefault. Those three are written by their own later passes (configureCrop and
   * onStreamingEstablish), and leaving them unset here is what preserves their unset-until-then state.
   */
  protected override configureHints(): boolean {

    // Configure our parent's hints.
    super.configureHints();

    const smartDetect = this.ufp.featureFlags.hasSmartDetect && this.hasFeature("Motion.SmartDetect");

    this.hints = {

      ...this.hints,
      crop: this.hasFeature("Video.Crop"),
      hardwareDecoding: true,
      hardwareTranscoding: this.hasFeature("Video.Transcode.Hardware"),
      highResSnapshots: this.hasFeature("Video.HighResSnapshots"),
      hksvRecordingIndicator: this.hasFeature("Video.HKSV.StatusLedIndicator"),
      ledStatus: this.ufp.featureFlags.hasLedStatus && this.hasFeature("Device.StatusLed"),
      logDoorbell: this.hasFeature("Log.Doorbell"),
      logHksv: this.hasFeature("Log.HKSV"),
      nightVision: this.ufp.featureFlags.hasInfrared && this.hasFeature("Device.NightVision"),

      // A regular camera stream is dense and continuous, so a modest probe is enough for FFmpeg to lock onto its format reliably without adding noticeable startup
      // latency; the package camera's sparser stream needs a deeper probe of its own (see its own probesize override).
      probesize: 16384,
      smartDetect: smartDetect,
      smartDetectSensors: smartDetect && this.hasFeature("Motion.SmartDetect.ObjectSensors"),
      transcode: this.hasFeature("Video.Transcode"),
      transcodeBitrate: this.getFeatureNumber("Video.Transcode.Bitrate") ?? -1,
      transcodeHighLatency: this.hasFeature("Video.Transcode.HighLatency"),
      transcodeHighLatencyBitrate: this.getFeatureNumber("Video.Transcode.HighLatency.Bitrate") ?? -1,
      tsbStreaming: this.hasFeature("Video.Timeshift.Livestream"),
      twoWayAudio: this.ufp.featureFlags.hasSpeaker && this.hasFeature("Audio") && this.hasFeature("Audio.TwoWay"),
      twoWayAudioDirect: this.ufp.featureFlags.hasSpeaker && this.hasFeature("Audio") && this.hasFeature("Audio.TwoWay.Direct")
    };

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

    // Preserve the persisted user-state keys across the context reset: motion detection always, plus the HKSV-recording and doorbell-mute switch states when their
    // features are enabled. The values here are the resting defaults a fresh accessory starts from; resetAccessoryContext keeps whatever was actually persisted and
    // falls back to these only when nothing was, so a user's saved choice survives the restart.
    const preserved: ProtectPersistedContextState = { detectMotion: true };

    if(this.hasFeature("Video.HKSV.Recording.Switch")) {

      preserved.hksvRecordingDisabled = false;
    }

    if(this.hasFeature("Doorbell.Mute")) {

      preserved.doorbellMuted = false;
    }

    this.resetAccessoryContext(preserved);

    // Inform the user that motion detection will suck.
    if(this.recordingMode === "never") {

      this.log.warn("Motion events will not be generated by the Protect controller when the controller's camera recording options are set to \"never\".");
    }

    // Check to see if we have smart motion events enabled on a supported camera.
    if(this.hints.smartDetect) {

      const smartDetectTypes = [ ...this.ufp.featureFlags.smartDetectAudioTypes, ...this.ufp.featureFlags.smartDetectTypes ];

      // Inform the user of what smart detection object types we're configured for. The list reads in display-name order rather than wire order, since the names are
      // what the reader is scanning...a code-unit sort of the labels would file "CO Alarm" before "Car Horn", so the ordering is a locale comparison.
      this.log.info("Smart motion detection enabled%s.", smartDetectTypes.length ? ": " +
        smartDetectTypes.map((type) => smartDetectLabel(type)).toSorted((left, right) => left.localeCompare(right)).join(", ") : "");
    }

    // Configure accessory information.
    this.configureInfo();

    // Configure MQTT services.
    this.configureMqtt();

    // Configure the motion sensor.
    this.configureMotionSensor(this.isHksvCapable);

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
      await Promise.all([ this.reconcileCapabilities("construct"), this.acquireStreaming().reconcile() ]);

      // Configure our camera details.
      this.configureCameraDetails();

      // Configure our NVR recording switches.
      this.configureNvrRecordingSwitch();

      // Configure the status indicator light switch.
      this.configureStatusLedSwitch();

      // Configure the doorbell trigger. It runs BEFORE the mute switch because the trigger is what creates the Doorbell service on a plain camera, and the mute switch's
      // gate requires that service to already exist. A camera the controller demoted (a cached Doorbell service, trigger now disabled) takes the trigger's disabled
      // branch here, which removes the stale service first, so the mute switch below is correctly absent immediately rather than one session later.
      this.configureDoorbellTrigger();

      // Configure the doorbell mute switch.
      this.configureDoorbellMuteSwitch();
    })();

    // Attach the doorbell capability when the controller already reports this camera as a doorbell. This runs at the END of configureDevice's synchronous body, after
    // the IIFE statement: the IIFE's synchronous prefix has already kicked off the streaming reconcile, while its tail (the trigger and mute switch) runs on later
    // microtasks. The capability's configure synchronously stands up the Doorbell service (through configureDoorbellService), so a real doorbell's service exists before
    // that microtask tail reaches the mute-switch gate; a plain camera's Doorbell service is stood up by the trigger, which the tail now runs ahead of the mute switch.
    // Either way the mute switch sees a present (or correctly absent) service. A camera the controller does not report as a doorbell attaches nothing here.
    this.reconcileDoorbellCapability("construct");

    return true;
  }

  /* Reconcile this camera's doorbell capability against the controller's live state - the single chokepoint the construction-time arm and the always-armed isDoorbell
   * observer both route through, driven by the pure doorbellReconcileAction over (hasCapability, isDoorbell). A promotion composes the capability onto the running
   * instance in place; the one HAP object that cannot change in place (the CameraController) is rebuilt by the streaming capability's audio reconcile, not here, since a
   * doorbell-ness is one of the frozen audio capabilities that reconcile watches for. The source tag separates the two attach contexts: at
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

        // A demoted-while-down doorbell reconstructs as a plain camera with no capability: remove the doorbell-only services it left behind (safe to call more than once
        // - a no-op on a steady plain camera). The removal routes through the NVR composition root so the camera never value-imports the sibling capability class (the
        // device-layer structural-cycle-proof rule); the Doorbell service itself is left to configureDoorbellTrigger's existing removal arm.
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
   * once. The late-doorbell controller rebuild lives in the streaming capability's audio reconcile, driven by the featureFlags observer, so this method only composes the
   * capability: an isDoorbell change also wakes that observer, and that reconcile rebuilds the streaming delegate when a frozen audio capability
   * has appeared (a late doorbell-ness or a late speaker), single-sourcing that rebuild across both late inputs.
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
    // acquireService is safe to call more than once, so a re-run that finds the service in place is harmless.
    this.configureDoorbellMuteSwitch();
    this.configureDoorbellTrigger();

    // Register the ring-trigger MQTT subscription, which the construction configureMqtt could not have registered while the flag was false (the once-guard makes a
    // later duplicate registration a no-op).
    this.configureDoorbellRingMqtt();

    // Narrate the promotion once - today's reclassification is completely silent.
    this.log.info("The controller now reports this camera as a doorbell; its doorbell features are now available in HomeKit.");
  }

  // Cleanup after ourselves if we're being deleted.
  public override cleanup(): void {

    // Tear down the doorbell capability first when one is attached - releasing its package camera, its observers, and exactly its MQTT handlers - then null the handle,
    // mirroring today's doorbell.cleanup ordering (package first).
    this.doorbell?.cleanup();
    this.doorbell = null;

    // Release the ambient light handle. The capability needs no cleanup call of its own - its lifetime signal is composed against this camera's, so the super below
    // drains its poll - and nulling the handle here is what keeps the availability delegation total once the camera is gone.
    this.#ambientLight = null;

    // Tear down the streaming capability, which releases its delegate and unregisters the controller it registered.
    this.#streaming?.cleanup();

    super.cleanup();

    this.isDeleted = true;
  }

  /* The camera family's observer template, effectively final: super spawns the universal base observers (name sync and device information), then spawnCameraObservers
   * spawns the family-specific set. Camera-family leaves extend spawnCameraObservers, never this template - a deliberate asymmetry with the other device families, which
   * extend spawnObservers directly. Only the camera family has a leaf-of-a-leaf (the package camera under the doorbell) that must suppress part of its parent's observer
   * set, and this is what lets it replace exactly the camera reactions while still inheriting the base pair. The package replaces spawnCameraObservers without a
   * super call (its own bespoke set); the doorbell's own reactions are not a camera subclass - they spawn through the composed DoorbellCapability's own configure, keyed
   * on the capability's signal - so the camera's set is the plain-camera set and the per-class observer count pins in the construction tests are the enforcement.
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
    const cam = deviceSelectors.camera.byId(this.device.id);

    // The RTSP channel set and the negotiated video codec both shape the HomeKit streaming surface, so a change to either re-derives it. Separate observers, not one
    // tuple: a fresh tuple would never dedup on Object.is, whereas each field dedups natively as its own slice.
    this.observeState({ key: "camera.channels", selector: state => cam(state)?.channels, title: "video streaming" },
      () => void this.acquireStreaming().reconcile());
    this.observeState({ key: "camera.videoCodec", selector: state => cam(state)?.videoCodec, title: "video streaming" },
      () => void this.acquireStreaming().reconcile());

    // The published channel profiles bake their RTSP URLs against the connection host at derivation time (rtspHost feeds buildChannelProfile), so a camera IP change must
    // re-derive them. The reconcile chokepoint's derivation half is safe to re-run and its create-once delegate half is already guarded, so routing the host change here
    // re-bakes the profile URLs without disturbing the standing streaming delegate.
    this.observeState({ key: "camera.connectionHost", selector: state => cam(state)?.connectionHost, title: "video streaming" },
      () => void this.acquireStreaming().reconcile());

    // The lifecycle state enum drives independent reactions, so each gets its own observer on the same slice. We watch state because isOnline - and therefore the
    // device-online half of isReachable - derives from it; the controller-health half is pushed by the NVR connection loop, not observed here. Two reactions ride this
    // wake: the availability projection, and the reboot-return watch, for which this is the path a camera that comes back on its own takes.
    this.observeState({ key: "camera.state", selector: state => cam(state)?.state, title: "availability" }, () => {

      this.updateAvailability();
      this.#reconcileRebootReturn();
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
    // one per flag: the flags complete together in a single bootstrap drain, the reconcile is a no-op on repeat, and the store's structural sharing yields a new
    // featureFlags reference only on a real change. The value-selecting isDoorbell observer above dedups independently, so a flag change that does not touch isDoorbell
    // wakes only this observer.
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

  /* The composed ambient light capability, built on first use. Construction is graph-assembly, so the camera asks the NVR composition root for the object rather than
   * newing a sibling class itself, and it reaches the root through an inherited field, so this forms no module import edge and the device layer stays structurally
   * cycle-proof.
   *
   * The whole body is one ??= assignment, which is what makes double construction unrepresentable rather than merely unlikely: the accessor is safe to call from
   * anywhere, including after a future edit moves a caller past an await, so two overlapping reconcile passes converge on one capability by the operator's own semantics.
   * A positional rule - "call it before the first await" - was considered and rejected: it holds only while nobody inserts a gate above the call, and it depends on a
   * reader noticing a comment.
   */
  private get ambientLight(): AmbientLightCapability {

    return this.#ambientLight ??= this.nvr.createAmbientLightCapability(this, this.device, this.signal);
  }

  // Capture a JPEG snapshot of this camera from the controller. This is the narrow public interface onto the camera projection's snapshot command - the camera owns "take
  // a snapshot of me" while keeping the device projection encapsulated. ProtectSnapshot calls this as the Protect-API source in its multi-source acquisition. The command
  // throws on failure (a non-2xx, or a ProtectUnsupportedError when a package snapshot is requested on a camera without a package sensor); the caller treats a throw as
  // "this source failed" and falls through to the next source.
  public async snapshotFromController(opts: SnapshotOptions = {}): Promise<Buffer> {

    return this.device.snapshot(opts);
  }

  // The narrow public interface onto the camera projection's pooled livestream, mirroring snapshotFromController. We map our ChannelProfile to the `source` selector
  // (the lens=>channel-0 coercion now lives in the library), default the segment length to our 100 ms resolution (the native pool
  // also floors at 100, but the RTSP adapter would otherwise default to 1000), declare the plugin's livestream defaults (a 16384-byte chunk for lower fragmentation and
  // per-segment timestamps - both enter the pool's sharing key, so they must be passed explicitly or two plugin subscribers would silently fail to share a session),
  // preserve the friendly controller-side request label (the camera name + channel/lens), and pass the consumer's urgency closure and discardOnDispose preference
  // straight through to the pool's recovery/detection policy. The RTSP-debug variant is a pure-FFmpeg plugin path that produces the same Segment stream behind the same
  // interface; it ignores discardOnDispose by construction, since its own FFmpeg-fed subscription has no pooled queue to discard.
  public livestream(channelProfile: ChannelProfile, opts: LivestreamHostOptions = {}): LivestreamSubscription {

    const segmentLength = opts.segmentLength ?? PROTECT_SEGMENT_RESOLUTION;

    // The RTSP-debug path (Debug.Video.Timeshift.UseRtsp) transcodes the camera's RTSP stream through FFmpeg to feed the timeshift buffer instead of the controller's
    // native livestream. It is gated on the debug feature alone - no HKSV recording precondition - so it engages from startup for the standing buffer. The audio target
    // mirrors the livestream API's native delivery, derived from camera facts rather than any HKSV recording configuration.
    if(this.hasFeature("Debug.Video.Timeshift.UseRtsp") && this.stream) {

      // The debug feed dials the handed channel over RTSP, so a channel the controller has not enabled has nothing for FFmpeg to connect to. We say so once and fall
      // through to the native pooled path rather than failing the buffer outright, and we clear the latch on the success path so a re-broken configuration re-narrates.
      if(!channelProfile.channel.isRtspEnabled) {

        if(!this.#reportedRtspDebugFallback) {

          this.#reportedRtspDebugFallback = true;
          this.log.warn("The timeshift buffer is configured to feed from the camera's RTSP stream, but no RTSP-enabled channel is available. " +
            "Feeding the buffer from the UniFi Protect livestream API instead.");
        }
      } else {

        this.#reportedRtspDebugFallback = false;

        // Mono AAC-LC at the camera's livestream (fMP4) audio rate, which livestreamAudioSampleRate owns.
        const samplerate = (livestreamAudioSampleRate(this.ufp) === 48000) ? AudioRecordingSamplerate.KHZ_48 : AudioRecordingSamplerate.KHZ_16;

        return new RtspLivestreamSubscription({

          audio: { channels: 1, codec: AudioRecordingCodecType.AAC_LC, samplerate: samplerate },
          enableAudio: this.ufp.featureFlags.hasMic && this.hasFeature("Audio"),
          ffmpegOptions: this.stream.ffmpegOptions,
          segmentLength: segmentLength,
          signal: opts.signal,
          url: channelProfile.url,
          videoCodec: this.ufp.videoCodec
        });
      }
    }

    // The native pooled livestream. requestId preserves the friendly label the controller logs (name + channel, or name + "0." + lens for a secondary lens).
    const source: LivestreamSource = (channelProfile.lens !== undefined) ? { lens: channelProfile.lens, type: "lens" } :
      { channel: channelProfile.channel.id, type: "channel" };
    const requestId = this.name + ":" + ((channelProfile.lens !== undefined) ? "0." + channelProfile.lens.toString() : channelProfile.channel.id.toString());

    return this.device.livestream({ chunkSize: 16384, discardOnDispose: opts.discardOnDispose, requestId: requestId, segmentLength: segmentLength, signal: opts.signal,
      source: source, timestamps: true, urgency: opts.urgency });
  }

  // Reboot this camera through the controller. This is the narrow public interface onto the camera projection's reboot command, mirroring snapshotFromController - the
  // camera owns "reboot me" while keeping the device projection encapsulated. The HKSV timeshift's livestream self-heal calls this to reset a wedged camera's
  // livestream endpoint after the recovery policy gives up. The command throws on failure; the caller decides how to handle a failed reboot.
  public async reboot(): Promise<void> {

    return this.device.reboot();
  }

  // Open a send-direction two-way-audio (talkback) channel to this camera's speaker. The narrow public interface onto the camera projection's talkback command, mirroring
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
      // guard on the auto re-lock timer being pending so we don't stomp a SECURED state that our own timer just wrote...the registry deletes the keyed entry before
      // invoking its callback, so by the time we check, a just-fired timer is already gone and we correctly become a no-op. The 50ms delay below is the same margin used
      // throughout this file to let HomeKit settle the value it just wrote before we write back over it, mirroring the package camera's flashlight reset.
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

      // The unlock succeeded, which confirms the controller released the strike...Protect fires no feedback event for user-directed Access unlocks, so we report the
      // momentary unlock and drive the auto re-lock ourselves. HomeKit's own set request moved the target to UNSECURED on its way into this handler; mirroring
      // current state is what lands the Home app tile on "Unlocked" rather than an "Unlocking" transition that never completes.
      service.updateCharacteristic(this.hap.Characteristic.LockCurrentState, this.hap.Characteristic.LockCurrentState.UNSECURED);

      this.log.info("Unlocked.");

      // Two seconds is long enough for the momentary UNSECURED state to register visibly in the Home app before we revert it back to SECURED.
      this.timers.setTimeout("accessUnlock", () => {

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

  /* Reconcile the discrete smart motion contact sensors this camera advertises against the controller's live state - a reconcileCapabilities leaf, so a camera whose
   * hasSmartDetect the controller reports only after adoption gains its sensors without a restart, and a detection type the controller adds or drops is reflected live.
   *
   * The derived hints are refreshed FIRST, in the same synchronous region as everything below, so the pass that raises them is the pass that acts on them: the all-off
   * prune reads hints.smartDetectSensors, and a refresh sequenced after it would decide against the previous pass's value, leaving a late-arriving capability's sensors
   * one reconcile behind. The refresh is additive, mirroring the twoWayAudio refresh the streaming capability performs, and being additive is also what makes
   * "a hardware withdrawal keeps" fall out of the structure rather than out of a guard.
   *
   * The capability withdrawal is the single short-circuit below rather than a condition inside each prune. That is what makes withdrawal-keeps a property of this
   * method's SHAPE: the controller empties the reported type set alongside the flag, so any prune reached during a withdrawal would delete every sensor - typed and plate
   * alike - through the per-type path and silently defeat the rule. One statement, and the capability level cannot drift apart from the per-type level.
   */
  private reconcileSmartDetectSensors(): boolean {

    // Refresh the derived smart-detect hints from their two live inputs. configureHints establishes the baseline at construction; this is the only live refresher, and
    // event-dispatch gates every smart-detect delivery on the cached value - so without this refresh a live arrival would materialize sensors that could never trip. Both
    // refreshes sit above the withdrawal short-circuit because ||= against a false right side is a no-op, so a withdrawal passing through here changes nothing.
    this.hints.smartDetect ||= this.ufp.featureFlags.hasSmartDetect && this.hasFeature("Motion.SmartDetect");
    this.hints.smartDetectSensors ||= this.hints.smartDetect && this.hasFeature("Motion.SmartDetect.ObjectSensors");

    // The controller does not report smart detection: leave every existing sensor exactly as it stands and touch nothing.
    if(!this.ufp.featureFlags.hasSmartDetect) {

      return false;
    }

    /* The detection types this camera actually delivers: the INTERSECTION of what the hardware advertises (featureFlags) with what the user has switched on in Protect
     * (smartDetectSettings). Both halves are needed. The capability alone would keep a sensor for a detection the user turned off, and that sensor could never trip -
     * delivery keys off the event's own type, and the controller sends no event for a disabled detection - so it would sit at no-detection forever and any automation
     * bound to it would silently never run. Audio types intersect with audio types and object types with object types; the controller keeps the audio and object lists
     * separate and so do we. It is derived once, here, and every consumer reads it - the occupancy list, both license-plate terms, the per-type prune, and the per-type
     * add - so "which detections does this camera deliver?" has a single answer.
     */
    const smartDetectTypes = new Set([ ...this.ufp.featureFlags.smartDetectAudioTypes.filter(type => this.ufp.smartDetectSettings.audioTypes.includes(type)),
      ...this.ufp.featureFlags.smartDetectTypes.filter(type => this.ufp.smartDetectSettings.objectTypes.includes(type)) ]);

    // Which of those delivered types the user wants a contact sensor for. It is read once, here, and both the prune and the create below test membership in it, so
    // "which per-type sensors should this camera advertise?" has a single answer that cannot drift between the two loops.
    const objectSensorTypes = new Set(this.getFeatureList("Motion.SmartDetect.ObjectSensors", [...smartDetectTypes]));

    // Rebuild the smart-occupancy type list from live state. It is a plain ASSIGNMENT on every pass rather than a rising-edge fill, because the type set itself moves
    // live (a type the controller adds or drops, or the user enables or disables), so a once-only fill would trade the flag's staleness for the list's. It sits BELOW the
    // short-circuit, unlike the additive refreshes above: an assignment is not a no-op, so running it during a withdrawal would empty the list against a withdrawn type
    // set and silently stop occupancy delivery - the very deletion the keep-on-withdrawal rule exists to prevent.
    this.hints.smartOccupancy = this.deriveSmartOccupancy(smartDetectTypes);

    // Get any license plates the user has configured for detection, if any. The list reads through the shared list grammar, so the stored text and every other
    // list-valued option are parsed by one definition; plates are matched in upper case, which is what the detection events carry.
    this.detectLicensePlate = parseValueList(this.getFeatureValue("Motion.SmartDetect.ObjectSensors.LicensePlate") ?? "").map(plate => plate.toUpperCase());

    // Check if we have disabled specific license plate smart motion object contact sensors, and if so, remove them.
    for(const objectService of this.accessory.services.filter(x => x.subtype?.startsWith(ProtectReservedNames.CONTACT_MOTION_SMARTDETECT_LICENSE + "."))) {

      // Do we have license plate detection available to us and is this license plate configured? If so, move on. The hardware capability is not a term here: the
      // short-circuit above has already established it, so the surviving terms are the plate detection this camera delivers and the user's own configured list.
      if(smartDetectTypes.has("licensePlate") && objectService.subtype &&
        this.detectLicensePlate.includes(objectService.subtype.slice(objectService.subtype.indexOf(".") + 1))) {

        continue;
      }

      // We don't have this contact sensor enabled, remove it.
      this.accessory.removeService(objectService);
      this.log.info("Disabling smart motion license plate contact sensor: %s.", objectService.subtype?.slice(objectService.subtype.indexOf(".") + 1));
    }

    /* Prune the object-centric contact sensors this camera should not advertise: all of them when the user has the object-sensor option off, and otherwise the ones the
     * selection does not name - a detection type this camera has stopped delivering (the controller withdrew the hardware type, or the user switched that detection off
     * in Protect), or one the user has left out of the selection. One keep-condition covers all of it, mirroring the license-plate prune above, so "which per-type
     * sensors survive" has a single answer. Removing a type's sensor here is the subtractive half of the per-type set reconciling live; the capability level above never
     * reaches this loop, which is what keeps a hardware withdrawal from deleting anything.
     */
    for(const objectService of this.accessory.services.filter(x => x.subtype?.startsWith(ProtectReservedNames.CONTACT_MOTION_SMARTDETECT + "."))) {

      const smartDetectType = objectService.subtype?.slice(objectService.subtype.indexOf(".") + 1) ?? "";

      if(this.hints.smartDetectSensors && objectSensorTypes.has(smartDetectType)) {

        continue;
      }

      // We don't have this contact sensor enabled, remove it.
      this.accessory.removeService(objectService);
      this.log.info("Disabling smart motion contact sensor: %s.", smartDetectLabel(smartDetectType));
    }

    // The number of sensors this pass CREATED, which each summary line below reads against its own pre-loop snapshot so a narration fires only on a real change. Once
    // this method runs on every reconcile pass, an ungated summary would re-print its enumeration on every unrelated capability change and turn a one-time startup
    // statement into recurring noise. Each removal above already narrates itself as it happens, so the prunes need no equivalent gate.
    let sensorsCreated = 0;

    // A utility for us to add contact sensors.
    const addSmartDetectContactSensor = (name: string, serviceId: string, errorMessage: string): boolean => {

      // Read prior existence BEFORE acquiring, the same establishment-detection idiom the Access lock and the night vision dimmer use: a get-or-create returns the
      // service either way and cannot tell us which it did.
      const existing = this.accessory.getServiceById(this.hap.Service.ContactSensor, serviceId);

      // Acquire the service.
      const service = this.acquireService(this.hap.Service.ContactSensor, name, serviceId);

      // Fail gracefully.
      if(!service) {

        this.log.error(errorMessage);

        return false;
      }

      // Initialize a freshly created sensor to its resting state, and only a freshly created one: an existing sensor's state belongs to the delivery path, so re-stamping
      // it here would reset a tripped detection the moment an unrelated capability change drove a reconcile, silently cancelling a live smart-motion event.
      if(!existing) {

        service.updateCharacteristic(this.hap.Characteristic.ContactSensorState, this.hap.Characteristic.ContactSensorState.CONTACT_DETECTED);

        sensorsCreated++;
      }

      return true;
    };

    let enabledContactSensors = [];

    // Add individual contact sensors for each object detection type, if needed.
    if(this.hints.smartDetectSensors) {

      const createdBeforeObjectSensors = sensorsCreated;

      for(const smartDetectType of [...objectSensorTypes].toSorted()) {

        if(addSmartDetectContactSensor(this.accessoryName + " " + smartDetectLabel(smartDetectType),
          ProtectReservedNames.CONTACT_MOTION_SMARTDETECT + "." + smartDetectType,
          "Unable to add smart motion contact sensor for " + smartDetectLabel(smartDetectType) + " detection.")) {

          enabledContactSensors.push(smartDetectType);
        }
      }

      if(sensorsCreated > createdBeforeObjectSensors) {

        // The sensors are created in wire order and narrated in display-name order, the order the reader scans...a locale comparison rather than a code-unit sort,
        // which would file "CO Alarm" before "Car Horn".
        this.log.info("Smart motion contact sensor%s enabled: %s.", enabledContactSensors.length > 1 ? "s" : "",
          enabledContactSensors.map((type) => smartDetectLabel(type)).toSorted((left, right) => left.localeCompare(right)).join(", "));
      }
    }

    enabledContactSensors = [];

    // Now process license plate contact sensors for individual detections, when this camera delivers plate detection at all.
    if(smartDetectTypes.has("licensePlate")) {

      const createdBeforePlateSensors = sensorsCreated;

      // Get the list of plates.
      for(const licenseOption of this.detectLicensePlate.filter(plate => plate.length)) {

        if(addSmartDetectContactSensor(this.accessoryName + " License Plate " + licenseOption,
          ProtectReservedNames.CONTACT_MOTION_SMARTDETECT_LICENSE + "." + licenseOption,
          "Unable to add smart motion license plate contact sensor for " + licenseOption + ".")) {

          enabledContactSensors.push(licenseOption);
        }
      }

      if(sensorsCreated > createdBeforePlateSensors) {

        this.log.info("Smart motion license plate contact sensor%s enabled: %s.", enabledContactSensors.length > 1 ? "s" : "", enabledContactSensors.join(", "));
      }
    }

    return true;
  }

  /* The smart-detect object types the user has selected to drive the occupancy sensor: the selection the Motion.OccupancySensor option holds, read against every
   * detection type this camera DELIVERS. It takes the delivered set rather than re-deriving one, so a detection the user has switched off in Protect is absent here for
   * the same reason it grows no contact sensor - one answer to "which detections does this camera deliver?", read by every consumer. The list is returned fresh rather
   * than pushed into the hint, so the caller assigns it and no pass can accumulate.
   *
   * It exists because the derived hint bag caches this list and the base configureOccupancySensor fills it only when it CREATES the service - at construction, before the
   * reconcile chokepoint runs - so a camera whose smart-detect capability arrives after adoption would otherwise carry an empty list for the rest of the session while
   * hints.smartDetect read true, and the delivery gate would then match no detection type at all. The base method keeps its own fill for its own contract (a live
   * re-creation of the occupancy service, on any device family); this is the camera's live refresher, and it deliberately expresses the same rule rather than a new one.
   *
   * It takes smartDetectTypes, the detection types this camera currently delivers (the intersection the reconcile pass derives once), and returns the delivered
   * detection types the user has selected for occupancy, empty when smart detection is not this camera's source of truth.
   */
  private deriveSmartOccupancy(smartDetectTypes: ReadonlySet<string>): readonly string[] {

    // Being past the withdrawal short-circuit establishes only that the HARDWARE reports smart detection. This hint is that flag AND the user's Motion.SmartDetect
    // option, so a camera whose owner has the option off reaches here with it false and must carry no occupancy types at all - the base method's own contract.
    if(!this.hints.smartDetect) {

      return [];
    }

    return this.getFeatureList("Motion.OccupancySensor", [...smartDetectTypes]);
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

  // The camera's "ensure my Doorbell service exists and is primary" interface, public so both the trigger path (configureDoorbellTrigger, when a plain camera enables the
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

        const command = nightVisionToggleCommand(value === true);

        // Push the new night vision setting to the controller, reporting any failure through the shared command-error helper and reverting the characteristic on failure.
        if(!(await this.runDeviceCommand("set night vision to " + command.irLedMode, () => this.device.update({ ispSettings: command })))) {

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
  // reconciles the UniFi Access lock, the night vision dimmer, the smart-detect contact sensors, the ambient light sensor, the tamper-detection characteristic, and the
  // streaming delegate's frozen audio surface (two-way audio and the doorbell sample rates, rebuilt in place when a late speaker or doorbell-ness appears); the remaining
  // camera-family capability gates fold in here as they gain their own observers. It is deliberately observeState-free - the capability observers that drive it are
  // registered once, in spawnCameraObservers. The source separates establishment (construct: a fresh adoption or a Homebridge restart) from a live reconcile (observe),
  // which the Access lock's resting-state stamp and the night vision dimmer's establishment-only push consume; the smart-detect sensors, the ambient light sensor, the
  // tamper-detection characteristic, and the streaming-audio reconcile ignore it, each deciding from live state alone. The isDeleted guard mirrors the streaming
  // delegate's create-half: a being-removed camera must not reconcile against a vanishing record.
  protected async reconcileCapabilities(source: ReconcileSource): Promise<void> {

    if(this.isDeleted) {

      return;
    }

    this.configureAccessFeatures(source);

    this.configureNightVisionDimmer(source);

    this.configureTamperDetection();

    this.acquireStreaming().reconcileAudioCapabilities();

    this.reconcileSmartDetectSensors();

    await this.ambientLight.reconcile();
  }

  /* Resolve one of this camera's channel pins: the single stream-quality tier this configuration names for it, or null when it names none.
   *
   * The readings this tells apart are the ones the device base's list read tells apart, one wrapper philosophy written twice. A pin disabled at some scope pins
   * nothing. A pin enabled with no stored tier keeps the meaning a bare enable has always had and resolves the tier the catalog registers as its default, so
   * turning the option on is a working choice rather than a switch that does nothing until a second gesture follows it. A stored tier reads against the tier table
   * through the same case folding every other selection read uses, so a quality typed in any casing still names its tier. The engine folds a hand-authored
   * "Enable.<option>=" into the same unspecified reading as a bare enable for an option holding a single value, so both enable forms land on the registered tier
   * and "no pin" is said by disabling the option.
   *
   * While the pin's family still carries entries in the retired per-tier grammar, the overlay answers instead, with this camera's own device and controller
   * identifiers and the exact three-level precedence those entries have always had. No registered default reaches that path: the retired grammar said "pin" by
   * naming a tier, so an entry that names none pins none.
   *
   * @param option - The feature option holding the pin.
   *
   * @returns The pinned tier, or null when no tier is pinned.
   */
  private resolveChannelPin(option: string): Nullable<StreamQualityTier> {

    const domain = STREAM_QUALITY_TIERS.map((entry) => entry.choice);

    // The family the overlay still has to answer for, or null once the configuration has converged. The engine read is skipped entirely while the overlay owns the
    // answer, since the retired entries it reads are exactly the ones the engine resolves nothing from.
    const overlaid = this.overlaidFamily(option);

    // The raw stored text on the non-overlaid path, read for the narration below alone: the engine read answers the pin, and this is the spelling the user wrote.
    const stored = overlaid ? undefined : this.getFeatureValue(option);
    const selected = overlaid ? resolveLegacySelection({ controller: this.nvr.ufp.mac, device: this.device.config.mac, domain, family: overlaid,
      options: this.platform.config.options }) : this.platform.featureOptions.valueList({ controller: this.nvr.ufp.mac, defaultWhenUnset: true,
      device: this.device.config.mac, domain, option });
    const pinned = STREAM_QUALITY_TIERS.find((entry) => entry.choice === selected[0])?.tier ?? null;

    /* A stored quality the tier table does not offer names no channel at all. Only a hand-edited configuration reaches it, so we say which value we set aside rather
     * than resolving it silently to no pin. The pin holds one tier by declaration, so its whole stored text is the single candidate the table is asked for: a payload
     * naming several tiers, or the wildcard that stands for a picker's entire domain, is a value the table does not carry and lands here.
     */
    if(stored?.length && !pinned) {

      this.log.debug("Ignoring an unrecognized stream quality for %s: %s.", option, stored);
    }

    return pinned;
  }

  /* Derive the streaming surface HomeKit advertises for this camera. This is the camera family's derivation HOST HOOK - public because the composed streaming capability
   * drives it across the composition boundary, and NON-ASYNC by declaration so a host whose derivation needs no controller round trip can override it with a plain value.
   * The value-or-promise union is what makes that override legal: an async method cannot declare a non-promise return type, so the asynchronous work lives in the private
   * helper below and this member hands back whatever the helper returns. A caller resolves the union by testing for a promise, which is what keeps a synchronous host's
   * whole derive-and-establish chain inside its caller's own call frame.
   */
  public deriveAdvertisedStreams(): Nullable<AdvertisedStreams> | Promise<Nullable<AdvertisedStreams>> {

    return this.#deriveStreams();
  }

  // The parent camera's derivation: enable RTSP across the camera's channels where the configuration needs it, then synthesize the advertised profile list HomeKit
  // consumes. Always re-run (every channel / codec / connection-host change re-derives), and null on every path that yields no advertisable list.
  async #deriveStreams(): Promise<Nullable<AdvertisedStreams>> {

    // No channels exist on this camera or we don't have access to the bootstrap configuration.
    if(!this.ufp.channels.length) {

      return null;
    }

    /* Whether this camera's configuration genuinely streams over RTSP. We enable RTSP on a camera's behalf only where something actually consumes it: live views drawn
     * directly over RTSP for a codec FFmpeg can carry that way, a direct-RTSP quality pin whose named channel must stay reachable, or the RTSP-debug buffer feed. The
     * external publishers (the M3U playlist and the MQTT topic) report what exists rather than causing enablement. Everything else reaches the camera through the
     * livestream API, which serves any channel whether or not RTSP is enabled on it.
     *
     * The quality pin is part of the need set even for a buffer-mode camera: the buffer-down resilience fallback dials the pinned channel BY NAME, so a pin naming a
     * channel the controller never enabled would be a hard live-view failure the moment the buffer blinks.
     */
    const needsRtspTransport = !this.usesTimeshiftLivestream && (this.ufp.videoCodec !== "av1");
    const needsRtsp = needsRtspTransport || this.hasFeature("Debug.Video.Timeshift.UseRtsp") || Boolean(this.resolveChannelPin("Video.Rtsp.Only"));

    // Ensure RTSP is enabled on every channel. This is a write-through config change with no read-after-write: when a channel still needs RTSP, we enable them all and
    // return, letting the channels observer (wired in spawnCameraObservers) re-run this method once the change reconciles, at which point every channel reads back
    // enabled and we build the stream entries below. When RTSP is already on - the common case for any existing camera and every restart - we skip the PATCH and fall
    // through synchronously. The reducer dedups a no-op patch, so a redundant enable could never loop the observer regardless. When the controller declines the write -
    // an account without the full management role, or a transient controller failure - we narrate the outcome and fall through to stream from the channels that are
    // already RTSP-enabled, so a permissions-limited account keeps every stream its manual configuration provides. There is no failure latch: each later wake
    // re-attempts the write, so nothing goes stale across a reconnect or a mid-session role change.
    if(needsRtsp && this.ufp.channels.some(channel => !channel.isRtspEnabled)) {

      try {

        await this.device.update({ channels: this.ufp.channels.map(channel => ({ ...channel, isRtspEnabled: true })) });

        return null;
      } catch(error) {

        // The camera can be removed while the write is in flight, and the observer-wake presence gate only covers the synchronous prefix ahead of the await. We re-check
        // before touching the live record again...a vanished camera has nothing to narrate and nothing to derive.
        if(!this.recordPresent) {

          return null;
        }

        if(error instanceof ProtectAuthorizationError) {

          this.log.warn("Unable to enable RTSP on all of the camera's channels because this account does not have the full management role in UniFi Protect. " +
            "Direct RTSP streaming can only use channels that already have RTSP enabled. To make every streaming quality option available, grant the account the full " +
            "management role or enable RTSP on each of the camera's channels in the Protect webUI.");
        } else {

          this.log.warn("Unable to enable RTSP on all of the camera's channels: %s. Direct RTSP streaming can only use channels that already have RTSP enabled.",
            formatErrorMessage(error));
        }
      }
    }

    // Figure out which channels are primary camera channels. We filter out any package camera entries - we deal with those independently elsewhere. RTSP enablement is
    // deliberately NOT a filter term here: the livestream API serves any channel, so the flag is a per-consumer concern the RTSP-consuming selectors apply to their own
    // view of the published list.
    const cameraChannels = this.ufp.channels.filter(isPrimaryChannel);

    // The camera reports no primary channels at all - a controller-report oddity rather than anything the user can act on, so we say what we found and stop.
    if(!cameraChannels.length) {

      this.log.info("No usable video channels were found for this camera.");

      return null;
    }

    // Build the native RTSP entries from the primary channels, skipping any channel Protect reports with nonsensical dimensions. The resolution module owns the entry
    // construction (the friendly name, the native resolution tuple, and the SRTP URL composed against our host chain).
    const nativeEntries: ChannelProfile[] = [];

    for(const channel of cameraChannels) {

      // Sanity check in case Protect reports nonsensical resolutions.
      if(!channel.name || (channel.width <= 0) || (channel.width > 65535) || (channel.height <= 0) || (channel.height > 65535)) {

        continue;
      }

      nativeEntries.push(buildChannelProfile(channel, { rtspPort: this.nvr.ufp.ports.rtsps, urlHost: this.rtspHost }));
    }

    /* Nothing can serve this camera: it cannot reach the livestream API, and it has no usable RTSP stream to dial either, so it must not advertise itself to HomeKit at
     * all. Every camera the API CAN reach advertises whenever a sane primary channel exists - its live views degrade to the buffer path when RTSP cannot serve them -
     * which is why this terminal is the API-incapable population's alone.
     *
     * We evaluate it after the sanity pass so the answer agrees with the list we actually publish: "usable" means a channel that both has RTSP enabled and survived the
     * dimension check, so a camera whose only RTSP-enabled channel is a dimension oddity is never misdiagnosed as an RTSP-configuration problem.
     */
    if(!canUseLivestreamApi(this.ufp) && !nativeEntries.some(entry => entry.channel.isRtspEnabled)) {

      this.log.info("This camera cannot use the UniFi Protect livestream API and none of its channels have a usable RTSP stream enabled. " +
        "Enable at least one RTSP stream in the UniFi Protect webUI or grant the plugin's account the full management role.");

      return null;
    }

    // Synthesize the full advertised resolution list HomeKit consumes from the native entries. The list build is preference-free: the streaming-quality preference is a
    // request-time concern selectChannel applies, not a list-construction input. The all-channels-fail-sanity empty result re-asserts the device
    // short-circuit: an advertised list of zero entries must NOT construct a streaming delegate or call configureController - we return null before reaching either.
    const profiles = buildAdvertisedProfiles(nativeEntries);

    if(!profiles.length) {

      return null;
    }

    // Hand back the derived surface: the supported profiles with their URLs, and the resolution list the CameraController is built from.
    return { profiles: profiles, resolutions: profiles.map(profile => profile.resolution) };
  }

  /* The camera family's establishment HOST HOOK: everything a camera pins and narrates at the moment its streaming delegate is about to be built. Public because the
   * composed streaming capability calls it across the composition boundary, immediately before it constructs the delegate - so the profile pins this writes into the
   * hint bag are in place for the constructor that reads them. Synchronous by contract: it runs inside the create-once stretch, which yields nowhere.
   */
  public onStreamingEstablish(derived: AdvertisedStreams): void {

    // Inform users about our RTSP entry mapping, if we're debugging.
    if(this.hasFeature("Debug.Video.Startup")) {

      for(const entry of derived.profiles) {

        this.log.info("Mapping resolution: %s.", formatResolution(entry.resolution) + " => " + entry.name + " [" + this.videoCodecName + "]");
      }
    }

    // Check for explicit RTSP profile preferences. A pin carries only a genuine user choice; the substrate channel policy computes its own default when neither is set.
    // The hints keep their unset-when-unpinned convention, so an unselected pin reads as absent rather than as an empty choice.
    this.hints.rtspDefault = this.resolveChannelPin("Video.Rtsp.Only") ?? undefined;
    this.hints.substrateDefault = this.resolveChannelPin("Video.Timeshift.Only") ?? undefined;

    // Inform the user if they've pinned a direct-RTSP livestream profile.
    if(this.hints.rtspDefault) {

      this.log.info("Direct RTSP livestreaming is configured to use only: %s.", toStartCase(this.hints.rtspDefault.toLowerCase()));
    }

    // Inform the user if they've pinned the channel that populates the timeshift buffer.
    if(this.hints.substrateDefault) {

      this.log.info("The timeshift buffer is configured to use only: %s.", toStartCase(this.hints.substrateDefault.toLowerCase()));
    }

    // Inform the user when they've opted out of buffer-backed livestreaming. It is a transport preference rather than a guarantee: a camera with no RTSP-enabled stream
    // to dial serves its live views from the buffer instead, so the narration states the condition rather than promising the outcome.
    if(!this.hints.tsbStreaming) {

      this.log.info("Live views will stream directly from the camera over RTSP whenever an RTSP-enabled stream is available.");
    }

    // If the user has redirected the timeshift buffer to feed from the camera's RTSP stream, warn that this is for debugging only.
    if(this.hasFeature("Debug.Video.Timeshift.UseRtsp")) {

      this.log.warn("Feeding the timeshift buffer from the camera's RTSP stream is for debugging purposes only and unsupported. " +
        "It consumes more resources on both the Protect controller and the system running HBUP.");
    }

    // Inform the user if they've selected the legacy snapshot API.
    if(!this.hints.highResSnapshots) {

      this.log.info("Disabling the use of higher quality snapshots.");
    }
  }

  // Configure HomeKit Secure Video support.
  private configureHksv(): boolean {

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

      // Turning on picks a mode from the current (quantized) brightness through the policy leaf; turning off sends "off". The On pick never turns the mode off and never
      // sends an icrCustomValue, so the controller keeps its current custom value.
      const command: NightVisionCommand = (value === true) ?
        nightVisionModeForToggleOn({ currentLevel: service.getCharacteristic(this.hap.Characteristic.Brightness).value as number,
          currentMode: parseNightVisionMode(this.ufp.ispSettings.irLedMode) }) :
        { irLedMode: "off" };

      // Push the new night vision setting to the controller, reporting any failure through the shared command-error helper and reverting the characteristic on failure.
      if(!(await this.runDeviceCommand("set night vision to " + command.irLedMode, () => this.device.update({ ispSettings: command })))) {

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

      // Map the raw brightness to its controller command and the brightness to reflect back, through the policy leaf: it quantizes the level to a stop, picks the mode
      // (mode-preserving for the custom pair), and computes the reflected brightness from the icr transform.
      const { command, reflectedLevel } = nightVisionCommandForLevel({ currentMode: parseNightVisionMode(this.ufp.ispSettings.irLedMode), level: value as number });

      // Push the new night vision settings to the controller, reporting any failure through the shared command-error helper.
      if(!(await this.runDeviceCommand("adjust the night vision settings", () => this.device.update({ ispSettings: command })))) {

        return;
      }

      // Make sure we properly reflect what brightness we're actually at, given the differences in setting granularity between Protect and HomeKit.
      setTimeout(() => service.updateCharacteristic(this.hap.Characteristic.Brightness, reflectedLevel), 50);
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
    this.subscribeGet(mqttTopics.rtsp.topic, mqttTopics.rtsp.label, (): string => {

      // Grab all the available RTSP channels and return them as a JSON. The SRTP-enabled RTSPS URL is composed through the shared rtspUrl SSOT (secure by default) over
      // the secure rtsps port - the same composer and host chain the streaming path uses, so the published catalog cannot drift from the URL FFmpeg actually connects to.
      return JSON.stringify(Object.assign({}, ...this.fromRecord((config) => config.channels, []).filter(channel => channel.isRtspEnabled)
        .map(channel => ({ [channel.name]: rtspUrl(channel, this.rtspHost, this.nvr.ufp.ports.rtsps) }))));
    });

    // Trigger snapshots when requested.
    this.subscribeSet(mqttTopics.snapshot.topic, mqttTopics.snapshot.label, (value: string) => {

      // When we get the right message, we trigger the snapshot request.
      if(value !== "true") {

        return;
      }

      this.stream?.handleSnapshotRequest();
    });

    // Register the doorbell ring-trigger subscription, gated and once-guarded so a late promotion can register it without the construction call double-subscribing.
    this.configureDoorbellRingMqtt();

    return true;
  }

  // Register the doorbell ring-trigger MQTT subscription, exactly once, when the camera is a Protect doorbell or the user enabled the doorbell trigger.
  // homebridge-plugin-utils subscribe is not safe to call twice, so the registered-once guard prevents a double-subscription across the call sites (configureMqtt at
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
    this.subscribeSet(mqttTopics.doorbell.topic, mqttTopics.doorbell.label, (value: string) => {

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

    // The light sensor's reachability push belongs to the capability that owns the service, so we delegate rather than reach into the accessory, exactly as updateDevice
    // composes the doorbell capability's own refresh. The optional chain no-ops for a camera whose capability was never built or has been released - the package camera,
    // which never reaches the reconcile chokepoint, and any camera after teardown.
    this.#ambientLight?.updateAvailability();

    // Wake the supervisor on every availability change, both directions. The offline edge stops an in-flight buffer through the honest terminated path, and the online
    // edge re-establishes a buffer an offline-at-startup reconcile could not - so this is deliberately NOT reachability-gated. The optional chain no-ops for a camera
    // without a supervisor, and the reconcile's own coalescing makes any sweep-driven extra call a harmless no-op.
    void this.stream?.timeshift?.reconcile();
  }

  // Push the reachability projection, then wake the supervisor when the camera is reachable. Overrides the base to add the streaming-arm kick: the base rewrites
  // StatusActive from isReachable and reports the transition, and on a reachable camera we reconcile so a buffer that could not establish while the camera was unhealthy
  // re-establishes in place. The kick is reachability-gated - the unhealthy edge preserves recover-in-place and must not tear a live buffer down here - but is NOT keyed
  // on the returned transition, which is null when no service carries StatusActive, so the buffer still revives on a camera that advertises no StatusActive
  // characteristic.
  public override refreshReachability(): Nullable<{ now: boolean; was: boolean }> {

    const transition = super.refreshReachability();

    if(this.isReachable) {

      void this.stream?.timeshift?.reconcile();
    }

    this.#reconcileRebootReturn();

    return transition;
  }

  /**
   * Note that the controller rebooted and start watching for this camera to come back. Every camera blips when its controller reboots, so the plugin quiets those
   * disruptions for a settling window...a camera that is still away when the window expires is the genuine exception, and this watch is what gives it a voice. The fact
   * belongs to the physical camera rather than to HomeKit Secure Video, which is why it lives here beside the availability projection: a camera nobody records is
   * exactly as gone as one that is.
   *
   * Arming is unconditional. The controller's reboot event arrives only after a fresh bootstrap has re-dispatched current device state, so there is no pre-reboot
   * reading available to gate on, and gating on the live state would decline exactly the slow-reconnecting cameras this exists for. A reboot the plugin learns about
   * through its periodic refresh, with no outage at all, arms a watch that finds the camera present and says nothing. Registering under the key replaces whatever it
   * held, so a second reboot inside the window restarts the wait rather than stacking a second one.
   */
  public noteControllerRebooted(): void {

    this.timers.setTimeout("rebootReturn", () => this.#reportRebootAbsence(), PROTECT_NVR_REBOOT_RECENCY_MS);
  }

  // The watch reaching its expiry, evaluated in order. An unhealthy controller means the reboot's tail is still running, so we extend the wait by another
  // window rather than blame the camera for the controller's absence; that chain is bounded, ending when the controller returns, when the camera returns, or when this
  // device tears down and its registry drains. A camera whose controller record has vanished is being removed, which is not a failure to come back. Otherwise the
  // controller is healthy, this camera is still away, and that is the exception worth telling. The health read is deliberately separate from the reachability read
  // below, because the two carry different news; past the health guard, isReachable is exactly the camera's own device-state half, read through the same peek-guarded
  // helper every availability consumer uses.
  #reportRebootAbsence(): void {

    if(!this.nvr.client.connection.isHealthy) {

      this.noteControllerRebooted();

      return;
    }

    if(!this.recordPresent) {

      return;
    }

    if(this.isReachable || this.#rebootReturnWarned) {

      return;
    }

    this.#rebootReturnWarned = true;
    this.log.warn("This camera has not come back online since the controller rebooted.");
  }

  // Reconcile the reboot-return watch against this camera's current reachability. A reachable camera has answered the question the watch asked, so the wait ends here,
  // and a watch that had already spoken closes its story with a matching line at the same level - an operator scanning warn sees the alert and its all-clear together.
  // Every reachability path calls this because each carries different news: the camera's own state observe sees the device itself come back, while the controller-health
  // push is what a whole-controller recovery moves. An outage freezes the device state and the store dedups on the selected value, so a controller-health recovery
  // never wakes the state observe at all, which makes the override the path a real reboot recovery most often takes. Safe to call more than once: clearing an unarmed
  // key does nothing and the latch gates the line.
  #reconcileRebootReturn(): void {

    if(!this.isReachable) {

      return;
    }

    this.timers.clear("rebootReturn");

    if(!this.#rebootReturnWarned) {

      return;
    }

    this.#rebootReturnWarned = false;
    this.log.warn("The camera is back online.");
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

  // Find a direct-RTSP livestream configuration for a given target resolution, forwarded to the composed streaming capability that holds the advertised list and the
  // selection policy. A camera that has not acquired its capability advertises nothing, which is exactly the answer an empty list produces.
  public selectChannel(width: number, height: number, opts?: { biasHigher?: boolean; maxPixels?: number }): Nullable<ChannelProfile> {

    return this.#streaming?.selectChannel(width, height, opts) ?? null;
  }

  // Resolve the channel that populates the standing timeshift buffer feeding HomeKit Secure Video, buffer-backed live views, and snapshots, forwarded to the composed
  // streaming capability that owns the resolution policy. A camera that has not acquired its capability resolves nothing, exactly as an empty list would.
  public selectSubstrateChannel(): Nullable<ChannelProfile> {

    return this.#streaming?.selectSubstrateChannel() ?? null;
  }

  // Whether this camera has an RTSP-enabled stream to draw a direct session from, forwarded to the composed streaming capability that holds the advertised list. A
  // camera that has not acquired its capability has published nothing yet, so it has nothing to dial - which is exactly what false says.
  public get hasRtspStream(): boolean {

    return this.#streaming?.hasRtspStream ?? false;
  }

  // Utility property to return the camera's current video codec, formatted for display. Read non-throwing through the record: a camera in the removal grace whose record
  // has vanished reports an empty label rather than throwing, so every consumer - including the reconcile pass's HKSV acknowledgment, reached after an await where the
  // record could vanish - is safe on the vanished-record path.
  public get videoCodecName(): string {

    return this.fromRecord((config) => config.videoCodec.replace("h265", "hevc"), "").toUpperCase();
  }

  // Utility property to return whether the camera is HKSV capable or not.
  public get isHksvCapable(): boolean {

    return (!this.ufp.isThirdPartyCamera && !this.ufp.isAdoptedByAccessApp) || (this.ufp.isThirdPartyCamera && this.ufp.isPairedWithAiPort);
  }

  // Whether buffer-backed livestreaming is enabled and this camera is capable of it - the streaming demand arm of the standing timeshift buffer. This composes the
  // user's toggle with the shared livestream-API capability predicate, deliberately not the borrowed isHksvCapable, whose real meaning is motion-event capability for
  // HomeKit Secure Video. Because it does not exclude Access-adopted Ubiquiti cameras, those cameras join the streaming arm and the toggle does real work for them. The
  // one remaining provisional corner: a non-AiPort third-party camera stays excluded pending its own livestream-accessibility verification, and canUseLivestreamApi is
  // the single definition to widen when that is settled. The capability read goes through the record non-throwing (fromRecord), so a camera whose record has vanished in
  // the removal grace reports false rather than throwing on every consumer that reads it - the reconcile pass, the session-source decision, and the samplerate
  // advertisement. Evaluated live; the one restart-scoped consumer that samples it at construction (the streaming delegate's samplerate advertisement) is documented at
  // that call site.
  public get usesTimeshiftLivestream(): boolean {

    return this.hints.tsbStreaming && this.fromRecord(canUseLivestreamApi, false);
  }

  // The active recording mode, read non-throwing through the record. An absent record (a camera in the removal grace) reports an empty mode - which matches none
  // of the three recording switches - rather than throwing; the onGet, the initial write, and the reactive push all read this single source.
  private get recordingMode(): string {

    return this.fromRecord((config) => config.recordingSettings.mode, "");
  }

  // Utility property to return the current night vision state of a camera. It's a blunt instrument due to HomeKit constraints. An absent record reports off rather than
  // throwing.
  private get nightVision(): boolean {

    return this.fromRecord((config) => nightVisionActive(parseNightVisionMode(config.ispSettings.irLedMode)), false);
  }

  // Utility property to return the current night vision state of a camera, mapped to a brightness characteristic. An absent record reports 0 rather than throwing, and an
  // unrecognized wire value is surfaced here (the classifier's null is what triggers the error log) before the policy leaf maps the narrow mode to a brightness.
  private get nightVisionBrightness(): number {

    return this.fromRecord((config) => {

      const mode = parseNightVisionMode(config.ispSettings.irLedMode);

      if(mode === null) {

        this.log.error("Unknown night vision value detected: %s.", config.ispSettings.irLedMode);

        return 0;
      }

      return nightVisionBrightnessForMode({ icrCustomValue: config.ispSettings.icrCustomValue, mode });
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

    // If we have an out-of-range setting, clamp it to the valid range. FFmpeg's afftdn filter only accepts its noise-reduction (nr) parameter in the 0.01-97 decibel
    // range, so an out-of-range value lands at that boundary rather than causing FFmpeg to reject the filter outright.
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
