/* Copyright(C) 2019-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * resolution.ts: The pure resolution-selection core for UniFi Protect cameras.
 *
 * This module owns the resolution mathematics that shapes the HomeKit streaming surface: the channel-to-entry construction, the high-to-low sort, the aspect-ratio
 * resolution tables, the HomeKit-mandated-resolution synthesis (both the per-camera advertised list and the package-camera list), and the closest-match selector. It
 * is deliberately pure - FFmpeg-free, `this`-free, and free of any device or controller I/O - so the selection logic is exhaustively unit-testable with constructed
 * inputs and the device classes (camera.ts/camera-package.ts) keep only the `this`-state injection: the channel read, the host chain, the published list write, and
 * the streaming/recording hint resolution. The thin device wrappers `selectChannel`/`selectRecordingChannel` inject `this`-state and delegate to the pure functions here.
 *
 * The selection model is a discriminated union, SelectRequest: a "name" request pins to a named channel (the user's explicit streaming/recording-quality preference);
 * a "nearest" request finds the closest entry to a target resolution, biased higher (for transcoding, which wants a higher-quality input) or lower (the default, which
 * wants the highest channel at or below the target). The pixel cap is a mode-agnostic pre-filter (capByPixels) applied BEFORE selectChannelProfile, so it filters
 * the name branch too - matching HEAD, where a constrained-hardware request with an explicit profile preference still drops profiles above the cap.
 *
 * Matches the pure-module voice of livestream-recovery-policy.ts and nvr-policy.ts: a small, exported, side-effect-free surface paired with a thin live-read wrapper.
 */
import type { Nullable } from "homebridge-plugin-utils";
import type { ProtectCameraChannelConfig } from "unifi-protect";
import type { Resolution } from "homebridge";

// One RTSP entry: a camera channel mapped to a HomeKit resolution, with the friendly display name and the FFmpeg `-i` input URL the media path consumes. The full
// shape is load-bearing - the URL flows to live streaming, RTSP snapshots, and the livestream RTSP fallback - so the entry stays whole rather than split into a
// transport-free profile.
export interface ChannelProfile {

  channel: ProtectCameraChannelConfig;
  lens?: number;
  name: string;
  resolution: Resolution;
  url: string;
}

// HomeKit resolution tables for the two standard aspect ratios. These are the base resolutions we advertise...consumers apply their own FPS logic. We type them as
// readonly tuple-pairs rather than number arrays so that destructuring `[ width, height ]` yields clean `number`s under noUncheckedIndexedAccess - the literals
// contextually type to the annotation, so the values are byte-identical.
export const RESOLUTIONS_4X3: readonly (readonly [number, number])[] =
  [ [ 3840, 2880 ], [ 2560, 1920 ], [ 1920, 1440 ], [ 1280, 960 ], [ 1024, 768 ], [ 640, 480 ], [ 480, 360 ], [ 320, 240 ] ];

export const RESOLUTIONS_16X9: readonly (readonly [number, number])[] =
  [ [ 3840, 2160 ], [ 2560, 1440 ], [ 1920, 1080 ], [ 1280, 720 ], [ 640, 360 ], [ 480, 270 ], [ 320, 180 ] ];

// The Protect channel name that designates a doorbell's secondary package-camera channel. Single-sources the literal across the camera class (which filters it out of
// the primary list), the package class (which selects it), and the NVR RTSP playlist publisher.
export const PACKAGE_CHANNEL_NAME = "Package Camera";

// A streaming-quality selection request. A "name" request pins to a named channel (the user's explicit profile preference); a "nearest" request finds the closest
// entry to a target resolution under the given bias. The pixel cap is NOT a request field - it is a mode-agnostic pre-filter (capByPixels) applied before selection.
export type SelectRequest = { mode: "name"; name: string } |
  { bias: "higher" | "lower"; height: number; mode: "nearest"; width: number };

// Determine whether a resolution belongs to the 4:3 aspect ratio family. HomeKit only recognizes 16:9 and 4:3 families...we normalize for portrait-oriented cameras
// (where width < height) so they map to the correct landscape resolution table.
export function is4x3AspectRatio(width: number, height: number): boolean {

  const maxDim = Math.max(width, height);
  const minDim = Math.min(width, height);

  return (maxDim * 3) === (minDim * 4);
}

