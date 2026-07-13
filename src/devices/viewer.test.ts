/* Copyright(C) 2019-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * viewer.test.ts: The viewer behavior-test family - behavior tests over a REAL constructed ProtectViewer.
 *
 * ProtectViewer extends ProtectDevice directly (no streaming-stack drag), so like ProtectLight it is unit-constructable, and this suite is another family: a
 * read-through projection double with a write-through update command surface, config builders, per-slice and collection push helpers,
 * and behavior-FIRST assertions (the observers, the liveview switches, the active-liveview reflection, the set-liveview command, the observers' reactions, and
 * the MQTT liveview get/set handlers). Every assertion drives the REAL production class through its real configureDevice / spawnObservers paths and its real setViewer
 * over the real runDeviceCommand seam.
 *
 * Two framing details the assertions honor exactly. First, the set-liveview COMMAND (the update payload, the publish-on-found, the clear-with-no-publish, the rejection)
 * is asserted separately from the active-liveview REFLECTION: setViewer does NOT update the local config (the projection double's update records rather than folding), so
 * the switch reflection is OBSERVER-driven - a test drives it through pushViewerPatch waking the viewer.liveview observer, not synchronously off update. Second, the MQTT
 * set handler matches a liveview by x.name.toLowerCase() === value, so the known-name test passes the LOWERCASED name.
 *
 * The isolation model mirrors the light reference: a beforeEach builds a fresh viewer so the capture arrays, the characteristic state, the observer baselines, and
 * store.observerCount are clean every test, and the wake log is windowed per push via a captured baseline. The afterEach(() => viewer?.cleanup()) unwinds the observers.
 */
import { Characteristic, Service, TestStateStore, TestViewerProjection, makeLiveviewConfig, makeProtectState, makeTestAccessory, makeTestNvr, makeViewerConfig, settle }
  from "../testing.helpers.ts";
import type { ProtectNvrLiveviewConfig, Viewer } from "unifi-protect";
import type { TestAccessory, TestLogEntry, TestMqttClient } from "../testing.helpers.ts";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import type { ObserverWakePayload } from "../diagnostics.ts";
import type { ProtectAccessory } from "../types.ts";
import type { ProtectNvr } from "../nvr/nvr.ts";
import { ProtectViewer } from "./viewer.ts";
import assert from "node:assert/strict";
import diagnosticsChannel from "node:diagnostics_channel";

// The device log wrapper formats every line through util.format into a single string parameter prefixed with the device name (for example "Test Viewer: No liveviews
// configured."), so a log assertion matches a substring of that one formatted parameter at the given level rather than re-deriving the format args. A plain substring
// match (not a regex) keeps the house lint rules satisfied and reads as the intent: did the viewer log this line at this level.
function loggedAt(entries: TestLogEntry[], level: TestLogEntry["level"], substring: string): boolean {

  return entries.some((entry) => (entry.level === level) && String(entry.parameters[0]).includes(substring));
}

// The reusable construction helper: build a REAL ProtectViewer against the harness doubles, seeding the viewer record plus whatever liveviews the test wants. The casts
// are confined to the construction seam exactly as the light suite does; the instance under test is the production class running its real configureDevice /
// spawnObservers paths. Returns logEntries and mqtt (the viewer asserts both the failure/configured log lines and the captured MQTT liveview handlers).
function buildViewer(configOptions: Parameters<typeof makeViewerConfig>[0] = {}, harnessOptions: { liveviews?: ProtectNvrLiveviewConfig[] } = {}): {
  accessory: TestAccessory; logEntries: TestLogEntry[]; mqtt: TestMqttClient; projection: TestViewerProjection; store: TestStateStore; viewer: ProtectViewer;
} {

  const viewerConfig = makeViewerConfig(configOptions);
  const store = new TestStateStore(makeProtectState({ liveviews: harnessOptions.liveviews ?? [], viewers: [viewerConfig] }));
  const { logEntries, mqtt, nvr } = makeTestNvr({ mqtt: true, store });
  const accessory = makeTestAccessory("Test Viewer", "uuid:test-viewer");
  const projection = new TestViewerProjection(viewerConfig.id, store);
  const viewer = new ProtectViewer(nvr as unknown as ProtectNvr, accessory as unknown as ProtectAccessory, projection as unknown as Viewer);

  // makeTestNvr was called with mqtt: true, so the recording double is present; a guard narrows Nullable<TestMqttClient> to the non-null type without an assertion or a
  // same-type cast (either of which the house lint preset forbids in opposite directions), and fails loudly if the opt-in ever stops installing the double.
  if(!mqtt) {

    throw new Error("The MQTT recording double was not installed despite mqtt: true.");
  }

  return { accessory, logEntries, mqtt, projection, store, viewer };
}

