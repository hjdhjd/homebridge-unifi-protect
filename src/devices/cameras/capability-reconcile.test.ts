/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * capability-reconcile.test.ts: The camera capability-reconcile chokepoint end to end - a controller that finishes reporting a camera's hardware capabilities AFTER
 * adoption reflects them live, without a Homebridge restart. The capabilities this suite exercises are the ambient light sensor (gated on featureFlags.hasLuxCheck plus
 * the Device.AmbientLightSensor user toggle), the UniFi Access lock (gated on accessDeviceMetadata.featureFlags.supportUnlock plus the UniFi.Access.Lock user toggle),
 * the night vision dimmer (gated on featureFlags.hasInfrared and hasIcrSensitivity plus the Device.NightVision.Dimmer user toggle), tamper detection (gated on
 * featureFlags.hasTamperDetection plus the smartDetectSettings.enableTamperDetection controller setting), two-way audio (gated on featureFlags.hasSpeaker, which
 * rebuilds the streaming controller in place rather than toggling a HomeKit service), the smart-detect contact sensors (gated on featureFlags.hasSmartDetect plus the
 * Motion.SmartDetect and Motion.SmartDetect.ObjectSensors user toggles, with the controller-reported per-type set reconciling in both directions beneath them), and
 * HomeKit Secure Video eligibility (gated on featureFlags.hasMotionDetection, the controller's motion report, a gain composing the motion sensor and the recording arm
 * in place, a withdrawal narrated once, and the controller's all-false drain frame narrated not at all), with the package camera's controller following its parent's
 * through the same pass.
 *
 * The suite drives a REAL constructed ProtectCamera against the camera-construction harness doubles (the faithful store, the read-through Camera projection, the stub
 * streaming-delegate factory) and exercises the capability observers and the reconcileCapabilities chokepoint they drive. Each scenario is behavior-FIRST - a
 * structural-sharing push followed by a settle and an assertion on the HomeKit surface the reconcile produced (the LightSensor / LockMechanism service) or did not - and
 * the scenarios that matter most tell causes apart precisely: the self-heal proves the OBSERVER (remove it and the late capability never appears), and the restart
 * re-wire proves the wiring runs on every configure (restore the if(existing) early-return and a cached-but-unwired sensor is never re-wired - no controller lux read
 * occurs). The wake-attribution and leak scenarios are the selector-correctness and no-leaked-loop controls.
 *
 * Every capability suite shares the function-form predicate's asymmetry (additive-eager on the capability, absolutely-pruning on the toggle). The Access lock and the
 * night vision dimmer add an establishment-only push on top: a live observe reconcile over an existing service never re-pushes the display (so an in-flight unlock or
 * night-vision command is never stomped), while create and the construct path (adoption or restart) do. The lock stamps SECURED; the dimmer pushes On / Brightness from
 * the device's irLedMode reading. Each suite's distinguishing mutations are traced in its tests' comments - the predicate's hasService and toggle clauses, the
 * early-return removal (lock only), and the (transition === "attached") || (source === "construct") establishment condition.
 */
import type { Camera, ProtectCameraConfig } from "unifi-protect";
import { Characteristic, Service, TestStateStore, makeProtectState, makeTestAccessory } from "../../testing.helpers.ts";
import { G2_PRO_CHANNELS, G6_PRO_ENTRY_CHANNELS } from "../../camera.fixtures.ts";
import { SAVE_WINDOW_MS, makeTestNvr } from "../../nvr/testing.helpers.ts";
import type { TestAccessory, TestService } from "../../testing.helpers.ts";
import { TestCameraProjection, makeCameraConfig } from "../testing.helpers.ts";
import { after, describe, test } from "node:test";
import { formatLogEntry, logCount, settle } from "homebridge-plugin-utils/testing";
import type { ObserverWakePayload } from "../../diagnostics.ts";
import type { ProtectAccessory } from "../../types.ts";
import { ProtectCamera } from "./camera.ts";
import type { ProtectNvr } from "../../nvr/nvr.ts";
import { ProtectReservedNames } from "../../types.ts";
import type { TestLogEntry } from "homebridge-plugin-utils/testing";
import type { TestProtectNvr } from "../../nvr/testing.helpers.ts";
import assert from "node:assert/strict";
import diagnosticsChannel from "node:diagnostics_channel";

// Every harness controller this file opens, aborted once at the end so no observe loop outlives the suite. The constructions are per-test and numerous, so the capture
// rides the construction itself rather than each test's own teardown.
const controllers: AbortController[] = [];

after(() => {

  for(const controller of controllers) {

    controller.abort();
  }
});

// Build the harness NVR / platform pair the way every test here does, capturing its lifetime controller for the drain above. The signature passes through makeTestNvr's
// own, so a call site reads exactly as a direct build and destructures whatever it needs.
function buildTestNvr(options: Parameters<typeof makeTestNvr>[0]): ReturnType<typeof makeTestNvr> {

  const built = makeTestNvr(options);

  controllers.push(built.controller);

  return built;
}

// Construct a real ProtectCamera, with the casts confined to this one construction call - the instance under test is the production class and its real configure path.
function construct(nvr: TestProtectNvr, accessory: TestAccessory, projection: TestCameraProjection): ProtectCamera {

  return new ProtectCamera(nvr as unknown as ProtectNvr, accessory as unknown as ProtectAccessory, projection as unknown as Camera);
}

// The count of bare LightSensor services on the accessory - the check for "exactly one ambient light sensor", which proves the reconcile re-run never sprouted a
// duplicate (acquireService is get-or-create, so a re-run returns the existing instance).
function lightSensorCount(accessory: TestAccessory): number {

  return accessory.services.filter((service) => service.type === Service.LightSensor).length;
}

// The camera's UniFi Access lock - the LOCK_ACCESS-subtyped LockMechanism service. ProtectReservedNames.LOCK_ACCESS subtypes it, so the lookup is getServiceById (the
// subtyped twin of getService), exactly as production acquires it.
function accessLock(accessory: TestAccessory): TestService | undefined {

  return accessory.getServiceById(Service.LockMechanism, ProtectReservedNames.LOCK_ACCESS);
}

// The count of LOCK_ACCESS LockMechanism services - the check for "exactly one lock", which proves a reconcile re-run never sprouted a duplicate.
function accessLockCount(accessory: TestAccessory): number {

  return accessory.services.filter((service) => (service.type === Service.LockMechanism) && (service.subtype === ProtectReservedNames.LOCK_ACCESS)).length;
}

// The camera's night vision dimmer - the LIGHTBULB_NIGHTVISION-subtyped Lightbulb service. ProtectReservedNames.LIGHTBULB_NIGHTVISION subtypes it, so the lookup is
// getServiceById (the subtyped twin of getService), exactly as production acquires it.
function nightVisionDimmer(accessory: TestAccessory): TestService | undefined {

  return accessory.getServiceById(Service.Lightbulb, ProtectReservedNames.LIGHTBULB_NIGHTVISION);
}

// The count of LIGHTBULB_NIGHTVISION Lightbulb services - the check for "exactly one dimmer", which proves a reconcile re-run never sprouted a duplicate.
function nightVisionDimmerCount(accessory: TestAccessory): number {

  return accessory.services.filter((service) => (service.type === Service.Lightbulb) && (service.subtype === ProtectReservedNames.LIGHTBULB_NIGHTVISION)).length;
}

// The camera's tamper-status host - the StatusTampered characteristic lives on the un-subtyped MotionSensor, so the lookup is getService, exactly as
// configureTamperDetection acquires it. The minimal camera is HKSV-capable, so configureMotionSensor builds the motion service at construction.
function motionSensor(accessory: TestAccessory): TestService | undefined {

  return accessory.getService(Service.MotionSensor);
}

// Confine the lone partial-config cast here, mirroring camera-onsets.test.ts: pushCameraPatch's patch is a Partial of the full wire record, and the value-selector dedup
// test moves exactly one nested accessDeviceMetadata sibling field, whose minimal shape is not the full wire type, so the loose shape is cast once here.
function cameraPatch(patch: Record<string, unknown>): Partial<ProtectCameraConfig> {

  return patch as Partial<ProtectCameraConfig>;
}

// A smart-detect object sensor, looked up BY ITS OWN DETECTION TYPE - the per-type subtype production acquires it under. Per-type lookups, never an aggregate count: a
// count cannot tell a per-type fan-out apart from one service appearing, so it would pass against a fold that materialized a single sensor.
function smartDetectSensor(accessory: TestAccessory, smartDetectType: string): TestService | undefined {

  return accessory.getServiceById(Service.ContactSensor, ProtectReservedNames.CONTACT_MOTION_SMARTDETECT + "." + smartDetectType);
}

// A license-plate contact sensor, looked up by its plate. The plate subtypes carry their own reserved prefix, so they never collide with the per-type subtypes above.
function plateSensor(accessory: TestAccessory, plate: string): TestService | undefined {

  return accessory.getServiceById(Service.ContactSensor, ProtectReservedNames.CONTACT_MOTION_SMARTDETECT_LICENSE + "." + plate);
}

describe("the camera capability reconcile - the ambient light sensor pilot", () => {

  test("a late hasLuxCheck creates the ambient light sensor live, without a restart (self-heal, fails without the observer)", async () => {

    // A camera the controller adopts WITHOUT the lux capability: the gate's early-return leaves no LightSensor at adoption.
    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { hasLuxCheck: false } });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { nvr } = buildTestNvr({ store });
    const accessory = makeTestAccessory("Test Camera", "uuid:capability-reconcile-1");
    const camera = construct(nvr, accessory, new TestCameraProjection(cameraConfig.id, store));

    await settle();

    try {

      // The vacuity guard: the sensor is genuinely absent before the push, so the post-push presence is a real transition and not a pre-existing service.
      assert.equal(accessory.getService(Service.LightSensor), undefined, "no ambient light sensor exists before the controller reports the capability");

      // The controller finishes provisioning the camera and now reports the lux capability.
      store.pushCameraFeatureFlags(cameraConfig.id, { hasLuxCheck: true });

      await settle();

      // The featureFlags observer drove reconcileCapabilities, which created the sensor live. Removing the observer (the featureFlags observer in spawnCameraObservers)
      // leaves this RED - the push would wake nothing and the sensor would stay absent.
      assert.ok(accessory.getService(Service.LightSensor), "the late capability created the ambient light sensor without a restart");
      assert.equal(lightSensorCount(accessory), 1, "exactly one ambient light sensor exists after the self-heal");
    } finally {

      camera.cleanup();
    }
  });

  test("a Homebridge restart re-wires the cached-but-unwired ambient light sensor (restart re-wire, fails without the re-wired controller read)", async () => {

    // A camera the controller reports WITH the lux capability. We simulate a Homebridge restart, which restores the cached accessory's LightSensor service - present with
    // its characteristics - but never its runtime onGet handlers or its poll timer, neither of which HAP serializes. This is the present-but-unwired state the first
    // configure after a restart runs against, and the case the removed "if(existing) return true" guard mistook for an already-wired sensor.
    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { hasLuxCheck: true } });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { nvr } = buildTestNvr({ store });
    const accessory = makeTestAccessory("Test Camera", "uuid:capability-reconcile-6");

    // Pre-seed the restored service: present, carrying CurrentAmbientLightLevel and StatusActive, but with no onGet handler bound and no interval registered.
    const restored = accessory.addService(Service.LightSensor, "Test Camera");

    restored.getCharacteristic(Characteristic.CurrentAmbientLightLevel);
    restored.getCharacteristic(Characteristic.StatusActive);

    // The vacuity guard, inverted: the sensor is genuinely PRESENT before construction, so a post-construction controller read proves a RE-wire of the restored
    // service, not a first creation.
    assert.ok(accessory.getService(Service.LightSensor), "the cached LightSensor service is present before construction, exactly as a Homebridge restart restores it");

    const projection = new TestCameraProjection(cameraConfig.id, store);
    const camera = construct(nvr, accessory, projection);

    await settle();

    try {

      // The wiring re-ran against the restored service: configureAmbientLightSensor's initial getLux issued a controller lux read, the observable proxy for re-binding
      // its onGet handlers and re-registering the 60-second poll. Restoring the "if(existing) return true" guard leaves this RED - the present service short-circuits
      // the wiring and no read occurs (luxCalls === 0), which is exactly the restart freeze this fix removes, and a RED for the absent read rather than a crash.
      assert.ok(projection.luxCalls.length >= 1,
        "the wiring re-ran against the restored service, re-issuing the controller lux read that re-establishes the handlers and poll");
      assert.equal(lightSensorCount(accessory), 1, "the re-wire reused the restored service - no duplicate ambient light sensor");
    } finally {

      camera.cleanup();
    }
  });

  test("an ambient light sensor created without a name of its own carries the camera's name", async () => {

    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { hasLuxCheck: true } });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { nvr } = buildTestNvr({ store });
    const accessory = makeTestAccessory("Test Camera", "uuid:capability-reconcile-name");
    const camera = construct(nvr, accessory, new TestCameraProjection(cameraConfig.id, store));

    await settle();

    try {

      // The capability's validate wrapper defaults the name to its host's accessory name, so the sensor it creates carries the camera's name.
      assert.equal(accessory.getService(Service.LightSensor)?.displayName, "Test Camera", "the ambient light sensor carries the camera's name");
    } finally {

      camera.cleanup();
    }
  });

  test("a withdrawn hasLuxCheck never prunes the ambient light sensor (subtractive-conservative)", async () => {

    // A camera adopted WITH the lux capability, then a controller that stops reporting it. The capability half of the gate is additive-eager / subtractive-conservative
    // (the user toggle stays on here): the reconcile creates on true and never prunes on false, so a flag that vanishes (a transient bootstrap blip) does not strip a
    // working sensor.
    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { hasLuxCheck: true } });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { nvr } = buildTestNvr({ store });
    const accessory = makeTestAccessory("Test Camera", "uuid:capability-reconcile-3");
    const camera = construct(nvr, accessory, new TestCameraProjection(cameraConfig.id, store));

    await settle();

    try {

      assert.ok(accessory.getService(Service.LightSensor), "the ambient light sensor was created at adoption");

      // The controller stops reporting the capability.
      store.pushCameraFeatureFlags(cameraConfig.id, { hasLuxCheck: false });

      await settle();

      // The capabilityGate conservative clause keeps the existing sensor through the transient hasLuxCheck-false while the toggle stays on - the sensor is retained.
      assert.ok(accessory.getService(Service.LightSensor), "the withdrawn capability never pruned the ambient light sensor");
      assert.equal(lightSensorCount(accessory), 1, "the sensor is retained, not duplicated, across the withdrawal");
    } finally {

      camera.cleanup();
    }
  });

  test("the feature option off creates no ambient light sensor even with hasLuxCheck (the toggle half, fresh, fails without the toggle clause)", async () => {

    // The lux capability is present, but the user toggle is off. Both halves must hold to CREATE, so no sensor appears.
    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { hasLuxCheck: true } });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { nvr } = buildTestNvr({ store, userOptions: ["Disable.Device.AmbientLightSensor"] });
    const accessory = makeTestAccessory("Test Camera", "uuid:capability-reconcile-7");
    const camera = construct(nvr, accessory, new TestCameraProjection(cameraConfig.id, store));

    await settle();

    try {

      // The toggle off vetoes the sensor even though hasLuxCheck is true. Dropping the hasFeature("Device.AmbientLightSensor") && half leaves this RED - the sensor
      // appears (the self-heal test is the positive control proving hasLuxCheck alone WOULD create it).
      assert.equal(accessory.getService(Service.LightSensor), undefined, "the disabled feature option creates no ambient light sensor despite hasLuxCheck");
    } finally {

      camera.cleanup();
    }
  });

  test("the feature option off prunes an existing ambient light sensor even when hasLuxCheck is false (the old-vs-new divergence; pins the early-return removal and " +
    "the toggle half)", async () => {

    // Pre-seed a cached LightSensor BEFORE construction - a restart whose toggle was edited off before the controller re-reports the capability. The camera adopts with
    // hasLuxCheck FALSE (the makeCameraConfig default) AND the option disabled. This is the ONLY cell where the toggle-absolute gate removes the stale pre-seeded sensor
    // that a capability-first skip would leave in place.
    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { nvr } = buildTestNvr({ store, userOptions: ["Disable.Device.AmbientLightSensor"] });
    const accessory = makeTestAccessory("Test Camera", "uuid:capability-reconcile-8");

    accessory.addService(Service.LightSensor, "Test Camera");

    assert.ok(accessory.getService(Service.LightSensor), "a cached ambient light sensor is present before construction");

    const camera = construct(nvr, accessory, new TestCameraProjection(cameraConfig.id, store));

    await settle();

    try {

      // The folded gate prunes on toggle-off even with hasLuxCheck false: hasFeature is false, so validService removes the present sensor. Introducing an
      // if(!hasLuxCheck) return false early-return leaves the sensor un-pruned (the early-return fires before validService) -> RED; dropping the hasFeature && half makes
      // the predicate (hasService || hasLuxCheck) true and keeps the sensor -> RED. This single test pins both the early-return removal and the toggle half.
      assert.equal(accessory.getService(Service.LightSensor), undefined,
        "the disabled feature option pruned the cached ambient light sensor even with hasLuxCheck false");
    } finally {

      camera.cleanup();
    }
  });

  test("a featureFlags push wakes exactly the capability observer, attributed to this accessory (wake attribution)", async () => {

    // A plain camera (isDoorbell false): a hasLuxCheck push changes the featureFlags object reference but not the isDoorbell value, so the value-selecting isDoorbell
    // observer dedups and only the whole-slice capability observer wakes.
    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { hasLuxCheck: false } });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { nvr } = buildTestNvr({ store });
    const accessory = makeTestAccessory("Test Camera", "uuid:capability-reconcile-4");
    const camera = construct(nvr, accessory, new TestCameraProjection(cameraConfig.id, store));

    await settle();

    const wakes: ObserverWakePayload[] = [];
    const onWake = (message: unknown): void => { wakes.push(message as ObserverWakePayload); };

    diagnosticsChannel.subscribe("hbup:observer:wake", onWake);

    try {

      store.pushCameraFeatureFlags(cameraConfig.id, { hasLuxCheck: true });

      await settle();

      assert.equal(wakes.length, 1, "exactly one observer woke for the single-slice featureFlags push");
      assert.deepEqual(wakes[0], { accessoryId: accessory.UUID, key: "camera.featureFlags" },
        "the wake is the capability observer, attributed to this accessory");
    } finally {

      diagnosticsChannel.unsubscribe("hbup:observer:wake", onWake);
      camera.cleanup();
    }
  });

  test("the capability observer unwinds at cleanup - a later featureFlags push wakes nothing (leak)", async () => {

    // The no-leaked-loop control: after cleanup tears the camera down, the capability observer is gone and a featureFlags push wakes nothing.
    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { hasLuxCheck: true } });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { nvr } = buildTestNvr({ store });
    const accessory = makeTestAccessory("Test Camera", "uuid:capability-reconcile-5");
    const camera = construct(nvr, accessory, new TestCameraProjection(cameraConfig.id, store));

    await settle();

    // Tear the camera down and let the observe loops drain and deregister.
    camera.cleanup();

    await settle();

    const wakes: ObserverWakePayload[] = [];
    const onWake = (message: unknown): void => { wakes.push(message as ObserverWakePayload); };

    diagnosticsChannel.subscribe("hbup:observer:wake", onWake);

    try {

      assert.equal(store.observerCount, 0, "every observer deregistered through cleanup");

      store.pushCameraFeatureFlags(cameraConfig.id, { hasLuxCheck: false });

      await settle();

      assert.equal(wakes.length, 0, "a featureFlags push after cleanup wakes nothing");
    } finally {

      diagnosticsChannel.unsubscribe("hbup:observer:wake", onWake);
    }
  });

  test("a teardown that lands mid-read writes neither the characteristic nor MQTT (the post-await lifetime check)", async () => {

    // The poll's continuation is suspended at the controller read when teardown arrives: the registry's drain stops the NEXT fire, but this fire is already past its
    // timer, so only the capability's own signal check can stop it from writing to a camera that is gone. The arrangement is exact - advance the clock through the
    // interval (which runs the callback synchronously up to its first await), tear the camera down in the SAME synchronous region, and only then settle so the
    // continuation resumes.
    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { hasLuxCheck: true } });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { clock, nvr } = buildTestNvr({ mqtt: true, store });
    const accessory = makeTestAccessory("Test Camera", "uuid:capability-reconcile-9");
    const projection = new TestCameraProjection(cameraConfig.id, store);

    projection.luxReading = 42;

    // The reconcile arms the poll's interval on the harness clock, so the poll fires on an advance of 60000 rather than on the wall clock, the camera-best-effort idiom.
    const camera = construct(nvr, accessory, projection);

    await settle();

    try {

      const lightSensor = accessory.getService(Service.LightSensor);

      assert.ok(lightSensor, "the lux capability created the ambient light sensor");

      // The vacuity guard: the init read stored 42, so a post-teardown write of the changed reading below would be visible as a real change.
      assert.equal(await lightSensor.getCharacteristic(Characteristic.CurrentAmbientLightLevel).triggerGet(), 42, "the init read stored the 42 reading");

      // The next read resolves 80, so a continuation that survives teardown would write 80 and publish it.
      projection.luxReading = 80;

      const publishedBaseline = nvr.mqtt?.published.length ?? 0;

      // Fire the poll and tear the camera down before the read resolves - the callback is () => void updateAmbientLight(), so the advance leaves it suspended at the
      // await.
      clock.advance(60000);
      camera.cleanup();

      await settle();

      // Deleting the if(this.signal.aborted) return guard leaves the resumed continuation writing 80 and publishing it -> both assertions RED.
      assert.equal(await lightSensor.getCharacteristic(Characteristic.CurrentAmbientLightLevel).triggerGet(), 42,
        "the continuation that resumed after teardown never wrote the new reading");
      assert.equal(nvr.mqtt?.published.length, publishedBaseline, "the continuation that resumed after teardown published nothing");
    } finally {

      camera.cleanup();
    }
  });
});

