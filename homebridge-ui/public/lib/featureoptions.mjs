/* Copyright(C) 2017-2024, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * featureoptions.mjs: Feature option webUI base class.
 */
"use strict";

export class FeatureOptions {

  controller;

  featureOptionGroups;
  featureOptionList;
  optionsList;

  constructor() {

    this.featureOptionGroups = {};
    this.featureOptionList = {};
    this.controller = null;
    this.optionsList = [];
  }

  // Abstract method to be implemented by subclasses to render the feature option webUI.
  async showUI() {
  }

  // Is this feature option set explicitly?
  isOptionSet(featureOption, deviceMac) {

    const optionRegex = new RegExp("^(?:Enable|Disable)\\." + featureOption + (!deviceMac ? "" : "\\." + deviceMac) + "$", "gi");
    return this.optionsList.filter(x => optionRegex.test(x)).length ? true : false;
  }

  // Is a feature option globally enabled?
  isGlobalOptionEnabled(featureOption, defaultState) {

    featureOption = featureOption.toUpperCase();

    // Test device-specific options.
    return this.optionsList.some(x => x === ("ENABLE." + featureOption)) ? true :
      (this.optionsList.some(x => x === ("DISABLE." + featureOption)) ? false : defaultState
      );
  }

  // Is a feature option enabled at the device or global level. This function does not traverse the scoping hierarchy.
  isDeviceOptionEnabled(featureOption, mac, defaultState) {

    if(!mac) {

      return this.isGlobalOptionEnabled(featureOption, defaultState);
    }

    featureOption = featureOption.toUpperCase();
    mac = mac.toUpperCase();

    // Test device-specific options.
    return this.optionsList.some(x => x === ("ENABLE." + featureOption + "." + mac)) ? true :
      (this.optionsList.some(x => x === ("DISABLE." + featureOption + "." + mac)) ? false : defaultState
      );
  }

  // Is a value-centric feature option enabled at the device or global level. This function does not traverse the scoping hierarchy.
  isOptionValueSet(featureOption, deviceMac) {

    const optionRegex = new RegExp("^Enable\\." + featureOption + (!deviceMac ? "" : "\\." + deviceMac) + "\\.([^\\.]+)$", "gi");


    return this.optionsList.some(x => optionRegex.test(x));
  }

  // Get the value of a value-centric feature option.
  getOptionValue(featureOption, deviceMac) {

    const optionRegex = new RegExp("^Enable\\." + featureOption + (!deviceMac ? "" : "\\." + deviceMac) + "\\.([^\\.]+)$", "gi");

    // Get the option value, if we have one.
    for(const option of this.optionsList) {

      const regexMatch = optionRegex.exec(option);

      if(regexMatch) {

        return regexMatch[1];
      }
    }

    return undefined;
  }

  // Is a feature option enabled at the device or global level. It does traverse the scoping hierarchy.
  isOptionEnabled(featureOption, deviceMac) {

    const defaultState = this.featureOptionList[featureOption]?.default ?? true;

    if(deviceMac) {

      // Device level check.
      if(this.isDeviceOptionEnabled(featureOption, deviceMac, defaultState) !== defaultState) {

        return !defaultState;
      }

      // Controller level check.
      if(this.isDeviceOptionEnabled(featureOption, this.controller, defaultState) !== defaultState) {

        return !defaultState;
      }
    }

    // Global check.
    if(this.isGlobalOptionEnabled(featureOption, defaultState) !== defaultState) {

      return !defaultState;
    }

    // Return the default.
    return defaultState;
  };

  // Return the scope level of a feature option.
  optionScope(featureOption, deviceMac, defaultState, isOptionValue = false) {

    // Scope priority is always: device, controller, global.

    // If we have a value-centric feature option, our lookups are a bit different.
    if(isOptionValue) {

      if(deviceMac) {

        if(this.isOptionValueSet(featureOption, deviceMac)) {

          return "device";
        }

        if(this.isOptionValueSet(featureOption, this.controller)) {

          return "controller";
        }
      }

      if(this.isOptionValueSet(featureOption)) {

        return "global";
      }

      return "none";
    }

    if(deviceMac) {

      // Let's see if we've set it at the device-level.
      if((this.isDeviceOptionEnabled(featureOption, deviceMac, defaultState) !== defaultState) || this.isOptionSet(featureOption, deviceMac)) {

        return "device";
      }

      // Now let's test the controller level.
      if((this.isDeviceOptionEnabled(featureOption, this.controller, defaultState) !== defaultState) || this.isOptionSet(featureOption, this.controller)) {

        return "controller";
      }
    }

    // Finally, let's test the global level.
    if((this.isGlobalOptionEnabled(featureOption, defaultState) !== defaultState) || this.isOptionSet(featureOption)) {

      return "global";
    }

    // Option isn't set to a non-default value.
    return "none";
  };

  // Return the color hinting for a given option's scope.
  optionScopeColor(featureOption, deviceMac, defaultState, isOptionValue) {

    switch(this.optionScope(featureOption, deviceMac, defaultState, isOptionValue)) {

      case "device":

        return "text-info";
        break;

      case "controller":

        return "text-success";
        break;

      case "global":

        return deviceMac ? "text-warning" : "text-info";
        break;

      default:

        break;
    }

    return null;
  };
}
