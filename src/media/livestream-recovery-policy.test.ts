/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * livestream-recovery-policy.test.ts: Unit tests for the health-correlated livestream recovery policy (livestreamRecoveryDecision).
 *
 * The policy is a pure function - the library-observable RecoveryContext plus a snapshot of the plugin's controller-health and lifecycle-phase reads in,
 * a RecoveryDecision out, with no live reads and no side effects. So it is tested directly with constructed inputs: no harness, no mocks, no HAP, no controller. That is
 * the whole point of the pure-core/live-read-closure split - the decision logic is exhaustively coverable here, and the thin closure in nvr.ts that supplies the live
 * reads is the only part that touches the running client.
 *
 * The type-only imports of NvrPhase/NvrHealthState are erased by the strip-types test runner, so importing the real production livestreamRecoveryDecision does NOT drag
 * in nvr.ts's camera/streaming stack at runtime - the module under test resolves against unifi-protect alone. This is real-code coverage of the shipped policy.
 *
 * Coverage map - every policy decision plus the named boundary, escalation, and hazard cases:
 *
 *   - establishing => delegate to the library default, proven by-reference (the returned decision is the default's own output).
 *   - recovering + rebooting/shuttingDown => wait (the induced-disruption guard), including the guard-precedes-the-hard-gate ordering (rebooting + throttled).
 *   - recovering + throttled, attempts=100 => wait, NEVER giveUp (the headline hazard: a throttled controller never reboots a camera).
 *   - recovering + healthy controller + this camera offline => wait (the NEW offline-defer gate, step 3), including the precedence-over-self-heal ordering (offline +
 *     attempts >= threshold still waits) and the wedged-preserved counter-case (reachable + attempts >= threshold still gives up).
 *   - recovering + reachable + attempts >= threshold => giveUp (self-heal); attempts < threshold + healthy => reconnect.
 *   - recovering + reachable + elevated + idle + within budget => wait (soft ease-off); + active => reconnect; + budget spent => reconnect.
 *   - The soft-ease-off boundaries: toleranceMs === step (no defer), elapsedMs === ceiling (escalate), toleranceMs === Infinity (defer, maximally patient).
 */
import { LIVE_SELF_HEAL_THRESHOLD, livestreamRecoveryDecision } from "./livestream-recovery-policy.ts";
import type { RecoveryContext, RecoveryDecision } from "unifi-protect";
import { describe, test } from "node:test";
import type { NvrHealthState } from "../nvr/nvr-health.ts";
import type { NvrPhase } from "../nvr/nvr.ts";
import assert from "node:assert/strict";
import { defaultLivestreamRecoveryPolicy } from "unifi-protect";

// The snapshot of the plugin's live reads the policy correlates against - the exact shape the nvr.ts closure passes. Named once here so both the builder and its return
// annotation single-source it, mirroring the inline object the production closure supplies.
interface NvrSnapshot {

  healthState: NvrHealthState;
  isHealthy: boolean;
  isThrottled: boolean;
  phase: NvrPhase;
}

// The three co-located constants the policy keeps private (only LIVE_SELF_HEAL_THRESHOLD is exported, for the consumer side - the timeshift buffer and live streaming
// delegate). We mirror them here so the boundary tests read against named values rather than bare literals, keeping the assertions legible and pinned to the policy.
const LIVESTREAM_STRESS_WAIT_MS = 5000;
const SOFT_DEFER_CEILING_MS = 8000;
const SOFT_DEFER_STEP_MS = 1000;

// A constructed RecoveryContext with sensible recovering-phase defaults. Every test overrides only the fields it exercises, so each case reads as exactly the matrix
// cell it pins. The defaults describe a reachable, mid-episode recovery with no declared urgency.
function makeContext(overrides: Partial<RecoveryContext> = {}): RecoveryContext {

  return { attempts: 0, cameraId: "cam-test", elapsedMs: 0, phase: "recovering", toleranceMs: Infinity, ...overrides };
}

// A constructed snapshot of the plugin's live reads with healthy-and-reachable defaults (the steady state). Each test overrides only the fields it exercises.
function makeNvr(overrides: Partial<NvrSnapshot> = {}): NvrSnapshot {

  return { healthState: "healthy", isHealthy: true, isThrottled: false, phase: "running", ...overrides };
}

describe("livestreamRecoveryDecision", () => {

  describe("establishment (row 1)", () => {

    // Establishment is hardware-bound and health-independent, so the policy delegates wholesale to the library default. We prove the delegation is by-reference: the
    // returned decision is byte-for-byte what defaultLivestreamRecoveryPolicy returns for the same context, regardless of the (here adverse) health snapshot.
    test("delegates to the library default regardless of health, returning the default's own decision", () => {

      const context = makeContext({ attempts: 2, elapsedMs: 4000, phase: "establishing" });
      const expected = defaultLivestreamRecoveryPolicy(context);

      assert.deepEqual(livestreamRecoveryDecision(context, makeNvr({ healthState: "stressed", isHealthy: false, isThrottled: true }), true), expected);
    });
  });

  describe("induced disruption (rows 2-3)", () => {

    // We are rebooting the controller ourselves, so we wait rather than fight our own teardown with reconnects.
    test("waits when the controller is rebooting (row 2)", () => {

      assert.deepEqual(livestreamRecoveryDecision(makeContext({ attempts: 99 }), makeNvr({ phase: "rebooting" }), true), { forMs: 5000, kind: "wait" });
    });

    // Likewise during our own shutdown: wait, never give up (the disconnect path disposes the subscription if we are truly tearing down).
    test("waits when the controller is shutting down (row 3)", () => {

      assert.deepEqual(livestreamRecoveryDecision(makeContext({ attempts: 99 }), makeNvr({ phase: "shuttingDown" }), true), { forMs: 5000, kind: "wait" });
    });

    // The induced-disruption guard precedes the hard reachability gate: a reboot that also looks throttled still routes through the disruption wait, not the gate's.
    // Both happen to return the same wait shape, but the ordering is what is pinned - the disruption branch wins so our own teardown is never reinterpreted as a
    // drowning controller. We pin the ordering by asserting the phase guard fires under conditions that would otherwise also satisfy the hard gate.
    test("the induced-disruption guard precedes the hard gate (rebooting + throttled => wait)", () => {

      const decision = livestreamRecoveryDecision(makeContext(), makeNvr({ isHealthy: false, isThrottled: true, phase: "rebooting" }), true);

      assert.deepEqual(decision, { forMs: 5000, kind: "wait" });
    });
  });

  describe("hard reachability gate - the headline hazard (row 4)", () => {

    // THE headline hazard. A throttled controller with a huge attempts count must still WAIT, never giveUp: a camera reboot cannot fix an overloaded controller, so
    // the hard reachability gate wins over the self-heal threshold. This test pins the intended "wait out the controller, don't reboot the camera" behavior so a future
    // refactor cannot regress it into a reboot-storm.
    test("waits, NEVER gives up, under a throttled controller even with attempts far past the self-heal threshold (row 4)", () => {

      const decision = livestreamRecoveryDecision(makeContext({ attempts: 100 }), makeNvr({ isThrottled: true }), true);

      assert.deepEqual(decision, { forMs: 5000, kind: "wait" });
      assert.notEqual(decision.kind, "giveUp");
    });

    // The other half of the hard gate: unreachable (the breaker reports unhealthy) without an explicit throttle flag still waits, regardless of a huge attempts count.
    test("waits under an unreachable controller (!isHealthy) even with a huge attempts count", () => {

      assert.deepEqual(livestreamRecoveryDecision(makeContext({ attempts: 100 }), makeNvr({ isHealthy: false }), true), { forMs: 5000, kind: "wait" });
    });
  });

  describe("offline-defer gate - the NEW step (step 3)", () => {

    // The positive case: this one camera is offline on an otherwise-healthy, non-throttled controller, so the gate defers rather than reconnecting. The controller is
    // explicitly healthy so the wait can only come from the new gate, not the hard reachability gate of step 2.
    test("waits when this camera is offline on a healthy controller (the new gate fires)", () => {

      assert.deepEqual(livestreamRecoveryDecision(makeContext(), makeNvr(), false), { forMs: LIVESTREAM_STRESS_WAIT_MS, kind: "wait" });
    });

    // The precedence case that pins the ordering: an offline camera that is ALSO past the self-heal threshold must wait, never give up. The gate sits before the
    // self-heal step, so the offline defer wins; if it were placed after the self-heal step, this case would give up instead. The controller is healthy and non-throttled
    // so the wait can only come from the new gate (step 2 cannot fire), which is what makes this discriminate the ordering rather than merely the gate's presence.
    test("an offline camera past the self-heal threshold still waits, never gives up (gate precedes self-heal)", () => {

      assert.deepEqual(livestreamRecoveryDecision(makeContext({ attempts: LIVE_SELF_HEAL_THRESHOLD }), makeNvr(), false), { forMs: LIVESTREAM_STRESS_WAIT_MS,
        kind: "wait" });
    });

    // The wedged-path-preserved case: a REACHABLE camera past the self-heal threshold on a healthy controller still gives up, so the gate does not interfere with the
    // reachable-but-wedged self-heal. This proves the gate is scoped to the offline camera and leaves the genuine self-heal reboot path intact.
    test("a reachable camera past the self-heal threshold still gives up (the gate does not shadow self-heal)", () => {

      assert.deepEqual(livestreamRecoveryDecision(makeContext({ attempts: LIVE_SELF_HEAL_THRESHOLD }), makeNvr(), true), { kind: "giveUp" });
    });
  });

  describe("self-heal (rows 5-6)", () => {

    // On a reachable controller, a camera that keeps failing real reconnects gives up at the threshold so the consumer reboots the wedged camera.
    test("gives up at the self-heal threshold on a reachable, healthy controller (row 5)", () => {

      assert.deepEqual(livestreamRecoveryDecision(makeContext({ attempts: LIVE_SELF_HEAL_THRESHOLD }), makeNvr(), true), { kind: "giveUp" });
    });

    // One reconnect past the threshold also gives up - the comparison is `>=`, not `===`.
    test("gives up above the self-heal threshold (>=, not ===)", () => {

      assert.deepEqual(livestreamRecoveryDecision(makeContext({ attempts: LIVE_SELF_HEAL_THRESHOLD + 5 }), makeNvr(), true), { kind: "giveUp" });
    });

    // Below the threshold on a healthy controller, the policy reconnects via the library default. We assert it is the default's own output, by reference.
    test("reconnects via the library default below the threshold on a healthy controller (row 6)", () => {

      const context = makeContext({ attempts: LIVE_SELF_HEAL_THRESHOLD - 1, elapsedMs: 2000 });
      const decision = livestreamRecoveryDecision(context, makeNvr(), true);

      assert.equal(decision.kind, "reconnect");
      assert.deepEqual(decision, defaultLivestreamRecoveryPolicy(context));
    });
  });

  describe("soft ease-off (rows 7-10 and boundaries)", () => {

    // An idle stream (tolerance above one defer step) under elevated-but-reachable symptoms, within the per-episode budget, eases off for one step before re-consulting.
    test("eases off an idle stream under degraded symptoms within budget (row 7)", () => {

      const context = makeContext({ attempts: 3, elapsedMs: 4000, toleranceMs: 2000 });

      assert.deepEqual(livestreamRecoveryDecision(context, makeNvr({ healthState: "degraded" }), true), { forMs: SOFT_DEFER_STEP_MS, kind: "wait" });
    });

    // The recording exemption: an active stream declares a tolerance below one defer step, so it skips the ease-off and reconnects immediately via the library default.
    test("reconnects an active (latency-sensitive) stream under degraded symptoms - recording exemption (row 8)", () => {

      const context = makeContext({ attempts: 3, elapsedMs: 4000, toleranceMs: 500 });
      const decision = livestreamRecoveryDecision(context, makeNvr({ healthState: "degraded" }), true);

      assert.equal(decision.kind, "reconnect");
      assert.deepEqual(decision, defaultLivestreamRecoveryPolicy(context));
    });

    // The bounded-defer-then-escalate path: once the episode has run past the ceiling, the idle stream stops easing off and reconnects, advancing attempts to self-heal.
    test("reconnects an idle stream once the soft budget is spent - degraded (row 9)", () => {

      const context = makeContext({ attempts: 3, elapsedMs: SOFT_DEFER_CEILING_MS, toleranceMs: 2000 });
      const decision = livestreamRecoveryDecision(context, makeNvr({ healthState: "degraded" }), true);

      assert.equal(decision.kind, "reconnect");
      assert.deepEqual(decision, defaultLivestreamRecoveryPolicy(context));
    });

    // The stressed level eases off identically to degraded - any non-healthy level is "elevated symptoms" for the soft ease-off.
    test("eases off an idle stream under stressed symptoms within budget (row 10)", () => {

      const context = makeContext({ attempts: 3, elapsedMs: 4000, toleranceMs: 2000 });

      assert.deepEqual(livestreamRecoveryDecision(context, makeNvr({ healthState: "stressed" }), true), { forMs: SOFT_DEFER_STEP_MS, kind: "wait" });
    });

    // The escalation, pinned explicitly: at elapsedMs === the ceiling the comparison `elapsedMs < SOFT_DEFER_CEILING_MS` is false, so the soft ease-off escalates to a
    // reconnect rather than easing off forever - the bounded-defer-then-escalate path that advances attempts toward the self-heal.
    test("escalates to reconnect at the soft-defer ceiling boundary (elapsedMs === ceiling)", () => {

      const context = makeContext({ attempts: 3, elapsedMs: SOFT_DEFER_CEILING_MS, toleranceMs: 2000 });

      assert.equal(livestreamRecoveryDecision(context, makeNvr({ healthState: "degraded" }), true).kind, "reconnect");
    });

    // The active/idle boundary, pinned explicitly: at toleranceMs === one step the comparison `toleranceMs > SOFT_DEFER_STEP_MS` is false (strict `>`), so a stream
    // tolerating exactly one step is treated as active and reconnects rather than easing off.
    test("treats a tolerance of exactly one defer step as active - no defer (toleranceMs === step)", () => {

      const context = makeContext({ attempts: 3, elapsedMs: 4000, toleranceMs: SOFT_DEFER_STEP_MS });

      assert.equal(livestreamRecoveryDecision(context, makeNvr({ healthState: "degraded" }), true).kind, "reconnect");
    });

    // The no-declared-urgency case: a stream reporting no urgency aggregates to toleranceMs === Infinity, maximally patient, and so eases off under elevated symptoms.
    test("eases off when no urgency is declared (toleranceMs === Infinity) under elevated symptoms", () => {

      const context = makeContext({ attempts: 3, elapsedMs: 4000, toleranceMs: Infinity });

      assert.deepEqual(livestreamRecoveryDecision(context, makeNvr({ healthState: "degraded" }), true), { forMs: SOFT_DEFER_STEP_MS, kind: "wait" });
    });

    // A healthy controller never eases off, even for a maximally patient idle stream: the soft ease-off is gated on elevated symptoms, so a healthy controller
    // reconnects.
    test("does not ease off on a healthy controller (reconnects an idle stream)", () => {

      const context = makeContext({ attempts: 3, elapsedMs: 4000, toleranceMs: 2000 });

      assert.equal(livestreamRecoveryDecision(context, makeNvr({ healthState: "healthy" }), true).kind, "reconnect");
    });
  });

  describe("the exported self-heal threshold", () => {

    // The threshold is exported for the consumer side - the timeshift buffer and live streaming delegate - which reads it to decide a caught give-up means "reboot this
    // camera". Pin its value so a drift is caught.
    test("exposes LIVE_SELF_HEAL_THRESHOLD as the expected value", () => {

      assert.equal(LIVE_SELF_HEAL_THRESHOLD, 10);
    });
  });

  describe("decision exhaustiveness", () => {

    // Every decision the policy returns must be one of RecoveryDecision's three arms. We sweep representative inputs across all six steps and assert the returned kind
    // is in the allowed set, so a future arm added to the union (or a step returning a malformed shape) is caught here rather than only at the library's recovery-loop
    // boundary. This is coverage, not the offline-defer gate's discriminating test: every case here passes a reachable camera (the gate's three dedicated deepEqual
    // cases above own the offline discrimination), so the sweep exercises the reachable-camera steps without conflating the two concerns.
    test("every returned decision carries a kind in the RecoveryDecision union", () => {

      const allowed: readonly RecoveryDecision["kind"][] = [ "giveUp", "reconnect", "wait" ];
      const cases: readonly { context: RecoveryContext; nvr: NvrSnapshot }[] = [
        { context: makeContext({ phase: "establishing" }), nvr: makeNvr() },
        { context: makeContext(), nvr: makeNvr({ phase: "rebooting" }) },
        { context: makeContext({ attempts: 100 }), nvr: makeNvr({ isThrottled: true }) },
        { context: makeContext({ attempts: LIVE_SELF_HEAL_THRESHOLD }), nvr: makeNvr() },
        { context: makeContext({ elapsedMs: 4000, toleranceMs: 2000 }), nvr: makeNvr({ healthState: "degraded" }) },
        { context: makeContext(), nvr: makeNvr() }
      ];

      for(const { context, nvr } of cases) {

        assert.ok(allowed.includes(livestreamRecoveryDecision(context, nvr, true).kind));
      }
    });
  });
});
