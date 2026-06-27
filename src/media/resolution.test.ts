/* Copyright(C) 2019-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * resolution.test.ts: The durable golden-master and selector coverage for the resolution-selection surface (resolution.ts).
 *
 * This is the first real coverage of the resolution-selection surface, including the deep-low-resolution drift regime. Parity vs the prior reference implementation's
 * runtime was proven by a parity test against a throwaway reference implementation (parent + package list-builds and the full selector cross-product, under all
 * streamingDefault states, all == the reference) plus an independent hand-computation of three hand-verified anchor fixtures; that reference implementation was then
 * deleted, leaving NO second implementation in the tree. What remains here is the DURABLE record: the production buildAdvertisedProfiles / buildAdvertisedResolutions
 * output asserted against the hand-verified golden-master in camera.fixtures.ts, plus a checked-in selector grid that pins the per-request mapping under both biases and
 * the pixel-cap pre-filter.
 *
 * The harness is pure - resolution.ts is FFmpeg-free and this-free, so no HAP double, no controller, no device instance is needed. The device wrappers selectChannel /
 * selectRecordingChannel inject this-state (streamingDefault, recordingDefault, channelProfiles, the cap) and delegate to selectChannelProfile; we reproduce the exact
 * injection here in a local closure that mirrors camera.ts line-for-line, so the selector grid proves the wrapper logic, not just the bare selector.
 *
 * The golden-master fixtures are the single source of expected behavior: when a later change intentionally alters behavior, the diff lands as a reviewed change to a
 * checked-in fixture value and these tests flag exactly the rows that moved.
 */
import { AI_PRO_CHANNELS, C5_WITNESS_CHANNELS, CAMERA_FIXTURES, FIXTURE_HOST, FIXTURE_RTSPS_PORT, MIXED_RTSP_DISABLED_CHANNELS, PACKAGE_FIXTURES, SANITY_FAIL_CHANNELS,
  makeChannel } from "../camera.fixtures.ts";
import { buildAdvertisedProfiles, buildAdvertisedResolutions, buildChannelProfile, capByPixels, isPrimaryChannel, rtspUrl, selectChannelProfile } from "./resolution.ts";
import { describe, test } from "node:test";
import type { ChannelProfile } from "./resolution.ts";
import type { Nullable } from "homebridge-plugin-utils";
import type { ProtectCameraChannelConfig } from "unifi-protect";
import type { Resolution } from "homebridge";
import type { SelectRequest } from "./resolution.ts";
import assert from "node:assert/strict";

// A selector outcome projected to the comparison shape: the matched channel id and the matched entry resolution (or null when no entry matches).
interface SelectOutcome {

  id: number;
  resolution: Resolution;
}

// Project a ChannelProfile to the comparison shape so deepEqual compares values, not identity. lens is included because the package entry carries it and the primary
// entries must not.
function project(entry: ChannelProfile): { channelId: number; lens: number | undefined; name: string; resolution: Resolution; url: string } {

  return { channelId: entry.channel.id, lens: entry.lens, name: entry.name, resolution: entry.resolution, url: entry.url };
}

// Project a selector result to the (id, resolution) outcome shape, or null.
function outcome(entry: Nullable<ChannelProfile>): SelectOutcome | null {

  return entry ? { id: entry.channel.id, resolution: entry.resolution } : null;
}

// Build the native RTSP entries the parent build consumes from a channel set, mirroring camera.ts refreshChannelProfiles: filter to RTSP-enabled primary channels, skip
// the sanity-fail channels, and construct an entry per channel against the fixture host.
function nativeEntries(channels: ProtectCameraChannelConfig[]): ChannelProfile[] {

  const entries: ChannelProfile[] = [];

  for(const channel of channels.filter(isPrimaryChannel)) {

    if(!channel.name || (channel.width <= 0) || (channel.width > 65535) || (channel.height <= 0) || (channel.height > 65535)) {

      continue;
    }

    entries.push(buildChannelProfile(channel, { rtspPort: FIXTURE_RTSPS_PORT, urlHost: FIXTURE_HOST }));
  }

  return entries;
}

