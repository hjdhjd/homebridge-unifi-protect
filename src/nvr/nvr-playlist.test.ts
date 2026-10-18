/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * nvr-playlist.test.ts: Durable coverage for the M3U playlist content composer and its HTTP shell (nvr-playlist.ts buildPlaylist and servePlaylist).
 *
 * This suite tests buildPlaylist - the content decision (the SSOT of what the playlist contains: the header, the AV1/RTSP filter, the name sort, the per-camera #EXTINF
 * guide block, the plain-RTSP URL line, the package-camera entry, and the primary-vs-package name asymmetry the tests hold fixed) - directly and server-free.
 * buildPlaylist is pure: it takes the camera configs plus a fixed host/port and returns the playlist string, so the whole format and ordering surface is exhaustively
 * assertable with constructed inputs and no TCP port.
 *
 * The shell is tested over a real homebridge-plugin-utils listener bound to an ephemeral port on the controller double, fetched over loopback: what the playlist
 * route answers for the store's cameras, the empty-catalog line's once-per-run latch, and the controller's lifetime signal governing the listener. What the listener
 * itself does with its options - the retry, the body limit, the teardown - is its own suite's to hold.
 */
import { TestStateStore, makeProtectState } from "../testing.helpers.ts";
import { buildPlaylist, servePlaylist } from "./nvr-playlist.ts";
import { describe, test } from "node:test";
import { logCount, loggedAt } from "homebridge-plugin-utils/testing";
import type { IncomingHttpHeaders } from "node:http";
import type { ProtectCameraConfig } from "unifi-protect";
import type { ProtectNvr } from "./nvr.ts";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { makeCameraConfig } from "../devices/testing.helpers.ts";
import { makeChannel } from "../camera.fixtures.ts";
import { makeTestNvr } from "./testing.helpers.ts";

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
    assert.ok(playlist.includes("UniFi Protect Test Camera Model camera livestream."));
    assert.ok(playlist.includes(rtspLine("alias0") + "\n"));
  });

  // The controller reports no market name for some cameras, so the guide text falls through to the hardware type that camera does report. The record drops the
  // marketName key outright, which is the shape such a camera actually arrives in.
  test("a camera reporting no market name carries its hardware type in the guide text", () => {

    const { marketName: _marketName, ...camera } = makeCameraConfig({ channels: [makeChannel({ fps: 30, height: 1080, id: 2, name: "High", width: 1920 })],
      name: "Side Gate" });
    const playlist = buildPlaylist([{ ...camera, type: "UVC G5 Flex" }], HOST, RTSP_PORT);

    assert.ok(playlist.includes("UniFi Protect UVC G5 Flex camera livestream."));
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

// The empty-catalog line the shell logs once per run, matched by its opening sentence.
const EMPTY_CATALOG_LINE = "The M3U playlist has no cameras available to publish.";

// Build a controller double whose playlist resolves to port zero, so the kernel hands the listener a free port, over a store seeded with the supplied cameras.
function makePlaylistNvr(cameras: ProtectCameraConfig[] = []): ReturnType<typeof makeTestNvr> & { store: TestStateStore } {

  const store = new TestStateStore(makeProtectState({ cameras }));

  return { ...makeTestNvr({ store, userOptions: ["Enable.Nvr.Service.Playlist.0"] }), store };
}

// Fetch a path from the listener over loopback, answering the status, headers, and body it wrote.
async function fetchPlaylist(options: { method: string; path: string; port: number }): Promise<{ body: string; headers: IncomingHttpHeaders; status: number }> {

  return new Promise((resolve, reject) => {

    const call = httpRequest({ host: "127.0.0.1", method: options.method, path: options.path, port: options.port }, (response) => {

      const chunks: Buffer[] = [];

      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ body: Buffer.concat(chunks).toString("utf8"), headers: response.headers, status: response.statusCode ?? 0 }));
    });

    call.on("error", reject);
    call.end();
  });
}

