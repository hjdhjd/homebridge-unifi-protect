/* Copyright(C) 2019-2020, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-securitysystem.ts: Security system accessory for UniFi Protect.
 */

import {
  CharacteristicEventTypes,
  CharacteristicGetCallback,
  CharacteristicSetCallback,
  CharacteristicValue
} from "homebridge";
import { ProtectAccessory } from "./protect-accessory";
import { ProtectNvrConfig } from "./protect-types";

export class ProtectSecuritySystem extends ProtectAccessory {
  cameraUrl = "";
  isVideoConfigured = false;

  // Configure a security system accessory for HomeKit.
  protected async configureDevice(): Promise<boolean> {
    const accessory = this.accessory;
    let securityState = this.hap.Characteristic.SecuritySystemCurrentState.STAY_ARM;

    // Save the motion sensor switch state before we wipeout the context.
    if(accessory.context.securityState !== undefined) {
      securityState = accessory.context.securityState;
    }

    // Clean out the context object in case it's been polluted somehow.
    accessory.context = {};
    accessory.context.nvr = this.nvr.nvrApi.bootstrap.nvr.mac;
    accessory.context.securityState = securityState;

    // Configure accessory information.
    if(!(await this.configureInfo())) {
      return false;
    }

    // Configure the security system service and we're done.
    return await this.configureSecuritySystem();
  }

  // Configure the security system device information for HomeKit.
  private async configureInfo(): Promise<boolean> {
    const accessory = this.accessory;
    const hap = this.hap;
    let nvrInfo!: ProtectNvrConfig;

    if(this.nvr && this.nvr.nvrApi && this.nvr.nvrApi.bootstrap && this.nvr.nvrApi.bootstrap.nvr) {
      nvrInfo = this.nvr.nvrApi.bootstrap.nvr;
    }

    // Update the manufacturer information for this security system.
    accessory
      .getService(hap.Service.AccessoryInformation)!
      .getCharacteristic(hap.Characteristic.Manufacturer).updateValue("github.com/hjdhjd");

    // Update the model information for this security system.
    accessory
      .getService(hap.Service.AccessoryInformation)!
      .getCharacteristic(hap.Characteristic.Model).updateValue("UniFi Protect Liveview Security System");


    if(nvrInfo) {
      // Update the serial number for this security system - we base this off of the NVR.
      accessory
        .getService(hap.Service.AccessoryInformation)!
        .getCharacteristic(hap.Characteristic.SerialNumber).updateValue(nvrInfo.mac + ".Security");

      // Update the hardware revision for this security system - we base this off of the NVR.
      accessory
        .getService(hap.Service.AccessoryInformation)!
        .getCharacteristic(hap.Characteristic.HardwareRevision).updateValue(nvrInfo.hardwareRevision);
    }

    return true;
  }

  // Configure the security system for HomeKit.
  private async configureSecuritySystem(): Promise<boolean> {
    const accessory = this.accessory;
    const hap = this.hap;

    // Clear out any previous motion sensor service.
    let securityService = accessory.getService(hap.Service.SecuritySystem);

    if(securityService) {
      accessory.removeService(securityService);
    }

    const SecuritySystemCurrentState = this.hap.Characteristic.SecuritySystemCurrentState;
    const SecuritySystemTargetState = this.hap.Characteristic.SecuritySystemTargetState;

    let targetSecurityState: CharacteristicValue;

    switch(accessory.context.securityState) {
      case SecuritySystemCurrentState.STAY_ARM:
      case SecuritySystemCurrentState.ALARM_TRIGGERED:
        targetSecurityState = SecuritySystemTargetState.STAY_ARM;
        break;

      case SecuritySystemCurrentState.AWAY_ARM:
        targetSecurityState = SecuritySystemTargetState.AWAY_ARM;
        break;

      case SecuritySystemCurrentState.NIGHT_ARM:
        targetSecurityState = SecuritySystemTargetState.NIGHT_ARM;
        break;

      case SecuritySystemCurrentState.DISARMED:
      default:
        targetSecurityState = SecuritySystemTargetState.DISARM;
        break;
    }

    // Add the security system service to the accessory.
    securityService = new hap.Service.SecuritySystem(accessory.displayName);

    // Handlers to get our current state, and initialize on startup.
    accessory.addService(securityService)
      .setCharacteristic(SecuritySystemCurrentState, accessory.context.securityState)
      .getCharacteristic(SecuritySystemCurrentState)!
      .on(CharacteristicEventTypes.GET, this.getSecurityState.bind(this));

    // Handlers for triggering a change in the security system state.
    accessory.getService(hap.Service.SecuritySystem)!
      .getCharacteristic(SecuritySystemTargetState)!
      .on(CharacteristicEventTypes.SET, this.setSecurityState.bind(this));

    // Set the initial state after we have setup our handlers above. This way, when we startup, we
    // automatically restore the scene we've been set to, if any.
    accessory.getService(hap.Service.SecuritySystem)!
      .setCharacteristic(SecuritySystemTargetState, targetSecurityState);

    return true;
  }

