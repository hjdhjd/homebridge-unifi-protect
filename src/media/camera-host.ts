/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * camera-host.ts: the camera contract the media delegates depend on for UniFi Protect.
 *
 * This is the dependency-inversion seam on the camera side of the media stack: the streaming, recording, snapshot, and timeshift delegates each operate on a
 * camera, but they read only this narrow slice of it, not the whole concrete ProtectCamera. Typing the delegates against ProtectCameraHost (rather than the
 * class) decouples the media layer from the device leaf and lets a test construct a delegate against a small stub host instead of standing up a full camera.
 * ProtectCameraHost is the camera-specific media surface; it extends ProtectDeviceContext, the shared device-and-plugin-context slice every collaborator reads,
 * so the interface pair mirrors the real ProtectDevice -> ProtectCamera hierarchy. The imports here are type-only by design - this module adds no runtime edge,
 * and its type-only reference to StreamingDelegate (mirrored by that module's factory param) is the same benign, erased cycle the camera and its delegate already
 * formed directly.
 */
import type { ProtectCameraConfig, SnapshotOptions, TalkbackSession } from "unifi-protect";
import type { ChannelProfile } from "./resolution.ts";
import type { LivestreamSubscription } from "./livestream.ts";
import type { Nullable } from "homebridge-plugin-utils";
import type { ProtectDeviceContext } from "../devices/device.ts";
import type { StreamingDelegate } from "./stream-delegate.ts";
import type { WithoutIdentity } from "../types.ts";

// The per-subscription options a media consumer passes to ProtectCameraHost.livestream(). One definition shared by the seam contract below and ProtectCamera's
// implementation, so a widening lands in a single place rather than drifting between two inline literals.
export interface LivestreamHostOptions {

  // Discard any still-queued, undelivered segments the instant this subscription is disposed, rather than draining them first, so a restart never feeds the
  // freshly-committed buffer stale bytes from the replaced subscription. Forwarded to the pooled Camera.livestream(); the RTSP-debug adapter ignores it by construction,
  // since its own FFmpeg-fed subscription has no pooled queue to discard.
  discardOnDispose?: boolean;

  // The fMP4 segment length in milliseconds. It enters the pool's sharing key, so buffer-backed consumers must agree on it to share one pooled session.
  segmentLength?: number;

  // An abort signal that disposes this subscription (and only this one - a shared session lives as long as any subscriber remains).
  signal?: AbortSignal;

  // The consumer's recovery and media-stall urgency closure, pulled live by the pool's recovery and detection policy.
  urgency?: () => number;
}

// The camera surface the streaming, recording, snapshot, and timeshift delegates read off the camera they serve. ProtectCamera implements this; the package
// camera satisfies it by inheritance. Every member is read-only at the call sites, so properties are readonly and getters satisfy them directly.
export interface ProtectCameraHost extends ProtectDeviceContext {

  // Builds the FFmpeg audio-filter chain against the camera's true input sample rate (live and HKSV-recording audio paths).
  getAudioFilters(sampleRate?: number): string[];

  // Whether this camera can back HomeKit Secure Video - gates recording-delegate construction and the recording/motion controller options.
  readonly isHksvCapable: boolean;

  // Opens the pooled fMP4 livestream subscription for a channel profile (the live path and the HKSV timeshift buffer both draw from this).
  livestream(channelProfile: ChannelProfile, opts?: LivestreamHostOptions): LivestreamSubscription;

  // The bare device MAC for topic addressing - the immutable identity the narrowed live-state projection (ufp) below no longer carries. The MQTT snapshot topic scopes
  // under this.
  readonly mac: string;

  // Reboots the camera through the controller - the consumer half of livestream self-heal.
  reboot(): Promise<void>;

  // Resolves the best-fit channel profile for a requested live/snapshot resolution.
  selectChannel(width: number, height: number, opts?: { biasHigher?: boolean; maxPixels?: number }): Nullable<ChannelProfile>;

  // Resolves the channel profile that populates the standing timeshift buffer feeding HomeKit Secure Video, buffer-backed live views, and snapshots.
  selectSubstrateChannel(): Nullable<ChannelProfile>;

  // Acquires a snapshot via the controller's snapshot command (the narrow controller-snapshot seam).
  snapshotFromController(opts?: SnapshotOptions): Promise<Buffer>;

  // The streaming delegate the camera owns - the gateway the recording, snapshot, and timeshift consumers read for ffmpegOptions, hksv, and the controller.
  readonly stream?: StreamingDelegate;

  // Opens a send-direction two-way-audio (talkback) channel to the camera's speaker.
  talkback(opts?: { signal?: AbortSignal }): Promise<TalkbackSession>;

  // The camera-narrowed Protect device live-state projection (featureFlags / videoCodec / talkbackSettings / ledSettings for the media paths), with device identity
  // dropped - the bare MAC is read through the dedicated mac member above, not this throwing projection.
  readonly ufp: Readonly<WithoutIdentity<ProtectCameraConfig>>;

  // Whether buffer-backed livestreaming is enabled and the camera is capable of it - the streaming demand arm of the standing buffer, read live by the supervisor, the
  // session-source decision, and the samplerate advertisement.
  readonly usesTimeshiftLivestream: boolean;

  // The human-readable video codec label for log lines.
  readonly videoCodecName: string;
}
