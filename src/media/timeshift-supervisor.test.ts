/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * timeshift-supervisor.test.ts: Behavior coverage of the timeshift buffer supervisor - the reconciler's lifecycle authority over the standing buffer.
 *
 * The supervisor owns the reconcile loop, the pushed recording demand, the per-episode narration state, and the terminal shutdown latch; the recording delegate
 * consumes it through the configureTimeshifting forwarder and the setRecordingDemand pushes. This suite covers that surface from both directions: through the
 * delegate's public seams (the deferred-offline and resolution narration, and the enable-acknowledgment lifecycle - reconcile-only behaviors that never touch the
 * transmit path, so no recording-process factory is involved) and through the supervisor directly (the demand-edge episode resets, the shutdown latch, the buffer's
 * channel-profile lifecycle, and the forwarder's promise-identity join semantics).
 *
 * The arrangement reuses the harness's camera-host double end to end: the segment-yielding parking livestream double fills the buffer so starts genuinely succeed,
 * the controllable livestream double drives the channel-profile lifecycle's failure and out-of-band-death arms, and the recorded log sink carries the narration
 * assertions. The assertions are behavior-first throughout: captured log lines, public buffer state, seam call counts, and promise identity - never a private field.
 */
import type { ControllableLivestreamDouble, TestCameraHost, TestLogEntry, TestProtectNvr } from "../testing.helpers.ts";
import { PROTECT_SEGMENT_RESOLUTION, PROTECT_TIMESHIFT_BUFFER_MAXDURATION } from "../settings.ts";
import { TestStreamingDelegate, makeControllableLivestreamDouble, makeTestCameraHost, settle } from "../testing.helpers.ts";
import { after, describe, test } from "node:test";
import type { CameraRecordingConfiguration } from "homebridge";
import type { ChannelProfile } from "./resolution.ts";
import { ProtectLivestreamUnavailableError } from "unifi-protect";
import { ProtectRecordingDelegate } from "./record.ts";
import { ProtectTimeshiftSupervisor } from "./timeshift-supervisor.ts";
import assert from "node:assert/strict";

// Every host this suite builds shares the one makeTestNvr AbortController. Aborting them in teardown releases the harness signals so any leaked observer (none here -
// neither the supervisor nor the recording delegate spawns any at construction) could never outlive the suite.
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

// A minimal-but-truthy recording configuration cast to the HAP type at this confined seam - the same harness discipline the sibling suites use. The reconcile path
// reads only videoCodec.resolution (channel selection) and videoCodec.parameters.bitRate (the enable-ack config log).
function makeRecordingConfig(): CameraRecordingConfiguration {

  return { prebufferLength: 4000, videoCodec: { parameters: { bitRate: 2000 }, resolution: [ 1920, 1080, 30 ] } } as unknown as CameraRecordingConfiguration;
}

// A ChannelProfile resolved from a real G2 Pro channel, so the channel's id and fps reach the reconciler exactly as production composes them. We guard the
// indexed access because host.ufp.channels[0] widens to ProtectCameraChannelConfig | undefined under noUncheckedIndexedAccess.
function makeChannelProfile(host: TestCameraHost): ChannelProfile {

  const channel = host.ufp.channels[0];

  if(!channel) {

    throw new Error("The G2 Pro channel fixture is missing its first channel.");
  }

  return { channel, name: channel.name, resolution: [ 1920, 1080, 30 ], url: "rtsps://test" };
}

// The arranged supervisor and its consuming delegate, plus the handles a test asserts against: logEntries captures the narration, host exposes the seam call logs
// and the reachability knob, nvr is the controller double whose settable phase drives the induced-vs-organic deferred/resolution log gating.
interface SupervisorArrange {

  delegate: ProtectRecordingDelegate;
  host: TestCameraHost;
  logEntries: TestLogEntry[];
  nvr: TestProtectNvr;
  supervisor: ProtectTimeshiftSupervisor;
}

// Arrange a supervisor+delegate pair whose success-path seams (stream, channel selector, segment-yielding buffer fill, recording configuration) are wired, but which
// is NOT yet armed and starts with the camera OFFLINE. This lets the deferred/resolution tests own the ordering: enable while offline to open a deferral episode,
// then bring the camera online and reconcile to drive the successful-start resolution. The caller flips host.isReachable and nvr.phase to steer the gating.
function arrangeDeferralDelegate(): SupervisorArrange {

  const { controller, host, logEntries, nvr } = makeTestCameraHost();

  controllers.push(controller);

  host.stream = new TestStreamingDelegate();
  host.selectSubstrateChannel = (): ChannelProfile => makeChannelProfile(host);

  // Over-fill the buffer so that, once the camera is online and the timeshift starts, whenEstablished resolves true on the segment-yielding double and the start
  // succeeds.
  host.livestreamMediaSegments = Math.ceil(PROTECT_TIMESHIFT_BUFFER_MAXDURATION / PROTECT_SEGMENT_RESOLUTION) + 10;

  // Begin offline: enabling recording here opens the deferral episode the reconcile head logs and the resolution later closes.
  host.isReachable = false;

  const supervisor = new ProtectTimeshiftSupervisor(host);
  const delegate = new ProtectRecordingDelegate(host, supervisor);

  delegate.updateRecordingConfiguration(makeRecordingConfig());

  return { delegate, host, logEntries, nvr, supervisor };
}

// Arrange an armed, successfully-started supervisor+delegate pair: seams wired, buffer filled through the segment-yielding double, recording enabled and settled, so
// the enable acknowledgment has fired exactly once by the time the test proceeds.
async function arrangeEnabledDelegate(): Promise<SupervisorArrange> {

  const { controller, host, logEntries, nvr } = makeTestCameraHost();

  controllers.push(controller);

  host.stream = new TestStreamingDelegate();
  host.selectSubstrateChannel = (): ChannelProfile => makeChannelProfile(host);
  host.livestreamMediaSegments = Math.ceil(PROTECT_TIMESHIFT_BUFFER_MAXDURATION / PROTECT_SEGMENT_RESOLUTION) + 10;

  const supervisor = new ProtectTimeshiftSupervisor(host);
  const delegate = new ProtectRecordingDelegate(host, supervisor);

  delegate.updateRecordingConfiguration(makeRecordingConfig());
  delegate.updateRecordingActive(true);

  // Drain the background consume loop up to the iterator's park, so the buffer is fully established before the test proceeds.
  await settle();

  return { delegate, host, logEntries, nvr, supervisor };
}

describe("timeshift supervisor deferred-offline and resolution logging", () => {

  // Deferred while ORGANIC. A camera goes offline (isReachable false) at the running phase while HomeKit asks us to record: the reconcile head logs the deferral at
  // WARN - a genuine "we wanted to record but cannot" signal for a single camera unexpectedly in trouble. We assert BOTH the present level (warn === 1) AND the absent
  // level (debug === 0) so a level flip fails the test.
  test("logs the deferred-offline notice at warn during an organic single-camera offline", async () => {

    const { delegate, logEntries } = arrangeDeferralDelegate();

    // The phase is the default organic "running"; arming while offline opens the deferral episode and the reconcile head logs it.
    delegate.updateRecordingActive(true);
    await settle();

    assert.equal(countLogs(logEntries, "warn", "deferred until the camera is online"), 1, "an organic deferral logs at warn");
    assert.equal(countLogs(logEntries, "debug", "deferred until the camera is online"), 0, "an organic deferral does not log at debug");
  });

  // Deferred while INDUCED. The same offline deferral, but the controller is rebooting because we asked it to: the reconcile head drops the deferral to DEBUG, since the
  // controller-level "rebooting..." narration already covers the disruption. Both-level assertion proves the gate flipped, not merely that one line is present.
  test("quiets the deferred-offline notice to debug during an induced controller reboot", async () => {

    const { delegate, logEntries, nvr } = arrangeDeferralDelegate();

    // Mark the disruption as one we induced before arming, so the deferral edge reads the rebooting phase.
    nvr.phase = "rebooting";

    delegate.updateRecordingActive(true);
    await settle();

    assert.equal(countLogs(logEntries, "debug", "deferred until the camera is online"), 1, "an induced deferral logs at debug");
    assert.equal(countLogs(logEntries, "warn", "deferred until the camera is online"), 0, "an induced deferral does not log at warn");
  });

  // Resolution while ORGANIC. A recording deferred at the running phase, then the camera returns and the timeshift actually starts: the successful-start path announces
  // the resumption at WARN (matching the deferral's organic origin). The start genuinely succeeds because the segment-yielding double resolves whenEstablished true.
  // Both-level assertion: warn === 1, debug === 0.
  test("announces the resumption at warn when an organic deferral re-establishes", async () => {

    const { delegate, host, logEntries } = arrangeDeferralDelegate();

    // Open the organic deferral.
    delegate.updateRecordingActive(true);
    await settle();

    assert.equal(countLogs(logEntries, "warn", "deferred until the camera is online"), 1, "the organic deferral was logged");

    // The camera returns; the reconcile now reaches the successful-start path and announces the resumption.
    host.isReachable = true;

    await delegate.configureTimeshifting();
    await settle();

    assert.equal(countLogs(logEntries, "warn", "has started now that the camera is online"), 1, "an organic resumption announces at warn");
    assert.equal(countLogs(logEntries, "debug", "has started now that the camera is online"), 0, "an organic resumption does not announce at debug");
  });

  // Resolution while INDUCED - the latch-not-phase proof. A recording deferred while the controller was rebooting (captured origin: induced), then the camera returns
  // AFTER the controller is back, so the phase is "running" again at the resolution reconcile. The resumption must announce at DEBUG, driven by the captured
  // wasDeferredWhileInduced latch, NOT by a fresh phase read - a current-phase read at this point would see "running" and wrongly announce at warn, failing this test.
  // This is the decisive case the captured-boolean design exists for.
  test("announces the resumption at debug from the captured induced origin even though the phase is running at resolution", async () => {

    const { delegate, host, logEntries, nvr } = arrangeDeferralDelegate();

    // Open the deferral while the controller is rebooting: the origin is captured as induced.
    nvr.phase = "rebooting";

    delegate.updateRecordingActive(true);
    await settle();

    assert.equal(countLogs(logEntries, "debug", "deferred until the camera is online"), 1, "the induced deferral was logged at debug");

    // The controller has finished rebooting (phase back to running) and the camera is online again. A current-phase read here would classify the recovery as organic; the
    // captured latch must keep it induced.
    nvr.phase = "running";
    host.isReachable = true;

    await delegate.configureTimeshifting();
    await settle();

    assert.equal(countLogs(logEntries, "debug", "has started now that the camera is online"), 1, "the induced resumption announces at debug from the captured origin");
    assert.equal(countLogs(logEntries, "warn", "has started now that the camera is online"), 0, "the induced resumption does not announce at warn (a phase read would)");
  });

  // No resolution when recording cannot actually run. A recording is deferred offline, then the camera becomes reachable BUT the timeshift start fails (the livestream
  // double yields no segments, so whenEstablished resolves false and the buffer's start returns false, taking the early return before the successful-start path). The
  // resumption must NOT be announced - recording did not actually resume - at either level. This pins the decisive correction: the announcement is past the start
  // success, not on the bare reachability edge.
  test("does not announce a resumption when the camera is reachable but the timeshift start fails", async () => {

    const { delegate, host, logEntries } = arrangeDeferralDelegate();

    // Open the deferral.
    delegate.updateRecordingActive(true);
    await settle();

    assert.equal(countLogs(logEntries, "warn", "deferred until the camera is online"), 1, "the deferral was logged");

    // The camera becomes reachable, but starve the buffer so the start fails (whenEstablished resolves false on the segment-less double) - the reconcile takes the
    // start-failure early return and never reaches the successful-start path.
    host.isReachable = true;
    host.livestreamMediaSegments = 0;

    await delegate.configureTimeshifting();
    await settle();

    assert.equal(countLogs(logEntries, "warn", "has started now that the camera is online"), 0, "no resumption is announced at warn when the start fails");
    assert.equal(countLogs(logEntries, "debug", "has started now that the camera is online"), 0, "no resumption is announced at debug when the start fails");
  });

  // #24: the deferred-offline resumption must survive a FAILED first post-online start and still fire on the pass that actually re-establishes. A recording is deferred
  // offline, the camera comes back but the first start fails (segment-less double), then the buffer re-fills and the second start succeeds. The resumption narration is
  // owed by the persistent deferralResolutionPending, not the per-pass edge-detect input, so the earlier failure does not lose it. Pre-fix, the single conflated flag was
  // cleared by the failing pass and the resumption was permanently lost.
  test("the deferred-offline resumption survives a failed first post-online start and fires on the real restart", async () => {

    const { delegate, host, logEntries } = arrangeDeferralDelegate();

    // Open the deferral (offline + recording).
    delegate.updateRecordingActive(true);
    await settle();

    assert.equal(countLogs(logEntries, "warn", "deferred until the camera is online"), 1, "the deferral was logged");

    // The camera becomes reachable, but starve the buffer so the first start fails (whenEstablished resolves false on the segment-less double).
    host.isReachable = true;
    host.livestreamMediaSegments = 0;

    await delegate.configureTimeshifting();
    await settle();

    assert.equal(countLogs(logEntries, "warn", "has started now that the camera is online"), 0, "no resumption is announced while the first start fails");

    // The buffer re-fills and the second start succeeds. The resumption fires on THIS real restart, even though the edge-detect input was cleared by the failing pass.
    host.livestreamMediaSegments = Math.ceil(PROTECT_TIMESHIFT_BUFFER_MAXDURATION / PROTECT_SEGMENT_RESOLUTION) + 10;

    await delegate.configureTimeshifting();
    await settle();

    assert.equal(countLogs(logEntries, "warn", "has started now that the camera is online"), 1, "the resumption fires on the real restart after the earlier failure");
  });

  // Negative control for the demand-disable reset, asserted on the FIELD. A recording is deferred offline (a resolution becomes owed), then disabled. The disable edge
  // must drop the pending-resolution narration so a later start cannot resurrect the disabled episode's resolution. We read the field directly through a test subclass:
  // the log-absence is coincidentally green whether or not the reset ran, because the disable's own reconcile pass clears the edge-detect input regardless.
  test("a demand-disable during a deferral clears the pending-resolution narration field", async () => {

    class InspectableSupervisor extends ProtectTimeshiftSupervisor {

      public get pendingResolution(): boolean {

        return this.deferralResolutionPending;
      }
    }

    const { controller, host } = makeTestCameraHost();

    controllers.push(controller);

    host.stream = new TestStreamingDelegate();
    host.selectSubstrateChannel = (): ChannelProfile => makeChannelProfile(host);
    host.isReachable = false;

    const supervisor = new InspectableSupervisor(host);

    // Open the deferral: recording demanded while the camera is offline.
    await supervisor.setRecordingDemand({ config: makeRecordingConfig(), isRecording: true });
    await settle();

    assert.equal(supervisor.pendingResolution, true, "the deferral opened, so a resolution narration is owed");

    // Disable recording during the deferral. The disable edge must clear the pending-resolution field so the disabled episode owes nothing.
    await supervisor.setRecordingDemand({ config: makeRecordingConfig(), isRecording: false });
    await settle();

    assert.equal(supervisor.pendingResolution, false, "the demand-disable cleared the pending-resolution narration field");
  });
});

describe("timeshift supervisor never-rejecting reconcile", () => {

  // #17/G2-D1: a reconcile pass that throws must be caught at the loop's chokepoint - the reconcile is reached through many fire-and-forget void kicks, so an escaping
  // rejection would float and poison the shared configurePromise every joined caller reads. We arrange a deferral edge (camera offline while recording), whose
  // bookkeeping runs first, then make the buffer's stop throw at the stop point that follows in the same pass. The catch must swallow the throw into a false verdict,
  // log exactly one retry line, and leave the pass's deferral bookkeeping intact - which we prove through the resumption that fires when the camera returns online,
  // since that resumption consults the very deferral field the throwing pass had already updated. Pre-fix, the uncaught throw rejected the awaited reconcile.
  test("a throwing reconcile pass is caught, reports false, logs once, and preserves the deferral bookkeeping", async () => {

    const { host, logEntries, supervisor } = await arrangeEnabledDelegate();

    // Take the camera offline and make the buffer's stop throw. The offline pass opens the deferral (its warn and field update run first), then throws at buffer.stop.
    host.isReachable = false;
    supervisor.buffer.stop = (): boolean => { throw new Error("stop boom"); };

    // Capture any unhandled rejection the throwing pass might float through the reconcile chokepoint.
    const floats: unknown[] = [];
    const onFloat = (reason: unknown): void => { floats.push(reason); };

    process.on("unhandledRejection", onFloat);

    let verdict: boolean;

    try {

      verdict = await supervisor.reconcile();

      await settle();
    } finally {

      process.off("unhandledRejection", onFloat);
    }

    assert.equal(floats.length, 0, "the throwing pass did not float an unhandled rejection through the reconcile chokepoint");
    assert.equal(verdict, false, "the caught failure reported a false verdict, never a stale-truthy success");
    assert.ok(countLogs(logEntries, "warn", "deferred until the camera is online") >= 1, "the deferral bookkeeping ran before the throw - the deferral warn fired");
    assert.equal(countLogs(logEntries, "error", "could not be updated and will be retried"), 1, "the caught failure logged exactly one retry line");

    // The loop survived and the deferral field the throwing pass set is intact: bring the camera back online and a fresh reconcile recovers, firing the resumption that
    // consults that very field.
    host.isReachable = true;

    const recoveredVerdict = await supervisor.reconcile();

    await settle();

    assert.equal(recoveredVerdict, true, "a fresh reconcile after the fault recovers - the loop was not killed");
    assert.ok(countLogs(logEntries, "warn", "has started now that the camera is online") >= 1,
      "the resumption fires on recovery, proving the throwing pass had already updated the deferral bookkeeping before it threw");
  });
});

describe("timeshift supervisor exit-window coalesce", () => {

  // A supervisor that drives a reconcile() request into the exit window exactly once, counting loop exits. The override fires at the loop's exit, before the wrapper
  // promise's .finally clears configurePromise, so the injected reconcile() sees configurePromise still truthy and joins it - setting the request flag with no loop to
  // consume it, the #23 race. Post-fix the .finally re-check starts a fresh loop (a second exit); pre-fix the request is silently dropped (one exit).
  class ExitWindowSupervisor extends ProtectTimeshiftSupervisor {

    public loopExits = 0;
    private injected = false;

    protected override onReconcileLoopExit(): void {

      this.loopExits++;

      if(!this.injected) {

        this.injected = true;
        void this.reconcile();
      }
    }
  }

  // #23: a reconcile request landing in the loop-exit-to-finally-clear microtask window must not be dropped. We inject exactly one such request via the sequencing seam
  // and observe the re-kick's effect by outcome, not timing: a second loop runs (loopExits === 2). The injection itself is the positive control - the request genuinely
  // lands inside the window, since the seam's reconcile() joins a still-truthy configurePromise; pre-fix, the same interleaving runs only one loop.
  test("a reconcile request in the exit window coalesces into a fresh loop", async () => {

    const { controller, host } = makeTestCameraHost();

    controllers.push(controller);

    host.stream = new TestStreamingDelegate();
    host.selectSubstrateChannel = (): ChannelProfile => makeChannelProfile(host);
    host.livestreamMediaSegments = Math.ceil(PROTECT_TIMESHIFT_BUFFER_MAXDURATION / PROTECT_SEGMENT_RESOLUTION) + 10;

    const supervisor = new ExitWindowSupervisor(host);

    // Drive one reconcile; the seam injects a second request into the exit window of this loop.
    await supervisor.reconcile();

    await settle();

    assert.equal(supervisor.loopExits, 2, "the exit-window request coalesced into a fresh loop - a second loop ran");
  });
});

describe("timeshift supervisor narration liveness guard", () => {

  // The consume loop runs detached from the start commit, so a buffer can die in the microtask window between a start settling and the pass narrating. A one-shot
  // onStartSettled override lands the death exactly inside that window: it stops the buffer on the first settled start, then disarms so the follow-up pass the death
  // re-arms can settle rather than re-entering the kill forever. Stopping the buffer synchronously drops isStarted and emits "stopped" (cause "ended"), which the
  // supervisor's own listener re-arms the coalescing loop on; the one-shot flag keeps that re-armed pass from being killed too, so the loop settles instead of spinning.
  class DeathAtSettleSupervisor extends ProtectTimeshiftSupervisor {

    private killedOnce = false;

    protected override onStartSettled(): void {

      if(!this.killedOnce) {

        this.killedOnce = true;
        this.buffer.stop();
      }
    }
  }

  // A start that commits and then dies before the pass narrates must not celebrate a buffer that is already gone. We open a deferral episode (offline while
  // recording) so a resolution is genuinely owed, bring the camera back with exactly one healthy livestream double over a STARVED fallback, and drive the death through
  // the one-shot hook. Phase 1 asserts both narration lines stayed silent through the death and the failed re-establishment - a permissive media-segments arrangement
  // would let the re-armed pass succeed and acknowledge inside the same outer await, so the fallback is starved to keep the retry failing. Phase 2 re-arms a healthy
  // fallback and asserts each line fires exactly once, proving the guard suppressed the phantom without burning the acknowledgment latch or the pending deferral
  // resolution.
  test("suppresses the acknowledgment and deferral resolution for a buffer that dies in the settle window, and both survive for the honest retry", async () => {

    const { controller, host, logEntries } = makeTestCameraHost();

    controllers.push(controller);

    host.stream = new TestStreamingDelegate();
    host.selectSubstrateChannel = (): ChannelProfile => makeChannelProfile(host);

    // Begin offline so the recording demand opens a deferral episode - the resolution a phantom narration would wrongly close.
    host.isReachable = false;

    const supervisor = new DeathAtSettleSupervisor(host);

    // Open the deferral: recording demanded while offline. A resolution is now owed, and the acknowledgment has not fired, since the buffer never started.
    await supervisor.setRecordingDemand({ config: makeRecordingConfig(), isRecording: true });
    await settle();

    assert.equal(countLogs(logEntries, "warn", "deferred until the camera is online"), 1, "the deferral episode opened while offline");

    // Phase 1: the camera returns. The first start succeeds on the one queued double, but the death lands inside the settle window before the pass narrates. The death
    // re-arms a follow-up pass, which falls back to the starved parking double and fails to re-establish, so nothing narrates at all.
    host.isReachable = true;
    host.livestreamMediaSegments = 0;
    host.livestreamSubscriptions.push(makeControllableLivestreamDouble());

    await supervisor.reconcile();
    await settle();

    assert.equal(countLogs(logEntries, "info", "HKSV:"), 0, "the phantom acknowledgment was suppressed for the buffer that died in the window");
    assert.equal(countLogs(logEntries, "warn", "has started now that the camera is online"), 0, "the phantom deferral resolution was suppressed at warn");
    assert.equal(countLogs(logEntries, "debug", "has started now that the camera is online"), 0, "the phantom deferral resolution was suppressed at debug");
    assert.equal(supervisor.buffer.isStarted, false, "the starved follow-up pass could not re-establish, so the buffer is stopped");

    // Phase 2: a healthy fallback re-arms. The honest retry re-establishes, and both suppressed lines fire exactly once - the acknowledgment latch and the pending
    // deferral resolution both survived the phantom.
    host.livestreamMediaSegments = Math.ceil(PROTECT_TIMESHIFT_BUFFER_MAXDURATION / PROTECT_SEGMENT_RESOLUTION) + 10;

    await supervisor.reconcile();
    await settle();

    assert.equal(countLogs(logEntries, "info", "HKSV:"), 1, "the acknowledgment latch survived the phantom and fires once on the honest retry");
    assert.equal(countLogs(logEntries, "warn", "has started now that the camera is online"), 1, "the deferral resolution survived and fires once on the honest retry");
    assert.equal(supervisor.buffer.isStarted, true, "the honest retry re-established the buffer");
  });
});

describe("timeshift supervisor enable-acknowledgment lifecycle", () => {

  // The "HKSV: ..." config summary fires once per enable EPISODE (not once per delegate lifetime, and not once per reconcile): exactly once on the first successful
  // configure of an episode, again on a true re-enable after a disable, never on a redundant within-episode reconcile. This pins both halves of the acknowledgment
  // lifecycle - the trigger on the reconcile's successful-start path (so the trigger is the configuration event) and the reset on the disable demand edge (so the next
  // enable re-acknowledges). We count occurrences rather than a boolean .some(): the boolean would pass after the FIRST enable regardless of whether the second
  // re-acknowledged, so it cannot discriminate a set-once-never-cleared flag that logs only the first enable.
  test("acknowledges the recording configuration on each enable episode, not within an episode and not only the first", async () => {

    const { delegate, logEntries } = await arrangeEnabledDelegate();

    // The arrange already armed recording once (updateRecordingActive(true) reached the reconcile's successful-start path), so the first enable acknowledged exactly
    // once - the relocation is behavior-preserving for the first enable.
    assert.equal(countLogs(logEntries, "info", "HKSV:"), 1, "the first enable acknowledged the configuration exactly once");

    // A redundant reconcile WHILE STILL ENABLED (no disable) must NOT re-acknowledge: the timeshift is already running on the desired channel, so the reconcile reaches
    // the shared acknowledgment gate with the flag already set and does not re-acknowledge. This is what proves "once per episode" rather than "once per reconcile".
    await delegate.configureTimeshifting();
    await settle();

    assert.equal(countLogs(logEntries, "info", "HKSV:"), 1, "a redundant reconcile within the same enable episode did not re-acknowledge");

    // Disable ends the episode: the "Disabling..." transition log fires and the acknowledgment flag is reset.
    delegate.updateRecordingActive(false);

    assert.ok(countLogs(logEntries, "info", "Disabling HomeKit Secure Video event recording.") >= 1, "the disable logged its transition");

    // Re-enable starts a fresh episode: the reconcile re-establishes the buffer (the segment-yielding double re-yields on the second start) and reaches the
    // successful-start path again, so the acknowledgment fires a SECOND time. countLogs === 2 is false against the un-reset flag (which would log only the first enable,
    // leaving the count at 1) and true after the reset - the discriminating assertion.
    delegate.updateRecordingActive(true);
    await settle();

    assert.equal(countLogs(logEntries, "info", "HKSV:"), 2, "the re-enable re-acknowledged the configuration, so the ack fired on each enable");
  });
});

describe("timeshift supervisor demand-edge episode resets", () => {

  // The per-episode resets live on the demand setter's disable edge, never inside a reconcile pass, so they land synchronously with the demand write even when the
  // flap's reconcile passes coalesce into a single loop. The flap must re-acknowledge exactly once: the disable edge closes the old enable episode (resetting the
  // acknowledgment flag) before any pass processes it, and the enable's successful restart opens - and acknowledges - exactly one new episode.
  test("a coalesced disable-then-enable flap re-acknowledges exactly once", async () => {

    const { logEntries, supervisor } = await arrangeEnabledDelegate();

    assert.equal(countLogs(logEntries, "info", "HKSV:"), 1, "the initial enable acknowledged once");

    const config = makeRecordingConfig();

    // Fire the flap back-to-back in one synchronous frame: the enable lands while the disable's reconcile loop is still in flight and coalesces into it.
    void supervisor.setRecordingDemand({ config, isRecording: false });
    void supervisor.setRecordingDemand({ config, isRecording: true });

    await settle();

    // Exactly one more acknowledgment: the flap closed the old episode on the disable edge and re-acknowledged once on the enable's successful restart.
    assert.equal(countLogs(logEntries, "info", "HKSV:"), 2, "the flap re-acknowledged exactly once");
    assert.equal(supervisor.buffer.isStarted, true, "the flap settled with the buffer running");
  });
});

describe("timeshift supervisor shutdown latch", () => {

  // Shutdown is the terminal teardown: it must stop the buffer synchronously, produce no narration of its own, and latch the supervisor so a post-shutdown reconcile
  // settles on stopped rather than restarting the buffer. The reconcile still runs - the pushed demand is unchanged and still wants recording - but the latch gates
  // the desired state to stopped, so the pass reports unmet prerequisites and never touches the livestream seam again.
  test("shutdown stops the buffer synchronously, logs nothing, and post-shutdown reconciles settle on stopped", async () => {

    const { host, logEntries, supervisor } = await arrangeEnabledDelegate();

    assert.equal(supervisor.buffer.isStarted, true, "the arrange left the buffer running");
    assert.equal(host.livestreamCalls.length, 1, "the arrange opened exactly one livestream");

    const logCountBeforeShutdown = logEntries.length;

    supervisor.shutdown();

    // The stop is synchronous and silent.
    assert.equal(supervisor.buffer.isStarted, false, "shutdown stopped the buffer synchronously");
    assert.equal(logEntries.length, logCountBeforeShutdown, "shutdown produced no narration");

    // A post-shutdown reconcile settles on stopped: recording is still demanded, so the pass reports unmet prerequisites (false), no restart happens, and the
    // livestream seam is never called again.
    assert.equal(await supervisor.reconcile(), false, "a post-shutdown reconcile reports the demand cannot be met");
    await settle();

    assert.equal(supervisor.buffer.isStarted, false, "the buffer stayed stopped through the post-shutdown reconcile");
    assert.equal(host.livestreamCalls.length, 1, "no restart reached the livestream seam");
    assert.equal(logEntries.length, logCountBeforeShutdown, "the post-shutdown reconcile produced no narration");
  });

  // The latch is per-instance by construction: tearing one supervisor down says nothing about a fresh one, which the streaming-delegate rebuild path constructs. A
  // fresh supervisor on the same host starts its buffer normally.
  test("a fresh supervisor instance on the same host is unlatched", async () => {

    const { host, supervisor } = await arrangeEnabledDelegate();

    supervisor.shutdown();

    assert.equal(supervisor.buffer.isStarted, false, "the first supervisor is shut down");

    const fresh = new ProtectTimeshiftSupervisor(host);

    assert.equal(await fresh.setRecordingDemand({ config: makeRecordingConfig(), isRecording: true }), true, "the fresh supervisor reconciles to running");
    await settle();

    assert.equal(fresh.buffer.isStarted, true, "the fresh supervisor's buffer is running");
  });
});

describe("timeshift supervisor buffer channel-profile lifecycle", () => {

  // A start whose establishment fails must never commit a channel profile: the buffer disposes the failed subscription and keeps reporting the matched
  // (isStarted false, channelProfile null) pair.
  test("remains null after a start whose establishment fails", async () => {

    const { controller, host } = makeTestCameraHost();

    controllers.push(controller);

    const supervisor = new ProtectTimeshiftSupervisor(host);

    // Hand the buffer a subscription whose establishment resolves false, so start() takes its validation-failure path.
    host.livestreamSubscriptions.push(makeControllableLivestreamDouble({ whenEstablished: false }));

    assert.equal(await supervisor.buffer.start(makeChannelProfile(host)), false, "the start failed");
    assert.equal(supervisor.buffer.isStarted, false, "the buffer is not running");
    assert.equal(supervisor.buffer.channelProfile, null, "no profile was committed for the failed start");
  });

  // A successful start commits the exact profile it started on, in the same synchronous frame the subscription commits - the matched (isStarted, channelProfile) pair.
  test("commits the backing profile with the subscription on a successful start", async () => {

    const { controller, host } = makeTestCameraHost();

    controllers.push(controller);

    const supervisor = new ProtectTimeshiftSupervisor(host);
    const profile = makeChannelProfile(host);

    host.livestreamSubscriptions.push(makeControllableLivestreamDouble());

    assert.equal(await supervisor.buffer.start(profile), true, "the start succeeded");
    assert.equal(supervisor.buffer.isStarted, true, "the buffer is running");
    assert.equal(supervisor.buffer.channelProfile, profile, "the committed profile is the one the buffer started on");
  });

  // An out-of-band subscription death (no explicit stop) must clear the profile too, and must clear it BEFORE the terminated emit, so a listener reacting to the
  // emit already observes the cleared matched pair.
  test("clears the profile on out-of-band subscription death, before the terminated emit", async () => {

    const { controller, host } = makeTestCameraHost();

    controllers.push(controller);

    const supervisor = new ProtectTimeshiftSupervisor(host);
    const double = makeControllableLivestreamDouble();

    host.livestreamSubscriptions.push(double);

    assert.equal(await supervisor.buffer.start(makeChannelProfile(host)), true, "the start succeeded");

    // Transmit so the out-of-band death fires the terminated emit, and capture exactly what a listener observes at emit time. transmitStart returns the blob fragment
    // count (zero here - the buffer holds no fragments yet); a non-null return means transmission began.
    assert.notEqual(supervisor.buffer.transmitStart(), null, "transmission began");

    const observedAtEmit: { channelProfile: unknown; isStarted: boolean }[] = [];

    supervisor.buffer.on("terminated", () => observedAtEmit.push({ channelProfile: supervisor.buffer.channelProfile, isStarted: supervisor.buffer.isStarted }));

    // End the subscription out-of-band: the iterator returns, the consume loop's finally self-cleans through finalizeSubscription, and the terminated emit fires.
    double.end();
    await settle();

    assert.equal(observedAtEmit.length, 1, "the terminated emit fired exactly once");
    assert.equal(observedAtEmit[0]?.channelProfile, null, "the listener observed the profile already cleared at emit time");
    assert.equal(observedAtEmit[0]?.isStarted, false, "the listener observed the buffer already stopped at emit time");
    assert.equal(supervisor.buffer.channelProfile, null, "the profile stays cleared after the death");
  });
});

describe("timeshift supervisor forwarder identity", () => {

  // The delegate's configureTimeshifting is a synchronous join onto the supervisor's reconciler - it must return the supervisor's own in-flight promise, not a
  // wrapper around it. Promise identity is the whole proof: identical objects mean joining callers share one reconcile loop with no added microtask boundary, so the
  // check-and-set atomicity the reconciler relies on is preserved through the forwarder and a second loop can never start.
  test("configureTimeshifting returns the supervisor's in-flight reconcile promise", async () => {

    const { controller, host } = makeTestCameraHost();

    controllers.push(controller);

    const supervisor = new ProtectTimeshiftSupervisor(host);
    const delegate = new ProtectRecordingDelegate(host, supervisor);

    // Start a reconcile, then join through the forwarder in the same synchronous frame: both callers must hold the identical promise object.
    const direct = supervisor.reconcile();
    const forwarded = delegate.configureTimeshifting();

    assert.equal(forwarded, direct, "the forwarder returned the supervisor's own in-flight promise");
    assert.equal(await forwarded, await direct, "both callers observe the same settlement");

    // Once the in-flight loop settles, a fresh forwarded call starts a NEW reconcile rather than handing back the settled promise.
    const fresh = delegate.configureTimeshifting();

    assert.notEqual(fresh, direct, "a post-settlement call starts a fresh reconcile");
    await fresh;
  });
});

// Arrange a streaming-arm-capable supervisor: buffer-backed livestreaming is on and the success-path seams are wired (the buffer fills through the segment-yielding
// double), but HomeKit recording is never armed. The streaming demand arm alone drives the buffer here.
function arrangeStreamingHost(): { host: TestCameraHost; logEntries: TestLogEntry[]; supervisor: ProtectTimeshiftSupervisor } {

  const { controller, host, logEntries } = makeTestCameraHost();

  controllers.push(controller);

  host.stream = new TestStreamingDelegate();
  host.selectSubstrateChannel = (): ChannelProfile => makeChannelProfile(host);
  host.livestreamMediaSegments = Math.ceil(PROTECT_TIMESHIFT_BUFFER_MAXDURATION / PROTECT_SEGMENT_RESOLUTION) + 10;
  host.usesTimeshiftLivestream = true;

  const supervisor = new ProtectTimeshiftSupervisor(host);

  return { host, logEntries, supervisor };
}

describe("timeshift supervisor streaming arm", () => {

  // The streaming demand arm alone runs the buffer: with buffer-backed livestreaming on and no recording, a reconcile starts the standing buffer, narrates its lifecycle
  // at DEBUG, and emits no HKSV acknowledgment - that line belongs to the recording arm.
  test("a streaming-only start runs the buffer, narrates at debug, and does not acknowledge HKSV", async () => {

    const { logEntries, supervisor } = arrangeStreamingHost();

    assert.equal(await supervisor.reconcile(), true, "the streaming arm reconciled to running");
    await settle();

    assert.equal(supervisor.buffer.isStarted, true, "the streaming arm started the standing buffer");
    assert.equal(countLogs(logEntries, "debug", "Timeshift buffer started for livestreaming."), 1, "a streaming-only start narrates at debug");
    assert.equal(countLogs(logEntries, "info", "HKSV:"), 0, "a streaming-only start emits no HKSV acknowledgment");
  });

  // A streaming-only camera going offline is already covered by the controller/camera narration, so its deferral is silent: the deferral block stays gated on the
  // recording request, so a streaming-only offline reconcile emits nothing at warn or debug about a deferral.
  test("a streaming-only camera going offline defers silently", async () => {

    const { host, logEntries, supervisor } = arrangeStreamingHost();

    host.isReachable = false;

    assert.equal(await supervisor.reconcile(), true, "the offline reconcile reports the streaming-only demand as satisfiable-when-stopped");
    await settle();

    assert.equal(supervisor.buffer.isStarted, false, "the offline camera did not start the buffer");
    assert.equal(countLogs(logEntries, "warn", "deferred until the camera is online"), 0, "a streaming-only offline does not defer at warn");
    assert.equal(countLogs(logEntries, "debug", "deferred until the camera is online"), 0, "a streaming-only offline does not defer at debug");
  });

  // The standing-buffer common case: the streaming arm has the buffer already running when the recording arm enables. The acknowledgment must still fire exactly once,
  // now on the already-running path rather than a fresh start - the restructure's whole point.
  test("an already-running streaming buffer acknowledges HKSV exactly once when recording enables", async () => {

    const { logEntries, supervisor } = arrangeStreamingHost();

    await supervisor.reconcile();
    await settle();

    assert.equal(supervisor.buffer.isStarted, true, "the streaming arm left the buffer running");
    assert.equal(countLogs(logEntries, "info", "HKSV:"), 0, "no acknowledgment before recording enables");

    // Enable recording against the already-running buffer: the reconcile finds it already on the desired channel and acknowledges on the shared path.
    assert.equal(await supervisor.setRecordingDemand({ config: makeRecordingConfig(), isRecording: true }), true, "the recording arm reconciled to running");
    await settle();

    assert.equal(countLogs(logEntries, "info", "HKSV:"), 1, "the enable acknowledged exactly once on the already-running path");
  });
});

// Arrange an armed, running supervisor whose buffer runs on the FIRST of two queued controllable livestream doubles, so a test can end the first out-of-band and observe
// whether the supervisor re-establishes onto the second.
async function arrangeControllableRecording(): Promise<{ doubles: ControllableLivestreamDouble[]; host: TestCameraHost; supervisor: ProtectTimeshiftSupervisor }> {

  const { controller, host } = makeTestCameraHost();

  controllers.push(controller);

  host.selectSubstrateChannel = (): ChannelProfile => makeChannelProfile(host);

  const doubles = [ makeControllableLivestreamDouble(), makeControllableLivestreamDouble() ];

  host.livestreamSubscriptions.push(...doubles);

  const supervisor = new ProtectTimeshiftSupervisor(host);
  const delegate = new ProtectRecordingDelegate(host, supervisor);

  delegate.updateRecordingConfiguration(makeRecordingConfig());
  delegate.updateRecordingActive(true);
  await settle();

  return { doubles, host, supervisor };
}

describe("timeshift supervisor cause-tagged re-arm", () => {

  // A recoverable out-of-band death ("ended") re-establishes the buffer immediately, without waiting for the availability edge. The graceful end of the first
  // subscription fires the buffer's stopped("ended"), which the supervisor's subscription reconciles - re-establishing onto the second double.
  test("an ended out-of-band death re-establishes the buffer immediately", async () => {

    const { doubles, host, supervisor } = await arrangeControllableRecording();

    assert.equal(supervisor.buffer.isStarted, true, "the arrange left the buffer running on the first subscription");
    assert.equal(host.livestreamCalls.length, 1, "exactly one livestream opened for the initial start");

    // End the first subscription gracefully: the buffer emits stopped("ended") and the supervisor re-establishes onto the second double.
    doubles[0]?.end();
    await settle();

    assert.equal(supervisor.buffer.isStarted, true, "the ended death re-established the buffer immediately");
    assert.equal(host.livestreamCalls.length, 2, "the re-establish opened the second livestream");
  });

  // A recovery give-up ("giveUp") does NOT re-arm - the availability edge and self-heal's reboot bounce own that path, so re-arming here would fight a tight loop. The
  // first subscription throwing the give-up leaves the buffer down even though a second subscription is queued and ready.
  test("a giveUp out-of-band death does not re-arm", async () => {

    const { doubles, host, supervisor } = await arrangeControllableRecording();

    assert.equal(supervisor.buffer.isStarted, true, "the arrange left the buffer running");

    // The first subscription exhausts recovery and gives up: the buffer emits stopped("giveUp") and the supervisor leaves revival to the availability edge.
    doubles[0]?.throwError(new ProtectLivestreamUnavailableError("the livestream gave up", { attempts: 10, phase: "recovering" }));
    await settle();

    assert.equal(supervisor.buffer.isStarted, false, "the give-up left the buffer down");
    assert.equal(host.livestreamCalls.length, 1, "no re-establish reached the livestream seam - the queued second subscription was untouched");
  });
});

describe("timeshift supervisor selection failure", () => {

  // When no valid stream profile resolves, the reconcile reports the failure once per episode. Under the streaming arm the reconcile is kicked frequently, so the latch
  // suppresses repeats across kicks; a pushed demand change re-arms the report so the user hears about a still-failing selection once more.
  test("reports the no-valid-profile failure once per episode and re-arms on a demand change", async () => {

    const { controller, host, logEntries } = makeTestCameraHost();

    controllers.push(controller);

    // The default selectSubstrateChannel returns null, so selection fails. Arm the streaming arm so shouldRun is true and the reconcile reaches the selection.
    host.usesTimeshiftLivestream = true;

    const supervisor = new ProtectTimeshiftSupervisor(host);

    await supervisor.reconcile();
    await settle();

    assert.equal(countLogs(logEntries, "error", "no valid video stream profile was found"), 1, "the selection failure reported once");

    // A repeat kick with the failure unresolved must not re-report - the once-per-episode latch holds.
    await supervisor.reconcile();
    await settle();

    assert.equal(countLogs(logEntries, "error", "no valid video stream profile was found"), 1, "a repeat kick did not re-report the still-unresolved failure");

    // A pushed demand change re-arms the report.
    await supervisor.setRecordingDemand({ config: makeRecordingConfig(), isRecording: true });
    await settle();

    assert.equal(countLogs(logEntries, "error", "no valid video stream profile was found"), 2, "a demand change re-armed the report");
  });
});
