/* Copyright(C) 2022-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * settings.ts: Settings and constants for homebridge-unifi-protect.
 */
// The name of our plugin.
export const PLUGIN_NAME = "homebridge-unifi-protect";

// The platform the plugin creates.
export const PLATFORM_NAME = "UniFi Protect";

// The waits, in milliseconds, between attempts to connect while the controller refuses the configured sign-in: no staged delays, and one steady interval between
// every attempt for as long as the refusal lasts. A refusal is a fact about the credentials rather than the network - the controller answered, and asking again
// moments later cannot change its answer - and UniFi OS locks an account after repeated failed sign-ins, so a wrong password retried at the network schedule's pace
// could lock the owner out of the controller's own interface. The attempts stay this far apart for that reason, and no further, so a sign-in the controller starts
// accepting again is picked up within one interval. The shape is the library's recovery schedule's, staged delays and a steady floor, so the connect retry holds
// each schedule the same way.
export const PROTECT_CONNECT_REFUSAL_SCHEDULE_MS = { backoff: [], steady: 300000 } as const;

// Default delay, in seconds, before removing Protect devices that no longer exist.
export const PROTECT_DEVICE_REMOVAL_DELAY_INTERVAL = 60;

// Default duration, in milliseconds, of the authentication contact sensor for a Protect doorbell, primarily for automation purposes.
export const PROTECT_DOORBELL_AUTHSENSOR_DURATION = 5000;

// Default duration, in milliseconds, of a physical digital chime attached to a Protect doorbell. This value comes from UniFi Protect itself.
export const PROTECT_DOORBELL_CHIME_DURATION_DIGITAL = 1000;

// Default duration, in milliseconds, to wait before allowing another trigger of the buzzer or speaker on the chime.
export const PROTECT_DOORBELL_CHIME_SPEAKER_DURATION = 3500;

// Suggested ring-suppression window, in seconds, pre-filled when a user enables the doorbell ring delay option. The option itself defaults off, so a configuration that
// never enables it keeps today's behavior of delivering every ring event as it arrives.
export const PROTECT_DOORBELL_RING_DELAY = 15;

// Default duration, in milliseconds, of the trigger switch for a Protect doorbell, primarily for automation purposes.
export const PROTECT_DOORBELL_TRIGGER_DURATION = 5000;

// FFmpeg afftdn audio filter defaults - this setting uses FFTs to reduce noise in an audio signal by the number of decibels below.
export const PROTECT_FFMPEG_AUDIO_FILTER_FFTNR = 14;

// FFmpeg highpass audio filter defaults - this setting attenuates (eliminates) frequencies below the value.
export const PROTECT_FFMPEG_AUDIO_FILTER_HIGHPASS = 150;

// FFmpeg lowpass audio filter defaults - this setting attenuates (eliminates) frequencies above the value.
export const PROTECT_FFMPEG_AUDIO_FILTER_LOWPASS = 9000;

// Delay, in milliseconds, before a deferred write reflects a characteristic's true state back to HomeKit after a set handler returns. It only has to clear HAP's own
// write of the requested value, so it stays short enough that the correction reads as part of the tap.
export const PROTECT_HOMEKIT_REFLECT_DELAY = 50;

// Ceiling, in bytes, on the probesize a camera's self-tuning will ever elevate to. This sits far above any probesize FFmpeg has needed in practice, so it bounds the
// repeated doubling without meaningfully limiting our ability to recover from a difficult stream.
export const PROTECT_PROBESIZE_OVERRIDE_MAX = 5000000;

// Number of probesize adjustments, over the life of a camera's streaming delegate, after which the elevated probesize stays in place for good. Enough attempts to tell
// a one-off hiccup apart from a persistently flaky stream, before we stop paying the cost of resetting the override on every attempt.
export const PROTECT_PROBESIZE_OVERRIDE_PERMANENT_THRESHOLD = 10;

// Delay, in milliseconds, before a temporary probesize override clears itself back to the camera's baseline - long enough for a transient stream irregularity to have
// passed, so the next stream attempt is not still paying the elevated probesize's startup latency for a problem that is over.
export const PROTECT_PROBESIZE_OVERRIDE_RESET_MS = 1000 * 60 * 10;

// Protect's native I-frame interval can vary, but the livestream API seems to default to 5 seconds at most, though it depends on camera type and stream quality selected.
export const PROTECT_LIVESTREAM_API_IDR_INTERVAL = 5;

// Protect fMP4 segment resolution, in milliseconds. This defines the resolution of our buffer. It should never be less than 100ms or greater than 1500ms.
export const PROTECT_SEGMENT_RESOLUTION = 100;

