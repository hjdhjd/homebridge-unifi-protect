/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * timeshift-supervisor.test.ts: Behavior coverage of the timeshift buffer supervisor - the reconciler's lifecycle authority over the standing buffer.
 *
 * The supervisor owns the reconcile passes, the pushed recording demand, the per-episode narration state, and the lifetime signal shutdown aborts; the recording
 * delegate consumes it through the configureTimeshifting forwarder and the setRecordingDemand pushes. This suite covers that surface from both directions: through the
 * delegate's public interface (the deferred-offline and resolution narration, and the enable-acknowledgment lifecycle - reconcile-only behaviors that never touch the
 * transmit path, so no recording-process factory is involved) and through the supervisor directly (the demand-edge episode resets, the lifetime's end at shutdown,
 * the buffer's channel-profile lifecycle, and the forwarder's promise-identity join semantics).
 *
 * The arrangement reuses the harness's camera-host double end to end: the segment-yielding parking livestream double fills the buffer so starts genuinely succeed,
 * the controllable livestream double drives the channel-profile lifecycle's failure and out-of-band-death arms, and the recorded log sink carries the narration
 * assertions. The assertions are behavior-first throughout: captured log lines, public buffer state, recorded call counts, and promise identity - never a private field.
 */
import type { ControllableLivestreamDouble, TestCameraHost } from "./testing.helpers.ts";
import { PROTECT_NVR_REBOOT_RECENCY_MS, PROTECT_SEGMENT_RESOLUTION, PROTECT_TIMESHIFT_BUFFER_MAXDURATION } from "../settings.ts";
import { TestStreamingDelegate, makeRecordingDelegateDouble } from "../testing.helpers.ts";
import { after, describe, test } from "node:test";
import { formatLogEntry, logCount, settle } from "homebridge-plugin-utils/testing";
import { makeChannelProfile, makeControllableLivestreamDouble, makeTestCameraHost } from "./testing.helpers.ts";
import type { CameraRecordingConfiguration } from "homebridge";
import type { ChannelProfile } from "./resolution.ts";
import type { LivestreamAudioFormat } from "./stream-delegate.ts";
import type { LivestreamDescription } from "unifi-protect";
import { ProtectLivestreamUnavailableError } from "unifi-protect";
import { ProtectRecordingDelegate } from "./record.ts";
import { ProtectTimeshiftSupervisor } from "./timeshift-supervisor.ts";
import { RECORDING_AUDIO_STAND_IN } from "./stream-delegate.ts";
import type { TestLogEntry } from "homebridge-plugin-utils/testing";
import type { TestProtectNvr } from "../nvr/testing.helpers.ts";
import assert from "node:assert/strict";

// Every host this suite builds shares the one makeTestNvr AbortController. Aborting them in teardown releases the harness signals so any leaked observer (none here -
// neither the supervisor nor the recording delegate spawns any at construction) could never outlive the suite.
const controllers: AbortController[] = [];

after(() => {

  for(const controller of controllers) {

    controller.abort();
  }
});

// A minimal-but-truthy recording configuration cast to the HAP type at this single boundary - the same harness discipline the sibling suites use. The reconcile path
// reads only videoCodec.resolution (channel selection) and videoCodec.parameters.bitRate (the enable-ack config log).
function makeRecordingConfig(): CameraRecordingConfiguration {

  return { prebufferLength: 4000, videoCodec: { parameters: { bitRate: 2000 }, resolution: [ 1920, 1080, 30 ] } } as unknown as CameraRecordingConfiguration;
}

// The arranged supervisor and its consuming delegate, plus the handles a test asserts against: logEntries captures the narration, host exposes the recorded call logs
// and the reachability knob, nvr is the controller double whose settable phase and observed-reboot timestamp together drive the expected-vs-organic deferred/resolution
// log gating.
interface SupervisorArrange {

  delegate: ProtectRecordingDelegate;
  host: TestCameraHost;
  logEntries: readonly TestLogEntry[];
  nvr: TestProtectNvr;
  supervisor: ProtectTimeshiftSupervisor;
}

// Arrange a supervisor+delegate pair whose success-path dependencies (stream, channel selector, segment-yielding buffer fill, recording configuration) are wired, but
// which is NOT yet armed and starts with the camera OFFLINE. This lets the deferred/resolution tests own the ordering: enable while offline to open a deferral episode,
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

