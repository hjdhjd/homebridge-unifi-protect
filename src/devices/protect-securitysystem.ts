/* Copyright(C) 2019-2025, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-securitysystem.ts: Security system accessory for UniFi Protect.
 */
import type { CharacteristicValue, PlatformAccessory } from "homebridge";
import { ProtectBase } from "./protect-device.js";
import type { ProtectNvr } from "../protect-nvr.js";
import { ProtectReservedNames } from "../protect-types.js";

export class ProtectSecuritySystem extends ProtectBase {

  public accessory: PlatformAccessory;
  private isAlarmTriggered: boolean;

  // Create an instance.
  constructor(nvr: ProtectNvr, accessory: PlatformAccessory) {

    super(nvr);

    this.accessory = accessory;
    this.isAlarmTriggered = false;

    this.configureDevice();
  }

  // Configure a security system accessory for HomeKit.
  private configureDevice(): boolean {

    let securityState: CharacteristicValue = this.hap.Characteristic.SecuritySystemCurrentState.STAY_ARM;

    // Save the security system state before we wipeout the context.
    if(this.accessory.context.securityState !== undefined) {

      securityState = this.accessory.context.securityState as CharacteristicValue;
    }

    // Clean out the context object in case it's been polluted somehow.
    this.accessory.context = {};
    this.accessory.context.nvr = this.nvr.ufp.mac;
    this.accessory.context.securityState = securityState;

    // Configure accessory information.
    this.configureInfo();

    // Configure MQTT services.
    this.configureMqtt();

    // Configure the security system service.
    this.configureSecuritySystem();

    // Configure the security alarm.
    this.configureSecurityAlarm();

    return true;
  }

  // Configure the security system device information for HomeKit.
  private configureInfo(): boolean {

    // Update the manufacturer information for this security system.
    this.accessory.getService(this.hap.Service.AccessoryInformation)?.updateCharacteristic(this.hap.Characteristic.Manufacturer, "github.com/hjdhjd");

    // Update the model information for this security system.
    this.accessory.getService(this.hap.Service.AccessoryInformation)?.updateCharacteristic(this.hap.Characteristic.Model, "UniFi Protect Liveview Security System");

    // Update the serial number for this security system - we base this off of the NVR.
    this.accessory.getService(this.hap.Service.AccessoryInformation)?.updateCharacteristic(this.hap.Characteristic.SerialNumber, this.nvr.ufp.mac + ".Security");

    // Update the hardware revision for this security system - we base this off of the NVR.
    this.accessory.getService(this.hap.Service.AccessoryInformation)?.updateCharacteristic(this.hap.Characteristic.HardwareRevision, this.nvr.ufp.hardwareRevision);

    return true;
  }

  // Configure MQTT capabilities for the security system.
  private configureMqtt(): boolean {

    // Get the current status of the security system.
    this.nvr.mqtt?.subscribeGet(this.nvr.ufp.mac, "securitysystem", "security system state", () => {

      return this.currentSecuritySystemState;
    });

    // Set the security system state.
    this.nvr.mqtt?.subscribeSet(this.nvr.ufp.mac, "securitysystem", "security system state", (value: string) => {

      const SecuritySystemCurrentState = this.hap.Characteristic.SecuritySystemCurrentState;
      const SecuritySystemTargetState = this.hap.Characteristic.SecuritySystemTargetState;

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
          this.log.error("Unable to process MQTT security system setting: %s.", value);

          return;
      }

      // The security alarm gets handled differently than the other state settings.
      if(targetState === SecuritySystemCurrentState.ALARM_TRIGGERED) {

        this.setSecurityAlarm(alarmState);

        return;
      }

      // Set the security state, and we're done.
      this.accessory.getService(this.hap.Service.SecuritySystem)?.updateCharacteristic(SecuritySystemTargetState, targetState);
      this.setSecurityState(targetState);
    });

