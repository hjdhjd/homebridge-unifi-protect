/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * testing.helpers.test.ts: Unit tests for the device-family test helpers in testing.helpers.ts.
 *
 * The config builders and projection doubles are themselves code, and a defect in one would silently corrupt every device test that seeds a record or reads through a
 * projection. They earn the same coverage rigor as production: each builder's populated read set, each projection's read-through behavior and recorded writes, the
 * per-slice push helpers' targeting, and the TestBaseDevice vehicle the shared base-device concerns ride.
 */
import { Characteristic, Service, TestStateStore, makeProtectState, makeTestAccessory, settle } from "../testing.helpers.ts";
import type { ProtectLightConfig, Sensor } from "unifi-protect";
import { TestBaseDevice, TestCameraProjection, TestChimeProjection, TestLightProjection, TestSensorProjection, TestViewerProjection, makeCameraConfig, makeChimeConfig,
  makeLightConfig, makeLiveviewConfig, makeRingtoneConfig, makeSensorConfig, makeViewerConfig } from "./testing.helpers.ts";
import { TestRecordingDispatch, makeNvrConfig, makeTestNvr } from "../nvr/testing.helpers.ts";
import { describe, test } from "node:test";
import type { ProtectAccessory } from "../types.ts";
import { ProtectEventDispatch } from "../nvr/event-dispatch.ts";
import type { ProtectNvr } from "../nvr/nvr.ts";
import assert from "node:assert/strict";

describe("harness growth: chime state", () => {

  test("makeChimeConfig populates the chime-volume read set and pushChimePatch wakes only chime-derived selectors that changed", async () => {

    const chime = makeChimeConfig({ cameraIds: ["camera-1"], ringSettings: [{ cameraId: "camera-1", volume: 50 }] });
    const store = new TestStateStore(makeProtectState({ chimes: [chime] }));
    const controller = new AbortController();
    const iterator = store.observe((state) => state.chimes.get(chime.id)?.ringSettings.find((ring) => ring.cameraId === "camera-1")?.volume,
      { signal: controller.signal });
    const first = iterator.next();

    await settle();

    // An unrelated chime patch leaves the derived volume unchanged, so the observer must stay parked; the volume change is the only wake.
    store.pushChimePatch(chime.id, { name: "Renamed Chime" });
    store.pushChimePatch(chime.id, { ringSettings: [{ cameraId: "camera-1", repeatTimes: 1, ringtoneId: "default", volume: 80 }] });

    assert.equal((await first).value, 80, "the volume change is the first and only yield");

    controller.abort();

    assert.equal((await iterator.next()).done, true, "abort completes the iterator");
  });
});

