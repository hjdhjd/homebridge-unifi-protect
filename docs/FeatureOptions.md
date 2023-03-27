<SPAN ALIGN="CENTER" STYLE="text-align:center">
<DIV ALIGN="CENTER" STYLE="text-align:center">

[![homebridge-unifi-protect: Native HomeKit support for UniFi Protect](https://raw.githubusercontent.com/hjdhjd/homebridge-unifi-protect/main/homebridge-protect.svg)](https://github.com/hjdhjd/homebridge-unifi-protect)

# Homebridge UniFi Protect

[![Downloads](https://img.shields.io/npm/dt/homebridge-unifi-protect?color=%230559C9&logo=icloud&logoColor=%23FFFFFF&style=for-the-badge)](https://www.npmjs.com/package/homebridge-unifi-protect)
[![Version](https://img.shields.io/npm/v/homebridge-unifi-protect?color=%230559C9&label=Homebridge%20UniFi%20Protect&logo=ubiquiti&logoColor=%23FFFFFF&style=for-the-badge)](https://www.npmjs.com/package/homebridge-unifi-protect)
[![UniFi Protect@Homebridge Discord](https://img.shields.io/discord/432663330281226270?color=0559C9&label=Discord&logo=discord&logoColor=%23FFFFFF&style=for-the-badge)](https://discord.gg/QXqfHEW)
[![verified-by-homebridge](https://img.shields.io/badge/homebridge-verified-blueviolet?color=%23491F59&style=for-the-badge&logoColor=%23FFFFFF&logo=homebridge)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)

## HomeKit support for the UniFi Protect ecosystem using [Homebridge](https://homebridge.io).
</DIV>
</SPAN>

`homebridge-unifi-protect` is a [Homebridge](https://homebridge.io) plugin that provides HomeKit support to the [UniFi Protect](https://unifi-network.ui.com/video-security) device ecosystem. [UniFi Protect](https://unifi-network.ui.com/video-security) is [Ubiquiti's](https://www.ui.com) video security platform, with rich camera, doorbell, and NVR controller hardware options for you to choose from, as well as an app which you can use to view, configure and manage your video camera and doorbells.

### Feature Options

Feature options allow you to enable or disable certain features in this plugin. These feature options provide unique flexibility by also allowing you to set a scope for each option that allows you more granular control in how this plugin makes features and capabilities available in HomeKit.

The priority given to these options works in the following order, from highest to lowest priority where settings that are higher in priority will override the ones below:

  * Device options that are enabled or disabled.
  * Controller options that are enabled or disabled.
  * Global options that are enabled or disabled.

All feature options can be set at any scope level, or at multiple scope levels. If an option isn't applicable to a particular category of device, it is ignored. For example, if you have two doorbells in your environment, and want to enable the same feature options on both, you can enable the doorbell-related feature options globally rather than specifying them for each individual doorbell. If you want to override a global feature option you've set, you can override the global feature option for the individual doorbell in this example.

**Note: it's strongly recommended that you use the Homebridge webUI](https://github.com/oznu/homebridge-config-ui-x) to configure this plugin - it's easier to use for most people, and will ensure you always have a valid configuration.**

#### Specifying Scope
There are two types of scope specifiers that you can use with feature options - MAC addresses and streaming client IP addresses.

Scoping rules:

  * If you don't use a scoping specifier, feature options will be applied globally for all devices and streaming clients.
  * To use a device or controller-specific feature option, append the option with `.MAC`, where `MAC` is the MAC address of either a UniFi Protect controller or a camera.

`homebridge-unifi-protect` will log all devices it discovers on startup, including MAC addresses, which you can use to tailor the feature options you'd like to enable or disable on a per-device basis. Additionally, when a client requests a video stream, the IP address of that client will be logged, which you can also use to further tailor the streaming experience.

### Getting Started
Before using these features, you should understand how feature options propagate to controllers and the devices attached to them. If you choose to disable a controller from being available to HomeKit, you will also disable all the cameras attached to that controller. If you've disabled a controller, you can selectively enable a single device associated with that controller by explicitly using the `Enable.` Feature Option with that device's MAC address. This provides you a lot of richness in how you enable or disable devices for HomeKit use.

The `options` setting is an array of strings used to customize Feature Options in your `config.json`. I would encourage most users, however, to use the [Homebridge webUI](https://github.com/oznu/homebridge-config-ui-x), to configure Feature Options as well as other options in this plugin. It contains additional validation checking of parameters to ensure the configuration is always valid.

#### Example Configuration
An example `options` setting might look like this in your config.json:

```js
"platforms": [
  {
    "platform": "UniFi Protect",

    "options": [
      "Disable.Video.Transcode",
      "Enable.Video.Transcode.AAAAAAAAAAAA"
    ],

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
| AAAAAAAAAAAA          | A UVC G3 Flex that is managed by a UniFi Protect controller.

* The first line `Disable.Video.Transcode` disables transcoding on all UniFi Protect devices that appear in HomeKit.
* The second line, overrides the first and enables transcoding on the G3 Flex. Specifying device-specific options always overrides global settings.

### <A NAME="reference"></A>Feature Options Reference
Feature options provide a rich mechanism for tailoring your `homebridge-unifi-protect` experience. The reference below is divided into functional category groups:

**Note: it's strongly recommended that you use the Homebridge webUI](https://github.com/oznu/homebridge-config-ui-x) to configure this plugin - it's easier to use for most people, and will ensure you always have a valid configuration.**

 * [Audio](#audio): Audio feature options.
 * [Device](#device): Device feature options.
 * [Doorbell](#doorbell): Doorbell feature options.
 * [Log](#log): Logging feature options.
 * [Motion](#motion): Motion detection feature options.
 * [Nvr](#nvr): NVR feature options.
 * [SecuritySystem](#securitysystem): Security system feature options.
 * [Video](#video): Video feature options.
 * [Video.HKSV](#video.hksv): HomeKit Secure Video feature options.

#### <A NAME="audio"></A>Audio feature options.
| Option                                 | Description
|----------------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------
| `Audio`                                | Audio support. (default: true).
| `Audio.Filter.Noise`                   | Audio filter for ambient noise suppression. (default: false).
| `Audio.TwoWay`                         | Two-way audio support on supported cameras. (default: true).

#### <A NAME="device"></A>Device feature options.
| Option                                 | Description
|----------------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------
| `Device`                               | Make this device available in HomeKit. (default: true).
| `Device.StatusLed`                     | Enable the status LED for this device in HomeKit. (default: false).

#### <A NAME="doorbell"></A>Doorbell feature options.
| Option                                 | Description
|----------------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------
| `Doorbell.Messages`                    | Enable the doorbell messages feature. (default: true).
| `Doorbell.Messages.FromDoorbell`       | Use messages saved to the Protect NVR as message switches. (default: true).
| `Doorbell.Trigger`                     | Add a switch accessory to trigger doorbell ring events on a Protect camera or doorbell. (default: false).

#### <A NAME="log"></A>Logging feature options.
| Option                                 | Description
|----------------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------
| `Log.HKSV`                             | Log HomeKit Secure Video recording events in Homebridge. (default: true).
| `Log.Doorbell`                         | Log doorbell ring events in Homebridge. (default: true).
| `Log.Motion`                           | Log motion events in Homebridge. (default: false).

#### <A NAME="motion"></A>Motion detection feature options.
| Option                                 | Description
|----------------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------
| `Motion.Sensor`                        | Enable this device's motion sensor in HomeKit. (default: true).
| `Motion.SmartDetect`                   | UniFi Protect smart motion detection when on a supported device. (default: false).
| `Motion.SmartDetect.ObjectSensors`     | Add contact sensor accessories for each smart motion object type that UniFi Protect supports. (default: false).
| `Motion.Switch`                        | Add a switch accessory to activate or deactivate motion detection in HomeKit. (default: false).
| `Motion.Trigger`                       | Add a switch accessory to manually trigger a motion detection event in HomeKit. (default: false).

#### <A NAME="nvr"></A>NVR feature options.
| Option                                 | Description
|----------------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------
| `Nvr.Recording.Switch`                 | Add switch accessories to control the native recording capabilities of the UniFi Protect NVR. (default: false).
| `Nvr.SystemInfo`                       | Add sensor accessories to display NVR system information (currently only the temperature). (default: false).

#### <A NAME="securitysystem"></A>Security system feature options.
| Option                                 | Description
|----------------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------
| `SecuritySystem.Alarm`                 | Add a switch accessory to trigger the security system accessory, when using the liveview feature option. (default: false).

#### <A NAME="video"></A>Video feature options.
| Option                                 | Description
|----------------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------
| `Video.DynamicBitrate`                 | Dynamically adjust the bitrate on the UniFi Protect controller to accomodate HomeKit requests. (default: false).
| `Video.DynamicBitrate.Switch`          | Add a switch accessory to enable or disable dynamic bitrate support on the Protect controller. (default: false).
| `Video.Stream.Only.Low`                | For viewing livestreams, force the use of the low quality video stream from the Protect controller. (default: false).
| `Video.Stream.Only.Medium`             | For viewing livestreams, force the use of the medium quality video stream from the Protect controller. (default: false).
| `Video.Stream.Only.High`               | For viewing livestreams, force the use of the high quality video stream from the Protect controller. (default: false).
| `Video.Transcode`                      | Transcode live video streams when viewing in the Home app instead of remuxing. (default: false).
| `Video.Transcode.Hardware`             | Use hardware-accelerated transcoding, when available (macOS only). (default: false).
| `Video.Transcode.HighLatency`          | When streaming to high-latency clients (e.g. cellular connections), transcode live video streams instead of remuxing them. (default: true).

#### <A NAME="video.hksv"></A>HomeKit Secure Video feature options.
| Option                                 | Description
|----------------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------
| `Video.HKSV.TimeshiftBuffer`           | Enable the timeshift buffer for HomeKit Secure Video. (default: true).
| `Video.HKSV.Recording.Switch`          | Add a switch accessory to enable or disable HKSV event recording. (default: false).
| `Video.HKSV.Record.Only.Low`           | For HomeKit Secure Video recordings, force the use of the low quality video stream from the Protect controller. (default: false).
| `Video.HKSV.Record.Only.Medium`        | For HomeKit Secure Video recordings, force the use of the medium quality video stream from the Protect controller. (default: false).
| `Video.HKSV.Record.Only.High`          | For HomeKit Secure Video recordings, force the use of the high quality video stream from the Protect controller. (default: false).
