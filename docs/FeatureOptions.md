<SPAN ALIGN="CENTER" STYLE="text-align:center">
<DIV ALIGN="CENTER" STYLE="text-align:center">

[![homebridge-unifi-protect: Native HomeKit support for UniFi Protect](https://raw.githubusercontent.com/hjdhjd/homebridge-unifi-protect/master/homebridge-protect.svg)](https://github.com/hjdhjd/homebridge-unifi-protect)

# Homebridge UniFi Protect

[![Downloads](https://img.shields.io/npm/dt/homebridge-unifi-protect?color=%230559C9&logo=icloud&logoColor=%23FFFFFF&style=for-the-badge)](https://www.npmjs.com/package/homebridge-unifi-protect)
[![Version](https://img.shields.io/npm/v/homebridge-unifi-protect?color=%230559C9&label=Homebridge%20UniFi%20Protect&logo=ubiquiti&logoColor=%23FFFFFF&style=for-the-badge)](https://www.npmjs.com/package/homebridge-unifi-protect)
[![UniFi Protect@Homebridge Discord](https://img.shields.io/discord/432663330281226270?color=0559C9&label=Discord&logo=discord&logoColor=%23FFFFFF&style=for-the-badge)](https://discord.gg/QXqfHEW)
[![verified-by-homebridge](https://img.shields.io/badge/homebridge-verified-blueviolet?color=%23491F59&style=for-the-badge&logoColor=%23FFFFFF&logo=homebridge)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)

## HomeKit support for the UniFi Protect ecosystem using [Homebridge](https://homebridge.io).
</DIV>
</SPAN>

`homebridge-unifi-protect` is a [Homebridge](https://homebridge.io) plugin that provides HomeKit support to the [UniFi Protect](https://unifi-network.ui.com/video-security) device ecosystem. [UniFi Protect](https://unifi-network.ui.com/video-security) is [Ubiquiti's](https://www.ui.com) next-generation video security platform, with rich camera, doorbell, and NVR controller hardware options for you to choose from, as well as an app which you can use to view, configure and manage your video camera and doorbells.

### Feature Options

Feature Options allow you to enable or disable certain features in this plugin. These Feature Options provide unique flexibility by also allowing you to set a scope for each option that allows you more granular control in how this plugin makes features and capabilities available in HomeKit.

The priority given to these options works in the following order, from highest to lowest priority where settings that are higher in priority can override lower ones:

  * Client-specific options that are enabled or disabled. **Note: these only apply for [audio](#audio) and [video](#video) feature options.**
  * Device options that are enabled or disabled.
  * Controller options that are enabled or disabled.
  * Global options that are enabled or disabled.

All feature options can be set at any scope level, or at multiple scope levels. If an option isn't applicable to a particular category of device, it is ignored. For example, if you have two doorbells in your environment, and want to enable the same feature options on both, you can enable the doorbell-related feature options globally rather than specifying them for each individual doorbell. If you want to override a global feature option you've set, you can override the global feature option for the individual doorbell in this example.

#### Specifying Scope
There are two types of scope specifiers that you can use with feature options - MAC addresses and streaming client IP addresses.

Scoping rules:

  * If you don't use a scoping specifier, feature options will be applied globally for all devices and streaming clients.
  * Feature option scoping specifiers can be stacked together, meaning you can use either type of scope or both, enabling you to create options that are specific to a certain Protect device, a certain streaming client, or both.
    * To use a device-specific feature option, append the option with `.MAC`, where `MAC` is the MAC address of either a UniFi Protect controller or a camera.
    * To use a streaming client-specific feature option, append the option with `.IPADDRESS` where `IPADDRESS` is the IP address of the HomeKit streaming client.
    * To use both a device-specific and a streaming client-specific feature option, append the option with `.MAC.IPADDRESS`.

`homebridge-unifi-protect` will log all devices it discovers on startup, including MAC addresses, which you can use to tailor the feature options you'd like to enable or disable on a per-device basis. Additionally, when a client requests a video stream, the IP address of that client will be logged, which you can also use to further tailor the streaming experience.

### Getting Started
Before using these features, you should understand how Feature Options propagate to controllers and the devices attached to them. If you choose to disable a controller from being available to HomeKit, you will also disable all the cameras attached to that controller. If you've disabled a controller, you can selectively enable a single device associated with that controller by explicitly using the `Enable.` Feature Option with that device's MAC address. This provides you a lot of richness in how you enable or disable devices for HomeKit use.

The `options` setting is an array of strings used to customize Feature Options in your `config.json`. I would encourage most users, however, to use the [Homebridge webUI](https://github.com/oznu/homebridge-config-ui-x), to configure Feature Options as well as other options in this plugin. It contains additional validation checking of parameters to ensure the configuration is always valid.

#### Example Configuration
An example `options` setting might look like this in your config.json:

```js
"platforms": [
  {
    "platform": "UniFi Protect",

    "options": [
      "Disable.Video.Stream.High",
      "Enable.Video.Stream.High.AAAAAAAAAAAA"
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

* The first line `Disable.Stream.High` disables the high quality stream on all UniFi Protect devices that appear in HomeKit.
* The second line, overrides the first and enables the high quality stream on the G3 Flex because specifying device-specific options always overrides global settings.

**Note: it's strongly recommended that you use the Homebridge webUI to configure this plugin - it's easier to use for most people, and will ensure you always have a valid configuration.**

### <A NAME="reference"></A>Feature Options Reference
Feature options provide a rich mechanism for tailoring your `homebridge-unifi-protect` experience. The reference below is divided into functional category groups:

  * [Audio](#audio): enable, disable, or enable audio filters.
  * [Device](#device): enable or disable specific cameras or Protect controllers.
  * [Doorbell](#doorbell): enable, disable, or customize doorbell features and related automation options.
  * [Logging](#logging): enable or disable logging of motion and doorbell ring events.
  * [Motion](#motion): enable, disable, or customize motion detection and related automation options.
  * [Security System](#securitysystem): enable, disable, or customize the optional security system accessory.
  * [Video](#video): further customize RTSP stream quality defaults.

#### <A NAME="audio"></A>Audio Feature Options
Some audio and video options can be applied on a per-streaming-client basis, if you choose. This means that you can optionally choose to set a certain stream quality or disable audio, for specific HomeKit streaming clients. For example, you may choose to always disable audio support when your Apple TV (with a static IP address) requests a camera stream.

Please review the [audio options documentation](https://github.com/hjdhjd/homebridge-unifi-protect/blob/master/docs/AudioOptions.md) for additional information about the options below.

| Option                                        | Description
|-----------------------------------------------|----------------------------------
| `Enable.Audio`                                | Enable audio support. *(Default)* <BR>*This option can be further customized on a per-streaming-client basis.*</BR>
| `Disable.Audio`                               | Disable audio support. <BR>*This option can be further customized on a per-streaming-client basis.*</BR>
|                                               |
| `Enable.Audio.Filter.Noise`                   | Enable the [audio noise filter](https://github.com/hjdhjd/homebridge-unifi-protect/blob/master/docs/AudioOptions.md#noise-filter) to enhance voices over background noise. <BR>*This option can be further customized on a per-streaming-client basis.*</BR>
| `Disable.Audio.Filter.Noise`                  | Disable the [audio noise filter](https://github.com/hjdhjd/homebridge-unifi-protect/blob/master/docs/AudioOptions.md#noise-filter). *(Default)* <BR>*This option can be further customized on a per-streaming-client basis.*</BR>
|                                               |
| <CODE>Enable.Audio.Filter.Noise.HighPass.<I>Number</I> | Set the high pass filter to attenuate (eliminate) frequencies below *number*. *(Default: 200)* <BR>*This option can be further customized on a per-streaming-client basis.*</BR>
| <CODE>Enable.Audio.Filter.Noise.LowPass.<I>Number</I> | Set the low pass filter to attenuate (eliminate) frequencies above *number*. *(Default: 1000)* <BR>*This option can be further customized on a per-streaming-client basis.*</BR>
|                                               |
| `Enable.Audio.TwoWay`                          | Enable two-way audio support using the Home app for supported cameras and doorbells. *(Default)*<BR>**Note that acoustic echo cancellation (AEC) is not currently available and you *will* hear an echo when using the Home app, however those standing at the doorbell (or camera) will hear things correctly.**</BR>
| `Disable.Audio.TwoWay`                         | Disable two-way audio support.

#### <A NAME="device"></A>Device Feature Options
These feature options allow you to control which Protect devices or controllers are enabled or disabled within HomeKit.

| Option                                        | Description
|-----------------------------------------------|----------------------------------
| <CODE>Enable.<I>MAC</I></CODE>                | Show the camera or controller identified by MAC address `MAC` from HomeKit.
| <CODE>Disable.<I>MAC</I></CODE>               | Hide the camera or controller identified by MAC address `MAC` from HomeKit.

#### <A NAME="doorbell"></A>Doorbell Feature Options
Please review the [documentation for UniFi Protect doorbell support](https://github.com/hjdhjd/homebridge-unifi-protect/blob/master/docs/Doorbell.md) for additional information about the options below and the broader doorbell feature set available in `homebridge-unifi-protect`.

| Option                                        | Description
|-----------------------------------------------|----------------------------------
| `Enable.Doorbell.Messages`                    | Enable the doorbell messages feature on UniFi Protect doorbells. *(Default)*
| `Disable.Doorbell.Messages`                   | Disable the doorbell messages feature on UniFi Protect doorbells.
|                                               |
| `Enable.Doorbell.Messages.FromDoorbell`       | Allow messages saved on the UniFi Protect doorbell to appear as switches in HomeKit. *(Default)*
| `Disable.Doorbell.Messages.FromDoorbell`      | Prevent messages saved on the UniFi Protect doorbell from appearing as switches in HomeKit.
|                                               |
| `Enable.Doorbell.NvrEvents`                   | Enable the processing of doorbell ring events from the UniFi Protect controller. *(Default)*
| `Disable.Doorbell.NvrEvents`                  | Disable the processing of doorbell ring events from the UniFi Protect controller. This is useful in scenarios where you want to ignore events generated from UniFi Protect and execute certain automation scenarios.
|                                               |
| `Enable.Doorbell.Trigger`                     | This feature option has a dual purpose: <UL> <LI>First, for Protect cameras that are not hardware doorbells, this will allow you to enable or disable HomeKit doorbell support on **any** Protect camera.</LI> <LI>Second, this will create a switch accessory in HomeKit that you can use to trigger ring events or create automations when ring events occur.</LI></UL>
| `Disable.Doorbell.Trigger`                    | Remove the doorbell switch accessory.  *(Default)*

#### <A NAME="logging"></A>Logging Feature Options
Logging feature options control which events get logged in Homebridge.

| Option                                        | Description
|-----------------------------------------------|----------------------------------
| `Enable.Log.Doorbell`                         | Enable the logging of doorbell ring events in Homebridge. *(Default)*
| `Disable.Log.Doorbell`                        | Disable the logging of doorbell ring events in Homebridge.
|                                               |
| `Enable.Log.Motion`                           | Enable the logging of motion events in Homebridge.
| `Disable.Log.Motion`                          | Disable the logging of motion events in Homebridge. *(Default)*

#### <A NAME="motion"></A>Motion Feature Options
Motion feature options allow you to tailor various aspects of motion detection and related automation settings.

| Option                                        | Description
|-----------------------------------------------|----------------------------------
| `Enable.Motion.NvrEvents`                     | Enable the processing of motion events from the UniFi Protect controller. *(Default)*
| `Disable.Motion.NvrEvents`                    | Disable the processing of motion events from the UniFi Protect controller. This is useful in scenarios where you want to ignore events generated from UniFi Protect and execute certain automation scenarios.
|                                               |
| `Enable.Motion.Sensor`                        | Add a motion sensor accessory to HomeKit to enable motion detection. *(Default)*
| `Disable.Motion.Sensor`                       | Remove the motion sensor and motion sensor switch accessories to disable motion detection capabilities
|                                               |
| `Enable.Motion.SmartDetect`                   | Enable smart motion detection on G4-series cameras. By default, any smart motion events configured will trigger the motion sensor. Some things to keep in mind: <UL> <LI>This feature requires UniFi Protect controller v1.15 or greater.</LI> <LI>Only G4-series cameras are supported - this is a UniFi Protect limitation, unfortunately.</LI> <LI>Smart motion detection uses the AI/ML capabilities on G4-series cameras to detect objects of interest. Currently, the supported object types are person and vehicle.</LI> <LI>You can configure smart motion detection in the UniFi Protect controller webUI for more customization and control over the motion detection experience.</LI> <LI>This feature option will suppress non-smart motion events on supported cameras.</LI> </UL>
| `Disable.Motion.SmartDetect`                  | Disable smart motion detection. *(Default)*
|                                               |
| `Enable.Motion.SmartDetect.NvrEvents`         | Enable the processing of smart motion events from the UniFi Protect controller. *(Default)*
| `Disable.Motion.SmartDetect.NvrEvents`        | Disable the processing of smart motion events from the UniFi Protect controller. This is useful in scenarios where you want to ignore events generated from UniFi Protect and execute certain automation scenarios.
|                                               |
| `Enable.Motion.SmartDetect.ObjectSensors`     | This feature option will create contact sensors for each object type that UniFi Protect supports through smart motion detection. The contact sensors will be triggered when a particular object type is detected, in addition to triggering a motion detection event. This is useful in scenarios where you have multiple object types configured for smart motion detection and you want to create automations around specific smart motion event object types. <BR>For example, you may have a smart motion detection zone for person and another for vehicle, and you want an automation to turn on a light if a person is detected, but not if a vehicle is detected. Enabling this option will allow you to create an automation using the contact sensor for the person object type.</BR>
| `Disable.Motion.SmartDetect.ObjectSensors`    | Disable smart motion detection contact sensors for each object type supported by UniFi Protect. *(Default)*
|                                               |
| `Enable.Motion.SmartDetect.Person`            | Trigger a motion event if smart motion detection identifies a person. This option requires smart motion detection to be enabled and assumes the appropriate smart detection zones have been configured in UniFi Protect. *(Default)*
| `Disable.Motion.SmartDetect.Person`           | Disable triggering motion events when smart motion detection identifies a person.
|                                               |
| `Enable.Motion.SmartDetect.Vehicle`           | Trigger a motion event if smart motion detection identifies a vehicle. This option requires smart motion detection to be enabled and assumes the appropriate smart detection zones have been configured in UniFi Protect. *(Default)*
| `Disable.Motion.SmartDetect.Vehicle`          | Disable triggering motion events when smart motion detection identifies a vehicle.
|                                               |
| `Enable.Motion.Switch`                        | Add a switch accessory to activate or deactivate motion detection in HomeKit.
| `Disable.Motion.Switch`                       | Remove the switch accessory used to enable or disable motion detection. *(Default)* <BR> *Note: this will not disable motion detection, just remove the ability to selectively activate and deactivate it in HomeKit.*</BR>
|                                               |
| `Enable.Motion.Trigger`                       | Add a switch accessory to manually trigger a motion detection event in HomeKit. This is useful in certain automation scenarios where you want to trigger a rich notification based on some other event.
| `Disable.Motion.Trigger`                      | Remove the switch accessory used to manually trigger a motion detection event. *(Default)*

#### <A NAME="securitysystem"></A>Security System Feature Options
Please review the [documentation for UniFi Protect liveview support](https://github.com/hjdhjd/homebridge-unifi-protect/blob/master/docs/Liveviews.md) for additional information about the options below and the broader liveview and security system feature set available in `homebridge-unifi-protect`.

| Option                                        | Description
|-----------------------------------------------|----------------------------------
| `Enable.SecuritySystem.Alarm`                 | Enable a switch that can trigger the security alarm on the security system accessory. This requires configuring [liveview scenes](https://github.com/hjdhjd/homebridge-unifi-protect/blob/master/docs/Liveviews.md#security-system) in order to enable to security system accessory.
| `Disable.SecuritySystem.Alarm`                | Remove the security alarm switch on the security system accessory. *(Default)*

#### <A NAME="video"></A>Video Feature Options
Some audio and video options can be applied on a per-streaming-client basis, if you choose. This means that you can optionally choose to set a certain stream quality or disable audio, for specific HomeKit streaming clients. For example, you may choose to always disable audio support when your Apple TV (with a static IP address) requests a camera stream.

Video feature options allow you to tailor which RTSP streams are utilized for HomeKit video streaming.

| Option                                               | Description
|------------------------------------------------------|----------------------------------
| <CODE>Enable.Video.Stream.<I>Quality</I></CODE>      | Make the stream of quality *Quality* available for use when streaming video in HomeKit. Valid quality settings are `Low`, `Medium`, `High`. *(Default: All stream qualities are enabled)*
| <CODE>Disable.Video.Stream.<I>Quality</I></CODE>     | Make the stream of quality *Quality* unavailble for use when streaming video in HomeKit. Valid quality settings are `Low`, `Medium`, `High`.
|                                                      |
| <CODE>Enable.Video.Stream.Only.<I>Quality</I></CODE> | Only allow the stream of quality *Quality* to be used in HomeKit. Valid quality settings are `Low`, `Medium`, `High`. *(Default: None)* <BR>**This option can be further customized on a per-streaming-client basis.**</BR>
|                                                      |
| `Enable.Video.Transcode`                             | Enable transcoding for this camera. <BR>**This option can be further customized on a per-streaming-client basis.**</BR><BR>**Note: this option will increase CPU consumption on the computer you run Homebridge on when streaming is active.**</BR>
| `Disable.Video.Transcode`                            | Disable transcoding for this camera. *(Default)* <BR>**This option can be further customized on a per-streaming-client basis.**</BR><BR>**Note: by default, the plugin will attempt to stream video unmodified from the source. For most users this is blazingly fast and works very reliably. For the unlucky few, they may need to to use transcoding as a last resort to get streaming to work properly.**</BR>
