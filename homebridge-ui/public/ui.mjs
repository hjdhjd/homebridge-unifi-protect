/* Copyright(C) 2017-2023, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ui.mjs: HBUP webUI.
 */
"use strict";

// Keep a list of all the feature options and option groups. We dynamically import our modules to avoid browser caches.
const featureOptions = new (await import("./protect-featureoptions.mjs")).ProtectFeatureOptions();

// Show the first run user experience if we don't have valid login credentials.
function showFirstRun () {

  const buttonFirstRun = document.getElementById("firstRun");
  const inputAddress = document.getElementById("address");
  const inputUsername = document.getElementById("username");
  const inputPassword = document.getElementById("password");
  const tdLoginError = document.getElementById("loginError");

  // If we don't have any controllers configured, initialize the list.
  if(!featureOptions.currentConfig[0].controllers) {

    featureOptions.currentConfig[0].controllers = [ {} ];
  }

  // Pre-populate with anything we might already have in our configuration.
  inputAddress.value = featureOptions.currentConfig[0].controllers[0].address ?? "";
  inputUsername.value = featureOptions.currentConfig[0].controllers[0].username ?? "";
  inputPassword.value = featureOptions.currentConfig[0].controllers[0].password ?? "";

  // Clear login error messages when the login credentials change.
  inputAddress.addEventListener("input", () => {

    tdLoginError.innerHTML = "&nbsp;";
  });

  inputUsername.addEventListener("input", () => {

    tdLoginError.innerHTML = "&nbsp;";
  });

  inputPassword.addEventListener("input", () => {

    tdLoginError.innerHTML = "&nbsp;";
  });

  // First run user experience.
  buttonFirstRun.addEventListener("click", async () => {

    // Show the beachball while we setup.
    homebridge.showSpinner();

    const address = inputAddress.value;
    const username = inputUsername.value;
    const password = inputPassword.value;

    tdLoginError.innerHTML = "&nbsp;";

    if(!address?.length || !username?.length || !password?.length) {

      tdLoginError.appendChild(document.createTextNode("Please enter a valid UniFi Protect controller address, username and password."));
      homebridge.hideSpinner();
      return;
    }

    const ufpDevices = await homebridge.request("/getDevices", { address: address, username: username, password: password });

    // Couldn't connect to the Protect controller for some reason.
    if(!ufpDevices?.length) {

      tdLoginError.innerHTML = "Unable to login to the UniFi Protect controller.<br>Please check your controller address, username, and password.<br><code class=\"text-danger\">" + (await homebridge.request("/getErrorMessage")) + "</code>";
      homebridge.hideSpinner();
      return;
    }

    // Save the login credentials to our configuration.
    featureOptions.currentConfig[0].controllers[0].address = address;
    featureOptions.currentConfig[0].controllers[0].username = username;
    featureOptions.currentConfig[0].controllers[0].password = password;

    await homebridge.updatePluginConfig(featureOptions.currentConfig);

    // Create our UI.
    document.getElementById("pageFirstRun").style.display = "none";
    document.getElementById("menuWrapper").style.display = "inline-flex";
    featureOptions.showUI();
  });

  document.getElementById("pageFirstRun").style.display = "block";
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

  // If we've got a valid Protect controller, username, and password configured, we launch our feature option UI. Otherwise, we launch our first run UI.
  if(featureOptions.currentConfig.length && featureOptions.currentConfig[0].controllers?.length && featureOptions.currentConfig[0].controllers[0]?.address?.length && featureOptions.currentConfig[0].controllers[0]?.username?.length && featureOptions.currentConfig[0].controllers[0]?.password?.length) {

    document.getElementById("menuWrapper").style.display = "inline-flex";
    featureOptions.showUI();
    return;
  }

  // If we have no configuration, let's create one.
  if(!featureOptions.currentConfig.length) {

    featureOptions.currentConfig.push({ controllers: [ {} ], name: "UniFi Protect" });
  } else if(!("name" in featureOptions.currentConfig[0])) {

    // If we haven't set the name, let's do so now.
    featureOptions.currentConfig[0].name = "UniFi Protect";
  }

  // Update the plugin configuration and launch the first run UI.
  await homebridge.updatePluginConfig(featureOptions.currentConfig);
  showFirstRun();
}

// Fire off our UI, catching errors along the way.
try {

  launchWebUI();
} catch(err) {

  // If we had an error instantiating or updating the UI, notify the user.
  homebridge.toast.error(err.message, "Error");
} finally {

  // Always leave the UI in a usable place for the end user.
  homebridge.hideSpinner();
}
