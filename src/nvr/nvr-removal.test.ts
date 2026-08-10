/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * nvr-removal.test.ts: Behavior tests over the REAL RemovalStabilityGate.
 *
 * The gate owns the plugin's one destructive decision - whether a removal is allowed at all, and when the removal it permits actually runs. This suite constructs it
 * directly against recording stubs, so what is exercised is the class itself rather than any controller wired to it: the stability arithmetic at its boundaries, the
 * first-stabilization latch that tells an initial startup entry from a later recovery, the one-shot sweep, the first-deadline-wins grace, the fire-time re-check, the
 * cancellation paths, the narration, and the lifetime signal.
 *
 * Timing is the subject here, so every arm runs under node:test's mocked timers with the mock enabled BEFORE construction: the gate arms nothing at construction, and
 * enabling first means every timer it later arms is mock-armed and tick-drivable. Each arm builds its own gate, because the first-stabilization latch is a one-way fact
 * about the object's life that a shared instance would carry from one arm into the next.
 *
 * The pure arithmetic these decisions rest on (computeStableSince, isStabilityWindowElapsed) is pinned as arithmetic in nvr.test.ts; this suite pins the stateful class
 * those functions serve, and deliberately does not restate them. Honest coverage note: what runSweep DOES in production - the controller's sweepRemovableDevices - is
 * the root's territory and stays untested; the recorder here proves only that the gate calls it, and at which instants.
 */
import { describe, mock, test } from "node:test";
import { PROTECT_NVR_REMOVAL_STABILITY_WINDOW } from "../settings.ts";
import type { ProtectAccessory } from "../types.ts";
import { RemovalStabilityGate } from "./nvr-removal.ts";
import { asProtectAccessory } from "./testing.helpers.ts";
import assert from "node:assert/strict";
import { makeTestAccessory } from "../testing.helpers.ts";
import util from "node:util";

// The wall-clock instant every arm's mocked clock starts from. A controller's upSince is a real timestamp, and the gate reads an upSince of zero as "no boot time
// reported" - the arm that counts from now rather than backdating. Starting the clock at a realistic instant keeps a test's "up for N milliseconds" fact from landing
// on that value by arithmetic accident, which a clock seeded at zero does the moment it has advanced exactly N.
const MOCK_EPOCH = 1700000000000;

// Everything the gate's actions and log wrote, plus the grace the supplier answers with. A plain mutable record rather than closures with accessors: an arm reads
// recorder.sweeps or moves recorder.grace directly, which is what the gate's own suppliers and actions see on their next call.
interface GateRecorder {

  grace: number;
  logLines: string[];
  removals: ProtectAccessory[];
  sweeps: number;
}

// Build a gate against recording stubs, with a victim accessory to schedule. The accessory is a harness accessory presented through the harness's own boundary cast -
// this suite invents no accessory shape of its own, so what the gate's API receives is the same object every other suite hands it.
function buildGate(options: { graceSeconds?: number } = {}): { accessory: ReturnType<typeof makeTestAccessory>; controller: AbortController;
  gate: RemovalStabilityGate; recorder: GateRecorder; } {

  const controller = new AbortController();
  const recorder: GateRecorder = { grace: options.graceSeconds ?? 60, logLines: [], removals: [], sweeps: 0 };
  const sink = (message: string, ...parameters: unknown[]): void => {

    recorder.logLines.push(util.format(message, ...parameters));
  };

  const gate = new RemovalStabilityGate({

    actions: {

      removeDevice: (accessory: ProtectAccessory): void => { recorder.removals.push(accessory); },
      runSweep: (): void => { recorder.sweeps++; }
    },
    graceSeconds: (): number => recorder.grace,
    log: { debug: sink, error: sink, info: sink, warn: sink },
    signal: controller.signal
  });

  return { accessory: makeTestAccessory("Victim", "uuid:victim"), controller, gate, recorder };
}

