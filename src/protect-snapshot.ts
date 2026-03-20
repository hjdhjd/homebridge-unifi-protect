/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-snapshot.ts: UniFi Protect HomeKit snapshot class.
 */
import type { API, HAP, SnapshotRequest } from "homebridge";
import { FfmpegExec, type HomebridgePluginLogging, type Nullable, runWithTimeout } from "homebridge-plugin-utils";
import { PROTECT_LIVESTREAM_API_IDR_INTERVAL, PROTECT_SNAPSHOT_CACHE_MAXAGE } from "./settings.js";
import type { ProtectCamera } from "./devices/index.js";
import type { ProtectNvr } from "./protect-nvr.js";
import type { ProtectPlatform } from "./protect-platform.js";

// Camera snapshot class for Protect.
export class ProtectSnapshot {

  private _cachedSnapshot: Nullable<{ image: Buffer; time: number }>;
  private _snapshotInFlight: Nullable<Promise<Nullable<Buffer>>>;
  private readonly api: API;
  private readonly hap: HAP;
  public readonly log: HomebridgePluginLogging;
  private readonly nvr: ProtectNvr;
  public readonly platform: ProtectPlatform;
  public readonly protectCamera: ProtectCamera;

  // Create an instance of a HomeKit streaming delegate.
  constructor(protectCamera: ProtectCamera) {

    this.api = protectCamera.api;
    this.hap = protectCamera.api.hap;
    this.log = protectCamera.log;
    this.nvr = protectCamera.nvr;
    this.protectCamera = protectCamera;
    this.platform = protectCamera.platform;
    this._cachedSnapshot = null;
    this._snapshotInFlight = null;
  }

  // Return a snapshot for use by HomeKit. Concurrent requests for the same camera are coalesced into a single acquisition to avoid spawning duplicate FFmpeg pipelines.
  public async getSnapshot(request?: SnapshotRequest): Promise<Nullable<Buffer>> {

    // If we aren't connected, we're done.
    if(!this.protectCamera.ufpApi.bootstrap || this.protectCamera.ufpApi.isThrottled || !this.protectCamera.isOnline) {

      return null;
    }

    // If there's already a snapshot acquisition in flight for this camera, share its result rather than spawning a duplicate pipeline. This commonly occurs with
    // multi-hub setups or when HomeKit and MQTT request snapshots simultaneously.
    if(this._snapshotInFlight) {

      return this._snapshotInFlight;
    }

    // Create the acquisition promise and store it for coalescing. The finally block clears the reference once the promise settles, so subsequent requests after this
    // one completes will trigger a fresh acquisition.
    this._snapshotInFlight = this.acquireSnapshot(request);

    try {

      return await this._snapshotInFlight;
    } finally {

      this._snapshotInFlight = null;
    }
  }

  // Acquire a snapshot by trying each source in priority order, applying crop if needed, and falling back to the cache on timeout.
  private async acquireSnapshot(request?: SnapshotRequest): Promise<Nullable<Buffer>> {

    // See if we have an image cached that we can use, if needed.
    const cachedSnapshot = this.cachedSnapshot;

    // We request the snapshot to prioritize performance and quality of the image. The reason for this is that the Protect API constrains the quality level of snapshot
    // images and doesn't always produce them reliably. Fortunately, we have a few options. We retrieve snapshots by trying to use the following sources, in order:
    //
    // - Timeshift buffer   eliminates querying the Protect controller and allows us to capture the highest quality image we can.
    // - RTSP stream        queries the Protect controller, but allows us to capture the highest quality image available.
    // - Protect API        requests a snapshot from the Protect controller. This is an error-prone task for the Protect controller and produces lower quality images.
    // - Cached snapshot    returns the last snapshot we have taken, assuming it isn't too old.
    //
    // The exception to this is package cameras - we try the Protect API before the RTSP stream there because the lower frame rate of the camera causes a lengthier
    // response time.
    const snapshotPromise = (async (): Promise<Nullable<Buffer>> => {

      let snapAttempt = await this.snapFromTimeshift(request);
      let needsExternalCrop = false;

      // No snapshot yet, let's try again.
      if(!snapAttempt) {

        // We treat package cameras uniquely - the Protect API is tried before RTSP because the lower frame rate of package cameras causes a lengthier RTSP response.
        if("packageCamera" in this.protectCamera.accessory.context) {

          snapAttempt = await this.nvr.ufpApi.getSnapshot(this.protectCamera.ufp, { height: request?.height, usePackageCamera: true, width: request?.width });

          if(snapAttempt) {

            needsExternalCrop = true;
          } else {

            snapAttempt = await this.snapFromRtsp(request);
          }
        } else {

          snapAttempt = await this.snapFromRtsp(request);

          if(!snapAttempt) {

            snapAttempt = await this.nvr.ufpApi.getSnapshot(this.protectCamera.ufp, { height: request?.height, width: request?.width });

            if(snapAttempt) {

              needsExternalCrop = true;
            }
          }
        }
      }

      if(!snapAttempt) {

        return null;
      }

      // Snapshots from the Protect API need a standalone crop pass since they bypass the FFmpeg pipeline where crop is now integrated into the filter chain.
      if(needsExternalCrop && this.protectCamera.hints.crop) {

        snapAttempt = await this.cropSnapshot(snapAttempt) ?? snapAttempt;
      }

      // Cache the image before returning it.
      this._cachedSnapshot = { image: snapAttempt, time: Date.now() };

      return snapAttempt;
    })();

    // Get a snapshot, but ensure we constrain it so we can return in a responsive manner.
    const snapshot = await runWithTimeout(snapshotPromise, 4990);

    // Occasional snapshot failures will happen. The controller isn't always able to generate them if one is already inflight or if it's too soon after the last one.
    if(!snapshot) {

      if(cachedSnapshot) {

        this.log.warn("Unable to retrieve a snapshot: using the most recent cached snapshot instead.");

        return cachedSnapshot;
      }

      this.log.error("Unable to retrieve a snapshot.");

      return null;
    }

    return this._cachedSnapshot?.image ?? null;
  }

