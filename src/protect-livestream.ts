/* Copyright(C) 2019-2024, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-livestream.ts: Protect livestream API manager.
 */
import { PROTECT_HKSV_SEGMENT_RESOLUTION } from "./settings.js";
import { ProtectCamera } from "./devices/index.js";
import { ProtectLivestream } from "unifi-protect";
import { sleep } from "homebridge-plugin-utils";

const LIVESTREAM_TIMEOUT = 3500;

export class LivestreamManager {

  private eventHandlers: { [index: string]: () => void };
  private livestreams: { [index: string]: ProtectLivestream };
  private protectCamera: ProtectCamera;
  private subscriberCount: { [index: string]: number };
  private segmentTimers: { [index: string]: NodeJS.Timeout };

  // Create an instance.
  constructor(protectCamera: ProtectCamera) {

    this.eventHandlers = {};
    this.livestreams = {};
    this.protectCamera = protectCamera;
    this.segmentTimers = {};
    this.subscriberCount = {};
  }

  // Utility to return an index into our livestream connection pool.
  private getIndex(channel: number, lens?: number): { channel: number, index: string, lens: number | undefined } {

    // If we're using a secondary lens, the channel must always be 0 when using the livestream API.
    if(lens !== undefined) {

      channel = 0;
    }

    return { channel: channel, index: channel.toString() + ((lens !== undefined) ? "." + lens.toString() : ""), lens: lens };
  }

  // Retrieve a connection to the livestream API for a given channel.
  public acquire(channel: number, lens?: number): ProtectLivestream {

    const { index } = this.getIndex(channel, lens);

    // Let's see if we have an existing livestream already open and reuse it if we can.
    if(this.livestreams[index]) {

      return this.livestreams[index];
    }

    // Create a new livestream instance.
    this.subscriberCount[index] = 0;

    return this.livestreams[index] = this.protectCamera.nvr.ufpApi.createLivestream();
  }

  // Shutdown all our connections.
  public shutdown(): void {

    // Cleanup all the listeners and shutdown our livestreams.
    Object.values(this.segmentTimers).map(timer => clearTimeout(timer));
    Object.values(this.livestreams).map(livestream => livestream.removeAllListeners() && livestream.stop());

    this.eventHandlers = {};
    this.livestreams = {};
    this.segmentTimers = {};
    this.subscriberCount = {};
  }

  // Access the livestream API, registering as a consumer.
  public async start(channel: number, lens?: number, segmentLength = PROTECT_HKSV_SEGMENT_RESOLUTION): Promise<boolean> {

    let index;

    ({ channel, index, lens } = this.getIndex(channel, lens));

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

      let isRestarting = false;

      // Configure a restart event for the livestream API session so we can restart the session in case of problems.
      this.livestreams[index].on("restart", this.eventHandlers[index + ".restart"] = async (): Promise<void> => {

        // If we have a restart inflight, we're done.
        if(isRestarting) {

          return;
        }

        isRestarting = true;
        this.protectCamera.log.warn("Reconnecting to the livestream API.");

        // Clear out any existing timer.
        if(this.segmentTimers[index]) {

          clearTimeout(this.segmentTimers[index]);
        }

        this.livestreams[index].stop();

        // Wait at least a full minute before we try to reconnect to the livestream. This accounts for reboots and other potential connection issues that can occur.
        await sleep((((Math.random() * 10) + 60) * 1000));
        await this.livestreams[index].start(this.protectCamera.ufp.id, channel, lens, segmentLength, this.protectCamera.name + ":" + index);

        // Check on the state of our livestream API session regularly.
        this.segmentTimers[index] = setTimeout(() => this.livestreams[index].emit("restart"), LIVESTREAM_TIMEOUT);
        isRestarting = false;
      });

      // Set a regular heartbeat for the livestream API.
      this.livestreams[index].on("segment", this.eventHandlers[index] = (): void => {

        // Clear out any existing timer.
        if(this.segmentTimers[index]) {

          clearTimeout(this.segmentTimers[index]);
        }

        // Check on the state of our livestream API session regularly.
        this.segmentTimers[index] = setTimeout(() => this.livestreams[index].emit("restart"), LIVESTREAM_TIMEOUT);
      });

      // Set an initial timer in case we have an issue with the livestream API at startup.
      this.segmentTimers[index] = setTimeout(() => this.livestreams[index].emit("restart"), LIVESTREAM_TIMEOUT);
    }

    // Increment our consumer count.
    this.subscriberCount[index]++;

    return true;
  }

  // End a livestream API connection once all the consumers of the livestream are done.
  public stop(channel: number, lens?: number): void {

    const { index } = this.getIndex(channel, lens);

    // If we have open livestreams, we don't want to close the livestream session.
    if(--this.subscriberCount[index] > 0) {

      return;
    }

    // End our livestream API connection.
    this.livestreams[index].stop();

    // Cleanup our listeners.
    this.livestreams[index].off("restart", this.eventHandlers[index + ".restart"]);
    this.livestreams[index].off("segment", this.eventHandlers[index]);

    if(this.segmentTimers[index]) {

      clearTimeout(this.segmentTimers[index]);
    }

    this.subscriberCount[index] = 0;
  }
}
