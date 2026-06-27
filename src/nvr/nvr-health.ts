/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * nvr-health.ts: Cohesive observability for the NVR's current operating condition.
 *
 * This module models the *health* of a UniFi Protect NVR as a first-class, NVR-scoped concept that the rest of the plugin can read instead of having to stitch
 * the picture together from per-component counters and per-camera errors. The design follows three principles:
 *
 *   1. Health is *derived*, not *set*. Inputs are typed symptoms (`HealthSymptom`) flowing in from the components that observe them - the unifi-protect API
 *      layer for request results and throttle transitions, the livestream subscription seam for stall events. The state is computed by a pure reducer over a sliding
 *      window of those symptoms with hysteresis. There is no `setState` method. Callers can only `observe` symptoms.
 *
 *   2. Single source of truth, single home. There is exactly one NvrHealth per ProtectNvr. Every subsystem that wants to know "is the NVR OK?" reads
 *      `nvr.health.state`. Every subsystem that observes a symptom calls `nvr.health.observe(...)`. No parallel "is X stressed" flags scattered across classes.
 *
 *   3. Mechanism vs policy separation. This module owns the *mechanism*: the symptom buffer, the eviction window, the threshold transitions. The recovery
 *      policy that consumes the resulting state lives elsewhere (e.g., in livestream-recovery-policy.ts). State here is a value other code can map to actions; this
 *      module does not decide what to do.
 *
 * The reducer is a pure function `(state, symptom, now) => state'`, exported and independently testable. The class is a thin event-sink wrapper that drives
 * the reducer with a wall clock and emits a `stateChange` event when the derived state crosses a boundary.
 */
import { EventEmitter } from "node:events";

// Sliding window over which symptoms are weighed, in milliseconds. One minute is long enough to absorb a single retry burst without flipping state, short enough
// that genuine stress is observed promptly.
const HEALTH_WINDOW_MS = 60 * 1000;

// Hard cap on retained symptoms. Acts as a safety bound under pathological event-rate spikes; a window full of symptoms would already saturate the thresholds
// long before this cap would matter, so reaching it indicates we are observing far more events per window than the design assumed.
const HEALTH_BUFFER_CAP = 256;

// Symptom-count thresholds within the window. API errors and livestream stalls are weighted equally...both are first-order evidence of controller load, and
// treating them symmetrically lets the signal cross between paths (e.g., HTTP throttling becomes evidence for livestream backoff).
const DEGRADED_THRESHOLD = 5;
const STRESSED_THRESHOLD = 12;

// Hysteresis: returning to a healthier state requires the symptom count to drop below the lower bound, not just back to the threshold. Prevents flapping when a
// single recovery event nudges the count to exactly the threshold.
const DEGRADED_RELEASE = 3;
const STRESSED_RELEASE = 8;

/**
 * Stable categorical contract for the controller's current operating condition. Internal reducer transitions can change without breaking consumers because the
 * external surface stays a small ordered set: `healthy` < `degraded` < `stressed`.
 *
 *   - `healthy`: nominal. The controller is responsive; no recent symptom rate concerns.
 *   - `degraded`: elevated symptom rate. Reconnect-aggressive behavior should soften (e.g., defer non-urgent reconnects); critical paths still proceed.
 *   - `stressed`: sustained or library-acknowledged stress. Non-critical work should back off; only urgent paths (in-flight HKSV recordings, active live streams)
 *      should drive new requests at the controller.
 */
export type NvrHealthState = "degraded" | "healthy" | "stressed";

/**
 * Symptoms feed the reducer. Each variant carries the timestamp when the symptom occurred (stamped by the caller, so the reducer remains pure with respect to
 * wall time), and a discriminating `kind`. A `cameraId` is included on livestream variants so future policies can distinguish per-camera vs. correlated stress
 * without changing the symptom shape.
 *
 *   - `apiError`: an API request returned a failure (timeout, 4xx/5xx, network error, etc.).
 *   - `apiSuccess`: an API request returned a successful response. Counted as evidence of recovery; reduces the apparent symptom rate.
 *   - `livestreamStall`: a camera's livestream session detected a stall (the stall timer fired during streaming).
 *   - `livestreamRecovery`: a camera's livestream session resumed segment delivery after a stall.
 *   - `libraryThrottleEntered`: the unifi-protect library entered its internal throttle. A strong stress signal: the library has unilaterally paused
 *      communication with the controller for the duration of its cooldown.
 *   - `libraryThrottleReleased`: the unifi-protect library released its internal throttle. Evidence of recovery, but does not by itself reset the state...we wait
 *      for organic improvement (success events accumulating in the window) rather than auto-resetting on release.
 */
