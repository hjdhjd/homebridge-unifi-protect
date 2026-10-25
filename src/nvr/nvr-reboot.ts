/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * nvr-reboot.ts: The controller's scheduled reboot, as a companion the controller hands its facts and its actions.
 *
 * A scheduled reboot is a deliberate outage inflicted on a controller that is working fine, so everything around the command matters more than the command itself: when
 * it fires, when a recording in flight is allowed to hold it back, how long holding back may go on, and how to tell a controller that accepted the command and restarted
 * from one that accepted it and did nothing at all. This module owns that whole choreography. The design follows three principles:
 *
 *   1. Facts in, actions out. The scheduler holds no controller reference and reads no controller state. The recording count, the connection health, and the lifecycle
 *      phase arrive as suppliers it pulls at its own fire time, so each decision reads the controller as of the instant it decides; the reboot command and the two phase
 *      moves are reached through the narrow {@link RebootSchedulerActions} surface handed at construction. That is what keeps this a decision rather than a second place
 *      the controller's lifecycle moves.
 *
 *   2. Mechanism vs policy separation. The deferral decision, the initial-delay arithmetic, and the recording-count rule are pure and live in nvr-policy.ts
 *      (`classifyRebootAttempt`, `computeInitialRebootDelay`, `countActiveRecordingViews`); the timer mechanism is the library's `TimerRegistry`, bound to the
 *      controller's lifetime signal. What is left here is the choreography: the order the acts run in, and what each outcome arms next.
 *
 *   3. Two timers, two fixed keys, one drain. The reboot cycle and the no-op confirmation each own a key, and the registry's replace-on-register rule is what makes
 *      every re-arm safe without a clear-then-set dance at each site. Teardown cancels both together, as the single act {@link RebootScheduler.reset} performs.
 *
 * The scheduler arms nothing at construction - entering the schedule is an explicit call - so a controller whose user never enabled scheduled reboots carries an inert
 * companion, and the controller's own configuration pass is the one place the feature turns on.
 */
import type { Clock, HomebridgePluginLogging } from "homebridge-plugin-utils";
import { PROTECT_NVR_REBOOT_CHECK_INTERVAL, PROTECT_NVR_REBOOT_CONFIRM_GRACE_MS, PROTECT_NVR_REBOOT_DEFERRAL_MAX, PROTECT_NVR_REBOOT_INTERVAL,
  PROTECT_NVR_REBOOT_MIN_INTERVAL } from "../settings.ts";
import { TimerRegistry, formatErrorMessage } from "homebridge-plugin-utils";
import { classifyRebootAttempt, computeInitialRebootDelay } from "./nvr-policy.ts";
import type { NvrPhase } from "./nvr.ts";
import { exhaustiveGuard } from "../types.ts";

/**
 * The acts the scheduler's decisions run, handed in at construction. Each one either commands the controller or moves its lifecycle phase - both the root's territory -
 * so the scheduler reaches them only through this surface and never holds the controller itself.
 */
export interface RebootSchedulerActions {

  // Move the lifecycle into its induced rebooting phase, ahead of the command. Suppressing the errors our own outage produces and pausing health observation both
  // follow from that phase rather than being separately arranged here.
  beginReboot: () => void;

  // Command the controller to reboot, through the live client. Throws a classified error when the command itself fails.
  reboot: () => Promise<void>;

  // Return the lifecycle to organic running operation. Both the failed-attempt rollback and the no-op confirmation land here.
  resumeRunning: () => void;
}

/**
 * Construction options for {@link RebootScheduler}.
 */
export interface RebootSchedulerOptions {

