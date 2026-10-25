/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * snapshot.test.ts: Behavior coverage of ProtectSnapshot's multi-source acquisition: the timeshift-freshness branch (finding #5), the package-camera ordering, the cache
 * window, and the hedge that runs a slow RTSP attempt beside a delayed controller-API attempt.
 *
 * The acquisition chain tries the timeshift buffer first, then RTSP with the controller command hedged beside it once RTSP runs long, then the cache. The hedge's
 * timing and abort rules are driven directly through the exported hedgeSnapshotAttempts on the host's TestClock, with each attempt a controllable double, because
 * a real RTSP attempt spawns FFmpeg. The rest of this suite drives the whole chain over doubles and asserts
 * SOURCE SELECTION - which source the chain uses - never a real FFmpeg spawn: the timeshift buffer's snapshotSource is steered to "stale" or "empty" so the buffer
 * declines before the FFmpeg pipeline, and the RTSP and controller sources are wired to decline too (no channel to select, the controller command rejects), so the whole
 * chain resolves without producing (or caching) any image. The assertions that matter are that a STALE buffer declines and notes it at debug (so a stalled buffer never
 * serves, and then caches, a frozen image), that an EMPTY buffer declines SILENTLY (no staleness to claim), and that in both cases the chain moves past the buffer to the
 * next source. The freshness DECISION itself - whether the buffer reads fresh, stale, or empty - is covered directly over ProtectTimeshiftBuffer in timeshift.test.ts.
 */
import type { HedgedSnapshot, SnapshotAttempt } from "./snapshot.ts";
import { ProtectSnapshot, hedgeSnapshotAttempts, snapshotCutoff } from "./snapshot.ts";
import type { TestClock, TestLogEntry } from "homebridge-plugin-utils/testing";
import { TestStreamingDelegate, makeTimeshiftSupervisorDouble } from "../testing.helpers.ts";
import { after, describe, test } from "node:test";
import { logCount, settle, settleUntil } from "homebridge-plugin-utils/testing";
import type { Nullable } from "homebridge-plugin-utils";
import type { SnapshotSource } from "./timeshift.ts";
import type { StreamingDelegate } from "./stream-delegate.ts";
import type { TestCameraHost } from "./testing.helpers.ts";
import assert from "node:assert/strict";
import { makeTestCameraHost } from "./testing.helpers.ts";
import { onAbort } from "homebridge-plugin-utils";

// Every host this suite builds shares its makeTestNvr AbortController. Aborting them in teardown releases the harness signals.
const controllers: AbortController[] = [];

after(() => {

  for(const controller of controllers) {

    controller.abort();
  }
});

// Build a ProtectSnapshot over a camera host whose timeshift buffer's snapshotSource is steered to the given decline kind, and whose RTSP and controller sources decline
// without spawning FFmpeg (no channel to select, the controller command rejects). The whole acquisition chain therefore runs spawn-free. selectCalls counts the RTSP
// channel selection so a test can prove the chain moved past the declined buffer, and clock is the host's test clock, which stamps and ages the snapshot cache.
function buildSnapshot(kind: "empty" | "stale"):
{ clock: TestClock; host: TestCameraHost; logEntries: readonly TestLogEntry[]; selectCalls: { count: number }; snapshot: ProtectSnapshot } {

  const { clock, controller, host, logEntries } = makeTestCameraHost();

  controllers.push(controller);

  // The timeshift/RTSP sources are gated behind high-resolution snapshots; enable it so the buffer source is actually consulted.
  host.hints.highResSnapshots = true;

  const stream = new TestStreamingDelegate();
  const supervisor = makeTimeshiftSupervisorDouble();

  supervisor.buffer.snapshotSource = (): SnapshotSource => ({ kind });
  stream.timeshift = supervisor as unknown as StreamingDelegate["timeshift"];
  host.stream = stream;

  // RTSP declines without spawning; count the calls to prove it was attempted after the buffer declined.
  const selectCalls = { count: 0 };

  host.selectChannel = (): null => {

    selectCalls.count++;

    return null;
  };

  // The controller source rejects too, so the whole chain resolves null without producing (or caching) any image.
  host.snapshotFromController = (): Promise<Buffer> => Promise.reject(new Error("controller declined"));

  return { clock, host, logEntries, selectCalls, snapshot: new ProtectSnapshot(host) };
}

