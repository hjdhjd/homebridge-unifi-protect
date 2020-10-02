<SPAN ALIGN="CENTER" STYLE="text-align:center">
<DIV ALIGN="CENTER" STYLE="text-align:center">

[![homebridge-unifi-protect: Native HomeKit support for UniFi Protect](https://raw.githubusercontent.com/hjdhjd/homebridge-unifi-protect/master/homebridge-protect.svg)](https://github.com/hjdhjd/homebridge-unifi-protect)

# Homebridge UniFi Protect

[![Downloads](https://img.shields.io/npm/dt/homebridge-unifi-protect?color=%230559C9&logo=icloud&logoColor=%23FFFFFF&style=for-the-badge)](https://www.npmjs.com/package/homebridge-unifi-protect)
[![Version](https://img.shields.io/npm/v/homebridge-unifi-protect?color=%230559C9&label=Homebridge%20UniFi%20Protect&logo=ubiquiti&logoColor=%23FFFFFF&style=for-the-badge)](https://www.npmjs.com/package/homebridge-unifi-protect)
[![UniFi Protect@Homebridge Discord](https://img.shields.io/discord/432663330281226270?color=0559C9&label=Discord&logo=discord&logoColor=%23FFFFFF&style=for-the-badge)](https://discord.gg/QXqfHEW)
[![verified-by-homebridge](https://img.shields.io/badge/homebridge-verified-blueviolet?color=%2357277C&style=for-the-badge&logoColor=%23FFFFFF&logo=data:image/svg%2bxml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI5OTIuMDkiIGhlaWdodD0iMTAwMCIgdmlld0JveD0iMCAwIDk5Mi4wOSAxMDAwIj48ZGVmcz48c3R5bGU+LmF7ZmlsbDojZmZmO308L3N0eWxlPjwvZGVmcz48cGF0aCBjbGFzcz0iYSIgZD0iTTk1MC4xOSw1MDguMDZhNDEuOTEsNDEuOTEsMCwwLDEtNDItNDEuOWMwLS40OC4zLS45MS4zLTEuNDJMODI1Ljg2LDM4Mi4xYTc0LjI2LDc0LjI2LDAsMCwxLTIxLjUxLTUyVjEzOC4yMmExNi4xMywxNi4xMywwLDAsMC0xNi4wOS0xNkg3MzYuNGExNi4xLDE2LjEsMCwwLDAtMTYsMTZWMjc0Ljg4bC0yMjAuMDktMjEzYTE2LjA4LDE2LjA4LDAsMCwwLTIyLjY0LjE5TDYyLjM0LDQ3Ny4zNGExNiwxNiwwLDAsMCwwLDIyLjY1bDM5LjM5LDM5LjQ5YTE2LjE4LDE2LjE4LDAsMCwwLDIyLjY0LDBMNDQzLjUyLDIyNS4wOWE3My43Miw3My43MiwwLDAsMSwxMDMuNjIuNDVMODYwLDUzOC4zOGE3My42MSw3My42MSwwLDAsMSwwLDEwNGwtMzguNDYsMzguNDdhNzMuODcsNzMuODcsMCwwLDEtMTAzLjIyLjc1TDQ5OC43OSw0NjguMjhhMTYuMDUsMTYuMDUsMCwwLDAtMjIuNjUuMjJMMjY1LjMsNjgwLjI5YTE2LjEzLDE2LjEzLDAsMCwwLDAsMjIuNjZsMzguOTIsMzlhMTYuMDYsMTYuMDYsMCwwLDAsMjIuNjUsMGwxMTQtMTEyLjM5YTczLjc1LDczLjc1LDAsMCwxLDEwMy4yMiwwbDExMywxMTEsLjQyLjQyYTczLjU0LDczLjU0LDAsMCwxLDAsMTA0TDU0NS4wOCw5NTcuMzV2LjcxYTQxLjk1LDQxLjk1LDAsMSwxLTQyLTQxLjk0Yy41MywwLC45NS4zLDEuNDQuM0w2MTYuNDMsODA0LjIzYTE2LjA5LDE2LjA5LDAsMCwwLDQuNzEtMTEuMzMsMTUuODUsMTUuODUsMCwwLDAtNC43OS0xMS4zMmwtMTEzLTExMWExNi4xMywxNi4xMywwLDAsMC0yMi42NiwwTDM2Ny4xNiw3ODIuNzlhNzMuNjYsNzMuNjYsMCwwLDEtMTAzLjY3LS4yN2wtMzktMzlhNzMuNjYsNzMuNjYsMCwwLDEsMC0xMDMuODZMNDM1LjE3LDQyNy44OGE3My43OSw3My43OSwwLDAsMSwxMDMuMzctLjlMNzU4LjEsNjM5Ljc1YTE2LjEzLDE2LjEzLDAsMCwwLDIyLjY2LDBsMzguNDMtMzguNDNhMTYuMTMsMTYuMTMsMCwwLDAsMC0yMi42Nkw1MDYuNSwyNjUuOTNhMTYuMTEsMTYuMTEsMCwwLDAtMjIuNjYsMEwxNjQuNjksNTgwLjQ0QTczLjY5LDczLjY5LDAsMCwxLDYxLjEsNTgwTDIxLjU3LDU0MC42OWwtLjExLS4xMmE3My40Niw3My40NiwwLDAsMSwuMTEtMTAzLjg4TDQzNi44NSwyMS40MUE3My44OSw3My44OSwwLDAsMSw1NDAsMjAuNTZMNjYyLjYzLDEzOS4zMnYtMS4xYTczLjYxLDczLjYxLDAsMCwxLDczLjU0LTczLjVINzg4YTczLjYxLDczLjYxLDAsMCwxLDczLjUsNzMuNVYzMjkuODFhMTYsMTYsMCwwLDAsNC43MSwxMS4zMmw4My4wNyw4My4wNWguNzlhNDEuOTQsNDEuOTQsMCwwLDEsLjA4LDgzLjg4WiIvPjwvc3ZnPg==)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)

## HomeKit support for the UniFi Protect ecosystem using [Homebridge](https://homebridge.io).
</DIV>
</SPAN>

`homebridge-unifi-protect` is a [Homebridge](https://homebridge.io) plugin that provides HomeKit support to the [UniFi Protect](https://unifi-network.ui.com/video-security) device ecosystem. [UniFi Protect](https://unifi-network.ui.com/video-security) is [Ubiquiti's](https://www.ui.com) next-generation video security platform, with rich camera, doorbell, and NVR controller hardware options for you to choose from, as well as an app which you can use to view, configure and manage your video camera and doorbells.

### Feature Options

Feature Options allow you to enable or disable certain features in this plugin. These Feature Options provide unique flexibility by also allowing you to set a scope for each option that allows you more granular control in how this plugin makes features and capabilities available in HomeKit.

The priority given to these options works in the following order, from highest to lowest priority where settings that are higher in priority can override lower ones:

* Device options that are enabled or disabled.
* Controller options that are enabled or disabled.
* Global options that are enabled or disabled.

All of the options below can be set at any scope level. If an option isn't applicable to a particular category of device, it is ignored. For example, if you have two doorbells in your environment, and want to enable the same feature options on both, you can enable the doorbell feature options globally instead of having to specify them individually. If you want to override a global feature option you've set, you can specify those overrides for the individual doorbell, in this example.

To specify the scope of an option, you append the option with `.MAC`, where `MAC` is the MAC address of either a UniFi Protect controller or a camera. If you don't append a MAC address to an option, it will be applied globally, unless a more specifically scoped option is specified elsewhere. The plugin will log all devices it encounters and knows about, including MAC addresses. You can use that to guide what features you would like to enable ot disable.

The `options` setting is an array of strings used to customize Feature Options in your `config.json`. I would encourage most users, however, to use the [Homebridge webUI](https://github.com/oznu/homebridge-config-ui-x), to configure Feature Options as well as other options in this plugin. It contains additional validation checking of parameters to ensure the configuration is always valid.

#### <A NAME="general"></A>General Feature Options
These Feature Options are available on ***all*** UniFi Protect devices available through this plugin:

| Option                                        | Description
|-----------------------------------------------|----------------------------------
| <CODE>Enable.<I>MAC</I></CODE>                | Show the camera or controller identified by MAC address `MAC` from HomeKit.
| <CODE>Disable.<I>MAC</I></CODE>               | Hide the camera or controller identified by MAC address `MAC` from HomeKit.
|                                               |
| `Enable.LogMotion`                            | Enable the logging, in Homebridge, of motion events.
| `Disable.LogMotion`                           | Disable the logging, in Homebridge, of motion events. *(Default)*
|                                               |
| `Enable.MotionSensor`                         | Add a motion sensor accessory to HomeKit to enable motion detection. *(Default)*
| `Disable.MotionSensor`                        | Remove the motion sensor and motion sensor switch accessories to disable motion detection capabilities
|                                               |
| `Enable.MotionSwitch`                         | Add a switch accessory to activate or deactivate motion detection in HomeKit.
| `Disable.MotionSwitch`                        | Remove the switch accessory used to enable or disable motion detection. *(Default)* *Note: this will not disable motion detection, just remove the ability to selectively activate and deactivate it in HomeKit.*
|                                               |
| `Enable.MotionTrigger`                        | Add a switch accessory to to manually trigger a motion detection event in HomeKit. This is useful in certain automation scenarios where you want to trigger a rich notification based on some other event.
| `Disable.MotionTrigger`                       | Remove the switch accessory used to manually trigger a motion detection event. *(Default)*
|                                               |
| `Enable.NoiseFilter`                          | Enable the [audio noise filter](#noise-filter) to enhance voices over background noise.
| `Disable.NoiseFilter`                         | Disable the [audio noise filter](#noise-filter). *(Default)*
| <CODE>Enable.NoiseFilter.HighPass.<I>Number</I> | Set the high pass filter to attenuate (eliminate) frequencies below *number*. *Default: 200*
| <CODE>Enable.NoiseFilter.LowPass.<I>Number</I> | Set the low pass filter to attenuate (eliminate) frequencies above *number*. *Default: 1000*
|                                               |
| <CODE>Enable.Stream.<I>Quality</I></CODE>     | Show the stream of quality *Quality* from HomeKit. Valid quality settings are `Low`, `Medium`, `High`.
| <CODE>Disable.Stream.<I>Quality</I></CODE>    | Hide the stream of quality *Quality* from HomeKit. Valid quality settings are `Low`, `Medium`, `High`.
| <CODE>Enable.StreamOnly.<I>Quality</I></CODE> | Only allow the stream of quality *Quality* to be used in HomeKit. Valid quality settings are `Low`, `Medium`, `High`.
|                                               |
| `Enable.TwoWayAudio`                          | Enable two-way audio support using the Home app for supported cameras and doorbells (G3 Micro and G4 Doorbell, currently). *(Default)*<BR>**Note that acoustic echo cancellation (AEC) is not currently available and you *will* hear an echo when using the Home app, however those standing at the doorbell (or camera) will hear things correctly.**</BR>
| `Disable.TwoWayAudio`                         | Disable two-way audio support.

#### <A NAME="controller"></A>Protect Controller Feature Options
In addition to the Feature Options available to all UniFi Protect devices, these are available for UniFi Protect controllers:

| Option                                        | Description
|-----------------------------------------------|----------------------------------
| `Enable.SecurityAlarm`                        | Enable a switch that can trigger the security alarm on the security system accessory. This requires configuring [liveview scenes](https://github.com/hjdhjd/homebridge-unifi-protect/blob/master/docs/Liveviews.md#security-system) in order to enable to security system accessory.
| `Disable.SecurityAlarm`                       | Remove the security alarm switch on the security system accessory. *(Default)*

#### <A NAME="doorbell"></A>Doorbell Feature Options
In addition to the Feature Options available to all UniFi Protect devices, these are available for UniFi Protect [doorbells](https://github.com/hjdhjd/homebridge-unifi-protect/blob/master/docs/Doorbell.md):

| Option                                        | Description
|-----------------------------------------------|----------------------------------
| `Enable.ContactSensor`                        | Add a contact sensor accessory that is triggered when the doorbell rings. This is useful when trying to create HomeKit automations for doorbell ring events.
| `Disable.ContactSensor`                       | Remove the contact sensor accessory.  *(Default)*
| `Enable.LogDoorbell`                          | Enable the logging, in Homebridge, of doorbell ring events. *(Default)*
| `Disable.LogDoorbell`                         | Disable the logging, in Homebridge, of doorbell ring events.
| `Enable.Messages`                             | Enable the doorbell messages feature on UniFi Protect doorbells. *(Default)*
| `Disable.Messages`                            | Disable the doorbell messages feature on UniFi Protect doorbells.
| `Enable.Messages.FromDoorbell`                | Allow messages saved on the UniFi Protect doorbell to appear as switches in HomeKit. *(Default)*
| `Disable.Messages.FromDoorbell`               | Prevent messages saved on the UniFi Protect doorbell from appearing as switches in HomeKit.

Before using these features, you should understand how Feature Options propagate to controllers and the devices attached to them. If you choose to disable a controller from being available to HomeKit, you will also disable all the cameras attached to that controller. If you've disabled a controller, and all it's devices with it, you can selectively enable a single device associated with that controller by explicitly setting an `Enable.` Feature Option. This provides you a lot of richness in how you enable or disable devices for HomeKit use.


### Example Configuration
An example `options` setting might look like this in your config.json:

```js
"platforms": [
  {
    "platform": "UniFi Protect",

    "options": [
      "Disable.Stream.High",
      "Enable.Stream.High.BBBBBBBBBBBB"
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
| AAAAAAAAAAAA          | A UniFi Protect controller with 4 cameras attached to it, including a UVC G3 Flex with a MAC address of BBBBBBBBBBBB.
| BBBBBBBBBBBB          | A UVC G3 Flex that is managed by a UniFi Protect controller with a MAC address of AAAAAAAAAAAA.

* The first line `Disable.Stream.High` disables the high quality stream on all UniFi Protect devices that appear in HomeKit.
* The second line, overrides the first and enables the high quality stream on the G3 Flex because specifying device-specific options always overrides global settings.

**Note: it's strongly recommended that you use the Homebridge webUI to configure this plugin - it's easier to use for most people, and will ensure you always have a valid configuration.**