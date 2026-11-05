/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * server.js: homebridge-unifi-protect webUI server API.
 *
 * This module is heavily inspired by, and borrows from, the homebridge-config-ui-x source code.
 * Thank you oznu for your contributions to the HomeKit world.
 */
"use strict";

import { ProtectClient, isDeviceAdopted, noopLog } from "unifi-protect";
import { UNREPORTED_CONTROLLER_RECORD, UNSUPPORTED_PROTECT_VERSION, isSupportedProtectVersion } from "../dist/nvr/nvr-policy.js";
import { featureOptionCategories, featureOptions } from "../dist/options.js";
import { HomebridgePluginUiServer } from "@homebridge/plugin-ui-utils";
import { composeMigrationPatch } from "../dist/options-legacy.js";
import { deviceDisplayName } from "../dist/devices/device-descriptor.js";
import util from "node:util";

class PluginUiServer extends HomebridgePluginUiServer {

  constructor() {

    super();

    this.#registerGetDevices();

    this.#registerGetOptions();

    this.#registerTranslateOptions();

    this.ready();
  }

  #registerGetDevices() {

    // Retrieve the list of devices from a Protect controller to populate the feature options device picker.
    this.onRequest("/getDevices", async (controller) => {

      // The connection outcome is probe-local state that travels back with the device list: a failed probe fills this with a user-facing message and the response
      // returns it alongside an empty device array, so the webUI reads the failure from the response it belongs to.
      let errorInfo = "";

      // A quiet logging shim for the short-lived client: debug/info/warn stay silent (noopLog), while error captures the message so the probe can return the most
      // recent failure reason to the user. The unifi-protect ProtectLogging signature is (message, ...parameters), so we spread the rest parameters into util.format.
      const log = { ...noopLog, error: (message, ...parameters) => {

        errorInfo = util.format(message, ...parameters);

        // eslint-disable-next-line no-console -- The settings server has no logger of its own, so it deliberately reports a controller error on the console.
        console.error(errorInfo);
      } };

      try {

        /* The address is read trimmed, because the plugin reads a listed controller's address trimmed, so the connect below reaches the controller the plugin
         * connects to. The request keeps the address as stored, the spelling every lookup on the page finds its controller by. A hand edit can leave the address
         * something other than a string, which is passed on as it stands, so the connect refuses it inside this try as a configuration error, and the page shows
         * that refusal's sentence as its answer.
         */
        const address = (typeof controller.address === "string") ? controller.address.trim() : controller.address;

        // Connect to the controller. unifi-protect's connect() performs login and the initial bootstrap atomically, throwing a typed error on failure. This file ships
        // as raw JavaScript executed directly by the host's Node runtime with no transpile step, so an `await using` declaration (explicit-resource-management syntax,
        // which the Node 24 runtime provides) cannot appear here while the package's engines floor is below Node 24. The inner try/finally is the equivalent: it
        // guarantees the client and its realtime connection are released on every exit path, success or throw. We disable the periodic refresh failsafe since this is a
        // one-shot discovery probe. When the engines floor reaches Node 24, an `await using` declaration is the preferred form.
        const client = await ProtectClient.connect({ host: address, log: log, password: controller.password, refreshIntervalMs: false,
          username: controller.username });

        try {

          /* A controller the plugin cannot start on is refused here too, in the plugin's own sentences. A record with no version has a sentence of its own, because
           * telling someone to upgrade a version nobody reported is false. The catch below says what is thrown and answers it as it does any failure of this probe, and
           * the finally still releases the client.
           */
          const { version } = client.nvr.config;

          if(typeof version !== "string") {

            throw new Error(UNREPORTED_CONTROLLER_RECORD);
          }

          if(!isSupportedProtectVersion(version)) {

            throw new Error(UNSUPPORTED_PROTECT_VERSION);
          }

          /* Project each live device collection to its raw config record, keep only the devices adopted by this controller, name each as HomeKit names its accessory
           * with no custom name applied, and sort by that name. We read the config records rather than the command-bearing projections because the webUI consumes
           * plain controller fields and serializes them across the request boundary. The name is the plugin's own rule, read from the compiled module the runtime
           * names accessories with, and it travels in a field of its own beside the controller's name, so the page applies only the custom name being edited, which
           * it reads from the configuration it already holds, and shows an edit before anything is saved.
           */
          const adopted = (devices) => devices.map(device => device.config).filter(isDeviceAdopted).map(config => ({ ...config, homeKitName: deviceDisplayName(config) }))
            .sort((a, b) => a.homeKitName.localeCompare(b.homeKitName));

          // Return the controller first, then the adopted devices by category, paired with an empty error. The controller is element 0 - the controller-as-device
          // entry the feature options webUI selects on initial load.
          return { devices: [ client.nvr.config, ...adopted(client.cameras), ...adopted(client.chimes), ...adopted(client.fobs), ...adopted(client.lights),
            ...adopted(client.relays), ...adopted(client.sensors), ...adopted(client.viewers) ], error: "" };
        } finally {

          // Release the client and its realtime connection on every exit path... the raw-JavaScript equivalent of an `await using` declaration's scope-bound disposal.
          await client[Symbol.asyncDispose]();
        }
      } catch(error) {

        // The library reports failures through the log shim above, which captured a friendly message into errorInfo and already logged it. The typed transport errors,
        // however, propagate WITHOUT logging - so when errorInfo is still empty we capture the thrown error's friendly .message and log that single clean sentence here.
        // We never log the raw error object, which would dump its stack and chained cause into the log; and the empty-errorInfo guard avoids logging the same failure
        // twice when the shim already reported it.
        if(!errorInfo) {

          errorInfo = (error instanceof Error) ? error.message : String(error);

          // eslint-disable-next-line no-console -- The settings server has no logger of its own, so it deliberately reports a controller error on the console.
          console.error(errorInfo);
        }

        return { devices: [], error: errorInfo };
      }
    });
  }

  #registerGetOptions() {

    // Return the full feature-option category and option catalog the webUI renders; per-device filtering happens client-side.
    this.onRequest("/getOptions", () => ({ categories: featureOptionCategories, options: featureOptions }));
  }

  #registerTranslateOptions() {

    /* Rewrite a configuration's retired feature option entries into the current grammar, permanently, and answer the single patch the page should commit. The whole of
     * the decision lives in the composed leaf this calls, so it is exercised under node against the real catalog rather than only in the browser: which array the
     * translation runs over, whether the result is worth writing, and how it composes with the property migration's own patch.
     *
     * A request carrying no topology is the cheap detector and the topology-free rewrite in one round trip. What it reports as remaining is what the caller widens its
     * controller probes to resolve before asking again.
     */
    this.onRequest("/translateOptions", (request) => composeMigrationPatch({

      controllers: Array.isArray(request?.topology) ? request.topology : undefined,
      migratePatch: request?.migratePatch ?? null,
      platformOptions: Array.isArray(request?.platformOptions) ? request.platformOptions : []
    }));
  }
}

(() => new PluginUiServer())();
