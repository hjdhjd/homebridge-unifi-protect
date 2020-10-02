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

### Audio Options
Audio options allow you to tune certain aspects of the audio that comes out of UniFi Protect cameras. They are configured as [Feature Options](https://github.com/hjdhjd/homebridge-unifi-protect/blob/master/docs/FeatureOptions.md), which means you have the same flexibility in being able to apply specific audio options to only certain cameras, or globally across all your Protect cameras in HomeKit.

#### Noise Filter
The noise filter [feature option](https://github.com/hjdhjd/homebridge-unifi-protect/blob/master/docs/FeatureOptions.md) applies a filter to the audio that comes from a Protect camera. Specifically, it tries to enhance human voices and filter out other background noise.

First, and foremost - **this filter is not magic. Don't expect magical results.** It can help, and when tuned for your environment, can help quite a bit. So how does this all work?

Human voices transmit sound between the frequencies of [300 Hz and 3400 Hz](https://en.wikipedia.org/wiki/Voice_frequency). In practice, the range is even smaller, but I'll leave that to audio engineers and your own curiosity searching online. Protect cameras have reasonably sensitive microphones. They tend to pickup a lot of the environmental noise, in addition to the stuff you might be really interested in. What if you could filter out the other noise and emphasize human voices?

`homebridge-unifi-protect` uses the FFmpeg [highpass](https://ffmpeg.org/ffmpeg-filters.html#highpass) and [lowpass](https://ffmpeg.org/ffmpeg-filters.html#lowpass) audio filters. There are other noise-reduction filters available in FFmpeg, however they either require special compilation options, or have substantial complexity in their setup that in practice, doesn't work better than the tried-and-true highpass and lowpass FFmpeg audio filters.

##### <A NAME="noise-filter"></A>Enabling the Noise Filter
Enabling the feature option `NoiseFilter` will enable the noise filter with the following default settings:

| Audio Noise Filter     | Setting
|------------------------|----------------------------------
| HighPass               | 200 Hz
| LowPass                | 1000 Hz

You can further tailor the defaults either globally or by camera, by looking at the [NoiseFilter.HighPass](#highpass) and [NoiseFilter.LowPass](#lowpass) feature options.

##### HighPass
The `highpass` audio filter attenuates (eliminates) frequencies below a given frequency. What're low-frequency sounds? Often times it's that rumbly background noise you may have in your area. The higher the `highpass` frequency value, the less of that low-frequency noise you'll have. The problem, of course, is if that number is too high, you start to interfere with the very human voices you're trying to enhance or preserve.

When you enable the `NoiseFilter` feature option in `homebridge-unifi-protect`, the default `highpass` value will be `200 Hz`. That means that sounds below `200 Hz` will be filtered out. This may work very well in your environment, or it may need further adjustment. Experiment and see what works best for you.

To adjust this setting, first enable the [noise filter](#noise-filter) [feature option](https://github.com/hjdhjd/homebridge-unifi-protect/blob/master/docs/FeatureOptions.md). To customize the `highpass` audio filter, you can use the `NoiseFilter.HighPass` feature option. For example:

```
Enable.NoiseFilter.HighPass.400
```
This will set the `highpass` filter frequency to 400 Hz globally.

##### LowPass
The `lowpass` audio filter attenuates (eliminates) frequencies above a given frequency. What're high-frequency sounds? Often times it's that background noise or environmental hiss. The lower the `lowpass` frequency value, the less of that high-frequency noise you'll have. The problem, of course, is if that number is too low, you start to interfere with the very human voices you're trying to enhance or preserve.

When you enable the `NoiseFilter` feature option in `homebridge-unifi-protect`, the default `lowpass` value will be `1000 Hz`. That means that sounds above `1000 Hz` will be filtered out. This may work very well in your environment, or it may need further adjustment. Experiment and see what works best for you.

To adjust this setting, first enable the [noise filter](#noise-filter) [feature option](https://github.com/hjdhjd/homebridge-unifi-protect/blob/master/docs/FeatureOptions.md). To customize the `lowpass` audio filter, you can use the `NoiseFilter.LowPass` feature option. For example:

```
Enable.NoiseFilter.LowPass.AABBCCDDEEFF.2000
```
This will set the `lowpass` filter frequency to 2000 Hz for the camera with the MAC address of `AABBCCDDEEFF`.
