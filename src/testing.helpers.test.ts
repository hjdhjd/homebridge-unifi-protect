/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * testing.helpers.test.ts: Unit tests for the cross-cutting test helpers in testing.helpers.ts.
 *
 * The HAP test-double is itself code, and a bug in the double would silently corrupt every consumer test that depends on it...particularly the StatusActive
 * write path the reachability rewire relies on. The double earns the same coverage rigor as production code: every accessor, every fan-out branch, every handler binding.
 */
import { Characteristic, Service, TestAccessory, TestBaseDevice, TestCameraProjection, TestChimeProjection, TestLightProjection, TestRecordingDispatch,
  TestSensorProjection, TestStateStore, TestViewerProjection, makeCameraConfig, makeChimeConfig, makeControllableLivestreamDouble, makeKeyframeFragment, makeLightConfig,
  makeLivestreamSubscriptionDouble, makeLiveviewConfig, makeNonKeyframeFragment, makeNvrConfig, makeProtectState, makeRingtoneConfig, makeSensorConfig, makeTestAccessory,
  makeTestAccessoryFamily, makeTestNvr, makeViewerConfig, settle } from "./testing.helpers.ts";
import type { CharacteristicType, TestService } from "./testing.helpers.ts";
import type { ProtectAccessory, ProtectDevices } from "./types.ts";
import type { ProtectCameraConfig, ProtectLightConfig, ProtectNvrConfig, ProtectNvrLiveviewConfig, ProtectRingtoneConfig, ProtectSensorConfig, ProtectViewerConfig,
  Segment, Sensor } from "unifi-protect";
import { describe, test } from "node:test";
import { ProtectEventDispatch } from "./nvr/event-dispatch.ts";
import type { ProtectNvr } from "./nvr/nvr.ts";
import assert from "node:assert/strict";
import { isKeyframe } from "homebridge-plugin-utils";

