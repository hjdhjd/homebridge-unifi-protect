/* Copyright(C) 2019-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * streaming.ts: Streaming capability for UniFi Protect cameras.
 */
import type { AdvertisedStreams, ProtectCamera } from "./camera.ts";
import type { ChannelProfile, SelectRequest } from "../../media/resolution.ts";
import { capByPixels, selectChannelProfile, selectSubstrateChannelFrom } from "../../media/resolution.ts";
import { controllerCapabilityAppeared, controllerIdentityOf } from "../../media/stream-delegate.ts";
import type { Nullable } from "homebridge-plugin-utils";
import { ProtectDeviceCapability } from "../device-capability.ts";
import type { ProtectNvr } from "../../nvr/nvr.ts";
import type { StreamingDelegate } from "../../media/stream-delegate.ts";

/* The streaming capability composed onto a ProtectCamera: the camera family's whole streaming LIFECYCLE POLICY in one place - when a delegate may be built, when it is
 * rebuilt, when it is torn down, and which channel each consumer selects. The media machinery underneath (ProtectStreamingDelegate and everything it owns) is untouched
 * by this class; what lives here is the policy that decides its lifetime, reached through the platform-held factory that keeps FFmpeg out of this dependency graph.
 *
 * ONE CLASS FOR BOTH CAMERA VIEWS. A parent camera and its package view are two hosts with one streaming policy between them, and the only thing that genuinely differs
 * is the DERIVATION - the parent negotiates its channel set and awaits a controller write-through where the configuration streams over RTSP, while the package reads its
 * single fixed channel straight off the shared projection. That difference lives on the host, behind deriveAdvertisedStreams, so this class holds exactly one
 * create-when-ready rule that serves both.
 *
 * NO PROJECTION HANDLE, deliberately, and a divergence from the two other camera-family capabilities: they hold a `device` handle because their host contract does not
 * expose the projection, while this capability's concrete host does. A second handle would be a second path to one truth, so every projection read here goes through
 * this.host.ufp, which is a live read that throws when the camera's controller record is gone - the exposure every consumer of this policy has always carried.
 *
 * IT IMPLEMENTS reconcile() AND NOT configure(): every line of its body is convergence. reconcile() is called at the host's construction, and again on each streaming
 * observer wake and each package-channel arrival; it derives, publishes, and - the first time a derivation yields something advertisable - stands the delegate up. Every
 * later call re-derives and returns at the create-once gate, which is what keeps the advertised list fresh for the selectors while leaving the standing delegate alone.
 *
 * A DERIVATION MAY CARRY A RESOURCE until the delegate exists: the parent's derivation reads the recording audio format from a livestream subscription it opens before
 * the first build, and hands that subscription on so the delegate's buffer adopts it. The build that takes the derivation owns the subscription from then on, and every
 * derivation whose build does not happen - a delegate an overlapping reconcile already built, or a construction gate that closed - disposes its subscription here, so two
 * derivations that overlap before the build leave exactly one live subscription.
 *
 * THE SYNCHRONOUS PATH. An async body runs synchronously up to its first EXECUTED await, so a host whose derivation returns a plain value never yields at all: derive,
 * narrate, create, and register all complete inside the caller's own call frame. That is what keeps the package camera's controller registration on the same tick as the
 * call that asked for it, which its deferral narration reads the outcome of. The instanceof test below is what preserves that property, and a behavioral pin guards it.
 *
 * TEARDOWN. cleanup() tears the machinery down explicitly before the contract's own cleanup aborts this capability's controller...the delegate is not signal-bound state,
 * so nothing else would release its HomeKit controller registration or its pooled livestream subscriptions.
 */
export class StreamingCapability extends ProtectDeviceCapability<ProtectCamera> {

  // The advertised channel-profile list the selectors below choose from, republished by every derivation. Seeded empty, which is what makes a selector called before the
  // first derivation return nothing rather than throw. On a package instance it holds the single package profile and nothing reads it, which is honest: the package's own
  // selector overrides answer from its fixed channel directly.
  #profiles: ChannelProfile[] = [];
  // The streaming delegate this capability owns, or null until a derivation yields something advertisable. PRIVATE with a read-only accessor below: every write lives in
  // this class, so the create-once rule and the teardown ordering cannot be circumvented from outside.
  #stream: Nullable<StreamingDelegate> = null;

