/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * chime.test.ts: The chime behavior-test family - behavior tests over a REAL constructed ProtectChime.
 *
 * ProtectChime extends ProtectDevice directly (no streaming-stack drag), so like ProtectLight it is unit-constructable, and this suite is the next such family after the
 * light reference: a read-through projection double with a play command surface, config builders, per-slice and collection push helpers, and behavior-FIRST assertions
 * (the observers, the buzzer / ringtone speaker switches, the legacy-service removal, the play dispatch, and the MQTT tone handler). Every assertion drives the
 * REAL production class through its real configureDevice / spawnObservers paths and its real playTone over the real runDeviceCommand seam - never a modeled stand-in.
 *
 * This suite covers the chime's complete playTone behavior through the real production class: the chime's speaker join,
 * the missing-ring fallback, the empty-ringSettings no-op, the buzzer no-join, the no-tone-selected empty payload, the rejection and the authorization paths are all
 * netted here END-TO-END through the real switch onSet AND the real MQTT subscribeSet("tone") handler. The empty-payload (no-tone-selected) case is reachable ONLY via
 * the MQTT "chime" path - the switch onSet always carries a tone subtype on a speaker switch - so it is asserted through the captured MQTT handler.
 *
 * Two framing details the assertions honor exactly. First, the onSet's reverts are bare setTimeout(...,50) NOT registered in this.timers, so chime.cleanup() does
 * not clear them; the tests that arm a bare revert (the failed / falsy / no-op play paths) await ~60ms so the revert fires within the test (touching only this test's
 * fresh accessory). Second, registerTimeout and the "Playing %s." log fire ONLY after playTone resolves true - a falsy set, a no-op play, and a rejected play all
 * share the same bare 50ms revert-only setTimeout from the first framing detail above, with no registerTimeout armed and no "Playing" line logged. The afterEach(()
 * => chime?.cleanup()) clears the registerTimeout play-timers per test (the light suite needs no such hook because the light arms none).
 *
 * The isolation model mirrors the light reference: a beforeEach builds a fresh chime so the capture arrays, the characteristic state, the observer baselines, and
 * store.observerCount are clean every test, and the wake log is windowed per push via a captured baseline.
 */
import { Characteristic, Service, TestChimeProjection, TestStateStore, makeChimeConfig, makeProtectState, makeRingtoneConfig, makeTestAccessory, makeTestNvr, settle }
  from "../testing.helpers.ts";
import type { Chime, ProtectRingtoneConfig } from "unifi-protect";
import type { TestAccessory, TestLogEntry, TestMqttClient } from "../testing.helpers.ts";
import { after, afterEach, before, beforeEach, describe, mock, test } from "node:test";
import type { ObserverWakePayload } from "../diagnostics.ts";
import type { ProtectAccessory } from "../types.ts";
import { ProtectAuthorizationError } from "unifi-protect";
import { ProtectChime } from "./chime.ts";
import type { ProtectNvr } from "../nvr/nvr.ts";
import { ProtectReservedNames } from "../types.ts";
import assert from "node:assert/strict";
import diagnosticsChannel from "node:diagnostics_channel";

// The device log wrapper formats every line through util.format into a single string parameter prefixed with the device name (for example "Test Chime: Playing buzzer."),
// so a log assertion matches a substring of that one formatted parameter at the given level rather than re-deriving the format args. A plain substring match (not a
// regex) keeps the house lint rules satisfied and reads as the intent: did the chime log this line at this level.
function loggedAt(entries: TestLogEntry[], level: TestLogEntry["level"], substring: string): boolean {

  return entries.some((entry) => (entry.level === level) && String(entry.parameters[0]).includes(substring));
}

