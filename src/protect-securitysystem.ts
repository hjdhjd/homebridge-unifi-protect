/* Copyright(C) 2019-2022, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-securitysystem.ts: Security system accessory for UniFi Protect.
 */
import {
  CharacteristicEventTypes,
  CharacteristicGetCallback,
  CharacteristicSetCallback,
  CharacteristicValue
} from "homebridge";
import { ProtectCameraConfig, ProtectNvrConfig } from "unifi-protect";
import { PROTECT_SWITCH_MOTION_SENSOR } from "./protect-camera";
import { ProtectAccessory } from "./protect-accessory";

export class ProtectSecuritySystem extends ProtectAccessory {
  private isAlarmTriggered!: boolean;

  // Configure a security system accessory for HomeKit.
  protected configureDevice(): Promise<boolean> {
    const accessory = this.accessory;
    let securityState: CharacteristicValue = this.hap.Characteristic.SecuritySystemCurrentState.STAY_ARM;

    // Save the motion sensor switch state before we wipeout the context.
    if(accessory.context.securityState !== undefined) {
      securityState = accessory.context.securityState as CharacteristicValue;
    }

    // Clean out the context object in case it's been polluted somehow.
    accessory.context = {};
    accessory.context.nvr = this.nvr.nvrApi.bootstrap?.nvr.mac;
    accessory.context.securityState = securityState;

    // Configure accessory information.
    this.configureInfo();

    // Configure MQTT services.
    this.configureMqtt();

    // Configure the security system service.
    this.configureSecuritySystem();

    // Configure the security alarm.
    this.configureSecurityAlarm();

    return Promise.resolve(true);
  }

  // Configure the security system device information for HomeKit.
  private configureInfo(): boolean {
    const accessory = this.accessory;
    const hap = this.hap;
    let nvrInfo!: ProtectNvrConfig;

    if(this.nvr && this.nvr.nvrApi && this.nvr.nvrApi.bootstrap && this.nvr.nvrApi.bootstrap.nvr) {
      nvrInfo = this.nvr.nvrApi.bootstrap.nvr;
    }

    // Update the manufacturer information for this security system.
    accessory
      .getService(hap.Service.AccessoryInformation)
      ?.updateCharacteristic(hap.Characteristic.Manufacturer, "github.com/hjdhjd");

    // Update the model information for this security system.
    accessory
      .getService(hap.Service.AccessoryInformation)
      ?.updateCharacteristic(hap.Characteristic.Model, "UniFi Protect Liveview Security System");


    if(nvrInfo) {
      // Update the serial number for this security system - we base this off of the NVR.
      accessory
        .getService(hap.Service.AccessoryInformation)
        ?.updateCharacteristic(hap.Characteristic.SerialNumber, nvrInfo.mac + ".Security");

      // Update the hardware revision for this security system - we base this off of the NVR.
      accessory
        .getService(hap.Service.AccessoryInformation)
        ?.updateCharacteristic(hap.Characteristic.HardwareRevision, nvrInfo.hardwareRevision);
    }

    return true;
  }

  // Configure MQTT capabilities for the security system.
  private configureMqtt(): boolean {

    // Get the current status of the security system.
    this.nvr.mqtt?.subscribe(this.accessory, "securitysystem/get", (message: Buffer) => {

      const value = message.toString().toLowerCase();

      // When we get the right message, we return the state of the security system.
      if(value !== "true") {
        return;
      }

      // Publish the current status of the security system.
      this.publishSecurityState();
      this.log.info("%s: Security system status published via MQTT.", this.name());
    });

    // Set the security system state.
    this.nvr.mqtt?.subscribe(this.accessory, "securitysystem/set", (message: Buffer) => {

      const SecuritySystemCurrentState = this.hap.Characteristic.SecuritySystemCurrentState;
      const SecuritySystemTargetState = this.hap.Characteristic.SecuritySystemTargetState;
      const value = message.toString().toLowerCase();

      let alarmState!: boolean;
      let targetState: CharacteristicValue;

      // Map the request to our security states.
      switch(value) {
        case "home":
          targetState = SecuritySystemTargetState.STAY_ARM;
          break;

        case "away":
          targetState = SecuritySystemTargetState.AWAY_ARM;
          break;

        case "night":
          targetState = SecuritySystemTargetState.NIGHT_ARM;
          break;

        case "alarmoff":
          targetState = SecuritySystemCurrentState.ALARM_TRIGGERED;
          alarmState = false;
          break;

        case "alarmon":
          targetState = SecuritySystemCurrentState.ALARM_TRIGGERED;
          alarmState = true;
          break;

        case "off":
          targetState = SecuritySystemTargetState.DISARM;
          break;

        default:
          // The user sent a bad value. Ignore it and we're done.
          this.log.error("%s: Unable to process MQTT security system setting: %s.", this.name(), message.toString());
          return;
      }

      // The security alarm gets handled differently than the other state settings.
      if(targetState === SecuritySystemCurrentState.ALARM_TRIGGERED) {
        this.setSecurityAlarm(alarmState);
        this.log.info("%s: Security alarm %s via MQTT.", this.name(), alarmState ? "triggered" : "reset");
        return;
      }

      // Set the security state, and we're done.
      this.accessory.getService(this.hap.Service.SecuritySystem)?.updateCharacteristic(SecuritySystemTargetState, targetState);
      this.setSecurityState(targetState);
      this.log.info("%s: Security system state set via MQTT: %s.", this.name(), value.charAt(0).toUpperCase() + value.slice(1));
    });

    return true;
  }

