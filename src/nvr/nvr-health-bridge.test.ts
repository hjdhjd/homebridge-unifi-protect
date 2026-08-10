/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * nvr-health-bridge.test.ts: Behavior tests over the REAL DiagnosticsHealthBridge.
 *
 * The bridge is the whole translation between the unifi-protect library's observability wire and the controller's health picture: which feeds become symptoms, which
 * are scoped away, when observation is open at all, and what the user is told as the state moves. This suite constructs it directly against recording stubs and feeds
 * it the REAL wire - `publish()` on the library's process-global diagnostics channels is public surface, so no test double stands between the arms and the code under
 * test. Reaching a given state costs publishing the reducer's own thresholds; nothing here imports them, because a suite that reads the thresholds it is meant to
 * exercise proves only that arithmetic agrees with itself.
 *
 * No mocked time anywhere, deliberately: the observer owns no timers (its symptom eviction is lazy, computed inside the reducer on each observation) and its
 * sixty-second window dwarfs any arm's runtime, so real time cannot move a result. That is the difference worth naming against the sibling gate suite, where timing IS
 * the subject and every arm runs under mocked timers.
 *
 * Each arm builds its own bridge on its own AbortController and aborts it in a finally. That is not only hygiene: the channels are process-global, so the abort is
 * what detaches an arm's subscriptions before the next arm publishes.
 *
 * Honest coverage notes: the bridge deliberately does NOT subscribe the recovery-exhausted channel - a given-up episode is the root's ledger and narration territory -
 * and the exhausted-channel arm is the empirical form of that claim. The three state-transition lines are written by the bridge, so this is the one suite that pins
 * their exact text.
 */
import type { HttpRequestEndPayload, LivestreamRecoveryExhaustedPayload, LivestreamRecoveryRecoveredPayload, LivestreamRecoveryStartedPayload } from "unifi-protect";
import { describe, test } from "node:test";
import { DiagnosticsHealthBridge } from "./nvr-health-bridge.ts";
import type { ThrottleRailSource } from "./nvr-health-bridge.ts";
import assert from "node:assert/strict";
import { channels as protectChannels } from "unifi-protect";
import util from "node:util";

// The controller address every arm's bridge is scoped to, and a foreign one for the scoping arm. Two distinct hosts is the whole fixture the address filter needs.
const CONTROLLER_ADDRESS = "controller.test";
const FOREIGN_ADDRESS = "other-controller.test";

// The camera this suite's livestream payloads name. Ownership is answered by the mutable predicate below rather than by the id, so one id serves both polarities.
const CAMERA_ID = "camera-under-test";

// Everything the bridge's log and action recorded, plus the ownership answer its predicate returns. A plain mutable record rather than closures with accessors: an arm
// moves recorder.owned or reads recorder.refreshes directly, and that is what the bridge's own predicate and action see on their next call.
interface BridgeRecorder {

  logLines: string[];
  owned: boolean;
  refreshes: number;
}

// Build a bridge against recording stubs. Every log level lands in the one collection, so an arm asserting "no lines" is asserting that the bridge said nothing at
// all rather than nothing at one chosen level - and since the state narration is its entire log surface, the collection IS the narration.
function buildBridge(options: { address?: string } = {}): { bridge: DiagnosticsHealthBridge; controller: AbortController; recorder: BridgeRecorder } {

  const controller = new AbortController();
  const recorder: BridgeRecorder = { logLines: [], owned: true, refreshes: 0 };
  const sink = (message: string, ...parameters: unknown[]): void => {

    recorder.logLines.push(util.format(message, ...parameters));
  };

  const bridge = new DiagnosticsHealthBridge({

    actions: { refreshRemovalStability: (): void => { recorder.refreshes++; } },
    address: options.address ?? CONTROLLER_ADDRESS,
    log: { debug: sink, error: sink, info: sink, warn: sink },
    ownsCamera: (cameraId: string): boolean => recorder.owned && (cameraId === CAMERA_ID),
    signal: controller.signal
  });

  bridge.wireDiagnostics();

  return { bridge, controller, recorder };
}

