# Changelog

All notable changes to this project will be documented in this file. This project uses [semantic versioning](https://semver.org/).

## 7.26.0 (2026-01-02)
  * Improvement: handle infrared filter-only use cases for night vision automation dimmer. You can use the dimmer to adjust the sensitivity level of when Protect will trigger infrared settings. 0% disables infrared, 5% sets it to infrared filter-only (no infrared LEDs), 10% sets it to auto, 20-90% reflect the states you would find through the Protect webUI at increasing levels of sensitivity, 100% sets infrared always on.
  * Improvement: when using the playlist feature, HBUP now filters out AV1 streams that can't be played by Channels DVR.
  * Improvement: minor webUI enhancements.
  * Fix: temperature sensors now correctly report temperatures below 0C/32F. I missed the behavior change by Ubiquiti in Protect v6 - sorry about that!
  * Housekeeping.

## 7.25.0 (2025-11-10)
  * New feature: you can now configure the leak sensors to be exposed as moisture sensors. This makes them available as contact sensors rather than leak sensors in HomeKit, allowing you to use them for various automation scenarios.
  * Housekeeping.

## 7.24.1 (2025-09-27)
  * Housekeeping.

## 7.24.0 (2025-09-15)
  * New feature: HBUP now supports tamper detection for Protect cameras (Ubiquiti has enabled this currently AI and G6 series it seems). Unlike Protect sensors, cameras only log a tamper event without flagging the device as “tampered.” In HBUP, if a tamper event is detected, you can clear it by either disabling and re-enabling tamper detection in the Protect web UI (under Recording Settings) or by restarting HBUP. Tampering status can be seen by pulling up the detail view of the motion sensor on the Protect camera (unfortunately the only place one can do this in HomeKit that makes sense for HBUP).
  * Improvement: FFmpeg 8 is now bundled in with HBUP, providing some additional (minor) performance improvements when using hardware acceleration.
  * Housekeeping.

## 7.23.2 (2025-09-05)
  * Fix: address a streaming regression for Raspberry Pi 4 users.
  * Housekeeping.

## 7.23.1 (2025-09-04)
  * Housekeeping.

## 7.23.0 (2025-09-04)
  * New feature: support for the new SuperLink sensors.
  * Breaking change: for those using UniFi sensors as leak sensors, you may need to disable and re-enable the leak sensor in the Protect webUI, or disable the device in HBUP prior to upgrading and then re-enable it. Due to the new SuperLink sensors, the way HBUP makes leak sensors available had to change in a way that might break for prior versions. Sorry about that!
  * New feature: this has been in place in HBUP for a few releases, but you now have the ability to disable HBUP's self-healing abilities per-device. By default, if a camera is misbehaving for an extended period of time under certain, limited circumstances, HBUP will attempt to restart the camera to get it working properly. Found under device feature options.
  * Housekeeping.

## 7.22.0 (2025-09-01)
  * Improvement: audio noise filters have been completely refactored (with [updated documentation](https://github.com/hjdhjd/homebridge-unifi-protect/blob/main/docs/AudioOptions.md)). I would recommend folks use this in environments where you have your cameras outdoors. I've been testing and tweaking this for a few weeks and the defaults should work quite nicely for most.
  * Improvement: if you have noise filters enabled, they'll be applied to HKSV events as well now.
  * Improvement: the HBUP webUI will now remember which categories you've left collapsed and expanded.
  * Fix: addressed regressions in audio latency.
  * Housekeeping.

## 7.21.0 (2025-08-08)
  * New feature: the ability to mute HomeKit doorbell chimes. It's available as a feature option under the `Doorbell` category. This will allow you to turn off having your HomePod chimes ring when someone rings your doorbell, selectively. Defaults to off.
  * Improvement: complete overhaul of feature option webUI. Improved the user interface, added the ability to search for feature options, filter on what's changed, and reset options.
  * Improvement: added additional resiliency to the livestream API connection to cameras. When cameras are continuously misbehaving, HBUP will attempt to restart them if their livestream API connection keeps timing out continuously. This should very rarely occur unless Ubiquiti releases a particularly problematic firmware release.
  * Improvement: The occupancy sensor feature option will now use both person and face to detect presence now, by default, on cameras that support it. As always, you can adjust these to your heart's content.
  * Housekeeping.

## 7.20.1 (2025-07-15)
  * Fix: address livestreaming regressions.
  * Housekeeping.

## 7.20.0 (2025-07-14)
  * Improvement: macOS users will see further improvements to video quality when API livestreaming.
  * Housekeeping.

## 7.19.2 (2025-06-25)
  * Housekeeping.

## 7.19.1 (2025-06-24)
  * Fix: address regressions in smart motion detection due to Protect v6 changes.
  * Housekeeping.

## 7.19.0 (2025-06-22)
  * **Note: HBUP now requires Protect v6 as if this release. Prior versions of Protect are no longer supported.**
  * Improvement: refined MQTT smart motion telemetry when there are additional attributes available (license plates, vehicle type, color, etc).
  * Fix: address regressions in smart motion detection due to Protect v6 changes.
  * Housekeeping.

## 7.18.1 (2025-06-21)
  * **Note: this will be the final version of HBUP to support Protect v5. Protect v6 has several breaking changes that I'll be addressing in future updates, most notably in the way smart event detection works in v6. Stay tuned for those updates.**
  * Fix: address a regression in Protect sensors due to changes in Protect v6.

## 7.18.0 (2025-06-17)
  * New feature: UniFi Protect v6 support.
  * Improvement: livestreaming optimizations.
  * Housekeeping.

## 7.17.5 (2025-06-02)
  * Housekeeping.

## 7.17.4 (2025-06-02)
  * Behavior change: MQTT events will be published for smart object detection, whether or not a user has enabled smart object sensors.
  * Housekeeping.

## 7.17.3 (2025-06-01)
  * Fix: address a regression in recent releases that caused doorbell package cameras to not see motion events.
  * Housekeeping.

## 7.17.2 (2025-05-29)
  * Fix: address audio regressions in HKSV.
  * Housekeeping.

## 7.17.1 (2025-05-26)
  * Fix: hardware-accelerated HKSV and snapshots for Intel QSV.
  * Housekeeping.

## 7.17.0 (2025-05-22)
  * Improvement: refined audio quality when livestreaming.
  * Fix: Workaround regressions in Apple's native audio encoder in recent macOS releases.
  * Housekeeping.

## 7.16.1 (2025-05-18)
  * Fix: Livestreaming resilience regressions.
  * Housekeeping.

## 7.16.0 (2025-05-18)
 * Improvement: further refinements to livestreaming.
 * Fix: Corrected a regression in MQTT set events for doorbells and lights that weren't being properly.
 * Housekeeping.

## 7.15.0 (2025-04-22)
  * New feature: Send two-way audio directly to supported cameras, bypassing the controller. Useful for working around bugs in some Protect controller firmware versions. It's disabled by default and requires ensuring that HBUP can access the camera directly over your network (for obvious reasons). Why is this useful? Well...Protect can be flaky with two-way audio in the API-supported mechanism it provides. Protect's been addressing this by disabling functionality in the native Protect app in recent releases because there's some bugginess in the controller. For instance, if you use HEVC (aka enhanced encoding) for a camera that supports two-way audio, you can't use the native Protect app to send two-way audio. It's disabled by default because this should really not be needed (maybe one day?), but it is for some users and use cases.
  * Housekeeping.

## 7.14.0 (2025-04-20)
  * New feature: Third party cameras connected paired with an AI Port can be used for HKSV. An AI Port provides the necessary Protect plumbing to generate motion events and smart motion events from third party cameras. If a camera is no longer paired with an AI Port, HKSV support for it will be disabled.
  * Improvement: I've reverted a set of optimizations I made last year to HKSV that cause audio and occasional video issues in recorded events. The result should be a smoother HKSV event recording experience at the expense of some minor additional CPU overhead. Seems that hardware accelerated video decoding in FFmpeg doesn't like the particular way HKSV prefers things. Thanks to @mn7474 for persistently raising the issue and having a sharp memory to help me track this down quickly.
  * Housekeeping.

## 7.13.0 (2025-04-12)
  * New feature: UniFi Access devices hosted on the same controller as Protect and exposed through Protect, can be unlocked. Crucially - Protect only provides the capability to view the livestream of an Access reader and to unlock it. There's no ability to lock it, no motion sensor (and therefore no HKSV support). As Protect evolves it's integration with Access, HBUP will continue to provide as much capability as we can (and more, where I can).
  * Improvement: better edge case recovery to deal with Protect controller API connectivity quirks.
  * Housekeeping.

## 7.12.1 (2025-03-16)
  * Housekeeping.

## 7.12.0 (2025-03-16)
  * Behavior change: Protect doorbell message switches are now disabled by default. The feature's still there and available for those who wish to use it, but for those who don't, it provides a more streamlined experience by default.
  * Fix: address regressions in message switches.
  * Fix: workaround quirks in recent Homebridge UI releases.
  * Housekeeping and refinements.
  * The author would like to express his deep appreciation to a certain member of the community...thank you, again.

## 7.11.0 (2025-01-05)
  * Improvement: additional refinements to deal with more frequent Protect controller connectivity quirks.
  * Housekeeping.

## 7.10.1 (2024-12-27)
  * Housekeeping.

## 7.10.0 (2024-12-22)
  * Breaking change: node 18 is no longer supported. The minimum version required for HBUP as of this release is node 20.
  * New feature: MQTT support for doorbell authentication, including NFC card information, when available. See the [MQTT documentation](https://github.com/hjdhjd/homebridge-unifi-protect/blob/main/docs/MQTT.md) for details.
  * Improvement: HBUP will now workaround Protect controller quirkiness/bugginess much more gracefully, significantly reducing connectivity issues with the Protect API. It was a fun problem.
  * Housekeeping.

## 7.9.0 (2024-12-08)
  * New feature: on Protect G4 Doorbell Pro doorbells, the fingerprint and NFC sensors are now available through a contact sensor that gets activated when the doorbell detects a successful authentication. It's disabled by default, available under the doorbell-related feature options section.
  * New feature: on Protect G4 Doorbell Pro doorbells, the downlight (Protect calls this the flashlight) is now accessible. It has some constraints due to API limitations that make it only crudely accessible: the light is only available when the doorbell believes it's dark, and the light has a delay of up to 25 seconds before it turns off, once you’ve turned it off in HBUP. Aside from that, enjoy! It's enabled by default and can be disabled in the doorbell-related feature options section.
  * New feature: when streaming a package camera at night, HBUP will turn on the flashlight, similar to the way Protect does so in the native Protect app.
  * Improvement: minor webUI enhancements.
  * Behavior change: by default, the device removal delay is now enabled by default. HBUP will wait at least 60 seconds before removing a device that's been removed by the Protect controller. There are a number of Protect controller regressions that seem to cause the sporadic removal and re-addition of devices, this should help curb that. You can revert the prior behavior by simply disabling the feature option.
  * Fix: addressed a regression with viewing the package camera on G4 Doorbell Pros that changed in Protect controller versions above 5.1.
  * Housekeeping.

## 7.8.2 (2024-10-20)
  * Housekeeping.

## 7.8.1 (2024-10-20)
  * Housekeeping.

## 7.8.0 (2024-10-14)
  * Behavior change: hardware acceleration is now enabled by default if it's available and detected as working by HBUP.
  * Behavior change: the bundled FFmpeg no longer attempts to provide Intel QSV hardware acceleration support due to bugs in the QSV libraries when creating static FFmpeg builds.
  * Improvement: Intel QSV hardware acceleration support now works with HEVC (Protect calls this enhanced encoding).
  * Improvement: support for Jellfin FFmpeg builds for use with Intel QSV hardware acceleration. If you want to use Intel QSV hardware acceleration, I recommend either [downloading it for your particular Linux environment from Jellyfin](https://repo.jellyfin.org/?path=/ffmpeg) or [adding the Jellyfin repository to your Linux distribution](https://jellyfin.org/docs/general/installation/linux/#debuntu-debian-ubuntu-and-derivatives-using-apt) and then installing `jellyfin-ffmpeg`. Ensure you specify the location of the Jellyfin FFmpeg version under the Settings | Additional Settings section in the HBUP webUI.
  * Housekeeping.

## 7.7.1 (2024-10-06)
  * **Note: FFmpeg v7.1 currently has fatal issues handling H.264 and HEVC decoding in certain scenarios. Unfortunately, this impacts HBUP as well as a lot of software out there. Until further notice, HBUP does not support FFmpeg versions above 7.0.x. If you have no idea what any of this means, that generally means you can ignore all this because things work fine in your environment. 😀**
  * Housekeeping.

## 7.7.0 (2024-10-02)
  * Behavior change: HBUP will now ensure HomeKit accessory names are compliant with [HomeKit's naming guidelines](https://developer.apple.com/design/human-interface-guidelines/homekit#Help-people-choose-useful-names). Invalid characters will be replaced with a space, and multiple spaces will be squashed.
  * Housekeeping.

## 7.6.0 (2024-09-29)
  * **Note: HBUP now requires Protect v5 as if this release. Prior versions of Protect are no longer supported.**
  * Behavior change: Protect v5 has significantly changed interactions between doorbell cameras and chimes. As a result of Ubiquiti's changes, Protect chimes cannot have their volume controlled individually any longer. For the time being, it seems Protect's still permitting individual chimes to play unique ringtones and that functionality remains in HBUP. Volume control for Protect chimes attached to Protect doorbells can be enabled by a feature option, allowing you to control the volume across all Protect chimes paired to a particular doorbell.
  * New feature: Protect doorbell chime support is now available through Protect doorbells. You can find the relevant feature option under the doorbell section in the HBUP webUI.
  * New feature: third party cameras in Protect via ONVIF are now supported in HBUP, with constraints: there's no motion sensor exposed by the Protect controller, which means HKSV is unavailable to these cameras, as are any unique camera-specific controls.
  * Housekeeping.

## 7.5.2 (2024-09-28)
  * **Note: this will likely be the final version of HBUP to support Protect v4. Protect v5 has several breaking changes that I'll be addressing in future updates, most notably in the way Protect chimes now work, making them far less customizable than previously. Stay tuned for those updates.**
  * Improvement: HKSV performance and error rates should be noticeably improved. Thanks to @rasod for providing some good comparative logs to help me track this down.
  * Housekeeping.

## 7.5.1 (2024-09-26)
  * Housekeeping.

## 7.5.0 (2024-09-26)
  * Behavior change: smart motion detection will now trigger on **both** realtime and near-realtime events, as detected by Protect. Certain activities (e.g. license plate detection) frequently don't occur in realtime, and historically HBUP has ignored these detections in order to be consistent throughout. Given the continued evolution of Protect, it now makes sense to also trigger on these not-quite-realtime events as well - typically, events will be triggered within a few seconds of actual detection within the Protect environment. This change mostly impacts users who use smart object sensors to detect specific types of objects as detected by Protect. Object detection will more directly mirror what's available under the detections view within the Protect controller's webUI.
  * Improvement: smart motion detection now includes smart audio detection, when supported by Protect. You too can now have a sensor triggered when a baby is crying, a dog is barking, and a car horn is heard - potentially all at once! Functionality has been incorporated into the smart motion detection feature options and smart object sensors.
  * Improvement: address edge cases where the Protect controller disappears for large periods of time, leading to potential device removal.
  * Housekeeping.

## 7.4.0 (2024-09-22)
  * Behavior change: the camera status indicator light feature option now defaults to on. This was always the intended default behavior, but due to bugs that seem to be fixed in iOS 18, we can have our toys back. You can control the status indicator light through the camera details screen in the Home app.
  * New feature: the night vision indicator light is now available in the camera details screen in the Home app. This feature is enabled by default, you can choose to enable or disable it through the HBUP webUI.
  * New feature: night vision indicator light automation dimmer. This feature is disabled by default, and primarily intended for automation use cases. You can use the dimmer to adjust the sensitivity level of when Protect will trigger infrared settings. 0% disables infrared, 10% sets it to auto, 20-90% reflect the states you would find through the Protect webUI at increasing levels of sensitivity, 100% sets infrared always on.
  * Housekeeping.

## 7.3.1 (2024-09-15)
  * Housekeeping.

## 7.3.0 (2024-09-15)
  * New feature: Protect chimes now support all ringtones available, including custom ones. a switch will be created for each ringtone available.
  * Improvement: improve performance on lower powered environments like Pi4.
  * Housekeeping.

## 7.2.0 (2024-09-14)
  * Behavior change: API livestreaming is now the default. You can revert to the former method, using RTSP streams if you prefer. **I intend to deprecate RTSP streaming at some future point.**
  * Behavior change: the timeshift buffer is now mandatory in HBUP for HKSV. Latency issues make the legacy RTSP method extremely unreliable and I've decided to simplify and focus on a great HKSV experience at the expense of supporting low-power/limited CPU environments.
  * Removed feature: the HKSV maximum recording duration feature option has been removed. With recent changes to the Protect API make this extremely unreliable.
  * New feature: on Protect cameras that support it, an ambient light sensor will be added, reporting the current light level.
  * New feature: for automation use cases, an optional switch can be enabled to control the status indicator light on Protect devices that support it. This feature is supported on all UniFi Protect device types that have a status indicator light (currently cameras, lights, and sensors) Find it under device feature options. Disabled by default.
  * New feature: the status indicator light on Protect cameras can be used to automatically reflect when an HKSV event is being recorded. With this enabled, the status indicator light will switch on when an event is being actively recorded and off once it stops. Find it under HKSV feature options. Disabled by default. Thanks to @kevinwestby for the suggestion and enhancement request.
  * Improvement: further refinements to API livestreaming and HKSV.
  * Improvement: Protect-based smart motion detection (not to be confused with HKSV) has been refined to support the changes introduced by Ubiquiti in Protect firmware 4.1 and beyond. **HBUP now requires v4.1 or later, as of this release, as a result. As a reminder, non-GA/official firmware releases are explicitly unsupported by HBUP.**
  * Housekeeping and refinements. Lots of them...subtle and not.

## 7.1.2 (2024-06-16)
  * Improvement: additional refinements to API livestreaming.
  * Housekeeping.

## 7.1.1 (2024-06-15)
  * Improvement: some further refinements to HKSV recording.

## 7.1.0 (2024-06-15)
  * Behavior change: transcoding is now enabled by default even for local/low-latency streaming. The reason for this change is that HomeKit really doesn't provide a good distinction between local versus remote streaming, merely hinting at whether a HomeKit client is in a low-latency or high-latency environment. If you're on WiFi in a remote location and accessing your Protect cameras in the Home app, they would appear to HomeKit and HBUP as a low-latency connection rather. I believe these defaults are more sane and consistent as we move into the next generation of HBUP and Protect. You can, as always, adjust the defaults.
  * Improvement: hardware-accelerated decoding has been reenabled for HKSV. I disabled this quite some time ago as it seemed to be finicky at times and lead to unnecessary recording errors, but things seem to have improvement somewhat on the Protect end of things and I've also added some safety checks to alleviate the issues. The benefits outweigh the potential downsides, particularly given how often HKSV events can be triggered in most environments.
  * Improvement: further optimizations to snapshots to ensure we're even more responsive to HomeKit. HBUP now goes to more lengths to guarantee a short response time to snapshot requests by the Home app.
  * Improvement: further optimizations and refinements of API-based livestreaming. I'm hoping to evolve this to be the default in future releases, but there's a little more testing and work I'd like to do first. Using API livestreaming has numerous advantages including substantially lower resource utilization on the Protect controller itself if you're already using HKSV and have timeshifting enabled (which it is by default). In addition, livestreams are now essentially instantaneous across the board, and more is coming. TL;DR: things are faster, better, and more streamlined...and still experimental.
  * Improvement: HEVC (aka enhanced encoding in Protect-speak) based recording events are much better supported with far fewer grey/blank event snapshots in the HKSV timeline than in prior releases.

## 7.0.7 (2024-06-10)
  * Housekeeping.

## 7.0.6 (2024-06-10)
  * Breaking change: due to changes in the Protect controller, and my desire to continue to move forward rather than expend too much energy looking back, HBUP v7+ now requires Protect controller v4.0 or better.
  * Improvement: further refinements to API livestreaming.
  * Housekeeping.

## 7.0.5 (2024-06-09)
  * Fix: address a regression with pre-Protect 4.0-based controllers.
  * Housekeeping.

## 7.0.4 (2024-06-09)
  * Improvement: more refinements to API livestreaming.
  * Housekeeping.

## 7.0.3 (2024-06-09)
  * Housekeeping.

## 7.0.2 (2024-06-09)
  * Improvement: more refinements to API livestreaming.
  * Housekeeping.

## 7.0.1 (2024-06-06)
  * Fix: addressed a regression in the first run webUI.
  * Improvement: refinements to accessing the Protect Livestream API when livestreaming from the Home app. Certain camera types (notably the AI Pro and G4 Pro) will not livestream certain quality levels due to regressions in the current Protect controller firmware. I've implemented a workaround for the time being that forces the use of the high quality stream with those cameras. Let's see how it goes...**Note: this is an experimental feature and I will accept no support requests related to it. You're on your own if you have an issue.**
  * Housekeeping.

## 7.0.0 (2024-06-03)
  * New feature: experimental support for using the Protect livestream API directly when livestreaming in the Home app. This will provide an instantaneous livestreaming experience, but it has some caveats that I'm continuing to work through. At some point it may become the default - for now, if you want to enable this feature, you'll need to do so through the feature options webUI under the video options section. **Note: this is an experimental feature and I will accept no support requests related to it. You're on your own if you have an issue.**
  * Breaking change: default doorbell messages are no longer supported as of Protect controller firmware 4.0. That functionality has been removed from HBUP. To accomplish the same thing, just set a message with an indefinite duration either in HBUP, or through the Protect controller webUI (or native Protect app).
  * Breaking change: dynamic bitrate support has been removed. This was always an esoteric and often misunderstood feature, and generally didn't do a great job of solving the problem it was meant to solve. In the era of HEVC on Protect, it makes even less sense now given the need to transcode in most circumstances.
  * Improvement: if you're using the Protect *enhanced encoding* (which enables H.265/HEVC as the video codec Protect uses rather than H.264) setting on your cameras, HBUP will detect this and transcode even if you've requested that it not do so. HomeKit does not currently support anything other than H.264.
  * Improvement: the HBUP webUI has been further refined. Nobody might notice but me, but it still makes me smile.
  * Housekeeping: some significant spring cleaning and standardization.

## 6.22.0 (2024-04-27)
  * New feature: you can now choose to override the bitrates HomeKit requests (either locally or remotely). This allows you to have a much higher quality transcoding experience at home or remotely.
  * Housekeeping.

## 6.21.1 (2024-04-21)
  * Fix: ensure we honor user-selected stream quality defaults.

## 6.21.0 (2024-04-21)
  * Improvement: even faster startup times for livestreams.
  * Improvement: I've adjusted the defaults when transmuxing to better align to HomeKit expectations and certain Apple quirks. This should particularly result in improvements to the default experience on tvOS.
  * Improvement: more robust handling of misbehaving Protect controllers. HBUP will more assertively disconnect and reconnect from the Protect controller when too many transcoding errors are encountered.
  * Improvement: additional smart object detection options are now available through the HBUP webUI.
  * Improvement: documentation updates.
  * Fix: events from Protect sensors are once more published to MQTT immediately.
  * Housekeeping.

## 6.20.0 (2024-03-30)
  * New feature: UniFi chime devices now expose two additional switches, allowing you to trigger the chime speaker with either the default tone or the buzzer tone. Buzzer tone you say, what's that? Give it a try.
  * New feature: the new high quality (and performance) snapshot capabilities can now be controlled through a feature option. The option is enabled by default, but can be disabled if you prefer. Why might you want to disable it? In certain performance-constrained environments (e.g. Pi), snapshots may take longer to generate than HomeKit allows for when the CPU is under heavier load.
  * Change: HomeKit Secure Video events are no longer logged by default. You can enable HKSV event logging using the appropriate feature option through the webUI.
  * Breaking changes for MQTT users: MQTT capabilities have been standardized - see the [MQTT documentation](https://github.com/hjdhjd/homebridge-unifi-protect/blob/main/docs/MQTT.md) for details. The changes are focused on streamlining how you can query HBUP, and how information is published. In addition, all the MQTT capabilities are now documented. A few items weren't previously.
  * Housekeeping, spring cleaning, and a few refinements throughout.

## 6.19.0 (2024-03-17)
  * New feature: add support for optionally choosing to make Protect devices standalone in HomeKit. If you choose to do so, you'll have to manually manage the individual Protect devices in HomeKit. I would not recommend using this feature for most people.
  * Improvement: snapshots have been rethought and optimized, and image quality has been significantly improved. In recent Protect controller firmware releases, the Protect API no longer produces high-quality snapshots and the performance of the Protect controller has been inconsistent at best. With this release, snapshots are now first driven from the timeshift buffer, for those that have enabled HKSV and timeshifting. If that's not available or unusable, HBUP will snapshot the RTSP stream to the controller before trying the Protect API as a final fallback.
  * Housekeeping.

## 6.18.1 (2024-03-01)
  * Housekeeping.

## 6.18.0 (2024-02-11)
  * New feature: stream cropping. You can now selectively crop your Protect video stream feed in HBUP. This option will force transcoding on in all circumstances when viewing livestreams. My thanks to @dansimau for the initial PR that implemented this feature and contributed it to the community. This feature utilized the FFmpeg crop filter behind the scenes - you can read more about how cropping in FFmpeg works in the FFmpeg documentation to orient yourself if you're struggling with this feature at first. My recommendation: play with it and you'll eventually get a feel for the settings if they don't seem intuitive at first.
  * Improvement: Protect device availability is now provided to HomeKit on a realtime basis. This should help folks more easily see when devices are disconnected from the Protect controller.
  * Housekeeping.

## 6.17.0 (2024-02-04)
  * Improvement: add support for UniFi Protect-driven animal smart occupancy in the HBUP webUI.
  * Housekeeping.

## 6.16.0 (2023-11-05)
  * Housekeeping.

## 6.15.1 (2023-10-08)
  * Improvement: more robust validation of hardware acceleration before enabling it. For users who are trying to use QSV - there's some known issues that'll be worked on in a future release of ffmpeg-for-homebridge to enable these capabilities more fully, bear with me.
  * Housekeeping.

## 6.15.0 (2023-10-02)
  * New feature: sync Protect device names between HomeKit and Protect (available under device feature options in the HBUP webUI). Protect device name synchronization is one-way, from Protect to HomeKit, and is not realtime. Name synchronization with HomeKit will be delivered to HomeKit on plugin startup. In reality - name synchronization is a realtime activity in HBUP, but there seems to be an issue somewhere along the way that'll be resolved in either a future HBUP or Homebridge release. **This feature is off by default, but may become the default in a future release.**
  * New feature: license plate telemetry contact sensor support (available under motion feature options in the HBUP webUI). If you have an AI-series camera and have license plate detection enabled, you can now look for individual license plates and potentially execute specific automation scenarios (say in combination with [homebridge-myq](https://github.com/hjdhjd/homebridge-myq) and automatically open or close a garage door when detected). This works by using Protect's native detection of individual license plates - in my testing, it's imperfect but works the vast majority of the time in good lighting conditions. If you enable motion event logging, you'll see the license plate telemetry logged and, of course, there is MQTT support available as well. You must enable smart motion event detection in HBUP to use this feature - and of course, it's available in the webUI. One last thing: you can set detections for multiple license plates by hyphenating the license plates (PLATE1-PLATE2-PLATE3...) when enabling the feature option and you'll get a contact sensor for each plate.
  * New feature: ring delay intervals. For those situations where you want to prevent someone from hitting the doorbell too many times in a row, you can now configure how much time must pass in between each doorbell ring. Available in the settings tab in the HBUP webUI under additional options and defaults to no delay between rings. Thanks to @vincer for the suggestion.
  * New feature: device removal delay feature option (available under NVR feature options). There are certain unique scenarios (almost entirely revolving around UniFi Protect bugs related to stacked NVR configurations) where realtime removal of Protect devices from HomeKit is undesirable. This feature option allows users to configure a delay once a device removal event has been detected before HBUP removes the device from HomeKit. This can be helpful in instances where Protect devices temporarily disappear from a Protect controller before reappearing a short time later.
  * Improvement: motion event delivery is more robust, with several under-the-hood optimizations that should make motion detection feel even snappier than they already are for users. Additionally, HBUP now warns users when Protect controller settings will prevent HBUP from seeing motion events.
  * Improvement: native Intel QSV support comes to this release, courtesy of the latest ffmpeg-for-homebridge has now been updated with support for Intel Quick Sync Video GPU hardware acceleration. For users of QSV-enabled systems, you can give hardware-accelerated transcoding a try and see what we've been enjoying on the macOS end of the world.
  * Housekeeping.

## 6.14.0 (2023-09-11)
  * New feature: you can now trigger doorbell ring events through MQTT. See the MQTT documentation reference for more details. Thanks to @glynd for the contribution.
  * Fix: address two edge cases on which Protect camera streams are used when HBUP tries to be smart about selecting one to use. One edge case relates to hardware transcoding and the other to some of the more exotic camera resolutions Protect uses. Thanks to @bSr43 for encountering one part of this bug and raising it to my attention wherein I discovered the second part of my shame and corrected both problems.

## 6.13.1 (2023-08-26)
  * Fix: ensure audio settings are honored for HKSV event recordings.

## 6.13.0 (2023-08-26)
  * Improvement: webUI enhancements. Users now default into the feature options tab, and new users will get a first run screen prompting for Protect controller and login credentials. Protect API errors are reported in the webUI. And more.
  * Improvement: modernized and refined motion detection event delivery.
  * Housekeeipng. Lots of housekeeping.

## 6.12.2 (2023-08-19)
## 6.12.1 (2023-08-19)
  * Housekeeping.

## 6.12.0 (2023-08-06)
  * Fix: correctly detect Raspberry Pi Compute Module 4 variants.
  * Housekeeping.

## 6.11.1 (2023-07-27)
  * Housekeeping and minor bugfixes.

## 6.11.0 (2023-07-16)
  * New feature: Protect doorbells with attached physical chimes can now be controlled. This option adds three switch accessories that you can toggle between: none, mechanical, and digital. It allows those who have physical chimes attached to their Protect doorbells to be able to silence them selectively. **Note: these switches are special in that they can only be set to on. Trying to turn off the individual switches won't work. If you want to turn off the physical chime, you turn *on* the "None" switch, which will turn off the others. Inelegant, but it's the only meaningful way to add three-state switches in the HomeKit world.** This option will appear in the webUI under the `Doorbell` configuration section, if you have a Protect doorbell with a physical chime. Enabling it will expose an additional feature option, allowing you to select the duration for digital chimes, which should correspond to the same settings in the Protect webUI and app.
  * Improvement: further refinements to M3U playlist generation, including live guide data and keywords for consuming apps that support it.
  * Housekeeping.

## 6.10.0 (2023-07-08)
  * **Note: as of 6.10.0, HBUP requires UniFi OS 3.0 or greater. Given Ubiquiti has completed the rollout of UniFi OS 3.0+ to all supported console platforms, if you're running on recent GA firmware releases of UniFi Protect controllers, this requirement will have no impact to you. If you don't, please note that while HBUP may continue to work for the time being, there is no support or guarantee of compatibility for future releases.**
  * New feature: You can now enable a new feature option that will enable HBUP to publish an M3U playlist that can be ingested by other apps. This is useful in certain scenarios, such as an app that can make Protect livestreams available through it's own UI, but doesn't know how to speak to the Protect API. An example of this would be creating a custom channel in Channels DVR. M3U playlist will be made available on a user-selectable port, via HTTP. The playlist contains additional metadata that is especially useful in Channels DVR. See the HBUP webUI for more under NVR feature options.
  * New feature: Protect sensors now display battery percentages in the Home app.
  * Improvement: webUI refinements and branding updates.
  * Fix: further refinements to ensuring HomeKit recording and streaming profile requirements are met.
  * Housekeeping, documentation updates, and visual refreshes.

## 6.9.2 (2023-06-24)
  * Fix: ensure HKSV recording can be enabled on Protect cameras with native frame rates that are different than what HomeKit accepts.

## 6.9.1 (2023-06-23)
  * Fix: improve  webUI compatibility across browsers for value-centric feature options.
  * Housekeeping.

## 6.9.0 (2023-06-19)
  * New feature: package camera HKSV support is here. Ubiquiti has stabilized access to the package camera and finally provided reliable access to it through the API. Package cameras will appear as HKSV-capable within the Home app, you can configure it the same as any other camera.
  * New feature: leak sensor support, now that it's fully available in UniFi Protect sensors, are now fully supported. A leak sensor service will be configured in HomeKit if you enable the functionality is enabled in the Protect webUI or app. I also realized that I hadn't previously updated the MQTT documentation for Protect sensors - that's now documented as well.
  * New feature: motion and occupancy event durations can now be granularly controlled through feature options. You can configure them using the webUI. **Note: if you previously set a default motion or occupancy event as an advanced setting - these will no longer be used. To replicate the behavior, set a global feature option for motion and occupancy event durations.**
  * New feature: the webUI now will hide or show feature options that are dependent on other feature options being enabled or disabled, reducing visual clutter and making the webUI easier to navigate for people.
  * New feature: value-centric feature options can now be configured using the webUI. This completes the feature set for the webUI - all feature options should be configured using the webUI moving forward.
  * Improvement: additional speed and quality improvements for those that have hardware acceleration available to them. When using hardware acceleration, the highest stream quality will always be used by HBUP now, which significantly improves transcoding speed and quality.
  * Improvement: Viewport liveview state changes from the Protect webUI are now detected in realtime.
  * Housekeeping.

## 6.8.1 (2023-06-04)
## 6.8.0 (2023-06-04)
  * Improvement: when using occupancy sensors in combination with smart motion detection, you can now tailor which Protect object detection types trigger occupancy. See the webUI or documentation for more.
  * Improvement: the webUI now visually shows you the scope of a feature option (global, controller, or device), and allows you to cycle between them. This makes it easier to set a global or controller default, but individually override it for a device.
  * Fix: ensure occupancy sensors are available to all Protect device types that support motion detection.
  * Housekeeping.

## 6.7.0 (2023-05-21)
  * New feature: occupancy sensors for Protect devices with motion sensors. If you enable the occupancy sensor feature option on a Protect device, an occupancy sensor accessory will be added to that device. The occupancy sensor works like this: when any motion is detected by that device's motion sensor, occupancy is triggered. When no motion has been detected for a certain amount of time (5 minutes by default), occupancy will no longer be triggered. This is useful in various automation scenarios that folks might want (e.g. occupancy triggering a light turning on/off). If you enable the smart motion events feature option as well, the occupancy sensor will use smart motion events to determine occupancy state, meaning rather than trigger occupancy on *any* motion, occupancy will only be triggered when **Protect** thinks it has detected a person.
  * Housekeeping and minor bugfixes.

## 6.6.0 (2023-05-14)
  * New feature: Raspberry Pi 4 hardware accelerated decoding and encoding. This requires that you've configured your RPi4 to use at least 128MB for the GPU. HKSV event recording will not be hardware accelerated due to ongoing driver quirks. I hope once the software and drivers evolve, we can more effectively leverage it for HKSV as well.
  * New feature: Intel Quick Sync Video hardware accelerated decoding and encoding. Many Intel CPUs come with QSV support builtin. Thie feature requires a QSV-supported CPU and h264_qsv codec support in your version of FFmpeg.
  * New feature: the base address used for accessing camera URLs on the Protect controller can now be independently configured as an advanced option under controller settings.
  * Fix: stacked UNVRs couldn't access cameras in certain circumstances.
  * Housekeeping.

## 6.5.1 (2023-05-02)
  * Fix: address a regression in hardware transcoding for non-Apple Silicon Macs.

## 6.5.0 (2023-04-30)
  * Improvement: various transcoding improvements and optimizations across platforms.
  * Improvement: on macOS, hardware transcoding optimizations that should noticeably improve video quality. These refinements are primarily for Apple Silicon Macs.
  * Improvement: on macOS, use the extra-awesome native macOS AAC encoder.
  * Fix: address iOS 16+ HomeKit naming changes - HBUP now correctly names the switches and sensors it creates. If you've got blank or missing names for switches / sensors created by HBUP after this update, you can disable, restart Homebridge, and then reenable them and restart Homebridge a second time.
  * Fix: when using the "only"-specific feature options related to selecting stream quality, ensure we propagate selections correctly when selecting both controller/global options and device-level ones.

## 6.4.4 (2023-04-14)
  * Fix: ensure doorbells can be accessed on UDMPs - Ubiquiti hasn't updated these devices to UniFi OS 3.0 yet.
  * Housekeeping.

## 6.4.3 (2023-04-13)
  * Fix: ensure chime volume settings are properly set.
  * Housekeeping.

## 6.4.2 (2023-04-11)
  * Fix: correctly discern motion events when smart motion detection is disabled on smart motion detection capable cameras.

## 6.4.1 (2023-04-10)
## 6.4.0 (2023-04-10)
  * Improvement: hardware accelerated decoding is always-on on macOS. This has no negative implications to quality, and is only a net quality-of-life for those running Homebridge on macOS.
  * Improvement: further speed improvements and optimizations - connections to the Protect controller are faster and more resilient.
  * Housekeeping.

## 6.3.0 (2023-04-08)
  * New feature: hardware accelerated decoding support on macOS.
  * New feature: Protect "crossing line" smart motion detection is now supported on cameras that support the functionality. You can configure this in the Protect controller webUI, on G4-series and higher cameras in the same place you can configure motion zones.
  * New feature: you can have all the Protect controller telemetry published in MQTT under the *telemetry* topic. This is the raw feed of the realtime telemetry as it's received from the Protect controller, so expect a lot of data. This can be enabled with a new feature option: `NVR.Publish.Telemetry`. For the MQTT enthusiasts, this really gives you the ultimate flexibility to build automations and events in a more granular way for specific use cases. For most users, I would not recommend enabling this option - it's a lot of data, and you'll need to parse through everything that the controller is publishing. The MQTT support that's provided for cameras, motion detection, etc. by HBUP is more refined and feature-rich in important ways, but for those that want the raw telemetry...here it is.
  * Improvement: Further refinements to plugin startup.
  * Housekeeping.

## 6.2.8 (2023-04-05)
  * Improve Protect controller login resilience.

## 6.2.7 (2023-04-05)
## 6.2.6 (2023-04-05)
  * Housekeeping.

## 6.2.5 (2023-04-05)
  * Improvement: minor webUI refinements.
  * Housekeeping.

## 6.2.4 (2023-04-03)
## 6.2.3 (2023-04-03)
  * Fix: address a rare race condition in motion event delivery.

## 6.2.2 (2023-04-03)
  * Fix: really ensure MQTT notifications use the correct MAC addresses when publishing messages.

## 6.2.1 (2023-04-02)
  * Fix: make codec detection more robust across platforms.

## 6.2.0 (2023-04-02)
  * New feature: support for chime accessories. They will appear as dimmer accessories in HomeKit and can be used to control the volume level of the Protect chimes. Unfortunately, this is the best we can do given there are no speaker / volume accessories in HomeKit.

## 6.1.0 (2023-04-02)
  * Improvement: the feature option webUI has been made more contextually aware and will only show options that are relevant for the selected Protect device.
  * Improvement: all UniFi devices (currently that's Protect cameras, Protect sensors, or Protect flood lights) that support motion sensors can now be configured to have motion switches and/or motion triggers by enabling those feature options for those devices.
  * Improvement: when the Protect controller is unavailable when HBUP is starting up, retry at regular intervals rather than giving up entirely.
  * Improvement: streaming from an Apple Watch is more reliable now.
  * Improvement: further refinements to macOS hardware transcoding.
  * Improvement: streaming session startup further optimized by moving encoder checks to plugin startup, rather than on each new session.
  * Fix: livestreaming from the Home app on the same machine as Homebridge is running on should work correctly now.
  * Fix: ensure MQTT notifications use the correct MAC addresses when publishing messages.
  * Housekeeping.

## 6.0.3 (2023-03-27)
  * Fix: ensure motion switch state is retained across restarts.

## 6.0.2 (2023-03-27)
  * Fix: bugfixes for the webUI when no options are selected.
  * Fix: bugfixes for the NVR temperature sensor accessory.

## 6.0.1 (2023-03-26)
## 6.0.0 (2023-03-26)
  * **Breaking change: several feature options have been renamed, and some have been removed or made obsolete. If you use anything other than the defaults of this plugin, you should take the time to look through the revised list of feature options. This is a major version upgrade - there are breaking changes for some users.**
  * New feature: a custom webUI is now the default and preferred way to configure feature options in this plugin, using the Homebridge webUI.
  * New feature: hardware accelerated transcoding is now available on macOS. Other platforms coming soon. Disabled by default.
  * New feature: customize the default doorbell mesage on a UniFi Protect doorbell. The UniFi Protect controller defaults this to "WELCOME".
  * New feature: package cameras are supported on the G4 Doorbell Pro.
  * New feature: when viewing cameras in the Home app over a high latency connection (e.g. looking at a livestream over a cellular connection), HBUP will transcode to provide the requested bitrates to HomeKit by default. This should improve responsiveness for cellular connections. This behavior can be adjusted using the `Video.Transcode.HighLatency` feature option, which defaults to enabled.
  * Change: The HKSV feature option has been removed. HKSV will be available to any camera that supports it. You can choose to enable or disable HKSV in the Home app, which provides a consistent experience with all other native HomeKit cameras.
  * Change: The HKSV recording stream selection feature option has been renamed.
  * Improvement: the status light LEDs on Protect devices will be disabled in HomeKit by default. This behavior can be controlled with the `Device.StatusLed` feature option. HomeKit support for camera status lights is still flaky as of iOS 16.
  * Improvement: further refinements to timeshifting.
  * Improvement: audio support has been enhanced throughout to take advantage of the latest HomeKit capabilities.
  * Improvement: complete rewrite of the core aspects of HBUP from scratch to prepare for the future, along with many optimizations and improvements.
  * Improvement: liveview switch states are now more accurate at startup.
  * Improvement: addressed some longstanding quirks related to Homebridge and HomeKit when viewing livestreams using the Home app on a Mac.

## 5.5.0 (2022-02-21)
  * New feature: For those that enable it, background noise reduction has been enhanced to use FFmpeg's `afftdn` noise filter, a modern background noise reducer. The classic `highpass` and `lowpass` filters are still there, of course. You can read all about the [`Audio.Filter.Noise.FftNr` feature options](https://github.com/hjdhjd/homebridge-unifi-protect/blob/main/docs/FeatureOptions.md#audio) and in the [audio options documentation](https://github.com/hjdhjd/homebridge-unifi-protect/blob/main/docs/AudioOptions.md). With this release, the defaults when using `Audio.Filter.Noise` will use `afftnr` instead of highpass and lowpass filters, by default.
  * New feature: Logging for HKSV-related recording events can now be controlled. Read about the new [`Log.HKSV` feature options](https://github.com/hjdhjd/homebridge-unifi-protect/blob/main/docs/FeatureOptions.md#logging)
  * Housekeeping and minor bugfixes.

  * **[Please review the changelog for v5.4.0 for important information on the new features and changes in 5.4.x](https://github.com/hjdhjd/homebridge-unifi-protect/blob/main/docs/Changelog.md#540-2022-02-19)**.

## 5.4.5 (2022-02-21)
  * Housekeeping and minor bugfixes.

  * **[Please review the changelog for v5.4.0 for important information on the new features and changes in 5.4.x](https://github.com/hjdhjd/homebridge-unifi-protect/blob/main/docs/Changelog.md#540-2022-02-19)**.

## 5.4.4 (2022-02-20)
  * Housekeeping and minor bugfixes.

  * **[Please review the changelog for v5.4.0 for important information on the new features and changes in 5.4.x](https://github.com/hjdhjd/homebridge-unifi-protect/blob/main/docs/Changelog.md#540-2022-02-19)**.

## 5.4.3 (2022-02-20)
  * Housekeeping minor bugfixes.

  * **[Please review the changelog for v5.4.0 for important information on the new features and changes in 5.4.x](https://github.com/hjdhjd/homebridge-unifi-protect/blob/main/docs/Changelog.md#540-2022-02-19)**.

## 5.4.2 (2022-02-20)
  * Github housekeeping and minor bugfixes.

  * **[Please review the changelog for v5.4.0 for important information on the new features and changes in 5.4.x](https://github.com/hjdhjd/homebridge-unifi-protect/blob/main/docs/Changelog.md#540-2022-02-19)**.

## 5.4.1 (2022-02-20)
  * Housekeeping and minor bugfixes.

  * **[Please review the changelog for v5.4.0 for important information on the new features and changes in 5.4.x](https://github.com/hjdhjd/homebridge-unifi-protect/blob/main/docs/Changelog.md#540-2022-02-19)**.

## 5.4.0 (2022-02-19)
  * New feature: You can disable the timeshift buffer for HKSV. This will have some small negative implications to the HKSV user experience - specifically that you won't have a few seconds of video before the actual motion event that triggers it. However, this allows for a much easier experience for users on low-powered systems such as Raspberry Pi, etc. The new feature option is [`Video.HKSV.TimeshiftBuffer`](https://github.com/hjdhjd/homebridge-unifi-protect/blob/main/docs/FeatureOptions.md#video).

  * New feature: Added the ability to select which stream quality should be used for HKSV independent of what is used for viewing a live stream. For example, this feature allows you to use a high-quality video stream for live viewing, and a different one for HKSV. This is useful on lower end devices running Homebridge where you want to use the lowest streaming quality for CPU reasons, but still have a great live viewing experience.  **This is a breaking change for some users who have been using the `Video.Stream.Only` to force HKSV to use a lower stream quality. You will need to use the new feature option instead.** The new feature option is [`Video.HKSV.Recording.Only.`*Quality*](https://github.com/hjdhjd/homebridge-unifi-protect/blob/main/docs/FeatureOptions.md#video).

  * New feature: You now have the ability to selectively enable or disable dynamic bitrates for video streams using the [`Video.DynamicBitrate.Switch` feature option](https://github.com/hjdhjd/homebridge-unifi-protect/blob/main/docs/FeatureOptions.md#video). This is useful in automation scenarios such as choosing to enable dynamic bitrates when you are not home in order to optimize the HomeKit video streaming experience, and disabling it when you are home, to ensure you always have the best video quality.

  * New feature: You can choose whether or not to enable recording on the UniFi Protect NVR, and in what recording mode. Use the [`Nvr.Recording.Switch` feature option](https://github.com/hjdhjd/homebridge-unifi-protect/blob/main/docs/FeatureOptions.md#nvr) to enable the capability. It will add three new switches, allowing you to choose which NVR recording mode you want to use. **Note: this feature is unrelated to HomeKit Secure Video and is for controlling the recording capabilities of the UniFi Protect NVR**.

  * **Note: The [`Video.Dynamic.Bitrates` feature option](https://github.com/hjdhjd/homebridge-unifi-protect/blob/main/docs/FeatureOptions.md#video) has been renamed to [`Video.DynamicBitrate`](https://github.com/hjdhjd/homebridge-unifi-protect/blob/main/docs/FeatureOptions.md#video). Adjust your feature option settings accordingly.**

  * Improvement: Camera streaming startup times should be noticably improved thanks to some additional tuning.
  * Housekeeping.

## 5.3.4 (2022-02-15)
  * Housekeeping. Can you believe how messy it is around here these days? Sorry about that!

## 5.3.3 (2022-02-15)
  * Fix: Cameras with microphones such as the G4 Doorbell and G3/G4 Instants weren't able to stream for more than a few seconds. Fixed.

## 5.3.2 (2022-02-14)
  * Housekeeping updates.

## 5.3.1 (2022-02-14)
  * Improvement: Performance-related updates that further refine the streaming and HKSV experiences.
  * Fix: Ensure motion sensors are always reset when Homebridge starts, and that motion events are processed correctly when certain HKSV-adjacent edge cases take place.
  * Fix: Cosmetic issue - we incorrectly logged that dynamic bitrates were enabled when they weren't.
  * Housekeeping updates.

## 5.3.0 (2022-02-13)
  * New feature: enable or disable dynamic bitrate support for video. The [`Video.Dynamic.Bitrates` feature option](https://github.com/hjdhjd/homebridge-unifi-protect/blob/main/docs/FeatureOptions.md#video) defaults to disabled. Enabling it will have consequences for the Protect controller you should be aware of. Read the documentation for more information.

## 5.2.0 (2022-02-13)
  * New feature: enable or disable HKSV recording without having to enable or disable it within the Home app. This is useful in automation scenarios where you don't actually want to turn off HKSV, but you do want to control when it chooses to record beyond the simple home/away options that Apple gives you. The new feature option is [`Video.HKSV.Recording.Switch`](https://github.com/hjdhjd/homebridge-unifi-protect/blob/main/docs/FeatureOptions.md#video).
  * Housekeeping updates.

## 5.1.2 (2022-02-12)
  * Fix: honor a user-selected video encoder for HKSV.

## 5.1.1 (2022-02-12)
  * Housekeeping updates.

## 5.1.0 (2022-02-12)
  * New feature: Full HomeKit Secure Video support. No extra plugins and capabilities needed...in another open source community first, we use the Protect livestream API to directly access and maintain a HomeKit buffer. You don't need to explicitly enable it in a feature option...it just works...and is enabled by default. Of course there are a couple of [feature options you can configure](https://github.com/hjdhjd/homebridge-unifi-protect/blob/main/docs/FeatureOptions.md#video) as well, if you want. You can read more about it [here](https://github.com/hjdhjd/homebridge-unifi-protect/blob/main/docs/HomeKitSecureVideo.md).
  * New feature: Now that Ubiquiti has stabilized their RTSPS support, it is replaces RTSP when needed.

## 5.0.6 (2022-01-16)
  * Fix: Doorbell trigger reliability improvements.
  * Housekeeping and dependency updates.

## 5.0.5 (2022-01-15)
  * Fix: Corrected liveview behavior to ensure they are correctly set and unset. Regression introduced in v5.
  * Housekeeping and dependency updates.

## 5.0.4 (2022-01-10)
  * Fix: Further improve networking robustness for edge cases.

## 5.0.3 (2022-01-10)
  * Housekeeping and minor logging UX improvement.

## 5.0.2 (2022-01-10)
  * Fix: really fix a networking edge case this time.

## 5.0.1 (2022-01-10)
  * Fix: adjust some edge cases relating to two-way audio.
  * Enhancement: allow for users to specify a different video encoder to use with FFmpeg when transcoding. **This is an entirely unsupported feature - issues opened for problems this may create for you are your own**. This might be useful in certain scenarios (e.g. Raspberry Pi) where you want to use hardware-accelerated transcoding. Personally, I'm deeply skeptical of the utility of this feature, but curious enough to add it in. This might happen to you too someday when you are old like me. Find the option in Homebridge UI, under advanced settings.

## 5.0.0 (2022-01-09)
  * Fix: gracefully error out when no version of ffmpeg is available.
  * Fix: increase the duration a doorbell trigger is on. In certain setups, doorbell triggers don't stay on for a long enough time to trigger HomeKit automations or update the Home app.
  * New feature: full UniFi Protect floodlight support. Floodlights will appear as a dimmer in HomeKit, allowing you to turn them on, off, and set various lighting levels. Floodlights include motion sensors that are also accessible in HomeKit.
  * New feature: full UniFi Protect sensor support. This includes ambient light sensors, contact sensors, motion sensors, and temperature sensors...and more!
  * New feature: full UniFi Protect Viewport support. You can configure which liveview is used for Viewport directly in HomeKit.
  * New feature: UniFi Protect controller system information sensor support. Currently, we support the controller CPU temperature as a HomeKit sensor. More perhaps in the future. This feature is disabled by default. Enable the feature option `NVR.SystemInfo` to use it. See the documentation for details.
  * New feature: MQTT support for UniFi Protect floodlights.
  * New feature: MQTT support for UniFi Protect sensors.
  * New feature: MQTT support for UniFi Protect controller system information.
  * Enhancement: streaming will now use the IP address / hostname provided to the plugin during configuration, rather than the one provided back by the Protect NVR. This is useful in certain networking scenarios.
  * Enhancement: refine streaming autoconfiguration given recent Protect firmware updates. What's it mean for you? Even snappier startup times for streaming.
  * Enhancement: I've further reverse-engineered two-way audio (on supported devices such as Doorbells) to connect through the Protect controller rather than the camera directly. We still don't have AEC (acoustic echo cancellation), but it's significant progress.
  * Enhancement: for MQTT doorbell ring events, `homebridge-unifi-protect` will now send both `true` and `false` messages when a doorbell ring event occurs.

## 4.4.4 (2022-01-02)
  * Separate the core UniFi Protect API into a separate library so it can be used in other projects.
  * Lock `mqtt` upstream package version due to a bug introduced in a newer version until it gets sorted out.
  * Dependency updates.

## 4.4.3 (2021-09-07)
  * Remove deprecated code that was causing a minor issue when using smart detection with object-specific accessory granularity.
  * Housekeeping.

## 4.4.2 (2021-07-19)
  * Dependency updates.

## 4.4.1 (2021-06-16)
  * Fix: for those that are running into occasional issues related to FFmpeg streaming and `port in use` errors, this update is for you.
  * Dependency updates.

## 4.4.0 (2021-03-28)
  * Fix: adjust realtime event processing semantics to match the changes in behavior UniFi Protect introduced in v1.17 controller firmwares and beyond.
  * Fix: correct a regression of MQTT-triggered snapshots. They should work correctly once more - sorry about that!
  * New feature: significantly updated smart motion detection support:
    * You can now configure which smart motion object types trigger a motion event (see the `Motion.SmartDetect.Person` and `Motion.SmartDetect.Vehicle` [feature options](https://github.com/hjdhjd/homebridge-unifi-protect/blob/main/docs/FeatureOptions.md#motion)).
    * Create automations based on object types that are detected by UniFi Protect through the new `Motion.SmartDetect.ObjectSensors` [feature option](https://github.com/hjdhjd/homebridge-unifi-protect/blob/main/docs/FeatureOptions.md#motion). This option will create a set of contact sensors that will be triggered whenever UniFi Protect detects those object types which can be used in various automation scenarios.
    * Updated MQTT support with all that smart motion goodness. We now publish smart motion events, including detected object types, for those that use MQTT to further their automation scenarios. See the [MQTT documentation](https://github.com/hjdhjd/homebridge-unifi-protect/blob/main/docs/MQTT.md) for more details.
  * New feature: ignore UniFi Protect events. Using the `Doorbell.NvrEvents`, `Motion.NvrEvents`, and `Motion.SmartDetect.NvrEvents` [feature option](https://github.com/hjdhjd/homebridge-unifi-protect/blob/main/docs/FeatureOptions.md) you can selectively disable processing those events in HomeKit from UniFi Protect. Why might you want to do this? There are some use cases where users may want to ignore the event detection in Protect, due to false positives or other automation scenarios.

## 4.3.5 (2021-01-02)
  * Fix: deal gracefully with Protect edge cases where undefined / uninitialized values may be provided by the Protect controller for RTSP streams.

## 4.3.4 (2021-01-02)
  * Selectively enable additional logging when needed to troubleshoot startup issues.

## 4.3.3 (2021-01-01)
  * More housekeeping.

## 4.3.2 (2021-01-01)
  * More housekeeping.

## 4.3.1 (2021-01-01)
  * Dependency updates and housekeeping.

## 4.3.0 (2020-12-26)
  * Removed support for legacy UniFi Cloud Key Gen2+ firmware. `homebridge-unifi-protect` now requires at least firmware version 2.0.24 or newer, which adds full UniFi OS support for UCK Gen2+ devices. This may be a breaking change if you aren't on the latest stable firmware for UCK Gen2+.

## 4.2.0 (2020-11-26)
  * New feature: video transcoding. This [feature option](https://github.com/hjdhjd/homebridge-unifi-protect/blob/main/docs/FeatureOptions.md#video) should **not** be needed for most people. For the unlucky few that struggle with getting native streaming to work, please refer to the [troubleshooting documentation](https://github.com/hjdhjd/homebridge-unifi-protect/blob/main/docs/Troubleshooting.md#video) for how and when to use this feature, and it's implications.
  * Dependency and library updates.

## 4.1.5 (2020-11-22)
  * Fix for a regression of MQTT event triggers.
  * Increase API timeout limit to give WiFi-based cameras a little more time to respond.
  * Dependency and library updates.

## 4.1.4 (2020-11-09)
  * Reinstate compatibility with NodeJS 12.

## 4.1.3 (2020-11-08)
  * More minor housekeeping and documentation updates.

## 4.1.2 (2020-11-08)
  * Minor housekeeping and documentation updates.

## 4.1.1 (2020-11-08)
  * Fix: ensure that `homebridge-unifi-protect` honors RTSP streaming feature option scope for individual HomeKit clients.

## 4.1.0 (2020-11-07)
  * Enhancement: feature options can now be specified on a per-client basis for audio and video feature options. For example, you can now specify that a specific RTSP profile be used with a specific client IP address (e.g. Apple TV). This can be useful in situations where you really want to control exactly which RTSP profile is used for a particular HomeKit client. An example of this that is immediately useful to some people: if you use `Enable.Video.Stream.Only.Low` because of trouble streaming remotely (outside of your home), you can now override it when you are home with `Enable.Video.Stream.Only.X.IPADDRESS`, where X is Medium or High, and IPADDRESS represents the static IP address of your iPhone. In this example, when remote, video streaming will always use the Low RTSP profile, but when at home, video streaming will use X.

## 4.0.1 (2020-11-03)
  * Fix for a regression related to event detection on non-UniFi OS platforms.
  * Fix for a race condition related to adding newly detected Protect devices - `homebridge-unifi-protect` will wait until they are finsihed being adopted by the Protect controller before adding the device to HomeKit.

## 4.0.0 (2020-11-01)
  * **IMPORTANT BREAKING CHANGE**: many of the [feature options](https://github.com/hjdhjd/homebridge-unifi-protect/blob/main/docs/FeatureOptions.md) have had their names change (mostly minor changes) in order to create clear namespaces and provide more consistency throughout the plugin. As feature options have grown over time, I took a step back and wanted to rethink how to logically structure them and prepare for the future. Refer to the [feature options](https://github.com/hjdhjd/homebridge-unifi-protect/blob/main/docs/FeatureOptions.md) documentation for the complete reference, and update your feature options before you restart Homebridge.
  * New [feature option](https://github.com/hjdhjd/homebridge-unifi-protect/blob/main/docs/FeatureOptions.md): `Audio`. This will allow you to enable or disable audio support for cameras.
  * New [feature option](https://github.com/hjdhjd/homebridge-unifi-protect/blob/main/docs/FeatureOptions.md): `Doorbell.Trigger`. This feature has a dual purpose:
    * First, for Protect cameras that are not hardware doorbells, this will allow you to enable or disable HomeKit doorbell support on **any** Protect camera.
    * Second, this will create a switch accessory in HomeKit that you can use to manage automations - you can use it to trigger a doorbell ring, and the switch will turn on or off when a genuine ring occurs on Protect hardware doorbells.
  * **Breaking change**: The `ContactSensor` [feature option](https://github.com/hjdhjd/homebridge-unifi-protect/blob/main/docs/FeatureOptions.md) for Protect doorbells has been deprecated and removed in favor of the new `Doorbell.Trigger` feature option, which provides this functionality and more.
  * New [feature option](https://github.com/hjdhjd/homebridge-unifi-protect/blob/main/docs/FeatureOptions.md): `Motion.SmartDetect`. This feature option takes advantage of new smart detection capabilities in Protect controller v1.15 and above for **for G4 series cameras only** (that's a Protect limitation, not a limitation of `homebridge-unifi-protect`). Smart detection is Protect's name for AI/ML-based object detection for motion events. Currently, Protect can detect people, but I expect more object types to be added in the future, and `homebridge-unifi-protect` will support them when they do. This feature option allows you to use Protect's smart object detection to decide whether to notify you of a motion event or not. What does this mean to you? If you only want to see a motion event when Protect detects an actual person rather than some leaves blowing across the camera, this is the feature you've been waiting for. **This feature is only available for UniFi OS-based Protect controllers - UCKgen2+ controllers aren't currently supported. I plan to add support for this feature on UCKgen2+ in the future.** Read the [feature options](https://github.com/hjdhjd/homebridge-unifi-protect/blob/main/docs/FeatureOptions.md) documentation for more information.
  * Enhancement: video stream selection has been redesigned and improved. We now match the resolution requested by HomeKit against the list of available RTSP streams from the Protect camera to provide a richer experience. This should result in improved compatibility across a broader range of resolutions across the Apple ecosystem (iOS, iPadOS, macOS, tvOS, watchOS). Oh...it also includes support for 4K resolutions which it seems that HomeKit is beginning to add support for (though not officially in the HomeKit spec yet).
  * Enhancement: improve overall responsiveness by enforcing time limits on the Protect API. You **will** see more errors and alerts in the logs related to the controller API. They can largely be ignored. Protect controllers are occasionally very slow to respond, taking 5+ seconds to return an API call. We now aggressively terminate those calls in order to not slow down HomeKit / Homebridge responsiveness overall. **For the most part, these error messages can be safely ignored and `homebridge-unifi-protect` will handle them gracefully.**
  * Enhancement: when `homebridge-unifi-protect` is unable to retrieve a snapshot from the controller, it will attempt to use the most recent snapshot from that camera, if that snapshot is less than 60 seconds old.
  * Enhancement: improve startup times by better utilizing the Homebridge object cache.
  * Enhancement: increase responsiveness of LCD messages using the realtime events API on UniFi OS-based controllers.

## 3.7.9 (2020-10-10)
  * Housekeeping updates and minor optimizations.

## 3.7.8 (2020-10-02)
  * Enhancement: streamlined handling when Protect devices become unavailable.
  * Fix: workaround a limitation in Homebridge where it doesn't notify us of a video stream disappearing. This will hopefully be addressed in a future Homebridge release.

## 3.7.7 (2020-09-27)
  * Fix: Redact MQTT password information in Homebridge logs.

## 3.7.6 (2020-09-22)
  * Housekeeping updates and minor optimizations.

## 3.7.5 (2020-09-18)
  * Housekeeping fixes.

## 3.7.4 (2020-09-16)
  * Housekeeping fixes.

## 3.7.3 (2020-09-16)
  * Fix: Really fix that pesky logging regression.

## 3.7.2 (2020-09-16)
  * Fix: Really fix that pesky logging regression.

## 3.7.1 (2020-09-16)
  * Fix: Small regression related to logging.

## 3.7.0 (2020-09-16)
  * New feature: noise filters. Read the [documentation](https://github.com/hjdhjd/homebridge-unifi-protect/blob/main/docs/AudioOptions.md) and the associated [feature options](https://github.com/hjdhjd/homebridge-unifi-protect/blob/main/docs/FeatureOptions.md)
  * Enhancement: improved device detection support in anticipation of more types of UniFi Protect cameras in the future.
  * Enhancement: support for self-signed TLS certificates for those with MQTT brokers.
  * New behavior: motion switches for each camera are now disabled by default. To better understand why, please read [homebridge-unifi-protect best practices](https://github.com/hjdhjd/homebridge-unifi-protect/blob/main/docs/BestPractices.md) for more information. Motion detection remains on by default, of course. Fear not, you can still get them back by default if you want - just set the [feature option](https://github.com/hjdhjd/homebridge-unifi-protect/blob/main/docs/FeatureOptions.md) `Enable.MotionSwitch` either globally, or per-camera.
  * New behavior: motion and doorbell events are not logged by default. This goes along with the above to reduce unnecessary logging. If you're like to restore the previous behavior, just set the [feature option](https://github.com/hjdhjd/homebridge-unifi-protect/blob/main/docs/FeatureOptions.md) `Enable.LogMotion`  and `Enable.LogDoorbell` either globally, or per-camera. You can read more about [homebridge-unifi-protect best practices](https://github.com/hjdhjd/homebridge-unifi-protect/blob/main/docs/BestPractices.md) to understand why the defaults were changed.
  * Various housekeeping improvements.

## 3.6.5 (2020-09-09)
  * Fix: minor update to cleanup aspects of logging.

## 3.6.4 (2020-09-08)
  * New [feature options](https://github.com/hjdhjd/homebridge-unifi-protect/blob/main/docs/FeatureOptions.md) `LogMotion` and `LogDoorbell` to control whether motion or doorbell events get logged. You can set this for the entire controller, or individual cameras, like all feature options.
  * Fix a regression that was introduced in 3.6.3 for non-UniFi OS users where motion detection and doorbell events weren't being sent.
  * **Note: starting with v3.6.4, this plugin will only publish updates as `homebridge-unifi-protect`. See below for more information on the deprecation of the `homebridge-unifi-protect` name.**

## 3.6.3 (2020-09-07)
  * **IMPORTANT: NAME CHANGE.** Starting with this release, this plugin is now renamed to `homebridge-unifi-protect`. My thanks to the previous owner of the NPM name for `homebridge-unifi-protect` for graciously transitioning it to me. What does this mean for you?
    * You should uninstall this package and reinstall it under it's new name, `homebridge-unifi-protect`. That should do the trick. Your configuration won't be impacted. Apologies for any extra gymnastics this might cause some people, but it will help future users and make this plugin more discoverable.
    * `homebridge-unifi-protect` will soon be deprecated. You'll receive a warning message that the package has been deprecated and to install `homebridge-unifi-protect` instead.
    * Again my apologies for any extra work this causes people, but I hope it will be a mostly painless transition.
    * Quick steps for those using the command line:
      ```sh
      npm -g uninstall homebridge-unifi-protect
      npm -g --unsafe-perm install homebridge-unifi-protect
      ```
      Restart homebridge and you're all set.

  * Enhancement: after several weeks of testing, I've shifted our realtime events API over to the updates realtime events API. This took some time to reverse engineer because it's a binary protocol, and I wanted to ensure it was solid before releasing it. What's new for you? Doorbell events should be even faster now for those on UniFi OS-based controllers.
  * Fix: messages weren't always properly reset when using the messages switch feature on doorbells.

## 3.6.2 (2020-09-05)
  * Minor bugfixes and dependency updates.

## 3.6.1 (2020-09-04)
  * Update to support older versions of Node.

## 3.6.0 (2020-09-04)
  * **This version requires homebridge 1.1.3 or greater. Video streaming will not work unless you upgrade your homebridge version.** The updated version of homebridge resolves a long-standing issue relating to those who can get snapshots but not stream video. The source of the issue is related to network interface and IP address confusion that should now be resolved.
  * New feature: Motion trigger switches. You can automate the triggering of a motion event. See the new `MotionTrigger` [feature option](https://github.com/hjdhjd/homebridge-unifi-protect/blob/main/docs/FeatureOptions.md) for details.
  * Enhancement: Security system alarm support. You can now optionally add in support for setting and clearing alarm states on the security system accessory. See the [liveview scenes documentation](https://github.com/hjdhjd/homebridge-unifi-protect/blob/main/docs/Liveviews.md#security-system) for more details.
  * Enhancement: Significant update in MQTT capabilities. Get snapshots, the current message on a doorbell, or trigger a motion event...and more. For more details, [read here](https://github.com/hjdhjd/homebridge-unifi-protect/blob/main/docs/MQTT.md).
  * Added documentation for troubleshooting.

## 3.5.1 (2020-08-27)
  * Minor fixes and address a potential ffmpeg edge case.

## 3.5.0 (2020-08-26)
  * New feature: Two-way audio support for doorbells and cameras that support it. For those who have G4 Doorbells, you now have the ability to use two-way audio...with a catch. Automatic echo cancellation (AEC) is unavailable which means you'll hear your own voice. [Read more here](https://github.com/hjdhjd/homebridge-unifi-protect/blob/main/docs/Doorbell.md#doorbell-twoway). Note: this support is untested on the UniFi Protect G3 Mini, but I expect it should work given the consistency in Ubiquiti's implementation. Enjoy. :smile:
  * Enhancement: Improved default network interface detection.

## 3.4.0 (2020-08-22)
  * New feature: Complete doorbell message support. For those who have G4 Doorbells, you now have the ability to set the message on the doorbell from within HomeKit. TL;DR - a switch will appear on your doorbell for each message that's configured. [Full details here](https://github.com/hjdhjd/homebridge-unifi-protect/blob/main/docs/Doorbell.md). Oh...and you can use MQTT to set arbitrary doorbell message too. :smile:
  * New feature: You can now create HomeKit automations based on doorbell ring events. This feature really should exist in HomeKit, but unfortunately Apple doesn't allow you to create automations for doorbell ring events. [Full details here](https://github.com/hjdhjd/homebridge-unifi-protect/blob/main/docs/Doorbell.md).
  * Minor housekeeping throughout the plugin.

## 3.3.2 (2020-08-18)
  * Housekeeping updates to the plugin configuration webUI and streaming.

## 3.3.1 (2020-08-18)
  * Enhancement: publish motion sensor reset events to MQTT.

## 3.3.0 (2020-08-17)
  * New feature: MQTT support, for those that have asked for it. Read more [here](https://github.com/hjdhjd/homebridge-unifi-protect/blob/main/docs/MQTT.md).
  * Enhancement: Liveviews can now be used to create switches to control groups of motion sensors Read more [here](https://github.com/hjdhjd/homebridge-unifi-protect/blob/main/docs/Liveviews.md).

## 3.2.0 (2020-08-16)
  * New feature: initial support for UniFi Protect G4 Doorbell. We support doorbell rings, video, and receiving audio in this release.
  * Enhancement: enable connection reuse (aka keepalives) on UniFi OS platforms.
  * Fix: correct a race condition that can occur when adding new cameras in realtime.
  * Fix: refresh Protect controller security credentials on a regular basis.

## 3.1.3 (2020-08-12)
  * Minor updates to support libraries and some housekeeping.

## 3.1.2 (2020-08-09)
  * Fix: correctly disable a Protect controller when configured to do so in options.

## 3.1.1 (2020-08-07)
  * Fix: improve streaming startup latency and performance.

## 3.1.0 (2020-08-06)
  * New feature: enable or disable motion detection across multiple cameras simultaneously using the liveview feature in the UniFi Protect controller webUI. This will activate a new HomeKit security system accessory for this plugin and give you the ability to really tailor when alerts get generated, and for which cameras. [Read more about it here](https://github.com/hjdhjd/homebridge-unifi-protect/blob/main/docs/Liveviews.md).
  * Enhancement: snapshots are now pulled directly from the Protect controller. This should substantially improve both the speed of snapshot generation and the image quality which were previously generated from a video frame.
  * Enhancement: improved error detection and notification when you configure a bad hostname or IP address.
  * Enhancement: the API now intelligently backs off when errors are detected to avoid spamming your logs and hammering the Protect controller.
  * Some housekeeping and reorganization of documentation for better discovery.

## 3.0.2 (2020-08-04)
  * Fix: URL typo in package.

## 3.0.1 (2020-08-04)
  * Fix: ensure ffmpeg sessions are properly shutdown when inactive.
  * Fix: eliminate a warning that might occur in installations with more than 10 Protect cameras related to event listeners.

## 3.0.0 (2020-08-04)
  * **Breaking change - homebridge may not start properly:** the platform name of this plugin in config.json has changed. Your best bet might be to uninstall the plugin and then reinstall it, to eliminate any need for manual configuration. To manually make the change you need to update the `platform` configuration block for this plugin in your Homebridge `config.json` and change it to `UniFi Protect` (and note that the name is case sensitive as well).
  * Change: **All cameras that existed in HomeKit from prior versions of this plugin need to be manually deleted.** This is an unfortunate side effect of refactoring to take advantage of the modern Homebridge APIs, which now allow us to do things like dynamically add and remove cameras without having users jump through hoops anymore. Sorry for this one-time disruption.
  * Completely redesigned plugin to take advantage of modern Homebridge capabilities. I've rewritten this plugin from the ground up to make it more scalable and maintainable over time. **There are breaking changes as a result**.
  * **New feature: complete autoconfiguration.** As long as the user you're using has administrative privileges on your UniFi Protect, this plugin will now autoconfigure everything it needs. No more having to manually enable RTSP streams to get things going.
  * **New feature: motion detection.** This has been the big one. I've reverse engineered the *realtime Protect notification API* that allows this plugin to alert as soon as event is detected on a UniFi Protect device. This means we don't need to poll every few moments to figure out what's going on, thereby reducing the performance impact on UniFi Protect controllers. **This is huge**. There is a catch - it's only supported on UniFi OS controllers. UCK Gen2+ installations don't have support for the realtime notification API - perhaps it'll be added in the future by Ubiquiti. That said, we do provide polling support for motion detection on UCK Gen2+ installations, so fear not, you get motion detection too!
  * **New feature: granular feature options to allow you to tailor the behavior of this plugin.** Set the quality on individual cameras, hide cameras from HomeKit, and more. See the feature options section below for more details.
  * See the [developer page](https://github.com/hjdhjd/homebridge-unifi-protect) for more details and documentation.
