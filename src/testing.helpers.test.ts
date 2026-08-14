/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * testing.helpers.test.ts: Unit tests for the cross-cutting test helpers in testing.helpers.ts.
 *
 * The HAP test-double is itself code, and a bug in the double would silently corrupt every consumer test that depends on it...particularly the StatusActive write path
 * the reachability rewire relies on. The double earns the same coverage rigor as production code: every accessor, every fan-out branch, every handler binding. The state
 * store, the shared stubs, and settle() are pinned here alongside it.
 */
import { Characteristic, Service, TestAccessory, TestStateStore, makeProtectState, makeTestAccessory, settle } from "./testing.helpers.ts";
import type { CharacteristicType, TestService } from "./testing.helpers.ts";
import type { Service as HapService, PlatformAccessory } from "homebridge";
import type { ProtectCameraConfig, ProtectLightConfig, ProtectNvrConfig, ProtectNvrLiveviewConfig, ProtectRingtoneConfig, ProtectSensorConfig,
  ProtectViewerConfig } from "unifi-protect";
import { describe, test } from "node:test";
import { setAccessoryName, setServiceName } from "homebridge-plugin-utils";
import assert from "node:assert/strict";
import { makeCameraConfig } from "./devices/testing.helpers.ts";

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

    // HAP throws on a second controller registration while one is configured - the double enforces the same rule.
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
    // OccupancySensor / MotionSensor precedent. Getting the seed pairing right matters: a wrong seed would let construction succeed yet break the kind-true read.
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

describe("A2 controller owners, commit 2: the security-system HAP markers and recordable setProps", () => {

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

    // The five Current values and four Target values are verified against @homebridge/hap-nodejs CharacteristicDefinitions. Distinct values matter: the
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
});

/* The AccessoryInformation naming bridge: the pieces of real-platform behavior the doubles model so homebridge-plugin-utils' own accessory-naming surface runs
 * unmodified against them - updateDisplayName on the accessory, and the service / characteristic statics the library reflects through to locate the information
 * service and gate its name writes. These arms drive the REAL setAccessoryName and setServiceName, so a regression in either the bridge or the library's contract
 * surfaces here rather than as a puzzling failure inside a device-family suite. The casts are the confined `as unknown as` form this file already uses for partial
 * doubles.
 */
describe("harness growth: the AccessoryInformation naming bridge", () => {

  test("updateDisplayName moves the platform wrapper's displayName and the underlying HAP accessory's together", () => {

    const accessory = makeTestAccessory("Original Name");

    assert.equal(accessory._associatedHAPAccessory.displayName, "Original Name", "both names start at the construction value");

    accessory.updateDisplayName("Renamed Accessory");

    assert.equal(accessory.displayName, "Renamed Accessory", "the platform wrapper's displayName follows the update");
    assert.equal(accessory._associatedHAPAccessory.displayName, "Renamed Accessory", "the HAP accessory's displayName moves with it, never drifting apart");
  });

  test("the real setAccessoryName renames both display names and writes the information service's Name and ConfiguredName against real markers", () => {

    const accessory = makeTestAccessory("Original Name");
    const info = accessory.getService(Service.AccessoryInformation);

    assert.ok(info, "the accessory carries an information service from construction for the naming surface to find");

    // The before half, which is what makes every after-assertion a proven transition. The existence probes go through testCharacteristic, a pure has-predicate that
    // (unlike getCharacteristic) never materializes the kind it reads: the information service is BORN carrying Name, the shape real HAP always gives it and the
    // seed the naming surface destructures to recover the Characteristic constructor, while ConfiguredName does not exist until a name write creates it. Probing
    // Name's existence without materializing it is what keeps this arm an honest end-to-end run against a born-shaped accessory rather than against a shape this
    // test itself created.
    assert.ok(info.testCharacteristic(Characteristic.Name), "the information service is born carrying its Name characteristic");
    assert.equal(info.getCharacteristic(Characteristic.Name).value, null, "the born Name characteristic is unwritten until a rename lands");
    assert.equal(info.testCharacteristic(Characteristic.ConfiguredName), false, "ConfiguredName is absent until the naming surface writes it");

    setAccessoryName(accessory as unknown as PlatformAccessory, "Front Door");

    assert.equal(accessory.displayName, "Front Door", "the platform wrapper's displayName took the rename");
    assert.equal(accessory._associatedHAPAccessory.displayName, "Front Door", "the HAP accessory's displayName took the rename");
    assert.equal(info.displayName, "Front Door", "setServiceName wrote the information service's own displayName");
    assert.equal(info.getCharacteristic(Characteristic.Name).value, "Front Door", "the Name characteristic carries the new name");
    assert.equal(info.getCharacteristic(Characteristic.ConfiguredName).value, "Front Door",
      "the ConfiguredName characteristic, the Home app's editable name, carries it too");

    // Both writes landed on the kinds this file's namespace exposes, which is the whole point of wiring real statics: a write against an undefined static would key a
    // characteristic by undefined, leaving the reads above at null and polluting the double.
    assert.ok(info.characteristics.every((characteristic) => characteristic.type !== undefined), "every characteristic the naming surface wrote is keyed by a real kind");
  });

  test("the bridge is scoped to AccessoryInformation: another service kind takes the displayName write but neither name characteristic", () => {

    const accessory = makeTestAccessory();

    // Constructed through the marker so the service arrives carrying its seed characteristic. The naming surface recovers the Characteristic constructor from that
    // first slot and throws without it, so the legacy addService(type, ...) form would fail before ever reaching the predicate gate this arm exists to exercise.
    const motion = accessory.addService(new Service.MotionSensor("Motion"));

    setServiceName(motion as unknown as HapService, "Renamed Motion");

    assert.equal(motion.displayName, "Renamed Motion", "setServiceName writes displayName on any service it runs against");
    assert.equal(motion.testCharacteristic(Characteristic.Name), false, "the unwired kind's Name stays unmaterialized - the degenerate predicate withheld the write");
    assert.equal(motion.testCharacteristic(Characteristic.ConfiguredName), false, "the unwired kind's ConfiguredName stays unmaterialized for the same reason");
  });
});
