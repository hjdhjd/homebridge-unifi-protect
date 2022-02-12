/* Copyright(C) 2017-2022, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-ffmpeg.ts: Provide FFmpeg process control and capability introspection.
 *
 * This module is heavily inspired by the homebridge and homebridge-camera-ffmpeg source code and
 * borrows heavily from both. Thank you for your contributions to the HomeKit world.
 */
import { CameraRecordingConfiguration, H264Level, H264Profile, Logging, StreamRequestCallback } from "homebridge";
import { Readable, Writable } from "stream";
import execa, { ExecaChildProcess, ExecaError } from "execa";
import { ProtectCamera } from "./protect-camera";
import { ProtectNvr } from "./protect-nvr";
import { ProtectStreamingDelegate } from "./protect-stream";
import { createSocket } from "dgram";

// Port and IP version information.
interface PortInterface {
  addressVersion: string,
  port: number
}

// Base class for all FFmpeg process management.
export class FfmpegProcess {

  protected callback: StreamRequestCallback | null;
  protected commandLineArgs: string[];
  protected readonly debug: (message: string, ...parameters: unknown[]) => void;
  public isEnded: boolean;
  private isPrepared: boolean;
  public isStarted: boolean;
  protected isVerbose: boolean;
  protected readonly log: Logging;
  protected readonly name: () => string;
  protected readonly nvr: ProtectNvr;
  protected process: ExecaChildProcess | null;
  private protectCamera: ProtectCamera;

  // Create a new FFmpeg process instance.
  constructor(protectCamera: ProtectCamera, commandLineArgs?: string[], callback?: StreamRequestCallback) {

    this.callback = null;
    this.commandLineArgs = [];
    this.debug = protectCamera.platform.debug.bind(protectCamera.platform);
    this.isPrepared = false;
    this.isEnded = false;
    this.isStarted = false;
    this.log = protectCamera.platform.log;
    this.name = protectCamera.name.bind(protectCamera);
    this.nvr = protectCamera.nvr;
    this.process = null;
    this.protectCamera = protectCamera;

    // Toggle FFmpeg logging, if configured.
    this.isVerbose = protectCamera.platform.verboseFfmpeg;

    // If we've specified a command line or a callback, let's save them.
    if(commandLineArgs) {

      this.commandLineArgs = commandLineArgs;
    }

    if(callback) {

      this.callback = callback;
    }
  }

  // Prepare and start our FFmpeg process.
  protected prepareProcess(commandLineArgs?: string[], callback?: StreamRequestCallback): void {

    // If we've specified a new command line or callback, let's save them.
    if(commandLineArgs) {

      this.commandLineArgs = commandLineArgs;
    }

    // No command line arguments - we're done.
    if(!this.commandLineArgs) {

      this.log.error("%s: No FFmpeg command line specified.", this.name());
      return;
    }

    // Save the callback, if we have one.
    if(callback) {

      this.callback = callback;
    }

    // See if we should display ffmpeg command output.
    let hasLogging = false;

    // Track if we've started or ended FFmpeg.
    this.isStarted = false;
    this.isEnded = false;

    // If we've got a loglevel specified, ensure we display it.
    if(this.commandLineArgs.indexOf("-loglevel") !== -1) {
      hasLogging = true;
    }

    // Inform the user, if we've been asked to do so.
    if(hasLogging || this.isVerbose || this.protectCamera.platform.config.debugAll) {

      this.log.info("%s: ffmpeg command: %s %s", this.name(), this.protectCamera.stream.videoProcessor, this.commandLineArgs.join(" "));
    } else {

      this.debug("%s: ffmpeg command: %s %s", this.name(), this.protectCamera.stream.videoProcessor, this.commandLineArgs.join(" "));
    }

    // Prepare the command line we want to execute.
    this.process = execa(this.protectCamera.stream.videoProcessor, this.commandLineArgs);

    let dataListener: (data: Buffer) => void;
    let errorListener: (error: Error) => void;

    // Handle errors on stdin.
    this.process.stdin?.on("error", errorListener = (error: Error): void => {

      if(!error.message.includes("EPIPE")) {
        this.log.error("%s: FFmpeg error: %s.", this.name(), error.message);
      }

    });

    // Handle logging output that gets sent to stderr.
    this.process.stderr?.on("data", dataListener = (data: Buffer): void => {

      if(!this.isStarted) {

        this.isStarted = true;
        this.isEnded = false;
        this.debug("%s: Received the first frame.", this.name());

        // Always remember to execute the callback once we're setup to let homebridge know we're streaming.
        if(this.callback) {

          this.callback();
        }
      }

      // Debugging and additional logging, if requested.
      if(hasLogging || this.isVerbose || this.protectCamera.platform.config.debugAll) {

        data.toString().split(/\n/).forEach((line: string) => {

          this.log.info("%s: %s", this.name(), line);
        });
      }

    });

    // Make sure we update our state and cleanup after ourselves if we're ending a process.
    this.process.stdout?.once("close", () => {

      this.isStarted = false;
      this.isEnded = true;

      this.process?.stdin?.removeListener("error", errorListener);
      this.process?.stderr?.removeListener("data", dataListener);

      this.process = null;
    });

    this.isPrepared = true;
  }

