/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * testing.helpers.test.ts: Unit tests for the cross-cutting test helpers in testing.helpers.ts.
 *
 * The harness is itself code, and a bug in a helper would silently corrupt every consumer test that depends on it, so the helpers earn the same coverage rigor as
 * production code. HAP and Homebridge are not restated here: every accessory, service and characteristic a suite builds is the real thing, and HBPU's own suite covers
 * the Homebridge double it runs through. What these rows cover is what the harness adds on top: the state store facade and the state builder that seeds it, the
 * accessory builder's identities, the read helpers over HAP's change record, and the controller log the streaming stub's stand-in controller keeps.
 */
import { Characteristic, Service, TestStateStore, TestStreamingDelegate, accessoryUuid, controllerEvents, eventsFrom, makeProtectState, makeTestAccessory,
  makeTestApi, runtime, writesTo } from "./testing.helpers.ts";
import { PLATFORM_NAME, PLUGIN_NAME } from "./settings.ts";
import type { ProtectCameraConfig, ProtectLightConfig, ProtectNvrConfig, ProtectNvrLiveviewConfig, ProtectRingtoneConfig, ProtectSensorConfig,
  ProtectViewerConfig } from "unifi-protect";
import { describe, test } from "node:test";
import { settle, triggerSet } from "homebridge-plugin-utils/testing";
import assert from "node:assert/strict";
import { makeCameraConfig } from "./devices/testing.helpers.ts";

describe("the state-store double (TestStateStore)", () => {

  // Build a one-camera store and return both halves. The contract tests observe the camera's name slice: a string, so the store's Object.is reference dedup
  // degenerates to value identity, which keeps the ping-pong expectations easy to read while exercising the exact dedup gate the real store applies.
  const makeStore = (): { camera: ProtectCameraConfig; store: TestStateStore } => {

    const camera = makeCameraConfig({ channels: [] });
    const store = new TestStateStore(makeProtectState({ cameras: [camera] }));

    return { camera, store };
  };

  test("an already-aborted signal yields nothing and registers nothing", async () => {

    const { camera, store } = makeStore();
    const controller = new AbortController();

    controller.abort();

    const received: unknown[] = [];

    for await (const value of store.observe((state) => state.cameras.get(camera.id)?.name, { signal: controller.signal })) {

      received.push(value);
    }

    assert.deepEqual(received, [], "an already-aborted signal produces no yields");
    assert.equal(store.observerCount, 0, "an already-aborted observe never registers an observer");
  });

  test("abort is drain-then-close: a queued value still yields before the iterator completes", async () => {

    const { camera, store } = makeStore();
    const controller = new AbortController();
    const iterator = store.observe((state) => state.cameras.get(camera.id)?.name, { signal: controller.signal });

    // Begin iteration without consuming: the first next() starts the generator body, which registers the observer (lazy registration) and parks awaiting a change.
    const first = iterator.next();

    await settle();

    assert.equal(store.observerCount, 1, "beginning iteration registers the observer");

    // Queue a change, then abort before the consumer drains it. The contract is drain-then-close: the queued value must still be delivered before completion.
    store.pushCameraPatch(camera.id, { name: "Renamed Camera" });
    controller.abort();

    const firstResult = await first;

    assert.equal(firstResult.done, false, "the queued value still yields after the abort");
    assert.equal(firstResult.value, "Renamed Camera", "the drained value is the queued change");

    const second = await iterator.next();

    assert.equal(second.done, true, "after the drain, the iterator completes");
    assert.equal(store.observerCount, 0, "completion deregisters the observer");
  });

  test("dedup happens at enqueue time against the last enqueued value: A to B back to A yields B then A", async () => {

    const { camera, store } = makeStore();
    const controller = new AbortController();
    const original = camera.name;
    const iterator = store.observe((state) => state.cameras.get(camera.id)?.name, { signal: controller.signal });
    const first = iterator.next();

    await settle();

    // Three pushes while the consumer is parked: a change to B, a second push whose name slice is unchanged (a different record, the same selected value - the
    // dedup gate must enqueue nothing), and a change back to the baseline A. The queue must then hold exactly B followed by A: dedup compares against the last
    // ENQUEUED value, never against everything ever seen - the baseline value returning IS a change and must be delivered, in order, unconflated.
    store.pushCameraPatch(camera.id, { name: "B" });
    store.pushCameraPatch(camera.id, { marketName: "Updated Model" });
    store.pushCameraPatch(camera.id, { name: original });

    assert.equal((await first).value, "B", "the first parked yield is the change to B");
    assert.equal((await iterator.next()).value, original, "the return to the baseline value yields - dedup is against the last enqueued value only");

    controller.abort();

    assert.equal((await iterator.next()).done, true, "abort completes the drained iterator");
    assert.equal(store.observerCount, 0, "abort deregisters the observer");
  });

  test("breaking out of iteration deregisters the observer", async () => {

    const { camera, store } = makeStore();
    const controller = new AbortController();
    const consumed: unknown[] = [];

    const loop = (async (): Promise<void> => {

      for await (const value of store.observe((state) => state.cameras.get(camera.id)?.name, { signal: controller.signal })) {

        consumed.push(value);

        break;
      }
    })();

    await settle();

    assert.equal(store.observerCount, 1, "the parked loop holds a registration");

    store.pushCameraPatch(camera.id, { name: "B" });

    await loop;

    assert.deepEqual(consumed, ["B"], "the loop consumed the single change it broke on");
    assert.equal(store.observerCount, 0, "break unwinds the generator's finally, deregistering the observer");

    // The loop exited via break rather than abort, so the signal stayed live throughout - which is the point: break alone must deregister. Abort the controller
    // anyway so nothing lingers.
    controller.abort();
  });

  test("selectors exposes the real store's catalog, so a by-id read over the snapshot returns the seeded camera", () => {

    const { camera, store } = makeStore();

    assert.equal(store.selectors.camera.byId(camera.id)(store.snapshot()), camera, "the catalog's camera by-id selector resolves the seeded record");
  });
});

