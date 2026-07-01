/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * record-present-gate.test.ts: The observeState recordPresent gate during the removal grace. When a device is unadopted at the controller, its config record leaves the
 * store but its ProtectDevice wrapper lingers for the DelayDeviceRemoval grace. The gate (if(!this.recordPresent) continue) keeps every observe loop subscribed while
 * suppressing its handler, so an async-void capability handler never re-reads the vanished record and throws into the detached loop, and a re-adoption within the grace
 * resumes the handlers with no respawn. This drives a REAL ProtectCamera against the camera-construction harness doubles, as capability-reconcile.test.ts does, and is
 * SELF-VALIDATING: the positive liveness control (a present-record push reconciles and creates the sensor) proves the counter and the observer are live, so the
 * suppression assertion that follows cannot pass for the wrong reason. The global unhandledRejection channel and a loopFaultReporter spy are deliberately NOT consulted.
 */
import { Service, TestCameraProjection, TestStateStore, makeCameraConfig, makeProtectState, makeTestAccessory, makeTestNvr, settle } from "../../testing.helpers.ts";
import type { TestAccessory, TestProtectNvr } from "../../testing.helpers.ts";
import { describe, test } from "node:test";
import type { Camera } from "unifi-protect";
import { G2_PRO_CHANNELS } from "../../camera.fixtures.ts";
import type { ProtectAccessory } from "../../types.ts";
import { ProtectCamera } from "./camera.ts";
import type { ProtectNvr } from "../../nvr/nvr.ts";
import assert from "node:assert/strict";

// A ProtectCamera that counts its reconcileCapabilities invocations, so the test proves the async-void capability observer is LIVE (the count rises on a present-record
// push, alongside the service that reconcile creates) and then SUPPRESSED once the record vanishes (the count holds). Construction's own reconcile is wiped from this
// counter by ES2024 subclass field-define (the field initializes to 0 after super returns), so the count measures the live observer's invocations from a 0 baseline.
class CountingCamera extends ProtectCamera {

  public reconcileCount = 0;

  protected override async reconcileCapabilities(source: "construct" | "observe"): Promise<void> {

    this.reconcileCount++;

    return super.reconcileCapabilities(source);
  }
}

// Construct a real CountingCamera, with the casts confined to this one seam - the instance under test is the production class and its real observe loops.
function construct(nvr: TestProtectNvr, accessory: TestAccessory, projection: TestCameraProjection): CountingCamera {

  return new CountingCamera(nvr as unknown as ProtectNvr, accessory as unknown as ProtectAccessory, projection as unknown as Camera);
}

describe("the observeState recordPresent gate during the removal grace", () => {

  test("an async-void capability observer reconciles while the record is present and is suppressed once it vanishes (self-validating)", async () => {

    // A camera adopted WITHOUT the lux capability, so the ambient light sensor is absent at adoption - its later appearance is the observable proof the observer ran.
    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { hasLuxCheck: false } });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { nvr } = makeTestNvr({ store });
    const accessory = makeTestAccessory("Test Camera", "uuid:record-present-gate-1");
    const camera = construct(nvr, accessory, new TestCameraProjection(cameraConfig.id, store));

    await settle();

    try {

      // The baseline after construction (the construct reconcile is wiped from the counter by the subclass field-define), and the camera's full set of observe loops.
      const baseline = camera.reconcileCount;
      const observerCount = store.observerCount;

      assert.ok(observerCount > 0, "the camera spawned its observe loops");
      assert.equal(accessory.getService(Service.LightSensor), undefined, "no ambient light sensor exists before the present-record push (the vacuity guard)");

      // Positive liveness control: a featureFlags push with the record PRESENT wakes the async-void capability observer, which invokes reconcileCapabilities and creates
      // the ambient light sensor. The count rising AND the service appearing prove the observer is live and the counter records its invocations.
      store.pushCameraFeatureFlags(cameraConfig.id, { hasLuxCheck: true });

      await settle();

      assert.ok(camera.reconcileCount > baseline, "the present-record featureFlags push invoked reconcileCapabilities - the async-void observer is live");
      assert.ok(accessory.getService(Service.LightSensor), "the present-record reconcile created the ambient light sensor");

      const afterPresentPush = camera.reconcileCount;

      // The record vanishes (the camera unadopted, lingering in the removal grace). The removal wakes every observer (their slices go undefined), but the recordPresent
      // gate (continue) suppresses each handler before it runs: the async-void capability observer does NOT invoke reconcileCapabilities (so it cannot throw into the
      // detached loop), and every observe loop stays subscribed rather than dying - so a re-adoption within the grace resumes the handlers with no respawn.
      store.removeCameraRecord(cameraConfig.id);

      await settle();

      assert.equal(camera.reconcileCount, afterPresentPush,
        "the recordPresent gate suppressed the async-void capability observer once the record vanished - reconcileCapabilities was not invoked");
      assert.equal(store.observerCount, observerCount,
        "every observe loop stayed subscribed across the vanished record (continue, not break) so a re-adoption resumes them - the survival " +
        "invariant (the reconcileCount assertion above is the gate's discriminator)");
    } finally {

      camera.cleanup();
    }
  });
});
