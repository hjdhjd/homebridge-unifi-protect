/* Copyright(C) 2021, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-platformsettings.ts: Platform configuration for transcoding settings
 *
 */
import { Systeminformation, osInfo, system } from "systeminformation";
import { FfmpegProcess } from "./protect-ffmpeg";
import { Logging } from "homebridge";
import { PROTECT_FFMPEG_VIDEO_DEFAULT_ENCODER } from "./settings";

type PlatformMatchDelegate = (systemInformation: Systeminformation.SystemData, osInformation: Systeminformation.OsData) => boolean;

type PlatformEncoderConfiguration = {
  isMatch: PlatformMatchDelegate; // The delegate that attempt to identify the platform
  videoEncoder: string; // The encoder to use
}

const PlatformEncoderConfigurations: PlatformEncoderConfiguration[] = [
  {
    isMatch: (systemInformation, osInformation): boolean =>
      !systemInformation.virtual && 
      osInformation.arch === "arm" && // Only 32bit environments are supported with HW acceleration at this time
      systemInformation.model.startsWith("Raspberry Pi 3"),
    videoEncoder: "h264_omx"
  },
  {
    isMatch: (systemInformation, osInformation): boolean =>
      !systemInformation.virtual && 
      osInformation.arch === "arm" && // Only 32bit environments are supported with HW acceleration at this time
      systemInformation.model.startsWith("Raspberry Pi 4"),
    videoEncoder: "h264_omx"
  }
];

export class ProtectPlatformSettings {
  private readonly log: Logging;
  private readonly videoProcessor: string;

  constructor(logger: Logging, videoProcessor: string) {
    this.log = logger;
    this.videoProcessor = videoProcessor;
  }

  public async configurePlatformEncoder(): Promise<string> {
    try {
      const sysInformation = await system();
      const osInformation = await osInfo();

      const preferredPlatformEncoder = PlatformEncoderConfigurations.find(platform => 
        platform.isMatch(sysInformation, osInformation))?.videoEncoder;
      
      if (!preferredPlatformEncoder) {
        this.log.error("Hardware acceleration is enabled but no platform support is defined for this system. Using default encoder '%s'.",
          PROTECT_FFMPEG_VIDEO_DEFAULT_ENCODER);
        return PROTECT_FFMPEG_VIDEO_DEFAULT_ENCODER;
      }

      if (await FfmpegProcess.codecEnabled(this.videoProcessor, preferredPlatformEncoder)) {
        this.log.info("Using FFmpeg encoder '%s' for this platform.", preferredPlatformEncoder);
        return preferredPlatformEncoder;
      }

      this.log.error("Unable to find FFmpeg support for platform codec '%s'. Using default codec '%s'.", preferredPlatformEncoder, PROTECT_FFMPEG_VIDEO_DEFAULT_ENCODER);
    } catch (_) {
      this.log.error("Unable to detect platform. Using default encoder '%s'.", PROTECT_FFMPEG_VIDEO_DEFAULT_ENCODER);
    }

    return PROTECT_FFMPEG_VIDEO_DEFAULT_ENCODER;
  }
}
