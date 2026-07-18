/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * snapshot.test.ts: Behavior coverage of the timeshift-freshness branch of ProtectSnapshot's multi-source acquisition (finding #5).
 *
 * The acquisition chain tries the timeshift buffer first, then RTSP, then the controller command, then the cache. This suite drives that chain over doubles and asserts
 * SOURCE SELECTION - which source the chain uses - never a real FFmpeg spawn: the timeshift buffer's snapshotSource is steered to "stale" or "empty" so the buffer
 * declines before the FFmpeg pipeline, and the RTSP and controller sources are wired to decline too (no channel to select, the controller command rejects), so the whole
 * chain resolves without producing (or caching) any image. The load-bearing assertions are that a STALE buffer declines and notes it at debug (so a stalled buffer never
 * serves, and then caches, a frozen image), that an EMPTY buffer declines SILENTLY (no staleness to claim), and that in both cases the chain moves past the buffer to the
 * next source. The freshness DECISION itself - whether the buffer reads fresh, stale, or empty - is covered directly over ProtectTimeshiftBuffer in timeshift.test.ts.
 */
import type { TestCameraHost, TestLogEntry } from "../testing.helpers.ts";
import { TestStreamingDelegate, makeTestCameraHost, makeTimeshiftSupervisorDouble, settle } from "../testing.helpers.ts";
import { after, describe, test } from "node:test";
import { ProtectSnapshot } from "./snapshot.ts";
import type { StreamingDelegate } from "./stream-delegate.ts";
import assert from "node:assert/strict";

// Every host this suite builds shares its makeTestNvr AbortController. Aborting them in teardown releases the harness signals.
const controllers: AbortController[] = [];

after(() => {

  for(const controller of controllers) {

    controller.abort();
  }
});

// The count of log lines at a level whose first format string contains the given fragment.
function countLogs(entries: TestLogEntry[], level: TestLogEntry["level"], fragment: string): number {

  return entries.filter((entry) => (entry.level === level) && (typeof entry.parameters[0] === "string") && entry.parameters[0].includes(fragment)).length;
}

// Build a ProtectSnapshot over a camera host whose timeshift buffer's snapshotSource is steered to the given decline kind, and whose RTSP and controller sources decline
// without spawning FFmpeg (no channel to select, the controller command rejects). The whole acquisition chain therefore runs spawn-free. selectCalls counts the RTSP
// channel selection so a test can prove the chain moved past the declined buffer.
function buildSnapshot(kind: "empty" | "stale"): { host: TestCameraHost; logEntries: TestLogEntry[]; selectCalls: { count: number }; snapshot: ProtectSnapshot } {

  const { controller, host, logEntries } = makeTestCameraHost();

  controllers.push(controller);

  // The timeshift/RTSP sources are gated behind high-resolution snapshots; enable it so the buffer source is actually consulted.
  host.hints.highResSnapshots = true;

  const stream = new TestStreamingDelegate();
  const supervisor = makeTimeshiftSupervisorDouble();

  supervisor.buffer.snapshotSource = () => ({ kind });
  stream.timeshift = supervisor as unknown as StreamingDelegate["timeshift"];
  host.stream = stream;

  // RTSP declines without spawning; count the calls to prove it was attempted after the buffer declined.
  const selectCalls = { count: 0 };

  host.selectChannel = () => {

    selectCalls.count++;

    return null;
  };

  // The controller source rejects too, so the whole chain resolves null without producing (or caching) any image.
  host.snapshotFromController = () => Promise.reject(new Error("controller declined"));

  return { host, logEntries, selectCalls, snapshot: new ProtectSnapshot(host) };
}

describe("ProtectSnapshot timeshift freshness", () => {

  // #5: a stale buffer must NOT serve (and then cache) a frozen image. The buffer declines, notes the stale decline at debug, and the chain moves past it to the RTSP
  // source. With every source wired to decline the acquisition resolves null, so nothing frozen is served or cached.
  test("a stale buffer declines, notes it at debug, caches nothing, and the RTSP source is selected", async () => {

    const { logEntries, selectCalls, snapshot } = buildSnapshot("stale");

    const image = await snapshot.getSnapshot();

    await settle();

    assert.equal(image, null, "the stale buffer served nothing, and no source produced an image to cache");
    assert.ok(countLogs(logEntries, "debug", "timeshift buffer is stale") >= 1, "the stale decline was noted at debug");
    assert.ok(selectCalls.count > 0, "the chain moved past the stale buffer and selected the RTSP source");
  });

  // #5: an empty buffer (no keyframe yet) declines SILENTLY - there is no staleness to claim - and the chain moves past it just the same.
  test("an empty buffer declines without staleness logging", async () => {

    const { logEntries, selectCalls, snapshot } = buildSnapshot("empty");

    const image = await snapshot.getSnapshot();

    await settle();

    assert.equal(image, null, "the empty buffer served nothing, and no source produced an image to cache");
    assert.equal(countLogs(logEntries, "debug", "timeshift buffer is stale"), 0, "an empty buffer declines silently - no staleness is claimed");
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
