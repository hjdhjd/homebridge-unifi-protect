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
import { ProtectOptions } from "./protect-types";
import { PROTECT_FFMPEG_OPTIONS, PROTECT_MOTION_DURATION, PROTECT_MQTT_TOPIC } from "./settings";
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

    // If we have feature options, put them into their own array, upper-cased for future reference.
    if(config.options) {
      for(const featureOption of config.options) {
        this.configOptions.push(featureOption.toUpperCase());
      }
    }

    // Additional ffmpeg options, in case the user wants to override the defaults. This option may be removed in a future release.
    if(!config.ffmpegOptions) {
      config.ffmpegOptions = PROTECT_FFMPEG_OPTIONS;
    }

    if(!config.motionDuration) {
      config.motionDuration = PROTECT_MOTION_DURATION;
    }

    // Motion detection duration. Make sure it's never less than 2 seconds so we can actually alert the user.
    if(config.motionDuration < 2 ) {
      config.motionDuration = 2;
    }

    // Loop through each configured NVR and instantiate it.
    for(const controllerConfig of config.controllers) {

      // We need an address, or there's nothing to do.
      if(!controllerConfig.address) {
        this.log("No host or IP address has been configured.");
        continue;
      }

      // We need login credentials or we're skipping this one.
      if(!controllerConfig.username || !controllerConfig.password) {
        this.log("No UniFi Protect login credentials have been configured.");
        continue;
      }

      // Controller device list refresh interval. Make sure it's never less than 2 seconds so we don't overwhelm the Protect controller.
      if(controllerConfig.refreshInterval < 2) {
        controllerConfig.refreshInterval = 2;
      }

      // MQTT topic to use.
      if(!controllerConfig.mqttTopic) {
        controllerConfig.mqttTopic = PROTECT_MQTT_TOPIC;
      }

      this.controllers.push(new ProtectNvr(this, controllerConfig));
    }

    // Avoid a prospective race condition by waiting to configure our controllers until Homebridge is done
    // loading all the cached accessories it knows about, and calling configureAccessory() on each.
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

    for(const controller of this.controllers) {
      controller.poll(0);
    }
  }

  // Utility for debug logging.
  debug(message: string, ...parameters: any[]) {
    if(this.debugMode) {
      this.log(util.format(message, ...parameters));
    }
  }
}
