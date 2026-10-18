/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * motion-policy.ts: The pure motion policies for UniFi Protect cameras.
 *
 * This module owns the pure decisions about a camera's motion: whether Protect exposes the motion sensor HomeKit Secure Video records on for a camera, and whether a
 * camera's bare motion - a raw motion start with no smart-object classification - should trip the HomeKit MotionSensor, or whether the matching smart detection owns
 * motion for this camera and firing here would double-report it. Each is deliberately pure - `this`-free and free of any device or controller I/O, camera facts in and
 * a boolean out - so the camera leaf's observers can import them without value-importing the non-leaf event-dispatch.ts (a rule the device layer enforces), and each
 * truth table is exhaustively testable without standing up a camera accessory.
 *
 * The bare-motion policy's home is the camera leaf's `lastMotion` observer. The controller signals bare motion by advancing the camera record's `lastMotion`
 * device-state field, which the camera observes exactly as the sensor and light families observe their own motion state. The policy itself is simple: we trip the
 * MotionSensor from a bare motion only when smart detection cannot be the authoritative source of motion - the camera is actively recording for HKSV (where every motion
 * start must drive the recording), the camera has no smart-detection capability at all, or the user has turned smart detection off. In every other case the matching
 * smart detection is the source of truth and firing here as well would double-report the same motion.
 */

/**
 * Decide whether a camera can back HomeKit Secure Video. Protect states in the camera's feature flags whether it exposes a motion sensor for the camera, and HomeKit
 * Secure Video depends on that sensor, since its recordings start on the camera's motion events. The statement covers every camera alike: a third-party camera reports
 * it once its ONVIF profile exposes motion detection. Smart detection is the smart-detection features' concern and plays no part here, so a camera that reports smart
 * detection without motion detection cannot back HomeKit Secure Video.
 *
 * @param config - The record field the predicate reads: the camera's feature flags, carrying whether Protect exposes a motion sensor for it.
 *
 * @returns `true` when the camera can back HomeKit Secure Video, `false` otherwise.
 */
export function canBackHksv(config: { featureFlags: { hasMotionDetection: boolean } }): boolean {

  return config.featureFlags.hasMotionDetection;
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