  // Construct the capability against its owning camera. The camera passes itself and its own per-accessory lifetime signal from inside its own class body, so no
  // visibility widening is needed. No projection handle is taken - see the class narrative above.
  constructor(nvr: ProtectNvr, init: { host: ProtectCamera; signal: AbortSignal }) {

    super(nvr, { host: init.host, signal: init.signal });
  }

  // The streaming delegate, or null while none has been built. The read-only window onto the private field, consumed by the host's own forward and by the machinery's
  // external readers.
  public get stream(): Nullable<StreamingDelegate> {

    return this.#stream;
  }

  // Whether this camera is currently transmitting a HomeKit Secure Video recording. Null-safe at both hops, so a camera with no delegate - or one with HKSV unconfigured
  // - answers false rather than throwing.
  public get isRecordingTransmitting(): boolean {

    return this.#stream?.hksv?.isTransmitting ?? false;
  }

  // Converge this camera's streaming surface: derive, publish the advertised list, and stand the delegate up the first time the derivation yields one.
  public override async reconcile(): Promise<void> {

    /* Resolve the host's derivation without forcing it onto a microtask. A host whose derivation is genuinely synchronous hands back a plain value, and testing for a
     * promise is what lets this body consume it without yielding - so the package camera's derive-narrate-create-register chain completes inside its caller's call frame
     * and its controller registration stays on the same tick. Collapsing this into an unconditional await would compile and read more simply while silently deferring
     * that registration past the caller's own frame, which is the behavior change this shape exists to prevent.
     */
    const result = this.host.deriveAdvertisedStreams();
    const derived = (result instanceof Promise) ? await result : result;

    if(!derived) {

      return;
    }

    // Publish the advertised list before the create-once half runs. The selectors read this list, so a re-derive that lands once the delegate already exists still
    // refreshes what they see even though the create half declines at its gate.
    this.#profiles = derived.profiles;

    // A derivation whose build did not happen releases the probe subscription it carried, since no delegate will ever adopt it. See the class narrative above.
    if(!this.#establish(derived) && derived.probe) {

      void derived.probe.subscription[Symbol.asyncDispose]();
    }
  }

  /* Stand up the streaming delegate and register its CameraController, exactly once per capability. SYNCHRONOUS by design - nothing yields between the create-once gate
   * and configureController, so two concurrent callers can never both pass the gate while the field is still null. That race freedom is what lets the channels and
   * videoCodec observers fire in the same drain safely; an await introduced anywhere in this stretch lets one camera build two delegates. The host's construction gate
   * covers the rebuild path, which can reach here on an accessory mid-removal or after controller shutdown has begun: neither a being-removed camera nor a shutting-down
   * controller may register a controller that no teardown walk would ever reach. Returns whether this call built the delegate, so the caller can release whatever the
   * derivation carried that only a build would have taken over.
   */
  #establish(derived: AdvertisedStreams): boolean {

    // We've already built the delegate for this camera - we're done here.
    if(this.#stream) {

      return false;
    }

    // The accessory is being removed, or the controller is shutting down - do not stand up a controller on it.
    if(!this.host.canConfigureStream) {

      return false;
    }

    // Let the host pin its profile preferences and narrate the establishment before the delegate's constructor reads the hint bag those pins write into.
    this.host.onStreamingEstablish(derived);

    // Configure the video stream with the derived streams: the resolutions, the recording audio format, and the probe subscription the delegate's buffer adopts.
    this.#stream = this.platform.streamingDelegateFactory.create(this.host, derived);

    // Fire up the controller and inform HomeKit about it. The controller's services are part of what Homebridge's accessory cache holds for the accessory, so we mark
    // it for the next save, at the cost of one batched save each start, when every camera establishes its controller anew.
    this.accessory.configureController(this.#stream.controller);
    this.platform.persistence.persist(this.accessory);

    // Tell the host its controller is registered, so it can configure the services the registration gave the accessory. The call is synchronous, like the rest of this
    // stretch.
    this.host.onControllerRegistered();

    // Kick the supervisor so the standing timeshift buffer establishes for this camera's streaming arm, independent of any HomeKit Secure Video recording demand.
    void this.#stream.timeshift?.reconcile();

    return true;
  }

