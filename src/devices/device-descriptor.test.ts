/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * device-descriptor.test.ts: Unit tests for the pure device descriptor (describeDevice) in the importable leaf src/devices/device-descriptor.ts.
 *
 * describeDevice is a pure free function - a config record in, a log descriptor out, no this, no HAP - so the natural coverage is to import the REAL leaf and drive it
 * with plain config objects, exactly as motion-policy.test.ts / chime-volume.test.ts drive their pure leaves. It reproduces the pre-v5 v4 getDeviceName format, so the
 * cases pin the plain and rich modes plus the marketName-empty, no-name, host-empty, and name-override edges the v4 helper handled.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { describeDevice } from "./device-descriptor.ts";

// A representative device config: a named camera carrying a market name, host, and MAC.
const camera = { host: "172.16.0.104", mac: "E438830E6225", marketName: "G5 Flex", name: "Basement Foyer", type: "camera" };

describe("describeDevice", () => {

  test("plain mode renders \"Name [Model]\"", () => {

    assert.equal(describeDevice(camera), "Basement Foyer [G5 Flex]");
  });

  test("rich mode appends the address and MAC for support triage", () => {

    assert.equal(describeDevice(camera, { includeNetwork: true }), "Basement Foyer [G5 Flex] (address: 172.16.0.104 mac: E438830E6225)");
  });

  test("prefers marketName for the model, falling back to the wire type when marketName is empty", () => {

    // The v5 wire can deliver an empty marketName; the descriptor falls through to the raw type - the deliberate `||`, not `??`.
    assert.equal(describeDevice({ ...camera, marketName: "" }), "Basement Foyer [camera]");
  });

  test("falls back to the model for the name when the device carries no user-assigned name", () => {

    assert.equal(describeDevice({ ...camera, name: undefined }), "G5 Flex [G5 Flex]");
  });

  test("omits the address segment when the host is empty, still emitting the MAC", () => {

    assert.equal(describeDevice({ ...camera, host: "" }, { includeNetwork: true }), "Basement Foyer [G5 Flex] (mac: E438830E6225)");
  });

  test("the name override wins over the config name - the controller passes its resolved controllerName", () => {

    assert.equal(describeDevice(camera, { includeNetwork: true, name: "Hubble" }), "Hubble [G5 Flex] (address: 172.16.0.104 mac: E438830E6225)");
  });

  test("a null name override falls back to the config name", () => {

    assert.equal(describeDevice(camera, { name: null }), "Basement Foyer [G5 Flex]");
  });
});