// The exact streaming-wrapper logic from camera.ts selectChannel, reproduced over explicit entries and this-state so the selector grid proves the WRAPPER, not just the
// bare selector. The pixel cap is a mode-agnostic pre-filter applied before the name/nearest branch, exactly as the wrapper does (so it filters the name branch too).
function selectChannelViaWrapper(entries: ChannelProfile[], streamingDefault: string, width: number, height: number,
  opts?: { biasHigher?: boolean; maxPixels?: number }): Nullable<ChannelProfile> {

  const capped = capByPixels(entries, opts?.maxPixels);
  const request: SelectRequest = streamingDefault ? { mode: "name", name: streamingDefault } :
    { bias: opts?.biasHigher ? "higher" : "lower", height: height, mode: "nearest", width: width };

  return selectChannelProfile(capped, request);
}

describe("resolution golden-master: parent advertised list (production == checked-in fixtures)", () => {

  // The list-build is the first-class system under test: the per-candidate gate's drifting current-top (the drift locus), the dedup, the re-sort, and the fps
  // normalization all run inside buildAdvertisedProfiles. Each fixture's expected list is the hand-verified golden-master for streamingDefault "".
  for(const fixture of CAMERA_FIXTURES) {

    test(fixture.model, () => {

      const produced = buildAdvertisedProfiles(nativeEntries(fixture.channels)).map(project);

      assert.deepEqual(produced, fixture.expected);
    });
  }
});

describe("resolution golden-master: package list (production == checked-in fixtures)", () => {

  // The package synthesis seeds the native top and appends the aspect-appropriate mandated rows at the package frame rate, with the fixed-seed gate (no drift).
  for(const fixture of PACKAGE_FIXTURES) {

    test(fixture.model, () => {

      const produced = buildAdvertisedResolutions({ fpsSet: [15], nativeTop: fixture.nativeTop });

      assert.deepEqual(produced, fixture.expected);
    });
  }
});

describe("resolution: the RTSP-enabled / sanity-fail channel filtering", () => {

  // A disabled channel is dropped from the native list before the build runs (isPrimaryChannel gates on isRtspEnabled). The Mixed-RTSP-disabled corpus has its Medium
  // channel disabled, so no entry ever references channel 1.
  test("a disabled channel never appears in the advertised list", () => {

    const produced = buildAdvertisedProfiles(nativeEntries(MIXED_RTSP_DISABLED_CHANNELS));

    assert.equal(produced.some((e) => (e.channel.id === 1)), false);
    assert.equal(produced.length > 0, true);
  });

  // The all-sanity-fail case (a 0-width channel and an empty-name channel): the native list is empty, so buildAdvertisedProfiles returns [] without throwing. This is the
  // deliberate hardening - the device-level guard and the new return [] replace the earlier crash on an empty list (the throwaway reference implementation dereferenced
  // rtspEntries[0] here, which is exactly why this case is asserted directly rather than against a reference implementation). The device level re-asserts this: camera.ts
  // refreshChannelProfiles guards `if(!advertised.length) { return false; }` BEFORE constructing the streaming delegate or calling configureController, so an all-fail
  // camera builds no controller.
  test("buildAdvertisedProfiles([]) returns [] (no throw) - the device short-circuit signal", () => {

    const empty = nativeEntries(SANITY_FAIL_CHANNELS);

    assert.equal(empty.length, 0);
    assert.deepEqual(buildAdvertisedProfiles(empty), []);
  });
});

