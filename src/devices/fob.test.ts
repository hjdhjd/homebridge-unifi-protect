/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * fob.test.ts: Behavior tests over a REAL constructed ProtectFob.
 *
 * ProtectFob projects one UniFi Protect LoRa fob onto one accessory carrying a fixed set of subtyped StatelessProgrammableSwitch services - one per physical button -
 * grouped under a ServiceLabel when two or more are visible, plus a Battery service. A fob is a PURE-INPUT device: it issues no commands, so the leaf only CREATES the
 * services (configure-time) while the event-dispatch ROUTER delivers each press. These tests construct the REAL class end to end, drive presses through the REAL
 * ProtectEventDispatch.buttonEventHandler (never a hand-rolled call), and are written to SURFACE a defect (a mis-created subtype, a compacted ServiceLabelIndex, a
 * swallowed single press, a lost faithful-firehose publish) rather than to assert whatever the current code happens to do.
 *
 * The isolation model mirrors the relay reference: a per-test-fresh beforeEach builds a clean fob against a clean store so the characteristic state, the event log, and
 * the observer baselines are clean every test. The wake log is windowed per push via a captured baseline. buildFob is the copyable skeleton; only makeFobConfig,
 * TestFobProjection, the slice keys, the fob's own battery observers, and the fob-specific button table are fob-particular.
 *
 * NOTE the create/address round-trip and pressType->constant mapping tests verify plugin-INTERNAL consistency only: they are authored against the SAME assumed wire
 * strings the production table is (the six button wire ids and the three gesture strings), so they cannot catch a wire mismatch between the plugin and a real controller
 * - only HJD's live validation can. The INFO log on an unrecognized gesture is the field tell.
 */
import { Characteristic, Service, TestFobProjection, TestStateStore, makeFobConfig, makeProtectState, makeTestAccessory, makeTestNvr, settle }
  from "../testing.helpers.ts";
import type { Fob, ProtectFobConfig } from "unifi-protect";
import type { TestAccessory, TestLogEntry, TestMqttClient } from "../testing.helpers.ts";
import { after, before, beforeEach, describe, test } from "node:test";
import type { ObserverWakePayload } from "../diagnostics.ts";
import type { ProtectAccessory } from "../types.ts";
import type { ProtectEventDispatch } from "../nvr/event-dispatch.ts";
import { ProtectFob } from "./fob.ts";
import type { ProtectNvr } from "../nvr/nvr.ts";
import { ProtectReservedNames } from "../types.ts";
import assert from "node:assert/strict";
import diagnosticsChannel from "node:diagnostics_channel";

// The fixed button table the production ProtectFob authors, mirrored here so every lookup in the suite names the exact index / label / wire id the class created its
// services under. index is the STABLE 1-based ServiceLabelIndex following the controller's own button numbering; wireId is the lowercase protocol id the router addresses
// on; label is the security-action human name; positionLabel is the name the controller's position-hint labeling assigns.
const FOB_BUTTONS = [

  { index: 1, label: "Arm", positionLabel: "1", wireId: "arm" },
  { index: 2, label: "Night", positionLabel: "2", wireId: "night" },
  { index: 3, label: "Disarm", positionLabel: "3", wireId: "disarm" },
  { index: 4, label: "Panic", positionLabel: "4", wireId: "panic" },
  { index: 5, label: "Right", positionLabel: "Right", wireId: "right" },
  { index: 6, label: "Left", positionLabel: "Left", wireId: "left" }
] as const;

// The subtype the fob assigns each button switch, keyed by the lowercase wire id. Single-sourced here so every lookup in the suite names the exact subtype the class
// created the service under - and the exact address the router delivers to.
const buttonSubtype = (wireId: string): string => ProtectReservedNames.SWITCH_FOB_BUTTON + "." + wireId;

// The per-button feature-option identity, keyed by the title-cased label. Single-sourced so a userOptions "Disable." string in the suite names the exact option the class
// gates the switch on, which is what closes the option-identity drift between fob.ts and options.ts.
const buttonOption = (label: string): string => "Fob.Button." + label;