describe("the camera capability reconcile - the UniFi Access lock", () => {

  test("a late supportUnlock creates the Access lock live and reads SECURED, without a restart (self-heal, fails without the observer)", async () => {

    // A camera adopted WITHOUT a paired Access reader: no accessDeviceMetadata, so the gate creates no lock at adoption.
    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { nvr } = buildTestNvr({ store });
    const accessory = makeTestAccessory("Test Camera", "uuid:access-lock-1");
    const camera = construct(nvr, accessory, new TestCameraProjection(cameraConfig.id, store));

    await settle();

    try {

      // The vacuity guard: genuinely no lock before the push, so the post-push presence is a real transition.
      assert.equal(accessLock(accessory), undefined, "no Access lock exists before the controller reports the unlock capability");

      // The paired reader finishes reporting; supportUnlock goes from absent to true.
      store.pushCameraSupportUnlock(cameraConfig.id, true);

      await settle();

      // The supportUnlock observer drove reconcileCapabilities("observe"), which created the lock and (an attached transition) stamped it SECURED. Removing the
      // supportUnlock observer in spawnCameraObservers leaves this RED - the push wakes nothing (the featureFlags observer dedups, since featureFlags is unchanged) and
      // the lock stays absent.
      const lock = accessLock(accessory);

      assert.ok(lock, "the late supportUnlock created the Access lock without a restart");
      assert.equal(accessLockCount(accessory), 1, "exactly one Access lock exists after the self-heal");
      assert.equal(lock.getCharacteristic(Characteristic.LockCurrentState).value, Characteristic.LockCurrentState.SECURED,
        "the self-healed lock current state reads SECURED");
      assert.equal(lock.getCharacteristic(Characteristic.LockTargetState).value, Characteristic.LockTargetState.SECURED,
        "the self-healed lock target state reads SECURED");
    } finally {

      camera.cleanup();
    }
  });

  test("a withdrawn supportUnlock never prunes the Access lock (subtractive-conservative, fails without the hasService clause)", async () => {

    // A camera adopted WITH the unlock capability, then a controller that stops reporting it. The capability half is additive-eager / subtractive-conservative: it
    // creates on true and never prunes on false (a transient incomplete bootstrap must not strip a working lock).
    const cameraConfig = makeCameraConfig({ accessDeviceMetadata: { featureFlags: { supportUnlock: true } }, channels: G2_PRO_CHANNELS });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { nvr } = buildTestNvr({ store });
    const accessory = makeTestAccessory("Test Camera", "uuid:access-lock-2");
    const camera = construct(nvr, accessory, new TestCameraProjection(cameraConfig.id, store));

    await settle();

    try {

      assert.ok(accessLock(accessory), "the Access lock was created at adoption");

      // The controller stops reporting the capability.
      store.pushCameraSupportUnlock(cameraConfig.id, false);

      await settle();

      // The gate's hasService || clause keeps a present lock regardless of the false. Replacing the predicate with Boolean(supportsUnlock) leaves this RED - the false
      // prunes the working lock.
      assert.ok(accessLock(accessory), "the withdrawn capability never pruned the existing Access lock");
      assert.equal(accessLockCount(accessory), 1, "the lock is retained, not duplicated, across the withdrawal");
    } finally {

      camera.cleanup();
    }
  });

  test("the feature option off creates no lock even with supportUnlock (the toggle half, fresh, fails without the toggle clause)", async () => {

    // The capability is present, but the user toggle is off. Both halves must hold to CREATE, so no lock appears.
    const cameraConfig = makeCameraConfig({ accessDeviceMetadata: { featureFlags: { supportUnlock: true } }, channels: G2_PRO_CHANNELS });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { nvr } = buildTestNvr({ store, userOptions: ["Disable.UniFi.Access.Lock"] });
    const accessory = makeTestAccessory("Test Camera", "uuid:access-lock-3");
    const camera = construct(nvr, accessory, new TestCameraProjection(cameraConfig.id, store));

    await settle();

    try {

      // The toggle off vetoes the lock even though supportUnlock is true. Dropping the hasFeature("UniFi.Access.Lock") && half leaves this RED - the lock appears (the
      // self-heal test is the positive control proving supportUnlock alone WOULD create it).
      assert.equal(accessLock(accessory), undefined, "the disabled feature option creates no Access lock despite supportUnlock");
    } finally {

      camera.cleanup();
    }
  });

  test("the feature option off prunes an existing lock even when supportUnlock is false (the old-vs-new divergence; pins the early-return removal and the toggle half)",
    async () => {

      // Pre-seed a cached lock BEFORE construction - a restart whose toggle was edited off before the controller re-reports the capability. The camera adopts with
      // supportUnlock FALSE (no accessDeviceMetadata) AND the option disabled. This is the ONLY cell where the toggle-absolute gate removes the stale pre-seeded lock
      // that a capability-first skip would leave in place.
      const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS });
      const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
      const { nvr } = buildTestNvr({ store, userOptions: ["Disable.UniFi.Access.Lock"] });
      const accessory = makeTestAccessory("Test Camera", "uuid:access-lock-4");

      accessory.addService(Service.LockMechanism, "Test Camera", ProtectReservedNames.LOCK_ACCESS);

      assert.ok(accessLock(accessory), "a cached Access lock is present before construction");

      const camera = construct(nvr, accessory, new TestCameraProjection(cameraConfig.id, store));

      await settle();

      try {

        // The folded gate prunes on toggle-off even with supportUnlock false: hasFeature is false, so validService removes the present lock. Introducing an
        // if(!supportUnlock) return false early-return leaves the lock un-pruned (the early-return fires before validService) -> RED; dropping the hasFeature && half
        // makes the predicate (hasService || supportsUnlock) true and keeps the lock -> RED. This single test pins both the early-return removal and the toggle half.
        assert.equal(accessLock(accessory), undefined, "the disabled feature option pruned the cached lock even with supportUnlock false");
      } finally {

        camera.cleanup();
      }
    });

  test("a freshly created Access lock reads SECURED (the establishment stamp, pinned against the null default)", async () => {

    const cameraConfig = makeCameraConfig({ accessDeviceMetadata: { featureFlags: { supportUnlock: true } }, channels: G2_PRO_CHANNELS });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { nvr } = buildTestNvr({ store });
    const accessory = makeTestAccessory("Test Camera", "uuid:access-lock-5");
    const camera = construct(nvr, accessory, new TestCameraProjection(cameraConfig.id, store));

    await settle();

    try {

      const lock = accessLock(accessory);

      assert.ok(lock, "the supportUnlock capability plus the default-on option created the Access lock at adoption");

      // The establishment stamp wrote SECURED to both characteristics. Removing the stamp leaves the double's value at its null default - null !== SECURED - so this is
      // RED, which is exactly why the SECURED assertion tells apart SECURED-vs-null rather than SECURED-vs-UNSECURED.
      assert.equal(lock.getCharacteristic(Characteristic.LockCurrentState).value, Characteristic.LockCurrentState.SECURED,
        "the lock current state reads SECURED at creation");
      assert.equal(lock.getCharacteristic(Characteristic.LockTargetState).value, Characteristic.LockTargetState.SECURED,
        "the lock target state reads SECURED at creation");
    } finally {

      camera.cleanup();
    }
  });

  test("a live observe reconcile over an existing lock never re-stamps the display (Fix C2, fails without the establishment condition)", async () => {

    const cameraConfig = makeCameraConfig({ accessDeviceMetadata: { featureFlags: { supportUnlock: true } }, channels: G2_PRO_CHANNELS });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { nvr } = buildTestNvr({ store });
    const accessory = makeTestAccessory("Test Camera", "uuid:access-lock-6");
    const camera = construct(nvr, accessory, new TestCameraProjection(cameraConfig.id, store));

    await settle();

    try {

      const lock = accessLock(accessory);

      assert.ok(lock, "the Access lock exists before the observe reconcile");

      // Simulate any in-flight unlock state: drive both characteristics to UNSECURED directly (a status push, not the onSet). This stands in for the command-flight
      // window (optimistic UNSECURED, no relock timer yet armed) and the re-lock window uniformly.
      lock.updateCharacteristic(Characteristic.LockCurrentState, Characteristic.LockCurrentState.UNSECURED);
      lock.updateCharacteristic(Characteristic.LockTargetState, Characteristic.LockTargetState.UNSECURED);

      // Trigger a LIVE observe reconcile through the featureFlags observer (a re-push of the same supportUnlock would dedup under the value selector and wake nothing).
      // The observe path reconciles WHICH services exist but, with the lock already present and source "observe", never re-stamps the display.
      store.pushCameraFeatureFlags(cameraConfig.id, { hasLuxCheck: true });

      await settle();

      // The display is untouched - still UNSECURED. Making the stamp unconditional (dropping (transition === "attached") || (source === "construct")) leaves the observe
      // reconcile re-stamping SECURED -> RED, which would truncate a momentary user unlock.
      assert.equal(lock.getCharacteristic(Characteristic.LockCurrentState).value, Characteristic.LockCurrentState.UNSECURED,
        "the observe reconcile left the lock current state UNSECURED");
      assert.equal(lock.getCharacteristic(Characteristic.LockTargetState).value, Characteristic.LockTargetState.UNSECURED,
        "the observe reconcile left the lock target state UNSECURED");
    } finally {

      camera.cleanup();
    }
  });

  test("a configure against a restart-restored lock recovers SECURED and re-binds the unlock onSet (the construct stamp + wire-every-configure)", async () => {

    const cameraConfig = makeCameraConfig({ accessDeviceMetadata: { featureFlags: { supportUnlock: true } }, channels: G2_PRO_CHANNELS });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { nvr } = buildTestNvr({ store });
    const accessory = makeTestAccessory("Test Camera", "uuid:access-lock-7");

    // Pre-seed the restored service: present, both characteristics at UNSECURED, with no onSet bound and no relock timer - the state a Homebridge restart restores (HAP
    // serializes neither the runtime handler nor the resting display).
    const restored = accessory.addService(Service.LockMechanism, "Test Camera", ProtectReservedNames.LOCK_ACCESS);

    restored.updateCharacteristic(Characteristic.LockCurrentState, Characteristic.LockCurrentState.UNSECURED);
    restored.updateCharacteristic(Characteristic.LockTargetState, Characteristic.LockTargetState.UNSECURED);

    assert.equal(restored.getCharacteristic(Characteristic.LockCurrentState).value, Characteristic.LockCurrentState.UNSECURED,
      "the cached lock reads UNSECURED before construction");

    const projection = new TestCameraProjection(cameraConfig.id, store);
    const camera = construct(nvr, accessory, projection);

    await settle();

    try {

      // (a) The construct path stamped SECURED on the EXISTING lock (source === "construct" with the lock kept). Dropping the source === "construct" half leaves the
      // cached lock un-stamped - the gate answers kept, not attached - and it stays UNSECURED -> RED.
      assert.equal(restored.getCharacteristic(Characteristic.LockCurrentState).value, Characteristic.LockCurrentState.SECURED,
        "the construct reconcile recovered the lock current state to SECURED");
      assert.equal(restored.getCharacteristic(Characteristic.LockTargetState).value, Characteristic.LockTargetState.SECURED,
        "the construct reconcile recovered the lock target state to SECURED");

      // (b) The onSet was re-bound on this configure (the wire-every-configure rule - the transition does NOT gate the wiring). Driving the LockTargetState onSet to
      // UNSECURED dispatches exactly one unlock command. Re-introducing an if(existing) return true guard before the onSet bind leaves nothing recorded -> RED.
      await restored.getCharacteristic(Characteristic.LockTargetState).triggerSet(Characteristic.LockTargetState.UNSECURED);

      assert.equal(projection.unlockCalls.length, 1, "the re-bound onSet dispatched exactly one unlock when driven to UNSECURED");

      // (c) The success path reported the momentary unlock: current state mirrors UNSECURED so the Home app lands on "Unlocked" rather than a transition that never
      // completes, and the auto re-lock timer restores SECURED afterwards (the re-lock is armed on the harness clock, which this row never advances, so it never fires
      // before this read).
      assert.equal(restored.getCharacteristic(Characteristic.LockCurrentState).value, Characteristic.LockCurrentState.UNSECURED,
        "the successful unlock pushed the momentary UNSECURED current state");
    } finally {

      camera.cleanup();
    }
  });

  test("an unrelated accessDeviceMetadata change does not wake the supportUnlock observer (value-selector dedup vs a whole-object selector)", async () => {

    const cameraConfig = makeCameraConfig({ accessDeviceMetadata: { featureFlags: { supportUnlock: true } }, channels: G2_PRO_CHANNELS });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { nvr } = buildTestNvr({ store });
    const accessory = makeTestAccessory("Test Camera", "uuid:access-lock-8");
    const camera = construct(nvr, accessory, new TestCameraProjection(cameraConfig.id, store));

    await settle();

    const wakes: ObserverWakePayload[] = [];
    const onWake = (message: unknown): void => { wakes.push(message as ObserverWakePayload); };

    diagnosticsChannel.subscribe("hbup:observer:wake", onWake);

    try {

      // Replace accessDeviceMetadata with a NEW object whose supportUnlock is UNCHANGED (still true) but a sibling field (micVolume) differs. The new object reference
      // would wake a whole-accessDeviceMetadata selector, but the value selector reads only supportUnlock and dedups on the unchanged true.
      store.pushCameraPatch(cameraConfig.id, cameraPatch({ accessDeviceMetadata: { featureFlags: { supportUnlock: true }, micVolume: 50 } }));

      await settle();

      assert.equal(wakes.filter((wake) => wake.key === "camera.supportUnlock").length, 0,
        "the value selector dedups the unchanged supportUnlock - the sibling-field change wakes no Access observer");
    } finally {

      diagnosticsChannel.unsubscribe("hbup:observer:wake", onWake);
      camera.cleanup();
    }
  });

  test("a supportUnlock push wakes exactly the supportUnlock observer, attributed to this accessory (wake attribution)", async () => {

    // A camera with no paired reader: a supportUnlock push (absent -> true) changes accessDeviceMetadata but not the camera's own featureFlags, so only the
    // value-selecting supportUnlock observer wakes.
    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { nvr } = buildTestNvr({ store });
    const accessory = makeTestAccessory("Test Camera", "uuid:access-lock-9");
    const camera = construct(nvr, accessory, new TestCameraProjection(cameraConfig.id, store));

    await settle();

    const wakes: ObserverWakePayload[] = [];
    const onWake = (message: unknown): void => { wakes.push(message as ObserverWakePayload); };

    diagnosticsChannel.subscribe("hbup:observer:wake", onWake);

    try {

      store.pushCameraSupportUnlock(cameraConfig.id, true);

      await settle();

      assert.equal(wakes.length, 1, "exactly one observer woke for the supportUnlock push");
      assert.deepEqual(wakes[0], { accessoryId: accessory.UUID, key: "camera.supportUnlock" }, "the wake is the supportUnlock observer, attributed to this accessory");
    } finally {

      diagnosticsChannel.unsubscribe("hbup:observer:wake", onWake);
      camera.cleanup();
    }
  });

  test("the supportUnlock observer unwinds at cleanup - a later push wakes nothing (leak)", async () => {

    const cameraConfig = makeCameraConfig({ accessDeviceMetadata: { featureFlags: { supportUnlock: true } }, channels: G2_PRO_CHANNELS });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { nvr } = buildTestNvr({ store });
    const accessory = makeTestAccessory("Test Camera", "uuid:access-lock-10");
    const camera = construct(nvr, accessory, new TestCameraProjection(cameraConfig.id, store));

    await settle();

    // Tear the camera down and let the observe loops drain and deregister.
    camera.cleanup();

    await settle();

    const wakes: ObserverWakePayload[] = [];
    const onWake = (message: unknown): void => { wakes.push(message as ObserverWakePayload); };

    diagnosticsChannel.subscribe("hbup:observer:wake", onWake);

    try {

      assert.equal(store.observerCount, 0, "every observer deregistered through cleanup");

      store.pushCameraSupportUnlock(cameraConfig.id, false);

      await settle();

      assert.equal(wakes.length, 0, "a supportUnlock push after cleanup wakes nothing");
    } finally {

      diagnosticsChannel.unsubscribe("hbup:observer:wake", onWake);
    }
  });

  /* A lock the user turns off stays off across a restart only once Homebridge's accessory cache holds the camera without it, so the reconcile that removes the lock
   * marks the camera, and the save window that mark opens carries it to the cache once. The window the construction opened is closed first, so the update the row
   * reads after the reconcile belongs to the reconcile alone.
   */
  test("turning the Access lock off saves the camera once, without the lock, when the reconcile's save window closes", async () => {

    const cameraConfig = makeCameraConfig({ accessDeviceMetadata: { featureFlags: { supportUnlock: true } }, channels: G2_PRO_CHANNELS });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { apiCalls, clock, nvr } = buildTestNvr({ store });
    const accessory = makeTestAccessory("Test Camera", "uuid:access-lock-11");
    const camera = construct(nvr, accessory, new TestCameraProjection(cameraConfig.id, store));
    const saves = (): number => apiCalls.filter((call) => (call.kind === "update") && call.accessories.includes(accessory)).length;

    await settle();

    try {

      assert.ok(accessLock(accessory), "the Access lock was created at adoption");

      clock.advance(SAVE_WINDOW_MS);

      const constructed = saves();

      assert.equal(constructed, 1, "the construction window saved the camera once");

      // The user turns the option off through the engine's own write path, the way a settings save does, and a controller change drives the reconcile. The change is
      // a flag only a doorbell reads, so the lock's removal is the one change the reconcile makes, and the save it asks for is the lock's alone.
      nvr.platform.featureOptions.setOption({ enabled: false, option: "UniFi.Access.Lock" });
      store.pushCameraFeatureFlags(cameraConfig.id, { hasFingerprintSensor: true });

      await settle();

      assert.equal(accessLock(accessory), undefined, "the reconcile removed the lock the option turned off");

      clock.advance(SAVE_WINDOW_MS - 1);

      assert.equal(saves(), constructed, "nothing is saved while the reconcile's window is open");

      clock.advance(1);

      assert.equal(saves(), constructed + 1, "exactly one update names the camera once the reconcile's window closes");
    } finally {

      camera.cleanup();
    }
  });
});

