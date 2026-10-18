/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * capability-reconcile-policy.ts: The pure capability reconcile policy for UniFi Protect cameras.
 *
 * This module owns the decisions a camera makes when it reconciles a capability the controller can report late or withdraw. The reconcile action weighs what the
 * camera already stands up for the capability against what the controller reports right now. Every capability the camera family composes in place on a gain and
 * narrates on a withdrawal reads this one truth table, so the family answers "gain, withdrawal, or steady state" the same way for each of them. The drain test decides
 * whether a featureFlags block the controller delivered is a reading at all, so a narrator screens the transient all-false block before it calls a withdrawal. Each
 * is the camera-family sibling of motion-policy.ts - a `this`-free, I/O-free leaf the camera leaf's observers can import without value-importing the non-leaf
 * event-dispatch.ts (the device-layer module design), and exhaustively testable in isolation without standing up a camera accessory.
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

/**
 * Decide whether a camera's featureFlags block is the controller's drain rather than a reading. On a deep re-adopt the controller delivers the whole block with every
 * capability false, and the real values follow, so a narrator reads such a block as no reading at all: it calls no withdrawal and schedules no removal for a
 * capability the block reports false. The block is a drain when it carries at least one top-level boolean member and every top-level boolean member reads false; the
 * nested objects and the lists are not read.
 *
 * The cost is the one a block cannot tell apart: a camera whose only true capability flag was the one it lost reports a genuine withdrawal as an all-false block, so a
 * camera whose motion report was its only true flag is never narrated when it loses it. The same cost falls on a genuine withdrawal whose real values land right after
 * a drain: the narrators wake on a value change, and the drain already read the value false, so that withdrawal is never narrated either and a package camera's
 * removal waits for the next sweep. Nothing is removed wrongly on either path, and a restart builds the camera from the real values.
 *
 * @param featureFlags - The camera's featureFlags block as the controller currently reports it.
 *
 * @returns `true` when the block is an all-false drain, `false` when it is a reading.
 */
export function isFeatureFlagsDrain(featureFlags: Record<string, unknown>): boolean {

  const flags = Object.values(featureFlags).filter((value) => typeof value === "boolean");

  return (flags.length > 0) && flags.every((flag) => !flag);
}
