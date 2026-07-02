/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * motion-policy.test.ts: Unit tests for the pure bare-motion delivery policy (shouldDeliverBareMotion) extracted to the importable leaf motion-policy.ts.
 *
 * shouldDeliverBareMotion is a pure free function - three camera facts in, a boolean out, no this, no HAP - so the natural coverage is to import the REAL leaf and drive
 * it directly, exactly as chime-volume.test.ts / smart-detect-metadata.test.ts import their pure leaves. Because the policy is a pure leaf type-importing nothing, it is
 * importable by both the camera leaf and this test, so this is real-code coverage of the shipping decision rather than a model that could drift.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { shouldDeliverBareMotion } from "./motion-policy.ts";

describe("bare-motion delivery policy (shouldDeliverBareMotion)", () => {

  test("fires bare motion in every case except a capable, smart-enabled camera that is not recording", () => {

    // The policy: fire = HKSV recording OR no smart capability OR smart detection disabled. The lone suppression is the case where smart detection is the source of
    // truth - the camera can smart-detect, the user enabled it, and HKSV is not separately demanding the motion - so the matching smartDetect event will fire instead.
    const cases: { expected: boolean; hksvRecording: boolean; smartCapable: boolean; smartDetectEnabled: boolean }[] = [

      { expected: true, hksvRecording: false, smartCapable: false, smartDetectEnabled: false },
      { expected: true, hksvRecording: false, smartCapable: false, smartDetectEnabled: true },
      { expected: true, hksvRecording: false, smartCapable: true, smartDetectEnabled: false },
      { expected: false, hksvRecording: false, smartCapable: true, smartDetectEnabled: true },
      { expected: true, hksvRecording: true, smartCapable: false, smartDetectEnabled: false },
      { expected: true, hksvRecording: true, smartCapable: false, smartDetectEnabled: true },
      { expected: true, hksvRecording: true, smartCapable: true, smartDetectEnabled: false },
      { expected: true, hksvRecording: true, smartCapable: true, smartDetectEnabled: true }
    ];

    for(const { expected, hksvRecording, smartCapable, smartDetectEnabled } of cases) {

      assert.equal(shouldDeliverBareMotion({ hksvRecording, smartCapable, smartDetectEnabled }), expected,
        "hksvRecording=" + String(hksvRecording) + " smartCapable=" + String(smartCapable) + " smartDetectEnabled=" + String(smartDetectEnabled));
    }
  });
});
