/* Copyright(C) 2017-2023, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-ffmpeg.ts: Base class to provide FFmpeg process control and capability introspection.
 *
 * This module is heavily inspired by the homebridge and homebridge-camera-ffmpeg source code. Thank you for your contributions to the HomeKit world.
 */
import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { ProtectCamera, ProtectPackageCamera } from "./protect-camera.js";
import { Readable, Writable } from "node:stream";
import { EventEmitter } from "node:events";
import { ProtectLogging } from "./protect-types.js";
import { ProtectNvr } from "./protect-nvr.js";
import { StreamRequestCallback } from "homebridge";
import util from "node:util";

// Port and IP version information.
export interface PortInterface {
  addressVersion: string,
  port: number
}

// Base class for all FFmpeg process management.
export class FfmpegProcess extends EventEmitter {

  protected callback: StreamRequestCallback | null;
  protected commandLineArgs: string[];
  public hasError: boolean;
  public isEnded: boolean;
  private isLogging: boolean;
  private isPrepared: boolean;
  public isStarted: boolean;
  protected isVerbose: boolean;
  private ffmpegTimeout?: NodeJS.Timeout;
  protected readonly log: ProtectLogging;
  protected readonly nvr: ProtectNvr;
  protected process: ChildProcessWithoutNullStreams | null;
  protected protectCamera: ProtectCamera | ProtectPackageCamera;
  protected stderrLog: string[];

  // Create a new FFmpeg process instance.
  constructor(protectCamera: ProtectCamera | ProtectPackageCamera, commandLineArgs?: string[], callback?: StreamRequestCallback) {

    // Initialize our parent.
    super();

    this.callback = null;
    this.commandLineArgs = [];
    this.hasError = false;
    this.isLogging = false;
    this.isPrepared = false;
    this.isEnded = false;
    this.isStarted = false;
    this.log = protectCamera.log;
    this.nvr = protectCamera.nvr;
    this.process = null;
    this.protectCamera = protectCamera;
    this.stderrLog = [];

    // Toggle FFmpeg logging, if configured.
    this.isVerbose = protectCamera.platform.verboseFfmpeg || protectCamera.stream.verboseFfmpeg;

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

      this.log.error("No FFmpeg command line specified.");
      return;
    }

    // Save the callback, if we have one.
    if(callback) {

      this.callback = callback;
    }

    // See if we should display ffmpeg command output.
    this.isLogging = false;

    // Track if we've started or ended FFmpeg.
    this.isStarted = false;
    this.isEnded = false;

    // If we've got a loglevel specified, ensure we display it.
    if(this.commandLineArgs.indexOf("-loglevel") !== -1) {

      this.isLogging = true;
    }

    // Inform the user, if we've been asked to do so.
    if(this.isLogging || this.isVerbose || this.protectCamera.platform.config.debugAll) {

      this.log.info("FFmpeg command: %s %s", this.protectCamera.platform.config.videoProcessor, this.commandLineArgs.join(" "));
    } else {

      this.log.debug("FFmpeg command: %s %s", this.protectCamera.platform.config.videoProcessor, this.commandLineArgs.join(" "));
    }