// Arrange an armed, successfully-started supervisor+delegate pair: the success-path dependencies wired, buffer filled through the segment-yielding double,
// recording enabled and settled, so the enable acknowledgment has fired exactly once by the time the test proceeds.
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

  // The shared inspection subclass the demand-disable arms read the episode through: it surfaces the supervisor's protected "a resolution is owed" projection, which is
  // the only observable that tells a ran-reset from a skipped one. The absence of a resolution line is coincidentally green either way, because the disable's own
  // reconcile pass clears the edge-detect input regardless.
  class InspectableSupervisor extends ProtectTimeshiftSupervisor {

    public get pendingResolution(): boolean {

      return this.deferralResolutionOwed;
    }
  }

  // Deferred while ORGANIC. A camera goes offline (isReachable false) at the running phase while HomeKit asks us to record: the reconcile head logs the deferral at
  // WARN - a genuine "we wanted to record but cannot" signal for a single camera unexpectedly in trouble. We assert BOTH the present level (warn === 1) AND the absent
  // level (debug === 0) so a level flip fails the test.
  test("logs the deferred-offline notice at warn during an organic single-camera offline", async () => {

    const { delegate, logEntries } = arrangeDeferralDelegate();

    // The phase is the default organic "running"; arming while offline opens the deferral episode and the reconcile head logs it.
    delegate.updateRecordingActive(true);
    await settle();

    assert.equal(logCount(logEntries, "warn", "deferred until the camera is online"), 1, "an organic deferral logs at warn");
    assert.equal(logCount(logEntries, "debug", "deferred until the camera is online"), 0, "an organic deferral does not log at debug");
  });

  // Deferred while EXPECTED, through the induced half. The same offline deferral, but the controller is rebooting because we asked it to: the reconcile head drops the
  // deferral to DEBUG, since the controller-level "rebooting..." narration already covers the disruption. Both-level assertion proves the gate flipped, not merely that
  // one line is present.
  test("quiets the deferred-offline notice to debug during an induced controller reboot", async () => {

    const { delegate, logEntries, nvr } = arrangeDeferralDelegate();

    // Mark the disruption as one we induced before arming, so the deferral edge reads the rebooting phase.
    nvr.phase = "rebooting";

    delegate.updateRecordingActive(true);
    await settle();

    assert.equal(logCount(logEntries, "debug", "deferred until the camera is online"), 1, "an expected deferral logs at debug");
    assert.equal(logCount(logEntries, "warn", "deferred until the camera is online"), 0, "an expected deferral does not log at warn");
  });

  // Deferred while EXPECTED, through the settling-tail half - the reclassification this classification exists for. The controller has already finished rebooting and
  // returned to running, so the phase alone reads organic, yet the plugin observed that reboot moments ago and every camera blips as it re-establishes. The disruption
  // belongs to the reboot rather than to this camera, so the deferral is expected and drops to DEBUG.
  test("quiets the deferred-offline notice to debug inside the settling tail of an observed reboot", async () => {

    const { delegate, logEntries, nvr } = arrangeDeferralDelegate();

    // The phase is the default "running", so only the freshly-observed reboot can classify this disruption as expected.
    nvr.lastRebootObservedAt = nvr.platform.clock.now();

    delegate.updateRecordingActive(true);
    await settle();

    assert.equal(logCount(logEntries, "debug", "deferred until the camera is online"), 1, "a deferral inside the reboot's settling tail logs at debug");
    assert.equal(logCount(logEntries, "warn", "deferred until the camera is online"), 0, "a deferral inside the reboot's settling tail does not log at warn");
  });

  // The settling tail's far edge. The same running-phase deferral, but the observed reboot is older than the window, so the tail does not explain this camera and the
  // deferral is organic at WARN. Paired with the arm above, this holds the tail to a window rather than a permanent quieting of everything that follows a reboot.
  test("logs the deferred-offline notice at warn once an observed reboot's settling tail has elapsed", async () => {

    const { delegate, logEntries, nvr } = arrangeDeferralDelegate();

    // A reboot observed longer ago than the window puts this deferral comfortably outside the tail.
    nvr.lastRebootObservedAt = nvr.platform.clock.now() - PROTECT_NVR_REBOOT_RECENCY_MS - 5000;

    delegate.updateRecordingActive(true);
    await settle();

    assert.equal(logCount(logEntries, "warn", "deferred until the camera is online"), 1, "a deferral past the reboot's settling tail logs at warn");
    assert.equal(logCount(logEntries, "debug", "deferred until the camera is online"), 0, "a deferral past the reboot's settling tail does not log at debug");
  });

  // Resolution while ORGANIC. A recording deferred at the running phase, then the camera returns and the timeshift actually starts: the successful-start path announces
  // the resumption at WARN (matching the deferral's organic origin). The start genuinely succeeds because the segment-yielding double resolves whenEstablished true.
  // Both-level assertion: warn === 1, debug === 0.
  test("announces the resumption at warn when an organic deferral re-establishes", async () => {

    const { delegate, host, logEntries } = arrangeDeferralDelegate();

    // Open the organic deferral.
    delegate.updateRecordingActive(true);
    await settle();

    assert.equal(logCount(logEntries, "warn", "deferred until the camera is online"), 1, "the organic deferral was logged");

    // The camera returns; the reconcile now reaches the successful-start path and announces the resumption.
    host.isReachable = true;

    await delegate.configureTimeshifting();
    await settle();

    assert.equal(logCount(logEntries, "warn", "has started now that the camera is online"), 1, "an organic resumption announces at warn");
    assert.equal(logCount(logEntries, "debug", "has started now that the camera is online"), 0, "an organic resumption does not announce at debug");
  });

  // Resolution while EXPECTED - the latch-not-phase proof. A recording deferred while the controller was rebooting (captured origin: expected), then the camera returns
  // AFTER the controller is back, so the phase is "running" again at the resolution reconcile. The resumption must announce at DEBUG, driven by the captured
  // origin the episode captured, NOT by a fresh classification read - a current read at this point would find a running controller with no reboot observed and wrongly
  // announce at warn, failing this test. This is the decisive case capturing the origin at the open edge exists for.
  test("announces the resumption at debug from the captured expected origin even though the phase is running at resolution", async () => {

    const { delegate, host, logEntries, nvr } = arrangeDeferralDelegate();

    // Open the deferral while the controller is rebooting: the origin is captured as expected.
    nvr.phase = "rebooting";

    delegate.updateRecordingActive(true);
    await settle();

    assert.equal(logCount(logEntries, "debug", "deferred until the camera is online"), 1, "the expected deferral was logged at debug");

    // The controller has finished rebooting (phase back to running) and the camera is online again. A fresh classification read here would call the recovery organic;
    // the captured latch must keep it expected.
    nvr.phase = "running";
    host.isReachable = true;

    await delegate.configureTimeshifting();
    await settle();

    assert.equal(logCount(logEntries, "debug", "has started now that the camera is online"), 1, "the expected resumption announces at debug from the captured origin");
    assert.equal(logCount(logEntries, "warn", "has started now that the camera is online"), 0,
      "the expected resumption does not announce at warn (a fresh classification read would)");
  });

  // No resolution when recording cannot actually run. A recording is deferred offline, then the camera becomes reachable BUT the timeshift start fails (the livestream
  // double yields no segments, so whenEstablished resolves false and the buffer's start returns false, taking the early return before the successful-start path). The
  // resumption must NOT be announced - recording did not actually resume - at either level. This holds the announcement past the start success rather than on the
  // bare reachability edge.
  test("does not announce a resumption when the camera is reachable but the timeshift start fails", async () => {

    const { delegate, host, logEntries } = arrangeDeferralDelegate();

    // Open the deferral.
    delegate.updateRecordingActive(true);
    await settle();

    assert.equal(logCount(logEntries, "warn", "deferred until the camera is online"), 1, "the deferral was logged");

    // The camera becomes reachable, but starve the buffer so the start fails (whenEstablished resolves false on the segment-less double) - the reconcile takes the
    // start-failure early return and never reaches the successful-start path.
    host.isReachable = true;
    host.livestreamMediaSegments = 0;

    await delegate.configureTimeshifting();
    await settle();

    assert.equal(logCount(logEntries, "warn", "has started now that the camera is online"), 0, "no resumption is announced at warn when the start fails");
    assert.equal(logCount(logEntries, "debug", "has started now that the camera is online"), 0, "no resumption is announced at debug when the start fails");
  });

  // The deferred-offline resumption must survive a FAILED first post-online start and still fire on the pass that actually re-establishes. A recording is deferred
  // offline, the camera comes back but the first start fails (segment-less double), then the buffer re-fills and the second start succeeds. The resumption narration is
  // owed by the persistent episode value, not the per-pass edge-detect input, so the earlier failure does not lose it. The failure this test exists to catch: a single
  // flag serving both roles is cleared by the failing pass, and the resumption is lost for good.
  test("the deferred-offline resumption survives a failed first post-online start and fires on the real restart", async () => {

    const { delegate, host, logEntries } = arrangeDeferralDelegate();

    // Open the deferral (offline + recording).
    delegate.updateRecordingActive(true);
    await settle();

    assert.equal(logCount(logEntries, "warn", "deferred until the camera is online"), 1, "the deferral was logged");

    // The camera becomes reachable, but starve the buffer so the first start fails (whenEstablished resolves false on the segment-less double).
    host.isReachable = true;
    host.livestreamMediaSegments = 0;

    await delegate.configureTimeshifting();
    await settle();

    assert.equal(logCount(logEntries, "warn", "has started now that the camera is online"), 0, "no resumption is announced while the first start fails");

    // The buffer re-fills and the second start succeeds. The resumption fires on THIS real restart, even though the edge-detect input was cleared by the failing pass.
    host.livestreamMediaSegments = Math.ceil(PROTECT_TIMESHIFT_BUFFER_MAXDURATION / PROTECT_SEGMENT_RESOLUTION) + 10;

    await delegate.configureTimeshifting();
    await settle();

    assert.equal(logCount(logEntries, "warn", "has started now that the camera is online"), 1, "the resumption fires on the real restart after the earlier failure");
  });

  // Classification stability across a CONTINUOUS offline. The origin is captured once, at the open edge, and a phase change while the camera stays offline never
  // re-opens the episode: no second deferral line, and - the arm that actually tells the two apart - the eventual resolution still announces at the ORIGINAL level. A
  // mid-episode reclassification would leave the episode reading expected and quietly move the resolution to debug, even if it never logged a line of its own.
  test("a phase change during a continuous offline neither re-logs the deferral nor moves the resolution's level", async () => {

    const { delegate, host, logEntries, nvr } = arrangeDeferralDelegate();

    // Open the episode organically: offline at the running phase.
    delegate.updateRecordingActive(true);
    await settle();

    assert.equal(logCount(logEntries, "warn", "deferred until the camera is online"), 1, "the organic deferral opened at warn");

    // The controller starts an induced reboot while the camera is STILL offline. The camera never came back, so no open edge fires and the episode keeps its origin.
    nvr.phase = "rebooting";

    await delegate.configureTimeshifting();
    await settle();

    assert.equal(logCount(logEntries, "warn", "deferred until the camera is online"), 1, "the continuous offline did not re-log the deferral at warn");
    assert.equal(logCount(logEntries, "debug", "deferred until the camera is online"), 0, "the continuous offline did not re-log the deferral at debug");

    // The controller finishes rebooting and the camera returns, so the buffer starts and the resolution narrates against the origin captured at the open edge.
    nvr.phase = "running";
    host.isReachable = true;

    await delegate.configureTimeshifting();
    await settle();

    assert.equal(logCount(logEntries, "warn", "has started now that the camera is online"), 1, "the resolution kept the origin the episode opened with");
    assert.equal(logCount(logEntries, "debug", "has started now that the camera is online"), 0, "no mid-episode reclassification moved the resolution to debug");
  });

  // A flicker RE-OPENS the episode, and the last classification wins. The camera comes back but the start fails, clearing the edge-detect input without resolving
  // anything; the camera then drops again under an induced reboot, so the open edge fires afresh, logs a second deferral line at the new level, and overwrites the
  // captured origin. The resolution that finally lands narrates at that last-captured level, exactly once - and a further kick after it narrates nothing at all.
  test("a flicker re-opens the deferral at the new classification and resolves once at the last captured origin", async () => {

    const { delegate, host, logEntries, nvr } = arrangeDeferralDelegate();

    // Open the episode organically: offline at the running phase.
    delegate.updateRecordingActive(true);
    await settle();

    assert.equal(logCount(logEntries, "warn", "deferred until the camera is online"), 1, "the organic deferral opened at warn");

    // The camera returns, but a starved buffer fails the start: nothing resolves, and the edge-detect input clears.
    host.isReachable = true;
    host.livestreamMediaSegments = 0;

    await delegate.configureTimeshifting();
    await settle();

    // The camera drops again, this time under a reboot we induced. The open edge fires afresh and reclassifies the episode.
    host.isReachable = false;
    nvr.phase = "rebooting";

    await delegate.configureTimeshifting();
    await settle();

    assert.equal(logCount(logEntries, "debug", "deferred until the camera is online"), 1, "the re-open logged its own deferral line at the new level");
    assert.equal(logCount(logEntries, "warn", "deferred until the camera is online"), 1, "the re-open did not repeat the original level's line");

    // The reboot completes and the camera returns to a fillable buffer, so the start succeeds and the resolution narrates.
    nvr.phase = "running";
    host.isReachable = true;
    host.livestreamMediaSegments = Math.ceil(PROTECT_TIMESHIFT_BUFFER_MAXDURATION / PROTECT_SEGMENT_RESOLUTION) + 10;

    await delegate.configureTimeshifting();
    await settle();

    assert.equal(logCount(logEntries, "debug", "has started now that the camera is online"), 1, "the resolution narrated once at the last captured origin");
    assert.equal(logCount(logEntries, "warn", "has started now that the camera is online"), 0, "the overwritten origin did not also narrate");

    // A further kick against the running buffer must narrate nothing: the resolution closed the episode.
    await delegate.configureTimeshifting();
    await settle();

    assert.equal(logCount(logEntries, "debug", "has started now that the camera is online"), 1, "a kick after the resolution did not narrate a second time at debug");
    assert.equal(logCount(logEntries, "warn", "has started now that the camera is online"), 0, "a kick after the resolution did not narrate at warn either");
  });

  // The re-log is per RE-OPEN, not per level change: a flicker whose classification is unchanged still logs a second deferral line, because the open edge is what
  // narrates. The single resolution that follows announces once at that same level.
  test("a flicker at an unchanged classification still re-logs the deferral and resolves once", async () => {

    const { delegate, host, logEntries } = arrangeDeferralDelegate();

    // Open the episode organically: offline at the running phase.
    delegate.updateRecordingActive(true);
    await settle();

    assert.equal(logCount(logEntries, "warn", "deferred until the camera is online"), 1, "the organic deferral opened at warn");

    // The camera returns, but a starved buffer fails the start: nothing resolves, and the edge-detect input clears.
    host.isReachable = true;
    host.livestreamMediaSegments = 0;

    await delegate.configureTimeshifting();
    await settle();

    // The camera drops again with the phase unchanged, so the re-open classifies identically to the first.
    host.isReachable = false;

    await delegate.configureTimeshifting();
    await settle();

    assert.equal(logCount(logEntries, "warn", "deferred until the camera is online"), 2, "the re-open logged a second deferral line at the same level");
    assert.equal(logCount(logEntries, "debug", "deferred until the camera is online"), 0, "the unchanged classification never dropped a line to debug");

    // The camera returns to a fillable buffer, so the start succeeds and the single resolution narrates.
    host.isReachable = true;
    host.livestreamMediaSegments = Math.ceil(PROTECT_TIMESHIFT_BUFFER_MAXDURATION / PROTECT_SEGMENT_RESOLUTION) + 10;

    await delegate.configureTimeshifting();
    await settle();

    assert.equal(logCount(logEntries, "warn", "has started now that the camera is online"), 1, "the two deferral lines resolved with a single resumption");
    assert.equal(logCount(logEntries, "debug", "has started now that the camera is online"), 0, "the resumption did not also narrate at debug");
  });

  // Negative control for the demand-disable reset, asserted on the FIELD. A recording is deferred offline (a resolution becomes owed), then disabled. The disable edge
  // must drop the pending-resolution narration so a later start cannot resurrect the disabled episode's resolution. We read the field directly through a test subclass:
  // the log-absence is coincidentally green whether or not the reset ran, because the disable's own reconcile pass clears the edge-detect input regardless.
  test("a demand-disable during a deferral clears the pending-resolution narration field", async () => {

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

    // The divergence moment, and what makes the reads above and below genuinely distinguishing: the camera comes back but the starved buffer fails the start, so the
    // edge-detect input clears while the episode still owes its resolution. A projection reading the edge input instead of the episode answers false right here.
    host.isReachable = true;
    host.livestreamMediaSegments = 0;

    await supervisor.reconcile();
    await settle();

    assert.equal(supervisor.pendingResolution, true, "the episode still owes its resolution even though the edge-detect input has cleared");

    // Restore the offline state the disable is asserted against. This flip deliberately drives no reconcile: the disable below writes the demand before its own pass
    // runs, so no pass ever observes an offline camera with recording still enabled, and no second deferral line can fire from it.
    host.isReachable = false;

    // Disable recording during the deferral. The disable edge must clear the pending-resolution field so the disabled episode owes nothing.
    await supervisor.setRecordingDemand({ config: makeRecordingConfig(), isRecording: false });
    await settle();

    assert.equal(supervisor.pendingResolution, false, "the demand-disable cleared the pending-resolution narration field");
  });

  // The reset lives at the demand EDGE, not inside a reconcile pass, and the suspension window is where those two placements part company. A pass is held mid-start
  // on a gated establishment while the episode is owed; the disable then lands synchronously, so at the assert below the suspended pass predates the disable and the
  // coalesced follow-up has not begun - a reset relocated into the pass could not yet have run, and the projection would still read owed. The held start is then
  // released after the supervisor's lifetime has ended, so it declines at its commit point and the suspended pass ends on the start's failure, narrating nothing from
  // state the disable has already retired.
  test("a demand-disable clears the pending resolution while a start is still suspended mid-pass", async () => {

    const { controller, host, logEntries } = makeTestCameraHost();

    controllers.push(controller);

    host.stream = new TestStreamingDelegate();
    host.selectSubstrateChannel = (): ChannelProfile => makeChannelProfile(host);
    host.isReachable = false;

    const supervisor = new InspectableSupervisor(host);

    // Open the deferral: recording demanded while the camera is offline.
    await supervisor.setRecordingDemand({ config: makeRecordingConfig(), isRecording: true });
    await settle();

    assert.equal(supervisor.pendingResolution, true, "the deferral opened, so a resolution narration is owed");

    // Queue a double whose establishment stays open, bring the camera back, and kick a pass without awaiting it: the pass parks at the buffer's start with the episode
    // still owed.
    const double = makeControllableLivestreamDouble({ deferEstablishment: true });

    host.livestreamSubscriptions.push(double);
    host.isReachable = true;

    const suspendedPass = supervisor.reconcile();

    await settle();

    assert.equal(supervisor.buffer.isStarted, false, "the start is held in flight, so the pass is suspended with the episode still owed");

    // Disable recording while that pass is suspended. The demand write and its episode reset are synchronous, so they land before any pass can process them.
    void supervisor.setRecordingDemand({ config: makeRecordingConfig(), isRecording: false });

    assert.equal(supervisor.pendingResolution, false, "the demand edge cleared the episode while the in-flight pass was still suspended");

    // End through the decline path: the supervisor's lifetime ends before the establishment releases, so the resumed start declines at its commit point and the
    // suspended pass never reaches the narration blocks with the configuration the disable retired.
    supervisor.shutdown();
    double.releaseEstablishment();

    await suspendedPass;
    await settle();

    assert.equal(supervisor.pendingResolution, false, "the episode stayed closed once the suspended pass resumed");
    assert.equal(logCount(logEntries, "warn", "has started now that the camera is online"), 0, "the retired episode narrated no resolution at warn");
    assert.equal(logCount(logEntries, "debug", "has started now that the camera is online"), 0, "the retired episode narrated no resolution at debug");
    assert.equal(logCount(logEntries, "info", "HKSV:"), 0, "the declined start acknowledged no recording configuration");
  });

  // A reconcile asked after shutdown runs no pass, and the order of the arrangement is what makes that observable. The supervisor is shut down first, and only then
  // does the camera go offline under a pushed recording demand, so the pass that push would run is the one that opens a deferral: its warn line and the resolution it
  // leaves owed are what a pass after the lifetime's end would leave behind. The second cell reads the settlement itself, on a supervisor shut down with no recording
  // demand, whose reconcile resolves rather than carrying the task's refusal.
  test("a reconcile asked after shutdown runs no pass", async () => {

    const { controller, host, logEntries } = makeTestCameraHost();

    controllers.push(controller);

    host.stream = new TestStreamingDelegate();
    host.selectSubstrateChannel = (): ChannelProfile => makeChannelProfile(host);

    const supervisor = new InspectableSupervisor(host);

    supervisor.shutdown();

    // The camera goes offline after the shutdown, so a pass run for the push below would open the deferral episode.
    host.isReachable = false;

    const logCountBeforePush = logEntries.length;

    await supervisor.setRecordingDemand({ config: makeRecordingConfig(), isRecording: true });
    await settle();

    assert.equal(logEntries.length, logCountBeforePush, "no pass ran, so no deferral line was written");
    assert.equal(supervisor.pendingResolution, false, "no pass ran, so no deferral episode was opened");

    // The second cell: on a supervisor shut down with no recording demand ever pushed to it, a reconcile resolves rather than carrying the task's refusal of a request
    // made after the lifetime's end. Its buffer never started, so a started-state read would pass whether or not a pass ran, and the cell reads the settlement alone.
    const undemanded = new ProtectTimeshiftSupervisor(host);

    undemanded.shutdown();

    await assert.doesNotReject(undemanded.reconcile(), "a reconcile after shutdown resolves rather than carrying the task's refusal");
  });
});

