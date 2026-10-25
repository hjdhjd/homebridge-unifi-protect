/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * camera-best-effort.test.ts: Unit tests for the camera operations that deliberately bypass the shared command-error helper - the ambient-light query and
 * the package-camera flashlight heartbeat - driven against the REAL constructed classes.
 *
 * Both are best-effort, cadenced calls onto the live projection (this.device.lux() and this.device.turnOnFlashlight()): the lux query runs at construction and on a
 * 60-second poll, the flashlight pulse on a retry-and-timer keepalive. Because a higher-level cadence re-issues each one, a failure is swallowed to a no-op sentinel -
 * the lux query's -1 ("no reading", which the poll skips on, the init floors only the first read) and the flashlight pulse's reflected-off switch (stop the heartbeat) -
 * rather than routed through runDeviceCommand, which would log every failed poll or pulse. That is the one-sentence reason these two do not share the command-error path
 * the configuration writes use, and it is the cohesive identity this suite pins.
 *
 * The lux describe drives a plain ProtectCamera built INLINE (so it can pass featureFlags.hasLuxCheck, flip controller health to unreachable BEFORE construction, and
 * thread an MQTT double); the flashlight describe drives the REAL doorbell-plus-package family through the package-defer-create construction path, reaching the
 * flashlight on the package camera's own accessory. Each sentinel is asserted against the production path: the projection's lux() / turnOnFlashlight() RECORD their
 * calls and resolve with a settable reading / rejection, so the command (the recorded call count and the returned reading) and the reflection (the characteristic write,
 * the poll's MQTT publish) are asserted INDEPENDENTLY. The 60-second lux poll and the 20-second flashlight heartbeat are registry intervals on the harness's test
 * clock; because each callback is an async fire-and-forget (() => void asyncFn()), an advance fires it but does not drain its await-chain, so every poll / heartbeat
 * assertion settle()s after the advance.
 * The flashlight retry's backoff runs on the platform's clock, so the one failure test walks the harness clock through it rather than waiting in real time.
 */
import { Characteristic, Service, TestStateStore, makeProtectState, makeTestAccessory } from "../../testing.helpers.ts";
import { G2_PRO_CHANNELS, G6_PRO_ENTRY_CHANNELS } from "../../camera.fixtures.ts";
import { TestCameraProjection, makeCameraConfig } from "../testing.helpers.ts";
import type { TestClock, TestMqttClient } from "homebridge-plugin-utils/testing";
import { advanceThroughSchedule, settle, triggerGet, triggerSet } from "homebridge-plugin-utils/testing";
import { afterEach, describe, test } from "node:test";
import type { Camera } from "unifi-protect";
import { PROTECT_HOMEKIT_REFLECT_DELAY } from "../../settings.ts";
import { ProtectCamera } from "./camera.ts";
import type { ProtectNvr } from "../../nvr/nvr.ts";
import { ProtectReservedNames } from "../../types.ts";
import type { TestProtectAccessory } from "../../testing.helpers.ts";
import type { TestProtectNvr } from "../../nvr/testing.helpers.ts";
import assert from "node:assert/strict";
import { makeTestNvr } from "../../nvr/testing.helpers.ts";

// The construction handle a lux test holds: the camera's accessory (the LightSensor lives here), the NVR double (its mqtt double carries the poll's publish, its
// client.connection.isHealthy is the reachability knob), the held projection (luxReading / luxRejection / luxCalls), and the store. Held so the afterEach can unwind the
// per-accessory abort regardless of which path the test drove.
interface BuiltLuxCamera {

  accessory: TestProtectAccessory;
  camera: ProtectCamera;
  clock: TestClock;
  controller: AbortController;
  nvr: TestProtectNvr;
  projection: TestCameraProjection;
}

describe("camera best-effort device-command paths (camera-best-effort concern net)", () => {

  describe("the ambient-light lux query (the AmbientLightCapability's getLux, in ambient-light.ts, a plain ProtectCamera)", () => {

    // The per-test handle, torn down in afterEach so each test's per-accessory abort unwinds and no observe loop or registered interval outlives the test.
    let built: BuiltLuxCamera | undefined;

    afterEach(() => {

      built?.camera.cleanup();
      built?.controller.abort();
      built = undefined;
    });

    // Build a REAL plain ProtectCamera INLINE (mirroring package-defer-create.test.ts), NOT camera-onsets' buildCamera which constructs and settle()s internally
    // and so precludes the pre-construction knobs this describe needs: featureFlags.hasLuxCheck (the ONE featureFlags gate, opening configureAmbientLightSensor), the
    // controller-health flip to unreachable set BEFORE construction (so the init query short-circuits), and the MQTT double the poll publishes through. The held
    // projection is the SAME instance the camera's getLux closure calls, so a test sets luxReading / luxRejection and reads luxCalls on it directly. The
    // construction-time this.timers.setInterval("ambientLight", ..., 60000) arms on the harness clock the builder returns, and a test advances it 60000 to fire the
    // poll.
    async function buildLuxCamera(options: { reachable?: boolean } = {}): Promise<BuiltLuxCamera> {

      const reachable = options.reachable ?? true;
      const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { hasLuxCheck: true } });
      const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
      const { clock, controller, nvr } = makeTestNvr({ mqtt: true, store });

      // Flip controller health to unreachable BEFORE construction when the test needs the init query skipped (isReachable = connection.isHealthy && device.isOnline,
      // device.ts; the reachability.test.ts idiom on makeTestNvr's mutable client).
      nvr.client.connection.isHealthy = reachable;

      const accessory = makeTestAccessory("Test Camera", "74ACB9000001");
      const projection = new TestCameraProjection(cameraConfig.id, store);

      const camera = new ProtectCamera(nvr as unknown as ProtectNvr, accessory, projection as unknown as Camera);

      // Settle the floating configure IIFE (which awaits the init getLux) and the observe loops' lazy registration before any drive.
      await settle();

      return { accessory, camera, clock, controller, nvr, projection };
    }

    test("with hasLuxCheck the LightSensor materializes and a positive init reading passes through", async () => {

      // The reachable build's init getLux ran at construction (ambient-light.ts) against the projection's default positive reading (100), proving the projection's lux()
      // is wired (a missing member would throw at construction).
      built = await buildLuxCamera();

      const lightSensor = built.accessory.getService(Service.LightSensor);

      // HARD-assert the LightSensor exists FIRST (non-optional): an absent service would let every onGet assertion pass vacuously.
      assert.ok(lightSensor, "featureFlags.hasLuxCheck materializes the ambient LightSensor");

      // The CurrentAmbientLightLevel onGet (ambient-light.ts) reads the stored init value, and the StatusActive onGet (ambient-light.ts) reads isReachable (true here).
      assert.equal(await triggerGet(lightSensor.getCharacteristic(Characteristic.CurrentAmbientLightLevel)), 100,
        "the positive init reading passes through untouched to the CurrentAmbientLightLevel onGet");
      assert.equal(await triggerGet(lightSensor.getCharacteristic(Characteristic.StatusActive)), true, "the StatusActive onGet reads isReachable");
      assert.equal(built.projection.luxCalls.length, 1, "the construction-time init issued the lux query exactly once, proving the projection's lux() is wired");
    });

    test("a camera's ambient light sensor publishes its reading and answers no ambient-light get", async () => {

      // The camera states its reading on the ambientlight topic and never subscribes to that topic's get, which the sensor alone answers. The MQTT catalog credits
      // the get to the sensor on exactly that basis, so a get registered here would put the reference in disagreement with the camera.
      built = await buildLuxCamera();

      const mqtt = built.nvr.mqtt;

      // The standing sensor, the MQTT double and the camera's publish come first, because a camera whose sensor never stood, or a double that never saw the
      // camera's traffic, would also show no get.
      assert.ok(built.accessory.getService(Service.LightSensor), "featureFlags.hasLuxCheck materializes the ambient LightSensor");
      assert.ok(mqtt, "the NVR double carries an MQTT client double");
      assert.deepEqual(mqtt.publishedTo("/ambientlight").map((entry) => entry.payload), ["100"], "the camera states its first reading on the ambientlight topic");
      assert.deepEqual(mqtt.subscriptions.filter((subscription) => (subscription.kind === "get") && subscription.topic.endsWith("/ambientlight/get")), [],
        "the camera registers no ambientlight get, which the sensor alone answers");
    });

    test("without hasLuxCheck, no LightSensor is configured (the featureFlag absence pair)", async () => {

      // The featureFlag without-pair: with the Device.AmbientLightSensor toggle on (the default) but hasLuxCheck false and no existing service, the capabilityGate
      // predicate votes false, so no LightSensor is created and no lux query issues (ambient-light.ts).
      const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS });
      const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
      const { controller, nvr } = makeTestNvr({ store });
      const accessory = makeTestAccessory("Test Camera", "74ACB9000001");
      const projection = new TestCameraProjection(cameraConfig.id, store);
      const camera = new ProtectCamera(nvr as unknown as ProtectNvr, accessory, projection as unknown as Camera);

      await settle();

      try {

        assert.equal(accessory.getService(Service.LightSensor), undefined, "no LightSensor without featureFlags.hasLuxCheck");
        assert.equal(projection.luxCalls.length, 0, "the absent sensor never issued a lux query");
      } finally {

        camera.cleanup();
        controller.abort();
      }
    });

    test("a genuine zero reading is floored to HomeKit's 0.0001 minimum at init", async () => {

      // getLux floors a successful zero to the HomeKit minimum (ambient-light.ts: lux ||= 0.0001). Set the reading BEFORE construction so the init stores the floor.
      const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { hasLuxCheck: true } });
      const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
      const { controller, nvr } = makeTestNvr({ store });
      const accessory = makeTestAccessory("Test Camera", "74ACB9000001");
      const projection = new TestCameraProjection(cameraConfig.id, store);

      projection.luxReading = 0;

      const camera = new ProtectCamera(nvr as unknown as ProtectNvr, accessory, projection as unknown as Camera);

      await settle();

      try {

        const lightSensor = accessory.getService(Service.LightSensor);

        assert.ok(lightSensor, "featureFlags.hasLuxCheck materializes the ambient LightSensor");
        assert.equal(await triggerGet(lightSensor.getCharacteristic(Characteristic.CurrentAmbientLightLevel)), 0.0001,
          "a genuine zero reading is floored to the HomeKit 0.0001 minimum, not reported as zero");
        assert.equal(projection.luxCalls.length, 1, "the init issued the lux query once");
      } finally {

        camera.cleanup();
        controller.abort();
      }
    });

    test("an unreachable camera skips the init query and re-maps -1 to 0.0001, never calling lux()", async () => {

      // Build unreachable: getLux short-circuits at if(!this.isReachable) return -1 (ambient-light.ts) WITHOUT calling this.device.lux(), and the init re-maps -1 ->
      // 0.0001 (ambient-light.ts). The doomed query is never issued - the model's queried === false assertion, now real against the production path.
      const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { hasLuxCheck: true } });
      const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
      const { controller, nvr } = makeTestNvr({ store });

      nvr.client.connection.isHealthy = false;

      const accessory = makeTestAccessory("Test Camera", "74ACB9000001");
      const projection = new TestCameraProjection(cameraConfig.id, store);
      const camera = new ProtectCamera(nvr as unknown as ProtectNvr, accessory, projection as unknown as Camera);

      await settle();

      try {

        const lightSensor = accessory.getService(Service.LightSensor);

        assert.ok(lightSensor, "featureFlags.hasLuxCheck materializes the ambient LightSensor even while unreachable");
        assert.equal(await triggerGet(lightSensor.getCharacteristic(Characteristic.CurrentAmbientLightLevel)), 0.0001,
          "the unreachable init re-maps the -1 no-reading sentinel to the 0.0001 floor");
        assert.equal(projection.luxCalls.length, 0, "the doomed query is never issued while unreachable - lux() is never called");
        assert.equal(await triggerGet(lightSensor.getCharacteristic(Characteristic.StatusActive)), false, "the StatusActive onGet reads the unreachable state");
      } finally {

        camera.cleanup();
        controller.abort();
      }
    });

    test("the 60-second poll updates a changed reading and publishes it on MQTT", async () => {

      // Construct with a known init reading (42), then change it (80) and fire the poll: getLux returns 80, the guard if((42 === 80) || (80 === -1)) is false, so the
      // poll updates CurrentAmbientLightLevel to 80 (ambient-light.ts) and publishes "ambientlight" "80" (ambient-light.ts). The publish fires ONLY in the poll path,
      // never at init.
      const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { hasLuxCheck: true } });
      const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
      const { clock, controller, nvr } = makeTestNvr({ mqtt: true, store });
      const accessory = makeTestAccessory("Test Camera", "74ACB9000001");
      const projection = new TestCameraProjection(cameraConfig.id, store);

      projection.luxReading = 42;

      const camera = new ProtectCamera(nvr as unknown as ProtectNvr, accessory, projection as unknown as Camera);

      await settle();

      try {

        const lightSensor = accessory.getService(Service.LightSensor);

        assert.ok(lightSensor, "featureFlags.hasLuxCheck materializes the ambient LightSensor");

        // Change the reading the next poll will read.
        projection.luxReading = 80;

        // Fire the captured construction-time poll, then settle() the async updateAmbientLight await-chain BEFORE asserting - the poll callback is () => void
        // updateAmbientLight(), so the advance fires it but does not drain its await on getLux / updateCharacteristic / publish.
        clock.advance(60000);

        await settle();

        assert.equal(await triggerGet(lightSensor.getCharacteristic(Characteristic.CurrentAmbientLightLevel)), 80, "the poll updated the changed reading to 80");
        assert.ok(nvr.mqtt?.published.some((entry) => (entry.topic === (cameraConfig.mac + "/ambientlight")) && (entry.payload === "80")),
          "the poll published the new reading on the device-scoped ambientlight topic");
      } finally {

        camera.cleanup();
        controller.abort();
      }
    });

    test("the 60-second poll skips on a throw (the -1 sentinel), holding the prior reading and publishing nothing", async () => {

      // Construct with a known init reading (42), which the reconcile adopts and publishes once, then make the next query throw: getLux's catch returns -1, so the
      // poll SKIPS - no updateCharacteristic, no publish. The prior reading is held.
      const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { hasLuxCheck: true } });
      const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
      const { clock, controller, nvr } = makeTestNvr({ mqtt: true, store });
      const accessory = makeTestAccessory("Test Camera", "74ACB9000001");
      const projection = new TestCameraProjection(cameraConfig.id, store);

      projection.luxReading = 42;

      const camera = new ProtectCamera(nvr as unknown as ProtectNvr, accessory, projection as unknown as Camera);

      await settle();

      try {

        const lightSensor = accessory.getService(Service.LightSensor);

        assert.ok(lightSensor, "featureFlags.hasLuxCheck materializes the ambient LightSensor");

        // The next query throws, so getLux returns the -1 no-reading sentinel.
        projection.luxRejection = new Error("The lux response did not contain a numeric illuminance reading.");

        clock.advance(60000);

        await settle();

        assert.equal(await triggerGet(lightSensor.getCharacteristic(Characteristic.CurrentAmbientLightLevel)), 42,
          "a thrown reading skips the poll - the prior 42 holds");
        assert.deepEqual(nvr.mqtt?.publishedTo(cameraConfig.mac + "/ambientlight").map((entry) => entry.payload), ["42"],
          "the reconcile's adoption of the first reading is the topic's one statement, and the skipped poll published nothing");
      } finally {

        camera.cleanup();
        controller.abort();
      }
    });

    test("a failed refresh read preserves the last-known reading at re-init (fails on the unconditional floor)", async () => {

      // Construct with the lux capability and a genuine positive first reading (100): the init read stores 100 and the sensor displays it. Then make a subsequent read
      // fail (the luxRejection hook, exactly as the poll-skip test drives it) and trigger a configureAmbientLightSensor RE-RUN through a featureFlags push that keeps
      // hasLuxCheck true - a controller capability refresh, the reconnect frame the Device.AmbientLightSensor gate later makes routine. The re-run's init read returns
      // the -1 no-reading sentinel; the guard keeps the last-known 100 in place rather than stamping the HomeKit floor.
      const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { hasLuxCheck: true } });
      const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
      const { controller, nvr } = makeTestNvr({ store });
      const accessory = makeTestAccessory("Test Camera", "74ACB9000001");
      const projection = new TestCameraProjection(cameraConfig.id, store);

      projection.luxReading = 100;

      const camera = new ProtectCamera(nvr as unknown as ProtectNvr, accessory, projection as unknown as Camera);

      await settle();

      try {

        const lightSensor = accessory.getService(Service.LightSensor);

        assert.ok(lightSensor, "featureFlags.hasLuxCheck materializes the ambient LightSensor");

        // The vacuity guard: the genuine first read stored 100, so the post-failure assertion proves a PRESERVED reading rather than an initial one.
        assert.equal(await triggerGet(lightSensor.getCharacteristic(Characteristic.CurrentAmbientLightLevel)), 100,
          "the genuine first reading stored 100 before the failed refresh");

        // The next read throws (the camera momentarily unreachable mid-flight, or the lux capability transiently withdrawn), so the re-run's getLux returns -1.
        projection.luxRejection = new Error("The lux response did not contain a numeric illuminance reading.");

        // A featureFlags push that keeps hasLuxCheck true wakes the capability observer (the store spreads a new featureFlags reference, so Object.is never dedups it),
        // which drives reconcileCapabilities and re-runs configureAmbientLightSensor against the failed read.
        store.pushCameraFeatureFlags(cameraConfig.id, { hasLuxCheck: true });

        await settle();

        // The init guard adopted only a genuine reading: the failed re-read left the last-known 100 in place. Reverting the guard (the unconditional this.ambientLight =
        // await getLux() then if(-1) 0.0001) stamps the display to the 0.0001 floor here -> RED.
        assert.equal(await triggerGet(lightSensor.getCharacteristic(Characteristic.CurrentAmbientLightLevel)), 100,
          "a failed refresh read preserved the last-known 100 rather than flooring the display");
      } finally {

        camera.cleanup();
        controller.abort();
      }
    });
  });

  describe("the package-camera flashlight (camera-package.ts:171-265, the REAL doorbell-plus-package family)", () => {

    let doorbell: ProtectCamera | undefined;
    let harnessController: AbortController | undefined;

    afterEach(() => {

      doorbell?.cleanup();
      harnessController?.abort();
      doorbell = undefined;
      harnessController = undefined;
    });

    // Build a REAL doorbell-plus-package family (the package-defer-create.test.ts construction path) with the package channel PRESENT (G6_PRO_ENTRY_CHANNELS carries it),
    // so the package camera materializes immediately and its flashlight Lightbulb is configured. The HELD projection is the SAME instance the package camera shares
    // (doorbell.ts passes the doorbell's own #device to createPackageCamera), so a test sets flashlightRejection and reads flashlightCalls on it directly. isDark is
    // threaded at construction (makeCameraConfig.isDark) so the dark-guard resolves deterministically.
    async function buildFlashlightFamily(options: { isDark: boolean }): Promise<{ cameraId: string; clock: TestClock; projection: TestCameraProjection;
      store: TestStateStore; }> {

      const cameraConfig = makeCameraConfig({ channels: G6_PRO_ENTRY_CHANNELS, featureFlags: { hasPackageCamera: true, isDoorbell: true }, isDark: options.isDark,
        name: "Front Door" });
      const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
      const { clock, controller, nvr } = makeTestNvr({ store });
      const projection = new TestCameraProjection(cameraConfig.id, store);

      harnessController = controller;
      doorbell = new ProtectCamera(nvr as unknown as ProtectNvr, makeTestAccessory("Front Door", "74ACB9000001"),
        projection as unknown as Camera);

      await settle();

      return { cameraId: cameraConfig.id, clock, projection, store };
    }

    // Resolve the package camera's flashlight On characteristic, hard-asserting the package camera is live and the gated Lightbulb exists FIRST (Doorbell.PackageCamera.
    // Flashlight defaults TRUE, so no Enable string is needed; an absent service would let every value assertion pass vacuously).
    function flashlightOn(): Characteristic {

      assert.ok(doorbell?.packageCamera, "the package camera instance is live post-settle");

      const packageAccessory = doorbell.packageCamera.accessory as unknown as TestProtectAccessory;
      const flashlight = packageAccessory.getServiceById(Service.Lightbulb, ProtectReservedNames.LIGHTBULB_PACKAGE_FLASHLIGHT);

      assert.ok(flashlight, "Doorbell.PackageCamera.Flashlight materializes the package flashlight Lightbulb");

      return flashlight.getCharacteristic(Characteristic.On);
    }

    test("not dark: the On set issues no pulse and reflects off after the 50ms window", async () => {

      // The dark-guard (configureFlashlight in camera-package.ts): isDark false short-circuits with no pulse and a deferred reflect of On false.
      const { clock, projection } = await buildFlashlightFamily({ isDark: false });

      const onChar = flashlightOn();

      await triggerSet(onChar, true);

      // The command: no pulse issued (the dark-guard returned before activateFlashlight).
      assert.equal(projection.flashlightCalls.length, 0, "the not-dark guard issues no flashlight pulse");

      // The reflection: HAP stores the written On true, then the deferred reflect fires updateCharacteristic(On, false). Advance the clock through the window and
      // assert the reflect-off landed.
      clock.advance(PROTECT_HOMEKIT_REFLECT_DELAY);

      assert.equal(onChar.value, false, "the not-dark guard reflects the flashlight off after the 50ms window");
    });

    test("dark: the On set pulses, lights On, and the 20-second heartbeat re-pulses", async () => {

      // The happy path (configureFlashlight in camera-package.ts): isDark true pulses via the retry, reflects On true, and arms the 20-second heartbeat that re-pulses.
      const { clock, projection } = await buildFlashlightFamily({ isDark: true });

      const onChar = flashlightOn();

      await triggerSet(onChar, true);

      // The command: exactly one pulse, threading the abort signal the retry binds (activateFlashlight in camera-package.ts).
      assert.equal(projection.flashlightCalls.length, 1, "the dark On set issues exactly one flashlight pulse");
      assert.ok(projection.flashlightCalls[0]?.opts?.signal, "the pulse threads the retry's abort signal");

      // The reflection: flashlightState is true, read through the On onGet (configureFlashlight in camera-package.ts) which is robust to HAP's stored write.
      assert.equal(await triggerGet(onChar), true, "a successful pulse lights the flashlight On");

      // The 20-second heartbeat (configureFlashlight in camera-package.ts) re-pulses; settle() drains the async () => void activateFlashlight() the advance fired.
      clock.advance(20000);

      await settle();

      assert.equal(projection.flashlightCalls.length, 2, "the 20-second heartbeat re-pulses the flashlight");
    });

    test("the Off set clears the heartbeat and reflects off without issuing a command", async () => {

      // The off path (configureFlashlight in camera-package.ts): value false clears the timer, sets flashlightState false, and returns without any pulse.
      const { projection } = await buildFlashlightFamily({ isDark: true });

      const onChar = flashlightOn();

      await triggerSet(onChar, false);

      assert.equal(projection.flashlightCalls.length, 0, "the Off set issues no flashlight command");
      assert.equal(await triggerGet(onChar), false, "the Off set reflects the flashlight off via flashlightState");
    });

    test("dark with a persistently rejecting pulse: the retry exhausts three attempts and reflects off", async () => {

      // The failure path (camera-package.ts): the retry attempts three times with a 1000ms backoff between attempts on the platform's clock, the catch swallows the
      // persistent rejection to lit = false, and the switch reflects off. The heartbeat interval that arms after activateFlashlight() resolves, even on failure, lands on
      // the same harness clock; the walk below stops at the last backoff, well short of the heartbeat's cadence, and the heartbeat-arm is already netted on the happy
      // path.
      const { clock, projection } = await buildFlashlightFamily({ isDark: true });

      const onChar = flashlightOn();

      projection.flashlightRejection = new Error("The flashlight pulse was rejected.");

      // Fire the on without awaiting it, then walk the clock through each backoff wait, letting each failed attempt reach its next wait before the clock moves. The
      // attempt count is read as soon as the walk settles and before the set is awaited, so a backoff left waiting in real time reads short of the full budget.
      // activateFlashlight's own try/catch swallows the final rejection, so the set then resolves rather than throwing.
      const activating = triggerSet(onChar, true);

      await advanceThroughSchedule(clock, [ 1000, 1000 ]);

      assert.equal(projection.flashlightCalls.length, 3, "the retry exhausts its full three-attempt budget against a persistent rejection");

      await activating;

      assert.equal(await triggerGet(onChar), false, "an exhausted pulse reflects the flashlight off via flashlightState");
    });

    test("an off during an in-flight activation wins: no re-latch, no heartbeat arm", async () => {

      const { clock, projection } = await buildFlashlightFamily({ isDark: true });

      const onChar = flashlightOn();

      // Fire the on WITHOUT awaiting - its handler suspends at the retry await, having issued its one pulse - then drive the off to completion (which bumps the intent
      // generation), then let the on resume into its now-superseded continuation.
      const activating = triggerSet(onChar, true);

      await triggerSet(onChar, false);
      await activating;

      // The off won: the flashlight reads off through the onGet (flashlightState), un-re-latched by the stale activation's post-retry continuation. The onGet is the
      // authoritative read here - the code never pushes updateCharacteristic on this path, so the characteristic's stored value is HAP's record of the last HomeKit
      // write to resolve, not a state the code wrote.
      assert.equal(await triggerGet(onChar), false, "the off during the in-flight activation wins - the flashlight reads off");

      // The superseded activation skipped arming the keyed interval, so the heartbeat was never armed: advancing past its cadence issues no further pulse. A shape
      // that gated only inside activateFlashlight would arm the heartbeat from the stale closure, and this advance would grow the pulse count.
      const callsBefore = projection.flashlightCalls.length;

      clock.advance(20000);

      await settle();

      assert.equal(projection.flashlightCalls.length, callsBefore, "the superseded activation never armed the heartbeat, so no further pulse fires");
    });

    test("a legitimate activation within the not-dark reset window is not stomped off", async () => {

      const { cameraId, clock, store } = await buildFlashlightFamily({ isDark: false });

      const onChar = flashlightOn();

      // Not dark: the on schedules a 50ms deferred off-reset under its captured generation.
      await triggerSet(onChar, true);

      // The camera becomes dark, and a fresh on latches the flashlight - a NEW generation the earlier deferred reset must not stomp.
      store.pushCameraPatch(cameraId, { isDark: true });
      await triggerSet(onChar, true);

      assert.equal(await triggerGet(onChar), true, "the later dark activation lit the flashlight on");

      // Advance the earlier activation's 50ms window: its reset re-checks its captured generation, sees itself superseded, and does nothing - the flashlight stays on.
      clock.advance(PROTECT_HOMEKIT_REFLECT_DELAY);

      assert.equal(await triggerGet(onChar), true, "the later activation's On survives the earlier not-dark reset window");
      assert.equal(onChar.value, true, "the switch characteristic stays on, not stomped off by the stale not-dark reset");
    });
  });
});