// Publish one completed request on the library's HTTP channel. A 500 is the failure the bridge reads as a stress symptom; a 200 is the success it reads as recovery.
function publishRequest(options: { host?: string; ok: boolean }): void {

  protectChannels.httpRequestEnd.publish({

    durationMs: 5,
    ...(options.ok ? {} : { error: "the request failed" }),
    host: options.host ?? CONTROLLER_ADDRESS,
    method: "GET",
    requestId: "request-" + String(Math.random()),
    statusCode: options.ok ? 200 : 500,
    url: "/proxy/protect/api/bootstrap"
  } satisfies HttpRequestEndPayload);
}

// Publish the given number of completed requests, all with the same outcome and host.
function publishRequests(count: number, options: { host?: string; ok: boolean }): void {

  for(let published = 0; published < count; published++) {

    publishRequest(options);
  }
}

// Publish a livestream episode's opening edge - the disruption the bridge weighs as a stall symptom.
function publishRecoveryStarted(cameraId: string = CAMERA_ID): void {

  protectChannels.livestreamRecoveryStarted.publish({ attempts: 0, cameraId, key: "episode-key", sinceLastSegmentMs: 4000 } satisfies
    LivestreamRecoveryStartedPayload);
}

/* A recording stand-in for the client's connection monitor, satisfying ThrottleRailSource natively - its `on` has exactly the rails' event union, so it assigns with
 * no cast on either side. It captures each registered handler so an arm can fire a rail directly, and hands back a Disposable that both records its disposal and
 * actually detaches the handler, which is what lets an arm prove a disposed rail is dead by firing it again rather than by reading a flag.
 */
class TestThrottleSource implements ThrottleRailSource {

  public readonly handlers = new Map<string, (() => void)[]>();

  public disposals = 0;

  public fire(event: "throttleEntered" | "throttleExited"): void {

    for(const handler of this.handlers.get(event) ?? []) {

      handler();
    }
  }

  public on(event: "throttleEntered" | "throttleExited", handler: () => void): Disposable {

    const registered = this.handlers.get(event) ?? [];

    registered.push(handler);
    this.handlers.set(event, registered);

    return { [Symbol.dispose]: (): void => {

      this.disposals++;
      this.handlers.set(event, (this.handlers.get(event) ?? []).filter((candidate) => candidate !== handler));
    } };
  }
}

describe("the health bridge: narration", () => {

  test("the way up narrates each entry exactly once, at the reducer's own thresholds", () => {

    const { bridge, controller, recorder } = buildBridge();

    try {

      bridge.notePhase("running");

      // Five weighted failures is where the reducer first calls the controller degraded. The line is the operator's alert that reconnects are being softened.
      publishRequests(5, { ok: false });

      assert.deepEqual(recorder.logLines, ["The Protect controller is responding slowly or with intermittent errors. Reducing reconnect attempts until conditions " +
        "improve."], "crossing into degraded narrates the slow-response line exactly once");
      assert.equal(bridge.state, "degraded", "five failures within the window read as degraded");

      // Seven more carries the count to twelve, the sustained-load threshold.
      publishRequests(7, { ok: false });

      assert.equal(recorder.logLines.length, 2, "crossing into stressed adds exactly one more line");
      assert.equal(recorder.logLines[1], "The Protect controller is under sustained load. Pausing background operations until conditions improve. Active recordings " +
        "and live streams continue.", "the stressed entry names what keeps running, so an operator knows recordings are not being dropped");
      assert.equal(bridge.state, "stressed", "twelve failures within the window read as stressed");
    } finally {

      controller.abort();
    }
  });

  test("the way down is silent through the hysteresis step and speaks only on the return to healthy", () => {

    const { bridge, controller, recorder } = buildBridge();

    try {

      bridge.notePhase("running");
      publishRequests(12, { ok: false });

      assert.equal(bridge.state, "stressed", "the arm opens from stressed");
      assert.equal(recorder.logLines.length, 2, "two entry lines so far");

      // Each success cancels one failure's weight. Five brings the weight to seven, under the stressed release bound, which steps the state down to degraded. That
      // step means recovery is in progress, so narrating it would read as a fresh alert.
      publishRequests(5, { ok: true });

      assert.equal(bridge.state, "degraded", "falling out of stressed lands in degraded");
      assert.equal(recorder.logLines.length, 2, "the stressed-to-degraded hysteresis step is silent");

      // Five more brings the weight to two, under the degraded release bound, and the closing line pairs with the entry warns an operator already saw.
      publishRequests(5, { ok: true });

      assert.equal(bridge.state, "healthy", "the weight fell under the degraded release bound");
      assert.deepEqual(recorder.logLines.slice(2), ["The Protect controller is responsive again."], "the return to healthy narrates the recovery exactly once");
    } finally {

      controller.abort();
    }
  });
});