describe("HAP test-double", () => {

  describe("TestAccessory", () => {

    test("preloads an AccessoryInformation service so production code can fetch it without first calling addService", () => {

      const accessory = makeTestAccessory();

      assert.ok(accessory.getService(Service.AccessoryInformation), "every HomeKit accessory carries an AccessoryInformation service from construction");
    });

    test("makeTestAccessory carries the supplied displayName and UUID through to the instance fields", () => {

      const accessory = new TestAccessory("Doorbell-1", "00000000-1111-2222-3333-444444444444");

      assert.equal(accessory.displayName, "Doorbell-1", "displayName is forwarded verbatim");
      assert.equal(accessory.UUID, "00000000-1111-2222-3333-444444444444", "UUID is forwarded verbatim");
    });

    test("addService returns the new service instance and getService finds it by type", () => {

      const accessory = makeTestAccessory();
      const motion = accessory.addService(Service.MotionSensor, "Motion");

      assert.equal(accessory.getService(Service.MotionSensor), motion, "the same TestService instance is returned by getService(type)");
    });

    test("getServiceById matches on (type, subtype); getService only matches the subtype-less instance", () => {

      const accessory = makeTestAccessory();
      const baseSwitch = accessory.addService(Service.Switch, "Base Switch");
      const taggedSwitch = accessory.addService(Service.Switch, "Tagged Switch", "tagged");

      assert.equal(accessory.getService(Service.Switch), baseSwitch, "getService matches the subtype-less Switch service");
      assert.equal(accessory.getServiceById(Service.Switch, "tagged"), taggedSwitch, "getServiceById matches the tagged Switch service");
      assert.equal(accessory.getServiceById(Service.Switch, "missing"), undefined, "an unknown subtype returns undefined rather than throwing");
    });

    test("the services array is publicly iterable and reflects every added service plus the preloaded AccessoryInformation", () => {

      const accessory = makeTestAccessory();

      accessory.addService(Service.MotionSensor, "Motion");
      accessory.addService(Service.OccupancySensor, "Occupancy");

      // The reachability fan-out walks accessory.services directly, so the array must be public and complete. AccessoryInformation is preloaded, so we expect three.
      assert.equal(accessory.services.length, 3, "AccessoryInformation plus the two added sensors are all visible on the public services array");
      assert.ok(accessory.services.some((service) => service.type === Service.OccupancySensor), "the occupancy sensor kind is present on the double");
    });

    // removeService is the removal path homebridge-plugin-utils' validService takes when an existing service fails validation, the camera's smart-detect pruning calls
    // directly, and the sweep-stale arm's DoorbellCapability.removeServices drives - so the capability-detach-adjacent assertions lean on it. It must drop exactly the
    // named instance, leave every other service (including a same-type, different-subtype sibling) in place, and tolerate a service that is not present without throwing.
    test("removeService drops exactly the named service, leaves same-type siblings, and is a no-op on an absent service", () => {

      const accessory = makeTestAccessory();
      const baseSwitch = accessory.addService(Service.Switch, "Base Switch");
      const taggedSwitch = accessory.addService(Service.Switch, "Tagged Switch", "tagged");

      accessory.removeService(taggedSwitch);

      assert.equal(accessory.getServiceById(Service.Switch, "tagged"), undefined, "the removed tagged Switch is gone");
      assert.equal(accessory.getService(Service.Switch), baseSwitch, "the same-type, different-subtype sibling survives the removal");

      // A second removal of the already-removed instance must not corrupt the array (no negative-index splice) and must leave the survivors untouched.
      accessory.removeService(taggedSwitch);

      assert.equal(accessory.getService(Service.Switch), baseSwitch, "the base Switch still resolves after a redundant remove of an absent service");
      assert.ok(accessory.services.includes(baseSwitch), "the base Switch remains on the public services array after the no-op removal");
    });
  });

  describe("TestService", () => {

    test("getCharacteristic returns the same instance across calls for a given kind", () => {

      const accessory = makeTestAccessory();
      const service = accessory.addService(Service.MotionSensor, "Motion");
      const first = service.getCharacteristic(Characteristic.StatusActive);
      const second = service.getCharacteristic(Characteristic.StatusActive);

      assert.equal(first, second, "the same characteristic instance is returned per kind, so an onGet binding stays attached across reads");
    });

    test("updateCharacteristic writes a value visible via the characteristic's .value getter and overwrites on subsequent writes", () => {

      const accessory = makeTestAccessory();
      const service = accessory.addService(Service.MotionSensor, "Motion");

      service.updateCharacteristic(Characteristic.StatusActive, true);
      assert.equal(service.getCharacteristic(Characteristic.StatusActive).value, true, "first write lands");

      service.updateCharacteristic(Characteristic.StatusActive, false);
      assert.equal(service.getCharacteristic(Characteristic.StatusActive).value, false, "subsequent write overwrites the previous value");
    });

    test("testCharacteristic reports false before a characteristic is created and true once getCharacteristic has materialized it", () => {

      const accessory = makeTestAccessory();
      const service = accessory.addService(Service.MotionSensor, "Motion");

      assert.equal(service.testCharacteristic(Characteristic.StatusActive), false, "a never-accessed characteristic reports absent, the predicate the reachability " +
        "fan-out uses to skip services that do not carry StatusActive");

      service.getCharacteristic(Characteristic.StatusActive);

      assert.equal(service.testCharacteristic(Characteristic.StatusActive), true, "once materialized, the predicate reports present");
    });

    test("testCharacteristic does not itself materialize the characteristic, unlike getCharacteristic", () => {

      const accessory = makeTestAccessory();
      const service = accessory.addService(Service.Switch, "Switch");

      service.testCharacteristic(Characteristic.StatusActive);

      assert.equal(service.testCharacteristic(Characteristic.StatusActive), false, "calling the predicate is side-effect free; it never creates the characteristic");
    });
  });

  describe("TestCharacteristic", () => {

    test("onGet installs a handler whose value is re-invoked on each triggerGet (not memoized)", async () => {

      const accessory = makeTestAccessory();
      const service = accessory.addService(Service.MotionSensor, "Motion");
      let computed = "first";

      service.getCharacteristic(Characteristic.StatusActive).onGet(() => computed);

      assert.equal(await service.getCharacteristic(Characteristic.StatusActive).triggerGet(), "first", "the bound getter runs against current closure state");

      computed = "second";

      assert.equal(await service.getCharacteristic(Characteristic.StatusActive).triggerGet(), "second", "the bound getter is re-invoked, not memoized");
    });

    test("onSet installs a handler that triggerSet invokes; the post-set value becomes the new .value", async () => {

      const accessory = makeTestAccessory();
      const service = accessory.addService(Service.Switch, "Switch");
      const observed: unknown[] = [];

      service.getCharacteristic(Characteristic.On).onSet((value) => { observed.push(value); });
      await service.getCharacteristic(Characteristic.On).triggerSet(true);
      await service.getCharacteristic(Characteristic.On).triggerSet(false);

      assert.deepEqual(observed, [ true, false ], "every triggered set call reaches the bound handler in order");
      assert.equal(service.getCharacteristic(Characteristic.On).value, false, ".value reflects the most recent set value");
    });

    test("triggerGet falls through to the cached value when no onGet handler is bound", async () => {

      const accessory = makeTestAccessory();
      const service = accessory.addService(Service.MotionSensor, "Motion");

      service.updateCharacteristic(Characteristic.StatusActive, true);

      assert.equal(await service.getCharacteristic(Characteristic.StatusActive).triggerGet(), true, "with no handler bound, the cached value is returned");
    });
  });

  // setCharacteristic is the HAP-faithful set path the production MQTT subscribeSet handlers (and the doorbell chime-volume / stream flashlight writes) take to drive
  // a device command through HomeKit's own set machinery. Unlike updateCharacteristic - a silent status push - it must FIRE the bound onSet handler. The handler is
  // async and fire-and-forget, so every effect is asserted only after settle() lets the microtask run, never synchronously.
  describe("TestService.setCharacteristic", () => {

    test("fires the bound onSet handler with the supplied value", async () => {

      const accessory = makeTestAccessory();
      const service = accessory.addService(Service.Lightbulb, "Light");
      const observed: unknown[] = [];

      service.getCharacteristic(Characteristic.On).onSet((value) => { observed.push(value); });
      service.setCharacteristic(Characteristic.On, true);

      await settle();

      assert.deepEqual(observed, [true], "setCharacteristic routes through the bound onSet handler, the production command path");
    });

    test("updates the read cache to the set value once the handler resolves", async () => {

      const accessory = makeTestAccessory();
      const service = accessory.addService(Service.Lightbulb, "Light");

      service.getCharacteristic(Characteristic.Brightness).onSet(() => { /* The handler does not write the cache; triggerSet does, after it resolves. */ });
      service.setCharacteristic(Characteristic.Brightness, 42);

      await settle();

      assert.equal(service.getCharacteristic(Characteristic.Brightness).value, 42, "the post-set value becomes the new cached value, mirroring HAP's set semantics");
    });

    test("is distinct from updateCharacteristic, which writes the value but never fires the handler", async () => {

      const accessory = makeTestAccessory();
      const service = accessory.addService(Service.Lightbulb, "Light");
      const observed: unknown[] = [];

      service.getCharacteristic(Characteristic.On).onSet((value) => { observed.push(value); });
      service.updateCharacteristic(Characteristic.On, true);

      await settle();

      assert.deepEqual(observed, [], "updateCharacteristic is a status push that never runs the onSet handler");
      assert.equal(service.getCharacteristic(Characteristic.On).value, true, "updateCharacteristic still writes the value, it just bypasses the handler");
    });

    test("works through the lazy getCharacteristic, materializing and firing a not-yet-created characteristic", async () => {

      const accessory = makeTestAccessory();
      const service = accessory.addService(Service.Lightbulb, "Light");
      const observed: unknown[] = [];

      // Bind the handler before the value is ever set; getCharacteristic lazily materializes the characteristic here, and setCharacteristic must reach that same
      // instance rather than creating a second, handler-less one.
      service.getCharacteristic(Characteristic.On).onSet((value) => { observed.push(value); });
      service.setCharacteristic(Characteristic.On, false);

      await settle();

      assert.deepEqual(observed, [false], "setCharacteristic resolves the characteristic through the lazy getCharacteristic, firing the bound handler");
      assert.equal(service.getCharacteristic(Characteristic.On).value, false, "the lazily-materialized characteristic carries the set value afterward");
    });

    test("returns the service for chaining, like updateCharacteristic", () => {

      const accessory = makeTestAccessory();
      const service = accessory.addService(Service.Lightbulb, "Light");

      assert.equal(service.setCharacteristic(Characteristic.On, true), service, "setCharacteristic returns this so production chained writes compile");
    });
  });
});

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
});

