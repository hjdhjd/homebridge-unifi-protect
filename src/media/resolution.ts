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
 * of its transposed ratio from the channel whose pixel count matches them. Width and height are read only by the selector's exact-dimensions match, which a request for
 * a channel's own size takes ahead of any area comparison, by the sort's tie-breaks between sizes of equal area, by the advertised list's set, which is keyed by them,
 * and by the labels that gather a list's frame rates under each size.
 *
 * The selection model is a discriminated union, SelectRequest: a "name" request takes the named channel (the user's explicit streaming/recording-quality preference),
 * and a "size" request takes a channel for a target resolution under a posture, ChannelBias, that names the need it serves. Bias lower takes the highest channel at
 * or under the target, a pixel budget (the advertised list's mapping and the constrained-host buffer target); bias higher takes the smallest channel at or over it,
 * a transcode's input, which wants the richer source; and bias nearest takes the channel closest to it, for copy mode, which re-encodes nothing and so serves the
 * stream closest to what the client asked for. The pixel cap is a mode-agnostic pre-filter (capByPixels) applied BEFORE selectChannelProfile, so it filters the name
 * branch too: a constrained-hardware request with an explicit profile preference still drops profiles above the cap.
 *
 * Matches the pure-module voice of livestream-recovery-policy.ts and nvr-policy.ts: a small, exported, side-effect-free surface paired with a thin live-read wrapper.
 */
import type { Nullable } from "homebridge-plugin-utils";
import { PROTECT_TIMESHIFT_CONSTRAINED_HOST_TARGET } from "../settings.ts";
import type { ProtectCameraChannelConfig } from "unifi-protect";
import type { Resolution } from "homebridge";
import { exhaustiveGuard } from "../types.ts";
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

// The source that names a standard size, spelled as the HAP characteristic or table it comes from: the stream configuration's sizes, each of which HomeKit requires
// of a camera of the aspect ratio HAP labels it with; the recording configuration's sizes; and the stream tiers, the sizes the HomeKit Secure Video compatibility
// guide names in its minimum requirements' table of resolutions by aspect ratio and in its Supported Video Stream Tiers table of common resolutions.
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
  { family: "4:3", height: 3040, sources: ["stream-tiers"], width: 4056 },
  { family: "4:3", height: 2400, sources: ["stream-tiers"], width: 3200 },
  { family: "4:3", height: 2160, sources: ["stream-tiers"], width: 2880 },
  { family: "4:3", height: 1536, sources: [ "recording-configuration", "stream-tiers" ], width: 2048 },
  { family: "4:3", height: 1200, sources: [ "recording-configuration", "stream-tiers" ], width: 1600 },
  { family: "4:3", height: 1080, sources: ["stream-tiers"], width: 1440 },
  { family: "4:3", height: 960, sources: [ "stream-configuration", "recording-configuration" ], width: 1280 },
  { family: "4:3", height: 768, sources: [ "stream-configuration", "recording-configuration", "stream-tiers" ], width: 1024 },
  { family: "4:3", height: 480, sources: [ "stream-configuration", "recording-configuration", "stream-tiers" ], width: 640 },
  { family: "4:3", height: 360, sources: [ "stream-configuration", "stream-tiers" ], width: 480 },
  { family: "4:3", height: 240, sources: [ "stream-configuration", "stream-tiers" ], width: 320 },
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

// The landscape family whose stream-configuration rows a camera of each aspect family takes, which requiredSizesFor reads. The record is typed over every family, so a
// family added to the union fails the typecheck until it is mapped here.
const REQUIRED_LANDSCAPE_FAMILY: Readonly<Record<AspectFamily, "16:9" | "4:3">> = {

  "16:9": "16:9",
  "1:1": "16:9",
  "3:4": "4:3",
  "4:3": "4:3",
  "9:16": "16:9",
  "other": "16:9"
};

// The frame rates every advertised size is offered at, high to low. HomeKit's recording configuration names 15, 24 and 30 fps and asks a camera to advertise every
// rate it supports at each size, and the client picks the rate it wants, so a size is offered at each of them whatever its channel's own rate: a transcode and a
// recording encode at the rate HomeKit selects, while copy mode passes the channel's own rate through.
const ADVERTISED_FRAME_RATES: readonly number[] = [ 30, 24, 15 ];

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

/* The posture a size request selects a channel under. Each answers one need, and each compares the request's pixel area with the channels':
 *
 * - "lower" takes the highest channel at or under the request, or the lowest channel when none is, a pixel budget: the advertised list's mapping of each size to the
 *   channel that can serve it without upscaling, and the constrained-host buffer target.
 * - "higher" takes the smallest channel at or over the request, a transcode's input, because an encoder fed the richer source produces the better stream.
 * - "nearest" takes the channel whose area is closest to the request's, the lower on a tie, for copy mode: nothing is re-encoded, so the stream the client receives
 *   untouched should be the one closest to what it asked for.
 */
export type ChannelBias = "higher" | "lower" | "nearest";

// A channel-selection request. A "name" request takes the channel the user named (the explicit profile preference); a "size" request takes a channel for a target
// resolution under the posture its bias names. The pixel cap is NOT a request field - it is a mode-agnostic pre-filter (capByPixels) applied before selection.
export type SelectRequest = { mode: "name"; name: string } |
  { bias: ChannelBias; height: number; mode: "size"; width: number };

// What a caller of a camera's channel selection names beside the target resolution, shared by the host contract, the camera, its streaming capability and the test
// double, so the options are spelled once.
export interface SelectChannelOptions {

  // The posture the size request selects under.
  bias: ChannelBias;

  // The most pixels a channel may carry, applied as a pre-filter before selection, the name request included. Absent means no cap.
  maxPixels?: number;
}

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

// The sizes HomeKit requires of a camera of one aspect family, offered whatever the camera's native area. HAP's stream configuration labels each size it requires with
// its aspect ratio, so a camera takes the required sizes of the landscape ratio matching its shape: a landscape camera its own ratio's, a portrait camera its transposed
// ratio's, and a square camera or one of no standard ratio the 16:9 rows.
export function requiredSizesFor(family: AspectFamily): readonly StandardSize[] {

  return standardSizesFor(REQUIRED_LANDSCAPE_FAMILY[family]).filter((row) => row.sources.includes("stream-configuration"));
}

// Comparator that sorts entries from high to low: by pixel area, then by width, height and frame rate, so a landscape size sorts ahead of the portrait size of the
// same area and a size's entries run from its highest rate to its lowest. A size holds one entry for each channel that serves it at each rate, and a built list needs
// no channel key beside these, because every size maps to the highest channel at or under its own area, or to the lowest channel when none is, so a list sorted by its
// sizes already runs its channels high to low. Pure - no `this`.
export function sortByResolutions(a: ChannelProfile, b: ChannelProfile): number {

  const [ aWidth, aHeight, aFps ] = a.resolution;
  const [ bWidth, bHeight, bFps ] = b.resolution;

  return (pixelArea(bWidth, bHeight) - pixelArea(aWidth, aHeight)) || (bWidth - aWidth) || (bHeight - aHeight) || (bFps - aFps);
}

// Format a frame's size for display, as "WIDTHxHEIGHT", the one spelling the resolution labels and the advertised list's set key share.
function formatSize(width: number, height: number): string {

  return width.toString() + "x" + height.toString();
}

// Format a resolution tuple for display, as "WIDTHxHEIGHT@FPSfps".
export function formatResolution(resolution: Resolution): string {

  return formatSize(resolution[0], resolution[1]) + "@" + resolution[2].toString() + "fps";
}

// Format a list of resolutions for display with each size labeled once, its rates joined in the order the list holds them, as in "1920x1080@30/24/15fps". The sizes
// keep the order in which each first appears.
export function formatSizeRates(resolutions: readonly Resolution[]): string[] {

  const sizes = Map.groupBy(resolutions, (resolution) => formatSize(resolution[0], resolution[1]));

  return [...sizes].map(([ size, group ]) => size + "@" + group.map((resolution) => resolution[2].toString()).join("/") + "fps");
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
// null. A "size" request returns the exact channel-dimension match if present (FPS ignored - HomeKit clients handle it fine), else compares pixel area under the
// request's posture: lower picks the first entry whose channel is at or under the request's area, falling back to the lowest entry; higher picks the last entry whose
// channel is at or over it, falling back to the highest entry; and nearest picks the entry whose channel area is closest to the request's, a later entry winning an
// equal difference, so a tie takes the lower channel and a channel answers with its last entry. Each comparison is inclusive, so a request whose area equals a
// transposed channel's - 1280x960 against a 960x1280 channel - maps to that channel rather than past it. Entries arrive pre-sorted; the selector never sorts and never
// mutates its argument.
export function selectChannelProfile(entries: readonly ChannelProfile[], request: SelectRequest): Nullable<ChannelProfile> {

  switch(request.mode) {

    case "name": {

      // Pin to the named channel, matched case-insensitively. We uppercase into a local const rather than mutating the request, so the selector stays pure.
      const wanted = request.name.toUpperCase();

      return entries.find((e) => e.channel.name.toUpperCase() === wanted) ?? null;
    }

    case "size": {

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
      const channelArea = (e: ChannelProfile): number => pixelArea(e.channel.width, e.channel.height);

      switch(request.bias) {

        case "higher": {

          // Bias higher (primarily for transcoding, which wants a higher-quality input): the last entry whose channel is at or over the request by area, which is the
          // smallest such channel because the list is sorted high to low, or the highest entry as a backstop.
          return entries.findLast((e) => (channelArea(e) >= requestArea)) ?? entries[0] ?? null;
        }

        case "lower": {

          // Bias lower: the first entry whose channel is at or under the request by area, or the lowest entry we have as a backstop (the list is sorted high to low,
          // so .at(-1) is the lowest).
          return entries.find((e) => (channelArea(e) <= requestArea)) ?? entries.at(-1) ?? null;
        }

        case "nearest": {

          // Bias nearest (copy mode, which serves the channel untouched): the entry whose channel area is closest to the request's. A later entry wins an equal
          // difference, so a channel above the request and one below it at the same distance resolve to the lower, which the high-to-low list puts later, and a
          // channel answers with the last of its entries.
          const distance = (e: ChannelProfile): number => Math.abs(channelArea(e) - requestArea);

          return entries.reduce((best, e) => ((distance(e) <= distance(best)) ? e : best));
        }

        default: {

          // ChannelBias is a closed union, so no request reaches this branch; the guard stops the build the moment a posture is added without a branch above, and the
          // null is the same safe default the mode switch below returns.
          exhaustiveGuard(request.bias);

          return null;
        }
      }
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

    return selectChannelProfile(entries, { bias: "lower", height: PROTECT_TIMESHIFT_CONSTRAINED_HOST_TARGET.height, mode: "size",
      width: PROTECT_TIMESHIFT_CONSTRAINED_HOST_TARGET.width });
  }

  // (3) Otherwise, the highest-quality channel - the first surviving entry, taken structurally with no name lookup.
  return entries[0] ?? null;
}

/**
 * Build the advertised list HomeKit receives, for its stream configuration and its recording configuration alike, from a camera's native channel entries. The list holds
 * every native channel's size, each channel with entries of its own so every channel stays reachable by name, channels of equal size included; the catalog rows of the
 * native top's aspect family, whatever source names them, at or under the native top's pixel count; and the landscape sizes HomeKit requires of a camera of that
 * family, above the native top included, as requiredSizesFor reads them. Each size that is not a native one maps to the highest channel at or under its own area, the
 * bias-lower selection, and falls back to the lowest channel when none is. Every size is offered at each rate in ADVERTISED_FRAME_RATES whatever the rate of the
 * channel that serves it, or at the one fixed rate the caller names, so a size holds one entry for each channel that serves it at each rate.
 *
 * The list is a set keyed by width and height: a size joins only when no entry holds it, the set is computed once, and the list is sorted once at the end. The build is
 * preference-free: the direct-RTSP quality preference (the Video.Rtsp.Only setting) is a request-time concern the selectChannel wrapper applies when a stream starts,
 * and it must not bias which sizes we advertise, which would also tie the substrate default to the direct-RTSP channel on constrained hosts. The caller's entries and
 * their resolution tuples are never written.
 *
 * @param nativeEntries    - The camera's native channel entries, in any order.
 * @param options.fixedFps - The one frame rate every size is offered at, when given, rather than each rate in ADVERTISED_FRAME_RATES.
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
  const family = classifyAspect(topWidth, topHeight);
  const frameRates = (fixedFps === undefined) ? ADVERTISED_FRAME_RATES : [fixedFps];

  // The entries advertising a size from a native, one per frame rate: the native's channel, name, URL and lens, each with a resolution tuple of its own.
  const entriesFor = (native: ChannelProfile, width: number, height: number): ChannelProfile[] => {

    return frameRates.map((fps) => ({ ...native, resolution: [ width, height, fps ] }));
  };

  // Every native channel, keyed by its size. Natives of equal size share a key and each keeps its own entries.
  const advertised = Map.groupBy(natives.flatMap((native) => entriesFor(native, native.resolution[0], native.resolution[1])),
    (entry) => formatSize(entry.resolution[0], entry.resolution[1]));

  // The family's catalog rows within the native top's pixel count, then the sizes HomeKit requires of a camera of that family, above the native top included.
  const candidates = [ ...standardSizesFor(family).filter((row) => (pixelArea(row.width, row.height) <= topArea)), ...requiredSizesFor(family) ];

  for(const { height, width } of candidates) {

    const key = formatSize(width, height);

    // We already advertise this size.
    if(advertised.has(key)) {

      continue;
    }

    // The highest native at or under this size by area, or the lowest native when none is, preference-free and uncapped. The natives are not empty, so one always
    // answers.
    const native = selectChannelProfile(natives, { bias: "lower", height, mode: "size", width });

    if(!native) {

      continue;
    }

    advertised.set(key, entriesFor(native, width, height));
  }

  return [...advertised.values()].flat().toSorted(sortByResolutions);
}
