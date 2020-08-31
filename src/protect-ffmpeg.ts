/* Copyright(C) 2017-2020, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-ffmpeg.ts: FFmpeg capability validation and process control.
 *
 * This module is heavily inspired by the homebridge and homebridge-camera-ffmpeg source code and
 * borrows heavily from both. Thank you for your contributions to the HomeKit world.
 */
import { ChildProcess, spawn } from "child_process";
import { createSocket } from "dgram";
import execa from "execa";
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
  private isVerbose: boolean;
  private readonly log: Logging;
  private readonly process: ChildProcess;
  private killing = false;
  private timeout?: NodeJS.Timeout;
  private delegate: ProtectStreamingDelegate;

  constructor(delegate: ProtectStreamingDelegate, sessionId: string, command: string, returnPort?: PortInterface, callback?: StreamRequestCallback) {

    this.debug = delegate.platform.debug.bind(this);
    this.delegate = delegate;
    this.log = delegate.platform.log;

    // Toggle FFmpeg logging, if configured.
    this.isVerbose = this.delegate.platform.verboseFfmpeg;

    if(this.isVerbose) {
      this.log("%s: ffmpeg command: %s %s", delegate.name, delegate.videoProcessor, command);
    } else {
      this.debug("%s: ffmpeg command: %s %s", delegate.name, delegate.videoProcessor, command);
    }

    // Create the return port for FFmpeg, if requested to do so. The only time we don't do this is when we're standing up
    // a two-way audio stream - in that case, the audio work is done through RtpSplitter and not here.
    if(returnPort !== undefined) {
      const socket = createSocket(returnPort.addressVersion === "ipv6" ? "udp6" : "udp4");

      // Handle network errors.
      socket.on("error", (error: Error) => {
        this.log.error("%s: Socket error: ", delegate.name, error.name);
        delegate.stopStream(sessionId);
      });

      // Kill zombie video streams.
      socket.on("message", () => {
        if(this.timeout) {
          clearTimeout(this.timeout);
        }

        this.timeout = setTimeout(() => {
          delegate.platform.log.info("%s: Device appears to be inactive for over 5 seconds. Stopping stream.", delegate.name);
          delegate.controller.forceStopStreamingSession(sessionId);
          delegate.stopStream(sessionId);
        }, 5000);
      });

      socket.bind(returnPort.port);
    }

    // Track if we've started receiving data.
    let started = false;

    // Execute the command line.
    this.process = spawn(delegate.videoProcessor, command.split(/\s+/), { env: process.env });

    this.process.stdin?.on("error", (error: Error) => {
      if(!error.message.includes("EPIPE")) {
        this.log.error("%s: FFmpeg error: %s", delegate.name, error.message);
      }
    });

    this.process.stderr?.on("data", (data) => {
      if(!started) {
        started = true;
        this.debug("%s: Received the first frame.", delegate.name);

        // Always remember to execute the callback once we're setup.
        if(callback) {
          callback();
        }
      }

      // Debugging and additional logging, if requested.
      if(this.isVerbose || delegate.platform.debugMode) {
        data.toString().split(/\n/).forEach((line: string) => {
          this.log(line);
        });
      }
    });

    // Error handling.
    this.process.on("error", (error: Error) => {
      this.log.error("%s: Unable to start stream: %s.", delegate.name, error.message);
      if(callback) {
        callback(new Error("ffmpeg process creation failed!"));
        delegate.stopStream(sessionId);
      }
    });

    // Handle the end of our process - graceful and otherwise.
    this.process.on("exit", (code: number, signal: NodeJS.Signals) => {
      const message = "%s: ffmpeg exited with code: " + code + " and signal: " + signal;

      if(code === null || code === 255) {
        if(this.killing) {
          this.debug(message + " (Expected)", delegate.name);
        } else {
          this.log.error(message + " (Unexpected)", delegate.name);
        }
      } else {
        this.log.error(message + " (Error)", delegate.name);
        this.delegate.setVerboseFfmpeg();

        delegate.stopStream(sessionId);

        if(!started && callback) {
          callback(new Error(message));
        } else {
          delegate.controller.forceStopStreamingSession(sessionId);
        }
      }
    });
  }

  // Cleanup after we're done.
  public stop(): void {
    this.killing = true;
    if(this.timeout) {
      clearTimeout(this.timeout);
    }
    this.process.kill("SIGKILL");
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
