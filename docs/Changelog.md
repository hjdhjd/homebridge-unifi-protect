# Changelog

All notable changes to this project will be documented in this file. This project uses [semantic versioning](https://semver.org/).

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
  * New feature: full UniFi Protect ViewPort support. You can configure which liveview is used for ViewPort directly in HomeKit.
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
