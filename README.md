<SPAN ALIGN="CENTER">

[![homebridge-unifi-protect2: Native HomeKit support for UniFi Protect](https://raw.githubusercontent.com/hjdhjd/homebridge-unifi-protect2/master/homebridge-protect.svg)](https://github.com/hjdhjd/homebridge-unifi-protect2)

# Homebridge UniFi Protect<SUP STYLE="font-size: smaller; color:#5EB5E6;">2</SUP>

[![Downloads](https://badgen.net/npm/dt/homebridge-unifi-protect2)](https://www.npmjs.com/package/homebridge-unifi-protect2)
[![Version](https://badgen.net/npm/v/homebridge-unifi-protect2)](https://www.npmjs.com/package/homebridge-unifi-protect2)
[![verified-by-homebridge](https://badgen.net/badge/homebridge/verified/purple)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)

## HomeKit support the UniFi Protect ecosystem using [Homebridge](https://homebridge.io).
</SPAN>

`homebridge-unifi-protect2` is a [Homebridge](https://homebridge.io) plugin that provides HomeKit support to the [UniFi Protect](https://unifi-network.ui.com/video-security) device ecosystem. [UniFi Protect](https://unifi-network.ui.com/video-security) is [Ubiquiti's](https://www.ui.com) next-generation video security platform, with a rich camera, doorbell, and NVR set of options for you to choose from, as well as an app which you can use to view, configure and manage your video camera and doorbells.

## Why use this plugin for UniFi Protect support in HomeKit?

This plugin attempts to bridge a gap in the UniFi Protect ecosystem by providing native HomeKit support on par with what you would expect from a first-party of native HomeKit solution. Our north star is to create a plugin that *just works* with minimal required configuration by you, the end user, to get up and running. The goal is to provide as close to a streamlined experience as you would expect from a first-party or native HomeKit solution. For the adventurous, there are more granular options available to enable you to further tailor your experience.

What does *just works* mean in practice? It means that this plugin will discover all your supported UniFi Protect devices and make them available in HomeKit. It supports all known UniFi Protect controller configurations (UniFi CloudKey Gen2+, UniFi Dream Machine Pro, and UniFi Protect NVR).

### Features
- ***Easy* configuration - all you need is your UniFi Protect username and password to get started.** The defaults work for the vast majority of users. When you want more, there are [advanced options](#advanced-config) you can play with, if you choose.

- **Support for multiple controllers.** This plugin can support multiple UniFi Protect controllers. If you have more than one controller, it's easy to add them to this plugin, and integrate them seamlessly into HomeKit.

- **Automatic *continuous* detection and configuration of all UniFi Protect devices.** By default - all of your supported UniFi Protect devices are made available in HomeKit without needing any further configuration on your part. Additionally, if you add or remove cameras or other devices to your UniFi Protect controller, this plugin will autodetect those configuration changes and add or remove those devices in HomeKit, seamlessly.

- **The ability to [selectively hide and show](#feature-options) specific Protect devices.** For those who only want to show particular devices in HomeKit, or particular controllers, a flexible and intuitive way to configure device availability at a granular level is available.

- **Motion detection support using a native realtime notification API (UniFi OS).** On UniFI OS-based controllers, we use a native realtime notification API, *without having to continuously poll the UniFI Protect controller.* This does a couple of things - first, it provides ***true*** realtime HomeKit rich notifications when motion is detected, including image snapshots. Second, this approach eliminates the requirement to continuously poll every few seconds that most non-native solutions to motion detection on UniFi Protect have used until now, and reduces the load on UniFi Protect controllers substantially.

- **Motion detection support for UniFi CloudKey Gen2+ controllers.** For those using UCK Gen2+ controllers, support for motion detection with rich notifications is also available, although only using poll-based notifications. Unfortunately, Ubiquiti hasn't yet implemented a realtime notification API for UCK Gen2+ controllers, but should Ubiquiti implement it in the future, this plugin will provide support for it.

- **Motion sensor control from within HomeKit.** By default, all detected cameras have two additional services attached to them - a motion sensor service, and a motion switch service. The motion switch allows you to selectively activate and deactivate motion detection of your cameras. This is especialy useful in automation scenarios where you wish to activate or deactivate motion detection selectively when you leave your home or arrive home, for example.

### What's not in this plugin right now

Full support for UniFi Protect doorbells such as the [UniFi Protect G4 Doorbell](https://store.ui.com/collections/unifi-protect/products/uvc-g4-doorbell). I would love to add more complete support for the doorbell, but until I can get my hands on one, the best I can do at the moment is provide support for the camera itself, but not the full doorbell functionality. I hope to resolve this in the near future.

## Installation
If you are new to Homebridge, please first read the [Homebridge](https://homebridge.io) [documentation](https://github.com/homebridge/homebridge/wiki) and installation instructions before proceeding.

If you have installed the [Homebridge Config UI](https://github.com/oznu/homebridge-config-ui-x), you can intall this plugin by going to the `Plugins` tab and searching for `homebridge-unifi-protect2` and installing it.

If you prefer to install `homebridge-unifi-protect2` from the command line, you can do so by executing:

```sh
sudo npm install -g homebridge-unifi-protect2
```

You will need a working **ffmpeg** installation for this plugin to work. Configuring ffmpeg is beyond the scope of this manual. Please refer to the
excellent documentation for [homebridge-camera-ffmpeg](https://github.com/Sunoo/homebridge-camera-ffmpeg).

### Audio support notes

Audio on cameras is tricky in the HomeKit world to begin with, and when you throw in some of the specifics of how UniFi Protect works, it gets even more interesting. Some things to keep in mind if you want to use audio with UniFi Protect:

* This plugin supports audio coming from UniFi cameras. It does **not** support two-way audio at this time.

* **Audio support will not work unless you have a version of ffmpeg that supports fdk-aac.** Unfortunately, most default installations of ffmpeg are not compiled with support for fdk-aac. You'll need to compile or acquire a version of ffmpeg that does. Doing so is beyond the scope of this plugin. There are plenty of guides to this - Google is your friend. This plugin uses [ffmpeg-for-homebridge](https://www.npmjs.com/package/ffmpeg-for-homebridge) which easies pain somewhat by providing prebuilt static binaries of ffmpeg for certain platforms, and save you the trouble of having to compile a version of ffmpeg yourself.

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

### Changelog
Changelog starting with v3.0 is available [here](https://github.com/hjdhjd/homebridge-unifi-protect2/blob/master/CHANGELOG.md).

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

### Autoconfiguration
This plugin will attempt to autoconfigure all devices it detects attached to a UniFi Protect controller in order to create a more seamless end user experience. In order to do so, the UniFi Protect controller user that you configure this plugin to use will require the Administrator role enabled. Enabling the administrator role is *optional* and only required if you want this plugin to configure your UniFi Protect controller to make all RTSP streams available. You can also choose to manually enable all RTSP streams on all cameras yourself, if you prefer.

Why is enabling all RTSP streams a good idea? In short - it's free and gives you optionality later, should you choose to use it. For this plugin to work correctly, you will need to enable at least one RTSP stream on each camera you want to see in HomeKit. There's really no good reason not to enable all the RTSP streams, which just gives you more flexibility in the stream quality you have available to use, should you choose to do so.

Which leads to the final point on autoconfiguration - sane defaults. As stated earlier on this page, our north star is to make this plugin as easy and seamless to use with HomeKit as possible and provide an optimized user experience and that includes good video streaming performance. By default, this plugin prioritizes configuring each camera's streaming quality by understanding HomeKit's limitations and selecting a stream that provides a reasonable balance between quality and speed of stream startup. For example, we default the UVC G4 Pro camera to a medium quality stream (1280x720 in this case) rather than using the high quality stream (3840x2160). The reason for this is that HomeKit only supports streams of up to 1920x1080 (aka 1080p) as of iOS 13, and in my testing, having ffmpeg try to handle reencoding a stream with that much data to a lower quality results in a jittery and unsatisfying camera streaming experience in HomeKit. The table below lists the current autoconfiguration defaults:

| Camera Model           | Quality Defaults
|------------------------|------------------
| UVC G4 Pro             | Medium, Low, High
| UVC G4 Bullet          | Medium, Low, High
| All others             | High, Medium, Low

Of course, you can override any of the defaults to your liking (see [feature options](#feature-options) for more detail).

### Feature Options
Feature options allow you to enable or disable certain features in this plugin. These feature options provide unique flexibility by also allowing you to set a scope for each option that allows you more granular control in how this plugin makes features and capabilities available in HomeKit.

The priority given to these options works in the following order, from highest to lowest priority where settings that are higher in priority can override lower ones:

* Device options that are enabled or disabled.
* Controller options that are enabled or disabled.
* Global options that are enabled or disabled.

To specify the scope of an option, you append the option with `.MAC`, where `MAC` is the MAC address of either a UniFi Protect controller or a camera. If you don't append a MAC address to an option, it will be applied globally, unless a more specifically scoped option is specified elsewhere. The plugin will log all devices it encounters and knows about, including MAC addresses. You can use that to guide what features you would like to enable ot disable.

The `options` setting is an array of strings used to customize feature options. The available feature options are:

* <CODE>Enable.<I>MAC</I></CODE> - show the camera or controller identified by MAC address `MAC` from HomeKit.
* <CODE>Disable.<I>MAC</I></CODE> - hide the camera or controller identified by MAC address `MAC` from HomeKit.

* <CODE>Enable.Stream.<I>Quality</I></CODE> - show the stream of quality *Quality* from HomeKit. Valid quality settings are `Low`, `Medium`, `High`.
* <CODE>Disable.Stream.<I>Quality</I></CODE> - hide the stream of quality *Quality* from HomeKit. Valid quality settings are `Low`, `Medium`, `High`.

* <CODE>Enable.StreamOnly.<I>Quality</I></CODE> - only allow the stream of quality *Quality* to be used in HomeKit. Valid quality settings are `Low`, `Medium`, `High`.

* <CODE>Enable.MotionSensor</CODE> - add a motion sensor accessory to HomeKit to enable motion detection.
* <CODE>Disable.MotionSensor</CODE> - remove the motion sensor and motion sensor switch accessories to disable motion detection capabilities.

* <CODE>Enable.MotionSwitch</CODE> - add a switch accessory to activate or deactivate motion detection in HomeKit.
* <CODE>Disable.MotionSwitch</CODE> - remove the switch accessory used to enable or disable motion detection. Note: this will not disable motion detection, just remove the ability to selectively activate and deactivate it in HomeKit.

Before using these features, you should understand how feature options propogate to controllers and the devices attached to them. If you choose to disable a controller from being available to HomeKit, you will also disable all the cameras attached to that controller. If you've disabled a controller, and all it's devices with it, you can selectively enable a single device associated with that controller by explicitly setting an `Enable.` feature option. This provides you a lot of richness in how you enable or disable devices for HomeKit use.

An example `options` setting might look like this:

```js
"platforms": [
  {
    "platform": "UniFi Protect",

    "options": [
      "Disable.Stream.High",
      "Enable.Stream.High.BBBBBBBBBBBB"
    ]

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
In this example:

| Device MAC Address    | Description
|-----------------------|------------------
| AAAAAAAAAAAA          | A UniFi Protect controller with 4 cameras attached to it, including a UVC G3 Flex with a MAC address of BBBBBBBBBBBB.
| BBBBBBBBBBBB          | A UVC G3 Flex that is managed by a UniFi Protect controller with a MAC address of AAAAAAAAAAAA.

* The first line `Disable.Stream.High` disables the high quality stream on all UniFi Protect devices that appear in HomeKit.
* The second line, overrides the first and enables the high quality stream on the G3 Flex because specifying device options always overrides global settings.

### <A NAME="advanced-config"></A>Advanced Configuration (Optional)
This step is not required. The defaults should work well for almost everyone, but for those that prefer to tweak additional settings, this is the complete list of settings available.

```js
"platforms": [
  {
    "platform": "UniFi Protect",
    "videoProcessor": "/usr/local/bin/ffmpeg",
    "ffmpegOptions": "-preset ultrafast -tune zerolatency",
    "motionDuration": 10,
    "debug": false,

    "options": [
      "Disable.Stream.High"
    ],

    "controllers": [
      {
        "name": "My UniFi Protect Controller",
        "address": "1.2.3.4",
        "username": "some-homebridge-user (or create a new one just for homebridge)",
        "password": "some-password",
        "refreshInterval": 5
      }
    ],
  }
]
```

| Fields                 | Description                                             | Default                                                                               | Required |
|------------------------|---------------------------------------------------------|---------------------------------------------------------------------------------------|----------|
| platform               | Must always be `UniFi Protect`.                         | UniFi Protect                                                                         | Yes      |
| address                | Host or IP address of your UniFi Protect controller     |                                                                                       | Yes      |
| username               | Your UniFi Protect username.                            |                                                                                       | Yes      |
| password               | Your UniFi Protect password.                            |                                                                                       | Yes      |
| videoProcessor         | Specify path of ffmpeg or avconv.                       | "ffmpeg"                                                                              | No       |
| ffmpegOptions          | Additional parameters to pass ffmpeg to render video.   | "-probesize 32 -analyzeduration 0 -fflags nobuffer -refs 1 -x264-params intra-refresh=1:bframes=0"      | No       |
| motionDuration         | Duration of motion events. Setting this too low will potentially cause a lot of notification spam. | 10                                         | No       |
| refreshInterval        | Interval to check UniFi Protect for new or removed devices. On UCKGen2+ controllers **only**, also sets the polling interval for motion events. | 10 seconds for UniFi OS, 5 seconds for UCK Gen2+ | No       |
| options                | Configure plugin [feature options](#feature-options).   | []      | No       |
| name                   | Controller name to use for homebridge logging purposes. | UniFi Protect controller name                                                         | No       |
| debug                  | Enable additional debug logging.                        | no                                                                                    | No       |

