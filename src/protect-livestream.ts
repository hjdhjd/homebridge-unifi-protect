/* Copyright(C) 2019-2025, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-livestream.ts: Protect livestream API manager.
 */
import { PROTECT_HKSV_SEGMENT_RESOLUTION } from "./settings.js";
import { ProtectCamera } from "./devices/index.js";
import { ProtectLivestream } from "unifi-protect";
import { RtspEntry } from "./devices/protect-camera.js";
import { sleep } from "homebridge-plugin-utils";

const LIVESTREAM_TIMEOUT = 3500;
const LIVESTREAM_RESTART_INTERVAL = 10;

export class LivestreamManager {

  private eventHandlers: { [index: string]: () => void };
  private livestreams: { [index: string]: ProtectLivestream };
  private protectCamera: ProtectCamera;
  private restartDelay: { [index: string]: number };
  private restarting: { [index: string]: boolean };
  private subscriberCount: { [index: string]: number };
  private segmentTimer: { [index: string]: NodeJS.Timeout };
  private startTime: { [index: string]: number };

  // Create an instance.
  constructor(protectCamera: ProtectCamera) {

    this.eventHandlers = {};
    this.livestreams = {};
    this.protectCamera = protectCamera;
    this.restartDelay = {};
    this.restarting = {};
    this.segmentTimer = {};
    this.startTime = {};
    this.subscriberCount = {};
  }

  // Utility to return an index into our livestream connection pool.
  private getIndex(rtspEntry: RtspEntry): { channel: number, index: string, lens: number | undefined } {

    // If we're using a secondary lens, the channel must always be 0 when using the livestream API.
    const channel = (rtspEntry.lens === undefined) ? rtspEntry.channel.id : 0;
    const lens = rtspEntry.lens;

    return { channel: channel, index: channel.toString() + ((lens !== undefined) ? "." + lens.toString() : ""), lens: lens };
  }

  // Retrieve a connection to the livestream API for a given channel.
  public acquire(rtspEntry: RtspEntry): ProtectLivestream {

    const { index } = this.getIndex(rtspEntry);

    // Let's see if we have an existing livestream already open and reuse it if we can.
    if(this.livestreams[index]) {

      return this.livestreams[index];
    }

    // Create a new livestream instance.
    this.subscriberCount[index] = 0;

    return this.livestreams[index] = this.protectCamera.nvr.ufpApi.createLivestream();
  }

  // Restarting status.
  public isRestarting(rtspEntry: RtspEntry): boolean {

    return this.restarting[this.getIndex(rtspEntry).index];
  }

  // Shutdown all our connections.
  public shutdown(): void {

    // Cleanup all the listeners and shutdown our livestreams.
    Object.values(this.segmentTimer).map(timer => clearTimeout(timer));
    Object.values(this.livestreams).map(livestream => livestream.removeAllListeners() && livestream.stop());

    this.eventHandlers = {};
    this.livestreams = {};
    this.restartDelay = {};
    this.restarting = {};
    this.segmentTimer = {};
    this.startTime = {};
    this.subscriberCount = {};
  }

  // Access the livestream API, registering as a consumer.
  public async start(rtspEntry: RtspEntry, segmentLength = PROTECT_HKSV_SEGMENT_RESOLUTION): Promise<boolean> {

    const { channel, index, lens } = this.getIndex(rtspEntry);

    // If we don't have a livestream configured for this channel, we're done. We could just create it here, but given we listen to events on livestream listeners, this
    // is a safer option to ensure that we've acquired a livestream endpoint before trying to start it.
    if(!this.livestreams[index]) {

      return false;
    }

    // Start the livestream if this is the first run. We set this to reattempt establishing the livestream up to three times due to occasional controller glitches.
    if(!this.subscriberCount[index] &&
      !(await this.livestreams[index].start(this.protectCamera.ufp.id, channel, lens, segmentLength, this.protectCamera.name + ":" + index))) {

      this.protectCamera.log.error("Unable to access the Protect livestream API: this is typically due to the Protect controller or camera rebooting.");

      // Something went wrong in communicating with the controller.
      return false;
    }

    // Keep track of any issues in the livestream.
    if(!this.subscriberCount[index]) {

      this.restartDelay[index] = LIVESTREAM_RESTART_INTERVAL;
      this.restarting[index] = false;
      this.startTime[index] = Date.now();

      // Configure a restart event for the livestream API session so we can restart the session in case of problems.
      this.livestreams[index].on("restart", this.eventHandlers[index + ".restart"] = async (retryRestart = false): Promise<void> => {

        // If we have a restart inflight and this restart trigger isn't internally triggered, we're done.
        if(this.restarting[index] && !retryRestart) {

          return;
        }

        this.restarting[index] = true;

        // Clear out any existing timer.
        if(this.segmentTimer[index]) {

          clearTimeout(this.segmentTimer[index]);
        }

        this.livestreams[index].stop();

        // If the camera isn't connected, let's retry again in a minute.
        if(!this.protectCamera.isOnline) {

          this.segmentTimer[index] = setTimeout(() => this.livestreams[index].emit("restart", true), 60 * 1000);

          return;
        }

        this.protectCamera.log.warn("Reconnecting to the livestream API.");

        // Wait before we try to reconnect to the livestream. This accounts for reboots and other potential connection issues that can occur.
        await sleep((((Math.random() * 3) + this.restartDelay[index]) * 1000));
        await this.livestreams[index].start(this.protectCamera.ufp.id, channel, lens, segmentLength, this.protectCamera.name + ":" + index);
        this.startTime[index] = Date.now();

        // Check on the state of our livestream API session regularly.
        this.segmentTimer[index] = setTimeout(() => this.livestreams[index].emit("restart"), LIVESTREAM_TIMEOUT);

        // Increase our backoff interval in case we've got a stuck livestream websocket on the Protect controller or the camera is offline.
        this.restartDelay[index] = Math.min(this.restartDelay[index] + (LIVESTREAM_RESTART_INTERVAL / 2), LIVESTREAM_RESTART_INTERVAL * 3);

        // We're done with this restart attempt.
        this.restarting[index] = false;
      });

      // Set a regular heartbeat for the livestream API.
      this.livestreams[index].on("segment", this.eventHandlers[index] = (): void => {

        // Clear out any existing timer.
        if(this.segmentTimer[index]) {

          clearTimeout(this.segmentTimer[index]);

          // Make sure we've got a good livestream before we reset our delay.
          if((Date.now() - this.startTime[index]) > (60 * 1000)) {

            this.restartDelay[index] = LIVESTREAM_RESTART_INTERVAL;
          }
        }

        // Check on the state of our livestream API session regularly.
        this.segmentTimer[index] = setTimeout(() => this.livestreams[index].emit("restart"), LIVESTREAM_TIMEOUT);
      });

      // Set an initial timer in case we have an issue with the livestream API at startup.
      this.segmentTimer[index] = setTimeout(() => this.livestreams[index].emit("restart"), LIVESTREAM_TIMEOUT);
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
    this.livestreams[index].off("restart", this.eventHandlers[index + ".restart"]);
    this.livestreams[index].off("segment", this.eventHandlers[index]);

    if(this.segmentTimer[index]) {

      clearTimeout(this.segmentTimer[index]);
    }

    this.subscriberCount[index] = 0;
  }
}
