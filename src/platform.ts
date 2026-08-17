/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * platform.ts: homebridge-unifi-protect platform class.
 */
import type { API, DynamicPlatformPlugin, Logging } from "homebridge";
import { APIEvent, FeatureOptions, FfmpegCodecs, RtpPortAllocator, debugGatedLog, recordingProcessFactory, systemClock } from "homebridge-plugin-utils";
import type { Clock, HomebridgePluginLogging, Nullable, RecordingProcessFactory } from "homebridge-plugin-utils";
import type { ProtectAccessory, ProtectPlatformConfig } from "./types.ts";
import { featureOptionCategories, featureOptions } from "./options.ts";
import { PROTECT_MQTT_TOPIC } from "./settings.ts";
import { ProtectNvr } from "./nvr/nvr.ts";
import type { ProtectOptions } from "./options.ts";
import type { StreamingDelegateFactory } from "./media/stream-delegate.ts";
import ffmpegPath from "ffmpeg-for-homebridge";
import { streamingDelegateFactory } from "./media/stream.ts";

// The Homebridge dynamic platform plugin for UniFi Protect. Owns FFmpeg capability detection, the RTP port allocator, and the per-controller ProtectNvr
// instances the plugin manages.
export class ProtectPlatform implements DynamicPlatformPlugin {

  public accessories: ProtectAccessory[];
  public readonly api: API;
  public readonly clock: Clock;
  private _codecSupport: Nullable<FfmpegCodecs> = null;
  public readonly config: ProtectOptions;
  private readonly controllers: ProtectNvr[];
  public readonly featureOptions: FeatureOptions;
  public readonly log: Logging;
  public readonly pluginLog: HomebridgePluginLogging;
  public readonly recordingProcessFactory: RecordingProcessFactory;
  public readonly rtpPorts: RtpPortAllocator;
  public readonly streamingDelegateFactory: StreamingDelegateFactory;

  constructor(log: Logging, config: ProtectPlatformConfig | undefined, api: API) {

    this.accessories = [];
    this.api = api;
    this.clock = systemClock;
    this.controllers = [];
    this.featureOptions = new FeatureOptions(featureOptionCategories, featureOptions, config?.options ?? []);
    this.log = log;

    // The plugin-side logging root. Debug is gated at global scope and emitted through warn; the other levels route to the Homebridge logger, which formats each
    // line once at the sink. Per-device and per-controller loggers derive from this root through prefixedLog with scope predicates of their own, so the sink wiring
    // lives here and nowhere else; this.log stays the raw Homebridge logger for direct platform-level output.
    this.pluginLog = debugGatedLog(this.log, () => this.testDebug({}));
    this.recordingProcessFactory = recordingProcessFactory;
    this.rtpPorts = new RtpPortAllocator();
    this.streamingDelegateFactory = streamingDelegateFactory;

    // The FFmpeg path, resolved from the feature option with the legacy configuration property as the transition fallback. An option that is enabled but left empty
    // counts as absent, so an emptied field falls through to the bundled build rather than launching an empty executable name.
    const ffmpegExec = this.featureOptions.value("Video.FFmpeg.Path");

    // Plugin options into our config variables.
    this.config = {

      controllers: config?.controllers ?? [],
      debugAll: config?.debug === true,
      options: config?.options ?? [],
      ringDelay: config?.ringDelay ?? 0,
      verboseFfmpeg: config?.verboseFfmpeg === true,
      videoProcessor: (ffmpegExec?.length ? ffmpegExec : undefined) ?? config?.videoProcessor ?? ffmpegPath ?? "ffmpeg"
    };

    // We need a UniFi Protect controller configured to do anything.
    if(!this.config.controllers.length) {

      this.log.info("No UniFi Protect controllers have been configured.");

      return;
    }

    // Debugging - most people shouldn't enable this.
    this.pluginLog.debug("Debug logging on. Expect a lot of data.");

    // Debug FFmpeg.
    if(this.config.verboseFfmpeg || this.featureOptions.test("Log.FFmpeg")) {

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

    // Avoid a prospective race condition by waiting to configure our controllers until Homebridge is done loading all the cached accessories it knows about, and calling
    // configureAccessory() on each.
    api.on(APIEvent.DID_FINISH_LAUNCHING, () => void this.launchControllers());
  }

  // The host's probed FFmpeg capabilities. Established exactly once, when launchControllers() completes a successful probe, and read-only thereafter. Every consumer
  // (streaming, recording, snapshots) runs only after a controller has logged in - which happens after the probe - so the value is always present by the time it is read;
  // the guard narrows the nullable backing and turns a would-be access-before-probe into a clear error rather than an undefined-property dereference.
  public get codecSupport(): FfmpegCodecs {

    if(!this._codecSupport) {

      throw new Error("The FFmpeg codec capabilities were accessed before they were probed.");
    }

    return this._codecSupport;
  }

  // This gets called when homebridge restores cached accessories at startup. We intentionally avoid doing anything significant here, and save it for device discovery.
  public configureAccessory(accessory: ProtectAccessory): void {

    // Add this to the accessory array so we can track it.
    this.accessories.push(accessory);
  }

  // Launch our configured controllers once all accessories have been loaded. Once we do, they will sustain themselves.
  private async launchControllers(): Promise<void> {

    // First things first - ensure we've got a working video processor before we do anything else. The probe runs the full FFmpeg capability detection and returns a
    // populated, immutable FfmpegCodecs value object on success, or null when probing fails. We run it without a cancellation signal: the platform has no shutdown
    // controller, and probing happens once at launch, before any controller is brought up.
    const codecs = await FfmpegCodecs.probe({ ffmpegExec: this.config.videoProcessor, log: this.log,
      verbose: this.featureOptions.test("Log.FFmpeg") || this.config.verboseFfmpeg });

    if(!codecs) {

      this.log.error("This plugin requires a working version of FFmpeg. " +
        "If you need to specify a path to your FFmpeg, you can do so under 'Settings | Additional Settings' in the plugin configuration webUI.");

      return;
    }

    this._codecSupport = codecs;

    // Iterate through all our controllers and startup.
    for(const controller of this.controllers) {

      // Login to the Protect controller.
      void controller.login();
    }
  }

  /* The one debug gate. Whether a debug line speaks is resolved per call at the caller's own scope - a device-suffixed Log.Debug entry turns on one camera, a
   * controller-suffixed entry one controller and everything it manages, a bare entry everything - with the hand-edited legacy debug property honored as the global
   * fallback. Emission belongs to the composed loggers, which route a gated debug line through warn rather than debug so plugin-level debug output stays visible
   * regardless of whether Homebridge itself runs with its own debug flag.
   */
  public testDebug(context: { controller?: string; device?: string }): boolean {

    return this.config.debugAll || this.featureOptions.test("Log.Debug", context.device, context.controller);
  }
}