// The reusable construction helper: build a REAL ProtectChime against the harness doubles, seeding the chime record plus whatever ringtones the test wants. The casts
// are confined to the construction seam exactly as the light suite does; the instance under test is the production class running its real configureDevice /
// spawnObservers paths. Returns logEntries and mqtt (the light suite needs neither; the chime asserts both the failure log lines and the captured MQTT tone handler).
// The accessory factory is injectable so the legacy-removal test can pre-seed a Lightbulb and a bare speaker Switch before construction.
function buildChime(configOptions: Parameters<typeof makeChimeConfig>[0] = {}, harnessOptions: { accessory?: TestAccessory; ringtones?: ProtectRingtoneConfig[] } = {}): {
  accessory: TestAccessory; chime: ProtectChime; logEntries: TestLogEntry[]; mqtt: TestMqttClient; projection: TestChimeProjection; store: TestStateStore;
} {

  const chimeConfig = makeChimeConfig(configOptions);
  const store = new TestStateStore(makeProtectState({ chimes: [chimeConfig], ringtones: harnessOptions.ringtones ?? [] }));
  const { logEntries, mqtt, nvr } = makeTestNvr({ mqtt: true, store });
  const accessory = harnessOptions.accessory ?? makeTestAccessory("Test Chime", "uuid:test-chime");
  const projection = new TestChimeProjection(chimeConfig.id, store);
  const chime = new ProtectChime(nvr as unknown as ProtectNvr, accessory as unknown as ProtectAccessory, projection as unknown as Chime);

  // makeTestNvr was called with mqtt: true, so the recording double is present; a guard narrows Nullable<TestMqttClient> to the non-null type without an assertion or a
  // same-type cast (either of which the house lint preset forbids in opposite directions), and fails loudly if the opt-in ever stops installing the double.
  if(!mqtt) {

    throw new Error("The MQTT recording double was not installed despite mqtt: true.");
  }

  return { accessory, chime, logEntries, mqtt, projection, store };
}

