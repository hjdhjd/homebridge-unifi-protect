/* Copyright(C) 2019-2025, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-camera-package.ts: Package camera device class for UniFi Protect.
 */
import { CharacteristicValue, Resolution } from "homebridge";
import { Nullable , retry} from "homebridge-plugin-utils";
import { ProtectCamera, RtspEntry } from "./protect-camera.js";
import { ProtectReservedNames } from "../protect-types.js";
import { ProtectStreamingDelegate } from "../protect-stream.js";

// Package camera class. To avoid circular dependencies, this has to be declared in the same file as ProtectCamera, given the ProtectCamera class references it.
export class ProtectCameraPackage extends ProtectCamera {

  private flashlightState?: boolean;
  private flashlightTimer?: NodeJS.Timeout;

  // Configure the package camera.
  protected configureDevice(): boolean {

    // Get our parent camera.
    const parentCamera = this.nvr.getDeviceById(this.ufp.id);

    this.flashlightState = false;
    this.hints.probesize = 32768;

    // Inherit settings from our parent.
    if(parentCamera) {

      this.hints.tsbStreaming = parentCamera.hints.tsbStreaming;
      this.hints.hardwareDecoding = parentCamera.hints.hardwareDecoding;
      this.hints.hardwareTranscoding = parentCamera.hints.hardwareTranscoding;
      this.hints.highResSnapshots = parentCamera.hints.highResSnapshots;
      this.hints.logHksv = parentCamera.hints.logHksv;
      this.hints.transcode = parentCamera.hints.transcode;
      this.hints.transcodeBitrate = parentCamera.hints.transcodeBitrate;
      this.hints.transcodeHighLatency = parentCamera.hints.transcodeHighLatency;
      this.hints.transcodeHighLatencyBitrate = parentCamera.hints.transcodeHighLatencyBitrate;
    }

    // Clean out the context object in case it's been polluted somehow.
    this.accessory.context = {};

    // Inherit our HKSV and motion awareness states from our parent camera.
    this.accessory.context.hksvRecording = parentCamera?.accessory.context.hksvRecording as boolean;
    this.accessory.context.detectMotion = parentCamera?.accessory.context.detectMotion as boolean;

    // We explicitly avoid adding the MAC address of the camera - that's reserved for real Protect devices, not synthetic ones we create.
    this.accessory.context.nvr = this.nvr.ufp.mac;
    this.accessory.context.packageCamera = this.ufp.mac;

    // Configure accessory information.
    this.configureInfo();

    // Configure the motion sensor.
    this.configureMotionSensor();

    // Configure the flashlight.
    this.configureFlashlight();

    let hkResolutions: Resolution[] = [];
    const validResolutions: Resolution[] = [ this.findRtsp()?.resolution ?? [ 1600, 1200, 2 ] ];

    // Ensure we have mandatory resolutions required by HomeKit, as well as special support for Apple TV and Apple Watch, while respecting aspect ratios.
    // We use the frame rate of the first entry, which should be our highest resolution option that's native to the camera as the upper bound for frame rate.
    //
    // Our supported resolutions range from 4K through 320p...even for package cameras.
    if((validResolutions[0][0] / validResolutions[0][1]) === (16 / 9)) {

      hkResolutions = [

        [ 3840, 2160, 15 ], [ 2560, 1440, 15 ],
        [ 1920, 1080, 15], [ 1280, 720, 15 ],
        [ 640, 360, 15 ], [ 480, 270, 15 ],
        [ 320, 180, 15 ]
      ];
    } else {

      hkResolutions = [

        [ 3840, 2880, 15 ], [ 2560, 1920, 15 ],
        [ 1920, 1440, 15 ], [ 1280, 960, 15 ],
        [ 640, 480, 15 ], [ 480, 360, 15 ],
        [ 320, 240, 15 ]
      ];
    }

    // Validate and add our entries to the list of what we make available to HomeKit.
    for(const entry of hkResolutions) {

      // This resolution is larger than the highest resolution on the camera, natively. We make an exception for
      // 1080p and 720p resolutions since HomeKit explicitly requires them.
      if((entry[0] >= validResolutions[0][0]) && ![ 1920, 1280 ].includes(entry[0])) {

        continue;
      }

      // We already have this resolution in our list.
      if(validResolutions.some(x => (x[0] === entry[0]) && (x[1] === entry[1]) && (x[2] === entry[2]))) {

        continue;
      }

      validResolutions.push(entry);
    }

    // Inform users about our RTSP entry mapping, if we're debugging.
    if(this.hasFeature("Debug.Video.Startup")) {

      for(const entry of validResolutions) {

        this.log.info("Mapping resolution: %s.", this.getResolution(entry) + " => " + this.getResolution(validResolutions[0]));
      }
    }

    // Configure the video stream with our required resolutions. No, package cameras don't really support any of these resolutions, but they're required
    // by HomeKit in order to stream video.
    this.stream = new ProtectStreamingDelegate(this, validResolutions);

    // Fire up the controller and inform HomeKit about it.
    this.accessory.configureController(this.stream.controller);

    // We're done.
    return true;
  }

