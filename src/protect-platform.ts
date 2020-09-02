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
import { PROTECT_FFMPEG_OPTIONS, PROTECT_MOTION_DURATION, PROTECT_MQTT_TOPIC } from "./settings";
import util from "util";

export class ProtectPlatform implements DynamicPlatformPlugin {
  public accessories: PlatformAccessory[];
  public readonly api: API;
  public readonly config!: ProtectOptions;
  public readonly configOptions: string[];
  private readonly controllers: ProtectNvr[];
  public debugMode: boolean;
  public readonly log: Logging;
  public verboseFfmpeg: boolean;

  constructor(log: Logging, config: PlatformConfig, api: API) {
    this.accessories = [];
    this.api = api;
    this.configOptions = [];
    this.controllers = [];
    this.debugMode = false;
    this.verboseFfmpeg = false;
    this.log = log;

    // We can't start without being configured.
    if(!config) {
      return;
    }

    // Plugin options into our config variables.
    this.config = {
      controllers: config.controllers as ProtectNvrOptions[],
      debugAll: config.debug === true,
      ffmpegOptions: config.ffmpegOptions as string ?? PROTECT_FFMPEG_OPTIONS,
      motionDuration: config.motionDuration as number ?? PROTECT_MOTION_DURATION,
      options: config.options as string[],
      verboseFfmpeg: config.verboseFfmpeg === true,
      videoProcessor: config.videoProcessor as string
    };

    // We need a UniFi Protect controller configured to do anything.
    if(!this.config.controllers) {
      this.log("No UniFi Protect controllers have been configured.");
      return;
    }

    // Debugging - most people shouldn't enable this.
    if(this.config.debugAll) {
      this.debugMode = true;
      this.debug("Debug logging on. Expect a lot of data.");
    }

    // Debug FFmpeg.
    if(this.config.verboseFfmpeg) {
      this.verboseFfmpeg = true;
    }

    // If we have feature options, put them into their own array, upper-cased for future reference.
    if(this.config.options) {
      for(const featureOption of this.config.options) {
        this.configOptions.push(featureOption.toUpperCase());
      }
    }

    // Motion detection duration. Make sure it's never less than 2 seconds so we can actually alert the user.
    if(this.config.motionDuration < 2 ) {
      this.config.motionDuration = 2;
    }

    // Loop through each configured NVR and instantiate it.
    for(const controllerConfig of this.config.controllers) {

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
  public configureAccessory(accessory: PlatformAccessory): void {

    // Delete the UniFi Protect camera pointer on startup. This will be set by device discovery.
    // Notably, we do NOT clear out the NVR pointer, because we need to maintain the mapping between
    // camera and NVR.
    delete accessory.context.camera;

    // Add this to the accessory array so we can track it.
    this.accessories.push(accessory);
  }

  // Launch our configured controllers. Once we do, they will sustain themselves.
  private pollControllers(): void {

    for(const controller of this.controllers) {
      void controller.poll(0);
    }
  }

  // Utility for debug logging.
  public debug(message: string, ...parameters: unknown[]): void {
    if(this.debugMode) {
      this.log(util.format(message, ...parameters));
    }
  }
}
