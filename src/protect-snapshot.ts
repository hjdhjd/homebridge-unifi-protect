/* Copyright(C) 2017-2024, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-snapshot.ts: UniFi Protect HomeKit snapshot class.
 */
import { API, HAP, SnapshotRequest } from "homebridge";
import { FfmpegExec } from "./ffmpeg/index.js";
import { PROTECT_SNAPSHOT_CACHE_MAXAGE } from "./settings.js";
import { ProtectCamera } from "./devices/index.js";
import { ProtectLogging } from "./protect-types.js";
import { ProtectNvr } from "./protect-nvr.js";
import { ProtectPlatform } from "./protect-platform.js";

// Camera snapshot class for Protect.
export class ProtectSnapshot {

  private readonly api: API;
  private readonly hap: HAP;
  public readonly log: ProtectLogging;
  private readonly nvr: ProtectNvr;
  public readonly platform: ProtectPlatform;
  public readonly protectCamera: ProtectCamera;
  private snapshotCache: { [index: string]: { image: Buffer, time: number } };

  // Create an instance of a HomeKit streaming delegate.
  constructor(protectCamera: ProtectCamera) {

    this.api = protectCamera.api;
    this.hap = protectCamera.api.hap;
    this.log = protectCamera.log;
    this.nvr = protectCamera.nvr;
    this.protectCamera = protectCamera;
    this.platform = protectCamera.platform;
    this.snapshotCache = {};
  }

  // Return a snapshot for use by HomeKit.
  public async getSnapshot(request?: SnapshotRequest): Promise<Buffer | null> {

    // If we aren't connected, we're done.
    if(!this.protectCamera.isOnline) {

      this.log.error("Unable to retrieve a snapshot: the camera is offline or unavailable.");

      return null;
    }

    // We request the snapshot to prioritize performance and quality of the image. The reason for this is that the Protect API constrains the quality level of snapshot
    // images and doesn't always produce them reliably. Fortunately, we have a few options. We retrieve snapshots by trying to use the following sources, in order:
    //
    // Timeshift buffer Eliminates querying the Protect controller and allows us to capture the highest quality image we can.
    // RTSP stream      Queries the Protect controller, but allows us to capture the highest quality image available.
    // Protect API      Requests a snapshot from the Protect controller. This is an error-prone task for the Protect controller and produces lower quality images.
    // Cached snapshot  Returns the last snapshot we have taken, assuming it isn't too old.
    //
    // The exception to this is package cameras - we try the Protect API before the RTSP stream there because the lower frame rate of the camera causes a lengthier
    // response time.
    let snapshot = await this.snapFromTimeshift(request);

    // No snapshot yet, let's try again.
    if(!snapshot) {

      // We treat package cameras uniquely.
      if("packageCamera" in this.protectCamera.accessory.context) {

        snapshot = (await this.nvr.ufpApi.getSnapshot(this.protectCamera.ufp, request?.width, request?.height, undefined, true)) ?? (await this.snapFromRtsp(request));
      } else {

        snapshot = (await this.snapFromRtsp(request)) ?? (await this.nvr.ufpApi.getSnapshot(this.protectCamera.ufp, request?.width, request?.height));
      }
    }

    // Occasional snapshot failures will happen. The controller isn't always able to generate them if one is already inflight or if it's too soon after the last one.
    if(!snapshot) {

      // See if we have an image cached that we can use instead.
      const cachedSnapshot = this.getCachedSnapshot(this.protectCamera.ufp.mac);

      if(cachedSnapshot) {

        this.log.error("Unable to retrieve a snapshot: using the most recent cached snapshot instead.");

        return cachedSnapshot;
      }

      this.log.error("Unable to retrieve a snapshot.");

      return null;
    }

    // Crop the snapshot, if we're configured to do so.
    if(this.protectCamera.hints.crop) {

      snapshot = await this.cropSnapshot(snapshot) ?? snapshot;
    }

    // Cache the image before returning it.
    this.snapshotCache[this.protectCamera.ufp.mac] = { image: snapshot, time: Date.now() };
    return this.snapshotCache[this.protectCamera.ufp.mac].image;
  }

  // Snapshots using the timeshift buffer as the source.
  private async snapFromTimeshift(request?: SnapshotRequest): Promise<Buffer | null> {

    // If we aren't generating high resolution snapshots, we're done.
    if(!this.protectCamera.hints.highResSnapshots) {

      return null;
    }

    const buffer = this.protectCamera.stream.hksv?.getTimeshiftBuffer();

    if(!buffer) {

      return null;
    }

    // Use our timeshift buffer to create a snapshot image. Options we use are:
    //
    // -r fps           Set the input frame rate for the video stream.
    // -f mp4           Specify that our input will be an MP4 file.
    // -i pipe:0        Read input from standard input.
    const ffmpegOptions = [

      "-r", this.protectCamera.stream.hksv?.rtspEntry?.channel.fps.toString() ?? "30",
      "-f", "mp4",
      "-i", "pipe:0"
    ];

    return this.snapFromFfmpeg(ffmpegOptions, request, buffer);
  }