  // Get the current security system state.
  private getSecurityState(callback: CharacteristicGetCallback): void {
    callback(null, this.accessory.context.securityState);
  }

  // Change the security system state, and enable or disable motion detection accordingly.
  private setSecurityState(value: CharacteristicValue, callback: CharacteristicSetCallback): void {
    const accessory = this.accessory;
    const hap = this.hap;
    const liveviews = this.nvr.nvrApi.bootstrap.liveviews;
    let newState: CharacteristicValue;
    const nvrApi = this.nvr.nvrApi;
    const SecuritySystemCurrentState = hap.Characteristic.SecuritySystemCurrentState;
    const SecuritySystemTargetState = hap.Characteristic.SecuritySystemTargetState;
    let viewScene = "";

    // We have three different states which can be triggered (aside from disarming).
    // Those states are home, away, and night. We use this as a convenient way to easily enable or disable motion detection
    // on a Protect controller and effectively give us scene-type functionality in a nice way.
    switch(value) {
      case SecuritySystemTargetState.STAY_ARM:
        newState = SecuritySystemCurrentState.STAY_ARM;
        viewScene = "Protect-Home";
        break;

      case SecuritySystemTargetState.AWAY_ARM:
        newState = SecuritySystemCurrentState.AWAY_ARM;
        viewScene = "Protect-Away";
        break;

      case SecuritySystemTargetState.NIGHT_ARM:
        newState = SecuritySystemCurrentState.NIGHT_ARM;
        viewScene = "Protect-Night";
        break;

      case SecuritySystemTargetState.DISARM:
        newState = SecuritySystemCurrentState.DISARMED;
        viewScene = "Protect-Off";
        break;

      default:
        newState = SecuritySystemCurrentState.DISARMED;
        break;
    }

    // Get the complete list of cameras in the liveview we're interested in.
    // This cryptic line grabs the list of liveviews that have the name we're interested in
    // (turns out, you can define multiple liveviews in Protect with the same name...who knew!),
    // and then create a single list containing all of the cameras found.
    const targetCameraIds = liveviews.filter(view => view.name === viewScene)
      .map(view => view.slots.map(slots => slots.cameras))
      .flat(2);

    // We don't have a liveview for this state and we aren't disarming - update state for the user and we're done.
    if(newState !== SecuritySystemCurrentState.DISARMED && !targetCameraIds.length) {
      this.log("%s: No liveview configured for this security system state. Create a liveview named %s in the Protect webUI to use this feature.",
        nvrApi.getNvrName(), viewScene);

      accessory.context.securityState = newState;
      accessory.getService(hap.Service.SecuritySystem)!.getCharacteristic(SecuritySystemCurrentState).updateValue(newState);
      callback(null);
      return;
    }

    this.log("%s: Setting the liveview scene: %s.", nvrApi.getNvrName(), viewScene);

    // Iterate through the list of accessories and set the Protect scene.
    for(const targetAccessory of this.platform.accessories) {
      // We only want accessories associated with this Protect controller.
      if(!targetAccessory.context?.camera || targetAccessory.context.nvr !== nvrApi.bootstrap.nvr.mac) {
        continue;
      }

      let targetState = false;

      // If we're disarming, then all Protect cameras will disable motion detection in HomeKit. Otherwise,
      // check to see if this is one of the cameras we want to turn on motion detection for.
      if(((newState !== SecuritySystemCurrentState.DISARMED) ||
        ((newState === SecuritySystemCurrentState.DISARMED) && targetCameraIds.length)) &&
        targetCameraIds.some(thisCameraId => thisCameraId === targetAccessory.context.camera.id)) {
        targetState = true;
      }

      // Only take action to change motion detection state if needed.
      if(targetAccessory.context.detectMotion !== targetState) {
        targetAccessory.context.detectMotion = targetState;

        // Update the switch service, if present.
        const motionSwitch = targetAccessory.getService(hap.Service.Switch);

        if(motionSwitch) {
          motionSwitch.getCharacteristic(hap.Characteristic.On)!.updateValue(targetAccessory.context.detectMotion);
        }

        this.log("%s -> %s: Motion detection %s.", viewScene, targetAccessory.displayName,
          targetAccessory.context.detectMotion === true ? "enabled" : "disabled");
      }
    }

    // Inform the user of our new state, and return.
    accessory.context.securityState = newState;
    accessory.getService(hap.Service.SecuritySystem)!.getCharacteristic(SecuritySystemCurrentState).updateValue(newState);
    callback(null);
  }
}
