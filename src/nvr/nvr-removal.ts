/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * nvr-removal.ts: The controller's removal-stability decision, as a companion the controller pushes facts into.
 *
 * Removing an accessory is the plugin's one destructive act, so it is gated on the controller having been continuously good for a settling window. This module owns
 * that whole decision - the good-state clock, the window, the delayed-removal graces, and the single chokepoint every controller-state-driven removal routes through.
 * The design follows three principles:
 *
 *   1. Facts in, actions out. The gate holds no controller reference and reads no controller state. The root recomputes the good-state conjunction and PUSHES the
 *      result through `refresh`; every act that touches the accessory graph is reached through the narrow {@link RemovalGateActions} surface handed at construction.
 *      That is what keeps the gate a decision rather than a second place removal happens.
 *
 *   2. Mechanism vs policy separation. The arithmetic is pure and lives in nvr-policy.ts (`computeStableSince`, `isStabilityWindowElapsed`); the timer mechanism is
 *      the library's `TimerRegistry`, bound to the controller's lifetime signal. What is left here is the policy: when the clock starts, when it drops, and what a
 *      removal request is allowed to do.
 *
 *   3. One drain, one rule. Leaving good-state means "all bets are off, no destructive action": the clock drops and every pending timer cancels together, as the
 *      single act {@link RemovalStabilityGate.reset} performs. Because the sweep one-shot and the per-accessory graces live in one registry, that rule cannot be
 *      half-applied.
 *
 * The gate is constructed once per controller and never rebuilt, because its first-stabilization latch is a fact about this process's whole life rather than about
 * the current connection.
 */
import type { HomebridgePluginLogging, Nullable } from "homebridge-plugin-utils";
import { computeStableSince, isStabilityWindowElapsed } from "./nvr-policy.ts";
import { PROTECT_NVR_REMOVAL_STABILITY_WINDOW } from "../settings.ts";
import type { ProtectAccessory } from "../types.ts";
import { TimerRegistry } from "homebridge-plugin-utils";

/**
 * The controller fact the root pushes into the gate. The uptime exists ONLY on the good arm: the controller projection is readable only once the client exists, and
 * the good arm's own truth guarantees that it does. A push assembled during the pre-connect window therefore cannot carry an uptime by construction rather than by
 * caller discipline.
 */
export type RemovalStabilityFacts = { good: false } | { good: true; upSince: number };

/**
 * The acts the gate's decisions run, handed in at construction. Both touch the accessory graph, which is the root's territory, so the gate reaches them only through
 * this surface and never holds the controller itself.
 */
export interface RemovalGateActions {

  // Remove an accessory from HomeKit - the default action a removal decision runs when the caller supplies none of its own.
  removeDevice: (accessory: ProtectAccessory) => void;

  // Re-assess the full device inventory. Run once per good-state period, when the stability window first elapses.
  runSweep: () => void;
}

/**
 * A removal request. `reason` is a user-facing sentence logged once at schedule time; `remove` overrides the default removal act for callers whose removal is not a
 * plain accessory removal (the package camera's detach); `stillGone` is re-evaluated against live controller state when the grace fires.
 */
export interface RemovalScheduleOptions {

  accessory: ProtectAccessory;
  reason?: string;
  remove?: () => void;
  stillGone: () => boolean;
}

/**
 * Construction options for {@link RemovalStabilityGate}.
 */
export interface RemovalStabilityGateOptions {

  actions: RemovalGateActions;
  // The user's configured removal grace, in seconds, resolved per request rather than captured, so a live configuration change governs the next removal.
  graceSeconds: () => number;
  log: HomebridgePluginLogging;
  // The controller's lifetime signal. The gate's timers bind to it, so teardown drains whatever is armed and a registration after it is inert.
  signal: AbortSignal;
}

/**
 * The removal-stability decision for one controller: whether destructive removal is currently allowed, and the graced scheduling of the removals it permits.
 */
export class RemovalStabilityGate {

  readonly #actions: RemovalGateActions;

  readonly #graceSeconds: () => number;

  // True once the controller has reached good-state at least once, which tells the initial startup entry (uptime-backdated) apart from a later recovery (counted from
  // now). It pairs with the clock below under one rule the shape cannot state on its own: the latch flips true only in the same act that stamps the clock, and only
  // the clock is ever cleared. The latch is therefore a one-way fact about this process's life, while the clock tracks the current good-state period.
  #hasStabilizedOnce = false;

  readonly #log: HomebridgePluginLogging;

  // The instant the controller entered its current continuous good state, or null when it is not good. Backdated by the controller's uptime at the first good-state
  // entry so a long-up controller is trusted immediately.
  #stableSince: Nullable<number> = null;

  // Every timer the gate owns: the one-shot stability sweep as an anonymous entry, and each pending delayed removal keyed by accessory UUID. One registry is what lets
  // the leaving-good-state rule cancel all of them as a single act.
  readonly #timers: TimerRegistry;

  public constructor(options: RemovalStabilityGateOptions) {

    this.#actions = options.actions;
    this.#graceSeconds = options.graceSeconds;
    this.#log = options.log;
    this.#timers = new TimerRegistry({ signal: options.signal });
  }