  // Snapshots using the timeshift buffer as the source.
  private async snapFromTimeshift(request?: SnapshotRequest): Promise<Nullable<Buffer>> {

    // If we aren't generating high resolution snapshots, we're done.
    if(!this.protectCamera.stream || !this.protectCamera.hints.highResSnapshots) {

      return null;
    }

    // Try the keyframe cache first for a minimal buffer (init segment + single keyframe fragment), falling back to the full timeshift window if no keyframe has been
    // detected yet or the cache is stale.
    const buffer = this.protectCamera.stream.hksv?.timeshift.getLastKeyframe() ??
      this.protectCamera.stream.hksv?.timeshift.getLast(PROTECT_LIVESTREAM_API_IDR_INTERVAL * 1000);

    if(!buffer) {

      return null;
    }

    // Use our timeshift buffer to create a snapshot image. Options we use are:
    //
    // -r fps                     Set the input frame rate for the video stream.
    // -probesize number          How many bytes should be analyzed for stream information.
    // -f mp4                     Specify that our input will be an MP4 file.
    // -i pipe:0                  Read input from standard input.
    const ffmpegOptions = [

      "-r", this.protectCamera.stream.hksv?.rtspEntry?.channel.fps.toString() ?? "30",
      "-probesize", buffer.length.toString(),
      "-f", "mp4",
      "-i", "pipe:0"
    ];

    return this.snapFromFfmpeg(ffmpegOptions, request, buffer);
  }

  // Snapshots using the Protect RTSP endpoints as the source.
  private async snapFromRtsp(request?: SnapshotRequest): Promise<Nullable<Buffer>> {

    // If we aren't generating high resolution snapshots, we're done.
    if(!this.protectCamera.stream || !this.protectCamera.hints.highResSnapshots) {

      return null;
    }

    // Grab the highest quality stream we have available.
    const rtspEntry = this.protectCamera.findRtsp(3840, 2160, { biasHigher: true });

    if(!rtspEntry) {

      return null;
    }

    // Use the RTSP stream to generate a snapshot image. Options we use are:
    //
    // -avioflags direct          Tell FFmpeg to minimize buffering to reduce latency for more realtime processing.
    // -r fps                     Set the input frame rate for the video stream.
    // -probesize number          How many bytes should be analyzed for stream information.
    // -rtsp_transport tcp        Tell the RTSP stream handler that we're looking for a TCP connection.
    // -i rtspEntry.url           RTSPS URL to get our input stream from.
    const ffmpegOptions = [

      "-avioflags", "direct",
      "-r", rtspEntry.channel.fps.toString(),
      "-probesize", this.protectCamera.stream.probesize.toString(),
      "-rtsp_transport", "tcp",
      "-i", rtspEntry.url
    ];

    return this.snapFromFfmpeg(ffmpegOptions, request);
  }