// Comparator that sorts RTSP entries from high to low resolution, by width then height then frame rate. Pure - no `this`, so it drops the `.bind(this)` the device
// methods needed.
export function sortByResolutions(a: ChannelProfile, b: ChannelProfile): number {

  // Check width.
  if(a.resolution[0] < b.resolution[0]) {

    return 1;
  }

  if(a.resolution[0] > b.resolution[0]) {

    return -1;
  }

  // Check height.
  if(a.resolution[1] < b.resolution[1]) {

    return 1;
  }

  if(a.resolution[1] > b.resolution[1]) {

    return -1;
  }

  // Check FPS.
  if(a.resolution[2] < b.resolution[2]) {

    return 1;
  }

  if(a.resolution[2] > b.resolution[2]) {

    return -1;
  }

  return 0;
}

// Format a resolution tuple for display, as "WIDTHxHEIGHT@FPSfps".
export function formatResolution(resolution: Resolution): string {

  return resolution[0].toString() + "x" + resolution[1].toString() + "@" + resolution[2].toString() + "fps";
}

// Compose a channel's RTSP URL from host, port, and alias. Pure string composition - the host and port are supplied by the caller (the device owns the host chain), and
// the alias is the channel's own. No I/O. By default we emit the secure SRTP-enabled stream URL (rtsps://...?enableSrtp) the plugin connects to; pass secure: false for
// the plain RTSP catalog URL (rtsp://...) the M3U playlist publishes for external app consumers.
export function rtspUrl(channel: ProtectCameraChannelConfig, urlHost: string, rtspPort: number, secure = true): string {

  return (secure ? "rtsps://" : "rtsp://") + urlHost + ":" + rtspPort.toString() + "/" + channel.rtspAlias + (secure ? "?enableSrtp" : "");
}

// Whether a channel is the doorbell's secondary package-camera channel.
export function isPackageChannel(channel: ProtectCameraChannelConfig): boolean {

  return channel.name === PACKAGE_CHANNEL_NAME;
}

// Whether a channel is an RTSP-enabled primary camera channel (the complement of the package channel within the RTSP-enabled set). The camera class filters its
// channel list with this to build the primary advertised list, leaving the package channel to the package class.
export function isPrimaryChannel(channel: ProtectCameraChannelConfig): boolean {

  return channel.isRtspEnabled && !isPackageChannel(channel);
}

// Construct one ChannelProfile from a channel. This is the single entry constructor that replaces the three hand-built object literals across the camera and package
// classes: the friendly name and resolution come from the channel's native dimensions, the URL from rtspUrl, and the optional lens is omitted entirely when
// undefined (so a primary-channel entry's projected shape is identical to HEAD's, which never set a lens key).
export function buildChannelProfile(channel: ProtectCameraChannelConfig, options: { lens?: number; rtspPort: number; urlHost: string }): ChannelProfile {

  const entry: ChannelProfile = {

    channel: channel,
    name: formatResolution([ channel.width, channel.height, channel.fps ]) + " (" + channel.name + ")",
    resolution: [ channel.width, channel.height, channel.fps ],
    url: rtspUrl(channel, options.urlHost, options.rtspPort)
  };

  // Omit the lens key entirely when undefined, so a primary-channel entry never carries a lens property (matching HEAD, where only the package entry set it).
  if(options.lens !== undefined) {

    entry.lens = options.lens;
  }

  return entry;
}

// The aspect-appropriate base resolution table for a camera whose native top is nativeTop. The 4:3-vs-16:9 pick is a shared atom both list-builds consume.
export function resolutionTableFor(nativeTop: Resolution): readonly (readonly [number, number])[] {

  return is4x3AspectRatio(nativeTop[0], nativeTop[1]) ? RESOLUTIONS_4X3 : RESOLUTIONS_16X9;
}

// Whether a candidate resolution belongs in the advertised list given the current top entry: it is included when it is strictly smaller (by max dimension, so
// portrait-oriented cameras use their longer dimension as the threshold) OR it is one of HomeKit's explicitly-mandated widths (1920/1280). This is the inclusion
// predicate - the exact inverse of HEAD's `>= top && !mandate` skip-gate - and BOTH list-builds use it, so the gate is written once.
export function isMandatedOrUnderTop(candidate: Resolution, currentTop: Resolution): boolean {

  return (Math.max(candidate[0], candidate[1]) < Math.max(currentTop[0], currentTop[1])) || [ 1920, 1280 ].includes(candidate[0]);
}

