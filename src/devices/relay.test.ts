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
 * only makeRelayConfig, TestRelayProjection, the slice keys, the observer count (the base class's universal observers, one per output, plus ledSettings), and the
 * relay-specific reactions are relay-particular.
 */
import { Characteristic, Service, TestStateStore, makeProtectState, makeTestAccessory } from "../testing.helpers.ts";
import { PROTECT_HOMEKIT_REFLECT_DELAY, PROTECT_RELAY_COMMAND_TIMEOUT } from "../settings.ts";
import type { ProtectRelayConfig, Relay } from "unifi-protect";
import type { TestClock, TestMqttClient } from "homebridge-plugin-utils/testing";
import { TestRelayProjection, makeRelayConfig } from "./testing.helpers.ts";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import { settle, triggerGet, triggerSet } from "homebridge-plugin-utils/testing";
import type { ObserverWakePayload } from "../diagnostics.ts";
import type { ProtectNvr } from "../nvr/nvr.ts";
import { ProtectRelay } from "./relay.ts";
import { ProtectReservedNames } from "../types.ts";
import type { TestProtectAccessory } from "../testing.helpers.ts";
import { analyzeLegacyFeatureOptions } from "../options-legacy.ts";
import assert from "node:assert/strict";
import diagnosticsChannel from "node:diagnostics_channel";
import { makeTestNvr } from "../nvr/testing.helpers.ts";

// The MAC-scoped tail the plugin composed, with the /get or /set suffix the MQTT client appends taken back off. These rows assert what the plugin addressed,
// which is the tail rather than the child topic the registration lands on.
const composedTail = (topic: string): string => topic.replace(/\/(get|set)$/, "");

// The subtype the relay assigns each output switch, keyed by the 0-based wire id. Single-sourced here so every lookup in the suite names the exact subtype the class
// created the service under.
const outputSubtype = (id: number): string => ProtectReservedNames.SWITCH_RELAY_OUTPUT + "." + id.toString();

// Every harness controller this suite opens, drained in afterEach so the controller lifetime signal bounds each test's constructions rather than the file's. The builder
// is the single push site, so an extra build inside a test body is captured exactly as the fixture's is.
const controllers: AbortController[] = [];

// The reusable construction helper: build a REAL ProtectRelay against the harness doubles. The casts are confined to where the class is constructed, exactly as the light
// and camera suites do; the instance under test runs its real configureHints / configureDevice / spawnObservers paths. Each call builds a fresh store, so an extra build
// inside a test (the feature-enabled variants) is fully isolated from the beforeEach relay.
function buildRelay(configOptions: Parameters<typeof makeRelayConfig>[0] = {}, harnessOptions: { disconnected?: boolean; userOptions?: string[] } = {}): {
  accessory: TestProtectAccessory; clock: TestClock; mqtt: TestMqttClient; relay: ProtectRelay; relayConfig: ProtectRelayConfig; relayProjection: TestRelayProjection;
  store: TestStateStore;
} {

  const relayConfig = makeRelayConfig(configOptions);
  const store = new TestStateStore(makeProtectState({ relays: [relayConfig] }));
  const { clock, controller, mqtt, nvr } = makeTestNvr({ mqtt: true, store, userOptions: harnessOptions.userOptions });

  controllers.push(controller);

  // A disconnected double is the production startup shape: the relay is built before the broker acknowledges the first session.
  if(mqtt && harnessOptions.disconnected) {

    mqtt.connected = false;
  }

  const accessory = makeTestAccessory("Test Relay", relayConfig.mac);

  // The projection is named (not cast inline) so the toggle / status-LED tests read its toggleCalls / updateCalls - and set its rejection levers - on the SAME instance
  // the relay's onSet write-through reaches; the lone cast at construction is confined to the new ProtectRelay(...) call.
  const projection = new TestRelayProjection(relayConfig.id, store);
  const relay = new ProtectRelay(nvr as unknown as ProtectNvr, accessory, projection as unknown as Relay);

  // makeTestNvr was called with mqtt: true, so the recording double is present; a guard narrows Nullable<TestMqttClient> to the non-null type without an assertion or a
  // same-type cast, and fails loudly if the opt-in ever stops installing the double.
  if(!mqtt) {

    throw new Error("The MQTT recording double was not installed despite mqtt: true.");
  }

  return { accessory, clock, mqtt, relay, relayConfig, relayProjection: projection, store };
}

describe("real ProtectRelay construction and behavior", () => {

  // The one observer-wake subscription for the whole suite, installed before any construction and removed once in the unconditional teardown.
  const wakeLog: ObserverWakePayload[] = [];
  const onWake = (message: unknown): void => { wakeLog.push(message as ObserverWakePayload); };

  // The per-test-fresh handles, rebuilt in beforeEach so every test starts from a clean relay, clean recording, and clean wake baseline.
  let accessory: TestProtectAccessory;
  let clock: TestClock;
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

  afterEach(() => {

    for(const controller of controllers) {

      controller.abort();
    }

    controllers.length = 0;
  });

  beforeEach(async () => {

    ({ accessory, clock, mqtt, relay, relayConfig, relayProjection, store } = buildRelay());

    // Settle the observe loops' lazy registration before any test asserts, then snapshot the construction-wake count and reset the window so each test measures only
    // its own pushes.
    await settle();

    // The relay states each output's held state as it is built, so each row reads what its own occasion publishes from a list taken past that statement. The double's
    // gate memory still holds what was stated, as the client's would, so a same-value statement stays unsent.
    mqtt.published.length = 0;

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
    assert.equal(await triggerGet(output0.getCharacteristic(Characteristic.On)), false, "the getter reads the live off state");

    store.pushRelayOutputs(relayConfig.id, [ { id: 0, state: "on" }, { id: 1, state: "off" } ]);

    await settle();

    assert.equal(await triggerGet(output0.getCharacteristic(Characteristic.On)), true, "the getter reads on after the controller flips the output");
  });

  test("leaving one output out of the selection prunes exactly its switch, leaving the sibling switch and the accessory intact", () => {

    const built = buildRelay({}, { userOptions: ["Enable.Relay.Outputs=1"] });

    assert.ok(built.accessory.getServiceById(Service.Switch, outputSubtype(0)), "output 1's switch survives the narrowing");
    assert.equal(built.accessory.getServiceById(Service.Switch, outputSubtype(1)), undefined, "output 2's switch is pruned");
    assert.ok(built.accessory.getService(Service.AccessoryInformation), "the accessory itself is intact");

    built.relay.cleanup();
  });

  /* The end-to-end translation row, written in the retired grammar this plugin used before output visibility was one list: one option per output, each default-on. It
   * is the only row in this file written that way. The retired entries stay in the configuration untouched - stating what they leave standing takes the live output
   * list, which a configuration string does not carry - so what gives them their old meaning is the runtime overlay, resolved against this relay's own outputs.
   */
  test("a relay configured in the retired per-output grammar keeps exactly the outputs it had", () => {

    const built = buildRelay({}, { userOptions: ["Disable.Relay.Output.2"] });

    assert.ok(built.accessory.getServiceById(Service.Switch, outputSubtype(0)), "output 1's switch survives");
    assert.equal(built.accessory.getServiceById(Service.Switch, outputSubtype(1)), undefined, "the output the retired configuration hid is still hidden");

    built.relay.cleanup();
  });

  /* The capability the live-domain selection adds: a relay reporting more outputs than the retired catalog ever enumerated shows every one of them. Under the retired
   * grammar a third output had no option of its own and resolved hidden, so this row is the blessed change - and the narrowed half beside it proves the selection is
   * what decides, not the hardware.
   */
  test("a three-output relay shows every output by default, and a selection hides exactly the ones left out", () => {

    const threeOutputs = [ { id: 0, state: "off" as const }, { id: 1, state: "off" as const }, { id: 2, state: "off" as const } ];
    const all = buildRelay({ outputs: threeOutputs });

    for(const id of [ 0, 1, 2 ]) {

      assert.ok(all.accessory.getServiceById(Service.Switch, outputSubtype(id)), "output " + (id + 1).toString() + " has a switch by default");
    }

    all.relay.cleanup();

    const narrowed = buildRelay({ outputs: threeOutputs }, { userOptions: ["Enable.Relay.Outputs=1,3"] });

    assert.ok(narrowed.accessory.getServiceById(Service.Switch, outputSubtype(0)), "output 1 stays");
    assert.equal(narrowed.accessory.getServiceById(Service.Switch, outputSubtype(1)), undefined, "output 2 is the only one hidden");
    assert.ok(narrowed.accessory.getServiceById(Service.Switch, outputSubtype(2)), "output 3 stays");

    narrowed.relay.cleanup();
  });

  /* The mixed-configuration row: a retired per-output entry AND a canonical selection present together. The canonical value is evidence the user has adopted the
   * current grammar, so it wins outright and every output it names is shown - which is what tells the ruled composition apart from a union (same answer here), an
   * intersection (which would hide output 2), and a silent legacy override (which would also hide it). The retired entry is superseded rather than honored, and the
   * startup narration names it so the user can see what was set aside.
   */
  test("a canonical selection supersedes a retired per-output entry outright, and the narration names what it set aside", () => {

    const threeOutputs = [ { id: 0, state: "off" as const }, { id: 1, state: "off" as const }, { id: 2, state: "off" as const } ];
    const built = buildRelay({ outputs: threeOutputs }, { userOptions: [ "Disable.Relay.Output.2", "Enable.Relay.Outputs=1,2,3" ] });

    for(const id of [ 0, 1, 2 ]) {

      assert.ok(built.accessory.getServiceById(Service.Switch, outputSubtype(id)),
        "output " + (id + 1).toString() + " is shown - the canonical selection wins over the retired entry");
    }

    const analysis = analyzeLegacyFeatureOptions([ "Disable.Relay.Output.2", "Enable.Relay.Outputs=1,2,3" ]);

    assert.equal(analysis.families.size, 0, "a superseded family is not overlaid");
    assert.deepEqual(analysis.translated, ["Disable.Relay.Output.2"], "the superseded entry is named for the startup line");

    built.relay.cleanup();
  });

  test("an onSet toggles only when the desired state differs from the current state", async () => {

    const output0 = accessory.getServiceById(Service.Switch, outputSubtype(0));

    assert.ok(output0, "output 0's switch exists");

    // The output starts off, so turning it off again is a no-op - calling toggleOutput twice would flip it back, so re-issuing it here would flip it the wrong way.
    await triggerSet(output0.getCharacteristic(Characteristic.On), false);

    assert.deepEqual(relayProjection.toggleCalls, [], "an off-when-already-off set issued no toggle");

    // Turning it on flips it exactly once.
    await triggerSet(output0.getCharacteristic(Characteristic.On), true);

    assert.deepEqual(relayProjection.toggleCalls, [{ outputId: 0 }], "an on-when-off set toggled output 0 exactly once");

    // Turning it on again while the on-intent is still pending is a no-op - the guard compares against where the output is headed, not the lagging controller value.
    await triggerSet(output0.getCharacteristic(Characteristic.On), true);

    assert.deepEqual(relayProjection.toggleCalls, [{ outputId: 0 }], "a second on-when-heading-on set issued no further toggle");
  });

  test("a rapid on-then-off tap sequence issues two toggles, publishes each confirmed state, and resolves to off once the broadcasts land", async () => {

    const output0 = accessory.getServiceById(Service.Switch, outputSubtype(0));

    assert.ok(output0, "output 0's switch exists");

    // Tap on, then tap off before either broadcast lands. The guard compares the off tap against the pending on-intent - not the controller value, which still reads off
    // during the write-through window - so it issues a second toggle rather than suppressing.
    await triggerSet(output0.getCharacteristic(Characteristic.On), true);
    await triggerSet(output0.getCharacteristic(Characteristic.On), false);

    assert.deepEqual(relayProjection.toggleCalls, [ { outputId: 0 }, { outputId: 0 } ], "the on tap and the off tap each issued a toggle");
    assert.equal(mqtt.publishedTo("/relay/1").length, 0, "the taps with no controller confirmation published nothing");

    // The first broadcast (on, from the first toggle) lands, then the second (off, from the second toggle).
    store.pushRelayOutputs(relayConfig.id, [ { id: 0, state: "on" }, { id: 1, state: "off" } ]);

    await settle();

    assert.equal(output0.getCharacteristic(Characteristic.On).value, true, "the first broadcast mirrored on to the tile");

    store.pushRelayOutputs(relayConfig.id, [ { id: 0, state: "off" }, { id: 1, state: "off" } ]);

    await settle();

    assert.equal(output0.getCharacteristic(Characteristic.On).value, false, "the second broadcast resolved the tile to off - the rapid on-then-off ends off");
    assert.deepEqual(mqtt.publishedTo("/relay/1").map((entry) => entry.payload), [ "true", "false" ],
      "each confirming broadcast published the output's state once on the 1-based output topic");

    // The confirming broadcast cleared the intent: a fresh on tap toggles again rather than being suppressed against a stale pending value.
    await triggerSet(output0.getCharacteristic(Characteristic.On), true);

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
    await triggerSet(output0.getCharacteristic(Characteristic.On), true);

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
    assert.deepEqual(mqtt.publishedTo("/relay/1").map((entry) => entry.payload), [ "true", "false" ], "the pulse and its self-revert each published once");
  });

  test("an output Relay.Outputs hides publishes nothing for its changes while a visible output's change publishes once", async () => {

    const built = buildRelay({}, { userOptions: ["Enable.Relay.Outputs=1"] });

    try {

      await settle();

      assert.deepEqual(built.mqtt.publishedTo("/relay/1").map((entry) => entry.payload), ["false"], "the visible output's held state is stated once as it is built");
      assert.equal(built.mqtt.publishedTo("/relay/2").length, 0, "the hidden output states nothing as it is built");

      built.mqtt.published.length = 0;

      built.store.pushRelayOutputs(built.relayConfig.id, [ { id: 0, state: "on" }, { id: 1, state: "on" } ]);
      await settle();

      assert.deepEqual(built.mqtt.publishedTo("/relay/1").map((entry) => entry.payload), ["true"], "the visible output's change published once");
      assert.equal(built.mqtt.publishedTo("/relay/2").length, 0, "the hidden output's change published nothing");
    } finally {

      built.relay.cleanup();
    }
  });

  test("an output Relay.Outputs hides registers no MQTT get or set while a visible output registers its get and its set", () => {

    const built = buildRelay({}, { userOptions: ["Enable.Relay.Outputs=1"] });

    // The registration kinds each output's MAC-scoped tail carries. A hidden output has no switch, and with it no MQTT topic, so its tail carries neither kind.
    const kinds = (tail: string): string[] => built.mqtt.subscriptions.filter((subscription) => composedTail(subscription.topic) === built.relayConfig.mac + tail)
      .map((subscription) => subscription.kind);

    try {

      assert.ok(built.accessory.getServiceById(Service.Switch, outputSubtype(0)), "the visible output's switch exists");
      assert.equal(built.accessory.getServiceById(Service.Switch, outputSubtype(1)), undefined, "the hidden output's switch is pruned");
      assert.deepEqual(kinds("/relay/1"), [ "get", "set" ], "the visible output registers its get and its set");
      assert.deepEqual(kinds("/relay/2"), [], "the hidden output registers neither a get nor a set");
    } finally {

      built.relay.cleanup();
    }
  });

  test("a toggle command failure drops the intent, cancels the safety timer, and bounces the tile back to controller truth", async () => {

    const output0 = accessory.getServiceById(Service.Switch, outputSubtype(0));

    assert.ok(output0, "output 0's switch exists");

    relayProjection.toggleRejection = new Error("the controller refused the command.");

    await triggerSet(output0.getCharacteristic(Characteristic.On), true);

    assert.deepEqual(relayProjection.toggleCalls, [{ outputId: 0 }], "the command was attempted");

    // HAP holds the requested (true) value on the characteristic; the deferred reflect then writes the true controller state, which is still off.
    clock.advance(PROTECT_HOMEKIT_REFLECT_DELAY);

    assert.equal(output0.getCharacteristic(Characteristic.On).value, false, "the deferred bounce restored the tile to the live off state after the failure");

    // The intent was dropped on failure, so a fresh on tap (rejection cleared) toggles again rather than being suppressed against a stale pending value.
    relayProjection.toggleRejection = null;

    await triggerSet(output0.getCharacteristic(Characteristic.On), true);

    assert.deepEqual(relayProjection.toggleCalls, [ { outputId: 0 }, { outputId: 0 } ], "the failure dropped the intent, so a fresh tap toggled again");
  });

  test("the pending-intent safety timer drops an unconfirmed intent so a later same-direction tap toggles again", async () => {

    const output0 = accessory.getServiceById(Service.Switch, outputSubtype(0));

    assert.ok(output0, "output 0's switch exists");

    // Tap on: the intent is recorded, and a same-direction second tap is suppressed while it stands.
    await triggerSet(output0.getCharacteristic(Characteristic.On), true);
    await triggerSet(output0.getCharacteristic(Characteristic.On), true);

    assert.deepEqual(relayProjection.toggleCalls, [{ outputId: 0 }], "the second same-direction tap was suppressed while the intent stood");

    // No broadcast ever confirms; the bounded safety timer fires and drops the intent so a lost broadcast cannot wedge the tap decision.
    clock.advance(PROTECT_RELAY_COMMAND_TIMEOUT);

    // A fresh on tap now toggles again: the controller value is still off and the stale intent is gone.
    await triggerSet(output0.getCharacteristic(Characteristic.On), true);

    assert.deepEqual(relayProjection.toggleCalls, [ { outputId: 0 }, { outputId: 0 } ], "after the safety timer dropped the intent, a fresh tap toggled again");
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

    await triggerSet(ledSwitch.getCharacteristic(Characteristic.On), true);

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

    const tails = mqtt.subscriptions.map((subscription) => composedTail(subscription.topic));

    assert.ok(tails.includes(relayConfig.mac + "/relay/1"), "output 1 registered a MAC-scoped subscription tail");
    assert.ok(tails.includes(relayConfig.mac + "/relay/2"), "output 2 registered a MAC-scoped subscription tail");

    // HARD-assert the GET subscription exists FIRST: an absent subscription whose getValue is optional-chained would let the value assertion pass vacuously.
    const get = mqtt.subscriptions.find((subscription) => (subscription.kind === "get") && (subscription.topic === relayConfig.mac + "/relay/1/get"));

    assert.ok(get, "output 1 registered a GET subscription");
    assert.equal(await mqtt.invokeGet(relayConfig.mac + "/relay/1/get"), "false", "the GET reads the live off state as the string \"false\"");

    // The SET body drives the output switch's On onSet, which re-enters the single set-to-toggle path.
    const set = mqtt.subscriptions.find((subscription) => (subscription.kind === "set") && (subscription.topic === relayConfig.mac + "/relay/1/set"));

    assert.ok(set, "output 1 registered a SET subscription");

    await mqtt.invokeSet(relayConfig.mac + "/relay/1/set", "true");
    await settle();

    assert.deepEqual(relayProjection.toggleCalls, [{ outputId: 0 }], "a \"true\" SET on the output topic drove the toggle path for output 0");
  });
});

describe("the relay's outputs restated per broker session", () => {

  test("a session restore restates each visible output once and a hidden output not at all, and a push leaving the outputs unchanged records nothing", async () => {

    const built = buildRelay({}, { userOptions: ["Enable.Relay.Outputs=1"] });

    try {

      await settle();

      built.mqtt.connected = false;
      await settle();
      built.mqtt.connected = true;
      await settle();

      assert.deepEqual(built.mqtt.publishedTo("/relay/1").map((entry) => entry.payload), [ "false", "false" ], "the visible output is stated as built and restated once");
      assert.equal(built.mqtt.publishedTo("/relay/2").length, 0, "the hidden output is never stated");
      assert.equal(built.mqtt.publishedTo("/motion").length, 0, "no event topic is restated");

      const recorded = built.mqtt.published.length;

      // A push that leaves every output's state where it was is one the per-output observer never sees, so this holds only that such a push records nothing. That the
      // gate suppresses an unchanged statement is held by the owner spine's own rows in device-mqtt-topic.test.ts.
      built.store.pushRelayOutputs(built.relayConfig.id, [ { id: 0, state: "off" }, { id: 1, state: "on" } ]);
      await settle();

      assert.equal(built.mqtt.published.length, recorded, "a push leaving the outputs unchanged records nothing");
    } finally {

      built.relay.cleanup();
    }
  });

  test("a relay built while no session is held records nothing until the session starts, then each visible output once", async () => {

    const built = buildRelay({}, { disconnected: true, userOptions: ["Enable.Relay.Outputs=1"] });

    try {

      await settle();

      assert.equal(built.mqtt.published.length, 0, "the statements made with no session held are refused");

      built.mqtt.connected = true;
      await settle();

      assert.deepEqual(built.mqtt.publishedTo("/relay/1").map((entry) => entry.payload), ["false"], "the first session states the visible output once");
      assert.equal(built.mqtt.publishedTo("/relay/2").length, 0, "the hidden output is never stated");
    } finally {

      built.relay.cleanup();
    }
  });

  test("an output changed while the session is down is restated once, as the current value, when the session returns", async () => {

    const built = buildRelay();

    try {

      await settle();

      built.mqtt.connected = false;
      built.store.pushRelayOutputs(built.relayConfig.id, [ { id: 0, state: "on" }, { id: 1, state: "off" } ]);
      await settle();

      const asBuilt = built.mqtt.publishedTo("/relay/1").length;

      built.mqtt.connected = true;
      await settle();

      assert.deepEqual(built.mqtt.publishedTo("/relay/1").slice(asBuilt).map((entry) => entry.payload), ["true"], "the returning session hears the current value once");
    } finally {

      built.relay.cleanup();
    }
  });
});
