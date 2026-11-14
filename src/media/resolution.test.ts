/* Copyright(C) 2019-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * resolution.test.ts: The durable golden-master and selector coverage for the resolution-selection surface (resolution.ts).
 *
 * This is the durable coverage of the resolution-selection surface, including the deep-low-resolution camera whose native top sits below sizes HomeKit requires.
 * The golden-master fixtures in camera.fixtures.ts are the single source of expected behavior for the production buildAdvertisedProfiles output, the package camera's
 * list included; there is no live second implementation in the tree to compare against. A checked-in selector grid separately locks in the per-request mapping
 * under each bias and the pixel-cap pre-filter, and the rows beside it hold the aspect family, the size catalog and the list's membership and frame rates.
 *
 * The harness is pure - resolution.ts is FFmpeg-free and this-free, so no Homebridge runtime, no controller, no device instance is needed. The device wrappers
 * selectChannel / selectSubstrateChannel inject this-state (rtspDefault, substrateDefault, the published list, the cap) and delegate to selectChannelProfile; we
 * reproduce the exact injection here in a local closure that mirrors the streaming capability line-for-line, so the selector grid proves the wrapper logic, not just
 * the bare selector.
 *
 * The golden-master fixtures are the single source of expected behavior: when a later change intentionally alters behavior, the diff lands as a reviewed change to a
 * checked-in fixture value and these tests flag exactly the rows that moved.
 */
import { AI_PRO_CHANNELS, C5_WITNESS_CHANNELS, CAMERA_FIXTURES, DOORBELL_LITE_CHANNELS, FIXTURE_HOST, FIXTURE_RTSPS_PORT, G2_PRO_CHANNELS, G5_FLEX_CHANNELS,
  G6_PRO_ENTRY_CHANNELS, MIXED_RTSP_DISABLED_CHANNELS, PACKAGE_FIXTURES, SANITY_FAIL_CHANNELS, makeChannel } from "../camera.fixtures.ts";
import type { AspectFamily, ChannelBias, ChannelProfile, SelectChannelOptions, SelectRequest } from "./resolution.ts";
import { STANDARD_SIZES, buildAdvertisedProfiles, buildChannelProfile, capByPixels, classifyAspect, formatSizeRates, isPrimaryChannel, rtspUrl,
  selectChannelProfile, selectSubstrateChannelFrom, standardSizesFor } from "./resolution.ts";
import { describe, test } from "node:test";
import type { Nullable } from "homebridge-plugin-utils";
import type { PackageFixture } from "../camera.fixtures.ts";
import type { ProtectCameraChannelConfig } from "unifi-protect";
import type { Resolution } from "homebridge";
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

// Build the native RTSP entries the parent build consumes from a channel set, mirroring the camera's derivation behind deriveAdvertisedStreams: filter to primary
// channels, skip the sanity-fail channels, and construct an entry per channel against the fixture host. RTSP enablement is deliberately not a filter term here, which
// is what keeps this mirroring the production derivation: it filters on the package complement alone.
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

// The exact wrapper logic of the streaming capability's selectChannel, reproduced over explicit entries and this-state so the selector grid proves the WRAPPER, not
// just the bare selector. The pixel cap is a mode-agnostic pre-filter applied before the name or size branch, exactly as the wrapper does (so it filters the name branch
// too), and the posture travels from the options into the size request as the wrapper forwards it.
function selectChannelViaWrapper(entries: ChannelProfile[], rtspDefault: string, width: number, height: number,
  options: SelectChannelOptions): Nullable<ChannelProfile> {

  const capped = capByPixels(entries, options.maxPixels);
  const request: SelectRequest = rtspDefault ? { mode: "name", name: rtspDefault } :
    { bias: options.bias, height: height, mode: "size", width: width };

  return selectChannelProfile(capped, request);
}

// The sizes HAP's stream configuration requires of every camera, as HAP prints them. They are written out here rather than read from the catalog, so a row the catalog
// loses or mistags reddens the rows that read them.
const STREAM_CONFIGURATION_SIZES = [ "1920x1080", "1280x720", "640x360", "480x270", "320x180", "1280x960", "1024x768", "640x480", "480x360", "320x240" ];

// A resolution as its width and height, the form the membership rows compare on.
function dims(resolution: Resolution): string {

  return resolution[0].toString() + "x" + resolution[1].toString();
}

// The sizes a camera with these channels advertises, each once in list order, through the production derivation and the one builder.
function advertisedSizes(channels: ProtectCameraChannelConfig[]): string[] {

  return [...new Set(buildAdvertisedProfiles(nativeEntries(channels)).map((entry) => dims(entry.resolution)))];
}

