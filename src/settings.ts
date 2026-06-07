/* Copyright(C) 2022-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * settings.ts: Settings and constants for homebridge-unifi-protect.
 */
// The name of our plugin.
export const PLUGIN_NAME = "homebridge-unifi-protect";

// The platform the plugin creates.
export const PLATFORM_NAME = "UniFi Protect";

// Maximum number of consecutive authentication failures tolerated while establishing the initial connection before we stop retrying. A controller that is still
// sorting out its own authentication state at startup recovers within this budget, while genuinely-incorrect credentials fail fast instead of looping forever (the
// v4 defect). Any non-authentication fault (network, transient) resets the budget, so a slow-to-appear controller is retried without bound until it answers. The
// periodic device refresh and the connection backoff that the two former controller-interval constants governed now live inside the unifi-protect client (its
// StateStore refresh failsafe and the retry() default exponential backoff, respectively), so HBUP no longer schedules either.
export const PROTECT_AUTH_FAILURE_LIMIT = 3;

// Default delay, in seconds, before removing Protect devices that no longer exist.
export const PROTECT_DEVICE_REMOVAL_DELAY_INTERVAL = 60;

// Default duration, in milliseconds, of the authentication contact sensor for a Protect doorbell, primarily for automation purposes.
export const PROTECT_DOORBELL_AUTHSENSOR_DURATION = 5000;

// Default duration, in milliseconds, of a physical digital chime attached to a Protect doorbell. This value comes from UniFi Protect itself.
export const PROTECT_DOORBELL_CHIME_DURATION_DIGITAL = 1000;

// Default duration, in milliseconds, to wait before allowing another trigger of the buzzer or speaker on the chime.
export const PROTECT_DOORBELL_CHIME_SPEAKER_DURATION = 3500;

// Default duration, in milliseconds, of the trigger switch for a Protect doorbell, primarily for automation purposes.
export const PROTECT_DOORBELL_TRIGGER_DURATION = 5000;

// FFmpeg afftdn audio filter defaults - this setting uses FFTs to reduce noise in an audio signal by the number of decibels below.
export const PROTECT_FFMPEG_AUDIO_FILTER_FFTNR = 14;

// FFmpeg highpass audio filter defaults - this setting attenuates (eliminates) frequencies below the value.
export const PROTECT_FFMPEG_AUDIO_FILTER_HIGHPASS = 150;

// FFmpeg lowpass audio filter defaults - this setting attenuates (eliminates) frequencies above the value.
export const PROTECT_FFMPEG_AUDIO_FILTER_LOWPASS = 9000;

// Protect's native I-frame interval can vary, but the livestream API seems to default to 5 seconds at most, though it depends on camera type and stream quality selected.
export const PROTECT_LIVESTREAM_API_IDR_INTERVAL = 5;

// Protect fMP4 segment resolution, in milliseconds. This defines the resolution of our buffer. It should never be less than 100ms or greater than 1500ms.
export const PROTECT_SEGMENT_RESOLUTION = 100;

// Livestream recovery urgency the timeshift buffer declares to the v5 pool while a recording is in flight, in milliseconds. Zero is strictly below the recovery
// policy's SOFT_DEFER_STEP_MS (1000ms) active/idle threshold, so an active recording is classified latency-sensitive and reconnects immediately rather than easing
// off a stressed controller - the parity behavior for an in-flight HKSV recording.
export const PROTECT_LIVESTREAM_ACTIVE_TOLERANCE_MS = 0;

// Livestream recovery urgency the timeshift buffer declares to the v5 pool while idle (prebuffering, not transmitting), in milliseconds. This is strictly above the
// recovery policy's SOFT_DEFER_STEP_MS (1000ms) threshold, so an idle prebuffer is classified latency-tolerant and eases off a stressed-but-reachable controller
// rather than piling reconnects onto it. It is also the parity ceiling: the v5 media-stall detection floors at max(urgency, 2000ms), so 2000ms holds idle detection
// exactly at pre-v5's 2-second stall window - a larger value would loosen idle stall detection past that window.
export const PROTECT_LIVESTREAM_IDLE_TOLERANCE_MS = 2000;

// HomeKit Secure Video communication timeout threshold, in milliseconds. HKSV has a strict 5 second threshold for communication, so we set this a little below that.
export const PROTECT_HKSV_TIMEOUT = 4500;

// Shadow adaptive-urgency-B parameters for the HKSV reserve-depth telemetry. These three constants are NOT a live recovery policy: they exist only so the telemetry
// teardown log can report, side by side with the shipped fixed urgency, what an adaptive "urgency B" would have declared given the reserve depth the event actually
// observed. The shadow formula is reserveMs = meanReserve * segmentLength; B = clamp(reserveMs - reconnectTime - safety, FLOOR, reserveMs). It models the idea that
// the recovery tolerance could be derived from how deep the FFmpeg-produced-but-unpulled reserve ran during the event - the deeper the reserve, the longer a stall the
// recording could absorb, and the more tolerance the pool could be granted. A maintainer compares B against the shipped fixed urgency to evaluate whether such a
// design is worth pursuing. It is an offline estimate computed at teardown for comparison only and never feeds the live recovery-await derivation.

