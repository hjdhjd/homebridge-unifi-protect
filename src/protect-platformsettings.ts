/* Copyright(C) 2021, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-platformsettings.ts: Platform configuration for transcoding settings
 *
 */
import { osInfo, system, Systeminformation } from 'systeminformation';

type PlatformMatchDelegate = (systemInformation: Systeminformation.SystemData, osInformation: Systeminformation.OsData) => boolean;

type PlatformEncoderConfiguration = {
  isMatch: PlatformMatchDelegate; // The delegate that attempt to identify the platform
  videoEncoder: string; // The encoder to use
}

export const PlatformEncoderConfigurations: PlatformEncoderConfiguration[] = [
  {
    isMatch: (systemInformation, osInformation) =>
      !systemInformation.virtual && 
      osInformation.arch == "arm" && // Only 32bit environments are supported with HW acceleration at this time
      systemInformation.model.startsWith("Raspberry Pi 3"),
    videoEncoder: "h264_omx"
  },
  {
    isMatch: (systemInformation, osInformation) =>
      !systemInformation.virtual && 
      osInformation.arch == "arm" && // Only 32bit environments are supported with HW acceleration at this time
      systemInformation.model.startsWith("Raspberry Pi 4"),
    videoEncoder: "h264_omx"
  }
]

