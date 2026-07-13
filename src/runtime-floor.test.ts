/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * runtime-floor.test.ts: The engines-keyed conformance guard for this package's Node runtime floor. While `engines.node` sits below the Node release that parses
 * explicit-resource-management syntax, this suite asserts the raw-JavaScript Config UI server carries no `await using` declaration and no shipped source constructs a
 * DisposableStack. The moment the floor is bumped to that release, the live assertion fails with an enumerated cleanup list - the anti-forget mechanism that turns
 * "restore the await using form" from a thing to remember into a thing the suite demands.
 */
import { describe, test } from "node:test";
import { readFile, readdir } from "node:fs/promises";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

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

// Parse the Node major version from an `engines.node` range and decide the regime: below the ERM-capable major the raw-JavaScript workaround is required (compat), at
// or above it the workaround must be undone (sunset). We read the first integer run as the major, which is the semantics of every range form we accept (">=22.20",
// "^24", ">=24.0.0"). An unparseable value is a hard failure, never a silent default.
function parseRuntimeFloor(enginesNode: string): { major: number; regime: "compat" | "sunset" } {

  const digits = /(\d+)/.exec(enginesNode)?.[0];

  if(digits === undefined) {

    throw new Error("Unable to parse a Node major version from the engines.node value: " + JSON.stringify(enginesNode) + ".");
  }

  const major = Number(digits);

  return { major, regime: (major >= NODE_ERM_GLOBAL_MAJOR) ? "sunset" : "compat" };
}

// Map an `engines.node` range to the action the live assertion takes: in the sunset regime it fails with the enumerated cleanup, in the compat regime it runs the
// source scan. Both arms of this function execute on every suite run - the synthetic tests drive the sunset arm with ">=24" and the scan arm with ">=22.20", and the
// live assertion drives whichever the real package.json selects - so the sunset canary's firing path is never dead code proven only by a replica.
function planRuntimeFloorCheck(enginesNode: string): { kind: "sunset"; message: string } | { kind: "scan" } {

  const { regime } = parseRuntimeFloor(enginesNode);

  if(regime === "sunset") {

    return { kind: "sunset", message: SUNSET_CLEANUP };
  }

  return { kind: "scan" };
}

// Read the package's own `engines.node`. This test derives its regime from nothing but the package's declared runtime floor - the single source of truth for what the
// plugin supports.
async function readEnginesNode(): Promise<string> {

  const packageJsonText = await readFile(new URL("../package.json", import.meta.url), "utf8");
  const packageJson = JSON.parse(packageJsonText) as { engines?: { node?: unknown } };
  const enginesNode = packageJson.engines?.node;

  if(typeof enginesNode !== "string") {

    throw new Error("The package.json engines.node field is missing or is not a string.");
  }

  return enginesNode;
}

// Strip line and block comments from source so the ERM-declaration scan sees code only. This is deliberately naive - a `//` or `/* */` sequence inside a string literal
// would be removed too - which is an accepted residual risk: the rewritten server comment names `await using` freely, and this stripper keeps that comment text from
// tripping the code-only scan. String literals carrying an ERM-declaration shape are the one false-negative this cannot see, and the server ships none.
function stripComments(source: string): string {

  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

// Enumerate the shipped host-Node source files the sweep inspects: every `.ts` under `src/` except test, helper, and fixture files. The `homebridge-ui/public/` tree is
// browser-side and out of scope for the host runtime floor, and compiled `dist/` is not swept because tsc preserves bare globals verbatim from `src`, so the source
// sweep is the same guard without a build-freshness dependency. Reads run in parallel.
async function sweptSourceFiles(): Promise<{ path: string; text: string }[]> {

  const srcDirectory = fileURLToPath(new URL(".", import.meta.url));
  const relativePaths = await readdir(srcDirectory, { recursive: true });
  const excludedSuffixes = [ ".fixtures.ts", ".helpers.ts", ".test.ts" ];
  const candidatePaths = relativePaths.filter((relativePath) => {

    if(!relativePath.endsWith(".ts")) {

      return false;
    }

    return !excludedSuffixes.some((suffix) => relativePath.endsWith(suffix));
  });

  return Promise.all(candidatePaths.map(async (relativePath) => {

    const fullPath = join(srcDirectory, relativePath);

    return { path: fullPath, text: await readFile(fullPath, "utf8") };
  }));
}

describe("HBUP runtime floor - regime helper", () => {

  test("parses the compat floor and selects the compat regime", () => {

    const result = parseRuntimeFloor(">=22.20");

    assert.equal(result.major, 22);
    assert.equal(result.regime, "compat");
  });

  test("parses a >=24 floor and selects the sunset regime", () => {

    const result = parseRuntimeFloor(">=24");

    assert.equal(result.major, 24);
    assert.equal(result.regime, "sunset");
  });

  test("parses a ^24 floor and selects the sunset regime", () => {

    assert.equal(parseRuntimeFloor("^24").regime, "sunset");
  });

  test("throws on an unparseable engines value", () => {

    assert.throws(() => parseRuntimeFloor("not-a-version"), /Unable to parse/);
  });

  test("the sunset regime produces the enumerated cleanup plan", () => {

    const plan = planRuntimeFloorCheck(">=24");

    assert.equal(plan.kind, "sunset");

    // The assert.equal above narrows plan to the sunset variant, so plan.message is in scope here.
    const expectedFragments = [ "await using", "homebridge-ui/server.js", "this file" ];

    for(const fragment of expectedFragments) {

      assert.ok(plan.message.includes(fragment), "the sunset cleanup enumerates " + fragment);
    }
  });

  test("the compat regime selects the source scan plan", () => {

    assert.equal(planRuntimeFloorCheck(">=22.20").kind, "scan");
  });
});

describe("HBUP runtime floor - live conformance", () => {

  test("the engines floor keeps the raw-JS regime, server.js carries no ERM declaration, and no shipped source constructs a DisposableStack", async () => {

    const plan = planRuntimeFloorCheck(await readEnginesNode());

    // The floor reached the ERM-capable release: fail with the enumerated cleanup so the raw-JS workaround cannot silently outlive the runtime it works around.
    if(plan.kind === "sunset") {

      assert.fail(plan.message);
    }

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

    const files = await sweptSourceFiles();

    // A mis-scoped walk that enumerates almost nothing must fail loudly rather than pass vacuously.
    assert.ok(files.length >= 20, "the source walk enumerated " + files.length.toString() + " files, expected at least 20");

    // This package ships no shim, so any DisposableStack construction in host-Node source while the floor is below the platform-global release would throw on Node 22.
    for(const file of files) {

      assert.doesNotMatch(file.text, NEW_DISPOSABLE_STACK, file.path + " constructs a DisposableStack, but this package ships no shim for the Node 22 floor");
      assert.doesNotMatch(file.text, NEW_ASYNC_DISPOSABLE_STACK, file.path + " constructs an AsyncDisposableStack, but this package ships no shim for the Node 22 floor");
    }
  });
});