  actions: RebootSchedulerActions;
  // How many camera views are actively transmitting HomeKit Secure Video recordings right now. Pulled at each deferral check rather than pushed at it, so the decision
  // reads the recordings as of its own fire time rather than whatever was true when the timer was armed.
  activeRecordings: () => number;
  // The time source the scheduler reads each cycle instant from and arms its reboot cycle and its confirmation on.
  clock: Clock;
  // Whether the controller's connection is currently healthy - the no-op confirmation's test for a controller that took the command and never restarted.
  isConnectionHealthy: () => boolean;
  log: HomebridgePluginLogging;
  // The controller's current lifecycle phase, read by the no-op confirmation to confirm we are still inside the reboot it was armed for.
  phase: () => NvrPhase;
  // The controller's lifetime signal. The scheduler's timers bind to it, so teardown drains whatever is armed and a registration after it is inert.
  signal: AbortSignal;
}

// The reboot cycle's timer key. The initially-scheduled fire, every deferral or post-failure re-check, and the next full cycle all arm under it, so the newest intent
// for the cycle is the only one ever pending.
const REBOOT_CYCLE_TIMER = "cycle";

// The no-op confirmation's timer key, armed once per successful reboot command.
const REBOOT_CONFIRM_TIMER = "confirm";

/**
 * The scheduled reboot for one controller: when it fires, when a recording in flight holds it back, and how a command that took no effect is recognized.
 */
export class RebootScheduler {

  readonly #actions: RebootSchedulerActions;

  readonly #activeRecordings: () => number;

  readonly #clock: Clock;

  readonly #isConnectionHealthy: () => boolean;

  readonly #log: HomebridgePluginLogging;

  readonly #phase: () => NvrPhase;

  // The controller's lifetime signal, held so the attempt's own teardown checks read it live. A shutdown landing mid-attempt must not roll the phase back, re-arm
  // anything, or promise the user that connectivity will resume against a controller we are disposing.
  readonly #signal: AbortSignal;

  // Both timers the scheduler owns - the reboot cycle and the no-op confirmation - in one registry bound to the controller's lifetime, so teardown drains them as a
  // single act and nothing can arm against a torn-down controller.
  readonly #timers: TimerRegistry;

  public constructor(options: RebootSchedulerOptions) {

    this.#actions = options.actions;
    this.#activeRecordings = options.activeRecordings;
    this.#clock = options.clock;
    this.#isConnectionHealthy = options.isConnectionHealthy;
    this.#log = options.log;
    this.#phase = options.phase;
    this.#signal = options.signal;
    this.#timers = new TimerRegistry({ clock: options.clock, signal: options.signal });
  }

  /**
   * Note that the controller genuinely came back from the reboot, which makes the no-op confirmation moot: a real recovery is proof the command took effect, and the
   * confirmation exists only to catch a controller that accepted the command and never restarted. Silently does nothing when no confirmation is pending.
   */
  public noteRebootConfirmed(): void {

    this.#timers.clear(REBOOT_CONFIRM_TIMER);
  }

  /**
   * Cancel every pending timer, the reboot cycle and the no-op confirmation alike. Both are induced-lifecycle work that must not survive teardown, so the controller
   * runs this as it tears down, ahead of the lifetime signal's abort that disposes the registry as the backstop.
   */
  public reset(): void {

    this.#timers.clearAll();
  }

