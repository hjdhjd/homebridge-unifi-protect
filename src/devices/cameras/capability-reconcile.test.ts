/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * capability-reconcile.test.ts: The camera capability-reconcile chokepoint end to end - a controller that finishes reporting a camera's hardware capabilities AFTER
 * adoption reflects them live, without a Homebridge restart. The ambient light sensor (gated on featureFlags.hasLuxCheck plus the Device.AmbientLightSensor user toggle)
 * is the pilot capability; the UniFi Access lock (gated on accessDeviceMetadata.featureFlags.supportUnlock plus the UniFi.Access.Lock user toggle) is the second; the
 * night vision dimmer (gated on featureFlags.hasInfrared and hasIcrSensitivity plus the Device.NightVision.Dimmer user toggle) is the third.
 *
 * The suite drives a REAL constructed ProtectCamera against the camera-construction harness doubles (the faithful store, the read-through Camera projection, the stub
 * streaming-delegate factory) and exercises the capability observers and the reconcileCapabilities chokepoint they drive. Each scenario is behavior-FIRST - a
 * structural-sharing push followed by a settle and an assertion on the HomeKit surface the reconcile produced (the LightSensor / LockMechanism service) or did not - and
 * the load-bearing scenarios are DISCRIMINATING: the self-heal proves the OBSERVER (remove it and the late capability never appears), and the restart re-wire proves the
 * wiring runs on every configure (restore the if(existing) early-return and a cached-but-unwired sensor is never re-wired - no controller lux read occurs). The
 * wake-attribution and leak scenarios are the selector-correctness and no-leaked-loop controls.
 *
 * All three capability suites share the function-form predicate's asymmetry (additive-eager on the capability, absolutely-pruning on the toggle). The Access lock and the
 * night vision dimmer add an establishment-only push on top: a live observe reconcile over an existing service never re-pushes the display (so an in-flight unlock or
 * night-vision command is never stomped), while create and the construct path (adoption or restart) do. The lock stamps SECURED; the dimmer pushes On / Brightness from
 * the device's irLedMode reading. Each suite's discriminating mutations are traced in its tests' comments - the predicate's hasService and toggle clauses, the
 * early-return removal (lock only), and the !existing || (source === "construct") establishment condition.
 */
import type { Camera, ProtectCameraConfig } from "unifi-protect";
import { Characteristic, Service, TestCameraProjection, TestStateStore, makeCameraConfig, makeProtectState, makeTestAccessory, makeTestNvr, settle }
  from "../../testing.helpers.ts";
import type { TestAccessory, TestProtectNvr, TestService } from "../../testing.helpers.ts";
import { describe, mock, test } from "node:test";
import { G2_PRO_CHANNELS } from "../../camera.fixtures.ts";
import type { ObserverWakePayload } from "../../diagnostics.ts";
import type { ProtectAccessory } from "../../types.ts";
import { ProtectCamera } from "./camera.ts";
import type { ProtectNvr } from "../../nvr/nvr.ts";
import { ProtectReservedNames } from "../../types.ts";
import assert from "node:assert/strict";
import diagnosticsChannel from "node:diagnostics_channel";

// Construct a real ProtectCamera, with the casts confined to this one seam - the instance under test is the production class and its real configure path.
function construct(nvr: TestProtectNvr, accessory: TestAccessory, projection: TestCameraProjection): ProtectCamera {

  return new ProtectCamera(nvr as unknown as ProtectNvr, accessory as unknown as ProtectAccessory, projection as unknown as Camera);
}

// The count of bare LightSensor services on the accessory - the discriminator for "exactly one ambient light sensor", which proves the reconcile re-run never sprouted a
// duplicate (acquireService is get-or-create, so a re-run returns the existing instance).
function lightSensorCount(accessory: TestAccessory): number {

  return accessory.services.filter((service) => service.type === Service.LightSensor).length;
}