describe("the camera capability reconcile - the night vision dimmer", () => {

  test("a late hasInfrared and hasIcrSensitivity create the night vision dimmer live and read the device value, without a restart (self-heal, fails without the " +
    "routing)", async () => {

    // A camera adopted WITHOUT the adjustable infrared hardware (the makeCameraConfig defaults leave hasInfrared / hasIcrSensitivity false), with the dimmer toggle on:
    // the gate's conservative-keep yields no dimmer at adoption. Seed a DIVERGENT irLedMode "auto" BEFORE construction so the eventual establishment push proves it reads
    // the real device value (On true, Brightness 10), not a vacuous off-state default.
    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));

    store.pushCameraPatch(cameraConfig.id, cameraPatch({ ispSettings: { irLedMode: "auto" } }));

    const { nvr } = buildTestNvr({ store, userOptions: ["Enable.Device.NightVision.Dimmer"] });
    const accessory = makeTestAccessory("Test Camera", "uuid:night-vision-dimmer-1");
    const camera = construct(nvr, accessory, new TestCameraProjection(cameraConfig.id, store));

    await settle();

    try {

      // The vacuity guard: genuinely no dimmer before the push, so the post-push presence is a real transition.
      assert.equal(nightVisionDimmer(accessory), undefined, "no night vision dimmer exists before the controller reports the infrared hardware");

      // The controller finishes provisioning the camera and now reports both adjustable-infrared flags.
      store.pushCameraFeatureFlags(cameraConfig.id, { hasIcrSensitivity: true, hasInfrared: true });

      await settle();

      // The featureFlags observer drove reconcileCapabilities("observe"), which created the dimmer and (an attached transition) established it from the device's
      // irLedMode "auto" reading. Dropping the configureNightVisionDimmer(source) call from reconcileCapabilities leaves this RED - the push wakes nothing and the dimmer
      // stays absent.
      const dimmer = nightVisionDimmer(accessory);

      assert.ok(dimmer, "the late infrared hardware created the night vision dimmer without a restart");
      assert.equal(nightVisionDimmerCount(accessory), 1, "exactly one night vision dimmer exists after the self-heal");
      assert.equal(dimmer.getCharacteristic(Characteristic.On).value, true, "the self-healed dimmer established On from the device irLedMode auto reading");
      assert.equal(dimmer.getCharacteristic(Characteristic.Brightness).value, 10, "the self-healed dimmer established Brightness 10 from the device irLedMode auto");
    } finally {

      camera.cleanup();
    }
  });

  test("a withdrawn hasInfrared never prunes the night vision dimmer (subtractive-conservative, THE old-vs-new divergence cell)", async () => {

    // A camera adopted WITH the adjustable infrared hardware and the dimmer toggle on, then a controller that stops reporting hasInfrared (a transient bootstrap blip
    // delivers featureFlags all-false). The capabilityGate capability half is additive-eager / subtractive-conservative: it creates on true and never prunes on false.
    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { hasIcrSensitivity: true, hasInfrared: true } });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { nvr } = buildTestNvr({ store, userOptions: ["Enable.Device.NightVision.Dimmer"] });
    const accessory = makeTestAccessory("Test Camera", "uuid:night-vision-dimmer-2");
    const camera = construct(nvr, accessory, new TestCameraProjection(cameraConfig.id, store));

    await settle();

    try {

      assert.ok(nightVisionDimmer(accessory), "the night vision dimmer was created at adoption");

      // The controller stops reporting the infrared capability.
      store.pushCameraFeatureFlags(cameraConfig.id, { hasInfrared: false });

      await settle();

      // The capabilityGate hasService || clause keeps the present dimmer through the transient hasInfrared-false while the toggle stays on. This is the ONLY cell
      // where capabilityGate and a strict boolean gate diverge: replacing capabilityGate(...) with the strict hasNightVisionHardware &&
      // this.hasFeature(...) boolean passes validService(false), which PRUNES the working dimmer -> RED.
      assert.ok(nightVisionDimmer(accessory), "the withdrawn capability never pruned the existing night vision dimmer");
      assert.equal(nightVisionDimmerCount(accessory), 1, "the dimmer is retained, not duplicated, across the withdrawal");
    } finally {

      camera.cleanup();
    }
  });

  test("the feature option off creates no night vision dimmer with the infrared hardware (the toggle half, fresh, fails without the toggle clause)", async () => {

    // The adjustable infrared hardware is present, but the Device.NightVision.Dimmer toggle defaults off (unlike lux / the lock) and no Enable option is supplied. Both
    // halves must hold to CREATE, so no dimmer appears.
    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { hasIcrSensitivity: true, hasInfrared: true } });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { nvr } = buildTestNvr({ store });
    const accessory = makeTestAccessory("Test Camera", "uuid:night-vision-dimmer-3");
    const camera = construct(nvr, accessory, new TestCameraProjection(cameraConfig.id, store));

    await settle();

    try {

      // The default-off toggle vetoes the dimmer even though the infrared hardware is present. Dropping the toggle half (leaving (hasService || capability) alone) leaves
      // this RED - the dimmer appears (the self-heal test is the positive control proving the hardware alone WOULD create it once the toggle is on).
      assert.equal(nightVisionDimmer(accessory), undefined, "the default-off Device.NightVision.Dimmer toggle creates no dimmer despite the infrared hardware");
    } finally {

      camera.cleanup();
    }
  });

  test("the feature option off prunes an existing night vision dimmer (the toggle half on an existing service; parity, not a divergence)", async () => {

    // Pre-seed a cached LIGHTBULB_NIGHTVISION Lightbulb BEFORE construction - a restart whose Enable toggle was removed. The camera adopts WITH the infrared hardware (so
    // the strict-boolean mutation cannot tell these apart here - capability true with toggle false prunes either way) but the toggle off.
    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { hasIcrSensitivity: true, hasInfrared: true } });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { nvr } = buildTestNvr({ store });
    const accessory = makeTestAccessory("Test Camera", "uuid:night-vision-dimmer-4");

    accessory.addService(Service.Lightbulb, "Test Camera Night Vision", ProtectReservedNames.LIGHTBULB_NIGHTVISION);

    assert.ok(nightVisionDimmer(accessory), "a cached night vision dimmer is present before construction");

    const camera = construct(nvr, accessory, new TestCameraProjection(cameraConfig.id, store));

    await settle();

    try {

      // The toggle half prunes the present dimmer: hasFeature is false, so validService removes it. This is PARITY - a plain boolean also passes to validService, which
      // removes on false, so the gate and a plain boolean BOTH prune (there is no toggle-off divergence, unlike the lock cell). ONLY the dropped-toggle-half mutation
      // tells these apart here ((hasService || capability) = true -> keeps -> RED); the strict-boolean mutation does NOT (capability true && toggle false = false =
      // prune, same as production).
      assert.equal(nightVisionDimmer(accessory), undefined, "the absent Enable toggle pruned the cached night vision dimmer");
    } finally {

      camera.cleanup();
    }
  });

  test("a live observe reconcile over an existing dimmer never re-pushes the displayed value (Fix C2, fails without the establishment condition)", async () => {

    // Seed a DIVERGENT irLedMode "auto" BEFORE construction so the dimmer is established to On true / Brightness 10 at adoption, a value distinct from the optimistic
    // setting driven below.
    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { hasIcrSensitivity: true, hasInfrared: true } });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));

    store.pushCameraPatch(cameraConfig.id, cameraPatch({ ispSettings: { irLedMode: "auto" } }));

    const { nvr } = buildTestNvr({ store, userOptions: ["Enable.Device.NightVision.Dimmer"] });
    const accessory = makeTestAccessory("Test Camera", "uuid:night-vision-dimmer-5");
    const camera = construct(nvr, accessory, new TestCameraProjection(cameraConfig.id, store));

    await settle();

    try {

      const dimmer = nightVisionDimmer(accessory);

      assert.ok(dimmer, "the night vision dimmer exists before the observe reconcile");
      assert.equal(dimmer.getCharacteristic(Characteristic.On).value, true, "the dimmer established On true from the seeded irLedMode auto");

      // Simulate an in-flight optimistic user setting: drive On / Brightness DIRECTLY to values that differ from the device reading (the user tapped the dimmer off; the
      // device.update is still in flight, so irLedMode is still "auto"). updateCharacteristic writes the value without firing the onSet.
      dimmer.updateCharacteristic(Characteristic.On, false);
      dimmer.updateCharacteristic(Characteristic.Brightness, 3);

      // Trigger a LIVE observe reconcile through the featureFlags observer with an unrelated capability change, exactly as the lock's row does: a re-push of the same
      // infrared flags would dedup under the value selector and wake nothing. ispSettings is untouched, so its observer stays asleep and updateNightVision never runs.
      // With the dimmer already present and source "observe", the establishment block is skipped.
      store.pushCameraFeatureFlags(cameraConfig.id, { hasLuxCheck: true });

      await settle();

      // The display is untouched - still the optimistic value. Making the push unconditional (dropping (transition === "attached") || (source === "construct")) leaves
      // the observe reconcile re-pushing the device reading (On true / Brightness 10) over the optimistic setting -> RED, which would momentarily stomp the user's
      // in-flight command.
      assert.equal(dimmer.getCharacteristic(Characteristic.On).value, false, "the observe reconcile left the optimistic On false untouched");
      assert.equal(dimmer.getCharacteristic(Characteristic.Brightness).value, 3, "the observe reconcile left the optimistic Brightness 3 untouched");
    } finally {

      camera.cleanup();
    }
  });

  test("a configure against a restart-restored dimmer re-establishes the device value and re-binds the onSet (the construct push + wire-every-configure)", async () => {

    // Seed a DIVERGENT irLedMode "auto" (device reading On true / Brightness 10) BEFORE construction, distinct from the STALE cached characteristic values the restored
    // service carries.
    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { hasIcrSensitivity: true, hasInfrared: true } });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));

    store.pushCameraPatch(cameraConfig.id, cameraPatch({ ispSettings: { irLedMode: "auto" } }));

    const { nvr } = buildTestNvr({ store, userOptions: ["Enable.Device.NightVision.Dimmer"] });
    const accessory = makeTestAccessory("Test Camera", "uuid:night-vision-dimmer-6");

    // Pre-seed the restored service: present, On / Brightness at STALE off-state values distinct from the device "auto" reading, with no onSet bound - the state a
    // Homebridge restart restores (HAP serializes neither the runtime handler nor a fresh device read).
    const restored = accessory.addService(Service.Lightbulb, "Test Camera Night Vision", ProtectReservedNames.LIGHTBULB_NIGHTVISION);

    restored.updateCharacteristic(Characteristic.On, false);
    restored.updateCharacteristic(Characteristic.Brightness, 0);

    assert.equal(restored.getCharacteristic(Characteristic.On).value, false, "the cached dimmer reads On false before construction");

    const projection = new TestCameraProjection(cameraConfig.id, store);
    const camera = construct(nvr, accessory, projection);

    await settle();

    try {

      // (a) The construct path re-established the EXISTING dimmer from the device reading (source === "construct" with the dimmer kept). Dropping the
      // source === "construct" half leaves the cached dimmer un-pushed - the gate answers kept, not attached - and it stays at the stale On false / Brightness 0 -> RED.
      assert.equal(restored.getCharacteristic(Characteristic.On).value, true, "the construct reconcile re-established On true from the device irLedMode auto reading");
      assert.equal(restored.getCharacteristic(Characteristic.Brightness).value, 10, "the construct reconcile re-established Brightness 10 from the device reading");

      // (b) The On onSet was re-bound on this configure (the wire-every-configure rule - the transition does NOT gate the wiring). Driving it to false dispatches
      // exactly one irLedMode off write. Re-introducing an if(existing) return true guard before the onSet bind leaves nothing recorded -> RED.
      await restored.getCharacteristic(Characteristic.On).triggerSet(false);

      assert.deepEqual(projection.updateCalls, [{ payload: { ispSettings: { irLedMode: "off" } } }],
        "the re-bound On onSet dispatched exactly one irLedMode off write when driven to false");
    } finally {

      camera.cleanup();
    }
  });

  test("the Enabling night vision dimmer log fires exactly once on creation and stays silent on a live reconcile (establishment-gated, counted)", async () => {

    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { hasIcrSensitivity: true, hasInfrared: true } });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { logEntries, nvr } = buildTestNvr({ store, userOptions: ["Enable.Device.NightVision.Dimmer"] });
    const accessory = makeTestAccessory("Test Camera", "uuid:night-vision-dimmer-7");

    // Count the captured "Enabling night vision dimmer." INFO entries. A COUNT through logCount, not the boolean loggedAt: the construct-time entry persists in the
    // buffer, so a boolean could not tell a once-logged dimmer from a twice-logged one.
    const enablingLogCount = (): number => {

      return logCount(logEntries, "info", "Enabling night vision dimmer.");
    };

    const camera = construct(nvr, accessory, new TestCameraProjection(cameraConfig.id, store));

    await settle();

    try {

      assert.ok(nightVisionDimmer(accessory), "the infrared hardware plus the Enable toggle created the night vision dimmer at construction");
      assert.equal(enablingLogCount(), 1, "the establishment block logged Enabling night vision dimmer exactly once at creation");

      // Trigger a LIVE observe reconcile through the featureFlags observer with an unrelated capability change, since a re-push of the same infrared flags would dedup
      // under the value selector and wake nothing; the dimmer is already present and source is observe, so the establishment block (and its log) is skipped.
      store.pushCameraFeatureFlags(cameraConfig.id, { hasLuxCheck: true });

      await settle();

      // Still exactly one. Moving the log back to the unconditional tail leaves the observe re-run logging again -> count 2 -> RED.
      assert.equal(enablingLogCount(), 1, "the live reconcile did not re-log Enabling night vision dimmer - the count stays one");
    } finally {

      camera.cleanup();
    }
  });
});