describe("resolution: selector per-request mapping through the selectChannel wrapper (checked-in grid)", () => {

  // The published list the wrapper reads: the AI Pro's own advertised list, built uncapped and preference-free, as the device publishes it before selectChannel reads
  // this.channelProfiles. AI Pro is a clean 16:9 4K camera (High 3840x2160 / Medium 1280x720 / Low 640x360), so the per-request mapping is legible.
  const published = buildAdvertisedProfiles(nativeEntries(AI_PRO_CHANNELS));

  // The 1080p pixel cap. Note capByPixels filters on the CHANNEL's native pixels, not the entry's advertised resolution, so a 2560x1440-labeled entry backed by the
  // 1280x720 Medium channel survives the cap while the 3840x2160 High channel (8.3M px) is dropped - matching the current selectChannel, which filters on channel pixels.
  const CAP_1080P = 1920 * 1080;

  // The checked-in selector grid: { bias } x { uncapped, 1080p cap } x { target } => the expected (id, resolution) outcome, derived from the reference implementation and
  // confirmed by the independent production-vs-reference sweep. Bias-lower picks the next-narrower (or lowest) channel; bias-higher picks the next-wider (or highest).
  // Under the 1080p cap the High channel is filtered out, so every selection lands on Medium or Low. The two 1280x720 rows reflect the exact channel-dimension-match fix:
  // an exact channel-dimension match now returns the native-dimensioned [1280,720,30] entry rather than the higher [2560,1440,30] synthetic that shares the Medium
  // channel - same channel/id, honest label.
  const GRID: { bias: "higher" | "lower"; expected: SelectOutcome; height: number; maxPixels: number; width: number }[] = [

    { bias: "lower", expected: { id: 0, resolution: [ 3840, 2160, 30 ] }, height: 2160, maxPixels: Infinity, width: 3840 },
    { bias: "lower", expected: { id: 1, resolution: [ 2560, 1440, 30 ] }, height: 1080, maxPixels: Infinity, width: 1920 },
    { bias: "lower", expected: { id: 1, resolution: [ 1280, 720, 30 ] }, height: 720, maxPixels: Infinity, width: 1280 },
    { bias: "lower", expected: { id: 2, resolution: [ 640, 360, 30 ] }, height: 360, maxPixels: Infinity, width: 640 },
    { bias: "lower", expected: { id: 2, resolution: [ 320, 180, 30 ] }, height: 100, maxPixels: Infinity, width: 100 },
    { bias: "lower", expected: { id: 0, resolution: [ 3840, 2160, 30 ] }, height: 99999, maxPixels: Infinity, width: 99999 },
    { bias: "lower", expected: { id: 1, resolution: [ 2560, 1440, 30 ] }, height: 2160, maxPixels: CAP_1080P, width: 3840 },
    { bias: "lower", expected: { id: 2, resolution: [ 640, 360, 30 ] }, height: 360, maxPixels: CAP_1080P, width: 640 },
    { bias: "higher", expected: { id: 0, resolution: [ 3840, 2160, 30 ] }, height: 2160, maxPixels: Infinity, width: 3840 },
    { bias: "higher", expected: { id: 0, resolution: [ 3840, 2160, 30 ] }, height: 1080, maxPixels: Infinity, width: 1920 },
    { bias: "higher", expected: { id: 1, resolution: [ 1280, 720, 30 ] }, height: 720, maxPixels: Infinity, width: 1280 },
    { bias: "higher", expected: { id: 2, resolution: [ 640, 360, 30 ] }, height: 360, maxPixels: Infinity, width: 640 },
    { bias: "higher", expected: { id: 2, resolution: [ 320, 180, 30 ] }, height: 100, maxPixels: Infinity, width: 100 },
    { bias: "higher", expected: { id: 0, resolution: [ 3840, 2160, 30 ] }, height: 99999, maxPixels: Infinity, width: 99999 },
    { bias: "higher", expected: { id: 1, resolution: [ 2560, 1440, 30 ] }, height: 2160, maxPixels: CAP_1080P, width: 3840 },
    { bias: "higher", expected: { id: 1, resolution: [ 2560, 1440, 30 ] }, height: 1080, maxPixels: CAP_1080P, width: 1920 }
  ];

  for(const row of GRID) {

    test("AI Pro bias=" + row.bias + " cap=" + row.maxPixels.toString() + " " + row.width.toString() + "x" + row.height.toString(), () => {

      const result = outcome(selectChannelViaWrapper(published, "", row.width, row.height, { biasHigher: (row.bias === "higher"), maxPixels: row.maxPixels }));

      assert.deepEqual(result, row.expected);
    });
  }

  // The explicit Pi+hwtranscode+Stream.Only.HIGH-above-cap witness: a constrained-hardware transcode request that pins streamingDefault to
  // "HIGH" AND caps at 1080p simultaneously. The HIGH channel (3840x2160, 8.3M px) exceeds the cap, so the pre-filter drops it BEFORE the name match runs - the name
  // branch finds no HIGH entry under the cap and returns null. This proves maxPixels filters the name branch too (it is a pre-filter, not a nearest-only request field).
  test("Pi witness: streamingDefault=HIGH + maxPixels=1080p + bias higher => null (HIGH exceeds the cap)", () => {

    const result = outcome(selectChannelViaWrapper(published, "HIGH", 3840, 2160, { biasHigher: true, maxPixels: CAP_1080P }));

    assert.equal(result, null);
  });

  // A name-pin under no cap resolves to the named channel regardless of the target dimensions (the name branch ignores width/height).
  test("name-pin HIGH (uncapped) resolves to the High channel", () => {

    const result = outcome(selectChannelViaWrapper(published, "HIGH", 640, 360));

    assert.deepEqual(result, { id: 0, resolution: [ 3840, 2160, 30 ] });
  });

  // An empty entry list yields null under every request mode (the selector's empty guards).
  test("empty entry list yields null", () => {

    assert.equal(outcome(selectChannelViaWrapper([], "", 1920, 1080)), null);
    assert.equal(outcome(selectChannelViaWrapper([], "HIGH", 1920, 1080)), null);
  });
});

