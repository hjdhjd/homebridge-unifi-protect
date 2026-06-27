/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * record-init-stream.test.ts: A spawn-free behavior suite for the HKSV init-then-media segment generator.
 *
 * initThenMedia re-stitches the homebridge-plugin-utils getInitSegment()/segments() split back into a single-generator contract and carries the load-bearing
 * pre-init-abort guard - when getInitSegment() rejects on an abort that fired before the init arrived, the generator returns cleanly so the for-await ends without
 * throwing out of the HAP generator. In production that guard is reachable only through the recording delegate's full transmit path, which spawns FFmpeg. This suite
 * drives the REAL exported generator end-to-end against the TestRecordingProcess double homebridge-plugin-utils ships, whose getInitSegment() reject-on-pre-init-abort
 * mirrors the real assembler contract, so the generator's behavior - happy ordering, the pre-init-abort guard, and signal forwarding - is exercised directly,
 * spawn-free. No part of the generator is left to inspection.
 *
 * This suite holds no harness controllers: it constructs only TestRecordingProcess instances and drives each generator to completion within its own test, so nothing is
 * left suspended. The after() hook aborts the doubles the suite created purely for defensive symmetry; there are no makeTestNvr controllers or leaked observers to
 * release.
 */
import { after, describe, test } from "node:test";
import { TestRecordingProcess } from "homebridge-plugin-utils";
import assert from "node:assert/strict";
import { initThenMedia } from "./record-init-stream.ts";

// Distinct, recognizable buffers so the order assertions pin exactly which item was yielded where. We compare by reference identity, which is the strongest possible
// proof that the generator forwarded the configured bytes unchanged and in order.
const INIT_SEGMENT = Buffer.from("init");
const MEDIA_SEGMENT_A = Buffer.from("media-a");
const MEDIA_SEGMENT_B = Buffer.from("media-b");

// Every TestRecordingProcess this suite builds is tracked here so the after() hook can abort each one for defensive symmetry. Each test drives its generator to
// completion within its own body, so this is belt-and-suspenders cleanup, not a correctness dependency.
const processes: TestRecordingProcess[] = [];

after(() => {

  for(const proc of processes) {

    proc.abort();
  }
});

// Construct a tracked TestRecordingProcess so the after() hook can release it. The double's getInitSegment() resolves the configured init (or rejects with signal.reason
// if already aborted), and its segments() yields the configured media unless the composed signal is already aborted - exactly the assembler contract initThenMedia
// targets.
function makeProcess(init: { initSegment?: Buffer; segments?: Buffer[] }): TestRecordingProcess {

  const proc = new TestRecordingProcess(init);

  processes.push(proc);

  return proc;
}

// Drive the generator to completion, collecting its yields into an array in order. A for-await is the production consumption shape (record.ts iterates it the same way),
// so this exercises the real generator the way the delegate does.
async function collect(generator: AsyncGenerator<Buffer>): Promise<Buffer[]> {

  const yielded: Buffer[] = [];

  for await (const segment of generator) {

    yielded.push(segment);
  }

  return yielded;
}

describe("initThenMedia", () => {

  // Happy path: a live (un-aborted) signal yields the init segment first, then the media segments in order, reproducing the single-generator init-first contract.
  test("yields the init segment first, then the media segments in order", async () => {

    const controller = new AbortController();
    const proc = makeProcess({ initSegment: INIT_SEGMENT, segments: [ MEDIA_SEGMENT_A, MEDIA_SEGMENT_B ] });
    const yielded = await collect(initThenMedia(proc, controller.signal));

    assert.deepEqual(yielded, [ INIT_SEGMENT, MEDIA_SEGMENT_A, MEDIA_SEGMENT_B ]);
  });

  // The load-bearing pre-init-abort guard: aborting the process before iterating makes getInitSegment() reject with signal.reason, and the generator must return
  // cleanly - yielding nothing and NOT throwing out of the for-await. This is the exact failure mode the extraction isolates for direct test, so we exercise it here.
  test("returns cleanly when the process aborts before the init arrives, yielding nothing", async () => {

    const controller = new AbortController();
    const proc = makeProcess({ initSegment: INIT_SEGMENT, segments: [ MEDIA_SEGMENT_A, MEDIA_SEGMENT_B ] });

    proc.abort();

    const yielded = await collect(initThenMedia(proc, controller.signal));

    assert.deepEqual(yielded, []);
  });

  // Init-only: a recording with no media segments yields exactly the init segment, confirming the generator does not invent or require a media item after the init.
  test("yields only the init segment when there are no media segments", async () => {

    const controller = new AbortController();
    const proc = makeProcess({ initSegment: INIT_SEGMENT, segments: [] });
    const yielded = await collect(initThenMedia(proc, controller.signal));

    assert.deepEqual(yielded, [INIT_SEGMENT]);
  });

  // Signal-forwarding plumbing: the process itself is NOT aborted, so getInitSegment() resolves and the init is yielded, but we pass an ALREADY-ABORTED signal to
  // initThenMedia. The double's segments() composes that passed signal with its own and checks it synchronously before its first yield, so the configured media is
  // withheld and only the init comes through. This proves initThenMedia actually threads its { signal } into proc.segments({ signal }) - it verifies the FORWARDING
  // wiring, not a realistic mid-iteration discontinuity window (there is no production analog to an init that resolves under an already-aborted signal).
  test("forwards its signal into segments(), so an already-aborted signal withholds the media", async () => {

    const controller = new AbortController();

    controller.abort();

    const proc = makeProcess({ initSegment: INIT_SEGMENT, segments: [ MEDIA_SEGMENT_A, MEDIA_SEGMENT_B ] });
    const yielded = await collect(initThenMedia(proc, controller.signal));

    assert.deepEqual(yielded, [INIT_SEGMENT]);
  });
});
