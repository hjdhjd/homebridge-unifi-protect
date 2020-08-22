/* Copyright(C) 2017-2020, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-accessory.ts: Base class for all UniFi Protect accessories.
 */
import {
  API,
  HAP,
  Logging,
  PlatformAccessory
} from "homebridge";
import { ProtectNvr } from "./protect-nvr";
import { ProtectPlatform } from "./protect-platform";

// List our optional methods in our subclasses.
export interface ProtectAccessory {
  configureDoorbellLcdSwitch?(): Promise<boolean>;
}

export abstract class ProtectAccessory {
  readonly accessory: PlatformAccessory;
  readonly api: API;
  debug: (message: string, ...parameters: any[]) => void;
  protected readonly debugMode: boolean;
  protected readonly hap: HAP;
  protected readonly log: Logging;
  readonly nvr: ProtectNvr;
  readonly platform: ProtectPlatform;

  // The constructor initializes key variables and calls configureDevice().
  constructor(nvr: ProtectNvr, accessory: PlatformAccessory) {
    this.accessory = accessory;
    this.api = nvr.platform.api;
    this.debug = nvr.platform.debug.bind(this);
    this.debugMode = nvr.platform.debugMode;
    this.hap = this.api.hap;
    this.log = nvr.platform.log;
    this.nvr = nvr;
    this.platform = nvr.platform;

    this.configureDevice();
  }

  // All accessories require a configureDevice function. This is where all the
  // accessory-specific configuration and setup happens.
  protected abstract async configureDevice(): Promise<boolean>;
}