  // Generate a snapshot using FFmpeg.
  private async snapFromFfmpeg(ffmpegInputOptions: string[], request?: SnapshotRequest, buffer?: Buffer): Promise<Nullable<Buffer>> {

    if(!this.protectCamera.stream) {

      return null;
    }

    // Options we use to generate an image based on our MP4 input are:
    //
    // -hide_banner         Suppress printing the startup banner in FFmpeg.
    // -nostats             Suppress printing progress reports while encoding in FFmpeg.
    // -fflags flags        Set the format flags to generate a presentation timestamp if it's missing and discard any corrupt packets rather than exit.
    // -max_delay 500000    Set an upper limit on how much time FFmpeg can take in demuxing packets.
    // -flags low_delay     Tell FFmpeg to optimize for low delay / realtime decoding.
    // -skip_frame          Only decode and process I-frames to ensure we always get a complete image when taking a snapshot.
    // -fps_mode vfr        Ensure we deal with any variable frame rates that might occur.
    // -frames:v 1          Extract a single video frame for the output.
    // -q:v 2               Set the quality output of the JPEG output.
    const decoderOptions = this.protectCamera.stream.ffmpegOptions.videoDecoder(this.protectCamera.ufp.videoCodec);

    const commandLineOptions = [

      "-hide_banner",
      "-nostats",
      "-fflags", "+discardcorrupt+genpts",
      ...decoderOptions,
      "-max_delay", "500000",
      "-flags", "low_delay",
      "-skip_frame", "nointra",
      ...ffmpegInputOptions,
      "-fps_mode", "vfr",
      "-frames:v", "1",
      "-q:v", "2"
    ];

    // Build the video filter chain. We assemble it as an array of individual filters and join them with commas. When cropping is enabled, we apply it before scaling so
    // the crop coordinates (which use relative iw/ih multipliers) operate on the source resolution, and the subsequent scale+pad fits the cropped region into HomeKit's
    // requested dimensions.
    const filters: string[] = [];

    // If hardware decoding produces GPU-resident frames, we need to transfer them to system memory before any CPU-based filters can operate on them.
    filters.push(...this.protectCamera.stream.ffmpegOptions.hardwareDownloadFilters);

    // Apply the crop filter if configured. The crop coordinates use relative iw/ih multipliers, making them resolution-independent and safe to apply at any point in the
    // filter chain. We place it before scale so the aspect ratio calculations in scale+pad reflect the cropped region rather than the full frame.
    if(this.protectCamera.hints.crop) {

      filters.push(this.protectCamera.stream.ffmpegOptions.cropFilter);
    }

    // Scale to the requested dimensions, preserving the aspect ratio and letterboxing where needed.
    if(request) {

      filters.push(

        [ "scale=" + request.width.toString(), request.height.toString(), "force_original_aspect_ratio=decrease" ].join(":"),
        [ "pad=" + request.width.toString(), request.height.toString(), "(ow-iw)/2", "(oh-ih)/2" ].join(":")
      );
    }

    // Apply the filter chain if we have any filters.
    if(filters.length) {

      commandLineOptions.push("-filter:v", filters.join(","));
    }

    // -f image2pipe        Specifies the output format to use a pipe, since we are outputting to stdout and want to consume the data directly.
    // -c:v mjpeg           Specify the MJPEG encoder to get a JPEG file.
    // pipe:1               Output the snapshot to standard output.
    commandLineOptions.push(

      "-f", "image2pipe",
      "-c:v", "mjpeg",
      "pipe:1"
    );

    // Enable verbose logging, if we're debugging.
    if(this.protectCamera.hasFeature("Debug.Video.Snapshot")) {

      commandLineOptions.unshift("-loglevel", "level+verbose");
    }

    // Instantiate FFmpeg.
    const ffmpeg = new FfmpegExec(this.protectCamera.stream.ffmpegOptions, commandLineOptions, false);

    // Retrieve the snapshot.
    const ffmpegResult = await ffmpeg.exec(buffer);

    // We're done. If we produced an empty image, we couldn't utilize the output.
    if(ffmpegResult?.exitCode === 0) {

      return ffmpegResult.stdout.length ? ffmpegResult.stdout : null;
    }

    return null;
  }

  // Image snapshot crop handler for Protect API snapshots. The input is a JPEG image, so we use minimal FFmpeg options - the hardware video decoder flags and stream
  // analysis options used in snapFromFfmpeg are unnecessary here since FFmpeg natively decodes JPEG without hardware assistance.
  private async cropSnapshot(snapshot: Buffer): Promise<Nullable<Buffer>> {

    if(!this.protectCamera.stream) {

      return null;
    }

    // Crop the snapshot using FFmpeg with the crop filter. Options we use are:
    //
    // -hide_banner         Suppress printing the startup banner in FFmpeg.
    // -nostats             Suppress printing progress reports while encoding in FFmpeg.
    // -i pipe:0            Read input from standard input.
    // -filter:v            Pass the crop filter options to FFmpeg.
    // -f image2pipe        Specifies the output format to use a pipe, since we are outputting to stdout and want to consume the data directly.
    // -c:v mjpeg           Specify the MJPEG encoder to get a JPEG file.
    // pipe:1               Output the cropped snapshot to standard output.
    const ffmpeg = new FfmpegExec(this.protectCamera.stream.ffmpegOptions, [

      "-hide_banner",
      "-nostats",
      "-i", "pipe:0",
      "-filter:v", this.protectCamera.stream.ffmpegOptions.cropFilter,
      "-f", "image2pipe",
      "-c:v", "mjpeg",
      "pipe:1"
    ]);

    // Retrieve the snapshot.
    const ffmpegResult = await ffmpeg.exec(snapshot);

    // Crop succeeded, we're done.
    if(ffmpegResult?.exitCode === 0) {

      return ffmpegResult.stdout;
    }

    // Something went wrong.
    this.log.error("Unable to crop snapshot.");

    return null;
  }

  // Retrieve a cached snapshot, if available.
  private get cachedSnapshot(): Nullable<Buffer> {

    // If we have an image from the last few seconds, we can use it. Otherwise, we're done.
    if(!this._cachedSnapshot || ((Date.now() - this._cachedSnapshot.time) > (PROTECT_SNAPSHOT_CACHE_MAXAGE * 1000))) {

      this._cachedSnapshot = null;

      return null;
    }

    return this._cachedSnapshot.image;
  }
}
