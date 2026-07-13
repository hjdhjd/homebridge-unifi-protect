/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * recording-transmit.test.ts: Behavior coverage of the HKSV recording delegate's segment-producing transmit path - the net the decline-only suite deferred.
 *
 * recording-delegate.test.ts proved the decline contract but could not reach the transmit path: against a segment-less livestream stub the timeshift buffer never fills,
 * so the gate always declines, and reaching transmit at all would spawn a real FFmpeg child. This suite clears both blockers FFmpeg-free. It fills the timeshift buffer
 * with the harness's segment-yielding livestream double (real keyframe-bearing fMP4 the production isKeyframe parse accepts), and it constructs the FFmpeg process
 * through the platform's recording-process factory seam - injecting an FFmpeg-free TestRecordingProcess - so the delegate runs its full accept-path logic with no child.
 *
 * Pacing is made deterministic by the injected clock, not by node:test mock timers (which cannot reach the production node:timers/promises delay) and not by mocking
 * Date: the delegate reads platform.clock for both its delay() and its now(), and the test holds that exact TestClock instance (returned by makeTestCameraHost). The
 * drainPaced helper advances virtual time by exactly the pacing interval per pull, so lastPacingDelay computes to exactly that interval and the telemetry is exactly
 * assertable. The assertions are behavior-first throughout: yielded RecordingPackets, the factory's createCalls, the host's livestreamCalls, the process's stdinWrites,
 * and captured log telemetry - never a private session field.
 */
import type { CameraRecordingConfiguration, RecordingPacket } from "homebridge";
import { HDSProtocolSpecificErrorReason, HKSV_TIMEOUT, TestRecordingProcess, TestRecordingProcessFactory } from "homebridge-plugin-utils";
import { PROTECT_SEGMENT_RESOLUTION, PROTECT_TIMESHIFT_BUFFER_MAXDURATION } from "../settings.ts";
import type { RecordingProcessFactory, TestClock, TestRecordingProcessInit } from "homebridge-plugin-utils";
import type { TestCameraHost, TestLogEntry, TestProtectNvr } from "../testing.helpers.ts";
import { TestStreamingDelegate, makeTestCameraHost, settle } from "../testing.helpers.ts";
import { after, describe, test } from "node:test";
import type { ChannelProfile } from "./resolution.ts";
import { ProtectRecordingDelegate } from "./record.ts";
import { ProtectTimeshiftSupervisor } from "./timeshift-supervisor.ts";
import assert from "node:assert/strict";

// The exact pacing interval the delegate computes between yields: HKSV_TIMEOUT minus the 500ms HomeKit-timeout safety margin. Because the injected clock is
// advanced by exactly this much per pull, lastPacingDelay and maxPacingDelay both compute to exactly this value, so the pacing telemetry is exactly assertable.
const PACING_INTERVAL = HKSV_TIMEOUT - 500;

// Every host this suite builds shares the one makeTestNvr AbortController. Aborting them in teardown releases the harness signals so any leaked observer (none here -
// the recording delegate spawns none at construction) could never outlive the suite.
const controllers: AbortController[] = [];

after(() => {

  for(const controller of controllers) {

    controller.abort();
  }
});

// The count of INFO/WARN log lines whose first format string contains the given fragment - the harness records the raw parameters, so we match the message template. The
// enable-ack re-acknowledgment test counts occurrences (not a boolean .some()), because a boolean would pass after the FIRST enable regardless of whether the second
// re-acknowledged - the count discriminates the per-enable acknowledgment behavior.
function countLogs(entries: TestLogEntry[], level: TestLogEntry["level"], fragment: string): number {

  return entries.filter((entry) => (entry.level === level) && (typeof entry.parameters[0] === "string") && entry.parameters[0].includes(fragment)).length;
}