// Push a good-state fact carrying the given uptime. A full-window uptime is the trusted long-up posture the plugin extends to a controller that has been up longer than
// the settling window; a shallower one leaves the remainder of the window to run.
function pushGood(gate: RemovalStabilityGate, uptimeMs: number): void {

  gate.refresh({ good: true, upSince: Date.now() - uptimeMs });
}

// The delay-narration lines the gate emitted, which are the only lines it writes unless a caller supplied a reason.
function delayingLines(recorder: GateRecorder): string[] {

  return recorder.logLines.filter((line) => line.includes("Delaying device removal"));
}

describe("the removal-stability gate: the good-state clock", () => {

  test("a partial uptime is trusted only as far as it goes - stability arrives when the remainder of the window elapses", () => {

    mock.timers.enable({ apis: [ "Date", "setTimeout" ], now: MOCK_EPOCH });

    const { controller, gate } = buildGate();

    try {

      // A controller up for a third of the window: the entry is backdated by exactly that, so two thirds of the window remain.
      pushGood(gate, 200000);

      assert.equal(gate.removalStable, false, "a controller up for less than the window is not yet trusted");

      mock.timers.tick(PROTECT_NVR_REMOVAL_STABILITY_WINDOW - 200000 - 1);

      assert.equal(gate.removalStable, false, "one millisecond short of the window, removal is still barred");

      mock.timers.tick(1);

      assert.equal(gate.removalStable, true, "the window elapsed, so removal is allowed");
    } finally {

      // Every timer this suite arms is armed under the mock, so the drain runs while the mock that armed them is still installed - the opposite ordering from a fixture
      // whose timers were armed under real time.
      controller.abort();
      mock.timers.reset();
    }
  });

  test("recovery counts from now: after the first stabilization the uptime backdate no longer applies", () => {

    mock.timers.enable({ apis: [ "Date", "setTimeout" ], now: MOCK_EPOCH });

    const { controller, gate } = buildGate();

    try {

      // A genuine first stabilization, which is what sets the latch. Without this opening the destabilize below would be a no-op against a null clock and the
      // "restabilize" would take the first-ever branch, so the backdate would be honored and the arm would prove nothing.
      pushGood(gate, PROTECT_NVR_REMOVAL_STABILITY_WINDOW);

      assert.equal(gate.removalStable, true, "a long-up controller is trusted on the first entry");

      gate.refresh({ good: false });

      assert.equal(gate.removalStable, false, "leaving good state bars removal at once");

      // The recovery, carrying the same fully-backdated uptime the first entry did. It is deliberately ignored: a disruption we observed resets our trust regardless of
      // how long the controller process has been up.
      pushGood(gate, PROTECT_NVR_REMOVAL_STABILITY_WINDOW);

      assert.equal(gate.removalStable, false, "the recovery counts from now, so the backdate buys nothing");

      mock.timers.tick(PROTECT_NVR_REMOVAL_STABILITY_WINDOW - 1);

      assert.equal(gate.removalStable, false, "one millisecond short of a full fresh window, removal is still barred");

      mock.timers.tick(1);

      assert.equal(gate.removalStable, true, "a full fresh window after the recovery, removal is allowed again");
    } finally {

      controller.abort();
      mock.timers.reset();
    }
  });
});

