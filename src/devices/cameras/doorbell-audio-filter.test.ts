/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * doorbell-audio-filter.test.ts: The 2c-iii doorbell audio-filter Nyquist fix - getAudioFilters validates each user-configured highpass/lowpass against the Nyquist limit
 * (half the input sample rate), so the rate the call sites feed it determines whether a filter in the 8-24 kHz band survives. Doorbells deliver audio at 48 kHz (Nyquist
 * 24 kHz) while every other camera delivers at 16 kHz (Nyquist 8 kHz); the former hard-coded 16000 at both call sites silently dropped a doorbell user's 8-24 kHz
 * filters. This suite pins the corrected behavior at the getAudioFilters boundary: fed the doorbell's true 48 kHz, a 9 kHz lowpass survives; fed 16 kHz, it is dropped.
 */
import { TestCameraProjection, TestStateStore, makeCameraConfig, makeProtectState, makeTestAccessory, makeTestNvr, settle } from "../../testing.helpers.ts";
import { describe, test } from "node:test";
import type { Camera } from "unifi-protect";
import { G2_PRO_CHANNELS } from "../../camera.fixtures.ts";
import type { ProtectAccessory } from "../../types.ts";
import { ProtectCamera } from "./camera.ts";
import type { ProtectNvr } from "../../nvr/nvr.ts";
import assert from "node:assert/strict";

describe("doorbell audio-filter Nyquist validation (2c-iii)", () => {

  test("an 8-24 kHz filter is validated against the source rate: kept at the doorbell's 48 kHz, dropped at a non-doorbell's 16 kHz", async () => {

    // With Audio.Filter.Noise enabled, the default lowpass is 9000 Hz - above the 16 kHz source's 8000 Hz Nyquist (dropped there) but below the 48 kHz doorbell source's
    // 24000 Hz Nyquist (kept there). The default highpass of 150 Hz is well under both Nyquists and is always kept. So feeding getAudioFilters the doorbell's true 48 kHz
    // preserves a user's lowpass that the former hard-coded 16000 silently dropped. We drive getAudioFilters directly at each rate - the fix is which rate the stream and
    // record call sites pass, and getAudioFilters is the pure boundary that turns the rate into a kept-or-dropped decision.
    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { isDoorbell: true } });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { controller, nvr } = makeTestNvr({ store, userOptions: ["Enable.Audio.Filter.Noise"] });
    const camera = new ProtectCamera(nvr as unknown as ProtectNvr, makeTestAccessory("Front Door", "uuid:74ACB900000A") as unknown as ProtectAccessory,
      new TestCameraProjection(cameraConfig.id, store) as unknown as Camera);

    await settle();

    // The doorbell's true source rate: the 9000 Hz lowpass is under the 24000 Hz Nyquist, so it survives alongside the always-kept 150 Hz highpass.
    const atDoorbellRate = camera.getAudioFilters(48000);

    assert.ok(atDoorbellRate.some((filter) => filter.includes("highpass=p=2:f=150")), "the 150 Hz highpass is kept at 48 kHz");
    assert.ok(atDoorbellRate.some((filter) => filter.includes("lowpass=p=2:f=9000")), "the 9000 Hz lowpass is kept at the doorbell's 48 kHz source rate");

    // The former hard-coded non-doorbell rate: the 9000 Hz lowpass exceeds the 8000 Hz Nyquist and is silently dropped - the bug the fix corrects for doorbells.
    const atNonDoorbellRate = camera.getAudioFilters(16000);

    assert.ok(atNonDoorbellRate.some((filter) => filter.includes("highpass=p=2:f=150")), "the 150 Hz highpass is kept at 16 kHz");
    assert.ok(!atNonDoorbellRate.some((filter) => filter.includes("lowpass=")), "the 9000 Hz lowpass is dropped at 16 kHz - above that source's 8000 Hz Nyquist limit");

    controller.abort();
  });
});
