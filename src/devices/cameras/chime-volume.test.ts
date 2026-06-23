/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * chime-volume.test.ts: Unit tests for the pure chime-volume reduction (chimeVolumeFor) extracted to the importable leaf src/devices/chime-volume.ts.
 *
 * chimeVolumeFor is a pure free function - config records in, a number out, no this, no HAP, no command - so the natural coverage is to import the REAL leaf and drive it
 * directly with constructed ProtectChimeConfig inputs, exactly as device-reactions.test.ts imports the real sensorTamperState. The helper formerly lived as a
 * module-local const in doorbell.ts, which transitively drags in the camera and streaming stack and so could not resolve in the strip-types runner; these were modeled
 * against a byte-identical hand-copy. The extraction to a pure leaf (type-importing only ProtectChimeConfig) makes the helper importable, so these are now real-code
 * coverage of the shipping reduction rather than a model that could silently drift.
 *
 * The reduction is the mean of the per-doorbell ring volume across every chime assigned to this doorbell, or 0 when none is assigned: cameraIds membership gates a chime
 * (a stray ring keyed to the doorbell on a chime that does not list it does not count), a chime listing the doorbell but carrying no ring for it is skipped (not diluted
 * toward zero), and the divisor is the count of contributing chimes.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { chimeVolumeFor } from "./chime-volume.ts";
import { makeChimeConfig } from "../../testing.helpers.ts";

describe("chimeVolumeFor (the real pure leaf, import-driven)", () => {

  test("no assigned chime reads as zero volume", () => {

    // An empty chime set and a chime serving only another doorbell both contribute nothing, so this doorbell's effective volume is zero.
    assert.equal(chimeVolumeFor([], "doorbell-1"), 0, "an empty chime set means this doorbell has no chime volume");
    assert.equal(chimeVolumeFor([makeChimeConfig({ cameraIds: ["other"], ringSettings: [{ cameraId: "other", volume: 50 }] })], "doorbell-1"), 0,
      "a chime serving only another doorbell contributes nothing");
  });

  test("a single assigned chime reads as that chime's ring volume", () => {

    const chimes = [makeChimeConfig({ cameraIds: ["doorbell-1"], ringSettings: [{ cameraId: "doorbell-1", volume: 75 }] })];

    assert.equal(chimeVolumeFor(chimes, "doorbell-1"), 75, "one assigned chime reports its per-doorbell ring volume directly");
  });

  test("multiple assigned chimes read as the mean of their per-doorbell ring volumes", () => {

    const chimes = [

      makeChimeConfig({ cameraIds: ["doorbell-1"], id: "chime-a", ringSettings: [{ cameraId: "doorbell-1", volume: 40 }] }),
      makeChimeConfig({ cameraIds: ["doorbell-1"], id: "chime-b", ringSettings: [{ cameraId: "doorbell-1", volume: 80 }] })
    ];

    assert.equal(chimeVolumeFor(chimes, "doorbell-1"), 60, "two assigned chimes report the mean of their ring volumes");
  });

  test("a chime assigned to this doorbell but carrying no ring for it is skipped, not counted as zero", () => {

    const chimes = [

      makeChimeConfig({ cameraIds: ["doorbell-1"], id: "chime-no-ring", ringSettings: [] }),
      makeChimeConfig({ cameraIds: ["doorbell-1"], id: "chime-ring", ringSettings: [{ cameraId: "doorbell-1", volume: 90 }] })
    ];

    // The first chime lists the doorbell in cameraIds but has no matching ring entry, so it is skipped and does not dilute the mean toward zero (the divisor is the count
    // of CONTRIBUTING chimes, one here, not the count of assigned chimes).
    assert.equal(chimeVolumeFor(chimes, "doorbell-1"), 90, "a chime with no ring for this doorbell is skipped, not counted as zero");
  });

  test("a chime whose cameraIds excludes this doorbell is skipped even if a stray ring matches", () => {

    // cameraIds is the membership gate: a ring keyed to this doorbell on a chime that does not list the doorbell must not count, so the cameraIds check precedes the ring
    // lookup exactly as it does in production.
    const chimes = [makeChimeConfig({ cameraIds: ["other"], ringSettings: [{ cameraId: "doorbell-1", volume: 100 }] })];

    assert.equal(chimeVolumeFor(chimes, "doorbell-1"), 0, "membership is gated on cameraIds, not on a stray ring entry");
  });
});
