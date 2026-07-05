/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * stream-delegate.ts: FFmpeg-free streaming-delegate abstractions for UniFi Protect.
 *
 * These abstractions are the dependency-inversion seam between the camera devices and the concrete, FFmpeg-bound ProtectStreamingDelegate. A camera depends only on
 * the StreamingDelegate surface it reads off this.stream, and constructs its delegate through the StreamingDelegateFactory the platform holds (typed as the abstraction).
 * This keeps the camera free of any direct dependency on the FFmpeg-backed implementation, and lets a test platform substitute a stub factory so construction completes
 * without a real FFmpeg/HAP environment. The imports here are almost entirely type-only by design; the one runtime import is the hap `AudioStreamingSamplerate` enum the
 * pure samplerate helper returns. The runtime exports - the pure audioCapabilityAppeared and streamingSamplerates helpers - pull in only that hap enum, so this module
 * never drags FFmpeg into the dependency graph.
 */
import type { CameraController, Resolution, SnapshotRequest, SnapshotRequestCallback } from "homebridge";
import type { FfmpegOptions, Nullable } from "homebridge-plugin-utils";
import { AudioStreamingSamplerate } from "homebridge-plugin-utils";
import type { ProtectCameraHost } from "./camera-host.ts";
import type { ProtectRecordingDelegate } from "./record.ts";
import type { ProtectTimeshiftSupervisor } from "./timeshift-supervisor.ts";

// The frozen audio-options inputs a CameraController is built from - the two live-volatile capabilities that shape its constructor-frozen audio surface. A camera the
// controller late-reports as a doorbell, or as having a speaker, carries a controller built for the wrong identity; the live capability reconcile compares the
// controller's current capabilities against this and rebuilds in place only when one has appeared.
export interface AudioOptionsIdentity {

  readonly isDoorbell: boolean;
  readonly twoWayAudio: boolean;
}

// True when current reports a frozen audio capability that built lacked - the additive-eager, subtractive-conservative rising edge over an audio-options identity. A
// capability appearing (false to true) warrants an in-place controller rebuild; a capability reading false (a transient incomplete-bootstrap drain, a settled demotion)
// never does, so the symmetric "the identities differ" comparison - which would rebuild on the all-false reconnect drain - is deliberately not what this expresses.
export function audioCapabilityAppeared(built: AudioOptionsIdentity, current: AudioOptionsIdentity): boolean {

  return (current.isDoorbell && !built.isDoorbell) || (current.twoWayAudio && !built.twoWayAudio);
}

// The streaming audio sample rates a camera advertises to HomeKit. Doorbells and cameras streamed directly over RTSP (buffer-backed livestreaming off, or a camera not
// capable of it) both deliver a 48 kHz source that HomeKit does not support; since 16 and 24 kHz each divide 48 cleanly, we advertise both and let HomeKit choose. A
// buffer-backed camera's livestream API delivers 16 kHz, so it advertises just that. A pure helper, red-green testable per population.
export function streamingSamplerates(input: { isDoorbell: boolean; usesTimeshiftLivestream: boolean }): AudioStreamingSamplerate | AudioStreamingSamplerate[] {

  return (input.isDoorbell || !input.usesTimeshiftLivestream) ? [ AudioStreamingSamplerate.KHZ_16, AudioStreamingSamplerate.KHZ_24 ] : AudioStreamingSamplerate.KHZ_16;
}

// The surface consumers read off this.stream - the exact set grounded across camera, camera-package, record, nvr, and snapshot (no more, no less). The production
// implementation is ProtectStreamingDelegate; a test substitutes a stub. Properties are listed alphabetically.
export interface StreamingDelegate {

  // The frozen audio-options identity the controller was built for - its two live-volatile capabilities, doorbell-ness and two-way audio. The CameraController's audio
  // options, twoWayAudio/Speaker service, and supported-configuration TLVs are constructor-frozen, so a camera the controller late-reports as a doorbell or as having a
  // speaker carries a controller built for the wrong identity; the live capability reconcile reads this to detect that staleness and rebuilds in place only when a frozen
  // audio capability has appeared, performing zero controller churn when the delegate was already built for the current identity.
  readonly builtFor: AudioOptionsIdentity;
  controller: CameraController;
  readonly ffmpegOptions: FfmpegOptions;
  handleSnapshotRequest(request?: SnapshotRequest, callback?: SnapshotRequestCallback): Promise<void>;
  hksv: Nullable<ProtectRecordingDelegate>;
  readonly probesize: number;
  resetProbesizeOverride(): void;
  shutdown(): void;

  // The camera's standing-buffer supervision seam: the timeshift supervisor that owns the standing buffer's lifecycle for an HKSV-capable camera, or null when the
  // camera cannot back HomeKit Secure Video. The controller-disconnect and camera-teardown paths reach through this to shut supervision down terminally, and the
  // snapshot and livestream paths read the supervised buffer through it.
  timeshift: Nullable<ProtectTimeshiftSupervisor>;
}

// The creational abstraction: build a StreamingDelegate for a camera and its advertised resolutions. Creation is deferred because the delegate needs the camera and its
// computed resolutions, so this is a factory rather than instance injection. The platform holds the production factory typed as this abstraction.
export interface StreamingDelegateFactory {

  create(camera: ProtectCameraHost, resolutions: Resolution[]): StreamingDelegate;
}