// A minimal-but-truthy recording configuration cast to the HAP type at this confined seam - the same harness discipline the decline suite uses. The transmit path reads
// only videoCodec.parameters.bitRate (the enable-ack config log) and prebufferLength; videoCodec.resolution is present solely to satisfy the
// CameraRecordingConfiguration shape and is not consumed by the code under test. prebufferLength is well below the filled buffer time (10000ms) so the
// early-end telemetry gate's time >= prebufferLength conjunct stays satisfied.
function makeRecordingConfig(): CameraRecordingConfiguration {

  return { prebufferLength: 4000, videoCodec: { parameters: { bitRate: 2000 }, resolution: [ 1920, 1080, 30 ] } } as unknown as CameraRecordingConfiguration;
}

// A ChannelProfile resolved from a real G2 Pro channel, so the channel's id and fps reach the recording-process init exactly as production composes them. We guard the
// indexed access because host.ufp.channels[0] widens to ProtectCameraChannelConfig | undefined under noUncheckedIndexedAccess.
function makeChannelProfile(host: TestCameraHost): ChannelProfile {

  const channel = host.ufp.channels[0];

  if(!channel) {

    throw new Error("The G2 Pro channel fixture is missing its first channel.");
  }

  return { channel, name: channel.name, resolution: [ 1920, 1080, 30 ], url: "rtsps://test" };
}

// A test-local recording-process factory that hands back a FRESH configured TestRecordingProcess per create call, in sequence, recording every create.
// homebridge-plugin-utils' TestRecordingProcessFactory returns either one shared process (which aborts at the first close, so a second event or a discontinuity restart
// receives an inert aborted process) or fresh DEFAULTS (no segments) - neither gives fresh-CONFIGURED-per-create, which a multi-event or restart test needs so each
// event's process yields its own segments. (A possible future refinement: homebridge-plugin-utils' factory could grow a sequenced variant so this lives in the
// library; it is kept test-local here for now.)
function makeSequencedRecordingFactory(inits: TestRecordingProcessInit[]): RecordingProcessFactory & { createCalls: { process: TestRecordingProcess }[] } {

  let index = 0;
  const createCalls: { process: TestRecordingProcess }[] = [];

  return {

    create: (): TestRecordingProcess => {

      const process = new TestRecordingProcess(inits[index++] ?? {});

      createCalls.push({ process });

      return process;
    },
    createCalls
  };
}

// Drain a transmitting request generator, advancing the injected clock by exactly the pacing interval per pull so each paced yield (the init segment is paced too)
// releases instantly. For each pull: kick off gen.next(), settle() to walk the generator to its next clock.delay registration (or to completion), advance the clock to
// cross that delay's deadline (a no-op on a completed generator), then await the pull. lastPacingDelay computes to exactly PACING_INTERVAL every segment, so the pacing
// telemetry is exact. maxPulls bounds the loop so a regression that fails to terminate surfaces as a bounded array rather than a hang. The await is intentionally serial,
// each pacing pull must release before the next, so the in-loop await is the correct shape here, not a parallelizable one.
async function drainPaced(gen: AsyncGenerator<RecordingPacket>, clock: TestClock, maxPulls = 30): Promise<RecordingPacket[]> {

  const packets: RecordingPacket[] = [];

  for(let pull = 0; pull < maxPulls; pull++) {

    const next = gen.next();

    // eslint-disable-next-line no-await-in-loop -- The pacing pulls are intentionally serial: each yield must be released before the next is requested.
    await settle();
    clock.advance(PACING_INTERVAL);

    // eslint-disable-next-line no-await-in-loop -- The pacing pulls are intentionally serial: each yield must be released before the next is requested.
    const result = await next;

    if(result.done) {

      break;
    }

    packets.push(result.value);
  }

  return packets;
}

// The arranged transmitting delegate plus the handles a test asserts against. The clock is the controllable TestClock the delegate's pacing awaits; logEntries captures
// the telemetry log; host exposes the seam call logs; nvr is the controller double backing the context.
interface TransmittingArrange {

  clock: TestClock;
  delegate: ProtectRecordingDelegate;
  host: TestCameraHost;
  logEntries: TestLogEntry[];
  nvr: TestProtectNvr;
}