describe("the camera capability reconcile - tamper detection", () => {

  test("a late hasTamperDetection materializes StatusTampered live and the onGet reads the preserved latch, without a restart (self-heal + the latch-clear guard, " +
    "fails without the routing and the guarded clear)", async () => {

    // A camera the controller adopts WITHOUT the tamper capability, the user setting eventually on. The tamper gate keys StatusTampered on TWO inputs - the
    // hasTamperDetection hardware capability and the enableTamperDetection setting - so the setting alone leaves the characteristic absent until the capability reports.
    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { nvr } = buildTestNvr({ store });
    const accessory = makeTestAccessory("Test Camera", "uuid:tamper-1");
    const camera = construct(nvr, accessory, new TestCameraProjection(cameraConfig.id, store));

    await settle();

    try {

      const motionService = motionSensor(accessory);

      assert.ok(motionService, "the HKSV-capable camera carries its motion sensor, the host of the StatusTampered characteristic");

      // Turn the user setting on. The capability is still unreported, so the conservative half of the gate keeps StatusTampered off.
      store.pushCameraPatch(cameraConfig.id, cameraPatch({ smartDetectSettings: { enableTamperDetection: true } }));

      await settle();

      // The vacuity guard: StatusTampered is genuinely absent before the capability reports, so a post-push presence is a real transition. The setting-on half alone does
      // not create it - the conservative capability half holds.
      assert.equal(motionService.testCharacteristic(Characteristic.StatusTampered), false, "no tamper characteristic exists while the capability is unreported");

      // A tamper event latches isTampered before the capability finishes reporting. An unrelated hasLedStatus change - an intentionally inert wake that touches no
      // reconcile leaf - re-delivers featureFlags with hasTamperDetection STILL false (a transient incomplete bootstrap), waking the featureFlags observer and running
      // a capability-false tamper reconcile while the setting is on: the prune branch is entered with no characteristic to remove, and the guarded clear must leave the
      // active latch intact.
      camera.isTampered = true;
      store.pushCameraFeatureFlags(cameraConfig.id, { hasLedStatus: true });

      await settle();

      // The controller finishes provisioning the camera and now reports the tamper capability.
      store.pushCameraFeatureFlags(cameraConfig.id, { hasTamperDetection: true });

      await settle();

      // The featureFlags observer drove reconcileCapabilities, which materialized StatusTampered and bound its onGet. Removing configureTamperDetection from
      // reconcileCapabilities leaves this RED - the capability push reaches no tamper leaf and the characteristic stays absent.
      assert.ok(motionService.testCharacteristic(Characteristic.StatusTampered), "the late capability materialized StatusTampered without a restart");

      // The latch the tamper event set survived the intervening capability-false reconcile, so the freshly-bound onGet reads it as true. Dropping the
      // if(!enableTamperDetection) guard (clearing the latch unconditionally) lets that capability-false reconcile wipe isTampered, so the onGet would read false -> RED.
      assert.equal(await motionService.getCharacteristic(Characteristic.StatusTampered).triggerGet(), true,
        "the onGet reads the latch the tamper event set, preserved through the capability-false reconcile");
    } finally {

      camera.cleanup();
    }
  });

  test("a withdrawn hasTamperDetection never prunes StatusTampered and the active latch survives (subtractive-conservative + latch protection, THE old-vs-new " +
    "divergence cell)", async () => {

    // A camera adopted WITH the tamper capability and the setting eventually on, then a controller that stops reporting hasTamperDetection (a transient incomplete
    // bootstrap delivers featureFlags with the flag false). The capabilityGate capability half is additive-eager / subtractive-conservative: it never prunes an existing
    // characteristic on a transient false while the setting stays on.
    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { hasTamperDetection: true } });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { nvr } = buildTestNvr({ store });
    const accessory = makeTestAccessory("Test Camera", "uuid:tamper-2");
    const camera = construct(nvr, accessory, new TestCameraProjection(cameraConfig.id, store));

    await settle();

    try {

      const motionService = motionSensor(accessory);

      assert.ok(motionService, "the camera carries its motion sensor");

      // Turn the user setting on. Both halves now hold, so the characteristic materializes - the before-presence vacuity for the retention check below.
      store.pushCameraPatch(cameraConfig.id, cameraPatch({ smartDetectSettings: { enableTamperDetection: true } }));

      await settle();

      assert.equal(motionService.testCharacteristic(Characteristic.StatusTampered), true, "the tamper characteristic exists with both the capability and the setting on");

      // An active tamper latches, then the controller stops reporting the capability.
      camera.isTampered = true;
      store.pushCameraFeatureFlags(cameraConfig.id, { hasTamperDetection: false });

      await settle();

      // The capabilityGate conservative clause keeps the present characteristic through the transient hasTamperDetection-false while the setting stays on. This is the
      // ONLY cell where capabilityGate diverges from a strict boolean gate (!hasTamperDetection || !enableTamperDetection): replacing capabilityGate(...) with the
      // strict this.ufp.featureFlags.hasTamperDetection && this.ufp.smartDetectSettings.enableTamperDetection boolean prunes the working characteristic -> RED here.
      assert.equal(motionService.testCharacteristic(Characteristic.StatusTampered), true, "the withdrawn capability never pruned the existing tamper characteristic");

      // The kept characteristic's onGet still reads the active latch - the conservative-keep skipped the prune branch, so its clear never ran. Under the same
      // strict-boolean mutation the characteristic is pruned, so this onGet read-through is gone and triggerGet falls back to a fresh null -> RED (coupled to the prune
      // above, not an independent latch clear: with the setting on, the guarded clear would not fire even if the prune branch ran).
      assert.equal(await motionService.getCharacteristic(Characteristic.StatusTampered).triggerGet(), true,
        "the retained characteristic's onGet reads the active latch, preserved across the capability withdrawal");
    } finally {

      camera.cleanup();
    }
  });

  test("the setting off prunes an existing StatusTampered and clears the latch (parity; pins the toggle half and the latch-clear)", async () => {

    // A camera adopted WITH the tamper capability, the setting toggled on then off. The setting half is absolute: a user toggle-off is the documented latch-clear path,
    // so it prunes the characteristic and clears the one-way latch. Both capabilityGate and a strict boolean gate prune on the setting-off (no divergence - the
    // divergence is the capability half).
    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { hasTamperDetection: true } });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { nvr } = buildTestNvr({ store });
    const accessory = makeTestAccessory("Test Camera", "uuid:tamper-3");
    const camera = construct(nvr, accessory, new TestCameraProjection(cameraConfig.id, store));

    await settle();

    try {

      const motionService = motionSensor(accessory);

      assert.ok(motionService, "the camera carries its motion sensor");

      // Turn the setting on so the characteristic materializes, then latch an active tamper.
      store.pushCameraPatch(cameraConfig.id, cameraPatch({ smartDetectSettings: { enableTamperDetection: true } }));

      await settle();

      assert.equal(motionService.testCharacteristic(Characteristic.StatusTampered), true, "the tamper characteristic exists before the setting-off");

      camera.isTampered = true;

      // The user turns tamper detection off in the controller.
      store.pushCameraPatch(cameraConfig.id, cameraPatch({ smartDetectSettings: { enableTamperDetection: false } }));

      await settle();

      // The setting-off prunes the characteristic. Dropping the toggle half (gating on (existing || hasTamperDetection) alone) keeps it - the capability is still true
      // - so this assertion goes RED, pinning the absolute toggle half.
      assert.equal(motionService.testCharacteristic(Characteristic.StatusTampered), false, "the setting-off pruned the tamper characteristic");

      // The setting-off also cleared the one-way latch. Removing the explicit latch-clear block leaves isTampered latched true through the prune -> RED, pinning the
      // documented clear path.
      assert.equal(camera.isTampered, false, "the setting-off cleared the one-way tamper latch");
    } finally {

      camera.cleanup();
    }
  });

  test("with the setting off and no StatusTampered to remove, a reconcile still clears a set latch", async () => {

    // A camera whose user setting stays off while a tamper event latches. The gate refuses the characteristic and finds none to remove, and the latch still clears,
    // because the clear follows the setting-off verdict rather than the removal itself.
    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { nvr } = buildTestNvr({ store });
    const accessory = makeTestAccessory("Test Camera", "uuid:tamper-5");
    const camera = construct(nvr, accessory, new TestCameraProjection(cameraConfig.id, store));

    await settle();

    try {

      const motionService = motionSensor(accessory);

      assert.ok(motionService, "the camera carries its motion sensor");
      assert.equal(motionService.testCharacteristic(Characteristic.StatusTampered), false, "no tamper characteristic exists while the setting is off");

      camera.isTampered = true;

      // The controller reports the tamper capability while the setting stays off, waking the featureFlags observer and running the tamper reconcile on a pass where
      // the gate refuses the characteristic and has nothing to remove.
      store.pushCameraFeatureFlags(cameraConfig.id, { hasTamperDetection: true });

      await settle();

      assert.equal(motionService.testCharacteristic(Characteristic.StatusTampered), false, "the setting-off verdict kept the tamper characteristic absent");

      // Clearing the latch only when the gate removed a characteristic leaves isTampered latched true here, where there was nothing to remove -> RED.
      assert.equal(camera.isTampered, false, "the setting-off verdict cleared the latch with no characteristic to remove");
    } finally {

      camera.cleanup();
    }
  });

  test("a configure against a restart-restored StatusTampered re-binds the onGet over the stale cached value (the construct re-wire; wire-every-configure)", async () => {

    // Pre-push the setting on BEFORE construction so the construct reconcile sees enableTamperDetection true, mirroring the controller-stored config a restart restores
    // (the ufp wire capture confirmed enableTamperDetection survives a reconnect independently of featureFlags).
    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { hasTamperDetection: true } });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));

    store.pushCameraPatch(cameraConfig.id, cameraPatch({ smartDetectSettings: { enableTamperDetection: true } }));

    const { nvr } = buildTestNvr({ store });
    const accessory = makeTestAccessory("Test Camera", "uuid:tamper-4");

    // Pre-seed the restored motion sensor carrying StatusTampered at a STALE true distinct from the rest latch (false), with no onGet bound - the state a Homebridge
    // restart restores (HAP serializes the characteristic and its cached value but never the runtime onGet handler). configureMotionSensor reuses this cached service.
    const restored = accessory.addService(Service.MotionSensor, "Test Camera");

    restored.updateCharacteristic(Characteristic.StatusTampered, true);

    assert.equal(restored.getCharacteristic(Characteristic.StatusTampered).value, true, "the cached StatusTampered reads a stale true before construction");

    const projection = new TestCameraProjection(cameraConfig.id, store);
    const camera = construct(nvr, accessory, projection);

    await settle();

    try {

      // The tamper gate answers kept for the restored characteristic, and the construct reconcile binds the onGet on that answer as well as on attached (the
      // wire-every-configure rule). triggerGet now reads this.isTampered at rest (false), NOT the stale cached true. Binding the onGet only on an attached answer leaves
      // the restored characteristic unwired, so triggerGet falls through to the stale cached true -> RED.
      assert.equal(await restored.getCharacteristic(Characteristic.StatusTampered).triggerGet(), false,
        "the construct reconcile re-bound the onGet, so the read returns isTampered at rest, not the stale cached true");

      // The pass binds the handler and writes no value: the write log holds the seed write above and no initial value after it, so a configure that stamped the
      // latch on a kept characteristic -> RED.
      assert.deepEqual(restored.getCharacteristic(Characteristic.StatusTampered).writes, [true],
        "the configure pass wrote no initial StatusTampered value, leaving only the row's own seed write in the log");
    } finally {

      camera.cleanup();
    }
  });
});

