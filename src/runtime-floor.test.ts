/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * runtime-floor.test.ts: The engines-keyed conformance guard for this package's Node runtime floor. While `engines.node` sits below the Node release that parses
 * explicit-resource-management syntax, this suite asserts the raw-JavaScript Config UI server carries no `await using` declaration and no shipped source constructs a
 * DisposableStack. The moment the floor is bumped to that release, the live assertion fails with an enumerated cleanup list - the anti-forget mechanism that turns
 * "restore the await using form" from a thing to remember into a thing the suite demands.
 *
 * What is left here is this package's policy alone: which major closes the gap, what its detectors look for, what its checklist enumerates, and which files its scans
 * read. The mechanism those feed - reading the engines floor, deciding the regime, walking the shipped source, firing the sunset - is the shared machinery in
 * `homebridge-plugin-utils/testing`, which the whole family drives with its own policy.
 */
import { assertRuntimeFloorCompat, parseRuntimeFloor, planRuntimeFloorCheck, readEnginesNode, sweepSourceFiles } from "homebridge-plugin-utils/testing";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// The major version of the Node release that first parses explicit-resource-management syntax (`await using`/`using`) and ships DisposableStack as a platform global.
// At or above this floor the raw-JavaScript workaround is redundant and the sunset runs; below it the workaround is required.
const NODE_ERM_GLOBAL_MAJOR = 24;

// The enumerated cleanup the live assertion emits the moment the engines floor reaches the ERM-capable release. It names every artifact to restore or remove so the
// sunset is a mechanical checklist. The synthetic sunset-regime test asserts these fragments are present, so this path runs green today.
const SUNSET_CLEANUP = [

  "The Node runtime floor has reached the release that parses explicit-resource-management syntax, so the raw-JavaScript try/finally workaround is now redundant.",
  "Complete the sunset: restore the `await using client = ...` declaration in homebridge-ui/server.js #registerGetDevices() in place of the inner try/finally",
  "disposal, then delete this file."
].join(" ");

// Match an explicit-resource-management declaration - `using x =` or `await using x =` - in statement OR embedded position. The negative lookbehind rejects a `using`
// that is part of a longer identifier (like `focusing`) or a member access (like `foo.using`). The raw-JavaScript server must carry none of these while the engines
// floor is below the Node runtime that parses the syntax, or a Config UI host on the older runtime fails to parse the file.
const ERM_DECLARATION = /(?<![\w.])(?:await\s+)?using\s+[A-Za-z_$][\w$]*\s*=/;

