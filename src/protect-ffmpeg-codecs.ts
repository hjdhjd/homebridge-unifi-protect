/* Copyright(C) 2023, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-ffmpeg-codecs.ts: probe FFmpeg capabilities and codecs.
 */
import { Logging } from "homebridge";
import { ProtectPlatform } from "./protect-platform.js";
import { execFile } from "node:child_process";
import os from "node:os";
import process from "node:process";
import util from "node:util";

export class FfmpegCodecs {

  private _gpuMem: number;
  private _ffmpegVersion: string;
  private readonly log: Logging;
  private readonly platform: ProtectPlatform;
  private readonly ffmpegExec: string;
  private readonly ffmpegCodecs: { [index: string]: { decoders: string[], encoders: string[] } };
  private readonly ffmpegHwAccels: { [index: string]: boolean };

  constructor(platform: ProtectPlatform) {

    this._gpuMem = 0;
    this._ffmpegVersion = "";
    this.log = platform.log;
    this.platform = platform;
    this.ffmpegExec = platform.config.videoProcessor;
    this.ffmpegCodecs = {};
    this.ffmpegHwAccels = {};
  }

  // Launch our configured controllers once all accessories have been loaded. Once we do, they will sustain themselves.
  public async probe(): Promise<boolean> {

    // Let's conduct our system-specific capability probes.
    switch(this.platform.hostSystem) {

      case "raspbian":

        // If we're on a Raspberry Pi, let's verify that we have enough GPU memory for hardware-based decoding and encoding.
        await this.probeRpiGpuMem();
        break;

      default:

        break;
    }

    // Capture the version information of FFmpeg.
    if(!(await this.probeFfmpegVersion())) {

      return false;
    }

    // Ensure we've got a working video processor before we do anything else.
    if(!(await this.probeFfmpegCodecs()) || !(await this.probeFfmpegHwAccel())) {

      return false;
    }

    return true;
  }

  // Utility to determine whether or not a specific decoder is available to the video processor for a given format.
  public hasDecoder(codec: string, decoder: string): boolean {

    // Normalize our lookups.
    codec = codec.toLowerCase();
    decoder = decoder.toLowerCase();

    return this.ffmpegCodecs[codec]?.decoders.some(x => x === decoder);
  }

  // Utility to determine whether or not a specific encoder is available to the video processor for a given format.
  public hasEncoder(codec: string, encoder: string): boolean {

    // Normalize our lookups.
    codec = codec.toLowerCase();
    encoder = encoder.toLowerCase();

    return this.ffmpegCodecs[codec]?.encoders.some(x => x === encoder);
  }

  // Utility to determine whether or not a specific decoder is available to the video processor for a given format.
  public hasHwAccel(accel: string): boolean {

    return this.ffmpegHwAccels[accel.toLowerCase()] ? true : false;
  }

  // Utility that returns the amount of GPU memory available to us.
  public get gpuMem(): number {

    return this._gpuMem;
  }

  public get ffmpegVersion(): string {

    return this._ffmpegVersion;
  }

  private async probeFfmpegVersion(): Promise<boolean> {

    return this.probeCmd(this.ffmpegExec, [ "-hide_banner", "-version" ], (stdout: string) => {

      // A regular expression to parse out the version.
      const versionRegex = /^ffmpeg version (.*) Copyright.*$/m;

      // Parse out the version string.
      const versionMatch = versionRegex.exec(stdout);

      // If we have a version string, let's save it. Otherwise, we're blind.
      this._ffmpegVersion = versionMatch ? versionMatch[1] : "unknown";

      this.log.info("Using FFmpeg version: %s.", this.ffmpegVersion);
    });
  }