describe("nvr-playlist: servePlaylist - the HTTP shell over the listener", () => {

  // The listener binds and announces itself under the playlist's label with the port the kernel gave it, through the controller's log.
  test("the publisher binds an ephemeral port and logs the listening line naming the port it bound", async () => {

    const { controller, logEntries, nvr } = makePlaylistNvr();
    const listener = servePlaylist(nvr as unknown as ProtectNvr);

    try {

      assert.ok(listener, "an un-aborted controller must publish");

      await listener.ready;

      assert.ok(listener.boundPort > 0, "port zero must resolve to the kernel's port");
      assert.ok(loggedAt(logEntries, "info", "The M3U playlist publisher is listening on port " + listener.boundPort.toString() + "."));
    } finally {

      await listener?.[Symbol.asyncDispose]();
      controller.abort();
    }
  });

  // A request answers the playlist the composer builds for the store's cameras on the controller's host and RTSP port, and each request recomposes it, so a camera
  // renamed between two requests is read at its new name by the second.
  test("a request answers the composed playlist with its content type, recomposed from the live cameras on every request", async () => {

    const camera = makeCameraConfig({ channels: [makeChannel({ fps: 30, height: 1080, id: 0, name: "High", width: 1920 })], name: "Front Door" });
    const { controller, nvr, store } = makePlaylistNvr([camera]);
    const listener = servePlaylist(nvr as unknown as ProtectNvr);

    try {

      assert.ok(listener, "an un-aborted controller must publish");

      await listener.ready;

      const first = await fetchPlaylist({ method: "GET", path: "/", port: listener.boundPort });

      assert.equal(first.status, 200);
      assert.equal(first.headers["content-type"], "application/x-mpegURL");
      assert.equal(first.body, buildPlaylist([camera], nvr.ufp.host, nvr.ufp.ports.rtsp));
      assert.ok(first.body.includes("Front Door"), "the seeded camera must be in the catalog");

      store.pushCameraPatch(camera.id, { name: "Back Door" });

      const second = await fetchPlaylist({ method: "GET", path: "/", port: listener.boundPort });

      assert.equal(second.body, buildPlaylist([...store.snapshot().cameras.values()], nvr.ufp.host, nvr.ufp.ports.rtsp));
      assert.ok(second.body.includes("Back Door"), "the second request must read the renamed camera");
      assert.notEqual(second.body, first.body);
    } finally {

      await listener?.[Symbol.asyncDispose]();
      controller.abort();
    }
  });

  // The route is the catch-all, so any path under any method answers the same playlist a plain GET of the root does.
  test("every path and method answers the playlist", async () => {

    const camera = makeCameraConfig({ channels: [makeChannel({ fps: 30, height: 1080, id: 0, name: "High", width: 1920 })], name: "Front Door" });
    const { controller, nvr } = makePlaylistNvr([camera]);
    const listener = servePlaylist(nvr as unknown as ProtectNvr);

    try {

      assert.ok(listener, "an un-aborted controller must publish");

      await listener.ready;

      const root = await fetchPlaylist({ method: "GET", path: "/", port: listener.boundPort });
      const other = await fetchPlaylist({ method: "POST", path: "/anything", port: listener.boundPort });

      assert.equal(other.status, 200);
      assert.equal(other.headers["content-type"], "application/x-mpegURL");
      assert.equal(other.body, root.body);
    } finally {

      await listener?.[Symbol.asyncDispose]();
      controller.abort();
    }
  });

  // An empty catalog is narrated once per run, however often a player polls the playlist.
  test("an empty catalog logs its line once across repeated requests", async () => {

    const { controller, logEntries, nvr } = makePlaylistNvr();
    const listener = servePlaylist(nvr as unknown as ProtectNvr);

    try {

      assert.ok(listener, "an un-aborted controller must publish");

      await listener.ready;

      await fetchPlaylist({ method: "GET", path: "/", port: listener.boundPort });
      await fetchPlaylist({ method: "GET", path: "/", port: listener.boundPort });

      assert.equal(logCount(logEntries, "info", EMPTY_CATALOG_LINE), 1);
    } finally {

      await listener?.[Symbol.asyncDispose]();
      controller.abort();
    }
  });

  // A controller already shutting down publishes nothing: no listener, no throw, and no line.
  test("a controller already shutting down publishes nothing and logs nothing", () => {

    const { controller, logEntries, nvr } = makePlaylistNvr();

    controller.abort();

    const before = logEntries.length;

    assert.equal(servePlaylist(nvr as unknown as ProtectNvr), null);
    assert.equal(logEntries.length, before);
  });

  // A configured port the listener refuses is reported once in the plugin's own words, and the call answers null rather than throwing into the controller's startup.
  test("a port outside the valid range is reported and publishes nothing without throwing", () => {

    const { controller, logEntries, nvr } = makeTestNvr({ store: new TestStateStore(makeProtectState({})), userOptions: ["Enable.Nvr.Service.Playlist.70000"] });

    try {

      let listener: ReturnType<typeof servePlaylist> | undefined;

      assert.doesNotThrow(() => {

        listener = servePlaylist(nvr as unknown as ProtectNvr);
      });
      assert.equal(listener, null);
      assert.equal(logCount(logEntries, "error", "Unable to publish the M3U playlist. The configured port must be a whole number from 0 to 65535."), 1);
    } finally {

      controller.abort();
    }
  });

  // The controller's lifetime signal governs the listener, so a controller shutting down ends its publisher.
  test("the controller's shutdown ends the publisher", async () => {

    const { controller, nvr } = makePlaylistNvr();
    const listener = servePlaylist(nvr as unknown as ProtectNvr);

    try {

      assert.ok(listener, "an un-aborted controller must publish");

      await listener.ready;

      assert.equal(listener.aborted, false);

      controller.abort();

      assert.equal(listener.aborted, true);
    } finally {

      await listener?.[Symbol.asyncDispose]();
      controller.abort();
    }
  });
});