describe("timeshift supervisor never-rejecting reconcile", () => {

  // A reconcile pass that throws must have its fault converted inside the supervisor - the reconcile is reached through many fire-and-forget void kicks, so an escaping
  // rejection would float unhandled and reach every caller holding the promise of the pass in flight. We arrange a deferral edge (camera offline while recording), whose
  // bookkeeping runs first, then make the buffer's stop throw at the stop point that follows in the same pass. The conversion must swallow the throw so nothing floats,
  // log exactly one retry line, and leave the pass's deferral bookkeeping intact - which we prove through the resumption that fires when the camera returns online,
  // since that resumption consults the very deferral field the throwing pass had already updated.
  test("a throwing reconcile pass is caught, logs once, and preserves the deferral bookkeeping", async () => {

    const { host, logEntries, supervisor } = await arrangeEnabledDelegate();

    // Take the camera offline and make the buffer's stop throw. The offline pass opens the deferral (its warn and field update run first), then throws at buffer.stop.
    host.isReachable = false;
    supervisor.buffer.stop = (): boolean => { throw new Error("stop boom"); };

    // Capture any unhandled rejection the throwing pass might float through the reconcile chokepoint.
    const floats: unknown[] = [];
    const onFloat = (reason: unknown): void => { floats.push(reason); };

    process.on("unhandledRejection", onFloat);

    try {

      await supervisor.reconcile();
      await settle();
    } finally {

      process.off("unhandledRejection", onFloat);
    }

    assert.equal(floats.length, 0, "the throwing pass did not float an unhandled rejection through the reconcile chokepoint");
    assert.ok(logCount(logEntries, "warn", "deferred until the camera is online") >= 1, "the deferral bookkeeping ran before the throw - the deferral warn fired");
    assert.equal(logCount(logEntries, "error", "could not be updated and will be retried"), 1, "the caught failure logged exactly one retry line");

    // The next request still runs a pass and the deferral field the throwing pass set is intact: bring the camera back online and a fresh reconcile recovers, firing
    // the resumption that consults that very field.
    host.isReachable = true;

    await supervisor.reconcile();
    await settle();

    assert.ok(logCount(logEntries, "warn", "has started now that the camera is online") >= 1,
      "the resumption fires on recovery, proving the throwing pass had already updated the deferral bookkeeping before it threw");
  });
});

