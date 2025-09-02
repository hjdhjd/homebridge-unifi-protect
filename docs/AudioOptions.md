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
The noise filter [feature option](https://github.com/hjdhjd/homebridge-unifi-protect/blob/main/docs/FeatureOptions.md#audio) applies a filter to the audio that comes from a Protect camera. Specifically, it tries to enhance human voices and filter out other background noise. The defaults have been carefully tuned for outdoor environments where wind and environmental noise can be significant factors, especially given that Protect cameras don't tend to have any meaningful noise suppression built in.

First, and foremost - **this filter is not magic. Don't expect magical results.** It can help, and when tuned for your environment, can help quite a bit. The defaults are now more conservative and practical, focusing on real-world outdoor performance rather than aggressive noise reduction that might distort voices. So how does this all work?

Human voices transmit sound between the frequencies of [300 Hz and 3400 Hz](https://en.wikipedia.org/wiki/Voice_frequency). In practice, the range is even smaller, but I'll leave that to audio engineers and your own curiosity searching online. Protect cameras have reasonably sensitive microphones. They tend to pickup a lot of the environmental noise, in addition to the stuff you might be really interested in. What if you could filter out the other noise and emphasize human voices without making everything sound like you're talking through a tin can?

`homebridge-unifi-protect` uses the FFmpeg [afftdn](https://ffmpeg.org/ffmpeg-filters.html#afftdn), [highpass](https://ffmpeg.org/ffmpeg-filters.html#highpass) and [lowpass](https://ffmpeg.org/ffmpeg-filters.html#lowpass) audio filters. There are other noise-reduction filters available in FFmpeg, however they either require special compilation options, or have substantial complexity in their setup that in practice, doesn't work much better than this tried-and-true combination of the modern FFT-based noise reduction coupled with the highpass and lowpass FFmpeg audio filters. The new defaults enable all three filters by default for a balanced approach to noise reduction.

##### <A NAME="noise-filter"></A>Enabling the Noise Filter
Enabling the audio filter for ambient noise suppression under the Audio section of the HBUP feature options webUI will enable the noise filter with the following default settings:

| Audio Noise Filter     | Default Setting                   | Purpose
|------------------------|-----------------------------------|----------------------------------
| Afftdn                 | 14 decibels of noise reduction    | Moderate noise reduction that preserves voice clarity
| HighPass               | 150 Hz                            | Removes low-frequency rumble and wind noise
| LowPass                | 9000 Hz                           | Preserves voice clarity while reducing high-frequency hiss

These defaults represent a significant shift from previous versions. Why the change? Real-world testing showed that aggressive noise reduction (like 90 dB) often made voices sound robotic or underwater, especially in outdoor environments. The new 14 dB default for afftdn provides meaningful noise reduction while preserving natural voice characteristics. Think of it as the difference between a sledgehammer and a scalpel - sometimes less is more.

##### Afftdn
Afftdn is a modern noise audio filter that uses fast Fourier transforms (FFTs) to achieve very good background noise reduction results. Here's the intriguing bit: when your camera stream starts, the afftdn filter spends the first couple of seconds listening to your environment. During this sampling period (specifically between 1 and 3 seconds after the stream starts), it's building a noise profile of your specific environment - learning what the ambient noise sounds like when no one is speaking. This allows it to create a custom-tuned model for your particular location, whether that's the constant hum of nearby traffic, the rustle of leaves, or the drone of an AC unit. After this initial learning phase, it uses that profile to intelligently reduce similar noise throughout the rest of the stream.

The default setting of 14 decibels strikes a balance between reducing ambient noise and preserving the natural quality of human voices. This is particularly effective for outdoor cameras where you're dealing with wind, traffic, and other environmental sounds. The beauty of this approach is that the filter adapts to your specific environment rather than applying a one-size-fits-all solution. That wind pattern unique to your backyard? The filter learns it. The HVAC that runs all summer? It figures that out too.

If you'd like to adjust the noise reduction settings, you can do so using the [`Audio.Filter.Noise.FftNr` feature option](https://github.com/hjdhjd/homebridge-unifi-protect/blob/main/docs/FeatureOptions.md#audio) feature option. Valid values range from 0.01 to 97 decibels. Lower values (like our default 14) provide subtle noise reduction, while higher values can be more aggressive but may introduce artifacts or make voices sound processed. If you're in a particularly noisy environment, you might try values between 20-30, but be prepared to dial it back if voices start sounding unnatural. Remember though, the initial sampling period means the filter needs those first few seconds to be effective - so if someone starts talking immediately when motion is detected, those first couple of seconds won't have the full benefit of noise reduction. You can read more about the [afftdn audio filter](https://ffmpeg.org/ffmpeg-filters.html#afftdn) in the FFmpeg documentation.

##### HighPass
The `highpass` audio filter attenuates (eliminates) frequencies below a given frequency. What're low-frequency sounds? Often times it's that rumbly background noise you may have in your area - think wind buffeting against your camera, distant traffic, or HVAC systems. The higher the `highpass` frequency value, the less of that low-frequency noise you'll have. The problem, of course, is if that number is too high, you start to interfere with the very human voices you're trying to preserve.

The highpass filter is now enabled by default with a value of `150 Hz`. This is a conservative setting that effectively removes wind rumble and low-frequency environmental noise while preserving the natural bass in human voices. The previous default of 200 Hz was a bit too aggressive for some voices, particularly male voices. At 150 Hz, you're filtering out the truly unwanted stuff while keeping voices sounding natural. If you're in a particularly windy location, you might experiment with values up to 200 Hz, but be aware that some voices might start to sound thin.

You can adjust this value using the highpass filter option in the ambient noise suppression setting within the Audio section of the HBUP feature options webUI. If you set this to null or undefined in your configuration, the filter will be disabled entirely.

##### LowPass
The `lowpass` audio filter attenuates (eliminates) frequencies above a given frequency. What're high-frequency sounds? Often times it's that background hiss, electronic interference, or the high-pitched whine of certain environmental sounds. The lower the `lowpass` frequency value, the less of that high-frequency noise you'll have. The problem, of course, is if that number is too low, you start to interfere with the clarity and presence of human voices.

The lowpass filter is now enabled by default with a value of `9000 Hz`. This is a much higher (and more practical) setting than the previous 1000 Hz default. Why the dramatic change? Well, it turns out that cutting off everything above 1000 Hz makes everyone sound like they're talking through a pillow. The human voice, especially consonants and sibilants that are crucial for understanding speech, extends well beyond 1000 Hz. The new 9000 Hz default preserves voice clarity and intelligibility while still filtering out ultra-high frequency noise that's typically not part of human speech.

You can adjust this value using the lowpass filter option in the ambient noise suppression setting within the Audio section of the HBUP feature options webUI. For indoor environments with less environmental noise, you might even disable this filter entirely by setting it to null. For particularly noisy environments, you could try values around 6000-7000 Hz, but monitor the results carefully to ensure voice clarity isn't compromised.

##### Fine-Tuning for Your Environment
The new defaults are optimized for outdoor cameras dealing with typical environmental challenges like wind, traffic, and weather. If you're using cameras indoors, you might find you can use even lighter settings or disable some filters entirely. Remember, the goal is clear, natural-sounding audio - not the most aggressive noise reduction possible. Start with the defaults, and only adjust if you're hearing specific issues. Your ears are the best judge of what sounds right in your particular environment.