describe("the health bridge: the removal-stability re-evaluation", () => {

  test("the root's re-evaluation runs on every transition, the silent step included", () => {

    const { bridge, controller, recorder } = buildBridge();

    try {

      bridge.notePhase("running");

      // The full journey: healthy to degraded, degraded to stressed, stressed back to degraded, degraded back to healthy.
      publishRequests(12, { ok: false });
      publishRequests(10, { ok: true });

      assert.equal(bridge.state, "healthy", "the journey ends where it started");
      assert.equal(recorder.logLines.length, 3, "three of the four transitions are narrated");

      // The action count exceeds the narration count by exactly the silent step. That difference is the whole point: the removal clock depends on health, so a step
      // toward recovery has to re-open the question even though the user is told nothing.
      assert.equal(recorder.refreshes, 4, "every transition ran the re-evaluation, including the one that narrated nothing");
    } finally {

      controller.abort();
    }
  });
});

describe("the health bridge: scoping", () => {

  test("another controller's requests are not this controller's symptoms", () => {

    const { bridge, controller, recorder } = buildBridge();

    try {

      bridge.notePhase("running");

      // Well past the degraded threshold, all of it belonging to a different controller on the same process-global channel.
      publishRequests(12, { host: FOREIGN_ADDRESS, ok: false });

      assert.equal(bridge.state, "healthy", "a foreign host's failures move nothing");
      assert.deepEqual(recorder.logLines, [], "and narrate nothing");

      // The positive control: the identical volume for this controller does move it, so the arm above proves scoping rather than an inert bridge.
      publishRequests(5, { ok: false });

      assert.equal(bridge.state, "degraded", "the same failures for this controller's own host do move it");
    } finally {

      controller.abort();
    }
  });

  test("a camera this controller does not own contributes no livestream symptoms", () => {

    const { bridge, controller, recorder } = buildBridge();

    try {

      bridge.notePhase("running");
      recorder.owned = false;

      publishRecoveryStarted();
      publishRecoveryStarted();
      publishRecoveryStarted();
      publishRecoveryStarted();
      publishRecoveryStarted();

      assert.equal(bridge.state, "healthy", "an un-owned camera's disruptions move nothing");

      // Flip the predicate and republish: the same five episodes now count, which is what makes the assertion above about ownership rather than about the channel.
      // An honest limit rides this arm: the observer weighs a stall and an API error identically by design, so a same-weight kind swap is behaviorally unobservable
      // here - what this arm and the threshold arms jointly pin is each channel's polarity, stress versus recovery, which a mistranslation would flip.
      recorder.owned = true;

      publishRecoveryStarted();
      publishRecoveryStarted();
      publishRecoveryStarted();
      publishRecoveryStarted();
      publishRecoveryStarted();

      assert.equal(bridge.state, "degraded", "an owned camera's disruptions weigh toward stress");
      assert.deepEqual(recorder.logLines, ["The Protect controller is responding slowly or with intermittent errors. Reducing reconnect attempts until conditions " +
        "improve."], "and narrate the degraded entry once");
    } finally {

      controller.abort();
    }
  });
});