  /* Reconcile the delegate's constructor-frozen controller identity against the camera's live capabilities. A CameraController is built from live-volatile camera facts -
   * every term of its controller identity - so a camera the controller reports a capability for only after adoption carries a controller built for the wrong identity,
   * with that capability baked off until a restart. This refreshes the speaker-derived hints and rebuilds the controller in place when a frozen term has appeared,
   * single-sourcing the in-place controller rebuild across every late capability.
   *
   * A reading taken while the camera's record does not report it connected is not acted on: the decline sits ahead of the rising edge, and the camera's state observer
   * re-runs the capability reconcile when the camera connects, which is when a held-back reading lands. The hint refresh runs ahead of the decline, so a speaker the
   * controller reports while the camera is not connected raises the sticky hint at once and its rebuild applies on connect.
   */
  public reconcileControllerCapabilities(): void {

    // Additively refresh the speaker-derived hints, mirroring the additive rebuild below: a capability appearing raises the hint (so a deferred first stream build and
    // the runtime talkback path read it), while a transient incomplete-bootstrap drain that reports the speaker absent leaves an established hint untouched - the same
    // subtractive-conservative discipline, so a reconnect blip never disturbs two-way audio. The host's configureHints establishes the baseline at construction; this is
    // the only live refresher. Running before the no-delegate guard is what closes the deferred-build window.
    this.host.hints.twoWayAudio ||= this.host.ufp.featureFlags.hasSpeaker && this.hasFeature("Audio") && this.hasFeature("Audio.TwoWay");
    this.host.hints.twoWayAudioDirect ||= this.host.ufp.featureFlags.hasSpeaker && this.hasFeature("Audio") && this.hasFeature("Audio.TwoWay.Direct");

    // No delegate yet: the create-once path builds it from the just-refreshed hints, so there is nothing to rebuild. This also covers construction.
    if(!this.#stream) {

      return;
    }

    // The camera's record does not report it connected, so the reading waits for the connect re-run rather than rebuilding a controller for a camera that is away.
    if(!this.host.isOnline) {

      return;
    }

    // Rebuild the controller in place only when a frozen term has appeared since it was built - the additive-eager, subtractive-conservative rising edge. A term
    // reading false (the all-false featureFlags drain a deep re-adopt delivers, a settled withdrawal) never rebuilds, so a deep re-adopt never flickers the controller
    // (an HKSV reset and a stream interruption).
    if(!controllerCapabilityAppeared(this.#stream.builtFor, controllerIdentityOf(this.host))) {

      return;
    }

    this.#rebuild();
  }

  /* Rebuild the delegate and its CameraController in place - the one HAP object the capability reconcile cannot mutate, since every surface its controller identity
   * decides is constructor-frozen. The teardown's removeController runs synchronously; clearing the field re-opens the create-once gate; reconcile's create half lands
   * as soon as the host's derivation resolves, a derivation that waits on the recording audio probe for a camera that can back HomeKit Secure Video, so
   * remove-before-configure ordering holds and exactly one removeController plus one configureController fire here. The HomeKit consequences of a reclassification -
   * the HKSV factory reset (removeController) and the supported-config hash change - land at exactly this transition. The tail can resolve on a later microtask, since
   * the parent's derivation may await a write-through update, so the create half's construction gate is what prevents a re-register when the accessory is removed, or
   * controller shutdown begins, inside that window. The re-create goes through the host's own derivation, so each camera view rebuilds from the surface it actually
   * advertises, reading every term of its identity live. (It inherits the benign fire-and-forget updateRecordingActive(false) call in #teardown below, which issues
   * that write without awaiting it.)
   */
  #rebuild(): void {

    this.#teardown();
    this.#stream = null;

    void this.reconcile();
  }

  // Tear this camera's delegate down and unregister its CameraController. Both cleanup (on deletion) and the controller-identity rebuild tear the delegate down through
  // one path: HKSV recording off, the live and timeshift consumers shut down (releasing their pool subscriptions), and the controller removed from HomeKit.
  #teardown(): void {

    // If we've got HomeKit Secure Video enabled and recording, disable it - fire-and-forget, since teardown does not wait on the controller's acknowledgment.
    if(this.#stream?.hksv?.isRecording) {

      this.#stream.hksv.updateRecordingActive(false);
    }

    // Tear down this camera's livestream consumers so their pool subscriptions are released. The camera does not own livestream sessions - the stream (live) and
    // timeshift (HKSV) consumers own the subscriptions, and disposing them decrements the pool refcount to zero. Mirrors the controller disconnect walk's per-camera
    // teardown.
    this.#stream?.shutdown();
    this.#stream?.timeshift?.shutdown();

    // Unregister our controller, marking the accessory for the next save, since the controller's services leave it.
    if(this.#stream) {

      this.accessory.removeController(this.#stream.controller);
      this.platform.persistence.persist(this.accessory);
    }
  }

