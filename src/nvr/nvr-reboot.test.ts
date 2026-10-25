/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * nvr-reboot.test.ts: Behavior tests over the REAL RebootScheduler.
 *
 * The scheduler owns a deliberate outage: it decides when the plugin asks a healthy controller to restart, how long an HKSV recording in flight may hold that back, what
 * a failed command does, and how a controller that accepted the command and never restarted is recognized. This suite constructs it directly against recording stubs, so
 * what is exercised is the class itself rather than any controller wired to it: the schedule arithmetic, the deferral chain and its cumulative ceiling, the phase
 * choreography around the command, the no-op confirmation and each half of its guard, and the lifetime signal.
 *
 * Timing is the subject here, so every arm builds its scheduler on its own test clock and drives time by advancing it: every timer the scheduler arms goes through
 * that clock, and every instant it reads comes from it. Each arm builds its own scheduler and its own recorder, so no arm inherits a cycle another one left pending.
 * The reboot command is awaited, so an advance is followed by a settle - the advance runs the timer callback, and the settle lets the continuation past that await
 * run before anything is asserted.
 *
 * The pure arithmetic these decisions rest on (classifyRebootAttempt, computeInitialRebootDelay, countActiveRecordingViews) is proven as arithmetic in nvr.test.ts; this
 * suite tests the stateful class those functions serve and deliberately does not restate them. Honest coverage note: what the actions DO in production - commanding the
 * unifi-protect client and moving the controller's lifecycle phase - is the root's territory and stays untested here; the recorders prove only that the scheduler runs
 * them, in which order, and at which instants.
 */
import { PROTECT_NVR_REBOOT_CHECK_INTERVAL, PROTECT_NVR_REBOOT_CONFIRM_GRACE_MS, PROTECT_NVR_REBOOT_DEFERRAL_MAX, PROTECT_NVR_REBOOT_INTERVAL,
  PROTECT_NVR_REBOOT_MIN_INTERVAL } from "../settings.ts";
import { TestClock, settle } from "homebridge-plugin-utils/testing";
import { describe, test } from "node:test";
import type { Nullable } from "homebridge-plugin-utils";
import type { NvrPhase } from "./nvr.ts";
import { RebootScheduler } from "./nvr-reboot.ts";
import { TEST_CLOCK_EPOCH } from "./testing.helpers.ts";
import assert from "node:assert/strict";
import util from "node:util";

// The default cadence, in milliseconds - what an enabled-without-a-value schedule waits.
const DEFAULT_INTERVAL_MS = PROTECT_NVR_REBOOT_INTERVAL * 60 * 60 * 1000;

// The minimum cadence, in milliseconds - what an explicit interval below the floor clamps to.
const MINIMUM_INTERVAL_MS = PROTECT_NVR_REBOOT_MIN_INTERVAL * 60 * 60 * 1000;

// The span a row waits for a reboot that must never arm: past the default and the clamped minimum cadence, so a reboot armed at the default or at the minimum would
// have fired within it. The span is derived rather than written out, so a change to the default or the minimum carries the rows with it.
const NO_SCHEDULE_SPAN_MS = Math.max(DEFAULT_INTERVAL_MS, MINIMUM_INTERVAL_MS) + 1;

// The warning a requested interval that is not a finite number of hours logs in place of the enabled line.
const NO_SCHEDULE_WARNING = "The scheduled reboot interval is not a number of hours, so no scheduled controller reboot will be set.";

// The cumulative deferral ceiling, in milliseconds, and how many re-checks at the check cadence it spans. The span is derived rather than written out, so a change to
// either constant carries the arms with it.
const DEFERRAL_CEILING_MS = PROTECT_NVR_REBOOT_DEFERRAL_MAX * 1000;
const CHECKS_TO_CEILING = DEFERRAL_CEILING_MS / PROTECT_NVR_REBOOT_CHECK_INTERVAL;

