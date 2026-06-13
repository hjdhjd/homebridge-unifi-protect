/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * recording-delegate.test.ts: The first behavior coverage of the HKSV recording delegate - a narrow decline-path contract plus the feasible synchronous observables.
 *
 * delegate-construction.test.ts proved the recording delegate CONSTRUCTS against the TestCameraHost stub; this suite is the first test that DRIVES it. Its core is the
 * decline-path contract: a fresh delegate, with HomeKit recording never armed, declines every recording event and yields exactly one end-of-stream packet. On the only
 * path reachable against the segment-less stub - timeshift.time is zero, below the configured prebuffer duration - the transmit gate declines, so the request handler
 * yields a single { data, isLast: true } marker and completes. We assert that observable shape (one yield, isLast true, a one-byte payload) without reaching into the
 * module-private end-of-stream marker constant.
 *
 * Honest framing of what this suite IS and is NOT: it is a SMOKE TRIPWIRE over the decline contract and the synchronous configuration observables - it catches a refactor
 * that throws out of, or breaks the generator/decline shape of, the recording delegate. It is NOT a guard on the delegate's per-event telemetry resets: on the reachable
 * decline path those fields are never read, so the suite would pass whether or not they were reset. The RecordingSession extraction's behavior-neutrality therefore rests
 * on a field-by-field source trace, not on this net; this net's value is the real-but-narrow one of pinning the observable decline contract green before and after.
 *
 * The segment-producing recording path (which would exercise the pacing/reserve telemetry) is infeasible against the current stub: the transmit gate declines whenever
 * timeshift.time is below the configured duration, and the stub's livestream yields no segments, so time stays zero; reaching the transmit path also spawns a real FFmpeg
 * process, breaching the suite's no-FFmpeg boundary. Building that harness is a separate, larger Phase-4 investment, deliberately out of scope here.
 */
import { Characteristic, Service, makeTestCameraHost } from "./testing.helpers.ts";
import { PROTECT_HKSV_TIMESHIFT_BUFFER_MAXDURATION, PROTECT_SEGMENT_RESOLUTION } from "./settings.ts";
import { after, describe, test } from "node:test";
import type { CameraRecordingConfiguration } from "homebridge";
import { ProtectRecordingDelegate } from "./record.ts";
import type { RecordingPacket } from "homebridge";
import assert from "node:assert/strict";

// Every host this suite builds shares the one makeTestNvr AbortController. Aborting it in teardown releases the harness signal so a leaked observer (none here, the
// recording delegate spawns none at construction) could never outlive the suite.
const controllers: AbortController[] = [];

after(() => {

  for(const controller of controllers) {

    controller.abort();
  }
});

// Drain the recording delegate's async generator into an array of the packets it yielded. The decline path yields exactly one packet then returns, so the drain
// terminates without needing the AbortSignal - but we still pass HAP's signal through faithfully, the way HAP-nodejs would on a real recording stream request.
async function drainRecordingStream(delegate: ProtectRecordingDelegate, streamId: number, signal: AbortSignal): Promise<RecordingPacket[]> {

  const packets: RecordingPacket[] = [];

  for await (const packet of delegate.handleRecordingStreamRequest(streamId, signal)) {

    packets.push(packet);
  }

  return packets;
}

