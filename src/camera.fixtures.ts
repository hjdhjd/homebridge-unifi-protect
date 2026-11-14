/* Copyright(C) 2019-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * camera.fixtures.ts: The shared real-camera test corpus - canonical channel layouts and camera/package projections for the whole suite, which also serves as the
 * durable golden-master for the resolution-selection surface.
 *
 * The corpus checks in the typed channel sets of real shipping Protect models, landscape and portrait, with a doorbell's package channel, beside a
 * deep-low-resolution witness whose native top is 640x480. For each it checks in the advertised list the production buildAdvertisedProfiles must produce, written
 * once per size as a {channelId, lens, name, size, url} row that atEveryRate expands, from a rate list of its own, into the stable {channelId, lens, name,
 * resolution, url} entry the list holds at each frame rate, and the package camera's list beside them. Every row is traced by hand from its channel set under the
 * advertised-list rules in resolution.ts, and the golden-master test asserts the production output still equals the expanded list.
 *
 * When a later change intentionally alters that behavior, the diff lands HERE as a reviewed change to a checked-in value - the
 * golden-master flags exactly the rows that move, and nothing else.
 *
 * makeChannel fills a complete ProtectCameraChannelConfig from the fields the resolution math actually reads (name/width/height/fps; isRtspEnabled filters the
 * per-consumer RTSP-enabled view; id and rtspAlias compose the URL). The remaining interface fields are filled with inert defaults so the corpus is a real typed channel,
 * not a cast.
 * The rtspAlias is synthesized from the id so the URL is stable and deterministic; it never affects the resolution math, only the URL string, which
 * production composes the same way every time.
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

// One row of a golden-master list as the fixtures write it: an entry's projection with the size it advertises in place of its resolution tuple, which atEveryRate
// completes with each frame rate.
interface SizeProjection extends Omit<EntryProjection, "resolution"> {

  size: [ number, number ];
}

// A named camera fixture: the model label, its channels, and the expected advertised list (the golden-master).
export interface CameraFixture {

  channels: ProtectCameraChannelConfig[];
  expected: EntryProjection[];
  model: string;
}

// A named package fixture: the model label, the package channel, and the expected HomeKit resolution list the package camera advertises from it.
export interface PackageFixture {

  channel: ProtectCameraChannelConfig;
  expected: Resolution[];
  model: string;
}

// Build a complete typed channel from the fields the resolution math reads. The remaining defaults are inert - the resolution math never reads them - and rtspAlias is
// synthesized from the id so URLs are deterministic.
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

// The real shipping Protect models from the grounded corpus, as typed channel arrays. The G6 Pro Entry's Package Camera channel is included so the parent build
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

// The G6 Pro Entry's package channel, which the package fixture builds from.
const G6_PRO_ENTRY_PACKAGE_CHANNEL = makeChannel({ fps: 3, height: 1200, id: 3, name: "Package Camera", width: 1600 });

export const G6_PRO_ENTRY_CHANNELS: ProtectCameraChannelConfig[] = [

  makeChannel({ fps: 20, height: 4032, id: 0, name: "High", width: 3024 }),
  makeChannel({ fps: 20, height: 1920, id: 1, name: "Medium", width: 1440 }),
  makeChannel({ fps: 20, height: 640, id: 2, name: "Low", width: 480 }),
  G6_PRO_ENTRY_PACKAGE_CHANNEL
];

export const DOORBELL_LITE_CHANNELS: ProtectCameraChannelConfig[] = [

  makeChannel({ fps: 24, height: 2560, id: 0, name: "High", width: 1920 }),
  makeChannel({ fps: 24, height: 896, id: 1, name: "Medium", width: 672 }),
  makeChannel({ fps: 24, height: 448, id: 2, name: "Low", width: 336 })
];

// The deep-low-native-resolution 4:3 witness: a 640x480 native top, below several of the sizes HomeKit requires of every camera. Those sizes are still advertised,
// above the native top, each served by the highest channel the camera has.
export const C5_WITNESS_CHANNELS: ProtectCameraChannelConfig[] = [

  makeChannel({ fps: 15, height: 480, id: 0, name: "High", width: 640 }),
  makeChannel({ fps: 15, height: 360, id: 1, name: "Low", width: 480 })
];

// A synthetic regime with a disabled Medium channel: channel 1 is advertised and substrate-selectable like any other primary channel, because the livestream API serves
// it regardless of the flag...only the RTSP-consuming views (the direct-RTSP selector and the RTSP snapshot source) exclude it. Exercises that split.
export const MIXED_RTSP_DISABLED_CHANNELS: ProtectCameraChannelConfig[] = [

  makeChannel({ fps: 30, height: 2160, id: 0, name: "High", width: 3840 }),
  makeChannel({ fps: 30, height: 720, id: 1, isRtspEnabled: false, name: "Medium", width: 1280 }),
  makeChannel({ fps: 30, height: 360, id: 2, name: "Low", width: 640 })
];

// A synthetic regime where every channel fails the sanity check (a 0-width channel and an empty-name channel): the native list is empty, so the build returns [] and the
// device re-asserts return false. This is deliberate hardening for the empty-list case: the build must return an empty list rather than throw, and the case
// is asserted directly rather than left implicit.
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

// The frame rates the advertised list offers every size at, high to low. They are written out here rather than read from resolution.ts, so a rate the builder drops,
// adds or reorders reddens every golden master.
const FIXTURE_FRAME_RATES = [ 30, 24, 15 ];

// Expand rows written once per size into the entries the advertised list holds: each row at every frame rate in turn.
function atEveryRate(rows: SizeProjection[]): EntryProjection[] {

  return rows.flatMap(({ size, ...row }) => FIXTURE_FRAME_RATES.map((fps): EntryProjection => ({ ...row, resolution: [ size[0], size[1], fps ] })));
}

// The parent-camera golden-master fixtures. Each expected list is the production advertised list (preference-free - the streaming-quality preference is a request-time
// concern, not a list-construction input), projected to the comparison shape. The names carry the SELECTED channel's native dimensions (the synthetic entries inherit
// the matched channel's name), which is the production advertised-list behavior these fixtures lock in.
export const CAMERA_FIXTURES: CameraFixture[] = [

  {

    channels: G2_PRO_CHANNELS,

    // The UA G2 PRO's channels: a portrait 3:4 camera with a 30fps High and Medium and a 15fps Low. Its 3:4 rows within its native area join the sizes HomeKit
    // requires. 1920x1080 maps to High, 1280x960 to Medium, whose 960x1280 holds the same area, and 1280x720, 1024x768 and every smaller size to the 15fps Low, the
    // highest channel at or under them, the sizes below Low reaching it as the lowest channel.
    expected: atEveryRate([

      { channelId: 0, lens: undefined, name: "1200x1600@30fps (High)", size: [ 1920, 1080 ], url: fixtureUrl(0) },
      { channelId: 0, lens: undefined, name: "1200x1600@30fps (High)", size: [ 1200, 1600 ], url: fixtureUrl(0) },
      { channelId: 1, lens: undefined, name: "960x1280@30fps (Medium)", size: [ 1280, 960 ], url: fixtureUrl(1) },
      { channelId: 1, lens: undefined, name: "960x1280@30fps (Medium)", size: [ 960, 1280 ], url: fixtureUrl(1) },
      { channelId: 2, lens: undefined, name: "360x480@15fps (Low)", size: [ 1280, 720 ], url: fixtureUrl(2) },
      { channelId: 2, lens: undefined, name: "360x480@15fps (Low)", size: [ 1024, 768 ], url: fixtureUrl(2) },
      { channelId: 2, lens: undefined, name: "360x480@15fps (Low)", size: [ 768, 1024 ], url: fixtureUrl(2) },
      { channelId: 2, lens: undefined, name: "360x480@15fps (Low)", size: [ 640, 480 ], url: fixtureUrl(2) },
      { channelId: 2, lens: undefined, name: "360x480@15fps (Low)", size: [ 480, 640 ], url: fixtureUrl(2) },
      { channelId: 2, lens: undefined, name: "360x480@15fps (Low)", size: [ 640, 360 ], url: fixtureUrl(2) },
      { channelId: 2, lens: undefined, name: "360x480@15fps (Low)", size: [ 480, 360 ], url: fixtureUrl(2) },
      { channelId: 2, lens: undefined, name: "360x480@15fps (Low)", size: [ 360, 480 ], url: fixtureUrl(2) },
      { channelId: 2, lens: undefined, name: "360x480@15fps (Low)", size: [ 480, 270 ], url: fixtureUrl(2) },
      { channelId: 2, lens: undefined, name: "360x480@15fps (Low)", size: [ 320, 240 ], url: fixtureUrl(2) },
      { channelId: 2, lens: undefined, name: "360x480@15fps (Low)", size: [ 240, 320 ], url: fixtureUrl(2) },
      { channelId: 2, lens: undefined, name: "360x480@15fps (Low)", size: [ 320, 180 ], url: fixtureUrl(2) }
    ]),
    model: "G2 Pro"
  },
  {

    channels: AI_PRO_CHANNELS,

    // AI Pro is a 16:9 4K camera with a 1280x720 middle and a 640x360 low. Its 16:9 rows within its native area, 2560x1440 among them, join the sizes HomeKit
    // requires: 2560x1440 down to 1280x720 map to Medium, and 1024x768 and every smaller size map to Low.
    expected: atEveryRate([

      { channelId: 0, lens: undefined, name: "3840x2160@30fps (High)", size: [ 3840, 2160 ], url: fixtureUrl(0) },
      { channelId: 1, lens: undefined, name: "1280x720@30fps (Medium)", size: [ 2560, 1440 ], url: fixtureUrl(1) },
      { channelId: 1, lens: undefined, name: "1280x720@30fps (Medium)", size: [ 1920, 1080 ], url: fixtureUrl(1) },
      { channelId: 1, lens: undefined, name: "1280x720@30fps (Medium)", size: [ 1280, 960 ], url: fixtureUrl(1) },
      { channelId: 1, lens: undefined, name: "1280x720@30fps (Medium)", size: [ 1280, 720 ], url: fixtureUrl(1) },
      { channelId: 2, lens: undefined, name: "640x360@30fps (Low)", size: [ 1024, 768 ], url: fixtureUrl(2) },
      { channelId: 2, lens: undefined, name: "640x360@30fps (Low)", size: [ 640, 480 ], url: fixtureUrl(2) },
      { channelId: 2, lens: undefined, name: "640x360@30fps (Low)", size: [ 640, 360 ], url: fixtureUrl(2) },
      { channelId: 2, lens: undefined, name: "640x360@30fps (Low)", size: [ 480, 360 ], url: fixtureUrl(2) },
      { channelId: 2, lens: undefined, name: "640x360@30fps (Low)", size: [ 480, 270 ], url: fixtureUrl(2) },
      { channelId: 2, lens: undefined, name: "640x360@30fps (Low)", size: [ 320, 240 ], url: fixtureUrl(2) },
      { channelId: 2, lens: undefined, name: "640x360@30fps (Low)", size: [ 320, 180 ], url: fixtureUrl(2) }
    ]),
    model: "AI Pro"
  },
  {

    channels: G5_FLEX_CHANNELS,
    expected: atEveryRate([

      { channelId: 0, lens: undefined, name: "2688x1512@30fps (High)", size: [ 2688, 1512 ], url: fixtureUrl(0) },
      { channelId: 1, lens: undefined, name: "1280x720@30fps (Medium)", size: [ 2560, 1440 ], url: fixtureUrl(1) },
      { channelId: 1, lens: undefined, name: "1280x720@30fps (Medium)", size: [ 1920, 1080 ], url: fixtureUrl(1) },
      { channelId: 1, lens: undefined, name: "1280x720@30fps (Medium)", size: [ 1280, 960 ], url: fixtureUrl(1) },
      { channelId: 1, lens: undefined, name: "1280x720@30fps (Medium)", size: [ 1280, 720 ], url: fixtureUrl(1) },
      { channelId: 2, lens: undefined, name: "640x360@30fps (Low)", size: [ 1024, 768 ], url: fixtureUrl(2) },
      { channelId: 2, lens: undefined, name: "640x360@30fps (Low)", size: [ 640, 480 ], url: fixtureUrl(2) },
      { channelId: 2, lens: undefined, name: "640x360@30fps (Low)", size: [ 640, 360 ], url: fixtureUrl(2) },
      { channelId: 2, lens: undefined, name: "640x360@30fps (Low)", size: [ 480, 360 ], url: fixtureUrl(2) },
      { channelId: 2, lens: undefined, name: "640x360@30fps (Low)", size: [ 480, 270 ], url: fixtureUrl(2) },
      { channelId: 2, lens: undefined, name: "640x360@30fps (Low)", size: [ 320, 240 ], url: fixtureUrl(2) },
      { channelId: 2, lens: undefined, name: "640x360@30fps (Low)", size: [ 320, 180 ], url: fixtureUrl(2) }
    ]),
    model: "G5 Flex"
  },
  {

    channels: G5_PTZ_CHANNELS,
    expected: atEveryRate([

      { channelId: 0, lens: undefined, name: "2688x1512@30fps (High)", size: [ 2688, 1512 ], url: fixtureUrl(0) },
      { channelId: 1, lens: undefined, name: "1280x720@30fps (Medium)", size: [ 2560, 1440 ], url: fixtureUrl(1) },
      { channelId: 1, lens: undefined, name: "1280x720@30fps (Medium)", size: [ 1920, 1080 ], url: fixtureUrl(1) },
      { channelId: 1, lens: undefined, name: "1280x720@30fps (Medium)", size: [ 1280, 960 ], url: fixtureUrl(1) },
      { channelId: 1, lens: undefined, name: "1280x720@30fps (Medium)", size: [ 1280, 720 ], url: fixtureUrl(1) },
      { channelId: 2, lens: undefined, name: "640x360@30fps (Low)", size: [ 1024, 768 ], url: fixtureUrl(2) },
      { channelId: 2, lens: undefined, name: "640x360@30fps (Low)", size: [ 640, 480 ], url: fixtureUrl(2) },
      { channelId: 2, lens: undefined, name: "640x360@30fps (Low)", size: [ 640, 360 ], url: fixtureUrl(2) },
      { channelId: 2, lens: undefined, name: "640x360@30fps (Low)", size: [ 480, 360 ], url: fixtureUrl(2) },
      { channelId: 2, lens: undefined, name: "640x360@30fps (Low)", size: [ 480, 270 ], url: fixtureUrl(2) },
      { channelId: 2, lens: undefined, name: "640x360@30fps (Low)", size: [ 320, 240 ], url: fixtureUrl(2) },
      { channelId: 2, lens: undefined, name: "640x360@30fps (Low)", size: [ 320, 180 ], url: fixtureUrl(2) }
    ]),
    model: "G5 PTZ"
  },
  {

    channels: G6_INSTANT_CHANNELS,
    expected: atEveryRate([

      { channelId: 0, lens: undefined, name: "3840x2160@30fps (High)", size: [ 3840, 2160 ], url: fixtureUrl(0) },
      { channelId: 1, lens: undefined, name: "1280x720@30fps (Medium)", size: [ 2560, 1440 ], url: fixtureUrl(1) },
      { channelId: 1, lens: undefined, name: "1280x720@30fps (Medium)", size: [ 1920, 1080 ], url: fixtureUrl(1) },
      { channelId: 1, lens: undefined, name: "1280x720@30fps (Medium)", size: [ 1280, 960 ], url: fixtureUrl(1) },
      { channelId: 1, lens: undefined, name: "1280x720@30fps (Medium)", size: [ 1280, 720 ], url: fixtureUrl(1) },
      { channelId: 2, lens: undefined, name: "640x360@30fps (Low)", size: [ 1024, 768 ], url: fixtureUrl(2) },
      { channelId: 2, lens: undefined, name: "640x360@30fps (Low)", size: [ 640, 480 ], url: fixtureUrl(2) },
      { channelId: 2, lens: undefined, name: "640x360@30fps (Low)", size: [ 640, 360 ], url: fixtureUrl(2) },
      { channelId: 2, lens: undefined, name: "640x360@30fps (Low)", size: [ 480, 360 ], url: fixtureUrl(2) },
      { channelId: 2, lens: undefined, name: "640x360@30fps (Low)", size: [ 480, 270 ], url: fixtureUrl(2) },
      { channelId: 2, lens: undefined, name: "640x360@30fps (Low)", size: [ 320, 240 ], url: fixtureUrl(2) },
      { channelId: 2, lens: undefined, name: "640x360@30fps (Low)", size: [ 320, 180 ], url: fixtureUrl(2) }
    ]),
    model: "G6 Instant"
  },
  {

    channels: G6_PRO_ENTRY_CHANNELS,

    // G6 Pro Entry is a portrait 3:4 doorbell at the controller's 3024x4032 top, whose channels run at a native 20fps. Every 3:4 row sits within its native area and
    // joins the sizes HomeKit requires: 2400x3200 and 1536x2048 map to Medium, and every smaller size, 1920x1080 included, maps to Low, since Medium's 1440x1920 holds
    // more pixels. Its Package Camera channel is filtered out of this parent list.
    expected: atEveryRate([

      { channelId: 0, lens: undefined, name: "3024x4032@20fps (High)", size: [ 3024, 4032 ], url: fixtureUrl(0) },
      { channelId: 1, lens: undefined, name: "1440x1920@20fps (Medium)", size: [ 2400, 3200 ], url: fixtureUrl(1) },
      { channelId: 1, lens: undefined, name: "1440x1920@20fps (Medium)", size: [ 1536, 2048 ], url: fixtureUrl(1) },
      { channelId: 1, lens: undefined, name: "1440x1920@20fps (Medium)", size: [ 1440, 1920 ], url: fixtureUrl(1) },
      { channelId: 2, lens: undefined, name: "480x640@20fps (Low)", size: [ 1920, 1080 ], url: fixtureUrl(2) },
      { channelId: 2, lens: undefined, name: "480x640@20fps (Low)", size: [ 1200, 1600 ], url: fixtureUrl(2) },
      { channelId: 2, lens: undefined, name: "480x640@20fps (Low)", size: [ 1280, 960 ], url: fixtureUrl(2) },
      { channelId: 2, lens: undefined, name: "480x640@20fps (Low)", size: [ 960, 1280 ], url: fixtureUrl(2) },
      { channelId: 2, lens: undefined, name: "480x640@20fps (Low)", size: [ 1280, 720 ], url: fixtureUrl(2) },
      { channelId: 2, lens: undefined, name: "480x640@20fps (Low)", size: [ 1024, 768 ], url: fixtureUrl(2) },
      { channelId: 2, lens: undefined, name: "480x640@20fps (Low)", size: [ 768, 1024 ], url: fixtureUrl(2) },
      { channelId: 2, lens: undefined, name: "480x640@20fps (Low)", size: [ 640, 480 ], url: fixtureUrl(2) },
      { channelId: 2, lens: undefined, name: "480x640@20fps (Low)", size: [ 480, 640 ], url: fixtureUrl(2) },
      { channelId: 2, lens: undefined, name: "480x640@20fps (Low)", size: [ 640, 360 ], url: fixtureUrl(2) },
      { channelId: 2, lens: undefined, name: "480x640@20fps (Low)", size: [ 480, 360 ], url: fixtureUrl(2) },
      { channelId: 2, lens: undefined, name: "480x640@20fps (Low)", size: [ 360, 480 ], url: fixtureUrl(2) },
      { channelId: 2, lens: undefined, name: "480x640@20fps (Low)", size: [ 480, 270 ], url: fixtureUrl(2) },
      { channelId: 2, lens: undefined, name: "480x640@20fps (Low)", size: [ 320, 240 ], url: fixtureUrl(2) },
      { channelId: 2, lens: undefined, name: "480x640@20fps (Low)", size: [ 240, 320 ], url: fixtureUrl(2) },
      { channelId: 2, lens: undefined, name: "480x640@20fps (Low)", size: [ 320, 180 ], url: fixtureUrl(2) }
    ]),
    model: "G6 Pro Entry"
  },
  {

    channels: DOORBELL_LITE_CHANNELS,

    // The Doorbell Lite is a portrait 3:4 doorbell whose channels run at 24fps. 2400x3200 holds more pixels than its native top and stays out; the 3:4 rows within its
    // native area join the sizes HomeKit requires. Every size from 1536x2048 down to 768x1024 maps to Medium, and every size from 640x480 down maps to Low.
    expected: atEveryRate([

      { channelId: 0, lens: undefined, name: "1920x2560@24fps (High)", size: [ 1920, 2560 ], url: fixtureUrl(0) },
      { channelId: 1, lens: undefined, name: "672x896@24fps (Medium)", size: [ 1536, 2048 ], url: fixtureUrl(1) },
      { channelId: 1, lens: undefined, name: "672x896@24fps (Medium)", size: [ 1920, 1080 ], url: fixtureUrl(1) },
      { channelId: 1, lens: undefined, name: "672x896@24fps (Medium)", size: [ 1200, 1600 ], url: fixtureUrl(1) },
      { channelId: 1, lens: undefined, name: "672x896@24fps (Medium)", size: [ 1280, 960 ], url: fixtureUrl(1) },
      { channelId: 1, lens: undefined, name: "672x896@24fps (Medium)", size: [ 960, 1280 ], url: fixtureUrl(1) },
      { channelId: 1, lens: undefined, name: "672x896@24fps (Medium)", size: [ 1280, 720 ], url: fixtureUrl(1) },
      { channelId: 1, lens: undefined, name: "672x896@24fps (Medium)", size: [ 1024, 768 ], url: fixtureUrl(1) },
      { channelId: 1, lens: undefined, name: "672x896@24fps (Medium)", size: [ 768, 1024 ], url: fixtureUrl(1) },
      { channelId: 1, lens: undefined, name: "672x896@24fps (Medium)", size: [ 672, 896 ], url: fixtureUrl(1) },
      { channelId: 2, lens: undefined, name: "336x448@24fps (Low)", size: [ 640, 480 ], url: fixtureUrl(2) },
      { channelId: 2, lens: undefined, name: "336x448@24fps (Low)", size: [ 480, 640 ], url: fixtureUrl(2) },
      { channelId: 2, lens: undefined, name: "336x448@24fps (Low)", size: [ 640, 360 ], url: fixtureUrl(2) },
      { channelId: 2, lens: undefined, name: "336x448@24fps (Low)", size: [ 480, 360 ], url: fixtureUrl(2) },
      { channelId: 2, lens: undefined, name: "336x448@24fps (Low)", size: [ 360, 480 ], url: fixtureUrl(2) },
      { channelId: 2, lens: undefined, name: "336x448@24fps (Low)", size: [ 336, 448 ], url: fixtureUrl(2) },
      { channelId: 2, lens: undefined, name: "336x448@24fps (Low)", size: [ 480, 270 ], url: fixtureUrl(2) },
      { channelId: 2, lens: undefined, name: "336x448@24fps (Low)", size: [ 320, 240 ], url: fixtureUrl(2) },
      { channelId: 2, lens: undefined, name: "336x448@24fps (Low)", size: [ 240, 320 ], url: fixtureUrl(2) },
      { channelId: 2, lens: undefined, name: "336x448@24fps (Low)", size: [ 320, 180 ], url: fixtureUrl(2) }
    ]),
    model: "Doorbell Lite"
  },
  {

    channels: C5_WITNESS_CHANNELS,

    // The deep-low-resolution witness: a 640x480 4:3 native top with every size HomeKit requires above 640x480 still advertised. Those sizes, 1920x1080 down to
    // 1024x768, map to High, the highest channel the camera has; 640x360 maps to Low, and 480x270 and every smaller size fall back to Low as the lowest channel. Every
    // channel runs at 15fps.
    expected: atEveryRate([

      { channelId: 0, lens: undefined, name: "640x480@15fps (High)", size: [ 1920, 1080 ], url: fixtureUrl(0) },
      { channelId: 0, lens: undefined, name: "640x480@15fps (High)", size: [ 1280, 960 ], url: fixtureUrl(0) },
      { channelId: 0, lens: undefined, name: "640x480@15fps (High)", size: [ 1280, 720 ], url: fixtureUrl(0) },
      { channelId: 0, lens: undefined, name: "640x480@15fps (High)", size: [ 1024, 768 ], url: fixtureUrl(0) },
      { channelId: 0, lens: undefined, name: "640x480@15fps (High)", size: [ 640, 480 ], url: fixtureUrl(0) },
      { channelId: 1, lens: undefined, name: "480x360@15fps (Low)", size: [ 640, 360 ], url: fixtureUrl(1) },
      { channelId: 1, lens: undefined, name: "480x360@15fps (Low)", size: [ 480, 360 ], url: fixtureUrl(1) },
      { channelId: 1, lens: undefined, name: "480x360@15fps (Low)", size: [ 480, 270 ], url: fixtureUrl(1) },
      { channelId: 1, lens: undefined, name: "480x360@15fps (Low)", size: [ 320, 240 ], url: fixtureUrl(1) },
      { channelId: 1, lens: undefined, name: "480x360@15fps (Low)", size: [ 320, 180 ], url: fixtureUrl(1) }
    ]),
    model: "C5 Witness 640x480"
  }
];

// The package-camera golden-master fixture: the list the package camera advertises, the one advertised-list builder over its channel at a fixed 15fps, mapped to
// resolutions.
export const PACKAGE_FIXTURES: PackageFixture[] = [

  {

    // The G6 Pro Entry's package channel, 1600x1200 (4:3) at a native 3fps. The 4:3 rows within its native area, 1440x1080 among them, join the sizes HomeKit
    // requires, while 2048x1536 holds more pixels than the channel and stays out. Every entry advertises 15fps, the package's own size included.
    channel: G6_PRO_ENTRY_PACKAGE_CHANNEL,
    expected: [ [ 1920, 1080, 15 ], [ 1600, 1200, 15 ], [ 1440, 1080, 15 ], [ 1280, 960, 15 ], [ 1280, 720, 15 ], [ 1024, 768, 15 ], [ 640, 480, 15 ],
      [ 640, 360, 15 ], [ 480, 360, 15 ], [ 480, 270, 15 ], [ 320, 240, 15 ], [ 320, 180, 15 ] ],
    model: "G6 Pro Entry Package"
  }
];

// The init segment an Amcrest camera's livestream delivered through Protect, captured from the controller and checked in byte for byte: H.264 Main at 2592 by
// 1944 beside one AAC-LC audio track at 8000 Hz in one channel, the stream a camera whose audio differs from the recording stand-in carries. The probe and buffer
// tests describe it through unifi-protect's own describeInitSegment, so what they read is what the controller's bytes say.
export const AMCREST_INIT_SEGMENT = Buffer.from([

  "AAAAIGZ0eXBkYXNoAAAAAGlzbzZodmMxYXZjMW1wNDEAAAR+bW9vdgAAAGxtdmhkAAAAAObxoLPm8aCzAAAD6AAAAAAAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAA",
  "AABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwAAAEhtdmV4AAAAIHRyZXgAAAAAAAAAAQAAAAEAAAjKAAAAAAABAAAAAAAgdHJleAAAAAAAAAACAAAAAQAABAAAAAAAAAAAAAAAAgJ0cmFr",
  "AAAAXHRraGQAAAAH5vGgs+bxoLMAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAACiAAAAeYAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAA",
  "AAEAAAAAAAAAAAABAAAAAAF6bWRpYQAAACBtZGhkAAAAAObxoLPm8aCzAAFfkAAAAABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABJW1pbmYAAAAUdm1o",
  "ZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAOVzdGJsAAAAmXN0c2QAAAAAAAAAAQAAAIlhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAACiAHmABIAAAA",
  "SAAAAAAAAAABFlViaXF1aXRpIE1lZGlhIFNlcnZlciAAAAAAAAAAAAAAGP//AAAAM2F2Y0MBTUAz/+EAG2dNQDOmgCiA9flm4CAgKAAAAwAIAAADAUQgAAEABWjuPIAAAAAAEHN0dHMAAAAAAAAAAAAA",
  "ABBzdHNjAAAAAAAAAAAAAAAUc3RzegAAAAAAAAAAAAAAAAAAABBzdGNvAAAAAAAAAAAAAAHAdHJhawAAAFx0a2hkAAAAB+bxoLPm8aCzAAAAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAABAAAAAAAA",
  "AAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAJGVkdHMAAAAcZWxzdAAAAAAAAAABAAAAAAAAAAAAAQAAAAABOG1kaWEAAAAgbWRoZAAAAADm8aCz5vGgswAAH0AAAAAAVcQAAAAA",
  "AC1oZGxyAAAAAAAAAABzb3VuAAAAAAAAAAAAAAAAU291bmRIYW5kbGVyAAAAAONtaW5mAAAAEHNtaGQAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAKdzdGJsAAAA",
  "W3N0c2QAAAAAAAAAAQAAAEttcDRhAAAAAAAAAAEAAAAAAAAAAAACABAAAAAAH0AAAAAAACdlc2RzAAAAAAMZAAIABBFAFQAAAAAAAAAAAAAABQIViAYBAgAAABBzdHRzAAAAAAAAAAAAAAAQc3RzYwAA",
  "AAAAAAAAAAAAFHN0c3oAAAAAAAAAAAAAAAAAAAAQc3RjbwAAAAAAAAAA"
].join(""), "base64");