describe("ProtectSnapshot timeshift freshness", () => {

  // #5: a stale buffer must NOT serve (and then cache) a frozen image. The buffer declines, notes the stale decline at debug, and the chain moves past it to the RTSP
  // source. With every source wired to decline the acquisition resolves null, so nothing frozen is served or cached.
  test("a stale buffer declines, notes it at debug, caches nothing, and the RTSP source is selected", async () => {

    const { logEntries, selectCalls, snapshot } = buildSnapshot("stale");

    const image = await snapshot.getSnapshot();

    await settle();

    assert.equal(image, null, "the stale buffer served nothing, and no source produced an image to cache");
    assert.ok(logCount(logEntries, "debug", "timeshift buffer is stale") >= 1, "the stale decline was noted at debug");
    assert.ok(selectCalls.count > 0, "the chain moved past the stale buffer and selected the RTSP source");
  });

  // #5: an empty buffer (no keyframe yet) declines SILENTLY - there is no staleness to claim - and the chain moves past it just the same.
  test("an empty buffer declines without staleness logging", async () => {

    const { logEntries, selectCalls, snapshot } = buildSnapshot("empty");

    const image = await snapshot.getSnapshot();

    await settle();

    assert.equal(image, null, "the empty buffer served nothing, and no source produced an image to cache");
    assert.equal(logCount(logEntries, "debug", "timeshift buffer is stale"), 0, "an empty buffer declines silently - no staleness is claimed");
    assert.ok(selectCalls.count > 0, "the chain moved past the empty buffer and selected the RTSP source");
  });
});

describe("ProtectSnapshot package-camera source ordering", () => {

  // The package camera's uniquely-ordered acquisition: with no timeshift snapshot, the package tries the Protect API before RTSP - its low frame rate makes an RTSP
  // response lengthy - so a succeeding controller snapshot must arrive carrying the packageCamera request flag with the RTSP source untouched. The row pins the
  // isPackageCameraContext branch's sense at this site: a flipped or absent predicate routes the package down the device ordering and selects RTSP first.
  test("a package-camera context tries the controller before RTSP and flags the package request", async () => {

    const { host, selectCalls, snapshot } = buildSnapshot("empty");

    host.accessory.context.packageCamera = "AA:BB:CC:DD:EE:FF";

    const controllerCalls: { packageCamera?: boolean }[] = [];

    host.snapshotFromController = (options): Promise<Buffer> => {

      controllerCalls.push({ packageCamera: options?.packageCamera });

      return Promise.resolve(Buffer.from("package-snapshot"));
    };

    const image = await snapshot.getSnapshot();

    await settle();

    assert.ok(image, "the controller snapshot served the package camera");
    assert.equal(controllerCalls.length, 1, "the controller source was tried exactly once");
    assert.equal(controllerCalls[0]?.packageCamera, true, "the controller request carried the package flag");
    assert.equal(selectCalls.count, 0, "the package ordering left the RTSP source untouched");
  });
});

describe("ProtectSnapshot cache window", () => {

  // The cache's maximum age, which snapshot.ts keeps module-private: a failed acquisition falls back to a cached image until it is this old on the platform's clock.
  const CACHE_WINDOW_MS = 90 * 1000;

  test("a failed acquisition serves the cached snapshot while it is inside the cache window, and nothing once the clock has moved past it", async () => {

    const { clock, host, logEntries, snapshot } = buildSnapshot("empty");

    // The controller source serves one image, which the chain caches stamped with the clock's instant, and declines every request after it.
    let controllerCalls = 0;

    host.snapshotFromController = (): Promise<Buffer> => {

      controllerCalls++;

      return (controllerCalls === 1) ? Promise.resolve(Buffer.from("cached-snapshot")) : Promise.reject(new Error("controller declined"));
    };

    const first = await snapshot.getSnapshot();

    assert.equal(first?.toString(), "cached-snapshot", "the controller source served the first snapshot, which the chain cached");

    // The window is bounded on both sides: an image exactly as old as the window still serves a failed acquisition, and one tick older does not.
    clock.advance(CACHE_WINDOW_MS);

    const cached = await snapshot.getSnapshot();

    assert.equal(cached?.toString(), "cached-snapshot", "a failed acquisition serves the cached snapshot while it is inside the cache window");
    assert.equal(logCount(logEntries, "warn", "using the most recent cached snapshot"), 1, "the cache fallback is reported");

    clock.advance(1);

    const expired = await snapshot.getSnapshot();

    assert.equal(expired, null, "a failed acquisition serves nothing once the cached snapshot has aged past the window");
    assert.equal(logCount(logEntries, "error", "Unable to retrieve a snapshot."), 1, "the failure with no usable cache is reported");
    assert.equal(controllerCalls, 3, "every acquisition reached the controller source before falling back");
  });
});

