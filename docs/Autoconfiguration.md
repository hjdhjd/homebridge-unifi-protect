<SPAN ALIGN="CENTER">

[![homebridge-unifi-protect2: Native HomeKit support for UniFi Protect](https://raw.githubusercontent.com/hjdhjd/homebridge-unifi-protect2/master/homebridge-protect.svg)](https://github.com/hjdhjd/homebridge-unifi-protect2)

# Homebridge UniFi Protect<SUP STYLE="font-size: smaller; color:#5EB5E6;">2</SUP>

[![Downloads](https://img.shields.io/npm/dt/homebridge-unifi-protect2?color=%235EB5E6&style=for-the-badge)](https://www.npmjs.com/package/homebridge-unifi-protect2)
[![Version](https://img.shields.io/npm/v/homebridge-unifi-protect2?color=%235EB5E6&label=UniFi%20Protect%202&logo=apple&logoColor=%235EB5E6&style=for-the-badge)](https://www.npmjs.com/package/homebridge-unifi-protect2)
[![verified-by-homebridge](https://img.shields.io/badge/homebridge-verified-blueviolet?style=for-the-badge)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)

## HomeKit support the UniFi Protect ecosystem using [Homebridge](https://homebridge.io).
</SPAN>

`homebridge-unifi-protect2` is a [Homebridge](https://homebridge.io) plugin that provides HomeKit support to the [UniFi Protect](https://unifi-network.ui.com/video-security) device ecosystem. [UniFi Protect](https://unifi-network.ui.com/video-security) is [Ubiquiti's](https://www.ui.com) next-generation video security platform, with rich camera, doorbell, and NVR controller hardware options for you to choose from, as well as an app which you can use to view, configure and manage your video camera and doorbells.

### Autoconfiguration
This plugin will attempt to autoconfigure all devices it detects attached to a UniFi Protect controller in order to create a more seamless end user experience. In order to do so, the UniFi Protect controller user that you configure this plugin to use will require the Administrator role enabled. Enabling the administrator role is *optional* and only required if you want this plugin to configure your UniFi Protect controller to make all RTSP streams available. You can also choose to manually enable all RTSP streams on all cameras yourself, if you prefer.

Why is enabling all RTSP streams a good idea? In short - it's free and gives you optionality later, should you choose to use it. For this plugin to work correctly, you will need to enable at least one RTSP stream on each camera you want to see in HomeKit. There's really no good reason not to enable all the RTSP streams, which just gives you more flexibility in the stream quality you have available to use, should you choose to do so. Unless you are actively streaming multiple streams at once from a camera, you aren't negatively impacting that camera's performance.

Which leads to the final point on autoconfiguration - ***sane*** defaults. [This plugin's north star](https://github.com/hjdhjd/homebridge-unifi-protect2#readme) is to make it as easy and seamless to integrate with HomeKit as possible in order to provide a terrific user experience -- and that includes great video streaming performance. By default, this plugin prioritizes configuring each camera's streaming quality by understanding HomeKit's limitations and selecting a stream that provides a reasonable balance between quality and speed of stream startup.

For example, we default the UVC G4 Pro camera to a medium quality stream (1280x720 in this case) rather than using the high quality stream (3840x2160). **The reason for this is that HomeKit only supports streams of up to 1920x1080 (aka 1080p) as of iOS 13**, and in my testing, having ffmpeg try to handle reencoding a stream with that much data to a lower quality results in a jittery and unsatisfying camera streaming experience in HomeKit. The table below lists the current autoconfiguration defaults:

| Camera Model           | Quality Defaults
|------------------------|------------------
| UVC G4 Pro             | Medium, Low, High
| UVC G4 Bullet          | Medium, Low, High
| All others             | High, Medium, Low

Of course, you can override any of the defaults to your liking (see [feature options](https://github.com/hjdhjd/homebridge-unifi-protect2/blob/master/docs/FeatureOptions.md) for more detail).

