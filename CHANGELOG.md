# Changelog

All notable changes to this project will be documented in this file. This project uses [semantic versioning](https://semver.org/).

## 3.0.1 (2020-08-04)
  * Fix: ensure ffmpeg sessions are properly shutdown when inactive.
  * Fix: eliminate a warning that might occur in installations with more than 10 Protect cameras related to event listeners.

## 3.0.0 (2020-08-04)
  * **Breaking change - homebridge may not start properly:** the platform name of this plugin in config.json has changed. Your best bet might be to uninstall the plugin and then reinstall it, to eliminate any need for manual configuration. To manually make the change you need to update the `platform` configuration block for this plugin in your Homebridge `config.json` and change it to `UniFi Protect` (and note that the name is case sensitive as well).
  * Change: **All cameras that existed in HomeKit from prior versions of this plugin need to be manually deleted.** This is an unfortunate side effect of refactoring to take advantage of the modern Homebridge APIs, which now allow us to do things like dynamically add and remove cameras without having users jump through hoops anymore. Sorry for this one-time disruption.
  * Completely redesigned plugin to take advantage of modern Homebridge capabilities. I've rewritten this plugin from the ground up to make it more scalable and maintainable over time. **There are breaking changes as a result**.
  * **New feature: complete autoconfiguration.** As long as the user you're using has administrative privileges on your UniFi Protect, this plugin will now autoconfigure everything it needs. No more having to manually enable RTSP streams to get things going.
  * **New feature: motion detection.** This has been the big one. I've reverse engineered the *realtime Protect notification API* that allows this plugin to alert as soon as event is detected on a UniFi Protect device. This means we don't need to poll every few moments to figure out what's going on, thereby reducing the performance impact on UniFi Protect controlers. **This is huge**. There is a catch - it's only supported on UniFi OS controllers. UCK Gen2+ installations don't have support for the realtime notification API - perhaps it'll be added in the future by Ubiquiti. That said, we do provide polling support for motion detection on UCK Gen2+ installations, so fear not, you get motion detection too!
  * **New feature: granular feature options to allow you to tailor the behavior of this plugin.** Set the quality on individual cameras, hide cameras from HomeKit, and more. See the feature options section below for more details.
  * See the [developer page](https://github.com/hjdhjd/homebridge-unifi-protect2) for more details and documentation.