// The package camera's advertised list for a package fixture, built as the package derivation builds it: the one builder over the package channel at a fixed 15fps.
function packageResolutions(fixture: PackageFixture): Resolution[] {

  const profile = buildChannelProfile(fixture.channel, { lens: 2, rtspPort: FIXTURE_RTSPS_PORT, urlHost: FIXTURE_HOST });

  return buildAdvertisedProfiles([profile], { fixedFps: 15 }).map((entry) => entry.resolution);
}

// A 2592x1944 4:3 camera with a 704x480 low channel, a shape the corpus otherwise lacks: its native area admits the larger 4:3 rows.
const LARGE_4X3_CHANNELS: ProtectCameraChannelConfig[] = [

  makeChannel({ fps: 20, height: 1944, id: 0, name: "High", width: 2592 }),
  makeChannel({ fps: 20, height: 480, id: 1, name: "Low", width: 704 })
];

describe("resolution golden-master: parent advertised list (production == checked-in fixtures)", () => {

  // The list build is the first-class system under test: the aspect family, the catalog rows within the native area, the required sizes, the area mapping, the dedup,
  // the sort, and the entries of each size at every frame rate all run inside buildAdvertisedProfiles. Each fixture's expected list is the hand-traced golden-master
  // for rtspDefault "".
  for(const fixture of CAMERA_FIXTURES) {

    test(fixture.model, () => {

      const produced = buildAdvertisedProfiles(nativeEntries(fixture.channels)).map(project);

      assert.deepEqual(produced, fixture.expected);
    });
  }
});

describe("resolution golden-master: package list (production == checked-in fixtures)", () => {

  // The package camera's list is the one builder's output over its single channel at a fixed 15fps, mapped to resolutions, as the package derivation hands it on.
  for(const fixture of PACKAGE_FIXTURES) {

    test(fixture.model, () => {

      assert.deepEqual(packageResolutions(fixture), fixture.expected);
    });
  }
});

describe("resolution: the primary-channel / sanity-fail channel filtering", () => {

  // An RTSP-disabled channel IS advertised: isPrimaryChannel is the package-complement test alone, because the livestream API serves any channel. The Mixed-RTSP-disabled
  // corpus has its Medium channel disabled, so channel 1 appears in the advertised list; the RTSP-enabled subset is a per-consumer view the selectors apply instead.
  test("a disabled channel still appears in the advertised list", () => {

    const produced = buildAdvertisedProfiles(nativeEntries(MIXED_RTSP_DISABLED_CHANNELS));

    assert.equal(produced.some((e) => (e.channel.id === 1)), true);
    assert.equal(produced.length > 0, true);
  });

  // The package channel is the one channel the primary build excludes, whatever its RTSP state - it belongs to the package class. The G6 Pro Entry corpus carries one.
  test("the package channel never appears in the primary advertised list", () => {

    const produced = buildAdvertisedProfiles(nativeEntries(G6_PRO_ENTRY_CHANNELS));

    assert.equal(produced.some((e) => (e.channel.name === "Package Camera")), false);
    assert.equal(produced.length > 0, true);
  });

  // The all-sanity-fail case (a 0-width channel and an empty-name channel): the native list is empty, so buildAdvertisedProfiles([]) returns [] without throwing, and
  // this case is asserted directly since there is no second implementation in the tree to compare against. The device level re-asserts this: the camera's derivation
  // returns null BEFORE constructing the streaming delegate or calling configureController, so an all-fail camera builds no controller.
  test("buildAdvertisedProfiles([]) returns [] (no throw) - the device short-circuit signal", () => {

    const empty = nativeEntries(SANITY_FAIL_CHANNELS);

    assert.equal(empty.length, 0);
    assert.deepEqual(buildAdvertisedProfiles(empty), []);
  });
});