  // Probe our video processor's hardware acceleration capabilities.
  private async probeFfmpegHwAccel(): Promise<boolean> {

    if(!(await this.probeCmd(this.ffmpegExec, [ "-hide_banner", "-hwaccels" ], (stdout: string) => {

      // Iterate through each line, and a build a list of encoders.
      for(const accel of stdout.split(os.EOL)) {

        // Skip blank lines.
        if(!accel.length) {

          continue;
        }

        // Skip the first line.
        if(accel === "Hardware acceleration methods:") {

          continue;
        }

        // We've found a hardware acceleration method, let's add it.
        this.ffmpegHwAccels[accel.toLowerCase()] = true;
      }
    }))) {

      return false;
    }

    // Let's test to ensure that just because we have a codec or capability available to us, it doesn't necessarily mean that the user has the hardware capabilities
    // needed to use it, resulting in an FFmpeg error. We catch that here and prevent those capabilities from being exposed to HBUP unless both software and hardware
    // capabilities enable it. This simple test, generates a one-second video that is processed by the requested codec. If it fails, we discard the codec.
    for(const accel of Object.keys(this.ffmpegHwAccels)) {

      // eslint-disable-next-line no-await-in-loop
      if(!(await this.probeCmd(this.ffmpegExec, [

        "-hide_banner", "-hwaccel", accel, "-v", "quiet", "-t", "1", "-f", "lavfi", "-i", "color=black:1920x1080", "-c:v", "libx264", "-f", "null", "-"
      ], () => {}, true))) {

        delete this.ffmpegHwAccels[accel];

        if(this.platform.verboseFfmpeg) {

          this.log.error("Hardware-accelerated decoding and encoding using %s will be unavailable: unable to successfully validate capabilities.", accel);
        }
      }
    }

    return true;
  }

  // Probe our video processor's encoding and decoding capabilities.
  private async probeFfmpegCodecs(): Promise<boolean> {

    return this.probeCmd(this.ffmpegExec, [ "-hide_banner", "-codecs" ], (stdout: string) => {

      // A regular expression to parse out the codec and it's supported decoders.
      const decodersRegex = /\S+\s+(\S+).+\(decoders: (.*?)\s*\)/;

      // A regular expression to parse out the codec and it's supported encoders.
      const encodersRegex = /\S+\s+(\S+).+\(encoders: (.*?)\s*\)/;

      // Iterate through each line, and a build a list of encoders.
      for(const codecLine of stdout.split(os.EOL)) {

        // Let's see if we have decoders.
        const decodersMatch = decodersRegex.exec(codecLine);

        // Let's see if we have encoders.
        const encodersMatch = encodersRegex.exec(codecLine);

        // If we found decoders, add them to our list of supported decoders for this format.
        if(decodersMatch) {

          this.ffmpegCodecs[decodersMatch[1]] = { decoders: [], encoders: [] };

          this.ffmpegCodecs[decodersMatch[1]].decoders = decodersMatch[2].split(" ").map(x => x.toLowerCase());
        }

        // If we found decoders, add them to our list of supported decoders for this format.
        if(encodersMatch) {

          if(!this.ffmpegCodecs[encodersMatch[1]]) {

            this.ffmpegCodecs[encodersMatch[1]] = { decoders: [], encoders: [] };
          }

          this.ffmpegCodecs[encodersMatch[1]].encoders = encodersMatch[2].split(" ").map(x => x.toLowerCase());
        }
      }
    });
  }

  // Probe Raspberry Pi GPU.
  private async probeRpiGpuMem(): Promise<boolean> {

    return this.probeCmd("vcgencmd", [ "get_mem", "gpu" ], (stdout: string) => {

      // A regular expression to parse out the configured GPU memory on the Raspberry Pi.
      const gpuRegex = /^gpu=(.*)M\n$/;

      // Let's see what we've got.
      const gpuMatch = gpuRegex.exec(stdout);

      // We matched what we're looking for.
      if(gpuMatch) {

        // Parse the result and retrieve our allocated GPU memory.
        this._gpuMem = parseInt(gpuMatch[1]);

        // Something went wrong.
        if(isNaN(this._gpuMem)) {

          this._gpuMem = 0;
        }
      }
    });
  }

  // Utility to probe the capabilities of FFmpeg and the host platform.
  private async probeCmd(command: string, commandLineArgs: string[], processOutput: (output: string) => void, quietRunErrors = false): Promise<boolean> {

    try {

      // Promisify exec to allow us to wait for it asynchronously.
      const execAsync = util.promisify(execFile);

      // Check for the codecs in our video processor.
      const { stdout } = await execAsync(command, commandLineArgs);

      processOutput(stdout);

      return true;
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

          this.log.error("Unable to find '%s' in path: '%s'.", command, process.env.PATH);
        } else if(quietRunErrors) {

          return false;
        } else {

          this.log.error("Error running %s: %s", command, error.message);
        }
      }

      this.log.error("Unable to probe the capabilities of your Homebridge host without access to '%s'. Ensure that it is available in your path and correctly working.",
        command);

      return false;
    }
  }
}
