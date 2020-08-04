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

export class FfmpegProcess {
  private readonly debug: (message: string, ...parameters: any[]) => void;
  private readonly log: Logging;
  private readonly process: ChildProcess;
  private killing = false;
  private timeout?: NodeJS.Timeout;
  private delegate: ProtectStreamingDelegate;

  constructor(delegate: ProtectStreamingDelegate, sessionId: string, command: string, returnPort: number, callback: StreamRequestCallback) {
    this.debug = delegate.platform.debug.bind(this);
    // this.debug = delegate.platform.log;
    this.delegate = delegate;
    this.log = delegate.platform.log;

    let started = false;

    this.debug("%s: ffmpeg command: %s %s", delegate.name, delegate.videoProcessor, command);

    const socket = createSocket("udp4");

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
        delegate.stopStream(sessionId);
      }, 5000);
    });

    socket.bind(returnPort);

    // Execute the command line.
    this.process = spawn(delegate.videoProcessor, command.split(/\s+/), { env: process.env });

    if(this.process.stdin) {
      this.process.stdin.on("error", (error: Error) => {
        if(!error.message.includes("EPIPE")) {
          this.log.error("%s: FFmpeg error: %s", delegate.name, error.message);
        }
      });
    }

    if(this.process.stderr) {
      this.process.stderr.on("data", (data) => {
        if(!started) {
          started = true;
          this.debug("%s: Received the first frame.", delegate.name);

          // Always remember to execute the callback once we're setup.
          if(callback) {
            callback();
          }
        }

        // Debugging and additional logging, if requested.
        if(delegate.platform.debugMode) {
          data.toString().split(/\n/).forEach((line: string) => {
            this.log(line);
          });
        }
      });
    }

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

        delegate.stopStream(sessionId);

        if(!started && callback) {
          callback(new Error(message));
        } else {
          delegate.controller.forceStopStreamingSession(sessionId);
        }
      }
    });
  }

  // Cleanup.
  public stop(): void {
    this.killing = true;
    if(this.timeout) {
      clearTimeout(this.timeout);
    }
    this.process.kill("SIGKILL");
  }

  // Validate whether or not we have a specific codec available to us in FFmpeg.
  static async codecEnabled(videoProcessor: string, codec: string): Promise<boolean> {
    const output = await execa(videoProcessor, ["-codecs"]);
    return output.stdout.includes(codec);
  }
}