describe("makeProtectState device-slice widening", () => {

  // No per-slice config builder exists yet (each lands with its own device-family suite), so each record is a minimal id-bearing literal bridged through the same
  // confined `as unknown as` cast the harness uses for makeCameraConfig / makeNvrConfig - honest about being a partial double, while keeping the population and
  // keying under test exactly the production-shaped path.
  const lightRecord = { id: "light-1" } as unknown as ProtectLightConfig;
  const liveviewRecord = { id: "liveview-1" } as unknown as ProtectNvrLiveviewConfig;
  const nvrRecord = { mac: "AABBCCDDEEFF" } as unknown as ProtectNvrConfig;
  const ringtoneRecord = { id: "ringtone-1" } as unknown as ProtectRingtoneConfig;
  const sensorRecord = { id: "sensor-1" } as unknown as ProtectSensorConfig;
  const viewerRecord = { id: "viewer-1" } as unknown as ProtectViewerConfig;

  test("seeding a slice populates exactly that slice, keyed by the record's own id", () => {

    const state = makeProtectState({ lights: [lightRecord], liveviews: [liveviewRecord], nvr: nvrRecord, ringtones: [ringtoneRecord], sensors: [sensorRecord],
      viewers: [viewerRecord] });

    assert.equal(state.lights.get("light-1"), lightRecord, "the lights slice is keyed by the light's id");
    assert.equal(state.liveviews.get("liveview-1"), liveviewRecord, "the liveviews slice is keyed by the liveview's id");
    assert.equal(state.ringtones.get("ringtone-1"), ringtoneRecord, "the ringtones slice is keyed by the ringtone's id");
    assert.equal(state.sensors.get("sensor-1"), sensorRecord, "the sensors slice is keyed by the sensor's id");
    assert.equal(state.viewers.get("viewer-1"), viewerRecord, "the viewers slice is keyed by the viewer's id");
    assert.equal(state.nvr, nvrRecord, "the nvr slice is the single supplied controller record, not a map");
  });

  test("omitting a slice leaves the other slices untouched", () => {

    // Seed only the lights slice; every sibling slice must remain its empty starting value, proving a single seeded slice does not leak into the others.
    const state = makeProtectState({ lights: [lightRecord] });

    assert.equal(state.lights.size, 1, "the seeded lights slice carries its one record");
    assert.equal(state.sensors.size, 0, "an unseeded sibling slice stays empty");
    assert.equal(state.nvr, null, "an unseeded nvr slice stays null");
  });

  test("a bare makeProtectState() yields every widened slice empty and the nvr slice null - no default drift", () => {

    const state = makeProtectState();

    assert.equal(state.lights.size, 0, "lights defaults to an empty Map");
    assert.equal(state.liveviews.size, 0, "liveviews defaults to an empty Map");
    assert.equal(state.ringtones.size, 0, "ringtones defaults to an empty Map");
    assert.equal(state.sensors.size, 0, "sensors defaults to an empty Map");
    assert.equal(state.viewers.size, 0, "viewers defaults to an empty Map");
    assert.equal(state.users.size, 0, "the intentionally-unexposed users slice stays the empty Map the reducer starts from");
    assert.equal(state.nvr, null, "nvr defaults to null");
  });
});

