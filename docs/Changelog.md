# Changelog

All notable changes to this project will be documented in this file. This project uses [semantic versioning](https://semver.org/).

## 3.3.2 (2020-08-18)
  * Houskeeping updates to the plugin configuration webUI.

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
