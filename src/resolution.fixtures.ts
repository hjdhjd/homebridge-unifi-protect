/* Copyright(C) 2019-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * resolution.fixtures.ts: The durable golden-master for the resolution-selection surface.
 *
 * Parity NOW is proven by the differential harness (resolution.test.ts) against the throwaway 6898296 oracle; parity FOREVER is proven here. This module checks in the
 * typed real-camera corpus (six shipping Protect models plus the deep-low-resolution C5-witness) and, for each, the EXACT advertised resolution list the production
 * buildAdvertisedProfiles must produce, projected to a stable {channelId, lens, name, resolution, url} shape. The package synthesis is checked in alongside, so the
 * package list is regression-armored too. The expected values were DERIVED from the oracle during the 3a build and independently hand-verified for the trust-anchor
 * fixtures (the 640x480 C5-witness, AI Pro, and the G6 Pro Entry 20->24fps normalization); the golden-master test asserts the production output still equals them.
 *
 * When a later sub-commit (3b's D8/D1-heal/url-reconcile) intentionally changes behavior, the diff lands HERE as a reviewed change to a checked-in value - the
 * golden-master flags exactly the rows that move, and nothing else.
 *
 * makeChannel fills a complete ProtectCameraChannelConfig from the load-bearing fields (the resolution math reads only name/width/height/fps/isRtspEnabled/id/rtspAlias);
 * the remaining interface fields are filled with inert defaults so the corpus is a real typed channel, not a cast. The rtspAlias is synthesized from the id so the URL is
 * stable and deterministic; it never affects the resolution math, only the URL string both the oracle and production compose identically.
 */
import type { ProtectCameraChannelConfig } from "unifi-protect";
import type { Resolution } from "homebridge";

// The stable projection of a ChannelProfile the harness and golden-master compare on - identity-free, so deepEqual compares values not references. lens is included
// because the package entry carries it and the primary entries must not.
export interface EntryProjection {

  channelId: number;
  lens: number | undefined;
  name: string;
  resolution: Resolution;
  url: string;
}

// A named camera fixture: the model label, its channels, and the expected advertised list (the golden-master). driftNarrative is present on the hand-annotated anchors.
export interface CameraFixture {

  channels: ProtectCameraChannelConfig[];
  driftNarrative?: string;
  expected: EntryProjection[];
  model: string;
}

// A named package fixture: the model label, the package channel's native seed resolution, and the expected synthesized HomeKit resolution list.
export interface PackageFixture {

  driftNarrative?: string;
  expected: Resolution[];
  model: string;
  nativeTop: Resolution;
}

// Build a complete typed channel from the load-bearing fields. The defaults are inert - the resolution math never reads them - and rtspAlias is synthesized from the id
// so URLs are deterministic.
export function makeChannel(options: { fps: number; height: number; id: number; isRtspEnabled?: boolean; name: string; width: number }): ProtectCameraChannelConfig {

  return {

    autoBitrate: false,
    autoFps: false,
    bitrate: 0,
    enabled: true,
    fps: options.fps,
    fpsValues: [],
    height: options.height,
    id: options.id,
    idrInterval: 0,
    internalRtspAlias: null,
    isInternalRtspEnabled: false,
    isRtspEnabled: options.isRtspEnabled ?? true,
    maxBitrate: 0,
    minBitrate: 0,
    minClientAdaptiveBitRate: 0,
    minMotionAdaptiveBitRate: 0,
    name: options.name,
    rtspAlias: "alias" + options.id.toString(),
    validBitrateRangeMargin: null,
    videoId: "",
    width: options.width
  };
}

// The six real shipping Protect models from the grounded corpus, as typed channel arrays. The G6 Pro Entry's Package Camera channel is included so the parent build
// correctly filters it out (and the package build can select it).
export const G2_PRO_CHANNELS: ProtectCameraChannelConfig[] = [

  makeChannel({ fps: 30, height: 1600, id: 0, name: "High", width: 1200 }),
  makeChannel({ fps: 30, height: 1280, id: 1, name: "Medium", width: 960 }),
  makeChannel({ fps: 15, height: 480, id: 2, name: "Low", width: 360 })
];

export const AI_PRO_CHANNELS: ProtectCameraChannelConfig[] = [

  makeChannel({ fps: 30, height: 2160, id: 0, name: "High", width: 3840 }),
  makeChannel({ fps: 30, height: 720, id: 1, name: "Medium", width: 1280 }),
  makeChannel({ fps: 30, height: 360, id: 2, name: "Low", width: 640 })
];

