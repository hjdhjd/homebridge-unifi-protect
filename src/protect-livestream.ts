/* Copyright(C) 2019-2024, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-livestream.ts: Protect livestream API manager.
 */
import { PROTECT_HKSV_SEGMENT_RESOLUTION } from "./settings.js";
import { ProtectCamera } from "./devices/index.js";
import { ProtectLivestream } from "unifi-protect";
import { retry } from "homebridge-plugin-utils";

export class LivestreamManager {

  private livestreams: { [index: string]: ProtectLivestream };
  private protectCamera: ProtectCamera;
  private subscriberCount: { [index: string]: number };

  // Create an instance.
  constructor(protectCamera: ProtectCamera) {

    this.protectCamera = protectCamera;
    this.subscriberCount = {};
    this.livestreams = {};
  }

  // Utility to return an index into our livestream connection pool.
  private getIndex(channel: number, lens?: number): string {

    return channel.toString() + ((lens !== undefined) ? "." + lens.toString() : "");
  }

  // Retrieve a connection to the livestream API for a given channel.
  public acquire(channel: number, lens?: number): ProtectLivestream {

    const index = this.getIndex(channel, lens);

    // Let's see if we have an existing livestream already open and reuse it if we can.
    if(this.livestreams[index]) {

      return this.livestreams[index];
    }

    // Create a new livestream instance.
    this.subscriberCount[index] = 0;

    return this.livestreams[index] = this.protectCamera.nvr.ufpApi.createLivestream();
  }

  // Access the livestream API, registering as a consumer.
  public async start(channel: number, lens?: number, segmentLength = PROTECT_HKSV_SEGMENT_RESOLUTION): Promise<boolean> {

    const index = this.getIndex(channel, lens);

    // If we don't have a livestream configured for this channel, we're done. We could just create it here, but given we listen to events on livestream listeners, this
    // is a safer option to ensure that we've acquired a livestream endpoint before trying to start it.
    if(!this.livestreams[index]) {

      return false;
    }

    // Start the livestream if this is the first run. We set this to reattempt establishing the livestream up to three times due to occasional controller glitches.
    if(!this.subscriberCount[index] && !(await retry(async () => this.livestreams[index].start(this.protectCamera.ufp.id, channel, lens, segmentLength,
      this.protectCamera.name + ":" + index), 1000, 3))) {

      this.protectCamera.log.error("Unable to access the Protect livestream API: this is typically due to the Protect controller or camera rebooting.");

      await this.protectCamera.nvr.resetNvrConnection();

      // Something went wrong in communicating with the controller.
      return false;
    }

    // Increment our consumer count.
    this.subscriberCount[index]++;

    return true;
  }

  // End a livestream API connection once all the consumers of the livestream are done.
  public stop(channel: number, lens?: number): void {

    const index = this.getIndex(channel, lens);

    // If we have open livestreams, we'll won't close the livestream.
    if(--this.subscriberCount[index] > 0) {

      return;
    }

    // End our livestream API connection.
    this.livestreams[index].stop();
    this.subscriberCount[index] = 0;
  }
}
