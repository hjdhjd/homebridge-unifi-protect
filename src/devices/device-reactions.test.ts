/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * device-reactions.test.ts: Unit tests for the pure decision functions the per-device state observers rest on.
 *
 * The device leaves themselves are not directly importable in a unit test - the camera leaf transitively drags the streaming stack, and the others stand up a HAP
 * accessory at construction - so the reaction decisions that warrant a regression assertion are extracted as pure functions and exercised here in isolation. The
 * camera family's capability reconcile decision lives in cameras/capability-reconcile-policy.ts (a poison-free leaf reachable from a test); the sensor tamper-state
 * mapping lives in sensor.ts (which imports cleanly). Both are the single source of truth their observers and read-through getters consult, so asserting them here
 * holds the behavior the live observers deliver.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { capabilityReconcileAction } from "./cameras/capability-reconcile-policy.ts";
import { sensorTamperState } from "./sensor.ts";

describe("capability reconcile decision (capabilityReconcileAction)", () => {

  test("the exhaustive 2x2 over (attached, reported) maps to the four reconcile actions", () => {

    // The exhaustive truth table over whether the capability already stands on the camera and whether the controller currently reports it. A gain composes the
    // capability in place rather than tearing down and recreating, so every combination resolves to one of the reconcile actions: a capability the controller reports
    // late attaches; a withdrawn one the camera still stands up is reported (observability-only, nothing removed); a camera with neither sweeps anything a withdrawal
    // it never saw left behind; and a capability that stands while the controller reports it is a no-op.
    const cases: { attached: boolean; expected: ReturnType<typeof capabilityReconcileAction>; reported: boolean }[] = [

      { attached: false, expected: "attach", reported: true },
      { attached: true, expected: "none", reported: true },
      { attached: true, expected: "report-withdrawn", reported: false },
      { attached: false, expected: "sweep-stale", reported: false }
    ];

    for(const { attached, expected, reported } of cases) {

      assert.equal(capabilityReconcileAction({ attached, reported }), expected, "attached=" + String(attached) + " reported=" + String(reported));
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
