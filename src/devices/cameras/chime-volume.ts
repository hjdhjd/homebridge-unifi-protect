/* Copyright(C) 2019-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * chime-volume.ts: The pure chime-volume reduction for UniFi Protect doorbells, and the per-chime ring lookup it reduces over.
 *
 * This module owns a doorbell's effective chime volume, reduced over the controller's chime config records, and the ring lookup that decides which chimes count. A
 * chime can serve multiple doorbells, so the doorbell's volume is the mean of the per-doorbell ring volume across every chime assigned to it, or 0 when none is
 * assigned. It is deliberately pure - `this`-free and free of any device or controller I/O, config records in and a number out - so the doorbell's read-through volume
 * getter and its volume observer share ONE definition of "this doorbell's volume" rather than each hand-rolling the reduction. The doorbell class keeps only the
 * `this`-state injection: the live snapshot read and the deviceSelectors.chime.all projection it feeds in.
 *
 * Extracting the reduction to this leaf also makes it importable in isolation: doorbell.ts transitively pulls in the camera and streaming stack, so a test cannot import
 * the helper from there, but a pure leaf type-importing only ProtectChimeConfig resolves freely. Matches the pure-module voice of resolution.ts and nvr-policy.ts: a
 * small, exported, side-effect-free surface paired with a thin live-read wrapper in the device class.
 */
import type { ProtectChimeConfig } from "unifi-protect";

// Answer the ring a chime carries for one doorbell: its ring setting for the camera when the chime is assigned to that camera, or undefined when the chime is not
// assigned to it or carries no ring for it. This is the one definition of "this chime rings for this doorbell"...the volume reduction below, the doorbell's ring check,
// and its volume write all read it, so no two of them can disagree about which chimes count.
export const chimeRingFor = (chime: ProtectChimeConfig, cameraId: string): ProtectChimeConfig["ringSettings"][number] | undefined => {

  return chime.cameraIds.includes(cameraId) ? chime.ringSettings.find(setting => setting.cameraId === cameraId) : undefined;
};

// Compute a doorbell's effective chime volume: the mean of the per-doorbell ring volume across every chime assigned to it (a chime can serve multiple doorbells), or 0
// when none is assigned. Pure over config records so the read-through getter and the volume observer share one definition of "this doorbell's volume".
export const chimeVolumeFor = (chimes: readonly ProtectChimeConfig[], cameraId: string): number => {

  let total = 0;
  let count = 0;

  for(const chime of chimes) {

    const ring = chimeRingFor(chime, cameraId);

    if(!ring) {

      continue;
    }

    total += ring.volume;
    count++;
  }

  return count ? (total / count) : 0;
};