  /**
   * Enter the reboot schedule, or arm nothing when the requested interval is not a finite number of hours, the same as the option being off. The interval is clamped
   * to the configured minimum so a misconfigured option cannot put the controller into a reboot loop, and the first fire is anchored to the controller's own uptime so
   * restarting the plugin does not reset the cadence.
   *
   * @param options - requestedIntervalHours: the user's configured interval in hours, absent when the feature is enabled without an explicit value; upSince: the
   *                  controller's self-reported boot time.
   */
  public schedule(options: { requestedIntervalHours?: number; upSince: number }): void {

    // An interval that is not a finite number of hours names no schedule, the same as the option being off, so we warn and arm nothing. The check runs ahead of the
    // clamp, which would otherwise turn negative infinity into the minimum interval and reboot the controller every hour.
    if((options.requestedIntervalHours !== undefined) && !Number.isFinite(options.requestedIntervalHours)) {

      this.#log.warn("The scheduled reboot interval is not a number of hours, so no scheduled controller reboot will be set.");

      return;
    }

    // Apply the reboot interval, defaulting to the configured default if the option is enabled without an explicit value. We enforce a minimum interval to prevent the
    // controller from entering a reboot loop.
    const intervalHours = Math.max(options.requestedIntervalHours ?? PROTECT_NVR_REBOOT_INTERVAL, PROTECT_NVR_REBOOT_MIN_INTERVAL);
    const intervalMs = intervalHours * 60 * 60 * 1000;
    const delayMs = computeInitialRebootDelay({ intervalMs, nowMs: this.#clock.now(), upSince: options.upSince });

    this.#log.info("Scheduled controller reboot enabled every %s hour%s.", intervalHours, (intervalHours === 1) ? "" : "s");

    this.#timers.setTimeout(REBOOT_CYCLE_TIMER, () => void this.#execute({ intervalHours }), delayMs);
  }

  // Whether the controller's lifetime signal has fired - it is tearing down, and nothing this attempt was armed to do may still act. Read through a method so each of
  // the checks below re-reads the live signal at the instant it runs, rather than a snapshot taken before the reboot command went out.
  #isShuttingDown(): boolean {

    return this.#signal.aborted;
  }

  /* Run one scheduled-reboot attempt: decide whether it may proceed, command the reboot, and arm whatever comes next. `cycleStart` is absent on the originally-scheduled
   * fire and carries the timestamp of the first reschedule - a deferral or a post-failure retry - on every subsequent call. That makes the deferral ceiling a pure
   * function of the call chain rather than separate mutable state, and it lets a failure retry accumulate cycle time exactly as a deferral does.
   *
   * The reboot goes through the unifi-protect client's reboot command and its surviving connection layer: we POST the reboot and let the connection monitor, store, and
   * livestream pool stay up through the outage and auto-recover without recreating the client. The return to running is driven by the connection's recovery edge,
   * which the root observes and reports through {@link RebootScheduler.noteRebootConfirmed}, with the no-op confirmation below as the only other exit.
   *
   * @param options - cycleStart: when this reboot cycle first rescheduled; intervalHours: the cadence the next full cycle arms at.
   */
  async #execute(options: { cycleStart?: number; intervalHours: number }): Promise<void> {

    const { cycleStart, intervalHours } = options;

    // A teardown that landed between this timer being armed and now makes the whole reboot moot: the shutdown signal has aborted the lifecycle and the timers are being
    // cleared. Bail before any deferral accounting or sending a command against a disposing client.
    if(this.#isShuttingDown()) {

      return;
    }

    // Check whether any cameras are actively recording HKSV events. We defer if so, but only up to the deferral ceiling cumulatively...past that ceiling we force the
    // reboot regardless. An open-ended series of HKSV events would otherwise let the deferral chain run indefinitely, which defeats the point of having a scheduled
    // reboot in the first place.
    const activeRecordings = this.#activeRecordings();
    const elapsedCycleMs = (cycleStart !== undefined) ? (this.#clock.now() - cycleStart) : 0;
    const deferralCeilingMs = PROTECT_NVR_REBOOT_DEFERRAL_MAX * 1000;

    // Stamp the cycle start on the first reschedule; propagate it unchanged on subsequent ones so the ceiling is measured from the first attempt, not the last.
    const nextCycleStart = cycleStart ?? this.#clock.now();
    const decision = classifyRebootAttempt({ activeRecordings, ceilingMs: deferralCeilingMs, elapsedCycleMs });

    // Every arm terminates, so the reboot choreography below is reached only by the decision arms that let the attempt continue rather than return early.
    switch(decision) {

      case "defer":

        this.#log.info("Deferring scheduled controller reboot: %s camera%s actively recording HKSV events.", activeRecordings,
          (activeRecordings === 1) ? " is" : "s are");

        this.#timers.setTimeout(REBOOT_CYCLE_TIMER, () => void this.#execute({ cycleStart: nextCycleStart, intervalHours }), PROTECT_NVR_REBOOT_CHECK_INTERVAL);

        return;

      case "force":

        // Surface the ceiling-forced case so an operator can see why the reboot fired despite active recordings. This is rare; an info log keeps the signal visible
        // without turning a benign event into a warning.
        this.#log.info("Proceeding with scheduled controller reboot after %s minutes of deferrals; %s camera%s still recording HKSV events but the deferral limit " +
          "has been reached.", Math.round(deferralCeilingMs / 60000), activeRecordings, (activeRecordings === 1) ? " is" : "s are");

        break;

      case "proceed":

        break;

      default:

        exhaustiveGuard(decision);
    }

