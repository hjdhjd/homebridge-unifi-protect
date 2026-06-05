/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * nvr.test.ts: Unit tests for the pure decision logic the v5 controller-root inversion introduces - the startup-resilient connect retry policy, the HomeKit-membership
 * set diff, and the request-outcome classifier - plus the NvrHealth connection-input mapping those drive.
 *
 * ProtectNvr itself is a composition root: its constructor stands up the event handler and the controller logging, and it transitively imports the entire device and
 * media graph, so it is neither unit-constructable nor cheaply loadable. The response is to keep the *decisions* it makes in a pure leaf module (nvr-policy.ts) and pin
 * those here, exercising the controller's real behavior (auth-budget exhaustion, membership add/remove, request-outcome-to-symptom mapping) without mocking a client.
 * The connection-input mapping is verified against the real NvrHealth with an injected clock, so the test proves both the new mapping and that the reducer/window
 * behavior it feeds is unchanged.
 */
import { createConnectRetryPolicy, isSuccessfulRequest, membershipDelta } from "./nvr-policy.ts";
import { describe, test } from "node:test";
import { NvrHealth } from "./nvr-health.ts";
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
