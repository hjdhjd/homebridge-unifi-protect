var Accessory, hap, UUIDGen;

var FFMPEG = require('homebridge-camera-ffmpeg/ffmpeg.js').FFMPEG;
var requestPromise = require('request-promise');

module.exports = function(homebridge) {
  Accessory = homebridge.platformAccessory;
  hap = homebridge.hap;
  UUIDGen = homebridge.hap.uuid;

  homebridge.registerPlatform("homebridge-camera-unifi", "Camera-unifi", unifiPlatform, true);
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

unifiPlatform.prototype.configureAccessory = function(accessory) {
  // Won't be invoked
}

unifiPlatform.prototype.didFinishLaunching = function() {
  var self = this;
  var videoProcessor = self.config.videoProcessor || 'ffmpeg';
  var videoConfig = self.config.videoConfig;

  if (self.config.controllers) {
    var controllers = self.config.controllers;
    var promises = controllers.map(controllerConfig => {
      return requestPromise.post(
        controllerConfig.url + 'api/auth',
        {
          json: { username: controllerConfig.username, password: controllerConfig.password },
          resolveWithFullResponse: true
        }
      ).then(response => {
        var accessToken = response.headers.authorization;
        return requestPromise.get(
          controllerConfig.url + 'api/bootstrap',
          {
            headers: { 
              Authorization: 'Bearer ' + accessToken
            }
          }
        ).then(response => {  
          let bootstrap = JSON.parse(response);
          var accessKey = bootstrap.accessKey;

          return bootstrap.cameras.map(camera => {  
            var cameraName = camera.name;
  
            var channel = camera.channels.find(channel => {
              return channel.isRtspEnabled == true;
            });
  
            if (!channel) {
              throw new Error("No RTSP channel found");
            }
  
            var cameraConfig = {
              name: cameraName,
              videoConfig: {
                source: videoConfig.sourcePrefix + " -i rtsp://" + bootstrap.nvr.host + ':' + bootstrap.nvr.ports.rtsp + '/' + channel.rtspAlias,
                stillImageSource: '-i https://' + bootstrap.nvr.host + ':' + bootstrap.nvr.ports.https + '/api/cameras/' + camera.id + '/snapshot?accessKey=' + accessKey,
                maxStreams: videoConfig.maxStreams,
                maxWidth: videoConfig.maxWidth,
                maxHeight: videoConfig.maxHeight,
                maxFPS: videoConfig.maxFPS
              }
            }
    
            var uuid = UUIDGen.generate(cameraName);
            var cameraAccessory = new Accessory(cameraName, uuid, hap.Accessory.Categories.CAMERA);
  
            var cameraSource = new FFMPEG(hap, cameraConfig, self.log, videoProcessor);
            cameraAccessory.configureCameraSource(cameraSource);
  
            return cameraAccessory;
          });
        });
      }).then(result => {
        return result;
      });
    });

    Promise.all(promises).then(controllerAccessories => {
      controllerAccessories.forEach(accessories => {
        self.api.publishCameraAccessories("Camera-unifi", accessories);
      });
    });
  }
}