// Everything the scheduler's actions, log, and suppliers exchanged with the test. A plain mutable record rather than closures with accessors: an arm reads
// recorder.rebootCalls or moves recorder.recordings directly, and the scheduler's own suppliers see that on their next pull.
interface SchedulerRecorder {

  // Every action the scheduler ran, in order, so an arm can assert the choreography's sequence rather than only its effects.
  actions: string[];
  // The connection-health fact the confirmation's guard pulls.
  healthy: boolean;
  logLines: string[];
  // The lifecycle phase the confirmation's guard pulls. The two phase actions move it, and an arm may move it directly to drive the guard's negatives.
  phase: NvrPhase;
  // The levers over a reboot command the builder was asked to hold open, so an arm can abort the lifetime signal while the command is genuinely in flight and then
  // decide how it ends. Null until the held command is issued.
  pendingReboot: Nullable<{ reject: (error: Error) => void; resolve: () => void }>;
  rebootCalls: number;
  // Set by an arm to make the NEXT command fail. Single-shot: the action consumes it as it throws.
  rebootError: Nullable<Error>;
  // The active-recording count the deferral check pulls. An arm moves it between ticks to drive a recording starting or finishing.
  recordings: number;
}

/* Build a scheduler against recording stubs.
 *
 * @param options - holdReboot: make the reboot command return a promise the arm resolves or rejects itself, so a teardown can land while the command is outstanding.
 *                  Omitted, the command settles immediately - throwing the injected error when one is set.
 *
 * @returns the scheduler, its recorder, the AbortController behind the lifetime signal, the scheduler's test clock (started at the harness epoch, since the schedule
 *          reads a controller upSince of zero as no boot time reported), and the advance that drives that clock.
 */
function buildScheduler(options: { holdReboot?: boolean } = {}): { advance: (ms: number) => Promise<void>; clock: TestClock; controller: AbortController;
  recorder: SchedulerRecorder; scheduler: RebootScheduler; } {

  const clock = new TestClock(TEST_CLOCK_EPOCH);
  const controller = new AbortController();
  const recorder: SchedulerRecorder = { actions: [], healthy: true, logLines: [], pendingReboot: null, phase: "running", rebootCalls: 0, rebootError: null,
    recordings: 0 };
  const sink = (message: string, ...parameters: unknown[]): void => {

    recorder.logLines.push(util.format(message, ...parameters));
  };

  const scheduler = new RebootScheduler({

    actions: {

      beginReboot: (): void => {

        recorder.actions.push("beginReboot");
        recorder.phase = "rebooting";
      },
      reboot: async (): Promise<void> => {

        recorder.actions.push("reboot");
        recorder.rebootCalls++;

        // Hand the arm the levers and wait on them, so the command stays outstanding until the arm ends it.
        if(options.holdReboot) {

          await new Promise<void>((resolve, reject) => {

            recorder.pendingReboot = { reject, resolve };
          });

          return;
        }

        const error = recorder.rebootError;

        if(error) {

          recorder.rebootError = null;

          throw error;
        }
      },
      resumeRunning: (): void => {

        recorder.actions.push("resumeRunning");
        recorder.phase = "running";
      }
    },
    activeRecordings: (): number => recorder.recordings,
    clock,
    isConnectionHealthy: (): boolean => recorder.healthy,
    log: { debug: sink, error: sink, info: sink, warn: sink },
    phase: (): NvrPhase => recorder.phase,
    signal: controller.signal
  });

  // Advance the scheduler's clock and let the reboot command's continuation run. Every arm below drives time through this, so no arm can assert against a
  // half-finished attempt.
  const advance = async (ms: number): Promise<void> => {

    clock.advance(ms);

    await settle();
  };

  return { advance, clock, controller, recorder, scheduler };
}

// Every line the scheduler logged that contains the given fragment.
function linesMatching(recorder: SchedulerRecorder, fragment: string): string[] {

  return recorder.logLines.filter((line) => line.includes(fragment));
}

