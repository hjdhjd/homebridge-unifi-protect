/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * snapshot.ts: UniFi Protect HomeKit snapshot class.
 */
import { FfmpegExec, runWithAbort } from "homebridge-plugin-utils";
import type { HomebridgePluginLogging, Nullable } from "homebridge-plugin-utils";
import { PROTECT_LIVESTREAM_API_IDR_INTERVAL } from "../settings.ts";
import type { ProtectCameraHost } from "./camera-host.ts";
import type { SnapshotOptions } from "unifi-protect";
import type { SnapshotRequest } from "homebridge";

// Maximum age of a snapshot in seconds.
const PROTECT_SNAPSHOT_CACHE_MAXAGE = 90;

// Timeout for snapshot acquisition, in milliseconds. HomeKit enforces a 5000ms hard limit on snapshot requests. We budget 10ms of overhead for the response to
// reach HomeKit after our code produces the snapshot.
const PROTECT_SNAPSHOT_TIMEOUT = 4990;

// A snapshot-source FFmpeg pipeline whose non-zero exits are routine, not exceptional: each source (timeshift, RTSP) is attempted in turn and a miss simply falls through
// to the next source, so a failed exit is expected. We override the base class's ERROR teardown dump - which would otherwise spam the log on every routine miss - with a
// single debug line, deliberately suppressing the ERROR dump that routine misses do not warrant; the homebridge-plugin-utils base exposes logFailedTeardown as exactly
// this hook for known-benign failure shapes. The separate crop pipeline keeps the default ERROR logging, since a crop failure is genuinely noteworthy.
class SnapshotFfmpegExec extends FfmpegExec {

  protected override logFailedTeardown(): void {

    this.log.debug("A snapshot source FFmpeg pipeline exited without producing an image; falling through to the next source.");
  }
}

// Camera snapshot class for Protect.
export class ProtectSnapshot {

  private _cachedSnapshot: Nullable<{ image: Buffer; time: number }>;
  private _snapshotInFlight: Nullable<Promise<Nullable<Buffer>>>;
  public readonly log: HomebridgePluginLogging;
  public readonly protectCamera: ProtectCameraHost;

  // Create an instance of the Protect snapshot handler.
  constructor(protectCamera: ProtectCameraHost) {

    this.log = protectCamera.log;
    this.protectCamera = protectCamera;
    this._cachedSnapshot = null;
    this._snapshotInFlight = null;
  }

