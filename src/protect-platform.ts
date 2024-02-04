/* Copyright(C) 2017-2023, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-platform.ts: homebridge-unifi-protect platform class.
 */
import { API, APIEvent, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig } from "homebridge";
import { PROTECT_FFMPEG_OPTIONS, PROTECT_MQTT_TOPIC } from "./settings.js";
import { ProtectNvrOptions, ProtectOptions, featureOptionCategories, featureOptions } from "./protect-options.js";
import { FfmpegCodecs } from "./protect-ffmpeg-codecs.js";
import { ProtectNvr } from "./protect-nvr.js";
import { RtpPortAllocator } from "./protect-rtp.js";
import ffmpegPath from "ffmpeg-for-homebridge";
import os from "node:os";
import { platform } from "node:process";
import { readFileSync } from "node:fs";
import util from "node:util";

export class ProtectPlatform implements DynamicPlatformPlugin {

  public accessories: PlatformAccessory[];
  public readonly api: API;
  public readonly codecSupport!: FfmpegCodecs;
  public readonly config!: ProtectOptions;
  private readonly controllers: ProtectNvr[];
  private featureOptionDefaults: { [index: string]: boolean };
  public readonly featureOptions: string[];
  public readonly log: Logging;
  public readonly rtpPorts: RtpPortAllocator;
  private _hostSystem: string;
  public verboseFfmpeg: boolean;

  constructor(log: Logging, config: PlatformConfig, api: API) {

    this._hostSystem = "";
    this.accessories = [];
    this.api = api;
    this.controllers = [];
    this.featureOptionDefaults = {};
    this.featureOptions = [];
    this.log = log;
    this.rtpPorts = new RtpPortAllocator();
    this.verboseFfmpeg = false;

    // We can't start without being configured.
    if(!config) {

      return;
    }

    // Plugin options into our config variables.
    this.config = {

      controllers: config.controllers as ProtectNvrOptions[],
      debugAll: config.debug as boolean === true,
      ffmpegOptions: config.ffmpegOptions as string[] ?? PROTECT_FFMPEG_OPTIONS,
      options: config.options as string[],
      ringDelay: config.ringDelay as number ?? 0,
      verboseFfmpeg: config.verboseFfmpeg === true,
      videoEncoder: config.videoEncoder as string,
      videoProcessor: config.videoProcessor as string ?? ffmpegPath ?? "ffmpeg"
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

    // Build our list of default values for our feature options.
    for(const category of featureOptionCategories) {

      for(const options of featureOptions[category.name]) {

        this.featureOptionDefaults[(category.name + (options.name.length ? "." + options.name : "")).toLowerCase()] = options.default;
      }
    }

    // If we have feature options, put them into their own array, lower-cased for future reference.
    if(this.config.options) {

      for(const featureOption of this.config.options) {

        this.featureOptions.push(featureOption.toLowerCase());
      }
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
      if(!controllerConfig.mqttTopic) {

        controllerConfig.mqttTopic = PROTECT_MQTT_TOPIC;
      }

      this.controllers.push(new ProtectNvr(this, controllerConfig));
    }

    // Identify what we're running on so we can take advantage of hardware-specific features.
    this.probeHwOs();

    // Probe our FFmpeg capabilities.
    this.codecSupport = new FfmpegCodecs(this);

    // Avoid a prospective race condition by waiting to configure our controllers until Homebridge is done loading all the cached accessories it knows about, and calling
    // configureAccessory() on each.
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    api.on(APIEvent.DID_FINISH_LAUNCHING, this.launchControllers.bind(this));
  }

  // This gets called when homebridge restores cached accessories at startup. We intentionally avoid doing anything significant here, and save all that logic
  // for device discovery.
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

  // Identify what hardware and operating system environment we're actually running on.
  private probeHwOs(): void {

    // Start off with a generic identifier.
    this._hostSystem = "generic";

    // Take a look at the platform we're on for an initial hint of what we are.
    switch(platform) {

      // The beloved macOS.
      case "darwin":

        this._hostSystem = "macOS." + (os.cpus()[0].model.includes("Apple") ? "Apple" : "Intel");

        break;

      // The indomitable Linux.
      case "linux":

        // Let's further see if we're a small, but scrappy, Raspberry Pi.
        try {

          // As of the 4.9 kernel, Raspberry Pi prefers to be identified using this method and has deprecated cpuinfo.
          const systemId = readFileSync("/sys/firmware/devicetree/base/model", { encoding: "utf8" });

          // Is it a Pi 4?
          if(/Raspberry Pi (Compute Module )?4/.test(systemId)) {

            this._hostSystem = "raspbian";
          }
        } catch(error) {

          // We aren't especially concerned with errors here, given we're just trying to ascertain the system information through hints.
        }

        break;

      default:

        // We aren't trying to solve for every system type.
        break;
    }
  }

  // Utility to return the hardware environment we're on.
  public get hostSystem(): string {

    return this._hostSystem;
  }

  // Utility to return the default value for a feature option.
  public featureOptionDefault(option: string): boolean {

    const defaultValue = this.featureOptionDefaults[option.toLowerCase()];

    // If it's a feature that's unknown to us, assume it's false.
    if(defaultValue === undefined) {

      return false;
    }

    return defaultValue;
  }

  // Utility for debug logging.
  public debug(message: string, ...parameters: unknown[]): void {

    if(this.config.debugAll) {

      this.log.info(util.format(message, ...parameters));
    }
  }
}
