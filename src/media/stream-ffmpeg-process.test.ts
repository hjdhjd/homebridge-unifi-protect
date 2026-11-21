/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * stream-ffmpeg-process.test.ts: A spawn-free truth-table for the live-path failed-teardown policy classifier, the live view's answer to a failed FFmpeg process, the
 * live view's audio-filter arguments, the SRTP destination each live-view sink sends to, the destination two-way audio sends to directly, whether a camera's FFmpeg
 * processes log verbosely, and the live view's bounded wait for its livestream.
 *
 * classifyTeardownFailure is the pure, exported decision the live view's answer to a failed FFmpeg process is built on: given the accumulated stderr and whether the
 * live view suppresses livestream-API hiccups, it returns one of the protocol verdicts. This suite exercises the decision densely against the REAL exported function
 * (and, transitively, the REAL module-private LIVESTREAM_API_ERROR_PATTERNS, which we never re-declare): all the verdicts, the suppress-gating that lets a genuine
 * failure still dump, the benign-before-probesize precedence both ways, every benign pattern held live, and the empty / non-matching baselines.
 *
 * liveViewOnFailed turns each verdict into its effect, and the rows over it read every effect with no process behind it: the answer HBPU reads, the friendly sentence
 * the live view's log carries in place of HBPU's report, and the probe-size callback. The compile-time exhaustiveGuard in that answer closes the "an unhandled verdict
 * slips through" risk, since a future verdict is a tsc error rather than a silent report. The live view's wiring of the answer into the process it starts is read by
 * stream-start.test.ts, through HBPU's streaming process double.
 */
import { TestCameraProjection, makeCameraConfig } from "../devices/testing.helpers.ts";
import { TestClock, capturingLog, settle } from "homebridge-plugin-utils/testing";
import { TestStateStore, makeProtectState, makeTestAccessory } from "../testing.helpers.ts";
import { after, describe, test } from "node:test";
import { classifyTeardownFailure, liveViewOnFailed } from "./stream-ffmpeg-process.ts";
import { establishedWithin, isFfmpegVerbose, liveAudioFilterArgs, srtpDestination, talkbackDestination } from "./stream.ts";
import type { Camera } from "unifi-protect";
import type { CapturingLog } from "homebridge-plugin-utils/testing";
import type { FfmpegEndingVerdict } from "homebridge-plugin-utils";
import { G2_PRO_CHANNELS } from "../camera.fixtures.ts";
import { HbpuAbortError } from "homebridge-plugin-utils";
import { ProtectCamera } from "../devices/cameras/camera.ts";
import type { ProtectNvr } from "../nvr/nvr.ts";
import assert from "node:assert/strict";
import { configured } from "../devices/device-base.ts";
import { makeTestCameraHost } from "./testing.helpers.ts";
import { makeTestNvr } from "../nvr/testing.helpers.ts";