/* A controllable snapshot attempt for the hedge rows. Its one call records the clock time it started and the signal it runs under, and settles when the row answers
 * it, or with null a turn after its signal aborts, the way a real source's FFmpeg settles only once the kill has landed. That turn is what lets a row tell a hedge
 * that waits for its loser to settle from one that returns while the loser is still winding down.
 */
interface AttemptDouble {

  // Settle the attempt with an image, or with null for a decline.
  answer(image: Nullable<Buffer>): void;
  readonly attempt: SnapshotAttempt;
  readonly calls: { signal: AbortSignal; startedAt: number }[];
  readonly settled: boolean;
}

function makeAttemptDouble(clock: TestClock): AttemptDouble {

  const calls: { signal: AbortSignal; startedAt: number }[] = [];
  const { promise, resolve } = Promise.withResolvers<Nullable<Buffer>>();

  let settled = false;

  const finish = (image: Nullable<Buffer>): void => {

    if(settled) {

      return;
    }

    settled = true;
    resolve(image);
  };

  return {

    answer: finish,
    attempt: async (signal: AbortSignal): Promise<Nullable<Buffer>> => {

      calls.push({ signal, startedAt: clock.now() });
      onAbort(signal, () => setImmediate(() => finish(null)));

      return promise;
    },
    calls,
    get settled(): boolean {

      return settled;
    }
  };
}

/* The hedge's timing and abort rules, driven on the camera host's test clock. RTSP runs alone until the hedge point, measured from the acquisition's start; a decline
 * before then starts the controller-API attempt at once; past it, the API attempt runs beside RTSP and the first image wins, except that an API image waits for
 * RTSP's for at most the held-image wait, never past the grace cutoff. Every row also reads what the hedge left behind the moment it resolved, because an attempt
 * still running then would outlive the acquisition's deadline.
 */