describe("resolution: selector per-request mapping through the selectChannel wrapper (checked-in grid)", () => {

  // The published list the wrapper reads: the AI Pro's own advertised list, built uncapped and preference-free, as the streaming capability publishes it before
  // selectChannel selects over it. AI Pro is a clean 16:9 4K camera (High 3840x2160 / Medium 1280x720 / Low 640x360), so the per-request mapping is legible.
  const published = buildAdvertisedProfiles(nativeEntries(AI_PRO_CHANNELS));

  // The 1080p pixel cap. Note capByPixels filters on the CHANNEL's native pixels, not the entry's advertised resolution, so a 2560x1440-labeled entry backed by the
  // 1280x720 Medium channel survives the cap while the 3840x2160 High channel (8.3M px) is dropped - matching the current selectChannel, which filters on channel pixels.
  const CAP_1080P = 1920 * 1080;

  // The checked-in selector grid: { bias } x { uncapped, 1080p cap } x { target } => the expected (id, resolution) outcome. Each bias compares pixel area: bias-lower
  // picks the first entry whose channel is at or under the target's area (or the lowest), and bias-higher the last entry whose channel is at or over it (or the highest).
  // Under the 1080p cap the High channel is filtered out, so every selection lands on Medium or Low. The two 1280x720 rows reflect the exact channel-dimension-match
  // behavior: an exact channel-dimension match returns the native-dimensioned [1280,720,30] entry rather than the higher [2560,1440,30] synthetic that shares the Medium
  // channel - same channel/id, honest label. Bias-nearest, copy mode's posture, runs uncapped as copy mode does and picks the entry whose channel area is closest to the
  // target's: a channel answers with its last entry, so Medium reads [1280,720,15] and Low [320,180,15], and 960x600, exactly midway between Medium and Low by area,
  // takes Low, the lower channel on a tie. Every size is offered at 30, 24 and 15fps in that order, so a pick that lands on a channel's last entry or the list's lowest
  // reads 15 and every other pick reads 30.
  const GRID: { bias: ChannelBias; expected: SelectOutcome; height: number; maxPixels: number; width: number }[] = [

    { bias: "lower", expected: { id: 0, resolution: [ 3840, 2160, 30 ] }, height: 2160, maxPixels: Infinity, width: 3840 },
    { bias: "lower", expected: { id: 1, resolution: [ 2560, 1440, 30 ] }, height: 1080, maxPixels: Infinity, width: 1920 },
    { bias: "lower", expected: { id: 1, resolution: [ 1280, 720, 30 ] }, height: 720, maxPixels: Infinity, width: 1280 },
    { bias: "lower", expected: { id: 2, resolution: [ 640, 360, 30 ] }, height: 360, maxPixels: Infinity, width: 640 },
    { bias: "lower", expected: { id: 2, resolution: [ 320, 180, 15 ] }, height: 100, maxPixels: Infinity, width: 100 },
    { bias: "lower", expected: { id: 0, resolution: [ 3840, 2160, 30 ] }, height: 99999, maxPixels: Infinity, width: 99999 },
    { bias: "lower", expected: { id: 1, resolution: [ 2560, 1440, 30 ] }, height: 2160, maxPixels: CAP_1080P, width: 3840 },
    { bias: "lower", expected: { id: 2, resolution: [ 640, 360, 30 ] }, height: 360, maxPixels: CAP_1080P, width: 640 },
    { bias: "higher", expected: { id: 0, resolution: [ 3840, 2160, 30 ] }, height: 2160, maxPixels: Infinity, width: 3840 },
    { bias: "higher", expected: { id: 0, resolution: [ 3840, 2160, 15 ] }, height: 1080, maxPixels: Infinity, width: 1920 },
    { bias: "higher", expected: { id: 1, resolution: [ 1280, 720, 30 ] }, height: 720, maxPixels: Infinity, width: 1280 },
    { bias: "higher", expected: { id: 2, resolution: [ 640, 360, 30 ] }, height: 360, maxPixels: Infinity, width: 640 },
    { bias: "higher", expected: { id: 2, resolution: [ 320, 180, 15 ] }, height: 100, maxPixels: Infinity, width: 100 },
    { bias: "higher", expected: { id: 0, resolution: [ 3840, 2160, 30 ] }, height: 99999, maxPixels: Infinity, width: 99999 },
    { bias: "higher", expected: { id: 1, resolution: [ 2560, 1440, 30 ] }, height: 2160, maxPixels: CAP_1080P, width: 3840 },
    { bias: "higher", expected: { id: 1, resolution: [ 2560, 1440, 30 ] }, height: 1080, maxPixels: CAP_1080P, width: 1920 },
    { bias: "nearest", expected: { id: 0, resolution: [ 3840, 2160, 30 ] }, height: 2160, maxPixels: Infinity, width: 3840 },
    { bias: "nearest", expected: { id: 1, resolution: [ 1280, 720, 15 ] }, height: 1080, maxPixels: Infinity, width: 1920 },
    { bias: "nearest", expected: { id: 1, resolution: [ 1280, 720, 15 ] }, height: 768, maxPixels: Infinity, width: 1024 },
    { bias: "nearest", expected: { id: 2, resolution: [ 320, 180, 15 ] }, height: 480, maxPixels: Infinity, width: 640 },
    { bias: "nearest", expected: { id: 2, resolution: [ 320, 180, 15 ] }, height: 600, maxPixels: Infinity, width: 960 },
    { bias: "nearest", expected: { id: 2, resolution: [ 320, 180, 15 ] }, height: 100, maxPixels: Infinity, width: 100 },
    { bias: "nearest", expected: { id: 0, resolution: [ 3840, 2160, 15 ] }, height: 99999, maxPixels: Infinity, width: 99999 }
  ];

  for(const row of GRID) {

    test("AI Pro bias=" + row.bias + " cap=" + row.maxPixels.toString() + " " + row.width.toString() + "x" + row.height.toString(), () => {

      const result = outcome(selectChannelViaWrapper(published, "", row.width, row.height, { bias: row.bias, maxPixels: row.maxPixels }));

      assert.deepEqual(result, row.expected);
    });
  }

  // The explicit Pi+hwtranscode+Rtsp.Only.HIGH-above-cap witness: a constrained-hardware transcode request that sets rtspDefault to
  // "HIGH" AND caps at 1080p simultaneously. The HIGH channel (3840x2160, 8.3M px) exceeds the cap, so the pre-filter drops it BEFORE the name match runs - the name
  // branch finds no HIGH entry under the cap and returns null. This proves maxPixels filters the name branch too (it is a pre-filter, not a size-only request field).
  test("Pi witness: rtspDefault=HIGH + maxPixels=1080p + bias higher => null (HIGH exceeds the cap)", () => {

    const result = outcome(selectChannelViaWrapper(published, "HIGH", 3840, 2160, { bias: "higher", maxPixels: CAP_1080P }));

    assert.equal(result, null);
  });

  // A name request under no cap resolves to the named channel regardless of the target dimensions (the name branch ignores width/height).
  test("a name request for HIGH (uncapped) resolves to the High channel", () => {

    const result = outcome(selectChannelViaWrapper(published, "HIGH", 640, 360, { bias: "nearest" }));

    assert.deepEqual(result, { id: 0, resolution: [ 3840, 2160, 30 ] });
  });

  // An empty entry list yields null under every request mode (the selector's empty guards).
  test("empty entry list yields null", () => {

    assert.equal(outcome(selectChannelViaWrapper([], "", 1920, 1080, { bias: "nearest" })), null);
    assert.equal(outcome(selectChannelViaWrapper([], "HIGH", 1920, 1080, { bias: "nearest" })), null);
  });
});

