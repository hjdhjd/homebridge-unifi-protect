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

### Advanced Configuration (Optional)

This step is not required. The defaults should work well for almost everyone, but for those that prefer to tweak additional settings, this is the complete list of settings available.

```js
"platforms": [
  {
    "platform": "UniFi Protect",
    "videoProcessor": "/usr/local/bin/ffmpeg",
    "ffmpegOptions": [
      "-tune",
      "zerolatency"
    ]
    "motionDuration": 10,
    "verboseFfmpeg": false,

    "options": [
      "Disable.Stream.High"
    ],

    "controllers": [
      {
        "name": "My UniFi Protect Controller",
        "address": "1.2.3.4",
        "username": "some-homebridge-user (or create a new one just for homebridge)",
        "password": "some-password",
        "doorbellMessages": [
          {
             "message": "Be right there.",
             "duration": 90
          }
        ],
        "refreshInterval": 5,
        "mqttUrl": "mqtt://test.mosquitto.org",
        "mqttTopic": "unifi/protect"
      }
    ]
  }
]
```

| Fields                 | Description                                             | Default                                                                               | Required |
|------------------------|---------------------------------------------------------|---------------------------------------------------------------------------------------|----------|
| platform               | Must always be `UniFi Protect`.                         | UniFi Protect                                                                         | Yes      |
| address                | Host or IP address of your UniFi Protect controller.    |                                                                                       | Yes      |
| username               | Your UniFi Protect username.                            |                                                                                       | Yes      |
| password               | Your UniFi Protect password.                            |                                                                                       | Yes      |
| doorbellMessages       | Configure [doorbell messages](https://github.com/hjdhjd/homebridge-unifi-protect/blob/master/docs/Doorbell.md) for your UniFi Protect controller. | [] | No |
| videoProcessor         | Specify path of ffmpeg or avconv.                       | "ffmpeg"                                                                              | No       |
| ffmpegOptions          | Additional parameters to pass ffmpeg to render video.   |                                                                                       | No       |
| ffmpegEncoder          | Specify FFmpeg encoder for use with transcoding. | libx264 | No       |
| motionDuration         | Duration of motion events. Setting this too low will potentially cause a lot of notification spam. | 10                                         | No       |
| refreshInterval        | Interval, in seconds, to check UniFi Protect for new or removed devices. | 10                                                                   | No       |
| options                | Configure plugin [feature options](https://github.com/hjdhjd/homebridge-unifi-protect/blob/master/docs/FeatureOptions.md).   | []               | No       |
| name                   | Controller name to use for homebridge logging purposes. | UniFi Protect controller name                                                         | No       |
| mqttUrl                | The URL of your MQTT broker. **This must be in URL form**, e.g.: `mqtt://user:password@1.2.3.4`. |                                              | No       |
| mqttTopic              | The base topic to use when publishing MQTT messages.    | "unifi/protect"                                                                       | No       |
| verboseFfmpeg          | Enable additional logging for video streaming.          | false                                                                                 | No       |