describe("the reboot scheduler: entering the schedule", () => {

  test("a freshly-booted controller waits the whole interval before the first attempt", async () => {

    const { advance, controller, recorder, scheduler } = buildScheduler();

    try {

      scheduler.schedule({ requestedIntervalHours: PROTECT_NVR_REBOOT_INTERVAL, upSince: TEST_CLOCK_EPOCH });

      await advance(DEFAULT_INTERVAL_MS - 1);

      assert.equal(recorder.rebootCalls, 0, "one millisecond short of the interval, nothing has fired");

      await advance(1);

      assert.equal(recorder.rebootCalls, 1, "the interval elapsed and the first attempt commanded the reboot");
    } finally {

      // The abort drains every timer the scheduler armed on its test clock, so nothing this arm armed outlives it.
      controller.abort();
    }
  });

  test("a controller already up longer than the interval gets the settling floor rather than an immediate reboot", async () => {

    const { advance, controller, recorder, scheduler } = buildScheduler();

    try {

      // Up for twice the interval: the backdate would put the fire well in the past, so the floor is what governs.
      scheduler.schedule({ upSince: TEST_CLOCK_EPOCH - (2 * DEFAULT_INTERVAL_MS) });

      await advance(59999);

      assert.equal(recorder.rebootCalls, 0, "the floor has not elapsed, so nothing fired");

      await advance(1);

      assert.equal(recorder.rebootCalls, 1, "the sixty-second floor elapsed and the attempt ran");
    } finally {

      controller.abort();
    }
  });

  test("an interval below the minimum clamps to it, and the enabled line reads in the singular", async () => {

    const { advance, controller, recorder, scheduler } = buildScheduler();

    try {

      scheduler.schedule({ requestedIntervalHours: 0.25, upSince: TEST_CLOCK_EPOCH });

      assert.deepEqual(recorder.logLines, ["Scheduled controller reboot enabled every 1 hour."], "the clamped interval is what the user is told about");

      await advance(MINIMUM_INTERVAL_MS - 1);

      assert.equal(recorder.rebootCalls, 0, "a quarter-hour request did not fire at a quarter hour");

      await advance(1);

      assert.equal(recorder.rebootCalls, 1, "the clamped minimum is when it fired");
    } finally {

      controller.abort();
    }
  });

  test("an unspecified interval schedules at the default, and the enabled line reads in the plural", async () => {

    const { advance, controller, recorder, scheduler } = buildScheduler();

    try {

      scheduler.schedule({ upSince: TEST_CLOCK_EPOCH });

      assert.deepEqual(recorder.logLines, ["Scheduled controller reboot enabled every 6 hours."], "the default cadence is what the user is told about");

      await advance(DEFAULT_INTERVAL_MS - 1);

      assert.equal(recorder.rebootCalls, 0, "the default interval has not elapsed");

      await advance(1);

      assert.equal(recorder.rebootCalls, 1, "the default interval is when it fired");
    } finally {

      controller.abort();
    }
  });

  test("an infinite interval arms no reboot and warns once in place of the enabled line", async () => {

    const { advance, controller, recorder, scheduler } = buildScheduler();

    try {

      scheduler.schedule({ requestedIntervalHours: Infinity, upSince: TEST_CLOCK_EPOCH });

      assert.deepEqual(recorder.logLines, [NO_SCHEDULE_WARNING], "the user is told once that no reboot was set, and no enabled line claims a schedule");

      await advance(NO_SCHEDULE_SPAN_MS);

      assert.equal(recorder.rebootCalls, 0, "past the no-schedule span, nothing has fired");
    } finally {

      controller.abort();
    }
  });

  test("a negative infinite interval arms no reboot rather than clamping to the minimum, and warns once in place of the enabled line", async () => {

    const { advance, controller, recorder, scheduler } = buildScheduler();

    try {

      scheduler.schedule({ requestedIntervalHours: -Infinity, upSince: TEST_CLOCK_EPOCH });

      assert.deepEqual(recorder.logLines, [NO_SCHEDULE_WARNING], "the user is told once that no reboot was set, and no enabled line claims the clamped minimum");

      await advance(NO_SCHEDULE_SPAN_MS);

      assert.equal(recorder.rebootCalls, 0, "past the no-schedule span, nothing has fired, so no hourly cadence was armed at the clamped minimum");
    } finally {

      controller.abort();
    }
  });
});