describe("resolution: the deep-low-resolution camera (a native top below sizes HomeKit requires, exercised through the full list-build)", () => {

  // The 640x480 4:3 witness sits below several sizes HomeKit requires of every camera. Those sizes are still advertised above the native top, each served by High, the
  // highest channel the camera has. The golden-master fixture above already locks in the exact list; here we additionally name its order and that mapping in a test.
  test("the deep-low-resolution 4:3 camera advertises the required sizes above its native top, served by its highest channel", () => {

    const produced = buildAdvertisedProfiles(nativeEntries(C5_WITNESS_CHANNELS));

    // Every required size lands, those above the native top among them, and the list is sorted high to low by area, each size read once.
    assert.deepEqual([...new Set(produced.map((e) => dims(e.resolution)))],
      [ "1920x1080", "1280x960", "1280x720", "1024x768", "640x480", "640x360", "480x360", "480x270", "320x240", "320x180" ]);

    // Every size at or above the native top's area maps to High.
    assert.equal(produced.filter((e) => ((e.resolution[0] * e.resolution[1]) >= (640 * 480))).every((e) => (e.channel.id === 0)), true);
  });

  // A synthetic single-channel camera collapses every selection onto its one entry, and the build still produces a coherent list (every advertised size maps back to
  // the single channel). This guards the degenerate end of the list build.
  test("a single-channel camera produces a coherent list", () => {

    const single: ProtectCameraChannelConfig[] = [makeChannel({ fps: 30, height: 1080, id: 0, name: "High", width: 1920 })];
    const produced = buildAdvertisedProfiles(nativeEntries(single));

    assert.equal(produced.length > 0, true);
    assert.equal(produced.every((e) => (e.channel.id === 0)), true);
  });
});

describe("resolution: the advertised list is streaming-preference-free", () => {

  // The list build takes no streaming preference: every advertised size maps to the channel its area selects, not one a name request picks.
  // buildAdvertisedProfiles is preference-free by construction: the streaming preference (the Video.Rtsp.Only setting) is applied only at request time, in the
  // selectChannel wrapper, never during list construction.
  test("buildAdvertisedProfiles maps each size to a channel at or under it, or the lowest; the streaming preference applies only at request time", () => {

    const list = buildAdvertisedProfiles(nativeEntries(AI_PRO_CHANNELS));

    // Each size's channel, repeated for the entry at each of its frame rates.
    assert.deepEqual(list.map((e) => e.channel.id), [ 0, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2 ].flatMap((id) => [ id, id, id ]));

    // The same published list, queried at request time with a HIGH preference, resolves by name to the High channel (id 0) - the preference's only remaining home.
    assert.equal(outcome(selectChannelViaWrapper(list, "HIGH", 640, 360, { bias: "nearest" }))?.id, 0);
  });
});

