/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * stream-delegate.ts: FFmpeg-free streaming-delegate abstractions for UniFi Protect.
 *
 * These abstractions are the dependency-inversion seam between the camera devices and the concrete, FFmpeg-bound ProtectStreamingDelegate. A camera depends only on
 * the StreamingDelegate surface it reads off this.stream, and constructs its delegate through the StreamingDelegateFactory the platform holds (typed as the abstraction).
 * This keeps the camera free of any direct dependency on the FFmpeg-backed implementation, and lets a test platform substitute a stub factory so construction completes
 * without a real FFmpeg/HAP environment. The imports here are type-only by design, and the lone runtime export - the pure audioCapabilityAppeared predicate - imports
 * nothing at runtime, so this module never drags FFmpeg into the dependency graph.
 */
import type { CameraController, Resolution, SnapshotRequest, SnapshotRequestCallback } from "homebridge";
import type { FfmpegOptions, Nullable } from "homebridge-plugin-utils";
import type { ProtectCameraHost } from "./camera-host.ts";
import type { ProtectRecordingDelegate } from "./record.ts";

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

// The surface consumers read off this.stream - the exact set grounded across camera, camera-package, record, nvr, snapshot, and event-dispatch (no more, no less). The
// production implementation is ProtectStreamingDelegate; a test substitutes a stub. Properties are listed alphabetically.
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
}

// The creational abstraction: build a StreamingDelegate for a camera and its advertised resolutions. Creation is deferred because the delegate needs the camera and its
// computed resolutions, so this is a factory rather than instance injection. The platform holds the production factory typed as this abstraction.
export interface StreamingDelegateFactory {

  create(camera: ProtectCameraHost, resolutions: Resolution[]): StreamingDelegate;
}