describe("classifyTeardownFailure - the live-path failed-teardown policy", () => {

  // A benign livestream-API pattern under suppression resolves to the benign-api verdict so the live view's answer can substitute the friendly sentence for the report.
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

/* The live view's answer to a failed FFmpeg process, read with no process behind it. Each row hands the answer an ending whose stderr carries the lines under test and
 * reads its effects together: the verdict HBPU acts on, every line the answer wrote to the live view's log, and how often it called the probe-size callback.
 */
describe("liveViewOnFailed - the live view's answer to a failed FFmpeg process", () => {

  // The friendly sentence a known livestream API hiccup is answered with, written out here rather than read from the module, which keeps it private.
  const FRIENDLY_SENTENCE = "FFmpeg ended unexpectedly due to issues processing the media stream provided by the UniFi Protect livestream API. This error can be " +
    "safely ignored - it will occur occasionally.";

  // The line FFmpeg writes when it runs out of probe size before it can estimate the stream's rate.
  const PROBESIZE_LINE = "not enough frames to estimate rate; consider increasing probesize";

  // Answer a failed ending carrying the given stderr lines, and hand back the verdict, the log the answer wrote to, and the probe-size callback's call count.
  function answer(stderrLog: string[], suppressLivestreamApiErrors: boolean): { log: CapturingLog; probesizeCalls: number; verdict: FfmpegEndingVerdict } {

    const log = capturingLog();
    const calls = { probesize: 0 };
    const onFailed = liveViewOnFailed({ log, onProbesizeError: (): void => { calls.probesize++; }, suppressLivestreamApiErrors });
    const verdict = onFailed({ reason: new HbpuAbortError("failed", { cause: { exitCode: 1, exitSignal: null } }), stderrLog });

    return { log, probesizeCalls: calls.probesize, verdict };
  }

  test("a known livestream line under suppression is answered with the friendly sentence at error and nothing more", () => {

    const { log, probesizeCalls, verdict } = answer(["moov atom not found"], true);

    assert.equal(verdict, "handled", "HBPU logs no report of its own");
    assert.deepEqual(log.entries, [{ level: "error", message: FRIENDLY_SENTENCE, params: [] }], "the friendly sentence is the one line, at error");
    assert.equal(probesizeCalls, 0, "the probe size stands");
  });

  test("the same line without suppression is left to HBPU's report", () => {

    const { log, probesizeCalls, verdict } = answer(["moov atom not found"], false);

    assert.equal(verdict, "default", "HBPU logs its full report");
    assert.deepEqual(log.entries, [], "the answer writes nothing of its own");
    assert.equal(probesizeCalls, 0, "the probe size stands");
  });

  test("the probe-size line raises the probe size once and leaves no report", () => {

    const { log, probesizeCalls, verdict } = answer([PROBESIZE_LINE], false);

    assert.equal(verdict, "handled", "HBPU logs no report of its own");
    assert.deepEqual(log.entries, [], "the answer writes nothing of its own, since raising the probe size says so itself");
    assert.equal(probesizeCalls, 1, "the probe size is raised once");
  });

  test("a known livestream line beside the probe-size line under suppression is answered with the friendly sentence, and the probe size stands", () => {

    const { log, probesizeCalls, verdict } = answer([ "moov atom not found", PROBESIZE_LINE ], true);

    assert.equal(verdict, "handled", "HBPU logs no report of its own");
    assert.deepEqual(log.entries, [{ level: "error", message: FRIENDLY_SENTENCE, params: [] }], "the friendly sentence is the one line, at error");
    assert.equal(probesizeCalls, 0, "the known livestream line wins over the probe-size line");
  });

  test("a line neither matches is left to HBPU's report, under suppression too", () => {

    const { log, probesizeCalls, verdict } = answer(["Some unrelated FFmpeg diagnostic line"], true);

    assert.equal(verdict, "default", "HBPU logs its full report");
    assert.deepEqual(log.entries, [], "the answer writes nothing of its own");
    assert.equal(probesizeCalls, 0, "the probe size stands");
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
    const camera = configured(new ProtectCamera(nvr as unknown as ProtectNvr, makeTestAccessory("Porch", cameraConfig.mac),
      new TestCameraProjection(cameraConfig.id, store) as unknown as Camera));

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

/* The SRTP destination each live-view sink sends to, composed from the HomeKit client's address and the port it negotiated for the sink. An IPv6 address has to be
 * bracketed or FFmpeg cannot tell its colons from the port separator, an IPv4 address reaches FFmpeg unchanged, and an IPv6 address carrying a zone is
 * refused, which the streaming delegate turns into a failed start that disposes the prepared session.
 */
describe("srtpDestination - the SRTP destination a live-view sink sends to", () => {

  test("an IPv4 address passes through unchanged", () => {

    assert.equal(srtpDestination("192.168.1.20", 52000), "srtp://192.168.1.20:52000?rtcpport=52000");
  });

  test("an IPv6 address is bracketed so its colons are not read as the port separator", () => {

    assert.equal(srtpDestination("fd00::1:2", 52002), "srtp://[fd00::1:2]:52002?rtcpport=52002");
  });

  test("an IPv6 address carrying a zone is refused", () => {

    assert.throws(() => srtpDestination("fe80::1%en0", 52004), TypeError, "a zone has no place in a destination");
  });
});

/* The UDP destination two-way audio sends its return audio to when it talks to the camera directly, composed from the camera's address and the port its talkback
 * settings bind. It brackets an IPv6 address and passes an IPv4 one through exactly as the SRTP destination does, and refuses an IPv6 address carrying a zone, which
 * the streaming delegate turns into a session that goes on without return audio.
 */
describe("talkbackDestination - the destination two-way audio sends to directly", () => {

  test("an IPv4 address passes through unchanged", () => {

    assert.equal(talkbackDestination("192.168.1.30", 7004), "udp://192.168.1.30:7004");
  });

  test("an IPv6 address is bracketed so its colons are not read as the port separator", () => {

    assert.equal(talkbackDestination("fd00::1:3", 7004), "udp://[fd00::1:3]:7004");
  });

  test("an IPv6 address carrying a zone is refused", () => {

    assert.throws(() => talkbackDestination("fe80::1%en0", 7004), TypeError, "a zone has no place in a destination");
  });
});

/* Whether a camera's FFmpeg processes log verbosely, the one answer every FFmpeg process of a live view reads, its two-way audio return included. Each input turns it
 * on by itself - the camera's FFmpeg logging option, its video FFmpeg debugging option, and the platform's verbose FFmpeg setting - and a camera with none of them
 * stays quiet.
 */
describe("isFfmpegVerbose - whether a camera's FFmpeg processes log verbosely", () => {

  const controllers: AbortController[] = [];

  after(() => {

    for(const controller of controllers) {

      controller.abort();
    }
  });

  // A camera host with exactly the given feature option enabled, or none, and the platform's verbose FFmpeg setting as given.
  function hostWith(options: { feature?: string; verboseFfmpeg?: boolean } = {}): Parameters<typeof isFfmpegVerbose>[0] {

    const { controller, host } = makeTestCameraHost();

    controllers.push(controller);
    host.hasFeature = (option: string): boolean => option === options.feature;
    host.platform.config.verboseFfmpeg = options.verboseFfmpeg ?? false;

    return host;
  }

  test("a camera with no FFmpeg logging option and no platform setting does not log verbosely", () => {

    assert.equal(isFfmpegVerbose(hostWith()), false);
  });

  test("the camera's FFmpeg logging option turns verbose logging on", () => {

    assert.equal(isFfmpegVerbose(hostWith({ feature: "Log.FFmpeg" })), true);
  });

  test("the camera's video FFmpeg debugging option turns verbose logging on", () => {

    assert.equal(isFfmpegVerbose(hostWith({ feature: "Debug.Video.FFmpeg" })), true);
  });

  test("the platform's verbose FFmpeg setting turns verbose logging on", () => {

    assert.equal(isFfmpegVerbose(hostWith({ verboseFfmpeg: true })), true);
  });
});

describe("establishedWithin - the live view's bounded wait for its livestream", () => {

  // An establishment that answers inside the deadline is the wait's answer, true and false alike, and the deadline's timer is released with it.
  test("an establishment that answers in time is the answer, and leaves no timer armed", async () => {

    const clock = new TestClock();

    assert.equal(await establishedWithin({ clock, established: Promise.resolve(true), withinMs: 8000 }), true);
    assert.equal(await establishedWithin({ clock, established: Promise.resolve(false), withinMs: 8000 }), false);
    assert.equal(clock.pending, 0, "no deadline timer outlives a settled wait");
  });

  // A livestream that never answers is given up on exactly at the deadline: still waiting a millisecond before it, and false the moment it passes.
  test("a livestream that never answers is given up on at the deadline", async () => {

    const clock = new TestClock();
    const outcome: { answer?: boolean } = {};

    void establishedWithin({ clock, established: Promise.withResolvers<boolean>().promise, withinMs: 8000 }).then((answer): void => { outcome.answer = answer; });

    clock.advance(7999);

    await settle();

    assert.equal(outcome.answer, undefined, "still waiting a millisecond before the deadline");

    clock.advance(1);

    await settle();

    assert.equal(outcome.answer, false);
  });

  // A budget the work ahead of the wait has already spent answers false on the clock's next turn rather than arming a timer in the past.
  test("a budget already spent answers false on the clock's next turn", async () => {

    const clock = new TestClock();
    const outcome: { answer?: boolean } = {};

    void establishedWithin({ clock, established: Promise.withResolvers<boolean>().promise, withinMs: -500 }).then((answer): void => { outcome.answer = answer; });

    clock.advance(0);

    await settle();

    assert.equal(outcome.answer, false);
  });
});
