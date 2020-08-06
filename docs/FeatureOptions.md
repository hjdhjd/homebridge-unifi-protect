<SPAN ALIGN="CENTER">

[![homebridge-unifi-protect2: Native HomeKit support for UniFi Protect](https://raw.githubusercontent.com/hjdhjd/homebridge-unifi-protect2/master/homebridge-protect.svg)](https://github.com/hjdhjd/homebridge-unifi-protect2)

# Homebridge UniFi Protect<SUP STYLE="font-size: smaller; color:#5EB5E6;">2</SUP>

[![Downloads](https://badgen.net/npm/dt/homebridge-unifi-protect2)](https://www.npmjs.com/package/homebridge-unifi-protect2)
[![Version](https://badgen.net/npm/v/homebridge-unifi-protect2)](https://www.npmjs.com/package/homebridge-unifi-protect2)
[![verified-by-homebridge](https://badgen.net/badge/homebridge/verified/purple)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)

## HomeKit support the UniFi Protect ecosystem using [Homebridge](https://homebridge.io).
</SPAN>

`homebridge-unifi-protect2` is a [Homebridge](https://homebridge.io) plugin that provides HomeKit support to the [UniFi Protect](https://unifi-network.ui.com/video-security) device ecosystem. [UniFi Protect](https://unifi-network.ui.com/video-security) is [Ubiquiti's](https://www.ui.com) next-generation video security platform, with rich camera, doorbell, and NVR controller hardware options for you to choose from, as well as an app which you can use to view, configure and manage your video camera and doorbells.

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

### Example
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

