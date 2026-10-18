/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * audio-filter.test.ts: The camera's audio-filter chain at its output rate - getAudioFilters leads the chain with a resample to the rate it is handed, the rate the
 * live view or the recording encodes at, and validates each user-configured highpass and lowpass against that rate's Nyquist limit (half the rate). No call site
 * reads a rate the camera delivers: the filters run where the encoder already converts to, so the rate decides alone whether a filter in the band between the two
 * Nyquist limits survives. This suite asserts that at the getAudioFilters boundary: at a 16000 Hz output a 9000 Hz lowpass is dropped, at a 48000 Hz output it is
 * kept, each chain leads with its resample, and the noise option off builds no chain at all.
 */
import { TestCameraProjection, makeCameraConfig } from "../testing.helpers.ts";
import { TestStateStore, makeProtectState, makeTestAccessory } from "../../testing.helpers.ts";
import { describe, test } from "node:test";
import type { Camera } from "unifi-protect";
import { G2_PRO_CHANNELS } from "../../camera.fixtures.ts";
import type { ProtectAccessory } from "../../types.ts";
import { ProtectCamera } from "./camera.ts";
import type { ProtectNvr } from "../../nvr/nvr.ts";
import assert from "node:assert/strict";
import { makeTestNvr } from "../../nvr/testing.helpers.ts";
import { settle } from "homebridge-plugin-utils/testing";

// Construct a real camera under the given feature options and hand back the camera with the harness controller that ends its observers.
async function constructCamera(userOptions: string[]): Promise<{ camera: ProtectCamera; controller: AbortController }> {

  const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS });
  const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
  const { controller, nvr } = makeTestNvr({ store, userOptions });
  const camera = new ProtectCamera(nvr as unknown as ProtectNvr, makeTestAccessory("Front Door", "uuid:74ACB900000A") as unknown as ProtectAccessory,
    new TestCameraProjection(cameraConfig.id, store) as unknown as Camera);

  await settle();

  return { camera, controller };
}

describe("the camera's audio-filter chain at its output rate", () => {

  // With Audio.Filter.Noise enabled, the default lowpass is 9000 Hz - above a 16000 Hz output's 8000 Hz Nyquist (dropped there) but below a 48000 Hz output's 24000 Hz
  // Nyquist (kept there). The default highpass of 150 Hz is well under both Nyquists and is always kept.
  test("each chain leads with a resample to its output rate, and a 9000 Hz lowpass is dropped at 16000 Hz and kept at 48000 Hz", async () => {

    const { camera, controller } = await constructCamera(["Enable.Audio.Filter.Noise"]);

    const atSixteen = camera.getAudioFilters(16000);

    assert.equal(atSixteen[0], "aresample=16000", "the chain leads with the resample to the 16000 Hz output rate");
    assert.ok(atSixteen.some((filter) => filter.includes("highpass=p=2:f=150")), "the 150 Hz highpass is kept at a 16000 Hz output");
    assert.ok(!atSixteen.some((filter) => filter.includes("lowpass=")), "the 9000 Hz lowpass is dropped at a 16000 Hz output - above its 8000 Hz Nyquist limit");

    const atFortyEight = camera.getAudioFilters(48000);

    assert.equal(atFortyEight[0], "aresample=48000", "the chain leads with the resample to the 48000 Hz output rate");
    assert.ok(atFortyEight.some((filter) => filter.includes("lowpass=p=2:f=9000")), "the 9000 Hz lowpass is kept at a 48000 Hz output - under its 24000 Hz Nyquist");

    controller.abort();
  });

  test("with the noise option off the chain is empty, so a recording or a live view with no filters copies or encodes without one", async () => {

    const { camera, controller } = await constructCamera([]);

    assert.deepEqual(camera.getAudioFilters(16000), [], "the option off builds no chain, the resample included");

    controller.abort();
  });
});
