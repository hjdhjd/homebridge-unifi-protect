/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * nvr.test.ts: Unit tests for the controller root's pure decision logic - the startup-resilient connect retry policy, the request-outcome classifier, the
 * removal-stability arithmetic, the disruption-expectation gating (the classification, its induced and recency halves, and the episode-latch), the induced-reboot resume
 * decision, the scheduled-reboot arithmetic with the recording-count rule behind its deferral, and the address override rule - plus the NvrHealth connection-input
 * mapping those drive, and the real controller root's disabled-controller path, its stability sweep's liveviews pass, its connect retry, its address override, the
 * accessory cache saves its adoption asks for, the name it adds a camera under when the camera's own name sanitizes to nothing, and its removal of a package camera
 * whose parent is gone.
 *
 * ProtectNvr itself is a composition root: its constructor stands up the event handler and the controller logging, and it transitively owns the entire device and
 * media graph. The response is to keep the *decisions* it makes in a pure leaf module (nvr-policy.ts) and assert those here, exercising the controller's real
 * behavior (the connect retry's schedules and reports, request-outcome-to-symptom mapping) without mocking a client. The connect retry's schedules are walked through
 * HBPU's own retry on a test clock, so the rows read the waits the retry actually asked for. The connection-input mapping is verified against the real NvrHealth
 * with an injected clock, so the test proves both the mapping and the reducer/window behavior it feeds.
 *
 * The root's one external boundary is its connect port, so a path that is the root's own rather than a decision it delegates runs through the real root: it is built
 * over the controller double's platform with a client double answering the port, and the platform's shutdown registration is run at the end of each row so no
 * process-global diagnostics subscription outlives it.
 */
import { ACCESSORY_SAVE_WINDOW_MS, retry } from "homebridge-plugin-utils";
import { PROTECT_DEVICE_REMOVAL_DELAY_INTERVAL, PROTECT_NVR_REMOVAL_STABILITY_WINDOW } from "../settings.ts";
import { PROTECT_RECOVERY_BACKOFF_UNKNOWN_MS, PROTECT_RECOVERY_STEADY_INTERVAL_MS, ProtectAuthError } from "unifi-protect";
import type { ProtectCameraConfig, ProtectClient, ProtectNvrConfig } from "unifi-protect";
import { TEST_CLOCK_EPOCH, TestConnection, makeConnectedClient, makeNvrConfig, makeRootPlatform, makeTestNvr,
  restoreAccessories } from "./testing.helpers.ts";
import { TestClock, formatLogEntry, logCount, loggedAt, settle, settleUntil } from "homebridge-plugin-utils/testing";
import { TestStateStore, accessoryUuid, makeProtectState, makeTestAccessory } from "../testing.helpers.ts";
import { canTransition, classifyRebootAttempt, computeInitialRebootDelay, computeStableSince, countActiveRecordingViews, createConnectRetryPolicy,
  createLivestreamEpisodeLatch, isDisruptionExpected, isInducedDisruption, isRequestForController, isStabilityWindowElapsed, isSuccessfulRequest,
  isWithinRebootRecency, resolveOverrideAddress, shouldResumeFromInducedReboot } from "./nvr-policy.ts";
import { describe, test } from "node:test";
import { G2_PRO_CHANNELS } from "../camera.fixtures.ts";
import type { Nullable } from "homebridge-plugin-utils";
import { NvrHealth } from "./nvr-health.ts";
import type { NvrPhase } from "./nvr.ts";
import { ProtectCamera } from "../devices/cameras/camera.ts";
import { ProtectNvr } from "./nvr.ts";
import assert from "node:assert/strict";
import { makeCameraConfig } from "../devices/testing.helpers.ts";
import { once } from "node:events";

// The instant each health observer's test clock starts at, so the sliding window is driven by the test rather than wall time. Any nonzero epoch serves: the rows stamp
// every symptom from the same clock the observer reads, so only the window's arithmetic reaches an assertion.
const HEALTH_CLOCK_EPOCH = 1000000;

// A stand-in non-authentication fault. The retry policy branches solely on `error instanceof ProtectAuthError`, so any other error value exercises the non-auth path;
// a plain Error is the clearest representative of "network / transient".
const networkError = new Error("connection refused");

// A refused sign-in, in the library's authentication error, which is the class the retry policy reads a refusal by.
const refusalError = new ProtectAuthError("bad credentials");

// The wait between connect attempts while the controller refuses the sign-in, transcribed rather than read from the plugin's settings, so a schedule that drifts
// toward a pace that could lock the account reddens a row.
const REFUSAL_WAIT_MS = 5 * 60 * 1000;

/* Walk HBPU's retry over a fresh connect retry policy on a test clock: each attempt fails with the next of the given errors, and the attempt after the last of them
 * connects. Each pass lets the failed attempt reach the wait the retry asks the clock for, then steps the clock to that wait's deadline, so the run walks the
 * policy's schedules on virtual time as the controller root's retry walks them.
 *
 * @param failures - The error each attempt fails with, in attempt order.
 *
 * @returns Every wait the retry asked the clock for, in order, and every reason the policy reported.
 */
async function walkConnectRetry(failures: readonly Error[]): Promise<{ reports: string[]; waits: number[] }> {

  const clock = new TestClock();
  const reports: string[] = [];
  const { backoff, shouldRetry } = createConnectRetryPolicy({ onFailure: (reason: string): void => void reports.push(reason) });

  let attempt = 0;

  const run = retry(async (): Promise<string> => {

    const failure = failures[attempt++];

    if(failure) {

      throw failure;
    }

    return "connected";
  }, { attempts: Infinity, backoff, clock, shouldRetry });

  for(const [index] of failures.entries()) {

    // eslint-disable-next-line no-await-in-loop -- Each failed attempt has to reach its wait before the clock can step to that wait's deadline.
    await settleUntil(() => clock.pending > 0, { description: "the wait after failure " + (index + 1).toString() });
    clock.advanceToNext();
  }

  assert.equal(await run, "connected", "the attempt after the last failure connects, so the run ends on the controller accepting it");

  return { reports, waits: [...clock.requested] };
}

describe("connect retry policy", () => {

  test("a fault other than a refusal waits out the library's recovery schedule, then holds at its steady floor", async () => {

    // More than one failure past the last staged delay, so the floor is shown to hold rather than to be one more rung.
    const failures = Array.from({ length: PROTECT_RECOVERY_BACKOFF_UNKNOWN_MS.length + 2 }, () => networkError);

    assert.deepEqual((await walkConnectRetry(failures)).waits, [ ...PROTECT_RECOVERY_BACKOFF_UNKNOWN_MS, PROTECT_RECOVERY_STEADY_INTERVAL_MS,
      PROTECT_RECOVERY_STEADY_INTERVAL_MS ]);
  });

  test("a refused sign-in waits five minutes before every retry, however many times it is refused", async () => {

    // A run of refusals, so a policy that stopped retrying a refusal would end the walk rejected rather than connected.
    const failures = Array.from({ length: PROTECT_RECOVERY_BACKOFF_UNKNOWN_MS.length + 2 }, () => refusalError);

    assert.deepEqual((await walkConnectRetry(failures)).waits, failures.map(() => REFUSAL_WAIT_MS), "every retry after a refusal waits five minutes");
  });

  test("a change of class restarts the new class's schedule at its first rung, whichever way the class changes", async () => {

    const [ firstRecovery, secondRecovery, thirdRecovery ] = PROTECT_RECOVERY_BACKOFF_UNKNOWN_MS;

    /* A run of ordinary faults, then refusals, then ordinary faults again. The retry hands each wait its own attempt number, which counts the whole run, so a wait
     * that read it would land each change partway down the new schedule rather than on its first rung.
     */
    const { waits } = await walkConnectRetry([ networkError, networkError, networkError, refusalError, refusalError, networkError, networkError ]);

    assert.deepEqual(waits, [ firstRecovery, secondRecovery, thirdRecovery, REFUSAL_WAIT_MS, REFUSAL_WAIT_MS, firstRecovery, secondRecovery ]);
  });

  test("every class of fault is retried at every rung of its schedule, its steady floor included", () => {

    // More than one failure past the recovery schedule's last staged delay, so each class is asked about on its floor as well as on each of its rungs.
    const run = PROTECT_RECOVERY_BACKOFF_UNKNOWN_MS.length + 2;

    for(const failure of [ networkError, refusalError, new TypeError("Cannot read properties of undefined (reading 'nvr')") ]) {

      const { shouldRetry } = createConnectRetryPolicy();

      for(let attempt = 1; attempt <= run; attempt++) {

        assert.equal(shouldRetry(failure), true, "nothing gives up, so every failure of every class is retried");
      }
    }
  });

  test("a run reports its first failure, and a repeat of the same reason stays silent", async () => {

    /* Distinct error instances that read identically, which is the shape a refusal takes when each attempt throws afresh. A comparison by identity would report each
     * of them, and one that remembered nothing would too.
     */
    const { reports } = await walkConnectRetry(Array.from({ length: 3 }, () => new ProtectAuthError("bad credentials")));

    assert.deepEqual(reports, ["bad credentials"], "the run reports its reason once, as the text a user reads");

    // The same policy with no callback retries identically, so reporting is an addition to the verdict and never a change to it.
    assert.equal(createConnectRetryPolicy().shouldRetry(refusalError), true);
  });

  test("a run reports again whenever the reason changes, a return to an earlier reason included", async () => {

    /* An unreachable controller that starts refusing the sign-in, then becomes unreachable again. The return is what tells a comparison against the last reason
     * apart from one against every reason ever seen...the latter would stay silent when the first fault returns and hide from the user that the fault moved again.
     */
    const { reports } = await walkConnectRetry([ networkError, networkError, refusalError, refusalError, networkError ]);

    assert.deepEqual(reports, [ "connection refused", "bad credentials", "connection refused" ]);
  });
});

describe("the address override rule", () => {

  /* The option outranks the legacy per-controller property. An option that sets nothing - unset, turned off, or enabled with an empty value - leaves the answer to
   * the legacy property, so an emptied field never resolves the cameras against nothing, and with neither source configured there is no override at all.
   */
  test("the option outranks the legacy property, and an option that sets nothing leaves the answer to it", () => {

    assert.deepEqual(resolveOverrideAddress({ legacy: "legacy.example", option: "option.example" }), { address: "option.example", kind: "resolved" },
      "the option outranks the legacy property");

    for(const option of [ undefined, null, "" ]) {

      const label = "option " + JSON.stringify(option);

      assert.deepEqual(resolveOverrideAddress({ legacy: "legacy.example", option }), { address: "legacy.example", kind: "resolved" },
        label + ": the legacy property answers");
      assert.deepEqual(resolveOverrideAddress({ legacy: undefined, option }), { kind: "absent" }, label + ": with no legacy property there is no override");
    }
  });

  /* A plain IPv6 address resolves as it stands, bracketed only where a URL is composed from it. One carrying an IPv6 zone cannot stand in a URL, so it is refused,
   * naming the address, whichever source supplies it, and a refused option never falls through to the legacy property it outranks.
   */
  test("an address carrying an IPv6 zone is refused whichever source supplies it, and a plain IPv6 address resolves as it stands", () => {

    assert.deepEqual(resolveOverrideAddress({ legacy: undefined, option: "fd00::1" }), { address: "fd00::1", kind: "resolved" }, "a plain IPv6 address resolves");
    assert.deepEqual(resolveOverrideAddress({ legacy: "fe80::1%en0", option: null }), { address: "fe80::1%en0", kind: "refused" },
      "a zoned legacy property is refused");
    assert.deepEqual(resolveOverrideAddress({ legacy: "legacy.example", option: "fe80::1%en0" }), { address: "fe80::1%en0", kind: "refused" },
      "a zoned option is refused rather than falling through to the legacy property");
  });
});

describe("request-outcome classifier", () => {

  test("a 2xx response is a success", () => {

    assert.equal(isSuccessfulRequest({ statusCode: 200 }), true);
    assert.equal(isSuccessfulRequest({ statusCode: 299 }), true);
  });

  test("a non-2xx response is a failure", () => {

    assert.equal(isSuccessfulRequest({ statusCode: 401 }), false);
    assert.equal(isSuccessfulRequest({ statusCode: 500 }), false);
    assert.equal(isSuccessfulRequest({ statusCode: 199 }), false);
    assert.equal(isSuccessfulRequest({ statusCode: 300 }), false);
  });

  test("a transport-level error is a failure even absent a status", () => {

    assert.equal(isSuccessfulRequest({ error: "ECONNRESET" }), false);
    assert.equal(isSuccessfulRequest({ error: "timeout", statusCode: 200 }), false);
  });

  test("an absent status with no error is a failure", () => {

    assert.equal(isSuccessfulRequest({}), false);
  });
});

describe("NvrHealth connection-input mapping", () => {

  test("a run of request failures drives the controller degraded then stressed", () => {

    const clock = new TestClock(HEALTH_CLOCK_EPOCH);
    const health = new NvrHealth(clock);

    // Five weighted failures cross the degraded threshold; twelve cross stressed. The mapping under test is request-outcome -> apiError/apiSuccess symptom; the
    // thresholds and window are the unchanged reducer behavior this exercises end to end.
    for(let count = 0; count < 5; count++) {

      health.observe({ at: clock.now(), kind: "apiError" });
    }

    assert.equal(health.state, "degraded");

    for(let count = 0; count < 7; count++) {

      health.observe({ at: clock.now(), kind: "apiError" });
    }

    assert.equal(health.state, "stressed");
  });

  test("request successes count as recovery evidence against failures", () => {

    const clock = new TestClock(HEALTH_CLOCK_EPOCH);
    const health = new NvrHealth(clock);

    // Drive to degraded, then feed successes: the weighted count falls below the release bound and the controller returns to healthy. This pins that a 2xx maps to
    // apiSuccess (recovery), the counterpart of the failure mapping.
    for(let count = 0; count < 6; count++) {

      health.observe({ at: clock.now(), kind: "apiError" });
    }

    assert.equal(health.state, "degraded");

    for(let count = 0; count < 6; count++) {

      health.observe({ at: clock.now(), kind: "apiSuccess" });
    }

    assert.equal(health.state, "healthy");
  });

  test("a library throttle latches stressed, and release alone does not auto-recover", () => {

    const clock = new TestClock(HEALTH_CLOCK_EPOCH);
    const health = new NvrHealth(clock);

    // throttleEntered maps to the libraryThrottleEntered symptom, which short-circuits to stressed regardless of the symptom count.
    health.observe({ at: clock.now(), kind: "libraryThrottleEntered" });
    assert.equal(health.state, "stressed");

    // throttleExited releases the latch but, by NvrHealth's documented contract, does NOT itself reset the state - recovery waits for organic improvement (success
    // events accumulating in the window), not the mere release. So after release the state steps down one level to degraded, not all the way to healthy.
    health.observe({ at: clock.now(), kind: "libraryThrottleReleased" });
    assert.equal(health.state, "degraded");

    // Organic recovery: a run of successes drives the weighted count below the release bound and returns the controller to healthy. This is the throttle-released-then-
    // recovered path the connection rails feed end to end.
    for(let count = 0; count < 4; count++) {

      health.observe({ at: clock.now(), kind: "apiSuccess" });
    }

    assert.equal(health.state, "healthy");
  });
});

describe("removal stability arithmetic", () => {

  // The stability window the production gate uses, restated here as a plain literal so these clock-free cases read independently of the settings constant.
  const windowMs = 600000;
  const nowMs = 1000000;

  test("a long-up controller at first good-state is trusted immediately", () => {

    // First good-state entry (hasStabilizedBefore false) with an uptime well past the window: the backdate clamps to exactly one window, so the window has already
    // elapsed at now and a removal is permitted right away.
    const stableSinceMs = computeStableSince({ hasStabilizedBefore: false, nowMs, uptimeMs: windowMs + 500000, windowMs });

    assert.equal(stableSinceMs, nowMs - windowMs);
    assert.equal(isStabilityWindowElapsed({ nowMs, stableSinceMs, windowMs }), true);
  });

  test("a short-up controller at first good-state must still wait out the remainder", () => {

    // First good-state entry with an uptime shorter than the window: the backdate counts from boot, so the gate stays closed now and opens only once the full window has
    // elapsed since boot (now + the uncovered remainder).
    const uptimeMs = 180000;
    const stableSinceMs = computeStableSince({ hasStabilizedBefore: false, nowMs, uptimeMs, windowMs });

    assert.equal(stableSinceMs, nowMs - uptimeMs);
    assert.equal(isStabilityWindowElapsed({ nowMs, stableSinceMs, windowMs }), false);
    assert.equal(isStabilityWindowElapsed({ nowMs: stableSinceMs + windowMs, stableSinceMs, windowMs }), true);
  });

  test("a recovery counts from now and ignores uptime", () => {

    // A later good-state entry (hasStabilizedBefore true) always counts from now regardless of how long the controller process has been up - a disruption we observed
    // resets our trust - so even a huge uptime leaves the gate closed until a fresh full window elapses.
    const stableSinceMs = computeStableSince({ hasStabilizedBefore: true, nowMs, uptimeMs: windowMs * 10, windowMs });

    assert.equal(stableSinceMs, nowMs);
    assert.equal(isStabilityWindowElapsed({ nowMs, stableSinceMs, windowMs }), false);
  });

  test("the window is elapsed at exactly the boundary", () => {

    // The gate is a >= comparison, so the instant the elapsed time equals the window the controller is stable; one millisecond before it is not.
    assert.equal(isStabilityWindowElapsed({ nowMs, stableSinceMs: nowMs - windowMs, windowMs }), true);
    assert.equal(isStabilityWindowElapsed({ nowMs, stableSinceMs: nowMs - windowMs + 1, windowMs }), false);
  });

  test("a null stable-since is never elapsed", () => {

    // Null means the controller is not currently good (mid-disruption), so the gate is closed no matter the window.
    assert.equal(isStabilityWindowElapsed({ nowMs, stableSinceMs: null, windowMs }), false);
  });
});

describe("livestream disruption gating", () => {

  // The induced predicate the livestream-subsystem sites share. We pin every phase so a wrong set is caught - including a `!== "running"` flip that would fold
  // `connecting` into the induced set and silence a startup/reconnection disruption the operator should see.
  test("isInducedDisruption is true only for the induced phases", () => {

    assert.equal(isInducedDisruption("running"), false);
    assert.equal(isInducedDisruption("connecting"), false);
    assert.equal(isInducedDisruption("rebooting"), true);
    assert.equal(isInducedDisruption("shuttingDown"), true);
  });

  // The recency half of the per-camera quiet gate - the second predicate the interruption edge ORs together. A blip inside the window of an observed reboot is that
  // reboot's tail (quiet); at or past the window, or with no reboot observed this process, it is a genuine drop (loud). The comparison is strict-less-than, so the
  // window boundary is pinned on BOTH sides. The null case pairs with a SMALL nowMs so a mutant dropping the `!== null` guard would compute 0 - null === 0 < window and
  // flip the case to true - the guard genuinely matters here rather than being masked by a large nowMs.
  test("isWithinRebootRecency is true only within the window of an observed reboot", () => {

    const windowMs = 60000;
    const lastRebootMs = 1000;

    // Observed well within the window: quiet.
    assert.equal(isWithinRebootRecency({ lastRebootMs, nowMs: lastRebootMs + 1, windowMs }), true);

    // The window boundary, both sides: one millisecond short is still within (<), exactly the window is out (the comparison is strict-less-than).
    assert.equal(isWithinRebootRecency({ lastRebootMs, nowMs: lastRebootMs + windowMs - 1, windowMs }), true);
    assert.equal(isWithinRebootRecency({ lastRebootMs, nowMs: lastRebootMs + windowMs, windowMs }), false);

    // Comfortably past the window: loud.
    assert.equal(isWithinRebootRecency({ lastRebootMs, nowMs: lastRebootMs + windowMs + 5000, windowMs }), false);

    // No reboot observed this process. The small nowMs means removing the null guard would compute 0 - null < window and wrongly read as within-window.
    assert.equal(isWithinRebootRecency({ lastRebootMs: null, nowMs: 0, windowMs }), false);
  });

  // The composed classification every disruption-facing narration consults. The cells cover each way an answer can arise: the induced half standing alone (no reboot has
  // ever been observed, so only the phase can answer yes), the settling-tail half standing alone (a controller already back to running), and the two ways the answer is
  // no - the window elapsed, and no reboot observed at all. A mutant dropping either half fails a cell.
  test("isDisruptionExpected is true for an induced phase or an observed reboot's settling tail", () => {

    const windowMs = 60000;
    const lastRebootMs = 1000;

    // The induced half alone: no reboot observed this process, so the phase is the only thing that can classify this as expected.
    assert.equal(isDisruptionExpected({ lastRebootMs: null, nowMs: 0, phase: "rebooting", windowMs }), true);

    // The settling-tail half alone: the plugin has concluded the reboot and returned to running, and the blip lands inside the observed reboot's window.
    assert.equal(isDisruptionExpected({ lastRebootMs, nowMs: lastRebootMs + 1, phase: "running", windowMs }), true);

    // A running controller with the window elapsed - a genuine single-camera drop, and the reason the tail half is a window rather than a permanent quieting.
    assert.equal(isDisruptionExpected({ lastRebootMs, nowMs: lastRebootMs + windowMs, phase: "running", windowMs }), false);

    // A running controller with no reboot observed this process: nothing makes this disruption expected.
    assert.equal(isDisruptionExpected({ lastRebootMs: null, nowMs: 0, phase: "running", windowMs }), false);
  });

  // The core latch protocol: the recovery edge reads the quiet/loud classification the interruption edge recorded, and the read drains the slot so a re-used key cannot
  // leak a prior episode's classification into a later one.
  test("the latch returns the recorded classification and drains on consume", () => {

    const latch = createLivestreamEpisodeLatch();

    latch.record("key1", "camA", true);
    assert.equal(latch.consume("key1"), true);

    // The first consume drained the slot, so a second consume of the same key sees no entry and defaults to the loud, genuine-drop level.
    assert.equal(latch.consume("key1"), false);
  });

  // An unrecorded key (a recovery with no matching interruption, e.g. a foreign controller's key our guard never recorded) defaults to the loud level, and an explicitly
  // loud classification round-trips as loud too.
  test("the latch defaults an unrecorded key to loud", () => {

    const latch = createLivestreamEpisodeLatch();

    assert.equal(latch.consume("absent"), false);

    latch.record("key1", "camA", false);
    assert.equal(latch.consume("key1"), false);
  });

  // A single camera can run concurrent livestream sessions under distinct pool keys (e.g. an HKSV record channel and a Home-app live view on another lens). Per-key
  // keying gives each session its own slot, so the second-and-later recoveries during a reboot read their own classification rather than aliasing onto a shared cameraId
  // slot.
  test("the latch isolates concurrent sessions of one camera by key", () => {

    const latch = createLivestreamEpisodeLatch();

    latch.record("camA:0", "camA", true);
    latch.record("camA:1", "camA", false);

    assert.equal(latch.consume("camA:0"), true);
    assert.equal(latch.consume("camA:1"), false);
  });

  // forgetCamera reclaims every entry for the named camera (the removal-chokepoint cleanup that prevents a started-but-never-recovered episode from leaking) and leaves
  // other cameras' entries untouched.
  test("forgetCamera reclaims only the named camera's entries", () => {

    const latch = createLivestreamEpisodeLatch();

    latch.record("camA:0", "camA", true);
    latch.record("camB:0", "camB", true);

    latch.forgetCamera("camA");

    assert.equal(latch.consume("camA:0"), false);
    assert.equal(latch.consume("camB:0"), true);
  });

  // A re-used key records over the prior slot, so a recovery reads the current episode's classification, never a stale one from a prior episode sharing the same key.
  test("recording a key overwrites a stale classification for that key", () => {

    const latch = createLivestreamEpisodeLatch();

    latch.record("camA:0", "camA", true);
    latch.record("camA:0", "camA", false);

    assert.equal(latch.consume("camA:0"), false);
  });
});

describe("induced-reboot resume decision", () => {

  // The recovery-edge predicate that concludes an induced reboot. The true case is a recovery edge while rebooting - the connection arriving at healthy from a
  // non-healthy state. Each false case deviates from that true case in exactly ONE conjunct, so a mutation that drops any conjunct fails at least one assertion: the
  // entry-healthy guard (from: "healthy"), the destination check (to: "degraded"), and the induced-phase gate across the other phases (running / connecting /
  // shuttingDown), including connecting so a startup edge never resumes.
  test("shouldResumeFromInducedReboot is true only on a recovery edge while rebooting", () => {

    // A genuine drop-and-recovery while we induced the reboot: resume.
    assert.equal(shouldResumeFromInducedReboot({ from: "reconnecting", phase: "rebooting", to: "healthy" }), true);

    // Single-conjunct deviations from the true case, each false.
    assert.equal(shouldResumeFromInducedReboot({ from: "healthy", phase: "rebooting", to: "healthy" }), false);
    assert.equal(shouldResumeFromInducedReboot({ from: "reconnecting", phase: "rebooting", to: "degraded" }), false);
    assert.equal(shouldResumeFromInducedReboot({ from: "reconnecting", phase: "running", to: "healthy" }), false);
    assert.equal(shouldResumeFromInducedReboot({ from: "reconnecting", phase: "connecting", to: "healthy" }), false);
    assert.equal(shouldResumeFromInducedReboot({ from: "reconnecting", phase: "shuttingDown", to: "healthy" }), false);
  });
});

describe("phase transition legality", () => {

  // canTransition owns every refusal the NVR's transition chokepoint honors: a same-phase change (a no-op), and any change out of the terminal
  // "shuttingDown". The same-phase rows and the shuttingDown-exit rows are false; every ordinary lifecycle change is legal, and entering "shuttingDown" from any
  // phase is legal. The shuttingDown-exit rows are precisely what a same-phase-only guard - the rule before the terminal one-way clause - would wrongly permit.
  test("canTransition refuses same-phase changes and any exit from shuttingDown", () => {

    const phases: NvrPhase[] = [ "connecting", "rebooting", "running", "shuttingDown" ];

    // A same-phase change is always a no-op, for every phase.
    for(const phase of phases) {

      assert.equal(canTransition({ from: phase, to: phase }), false);
    }

    // Leaving the terminal shutdown phase is refused for every destination.
    assert.equal(canTransition({ from: "shuttingDown", to: "connecting" }), false);
    assert.equal(canTransition({ from: "shuttingDown", to: "rebooting" }), false);
    assert.equal(canTransition({ from: "shuttingDown", to: "running" }), false);

    // The ordinary lifecycle changes are legal.
    assert.equal(canTransition({ from: "running", to: "rebooting" }), true);
    assert.equal(canTransition({ from: "rebooting", to: "running" }), true);
    assert.equal(canTransition({ from: "connecting", to: "running" }), true);

    // Entering shuttingDown from any other phase is always legal - the terminal phase is a one-way door that anyone may walk through.
    assert.equal(canTransition({ from: "connecting", to: "shuttingDown" }), true);
    assert.equal(canTransition({ from: "rebooting", to: "shuttingDown" }), true);
    assert.equal(canTransition({ from: "running", to: "shuttingDown" }), true);
  });
});

describe("controller request-host filter", () => {

  // The process-global HTTP diagnostics channel carries every client's requests, so each NVR keeps only its own by an EXACT string match of the payload's reported host
  // against its configured address - both descend from the one address this NVR passed to ProtectClient.connect(). The cross-contamination row is the one a substring
  // test gets wrong: "192.168.1.2" is a substring of "192.168.1.20", so a .includes() filter let a controller observe a neighbor's requests. The remaining rows pin the
  // exact-identity contract: a hostname prefix does not match, a mixed-case address matches only itself verbatim, a bare IPv6 literal does not match a bracketed form, a
  // ported address attributes as-is, and any non-URL host string attributes only when the configured address is that same string.
  test("isRequestForController matches only the exact configured host", () => {

    // The controller's own request counts.
    assert.equal(isRequestForController({ address: "192.168.1.2", host: "192.168.1.2" }), true);

    // The cross-contamination case: a neighbor whose host merely contains ours must not match.
    assert.equal(isRequestForController({ address: "192.168.1.2", host: "192.168.1.20" }), false);

    // A configured address that is a prefix of the reported host does not match - equality, not containment.
    assert.equal(isRequestForController({ address: "controller", host: "controller.example.com" }), false);

    // A mixed-case address matches its own verbatim host, and does NOT match a lowercased variant (a different controller's string) - exact identity, no case folding.
    assert.equal(isRequestForController({ address: "Controller.Local", host: "Controller.Local" }), true);
    assert.equal(isRequestForController({ address: "Controller.Local", host: "controller.local" }), false);

    // A bare IPv6 literal matches a bare literal and NOT a bracketed form - the payload carries the exact configured address, so no bracket normalization applies.
    assert.equal(isRequestForController({ address: "fe80::1", host: "fe80::1" }), true);
    assert.equal(isRequestForController({ address: "fe80::1", host: "[fe80::1]" }), false);

    // Exact identity keeps the port significant: a bare-host request does NOT match a ported configured address.
    assert.equal(isRequestForController({ address: "192.168.1.2:7443", host: "192.168.1.2" }), false);

    // A non-URL host string attributes only when the configured address is that same string.
    assert.equal(isRequestForController({ address: "notaurl", host: "notaurl" }), true);
    assert.equal(isRequestForController({ address: "192.168.1.2", host: "notaurl" }), false);

    // A ported address attributes to itself - the port is part of the exact identity.
    assert.equal(isRequestForController({ address: "1.2.3.4:8443", host: "1.2.3.4:8443" }), true);

    // Two controllers on one host at different ports stay distinct - the port is part of the exact identity.
    assert.equal(isRequestForController({ address: "1.2.3.4:8443", host: "1.2.3.4:9443" }), false);
  });
});

describe("scheduled-reboot arithmetic", () => {

  // The three-way decision a reboot attempt acts on. The ceiling comparison is strict-less-than, so the boundary is pinned on both sides: one millisecond short still
  // defers, exactly at the ceiling forces. The zero-recordings rows carry an elapsed time well past the ceiling, so a mutant that consulted the ceiling before the
  // recording count would answer "force" there and fail rather than passing by coincidence.
  test("classifyRebootAttempt defers only while recordings are active and the ceiling has headroom left", () => {

    const ceilingMs = 900000;

    // Nothing is recording, so the attempt proceeds however long the cycle has been running.
    assert.equal(classifyRebootAttempt({ activeRecordings: 0, ceilingMs, elapsedCycleMs: 0 }), "proceed");
    assert.equal(classifyRebootAttempt({ activeRecordings: 0, ceilingMs, elapsedCycleMs: ceilingMs + 60000 }), "proceed");

    // Recordings in flight with ceiling headroom left: hold the reboot back.
    assert.equal(classifyRebootAttempt({ activeRecordings: 1, ceilingMs, elapsedCycleMs: 0 }), "defer");
    assert.equal(classifyRebootAttempt({ activeRecordings: 3, ceilingMs, elapsedCycleMs: ceilingMs - 1 }), "defer");

    // At the ceiling and past it, an active recording does not earn a deferral.
    assert.equal(classifyRebootAttempt({ activeRecordings: 1, ceilingMs, elapsedCycleMs: ceilingMs }), "force");
    assert.equal(classifyRebootAttempt({ activeRecordings: 1, ceilingMs, elapsedCycleMs: ceilingMs + 60000 }), "force");
  });

  // The first fire's delay, anchored to the controller's own uptime so restarting the plugin does not reset the cadence. The zero-upSince row is the one a plain
  // subtraction gets wrong: it would treat the epoch as a boot time and compute a delay tens of thousands of hours in the past, flooring every fresh install at a
  // minute rather than the configured interval.
  test("computeInitialRebootDelay anchors the first fire to the controller's uptime", () => {

    const intervalMs = 6 * 60 * 60 * 1000;
    const nowMs = 1700000000000;

    // A controller that has only just booted waits the whole interval.
    assert.equal(computeInitialRebootDelay({ intervalMs, nowMs, upSince: nowMs }), intervalMs);

    // No boot time reported reads as no backdate at all, so the wait is the full interval.
    assert.equal(computeInitialRebootDelay({ intervalMs, nowMs, upSince: 0 }), intervalMs);

    // Uptime consumes the interval, and what remains of it is the wait.
    assert.equal(computeInitialRebootDelay({ intervalMs, nowMs, upSince: nowMs - (2 * 60 * 60 * 1000) }), 4 * 60 * 60 * 1000);

    // A controller up longer than the interval does not reboot the instant we connect - the floor leaves it a minute to settle first.
    assert.equal(computeInitialRebootDelay({ intervalMs, nowMs, upSince: nowMs - (2 * intervalMs) }), 60000);
  });
});

describe("the active-recording count", () => {

  // The counting rule the scheduled-reboot deferral rests on, shared by every caller that has its own population to walk. The mixed row carries both shapes of absence
  // the real callers present - a camera that never acquired a streaming arm, and a view whose object carries no streaming member at all - so a rule that dropped
  // either optional hop would throw here rather than answer false.
  test("countActiveRecordingViews counts the transmitting views and nothing else", () => {

    assert.equal(countActiveRecordingViews([]), 0);

    assert.equal(countActiveRecordingViews([ { streaming: { isRecordingTransmitting: true } }, { streaming: { isRecordingTransmitting: false } }, { streaming: null },
      {} ]), 1);

    assert.equal(countActiveRecordingViews([ { streaming: { isRecordingTransmitting: true } }, { streaming: { isRecordingTransmitting: true } } ]), 2);
  });
});

describe("the controller root's disabled-controller path", () => {

  /* A controller the user disabled in HomeKit at its own scope connects, removes every accessory it owns, and then lets go of its console session. The client double
   * records its dispose and whether this controller's accessories were already gone when it ran, so the order is part of the assertion: a dispose ahead of the sweep
   * would leave the sweep reading a disposed client. What a live client would go on delivering to a root still wired to it - the library entering its throttle, which
   * the health bridge narrates at warn, and the controller dropping off and coming back - is then delivered through the connection, and nothing may be logged.
   */
  test("a controller disabled in HomeKit disconnects from the Protect controller after removing its accessories", async () => {

    const nvrConfig: ProtectNvrConfig = { ...makeNvrConfig(), firmwareVersion: "4.3.6", version: "6.1.79" };
    const store = new TestStateStore(makeProtectState({ nvr: nvrConfig }));
    const { controller, logEntries, nvr: double } = makeTestNvr({ store, userOptions: ["Disable.Device." + nvrConfig.mac] });
    const connection = new TestConnection();
    const disposals: boolean[] = [];

    // A cached camera and a cached liveview switch this controller owns, one for each of the disabled path's removal loops.
    const camera = makeTestAccessory("Test Camera", "74ACB9000001");
    const liveview = makeTestAccessory("Test Liveview", nvrConfig.mac + ".Liveview.TEST");

    camera.context = { mac: "74ACB9000001", nvr: nvrConfig.mac };
    liveview.context = { liveview: "Test", nvr: nvrConfig.mac };
    restoreAccessories(double, [ camera, liveview ]);

    const client = {

      [Symbol.asyncDispose]: async (): Promise<void> => {

        disposals.push(!double.platform.accessories.some((accessory) => accessory.context.nvr === nvrConfig.mac));
      },
      connection: connection,
      controllerName: "Test Controller",
      nvr: { config: nvrConfig },
      state: store
    };

    const { platform, shutdown } = makeRootPlatform(double);
    const root = new ProtectNvr(platform, double.config, async (): Promise<ProtectClient> => client as unknown as ProtectClient);

    try {

      await root.login();

      assert.ok(loggedAt(logEntries, "info", "Disabling this UniFi Protect controller in HomeKit."), "the controller took its disabled path");
      assert.deepEqual(disposals, [true], "the client was disposed once, after every accessory this controller owns was removed");
      assert.equal(connection.listenerCount, 0, "no connection subscription outlives the client");

      const settled = logEntries.length;

      connection.emit("throttleEntered");
      connection.emit("controllerLost");
      connection.emit("controllerRebooted");

      await settle();

      assert.deepEqual(logEntries.slice(settled).map(formatLogEntry), [], "nothing is logged after the sweep");
    } finally {

      shutdown();
      controller.abort();

      await settle();
    }
  });
});

describe("the controller root's stability sweep", () => {

  /* A controller that boots as the plugin starts is unsettled at login, so the removal gate refuses what the startup liveviews reconcile asks for: the removal of a
   * security system accessory Homebridge restored from its cache after its liveviews were deleted while the plugin was down. Nothing else asks again, because the
   * liveviews only change when the user edits them. The root's stability sweep runs once the stability window has passed, and its liveviews pass schedules the
   * removal, which lands when the removal delay ends. The clock stops a millisecond short of the window first, so a removal scheduled before the sweep reddens the row.
   */
  test("a security system left by liveviews deleted while the plugin was down is removed by the stability sweep's liveviews pass", async () => {

    const clock = new TestClock(TEST_CLOCK_EPOCH);
    const nvrConfig: ProtectNvrConfig = { ...makeNvrConfig(), firmwareVersion: "4.3.6", upSince: clock.now(), version: "6.1.79" };
    const store = new TestStateStore(makeProtectState({ nvr: nvrConfig }));
    const { api, controller, logEntries, nvr: double } = makeTestNvr({ clock, store });
    const ghost = makeTestAccessory("Security System", nvrConfig.mac + ".Security");

    ghost.context = { liveviewDerived: true, nvr: nvrConfig.mac };
    restoreAccessories(double, [ghost]);

    // The client a connected controller reads, whose store holds no liveview at all.
    const client = makeConnectedClient({ nvrConfig, store });
    const { platform, shutdown } = makeRootPlatform(double);
    const root = new ProtectNvr(platform, double.config, async (): Promise<ProtectClient> => client);
    const removalReason = "No plugin-specific liveviews found. Disabling the security system accessory associated with this UniFi Protect controller.";

    try {

      await root.login();
      await settle();

      assert.ok(loggedAt(logEntries, "info", "Connected to nvr.test (UniFi Protect 6.1.79 running on UniFi OS 4.3.6)."),
        "the controller connected and took its enabled path");

      clock.advance(PROTECT_NVR_REMOVAL_STABILITY_WINDOW - 1);

      assert.ok(double.platform.accessories.includes(ghost), "the security system stays while the controller settles");
      assert.equal(loggedAt(logEntries, "info", removalReason), false, "and the startup reconcile's removal was refused");

      clock.advance(1);

      assert.ok(loggedAt(logEntries, "info", removalReason), "the stability sweep's liveviews pass scheduled the removal");
      assert.ok(double.platform.accessories.includes(ghost), "the security system stays through the removal delay");

      clock.advance(PROTECT_DEVICE_REMOVAL_DELAY_INTERVAL * 1000);

      assert.equal(double.platform.accessories.includes(ghost), false, "the security system left when the removal delay ended");
      assert.ok(api.calls.some((call) => (call.kind === "unregister") && call.accessories.includes(ghost)), "and it was unregistered from HomeKit");

      shutdown();

      await settle();

      assert.equal(store.observerCount, 0, "every observe loop the root started ended with its shutdown");
    } finally {

      shutdown();
      controller.abort();

      await settle();
    }
  });
});

describe("the controller root's connect retry", () => {

  /* A controller that refuses the configured sign-in at startup is retried for as long as the plugin runs, five minutes between attempts, and the user is told why
   * once rather than on every attempt. The connect port refuses every attempt and records the platform clock's time at each, so the spacing is read from the
   * attempts themselves, and the clock stops a millisecond short of each wait first, so a retry that came early reddens the row. The run is walked to its fourth
   * attempt, which a policy that stopped retrying after a few refusals would never reach. That attempt is still in flight when the plugin shuts down, and fails with
   * the abort it is handed, as a sign-in torn down mid-request does. Shutdown is the only end of the run, and an orderly one: the login returns and the aborted
   * attempt is not reported.
   */
  test("a refused sign-in is reported once at error and retried five minutes apart until shutdown ends the run", async () => {

    const { clock, controller, logEntries, nvr: double } = makeTestNvr({ store: new TestStateStore(makeProtectState({ nvr: makeNvrConfig() })) });
    const attempts: number[] = [];
    const { platform, shutdown } = makeRootPlatform(double);
    const root = new ProtectNvr(platform, double.config, async ({ signal }): Promise<ProtectClient> => {

      attempts.push(clock.now());

      if((attempts.length === 4) && signal) {

        await once(signal, "abort");

        signal.throwIfAborted();
      }

      throw refusalError;
    });

    try {

      const login = root.login();

      await settleUntil(() => attempts.length === 1, { description: "the first sign-in attempt" });

      for(let attempt = 2; attempt <= 4; attempt++) {

        clock.advance(REFUSAL_WAIT_MS - 1);

        // eslint-disable-next-line no-await-in-loop -- Each step reads the attempts the previous one let run, so the steps are serial by intent.
        await settle();

        assert.equal(attempts.length, attempt - 1, "no attempt runs before five minutes have passed since the last refusal");

        clock.advance(1);

        // eslint-disable-next-line no-await-in-loop -- Each step reads the attempts the previous one let run, so the steps are serial by intent.
        await settleUntil(() => attempts.length === attempt, { description: "sign-in attempt " + attempt.toString() });
      }

      assert.deepEqual(attempts.map((at) => at - (attempts[0] ?? 0)), [ 0, REFUSAL_WAIT_MS, 2 * REFUSAL_WAIT_MS, 3 * REFUSAL_WAIT_MS ],
        "each attempt after a refusal runs five minutes after the one before it");
      assert.equal(logCount(logEntries, "error", "Unable to connect to the Protect controller, and will keep trying: bad credentials."), 1,
        "the refusal is reported once at error, and its repeats are not");

      const reported = logEntries.length;

      shutdown();

      await login;

      assert.equal(attempts.length, 4, "shutdown ends the run without another attempt");
      assert.deepEqual(logEntries.slice(reported).filter((entry) => entry.level === "error").map(formatLogEntry), [],
        "and the attempt the shutdown aborted is not reported, so the run ends with nothing at error");
    } finally {

      shutdown();
      controller.abort();

      await settle();
    }
  });
});

describe("the controller root's address override", () => {

  /* The address the cameras' RTSP URLs are composed against when the user overrides it, resolved by the real root as it logs in: the option outranks the legacy
   * property, an option enabled but left empty falls through to that property, and a plain IPv6 address is kept for the URL composition to bracket. An address carrying
   * an IPv6 zone cannot stand in a URL, so it is set aside with one warning naming it, and the cameras fall through to the address the controller reports for each of
   * them, never to the legacy property an option outranks. The root is read twice after its login, and neither read may move the answer or say the warning again. The
   * controller double resolves the override through the same rule as it is built, and warns on its own, so each case counts only the lines logged after that.
   */
  test("the override address is resolved once at login, and one carrying an IPv6 zone is set aside with one warning", async () => {

    const zoneWarning = "The override address fe80::1%en0 carries an IPv6 zone, which a camera stream address cannot include. Cameras on this controller will use the " +
      "address the controller reports for each of them instead.";
    const cases: { expected: Nullable<string>; legacy?: string; option?: string; warnings: number }[] = [

      { expected: null, warnings: 0 },
      { expected: "option.example", legacy: "legacy.example", option: "option.example", warnings: 0 },
      { expected: "legacy.example", legacy: "legacy.example", option: "", warnings: 0 },
      { expected: "fd00::1", option: "fd00::1", warnings: 0 },
      { expected: null, legacy: "fe80::1%en0", warnings: 1 },
      { expected: null, legacy: "legacy.example", option: "fe80::1%en0", warnings: 1 }
    ];

    for(const { expected, legacy, option, warnings } of cases) {

      const label = "option " + (option ?? "absent") + ", legacy property " + (legacy ?? "absent");
      const clock = new TestClock(TEST_CLOCK_EPOCH);
      const nvrConfig: ProtectNvrConfig = { ...makeNvrConfig(), firmwareVersion: "4.3.6", upSince: clock.now(), version: "6.1.79" };
      const store = new TestStateStore(makeProtectState({ nvr: nvrConfig }));
      const { controller, logEntries, nvr: double } = makeTestNvr({ clock, ...((legacy !== undefined) ? { overrideAddress: legacy } : {}), store,
        userOptions: (option !== undefined) ? ["Enable.Nvr.OverrideAddress." + nvrConfig.mac + "=" + option] : [] });
      const built = logEntries.length;
      const client = makeConnectedClient({ nvrConfig, store });
      const { platform, shutdown } = makeRootPlatform(double);
      const root = new ProtectNvr(platform, double.config, async (): Promise<ProtectClient> => client);

      try {

        // eslint-disable-next-line no-await-in-loop -- Each case logs in a root of its own and ends its run before the next case builds one.
        await root.login();

        assert.equal(root.overrideAddress, expected, label + ": the override the cameras resolve against");
        assert.equal(root.overrideAddress, expected, label + ": a second read gives the same answer");
        assert.equal(logCount(logEntries.slice(built), "warn", zoneWarning), warnings, label + ": the warning is said once for a zoned address, and never otherwise");

        shutdown();

        // eslint-disable-next-line no-await-in-loop -- Each case logs in a root of its own and ends its run before the next case builds one.
        await settle();

        assert.equal(store.observerCount, 0, label + ": every observe loop the root started ended with its shutdown");
      } finally {

        shutdown();
        controller.abort();

        // eslint-disable-next-line no-await-in-loop -- Each case logs in a root of its own and ends its run before the next case builds one.
        await settle();
      }
    }
  });

  /* Each camera bakes its RTSP URLs into its channel profiles as it is built, so the root resolves the override before it adopts any camera. A root whose store carries
   * one camera and whose configuration carries an override logs in, and the camera's channel profiles compose against the override rather than against the camera's
   * connection host, which a resolution made only after the device observers start would leave them composed against.
   */
  test("the override address is resolved before the cameras are adopted, so a camera's channel profiles compose against it", async () => {

    const clock = new TestClock(TEST_CLOCK_EPOCH);
    const nvrConfig: ProtectNvrConfig = { ...makeNvrConfig(), firmwareVersion: "4.3.6", upSince: clock.now(), version: "6.1.79" };

    // The camera record carries what the root's membership reconcile reads before it constructs a camera, its category and its adoption by this controller, on top of
    // the construction read set makeCameraConfig builds.
    const cameraConfig: ProtectCameraConfig = { ...makeCameraConfig({ channels: G2_PRO_CHANNELS }), isAdopted: true, isAdoptedByOther: false, modelKey: "camera" };
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig], nvr: nvrConfig }));
    const { controller, nvr: double } = makeTestNvr({ clock, overrideAddress: "override.example", store });
    const client = makeConnectedClient({ nvrConfig, store });
    const { platform, shutdown } = makeRootPlatform(double);
    const root = new ProtectNvr(platform, double.config, async (): Promise<ProtectClient> => client);

    try {

      await root.login();
      await settle();

      const camera = root.getDeviceById(cameraConfig.id);

      assert.ok(camera instanceof ProtectCamera, "the root adopted the camera its store carries");
      assert.match(camera.selectChannel(1920, 1080)?.url ?? "", /^rtsps:\/\/override\.example:7441\/alias\d\?enableSrtp$/,
        "the camera's channel profiles compose against the override, not its connection host");

      shutdown();

      await settle();

      assert.equal(store.observerCount, 0, "every observe loop the root and its camera started ended with its shutdown");
    } finally {

      shutdown();
      controller.abort();

      await settle();
    }
  });
});

