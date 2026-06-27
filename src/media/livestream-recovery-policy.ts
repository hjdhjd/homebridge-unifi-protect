/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * livestream-recovery-policy.ts: The plugin's health-correlated livestream recovery policy - the POLICY half of the unifi-protect livestream recovery dependency
 * inversion.
 *
 * The unifi-protect library's livestream pool owns the recovery MECHANISM: the loop that re-consults a policy on every stall, the timing windows it honors, and
 * the terminal give-up throw. It deliberately omits controller-health and lifecycle-phase from its `RecoveryContext`, because those are consumer-private - only
 * the plugin can observe them. This module is the POLICY: a pure function that correlates the library-observable context with the plugin's own controller-health
 * (`NvrHealthState`, `connection.isThrottled`/`isHealthy`) and lifecycle-phase (`NvrPhase`) reads to apply the three self-heal rules, plus a thin live-read closure
 * (wired at `ProtectClient.connect` in nvr.ts) that supplies those reads at policy-fire time. This is the same dependency-inversion split as the `reduceHealth` pure
 * core paired with its `NvrHealth` event-sink wrapper: the decision logic is an exhaustively unit-testable pure function, and the wrapper supplies only live state.
 *
 * The three self-heal rules this policy applies:
 *
 *   1. Wait out a drowning controller. When the controller's breaker is open or it is unreachable (`isThrottled`/`!isHealthy`), back off and wait indefinitely (the
 *      library caps the backoff) without ever rebooting the camera - a camera reboot cannot fix an overloaded controller. The reachability gate is checked before the
 *      self-heal rule for exactly this reason, so a throttled controller never reboots a camera.
 *   2. Reboot a wedged camera. When the controller is reachable but a single camera will not reconnect after `LIVE_SELF_HEAL_THRESHOLD` consecutive failed
 *      reconnects, give up so the consumer reboots that camera and re-subscribes. The give-up is the self-heal trigger, not a terminal failure.
 *   3. Ease an idle stream off a stressed-but-reachable controller. When the controller is reachable but showing elevated symptoms, defer an idle (latency-tolerant)
 *      stream for a bounded window rather than piling reconnects onto it; a latency-sensitive consumer (an active recording) skips the defer and reconnects at once.
 *
 * A deliberate design property (not a bug): the library's `attempts` counter increments ONLY on a failed reconnect, never on a `wait`, so it is not poisoned during a
 * throttle wait. When the controller recovers, reconnects count fresh from 0, so a stretch of throttle-defers cannot reboot a camera the instant the controller
 * recovers.
 *
 * The consumer contract honored by the timeshift buffer and live streaming delegate (documented here, implemented there - do NOT implement in this module):
 *
 *   - The soft ease-off in step 5 exempts active recordings via `toleranceMs`. An active consumer (a live recording) must declare an `urgency()` strictly below
 *     SOFT_DEFER_STEP_MS so it reconnects immediately; an idle prebuffer must declare strictly above SOFT_DEFER_STEP_MS so it eases off. The library's media-stall
 *     detection floors at 2s regardless of the declared urgency, so the prebuffer stays watched at 2s either way. The timeshift buffer and live streaming delegate wire
 *     their `urgency()` closures to honor this split.
 *   - The self-heal in step 4 has a consumer side that also lives in those consumers, not here: catch `ProtectLivestreamUnavailableError` (which carries
 *     `{ attempts, phase }`) and reboot the camera, then re-subscribe, when `attempts >= LIVE_SELF_HEAL_THRESHOLD`. This module only declares the give-up; the
 *     reboot-and-resubscribe is theirs.
 */
import type { RecoveryContext, RecoveryDecision } from "unifi-protect";
import type { NvrHealthState } from "../nvr/nvr-health.ts";
import type { NvrPhase } from "../nvr/nvr.ts";
import { defaultLivestreamRecoveryPolicy } from "unifi-protect";
import { isInducedDisruption } from "../nvr/nvr-policy.ts";

// Consecutive failed reconnects on a reachable controller before the camera is rebooted. Exported because the consumer side - the timeshift buffer and
// live streaming delegate - reads it to decide when a caught give-up error means "reboot this camera" rather than "surface a terminal failure".
export const LIVE_SELF_HEAL_THRESHOLD = 10;

// Per-episode bound on the soft ease-off, in milliseconds. Once the episode has run this long, the soft ease-off escalates to a
// reconnect rather than easing off forever, so sustained symptoms advance the attempts counter toward the self-heal above.
const SOFT_DEFER_CEILING_MS = 8000;

// Soft ease-off re-poll granularity AND the active/idle threshold, in milliseconds: a stream that tolerates one step or less is "active" (latency-sensitive) and skips
// the defer; a stream that tolerates strictly more than one step is "idle" and eases off.
const SOFT_DEFER_STEP_MS = 1000;

// Re-poll interval, in milliseconds, while the controller is drowning, an induced disruption (our own reboot/shutdown) is in flight, or this camera is offline. We wait
// and re-consult rather than reconnect, so the episode does not burn reconnect attempts on a connection that cannot yet succeed - the controller or camera will return.
const LIVESTREAM_STRESS_WAIT_MS = 5000;

