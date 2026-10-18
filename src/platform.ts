/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * platform.ts: homebridge-unifi-protect platform class.
 */
import type { API, DynamicPlatformPlugin, Logging } from "homebridge";
import { APIEvent, FeatureOptions, FfmpegCodecs, RtpPortAllocator, debugGatedLog, livestreamProcessFactory, recordingProcessFactory,
  systemClock } from "homebridge-plugin-utils";
import type { Clock, HomebridgePluginLogging, LivestreamProcessFactory, Nullable, RecordingProcessFactory } from "homebridge-plugin-utils";
import type { ProtectAccessory, ProtectPlatformConfig } from "./types.ts";
import { featureOptionCategories, featureOptions } from "./options.ts";
import type { LegacyFeatureOptions } from "./options-legacy.ts";
import { ProtectNvr } from "./nvr/nvr.ts";
import type { ProtectOptions } from "./options.ts";
import type { StreamingDelegateFactory } from "./media/stream-delegate.ts";
import { analyzeLegacyFeatureOptions } from "./options-legacy.ts";
import ffmpegPath from "ffmpeg-for-homebridge";
import { streamingDelegateFactory } from "./media/stream.ts";

/* The form an address is compared in to tell whether two configured entries name one controller: surrounding space removed and letters lowercased. An address
 * that is absent, not a string, or empty once trimmed has no form and never repeats another. It is the settings page's listed-address form, so the page and the
 * plugin agree on which entry at an address is the first.
 */
function listingForm(address: unknown): Nullable<string> {

  if(typeof address !== "string") {

    return null;
  }

  const trimmed = address.trim();

  return trimmed.length ? trimmed.toLowerCase() : null;
}

// Whether a configured entry is an object, which an entry has to be before anything in it can be read. A hand edit can leave anything in the list, and the type the
// configuration is read through cannot say so, so the check takes the entry as unknown.
function isObject(entry: unknown): entry is object {

  return (typeof entry === "object") && (entry !== null);
}

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
  public readonly legacyOptions: LegacyFeatureOptions;
  public readonly livestreamProcessFactory: LivestreamProcessFactory;
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

    /* The configured options as the engine should see them. A configuration written for an earlier version of this plugin can name options the current catalog does not
     * declare, and several of those shapes are not merely stale - read through that catalog they decompose into values of the very options that supersede them. The
     * analysis rewrites each such shape into the current grammar before the engine is built, and reports which families still need the runtime overlay for their exact
     * historic meaning. The raw entries stay where they already live, on this.config.options, which is what the overlay reads.
     */
    const legacyOptions = analyzeLegacyFeatureOptions(config?.options ?? []);

    this.featureOptions = new FeatureOptions(featureOptionCategories, featureOptions, [...legacyOptions.engineOptions]);
    this.legacyOptions = legacyOptions;
    this.livestreamProcessFactory = livestreamProcessFactory;
    this.log = log;

    // Say once that a translation happened, and where the permanent fix is. It is a warning rather than an informational line because the translation is exact but
    // in-memory: the configuration on disk still speaks the older grammar until a settings save rewrites it.
    if(legacyOptions.translated.length) {

      this.log.warn("Feature option entries from an earlier version of this plugin were translated automatically at startup. Open the plugin settings in the " +
        "Homebridge UI to migrate your configuration permanently.", { entries: legacyOptions.translated });
    }

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

      // A hand edit can leave anything under controllers, and a value that is not a list names no controller at all.
      controllers: Array.isArray(config?.controllers) ? config.controllers : [],
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

    /* The first entry at each listed address, keyed by its listing form, and whether a later entry repeating it has been reported. A controller is reached by its
     * address, so the first entry at an address is the one we read, and every later entry there is skipped ahead of the checks below, with one warning per address
     * however many entries repeat it.
     */
    const firstEntries = new Map<string, { address: string; warned: boolean }>();

    // Loop through each configured NVR and instantiate it.
    for(const controllerConfig of this.config.controllers) {

      // An entry that is not an object carries nothing to start.
      if(!isObject(controllerConfig)) {

        continue;
      }

      const form = listingForm(controllerConfig.address);

      if(form !== null) {

        const first = firstEntries.get(form);

        if(first) {

          if(!first.warned) {

            first.warned = true;
            this.log.warn("The controller %s is listed more than once in the plugin configuration. Only its first entry is used. Saving that controller in the plugin " +
              "settings removes the extra entries.", first.address);
          }

          continue;
        }

        firstEntries.set(form, { address: controllerConfig.address, warned: false });
      }

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
    const codecs = await FfmpegCodecs.probe({ clock: this.clock, ffmpegExec: this.config.videoProcessor, log: this.log,
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
