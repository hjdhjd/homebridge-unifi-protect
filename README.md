<SPAN ALIGN="CENTER" STYLE="text-align:center">
<DIV ALIGN="CENTER" STYLE="text-align:center">

[![homebridge-unifi-protect2: Native HomeKit support for UniFi Protect](https://raw.githubusercontent.com/hjdhjd/homebridge-unifi-protect2/master/homebridge-protect.svg)](https://github.com/hjdhjd/homebridge-unifi-protect2)

# Homebridge UniFi Protect<SUP STYLE="font-size: smaller; color:#0559C9;">2</SUP>

[![Downloads](https://img.shields.io/npm/dt/homebridge-unifi-protect2?color=%230559C9&style=for-the-badge)](https://www.npmjs.com/package/homebridge-unifi-protect2)
[![Version](https://img.shields.io/npm/v/homebridge-unifi-protect2?color=%230559C9&label=UniFi%20Protect%202&logo=ubiquiti&logoColor=%230559C9&style=for-the-badge)](https://www.npmjs.com/package/homebridge-unifi-protect2)
[![verified-by-homebridge](https://img.shields.io/badge/homebridge-verified-blueviolet?color=%2357277C&style=for-the-badge)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)

## HomeKit support for the UniFi Protect ecosystem using [Homebridge](https://homebridge.io).
</DIV>
</SPAN>

`homebridge-unifi-protect2` is a [Homebridge](https://homebridge.io) plugin that provides HomeKit support to the [UniFi Protect](https://unifi-network.ui.com/video-security) device ecosystem. [UniFi Protect](https://unifi-network.ui.com/video-security) is [Ubiquiti's](https://www.ui.com) next-generation video security platform, with rich camera, doorbell, and NVR controller hardware options for you to choose from, as well as an app which you can use to view, configure and manage your video camera and doorbells.

## Why use this plugin for UniFi Protect support in HomeKit?

This plugin attempts to bridge a gap in the UniFi Protect ecosystem by providing native HomeKit support on par with what you would expect from a first-party of native HomeKit solution. Our north star is to create a plugin that *just works* with minimal required configuration by you, the end user, to get up and running. The goal is to provide as close to a streamlined experience as you would expect from a first-party or native HomeKit solution. For the adventurous, there are more granular options available to enable you to further tailor your experience.

What does *just works* mean in practice? It means that this plugin will discover all your supported UniFi Protect devices and make them available in HomeKit. It supports all known UniFi Protect controller configurations (UniFi CloudKey Gen2+, UniFi Dream Machine Pro, and UniFi Protect NVR).

### Features
- ***Easy* configuration - all you need is your UniFi Protect controller IP address, username, and password to get started.** The defaults work for the vast majority of users. When you want more, there are [advanced options](https://github.com/hjdhjd/homebridge-unifi-protect2/blob/master/docs/AdvancedOptions.md) you can play with, if you choose.

- **Blazing fast video streaming.** Video streaming from HomeKit will start within in 1-2 seconds for G3-series cameras and 3-4 seconds for G4-series cameras, in most cases. I've spent the time to optimize the video streaming experience to ensure it feels very responsive, and *just works*.

- **[Full UniFi Protect G4 Doorbell support.](https://github.com/hjdhjd/homebridge-unifi-protect2/blob/master/docs/Doorbell.md).** This plugin provides complete support for [UniFi Protect G4 Doorbells](https://store.ui.com/collections/unifi-protect/products/uvc-g4-doorbell). We support all the features of the doorbell including - doorbell rings, two-way audio, and the use of the onboard LCD screen for messages. Two-way audio has caveats you should be aware of.

- **[Two-way audio support](https://github.com/hjdhjd/homebridge-unifi-protect2/blob/master/docs/Doorbell.md#doorbell-twoway) for all UniFi Protect cameras that support it**. In addition to [UniFi Protect G4 Doorbells](https://store.ui.com/collections/unifi-protect/products/uvc-g4-doorbell), the [UniFi Protect G3 Micro](https://store.ui.com/collections/unifi-protect/products/unifi-video-g3-micro) provides two-way audio capabilities, and that functionality is available to you in HomeKit.

- **Support for multiple controllers.** This plugin can support multiple UniFi Protect controllers. If you have more than one controller, it's easy to add them to this plugin, and integrate them seamlessly into HomeKit.

- **Automatic *continuous* detection and configuration of all UniFi Protect devices.** By default - all of your supported UniFi Protect devices are made available in HomeKit without needing any further configuration on your part. Additionally, if you add or remove cameras or other devices to your UniFi Protect controller, this plugin will autodetect those configuration changes and add or remove those devices in HomeKit, seamlessly, *in realtime*.

- **The ability to [selectively hide and show](https://github.com/hjdhjd/homebridge-unifi-protect2/blob/master/docs/FeatureOptions.md) specific Protect devices.** For those who only want to show particular devices in HomeKit, or particular controllers, a flexible and intuitive way to configure device availability at a granular level is available.

- **Motion detection support using a native realtime notification API (UniFi OS).** On UniFI OS-based controllers, we use a native realtime notification API, *without having to continuously poll the UniFI Protect controller.* This does a couple of things - first, it provides ***true*** realtime HomeKit rich notifications when motion is detected, including image snapshots. Second, this approach eliminates the requirement to continuously poll every few seconds that most non-native solutions to motion detection on UniFi Protect have used until now and reduces the load on UniFi Protect controllers substantially.

- **Motion detection support for UniFi CloudKey Gen2+ controllers.** For those using UCK Gen2+ controllers, support for motion detection with rich notifications is also available, although only using poll-based notifications. Unfortunately, Ubiquiti hasn't yet implemented a realtime notification API for UCK Gen2+ controllers, but should Ubiquiti implement it in the future, this plugin will provide support for it.

- **Motion sensor control from within HomeKit.** By default, all detected cameras have two additional services attached to them - a motion sensor service, and a motion switch service. The motion switch allows you to selectively activate and deactivate motion detection of your cameras. This is especially useful in automation scenarios where you wish to activate or deactivate motion detection selectively when you leave your home or arrive home, for example.

- **Create scenes or presets for groups of cameras.** If you choose to [create specific liveviews](https://github.com/hjdhjd/homebridge-unifi-protect2/blob/master/docs/Liveviews.md), a security system accessory will appear in HomeKit, enabling you to have motion-detection scenes or presets a tap away. For even more customization, you can create liveview-based switches that will allow you to enable or disable motion detection on groups of cameras. They're easy and intuitive to create and can amplify your user experience in HomeKit.

- **MQTT support.** [MQTT](https://mqtt.org) support is available for those that want to [make UniFi Protect accessible to an MQTT broker](https://github.com/hjdhjd/homebridge-unifi-protect2/blob/master/docs/MQTT.md).

### What's not in this plugin right now

Acoustic Echo Cancellation (AEC) support for two-way audio in UniFi Protect. We're most of the way there with two-way audio support, and hopefully AEC support can be reverse-engineered in the future.

Currently, we support doorbell ring events, motion sensor, incoming video, and two-way audio.

I hope to continue to work on this one to get AEC working for two-way audio. [You can also read more on about two-way audio support here](https://github.com/hjdhjd/homebridge-unifi-protect2/blob/master/docs/Doorbell.md#doorbell-twoway).

## Documentation
* Getting going
  * [Installation](#installation): installing this plugin, including system requirements.
  * [Plugin Configuration](#plugin-configuration): how to quickly get up and running.
* Advanced Topics
  * [Autoconfiguration](https://github.com/hjdhjd/homebridge-unifi-protect2/blob/master/docs/Autoconfiguration.md): what it is, design choices that I've made, and why.
  * [Feature Options](https://github.com/hjdhjd/homebridge-unifi-protect2/blob/master/docs/FeatureOptions.md): granular options to allow you to set the camera quality individually, show or hide specific cameras, controllers, and more.
  * [Doorbells](https://github.com/hjdhjd/homebridge-unifi-protect2/blob/master/docs/Doorbell.md): how UniFi Protect doorbell support works in this plugin, and how to use all the available features including doorbell messages.
  * [Liveview Scenes](https://github.com/hjdhjd/homebridge-unifi-protect2/blob/master/docs/Liveviews.md): use the UniFi Protect liveviews feature (available in the UniFi Protect controller webUI) to create motion-detection scenes.
  * [MQTT](https://github.com/hjdhjd/homebridge-unifi-protect2/blob/master/docs/MQTT.md): how to configure MQTT support.
  * [Advanced Configuration](https://github.com/hjdhjd/homebridge-unifi-protect2/blob/master/docs/AdvancedOptions.md): complete list of configuration options available in this plugin.
  * [Changelog](https://github.com/hjdhjd/homebridge-unifi-protect2/blob/master/docs/Changelog.md): changes and release history of this plugin, starting with v3.0.

## Installation
If you are new to Homebridge, please first read the [Homebridge](https://homebridge.io) [documentation](https://github.com/homebridge/homebridge/wiki) and installation instructions before proceeding.

If you have installed the [Homebridge Config UI](https://github.com/oznu/homebridge-config-ui-x), you can intall this plugin by going to the `Plugins` tab and searching for `homebridge-unifi-protect2` and installing it.

If you prefer to install `homebridge-unifi-protect2` from the command line, you can do so by executing:

```sh
sudo npm install --unsafe-perm -g homebridge-unifi-protect2
```

You will need a working **ffmpeg** installation for this plugin to work. Configuring ffmpeg is beyond the scope of this manual. Please refer to the
excellent documentation for [homebridge-camera-ffmpeg](https://github.com/Sunoo/homebridge-camera-ffmpeg).

### Audio
Audio on cameras is tricky in the HomeKit world to begin with, and when you throw in some of the specifics of how UniFi Protect works, it gets even more interesting. Some things to keep in mind if you want to use audio with UniFi Protect:

* This plugin provides audio on UniFi cameras and doorbells. This includes two-way audio on the [G4 Doorbell](https://store.ui.com/collections/unifi-protect/products/uvc-g4-doorbell) and [G3 Micro](https://store.ui.com/collections/unifi-protect/products/unifi-video-g3-micro).

* There is one notable caveat, currently, with two-way audio: the lack of acoustic echo cancellation, or AEC. [Read more on about two-way audio here](https://github.com/hjdhjd/homebridge-unifi-protect2/blob/master/docs/Doorbell.md#doorbell-twoway).

* **Audio support will not work unless you have a version of ffmpeg that supports fdk-aac.** Unfortunately, most default installations of ffmpeg are not compiled with support for fdk-aac. You'll need to compile or acquire a version of ffmpeg that does. Doing so is beyond the scope of this documentation. There are plenty of guides to this - Google is your friend. This plugin uses [ffmpeg-for-homebridge](https://www.npmjs.com/package/ffmpeg-for-homebridge) which eases the pain somewhat by providing prebuilt static binaries of ffmpeg for certain platforms, and save you the trouble of having to compile a version of ffmpeg yourself.

### Using another video processor
`videoProcessor` is the video processor used to stream video. By default, this is [ffmpeg](https://ffmpeg.org), but can be your own custom version of ffmpeg or other video processor that accepts and understands ffmpeg command line arguments.

```
{
  "platform": "UniFi Protect",
  "videoProcessor": "/my/own/compiled/ffmpeg",
  "controllers": [
    ...
  ]
}
```

### Things to be aware of
- **Beginning with v3.0, this plugin requires Homebridge v1.0 on greater to work. For some, this may be a breaking change if you are running on older versions of Homebridge.**

- Also beginning with v3.0, the `platform` configuration block for this plugin in your Homebridge `config.json` has been renamed to `UniFi Protect` (and note that the name is case sensitive as well). See the [plugin configuration section below](#plugin-configuration) for details. **This is a breaking change for those upgrading from v2.x and you will need to update your `config.json` to reflect the updates or your homebridge installation may not start properly**.

## Plugin configuration
If you choose to configure this plugin directly instead of using the [Homebridge Configuration web UI](https://github.com/oznu/homebridge-config-ui-x), you'll need to add the platform to your `config.json` in your home directory inside `.homebridge`.

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
For most people, I recommend using [Homebridge Configuration web UI](https://github.com/oznu/homebridge-config-ui-x) to configure this plugin rather than doing so directly. It's easier to use for most users, especially newer users, and less prone to typos, leading to other problems.

For UniFi OS devices like UDM-Pro, UniFi NVR, you can use your Ubiquiti account credentials, though 2FA is not currently supported. That said, **I strongly recommend creating a local user just for Homebridge instead of using this option.**