describe("hedgeSnapshotAttempts - a slow RTSP attempt hedged by a delayed controller-API attempt", () => {

  // The hedge's timing, which snapshot.ts keeps module-private, transcribed so a drift in any of it reddens a row: the controller-API attempt joins a still-running
  // RTSP attempt this long after the acquisition began, a held API image waits for RTSP for at most the held-image wait, and the cutoff it never waits past is the
  // acquisition budget less the reaping reserve, and less the crop allowance too when cropping is on.
  const HEDGE_DELAY_MS = 2500;
  const BUDGET_MS = 4990;
  const REAPING_RESERVE_MS = 250;
  const CROP_ALLOWANCE_MS = 1000;
  const HELD_IMAGE_WAIT_MS = 1000;
  const CUTOFF_MS = BUDGET_MS - REAPING_RESERVE_MS;
  const CROPPED_CUTOFF_MS = CUTOFF_MS - CROP_ALLOWANCE_MS;

  const API_IMAGE = Buffer.from("api-image");
  const RTSP_IMAGE = Buffer.from("rtsp-image");

  // A hedge in flight: its attempt doubles, the acquisition's own controller (whose abort stands for the budget's deadline), the clock, the budget's start, the
  // hedge's result, and each attempt's state read the moment that result settled.
  interface HedgeRun {

    readonly acquisition: AbortController;
    readonly api: AttemptDouble;
    readonly atResolve: { apiAborted?: boolean; apiSettled?: boolean; rtspAborted?: boolean; rtspSettled?: boolean } | null;
    readonly clock: TestClock;
    readonly result: Promise<Nullable<HedgedSnapshot>>;
    readonly rtsp: AttemptDouble;
    readonly startedAt: number;
  }

  // Start a hedge on a fresh camera host's clock. budgetSpentMs is the time the timeshift source already spent before RTSP starts, so the hedge begins that long
  // after the budget did. cropping is whether the camera's snapshots are cropped, by default on, and the hedge's cutoff is computed from it by the production
  // snapshotCutoff, as the acquisition computes it.
  function startHedge({ budgetSpentMs = 0, cropping = true }: { budgetSpentMs?: number; cropping?: boolean } = {}): HedgeRun {

    const { clock, controller } = makeTestCameraHost();

    controllers.push(controller);

    const startedAt = clock.now();
    const acquisition = new AbortController();
    const api = makeAttemptDouble(clock);
    const rtsp = makeAttemptDouble(clock);

    let atResolve: HedgeRun["atResolve"] = null;

    clock.advance(budgetSpentMs);

    const result = hedgeSnapshotAttempts({ api: api.attempt, clock, cutoffAt: snapshotCutoff({ cropping, startedAt }), rtsp: rtsp.attempt, signal: acquisition.signal,
      startedAt }).finally(() => {

      atResolve = { apiAborted: api.calls[0]?.signal.aborted, apiSettled: api.settled, rtspAborted: rtsp.calls[0]?.signal.aborted, rtspSettled: rtsp.settled };
    });

    return {

      acquisition,
      api,
      get atResolve(): HedgeRun["atResolve"] {

        return atResolve;
      },
      clock,
      result,
      rtsp,
      startedAt
    };
  }

  // Move the clock and let every continuation it released run.
  async function advance(run: HedgeRun, ms: number): Promise<void> {

    run.clock.advance(ms);
    await settle();
  }

  // The hedge's result once it has resolved without the clock moving further. A hedge still waiting on an attempt it should have ended fails the row here rather
  // than hanging it, because nothing in the row would ever release that wait.
  async function resolved(run: HedgeRun): Promise<Nullable<HedgedSnapshot>> {

    await settleUntil(() => run.atResolve !== null, { description: "the hedge to resolve" });

    return run.result;
  }

  test("RTSP answering before the hedge point wins, and the controller-API attempt never starts", async () => {

    const run = startHedge();

    await advance(run, 1000);
    run.rtsp.answer(RTSP_IMAGE);

    assert.deepEqual(await resolved(run), { image: RTSP_IMAGE, source: "rtsp" }, "RTSP's image wins");

    await advance(run, HEDGE_DELAY_MS);

    assert.equal(run.api.calls.length, 0, "the hedge point passing after RTSP answered starts no API attempt");
  });

  // A hedge point that fires after RTSP has already declined must not start a second API attempt beside the one the decline started.
  test("an RTSP decline before the hedge point starts the API attempt at once, and the hedge point starts no second one", async () => {

    const run = startHedge();

    await advance(run, 1000);
    run.rtsp.answer(null);
    await settle();

    assert.equal(run.api.calls.length, 1, "the decline started the API attempt");
    assert.equal(run.api.calls[0]?.startedAt, run.startedAt + 1000, "the API attempt started the moment RTSP declined");

    await advance(run, HEDGE_DELAY_MS);

    assert.equal(run.api.calls.length, 1, "exactly one API attempt, with the hedge point passed");

    run.api.answer(API_IMAGE);

    assert.deepEqual(await resolved(run), { image: API_IMAGE, source: "api" }, "the API image wins");
  });

  /* A hedge that resolves before its hedge point disarms that instant on its way out, so no timer it armed outlives the call. Nothing else on this clock is armed
   * once its first advance has run the harness's own startup timer, so an instant the hedge left armed is the one thing the clock would still hold.
   */
  test("an RTSP decline the API answers before the hedge point leaves nothing armed on the clock once the hedge resolves", async () => {

    const run = startHedge();

    await advance(run, 1000);
    run.rtsp.answer(null);
    await advance(run, 500);
    run.api.answer(API_IMAGE);

    assert.deepEqual(await resolved(run), { image: API_IMAGE, source: "api" }, "the API image wins");
    assert.ok(run.clock.now() < (run.startedAt + HEDGE_DELAY_MS), "the hedge resolved before its hedge point");
    assert.equal(run.clock.pending, 0, "the hedge point the hedge armed was disarmed as it resolved");
  });

  // The hedge point is measured from the acquisition's start. With the timeshift source taking a second, RTSP starts at one second and the API attempt
  // joins it at two and a half seconds, not three and a half.
  test("the hedge point is measured from the acquisition's start, not from RTSP's", async () => {

    const run = startHedge({ budgetSpentMs: 1000 });

    assert.equal(run.rtsp.calls[0]?.startedAt, run.startedAt + 1000, "RTSP started once the timeshift source had spent its second");

    await advance(run, HEDGE_DELAY_MS - 1000 - 1);

    assert.equal(run.api.calls.length, 0, "no API attempt before the hedge point");

    await advance(run, 1);

    assert.equal(run.api.calls.length, 1, "the API attempt joined RTSP at the hedge point");
    assert.equal(run.api.calls[0]?.startedAt, run.startedAt + HEDGE_DELAY_MS, "the hedge point is the budget's start plus the hedge delay");

    run.rtsp.answer(RTSP_IMAGE);

    assert.deepEqual(await resolved(run), { image: RTSP_IMAGE, source: "rtsp" }, "RTSP's image wins once it arrives first");
    assert.deepEqual(run.atResolve, { apiAborted: true, apiSettled: true, rtspAborted: true, rtspSettled: true }, "every attempt ended before the hedge resolved");
  });

  // The cutoff always holds back the reaping reserve, so the hedge's cleanup can kill and reap the losing RTSP attempt inside the budget, and holds back the crop
  // allowance too only when cropping is on, the one case a controller-API image still has a crop pass to run after the hedge.
  test("the cutoff is the budget less the reaping reserve with cropping off, and less the crop allowance too with cropping on", () => {

    const startedAt = 1000;

    assert.equal(snapshotCutoff({ cropping: false, startedAt }), startedAt + CUTOFF_MS, "with cropping off the cutoff holds back the reaping reserve alone");
    assert.equal(snapshotCutoff({ cropping: true, startedAt }), startedAt + CROPPED_CUTOFF_MS, "with cropping on it holds back the crop allowance as well");
  });

  // With cropping off, an API image that answers late enough that its held-image wait would run past the cutoff wins at the cutoff, the budget less the reaping
  // reserve, rather than at the end of that wait or of the budget, and the hedge aborts RTSP's still-running attempt itself and waits for it to settle, so neither
  // per-attempt signal is left live when the hedge resolves.
  test("with cropping off, a late API image is held only until the cutoff, and RTSP's attempt is aborted and settled before the hedge resolves", async () => {

    const run = startHedge({ cropping: false });

    await advance(run, HEDGE_DELAY_MS + 1500);
    run.api.answer(API_IMAGE);

    // The hedge arms its cutoff as it reads the API's answer, so the answer settles before the clock moves. A cutoff armed after the clock had already jumped toward
    // it would fire on whichever advance came next, and the row could not tell one cutoff from another.
    await settle();
    await advance(run, CUTOFF_MS - HEDGE_DELAY_MS - 1500 - 1);

    assert.equal(run.atResolve, null, "the API image is held while RTSP runs on");
    assert.equal(run.rtsp.calls[0]?.signal.aborted, false, "RTSP's attempt is still running just before the cutoff");

    await advance(run, 1);

    assert.deepEqual(await resolved(run), { image: API_IMAGE, source: "api" }, "the held API image wins at the cutoff");
    assert.equal(run.clock.now(), run.startedAt + CUTOFF_MS, "the hedge resolved at the cutoff, the budget less the reaping reserve");
    assert.deepEqual(run.atResolve, { apiAborted: true, apiSettled: true, rtspAborted: true, rtspSettled: true }, "every attempt ended before the hedge resolved");
  });

  // With cropping on, an API image that answers late enough that its held-image wait would run past the cutoff, which holds back the crop allowance as well, is
  // handed back at the cutoff, the hedge aborting RTSP's still-running attempt and waiting for it to settle. A hold ordered after the cutoff would hand it back later.
  test("with cropping on, an API image whose wait would run past the cutoff is handed back at the cutoff, and RTSP's attempt is aborted and settled", async () => {

    const run = startHedge({ cropping: true });

    await advance(run, HEDGE_DELAY_MS + 1100);
    run.api.answer(API_IMAGE);
    await settle();
    await advance(run, CROPPED_CUTOFF_MS - HEDGE_DELAY_MS - 1100 - 1);

    assert.equal(run.atResolve, null, "the API image is held while RTSP runs on");
    assert.equal(run.rtsp.calls[0]?.signal.aborted, false, "RTSP's attempt is still running just before the cutoff");

    await advance(run, 1);

    assert.deepEqual(await resolved(run), { image: API_IMAGE, source: "api" }, "the held API image wins at the cutoff");
    assert.equal(run.clock.now(), run.startedAt + CROPPED_CUTOFF_MS, "the hedge resolved at the cutoff, the budget less the reaping reserve and the crop allowance");
    assert.deepEqual(run.atResolve, { apiAborted: true, apiSettled: true, rtspAborted: true, rtspSettled: true }, "every attempt ended before the hedge resolved");
  });

  // With cropping off, an API image that answers well before the cutoff is held for RTSP for the held-image wait alone and handed back when it ends, so a controller
  // image already in hand never waits out the rest of the budget.
  test("an API image in hand is held for RTSP for at most the held-image wait, and RTSP's attempt is aborted and settled before the hedge resolves", async () => {

    const run = startHedge({ cropping: false });

    await advance(run, HEDGE_DELAY_MS + 500);
    run.api.answer(API_IMAGE);
    await settle();
    await advance(run, HELD_IMAGE_WAIT_MS - 1);

    assert.equal(run.atResolve, null, "the API image is held while RTSP runs on");
    assert.equal(run.rtsp.calls[0]?.signal.aborted, false, "RTSP's attempt is still running just before the held-image wait ends");

    await advance(run, 1);

    assert.deepEqual(await resolved(run), { image: API_IMAGE, source: "api" }, "the held API image wins when the held-image wait ends");
    assert.equal(run.clock.now(), run.startedAt + HEDGE_DELAY_MS + 500 + HELD_IMAGE_WAIT_MS, "the hedge resolved one held-image wait after the API answered");
    assert.deepEqual(run.atResolve, { apiAborted: true, apiSettled: true, rtspAborted: true, rtspSettled: true }, "every attempt ended before the hedge resolved");
  });

  // RTSP's image arriving in the last instant of the held-image wait still replaces the held API image.
  test("RTSP's image replaces a held API image when RTSP answers inside the held-image wait", async () => {

    const run = startHedge({ cropping: false });

    await advance(run, HEDGE_DELAY_MS + 500);
    run.api.answer(API_IMAGE);
    await settle();
    await advance(run, HELD_IMAGE_WAIT_MS - 1);
    run.rtsp.answer(RTSP_IMAGE);

    assert.deepEqual(await resolved(run), { image: RTSP_IMAGE, source: "rtsp" }, "RTSP's image is preferred while it arrives inside the held-image wait");
    assert.equal(run.clock.pending, 0, "the held-image wait the hedge armed was disarmed as it resolved");
  });

  test("RTSP failing while an API image is held hands the API image back at once", async () => {

    const run = startHedge();

    await advance(run, HEDGE_DELAY_MS + 500);
    run.api.answer(API_IMAGE);
    await advance(run, 500);
    run.rtsp.answer(null);

    assert.deepEqual(await resolved(run), { image: API_IMAGE, source: "api" }, "the held API image wins once RTSP fails");
    assert.ok(run.clock.now() < (run.startedAt + CROPPED_CUTOFF_MS), "the API image was handed back without waiting for the cutoff");
  });

  // The other loser: RTSP's image arriving first after the hedge point aborts the API attempt, and the hedge waits for it to settle before resolving.
  test("RTSP answering first after the hedge point wins, and the API attempt is aborted and settled before the hedge resolves", async () => {

    const run = startHedge();

    await advance(run, HEDGE_DELAY_MS + 500);
    run.rtsp.answer(RTSP_IMAGE);

    assert.deepEqual(await resolved(run), { image: RTSP_IMAGE, source: "rtsp" }, "RTSP's image wins");
    assert.deepEqual(run.atResolve, { apiAborted: true, apiSettled: true, rtspAborted: true, rtspSettled: true }, "every attempt ended before the hedge resolved");
  });

  test("RTSP declining after the hedge point leaves the API attempt to answer", async () => {

    const run = startHedge();

    await advance(run, HEDGE_DELAY_MS + 500);
    run.rtsp.answer(null);
    await advance(run, 1000);

    assert.equal(run.atResolve, null, "the hedge waits for the API attempt");

    run.api.answer(API_IMAGE);

    assert.deepEqual(await resolved(run), { image: API_IMAGE, source: "api" }, "the API image wins");
  });

  test("the API attempt answering first with nothing leaves RTSP's answer", async () => {

    const run = startHedge();

    await advance(run, HEDGE_DELAY_MS + 500);
    run.api.answer(null);
    await advance(run, 1000);
    run.rtsp.answer(RTSP_IMAGE);

    assert.deepEqual(await resolved(run), { image: RTSP_IMAGE, source: "rtsp" }, "RTSP's image wins");
  });

  // No attempt outlives the acquisition: the acquisition's own abort, the budget's deadline or a caller's signal, ends every attempt and the hedge answers nothing.
  test("the acquisition's abort ends every attempt, and the hedge answers nothing", async () => {

    const run = startHedge();

    await advance(run, HEDGE_DELAY_MS + 500);
    run.acquisition.abort();

    assert.equal(await resolved(run), null, "the hedge answers nothing once the acquisition has ended");
    assert.deepEqual(run.atResolve, { apiAborted: true, apiSettled: true, rtspAborted: true, rtspSettled: true }, "every attempt ended with the acquisition");
  });
});