    return true;
  }

  // Configure the security system for HomeKit.
  private configureSecuritySystem(): boolean {

    // Find any existing security system service.
    let service = this.accessory.getService(this.hap.Service.SecuritySystem);

    // Add the security system service, if needed.
    if(!service) {

      service = new this.hap.Service.SecuritySystem(this.accessory.displayName);

      if(!service) {

        this.log.error("Unable to add security system.");

        return false;
      }

      this.accessory.addService(service);
    }

    const SecuritySystemCurrentState = this.hap.Characteristic.SecuritySystemCurrentState;
    const SecuritySystemTargetState = this.hap.Characteristic.SecuritySystemTargetState;

    let targetSecurityState: CharacteristicValue;

    switch(this.accessory.context.securityState) {

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
    service.updateCharacteristic(SecuritySystemCurrentState, this.accessory.context.securityState as CharacteristicValue)
      .getCharacteristic(SecuritySystemCurrentState)?.onGet(() => {

        return this.isAlarmTriggered ? this.hap.Characteristic.SecuritySystemCurrentState.ALARM_TRIGGERED : (this.accessory.context.securityState as CharacteristicValue);
      });

    // Handlers for triggering a change in the security system state.
    this.accessory.getService(this.hap.Service.SecuritySystem)?.getCharacteristic(SecuritySystemTargetState).onSet(this.setSecurityState.bind(this));

    // Set the initial state after we have setup our handlers above. This way, when we startup, we
    // automatically restore the scene we've been set to, if any.
    this.accessory.getService(this.hap.Service.SecuritySystem)?.updateCharacteristic(SecuritySystemTargetState, targetSecurityState);

    return true;
  }

  // Configure the security alarm for HomeKit.
  private configureSecurityAlarm(): boolean {

    this.isAlarmTriggered = false;

    // Find the existing security alarm switch service.
    let switchService = this.accessory.getService(this.hap.Service.Switch);

    // Have we enabled the security system alarm?
    if(!this.nvr?.hasFeature("SecuritySystem.Alarm")) {

      if(switchService) {

        this.accessory.removeService(switchService);
      }

      return false;

    }

    const switchName = this.accessory.displayName + " Security Alarm";

    // Add the security alarm switch to the security system.
    if(!switchService) {

      switchService = new this.hap.Service.Switch(switchName);

      if(!switchService) {

        this.log.error("Unable to add security system alarm.");

        return false;
      }

      switchService.addOptionalCharacteristic(this.hap.Characteristic.ConfiguredName);
      this.accessory.addService(switchService);
    }

    // Notify the user that we're enabled.
    this.log.info("Enabling the security alarm switch on the security system accessory.");

    // Activate or deactivate the security alarm.
    switchService.getCharacteristic(this.hap.Characteristic.On)
      ?.onGet(() => {

        return this.isAlarmTriggered === true;
      })
      .onSet((value: CharacteristicValue) => {

        this.setSecurityAlarm(value === true);
        this.log.info("Security system alarm %s.", (value === true) ? "triggered" : "reset");
      });

    // Initialize the value.
    switchService.updateCharacteristic(this.hap.Characteristic.ConfiguredName, switchName);
    switchService.updateCharacteristic(this.hap.Characteristic.On, this.isAlarmTriggered);

    return true;
  }

  // Update security system accessory settings.
  public updateDevice(): boolean {

    // We always have a disarmed state available to us.
    const availableSecurityStates = [this.hap.Characteristic.SecuritySystemTargetState.DISARM];

    // No liveviews configured - we're done.
    if(!this.nvr.ufpApi.bootstrap?.liveviews) {

      return false;
    }

    for(const securityState of [
      [ "Protect-Away".toLowerCase(), this.hap.Characteristic.SecuritySystemTargetState.AWAY_ARM ],
      [ "Protect-Home".toLowerCase(), this.hap.Characteristic.SecuritySystemTargetState.STAY_ARM ],
      [ "Protect-Night".toLowerCase(), this.hap.Characteristic.SecuritySystemTargetState.NIGHT_ARM ]
    ]) {

      // If we don't have this liveview configured, don't add it to the property list for the security system accessory.
      if(!this.nvr.ufpApi.bootstrap.liveviews.some(x => x.name.toLowerCase() === securityState[0])) {

        continue;
      }

      availableSecurityStates.push(securityState[1] as number);
    }

    // No available security states besides disarmed - something probably went wrong, so we're done.
    if(availableSecurityStates.length < 2) {

      return false;
    }

    // Only show the available values we've configured.
    this.accessory.getService(this.hap.Service.SecuritySystem)?.
      getCharacteristic(this.hap.Characteristic.SecuritySystemTargetState).setProps({ validValues: availableSecurityStates });

    return true;
  }

  // Utility to translate security system states.
  private get currentSecuritySystemState(): string {

    const securitySystemCurrentState: { [index: number]: string } = {

      [this.hap.Characteristic.SecuritySystemCurrentState.ALARM_TRIGGERED]: "Alarm",
      [this.hap.Characteristic.SecuritySystemCurrentState.AWAY_ARM]: "Away",
      [this.hap.Characteristic.SecuritySystemCurrentState.DISARMED]: "Off",
      [this.hap.Characteristic.SecuritySystemCurrentState.NIGHT_ARM]: "Night",
      [this.hap.Characteristic.SecuritySystemCurrentState.STAY_ARM]: "Home"
    };

    return this.isAlarmTriggered ? "Alarm" : securitySystemCurrentState[this.accessory.context.securityState as number] ?? "Off";
  }

  // Change the security system state, and enable or disable motion detection accordingly.
  private setSecurityState(value: CharacteristicValue): void {

    const liveviews = this.nvr.ufpApi.bootstrap?.liveviews;
    let newState: CharacteristicValue;
    const SecuritySystemCurrentState = this.hap.Characteristic.SecuritySystemCurrentState;
    const SecuritySystemTargetState = this.hap.Characteristic.SecuritySystemTargetState;
    let viewScene = "";

    // If we don't have any liveviews, there's nothing for us to do.
    if(!liveviews) {

      return;
    }

    // We have three different states which can be triggered (aside from disarming). Those states are home, away, and night. We use this as a convenient way to easily
    // enable or disable motion detection on a Protect controller and effectively give us scene-type functionality in a nice way.
    switch(value) {

      case SecuritySystemTargetState.STAY_ARM:

        newState = SecuritySystemCurrentState.STAY_ARM;
        viewScene = "Protect-Home".toLowerCase();

        break;

      case SecuritySystemTargetState.AWAY_ARM:

        newState = SecuritySystemCurrentState.AWAY_ARM;
        viewScene = "Protect-Away".toLowerCase();

        break;

      case SecuritySystemTargetState.NIGHT_ARM:

        newState = SecuritySystemCurrentState.NIGHT_ARM;
        viewScene = "Protect-Night".toLowerCase();

        break;

      case SecuritySystemTargetState.DISARM:

        newState = SecuritySystemCurrentState.DISARMED;
        viewScene = "Protect-Off".toLowerCase();

        break;

      default:

        newState = SecuritySystemCurrentState.DISARMED;

        break;
    }

    // Get the complete list of cameras in the liveview we're interested in. This cryptic line grabs the list of liveviews that have the name we're interested in (turns
    // out, you can define multiple liveviews in Protect with the same name...who knew!), and then create a single list containing all of the cameras found.
    const targetCameraIds = liveviews.filter(view => view.name.toLowerCase() === viewScene).map(view => view.slots.map(slots => slots.cameras)).flat(2);

    // We don't have a liveview for this state and we aren't disarming - update state for the user and we're done.
    if(newState !== SecuritySystemCurrentState.DISARMED && !targetCameraIds.length) {

      this.log.info("No liveview configured for this security system state. Create a liveview named %s in the Protect webUI to use this feature.", viewScene);

      this.accessory.context.securityState = newState;
      this.accessory.getService(this.hap.Service.SecuritySystem)?.updateCharacteristic(SecuritySystemCurrentState, newState);

      return;
    }

    this.log.info("Setting the liveview scene: %s.", viewScene);

    // Iterate through the list of accessories and set the Protect scene.
    for(const targetAccessory of this.platform.accessories) {

      const targetUfp = this.nvr.configuredDevices[targetAccessory.UUID]?.ufp;

      // We only want accessories associated with this Protect controller.
      if(!targetUfp || (targetAccessory.context.nvr !== this.nvr.ufp.mac)) {

        continue;
      }

      let targetState = false;

      // If we're disarming, then all Protect cameras will disable motion detection in HomeKit. Otherwise, check to see if this is one of the cameras we want to turn on
      // motion detection for.
      if(((newState !== SecuritySystemCurrentState.DISARMED) ||
        ((newState === SecuritySystemCurrentState.DISARMED) && targetCameraIds.length)) && targetCameraIds.some(thisCameraId => thisCameraId === targetUfp?.id)) {

        targetState = true;
      }

      // Only take action to change motion detection state if needed.
      if(targetAccessory.context.detectMotion !== targetState) {

        targetAccessory.context.detectMotion = targetState;

        // Update the switch service, if present.
        const motionSwitch = targetAccessory.getServiceById(this.hap.Service.Switch, ProtectReservedNames.SWITCH_MOTION_SENSOR);

        if(motionSwitch) {

          motionSwitch.updateCharacteristic(this.hap.Characteristic.On, targetAccessory.context.detectMotion as boolean);
        }

        this.log.info("%s -> %s: Motion detection %s.", viewScene, targetAccessory.displayName,
          targetAccessory.context.detectMotion === true ? "enabled" : "disabled");
      }
    }

    // Inform the user of our new state.
    this.accessory.context.securityState = newState;
    this.accessory.getService(this.hap.Service.SecuritySystem)?.updateCharacteristic(SecuritySystemCurrentState, newState);

    // Reset our alarm state and update our alarm switch.
    this.isAlarmTriggered = false;

    if(this.accessory.getService(this.hap.Service.Switch)?.getCharacteristic(this.hap.Characteristic.On).value !== this.isAlarmTriggered) {

      this.accessory.getService(this.hap.Service.Switch)?.updateCharacteristic(this.hap.Characteristic.On, this.isAlarmTriggered);
    }

    // Publish to MQTT, if configured.
    this.nvr.mqtt?.publish(this.nvr.ufp.mac, "securitysystem", this.currentSecuritySystemState);
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
    this.nvr.mqtt?.publish(this.nvr.ufp.mac, "securitysystem", this.currentSecuritySystemState);
  }
}
