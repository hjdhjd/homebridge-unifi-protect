/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * livestream-recovery-policy.ts: HBUP's health-correlated livestream recovery policy - the POLICY half of the v5 livestream recovery dependency inversion.
 *
 * v5's livestream pool owns the recovery MECHANISM: the loop that re-consults a policy on every stall, the timing windows it honors, and the terminal give-up
 * throw. It deliberately omits controller-health and lifecycle-phase from its `RecoveryContext`, because those are consumer-private - only HBUP can observe them.
 * This module is the POLICY: a pure function that correlates the library-observable context with HBUP's own controller-health (`NvrHealthState`,
 * `connection.isThrottled`/`isHealthy`) and lifecycle-phase (`NvrPhase`) reads to reproduce pre-v5's three self-heal rules, plus a thin live-read closure (wired at
 * `ProtectClient.connect` in nvr.ts) that supplies those reads at policy-fire time. This is the same dependency-inversion split as the `reduceHealth` pure core paired
 * with its `NvrHealth` event-sink wrapper: the decision logic is an exhaustively unit-testable pure function, and the wrapper supplies only live state.
 *
 * The three pre-v5 rules this reproduces (parity basis = pre-v5 RUNTIME `protect-livestream.ts`):
 *
 *   1. Wait out a drowning controller. When the controller's breaker is open or it is unreachable (`isThrottled`/`!isHealthy`), back off and wait indefinitely (the
 *      library caps the backoff) without ever rebooting the camera - a camera reboot cannot fix an overloaded controller. Pre-v5 returned before the self-heal check
 *      for exactly this reason, so a throttled controller never reboots a camera.
 *   2. Reboot a wedged camera. When the controller is reachable but a single camera will not reconnect after `LIVE_SELF_HEAL_THRESHOLD` consecutive failed
 *      reconnects, give up so the consumer reboots that camera and re-subscribes. The give-up is the self-heal trigger, not a terminal failure.
 *   3. Ease an idle stream off a stressed-but-reachable controller. When the controller is reachable but showing elevated symptoms, defer an idle (latency-tolerant)
 *      stream for a bounded window rather than piling reconnects onto it; a latency-sensitive consumer (an active recording) skips the defer and reconnects at once.
 *
 * Blessed divergence from pre-v5 (documented refinement, not a bug): the v5 `attempts` counter increments ONLY on a failed reconnect, never on a `wait`, so it is not
 * poisoned during a throttle wait. When the controller recovers, reconnects count fresh from 0 - cleaner than pre-v5, which incremented during throttle-defers and
 * could reboot a camera immediately on controller recovery.
 *
 * The 5b/5c consumer contract (documented here, implemented there - do NOT implement in this module):
 *
 *   - The soft ease-off in step 4 exempts active recordings via `toleranceMs`. An active consumer (a live recording) must declare an `urgency()` strictly below
 *     SOFT_DEFER_STEP_MS so it reconnects immediately; an idle prebuffer must declare strictly above SOFT_DEFER_STEP_MS so it eases off. The library's media-stall
 *     detection floors at 2s regardless of the declared urgency, so the prebuffer stays watched at 2s either way. The 5b/5c author wires the timeshift/live
 *     `urgency()` closures to honor this split.
 *   - The self-heal in step 2 has a consumer side that is also 5b/5c, not here: catch `ProtectLivestreamUnavailableError` (which carries `{ attempts, phase }`) and
 *     reboot the camera, then re-subscribe, when `attempts >= LIVE_SELF_HEAL_THRESHOLD`. This module only declares the give-up; the reboot-and-resubscribe is theirs.
 */
import type { RecoveryContext, RecoveryDecision } from "unifi-protect";
import type { NvrHealthState } from "./nvr-health.ts";
import type { NvrPhase } from "./nvr.ts";
import { defaultLivestreamRecoveryPolicy } from "unifi-protect";

// Consecutive failed reconnects on a reachable controller before the camera is rebooted; pre-v5 parity. Exported because the 5b/5c consumer side reads it to decide
// when a caught give-up error means "reboot this camera" rather than "surface a terminal failure".
export const LIVE_SELF_HEAL_THRESHOLD = 10;

// Per-episode bound on the soft ease-off, in milliseconds; pre-v5 LIVE_DEFERRED_STALL_CEILING. Once the episode has run this long, the soft ease-off escalates to a
// reconnect rather than easing off forever, so sustained symptoms advance the attempts counter toward the self-heal above.
const SOFT_DEFER_CEILING_MS = 8000;

// Soft ease-off re-poll granularity AND the active/idle threshold, in milliseconds: a stream that tolerates strictly less than one step is "active" (latency-
// sensitive) and skips the defer; a stream that tolerates strictly more is "idle" and eases off.
const SOFT_DEFER_STEP_MS = 1000;