describe("makeProtectState device-slice widening", () => {

  // No per-slice config builder exists yet (each lands with its own device-family suite), so each record is a minimal id-bearing literal bridged through the same
  // confined `as unknown as` seam cast the harness uses for makeCameraConfig / makeNvrConfig - honest about being a partial double, while keeping the population and
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

describe("harness growth: service identity, controller log, and event notifications", () => {

  test("every namespace service marker carries a distinct, non-empty static UUID, mirrored onto instances from both construction paths", () => {

    const uuids = Object.values(Service).map((marker) => marker.UUID);

    // The amended identity contract: real, distinct, never-empty identities (an empty UUID would false-positive homebridge-plugin-utils' degenerate
    // name-set predicates).
    assert.ok(uuids.every((uuid) => (typeof uuid === "string") && (uuid.length > 0)), "every marker carries a non-empty static UUID");
    assert.equal(new Set(uuids).size, uuids.length, "every marker UUID is distinct");

    // The marker-construction path (what acquireService's create branch invokes) and the legacy type-form path both mirror the static through this.type.
    const viaMarker = new Service.MotionSensor("Motion");

    assert.equal(viaMarker.UUID, Service.MotionSensor.UUID, "a marker-constructed service mirrors its class static");

    const accessory = makeTestAccessory();
    const viaLegacy = accessory.addService(Service.Switch, "Switch");

    assert.equal(viaLegacy.UUID, Service.Switch.UUID, "a legacy type-form service mirrors the namespace entry's static through this.type");
    assert.notEqual(viaLegacy.UUID, "", "no construction path ever yields an empty UUID");
  });

  test("setPrimaryService records the primary designation", () => {

    const accessory = makeTestAccessory();
    const service = accessory.addService(Service.Doorbell, "Doorbell");

    assert.equal(service.isPrimary, false, "a fresh service is not primary");

    service.setPrimaryService(true);

    assert.equal(service.isPrimary, true, "setPrimaryService(true) records the designation");

    service.setPrimaryService(false);

    assert.equal(service.isPrimary, false, "setPrimaryService(false) clears it");
  });

  test("the controller-event log records configure and remove in order, the derived views filter it, and a double configure throws", () => {

    const accessory = makeTestAccessory();
    const first = { sentinel: "first" };
    const second = { sentinel: "second" };

    accessory.configureController(first);

    // HAP throws on a second controller registration while one is configured - the double enforces the same invariant.
    assert.throws(() => accessory.configureController(second), /already added/, "a double configure throws, mirroring HAP");

    accessory.removeController(first);

    // After removal the chokepoint clears, so a re-configure succeeds, exactly as it would live.
    accessory.configureController(second);

    assert.deepEqual(accessory.controllerEvents.map((event) => event.kind), [ "configure", "remove", "configure" ], "the unified log preserves event order");
    assert.deepEqual(accessory.controllerEvents.map((event) => event.seq), [ 0, 1, 2 ], "sequence numbers are monotonic");
    assert.deepEqual(accessory.configureControllerCalls, [ first, second ], "the configure view derives from the log");
    assert.deepEqual(accessory.removeControllerCalls, [first], "the remove view derives from the log");
    assert.equal(accessory.configuredController, second, "the chokepoint tracks the currently configured controller");
  });

  test("sendEventNotification records events in order without disturbing the cached value", () => {

    const doorbell = new Service.Doorbell("Doorbell");
    const characteristic = doorbell.getCharacteristic(Characteristic.ProgrammableSwitchEvent);

    characteristic.updateValue("resting");
    characteristic.sendEventNotification(Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS);
    characteristic.sendEventNotification(Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS);

    assert.deepEqual(characteristic.events, [ 0, 0 ], "both press events are recorded in order");
    assert.equal(characteristic.value, "resting", "an event notification never changes the cached value");
  });

  test("the sensor-family service markers construct and each carries its seeded primary characteristic", () => {

    // The sensor-family markers added for the ProtectSensor real-construction net. Each must construct without throwing (acquireService's create branch invokes the
    // namespace entry directly) AND carry its seed characteristic as the materialized first element (getCharacteristicConstructor destructures it), mirroring the
    // OccupancySensor / MotionSensor precedent. The seed pairing is the load-bearing claim: a wrong seed would let construction succeed yet break the kind-true read.
    // We pair each marker with its expected seed and assert the first characteristic IS that kind - reading characteristics[0] with a length guard so the index access
    // is type-honest under strict null checks rather than asserted away.
    const cases: { expectedSeed: CharacteristicType; service: TestService }[] = [

      { expectedSeed: Characteristic.BatteryLevel, service: new Service.Battery("Battery") },
      { expectedSeed: Characteristic.CurrentAmbientLightLevel, service: new Service.LightSensor("Light Sensor") },
      { expectedSeed: Characteristic.CurrentRelativeHumidity, service: new Service.HumiditySensor("Humidity Sensor") },
      { expectedSeed: Characteristic.CurrentTemperature, service: new Service.TemperatureSensor("Temperature Sensor") },
      { expectedSeed: Characteristic.LeakDetected, service: new Service.LeakSensor("Leak Sensor") }
    ];

    for(const { expectedSeed, service } of cases) {

      const [primary] = service.characteristics;

      assert.ok(primary, "the " + service.UUID + " marker materialized a primary characteristic at construction");
      assert.equal(primary.type, expectedSeed, "the " + service.UUID + " marker seeds its kind-true primary characteristic");
      assert.ok(service.testCharacteristic(expectedSeed), "the " + service.UUID + " marker reports its seed via testCharacteristic");
    }
  });

  test("the standalone StatusLowBattery characteristic marker resolves to a distinct on-demand kind", () => {

    // StatusLowBattery is NOT a service seed - updateBatteryStatus writes it on-demand alongside BatteryLevel on the Battery service - so it must resolve as its own
    // distinct namespace entry, never collapsing onto the BatteryLevel seed. A test materializes both on a Battery service and asserts they are independent instances.
    const battery = new Service.Battery("Battery");

    battery.updateCharacteristic(Characteristic.BatteryLevel, 80);
    battery.updateCharacteristic(Characteristic.StatusLowBattery, true);

    assert.equal(battery.getCharacteristic(Characteristic.BatteryLevel).value, 80, "BatteryLevel holds its own value");
    assert.equal(battery.getCharacteristic(Characteristic.StatusLowBattery).value, true, "StatusLowBattery holds its own value on a distinct entry");
    assert.notEqual(battery.getCharacteristic(Characteristic.BatteryLevel), battery.getCharacteristic(Characteristic.StatusLowBattery),
      "BatteryLevel and StatusLowBattery are distinct characteristic instances");
  });
});

describe("harness growth: chime state and record removal", () => {

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

describe("harness growth: NVR removal machinery", () => {

  test("scheduleDeviceRemoval honors the registered DelayDeviceRemoval default and the fire body re-checks stability and stillGone", () => {

    const store = new TestStateStore(makeProtectState());
    const { nvr } = makeTestNvr({ store });
    const accessory = makeTestAccessory("Victim", "uuid:victim");

    nvr.platform.accessories.push(accessory);
    nvr.scheduleDeviceRemoval({ accessory, stillGone: () => true });

    // The registered default is 60 seconds, so the schedule defers rather than removing immediately.
    assert.equal(nvr.scheduledRemovals.length, 1, "the schedule decision is recorded");
    assert.equal(nvr.scheduledRemovals[0]?.interval, 60, "the interval resolves to the registered DelayDeviceRemoval default");
    assert.ok(nvr.removalTimers.has(accessory.UUID), "a manually-fireable timer entry is recorded");
    assert.ok(nvr.platform.accessories.includes(accessory), "the accessory survives until the grace fires");

    // A second schedule while one is pending is idempotent, mirroring production.
    nvr.scheduleDeviceRemoval({ accessory, stillGone: () => true });

    assert.equal(nvr.scheduledRemovals.length, 1, "a pending removal dedups a re-schedule");

    nvr.removalTimers.get(accessory.UUID)?.fire();

    assert.equal(nvr.platform.accessories.includes(accessory), false, "the fired grace removes the accessory through the tail");
    assert.equal(nvr.removalTimers.size, 0, "the fired timer entry is deleted");
  });

  test("the stability gate suppresses scheduling and a stale fire after cancellation is a no-op", () => {

    const store = new TestStateStore(makeProtectState());
    const { nvr } = makeTestNvr({ store });
    const accessory = makeTestAccessory("Victim", "uuid:victim");

    nvr.platform.accessories.push(accessory);
    nvr.removalStable = false;
    nvr.scheduleDeviceRemoval({ accessory, stillGone: () => true });

    assert.equal(nvr.scheduledRemovals.length, 0, "an unstable controller schedules nothing");

    nvr.removalStable = true;
    nvr.scheduleDeviceRemoval({ accessory, stillGone: () => true });

    const entry = nvr.removalTimers.get(accessory.UUID);

    nvr.cancelDeviceRemovalFor(accessory.UUID);

    assert.deepEqual(nvr.cancelledRemovals, [accessory.UUID], "the cancellation is recorded");

    // A captured stale fire after cancellation still runs its body, but the production-mirroring re-checks make it harmless when stillGone holds; here we prove the
    // presence guard half by firing after the accessory was already removed another way.
    nvr.removeAccessoryFromHomeKit(accessory);
    entry?.fire();

    assert.equal(nvr.platform.accessories.length, 0, "the stale fire is a no-op against the already-removed accessory");
  });

  test("user-disabling DelayDeviceRemoval makes removal immediate and the tail is presence-guarded and bridged-gated", () => {

    const store = new TestStateStore(makeProtectState());
    const { apiCalls, nvr } = makeTestNvr({ store, userOptions: ["Disable.Nvr.DelayDeviceRemoval"] });
    const bystander = makeTestAccessory("Bystander", "uuid:bystander");
    const victim = makeTestAccessory("Victim", "uuid:victim");

    nvr.platform.accessories.push(victim, bystander);
    nvr.scheduleDeviceRemoval({ accessory: victim, stillGone: () => true });

    assert.equal(nvr.scheduledRemovals[0]?.interval, 0, "the disabled option resolves to the immediate path");
    assert.equal(nvr.removalTimers.size, 0, "no timer is recorded on the immediate path");
    assert.deepEqual(nvr.platform.accessories, [bystander], "the accessory is removed synchronously");
    assert.equal(apiCalls.filter((call) => call.kind === "unregister").length, 1, "a bridged accessory records exactly one unregister");

    // The presence guard: a double-removal must be a no-op, never a splice of an unrelated accessory.
    nvr.removeAccessoryFromHomeKit(victim);

    assert.deepEqual(nvr.platform.accessories, [bystander], "a stale double-removal leaves the platform array intact");

    // The bridged gate: an unbridged accessory is spliced but never unregistered.
    bystander._associatedHAPAccessory.bridged = false;
    nvr.removeAccessoryFromHomeKit(bystander);

    assert.equal(nvr.platform.accessories.length, 0, "the unbridged accessory is spliced");
    assert.equal(apiCalls.filter((call) => call.kind === "unregister").length, 1, "no unregister is recorded for an unbridged accessory");
  });
});

describe("harness growth: MQTT recording double and the family builder", () => {

  test("the MQTT double is opt-in and records publishes and subscription registrations with their init options", async () => {

    const store = new TestStateStore(makeProtectState());
    const withoutMqtt = makeTestNvr({ store });

    assert.equal(withoutMqtt.mqtt, null, "the default NVR double carries no MQTT client, matching an unconfigured broker");

    const { mqtt } = makeTestNvr({ mqtt: true, store });

    assert.ok(mqtt, "opting in installs the recording double");

    const signal = new AbortController().signal;

    await mqtt.publish("74ACB9000001/motion", "true");
    mqtt.subscribeGet("74ACB9000001/motion", "motion", () => "false", { signal });

    assert.deepEqual(mqtt.published, [{ message: "true", topic: "74ACB9000001/motion" }], "publishes are recorded");
    assert.equal(mqtt.subscriptions.length, 1, "subscription registrations are recorded");
    assert.equal(mqtt.subscriptions[0]?.init?.signal, signal, "the per-subscription init options - including the lifetime signal - are recorded");
  });

  test("the family builder produces a restart-shaped bridged pair with exact production context keys", () => {

    const store = new TestStateStore(makeProtectState());
    const { nvr } = makeTestNvr({ store });
    const { packageAccessory, parentAccessory } = makeTestAccessoryFamily({ nvr });

    assert.deepEqual(nvr.platform.accessories, [ parentAccessory, packageAccessory ], "both cached accessories land in the platform array");
    assert.deepEqual(parentAccessory.context, { mac: "74ACB9000001", nvr: nvr.ufp.mac }, "the parent context carries the production mac and nvr keys");
    assert.deepEqual(packageAccessory.context, { nvr: nvr.ufp.mac, packageCamera: "74ACB9000001" }, "the package context carries nvr and packageCamera, never mac");
    assert.equal(packageAccessory.UUID, "uuid:74ACB9000001.PackageCamera", "the package UUID pins the persistence-critical identity-suffix fixture");
    assert.ok(parentAccessory._associatedHAPAccessory.bridged && packageAccessory._associatedHAPAccessory.bridged,
      "a restart restore only ever contains bridged accessories");
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
    assert.equal(defaults.modelKey, "light", "the modelKey discriminant is light");

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

  test("the dispatch-injection seam defaults to the real ProtectEventDispatch and replaces it with the injected factory's instance", () => {

    const store = new TestStateStore(makeProtectState());

    // The default path: omitting dispatch builds the real ProtectEventDispatch. We assert on the constructor by identity, NOT instanceof - a subclass satisfies
    // instanceof too, so it would not prove the DEFAULT (un-subclassed) path actually ran.
    const { nvr: defaultNvr } = makeTestNvr({ store });

    assert.equal(defaultNvr.events.constructor, ProtectEventDispatch, "the default events member is exactly a ProtectEventDispatch, not a subclass");

    // The injected path: a trivial recording subclass arms no reset timer. The seam must replace the default with this exact instance, proving the factory ran.
    class TrivialRecordingDispatch extends ProtectEventDispatch {

      public readonly calls: string[] = [];
    }

    const { nvr: injectedNvr } = makeTestNvr({ dispatch: (innerNvr: ProtectNvr): ProtectEventDispatch => new TrivialRecordingDispatch(innerNvr), store });

    assert.equal(injectedNvr.events.constructor, TrivialRecordingDispatch, "the injected factory's instance replaces the default events member");
  });
});

describe("harness growth: the recording transmit doubles", () => {

  // The keyframe-fragment box builder must synthesize a genuine fMP4 fragment the PRODUCTION isKeyframe parse accepts - there is no isKeyframe injection seam, so the
  // transmit test exercises the real fMP4 keyframe coupling. If the builder ever drifts (a wrong box nesting, a flipped TRUN flag, the NON_SYNC bit set), production
  // would read these segments as non-keyframes and the timeshift's keyframe-aligned start would never resolve.
  test("makeKeyframeFragment synthesizes a fragment the production isKeyframe parse accepts", () => {

    assert.equal(isKeyframe(makeKeyframeFragment().data), true, "the synthesized moof>traf>trun fragment reads as a sync sample (keyframe)");
  });

  // The established (segment-yielding) livestream double reports the live profile and yields one init segment then exactly the requested media segments. We drain the
  // iterator to the requested count rather than to completion, because the established iterator PARKS after its media loop (never returning done) - a finite drain would
  // hang. The drain therefore pulls exactly initCount + mediaSegments items and stops.
  test("makeLivestreamSubscriptionDouble established profile yields one init then the requested media segments", async () => {

    const subscription = makeLivestreamSubscriptionDouble({ mediaSegments: 3 });

    assert.equal(subscription.state, "live", "the established profile reports the live state");
    assert.ok(subscription.initSegment, "the established profile populates its init segment");
    assert.equal(await subscription.whenEstablished(), true, "the established profile resolves whenEstablished true");

    const segments: Segment[] = [];
    const iterator = subscription[Symbol.asyncIterator]();

    // Pull exactly four items - the init segment plus the three media segments - then stop, because the iterator parks rather than completing.
    for(let i = 0; i < 4; i++) {

      // eslint-disable-next-line no-await-in-loop -- The pulls are intentionally serial: we walk the async iterator one yield at a time up to its park point.
      const result = await iterator.next();

      assert.equal(result.done, false, "the iterator yields its init and media segments before parking");

      if(result.done) {

        break;
      }

      segments.push(result.value);
    }

    assert.equal(segments.filter((segment) => segment.type === "init").length, 1, "exactly one init segment was yielded");
    assert.equal(segments.filter((segment) => segment.type === "media").length, 3, "exactly three media segments were yielded");

    // Release the park so the iterator does not leak past the test.
    await subscription[Symbol.asyncDispose]();
  });

  // The inert (default) profile is unchanged: it backs the construction suites, which must stay on their segment-less path. A regression that accidentally made the
  // default established would fill those suites' timeshift buffers and change their behavior.
  test("makeLivestreamSubscriptionDouble default profile is the unchanged inert double", async () => {

    const subscription = makeLivestreamSubscriptionDouble();

    assert.equal(subscription.initSegment, null, "the inert profile has no init segment");
    assert.equal(subscription.state, "closed", "the inert profile reports the closed state");
    assert.equal(await subscription.whenEstablished(), false, "the inert profile resolves whenEstablished false");

    const segments: Segment[] = [];

    for await (const segment of subscription) {

      segments.push(segment);
    }

    assert.equal(segments.length, 0, "the inert profile's iterator yields nothing and completes");
  });
});

describe("harness growth: the timeshift behavior doubles", () => {

  // The non-keyframe builder is the negative counterpart to the held keyframe self-test: it must synthesize a fragment the PRODUCTION isKeyframe parse REJECTS, so the
  // timeshift suite's discontinuity keyframe-gate (a discontinuity-marked non-keyframe must defer until a clean keyframe) is genuinely exercised. There is no isKeyframe
  // injection seam, so the only way to drive the non-keyframe path is real bytes with the SAMPLE_FLAG_NON_SYNC bit set.
  test("makeNonKeyframeFragment synthesizes a fragment the production isKeyframe parse rejects", () => {

    assert.equal(isKeyframe(makeNonKeyframeFragment().data), false, "the synthesized non-sync fragment reads as a non-keyframe");
  });

  // Because makeKeyframeFragment is a thin selector over the shared makeMediaFragment, its bytes must stay stable: the KEYFRAME_FRAGMENT const, the
  // segment-yielding parking double, and the recording-transmit path all read these bytes, so a drift would silently churn that net. The keyframe still reads
  // as a sync sample.
  test("makeKeyframeFragment still synthesizes a fragment the production isKeyframe parse accepts after the SSOT refactor", () => {

    assert.equal(isKeyframe(makeKeyframeFragment().data), true, "the keyframe fragment still reads as a sync sample after the refactor");
  });

  // The controllable double, pushed once then iterated, yields exactly that pushed segment. The first next() runs the generator from the top, drains the one queued
  // segment, and yields it. We release the park afterwards so the iterator does not leak past the test.
  test("makeControllableLivestreamDouble yields a pushed segment", async () => {

    const double = makeControllableLivestreamDouble();
    const segment: Segment = { data: makeKeyframeFragment().data, mdat: makeKeyframeFragment().mdat, moof: makeKeyframeFragment().moof, type: "media" };

    double.push(segment);

    const iterator = double[Symbol.asyncIterator]();
    const result = await iterator.next();

    assert.equal(result.done, false, "the iterator yields rather than completing");
    assert.equal(result.value, segment, "the iterator yields the exact pushed segment");

    await double[Symbol.asyncDispose]();
  });

  // The lost-wakeup guard, exercising the genuine park-then-wake hazard: the iterator first PARKS on an empty queue (the kicked-off next() suspends), THEN two segments
  // are pushed synchronously under that single wake, and BOTH must be yielded. A naive park/yield-one/re-park iterator strands the second (it wakes, yields the first,
  // and re-parks before re-checking the queue); the drain-loop re-checks the queue on wake and yields the whole queue across the two pulls. We kick off the first pull
  // WITHOUT awaiting (so the generator runs to its park), settle to let it reach the park, then push both and pull both.
  test("makeControllableLivestreamDouble does not strand a second segment queued under one wake", async () => {

    const double = makeControllableLivestreamDouble();
    const first: Segment = { data: makeKeyframeFragment().data, mdat: makeKeyframeFragment().mdat, moof: makeKeyframeFragment().moof, type: "media" };
    const second: Segment = { data: makeNonKeyframeFragment().data, mdat: makeNonKeyframeFragment().mdat, moof: makeNonKeyframeFragment().moof, type: "media" };
    const iterator = double[Symbol.asyncIterator]();

    // Kick off the first pull and let the generator run to its park on the empty queue (it has nothing to yield yet).
    const firstPull = iterator.next();

    await settle();

    // Both pushes land under a single wake while the generator is parked.
    double.push(first);
    double.push(second);

    const firstResult = await firstPull;
    const secondResult = await iterator.next();

    assert.equal(firstResult.value, first, "the first push is yielded after the wake");
    assert.equal(secondResult.value, second, "the second push queued under the same wake is not stranded");

    await double[Symbol.asyncDispose]();
  });

  // whenEstablished defaults true (so start() commits) and is configurable false (so a start-validation test drives the failure arm).
  test("makeControllableLivestreamDouble whenEstablished defaults true and is configurable false", async () => {

    assert.equal(await makeControllableLivestreamDouble().whenEstablished(), true, "whenEstablished defaults true");
    assert.equal(await makeControllableLivestreamDouble({ whenEstablished: false }).whenEstablished(), false, "whenEstablished is configurable false");
  });

  // initSegment defaults to a populated init (so start() passes its initSegment check) and is configurable null (so the start initSegment-null validation arm is
  // reachable).
  test("makeControllableLivestreamDouble initSegment defaults populated and is configurable null", () => {

    assert.ok(makeControllableLivestreamDouble().initSegment, "initSegment defaults to a populated init segment");
    assert.equal(makeControllableLivestreamDouble({ initSegment: null }).initSegment, null, "initSegment is configurable null");
  });

  // state defaults live and is configurable recovering (so the timeshift's isRestarting getter, which reads state === "recovering", is drivable both ways).
  test("makeControllableLivestreamDouble state defaults live and is configurable recovering", () => {

    assert.equal(makeControllableLivestreamDouble().state, "live", "state defaults live");
    assert.equal(makeControllableLivestreamDouble({ state: "recovering" }).state, "recovering", "state is configurable recovering");
  });

  // end() completes the iterator: the for-await runs to completion (rather than parking forever), which is what feeds the timeshift's consumeSegments finally. Iterating
  // with for-await terminates because end() returns from the generator.
  test("makeControllableLivestreamDouble end completes the iterator", async () => {

    const double = makeControllableLivestreamDouble();

    double.end();

    const segments: Segment[] = [];

    for await (const segment of double) {

      segments.push(segment);
    }

    assert.equal(segments.length, 0, "end with no queued segments completes the iterator immediately");
  });

  // Distinct ids per instance are LOAD-BEARING for the timeshift restart / id-identity targets (the consumeSegments finally guards on subscription id equality). Two
  // default-id doubles must not collide.
  test("makeControllableLivestreamDouble mints a distinct id per instance", () => {

    assert.notEqual(makeControllableLivestreamDouble().id, makeControllableLivestreamDouble().id, "two doubles have distinct ids");
  });

  // The behavior-first recording surface: reassess() increments reassessCalls (the timeshift's transmit-start escalation), and dispose records disposed. A test asserts
  // these rather than reaching into private fields.
  test("makeControllableLivestreamDouble records reassessCalls and disposed", async () => {

    const double = makeControllableLivestreamDouble();

    assert.equal(double.reassessCalls, 0, "reassessCalls starts at zero");
    assert.equal(double.disposed, false, "disposed starts false");

    double.reassess();

    assert.equal(double.reassessCalls, 1, "reassess increments reassessCalls");

    await double[Symbol.asyncDispose]();

    assert.equal(double.disposed, true, "dispose records disposed");
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
    assert.equal(defaults.modelKey, "chime", "the modelKey discriminant is chime");

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
    assert.equal(defaults.modelKey, "viewer", "the modelKey discriminant is viewer");
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

    // LOAD-BEARING: the chime filters ringtones by nvrMac === nvr.ufp.mac (the makeNvrConfig mac), so the default must match or every seeded ringtone is dropped.
    assert.equal(defaults.nvrMac, "74ACB9FFFFFF", "nvrMac defaults to the makeNvrConfig controller mac");
    assert.equal(defaults.id, "test-ringtone-1", "the id defaults");
    assert.equal(defaults.modelKey, "ringtone", "the modelKey discriminant is ringtone");

    const overridden = makeRingtoneConfig({ id: "ring-9", name: "Ring Nine", nvrMac: "FFFFFFFFFFFF" });

    assert.equal(overridden.id, "ring-9", "the id override lands");
    assert.equal(overridden.name, "Ring Nine", "the name override lands");
    assert.equal(overridden.nvrMac, "FFFFFFFFFFFF", "the nvrMac override lands so a foreign-controller ringtone can be modeled");
  });

  test("makeLiveviewConfig defaults the viewer read set and merges overrides", () => {

    const defaults = makeLiveviewConfig();

    assert.equal(defaults.id, "test-liveview-1", "the id defaults");
    assert.equal(defaults.name, "Test Liveview", "the name defaults");
    assert.equal(defaults.modelKey, "liveview", "the modelKey discriminant is liveview");

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
    assert.equal(projection.modelKey, "chime", "the modelKey discriminant is chime");

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
    assert.equal(projection.modelKey, "viewer", "the modelKey discriminant is viewer");

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

  test("the client.ringtones and client.liveviews getters read through the current store, reflecting a later push", () => {

    const store = new TestStateStore(makeProtectState({ liveviews: [makeLiveviewConfig({ id: "lv-1", name: "Front" })],
      ringtones: [makeRingtoneConfig({ id: "ring-1", name: "Ring One" })] }));
    const { nvr } = makeTestNvr({ store });

    assert.deepEqual(nvr.client.ringtones.map((ringtone) => ringtone.id), ["ring-1"], "client.ringtones reads the seeded ringtone");
    assert.deepEqual(nvr.client.liveviews.map((liveview) => liveview.id), ["lv-1"], "client.liveviews reads the seeded liveview");

    // A later push is visible through the getters - they read the CURRENT store, not a held snapshot.
    store.pushRingtones([ makeRingtoneConfig({ id: "ring-2" }), makeRingtoneConfig({ id: "ring-3" }) ]);
    store.pushLiveviews([makeLiveviewConfig({ id: "lv-9" })]);

    assert.deepEqual(nvr.client.ringtones.map((ringtone) => ringtone.id), [ "ring-2", "ring-3" ], "client.ringtones reflects the later ringtones push");
    assert.deepEqual(nvr.client.liveviews.map((liveview) => liveview.id), ["lv-9"], "client.liveviews reflects the later liveviews push");
  });

  test("client.chimes returns the HELD projection instances - not a per-access rebuild - so a write and its rejection lever see one object", () => {

    const store = new TestStateStore(makeProtectState({ chimes: [makeChimeConfig({ id: "chime-h" })] }));
    const held = new TestChimeProjection("chime-h", store);
    const { nvr } = makeTestNvr({ chimes: [held], store });

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
  });

  test("the TestMqttClient captures the get and set handler closures so a test can invoke them", async () => {

    const { mqtt } = makeTestNvr({ mqtt: true, store: new TestStateStore(makeProtectState()) });

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
  });
});

describe("A2 base-capability foundation: the shared dispatch, the sensor carrier / projection, and the TestBaseDevice vehicle", () => {

  test("makeSensorConfig defaults the all-quiet read set (including isMotionDetected and ledSettings) and merges overrides", () => {

    const defaults = makeSensorConfig();

    // The all-quiet defaults the base-capability carrier relies on: every *Settings.isEnabled false, the LED off, a healthy present battery, a "none" mount, no stats.
    assert.equal(defaults.modelKey, "sensor", "the modelKey discriminant is sensor (resolves in deviceConfigSelector)");
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

    // The leak-policy leaf reads featureFlags.waterLeak.channelNames as the capability discriminator. The default is [] (no leak capability), so the all-quiet carrier
    // exposes no leak service; an opted-in channelNames lands on the record so the single-channel / multi-channel leak paths can be exercised.
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
    assert.equal(projection.modelKey, "sensor", "the modelKey discriminant is sensor");

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
    const { nvr } = makeTestNvr({ dispatch: (innerNvr: ProtectNvr): TestRecordingDispatch => new TestRecordingDispatch(innerNvr), store });
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
  });

  test("TestBaseDevice constructs against the harness and reaches the base motion configurator", () => {

    const sensor = makeSensorConfig({ id: "sensor-vehicle" });
    const store = new TestStateStore(makeProtectState({ sensors: [sensor] }));
    const { nvr } = makeTestNvr({ store, userOptions: ["Enable.Motion.Switch"] });
    const accessory = makeTestAccessory("Test Sensor", "uuid:sensor-vehicle");
    const projection = new TestSensorProjection("sensor-vehicle", store) as unknown as Sensor;
    const device = new TestBaseDevice(nvr as unknown as ProtectNvr, accessory as unknown as ProtectAccessory, projection);

    // The ufp read-through narrows to the Sensor carrier.
    assert.equal(device.ufp.id, "sensor-vehicle", "ufp reads through to the seeded sensor record");

    // A smoke check that the public test windows reach the base configurators: hints first, then the motion sensor returns true (the deep motion nets are
    // device-motion.test.ts's job).
    assert.equal(device.configureHintsFor(), true, "configureHintsFor reaches the base configureHints");
    assert.equal(device.configureMotionSensorFor(true), true, "configureMotionSensorFor reaches the base configureMotionSensor and validates the motion service");

    device.cleanup();
  });

  test("TestBaseDevice's configureStatusLedSwitchFor window reaches the base status-LED configurator with the feature", () => {

    const sensor = makeSensorConfig({ id: "sensor-led" });
    const store = new TestStateStore(makeProtectState({ sensors: [sensor] }));
    const { nvr } = makeTestNvr({ store, userOptions: ["Enable.Device.StatusLed.Switch"] });
    const accessory = makeTestAccessory("Test Sensor", "uuid:sensor-led");
    const projection = new TestSensorProjection("sensor-led", store) as unknown as Sensor;
    const device = new TestBaseDevice(nvr as unknown as ProtectNvr, accessory as unknown as ProtectAccessory, projection);

    // A smoke check that the public window reaches the base configureStatusLedSwitch: with the Enable.Device.StatusLed.Switch feature it validates and acquires the
    // status-indicator switch and returns true (the deep status-LED nets - reflection, the onSet command routing, the change-gated log, the failure / auth paths - are
    // device-statusled.test.ts's job).
    assert.equal(device.configureStatusLedSwitchFor(true), true, "configureStatusLedSwitchFor reaches the base configureStatusLedSwitch and validates the switch");

    device.cleanup();
  });

  test("TestBaseDevice's configureInfoFor window reaches the base device-info configurator and writes the AccessoryInformation Model", () => {

    const sensor = makeSensorConfig({ id: "sensor-info" });
    const store = new TestStateStore(makeProtectState({ sensors: [sensor] }));
    const { nvr } = makeTestNvr({ store });
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
  });

  test("TestBaseDevice's spawnObserversFor window registers exactly the two base observers once the lazy registration settles", async () => {

    const sensor = makeSensorConfig({ id: "sensor-observe" });
    const store = new TestStateStore(makeProtectState({ sensors: [sensor] }));
    const { nvr } = makeTestNvr({ store });
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

describe("A2 controller owners: the widened makeNvrConfig, the read-through client.nvr.config getter, and pushNvrPatch", () => {

  test("makeNvrConfig populates the controller-owner read set and preserves the load-bearing mac / host / ports byte-for-byte", () => {

    const defaults = makeNvrConfig();

    // The construction read set the real ProtectNvrSystemInfo needs: a populated systemInfo (the initial pass dereferences systemInfo.cpu.temperature with no optional
    // chaining and the MQTT handler JSON.stringifies the whole object), a marketName / name for the accessory display name and setInfo's Model, and a type for the Model
    // fallback.
    assert.equal(defaults.systemInfo.cpu.temperature, 40, "systemInfo.cpu.temperature defaults to a number so the initial-pass deref succeeds");
    assert.equal(defaults.marketName, "UniFi Dream Machine SE", "marketName defaults so the accessory name and setInfo's Model resolve");
    assert.equal(defaults.name, "Test Controller", "name defaults so sanitizeName(nvr.ufp.name) resolves");
    assert.equal(defaults.type, "UDMPRO", "type defaults so setInfo's marketName ?? type Model fallback is non-empty");

    // LOAD-BEARING: the chime / ringtone nvrMac filter and the makeRingtoneConfig nvrMac default both depend on this exact mac, and the golden-master channel URLs depend
    // on the exact host / ports, so the widening must only ADD fields.
    assert.equal(defaults.mac, "74ACB9FFFFFF", "the controller mac is preserved byte-for-byte");
    assert.equal(defaults.host, "nvr.test", "the host is preserved byte-for-byte");
    assert.deepEqual(defaults.ports, { rtsp: 7447, rtsps: 7441 }, "the RTSP(S) ports are preserved byte-for-byte");

    // hardwareRevision is intentionally absent so setInfo's HardwareRevision length-guard stays short-circuited (the security-system config owns that marker).
    assert.equal((defaults as { hardwareRevision?: string }).hardwareRevision, undefined, "hardwareRevision is left unset so setInfo skips the HardwareRevision write");

    // The temperature option overrides systemInfo.cpu.temperature so the observer reaction can be driven to a known value.
    const warm = makeNvrConfig({ temperature: 42 });

    assert.equal(warm.systemInfo.cpu.temperature, 42, "the temperature option moves systemInfo.cpu.temperature");
  });

  test("client.nvr.config reads THROUGH the store's nvr slice and falls back to a stable default when the slice is null", () => {

    // Seed the store nvr slice non-null: nvr.ufp must read the SEEDED record (not a held value), so the systemInfo temperature reads through to the production getter.
    const seededStore = new TestStateStore(makeProtectState({ nvr: makeNvrConfig({ temperature: 42 }) }));
    const { nvr: seededNvr } = makeTestNvr({ store: seededStore });

    assert.equal(seededNvr.ufp.systemInfo.cpu.temperature, 42, "nvr.ufp reads through the seeded store nvr slice, not a held default");

    // A pushNvrPatch moving systemInfo by reference is reflected by nvr.ufp - the SSOT read-through that lets the owner's observer reaction be non-vacuous.
    seededStore.pushNvrPatch({ systemInfo: { ...seededNvr.ufp.systemInfo, cpu: { ...seededNvr.ufp.systemInfo.cpu, temperature: 99 } } });

    assert.equal(seededNvr.ufp.systemInfo.cpu.temperature, 99, "a pushNvrPatch is reflected by nvr.ufp through the read-through getter");

    // A store with NO nvr slice falls back to the stable default (the existing camera consumers never seed the slice and must keep reading a fixed record).
    const emptyStore = new TestStateStore(makeProtectState());
    const { nvr: emptyNvr } = makeTestNvr({ store: emptyStore });

    assert.equal(emptyNvr.ufp.mac, "74ACB9FFFFFF", "an unseeded nvr slice falls back to the stable default controller record");
    assert.ok(Object.is(emptyNvr.ufp, emptyNvr.ufp), "the fallback default is a stable reference across reads");
  });

  test("pushNvrPatch rebuilds only the nvr slice with a fresh systemInfo reference and guards an absent slice", () => {

    const sensor = makeSensorConfig({ id: "sensor-x" });
    const store = new TestStateStore(makeProtectState({ nvr: makeNvrConfig(), sensors: [sensor] }));
    const before = store.snapshot();
    const beforeNvr = before.nvr;

    assert.ok(beforeNvr, "the seeded store carries an nvr slice");

    store.pushNvrPatch({ systemInfo: { ...beforeNvr.systemInfo, cpu: { ...beforeNvr.systemInfo.cpu, temperature: 55 } } });

    const after = store.snapshot();

    assert.notEqual(after.nvr, beforeNvr, "the patched nvr record is a fresh reference");
    assert.notEqual(after.nvr?.systemInfo, beforeNvr.systemInfo, "the systemInfo is a fresh reference so a narrow systemInfo selector wakes");
    assert.equal(after.nvr?.systemInfo.cpu.temperature, 55, "the patch applied to the nvr record");
    assert.ok(Object.is(after.sensors, before.sensors), "the untouched sensors slice keeps its reference");
    assert.ok(Object.is(after.sensors.get("sensor-x"), before.sensors.get("sensor-x")), "the untouched sensor record keeps its reference");

    // The slice-absent guard: a null nvr slice cannot be patched (the patch composes over the live record).
    const emptyStore = new TestStateStore(makeProtectState());

    assert.throws(() => emptyStore.pushNvrPatch({ systemInfo: beforeNvr.systemInfo }), /The nvr record to patch is not present in the store double/,
      "patching an absent nvr slice throws the store-double guard");
  });
});

describe("A2 controller owners, commit 2: the security-system HAP markers, recordable setProps, the managed-device registry, and the new builder options", () => {

  test("the SecuritySystem service marker constructs and seeds its primary SecuritySystemCurrentState characteristic", () => {

    // The Service marker is invoked directly by acquireService's create branch and must seed a primary characteristic the real getCharacteristicConstructor destructures
    // (else new ProtectSecuritySystem throws), exactly as the Battery / sensor markers do. A wrong seed would let construction succeed yet break the kind-true read.
    const service = new Service.SecuritySystem("Security System");
    const [primary] = service.characteristics;

    assert.equal(service.UUID, "SecuritySystem", "the SecuritySystem marker carries its kind-string static UUID");
    assert.ok(primary, "the SecuritySystem marker materialized a primary characteristic at construction");
    assert.equal(primary.type, Characteristic.SecuritySystemCurrentState,
      "the SecuritySystem marker seeds its kind-true SecuritySystemCurrentState primary characteristic");
    assert.ok(service.testCharacteristic(Characteristic.SecuritySystemCurrentState), "the SecuritySystem marker reports its seed via testCharacteristic");
  });

  test("the SecuritySystem state characteristic markers carry HAP's distinct named arm-state statics", () => {

    // The five Current values and four Target values are verified against @homebridge/hap-nodejs CharacteristicDefinitions. Distinct values are load-bearing: the
    // currentSecuritySystemState string map is keyed by the Current statics, and the setProps validValues array carries the Target statics. Note DISARMED (Current) and
    // DISARM (Target) are the same integer 3 under HAP-distinct names, both reached by name in production.
    assert.deepEqual(
      [ Characteristic.SecuritySystemCurrentState.STAY_ARM, Characteristic.SecuritySystemCurrentState.AWAY_ARM, Characteristic.SecuritySystemCurrentState.NIGHT_ARM,
        Characteristic.SecuritySystemCurrentState.DISARMED, Characteristic.SecuritySystemCurrentState.ALARM_TRIGGERED ],
      [ 0, 1, 2, 3, 4 ], "the SecuritySystemCurrentState statics carry the five distinct HAP values");
    assert.deepEqual(
      [ Characteristic.SecuritySystemTargetState.STAY_ARM, Characteristic.SecuritySystemTargetState.AWAY_ARM, Characteristic.SecuritySystemTargetState.NIGHT_ARM,
        Characteristic.SecuritySystemTargetState.DISARM ],
      [ 0, 1, 2, 3 ], "the SecuritySystemTargetState statics carry the four distinct HAP values");
    assert.equal(Characteristic.SecuritySystemCurrentState.DISARMED, Characteristic.SecuritySystemTargetState.DISARM,
      "DISARMED (Current) and DISARM (Target) are the same integer under HAP-distinct names");

    // The new instances report their kinds for inspect-legible failures.
    assert.equal(new Characteristic.SecuritySystemCurrentState().hapKind, "SecuritySystemCurrentState", "the Current marker instance reports its kind");
    assert.equal(new Characteristic.SecuritySystemTargetState().hapKind, "SecuritySystemTargetState", "the Target marker instance reports its kind");
    assert.equal(new Characteristic.HardwareRevision().hapKind, "HardwareRevision", "the HardwareRevision marker instance reports its kind");
  });

  test("setProps records the last props object and chains by returning the characteristic", () => {

    // The recordable-double discipline: production chains getCharacteristic(SecuritySystemTargetState).setProps({ validValues }) in updateDevice, so the double must
    // capture the props (else the arm-states reconcile net is vacuous) and return the characteristic so the chain compiles. We drive it through a real service. The
    // initial-undefined check reads a SEPARATE fresh characteristic so the asserted-undefined narrowing never pins the binding we later read back after setProps.
    const service = new Service.SecuritySystem("Security System");

    assert.equal(service.getCharacteristic(Characteristic.SecuritySystemCurrentState).props, undefined,
      "a fresh characteristic carries no props until production sets them");

    const characteristic = service.getCharacteristic(Characteristic.SecuritySystemTargetState);
    const returned = characteristic.setProps({ validValues: [ 3, 1 ] });

    assert.equal(returned, characteristic, "setProps returns the characteristic so the production chain compiles");
    assert.deepEqual(service.getCharacteristic(Characteristic.SecuritySystemTargetState).props?.validValues, [ 3, 1 ],
      "setProps captured the exact validValues array for assertion");
  });

  test("getDeviceById resolves a seeded managed device by protectId and survives a vanished record", () => {

    // A store-backed member, not a static stub: its ufp reads through the store (and throws once the record is removed) while its protectId comes from the projection's
    // stable id field and stays non-throwing. That is what makes the absence assertion non-vacuous - getDeviceById must keep resolving by protectId after a
    // removeCameraRecord, not merely "not throw" against a stub that could never throw. (membershipDelta is an orthogonal set-diff guard, not a survival proxy.)
    const camera = makeCameraConfig({ channels: [] });
    const store = new TestStateStore(makeProtectState({ cameras: [camera] }));
    const { nvr } = makeTestNvr({ store });
    const projection = new TestCameraProjection(camera.id, store);
    const accessory = makeTestAccessory("Member Camera", "uuid:member-camera");
    const member = { accessory, accessoryName: "Member Camera", protectId: projection.id, get ufp() { return projection.config; } } as unknown as ProtectDevices;

    nvr.configuredDevices.set(accessory.UUID, member);

    // Present: getDeviceById resolves the member by its protectId, mirroring the production one-liner, and returns null for an unmatched id.
    assert.equal(nvr.getDeviceById(camera.id), member, "getDeviceById finds the seeded member by its protectId");
    assert.equal(nvr.getDeviceById("camera-absent"), null, "getDeviceById returns null when no managed device matches the id");

    // The record vanishes from the store. Reading the member's ufp would now throw, but getDeviceById matches on the non-throwing protectId, so it still resolves it.
    store.removeCameraRecord(camera.id);

    assert.throws(() => member.ufp, "the member's ufp reads through the store and throws once the record is removed - the absence case is genuinely store-backed");
    assert.equal(nvr.getDeviceById(camera.id), member, "getDeviceById still resolves the member by its non-throwing protectId after the record vanished");
  });

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

  test("makeNvrConfig leaves hardwareRevision absent by default and lands an opted-in value (the committed undefined assertion is unchanged)", () => {

    // The OPT-IN contract: the default still omits the field (the committed default-omission assertion at the top of this file stays green), while an explicitly-passed
    // value lands so the security-system owner's unconditional HardwareRevision write is non-vacuous. The conditional spread keeps the key ABSENT (not present-as-
    // undefined) on the default, so an `in` check sees the pre-marker shape.
    const defaults = makeNvrConfig() as { hardwareRevision?: string };

    assert.equal(defaults.hardwareRevision, undefined, "the default makeNvrConfig leaves hardwareRevision unset");
    assert.equal("hardwareRevision" in defaults, false, "the default omits the key entirely rather than carrying it as present-but-undefined");

    const opted = makeNvrConfig({ hardwareRevision: "1.0.0" }) as { hardwareRevision?: string };

    assert.equal(opted.hardwareRevision, "1.0.0", "an opted-in hardwareRevision lands on the record for the security-system owner to write");
  });
});