  // Wait for our FFmpeg process to complete execution.
  protected async start(commandLineArgs?: string[], callback?: StreamRequestCallback, errorHandler?: (errorMessage: string) => Promise<void>): Promise<void> {

    // If we haven't prepared our FFmpeg process, do so now.
    if(!this.isPrepared) {

      this.prepareProcess(commandLineArgs, callback);

      if(!this.isPrepared) {

        this.log.error("%s: Error preparing to run FFmpeg.", this.name());
        return;
      }
    }

    try {

      // Execute the command line.
      await this.process;

    } catch(error) {

      // You might think this should be ExecaError, but ExecaError is a type, not a class, and instanceof
      // only operates on classes.
      if(!(error instanceof Error)) {

        this.log.error("%s: Unknown error received while attempting to start FFmpeg: %s.", this.name(), error);
        return;
      }

      // Recast our error object as an ExecaError.
      const execError = error as ExecaError;

      // Some utilities to streamline things.
      const logPrefix = this.name() + ": FFmpeg process ended ";
      const code = execError.exitCode ?? null;
      const signal = execError.signal ?? null;

      // We asked FFmpeg to stop.
      if(execError.isCanceled) {

        this.debug(logPrefix + "(Expected).");
        return;
      }

      // FFmpeg ended for another reason.
      const errorMessage = logPrefix + "(Error)." + (code === null ? "" : " Exit code: " + code.toString() + ".") + (signal === null ? "" : " Signal: " + signal + ".");
      // this.log.error("%s: %s", this.name(), execError.message);
      this.log.error("%s: FFmpeg failed with error: %s: %s", this.name(), signal, execError.signalDescription);

      // Execute our error handler, if one is provided.
      if(errorHandler) {
        await errorHandler(errorMessage);
      }
    }
  }

  // Cleanup after we're done.
  public stop(): void {

    // Cancel our process.
    this.process?.cancel();
  }

  // Return the standard input for this process.
  public get stdin(): Writable | null {

    return this.process?.stdin ?? null;
  }

  // Return the standard output for this process.
  public get stdout(): Readable | null {

    return this.process?.stdout ?? null;
  }

  // Validate whether or not we have a specific codec available to us in FFmpeg.
  public static async codecEnabled(videoProcessor: string, codec: string, log: Logging): Promise<boolean> {

    try {

      const output = await execa(videoProcessor, ["-codecs"]);
      return output.stdout.includes(codec);

    } catch(error) {

      // You might think this should be ExecaError, but ExecaError is a type, not a class, and instanceof
      // only operates on classes.
      if(!(error instanceof Error)) {
        log.error("Unknown error received while attempting to start FFmpeg: %s.", error);
        return false;
      }

      /* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access */
      if((error as any).code === "ENOENT") {

        log.error("Unable to find FFmpeg at: '%s'. Please make sure that you have a working version of FFmpeg installed.", (error as any).path);

      } else {

        log.error("Error running FFmpeg: %s", (error as any).originalMessage);
      }
      /* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access */

    }

    return false;
  }
}

// FFmpeg streaming process management.
export class FfmpegStreamingProcess extends FfmpegProcess {

