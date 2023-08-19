/* Copyright(C) 2017-2023, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ui.mjs: HBUP webUI.
 */
"use strict";

import { ProtectFeatureOptions } from "./protect-featureoptions.mjs";

// Keep a list of all the feature options and option groups.
const featureOptions = new ProtectFeatureOptions();

// Toggle our enabled state.
async function enablePlugin() {

  // Show the beachball while we setup.
  homebridge.showSpinner();

  // Create our UI.
  document.getElementById("disabledBanner").style.display = "none";
  featureOptions.currentConfig[0].disablePlugin = false;

  await homebridge.updatePluginConfig(featureOptions.currentConfig)
  await homebridge.savePluginConfig()

  // All done. Let the user interact with us.
  homebridge.hideSpinner()
}

// Show a disabled interface.
function showDisabledBanner() {

  document.getElementById("disabledBanner").style.display = "block";
}

// Show an navigation bar at the top of the plugin configuration UI.
function showIntro () {

  const introLink = document.getElementById("introLink");

  introLink.addEventListener("click", () => {

    // Show the beachball while we setup.
    homebridge.showSpinner();

    // Create our UI.
    document.getElementById("pageIntro").style.display = "none";
    document.getElementById("menuWrapper").style.display = "inline-flex";
    showSettings();

    // All done. Let the user interact with us.
    homebridge.hideSpinner();
  });

  document.getElementById("pageIntro").style.display = "block";
}

// Show the main plugin configuration tab.
function showSettings () {

  // Show the beachball while we setup.
  homebridge.showSpinner();

  // Create our UI.
  document.getElementById("menuHome").classList.remove("btn-elegant");
  document.getElementById("menuHome").classList.add("btn-primary");
  document.getElementById("menuFeatureOptions").classList.remove("btn-elegant");
  document.getElementById("menuFeatureOptions").classList.add("btn-primary");
  document.getElementById("menuSettings").classList.add("btn-elegant");
  document.getElementById("menuSettings").classList.remove("btn-primary");

  document.getElementById("pageSupport").style.display = "none";
  document.getElementById("pageFeatureOptions").style.display = "none";

  homebridge.showSchemaForm();

  // All done. Let the user interact with us.
  homebridge.hideSpinner();
}

// Show the support tab.
function showSupport() {

  // Show the beachball while we setup.
  homebridge.showSpinner();
  homebridge.hideSchemaForm();

  // Create our UI.
  document.getElementById("menuHome").classList.add("btn-elegant");
  document.getElementById("menuHome").classList.remove("btn-primary");
  document.getElementById("menuFeatureOptions").classList.remove("btn-elegant");
  document.getElementById("menuFeatureOptions").classList.add("btn-primary");
  document.getElementById("menuSettings").classList.remove("btn-elegant");
  document.getElementById("menuSettings").classList.add("btn-primary");

  document.getElementById("pageSupport").style.display = "block";
  document.getElementById("pageFeatureOptions").style.display = "none";

  // All done. Let the user interact with us.
  homebridge.hideSpinner();
}

// Launch our webUI.
async function launchWebUI() {

  // Retrieve the current plugin configuration.
  featureOptions.currentConfig = await homebridge.getPluginConfig();

  // Add our event listeners to animate the UI.
  menuHome.addEventListener("click", () => showSupport());
  menuFeatureOptions.addEventListener("click", () => featureOptions.showUI());
  menuSettings.addEventListener("click", () => showSettings());
  disabledEnable.addEventListener("click", () => enablePlugin());

  if(featureOptions.currentConfig.length) {

    document.getElementById("menuWrapper").style.display = "inline-flex"
    showSettings();

    // If the plugin's disabled, inform the user.
    if(featureOptions.currentConfig[0].disablePlugin) {

      showDisabledBanner();
    }
  } else {

    featureOptions.currentConfig.push({ name: "UniFi Protect" });
    await homebridge.updatePluginConfig(featureOptions.currentConfig);
    showIntro();
  }
}

// Fire off our UI, catching errors along the way.
try {

  launchWebUI();
} catch (err) {

  // If we had an error instantiating or updating the UI, notify the user.
  homebridge.toast.error(err.message, "Error");
} finally {

  // Always leave the UI in a usable place for the end user.
  homebridge.hideSpinner();
}