    // Move into the `rebooting` phase before sending the command. From this point until we know the outcome, any API errors are induced by our own action and should be
    // suppressed, and any livestream-stall or apiError symptoms are dropped by the health bridge, which closes observation in every non-`running` phase. On a failed
    // attempt below we return to `running` so the next retry surfaces real errors organically.
    this.#actions.beginReboot();

    try {

      // Reboot the controller through the unifi-protect client. It POSTs the UniFi-OS reboot and throws a classified error on a non-2xx response; the surviving
      // connection monitor and store stay up through the outage and auto-recover without recreating the client, so we do NOT tear anything down here.
      await this.#actions.reboot();
    } catch(error) {

      // A reboot rejection while the shutdown signal is aborted is induced by our own disposal, not a controller failure. Return without rolling the phase back,
      // logging an error, or re-arming: the phase is already terminal and the timers are being torn down.
      if(this.#isShuttingDown()) {

        this.#log.debug("Abandoning the scheduled reboot; the controller is shutting down.");

        return;
      }

      // The reboot command failed (a non-2xx, or a transport-level error). Roll back to `running` so error logging and health observation resume for the retry, and
      // reschedule at the deferral cadence - a failure is just another reason to try again the next time we check. Propagate the cycle start so the ceiling keeps
      // counting cumulative time across deferrals and retries.
      this.#actions.resumeRunning();
      this.#log.error("Unable to reboot the Protect controller: %s.", formatErrorMessage(error));

      this.#timers.setTimeout(REBOOT_CYCLE_TIMER, () => void this.#execute({ cycleStart: nextCycleStart, intervalHours }), PROTECT_NVR_REBOOT_CHECK_INTERVAL);

      return;
    }

    // A shutdown that landed while the reboot POST was in flight makes the confirmation and next-cycle arming moot, and the "connectivity will resume" promise would be
    // false against a controller we are disposing. Bail before the info log and before arming either timer.
    if(this.#isShuttingDown()) {

      return;
    }

    this.#log.info("Rebooting the Protect controller; connectivity will resume automatically once it returns.");

    /* Confirm the reboot actually took effect. A genuine reboot drops the controller's realtime connection within seconds - it arrives as an unsolicited socket close
     * that the unifi-protect library routes straight onto its recovery rail, so connection health goes false promptly and stays false for the minutes the controller
     * takes to return. If, after the grace window, we are still `rebooting` AND the connection never went unhealthy, the controller never actually restarted (a silent
     * no-op accept) and we must not stay suppressed on a perfectly healthy controller, so we resume normal monitoring. For a genuine reboot this check is inert - the
     * connection is unhealthy well within the grace, and the recovery edge drives the return instead. The grace is generous headroom over the seconds-scale real drop
     * (a pathologically slow-to-drop controller is the one case this could misread, and it self-heals: the late drop is then handled as an organic disruption).
     * Cancelled by a genuine recovery and by teardown.
     */
    this.#timers.setTimeout(REBOOT_CONFIRM_TIMER, () => {

      if((this.#phase() === "rebooting") && this.#isConnectionHealthy()) {

        this.#log.warn("The controller did not restart after the reboot command; resuming normal monitoring.");
        this.#actions.resumeRunning();
      }
    }, PROTECT_NVR_REBOOT_CONFIRM_GRACE_MS);

    // Schedule the next reboot cycle at the full interval. We do not block on the outage; the recovery edge returns us to `running` asynchronously.
    this.#timers.setTimeout(REBOOT_CYCLE_TIMER, () => void this.#execute({ intervalHours }), intervalHours * 60 * 60 * 1000);
  }
}
