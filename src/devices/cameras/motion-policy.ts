/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * motion-policy.ts: The pure motion policies for UniFi Protect cameras.
 *
 * This module owns the pure decisions about a camera's motion: whether a camera can source the motion events HomeKit Secure Video records on, and whether a camera's
 * bare motion - a raw motion start with no smart-object classification - should trip the HomeKit MotionSensor, or whether the matching smart detection owns motion for
 * this camera and firing here would double-report it. Each is deliberately pure - `this`-free and free of any device or controller I/O, camera facts in and a boolean
 * out - so the camera leaf's observers can import them without value-importing the non-leaf event-dispatch.ts (a rule the device layer enforces), and each truth table
 * is exhaustively testable without standing up a camera accessory.
 *
 * The bare-motion policy's home is the camera leaf's `lastMotion` observer. The controller signals bare motion by advancing the camera record's `lastMotion`
 * device-state field, which the camera observes exactly as the sensor and light families observe their own motion state. The policy itself is simple: we trip the
 * MotionSensor from a bare motion only when smart detection cannot be the authoritative source of motion - the camera is actively recording for HKSV (where every motion
 * start must drive the recording), the camera has no smart-detection capability at all, or the user has turned smart detection off. In every other case the matching
 * smart detection is the source of truth and firing here as well would double-report the same motion.
 */

/**
 * Decide whether a camera can back HomeKit Secure Video: whether the controller delivers the motion events HKSV records on for this camera. A first-party camera can,
 * unless UniFi Access has adopted it. A third-party camera has no native motion detection exposed through the Protect API, so it can back HKSV only when it is paired
 * with an AI Port, which supplies that detection.
 *
 * @param config - The record fields the predicate reads: whether UniFi Access has adopted the camera, whether it is paired with an AI Port, and whether it is a
 *                 third-party camera.
 *
 * @returns `true` when the camera can back HomeKit Secure Video, `false` otherwise.
 */
export function canBackHksv(config: { isAdoptedByAccessApp: boolean; isPairedWithAiPort: boolean; isThirdPartyCamera: boolean }): boolean {

  return (!config.isThirdPartyCamera && !config.isAdoptedByAccessApp) || (config.isThirdPartyCamera && config.isPairedWithAiPort);
}

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