describe("A2 light family: config builder, push helpers, and projection double", () => {

  test("makeLightConfig defaults the verified read set and merges overrides into the right (nested) slots", () => {

    // The bare-call defaults: the power state off, the LED level at the bottom of Protect's 1-6 scale, no motion, and a connected state - the quiet baseline the light
    // observe tests seed before pushing a single field.
    const defaults = makeLightConfig();

    assert.equal(defaults.isLightOn, false, "isLightOn defaults to false");
    assert.equal(defaults.lightDeviceSettings.ledLevel, 1, "ledLevel defaults to 1, the bottom of the Protect scale");
    assert.equal(defaults.lightDeviceSettings.isIndicatorEnabled, false, "isIndicatorEnabled defaults to false");
    assert.equal(defaults.lastMotion, null, "lastMotion defaults to null");
    assert.equal(defaults.state, "CONNECTED", "state defaults to CONNECTED");
    assert.equal(defaults.modelKey, "light", "the modelKey is light");

    // Every override lands, and the two nested options compose under lightDeviceSettings rather than the top level.
    const overridden = makeLightConfig({ id: "light-99", isIndicatorEnabled: true, isLightOn: true, lastMotion: 1700000000000, ledLevel: 4, mac: "AABBCCDDEE01",
      name: "Porch Light" });

    assert.equal(overridden.id, "light-99", "the id override lands");
    assert.equal(overridden.isLightOn, true, "the isLightOn override lands");
    assert.equal(overridden.lastMotion, 1700000000000, "the lastMotion override lands");
    assert.equal(overridden.mac, "AABBCCDDEE01", "the mac override lands");
    assert.equal(overridden.name, "Porch Light", "the name override lands");
    assert.equal(overridden.lightDeviceSettings.ledLevel, 4, "ledLevel nests under lightDeviceSettings");
    assert.equal(overridden.lightDeviceSettings.isIndicatorEnabled, true, "isIndicatorEnabled nests under lightDeviceSettings");
  });

  test("pushLightPatch replaces only the targeted light record, structural-sharing every untouched slice, and throws on a missing id", () => {

    const lightA = makeLightConfig({ id: "light-a" });
    const lightB = makeLightConfig({ id: "light-b", mac: "AABBCCDDEE02" });
    const camera = makeCameraConfig({ channels: [] });
    const store = new TestStateStore(makeProtectState({ cameras: [camera], lights: [ lightA, lightB ] }));
    const before = store.snapshot();

    store.pushLightPatch("light-a", { isLightOn: true });

    const after = store.snapshot();

    // The patched record is a NEW reference carrying the new field; every other light record, and every other slice, keeps its reference (Object.is) - the structural
    // sharing the narrow observers' dedup depends on.
    assert.notEqual(after.lights.get("light-a"), before.lights.get("light-a"), "the patched record is a fresh reference");
    assert.equal(after.lights.get("light-a")?.isLightOn, true, "the patch applied to the targeted record");
    assert.ok(Object.is(after.lights.get("light-b"), before.lights.get("light-b")), "the untouched sibling light record keeps its reference");
    assert.ok(Object.is(after.cameras, before.cameras), "the untouched cameras slice keeps its reference");

    assert.throws(() => store.pushLightPatch("light-missing", { isLightOn: true }), /not present in the store double: light-missing/,
      "patching an absent id throws the store-double guard");
  });

  test("pushLightDeviceSettings composes one nested field while preserving the rest, and throws on a missing id", () => {

    const light = makeLightConfig({ id: "light-c", isIndicatorEnabled: true, ledLevel: 1 });
    const store = new TestStateStore(makeProtectState({ lights: [light] }));

    // Move only ledLevel; the composing helper must preserve the live isIndicatorEnabled rather than dropping it the way a shallow pushLightPatch of lightDeviceSettings
    // would.
    store.pushLightDeviceSettings("light-c", { ledLevel: 6 });

    const record = store.snapshot().lights.get("light-c");

    assert.equal(record?.lightDeviceSettings.ledLevel, 6, "the targeted nested field moved");
    assert.equal(record?.lightDeviceSettings.isIndicatorEnabled, true, "the untouched nested field persists through the compose");

    assert.throws(() => store.pushLightDeviceSettings("light-missing", { ledLevel: 2 }), /not present in the store double: light-missing/,
      "composing against an absent id throws the store-double guard");
  });

  test("TestLightProjection reads through to the current store record, guards an absent record, and derives isOnline / name", () => {

    const light = makeLightConfig({ id: "light-d" });
    const store = new TestStateStore(makeProtectState({ lights: [light] }));
    const projection = new TestLightProjection("light-d", store);

    assert.equal(projection.config, store.snapshot().lights.get("light-d"), "config reads through to the seeded record");
    assert.equal(projection.isOnline, true, "isOnline is true for a CONNECTED record");

    // A never-seeded id throws the absent-record guard, exactly as the real projection does when its record leaves the store.
    const absent = new TestLightProjection("light-never", store);

    assert.throws(() => absent.config, /The light record is not present in the store double: light-never/, "the absent-record guard throws");

    // The name fallback: name when present, otherwise displayName. We cover both branches. The present branch uses the builder (which sets name); the fallback branch
    // seeds a record with name explicitly undefined and a distinct displayName to actually exercise the ?? branch (a config defaulting both to the same value would
    // leave it unexercised).
    const named = makeLightConfig({ id: "light-named", name: "Named Light" });
    const namedStore = new TestStateStore(makeProtectState({ lights: [named] }));

    assert.equal(new TestLightProjection("light-named", namedStore).name, "Named Light", "name returns the user-assigned name when present");

    const fallbackRecord = { displayName: "Fallback Display", id: "light-fallback", lightDeviceSettings: { isIndicatorEnabled: false, ledLevel: 1 }, modelKey: "light",
      name: undefined, state: "CONNECTED" } as unknown as ProtectLightConfig;
    const fallbackStore = new TestStateStore(makeProtectState({ lights: [fallbackRecord] }));

    assert.equal(new TestLightProjection("light-fallback", fallbackStore).name, "Fallback Display", "name falls back to displayName when the name field is absent");
  });

  test("TestCameraProjection.update records the camera onSet payload, returns this, and rejects on the settable rejection without folding the store", async () => {

    const camera = makeCameraConfig({ channels: [], id: "camera-update" });
    const store = new TestStateStore(makeProtectState({ cameras: [camera] }));
    const projection = new TestCameraProjection("camera-update", store);

    // update records the raw payload, returns this, and deliberately does NOT fold into the store, so a reactive reflection a test asserts stays observer-driven.
    const returned = await projection.update({ ispSettings: { irLedMode: "auto" } });

    assert.equal(returned, projection, "update returns this");
    assert.deepEqual(projection.updateCalls, [{ payload: { ispSettings: { irLedMode: "auto" } } }], "update records the raw payload");
    assert.equal(store.snapshot().cameras.get("camera-update")?.ispSettings.irLedMode, "off",
      "update does NOT fold the payload into the store - the seeded config is unchanged");

    // A settable rejection drives the real runDeviceCommand failure path.
    projection.updateRejection = new Error("rejected");

    await assert.rejects(() => projection.update({ ledSettings: { isEnabled: true } }), /rejected/, "the settable rejection rejects update");
  });

  test("TestCameraProjection.lux records each query, resolves with the settable reading, and rejects on the settable rejection", async () => {

    const camera = makeCameraConfig({ channels: [], id: "camera-lux" });
    const store = new TestStateStore(makeProtectState({ cameras: [camera] }));
    const projection = new TestCameraProjection("camera-lux", store);

    // lux resolves with the settable reading and records the call, so a test can both read the value and prove the unreachable arm never queried.
    projection.luxReading = 42.5;

    const reading = await projection.lux();

    assert.equal(reading, 42.5, "lux resolves with the settable reading");
    assert.equal(projection.luxCalls.length, 1, "lux records the query");

    // A settable rejection drives the real getLux catch -> -1 sentinel path; the call is still recorded.
    projection.luxRejection = new Error("rejected");

    await assert.rejects(() => projection.lux(), /rejected/, "the settable rejection rejects lux");
    assert.equal(projection.luxCalls.length, 2, "the rejected query is still recorded");
  });

  test("TestCameraProjection.turnOnFlashlight records each pulse, resolves by default, and rejects on the settable rejection", async () => {

    const camera = makeCameraConfig({ channels: [], id: "camera-flashlight" });
    const store = new TestStateStore(makeProtectState({ cameras: [camera] }));
    const projection = new TestCameraProjection("camera-flashlight", store);

    // turnOnFlashlight resolves and records the call, so a test asserts the retry budget by count.
    await projection.turnOnFlashlight();

    assert.equal(projection.flashlightCalls.length, 1, "turnOnFlashlight records the pulse");

    // A settable rejection drives the real activateFlashlight retry-exhaustion -> reflected-off path; each rejected attempt is still recorded.
    projection.flashlightRejection = new Error("rejected");

    await assert.rejects(() => projection.turnOnFlashlight(), /rejected/, "the settable rejection rejects turnOnFlashlight");
    assert.equal(projection.flashlightCalls.length, 2, "the rejected pulse is still recorded");
  });

  test("the dispatch-injection hook defaults to the real ProtectEventDispatch and replaces it with the injected factory's instance", () => {

    const store = new TestStateStore(makeProtectState());

    // The default path: omitting dispatch builds the real ProtectEventDispatch. We assert on the constructor by identity, NOT instanceof - a subclass satisfies
    // instanceof too, so it would not prove the DEFAULT (un-subclassed) path actually ran.
    const { controller: defaultController, nvr: defaultNvr } = makeTestNvr({ store });

    assert.equal(defaultNvr.events.constructor, ProtectEventDispatch, "the default events member is exactly a ProtectEventDispatch, not a subclass");

    // The injected path: a trivial recording subclass arms no reset timer. The injected factory must replace the default with this exact instance, proving the
    // factory ran.
    class TrivialRecordingDispatch extends ProtectEventDispatch {

      public readonly calls: string[] = [];
    }

    const { controller: injectedController, nvr: injectedNvr } =
      makeTestNvr({ dispatch: (innerNvr: ProtectNvr): ProtectEventDispatch => new TrivialRecordingDispatch(innerNvr), store });

    assert.equal(injectedNvr.events.constructor, TrivialRecordingDispatch, "the injected factory's instance replaces the default events member");

    defaultController.abort();
    injectedController.abort();
  });
});

