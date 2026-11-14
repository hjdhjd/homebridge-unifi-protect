/* Copyright(C) 2019-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * resolution.ts: The pure resolution-selection core for UniFi Protect cameras.
 *
 * This module owns the resolution mathematics that shapes the HomeKit streaming surface: the channel-to-entry construction, the size catalog every standard size
 * HomeKit names lives in, the aspect family that reads a camera's shape, the advertised list one builder computes for a camera and its package camera alike, the
 * high-to-low sort, and the closest-match selector. It is deliberately pure - FFmpeg-free, `this`-free, and free of any device or controller I/O - so the selection
 * logic is exhaustively unit-testable with constructed inputs and the device classes (camera.ts/camera-package.ts) keep only the `this`-state injection: the channel
 * read, the host chain, the published list write, and the direct-RTSP and substrate hint resolution. The thin device wrappers `selectChannel`/`selectSubstrateChannel`
 * inject `this`-state and delegate to the pure functions here.
 *
 * Every comparison of sizes reads pixel area: which catalog sizes a camera advertises, the channel each size maps to, the sort, the pixel cap, and the selector. A
 * portrait channel and a landscape size of the same area therefore compare as equals, which is what lets a portrait camera serve the landscape sizes HomeKit requires
 * of every camera from the channel whose pixel count matches them.
 *
 * The selection model is a discriminated union, SelectRequest: a "name" request pins to a named channel (the user's explicit streaming/recording-quality preference);
 * a "nearest" request finds the closest entry to a target resolution, biased higher (for transcoding, which wants a higher-quality input) or lower (the default, which
 * wants the highest channel at or below the target). The pixel cap is a mode-agnostic pre-filter (capByPixels) applied BEFORE selectChannelProfile, so it filters
 * the name branch too: a constrained-hardware request with an explicit profile preference still drops profiles above the cap.
 *
 * Matches the pure-module voice of livestream-recovery-policy.ts and nvr-policy.ts: a small, exported, side-effect-free surface paired with a thin live-read wrapper.
 */
import type { Nullable } from "homebridge-plugin-utils";
import { PROTECT_TIMESHIFT_CONSTRAINED_HOST_TARGET } from "../settings.ts";
import type { ProtectCameraChannelConfig } from "unifi-protect";
import type { Resolution } from "homebridge";
import { formatUrlHost } from "homebridge-plugin-utils";

// One RTSP entry: a camera channel mapped to a HomeKit resolution, with the friendly display name and the FFmpeg `-i` input URL the media path consumes. The full
// shape carries the whole transport contract - the URL flows to live streaming, RTSP snapshots, and the livestream RTSP fallback, and splitting it would break each
// of those consumers - so the entry stays whole rather than split into a transport-free profile.
export interface ChannelProfile {

  channel: ProtectCameraChannelConfig;
  lens?: number;
  name: string;
  resolution: Resolution;
  url: string;
}

// The source that names a standard size, spelled as the HAP characteristic or table it comes from: the stream configuration's sizes, every one of which HomeKit
// requires of a camera; the recording configuration's sizes; and the stream tiers the HomeKit Secure Video compatibility guide's resolution table names.
export type SizeSource = "stream-configuration" | "recording-configuration" | "stream-tiers";

// A frame's shape: the standard ratio it matches, in landscape or portrait, or "other" when it matches none within the tolerance below.
export type AspectFamily = "16:9" | "4:3" | "1:1" | "9:16" | "3:4" | "other";

// One row of the size catalog: a standard size, the aspect family its shape belongs to, and every source that names it in that orientation.
export interface StandardSize {

  readonly family: Exclude<AspectFamily, "other">;
  readonly height: number;
  readonly sources: readonly SizeSource[];
  readonly width: number;
}

/* The size catalog: every standard size HomeKit names, tagged with each source that names it. A portrait row carries the configuration sources of the landscape row it
 * transposes, and the stream-tiers source only where the compatibility guide names that size in portrait, so no row stands that no source names in its orientation.
 * The rows are data from those tables, the square family's included. The advertised list is one projection of the catalog.
 */