  private delegate: ProtectStreamingDelegate;
  private sessionId: string;
  private streamTimeout?: NodeJS.Timeout;

  // Create a new FFmpeg process instance.
  constructor(delegate: ProtectStreamingDelegate, sessionId: string, commandLineArgs: string[], returnPort?: PortInterface, callback?: StreamRequestCallback) {

    // Initialize our parent.
    super(delegate.protectCamera);

    this.delegate = delegate;
    this.sessionId = sessionId;

    // Create the return port for FFmpeg, if requested to do so. The only time we don't do this is when we're standing up
    // a two-way audio stream - in that case, the audio work is done through RtpSplitter and not here.
    if(returnPort) {

      this.createSocket(returnPort);
    }

    void this.start(commandLineArgs, callback, async (errorMessage: string) => {

      // Stop the stream.
      await this.delegate.stopStream(this.sessionId);

      // Temporarily increase logging verbosity.
      this.delegate.setVerboseFfmpeg();

      // Let homebridge know what happened and stop the stream if we've already started.
      if(!this.isStarted && this.callback) {

        this.callback(new Error(errorMessage));
        return;
      }

      // Tell Homebridge to forcibly stop the streaming session.
      this.delegate.controller.forceStopStreamingSession(this.sessionId);
    });
  }

  // Create the port for FFmpeg to send data through.
  private createSocket(portInfo: PortInterface): void {

    let errorListener: (error: Error) => void;
    let messageListener: () => void;
    const socket = createSocket(portInfo.addressVersion === "ipv6" ? "udp6" : "udp4");

    // Cleanup after ourselves when the socket closes.
    socket.once("close", () => {

      if(this.streamTimeout) {

        clearTimeout(this.streamTimeout);
      }

      socket.removeListener("error", errorListener);
      socket.removeListener("message", messageListener);
    });

    // Handle potential network errors.
    socket.on("error", errorListener = (error: Error): void => {

      this.log.error("%s: Socket error: %s.", this.name(), error.name);
      void this.delegate.stopStream(this.sessionId);
    });

    // Manage our video streams in case we haven't received a stop request, but we're in fact dead zombies.
    socket.on("message", messageListener = (): void => {

      // Clear our last canary.
      if(this.streamTimeout) {

        clearTimeout(this.streamTimeout);
      }

      // Set our new canary.
      this.streamTimeout = setTimeout(() => {

        this.debug("%s: video stream appears to be inactive for 5 seconds. Stopping stream.", this.name());

        this.delegate.controller.forceStopStreamingSession(this.sessionId);
        void this.delegate.stopStream(this.sessionId);
      }, 5000);
    });

    // Bind to the port we're opening.
    socket.bind(portInfo.port);
  }
}

// FFmpeg HomeKit Streaming Video recording process management.
export class FfmpegRecordingProcess extends FfmpegProcess {

  private recordingBuffer: { data: Buffer, header: Buffer, length: number, type: string }[];

