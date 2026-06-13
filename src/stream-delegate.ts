/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * stream-delegate.ts: FFmpeg-free streaming-delegate abstractions for UniFi Protect.
 *
 * These abstractions are the dependency-inversion seam between the camera devices and the concrete, FFmpeg-bound ProtectStreamingDelegate. A camera depends only on
 * the StreamingDelegate surface it reads off this.stream, and constructs its delegate through the StreamingDelegateFactory the platform holds (typed as the abstraction).
 * This keeps the camera free of any direct dependency on the FFmpeg-backed implementation, and lets a test platform substitute a stub factory so construction completes
 * without a real FFmpeg/HAP environment. The imports here are type-only by design, so this module never drags FFmpeg into the dependency graph.
 */
import type { CameraController, Resolution, SnapshotRequest, SnapshotRequestCallback } from "homebridge";
import type { FfmpegOptions, Nullable } from "homebridge-plugin-utils";
import type { ProtectCameraHost } from "./camera-host.ts";
import type { ProtectRecordingDelegate } from "./record.ts";

// The surface consumers read off this.stream - the exact set grounded across camera, camera-package, record, nvr, snapshot, and event-dispatch (no more, no less). The
// production implementation is ProtectStreamingDelegate; a test substitutes a stub. Properties are listed alphabetically.
export interface StreamingDelegate {

  // The doorbell-ness the controller's frozen audio options were built for. The CameraController's audio options, twoWayAudio/Speaker service, and supported-config TLVs
  // are constructor-frozen, so a camera the controller late-flips to a doorbell carries a controller built for the wrong doorbell-ness; the live-attach reads this to
  // detect that staleness and rebuild only when it genuinely diverges, performing zero controller churn when the delegate was already built with the correct value.
  readonly builtAsDoorbell: boolean;
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