describe("harness growth: accessory identities, the change-record readers, and the controller log", () => {

  test("makeTestAccessory derives a seeded identity through HAP's generator and seeds each default uniquely, so same-named accessories each join the bridge", () => {

    // A seeded accessory carries the UUID HAP derives from its seed, the derivation production runs over a device's MAC.
    assert.equal(makeTestAccessory("Seeded", "74ACB9000001").UUID, accessoryUuid("74ACB9000001"), "a seeded accessory carries the UUID its seed derives");
    assert.equal(accessoryUuid("74ACB9000001"), runtime.hap.uuid.generate("74ACB9000001"), "the derivation is HAP's own generator");

    // Homebridge skips a registration whose UUID it already holds, so same-named accessories built without a seed must never share one.
    const api = makeTestApi();
    const first = makeTestAccessory("Same Name");
    const second = makeTestAccessory("Same Name");

    assert.notEqual(first.UUID, second.UUID, "accessories built without a seed carry distinct UUIDs");

    api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [ first, second ]);

    assert.ok(first._associatedHAPAccessory.bridged && second._associatedHAPAccessory.bridged, "the registration bridged each, skipping none as a duplicate");
  });

  test("writesTo and eventsFrom tell one characteristic's update writes and notifications apart, leaving out HomeKit's writes and every other instance", async () => {

    const accessory = makeTestAccessory();
    const first = accessory.addService(new Service.Switch("First", "first"));
    const second = accessory.addService(new Service.Switch("Second", "second"));
    const on = first.getCharacteristic(Characteristic.On);

    // An update write and an unchanged rewrite of the same value, which HAP records all the same; a write to the same kind on the sibling service; HomeKit's own
    // write; and an event notification. Each reader takes exactly its own reason on exactly this instance.
    on.updateValue(true);
    on.updateValue(true);
    second.updateCharacteristic(Characteristic.On, true);
    await triggerSet(on, false);
    on.sendEventNotification(true);

    assert.deepEqual(writesTo(accessory, on), [ true, true ], "writesTo holds each update write, the unchanged one included, and nothing else");
    assert.deepEqual(eventsFrom(accessory, on), [true], "eventsFrom holds the one event notification and nothing else");
  });

  test("the controller log records the stand-in controller's configure and remove in HAP's order, and HAP refuses a second camera controller", () => {

    const accessory = makeTestAccessory();
    const first = new TestStreamingDelegate({ accessory }).controller;
    const second = new TestStreamingDelegate({ accessory }).controller;

    accessory.configureController(first);

    // HAP keys an accessory's controllers by id and refuses a second one under an id it holds, and the stand-in carries the real camera controller's id.
    assert.throws(() => accessory.configureController(second), /already added/, "HAP refuses a second camera controller while one is configured");

    accessory.removeController(first);

    // The removal frees the id, so the second controller configures, exactly as a rebuilt delegate's does.
    accessory.configureController(second);

    const log = controllerEvents(accessory);

    assert.deepEqual(log.map((event) => event.kind), [ "configure", "remove", "configure" ], "the log holds HAP's configure and remove calls in order");
    assert.deepEqual(log.map((event) => event.seq), [ 0, 1, 2 ], "sequence numbers are monotonic");
    assert.deepEqual(log.map((event) => event.controller), [ first, first, second ], "each entry names the controller HAP ran the hook on");
  });
});

describe("harness growth: record removal", () => {

  test("removeCameraRecord deletes the record so reads see absence and selectors yield undefined", async () => {

    const camera = makeCameraConfig({ channels: [] });
    const store = new TestStateStore(makeProtectState({ cameras: [camera] }));
    const controller = new AbortController();
    const iterator = store.observe((state) => state.cameras.get(camera.id)?.name, { signal: controller.signal });
    const first = iterator.next();

    await settle();

    store.removeCameraRecord(camera.id);

    assert.equal((await first).value, undefined, "the removal yields the undefined slice");
    assert.equal(store.snapshot().cameras.has(camera.id), false, "the record is gone from the snapshot");

    controller.abort();
  });
});
