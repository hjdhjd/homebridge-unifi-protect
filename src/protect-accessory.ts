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
import { ProtectApi } from "./protect-api";
import { ProtectNvr } from "./protect-nvr";
import { ProtectPlatform } from "./protect-platform";
import { ProtectCameraConfig } from "./protect-types";

// List the optional methods of our subclasses that we want to expose commonly.
export interface ProtectAccessory {
  configureDoorbellLcdSwitch?(): boolean;
}

export abstract class ProtectBase {
  public readonly api: API;
  public debug: (message: string, ...parameters: unknown[]) => void;
  protected readonly hap: HAP;
  protected readonly log: Logging;
  public readonly nvr: ProtectNvr;
  public nvrApi: ProtectApi;
  public readonly platform: ProtectPlatform;

  // The constructor initializes key variables and calls configureDevice().
  constructor(nvr: ProtectNvr) {
    this.api = nvr.platform.api;
    this.debug = nvr.platform.debug.bind(this);
    this.hap = this.api.hap;
    this.log = nvr.platform.log;
    this.nvr = nvr;
    this.nvrApi = nvr.nvrApi;
    this.platform = nvr.platform;
  }

  // Utility function to return the fully enumerated name of this camera.
  public name(): string {
    return this.nvr.nvrApi.getNvrName();
  }
}

export abstract class ProtectAccessory extends ProtectBase {
  public readonly accessory: PlatformAccessory;

  // The constructor initializes key variables and calls configureDevice().
  constructor(nvr: ProtectNvr, accessory: PlatformAccessory) {

    // Call the constructor of our base class.
    super(nvr);

    // Set the accessory.
    this.accessory = accessory;

    // Configure the device.
    void this.configureDevice();
  }

  // All accessories require a configureDevice function. This is where all the
  // accessory-specific configuration and setup happens.
  protected abstract async configureDevice(): Promise<boolean>;

  // Utility function to return the fully enumerated name of this camera.
  public name(): string {
    return this.nvr.nvrApi.getFullName((this.accessory.context.camera as ProtectCameraConfig) ?? null);
  }
}
