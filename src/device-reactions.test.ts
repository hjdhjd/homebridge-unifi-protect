/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * device-reactions.test.ts: Unit tests for the pure decision functions the per-device state observers (Fork B) rest on.
 *
 * The device leaves themselves are not directly importable in a unit test - the camera leaf transitively drags the streaming stack, and the others stand up a HAP
 * accessory at construction - so the reaction decisions that warrant pinning are extracted as pure functions and exercised here in isolation. The camera-to-doorbell
 * reclassification guard lives in types.ts (a poison-free, device-classification home reachable from a test); the sensor tamper-state mapping lives in sensor.ts (which
 * imports cleanly). Both are the single source of truth their observers and read-through getters consult, so pinning them here pins the behavior the live observers
 * deliver.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { sensorTamperState } from "./devices/sensor.ts";
import { shouldReconfigureAsDoorbell } from "./types.ts";

describe("doorbell reclassification guard (shouldReconfigureAsDoorbell)", () => {

  test("reconfigures only when the device is now a doorbell and is still running as a plain camera", () => {

    // The full truth table over the two inputs: the camera's current featureFlags.isDoorbell, and whether this accessory already runs as a ProtectDoorbell. The only
    // case that reconfigures is the late-arriving doorbell flag on an accessory that is still a plain camera; an accessory already running as a doorbell never
    // reconfigures (whatever the flag reads), and a plain camera that is not a doorbell stays a camera.
    const cases: { expected: boolean; isDoorbell: boolean; isDoorbellAccessory: boolean }[] = [

      { expected: false, isDoorbell: false, isDoorbellAccessory: false },
      { expected: false, isDoorbell: false, isDoorbellAccessory: true },
      { expected: true, isDoorbell: true, isDoorbellAccessory: false },
      { expected: false, isDoorbell: true, isDoorbellAccessory: true }
    ];

    for(const { expected, isDoorbell, isDoorbellAccessory } of cases) {

      assert.equal(shouldReconfigureAsDoorbell({ isDoorbell, isDoorbellAccessory }), expected,
        "isDoorbell=" + String(isDoorbell) + " isDoorbellAccessory=" + String(isDoorbellAccessory));
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