describe("timeshift supervisor narration liveness guard", () => {

  // The consume loop runs detached from the start commit, so a buffer can die in the microtask window between a start settling and the pass narrating. A one-shot
  // onStartSettled override lands the death exactly inside that window: it stops the buffer on the first settled start, then disarms so the follow-up pass the death
  // queues can settle rather than re-entering the kill forever. Stopping the buffer synchronously drops isStarted and emits "stopped" (cause "ended"), on which the
  // supervisor's own listener asks for a reconcile from inside the pass, queuing one further pass behind it; the one-shot flag keeps that queued pass from being
  // killed too, so the passes settle instead of spinning.
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

    assert.equal(logCount(logEntries, "warn", "deferred until the camera is online"), 1, "the deferral episode opened while offline");

    // Phase 1: the camera returns. The first start succeeds on the one queued double, but the death lands inside the settle window before the pass narrates. The death
    // re-arms a follow-up pass, which falls back to the starved parking double and fails to re-establish, so nothing narrates at all.
    host.isReachable = true;
    host.livestreamMediaSegments = 0;
    host.livestreamSubscriptions.push(makeControllableLivestreamDouble());

    await supervisor.reconcile();
    await settle();

    assert.equal(logCount(logEntries, "info", "HKSV:"), 0, "the phantom acknowledgment was suppressed for the buffer that died in the window");
    assert.equal(logCount(logEntries, "warn", "has started now that the camera is online"), 0, "the phantom deferral resolution was suppressed at warn");
    assert.equal(logCount(logEntries, "debug", "has started now that the camera is online"), 0, "the phantom deferral resolution was suppressed at debug");
    assert.equal(supervisor.buffer.isStarted, false, "the starved follow-up pass could not re-establish, so the buffer is stopped");
    assert.equal(host.livestreamCalls.length, 2, "the death bought exactly one further pass, which made the second livestream call");

    // Phase 2: a healthy fallback re-arms. The honest retry re-establishes, and both suppressed lines fire exactly once - the acknowledgment latch and the pending
    // deferral resolution both survived the phantom.
    host.livestreamMediaSegments = Math.ceil(PROTECT_TIMESHIFT_BUFFER_MAXDURATION / PROTECT_SEGMENT_RESOLUTION) + 10;

    await supervisor.reconcile();
    await settle();

    assert.equal(logCount(logEntries, "info", "HKSV:"), 1, "the acknowledgment latch survived the phantom and fires once on the honest retry");
    assert.equal(logCount(logEntries, "warn", "has started now that the camera is online"), 1, "the deferral resolution survived and fires once on the honest retry");
    assert.equal(supervisor.buffer.isStarted, true, "the honest retry re-established the buffer");
  });
});

describe("timeshift supervisor enable-acknowledgment lifecycle", () => {

  // The "HKSV: ..." config summary fires once per enable EPISODE (not once per delegate lifetime, and not once per reconcile): exactly once on the first successful
  // configure of an episode, again on a true re-enable after a disable, never on a redundant within-episode reconcile. This holds both halves of the acknowledgment
  // lifecycle - the trigger on the reconcile's successful-start path (so the trigger is the configuration event) and the reset on the disable demand edge (so the next
  // enable re-acknowledges). We count occurrences rather than a boolean .some(): the boolean would pass after the FIRST enable regardless of whether the second
  // re-acknowledged, so it cannot distinguish a set-once-never-cleared flag that logs only the first enable.
  test("acknowledges the recording configuration on each enable episode, not within an episode and not only the first", async () => {

    const { delegate, logEntries } = await arrangeEnabledDelegate();

    // The arrange already armed recording once (updateRecordingActive(true) reached the reconcile's successful-start path), so the first enable acknowledged exactly
    // once - the relocation is behavior-preserving for the first enable.
    assert.equal(logCount(logEntries, "info", "HKSV:"), 1, "the first enable acknowledged the configuration exactly once");

    // A redundant reconcile WHILE STILL ENABLED (no disable) must NOT re-acknowledge: the timeshift is already running on the desired channel, so the reconcile reaches
    // the shared acknowledgment gate with the flag already set and does not re-acknowledge. This is what proves "once per episode" rather than "once per reconcile".
    await delegate.configureTimeshifting();
    await settle();

    assert.equal(logCount(logEntries, "info", "HKSV:"), 1, "a redundant reconcile within the same enable episode did not re-acknowledge");

    // Disable ends the episode: the "Disabling..." transition log fires and the acknowledgment flag is reset.
    delegate.updateRecordingActive(false);

    assert.ok(logCount(logEntries, "info", "Disabling HomeKit Secure Video event recording.") >= 1, "the disable logged its transition");

    // Re-enable starts a fresh episode: the reconcile re-establishes the buffer (the segment-yielding double re-yields on the second start) and reaches the
    // successful-start path again, so the acknowledgment fires a SECOND time. logCount === 2 is false against the un-reset flag (which would log only the first enable,
    // leaving the count at 1) and true after the reset - the distinguishing assertion.
    delegate.updateRecordingActive(true);
    await settle();

    assert.equal(logCount(logEntries, "info", "HKSV:"), 2, "the re-enable re-acknowledged the configuration, so the ack fired on each enable");
  });

  /* The disable race. A start can be suspended across its await while HomeKit turns recording off underneath it, and the pass that resumes still holds the demand it
   * began with. This arranges exactly that window: the establishment is gated open, the disable lands synchronously while the pass is held, and the establishment is
   * then released so the start genuinely SUCCEEDS - the pass runs all the way through its narration blocks with a buffer that is really up.
   *
   * The arrangement is shared by both arms below because the window is the same one; each asserts a different thing about what the pass does at the finish line.
   */
  async function arrangeDisableRace(): Promise<{ logEntries: readonly TestLogEntry[]; supervisor: ProtectTimeshiftSupervisor }> {

    const { controller, host, logEntries } = makeTestCameraHost();

    controllers.push(controller);

    host.stream = new TestStreamingDelegate();
    host.selectSubstrateChannel = (): ChannelProfile => makeChannelProfile(host);

    // Fill any LATER start (the follow-up enable below) through the default segment-yielding double, so a re-established buffer commits on its own.
    host.livestreamMediaSegments = Math.ceil(PROTECT_TIMESHIFT_BUFFER_MAXDURATION / PROTECT_SEGMENT_RESOLUTION) + 10;

    // The first start takes a double whose establishment stays open, which is what holds the pass mid-start.
    const double = makeControllableLivestreamDouble({ deferEstablishment: true });

    host.livestreamSubscriptions.push(double);

    const supervisor = new ProtectTimeshiftSupervisor(host);

    // Enable recording and let the pass reach the held start without awaiting it.
    const suspendedPass = supervisor.setRecordingDemand({ config: makeRecordingConfig(), isRecording: true });

    await settle();

    assert.equal(supervisor.buffer.isStarted, false, "the start is held in flight, so the pass is suspended before its narration");
    assert.equal(logCount(logEntries, "info", "HKSV:"), 0, "nothing has been acknowledged yet - the buffer is not up");

    // HomeKit disables recording while that pass is held. The demand write is synchronous, so it lands before the pass can resume.
    void supervisor.setRecordingDemand({ config: makeRecordingConfig(), isRecording: false });

    // Release the establishment. The start now COMMITS - no ended lifetime, no decline - so the resumed pass reaches the commit point with a running buffer and a
    // recording demand that has already gone away.
    double.releaseEstablishment();

    await suspendedPass;
    await settle();

    return { logEntries, supervisor };
  }

  // A recording disabled while its start was in flight must be honored at the finish line, not acknowledged over. The zero-count is the direct assertion; the follow-up
  // enable is what proves the flag was also left unset, which the log alone cannot show - an enable acknowledges only if the raced pass never latched, so a count of one
  // here reads true exactly when the disable was honored in both respects.
  test("a recording disabled while its start was suspended is never acknowledged, and leaves the next enable free to acknowledge", async () => {

    const { logEntries, supervisor } = await arrangeDisableRace();

    assert.equal(logCount(logEntries, "info", "HKSV:"), 0, "the pass acknowledged nothing for a recording that had already been disabled");

    // A genuine enable afterwards. It re-establishes through the segment-yielding double and reaches the same commit point, this time with a live demand.
    await supervisor.setRecordingDemand({ config: makeRecordingConfig(), isRecording: true });
    await settle();

    assert.equal(logCount(logEntries, "info", "HKSV:"), 1, "the next genuine enable acknowledged exactly once, so the raced pass had left nothing latched");
  });

  // The same window, read through the buffer's state once the passes the disable joined have settled. The raced start committed a running buffer, and only the
  // follow-up pass the disable bought can have stopped it, so reading the buffer stopped once the joined passes and the settle are through proves that pass ran.
  test("the passes a mid-start disable joined leave the buffer stopped once they settle", async () => {

    const { supervisor } = await arrangeDisableRace();

    assert.equal(supervisor.buffer.isStarted, false, "the raced start's buffer reads stopped after the joined passes and the settle, so the pass the disable bought ran");
  });
});

