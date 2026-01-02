/* Copyright(C) 2017-2025, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * eslint.config.mjs: Linting defaults for Homebridge plugins.
 */
import eslintJs from "@eslint/js";
import hbPluginUtils from "homebridge-plugin-utils/build/eslint-rules.mjs";
import ts from "typescript-eslint";
import tsParser from "@typescript-eslint/parser";

export default ts.config(

  eslintJs.configs.recommended,

  {

    files: [ "src/**.ts", "src/devices/**.ts" ],
    rules: {

      ...hbPluginUtils.rules.ts
    }
  },

  {

    files: [ "homebridge-ui/public/**/*.@(js|mjs)", "homebridge-ui/server.js", "eslint.config.mjs" ],
    rules: {

      ...hbPluginUtils.rules.js
    }
  },

  {

    files: [ "src/**.ts", "src/devices/**.ts", "homebridge-ui/*.@(js|mjs)", "homebridge-ui/public/**/*.@(js|mjs)", "eslint.config.mjs" ],

    ignores: ["dist"],

    languageOptions: {

      ecmaVersion: "latest",
      parser: tsParser,
      parserOptions: {

        ecmaVersion: "latest",

        projectService: {

          allowDefaultProject: [ "eslint.config.mjs", "homebridge-ui/*.@(js|mjs)", "homebridge-ui/public/*.@(js|mjs)", "homebridge-ui/public/lib/*.@(js|mjs)" ],
          defaultProject: "./tsconfig.json"
        }
      },

      sourceType: "module"
    },

    linterOptions: {

      reportUnusedDisableDirectives: "error"
    },

    plugins: {

      ...hbPluginUtils.plugins
    },

    rules: {

      ...hbPluginUtils.rules.common
    }
  },

  {

    files: [ "homebridge-ui/public/lib/webUi.mjs", "homebridge-ui/public/lib/webUi-featureoptions.mjs", "homebridge-ui/public/ui.mjs" ],

    languageOptions: {

      globals: {

        ...hbPluginUtils.globals.ui
      }
    }
  },

  {

    files: ["homebridge-ui/server.js"],

    languageOptions: {

      globals: {

        console: "readonly",
        fetch: "readonly"
      }
    }
  }
);
