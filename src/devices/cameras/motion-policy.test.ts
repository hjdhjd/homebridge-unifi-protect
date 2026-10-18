/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * motion-policy.test.ts: Unit tests for the pure motion policies (canBackHksv and shouldDeliverBareMotion) extracted to the importable leaf motion-policy.ts.
 *
 * Each policy is a pure free function - camera facts in, a boolean out, no this, no HAP - so the natural coverage is to import the REAL leaf and drive it directly,
 * exactly as chime-volume.test.ts / smart-detect-metadata.test.ts import their pure leaves. Because the policies are a pure leaf type-importing nothing, they are
 * importable by both the camera leaf and this test, so this is real-code coverage of the shipping decisions rather than a model that could drift.
 */
import { canBackHksv, shouldDeliverBareMotion } from "./motion-policy.ts";
import { describe, test } from "node:test";
import assert from "node:assert/strict";

describe("HomeKit Secure Video eligibility (canBackHksv)", () => {

  test("a first-party camera can back HKSV unless Access has adopted it, and a third-party camera only when paired with an AI Port", () => {

    // The predicate: eligible = (first-party AND not Access-adopted) OR (third-party AND paired with an AI Port). The AI Port term is read only for a third-party camera
    // and the Access term only for a first-party one, so each half of the table moves on its own term alone.
    const cases: { expected: boolean; isAdoptedByAccessApp: boolean; isPairedWithAiPort: boolean; isThirdPartyCamera: boolean }[] = [

      { expected: true, isAdoptedByAccessApp: false, isPairedWithAiPort: false, isThirdPartyCamera: false },
      { expected: true, isAdoptedByAccessApp: false, isPairedWithAiPort: true, isThirdPartyCamera: false },
      { expected: false, isAdoptedByAccessApp: true, isPairedWithAiPort: false, isThirdPartyCamera: false },
      { expected: false, isAdoptedByAccessApp: true, isPairedWithAiPort: true, isThirdPartyCamera: false },
      { expected: false, isAdoptedByAccessApp: false, isPairedWithAiPort: false, isThirdPartyCamera: true },
      { expected: true, isAdoptedByAccessApp: false, isPairedWithAiPort: true, isThirdPartyCamera: true },
      { expected: false, isAdoptedByAccessApp: true, isPairedWithAiPort: false, isThirdPartyCamera: true },
      { expected: true, isAdoptedByAccessApp: true, isPairedWithAiPort: true, isThirdPartyCamera: true }
    ];

    for(const { expected, isAdoptedByAccessApp, isPairedWithAiPort, isThirdPartyCamera } of cases) {

      assert.equal(canBackHksv({ isAdoptedByAccessApp, isPairedWithAiPort, isThirdPartyCamera }), expected, "isAdoptedByAccessApp=" + String(isAdoptedByAccessApp) +
        " isPairedWithAiPort=" + String(isPairedWithAiPort) + " isThirdPartyCamera=" + String(isThirdPartyCamera));
    }
  });
});

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
