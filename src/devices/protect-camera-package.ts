/* Copyright(C) 2019-2024, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-camera-package.ts: Package camera device class for UniFi Protect.
 */
import { ProtectCamera, RtspEntry } from "./protect-camera.js";
import { ProtectStreamingDelegate } from "../protect-stream.js";
import { Resolution } from "homebridge";

// Package camera class. To avoid circular dependencies, this has to be declared in the same file as ProtectCamera, given the ProtectCamera class references it.
export class ProtectCameraPackage extends ProtectCamera {

  // Configure the package camera.
  protected async configureDevice(): Promise<boolean> {

    // Get our parent camera.
    const parentCamera = this.nvr.deviceLookup(this.ufp.id);

    this.hasHksv = true;
    this.hints.probesize = 32768;
    this.hints.transcode = true;

    if(parentCamera) {

      this.hints.apiStreaming = parentCamera.hints.apiStreaming;
      this.hints.hardwareDecoding = parentCamera.hints.hardwareDecoding;
      this.hints.hardwareTranscoding = parentCamera.hints.hardwareTranscoding;
      this.hints.highResSnapshots = parentCamera.hints.highResSnapshots;
      this.hints.logHksv = parentCamera.hints.logHksv;
      this.hints.timeshift = parentCamera.hints.timeshift;
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
    return Promise.resolve(true);
  }

  // Return a unique identifier for package cameras based on the parent device's MAC address.
  public get id(): string {

    return this.ufp.mac + ".PackageCamera";
  }

  // Make our RTSP stream findable.
  public findRtsp(): RtspEntry | null {

    const channel = this.ufp.channels.find(x => x.name === "Package Camera");

    if(!channel) {

      return null;
    }

    // Return the information we need for package camera channel access.
    return {

      channel: channel,
      lens: this.ufp.lenses.length ? this.ufp.lenses[0].id : undefined,
      name: this.getResolution([channel.width, channel.height, channel.fps]) + " (" + channel.name + ") [" + (this.ufp.videoCodec.replace("h265", "hevc")).toUpperCase() +
        "]",
      resolution: [ channel.width, channel.height, channel.fps ],
      url:  "rtsps://" + this.nvr.config.address + ":" + this.nvr.ufp.ports.rtsps.toString() + "/" + channel.rtspAlias + "?enableSrtp"
    };
  }

  // Return a recording RTSP configuration for HKSV.
  public findRecordingRtsp(): RtspEntry | null {

    return this.findRtsp();
  }
}