describe("the camera capability reconcile - two-way audio", () => {

  test("a late hasSpeaker surfaces two-way audio via one in-place controller rebuild, without a restart (self-heal, fails without the reconcile call)", async () => {

    // A camera the controller adopts WITHOUT a speaker: the streaming delegate's frozen audio options are built with two-way audio off, so the talk button is baked off.
    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { hasSpeaker: false } });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { nvr } = buildTestNvr({ store });
    const accessory = makeTestAccessory("Test Camera", "uuid:two-way-audio-1");
    const camera = construct(nvr, accessory, new TestCameraProjection(cameraConfig.id, store));

    await settle();

    try {

      // The vacuity guard: the controller was genuinely built without two-way audio, so the post-push flip is a real transition.
      assert.equal(camera.stream?.builtFor.twoWayAudio, false, "the construction-built controller carries two-way audio off");
      assert.equal(camera.hints.twoWayAudio, false, "the two-way audio hint is off before the speaker is reported");

      const churnBaseline = accessory.controllerEvents.length;

      // The controller finishes provisioning the camera and now reports the speaker.
      store.pushCameraFeatureFlags(cameraConfig.id, { hasSpeaker: true });

      await settle();

      // The featureFlags observer drove reconcileCapabilities, whose controller-identity reconcile refreshed the hint and rebuilt the controller: exactly one
      // removeController then one configureController. Removing that reconcile from reconcileCapabilities leaves this RED - no rebuild fires
      // and builtFor.twoWayAudio stays false.
      const churn = accessory.controllerEvents.slice(churnBaseline);

      assert.equal(churn.length, 2, "the late speaker fired exactly two controller events");
      assert.equal(churn[0]?.kind, "remove", "the first controller event is the removeController");
      assert.equal(churn[1]?.kind, "configure", "the second controller event is the configureController");
      assert.equal(camera.stream.builtFor.twoWayAudio, true, "the rebuilt controller is now built for two-way audio");
      assert.equal(camera.hints.twoWayAudio, true, "the two-way audio hint refreshed to true");
    } finally {

      camera.cleanup();
    }
  });

  test("a late hasSpeaker reported while the camera is disconnected rebuilds nothing until the camera connects, then rebuilds exactly once (fails without the " +
    "connected gate, fails without the connect re-run)", async () => {

    // A camera the controller adopts WITHOUT a speaker, so its controller is built with two-way audio off.
    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { hasSpeaker: false } });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { nvr } = buildTestNvr({ store });
    const accessory = makeTestAccessory("Test Camera", "uuid:two-way-audio-disconnected");
    const camera = construct(nvr, accessory, new TestCameraProjection(cameraConfig.id, store));

    await settle();

    try {

      assert.equal(camera.stream?.builtFor.twoWayAudio, false, "the construction-built controller carries two-way audio off");

      // The camera drops off the controller, and while it is away the controller reports its speaker.
      store.pushCameraPatch(cameraConfig.id, { state: "DISCONNECTED" });

      await settle();

      const churnBaseline = accessory.controllerEvents.length;

      store.pushCameraFeatureFlags(cameraConfig.id, { hasSpeaker: true });

      await settle();

      // The connected gate held the reading back: no controller churn, and the controller is still built without two-way audio. The hint refresh runs ahead of the
      // gate, so the sticky hint has already risen. Removing the gate rebuilds here -> RED.
      assert.equal(accessory.controllerEvents.length, churnBaseline, "the speaker reported while the camera is disconnected rebuilt nothing");
      assert.equal(camera.stream.builtFor.twoWayAudio, false, "the standing controller is still built without two-way audio");
      assert.equal(camera.hints.twoWayAudio, true, "the two-way audio hint rose ahead of the connected gate");

      // The camera connects. The state observer re-runs the capability reconcile on the connect edge, which lands the held-back reading as exactly one rebuild.
      // Removing that re-run leaves the controller unbuilt for two-way audio -> RED.
      store.pushCameraPatch(cameraConfig.id, { state: "CONNECTED" });

      await settle();

      assert.deepEqual(accessory.controllerEvents.slice(churnBaseline).map((event) => event.kind), [ "remove", "configure" ],
        "the connect rebuilt the controller exactly once, remove then configure");
      assert.equal(camera.stream.builtFor.twoWayAudio, true, "the rebuilt controller is built for two-way audio");
    } finally {

      camera.cleanup();
    }
  });

  test("a speaker drop never churns the controller and the additive-only hint stays true (subtractive-conservative, fails without the ||= refresh)", async () => {

    // A camera adopted WITH a speaker: the controller is built for two-way audio and the hint reads true.
    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { hasSpeaker: true } });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { nvr } = buildTestNvr({ store });
    const accessory = makeTestAccessory("Test Camera", "uuid:two-way-audio-2");
    const camera = construct(nvr, accessory, new TestCameraProjection(cameraConfig.id, store));

    await settle();

    try {

      assert.equal(camera.stream?.builtFor.twoWayAudio, true, "the construction-built controller carries two-way audio on");
      assert.equal(camera.hints.twoWayAudio, true, "the two-way audio hint reads true with the speaker present");

      const churnBaseline = accessory.controllerEvents.length;

      // A transient incomplete-bootstrap drain reports no speaker. The additive-only refresh leaves the established hint untouched, and the additive-only predicate
      // never rebuilds on a capability reading false, so the blip is a complete non-event.
      store.pushCameraFeatureFlags(cameraConfig.id, { hasSpeaker: false });

      await settle();

      // Zero controller churn, and the hint stayed true. Changing the hint refresh from ||= to = sets the hint false on this subtractive push -> the hint assertion goes
      // RED. (The predicate is additive too, but under the sticky ||= the current two-way audio never falls, so a symmetric-predicate mutation does not fire on the
      // two-way audio term here - that is pinned by the all-false drain test via the live isDoorbell term.)
      assert.equal(accessory.controllerEvents.length, churnBaseline, "the speaker drop drove zero controller churn");
      assert.equal(camera.hints.twoWayAudio, true, "the additive-only hint refresh left the established two-way audio hint true");
    } finally {

      camera.cleanup();
    }
  });

  test("a wholesale all-false featureFlags drain then the real values drives zero controller churn and no warning (the deep re-adopt contract, fails on a " +
    "symmetric predicate)", async () => {

    // A doorbell-with-speaker: the controller is built for a doorbell with two-way audio, and the camera carries its motion sensor. A deep re-adopt delivers the whole
    // featureFlags block with every flag false before the real values land, so the reconcile must not rebuild on the transient false, and no narrator may read it as a
    // withdrawal.
    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { hasSpeaker: true, isDoorbell: true } });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { logEntries, nvr } = buildTestNvr({ store });
    const accessory = makeTestAccessory("Test Camera", "uuid:two-way-audio-3");
    const camera = construct(nvr, accessory, new TestCameraProjection(cameraConfig.id, store));

    await settle();

    try {

      assert.equal(camera.stream?.builtFor.isDoorbell, true, "the controller is built for a doorbell");
      assert.equal(camera.stream.builtFor.twoWayAudio, true, "the controller is built for two-way audio");
      assert.ok(motionSensor(accessory), "the camera carries its motion sensor");

      const churnBaseline = accessory.controllerEvents.length;
      const warnBaseline = logEntries.filter((entry) => entry.level === "warn").length;

      // The drain: a frame reporting every flag false, then the recovery frame restoring the real values.
      store.pushCameraFeatureFlagsDrain(cameraConfig.id);

      await settle();

      assert.equal(camera.isHksvCapable, false, "the vacuity guard: the drain frame reads the motion report false");

      store.pushCameraFeatureFlags(cameraConfig.id, { hasMotionDetection: true, hasSpeaker: true, isDoorbell: true });

      await settle();

      // Zero controller churn across the drain. A symmetric "the identities differ" predicate would rebuild on the all-false frame (current isDoorbell false differs
      // from built true) AND again on recovery (now built false differs from the restored true) -> four events -> RED.
      assert.equal(accessory.controllerEvents.length, churnBaseline, "the all-false drain and recovery drove zero controller churn");

      // Zero warnings across the drain: the doorbell and the motion sensor each read the all-false frame as no reading, and each remains.
      assert.equal(logEntries.filter((entry) => entry.level === "warn").length, warnBaseline, "the all-false drain and recovery warned nothing");
      assert.ok(camera.doorbell, "the doorbell capability remains");
      assert.ok(motionSensor(accessory), "the motion sensor remains");
    } finally {

      camera.cleanup();
    }
  });

  test("a late hasSpeaker with Audio.TwoWay disabled never churns the controller (negative control, fails without the Audio.TwoWay clause)", async () => {

    // The speaker hardware will report, but the user disabled two-way audio. The hint derivation gates on the Audio.TwoWay feature option, so two-way audio stays off and
    // the controller is never rebuilt - the control that proves the hasFeature clauses are each actually exercised.
    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { hasSpeaker: false } });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { nvr } = buildTestNvr({ store, userOptions: ["Disable.Audio.TwoWay"] });
    const accessory = makeTestAccessory("Test Camera", "uuid:two-way-audio-4");
    const camera = construct(nvr, accessory, new TestCameraProjection(cameraConfig.id, store));

    await settle();

    try {

      assert.equal(camera.hints.twoWayAudio, false, "two-way audio is off at construction with the option disabled");

      const churnBaseline = accessory.controllerEvents.length;

      // The controller reports the speaker, but the disabled option holds two-way audio off.
      store.pushCameraFeatureFlags(cameraConfig.id, { hasSpeaker: true });

      await settle();

      // Zero churn and the hint stays false, because twoWayAudio = hasSpeaker && hasFeature("Audio.TwoWay")(false) = false. A hasSpeaker-only predicate (dropping the
      // && this.hasFeature("Audio.TwoWay") clause) would flip the hint true and rebuild -> RED, so this tells apart the otherwise-unexercised hasFeature clauses.
      assert.equal(accessory.controllerEvents.length, churnBaseline, "the disabled Audio.TwoWay option drove zero controller churn despite the late speaker");
      assert.equal(camera.hints.twoWayAudio, false, "the disabled Audio.TwoWay option held two-way audio off");
    } finally {

      camera.cleanup();
    }
  });

  test("a late hasSpeaker refreshes the direct-talkback hint when the direct option is enabled (the direct-talkback refresh, fails without the refresh line)",
    async () => {

      // The direct-talkback path reads hints.twoWayAudioDirect live (it is never frozen into the controller), so the reconcile refreshes it alongside two-way audio for
      // a late speaker. Enable the default-off Audio.TwoWay.Direct option and report the speaker late.
      const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { hasSpeaker: false } });
      const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
      const { nvr } = buildTestNvr({ store, userOptions: ["Enable.Audio.TwoWay.Direct"] });
      const accessory = makeTestAccessory("Test Camera", "uuid:two-way-audio-5");
      const camera = construct(nvr, accessory, new TestCameraProjection(cameraConfig.id, store));

      await settle();

      try {

        assert.equal(camera.hints.twoWayAudioDirect, false, "the direct-talkback hint is off before the speaker is reported");

        store.pushCameraFeatureFlags(cameraConfig.id, { hasSpeaker: true });

        await settle();

        // The direct-talkback hint rose with the late speaker. Dropping the this.hints.twoWayAudioDirect ||= ... refresh line leaves it false -> RED.
        assert.equal(camera.hints.twoWayAudioDirect, true, "the late speaker refreshed the direct-talkback hint to true");
      } finally {

        camera.cleanup();
      }
    });

  test("an unrelated featureFlags change never churns a controller built for the camera's current identity (routine wake, the additive !built guard)", async () => {

    // A camera adopted WITH a speaker, already built for two-way audio. An unrelated capability change wakes the featureFlags observer but must not rebuild it.
    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { hasSpeaker: true } });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { nvr } = buildTestNvr({ store });
    const accessory = makeTestAccessory("Test Camera", "uuid:two-way-audio-6");
    const camera = construct(nvr, accessory, new TestCameraProjection(cameraConfig.id, store));

    await settle();

    try {

      assert.equal(camera.stream?.builtFor.twoWayAudio, true, "the controller is built for two-way audio");

      const churnBaseline = accessory.controllerEvents.length;

      // An unrelated capability (the status-light hardware) reports late.
      store.pushCameraFeatureFlags(cameraConfig.id, { hasLedStatus: true });

      await settle();

      // Zero churn: controllerCapabilityAppeared reads no rising edge, since built and current carry the same terms. Removing the if(!controllerCapabilityAppeared(...))
      // return guard rebuilds on any wake -> RED; dropping the !built[term] half (leaving current[term] alone) reads two-way audio as appeared while built already
      // carries it -> rebuild -> RED. This is the regression assertion for the additive !built guard.
      assert.equal(accessory.controllerEvents.length, churnBaseline, "the unrelated wake drove zero controller churn");
    } finally {

      camera.cleanup();
    }
  });

  /* The package camera follows its parent. The package spawns no capability observer of its own - it replaces the camera observer set wholesale - so the parent's
   * capability reconcile re-checks the package's frozen controller identity in the same pass. A speaker appearing on the shared parent record therefore rebuilds the
   * PARENT's controller and the package's together, each exactly once, and the package's rebuilt controller carries the two-way audio its hint bag reads after the push.
   *
   * The package channel is present in the fixture deliberately: a package with no delegate could not rebuild its controller no matter what the reconcile did, so both
   * delegates exist here and the package's rebuild is a real result.
   */
  test("a late hasSpeaker rebuilds the parent's controller and the package camera's together, each exactly once (fails without the parent's package re-check)",
    async () => {

      const cameraConfig = makeCameraConfig({ channels: G6_PRO_ENTRY_CHANNELS, featureFlags: { hasPackageCamera: true, hasSpeaker: false, isDoorbell: true } });
      const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
      const { controller, nvr } = buildTestNvr({ store });
      const accessory = makeTestAccessory("Test Doorbell", "uuid:two-way-audio-package");
      const camera = construct(nvr, accessory, new TestCameraProjection(cameraConfig.id, store));

      await settle();

      try {

        const packageAccessory = camera.packageCamera?.accessory as unknown as TestAccessory | undefined;

        assert.ok(packageAccessory, "the package camera was composed");

        // The vacuity guards: the parent and the package each hold a real delegate genuinely built without two-way audio, so the push below is a real transition
        // for each.
        assert.ok(camera.stream, "the parent holds a delegate");
        assert.ok(camera.packageCamera?.stream, "the package holds a delegate");
        assert.equal(camera.stream.builtFor.twoWayAudio, false, "the parent's controller was built with two-way audio off");
        assert.equal(camera.packageCamera.stream.builtFor.twoWayAudio, false, "the package's controller was built with two-way audio off");

        const parentBaseline = accessory.controllerEvents.length;
        const packageBaseline = packageAccessory.controllerEvents.length;

        store.pushCameraFeatureFlags(cameraConfig.id, { hasSpeaker: true });

        await settle();

        // Removing the parent's re-check of the package leaves the package's controller untouched -> RED.
        assert.deepEqual(accessory.controllerEvents.slice(parentBaseline).map((event) => event.kind), [ "remove", "configure" ],
          "the parent rebuilt its controller exactly once");
        assert.deepEqual(packageAccessory.controllerEvents.slice(packageBaseline).map((event) => event.kind), [ "remove", "configure" ],
          "the package rebuilt its controller exactly once, in the same pass");
        assert.equal(camera.packageCamera.stream.builtFor.twoWayAudio, true, "the package's rebuilt controller is built for two-way audio");
      } finally {

        camera.cleanup();

        controller.abort();
      }
    });
});

/* HomeKit Secure Video eligibility observed live. A camera's eligibility is the controller's motion report, featureFlags.hasMotionDetection, for a first-party and a
 * third-party camera alike, and the camera follows it through the eligibility observer and the chokepoint's leaf: a gain stands the motion sensor up first and then
 * rebuilds the controller once, carrying the recording arm and the motion link; a withdrawal warns once and removes nothing, while the controller's all-false drain
 * frame warns nothing; a reading taken while the camera is not connected waits for the connect; and the package camera follows its parent through the parent's pass.
 * Every withdrawal row's camera carries a microphone, so its withdrawal block keeps a true flag and reads as a withdrawal rather than as the drain frame.
 */
