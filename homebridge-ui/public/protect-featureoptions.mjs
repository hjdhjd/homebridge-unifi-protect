/* Copyright(C) 2017-2024, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-featureoptions.mjs: Protect feature option webUI.
 */
"use strict";

// Protect-specific customizations for my feature option framework. We import in this odd way to dodge browser caches.
export class ProtectFeatureOptions extends (await import("./lib/featureoptions.mjs")).FeatureOptions {

  // The current plugin configuration.
  currentConfig;

  // Current configuration options selected in the webUI for a given device.
  #configOptions;

  // Table containing the currently displayed feature options.
  #configTable;

  // Our list of Protect controllers.
  #controllerList;

  // Current list of devices on a given controller, for webUI elements.
  #deviceList;

  // Current list of Protect devices from the Protect controller.
  #ufpDevices;

  constructor() {

    super();

    this.configOptions = [];
    this.configTable = document.getElementById("configTable");
    this.controllerList = [];
    this.currentConfig = [];
    this.deviceList = [];
    this.ufpDevices = [];
  }

  // Render the feature option webUI.
  async showUI() {

    // Show the beachball while we setup.
    homebridge.showSpinner();
    homebridge.hideSchemaForm();

    // Make sure we have the refreshed configuration.
    this.currentConfig = await homebridge.getPluginConfig();

    // Create our custom UI.
    document.getElementById("menuHome").classList.remove("btn-elegant");
    document.getElementById("menuHome").classList.add("btn-primary");
    document.getElementById("menuFeatureOptions").classList.add("btn-elegant");
    document.getElementById("menuFeatureOptions").classList.remove("btn-primary");
    document.getElementById("menuSettings").classList.remove("btn-elegant");
    document.getElementById("menuSettings").classList.add("btn-primary");

    // Hide the legacy UI.
    document.getElementById("pageSupport").style.display = "none";
    document.getElementById("pageFeatureOptions").style.display = "block";

    // What we're going to do is display our global options, followed by the list of controllers the user has configured.
    // We pre-select the first controller by default for the user as a starting point.

    // Create the table for the our list of controllers and global options.
    const controllersTable = document.getElementById("controllersTable");

    // Start with a clean slate.
    controllersTable.innerHTML = "";
    document.getElementById("devicesTable").innerHTML = "";
    this.configTable.innerHTML = "";
    this.deviceList = [];

    // Hide the UI until we're ready.
    document.getElementById("sidebar").style.display = "none";
    document.getElementById("headerInfo").style.display = "none";
    document.getElementById("deviceStatsTable").style.display = "none";

    // We haven't configured anything yet - we're done.
    if(!this.currentConfig[0]?.controllers?.length) {

      document.getElementById("headerInfo").innerHTML = "Please configure a UniFi Protect controller to access in the main settings tab before configuring feature options."
      document.getElementById("headerInfo").style.display = "";
      homebridge.hideSpinner();
      return;
    }

    // Enumerate our global options.
    const trGlobal = document.createElement("tr");

    // Create the cell for our global options.
    const tdGlobal = document.createElement("td");
    tdGlobal.classList.add("m-0", "p-0");

    // Create our label target.
    const globalLabel = document.createElement("label");

    globalLabel.name = "Global Options";
    globalLabel.appendChild(document.createTextNode("Global Options"));
    globalLabel.style.cursor = "pointer";
    globalLabel.classList.add("mx-0", "my-2", "p-0", "w-100");

    globalLabel.addEventListener("click", event => this.#showDevices(null));

    // Add the global options label.
    tdGlobal.appendChild(globalLabel);
    tdGlobal.style.fontWeight = "bold";

    // Add the global cell to the table.
    trGlobal.appendChild(tdGlobal);

    // Now add it to the overall controllers table.
    controllersTable.appendChild(trGlobal);

    // Add it as another controller, for UI purposes.
    this.controllerList.push(globalLabel);

    // Create a row for our controllers.
    const trController = document.createElement("tr");

    // Create the cell for our controller category row.
    const tdController = document.createElement("td");
    tdController.classList.add("m-0", "p-0");

    // Add the category name, with appropriate casing.
    tdController.appendChild(document.createTextNode("Protect Controller" + (this.currentConfig[0].controllers.length > 1 ? "s" : "")));
    tdController.style.fontWeight = "bold";

    // Add the cell to the table row.
    trController.appendChild(tdController);

    // Add the table row to the table.
    controllersTable.appendChild(trController);

    for(const controller of this.currentConfig[0].controllers) {

      // Create a row for this controller.
      const trDevice = document.createElement("tr");
      trDevice.classList.add("m-0", "p-0");

      // Create a cell for our controller.
      const tdDevice = document.createElement("td");
      tdDevice.classList.add("m-0", "p-0", "w-100");

      const label = document.createElement("label");

      label.name = controller.address;
      label.appendChild(document.createTextNode(controller.address));
      label.style.cursor = "pointer";
      label.classList.add("mx-2", "my-0", "p-0", "w-100");

      label.addEventListener("click", event => this.#showDevices(controller));

      // Add the controller label to our cell.
      tdDevice.appendChild(label);

      // Add the cell to the table row.
      trDevice.appendChild(tdDevice);

      // Add the table row to the table.
      controllersTable.appendChild(trDevice);

      this.controllerList.push(label);
    }

    // All done. Let the user interact with us.
    homebridge.hideSpinner();

    // Default the user on the first controller.
    this.#showDevices(this.currentConfig[0].controllers[0]);
  }

  // Show the devices attached to a controller.
  async #showDevices(controller) {

    // Show the beachball while we setup.
    homebridge.showSpinner();

    // Make sure we highlight the selected controller so the user knows where we are.
    this.controllerList.map(x => (x.name === (controller ? controller.address : "Global Options")) ?
      x.parentElement.classList.add("bg-info", "text-white") : x.parentElement.classList.remove("bg-info", "text-white"));

    const devicesTable = document.getElementById("devicesTable");
    this.ufpDevices = [];

    // If we're not accessing global options, pull a list of devices attached to this controller.
    if(controller) {

      this.ufpDevices = await homebridge.request("/getDevices", { address: controller.address, username: controller.username, password: controller.password });
    }

    // Couldn't connect to the Protect controller for some reason.
    if(controller && !this.ufpDevices?.length) {

      devicesTable.innerHTML = "";
      this.configTable.innerHTML = "";

      document.getElementById("headerInfo").innerHTML = "Unable to connect to the Protect controller.<br>Check your settings for this controller in the settings tab to verify they are correct.<br><code class=\"text-danger\">" + (await homebridge.request("/getErrorMessage")) + "</code>";
      document.getElementById("headerInfo").style.display = "";
      document.getElementById("deviceStatsTable").style.display = "none";

      homebridge.hideSpinner();
      return;
    }

    // Initialize our informational header.
    document.getElementById("headerInfo").innerHTML = "Feature options are applied in prioritized order, from global to device-specific options:<br><i class=\"text-warning\">Global options</i> (lowest priority) &rarr; <i class=\"text-success\">Protect controller options</i> &rarr; <i class=\"text-info\">Protect device options</i> (highest priority)"

    // Make the UI visible.
    document.getElementById("headerInfo").style.display = "";
    document.getElementById("sidebar").style.display = "";
    document.getElementById("deviceStatsTable").style.display = "";

    const modelKeys = [...new Set(this.ufpDevices.map(x => x.modelKey))];
    this.deviceList = [];

    // The first entry returned by getDevices is always the controller.
    this.controller = this.ufpDevices[0]?.mac ?? "";

    // Start with a clean slate.
    devicesTable.innerHTML = "";

    for(const key of modelKeys) {

      // Get all the devices associated with this device category.
      const devices = this.ufpDevices.filter(x => x.modelKey === key);

      // If it's a controller, we handle that case differently.
      if((key === "nvr") && devices.length) {

        // Change the name of the controller that we show users once we've connected with the controller.
        this.controllerList.map(x => (x.name === controller.address) ? x.childNodes[0].nodeValue = devices[0].name : true);
        continue;
      }

      // Create a row for this device category.
      const trCategory = document.createElement("tr");

      // Create the cell for our device category row.
      const tdCategory = document.createElement("td");
      tdCategory.classList.add("m-0", "p-0");

      // Add the category name, with appropriate casing.
      tdCategory.appendChild(document.createTextNode((key === "nvr") ? "Protect Controller" : (key.charAt(0).toUpperCase() + key.slice(1) + "s")));
      tdCategory.style.fontWeight = "bold";

      // Add the cell to the table row.
      trCategory.appendChild(tdCategory);

      // Add the table row to the table.
      devicesTable.appendChild(trCategory);

      for(const device of devices) {

        // Create a row for this device.
        const trDevice = document.createElement("tr");
        trDevice.classList.add("m-0", "p-0");

        // Create a cell for our device.
        const tdDevice = document.createElement("td");
        tdDevice.classList.add("m-0", "p-0" , "w-100");

        const label = document.createElement("label");

        label.name = device.id;
        label.appendChild(document.createTextNode(device.name ?? device.marketName));
        label.style.cursor = "pointer";
        label.classList.add("mx-2", "my-0", "p-0", "w-100");

        label.addEventListener("click", event => this.#showDeviceInfo(device.id));

        // Add the device label to our cell.
        tdDevice.appendChild(label);

        // Add the cell to the table row.
        trDevice.appendChild(tdDevice);

        // Add the table row to the table.
        devicesTable.appendChild(trDevice);

        this.deviceList.push(label);
      }
    }

    this.configOptions = [];

    // Initialize our feature option configuration.
    this.#updateConfigOptions(this.currentConfig[0].options ?? []);

    // Display the feature options to the user.
    this.#showDeviceInfo(controller ? this.ufpDevices[0].id : null);

    // All done. Let the user interact with us.
    homebridge.hideSpinner();
  }

  // Show feature option information for a specific device, controller, or globally.
  async #showDeviceInfo(deviceId) {

    homebridge.showSpinner();

    // Update the selected device for visibility.
    this.deviceList.map(x => (x.name === deviceId) ? x.parentElement.classList.add("bg-info", "text-white") : x.parentElement.classList.remove("bg-info", "text-white"));

    // Populate the device information info pane.
    const ufpDevice = this.ufpDevices.find(x => x.id === deviceId);

    // Ensure we have a controller or device. The only time this won't be the case is when we're looking at global options.
    if(ufpDevice) {

      document.getElementById("device_model").classList.remove("text-center");
      document.getElementById("device_model").colSpan = 1;
      document.getElementById("device_model").style.fontWeight = "normal";
      document.getElementById("device_model").innerHTML = ufpDevice.marketName ?? ufpDevice.type;
      document.getElementById("device_mac").innerHTML = ufpDevice.mac;
      document.getElementById("device_address").innerHTML = ufpDevice.host ?? (ufpDevice.modelKey === "sensor" ? "Bluetooth Device" : "None");
      document.getElementById("device_online").innerHTML = ("state" in ufpDevice) ? (ufpDevice.state.charAt(0).toUpperCase() + ufpDevice.state.slice(1).toLowerCase()) : "Connected";
      document.getElementById("deviceStatsTable").style.display = "";
    } else {

      document.getElementById("deviceStatsTable").style.display = "none";
      document.getElementById("device_model").classList.remove("text-center");
      document.getElementById("device_model").colSpan = 1;
      document.getElementById("device_model").style.fontWeight = "normal";
      document.getElementById("device_model").innerHTML = "N/A"
      document.getElementById("device_mac").innerHTML = "N/A";
      document.getElementById("device_address").innerHTML = "N/A";
      document.getElementById("device_online").innerHTML = "N/A";
    }

    // Populate the feature options selected for this device.
    const ufpFeatures = await homebridge.request("/getOptions", { configOptions: this.configOptions, nvrUfp: this.ufpDevices[0], deviceUfp: ufpDevice });
    const optionsDevice = ufpFeatures.options;

    // Start with a clean slate.
    let newConfigTableHtml = "";
    this.configTable.innerHTML = "";

    // Initialize the full list of options.
    this.featureOptionList = {};
    this.featureOptionGroups = {};

    for(const category of ufpFeatures.categories) {

      // Now enumerate all the feature options for a given device and add then to the full list.
      for(const option of optionsDevice[category.name]) {

        const featureOption = category.name + (option.name.length ? ("." + option.name): "");

        // Add it to our full list.
        this.featureOptionList[featureOption] = option;

        // Cross reference the feature option group it belongs to, if any.
        if(option.group !== undefined) {

          const expandedGroup = category.name + (option.group.length ? ("." + option.group): "");

          // Initialize the group entry if needed.
          if(!this.featureOptionGroups[expandedGroup]) {

            this.featureOptionGroups[expandedGroup] = [];
          }

          this.featureOptionGroups[expandedGroup].push(featureOption);
        }
      }
    }

    for(const category of ufpFeatures.categories) {

      // Only show feature option categories that are valid for this context.
      if(ufpDevice && (ufpDevice.modelKey !== "nvr") && !category.modelKey.some(x => (x === ufpDevice.modelKey) || x === "all")) {

        continue;
      }

      const optionTable = document.createElement("table");
      const thead = document.createElement("thead");
      const tbody = document.createElement("tbody");
      const trFirst = document.createElement("tr");
      const th = document.createElement("th");

      // Set our table options.
      optionTable.classList.add("table", "table-borderless", "table-sm", "table-hover");
      th.classList.add("p-0");
      th.style.fontWeight = "bold";
      th.colSpan = 3;
      tbody.classList.add("table-bordered");

      // Add the feature option category description.
      th.appendChild(document.createTextNode(category.description +
        (!ufpDevice ? " (Global)" : (ufpDevice.modelKey === "nvr" ? " (Controller-wide)" : " (Device-specific)"))));

      // Add the table header to the row.
      trFirst.appendChild(th);

      // Add the table row to the table head.
      thead.appendChild(trFirst);

      // Finally, add the table head to the table.
      optionTable.appendChild(thead);

      // Keep track of the number of options we have made available in a given category.
      let optionsVisibleCount = 0;

      // Now enumerate all the feature options for a given device.
      for(const option of optionsDevice[category.name]) {

        // Only show feature options that are valid for this device.
        if(ufpDevice && (ufpDevice.modelKey !== "nvr") && (
          (option.hasFeature && (!ufpDevice.featureFlags || !option.hasFeature.some(x => ufpDevice.featureFlags[x]))) ||
          (option.hasProperty && !option.hasProperty.some(x => x in ufpDevice)) ||
          (option.modelKey && (option.modelKey !== "all") && !option.modelKey.includes(ufpDevice.modelKey)) ||
          (option.hasSmartObjectType && ufpDevice.featureFlags?.smartDetectTypes && !option.hasSmartObjectType.some(x => ufpDevice.featureFlags.smartDetectTypes.includes(x))))) {

          continue;
        }

        // Expand the full feature option.
        const featureOption = category.name + (option.name.length ? ("." + option.name): "");

        // Create the next table row.
        const trX = document.createElement("tr");
        trX.classList.add("align-top");
        trX.id = "row-" + featureOption;

        // Create a checkbox for the option.
        const tdCheckbox = document.createElement("td");

        // Create the actual checkbox for the option.
        const checkbox = document.createElement("input");

        checkbox.type = "checkbox";
        checkbox.readOnly = false;
        checkbox.id = featureOption;
        checkbox.name = featureOption;
        checkbox.value = featureOption + (!ufpDevice ? "" : ("." + ufpDevice.mac));

        let initialValue = undefined;
        let initialScope;

        // Determine our initial option scope to show the user what's been set.
        switch(initialScope = this.optionScope(featureOption, ufpDevice?.mac, option.default, ("defaultValue" in option))) {

          case "global":
          case "controller":

            // If we're looking at the global scope, show the option value. Otherwise, we show that we're inheriting a value from the scope above.
            if(!ufpDevice) {

              if("defaultValue" in option) {

                checkbox.checked = this.isOptionValueSet(featureOption);
                initialValue = this.getOptionValue(checkbox.id);
              } else {

                checkbox.checked = this.isGlobalOptionEnabled(featureOption, option.default);
              }

              if(checkbox.checked) {

                checkbox.indeterminate = false;
              }

            } else {

              if("defaultValue" in option) {

                initialValue = this.getOptionValue(checkbox.id, (initialScope === "controller") ? this.controller : undefined);
              }

              checkbox.readOnly = checkbox.indeterminate = true;
            }

            break;

          case "device":
          case "none":
          default:

            if("defaultValue" in option) {

              checkbox.checked = this.isOptionValueSet(featureOption, ufpDevice?.mac);
              initialValue = this.getOptionValue(checkbox.id, ufpDevice?.mac);
            } else {

              checkbox.checked = this.isDeviceOptionEnabled(featureOption, ufpDevice?.mac, option.default);
            }

            break;
        }

        checkbox.defaultChecked = option.default;
        checkbox.classList.add("mx-2");

        // Add the checkbox to the table cell.
        tdCheckbox.appendChild(checkbox);

        // Add the checkbox to the table row.
        trX.appendChild(tdCheckbox);

        const tdLabel = document.createElement("td");
        tdLabel.classList.add("w-100");
        tdLabel.colSpan = 2;

        let inputValue = null;

        // Add an input field if we have a value-centric feature option.
        if(("defaultValue" in option)) {

          const tdInput = document.createElement("td");
          tdInput.classList.add("mr-2");
          tdInput.style.width = "10%";

          inputValue = document.createElement("input");
          inputValue.type = "text";
          inputValue.value = initialValue ?? option.defaultValue;
          inputValue.size = 5;
          inputValue.readOnly = !checkbox.checked;

          // Add or remove the setting from our configuration when we've changed our state.
          inputValue.addEventListener("change", async () => {

            // Find the option in our list and delete it if it exists.
            const optionRegex = new RegExp("^(?:Enable|Disable)\\." + checkbox.id + (!ufpDevice ? "" : ("\\." + ufpDevice.mac)) + "\\.[^\\.]+$", "gi");
            const newOptions = this.configOptions.filter(x => !optionRegex.test(x));

            if(checkbox.checked) {

              if(inputValue.value.length) {

                newOptions.push("Enable." + checkbox.value + "." + inputValue.value);
              }
            } else if(checkbox.indeterminate) {

              // If we're in an indeterminate state, we need to traverse the tree to get the upstream value we're inheriting.
              inputValue.value = (ufpDevice?.mac !== this.controller) ? (this.getOptionValue(checkbox.id, this.controller) ?? this.getOptionValue(checkbox.id)) : (this.getOptionValue(checkbox.id) ?? option.defaultValue);
            } else {

              inputValue.value = option.defaultValue;
            }

            // Update our configuration in Homebridge.
            this.currentConfig[0].options = newOptions;
            this.#updateConfigOptions(newOptions);
            await homebridge.updatePluginConfig(this.currentConfig);
          });

          tdInput.appendChild(inputValue);
          trX.appendChild(tdInput);
        }

        // Create a label for the checkbox with our option description.
        const labelDescription = document.createElement("label");
        labelDescription.for = checkbox.id;
        labelDescription.style.cursor = "pointer";
        labelDescription.classList.add("user-select-none", "my-0", "py-0");

        // Highlight options for the user that are different than our defaults.
        const scopeColor = this.optionScopeColor(featureOption, ufpDevice?.mac, option.default, ("defaultValue" in option));

        if(scopeColor) {

          labelDescription.classList.add(scopeColor);
        }

        // Add or remove the setting from our configuration when we've changed our state.
        checkbox.addEventListener("change", async () => {

          // Find the option in our list and delete it if it exists.
          const optionRegex = new RegExp("^(?:Enable|Disable)\\." + checkbox.id + (!ufpDevice ? "" : ("\\." + ufpDevice.mac)) + "$", "gi");
          const newOptions = this.configOptions.filter(x => !optionRegex.test(x));

          // Figure out if we've got the option set upstream.
          let upstreamOption = false;

          // We explicitly want to check for the scope of the feature option above where we are now, so we can appropriately determine what we should show.
          switch(this.optionScope(checkbox.id, (ufpDevice && (ufpDevice.mac !== this.controller)) ? this.controller : null, option.default, ("defaultValue" in option))) {

            case "device":
            case "controller":

              if(ufpDevice.mac !== this.controller) {

                upstreamOption = true;
              }

              break;

            case "global":

              if(ufpDevice) {

                upstreamOption = true;
              }

              break;

            default:

              break;
          }

          // For value-centric feature options, if there's an upstream value assigned above us, we don't allow for an unchecked state as it makes no sense in that context.
          if(checkbox.readOnly && (!("defaultValue" in option) || (("defaultValue" in option) && inputValue && !upstreamOption))) {

            // We're truly unchecked. We need this because a checkbox can be in both an unchecked and indeterminate simultaneously,
            // so we use the readOnly property to let us know that we've just cycled from an indeterminate state.
            checkbox.checked = checkbox.readOnly = false;
          } else if(!checkbox.checked) {

            // If we have an upstream option configured, we reveal a third state to show inheritance of that option and allow the user to select it.
            if(upstreamOption) {

              // We want to set the readOnly property as well, since it will survive a user interaction when they click the checkbox to clear out the
              // indeterminate state. This allows us to effectively cycle between three states.
              checkbox.readOnly = checkbox.indeterminate = true;
            }

            if(("defaultValue" in option) && inputValue) {

              inputValue.readOnly = true;
            }
          } else if(checkbox.checked) {

            // We've explicitly checked this option.
            checkbox.readOnly = checkbox.indeterminate = false;

            if(("defaultValue" in option) && inputValue) {

              inputValue.readOnly = false;
            }
          }

          // The setting is different from the default, highlight it for the user, accounting for upstream scope, and add it to our configuration.
          if(!checkbox.indeterminate && ((checkbox.checked !== option.default) || upstreamOption)) {

            labelDescription.classList.add("text-info");
            newOptions.push((checkbox.checked ? "Enable." : "Disable.") + checkbox.value);
          } else {

            // We've reset to the defaults, remove our highlighting.
            labelDescription.classList.remove("text-info");
          }

          // Update our Homebridge configuration.
          if(("defaultValue" in option) && inputValue) {

            // Inform our value-centric feature option to update Homebridge.
            const changeEvent = new Event("change");

            inputValue.dispatchEvent(changeEvent);
          } else {

            // Update our configuration in Homebridge.
            this.currentConfig[0].options = newOptions;
            this.#updateConfigOptions(newOptions);
            await homebridge.updatePluginConfig(this.currentConfig);
          }

          // If we've reset to defaults, make sure our color coding for scope is reflected.
          if((checkbox.checked === option.default) || checkbox.indeterminate) {

            const scopeColor = this.optionScopeColor(featureOption, ufpDevice?.mac, option.default, ("defaultValue" in option));

            if(scopeColor) {

              labelDescription.classList.add(scopeColor);
            }
          }

          // Adjust visibility of other feature options that depend on us.
          if(this.featureOptionGroups[checkbox.id]) {

            const entryVisibility = this.isOptionEnabled(featureOption, ufpDevice?.mac) ? "" : "none";

            // Lookup each feature option setting and set the visibility accordingly.
            for(const entry of this.featureOptionGroups[checkbox.id]) {

              document.getElementById("row-" + entry).style.display = entryVisibility;
            }
          }
        });

        // Add the actual description for the option after the checkbox.
        labelDescription.appendChild(document.createTextNode(option.description));

        // Add the label to the table cell.
        tdLabel.appendChild(labelDescription);

        // Provide a cell-wide target to click on options.
        tdLabel.addEventListener("click", () => checkbox.click());

        // Add the label table cell to the table row.
        trX.appendChild(tdLabel);

        // Adjust the visibility of the feature option, if it's logically grouped.
        if((option.group !== undefined) && !this.isOptionEnabled(category.name + (option.group.length ? ("." + option.group): ""), ufpDevice?.mac)) {

          trX.style.display = "none";
        } else {

          // Increment the visible option count.
          optionsVisibleCount++;
        }

        // Add the table row to the table body.
        tbody.appendChild(trX);
      }

      // Add the table body to the table.
      optionTable.appendChild(tbody);

      // If we have no options visible in a given category, then hide the entire category.
      if(!optionsVisibleCount) {

        optionTable.style.display = "none";
      }

      // Add the table to the page.
      this.configTable.appendChild(optionTable);
    }

    homebridge.hideSpinner();
  }

  // Update our configuration options.
  #updateConfigOptions(newConfig) {

    // Update our configuration.
    this.configOptions = newConfig;

    // Show all the valid options configured by the user.
    this.optionsList = this.configOptions.filter(x => x.match(/^(Enable|Disable)\.*/gi)).map(x => x.toUpperCase());
  }
}
