/* Copyright(C) 2020-2022, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-options.ts: Type definitions for UniFi Protect.
 */

// Plugin configuration options.
export interface ProtectOptions {
  controllers: ProtectNvrOptions[],
  debugAll: boolean,
  ffmpegOptions: string[],
  motionDuration: number,
  options: string[],
  ringDuration: number,
  verboseFfmpeg: boolean,
  videoEncoder: string,
  videoProcessor: string
}

// NVR configuration options.
export interface ProtectNvrOptions {
  address: string,
  doorbellMessages: {
    duration: number,
    message: string
  }[],
  mqttTopic: string,
  mqttUrl: string,
  name: string,
  refreshInterval: number,
  username: string,
  password: string
}
