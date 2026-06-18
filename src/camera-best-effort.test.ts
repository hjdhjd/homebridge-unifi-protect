/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * camera-best-effort.test.ts: Unit tests for the two migrated camera operations that deliberately bypass the shared command-error helper - the ambient-light query and
 * the package-camera flashlight heartbeat - driven against the REAL constructed classes.
 *
 * Both are best-effort, cadenced calls onto the live v5 projection (this.device.lux() and this.device.turnOnFlashlight()): the lux query runs at construction and on a
 * 60-second poll, the flashlight pulse on a retry-and-timer keepalive. Because a higher-level cadence re-issues each one, a failure is swallowed to a no-op sentinel -
 * the lux query's -1 ("no reading", which the poll skips on, the init re-maps to the 0.0001 floor) and the flashlight pulse's reflected-off switch (stop the heartbeat) -
 * rather than routed through runDeviceCommand, which would log every failed poll or pulse. That is the one-sentence reason these two do not share the command-error seam
 * the configuration writes use, and it is the cohesive identity this suite pins.
 *
 * The lux describe drives a plain ProtectCamera built INLINE (so it can pass featureFlags.hasLuxCheck, flip controller health to unreachable BEFORE construction, and
 * thread an MQTT double); the flashlight describe drives the REAL doorbell-plus-package family through the package-defer-create seam, reaching the flashlight on the
 * package camera's own accessory. Each sentinel is asserted against the production path: the projection's lux() / turnOnFlashlight() RECORD their calls and resolve with
 * a settable reading / rejection, so the command (the recorded call count and the returned reading) and the reflection (the characteristic write, the poll's MQTT
 * publish) are asserted INDEPENDENTLY. The 60-second lux poll and the 20-second flashlight heartbeat are GLOBAL setInterval callbacks captured by mock.timers; because
 * each callback is an async fire-and-forget (() => void asyncFn()), a tick fires it but does not drain its await-chain, so every poll / heartbeat assertion settle()s
 * after the tick.
 * The flashlight retry backoff is node:timers/promises and is un-reachable by mock.timers, so the one failure test pays its real ~2-second retry budget by design.
 */
import { Characteristic, Service, TestCameraProjection, TestStateStore, makeCameraConfig, makeProtectState, makeTestAccessory, makeTestNvr, settle }
  from "./testing.helpers.ts";
import { G2_PRO_CHANNELS, G6_PRO_ENTRY_CHANNELS } from "./resolution.fixtures.ts";
import type { TestAccessory, TestCharacteristic, TestProtectNvr } from "./testing.helpers.ts";
import { afterEach, describe, mock, test } from "node:test";
import type { Camera } from "unifi-protect";
import type { ProtectAccessory } from "./types.ts";
import { ProtectCamera } from "./devices/camera.ts";
import type { ProtectNvr } from "./nvr.ts";
import { ProtectReservedNames } from "./types.ts";
import assert from "node:assert/strict";

// The construction handle a lux test holds: the camera's accessory (the LightSensor lives here), the NVR double (its mqtt double carries the poll's publish, its
// client.connection.isHealthy is the reachability knob), the held projection (luxReading / luxRejection / luxCalls), and the store. Held so the afterEach can unwind the
// per-accessory abort regardless of which path the test drove.
interface BuiltLuxCamera {

  accessory: TestAccessory;
  camera: ProtectCamera;
  controller: AbortController;
  nvr: TestProtectNvr;
  projection: TestCameraProjection;
}