describe("recording delegate decline-path behavior", () => {

  // The decline-path contract, the suite's core. With recording never armed (isRecording is false at rest), the request-entry reconcile is skipped and the transmit gate
  // declines on the empty buffer: timeshift.time is zero (the segment-less stub) and the configured duration is one segment's worth (100ms), so the time-below-duration
  // branch fires. The delegate yields a single end-of-stream packet and completes. We assert the observable shape - exactly one yield, marked last, carrying a one-byte
  // payload - without reaching into the module-private HKSV_END_OF_STREAM_MARKER constant, which the test cannot and should not import.
  test("a fresh, unarmed delegate declines a recording event with exactly one end-of-stream packet", async () => {

    const { controller, host } = makeTestCameraHost();

    controllers.push(controller);

    const delegate = new ProtectRecordingDelegate(host);

    // Recording is not armed, so the delegate is in its decline posture: the buffer is empty (time zero) and below the one-segment configured duration.
    assert.equal(delegate.isRecording, false);

    const packets = await drainRecordingStream(delegate, 1, new AbortController().signal);

    // Exactly one packet, marked as the last, carrying a single byte - the end-of-stream marker's observable shape.
    assert.equal(packets.length, 1);
    assert.equal(packets[0]?.isLast, true);
    assert.equal(packets[0]?.data.length, 1);
  });

  // A reused delegate declines a second event without crashing. This proves the generator/decline path survives re-entry on the same delegate instance - the lifecycle a
  // real camera sees across successive HKSV events - and is the closest a decline-only path comes to exercising the delegate's per-event re-entry. It is NOT a guard on
  // the per-event resets (unobservable on the decline path); it is a re-entry smoke check.
  test("a reused delegate declines a second event without crashing", async () => {

    const { controller, host } = makeTestCameraHost();

    controllers.push(controller);

    const delegate = new ProtectRecordingDelegate(host);

    const first = await drainRecordingStream(delegate, 1, new AbortController().signal);
    const second = await drainRecordingStream(delegate, 2, new AbortController().signal);

    assert.equal(first.length, 1);
    assert.equal(first[0]?.isLast, true);
    assert.equal(second.length, 1);
    assert.equal(second[0]?.isLast, true);
  });
});

describe("recording delegate synchronous configuration observables", () => {

  // updateRecordingConfiguration writes the timeshift buffer's configured duration synchronously when handed a configuration. The fire-and-forget reconcile it kicks off
  // takes the shouldRun-false early return with recording unarmed, so it never reaches selectRecordingChannel and needs no stub for it. We observe the synchronous write
  // through the public configuredDuration derivation (segmentCount * segmentLength), which equals the HKSV timeshift max duration after the configuration lands.
  test("updateRecordingConfiguration sets the timeshift configured duration synchronously", () => {

    const { controller, host } = makeTestCameraHost();

    controllers.push(controller);

    const delegate = new ProtectRecordingDelegate(host);

    // At rest the buffer holds one segment's worth of configured duration (the timeshift seed of one segment).
    assert.equal(delegate.timeshift.configuredDuration, PROTECT_SEGMENT_RESOLUTION);

    // A minimal-but-truthy recording configuration: only its truthiness drives the synchronous configuredDuration write, and the reconcile it fires early-returns before
    // reading any of its fields (recording is unarmed). We cast a minimal literal to the HAP type at this confined seam, the same discipline the harness builders use.
    const configuration = { prebufferLength: 4000 } as unknown as CameraRecordingConfiguration;

    delegate.updateRecordingConfiguration(configuration);

    assert.equal(delegate.timeshift.configuredDuration, PROTECT_HKSV_TIMESHIFT_BUFFER_MAXDURATION);
  });

  // updateRecordingActive(false) forces MotionDetected to false on the camera's MotionSensor service synchronously, before its await, so an inflight motion event cannot
  // hold HomeKit's view stale past the just-disabled state. The write is guarded by an optional chain that no-ops when no MotionSensor exists, so the test must first add
  // one. With recording unarmed the awaited reconcile resolves cleanly (it reports "stopped was the desired outcome"), so the call returns without throwing.
  test("updateRecordingActive(false) forces MotionDetected false on the motion sensor", async () => {

    const { accessory, controller, host } = makeTestCameraHost();

    controllers.push(controller);

    const delegate = new ProtectRecordingDelegate(host);

    // Add the MotionSensor service the production write targets; its marker seeds a MotionDetected characteristic, pre-set true to prove the disable write flips it.
    const motionService = accessory.addService(Service.MotionSensor);

    motionService.updateCharacteristic(Characteristic.MotionDetected, true);

    await delegate.updateRecordingActive(false);

    assert.equal(accessory.getService(Service.MotionSensor)?.getCharacteristic(Characteristic.MotionDetected).value, false);
  });

  // A smoke check that the HAP-facing close and acknowledge entry points do not throw at rest. With nothing transmitting, stopTransmitting early-returns at its
  // !_isTransmitting guard, so neither call does anything observable - this is a no-throw tripwire over the close path, NOT evidence about the per-event state.
  test("acknowledgeStream and closeRecordingStream do not throw at rest", () => {

    const { controller, host } = makeTestCameraHost();

    controllers.push(controller);

    const delegate = new ProtectRecordingDelegate(host);

    assert.doesNotThrow(() => delegate.acknowledgeStream());
    assert.doesNotThrow(() => delegate.closeRecordingStream(7));
  });
});