describe("real ProtectChime construction and play behavior", () => {

  // The one observer-wake subscription for the whole suite, installed before any construction and removed once in the unconditional teardown. A leaked subscriber would
  // flip hasSubscribers for every later test in the process, so it is removed exactly once.
  const wakeLog: ObserverWakePayload[] = [];
  const onWake = (message: unknown): void => { wakeLog.push(message as ObserverWakePayload); };

  // The per-test-fresh handles, rebuilt in beforeEach so every test starts from a clean chime, clean captures, and clean wake baseline.
  let accessory: TestAccessory;
  let chime: ProtectChime | undefined;
  let constructionWakes = 0;
  let logEntries: TestLogEntry[];
  let mqtt: TestMqttClient;
  let projection: TestChimeProjection;
  let store: TestStateStore;

  before(() => {

    diagnosticsChannel.subscribe("hbup:observer:wake", onWake);
  });

  after(() => {

    diagnosticsChannel.unsubscribe("hbup:observer:wake", onWake);
  });

  beforeEach(async () => {

    // The default fixture: one ringtone (so a speaker switch exists) whose id is the chime's one ringSettings entry, so a speaker play joins a real ring.
    ({ accessory, chime, logEntries, mqtt, projection, store } = buildChime(
      { ringSettings: [{ cameraId: "doorbell-1", repeatTimes: 2, ringtoneId: "test-ringtone-1", volume: 65 }] },
      { ringtones: [makeRingtoneConfig({ id: "test-ringtone-1", name: "Test Ringtone" })] }));

    // Settle the observe loops' lazy registration before any test asserts, then snapshot the construction-wake count and reset the window so each test measures only
    // its own pushes.
    await settle();

    constructionWakes = wakeLog.length;
    wakeLog.length = 0;
  });

  // The chime arms registerTimeout play-timers on a truthy onSet; cleanup() clears them. Each test gets a fresh accessory, so a test that built its own variant cleans
  // that one up locally; this hook clears the beforeEach-built default.
  afterEach(() => {

    chime?.cleanup();
  });

  test("three observers register, construction wakes none, and the buzzer plus one speaker switch exist", () => {

    assert.equal(store.observerCount, 3, "the two base observers plus the chime's ringtone-collection observer are registered against the store double");
    assert.equal(constructionWakes, 0, "no observer wake was published during construction - observers arm against the baseline and stay silent");
    assert.ok(accessory.getServiceById(Service.Switch, ProtectReservedNames.SWITCH_DOORBELL_CHIME_BUZZER), "configureDevice configured the buzzer switch");
    assert.ok(accessory.getServiceById(Service.Switch, ProtectReservedNames.SWITCH_DOORBELL_CHIME_SPEAKER + ".test-ringtone-1"),
      "configureRingtoneSwitches configured a speaker switch for the seeded ringtone");
  });

  test("a speaker switch per seeded ringtone is configured, and the count matches the seeded ringtone count", () => {

    const fixture = buildChime({}, { ringtones: [ makeRingtoneConfig({ id: "ring-a", name: "Ring A" }), makeRingtoneConfig({ id: "ring-b", name: "Ring B" }) ] });

    const speakerSwitches = fixture.accessory.services.filter((service) => (service.UUID === Service.Switch.UUID) &&
      Boolean(service.subtype?.startsWith(ProtectReservedNames.SWITCH_DOORBELL_CHIME_SPEAKER + ".")));

    assert.equal(speakerSwitches.length, 2, "one speaker switch was configured per seeded ringtone");
    assert.ok(fixture.accessory.getServiceById(Service.Switch, ProtectReservedNames.SWITCH_DOORBELL_CHIME_SPEAKER + ".ring-a"), "the first ringtone's switch exists");
    assert.ok(fixture.accessory.getServiceById(Service.Switch, ProtectReservedNames.SWITCH_DOORBELL_CHIME_SPEAKER + ".ring-b"), "the second ringtone's switch exists");

    fixture.chime.cleanup();
  });

  test("a ringtone whose nvrMac does not match the controller is filtered out, leaving no speaker switch", () => {

    const fixture = buildChime({}, { ringtones: [makeRingtoneConfig({ id: "foreign", name: "Foreign", nvrMac: "FFFFFFFFFFFF" })] });

    const speakerSwitches = fixture.accessory.services.filter((service) => (service.UUID === Service.Switch.UUID) &&
      Boolean(service.subtype?.startsWith(ProtectReservedNames.SWITCH_DOORBELL_CHIME_SPEAKER + ".")));

    assert.equal(speakerSwitches.length, 0, "a ringtone scoped to a different controller is filtered out and creates no speaker switch");

    fixture.chime.cleanup();
  });

  test("a pre-seeded legacy Lightbulb and bare speaker Switch are removed at construction", () => {

    // A fresh accessory carries neither, so the removal would be vacuous; we pre-seed both onto the accessory BEFORE constructing the chime so configureDevice's
    // Lightbulb removal and legacy bare-speaker-Switch removal are exercised genuinely.
    const seeded = makeTestAccessory("Legacy Chime", "uuid:legacy-chime");

    seeded.addService(new Service.Lightbulb("Legacy Volume"));
    seeded.addService(new Service.Switch("Legacy Speaker", ProtectReservedNames.SWITCH_DOORBELL_CHIME_SPEAKER));

    assert.ok(seeded.getService(Service.Lightbulb), "the legacy Lightbulb was seeded onto the accessory before construction");
    assert.ok(seeded.getServiceById(Service.Switch, ProtectReservedNames.SWITCH_DOORBELL_CHIME_SPEAKER), "the legacy bare speaker Switch was seeded before construction");

    const fixture = buildChime({}, { accessory: seeded });

    assert.equal(seeded.getService(Service.Lightbulb), undefined, "configureDevice removed the legacy Lightbulb volume service");
    assert.equal(seeded.getServiceById(Service.Switch, ProtectReservedNames.SWITCH_DOORBELL_CHIME_SPEAKER), undefined,
      "configureDevice removed the legacy bare speaker Switch");

    fixture.chime.cleanup();
  });

  test("turning the buzzer switch on plays the buzzer, publishes the tone, logs Playing, and arms the timer", async () => {

    const buzzerSwitch = accessory.getServiceById(Service.Switch, ProtectReservedNames.SWITCH_DOORBELL_CHIME_BUZZER);

    assert.ok(buzzerSwitch, "the buzzer switch exists");

    await buzzerSwitch.getCharacteristic(Characteristic.On).triggerSet(true);

    assert.equal(projection.playBuzzerCalls.length, 1, "the real playTone dispatched a single playBuzzer call with no ringtone join");
    assert.equal(projection.playSpeakerCalls.length, 0, "the buzzer never dispatches to the speaker");
    assert.deepEqual(mqtt.published, [{ message: "buzzer", topic: projection.config.mac + "/tone" }],
      "an accepted buzzer publishes its tone name on the device-scoped topic");
    assert.ok(loggedAt(logEntries, "info", "Playing buzzer."), "the Playing info log fired for the buzzer");
    assert.equal(await buzzerSwitch.getCharacteristic(Characteristic.On).triggerGet(), true, "the On getter reads the armed registerTimeout play-timer");
  });

  test("turning a ringtone speaker switch on joins the configured repeat/volume/ringtoneId into the speaker payload", async () => {

    const speakerSwitch = accessory.getServiceById(Service.Switch, ProtectReservedNames.SWITCH_DOORBELL_CHIME_SPEAKER + ".test-ringtone-1");

    assert.ok(speakerSwitch, "the seeded ringtone's speaker switch exists");

    await speakerSwitch.getCharacteristic(Characteristic.On).triggerSet(true);

    assert.equal(projection.playSpeakerCalls.length, 1, "the real playTone dispatched a single playSpeaker call");
    assert.deepEqual(projection.playSpeakerCalls[0]?.opts, { repeatTimes: 2, ringtoneId: "test-ringtone-1", volume: 65 },
      "the configured repeat/volume for the selected ringtone is joined into the payload alongside the requested ringtoneId");
    assert.ok(mqtt.published.some((published) => published.message === "Test Ringtone"), "an accepted speaker tone publishes the ringtone name");
  });

  test("a speaker tone whose id is absent from ringSettings falls back to the first ring entry for the playback values", async () => {

    // The chime's lone ringSettings entry is keyed to "tone-a", but the seeded ringtone's switch requests "absent-id", so the find fails and ringSettings[0] supplies
    // repeat/volume while the requested id is still sent. A non-empty ringSettings makes the fallback genuine (an empty one would no-op instead).
    const fixture = buildChime({ ringSettings: [{ cameraId: "doorbell-1", repeatTimes: 4, ringtoneId: "tone-a", volume: 30 }] },
      { ringtones: [makeRingtoneConfig({ id: "absent-id", name: "Absent" })] });

    const speakerSwitch = fixture.accessory.getServiceById(Service.Switch, ProtectReservedNames.SWITCH_DOORBELL_CHIME_SPEAKER + ".absent-id");

    assert.ok(speakerSwitch, "the speaker switch for the decoupled ringtone exists");

    await speakerSwitch.getCharacteristic(Characteristic.On).triggerSet(true);

    assert.deepEqual(fixture.projection.playSpeakerCalls[0]?.opts, { repeatTimes: 4, ringtoneId: "absent-id", volume: 30 },
      "the first ring entry supplies repeat/volume while the requested ringtoneId is sent unchanged");

    fixture.chime.cleanup();
  });

  test("a speaker tone with empty ringSettings is a no-op that reverts the switch without logging Playing or arming the reset", async () => {

    // The chime has no ringSettings, so playTone returns false and issues NO command. A false return reverts the switch to its real state and returns before the
    // "Playing" log or the playback-reset timer, so a no-op never shows as playing. The bare 50ms revert it arms is NOT in this.timers, so we await past it before this
    // test's afterEach.
    const fixture = buildChime({ ringSettings: [] }, { ringtones: [makeRingtoneConfig({ id: "empty-ring", name: "Empty Ring" })] });

    const speakerSwitch = fixture.accessory.getServiceById(Service.Switch, ProtectReservedNames.SWITCH_DOORBELL_CHIME_SPEAKER + ".empty-ring");

    assert.ok(speakerSwitch, "the speaker switch exists");

    await speakerSwitch.getCharacteristic(Characteristic.On).triggerSet(true);

    assert.equal(fixture.projection.playSpeakerCalls.length, 0, "no command is issued when there is no ring to source playback from");
    assert.equal(fixture.mqtt.published.length, 0, "a no-op play publishes nothing");
    assert.ok(!loggedAt(fixture.logEntries, "info", "Playing Empty Ring."), "the Playing info log does NOT fire on the no-op set");

    // Let the bare 50ms revert (not in this.timers) fire within the test; no playback-reset timer is armed on a no-op, so there is none to clean up.
    await new Promise<void>((resolve) => setTimeout(resolve, 60));

    fixture.chime.cleanup();
  });

  test("a rejecting play reports the failure through the shared helper, publishes nothing, and reverts without logging Playing or arming the reset", async () => {

    projection.playSpeakerCalls.length = 0;
    projection.playRejection = new Error("The chime is unreachable.");

    const speakerSwitch = accessory.getServiceById(Service.Switch, ProtectReservedNames.SWITCH_DOORBELL_CHIME_SPEAKER + ".test-ringtone-1");

    assert.ok(speakerSwitch, "the seeded ringtone's speaker switch exists");

    await speakerSwitch.getCharacteristic(Characteristic.On).triggerSet(true);

    assert.equal(projection.playSpeakerCalls.length, 1, "the command was attempted");
    assert.equal(mqtt.published.length, 0, "a failed play publishes nothing");
    assert.ok(loggedAt(logEntries, "error", "Unable to play Test Ringtone: The chime is unreachable."),
      "the shared command-error helper reported the single failure line");
    assert.ok(!loggedAt(logEntries, "info", "Playing Test Ringtone."), "the Playing info log does NOT fire on the failed play");

    // Let the bare 50ms revert (armed on the false playTone return, not in this.timers) fire within the test before afterEach; no reset timer is armed on a failure.
    await new Promise<void>((resolve) => setTimeout(resolve, 60));
  });

  test("an authorization failure on a play earns the Administrator-role guidance", async () => {

    projection.playRejection = new ProtectAuthorizationError("forbidden");

    const speakerSwitch = accessory.getServiceById(Service.Switch, ProtectReservedNames.SWITCH_DOORBELL_CHIME_SPEAKER + ".test-ringtone-1");

    assert.ok(speakerSwitch, "the seeded ringtone's speaker switch exists");

    await speakerSwitch.getCharacteristic(Characteristic.On).triggerSet(true);

    assert.ok(loggedAt(logEntries, "error", "Unable to play Test Ringtone. Please ensure this username has the full management role in UniFi Protect."),
      "an authorization failure earns the admin-role guidance");

    await new Promise<void>((resolve) => setTimeout(resolve, 60));
  });

  test("turning a switch off is a meaningless state: no command, no publish, just a deferred revert", async () => {

    const buzzerSwitch = accessory.getServiceById(Service.Switch, ProtectReservedNames.SWITCH_DOORBELL_CHIME_BUZZER);

    assert.ok(buzzerSwitch, "the buzzer switch exists");

    await buzzerSwitch.getCharacteristic(Characteristic.On).triggerSet(false);

    assert.equal(projection.playBuzzerCalls.length, 0, "a falsy set issues no command - you cannot undo a play");
    assert.equal(mqtt.published.length, 0, "a falsy set publishes nothing");
    assert.ok(!loggedAt(logEntries, "info", "Playing "), "a falsy set logs no Playing line and arms no registerTimeout");

    // The falsy path arms only a bare 50ms revert (not in this.timers); let it fire within the test.
    await new Promise<void>((resolve) => setTimeout(resolve, 60));
  });

  test("the MQTT tone handler dispatches buzzer, chime (empty payload), and rejects an unknown tone", async () => {

    const toneSet = mqtt.subscriptions.find((subscription) => (subscription.kind === "set") && (subscription.topic === projection.config.mac + "/tone"));

    assert.ok(toneSet?.setValue, "the chime registered a captured set handler for the tone topic");

    // "buzzer" dispatches the piezo buzzer.
    await toneSet.setValue("buzzer", "buzzer");

    assert.equal(projection.playBuzzerCalls.length, 1, "the MQTT buzzer value dispatched playBuzzer");

    // "chime" plays the speaker with NO tone, the empty-payload default - the no-tone-selected case reachable only here, never via the switch onSet.
    await toneSet.setValue("chime", "chime");

    assert.equal(projection.playSpeakerCalls.length, 1, "the MQTT chime value dispatched a single playSpeaker");
    assert.deepEqual(projection.playSpeakerCalls[0]?.opts, {}, "the no-tone-selected chime path sends an empty payload so the controller plays the default ringtone");

    // An unknown value logs the error and dispatches nothing.
    await toneSet.setValue("nonsense", "nonsense");

    assert.equal(projection.playBuzzerCalls.length, 1, "an unknown tone dispatches no buzzer");
    assert.equal(projection.playSpeakerCalls.length, 1, "an unknown tone dispatches no speaker");
    assert.ok(loggedAt(logEntries, "error", "Unknown chime tone."), "an unknown tone logs the error");
  });

  test("the MQTT subscriptions compose the device-MAC-scoped tone topic tail", () => {

    const tails = mqtt.subscriptions.map((subscription) => subscription.topic);

    assert.ok(tails.includes(projection.config.mac + "/tone"), "the chime tone subscription composed the device-scoped tail");
  });

  test("a ringtone-collection push wakes only the ringtone observer and reconciles the speaker switches", async () => {

    const baseline = wakeLog.length;

    // Replace the lone seeded ringtone with two different ones: the old switch is pruned, two new ones are added.
    store.pushRingtones([ makeRingtoneConfig({ id: "new-a", name: "New A" }), makeRingtoneConfig({ id: "new-b", name: "New B" }) ]);

    await settle();

    assert.deepEqual(wakeLog.slice(baseline), [{ accessoryId: accessory.UUID, key: "nvr.ringtones" }], "exactly the ringtone-collection observer woke for this push");
    assert.equal(accessory.getServiceById(Service.Switch, ProtectReservedNames.SWITCH_DOORBELL_CHIME_SPEAKER + ".test-ringtone-1"), undefined,
      "the removed ringtone's speaker switch was pruned");
    assert.ok(accessory.getServiceById(Service.Switch, ProtectReservedNames.SWITCH_DOORBELL_CHIME_SPEAKER + ".new-a"), "a switch was added for the first new ringtone");
    assert.ok(accessory.getServiceById(Service.Switch, ProtectReservedNames.SWITCH_DOORBELL_CHIME_SPEAKER + ".new-b"), "a switch was added for the second new ringtone");
  });

  test("concurrent ringtone plays keep independent per-switch reset timers, so neither strands the other on", async () => {

    // Two ringtones with their own switches. Each play's auto-reset is keyed by the switch's own subtype, so tapping the second never displaces the first's reset - a
    // shared "speaker" key would, stranding the first switch on forever. The chime speaker window is PROTECT_DOORBELL_CHIME_SPEAKER_DURATION (3500ms).
    const fixture = buildChime({ ringSettings: [{ cameraId: "doorbell-1", repeatTimes: 1, ringtoneId: "ring-a", volume: 50 }] },
      { ringtones: [ makeRingtoneConfig({ id: "ring-a", name: "Ring A" }), makeRingtoneConfig({ id: "ring-b", name: "Ring B" }) ] });
    const switchA = fixture.accessory.getServiceById(Service.Switch, ProtectReservedNames.SWITCH_DOORBELL_CHIME_SPEAKER + ".ring-a");
    const switchB = fixture.accessory.getServiceById(Service.Switch, ProtectReservedNames.SWITCH_DOORBELL_CHIME_SPEAKER + ".ring-b");

    assert.ok(switchA && switchB, "both ringtone switches exist");

    mock.timers.enable({ apis: ["setTimeout"] });

    try {

      // Tap A at t0, arming its reset at t0 + 3500.
      await switchA.getCharacteristic(Characteristic.On).triggerSet(true);

      // Advance to t0 + 1500 and tap B, arming its reset at t0 + 5000.
      mock.timers.tick(1500);
      await switchB.getCharacteristic(Characteristic.On).triggerSet(true);

      // Checkpoint 1 (~t0 + 2000, inside A's own 3500ms window): A still reads playing, undisplaced by B's tap.
      mock.timers.tick(500);

      assert.equal(await switchA.getCharacteristic(Characteristic.On).triggerGet(), true, "A's switch still reads playing inside its own window");

      // Checkpoint 2 (~t0 + 4000: A's window closed at 3500, B's still open until 5000): A resets off, B stays on.
      mock.timers.tick(2000);

      assert.equal(switchA.getCharacteristic(Characteristic.On).value, false, "A's switch resets off when its own window closes - it is not stranded on by B's play");
      assert.equal(await switchA.getCharacteristic(Characteristic.On).triggerGet(), false, "A's play-timer is gone after its own window");
      assert.equal(await switchB.getCharacteristic(Characteristic.On).triggerGet(), true, "B's switch remains playing until its own later window closes");

      // Checkpoint 3 (past t0 + 5000): B's window closes and it resets off too.
      mock.timers.tick(1500);

      assert.equal(switchB.getCharacteristic(Characteristic.On).value, false, "B's switch resets off when its own window closes");
      assert.equal(await switchB.getCharacteristic(Characteristic.On).triggerGet(), false, "B's play-timer is gone after its own window");
    } finally {

      mock.timers.reset();
      fixture.chime.cleanup();
    }
  });
});