// Shadow reconnect-floor term, in milliseconds. We mirror the v5 pool's AWAIT_MIN_MS (3000ms) reconnect floor: any tolerance we would grant must first cover the
// minimum time the pool takes to re-establish a livestream, otherwise the recording would drain its reserve before the wire recovered.
export const PROTECT_HKSV_SHADOW_RECONNECT_MS = 3000;

// Shadow jitter-margin term, in milliseconds. A small additional cushion subtracted alongside the reconnect floor to absorb scheduling and poll-granularity jitter in
// the reconnect timing, so the shadow tolerance does not assume a perfectly punctual recovery.
export const PROTECT_HKSV_SHADOW_SAFETY_MS = 500;

// Shadow tolerance floor, in milliseconds. The minimum tolerance the shadow formula will ever report, matching the active-recording tolerance floor (0ms) so a
// shallow reserve clamps to "reconnect immediately" exactly as the shipped active urgency does, rather than going negative.
export const PROTECT_HKSV_SHADOW_FLOOR_MS = PROTECT_LIVESTREAM_ACTIVE_TOLERANCE_MS;

// HomeKit Secure Video timeshift buffer default duration, in milliseconds. This defines how far back in time we can look when we see a motion event.
export const PROTECT_HKSV_TIMESHIFT_BUFFER_MAXDURATION = PROTECT_LIVESTREAM_API_IDR_INTERVAL * 1000 * 2;

// Default port to use to publish an M3U playlist for use in other apps that can consume one to make camera livestreams available, such as Channels DVR.
export const PROTECT_M3U_PLAYLIST_PORT = 10110;

// Default duration, in seconds, of motion events. Setting this too low will potentially cause a lot of notification spam.
export const PROTECT_MOTION_DURATION = 10;

// Default MQTT topic to use when publishing events. This is in the form of: unifi/protect/camera/event
export const PROTECT_MQTT_TOPIC = "unifi/protect";

// Default duration, in seconds, of occupancy events.
export const PROTECT_OCCUPANCY_DURATION = 300;

// Minimum required GPU memory on a Raspberry Pi for hardware acceleration.
export const PROTECT_RPI_GPU_MINIMUM = 128;

// Maximum age of a snapshot in seconds.
export const PROTECT_SNAPSHOT_CACHE_MAXAGE = 90;

// Timeout for snapshot acquisition, in milliseconds. HomeKit enforces a 5000ms hard limit on snapshot requests. We budget 10ms of overhead for the response to
// reach HomeKit after our code produces the snapshot.
export const PROTECT_SNAPSHOT_TIMEOUT = 4990;

// Bitrate, in kilobits per second, to use when transcoding to local clients.
export const PROTECT_TRANSCODE_BITRATE = 2000;

// Default interval, in hours, for scheduled NVR reboots when enabled.
export const PROTECT_NVR_REBOOT_INTERVAL = 6;

// Minimum interval, in hours, allowed for scheduled NVR reboots.
export const PROTECT_NVR_REBOOT_MIN_INTERVAL = 1;

// Settle delay, in milliseconds, before a globally-disabled controller unregisters its cached accessories. The inline comment at the consuming call site reads "thirty
// seconds" - the original intent - but the pre-collapse code passed sleep(30), which is 30 ms (sleep is node:timers/promises, so its argument is milliseconds). This
// names the intended thirty-second settle window so all the accessories have a chance to finish loading at startup before we tear them down.
export const PROTECT_NVR_CONTROLLER_DISABLED_SETTLE_DELAY = 30000;

// Grace period, in milliseconds, to confirm a reboot command actually took effect. A genuine reboot drops the controller's realtime connection within seconds, so 60 s
// is generous headroom over the real drop latency yet far below the recovery track's first probe. This is a "did the command take effect" latency, NOT a recovery
// deadline: if, after this grace, the connection is still perfectly healthy, the controller never restarted (a silent no-op accept) and we resume normal monitoring.
export const PROTECT_NVR_REBOOT_CONFIRM_GRACE_MS = 60000;

// Maximum cumulative duration, in seconds, that a scheduled reboot may be deferred while cameras are actively recording HKSV events. Once this elapses, the
// reboot fires regardless of in-flight recordings - we cannot let an open-ended series of HKSV events postpone a controller reboot indefinitely.
export const PROTECT_NVR_REBOOT_DEFERRAL_MAX = 15 * 60;

// Minimum duration, in milliseconds, that the controller must be continuously available and healthy before HBUP will perform any destructive device removal. A fixed
// safety floor (not user-configurable): no device is removed until the controller has been in a good state this long, so a freshly-recovered or freshly-rebooted
// controller never triggers a removal while it is still settling and re-adopting its devices.
export const PROTECT_NVR_REMOVAL_STABILITY_WINDOW = 600000;

// Bitrate, in kilobits per second, to use when transcoding to high-latency clients.
export const PROTECT_TRANSCODE_HIGH_LATENCY_BITRATE = 1000;
