/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ui.mjs: Homebridge UniFi Protect webUI.
 */
"use strict";

import { controllers, hasValidCredentials, primaryController, withPrimaryCredentials } from "./protect-config.mjs";
import { webUi } from "homebridge-plugin-utils/webUi.mjs";

// Execute our first run screen if we don't have valid Protect login credentials and a controller. The framework injects our primary platform-config entry, so this is
// a pure predicate over the persisted config rather than a reach into the feature-options page's state.
const firstRunIsRequired = ({ config }) => !hasValidCredentials(config);

// Initialize our first run screen with any information from our existing configuration. The injected config is the primary platform entry; we pre-populate the form
// from its primary controller, if one is already configured.
const firstRunOnStart = ({ config }) => {

  const controller = primaryController(config);

  document.getElementById("address").value = controller?.address ?? "";
  document.getElementById("username").value = controller?.username ?? "";
  document.getElementById("password").value = controller?.password ?? "";

  return true;
};

// Validate our Protect credentials.
const firstRunOnSubmit = async ({ commit, config }) => {

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

  // Couldn't connect to the Protect controller for some reason. Render the guidance as DOM nodes and place the controller-sourced error string via textContent so it
  // is shown as text, never interpreted as markup.
  if(!ufpDevices?.length) {

    const errorCode = document.createElement("code");

    errorCode.className = "text-danger";
    errorCode.textContent = (await homebridge.request("/getErrorMessage")) ?? "";

    tdLoginError.replaceChildren(

      document.createTextNode("Unable to login to the UniFi Protect controller."), document.createElement("br"),
      document.createTextNode("Please check your controller address, username, and password."), document.createElement("br"), errorCode
    );

    homebridge.hideSpinner();

    return false;
  }

  // Persist the validated credentials through the framework's single write seam. We own the shape of the write - credentials live under the primary controller, which
  // withPrimaryCredentials encodes while preserving any additional controllers - and the session owns persistence and the preservation of sibling platform entries.
  await commit(withPrimaryCredentials(config, { address, password, username }));

  return true;
};

// Return whether a given device is a controller.
const isController = (device) => device.modelKey === "nvr";

// Return the list of controllers from our plugin configuration. The framework injects our primary platform-config entry; we map each configured controller to the
// sidebar shape, deliberately carrying no credentials into the rendered list.
const getControllers = ({ config }) => controllers(config).map((controller) => ({ name: controller.address, serialNumber: controller.address }));

// Return the list of devices associated with a given Protect controller. The framework injects the live platform config alongside the selected controller, so we can
// recover the selected controller's credentials (which the sidebar entries deliberately omit) without reaching for the config ourselves.
const getDevices = async (selectedController, { config }) => {

  // If we're in the global context, we have no devices.
  if(!selectedController) {

    return [];
  }

  // Find the entry in our plugin configuration.
  const controller = controllers(config).find((c) => c.address === selectedController.serialNumber);

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

    // We update the name of the controller that we show users once we've connected with the controller and have its name.
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
    (option.meta?.hasAccessFeature && (!device.accessDeviceMetadata?.featureFlags ||
      !option.meta?.hasAccessFeature.some(x => device.accessDeviceMetadata.featureFlags[x]))) ||
    (option.meta?.hasFeature && (!device.featureFlags || !option.meta?.hasFeature.some(x => device.featureFlags[x]))) ||
    (option.meta?.hasProperty && !option.meta?.hasProperty.some(x => x in device)) ||
    (option.meta?.modelKey && (option.meta?.modelKey !== "all") && !option.meta?.modelKey.includes(device.modelKey)) ||
    (option.meta?.hasSmartObjectType && device.featureFlags?.smartDetectTypes &&
      !option.meta?.hasSmartObjectType.some(x => device.featureFlags.smartDetectTypes.includes(x))))) {

    return false;
  }

  // Test for the explicit exclusion of a property if it's true.
  if(device && option.meta?.isNotProperty?.some(x => device[x] === true)) {

    return false;
  }

  // Test for device class-specific features and properties.
  switch(device?.modelKey) {

    case "camera":

      if(option.meta?.hasCameraFeature && !option.meta?.hasCameraFeature.some(x => device.featureFlags[x])) {

        return false;
      }

      break;

    case "light":

      if(option.meta?.hasLightProperty && !option.meta?.hasLightProperty.some(x => x in device)) {

        return false;
      }

      break;

    case "sensor":

      if(option.meta?.hasSensorProperty && !option.meta?.hasSensorProperty.some(x => x in device)) {

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
  if(!category.meta?.modelKey?.some(model => [ "all", device.modelKey ].includes(model))) {

    return false;
  }

  // Test for the explicit exclusion of a property if it's true.
  if(category.meta?.isNotProperty?.some(x => device[x] === true)) {

    return false;
  }

  // Test for the feature availability on a specific device type.
  if(category.meta?.featureByModel?.[device.modelKey]?.some(x => !device.featureFlags?.[x])) {

    return false;
  }

  return true;
};

/* Build one row of the device-stats grid. We construct DOM nodes directly via createElement / textContent rather than concatenating into innerHTML so any HTML
 * metacharacter in a device field (model, MAC address, IP address) renders as text instead of being interpreted as markup. The discovery boundary is the trust line,
 * and treating controller-reported strings as data rather than HTML is the cleanest place to enforce it.
 */
const buildStatRow = (label, value, valueClassName) => {

  const item = document.createElement("div");

  item.className = "stat-item";

  const labelSpan = document.createElement("span");

  labelSpan.className = "stat-label";
  labelSpan.textContent = label;

  const valueSpan = document.createElement("span");

  valueSpan.className = valueClassName;
  valueSpan.textContent = value ?? "";

  item.append(labelSpan, valueSpan);

  return item;
};

// Show the details for this device.
const showProtectDetails = (device) => {

  const deviceStatsContainer = document.getElementById("deviceStatsContainer");

  // No device specified, we must be in a global context.
  if(!device) {

    deviceStatsContainer.textContent = "";

    return;
  }

  // Compute the IP-address value: cameras and most devices report a host; sensors without one are reached over LoRa (SuperLink) or Bluetooth.
  const ipValue = device.host ?? ((device.modelKey === "sensor") ? ((device.connectionType === "lora") ? "SuperLink" : "Bluetooth") + " Device" : "None");

  // Compute the status value: title-case the device state when present, otherwise report a connected controller.
  const statusValue = ("state" in device) ? (device.state.charAt(0).toUpperCase() + device.state.slice(1).toLowerCase()) : "Connected";

  // Build the device-details grid fresh so successive selections do not stack stale rows.
  const grid = document.createElement("div");

  grid.className = "device-stats-grid";
  grid.append(

    buildStatRow("Model", device.marketName ?? device.type, "stat-value"),
    buildStatRow("MAC Address", device.mac, "stat-value font-monospace"),
    buildStatRow("IP Address", ipValue, "stat-value font-monospace"),
    buildStatRow("Status", statusValue, "stat-value")
  );

  deviceStatsContainer.replaceChildren(grid);
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