export type HealthSymptom =
  { at: number; kind: "apiError" } |
  { at: number; kind: "apiSuccess" } |
  { at: number; kind: "libraryThrottleEntered" } |
  { at: number; kind: "libraryThrottleReleased" } |
  { at: number; cameraId: string; kind: "livestreamRecovery" } |
  { at: number; cameraId: string; kind: "livestreamStall" };

/**
 * The reducer's persistent state. Exposed (via `NvrHealth.snapshot()`) for diagnostics and tests; not directly mutable.
 *
 *   - `state`: the current derived state, the externally-meaningful output.
 *   - `recentSymptoms`: the sliding-window buffer of symptoms within HEALTH_WINDOW_MS of the most recent observation. Old symptoms are evicted on each reduce.
 *   - `libraryThrottled`: latched flag for the library's throttle. While true, the state is forced to `stressed` regardless of symptom counts; releases on
 *      `libraryThrottleReleased`. Modeled as latched state rather than derived from buffer contents because the library throttle is a longer-lived condition than
 *      the symptom window.
 */
export interface HealthState {

  readonly libraryThrottled: boolean;
  readonly recentSymptoms: readonly HealthSymptom[];
  readonly state: NvrHealthState;
}

/**
 * Initial state. Exported so callers can construct a fresh state for tests or for replay scenarios without depending on the class.
 */
export function createInitialHealthState(): HealthState {

  return { libraryThrottled: false, recentSymptoms: [], state: "healthy" };
}

/**
 * Pure reducer. Given the previous state, a symptom, and the current wall time, returns the new state. Total: every symptom variant is handled, every transition
 * is explicit, and the function does not read external state. Callers that need to drive eviction without a new symptom can pass a synthetic `apiSuccess` (the
 * reducer evicts old entries on every call regardless of symptom kind) - in practice this is unnecessary because the consumer-facing `state` getter is correct
 * the moment the reducer has been called with any symptom.
 *
 * Stress evaluation prioritises the latched library-throttle flag: as long as the library has paused communication, we are stressed regardless of what the
 * symptom window says. Otherwise we count weighted symptoms and apply hysteresis against the previous state.
 */
export function reduceHealth(prev: HealthState, symptom: HealthSymptom, now: number): HealthState {

  // Update the latched library-throttle flag if applicable. The flag is the dominant input...nothing else can move us out of `stressed` while it's set.
  let libraryThrottled = prev.libraryThrottled;

  switch(symptom.kind) {

    case "libraryThrottleEntered":

      libraryThrottled = true;

      break;

    case "libraryThrottleReleased":

      libraryThrottled = false;

      break;

    default:

      break;
  }

  // Append the new symptom and evict any outside the sliding window. We then enforce the hard cap by trimming from the front, which preserves the most recent
  // symptoms - the ones most relevant to the current state.
  const cutoff = now - HEALTH_WINDOW_MS;
  const merged = [ ...prev.recentSymptoms, symptom ].filter((s) => s.at >= cutoff);
  const recentSymptoms = (merged.length > HEALTH_BUFFER_CAP) ? merged.slice(merged.length - HEALTH_BUFFER_CAP) : merged;

  // Compute the next state. Library throttle short-circuits to stressed.
  let nextState: NvrHealthState;

  if(libraryThrottled) {

    nextState = "stressed";
  } else {

    // Weight stress evidence against recovery evidence. apiError and livestreamStall add stress weight; apiSuccess and livestreamRecovery reduce it. The
    // library-throttle events are informational here and add no weight: the entered case has already forced stressed via the latched flag above, and the
    // released event only adjusts that flag.
    let stressWeight = 0;

    for(const s of recentSymptoms) {

      switch(s.kind) {

        case "apiError":
        case "livestreamStall":

          stressWeight++;

          break;

        case "apiSuccess":
        case "livestreamRecovery":

          stressWeight--;

          break;

        default:

          break;
      }
    }

    // Apply thresholds with hysteresis. The release thresholds are strictly less than the entry thresholds so we cannot oscillate between adjacent states on a
    // single symptom-count delta.
    nextState = transitionState(prev.state, stressWeight);
  }

  return { libraryThrottled: libraryThrottled, recentSymptoms: recentSymptoms, state: nextState };
}

// Discrete state-machine transition with hysteresis. Pure, exhaustive over the input state.
function transitionState(prev: NvrHealthState, weight: number): NvrHealthState {

  switch(prev) {

    case "healthy":

      if(weight >= STRESSED_THRESHOLD) {

        return "stressed";
      }

      if(weight >= DEGRADED_THRESHOLD) {

        return "degraded";
      }

      return "healthy";

    case "degraded":

      if(weight >= STRESSED_THRESHOLD) {

        return "stressed";
      }

      if(weight < DEGRADED_RELEASE) {

        return "healthy";
      }

      return "degraded";

    case "stressed":

      if(weight < STRESSED_RELEASE) {

        // We can only release one level at a time; falling out of `stressed` lands in `degraded`, which then has its own hysteresis to release further.
        return "degraded";
      }

      return "stressed";

    default: {

      const exhaustive: never = prev;

      throw new Error("Unhandled health state: " + String(exhaustive));
    }
  }
}

