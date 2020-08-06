/* Copyright(C) 2017-2020, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * settings.ts: Settings and constants for homebridge-unifi-protect2.
 */
// The name of our plugin.
export const PLUGIN_NAME = "homebridge-unifi-protect2";

// The platform the plugin creates.
export const PLATFORM_NAME = "UniFi Protect";

// Magic incantantion to further streamline ffmpeg for Protect.
export const PROTECT_FFMPEG_OPTIONS = "-probesize 32 -analyzeduration 0 -fflags nobuffer -refs 1 -x264-params intra-refresh=1:bframes=0";

// Default duration of motion events. Setting this too low will potentially cause a lot of notification spam.
export const PROTECT_MOTION_DURATION = 10;

// How often should we check Protect NVRs for new or removed devices.
// This will NOT impact motion and event detection on UniFi OS devices.
export const PROTECT_NVR_UNIFIOS_REFRESH_INTERVAL = 10;

// How often should we check UniFi Cloud Key Gen2+ Protect NVRs for motion, other events, or new or removed devices.
// This WILL impact motion and event detection resolution on UCK Gen2+ NVRs.
export const PROTECT_NVR_UCK_REFRESH_INTERVAL = 5;

// Number of API errors to accept before we implement backoff so we don't slam a Protect controller.
export const PROTECT_API_ERROR_LIMIT = 10;

// Amount, in seconds, to wait before trying to access the API again once we've hit the PROTECT_API_ERROR_LIMIT threshold.
export const PROTECT_API_RETRY_TIME = 300;