  // Configure the security system for HomeKit.
  private configureSecuritySystem(): boolean {
    const accessory = this.accessory;
    const hap = this.hap;

    // Find any existing security system service.
    let securityService = accessory.getService(hap.Service.SecuritySystem);

    // Add the security system service, if needed.
    if(!securityService) {
      securityService = new hap.Service.SecuritySystem(accessory.displayName);

      if(!securityService) {
        this.log.error("%s: Unable to add security system.", this.name());
        return false;
      }

      accessory.addService(securityService);
    }

    const SecuritySystemCurrentState = this.hap.Characteristic.SecuritySystemCurrentState;
    const SecuritySystemTargetState = this.hap.Characteristic.SecuritySystemTargetState;

    let targetSecurityState: CharacteristicValue;

    switch(accessory.context.securityState) {
      case SecuritySystemCurrentState.STAY_ARM:
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

    // Handlers to get our current state, and initialize on startup.
    securityService
      .updateCharacteristic(SecuritySystemCurrentState, accessory.context.securityState as CharacteristicValue)
      .getCharacteristic(SecuritySystemCurrentState)
      ?.on(CharacteristicEventTypes.GET, this.getSecurityState.bind(this));

    // Handlers for triggering a change in the security system state.
    accessory.getService(hap.Service.SecuritySystem)
      ?.getCharacteristic(SecuritySystemTargetState)
      .on(CharacteristicEventTypes.SET, this.setSecurityState.bind(this));

    // Set the initial state after we have setup our handlers above. This way, when we startup, we
    // automatically restore the scene we've been set to, if any.
    accessory.getService(hap.Service.SecuritySystem)
      ?.updateCharacteristic(SecuritySystemTargetState, targetSecurityState);

    return true;
  }

  // Configure the security alarm for HomeKit.
  private configureSecurityAlarm(): boolean {

    this.isAlarmTriggered = false;

    // Find the existing security alarm switch service.
    let switchService = this.accessory.getService(this.hap.Service.Switch);

    // Have we enabled the security system alarm?
    if(!this.nvr?.optionEnabled(null, "SecuritySystem.Alarm", false)) {

      if(switchService) {
        this.accessory.removeService(switchService);
      }

      return false;

    }

    // Add the security alarm switch to the security system.
    if(!switchService) {
      switchService = new this.hap.Service.Switch(this.accessory.displayName + " Security Alarm");

      if(!switchService) {
        this.log.error("%s: Unable to add security system alarm.", this.name());
        return false;
      }

      this.accessory.addService(switchService);
    }

    // Notify the user that we're enabled.
    this.log.info("%s: Enabling the security alarm switch on the security system accessory.", this.name());

    // Activate or deactivate the security alarm.
    switchService
      .getCharacteristic(this.hap.Characteristic.On)
      ?.on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
        callback(null, this.isAlarmTriggered === true);
      })
      .on(CharacteristicEventTypes.SET, (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
        this.setSecurityAlarm(value === true);
        this.log.info("%s: Security system alarm %s.", this.name(), (value === true) ? "triggered" : "reset");
        callback(null);
      });

    // Initialize the value.
    switchService.updateCharacteristic(this.hap.Characteristic.On, this.isAlarmTriggered);