// Apply the pixel cap as a mode-agnostic pre-filter. When maxPixels is undefined there is no constraint and the entries pass through unchanged; otherwise we drop any
// entry whose channel exceeds the cap. This runs BEFORE selectChannelProfile so it filters the name branch too - intentionally a pre-filter, not a request field, so a
// future reader does not move it into the request and silently exempt the name branch (which HEAD does NOT exempt).
export function capByPixels(entries: readonly ChannelProfile[], maxPixels: number | undefined): ChannelProfile[] {

  return (maxPixels === undefined) ? [...entries] : entries.filter((e) => ((e.channel.width * e.channel.height) <= maxPixels));
}

// The pure closest-match selector over a pre-sorted (high-to-low) entry list. A "name" request returns the entry whose channel name matches case-insensitively, or
// null. A "nearest" request returns the exact channel-dimension match if present (FPS ignored - HomeKit clients handle it fine), else under the bias: lower picks the
// first entry strictly narrower than the target, falling back to the lowest entry; higher picks the first entry strictly wider, falling back to the highest entry.
// Entries arrive pre-sorted; the selector never sorts and never mutates its argument.
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

      // Bias lower: the next narrower entry, or the lowest entry we have as a backstop (the list is sorted high to low, so .at(-1) is the lowest).
      if(request.bias === "lower") {

        return entries.find((e) => (e.channel.width < request.width)) ?? entries.at(-1) ?? null;
      }

      // Bias higher (primarily for transcoding, which wants a higher-quality input): the narrowest entry still wider than the target, or the highest entry as a
      // backstop. The list is sorted high to low, so the last of the wider-than-target entries is the narrowest among them.
      return entries.filter((e) => (e.channel.width > request.width)).at(-1) ?? entries[0] ?? null;
    }

    default: {

      // SelectRequest is a closed discriminated union, so this is unreachable; we satisfy the exhaustiveness checker and surface a typo at compile time.
      return null;
    }
  }
}