describe("the reboot scheduler: deferring for active recordings", () => {

  test("a recording in flight holds the reboot back until the next check finds it finished", async () => {

    const { advance, controller, recorder, scheduler } = buildScheduler();

    try {

      recorder.recordings = 1;
      scheduler.schedule({ upSince: TEST_CLOCK_EPOCH });

      await advance(DEFAULT_INTERVAL_MS);

      assert.equal(recorder.rebootCalls, 0, "the recording held the reboot back");
      assert.deepEqual(linesMatching(recorder, "Deferring"), ["Deferring scheduled controller reboot: 1 camera is actively recording HKSV events."],
        "the deferral narrates the single recording in the singular");

      // A second camera starts recording, and the re-check a minute later defers again - the plural half of the same line.
      recorder.recordings = 2;

      await advance(PROTECT_NVR_REBOOT_CHECK_INTERVAL);

      assert.equal(recorder.rebootCalls, 0, "still recording, so still deferred");
      assert.deepEqual(linesMatching(recorder, "Deferring").at(-1), "Deferring scheduled controller reboot: 2 cameras are actively recording HKSV events.",
        "the deferral narrates two recordings in the plural");

      // The recordings finish, and the next check at the same cadence lets the reboot through.
      recorder.recordings = 0;

      await advance(PROTECT_NVR_REBOOT_CHECK_INTERVAL);

      assert.equal(recorder.rebootCalls, 1, "the check that found nothing recording commanded the reboot");
      assert.deepEqual(recorder.actions, [ "beginReboot", "reboot" ], "the phase moved into the reboot before the command went out");
    } finally {

      controller.abort();
    }
  });

  test("a recording that never finishes is overridden once the cumulative ceiling elapses", async () => {

    const { advance, clock, controller, recorder, scheduler } = buildScheduler();

    try {

      recorder.recordings = 1;
      scheduler.schedule({ upSince: TEST_CLOCK_EPOCH });

      // The first attempt defers and stamps the cycle, which is the instant the ceiling is measured from.
      await advance(DEFAULT_INTERVAL_MS);

      assert.equal(recorder.rebootCalls, 0, "the first attempt deferred");

      /* Every check short of the ceiling defers again, with the recording held open throughout. A deferral decides, narrates, and re-arms without ever awaiting, so
       * these ticks need no settle between them - and asserting straight after each tick is the stricter reading anyway, since a command would have been counted
       * synchronously before its own await.
       */
      for(let check = 0; check < (CHECKS_TO_CEILING - 1); check++) {

        clock.advance(PROTECT_NVR_REBOOT_CHECK_INTERVAL);

        assert.equal(recorder.rebootCalls, 0, "the ceiling still has headroom, so the deferral continues");
      }

      await advance(PROTECT_NVR_REBOOT_CHECK_INTERVAL);

      assert.equal(recorder.rebootCalls, 1, "the cumulative ceiling elapsed and the reboot went out despite the recording");
      assert.deepEqual(linesMatching(recorder, "Proceeding"), ["Proceeding with scheduled controller reboot after 15 minutes of deferrals; 1 camera is still " +
        "recording HKSV events but the deferral limit has been reached."], "the forced case is narrated with the ceiling in minutes and the recording count");
    } finally {

      controller.abort();
    }
  });
});

