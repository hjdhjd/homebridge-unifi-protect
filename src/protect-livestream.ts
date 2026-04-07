/* Copyright(C) 2019-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-livestream.ts: Protect livestream API manager.
 */
import { FfmpegLivestreamProcess, sleep } from "homebridge-plugin-utils";
import { PROTECT_SEGMENT_RESOLUTION } from "./settings.js";
import type { ProtectCamera } from "./devices/index.js";
import type { ProtectLivestream } from "unifi-protect";
import type { RtspEntry } from "./devices/protect-camera.js";

const LIVESTREAM_OPTIONS = { chunkSize: 16384, emitTimestamps: true };
const LIVESTREAM_RESTART_INTERVAL = 10;
const LIVESTREAM_TIMEOUT = 2000;

export class LivestreamManager {

  private channels: Record<string, number>;
  private eventHandlers: Record<string, () => void>;
  private lastSegmentTime: Record<string, number>;
  private lenses: Record<string, number | undefined>;
  private livestreams: Record<string, FfmpegLivestreamProcess | ProtectLivestream>;
  private protectCamera: ProtectCamera;
  private restartCount: Record<string, number>;
  private restartDelay: Record<string, number>;
  private restarting: Record<string, boolean>;
  private segmentLengths: Record<string, number>;
  private subscriberCount: Record<string, number>;
  private segmentTimer: Record<string, NodeJS.Timeout>;
  private startTime: Record<string, number>;

  // Create an instance.
  constructor(protectCamera: ProtectCamera) {

    this.channels = {};
    this.eventHandlers = {};
    this.lastSegmentTime = {};
    this.lenses = {};
    this.livestreams = {};
    this.protectCamera = protectCamera;
    this.restartCount = {};
    this.restartDelay = {};
    this.restarting = {};
    this.segmentLengths = {};
    this.segmentTimer = {};
    this.startTime = {};
    this.subscriberCount = {};
  }

  // Utility to return an index into our livestream connection pool.
  private getIndex(rtspEntry: RtspEntry): { channel: number; index: string; lens: number | undefined } {

    // If we're using a secondary lens, the channel must always be 0 when using the livestream API.
    const channel = (rtspEntry.lens === undefined) ? rtspEntry.channel.id : 0;
    const lens = rtspEntry.lens;

    return { channel: channel, index: channel.toString() + ((lens !== undefined) ? "." + lens.toString() : ""), lens: lens };
  }

  // Retrieve a connection to the livestream API for a given channel.
  public acquire(rtspEntry: RtspEntry): FfmpegLivestreamProcess | ProtectLivestream {

    const { index } = this.getIndex(rtspEntry);

    // Let's see if we have an existing livestream already open and reuse it if we can.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if(this.livestreams[index]) {

      return this.livestreams[index];
    }

    // Create a new livestream instance.
    this.subscriberCount[index] = 0;

    if(this.protectCamera.hasFeature("Debug.Video.HKSV.UseRtsp") && this.protectCamera.stream?.hksv?.recordingConfiguration) {

      return this.livestreams[index] = new FfmpegLivestreamProcess(this.protectCamera.stream.ffmpegOptions, this.protectCamera.stream.hksv.recordingConfiguration,
        { codec: this.protectCamera.ufp.videoCodec, enableAudio: this.protectCamera.stream.hksv.isAudioActive, url: rtspEntry.url });
    }

