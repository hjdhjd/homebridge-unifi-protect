# homebridge-unifi-protect2

Unifi Protect plarform plugin for [Homebridge](https://github.com/nfarina/homebridge)

This plugin is intended to automatically configure all the cameras you have setup in UniFi Protect to make them available via HomeKit. It supports
UniFi CloudKey Gen2+ and UniFi Dream Machine Pro and should support any device that can run UniFi Protect. It requires the
[camera-ffmpeg](https://github.com/KhaosT/homebridge-camera-ffmpeg) plugin in order to provide that functionality.

This package is based on the excellent work of [homebridge-camera-unifi](https://github.com/ptescher/homebridge-camera-unifi).

# Why use this homebridge plugin?

This plugin aims to be a one-stop-shop for UniFi Protect to HomeKit connectivity. Over time, it is my hope to add motion sensors and
any other capabilities that make sense to this plugin to enable HomeKit users to easily connect the UniFi Protect and HomeKit worlds.

# What's new?

* UniFi Dream Machine Pro (UniFiOS support)

# What's not in this plugin right now

* Support for motion detection and motion events. I would love to add this functionality but most of the approaches to implementing this right now involve hacks like
monitoring the logs in reealtime on Protect and trying to parse what it's telling us on the motion front. Additionally, with the developmeent and evolution of
motion detection on Protect right now (circa early-mid 2020) makes this a moving target. TL;DR: it's on the radar, but I'm waiting until there are better options to
implementing this in a reasonable way.

# Installation
If you are new to Homebridge, please first read the Homebridge [documentation](https://www.npmjs.com/package/homebridge).
If you are running on a Raspberry, you will find a tutorial in the [homebridge-punt Wiki](https://github.com/cflurin/homebridge-punt/wiki/Running-Homebridge-on-a-Raspberry-Pi).

Install homebridge:
```sh
sudo npm install -g --unsafe-perm homebridge
```
Install homebridge-camera-ffmpeg:
```sh
sudo npm install -g --unsafe-perm homebridge-camera-ffmpeg
```
Install homebridge-unifi-protect2:
```sh
sudo npm install -g homebridge-unifi-protect2
```

You will need a working ffmpeg installation for this plugin to work. Configuring ffmpeg is beyond the scope of this manual. Please refer to the
excellent documentation for [camera-ffmpeg](https://github.com/KhaosT/homebridge-camera-ffmpeg).

## Adding your cameras using the Home app

###TL;DR
Adding cameras requires the same steps outlined in homebridge-camera-ffmpeg. Install the accessories and use the Homebridge setup code for the
camera accessories.

###Longer version
After restarting Homebridge, each camera you defined will need to be manually paired in the Home app, to do this:

1. Open the Home <img src="https://user-images.githubusercontent.com/3979615/78010622-4ea1d380-738e-11ea-8a17-e6a465eeec35.png" height="16.42px"> app on your device.
2. Tap the Home tab, then tap <img src="https://user-images.githubusercontent.com/3979615/78010869-9aed1380-738e-11ea-9644-9f46b3633026.png" height="16.42px">.
3. Tap *Add Accessory*, and select *I Don't Have a Code or Cannot Scan*.
4. Select the Camera you want to pair.
5. Enter the Homebridge PIN, this can be found under the QR code in Homebridge UI or your Homebridge logs, alternatively you can select *Use Camera* and scan the QR code again.

# Configuration
Add the platform in `config.json` in your home directory inside `.homebridge`.

```js
"platforms": [
  {
    "platform": "Camera-UniFi-Protect",
    "name": "UniFi Protect",

    "controllers": [
      {
        "url": "https://my-cloud-key:7443/",
        "username": "some-homebridge-user (or create a new one just for homebridge)",
        "password": "some-password"
      }
    ]
  }
]
```

### Advanced Configuration (Optional)
This step is not required. For those that prefer to tailor the defaults to their liking, here are the supported parameters.

```
"platforms": [
  {
    "platform": "Camera-UniFi-Protect",
    "name": "UniFi Protect",
    "videoProcessor" : "/usr/local/bin/ffmpeg",

    "controllers": [
      {
        "url": "https://my-cloud-key:7443/",
        "username": "some-homebridge-user (or create a new one just for homebridge)",
        "password": "some-password"
      }
    ],

    "videoConfig": {
        "sourcePrefix": "-re -rtsp_transport http",
        "additionalCommandline": "-preset slow -profile:v high -level 4.2 -x264-params intra-refresh=1:bframes=0",
        "mapaudio": "0:0",
        "mapvideo": "0:1",
        "maxStreams": 4,
        "maxWidth": 1920,
        "maxHeight": 1080,
        "maxFPS": 20
    } 
  }
]
```

| Fields                 | Description                                             | Default                                                                               | Required |
|------------------------|---------------------------------------------------------|---------------------------------------------------------------------------------------|----------|
| platform               | Must always be `Camera-UniFi-Protect`.                  |                                                                                       | Yes      |
| name                   | For logging purposes.                                   |                                                                                       | No       |
| videoProcessor         | Specify path of ffmpeg or avconv                        | "ffmpeg"                                                                              | No       |
| url                    | URL for UniFi CloudKey G2+                              |                                                                                       | Yes      |
| username               | Your UniFi Protect username                             |                                                                                       | Yes      |
| password               | Your UniFi Protect password                             |                                                                                       | Yes      |
| sourcePrefix           | Prefix to apply to ffmpeg source command.               | "-re -rtsp_transport http"                                                            | No       |
| additionalCommandline  | Additional parameters to pass ffmpeg to render video.   | "-preset slow -profile:v high -level 4.2 -x264-params intra-refresh=1:bframes=0"      | No       |
| mapaudio               | Mapping of audio channels for ffmpeg.                   | "0:0"                                                                                 | No       |
| mapvideo               | Mapping of video channels for ffmpeg.                   | "0:1"                                                                                 | No       |
| maxStreams             | Maximum number of streams allowed for a camera.         | 4                                                                                     | No       |
| maxWidth               | Maximum width of a video stream allowed.                | 1920                                                                                  | No       |
| maxHeight              | Maximum height of a video stream allowed.               | 1080                                                                                  | No       |
| maxFPS                 | Maximum framerate for a video stream.                   | 20                                                                                    | No       |

