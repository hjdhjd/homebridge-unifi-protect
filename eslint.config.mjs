/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * eslint.config.mjs: Linting defaults for Homebridge plugins.
 */
import hbPluginUtils from "homebridge-plugin-utils/build/eslint-plugin/index.mjs";

export default hbPluginUtils({

  allowDefaultProject: [ "eslint.config.mjs", "homebridge-ui/*.@(js|mjs)", "homebridge-ui/public/*.@(js|mjs)", "homebridge-ui/public/lib/*.@(js|mjs)" ],

  // Test, fixture, and helper files are co-located with production code under src/. They follow the same modern style rules as production but legitimately
  // use a few patterns that the strict production preset would flag:
  //
  // - `describe()` / `test()` from `node:test` return promises whose lifecycle the runner itself manages, so a top-level `test(...)` looks like a floating
  //   promise to the linter even though it is the canonical test definition shape.
  //
  // - Tests routinely narrow `unknown` inputs through guards that, after narrowing, leave subsequent member access as "definitely defined" - the linter then
  //   flags the safety-net optional chain as "unnecessary" even though it is the chain that *enabled* the narrowing.
  //
  // - Test helpers compose mocks with `mock.fn()` and other return values whose types are intentionally permissive; requiring explicit return-type annotations
  //   on every inline test arrow function adds noise without catching real bugs.
  //
  // - Some test callbacks are declared with `Promise<T>` return signatures (because the helper they pass to is async-shaped) but have no meaningful body to
  //   await internally. Enforcing `require-await` here would force a cosmetic `await Promise.resolve()` inside every such callback - we'd rather let the test
  //   express the intent directly. The test code paths are exercised by the runner regardless of the keyword.
  //
  // We turn off only those four rules for test infrastructure so the rest of the strict preset still applies. Mirrors the same admission v5 (unifi-protect) uses
  // so a single test idiom carries across both repos.
  extraConfigs: [
    { files: ["homebridge-ui/server.js"], languageOptions: { globals: { console: "readonly", fetch: "readonly" } } },
    {

      files: [ "**/*.test.ts", "**/*.fixtures.ts", "**/*.helpers.ts" ],
      rules: {

        "@typescript-eslint/explicit-function-return-type": "off",
        "@typescript-eslint/no-floating-promises": "off",
        "@typescript-eslint/no-unnecessary-condition": "off",
        "@typescript-eslint/require-await": "off"
      }
    }
  ],
  js: [ "homebridge-ui/public/**/*.@(js|mjs)", "homebridge-ui/server.js", "eslint.config.mjs" ],
  ts: [ "src/**.ts", "src/devices/**.ts" ],
  ui: [ "homebridge-ui/public/lib/webUi.mjs", "homebridge-ui/public/lib/webUi-featureoptions.mjs", "homebridge-ui/public/ui.mjs" ]
});
