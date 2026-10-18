/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * stream-delegate.ts: FFmpeg-free streaming-delegate abstractions for UniFi Protect.
 *
 * These abstractions are the dependency-inversion boundary between the camera devices and the concrete, FFmpeg-bound ProtectStreamingDelegate. A camera depends only on
 * the StreamingDelegate surface it reads off this.stream, and constructs its delegate through the StreamingDelegateFactory the platform holds (typed as the abstraction).
 * This keeps the camera free of any direct dependency on the FFmpeg-backed implementation, and lets a test platform substitute a stub factory so construction completes
 * without a real FFmpeg/HAP environment. The imports here are type-only by design except for what the pure helpers below compute with, and each of those is a leaf
 * that reaches no FFmpeg, so this module never drags FFmpeg into the dependency graph.
 */
import type { CameraController, Resolution, SnapshotRequest, SnapshotRequestCallback } from "homebridge";
import type { FfmpegOptions, Nullable } from "homebridge-plugin-utils";
import { AudioStreamingSamplerate } from "homebridge-plugin-utils";
import type { ProtectCameraHost } from "./camera-host.ts";
import type { ProtectRecordingDelegate } from "./record.ts";
import type { ProtectTimeshiftSupervisor } from "./timeshift-supervisor.ts";
import { canUseLivestreamApi } from "./stream-source-policy.ts";

// The identity a CameraController is built for: every live-volatile camera fact its constructor freezes into it. HAP fixes a controller's options at construction, so
// a camera the controller reports a capability for only after adoption carries a controller built for the wrong identity; the live capability reconcile compares the
// camera's current identity against this and rebuilds in place only when a term has appeared.
export interface ControllerIdentity {

  // Whether the camera could reach the livestream API when the controller was built, which decides its streaming sample rates and whether a timeshift supervisor
  // stands behind it.
  readonly canUseLivestreamApi: boolean;

  // Whether the camera could back HomeKit Secure Video when the controller was built, which decides its recording arm and its link to the motion sensor.
  readonly hksvCapable: boolean;

  // Whether the controller was built for a doorbell, which decides its recording and streaming sample rates.
  readonly isDoorbell: boolean;

  // Whether the controller was built with two-way audio, which decides its streaming audio options and its speaker service.
  readonly twoWayAudio: boolean;
}

// True when current carries a term that built lacked - the additive-eager, subtractive-conservative rising edge over a controller identity. A term appearing (false to
// true) warrants an in-place controller rebuild; a term reading false (a transient incomplete-bootstrap drain, a settled withdrawal) never does, so the symmetric "the
// identities differ" comparison - which would rebuild on the all-false reconnect drain - is deliberately not what this expresses. The edge runs over the record's own
// keys, so a term the identity gains joins it with no edit here.
export function controllerCapabilityAppeared(built: ControllerIdentity, current: ControllerIdentity): boolean {

  return (Object.keys(current) as (keyof ControllerIdentity)[]).some((term) => current[term] && !built[term]);
}

// The one derivation of a controller identity from the camera a controller serves. The production delegate and the test stub both capture their builtFor through it,
// and the live capability reconcile reads the camera's current identity through it, so the identity a controller is built for and the identity it is checked against
// are spelled once.
export function controllerIdentityOf(host: ProtectCameraHost): ControllerIdentity {

  return { canUseLivestreamApi: canUseLivestreamApi(host.ufp), hksvCapable: host.isHksvCapable, isDoorbell: host.ufp.featureFlags.isDoorbell,
    twoWayAudio: host.hints.twoWayAudio };
}

// The streaming audio sample rates a camera advertises to HomeKit. This condition deliberately encodes TWO wire facts, so it does not defer to livestreamAudioSampleRate:
// on the fMP4 livestream a doorbell delivers 48 kHz and every other camera 16 kHz (the half livestreamAudioSampleRate owns), while a camera streamed directly over RTSP
// delivers a 48 kHz source regardless of type. Both 48 kHz sources exceed what HomeKit supports; since 16 and 24 kHz each divide 48 cleanly, we advertise both and let
// HomeKit choose. The capability - not the user's transport preference - is what decides: a camera that can reach the livestream API may serve any given session from
// the 16 kHz buffer track whatever the toggle says, so it advertises just 16 kHz, while doorbells and cameras the API cannot reach are RTSP-served and get both. The
// wider advertisement coexists with buffer-served sessions the same way a 16 kHz advertisement coexists with the direct-RTSP sessions the buffer-down fallback serves.
// A pure helper, red-green testable per population.
export function streamingSamplerates(input: { canUseLivestreamApi: boolean; isDoorbell: boolean }): AudioStreamingSamplerate | AudioStreamingSamplerate[] {

  return (input.isDoorbell || !input.canUseLivestreamApi) ? [ AudioStreamingSamplerate.KHZ_16, AudioStreamingSamplerate.KHZ_24 ] : AudioStreamingSamplerate.KHZ_16;
}

// The surface consumers read off this.stream - the exact set grounded across camera, camera-package, record, and snapshot (no more, no less). The production
// implementation is ProtectStreamingDelegate; a test substitutes a stub. Properties are listed alphabetically.
export interface StreamingDelegate {

  // The controller identity this delegate's CameraController was built for, captured at construction through controllerIdentityOf. Every surface the identity decides
  // is constructor-frozen, so the live capability reconcile reads this to tell a controller built for a stale identity from a current one, and rebuilds in place only
  // when a term has appeared since, performing zero controller churn when the delegate was already built for the current identity.
  readonly builtFor: ControllerIdentity;

  // The HAP CameraController this delegate drives.
  controller: CameraController;

  // The resolved FFmpeg invocation options every pipeline this delegate spawns shares.
  readonly ffmpegOptions: FfmpegOptions;

  // HAP's snapshot-request entry point, forwarded to the camera's multi-source snapshot acquisition.
  handleSnapshotRequest(request?: SnapshotRequest, callback?: SnapshotRequestCallback): void;

  // The camera's HomeKit Secure Video recording delegate, or null when the camera cannot back HKSV.
  hksv: Nullable<ProtectRecordingDelegate>;

  // The current FFmpeg probesize, self-tuned upward after a probesize-estimation failure and read by the delegate's next spawn.
  readonly probesize: number;

  // Clear any self-tuned probesize override, returning the next spawn to the configured default.
  resetProbesizeOverride(): void;

  // End every streaming session this delegate holds and wind its probesize self-tuning back. Safe to call more than once - a repeat call finds no sessions and nothing
  // to reset - so a caller that pairs this with another teardown never needs to track whether it has already run.
  shutdown(): void;

  // The camera's standing-buffer supervision interface: the timeshift supervisor that owns the standing buffer's lifecycle for a camera that can reach the livestream
  // API, or null when the camera cannot. The controller-disconnect and camera-teardown paths reach through this to shut supervision down terminally, and the snapshot
  // and livestream paths read the supervised buffer through it.
  timeshift: Nullable<ProtectTimeshiftSupervisor>;
}

// The creational abstraction: build a StreamingDelegate for a camera and its advertised resolutions. Creation is deferred because the delegate needs the camera and its
// computed resolutions, so this is a factory rather than instance injection. The platform holds the production factory typed as this abstraction.
export interface StreamingDelegateFactory {

  create(camera: ProtectCameraHost, resolutions: Resolution[]): StreamingDelegate;
}
