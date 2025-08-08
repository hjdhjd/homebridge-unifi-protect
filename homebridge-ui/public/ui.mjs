/* Copyright(C) 2017-2025, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ui.mjs: Homebridge UniFi Protect webUI.
 */
"use strict";

import { webUi } from "./lib/webUi.mjs";

// Execute our first run screen if we don't have valid Protect login credentials and a controller.
const firstRunIsRequired = () => {

  if(ui.featureOptions.currentConfig.length && ui.featureOptions.currentConfig[0].controllers?.length &&
    ui.featureOptions.currentConfig[0].controllers[0]?.address?.length && ui.featureOptions.currentConfig[0].controllers[0]?.username?.length &&
    ui.featureOptions.currentConfig[0].controllers[0]?.password?.length) {

    return false;
  }

  return true;
};

// Initialize our first run screen with any information from our existing configuration.
const firstRunOnStart = () => {

  // Pre-populate with anything we might already have in our configuration.
  document.getElementById("address").value = ui.featureOptions.currentConfig[0].controllers?.[0]?.address ?? "";
  document.getElementById("username").value = ui.featureOptions.currentConfig[0].controllers?.[0]?.username ?? "";
  document.getElementById("password").value = ui.featureOptions.currentConfig[0].controllers?.[0]?.password ?? "";

  return true;
};

// Validate our Protect credentials.
const firstRunOnSubmit = async () => {

  const address = document.getElementById("address").value;
  const username = document.getElementById("username").value;
  const password = document.getElementById("password").value;
  const tdLoginError = document.getElementById("loginError");

  tdLoginError.innerHTML = "&nbsp;";

  if(!address?.length || !username?.length || !password?.length) {

    tdLoginError.innerHTML = "<code class=\"text-danger\">Please enter a valid UniFi Protect controller address, username and password.</code>";
    homebridge.hideSpinner();

    return false;
  }

  const ufpDevices = await homebridge.request("/getDevices", { address: address, password: password, username: username });

  // Couldn't connect to the Protect controller for some reason.
  if(!ufpDevices?.length) {

    tdLoginError.innerHTML = "Unable to login to the UniFi Protect controller.<br>Please check your controller address, username, and password.<br>" +
      "<code class=\"text-danger\">" + (await homebridge.request("/getErrorMessage")) + "</code>";
    homebridge.hideSpinner();

    return false;
  }

  // Save the login credentials to our configuration.
  if(!ui.featureOptions.currentConfig[0].controllers?.length) {

    ui.featureOptions.currentConfig[0].controllers = [{}];
  }

  ui.featureOptions.currentConfig[0].controllers[0].address = address;
  ui.featureOptions.currentConfig[0].controllers[0].username = username;
  ui.featureOptions.currentConfig[0].controllers[0].password = password;

  await homebridge.updatePluginConfig(ui.featureOptions.currentConfig);

  return true;
};

// Return whether a given device is a controller.
const isController = (device) => device.modelKey === "nvr";

// Return the list of controllers from our plugin configuration.
const getControllers = () => {

  const controllers = [];

  // Grab the controllers from our configuration.
  for(const controller of ui.featureOptions.currentConfig[0].controllers ?? []) {

    controllers.push({ name: controller.address, serialNumber: controller.address });
  }

  return controllers;
};

// Return the list of devices associated with a given Protect controller.
const getDevices = async (selectedController) => {

  // If we're in the global context, we have no devices.
  if(!selectedController) {

    return [];
  }

  // Find the entry in our plugin configuration.
  const controller = (ui.featureOptions.currentConfig[0].controllers ?? []).find(c => c.address === selectedController.serialNumber);

  if(!controller) {

    return [];
  }

  // Retrieve the current list of devices from the Protect controller.
  const devices = await homebridge.request("/getDevices", { address: controller.address, password: controller.password, username: controller.username });

  // Add the fields that the webUI framework is looking for to render.
  for(const device of devices) {

    device.name ??= device.marketName;
    device.serialNumber = device.mac;
    device.sidebarGroup = device.modelKey + "s";

    // We update the name of the controller that we show users once we've connected with the controller and have it's name.
    if(isController(device)) {

      const activeController = [...document.querySelectorAll("[data-navigation='controller']")].find(c => c.getAttribute("data-device-serial") === controller.address);

      if(activeController) {

        activeController.textContent = device.name;
      }
    }
  }

  return devices;
};

