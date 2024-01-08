/* Copyright(C) 2017-2023, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-ffmpeg-exec.ts: Execute generic FFmpeg commands.
 *
 */
import { FfmpegProcess } from "./protect-ffmpeg.js";
import { ProtectCamera } from "./protect-camera.js";

type ProcessResult = {
  exitCode: number | null;
  stderr: Buffer;
  stdout: Buffer;
}
export class FfmpegExec extends FfmpegProcess {
  constructor(protectCamera: ProtectCamera, commandLineArgs?: string[]) {

    // Initialize our parent.
    super(protectCamera, commandLineArgs);
  }

  // Run the FFmpeg process and return the result.
  public exec(stdinData?: Buffer): Promise<ProcessResult | null> {

    return new Promise<ProcessResult | null>((resolve) => {

      this.start();

      if (this.process === null) {
        this.log.error("failed to start");
        return null;
      }

      // Write data to stdin and close
      if (stdinData) {
        this.process.stdin.end(stdinData);
      }

      const stderr: Buffer[] = [];
      const stdout: Buffer[] = [];

      // Read stdout/stderr to buffers
      this.process.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      this.process.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));

      // Return when process is done
      this.process.on("exit", (exitCode) => {
        resolve({
          exitCode,
          stderr: Buffer.concat(stderr),
          stdout: Buffer.concat(stdout)
        });
      });
    });
  }
}