// The camera's UniFi Access lock - the LOCK_ACCESS-subtyped LockMechanism service. ProtectReservedNames.LOCK_ACCESS subtypes it, so the lookup is getServiceById (the
// subtyped twin of getService), exactly as production acquires it.
function accessLock(accessory: TestAccessory): TestService | undefined {

  return accessory.getServiceById(Service.LockMechanism, ProtectReservedNames.LOCK_ACCESS);
}

// The count of LOCK_ACCESS LockMechanism services - the discriminator for "exactly one lock", which proves a reconcile re-run never sprouted a duplicate.
function accessLockCount(accessory: TestAccessory): number {

  return accessory.services.filter((service) => (service.type === Service.LockMechanism) && (service.subtype === ProtectReservedNames.LOCK_ACCESS)).length;
}

// The camera's night vision dimmer - the LIGHTBULB_NIGHTVISION-subtyped Lightbulb service. ProtectReservedNames.LIGHTBULB_NIGHTVISION subtypes it, so the lookup is
// getServiceById (the subtyped twin of getService), exactly as production acquires it.
function nightVisionDimmer(accessory: TestAccessory): TestService | undefined {

  return accessory.getServiceById(Service.Lightbulb, ProtectReservedNames.LIGHTBULB_NIGHTVISION);
}

// The count of LIGHTBULB_NIGHTVISION Lightbulb services - the discriminator for "exactly one dimmer", which proves a reconcile re-run never sprouted a duplicate.
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