describe("the reboot scheduler: the reboot attempt", () => {

  test("a failed command rolls the phase back, narrates the failure, and retries at the check cadence", async () => {

    const { advance, controller, recorder, scheduler } = buildScheduler();

    try {

      recorder.rebootError = new Error("the controller refused the command");
      scheduler.schedule({ upSince: TEST_CLOCK_EPOCH });

      await advance(DEFAULT_INTERVAL_MS);

      assert.deepEqual(recorder.actions, [ "beginReboot", "reboot", "resumeRunning" ], "the failed attempt returned the controller to organic operation");
      assert.equal(recorder.phase, "running", "the rollback left the lifecycle running so the retry surfaces real errors");
      assert.deepEqual(linesMatching(recorder, "Unable to reboot"), ["Unable to reboot the Protect controller: the controller refused the command."],
        "the failure is narrated once, carrying the controller's own reason");

      await advance(PROTECT_NVR_REBOOT_CHECK_INTERVAL - 1);

      assert.equal(recorder.rebootCalls, 1, "nothing retried before the check cadence elapsed");

      await advance(1);

      assert.equal(recorder.rebootCalls, 2, "the retry ran at the check cadence, and this time the command succeeded");
    } finally {

      controller.abort();
    }
  });

  test("the deferral ceiling keeps counting across a failure and the deferrals that follow it", async () => {

    const { advance, clock, controller, recorder, scheduler } = buildScheduler();

    try {

      recorder.rebootError = new Error("the controller refused the command");
      scheduler.schedule({ upSince: TEST_CLOCK_EPOCH });

      // The failed attempt stamps the cycle, exactly as a deferral would.
      await advance(DEFAULT_INTERVAL_MS);

      assert.equal(recorder.rebootCalls, 1, "the failed command counts as an attempt");

      /* From here a recording holds every retry back. The ceiling is measured from the FAILURE's reschedule, so the force lands exactly one ceiling's worth of checks
       * after it - which is what tells the threaded cycle start apart from a mutant that dropped it: restarting the count at each reschedule would leave the last
       * check below the ceiling and still deferring.
       */
      recorder.recordings = 1;

      // As in the ceiling arm above, a deferral runs entirely inside its own timer callback, so these ticks need no settle between them.
      for(let check = 0; check < (CHECKS_TO_CEILING - 1); check++) {

        clock.advance(PROTECT_NVR_REBOOT_CHECK_INTERVAL);

        assert.equal(recorder.rebootCalls, 1, "the ceiling still has headroom, so the retry defers rather than commanding");
      }

      await advance(PROTECT_NVR_REBOOT_CHECK_INTERVAL);

      assert.equal(recorder.rebootCalls, 2, "the ceiling, counted from the failed attempt, forced the reboot");
    } finally {

      controller.abort();
    }
  });

  test("a successful command narrates the outage and arms the next cycle at the full interval", async () => {

    const { advance, controller, recorder, scheduler } = buildScheduler();

    try {

      scheduler.schedule({ upSince: TEST_CLOCK_EPOCH });

      await advance(DEFAULT_INTERVAL_MS);

      assert.deepEqual(recorder.actions, [ "beginReboot", "reboot" ], "the phase moved into the reboot before the command, and nothing rolled it back");
      assert.deepEqual(linesMatching(recorder, "Rebooting"), ["Rebooting the Protect controller; connectivity will resume automatically once it returns."],
        "the user is told the outage is expected and will end on its own");

      // A genuine reboot drops the connection, which leaves the no-op confirmation inert - so what the ticks below measure is the next cycle alone.
      recorder.healthy = false;

      await advance(DEFAULT_INTERVAL_MS - 1);

      assert.equal(recorder.rebootCalls, 1, "nothing re-fired before the full interval elapsed");

      await advance(1);

      assert.equal(recorder.rebootCalls, 2, "the next cycle armed at the full interval and a second attempt began");
    } finally {

      controller.abort();
    }
  });
});

