/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * device-reactions.test.ts: Unit tests for the pure decision functions the per-device state observers (Fork B) rest on.
 *
 * The device leaves themselves are not directly importable in a unit test - the camera leaf transitively drags the streaming stack, and the others stand up a HAP
 * accessory at construction - so the reaction decisions that warrant pinning are extracted as pure functions and exercised here in isolation. The camera-to-doorbell
 * reconcile decision lives in cameras/doorbell-reconcile-policy.ts (a poison-free, device-classification leaf reachable from a test); the sensor tamper-state mapping
 * lives in sensor.ts (which imports cleanly). Both are the single source of truth their observers and read-through getters consult, so pinning them here pins the
 * behavior the live observers deliver.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { doorbellReconcileAction } from "./cameras/doorbell-reconcile-policy.ts";
import { sensorTamperState } from "./sensor.ts";

describe("doorbell reconcile decision (doorbellReconcileAction)", () => {

  test("the exhaustive 2x2 over (hasCapability, isDoorbell) maps to the four live-attach actions", () => {

    // The full truth table over the two inputs: whether this camera already has a doorbell capability attached, and the camera's current featureFlags.isDoorbell. The
    // live-attach replaces the former teardown+recreate, so the four actions are: a late-arriving doorbell flag on a plain camera attaches the capability; a withdrawn
    // flag on a camera that still has one is reported (observability-only, nothing removed); a plain camera with no capability sweeps any stale doorbell-only services;
    // and a steady doorbell (with its capability) or a steady plain camera (with none) is a no-op.
    const cases: { expected: ReturnType<typeof doorbellReconcileAction>; hasCapability: boolean; isDoorbell: boolean }[] = [

      { expected: "attach", hasCapability: false, isDoorbell: true },
      { expected: "none", hasCapability: true, isDoorbell: true },
      { expected: "report-withdrawn", hasCapability: true, isDoorbell: false },
      { expected: "sweep-stale", hasCapability: false, isDoorbell: false }
    ];

    for(const { expected, hasCapability, isDoorbell } of cases) {

      assert.equal(doorbellReconcileAction({ hasCapability, isDoorbell }), expected,
        "hasCapability=" + String(hasCapability) + " isDoorbell=" + String(isDoorbell));
    }
  });
});

describe("sensor tamper-state mapping (sensorTamperState)", () => {

  test("reports tampered exactly when the controller has recorded a tampering time", () => {

    // The mapping is "tampered iff tamperingDetectedAt is non-null": a null timestamp is clear, and any timestamp - including the 1970 epoch zero, which is non-null - is
    // tampered. This is the single definition shared by the StatusTampered onGet, the initial write, and the reactive tamper observer.
    assert.equal(sensorTamperState(null), false, "a null tampering time reads as not tampered");
    assert.equal(sensorTamperState(0), true, "the epoch-zero timestamp is non-null, so it reads as tampered");
    assert.equal(sensorTamperState(1719772800000), true, "a real tampering timestamp reads as tampered");
  });
});