describe("the removal-stability gate: the one-shot sweep", () => {

  test("a long-up entry arms the sweep at no delay, fires it exactly once, and an agreeing second push arms nothing", () => {

    mock.timers.enable({ apis: [ "Date", "setTimeout" ], now: MOCK_EPOCH });

    const { controller, gate, recorder } = buildGate();

    try {

      pushGood(gate, PROTECT_NVR_REMOVAL_STABILITY_WINDOW);

      assert.equal(recorder.sweeps, 0, "the sweep is armed rather than run inline");

      mock.timers.tick(0);

      assert.equal(recorder.sweeps, 1, "the zero-delay sweep ran on the next macrotask");

      // A push that agrees with the state the gate is already in is a no-op, so the root can push on every fact change without ceremony.
      pushGood(gate, PROTECT_NVR_REMOVAL_STABILITY_WINDOW);
      mock.timers.tick(PROTECT_NVR_REMOVAL_STABILITY_WINDOW);

      assert.equal(recorder.sweeps, 1, "an agreeing second good push neither re-armed nor re-ran the sweep");
    } finally {

      controller.abort();
      mock.timers.reset();
    }
  });

  test("a partial-uptime entry defers the sweep to the exact instant the window elapses", () => {

    mock.timers.enable({ apis: [ "Date", "setTimeout" ], now: MOCK_EPOCH });

    const { controller, gate, recorder } = buildGate();

    try {

      pushGood(gate, 200000);
      mock.timers.tick(PROTECT_NVR_REMOVAL_STABILITY_WINDOW - 200000 - 1);

      assert.equal(recorder.sweeps, 0, "the sweep does not run before the window is complete");

      mock.timers.tick(1);

      assert.equal(recorder.sweeps, 1, "the sweep ran as the window completed");
    } finally {

      controller.abort();
      mock.timers.reset();
    }
  });
});

describe("the removal-stability gate: leaving good state drains everything", () => {

  test("a pending grace is dropped by the disruption, and the accessory can be scheduled afresh once stability returns", () => {

    mock.timers.enable({ apis: [ "Date", "setTimeout" ], now: MOCK_EPOCH });

    const { accessory, controller, gate, recorder } = buildGate();

    try {

      pushGood(gate, PROTECT_NVR_REMOVAL_STABILITY_WINDOW);

      // Retire the sweep first, so the drain assertion below watches the grace alone. The two can coexist briefly - a backdated entry leaves the zero-delay sweep
      // registered but unfired while a grace is already schedulable - and banking the sweep here is what keeps this arm's observable single.
      mock.timers.tick(0);

      assert.equal(recorder.sweeps, 1, "the sweep is spent");

      gate.schedule({ accessory: asProtectAccessory(accessory), stillGone: () => true });
      gate.refresh({ good: false });
      mock.timers.tick(PROTECT_NVR_REMOVAL_STABILITY_WINDOW);

      assert.deepEqual(recorder.removals, [], "the disruption dropped the pending grace before it could fire");
      assert.equal(recorder.sweeps, 1, "and no sweep ran either");

      // The staleness re-check that a partial clear cannot survive: a registry entry left behind for this accessory would silently dedup the fresh schedule away, so
      // the fresh grace firing is what proves the drain reached the keyed timer rather than only the sweep.
      pushGood(gate, PROTECT_NVR_REMOVAL_STABILITY_WINDOW);
      mock.timers.tick(PROTECT_NVR_REMOVAL_STABILITY_WINDOW);
      gate.schedule({ accessory: asProtectAccessory(accessory), stillGone: () => true });
      mock.timers.tick(60000);

      assert.deepEqual(recorder.removals, [asProtectAccessory(accessory)], "the same accessory scheduled afresh armed and fired");
    } finally {

      controller.abort();
      mock.timers.reset();
    }
  });

  test("a sweep still pending when the disruption arrives never runs", () => {

    mock.timers.enable({ apis: [ "Date", "setTimeout" ], now: MOCK_EPOCH });

    const { controller, gate, recorder } = buildGate();

    try {

      // A partial uptime leaves the sweep pending at the remaining window, which is the state a disruption has to reach into.
      pushGood(gate, 200000);
      gate.refresh({ good: false });
      mock.timers.tick(PROTECT_NVR_REMOVAL_STABILITY_WINDOW);

      assert.equal(recorder.sweeps, 0, "the pending sweep was drained by the disruption");
    } finally {

      controller.abort();
      mock.timers.reset();
    }
  });
});