export const G5_FLEX_CHANNELS: ProtectCameraChannelConfig[] = [

  makeChannel({ fps: 30, height: 1512, id: 0, name: "High", width: 2688 }),
  makeChannel({ fps: 30, height: 720, id: 1, name: "Medium", width: 1280 }),
  makeChannel({ fps: 30, height: 360, id: 2, name: "Low", width: 640 })
];

export const G5_PTZ_CHANNELS: ProtectCameraChannelConfig[] = [

  makeChannel({ fps: 30, height: 1512, id: 0, name: "High", width: 2688 }),
  makeChannel({ fps: 30, height: 720, id: 1, name: "Medium", width: 1280 }),
  makeChannel({ fps: 30, height: 360, id: 2, name: "Low", width: 640 })
];

export const G6_INSTANT_CHANNELS: ProtectCameraChannelConfig[] = [

  makeChannel({ fps: 30, height: 2160, id: 0, name: "High", width: 3840 }),
  makeChannel({ fps: 30, height: 720, id: 1, name: "Medium", width: 1280 }),
  makeChannel({ fps: 30, height: 360, id: 2, name: "Low", width: 640 })
];

export const G6_PRO_ENTRY_CHANNELS: ProtectCameraChannelConfig[] = [

  makeChannel({ fps: 20, height: 4096, id: 0, name: "High", width: 3024 }),
  makeChannel({ fps: 20, height: 1920, id: 1, name: "Medium", width: 1440 }),
  makeChannel({ fps: 20, height: 640, id: 2, name: "Low", width: 480 }),
  makeChannel({ fps: 3, height: 1200, id: 3, name: "Package Camera", width: 1600 })
];

// The deep-low-native-resolution 4:3 C5-witness: a 640x480 native top, where BOTH HomeKit mandates (1920 and 1280) insert resolutions ABOVE the camera's native top.
// This is the exact regime the C5 regression mis-handled - the per-candidate gate's drifting current-top must be re-read so the mandated 1920x1440/1280x960 entries land
// and the under-native entries still map.
export const C5_WITNESS_CHANNELS: ProtectCameraChannelConfig[] = [

  makeChannel({ fps: 15, height: 480, id: 0, name: "High", width: 640 }),
  makeChannel({ fps: 15, height: 360, id: 1, name: "Low", width: 480 })
];

// A synthetic regime with a disabled Medium channel: isPrimaryChannel gates on isRtspEnabled, so channel 1 is dropped from the native list and never appears in the
// advertised output. Exercises the RTSP-enable filtering boundary.
export const MIXED_RTSP_DISABLED_CHANNELS: ProtectCameraChannelConfig[] = [

  makeChannel({ fps: 30, height: 2160, id: 0, name: "High", width: 3840 }),
  makeChannel({ fps: 30, height: 720, id: 1, isRtspEnabled: false, name: "Medium", width: 1280 }),
  makeChannel({ fps: 30, height: 360, id: 2, name: "Low", width: 640 })
];

// A synthetic regime where every channel fails the sanity check (a 0-width channel and an empty-name channel): the native list is empty, so the build returns [] and the
// device re-asserts return false. This is the blessed hardening - the deleted oracle crashed on the empty list, so the case is asserted directly.
export const SANITY_FAIL_CHANNELS: ProtectCameraChannelConfig[] = [

  makeChannel({ fps: 30, height: 0, id: 0, name: "High", width: 0 }),
  makeChannel({ fps: 30, height: 720, id: 1, name: "", width: 1280 })
];

// The host both the fixtures' expected URLs and the golden-master test compose against. A fixed value so the checked-in URLs are stable.
export const FIXTURE_HOST = "camera.test";

// The RTSPS port the fixtures compose against.
export const FIXTURE_RTSPS_PORT = 7441;

// A small helper to compose a fixture URL the same way buildChannelProfile does, so the checked-in expected URLs stay single-sourced from the host/port/alias rather than
// hand-typed. The alias matches makeChannel's id-derived alias.
function fixtureUrl(id: number): string {

  return "rtsps://" + FIXTURE_HOST + ":" + FIXTURE_RTSPS_PORT.toString() + "/alias" + id.toString() + "?enableSrtp";
}

