/* Copyright(C) 2019-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-camera-package.ts: Package camera device class for UniFi Protect.
 */
import type { CharacteristicValue, Resolution } from "homebridge";
import { type Nullable , retry} from "homebridge-plugin-utils";
import { ProtectCamera, type RtspEntry } from "./camera.ts";
import { ProtectReservedNames } from "../types.ts";
import { ProtectStreamingDelegate } from "../stream.ts";

// Package camera class. Extends ProtectCamera and represents the secondary camera channel on Protect doorbells that ship with one.
export class ProtectCameraPackage extends ProtectCamera {

  private flashlightState?: boolean;

  // The package camera is a HomeKit sub-view of its parent doorbell's shared camera projection, not a Protect device of its own: it has no independent state to observe,
  // its availability, information, and name are fanned out by the parent doorbell, and its motion is delivered by the firehose router when the parent fires. So it spawns
  // no observers - in particular it must not inherit the camera reactions (it would re-derive the parent's video stream and could trip the doorbell reclassification) nor
  // the base name-sync observer, which would write the bare parent name; its own configureInfo override applies the suffixed name instead (see below).
  protected override spawnObservers(): void {

    return;
  }

  // The package camera's display name is the parent's name plus a " Package Camera" suffix, single-sourced from the shared live parent projection. v4 synthesized a
  // pre-suffixed ufp.name for the sub-view; the v5 shared-projection move reads the parent's bare name, so we re-add the suffix here when name-sync is on, restoring the
  // v4 behavior the migration regressed (the base configureInfo would otherwise overwrite the suffix with the bare parent name). With name-sync off we leave the
  // creation-time name, exactly as v4 did. The parent doorbell fans this out from its configureInfo (on a firmware change) and syncNameFromController (on a rename), so
  // the sub-view's name and firmware track the parent live, without the package camera observing anything itself.
  public override configureInfo(): boolean {

    if(this.hints.syncName) {

      this.accessoryName = (this.ufp.name ?? this.ufp.marketName) + " Package Camera";
    }

    return this.setInfo(this.accessory, this.ufp);
  }

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

    // Save our context for reference before we recreate it.
    const savedContext = this.accessory.context;

    // Clean out the context object in case it's been polluted somehow.
    this.accessory.context = {};

    // Inherit our HKSV and motion awareness states from our parent camera.
    this.accessory.context.detectMotion = savedContext.detectMotion as boolean | undefined ?? true;

    if(this.hasFeature("Video.HKSV.Recording.Switch")) {

      this.accessory.context.hksvRecordingDisabled = savedContext.hksvRecordingDisabled as boolean | undefined ?? false;
    }

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
    const validResolutions: Resolution[] = [this.findRtsp()?.resolution ?? [ 1600, 1200, 2 ]];

    // Ensure we have mandatory resolutions required by HomeKit, as well as special support for Apple TV and Apple Watch, while respecting aspect ratios.
    //
    // Our supported resolutions range from 4K through 320p...even for package cameras.
    if(!this.is4x3AspectRatio(validResolutions[0][0], validResolutions[0][1])) {

      hkResolutions = ProtectCamera.RESOLUTIONS_16X9.map(([ width, height ]) => [ width, height, 15 ]);
    } else {

      hkResolutions = ProtectCamera.RESOLUTIONS_4X3.map(([ width, height ]) => [ width, height, 15 ]);
    }

    // Validate and add our entries to the list of what we make available to HomeKit.
    for(const entry of hkResolutions) {

      // This resolution is larger than the highest resolution on the camera, natively. We compare max dimensions so portrait-oriented cameras (where width < height) use
      // their longer dimension as the threshold. We make an exception for 1080p and 720p resolutions since HomeKit explicitly requires them.
      if((Math.max(entry[0], entry[1]) >= Math.max(validResolutions[0][0], validResolutions[0][1])) && ![ 1920, 1280 ].includes(entry[0])) {

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
    if(!this.validService(this.hap.Service.Lightbulb, this.hasFeature("Doorbell.PackageCamera.Flashlight"), ProtectReservedNames.LIGHTBULB_PACKAGE_FLASHLIGHT)) {

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
    service.getCharacteristic(this.hap.Characteristic.On).onGet(() => !!this.flashlightState);

    service.getCharacteristic(this.hap.Characteristic.On).onSet(async (value: CharacteristicValue) => {

      // Stop heartbeating the flashlight to allow it to turn off.
      if(!value) {

        this.clearTimer("flashlight");
        this.flashlightState = false;

        return;
      }

      // Utility function to activate the package camera's flashlight.
      const activateFlashlight = async (): Promise<boolean> => {

        // The flashlight is momentary, so this heartbeat re-issues the pulse on a timer. We assume the pulse lands and unset only if every attempt fails.
        // turnOnFlashlight throws on a failed pulse (a non-2xx, or an unreachable controller), so a failure drives a re-attempt directly - reachability is the
        // command's to report, not a second check here. We retry up to three times at a fixed one-second cadence, swallow a persistent failure to a reflected-off
        // switch (the timer re-issues), and bind this.signal so a teardown aborts an in-flight backoff and pulse.
        let lit = true;

        try {

          await retry((signal) => this.device.turnOnFlashlight({ signal }), { attempts: 3, backoff: () => 1000, signal: this.signal });
        } catch {

          lit = false;
        }

        this.flashlightState = lit;

        // Update the sensor.
        service.updateCharacteristic(this.hap.Characteristic.On, this.flashlightState);

        // Stop if we've been told to turn off.
        if(!this.flashlightState) {

          this.clearTimer("flashlight");
        }

        return this.flashlightState;
      };

      // Clear out any interval we have.
      this.clearTimer("flashlight");

      // If it's dark, we're done.
      if(!this.ufp.isDark) {

        setTimeout(() => service.updateCharacteristic(this.hap.Characteristic.On, false), 50);

        return;
      }

      // Activate the flashlight.
      await activateFlashlight();

      // Heartbeat the flashlight at regular intervals to keep it on.
      this.registerInterval("flashlight", () => void activateFlashlight(), 20 * 1000);
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
      name: this.getResolution([ channel.width, channel.height, channel.fps ]) + " (" + channel.name + ")",
      resolution: [ channel.width, channel.height, channel.fps ],
      url:  "rtsps://" + this.nvr.config.address + ":" + this.nvr.ufp.ports.rtsps.toString() + "/" + channel.rtspAlias + "?enableSrtp"
    };
  }

  // Return a recording RTSP configuration for HKSV.
  public findRecordingRtsp(): Nullable<RtspEntry> {

    return this.findRtsp();
  }
}