  // Create a new FFmpeg process instance.
  constructor(device: ProtectCamera, recordingConfig: CameraRecordingConfiguration, isAudioActive: boolean) {

    // Initialize our parent.
    super(device);

    // Initialize our recording buffer.
    this.recordingBuffer = [];

    // Determine which H.264 profile HomeKit is expecting from us.
    const requestedProfile = (recordingConfig.videoCodec.parameters.profile === H264Profile.HIGH) ? "high"
      : (recordingConfig.videoCodec.parameters.profile === H264Profile.MAIN) ? "main" : "baseline";

    const requestedLevel = (recordingConfig.videoCodec.parameters.level === H264Level.LEVEL4_0) ? "4.0"
      : (recordingConfig.videoCodec.parameters.level === H264Level.LEVEL3_2) ? "3.2" : "3.1";

    // Configure our video parameters for transcoding:
    //
    // -hide_banner:                                         Suppress printing the startup banner in FFmpeg.
    // -f mp4                                                Tell ffmpeg that it should expect an MP4-encoded input stream.
    // -i pipe:0                                             Use standard input to get video data.
    // -map 0:v                                              Selects the first available video track from the stream. Protect actually maps audio
    //                                                       and video tracks in opposite locations from where FFmpeg typically expects them. This
    //                                                       setting is a more general solution than naming the track locations directly in case
    //                                                       Protect changes this in the future.
    // -vcodec libx264                                       Copy the stream withour reencoding it.
    // -pix_fmt yuvj420p                                     Use the yuvj420p pixel format, which is what Protect uses.
    // -profile:v high                                       Use the H.264 high profile when encoding, which provides for better stream quality and size efficiency.
    // -preset veryfast                                      Use the veryfast encoding preset in libx264, which provides a good balance of encoding speed and quality.
    // -b:v bitrate                                          The average bitrate to use for this stream. This is specified by HomeKit Secure Video.
    // -bufsize size                                         This is the decoder buffer size, which drives the variability / quality of the output bitrate.
    // -maxrate bitrate                                      The maximum bitrate tolerance, used with -bufsize. We set this to effectively create a constant bitrate.
    // -force_key_frames expr:gte(t, n_forced * 4)           Force a specific keyframe interval in the fMP4 stream we are generating.
    // -fflags +genpts                                       Generate a presentation timestamp (PTS) if there's a valid decoding timestamp (DTS) and PTS is missing.
    // -reset_timestamps 1                                   Reset timestamps at the beginning of each segment to make the generated segments easier to consume.
    // -movflags frag_keyframe+empty_moov+default_base_moof  Start a new fragment at each keyframe, send the MOOV box at the beginning of the stream, and avoid
    //                                                       writing absolute byte positions for the segments we send.
    this.commandLineArgs = [

      "-hide_banner",
      "-f", "mp4",
      "-i", "pipe:0",
      "-map", "0:v",
      "-vcodec", "libx264",
      "-pix_fmt", "yuvj420p",
      "-profile:v", requestedProfile,
      "-level:v", requestedLevel,
      "-preset", "veryfast",
      "-b:v", recordingConfig.videoCodec.parameters.bitRate.toString() + "k",
      "-bufsize", (2 * recordingConfig.videoCodec.parameters.bitRate).toString() + "k",
      "-maxrate", recordingConfig.videoCodec.parameters.bitRate.toString() + "k",
      "-force_key_frames", "expr:gte(t, n_forced * " + (recordingConfig.videoCodec.parameters.iFrameInterval / 1000).toString() + ")",
      "-fflags", "+genpts",
      "-reset_timestamps", "1",
      "-movflags", "frag_keyframe+empty_moov+default_base_moof"
    ];

    if(isAudioActive) {

      // Configure the audio portion of the command line. Options we use are:
      //
      // -map 0:a      Selects the first available audio track from the stream. Protect actually maps audio
      //               and video tracks in opposite locations from where FFmpeg typically expects them. This
      //               setting is a more general solution than naming the track locations directly in case
      //               Protect changes this in the future.
      // -acodec copy  Copy the stream withour reencoding it.
      this.commandLineArgs.push(

        "-map", "0:a",
        "-acodec", "copy"
      );
    }

    // Configure our video parameters for outputting our final stream:
    //
    // -f mp4  Tell ffmpeg that it should create an MP4-encoded output stream.
    // pipe:1  Output the stream to standard output.
    this.commandLineArgs.push("-f", "mp4", "pipe:1");

    // Additional logging, but only if we're debugging.
    if(device.platform.verboseFfmpeg) {

      this.commandLineArgs.unshift("-loglevel", "level+verbose");
    }

    // Start the FFmpeg session.
    void this.start();
  }

