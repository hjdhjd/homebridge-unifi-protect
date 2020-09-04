# Changelog

All notable changes to this project will be documented in this file. This project uses [semantic versioning](https://semver.org/).

## 3.6.0
  * **This version requires homebridge 1.1.3 or greater. Video streaming will not work unless you upgrade your homebridge version.** The updated version of homebridge resolves a long-standing issue relating to those who can get snapshots but not stream video. The source of the issue is related to network interface and IP address confusion that should now be resolved.
  * New feature: Motion trigger switches. You can automate the triggering of a motion event. See the new `MotionTrigger` [feature option](https://github.com/hjdhjd/homebridge-unifi-protect2/blob/master/docs/FeatureOptions.md) for details.
  * Enhancement: Security system alarm support. You can now optionally add in support for setting and clearing alarm states on the security system accessory. See the [liveview scenes documentation](https://github.com/hjdhjd/homebridge-unifi-protect2/blob/master/docs/Liveviews.md#security-system) for more details.
  * Enhancement: Significant update in MQTT capabilities. Get snapshots, the current message on a doorbell, or trigger a motion event...and more. For more details, [read here](https://github.com/hjdhjd/homebridge-unifi-protect2/blob/master/docs/MQTT.md).
  * Added documentation for troubleshooting.

## 3.5.1 (2020-08-27)
  * Minor fixes and address a potential ffmpeg edge case.

## 3.5.0 (2020-08-26)
  * New feature: Two-way audio support for doorbells and cameras that support it. For those who have G4 Doorbells, you now have the ability to use two-way audio...with a catch. Automatic echo cancellation (AEC) is unavailable which means you'll hear your own voice. [Read more here](https://github.com/hjdhjd/homebridge-unifi-protect2/blob/master/docs/Doorbell.md#doorbell-twoway). Note: this support is untested on the UniFi Protect G3 Mini, but I expect it should work given the consistency in Ubiquiti's implementation. Enjoy. :smile:
  * Enhancement: Improved default network interface detection.

## 3.4.0 (2020-08-22)
  * New feature: Complete doorbell message support. For those who have G4 Doorbells, you now have the ability to set the message on the doorbell from within HomeKit. TL;DR - a switch will appear on your doorbell for each message that's configured. [Full details here](https://github.com/hjdhjd/homebridge-unifi-protect2/blob/master/docs/Doorbell.md). Oh...and you can use MQTT to set arbitrary doorbell message too. :smile:
  * New feature: You can now create HomeKit automations based on doorbell ring events. This feature really should exist in HomeKit, but unfortunately Apple doesn't allow you to create automations for doorbell ring events. [Full details here](https://github.com/hjdhjd/homebridge-unifi-protect2/blob/master/docs/Doorbell.md).
  * Minor housekeeping throughout the plugin.

## 3.3.2 (2020-08-18)
  * Housekeeping updates to the plugin configuration webUI and streaming.

## 3.3.1 (2020-08-18)
  * Enhancement: publish motion sensor reset events to MQTT.

## 3.3.0 (2020-08-17)
  * New feature: MQTT support, for those that have asked for it. Read more [here](https://github.com/hjdhjd/homebridge-unifi-protect2/blob/master/docs/MQTT.md).
  * Enhancement: Liveviews can now be used to create switches to control groups of motion sensors Read more [here](https://github.com/hjdhjd/homebridge-unifi-protect2/blob/master/docs/Liveviews.md).

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
  * New feature: enable or disable motion detection across multiple cameras simultaneously using the liveview feature in the UniFi Protect controller webUI. This will activate a new HomeKit security system accessory for this plugin and give you the ability to really tailor when alerts get generated, and for which cameras. [Read more about it here](https://github.com/hjdhjd/homebridge-unifi-protect2/blob/master/docs/Liveviews.md).
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
  * See the [developer page](https://github.com/hjdhjd/homebridge-unifi-protect2) for more details and documentation.