describe("the camera capability reconcile - HomeKit Secure Video eligibility", () => {

  // The gain and withdrawal lines, each naming the controller's motion report, which every camera's eligibility follows alike.
  const GAIN = "Protect now exposes a motion sensor for this camera, making HomeKit Secure Video support available.";
  const LOSS = "Protect no longer exposes a motion sensor for this camera. Its motion sensor and HomeKit Secure Video support will remain in HomeKit until " +
    "HBUP restarts.";

  // The smart-motion overlap advisory an eligible camera with smart detection enabled logs.
  const OVERLAP = "Smart motion detection and HomeKit Secure Video provide overlapping functionality.";

  // The handles a row reads: the camera, its accessory, its store, and the harness around it.
  interface EligibilityCamera {

    accessory: TestAccessory;
    camera: ProtectCamera;
    harness: ReturnType<typeof buildTestNvr>;
    store: TestStateStore;
  }

  // Build a real camera from a config and settle it. The harness controller is captured by buildTestNvr for the suite's drain.
  const build = async (options: { cameraConfig: ProtectCameraConfig; mqtt?: boolean; userOptions?: string[] }): Promise<EligibilityCamera> => {

    const store = new TestStateStore(makeProtectState({ cameras: [options.cameraConfig] }));
    const harness = buildTestNvr({ mqtt: options.mqtt, store, userOptions: options.userOptions });
    const accessory = makeTestAccessory("Test Camera", "uuid:hksv-eligibility");
    const camera = construct(harness.nvr, accessory, new TestCameraProjection(options.cameraConfig.id, store));

    await settle();

    return { accessory, camera, harness, store };
  };

  // The count of log lines at one level carrying a fragment, read from a baseline index on so each assertion windows exactly the push it is about.
  const countLines = (entries: readonly TestLogEntry[], level: TestLogEntry["level"], fragment: string, from = 0): number => {

    return logCount(entries.slice(from), level, fragment);
  };

  // The controller events an accessory logged from a baseline on, by kind.
  const churnSince = (accessory: TestAccessory, from: number): string[] => accessory.controllerEvents.slice(from).map((event) => event.kind);

  // The count of motion MQTT registrations of one kind on the default camera's MAC-scoped topic.
  const motionRegistrations = (harness: EligibilityCamera["harness"], kind: "get" | "set"): number => {

    return harness.mqtt?.subscriptions.filter((subscription) => (subscription.kind === kind) && (subscription.topic === ("74ACB9000001/motion/" + kind))).length ?? 0;
  };

  // The camera's HKSV recording switch, looked up by its reserved subtype exactly as production acquires it.
  const recordingSwitch = (accessory: TestAccessory): TestService | undefined => accessory.getServiceById(Service.Switch, ProtectReservedNames.SWITCH_HKSV_RECORDING);

  test("a third-party camera Protect starts exposing a motion sensor for gains its motion sensor, then one rebuild carrying recording and the motion link " +
    "(fails without the leaf, fails with the leaf after the tamper leaf)", async () => {

    // A third-party camera Protect exposes no motion sensor for, carrying a microphone and reporting tamper detection with the setting on. It cannot back HKSV, so it
    // constructs with no motion sensor and a controller built without eligibility.
    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { hasMic: true, hasMotionDetection: false, hasTamperDetection: true },
      isThirdPartyCamera: true, smartDetectSettings: { enableTamperDetection: true } });
    const { accessory, camera, harness, store } = await build({ cameraConfig, mqtt: true });

    try {

      assert.equal(motionSensor(accessory), undefined, "a camera that cannot back HKSV constructs with no motion sensor");
      assert.equal(camera.stream?.builtFor.hksvCapable, false, "the construction-built controller is built without HKSV eligibility");
      assert.equal(motionRegistrations(harness, "get") + motionRegistrations(harness, "set"), 0, "no motion MQTT is registered without the sensor");

      const churnBaseline = accessory.controllerEvents.length;
      const createBaseline = harness.factory.createCalls.length;
      const logBaseline = harness.logEntries.length;

      store.pushCameraFeatureFlags(cameraConfig.id, { hasMotionDetection: true });

      await settle();

      // The leaf stood the motion sensor up dressed: its resting state, StatusActive from reachability, and its motion MQTT. The leaf runs ahead of the tamper leaf, so
      // the same pass dressed the new sensor with StatusTampered bound to the camera's tamper latch; moving the leaf after the tamper leaf leaves it absent -> RED.
      const sensor = motionSensor(accessory);

      assert.ok(sensor, "the gain created the motion sensor");
      assert.equal(sensor.getCharacteristic(Characteristic.MotionDetected).value, false, "MotionDetected initialized to false");
      assert.equal(sensor.getCharacteristic(Characteristic.StatusActive).value, true, "StatusActive initialized from reachability");
      assert.equal(motionRegistrations(harness, "get"), 1, "the motion MQTT get registered once");
      assert.equal(motionRegistrations(harness, "set"), 1, "the motion MQTT set registered once");
      assert.equal(sensor.testCharacteristic(Characteristic.StatusTampered), true, "the tamper leaf dressed the new sensor with StatusTampered in the same pass");

      camera.isTampered = true;

      assert.equal(await sensor.getCharacteristic(Characteristic.StatusTampered).triggerGet(), true, "StatusTampered is bound to the camera's tamper latch");

      // Then exactly one rebuild, whose controller was built with the sensor already standing and for each risen term.
      assert.deepEqual(churnSince(accessory, churnBaseline), [ "remove", "configure" ], "the gain rebuilt the controller exactly once, remove then configure");
      assert.equal(harness.factory.createCalls.length - createBaseline, 1, "exactly one controller was built for the gain");
      assert.equal(harness.factory.createCalls.at(-1)?.motionSensorPresent, true, "the motion sensor stood when the rebuilt controller was built");
      assert.equal(camera.stream.builtFor.hksvCapable, true, "the rebuilt controller is built for HKSV eligibility");
      assert.equal(countLines(harness.logEntries, "info", GAIN, logBaseline), 1, "exactly one info line narrates the gain");
    } finally {

      camera.cleanup();
    }
  });

  test("a first-party camera Protect starts exposing a motion sensor for gains its motion sensor and one rebuild, with one gain line", async () => {

    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { hasMic: true, hasMotionDetection: false } });
    const { accessory, camera, harness, store } = await build({ cameraConfig });

    try {

      assert.equal(motionSensor(accessory), undefined, "a camera Protect exposes no motion sensor for constructs with no motion sensor");
      assert.equal(camera.stream?.builtFor.hksvCapable, false, "the construction-built controller is built without HKSV eligibility");

      const churnBaseline = accessory.controllerEvents.length;
      const logBaseline = harness.logEntries.length;

      store.pushCameraFeatureFlags(cameraConfig.id, { hasMotionDetection: true });

      await settle();

      assert.ok(motionSensor(accessory), "the motion report created the motion sensor");
      assert.deepEqual(churnSince(accessory, churnBaseline), [ "remove", "configure" ], "the motion report rebuilt the controller exactly once, remove then configure");
      assert.equal(camera.stream.builtFor.hksvCapable, true, "the rebuilt controller is built for HKSV eligibility");
      assert.equal(countLines(harness.logEntries, "info", GAIN, logBaseline), 1, "exactly one info line narrates the gain");
    } finally {

      camera.cleanup();
    }
  });

  test("a motion report taken while the camera is disconnected creates nothing and rebuilds nothing until the camera connects (fails without the connected gate, " +
    "fails without the connect re-run)", async () => {

    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { hasMic: true, hasMotionDetection: false } });
    const { accessory, camera, harness, store } = await build({ cameraConfig });

    try {

      store.pushCameraPatch(cameraConfig.id, { state: "DISCONNECTED" });

      await settle();

      const churnBaseline = accessory.controllerEvents.length;
      const logBaseline = harness.logEntries.length;

      store.pushCameraFeatureFlags(cameraConfig.id, { hasMotionDetection: true });

      await settle();

      assert.equal(motionSensor(accessory), undefined, "the motion report read while disconnected created no motion sensor");
      assert.deepEqual(churnSince(accessory, churnBaseline), [], "the motion report read while disconnected rebuilt nothing");
      assert.equal(countLines(harness.logEntries, "info", GAIN, logBaseline), 0, "no gain is narrated while the camera is away");

      store.pushCameraPatch(cameraConfig.id, { state: "CONNECTED" });

      await settle();

      assert.ok(motionSensor(accessory), "the connect landed the gain's motion sensor");
      assert.deepEqual(churnSince(accessory, churnBaseline), [ "remove", "configure" ], "the connect landed exactly one rebuild");
      assert.equal(camera.stream?.builtFor.hksvCapable, true, "the rebuilt controller is built for HKSV eligibility");
      assert.equal(countLines(harness.logEntries, "info", GAIN, logBaseline), 1, "the gain is narrated once, on connect");
    } finally {

      camera.cleanup();
    }
  });

  test("an eligibility that comes and goes while the camera is disconnected creates nothing, rebuilds nothing, and warns nothing", async () => {

    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { hasMic: true, hasMotionDetection: false } });
    const { accessory, camera, harness, store } = await build({ cameraConfig });

    try {

      store.pushCameraPatch(cameraConfig.id, { state: "DISCONNECTED" });

      await settle();

      const churnBaseline = accessory.controllerEvents.length;
      const logBaseline = harness.logEntries.length;

      store.pushCameraFeatureFlags(cameraConfig.id, { hasMotionDetection: true });

      await settle();

      store.pushCameraFeatureFlags(cameraConfig.id, { hasMotionDetection: false });

      await settle();

      store.pushCameraPatch(cameraConfig.id, { state: "CONNECTED" });

      await settle();

      assert.equal(motionSensor(accessory), undefined, "no motion sensor was created");
      assert.deepEqual(churnSince(accessory, churnBaseline), [], "no controller was rebuilt");
      assert.equal(countLines(harness.logEntries, "warn", "HomeKit Secure Video", logBaseline), 0, "no withdrawal was warned");
      assert.equal(countLines(harness.logEntries, "info", "HomeKit Secure Video", logBaseline), 0, "no gain was narrated");
    } finally {

      camera.cleanup();
    }
  });

  test("a withdrawal warns once, removes nothing, and an unrelated chokepoint wake adds no second warning (fails with the warning in the leaf)", async () => {

    // A third-party camera carrying a microphone, so the withdrawal's block keeps a true flag and is a reading rather than the controller's drain frame.
    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { hasMic: true }, isThirdPartyCamera: true });
    const { accessory, camera, harness, store } = await build({ cameraConfig });

    try {

      const sensor = motionSensor(accessory);

      assert.ok(sensor, "an eligible camera constructs with its motion sensor");
      assert.equal(camera.stream?.builtFor.hksvCapable, true, "the construction-built controller is built for HKSV eligibility");

      const churnBaseline = accessory.controllerEvents.length;
      const logBaseline = harness.logEntries.length;

      store.pushCameraFeatureFlags(cameraConfig.id, { hasMotionDetection: false });

      await settle();

      assert.equal(countLines(harness.logEntries, "warn", LOSS, logBaseline), 1, "exactly one warning narrates the withdrawal");
      assert.deepEqual(churnSince(accessory, churnBaseline), [], "the withdrawal fired zero controller events");
      assert.equal(motionSensor(accessory), sensor, "the motion sensor remains");
      assert.equal(camera.stream.builtFor.hksvCapable, true, "the standing controller keeps its HKSV eligibility term");

      // An unrelated setting change re-runs the chokepoint with no rising edge. The leaf narrates nothing, so the warning stays single; narrating the withdrawal in the
      // leaf repeats it here -> RED.
      store.pushCameraPatch(cameraConfig.id, cameraPatch({ smartDetectSettings: { enableTamperDetection: true } }));

      await settle();

      assert.equal(countLines(harness.logEntries, "warn", LOSS, logBaseline), 1, "the unrelated wake added no second warning");
      assert.deepEqual(churnSince(accessory, churnBaseline), [], "the unrelated wake fired zero controller events");
    } finally {

      camera.cleanup();
    }
  });

  /* The controller's drain frame against a real withdrawal. A deep re-adopt delivers the whole featureFlags block with every flag false before the real values follow,
   * and that block reads the motion report false too, so the narrator has to read it as no reading: nothing is logged, removed, or rebuilt. Once the real values land,
   * a genuine withdrawal - the report false beside a microphone the block still reports - warns exactly once. Removing the guard warns on the drain -> RED; a guard that
   * skips every false withdrawal stays silent on the real one -> RED.
   */
  test("the drain frame logs nothing, removes nothing and churns nothing, while a withdrawal beside a true flag warns once", async () => {

    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { hasMic: true } });
    const { accessory, camera, harness, store } = await build({ cameraConfig });

    try {

      const sensor = motionSensor(accessory);

      assert.ok(sensor, "an eligible camera constructs with its motion sensor");

      const churnBaseline = accessory.controllerEvents.length;
      const logBaseline = harness.logEntries.length;

      store.pushCameraFeatureFlagsDrain(cameraConfig.id);

      await settle();

      assert.equal(camera.isHksvCapable, false, "the vacuity guard: the drain frame reads the motion report false");
      assert.equal(harness.logEntries.length, logBaseline, "the drain frame logged nothing");
      assert.equal(motionSensor(accessory), sensor, "the motion sensor remains across the drain frame");
      assert.deepEqual(churnSince(accessory, churnBaseline), [], "the drain frame fired zero controller events");

      // The real values land, then the controller genuinely stops reporting the motion sensor while the microphone stays reported.
      store.pushCameraFeatureFlags(cameraConfig.id, { hasMic: true, hasMotionDetection: true });

      await settle();

      store.pushCameraFeatureFlags(cameraConfig.id, { hasMotionDetection: false });

      await settle();

      assert.equal(countLines(harness.logEntries, "warn", LOSS, logBaseline), 1, "the genuine withdrawal warned exactly once");
      assert.equal(motionSensor(accessory), sensor, "the motion sensor remains after the withdrawal");
      assert.deepEqual(churnSince(accessory, churnBaseline), [], "neither the drain nor the withdrawal fired a controller event");
    } finally {

      camera.cleanup();
    }
  });

  test("a withdrawn camera made eligible again logs nothing and rebuilds nothing", async () => {

    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { hasMic: true }, isThirdPartyCamera: true });
    const { accessory, camera, harness, store } = await build({ cameraConfig });

    try {

      store.pushCameraFeatureFlags(cameraConfig.id, { hasMotionDetection: false });

      await settle();

      const churnBaseline = accessory.controllerEvents.length;
      const logBaseline = harness.logEntries.length;

      store.pushCameraFeatureFlags(cameraConfig.id, { hasMotionDetection: true });

      await settle();

      assert.equal(harness.logEntries.length, logBaseline, "the regain logged nothing");
      assert.deepEqual(churnSince(accessory, churnBaseline), [], "the regain rebuilt nothing");
    } finally {

      camera.cleanup();
    }
  });

  test("a repeated eligible reading after a gain, and an unrelated wake after it, rebuild nothing and narrate nothing (the sensor is the latch)", async () => {

    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { hasMotionDetection: false }, isThirdPartyCamera: true });
    const { accessory, camera, harness, store } = await build({ cameraConfig });

    try {

      store.pushCameraFeatureFlags(cameraConfig.id, { hasMotionDetection: true });

      await settle();

      assert.ok(motionSensor(accessory), "the gain created the motion sensor");

      const churnBaseline = accessory.controllerEvents.length;
      const logBaseline = harness.logEntries.length;

      // The same reading again, then an unrelated capability that wakes the chokepoint: the standing sensor answers the leaf, so neither does anything.
      store.pushCameraFeatureFlags(cameraConfig.id, { hasMotionDetection: true });

      await settle();

      store.pushCameraFeatureFlags(cameraConfig.id, { hasLedStatus: true });

      await settle();

      assert.deepEqual(churnSince(accessory, churnBaseline), [], "nothing rebuilt the controller again");
      assert.equal(countLines(harness.logEntries, "info", GAIN, logBaseline), 0, "the gain was not narrated again");
      assert.equal(accessory.services.filter((service) => service.type === Service.MotionSensor).length, 1, "exactly one motion sensor stands");
    } finally {

      camera.cleanup();
    }
  });

  test("a camera with no channel gains eligibility, then its channels arrive, and its first controller is built with the sensor in place", async () => {

    // No channel exists yet, so the derivation returns nothing and no delegate stands while the gain composes the sensor.
    const cameraConfig = makeCameraConfig({ channels: [], featureFlags: { hasMotionDetection: false } });
    const { accessory, camera, harness, store } = await build({ cameraConfig });

    try {

      assert.equal(camera.stream, undefined, "no delegate stands for a camera with no channel");
      assert.deepEqual(churnSince(accessory, 0), [], "no controller was ever registered");

      store.pushCameraFeatureFlags(cameraConfig.id, { hasMotionDetection: true });

      await settle();

      assert.ok(motionSensor(accessory), "the gain created the motion sensor");
      assert.equal(camera.stream, undefined, "the gain built no controller, since there is still nothing to advertise");

      store.pushCameraPatch(cameraConfig.id, { channels: G2_PRO_CHANNELS });

      await settle();

      const create = harness.factory.createCalls.at(-1);

      assert.ok(motionSensor(accessory), "the gain created the motion sensor");
      assert.deepEqual(churnSince(accessory, 0), ["configure"], "the channels established the first controller: one configure and zero remove");
      assert.ok(create, "the channels built a controller");
      assert.equal(camera.stream, create.delegate, "the camera holds the delegate the channels built");
      assert.equal(create.motionSensorPresent, true, "the motion sensor stood when the first controller was built");
      assert.equal(create.delegate.builtFor.hksvCapable, true, "the first controller is built for HKSV eligibility");
    } finally {

      camera.cleanup();
    }
  });

  test("a doorbell promotion and a motion report in one featureFlags patch compose the doorbell capability and fire exactly two controller events", async () => {

    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { hasMotionDetection: false } });
    const { accessory, camera, store } = await build({ cameraConfig });

    try {

      assert.equal(camera.doorbell, null, "the camera starts plain");

      const churnBaseline = accessory.controllerEvents.length;

      store.pushCameraFeatureFlags(cameraConfig.id, { hasMotionDetection: true, isDoorbell: true });

      await settle();

      assert.ok(camera.doorbell, "the doorbell capability composed onto the camera");
      assert.ok(motionSensor(accessory), "the motion report created the motion sensor");
      assert.deepEqual(churnSince(accessory, churnBaseline), [ "remove", "configure" ], "the doorbell promotion and the motion report landed in exactly one rebuild");
      assert.equal(camera.stream?.builtFor.isDoorbell, true, "the rebuilt controller is built for a doorbell");
      assert.equal(camera.stream.builtFor.hksvCapable, true, "the rebuilt controller is built for HKSV eligibility");
    } finally {

      camera.cleanup();
    }
  });

  test("a doorbell Protect starts exposing a motion sensor for rebuilds the parent and its package camera once each, and the package says nothing", async () => {

    const cameraConfig = makeCameraConfig({ channels: G6_PRO_ENTRY_CHANNELS, featureFlags: { hasMotionDetection: false, hasPackageCamera: true, isDoorbell: true } });
    const { accessory, camera, harness, store } = await build({ cameraConfig });

    try {

      const packageAccessory = camera.packageCamera?.accessory as unknown as TestAccessory | undefined;

      assert.ok(packageAccessory, "the package camera was composed");
      assert.equal(camera.packageCamera?.stream?.builtFor.hksvCapable, false, "the package's controller was built without HKSV eligibility");

      const parentBaseline = accessory.controllerEvents.length;
      const packageBaseline = packageAccessory.controllerEvents.length;
      const logBaseline = harness.logEntries.length;

      store.pushCameraFeatureFlags(cameraConfig.id, { hasMotionDetection: true });

      await settle();

      assert.deepEqual(churnSince(accessory, parentBaseline), [ "remove", "configure" ], "the parent rebuilt its controller exactly once");
      assert.deepEqual(churnSince(packageAccessory, packageBaseline), [ "remove", "configure" ], "the package rebuilt its controller exactly once");
      assert.equal(camera.packageCamera.stream.builtFor.hksvCapable, true, "the package's rebuilt controller is built for HKSV eligibility");
      assert.equal(harness.logEntries.slice(logBaseline).filter((entry) => formatLogEntry(entry).includes("Package Camera")).length, 0,
        "the package camera logged no line of its own");
    } finally {

      camera.cleanup();
    }
  });

  test("a camera that cannot back HKSV constructs with no recording switch, even with the switch option on", async () => {

    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { hasMotionDetection: false } });
    const { accessory, camera } = await build({ cameraConfig, userOptions: ["Enable.Video.HKSV.Recording.Switch"] });

    try {

      assert.equal(recordingSwitch(accessory), undefined, "no recording switch stands for a camera with no recording arm");
    } finally {

      camera.cleanup();
    }
  });

  test("the gain creates the recording switch the option asks for", async () => {

    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { hasMotionDetection: false } });
    const { accessory, camera, store } = await build({ cameraConfig, userOptions: ["Enable.Video.HKSV.Recording.Switch"] });

    try {

      store.pushCameraFeatureFlags(cameraConfig.id, { hasMotionDetection: true });

      await settle();

      const service = recordingSwitch(accessory);

      assert.ok(service, "the gain created the recording switch");
      assert.equal(service.getCharacteristic(Characteristic.On).value, true, "the new switch reads recording enabled");
    } finally {

      camera.cleanup();
    }
  });

  test("a doorbell whose motion report arrives while it is disconnected rebuilds neither view until it connects, then each once (fails without the parent's " +
    "connect re-run reaching the package)", async () => {

    const cameraConfig = makeCameraConfig({ channels: G6_PRO_ENTRY_CHANNELS, featureFlags: { hasMotionDetection: false, hasPackageCamera: true, isDoorbell: true } });
    const { accessory, camera, store } = await build({ cameraConfig });

    try {

      const packageAccessory = camera.packageCamera?.accessory as unknown as TestAccessory | undefined;

      assert.ok(packageAccessory, "the package camera was composed");

      store.pushCameraPatch(cameraConfig.id, { state: "DISCONNECTED" });

      await settle();

      const parentBaseline = accessory.controllerEvents.length;
      const packageBaseline = packageAccessory.controllerEvents.length;

      store.pushCameraFeatureFlags(cameraConfig.id, { hasMotionDetection: true });

      await settle();

      assert.deepEqual(churnSince(accessory, parentBaseline), [], "the parent rebuilt nothing while disconnected");
      assert.deepEqual(churnSince(packageAccessory, packageBaseline), [], "the package rebuilt nothing while disconnected");

      store.pushCameraPatch(cameraConfig.id, { state: "CONNECTED" });

      await settle();

      assert.deepEqual(churnSince(accessory, parentBaseline), [ "remove", "configure" ], "the connect rebuilt the parent exactly once");
      assert.deepEqual(churnSince(packageAccessory, packageBaseline), [ "remove", "configure" ], "the connect rebuilt the package exactly once");
    } finally {

      camera.cleanup();
    }
  });

  test("the gain on a camera with smart detection enabled logs the overlap advisory exactly once more", async () => {

    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { hasMotionDetection: false, hasSmartDetect: true, smartDetectTypes: ["person"] } });
    const { camera, harness, store } = await build({ cameraConfig, userOptions: ["Enable.Motion.SmartDetect"] });

    try {

      const logBaseline = harness.logEntries.length;

      assert.equal(countLines(harness.logEntries, "warn", OVERLAP), 0, "a camera that cannot back HKSV logs no overlap advisory at construction");

      store.pushCameraFeatureFlags(cameraConfig.id, { hasMotionDetection: true });

      await settle();

      assert.equal(countLines(harness.logEntries, "warn", OVERLAP, logBaseline), 1, "the gain logged the overlap advisory exactly once");
    } finally {

      camera.cleanup();
    }
  });

  test("a first-party camera Protect stops exposing a motion sensor for warns once with the loss line", async () => {

    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { hasMic: true } });
    const { accessory, camera, harness, store } = await build({ cameraConfig });

    try {

      const churnBaseline = accessory.controllerEvents.length;
      const logBaseline = harness.logEntries.length;

      store.pushCameraFeatureFlags(cameraConfig.id, { hasMotionDetection: false });

      await settle();

      assert.equal(countLines(harness.logEntries, "warn", LOSS, logBaseline), 1, "exactly one warning narrates the withdrawal");
      assert.equal(harness.logEntries.slice(logBaseline).filter((entry) => entry.level === "warn").length, 1, "the loss line is the withdrawal's only warning");
      assert.deepEqual(churnSince(accessory, churnBaseline), [], "the withdrawal fired zero controller events");
      assert.ok(motionSensor(accessory), "the motion sensor remains");
    } finally {

      camera.cleanup();
    }
  });

  test("an eligibility flap within one drain logs nothing and churns nothing (fails when the handler trusts the yielded value)", async () => {

    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { hasMic: true } });
    const { accessory, camera, harness, store } = await build({ cameraConfig });

    try {

      const churnBaseline = accessory.controllerEvents.length;
      const logBaseline = harness.logEntries.length;

      // Withdrawn and restored before any consumer drains: the observer yields the false and then the true, and each wake reads the live, recovered state. The
      // microphone keeps the withdrawal's block a reading rather than the drain frame, so only the live read keeps it silent.
      store.pushCameraFeatureFlags(cameraConfig.id, { hasMotionDetection: false });
      store.pushCameraFeatureFlags(cameraConfig.id, { hasMotionDetection: true });

      await settle();

      assert.equal(harness.logEntries.length, logBaseline, "the flap logged nothing");
      assert.deepEqual(churnSince(accessory, churnBaseline), [], "the flap churned nothing");
    } finally {

      camera.cleanup();
    }
  });

  test("a record that vanishes and returns with eligibility unchanged logs nothing and churns nothing", async () => {

    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS });
    const { accessory, camera, harness, store } = await build({ cameraConfig });

    try {

      const churnBaseline = accessory.controllerEvents.length;
      const logBaseline = harness.logEntries.length;

      // The record leaves and returns before any consumer drains, so the eligibility observer yields the absent reading and then the eligible one with the record
      // present at each wake: reading the absent value as a withdrawal would warn here.
      store.removeCameraRecord(cameraConfig.id);

      // While the record is absent, the eligibility getter reads false through the record rather than throwing, the vanished-record reading the ledger blesses.
      assert.equal(camera.isHksvCapable, false, "the eligibility getter reads false over the vanished record");

      store.addCameraRecord(cameraConfig);

      await settle();

      assert.equal(harness.logEntries.length, logBaseline, "the vanish and return logged nothing");
      assert.deepEqual(churnSince(accessory, churnBaseline), [], "the vanish and return churned nothing");
    } finally {

      camera.cleanup();
    }
  });

  test("after a withdrawal, a late speaker rebuilds once from current truth, building no recording arm, with no further warning", async () => {

    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { hasMic: true }, isThirdPartyCamera: true });
    const { accessory, camera, harness, store } = await build({ cameraConfig });

    try {

      store.pushCameraFeatureFlags(cameraConfig.id, { hasMotionDetection: false });

      await settle();

      const churnBaseline = accessory.controllerEvents.length;
      const logBaseline = harness.logEntries.length;

      store.pushCameraFeatureFlags(cameraConfig.id, { hasSpeaker: true });

      await settle();

      assert.deepEqual(churnSince(accessory, churnBaseline), [ "remove", "configure" ], "the late speaker rebuilt the controller exactly once");
      assert.equal(camera.stream?.builtFor.twoWayAudio, true, "the rebuilt controller is built for two-way audio");
      assert.equal(camera.stream.builtFor.hksvCapable, false, "the rebuilt controller reads eligibility live and is built without it");
      assert.equal(countLines(harness.logEntries, "warn", "HomeKit Secure Video", logBaseline), 0, "the rebuild warned nothing further");
    } finally {

      camera.cleanup();
    }
  });
});