// Arrange an armed, buffer-filled, transmit-ready delegate from a supplied recording-process factory. Sets the host's stream and channel selector, fills the timeshift
// buffer past its configured duration with the segment-yielding livestream double, enables the telemetry feature so the reserve sampling and the early-end telemetry
// fragment run, then arms recording and settles so the consume loop drains the (parking) iterator and timeshift.time reaches the configured duration.
async function buildTransmittingDelegate(factory: RecordingProcessFactory): Promise<TransmittingArrange> {

  const { clock, controller, host, logEntries, nvr } = makeTestCameraHost({ recordingProcessFactory: factory });

  controllers.push(controller);

  host.stream = new TestStreamingDelegate();
  host.selectSubstrateChannel = (): ChannelProfile => makeChannelProfile(host);

  // Over-fill the buffer: the timeshift caps at its segment count (100), so any value at or above that fills time to exactly the configured duration. We over-fill by a
  // margin so the strict time < configuredDuration gate clears with room to spare.
  host.livestreamMediaSegments = Math.ceil(PROTECT_TIMESHIFT_BUFFER_MAXDURATION / PROTECT_SEGMENT_RESOLUTION) + 10;
  host.hasFeature = (option: string): boolean => option === "Debug.Video.HKSV.Telemetry";

  const supervisor = new ProtectTimeshiftSupervisor(host);
  const delegate = new ProtectRecordingDelegate(host, supervisor);

  delegate.updateRecordingConfiguration(makeRecordingConfig());
  delegate.updateRecordingActive(true);

  // Drain the background consume loop up to the iterator's park, so the buffer reaches the configured duration before the first request.
  await settle();

  return { clock, delegate, host, logEntries, nvr };
}

// Find the early-end telemetry log a closeRecordingStream emitted. record.ts logs error("HKSV recording event ended early: %s%s", reasonDescription, telemetry), so the
// log's first parameter is the format string and the telemetry payload is the THIRD parameter (the %s%s template's second substitution) - never a pre-formatted string.
function findEndedEarlyTelemetry(logEntries: TestLogEntry[], fromIndex = 0): string {

  const entry = logEntries.slice(fromIndex).find((e) => (e.level === "error") && String(e.parameters[0]).includes("ended early"));

  assert.ok(entry, "Expected an early-end telemetry log entry.");

  return String(entry.parameters[2]);
}