  // Return a snapshot for use by HomeKit. Concurrent requests for the same camera are coalesced into a single acquisition to avoid spawning duplicate FFmpeg pipelines.
  public async getSnapshot(request?: SnapshotRequest): Promise<Nullable<Buffer>> {

    // If we aren't connected, we're done. Reachability is the single honest fact here: it composes the controller's connection health with this camera's online state, so
    // a pre-bootstrap or throttled controller already reads as unreachable (its connection is not healthy). One check replaces the former bootstrap/throttle/online trio.
    if(!this.protectCamera.isReachable) {

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
    //
    // We run the whole acquisition under an abort signal so the timeout below actually cancels in-flight work - the controller snapshot request and every FFmpeg pipeline
    // receive the same signal and tear down the moment the deadline lapses, rather than leaking until they complete on their own.
    const snapshot = await runWithAbort(async (signal): Promise<Nullable<Buffer>> => {

      let snapAttempt = await this.snapFromTimeshift(request, signal);
      let needsExternalCrop = false;

      // No snapshot yet, let's try again.
      if(!snapAttempt) {

        // We treat package cameras uniquely - the Protect API is tried before RTSP because the lower frame rate of package cameras causes a lengthier RTSP response.
        if("packageCamera" in this.protectCamera.accessory.context) {

          snapAttempt = await this.snapFromController({ height: request?.height, packageCamera: true, signal, width: request?.width });

          if(snapAttempt) {

            needsExternalCrop = true;
          } else {

            snapAttempt = await this.snapFromRtsp(request, signal);
          }
        } else {

          snapAttempt = await this.snapFromRtsp(request, signal);

          if(!snapAttempt) {

            snapAttempt = await this.snapFromController({ height: request?.height, signal, width: request?.width });

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

        snapAttempt = await this.cropSnapshot(snapAttempt, signal) ?? snapAttempt;
      }

      // Cache the image before returning it.
      this._cachedSnapshot = { image: snapAttempt, time: Date.now() };

      return snapAttempt;
    }, { timeout: PROTECT_SNAPSHOT_TIMEOUT });

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
  private async snapFromTimeshift(request: SnapshotRequest | undefined, signal: AbortSignal): Promise<Nullable<Buffer>> {

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

      "-r", this.protectCamera.stream.hksv?.channelProfile?.channel.fps.toString() ?? "30",
      "-probesize", buffer.length.toString(),
      "-f", "mp4",
      "-i", "pipe:0"
    ];

    return this.snapFromFfmpeg(ffmpegOptions, signal, request, buffer);
  }

  // Snapshots using the Protect RTSP endpoints as the source.
  private async snapFromRtsp(request: SnapshotRequest | undefined, signal: AbortSignal): Promise<Nullable<Buffer>> {

    // If we aren't generating high resolution snapshots, we're done.
    if(!this.protectCamera.stream || !this.protectCamera.hints.highResSnapshots) {

      return null;
    }

    // Grab the highest quality stream we have available.
    const channelProfile = this.protectCamera.selectChannel(3840, 2160, { biasHigher: true });

    if(!channelProfile) {

      return null;
    }

    // Use the RTSP stream to generate a snapshot image. Options we use are:
    //
    // -avioflags direct          Tell FFmpeg to minimize buffering to reduce latency for more realtime processing.
    // -r fps                     Set the input frame rate for the video stream.
    // -probesize number          How many bytes should be analyzed for stream information.
    // -rtsp_transport tcp        Tell the RTSP stream handler that we're looking for a TCP connection.
    // -i channelProfile.url           RTSPS URL to get our input stream from.
    const ffmpegOptions = [

      "-avioflags", "direct",
      "-r", channelProfile.channel.fps.toString(),
      "-probesize", this.protectCamera.stream.probesize.toString(),
      "-rtsp_transport", "tcp",
      "-i", channelProfile.url
    ];

    return this.snapFromFfmpeg(ffmpegOptions, signal, request);
  }

  // Snapshots using the Protect controller's snapshot command as the source. This is the unifi-protect library's camera projection snapshot, exposed through the
  // camera's narrow public seam. Unlike the FFmpeg-based sources, the controller command throws on failure rather than returning null - a non-2xx response, or a
  // ProtectUnsupportedError when a package snapshot is requested on a camera without a package sensor. We translate that throw into a null so the multi-source
  // acquisition falls through to the next source exactly as it always has, and so a snapshot failure never escapes acquireSnapshot.
  private async snapFromController(opts: SnapshotOptions): Promise<Nullable<Buffer>> {

    try {

      return await this.protectCamera.snapshotFromController(opts);
    } catch {

      return null;
    }
  }

  // Generate a snapshot using FFmpeg.
  private async snapFromFfmpeg(ffmpegInputOptions: string[], signal: AbortSignal, request?: SnapshotRequest, buffer?: Buffer): Promise<Nullable<Buffer>> {

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

    // Instantiate and spawn FFmpeg. The composed signal ties this pipeline's lifetime to the acquisition deadline, so a timeout kills the child rather than leaving it
    // running. When we have a timeshift buffer it is fed as canned stdin; the RTSP source reads from its input URL and supplies no stdin.
    const ffmpeg = new SnapshotFfmpegExec(this.protectCamera.stream.ffmpegOptions, { args: commandLineOptions, signal, stdin: buffer });

    // Retrieve the snapshot. The result accessor rejects only when the child never spawned (e.g., a missing FFmpeg binary), which we treat as this source failing so the
    // acquisition falls through to the next source rather than letting the error escape.
    let ffmpegResult;

    try {

      ffmpegResult = await ffmpeg.result();
    } catch {

      return null;
    }

    // We're done. If we produced an empty image, we couldn't utilize the output.
    if(ffmpegResult.exitCode === 0) {

      return ffmpegResult.stdout.length ? ffmpegResult.stdout : null;
    }

    return null;
  }

  // Image snapshot crop handler for Protect API snapshots. The input is a JPEG image, so we use minimal FFmpeg options - the hardware video decoder flags and stream
  // analysis options used in snapFromFfmpeg are unnecessary here since FFmpeg natively decodes JPEG without hardware assistance.
  private async cropSnapshot(snapshot: Buffer, signal: AbortSignal): Promise<Nullable<Buffer>> {

    if(!this.protectCamera.stream) {

      return null;
    }

    // Crop the snapshot using FFmpeg with the crop filter. The JPEG to crop is fed as canned stdin, and the composed signal ties this pipeline to the acquisition
    // deadline. Options we use are:
    //
    // -hide_banner         Suppress printing the startup banner in FFmpeg.
    // -nostats             Suppress printing progress reports while encoding in FFmpeg.
    // -i pipe:0            Read input from standard input.
    // -filter:v            Pass the crop filter options to FFmpeg.
    // -f image2pipe        Specifies the output format to use a pipe, since we are outputting to stdout and want to consume the data directly.
    // -c:v mjpeg           Specify the MJPEG encoder to get a JPEG file.
    // pipe:1               Output the cropped snapshot to standard output.
    const ffmpeg = new FfmpegExec(this.protectCamera.stream.ffmpegOptions, { args: [

      "-hide_banner",
      "-nostats",
      "-i", "pipe:0",
      "-filter:v", this.protectCamera.stream.ffmpegOptions.cropFilter,
      "-f", "image2pipe",
      "-c:v", "mjpeg",
      "pipe:1"
    ], signal, stdin: snapshot });

    // Retrieve the cropped snapshot. The result accessor rejects only when the child never spawned, which we treat as a crop failure.
    let ffmpegResult;

    try {

      ffmpegResult = await ffmpeg.result();
    } catch {

      this.log.error("Unable to crop snapshot.");

      return null;
    }

    // Crop succeeded, we're done.
    if(ffmpegResult.exitCode === 0) {

      return ffmpegResult.stdout;
    }

    // Something went wrong.
    this.log.error("Unable to crop snapshot.");

    return null;
  }

  // Retrieve a cached snapshot, if available.
  private get cachedSnapshot(): Nullable<Buffer> {

    // If we have an image within the cache max-age (90 seconds, PROTECT_SNAPSHOT_CACHE_MAXAGE), we can use it. Otherwise, we're done.
    if(!this._cachedSnapshot || ((Date.now() - this._cachedSnapshot.time) > (PROTECT_SNAPSHOT_CACHE_MAXAGE * 1000))) {

      this._cachedSnapshot = null;

      return null;
    }

    return this._cachedSnapshot.image;
  }
}