describe("timeshift supervisor demand-edge episode resets", () => {

  // The per-episode resets live on the demand setter's disable edge, never inside a reconcile pass, so they land synchronously with the demand write even when the
  // flap's enable queues behind the disable's pass. The flap must re-acknowledge exactly once: the disable edge closes the old enable episode (resetting the
  // acknowledgment flag) before any pass processes it, and the enable's successful restart opens - and acknowledges - exactly one new episode.
  test("a coalesced disable-then-enable flap re-acknowledges exactly once", async () => {

    const { logEntries, supervisor } = await arrangeEnabledDelegate();

    assert.equal(logCount(logEntries, "info", "HKSV:"), 1, "the initial enable acknowledged once");

    const config = makeRecordingConfig();

    // Fire the flap back-to-back in one synchronous frame: the enable lands while the disable's pass is still in flight and queues one further pass behind it.
    void supervisor.setRecordingDemand({ config, isRecording: false });
    void supervisor.setRecordingDemand({ config, isRecording: true });

    await settle();

    // Exactly one more acknowledgment: the flap closed the old episode on the disable edge and re-acknowledged once on the enable's successful restart.
    assert.equal(logCount(logEntries, "info", "HKSV:"), 2, "the flap re-acknowledged exactly once");
    assert.equal(supervisor.buffer.isStarted, true, "the flap settled with the buffer running");
  });
});

describe("timeshift supervisor shutdown", () => {

  // Shutdown is the terminal teardown: it must stop the buffer synchronously, produce no narration of its own, and end the supervisor's lifetime so a post-shutdown
  // reconcile settles on stopped rather than restarting the buffer. No pass runs for it even though the pushed demand is unchanged and still wants recording: the
  // buffer stays stopped and the livestream is never opened again.
  test("shutdown stops the buffer synchronously, logs nothing, and post-shutdown reconciles settle on stopped", async () => {

    const { host, logEntries, supervisor } = await arrangeEnabledDelegate();

    assert.equal(supervisor.buffer.isStarted, true, "the arrange left the buffer running");
    assert.equal(host.livestreamCalls.length, 1, "the arrange opened exactly one livestream");

    const logCountBeforeShutdown = logEntries.length;

    supervisor.shutdown();

    // The stop is synchronous and silent.
    assert.equal(supervisor.buffer.isStarted, false, "shutdown stopped the buffer synchronously");
    assert.equal(logEntries.length, logCountBeforeShutdown, "shutdown produced no narration");

    // A post-shutdown reconcile settles on stopped without running a pass: recording is still demanded, yet no restart happens and the livestream is never opened again.
    await supervisor.reconcile();
    await settle();

    assert.equal(supervisor.buffer.isStarted, false, "the buffer stayed stopped through the post-shutdown reconcile");
    assert.equal(host.livestreamCalls.length, 1, "no restart reached the livestream interface");
    assert.equal(logEntries.length, logCountBeforeShutdown, "the post-shutdown reconcile produced no narration");
  });

  // A second shutdown is a designed no-op, and the entry guard on the ended lifetime is what makes it one rather than an accident of ordering. The observable that tells
  // the two apart is the CALL, not an emission: the buffer reports nothing when asked to stop something it already stopped, so an emission count stays green whether or
  // not the guard is there. Spying the stop call is what fails when the guard is removed.
  test("a second shutdown returns at the ended lifetime rather than tearing the buffer down again", async (t) => {

    const { supervisor } = await arrangeEnabledDelegate();

    assert.equal(supervisor.buffer.isStarted, true, "the arrange left the buffer running");

    const stopSpy = t.mock.method(supervisor.buffer, "stop");

    supervisor.shutdown();
    supervisor.shutdown();

    assert.equal(stopSpy.mock.callCount(), 1, "only the first shutdown reached the buffer's teardown");
    assert.equal(supervisor.buffer.isStarted, false, "the buffer is stopped either way");
  });

  // The lifetime is per-instance by construction: tearing one supervisor down says nothing about a fresh one, which the streaming-delegate rebuild path constructs. A
  // fresh supervisor on the same host starts its buffer normally.
  test("a fresh supervisor instance on the same host starts with a lifetime of its own", async () => {

    const { host, supervisor } = await arrangeEnabledDelegate();

    supervisor.shutdown();

    assert.equal(supervisor.buffer.isStarted, false, "the first supervisor is shut down");

    const fresh = new ProtectTimeshiftSupervisor(host);

    await fresh.setRecordingDemand({ config: makeRecordingConfig(), isRecording: true });
    await settle();

    assert.equal(fresh.buffer.isStarted, true, "the fresh supervisor's buffer is running");
  });

  // The supervisor's lifetime reaches its buffer's livestream: the buffer opens its subscription under the supervisor's own signal, so a shutdown ends that subscription
  // through the abort as well as through the buffer's stop. The same signal object is read before and after the shutdown, which tells the supervisor's lifetime from
  // any other signal the call might have carried.
  test("the buffer opens its livestream under the supervisor's lifetime signal, which shutdown aborts", async () => {

    const { host, supervisor } = await arrangeEnabledDelegate();
    const signal = host.livestreamCalls[0]?.opts?.signal;

    assert.ok(signal, "the buffer's livestream call carried a signal");
    assert.equal(signal.aborted, false, "the signal is live while the supervisor runs");

    supervisor.shutdown();

    assert.equal(signal.aborted, true, "shutdown aborted the very signal the buffer's livestream call carried");
  });

  // The commit-point decline, driven through the REAL shutdown-versus-in-flight-start race rather than a hook. A fresh first-enable starts the buffer, but the start is
  // held in flight on a gated establishment; shutdown() runs while it is pending, so the lifetime ends and its stop() finds no committed subscription to release. When
  // the establishment then releases, the start reaches its commit point, reads its owner's aborted signal, disposes the subscription it opened and declines - so the
  // pass ends on the start's failure having never started. The host double records the signal and does nothing more with it, so the held establishment still
  // answers true after the abort, which is the one case the commit point's check exists for.
  //
  // No pass follows a shutdown, so a start that DID commit would simply stay committed: what tells it from a declined start is the subscription's dispose, the started
  // state, and the acknowledgment count, because a committed start keeps its subscription, reports itself started, and is acknowledged by the pass awaiting it. The
  // stopped-emit count and the DEBUG stop line stay at zero because nothing here tore a running buffer down: shutdown's stop found no committed subscription, and the
  // declined start released only what it had opened.
  test("a shutdown that races an in-flight start declines the commit and disposes the subscription", async () => {

    const { controller, host, logEntries } = makeTestCameraHost();

    controllers.push(controller);

    host.stream = new TestStreamingDelegate();
    host.selectSubstrateChannel = (): ChannelProfile => makeChannelProfile(host);

    // Queue a double whose establishment stays open until the test releases it, so the first start parks in flight.
    const double = makeControllableLivestreamDouble({ deferEstablishment: true });

    host.livestreamSubscriptions.push(double);

    const supervisor = new ProtectTimeshiftSupervisor(host);

    // Count the buffer's teardown emits from before the shutdown, so the shutdown's own stop and any later release are both in scope.
    let stoppedEmits = 0;

    supervisor.buffer.on("stopped", (): void => { stoppedEmits++; });

    // Enable recording. The reconcile reaches buffer.start and parks on the gated establishment, so the subscription is not yet committed.
    const enablePromise = supervisor.setRecordingDemand({ config: makeRecordingConfig(), isRecording: true });

    await settle();

    assert.equal(supervisor.buffer.isStarted, false, "the start is held in flight, not yet committed");

    // Shutdown races the pending start: the lifetime ends first, and stop() has no committed subscription to release.
    supervisor.shutdown();

    assert.equal(host.livestreamCalls[0]?.opts?.signal?.aborted, true, "the shutdown aborted the signal the in-flight start's livestream call carries");

    // Release establishment so the held start settles AFTER shutdown returned and meets the aborted signal at its commit point.
    double.releaseEstablishment();

    await enablePromise;
    await settle();

    assert.equal(stoppedEmits, 0, "no teardown was reported because none happened - shutdown's stop found no committed subscription");
    assert.equal(logCount(logEntries, "debug", "Timeshift buffer stopped."), 0, "no pass stopped a running buffer, since the commit never landed");
    assert.equal(double.disposed, true, "the declined start disposed the subscription it opened");
    assert.equal(supervisor.buffer.isStarted, false, "the buffer never started");
    assert.equal(supervisor.buffer.channelProfile, null, "no channel profile committed");
    assert.equal(logCount(logEntries, "info", "HKSV:"), 0, "the shutdown-raced start emitted no acknowledgment");
    assert.equal(logCount(logEntries, "warn", "has started now that the camera is online"), 0, "no deferral resolution narrated at warn");
    assert.equal(logCount(logEntries, "debug", "has started now that the camera is online"), 0, "no deferral resolution narrated at debug");
  });

  // A follow-up queued before a shutdown does not run after it. The in-flight race's arrangement holds a start on a deferred establishment, and a reconcile asked
  // while it is held queues one further pass behind it; the shutdown that follows ends the lifetime that pass would run in. The livestream call count tells the two
  // apart: the held start made the only call, and a queued pass that ran after the shutdown would find the buffer stopped and make another.
  test("a follow-up queued before a shutdown does not run after it", async () => {

    const { controller, host } = makeTestCameraHost();

    controllers.push(controller);

    host.stream = new TestStreamingDelegate();
    host.selectSubstrateChannel = (): ChannelProfile => makeChannelProfile(host);

    // Queue a double whose establishment stays open until the test releases it, so the first start parks in flight.
    const double = makeControllableLivestreamDouble({ deferEstablishment: true });

    host.livestreamSubscriptions.push(double);

    const supervisor = new ProtectTimeshiftSupervisor(host);
    const enablePromise = supervisor.setRecordingDemand({ config: makeRecordingConfig(), isRecording: true });

    await settle();

    assert.equal(supervisor.buffer.isStarted, false, "the start is held in flight, not yet committed");

    // Ask for a reconcile while the start is held, which queues one further pass, then shut down before the held start settles.
    void supervisor.reconcile();
    supervisor.shutdown();
    double.releaseEstablishment();

    await enablePromise;
    await settle();

    assert.equal(host.livestreamCalls.length, 1, "the held start made the only livestream call, so no queued pass ran after the shutdown");
  });

  // The settle window's other occupant: a shutdown landing AFTER a start has committed, before the pass narrates. The one-shot onStartSettled override lands it exactly
  // there, and no pass follows the shutdown to settle a start again. Here the buffer genuinely committed, so shutdown's stop acts on a live subscription and disposes
  // it, and the narration guard catches the window through the started state alone.
  class ShutdownAtSettleSupervisor extends ProtectTimeshiftSupervisor {

    private shutDownOnce = false;

    protected override onStartSettled(): void {

      if(!this.shutDownOnce) {

        this.shutDownOnce = true;
        this.shutdown();
      }
    }
  }

  test("a shutdown landing in the settle window narrates nothing and leaves the buffer stopped", async () => {

    const { controller, host, logEntries } = makeTestCameraHost();

    controllers.push(controller);

    host.stream = new TestStreamingDelegate();
    host.selectSubstrateChannel = (): ChannelProfile => makeChannelProfile(host);

    // A normally-establishing double, so the start actually commits before the hook fires.
    const double = makeControllableLivestreamDouble();

    host.livestreamSubscriptions.push(double);

    const supervisor = new ShutdownAtSettleSupervisor(host);

    let stoppedEmits = 0;

    supervisor.buffer.on("stopped", (): void => { stoppedEmits++; });

    await supervisor.setRecordingDemand({ config: makeRecordingConfig(), isRecording: true });
    await settle();

    assert.equal(logCount(logEntries, "info", "HKSV:"), 0, "the settle-window shutdown emitted no acknowledgment");
    assert.equal(logCount(logEntries, "warn", "has started now that the camera is online"), 0, "no deferral resolution narrated at warn");
    assert.equal(logCount(logEntries, "debug", "has started now that the camera is online"), 0, "no deferral resolution narrated at debug");
    assert.equal(supervisor.buffer.isStarted, false, "the shutdown stopped the committed buffer before the guard read it");
    assert.equal(double.disposed, true, "the shutdown's stop disposed the committed subscription");
    assert.equal(stoppedEmits, 1, "the committed subscription was released exactly once");
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
    assert.equal(observedAtEmit[0].isStarted, false, "the listener observed the buffer already stopped at emit time");
    assert.equal(supervisor.buffer.channelProfile, null, "the profile stays cleared after the death");
  });
});

