/* Copyright(C) 2017-2025, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-platform.ts: homebridge-unifi-protect platform class.
 */
import type { API, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig } from "homebridge";
import { FeatureOptions, FfmpegCodecs, RtpPortAllocator } from "homebridge-plugin-utils";
import { type ProtectOptions, featureOptionCategories, featureOptions } from "./protect-options.js";
import { APIEvent } from "homebridge";
import { PROTECT_MQTT_TOPIC } from "./settings.js";
import { ProtectNvr } from "./protect-nvr.js";
import ffmpegPath from "ffmpeg-for-homebridge";
import util from "node:util";

export class ProtectPlatform implements DynamicPlatformPlugin {

  public accessories: PlatformAccessory[];
  public readonly api: API;
  public readonly codecSupport!: FfmpegCodecs;
  public readonly config: ProtectOptions;
  private readonly controllers: ProtectNvr[];
  public readonly featureOptions: FeatureOptions;
  public readonly log: Logging;
  public readonly rtpPorts: RtpPortAllocator;
  public verboseFfmpeg: boolean;

  constructor(log: Logging, config: PlatformConfig | undefined, api: API) {

    this.accessories = [];
    this.api = api;
    this.controllers = [];
    this.featureOptions = new FeatureOptions(featureOptionCategories, featureOptions, config?.options ?? []);
    this.log = log;
    this.rtpPorts = new RtpPortAllocator();
    this.verboseFfmpeg = false;

    // Plugin options into our config variables.
    this.config = {

      controllers: config?.controllers ?? [],
      debugAll: config?.debug === true,
      options: config?.options ?? [],
      ringDelay: config?.ringDelay ?? 0,
      verboseFfmpeg: config?.verboseFfmpeg === true,
      videoProcessor: config?.videoProcessor ?? ffmpegPath ?? "ffmpeg"
    };

    // We need a UniFi Protect controller configured to do anything.
    if(!this.config.controllers.length) {

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

      // MQTT topic to use.
      controllerConfig.mqttTopic ||= PROTECT_MQTT_TOPIC;

      this.controllers.push(new ProtectNvr(this, controllerConfig));
    }

    // Probe our FFmpeg capabilities.
    this.codecSupport = new FfmpegCodecs({ ffmpegExec: this.config.videoProcessor, log: this.log, verbose: this.verboseFfmpeg });

    // Avoid a prospective race condition by waiting to configure our controllers until Homebridge is done loading all the cached accessories it knows about, and calling
    // configureAccessory() on each.
    api.on(APIEvent.DID_FINISH_LAUNCHING, this.launchControllers.bind(this));
  }

  // This gets called when homebridge restores cached accessories at startup. We intentionally avoid doing anything significant here, and save it for device discovery.
  public configureAccessory(accessory: PlatformAccessory): void {

    // Add this to the accessory array so we can track it.
    this.accessories.push(accessory);
  }

  // Launch our configured controllers once all accessories have been loaded. Once we do, they will sustain themselves.
  private async launchControllers(): Promise<void> {

    // First things first - ensure we've got a working video processor before we do anything else.
    if(!(await this.codecSupport.probe())) {

      return;
    }

    // Iterate through all our controllers and startup.
    for(const controller of this.controllers) {

      // Login to the Protect controller.
      void controller.login();
    }
  }

  // Utility for debug logging.
  public debug(message: string, ...parameters: unknown[]): void {

    if(this.config.debugAll) {

      this.log.warn(util.format(message, ...parameters));
    }
  }
}