// Detect a bare `new DisposableStack()` / `new AsyncDisposableStack()` construction. This package ships no shim for either, so any occurrence in host-Node source while
// the floor is below the platform-global release is an unguarded leak that would throw on Node 22.
const NEW_DISPOSABLE_STACK = /new\s+DisposableStack\s*\(/;
const NEW_ASYNC_DISPOSABLE_STACK = /new\s+AsyncDisposableStack\s*\(/;

// Strip line and block comments from source so the ERM-declaration scan sees code only. This is deliberately naive - a `//` or `/* */` sequence inside a string literal
// would be removed too - which is an accepted residual risk: the rewritten server comment names `await using` freely, and this stripper keeps that comment text from
// tripping the code-only scan. String literals carrying an ERM-declaration shape are the one false-negative this cannot see, and the server ships none.
function stripComments(source: string): string {

  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

describe("HBUP runtime floor - regime helper", () => {

  test("parses the compat floor and selects the compat regime", () => {

    const result = parseRuntimeFloor({ enginesNode: ">=22.20", sunsetMajor: NODE_ERM_GLOBAL_MAJOR });

    assert.equal(result.major, 22);
    assert.equal(result.regime, "compat");
  });

  test("parses a >=24 floor and selects the sunset regime", () => {

    const result = parseRuntimeFloor({ enginesNode: ">=24", sunsetMajor: NODE_ERM_GLOBAL_MAJOR });

    assert.equal(result.major, 24);
    assert.equal(result.regime, "sunset");
  });

  test("parses a ^24 floor and selects the sunset regime", () => {

    assert.equal(parseRuntimeFloor({ enginesNode: "^24", sunsetMajor: NODE_ERM_GLOBAL_MAJOR }).regime, "sunset");
  });

  test("throws on an unparseable engines value", () => {

    assert.throws(() => parseRuntimeFloor({ enginesNode: "not-a-version", sunsetMajor: NODE_ERM_GLOBAL_MAJOR }), /Unable to parse/);
  });

  test("the sunset regime produces the enumerated cleanup plan", () => {

    const plan = planRuntimeFloorCheck({ enginesNode: ">=24", sunsetMajor: NODE_ERM_GLOBAL_MAJOR, sunsetMessage: SUNSET_CLEANUP });

    assert.equal(plan.kind, "sunset");

    // The assert.equal above narrows plan to the sunset variant, so plan.message is in scope here.
    const expectedFragments = [ "await using", "homebridge-ui/server.js", "this file" ];

    for(const fragment of expectedFragments) {

      assert.ok(plan.message.includes(fragment), "the sunset cleanup enumerates " + fragment);
    }
  });

  test("the compat regime selects the source sweep plan", () => {

    assert.equal(planRuntimeFloorCheck({ enginesNode: ">=22.20", sunsetMajor: NODE_ERM_GLOBAL_MAJOR, sunsetMessage: SUNSET_CLEANUP }).kind, "sweep");
  });
});

describe("HBUP runtime floor - live conformance", () => {

  test("the engines floor keeps the raw-JS regime, server.js carries no ERM declaration, and no shipped source constructs a DisposableStack", async () => {

    // The regime derives from nothing but the package's own declared runtime floor - the single source of truth for what the plugin supports.
    const plan = planRuntimeFloorCheck({ enginesNode: await readEnginesNode(new URL("../", import.meta.url)), sunsetMajor: NODE_ERM_GLOBAL_MAJOR,
      sunsetMessage: SUNSET_CLEANUP });

    // The floor reached the ERM-capable release: fail with the enumerated cleanup so the raw-JS workaround cannot silently outlive the runtime it works around.
    assertRuntimeFloorCompat(plan);

    // Self-test the detectors so a silently-broken pattern fails loudly rather than reporting a false all-clear. The ERM detector must catch statement and embedded
    // forms while rejecting `using` embedded in a longer identifier, and the DisposableStack detector must catch a synthetic construction.
    assert.match("await using x = y;", ERM_DECLARATION, "the ERM detector must match a statement-position declaration");
    assert.match("{ using a = b;", ERM_DECLARATION, "the ERM detector must match an embedded declaration");
    assert.doesNotMatch("refusing y = z;", ERM_DECLARATION, "the ERM detector must not match 'using' embedded in a longer identifier");
    assert.match("const s = new DisposableStack();", NEW_DISPOSABLE_STACK, "the DisposableStack detector must match a synthetic positive");

    // The raw-JavaScript Config UI server, comment-stripped, must carry no ERM declaration syntax - the exact syntax that fails to parse on a Node 22 Config UI host -
    // and must construct neither DisposableStack variant.
    const serverCode = stripComments(await readFile(new URL("../homebridge-ui/server.js", import.meta.url), "utf8"));

    assert.doesNotMatch(serverCode, ERM_DECLARATION, "homebridge-ui/server.js carries an await using / using declaration in code");
    assert.doesNotMatch(serverCode, NEW_DISPOSABLE_STACK, "homebridge-ui/server.js constructs a DisposableStack");
    assert.doesNotMatch(serverCode, NEW_ASYNC_DISPOSABLE_STACK, "homebridge-ui/server.js constructs an AsyncDisposableStack");

    // The shipped host-Node source this package holds to the rule: every `.ts` under `src/`. The `homebridge-ui/public/` tree is browser-side and out of scope for the
    // host runtime floor, and compiled `dist/` is not swept because tsc preserves bare globals verbatim from `src`, so the source sweep is the same guard without a
    // build-freshness dependency.
    const files = await sweepSourceFiles({ roots: [new URL(".", import.meta.url)] });

    // A mis-scoped walk that enumerates almost nothing must fail loudly rather than pass vacuously.
    assert.ok(files.length >= 20, "the source walk enumerated " + files.length.toString() + " files, expected at least 20");

    // This package ships no shim, so any DisposableStack construction in host-Node source while the floor is below the platform-global release would throw on Node 22.
    for(const file of files) {

      assert.doesNotMatch(file.text, NEW_DISPOSABLE_STACK, file.path + " constructs a DisposableStack, but this package ships no shim for the Node 22 floor");
      assert.doesNotMatch(file.text, NEW_ASYNC_DISPOSABLE_STACK, file.path + " constructs an AsyncDisposableStack, but this package ships no shim for the Node 22 floor");
    }
  });
});