export const STANDARD_SIZES: readonly StandardSize[] = [

  { family: "16:9", height: 2160, sources: [ "recording-configuration", "stream-tiers" ], width: 3840 },
  { family: "16:9", height: 1440, sources: ["stream-tiers"], width: 2560 },
  { family: "16:9", height: 1080, sources: [ "stream-configuration", "recording-configuration", "stream-tiers" ], width: 1920 },
  { family: "16:9", height: 720, sources: [ "stream-configuration", "recording-configuration", "stream-tiers" ], width: 1280 },
  { family: "16:9", height: 360, sources: [ "stream-configuration", "recording-configuration", "stream-tiers" ], width: 640 },
  { family: "16:9", height: 270, sources: ["stream-configuration"], width: 480 },
  { family: "16:9", height: 180, sources: ["stream-configuration"], width: 320 },
  { family: "4:3", height: 2160, sources: ["stream-tiers"], width: 2880 },
  { family: "4:3", height: 1536, sources: [ "recording-configuration", "stream-tiers" ], width: 2048 },
  { family: "4:3", height: 1200, sources: [ "recording-configuration", "stream-tiers" ], width: 1600 },
  { family: "4:3", height: 1080, sources: ["stream-tiers"], width: 1440 },
  { family: "4:3", height: 960, sources: [ "stream-configuration", "recording-configuration" ], width: 1280 },
  { family: "4:3", height: 768, sources: [ "stream-configuration", "recording-configuration" ], width: 1024 },
  { family: "4:3", height: 480, sources: [ "stream-configuration", "recording-configuration", "stream-tiers" ], width: 640 },
  { family: "4:3", height: 360, sources: ["stream-configuration"], width: 480 },
  { family: "4:3", height: 240, sources: ["stream-configuration"], width: 320 },
  { family: "9:16", height: 3840, sources: [ "recording-configuration", "stream-tiers" ], width: 2160 },
  { family: "9:16", height: 2560, sources: ["stream-tiers"], width: 1440 },
  { family: "9:16", height: 1920, sources: [ "stream-configuration", "recording-configuration", "stream-tiers" ], width: 1080 },
  { family: "9:16", height: 1280, sources: [ "stream-configuration", "recording-configuration", "stream-tiers" ], width: 720 },
  { family: "9:16", height: 640, sources: [ "stream-configuration", "recording-configuration", "stream-tiers" ], width: 360 },
  { family: "9:16", height: 480, sources: ["stream-configuration"], width: 270 },
  { family: "9:16", height: 320, sources: ["stream-configuration"], width: 180 },
  { family: "3:4", height: 3200, sources: ["stream-tiers"], width: 2400 },
  { family: "3:4", height: 2048, sources: [ "recording-configuration", "stream-tiers" ], width: 1536 },
  { family: "3:4", height: 1600, sources: [ "recording-configuration", "stream-tiers" ], width: 1200 },
  { family: "3:4", height: 1280, sources: [ "stream-configuration", "recording-configuration", "stream-tiers" ], width: 960 },
  { family: "3:4", height: 1024, sources: [ "stream-configuration", "recording-configuration" ], width: 768 },
  { family: "3:4", height: 640, sources: [ "stream-configuration", "recording-configuration", "stream-tiers" ], width: 480 },
  { family: "3:4", height: 480, sources: ["stream-configuration"], width: 360 },
  { family: "3:4", height: 320, sources: ["stream-configuration"], width: 240 },
  { family: "1:1", height: 2880, sources: ["stream-tiers"], width: 2880 },
  { family: "1:1", height: 1920, sources: ["stream-tiers"], width: 1920 },
  { family: "1:1", height: 1440, sources: ["stream-tiers"], width: 1440 },
  { family: "1:1", height: 1080, sources: ["stream-tiers"], width: 1080 },
  { family: "1:1", height: 480, sources: ["stream-tiers"], width: 480 }
];

// The sizes every camera advertises whatever its shape, above its native top included: the stream-configuration rows of the landscape families, the stream
// configuration as HAP prints it, each a size HomeKit requires of a camera.
const REQUIRED_SIZES = STANDARD_SIZES.filter((row) => [ "16:9", "4:3" ].includes(row.family) && row.sources.includes("stream-configuration"));

