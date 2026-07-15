/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * doorbell-audio-filter.test.ts: The doorbell audio-filter Nyquist validation - getAudioFilters validates each user-configured highpass/lowpass against the Nyquist
 * limit (half the input sample rate), so the rate the call sites feed it determines whether a filter in the 8-24 kHz band survives. Doorbells deliver audio at 48 kHz
 * (Nyquist 24 kHz) while every other camera delivers at 16 kHz (Nyquist 8 kHz), so each call site must pass the camera's true sample rate for a filter in the 8-24 kHz
 * band to be evaluated correctly. This suite pins that behavior at the getAudioFilters boundary: fed the doorbell's true 48 kHz, a 9 kHz lowpass survives; fed 16 kHz,
 * it is dropped.
 */
import { TestCameraProjection, TestStateStore, makeCameraConfig, makeProtectState, makeTestAccessory, makeTestNvr, settle } from "../../testing.helpers.ts";
import { describe, test } from "node:test";
import type { Camera } from "unifi-protect";
import { G2_PRO_CHANNELS } from "../../camera.fixtures.ts";
import type { ProtectAccessory } from "../../types.ts";
import { ProtectCamera } from "./camera.ts";
import type { ProtectNvr } from "../../nvr/nvr.ts";
import assert from "node:assert/strict";
import { livestreamAudioSampleRate } from "unifi-protect";

describe("doorbell audio-filter Nyquist validation", () => {

  test("an 8-24 kHz filter is validated against the source rate: kept at the doorbell's 48 kHz, dropped at a non-doorbell's 16 kHz", async () => {

    // With Audio.Filter.Noise enabled, the default lowpass is 9000 Hz - above the 16 kHz source's 8000 Hz Nyquist (dropped there) but below the 48 kHz doorbell source's
    // 24000 Hz Nyquist (kept there). The default highpass of 150 Hz is well under both Nyquists and is always kept. So feeding getAudioFilters the doorbell's true 48 kHz
    // preserves a user's lowpass that a non-doorbell's 16 kHz source rate would drop. We drive getAudioFilters directly at each rate - what matters is which rate the
    // stream and record call sites pass, and getAudioFilters is the pure boundary that turns the rate into a kept-or-dropped decision.
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

    // At a non-doorbell's 16 kHz source rate: the 9000 Hz lowpass exceeds the 8000 Hz Nyquist and is silently dropped, unlike at the doorbell's true 48 kHz rate above.
    const atNonDoorbellRate = camera.getAudioFilters(16000);

    assert.ok(atNonDoorbellRate.some((filter) => filter.includes("highpass=p=2:f=150")), "the 150 Hz highpass is kept at 16 kHz");
    assert.ok(!atNonDoorbellRate.some((filter) => filter.includes("lowpass=")), "the 9000 Hz lowpass is dropped at 16 kHz - above that source's 8000 Hz Nyquist limit");

    controller.abort();
  });

  test("the record and stream sites feed livestreamAudioSampleRate(ufp): a doorbell yields 48 kHz, every other camera 16 kHz, for both consumption shapes", async () => {

    // Both consumption shapes read livestreamAudioSampleRate(this.protectCamera.ufp): the getAudioFilters filter-string input and the advertised-recording-
    // samplerate enum (which branches on the rate === 48000). This row pins that the ufp a real camera exposes yields the right rate per camera type - validating the
    // helper's structural parameter accepts the WithoutIdentity-narrowed ufp - and that feeding that rate into getAudioFilters keeps a doorbell's high lowpass while a
    // non-doorbell's drops it, catching a site that fed the wrong rate. The enum sites themselves construct FFmpeg-bound machinery the runner's stub delegate
    // deliberately replaces, so the runner pins the shared rate input those sites branch on; the advertised value is proven at the live acceptance, not here.
    const doorbellConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { isDoorbell: true } });
    const doorbellStore = new TestStateStore(makeProtectState({ cameras: [doorbellConfig] }));
    const doorbellHarness = makeTestNvr({ store: doorbellStore, userOptions: ["Enable.Audio.Filter.Noise"] });
    const doorbell = new ProtectCamera(doorbellHarness.nvr as unknown as ProtectNvr, makeTestAccessory("Doorbell", "uuid:74ACB900000B") as unknown as ProtectAccessory,
      new TestCameraProjection(doorbellConfig.id, doorbellStore) as unknown as Camera);

    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { isDoorbell: false } });
    const cameraStore = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const cameraHarness = makeTestNvr({ store: cameraStore, userOptions: ["Enable.Audio.Filter.Noise"] });
    const camera = new ProtectCamera(cameraHarness.nvr as unknown as ProtectNvr, makeTestAccessory("Camera", "uuid:74ACB900000C") as unknown as ProtectAccessory,
      new TestCameraProjection(cameraConfig.id, cameraStore) as unknown as Camera);

    await settle();

    // The shared site input the getAudioFilters and advertised-samplerate-enum sites both feed. The enum branches on this being 48000, so pinning the rate pins the enum.
    const doorbellRate = livestreamAudioSampleRate(doorbell.ufp);
    const cameraRate = livestreamAudioSampleRate(camera.ufp);

    assert.equal(doorbellRate, 48000, "a doorbell's ufp yields the 48 kHz livestream rate the sites feed");
    assert.equal(cameraRate, 16000, "a non-doorbell's ufp yields the 16 kHz livestream rate the sites feed");

    // The getAudioFilters filter-string shape at each site's exact invocation: the doorbell's 48 kHz keeps the 9000 Hz lowpass; the non-doorbell's 16 kHz drops it.
    assert.ok(doorbell.getAudioFilters(doorbellRate).some((filter) => filter.includes("lowpass=p=2:f=9000")), "the doorbell site keeps the 9000 Hz lowpass");
    assert.ok(!camera.getAudioFilters(cameraRate).some((filter) => filter.includes("lowpass=")), "the non-doorbell site drops the 9000 Hz lowpass at its 16 kHz");

    doorbellHarness.controller.abort();
    cameraHarness.controller.abort();
  });
});
