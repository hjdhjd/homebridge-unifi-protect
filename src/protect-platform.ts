/* Copyright(C) 2017-2022, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-platform.ts: homebridge-unifi-protect platform class.
 */
import {
  API,
  APIEvent,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig
} from "homebridge";
import {
  PROTECT_FFMPEG_OPTIONS,
  PROTECT_HKSV_SEGMENT_RESOLUTION,
  PROTECT_MOTION_DURATION,
  PROTECT_MQTT_TOPIC,
  PROTECT_RING_DURATION
} from "./settings";
import { ProtectNvrOptions, ProtectOptions } from "./protect-options";
import { ProtectNvr } from "./protect-nvr";
import util from "util";

export class ProtectPlatform implements DynamicPlatformPlugin {
  public accessories: PlatformAccessory[];
  public readonly api: API;
  public readonly config!: ProtectOptions;
  public readonly configOptions: string[];
  private readonly controllers: ProtectNvr[];
  public readonly log: Logging;
  public verboseFfmpeg: boolean;

  constructor(log: Logging, config: PlatformConfig, api: API) {

    this.accessories = [];
    this.api = api;
    this.configOptions = [];
    this.controllers = [];
    this.verboseFfmpeg = false;
    this.log = log;

    // We can't start without being configured.
    if(!config) {

      return;
    }

    // Plugin options into our config variables.
    this.config = {
      controllers: config.controllers as ProtectNvrOptions[],
      debugAll: config.debug as boolean === true,
      ffmpegOptions: config.ffmpegOptions as string[] ?? PROTECT_FFMPEG_OPTIONS,
      hksvSegmentResolution: config.hksvSegmentResolution as number ?? PROTECT_HKSV_SEGMENT_RESOLUTION,
      motionDuration: config.motionDuration as number ?? PROTECT_MOTION_DURATION,
      options: config.options as string[],
      ringDuration: config.ringDuration as number ?? PROTECT_RING_DURATION,
      verboseFfmpeg: config.verboseFfmpeg === true,
      videoEncoder: config.videoEncoder as string,
      videoProcessor: config.videoProcessor as string
    };

    // We need a UniFi Protect controller configured to do anything.
    if(!this.config.controllers) {
      this.log.info("No UniFi Protect controllers have been configured.");
      return;
    }

    // Debugging - most people shouldn't enable this.
    this.debug("Debug logging on. Expect a lot of data.");

    // Debug FFmpeg.
    if(this.config.verboseFfmpeg) {
      this.verboseFfmpeg = true;
      this.log.info("Verbose logging of video streaming sessions enabled. Expect a lot of data.");
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

    // Ring trigger duration. Make sure it's never less than 3 seconds so we can ensure automations work.
    if(this.config.ringDuration < 3 ) {
      this.config.ringDuration = 3;
    }

    // Loop through each configured NVR and instantiate it.
    for(const controllerConfig of this.config.controllers) {

      // We need an address, or there's nothing to do.
      if(!controllerConfig.address) {
        this.log.info("No host or IP address has been configured.");
        continue;
      }

      // We need login credentials or we're skipping this one.
      if(!controllerConfig.username || !controllerConfig.password) {
        this.log.info("No UniFi Protect login credentials have been configured.");
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

    // Delete the UniFi Protect device pointer on startup. This will be set by device discovery.
    // Notably, we do NOT clear out the NVR pointer, because we need to maintain the mapping between
    // camera and NVR.
    delete accessory.context.device;

    // Add this to the accessory array so we can track it.
    this.accessories.push(accessory);
  }

  // Launch our configured controllers. Once we do, they will sustain themselves.
  private pollControllers(): void {

    for(const controller of this.controllers) {
      void controller.poll();
    }
  }

  // Utility for debug logging.
  public debug(message: string, ...parameters: unknown[]): void {

    if(this.config.debugAll) {
      this.log.info(util.format(message, ...parameters));
    }
  }
}
