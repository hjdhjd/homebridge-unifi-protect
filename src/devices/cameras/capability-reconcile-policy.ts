/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * capability-reconcile-policy.ts: The pure capability reconcile policy for UniFi Protect cameras.
 *
 * This module owns the decision a camera makes when it reconciles a capability the controller can report late or withdraw: what the camera already stands up for the
 * capability, weighed against what the controller reports right now. Every capability the camera family composes in place on a gain and narrates on a withdrawal
 * reads this one truth table, so the family answers "gain, withdrawal, or steady state" the same way for each of them. It is the camera-family sibling of
 * motion-policy.ts - a `this`-free, I/O-free leaf the camera leaf's observers can import without value-importing the non-leaf event-dispatch.ts (the device-layer module
 * design), and whose exhaustive truth table is testable in isolation without standing up a camera accessory.
 */

/**
 * Resolve what a camera should do to reconcile a capability against the controller's live state. The controller can report a capability after a camera is first
 * adopted, or withdraw one it reported, so a camera's observer routes each change through one reconcile chokepoint driven by this exhaustive truth table over
 * (attached, reported) - a pure decision, homed in this camera-family policy leaf alongside motion-policy.ts and testable without standing up an accessory (the camera
 * leaf is not directly importable in a unit test due to its transitive streaming-stack dependencies).
 *
 * The reconcile actions (a gain composes in place; a withdrawal is observability-only):
 *
 * - "attach": the controller reports the capability and the camera does not stand it up yet - compose it onto the live camera in place (no teardown).
 * - "report-withdrawn": the controller no longer reports the capability but the camera stands it up - log a warning only; nothing here removes what the capability
 *   built.
 * - "sweep-stale": the controller does not report the capability and the camera does not stand it up - clear anything a withdrawal the plugin never saw left behind,
 *   where the capability has anything to clear (a no-op on a steady camera without it).
 * - "none": steady state - the camera stands up a capability the controller reports.
 *
 * @param inputs - attached is whether the capability already stands on this camera; reported is whether the controller currently reports it.
 *
 * @returns the reconcile action the camera's chokepoint should run.
 */
export function capabilityReconcileAction(inputs: { attached: boolean; reported: boolean }): "attach" | "none" | "report-withdrawn" | "sweep-stale" {

  if(inputs.reported) {

    return inputs.attached ? "none" : "attach";
  }

  return inputs.attached ? "report-withdrawn" : "sweep-stale";
}