// The parent-camera golden-master fixtures. Each expected list is the production advertised list (preference-free - the streaming-quality preference is a request-time
// concern, not a list-construction input), projected to the comparison shape. The names carry the SELECTED channel's native dimensions (the synthetic entries inherit
// the matched channel's name), which is exactly what HEAD produced.
export const CAMERA_FIXTURES: CameraFixture[] = [

  {

    channels: G2_PRO_CHANNELS,
    expected: [

      { channelId: 0, lens: undefined, name: "1200x1600@30fps (High)", resolution: [ 1920, 1440, 30 ], url: fixtureUrl(0) },
      { channelId: 0, lens: undefined, name: "1200x1600@30fps (High)", resolution: [ 1280, 960, 30 ], url: fixtureUrl(0) },
      { channelId: 0, lens: undefined, name: "1200x1600@30fps (High)", resolution: [ 1200, 1600, 30 ], url: fixtureUrl(0) },
      { channelId: 1, lens: undefined, name: "960x1280@30fps (Medium)", resolution: [ 1024, 768, 30 ], url: fixtureUrl(1) },
      { channelId: 1, lens: undefined, name: "960x1280@30fps (Medium)", resolution: [ 960, 1280, 30 ], url: fixtureUrl(1) },
      { channelId: 2, lens: undefined, name: "360x480@15fps (Low)", resolution: [ 640, 480, 15 ], url: fixtureUrl(2) },
      { channelId: 2, lens: undefined, name: "360x480@15fps (Low)", resolution: [ 480, 360, 15 ], url: fixtureUrl(2) },
      { channelId: 2, lens: undefined, name: "360x480@15fps (Low)", resolution: [ 360, 480, 15 ], url: fixtureUrl(2) },
      { channelId: 2, lens: undefined, name: "360x480@15fps (Low)", resolution: [ 320, 240, 15 ], url: fixtureUrl(2) }
    ],
    model: "G2 Pro"
  },
  {

    channels: AI_PRO_CHANNELS,

    // AI Pro is a 16:9 4K camera with a 1280x720 middle and a 640x360 low. The 2560x1440/1920x1080 mandated entries map to Medium (the next-lower channel under the
    // bias), the 1280x720 maps to Medium exactly, and the 480x270/320x180 mandated entries map to Low - one of the three independent hand-verified trust anchors.
    driftNarrative: "16:9 4K. The 2560/1920/1280 entries select Medium (1280x720); 640/480/320 select Low (640x360). No fps normalization (all 30fps native).",
    expected: [

      { channelId: 0, lens: undefined, name: "3840x2160@30fps (High)", resolution: [ 3840, 2160, 30 ], url: fixtureUrl(0) },
      { channelId: 1, lens: undefined, name: "1280x720@30fps (Medium)", resolution: [ 2560, 1440, 30 ], url: fixtureUrl(1) },
      { channelId: 1, lens: undefined, name: "1280x720@30fps (Medium)", resolution: [ 1920, 1080, 30 ], url: fixtureUrl(1) },
      { channelId: 1, lens: undefined, name: "1280x720@30fps (Medium)", resolution: [ 1280, 720, 30 ], url: fixtureUrl(1) },
      { channelId: 2, lens: undefined, name: "640x360@30fps (Low)", resolution: [ 640, 360, 30 ], url: fixtureUrl(2) },
      { channelId: 2, lens: undefined, name: "640x360@30fps (Low)", resolution: [ 480, 270, 30 ], url: fixtureUrl(2) },
      { channelId: 2, lens: undefined, name: "640x360@30fps (Low)", resolution: [ 320, 180, 30 ], url: fixtureUrl(2) }
    ],
    model: "AI Pro"
  },
  {

    channels: G5_FLEX_CHANNELS,
    expected: [

      { channelId: 0, lens: undefined, name: "2688x1512@30fps (High)", resolution: [ 2688, 1512, 30 ], url: fixtureUrl(0) },
      { channelId: 1, lens: undefined, name: "1280x720@30fps (Medium)", resolution: [ 2560, 1440, 30 ], url: fixtureUrl(1) },
      { channelId: 1, lens: undefined, name: "1280x720@30fps (Medium)", resolution: [ 1920, 1080, 30 ], url: fixtureUrl(1) },
      { channelId: 1, lens: undefined, name: "1280x720@30fps (Medium)", resolution: [ 1280, 720, 30 ], url: fixtureUrl(1) },
      { channelId: 2, lens: undefined, name: "640x360@30fps (Low)", resolution: [ 640, 360, 30 ], url: fixtureUrl(2) },
      { channelId: 2, lens: undefined, name: "640x360@30fps (Low)", resolution: [ 480, 270, 30 ], url: fixtureUrl(2) },
      { channelId: 2, lens: undefined, name: "640x360@30fps (Low)", resolution: [ 320, 180, 30 ], url: fixtureUrl(2) }
    ],
    model: "G5 Flex"
  },
  {

    channels: G5_PTZ_CHANNELS,
    expected: [

      { channelId: 0, lens: undefined, name: "2688x1512@30fps (High)", resolution: [ 2688, 1512, 30 ], url: fixtureUrl(0) },
      { channelId: 1, lens: undefined, name: "1280x720@30fps (Medium)", resolution: [ 2560, 1440, 30 ], url: fixtureUrl(1) },
      { channelId: 1, lens: undefined, name: "1280x720@30fps (Medium)", resolution: [ 1920, 1080, 30 ], url: fixtureUrl(1) },
      { channelId: 1, lens: undefined, name: "1280x720@30fps (Medium)", resolution: [ 1280, 720, 30 ], url: fixtureUrl(1) },
      { channelId: 2, lens: undefined, name: "640x360@30fps (Low)", resolution: [ 640, 360, 30 ], url: fixtureUrl(2) },
      { channelId: 2, lens: undefined, name: "640x360@30fps (Low)", resolution: [ 480, 270, 30 ], url: fixtureUrl(2) },
      { channelId: 2, lens: undefined, name: "640x360@30fps (Low)", resolution: [ 320, 180, 30 ], url: fixtureUrl(2) }
    ],
    model: "G5 PTZ"
  },
  {

    channels: G6_INSTANT_CHANNELS,
    expected: [

      { channelId: 0, lens: undefined, name: "3840x2160@30fps (High)", resolution: [ 3840, 2160, 30 ], url: fixtureUrl(0) },
      { channelId: 1, lens: undefined, name: "1280x720@30fps (Medium)", resolution: [ 2560, 1440, 30 ], url: fixtureUrl(1) },
      { channelId: 1, lens: undefined, name: "1280x720@30fps (Medium)", resolution: [ 1920, 1080, 30 ], url: fixtureUrl(1) },
      { channelId: 1, lens: undefined, name: "1280x720@30fps (Medium)", resolution: [ 1280, 720, 30 ], url: fixtureUrl(1) },
      { channelId: 2, lens: undefined, name: "640x360@30fps (Low)", resolution: [ 640, 360, 30 ], url: fixtureUrl(2) },
      { channelId: 2, lens: undefined, name: "640x360@30fps (Low)", resolution: [ 480, 270, 30 ], url: fixtureUrl(2) },
      { channelId: 2, lens: undefined, name: "640x360@30fps (Low)", resolution: [ 320, 180, 30 ], url: fixtureUrl(2) }
    ],
    model: "G6 Instant"
  },
  {

    channels: G6_PRO_ENTRY_CHANNELS,

    // G6 Pro Entry is a portrait doorbell whose channels run at a native 20fps. 20 is not one of HomeKit's accepted {15,24,30}, so the post-loop fps normalization
    // rewrites EVERY advertised entry's fps to 24 (20 > 15, so the 24 bucket). Its Package Camera channel is filtered out of this parent list. One of the three
    // independent hand-verified trust anchors: the 20->24fps normalization across the 16:9 table.
    driftNarrative: "Native 20fps, not in {15,24,30}, so every advertised entry normalizes to 24fps. Portrait 3024x4096 reads 16:9. Package Camera channel filtered out.",
    expected: [

      { channelId: 0, lens: undefined, name: "3024x4096@20fps (High)", resolution: [ 3840, 2160, 24 ], url: fixtureUrl(0) },
      { channelId: 0, lens: undefined, name: "3024x4096@20fps (High)", resolution: [ 3024, 4096, 24 ], url: fixtureUrl(0) },
      { channelId: 1, lens: undefined, name: "1440x1920@20fps (Medium)", resolution: [ 2560, 1440, 24 ], url: fixtureUrl(1) },
      { channelId: 1, lens: undefined, name: "1440x1920@20fps (Medium)", resolution: [ 1920, 1080, 24 ], url: fixtureUrl(1) },
      { channelId: 1, lens: undefined, name: "1440x1920@20fps (Medium)", resolution: [ 1440, 1920, 24 ], url: fixtureUrl(1) },
      { channelId: 2, lens: undefined, name: "480x640@20fps (Low)", resolution: [ 1280, 720, 24 ], url: fixtureUrl(2) },
      { channelId: 2, lens: undefined, name: "480x640@20fps (Low)", resolution: [ 640, 360, 24 ], url: fixtureUrl(2) },
      { channelId: 2, lens: undefined, name: "480x640@20fps (Low)", resolution: [ 480, 640, 24 ], url: fixtureUrl(2) },
      { channelId: 2, lens: undefined, name: "480x640@20fps (Low)", resolution: [ 480, 270, 24 ], url: fixtureUrl(2) },
      { channelId: 2, lens: undefined, name: "480x640@20fps (Low)", resolution: [ 320, 180, 24 ], url: fixtureUrl(2) }
    ],
    model: "G6 Pro Entry"
  },
  {

    channels: C5_WITNESS_CHANNELS,

    // The C5-witness, the third independent hand-verified trust anchor and the regression locus. Native top 640x480 (4:3). Both HomeKit mandates (1920 and 1280) insert
    // entries ABOVE the native top: the 1920x1440 lands first and re-sorts to the front, so the per-candidate gate's drifting current top becomes 1920 - which is exactly
    // what then admits the 1280x960 and 1024x768 entries (all < 1920). All map to High (640x480, ch0) under the bias-lower selection, except 320x240 which falls back to
    // the lowest entry (Low, ch1). If the drift had been frozen to the original native top (the C5 bug), the under-native entries would have been dropped.
    driftNarrative: "640x480 4:3 native top. The 1920 mandate inserts 1920x1440 ABOVE native and re-sorts to front; the drifting current-top then admits 1280/1024. " +
      "Final: 1920x1440, 1280x960, 1024x768, 640x480 (all High/ch0), 480x360 (Low/ch1 native), 320x240 (Low/ch1 backstop). All 15fps.",
    expected: [

      { channelId: 0, lens: undefined, name: "640x480@15fps (High)", resolution: [ 1920, 1440, 15 ], url: fixtureUrl(0) },
      { channelId: 0, lens: undefined, name: "640x480@15fps (High)", resolution: [ 1280, 960, 15 ], url: fixtureUrl(0) },
      { channelId: 0, lens: undefined, name: "640x480@15fps (High)", resolution: [ 1024, 768, 15 ], url: fixtureUrl(0) },
      { channelId: 0, lens: undefined, name: "640x480@15fps (High)", resolution: [ 640, 480, 15 ], url: fixtureUrl(0) },
      { channelId: 1, lens: undefined, name: "480x360@15fps (Low)", resolution: [ 480, 360, 15 ], url: fixtureUrl(1) },
      { channelId: 1, lens: undefined, name: "480x360@15fps (Low)", resolution: [ 320, 240, 15 ], url: fixtureUrl(1) }
    ],
    model: "C5 Witness 640x480"
  }
];