    return true;
  }

  // Publish the security system state to MQTT.
  private publishSecurityState(): void {

    const SecuritySystemCurrentState = this.hap.Characteristic.SecuritySystemCurrentState;
    let state;

    switch(this.accessory.context.securityState) {
      case SecuritySystemCurrentState.STAY_ARM:
        state = "Home";
        break;

      case SecuritySystemCurrentState.AWAY_ARM:
        state = "Away";
        break;

      case SecuritySystemCurrentState.NIGHT_ARM:
        state = "Night";
        break;

      case SecuritySystemCurrentState.ALARM_TRIGGERED:
        state = "Alarm";
        break;

      case SecuritySystemCurrentState.DISARMED:
      default:
        state = "Off";
        break;
    }

    this.nvr.mqtt?.publish(this.accessory, "securitysystem", this.isAlarmTriggered ? "Alarm" : state);
  }

  // Get the current security system state.
  private getSecurityState(callback: CharacteristicGetCallback): void {
    callback(null, this.isAlarmTriggered ?
      this.hap.Characteristic.SecuritySystemCurrentState.ALARM_TRIGGERED :
      this.accessory.context.securityState as CharacteristicValue);
  }

  // Change the security system state, and enable or disable motion detection accordingly.
  private setSecurityState(value: CharacteristicValue, callback?: CharacteristicSetCallback): void {
    const accessory = this.accessory;
    const hap = this.hap;
    const liveviews = this.nvr.nvrApi.bootstrap?.liveviews;
    let newState: CharacteristicValue;
    const nvrApi = this.nvr.nvrApi;
    const SecuritySystemCurrentState = hap.Characteristic.SecuritySystemCurrentState;
    const SecuritySystemTargetState = hap.Characteristic.SecuritySystemTargetState;
    let viewScene = "";

    // If we don't have any liveviews or the bootstrap configuration, there's nothing for us to do.
    if(!liveviews || !nvrApi.bootstrap) {

      if(callback) {
        callback(null);
      }

      return;
    }

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
      this.log.info("%s: No liveview configured for this security system state. Create a liveview named %s in the Protect webUI to use this feature.",
        this.name(), viewScene);

      accessory.context.securityState = newState;
      accessory.getService(hap.Service.SecuritySystem)?.updateCharacteristic(SecuritySystemCurrentState, newState);

      if(callback) {
        callback(null);
      }

      return;
    }

    this.log.info("%s: Setting the liveview scene: %s.", this.name(), viewScene);

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
        targetCameraIds.some(thisCameraId => thisCameraId === (targetAccessory.context.camera as ProtectCameraConfig).id)) {
        targetState = true;
      }

      // Only take action to change motion detection state if needed.
      if(targetAccessory.context.detectMotion !== targetState) {
        targetAccessory.context.detectMotion = targetState;

        // Update the switch service, if present.
        const motionSwitch = targetAccessory.getServiceById(hap.Service.Switch, PROTECT_SWITCH_MOTION_SENSOR);

        if(motionSwitch) {
          motionSwitch.updateCharacteristic(hap.Characteristic.On, targetAccessory.context.detectMotion as boolean);
        }

        this.log.info("%s: %s -> %s: Motion detection %s.", this.name(), viewScene, targetAccessory.displayName,
          targetAccessory.context.detectMotion === true ? "enabled" : "disabled");
      }
    }

    // Inform the user of our new state.
    accessory.context.securityState = newState;
    accessory.getService(hap.Service.SecuritySystem)?.updateCharacteristic(SecuritySystemCurrentState, newState);

    // Reset our alarm state and update our alarm switch.
    this.isAlarmTriggered = false;

    if(accessory.getService(hap.Service.Switch)?.getCharacteristic(hap.Characteristic.On).value !== this.isAlarmTriggered) {
      accessory.getService(hap.Service.Switch)?.updateCharacteristic(hap.Characteristic.On, this.isAlarmTriggered);
    }

    // Publish to MQTT, if configured.
    this.publishSecurityState();

    if(callback) {
      callback(null);
    }
  }

  // Set the security alarm.
  private setSecurityAlarm(value: boolean): void {

    // Nothing to do.
    if(this.isAlarmTriggered === value) {
      return;
    }

    // Update the alarm state.
    this.isAlarmTriggered = value === true;

    // Update the security system state.
    this.accessory.getService(this.hap.Service.SecuritySystem)?.updateCharacteristic(this.hap.Characteristic.SecuritySystemCurrentState,
      this.isAlarmTriggered ? this.hap.Characteristic.SecuritySystemCurrentState.ALARM_TRIGGERED : this.accessory.context.securityState as CharacteristicValue);

    // Update the security alarm state.
    this.accessory.getService(this.hap.Service.Switch)?.updateCharacteristic(this.hap.Characteristic.On, this.isAlarmTriggered);

    // Publish to MQTT, if configured.
    this.publishSecurityState();
  }
}
