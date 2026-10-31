/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * device-descriptor.test.ts: Unit tests for the pure model resolver (describeDeviceModel), HomeKit name derivation (deviceDisplayName) and device descriptor
 * (describeDevice) in the importable leaf src/devices/device-descriptor.ts.
 *
 * Each is a pure free function - a config record in, a rendered string out, no this, no HAP - so the natural coverage is to import the REAL leaf and drive them with
 * plain config objects, exactly as motion-policy.test.ts / chime-volume.test.ts drive their pure leaves. They reproduce the established device-name format, so the
 * cases cover the resolver's marketName-present, marketName-empty, marketName-absent, and nothing-reported edges, the name derivation's custom-name, sanitized-name,
 * empty-name, model-fallback and unknown-fallback edges, and the descriptor's plain and rich modes plus its marketName-empty, marketName-absent, no-model, no-name,
 * empty-name, host-empty, and name-override edges. The absent-field cases are what a controller that omits marketName on some units and type on others actually
 * delivers, and they are written as records that simply lack the key rather than carry an empty one, so a fallback chain that only handles the empty spelling fails
 * here.
 */
import { describe, test } from "node:test";
import { describeDevice, describeDeviceModel, deviceDisplayName, deviceDisplayNaming } from "./device-descriptor.ts";
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

describe("deviceDisplayName", () => {

  test("a name HomeKit accepts is the accessory's name, and one carrying a character HomeKit disallows is sanitized", () => {

    assert.equal(deviceDisplayName(camera), "Basement Foyer");
    assert.equal(deviceDisplayName({ ...camera, name: "Basement|Foyer" }), "Basement Foyer", "sanitizeName turns the disallowed character into a space");
  });

  test("a name that is empty, blank or made only of characters HomeKit disallows falls to the model", () => {

    // Each of these sanitizes to nothing, and HAP refuses an accessory whose display name is empty, so the model names the accessory instead.
    for(const name of [ "", "  ", "🙂" ]) {

      assert.equal(deviceDisplayName({ ...camera, name }), "G5 Flex", JSON.stringify(name) + " falls to the model");
    }
  });

  test("a device with no name falls to the model", () => {

    assert.equal(deviceDisplayName({ ...camera, name: undefined }), "G5 Flex");
  });

  test("a device with an empty name and no model reads as \"unknown\"", () => {

    assert.equal(deviceDisplayName({ name: "" }), "unknown");
  });

  test("a nameless device whose model sanitizes to nothing reads as \"unknown\"", () => {

    // The model label is the controller's own string, so it too can carry nothing HomeKit accepts, and the literal last step still names the accessory.
    assert.equal(deviceDisplayName({ marketName: "🙂" }), "unknown");
  });

  test("a device whose record lacks a name key, or carries an empty market name beside its hardware type, falls to the model it reports", () => {

    const { name: _name, ...noName } = camera;

    assert.equal(deviceDisplayName(noName), "G5 Flex", "a record carrying no name key at all falls to the market name");
    assert.equal(deviceDisplayName({ ...noName, marketName: "" }), "camera", "an empty market name falls through to the hardware type");
  });

  test("a custom name HomeKit can carry names the accessory ahead of the device's own name, trimmed and sanitized", () => {

    assert.equal(deviceDisplayName(camera, { override: "Reading Nook" }), "Reading Nook", "a plain custom name is the accessory's name");
    assert.equal(deviceDisplayName(camera, { override: "  Reading Nook  " }), "Reading Nook", "a padded custom name is trimmed");
    assert.equal(deviceDisplayName(camera, { override: "Bedtime 🌙" }), "Bedtime", "a custom name carrying a character HomeKit disallows is sanitized");
  });

  test("a custom name HomeKit can carry nothing of falls through to the device's own name, and on to the model when that sanitizes to nothing too", () => {

    // An emoji alone and punctuation alone are names HomeKit's naming rules leave nothing of, so they count as no custom name at all, as an empty or absent one does.
    for(const override of [ "🙂", "---", "", "   ", null, undefined ]) {

      assert.equal(deviceDisplayName(camera, { override }), "Basement Foyer", JSON.stringify(override) + " falls through to the device's own name");
    }

    assert.equal(deviceDisplayName({ ...camera, name: "🙂" }, { override: "---" }), "G5 Flex", "each step falls through on an empty sanitized result");
  });
});

describe("deviceDisplayNaming", () => {

  test("answers the device's own name the walk passed over where it carries something and sanitizes to nothing, and nothing otherwise", () => {

    assert.deepEqual(deviceDisplayNaming({ ...camera, name: "🙂" }), { name: "G5 Flex", passedOver: "🙂" }, "a name HomeKit can display none of is passed over");
    assert.deepEqual(deviceDisplayNaming(camera), { name: "Basement Foyer", passedOver: null }, "a name HomeKit can display passes nothing over");
    assert.deepEqual(deviceDisplayNaming({ ...camera, name: "" }), { name: "G5 Flex", passedOver: null }, "an empty name carries nothing to pass over");
    assert.deepEqual(deviceDisplayNaming({ ...camera, name: "🙂" }, { override: "Den" }), { name: "Den", passedOver: null },
      "a custom name that applies names the device ahead of its own name, which the walk never reaches");
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

  test("falls back to the model for the name when the device's name is empty, and keeps any other name unsanitized", () => {

    // The log line shows what the controller reports, so only an empty name falls to the model; one HomeKit would sanitize away stays as the controller sent it.
    assert.equal(describeDevice({ ...camera, name: "" }), "G5 Flex [G5 Flex]");
    assert.equal(describeDevice({ ...camera, name: "🙂" }), "🙂 [G5 Flex]", "an emoji-only name stays raw in the log");
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