describe("resolution: the aspect family and the size catalog", () => {

  // Each frame and the family it reads. 3024x4096 sits 1.6 percent off 3:4 and reads 3:4, which a tolerance of zero would turn "other"; 704x480 sits 10 percent off
  // 4:3 and reads "other", which a tolerance as wide as 15 percent would turn 4:3.
  test("classifyAspect reads each frame's family, portrait from the taller side and other beyond the tolerance", () => {

    const rows: { expected: AspectFamily; height: number; width: number }[] = [

      { expected: "16:9", height: 2160, width: 3840 },
      { expected: "16:9", height: 1512, width: 2688 },
      { expected: "4:3", height: 1944, width: 2592 },
      { expected: "4:3", height: 480, width: 640 },
      { expected: "3:4", height: 1600, width: 1200 },
      { expected: "3:4", height: 4096, width: 3024 },
      { expected: "3:4", height: 4032, width: 3024 },
      { expected: "3:4", height: 2560, width: 1920 },
      { expected: "3:4", height: 2016, width: 1504 },
      { expected: "9:16", height: 1920, width: 1080 },
      { expected: "1:1", height: 1440, width: 1440 },
      { expected: "other", height: 2160, width: 7680 },
      { expected: "other", height: 480, width: 704 }
    ];

    for(const row of rows) {

      assert.equal(classifyAspect(row.width, row.height), row.expected, row.width.toString() + "x" + row.height.toString() + " reads " + row.expected);
    }
  });

  test("standardSizesFor returns a family's own rows, none for other, and every catalog row reads as its own family", () => {

    const portrait = standardSizesFor("3:4").map((row) => dims([ row.width, row.height, 0 ]));

    assert.equal(portrait.includes("960x1280"), true, "the 3:4 family holds 960x1280");
    assert.equal(portrait.includes("1280x960"), false, "the 3:4 family holds no landscape row");
    assert.deepEqual(standardSizesFor("other"), [], "a frame that matches no standard ratio has no catalog rows");

    for(const row of STANDARD_SIZES) {

      assert.equal(classifyAspect(row.width, row.height), row.family, row.width.toString() + "x" + row.height.toString() + " classifies as its own family");
    }
  });
});