describe("A2 chime + viewer family: config builders, projection doubles, push helpers, client getters, and MQTT handler capture", () => {

  test("makeChimeConfig populates the construction read set (marketName / firmwareVersion / displayName) and keeps the chime-volume read set", () => {

    // The construction read set the real ProtectChime needs: setInfo reads marketName (the model derivation) and firmwareVersion (the firmware-revision write guard), and
    // the projection's name getter falls back to displayName. The existing chime-volume read set (cameraIds / ringSettings) must still default correctly.
    const defaults = makeChimeConfig();

    assert.equal(defaults.marketName, "Test Chime Model", "marketName defaults to the chime model name so setInfo writes a Model");
    assert.equal(defaults.firmwareVersion, "5.0.0", "firmwareVersion defaults so the firmware-revision write fires");
    assert.equal(defaults.displayName, "Test Chime", "displayName defaults to the name so the projection's name fallback resolves");
    assert.deepEqual(defaults.cameraIds, [], "cameraIds still defaults empty");
    assert.deepEqual(defaults.ringSettings, [], "ringSettings still defaults empty");
    assert.equal(defaults.modelKey, "chime", "the modelKey is chime");

    // The name override flows into both name and displayName, mirroring makeLightConfig.
    const named = makeChimeConfig({ name: "Hallway Chime", ringSettings: [{ cameraId: "doorbell-1", repeatTimes: 3, ringtoneId: "tone-x", volume: 40 }] });

    assert.equal(named.name, "Hallway Chime", "the name override lands");
    assert.equal(named.displayName, "Hallway Chime", "displayName follows the name override");
    assert.deepEqual(named.ringSettings, [{ cameraId: "doorbell-1", repeatTimes: 3, ringtoneId: "tone-x", volume: 40 }],
      "the ring entry's repeat/volume/ringtoneId land");
  });

  test("makeViewerConfig defaults the construction read set and merges overrides, with liveview nullable", () => {

    const defaults = makeViewerConfig();

    assert.equal(defaults.id, "test-viewer-1", "the id defaults");
    assert.equal(defaults.liveview, null, "liveview defaults to null - no active liveview");
    assert.equal(defaults.marketName, "Test Viewer Model", "marketName defaults so setInfo writes a Model");
    assert.equal(defaults.firmwareVersion, "5.0.0", "firmwareVersion defaults so the firmware-revision write fires");
    assert.equal(defaults.modelKey, "viewer", "the modelKey is viewer");
    assert.equal(defaults.state, "CONNECTED", "state defaults to CONNECTED");

    const overridden = makeViewerConfig({ id: "viewer-9", liveview: "liveview-7", mac: "AABBCCDDEE09", name: "Den Viewer" });

    assert.equal(overridden.id, "viewer-9", "the id override lands");
    assert.equal(overridden.liveview, "liveview-7", "the liveview override lands");
    assert.equal(overridden.mac, "AABBCCDDEE09", "the mac override lands");
    assert.equal(overridden.name, "Den Viewer", "the name override lands");
    assert.equal(overridden.displayName, "Den Viewer", "displayName follows the name override");
  });

  test("makeRingtoneConfig defaults nvrMac to the controller mac so the chime's filter keeps it", () => {

    const defaults = makeRingtoneConfig();

    // Required, not incidental: the chime filters ringtones by nvrMac === nvr.ufp.mac (the makeNvrConfig mac), so the default must match or every seeded ringtone
    // is dropped.
    assert.equal(defaults.nvrMac, "74ACB9FFFFFF", "nvrMac defaults to the makeNvrConfig controller mac");
    assert.equal(defaults.id, "test-ringtone-1", "the id defaults");
    assert.equal(defaults.modelKey, "ringtone", "the modelKey is ringtone");

    const overridden = makeRingtoneConfig({ id: "ring-9", name: "Ring Nine", nvrMac: "FFFFFFFFFFFF" });

    assert.equal(overridden.id, "ring-9", "the id override lands");
    assert.equal(overridden.name, "Ring Nine", "the name override lands");
    assert.equal(overridden.nvrMac, "FFFFFFFFFFFF", "the nvrMac override lands so a foreign-controller ringtone can be modeled");
  });

  test("makeLiveviewConfig defaults the viewer read set and merges overrides", () => {

    const defaults = makeLiveviewConfig();

    assert.equal(defaults.id, "test-liveview-1", "the id defaults");
    assert.equal(defaults.name, "Test Liveview", "the name defaults");
    assert.equal(defaults.modelKey, "liveview", "the modelKey is liveview");

    const overridden = makeLiveviewConfig({ id: "liveview-9", name: "Whole House" });

    assert.equal(overridden.id, "liveview-9", "the id override lands");
    assert.equal(overridden.name, "Whole House", "the name override lands");
  });

  test("TestChimeProjection reads through to the store, guards an absent record, and records play commands (resolving or rejecting)", async () => {

    const chime = makeChimeConfig({ id: "chime-d" });
    const store = new TestStateStore(makeProtectState({ chimes: [chime] }));
    const projection = new TestChimeProjection("chime-d", store);

    assert.equal(projection.config, store.snapshot().chimes.get("chime-d"), "config reads through to the seeded record");
    assert.equal(projection.isOnline, true, "isOnline is true for a CONNECTED record");
    assert.equal(projection.name, "Test Chime", "name resolves to the user-assigned name");
    assert.equal(projection.modelKey, "chime", "the modelKey is chime");

    const absent = new TestChimeProjection("chime-never", store);

    assert.throws(() => absent.config, /The chime record is not present in the store double: chime-never/, "the absent-record guard throws");

    // The command surface records and resolves by default.
    await projection.playBuzzer();
    await projection.playSpeaker({ repeatTimes: 2, ringtoneId: "tone-a", volume: 50 });

    assert.equal(projection.playBuzzerCalls.length, 1, "playBuzzer is recorded");
    assert.deepEqual(projection.playSpeakerCalls, [{ opts: { repeatTimes: 2, ringtoneId: "tone-a", volume: 50 } }], "playSpeaker records its joined payload");

    // A settable rejection drives the failure path for both commands.
    projection.playRejection = new Error("unreachable");

    await assert.rejects(() => projection.playBuzzer(), /unreachable/, "the settable rejection rejects playBuzzer");
    await assert.rejects(() => projection.playSpeaker(), /unreachable/, "the settable rejection rejects playSpeaker");
    assert.deepEqual(projection.playSpeakerCalls[1]?.opts, {}, "a default speaker call records the empty payload");
  });

  test("TestChimeProjection.update records the volume-write payload, returns this, does not fold the store, and rejects on its own distinct lever", async () => {

    const chime = makeChimeConfig({ id: "chime-u", ringSettings: [{ cameraId: "doorbell-1", volume: 30 }] });
    const store = new TestStateStore(makeProtectState({ chimes: [chime] }));
    const projection = new TestChimeProjection("chime-u", store);

    // update records the raw payload, returns this, and deliberately does NOT fold into the store, so the doorbell's volume reflection stays observer-driven.
    const returned = await projection.update({ ringSettings: [{ cameraId: "doorbell-1", repeatTimes: 1, ringtoneId: "default", volume: 70 }] });

    assert.equal(returned, projection, "update returns this");
    assert.deepEqual(projection.updateCalls, [{ payload: { ringSettings: [{ cameraId: "doorbell-1", repeatTimes: 1, ringtoneId: "default", volume: 70 }] } }],
      "update records the raw write-through payload");
    assert.equal(store.snapshot().chimes.get("chime-u")?.ringSettings[0]?.volume, 30, "update does NOT fold the payload into the store - the seeded ring is unchanged");

    // updateRejection is a DISTINCT lever from playRejection: a set play rejection does not fail the write, and a set update rejection does not fail a play.
    projection.playRejection = new Error("play unreachable");

    const survived = await projection.update({ ringSettings: [] });

    assert.equal(survived, projection, "a set playRejection does not reject the volume write - the levers are independent");

    projection.playRejection = null;
    projection.updateRejection = new Error("rejected");

    await assert.rejects(() => projection.update({ ringSettings: [] }), /rejected/, "the settable updateRejection rejects update");
    await projection.playBuzzer();
    assert.equal(projection.playBuzzerCalls.length, 1, "a set updateRejection does not reject a play - the levers are independent");
  });

  test("TestViewerProjection reads through to the store, guards an absent record, and records update payloads without folding", async () => {

    const viewer = makeViewerConfig({ id: "viewer-d", liveview: "liveview-1" });
    const store = new TestStateStore(makeProtectState({ viewers: [viewer] }));
    const projection = new TestViewerProjection("viewer-d", store);

    assert.equal(projection.config, store.snapshot().viewers.get("viewer-d"), "config reads through to the seeded record");
    assert.equal(projection.isOnline, true, "isOnline is true for a CONNECTED record");
    assert.equal(projection.name, "Test Viewer", "name resolves to the user-assigned name");
    assert.equal(projection.modelKey, "viewer", "the modelKey is viewer");

    const absent = new TestViewerProjection("viewer-never", store);

    assert.throws(() => absent.config, /The viewer record is not present in the store double: viewer-never/, "the absent-record guard throws");

    // update records the payload, returns this, and deliberately does NOT fold into the store (the active reflection stays observer-driven).
    const returned = await projection.update({ liveview: "liveview-2" });

    assert.equal(returned, projection, "update returns this");
    assert.deepEqual(projection.updateCalls, [{ liveview: "liveview-2" }], "update records the payload");
    assert.equal(store.snapshot().viewers.get("viewer-d")?.liveview, "liveview-1", "update does NOT fold the payload into the store - the config is unchanged");

    // A settable rejection drives the failure path.
    projection.updateRejection = new Error("rejected");

    await assert.rejects(() => projection.update({ liveview: null }), /rejected/, "the settable rejection rejects update");
  });

  test("pushViewerPatch replaces only the targeted viewer record, structural-sharing every untouched slice, and throws on a missing id", () => {

    const viewerA = makeViewerConfig({ id: "viewer-a" });
    const viewerB = makeViewerConfig({ id: "viewer-b", mac: "AABBCCDDEE02" });
    const store = new TestStateStore(makeProtectState({ viewers: [ viewerA, viewerB ] }));
    const before = store.snapshot();

    store.pushViewerPatch("viewer-a", { liveview: "liveview-7" });

    const after = store.snapshot();

    assert.notEqual(after.viewers.get("viewer-a"), before.viewers.get("viewer-a"), "the patched record is a fresh reference");
    assert.equal(after.viewers.get("viewer-a")?.liveview, "liveview-7", "the patch applied to the targeted record");
    assert.ok(Object.is(after.viewers.get("viewer-b"), before.viewers.get("viewer-b")), "the untouched sibling viewer record keeps its reference");

    assert.throws(() => store.pushViewerPatch("viewer-missing", { liveview: null }), /not present in the store double: viewer-missing/,
      "patching an absent id throws the store-double guard");
  });

  test("pushRingtones and pushLiveviews rebuild only their slice, structural-sharing every other slice", () => {

    const store = new TestStateStore(makeProtectState({ ringtones: [makeRingtoneConfig({ id: "ring-old" })] }));
    const before = store.snapshot();

    store.pushRingtones([ makeRingtoneConfig({ id: "ring-1" }), makeRingtoneConfig({ id: "ring-2" }) ]);

    const afterRingtones = store.snapshot();

    assert.deepEqual([...afterRingtones.ringtones.keys()], [ "ring-1", "ring-2" ], "the ringtones slice rebuilt from the supplied array");
    assert.ok(Object.is(afterRingtones.viewers, before.viewers), "an unrelated slice keeps its reference across a ringtones push");

    store.pushLiveviews([ makeLiveviewConfig({ id: "lv-1" }), makeLiveviewConfig({ id: "lv-2" }) ]);

    const afterLiveviews = store.snapshot();

    assert.deepEqual([...afterLiveviews.liveviews.keys()], [ "lv-1", "lv-2" ], "the liveviews slice rebuilt from the supplied array");
    assert.ok(Object.is(afterLiveviews.ringtones, afterRingtones.ringtones), "the ringtones slice keeps its reference across a liveviews push");
  });

  test("a whole-collection push preserves every POPULATED sibling slice, its records, and the nvr record - including a null one", () => {

    /* The sibling slices are populated here, which is what separates this from the structural-sharing pin above: that store seeds only the replaceable collections
     * (ringtones, liveviews today), so its untouched slices are empty maps and it cannot show the round-trip carrying real records through. Both whole-collection
     * helpers reduce through a bootstrap rebuilt from the current snapshot, one line per modeled slice, so a builder that dropped a slice or fabricated an nvr would
     * surface here as a lost record or a moved reference rather than as a silent hole.
     */
    const nvr = makeNvrConfig();
    const store = new TestStateStore(makeProtectState({ cameras: [makeCameraConfig({ channels: [], id: "camera-keep" })],
      liveviews: [makeLiveviewConfig({ id: "lv-keep" })], nvr, ringtones: [makeRingtoneConfig({ id: "ring-old" })],
      sensors: [makeSensorConfig({ id: "sensor-keep" })] }));
    const before = store.snapshot();

    store.pushRingtones([makeRingtoneConfig({ id: "ring-new" })]);

    const after = store.snapshot();

    assert.deepEqual([...after.ringtones.keys()], ["ring-new"], "the ringtones slice rebuilt from the supplied array");
    assert.ok(Object.is(after.cameras, before.cameras), "the populated cameras map keeps its own reference across a ringtones push");
    assert.ok(Object.is(after.sensors, before.sensors), "the populated sensors map keeps its own reference across a ringtones push");
    assert.ok(Object.is(after.liveviews, before.liveviews), "the populated liveviews map keeps its own reference across a ringtones push");
    assert.ok(Object.is(after.cameras.get("camera-keep"), before.cameras.get("camera-keep")), "a populated sibling's camera record keeps its reference");
    assert.ok(Object.is(after.sensors.get("sensor-keep"), before.sensors.get("sensor-keep")), "a populated sibling's sensor record keeps its reference");
    assert.ok(Object.is(after.liveviews.get("lv-keep"), before.liveviews.get("lv-keep")), "the other replaceable collection's record keeps its reference");
    assert.ok(Object.is(after.nvr, before.nvr), "the nvr record keeps its reference - the builder carries it across rather than rebuilding it");

    // The liveviews half of the same builder, so the round-trip is pinned for both replaceable collections rather than only the one the first push left alone.
    store.pushLiveviews([makeLiveviewConfig({ id: "lv-new" })]);

    const afterLiveviews = store.snapshot();

    assert.deepEqual([...afterLiveviews.liveviews.keys()], ["lv-new"], "the liveviews slice rebuilt from the supplied array");
    assert.ok(Object.is(afterLiveviews.ringtones, after.ringtones), "the freshly pushed ringtones slice keeps its reference across a liveviews push");
    assert.ok(Object.is(afterLiveviews.cameras.get("camera-keep"), before.cameras.get("camera-keep")), "a populated sibling's record survives a second push");
    assert.ok(Object.is(afterLiveviews.nvr, before.nvr), "the nvr record still keeps its reference after the second whole-collection push");

    /* The null-nvr cell. makeProtectState defaults the nvr slice to null, and the synthesized bootstrap smuggles that null verbatim through its confined cast:
     * applyBootstrap carries it through unchanged, and the adoption normalization ahead of it reads the controller MAC off the same null and goes inert rather than
     * throwing. A builder that invented an nvr record to satisfy the bootstrap type would flip this slice out from under every fixture that depends on it.
     */
    const nullNvrStore = new TestStateStore(makeProtectState({ ringtones: [makeRingtoneConfig({ id: "ring-old" })] }));

    assert.equal(nullNvrStore.snapshot().nvr, null, "the vacuity guard: the store genuinely starts with no nvr record");

    nullNvrStore.pushRingtones([makeRingtoneConfig({ id: "ring-new" })]);

    assert.equal(nullNvrStore.snapshot().nvr, null, "a ringtones push against a null-nvr store leaves the nvr slice null");
    assert.deepEqual([...nullNvrStore.snapshot().ringtones.keys()], ["ring-new"], "the ringtones push still landed against the null-nvr store");

    nullNvrStore.pushLiveviews([makeLiveviewConfig({ id: "lv-new" })]);

    assert.equal(nullNvrStore.snapshot().nvr, null, "a liveviews push against a null-nvr store leaves the nvr slice null");
  });

  test("the client.ringtones and client.liveviews getters read through the current store, reflecting a later push", () => {

    const store = new TestStateStore(makeProtectState({ liveviews: [makeLiveviewConfig({ id: "lv-1", name: "Front" })],
      ringtones: [makeRingtoneConfig({ id: "ring-1", name: "Ring One" })] }));
    const { controller, nvr } = makeTestNvr({ store });

    assert.deepEqual(nvr.client.ringtones.map((ringtone) => ringtone.id), ["ring-1"], "client.ringtones reads the seeded ringtone");
    assert.deepEqual(nvr.client.liveviews.map((liveview) => liveview.id), ["lv-1"], "client.liveviews reads the seeded liveview");

    // A later push is visible through the getters - they read the CURRENT store, not a held snapshot.
    store.pushRingtones([ makeRingtoneConfig({ id: "ring-2" }), makeRingtoneConfig({ id: "ring-3" }) ]);
    store.pushLiveviews([makeLiveviewConfig({ id: "lv-9" })]);

    assert.deepEqual(nvr.client.ringtones.map((ringtone) => ringtone.id), [ "ring-2", "ring-3" ], "client.ringtones reflects the later ringtones push");
    assert.deepEqual(nvr.client.liveviews.map((liveview) => liveview.id), ["lv-9"], "client.liveviews reflects the later liveviews push");

    controller.abort();
  });

  test("client.chimes returns the HELD projection instances - not a per-access rebuild - so a write and its rejection lever see one object", () => {

    const store = new TestStateStore(makeProtectState({ chimes: [makeChimeConfig({ id: "chime-h" })] }));
    const held = new TestChimeProjection("chime-h", store);
    const { controller, nvr } = makeTestNvr({ chimes: [held], store });

    // The CRITICAL stable-reference contract: every access returns the SAME instance the test holds. A store-rebuild getter (like liveviews / ringtones) would hand back
    // a fresh projection each pass, so the doorbell's setChimeVolume would write through one object while the test's updateRejection sat on another, and the failure
    // drive would pass vacuously. We prove identity across two accesses and against the held handle.
    const clientChimes = nvr.client.chimes as unknown as TestChimeProjection[];

    assert.equal(clientChimes.length, 1, "client.chimes exposes the held projection");
    assert.ok(Object.is(clientChimes[0], held), "client.chimes returns the SAME instance the test holds");
    assert.ok(Object.is((nvr.client.chimes as unknown as TestChimeProjection[])[0], clientChimes[0]), "a second access returns the identical instance - not a rebuild");

    // A rejection lever set on the held handle is visible through client.chimes (the same object), which is what lets the setChimeVolume failure drive be non-vacuous.
    held.updateRejection = new Error("held rejection");

    assert.equal((nvr.client.chimes as unknown as TestChimeProjection[])[0]?.updateRejection?.message, "held rejection",
      "the rejection set on the held handle is seen through client.chimes");

    controller.abort();
  });

  test("the TestMqttClient captures the get and set handler closures so a test can invoke them", async () => {

    const { controller, mqtt } = makeTestNvr({ mqtt: true, store: new TestStateStore(makeProtectState()) });

    assert.ok(mqtt, "the recording double is installed");

    const setCalls: string[] = [];

    mqtt.subscribeGet("74ACB9000101/tone", "tone", () => "captured-get");
    mqtt.subscribeSet("74ACB9000101/tone", "tone", (value: string) => { setCalls.push(value); });

    const getSub = mqtt.subscriptions.find((subscription) => subscription.kind === "get");
    const setSub = mqtt.subscriptions.find((subscription) => subscription.kind === "set");

    assert.equal(getSub?.getValue?.(), "captured-get", "the get handler is captured and invocable");

    await setSub?.setValue?.("a-value", "a-value");

    assert.deepEqual(setCalls, ["a-value"], "the set handler is captured and invocable");
    assert.equal(getSub?.topic, "74ACB9000101/tone", "the topic is still recorded for the topic-composition assertions");

    controller.abort();
  });
});