describe("the health bridge: observation gating", () => {

  test("a suspended bridge drops symptoms, and resuming opens the same publishes through", () => {

    const { bridge, controller, recorder } = buildBridge();

    try {

      // A fresh bridge is born suspended, matching the controller's connecting posture.
      publishRequests(12, { ok: false });

      assert.equal(bridge.state, "healthy", "symptoms observed before the controller is running are dropped");
      assert.deepEqual(recorder.logLines, [], "so nothing is narrated either");

      bridge.notePhase("running");
      publishRequests(5, { ok: false });

      assert.equal(bridge.state, "degraded", "the same publishes move state once observation is open");

      // Every non-running phase closes observation again, which is what keeps an induced reboot's own errors out of the picture.
      bridge.notePhase("rebooting");

      const narratedBeforeReboot = recorder.logLines.length;

      publishRequests(12, { ok: false });

      assert.equal(bridge.state, "degraded", "symptoms during an induced disruption move nothing");
      assert.equal(recorder.logLines.length, narratedBeforeReboot, "and narrate nothing");
    } finally {

      controller.abort();
    }
  });
});

describe("the health bridge: reset", () => {

  test("a reset clears the window without narrating, and the cleared window is real", () => {

    const { bridge, controller, recorder } = buildBridge();

    try {

      bridge.notePhase("running");
      publishRequests(5, { ok: false });

      // The checkpoint: the reset below has something real to clear, and the entry line proves the state genuinely moved.
      assert.equal(bridge.state, "degraded", "the bridge is genuinely degraded before the reset");
      assert.equal(recorder.logLines.length, 1, "with its entry line narrated");

      bridge.reset();

      assert.equal(bridge.state, "healthy", "the reset returns the state to healthy");
      assert.equal(recorder.logLines.length, 1, "and narrates nothing, so a reconnect produces no recovery line the user had no alert for");

      // Four fresh failures. Against a cleared window that is under the degraded threshold; against an uncleared one it would be nine and already over.
      publishRequests(4, { ok: false });

      assert.equal(bridge.state, "healthy", "four failures against a cleared window are under the threshold");

      // The fifth crosses it, so the observer is demonstrably still live after the reset.
      publishRequests(1, { ok: false });

      assert.equal(bridge.state, "degraded", "the same five symptoms degrade the controller again");
      assert.equal(recorder.logLines.length, 2, "and the re-entry narrates once more");
    } finally {

      controller.abort();
    }
  });
});

describe("the health bridge: the throttle rails", () => {

  test("the library's throttle latches stressed, and releasing it needs organic recovery", () => {

    const { bridge, controller, recorder } = buildBridge();
    const source = new TestThrottleSource();

    try {

      bridge.notePhase("running");

      const rails = bridge.wireClient(source);

      assert.equal(rails.length, 2, "wireClient returns exactly the two rail subscriptions it took out");

      // The throttle is the dominant input: the library has paused talking to the controller, so the state is stressed regardless of how quiet the window is.
      source.fire("throttleEntered");

      assert.equal(bridge.state, "stressed", "an entered throttle forces stressed with no symptom count behind it");
      assert.deepEqual(recorder.logLines, ["The Protect controller is under sustained load. Pausing background operations until conditions improve. Active " +
        "recordings and live streams continue."], "and narrates the sustained-load line");

      // Releasing the latch alone steps down one level; the reducer waits for organic evidence before calling the controller healthy again.
      source.fire("throttleExited");

      assert.equal(bridge.state, "degraded", "releasing the throttle steps down to degraded rather than straight to healthy");

      publishRequests(1, { ok: true });

      assert.equal(bridge.state, "healthy", "a success is the organic evidence that closes it out");
    } finally {

      controller.abort();
    }
  });

  test("disposing the returned pair is what kills the rails - proven by firing them afterward", () => {

    const { bridge, controller } = buildBridge();
    const source = new TestThrottleSource();

    try {

      bridge.notePhase("running");

      const rails = bridge.wireClient(source);

      // The live half: a fired rail moves the state, so the subscriptions are provably attached.
      source.fire("throttleEntered");

      assert.equal(bridge.state, "stressed", "before disposal the rail is live");

      source.fire("throttleExited");
      publishRequests(1, { ok: true });

      assert.equal(bridge.state, "healthy", "and the release path returns it to healthy");

      for(const rail of rails) {

        rail[Symbol.dispose]();
      }

      assert.equal(source.disposals, 2, "both returned subscriptions were disposed");

      // The dead half: the same fire that forced stressed a moment ago now does nothing. A disposed-flag read alone could not tell these two states apart.
      source.fire("throttleEntered");

      assert.equal(bridge.state, "healthy", "after disposal the rail is dead, so the identical fire moves nothing");

      // A second call subscribes a fresh, independent pair - the bridge holds nothing of its own on this half.
      const replacement = bridge.wireClient(source);

      assert.equal(replacement.length, 2, "a repeat call hands back a fresh pair");

      source.fire("throttleEntered");

      assert.equal(bridge.state, "stressed", "and the fresh pair is live");
    } finally {

      controller.abort();
    }
  });
});

