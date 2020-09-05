/* Copyright(C) 2017-2020, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-ffmpeg.ts: FFmpeg capability validation and process control.
 *
 * This module is heavily inspired by the homebridge and homebridge-camera-ffmpeg source code and
 * borrows heavily from both. Thank you for your contributions to the HomeKit world.
 */
import { createSocket } from "dgram";
import execa, { ExecaChildProcess, ExecaError } from "execa";
import { Logging, StreamRequestCallback } from "homebridge";
import { ProtectStreamingDelegate } from "./protect-stream";
import { Readable, Writable } from "stream";

// Port and IP version information.
interface PortInterface {
  addressVersion: string,
  port: number
}

export class FfmpegProcess {
  private readonly debug: (message: string, ...parameters: unknown[]) => void;
  private delegate: ProtectStreamingDelegate;
  private isVerbose: boolean;
  private readonly log: Logging;
  private process!: ExecaChildProcess;
  private sessionId: string;
  private timeout?: NodeJS.Timeout;

  constructor(delegate: ProtectStreamingDelegate, sessionId: string, command: string[], returnPort?: PortInterface, callback?: StreamRequestCallback) {

    this.debug = delegate.platform.debug.bind(this);
    this.delegate = delegate;
    this.log = delegate.platform.log;
    this.sessionId = sessionId;

    // Toggle FFmpeg logging, if configured.
    this.isVerbose = this.delegate.platform.verboseFfmpeg;

    if(this.isVerbose) {
      this.log("%s: ffmpeg command: %s %s", delegate.protectCamera.name(), delegate.videoProcessor, command);
    } else {
      this.debug("%s: ffmpeg command: %s %s", delegate.protectCamera.name(), delegate.videoProcessor, command);
    }

    // Create the return port for FFmpeg, if requested to do so. The only time we don't do this is when we're standing up
    // a two-way audio stream - in that case, the audio work is done through RtpSplitter and not here.
    if(returnPort) {
      this.createSocket(returnPort);
    }

    void this.startFfmpeg(command, callback);
  }

  // Create the port for FFmpeg to send data through.
  private createSocket(portInfo: PortInterface): void {

    const socket = createSocket(portInfo.addressVersion === "ipv6" ? "udp6" : "udp4");

    // Handle potential network errors.
    socket.on("error", (error: Error) => {
      this.log.error("%s: Socket error: ", this.delegate.protectCamera.name(), error.name);
      this.delegate.stopStream(this.sessionId);
    });

    // Kill zombie video streams.
    socket.on("message", () => {
      if(this.timeout) {
        clearTimeout(this.timeout);
      }

      this.timeout = setTimeout(() => {
        this.log("%s: Device appears to be inactive for over 5 seconds. Stopping stream.", this.delegate.protectCamera.name());
        this.delegate.controller.forceStopStreamingSession(this.sessionId);
        this.delegate.stopStream(this.sessionId);
      }, 5000);
    });

    socket.bind(portInfo.port);
  }

  // Start our FFmpeg process.
  private async startFfmpeg(ffmpegCommandLine: string[], callback?: StreamRequestCallback): Promise<void> {

    // Track if we've started receiving data.
    let started = false;

    // Prepare the command line we want to execute.
    this.process = execa(this.delegate.videoProcessor, ffmpegCommandLine);

    // Handle errors on stdin.
    this.process.stdin?.on("error", (error: Error) => {
      if(!error.message.includes("EPIPE")) {
        this.log.error("%s: FFmpeg error: %s", this.delegate.protectCamera.name(), error.message);
      }
    });

    // Handle logging output that gets sent to stderr.
    this.process.stderr?.on("data", (data: Buffer) => {
      if(!started) {
        started = true;
        this.debug("%s: Received the first frame.", this.delegate.protectCamera.name());

        // Always remember to execute the callback once we're setup to let homebridge know we're streaming.
        if(callback) {
          callback();
        }
      }

      // Debugging and additional logging, if requested.
      if(this.isVerbose || this.delegate.platform.debugMode) {
        data.toString().split(/\n/).forEach((line: string) => {
          this.log(line);
        });
      }
    });

    try {

      // Execute the command line.
      await this.process;

    } catch(error) {

      // You might think this should be ExecaError, but ExecaError is a type, not a class, and instanceof
      // only operates on classes.
      if(!(error instanceof Error)) {
        this.log("Unknown error received while attempting to start FFmpeg: %s.", error);
        return;
      }

      // Recast our error object as an ExecaError.
      const execError = error as ExecaError;

      // Some utilities to streamline things.
      const logPrefix = this.delegate.protectCamera.name() + ": FFmpeg process ended ";
      const code = execError.exitCode ?? null;
      const signal = execError.signal ?? null;

      // We asked FFmpeg to stop.
      if(execError.isCanceled) {
        this.debug(logPrefix + "(Expected).");
        return;
      }

      // FFmpeg ended for another reason.
      const errorMessage = logPrefix + "(Error)." + (code === null ? "" : " Exit code: " + code.toString() + ".") + (signal === null ? "" : " Signal: " + signal + ".");
      this.log.error("%s: %s", this.delegate.protectCamera.name(), execError.message);

      // Stop the stream.
      this.delegate.stopStream(this.sessionId);

      // Temporarily increase logging verbosity.
      this.delegate.setVerboseFfmpeg();

      // Let homebridge know what happened and stop the stream if we've already started.
      if(!started && callback) {
        callback(new Error(errorMessage));
      } else {
        this.delegate.controller.forceStopStreamingSession(this.sessionId);
      }
    }
  }

  // Cleanup after we're done.
  public stop(): void {

    // Cancel our process.
    this.process.cancel();

    // Kill our heartbeat monitoring.
    if(this.timeout) {
      clearTimeout(this.timeout);
    }
  }

  // Grab the standard input.
  public getStdin(): Writable | null {
    return this.process.stdin;
  }

  // Grab the standard output.
  public getStdout(): Readable | null {
    return this.process.stdout;
  }

  // Validate whether or not we have a specific codec available to us in FFmpeg.
  public static async codecEnabled(videoProcessor: string, codec: string): Promise<boolean> {
    const output = await execa(videoProcessor, ["-codecs"]);
    return output.stdout.includes(codec);
  }
}