    return this.livestreams[index] = this.protectCamera.nvr.ufpApi.createLivestream();
  }

  // Restarting status.
  public isRestarting(rtspEntry: RtspEntry): boolean {

    return this.restarting[this.getIndex(rtspEntry).index];
  }

  // Restart the livestream for the given RTSP entry. We use this when something goes wrong downstream of the livestream, such as an FFmpeg timeout during HKSV
  // recording...the connection itself may be fine, but we need a fresh one to recover.
  public restart(rtspEntry: RtspEntry): void {

    const { index } = this.getIndex(rtspEntry);

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if(this.livestreams[index]) {

      void this.restartLivestream(index, true);
    }
  }

  // Restart the livestream connection, tearing down the current session and establishing a fresh one. Both the stall detection timer and the public restart() method come
  // through here...when isExternal is true, it means something downstream failed (not the connection itself), so we skip backoff and self-healing.
  private async restartLivestream(index: string, isExternal: boolean, retryRestart = false): Promise<void> {

    // If there are no subscribers, this connection has no purpose...a subscriber called stop() while a restart was in flight. Clean up and walk away.
    if(!this.subscriberCount[index]) {

      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if(this.segmentTimer[index]) {

        clearTimeout(this.segmentTimer[index]);
      }

      this.restarting[index] = false;

      return;
    }

    // If we have a restart inflight and this restart trigger isn't internally triggered, we're done.
    if(this.restarting[index] && !retryRestart) {

      return;
    }

    this.restarting[index] = true;

    // Clear out any existing timer.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if(this.segmentTimer[index]) {

      clearTimeout(this.segmentTimer[index]);
    }

    this.livestreams[index].stop();

    // If either the controller is offline/throttled or the camera isn't connected, let's retry again in a minute.
    if(!this.protectCamera.ufpApi.bootstrap || this.protectCamera.ufpApi.isThrottled || !this.protectCamera.isOnline) {

      this.segmentTimer[index] = setTimeout(() => void this.restartLivestream(index, false, true), 60 * 1000);

      return;
    }

    // Self-healing: if we've had too many consecutive restarts from stalls, reboot the camera. We don't count external restarts here because those are downstream
    // failures, not camera problems.
    if(!isExternal && this.protectCamera.hasFeature("Device.SelfHealing") && (++this.restartCount[index] > 10)) {

      this.restartCount[index] = 0;
      this.protectCamera.log.warn("Restarting the camera to reset its connection to the livestream API.");

      // Restart now.
      const response = await this.protectCamera.nvr.ufpApi.retrieve(this.protectCamera.nvr.ufpApi.getApiEndpoint(this.protectCamera.ufp.modelKey) + "/" +
        this.protectCamera.ufp.id + "/reboot", { body: JSON.stringify({}), method: "POST" });

      if(!this.protectCamera.nvr.ufpApi.responseOk(response?.statusCode)) {

        this.protectCamera.log.error("Unable to restart the camera.");

        this.segmentTimer[index] = setTimeout(() => void this.restartLivestream(index, false, true), 60 * 1000);

        return;
      }
    }

    const streamType = this.protectCamera.hasFeature("Debug.Video.HKSV.UseRtsp") ? "RTSP stream" : "livestream API";

    if(isExternal) {

      this.protectCamera.log.warn("Restarting the %s to recover from a recording failure.", streamType);
    } else {

      const elapsed = (this.protectCamera.hasFeature("Debug.Video.HKSV.Telemetry") && this.lastSegmentTime[index]) ?
        parseFloat(((Date.now() - this.lastSegmentTime[index]) / 1000).toFixed(1)).toString() : "";

      if(this.restartDelay[index]) {

        this.protectCamera.log.warn("Retrying %s connection%s.", streamType, elapsed ? " (last segment " + elapsed + "s ago)" : "");
      } else {

        this.protectCamera.log.warn("Reconnecting to the %s%s.", streamType, elapsed ? " after a " + elapsed + "s stall" : "");
      }
    }

    // On the first restart attempt after a healthy period, reconnect immediately to maximize our chances of staying within the HKSV timeout
    // window. We only apply a backoff delay on subsequent attempts to account for persistent controller or camera issues.
    if(this.restartDelay[index]) {

      await sleep((((Math.random() * 3) + this.restartDelay[index]) * 1000));
    }

    const channel = this.channels[index];
    const lens = this.lenses[index];
    const segmentLength = this.segmentLengths[index];

    if(this.protectCamera.hasFeature("Debug.Video.HKSV.UseRtsp")) {

      (this.livestreams[index] as FfmpegLivestreamProcess).segmentLength = segmentLength;
      (this.livestreams[index] as FfmpegLivestreamProcess).start();
    } else if(!(await (this.livestreams[index] as ProtectLivestream).start(this.protectCamera.ufp.id, channel,
      { ...LIVESTREAM_OPTIONS, lens, requestId: this.protectCamera.name + ":" + index, segmentLength }))) {

      // The controller couldn't provide a livestream endpoint...same class of failure as being offline. We defer the retry and let the next attempt go through the full
      // restart path with its own backoff and logging.
      this.segmentTimer[index] = setTimeout(() => void this.restartLivestream(index, false, true), 60 * 1000);

      return;
    }

    this.startTime[index] = Date.now();

    // Check on the state of our livestream API session regularly.
    this.segmentTimer[index] = setTimeout(() => void this.restartLivestream(index, false), LIVESTREAM_TIMEOUT);

    // Increase our backoff interval in case we've got a stuck livestream websocket on the Protect controller or the camera is offline. We only increase the backoff
    // for stall restarts...external restarts don't mean the connection is unstable.
    if(!isExternal) {

      this.restartDelay[index] = Math.min(this.restartDelay[index] + (LIVESTREAM_RESTART_INTERVAL / 2), LIVESTREAM_RESTART_INTERVAL * 3);
    }

    // We're done with this restart attempt.
    this.restarting[index] = false;
  }

  // Shutdown all our connections.
  public shutdown(): void {

    // Cleanup all the listeners and shutdown our livestreams.
    for(const timer of Object.values(this.segmentTimer)) {

      clearTimeout(timer);
    }

    for(const livestream of Object.values(this.livestreams)) {

      livestream.removeAllListeners();
      livestream.stop();
    }

    this.channels = {};
    this.eventHandlers = {};
    this.lastSegmentTime = {};
    this.lenses = {};
    this.livestreams = {};
    this.restartCount = {};
    this.restartDelay = {};
    this.restarting = {};
    this.segmentLengths = {};
    this.segmentTimer = {};
    this.startTime = {};
    this.subscriberCount = {};
  }

  // Access the livestream API, registering as a consumer.
  public async start(rtspEntry: RtspEntry, segmentLength = PROTECT_SEGMENT_RESOLUTION): Promise<boolean> {

    const { channel, index, lens } = this.getIndex(rtspEntry);

    // If we don't have a livestream configured for this channel, we're done. We could just create it here, but given we listen to events on livestream listeners, this
    // is a safer option to ensure that we've acquired a livestream endpoint before trying to start it.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if(!this.livestreams[index]) {

      return false;
    }

    // Start the livestream if this is our first subscriber for this channel.
    if(!this.subscriberCount[index]) {

      if(this.protectCamera.hasFeature("Debug.Video.HKSV.UseRtsp")) {

        (this.livestreams[index] as FfmpegLivestreamProcess).segmentLength = segmentLength;
        (this.livestreams[index] as FfmpegLivestreamProcess).start();
      } else if(!(await (this.livestreams[index] as ProtectLivestream).start(this.protectCamera.ufp.id, channel,
        { ...LIVESTREAM_OPTIONS, lens, requestId: this.protectCamera.name + ":" + index, segmentLength }))) {

        this.protectCamera.log.error("Unable to access the Protect livestream API: this is typically due to the Protect controller or camera rebooting.");

        // Something went wrong in communicating with the controller.
        return false;
      }
    }

    // Keep track of any issues in the livestream.
    if(!this.subscriberCount[index]) {

      this.channels[index] = channel;
      this.lenses[index] = lens;
      this.restartCount[index] = 0;
      this.restartDelay[index] = 0;
      this.restarting[index] = false;
      this.segmentLengths[index] = segmentLength;
      this.startTime[index] = Date.now();

      // Set a regular heartbeat for the livestream API.
      this.livestreams[index].on("segment", this.eventHandlers[index] = (): void => {

        // Track when we last received a segment so we can measure stall durations when restarts occur.
        this.lastSegmentTime[index] = Date.now();

        // If a restart is in progress, the restart handler owns the timer lifecycle...we don't want late segments from an old connection creating orphaned timers
        // that interfere with the new connection.
        if(this.restarting[index]) {

          return;
        }

        // Clear out any existing timer.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if(this.segmentTimer[index]) {

          clearTimeout(this.segmentTimer[index]);

          // Make sure we've got a good livestream before we reset our delay.
          if((Date.now() - this.startTime[index]) > (60 * 1000)) {

            this.restartCount[index] = 0;
            this.restartDelay[index] = 0;
          }
        }

        // Check on the state of our livestream API session regularly.
        this.segmentTimer[index] = setTimeout(() => void this.restartLivestream(index, false), LIVESTREAM_TIMEOUT);
      });

    }

    // Increment our consumer count.
    this.subscriberCount[index]++;

    return true;
  }

  // End a livestream API connection once all the consumers of the livestream are done.
  public stop(rtspEntry: RtspEntry): void {

    const { index } = this.getIndex(rtspEntry);

    // If we have open livestreams, we don't want to close the livestream session.
    if(--this.subscriberCount[index] > 0) {

      return;
    }

    // End our livestream API connection.
    this.livestreams[index].stop();

    // Cleanup our listeners.
    this.livestreams[index].off("segment", this.eventHandlers[index]);

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if(this.segmentTimer[index]) {

      clearTimeout(this.segmentTimer[index]);
    }

    this.subscriberCount[index] = 0;
  }
}
