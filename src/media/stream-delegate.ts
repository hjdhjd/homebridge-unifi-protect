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
import { AudioRecordingCodecType, AudioRecordingSamplerate, AudioStreamingSamplerate } from "homebridge-plugin-utils";
import type { CameraController, SnapshotRequest, SnapshotRequestCallback } from "homebridge";
import type { FfmpegOptions, Nullable } from "homebridge-plugin-utils";
import type { AdvertisedStreams } from "../devices/cameras/camera.ts";
import type { LivestreamDescription } from "unifi-protect";
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

  // Whether the controller was built for a doorbell, which decides its streaming sample rates.
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

// The streaming audio sample rates a camera advertises to HomeKit, which picks one per session and has the live view's audio encoded at that rate. A doorbell offers
// HomeKit both of its streaming rates to choose from, and so does a camera the livestream API cannot reach, whose sessions are served directly over RTSP. Every other
// camera offers the lower rate alone. The capability - not the user's transport preference - is what decides: a camera that can reach the livestream API may serve any
// given session from the buffer whatever the toggle says, and the single rate holds for every session it serves, from the buffer or from the RTSP fallback. A pure
// helper, red-green testable per population.
export function streamingSamplerates(input: { canUseLivestreamApi: boolean; isDoorbell: boolean }): AudioStreamingSamplerate | AudioStreamingSamplerate[] {

  return (input.isDoorbell || !input.canUseLivestreamApi) ? [ AudioStreamingSamplerate.KHZ_16, AudioStreamingSamplerate.KHZ_24 ] : AudioStreamingSamplerate.KHZ_16;
}

// The audio format a camera's livestream carries, as its init segment describes it: the codec, the channel count, and the sample rate in hertz.
export interface LivestreamAudioFormat {

  channels: number;
  codec: "aac" | "opus";
  sampleRate: number;
}

/* The audio format HomeKit Secure Video is told a camera records at when the camera's own stream could not be read before its controller was built. It is the format
 * unifi-protect's own captures read from first-party cameras, the G6 Pro Entry doorbell included, so it is one value for every camera. It stands in only for a stream
 * that could not be read: the camera record carries no audio format of its own, so the stream is the one source, and a recording whose stream turns out to differ
 * is transcoded to this format rather than mislabeled.
 */
export const RECORDING_AUDIO_STAND_IN: { format: LivestreamAudioFormat; samplerate: AudioRecordingSamplerate } = {

  format: { channels: 1, codec: "aac", sampleRate: 16000 },
  samplerate: AudioRecordingSamplerate.KHZ_16
};

// Each HomeKit recording sample rate and the rate it stands for in hertz, the one table both directions of the mapping below read.
const RECORDING_SAMPLERATE_HZ: Record<AudioRecordingSamplerate, number> = {

  [AudioRecordingSamplerate.KHZ_8]: 8000,
  [AudioRecordingSamplerate.KHZ_16]: 16000,
  [AudioRecordingSamplerate.KHZ_24]: 24000,
  [AudioRecordingSamplerate.KHZ_32]: 32000,
  [AudioRecordingSamplerate.KHZ_44_1]: 44100,
  [AudioRecordingSamplerate.KHZ_48]: 48000
};

// The audio format a livestream carries, read from its init segment's description: the first audio track, which is the track the recording pipeline maps, or null
// when the stream has no audio track or the library could not read that track's configuration.
export function livestreamAudioFormat(description: LivestreamDescription): LivestreamAudioFormat | null {

  const track = description.tracks.find((candidate) => candidate.kind === "audio");

  if((track?.kind !== "audio") || (track.codec === "unknown")) {

    return null;
  }

  return { channels: track.channels, codec: track.codec, sampleRate: track.sampleRate };
}

// The HomeKit recording sample rate a rate in hertz names, or null when HomeKit has no recording rate for it.
export function recordingSamplerateOf(hz: number): AudioRecordingSamplerate | null {

  return Object.values(AudioRecordingSamplerate).find((samplerate) => RECORDING_SAMPLERATE_HZ[samplerate] === hz) ?? null;
}

// The rate in hertz a HomeKit recording sample rate stands for.
export function sampleRateHzOf(samplerate: AudioRecordingSamplerate): number {

  return RECORDING_SAMPLERATE_HZ[samplerate];
}

/**
 * Decide whether a recording can copy a stream's audio as it is: true only when the stream's audio is AAC and the format HomeKit selected is AAC-LC at the same rate
 * and channel count. Anything else - an Opus stream, a different rate, a different channel count, a codec HomeKit selected other than AAC-LC, or a stream with no
 * readable audio track - is transcoded to the selected format instead.
 *
 * @param format - The stream's audio format, or null when its audio could not be read.
 * @param codec  - The recording audio codec HomeKit selected; an absent channel count reads as HAP's default of one.
 *
 * @returns `true` when the stream's audio already is the selected format, `false` otherwise.
 */
export function recordingAudioMatches(format: LivestreamAudioFormat | null, codec: { audioChannels?: number; samplerate: AudioRecordingSamplerate;
  type: AudioRecordingCodecType; }): boolean {

  return (format !== null) && (format.codec === "aac") && (codec.type === AudioRecordingCodecType.AAC_LC) &&
    (recordingSamplerateOf(format.sampleRate) === codec.samplerate) && (format.channels === (codec.audioChannels ?? 1));
}

// Render an audio format for a log line: its rate and its channels, as in "8 kHz mono", with the codec named only when the stream is Opus, so two formats that
// differ by codec alone still read differently.
export function describeAudioFormat(format: LivestreamAudioFormat): string {

  const channels = (format.channels === 1) ? "mono" : ((format.channels === 2) ? "stereo" : format.channels.toString() + " channels");

  return (format.sampleRate / 1000).toString() + " kHz " + channels + ((format.codec === "opus") ? " Opus" : "");
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

// The creational abstraction: build a StreamingDelegate for a camera and the streams it derived - its advertised resolutions, the recording audio format read from its
// livestream, and the probe subscription that read it. Creation is deferred because the delegate needs the camera and its derived streams, so this is a factory rather
// than instance injection. The platform holds the production factory typed as this abstraction.
export interface StreamingDelegateFactory {

  create(camera: ProtectCameraHost, derived: AdvertisedStreams): StreamingDelegate;
}
