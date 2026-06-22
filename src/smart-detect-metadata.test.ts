/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * smart-detect-metadata.test.ts: Unit tests for the per-type smart-detection rich-metadata enrichers.
 *
 * The enrichers are pure functions over a SmartDetectEventItem, so the registry and the vehicle enricher's attribute and MQTT rendering are exercised directly with no
 * mocks. These pin the human-readable fragment shape (label, value, confidence, ordering, defaults) and the structured MQTT payload (presence gating, finite-confidence
 * omission) that the event router's delivery and log-dedup policy build on.
 */
import { describe, test } from "node:test";
import { SMART_DETECT_ENRICHERS } from "./devices/smart-detect-metadata.ts";
import type { SmartDetectEventItem } from "./devices/smart-detect-metadata.ts";
import assert from "node:assert/strict";

// Resolve the vehicle enricher once; it is the only registered type today and the focus of these tests.
const vehicle = SMART_DETECT_ENRICHERS.get("vehicle");

// Assemble a vehicle SmartDetectEventItem from just the parts a case exercises. The partial object literal satisfies the item's deep-partial payload shape directly, so
// no assertion is needed - the same shape the production assembly point builds when it sources these items from the firehose metadata.
function vehicleItem(parts: { color?: { confidence?: number; val?: string }; confidence?: number; name?: string;
  vehicleType?: { confidence?: number; val?: string }; }): SmartDetectEventItem {

  return {

    ...((parts.confidence !== undefined) && { confidence: parts.confidence }),
    ...((parts.name !== undefined) && { name: parts.name }),
    ...((parts.color ?? parts.vehicleType) && { payload: { attributes: { ...(parts.color && { color: parts.color }),
      ...(parts.vehicleType && { vehicleType: parts.vehicleType }) } } }),
    type: "vehicle"
  };
}

describe("smart-detect enricher registry", () => {

  test("registers a vehicle enricher and nothing for plain object types", () => {

    assert.ok(SMART_DETECT_ENRICHERS.has("vehicle"), "the vehicle type has a rich-metadata enricher");
    assert.equal(SMART_DETECT_ENRICHERS.has("person"), false, "a plain object type has no enricher and is treated as a bare detection");
    assert.equal(SMART_DETECT_ENRICHERS.has("animal"), false, "a plain object type has no enricher and is treated as a bare detection");
  });
});

describe("vehicle enricher attributes", () => {

  test("returns an empty list when no rich metadata is present", () => {

    assert.deepEqual(vehicle?.attributes(vehicleItem({})), [], "a bare vehicle detection yields no attribute fragments");
  });

  test("renders the license plate from the detection name and its confidence", () => {

    assert.deepEqual(vehicle?.attributes(vehicleItem({ confidence: 98, name: "ABC123" })), ["license plate: ABC123 [98% confidence]"]);
  });

  test("defaults a missing plate confidence to zero", () => {

    assert.deepEqual(vehicle?.attributes(vehicleItem({ name: "ABC123" })), ["license plate: ABC123 [0% confidence]"]);
  });

  test("renders color and vehicle type from the thumbnail attributes", () => {

    assert.deepEqual(vehicle?.attributes(vehicleItem({ color: { confidence: 68, val: "black" }, vehicleType: { confidence: 96, val: "suv" } })),
      [ "color: black [68% confidence]", "vehicleType: suv [96% confidence]" ]);
  });

  test("orders plate, then color, then vehicle type when all are present", () => {

    assert.deepEqual(vehicle?.attributes(vehicleItem({ color: { confidence: 68, val: "black" }, confidence: 98, name: "ABC123",
      vehicleType: { confidence: 96, val: "suv" } })),
    [ "license plate: ABC123 [98% confidence]", "color: black [68% confidence]", "vehicleType: suv [96% confidence]" ]);
  });

  test("defaults a missing attribute value and confidence", () => {

    assert.deepEqual(vehicle?.attributes(vehicleItem({ color: {} })), ["color:  [0% confidence]"]);
  });
});

describe("vehicle enricher MQTT payload", () => {

  test("returns null when there is nothing structured to publish", () => {

    assert.equal(vehicle?.mqtt(vehicleItem({})), null, "a bare vehicle detection has no MQTT metadata");
  });

  test("includes the plate name and a finite confidence", () => {

    assert.deepEqual(vehicle?.mqtt(vehicleItem({ confidence: 98, name: "ABC123" })), { confidence: 98, name: "ABC123", type: "vehicle" });
  });

  test("omits a non-finite confidence", () => {

    assert.deepEqual(vehicle?.mqtt(vehicleItem({ name: "ABC123" })), { name: "ABC123", type: "vehicle" });
  });

  test("includes the color and vehicle-type objects when present", () => {

    assert.deepEqual(vehicle?.mqtt(vehicleItem({ color: { confidence: 68, val: "black" }, vehicleType: { confidence: 96, val: "suv" } })),
      { color: { confidence: 68, val: "black" }, type: "vehicle", vehicleType: { confidence: 96, val: "suv" } });
  });
});