/**
 * The pure decision core of the plugin's livestream recovery policy. Given the library-observable {@link RecoveryContext} and a snapshot of the plugin's
 * controller-health and lifecycle-phase reads, it returns the {@link RecoveryDecision} the library's recovery loop will honor. It is pure - no live reads, no side
 * effects - so it is exhaustively unit-testable with constructed inputs, and the live reads are supplied by the thin closure wired at `ProtectClient.connect`.
 *
 * Establishment is delegated wholesale to the library default (it is hardware-bound and health-independent); past establishment the ordered policy is six steps, the
 * first match winning:
 *
 *   1. An induced disruption (our own reboot/shutdown) waits, so we do not fight our own teardown with reconnects.
 *   2. A drowning controller (the hard reachability gate) waits indefinitely and never reboots a camera.
 *   3. This one camera is offline on an otherwise-healthy controller, so wait for it to return rather than burn reconnect attempts toward the self-heal give-up.
 *   4. A wedged camera on a reachable controller gives up after the self-heal threshold, so the consumer reboots it.
 *   5. An idle stream under elevated-but-reachable symptoms eases off for a bounded window.
 *   6. Otherwise - healthy, latency-sensitive, or soft budget spent - reconnect with the library default's self-tuning timing.
 *
 * @param context - The library-observable recovery context (attempts, cameraId, elapsedMs, phase, toleranceMs).
 * @param nvr - A snapshot of the plugin's controller-health and lifecycle-phase reads at the decision point.
 * @param cameraReachable - Whether the episode's camera is currently reachable, resolved by the consumer's closure (the offline-defer gate's sole input).
 *
 * @returns The recovery decision for this step.
 */
export function livestreamRecoveryDecision(context: RecoveryContext,
  nvr: { healthState: NvrHealthState; isHealthy: boolean; isThrottled: boolean; phase: NvrPhase }, cameraReachable: boolean): RecoveryDecision {

  // Establishment is hardware-bound and health-independent: delegate to the library's patient default (30s deadline, 5/8/10s backoff) for provisioning.
  if(context.phase === "establishing") {

    return defaultLivestreamRecoveryPolicy(context);
  }

  // 1. Induced disruption: we are rebooting or shutting down the controller ourselves, so do not fight it with reconnects. Wait for it to clear; never give up here (the
  //    disconnect path disposes the subscription if we are truly tearing down, and a giveUp would needlessly surface a terminal error during our own reboot).
  if(isInducedDisruption(nvr.phase)) {

    return { forMs: LIVESTREAM_STRESS_WAIT_MS, kind: "wait" };
  }

  // 2. Hard reachability gate: the CONTROLLER is drowning (its breaker is open or it is unreachable). Wait it out until it recovers, and do NOT reboot the camera - a
  //    camera reboot cannot fix an overloaded controller. This reachability backoff returns before the self-heal check, so a throttled controller
  //    never reboots a camera. It never gives up; recovery resumes when the controller comes back.
  if(nvr.isThrottled || !nvr.isHealthy) {

    return { forMs: LIVESTREAM_STRESS_WAIT_MS, kind: "wait" };
  }

  // 3. This camera is offline. Steps 1-2 already cleared the controller (induced disruption, then drowning), so isReachable's controller half is necessarily true here -
  //    which means !cameraReachable is exactly "this one camera is offline" (rebooting, lost power, off the network), read through the single availability helper
  //    rather than a parallel device-online accessor. Reconnecting its livestream is futile until it returns, and a self-heal reboot cannot help a camera the controller
  //    already reports offline, so wait rather than burn reconnect attempts toward the self-heal give-up. The attempts counter only advances on a failed reconnect, never
  //    on a wait (the deliberate counter behavior above), so this defer costs zero attempts and the give-up is unreachable for an offline camera by construction. This
  //    offline defer is an intentional refinement of the policy.
  if(!cameraReachable) {

    return { forMs: LIVESTREAM_STRESS_WAIT_MS, kind: "wait" };
  }

  // 4. Self-heal: the controller is reachable but this camera will not reconnect. After LIVE_SELF_HEAL_THRESHOLD consecutive failed reconnects, give up so the consumer
  //    (a later step) reboots the wedged camera and re-subscribes. The library increments attempts only on a failed reconnect, so this is correctly reached only on a
  //    reachable controller that keeps failing real reconnects, never during a wait.
  if(context.attempts >= LIVE_SELF_HEAL_THRESHOLD) {

    return { kind: "giveUp" };
  }

  // 5. Soft ease-off: the controller is reachable but showing elevated symptoms. Ease an idle stream off the controller for a bounded window before reconnecting, rather
  //    than piling reconnects onto a stressed-but-reachable controller. A latency-sensitive consumer (an active recording) declares a tolerance below one defer step and
  //    so skips this, reconnecting immediately. The window is bounded by elapsedMs against the ceiling, so under sustained symptoms it escalates to a reconnect
  //    (advancing the attempts counter toward the self-heal above) rather than easing off forever.
  if((nvr.healthState !== "healthy") && (context.elapsedMs < SOFT_DEFER_CEILING_MS) && (context.toleranceMs > SOFT_DEFER_STEP_MS)) {

    return { forMs: SOFT_DEFER_STEP_MS, kind: "wait" };
  }

  // 6. Reconnect: the controller is healthy, or the consumer is latency-sensitive, or the soft ease-off budget is spent. Delegate the timing to the library default,
  //    whose await window self-tunes from the consumer's reported tolerance.
  return defaultLivestreamRecoveryPolicy(context);
}
