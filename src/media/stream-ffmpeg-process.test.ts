/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * stream-ffmpeg-process.test.ts: A spawn-free truth-table for the live-path failed-teardown policy classifier, and the live view's audio-filter arguments.
 *
 * classifyTeardownFailure is the pure, exported decision the live-path FFmpeg streaming process delegates to in its logFailedTeardown override: given the accumulated
 * stderr and whether this instance suppresses livestream-API hiccups, it returns one of the protocol verdicts. Lifting that decision out of the spawn-on-construction
 * class is what makes it reachable here at all - the whole media suite is deliberately spawn-free and never builds a real FfmpegOptions, so the override itself cannot be
 * driven directly. This suite exercises the decision densely against the REAL exported function (and, transitively, the REAL module-private
 * LIVESTREAM_API_ERROR_PATTERNS, which we never re-declare): all the verdicts, the suppress-gating that lets a genuine failure still dump, the benign-before-probesize
 * precedence both ways, all the benign patterns pinned live, and the empty / non-matching baselines.
 *
 * Honest scope note: this covers the DECISION, where all the policy risk lives, and the compile-time exhaustiveGuard in the dispatcher closes the "an unhandled verdict
 * slips through" risk (a future verdict is a tsc error, not a silent canonical dump). The one residual we cannot reach is a mis-wired EFFECT inside one of the handled
 * case bodies, because reaching the dispatcher requires constructing the class, which spawns an FFmpeg child and needs a real FfmpegOptions this suite does not build.
 * That dispatch is trivial glue verified by inspection, and homebridge-plugin-utils' own process tests cover the base super.logFailedTeardown dump.
 */
import { TestCameraProjection, makeCameraConfig } from "../devices/testing.helpers.ts";
import { TestStateStore, makeProtectState, makeTestAccessory } from "../testing.helpers.ts";
import { after, describe, test } from "node:test";
import type { Camera } from "unifi-protect";
import { G2_PRO_CHANNELS } from "../camera.fixtures.ts";
import type { ProtectAccessory } from "../types.ts";
import { ProtectCamera } from "../devices/cameras/camera.ts";
import type { ProtectNvr } from "../nvr/nvr.ts";
import assert from "node:assert/strict";
import { classifyTeardownFailure } from "./stream-ffmpeg-process.ts";
import { liveAudioFilterArgs } from "./stream.ts";
import { makeTestNvr } from "../nvr/testing.helpers.ts";
import { settle } from "homebridge-plugin-utils/testing";

describe("classifyTeardownFailure - the live-path failed-teardown policy", () => {

  // A benign livestream-API pattern under suppression resolves to the benign-api verdict so the override can substitute the friendly sentence instead of dumping stderr.
  test("a benign livestream-API pattern under suppress=true classifies as benign-api", () => {

    assert.equal(classifyTeardownFailure(["moov atom not found"], true), "benign-api");
  });

  // All benign patterns must stay live. We feed each known literal in its own stderr line under suppress=true and assert each maps to benign-api, pinning the real
  // module-private LIVESTREAM_API_ERROR_PATTERNS array against silent drift without re-declaring it here.
  test("each of the four benign patterns classifies as benign-api under suppress=true", () => {

    const benignPatterns = [

      "Cannot determine format of input stream 0:0 after EOF",
      "Finishing stream without any data written to it",
      "could not find corresponding trex",
      "moov atom not found"
    ];

    for(const pattern of benignPatterns) {

      assert.equal(classifyTeardownFailure([pattern], true), "benign-api");
    }
  });

  // The suppression gate: with suppress=false a genuine failure that happens to carry a benign pattern still dumps, so the same line that was benign-api above is now
  // canonical. This proves the benign branch is gated on the captured flag, not on the pattern alone.
  test("a benign pattern with suppress=false classifies as canonical (the suppression gate)", () => {

    assert.equal(classifyTeardownFailure(["moov atom not found"], false), "canonical");
  });

  // The probesize self-tune is ungated, so the probesize substring resolves to the probesize verdict with suppress=false.
  test("the probesize substring with suppress=false classifies as probesize", () => {

    assert.equal(classifyTeardownFailure(["not enough frames to estimate rate; consider increasing probesize"], false), "probesize");
  });

  // The probesize branch is ungated, so suppress=true changes nothing when only the probesize substring (no benign pattern) is present.
  test("the probesize substring with suppress=true (no benign pattern) still classifies as probesize", () => {

    assert.equal(classifyTeardownFailure(["not enough frames to estimate rate; consider increasing probesize"], true), "probesize");
  });

  // Precedence, suppress=true: when both a benign pattern and the probesize substring are present, benign is checked first and wins.
  test("benign and probesize together with suppress=true classifies as benign-api (benign checked first)", () => {

    assert.equal(classifyTeardownFailure([ "moov atom not found", "not enough frames to estimate rate; consider increasing probesize" ], true), "benign-api");
  });

  // Precedence, suppress=false: the same two lines with the benign branch gated off let probesize win.
  test("benign and probesize together with suppress=false classifies as probesize (benign gated off)", () => {

    assert.equal(classifyTeardownFailure([ "moov atom not found", "not enough frames to estimate rate; consider increasing probesize" ], false), "probesize");
  });

  // The canonical baseline: empty stderr and a non-matching line both fall through to the canonical verdict, regardless of suppression.
  test("empty stderr and a non-matching line both classify as canonical", () => {

    assert.equal(classifyTeardownFailure([], true), "canonical");
    assert.equal(classifyTeardownFailure(["Some unrelated FFmpeg diagnostic line"], false), "canonical");
  });
});

/* The live view's audio-filter arguments, the other half of the live-path FFmpeg command this suite can reach without a spawn. The arguments are built from a real
 * camera's filter chain at the rate HomeKit requested for the stream, so the rows read what a live view would spawn with: a chain that leads with the resample to
 * the requested rate when the noise option is on, and no -filter:a at all when it is off.
 */
describe("liveAudioFilterArgs - the live view's -filter:a at the requested rate", () => {

  const controllers: AbortController[] = [];

  after(() => {

    for(const controller of controllers) {

      controller.abort();
    }
  });

  // A real camera under the given feature options, settled.
  async function constructCamera(userOptions: string[]): Promise<ProtectCamera> {

    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { controller, nvr } = makeTestNvr({ store, userOptions });
    const camera = new ProtectCamera(nvr as unknown as ProtectNvr, makeTestAccessory("Porch", "uuid:live-audio-filter") as unknown as ProtectAccessory,
      new TestCameraProjection(cameraConfig.id, store) as unknown as Camera);

    controllers.push(controller);
    await settle();

    return camera;
  }

  test("with the noise option on, the chain leads with the resample to each rate HomeKit can request", async () => {

    const camera = await constructCamera(["Enable.Audio.Filter.Noise"]);

    for(const requestedKhz of [ 16, 24 ]) {

      const args = liveAudioFilterArgs(camera, requestedKhz);

      assert.equal(args[0], "-filter:a", "the chain is passed as one -filter:a at " + requestedKhz.toString() + " kHz");
      assert.ok(args[1]?.startsWith("aresample=" + (requestedKhz * 1000).toString() + ", "), "the chain leads with the resample to the requested rate");
    }
  });

  test("with the noise option off, the live view carries no -filter:a", async () => {

    const camera = await constructCamera([]);

    assert.deepEqual(liveAudioFilterArgs(camera, 16), [], "no filter arguments at all");
  });
});