describe("recording delegate transmit-path behavior", () => {

  // Test A - the accept path. The delegate constructs its FFmpeg process through the factory exactly once, opens the livestream on the resolved channel, feeds the
  // timeshift's concatenated buffer to the process's stdin, and yields the init segment plus the three media segments the process produces, each NOT marked last. After
  // the close, the early-end telemetry reports the off-by-one-discounted yield count, the exact deterministic pacing delay, and the finite reserve depth (proving the
  // POSITIVE_INFINITY reserveMin sentinel was overwritten and never logged).
  test("accepts a recording event, constructs the FFmpeg process once, and yields paced fMP4 packets with exact telemetry", async () => {

    const ffmpegProcess = new TestRecordingProcess({ bufferedSegments: 5, initSegment: Buffer.from("init"),
      segments: [ Buffer.from("seg1"), Buffer.from("seg2"), Buffer.from("seg3") ] });
    const recordingProcessFactory = new TestRecordingProcessFactory(ffmpegProcess);
    const { clock, delegate, host, logEntries } = await buildTransmittingDelegate(recordingProcessFactory);

    const packets = await drainPaced(delegate.handleRecordingStreamRequest(1, new AbortController().signal), clock);

    // Exactly four packets - the init segment plus the three media segments - none marked last (the accept path never yields the one-byte end-of-stream marker).
    assert.equal(packets.length, 4);

    for(const packet of packets) {

      assert.equal(packet.isLast, false);
    }

    // The factory was constructed exactly once, with the host's own ffmpegOptions.
    assert.equal(recordingProcessFactory.createCalls.length, 1);
    assert.equal(recordingProcessFactory.createCalls[0]?.options, host.stream?.ffmpegOptions);

    // The timeshift's concatenated buffer was fed to FFmpeg, and the buffer was opened on the resolved channel.
    assert.ok(ffmpegProcess.stdinWrites.length >= 1);
    assert.equal(host.livestreamCalls.length, 1);

    // Drive the early-end telemetry log via a non-normal close.
    delegate.closeRecordingStream(1, HDSProtocolSpecificErrorReason.TIMEOUT);

    const telemetry = findEndedEarlyTelemetry(logEntries);

    // The event id, the off-by-one-discounted yield count (four transmitted minus the one init-header discount), the exact deterministic pacing delay, and the finite
    // reserve (min(Infinity, 5) = 5, NOT "Infinity").
    assert.ok(telemetry.includes("event: 1"), telemetry);
    assert.ok(telemetry.includes("segments yielded: 3"), telemetry);
    assert.ok(telemetry.includes("pacing delay: 4000/4000ms"), telemetry);
    assert.ok(telemetry.includes("reserve: 5"), telemetry);
  });

  // Test B - the decline negative control. With an empty buffer (no media segments) the transmit gate declines: the delegate yields exactly one one-byte end-of-stream
  // packet and NEVER constructs the FFmpeg process. This is the accept-vs-decline pair against Test A.
  test("declines an event on an empty buffer and never constructs the FFmpeg process", async () => {

    const recordingProcessFactory = new TestRecordingProcessFactory();
    const { controller, host } = makeTestCameraHost({ recordingProcessFactory });

    controllers.push(controller);

    host.stream = new TestStreamingDelegate();
    host.selectSubstrateChannel = (): ChannelProfile => makeChannelProfile(host);

    // Leave the buffer empty so timeshift.time stays 0, below the configured duration.
    host.livestreamMediaSegments = 0;

    const supervisor = new ProtectTimeshiftSupervisor(host);
    const delegate = new ProtectRecordingDelegate(host, supervisor);

    delegate.updateRecordingConfiguration(makeRecordingConfig());
    delegate.updateRecordingActive(true);
    await settle();

    const packets: RecordingPacket[] = [];

    for await (const packet of delegate.handleRecordingStreamRequest(1, new AbortController().signal)) {

      packets.push(packet);
    }

    // Exactly one packet, marked last, one byte - the decline contract. And the factory was never constructed.
    assert.equal(packets.length, 1);
    assert.equal(packets[0]?.isLast, true);
    assert.equal(packets[0]?.data.length, 1);
    assert.equal(recordingProcessFactory.createCalls.length, 0);
  });

  // Test C - per-event RecordingSession reset. Two successive events on one armed delegate, each create handing back a fresh configured process (3 media for event 1, 1
  // for event 2) via the sequenced factory. The two telemetry logs carry distinct event ids AND distinct yield counts - event 2's count is its own (1, not 3 and not an
  // accumulation of event 1's) - which is the behavior-first proof a fresh RecordingSession is established per request. Event 2's telemetry also carries its own reserve
  // fragment, re-seeded from POSITIVE_INFINITY to a finite value (here 0, since the sequenced inits set no bufferedSegments) - the load-bearing observable is the
  // per-event re-seed away from the Infinity sentinel, not a positive count.
  test("establishes a fresh per-event session so successive events report independent telemetry", async () => {

    const factory = makeSequencedRecordingFactory([
      { segments: [ Buffer.from("seg1"), Buffer.from("seg2"), Buffer.from("seg3") ] },
      { segments: [Buffer.from("seg1")] }
    ]);
    const { clock, delegate, logEntries } = await buildTransmittingDelegate(factory);

    // Event 1: three media segments yielded, then closed.
    const firstPackets = await drainPaced(delegate.handleRecordingStreamRequest(1, new AbortController().signal), clock);

    assert.equal(firstPackets.length, 4);

    delegate.closeRecordingStream(1, HDSProtocolSpecificErrorReason.TIMEOUT);

    const firstTelemetry = findEndedEarlyTelemetry(logEntries);
    const afterFirst = logEntries.length;

    assert.ok(firstTelemetry.includes("event: 1"), firstTelemetry);
    assert.ok(firstTelemetry.includes("segments yielded: 3"), firstTelemetry);

    // Event 2: a fresh process yields a single media segment, then closed.
    const secondPackets = await drainPaced(delegate.handleRecordingStreamRequest(2, new AbortController().signal), clock);

    assert.equal(secondPackets.length, 2);

    delegate.closeRecordingStream(2, HDSProtocolSpecificErrorReason.TIMEOUT);

    const secondTelemetry = findEndedEarlyTelemetry(logEntries, afterFirst);

    // Event 2's id and yield count are its own - one, the single media segment it produced, not three and not an accumulation.
    assert.ok(secondTelemetry.includes("event: 2"), secondTelemetry);
    assert.ok(secondTelemetry.includes("segments yielded: 1"), secondTelemetry);

    // Event 2 carries its own reserve fragment, re-seeded from the POSITIVE_INFINITY sentinel to a finite value (never logged as "Infinity").
    assert.ok(secondTelemetry.includes("reserve:"), secondTelemetry);
    assert.ok(!secondTelemetry.includes("Infinity"), secondTelemetry);
  });

  // Test D - discontinuity restart. While the generator is parked in its pacing delay (after settle(), before advancing the clock, so the abort interrupts the in-flight
  // delay), a timeshift discontinuity fires: the delegate aborts the first process, breaks the segment loop, re-enters the do-while, and creates a SECOND process through
  // the factory. With the sequenced factory the second create returns a fresh working process, so packets continue to be yielded after the restart - proving the restart
  // both fired (a second create) and resumed (post-restart segments reach HomeKit).
  test("restarts the FFmpeg process on a livestream discontinuity and resumes yielding", async () => {

    const factory = makeSequencedRecordingFactory([
      { segments: [ Buffer.from("seg1"), Buffer.from("seg2"), Buffer.from("seg3"), Buffer.from("seg4") ] },
      { segments: [ Buffer.from("seg5"), Buffer.from("seg6") ] }
    ]);
    const { clock, delegate } = await buildTransmittingDelegate(factory);

    const gen = delegate.handleRecordingStreamRequest(1, new AbortController().signal);
    const packets: RecordingPacket[] = [];

    // Pull the first packet (the init segment) to completion.
    const first = gen.next();

    await settle();
    clock.advance(PACING_INTERVAL);

    const firstResult = await first;

    if(!firstResult.done) {

      packets.push(firstResult.value);
    }

    // Walk the generator to its next pacing delay, then - while parked in that delay - fire the discontinuity so the abort interrupts the in-flight pace.
    const interrupted = gen.next();

    await settle();
    delegate.timeshift.emit("discontinuity");

    const interruptedResult = await interrupted;

    if(!interruptedResult.done) {

      packets.push(interruptedResult.value);
    }

    // Continue draining the restarted stream to completion.
    const rest = await drainPaced(gen, clock);

    packets.push(...rest);

    // The restart fired a second create, and the resumed process's segments reached HomeKit. We assert on rest (the packets drained AFTER the discontinuity) rather than
    // the running total, so the resume half is genuinely discriminating: packets already held the pre-restart init and in-flight segment, so a total >= 2 would pass even
    // if the restarted process yielded nothing.
    assert.equal(factory.createCalls.length, 2);
    assert.ok(rest.length >= 1, "Expected the restarted process to resume yielding segments after the discontinuity.");
  });

  // Test E - terminated exit. While the generator is parked in its pacing delay, timeshift.stop() fires (the real public method): finalizeSubscription emits terminated
  // since the delegate is transmitting, and disposes the subscription (releasing the parked livestream double). The post-loop teardown yields a final end-of-stream
  // marker on the terminated branch.
  test("yields a final end-of-stream marker when the timeshift subscription terminates", async () => {

    const ffmpegProcess = new TestRecordingProcess({ initSegment: Buffer.from("init"),
      segments: [ Buffer.from("seg1"), Buffer.from("seg2"), Buffer.from("seg3") ] });
    const recordingProcessFactory = new TestRecordingProcessFactory(ffmpegProcess);
    const { clock, delegate } = await buildTransmittingDelegate(recordingProcessFactory);

    const gen = delegate.handleRecordingStreamRequest(1, new AbortController().signal);
    const packets: RecordingPacket[] = [];

    // Pull the first packet to completion.
    const first = gen.next();

    await settle();
    clock.advance(PACING_INTERVAL);

    const firstResult = await first;

    if(!firstResult.done) {

      packets.push(firstResult.value);
    }

    // Walk the generator to its next pacing delay, then - while parked - terminate the subscription.
    const interrupted = gen.next();

    await settle();
    delegate.timeshift.stop();

    const interruptedResult = await interrupted;

    if(!interruptedResult.done) {

      packets.push(interruptedResult.value);
    }

    // Drain the rest to completion.
    const rest = await drainPaced(gen, clock);

    packets.push(...rest);

    // The final yielded packet is the end-of-stream marker on the terminated branch.
    assert.equal(packets.at(-1)?.isLast, true);
    assert.equal(packets.at(-1)?.data.length, 1);
  });

  // Test K - the recorded-event summary is session-scoped. An accepted event whose buffer dies mid-flight is still a recording HomeKit accepted: when HomeKit closes it
  // normally and HKSV event logging is enabled, the summary line fires from the per-event counters alone, even though the buffer's channel profile has already cleared
  // at teardown. This pins the summary against the session, not against live buffer state.
  test("logs the recorded-event summary on a normal close even when the buffer died mid-event", async () => {

    const ffmpegProcess = new TestRecordingProcess({ initSegment: Buffer.from("init"),
      segments: [ Buffer.from("seg1"), Buffer.from("seg2"), Buffer.from("seg3") ] });
    const recordingProcessFactory = new TestRecordingProcessFactory(ffmpegProcess);
    const { clock, delegate, host, logEntries } = await buildTransmittingDelegate(recordingProcessFactory);

    // Enable the HKSV event-summary logging the summary line is gated on.
    host.hints.logHksv = true;

    const gen = delegate.handleRecordingStreamRequest(1, new AbortController().signal);

    // Pull the first packet to completion.
    const first = gen.next();

    await settle();
    clock.advance(PACING_INTERVAL);
    await first;

    // Feed two more segments through the transmit listener while the event is live, so the per-event timeshifted counter survives the header discount at the close.
    delegate.timeshift.emit("segment", Buffer.from("live1"));
    delegate.timeshift.emit("segment", Buffer.from("live2"));
    await settle();

    // Walk the generator to its next pacing delay, then - while parked - terminate the subscription out from under the event. The source is gone (no further segments),
    // so when the stop emits its cause the supervisor's re-establish attempt cannot succeed and the buffer stays down.
    const interrupted = gen.next();

    await settle();
    host.livestreamMediaSegments = 0;
    delegate.timeshift.stop();
    await interrupted;
    await drainPaced(gen, clock);
    await settle();

    // The buffer's channel profile has cleared with the teardown and, the source being gone, stays null - the exact state the summary must not depend on.
    assert.equal(delegate.timeshift.channelProfile, null);

    // HomeKit accepted what it received and closes the event normally.
    delegate.closeRecordingStream(1, HDSProtocolSpecificErrorReason.NORMAL);

    // The summary fires from the session's own counters: two timeshifted segments after the header discount, at 100ms each.
    const summary = logEntries.find((e) => (e.level === "info") && (String(e.parameters[0]) === "HKSV: %s %s event."));

    assert.ok(summary, "Expected the recorded-event summary log entry.");
    assert.equal(summary.parameters[1], "0.2");
    assert.equal(summary.parameters[2], "second");
  });

  // Test F - FFmpeg-timeout exit. With a process that yields no media and reports isTimedOut, the segments() generator ends immediately; the init segment is still paced
  // (so the drain must advance the clock), and the post-loop teardown yields a final end-of-stream marker on the FFmpeg-timeout branch.
  test("yields a final end-of-stream marker when the FFmpeg process times out", async () => {

    const ffmpegProcess = new TestRecordingProcess({ initSegment: Buffer.from("init"), isTimedOut: true, segments: [] });
    const recordingProcessFactory = new TestRecordingProcessFactory(ffmpegProcess);
    const { clock, delegate } = await buildTransmittingDelegate(recordingProcessFactory);

    const packets = await drainPaced(delegate.handleRecordingStreamRequest(1, new AbortController().signal), clock);

    // The final yielded packet is the end-of-stream marker on the FFmpeg-timeout branch.
    assert.equal(packets.at(-1)?.isLast, true);
    assert.equal(packets.at(-1)?.data.length, 1);
  });

  // Test H - the fed-but-stuck warning. A recording the watchdog reaped (isTimedOut) while the camera was STILL delivering segments is a genuine local stall, not a
  // starved source. We drain the timed-out event (advancing the clock past the watchdog window, so the transmit-start arrival goes stale), then emit one fresh segment
  // to mark the source alive at the close, so the finalization sees a recent arrival under a timeout and warns once. acknowledgeStream closes with no HAP reason - the
  // production-faithful close for a timed-out event - so the early-end telemetry error stays gated off and only this warning can fire.
  test("warns once when a recording times out while the camera is still delivering segments", async () => {

    const ffmpegProcess = new TestRecordingProcess({ initSegment: Buffer.from("init"), isTimedOut: true, segments: [Buffer.from("seg1")] });
    const recordingProcessFactory = new TestRecordingProcessFactory(ffmpegProcess);
    const { clock, delegate, logEntries } = await buildTransmittingDelegate(recordingProcessFactory);

    await drainPaced(delegate.handleRecordingStreamRequest(1, new AbortController().signal), clock);

    // The camera is still streaming: a fresh segment arrives at the current clock, just before HomeKit closes the event.
    delegate.timeshift.emit("segment", Buffer.from("live"));
    delegate.acknowledgeStream();

    assert.equal(countLogs(logEntries, "warn", "while the camera was still streaming"), 1);
  });

  // Test I - the starved source stays calm. The same timed-out recording, but no fresh segment arrives before the close: the source has gone quiet, so the only
  // arrival was the transmit-start one, now stale after the drain advanced the clock past the watchdog window. The finalization sees a stale arrival under a timeout
  // and says nothing - the benign starve the offline/deferred path already narrates. The discriminant against Test H is exactly the absence of the fresh arrival.
  test("stays quiet when a recording times out after the source has gone quiet", async () => {

    const ffmpegProcess = new TestRecordingProcess({ initSegment: Buffer.from("init"), isTimedOut: true, segments: [Buffer.from("seg1")] });
    const recordingProcessFactory = new TestRecordingProcessFactory(ffmpegProcess);
    const { clock, delegate, logEntries } = await buildTransmittingDelegate(recordingProcessFactory);

    await drainPaced(delegate.handleRecordingStreamRequest(1, new AbortController().signal), clock);

    // No fresh segment arrives - the source quieted - so the last arrival is the now-stale transmit-start one.
    delegate.acknowledgeStream();

    assert.equal(countLogs(logEntries, "warn", "while the camera was still streaming"), 0);
  });

  // Test J - a recording that did not time out is unaffected. Even with a fresh arrival right before the close, a recording the watchdog did NOT reap (isTimedOut
  // false) never warns: the warning is gated on the timeout, since a recent arrival alone is the normal healthy case, not a stall. The discriminant against Test H
  // is exactly the timeout flag.
  test("stays quiet when the recording did not time out even though the source is still delivering segments", async () => {

    const ffmpegProcess = new TestRecordingProcess({ initSegment: Buffer.from("init"), isTimedOut: false, segments: [Buffer.from("seg1")] });
    const recordingProcessFactory = new TestRecordingProcessFactory(ffmpegProcess);
    const { clock, delegate, logEntries } = await buildTransmittingDelegate(recordingProcessFactory);

    await drainPaced(delegate.handleRecordingStreamRequest(1, new AbortController().signal), clock);

    // A fresh segment arrives (recent arrival), but the watchdog did not reap this event, so there is no stall to warn about.
    delegate.timeshift.emit("segment", Buffer.from("live"));
    delegate.acknowledgeStream();

    assert.equal(countLogs(logEntries, "warn", "while the camera was still streaming"), 0);
  });
});
