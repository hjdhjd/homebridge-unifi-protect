/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * nvr-playlist.ts: The M3U playlist service for UniFi Protect camera livestreams.
 *
 * This module owns the controller's optional M3U playlist publisher, split along the step-11 policy/mechanism seam into two exported functions. buildPlaylist is the
 * pure content decision - the SSOT of what the playlist contains (the header, the codec/RTSP filter, the name sort, the per-camera #EXTINF guide block, the plain-RTSP
 * URL line, and the package-camera entry) - composed server-free as a string so the whole format and ordering surface is exhaustively unit-testable with constructed
 * camera configs and no TCP port. servePlaylist is the thin I/O shell: it stands up the HTTP server, wires the request/error/listening handlers, and binds a one-shot
 * teardown to plugin shutdown so a Homebridge reload (a SHUTDOWN that is not a process exit) releases the port instead of leaking it across the restart.
 *
 * The leaf references the controller (ProtectNvr) by TYPE only and is constructed by no one - servePlaylist(nvr) is invoked from the NVR's login() through an
 * already-held reference, so this module adds no value-import edge to nvr.ts and the device/controller value-import graph stays a cycle-free DAG.
 */
import { formatErrorMessage, onAbort } from "homebridge-plugin-utils";
import { isPackageChannel, rtspUrl } from "../media/resolution.ts";
import { PROTECT_M3U_PLAYLIST_PORT } from "../settings.ts";
import type { ProtectCameraConfig } from "unifi-protect";
import type { ProtectNvr } from "./nvr.ts";
import http from "node:http";
import util from "node:util";

// Compose the M3U playlist body for the supplied camera configs. Pure string composition - host and rtspPort are read from the live NVR projection by the caller and
// passed in, so this function does no I/O and is exhaustively testable. We publish only cameras that are not AV1 (HomeKit/app codec compatibility) and that have at
// least one RTSP-enabled channel, sorted by name so the catalog is stable across reads. Each entry is a guide-annotated #EXTINF block followed by the plain-RTSP URL
// (rtsp://, not the secure rtsps:// stream) because many consuming apps (e.g. Channels DVR) only speak plain RTSP.
export function buildPlaylist(cameras: readonly ProtectCameraConfig[], host: string, rtspPort: number): string {

  // We accumulate each piece of the playlist into an array and join once, which is byte-equivalent to the prior streamed response.write() sequence with none of the I/O.
  const parts: string[] = [];

  // Emit the M3U header.
  parts.push("#EXTM3U\n");

  // Find the RTSP aliases and publish them. We filter out any cameras that don't have RTSP aliases since they would be inaccessible in this context.
  const publishable = cameras
    .filter(camera => (camera.videoCodec !== "av1") && camera.channels.some(channel => channel.isRtspEnabled))
    .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));

  for(const camera of publishable) {

    // By convention, the first channel is the highest quality on UniFi Protect cameras, and our filter above guarantees this camera has at least one channel. We still
    // capture it through a guard rather than indexing blind, so a camera that somehow reports no channels is skipped cleanly instead of crashing.
    const primaryChannel = camera.channels[0];

    if(!primaryChannel) {

      continue;
    }

    // Publish a playlist entry, including guide information that's suitable for apps that support it, such as Channels DVR. The closure takes the channel so the RTSP
    // line is composed through the SSOT rtspUrl(..., false) - the plain rtsp:// catalog URL - rather than a hand-rolled string.
    const publishEntry = (channel = primaryChannel, name = camera.name, description = "camera"): void => {

      parts.push(util.format("#EXTINF:0 channel-id=\"%s\" tvc-stream-vcodec=\"h264\" tvc-stream-acodec=\"opus\" tvg-logo=\"%s\" ",
        name, "https://raw.githubusercontent.com/hjdhjd/homebridge-unifi-protect/main/images/homebridge-unifi-protect-4x3.png"));

      parts.push(util.format("tvc-guide-title=\"%s Livestream\" tvc-guide-description=\"UniFi Protect %s %s livestream.\" ",
        name, camera.marketName, description));

      parts.push(util.format("tvc-guide-art=\"%s\" tvc-guide-placeholders=\"86400\" tvc-guide-tags=\"HD, Live, New, UniFi Protect\", %s\n",
        "https://raw.githubusercontent.com/hjdhjd/homebridge-unifi-protect/main/images/homebridge-unifi-protect-4x3.png", name));

      // By convention, the first RTSP alias is always the highest quality on UniFi Protect cameras. Grab it and we're done. We might be tempted to use the RTSPS stream
      // here, but many apps only support RTSP, and we'll opt for maximizing compatibility here.
      parts.push(rtspUrl(channel, host, rtspPort, false) + "\n");
    };

    // Create a playlist entry for each camera. We pass the primary channel and the camera's RAW name (not coalesced): a nameless camera renders "undefined" in the
    // primary #EXTINF, which is the current byte-for-byte behavior and is preserved deliberately.
    publishEntry();

    // Ensure we publish package cameras as well, when we have them.
    if(camera.featureFlags.hasPackageCamera) {

      const packageChannel = camera.channels.find(x => x.isRtspEnabled && isPackageChannel(x));

      if(!packageChannel) {

        continue;
      }

      // The package entry coalesces the camera name (so a nameless camera does not render "undefined " before the package channel name) - asymmetric with the primary
      // entry above by design.
      publishEntry(packageChannel, (camera.name ?? "") + " " + packageChannel.name, "package camera");
    }
  }

  return parts.join("");
}

