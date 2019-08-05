# homebridge-unifi-protect2

Unifi Protect plarform plugin for [Homebridge](https://github.com/nfarina/homebridge)

This plugin is intended to automatically configure all the cameras you have setup in UniFi Protect to make them available via HomeKit. It requires the
[camera-ffmpeg](https://github.com/KhaosT/homebridge-camera-ffmpeg) plugin in order to provide that functionality.

This package is based on the excellent work of [homebridge-camera-unifi](https://github.com/ptescher/homebridge-camera-unifi).

Why use this plugin? This plugin aims to be a one-stop-shop for UniFi Protect to HomeKit connectivity. Over time, it is my hope to add motion sensors and
any other capabilities that make sense to this plugin to enable HomeKit users to easily connect the UniFi Protect and HomeKit worlds.

## Installation

1. Install ffmpeg on your computer
2. Install this plugin using: npm install -g homebridge-unifi-protect2
3. Edit ``config.json`` and add the Unifi Protect controller.
4. Run Homebridge.
5. Add extra camera accessories in Home app. The setup code is the same as homebridge.

### config.json Example

    {
      "platform" : "homebridge-unifi-protect2",
      "name" : "Unifi Protect",
      "controllers": [{
        "url": "https://my-cloud-key:7443/",
        "username": "some-homebridge-user (create a new one just for homebridge)",
        "password": "some-password"
      }],
      "videoConfig": {
        "sourcePrefix": "-rtsp_transport http -re",
        "additionalCommandline": "",
        "mapaudio": "",
        "mapvideo": "",
        "maxStreams": 2,
        "maxWidth": 1280,
        "maxHeight": 720,
        "maxFPS": 30
      }
    }

