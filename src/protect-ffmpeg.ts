/* Copyright(C) 2017-2022, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-ffmpeg.ts: Base class to provide FFmpeg process control and capability introspection.
 *
 * This module is heavily inspired by the homebridge and homebridge-camera-ffmpeg source code and
 * borrows heavily from both. Thank you for your contributions to the HomeKit world.
 */
import { ChildProcessWithoutNullStreams, execFile, spawn } from "child_process";
import { Logging, StreamRequestCallback } from "homebridge";
import { Readable, Writable } from "stream";
import { ProtectCamera } from "./protect-camera";
import { ProtectNvr } from "./protect-nvr";
import util from "util";

// Port and IP version information.
export interface PortInterface {
  addressVersion: string,
  port: number
}

// Base class for all FFmpeg process management.
export class FfmpegProcess {

  protected callback: StreamRequestCallback | null;
  protected commandLineArgs: string[];
  protected readonly debug: (message: string, ...parameters: unknown[]) => void;
  public isEnded: boolean;
  private isLogging: boolean;
  private isPrepared: boolean;
  public isStarted: boolean;
  protected isVerbose: boolean;
  private ffmpegTimeout?: NodeJS.Timeout;
  protected readonly log: Logging;
  protected readonly name: () => string;
  protected readonly nvr: ProtectNvr;
  protected process: ChildProcessWithoutNullStreams | null;
  protected protectCamera: ProtectCamera;

  // Create a new FFmpeg process instance.
  constructor(protectCamera: ProtectCamera, commandLineArgs?: string[], callback?: StreamRequestCallback) {

    this.callback = null;
    this.commandLineArgs = [];
    this.debug = protectCamera.platform.debug.bind(protectCamera.platform);
    this.isLogging = false;
    this.isPrepared = false;
    this.isEnded = false;
    this.isStarted = false;
    this.log = protectCamera.platform.log;
    this.name = protectCamera.name.bind(protectCamera);
    this.nvr = protectCamera.nvr;
    this.process = null;
    this.protectCamera = protectCamera;

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

      this.log.error("%s: No FFmpeg command line specified.", this.name());
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

      this.log.info("%s: ffmpeg command: %s %s", this.name(), this.protectCamera.stream.videoProcessor, this.commandLineArgs.join(" "));
    } else {

      this.debug("%s: ffmpeg command: %s %s", this.name(), this.protectCamera.stream.videoProcessor, this.commandLineArgs.join(" "));
    }

    this.isPrepared = true;
  }

  // Start our FFmpeg process.
  protected start(commandLineArgs?: string[], callback?: StreamRequestCallback, errorHandler?: (errorMessage: string) => Promise<void>): void {

    // If we haven't prepared our FFmpeg process, do so now.
    if(!this.isPrepared) {

      this.prepareProcess(commandLineArgs, callback);

      if(!this.isPrepared) {

        this.log.error("%s: Error preparing to run FFmpeg.", this.name());
        return;
      }
    }

    // Execute the command line based on what we've prepared.
    this.process = spawn(this.protectCamera.stream.videoProcessor, this.commandLineArgs);

    // Configure any post-spawn listeners and other plumbing.
    this.configureProcess(errorHandler);
  }

  // Configure our FFmpeg process, once started.
  protected configureProcess(errorHandler?: (errorMessage: string) => Promise<void>): void {

    let dataListener: (data: Buffer) => void;
    let errorListener: (error: Error) => void;

    // Handle errors emitted during process creation, such as an invalid command line.
    this.process?.once("error", (error: Error) => {

      this.log.error("%s: FFmpeg failed to start: %s", this.name(), error.message);

      // Execute our error handler, if one is provided.
      if(errorHandler) {

        void errorHandler(error.name + ": " + error.message);
      }
    });

    // Handle errors on stdin.
    this.process?.stdin?.on("error", errorListener = (error: Error): void => {

      if(!error.message.includes("EPIPE")) {
        this.log.error("%s: FFmpeg error: %s.", this.name(), error.message);
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
        this.debug("%s: Received the first frame.", this.name());

        // Always remember to execute the callback once we're setup to let homebridge know we're streaming.
        if(this.callback) {

          this.callback();
          this.callback = null;
        }
      }

      // Debugging and additional logging, if requested.
      if(this.isLogging || this.isVerbose || this.protectCamera.platform.config.debugAll) {

        data.toString().split(/\n/).forEach((line: string) => {

          // Don't output not-printable characters to ensure the log output is readable.
          const cleanLine = line.replace(/[\p{Cc}\p{Cn}\p{Cs}]+/gu, "");

          // Don't print the progress bar.
          if(cleanLine.length && (cleanLine.indexOf("frame=") === -1)) {

            this.log.info("%s: %s", this.name(), cleanLine);
          }
        });
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
      const logPrefix = this.name() + ": FFmpeg process ended ";

      // FFmpeg ended normally and our canary didn't need to enforce FFmpeg's extinction.
      if(this.ffmpegTimeout && exitCode === 0) {

        this.debug(logPrefix + "(Normal).");
      } else if(((exitCode === null) || (exitCode === 255)) && this.process?.killed) {

        // FFmpeg has ended. Let's figure out if it's because we killed it or whether it died of natural causes.
        this.debug(logPrefix + (signal === "SIGKILL" ? "(Killed)." : "(Expected)."));
      } else {

        // Something else has occurred. Inform the user, and stop everything.
        this.log.error(logPrefix + "unexpectedly with %s%s%s.",
          (exitCode !== null) ? "an exit code of " + exitCode.toString() : "",
          ((exitCode !== null) && signal) ? " and " : "",
          signal ? "a signal received of " + signal : "");

        this.log.debug("%s: FFmpeg command line that errored out was: %s %s", this.name(), this.protectCamera.stream.videoProcessor, this.commandLineArgs.join(" "));

        // Execute our error handler, if one is provided.
        if(errorHandler) {

          void errorHandler(util.format(logPrefix + " unexpectedly with exit code %s and signal %s.", exitCode, signal));
        }
      }

      // Cleanup after ourselves.
      this.process?.stdin?.removeListener("error", errorListener);
      this.process?.stderr?.removeListener("data", dataListener);
      this.process = null;
    });
  }

  // Cleanup after we're done.
  public stop(): void {

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

      // Promisify exec to allow us to wait for it asynchronously.
      const execAsync = util.promisify(execFile);

      // Check for the codecs in FFmpeg.
      const { stdout } = await execAsync(videoProcessor, ["-codecs"]);

      // See if we can find the codec.
      return stdout.includes(codec);
    } catch(error) {

      // It's really a SystemError, but Node hides that type from us for esoteric reasons.
      if(error instanceof Error) {

        interface SystemError {
          cmd: string,
          code: string,
          errno: number,
          path: string,
          spawnargs: string[],
          stderr: string,
          stdout: string,
          syscall: string
        }

        const execError = error as unknown as SystemError;

        if(execError.code === "ENOENT") {

          log.error("Unable to find FFmpeg at: '%s'. Please make sure that you have a working version of FFmpeg installed.", execError.path);

        } else {

          log.error("Error running FFmpeg: %s", error.message);
        }
      }
    }

    return false;
  }
}
