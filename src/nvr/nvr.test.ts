/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * nvr.test.ts: Unit tests for the controller root's pure decision logic - the startup-resilient connect retry policy, the HomeKit-membership set diff, the
 * request-outcome classifier, the removal-stability arithmetic, the livestream-disruption gating (induced/recency/episode-latch), and the induced-reboot resume
 * decision - plus the NvrHealth connection-input mapping those drive.
 *
 * ProtectNvr itself is a composition root: its constructor stands up the event handler and the controller logging, and it transitively imports the entire device and
 * media graph, so it is neither unit-constructable nor cheaply loadable. The response is to keep the *decisions* it makes in a pure leaf module (nvr-policy.ts) and pin
 * those here, exercising the controller's real behavior (auth-budget exhaustion, membership add/remove, request-outcome-to-symptom mapping) without mocking a client.
 * The connection-input mapping is verified against the real NvrHealth with an injected clock, so the test proves both the new mapping and that the reducer/window
 * behavior it feeds is unchanged.
 */
import { canTransition, computeStableSince, createConnectRetryPolicy, createLivestreamEpisodeLatch, isInducedDisruption, isRequestForController,
  isStabilityWindowElapsed, isSuccessfulRequest, isWithinRebootRecency, membershipDelta, shouldResumeFromInducedReboot } from "./nvr-policy.ts";
import { describe, test } from "node:test";
import { NvrHealth } from "./nvr-health.ts";
import type { NvrPhase } from "./nvr.ts";
import { ProtectAuthError } from "unifi-protect";
import assert from "node:assert/strict";

// A deterministic clock for NvrHealth so the sliding window is driven by the test, not wall time. Starts at an arbitrary fixed epoch and advances only when the test
// asks; mirrors the Clock seam the production NvrHealth already accepts.
class FakeClock {

  public current = 1_000_000;

  public now(): number {

    return this.current;
  }
}

// A stand-in non-authentication fault. The retry policy branches solely on `error instanceof ProtectAuthError`, so any other error value exercises the non-auth path;
// a plain Error is the clearest representative of "network / transient".
const networkError = new Error("connection refused");

describe("connect retry policy", () => {

  test("fails fast after the consecutive-auth budget is exhausted", () => {

    const { shouldRetry } = createConnectRetryPolicy(3);
    const authError = new ProtectAuthError("bad credentials");

    // The first two consecutive auth faults are retried (the controller may still be sorting out its own auth); the third exhausts the budget and stops.
    assert.equal(shouldRetry(authError), true);
    assert.equal(shouldRetry(authError), true);
    assert.equal(shouldRetry(authError), false);
  });

  test("retries a non-auth fault without consuming the auth budget", () => {

    const { shouldRetry } = createConnectRetryPolicy(3);

    // Any number of network faults are retried - the budget only ever counts authentication failures.
    for(let attempt = 0; attempt < 10; attempt++) {

      assert.equal(shouldRetry(networkError), true);
    }
  });

  test("a non-auth fault resets the consecutive-auth counter", () => {

    const { shouldRetry } = createConnectRetryPolicy(3);
    const authError = new ProtectAuthError("bad credentials");

    // Two auth faults, then a network fault, must reset the run - so the budget is not exhausted by non-consecutive auth failures interleaved with recovery signals.
    assert.equal(shouldRetry(authError), true);
    assert.equal(shouldRetry(authError), true);
    assert.equal(shouldRetry(networkError), true);

    // The counter is back to zero, so two more auth faults are again retried and only the third would stop.
    assert.equal(shouldRetry(authError), true);
    assert.equal(shouldRetry(authError), true);
    assert.equal(shouldRetry(authError), false);
  });

  test("defaults its budget to the shared auth-failure limit", () => {

    const { shouldRetry } = createConnectRetryPolicy();
    const authError = new ProtectAuthError("bad credentials");

    // The default ceiling is PROTECT_AUTH_FAILURE_LIMIT (3): two retried, the third stops.
    assert.equal(shouldRetry(authError), true);
    assert.equal(shouldRetry(authError), true);
    assert.equal(shouldRetry(authError), false);
  });
});

