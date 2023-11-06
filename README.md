<SPAN ALIGN="CENTER" STYLE="text-align:center">
<DIV ALIGN="CENTER" STYLE="text-align:center">

[![homebridge-unifi-protect: Native HomeKit support for UniFi Protect](https://raw.githubusercontent.com/hjdhjd/homebridge-unifi-protect/main/images/homebridge-unifi-protect.svg)](https://github.com/hjdhjd/homebridge-unifi-protect)

# Homebridge UniFi Protect
[![Downloads](https://img.shields.io/npm/dt/homebridge-unifi-protect?color=%230559C9&logo=icloud&logoColor=%23FFFFFF&style=for-the-badge)](https://www.npmjs.com/package/homebridge-unifi-protect)
[![Version](https://img.shields.io/npm/v/homebridge-unifi-protect?color=%230559C9&label=Latest%20Version&logo=ubiquiti&logoColor=%23FFFFFF&style=for-the-badge)](https://www.npmjs.com/package/homebridge-unifi-protect)
[![UniFi Protect@Homebridge Discord](https://img.shields.io/discord/432663330281226270?color=0559C9&label=Discord&logo=discord&logoColor=%23FFFFFF&style=for-the-badge)](https://discord.gg/QXqfHEW)
[![verified-by-homebridge](https://img.shields.io/badge/homebridge-verified-blueviolet?color=%23491F59&style=for-the-badge&logoColor=%23FFFFFF&logo=homebridge)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)

## Complete HomeKit support for the UniFi Protect ecosystem using [Homebridge](https://homebridge.io).
</DIV>
</SPAN>

`homebridge-unifi-protect` is a [Homebridge](https://homebridge.io) plugin that provides HomeKit support to the [UniFi Protect](https://ui.com/us/camera-security) device ecosystem. [UniFi Protect](https://ui.com/us/camera-security) is [Ubiquiti's](https://www.ui.com) video security platform, with rich camera, doorbell, and NVR controller hardware options for you to choose from, as well as an app which you can use to view, configure and manage your video camera and doorbells.

## <A NAME="why"></A>Why Use This Plugin For UniFi Protect Support In HomeKit?
This plugin attempts to bridge a gap in the UniFi Protect ecosystem by providing native HomeKit support on par with what you would expect from a first-party of native HomeKit solution. My north star is to create a plugin that *just works* with minimal required configuration by you to get up and running. The goal is to provide as close to a streamlined experience as you would expect from a first-party or native HomeKit solution. For the adventurous, there are more granular options available to enable you to further tailor your experience.

What does *just works* mean in practice? It means that this plugin will discover all your supported UniFi Protect devices and make them available in HomeKit. It supports all known UniFi Protect controller configurations (UniFi CloudKey Gen2+, UniFi Dream Machine Pro/SE, and UniFi Protect NVR).

For the more technically inclined - this plugin has continued to pioneer the HomeKit user experience for UniFi Protect by being the ***first*** Homebridge plugin (and first third-party app, to my knowledge) to successfully reverse engineer the UniFi Protect realtime events API that was introduced with UniFi OS. This allows instantaneous, realtime capturing of events as they occur in the Protect ecosystem, allowing us to provide that same level of realtime sensor and camera feedback to HomeKit. Since reverse engineering the realtime events API, most of the major open source smart automation projects have benefited and also incorporated our work, improving the experience for everyone across smart home ecosystems.

### Features
- ***Easy* configuration - all you need is your UniFi Protect controller IP address, username, and password to get started.** The defaults work quite well for the vast majority of users. When you want more, there are [additional options](https://github.com/hjdhjd/homebridge-unifi-protect/blob/main/docs/FeatureOptions.md) you can play with, if you choose.

- **Full HomeKit support for the UniFi Protect ecosystem.** All generally available UniFi Protect devices are supported, including cameras, chimes, doorbells, lights, sensors, and Viewports.

- **[Complete HomeKit Secure Video support for all UniFi Protect cameras.](https://github.com/hjdhjd/homebridge-unifi-protect/blob/main/docs/HomeKitSecureVideo.md)** Complete HomeKit Secure Video support, without the need for additional plugins or software beyond FFmpeg. Another community first - all without the need for additional tools to get a complete solution.

- **Incredibly high performance.** I've spent the time to optimize the video streaming experience to ensure it feels very responsive, and *just works*. For those that have hardware-accelerated CPUs and GPUs, live video stream load times using the Home app on iOS average at 0.2-0.3 seconds on a day-to-day basis, which is often better than the native UniFi Protect app! Supported hardware-accelerated platforms are currently: Apple Macs (both Intel and Apple Silicon), Intel Quick Sync Video-enabled CPUs, and Raspberry Pi 4. When not using hardware acceleration, or on slower systems, you can expect live video streams to load within 1-2 seconds.

- **[Full UniFi Protect Doorbell support.](https://github.com/hjdhjd/homebridge-unifi-protect/blob/main/docs/Doorbell.md).** This plugin provides complete support for [UniFi Protect Doorbells](https://store.ui.com/collections/unifi-protect/products/uvc-g4-doorbell). We support all the features of the doorbell including - doorbell rings, two-way audio, package camera support, and the use of the onboard LCD screen for messages. Two-way audio has caveats you should be aware of.

- **[Two-way audio support](https://github.com/hjdhjd/homebridge-unifi-protect/blob/main/docs/Doorbell.md#doorbell-twoway) for all UniFi Protect cameras that support it**. Some Protect devices that support two-way audio capabilities include [UniFi Protect Doorbells](https://store.ui.com/collections/unifi-protect/products/uvc-g4-doorbell), the [UniFi Protect Instant Cameras](https://store.ui.com/collections/unifi-protect/products/unifi-video-g3-micro), and more. If the Protect device supports two-way audio, that functionality is available to you in HomeKit.

- **Support for multiple controllers.** This plugin can support multiple UniFi Protect controllers. If you have more than one controller, it's easy to add them to this plugin, and integrate them seamlessly into HomeKit.

- **Automatic *realtime* detection and configuration of all UniFi Protect devices.** By default - all of your supported UniFi Protect devices are made available in HomeKit without needing any further configuration on your part. Additionally, if you add or remove cameras or other devices to your UniFi Protect controller, this plugin will autodetect those configuration changes and add or remove those devices in HomeKit, seamlessly, *in realtime*. No need to restart Homebridge to see your new Protect devices added or removed.

- **A builtin webUI using the Homebridge webUI plugin framework allows you the ability to [customize the plugin to your needs](https://github.com/hjdhjd/homebridge-unifi-protect/blob/main/docs/FeatureOptions.md).** You can apply options globally, for all devices connected to a specific Protect controller, or for individual Protect devices in an intuitive way using the Homebridge HBUP webUI.

- **Motion sensor control from within HomeKit.** By default, all detected cameras have a motion sensor service. An additional motion switch service can be enabled if you want even more granular control: the motion switch allows you to selectively activate and deactivate motion detection of your cameras. This is especially useful in automation scenarios where you wish to activate or deactivate motion detection selectively when you leave your home or arrive home, for example, or to enable specific groups of cameras to turn on and off motion detection through automation.

- **Occupancy sensors for HomeKit.** Any device with a motion sensor can also be used as an occupancy sensor with the appropriate feature option. This further simplifies automation scenarios where say you want to turn on a light in a room but only when there's motion detected over a certain period of time. Taking it one step further, on Protect devices with smart motion event notification, you can configure the occupancy sensor to only trigger when a person is in the room.

- **Create scenes or presets for groups of cameras.** If you choose to [create specific liveviews](https://github.com/hjdhjd/homebridge-unifi-protect/blob/main/docs/Liveviews.md), a security system accessory will appear in HomeKit, enabling you to have motion-detection scenes or presets a tap away. For even more customization, you can create liveview-based switches that will allow you to enable or disable motion detection on groups of cameras. They're easy and intuitive to create and can amplify your user experience in HomeKit.

- **MQTT support.** [MQTT](https://mqtt.org) support is available for those that want to [make UniFi Protect accessible to an MQTT broker](https://github.com/hjdhjd/homebridge-unifi-protect/blob/main/docs/MQTT.md).

### What's Not In This Plugin Yet
Acoustic Echo Cancellation (AEC) support for two-way audio in UniFi Protect. We're most of the way there with two-way audio support, and hopefully AEC support can be reverse-engineered in the future.

I hope to continue to work on this one to get AEC working for two-way audio. [You can also read more on about two-way audio support here](https://github.com/hjdhjd/homebridge-unifi-protect/blob/main/docs/Doorbell.md#doorbell-twoway).

## Documentation
* Getting Started
  * [Installation](#installation): installing this plugin, including system requirements.
  * [Plugin Configuration](#plugin-configuration): how to quickly get up and running.
  * [Best Practices](https://github.com/hjdhjd/homebridge-unifi-protect/blob/main/docs/BestPractices.md): best practices for getting the most of your HomeKit setup and UniFi Protect.
  * [Troubleshooting](https://github.com/hjdhjd/homebridge-unifi-protect/blob/main/docs/Troubleshooting.md): running into login problems or streaming issues? Give this a read before looking anywhere else.
* Advanced Topics
  * [Autoconfiguration](https://github.com/hjdhjd/homebridge-unifi-protect/blob/main/docs/Autoconfiguration.md): how Protect controller autoconfiguration, transcoding and transmuxing work in HBUP, and why.
  * [Feature Options](https://github.com/hjdhjd/homebridge-unifi-protect/blob/main/docs/FeatureOptions.md): granular options to allow you to set the camera quality individually, show or hide specific cameras, controllers, and more.
  * [Audio Options](https://github.com/hjdhjd/homebridge-unifi-protect/blob/main/docs/AudioOptions.md): options to further tailor how audio is handled from Protect, such as background noise reduction.
  * [Doorbells](https://github.com/hjdhjd/homebridge-unifi-protect/blob/main/docs/Doorbell.md): how UniFi Protect doorbell support works in this plugin, and how to use all the available features including doorbell messages.
  * [HomeKit Secure Video](https://github.com/hjdhjd/homebridge-unifi-protect/blob/main/docs/HomeKitSecureVideo.md): how HomeKit Secure Video support works in this plugin with UniFi Protect.
  * [Liveview Scenes](https://github.com/hjdhjd/homebridge-unifi-protect/blob/main/docs/Liveviews.md): use the UniFi Protect liveviews feature (available in the UniFi Protect controller webUI) to create motion-detection scenes.
  * [MQTT](https://github.com/hjdhjd/homebridge-unifi-protect/blob/main/docs/MQTT.md): how to configure MQTT support.
  * [Advanced Configuration](https://github.com/hjdhjd/homebridge-unifi-protect/blob/main/docs/AdvancedOptions.md): complete list of configuration options available in this plugin.
  * [realtime API Documentation](https://github.com/hjdhjd/homebridge-unifi-protect/blob/main/docs/ProtectAPI.md): documentation of how the Ubiquiti realtime updates API works and how to decode the binary protocol.
  * [Changelog](https://github.com/hjdhjd/homebridge-unifi-protect/blob/main/docs/Changelog.md): changes and release history of this plugin, starting with v3.0.

## Installation
If you are new to Homebridge, please first read the [Homebridge](https://homebridge.io) [documentation](https://github.com/homebridge/homebridge/wiki) and installation instructions before proceeding.

If you have installed the [Homebridge Config UI](https://github.com/homebridge/homebridge-config-ui-x), you can intall this plugin by going to the `Plugins` tab and searching for `homebridge-unifi-protect` and installing it.

**Important:** you will need a working **ffmpeg** installation for `homebridge-unifi-protect` to work correctly. To make installation more convenient, this plugin uses [ffmpeg-for-homebridge](https://www.npmjs.com/package/ffmpeg-for-homebridge) which provides prebuilt versions of ffmpeg for some of the more popular platforms. [Click here](https://github.com/homebridge/ffmpeg-for-homebridge#supported-platforms) for a list of platforms supported by `ffmpeg-for-homebridge`. If you don't find your platform listed, you'll need to install a working version of ffmpeg for yourself, if you want video streaming to work. **Setting up and configuring ffmpeg is beyond the scope of this documentation.**

### Audio
Audio on cameras is tricky in the HomeKit world to begin with, and when you throw in some of the specifics of how UniFi Protect works, it gets even more interesting. Some things to keep in mind if you want to use audio with UniFi Protect:

* This plugin provides audio on UniFi cameras and doorbells. This includes two-way audio on the [G4 Doorbell](https://store.ui.com/collections/unifi-protect/products/uvc-g4-doorbell), [G3 Micro](https://store.ui.com/collections/unifi-protect/products/unifi-video-g3-micro), and other UniFi Protect devices that support two-way audio.

* There is one notable caveat, currently, with two-way audio: the lack of acoustic echo cancellation, or AEC. [Read more on about two-way audio here](https://github.com/hjdhjd/homebridge-unifi-protect/blob/main/docs/Doorbell.md#doorbell-twoway).

* **Audio support will not work unless you have a version of FFmpeg that supports fdk-aac.** Unfortunately, most default installations of FFmpeg are not compiled with support for fdk-aac. You'll need to compile or acquire a version of FFmpeg that does. Doing so is beyond the scope of this documentation. There are plenty of guides to this - Google is your friend. This plugin uses [ffmpeg-for-homebridge](https://www.npmjs.com/package/ffmpeg-for-homebridge) which eases the pain somewhat by providing prebuilt static binaries of FFmpeg for certain platforms, and save you the trouble of having to compile a version of FFmpeg yourself.

### Things To Be Aware Of
- **Make sure you are running on the latest production / stable firmwares for both your controller platform (UCKgen2+, UDM-Pro, UNVR, etc.) as well as the latest production / stable UniFi Protect controller firmware.**
- **No beta versions of iOS, iPadOS, macOS, tvOS, or watchOS are supported. You are on your own if you choose to install / run beta firmwares - don't expect support or sympathy if you run into issues.**
- **No beta or early access versions of device controller firmware (UCKgen2+, UDM-Pro, UNVR, etc.) are supported by this plugin. You are on your own if you choose to install / run beta firmwares - don't expect support or sympathy if you run into issues.**
- **No beta or early access versions of UniFi Protect firmware are supported by this plugin. You are on your own if you choose to install / run beta firmwares - don't expect support or sympathy if you run into issues.**
- **No beta or early access versions of UniFi Protect hardware are supported by this plugin. You are on your own if you choose to use non-production/GA hardware - don't expect support or sympathy if you run into issues.**
- **My philosophy is to aggressively adopt the capability and features (that make sense in a HomeKit context) in the latest production / stable Ubiquiti firmware releases and to deprecate old functionality that's been superceded by newer, richer, or more performant capabilities - either by HomeKit or Ubiquiti. Read the [Changelog](https://github.com/hjdhjd/homebridge-unifi-protect/blob/main/docs/Changelog.md) carefully for the latest information on what's new.**
- ***For extra clarity and to reiterate the above - before you install this plugin, make sure you are on the latest production / stable controller platform firmware and the latest production / stable UniFi Protect firmware.***

## Plugin Configuration
If you choose to configure this plugin directly instead of using the [Homebridge Configuration webUI](https://github.com/homebridge/homebridge-config-ui-x), you'll need to add the platform to your `config.json` in your home directory inside `.homebridge`.

```js
"platforms": [
  {
    "platform": "UniFi Protect",

    "controllers": [
      {
        "address": "1.2.3.4",
        "username": "some-unifi-protect-user (or create a new one just for homebridge)",
        "password": "some-password"
      }
    ]
  }
]
```
**For most people, I recommend using [Homebridge Configuration web UI](https://github.com/homebridge/homebridge-config-ui-x) to configure this plugin rather than doing so directly. It's easier to use for most users, especially newer users, and less prone to typos, leading to other problems. This plugin has a custom webUI built on top of the Homebridge webUI framework that should simplify feature configuration, and make them more accessible to users.**

You can use your Ubiquiti account credentials, though 2FA is not currently supported. That said, **I strongly recommend creating a local user just for Homebridge instead of using this option.**

## Plugin Development Dashboard
This is mostly of interest to the true developer nerds amongst us.

[![License](https://img.shields.io/npm/l/homebridge-unifi-protect?color=%230559C9&logo=open%20source%20initiative&logoColor=%23FFFFFF&style=for-the-badge)](https://github.com/hjdhjd/homebridge-unifi-protect/blob/main/LICENSE.md)
[![Build Status](https://img.shields.io/github/actions/workflow/status/hjdhjd/homebridge-unifi-protect/ci.yml?branch=main&color=%230559C9&logo=github-actions&logoColor=%23FFFFFF&style=for-the-badge)](https://github.com/hjdhjd/homebridge-unifi-protect/actions?query=workflow%3A%22Continuous+Integration%22)
[![Dependencies](https://img.shields.io/librariesio/release/npm/homebridge-unifi-protect?color=%230559C9&logo=dependabot&style=for-the-badge)](https://libraries.io/npm/homebridge-unifi-protect)
[![GitHub commits since latest release (by SemVer)](https://img.shields.io/github/commits-since/hjdhjd/homebridge-unifi-protect/latest?color=%230559C9&logo=github&sort=semver&style=for-the-badge)](https://github.com/hjdhjd/homebridge-unifi-protect/commits/master)
