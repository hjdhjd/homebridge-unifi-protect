/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * reachability.test.ts: Unit tests for the primitives the projection-backed accessory base depends on for correct teardown and reachability reporting - the composed
 * per-accessory abort signal (teardown) and the reachability read the media paths gate on - exercised against the real production ProtectDevice.
 *
 * These import the real ProtectDevice and drive its own isReachable, noteConnectionChanged, and cleanup directly: every relative import specifier resolves to its
 * on-disk ".ts" sibling under the project's "node --strip-types" test runner (the shared tsconfig's rewriteRelativeImportExtensions rewrites it back to ".js" on
 * emit), and the lone non-erasable construct - the ProtectReservedNames string identifiers - is an erasable "as const" object.
 *
 * The abstract base is exercised through the smallest possible concrete leaf: beside the empty configureDevice ProtectDevice requires, which never runs because the
 * leaf is built without being configured, the subclass adds nothing but a window onto the protected composed signal, and every method under test is the base's own.
 * It is constructed against the minimal mocks isReachable / noteConnectionChanged / cleanup actually read, and the rig hands production the runtime's HAP, whose classes
 * the accessory's own characteristics come from.
 */
import { Characteristic, Service, hap, makeTestAccessory } from "../testing.helpers.ts";
import { TestClock, silentLog } from "homebridge-plugin-utils/testing";
import { describe, test } from "node:test";
import type { Camera } from "unifi-protect";
import { ProtectDevice } from "./device.ts";
import type { ProtectNvr } from "../nvr/nvr.ts";
import { TEST_CLOCK_EPOCH } from "../nvr/testing.helpers.ts";
import type { TestProtectAccessory } from "../testing.helpers.ts";
import assert from "node:assert/strict";
import { composeSignals } from "homebridge-plugin-utils";

// The smallest concrete leaf of the abstract base. Its configureDevice is the empty body ProtectDevice requires and never runs, so a near-empty subclass is a
// faithful, fully real instance of the production class - isReachable, noteConnectionChanged, and cleanup are all the base's own, inherited unchanged. The one other
// addition exposes the protected composed signal so the teardown assertion can observe exactly what cleanup() aborts.
class TestProtectDevice extends ProtectDevice {

  protected override configureDevice(): boolean {

    return true;
  }

  public get composedSignal(): AbortSignal {

    return this.signal;
  }
}

// Construct a real ProtectDevice against the minimal mocks its constructor and the methods under test actually read: the controller-health flag (client.connection),
// the device record (read non-throwing via peek()), the runtime's HAP namespace the accessory's own characteristics come from, the test clock the spine's timer
// registry is built on, started at the harness epoch, and a real AbortSignal for composeSignals. ProtectBase composes its debug channel against the platform's scope
// gate, so that one member must be callable - this rig exercises no debug output, so a gate that always answers false is the honest wiring. The total
// isReachable reads the device's online state through peek().state, so the lever is the record's state field, and a vanished record (present false -> peek() undefined)
// is the unreachable-without-throwing case. Returns the mutable health / record handles so a test can flip either input and re-read the real getter. The casts are
// confined to this construction step; the instance itself is the production class.
const makeReachableDevice = (accessory: TestProtectAccessory):
{ connection: { isHealthy: boolean }; device: { config: { state: string }; present: boolean }; instance: TestProtectDevice } => {

  const connection = { isHealthy: true };
  const device = { config: { state: "CONNECTED" }, name: "Test Accessory", peek(): { state: string } | undefined { return this.present ? this.config : undefined; },
    present: true };
  const log = silentLog();
  const nvr = {

    client: { connection },
    platform: { api: { hap }, clock: new TestClock(TEST_CLOCK_EPOCH), log, pluginLog: log, testDebug: (): boolean => false },
    signal: new AbortController().signal
  };
  const instance = new TestProtectDevice(nvr as unknown as ProtectNvr, accessory, device as unknown as Camera);

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
        // eslint-disable-next-line no-await-in-loop -- The await is serial by intent, so an abort can interleave between iterations.
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    };

    let iterations = 0;
    let finished = false;

    const consume = (async (): Promise<void> => {

      for await (const _tick of ticks()) {

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

    // Healthy controller, online device (state CONNECTED): reachable.
    connection.isHealthy = true;
    device.config.state = "CONNECTED";
    assert.equal(instance.isReachable, true, "a healthy controller and an online device compose to reachable");

    // Healthy controller, offline device (state not CONNECTED): not reachable - the per-device fact gates this device alone.
    device.config.state = "DISCONNECTED";
    assert.equal(instance.isReachable, false, "an offline device is unreachable even on a healthy controller");

    // Unhealthy controller, online device: not reachable - controller health gates every device, and the device's state is stale during an outage.
    connection.isHealthy = false;
    device.config.state = "CONNECTED";
    assert.equal(instance.isReachable, false, "a healthy-looking device is unreachable when the controller is down");

    // Unhealthy controller, offline device: not reachable.
    device.config.state = "DISCONNECTED";
    assert.equal(instance.isReachable, false, "neither input present means unreachable");
  });

  test("isReachable is false (not a throw) for a vanished record, even on a healthy controller", () => {

    const { connection, device, instance } = makeReachableDevice(makeTestAccessory());

    // Present and online on a healthy controller: reachable.
    connection.isHealthy = true;
    device.config.state = "CONNECTED";
    assert.equal(instance.isReachable, true, "a present, online device on a healthy controller is reachable");

    // The controller record vanishes (the device unadopted, in the removal grace): peek() returns undefined, so the total isReachable reports unavailable rather than
    // throwing the ReferenceError the throwing config getter would.
    device.present = false;
    assert.equal(instance.isReachable, false, "a vanished record reports unreachable without throwing");
  });

  // No Response answers for reachability, so the connection loop's push sweeps nothing onto the accessory, and a service with no use for StatusActive grows none from it.
  test("noteConnectionChanged writes no StatusActive onto any service, whatever the reachable state reads", () => {

    const accessory = makeTestAccessory();
    const motion = accessory.addService(Service.MotionSensor, "Motion");
    const occupancy = accessory.addService(Service.OccupancySensor, "Occupancy");
    const { connection, instance } = makeReachableDevice(accessory);

    for(const isHealthy of [ true, false ]) {

      connection.isHealthy = isHealthy;
      instance.noteConnectionChanged();

      assert.equal(motion.testCharacteristic(Characteristic.StatusActive), false, "the motion sensor carries no StatusActive");
      assert.equal(occupancy.testCharacteristic(Characteristic.StatusActive), false, "and neither does the occupancy sensor");
    }
  });

  test("cleanup() aborts the composed per-accessory signal, tearing down every observe loop bound to it", () => {

    const { instance } = makeReachableDevice(makeTestAccessory());

    assert.equal(instance.composedSignal.aborted, false, "the composed signal is live before cleanup");

    instance.cleanup();

    assert.equal(instance.composedSignal.aborted, true, "cleanup() aborts the per-accessory controller, which the composed signal observes");
  });
});
