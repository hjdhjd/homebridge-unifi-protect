<SPAN ALIGN="CENTER" STYLE="text-align:center">
<DIV ALIGN="CENTER" STYLE="text-align:center">

[![homebridge-unifi-protect: Native HomeKit support for UniFi Protect](https://raw.githubusercontent.com/hjdhjd/homebridge-unifi-protect/main/images/homebridge-unifi-protect.svg)](https://github.com/hjdhjd/homebridge-unifi-protect)

# Homebridge UniFi Protect

[![Downloads](https://img.shields.io/npm/dt/homebridge-unifi-protect?color=%230559C9&logo=icloud&logoColor=%23FFFFFF&style=for-the-badge)](https://www.npmjs.com/package/homebridge-unifi-protect)
[![Version](https://img.shields.io/npm/v/homebridge-unifi-protect?color=%230559C9&label=Latest%20Version&logo=ubiquiti&logoColor=%23FFFFFF&style=for-the-badge)](https://www.npmjs.com/package/homebridge-unifi-protect)
[![UniFi Protect@Homebridge Discord](https://img.shields.io/discord/432663330281226270?color=0559C9&label=Discord&logo=discord&logoColor=%23FFFFFF&style=for-the-badge)](https://discord.gg/QXqfHEW)
[![verified-by-homebridge](https://img.shields.io/badge/homebridge-verified-blueviolet?color=%23491F59&style=for-the-badge&logoColor=%23FFFFFF&logo=homebridge)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)

## Complete HomeKit support for the UniFi Protect ecosystem using [Homebridge](https://homebridge.io).
</DIV>
</SPAN>

`homebridge-unifi-protect` is a [Homebridge](https://homebridge.io) plugin that provides HomeKit support to the [UniFi Protect](https://ui.com/camera-security) device ecosystem. [UniFi Protect](https://ui.com/camera-security) is [Ubiquiti's](https://www.ui.com) video security platform, with rich camera, doorbell, and NVR controller hardware options for you to choose from, as well as an app which you can use to view, configure and manage your video camera and doorbells.

### Protect Controller Autoconfiguration

This plugin autoconfigures the devices it finds on a UniFi Protect controller so that everything works as seamlessly as possible, with minimal effort on your part. Most of that comes down to one thing: making sure every camera has at least one RTSP stream enabled, which is what HomeKit ultimately needs.

You've got two ways to get there. Give the local user account you configure HBUP with the *full management role* in UniFi Protect, and HBUP will enable the RTSP streams for you...along with a handful of other niceties you can selectively turn on through feature options. That role is entirely optional, though. If you'd rather keep the account's permissions to a minimum, just enable at least one RTSP stream on each camera you want in HomeKit yourself, and you're all set.

Why enable all the RTSP streams? There's no performance penalty on the Protect controller for having them on, and it gives HBUP more quality levels to work with...which you can then tailor in a granular way through feature options. Whichever route you take, keep the one hard requirement in mind: at least one RTSP stream enabled on every camera you want to see in HomeKit.

### How HBUP Sources Your Video

By default, HBUP keeps a small rolling *timeshift buffer* of each camera's livestream...think of it as a few seconds of continuously updated video that's always ready to go. That single buffer feeds everything that needs your camera's video: your live views in the Home app, HomeKit Secure Video event recordings, and snapshots. Keeping one shared, always-warm buffer is what lets a live view start almost instantly, and it's what lets HKSV capture the moments *before* a motion event rather than starting cold. It's on by default.

The alternative is to stream each live view directly from the camera over RTSP, on demand. If you'd prefer that, disable the `Video.Timeshift.Livestream` feature option under the *Timeshift Buffer* section, and live views will come straight from the camera over RTSP instead. HomeKit Secure Video and snapshots keep using the buffer either way, so opting live views out of the buffer doesn't change how your events are recorded.

One caveat: a camera that streams AV1 can't use the direct-RTSP path...the bundled version of FFmpeg can't carry AV1 over RTSP. For an AV1 camera the buffer is the only way to get a live view, so leave `Video.Timeshift.Livestream` enabled (it is, by default). If you turn it off on an AV1 camera, HBUP will tell you exactly that in the log.

### Transcoding and Transmuxing

Consistent with the ethos of this plugin, HBUP always strives to combine the highest possible quality with the best performance the hardware it's running on can deliver.

Briefly:

* *Transcoding* involves a CPU-intensive conversion of a video stream from one format or quality level to another. It can be made significantly faster (with caveats and compromises) and less resource-intensive through the use of GPU hardware acceleration.
* *Transmuxing* involves repackaging a video stream from one container format to another. No change in format or quality occurs, and notably, it isn't a resource-intensive activity.

#### Customizing How HBUP Transcodes

HomeKit bitrates are notoriously conservative from a bandwidth and quality perspective...they're downright low, and can result in far less than ideal video quality. You can customize the bitrates HBUP uses for local and non-local streaming when transcoding through the appropriate [feature options](https://github.com/hjdhjd/homebridge-unifi-protect/blob/main/docs/FeatureOptions.md#video).

#### How HBUP Selects Stream Quality

Protect offers up to three stream qualities per camera - High, Medium, and Low. When HBUP transcodes, here's how it picks which one to draw from.

For live views:

* On a hardware-accelerated platform, HBUP starts from the highest-quality stream available...fixed-function hardware transcoders (most GPUs) simply do better work with more to chew on.
* On a platform without hardware acceleration, HBUP matches the quality being requested as closely as it can, with a slight bias toward going higher rather than lower, and hands that to the software transcoder.

For HomeKit Secure Video event recording:

* By default, HBUP feeds the buffer from the highest available stream quality, so your recordings start from the best source available before HomeKit does its own processing and compression.
* On pixel-constrained hardware like a Raspberry Pi, HBUP caps that source at 1080p, because the Pi's onboard transcoder struggles with very high bitrate streams.

#### Customizing Defaults

Everything above can be tailored to your environment and taste in the HBUP feature options webUI. Specifically, you can:

* Stream live views directly from the camera over RTSP instead of from the buffer. **Default: buffer-backed live viewing (`Video.Timeshift.Livestream`, on).**
* Transmux instead of transcode for local clients. **Default: transcode local clients.**
* Transmux instead of transcode for high-latency / remote clients. **Default: transcode high-latency / remote clients.**
* Force a specific Protect stream quality for direct-RTSP live views, using `Video.Rtsp.Only.High` / `Medium` / `Low`. **Default: HBUP decides, using the rules above.**
* Force the stream quality the timeshift buffer feeds from - the source HKSV, buffer-backed live views, and snapshots all draw on - using `Video.Timeshift.Only.High` / `Medium` / `Low`. **Default: the highest available quality.**

***In general, I'd discourage most people from changing these defaults unless they have a specific need to. But if you're reading this, you probably like to tinker. 😄 I've taken a lot of time and care to design these behaviors and defaults...they really do exist for good reasons.***