// Livestream recovery urgency the timeshift buffer declares to the unifi-protect library's livestream pool while a recording is in flight, in milliseconds.
// Zero is strictly below the recovery policy's SOFT_DEFER_STEP_MS (1000ms) active/idle threshold, so an active recording is classified latency-sensitive and
// reconnects immediately rather than easing off a stressed controller - the parity behavior for an in-flight HKSV recording.
export const PROTECT_LIVESTREAM_ACTIVE_TOLERANCE_MS = 0;

// Livestream recovery urgency the timeshift buffer declares to the unifi-protect library's livestream pool while idle (prebuffering, not transmitting), in
// milliseconds. This is strictly above the recovery policy's SOFT_DEFER_STEP_MS (1000ms) threshold, so an idle prebuffer is classified latency-tolerant and
// eases off a stressed-but-reachable controller rather than piling reconnects onto it. It is also the parity ceiling: the unifi-protect library's media-stall
// detection floors at max(urgency, 2000ms), so 2000ms holds idle detection exactly at the established 2-second stall window - a larger value would loosen idle
// stall detection past that window.
export const PROTECT_LIVESTREAM_IDLE_TOLERANCE_MS = 2000;

// Shadow reserve-depth urgency telemetry parameters for HKSV recovery. These constants are NOT a live recovery policy: they exist only so the telemetry
// teardown log can report, side by side with the shipped fixed urgency, what a reserve-depth-adaptive urgency would have declared given the reserve depth the
// event actually observed. The shadow formula is reserveMs = meanReserve * segmentLength; shadowUrgency = clamp(reserveMs - reconnectTime - safety, FLOOR,
// reserveMs). It models the idea that the recovery tolerance could be derived from how deep the FFmpeg-produced-but-unpulled reserve ran during the event - the
// deeper the reserve, the longer a stall the recording could absorb, and the more tolerance the pool could be granted. A maintainer compares the shadow urgency
// against the shipped fixed urgency to evaluate whether such a design is worth pursuing. It is an offline estimate computed at teardown for comparison only and
// never feeds the live recovery-await derivation.

// Shadow reconnect-floor term, in milliseconds. We mirror the unifi-protect library's pool AWAIT_MIN_MS (3000ms) reconnect floor: any tolerance we would grant
// must first cover the minimum time the pool takes to re-establish a livestream, otherwise the recording would drain its reserve before the wire recovered.
export const PROTECT_HKSV_SHADOW_RECONNECT_MS = 3000;

// Shadow jitter-margin term, in milliseconds. A small additional cushion subtracted alongside the reconnect floor to absorb scheduling and poll-granularity jitter in
// the reconnect timing, so the shadow tolerance does not assume a perfectly punctual recovery.
export const PROTECT_HKSV_SHADOW_SAFETY_MS = 500;

// Shadow tolerance floor, in milliseconds. The minimum tolerance the shadow formula will ever report, matching the active-recording tolerance floor (0ms) so a
// shallow reserve clamps to "reconnect immediately" exactly as the shipped active urgency does, rather than going negative.
export const PROTECT_HKSV_SHADOW_FLOOR_MS = PROTECT_LIVESTREAM_ACTIVE_TOLERANCE_MS;

// Standing timeshift buffer depth, in milliseconds. Sized at twice the livestream API's I-frame interval so the rolling buffer always retains at least one keyframe for
// every consumer it feeds - HomeKit Secure Video event look-back, buffer-backed live views, and snapshots.
export const PROTECT_TIMESHIFT_BUFFER_MAXDURATION = PROTECT_LIVESTREAM_API_IDR_INTERVAL * 1000 * 2;

// The channel-selection target for a pixel-constrained hardware encoder (such as a Raspberry Pi): the substrate channel policy picks the highest-quality channel at or
// below this on such a host. Deliberately not named with "RESOLUTION" - in this file that word denotes the buffer's time-granularity, not a pixel dimension.
export const PROTECT_TIMESHIFT_CONSTRAINED_HOST_TARGET = { height: 1080, width: 1920 };

// The richest source we ever ask a camera for when we are hunting a maximum-quality channel rather than one matched to a requested size. Shared by the transcode
// dimension bias (a hardware encoder performs better fed a high-bitrate source) and the high-resolution snapshot path, so both hunt against the same ceiling.
export const PROTECT_MAX_SOURCE_HEIGHT = 2160;
export const PROTECT_MAX_SOURCE_WIDTH = 3840;