describe("resolution: the advertised list's membership and frame rates", () => {

  test("every fixture's list and the package's carry every size the stream configuration requires", () => {

    for(const fixture of CAMERA_FIXTURES) {

      const sizes = advertisedSizes(fixture.channels);

      for(const size of STREAM_CONFIGURATION_SIZES) {

        assert.equal(sizes.includes(size), true, fixture.model + " advertises " + size);
      }
    }

    for(const fixture of PACKAGE_FIXTURES) {

      const sizes = packageResolutions(fixture).map(dims);

      for(const size of STREAM_CONFIGURATION_SIZES) {

        assert.equal(sizes.includes(size), true, fixture.model + " advertises " + size);
      }
    }
  });

  // A family's rows join whatever source names them, every one at or under the native top's pixel count, and none above it. No source names 1920x1440, 2560x1920 or
  // 3840x2880, so no list carries them.
  test("every source's rows within the native area are advertised, and no unnamed size is", () => {

    const aiPro = advertisedSizes(AI_PRO_CHANNELS);
    const g6ProEntry = advertisedSizes(G6_PRO_ENTRY_CHANNELS);
    const doorbellLite = advertisedSizes(DOORBELL_LITE_CHANNELS);
    const large4x3 = advertisedSizes(LARGE_4X3_CHANNELS);

    assert.equal(aiPro.includes("2560x1440"), true, "the AI Pro advertises the 2560x1440 the stream tiers name");
    assert.equal(aiPro.includes("3840x2160"), true, "the AI Pro keeps its 3840x2160 native");
    assert.equal(g6ProEntry.includes("2400x3200"), true, "the G6 Pro Entry advertises the 2400x3200 the stream tiers name");
    assert.equal(g6ProEntry.includes("1536x2048"), true, "the G6 Pro Entry advertises 1536x2048");
    assert.equal(g6ProEntry.includes("3024x4032"), true, "the G6 Pro Entry keeps its 3024x4032 native");
    assert.equal(doorbellLite.includes("1536x2048"), true, "the Doorbell Lite advertises 1536x2048");
    assert.equal(doorbellLite.includes("2400x3200"), false, "the Doorbell Lite leaves out 2400x3200, above its native area");
    assert.equal(large4x3.includes("2048x1536"), true, "a 2592x1944 camera advertises 2048x1536");
    assert.equal(large4x3.includes("1440x1080"), true, "a 2592x1944 camera advertises the 1440x1080 the stream tiers name");

    const lists = [ ...CAMERA_FIXTURES.map((fixture) => advertisedSizes(fixture.channels)), ...PACKAGE_FIXTURES.map((fixture) => packageResolutions(fixture).map(dims)),
      large4x3 ];

    for(const sizes of lists) {

      for(const unnamed of [ "1920x1440", "2560x1920", "3840x2880" ]) {

        assert.equal(sizes.includes(unnamed), false, "no list advertises " + unnamed);
      }
    }
  });

  // Every size is offered at 30, 24 and 15fps in that order, whatever the rate of the channel that serves it, and the package's sizes at its fixed 15fps alone. The
  // entries are grouped by channel name and size, so a camera whose channels share a size reads each channel's own entries. A 30fps High beside a 20fps Low joins the
  // fixtures, so the channels serving one list run at different rates.
  test("every size is offered at 30, 24 and 15fps whatever its channel's rate, and the package's at 15fps alone", () => {

    const cameras = [ ...CAMERA_FIXTURES, { channels: [ makeChannel({ fps: 30, height: 1080, id: 0, name: "High", width: 1920 }),
      makeChannel({ fps: 20, height: 360, id: 1, name: "Low", width: 640 }) ], model: "a 30fps High beside a 20fps Low" } ];

    for(const { channels, model } of cameras) {

      for(const [ group, entries ] of Map.groupBy(buildAdvertisedProfiles(nativeEntries(channels)), (entry) => entry.channel.name + " " + dims(entry.resolution))) {

        assert.deepEqual(entries.map((entry) => entry.resolution[2]), [ 30, 24, 15 ], model + " offers " + group + " at 30, 24 and 15fps");
      }
    }

    for(const fixture of PACKAGE_FIXTURES) {

      assert.equal(packageResolutions(fixture).every((resolution) => (resolution[2] === 15)), true, fixture.model + " advertises every entry at 15fps");
    }
  });

  // The startup mapping lines label each size once with the rates the list offers it at, in list order: a parent channel's sizes at every rate, and the package's sizes
  // at its one rate.
  test("formatSizeRates labels each size once with every rate the list offers it at", () => {

    const medium = buildAdvertisedProfiles(nativeEntries(G6_PRO_ENTRY_CHANNELS)).filter((entry) => (entry.channel.name === "Medium"));

    assert.deepEqual(formatSizeRates([ [ 1920, 1080, 30 ], [ 1920, 1080, 24 ], [ 1920, 1080, 15 ], [ 1280, 720, 15 ] ]), [ "1920x1080@30/24/15fps", "1280x720@15fps" ],
      "each size reads once, its rates in list order");
    assert.deepEqual(formatSizeRates(medium.map((entry) => entry.resolution)), [ "2400x3200@30/24/15fps", "1536x2048@30/24/15fps", "1440x1920@30/24/15fps" ],
      "the G6 Pro Entry's Medium channel labels each size it serves at every rate");

    for(const fixture of PACKAGE_FIXTURES) {

      assert.deepEqual(formatSizeRates(packageResolutions(fixture)), fixture.expected.map((resolution) => dims(resolution) + "@15fps"),
        fixture.model + " labels each size once at 15fps");
    }
  });

  // The build reads the caller's entries and writes neither them nor their order: each native's tuple stays as constructed, its 20fps included.
  test("building leaves the caller's native entries and their order as constructed", () => {

    const natives = nativeEntries(G6_PRO_ENTRY_CHANNELS);
    const reversed = natives.toReversed();

    buildAdvertisedProfiles(natives);
    buildAdvertisedProfiles(reversed);

    assert.deepEqual(natives.map((entry) => entry.resolution), [ [ 3024, 4032, 20 ], [ 1440, 1920, 20 ], [ 480, 640, 20 ] ], "each native's tuple is as constructed");
    assert.deepEqual(reversed.map((entry) => entry.channel.id), [ 2, 1, 0 ], "the caller's array keeps its own order");
  });

  // A camera of no standard shape advertises its native and the sizes the stream configuration requires, and nothing else.
  test("a single 7680x2160 channel advertises its native and exactly the stream configuration's sizes", () => {

    const sizes = advertisedSizes([makeChannel({ fps: 15, height: 2160, id: 0, name: "High", width: 7680 })]);

    assert.deepEqual(sizes.toSorted(), [ "7680x2160", ...STREAM_CONFIGURATION_SIZES ].toSorted());
  });

  // Channels that share a size each keep entries of their own, so a name request still finds each.
  test("natives of equal size each stay, every channel reachable", () => {

    const list = buildAdvertisedProfiles(nativeEntries([ makeChannel({ fps: 30, height: 1080, id: 0, name: "High", width: 1920 }),
      makeChannel({ fps: 30, height: 360, id: 1, name: "Medium", width: 640 }), makeChannel({ fps: 30, height: 360, id: 2, name: "Low", width: 640 }) ]));

    assert.deepEqual(list.filter((entry) => (dims(entry.resolution) === "640x360")).map((entry) => entry.channel.id).toSorted(), [ 1, 1, 1, 2, 2, 2 ],
      "each 640x360 channel keeps its own entry at every rate");
    assert.deepEqual([...new Set(list.map((entry) => entry.channel.id))].toSorted(), [ 0, 1, 2 ], "every channel is present");
    assert.equal(selectChannelProfile(list, { mode: "name", name: "Low" })?.channel.id, 2, "a name request finds the second channel of that size");
  });
});