describe("timeshift supervisor forwarder identity", () => {

  // The delegate's configureTimeshifting is a synchronous join onto the supervisor's reconciler - it must return the supervisor's own in-flight promise, not a
  // wrapper around it. Promise identity is the whole proof: identical objects mean a caller joining through the forwarder holds the very promise of the pass in
  // flight, with no added microtask boundary between the two.
  test("configureTimeshifting returns the supervisor's in-flight reconcile promise", async () => {

    const { controller, host } = makeTestCameraHost();

    controllers.push(controller);

    const supervisor = new ProtectTimeshiftSupervisor(host);
    const delegate = new ProtectRecordingDelegate(host, supervisor);

    // Start a reconcile, then join through the forwarder in the same synchronous frame: both callers must hold the identical promise object.
    const direct = supervisor.reconcile();
    const forwarded = delegate.configureTimeshifting();

    assert.equal(forwarded, direct, "the forwarder returned the supervisor's own in-flight promise");
    await forwarded;

    // Once the pass in flight settles, a fresh forwarded call starts a NEW reconcile rather than handing back the settled promise.
    const fresh = delegate.configureTimeshifting();

    assert.notEqual(fresh, direct, "a post-settlement call starts a fresh reconcile");
    await fresh;
  });
});

// Arrange a streaming-arm-capable supervisor: buffer-backed livestreaming is on and the success-path dependencies are wired (the buffer fills through the segment-
// yielding double), but HomeKit recording is never armed. The streaming demand arm alone drives the buffer here.
function arrangeStreamingHost(): { host: TestCameraHost; logEntries: readonly TestLogEntry[]; supervisor: ProtectTimeshiftSupervisor } {

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

    await supervisor.reconcile();
    await settle();

    assert.equal(supervisor.buffer.isStarted, true, "the streaming arm started the standing buffer");
    assert.equal(logCount(logEntries, "debug", "Timeshift buffer started for livestreaming."), 1, "a streaming-only start narrates at debug");
    assert.equal(logCount(logEntries, "info", "HKSV:"), 0, "a streaming-only start emits no HKSV acknowledgment");
  });

  // A streaming-only camera going offline is already covered by the controller/camera narration, so its deferral is silent: the deferral block stays gated on the
  // recording request, so a streaming-only offline reconcile emits nothing at warn or debug about a deferral.
  test("a streaming-only camera going offline defers silently", async () => {

    const { host, logEntries, supervisor } = arrangeStreamingHost();

    host.isReachable = false;

    await supervisor.reconcile();
    await settle();

    assert.equal(supervisor.buffer.isStarted, false, "the offline camera did not start the buffer");
    assert.equal(logCount(logEntries, "warn", "deferred until the camera is online"), 0, "a streaming-only offline does not defer at warn");
    assert.equal(logCount(logEntries, "debug", "deferred until the camera is online"), 0, "a streaming-only offline does not defer at debug");
  });

  // The standing-buffer common case: the streaming arm has the buffer already running when the recording arm enables. The acknowledgment must still fire exactly once,
  // now on the already-running path rather than a fresh start - the restructure's whole point.
  test("an already-running streaming buffer acknowledges HKSV exactly once when recording enables", async () => {

    const { logEntries, supervisor } = arrangeStreamingHost();

    await supervisor.reconcile();
    await settle();

    assert.equal(supervisor.buffer.isStarted, true, "the streaming arm left the buffer running");
    assert.equal(logCount(logEntries, "info", "HKSV:"), 0, "no acknowledgment before recording enables");

    // Enable recording against the already-running buffer: the reconcile finds it already on the desired channel and acknowledges on the shared path.
    await supervisor.setRecordingDemand({ config: makeRecordingConfig(), isRecording: true });
    await settle();

    assert.equal(supervisor.buffer.isStarted, true, "the buffer is running after the recording arm enabled");
    assert.equal(logCount(logEntries, "info", "HKSV:"), 1, "the enable acknowledged exactly once on the already-running path");
  });

  // A running buffer restarted onto a different stream goes through one start. The restart stops the running buffer before it opens the new stream, and the stopped
  // event that stop emits asks for a reconcile from inside the pass; that request queues one further pass behind the pass running, which finds the buffer already on
  // the new stream and narrates nothing. The fallback is left inert and one more double is queued than the row consumes, each with an id of its own, so a second
  // start would take that spare double and show up in the call count, the queue, and the doubles left undisposed alike.
  test("a running buffer restarted onto a different stream goes through one start", async () => {

    const { host, logEntries, supervisor } = arrangeStreamingHost();
    const doubles = [ makeControllableLivestreamDouble(), makeControllableLivestreamDouble(), makeControllableLivestreamDouble() ];

    // Leave the fallback inert, so every start this row makes is served by a double it queued.
    host.livestreamMediaSegments = 0;
    host.livestreamSubscriptions.push(...doubles);

    await supervisor.reconcile();
    await settle();

    assert.equal(supervisor.buffer.isStarted, true, "the first reconcile left the buffer running");

    const callsBeforeRestart = host.livestreamCalls.length;
    const otherProfile = makeChannelProfile(host, 1);

    // Steer the selection onto another channel and reconcile the idle supervisor again, so the pass restarts the running buffer onto it.
    host.selectSubstrateChannel = (): ChannelProfile => otherProfile;

    await supervisor.reconcile();
    await settle();

    assert.equal(host.livestreamCalls.length, callsBeforeRestart + 1, "the restart opened exactly one new livestream");
    assert.equal(host.livestreamSubscriptions.length, 1, "the spare double was never handed out");
    assert.equal(doubles.filter((double) => !double.disposed && !host.livestreamSubscriptions.includes(double)).length, 1,
      "exactly one double the host handed out is still undisposed");
    assert.equal(supervisor.buffer.isStarted, true, "the restarted buffer is running");
    assert.equal(supervisor.buffer.channelProfile?.channel.id, otherProfile.channel.id, "the buffer runs on the new channel");
    assert.equal(logCount(logEntries, "debug", "Timeshift buffer started for livestreaming."), 2, "the restart wrote the started line once more, twice in all");
  });

  // A restart whose new start fails is retried at once, and the retry can succeed. The restart's stop asks for a reconcile from inside the pass, and the pass that
  // request queued is the retry: it runs once the failed start has returned, and finds the buffer stopped with the new stream still wanted. The first double queued
  // for the restart answers its establishment false and the second establishes, so the retry is what leaves the buffer running.
  test("a restart whose new start fails is retried at once onto the new stream", async () => {

    const { host, supervisor } = arrangeStreamingHost();

    // Leave the fallback inert and run the buffer on a queued double, so every start this row makes is served by a double it queued.
    host.livestreamMediaSegments = 0;
    host.livestreamSubscriptions.push(makeControllableLivestreamDouble());

    await supervisor.reconcile();
    await settle();

    assert.equal(supervisor.buffer.isStarted, true, "the arrange left the buffer running");

    const callsBeforeRestart = host.livestreamCalls.length;
    const failing = makeControllableLivestreamDouble({ whenEstablished: false });
    const otherProfile = makeChannelProfile(host, 1);

    host.livestreamSubscriptions.push(failing, makeControllableLivestreamDouble());
    host.selectSubstrateChannel = (): ChannelProfile => otherProfile;

    await supervisor.reconcile();
    await settle();

    assert.equal(host.livestreamCalls.length, callsBeforeRestart + 2, "the failed start and its retry each opened a livestream");
    assert.equal(failing.disposed, true, "the failed start disposed the double whose establishment answered false");
    assert.equal(supervisor.buffer.isStarted, true, "the retry left the buffer running");
    assert.equal(supervisor.buffer.channelProfile?.channel.id, otherProfile.channel.id, "the buffer runs on the new channel");
    assert.equal(host.livestreamSubscriptions.length, 0, "no queued double was left");
  });
});

