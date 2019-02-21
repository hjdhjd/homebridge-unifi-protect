# homebridge-camera-unifi

Unifi Protect plugin for [Homebridge](https://github.com/nfarina/homebridge)

This plugin automatiicaly configures [Camera-ffmpeg](https://github.com/KhaosT/homebridge-camera-ffmpeg) with any cameras that have RTSP enabled from your Unifi Protect controller.

## Installation

1. Install ffmpeg on your computer
2. Install this plugin using: npm install -g homebridge-camera-unifi
3. Edit ``config.json`` and add the Unifi Protect controller.
4. Run Homebridge.
5. Add extra camera accessories in Home app. The setup code is the same as homebridge.

### Config.json Example

    {
      "platform" : "Camera-unifi",
      "name" : "Unifi Protect",
      "controllers": [{
        "url": "https://my-cloud-key:7443/",
        "username": "some-homebridge-user (create a new one just for homebridge)",
        "password": "some-password"
      }],
      "videoConfig": {
        "sourcePrefix": "-rtsp_transport http -re",
        "maxStreams": 2,
        "maxWidth": 1280,
        "maxHeight": 720,
        "maxFPS": 30
      }
    }