describe("resolution: area mapping at list time and at request time", () => {

  // Each size maps to the highest channel at or under its own area, or to the lowest channel when none is, so a list sorted by its sizes runs its channels high to
  // low too. Each comparison is inclusive, so a request whose area equals a transposed channel's selects that channel.
  test("channel area never increases along a list, and bias lower takes an equal-area channel", () => {

    for(const fixture of CAMERA_FIXTURES) {

      const areas = buildAdvertisedProfiles(nativeEntries(fixture.channels)).map((entry) => entry.channel.width * entry.channel.height);

      assert.equal(areas.every((area, index) => (index === 0) || (area <= (areas[index - 1] ?? area))), true, fixture.model + " runs its channels high to low");
    }

    const g2Pro = buildAdvertisedProfiles(nativeEntries(G2_PRO_CHANNELS));
    const c5 = buildAdvertisedProfiles(nativeEntries(C5_WITNESS_CHANNELS));

    assert.equal(selectChannelProfile(g2Pro, { bias: "lower", height: 960, mode: "size", width: 1280 })?.channel.id, 1,
      "1280x960 selects Medium, whose 960x1280 holds the same area");
    assert.equal(selectChannelProfile(g2Pro, { bias: "lower", height: 1300, mode: "size", width: 1100 })?.channel.id, 1,
      "1100x1300 selects Medium, the highest channel at or under it");
    assert.equal(selectChannelProfile(c5, { bias: "lower", height: 640, mode: "size", width: 480 })?.channel.id, 0,
      "480x640 selects High, whose 640x480 holds the same area");
  });

  test("bias higher takes the smallest channel at or over the request, an equal-area one included, and the buffer's channel on a Pi reads area", () => {

    const g2Pro = buildAdvertisedProfiles(nativeEntries(G2_PRO_CHANNELS));

    assert.equal(selectChannelProfile(g2Pro, { bias: "higher", height: 720, mode: "size", width: 1280 })?.channel.id, 1,
      "1280x720 selects Medium, the smallest channel at or over it");
    assert.equal(selectChannelProfile(g2Pro, { bias: "higher", height: 960, mode: "size", width: 1280 })?.channel.id, 1,
      "1280x960 selects Medium, whose 960x1280 holds the same area");
    assert.equal(selectSubstrateChannelFrom(buildAdvertisedProfiles(nativeEntries(G6_PRO_ENTRY_CHANNELS)), { hostSystem: "raspbian", pin: null })?.channel.id, 2,
      "the G6 Pro Entry's buffer on a Pi reads Low, since Medium's 1440x1920 holds more pixels than 1920x1080");
    assert.equal(selectSubstrateChannelFrom(buildAdvertisedProfiles(nativeEntries(AI_PRO_CHANNELS)), { hostSystem: "raspbian", pin: null })?.channel.id, 1,
      "the AI Pro's buffer on a Pi reads Medium");
  });

  // The id of the channel that bias nearest, copy mode's posture, takes for a request over a built list.
  const nearestChannel = (list: readonly ChannelProfile[], width: number, height: number): number | undefined => {

    return selectChannelProfile(list, { bias: "nearest", height: height, mode: "size", width: width })?.channel.id;
  };

  // Bias nearest compares the request's area with each channel's and takes the closest, which is never a matter of width: on the portrait cameras a landscape
  // request is wider than the channel that serves it, and a request just under a channel takes that channel rather than the one below.
  test("bias nearest takes the channel closest to the request by area on the portrait cameras", () => {

    const g6ProEntry = buildAdvertisedProfiles(nativeEntries(G6_PRO_ENTRY_CHANNELS));
    const doorbellLite = buildAdvertisedProfiles(nativeEntries(DOORBELL_LITE_CHANNELS));
    const g2Pro = buildAdvertisedProfiles(nativeEntries(G2_PRO_CHANNELS));

    assert.equal(nearestChannel(g6ProEntry, 2400, 3200), 0, "the G6 Pro Entry's 2400x3200 takes High, closer in area than Medium");
    assert.equal(nearestChannel(g6ProEntry, 1920, 1080), 1, "the G6 Pro Entry's 1920x1080 takes Medium, closer in area than Low");
    assert.equal(nearestChannel(g6ProEntry, 1200, 1600), 1, "the G6 Pro Entry's 1200x1600 takes Medium, closer in area than Low");
    assert.equal(nearestChannel(g6ProEntry, 1280, 720), 2, "the G6 Pro Entry's 1280x720 takes Low, closer in area than Medium");
    assert.equal(nearestChannel(g6ProEntry, 640, 360), 2, "the G6 Pro Entry's 640x360 takes Low, closer in area than Medium");
    assert.equal(nearestChannel(doorbellLite, 1536, 2048), 0, "the Doorbell Lite's 1536x2048 takes High, closer in area than Medium");
    assert.equal(nearestChannel(doorbellLite, 1920, 1080), 1, "the Doorbell Lite's 1920x1080 takes Medium, closer in area than High");
    assert.equal(nearestChannel(doorbellLite, 1280, 720), 1, "the Doorbell Lite's 1280x720 takes Medium, closer in area than Low");
    assert.equal(nearestChannel(doorbellLite, 640, 360), 2, "the Doorbell Lite's 640x360 takes Low, closer in area than Medium");
    assert.equal(nearestChannel(g2Pro, 1920, 1080), 0, "the G2 Pro's 1920x1080 takes High, closer in area than Medium");
    assert.equal(nearestChannel(g2Pro, 1280, 720), 1, "the G2 Pro's 1280x720 takes Medium, closer in area than Low");
    assert.equal(nearestChannel(g2Pro, 1024, 768), 1, "the G2 Pro's 1024x768 takes Medium, closer in area than Low");
    assert.equal(nearestChannel(g2Pro, 640, 360), 2, "the G2 Pro's 640x360 takes Low, closer in area than Medium");
  });

  // A request whose area equals a transposed channel's sits no distance from it, so bias nearest takes that channel, though its width is nearer another's.
  test("bias nearest takes an equal-area channel", () => {

    const g2Pro = buildAdvertisedProfiles(nativeEntries(G2_PRO_CHANNELS));

    assert.equal(nearestChannel(g2Pro, 1280, 960), 1, "the G2 Pro's 1280x960 takes Medium, whose 960x1280 holds the same area");
  });

  // On a landscape camera bias nearest takes the channel above the request where that channel is the closer one, and the one below it otherwise.
  test("bias nearest takes the closer channel on the landscape cameras, the one above the request included", () => {

    const g5Flex = buildAdvertisedProfiles(nativeEntries(G5_FLEX_CHANNELS));
    const c5 = buildAdvertisedProfiles(nativeEntries(C5_WITNESS_CHANNELS));

    assert.equal(nearestChannel(g5Flex, 2560, 1440), 0, "the G5 Flex's 2560x1440 takes High, closer in area than Medium");
    assert.equal(nearestChannel(g5Flex, 1024, 768), 1, "the G5 Flex's 1024x768 takes Medium, closer in area than Low");
    assert.equal(nearestChannel(c5, 640, 360), 1, "the C5's 640x360 takes Low, closer in area than High");
  });
});

