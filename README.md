<SPAN ALIGN="CENTER">

[![homebridge-unifi-protect2: Native HomeKit support for UniFi Protect](https://raw.githubusercontent.com/hjdhjd/homebridge-unifi-protect2/master/homebridge-protect.svg)](https://github.com/hjdhjd/homebridge-unifi-protect2)

# Homebridge UniFi Protect<SUP STYLE="font-size: smaller; color:#5EB5E6;">2</SUP>

[![Downloads](https://badgen.net/npm/dt/homebridge-unifi-protect2)](https://www.npmjs.com/package/homebridge-unifi-protect2)
[![Version](https://badgen.net/npm/v/homebridge-unifi-protect2)](https://www.npmjs.com/package/homebridge-unifi-protect2)
[![verified-by-homebridge](https://badgen.net/badge/homebridge/verified/purple)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)

## HomeKit support the UniFi Protect ecosystem using [Homebridge](https://homebridge.io).
</SPAN>

`homebridge-unifi-protect2` is a [Homebridge](https://homebridge.io) plugin that provides HomeKit support to the [UniFi Protect](https://unifi-network.ui.com/video-security) device ecosystem. [UniFi Protect](https://unifi-network.ui.com/video-security) is [Ubiquiti's](https://www.ui.com) next-generation video security platform, with a rich camera, doorbell, and NVR set of options for you to choose from, as well as an app which you can use to view, configure and manage your video camera and doorbells.

This plugin attempts to bridge a gap in the UniFi Protect ecosystem by providing native HomeKit support on par with what you would expect from a first-party of native HomeKit solution. Our north star is to create a plugin that *just works* with minimal required configuration by you, the end user, to get up and running. The goal is to provide as close to a streamlined experience as you would expect from a first-party or native HomeKit solution. For the adventurous, there will be more granular options available to enable you to further tailor your experience.

What does *just works* mean in practice? It means that this plugin will discover all your supported UniFi Protect devices and make them available in HomeKit. It supports all known UniFi Protect NVR configurations (UniFi CloudKey Gen2+, UniFi Dream Machine Pro, and UniFi Protect NVR).

## What's not in this plugin right now

Support for motion detection and motion events. I would love to add this functionality but most of the approaches to implementing this right now involve hacks like monitoring the logs in realtime on Protect and trying to parse what it's telling us on the motion front. Additionally, the active development and evolution of motion detection on Protect right now (circa mid 2020) makes this a moving target. TL;DR: it's on the radar, but I'm waiting until there are better options to implementing this in a reasonable way.

## What's new?

* UniFi Dream Machine Pro and UniFi NVR support (UnifiOS support).
* Audio support (listen-only - no microphone support).

# Installation
If you are new to Homebridge, please first read the Homebridge [documentation](https://www.npmjs.com/package/homebridge).

Install homebridge if you haven't already done so:

```sh
sudo npm install -g --unsafe-perm homebridge
```

Install homebridge-unifi-protect2:

```sh
sudo npm install -g --unsafe-perm homebridge-unifi-protect2
```

You will need a working **ffmpeg** installation for this plugin to work. Configuring ffmpeg is beyond the scope of this manual. Please refer to the
excellent documentation for [homebridge-camera-ffmpeg](https://github.com/KhaosT/homebridge-camera-ffmpeg).

## Audio support notes

Audio on cameras is tricky in the HomeKit world to begin with, and when you throw in some of the specifics of how UniFi Protect works, it gets even more interesting. Some things to keep in mind if you want to use audio with UniFi Protect:

* This plugin supports audio coming from UniFi cameras. It does **not** support two-way audio.

* You will need to enable the `audio` configuration option and you may need to adjust the `packetSize` option if you're getting choppy audio or video as a result.

* **Audio support will not work unless you have a version of ffmpeg that supports fdk-aac.** Unfortunately, most default installations of ffmpeg are not compiled with support for fdk-aac. You'll need to compile or acquire a version of ffmpeg that does. Doing so is beyond the scope of this plugin. There are plenty of guides to this - Google is your friend. This plugin uses [ffmpeg-for-homebridge](https://www.npmjs.com/package/ffmpeg-for-homebridge) which easies pain somewhat by providing prebuilt static binaries of ffmpeg for certain platforms, and save you the trouble of having to compile a version of ffmpeg yourself.

## Using another video processor

`videoProcessor` is the video processor used to stream video. By default, this is ffmpeg, but can be your own custom version of ffmpeg or other video processor that accepts and understands ffmpeg command line arguments.

```
{
  "platform": "Camera-UniFi-Protect",
  "videoProcessor": "ffmpeg",
  "controllers": [
    ...
  ]
}
```

```
{
  "platform": "Camera-UniFi-Protect",
  "videoProcessor": "/my/own/compiled/ffmpeg",
  "controllers": [
    ...
  ]
}
```

## Adding your cameras using the Home app

After restarting Homebridge, each UniFi camera will need to be manually paired in the Home app.

To do this:

1. Open the Home <img src="https://user-images.githubusercontent.com/3979615/78010622-4ea1d380-738e-11ea-8a17-e6a465eeec35.png" height="16.42px"> app on your device.
2. Tap the Home tab, then tap <img src="https://user-images.githubusercontent.com/3979615/78010869-9aed1380-738e-11ea-9644-9f46b3633026.png" height="16.42px">.
3. Tap *Add Accessory*, and select *I Don't Have a Code or Cannot Scan*.
4. Select the Camera you want to pair.
5. Enter the Homebridge PIN, this can be found under the QR code in Homebridge UI or your Homebridge logs, alternatively you can select *Use Camera* and scan the QR code again.

## Plugin configuration
Add the platform in `config.json` in your home directory inside `.homebridge`.

For UniFi CloudKey Gen2+ devices, you need to specify the port in the URL to access Protect.

Sample configuration block for UCK Gen2+ devices:

```js
"platforms": [
  {
    "platform": "Camera-UniFi-Protect",
    "name": "UniFi Protect",

    "controllers": [
      {
        "url": "https://my-cloud-key:7443",
        "username": "some-unifi-protect-user (or create a new one just for homebridge)",
        "password": "some-password"
      }
    ]
  }
]
```

For UnifiOS devices like UDM-Pro, UniFi NVR, do not specify the port. You can use your Ubiquiti account credentials, though
2FA is not currently supported. **I strongly recommend creating a local user just for Homebridge instead of using this option.**

Here's a sample configuration block for UnifiOS devices:

```js
"platforms": [
  {
    "platform": "Camera-UniFi-Protect",
    "name": "UniFi Protect",

    "controllers": [
      {
        "url": "https://my-udm-pro",
        "username": "some-unifi-protect-user (or create a new one just for homebridge)",
        "password": "some-password"
      }
    ]
  }
]
```

### Advanced configuration (optional)
This step is not required. For those that prefer to tailor the defaults to their liking, here are the supported parameters.

```
"platforms": [
  {
    "platform": "Camera-UniFi-Protect",
    "name": "UniFi Protect",
    "videoProcessor" : "/usr/local/bin/ffmpeg",
    "debug" : no,

    "controllers": [
      {
        "url": "https://my-cloud-key:7443",
        "username": "some-homebridge-user (or create a new one just for homebridge)",
        "password": "some-password"
      }
    ],

    "videoConfig": {
        "sourcePrefix": "-re -rtsp_transport tcp",
        "additionalCommandline": "-preset slow -profile:v high -level 4.2 -x264-params intra-refresh=1:bframes=0",
        "mapaudio": "0:0",
        "mapvideo": "0:1",
        "maxStreams": 4,
        "maxWidth": 1920,
        "maxHeight": 1080,
        "maxFPS": 20,
        "packetSize" : 376,
        "audio": no
    }
  }
]
```

| Fields                 | Description                                             | Default                                                                               | Required |
|------------------------|---------------------------------------------------------|---------------------------------------------------------------------------------------|----------|
| platform               | Must always be `Camera-UniFi-Protect`.                  |                                                                                       | Yes      |
| name                   | For logging purposes.                                   |                                                                                       | No       |
| videoProcessor         | Specify path of ffmpeg or avconv.                       | "ffmpeg"                                                                              | No       |
| debug                  | Enable additional debug logging.                        | no                                                                                    | No       |
| url                    | URL for UniFi CloudKey G2+                              |                                                                                       | Yes      |
| username               | Your UniFi Protect username.                            |                                                                                       | Yes      |
| password               | Your UniFi Protect password.                            |                                                                                       | Yes      |
| sourcePrefix           | Prefix to apply to ffmpeg source command.               | "-re -rtsp_transport tcp"                                                            | No       |
| additionalCommandline  | Additional parameters to pass ffmpeg to render video.   | "-preset slow -profile:v high -level 4.2 -x264-params intra-refresh=1:bframes=0"      | No       |
| mapaudio               | Mapping of audio channels for ffmpeg.                   | "0:0"                                                                                 | No       |
| mapvideo               | Mapping of video channels for ffmpeg.                   | "0:1"                                                                                 | No       |
| maxStreams             | Maximum number of streams allowed for a camera.         | 4                                                                                     | No       |
| maxWidth               | Maximum width of a video stream allowed.                | 1920                                                                                  | No       |
| maxHeight              | Maximum height of a video stream allowed.               | 1080                                                                                  | No       |
| maxFPS                 | Maximum framerate for a video stream.                   | 20                                                                                    | No       |
| packetSize             | Packet size for the camera stream in multiples of 188.  | 376                                                                                   | No       |
| audio                  | Enable audio support for UniFi Protect.                 | no                                                                                    | No       |