describe("the camera capability reconcile - the smart-detect contact sensors", () => {

  test("with smart detection and the object-sensors option, every advertised detection type materializes its own contact sensor", async () => {

    // Both halves of the smartDetect derivation must be present - the hasSmartDetect hardware flag and Enable.Motion.SmartDetect, which defaults OFF - and
    // Enable.Motion.SmartDetect.ObjectSensors, also default OFF, is the second gate that turns that derivation into per-type sensors. Two advertised types exercise the
    // per-type fan-out rather than a single-sensor special case.
    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { hasSmartDetect: true, smartDetectTypes: [ "person", "vehicle" ] } });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { nvr } = buildTestNvr({ store, userOptions: [ "Enable.Motion.SmartDetect", "Enable.Motion.SmartDetect.ObjectSensors" ] });
    const accessory = makeTestAccessory("Test Camera", "uuid:smart-detect-1");
    const camera = construct(nvr, accessory, new TestCameraProjection(cameraConfig.id, store));

    await settle();

    try {

      // HARD-assert each gated sensor EXISTS as the FIRST check, subtyped by its own detection type, so an absent service throws here rather than letting the state
      // assertion below pass vacuously.
      const person = smartDetectSensor(accessory, "person");
      const vehicle = smartDetectSensor(accessory, "vehicle");

      assert.ok(person, "the person detection type materialized its own subtyped contact sensor");
      assert.ok(vehicle, "the vehicle detection type materialized its own subtyped contact sensor");

      // Each sensor is initialized to contact-detected, the at-rest state a later smart-detect delivery moves.
      assert.equal(person.getCharacteristic(Characteristic.ContactSensorState).value, Characteristic.ContactSensorState.CONTACT_DETECTED,
        "the person contact sensor is initialized at rest, in the contact-detected state");
    } finally {

      camera.cleanup();
    }
  });

  test("without the object-sensors option, smart detection alone materializes no per-type contact sensors", async () => {

    // The negative control isolates the object-sensors half of the gate: the same smart-capable, smart-enabled camera carrying only Enable.Motion.SmartDetect. The
    // subtype prefix matched below carries its trailing separator, so the count never picks up the separately-gated license-plate sensors.
    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { hasSmartDetect: true, smartDetectTypes: [ "person", "vehicle" ] } });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { nvr } = buildTestNvr({ store, userOptions: ["Enable.Motion.SmartDetect"] });
    const accessory = makeTestAccessory("Test Camera", "uuid:smart-detect-2");
    const camera = construct(nvr, accessory, new TestCameraProjection(cameraConfig.id, store));

    await settle();

    try {

      const objectSensors = accessory.services.filter((service) => service.subtype?.startsWith(ProtectReservedNames.CONTACT_MOTION_SMARTDETECT + "."));

      assert.equal(objectSensors.length, 0, "with the object-sensors option omitted, no detection type materializes a contact sensor");
    } finally {

      camera.cleanup();
    }
  });

  test("a late hasSmartDetect materializes every advertised type's sensor live and narrates the set exactly once (self-heal + the counted log)", async () => {

    // A camera the controller adopts WITHOUT smart detection, both user options on. The hints derive false at construction, so no sensor exists and the delivery gate is
    // shut; the controller then finishes provisioning and reports the capability alongside the types it advertises.
    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { hasSmartDetect: false, smartDetectTypes: [ "person", "vehicle" ] } });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { logEntries, nvr } = buildTestNvr({ store, userOptions: [ "Enable.Motion.SmartDetect", "Enable.Motion.SmartDetect.ObjectSensors" ] });
    const accessory = makeTestAccessory("Test Camera", "uuid:smart-detect-3");

    // Count the captured summary lines. A COUNT, not a boolean: the establishment entry persists in the buffer, so a boolean could not tell a once-narrated set from a
    // twice-narrated one.
    const summaryLogCount = (): number => {

      return logCount(logEntries, "info", "Smart motion contact sensor");
    };

    const camera = construct(nvr, accessory, new TestCameraProjection(cameraConfig.id, store));

    await settle();

    try {

      // The vacuity guard: neither sensor exists before the push, so their appearance is a real transition.
      assert.equal(smartDetectSensor(accessory, "person"), undefined, "no person contact sensor exists before the controller reports smart detection");
      assert.equal(smartDetectSensor(accessory, "vehicle"), undefined, "no vehicle contact sensor exists before the controller reports smart detection");
      assert.equal(summaryLogCount(), 0, "nothing was narrated while the capability was absent");

      // The controller finishes provisioning and now reports smart detection.
      store.pushCameraFeatureFlags(cameraConfig.id, { hasSmartDetect: true });

      await settle();

      // Asserted per type, never as a service count: a count cannot tell a two-sensor fan-out apart from one service appearing. Removing the hints refresh leaves both
      // hints false and the add loop skipped -> RED; removing the reconcileSmartDetectSensors call from the chokepoint leaves the same -> RED.
      assert.ok(smartDetectSensor(accessory, "person"), "the late capability materialized the person contact sensor without a restart");
      assert.ok(smartDetectSensor(accessory, "vehicle"), "the late capability materialized the vehicle contact sensor without a restart");
      assert.equal(summaryLogCount(), 1, "the creation narrated the enabled set exactly once");

      // A second, unrelated capability push drives another reconcile pass over the now-existing sensors: nothing is created, so nothing is narrated.
      store.pushCameraFeatureFlags(cameraConfig.id, { hasLedStatus: true });

      await settle();

      // Still exactly one. Moving the summary back to the unconditional tail leaves this pass narrating again -> count 2 -> RED.
      assert.equal(summaryLogCount(), 1, "the no-op reconcile stayed silent - the count stays one");
    } finally {

      camera.cleanup();
    }
  });

  test("a late hasSmartDetect also opens delivery, so a smart detection trips the new sensor (the hints refresh, not just the sensor set)", async () => {

    // The other half of the live arrival: event-dispatch gates ALL smart-detect delivery on the cached hints.smartDetect, so a fold that created the sensors without
    // refreshing the hint would leave visible-but-dead sensors. We drive the REAL dispatch's delivery and assert the sensor actually moves.
    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { hasSmartDetect: false, smartDetectTypes: ["person"] } });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { nvr } = buildTestNvr({ store, userOptions: [ "Enable.Motion.SmartDetect", "Enable.Motion.SmartDetect.ObjectSensors" ] });
    const accessory = makeTestAccessory("Test Camera", "uuid:smart-detect-4");
    const camera = construct(nvr, accessory, new TestCameraProjection(cameraConfig.id, store));

    await settle();

    // The delivery arms a motionDuration reset timer on the double's test clock, which this test never advances, so the detection's window stays open.
    try {

      store.pushCameraFeatureFlags(cameraConfig.id, { hasSmartDetect: true });

      await settle();

      const person = smartDetectSensor(accessory, "person");

      assert.ok(person, "the late capability materialized the person contact sensor");
      assert.equal(person.getCharacteristic(Characteristic.ContactSensorState).value, Characteristic.ContactSensorState.CONTACT_DETECTED,
        "the freshly created sensor sits at rest before the detection");

      // A smart-object detection for the newly advertised type, delivered exactly as the firehose router delivers it.
      nvr.events.motionEventHandler(camera, ["person"]);

      // Refreshing only hints.smartDetectSensors (the sensor-set half) while leaving hints.smartDetect false materializes the sensor above but leaves the delivery gate
      // shut, so the detection never reaches the sensor -> RED. This is the assertion that separates a working fold from a visible-but-dead one.
      assert.equal(person.getCharacteristic(Characteristic.ContactSensorState).value, Characteristic.ContactSensorState.CONTACT_NOT_DETECTED,
        "the smart detection tripped the newly materialized sensor - the delivery gate opened with it");
    } finally {

      camera.cleanup();
    }
  });

  test("a late hasSmartDetect keeps the occupancy sensor alive, since the refresh rebuilds the smart-occupancy list too", async () => {

    // The occupancy delivery gate reads BOTH derived hints: with smartDetect false any motion trips occupancy, and once smartDetect reads true only a detection whose
    // type is in smartOccupancy does. That list is filled by the base occupancy configure, which runs at construction and only when smartDetect is already true - so on a
    // camera whose capability arrives later, raising the flag without rebuilding the list would leave an empty list and an occupancy sensor that can never trip again.
    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { hasSmartDetect: false, smartDetectTypes: ["person"] } });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { nvr } = buildTestNvr({ store,
      userOptions: [ "Enable.Motion.OccupancySensor=person", "Enable.Motion.SmartDetect", "Enable.Motion.SmartDetect.ObjectSensors" ] });
    const accessory = makeTestAccessory("Test Camera", "uuid:smart-detect-11");
    const camera = construct(nvr, accessory, new TestCameraProjection(cameraConfig.id, store));

    await settle();

    try {

      const occupancy = accessory.getService(Service.OccupancySensor);

      assert.ok(occupancy, "the occupancy sensor exists");

      // The vacuity guard: the sensor is genuinely at rest before the detection, so the trip below is a real transition.
      assert.equal(occupancy.getCharacteristic(Characteristic.OccupancyDetected).value, false, "the occupancy sensor is at rest before the detection");

      // The capability arrives live, which raises hints.smartDetect and moves the occupancy gate onto its smart-detection branch.
      store.pushCameraFeatureFlags(cameraConfig.id, { hasSmartDetect: true });

      await settle();

      // A person detection - the type the user selected for occupancy.
      nvr.events.motionEventHandler(camera, ["person"]);

      // Deleting the hints.smartOccupancy assignment from the refresh leaves the list empty while smartDetect reads true, so the gate matches nothing and occupancy stays
      // at rest -> RED. Rebuilding the list on a rising edge only would pass here and go stale on the next type-set change instead.
      assert.equal(occupancy.getCharacteristic(Characteristic.OccupancyDetected).value, true,
        "the detection tripped occupancy after the live arrival - the refreshed smart-occupancy list matched its type");
    } finally {

      camera.cleanup();
    }
  });

  test("the smart-occupancy list follows a type-set change, not just the first fill (assignment, not a rising edge)", async () => {

    // The list is rebuilt by ASSIGNMENT on every pass, so it tracks the type set as it moves. A once-only fill would satisfy the live-arrival case above and then hold a
    // list the controller has since replaced, trading the flag's staleness for the list's. This camera adopts with person (selected for occupancy by default) and the
    // controller later swaps the reported type to vehicle, which the user has also selected.
    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { hasSmartDetect: true, smartDetectTypes: ["person"] } });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { nvr } = buildTestNvr({ store, userOptions: [ "Enable.Motion.OccupancySensor=person,vehicle", "Enable.Motion.SmartDetect" ] });
    const accessory = makeTestAccessory("Test Camera", "uuid:smart-detect-12");
    const camera = construct(nvr, accessory, new TestCameraProjection(cameraConfig.id, store));

    await settle();

    try {

      const occupancy = accessory.getService(Service.OccupancySensor);

      assert.ok(occupancy, "the occupancy sensor exists");
      assert.equal(occupancy.getCharacteristic(Characteristic.OccupancyDetected).value, false,
        "the occupancy sensor is at rest before the detection (the vacuity guard)");

      // The controller replaces the reported detection type, enabled on the Protect side.
      store.pushCameraPatch(cameraConfig.id, cameraPatch({ featureFlags: { ...cameraConfig.featureFlags, smartDetectTypes: ["vehicle"] },
        smartDetectSettings: { audioTypes: [], enableTamperDetection: false, objectTypes: ["vehicle"] } }));

      await settle();

      nvr.events.motionEventHandler(camera, ["vehicle"]);

      // Rebuilding the list only while it is empty leaves the construct-time ["person"] in place, so the vehicle detection matches nothing and occupancy stays at rest
      // -> RED. This is the pin that separates the assignment shape from a rising-edge fill.
      assert.equal(occupancy.getCharacteristic(Characteristic.OccupancyDetected).value, true,
        "the swapped-in detection type tripped occupancy - the list followed the controller's change");
    } finally {

      camera.cleanup();
    }
  });

  test("a detection the user disabled in Protect drives no occupancy either, even with its own occupancy option on", async () => {

    // The occupancy list reads the SAME delivered-type set the contact sensors do, so a detection the user switched off in Protect is absent from both. The hardware
    // advertises vehicle, the plugin's own occupancy option for vehicle is on, and the user has vehicle detection switched off on the controller - the one arrangement
    // where a list derived from the raw capability flags and a list derived from the delivered set disagree.
    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { hasSmartDetect: true, smartDetectTypes: [ "person", "vehicle" ] },
      smartDetectSettings: { objectTypes: ["person"] } });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { nvr } = buildTestNvr({ store, userOptions: [ "Enable.Motion.OccupancySensor=person,vehicle", "Enable.Motion.SmartDetect" ] });
    const accessory = makeTestAccessory("Test Camera", "uuid:smart-detect-13");
    const camera = construct(nvr, accessory, new TestCameraProjection(cameraConfig.id, store));

    await settle();

    try {

      // Person is delivered and carries its own default-on occupancy option, so it belongs; vehicle carries an occupancy option the test enabled explicitly and is
      // excluded anyway, because the camera does not deliver it. Deriving from featureFlags instead of the delivered set yields [ "person", "vehicle" ] -> RED.
      assert.deepEqual(camera.hints.smartOccupancy, ["person"],
        "the occupancy list holds the delivered detection and excludes the one the user disabled in Protect, despite its occupancy option being on");
    } finally {

      camera.cleanup();
    }
  });

  /* The camera's occupancy list has one derivation, read by the occupancy configure when it creates the service and by every reconcile pass after it, so the line the
   * configure logs at construction names the same delivered selection the reconcile holds. The hardware advertises person, vehicle, and animal; the user has vehicle
   * switched off in Protect; the occupancy selection names person and vehicle. A configure reading the hardware's list instead narrates "Person, Vehicle" -> RED.
   *
   * The row then carries the selection end to end: a canonical selection string resolves through the list-read wrapper in the wire casing the controller sends, and
   * the REAL event dispatcher's occupancy gate matches a delivered detection against exactly that list. A wrapper that answered catalog-cased names would leave the
   * list looking right and the gate matching nothing.
   */
  test("the occupancy configure and the reconcile read one derivation, and the dispatcher's occupancy gate matches against it", async () => {

    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { hasSmartDetect: true, smartDetectTypes: [ "person", "vehicle", "animal" ] },
      smartDetectSettings: { objectTypes: [ "person", "animal" ] } });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { logEntries, nvr } = buildTestNvr({ store, userOptions: [ "Enable.Motion.OccupancySensor=person,vehicle", "Enable.Motion.SmartDetect" ] });
    const accessory = makeTestAccessory("Test Camera", "uuid:smart-detect-14");
    const camera = construct(nvr, accessory, new TestCameraProjection(cameraConfig.id, store));

    await settle();

    try {

      assert.deepEqual(camera.hints.smartOccupancy, ["person"], "the occupancy list is the delivered selection, in the wire casing the controller sends");
      assert.equal(logCount(logEntries, "info", "Enabling occupancy sensor using smart motion detection: Person."), 1,
        "the occupancy configure narrated the delivered selection at construction");

      const occupancy = accessory.getService(Service.OccupancySensor);

      assert.ok(occupancy, "the occupancy service exists to be tripped");
      assert.equal(occupancy.getCharacteristic(Characteristic.OccupancyDetected).value, false, "the occupancy sensor is at rest before the detections");

      // An animal is a detection the camera delivers that the selection does not name, so the gate leaves occupancy clear.
      nvr.events.motionEventHandler(camera, ["animal"]);

      assert.notEqual(occupancy.getCharacteristic(Characteristic.OccupancyDetected).value, true, "a delivered detection outside the selection leaves occupancy clear");

      // The selected type trips it, which is the match the gate performs against the derivation's own answer.
      nvr.events.motionEventHandler(camera, ["person"]);

      assert.equal(occupancy.getCharacteristic(Characteristic.OccupancyDetected).value, true, "the selected type trips occupancy through the production gate");
    } finally {

      camera.cleanup();
    }
  });

  /* The end-to-end translation row for the occupancy selection, written in the retired grammar this plugin used before the selection was a picker: one option per
   * detection type, with mixed defaults - face and person on, everything else off. It is the only row in this file written that way, and it carries both the global
   * and the device-scoped shapes, because the two reach the runtime by different routes: a global retired entry is rescued by the current catalog's own reading of the
   * dotted form, while a device-scoped one addresses nothing at all there and reaches the camera only through the overlay. A camera whose owner has never opened the
   * settings page has to keep the occupancy sensor it configured years ago, and this is the row that says so.
   */
  test("a camera configured in the retired per-type occupancy grammar keeps its exact selection", async () => {

    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { hasSmartDetect: true, smartDetectTypes: [ "person", "vehicle" ] },
      smartDetectSettings: { objectTypes: [ "person", "vehicle" ] } });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));

    // Occupancy on globally, face subtracted globally, and vehicle added at this camera alone - the three-level shape a long-lived configuration actually carries.
    const { nvr } = buildTestNvr({ store, userOptions: [ "Enable.Motion.OccupancySensor", "Disable.Motion.OccupancySensor.Face",
      "Enable.Motion.OccupancySensor.Vehicle." + cameraConfig.mac, "Enable.Motion.SmartDetect" ] });
    const accessory = makeTestAccessory("Test Camera", "uuid:smart-detect-legacy");
    const camera = construct(nvr, accessory, new TestCameraProjection(cameraConfig.id, store));

    await settle();

    try {

      assert.ok(accessory.getService(Service.OccupancySensor), "the occupancy sensor the retired configuration asked for still exists");
      assert.deepEqual(camera.hints.smartOccupancy, [ "person", "vehicle" ],
        "person survives from the retired defaults and vehicle arrives from this camera's own entry, in the wire casing the controller delivers");
    } finally {

      camera.cleanup();
    }
  });

  test("with the capability present, a type the controller adds gains a sensor and a type it drops loses one (the per-type set, both directions)", async () => {

    // hasSmartDetect stays TRUE throughout, so this is the per-type SET reconciling live rather than a capability transition - the steady-state behavior, which the
    // withdrawal case below cannot stand in for. The set that matters is the intersection of the advertised capability with the user's Protect-side selection, so each
    // push below moves BOTH halves together, the way a controller that gains (or loses) a detection type reports it.
    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { hasSmartDetect: true, smartDetectTypes: ["person"] } });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { nvr } = buildTestNvr({ store, userOptions: [ "Enable.Motion.SmartDetect", "Enable.Motion.SmartDetect.ObjectSensors" ] });
    const accessory = makeTestAccessory("Test Camera", "uuid:smart-detect-5");
    const camera = construct(nvr, accessory, new TestCameraProjection(cameraConfig.id, store));

    await settle();

    try {

      assert.ok(smartDetectSensor(accessory, "person"), "the adopted type has its contact sensor");
      assert.equal(smartDetectSensor(accessory, "package"), undefined, "the not-yet-reported type has none (the vacuity guard for the add below)");

      // The controller starts reporting a second detection type, enabled on the Protect side.
      store.pushCameraPatch(cameraConfig.id, cameraPatch({ featureFlags: { ...cameraConfig.featureFlags, smartDetectTypes: [ "package", "person" ] },
        smartDetectSettings: { audioTypes: [], enableTamperDetection: false, objectTypes: [ "package", "person" ] } }));

      await settle();

      assert.ok(smartDetectSensor(accessory, "package"), "the added type gained its own contact sensor live");
      assert.ok(smartDetectSensor(accessory, "person"), "the surviving type kept its contact sensor across the add");

      // The controller stops reporting the type it just added.
      store.pushCameraPatch(cameraConfig.id, cameraPatch({ featureFlags: { ...cameraConfig.featureFlags, smartDetectTypes: ["person"] },
        smartDetectSettings: { audioTypes: [], enableTamperDetection: false, objectTypes: ["person"] } }));

      await settle();

      // Reverting the prune to its all-or-nothing form (remove every per-type sensor only when the object-sensor option is off) leaves the dropped type's sensor in
      // place -> RED. This is the remove half's only coverage.
      assert.equal(smartDetectSensor(accessory, "package"), undefined, "the dropped type lost its contact sensor live");
      assert.ok(smartDetectSensor(accessory, "person"), "the still-reported type kept its contact sensor across the removal");
    } finally {

      camera.cleanup();
    }
  });

  /* Per-type SELECTION, which is the new capability: the camera delivers both types and the user narrows the sensors to one of them. The row runs in two passes so the
   * subtractive branch is genuinely exercised - constructing straight into the narrowed selection would only prove that the excluded sensor was never created, which a
   * prune that removes nothing would also satisfy. The first pass builds both sensors, the selection then narrows through the engine's own write path, and the
   * reconcile a controller patch drives is what has to take the excluded one away.
   */
  test("narrowing the per-type selection removes the excluded sensor and leaves the selected one standing", async () => {

    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { hasSmartDetect: true, smartDetectTypes: [ "person", "vehicle" ] },
      smartDetectSettings: { objectTypes: [ "person", "vehicle" ] } });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { nvr } = buildTestNvr({ store,
      userOptions: [ "Enable.Motion.SmartDetect", "Enable.Motion.SmartDetect.ObjectSensors=person,vehicle" ] });
    const accessory = makeTestAccessory("Test Camera", "uuid:smart-detect-selection");
    const camera = construct(nvr, accessory, new TestCameraProjection(cameraConfig.id, store));

    await settle();

    try {

      assert.ok(smartDetectSensor(accessory, "person"), "the first pass built the person sensor");
      assert.ok(smartDetectSensor(accessory, "vehicle"), "the first pass built the vehicle sensor, so the removal below is a real removal");

      /* Narrow the selection through the engine's own write path, the way a settings save does, then let an unrelated controller change drive the reconcile. The
       * detection types this camera delivers are deliberately unchanged across the patch, so what removes the vehicle sensor is the selection alone.
       */
      nvr.platform.featureOptions.setOption({ enabled: true, option: "Motion.SmartDetect.ObjectSensors", value: "person" });

      store.pushCameraPatch(cameraConfig.id, cameraPatch({ featureFlags: { ...cameraConfig.featureFlags, smartDetectTypes: [ "person", "vehicle" ] },
        smartDetectSettings: { audioTypes: [], enableTamperDetection: true, objectTypes: [ "person", "vehicle" ] } }));

      await settle();

      assert.equal(smartDetectSensor(accessory, "vehicle"), undefined, "the type the user left out of the selection lost its contact sensor");
      assert.ok(smartDetectSensor(accessory, "person"), "the selected type kept its contact sensor");
    } finally {

      camera.cleanup();
    }
  });

  test("a withdrawn hasSmartDetect keeps every sensor, typed and plate alike (subtractive-conservative at the capability level)", async () => {

    // The controller withdraws the capability the way it actually does it - the flag goes false and the reported type set empties in the same push - so a per-type prune
    // reached during the withdrawal would delete every sensor. The short-circuit is what makes the withdrawal touch nothing at all.
    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS,
      featureFlags: { hasSmartDetect: true, smartDetectTypes: [ "licensePlate", "person" ] } });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { nvr } = buildTestNvr({ store, userOptions: [ "Enable.Motion.SmartDetect", "Enable.Motion.SmartDetect.ObjectSensors",
      "Enable.Motion.SmartDetect.ObjectSensors.LicensePlate.ABC123" ] });
    const accessory = makeTestAccessory("Test Camera", "uuid:smart-detect-6");
    const camera = construct(nvr, accessory, new TestCameraProjection(cameraConfig.id, store));

    await settle();

    try {

      assert.ok(smartDetectSensor(accessory, "person"), "the person sensor exists before the withdrawal");
      assert.ok(plateSensor(accessory, "ABC123"), "the configured plate sensor exists before the withdrawal");

      // The capability withdraws: an all-false featureFlags drain of the kind a reconnect delivers, with the type list emptied alongside the flag.
      store.pushCameraFeatureFlags(cameraConfig.id, { hasSmartDetect: false, smartDetectTypes: [] });

      await settle();

      // Deleting the short-circuit lets the emptied type set drive the per-type prune (every typed sensor removed) and the plate prune (no licensePlate telemetry) ->
      // both assertions RED. This is the one statement that makes a hardware withdrawal touch nothing.
      assert.ok(smartDetectSensor(accessory, "person"), "the withdrawn capability kept the typed contact sensor");
      assert.ok(plateSensor(accessory, "ABC123"), "the withdrawn capability kept the license plate contact sensor");
    } finally {

      camera.cleanup();
    }
  });

  test("a plate the user removed from the configured list still loses its sensor (the user-configured half stays authoritative)", async () => {

    // The user-configured side is restart-scoped, so production reaches this prune on the next startup's construct pass: the cached sensor for a plate the user has since
    // dropped from the list is pre-seeded here, exactly as a restart restores it, while the plate the user kept is configured.
    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { hasSmartDetect: true, smartDetectTypes: ["licensePlate"] } });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { nvr } = buildTestNvr({ store, userOptions: [ "Enable.Motion.SmartDetect", "Enable.Motion.SmartDetect.ObjectSensors",
      "Enable.Motion.SmartDetect.ObjectSensors.LicensePlate.ABC123" ] });
    const accessory = makeTestAccessory("Test Camera", "uuid:smart-detect-7");

    accessory.addService(Service.ContactSensor, "Test Camera License Plate XYZ789", ProtectReservedNames.CONTACT_MOTION_SMARTDETECT_LICENSE + ".XYZ789");

    // The vacuity guard, inverted: the de-configured plate's sensor is genuinely present before construction, so its absence afterward is a real prune.
    assert.ok(plateSensor(accessory, "XYZ789"), "the cached sensor for the de-configured plate is present before construction");

    const camera = construct(nvr, accessory, new TestCameraProjection(cameraConfig.id, store));

    await settle();

    try {

      // Dropping the detectLicensePlate.includes(...) term from the keep-condition leaves the de-configured plate's sensor in place -> RED. The hardware capability is no
      // longer a term in that condition, so this is what holds its surviving half.
      assert.equal(plateSensor(accessory, "XYZ789"), undefined, "the plate the user removed from the list lost its contact sensor");
      assert.ok(plateSensor(accessory, "ABC123"), "the plate the user kept still has its contact sensor");
    } finally {

      camera.cleanup();
    }
  });

  /* The end-to-end row for the retired plate grammar, which separated plates with hyphens rather than with the shared list delimiter. A configuration nobody has
   * opened the settings page on still carries it, and every plate in it has to keep its sensor. The rewrite happens before the engine reads the entry at all, so the
   * camera's own read carries no hyphen awareness whatsoever.
   */
  test("a plate list stored in the retired hyphen grammar still creates every plate's sensor", async () => {

    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { hasSmartDetect: true, smartDetectTypes: ["licensePlate"] } });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { nvr } = buildTestNvr({ store, userOptions: [ "Enable.Motion.SmartDetect", "Enable.Motion.SmartDetect.ObjectSensors",
      "Enable.Motion.SmartDetect.ObjectSensors.LicensePlate.ABC123-XYZ789" ] });
    const accessory = makeTestAccessory("Test Camera", "uuid:smart-detect-plates-legacy");
    const camera = construct(nvr, accessory, new TestCameraProjection(cameraConfig.id, store));

    await settle();

    try {

      assert.ok(plateSensor(accessory, "ABC123"), "the first plate in the retired list has its sensor");
      assert.ok(plateSensor(accessory, "XYZ789"), "the second plate in the retired list has its sensor");
      assert.deepEqual(camera.detectLicensePlate, [ "ABC123", "XYZ789" ], "the camera read both plates rather than one run-together value");
    } finally {

      camera.cleanup();
    }
  });

  test("an unrelated reconcile never resets a sensor a live detection has tripped (the establishment-only resting stamp)", async () => {

    // Once the sensors reconcile on every capability change, an unconditional resting stamp would cancel a live smart-motion event the moment any unrelated flag moved.
    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { hasSmartDetect: true, smartDetectTypes: ["person"] } });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { nvr } = buildTestNvr({ store, userOptions: [ "Enable.Motion.SmartDetect", "Enable.Motion.SmartDetect.ObjectSensors" ] });
    const accessory = makeTestAccessory("Test Camera", "uuid:smart-detect-8");
    const camera = construct(nvr, accessory, new TestCameraProjection(cameraConfig.id, store));

    await settle();

    try {

      const person = smartDetectSensor(accessory, "person");

      assert.ok(person, "the person sensor exists before the detection");

      // A live detection trips the sensor, and its motion window is still open.
      nvr.events.motionEventHandler(camera, ["person"]);

      assert.equal(person.getCharacteristic(Characteristic.ContactSensorState).value, Characteristic.ContactSensorState.CONTACT_NOT_DETECTED,
        "the detection tripped the sensor (the vacuity guard for the reconcile below)");

      // An unrelated capability reports late, driving a full reconcile pass across the tripped sensor.
      store.pushCameraFeatureFlags(cameraConfig.id, { hasLedStatus: true });

      await settle();

      // Returning the resting stamp to its unconditional form re-stamps CONTACT_DETECTED here, silently cancelling the live event -> RED.
      assert.equal(person.getCharacteristic(Characteristic.ContactSensorState).value, Characteristic.ContactSensorState.CONTACT_NOT_DETECTED,
        "the reconcile left the tripped sensor alone - the delivery path owns an existing sensor's state");
    } finally {

      camera.cleanup();
    }
  });
});