describe("resolution: rtspUrl - the two scheme branches", () => {

  // The default (secure) branch is the SRTP-enabled stream URL the plugin connects to: rtsps://host:port/alias?enableSrtp - the branch the plugin's own RTSP
  // connections use.
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

/* The host a URL is composed against, in each form it can arrive in. An IPv6 address has to be bracketed or an RTSP client cannot tell its colons from the port
 * separator, an IPv4 address reaches the URL unchanged, an address already bracketed is not bracketed again, and an IPv6 address carrying a zone is refused, because
 * no URL can carry one. Each scheme branch composes the host the same way, so the rows alternate between them.
 */
describe("resolution: rtspUrl - the host forms", () => {

  const channel = makeChannel({ fps: 30, height: 1080, id: 0, name: "High", width: 1920 });

  test("an IPv4 address passes through unchanged", () => {

    assert.equal(rtspUrl(channel, "192.168.1.10", 7441), "rtsps://192.168.1.10:7441/" + channel.rtspAlias + "?enableSrtp");
  });

  test("a bare IPv6 address is bracketed so its colons are not read as the port separator", () => {

    assert.equal(rtspUrl(channel, "fd00::1:2", 7447, false), "rtsp://[fd00::1:2]:7447/" + channel.rtspAlias);
  });

  test("an IPv6 address the caller already bracketed is not bracketed twice", () => {

    assert.equal(rtspUrl(channel, "[fd00::1:2]", 7441), "rtsps://[fd00::1:2]:7441/" + channel.rtspAlias + "?enableSrtp");
  });

  test("an IPv6 address carrying a zone is refused", () => {

    assert.throws(() => rtspUrl(channel, "fe80::1%en0", 7441), TypeError, "a zone has no place in a URL");
  });
});