describe("the removal-stability gate: scheduling a removal", () => {

  test("first deadline wins: a re-schedule inside the grace keeps the original deadline and removes exactly once", () => {

    mock.timers.enable({ apis: [ "Date", "setTimeout" ], now: MOCK_EPOCH });

    const { accessory, controller, gate, recorder } = buildGate();

    try {

      pushGood(gate, PROTECT_NVR_REMOVAL_STABILITY_WINDOW);
      gate.schedule({ accessory: asProtectAccessory(accessory), stillGone: () => true });
      gate.schedule({ accessory: asProtectAccessory(accessory), stillGone: () => true });

      // The dedup is silent, so the single narration line is what marks the second call as a no-op: a device that keeps re-yielding while it stays gone must not have
      // its grace restarted on every yield.
      assert.equal(delayingLines(recorder).length, 1, "the redundant schedule narrated nothing of its own");

      mock.timers.tick(60000);

      assert.equal(recorder.removals.length, 1, "the accessory was removed exactly once");
    } finally {

      controller.abort();
      mock.timers.reset();
    }
  });

  test("with the grace disabled the removal is immediate, and nothing is left armed behind it", () => {

    mock.timers.enable({ apis: [ "Date", "setTimeout" ], now: MOCK_EPOCH });

    const { accessory, controller, gate, recorder } = buildGate({ graceSeconds: 0 });

    try {

      pushGood(gate, PROTECT_NVR_REMOVAL_STABILITY_WINDOW);
      gate.schedule({ accessory: asProtectAccessory(accessory), stillGone: () => true });

      assert.equal(recorder.removals.length, 1, "the removal ran synchronously inside the schedule call");
      assert.deepEqual(delayingLines(recorder), [], "no delay is narrated when none is taken");

      // The no-timer-armed negative, proven behaviorally: a timer armed alongside the immediate removal would fire a second one here.
      mock.timers.tick(PROTECT_NVR_REMOVAL_STABILITY_WINDOW);

      assert.equal(recorder.removals.length, 1, "no armed timer followed the immediate removal");
    } finally {

      controller.abort();
      mock.timers.reset();
    }
  });

  test("the fire re-reads live state: a device that returned during its grace is not removed", () => {

    mock.timers.enable({ apis: [ "Date", "setTimeout" ], now: MOCK_EPOCH });

    const { accessory, controller, gate, recorder } = buildGate();

    try {

      let gone = true;

      pushGood(gate, PROTECT_NVR_REMOVAL_STABILITY_WINDOW);
      gate.schedule({ accessory: asProtectAccessory(accessory), stillGone: () => gone });

      // The device comes back inside its grace, which is the whole point of having one.
      gone = false;

      mock.timers.tick(60000);

      // The stability half of the fire-time conjunction has no isolated pin here, and that is deliberate: reaching the fire with a dropped clock would require a drain
      // that failed to pair with the clock drop, and leaving good state performs both as a single act, so that term is defense in depth rather than a reachable branch.
      assert.deepEqual(recorder.removals, [], "the returned device was not removed");
    } finally {

      controller.abort();
      mock.timers.reset();
    }
  });

  test("cancelFor drops a pending removal, and cancelling an accessory that holds none is silent", () => {

    mock.timers.enable({ apis: [ "Date", "setTimeout" ], now: MOCK_EPOCH });

    const { accessory, controller, gate, recorder } = buildGate();

    try {

      pushGood(gate, PROTECT_NVR_REMOVAL_STABILITY_WINDOW);
      gate.schedule({ accessory: asProtectAccessory(accessory), stillGone: () => true });
      gate.cancelFor(accessory.UUID);

      assert.doesNotThrow(() => gate.cancelFor("uuid:never-scheduled"), "cancelling an accessory with no pending removal does nothing");

      mock.timers.tick(PROTECT_NVR_REMOVAL_STABILITY_WINDOW);

      assert.deepEqual(recorder.removals, [], "the cancelled grace never fired");
    } finally {

      controller.abort();
      mock.timers.reset();
    }
  });

  test("an unstable controller schedules nothing at all - no timer, no removal, and no narration", () => {

    mock.timers.enable({ apis: [ "Date", "setTimeout" ], now: MOCK_EPOCH });

    const { accessory, controller, gate, recorder } = buildGate();

    try {

      // Never stabilized: the gate is in the state a plugin start against an unreachable controller leaves it in.
      gate.schedule({ accessory: asProtectAccessory(accessory), reason: "The controller no longer reports this device.", stillGone: () => true });

      assert.deepEqual(recorder.logLines, [], "the stability gate returns ahead of any logging, so a suppressed schedule is entirely silent");

      mock.timers.tick(PROTECT_NVR_REMOVAL_STABILITY_WINDOW);

      assert.deepEqual(recorder.removals, [], "nothing was armed while the controller was untrusted");

      // The same call once the controller has settled is the positive control: it arms, narrates, and fires.
      pushGood(gate, PROTECT_NVR_REMOVAL_STABILITY_WINDOW);
      gate.schedule({ accessory: asProtectAccessory(accessory), reason: "The controller no longer reports this device.", stillGone: () => true });
      mock.timers.tick(60000);

      assert.equal(recorder.removals.length, 1, "the identical call landed once the controller was trusted");
    } finally {

      controller.abort();
      mock.timers.reset();
    }
  });
});

