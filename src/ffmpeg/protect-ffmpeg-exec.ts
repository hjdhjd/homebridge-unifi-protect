/* Copyright(C) 2017-2024, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-ffmpeg-exec.ts: Execute arbitrary FFmpeg commands and return the results.
 *
 */
import { FfmpegProcess } from "./protect-ffmpeg.js";
import { ProtectCamera } from "../devices/index.js";

type ProcessResult = {

  exitCode: number | null;
  stderr: Buffer;
  stdout: Buffer;
};

export class FfmpegExec extends FfmpegProcess {

  private isLoggingErrors: boolean;

  constructor(protectCamera: ProtectCamera, commandLineArgs?: string[], logErrors = true) {

    // Initialize our parent.
    super(protectCamera, commandLineArgs);

    // We want to log errors when they occur.
    this.isLoggingErrors = logErrors;
  }

  // Run the FFmpeg process and return the result.
  public exec(stdinData?: Buffer): Promise<ProcessResult | null> {

    return new Promise<ProcessResult | null>((resolve) => {

      this.start();

      if(this.process === null) {

        this.log.error("Unable to execute command.");

        return null;
      }

      // Write data to stdin and close
      if(stdinData) {

        this.process.stdin.end(stdinData);
      }

      const stderr: Buffer[] = [];
      const stdout: Buffer[] = [];

      // Read standard output and standard error into buffers.
      this.process.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      this.process.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));

      // We prepend this listener to ensure we can properly cleanup after ourselves.
      this.process.prependOnceListener("exit", () => {

        // Trigger our process cleanup activities.
        this.stop();
      });

      // Return when process is done.
      this.process.once("exit", (exitCode) => {

        // Return the output and results.
        resolve({

          exitCode,
          stderr: Buffer.concat(stderr),
          stdout: Buffer.concat(stdout)
        });
      });
    });
  }

  // Log errors.
  protected logFfmpegError(exitCode: number, signal: NodeJS.Signals): void {

    // If we're ignoring errors, we're done.
    if(!this.isLoggingErrors) {

      return;
    }

    // Otherwise, revert to our default logging in our parent.
    super.logFfmpegError(exitCode, signal);
  }

}
