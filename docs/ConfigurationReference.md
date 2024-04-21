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

### Configuration Reference

This is a complete reference of the HBUP settings JSON. The defaults should work well for almost everyone and configuration of this plugin should be done exclusively within the HBUP webUI and not manually editing JSONs which can be error-prone and lead to undesired behavior.

```js
"platforms": [
  {
    "platform": "UniFi Protect",
    "videoProcessor": "/usr/local/bin/ffmpeg",
    "ffmpegOptions": [
    ]
    "verboseFfmpeg": false,

    "options": [
      "Disable.Video.Stream.High"
    ],

    "controllers": [
      {
        "name": "My UniFi Protect Controller",
        "address": "1.2.3.4",
        "addressOverride": "a.b.c.d",
        "username": "some-homebridge-user (or create a new one just for homebridge)",
        "password": "some-password",
        "doorbellMessages": [
          {
             "message": "Be right there.",
             "duration": 90
          }
        ],
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
| addressOverride        | Override the address used when HBUP accesses camera URLs.|                                                                                      | No       |
| doorbellMessages       | Configure [doorbell messages](https://github.com/hjdhjd/homebridge-unifi-protect/blob/main/docs/Doorbell.md) for your UniFi Protect controller. | [] | No |
| videoProcessor         | Specify path of ffmpeg or avconv.                       | "ffmpeg"                                                                              | No       |
| ffmpegOptions          | Additional parameters to pass ffmpeg to render video.   |                                                                                       | No       |
| options                | Configure plugin [feature options](https://github.com/hjdhjd/homebridge-unifi-protect/blob/main/docs/FeatureOptions.md).   | []                 | No       |
| name                   | Controller name to use for homebridge logging purposes. | UniFi Protect controller name                                                         | No       |
| mqttUrl                | The URL of your MQTT broker. **This must be in URL form**, e.g.: `mqtt://user:password@1.2.3.4`. |                                              | No       |
| mqttTopic              | The base topic to use when publishing MQTT messages.    | "unifi/protect"                                                                       | No       |
| verboseFfmpeg          | Enable additional logging for video streaming.          | false                                                                                 | No       |