describe("the removal-stability gate: narration", () => {

  test("the caller's reason is logged once at schedule time, and the delay line carries the resolved interval", () => {

    mock.timers.enable({ apis: [ "Date", "setTimeout" ], now: MOCK_EPOCH });

    const { accessory, controller, gate, recorder } = buildGate();

    try {

      pushGood(gate, PROTECT_NVR_REMOVAL_STABILITY_WINDOW);
      gate.schedule({ accessory: asProtectAccessory(accessory), reason: "The controller no longer reports this device.", stillGone: () => true });

      assert.deepEqual(recorder.logLines, [ "The controller no longer reports this device.", "Victim: Delaying device removal for at least 60 seconds." ],
        "the reason is narrated once at schedule time, followed by the delay line carrying the resolved interval");

      mock.timers.tick(60000);

      assert.equal(recorder.logLines.length, 2, "the fire itself narrates nothing");
    } finally {

      controller.abort();
      mock.timers.reset();
    }
  });

  test("a one-second grace is narrated in the singular", () => {

    mock.timers.enable({ apis: [ "Date", "setTimeout" ], now: MOCK_EPOCH });

    const { accessory, controller, gate, recorder } = buildGate({ graceSeconds: 1 });

    try {

      pushGood(gate, PROTECT_NVR_REMOVAL_STABILITY_WINDOW);
      gate.schedule({ accessory: asProtectAccessory(accessory), stillGone: () => true });

      assert.deepEqual(delayingLines(recorder), ["Victim: Delaying device removal for at least 1 second."], "a single-second grace reads as one second, not one seconds");
    } finally {

      controller.abort();
      mock.timers.reset();
    }
  });
});

describe("the removal-stability gate: the lifetime signal", () => {

  test("teardown drains a pending grace, and a schedule after teardown arms nothing", () => {

    mock.timers.enable({ apis: [ "Date", "setTimeout" ], now: MOCK_EPOCH });

    const { accessory, controller, gate, recorder } = buildGate();

    try {

      pushGood(gate, PROTECT_NVR_REMOVAL_STABILITY_WINDOW);
      gate.schedule({ accessory: asProtectAccessory(accessory), stillGone: () => true });

      controller.abort();

      mock.timers.tick(PROTECT_NVR_REMOVAL_STABILITY_WINDOW);

      assert.deepEqual(recorder.removals, [], "teardown drained the pending grace");

      // A post-teardown schedule still passes the stability gate and still narrates - the clock is untouched by an abort - so what is asserted is the absence of the
      // REMOVAL: the registry is retired, so no timer arms and nothing can fire later.
      gate.schedule({ accessory: asProtectAccessory(accessory), stillGone: () => true });
      mock.timers.tick(PROTECT_NVR_REMOVAL_STABILITY_WINDOW);

      assert.deepEqual(recorder.removals, [], "a schedule against a torn-down gate can never produce a removal");
    } finally {

      mock.timers.reset();
    }
  });
});