// The rendered HKSV acknowledgment line at info level, or undefined when none fired. The hardware marker is a substituted %s argument, so only the rendered line carries
// it, and the marker assertions read that line itself rather than a count of the marker, because a count of zero cannot tell an acknowledgment without the marker from
// no acknowledgment at all.
function hksvAckLine(entries: readonly TestLogEntry[]): string | undefined {

  const entry = entries.find((candidate) => (candidate.level === "info") && formatLogEntry(candidate).includes("HKSV:"));

  return entry && formatLogEntry(entry);
}

// The hardware marker the acknowledgment prefixes when the HKSV encode runs on the host's hardware encoder (U+26A1 HIGH VOLTAGE SIGN + U+FE0F VARIATION SELECTOR-16),
// encoded here independently so the assertion checks the exact glyph rather than trusting the module constant.
const HKSV_HARDWARE_MARKER = "⚡️";

describe("timeshift supervisor HKSV hardware marker", () => {

  // The acknowledgment prefixes the hardware marker when this camera's HKSV recording encode runs on the host's hardware encoder, which the stub reports through its
  // ffmpegOptions.hardwareEncodes closure. The stub is configured true before the acknowledgment fires, then recording enables against the already-running buffer.
  test("prefixes the hardware marker when the HKSV encode runs on the hardware encoder", async () => {

    const { host, logEntries, supervisor } = arrangeStreamingHost();
    const delegate = new TestStreamingDelegate();

    delegate.hardwareEncodes = true;
    host.stream = delegate;

    await supervisor.reconcile();
    await settle();

    await supervisor.setRecordingDemand({ config: makeRecordingConfig(), isRecording: true });
    await settle();

    assert.equal(supervisor.buffer.isStarted, true, "the buffer is running after the recording arm enabled");

    const line = hksvAckLine(logEntries);

    assert.ok(line?.includes(HKSV_HARDWARE_MARKER), "the acknowledgment carries the hardware marker when the encode runs on the hardware encoder");
  });

  // With the encoder answer at its software-neutral default of false, the acknowledgment still fires but carries no hardware marker.
  test("omits the hardware marker when the HKSV encode runs in software", async () => {

    const { logEntries, supervisor } = arrangeStreamingHost();

    await supervisor.reconcile();
    await settle();

    await supervisor.setRecordingDemand({ config: makeRecordingConfig(), isRecording: true });
    await settle();

    assert.equal(supervisor.buffer.isStarted, true, "the buffer is running after the recording arm enabled");

    const line = hksvAckLine(logEntries);

    assert.ok(line, "the acknowledgment fired");
    assert.equal(line.includes(HKSV_HARDWARE_MARKER), false, "the acknowledgment carries no hardware marker when the encode runs in software");
  });
});

// Arrange an armed, running supervisor whose buffer runs on the FIRST of two queued controllable livestream doubles, so a test can end the first out-of-band and observe
// whether the supervisor re-establishes onto the second.
async function arrangeControllableRecording(): Promise<{ doubles: ControllableLivestreamDouble[]; host: TestCameraHost; supervisor: ProtectTimeshiftSupervisor }> {

  const { controller, host } = makeTestCameraHost();

  controllers.push(controller);

  host.stream = new TestStreamingDelegate();
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
    assert.equal(host.livestreamCalls.length, 1, "no re-establish reached the livestream interface - the queued second subscription was untouched");
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

    assert.equal(logCount(logEntries, "error", "no valid video stream profile was found"), 1, "the selection failure reported once");

    // A repeat kick with the failure unresolved must not re-report - the once-per-episode latch holds.
    await supervisor.reconcile();
    await settle();

    assert.equal(logCount(logEntries, "error", "no valid video stream profile was found"), 1, "a repeat kick did not re-report the still-unresolved failure");

    // A pushed demand change re-arms the report.
    await supervisor.setRecordingDemand({ config: makeRecordingConfig(), isRecording: true });
    await settle();

    assert.equal(logCount(logEntries, "error", "no valid video stream profile was found"), 2, "a demand change re-armed the report");
  });
});