  // Snapshots using the Protect RTSP endpoints as the source.
  private async snapFromRtsp(request?: SnapshotRequest): Promise<Buffer | null> {

    // If we aren't generating high resolution snapshots, we're done.
    if(!this.protectCamera.hints.highResSnapshots) {

      return null;
    }

    // Grab the highest quality stream we have available.
    const rtspEntry = this.protectCamera.findRtsp(3840, 2160);

    if(!rtspEntry) {

      return null;
    }

    // Use the RTSP stream to generate a snapshot image. Options we use are:
    //
    // -probesize amount    How many bytes should be analyzed for stream information. We default to to analyze time should be spent analyzing
    //                      the input stream.
    // -max_delay 500000    Set an upper limit on how much time FFmpeg can take in demuxing packets.
    // -r fps               Set the input frame rate for the video stream.
    // -rtsp_transport tcp  Tell the RTSP stream handler that we're looking for a TCP connection.
    // -i rtspEntry.url     RTSPS URL to get our input stream from.
    const ffmpegOptions = [
      ...this.protectCamera.stream.ffmpegOptions.videoDecoder,
      "-probesize", this.protectCamera.stream.probesize.toString(),
      "-max_delay", "500000",
      "-r", rtspEntry.channel.fps.toString(),
      "-rtsp_transport", "tcp",
      "-i", rtspEntry.url
    ];

    return this.snapFromFfmpeg(ffmpegOptions, request);
  }

  // Generate a snapshot using FFmpeg.
  private async snapFromFfmpeg(ffmpegInputOptions: string[], request?: SnapshotRequest, buffer?: Buffer): Promise<Buffer | null> {

    // Options we use to generate an image based on our MP4 input are:
    //
    // -hide_banner         Suppress printing the startup banner in FFmpeg.
    // -nostats             Suppress printing progress reports while encoding in FFmpeg.
    // -fflags flags        Set the format flags to generate a presentation timestamp if it's missing and discard any corrupt packets rather than exit.
    // -frames:v 1          Extract a single video frame for the output.
    // -q:v 1               Set the quality output of the JPEG output.
    const ffmpegOptions = [

      "-hide_banner",
      "-nostats",
      "-fflags", "+discardcorrupt+genpts",
      ...ffmpegInputOptions,
      "-frames:v", "1",
      "-q:v", "2"
    ];

    // If we've specified dimensions, scale the snapshot.
    if(request) {

      // -filter:v scale=   Scale the image down, if needed, but never upscale it, preserving aspect ratios and letterboxing where needed.
      ffmpegOptions.push("-filter:v", [

        "scale=" + request.width.toString(), request.height.toString(),
        "force_original_aspect_ratio=decrease,pad=" + request.width.toString(), request.height.toString(),
        "(ow-iw)/2", "(oh-ih)/2"
      ].join(":"));
    }

    // -f image2pipe        Specifies the output format to use a pipe, since we are outputting to stdout and want to consume the data directly.
    // -c:v mjpeg           Specify the MJPEG encoder to get a JPEG file.
    // pipe:1               Output the snapshot to standard output.
    ffmpegOptions.push(

      "-f", "image2pipe",
      "-c:v", "mjpeg",
      "pipe:1"
    );

    // Instantiate FFmpeg.
    const ffmpeg = new FfmpegExec(this.protectCamera, ffmpegOptions, false);

    // Retrieve the snapshot.
    const ffmpegResult = await ffmpeg.exec(buffer);

    // We're done. If we produced an empty image, we couldn't utilize the output.
    if(ffmpegResult?.exitCode === 0) {

      return ffmpegResult.stdout.length ? ffmpegResult.stdout : null;
    }

    return null;
  }

  // Image snapshot crop handler.
  private async cropSnapshot(snapshot: Buffer): Promise<Buffer|null> {

    // Crop the snapshot using the FFmpeg with crop filter. Options we use are:
    //
    // -hide_banner         Suppress printing the startup banner in FFmpeg.
    // -nostats             Suppress printing progress reports while encoding in FFmpeg.
    // -i pipe:0            Read input from standard input.
    // -filter:v            Pass the crop filter options to FFmpeg.
    // -f image2pipe        Specifies the output format to use a pipe, since we are outputting to stdout and want to consume the data directly.
    // -c:v mjpeg           Specify the MJPEG encoder to get a JPEG file.
    // pipe:1               Output the cropped snapshot to standard output.
    const ffmpeg = new FfmpegExec(this.protectCamera, [

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
  private getCachedSnapshot(cameraMac: string): Buffer | null {

    // If we have an image from the last few seconds, we can use it. Otherwise, we're done.
    if(!this.snapshotCache[cameraMac] || ((Date.now() - this.snapshotCache[cameraMac].time) > (PROTECT_SNAPSHOT_CACHE_MAXAGE * 1000))) {

      delete this.snapshotCache[cameraMac];
      return null;
    }

    return this.snapshotCache[cameraMac].image;
  }
}
