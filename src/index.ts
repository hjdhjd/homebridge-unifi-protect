/* Copyright(C) 2017-2023, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * index.ts: homebridge-unifi-protect plugin registration.
 */
import { PLATFORM_NAME, PLUGIN_NAME } from "./settings.js";
import { API } from "homebridge";
import { ProtectPlatform } from "./protect-platform.js";

// Register our platform with homebridge.
export default (api: API): void => {

  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, ProtectPlatform);
};
