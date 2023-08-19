/* Copyright(C) 2017-2023, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * server.js: Homebridge camera streaming delegate implementation for Protect.
 *
 * This module is heavily inspired by the homebridge-config-ui-x source code and borrows from both.
 * Thank you oznu for your contributions to the HomeKit world.
 */
/* eslint-disable no-undef */
/* eslint-disable @typescript-eslint/no-var-requires */
/* jshint node: true,esversion: 9, -W014, -W033 */
/* eslint-disable new-cap */
"use strict";

import { featureOptionCategories, featureOptions, isOptionEnabled } from "../dist/protect-options.js";
import { HomebridgePluginUiServer } from "@homebridge/plugin-ui-utils";
import { ProtectApi } from "unifi-protect";
import * as fs from "node:fs";

class PluginUiServer extends HomebridgePluginUiServer {

  constructor () {
    super();

    // Return the list of Protect devices.
    this.onRequest("/getDevices", async (controller) => {

      try {

        // Connect to the Protect controller.
        const ufpApi = new ProtectApi();

        if(!(await ufpApi.login(controller.address, controller.username, controller.password))) {

          return [];
        }

        // Bootstrap the controller. It will emit a message once it's received the bootstrap JSON, or you can alternatively wait for the Promise to resolve.
        if(!(await ufpApi.getBootstrap())) {

          return [];
        }

        const bootstrap = ufpApi.bootstrap;

        bootstrap.cameras = bootstrap.cameras.filter(x => !x.isAdoptedByOther && x.isAdopted);
        bootstrap.chimes = bootstrap.chimes.filter(x => !x.isAdoptedByOther && x.isAdopted);
        bootstrap.lights = bootstrap.lights.filter(x => !x.isAdoptedByOther && x.isAdopted);
        bootstrap.sensors = bootstrap.sensors.filter(x => !x.isAdoptedByOther && x.isAdopted);
        bootstrap.viewers = bootstrap.viewers.filter(x => !x.isAdoptedByOther && x.isAdopted);

        bootstrap.cameras.sort((a, b) => {

          const aCase = (a.name ?? a.marketName).toLowerCase();
          const bCase = (b.name ?? b.marketName).toLowerCase();

          return aCase > bCase ? 1 : (bCase > aCase ? -1 : 0);
        });

        bootstrap.chimes.sort((a, b) => {

          const aCase = (a.name ?? a.marketName).toLowerCase();
          const bCase = (b.name ?? b.marketName).toLowerCase();

          return aCase > bCase ? 1 : (bCase > aCase ? -1 : 0);
        });

        bootstrap.lights.sort((a, b) => {

          const aCase = (a.name ?? a.marketName).toLowerCase();
          const bCase = (b.name ?? b.marketName).toLowerCase();

          return aCase > bCase ? 1 : (bCase > aCase ? -1 : 0);
        });

        bootstrap.sensors.sort((a, b) => {

          const aCase = (a.name ?? a.marketName).toLowerCase();
          const bCase = (b.name ?? b.marketName).toLowerCase();

          return aCase > bCase ? 1 : (bCase > aCase ? -1 : 0);
        });

        bootstrap.viewers.sort((a, b) => {

          const aCase = (a.name ?? a.marketName).toLowerCase();
          const bCase = (b.name ?? b.marketName).toLowerCase();

          return aCase > bCase ? 1 : (bCase > aCase ? -1 : 0);
        });

        return [ ufpApi.bootstrap.nvr, ...ufpApi.bootstrap.cameras, ...ufpApi.bootstrap.chimes, ...ufpApi.bootstrap.lights, ...ufpApi.bootstrap.sensors, ...ufpApi.bootstrap.viewers ];
      } catch(err) {

        console.log("ERRORING OUT FOR " + controller.address);
        console.log(err);

        // Return nothing if we error out for some reason.
        return [];
      }
    });

    // Return the list of options configured for a given Protect device.
    this.onRequest("/getOptions", async(request) => {

      try {

        const optionSet = {};

        // Loop through all the feature option categories.
        for(const category of featureOptionCategories) {

          optionSet[category.name] = [];

          for(const options of featureOptions[category.name]) {

            options.value = isOptionEnabled(request.configOptions, request.nvrUfp, request.deviceUfp, category.name + "." + options.name, options.default);
            optionSet[category.name].push(options);
          }
        }

        return { categories: featureOptionCategories, options: optionSet };

      } catch(err) {

        // Return nothing if we error out for some reason.
        return {};
      }
    });

    this.ready();
  }
}

(() => new PluginUiServer())();