describe("the reboot scheduler: the no-op confirmation", () => {

  test("a controller that never restarted is caught at the grace and resumed", async () => {

    const { advance, controller, recorder, scheduler } = buildScheduler();

    try {

      scheduler.schedule({ upSince: TEST_CLOCK_EPOCH });

      await advance(DEFAULT_INTERVAL_MS);

      assert.equal(recorder.phase, "rebooting", "the command went out and the lifecycle is waiting on the controller");

      // Still rebooting, and the connection never went unhealthy: the controller took the command and did nothing.
      await advance(PROTECT_NVR_REBOOT_CONFIRM_GRACE_MS);

      assert.deepEqual(linesMatching(recorder, "did not restart"), ["The controller did not restart after the reboot command; resuming normal monitoring."],
        "the silent no-op accept is surfaced to the user");
      assert.deepEqual(recorder.actions, [ "beginReboot", "reboot", "resumeRunning" ], "monitoring resumed rather than staying suppressed on a healthy controller");
      assert.equal(recorder.phase, "running", "the lifecycle is back to organic operation");
    } finally {

      controller.abort();
    }
  });

  test("a lifecycle that has already left the reboot is not disturbed at the grace", async () => {

    const { advance, controller, recorder, scheduler } = buildScheduler();

    try {

      scheduler.schedule({ upSince: TEST_CLOCK_EPOCH });

      await advance(DEFAULT_INTERVAL_MS);

      // The controller came back and the root moved the lifecycle on. This is the conjunct that tells a genuine return apart from a timer that merely happened to be
      // cleared: with the phase moved, the guard must refuse even though the connection reads healthy.
      recorder.phase = "running";

      await advance(PROTECT_NVR_REBOOT_CONFIRM_GRACE_MS);

      assert.deepEqual(linesMatching(recorder, "did not restart"), [], "nothing was narrated about a reboot the lifecycle had already left");
      assert.deepEqual(recorder.actions, [ "beginReboot", "reboot" ], "no second resume ran");
    } finally {

      controller.abort();
    }
  });

  test("a genuinely rebooting controller whose connection dropped is not disturbed at the grace", async () => {

    const { advance, controller, recorder, scheduler } = buildScheduler();

    try {

      scheduler.schedule({ upSince: TEST_CLOCK_EPOCH });

      await advance(DEFAULT_INTERVAL_MS);

      // The reboot is genuinely under way: the connection dropped, which is the fact this conjunct exists to recognize.
      recorder.healthy = false;

      await advance(PROTECT_NVR_REBOOT_CONFIRM_GRACE_MS);

      assert.deepEqual(linesMatching(recorder, "did not restart"), [], "a controller that really is rebooting is not accused of ignoring the command");
      assert.deepEqual(recorder.actions, [ "beginReboot", "reboot" ], "the resume is left to the connection's recovery edge");
      assert.equal(recorder.phase, "rebooting", "the lifecycle stays suppressed for the outage that is actually happening");
    } finally {

      controller.abort();
    }
  });

  test("a confirmed reboot cancels the confirmation outright", async () => {

    const { advance, controller, recorder, scheduler } = buildScheduler();

    try {

      scheduler.schedule({ upSince: TEST_CLOCK_EPOCH });

      await advance(DEFAULT_INTERVAL_MS);

      // The controller came back and the root reported it. Everything else is left as the no-op case's arrangement - phase rebooting, connection healthy - so the
      // cancellation is the only thing that can account for the silence below.
      scheduler.noteRebootConfirmed();

      await advance(PROTECT_NVR_REBOOT_CONFIRM_GRACE_MS);

      assert.deepEqual(linesMatching(recorder, "did not restart"), [], "the confirmation was cancelled, so the grace passed silently");
      assert.deepEqual(recorder.actions, [ "beginReboot", "reboot" ], "nothing resumed on a reboot that was already confirmed");
    } finally {

      controller.abort();
    }
  });
});

