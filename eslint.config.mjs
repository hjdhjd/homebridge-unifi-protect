/* Copyright(C) 2017-2024, HJD (https://github.com/hjdhjd). All rights reserved.
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

    files: [ "src/**.ts", "src/devices/**.ts", "src/ffmpeg/**.ts" ],
    rules: {

      ...hbPluginUtils.rules.ts
    }
  },

  {

    files: [ "ui/lib/**.mjs", "eslint.config.mjs" ],
    rules: {

      ...hbPluginUtils.rules.js
    }
  },

  {

    files: [ "src/**.ts", "src/devices/**.ts", "src/ffmpeg/**.ts", "homebridge-ui/*.@(js|mjs)", "homebridge-ui/public/**/*.@(js|mjs)", "eslint.config.mjs" ],

    ignores: [ "dist" ],

    languageOptions: {

      ecmaVersion: "latest",
      parser: tsParser,
      parserOptions: {

        ecmaVersion: "latest",
        project: "./tsconfig.json"
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

    files: [ "homebridge-ui/public/lib/webUi.mjs", "homebridge-ui/public/lib/webUi-featureoptions.mjs" ],

    languageOptions: {

      globals: {

        ...hbPluginUtils.globals.ui
      }
    }
  },

  {

    files: [ "homebridge-ui/server.js" ],

    languageOptions: {

      globals: {

        console: "readonly",
        fetch: "readonly"
      }
    }
  }
);