// How far a frame's long side over its short side may sit from a standard ratio, as a fraction of that ratio, and still belong to its family. A near-3:4 top such as
// 3024x4096 sits 1.6 percent off and reads 3:4, a 32:9 panorama such as 7680x2160 reads "other", and the value stays far inside the gap between neighboring ratios, so
// no frame sits within it of two of them.
const ASPECT_FAMILY_TOLERANCE = 0.05;

// The standard ratios a frame is matched against, long side over short side, each with the family it names in landscape and in portrait.
const ASPECT_RATIOS: readonly { readonly landscape: AspectFamily; readonly portrait: AspectFamily; readonly ratio: number }[] = [

  { landscape: "16:9", portrait: "9:16", ratio: 16 / 9 },
  { landscape: "4:3", portrait: "3:4", ratio: 4 / 3 },
  { landscape: "1:1", portrait: "1:1", ratio: 1 }
];

// The Protect channel name that designates a doorbell's secondary package-camera channel. Single-sources the literal across the camera class (which filters it out of
// the primary list), the package class (which selects it), and the NVR RTSP playlist publisher.
export const PACKAGE_CHANNEL_NAME = "Package Camera";

// A streaming-quality selection request. A "name" request pins to a named channel (the user's explicit profile preference); a "nearest" request finds the closest
// entry to a target resolution under the given bias. The pixel cap is NOT a request field - it is a mode-agnostic pre-filter (capByPixels) applied before selection.
export type SelectRequest = { mode: "name"; name: string } |
  { bias: "higher" | "lower"; height: number; mode: "nearest"; width: number };

// The pixel count of a frame, the one measure every size comparison in this module reads.
function pixelArea(width: number, height: number): number {

  return width * height;
}

// Classify a frame into its aspect family. Its long side over its short side is matched to the nearest standard ratio by relative deviation, the portrait family taken
// when the frame is taller than it is wide, and a frame whose nearest ratio sits beyond the tolerance is "other".
export function classifyAspect(width: number, height: number): AspectFamily {

  const ratio = Math.max(width, height) / Math.min(width, height);
  const deviation = (standard: number): number => Math.abs(ratio - standard) / standard;
  const nearest = ASPECT_RATIOS.reduce((best, candidate) => (deviation(candidate.ratio) < deviation(best.ratio)) ? candidate : best);

  if(deviation(nearest.ratio) > ASPECT_FAMILY_TOLERANCE) {

    return "other";
  }

  return (height > width) ? nearest.portrait : nearest.landscape;
}

// The catalog rows of one aspect family, whatever their sources. A frame that matches no standard ratio has none.
export function standardSizesFor(family: AspectFamily): readonly StandardSize[] {

  return STANDARD_SIZES.filter((row) => (row.family === family));
}

// The frame rate an entry advertises for a channel's own rate. HomeKit accepts 15, 24 and 30 fps and a Protect channel can run at another rate, so a rate above 24
// advertises 30, one above 15 advertises 24, and any other advertises 15, which leaves each accepted rate as it is. The advertised rate does not choose the stream that
// records, but it decides whether HomeKit attempts the camera for HomeKit Secure Video at all.
function advertisedFrameRate(fps: number): number {

  if(fps > 24) {

    return 30;
  }

  if(fps > 15) {

    return 24;
  }

  return 15;
}

// Comparator that sorts entries from high to low: by pixel area, then by width, height and frame rate, so a landscape size sorts ahead of the portrait size of the
// same area. A built list needs no channel key beside these, because every size maps to the highest channel at or under its own area, so a list sorted by its sizes
// already runs its channels high to low. Pure - no `this`.
export function sortByResolutions(a: ChannelProfile, b: ChannelProfile): number {

  const [ aWidth, aHeight, aFps ] = a.resolution;
  const [ bWidth, bHeight, bFps ] = b.resolution;

  return (pixelArea(bWidth, bHeight) - pixelArea(aWidth, aHeight)) || (bWidth - aWidth) || (bHeight - aHeight) || (bFps - aFps);
}