describe("the supervisor's adoption of the derivation's probe subscription", () => {

  // A supervisor handed the probe pair, under the streaming arm's demand unless a row withdraws it, with the host selecting its first channel.
  function arrangeAdoption(options: { adopted: ControllableLivestreamDouble; profileIndex?: number }):
  { host: TestCameraHost; supervisor: ProtectTimeshiftSupervisor } {

    const { controller, host } = makeTestCameraHost();

    controllers.push(controller);

    host.stream = new TestStreamingDelegate();
    host.selectSubstrateChannel = (): ChannelProfile => makeChannelProfile(host);
    host.usesTimeshiftLivestream = true;

    const supervisor = new ProtectTimeshiftSupervisor(host, { adopt: { profile: makeChannelProfile(host, options.profileIndex), subscription: options.adopted },
      advertised: { channels: 1, codec: "aac", sampleRate: 16000 } });

    return { host, supervisor };
  }

  test("an adopted subscription on the desired channel starts the buffer with no subscribe of its own when demand holds", async () => {

    const adopted = makeControllableLivestreamDouble();
    const { host, supervisor } = arrangeAdoption({ adopted });

    await supervisor.reconcile();

    assert.equal(supervisor.buffer.isStarted, true, "the buffer started");
    assert.equal(host.livestreamCalls.length, 0, "the start subscribed nothing, running on the adopted subscription");
    assert.equal(adopted.disposed, false, "the adopted subscription is the buffer's, still open");

    supervisor.shutdown();

    assert.equal(adopted.disposed, true, "the buffer's own teardown disposes it");
  });

  test("with no demand the adopted subscription is disposed and the buffer stays stopped", async () => {

    const adopted = makeControllableLivestreamDouble();
    const { host, supervisor } = arrangeAdoption({ adopted });

    host.usesTimeshiftLivestream = false;
    await supervisor.reconcile();

    assert.equal(adopted.disposed, true, "a pass with no demand disposed the adopted subscription");
    assert.equal(supervisor.buffer.isStarted, false, "the buffer stayed stopped");
    assert.equal(host.livestreamCalls.length, 0, "nothing subscribed");
  });

  test("an adopted subscription on a different channel, or one already closed, is disposed and one fresh subscribe runs", async () => {

    const elsewhere = makeControllableLivestreamDouble();
    const moved = arrangeAdoption({ adopted: elsewhere, profileIndex: 1 });

    await moved.supervisor.reconcile();

    assert.equal(elsewhere.disposed, true, "the subscription on another channel was disposed");
    assert.equal(moved.host.livestreamCalls.length, 1, "exactly one fresh subscribe ran for the desired channel");
    moved.supervisor.shutdown();

    const closed = makeControllableLivestreamDouble({ state: "closed" });
    const ended = arrangeAdoption({ adopted: closed });

    await ended.supervisor.reconcile();

    assert.equal(closed.disposed, true, "the closed subscription was disposed");
    assert.equal(ended.host.livestreamCalls.length, 1, "exactly one fresh subscribe ran in its place");
    ended.supervisor.shutdown();
  });

  test("a first pass that throws disposes the adopted subscription", async () => {

    const adopted = makeControllableLivestreamDouble();
    const { host, supervisor } = arrangeAdoption({ adopted });

    host.selectSubstrateChannel = (): ChannelProfile => {

      throw new Error("the channel selection failed");
    };

    await supervisor.reconcile();

    assert.equal(adopted.disposed, true, "the pass's frame disposed the subscription the throwing pass never handed on");
    assert.equal(supervisor.buffer.isStarted, false, "the buffer stayed stopped");
  });

  test("a shutdown before the first pass disposes the adopted subscription", () => {

    const adopted = makeControllableLivestreamDouble();
    const { supervisor } = arrangeAdoption({ adopted });

    supervisor.shutdown();

    assert.equal(adopted.disposed, true, "the shutdown disposed the subscription no pass ever took");
  });
});

describe("the supervisor's audio-format narration at a buffer start", () => {

  const ADVERTISED = { channels: 1, codec: "aac", sampleRate: 16000 } as const;
  const RESTART_HINT = "restart HBUP to let HomeKit learn the new format";

  // A stream format carrying AAC at the given rate in one channel.
  const mono = (sampleRate: number): LivestreamAudioFormat => ({ channels: 1, codec: "aac", sampleRate });

  // A description carrying one audio track in the given format.
  const describedAs = (format: LivestreamAudioFormat): LivestreamDescription => ({ tracks: [{ ...format, id: 2, kind: "audio" }] });

  // A camera under the streaming arm's demand, with a recording arm unless a row withdraws it, whose controller was built with the given advertisement, the 16 kHz
  // mono one unless a row names another, and whose successive buffer starts run on subscriptions carrying the given stream formats in order.
  function arrangeNarration({ advertised = ADVERTISED, formats, recording = true }: { advertised?: LivestreamAudioFormat; formats: LivestreamAudioFormat[];
    recording?: boolean; }): { logEntries: readonly TestLogEntry[]; supervisor: ProtectTimeshiftSupervisor } {

    const { controller, host, logEntries } = makeTestCameraHost();

    controllers.push(controller);

    const stream = new TestStreamingDelegate();

    if(recording) {

      stream.hksv = makeRecordingDelegateDouble() as unknown as TestStreamingDelegate["hksv"];
    }

    host.stream = stream;
    host.selectSubstrateChannel = (): ChannelProfile => makeChannelProfile(host);
    host.usesTimeshiftLivestream = true;
    host.livestreamSubscriptions = formats.map((format) => makeControllableLivestreamDouble({ description: describedAs(format) }));

    return { logEntries, supervisor: new ProtectTimeshiftSupervisor(host, { adopt: null, advertised }) };
  }

  // Stop the running buffer, which asks for the re-establishing pass itself, and let that pass start the buffer on the next subscription.
  async function restart(supervisor: ProtectTimeshiftSupervisor): Promise<void> {

    supervisor.buffer.stop();
    await settle();
  }

  test("a start whose format differs logs the restart hint once, a restart on the same format logs nothing more, and a return to the advertised one resets it",
    async () => {

      const { logEntries, supervisor } = arrangeNarration({ formats: [ mono(8000), mono(8000), mono(16000), mono(8000) ] });

      await supervisor.reconcile();

      assert.equal(logCount(logEntries, "info", RESTART_HINT), 1, "the differing format was narrated once at the first start");
      assert.ok(logEntries.some((entry) => formatLogEntry(entry).includes("now 8 kHz mono, while HomeKit Secure Video records at 16 kHz mono")),
        "the line names the stream's format and the advertised one");

      await restart(supervisor);

      assert.equal(logCount(logEntries, "info", RESTART_HINT), 1, "a restart on the same differing format narrated nothing more");

      await restart(supervisor);

      assert.equal(logCount(logEntries, "info", RESTART_HINT), 1, "a restart back on the advertised format narrated nothing");

      await restart(supervisor);

      assert.equal(logCount(logEntries, "info", RESTART_HINT), 2, "the return to the advertised format reset the latch, so the next change is narrated again");

      supervisor.shutdown();
    });

  test("a start whose format matches the advertised one never logs the hint", async () => {

    const { logEntries, supervisor } = arrangeNarration({ formats: [ mono(16000), mono(16000) ] });

    await supervisor.reconcile();
    await restart(supervisor);

    assert.equal(logCount(logEntries, "info", RESTART_HINT), 0, "a matching format is never narrated");

    supervisor.shutdown();
  });

  // The hint compares the advertisement a restart would compute from the running stream against the one the controller was built with, so a stream that differs only
  // in what every advertisement normalizes away earns no hint. A stereo stream advertises its rate in one channel, so at the advertised rate a restart would tell
  // HomeKit exactly what it already holds.
  test("a stereo stream at the advertised rate never logs the hint", async () => {

    const stereo: LivestreamAudioFormat = { channels: 2, codec: "aac", sampleRate: 16000 };
    const { logEntries, supervisor } = arrangeNarration({ formats: [stereo] });

    await supervisor.reconcile();

    assert.deepEqual(supervisor.buffer.audioFormat, stereo, "the vacuity guard: the buffer runs on the stereo stream");
    assert.equal(logCount(logEntries, "info", RESTART_HINT), 0, "a stereo stream at the advertised rate is never narrated");

    supervisor.shutdown();
  });

  // An Opus stream advertises AAC-LC at its own rate in one channel, so a controller built from a 48 kHz Opus stream holds 48 kHz mono, and the same stream earns no
  // hint. The stream moving to a rate HomeKit has another recording member for is a change a restart would advertise, so it is said once.
  test("an Opus stream at the advertised rate never logs the hint, and the same stream moving to 8 kHz AAC logs it once", async () => {

    const opus: LivestreamAudioFormat = { channels: 1, codec: "opus", sampleRate: 48000 };
    const { logEntries, supervisor } = arrangeNarration({ advertised: mono(48000), formats: [ opus, mono(8000) ] });

    await supervisor.reconcile();

    assert.deepEqual(supervisor.buffer.audioFormat, opus, "the vacuity guard: the buffer runs on the Opus stream");
    assert.equal(logCount(logEntries, "info", RESTART_HINT), 0, "an Opus stream at the advertised rate is never narrated");

    await restart(supervisor);

    assert.equal(logCount(logEntries, "info", RESTART_HINT), 1, "the move to 8 kHz AAC was narrated once");
    assert.ok(logEntries.some((entry) => formatLogEntry(entry).includes("now 8 kHz mono, while HomeKit Secure Video records at 48 kHz mono.")),
      "the line names the stream's format and the advertisement HomeKit holds");

    supervisor.shutdown();
  });

  // A stream at a rate HomeKit has no recording member for advertises the whole stand-in, so against a controller built with the stand-in a restart would change
  // nothing and the stream earns no hint.
  test("a stream at a rate HomeKit cannot express never logs the hint against the stand-in", async () => {

    const { logEntries, supervisor } = arrangeNarration({ advertised: RECORDING_AUDIO_STAND_IN.format, formats: [mono(22050)] });

    await supervisor.reconcile();

    assert.deepEqual(supervisor.buffer.audioFormat, mono(22050), "the vacuity guard: the buffer runs on the 22050 Hz stream");
    assert.equal(logCount(logEntries, "info", RESTART_HINT), 0, "a stream whose rate HomeKit cannot express is never narrated against the stand-in");

    supervisor.shutdown();
  });

  // The hint speaks about HomeKit Secure Video, so a camera with no recording arm has nothing to narrate, even when its stream would earn another advertisement.
  test("a camera with no recording arm never logs the hint, though its stream differs from the advertised format", async () => {

    const { logEntries, supervisor } = arrangeNarration({ formats: [mono(8000)], recording: false });

    await supervisor.reconcile();

    assert.deepEqual(supervisor.buffer.audioFormat, mono(8000), "the vacuity guard: the buffer runs on a stream whose advertisement differs");
    assert.equal(logCount(logEntries, "info", RESTART_HINT), 0, "a camera with no recording arm is never narrated");

    supervisor.shutdown();
  });
});