  // Prepare and start our FFmpeg process.
  protected prepareProcess(): void {

    // Call our parent to get started.
    super.prepareProcess();

    // Initialize our variables that we need to process incoming FFmpeg packets.
    let header = Buffer.alloc(0);
    let bufferRemaining = Buffer.alloc(0);
    let dataLength = 0;
    let type = "";

    // Process FFmpeg output and parse out the fMP4 stream it's generating for HomeKit Secure Video.
    this.process?.stdout?.on("data", (buffer: Buffer) => {

      // If we have anything left from the last buffer we processed, prepend it to this buffer.
      if(bufferRemaining.length > 0) {

        buffer = Buffer.concat([bufferRemaining, buffer]);
        bufferRemaining = Buffer.alloc(0);
      }

      let offset = 0;

      // FFmpeg is outputting an fMP4 stream that's suitable for HomeKit Secure Video. However, we can't just
      // pass this stream directly back to HomeKit since we're using a generator-based API to send packets back to
      // HKSV. Here, we take on the task of parsing the fMP4 stream that's being generated and split it up into the
      // MP4 boxes that HAP-NodeJS is ultimately expecting.
      for(;;) {

        let data;

        // The MP4 container format is well-documented format that is based around the concept of boxes. A box (or atom as they
        // used to be called), is at the center of the MP4 format. It's composed of an 8-byte header, followed by the data payload
        // it carries.

        // No existing header, let's start a new box.
        if(!header.length) {

          // Grab the header. The first four bytes represents the length of the entire box. Second four bytes represent the box type.
          header = buffer.slice(0, 8);

          // Now we retrieve the length of the box and subtract the length of the header to get the length of the data portion of the box.
          dataLength = header.readUInt32BE(0) - 8;

          // Get the type of the box. This is always a string and has a funky history to it that makes for an interesting read!
          type = header.slice(4).toString();

          // Finally, we get the data portion of the box.
          data = buffer.slice(8, dataLength + 8);
          offset = 8;
        } else {

          // Grab the data from our buffer.
          data = buffer.slice(0, dataLength);
          offset = 0;
        }

        // If we don't have enough data in this buffer, save what we have for the next buffer we see and append it there.
        if(data.length < (dataLength - offset)) {

          bufferRemaining = data;
          break;
        }

        // Add it to our queue to be eventually pushed out through our generator function.
        this.recordingBuffer.push({ data: data, header: header, length: dataLength, type: type });

        // Prepare to start a new box for the next buffer that we will be processing.
        data = Buffer.alloc(0);
        header = Buffer.alloc(0);
        type = "";

        // We've parsed an entire box, and there's no more data in this buffer to parse.
        if(buffer.length === (offset + dataLength)) {

          dataLength = 0;
          break;
        }

        // If there's anything left in the buffer, move us to the new box and let's keep iterating.
        buffer = buffer.slice(offset + dataLength);
        dataLength = 0;
      }
    });
  }

  // Generate complete segments from an FFmpeg output stream that HomeKit Secure Video can process.
  public async *generator(): AsyncGenerator<Buffer> {

    let segment: Buffer[] = [];

    // Loop forever, generating either FTYP/MOOV box pairs or MOOF/MDAT box pairs for HomeKit Secure Video.
    for(;;) {

      // FFmpeg has finished it's output - we're done.
      if(this.isEnded) {

        break;
      }

      // If we haven't seen any output from FFmpeg yet, sleep for a very short period of time to wait for it.
      // You might think there should be a longer sleep interval here, given the typical HKSV-requested segment
      // size, but since we have a several-second buffer that gets fed to FFmpeg on startup, FFmpeg is likely to
      // generate output very quickly after startup.
      if(!this.isStarted) {

        // eslint-disable-next-line no-await-in-loop
        await this.nvr.sleep(100);
        continue;
      }

      // Grab the next fMP4 box from our buffer.
      const box = this.recordingBuffer.shift();

      // If the buffer is empty, sleep for a second. We sleep a longer interval here because the buffer is likely
      // to populate no more than once a second, and in reality, more likely longer than that in most cases. Smaller
      // boxes (e.g. MOOF) will be buffered faster than larger ones like MDAT that carry the bulk of the audio / video
      // data.
      if(!box) {

        // eslint-disable-next-line no-await-in-loop
        await this.nvr.sleep(1000);
        continue;
      }

      // Queue up this fMP4 box to send back to HomeKit.
      segment.push(box.header, box.data);

      // What we want to send are two types of complete segments:
      //
      // - a complete MOOV box, usually with an accompanying FTYP box, that's sent at the very
      //   beginning of any valid fMP4 stream. HomeKit Secure Video looks for this before anything
      //   else.
      //
      // - a complete MOOF/MDAT pair. MOOF describes XXX and MDAT describes the actual audio and video
      //   data related to that segment.
      //
      // Once we see these, we combine all the segments in our queue to send back to HomeKit.
      if((box.type === "moov") || (box.type === "mdat")) {

        yield Buffer.concat(segment);
        segment = [];
      }
    }
  }
}
