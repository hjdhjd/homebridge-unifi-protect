/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * delegate-construction.test.ts: The first media-delegate construction tests - the proof the ProtectCameraHost interface segregation unlocks delegate testability.
 *
 * The ProtectCameraHost interface (the dependency-inversion boundary on the camera side of the media stack) lets the recording, snapshot, and timeshift delegates type
 * their camera handle as a narrow contract instead of the concrete ProtectCamera. The promised payoff is that a delegate can now
 * be unit-constructed against a small stub host instead of a full camera. This suite cashes that in for the Tier-1 (field-copy ctor) delegates: each
 * constructs against the reusable TestCameraHost double with no real camera and no FFmpeg.
 *
 * The construction proof for a field-copy ctor is necessarily thin, so the real-behavior anchor is the snapshot delegate's reachability gate, tested TWO-SIDED: with
 * the host unreachable getSnapshot returns null (the gate, the first statement of getSnapshot), and with the host reachable it returns the stub's controller Buffer
 * (the non-package pipeline falls through the timeshift and RTSP sources - both early-return on the host's undefined stream - to the controller source, with no crop
 * because the host's hints.crop is false). Two-sided proves isReachable is actually READ and that a stubbed interface value flows THROUGH the delegate's logic - the
 * capability the interface unlocked - not a coincidental null.
 *
 * The streaming delegate constructs here too, and it is the one member of the group that composes rather than field-copies: it builds a real FfmpegOptions (inert
 * under the harness's default hints, which turn every acceleration and crop knob off) and hands a fully-composed options object to the hap namespace's camera-controller
 * marker. That makes its construction test the suite's second real-behavior anchor - the capability arms it decides, and the probesize self-tuning its shutdown ends.
 */
import { AudioRecordingCodecType, AudioRecordingSamplerate } from "homebridge-plugin-utils";
import { PROTECT_PROBESIZE_OVERRIDE_MAX, PROTECT_PROBESIZE_OVERRIDE_PERMANENT_THRESHOLD, PROTECT_PROBESIZE_OVERRIDE_RESET_MS,
  PROTECT_SEGMENT_RESOLUTION } from "../settings.ts";
import { RECORDING_AUDIO_STAND_IN, controllerIdentityOf } from "./stream-delegate.ts";
import { Service, TestCameraController } from "../testing.helpers.ts";
import { after, describe, test } from "node:test";
import { G2_PRO_CHANNELS } from "../camera.fixtures.ts";
import type { LivestreamAudioFormat } from "./stream-delegate.ts";
import { ProtectRecordingDelegate } from "./record.ts";
import { ProtectSnapshot } from "./snapshot.ts";
import { ProtectStreamingDelegate } from "./stream.ts";
import { ProtectTimeshiftBuffer } from "./timeshift.ts";
import { ProtectTimeshiftSupervisor } from "./timeshift-supervisor.ts";
import assert from "node:assert/strict";
import { formatLogEntry } from "homebridge-plugin-utils/testing";
import { makeCameraConfig } from "../devices/testing.helpers.ts";
import { makeTestCameraHost } from "./testing.helpers.ts";

// Every host this suite builds shares the one makeTestNvr AbortController. Aborting it in teardown releases the harness signal so a leaked observer (none here, the
// field-copy ctors spawn none) could never outlive the suite. The field-copy ctors are pure field-copies, so construction floats no async machinery and needs no
// settle().
const controllers: AbortController[] = [];

after(() => {

  for(const controller of controllers) {

    controller.abort();
  }
});

describe("media-delegate construction against the ProtectCameraHost stub", () => {

  // The recording delegate: a field-copy ctor reading accessory / api / log off the host and wiring a nested ProtectTimeshiftBuffer. The delegate types its handle
  // as ProtectCameraHost, so the stub host passes WITH NO CAST at the construction site - that no-cast construction is the unlock the interface bought. The state
  // assertions (both getters false at rest) and the nested-timeshift instance check carry what a field-copy ctor honestly can: that it constructed and wired its
  // sub-delegate without throwing.
  test("ProtectRecordingDelegate constructs against the stub host with no real camera", () => {

    const { controller, host } = makeTestCameraHost();

    controllers.push(controller);

    const supervisor = new ProtectTimeshiftSupervisor(host);
    const recording = new ProtectRecordingDelegate(host, supervisor);

    assert.equal(recording.isRecording, false);
    assert.equal(recording.isTransmitting, false);
    assert.ok(recording.timeshift instanceof ProtectTimeshiftBuffer);
  });

  // The snapshot delegate: a field-copy ctor reading log only, then the suite's real-behavior anchor. The two-sided reachability gate proves the delegate actually
  // READS host.isReachable and that a stubbed interface value flows through its source pipeline.
  test("ProtectSnapshot constructs and its reachability gate is two-sided", async () => {

    const { controller, host } = makeTestCameraHost();

    controllers.push(controller);

    const snapshot = new ProtectSnapshot(host);

    // Side one: an unreachable host returns null before any pipeline runs - the gate, the first statement of getSnapshot. This proves isReachable is read at all.
    host.isReachable = false;
    assert.equal(await snapshot.getSnapshot(), null);

    // Side two: a reachable host returns the stub's controller Buffer. With stream undefined the timeshift and RTSP sources early-return, and with no packageCamera
    // key on the accessory context the non-package branch falls through to the controller source, which resolves snapshotResult; hints.crop is false so no crop pass
    // runs. The returned Buffer being exactly the stubbed value is the proof an interface value threads through the delegate's logic with no FFmpeg.
    host.isReachable = true;
    assert.equal(await snapshot.getSnapshot(), host.snapshotResult);

    // The controller source was actually the path taken - the interface was invoked exactly once on the reachable side (the unreachable side returned before any source).
    assert.equal(host.snapshotFromControllerCalls.length, 1);
  });

  // The timeshift delegate: a field-copy ctor reading log only and calling super() as an EventEmitter. The construction assertions are thin public-surface checks
  // honest for a field-copy EventEmitter; configuredDuration reads the public derivation (segmentCount * segmentLength) at its init of one segment, so it equals one
  // segment resolution - the private segmentCount is never read directly.
  test("ProtectTimeshiftBuffer constructs against the stub host as an EventEmitter", () => {

    const { controller, host } = makeTestCameraHost();

    controllers.push(controller);

    const timeshift = new ProtectTimeshiftBuffer(host);

    assert.equal(timeshift.isStarted, false);
    assert.equal(timeshift.isTransmitting, false);
    assert.equal(timeshift.configuredDuration, PROTECT_SEGMENT_RESOLUTION);
  });

  // The streaming delegate: the one ctor here that composes rather than field-copies. It builds the real FfmpegOptions, decides its capability arms from the host's
  // reads, and hands HAP a composed CameraControllerOptions. The arms are asserted separately because they answer different questions: the buffer-backed supervisor
  // stands for every camera, while the stub host is not HKSV-capable, so no recording delegate does. The recorded options carrying the
  // delegate itself is the proof the composed object reached the controller intact rather than a coincidental non-null.
  test("ProtectStreamingDelegate constructs against the stub host with the real FfmpegOptions", () => {

    const { controller, host, logEntries } = makeTestCameraHost();

    controllers.push(controller);

    const stream = new ProtectStreamingDelegate(host, [[ 1920, 1080, 30 ]]);
    const cameraController = stream.controller;

    assert.ok(cameraController instanceof TestCameraController, "the delegate constructed the hap camera controller");
    assert.equal(cameraController.options.delegate, stream, "the composed controller options carry the delegate itself");
    assert.notEqual(stream.timeshift, null, "the buffer-backed supervisor constructed, as it does for every camera");
    assert.equal(stream.hksv, null, "no recording delegate constructed for a host that is not HKSV-capable");

    // The macOS hardware-acceleration nudge is the only warn-level line construction can emit, and it requires a hostSystem beginning with "macOS." - the harness
    // reports a bare "macOS", so it stays silent. A warn here would mean the real FfmpegOptions reached something the stub profile does not model.
    assert.equal(logEntries.filter((entry) => entry.level === "warn").length, 0, "construction warned about nothing");
  });

  // The supervisor stands for every camera, a third-party camera that cannot back HKSV included, while the recording delegate stays the HKSV-capable camera's alone.
  // The host's record agrees with its eligibility: Protect exposes no motion sensor for this camera.
  test("ProtectStreamingDelegate against a third-party host that cannot back HKSV builds the timeshift supervisor and no recording delegate", () => {

    const { controller, host } = makeTestCameraHost();

    controllers.push(controller);
    host.ufp = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { hasMotionDetection: false }, isThirdPartyCamera: true });

    const stream = new ProtectStreamingDelegate(host, [[ 1920, 1080, 30 ]]);

    assert.ok(stream.timeshift instanceof ProtectTimeshiftSupervisor, "the third-party camera's delegate stands its timeshift supervisor");
    assert.equal(stream.hksv, null, "no recording delegate constructed for a host that is not HKSV-capable");
  });

  // The capable column of the same construction: a host that can back HKSV gets the recording delegate, the controller options carry the recording arm that delegate
  // drives, and the controller's motion link is the accessory's own MotionSensor - the service the camera stands up before any controller that links it is built.
  test("ProtectStreamingDelegate against an HKSV-capable host builds the recording arm and links the accessory's motion sensor", () => {

    const { accessory, controller, host } = makeTestCameraHost();

    controllers.push(controller);

    const motionSensor = accessory.addService(Service.MotionSensor, "Test Camera");

    host.isHksvCapable = true;

    const stream = new ProtectStreamingDelegate(host, [[ 1920, 1080, 30 ]]);
    const cameraController = stream.controller;

    assert.ok(cameraController instanceof TestCameraController, "the delegate constructed the hap camera controller");
    assert.ok(stream.hksv instanceof ProtectRecordingDelegate, "a recording delegate constructed for a host that can back HKSV");
    assert.equal(cameraController.options.recording?.delegate, stream.hksv, "the controller's recording arm is driven by that recording delegate");
    assert.ok(cameraController.options.recording.options, "the controller's recording arm carries its recording options");
    assert.equal(cameraController.options.sensors?.motion, motionSensor, "the controller's motion link is the accessory's own motion sensor");
  });

  /* The advertised recording audio format is the camera's own, read from its livestream by the derivation, in one channel, or the whole stand-in when the stream was not
   * read or its rate has no HomeKit recording member. The advertisement is frozen into the controller, so each row reads it straight off the recorded controller
   * options, beside the format the delegate keeps for the supervisor's comparison. The controller identity carries no audio term, so the format moves no rebuild.
   */
  test("the recording codec advertises the derived audio format in one channel, or the stand-in, and the identity carries no audio term", () => {

    const advertise = (options: { audioFormat: LivestreamAudioFormat | null; isDoorbell?: boolean }): { codec: unknown; stream: ProtectStreamingDelegate } => {

      const { accessory, controller, host } = makeTestCameraHost();

      controllers.push(controller);
      accessory.addService(Service.MotionSensor, "Test Camera");
      host.isHksvCapable = true;
      host.ufp = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { isDoorbell: options.isDoorbell ?? false } });

      const stream = new ProtectStreamingDelegate(host, [[ 1920, 1080, 30 ]], { audioFormat: options.audioFormat, probe: null });
      const codecs = (stream.controller as unknown as TestCameraController).options.recording?.options.audio.codecs;

      assert.equal(stream.builtFor.hksvCapable, true, "the vacuity guard: the delegate built its recording arm");
      assert.deepEqual(stream.builtFor, controllerIdentityOf(host), "the identity is the derivation over the host, whatever the audio format");
      assert.deepEqual(Object.keys(stream.builtFor).toSorted(), [ "hksvCapable", "isDoorbell", "twoWayAudio" ],
        "the identity carries the same terms, none of them audio");

      return { codec: Array.isArray(codecs) ? codecs[0] : codecs, stream };
    };

    const mono = (sampleRate: number): LivestreamAudioFormat => ({ channels: 1, codec: "aac", sampleRate });

    assert.deepEqual(advertise({ audioFormat: mono(8000) }).codec, { audioChannels: 1, samplerate: AudioRecordingSamplerate.KHZ_8, type: AudioRecordingCodecType.AAC_LC },
      "an 8000 Hz mono stream advertises the 8 kHz recording rate");
    assert.deepEqual(advertise({ audioFormat: mono(48000) }).codec, { audioChannels: 1, samplerate: AudioRecordingSamplerate.KHZ_48,
      type: AudioRecordingCodecType.AAC_LC }, "a 48000 Hz mono stream advertises the 48 kHz recording rate");

    const stereo = advertise({ audioFormat: { channels: 2, codec: "aac", sampleRate: 16000 } });

    assert.deepEqual(stereo.codec, { audioChannels: 1, samplerate: AudioRecordingSamplerate.KHZ_16, type: AudioRecordingCodecType.AAC_LC },
      "a stereo stream advertises its rate in one channel");
    assert.deepEqual(stereo.stream.advertisedAudioFormat, mono(16000), "the delegate keeps the advertised format, in one channel, for the supervisor's comparison");

    for(const isDoorbell of [ false, true ]) {

      const unread = advertise({ audioFormat: null, isDoorbell });

      assert.deepEqual(unread.codec, { audioChannels: 1, samplerate: RECORDING_AUDIO_STAND_IN.samplerate, type: AudioRecordingCodecType.AAC_LC },
        "a stream not read advertises the stand-in, " + (isDoorbell ? "doorbell" : "camera") + " alike");
      assert.deepEqual(unread.stream.advertisedAudioFormat, RECORDING_AUDIO_STAND_IN.format, "the kept format is the stand-in's");
    }

    const unmapped = advertise({ audioFormat: mono(22050) });

    assert.deepEqual(unmapped.codec, { audioChannels: 1, samplerate: RECORDING_AUDIO_STAND_IN.samplerate, type: AudioRecordingCodecType.AAC_LC },
      "a 22050 Hz stream, a rate HomeKit has no recording member for, advertises the whole stand-in");
    assert.deepEqual(unmapped.stream.advertisedAudioFormat, RECORDING_AUDIO_STAND_IN.format, "the kept format is the whole stand-in, not the stream's rate");
  });

  // Shutdown ends this camera's probesize self-tuning along with its streams. The distinguishing assertion is the IMMEDIATE post-shutdown read: a shutdown that leaves
  // the self-tune armed still reads the elevated override right after the call, and only drifts back to baseline when the auto-reset timer eventually fires - which is
  // exactly the timer that would keep a retired delegate reachable. The advance-and-recheck afterward is post-reset stability hygiene, not what tells a shutdown that
  // ends the tuning from one that leaves it armed. The auto-reset arms on the harness test clock, so a pending one never holds the test process open.
  test("shutdown resets the probesize self-tuning and leaves no auto-reset pending", () => {

    const { clock, controller, host, logEntries } = makeTestCameraHost();

    controllers.push(controller);

    // The harness host defaults to a zero probesize, which the self-tune would double to zero and the getter could not tell from the baseline. A nonzero baseline makes
    // the override, the doubling, and the reset all separately observable through the public getter.
    host.hints.probesize = 16384;

    const stream = new ProtectStreamingDelegate(host, [[ 1920, 1080, 30 ]]);

    stream.adjustProbeSize();

    assert.equal(stream.probesize, 32768, "the self-tune doubled the camera's baseline probesize");
    assert.equal(logEntries.filter((entry) => entry.level === "error").length, 1, "the self-tune reported the stream trouble it is adjusting for");

    const logCountAfterAdjust = logEntries.length;

    stream.shutdown();

    assert.equal(stream.probesize, 16384, "shutdown wound the override back to the camera's baseline immediately");

    clock.advance(PROTECT_PROBESIZE_OVERRIDE_RESET_MS + 1);

    assert.equal(stream.probesize, 16384, "the baseline holds past the auto-reset delay");
    assert.equal(logEntries.length, logCountAfterAdjust, "nothing was logged after the shutdown");
  });

  /* The streaming delegate's shutdown is safe to call more than once, and structurally so rather than through a latch: both session maps drain on the first call, and
   * the reset assigns fixed values, so there is no state a second call could find in an unexpected shape. This test is a tripwire against a future edit that
   * introduces state a second call could trip over.
   */
  test("a repeat delegate shutdown tears nothing down and reports nothing", () => {

    const { controller, host, logEntries } = makeTestCameraHost();

    controllers.push(controller);

    host.hints.probesize = 16384;

    const stream = new ProtectStreamingDelegate(host, [[ 1920, 1080, 30 ]]);

    stream.shutdown();

    const logCountAfterFirstShutdown = logEntries.length;

    stream.shutdown();

    assert.equal(stream.probesize, 16384, "the second shutdown left the probesize at the camera's baseline");
    assert.equal(logEntries.length, logCountAfterFirstShutdown, "the second shutdown logged nothing");
    assert.equal(logEntries.filter((entry) => formatLogEntry(entry).includes("Stopped video streaming session.")).length, 0,
      "neither call reported a session teardown, because there was no session to tear down");
  });

  // The self-tuning's adjustment tally counts every adjustment over the delegate's life and deliberately outlives the auto-reset, so a camera that needs an adjustment
  // every few minutes reaches the permanent elevation just as surely as one that needs them back to back. Each pass through the loop returns the camera to its baseline
  // while the tally underneath keeps climbing - the state a tally that reset with the elevation could never reach. The threshold is pinned TWO-SIDED, because an
  // adjustment word asserted on one side alone is equally happy with a threshold off by one: the adjustment just below reports a temporary elevation, and the one that
  // reaches the threshold reports a permanent one. The closing advance is what proves the permanent adjustment armed no auto-reset at all.
  test("the probesize adjustment tally outlives the auto-reset and crosses the permanent threshold", () => {

    const { clock, controller, host, logEntries } = makeTestCameraHost();

    controllers.push(controller);

    host.hints.probesize = 16384;

    const stream = new ProtectStreamingDelegate(host, [[ 1920, 1080, 30 ]]);
    const lastAdjustmentLine = (): string => formatLogEntry(logEntries.filter((entry) => entry.level === "error").at(-1) ?? { level: "error", message: "", params: [] });

    for(let adjustment = 1; adjustment < PROTECT_PROBESIZE_OVERRIDE_PERMANENT_THRESHOLD; adjustment++) {

      stream.adjustProbeSize();

      assert.equal(stream.probesize, 32768, "adjustment " + adjustment.toString() + " doubled the camera's baseline");
      assert.ok(lastAdjustmentLine().includes("temporarily"), "adjustment " + adjustment.toString() + " reported a temporary elevation");

      clock.advance(PROTECT_PROBESIZE_OVERRIDE_RESET_MS + 1);

      assert.equal(stream.probesize, 16384, "the auto-reset after adjustment " + adjustment.toString() + " returned the camera to its baseline");
    }

    stream.adjustProbeSize();

    assert.ok(lastAdjustmentLine().includes("permanently"), "the adjustment that reached the threshold reported a permanent elevation");
    assert.ok(!lastAdjustmentLine().includes("temporarily"), "the permanent adjustment did not also report itself as temporary");

    clock.advance(PROTECT_PROBESIZE_OVERRIDE_RESET_MS + 1);

    assert.equal(stream.probesize, 32768, "no auto-reset was armed at the threshold, so the elevation stands");
  });

  // Each adjustment doubles the probesize ALREADY IN EFFECT rather than the camera's baseline, so back-to-back trouble compounds instead of arriving at the same
  // elevation every time - and the compounding comes to rest on the ceiling rather than running away. The ceiling is pinned two-sided: the last adjustment below it
  // lands on its exact doubled value, and the next lands on the ceiling instead of the value it would otherwise have reached.
  test("each probesize adjustment doubles the elevation already in effect, up to the ceiling", () => {

    const { controller, host } = makeTestCameraHost();

    controllers.push(controller);

    host.hints.probesize = 16384;

    const stream = new ProtectStreamingDelegate(host, [[ 1920, 1080, 30 ]]);

    // Three adjustments with no auto-reset between them: the baseline doubles three times over. A tuning that doubled the BASELINE each time would sit at 32768 here.
    stream.adjustProbeSize();
    stream.adjustProbeSize();
    stream.adjustProbeSize();

    assert.equal(stream.probesize, 131072, "the elevation compounded off itself rather than off the camera's baseline");

    // Carry on to the eighth adjustment, the last one whose doubling still fits under the ceiling.
    for(let adjustment = 4; adjustment <= 8; adjustment++) {

      stream.adjustProbeSize();
    }

    assert.equal(stream.probesize, 4194304, "the eighth adjustment doubled cleanly, still below the ceiling");

    stream.adjustProbeSize();

    assert.equal(stream.probesize, PROTECT_PROBESIZE_OVERRIDE_MAX, "the adjustment that would have overshot the ceiling came to rest on it");
  });
});