/**
 * Injectable clock for testability. Production uses {@link systemClock}; tests can substitute a deterministic clock to drive eviction without real time.
 */
export interface Clock {

  now(): number;
}

export const systemClock: Clock = { now: (): number => Date.now() };

/**
 * Event surface for {@link NvrHealth}. Listeners receive the new state on every transition; the previous state is provided for context (so listeners can
 * render directional log lines like "healthy -> degraded" without tracking it themselves).
 */
export interface NvrHealthEvents {

  stateChange: [next: NvrHealthState, previous: NvrHealthState];
}

/**
 * Thin event-sink wrapper around the reducer. Consumers call `observe()` with a symptom; the class drives the reducer with the injected clock, replaces its
 * internal state, and emits `stateChange` on transitions. The class exists so consumers do not have to thread the previous state through reduce calls themselves;
 * the reducer remains pure and independently testable.
 *
 * Lifecycle integration notes for future maintainers:
 *
 *   - `suspend()` / `resume()` are normally driven from `ProtectNvr.transition()` rather than called directly. The NVR's phase is the single source of truth for
 *      "induced vs organic disruption"; this class follows along. Calling `suspend()` directly is fine for tests but in production code should go through phase
 *      transitions so all derived effects (logApiErrors, future signals) stay aligned.
 *   - `reset()` clears the symptom buffer and forces the state back to `healthy` without emitting `stateChange`. Called by `ProtectNvr.connect()` after a
 *      successful reconnect; pre-disruption symptoms are no longer relevant. We deliberately do not emit on reset because that would surface a "responsive
 *      again" message at every reset boundary, which is misleading...the reset is internal bookkeeping, not a recovery event.
 *   - There is no "force healthy" method. Use `reset()` if you need to clear state. A force-healthy that emits a recovery event would be a footgun.
 *   - Initial state is `healthy`; the plugin assumes normalcy until proven otherwise. The NVR suspends observation in `connecting` phase so initial-connect
 *      errors do not bias the baseline.
 */
export class NvrHealth extends EventEmitter<NvrHealthEvents> {

  private current: HealthState;
  private suspended: boolean;
  private readonly clock: Clock;

  public constructor(clock: Clock = systemClock) {

    super();

    this.clock = clock;
    this.current = createInitialHealthState();
    this.suspended = false;
  }

  /**
   * Record a symptom. Drives the reducer with the current clock and emits a `stateChange` event if the derived state crossed a transition.
   *
   * The caller stamps the symptom's `at` field at the call site (typically `Date.now()`, but a different value is acceptable for replayed or queued symptoms).
   * The clock injected into NvrHealth is used as the eviction-window reference time on each call; it is not a fallback for `symptom.at`.
   *
   * No-op while suspended: symptoms observed during operations the plugin is intentionally driving are not signal we want to surface to consumers.
   */
  public observe(symptom: HealthSymptom): void {

    if(this.suspended) {

      return;
    }

    const next = reduceHealth(this.current, symptom, this.clock.now());

    if(next.state !== this.current.state) {

      const previous = this.current.state;

      this.current = next;
      this.emit("stateChange", next.state, previous);

      return;
    }

    this.current = next;
  }

  /**
   * Stop observing symptoms until {@link resume} is called. Used to bracket operations the plugin is intentionally driving (controlled disconnects, scheduled
   * reboots) so the induced API errors and stalls do not get surfaced as if they were organic controller stress. Idempotent.
   */
  public suspend(): void {

    this.suspended = true;
  }

  /**
   * Resume observing symptoms. Idempotent. Does not change the current state...if the parent wants a clean slate after the suspend window, it should call
   * {@link reset} explicitly.
   */
  public resume(): void {

    this.suspended = false;
  }

  /**
   * Clear the symptom buffer and force the state back to `healthy`. Does NOT emit `stateChange`...this is bookkeeping for "forget what came before this point,"
   * not a recovery event the user should see surfaced. Typical use: after a successful reconnect following a controller reboot or disconnect, where the
   * pre-disruption history is no longer relevant.
   */
  public reset(): void {

    this.current = createInitialHealthState();
  }

  /**
   * The current state. O(1) read; the reducer maintains it on every observation.
   */
  public get state(): NvrHealthState {

    return this.current.state;
  }

  /**
   * Diagnostic snapshot of the full reducer state. Intended for debug feature flags and for tests; not part of the steady-state read path.
   */
  public snapshot(): HealthState {

    return this.current;
  }
}