describe("the controller root's accessory cache saves", () => {

  /* A standalone accessory has no place in Homebridge's accessory cache: the cache's serializer refuses one, and a save that named one would fail every save of the
   * run. The root adopts a bridged camera and a standalone one, and marks each as it adds and configures it inside one save window. The window's save names the
   * bridged camera and never the standalone one, and every mark the adoption made goes out in that one save.
   */
  test("a standalone camera is never handed to the cache, while the bridged camera marked in the same window is saved in one update", async () => {

    const clock = new TestClock(TEST_CLOCK_EPOCH);
    const nvrConfig: ProtectNvrConfig = { ...makeNvrConfig(), firmwareVersion: "4.3.6", upSince: clock.now(), version: "6.1.79" };

    // Each camera record carries what the root's membership reconcile reads before it constructs a camera, its category and its adoption by this controller.
    const adopted = (options: { id: string; mac: string; name: string }): ProtectCameraConfig => ({ ...makeCameraConfig({ channels: G2_PRO_CHANNELS, ...options }),
      isAdopted: true, isAdoptedByOther: false, modelKey: "camera" });
    const bridgedConfig = adopted({ id: "camera-bridged", mac: "74ACB9000101", name: "Bridged Camera" });
    const standaloneConfig = adopted({ id: "camera-standalone", mac: "74ACB9000102", name: "Standalone Camera" });
    const store = new TestStateStore(makeProtectState({ cameras: [ bridgedConfig, standaloneConfig ], nvr: nvrConfig }));
    const { api, controller, nvr: double } = makeTestNvr({ clock, store, userOptions: ["Enable.Device.Standalone." + standaloneConfig.mac] });
    const client = makeConnectedClient({ nvrConfig, store });
    const { platform, shutdown } = makeRootPlatform(double);
    const root = new ProtectNvr(platform, double.config, async (): Promise<ProtectClient> => client);

    try {

      await root.login();
      await settle();

      const bridged = double.platform.accessories.find((accessory) => accessory.UUID === accessoryUuid(bridgedConfig.mac));
      const standalone = double.platform.accessories.find((accessory) => accessory.UUID === accessoryUuid(standaloneConfig.mac));

      assert.ok(bridged && standalone, "the root added the bridged camera and the standalone one");
      assert.ok(api.calls.some((call) => (call.kind === "publish") && call.accessories.includes(standalone)),
        "the standalone camera was published outside the bridge");
      assert.equal(api.calls.some((call) => call.kind === "update"), false, "nothing is saved while the adoption's window is open");

      clock.advance(ACCESSORY_SAVE_WINDOW_MS);

      const saves = api.calls.filter((call) => call.kind === "update");

      assert.equal(saves.length, 1, "every mark the adoption made went out in one save");
      assert.ok(saves[0]?.accessories.includes(bridged), "the save names the bridged camera");
      assert.equal(saves.some((call) => call.accessories.includes(standalone)), false, "no save names the standalone camera");
    } finally {

      shutdown();
      controller.abort();

      await settle();
    }
  });
});