describe("real ProtectViewer construction and set-liveview behavior", () => {

  // The one observer-wake subscription for the whole suite, installed before any construction and removed once in the unconditional teardown. A leaked subscriber would
  // flip hasSubscribers for every later test in the process, so it is removed exactly once.
  const wakeLog: ObserverWakePayload[] = [];
  const onWake = (message: unknown): void => { wakeLog.push(message as ObserverWakePayload); };

  // The per-test-fresh handles, rebuilt in beforeEach so every test starts from a clean viewer, clean captures, and clean wake baseline.
  let accessory: TestAccessory;
  let constructionWakes = 0;
  let logEntries: TestLogEntry[];
  let mqtt: TestMqttClient;
  let projection: TestViewerProjection;
  let store: TestStateStore;
  let viewer: ProtectViewer | undefined;

  before(() => {

    diagnosticsChannel.subscribe("hbup:observer:wake", onWake);
  });

  after(() => {

    diagnosticsChannel.unsubscribe("hbup:observer:wake", onWake);
  });

  beforeEach(async () => {

    // The default fixture: two liveviews, with the viewer's active liveview set to the first, so the matching switch reads On true and a clear/set has a target.
    ({ accessory, logEntries, mqtt, projection, store, viewer } = buildViewer(
      { liveview: "liveview-1" },
      { liveviews: [ makeLiveviewConfig({ id: "liveview-1", name: "Front Door" }), makeLiveviewConfig({ id: "liveview-2", name: "Backyard" }) ] }));

    // Settle the observe loops' lazy registration before any test asserts, then snapshot the construction-wake count and reset the window so each test measures only
    // its own pushes.
    await settle();

    constructionWakes = wakeLog.length;
    wakeLog.length = 0;
  });

  afterEach(() => {

    viewer?.cleanup();
  });

  test("four observers register, construction wakes none, and a liveview switch per seeded liveview exists", () => {

    assert.equal(store.observerCount, 4, "the two base observers plus the viewer's active-liveview and liveview-collection observers are registered");
    assert.equal(constructionWakes, 0, "no observer wake was published during construction - observers arm against the baseline and stay silent");
    assert.ok(accessory.getServiceById(Service.Switch, "liveview-1"), "a liveview switch exists for the first seeded liveview");
    assert.ok(accessory.getServiceById(Service.Switch, "liveview-2"), "a liveview switch exists for the second seeded liveview");
  });

  test("the active-liveview switch reads On true when the config's liveview matches its subtype", () => {

    assert.equal(accessory.getServiceById(Service.Switch, "liveview-1")?.getCharacteristic(Characteristic.On).value, true,
      "the switch whose subtype matches the active liveview initializes On true");
    assert.equal(accessory.getServiceById(Service.Switch, "liveview-2")?.getCharacteristic(Characteristic.On).value, false,
      "a non-active liveview switch initializes On false");
  });

  test("construction logs the configured liveview names", () => {

    assert.ok(loggedAt(logEntries, "info", "Configured liveviews: Front Door, Backyard."), "the configured-liveviews info log lists the seeded liveview names");
  });

  test("a viewer with no seeded liveviews logs the empty branch", () => {

    const fixture = buildViewer({}, { liveviews: [] });

    assert.ok(loggedAt(fixture.logEntries, "info", "No liveviews configured."), "with no liveviews the viewer logs the empty branch");
    assert.equal(fixture.accessory.services.filter((service) => (service.UUID === Service.Switch.UUID) && service.subtype).length, 0,
      "no liveview switches were configured");

    fixture.viewer.cleanup();
  });

  test("turning a liveview switch on issues the update command with that liveview id and publishes its name", async () => {

    const target = accessory.getServiceById(Service.Switch, "liveview-2");

    assert.ok(target, "the second liveview switch exists");

    await target.getCharacteristic(Characteristic.On).triggerSet(true);

    assert.deepEqual(projection.updateCalls, [{ liveview: "liveview-2" }], "the real setViewer dispatched a single update with the requested liveview id");
    assert.deepEqual(mqtt.published, [{ message: "Backyard", topic: projection.config.mac + "/liveview" }],
      "the accepted change published the liveview name on the device-scoped topic");
  });

  test("turning a liveview switch on writes nothing to the sibling switch - reflection is left to the broadcast observer", async () => {

    const target = accessory.getServiceById(Service.Switch, "liveview-2");
    const sibling = accessory.getServiceById(Service.Switch, "liveview-1");

    assert.ok(target && sibling, "both liveview switches exist");

    // The write log records every updateCharacteristic-driven write (triggerSet's own post-handler cache write does not append). Capture the sibling's baseline, tap the
    // other switch, and confirm the handler wrote nothing to the sibling - the buggy synchronous re-read re-asserted the stale pre-command layout, a re-write only the
    // write log reveals since the final cached value is unchanged.
    const siblingWritesBefore = sibling.getCharacteristic(Characteristic.On).writes.length;

    await target.getCharacteristic(Characteristic.On).triggerSet(true);

    assert.equal(projection.updateCalls.length, 1, "the command was dispatched");
    assert.equal(sibling.getCharacteristic(Characteristic.On).writes.length, siblingWritesBefore,
      "the handler produced no write to the sibling switch - it is left for the viewer.liveview observer to reflect once the broadcast lands");
  });

  test("turning the active liveview switch off clears the liveview and publishes nothing", async () => {

    const active = accessory.getServiceById(Service.Switch, "liveview-1");

    assert.ok(active, "the active liveview switch exists");

    await active.getCharacteristic(Characteristic.On).triggerSet(false);

    assert.deepEqual(projection.updateCalls, [{ liveview: null }], "a switch-off clears the liveview to null");
    assert.equal(mqtt.published.length, 0, "a clear-to-null publishes nothing - there is no liveview to name");
  });

  test("a rejecting update reports the failure and publishes nothing", async () => {

    projection.updateRejection = new Error("The viewer rejected the change.");

    const target = accessory.getServiceById(Service.Switch, "liveview-2");

    assert.ok(target, "the second liveview switch exists");

    await target.getCharacteristic(Characteristic.On).triggerSet(true);

    assert.equal(projection.updateCalls.length, 1, "the command was attempted");
    assert.equal(mqtt.published.length, 0, "a failed change publishes nothing");
    assert.ok(loggedAt(logEntries, "error", "Unable to set the liveview to Backyard: The viewer rejected the change."),
      "the shared command-error helper reported the single failure line");
  });

  test("a viewer.liveview push wakes only that observer and reflects the new active switch", async () => {

    const baseline = wakeLog.length;

    // Move the active liveview to the second one. setViewer never folds, so this observer-driven push is the genuine active reflection path.
    store.pushViewerPatch(projection.id, { liveview: "liveview-2" });

    await settle();

    assert.deepEqual(wakeLog.slice(baseline), [{ accessoryId: accessory.UUID, key: "viewer.liveview" }], "exactly the active-liveview observer woke for this push");
    assert.equal(accessory.getServiceById(Service.Switch, "liveview-2")?.getCharacteristic(Characteristic.On).value, true,
      "the new active liveview switch reflects On true");
    assert.equal(accessory.getServiceById(Service.Switch, "liveview-1")?.getCharacteristic(Characteristic.On).value, false,
      "the formerly active switch reflects On false");
  });

  test("a liveview-collection push wakes only that observer and reconciles the switch set", async () => {

    const baseline = wakeLog.length;

    // Replace the two seeded liveviews with two different ones: the old switches are pruned, two new ones are added.
    store.pushLiveviews([ makeLiveviewConfig({ id: "liveview-3", name: "Garage" }), makeLiveviewConfig({ id: "liveview-4", name: "Driveway" }) ]);

    await settle();

    assert.deepEqual(wakeLog.slice(baseline), [{ accessoryId: accessory.UUID, key: "nvr.liveviews" }], "exactly the liveview-collection observer woke for this push");
    assert.equal(accessory.getServiceById(Service.Switch, "liveview-1"), undefined, "a removed liveview's switch was pruned");
    assert.ok(accessory.getServiceById(Service.Switch, "liveview-3"), "a switch was added for the first new liveview");
    assert.ok(accessory.getServiceById(Service.Switch, "liveview-4"), "a switch was added for the second new liveview");
  });

  test("the MQTT liveview get handler returns the active liveview name, or None when nothing is active", async () => {

    const liveviewGet = mqtt.subscriptions.find((subscription) => (subscription.kind === "get") && (subscription.topic === projection.config.mac + "/liveview"));

    assert.ok(liveviewGet?.getValue, "the viewer registered a captured get handler for the liveview topic");
    assert.equal(liveviewGet.getValue(), "Front Door", "the get handler returns the active liveview name");

    // Move the active liveview to null and confirm the get handler returns the None sentinel.
    store.pushViewerPatch(projection.id, { liveview: null });

    await settle();

    assert.equal(liveviewGet.getValue(), "None", "with no active liveview the get handler returns None");
  });

  test("the MQTT liveview set handler resolves a known name (case-insensitively) and rejects an unknown one", async () => {

    const liveviewSet = mqtt.subscriptions.find((subscription) => (subscription.kind === "set") && (subscription.topic === projection.config.mac + "/liveview"));

    assert.ok(liveviewSet?.setValue, "the viewer registered a captured set handler for the liveview topic");

    // The set handler matches on x.name.toLowerCase() === value, so a known name is passed lowercased.
    await liveviewSet.setValue("backyard", "backyard");

    assert.deepEqual(projection.updateCalls, [{ liveview: "liveview-2" }], "a known liveview name resolved to its id and dispatched the update");
    assert.ok(loggedAt(logEntries, "info", "Liveview set via MQTT to Backyard."), "the MQTT set logged the confirmation");

    // An unknown name logs the error and dispatches no update.
    await liveviewSet.setValue("nonexistent", "nonexistent");

    assert.equal(projection.updateCalls.length, 1, "an unknown liveview name dispatches no update");
    assert.ok(loggedAt(logEntries, "error", "Unable to locate a liveview named nonexistent."), "an unknown liveview name logs the error");
  });

  test("the MQTT subscriptions compose the device-MAC-scoped liveview topic tail", () => {

    const tails = mqtt.subscriptions.map((subscription) => subscription.topic);

    assert.ok(tails.includes(projection.config.mac + "/liveview"), "the viewer liveview subscription composed the device-scoped tail");
  });
});