describe("camera best-effort device-command paths (camera-best-effort concern net)", () => {

  describe("the ambient-light lux query (camera.ts:397-489, a plain ProtectCamera)", () => {

    // The per-test handle, torn down in afterEach so each test's per-accessory abort unwinds and no observe loop or registered interval outlives the test.
    let built: BuiltLuxCamera | undefined;

    afterEach(() => {

      built?.camera.cleanup();
      built?.controller.abort();
      built = undefined;
    });

    // Build a REAL plain ProtectCamera INLINE (mirroring package-defer-create.test.ts:61-72), NOT camera-onsets' buildCamera which constructs and settle()s internally
    // and so precludes the pre-construction knobs this describe needs: featureFlags.hasLuxCheck (the ONE featureFlags gate, opening configureAmbientLightSensor), the
    // controller-health flip to unreachable set BEFORE construction (so the init query short-circuits), and the MQTT double the poll publishes through. The held
    // projection is the SAME instance the camera's getLux closure calls, so a test sets luxReading / luxRejection and reads luxCalls on it directly. mock.timers is
    // enabled for the GLOBAL setInterval BEFORE construction so the construction-time registerInterval("ambientLight", ..., 60000) is captured; the test ticks 60000 to
    // fire the poll.
    async function buildLuxCamera(options: { reachable?: boolean } = {}): Promise<BuiltLuxCamera> {

      const reachable = options.reachable ?? true;
      const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { hasLuxCheck: true } });
      const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
      const { controller, nvr } = makeTestNvr({ mqtt: true, store });

      // Flip controller health to unreachable BEFORE construction when the test needs the init query skipped (isReachable = connection.isHealthy && device.isOnline,
      // device.ts:828; the reachability.test.ts:45 idiom on makeTestNvr's mutable client).
      nvr.client.connection.isHealthy = reachable;

      const accessory = makeTestAccessory("Test Camera", "uuid:74ACB9000001");
      const projection = new TestCameraProjection(cameraConfig.id, store);

      // Capture the construction-time GLOBAL setInterval so the poll fires on tick(60000) rather than on the wall clock.
      mock.timers.enable({ apis: ["setInterval"] });

      const camera = new ProtectCamera(nvr as unknown as ProtectNvr, accessory as unknown as ProtectAccessory, projection as unknown as Camera);

      // Settle the floating configure IIFE (which awaits the init getLux) and the observe loops' lazy registration before any drive.
      await settle();

      return { accessory, camera, controller, nvr, projection };
    }

    test("with hasLuxCheck the LightSensor materializes and a positive init reading passes through", async () => {

      // The reachable build's init getLux ran at construction (camera.ts:475) against the projection's default positive reading (100), proving the projection's lux() is
      // wired (a missing member would throw at construction).
      built = await buildLuxCamera();

      try {

        const lightSensor = built.accessory.getService(Service.LightSensor);

        // HARD-assert the LightSensor exists FIRST (non-optional): an absent service would let every onGet assertion pass vacuously.
        assert.ok(lightSensor, "featureFlags.hasLuxCheck materializes the ambient LightSensor");

        // The CurrentAmbientLightLevel onGet (camera.ts:483) reads the stored init value, and the StatusActive onGet (camera.ts:472) reads isReachable (true here).
        assert.equal(await lightSensor.getCharacteristic(Characteristic.CurrentAmbientLightLevel).triggerGet(), 100,
          "the positive init reading passes through untouched to the CurrentAmbientLightLevel onGet");
        assert.equal(await lightSensor.getCharacteristic(Characteristic.StatusActive).triggerGet(), true, "the StatusActive onGet reads isReachable");
        assert.equal(built.projection.luxCalls.length, 1, "the construction-time init issued the lux query exactly once, proving the projection's lux() is wired");
      } finally {

        mock.timers.reset();
      }
    });

    test("without hasLuxCheck, no LightSensor is configured (the featureFlag absence pair)", async () => {

      // The featureFlag without-pair: hasLuxCheck false (the makeCameraConfig default) gates configureAmbientLightSensor out entirely (camera.ts:400).
      const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS });
      const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
      const { controller, nvr } = makeTestNvr({ store });
      const accessory = makeTestAccessory("Test Camera", "uuid:74ACB9000001");
      const projection = new TestCameraProjection(cameraConfig.id, store);
      const camera = new ProtectCamera(nvr as unknown as ProtectNvr, accessory as unknown as ProtectAccessory, projection as unknown as Camera);

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

      // getLux floors a successful zero to the HomeKit minimum (camera.ts:433: lux ||= 0.0001). Set the reading BEFORE construction so the init stores the floor.
      const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { hasLuxCheck: true } });
      const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
      const { controller, nvr } = makeTestNvr({ store });
      const accessory = makeTestAccessory("Test Camera", "uuid:74ACB9000001");
      const projection = new TestCameraProjection(cameraConfig.id, store);

      projection.luxReading = 0;

      const camera = new ProtectCamera(nvr as unknown as ProtectNvr, accessory as unknown as ProtectAccessory, projection as unknown as Camera);

      await settle();

      try {

        const lightSensor = accessory.getService(Service.LightSensor);

        assert.ok(lightSensor, "featureFlags.hasLuxCheck materializes the ambient LightSensor");
        assert.equal(await lightSensor.getCharacteristic(Characteristic.CurrentAmbientLightLevel).triggerGet(), 0.0001,
          "a genuine zero reading is floored to the HomeKit 0.0001 minimum, not reported as zero");
        assert.equal(projection.luxCalls.length, 1, "the init issued the lux query once");
      } finally {

        camera.cleanup();
        controller.abort();
      }
    });

    test("an unreachable camera skips the init query and re-maps -1 to 0.0001, never calling lux()", async () => {

      // Build unreachable: getLux short-circuits at if(!this.isReachable) return -1 (camera.ts:422) WITHOUT calling this.device.lux(), and the init re-maps -1 -> 0.0001
      // (camera.ts:477-479). The doomed query is never issued - the model's queried === false assertion, now real against the production path.
      const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { hasLuxCheck: true } });
      const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
      const { controller, nvr } = makeTestNvr({ store });

      nvr.client.connection.isHealthy = false;

      const accessory = makeTestAccessory("Test Camera", "uuid:74ACB9000001");
      const projection = new TestCameraProjection(cameraConfig.id, store);
      const camera = new ProtectCamera(nvr as unknown as ProtectNvr, accessory as unknown as ProtectAccessory, projection as unknown as Camera);

      await settle();

      try {

        const lightSensor = accessory.getService(Service.LightSensor);

        assert.ok(lightSensor, "featureFlags.hasLuxCheck materializes the ambient LightSensor even while unreachable");
        assert.equal(await lightSensor.getCharacteristic(Characteristic.CurrentAmbientLightLevel).triggerGet(), 0.0001,
          "the unreachable init re-maps the -1 no-reading sentinel to the 0.0001 floor");
        assert.equal(projection.luxCalls.length, 0, "the doomed query is never issued while unreachable - lux() is never called");
        assert.equal(await lightSensor.getCharacteristic(Characteristic.StatusActive).triggerGet(), false, "the StatusActive onGet reads the unreachable state");
      } finally {

        camera.cleanup();
        controller.abort();
      }
    });

    test("the 60-second poll updates a changed reading and publishes it on MQTT", async () => {

      // Construct with a known init reading (42), then change it (80) and fire the poll: getLux returns 80, the guard if((42 === 80) || (80 === -1)) is false, so the
      // poll updates CurrentAmbientLightLevel to 80 (camera.ts:463) and publishes "ambientlight" "80" (camera.ts:466). The publish fires ONLY in the poll path, never at
      // init.
      const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { hasLuxCheck: true } });
      const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
      const { controller, nvr } = makeTestNvr({ mqtt: true, store });
      const accessory = makeTestAccessory("Test Camera", "uuid:74ACB9000001");
      const projection = new TestCameraProjection(cameraConfig.id, store);

      projection.luxReading = 42;

      mock.timers.enable({ apis: ["setInterval"] });

      const camera = new ProtectCamera(nvr as unknown as ProtectNvr, accessory as unknown as ProtectAccessory, projection as unknown as Camera);

      await settle();

      try {

        const lightSensor = accessory.getService(Service.LightSensor);

        assert.ok(lightSensor, "featureFlags.hasLuxCheck materializes the ambient LightSensor");

        // Change the reading the next poll will read.
        projection.luxReading = 80;

        // Fire the captured construction-time poll, then settle() the async updateAmbientLight await-chain BEFORE asserting - the poll callback is () => void
        // updateAmbientLight(), so the tick fires it but does not drain its await on getLux / updateCharacteristic / publish.
        mock.timers.tick(60000);

        await settle();

        assert.equal(await lightSensor.getCharacteristic(Characteristic.CurrentAmbientLightLevel).triggerGet(), 80, "the poll updated the changed reading to 80");
        assert.ok(nvr.mqtt?.published.some((entry) => (entry.topic === (cameraConfig.mac + "/ambientlight")) && (entry.message === "80")),
          "the poll published the new reading on the device-scoped ambientlight topic");
      } finally {

        mock.timers.reset();
        camera.cleanup();
        controller.abort();
      }
    });

    test("the 60-second poll skips on a throw (the -1 sentinel), holding the prior reading and publishing nothing", async () => {

      // Construct with a known init reading (42), then make the next query throw: getLux's catch returns -1, the guard if((42 === -1) || (-1 === -1)) is true, so the
      // poll SKIPS - no updateCharacteristic, no publish. The prior reading is held.
      const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { hasLuxCheck: true } });
      const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
      const { controller, nvr } = makeTestNvr({ mqtt: true, store });
      const accessory = makeTestAccessory("Test Camera", "uuid:74ACB9000001");
      const projection = new TestCameraProjection(cameraConfig.id, store);

      projection.luxReading = 42;

      mock.timers.enable({ apis: ["setInterval"] });

      const camera = new ProtectCamera(nvr as unknown as ProtectNvr, accessory as unknown as ProtectAccessory, projection as unknown as Camera);

      await settle();

      try {

        const lightSensor = accessory.getService(Service.LightSensor);

        assert.ok(lightSensor, "featureFlags.hasLuxCheck materializes the ambient LightSensor");

        // The next query throws, so getLux returns the -1 no-reading sentinel.
        projection.luxRejection = new Error("The lux response did not contain a numeric illuminance reading.");

        mock.timers.tick(60000);

        await settle();

        assert.equal(await lightSensor.getCharacteristic(Characteristic.CurrentAmbientLightLevel).triggerGet(), 42,
          "a thrown reading skips the poll - the prior 42 holds");
        assert.equal(nvr.mqtt?.published.some((entry) => entry.topic === (cameraConfig.mac + "/ambientlight")), false, "the skipped poll published nothing");
      } finally {

        mock.timers.reset();
        camera.cleanup();
        controller.abort();
      }
    });
  });

  describe("the package-camera flashlight (camera-package.ts:164-251, the REAL doorbell-plus-package family)", () => {

    let doorbell: ProtectCamera | undefined;
    let harnessController: AbortController | undefined;

    afterEach(() => {

      doorbell?.cleanup();
      harnessController?.abort();
      doorbell = undefined;
      harnessController = undefined;
    });

    // Build a REAL doorbell-plus-package family (the package-defer-create.test.ts:61-72 seam) with the package channel PRESENT (G6_PRO_ENTRY_CHANNELS carries it), so the
    // package camera materializes immediately and its flashlight Lightbulb is configured. The HELD projection is the SAME instance the package camera shares
    // (doorbell.ts:418 passes the doorbell's own #device to createPackageCamera), so a test sets flashlightRejection and reads flashlightCalls on it directly. isDark is
    // threaded at construction (makeCameraConfig.isDark) so the dark-guard resolves deterministically.
    async function buildFlashlightFamily(options: { isDark: boolean }): Promise<{ projection: TestCameraProjection; store: TestStateStore }> {

      const cameraConfig = makeCameraConfig({ channels: G6_PRO_ENTRY_CHANNELS, featureFlags: { hasPackageCamera: true, isDoorbell: true }, isDark: options.isDark,
        name: "Front Door" });
      const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
      const { controller, nvr } = makeTestNvr({ store });
      const projection = new TestCameraProjection(cameraConfig.id, store);

      harnessController = controller;
      doorbell = new ProtectCamera(nvr as unknown as ProtectNvr, makeTestAccessory("Front Door", "uuid:74ACB9000001") as unknown as ProtectAccessory,
        projection as unknown as Camera);

      await settle();

      return { projection, store };
    }

    // Resolve the package camera's flashlight On characteristic, hard-asserting the package camera is live and the gated Lightbulb exists FIRST (Doorbell.PackageCamera.
    // Flashlight defaults TRUE, so no Enable string is needed; an absent service would let every value assertion pass vacuously).
    function flashlightOn(): TestCharacteristic {

      assert.ok(doorbell?.packageCamera, "the package camera instance is live post-settle");

      const packageAccessory = doorbell.packageCamera.accessory as unknown as TestAccessory;
      const flashlight = packageAccessory.getServiceById(Service.Lightbulb, ProtectReservedNames.LIGHTBULB_PACKAGE_FLASHLIGHT);

      assert.ok(flashlight, "Doorbell.PackageCamera.Flashlight materializes the package flashlight Lightbulb");

      return flashlight.getCharacteristic(Characteristic.On);
    }

    test("not dark: the On set issues no pulse and reflects off after the 50ms window", async () => {

      // The dark-guard (camera-package.ts:232-237): isDark false short-circuits with no pulse and a 50ms setTimeout that reflects On false.
      const { projection } = await buildFlashlightFamily({ isDark: false });

      mock.timers.enable({ apis: ["setTimeout"] });

      try {

        const onChar = flashlightOn();

        await onChar.triggerSet(true);

        // The command: no pulse issued (the dark-guard returned before activateFlashlight).
        assert.equal(projection.flashlightCalls.length, 0, "the not-dark guard issues no flashlight pulse");

        // The reflection: triggerSet caches On true, then the 50ms setTimeout fires updateCharacteristic(On, false). Tick the window and assert the reflect-off landed.
        mock.timers.tick(50);

        assert.equal(onChar.value, false, "the not-dark guard reflects the flashlight off after the 50ms window");
      } finally {

        mock.timers.reset();
      }
    });

    test("dark: the On set pulses, lights On, and the 20-second heartbeat re-pulses", async () => {

      // The happy path (camera-package.ts:198-243): isDark true pulses via the retry, reflects On true, and arms the 20-second heartbeat that re-pulses.
      const { projection } = await buildFlashlightFamily({ isDark: true });

      mock.timers.enable({ apis: ["setInterval"] });

      try {

        const onChar = flashlightOn();

        await onChar.triggerSet(true);

        // The command: exactly one pulse, threading the abort signal the retry binds (camera-package.ts:208).
        assert.equal(projection.flashlightCalls.length, 1, "the dark On set issues exactly one flashlight pulse");
        assert.ok(projection.flashlightCalls[0]?.opts?.signal, "the pulse threads the retry's abort signal");

        // The reflection: flashlightState is true, read through the On onGet (camera-package.ts:184) which is robust to triggerSet's value-cache.
        assert.equal(await onChar.triggerGet(), true, "a successful pulse lights the flashlight On");

        // The 20-second heartbeat (camera-package.ts:243) re-pulses; settle() drains the async () => void activateFlashlight() the tick fired.
        mock.timers.tick(20000);

        await settle();

        assert.equal(projection.flashlightCalls.length, 2, "the 20-second heartbeat re-pulses the flashlight");
      } finally {

        mock.timers.reset();
      }
    });

    test("the Off set clears the heartbeat and reflects off without issuing a command", async () => {

      // The off path (camera-package.ts:189-194): value false clears the timer, sets flashlightState false, and returns without any pulse.
      const { projection } = await buildFlashlightFamily({ isDark: true });

      const onChar = flashlightOn();

      await onChar.triggerSet(false);

      assert.equal(projection.flashlightCalls.length, 0, "the Off set issues no flashlight command");
      assert.equal(await onChar.triggerGet(), false, "the Off set reflects the flashlight off via flashlightState");
    });

    test("dark with a persistently rejecting pulse: the retry exhausts three attempts and reflects off", async () => {

      // The failure path (camera-package.ts:198-225, HJD-accepted ~2-second real cost): the retry attempts three times at a 1000ms node:timers/promises backoff
      // (un-reachable by mock.timers), the catch swallows the persistent rejection to lit = false, and the switch reflects off. mock.timers(setInterval) + reset()
      // discards the heartbeat interval line 243 arms even on failure, so no real interval leaks; we do NOT tick it (that would cost another ~2 seconds, and the
      // heartbeat-arm is already netted on the happy path).
      const { projection } = await buildFlashlightFamily({ isDark: true });

      mock.timers.enable({ apis: ["setInterval"] });

      try {

        const onChar = flashlightOn();

        projection.flashlightRejection = new Error("The flashlight pulse was rejected.");

        // This awaits the REAL retry to exhaustion (~2 seconds of node:timers/promises backoff); activateFlashlight's own try/catch swallows the rejection, so triggerSet
        // resolves rather than throwing.
        await onChar.triggerSet(true);

        assert.equal(projection.flashlightCalls.length, 3, "the retry exhausts its full three-attempt budget against a persistent rejection");
        assert.equal(await onChar.triggerGet(), false, "an exhausted pulse reflects the flashlight off via flashlightState");
      } finally {

        mock.timers.reset();
      }
    });
  });
});
