<SPAN ALIGN="CENTER" STYLE="text-align:center">
<DIV ALIGN="CENTER" STYLE="text-align:center">

[![homebridge-unifi-protect: Native HomeKit support for UniFi Protect](https://raw.githubusercontent.com/hjdhjd/homebridge-unifi-protect/master/homebridge-protect.svg)](https://github.com/hjdhjd/homebridge-unifi-protect)

# Homebridge UniFi Protect

[![Downloads](https://img.shields.io/npm/dt/homebridge-unifi-protect?color=%230559C9&logo=icloud&logoColor=%23FFFFFF&style=for-the-badge)](https://www.npmjs.com/package/homebridge-unifi-protect)
[![Version](https://img.shields.io/npm/v/homebridge-unifi-protect?color=%230559C9&label=Latest%20Version&logo=ubiquiti&logoColor=%23FFFFFF&style=for-the-badge)](https://www.npmjs.com/package/homebridge-unifi-protect)
[![UniFi Protect@Homebridge Discord](https://img.shields.io/discord/432663330281226270?color=0559C9&label=Discord&logo=discord&logoColor=%23FFFFFF&style=for-the-badge)](https://discord.gg/QXqfHEW)
[![verified-by-homebridge](https://img.shields.io/badge/homebridge-verified-blueviolet?color=%2357277C&style=for-the-badge&logoColor=%23FFFFFF&logo=data:image/svg%2bxml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI5OTIuMDkiIGhlaWdodD0iMTAwMCIgdmlld0JveD0iMCAwIDk5Mi4wOSAxMDAwIj48ZGVmcz48c3R5bGU+LmF7ZmlsbDojZmZmO308L3N0eWxlPjwvZGVmcz48cGF0aCBjbGFzcz0iYSIgZD0iTTk1MC4xOSw1MDguMDZhNDEuOTEsNDEuOTEsMCwwLDEtNDItNDEuOWMwLS40OC4zLS45MS4zLTEuNDJMODI1Ljg2LDM4Mi4xYTc0LjI2LDc0LjI2LDAsMCwxLTIxLjUxLTUyVjEzOC4yMmExNi4xMywxNi4xMywwLDAsMC0xNi4wOS0xNkg3MzYuNGExNi4xLDE2LjEsMCwwLDAtMTYsMTZWMjc0Ljg4bC0yMjAuMDktMjEzYTE2LjA4LDE2LjA4LDAsMCwwLTIyLjY0LjE5TDYyLjM0LDQ3Ny4zNGExNiwxNiwwLDAsMCwwLDIyLjY1bDM5LjM5LDM5LjQ5YTE2LjE4LDE2LjE4LDAsMCwwLDIyLjY0LDBMNDQzLjUyLDIyNS4wOWE3My43Miw3My43MiwwLDAsMSwxMDMuNjIuNDVMODYwLDUzOC4zOGE3My42MSw3My42MSwwLDAsMSwwLDEwNGwtMzguNDYsMzguNDdhNzMuODcsNzMuODcsMCwwLDEtMTAzLjIyLjc1TDQ5OC43OSw0NjguMjhhMTYuMDUsMTYuMDUsMCwwLDAtMjIuNjUuMjJMMjY1LjMsNjgwLjI5YTE2LjEzLDE2LjEzLDAsMCwwLDAsMjIuNjZsMzguOTIsMzlhMTYuMDYsMTYuMDYsMCwwLDAsMjIuNjUsMGwxMTQtMTEyLjM5YTczLjc1LDczLjc1LDAsMCwxLDEwMy4yMiwwbDExMywxMTEsLjQyLjQyYTczLjU0LDczLjU0LDAsMCwxLDAsMTA0TDU0NS4wOCw5NTcuMzV2LjcxYTQxLjk1LDQxLjk1LDAsMSwxLTQyLTQxLjk0Yy41MywwLC45NS4zLDEuNDQuM0w2MTYuNDMsODA0LjIzYTE2LjA5LDE2LjA5LDAsMCwwLDQuNzEtMTEuMzMsMTUuODUsMTUuODUsMCwwLDAtNC43OS0xMS4zMmwtMTEzLTExMWExNi4xMywxNi4xMywwLDAsMC0yMi42NiwwTDM2Ny4xNiw3ODIuNzlhNzMuNjYsNzMuNjYsMCwwLDEtMTAzLjY3LS4yN2wtMzktMzlhNzMuNjYsNzMuNjYsMCwwLDEsMC0xMDMuODZMNDM1LjE3LDQyNy44OGE3My43OSw3My43OSwwLDAsMSwxMDMuMzctLjlMNzU4LjEsNjM5Ljc1YTE2LjEzLDE2LjEzLDAsMCwwLDIyLjY2LDBsMzguNDMtMzguNDNhMTYuMTMsMTYuMTMsMCwwLDAsMC0yMi42Nkw1MDYuNSwyNjUuOTNhMTYuMTEsMTYuMTEsMCwwLDAtMjIuNjYsMEwxNjQuNjksNTgwLjQ0QTczLjY5LDczLjY5LDAsMCwxLDYxLjEsNTgwTDIxLjU3LDU0MC42OWwtLjExLS4xMmE3My40Niw3My40NiwwLDAsMSwuMTEtMTAzLjg4TDQzNi44NSwyMS40MUE3My44OSw3My44OSwwLDAsMSw1NDAsMjAuNTZMNjYyLjYzLDEzOS4zMnYtMS4xYTczLjYxLDczLjYxLDAsMCwxLDczLjU0LTczLjVINzg4YTczLjYxLDczLjYxLDAsMCwxLDczLjUsNzMuNVYzMjkuODFhMTYsMTYsMCwwLDAsNC43MSwxMS4zMmw4My4wNyw4My4wNWguNzlhNDEuOTQsNDEuOTQsMCwwLDEsLjA4LDgzLjg4WiIvPjwvc3ZnPg==)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)
[![Dependencies](https://img.shields.io/david/hjdhjd/homebridge-unifi-protect?color=%230559C9&label=%20&logo=dependabot&style=for-the-badge)](https://david-dm.org/hjdhjd/homebridge-unifi-protect)
[![Build Status](https://img.shields.io/travis/hjdhjd/homebridge-unifi-protect?color=%230559C9&label=%20&logo=travis-ci&logoColor=%23FFFFFF&style=for-the-badge)](https://travis-ci.org/hjdhjd/homebridge-unifi-protect)

## HomeKit support for the UniFi Protect ecosystem using [Homebridge](https://homebridge.io).
</DIV>
</SPAN>

`homebridge-unifi-protect` is a [Homebridge](https://homebridge.io) plugin that provides HomeKit support to the [UniFi Protect](https://unifi-network.ui.com/video-security) device ecosystem. [UniFi Protect](https://unifi-network.ui.com/video-security) is [Ubiquiti's](https://www.ui.com) next-generation video security platform, with rich camera, doorbell, and NVR controller hardware options for you to choose from, as well as an app which you can use to view, configure and manage your video camera and doorbells.

## <A NAME="why"></A>Why use this plugin for UniFi Protect support in HomeKit?

This plugin attempts to bridge a gap in the UniFi Protect ecosystem by providing native HomeKit support on par with what you would expect from a first-party of native HomeKit solution. My north star is to create a plugin that *just works* with minimal required configuration by you to get up and running. The goal is to provide as close to a streamlined experience as you would expect from a first-party or native HomeKit solution. For the adventurous, there are more granular options available to enable you to further tailor your experience.

What does *just works* mean in practice? It means that this plugin will discover all your supported UniFi Protect devices and make them available in HomeKit. It supports all known UniFi Protect controller configurations (UniFi CloudKey Gen2+, UniFi Dream Machine Pro, and UniFi Protect NVR).

For the more technically inclined - this plugin has continued to pioneer the HomeKit user experience for UniFi Protect by being the ***first*** Homebridge plugin to successfully reverse engineer the UniFi Protect realtime events API that was introduced with UniFi OS. This means that rather than poll the Protect controller every few seconds to catch events, we're able to capture motion and doorbell ring events in realtime, providing an extremely responsive HomeKit experience, and reducing the performance impact to Protect controllers.

### Features
- ***Easy* configuration - all you need is your UniFi Protect controller IP address, username, and password to get started.** The defaults work for the vast majority of users. When you want more, there are [advanced options](https://github.com/hjdhjd/homebridge-unifi-protect/blob/master/docs/AdvancedOptions.md) you can play with, if you choose.

- **Blazing fast video streaming.** Video streaming from HomeKit will start within in 1-2 seconds for G3-series cameras and 3-4 seconds for G4-series cameras, in most cases. I've spent the time to optimize the video streaming experience to ensure it feels very responsive, and *just works*.

- **[Full UniFi Protect G4 Doorbell support.](https://github.com/hjdhjd/homebridge-unifi-protect/blob/master/docs/Doorbell.md).** This plugin provides complete support for [UniFi Protect G4 Doorbells](https://store.ui.com/collections/unifi-protect/products/uvc-g4-doorbell). We support all the features of the doorbell including - doorbell rings, two-way audio, and the use of the onboard LCD screen for messages. Two-way audio has caveats you should be aware of.

- **[Two-way audio support](https://github.com/hjdhjd/homebridge-unifi-protect/blob/master/docs/Doorbell.md#doorbell-twoway) for all UniFi Protect cameras that support it**. Some Protect devices that support two-way audio capabilities include [UniFi Protect G4 Doorbells](https://store.ui.com/collections/unifi-protect/products/uvc-g4-doorbell), the [UniFi Protect G3 Micro](https://store.ui.com/collections/unifi-protect/products/unifi-video-g3-micro), and more. If the Protect device supports two-way audio, that functionality is available to you in HomeKit.

- **Support for multiple controllers.** This plugin can support multiple UniFi Protect controllers. If you have more than one controller, it's easy to add them to this plugin, and integrate them seamlessly into HomeKit.

- **Automatic *continuous* detection and configuration of all UniFi Protect devices.** By default - all of your supported UniFi Protect devices are made available in HomeKit without needing any further configuration on your part. Additionally, if you add or remove cameras or other devices to your UniFi Protect controller, this plugin will autodetect those configuration changes and add or remove those devices in HomeKit, seamlessly, *in realtime*.

- **The ability to [selectively hide and show](https://github.com/hjdhjd/homebridge-unifi-protect/blob/master/docs/FeatureOptions.md) specific Protect devices.** For those who only want to show particular devices in HomeKit, or particular controllers, a flexible and intuitive way to configure device availability at a granular level is available.

- **Motion detection support using the native realtime notification API on UniFi OS.** On UniFI OS-based controllers, we use the **native realtime update notification API**, *without having to continuously poll the UniFI Protect controller.* This does a couple of things - first, it provides ***true*** realtime HomeKit rich notifications when motion is detected, including image snapshots. Second, this approach eliminates the requirement to continuously poll every few seconds that most non-native solutions to motion detection on UniFi Protect have used until now and reduces the load on UniFi Protect controllers substantially.

- **Motion detection support for UniFi CloudKey Gen2+ controllers.** For those using UCK Gen2+ controllers, support for motion detection with rich notifications is also available, although only using poll-based notifications. Unfortunately, Ubiquiti hasn't yet implemented a realtime notification API for UCK Gen2+ controllers, but should Ubiquiti implement it in the future, this plugin will provide support for it.

- **Motion sensor control from within HomeKit.** By default, all detected cameras have two additional services attached to them - a motion sensor service, and a motion switch service. The motion switch allows you to selectively activate and deactivate motion detection of your cameras. This is especially useful in automation scenarios where you wish to activate or deactivate motion detection selectively when you leave your home or arrive home, for example.

- **Create scenes or presets for groups of cameras.** If you choose to [create specific liveviews](https://github.com/hjdhjd/homebridge-unifi-protect/blob/master/docs/Liveviews.md), a security system accessory will appear in HomeKit, enabling you to have motion-detection scenes or presets a tap away. For even more customization, you can create liveview-based switches that will allow you to enable or disable motion detection on groups of cameras. They're easy and intuitive to create and can amplify your user experience in HomeKit.

- **MQTT support.** [MQTT](https://mqtt.org) support is available for those that want to [make UniFi Protect accessible to an MQTT broker](https://github.com/hjdhjd/homebridge-unifi-protect/blob/master/docs/MQTT.md).

### What's not in this plugin right now

Acoustic Echo Cancellation (AEC) support for two-way audio in UniFi Protect. We're most of the way there with two-way audio support, and hopefully AEC support can be reverse-engineered in the future.

I hope to continue to work on this one to get AEC working for two-way audio. [You can also read more on about two-way audio support here](https://github.com/hjdhjd/homebridge-unifi-protect/blob/master/docs/Doorbell.md#doorbell-twoway).

## Documentation
* Getting going
  * [Installation](#installation): installing this plugin, including system requirements.
  * [Plugin Configuration](#plugin-configuration): how to quickly get up and running.
  * [Best Practices](https://github.com/hjdhjd/homebridge-unifi-protect/blob/master/docs/BestPractices.md): best practices for getting the most of your HomeKit setup and UniFi Protect.
  * [Troubleshooting](https://github.com/hjdhjd/homebridge-unifi-protect/blob/master/docs/Troubleshooting.md): run into login problems or streaming problems? Give this a read.
* Advanced Topics
  * [Autoconfiguration](https://github.com/hjdhjd/homebridge-unifi-protect/blob/master/docs/Autoconfiguration.md): what it is, design choices that I've made, and why.
  * [Feature Options](https://github.com/hjdhjd/homebridge-unifi-protect/blob/master/docs/FeatureOptions.md): granular options to allow you to set the camera quality individually, show or hide specific cameras, controllers, and more.
  * [Audio Options](https://github.com/hjdhjd/homebridge-unifi-protect/blob/master/docs/AudioOptions.md): options to further tailor how audio is handled from Protect, such as background noise reduction.
  * [Doorbells](https://github.com/hjdhjd/homebridge-unifi-protect/blob/master/docs/Doorbell.md): how UniFi Protect doorbell support works in this plugin, and how to use all the available features including doorbell messages.
  * [Liveview Scenes](https://github.com/hjdhjd/homebridge-unifi-protect/blob/master/docs/Liveviews.md): use the UniFi Protect liveviews feature (available in the UniFi Protect controller webUI) to create motion-detection scenes.
  * [MQTT](https://github.com/hjdhjd/homebridge-unifi-protect/blob/master/docs/MQTT.md): how to configure MQTT support.
  * [Advanced Configuration](https://github.com/hjdhjd/homebridge-unifi-protect/blob/master/docs/AdvancedOptions.md): complete list of configuration options available in this plugin.
  * [Realtime API Documentation](https://github.com/hjdhjd/homebridge-unifi-protect/blob/master/docs/ProtectAPI.md): documentation of how the Ubiquiti realtime updates API works and how to decode the binary protocol.
  * [Changelog](https://github.com/hjdhjd/homebridge-unifi-protect/blob/master/docs/Changelog.md): changes and release history of this plugin, starting with v3.0.

## Installation
If you are new to Homebridge, please first read the [Homebridge](https://homebridge.io) [documentation](https://github.com/homebridge/homebridge/wiki) and installation instructions before proceeding.

If you have installed the [Homebridge Config UI](https://github.com/oznu/homebridge-config-ui-x), you can intall this plugin by going to the `Plugins` tab and searching for `homebridge-unifi-protect` and installing it.

If you prefer to install `homebridge-unifi-protect` from the command line, you can do so by executing:

```sh
sudo npm install --unsafe-perm -g homebridge-unifi-protect
```

You will need a working **ffmpeg** installation for `homebridge-unifi-protect` to work correctly. To make installation more convenient, this plugin uses [ffmpeg-for-homebridge](https://www.npmjs.com/package/ffmpeg-for-homebridge) which provides prebuilt versions of ffmpeg for some of the more popular platforms. [Click here](https://github.com/homebridge/ffmpeg-for-homebridge#supported-platforms) for a list of platforms supported by `ffmpeg-for-homebridge`. If you don't find your platform listed, you'll need to install a working version of ffmpeg for yourself, if you want video streaming to work. **Setting up and configuring ffmpeg is beyond the scope of this documentation.**

### Audio
Audio on cameras is tricky in the HomeKit world to begin with, and when you throw in some of the specifics of how UniFi Protect works, it gets even more interesting. Some things to keep in mind if you want to use audio with UniFi Protect:

* This plugin provides audio on UniFi cameras and doorbells. This includes two-way audio on the [G4 Doorbell](https://store.ui.com/collections/unifi-protect/products/uvc-g4-doorbell), [G3 Micro](https://store.ui.com/collections/unifi-protect/products/unifi-video-g3-micro), and other UniFi Protect devices that support two-way audio.

* There is one notable caveat, currently, with two-way audio: the lack of acoustic echo cancellation, or AEC. [Read more on about two-way audio here](https://github.com/hjdhjd/homebridge-unifi-protect/blob/master/docs/Doorbell.md#doorbell-twoway).

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
- **Beginning with v3.6.0, this plugin requires Homebridge v1.1.3 on greater to work. For some, this may be a breaking change if you are running on older versions of Homebridge.**

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