// Re-poll interval, in milliseconds, while the controller is drowning or an induced disruption (our own reboot/shutdown) is in flight. We wait and re-consult rather
// than reconnect, so the episode does not burn reconnect attempts against a controller that cannot answer.
const LIVESTREAM_STRESS_WAIT_MS = 5000;

/**
 * The pure decision core of HBUP's livestream recovery policy. Given the library-observable {@link RecoveryContext} and a snapshot of HBUP's controller-health and
 * lifecycle-phase reads, it returns the {@link RecoveryDecision} the library's recovery loop will honor. It is pure - no live reads, no side effects - so it is
 * exhaustively unit-testable with constructed inputs, and the live reads are supplied by the thin closure wired at `ProtectClient.connect`.
 *
 * The ordered policy is five steps, the first match winning:
 *
 *   0. Establishment is delegated wholesale to the library default (it is hardware-bound and health-independent).
 *   1. An induced disruption (our own reboot/shutdown) waits, so we do not fight our own teardown with reconnects.
 *   2. A drowning controller (the hard reachability gate) waits indefinitely and never reboots a camera.
 *   3. A wedged camera on a reachable controller gives up after the self-heal threshold, so the consumer reboots it.
 *   4. An idle stream under elevated-but-reachable symptoms eases off for a bounded window.
 *   5. Otherwise - healthy, latency-sensitive, or soft budget spent - reconnect with the library default's self-tuning timing.
 *
 * @param context - The library-observable recovery context (attempts, elapsedMs, phase, toleranceMs).
 * @param nvr - A snapshot of HBUP's controller-health and lifecycle-phase reads at the decision point.
 *
 * @returns The recovery decision for this step.
 */
export function livestreamRecoveryDecision(context: RecoveryContext,
  nvr: { healthState: NvrHealthState; isHealthy: boolean; isThrottled: boolean; phase: NvrPhase }): RecoveryDecision {

  // Establishment is hardware-bound and health-independent: delegate to the library's patient default (30s deadline, 5/8/10s backoff), identical to pre-v5 provisioning.
  if(context.phase === "establishing") {

    return defaultLivestreamRecoveryPolicy(context);
  }

  // 1. Induced disruption: we are rebooting or shutting down the controller ourselves, so do not fight it with reconnects. Wait for it to clear; never give up here (the
  //    disconnect path disposes the subscription if we are truly tearing down, and a giveUp would needlessly surface a terminal error during our own reboot).
  if((nvr.phase === "rebooting") || (nvr.phase === "shuttingDown")) {

    return { forMs: LIVESTREAM_STRESS_WAIT_MS, kind: "wait" };
  }

  // 2. Hard reachability gate: the CONTROLLER is drowning (its breaker is open or it is unreachable). Wait it out until it recovers, and do NOT reboot the camera - a
  //    camera reboot cannot fix an overloaded controller. This is pre-v5's reachability backoff, which returned before the self-heal check, so a throttled controller
  //    never reboots a camera. It never gives up; recovery resumes when the controller comes back.
  if(nvr.isThrottled || !nvr.isHealthy) {

    return { forMs: LIVESTREAM_STRESS_WAIT_MS, kind: "wait" };
  }

  // 3. Self-heal: the controller is reachable but this camera will not reconnect. After LIVE_SELF_HEAL_THRESHOLD consecutive failed reconnects, give up so the consumer
  //    (a later step) reboots the wedged camera and re-subscribes. The library increments attempts only on a failed reconnect, so this is correctly reached only on a
  //    reachable controller that keeps failing real reconnects, never during a wait.
  if(context.attempts >= LIVE_SELF_HEAL_THRESHOLD) {

    return { kind: "giveUp" };
  }

  // 4. Soft ease-off: the controller is reachable but showing elevated symptoms. Ease an idle stream off the controller for a bounded window before reconnecting, rather
  //    than piling reconnects onto a stressed-but-reachable controller. A latency-sensitive consumer (an active recording) declares a tolerance below one defer step and
  //    so skips this, reconnecting immediately. The window is bounded by elapsedMs against the ceiling, so under sustained symptoms it escalates to a reconnect
  //    (advancing the attempts counter toward the self-heal above) rather than easing off forever.
  if((nvr.healthState !== "healthy") && (context.elapsedMs < SOFT_DEFER_CEILING_MS) && (context.toleranceMs > SOFT_DEFER_STEP_MS)) {

    return { forMs: SOFT_DEFER_STEP_MS, kind: "wait" };
  }

  // 5. Reconnect: the controller is healthy, or the consumer is latency-sensitive, or the soft ease-off budget is spent. Delegate the timing to the library default,
  //    whose await window self-tunes from the consumer's reported tolerance.
  return defaultLivestreamRecoveryPolicy(context);
}
