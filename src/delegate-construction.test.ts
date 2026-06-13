/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * delegate-construction.test.ts: The first media-delegate construction tests - the proof the ProtectCameraHost interface segregation unlocks delegate testability.
 *
 * The ProtectCameraHost interface (the dependency-inversion seam on the camera side of the media stack) lets the recording, snapshot, and timeshift delegates type
 * their camera handle as a narrow contract instead of the concrete ProtectCamera. The promised payoff - the reason that step ran first - is that a delegate can now
 * be unit-constructed against a small stub host instead of a full camera. This suite cashes that in for the three Tier-1 (field-copy ctor) delegates: each
 * constructs against the reusable TestCameraHost double with no real camera and no FFmpeg.
 *
 * The construction proof for a field-copy ctor is necessarily thin, so the real-behavior anchor is the snapshot delegate's reachability gate, tested TWO-SIDED: with
 * the host unreachable getSnapshot returns null (the gate, the first statement of getSnapshot), and with the host reachable it returns the stub's controller Buffer
 * (the non-package pipeline falls through the timeshift and RTSP sources - both early-return on the host's undefined stream - to the controller source, with no crop
 * because the host's hints.crop is false). Two-sided proves isReachable is actually READ and that a stubbed seam value flows THROUGH the delegate's logic - the
 * capability the interface unlocked - not a coincidental null.
 *
 * The streaming delegate (Tier 2) is deferred: it builds a real FfmpegOptions and a real HAP CameraController the test HAP double does not provide, and its
 * construction is already exercised through the factory seam in camera-construction.test.ts.
 */
import { after, describe, test } from "node:test";
import { PROTECT_SEGMENT_RESOLUTION } from "./settings.ts";
import { ProtectRecordingDelegate } from "./record.ts";
import { ProtectSnapshot } from "./snapshot.ts";
import { ProtectTimeshiftBuffer } from "./timeshift.ts";
import assert from "node:assert/strict";
import { makeTestCameraHost } from "./testing.helpers.ts";

// Every host this suite builds shares the one makeTestNvr AbortController. Aborting it in teardown releases the harness signal so a leaked observer (none here, the
// trio ctors spawn none) could never outlive the suite. The trio ctors are pure field-copies, so construction floats no async machinery and needs no settle().
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

    const recording = new ProtectRecordingDelegate(host);

    assert.equal(recording.isRecording, false);
    assert.equal(recording.isTransmitting, false);
    assert.ok(recording.timeshift instanceof ProtectTimeshiftBuffer);
  });

  // The snapshot delegate: a field-copy ctor reading log only, then the suite's real-behavior anchor. The two-sided reachability gate proves the delegate actually
  // READS host.isReachable and that a stubbed seam value flows through its source pipeline.
  test("ProtectSnapshot constructs and its reachability gate is two-sided", async () => {

    const { controller, host } = makeTestCameraHost();

    controllers.push(controller);

    const snapshot = new ProtectSnapshot(host);

    // Side one: an unreachable host returns null before any pipeline runs - the gate, the first statement of getSnapshot. This proves isReachable is read at all.
    host.isReachable = false;
    assert.equal(await snapshot.getSnapshot(), null);

    // Side two: a reachable host returns the stub's controller Buffer. With stream undefined the timeshift and RTSP sources early-return, and with no packageCamera
    // key on the accessory context the non-package branch falls through to the controller source, which resolves snapshotResult; hints.crop is false so no crop pass
    // runs. The returned Buffer being exactly the stubbed value is the proof a seam value threads through the delegate's logic with no FFmpeg.
    host.isReachable = true;
    assert.equal(await snapshot.getSnapshot(), host.snapshotResult);

    // The controller source was actually the path taken - the seam was invoked exactly once on the reachable side (the unreachable side returned before any source).
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
});