describe("the controller root's device names", () => {

  /* HAP refuses an accessory whose display name is empty, and a Protect name that is empty sanitizes to nothing, so the root adds such a camera under its market
   * name, as it adds a camera reporting no name at all. Each camera is adopted at login and registered on the bridge under the name it was added under.
   */
  for(const { name, title } of [ { name: "", title: "a camera whose Protect name is empty is added to HomeKit under its market name" },
    { name: undefined, title: "a camera reporting no Protect name is added to HomeKit under its market name" } ]) {

    test(title, async () => {

      const clock = new TestClock(TEST_CLOCK_EPOCH);
      const nvrConfig: ProtectNvrConfig = { ...makeNvrConfig(), firmwareVersion: "4.3.6", upSince: clock.now(), version: "6.1.79" };

      // The camera record carries what the root's membership reconcile reads before it constructs a camera, with its name set after the builder, whose own default
      // would otherwise stand in for an absent one.
      const cameraConfig: ProtectCameraConfig = { ...makeCameraConfig({ channels: G2_PRO_CHANNELS }), isAdopted: true, isAdoptedByOther: false, modelKey: "camera",
        name };
      const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig], nvr: nvrConfig }));
      const { api, controller, nvr: double } = makeTestNvr({ clock, store });
      const client = makeConnectedClient({ nvrConfig, store });
      const { platform, shutdown } = makeRootPlatform(double);
      const root = new ProtectNvr(platform, double.config, async (): Promise<ProtectClient> => client);

      try {

        await root.login();
        await settle();

        const accessory = double.platform.accessories.find((candidate) => candidate.UUID === accessoryUuid(cameraConfig.mac));

        assert.ok(accessory, "the root added the camera");
        assert.equal(accessory.displayName, "Test Camera Model", "the camera was added under its market name");
        assert.ok(api.calls.some((call) => (call.kind === "register") && call.accessories.includes(accessory)),
          "the camera was registered on the bridge under that name");
      } finally {

        shutdown();
        controller.abort();

        await settle();
      }
    });
  }
});

