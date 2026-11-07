/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * device-base.test.ts: The configure step every owner of HomeKit state takes after construction, through configured() - the one way a builder takes an owner into
 * service.
 *
 * A setup that throws part way has already started work bound to the owner's lifetime, and the builder never receives the instance to end it, so configured() releases
 * the owner through its own cleanup() before the error leaves unchanged. These tests drive that contract against a bare ProtectBase leaf built on the minimal mocks the
 * spine's constructor reads, whose configure() arms a timer on the owner's registry before it fails or returns, so the release is read from what the owner started
 * rather than from the call alone.
 */
import { ProtectBase, configured } from "./device-base.ts";
import { TestClock, settle, silentLog } from "homebridge-plugin-utils/testing";
import { describe, test } from "node:test";
import type { Nullable } from "homebridge-plugin-utils";
import type { ProtectNvr } from "../nvr/nvr.ts";
import { TEST_CLOCK_EPOCH } from "../nvr/testing.helpers.ts";
import assert from "node:assert/strict";
import { hap } from "../testing.helpers.ts";

// The delay of the timer each owner's setup arms, which the clock walks past to show whether the owner's lifetime still stands.
const SETUP_TIMER_MS = 1000;

// A bare owner whose configure() arms a timer on its own registry and then fails or returns as the test scripts it, counting each lifecycle call so a test reads how
// often configured() ran each.
class TestOwner extends ProtectBase {

  public cleanupCalls = 0;
  public configureCalls = 0;
  public failure: Nullable<Error> = null;
  public timerFired = false;

  // Whether this owner's lifetime has ended, read off the protected composed signal every observer, MQTT registration, and timer binds to.
  public get lifetimeEnded(): boolean {

    return this.signal.aborted;
  }

  public override configure(): void {

    this.configureCalls++;
    this.timers.setTimeout("setup", () => { this.timerFired = true; }, SETUP_TIMER_MS);

    if(this.failure) {

      throw this.failure;
    }
  }

  public override cleanup(): void {

    this.cleanupCalls++;
    super.cleanup();
  }
}

// Build an owner on the minimal mocks the spine's constructor reads: the runtime's HAP, the plugin logging root, the debug gate, the test clock its timer registry arms
// on, and the controller lifetime it composes against. The casts are confined to this construction step; the instance itself is the production base class.
function makeOwner(): { clock: TestClock; owner: TestOwner } {

  const clock = new TestClock(TEST_CLOCK_EPOCH);
  const log = silentLog();
  const nvr = { platform: { api: { hap }, clock, log, pluginLog: log, testDebug: (): boolean => false }, signal: new AbortController().signal };

  return { clock, owner: new TestOwner(nvr as unknown as ProtectNvr) };
}

describe("configured(), the configure step every owner takes after construction", () => {

  test("an owner whose configure() throws is released once, ending what its setup started, and the error leaves configured() unchanged", async () => {

    const { clock, owner } = makeOwner();
    const failure = new Error("The setup could not finish.");

    owner.failure = failure;

    assert.throws(() => configured(owner), (error: unknown) => error === failure, "configured() rethrows the very error the setup threw");
    assert.equal(owner.configureCalls, 1, "configured() ran the owner's setup once");
    assert.equal(owner.cleanupCalls, 1, "configured() released the owner exactly once");
    assert.equal(owner.lifetimeEnded, true, "the release ended the owner's lifetime");

    clock.advance(SETUP_TIMER_MS);

    await settle();

    assert.equal(owner.timerFired, false, "the timer the failed setup armed was drained with the owner's lifetime and never fired");
  });

  test("an owner whose configure() returns is handed back configured, with its lifetime and what its setup started still standing", async () => {

    const { clock, owner } = makeOwner();

    assert.equal(configured(owner), owner, "configured() hands back the owner it was given");
    assert.equal(owner.configureCalls, 1, "configured() ran the owner's setup once");
    assert.equal(owner.cleanupCalls, 0, "a setup that returned leaves the owner unreleased");
    assert.equal(owner.lifetimeEnded, false, "the owner's lifetime still stands");

    clock.advance(SETUP_TIMER_MS);

    await settle();

    // The control that keeps the release test above from passing vacuously: the same timer fires when the owner's lifetime stands.
    assert.equal(owner.timerFired, true, "the timer the setup armed fired on the owner's live registry");

    owner.cleanup();
  });
});