describe("A2 base-capability foundation: the shared dispatch, the sensor carrier / projection, and the TestBaseDevice vehicle", () => {

  test("makeSensorConfig defaults the all-quiet read set (including isMotionDetected and ledSettings) and merges overrides", () => {

    const defaults = makeSensorConfig();

    // The all-quiet defaults the base-capability carrier relies on: every *Settings.isEnabled false, the LED off, a healthy present battery, a "none" mount, no stats.
    assert.equal(defaults.modelKey, "sensor", "the modelKey is sensor (resolves in deviceConfigSelector)");
    assert.equal(defaults.isMotionDetected, true, "isMotionDetected defaults true so the Motion.* hasProperty applicability gate is satisfiable");
    assert.equal(defaults.ledSettings.isEnabled, false, "ledSettings.isEnabled defaults false (the all-quiet LED, for device-statusled later)");
    assert.equal(defaults.alarmSettings.isEnabled, false, "alarmSettings is quiet by default");
    assert.equal(defaults.humiditySettings.isEnabled, false, "humiditySettings is quiet by default");
    assert.equal(defaults.leakSettings.isExternalEnabled, false, "leakSettings external is quiet by default");
    assert.equal(defaults.leakSettings.isInternalEnabled, false, "leakSettings internal is quiet by default");
    assert.equal(defaults.lightSettings.isEnabled, false, "lightSettings is quiet by default");
    assert.equal(defaults.motionSettings.isEnabled, false, "motionSettings is quiet by default");
    assert.equal(defaults.temperatureSettings.isEnabled, false, "temperatureSettings is quiet by default");
    assert.equal(defaults.batteryStatus.isLow, false, "the battery defaults healthy");
    assert.equal(defaults.batteryStatus.percentage, 100, "the battery defaults to full charge");
    assert.equal(defaults.mountType, "none", "mountType defaults to none");
    assert.equal(defaults.motionDetectedAt, 0, "motionDetectedAt defaults to 0");
    assert.equal(defaults.alarmTriggeredAt, null, "alarmTriggeredAt defaults null");
    assert.equal(defaults.tamperingDetectedAt, null, "tamperingDetectedAt defaults null");
    assert.equal(defaults.isConnected, true, "isConnected defaults true");
    assert.equal(defaults.state, "CONNECTED", "state defaults CONNECTED so isOnline / isReachable resolve true");
    assert.equal(defaults.marketName, "Test Sensor Model", "marketName defaults so setInfo writes a Model");
    assert.equal(defaults.firmwareVersion, "5.0.0", "firmwareVersion defaults so the firmware-revision write fires");
    assert.equal(defaults.displayName, "Test Sensor", "displayName defaults to the name so the projection's name fallback resolves");
    assert.equal(defaults.id, "test-sensor-1", "the id defaults");
    assert.equal(defaults.mac, "74ACB9000401", "the mac defaults to a sensor-distinct value");
    assert.equal(defaults.stats, undefined, "an all-quiet sensor supplies no air-quality stats");
    assert.equal(defaults.externalLeakDetectedAt, null, "externalLeakDetectedAt defaults null");

    // The overrides merge into the right slots, including the stats sub-objects as ProtectAirQualityMetricInterface ({ status, value }) shapes.
    const overridden = makeSensorConfig({ alarmEnabled: true, ambientLight: 42, batteryLow: true, batteryPercentage: 10, humidity: 55, humidityEnabled: true,
      id: "sensor-9", isMotionDetected: false, ledEnabled: true, mac: "AABBCCDDEE10", motionDetectedAt: 1700000000000, motionEnabled: true, mountType: "door",
      name: "Garage Sensor", temperature: 21, temperatureEnabled: true });

    assert.equal(overridden.id, "sensor-9", "the id override lands");
    assert.equal(overridden.mac, "AABBCCDDEE10", "the mac override lands");
    assert.equal(overridden.name, "Garage Sensor", "the name override lands");
    assert.equal(overridden.displayName, "Garage Sensor", "displayName follows the name override");
    assert.equal(overridden.isMotionDetected, false, "the isMotionDetected override lands");
    assert.equal(overridden.ledSettings.isEnabled, true, "the ledEnabled override lands in ledSettings");
    assert.equal(overridden.alarmSettings.isEnabled, true, "the alarmEnabled override lands");
    assert.equal(overridden.humiditySettings.isEnabled, true, "the humidityEnabled override lands");
    assert.equal(overridden.motionSettings.isEnabled, true, "the motionEnabled override lands");
    assert.equal(overridden.temperatureSettings.isEnabled, true, "the temperatureEnabled override lands");
    assert.equal(overridden.batteryStatus.isLow, true, "the batteryLow override lands");
    assert.equal(overridden.batteryStatus.percentage, 10, "the batteryPercentage override lands");
    assert.equal(overridden.mountType, "door", "the mountType override lands");
    assert.equal(overridden.motionDetectedAt, 1700000000000, "the motionDetectedAt override lands");
    assert.deepEqual(overridden.stats?.humidity, { status: "", value: 55 }, "the humidity stat is a { status, value } air-quality metric");
    assert.deepEqual(overridden.stats?.light, { status: "", value: 42 }, "the ambient-light stat is a { status, value } air-quality metric");
    assert.deepEqual(overridden.stats?.temperature, { status: "", value: 21 }, "the temperature stat is a { status, value } air-quality metric");
  });

  test("makeSensorConfig leaves hardwareRevision absent by default and lands an opted-in value (mirroring the makeNvrConfig opt-in contract)", () => {

    // The OPT-IN contract, identical to makeNvrConfig's: a bare call still omits the field (the all-quiet carrier the base-capability concern tests ride on is byte-shape
    // unchanged, so setInfo's HardwareRevision length-guard short-circuits exactly as before), while an explicitly-passed value lands so the device-info HardwareRevision
    // write is non-vacuous. The conditional spread keeps the key ABSENT (not present-as-undefined) on the default, so an `in` check sees the pre-marker shape.
    const defaults = makeSensorConfig() as { hardwareRevision?: string };

    assert.equal(defaults.hardwareRevision, undefined, "the default makeSensorConfig leaves hardwareRevision unset");
    assert.equal("hardwareRevision" in defaults, false, "the default omits the key entirely rather than carrying it as present-but-undefined");

    const opted = makeSensorConfig({ hardwareRevision: "REV-A1" }) as { hardwareRevision?: string };

    assert.equal(opted.hardwareRevision, "REV-A1", "an opted-in hardwareRevision lands on the record for the device-info HardwareRevision write to net");
  });

  test("makeSensorConfig defaults the water-leak capability to no channels and lands an opted-in channelNames the leak-policy leaf reads", () => {

    // The leak-policy leaf reads featureFlags.waterLeak.channelNames to decide whether the capability is present. The default is [] (no leak capability), so the
    // all-quiet carrier exposes no leak service; an opted-in channelNames lands on the record so the single-channel / multi-channel leak paths can be exercised.
    const defaults = makeSensorConfig();

    assert.deepEqual(defaults.featureFlags.waterLeak?.channelNames, [], "the default makeSensorConfig advertises no water-leak channels");
    assert.equal(defaults.featureFlags.waterLeak?.channelCount, 0, "the default channelCount mirrors the empty channelNames length");

    const single = makeSensorConfig({ leakChannelNames: ["internal"] });

    assert.deepEqual(single.featureFlags.waterLeak?.channelNames, ["internal"], "an opted-in single channel lands on featureFlags.waterLeak.channelNames");
    assert.equal(single.featureFlags.waterLeak?.channelCount, 1, "the channelCount mirrors the single-channel length");

    const dual = makeSensorConfig({ leakChannelNames: [ "internal", "external" ] });

    assert.deepEqual(dual.featureFlags.waterLeak?.channelNames, [ "internal", "external" ], "an opted-in two-channel set lands on featureFlags.waterLeak.channelNames");
  });

  test("TestSensorProjection reads through to the store, guards an absent record, derives isOnline / name, and records update payloads without folding", async () => {

    const sensor = makeSensorConfig({ id: "sensor-d" });
    const store = new TestStateStore(makeProtectState({ sensors: [sensor] }));
    const projection = new TestSensorProjection("sensor-d", store);

    assert.equal(projection.config, store.snapshot().sensors.get("sensor-d"), "config reads through to the seeded record");
    assert.equal(projection.isOnline, true, "isOnline is true for a CONNECTED record");
    assert.equal(projection.name, "Test Sensor", "name resolves to the user-assigned name");
    assert.equal(projection.modelKey, "sensor", "the modelKey is sensor");

    const absent = new TestSensorProjection("sensor-never", store);

    assert.throws(() => absent.config, /The sensor record is not present in the store double: sensor-never/, "the absent-record guard throws");

    // update records the raw payload, returns this, and deliberately does NOT fold into the store (a later reactive reflection stays observer-driven).
    const returned = await projection.update({ ledSettings: { isEnabled: true } });

    assert.equal(returned, projection, "update returns this");
    assert.deepEqual(projection.updateCalls, [{ payload: { ledSettings: { isEnabled: true } } }], "update records the raw payload");
    assert.equal(store.snapshot().sensors.get("sensor-d")?.ledSettings.isEnabled, false, "update does NOT fold the payload into the store - the config is unchanged");

    // A settable rejection drives the failure path.
    projection.updateRejection = new Error("rejected");

    await assert.rejects(() => projection.update({}), /rejected/, "the settable rejection rejects update");
  });

  test("TestRecordingDispatch records a motion call carrying the device id and arms no reset timer", () => {

    const sensor = makeSensorConfig({ id: "sensor-fire" });
    const store = new TestStateStore(makeProtectState({ sensors: [sensor] }));
    const { controller, nvr } = makeTestNvr({ dispatch: (innerNvr: ProtectNvr): TestRecordingDispatch => new TestRecordingDispatch(innerNvr), store });
    const recording = nvr.events as TestRecordingDispatch;
    const accessory = makeTestAccessory("Test Sensor", "uuid:sensor-fire");
    const projection = new TestSensorProjection("sensor-fire", store) as unknown as Sensor;
    const device = new TestBaseDevice(nvr as unknown as ProtectNvr, accessory as unknown as ProtectAccessory, projection);

    assert.deepEqual(recording.calls, [], "the recorder starts empty");

    recording.motionEventHandler(device);

    assert.deepEqual(recording.calls, [{ id: "sensor-fire", kind: "motion" }], "the override records the device id and the motion kind");

    // The recorder arms no reset timer, so there is nothing to clear - cleanup unwinds the device's own (empty) timer map without leaking the dispatch's.
    device.cleanup();

    assert.deepEqual(recording.calls, [{ id: "sensor-fire", kind: "motion" }], "the recorded call survives teardown (the recorder holds no timer)");

    controller.abort();
  });

  test("TestBaseDevice constructs against the harness and reaches the base motion configurator", () => {

    const sensor = makeSensorConfig({ id: "sensor-vehicle" });
    const store = new TestStateStore(makeProtectState({ sensors: [sensor] }));
    const { controller, nvr } = makeTestNvr({ store, userOptions: ["Enable.Motion.Switch"] });
    const accessory = makeTestAccessory("Test Sensor", "uuid:sensor-vehicle");
    const projection = new TestSensorProjection("sensor-vehicle", store) as unknown as Sensor;
    const device = new TestBaseDevice(nvr as unknown as ProtectNvr, accessory as unknown as ProtectAccessory, projection);

    // The ufp read-through narrows to the Sensor carrier: a sensor-specific state field resolves off the seeded record, while the immutable controller id is read through
    // the dedicated non-throwing accessor rather than the identity-dropping state view.
    assert.equal(device.ufp.mountType, "none", "ufp reads through to the seeded sensor record, resolving a field only a sensor carries");
    assert.equal(device.protectId, "sensor-vehicle", "the controller id reads through the dedicated identity accessor");

    // A smoke check that the public test windows reach the base configurators: hints first, then the motion sensor returns true (the deep motion nets are
    // device-motion.test.ts's job).
    assert.equal(device.configureHintsFor(), true, "configureHintsFor reaches the base configureHints");
    assert.equal(device.configureMotionSensorFor(true), true, "configureMotionSensorFor reaches the base configureMotionSensor and validates the motion service");

    device.cleanup();
    controller.abort();
  });

  test("TestBaseDevice's configureStatusLedSwitchFor window reaches the base status-LED configurator with the feature", () => {

    const sensor = makeSensorConfig({ id: "sensor-led" });
    const store = new TestStateStore(makeProtectState({ sensors: [sensor] }));
    const { controller, nvr } = makeTestNvr({ store, userOptions: ["Enable.Device.StatusLed.Switch"] });
    const accessory = makeTestAccessory("Test Sensor", "uuid:sensor-led");
    const projection = new TestSensorProjection("sensor-led", store) as unknown as Sensor;
    const device = new TestBaseDevice(nvr as unknown as ProtectNvr, accessory as unknown as ProtectAccessory, projection);

    // A smoke check that the public window reaches the base configureStatusLedSwitch: with the Enable.Device.StatusLed.Switch feature it validates and acquires the
    // status-indicator switch and returns true (the deep status-LED nets - reflection, the onSet command routing, the change-gated log, the failure / auth paths - are
    // device-statusled.test.ts's job).
    assert.equal(device.configureStatusLedSwitchFor(true), true, "configureStatusLedSwitchFor reaches the base configureStatusLedSwitch and validates the switch");

    device.cleanup();
    controller.abort();
  });

  test("TestBaseDevice's configureInfoFor window reaches the base device-info configurator and writes the AccessoryInformation Model", () => {

    const sensor = makeSensorConfig({ id: "sensor-info" });
    const store = new TestStateStore(makeProtectState({ sensors: [sensor] }));
    const { controller, nvr } = makeTestNvr({ store });
    const accessory = makeTestAccessory("Test Sensor", "uuid:sensor-info");
    const projection = new TestSensorProjection("sensor-info", store) as unknown as Sensor;
    const device = new TestBaseDevice(nvr as unknown as ProtectNvr, accessory as unknown as ProtectAccessory, projection);

    // The base configurators read this.hints, so populate them first, then drive the device-info window. A smoke check that the public window reaches the base
    // configureInfo: it returns true and writes the AccessoryInformation Model (the carrier marketName) - the deep device-info nets (every setInfo write, the
    // observer reactions) are device-info.test.ts's job.
    device.configureHintsFor();

    assert.equal(device.configureInfoFor(), true, "configureInfoFor reaches the base configureInfo");
    assert.equal(accessory.getService(Service.AccessoryInformation)?.getCharacteristic(Characteristic.Model).value, "Test Sensor Model",
      "configureInfo's setInfo wrote the AccessoryInformation Model from the carrier marketName");

    device.cleanup();
    controller.abort();
  });

  test("TestBaseDevice's spawnObserversFor window registers exactly the two base observers once the lazy registration settles", async () => {

    const sensor = makeSensorConfig({ id: "sensor-observe" });
    const store = new TestStateStore(makeProtectState({ sensors: [sensor] }));
    const { controller, nvr } = makeTestNvr({ store });
    const accessory = makeTestAccessory("Test Sensor", "uuid:sensor-observe");
    const projection = new TestSensorProjection("sensor-observe", store) as unknown as Sensor;
    const device = new TestBaseDevice(nvr as unknown as ProtectNvr, accessory as unknown as ProtectAccessory, projection);

    device.configureHintsFor();
    device.spawnObserversFor();

    // Observe registration is LAZY: each loop registers its observer when iteration begins, a microtask after spawnObservers schedules the loop, so settle() first or
    // the count reads 0. After settling, the base spawnObservers has registered exactly its universal observers (device.name, device.firmwareVersion).
    await settle();

    assert.equal(store.observerCount, 2, "spawnObserversFor registers exactly the two base observers (device.name, device.firmwareVersion)");

    device.cleanup();
    controller.abort();
  });

  test("pushSensorPatch replaces only the targeted sensor record, structural-sharing every untouched slice, and throws on a missing id", () => {

    const sensorA = makeSensorConfig({ id: "sensor-a" });
    const sensorB = makeSensorConfig({ id: "sensor-b", mac: "AABBCCDDEE03" });
    const camera = makeCameraConfig({ channels: [] });
    const store = new TestStateStore(makeProtectState({ cameras: [camera], sensors: [ sensorA, sensorB ] }));
    const before = store.snapshot();

    store.pushSensorPatch("sensor-a", { name: "Renamed Sensor" });

    const after = store.snapshot();

    // The patched record is a NEW reference carrying the new field; every other sensor record, and every other slice, keeps its reference (Object.is) - the structural
    // sharing the narrow observers' dedup depends on.
    assert.notEqual(after.sensors.get("sensor-a"), before.sensors.get("sensor-a"), "the patched record is a fresh reference");
    assert.equal(after.sensors.get("sensor-a")?.name, "Renamed Sensor", "the patch applied to the targeted record");
    assert.ok(Object.is(after.sensors.get("sensor-b"), before.sensors.get("sensor-b")), "the untouched sibling sensor record keeps its reference");
    assert.ok(Object.is(after.cameras, before.cameras), "the untouched cameras slice keeps its reference");

    assert.throws(() => store.pushSensorPatch("sensor-missing", { name: "Nope" }), /not present in the store double: sensor-missing/,
      "patching an absent id throws the store-double guard");
  });
});

describe("A2 controller owners, commit 2: the new liveview builder option", () => {

  test("makeLiveviewConfig populates a single slot from the cameras option and preserves the empty-slots default otherwise", () => {

    // The controller-owner fanouts flatten slots[].cameras, so the cameras option must materialize a slot carrying those ids; a no-cameras call must preserve the empty
    // default the viewer relies on.
    const withCameras = makeLiveviewConfig({ cameras: [ "camera-1", "camera-2" ], id: "live-a", name: "Protect-Home" }) as unknown as
      { id: string; name: string; slots: { cameras: string[]; cycleInterval: number; cycleMode: string }[] };

    assert.equal(withCameras.slots.length, 1, "a cameras option populates exactly one slot");
    assert.deepEqual(withCameras.slots[0]?.cameras, [ "camera-1", "camera-2" ], "the slot carries the supplied member camera ids");
    assert.equal(withCameras.slots[0]?.cycleMode, "motion", "the slot carries the typed cycleMode / cycleInterval shape");

    const withoutCameras = makeLiveviewConfig({ id: "live-b", name: "Protect-Scene" }) as unknown as { slots: unknown[] };

    assert.equal(withoutCameras.slots.length, 0, "a no-cameras call preserves the empty-slots default");
  });
});