// Format a resolution tuple for display, as "WIDTHxHEIGHT@FPSfps".
export function formatResolution(resolution: Resolution): string {

  return resolution[0].toString() + "x" + resolution[1].toString() + "@" + resolution[2].toString() + "fps";
}

// Compose a channel's RTSP URL from host, port, and alias. Pure string composition - the host and port are supplied by the caller (the device owns the host chain), and
// the alias is the channel's own. No I/O. By default we emit the secure SRTP-enabled stream URL (rtsps://...?enableSrtp) the plugin connects to; pass secure: false for
// the plain RTSP catalog URL (rtsp://...) the M3U playlist publishes for external app consumers.
//
// The host goes through formatUrlHost, so an IPv6 address is bracketed and its colons are never read as the port separator, while an IPv4 address, a hostname, and an
// address the caller already bracketed pass through unchanged. An IPv6 address carrying a zone is refused, because no URL can carry one...the controller root sets
// such an override address aside before it reaches a camera's host chain, and the hosts the controller reports never carry a zone.
export function rtspUrl(channel: ProtectCameraChannelConfig, urlHost: string, rtspPort: number, secure = true): string {

  return (secure ? "rtsps://" : "rtsp://") + formatUrlHost(urlHost) + ":" + rtspPort.toString() + "/" + channel.rtspAlias + (secure ? "?enableSrtp" : "");
}

// Whether a channel is the doorbell's secondary package-camera channel.
export function isPackageChannel(channel: ProtectCameraChannelConfig): boolean {

  return channel.name === PACKAGE_CHANNEL_NAME;
}

// Whether a channel is a primary camera channel - the complement of the package channel. The camera class filters its channel list with this to build the primary
// advertised list, leaving the package channel to the package class. RTSP enablement is deliberately not part of this test: the livestream API serves any channel, so
// the flag is a per-consumer concern the selectors and the RTSP-consuming paths apply to their own view of the published list.
export function isPrimaryChannel(channel: ProtectCameraChannelConfig): boolean {

  return !isPackageChannel(channel);
}

// Construct one ChannelProfile from a channel. This is the single entry constructor every ChannelProfile across the camera and package classes is built through: the
// friendly name and resolution come from the channel's native dimensions, the URL from rtspUrl, and the optional lens is omitted entirely when undefined, so a
// primary-channel entry carries no lens property; only the package entry sets one.
export function buildChannelProfile(channel: ProtectCameraChannelConfig, options: { lens?: number; rtspPort: number; urlHost: string }): ChannelProfile {

  const entry: ChannelProfile = {

    channel: channel,
    name: formatResolution([ channel.width, channel.height, channel.fps ]) + " (" + channel.name + ")",
    resolution: [ channel.width, channel.height, channel.fps ],
    url: rtspUrl(channel, options.urlHost, options.rtspPort)
  };

  // Omit the lens key entirely when undefined, so a primary-channel entry carries no lens property; only the package entry sets one.
  if(options.lens !== undefined) {

    entry.lens = options.lens;
  }

  return entry;
}

// Apply the pixel cap as a mode-agnostic pre-filter. When maxPixels is undefined there is no constraint and the entries pass through unchanged; otherwise we drop any
// entry whose channel exceeds the cap. This runs BEFORE selectChannelProfile so it filters the name branch too - intentionally a pre-filter, not a request field, so a
// future reader does not move it into the request and silently exempt the name branch from the cap.
export function capByPixels(entries: readonly ChannelProfile[], maxPixels: number | undefined): ChannelProfile[] {

  return (maxPixels === undefined) ? [...entries] : entries.filter((e) => (pixelArea(e.channel.width, e.channel.height) <= maxPixels));
}

