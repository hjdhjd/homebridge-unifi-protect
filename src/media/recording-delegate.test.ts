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
 * The segment-producing recording path (which exercises the pacing/reserve telemetry) now lives in recording-transmit.test.ts: it fills the timeshift buffer with the
 * harness's segment-yielding livestream double and constructs the FFmpeg process through the platform's recording-process factory seam, so it drives the transmit path
 * FFmpeg-free with deterministic injected-clock pacing.
 */
import { Characteristic, Service, makeTestCameraHost, settle } from "../testing.helpers.ts";
import { PROTECT_SEGMENT_RESOLUTION, PROTECT_TIMESHIFT_BUFFER_MAXDURATION } from "../settings.ts";
import { after, describe, test } from "node:test";
import type { CameraRecordingConfiguration } from "homebridge";
import type { ChannelProfile } from "./resolution.ts";
import { ProtectRecordingDelegate } from "./record.ts";
import { ProtectTimeshiftSupervisor } from "./timeshift-supervisor.ts";
import type { RecordingPacket } from "homebridge";
import type { TestCameraHost } from "../testing.helpers.ts";
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

// A minimal-but-truthy recording configuration cast to the HAP type at this confined seam. The supervisor reads only videoCodec.parameters.bitRate (the enable-ack
// config log) off it now that channel selection is HKSV-state-independent.
function makeRecordingConfig(): CameraRecordingConfiguration {

  return { prebufferLength: 4000, videoCodec: { parameters: { bitRate: 2000 } } } as unknown as CameraRecordingConfiguration;
}

// A ChannelProfile resolved from the host's first real channel, so the buffer starts against a genuine profile. Guarded because host.ufp.channels[0] widens to
// ProtectCameraChannelConfig | undefined under noUncheckedIndexedAccess.
function makeChannelProfile(host: TestCameraHost): ChannelProfile {

  const channel = host.ufp.channels[0];

  if(!channel) {

    throw new Error("The camera channel fixture is missing its first channel.");
  }

  return { channel, name: channel.name, resolution: [ 1920, 1080, 30 ], url: "rtsps://test" };
}

describe("recording delegate decline-path behavior", () => {

  // The decline-path contract, the suite's core. With recording never armed (isRecording is false at rest), the request-entry reconcile is skipped and the transmit gate
  // declines on the empty buffer: timeshift.time is zero (the segment-less stub) and the configured duration is one segment's worth (100ms), so the time-below-duration
  // branch fires. The delegate yields a single end-of-stream packet and completes. We assert the observable shape - exactly one yield, marked last, carrying a one-byte
  // payload - without reaching into the module-private HKSV_END_OF_STREAM_MARKER constant, which the test cannot and should not import.
  test("a fresh, unarmed delegate declines a recording event with exactly one end-of-stream packet", async () => {

    const { controller, host } = makeTestCameraHost();

    controllers.push(controller);

    const supervisor = new ProtectTimeshiftSupervisor(host);
    const delegate = new ProtectRecordingDelegate(host, supervisor);

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

    const supervisor = new ProtectTimeshiftSupervisor(host);
    const delegate = new ProtectRecordingDelegate(host, supervisor);

    const first = await drainRecordingStream(delegate, 1, new AbortController().signal);
    const second = await drainRecordingStream(delegate, 2, new AbortController().signal);

    assert.equal(first.length, 1);
    assert.equal(first[0]?.isLast, true);
    assert.equal(second.length, 1);
    assert.equal(second[0]?.isLast, true);
  });
});