  // Tear the machinery down before the contract's cleanup aborts this capability's controller. The delegate is not signal-bound state, so the abort alone would leave its
  // HomeKit controller registered and its pooled subscriptions held; the explicit teardown is what releases both.
  public override cleanup(): void {

    this.#teardown();

    super.cleanup();
  }

  // Reset the delegate's accumulated probesize self-tuning after a controller reboot. Every reboot re-adopts and restarts the camera's stream from scratch, so the
  // per-camera latch it carries is stale; a camera with no delegate has nothing to reset.
  public recoverFromControllerReboot(): void {

    this.#stream?.resetProbesizeOverride();
  }

  /* Release the connection-dependent machinery this capability holds, for the controller-disconnect walk. Deliberately NOT the full teardown: this is a strict subset of
   * it - no HomeKit Secure Video recording-off, no controller removal - because the walk runs against a connection that is going away, not against a camera that is. What
   * has to happen before the client is disposed is exactly the release of the pooled livestream subscriptions the live and timeshift consumers hold, so that is all this
   * does; the HomeKit surface stays registered for the reconnect that follows.
   */
  public releaseForShutdown(): void {

    this.#stream?.shutdown();
    this.#stream?.timeshift?.shutdown();
  }

  // The RTSP-enabled subset of the published list: the view every RTSP-consuming path selects from, since a channel without RTSP enabled has no stream to dial. The
  // substrate selector deliberately reads the FULL published list instead, because the livestream API serves any channel regardless of the flag.
  get #rtspProfiles(): ChannelProfile[] {

    return this.#profiles.filter(profile => profile.channel.isRtspEnabled);
  }

  // Whether this camera currently has at least one RTSP-enabled stream to draw a direct session from - the camera-family fact the session-source decision reads. It reads
  // the published list, which republishes on every successful derivation, so within a request the fact stays coherent with what selectChannel actually serves...the same
  // freshness envelope every selector here already carries.
  public get hasRtspStream(): boolean {

    return this.#rtspProfiles.length > 0;
  }

  // Find a direct-RTSP livestream configuration for a given target resolution. This is the device wrapper over the pure selectChannelProfile: it injects our published
  // entries and our host's state (the direct-RTSP default, which pins to a named channel, and the optional hardware pixel cap), then delegates the selection mathematics.
  // We select over the RTSP-enabled subset because this is a direct-RTSP session: a channel the controller has not enabled has no stream for FFmpeg to connect to.
  // The pixel cap is applied as a mode-agnostic pre-filter BEFORE selection - intentionally a pre-filter, not part of the request, so it filters the name branch too (a
  // constrained request with an explicit profile preference still drops profiles above the cap); a future reader should not move it into the request.
  public selectChannel(width: number, height: number, opts?: { biasHigher?: boolean; maxPixels?: number }): Nullable<ChannelProfile> {

    const entries = capByPixels(this.#rtspProfiles, opts?.maxPixels);
    const request: SelectRequest = this.host.hints.rtspDefault ? { mode: "name", name: this.host.hints.rtspDefault } :
      { bias: opts?.biasHigher ? "higher" : "lower", height: height, mode: "nearest", width: width };

    return selectChannelProfile(entries, request);
  }

  // Resolve the channel that populates the standing timeshift buffer feeding HomeKit Secure Video, buffer-backed live views, and snapshots. The device wrapper over the
  // pure selectSubstrateChannelFrom, which holds the policy: it injects the full published list, because the livestream API that fills the buffer serves any channel
  // whether or not the controller has RTSP enabled on it, the host system, and the user's substrate pin.
  public selectSubstrateChannel(): Nullable<ChannelProfile> {

    // The published entries filtered by the host encoder's source ceiling. The cap is a mode-agnostic pre-filter applied BEFORE selection, so it filters the name-pin
    // branch too - a pin to a channel the cap drops honestly selects nothing rather than substituting. It is Infinity on every host today (HKSV software-encodes wherever
    // a pixel cap would apply), so this passes everything through; it engages only when a future predicate change hardware-encodes on a pixel-limited host.
    const entries = capByPixels(this.#profiles, this.#stream?.ffmpegOptions.maxSourcePixels("record"));

    return selectSubstrateChannelFrom(entries, { hostSystem: this.platform.codecSupport.hostSystem, pin: this.host.hints.substrateDefault ?? null });
  }
}