describe("resolution: the deep-low-resolution drift (the regression locus, exercised through the full list-build)", () => {

  // The 640x480 4:3 deep-low-resolution witness is the regression locus: the 1920 mandate inserts a 1920x1440 entry ABOVE the 640x480 native top, which re-sorts to the
  // front, so the per-candidate gate's drifting current-top becomes 1920 - which is precisely what then admits the 1280x960 and 1024x768 entries (all < 1920). A frozen
  // native-top would have dropped them. The golden-master fixture above already pins the exact list; here we additionally assert the structural invariants the regression
  // violated, so the regression's signature is named explicitly in a test.
  test("the deep-low-resolution 4:3 camera admits the under-mandate resolutions (no under-mandate drop)", () => {

    const produced = buildAdvertisedProfiles(nativeEntries(C5_WITNESS_CHANNELS));
    const dims = produced.map((e) => e.resolution[0].toString() + "x" + e.resolution[1].toString());

    // The mandated 1920x1440 lands ABOVE the native top.
    assert.equal(dims.includes("1920x1440"), true);

    // The under-mandate 1280x960 and 1024x768 land BECAUSE the drifting current-top rose to 1920 (the regression dropped exactly these).
    assert.equal(dims.includes("1280x960"), true);
    assert.equal(dims.includes("1024x768"), true);

    // The native 640x480 is still present, and the list is sorted high to low.
    assert.equal(dims.includes("640x480"), true);
    assert.deepEqual([...dims], [ "1920x1440", "1280x960", "1024x768", "640x480", "480x360", "320x240" ]);
  });

  // A synthetic single-channel camera collapses every selection onto its one entry, and the build still produces a coherent list (the mandated entries map back to the
  // single channel). This guards the degenerate end of the drift loop.
  test("a single-channel camera produces a coherent list", () => {

    const single: ProtectCameraChannelConfig[] = [makeChannel({ fps: 30, height: 1080, id: 0, name: "High", width: 1920 })];
    const produced = buildAdvertisedProfiles(nativeEntries(single));

    assert.equal(produced.length > 0, true);
    assert.equal(produced.every((e) => (e.channel.id === 0)), true);
  });
});

describe("resolution: the advertised list is streaming-preference-free", () => {

  // The list build takes no streaming preference: every synthetic maps to its NEAREST channel (the AI Pro id sequence 0,1,1,1,2,2,2), not a name-pinned one. Before the
  // heal, a re-run with Video.Stream.Only.HIGH pinned every synthetic to High (0,0,0,1,2,0,0) - the leak that also steered the HKSV recording default on a Pi. The
  // streaming preference now lives ONLY at request time, in the selectChannel wrapper.
  test("buildAdvertisedProfiles maps to nearest channels; the streaming preference applies only at request time", () => {

    const list = buildAdvertisedProfiles(nativeEntries(AI_PRO_CHANNELS));

    assert.deepEqual(list.map((e) => e.channel.id), [ 0, 1, 1, 1, 2, 2, 2 ]);

    // The same published list, queried at request time with a HIGH preference, name-pins to the High channel (id 0) - the preference's only remaining home.
    assert.equal(outcome(selectChannelViaWrapper(list, "HIGH", 640, 360))?.id, 0);
  });
});

describe("resolution: rtspUrl - the two scheme branches", () => {

  // The default (secure) branch is the SRTP-enabled stream URL the plugin connects to: rtsps://host:port/alias?enableSrtp - the historical secure-only composition.
  test("the default branch composes the secure rtsps URL with the enableSrtp query", () => {

    const channel = makeChannel({ fps: 30, height: 1080, id: 0, name: "High", width: 1920 });

    assert.equal(rtspUrl(channel, "h", 7447), "rtsps://h:7447/" + channel.rtspAlias + "?enableSrtp");
  });

  // The secure: false branch is the plain RTSP catalog URL the M3U playlist publishes for external app consumers: rtsp://host:port/alias, no enableSrtp query.
  test("the secure: false branch composes the plain rtsp URL with no query", () => {

    const channel = makeChannel({ fps: 30, height: 1080, id: 0, name: "High", width: 1920 });

    assert.equal(rtspUrl(channel, "h", 7447, false), "rtsp://h:7447/" + channel.rtspAlias);
  });
});
