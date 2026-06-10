/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * testing.helpers.test.ts: Unit tests for the cross-cutting test helpers in testing.helpers.ts.
 *
 * The HAP test-double is itself code, and a bug in the double would silently corrupt every consumer test that depends on it...particularly the StatusActive
 * write path the reachability rewire relies on. The double earns the same coverage rigor as production code: every accessor, every fan-out branch, every handler binding.
 */
import { Characteristic, Service, TestAccessory, TestStateStore, makeCameraConfig, makeProtectState, makeTestAccessory, settle } from "./testing.helpers.ts";
import { describe, test } from "node:test";
import type { ProtectCameraConfig } from "unifi-protect";
import assert from "node:assert/strict";

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
});

describe("v5 state-store double (TestStateStore)", () => {

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
