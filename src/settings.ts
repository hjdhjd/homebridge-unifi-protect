/* Copyright(C) 2017-2021, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * settings.ts: Settings and constants for homebridge-unifi-protect.
 */
// The name of our plugin.
export const PLUGIN_NAME = "homebridge-unifi-protect";

// The platform the plugin creates.
export const PLATFORM_NAME = "UniFi Protect";

// FFmpeg highpass audio filter defaults - this setting attenuates (eliminates) frequencies below the value.
export const PROTECT_FFMPEG_AUDIO_FILTER_HIGHPASS = 200;

// FFmpeg lowpass audio filter defaults - this setting attenuates (eliminates) frequencies above the value.
export const PROTECT_FFMPEG_AUDIO_FILTER_LOWPASS = 1000;

// Magic incantantion to further streamline FFmpeg for Protect.
export const PROTECT_FFMPEG_OPTIONS = [];

// Duration, in minutes, to increase the level of logging for FFmpeg when we encounter errors.
export const PROTECT_FFMPEG_VERBOSE_DURATION = 5;

// Default duration, in seconds, of motion events. Setting this too low will potentially cause a lot of notification spam.
export const PROTECT_MOTION_DURATION = 10;

// How often, in seconds, should we try to reconnect with an MQTT broker, if we have one configured.
export const PROTECT_MQTT_RECONNECT_INTERVAL = 60;

// Default MQTT topic to use when publishing events. This is in the form of: unifi/protect/camera/event
export const PROTECT_MQTT_TOPIC = "unifi/protect";

// How often, in seconds, should we check Protect controllers for new or removed devices.
// This will NOT impact motion or doorbell event detection on UniFi OS devices.
export const PROTECT_NVR_UNIFIOS_REFRESH_INTERVAL = 10;

// How often, in seconds, should we heartbeat FFmpeg in two-way audio sessions. This should be less than 5 seconds, which is
// FFmpeg's input timeout interval.
export const PROTECT_TWOWAY_HEARTBEAT_INTERVAL = 3.5;