describe("the reboot scheduler: teardown", () => {

  test("the drain cancels a pending cycle", async () => {

    const { advance, controller, recorder, scheduler } = buildScheduler();

    try {

      scheduler.schedule({ upSince: TEST_CLOCK_EPOCH });
      scheduler.reset();

      await advance(2 * DEFAULT_INTERVAL_MS);

      assert.equal(recorder.rebootCalls, 0, "the drained cycle never fired");
    } finally {

      controller.abort();
    }
  });

  test("a schedule entered after the lifetime signal aborts arms nothing", async () => {

    const { advance, controller, recorder, scheduler } = buildScheduler();

    try {

      controller.abort();
      scheduler.schedule({ upSince: TEST_CLOCK_EPOCH });

      await advance(2 * DEFAULT_INTERVAL_MS);

      assert.equal(recorder.rebootCalls, 0, "the registry was retired, so the arm was inert");
    } finally {

      controller.abort();
    }
  });

  test("aborting the lifetime signal drains a cycle already armed", async () => {

    const { advance, controller, recorder, scheduler } = buildScheduler();

    try {

      scheduler.schedule({ upSince: TEST_CLOCK_EPOCH });
      controller.abort();

      await advance(DEFAULT_INTERVAL_MS);

      assert.equal(recorder.rebootCalls, 0, "the abort drained the armed cycle before it could reach its fire instant");
    } finally {

      controller.abort();
    }
  });

  test("a command rejected after teardown neither rolls back nor retries", async () => {

    const { advance, controller, recorder, scheduler } = buildScheduler({ holdReboot: true });

    try {

      scheduler.schedule({ upSince: TEST_CLOCK_EPOCH });

      await advance(DEFAULT_INTERVAL_MS);

      const pending = recorder.pendingReboot;

      assert.ok(pending, "the command is outstanding");
      assert.equal(recorder.rebootCalls, 1, "exactly one command went out");

      // Teardown lands while the command is still in flight, and the disposing connection is what rejects it.
      controller.abort();
      pending.reject(new Error("the connection was torn down"));

      await settle();

      assert.deepEqual(recorder.actions, [ "beginReboot", "reboot" ], "no rollback ran against a lifecycle that is already terminal");
      assert.deepEqual(linesMatching(recorder, "Unable to reboot"), [], "our own disposal is not reported to the user as a controller failure");
      assert.deepEqual(linesMatching(recorder, "Abandoning"), ["Abandoning the scheduled reboot; the controller is shutting down."],
        "the abandonment is recorded for the debug log alone");

      await advance(2 * DEFAULT_INTERVAL_MS);

      assert.equal(recorder.rebootCalls, 1, "nothing was re-armed");
    } finally {

      controller.abort();
    }
  });

  test("a command that succeeds after teardown promises nothing and arms nothing", async () => {

    const { advance, controller, recorder, scheduler } = buildScheduler({ holdReboot: true });

    try {

      scheduler.schedule({ upSince: TEST_CLOCK_EPOCH });

      await advance(DEFAULT_INTERVAL_MS);

      const pending = recorder.pendingReboot;

      assert.ok(pending, "the command is outstanding");

      // Teardown lands while the command is in flight, and the controller accepts it anyway.
      controller.abort();
      pending.resolve();

      await settle();

      assert.deepEqual(linesMatching(recorder, "Rebooting"), [], "connectivity is not promised for a controller we are disposing");

      await advance(PROTECT_NVR_REBOOT_CONFIRM_GRACE_MS);

      assert.deepEqual(linesMatching(recorder, "did not restart"), [], "no confirmation was armed to fire");
      assert.deepEqual(recorder.actions, [ "beginReboot", "reboot" ], "nothing resumed the lifecycle out of its terminal phase");

      await advance(2 * DEFAULT_INTERVAL_MS);

      assert.equal(recorder.rebootCalls, 1, "no next cycle was armed");
    } finally {

      controller.abort();
    }
  });
});
