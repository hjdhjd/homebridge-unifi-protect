/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * nvr-playlist.ts: The M3U playlist service for UniFi Protect camera livestreams.
 *
 * This module owns the controller's optional M3U playlist publisher, split along the policy/mechanism boundary into two exported functions. buildPlaylist is the
 * pure content decision - the SSOT of what the playlist contains (the header, the codec/RTSP filter, the name sort, the per-camera #EXTINF guide block, the plain-RTSP
 * URL line, and the package-camera entry) - composed server-free as a string so the whole format and ordering surface is exhaustively unit-testable with constructed
 * camera configs and no TCP port. servePlaylist is the thin I/O shell, and the shell itself is homebridge-plugin-utils' HttpListener: the listener owns the bind, the
 * port-in-use retry, the request body read, the teardown on the controller's lifetime signal, and every lifecycle line under its label, while this module owns the
 * port, the one catch-all route, the body that route answers, and the empty-catalog line.
 *
 * The leaf references the controller (ProtectNvr) by TYPE only and is constructed by no one - servePlaylist(nvr) is invoked from the NVR's login() through an
 * already-held reference, so this module adds no value-import edge to nvr.ts and the device/controller value-import graph stays a cycle-free DAG.
 */
import { HTTP_LISTENER_ANY_PATH, HttpListener } from "homebridge-plugin-utils";
import { isPackageChannel, rtspUrl } from "../media/resolution.ts";
import type { Nullable } from "homebridge-plugin-utils";
import { PROTECT_M3U_PLAYLIST_PORT } from "../settings.ts";
import type { ProtectCameraConfig } from "unifi-protect";
import type { ProtectNvr } from "./nvr.ts";
import { describeDeviceModel } from "../devices/device-descriptor.ts";
import util from "node:util";

// Compose the M3U playlist body for the supplied camera configs. Pure string composition - host and rtspPort are read from the live NVR projection by the caller and
// passed in, so this function does no I/O and is exhaustively testable. We publish only cameras that are not AV1 (HomeKit/app codec compatibility) and that have at
// least one RTSP-enabled channel, sorted by name so the catalog is stable across reads. Each entry is a guide-annotated #EXTINF block followed by the plain-RTSP URL
// (rtsp://, not the secure rtsps:// stream) because many consuming apps (e.g. Channels DVR) only speak plain RTSP.
export function buildPlaylist(cameras: readonly ProtectCameraConfig[], host: string, rtspPort: number): string {

  // We accumulate each piece of the playlist into an array and join once, avoiding intermediate I/O until the full body is composed.
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
        name, describeDeviceModel(camera), description));

      // The placeholder value of 86400 is one day in seconds. Guide-consuming apps such as Channels DVR use it as the duration of the placeholder guide entry for this
      // livestream, since a live camera feed has no fixed program schedule to describe.
      parts.push(util.format("tvc-guide-art=\"%s\" tvc-guide-placeholders=\"86400\" tvc-guide-tags=\"HD, Live, New, UniFi Protect\", %s\n",
        "https://raw.githubusercontent.com/hjdhjd/homebridge-unifi-protect/main/images/homebridge-unifi-protect-4x3.png", name));

      // The channel was already selected by the caller (the primary channel, or the package channel). We emit its plain rtsp:// URL rather than the secure rtsps://
      // stream, since many consuming apps only support plain RTSP and we prioritize maximizing compatibility here.
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

/* Publish an M3U playlist of Protect camera livestreams over HTTP. This is the thin I/O shell around buildPlaylist, built on homebridge-plugin-utils' HttpListener,
 * which binds the port, retries it on the platform clock while another process holds it, reads each request's body, tears itself down when the controller's lifetime
 * signal fires, and logs every lifecycle line under its label. We own the port, the one catch-all route, the body it answers, and the empty-catalog line. The listener
 * is returned so a caller can read its bound port, or null when the controller is already shutting down.
 */
export function servePlaylist(nvr: ProtectNvr): Nullable<HttpListener> {

  const port = nvr.getFeatureNumber("Nvr.Service.Playlist") ?? PROTECT_M3U_PLAYLIST_PORT;

  // A controller that is already shutting down publishes nothing. We check before constructing the listener because a listener whose lifetime has ended refuses a
  // route, and that refusal would throw into the controller's login.
  if(nvr.signal.aborted) {

    return null;
  }

  let listener: HttpListener;

  /* The listener refuses a port outside 0 to 65535 at construction, the one refusal the options we hand it can raise. We report it in our own words, naming the
   * setting a user can correct, and answer null so the controller's startup continues without its playlist. Any other throw is a defect and propagates.
   */
  try {

    listener = new HttpListener({ clock: nvr.platform.clock, label: "M3U playlist publisher", log: nvr.log, port: port, signal: nvr.signal });
  } catch(error) {

    if(!(error instanceof TypeError)) {

      throw error;
    }

    nvr.log.error("Unable to publish the M3U playlist. The configured port must be a whole number from 0 to 65535.");

    return null;
  }

  // The once-per-run latch for the empty-catalog narration, so a player polling the playlist does not fill the log with the same line.
  let warnedEmptyPlaylist = false;

  // Answer every path and method with the playlist, reading the host, the RTSP port, and the camera list from the live NVR projection at request time.
  listener.route(HTTP_LISTENER_ANY_PATH, () => {

    const body = buildPlaylist(nvr.client.cameras.map(projection => projection.config), nvr.ufp.host, nvr.ufp.ports.rtsp);

    // A body equal to the bare header is the emptiness signal: the composer above emits that header and then nothing when no camera qualifies, so comparing against it
    // keeps the pure composer untouched and leaves no second eligibility predicate here to drift out of step with the real one. The compared literal is the header
    // buildPlaylist emits, so the two travel together. The message names both eligibility terms, so an all-AV1 fleet is not misread as an RTSP problem.
    if(!warnedEmptyPlaylist && (body === "#EXTM3U\n")) {

      warnedEmptyPlaylist = true;
      nvr.log.info("The M3U playlist has no cameras available to publish. " +
        "The playlist carries cameras that have at least one RTSP-enabled channel and do not stream AV1.");
    }

    // Set the right MIME type for M3U playlists.
    return { body: body, headers: { "Content-Type": "application/x-mpegURL" }, status: 200 };
  });

  return listener;
}
