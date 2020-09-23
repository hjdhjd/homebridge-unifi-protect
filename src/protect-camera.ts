/* Copyright(C) 2019-2020, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-camera.ts: Camera device class for UniFi Protect.
 */
import {
  CharacteristicEventTypes,
  CharacteristicGetCallback,
  CharacteristicSetCallback,
  CharacteristicValue
} from "homebridge";
import { ProtectCameraConfig, ProtectNvrBootstrap } from "./protect-types";
import { ProtectAccessory } from "./protect-accessory";
import { ProtectApi } from "./protect-api";
import { ProtectNvr } from "./protect-nvr";
import { ProtectStreamingDelegate } from "./protect-stream";

// Manage our switch types.
export const PROTECT_SWITCH_MOTION = "MotionSensorSwitch";
export const PROTECT_SWITCH_TRIGGER = "MotionSensorTrigger";

export class ProtectCamera extends ProtectAccessory {
  public cameraUrl!: string;
  private isVideoConfigured!: boolean;
  public snapshotUrl!: string;
  public stream!: ProtectStreamingDelegate;
  public twoWayAudio!: boolean;

  // Configure a camera accessory for HomeKit.
  protected async configureDevice(): Promise<boolean> {

    this.isVideoConfigured = false;

    // Save the camera object before we wipeout the context.
    const camera = this.accessory.context.camera as ProtectCameraConfig;

    // Default motion detection support to on.
    let detectMotion = true;

    // Save the motion sensor switch state before we wipeout the context.
    if(this.accessory.context.detectMotion !== undefined) {
      detectMotion = this.accessory.context.detectMotion as boolean;
    }

    // Clean out the context object in case it's been polluted somehow.
    this.accessory.context = {};
    this.accessory.context.camera = camera;
    this.accessory.context.nvr = this.nvr.nvrApi.bootstrap?.nvr.mac;
    this.accessory.context.detectMotion = detectMotion;

    // Clear out any switches on this camera so we can start fresh.
    let switchService;

    while((switchService = this.accessory.getService(this.hap.Service.Switch))) {
      this.accessory.removeService(switchService);
    }

    // Configure accessory information.
    this.configureInfo();

    // Configure MQTT services.
    this.configureMqtt();

    // Configure the motion sensor.
    this.configureMotionSensor();
    this.configureMotionSwitch();
    this.configureMotionTrigger();

    // Configure two-way audio support and our video stream...and we're done.
    this.configureTwoWayAudio();

    return await this.configureVideoStream();
  }

  // Configure the camera device information for HomeKit.
  private configureInfo(): boolean {
    const accessory = this.accessory;
    const camera = accessory.context.camera as ProtectCameraConfig;
    const hap = this.hap;

    // Update the manufacturer information for this camera.
    accessory
      .getService(hap.Service.AccessoryInformation)
      ?.getCharacteristic(hap.Characteristic.Manufacturer).updateValue("Ubiquiti Networks");

    // Update the model information for this camera.
    accessory
      .getService(hap.Service.AccessoryInformation)
      ?.getCharacteristic(hap.Characteristic.Model).updateValue(camera.type);

    // Update the serial number for this camera.
    accessory
      .getService(hap.Service.AccessoryInformation)
      ?.getCharacteristic(hap.Characteristic.SerialNumber).updateValue(camera.mac);

    // Update the hardware revision for this camera.
    accessory
      .getService(hap.Service.AccessoryInformation)
      ?.getCharacteristic(hap.Characteristic.HardwareRevision).updateValue(camera.hardwareRevision);

    // Update the firmware revision for this camera.
    accessory
      .getService(hap.Service.AccessoryInformation)
      ?.getCharacteristic(hap.Characteristic.FirmwareRevision).updateValue(camera.firmwareVersion);

    return true;
  }

