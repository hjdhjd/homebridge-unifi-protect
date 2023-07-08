<SPAN ALIGN="CENTER" STYLE="text-align:center">
<DIV ALIGN="CENTER" STYLE="text-align:center">

[![homebridge-unifi-protect: Native HomeKit support for UniFi Protect](https://raw.githubusercontent.com/hjdhjd/homebridge-unifi-protect/main/images/homebridge-unifi-protect.svg)](https://github.com/hjdhjd/homebridge-unifi-protect)

# Homebridge UniFi Protect

[![Downloads](https://img.shields.io/npm/dt/homebridge-unifi-protect?color=%230559C9&logo=icloud&logoColor=%23FFFFFF&style=for-the-badge)](https://www.npmjs.com/package/homebridge-unifi-protect)
[![Version](https://img.shields.io/npm/v/homebridge-unifi-protect?color=%230559C9&label=Homebridge%20UniFi%20Protect&logo=ubiquiti&logoColor=%23FFFFFF&style=for-the-badge)](https://www.npmjs.com/package/homebridge-unifi-protect)
[![UniFi Protect@Homebridge Discord](https://img.shields.io/discord/432663330281226270?color=0559C9&label=Discord&logo=discord&logoColor=%23FFFFFF&style=for-the-badge)](https://discord.gg/QXqfHEW)
[![verified-by-homebridge](https://img.shields.io/badge/homebridge-verified-blueviolet?color=%23491F59&style=for-the-badge&logoColor=%23FFFFFF&logo=homebridge)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)

## HomeKit support for the UniFi Protect ecosystem using [Homebridge](https://homebridge.io).
</DIV>
</SPAN>

`homebridge-unifi-protect` is a [Homebridge](https://homebridge.io) plugin that provides HomeKit support to the [UniFi Protect](https://unifi-network.ui.com/video-security) device ecosystem. [UniFi Protect](https://unifi-network.ui.com/video-security) is [Ubiquiti's](https://www.ui.com) video security platform, with rich camera, doorbell, and NVR controller hardware options for you to choose from, as well as an app which you can use to view, configure and manage your video camera and doorbells.

### Autoconfiguration

This plugin will attempt to autoconfigure all devices it detects attached to a UniFi Protect controller in order to create a more seamless end user experience. In order to do so, the UniFi Protect controller user that you configure this plugin to use will require the Administrator role enabled. Enabling the administrator role is *optional* and only required if you want this plugin to configure your UniFi Protect controller to make all RTSP streams available. You can also choose to manually enable all RTSP streams on all cameras yourself, if you prefer.

Why is enabling all RTSP streams a good idea? In short - it's free and gives you optionality when `homebridge-unifi-protect` tries to find the best RTSP streaming profile to use for a given HomeKit streaming request. For this plugin to work correctly, you will need to enable at least one RTSP stream on each camera that you want to see in HomeKit. There's really no good reason not to enable all the RTSP streams - it provides flexibility in the stream quality that's available to use, which you can further tailor in a granular way using feature options. Unless you are actively streaming multiple streams at once from a camera, you will not be negatively impacting that camera's performance.

Which leads to the final point on autoconfiguration - ***sane*** defaults. [This plugin's north star](https://github.com/hjdhjd/homebridge-unifi-protect#readme) is to make it as easy and seamless to integrate with HomeKit as possible in order to provide a terrific user experience -- and that includes great video streaming performance. By default, this plugin dynamically selects the best streaming quality to use by understanding HomeKit's limitations and using the RTSP profile (High, Medium, or Low) that most closely resembles the quality being requested by the streaming client.

Of course, you can override which RTSP profiles are used in your specific environment. See [Feature Options](https://github.com/hjdhjd/homebridge-unifi-protect/blob/main/docs/FeatureOptions.md#video) for more detail.