describe("the camera capability reconcile - the user's Protect-side detection selection", () => {

  test("a detection the user switches off in Protect loses its contact sensor, and the others are untouched", async () => {

    // The hardware advertises person and vehicle and the user has both enabled, so both sensors exist. The user then deselects vehicle detection in the Protect webUI,
    // which moves smartDetectSettings.objectTypes while featureFlags.smartDetectTypes - what the camera CAN detect - stays exactly as it was.
    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { hasSmartDetect: true, smartDetectTypes: [ "person", "vehicle" ] } });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { nvr } = buildTestNvr({ store, userOptions: [ "Enable.Motion.SmartDetect", "Enable.Motion.SmartDetect.ObjectSensors" ] });
    const accessory = makeTestAccessory("Test Camera", "uuid:smart-detect-9");
    const camera = construct(nvr, accessory, new TestCameraProjection(cameraConfig.id, store));

    await settle();

    try {

      // The vacuity guard: both sensors are genuinely present while both detections are enabled.
      assert.ok(smartDetectSensor(accessory, "person"), "the person sensor exists while the user has person detection enabled");
      assert.ok(smartDetectSensor(accessory, "vehicle"), "the vehicle sensor exists while the user has vehicle detection enabled");

      // The user switches vehicle detection off in Protect. The camera still ADVERTISES vehicle; the user has simply told the controller not to detect it.
      store.pushCameraPatch(cameraConfig.id, cameraPatch({ smartDetectSettings: { audioTypes: [], enableTamperDetection: false, objectTypes: ["person"] } }));

      await settle();

      // Deriving the live set from featureFlags alone leaves the vehicle sensor in place - visible, and unable to ever trip, since the controller sends no event for a
      // detection the user disabled -> RED. The person assertion is the control that proves the pass pruned by type rather than wholesale.
      assert.equal(smartDetectSensor(accessory, "vehicle"), undefined, "the detection the user switched off in Protect lost its contact sensor");
      assert.ok(smartDetectSensor(accessory, "person"), "the detection the user left enabled kept its contact sensor");
    } finally {

      camera.cleanup();
    }
  });

  test("re-enabling that detection in Protect brings its contact sensor back live, with no restart", async () => {

    // The mirror of the prune above: the camera advertises person and vehicle while the user has only person enabled, so the vehicle sensor is correctly absent. The user
    // then re-enables vehicle detection in Protect.
    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { hasSmartDetect: true, smartDetectTypes: [ "person", "vehicle" ] },
      smartDetectSettings: { objectTypes: ["person"] } });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { nvr } = buildTestNvr({ store, userOptions: [ "Enable.Motion.SmartDetect", "Enable.Motion.SmartDetect.ObjectSensors" ] });
    const accessory = makeTestAccessory("Test Camera", "uuid:smart-detect-10");
    const camera = construct(nvr, accessory, new TestCameraProjection(cameraConfig.id, store));

    await settle();

    try {

      // The vacuity guard, and the construct-path half of the same rule: the advertised-but-disabled detection has no sensor to begin with.
      assert.ok(smartDetectSensor(accessory, "person"), "the enabled detection has its sensor at adoption");
      assert.equal(smartDetectSensor(accessory, "vehicle"), undefined, "the advertised but user-disabled detection has no sensor at adoption");

      // The user re-enables vehicle detection in Protect.
      store.pushCameraPatch(cameraConfig.id, cameraPatch({ smartDetectSettings: { audioTypes: [], enableTamperDetection: false,
        objectTypes: [ "person", "vehicle" ] } }));

      await settle();

      // The smartDetectSettings observer already drives the chokepoint, so the re-enable rides the existing wake. Deriving the live set from featureFlags alone would
      // have created this sensor at adoption, so the vacuity guard above is what makes this a real live arrival -> both assertions are needed.
      assert.ok(smartDetectSensor(accessory, "vehicle"), "the re-enabled detection gained its contact sensor live");
      assert.ok(smartDetectSensor(accessory, "person"), "the already-enabled detection kept its contact sensor across the re-enable");
    } finally {

      camera.cleanup();
    }
  });
});