describe("the camera's ambient-light reading restated per broker session", () => {

  // Build a lux-capable camera whose first read returns the given reading or fails, flip the session lever off and on, and hand back the topic's payloads.
  const restoredPayloads = async (options: { reading?: number }): Promise<{ asBuilt: string[]; restored: string[] }> => {

    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { hasLuxCheck: true } });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { controller, nvr } = makeTestNvr({ mqtt: true, store });
    const projection = new TestCameraProjection(cameraConfig.id, store);

    if(options.reading === undefined) {

      projection.luxRejection = new Error("The lux response did not contain a numeric illuminance reading.");
    } else {

      projection.luxReading = options.reading;
    }

    const camera = new ProtectCamera(nvr as unknown as ProtectNvr, makeTestAccessory("Test Camera", "74ACB9000001"),
      projection as unknown as Camera);

    try {

      await settle();

      const read = (): string[] => (nvr.mqtt?.publishedTo(cameraConfig.mac + "/ambientlight") ?? []).map((entry) => entry.payload.toString());
      const asBuilt = read();

      if(nvr.mqtt) {

        nvr.mqtt.connected = false;
        await settle();
        nvr.mqtt.connected = true;
        await settle();
      }

      return { asBuilt, restored: read().slice(asBuilt.length) };
    } finally {

      camera.cleanup();
      controller.abort();
    }
  };

  test("a genuine first reading is stated once as the camera is built and restated once per session", async () => {

    assert.deepEqual(await restoredPayloads({ reading: 42 }), { asBuilt: ["42"], restored: ["42"] }, "the adopted reading is stated once and restated once");
  });

  test("a failed first read states nothing, and a session restore after it restates nothing", async () => {

    assert.deepEqual(await restoredPayloads({}), { asBuilt: [], restored: [] }, "the floor that stands in for no reading is never stated");
  });

  // Build a lux-capable camera reading the given level and hand back the levers the rows below drive: the capability's reconcile, reached through the camera's private
  // accessor because a capability wake is exactly a run of it, the session double, and the topic's recorded payloads.
  const buildLuxCamera = ({ connected = true, reading, userOptions = [] }: { connected?: boolean; reading?: number; userOptions?: string[] }): {
    accessory: TestProtectAccessory; cleanup: () => void; clock: TestClock; mqtt: TestMqttClient; projection: TestCameraProjection; read: () => string[];
    reconcile: () => Promise<void>;
  } => {

    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { hasLuxCheck: true } });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { clock, controller, mqtt, nvr } = makeTestNvr({ mqtt: true, store, userOptions });
    const projection = new TestCameraProjection(cameraConfig.id, store);
    const accessory = makeTestAccessory("Test Camera", "74ACB9000001");

    assert.ok(mqtt, "the NVR double carries an MQTT client double");

    // A disconnected double is the production startup shape: the camera is built before the broker acknowledges the first session. An absent reading makes the
    // first read fail.
    mqtt.connected = connected;

    if(reading === undefined) {

      projection.luxRejection = new Error("The lux response did not contain a numeric illuminance reading.");
    } else {

      projection.luxReading = reading;
    }

    const camera = new ProtectCamera(nvr as unknown as ProtectNvr, accessory, projection as unknown as Camera);
    const capability = (camera as unknown as { ambientLight: { reconcile: () => Promise<void> } }).ambientLight;

    return {

      accessory,
      cleanup: (): void => {

        camera.cleanup();
        controller.abort();
      },
      clock,
      mqtt,
      projection,
      read: (): string[] => mqtt.publishedTo(cameraConfig.mac + "/ambientlight").map((entry) => entry.payload.toString()),
      reconcile: async (): Promise<void> => capability.reconcile()
    };
  };

  // Flip the session lever off and back on, settling after each edge so the connect handlers have run.
  const restoreSession = async (mqtt: TestMqttClient): Promise<void> => {

    mqtt.connected = false;
    await settle();
    mqtt.connected = true;
    await settle();
  };

  test("two reconciles reading the same moved level, the second run after the first completes, record that level once", async () => {

    const built = buildLuxCamera({ reading: 42 });

    try {

      await settle();

      built.projection.luxReading = 57;
      await built.reconcile();
      await built.reconcile();

      assert.deepEqual(built.read(), [ "42", "57" ], "the moved level is stated once and the second run leaves it unsent");
    } finally {

      built.cleanup();
    }
  });

  test("two reconciles that overlap at the light-level read record the moved level once", async () => {

    const built = buildLuxCamera({ reading: 42 });

    try {

      await settle();

      built.projection.luxReading = 57;
      await Promise.all([ built.reconcile(), built.reconcile() ]);

      assert.deepEqual(built.read(), [ "42", "57" ], "the second statement of the moved level is suppressed at issue");
    } finally {

      built.cleanup();
    }
  });

  test("a later failed read records nothing", async () => {

    const built = buildLuxCamera({ reading: 42 });

    try {

      await settle();

      built.projection.luxRejection = new Error("The lux response did not contain a numeric illuminance reading.");
      await built.reconcile();

      assert.deepEqual(built.read(), ["42"], "the floor a failed read stands in with is never stated");
    } finally {

      built.cleanup();
    }
  });

  test("after a second reconcile, a session restore restates the reading once", async () => {

    const built = buildLuxCamera({ reading: 42 });

    try {

      await settle();
      await built.reconcile();

      const asBuilt = built.read().length;

      await restoreSession(built.mqtt);

      assert.deepEqual(built.read().slice(asBuilt), ["42"], "the capability's one registration restates the reading once, however many times it reconciled");
    } finally {

      built.cleanup();
    }
  });

  test("a camera whose light sensor is gated off states and restates nothing", async () => {

    const built = buildLuxCamera({ reading: 42, userOptions: ["Disable.Device.AmbientLightSensor"] });

    try {

      await settle();
      await restoreSession(built.mqtt);

      assert.deepEqual(built.read(), [], "no sensor service stands, so the topic is never stated");
    } finally {

      built.cleanup();
    }
  });

  test("a camera built while no session is held records nothing until the session starts, then its reading once", async () => {

    const built = buildLuxCamera({ connected: false, reading: 42 });

    try {

      await settle();

      assert.deepEqual(built.read(), [], "the statement made with no session held is refused");

      built.mqtt.connected = true;
      await settle();

      assert.deepEqual(built.read(), ["42"], "the first session states the reading once");
    } finally {

      built.cleanup();
    }
  });

  test("a poll that reads a moved level while the session is down restates that level once when the session returns", async () => {

    const built = buildLuxCamera({ reading: 42 });

    try {

      await settle();

      built.mqtt.connected = false;
      await settle();
      built.projection.luxReading = 57;
      built.clock.advance(60000);
      await settle();

      assert.deepEqual(built.read(), ["42"], "the poll's statement made with no session held is refused");

      built.mqtt.connected = true;
      await settle();

      assert.deepEqual(built.read(), [ "42", "57" ], "the returning session hears the moved level once");
    } finally {

      built.cleanup();
    }
  });

  test("a teardown during the reconcile's light-level read writes nothing and publishes nothing afterwards", async () => {

    const built = buildLuxCamera({ reading: 42 });

    await settle();

    // The run is suspended at its read when the camera tears down, so only the capability's signal check after that read keeps the moved level out of HomeKit and MQTT.
    built.projection.luxReading = 57;

    const run = built.reconcile();

    built.cleanup();
    await run;
    await settle();

    assert.equal(built.accessory.getService(Service.LightSensor)?.getCharacteristic(Characteristic.CurrentAmbientLightLevel).value, 42,
      "the torn-down run leaves the sensor's reading where it was");
    assert.deepEqual(built.read(), ["42"], "the torn-down run publishes nothing");
  });

  test("a failed first read, then a dark poll reading at the same floor, is restated once at the next session", async () => {

    const built = buildLuxCamera({});

    try {

      await settle();

      // The failed read floors the held value to the same minimum a dark reading floors to, so the poll's comparison sees no change and publishes nothing. The poll's
      // reading is still genuine, which is what the restatement reads.
      built.projection.luxRejection = null;
      built.projection.luxReading = 0;
      built.clock.advance(60000);
      await settle();

      assert.deepEqual(built.read(), [], "neither the failed read nor the unchanged dark poll publishes");

      await restoreSession(built.mqtt);

      assert.deepEqual(built.read(), ["0.0001"], "the session restates the dark reading once");
    } finally {

      built.cleanup();
    }
  });
});