describe("the controller root's orphan package camera removal", () => {

  /* A package camera whose parent doorbell is gone carries no MAC of its own, so it has no package camera of its own to take with it. The platform holds the orphan
   * beside a device accessory of another controller and one of this controller, each restored onto the bridge, and removing the orphan takes it alone. The
   * controller has only just come up, so the removal gate holds its stability sweep back and nothing but this removal reaches the platform.
   */
  test("removing a package camera whose parent is gone removes that accessory alone", async () => {

    const clock = new TestClock(TEST_CLOCK_EPOCH);
    const nvrConfig: ProtectNvrConfig = { ...makeNvrConfig(), firmwareVersion: "4.3.6", upSince: clock.now(), version: "6.1.79" };
    const store = new TestStateStore(makeProtectState({ nvr: nvrConfig }));
    const { api, controller, logEntries, nvr: double } = makeTestNvr({ clock, store });
    const orphan = makeTestAccessory("Front Door Package Camera", "74ACB9000001.PackageCamera");
    const foreign = makeTestAccessory("Other Controller Camera", "74ACB9000002");
    const own = makeTestAccessory("Garage Camera", "74ACB9000003");

    orphan.context = { nvr: nvrConfig.mac, packageCamera: "74ACB9000001" };
    foreign.context = { mac: "74ACB9000002", nvr: "AABBCCDDEEFF" };
    own.context = { mac: "74ACB9000003", nvr: nvrConfig.mac };
    restoreAccessories(double, [ orphan, foreign, own ]);

    const client = makeConnectedClient({ nvrConfig, store });
    const { platform, shutdown } = makeRootPlatform(double);
    const root = new ProtectNvr(platform, double.config, async (): Promise<ProtectClient> => client);

    try {

      await root.login();
      await settle();

      const logged = logEntries.length;

      root.removeHomeKitDevice(orphan);

      assert.deepEqual(logEntries.slice(logged).map(formatLogEntry),
        ["Test Controller [UniFi Dream Machine SE]: Front Door Package Camera: Removing device from HomeKit."], "the removal logs its one line");
      assert.equal(double.platform.accessories.includes(orphan), false, "the orphan left the platform");
      assert.ok(double.platform.accessories.includes(foreign) && double.platform.accessories.includes(own), "both bystanders stay on the platform");
      assert.deepEqual(api.calls.filter((call) => call.kind === "unregister").flatMap((call) => call.accessories), [orphan], "the orphan alone was unregistered");
    } finally {

      shutdown();
      controller.abort();

      await settle();
    }
  });
});