describe("the health bridge: lifetime", () => {

  test("the controller's abort detaches the channel subscriptions", () => {

    const { bridge, controller, recorder } = buildBridge();

    try {

      bridge.notePhase("running");

      // The positive control: before the abort the subscription is provably live.
      publishRequests(5, { ok: false });

      assert.equal(bridge.state, "degraded", "the subscription is live before the abort");
      assert.equal(recorder.logLines.length, 1, "with its entry narrated");

      controller.abort();

      // Enough failures to cross the stressed threshold had they arrived, which is what makes the unchanged state meaningful rather than merely unmoved.
      publishRequests(12, { ok: false });

      assert.equal(bridge.state, "degraded", "after the abort the identical publishes reach nothing");
      assert.equal(recorder.logLines.length, 1, "so no further line is narrated");
    } finally {

      controller.abort();
    }
  });
});

describe("the health bridge: the channels it deliberately leaves alone", () => {

  test("a given-up episode is the root's territory, so the bridge neither weighs nor narrates it", () => {

    const { bridge, controller, recorder } = buildBridge();

    try {

      bridge.notePhase("running");

      // An owned camera and an open observer: everything that would let this channel land, if the bridge subscribed it.
      for(let published = 0; published < 12; published++) {

        protectChannels.livestreamRecoveryExhausted.publish({ attempts: 5, cameraId: CAMERA_ID, key: "episode-key" } satisfies LivestreamRecoveryExhaustedPayload);
      }

      assert.equal(bridge.state, "healthy", "the exhausted channel feeds no symptom");
      assert.deepEqual(recorder.logLines, [], "and narrates nothing");
    } finally {

      controller.abort();
    }
  });

  test("a recovered episode is counted as recovery evidence for an owned camera", () => {

    const { bridge, controller } = buildBridge();

    try {

      bridge.notePhase("running");
      publishRequests(5, { ok: false });

      assert.equal(bridge.state, "degraded", "the arm opens from degraded");

      // Three recoveries cancel three failures' weight, taking the count under the degraded release bound. The recovery channel's polarity is what this pins: a
      // mistranslation that fed it as a stall would drive the state the other way instead.
      for(let published = 0; published < 3; published++) {

        protectChannels.livestreamRecoveryRecovered.publish({ cameraId: CAMERA_ID, downtimeMs: 3000, key: "episode-key" } satisfies
          LivestreamRecoveryRecoveredPayload);
      }

      assert.equal(bridge.state, "healthy", "livestream recoveries reduce the apparent symptom rate");
    } finally {

      controller.abort();
    }
  });
});

describe("the health bridge: the repeat-wire guard", () => {

  test("a second wiring call subscribes nothing further, told apart at the threshold boundary", () => {

    const { bridge, controller, recorder } = buildBridge();

    try {

      bridge.notePhase("running");

      // The bridge is already wired by buildBridge; this is the repeat the guard has to absorb.
      bridge.wireDiagnostics();

      // Four failing publishes. Weighed once each that is four, under the degraded threshold of five. A doubled subscription would weigh eight, cross the threshold,
      // and narrate - so the boundary is what tells one subscription from two, which a count that stayed below either bound could not.
      publishRequests(4, { ok: false });

      assert.equal(bridge.state, "healthy", "four publishes weighed once each stay under the degraded threshold");
      assert.deepEqual(recorder.logLines, [], "so a doubled subscription would have shown itself as a narrated line here");
    } finally {

      controller.abort();
    }
  });
});