// The pure closest-match selector over a pre-sorted (high-to-low) entry list. A "name" request returns the entry whose channel name matches case-insensitively, or
// null. A "nearest" request returns the exact channel-dimension match if present (FPS ignored - HomeKit clients handle it fine), else compares pixel area under the
// bias: lower picks the first entry whose channel is at or under the request's area, falling back to the lowest entry; higher picks the last entry whose channel is at
// or over it, falling back to the highest entry. Each comparison is inclusive, so a request whose area equals a transposed channel's - 1280x960 against a 960x1280
// channel - maps to that channel rather than past it. Entries arrive pre-sorted; the selector never sorts and never mutates its argument.
export function selectChannelProfile(entries: readonly ChannelProfile[], request: SelectRequest): Nullable<ChannelProfile> {

  switch(request.mode) {

    case "name": {

      // Pin to the named channel, matched case-insensitively. We uppercase into a local const rather than mutating the request, so the selector stays pure.
      const wanted = request.name.toUpperCase();

      return entries.find((e) => e.channel.name.toUpperCase() === wanted) ?? null;
    }

    case "nearest": {

      // Nothing to choose from.
      if(!entries.length) {

        return null;
      }

      // An exact channel-dimension match wins outright (we ignore FPS - HomeKit clients handle it just fine). Among the entries sharing that channel, prefer the one
      // whose advertised resolution ALSO equals the native dimensions over a higher-sorted synthetic that overstates them, so the returned entry's .resolution honestly
      // describes the chosen source (the channel was always correct; this corrects the label). The fully-exact find falls back to the first channel match, which is
      // defined within this guard.
      const exact = entries.find((e) => (e.channel.width === request.width) && (e.channel.height === request.height));

      if(exact) {

        return entries.find((e) => (e.channel.width === request.width) && (e.channel.height === request.height) && (e.resolution[0] === request.width) &&
          (e.resolution[1] === request.height)) ?? exact;
      }

      const requestArea = pixelArea(request.width, request.height);

      // Bias lower: the first entry whose channel is at or under the request by area, or the lowest entry we have as a backstop (the list is sorted high to low, so
      // .at(-1) is the lowest).
      if(request.bias === "lower") {

        return entries.find((e) => (pixelArea(e.channel.width, e.channel.height) <= requestArea)) ?? entries.at(-1) ?? null;
      }

      // Bias higher (primarily for transcoding, which wants a higher-quality input): the last entry whose channel is at or over the request by area, which is the
      // smallest such channel because the list is sorted high to low, or the highest entry as a backstop.
      return entries.findLast((e) => (pixelArea(e.channel.width, e.channel.height) >= requestArea)) ?? entries[0] ?? null;
    }

    default: {

      // SelectRequest is a closed discriminated union, so this branch is unreachable; the fallback returns null as a safe default rather than a compile-time
      // exhaustiveness guarantee.
      return null;
    }
  }
}

/**
 * Select the channel that populates the standing timeshift buffer from an already pixel-capped entry list. The policy is source-independent,
 * HomeKit-Secure-Video-state-independent, and RTSP-independent by construction, in order: (1) a user pin wins outright - an exact name match, null on a miss, the loud
 * user-pin failure; (2) a pixel-constrained encoder host (a Raspberry Pi) takes the highest-quality channel at or below its constrained target by pixel count, biased
 * downward, preference-free so the buffer does not inherit the direct-RTSP quality preference; (3) otherwise the highest-quality channel, taken structurally as the
 * first entry with no name lookup. Pure, so the camera's derivation can select the buffer's channel over a list it has not published yet, exactly as the buffer later
 * will.
 *
 * @param entries          - The candidate channel profiles, sorted high to low and already filtered by the host encoder's pixel cap.
 * @param input.hostSystem - The host system the codec support reports, which marks a pixel-constrained encoder host.
 * @param input.pin        - The user's pinned channel name, or null when no channel is pinned.
 *
 * @returns The channel profile that populates the buffer, or null when the pin names no available channel or there is nothing to choose from.
 */
