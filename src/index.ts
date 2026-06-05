/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * index.ts: homebridge-unifi-protect plugin registration.
 */
import { PLATFORM_NAME, PLUGIN_NAME } from "./settings.ts";
import type { API } from "homebridge";
import { ProtectPlatform } from "./platform.ts";

// Register our platform with homebridge.
export default (api: API): void => {

  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, ProtectPlatform);
};