  /**
   * Cancel a single pending delayed removal by accessory UUID - a returning orphan, or a package capability that came back during its detach grace. Silently does
   * nothing when the accessory holds no pending removal.
   *
   * @param uuid - The accessory UUID whose pending removal to cancel.
   */
  public cancelFor(uuid: string): void {

    this.#timers.clear(uuid);
  }

  /**
   * Drive the good-state clock from a pushed controller fact. Entering good-state stamps the clock and arms the one-shot sweep; leaving it drops the clock and every
   * pending removal. A push that agrees with the current state is a no-op, so the root can push on every fact change without ceremony.
   *
   * @param facts - See {@link RemovalStabilityFacts}.
   */
  public refresh(facts: RemovalStabilityFacts): void {

    if(facts.good && (this.#stableSince === null)) {

      // One instant serves the stamp, the uptime backdate, and the delay arithmetic below, so all three describe the same moment rather than three reads that could
      // straddle a millisecond boundary and disagree.
      const nowMs = Date.now();

      // A zero uptime reads as absent: the controller has reported no boot time we could backdate from, so the period counts from now.
      this.#stableSince = computeStableSince({ hasStabilizedBefore: this.#hasStabilizedOnce, nowMs, uptimeMs: facts.upSince ? (nowMs - facts.upSince) : 0,
        windowMs: PROTECT_NVR_REMOVAL_STABILITY_WINDOW });
      this.#hasStabilizedOnce = true;

      // What REMAINS of the window from the stamped instant, which is zero for a controller already up longer than the window.
      const delay = Math.max(0, (this.#stableSince + PROTECT_NVR_REMOVAL_STABILITY_WINDOW) - nowMs);

      /* Arm the one-shot sweep. It needs no key: this branch is the only place it arms and it requires a null clock, which the same branch immediately falsifies, so a
       * second arming cannot happen while one is pending; and the full drain is the only thing that cancels it. The keyed namespace is therefore nothing but accessory
       * UUIDs, with no reserved-key convention to reason about.
       *
       * At startup a zero delay runs the sweep in a later macrotask, after the controller's initial device population - a benign double reconcile, since reconciling
       * is repeatable and the orphan pass reads the live adopted-mac projection rather than the configured set, so it cannot evict an adopted-but-not-yet-configured
       * accessory whatever the ordering.
       */
      this.#timers.schedule(() => this.#actions.runSweep(), delay);

      return;
    }

    if(!facts.good && (this.#stableSince !== null)) {

      this.reset();
    }
  }

  /**
   * Whether the controller has been continuously good for at least the stability window - the gate every destructive removal must pass. Recomputed on every read
   * rather than memoized, because a grace armed inside the window fires outside it and must see the answer as of its own fire time.
   */
  public get removalStable(): boolean {

    return isStabilityWindowElapsed({ nowMs: Date.now(), stableSinceMs: this.#stableSince, windowMs: PROTECT_NVR_REMOVAL_STABILITY_WINDOW });
  }

  /**
   * Leave good-state: drop the clock and cancel every pending timer, the sweep one-shot and each delayed removal alike. This is the "all bets are off, no destructive
   * action during a disruption" rule as one act, so the clock and the timers can never disagree. The first-stabilization latch is deliberately untouched - it records
   * that this process has stabilized before, which a disruption does not undo.
   */
  public reset(): void {

    this.#stableSince = null;
    this.#timers.clearAll();
  }

  /* Mark an accessory for removal, honoring the user's removal grace. This is the single removal chokepoint every controller-state-driven removal routes through, and
   * the stability policy lives here: nothing schedules unless the controller has been continuously good for the window. The membership and orphan callers pre-gate on
   * `removalStable` before calling, so the in-chokepoint gate is deliberately redundant for them - it exists so the policy holds for every caller by construction
   * rather than by caller discipline. With the grace disabled (interval 0) we remove immediately - the stability gate already provided the safety. Keyed by accessory
   * UUID: the one id shared by a membership leave, an id-less cache orphan, and a package camera.
   *
   * @param options - See {@link RemovalScheduleOptions}.
   */
  public schedule(options: RemovalScheduleOptions): void {

    const { accessory, reason, stillGone } = options;
    const remove = options.remove ?? ((): void => this.#actions.removeDevice(accessory));

    if(!this.removalStable) {

      return;
    }

    // First deadline wins: an accessory already inside its grace keeps the deadline it was given. Registering under a key replaces whatever it held, so without this
    // guard a device that keeps re-yielding while it stays gone would have its grace restarted on every yield and could outlive any bound.
    if(this.#timers.has(accessory.UUID)) {

      return;
    }

    const delayInterval = this.#graceSeconds();

    // Narrate the removal decision once, at schedule time, when the caller supplied a reason - the one user-facing message for the whole removal flow.
    if(reason) {

      this.#log.info(reason);
    }

    if(delayInterval <= 0) {

      remove();

      return;
    }

    this.#log.info("%s: Delaying device removal for at least %s second%s.", accessory.displayName, delayInterval, delayInterval > 1 ? "s" : "");

    this.#timers.setTimeout(accessory.UUID, () => {

      // The caller's predicate is what decides here: it re-reads live controller state, so a device that returned during the grace is not removed. Re-confirming
      // stability alongside it is defense in depth - reaching this line with the clock dropped would mean a drain had failed to pair with the clock drop, which
      // reset() makes a single act.
      if(this.removalStable && stillGone()) {

        remove();
      }
    }, delayInterval * 1000);
  }
}
