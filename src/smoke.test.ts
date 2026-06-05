/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * smoke.test.ts: End-to-end smoke check for the test rig itself.
 *
 * This file exists so a fresh checkout can immediately confirm "the rig is wired": Node's --strip-types loader handles TypeScript-only syntax in src/, the
 * node:test runner discovers files matching the configured glob, and node:assert/strict is callable. If any of those breaks, this file is the first thing to
 * fail, with a clear pointer to the rig itself rather than to a specific feature's tests.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

// A typed generic identity function. Its sole purpose is to put TypeScript-only syntax (the generic parameter) into a file that --strip-types must parse: if
// the flag is not engaged, the runner will fail with a syntax error on the <T>. The runtime behavior is trivial...the value flows through unchanged.
const identity = <T>(value: T): T => value;

describe("test rig smoke", () => {

  test("node:test runs against TypeScript source via --strip-types and node:assert/strict is wired", () => {

    assert.equal(identity(42), 42, "the typed identity returns its argument verbatim");
    assert.equal(typeof identity("hello"), "string", "the generic is inferred at the call site and the runtime value is correct");
  });
});