  // Configure a light accessory to turn on or off the flashlight.
  private configureFlashlight(): boolean {

    // Validate whether we should have this service enabled.
    if(!this.validService(this.hap.Service.Lightbulb, () => {

      // If we don't have the package camera flashlight enabled, we're done.
      if(!this.hasFeature("Doorbell.PackageCamera.Flashlight")) {

        return false;
      }

      return true;
    }, ProtectReservedNames.LIGHTBULB_PACKAGE_FLASHLIGHT)) {

      return false;
    }

    // Acquire the service.
    const service = this.acquireService(this.hap.Service.Lightbulb, this.accessoryName + " Flashlight", ProtectReservedNames.LIGHTBULB_PACKAGE_FLASHLIGHT);

    // Fail gracefully.
    if(!service) {

      this.log.error("Unable to add flashlight.");

      return false;
    }

    // Activate or deactivate the package camera flashlight.
    service.getCharacteristic(this.hap.Characteristic.On)?.onGet(() => !!this.flashlightState);

    service.getCharacteristic(this.hap.Characteristic.On)?.onSet(async (value: CharacteristicValue) => {

      // Stop heartbeating the flashlight to allow it to turn off.
      if(!value) {

        clearInterval(this.flashlightTimer);
        this.flashlightTimer = undefined;
        this.flashlightState = false;

        return;
      }

      // Utility function to activate the package camera's flashlight.
      const activateFlashlight = async (): Promise<boolean> => {

        // Retry the heartbeat up to three times before giving up.
        this.flashlightState = await retry(async (): Promise<boolean> => {

          if(!this.isOnline) {

            return false;
          }

          const response = await this.nvr.ufpApi.retrieve(this.nvr.ufpApi.getApiEndpoint(this.ufp.modelKey) + "/" + this.ufp.id + "/turnon-flashlight",
            { method: "POST" });

          if(!response?.ok) {

            return false;
          }

          return true;
        }, 1000, 3);

        // Update the sensor.
        service.updateCharacteristic(this.hap.Characteristic.On, this.flashlightState);

        // Stop if we've been told to turn off.
        if(!this.flashlightState) {

          clearInterval(this.flashlightTimer);
          this.flashlightTimer = undefined;
        }

        return this.flashlightState;
      };

      // Clear out any interval we have.
      clearInterval(this.flashlightTimer);

      // If it's dark, we're done.
      if(!this.ufp.isDark) {

        setTimeout(() => service?.updateCharacteristic(this.hap.Characteristic.On, false), 50);

        return;
      }

      // Activate the flashlight.
      await activateFlashlight();

      // Heartbeat the flashlight at regular intervals to keep it on.
      this.flashlightTimer = setInterval(async () => activateFlashlight(), 20 * 1000);
    });

    // Initialize the flashlight.
    service.updateCharacteristic(this.hap.Characteristic.On, !!this.flashlightState);

    return true;
  }

  // Return a unique identifier for package cameras based on the parent device's MAC address.
  public get id(): string {

    return this.ufp.mac + ".PackageCamera";
  }

  // Make our RTSP stream findable.
  public findRtsp(): Nullable<RtspEntry> {

    const channel = this.ufp.channels.find(x => x.name === "Package Camera");

    if(!channel) {

      return null;
    }

    // Return the information we need for package camera channel access.
    return {

      channel: channel,
      lens: 2,
      name: this.getResolution([channel.width, channel.height, channel.fps]) + " (" + channel.name + ") [" + (this.ufp.videoCodec.replace("h265", "hevc")).toUpperCase() +
        "]",
      resolution: [ channel.width, channel.height, channel.fps ],
      url:  "rtsps://" + this.nvr.config.address + ":" + this.nvr.ufp.ports.rtsps.toString() + "/" + channel.rtspAlias + "?enableSrtp"
    };
  }

  // Return a recording RTSP configuration for HKSV.
  public findRecordingRtsp(): Nullable<RtspEntry> {

    return this.findRtsp();
  }
}
