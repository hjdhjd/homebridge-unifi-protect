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
  private readonly log: Logging;
  private readonly platform: ProtectPlatform;
  private readonly videoProcessor: string;
  private readonly videoProcessorCodecs: { [index: string]: { decoders: string[], encoders: string[] } };
  private readonly videoProcessorHwAccels: { [index: string]: boolean };

  constructor(platform: ProtectPlatform) {

    this._gpuMem = 0;
    this.log = platform.log;
    this.platform = platform;
    this.videoProcessor = platform.config.videoProcessor;
    this.videoProcessorCodecs = {};
    this.videoProcessorHwAccels = {};
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

    // First things first - ensure we've got a working video processor before we do anything else.
    if(!(await this.probeVideoProcessorCodecs()) || !(await this.probeVideoProcessorHwAccel())) {

      return false;
    }

    return true;
  }

  // Utility to determine whether or not a specific decoder is available to the video processor for a given format.
  public hasDecoder(codec: string, decoder: string): boolean {

    // Normalize our lookups.
    codec = codec.toLowerCase();
    decoder = decoder.toLowerCase();

    return this.videoProcessorCodecs[codec]?.decoders.some(x => x === decoder);
  }

  // Utility to determine whether or not a specific encoder is available to the video processor for a given format.
  public hasEncoder(codec: string, encoder: string): boolean {

    // Normalize our lookups.
    codec = codec.toLowerCase();
    encoder = encoder.toLowerCase();

    return this.videoProcessorCodecs[codec]?.encoders.some(x => x === encoder);
  }

  // Utility to determine whether or not a specific decoder is available to the video processor for a given format.
  public hasHwAccel(accel: string): boolean {

    return this.videoProcessorHwAccels[accel.toLowerCase()] ? true : false;
  }

  // Utility that returns the amount of GPU memory available to us.
  public get gpuMem(): number {

    return this._gpuMem;
  }

  // Probe our video processor's hardware acceleration capabilities.
  private async probeVideoProcessorHwAccel(): Promise<boolean> {

    return this.probeCmd(this.videoProcessor, [ "-hide_banner", "-hwaccels" ], (stdout: string) => {

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
        this.videoProcessorHwAccels[accel.toLowerCase()] = true;
      }
    });
  }

  // Probe our video processor's encoding and decoding capabilities.
  private async probeVideoProcessorCodecs(): Promise<boolean> {

    return this.probeCmd(this.videoProcessor, [ "-hide_banner", "-codecs" ], (stdout: string) => {

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

          this.videoProcessorCodecs[decodersMatch[1]] = { decoders: [], encoders: [] };

          this.videoProcessorCodecs[decodersMatch[1]].decoders = decodersMatch[2].split(" ").map(x => x.toLowerCase());
        }

        // If we found decoders, add them to our list of supported decoders for this format.
        if(encodersMatch) {

          if(!this.videoProcessorCodecs[encodersMatch[1]]) {

            this.videoProcessorCodecs[encodersMatch[1]] = { decoders: [], encoders: [] };
          }

          this.videoProcessorCodecs[encodersMatch[1]].encoders = encodersMatch[2].split(" ").map(x => x.toLowerCase());
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
  private async probeCmd(command: string, commandLineArgs: string[], processOutput: (output: string) => void): Promise<boolean> {

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