// Default port to use to publish an M3U playlist for use in other apps that can consume one to make camera livestreams available, such as Channels DVR.
export const PROTECT_M3U_PLAYLIST_PORT = 10110;

// Default duration, in seconds, of motion events. Setting this too low will potentially cause a lot of notification spam.
export const PROTECT_MOTION_DURATION = 10;

// Default MQTT topic to use when publishing events. This is in the form of: unifi/protect/camera/event
export const PROTECT_MQTT_TOPIC = "unifi/protect";

// Duration, in milliseconds, after which an unconfirmed relay-output toggle intent is dropped. A relay output has only a faithful toggle primitive that is write-through:
// the plugin records the state it is driving an output toward so a rapid second tap decides against where the output is headed rather than the pre-toggle controller
// value that lags until the broadcast lands. This is the bounded safety window for that recorded intent - if the controller never confirms it within this window (a lost
// broadcast), the intent is dropped so a stuck record can never wedge the switch. A few seconds comfortably covers the observed write-through latency plus margin.
export const PROTECT_RELAY_COMMAND_TIMEOUT = 5000;

// Default duration, in seconds, of occupancy events.
export const PROTECT_OCCUPANCY_DURATION = 300;

// Minimum required GPU memory on a Raspberry Pi for hardware acceleration.
export const PROTECT_RPI_GPU_MINIMUM = 128;

// Bitrate, in kilobits per second, to use when transcoding to local clients.
export const PROTECT_TRANSCODE_BITRATE = 2000;

// Default interval, in hours, for scheduled NVR reboots when enabled.
export const PROTECT_NVR_REBOOT_INTERVAL = 6;

// Minimum interval, in hours, allowed for scheduled NVR reboots.
export const PROTECT_NVR_REBOOT_MIN_INTERVAL = 1;

// Grace period, in milliseconds, to confirm a reboot command actually took effect. A genuine reboot drops the controller's realtime connection within seconds, so 60 s
// is generous headroom over the real drop latency yet far below the recovery track's first probe. This is a "did the command take effect" latency, NOT a recovery
// deadline: if, after this grace, the connection is still perfectly healthy, the controller never restarted (a silent no-op accept) and we resume normal monitoring.
export const PROTECT_NVR_REBOOT_CONFIRM_GRACE_MS = 60000;

// Maximum cumulative duration, in seconds, that a scheduled reboot may be deferred while cameras are actively recording HKSV events. Once this elapses, the
// reboot fires regardless of in-flight recordings - we cannot let an open-ended series of HKSV events postpone a controller reboot indefinitely.
export const PROTECT_NVR_REBOOT_DEFERRAL_MAX = 15 * 60;

// Cadence, in milliseconds, at which a deferred or failed scheduled reboot re-checks whether it can proceed. It paces the chain the ceiling above bounds: each check
// either finds the recordings finished and reboots, or defers again until that ceiling elapses. The initial-delay floor happens to share this value but is a different
// concept - the settling room a freshly-connected plugin gives a long-up controller - so it stays inline with the arithmetic that applies it.
export const PROTECT_NVR_REBOOT_CHECK_INTERVAL = 60000;

// Window, in milliseconds, after the plugin observes a controller reboot within which the reboot's after-effects are treated as that reboot's settling tail rather than
// as anything wrong with an individual camera. It carries both halves of that idea: a disruption inside the window is expected, so it stays quiet instead of warning,
// and a camera still away when the window expires has stopped being explainable by the reboot and is the exception worth telling the user about. Measured from our OWN
// observation of the reboot (the library's jitter-thresholded `controllerRebooted` event), not the controller's self-reported boot time. The live trace showed roughly
// twelve seconds from the observed reboot to the camera's re-establishment edge, so sixty seconds covers slower re-establishment while keeping the window tight - which
// matters in both directions, since the same window decides how long a genuine single-camera drop is held quiet and how long a camera has to come back before we say so.
export const PROTECT_NVR_REBOOT_RECENCY_MS = 60000;

// Minimum duration, in milliseconds, that the controller must be continuously available and healthy before the plugin will perform any destructive device
// removal. A fixed safety floor (not user-configurable): no device is removed until the controller has been in a good state this long, so a freshly-recovered
// or freshly-rebooted controller never triggers a removal while it is still settling and re-adopting its devices.
export const PROTECT_NVR_REMOVAL_STABILITY_WINDOW = 600000;

// Bitrate, in kilobits per second, to use when transcoding to high-latency clients.
export const PROTECT_TRANSCODE_HIGH_LATENCY_BITRATE = 1000;