    this.isPrepared = true;
  }

  // Start our FFmpeg process.
  protected start(commandLineArgs?: string[], callback?: StreamRequestCallback, errorHandler?: (errorMessage: string) => Promise<void>): void {

    // If we haven't prepared our FFmpeg process, do so now.
    if(!this.isPrepared) {

      this.prepareProcess(commandLineArgs, callback);

      if(!this.isPrepared) {

        this.log.error("Error preparing to run FFmpeg.");
        return;
      }
    }

    // Execute the command line based on what we've prepared.
    this.process = spawn(this.protectCamera.platform.config.videoProcessor, this.commandLineArgs);

    // Configure any post-spawn listeners and other plumbing.
    this.configureProcess(errorHandler);
  }

  // Configure our FFmpeg process, once started.
  protected configureProcess(errorHandler?: (errorMessage: string) => Promise<void>): void {

    let dataListener: (data: Buffer) => void;
    let errorListener: (error: Error) => void;

    // Handle errors emitted during process creation, such as an invalid command line.
    this.process?.once("error", (error: Error) => {

      this.log.error("FFmpeg failed to start: %s.", error.message);

      // Execute our error handler, if one is provided.
      if(errorHandler) {

        void errorHandler(error.name + ": " + error.message);
      }
    });

    // Handle errors on stdin.
    this.process?.stdin?.on("error", errorListener = (error: Error): void => {

      if(!error.message.includes("EPIPE")) {

        this.log.error("FFmpeg error: %s.", error.message);
      }

    });

    // Handle logging output that gets sent to stderr.
    this.process?.stderr?.on("data", dataListener = (data: Buffer): void => {

      // Inform us when we start receiving data back from FFmpeg. We do this here because it's the only
      // truly reliable place we can check on FFmpeg. stdin and stdout may not be used at all, depending
      // on the way FFmpeg is called, but stderr will always be there.
      if(!this.isStarted) {

        this.isStarted = true;
        this.isEnded = false;
        this.log.debug("Received the first frame.");
        this.emit("ffmpegStarted");

        // Always remember to execute the callback once we're setup to let homebridge know we're streaming.
        if(this.callback) {

          this.callback();
          this.callback = null;
        }
      }

      // Debugging and additional logging collection.
      for(const line of data.toString().split(/\n/)) {

        // Don't output not-printable characters to ensure the log output is readable.
        const cleanLine = line.replace(/[\p{Cc}\p{Cn}\p{Cs}]+/gu, "");

        // Don't print the FFmpeg progress bar to give clearer insights into what's going on.
        if(cleanLine.length && ((cleanLine.indexOf("frame=") === -1) || (cleanLine.indexOf("size=") === -1))) {

          this.stderrLog.push(cleanLine + "\n");

          // Show it to the user if it's been requested.
          if(this.isLogging || this.isVerbose || this.protectCamera.platform.config.debugAll) {

            this.log.info(cleanLine);
          }
        }
      }
    });

    // Handle our process termination.
    this.process?.once("exit", (exitCode: number, signal: NodeJS.Signals) => {

      // Clear out our canary.
      if(this.ffmpegTimeout) {

        clearTimeout(this.ffmpegTimeout);
      }

      this.isStarted = false;
      this.isEnded = true;

      // Some utilities to streamline things.
      const logPrefix = "FFmpeg process ended ";

      // FFmpeg ended normally and our canary didn't need to enforce FFmpeg's extinction.
      if(this.ffmpegTimeout && exitCode === 0) {

        this.log.debug(logPrefix + "(Normal).");
      } else if(((exitCode === null) || (exitCode === 255)) && this.process?.killed) {

        // FFmpeg has ended. Let's figure out if it's because we killed it or whether it died of natural causes.
        this.log.debug(logPrefix + (signal === "SIGKILL" ? "(Killed)." : "(Expected)."));
      } else {

        // Flag that we've run into an FFmpeg error.
        this.hasError = true;

        // Inform the user.
        this.logFfmpegError(exitCode, signal);

        // Execute our error handler, if one is provided.
        if(errorHandler) {

          void errorHandler(util.format(this.protectCamera.name + ": " + logPrefix + " unexpectedly with exit code %s and signal %s.", exitCode, signal));
        }
      }

      // Cleanup after ourselves.
      this.process?.stdin?.removeListener("error", errorListener);
      this.process?.stderr?.removeListener("data", dataListener);
      this.process = null;
      this.stderrLog = [];
    });
  }

  // Stop the FFmpeg process and complete any cleanup activities.
  protected stopProcess(): void {

    // Check to make sure we aren't using stdin for data before telling FFmpeg we're done.
    if(!this.commandLineArgs.includes("pipe:0")) {

      this.process?.stdin.end("q");
    }

    // Close our input and output.
    this.process?.stdin.destroy();
    this.process?.stdout.destroy();

    // In case we need to kill it again, just to be sure it's really dead.
    this.ffmpegTimeout = setTimeout(() => {

      this.process?.kill("SIGKILL");
    }, 5000);

    // Send the kill shot.
    this.process?.kill();
  }

  // Cleanup after we're done.
  public stop(): void {

    this.stopProcess();
  }

  // Inform the user if an FFmpeg error occurs.
  protected logFfmpegError(exitCode: number, signal: NodeJS.Signals): void {

    // Something else has occurred. Inform the user, and stop everything.
    this.log.error("FFmpeg process ended unexpectedly with %s%s%s.", (exitCode !== null) ? "an exit code of " + exitCode.toString() : "",
      ((exitCode !== null) && signal) ? " and " : "", signal ? "a signal received of " + signal : "");

    this.log.error("FFmpeg command line that errored out was: %s %s", this.protectCamera.platform.config.videoProcessor, this.commandLineArgs.join(" "));
    this.stderrLog.map(x => this.log.error(x));
  }

  // Return the standard input for this process.
  public get stdin(): Writable | null {

    return this.process?.stdin ?? null;
  }

  // Return the standard output for this process.
  public get stdout(): Readable | null {

    return this.process?.stdout ?? null;
  }

  // Return the standard error for this process.
  public get stderr(): Readable | null {

    return this.process?.stderr ?? null;
  }
}
