/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * doorbell-reconcile-policy.ts: The pure doorbell-capability reconcile policy for UniFi Protect cameras.
 *
 * This module owns one pure decision: what a camera should do to reconcile its doorbell capability against the controller's live state. It is the camera-family sibling
 * of motion-policy.ts - a `this`-free, I/O-free leaf the camera leaf's reclassification observer can import without value-importing the non-leaf event-dispatch.ts (the
 * device-layer module invariant), and whose exhaustive 2x2 truth table is testable in isolation without standing up a camera accessory.
 */

/**
 * Resolve what a camera should do to reconcile its doorbell capability against the controller's live state. Cameras and doorbells share Protect's "camera" modelKey - the
 * sole differentiator is featureFlags.isDoorbell, which can arrive (or be withdrawn) after a camera is first adopted (the controller provisions the doorbell capability
 * late). The per-camera reclassification observer watches that flag and routes its change through one reconcile chokepoint driven by this exhaustive 2x2 over
 * (hasCapability, isDoorbell) - a pure device-classification decision, homed in this dedicated camera-family policy leaf alongside motion-policy.ts and testable without
 * standing up an accessory (the camera leaf is not directly importable in a unit test due to its transitive streaming-stack dependencies).
 *
 * The four actions, by HJD ruling (the live-attach replaces the former teardown+recreate; demotion is observability-only):
 *
 * - "attach": the controller now reports a doorbell and no capability is attached yet - compose the capability onto the live camera in place (no teardown).
 * - "report-withdrawn": the controller no longer reports a doorbell but a capability is attached - log a warning only; the capability and its accessories remain (a full
 *   detach is a one-arm addition later if field observation shows demotion happens in the wild).
 * - "sweep-stale": the controller does not report a doorbell and no capability is attached - remove any doorbell-only services a demoted-while-down doorbell left behind
 *   (idempotent; a no-op on a steady plain camera).
 * - "none": steady state - a doorbell with its capability, or a plain camera with none.
 *
 * @param inputs - hasCapability is whether this camera already has a doorbell capability attached; isDoorbell is the camera's current featureFlags.isDoorbell.
 *
 * @returns the reconcile action the camera's chokepoint should run.
 */
export function doorbellReconcileAction(inputs: { hasCapability: boolean; isDoorbell: boolean }): "attach" | "none" | "report-withdrawn" | "sweep-stale" {

  if(inputs.isDoorbell) {

    return inputs.hasCapability ? "none" : "attach";
  }

  return inputs.hasCapability ? "report-withdrawn" : "sweep-stale";
}
