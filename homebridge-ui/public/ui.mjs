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

/* Render the plugin's first-run login error display. Guidance sentences render as text nodes separated by <br> elements, and the failure detail - when present -
 * renders inside a <code class="text-danger"> via textContent, so a controller-reported string is shown as text rather than interpreted as markup. Assembling DOM
 * nodes here (rather than an innerHTML string) keeps that trust boundary in one place, matching buildStatRow's discipline. An empty lines array renders no guidance,
 * and an omitted or empty detail renders no code element.
 */
const renderLoginError = (lines, detail) => {

  const nodes = [];

  for(const line of lines) {

    nodes.push(document.createTextNode(line), document.createElement("br"));
  }

  if(detail?.length) {

    const errorCode = document.createElement("code");

    errorCode.className = "text-danger";
    errorCode.textContent = detail;
    nodes.push(errorCode);
  }

  document.getElementById("loginError").replaceChildren(...nodes);
};

// Validate our Protect credentials.
const firstRunOnSubmit = async ({ commit, config }) => {

  const address = document.getElementById("address").value;
  const username = document.getElementById("username").value;
  const password = document.getElementById("password").value;

  document.getElementById("loginError").innerHTML = "&nbsp;";

  if(!address?.length || !username?.length || !password?.length) {

    renderLoginError([], "Please enter a valid UniFi Protect controller address, username and password.");
    homebridge.hideSpinner();

    return false;
  }

  try {

    const { devices, error } = await homebridge.request("/getDevices", { address: address, password: password, username: username });

    // Couldn't connect to the Protect controller. The two guidance sentences frame the failure and the controller-sourced error detail arrives with the device-list
    // response, rendered as text so it is never interpreted as markup.
    if(!devices?.length) {

      renderLoginError([ "Unable to login to the UniFi Protect controller.", "Please check your controller address, username, and password." ], error);
      homebridge.hideSpinner();

      return false;
    }

    // Persist the validated credentials through the framework's single write seam. We own the shape of the write - credentials live under the primary controller, which
    // withPrimaryCredentials encodes while preserving any additional controllers - and the session owns persistence and the preservation of sibling platform entries.
    await commit(withPrimaryCredentials(config, { address, password, username }));

    return true;
  } catch(err) {

    // The fallible sequence above can throw when the UI server fails to start or respond, or when the config write rejects. Rendering into the login display keeps the
    // user on the form with concrete guidance and the specific failure, while the framework's toast stays the generic net for consumers without their own handling -
    // this catch resolves first, so that toast never fires for this plugin.
    renderLoginError(["Unable to complete the plugin configuration."], (err instanceof Error) ? err.message : String(err));
    homebridge.hideSpinner();

    return false;
  }
};

// The Protect API represents the controller itself as a device whose model key is "nvr" - every other model key belongs to a device the controller manages.
const isController = (device) => device.modelKey === "nvr";

// Return the list of controllers from our plugin configuration. The framework injects our primary platform-config entry; we map each configured controller to the
// sidebar shape, deliberately carrying no credentials into the rendered list.
const getControllers = ({ config }) => controllers(config).map((controller) => ({ name: controller.address, serialNumber: controller.address }));

// Return the list of devices associated with a given Protect controller, paired with the connection outcome. The framework injects the live platform config alongside
// the selected controller, so we can recover the selected controller's credentials (which the sidebar entries deliberately omit) without reaching for the config
// ourselves. A connection failure travels back on the result rather than through a separate request.
const getDevices = async (selectedController, { config }) => {

  // The global context legitimately has no devices and no failure.
  if(!selectedController) {

    return { devices: [], error: "" };
  }

  // Find the entry in our plugin configuration. A sidebar entry can outlive a Settings-tab edit that removed its controller, so a miss is a carried failure with an
  // actionable message rather than a silent empty result that would render nothing the user can act on.
  const controller = controllers(config).find((c) => c.address === selectedController.serialNumber);

  if(!controller) {

    return { devices: [], error: "The selected controller is no longer in the plugin configuration." };
  }

  // The browser cannot reach the Protect controller directly, so we bridge the request through the plugin's UI server, which holds the controller credentials. The
  // server returns the device list and the connection error together.
  const { devices, error } = await homebridge.request("/getDevices", { address: controller.address, password: controller.password, username: controller.username });

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

  return { devices, error };
};

// Only show feature options that are valid for the capabilities of this device.
const validOption = (device, option) => {

  // Each device's capability metadata takes a different shape, so five independent meta-gates test for exclusion below, and any one hiding the option is
  // enough: hasAccessFeature reads the Access device's feature flags, hasFeature reads the Protect device's feature flags, hasProperty checks whether the
  // named property is merely present on the device, modelKey compares the device's own model against the option's supported models, and hasSmartObjectType
  // compares the device's smart-detection capabilities against the option's supported smart-object types.
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

  // Compute the IP-address value: cameras and most devices report a host. A device without one is reached over LoRa (SuperLink) or, for a sensor specifically, over
  // Bluetooth. The relay is a LoRa device but reports a null connectionType on the wire, so we key it by model instead; everything else reports none.
  const isSuperLink = (device.connectionType === "lora") || (device.modelKey === "relay");

  const ipValue = device.host ?? (isSuperLink ? "SuperLink Device" : ((device.modelKey === "sensor") ? "Bluetooth Device" : "None"));

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

    // The delay before the connection-error view re-enables its retry button, overriding the library's five-second default. A UniFi Protect controller can take well
    // over five seconds to authenticate and return its bootstrap, so twenty seconds keeps an impatient user from hammering retry while the first connection attempt is
    // still in flight.
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
