/* Copyright(C) 2017-2020, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-platform.ts: homebridge-unifi-protect2 platform class.
 */
import {
  API,
  APIEvent,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig
} from "homebridge";
import { ProtectNvr } from "./protect-nvr";
import { ProtectNvrOptions, ProtectOptions } from "./protect-types";
import { PROTECT_FFMPEG_OPTIONS, PROTECT_MOTION_DURATION } from "./settings";
import util from "util";

export class ProtectPlatform implements DynamicPlatformPlugin {
  accessories: PlatformAccessory[] = [];
  debugMode = false;
  readonly log: Logging;
  readonly api: API;
  readonly config: ProtectOptions;
  readonly configOptions: string[] = [];
  private readonly controllers: ProtectNvr[] = [];

  constructor(log: Logging, config: PlatformConfig, api: API) {
    this.api = api;

    // Force this to ProtectOptions.
    this.config = config as any;
    this.log = log;

    // We can't start without being configured.
    if(!config) {
      return;
    }

    // We need a UniFi Protect controller configured to do anything.
    if(!config.controllers) {
      this.log("No UniFi Protect controllers have been configured.");
      return;
    }

    // Capture configuration parameters.
    if(config.debug) {
      this.debugMode = config.debug === true;
      this.debug("Debug logging on. Expect a lot of data.");
    }

    // If we have feature options, put them into their own array, upper-cased for future use.
    if(config.options) {
      config.options.forEach((featureOption: string) => {
        this.configOptions.push(featureOption.toUpperCase());
      });
    }

    // Motion detection duration. Make sure it's never less than 2 seconds so we can actually alert the user.
    if(!config.ffmpegOptions) {
      config.ffmpegOptions = PROTECT_FFMPEG_OPTIONS;
    }

    // Motion detection duration. Make sure it's never less than 2 seconds so we can actually alert the user.
    if(config.motionDuration) {
      if(config.motionDuration < 2 ) {
        config.motionDuration = 2;
      }
    } else {
      config.motionDuration = PROTECT_MOTION_DURATION;
    }

    // Loop through each configured NVR and instantiate them.
    config.controllers.forEach((nvrOptions: ProtectNvrOptions) => {

      // We need an address, or there's nothing to do.
      if(!nvrOptions.address) {
        this.log("No host or IP address has been configured. Unable to start.");
        return;
      }

      // We need login credentials or we're skipping this one.
      if(!nvrOptions.username || !nvrOptions.password) {
        this.log("No UniFi Protect login credentials have been configured. Unable to start");
        return;
      }

      // NVR device list refresh interval. Make sure it's never less than 2 seconds so we don't overwhelm the Protect NVR.
      if(nvrOptions.refreshInterval) {
        if(nvrOptions.refreshInterval < 2 ) {
          nvrOptions.refreshInterval = 2;
        }
      }

      this.controllers.push(new ProtectNvr(this, nvrOptions));
    });

    // This event gets fired after homebridge has restored all cached accessories and called their respective
    // `configureAccessory` function.
    //
    // Fire off our polling, and let's get the party started.
    api.on(APIEvent.DID_FINISH_LAUNCHING, this.pollControllers.bind(this));
  }

  // This gets called when homebridge restores cached accessories at startup. We
  // intentionally avoid doing anything significant here, and save all that logic
  // for device discovery.
  configureAccessory(accessory: PlatformAccessory): void {
    // Delete the UniFi Protect camera pointer on startup. This will be set by device discovery.
    // Notably, we do NOT clear out the NVR pointer, because we need to maintain the mapping between
    // camera and NVR.
    delete accessory.context.camera;

    // Add this to the accessory array so we can track it.
    this.accessories.push(accessory);
  }

  // Launch our configured controllers. Once we do, they can sustain themselves.
  private pollControllers() {

    this.controllers.forEach((nvr: ProtectNvr) => {
      nvr.poll(0);
    });
  }

  // Utility for debug logging.
  debug(message: string, ...parameters: any[]) {
    if(this.debugMode) {
      this.log(util.format(message, ...parameters));
    }
  }
}
