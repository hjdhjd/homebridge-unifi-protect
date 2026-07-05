/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * relay.test.ts: Behavior tests over a REAL constructed ProtectRelay.
 *
 * ProtectRelay projects one physical relay onto one accessory carrying N subtyped Switch services - the leak-sensor multi-service idiom - plus the shared status-LED
 * switch, driven live from the controller. Its one piece of novel logic is the set-to-toggle guard: the controller offers only a faithful, write-through toggleOutput
 * primitive, so the class records the state it is driving each output toward (#pendingDesired) and decides a rapid second tap against that intent rather than the lagging
 * controller value. These tests construct the REAL class and drive it end to end through its bound onGet / onSet handlers, its two narrow observers, and its MQTT handler
 * bodies - never a modeled stand-in - and are written to SURFACE a defect (the rapid on-then-off tap resolving to the wrong state, a suppressed toggle, a leaked intent)
 * rather than to assert whatever the current code happens to do.
 *
 * The isolation model mirrors the light reference: a per-test-fresh beforeEach builds a clean relay against a clean store so #pendingDesired, the recorded toggles, the
 * characteristic state, and the observer baselines are clean every test. The wake log is windowed per push via a captured baseline. buildRelay is the copyable skeleton;
 * only makeRelayConfig, TestRelayProjection, the slice keys, the observer count (two base, one per output, plus ledSettings), and the relay-specific reactions are
 * relay-particular.
 */
import { Characteristic, Service, TestRelayProjection, TestStateStore, makeProtectState, makeRelayConfig, makeTestAccessory, makeTestNvr, settle }
  from "../testing.helpers.ts";
import type { TestAccessory, TestMqttClient } from "../testing.helpers.ts";
import { after, before, beforeEach, describe, mock, test } from "node:test";
import type { ObserverWakePayload } from "../diagnostics.ts";
import { PROTECT_RELAY_COMMAND_TIMEOUT } from "../settings.ts";
import type { ProtectAccessory } from "../types.ts";
import type { ProtectNvr } from "../nvr/nvr.ts";
import { ProtectRelay } from "./relay.ts";
import type { ProtectRelayConfig } from "unifi-protect";
import { ProtectReservedNames } from "../types.ts";
import type { Relay } from "unifi-protect";
import assert from "node:assert/strict";
import diagnosticsChannel from "node:diagnostics_channel";

// The subtype the relay assigns each output switch, keyed by the 0-based wire id. Single-sourced here so every lookup in the suite names the exact subtype the class
// created the service under.
const outputSubtype = (id: number): string => ProtectReservedNames.SWITCH_RELAY_OUTPUT + "." + id.toString();

// The reusable construction helper: build a REAL ProtectRelay against the harness doubles. The casts are confined to the construction seam exactly as the light and
// camera suites do; the instance under test runs its real configureHints / configureDevice / spawnObservers paths. Each call builds a fresh store, so an extra build
// inside a test (the feature-enabled variants) is fully isolated from the beforeEach relay.
function buildRelay(configOptions: Parameters<typeof makeRelayConfig>[0] = {}, harnessOptions: { userOptions?: string[] } = {}): {
  accessory: TestAccessory; mqtt: TestMqttClient; relay: ProtectRelay; relayConfig: ProtectRelayConfig; relayProjection: TestRelayProjection; store: TestStateStore;
} {

  const relayConfig = makeRelayConfig(configOptions);
  const store = new TestStateStore(makeProtectState({ relays: [relayConfig] }));
  const { mqtt, nvr } = makeTestNvr({ mqtt: true, store, userOptions: harnessOptions.userOptions });
  const accessory = makeTestAccessory("Test Relay", "uuid:test-relay");

  // The projection is named (not cast inline) so the toggle / status-LED tests read its toggleCalls / updateCalls - and set its rejection levers - on the SAME instance
  // the relay's onSet write-through reaches; the lone construction-seam cast is confined to the new ProtectRelay(...) call.
  const projection = new TestRelayProjection(relayConfig.id, store);
  const relay = new ProtectRelay(nvr as unknown as ProtectNvr, accessory as unknown as ProtectAccessory, projection as unknown as Relay);

  // makeTestNvr was called with mqtt: true, so the recording double is present; a guard narrows Nullable<TestMqttClient> to the non-null type without an assertion or a
  // same-type cast, and fails loudly if the opt-in ever stops installing the double.
  if(!mqtt) {

    throw new Error("The MQTT recording double was not installed despite mqtt: true.");
  }

  return { accessory, mqtt, relay, relayConfig, relayProjection: projection, store };
}

describe("real ProtectRelay construction and behavior", () => {

  // The one observer-wake subscription for the whole suite, installed before any construction and removed once in the unconditional teardown.
  const wakeLog: ObserverWakePayload[] = [];
  const onWake = (message: unknown): void => { wakeLog.push(message as ObserverWakePayload); };

  // The per-test-fresh handles, rebuilt in beforeEach so every test starts from a clean relay, clean recording, and clean wake baseline.
  let accessory: TestAccessory;
  let constructionWakes = 0;
  let mqtt: TestMqttClient;
  let relay: ProtectRelay;
  let relayConfig: ProtectRelayConfig;
  let relayProjection: TestRelayProjection;
  let store: TestStateStore;

  before(() => {

    diagnosticsChannel.subscribe("hbup:observer:wake", onWake);
  });

  after(() => {

    diagnosticsChannel.unsubscribe("hbup:observer:wake", onWake);
  });

  beforeEach(async () => {

    ({ accessory, mqtt, relay, relayConfig, relayProjection, store } = buildRelay());

    // Settle the observe loops' lazy registration before any test asserts, then snapshot the construction-wake count and reset the window so each test measures only
    // its own pushes.
    await settle();

    constructionWakes = wakeLog.length;
    wakeLog.length = 0;
  });

  test("five observers register, construction wakes none, and both output switches are created and distinctly named", () => {

    assert.equal(store.observerCount, 5, "the two base observers plus the relay's three (one per output, plus ledSettings) are registered against the store double");
    assert.equal(constructionWakes, 0, "no observer wake was published during construction - observers arm against the baseline and stay silent");

    const output0 = accessory.getServiceById(Service.Switch, outputSubtype(0));
    const output1 = accessory.getServiceById(Service.Switch, outputSubtype(1));

    assert.ok(output0, "output 0's switch exists");
    assert.ok(output1, "output 1's switch exists");
    assert.equal(output0.displayName, "Test Relay Output 1", "output 0 (0-based) labels 1-based as Output 1");
    assert.equal(output1.displayName, "Test Relay Output 2", "output 1 (0-based) labels 1-based as Output 2");
    assert.equal(output0.getCharacteristic(Characteristic.On).value, false, "output 0's tile seeded off from controller truth");
    assert.equal(output1.getCharacteristic(Characteristic.On).value, false, "output 1's tile seeded off from controller truth");
  });

  test("cleanup unwinds all five observers, and a value-changing push afterward wakes nothing", async () => {

    relay.cleanup();

    await settle();

    assert.equal(store.observerCount, 0, "every observer deregistered through the teardown");

    const teardownBaseline = wakeLog.length;

    store.pushRelayOutputs(relayConfig.id, [ { id: 0, state: "on" }, { id: 1, state: "off" } ]);

    await settle();

    assert.equal(wakeLog.length, teardownBaseline, "a push after cleanup wakes nothing");
  });

  test("the On getter reads through to the live controller output state", async () => {

    const output0 = accessory.getServiceById(Service.Switch, outputSubtype(0));

    assert.ok(output0, "output 0's switch exists");
    assert.equal(await output0.getCharacteristic(Characteristic.On).triggerGet(), false, "the getter reads the live off state");

    store.pushRelayOutputs(relayConfig.id, [ { id: 0, state: "on" }, { id: 1, state: "off" } ]);

    await settle();

    assert.equal(await output0.getCharacteristic(Characteristic.On).triggerGet(), true, "the getter reads on after the controller flips the output");
  });

  test("disabling one output prunes exactly its switch, leaving the sibling switch and the accessory intact", () => {

    const built = buildRelay({}, { userOptions: ["Disable.Relay.Output.2"] });

    assert.ok(built.accessory.getServiceById(Service.Switch, outputSubtype(0)), "output 1's switch survives the hide of output 2");
    assert.equal(built.accessory.getServiceById(Service.Switch, outputSubtype(1)), undefined, "output 2's switch is pruned");
    assert.ok(built.accessory.getService(Service.AccessoryInformation), "the accessory itself is intact");

    built.relay.cleanup();
  });

  test("an onSet toggles only when the desired state differs from the current state", async () => {

    const output0 = accessory.getServiceById(Service.Switch, outputSubtype(0));

    assert.ok(output0, "output 0's switch exists");

    // The output starts off, so turning it off again is a no-op - the toggle is not idempotent, and re-issuing it would flip it the wrong way.
    await output0.getCharacteristic(Characteristic.On).triggerSet(false);

    assert.deepEqual(relayProjection.toggleCalls, [], "an off-when-already-off set issued no toggle");

    // Turning it on flips it exactly once.
    await output0.getCharacteristic(Characteristic.On).triggerSet(true);

    assert.deepEqual(relayProjection.toggleCalls, [{ outputId: 0 }], "an on-when-off set toggled output 0 exactly once");

    // Turning it on again while the on-intent is still pending is a no-op - the guard compares against where the output is headed, not the lagging controller value.
    await output0.getCharacteristic(Characteristic.On).triggerSet(true);

    assert.deepEqual(relayProjection.toggleCalls, [{ outputId: 0 }], "a second on-when-heading-on set issued no further toggle");
  });

  test("a rapid on-then-off tap sequence issues two toggles, publishes each intent, and resolves to off once the broadcasts land", async () => {

    const output0 = accessory.getServiceById(Service.Switch, outputSubtype(0));

    assert.ok(output0, "output 0's switch exists");

    // Tap on, then tap off before either broadcast lands. The guard compares the off tap against the pending on-intent - not the controller value, which still reads off
    // during the write-through window - so it issues a second toggle rather than suppressing.
    await output0.getCharacteristic(Characteristic.On).triggerSet(true);
    await output0.getCharacteristic(Characteristic.On).triggerSet(false);

    assert.deepEqual(relayProjection.toggleCalls, [ { outputId: 0 }, { outputId: 0 } ], "the on tap and the off tap each issued a toggle");
    assert.deepEqual(mqtt.published.filter((entry) => entry.topic === relayConfig.mac + "/relay/1"),
      [ { message: "true", topic: relayConfig.mac + "/relay/1" }, { message: "false", topic: relayConfig.mac + "/relay/1" } ],
      "each accepted tap published its desired state on the 1-based output topic");

    // The first broadcast (on, from the first toggle) lands, then the second (off, from the second toggle).
    store.pushRelayOutputs(relayConfig.id, [ { id: 0, state: "on" }, { id: 1, state: "off" } ]);

    await settle();

    assert.equal(output0.getCharacteristic(Characteristic.On).value, true, "the first broadcast mirrored on to the tile");

    store.pushRelayOutputs(relayConfig.id, [ { id: 0, state: "off" }, { id: 1, state: "off" } ]);

    await settle();

    assert.equal(output0.getCharacteristic(Characteristic.On).value, false, "the second broadcast resolved the tile to off - the rapid on-then-off ends off");

    // The confirming broadcast cleared the intent: a fresh on tap toggles again rather than being suppressed against a stale pending value.
    await output0.getCharacteristic(Characteristic.On).triggerSet(true);

    assert.deepEqual(relayProjection.toggleCalls, [ { outputId: 0 }, { outputId: 0 }, { outputId: 0 } ],
      "the confirming broadcast cleared the intent, so a fresh on tap toggled again");
  });

  test("an output's state change wakes exactly that output's observer and mirrors it to its own tile", async () => {

    const output0 = accessory.getServiceById(Service.Switch, outputSubtype(0));
    const output1 = accessory.getServiceById(Service.Switch, outputSubtype(1));

    assert.ok(output0, "output 0's switch exists");
    assert.ok(output1, "output 1's switch exists");

    const baseline = wakeLog.length;

    store.pushRelayOutputs(relayConfig.id, [ { id: 0, state: "on" }, { id: 1, state: "off" } ]);

    await settle();

    assert.deepEqual(wakeLog.slice(baseline), [{ accessoryId: accessory.UUID, key: "relay.output.0" }], "exactly output 0's observer woke; output 1 was unchanged");
    assert.equal(output0.getCharacteristic(Characteristic.On).value, true, "output 0's tile mirrored on");
    assert.equal(output1.getCharacteristic(Characteristic.On).value, false, "output 1's tile stayed off");
  });

  test("a sibling output's change never wakes an output with an in-flight tap, so the pending tile does not flicker", async () => {

    const output0 = accessory.getServiceById(Service.Switch, outputSubtype(0));
    const output1 = accessory.getServiceById(Service.Switch, outputSubtype(1));

    assert.ok(output0, "output 0's switch exists");
    assert.ok(output1, "output 1's switch exists");

    // Tap output 0 ON. Its broadcast has not landed, so #pendingDesired[0] stands and HAP holds tile 0 on.
    await output0.getCharacteristic(Characteristic.On).triggerSet(true);

    assert.equal(output0.getCharacteristic(Characteristic.On).value, true, "tile 0 is optimistically on with the tap in flight");

    const baseline = wakeLog.length;

    // A sibling output (output 1) changes while output 0's tap is still in flight; output 0's own controller state is unchanged.
    store.pushRelayOutputs(relayConfig.id, [ { id: 0, state: "off" }, { id: 1, state: "on" } ]);

    await settle();

    // Output 0's per-output observer selects its own state primitive, which did not change, so it stayed parked - only the sibling woke and tile 0 never flickered.
    assert.deepEqual(wakeLog.slice(baseline), [{ accessoryId: accessory.UUID, key: "relay.output.1" }], "exactly the sibling output's observer woke");
    assert.equal(output0.getCharacteristic(Characteristic.On).value, true, "tile 0 stayed on - the sibling change did not flicker the in-flight tap");
    assert.equal(output1.getCharacteristic(Characteristic.On).value, true, "tile 1 mirrored the sibling change to on");

    // Clear the armed safety timer so it does not outlive the test.
    relay.cleanup();
  });

  test("a momentary output that self-reverts (on, then off) is mirrored back to the tile as on, then off", async () => {

    const output0 = accessory.getServiceById(Service.Switch, outputSubtype(0));

    assert.ok(output0, "output 0's switch exists");

    // A momentary output (a configured pulseDuration) flips on then self-reverts off on the controller; the observer mirrors both edges, which is correct behavior.
    store.pushRelayOutputs(relayConfig.id, [ { id: 0, state: "on" }, { id: 1, state: "off" } ]);

    await settle();

    assert.equal(output0.getCharacteristic(Characteristic.On).value, true, "the momentary pulse mirrored on");

    store.pushRelayOutputs(relayConfig.id, [ { id: 0, state: "off" }, { id: 1, state: "off" } ]);

    await settle();

    assert.equal(output0.getCharacteristic(Characteristic.On).value, false, "the self-revert mirrored back off");
  });

  test("a toggle command failure drops the intent, cancels the safety timer, and bounces the tile back to controller truth", async () => {

    mock.timers.enable({ apis: ["setTimeout"] });

    try {

      const output0 = accessory.getServiceById(Service.Switch, outputSubtype(0));

      assert.ok(output0, "output 0's switch exists");

      relayProjection.toggleRejection = new Error("the controller refused the command.");

      await output0.getCharacteristic(Characteristic.On).triggerSet(true);

      assert.deepEqual(relayProjection.toggleCalls, [{ outputId: 0 }], "the command was attempted");

      // HAP holds the requested (true) value on the characteristic; the deferred cosmetic bounce then reflects the true controller state, which is still off.
      mock.timers.tick(50);

      assert.equal(output0.getCharacteristic(Characteristic.On).value, false, "the deferred bounce restored the tile to the live off state after the failure");

      // The intent was dropped on failure, so a fresh on tap (rejection cleared) toggles again rather than being suppressed against a stale pending value.
      relayProjection.toggleRejection = null;

      await output0.getCharacteristic(Characteristic.On).triggerSet(true);

      assert.deepEqual(relayProjection.toggleCalls, [ { outputId: 0 }, { outputId: 0 } ], "the failure dropped the intent, so a fresh tap toggled again");
    } finally {

      mock.timers.reset();
    }
  });

  test("the pending-intent safety timer drops an unconfirmed intent so a later same-direction tap toggles again", async () => {

    mock.timers.enable({ apis: ["setTimeout"] });

    try {

      const output0 = accessory.getServiceById(Service.Switch, outputSubtype(0));

      assert.ok(output0, "output 0's switch exists");

      // Tap on: the intent is recorded, and a same-direction second tap is suppressed while it stands.
      await output0.getCharacteristic(Characteristic.On).triggerSet(true);
      await output0.getCharacteristic(Characteristic.On).triggerSet(true);

      assert.deepEqual(relayProjection.toggleCalls, [{ outputId: 0 }], "the second same-direction tap was suppressed while the intent stood");

      // No broadcast ever confirms; the bounded safety timer fires and drops the intent so a lost broadcast cannot wedge the tap decision.
      mock.timers.tick(PROTECT_RELAY_COMMAND_TIMEOUT);

      // A fresh on tap now toggles again: the controller value is still off and the stale intent is gone.
      await output0.getCharacteristic(Characteristic.On).triggerSet(true);

      assert.deepEqual(relayProjection.toggleCalls, [ { outputId: 0 }, { outputId: 0 } ], "after the safety timer dropped the intent, a fresh tap toggled again");
    } finally {

      mock.timers.reset();
    }
  });

  test("an output with a controller-assigned name uses that name; an unnamed output falls back to the 1-based Output N label", () => {

    const named = buildRelay({ outputs: [ { id: 0, name: "Garage Door", state: "off" }, { id: 1, name: null, state: "off" } ] });

    assert.equal(named.accessory.getServiceById(Service.Switch, outputSubtype(0))?.displayName, "Test Relay Garage Door", "output 0 used its controller-assigned name");
    assert.equal(named.accessory.getServiceById(Service.Switch, outputSubtype(1))?.displayName, "Test Relay Output 2", "output 1 fell back to the Output N label");

    named.relay.cleanup();
  });

  test("with the status-LED switch enabled, it is present and its onSet writes ledSettings through the projection", async () => {

    const enabled = buildRelay({ ledEnabled: false }, { userOptions: ["Enable.Device.StatusLed.Switch"] });

    await settle();

    const ledSwitch = enabled.accessory.getServiceById(Service.Switch, ProtectReservedNames.SWITCH_STATUS_LED);

    assert.ok(ledSwitch, "enabling the feature created the status-indicator switch");
    assert.equal(ledSwitch.getCharacteristic(Characteristic.On).value, false, "the switch seeded from the off indicator setting");

    await ledSwitch.getCharacteristic(Characteristic.On).triggerSet(true);

    assert.deepEqual(enabled.relayProjection.updateCalls, [{ payload: { ledSettings: { isEnabled: true } } }],
      "the LED onSet wrote ledSettings.isEnabled through device.update");

    enabled.relay.cleanup();
  });

  test("the ledSettings observer mirrors the indicator state to the status-LED switch", async () => {

    const enabled = buildRelay({ ledEnabled: false }, { userOptions: ["Enable.Device.StatusLed.Switch"] });

    await settle();

    const ledSwitch = enabled.accessory.getServiceById(Service.Switch, ProtectReservedNames.SWITCH_STATUS_LED);

    assert.ok(ledSwitch, "the status-indicator switch exists");

    const baseline = wakeLog.length;

    enabled.store.pushRelayPatch(enabled.relayConfig.id, { ledSettings: { isEnabled: true } });

    await settle();

    assert.deepEqual(wakeLog.slice(baseline), [{ accessoryId: enabled.accessory.UUID, key: "relay.ledSettings" }], "exactly the ledSettings observer woke");
    assert.equal(ledSwitch.getCharacteristic(Characteristic.On).value, true, "the observer pushed the indicator state to the switch");

    enabled.relay.cleanup();
  });

  test("MQTT registers a MAC-scoped get and set per output; the get reads live state and the set drives the toggle path", async () => {

    const tails = mqtt.subscriptions.map((subscription) => subscription.topic);

    assert.ok(tails.includes(relayConfig.mac + "/relay/1"), "output 1 registered a MAC-scoped subscription tail");
    assert.ok(tails.includes(relayConfig.mac + "/relay/2"), "output 2 registered a MAC-scoped subscription tail");

    // HARD-assert the GET subscription exists FIRST: an absent subscription whose getValue is optional-chained would let the value assertion pass vacuously.
    const get = mqtt.subscriptions.find((subscription) => (subscription.kind === "get") && (subscription.topic === relayConfig.mac + "/relay/1"));

    assert.ok(get?.getValue, "output 1 registered a GET subscription");
    assert.equal(get.getValue(), "false", "the GET reads the live off state as the string \"false\"");

    // The SET body drives the output switch's On onSet, which re-enters the single set-to-toggle path.
    const set = mqtt.subscriptions.find((subscription) => (subscription.kind === "set") && (subscription.topic === relayConfig.mac + "/relay/1"));

    assert.ok(set?.setValue, "output 1 registered a SET subscription");

    await set.setValue("true", "true");
    await settle();

    assert.deepEqual(relayProjection.toggleCalls, [{ outputId: 0 }], "a \"true\" SET on the output topic drove the toggle path for output 0");
  });
});
