var Accessory, hap, UUIDGen;

var FFMPEG = require('homebridge-camera-ffmpeg/ffmpeg.js').FFMPEG;
var requestPromise = require('request-promise').defaults({jar: true});

module.exports = function(homebridge) {
  Accessory = homebridge.platformAccessory;
  hap = homebridge.hap;
  UUIDGen = homebridge.hap.uuid;

  homebridge.registerPlatform("homebridge-ufp", "Camera-UniFi-Protect", unifiPlatform, true);
}

function unifiPlatform(log, config, api) {
  var self = this;

  self.log = log;
  self.config = config || {};

  if (api) {
    self.api = api;

    if (api.version < 2.1) {
      throw new Error("Unexpected API version.");
    }

    self.api.on('didFinishLaunching', self.didFinishLaunching.bind(this));
  }
}

function getUnifiAuthConfig(controllerConfig) {
  return requestPromise.get(controllerConfig.url, {
    rejectUnauthorized: false,
    resolveWithFullResponse: true
  }).then(response => {
    if (response.headers['x-csrf-token']) {
      return {
        authURL: controllerConfig.url + '/api/auth/login',
        bootstrapURL: controllerConfig.url + '/proxy/protect/api/bootstrap',
        isUnifiOS: true,
        csrfToken: response.headers['x-csrf-token']
      }
    } else {
      return {
        authURL: controllerConfig.url + '/api/auth',
        bootstrapURL: controllerConfig.url + '/api/bootstrap',
        isUnifiOS: false
      }
    }
  });
}

unifiPlatform.prototype.configureAccessory = function(accessory) {
  // Won't be invoked
}

unifiPlatform.prototype.didFinishLaunching = function() {
  var self = this;
  var videoProcessor = self.config.videoProcessor || 'ffmpeg';
  var videoConfig = self.config.videoConfig;

  // Set some sane defaults...

  // Tell ffmpeg that this is an RTSP over HTTP stream.
  var sourcePrefix = '-re -rtsp_transport http';

  // Magic incantation to stream effectively to iOS at the best quality possible.
  var additionalCommandline = '-preset slow -profile:v high -level 4.2 -x264-params intra-refresh=1:bframes=0';

  // Map audio and video to deal with UniFi quirks.
  var mapaudio = '0:0';
  var mapvideo = '0:1';

  // Set a reasonable max FPS value. If your Protect setup is slower, this won't matter.
  var maxFPS = 20;

  // Set a reasonable stream maximum.
  var maxStreams = 4;

  // Default to 1080p
  var maxWidth = 1920;
  var maxHeight = 1080;

  if(videoConfig) {
    if(videoConfig.sourcePrefix) {
      sourcePrefix = videoConfig.sourcePrefix;
    }

    if(videoConfig.additionalCommandline) {
      additionalCommandline = videoConfig.additionalCommandline;
    }

    if(videoConfig.mapaudio) {
      mapaudio = videoConfig.mapaudio;
    }

    if(videoConfig.mapvideo) {
      mapvideo = videoConfig.mapvideo;
    }

    if(videoConfig.maxFPS) {
      maxFPS = videoConfig.maxFPS;
    }

    if(videoConfig.maxStreams) {
      maxStreams = videoConfig.maxStreams;
    }

    if(videoConfig.maxWidth) {
      maxWidth = videoConfig.maxWidth;
    }

    if(videoConfig.maxHeight) {
      maxHeight = videoConfig.maxHeight;
    }

  }

  if (self.config.controllers) {
    var controllers = self.config.controllers;
    var promises = controllers.map(controllerConfig => {
      return getUnifiAuthConfig(controllerConfig).then(unifiAuthConfig => {
        var options = {
          json: {
            username: controllerConfig.username,
            password: controllerConfig.password
          },
          resolveWithFullResponse: true,
          rejectUnauthorized: false
        }
        if(unifiAuthConfig.isUnifiOS){
          options.headers = {
            'X-CSRF-Token': unifiAuthConfig.csrfToken,
          }
        }
        return requestPromise.post(
          unifiAuthConfig.authURL, options)
          .then(response => {
            var options = {
              headers: {},
              rejectUnauthorized: false,
              resolveWithFullResponse: true
          };
          if(unifiAuthConfig.isUnifiOS){
            options.headers['X-CSRF-Token'] = unifiAuthConfig.csrfToken;
          } else {
            options.headers['Authorization'] = 'Bearer ' + response.headers.authorization;
          }
            return requestPromise.get(
                unifiAuthConfig.bootstrapURL, options
            ).then(response => {
              let bootstrap = JSON.parse(response.body);

              return bootstrap.cameras.map(camera => {
                var cameraName = camera.name;

                var channel = camera.channels.find(channel => {
                  return channel.isRtspEnabled == true;
                });

                if (!channel) {
                  throw new Error("No RTSP channel found");
                }

                //     Other possibilities for dealing with image snapshoots...the first relies on anonymous snapshots being enabled. The second is a slightly
                //     fancier way of using ffmpeg to get a high-quality image snapshot. In practice, the default setting of the ffmpeg plugin works great in
                //     my testing.
                //
                //       stillImageSource: '-i https://' + camera.host + '/snap.jpeg',
                //       stillImageSource: sourcePrefix + ' -i rtsp://' + bootstrap.nvr.host + ':' + bootstrap.nvr.ports.rtsp + '/' + channel.rtspAlias + ' -q:v 0',

                var cameraConfig = {
                  name: cameraName,
                  videoConfig: {
                    source: sourcePrefix + ' -i rtsp://' + bootstrap.nvr.host + ':' + bootstrap.nvr.ports.rtsp + '/' + channel.rtspAlias,
                    additionalCommandline: additionalCommandline,
                    mapvideo: mapvideo,
                    mapaudio: mapaudio,
                    maxStreams: maxStreams,
                    maxWidth: maxWidth,
                    maxHeight: maxHeight,
                    maxFPS: maxFPS
                  }
                }

                var uuid = UUIDGen.generate(cameraName);
                var cameraAccessory = new Accessory(cameraName, uuid, hap.Accessory.Categories.CAMERA);

                cameraAccessory.getService(hap.Service.AccessoryInformation)
                  .setCharacteristic(hap.Characteristic.Manufacturer, 'Ubiquiti Inc.')
                  .setCharacteristic(hap.Characteristic.Model, camera.type)
                  .setCharacteristic(hap.Characteristic.HardwareRevision, camera.hardwareRevision)
                  .setCharacteristic(hap.Characteristic.FirmwareRevision, camera.firmwareVersion)
                  .setCharacteristic(hap.Characteristic.SerialNumber, camera.mac);

                var cameraSource = new FFMPEG(hap, cameraConfig, self.log, videoProcessor);
                cameraAccessory.configureCameraSource(cameraSource);

                return cameraAccessory;
              });
            }).catch(e => {
              console.error(e);
            });
          }).then(result => {
            return result;
          })
        });
    });

    Promise.all(promises).then(controllerAccessories => {
      controllerAccessories.forEach(accessories => {
        self.api.publishCameraAccessories("Camera-UniFi-Protect", accessories);
      });
    });
  }
}