// Build the per-camera advertised resolution list HomeKit consumes, from the camera's native RTSP entries. This is the entangled crux of the resolution surface, lifted
// verbatim from the device's channel-profile derivation (refreshChannelProfiles): sort high to low; capture the native top (the empty list returns []); pick the
// aspect-appropriate base table; expand each row to 30 and 15 fps; then, for each candidate that belongs (under the drifting current top), find the closest RTSP match
// and append it with the matched channel's native frame rate, re-sorting after each insert. Finally, normalize non-conforming frame rates to {15,24,30} so HomeKit will
// attempt the camera.
//
// The list build is preference-free: each candidate's closest-match uses the bias-lower nearest selection, mapping every HomeKit resolution to the highest channel at or
// below it. The streaming-quality preference (Video.Stream.Only.X) is a request-time concern the selectChannel wrapper applies when a stream starts; it must not bias
// which resolutions we advertise (the leak that, before this, also pinned the HKSV recording default to the streaming channel on constrained hosts).
export function buildAdvertisedProfiles(nativeEntries: readonly ChannelProfile[]): ChannelProfile[] {

  // Copy the native entries into a mutable working list and sort it high to low. We never mutate the caller's array.
  const entries = [...nativeEntries];

  entries.sort(sortByResolutions);

  // The camera's native highest-resolution entry, captured before the loop below inserts HomeKit's mandated synthetic resolutions (which can sort ahead of it). We use
  // it for the aspect-ratio decision and as an empty-guard: a camera whose every channel failed the sanity check leaves entries empty, so we return rather than
  // dereference. The per-candidate gate and the fps check below re-read the current entries[0], which drifts as entries are added.
  const nativeTopEntry = entries[0];

  if(!nativeTopEntry) {

    return [];
  }

  // Next, ensure we have mandatory resolutions required by HomeKit, as well as special support for Apple TV and Apple Watch, while respecting aspect ratios. We use the
  // frame rate of the first entry, which should be our highest resolution option that's native to the camera as the upper bound for frame rate.
  //
  // We build the list as [width, height, fps] tuples from the aspect-appropriate base table. Typing these as Resolution tuples (not number arrays) makes every
  // per-element read index-safe. We support both 30 and 15fps for each, ranging from 4K through 320p.
  const validResolutions: Resolution[] = resolutionTableFor(nativeTopEntry.resolution)
    .flatMap(([ width, height ]) => [ 30, 15 ].map((fps): Resolution => [ width, height, fps ]));

  // Validate and add our entries to the list of what we make available to HomeKit. We map these resolutions to the channels we have available to us on the camera.
  for(const candidate of validResolutions) {

    // The current highest entry, re-read each iteration: the loop can insert a HomeKit-mandated resolution (the 1920/1280 exception in isMandatedOrUnderTop) larger
    // than the camera's native top, which then sorts to the front - so this is not necessarily nativeTopEntry. entries is only ever appended to, so index 0 is always
    // present here; the `?? nativeTopEntry` is a type-only fallback under noUncheckedIndexedAccess (entries[0] is ChannelProfile|undefined) and is not runtime-reachable.
    const currentTop = entries[0] ?? nativeTopEntry;

    // Skip this resolution unless it belongs under the (drifting) current top or is a HomeKit-mandated width.
    if(!isMandatedOrUnderTop(candidate, currentTop.resolution)) {

      continue;
    }

    // Find the closest RTSP match for this resolution: the bias-lower nearest selection over the pre-sorted entries, with no pixel cap and no streaming preference (the
    // list is preference-free). This maps the candidate to the highest channel at or below it.
    const foundRtsp = selectChannelProfile(entries, { bias: "lower", height: candidate[1], mode: "nearest", width: candidate[0] });

    if(!foundRtsp) {

      continue;
    }

    // We already have this resolution in our list.
    if(entries.some((x) => (x.resolution[0] === candidate[0]) && (x.resolution[1] === candidate[1]) && (x.resolution[2] === foundRtsp.channel.fps))) {

      continue;
    }

    // Add the resolution to the list of supported resolutions, but use the selected camera channel's native frame rate.
    entries.push({ channel: foundRtsp.channel, name: foundRtsp.name, resolution: [ candidate[0], candidate[1], foundRtsp.channel.fps ], url: foundRtsp.url });

    // Since we added resolutions to the list, resort resolutions, from high to low.
    entries.sort(sortByResolutions);
  }

  // Ensure we've got entries that can be used for HomeKit Secure Video. Some Protect cameras (e.g. G3 Flex) don't have a native frame rate that maps to HomeKit's
  // specific requirements for event recording, so we normalize all non-conforming entries. This doesn't directly affect which stream is used to actually record
  // something, but it does determine whether HomeKit even attempts to use the camera for HomeKit Secure Video. We read the current highest entry (entries[0]).
  const topEntry = entries[0] ?? nativeTopEntry;

  if(![ 15, 24, 30 ].includes(topEntry.resolution[2])) {

    // Iterate through the list of RTSP entries we're providing to HomeKit and ensure they all meet HomeKit's requirements for frame rate.
    for(const entry of entries) {

      // This entry already has a conforming frame rate.
      if([ 15, 24, 30 ].includes(entry.resolution[2])) {

        continue;
      }

      // Determine the best frame rate to use that's closest to what HomeKit wants to see.
      if(entry.resolution[2] > 24) {

        entry.resolution[2] = 30;
      } else if(entry.resolution[2] > 15) {

        entry.resolution[2] = 24;
      } else {

        entry.resolution[2] = 15;
      }
    }
  }

  return entries;
}

// Build the package-camera HomeKit resolution list from the package channel's native top. The package camera is a single fixed channel - there is no closest-match
// drift, so the gate compares each candidate against the fixed nativeTop. We seed the list with nativeTop itself (matching HEAD, which seeded validResolutions with the
// primary resolution), expand the aspect-appropriate table at the package frame-rate set, and append each candidate that belongs and is not already present. The
// caller passes [ 15 ] for fpsSet (the package list-build's fixed frame rate) and must NOT prepend nativeTop - this function already seeds it.
export function buildAdvertisedResolutions(options: { fpsSet: readonly number[]; nativeTop: Resolution }): Resolution[] {

  // Seed with the native top, matching HEAD's `validResolutions = [ primaryResolution ]`.
  const validResolutions: Resolution[] = [options.nativeTop];

  // Expand the aspect-appropriate base table to the package frame-rate set.
  const hkResolutions: Resolution[] = resolutionTableFor(options.nativeTop)
    .flatMap(([ width, height ]) => options.fpsSet.map((fps): Resolution => [ width, height, fps ]));

  // Validate and add our entries to the list of what we make available to HomeKit.
  for(const candidate of hkResolutions) {

    // Skip this resolution unless it belongs under the fixed native top or is a HomeKit-mandated width. The package list has no drift, so the gate uses the fixed top.
    if(!isMandatedOrUnderTop(candidate, options.nativeTop)) {

      continue;
    }

    // We already have this resolution in our list.
    if(validResolutions.some((x) => (x[0] === candidate[0]) && (x[1] === candidate[1]) && (x[2] === candidate[2]))) {

      continue;
    }

    validResolutions.push(candidate);
  }

  return validResolutions;
}
