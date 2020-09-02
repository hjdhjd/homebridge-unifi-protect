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

// List the optional methods of our subclasses that we want to expose commonly.
export interface ProtectAccessory {
  configureDoorbellLcdSwitch?(): boolean;
}

export abstract class ProtectAccessory {
  public readonly accessory: PlatformAccessory;
  public readonly api: API;
  public debug: (message: string, ...parameters: unknown[]) => void;
  protected readonly debugMode: boolean;
  protected readonly hap: HAP;
  protected readonly log: Logging;
  public readonly nvr: ProtectNvr;
  public readonly platform: ProtectPlatform;

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

    void this.configureDevice();
  }

  // All accessories require a configureDevice function. This is where all the
  // accessory-specific configuration and setup happens.
  protected abstract async configureDevice(): Promise<boolean>;

  // Utility function to return the fully enumerated name of this camera.
  public name(): string {
    return this.nvr.nvrApi.getFullName(this.accessory.context.camera ?? null);
  }
}
