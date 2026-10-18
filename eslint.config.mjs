/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * eslint.config.mjs: Linting defaults for Homebridge plugins.
 */
import hbPluginUtils from "homebridge-plugin-utils/eslint";

export default hbPluginUtils({

  // These are the JS and config files that sit outside the main TypeScript project, so the parser needs its default-project fallback to lint them at all.
  allowDefaultProject: [ "eslint.config.mjs", "homebridge-ui/*.@(js|mjs)", "homebridge-ui/public/*.@(js|mjs)" ],
  // The library directory holds a build-time copy of the homebridge-plugin-utils webUI framework, which this repository does not author, so the lint never reads it.
  ignores: ["homebridge-ui/public/lib/**"],
  // Every file here that is not compiled TypeScript takes the plain-JavaScript rule set, which carries none of the type-aware checks.
  js: [ "homebridge-ui/public/controller-actions.mjs", "homebridge-ui/public/protect-config.mjs", "homebridge-ui/public/ui.mjs", "homebridge-ui/server.js",
    "eslint.config.mjs" ],
  // The settings server runs under Node rather than in the browser page, so it takes the Node runtime's globals.
  node: ["homebridge-ui/server.js"],
  ts: ["src/**/*.ts"],
  // The modules the settings page serves run in the browser, so they take the browser globals on top of the plain-JavaScript rules.
  ui: [ "homebridge-ui/public/controller-actions.mjs", "homebridge-ui/public/protect-config.mjs", "homebridge-ui/public/ui.mjs" ]
});
