/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * motion-policy.ts: The pure bare-motion delivery policy for UniFi Protect cameras.
 *
 * This module owns one pure decision: whether a camera's bare motion - a raw motion start with no smart-object classification - should trip the HomeKit MotionSensor, or
 * whether the matching smart detection owns motion for this camera and firing here would double-report it. It is deliberately pure - `this`-free and free of any device
 * or controller I/O, three camera facts in and a boolean out - so the camera leaf's bare-motion observer can import it without value-importing the non-leaf
 * event-dispatch.ts (the device-layer module invariant), and its truth table is exhaustively testable without standing up a camera accessory.
 *
 * The home is the camera leaf's `lastMotion` observer. Under v5 the controller signals bare motion by advancing the camera record's `lastMotion` device-state field,
 * which the camera observes exactly as the sensor and light families observe their own motion state. The policy itself survives the v4 semantics verbatim: we trip the
 * MotionSensor from a bare motion only when smart detection cannot be the authoritative source of motion - the camera is actively recording for HKSV (where every motion
 * start must drive the recording), the camera has no smart-detection capability at all, or the user has turned smart detection off. In every other case the matching
 * smart detection is the source of truth and firing here as well would double-report the same motion.
 */

/**
 * Decide whether a camera's bare motion should trip the HomeKit MotionSensor.
 *
 * @param inputs - The three camera facts the policy reads, named so the truth table is legible: whether HKSV is recording, whether the camera can smart-detect, and
 *                 whether the user enabled smart detection.
 *
 * @returns `true` when a bare motion should trip the HomeKit MotionSensor, `false` when the smart detection owns motion for this camera.
 */
export function shouldDeliverBareMotion(inputs: { hksvRecording: boolean; smartCapable: boolean; smartDetectEnabled: boolean }): boolean {

  return inputs.hksvRecording || !inputs.smartCapable || !inputs.smartDetectEnabled;
}