// Create a web service to publish an M3U playlist of Protect camera livestreams. This is the thin I/O shell around buildPlaylist: it stands up the HTTP server, wires the
// request/error/listening handlers, and binds a one-shot shutdown teardown to the NVR's lifetime signal so a plugin reload releases the port.
export function servePlaylist(nvr: ProtectNvr): void {

  const port = nvr.getFeatureNumber("Nvr.Service.Playlist") ?? PROTECT_M3U_PLAYLIST_PORT;
  const server = http.createServer();

  // The pending EADDRINUSE retry timer, if one is armed. We keep the handle so the shutdown teardown can cancel it and no retry can re-listen the port after teardown.
  let retryTimer: NodeJS.Timeout | undefined;

  // Respond to requests for a Protect camera playlist, reading the host and RTSP port from the live NVR projection at request time.
  server.on("request", (_request, response) => {

    // Set the right MIME type for M3U playlists.
    response.writeHead(200, { "Content-Type": "application/x-mpegURL" });
    response.write(buildPlaylist(nvr.client.cameras.map(projection => projection.config), nvr.ufp.host, nvr.ufp.ports.rtsp));
    response.end();
  });

  // Handle errors when they occur.
  server.on("error", (error) => {

    // Already shutting down: do not arm a retry. listen() returns synchronously and the EADDRINUSE error fires a tick later, possibly AFTER the one-shot teardown ran -
    // a retry armed then would be a live 5s timer nothing can cancel. The EADDRINUSE arm is the only place a timer is created, so this one guard closes it.
    if(nvr.signal.aborted) {

      return;
    }

    // Explicitly handle address in use errors, given their relative common nature. Everything else, we log and abandon.
    if((error as NodeJS.ErrnoException).code === "EADDRINUSE") {

      nvr.log.error("The address and port we are attempting to use is already in use by something else. Will retry again shortly.");

      retryTimer = setTimeout(() => {

        server.close();
        server.listen(port);
      }, 5000);

      return;
    }

    nvr.log.error("The M3U playlist publisher encountered an error and has stopped: %s.", formatErrorMessage(error));
    server.close();
  });

  // Let users know we're up and running.
  server.on("listening", () => {

    nvr.log.info("Publishing an M3U playlist of Protect camera livestream URLs on port %s.", port);
  });

  // Tear the server down on plugin shutdown (a SHUTDOWN that is not a process exit would otherwise leak the port) and cancel any pending EADDRINUSE retry. onAbort is
  // homebridge-plugin-utils' SSOT for this: it registers the one-shot teardown AND runs it inline if the signal is ALREADY aborted - the pre-aborted case servePlaylist
  // genuinely hits, since it runs from async login() which can race a SHUTDOWN. Pairing onAbort with clearing the retry handle means no path re-listens or leaks a timer
  // after abort.
  onAbort(nvr.signal, () => {

    if(retryTimer) {

      clearTimeout(retryTimer);
    }

    server.close();
  });

  // If we were already shutting down, onAbort just tore the (never-listened) server down inline above; do not listen. homebridge-plugin-utils sanctions this onAbort +
  // if-aborted-return pairing; server.close() on a never-listened server is a safe no-op.
  if(nvr.signal.aborted) {

    return;
  }

  // Listen on the port we've configured.
  server.listen(port);
}