export function selectSubstrateChannelFrom(entries: readonly ChannelProfile[], input: { hostSystem: string; pin: Nullable<string> }): Nullable<ChannelProfile> {

  // (1) A user pin wins outright: exact name match, null on a miss.
  if(input.pin) {

    return selectChannelProfile(entries, { mode: "name", name: input.pin });
  }

  // (2) A pixel-constrained encoder host: the highest-quality channel at or below the constrained target by pixel count, biased downward and preference-free.
  if(input.hostSystem === "raspbian") {

    return selectChannelProfile(entries, { bias: "lower", height: PROTECT_TIMESHIFT_CONSTRAINED_HOST_TARGET.height, mode: "nearest",
      width: PROTECT_TIMESHIFT_CONSTRAINED_HOST_TARGET.width });
  }

  // (3) Otherwise, the highest-quality channel - the first surviving entry, taken structurally with no name lookup.
  return entries[0] ?? null;
}

/**
 * Build the advertised list HomeKit receives, for its stream configuration and its recording configuration alike, from a camera's native channel entries. The list holds
 * every native channel, each its own entry so every channel stays reachable by name, channels of equal size included; the catalog rows of the native top's aspect
 * family, whatever source names them, at or under the native top's pixel count; and every size HomeKit requires of a camera, whatever its shape. Each size that is not
 * a native one maps to the highest channel at or under its own area, the bias-lower selection, and falls back to the lowest channel when none is. Every entry advertises
 * its channel's frame rate as HomeKit accepts it, or the fixed rate the caller names.
 *
 * The list is a set keyed by width and height: a size joins only when no entry holds it, the set is computed once, and the list is sorted once at the end. The build is
 * preference-free: the direct-RTSP quality preference (the Video.Rtsp.Only setting) is a request-time concern the selectChannel wrapper applies when a stream starts,
 * and it must not bias which sizes we advertise, which would also tie the substrate default to the direct-RTSP channel on constrained hosts. The caller's entries and
 * their resolution tuples are never written.
 *
 * @param nativeEntries    - The camera's native channel entries, in any order.
 * @param options.fixedFps - The frame rate every entry advertises in place of its channel's own, when given.
 *
 * @returns The advertised entries, sorted high to low, or an empty list when there is no native entry to build from.
 */
export function buildAdvertisedProfiles(nativeEntries: readonly ChannelProfile[], { fixedFps }: { fixedFps?: number } = {}): ChannelProfile[] {

  // The natives sorted high to low into a copy of their own, which the selection below reads as its pre-sorted list.
  const natives = nativeEntries.toSorted(sortByResolutions);
  const top = natives[0];

  // A camera whose every channel failed the sanity check has no native entries, and advertises nothing.
  if(!top) {

    return [];
  }

  const [ topWidth, topHeight ] = top.resolution;
  const topArea = pixelArea(topWidth, topHeight);
  const sizeKey = (width: number, height: number): string => width.toString() + "x" + height.toString();

  // An entry advertising a size from a native: the native's channel, name, URL and lens, with a resolution tuple of its own.
  const entryFor = (native: ChannelProfile, width: number, height: number): ChannelProfile => {

    return { ...native, resolution: [ width, height, fixedFps ?? advertisedFrameRate(native.channel.fps) ] };
  };

  // Every native channel, keyed by its size. Natives of equal size share a key and each keeps its own entry.
  const advertised = Map.groupBy(natives.map((native) => entryFor(native, native.resolution[0], native.resolution[1])),
    (entry) => sizeKey(entry.resolution[0], entry.resolution[1]));

  // The family's catalog rows within the native top's pixel count, then every size HomeKit requires of a camera.
  const candidates = [ ...standardSizesFor(classifyAspect(topWidth, topHeight)).filter((row) => (pixelArea(row.width, row.height) <= topArea)), ...REQUIRED_SIZES ];

  for(const { height, width } of candidates) {

    const key = sizeKey(width, height);

    // We already advertise this size.
    if(advertised.has(key)) {

      continue;
    }

    // The highest native at or under this size by area, preference-free and uncapped, which the natives always supply since they are not empty.
    const native = selectChannelProfile(natives, { bias: "lower", height, mode: "nearest", width });

    if(!native) {

      continue;
    }

    advertised.set(key, [entryFor(native, width, height)]);
  }

  return [...advertised.values()].flat().toSorted(sortByResolutions);
}