// The package-camera golden-master fixtures. Both seeds - the G6 Pro Entry's real Package Camera channel (1600x1200 @ 3fps native) and a low-fps 4:3 witness
// ([1600,1200,2]) - expand to the same 4:3 list: the seed itself plus the under-top mandated 4:3 resolutions at 15fps. The seed retains its native fps; the appended
// rows are all 15fps.
export const PACKAGE_FIXTURES: PackageFixture[] = [

  {

    // The G6 Pro Entry package channel: 1600x1200 (4:3) at the channel's native 3fps. The list seeds that exact tuple, then appends the 4:3 rows that pass the fixed-seed
    // gate: the 1920-wide 1920x1440 lands because 1920 is a HomeKit mandate (even though it exceeds the 1600 native top), and the under-1600 rows land normally. The 2560
    // and 3840 rows are dropped (>= 1600 native max and not mandated). All appended rows are 15fps.
    driftNarrative: "1600x1200 4:3 seed at native 3fps (the seed keeps its fps); 1920x1440 lands as a mandate; the under-top 4:3 rows land at 15fps; 2560/3840 dropped.",
    expected: [ [ 1600, 1200, 3 ], [ 1920, 1440, 15 ], [ 1280, 960, 15 ], [ 1024, 768, 15 ], [ 640, 480, 15 ], [ 480, 360, 15 ], [ 320, 240, 15 ] ],
    model: "G6 Pro Entry Package",
    nativeTop: [ 1600, 1200, 3 ]
  },
  {

    // A low-fps 4:3 seed ([1600,1200,2]) - historically production's no-package-channel fallback (PACKAGE_DEFAULT_RESOLUTION, deleted by the 2b defer-create, which
    // waits for the real channel instead of advertising an unstreamable list). Kept as a pure synthesis witness: the same 4:3 expansion, seeded at 2fps, pinning that
    // the seed keeps its own frame rate.
    expected: [ [ 1600, 1200, 2 ], [ 1920, 1440, 15 ], [ 1280, 960, 15 ], [ 1024, 768, 15 ], [ 640, 480, 15 ], [ 480, 360, 15 ], [ 320, 240, 15 ] ],
    model: "Package fallback",
    nativeTop: [ 1600, 1200, 2 ]
  }
];
