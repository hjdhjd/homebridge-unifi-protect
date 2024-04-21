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

### Audio Options
Audio options allow you to tune certain aspects of the audio that comes out of UniFi Protect cameras. They are configured as [Feature Options](https://github.com/hjdhjd/homebridge-unifi-protect/blob/main/docs/FeatureOptions.md) in the HBUP webUI, which means you have the same flexibility in being able to apply specific audio options to only certain cameras, or globally across all your Protect cameras in HomeKit.

#### Noise Filter
The noise filter [feature option](https://github.com/hjdhjd/homebridge-unifi-protect/blob/main/docs/FeatureOptions.md#audio) applies a filter to the audio that comes from a Protect camera. Specifically, it tries to enhance human voices and filter out other background noise.

First, and foremost - **this filter is not magic. Don't expect magical results.** It can help, and when tuned for your environment, can help quite a bit. So how does this all work?

Human voices transmit sound between the frequencies of [300 Hz and 3400 Hz](https://en.wikipedia.org/wiki/Voice_frequency). In practice, the range is even smaller, but I'll leave that to audio engineers and your own curiosity searching online. Protect cameras have reasonably sensitive microphones. They tend to pickup a lot of the environmental noise, in addition to the stuff you might be really interested in. What if you could filter out the other noise and emphasize human voices?

`homebridge-unifi-protect` uses the FFmpeg [afftdn](https://ffmpeg.org/ffmpeg-filters.html#afftdn), [highpass](https://ffmpeg.org/ffmpeg-filters.html#highpass) and [lowpass](https://ffmpeg.org/ffmpeg-filters.html#lowpass) audio filters. There are other noise-reduction filters available in FFmpeg, however they either require special compilation options, or have substantial complexity in their setup that in practice, doesn't work much better than this tritried-and-true  combination of the modern FFT-based noise reduction optionally coupled with the highpass and lowpass FFmpeg audio filters.

##### <A NAME="noise-filter"></A>Enabling the Noise Filter
Enabling the audio filter for ambient noise suppression under the Audio section of the HBUP feature options webUI will enable the noise filter with the following default setting:

| Audio Noise Filter     | Setting
|------------------------|----------------------------------
| Afftdn                 | 90 decibels of noise reduction

Afftdn is a modern noise audio filter that uses fast Fourier transforms (FFTs) to achieve very good background noise reduction results. If you'd like to further adjust the default noise reduction settings, you can do so using the [`Audio.Filter.Noise.FftNr` feature option](https://github.com/hjdhjd/homebridge-unifi-protect/blob/main/docs/FeatureOptions.md#audio) feature option, where you can tailor the number of decibels of background noise reduction you'd like.

The default in HBUP is 90 decibels. Valid values are from 0.01 to 97 and you can adjust the number in the HBUP webUI. You can read more about the [afftdn audio filter](https://ffmpeg.org/ffmpeg-filters.html#afftdn) in the FFmpeg documentation.

If you'd like to enable even more background noise reduction, you can also add the `highpass` and `lowpass` filters. These also provide good additional noise reduction and are additive to the `afftdn` audio filter and can be used in any combination along with the `afftdn` filter. The default settings for these audio filters are:

| Audio Noise Filter     | Setting
|------------------------|----------------------------------
| HighPass               | 200 Hz
| LowPass                | 1000 Hz

You can further tailor the defaults either globally or by camera, by looking at the high pass and low pass feature options under the Audio section of the HBUP feature options webUI.

##### HighPass
The `highpass` audio filter attenuates (eliminates) frequencies below a given frequency. What're low-frequency sounds? Often times it's that rumbly background noise you may have in your area. The higher the `highpass` frequency value, the less of that low-frequency noise you'll have. The problem, of course, is if that number is too high, you start to interfere with the very human voices you're trying to enhance or preserve.

If you want to enable the `highpass` filter in addition to the `afftdn` filter above, use the HBUP feature options webUI and enable the highpass filter in the ambient noise suppression setting within the Audio section. The default `highpass` value will be `200 Hz`. That means that sounds below `200 Hz` will be filtered out. This may work very well in your environment, or it may need further adjustment. Experiment and see what works best for you.

##### LowPass
The `lowpass` audio filter attenuates (eliminates) frequencies above a given frequency. What're high-frequency sounds? Often times it's that background noise or environmental hiss. The lower the `lowpass` frequency value, the less of that high-frequency noise you'll have. The problem, of course, is if that number is too low, you start to interfere with the very human voices you're trying to enhance or preserve.

If you want to enable the `lowpass` filter in addition to the `afftdn` filter above, use the HBUP feature options webUI and enable the highpass filter in the ambient noise suppression setting within the Audio section. The default `lowpass` value will be `1000 Hz`. That means that sounds above `1000 Hz` will be filtered out. This may work very well in your environment, or it may need further adjustment. Experiment and see what works best for you.
