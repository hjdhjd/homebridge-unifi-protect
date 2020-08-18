<SPAN ALIGN="CENTER">

[![homebridge-unifi-protect2: Native HomeKit support for UniFi Protect](https://raw.githubusercontent.com/hjdhjd/homebridge-unifi-protect2/master/homebridge-protect.svg)](https://github.com/hjdhjd/homebridge-unifi-protect2)

# Homebridge UniFi Protect<SUP STYLE="font-size: smaller; color:#5EB5E6;">2</SUP>

[![Downloads](https://img.shields.io/npm/dt/homebridge-unifi-protect2?color=%235EB5E6&style=for-the-badge)](https://www.npmjs.com/package/homebridge-unifi-protect2)
[![Version](https://img.shields.io/npm/v/homebridge-unifi-protect2?color=%235EB5E6&label=UniFi%20Protect%202&logo=apple&logoColor=%235EB5E6&style=for-the-badge)](https://www.npmjs.com/package/homebridge-unifi-protect2)
[![verified-by-homebridge](https://img.shields.io/badge/homebridge-verified-blueviolet?style=for-the-badge)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)

## HomeKit support the UniFi Protect ecosystem using [Homebridge](https://homebridge.io).
</SPAN>

`homebridge-unifi-protect2` is a [Homebridge](https://homebridge.io) plugin that provides HomeKit support to the [UniFi Protect](https://unifi-network.ui.com/video-security) device ecosystem. [UniFi Protect](https://unifi-network.ui.com/video-security) is [Ubiquiti's](https://www.ui.com) next-generation video security platform, with rich camera, doorbell, and NVR controller hardware options for you to choose from, as well as an app which you can use to view, configure and manage your video camera and doorbells.

### Advanced Configuration (Optional)
This step is not required. The defaults should work well for almost everyone, but for those that prefer to tweak additional settings, this is the complete list of settings available.

```js
"platforms": [
  {
    "platform": "UniFi Protect",
    "videoProcessor": "/usr/local/bin/ffmpeg",
    "ffmpegOptions": "-preset ultrafast -tune zerolatency",
    "motionDuration": 10,
    "debug": false,

    "options": [
      "Disable.Stream.High"
    ],

    "controllers": [
      {
        "name": "My UniFi Protect Controller",
        "address": "1.2.3.4",
        "username": "some-homebridge-user (or create a new one just for homebridge)",
        "password": "some-password",
        "refreshInterval": 5,
        "mqttUrl": "mqtt://test.mosquitto.org",
        "mqttTopic": "unifi/protect"
      }
    ],
  }
]
```

| Fields                 | Description                                             | Default                                                                               | Required |
|------------------------|---------------------------------------------------------|---------------------------------------------------------------------------------------|----------|
| platform               | Must always be `UniFi Protect`.                         | UniFi Protect                                                                         | Yes      |
| address                | Host or IP address of your UniFi Protect controller     |                                                                                       | Yes      |
| username               | Your UniFi Protect username.                            |                                                                                       | Yes      |
| password               | Your UniFi Protect password.                            |                                                                                       | Yes      |
| videoProcessor         | Specify path of ffmpeg or avconv.                       | "ffmpeg"                                                                              | No       |
| ffmpegOptions          | Additional parameters to pass ffmpeg to render video.   | "-probesize 32 -analyzeduration 0 -fflags nobuffer -strict experimental"              | No       |
| motionDuration         | Duration of motion events. Setting this too low will potentially cause a lot of notification spam. | 10                                         | No       |
| refreshInterval        | Interval to check UniFi Protect for new or removed devices. On UCKGen2+ controllers **only**, also sets the polling interval for motion events. | 10 seconds for UniFi OS, 5 seconds for UCK Gen2+ | No       |
| options                | Configure plugin [feature options](https://github.com/hjdhjd/homebridge-unifi-protect2/blob/master/docs/FeatureOptions.md).   | []      | No       |
| name                   | Controller name to use for homebridge logging purposes. | UniFi Protect controller name                                                         | No       |
| mqttUrl                | The URL of your MQTT broker. **This must be in URL form**, e.g.: `mqtt://user@password:1.2.3.4`. |                                              | No       |
| mqttTopic              | The base topic to use when publishing MQTT messages.    | "unifi/protect"                                                                       | No       |
| debug                  | Enable additional debug logging.                        | no                                                                                    | No       |
