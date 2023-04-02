/* Copyright(C) 2017-2023, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-platform.ts: homebridge-unifi-protect platform class.
 */
import { API, APIEvent, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig } from "homebridge";
import { PROTECT_FFMPEG_OPTIONS, PROTECT_MOTION_DURATION, PROTECT_MQTT_TOPIC, PROTECT_RING_DURATION } from "./settings.js";
import { ProtectNvrOptions, ProtectOptions } from "./protect-options.js";
import { ProtectNvr } from "./protect-nvr.js";
import { RtpPortAllocator } from "./protect-rtp.js";
import { execFile } from "node:child_process";
import ffmpegPath from "ffmpeg-for-homebridge";
import util from "node:util";

export class ProtectPlatform implements DynamicPlatformPlugin {

  public accessories: PlatformAccessory[];
  public readonly api: API;
  public readonly config!: ProtectOptions;
  public readonly configOptions: string[];
  private readonly controllers: ProtectNvr[];
  public readonly log: Logging;
  public readonly rtpPorts: RtpPortAllocator;
  public verboseFfmpeg: boolean;
  private videoProcessorEncoders: { [index: string]: string[] };

  constructor(log: Logging, config: PlatformConfig, api: API) {

    this.accessories = [];
    this.api = api;
    this.configOptions = [];
    this.controllers = [];
    this.log = log;
    this.rtpPorts = new RtpPortAllocator();
    this.verboseFfmpeg = false;
    this.videoProcessorEncoders = {};

    // We can't start without being configured.
    if(!config) {

      return;
    }

    // Plugin options into our config variables.
    this.config = {

      controllers: config.controllers as ProtectNvrOptions[],
      debugAll: config.debug as boolean === true,
      ffmpegOptions: config.ffmpegOptions as string[] ?? PROTECT_FFMPEG_OPTIONS,
      motionDuration: config.motionDuration as number ?? PROTECT_MOTION_DURATION,
      options: config.options as string[],
      ringDuration: config.ringDuration as number ?? PROTECT_RING_DURATION,
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

      // MQTT topic to use.
      if(!controllerConfig.mqttTopic) {

        controllerConfig.mqttTopic = PROTECT_MQTT_TOPIC;
      }

      this.controllers.push(new ProtectNvr(this, controllerConfig));
    }

    // Avoid a prospective race condition by waiting to configure our controllers until Homebridge is done
    // loading all the cached accessories it knows about, and calling configureAccessory() on each.
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    api.on(APIEvent.DID_FINISH_LAUNCHING, this.launchControllers.bind(this));
  }

  // This gets called when homebridge restores cached accessories at startup. We
  // intentionally avoid doing anything significant here, and save all that logic
  // for device discovery.
  public configureAccessory(accessory: PlatformAccessory): void {

    // Add this to the accessory array so we can track it.
    this.accessories.push(accessory);
  }

  // Launch our configured controllers once all accessories have been loaded. Once we do, they will sustain themselves.
  private async launchControllers(): Promise<void> {

    // First things first - ensure we've got a working video processor before we do anything else.
    if(!(await this.probeVideoProcessorCodecs())) {

      return;
    }

    // Iterate through all our controllers and startup.
    for(const controller of this.controllers) {

      // Login to the Protect controller.
      void controller.ufpApi.login(controller.nvrOptions.address, controller.nvrOptions.username, controller.nvrOptions.password);
    }
  }

  // Probe our video processor's encoding and decoding capabilities.
  private async probeVideoProcessorCodecs(): Promise<boolean> {

    try {

      // Promisify exec to allow us to wait for it asynchronously.
      const execAsync = util.promisify(execFile);

      // Check for the codecs in our video processor.
      const { stdout } = await execAsync(this.config.videoProcessor, [ "hide_banner", "-codecs" ]);

      // A regular expression to parse out the codec and it's supported encoders.
      const encodersRegex = /(\S+)\s(\S*)\s+\(.*encoders: (.*?)\s*\)/;

      // Iterate through each line, and a build a list of encoders.
      for(const codecLine of stdout.split("\n")) {

        // Let's see if we have encoders.
        const encodersMatch = encodersRegex.exec(codecLine);

        // No encoders found, keep going.
        if(!encodersMatch) {

          continue;
        }

        // Add the codec and supported encoders to our list of supported encoders.
        this.videoProcessorEncoders[encodersMatch[2]] = encodersMatch[3].split(" ");
      }

      return true;
    } catch(error) {

      // It's really a SystemError, but Node hides that type from us for esoteric reasons.
      if(error instanceof Error) {

        interface SystemError {
          cmd: string,
          code: string,
          errno: number,
          path: string,
          spawnargs: string[],
          stderr: string,
          stdout: string,
          syscall: string
        }

        const execError = error as unknown as SystemError;

        if(execError.code === "ENOENT") {

          this.log.error("Unable to find FFmpeg at: '%s'. Please make sure that you have a working version of FFmpeg installed in order to use this plugin.",
            execError.path);

        } else {

          this.log.error("Error running FFmpeg: %s", error.message);
        }
      }

      this.log.error("Unable to complete plugin startup without a working version of FFmpeg.");
      return false;
    }
  }

  // Utility to determine whether or not a specific encoder is available to the video processor for a given codec.
  public isEncoderAvailable(codec: string, encoder: string): boolean {

    // Normalize our lookups.
    codec = codec.toLowerCase();
    encoder = encoder.toLowerCase();

    return this.videoProcessorEncoders[codec]?.some(x => x === encoder);
  }

  // Utility for debug logging.
  public debug(message: string, ...parameters: unknown[]): void {

    if(this.config.debugAll) {

      this.log.info(util.format(message, ...parameters));
    }
  }
}