describe("the camera capability reconcile - the ambient light sensor pilot", () => {

  test("a late hasLuxCheck creates the ambient light sensor live, without a restart (self-heal, discriminating on the observer)", async () => {

    // A camera the controller adopts WITHOUT the lux capability: the gate's early-return leaves no LightSensor at adoption.
    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { hasLuxCheck: false } });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { nvr } = makeTestNvr({ store });
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

  test("a Homebridge restart re-wires the cached-but-unwired ambient light sensor (restart re-wire, discriminating on the re-wired controller read)", async () => {

    // A camera the controller reports WITH the lux capability. We simulate a Homebridge restart, which restores the cached accessory's LightSensor service - present with
    // its characteristics - but never its runtime onGet handlers or its poll timer, neither of which HAP serializes. This is the present-but-unwired state the first
    // configure after a restart runs against, and the case the removed "if(existing) return true" guard mistook for an already-wired sensor.
    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { hasLuxCheck: true } });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { nvr } = makeTestNvr({ store });
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

  test("a withdrawn hasLuxCheck never prunes the ambient light sensor (subtractive-conservative)", async () => {

    // A camera adopted WITH the lux capability, then a controller that stops reporting it. The capability half of the gate is additive-eager / subtractive-conservative
    // (the user toggle stays on here): the reconcile creates on true and never prunes on false, so a flag that vanishes (a transient bootstrap blip) does not strip a
    // working sensor.
    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { hasLuxCheck: true } });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { nvr } = makeTestNvr({ store });
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

  test("the feature option off creates no ambient light sensor even with hasLuxCheck (the toggle half, fresh, discriminating on the toggle clause)", async () => {

    // The lux capability is present, but the user toggle is off. Both halves must hold to CREATE, so no sensor appears.
    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { hasLuxCheck: true } });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { nvr } = makeTestNvr({ store, userOptions: ["Disable.Device.AmbientLightSensor"] });
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
    // hasLuxCheck FALSE (the makeCameraConfig default) AND the option disabled. This is the ONLY cell where the old early-return and the new folded gate diverge.
    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { nvr } = makeTestNvr({ store, userOptions: ["Disable.Device.AmbientLightSensor"] });
    const accessory = makeTestAccessory("Test Camera", "uuid:capability-reconcile-8");

    accessory.addService(Service.LightSensor, "Test Camera");

    assert.ok(accessory.getService(Service.LightSensor), "a cached ambient light sensor is present before construction");

    const camera = construct(nvr, accessory, new TestCameraProjection(cameraConfig.id, store));

    await settle();

    try {

      // The folded gate prunes on toggle-off even with hasLuxCheck false: hasFeature is false, so validService removes the present sensor. Reverting to the old
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
    const { nvr } = makeTestNvr({ store });
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
    const { nvr } = makeTestNvr({ store });
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
});

describe("the camera capability reconcile - the UniFi Access lock", () => {

  test("a late supportUnlock creates the Access lock live and reads SECURED, without a restart (self-heal, discriminating on the observer)", async () => {

    // A camera adopted WITHOUT a paired Access reader: no accessDeviceMetadata, so the gate creates no lock at adoption.
    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { nvr } = makeTestNvr({ store });
    const accessory = makeTestAccessory("Test Camera", "uuid:access-lock-1");
    const camera = construct(nvr, accessory, new TestCameraProjection(cameraConfig.id, store));

    await settle();

    try {

      // The vacuity guard: genuinely no lock before the push, so the post-push presence is a real transition.
      assert.equal(accessLock(accessory), undefined, "no Access lock exists before the controller reports the unlock capability");

      // The paired reader finishes reporting; supportUnlock goes from absent to true.
      store.pushCameraSupportUnlock(cameraConfig.id, true);

      await settle();

      // The supportUnlock observer drove reconcileCapabilities("observe"), which created the lock and (no prior service -> !existing) stamped it SECURED. Removing the
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

  test("a withdrawn supportUnlock never prunes the Access lock (subtractive-conservative, discriminating on the hasService clause)", async () => {

    // A camera adopted WITH the unlock capability, then a controller that stops reporting it. The capability half is additive-eager / subtractive-conservative: it
    // creates on true and never prunes on false (a transient incomplete bootstrap must not strip a working lock).
    const cameraConfig = makeCameraConfig({ accessDeviceMetadata: { featureFlags: { supportUnlock: true } }, channels: G2_PRO_CHANNELS });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { nvr } = makeTestNvr({ store });
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

  test("the feature option off creates no lock even with supportUnlock (the toggle half, fresh, discriminating on the toggle clause)", async () => {

    // The capability is present, but the user toggle is off. Both halves must hold to CREATE, so no lock appears.
    const cameraConfig = makeCameraConfig({ accessDeviceMetadata: { featureFlags: { supportUnlock: true } }, channels: G2_PRO_CHANNELS });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { nvr } = makeTestNvr({ store, userOptions: ["Disable.UniFi.Access.Lock"] });
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
      // supportUnlock FALSE (no accessDeviceMetadata) AND the option disabled. This is the ONLY cell where the old early-return and the new folded gate diverge.
      const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS });
      const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
      const { nvr } = makeTestNvr({ store, userOptions: ["Disable.UniFi.Access.Lock"] });
      const accessory = makeTestAccessory("Test Camera", "uuid:access-lock-4");

      accessory.addService(Service.LockMechanism, "Test Camera", ProtectReservedNames.LOCK_ACCESS);

      assert.ok(accessLock(accessory), "a cached Access lock is present before construction");

      const camera = construct(nvr, accessory, new TestCameraProjection(cameraConfig.id, store));

      await settle();

      try {

        // The folded gate prunes on toggle-off even with supportUnlock false: hasFeature is false, so validService removes the present lock. Reverting to the old
        // if(!supportUnlock) return false early-return leaves the lock un-pruned (the early-return fires before validService) -> RED; dropping the hasFeature && half
        // makes the predicate (hasService || supportsUnlock) true and keeps the lock -> RED. This single test pins both the early-return removal and the toggle half.
        assert.equal(accessLock(accessory), undefined, "the disabled feature option pruned the cached lock even with supportUnlock false");
      } finally {

        camera.cleanup();
      }
    });

  test("a freshly created Access lock reads SECURED (the establishment stamp, discriminating against the null default)", async () => {

    const cameraConfig = makeCameraConfig({ accessDeviceMetadata: { featureFlags: { supportUnlock: true } }, channels: G2_PRO_CHANNELS });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { nvr } = makeTestNvr({ store });
    const accessory = makeTestAccessory("Test Camera", "uuid:access-lock-5");
    const camera = construct(nvr, accessory, new TestCameraProjection(cameraConfig.id, store));

    await settle();

    try {

      const lock = accessLock(accessory);

      assert.ok(lock, "the supportUnlock capability plus the default-on option created the Access lock at adoption");

      // The establishment stamp wrote SECURED to both characteristics. Removing the stamp leaves the double's value at its null default - null !== SECURED - so this is
      // RED, which is exactly why the SECURED assertion discriminates SECURED-vs-null rather than SECURED-vs-UNSECURED.
      assert.equal(lock.getCharacteristic(Characteristic.LockCurrentState).value, Characteristic.LockCurrentState.SECURED,
        "the lock current state reads SECURED at creation");
      assert.equal(lock.getCharacteristic(Characteristic.LockTargetState).value, Characteristic.LockTargetState.SECURED,
        "the lock target state reads SECURED at creation");
    } finally {

      camera.cleanup();
    }
  });

  test("a live observe reconcile over an existing lock never re-stamps the display (Fix C2, discriminating on the establishment condition)", async () => {

    const cameraConfig = makeCameraConfig({ accessDeviceMetadata: { featureFlags: { supportUnlock: true } }, channels: G2_PRO_CHANNELS });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { nvr } = makeTestNvr({ store });
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

      // The display is untouched - still UNSECURED. Making the stamp unconditional (dropping !existing || (source === "construct")) leaves the observe reconcile
      // re-stamping SECURED -> RED, which would truncate a momentary user unlock.
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
    const { nvr } = makeTestNvr({ store });
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

    mock.timers.enable({ apis: ["setTimeout"] });

    try {

      // (a) The construct path stamped SECURED on the EXISTING lock (source === "construct" with existing present). Dropping the source === "construct" half leaves the
      // cached lock un-stamped - existing is present, so !existing is false - and it stays UNSECURED -> RED.
      assert.equal(restored.getCharacteristic(Characteristic.LockCurrentState).value, Characteristic.LockCurrentState.SECURED,
        "the construct reconcile recovered the lock current state to SECURED");
      assert.equal(restored.getCharacteristic(Characteristic.LockTargetState).value, Characteristic.LockTargetState.SECURED,
        "the construct reconcile recovered the lock target state to SECURED");

      // (b) The onSet was re-bound on this configure (the wire-every-configure invariant - existing does NOT gate the wiring). Driving the LockTargetState onSet to
      // UNSECURED dispatches exactly one unlock command. Re-introducing an if(existing) return true guard before the onSet bind leaves nothing recorded -> RED.
      await restored.getCharacteristic(Characteristic.LockTargetState).triggerSet(Characteristic.LockTargetState.UNSECURED);

      assert.equal(projection.unlockCalls.length, 1, "the re-bound onSet dispatched exactly one unlock when driven to UNSECURED");
    } finally {

      mock.timers.reset();
      camera.cleanup();
    }
  });

  test("an unrelated accessDeviceMetadata change does not wake the supportUnlock observer (value-selector dedup vs a whole-object selector)", async () => {

    const cameraConfig = makeCameraConfig({ accessDeviceMetadata: { featureFlags: { supportUnlock: true } }, channels: G2_PRO_CHANNELS });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { nvr } = makeTestNvr({ store });
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
    const { nvr } = makeTestNvr({ store });
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
    const { nvr } = makeTestNvr({ store });
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
});

describe("the camera capability reconcile - the night vision dimmer", () => {

  test("a late hasInfrared and hasIcrSensitivity create the night vision dimmer live and read the device value, without a restart (self-heal, discriminating on the " +
    "routing)", async () => {

    // A camera adopted WITHOUT the adjustable infrared hardware (the makeCameraConfig defaults leave hasInfrared / hasIcrSensitivity false), with the dimmer toggle on:
    // the gate's conservative-keep yields no dimmer at adoption. Seed a DIVERGENT irLedMode "auto" BEFORE construction so the eventual establishment push proves it reads
    // the real device value (On true, Brightness 10), not a vacuous off-state default.
    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));

    store.pushCameraPatch(cameraConfig.id, cameraPatch({ ispSettings: { irLedMode: "auto" } }));

    const { nvr } = makeTestNvr({ store, userOptions: ["Enable.Device.NightVision.Dimmer"] });
    const accessory = makeTestAccessory("Test Camera", "uuid:night-vision-dimmer-1");
    const camera = construct(nvr, accessory, new TestCameraProjection(cameraConfig.id, store));

    await settle();

    try {

      // The vacuity guard: genuinely no dimmer before the push, so the post-push presence is a real transition.
      assert.equal(nightVisionDimmer(accessory), undefined, "no night vision dimmer exists before the controller reports the infrared hardware");

      // The controller finishes provisioning the camera and now reports both adjustable-infrared flags.
      store.pushCameraFeatureFlags(cameraConfig.id, { hasIcrSensitivity: true, hasInfrared: true });

      await settle();

      // The featureFlags observer drove reconcileCapabilities("observe"), which created the dimmer and (no prior service -> !existing) established it from the device's
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
    const { nvr } = makeTestNvr({ store, userOptions: ["Enable.Device.NightVision.Dimmer"] });
    const accessory = makeTestAccessory("Test Camera", "uuid:night-vision-dimmer-2");
    const camera = construct(nvr, accessory, new TestCameraProjection(cameraConfig.id, store));

    await settle();

    try {

      assert.ok(nightVisionDimmer(accessory), "the night vision dimmer was created at adoption");

      // The controller stops reporting the infrared capability.
      store.pushCameraFeatureFlags(cameraConfig.id, { hasInfrared: false });

      await settle();

      // The capabilityGate hasService || clause keeps the present dimmer through the transient hasInfrared-false while the toggle stays on. This is the ONLY cell
      // where the dimmer's old boolean gate and the new capabilityGate diverge: replacing capabilityGate(...) with the strict hasNightVisionHardware &&
      // this.hasFeature(...) boolean passes validService(false), which PRUNES the working dimmer -> RED.
      assert.ok(nightVisionDimmer(accessory), "the withdrawn capability never pruned the existing night vision dimmer");
      assert.equal(nightVisionDimmerCount(accessory), 1, "the dimmer is retained, not duplicated, across the withdrawal");
    } finally {

      camera.cleanup();
    }
  });

  test("the feature option off creates no night vision dimmer with the infrared hardware (the toggle half, fresh, discriminating on the toggle clause)", async () => {

    // The adjustable infrared hardware is present, but the Device.NightVision.Dimmer toggle defaults off (unlike lux / the lock) and no Enable option is supplied. Both
    // halves must hold to CREATE, so no dimmer appears.
    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { hasIcrSensitivity: true, hasInfrared: true } });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { nvr } = makeTestNvr({ store });
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
    // the strict-boolean mutation cannot discriminate here - capability true with toggle false prunes either way) but the toggle off.
    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { hasIcrSensitivity: true, hasInfrared: true } });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { nvr } = makeTestNvr({ store });
    const accessory = makeTestAccessory("Test Camera", "uuid:night-vision-dimmer-4");

    accessory.addService(Service.Lightbulb, "Test Camera Night Vision", ProtectReservedNames.LIGHTBULB_NIGHTVISION);

    assert.ok(nightVisionDimmer(accessory), "a cached night vision dimmer is present before construction");

    const camera = construct(nvr, accessory, new TestCameraProjection(cameraConfig.id, store));

    await settle();

    try {

      // The toggle half prunes the present dimmer: hasFeature is false, so validService removes it. This is PARITY - the old boolean gate already passed a boolean to
      // validService, which removes on false, so old and new BOTH prune (there is no toggle-off divergence, unlike the lock's early-return). ONLY the dropped-toggle-half
      // mutation discriminates here ((hasService || capability) = true -> keeps -> RED); the strict-boolean mutation does NOT (capability true && toggle false = false =
      // prune, same as production).
      assert.equal(nightVisionDimmer(accessory), undefined, "the absent Enable toggle pruned the cached night vision dimmer");
    } finally {

      camera.cleanup();
    }
  });

  test("a live observe reconcile over an existing dimmer never re-pushes the displayed value (Fix C2, discriminating on the establishment condition)", async () => {

    // Seed a DIVERGENT irLedMode "auto" BEFORE construction so the dimmer is established to On true / Brightness 10 at adoption, a value distinct from the optimistic
    // setting driven below.
    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { hasIcrSensitivity: true, hasInfrared: true } });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));

    store.pushCameraPatch(cameraConfig.id, cameraPatch({ ispSettings: { irLedMode: "auto" } }));

    const { nvr } = makeTestNvr({ store, userOptions: ["Enable.Device.NightVision.Dimmer"] });
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

      // Trigger a LIVE observe reconcile through the featureFlags observer: re-pushing the same capability flags yields a new featureFlags object reference, so the
      // whole-object observer wakes (Object.is dedup), while ispSettings is untouched so its observer stays asleep and updateNightVision never runs. With the dimmer
      // already present and source "observe", the establishment block is skipped.
      store.pushCameraFeatureFlags(cameraConfig.id, { hasIcrSensitivity: true, hasInfrared: true });

      await settle();

      // The display is untouched - still the optimistic value. Making the push unconditional (dropping !existing || (source === "construct")) leaves the observe
      // reconcile re-pushing the device reading (On true / Brightness 10) over the optimistic setting -> RED, which would momentarily stomp the user's in-flight command.
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

    const { nvr } = makeTestNvr({ store, userOptions: ["Enable.Device.NightVision.Dimmer"] });
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

      // (a) The construct path re-established the EXISTING dimmer from the device reading (source === "construct" with existing present). Dropping the
      // source === "construct" half leaves the cached dimmer un-pushed - existing is present, so !existing is false - and it stays at the stale On false /
      // Brightness 0 -> RED.
      assert.equal(restored.getCharacteristic(Characteristic.On).value, true, "the construct reconcile re-established On true from the device irLedMode auto reading");
      assert.equal(restored.getCharacteristic(Characteristic.Brightness).value, 10, "the construct reconcile re-established Brightness 10 from the device reading");

      // (b) The On onSet was re-bound on this configure (the wire-every-configure invariant - existing does NOT gate the wiring). Driving it to false dispatches
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
    const { logEntries, nvr } = makeTestNvr({ store, userOptions: ["Enable.Device.NightVision.Dimmer"] });
    const accessory = makeTestAccessory("Test Camera", "uuid:night-vision-dimmer-7");

    // Count the captured "Enabling night vision dimmer." INFO entries. A COUNT (filter / length), not a boolean .some() helper: the construct-time entry persists in the
    // buffer, so a boolean could not tell a once-logged dimmer from a twice-logged one.
    const enablingLogCount = (): number => {

      return logEntries.filter((entry) => (entry.level === "info") && String(entry.parameters[0]).includes("Enabling night vision dimmer.")).length;
    };

    const camera = construct(nvr, accessory, new TestCameraProjection(cameraConfig.id, store));

    await settle();

    try {

      assert.ok(nightVisionDimmer(accessory), "the infrared hardware plus the Enable toggle created the night vision dimmer at construction");
      assert.equal(enablingLogCount(), 1, "the establishment block logged Enabling night vision dimmer exactly once at creation");

      // Trigger a LIVE observe reconcile: a new featureFlags reference wakes the whole-object observer; the dimmer is already present and source is observe, so the
      // establishment block (and its log) is skipped.
      store.pushCameraFeatureFlags(cameraConfig.id, { hasIcrSensitivity: true, hasInfrared: true });

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
    "discriminating on the routing and the guarded clear)", async () => {

    // A camera the controller adopts WITHOUT the tamper capability, the user setting eventually on. The tamper gate keys StatusTampered on TWO inputs - the
    // hasTamperDetection hardware capability and the enableTamperDetection setting - so the setting alone leaves the characteristic absent until the capability reports.
    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { nvr } = makeTestNvr({ store });
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
    const { nvr } = makeTestNvr({ store });
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
      // ONLY cell where the old strict gate (!hasTamperDetection || !enableTamperDetection) and the new capabilityGate diverge: replacing capabilityGate(...) with the
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
    // so it prunes the characteristic and clears the one-way latch. Old and new BOTH prune on the setting-off (no divergence - the divergence is the capability half).
    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { hasTamperDetection: true } });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { nvr } = makeTestNvr({ store });
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

  test("a configure against a restart-restored StatusTampered re-binds the onGet over the stale cached value (the construct re-wire; wire-every-configure)", async () => {

    // Pre-push the setting on BEFORE construction so the construct reconcile sees enableTamperDetection true, mirroring the controller-stored config a restart restores
    // (the ufp wire capture confirmed enableTamperDetection survives a reconnect independently of featureFlags).
    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { hasTamperDetection: true } });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));

    store.pushCameraPatch(cameraConfig.id, cameraPatch({ smartDetectSettings: { enableTamperDetection: true } }));

    const { nvr } = makeTestNvr({ store });
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

      // The construct reconcile's keep branch re-bound the onGet over the existing characteristic (the wire-every-configure invariant - existing does NOT gate the
      // wiring). triggerGet now reads this.isTampered at rest (false), NOT the stale cached true. Re-introducing an if(existing) return true guard before the onGet bind
      // leaves the cached characteristic unwired, so triggerGet falls through to the stale cached true -> RED.
      assert.equal(await restored.getCharacteristic(Characteristic.StatusTampered).triggerGet(), false,
        "the construct reconcile re-bound the onGet, so the read returns isTampered at rest, not the stale cached true");
    } finally {

      camera.cleanup();
    }
  });
});