  // Configure the camera motion sensor for HomeKit.
  private configureMotionSensor(): boolean {
    const accessory = this.accessory;
    const hap = this.hap;

    // Clear out any previous motion sensor service.
    let motionService = accessory.getService(hap.Service.MotionSensor);

    if(motionService) {
      accessory.removeService(motionService);
    }

    // Have we disabled motion sensors?
    if(!this.nvr?.optionEnabled(accessory.context.camera as ProtectCameraConfig, "MotionSensor")) {
      this.log.info("%s: Disabling motion sensor.", this.name());
      return false;
    }

    // Add the motion sensor to the camera.
    motionService = new hap.Service.MotionSensor(accessory.displayName);
    accessory.addService(motionService);

    return true;
  }

  // Configure a switch to easily activate or deactivate motion sensor detection for HomeKit.
  private configureMotionSwitch(): boolean {

    // Clear out any previous switch service.
    let switchService = this.accessory.getServiceById(this.hap.Service.Switch, PROTECT_SWITCH_MOTION);

    if(switchService) {
      this.accessory.removeService(switchService);
    }

    // Have we disabled motion sensors or the motion switch? Motion switches are disabled by default.
    if(!this.nvr?.optionEnabled(this.accessory.context.camera as ProtectCameraConfig, "MotionSensor") ||
      !this.nvr?.optionEnabled(this.accessory.context.camera as ProtectCameraConfig, "MotionSwitch", false)) {

      // If we disable the switch, make sure we fully reset it's state.
      this.accessory.context.detectMotion = true;
      return false;
    }

    this.log.info("%s: Enabling motion sensor switch.", this.name());

    // Add the switch to the camera.
    switchService = new this.hap.Service.Switch(this.accessory.displayName + " Motion Events", PROTECT_SWITCH_MOTION);

    // Activate or deactivate motion detection.
    this.accessory.addService(switchService)
      .getCharacteristic(this.hap.Characteristic.On)
      ?.on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
        callback(null, this.accessory.context.detectMotion === true);
      })
      .on(CharacteristicEventTypes.SET, (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
        if(this.accessory.context.detectMotion !== value) {
          this.log.info("%s: Motion detection %s.", this.name(), (value === true) ? "enabled" : "disabled");
        }

        this.accessory.context.detectMotion = value === true;
        callback(null);
      })
      .updateValue(this.accessory.context.detectMotion as boolean);

    return true;
  }

  // Configure a switch to manually trigger a motion sensor event for HomeKit.
  private configureMotionTrigger(): boolean {

    // Clear out any previous switch service.
    let triggerService = this.accessory.getServiceById(this.hap.Service.Switch, PROTECT_SWITCH_TRIGGER);

    if(triggerService) {
      this.accessory.removeService(triggerService);
    }

    // Motion triggers are disabled by default and primarily exist for automation purposes.
    if(!this.nvr?.optionEnabled(this.accessory.context.camera as ProtectCameraConfig, "MotionSensor") ||
      !this.nvr?.optionEnabled(this.accessory.context.camera as ProtectCameraConfig, "MotionTrigger", false)) {
      return false;
    }

    // Add the switch to the camera.
    triggerService = new this.hap.Service.Switch(this.accessory.displayName + " Motion Trigger", PROTECT_SWITCH_TRIGGER);
    const motionService = this.accessory.getService(this.hap.Service.MotionSensor);
    const switchService = this.accessory.getServiceById(this.hap.Service.Switch, PROTECT_SWITCH_MOTION);

    // Activate or deactivate motion detection.
    this.accessory.addService(triggerService)
      .getCharacteristic(this.hap.Characteristic.On)
      ?.on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
        callback(null, motionService?.getCharacteristic(this.hap.Characteristic.MotionDetected).value);
      })
      .on(CharacteristicEventTypes.SET, (value: CharacteristicValue, callback: CharacteristicSetCallback) => {

        if(value) {

          // Check to see if motion events are disabled.
          if(switchService && !switchService.getCharacteristic(this.hap.Characteristic.On).value) {
            setTimeout(() => {
              triggerService?.getCharacteristic(this.hap.Characteristic.On).updateValue(false);
            }, 50);

          } else {

            // Trigger the motion event.
            this.nvr.motionEventHandler(this.accessory, Date.now());
            this.log.info("%s: Motion event triggered.", this.name());
          }

        } else {

          // If the motion sensor is still on, we should be as well.
          if(motionService?.getCharacteristic(this.hap.Characteristic.MotionDetected).value) {
            setTimeout(() => {
              triggerService?.getCharacteristic(this.hap.Characteristic.On).updateValue(true);
            }, 50);
          }
        }

        callback(null);
      })
      .updateValue(false);

    this.log.info("%s: Enabling motion sensor automation trigger.", this.name());

    return true;
  }

  // Configure two-way audio support for HomeKit.
  private configureTwoWayAudio(): boolean {

    // Identify twoway-capable devices.
    if(!(this.accessory.context.camera as ProtectCameraConfig).hasSpeaker) {
      return this.twoWayAudio = false;
    }

    // Enabled by default unless disabled by the user.
    return this.twoWayAudio = this.nvr?.optionEnabled(this.accessory.context.camera as ProtectCameraConfig, "TwoWayAudio");
  }

  // Configure a camera accessory for HomeKit.
  public async configureVideoStream(): Promise<boolean> {
    const bootstrap: ProtectNvrBootstrap | null = this.nvr.nvrApi.bootstrap;
    const nvr: ProtectNvr = this.nvr;
    const nvrApi: ProtectApi = this.nvr.nvrApi;

    // No channels exist on this camera or we don't have access to the bootstrap configuration.
    if(!(this.accessory.context.camera as ProtectCameraConfig)?.channels || !bootstrap) {
      return false;
    }

    const camera = await nvrApi.enableRtsp(this.accessory.context.camera as ProtectCameraConfig) ?? (this.accessory.context.camera as ProtectCameraConfig);
    let forceQuality = "";
    let newCameraQuality = "";
    let newCameraUrl = "";

    if(nvr.optionEnabled(camera, "StreamOnly.Low", false)) {
      forceQuality = "Low";
    } else if(nvr.optionEnabled(camera, "StreamOnly.Medium", false)) {
      forceQuality = "Medium";
    } else if(nvr.optionEnabled(camera, "StreamOnly.High", false)) {
      forceQuality = "High";
    }

    // Filter the stream the user has explicitly set. If we can't find the stream quality the
    // user requests, we fail.
    if(forceQuality) {
      const foundChannel = camera.channels.find(channel => {

        // No RTSP channel here.
        if(!channel.isRtspEnabled) {
          return false;
        }

        return channel.name === forceQuality;
      });

      if(foundChannel) {
        newCameraQuality = foundChannel.name;
        newCameraUrl = foundChannel.rtspAlias;
      }
    } else {
      // Our defaults may seem counterintuitive in some cases but here's the rationale:
      // The G4-series of cameras, particularly the G4 Pro and the G4 Bullet push out
      // 3840x2160 and 2688x1520, respectively, if you use the "High" stream setting --
      // that's a lot of data! HomeKit can only handle up to 1920x1080 (1080p) streams -
      // trying to push anything larger through to HomeKit is pointless, at least at this
      // time. Instead, to increase our chances of a smooth and quick playback experience,
      // we're going to set defaults that make sense within the context of HomeKit.
      let channelPriority;
      switch(camera.type) {
        // Handle very high-resolution cameras with more sane HomeKit defaults.
        case "UVC G4 Pro":
        case "UVC G4 Bullet":
          channelPriority = ["Medium", "Low", "High"];
          break;

        default:
          channelPriority = ["High", "Medium", "Low"];
          break;
      }

      // Iterate.
      for(const quality of channelPriority) {
        const foundChannel = camera.channels.find(channel => {

          // No RTSP channel here.
          if(!channel.isRtspEnabled) {
            return false;
          }

          // Honor the user's quality biases.
          if(!nvr.optionEnabled(camera, "Stream." + quality)) {
            return false;
          }

          return channel.name === quality;
        });

        if(foundChannel) {
          newCameraQuality = foundChannel.name;
          newCameraUrl = foundChannel.rtspAlias;
          break;
        }
      }
    }

    // No RTSP stream is available.
    if(!newCameraUrl) {
      // Notify only if this is a new change.
      if(!this.isVideoConfigured || this.cameraUrl) {
        this.log.info("%s: No RTSP stream has been configured for this camera. %s",
          this.name(),
          "Enable an RTSP stream in the UniFi Protect webUI to resolve this issue or " +
          "assign the Administrator role to the user configured for this plugin to allow it to automatically configure itself."
        );
      }
    } else {
      // Set the selected quality.
      newCameraUrl = "rtsp://" + bootstrap.nvr.host + ":" + bootstrap.nvr.ports.rtsp.toString() + "/" + newCameraUrl;

      if(this.cameraUrl !== newCameraUrl) {
        this.log.info("%s: Stream quality configured: %s.", this.name(), newCameraQuality);
      }
    }

    // Set the video stream and shapshot URLs.
    this.cameraUrl = newCameraUrl;
    this.snapshotUrl = nvrApi.camerasUrl() + "/" + camera.id + "/snapshot";

    // Configure the video stream and inform HomeKit about it, if it's our first time.
    if(!this.isVideoConfigured) {
      this.isVideoConfigured = true;
      this.stream = new ProtectStreamingDelegate(this);
      this.accessory.configureController(this.stream.controller);
    }

    return true;
  }

  // Configure MQTT capabilities of this camera.
  protected configureMqtt(): boolean {
    const bootstrap: ProtectNvrBootstrap | null = this.nvr.nvrApi.bootstrap;
    const camera = (this.accessory.context.camera as ProtectCameraConfig);

    // Trigger a motion event in MQTT, if requested to do so.
    this.nvr.mqtt?.subscribe(this.accessory, "motion/trigger", (message: Buffer) => {
      const value = message.toString();

      // When we get the right message, we trigger the motion event.
      if(value?.toLowerCase() !== "true") {
        return;
      }

      // Trigger the motion event.
      this.nvr.motionEventHandler(this.accessory, Date.now());
      this.log.info("%s: Motion event triggered via MQTT.", this.name());
    });

    // Return the RTSP URLs when requested.
    this.nvr.mqtt?.subscribe(this.accessory, "rtsp/get", (message: Buffer) => {
      const value = message.toString();

      // When we get the right message, we trigger the snapshot request.
      if(value?.toLowerCase() !== "true") {
        return;
      }

      const urlInfo: { [index: string]: string } = {};

      // Include the default URL we're using for the camera.
      if(this.cameraUrl) {
        urlInfo.Default = this.cameraUrl;
      }

      // Grab all the available RTSP channels.
      for(const channel of camera.channels) {
        if(!bootstrap || !channel.isRtspEnabled) {
          continue;
        }

        urlInfo[channel.name] = "rtsp://" + bootstrap.nvr.host + ":" + bootstrap.nvr.ports.rtsp.toString() + "/" + channel.rtspAlias;
      }

      this.nvr.mqtt?.publish(this.accessory, "rtsp", JSON.stringify(urlInfo));
      this.log.info("%s: RTSP information published via MQTT.", this.name());
    });

    // Trigger snapshots when requested.
    this.nvr.mqtt?.subscribe(this.accessory, "snapshot/trigger", (message: Buffer) => {
      const value = message.toString();

      // When we get the right message, we trigger the snapshot request.
      if(value?.toLowerCase() !== "true") {
        return;
      }

      void this.stream?.getSnapshot();
      this.log.info("%s: Snapshot triggered via MQTT.", this.name());
    });

    return true;
  }

  // Utility function for reserved identifiers for switches.
  protected isReservedName(name: string | undefined): boolean {
    return name === undefined ? false :
      [ PROTECT_SWITCH_MOTION.toUpperCase(), PROTECT_SWITCH_TRIGGER.toUpperCase() ].includes(name.toUpperCase());
  }
}
