/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * device-descriptor.test.ts: Unit tests for the pure model resolver (describeDeviceModel) and device descriptor (describeDevice) in the importable leaf
 * src/devices/device-descriptor.ts.
 *
 * Both are pure free functions - a config record in, a rendered string out, no this, no HAP - so the natural coverage is to import the REAL leaf and drive them with
 * plain config objects, exactly as motion-policy.test.ts / chime-volume.test.ts drive their pure leaves. They reproduce the established device-name format, so the
 * cases cover the resolver's marketName-present, marketName-empty, marketName-absent, and nothing-reported edges, and the descriptor's plain and rich modes plus its
 * marketName-empty, marketName-absent, no-model, no-name, host-empty, and name-override edges. The absent-field cases are what a controller that omits marketName on
 * some units and type on others actually delivers, and they are written as records that simply lack the key rather than carry an empty one, so a fallback chain that
 * only handles the empty spelling fails here.
 */
import { describe, test } from "node:test";
import { describeDevice, describeDeviceModel } from "./device-descriptor.ts";
import assert from "node:assert/strict";

// A representative device config: a named camera carrying a market name, host, and MAC.
const camera = { host: "172.16.0.104", mac: "E438830E6225", marketName: "G5 Flex", name: "Basement Foyer", type: "camera" };

describe("describeDeviceModel", () => {

  test("prefers the market name the controller reports", () => {

    assert.equal(describeDeviceModel({ marketName: "G5 Flex", type: "UVC G5 Flex" }), "G5 Flex");
  });

  test("an empty market name falls through to the hardware type", () => {

    // The controller wire can deliver an empty marketName; the resolver falls through to the raw type - the deliberate `||`, not `??`.
    assert.equal(describeDeviceModel({ marketName: "", type: "UVC G5 Flex" }), "UVC G5 Flex");
  });

  test("an absent market name falls through to the hardware type", () => {

    assert.equal(describeDeviceModel({ type: "UVC G5 Flex" }), "UVC G5 Flex");
  });

  test("a unit reporting neither field reads as \"unknown\"", () => {

    // The same word the unifi-protect CLI inventory renders for such a unit, so one device shows the same model in both places.
    assert.equal(describeDeviceModel({}), "unknown");
  });
});

describe("describeDevice", () => {

  test("plain mode renders \"Name [Model]\"", () => {

    assert.equal(describeDevice(camera), "Basement Foyer [G5 Flex]");
  });

  test("rich mode appends the address and MAC for support triage", () => {

    assert.equal(describeDevice(camera, { includeNetwork: true }), "Basement Foyer [G5 Flex] (address: 172.16.0.104 mac: E438830E6225)");
  });

  test("prefers marketName for the model, falling back to the wire type when marketName is empty", () => {

    // The controller wire can deliver an empty marketName; the descriptor falls through to the raw type - the deliberate `||`, not `??`.
    assert.equal(describeDevice({ ...camera, marketName: "" }), "Basement Foyer [camera]");
  });

  test("falls back to the wire type for the model when the device reports no market name at all", () => {

    // The controller omits marketName entirely on some units, which is a different record shape from the empty string above and the same rendered outcome.
    const { marketName: _marketName, ...noMarketName } = camera;

    assert.equal(describeDevice(noMarketName), "Basement Foyer [camera]");
  });

  test("renders \"unknown\" for the model when the device reports neither a market name nor a type", () => {

    const { marketName: _marketName, type: _type, ...noModel } = camera;

    assert.equal(describeDevice(noModel), "Basement Foyer [unknown]");
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