// Only show feature options that are valid for the capabilities of this device.
const validOption = (device, option) => {

  if(device && (device.modelKey !== "nvr") && (
    (option.hasAccessFeature && (!device.accessDeviceMetadata?.featureFlags || !option.hasAccessFeature.some(x => device.accessDeviceMetadata.featureFlags[x]))) ||
    (option.hasFeature && (!device.featureFlags || !option.hasFeature.some(x => device.featureFlags[x]))) ||
    (option.hasProperty && !option.hasProperty.some(x => x in device)) ||
    (option.modelKey && (option.modelKey !== "all") && !option.modelKey.includes(device.modelKey)) ||
    (option.hasSmartObjectType && device.featureFlags?.smartDetectTypes && !option.hasSmartObjectType.some(x => device.featureFlags.smartDetectTypes.includes(x))))) {

    return false;
  }

  // Test for the explicit exclusion of a property if it's true.
  if(device && option.isNotProperty?.some(x => device[x] === true)) {

    return false;
  }

  // Test for device class-specific features and properties.
  switch(device?.modelKey) {

    case "camera":

      if(option.hasCameraFeature && !option.hasCameraFeature.some(x => device.featureFlags[x])) {

        return false;
      }

      break;

    case "light":

      if(option.hasLightProperty && !option.hasLightProperty.some(x => x in device)) {

        return false;
      }

      break;

    case "sensor":

      if(option.hasSensorProperty && !option.hasSensorProperty.some(x => x in device)) {

        return false;
      }

      break;

    default:

      break;
  }

  return true;
};

// Only show feature option categories that are valid for a particular device type.
const validOptionCategory = (device, category) => {

  // Always show all options at the global and controller level.
  if(!device || (device?.modelKey === "nvr")) {

    return true;
  }

  // Only show device categories we're explicitly interested in.
  if(!category.modelKey?.some(model => [ "all", device.modelKey ].includes(model))) {

    return false;
  }

  // Test for the explicit exclusion of a property if it's true.
  if(category.isNotProperty?.some(x => device[x] === true)) {

    return false;
  }

  return true;
};

// Show the details for this device.
const showProtectDetails = (device) => {

  const deviceStatsContainer = document.getElementById("deviceStatsContainer");

  // No device specified, we must be in a global context.
  if(!device) {

    deviceStatsContainer.innerHTML = "";

    return;
  }

  // Populate the device details using the new CSS Grid layout. This provides a more flexible and responsive display than the previous table layout.
  deviceStatsContainer.innerHTML =
    "<div class=\"device-stats-grid\">" +
      "<div class=\"stat-item\">" +
        "<span class=\"stat-label\">Model</span>" +
        "<span class=\"stat-value\">" + (device.marketName ?? device.type) + "</span>" +
      "</div>" +
      "<div class=\"stat-item\">" +
        "<span class=\"stat-label\">MAC Address</span>" +
        "<span class=\"stat-value font-monospace\">" + device.mac + "</span>" +
      "</div>" +
      "<div class=\"stat-item\">" +
        "<span class=\"stat-label\">IP Address</span>" +
        "<span class=\"stat-value font-monospace\">" + (device.host ?? (device.modelKey === "sensor" ? "Bluetooth Device" : "None")) + "</span>" +
      "</div>" +
      "<div class=\"stat-item\">" +
        "<span class=\"stat-label\">Status</span>" +
        "<span class=\"stat-value\">" + (("state" in device) ? (device.state.charAt(0).toUpperCase() + device.state.slice(1).toLowerCase()) : "Connected") + "</span>" +
      "</div>" +
    "</div>";
};

// Parameters for our feature options webUI.
const featureOptionsParams = {

  getControllers: getControllers,
  getDevices: getDevices,
  infoPanel: showProtectDetails,
  sidebar: {

    controllerLabel: "Protect Controllers"
  },
  ui: {

    controllerRetryEnableDelayMs: 20000,
    isController: isController,
    validOption: validOption,
    validOptionCategory: validOptionCategory
  }
};

// Parameters for our plugin webUI.
const webUiParams = {

  featureOptions: featureOptionsParams,
  firstRun: {

    isRequired: firstRunIsRequired,
    onStart: firstRunOnStart,
    onSubmit: firstRunOnSubmit
  },
  name: "UniFi Protect"
};

// Instantiate the webUI.
const ui = new webUi(webUiParams);

// Display the webUI.
ui.show();