describe("membership delta", () => {

  test("a newly adopted id is queued to add", () => {

    const { toAdd, toRemove } = membershipDelta([ "a", "b", "c" ], [ "a", "b" ]);

    assert.deepEqual(toAdd, ["c"]);
    assert.deepEqual(toRemove, []);
  });

  test("a vanished id is queued to remove", () => {

    const { toAdd, toRemove } = membershipDelta([ "a", "b" ], [ "a", "b", "c" ]);

    assert.deepEqual(toAdd, []);
    assert.deepEqual(toRemove, ["c"]);
  });

  test("an unchanged set produces no work", () => {

    const { toAdd, toRemove } = membershipDelta([ "a", "b", "c" ], [ "a", "b", "c" ]);

    assert.deepEqual(toAdd, []);
    assert.deepEqual(toRemove, []);
  });

  test("a simultaneous add and remove are both surfaced", () => {

    const { toAdd, toRemove } = membershipDelta([ "a", "c" ], [ "a", "b" ]);

    assert.deepEqual(toAdd, ["c"]);
    assert.deepEqual(toRemove, ["b"]);
  });

  test("diffs against the configured set, not a held snapshot", () => {

    // The diff is a pure function of its two arguments - the controller's adopted ids and our configured ids - so the same adopted set produces different work for
    // different configured sets, proving there is no retained #prev snapshot influencing the result.
    const adopted = [ "a", "b", "c" ];

    assert.deepEqual(membershipDelta(adopted, []).toAdd, [ "a", "b", "c" ]);
    assert.deepEqual(membershipDelta(adopted, [ "a", "b", "c" ]).toAdd, []);
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

    const clock = new FakeClock();
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

    const clock = new FakeClock();
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

    const clock = new FakeClock();
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

    // No reboot observed this process. The small nowMs keeps the null guard load-bearing - dropping it would compute 0 - null < window and wrongly read as within-window.
    assert.equal(isWithinRebootRecency({ lastRebootMs: null, nowMs: 0, windowMs }), false);
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

  // canTransition owns the two refusals the NVR's transition chokepoint honors: a same-phase change (the long-standing no-op), and any change OUT of the terminal
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

  // The process-global HTTP diagnostics channel carries every client's requests, so each NVR keeps only its own by an EXACT host match. The cross-contamination row is
  // the one a substring test gets wrong: "192.168.1.2" is a substring of "192.168.1.20", so the pre-fix .includes() filter let a controller observe a neighbor's
  // requests. The remaining rows pin the parser-derived behavior: a hostname prefix does not match, the compare is case-insensitive, a bracketed IPv6 URL matches a bare
  // configured IPv6 literal, a port on the URL is ignored, and a malformed URL matches nothing.
  test("isRequestForController matches only the exact configured host", () => {

    // The controller's own request counts.
    assert.equal(isRequestForController({ address: "192.168.1.2", url: "https://192.168.1.2/proxy/protect/api/bootstrap" }), true);

    // The cross-contamination case: a neighbor whose address merely contains ours must not match.
    assert.equal(isRequestForController({ address: "192.168.1.2", url: "https://192.168.1.20/proxy/protect/api/bootstrap" }), false);

    // A configured host that is a prefix of the URL's hostname does not match - equality, not containment.
    assert.equal(isRequestForController({ address: "controller", url: "https://controller.example.com/api" }), false);

    // The URL parser lowercases the hostname, so a mixed-case configured host still matches.
    assert.equal(isRequestForController({ address: "Controller.Local", url: "https://controller.local/api" }), true);

    // A bare configured IPv6 literal matches the URL parser's bracketed hostname form.
    assert.equal(isRequestForController({ address: "fe80::1", url: "https://[fe80::1]/api" }), true);

    // The hostname excludes the port, so a port on the request URL is irrelevant to the match.
    assert.equal(isRequestForController({ address: "192.168.1.2", url: "https://192.168.1.2:7443/api" }), true);

    // A malformed URL cannot be parsed, so it belongs to no controller.
    assert.equal(isRequestForController({ address: "192.168.1.2", url: "notaurl" }), false);
  });
});