describe("the camera capability reconcile - two-way audio", () => {

  test("a late hasSpeaker surfaces two-way audio via one in-place controller rebuild, without a restart (self-heal, discriminating on the reconcile call)", async () => {

    // A camera the controller adopts WITHOUT a speaker: the streaming delegate's frozen audio options are built with two-way audio off, so the talk button is baked off.
    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { hasSpeaker: false } });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { nvr } = makeTestNvr({ store });
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

      // The featureFlags observer drove reconcileCapabilities, whose reconcileStreamingAudioCapabilities refreshed the hint and rebuilt the controller: exactly one
      // removeController then one configureController. Removing the reconcileStreamingAudioCapabilities from reconcileCapabilities leaves this RED - no rebuild fires
      // and builtFor.twoWayAudio stays false.
      const churn = accessory.controllerEvents.slice(churnBaseline);

      assert.equal(churn.length, 2, "the late speaker fired exactly two controller events");
      assert.equal(churn[0]?.kind, "remove", "the first controller event is the removeController");
      assert.equal(churn[1]?.kind, "configure", "the second controller event is the configureController");
      assert.equal(camera.stream?.builtFor.twoWayAudio, true, "the rebuilt controller is now built for two-way audio");
      assert.equal(camera.hints.twoWayAudio, true, "the two-way audio hint refreshed to true");
    } finally {

      camera.cleanup();
    }
  });

  test("a speaker drop never churns the controller and the additive-only hint stays true (subtractive-conservative, discriminating on the ||= refresh)", async () => {

    // A camera adopted WITH a speaker: the controller is built for two-way audio and the hint reads true.
    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { hasSpeaker: true } });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { nvr } = makeTestNvr({ store });
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

  test("a wholesale all-false featureFlags drain then the real values drives zero controller churn (the empirical reconnect contract, discriminating on a symmetric " +
    "predicate)", async () => {

    // A doorbell-with-speaker: the controller is built for both frozen audio capabilities. Every offline-to-online re-adopt delivers a wholesale all-false featureFlags
    // drain before the real values land, so the reconcile must not rebuild on the transient false.
    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { hasSpeaker: true, isDoorbell: true } });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { nvr } = makeTestNvr({ store });
    const accessory = makeTestAccessory("Test Camera", "uuid:two-way-audio-3");
    const camera = construct(nvr, accessory, new TestCameraProjection(cameraConfig.id, store));

    await settle();

    try {

      assert.equal(camera.stream?.builtFor.isDoorbell, true, "the controller is built for a doorbell");
      assert.equal(camera.stream?.builtFor.twoWayAudio, true, "the controller is built for two-way audio");

      const churnBaseline = accessory.controllerEvents.length;

      // The reconnect drain: a frame reporting the capabilities false, then the recovery frame restoring the real values.
      store.pushCameraFeatureFlags(cameraConfig.id, { hasSpeaker: false, isDoorbell: false });

      await settle();

      store.pushCameraFeatureFlags(cameraConfig.id, { hasSpeaker: true, isDoorbell: true });

      await settle();

      // Zero controller churn across the drain. A symmetric "the identities differ" predicate would rebuild on the all-false frame (current isDoorbell false differs
      // from built true) AND again on recovery (now built false differs from the restored true) -> four events -> RED. (The isDoorbell-false push also wakes the
      // settled-demotion warn; we assert only controller churn here.)
      assert.equal(accessory.controllerEvents.length, churnBaseline, "the all-false reconnect drain and recovery drove zero controller churn");
    } finally {

      camera.cleanup();
    }
  });

  test("a late hasSpeaker with Audio.TwoWay disabled never churns the controller (negative control, discriminating on the Audio.TwoWay clause)", async () => {

    // The speaker hardware will report, but the user disabled two-way audio. The hint derivation gates on the Audio.TwoWay feature option, so two-way audio stays off and
    // the controller is never rebuilt - the control that proves the hasFeature clauses are not undiscriminated.
    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { hasSpeaker: false } });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { nvr } = makeTestNvr({ store, userOptions: ["Disable.Audio.TwoWay"] });
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
      // && this.hasFeature("Audio.TwoWay") clause) would flip the hint true and rebuild -> RED, so this discriminates the otherwise-undiscriminated hasFeature clauses.
      assert.equal(accessory.controllerEvents.length, churnBaseline, "the disabled Audio.TwoWay option drove zero controller churn despite the late speaker");
      assert.equal(camera.hints.twoWayAudio, false, "the disabled Audio.TwoWay option held two-way audio off");
    } finally {

      camera.cleanup();
    }
  });

  test("a late hasSpeaker refreshes the direct-talkback hint when the direct option is enabled (the direct-talkback refresh, discriminating on the refresh line)",
    async () => {

      // The direct-talkback path reads hints.twoWayAudioDirect live (it is never frozen into the controller), so the reconcile refreshes it alongside two-way audio for
      // a late speaker. Enable the default-off Audio.TwoWay.Direct option and report the speaker late.
      const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { hasSpeaker: false } });
      const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
      const { nvr } = makeTestNvr({ store, userOptions: ["Enable.Audio.TwoWay.Direct"] });
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

  test("an unrelated featureFlags change never churns the controller built for its audio identity (routine wake, pinning the additive !built guard)", async () => {

    // A camera adopted WITH a speaker, already built for two-way audio. An unrelated capability change wakes the featureFlags observer but must not rebuild it.
    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { hasSpeaker: true } });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { nvr } = makeTestNvr({ store });
    const accessory = makeTestAccessory("Test Camera", "uuid:two-way-audio-6");
    const camera = construct(nvr, accessory, new TestCameraProjection(cameraConfig.id, store));

    await settle();

    try {

      assert.equal(camera.stream?.builtFor.twoWayAudio, true, "the controller is built for two-way audio");

      const churnBaseline = accessory.controllerEvents.length;

      // An unrelated capability (the status-light hardware) reports late.
      store.pushCameraFeatureFlags(cameraConfig.id, { hasLedStatus: true });

      await settle();

      // Zero churn: audioCapabilityAppeared reads no rising edge, since both built and current carry two-way audio true. Removing the if(!audioCapabilityAppeared(...))
      // return guard rebuilds on any wake -> RED; dropping the !built.twoWayAudio term (leaving current.twoWayAudio alone) reads true while built is already true so it
      // now reads appeared -> rebuild -> RED. This pins the additive !built guard.
      assert.equal(accessory.controllerEvents.length, churnBaseline, "the unrelated wake drove zero controller churn");
    } finally {

      camera.cleanup();
    }
  });
});