// The reusable construction helper: build a REAL ProtectFob against the harness doubles. The casts are confined to the construction seam exactly as the relay and light
// suites do; the instance under test runs its real configureHints / configureDevice / spawnObservers paths. Each call builds a fresh store, so an extra build inside a
// test is fully isolated from the beforeEach fob. An optional accessory lets a test seed a restored-across-restart accessory (the grouped->lone reconfigure).
function buildFob(configOptions: Parameters<typeof makeFobConfig>[0] = {}, harnessOptions: { accessory?: TestAccessory; userOptions?: string[] } = {}): {
  accessory: TestAccessory; events: ProtectEventDispatch; fob: ProtectFob; fobConfig: ProtectFobConfig; logEntries: TestLogEntry[]; mqtt: TestMqttClient;
  store: TestStateStore;
} {

  const fobConfig = makeFobConfig(configOptions);
  const store = new TestStateStore(makeProtectState({ fobs: [fobConfig] }));
  const { logEntries, mqtt, nvr } = makeTestNvr({ mqtt: true, store, userOptions: harnessOptions.userOptions });
  const accessory = harnessOptions.accessory ?? makeTestAccessory("Test Fob", "uuid:test-fob");

  // The projection is named (not cast inline) so its read-through config feeds the SAME store the pushFobPatch battery test moves; the lone construction-seam cast is
  // confined to the new ProtectFob(...) call, and the presses route through the REAL ProtectEventDispatch this NVR double carries as nvr.events.
  const projection = new TestFobProjection(fobConfig.id, store);
  const fob = new ProtectFob(nvr as unknown as ProtectNvr, accessory as unknown as ProtectAccessory, projection as unknown as Fob);

  // makeTestNvr was called with mqtt: true, so the recording double is present; a guard narrows Nullable<TestMqttClient> to the non-null type without an assertion or a
  // same-type cast, and fails loudly if the opt-in ever stops installing the double.
  if(!mqtt) {

    throw new Error("The MQTT recording double was not installed despite mqtt: true.");
  }

  return { accessory, events: nvr.events, fob, fobConfig, logEntries, mqtt, store };
}

