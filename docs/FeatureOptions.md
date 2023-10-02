<SPAN ALIGN="CENTER" STYLE="text-align:center">
<DIV ALIGN="CENTER" STYLE="text-align:center">

[![homebridge-unifi-protect: Native HomeKit support for UniFi Protect](https://raw.githubusercontent.com/hjdhjd/homebridge-unifi-protect/main/images/homebridge-unifi-protect.svg)](https://github.com/hjdhjd/homebridge-unifi-protect)

# Homebridge UniFi Protect

[![Downloads](https://img.shields.io/npm/dt/homebridge-unifi-protect?color=%230559C9&logo=icloud&logoColor=%23FFFFFF&style=for-the-badge)](https://www.npmjs.com/package/homebridge-unifi-protect)
[![Version](https://img.shields.io/npm/v/homebridge-unifi-protect?color=%230559C9&label=Homebridge%20UniFi%20Protect&logo=ubiquiti&logoColor=%23FFFFFF&style=for-the-badge)](https://www.npmjs.com/package/homebridge-unifi-protect)
[![UniFi Protect@Homebridge Discord](https://img.shields.io/discord/432663330281226270?color=0559C9&label=Discord&logo=discord&logoColor=%23FFFFFF&style=for-the-badge)](https://discord.gg/QXqfHEW)
[![verified-by-homebridge](https://img.shields.io/badge/homebridge-verified-blueviolet?color=%23491F59&style=for-the-badge&logoColor=%23FFFFFF&logo=homebridge)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)

## Complete HomeKit support for the UniFi Protect ecosystem using [Homebridge](https://homebridge.io).
</DIV>
</SPAN>

`homebridge-unifi-protect` is a [Homebridge](https://homebridge.io) plugin that provides HomeKit support to the [UniFi Protect](https://ui.com/camera-security) device ecosystem. [UniFi Protect](https://ui.com/camera-security) is [Ubiquiti's](https://www.ui.com) video security platform, with rich camera, doorbell, and NVR controller hardware options for you to choose from, as well as an app which you can use to view, configure and manage your video camera and doorbells.

### Feature Options

Feature options allow you to enable or disable certain features in this plugin. These feature options provide unique flexibility by also allowing you to set a scope for each option that allows you more granular control in how this plugin makes features and capabilities available in HomeKit.

The priority given to these options works in the following order, from highest to lowest priority where settings that are higher in priority will override the ones below:

  * Device options that are enabled or disabled.
  * Controller options that are enabled or disabled.
  * Global options that are enabled or disabled.

All feature options can be set at any scope level, or at multiple scope levels. If an option isn't applicable to a particular category of device, it is ignored. For example, if you have two doorbells in your environment, and want to enable the same feature options on both, you can enable the doorbell-related feature options globally rather than specifying them for each individual doorbell. If you want to override a global feature option you've set, you can override the global feature option for the individual doorbell in this example.

**Note: it's strongly recommended that you use the Homebridge webUI](https://github.com/homebridge/homebridge-config-ui-x) to configure this plugin - it's easier to use for most people, and will ensure you always have a valid configuration.**

#### Specifying Scope
There are two types of scope specifiers that you can use with feature options - MAC addresses.

Scoping rules:

  * If you don't use a scoping specifier, feature options will be applied globally for all devices.
  * To use a device or controller-specific feature option, append the option with `.MAC`, where `MAC` is the MAC address of either a UniFi Protect controller or a camera.

`homebridge-unifi-protect` will log all devices it discovers on startup, including MAC addresses, which you can use to tailor the feature options you'd like to enable or disable on a per-device basis.

### Getting Started
Before using these features, you should understand how feature options propagate to controllers and the devices attached to them. If you choose to disable a controller from being available to HomeKit, you will also disable all the cameras attached to that controller. If you've disabled a controller, you can selectively enable a single device associated with that controller by explicitly using the `Enable.` Feature Option with that device's MAC address. This provides you a lot of richness in how you enable or disable devices for HomeKit use.

The `options` setting is an array of strings used to customize Feature Options in your `config.json`. I would encourage most users, however, to use the [Homebridge webUI](https://github.com/homebridge/homebridge-config-ui-x), to configure Feature Options as well as other options in this plugin. It contains additional validation checking of parameters to ensure the configuration is always valid.

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

**Note: it's strongly recommended that you use the Homebridge webUI](https://github.com/homebridge/homebridge-config-ui-x) to configure this plugin - it's easier to use for most people, and will ensure you always have a valid configuration.**

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

These option(s) apply to: , and Protect cameras

| Option                                           | Description
|--------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
| `Audio`                                          | Audio support. **(default: enabled)**. <BR>*Supported on Protect cameras that have a microphone.*
| `Audio.Filter.Noise`                             | Audio filter for ambient noise suppression. **(default: disabled)**. <BR>*Supported on Protect cameras that have a microphone.*
| `Audio.Filter.Noise.FftNr<I>.Value</I>`          | Noise reduction amount, in decibels, for the FFmpeg afftdn filter. **(default: 90)**.
| `Audio.Filter.Noise.HighPass<I>.Value</I>`       | Frequency, in Hertz, for the FFmpeg highpass filter. **(default: 200)**.
| `Audio.Filter.Noise.LowPass<I>.Value</I>`        | Frequency, in Hertz, for the FFmpeg lowpass filter. **(default: 1000)**.
| `Audio.TwoWay`                                   | Two-way audio support on supported cameras. **(default: enabled)**. <BR>*Supported on Protect devices that have a speaker (e.g. Protect doorbells).*

#### <A NAME="device"></A>Device feature options.

These option(s) apply to: , and all Protect devices

| Option                                           | Description
|--------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
| `Device`                                         | Make this device available in HomeKit. **(default: enabled)**.
| `Device.SyncName`                                | Synchronize the UniFi Protect name of this device with HomeKit. Synchronization is one-way only, syncing the device name from UniFi Protect to HomeKit. **(default: disabled)**.
| `Device.StatusLed`                               | Enable the status LED for this device in HomeKit. **(default: disabled)**. <BR>*Supported on Protect devices that have a status LED.*

#### <A NAME="doorbell"></A>Doorbell feature options.

These option(s) apply to: , and Protect cameras

| Option                                           | Description
|--------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
| `Doorbell.Messages`                              | Enable the doorbell messages feature. **(default: enabled)**. <BR>*Supported on Protect devices that have a doorbell.*
| `Doorbell.Messages.FromDoorbell`                 | Use messages saved to the Protect NVR as message switches. **(default: enabled)**. <BR>*Supported on Protect devices that have a doorbell.*
| `Doorbell.PhysicalChime`                         | Add switch accessories to control the physical chimes attached to a Protect doorbell. **(default: disabled)**. <BR>*Supported on Protect devices that have a physical chime.*
| `Doorbell.PhysicalChime.Duration.Digital<I>.Value</I>`  | Chime duration, in milliseconds, of a digital physical chime attached to a Protect doorbell. **(default: 1000)**. <BR>*Supported on Protect devices that have a physical chime.*
| `Doorbell.Trigger`                               | Add a switch accessory to trigger doorbell ring events on a Protect camera or doorbell. **(default: disabled)**. <BR>*Supported on Protect cameras that have a motion sensor.*

#### <A NAME="log"></A>Logging feature options.

These option(s) apply to: Protect cameras, Protect lights, and Protect sensors

| Option                                           | Description
|--------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
| `Log.Doorbell`                                   | Log doorbell ring events in Homebridge. **(default: enabled)**. <BR>*Supported on Protect cameras that have a motion sensor.*
| `Log.HKSV`                                       | Log HomeKit Secure Video recording events in Homebridge. **(default: enabled)**. <BR>*Supported on Protect cameras that have a motion sensor.*
| `Log.Motion`                                     | Log motion events in Homebridge. **(default: disabled)**. <BR>*Supported on Protect devices that have a motion sensor.*

#### <A NAME="motion"></A>Motion detection feature options.

These option(s) apply to: Protect cameras, Protect lights, and Protect sensors

| Option                                           | Description
|--------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
| `Motion.Duration<I>.Value</I>`                   | Duration, in seconds, of a single motion event, before allowing a new one. **(default: 10)**.
| `Motion.OccupancySensor`                         | Add an occupancy sensor accessory using motion sensor activity to determine occupancy. By default, any motion will trigger occupancy. If the smart motion detection feature option is enabled, it will be used instead. **(default: disabled)**. <BR>*Supported on Protect devices that have a motion sensor.*
| `Motion.OccupancySensor.Duration<I>.Value</I>`   | Duration, in seconds, to wait without receiving a motion event to determine when occupancy is no longer detected. **(default: 300)**.
| `Motion.OccupancySensor.Person`                  | When using both the occupancy sensor and smart motion detection feature options, use UniFi Protect's person detection to trigger occupancy. **(default: enabled)**. <BR>*Supported on Protect devices that support smart motion detection (e.g. G4-series cameras and better).*
| `Motion.OccupancySensor.Vehicle`                 | When using both the occupancy sensor and smart motion detection feature options, use UniFi Protect's vehicle detection to trigger occupancy. **(default: disabled)**. <BR>*Supported on Protect devices that support smart motion detection (e.g. G4-series cameras and better).*
| `Motion.SmartDetect`                             | Use UniFi Protect smart motion detection for HomeKit motion events when on a supported device. **(default: disabled)**. <BR>*Supported on Protect devices that support smart motion detection (e.g. G4-series cameras and better).*
| `Motion.SmartDetect.ObjectSensors`               | Add contact sensor accessories for each smart motion object type that UniFi Protect supports. **(default: disabled)**. <BR>*Supported on Protect devices that support smart motion detection (e.g. G4-series cameras and better).*
| `Motion.SmartDetect.ObjectSensors.LicensePlate<I>.Value</I>`  | Add a contact sensor accessory that will match a specific license plate detected by UniFi Protect. You may specify multiple license plates by using hyphens to distinguish unique license plates (e.g. PLATE1-PLATE2-PLATE3). **(default: )**.
| `Motion.Switch`                                  | Add a switch accessory to activate or deactivate motion detection in HomeKit. **(default: disabled)**. <BR>*Supported on Protect devices that have a motion sensor.*
| `Motion.Trigger`                                 | Add a switch accessory to manually trigger a motion detection event in HomeKit. **(default: disabled)**. <BR>*Supported on Protect devices that have a motion sensor.*

#### <A NAME="nvr"></A>NVR feature options.

These option(s) apply to: Protect cameras and Protect controllers

| Option                                           | Description
|--------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
| `Nvr.Service.Playlist<I>.Value</I>`              | Publish an M3U playlist of Protect cameras on the specified port of this Homebridge server that is suitable for use in apps (e.g. Channels DVR) that can make camera livestreams available through them. **(default: 10110)**. <BR>*Supported on Protect controllers.*
| `Nvr.DelayDeviceRemoval<I>.Value</I>`            | Delay, in seconds, before removing devices that are no longer detected on the Protect controller. By default, devices are added and removed in realtime. **(default: 60)**. <BR>*Supported on Protect controllers.*
| `Nvr.Publish.Telemetry`                          | Publish all the realtime telemetry received from the Protect controller to MQTT. **(default: disabled)**. <BR>*Supported on Protect controllers.*
| `Nvr.Recording.Switch`                           | Add switch accessories to control the native recording capabilities of the UniFi Protect NVR. **(default: disabled)**. <BR>*Supported on Protect cameras.*
| `Nvr.SystemInfo`                                 | Add sensor accessories to display the Protect controller system information (currently only the temperature). **(default: disabled)**. <BR>*Supported on Protect controllers.*

#### <A NAME="securitysystem"></A>Security system feature options.

These option(s) apply to: Protect cameras and Protect controllers

| Option                                           | Description
|--------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
| `SecuritySystem.Alarm`                           | Add a switch accessory to trigger the security system accessory, when using the liveview feature option. **(default: disabled)**.

#### <A NAME="video"></A>Video feature options.

These option(s) apply to: , and Protect cameras

| Option                                           | Description
|--------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
| `Video.Transcode.Hardware`                       | Use hardware-accelerated transcoding when available (Apple Macs, Intel Quick Sync Video-enabled CPUs, Raspberry Pi 4). **(default: disabled)**.
| `Video.Stream.Only.High`                         | When viewing livestreams, force the use of the high quality video stream from the Protect controller. **(default: disabled)**.
| `Video.Stream.Only.Medium`                       | When viewing livestreams, force the use of the medium quality video stream from the Protect controller. **(default: disabled)**.
| `Video.Stream.Only.Low`                          | When viewing livestreams, force the use of the low quality video stream from the Protect controller. **(default: disabled)**.
| `Video.Transcode`                                | When streaming to local clients (e.g. at home), always transcode livestreams, instead of transmuxing them. **(default: disabled)**.
| `Video.Transcode.HighLatency`                    | When streaming to high-latency clients (e.g. cellular connections), transcode livestreams instead of transmuxing them. **(default: enabled)**.
| `Video.DynamicBitrate`                           | Dynamically adjust the image quality of the camera directly on the UniFi Protect controller to accomodate HomeKit requests. **(default: disabled)**.
| `Video.DynamicBitrate.Switch`                    | Add a switch accessory to enable or disable dynamic bitrate support on the Protect controller. **(default: disabled)**.

#### <A NAME="video.hksv"></A>HomeKit Secure Video feature options.

These option(s) apply to: , and Protect cameras

| Option                                           | Description
|--------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
| `Video.HKSV.Recording.MaxDuration<I>.Value</I>`  | Maximum HomeKit Secure Video event duration, in seconds. **(default: 0)**.
| `Video.HKSV.Recording.Switch`                    | Add a switch accessory to enable or disable HKSV event recording. **(default: disabled)**.
| `Video.HKSV.Record.Only.High`                    | When recording HomeKit Secure Video events, force the use of the high quality video stream from the Protect controller. **(default: disabled)**.
| `Video.HKSV.Record.Only.Medium`                  | When recording HomeKit Secure Video events, force the use of the medium quality video stream from the Protect controller. **(default: disabled)**.
| `Video.HKSV.Record.Only.Low`                     | When recording HomeKit Secure Video events, force the use of the low quality video stream from the Protect controller. **(default: disabled)**.
| `Video.HKSV.TimeshiftBuffer`                     | Enable the timeshift buffer for HomeKit Secure Video. **(default: enabled)**.
