/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * reachability.test.ts: Unit tests for the projection-backed accessory base's load-bearing primitives - the composed per-accessory abort signal (teardown) and the
 * StatusActive reachability fan-out - exercised against the real production ProtectDevice.
 *
 * These import the real ProtectDevice and drive its own isReachable, refreshReachability, and cleanup. That became possible once the source loads under the project's
 * "node --strip-types" test runner: every relative import specifier now resolves to its on-disk ".ts" sibling (the rig adopted the ".ts"-specifier convention the
 * shared tsconfig's rewriteRelativeImportExtensions already rewrites back to ".js" on emit), and the lone non-erasable construct - the ProtectReservedNames string
 * enum - became an erasable "as const" object. Before that, a test importing ProtectDevice failed to load rather than failed an assertion, so an earlier rig pinned a
 * lifted copy of the algorithm against the HAP test-double; this version pins the production method itself.
 *
 * The abstract base is exercised through the smallest possible concrete leaf: ProtectDevice declares no abstract members, so the subclass adds nothing but a window
 * onto the protected composed signal, and every method under test is the base's own. It is constructed against the minimal mocks isReachable / refreshReachability /
 * cleanup actually read, with the StatusActive characteristic identity wired to the same class the TestAccessory keyed its characteristics on, so the production
 * fan-out resolves the very Map entries the test materialized.
 */
import { Characteristic, Service, makeTestAccessory } from "../testing.helpers.ts";
import { describe, test } from "node:test";
import type { Camera } from "unifi-protect";
import type { ProtectAccessory } from "../types.ts";
import { ProtectDevice } from "./device.ts";
import type { ProtectNvr } from "../nvr/nvr.ts";
import type { TestAccessory } from "../testing.helpers.ts";
import assert from "node:assert/strict";
import { composeSignals } from "homebridge-plugin-utils";

// The smallest concrete leaf of the abstract base. ProtectDevice declares no abstract members, so a near-empty subclass is a faithful, fully real instance of the
// production class - isReachable, refreshReachability, and cleanup are all the base's own, inherited unchanged. The lone addition exposes the protected composed
// signal so the teardown assertion can observe exactly what cleanup() aborts.
class TestProtectDevice extends ProtectDevice {

  public get composedSignal(): AbortSignal {

    return this.signal;
  }
}

// Construct a real ProtectDevice against the minimal mocks its constructor and the methods under test actually read: the controller-health flag (client.connection),
// the device-online flag (the projection), the HAP StatusActive identity (wired to the very class the TestAccessory keyed its characteristics on), and a real
// AbortSignal for composeSignals. ProtectBase binds platform.debug at construction, so that one member must be callable. Returns the mutable health / online handles
// so a test can flip either input and re-read the real getter. The casts are confined to this seam; the instance itself is the production class.
const makeReachableDevice = (accessory: TestAccessory): { connection: { isHealthy: boolean }; device: { isOnline: boolean }; instance: TestProtectDevice } => {

  const captured: unknown[] = [];
  const connection = { isHealthy: true };
  const device = { config: {}, isOnline: true, name: "Test Accessory" };
  const hap = { Characteristic: { StatusActive: Characteristic.StatusActive } };
  const sink = (...args: unknown[]): void => { captured.push(args); };
  const nvr = {

    client: { connection },
    platform: { api: { hap }, debug: sink, log: { debug: sink, error: sink, info: sink, warn: sink } },
    signal: new AbortController().signal
  };
  const instance = new TestProtectDevice(nvr as unknown as ProtectNvr, accessory as unknown as ProtectAccessory, device as unknown as Camera);

  return { connection, device, instance };
};

describe("per-accessory abort signal composition (composeSignals)", () => {

  test("the composed signal aborts when the per-accessory controller is aborted, modeling cleanup()", () => {

    // ProtectDevice composes this.signal = composeSignals(this.controller.signal, nvr.signal). cleanup() calls this.controller.abort(); we model that here and assert
    // the composed signal observes it.
    const accessoryController = new AbortController();
    const nvrController = new AbortController();
    const composed = composeSignals(accessoryController.signal, nvrController.signal);

    assert.equal(composed.aborted, false, "the composed signal is live while neither input has aborted");

    accessoryController.abort();

    assert.equal(composed.aborted, true, "aborting the per-accessory controller (cleanup) tears down the composed signal");
  });

  test("the composed signal aborts when the NVR's terminal shutdown signal fires", () => {

    // The other half of the composition: a plugin-wide shutdown aborts every per-accessory loop without each accessory's own cleanup running.
    const accessoryController = new AbortController();
    const nvrController = new AbortController();
    const composed = composeSignals(accessoryController.signal, nvrController.signal);

    nvrController.abort();

    assert.equal(composed.aborted, true, "aborting the NVR signal tears down the composed signal");
    assert.equal(accessoryController.signal.aborted, false, "the per-accessory controller itself is untouched - shutdown did not run its cleanup, the composition did " +
      "the unwinding");
  });

  test("a for-await loop bound to the composed signal exits once it aborts", async () => {

    // ProtectDevice spawns per-accessory observe loops bound to this.signal. We model one with an async generator that yields until the signal aborts, then assert the
    // consumer terminates when cleanup (the controller abort) fires.
    const accessoryController = new AbortController();
    const nvrController = new AbortController();
    const signal = composeSignals(accessoryController.signal, nvrController.signal);

    const ticks = async function *(): AsyncGenerator<number> {

      let i = 0;

      while(!signal.aborted) {

        yield i++;

        // Yield to the event loop so the abort can interleave between iterations, exactly as a real observe loop awaits its next yield. The serial await is the whole
        // point of the model - a loop parked on its next value is what cleanup must be able to unblock - so the in-loop await is intentional here.
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    };

    let iterations = 0;
    let finished = false;

    const consume = (async (): Promise<void> => {

      for await (const _tick of ticks()) {

        void _tick;
        iterations++;
      }

      finished = true;
    })();

    // Let the loop spin a few times, then tear it down via the per-accessory controller (the cleanup() path).
    await new Promise((resolve) => setTimeout(resolve, 10));
    accessoryController.abort();
    await consume;

    assert.equal(finished, true, "the loop exits cleanly once the composed signal aborts");
    assert.ok(iterations > 0, "the loop ran before teardown, confirming the abort is what stopped it rather than an empty iterator");
  });
});

describe("reachability (real ProtectDevice)", () => {

  test("isReachable is true only when the controller is healthy AND the device is online", () => {

    const { connection, device, instance } = makeReachableDevice(makeTestAccessory());

    // Healthy controller, online device: reachable.
    connection.isHealthy = true;
    device.isOnline = true;
    assert.equal(instance.isReachable, true, "a healthy controller and an online device compose to reachable");

    // Healthy controller, offline device: not reachable - the per-device fact gates this device alone.
    device.isOnline = false;
    assert.equal(instance.isReachable, false, "an offline device is unreachable even on a healthy controller");

    // Unhealthy controller, online device: not reachable - controller health gates every device, and device.isOnline is stale during an outage.
    connection.isHealthy = false;
    device.isOnline = true;
    assert.equal(instance.isReachable, false, "a healthy-looking device is unreachable when the controller is down");

    // Unhealthy controller, offline device: not reachable.
    device.isOnline = false;
    assert.equal(instance.isReachable, false, "neither input present means unreachable");
  });

  test("refreshReachability writes the reachable state to every service carrying StatusActive and leaves services without it untouched", () => {

    const accessory = makeTestAccessory();

    // Two sensor services carry StatusActive; we materialize the characteristic on each, mirroring how the configure paths create it during setup.
    const motion = accessory.addService(Service.MotionSensor, "Motion");
    const occupancy = accessory.addService(Service.OccupancySensor, "Occupancy");

    motion.getCharacteristic(Characteristic.StatusActive);
    occupancy.getCharacteristic(Characteristic.StatusActive);

    // A switch service deliberately does NOT carry StatusActive - the fan-out must skip it via the testCharacteristic guard.
    const toggle = accessory.addService(Service.Switch, "Some Switch");

    toggle.getCharacteristic(Characteristic.On);

    const { connection, device, instance } = makeReachableDevice(accessory);

    // Reachable: the real refreshReachability computes isReachable, walks accessory.services, and writes true to every StatusActive-bearing service.
    connection.isHealthy = true;
    device.isOnline = true;
    instance.refreshReachability();

    assert.equal(motion.getCharacteristic(Characteristic.StatusActive).value, true, "the motion sensor's StatusActive reflects the reachable state");
    assert.equal(occupancy.getCharacteristic(Characteristic.StatusActive).value, true, "the occupancy sensor's StatusActive reflects the reachable state");
    assert.equal(toggle.testCharacteristic(Characteristic.StatusActive), false, "the switch never gained a StatusActive characteristic - the fan-out left it untouched");

    // Unreachable (a controller outage): every StatusActive-bearing service goes inactive, the real improvement over leaving them stale-active.
    connection.isHealthy = false;
    instance.refreshReachability();

    assert.equal(motion.getCharacteristic(Characteristic.StatusActive).value, false, "the motion sensor goes inactive when unreachable");
    assert.equal(occupancy.getCharacteristic(Characteristic.StatusActive).value, false, "the occupancy sensor goes inactive when unreachable");
    assert.equal(toggle.testCharacteristic(Characteristic.StatusActive), false, "the switch is still untouched after the second pass");
  });

  test("cleanup() aborts the composed per-accessory signal, tearing down every observe loop bound to it", () => {

    const { instance } = makeReachableDevice(makeTestAccessory());

    assert.equal(instance.composedSignal.aborted, false, "the composed signal is live before cleanup");

    instance.cleanup();

    assert.equal(instance.composedSignal.aborted, true, "cleanup() aborts the per-accessory controller, which the composed signal observes");
  });
});