describe("recording delegate synchronous configuration observables", () => {

  // Buffer sizing is the supervisor's concern, applied immediately before every start - not a synchronous write on the recording delegate.
  // updateRecordingConfiguration does not size the buffer: an unstarted buffer holds its one-segment seed, and the standing depth lands only when a reconcile actually
  // starts the buffer. This pre-first-start default window is decline-safe because an unstarted buffer holds zero time, so the depth value does not change the decline
  // behavior.
  test("the supervisor sizes the timeshift buffer at start time, not on updateRecordingConfiguration", async () => {

    const { controller, host } = makeTestCameraHost();

    controllers.push(controller);

    // Wire the success-path seams so an armed reconcile genuinely starts the buffer: a substrate channel to select and enough buffered segments for whenEstablished.
    host.selectSubstrateChannel = (): ChannelProfile => makeChannelProfile(host);
    host.livestreamMediaSegments = Math.ceil(PROTECT_TIMESHIFT_BUFFER_MAXDURATION / PROTECT_SEGMENT_RESOLUTION) + 10;

    const supervisor = new ProtectTimeshiftSupervisor(host);
    const delegate = new ProtectRecordingDelegate(host, supervisor);

    // At rest the buffer holds one segment's worth of configured duration (the timeshift seed of one segment).
    assert.equal(delegate.timeshift.configuredDuration, PROTECT_SEGMENT_RESOLUTION);

    // A configuration alone, with recording unarmed, does not size the buffer: the fire-and-forget reconcile it kicks off early-returns with the buffer unstarted, so
    // the depth stays at the seed.
    delegate.updateRecordingConfiguration(makeRecordingConfig());

    await settle();

    assert.equal(delegate.timeshift.configuredDuration, PROTECT_SEGMENT_RESOLUTION, "a configuration with recording unarmed does not size the buffer");

    // Arming recording drives a reconcile that starts the buffer, and the supervisor applies the standing depth immediately before that start.
    delegate.updateRecordingActive(true);

    await settle();

    assert.equal(delegate.timeshift.isStarted, true, "the armed reconcile started the buffer");
    assert.equal(delegate.timeshift.configuredDuration, PROTECT_TIMESHIFT_BUFFER_MAXDURATION, "the supervisor sized the buffer at start time");
  });

  // updateRecordingActive(false) forces MotionDetected to false on the camera's MotionSensor service synchronously - the write runs before the reconcile's first await,
  // and guardedDispatch invokes the handler synchronously, so the write lands immediately (before an inflight motion event could hold HomeKit's view stale past the
  // just-disabled state) even though the method itself is fire-and-forget. The write is guarded by an optional chain that no-ops when no MotionSensor exists, so the test
  // must first add one.
  test("updateRecordingActive(false) forces MotionDetected false on the motion sensor", async () => {

    const { accessory, controller, host } = makeTestCameraHost();

    controllers.push(controller);

    const supervisor = new ProtectTimeshiftSupervisor(host);
    const delegate = new ProtectRecordingDelegate(host, supervisor);

    // Add the MotionSensor service the production write targets; its marker seeds a MotionDetected characteristic, pre-set true to prove the disable write flips it.
    const motionService = accessory.addService(Service.MotionSensor);

    motionService.updateCharacteristic(Characteristic.MotionDetected, true);

    delegate.updateRecordingActive(false);

    assert.equal(accessory.getService(Service.MotionSensor)?.getCharacteristic(Characteristic.MotionDetected).value, false);
  });

  // guardedDispatch owns updateRecordingActive's async reconcile: HomeKit calls the void-returning method fire-and-forget, so a rejecting reconcile must be caught and
  // logged rather than surfacing as an unhandled rejection. We force setRecordingDemand to reject and prove both halves of the contract - the fault is logged and nothing
  // floats - with a test-scoped unhandledRejection listener, since the suites carry no ready-made float-detection seam. Pre-fix, when the method was a bare async whose
  // rejected promise HomeKit discarded, the same throw floated instead.
  test("a throwing recording activation is logged and never floats an unhandled rejection", async () => {

    const { controller, host, logEntries } = makeTestCameraHost();

    controllers.push(controller);

    const supervisor = new ProtectTimeshiftSupervisor(host);
    const delegate = new ProtectRecordingDelegate(host, supervisor);

    // Force the reconcile to reject so the void-returning handler must absorb the fault.
    supervisor.setRecordingDemand = async (): Promise<boolean> => { throw new Error("reconcile boom"); };

    // Install a test-scoped listener to capture any unhandled rejection that escapes the delegate during the drive, then remove it immediately after.
    const floats: unknown[] = [];
    const onFloat = (reason: unknown): void => { floats.push(reason); };

    process.on("unhandledRejection", onFloat);

    try {

      // HomeKit invokes this fire-and-forget; the internal reconcile rejects.
      delegate.updateRecordingActive(true);

      await settle();
      await settle();
    } finally {

      process.off("unhandledRejection", onFloat);
    }

    assert.equal(floats.length, 0, "the throwing activation did not float an unhandled rejection");
    assert.ok(logEntries.some((entry) => (entry.level === "error") && (entry.parameters[1] === "recording activation")),
      "the throwing activation surfaced through the guardedDispatch failure log");
  });

  // A smoke check that the HAP-facing close and acknowledge entry points do not throw at rest. With nothing transmitting, stopTransmitting early-returns at its
  // !_isTransmitting guard, so neither call does anything observable - this is a no-throw tripwire over the close path, NOT evidence about the per-event state.
  test("acknowledgeStream and closeRecordingStream do not throw at rest", () => {

    const { controller, host } = makeTestCameraHost();

    controllers.push(controller);

    const supervisor = new ProtectTimeshiftSupervisor(host);
    const delegate = new ProtectRecordingDelegate(host, supervisor);

    assert.doesNotThrow(() => delegate.acknowledgeStream());
    assert.doesNotThrow(() => delegate.closeRecordingStream(7));
  });
});