describe("real ProtectFob construction and behavior", () => {

  // The one observer-wake subscription for the whole suite, installed before any construction and removed once in the unconditional teardown.
  const wakeLog: ObserverWakePayload[] = [];
  const onWake = (message: unknown): void => { wakeLog.push(message as ObserverWakePayload); };

  // The per-test-fresh handles, rebuilt in beforeEach so every test starts from a clean fob, clean recording, and clean wake baseline.
  let accessory: TestAccessory;
  let constructionWakes = 0;
  let events: ProtectEventDispatch;
  let fob: ProtectFob;
  let fobConfig: ProtectFobConfig;
  let logEntries: TestLogEntry[];
  let mqtt: TestMqttClient;
  let store: TestStateStore;

  before(() => {

    diagnosticsChannel.subscribe("hbup:observer:wake", onWake);
  });

  after(() => {

    diagnosticsChannel.unsubscribe("hbup:observer:wake", onWake);
  });

  beforeEach(async () => {

    ({ accessory, events, fob, fobConfig, logEntries, mqtt, store } = buildFob());

    // Settle the observe loops' lazy registration before any test asserts, then snapshot the construction-wake count and reset the window so each test measures only its
    // own pushes.
    await settle();

    constructionWakes = wakeLog.length;
    wakeLog.length = 0;
  });

  test("five observers register, construction wakes none, and all six button switches are created and distinctly named", () => {

    assert.equal(store.observerCount, 5,
      "the two base observers plus the fob's two battery observers and its button-label observer are registered against the store double");
    assert.equal(constructionWakes, 0, "no observer wake was published during construction - observers arm against the baseline and stay silent");

    for(const button of FOB_BUTTONS) {

      const service = accessory.getServiceById(Service.StatelessProgrammableSwitch, buttonSubtype(button.wireId));

      assert.ok(service, button.label + "'s switch exists");
      assert.equal(service.displayName, button.label, button.label + "'s switch is named by its bare button label");
    }
  });

  test("cleanup unwinds all five observers, and a value-changing push afterward wakes nothing", async () => {

    fob.cleanup();

    await settle();

    assert.equal(store.observerCount, 0, "every observer deregistered through the teardown");

    const teardownBaseline = wakeLog.length;

    store.pushFobBattery(fobConfig.id, { isLow: true, percentage: 10 });

    await settle();

    assert.equal(wakeLog.length, teardownBaseline, "a push after cleanup wakes nothing");
  });

  test("the six visible buttons are grouped under a ServiceLabel with ARABIC_NUMERALS, each carrying its fixed table index and linked to the label", () => {

    const serviceLabel = accessory.getService(Service.ServiceLabel);

    assert.ok(serviceLabel, "the ServiceLabel exists when two or more buttons are visible");
    assert.equal(serviceLabel.getCharacteristic(Characteristic.ServiceLabelNamespace).value, Characteristic.ServiceLabelNamespace.ARABIC_NUMERALS,
      "the ServiceLabel uses the arabic-numerals namespace");

    for(const button of FOB_BUTTONS) {

      const service = accessory.getServiceById(Service.StatelessProgrammableSwitch, buttonSubtype(button.wireId));

      assert.ok(service, button.label + "'s switch exists");
      assert.equal(service.getCharacteristic(Characteristic.ServiceLabelIndex).value, button.index, button.label + " carries its fixed 1-based table index");
      assert.ok(serviceLabel.linkedServices.includes(service), button.label + "'s switch is linked to the ServiceLabel");
    }
  });

  test("hiding an EARLY button leaves a LATER visible button's fixed 1-based table index unchanged, never a compacted visible-subset position", () => {

    // Hide disarm (table index 3). If the index were the visible-subset position rather than the fixed table index, panic would renumber from 4 to 3 - the exact defect
    // this catches. arm (index 1) and left (index 6) bracket the hidden button to prove nothing above or below it shifted either.
    const built = buildFob({}, { userOptions: ["Disable." + buttonOption("Disarm")] });

    assert.equal(built.accessory.getServiceById(Service.StatelessProgrammableSwitch, buttonSubtype("disarm")), undefined, "the hidden disarm button has no switch");

    const arm = built.accessory.getServiceById(Service.StatelessProgrammableSwitch, buttonSubtype("arm"));
    const panic = built.accessory.getServiceById(Service.StatelessProgrammableSwitch, buttonSubtype("panic"));
    const left = built.accessory.getServiceById(Service.StatelessProgrammableSwitch, buttonSubtype("left"));

    assert.ok(arm && panic && left, "the surviving buttons exist");
    assert.equal(panic.getCharacteristic(Characteristic.ServiceLabelIndex).value, 4, "panic keeps its FIXED table index 4, not a compacted visible position of 3");
    assert.equal(arm.getCharacteristic(Characteristic.ServiceLabelIndex).value, 1, "arm keeps its fixed table index 1");
    assert.equal(left.getCharacteristic(Characteristic.ServiceLabelIndex).value, 6, "left keeps its fixed table index 6");

    built.fob.cleanup();
  });

  test("a routed press to a visible button fires exactly the mapped ProgrammableSwitchEvent and leaves the cached value untouched", () => {

    // HARD-assert the switch exists FIRST: an absent service whose getCharacteristic lazily materializes would let the event assertion pass vacuously.
    const panic = accessory.getServiceById(Service.StatelessProgrammableSwitch, buttonSubtype("panic"));

    assert.ok(panic, "panic's switch exists");

    events.buttonEventHandler(fob, "panic", "press");

    const characteristic = panic.getCharacteristic(Characteristic.ProgrammableSwitchEvent);

    assert.deepEqual(characteristic.events, [Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS], "the press fired exactly one SINGLE_PRESS event notification");
    assert.equal(characteristic.value, null, "the cached characteristic value is untouched - a stateless programmable switch holds no persistent value");
  });

  test("each wire gesture maps to its HomeKit press value, including the falsy single press", () => {

    // Route single, double, then long onto one button. SINGLE_PRESS is 0 (falsy), so this proves the delivery's null-guard passes it rather than swallowing it under a
    // truthiness test - the exact defect a `!value` guard would introduce.
    const panic = accessory.getServiceById(Service.StatelessProgrammableSwitch, buttonSubtype("panic"));

    assert.ok(panic, "panic's switch exists");

    events.buttonEventHandler(fob, "panic", "press");
    events.buttonEventHandler(fob, "panic", "doublePress");
    events.buttonEventHandler(fob, "panic", "longPress");

    assert.deepEqual(panic.getCharacteristic(Characteristic.ProgrammableSwitchEvent).events, [

      Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS,
      Characteristic.ProgrammableSwitchEvent.DOUBLE_PRESS,
      Characteristic.ProgrammableSwitchEvent.LONG_PRESS
    ], "press / doublePress / longPress map to SINGLE / DOUBLE / LONG, with the falsy single press delivered rather than swallowed");
  });

  test("each button's press routes to exactly its own switch, proving the create/address subtype round-trip with no cross-talk", () => {

    // The fob CREATES each switch at SWITCH_FOB_BUTTON + "." + wireId and the router ADDRESSES a delivery at the same convention. Route one press per button, then assert
    // each switch fired exactly once from its own wire id - a create/address divergence would land the event on the wrong switch (or nowhere), and any cross-talk would
    // double-fire a sibling.
    for(const button of FOB_BUTTONS) {

      events.buttonEventHandler(fob, button.wireId, "press");
    }

    for(const button of FOB_BUTTONS) {

      const service = accessory.getServiceById(Service.StatelessProgrammableSwitch, buttonSubtype(button.wireId));

      assert.ok(service, button.label + "'s switch exists");
      assert.deepEqual(service.getCharacteristic(Characteristic.ProgrammableSwitchEvent).events, [Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS],
        button.label + " fired exactly once from its own wire id");
    }
  });

  test("hiding one button prunes exactly its switch; a press to it fires nothing while a sibling still fires, and BOTH presses publish MQTT", () => {

    const built = buildFob({}, { userOptions: ["Disable." + buttonOption("Disarm")] });

    assert.equal(built.accessory.getServiceById(Service.StatelessProgrammableSwitch, buttonSubtype("disarm")), undefined, "disarm's switch is pruned");
    assert.ok(built.accessory.getServiceById(Service.StatelessProgrammableSwitch, buttonSubtype("panic")), "panic's switch survives the hide of disarm");

    // A press to the pruned button fires nothing in HomeKit, then a press to a visible sibling fires - proving the prune is exactly scoped.
    built.events.buttonEventHandler(built.fob, "disarm", "press");
    built.events.buttonEventHandler(built.fob, "panic", "press");

    const panic = built.accessory.getServiceById(Service.StatelessProgrammableSwitch, buttonSubtype("panic"));

    assert.ok(panic, "panic's switch exists");
    assert.deepEqual(panic.getCharacteristic(Characteristic.ProgrammableSwitchEvent).events, [Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS],
      "the sibling press fired while the hidden button's press fired nothing");

    // The faithful firehose publishes BOTH presses on the device-family-agnostic button topic, hidden button included.
    const publishes = built.mqtt.published.filter((entry) => entry.topic === built.fobConfig.mac + "/button");

    assert.deepEqual(publishes, [

      { message: JSON.stringify({ button: "disarm", pressType: "press" }), topic: built.fobConfig.mac + "/button" },
      { message: JSON.stringify({ button: "panic", pressType: "press" }), topic: built.fobConfig.mac + "/button" }
    ], "both presses publish on the button topic, faithful to the firehose - the hidden button's press publishes even though it fires no HomeKit event");

    built.fob.cleanup();
  });

  test("a lone visible button is not grouped: no ServiceLabel, no ServiceLabelIndex, and no link", () => {

    // Only panic enabled: below the two-button grouping threshold, so no ServiceLabel and no per-button index.
    const disableAllBut = FOB_BUTTONS.filter((button) => button.label !== "Panic").map((button) => "Disable." + buttonOption(button.label));
    const built = buildFob({}, { userOptions: disableAllBut });

    assert.equal(built.accessory.getService(Service.ServiceLabel), undefined, "a single visible button creates no ServiceLabel");

    const panic = built.accessory.getServiceById(Service.StatelessProgrammableSwitch, buttonSubtype("panic"));

    assert.ok(panic, "panic's switch exists");
    assert.equal(panic.testCharacteristic(Characteristic.ServiceLabelIndex), false, "a lone visible button carries no ServiceLabelIndex");

    built.fob.cleanup();
  });

  test("regrouping down to a lone visible button removes a restored ServiceLabel and clears the surviving switch's stale index", () => {

    // The grouped->lone reconcile is only reachable across a restart+option-flip: a fresh accessory has no prior grouped state, so we seed a RESTORED accessory - a
    // ServiceLabel plus an arm switch carrying a stale ServiceLabelIndex, exactly as HomeKit restores a previously-grouped fob from its cache - then build the fob with
    // only arm visible. configureButtons must remove the now-orphaned ServiceLabel and drop the surviving switch's stale index.
    const restored = makeTestAccessory("Test Fob", "uuid:test-fob-restored");

    restored.addService(Service.ServiceLabel, "Test Fob");

    const armSwitch = restored.addService(Service.StatelessProgrammableSwitch, "Arm", buttonSubtype("arm"));

    armSwitch.updateCharacteristic(Characteristic.ServiceLabelIndex, 1);

    const disableAllBut = FOB_BUTTONS.filter((button) => button.label !== "Arm").map((button) => "Disable." + buttonOption(button.label));
    const built = buildFob({}, { accessory: restored, userOptions: disableAllBut });

    assert.equal(built.accessory.getService(Service.ServiceLabel), undefined, "the restored ServiceLabel is removed once the fob regroups to a single visible button");

    const arm = built.accessory.getServiceById(Service.StatelessProgrammableSwitch, buttonSubtype("arm"));

    assert.ok(arm, "the arm switch survives");
    assert.equal(arm.testCharacteristic(Characteristic.ServiceLabelIndex), false, "the surviving lone switch's stale ServiceLabelIndex is cleared");

    built.fob.cleanup();
  });

  test("the battery service seeds from the record and its observers push level and low-battery changes", async () => {

    const built = buildFob({ batteryLow: false, batteryPercentage: 80 });

    await settle();

    const battery = built.accessory.getService(Service.Battery);

    assert.ok(battery, "the battery service exists");
    assert.equal(battery.getCharacteristic(Characteristic.BatteryLevel).value, 80, "the battery level seeds from the record");
    assert.equal(battery.getCharacteristic(Characteristic.StatusLowBattery).value, false, "the low-battery flag seeds from the record");

    const baseline = built.store.observerCount;

    assert.equal(baseline, 5, "the fob registers five observers");

    // A battery change wakes the battery observers and re-pushes both characteristics.
    built.store.pushFobBattery(built.fobConfig.id, { isLow: true, percentage: 15 });

    await settle();

    assert.equal(battery.getCharacteristic(Characteristic.BatteryLevel).value, 15, "the battery-level observer pushed the new percentage");
    assert.equal(battery.getCharacteristic(Characteristic.StatusLowBattery).value, true, "the low-battery observer pushed the new flag");

    built.fob.cleanup();
  });

  test("an unrecognized fob adopts Battery-only with one actionable warning, no button switches, and no button-label observer", async () => {

    const built = buildFob({ marketName: "Some Other Remote", type: "XYZ-Remote-1" });

    await settle();

    // No button switches are created for an off-family fob...
    for(const button of FOB_BUTTONS) {

      assert.equal(built.accessory.getServiceById(Service.StatelessProgrammableSwitch, buttonSubtype(button.wireId)), undefined,
        button.label + " has no switch on an unrecognized fob");
    }

    assert.equal(built.accessory.getService(Service.ServiceLabel), undefined, "no ServiceLabel is created for an unrecognized fob");
    assert.ok(built.accessory.getService(Service.Battery), "the battery service is still present on an unrecognized fob");

    // The button-label observer is gated on a non-empty button table, so an unrecognized fob registers only the two base observers plus the two battery observers.
    assert.equal(built.store.observerCount, 4, "an unrecognized fob registers no button-label observer - it has no buttons to rename");

    // ...but the adoption is never silent: one actionable warning names the unrecognized model.
    const warned = built.logEntries.some((entry) => (entry.level === "warn") && entry.formatted.includes("not a recognized model"));

    assert.ok(warned, "an unrecognized fob logs one actionable warning rather than adopting silently");

    built.fob.cleanup();
  });

  test("a hidden button, an unknown button, and an unmapped gesture each fire nothing in HomeKit but still publish MQTT (faithful firehose)", () => {

    const built = buildFob({}, { userOptions: ["Disable." + buttonOption("Disarm")] });

    // A hidden button (no switch), an unknown button (never in the table), and an unmapped gesture on a visible button: none fire a HomeKit event, all publish MQTT.
    built.events.buttonEventHandler(built.fob, "disarm", "press");
    built.events.buttonEventHandler(built.fob, "nonexistent", "press");
    built.events.buttonEventHandler(built.fob, "panic", "wiggle");

    const panic = built.accessory.getServiceById(Service.StatelessProgrammableSwitch, buttonSubtype("panic"));

    assert.ok(panic, "panic's switch exists");
    assert.deepEqual(panic.getCharacteristic(Characteristic.ProgrammableSwitchEvent).events, [],
      "the unmapped gesture on a visible button fires no event - the gesture did not map to a press value");

    const publishes = built.mqtt.published.filter((entry) => entry.topic === built.fobConfig.mac + "/button");

    assert.deepEqual(publishes, [

      { message: JSON.stringify({ button: "disarm", pressType: "press" }), topic: built.fobConfig.mac + "/button" },
      { message: JSON.stringify({ button: "nonexistent", pressType: "press" }), topic: built.fobConfig.mac + "/button" },
      { message: JSON.stringify({ button: "panic", pressType: "wiggle" }), topic: built.fobConfig.mac + "/button" }
    ], "every delivered press publishes on the button topic, hidden / unknown button and unmapped gesture included");

    built.fob.cleanup();
  });

  test("each button's Disable option prunes exactly its switch, closing the option-identity drift between the leaf and options.ts", () => {

    // If buttonOption(label) in the leaf ever drifted from the "Fob.Button.<Label>" identity in options.ts, the Disable string below would resolve nothing and the switch
    // would survive - so a pruned switch here proves the leaf's option identity matches the registered option for EVERY button.
    for(const button of FOB_BUTTONS) {

      const built = buildFob({}, { userOptions: ["Disable." + buttonOption(button.label)] });

      assert.equal(built.accessory.getServiceById(Service.StatelessProgrammableSwitch, buttonSubtype(button.wireId)), undefined,
        "disabling " + button.label + " pruned its switch, so its option identity resolves");

      const sibling = FOB_BUTTONS.find((entry) => entry.wireId !== button.wireId);

      assert.ok(sibling, "a sibling button exists");
      assert.ok(built.accessory.getServiceById(Service.StatelessProgrammableSwitch, buttonSubtype(sibling.wireId)),
        "only the named button was pruned - a sibling survives");

      built.fob.cleanup();
    }
  });

  test("the button MQTT topic is scoped to the fob's MAC and carries the raw button and press type", () => {

    events.buttonEventHandler(fob, "night", "doublePress");

    assert.deepEqual(mqtt.published.filter((entry) => entry.topic === fobConfig.mac + "/button"),
      [{ message: JSON.stringify({ button: "night", pressType: "doublePress" }), topic: fobConfig.mac + "/button" }],
      "the delivered press publishes the raw button and press type on the MAC-scoped button topic");
  });

  test("under a position-hint labeling each button's displayName stays the security-action label while its ConfiguredName is the controller number", () => {

    const built = buildFob({ buttonLabels: "positionHint" });

    for(const button of FOB_BUTTONS) {

      const service = built.accessory.getServiceById(Service.StatelessProgrammableSwitch, buttonSubtype(button.wireId));

      assert.ok(service, button.label + "'s switch exists");
      assert.equal(service.displayName, button.label, button.label + "'s displayName stays the stable security-action label");
      assert.equal(service.getCharacteristic(Characteristic.ConfiguredName).value, button.positionLabel,
        button.label + "'s ConfiguredName is its controller-numbered label");
      assert.equal(service.getCharacteristic(Characteristic.ServiceLabelIndex).value, button.index, button.label + " keeps its controller-numbered index");
    }

    built.fob.cleanup();
  });

  test("under the factory-default labeling each button's ConfiguredName is the security-action label", () => {

    for(const button of FOB_BUTTONS) {

      const service = accessory.getServiceById(Service.StatelessProgrammableSwitch, buttonSubtype(button.wireId));

      assert.ok(service, button.label + "'s switch exists");
      assert.equal(service.getCharacteristic(Characteristic.ConfiguredName).value, button.label, button.label + "'s ConfiguredName is the security-action label");
    }
  });

  test("an unrecognized button labeling resolves the security-action names", () => {

    const built = buildFob({ buttonLabels: "someFutureMode" });

    for(const button of FOB_BUTTONS) {

      const service = built.accessory.getServiceById(Service.StatelessProgrammableSwitch, buttonSubtype(button.wireId));

      assert.ok(service, button.label + "'s switch exists");
      assert.equal(service.getCharacteristic(Characteristic.ConfiguredName).value, button.label,
        button.label + "'s ConfiguredName falls back to the security-action label under an unrecognized labeling");
    }

    built.fob.cleanup();
  });

  test("a live labeling flip wakes the observer and rewrites the plugin-managed button names while Right and Left are untouched", async () => {

    // The beforeEach fob is the factory-default security-action labeling, so every ConfiguredName starts at the security-action label.
    for(const button of FOB_BUTTONS) {

      const service = accessory.getServiceById(Service.StatelessProgrammableSwitch, buttonSubtype(button.wireId));

      assert.ok(service, button.label + "'s switch exists");
      assert.equal(service.getCharacteristic(Characteristic.ConfiguredName).value, button.label, button.label + " starts named by its security-action label");
    }

    // Right and Left resolve to the same label in both modes, so a flip must leave their ConfiguredName untouched - proven by their write logs not growing.
    const right = accessory.getServiceById(Service.StatelessProgrammableSwitch, buttonSubtype("right"))?.getCharacteristic(Characteristic.ConfiguredName);
    const left = accessory.getServiceById(Service.StatelessProgrammableSwitch, buttonSubtype("left"))?.getCharacteristic(Characteristic.ConfiguredName);

    assert.ok(right && left, "the Right and Left switches carry a ConfiguredName");

    const rightWrites = right.writes.length;
    const leftWrites = left.writes.length;

    // Flip the controller's labeling to the position-hint numbering and let the observer wake.
    store.pushFobPatch(fobConfig.id, { buttonLabels: "positionHint" });

    await settle();

    for(const button of FOB_BUTTONS) {

      const service = accessory.getServiceById(Service.StatelessProgrammableSwitch, buttonSubtype(button.wireId));

      assert.ok(service, button.label + "'s switch exists");
      assert.equal(service.getCharacteristic(Characteristic.ConfiguredName).value, button.positionLabel,
        button.label + "'s ConfiguredName followed the flip to its controller-numbered label");
    }

    assert.equal(right.writes.length, rightWrites, "Right's ConfiguredName was not rewritten - its two labels coincide, so the steady-state skip applied");
    assert.equal(left.writes.length, leftWrites, "Left's ConfiguredName was not rewritten - its two labels coincide, so the steady-state skip applied");
  });

  test("a user-renamed button survives a labeling flip while a plugin-managed sibling is renamed in the same pass", async () => {

    const arm = accessory.getServiceById(Service.StatelessProgrammableSwitch, buttonSubtype("arm"));
    const night = accessory.getServiceById(Service.StatelessProgrammableSwitch, buttonSubtype("night"));

    assert.ok(arm && night, "the arm and night switches exist");

    // The user renames the arm button to a custom string the plugin never authors for any button, so it is a user override.
    arm.updateCharacteristic(Characteristic.ConfiguredName, "Front Door");

    store.pushFobPatch(fobConfig.id, { buttonLabels: "positionHint" });

    await settle();

    assert.equal(arm.getCharacteristic(Characteristic.ConfiguredName).value, "Front Door", "the user-renamed arm button is left untouched across the flip");
    assert.equal(night.getCharacteristic(Characteristic.ConfiguredName).value, "2",
      "the plugin-managed night button was renamed to its controller number in the same pass");
  });

  test("a button whose name equals the other mode's default is owned by the plugin and reconciled, documenting the designed indistinguishability", () => {

    // A restored accessory carrying every button at its security-action label, then arm alone overwritten to "1" - the position-hint default. A user who typed "1" by
    // hand is indistinguishable from plugin management, so the configure-time reconcile in security-action mode treats arm's "1" as plugin-owned and rewrites it.
    const restored = makeTestAccessory("Test Fob", "uuid:test-fob-boundary");

    restored.addService(Service.ServiceLabel, "Test Fob");

    for(const button of FOB_BUTTONS) {

      const svc = restored.addService(Service.StatelessProgrammableSwitch, button.label, buttonSubtype(button.wireId));

      svc.updateCharacteristic(Characteristic.ServiceLabelIndex, button.index);
      svc.updateCharacteristic(Characteristic.ConfiguredName, button.label);
    }

    const restoredArm = restored.getServiceById(Service.StatelessProgrammableSwitch, buttonSubtype("arm"));

    assert.ok(restoredArm, "the restored arm switch exists");
    restoredArm.updateCharacteristic(Characteristic.ConfiguredName, "1");

    const built = buildFob({ buttonLabels: "securityActions" }, { accessory: restored });

    const arm = built.accessory.getServiceById(Service.StatelessProgrammableSwitch, buttonSubtype("arm"));

    assert.ok(arm, "the arm switch survives the reconfigure");
    assert.equal(arm.getCharacteristic(Characteristic.ConfiguredName).value, "Arm",
      "arm's other-mode default was treated as plugin-owned and reconciled to the active security-action label");

    built.fob.cleanup();
  });

  test("an offline labeling flip is reconciled at configure time with no observer wake", () => {

    // Seed a restored accessory carrying every button at its security-action label - as HomeKit restores a fob last configured under that labeling - then reconfigure the
    // SAME accessory with the controller reporting the position-hint labeling. The reconcile below is asserted before any settle, proving the configure-time pass did
    // it: the store's observe never replays a flip that happened while Homebridge was down.
    const restored = makeTestAccessory("Test Fob", "uuid:test-fob-offline");

    restored.addService(Service.ServiceLabel, "Test Fob");

    for(const button of FOB_BUTTONS) {

      const svc = restored.addService(Service.StatelessProgrammableSwitch, button.label, buttonSubtype(button.wireId));

      svc.updateCharacteristic(Characteristic.ServiceLabelIndex, button.index);
      svc.updateCharacteristic(Characteristic.ConfiguredName, button.label);
    }

    const built = buildFob({ buttonLabels: "positionHint" }, { accessory: restored });

    for(const button of FOB_BUTTONS) {

      const service = built.accessory.getServiceById(Service.StatelessProgrammableSwitch, buttonSubtype(button.wireId));

      assert.ok(service, button.label + "'s switch survives the reconfigure");
      assert.equal(service.getCharacteristic(Characteristic.ConfiguredName).value, button.positionLabel,
        button.label + "'s ConfiguredName was reconciled to the controller-numbered label at configure time");
    }

    built.fob.cleanup();
  });

  test("a steady-state configure writes each button's ConfiguredName once and logs no button-labeling line", () => {

    // On a fresh accessory the create callback writes each ConfiguredName to the active label, so the configure-time reconcile immediately below finds current === active
    // and writes nothing more. A second write would mean the reconcile mistook a just-created name for a rename.
    for(const button of FOB_BUTTONS) {

      const service = accessory.getServiceById(Service.StatelessProgrammableSwitch, buttonSubtype(button.wireId));

      assert.ok(service, button.label + "'s switch exists");
      assert.equal(service.getCharacteristic(Characteristic.ConfiguredName).writes.length, 1,
        button.label + "'s ConfiguredName was written once at create and left untouched by the configure-time reconcile");
    }

    const labelingLines = logEntries.filter((entry) => (entry.level === "info") && entry.formatted.includes("button names"));

    assert.deepEqual(labelingLines, [], "a steady-state configure logs no button-labeling info line");
  });
});
