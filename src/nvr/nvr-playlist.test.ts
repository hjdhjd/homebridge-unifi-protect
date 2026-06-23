/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * nvr-playlist.test.ts: Durable coverage for the pure M3U playlist content composer (nvr-playlist.ts buildPlaylist).
 *
 * This suite tests buildPlaylist - the content decision (the SSOT of what the playlist contains: the header, the AV1/RTSP filter, the name sort, the per-camera #EXTINF
 * guide block, the plain-RTSP URL line, the package-camera entry, and the load-bearing primary-vs-package name asymmetry) - directly and server-free. buildPlaylist is
 * pure: it takes the camera configs plus a fixed host/port and returns the playlist string, so the whole format and ordering surface is exhaustively assertable with
 * constructed inputs and no TCP port. servePlaylist's HTTP shell and its shutdown teardown (the already-aborted guard, the server.close(), the retry-timer cancel) are
 * I/O glue verified by inspection against the brief's four pre-mortem checks - reaching them would require binding a real TCP port, which this spawn-free suite avoids
 * (the same dispatcher-boundary discipline the step-11 split established).
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { buildPlaylist } from "./nvr-playlist.ts";
import { makeCameraConfig } from "../testing.helpers.ts";
import { makeChannel } from "../camera.fixtures.ts";

// The fixed host and RTSP port every case composes against, so the expected rtsp:// lines are deterministic.
const HOST = "controller.local";
const RTSP_PORT = 7447;

// The rtsp:// catalog line buildPlaylist emits for a channel, by its alias (makeChannel synthesizes rtspAlias as "alias" + id).
function rtspLine(rtspAlias: string): string {

  return "rtsp://" + HOST + ":" + RTSP_PORT.toString() + "/" + rtspAlias;
}

describe("nvr-playlist: buildPlaylist - the M3U content composer", () => {

  // Empty input yields just the header, with no entries.
  test("empty input yields exactly the M3U header", () => {

    assert.equal(buildPlaylist([], HOST, RTSP_PORT), "#EXTM3U\n");
  });

  // A single h264 RTSP camera publishes the header, a guide-annotated #EXTINF block (carrying the camera name and marketName), and the exact rtsp:// line for its
  // primary channel (alias0).
  test("a single h264 RTSP camera publishes its #EXTINF guide block and exact rtsp:// line", () => {

    const camera = makeCameraConfig({ channels: [makeChannel({ fps: 30, height: 1080, id: 0, name: "High", width: 1920 })], name: "Front Door" });
    const playlist = buildPlaylist([camera], HOST, RTSP_PORT);

    assert.ok(playlist.startsWith("#EXTM3U\n"));
    assert.ok(playlist.includes("#EXTINF:0 channel-id=\"Front Door\""));
    assert.ok(playlist.includes("UniFi Protect " + camera.marketName + " camera livestream."));
    assert.ok(playlist.includes(rtspLine("alias0") + "\n"));
  });

  // An AV1 camera is excluded by the codec filter while a sibling h264 camera is published.
  test("an av1 camera is excluded while a sibling h264 camera is included", () => {

    const av1 = makeCameraConfig({ channels: [makeChannel({ fps: 30, height: 1080, id: 0, name: "High", width: 1920 })], id: "av1-cam", name: "AV1 Cam",
      videoCodec: "av1" });
    const h264 = makeCameraConfig({ channels: [makeChannel({ fps: 30, height: 1080, id: 5, name: "High", width: 1920 })], id: "h264-cam", name: "H264 Cam" });
    const playlist = buildPlaylist([ av1, h264 ], HOST, RTSP_PORT);

    assert.ok(!playlist.includes("AV1 Cam"));
    assert.ok(playlist.includes("H264 Cam"));
    assert.ok(playlist.includes(rtspLine("alias5") + "\n"));
  });

  // A camera with no RTSP-enabled channels is excluded by the RTSP filter while a sibling RTSP camera is published.
  test("a no-RTSP camera is excluded while a sibling RTSP camera is included", () => {

    const noRtsp = makeCameraConfig({ channels: [makeChannel({ fps: 30, height: 1080, id: 0, isRtspEnabled: false, name: "High", width: 1920 })], id: "no-rtsp",
      name: "No RTSP Cam" });
    const rtsp = makeCameraConfig({ channels: [makeChannel({ fps: 30, height: 1080, id: 7, name: "High", width: 1920 })], id: "rtsp-cam", name: "RTSP Cam" });
    const playlist = buildPlaylist([ noRtsp, rtsp ], HOST, RTSP_PORT);

    assert.ok(!playlist.includes("No RTSP Cam"));
    assert.ok(playlist.includes("RTSP Cam"));
    assert.ok(playlist.includes(rtspLine("alias7") + "\n"));
  });

  // Two RTSP cameras supplied out of input order appear name-sorted in the playlist (localeCompare on name). We use unambiguous ASCII names so order is deterministic.
  test("two cameras supplied out of order appear name-sorted", () => {

    const zulu = makeCameraConfig({ channels: [makeChannel({ fps: 30, height: 1080, id: 1, name: "High", width: 1920 })], id: "zulu", name: "Zulu" });
    const alpha = makeCameraConfig({ channels: [makeChannel({ fps: 30, height: 1080, id: 2, name: "High", width: 1920 })], id: "alpha", name: "Alpha" });
    const playlist = buildPlaylist([ zulu, alpha ], HOST, RTSP_PORT);

    // Alpha sorts before Zulu, so its rtsp:// line (alias2) appears before Zulu's (alias1) regardless of input order.
    assert.ok(playlist.indexOf(rtspLine("alias2")) < playlist.indexOf(rtspLine("alias1")));
  });

  // A package-camera camera publishes two rtsp:// lines (primary + package alias) and the "package camera" guide text; a package-flagged camera with NO package channel
  // publishes only its primary entry (the continue guard).
  test("a package camera publishes primary + package entries; a package-flagged camera with no package channel publishes only the primary", () => {

    const packageChannels = [ makeChannel({ fps: 30, height: 1080, id: 0, name: "High", width: 1920 }),
      makeChannel({ fps: 3, height: 1200, id: 3, name: "Package Camera", width: 1600 }) ];
    const withPackage = makeCameraConfig({ channels: packageChannels, featureFlags: { hasPackageCamera: true }, id: "with-pkg", name: "Package Cam" });
    const withPlaylist = buildPlaylist([withPackage], HOST, RTSP_PORT);

    assert.ok(withPlaylist.includes(rtspLine("alias0") + "\n"));
    assert.ok(withPlaylist.includes(rtspLine("alias3") + "\n"));
    assert.ok(withPlaylist.includes("package camera"));

    // The package-flagged camera with no package channel: the hasPackageCamera flag is set but no channel matches isPackageChannel, so the continue guard fires and only
    // the primary entry is emitted.
    const noPackageChannel = makeCameraConfig({ channels: [makeChannel({ fps: 30, height: 1080, id: 4, name: "High", width: 1920 })],
      featureFlags: { hasPackageCamera: true }, id: "no-pkg-chan", name: "Flagged No Package" });
    const noPackagePlaylist = buildPlaylist([noPackageChannel], HOST, RTSP_PORT);

    assert.ok(noPackagePlaylist.includes(rtspLine("alias4") + "\n"));
    assert.ok(!noPackagePlaylist.includes("package camera"));
  });
});
