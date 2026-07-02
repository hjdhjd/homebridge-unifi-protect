/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * camera-tamper-phantom-guard.test.ts: The StatusTampered phantom guard across both camera push sites.
 *
 * A camera's StatusTampered indicator is an OPTIONAL characteristic on its MotionSensor, created only when both the hardware capability and the user setting are present.
 * Two paths re-apply the latched tamper value onto that characteristic - the availability projection (updateAvailability, camera.ts, driven by the lifecycle-state
 * observer) and the firehose tamper delivery (tamperEventHandler, event-dispatch.ts). HAP's updateCharacteristic routes through getCharacteristic, which lazily
 * materializes an absent optional characteristic, so an UNGUARDED push on a camera without tamper detection sprouts an always-false phantom StatusTampered. Both
 * sites now guard the push behind testCharacteristic, mirroring how the sensor family fans StatusTampered out (sensor.ts) - the latch and the log stay
 * unconditional, only the HomeKit push is gated on the characteristic's real presence.
 *
 * This suite drives a REAL constructed ProtectCamera against the camera-construction harness doubles and pins each guard behavior-FIRST: construct a camera with no
 * tamper detection (the construct reconcile prunes StatusTampered), exercise a push site, and assert the characteristic never materialized while the side that must
 * still run (StatusActive, the isTampered latch) did. Each test's discriminating mutation - removing the testCharacteristic guard at the site under test - is traced in
 * its comments and materializes the phantom, turning the absence assertion RED. The package camera rides the guarded base availability projection, so it needs no bespoke
 * updateAvailability override of its own; that its projection carries the guard is pinned by doorbell-construction.test.ts.
 */
import { Characteristic, Service, TestCameraProjection, TestStateStore, makeCameraConfig, makeProtectState, makeTestAccessory, makeTestNvr, settle }
  from "../../testing.helpers.ts";
import type { TestAccessory, TestProtectNvr } from "../../testing.helpers.ts";
import { describe, test } from "node:test";
import type { Camera } from "unifi-protect";
import { G2_PRO_CHANNELS } from "../../camera.fixtures.ts";
import type { ProtectAccessory } from "../../types.ts";
import { ProtectCamera } from "./camera.ts";
import type { ProtectNvr } from "../../nvr/nvr.ts";
import assert from "node:assert/strict";

// Construct a real ProtectCamera, with the casts confined to this one seam - the instance under test is the production class and its real configure path. A doorbell
// config (isDoorbell plus hasPackageCamera) composes the doorbell capability, which creates the package camera reachable through the camera's packageCamera getter.
function construct(nvr: TestProtectNvr, accessory: TestAccessory, projection: TestCameraProjection): ProtectCamera {

  return new ProtectCamera(nvr as unknown as ProtectNvr, accessory as unknown as ProtectAccessory, projection as unknown as Camera);
}

describe("the StatusTampered phantom guard - camera availability and tamper-event push sites", () => {

  test("a lifecycle-state transition on a no-tamper camera never materializes a phantom StatusTampered (the updateAvailability guard)", async () => {

    // A camera the controller adopts WITHOUT tamper detection: the makeCameraConfig defaults leave hasTamperDetection and enableTamperDetection false, so the construct
    // reconcile's tamper gate prunes and no StatusTampered exists at adoption.
    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { nvr } = makeTestNvr({ store });
    const accessory = makeTestAccessory("Test Camera", "uuid:tamper-phantom-1");
    const camera = construct(nvr, accessory, new TestCameraProjection(cameraConfig.id, store));

    await settle();

    try {

      const motionService = accessory.getService(Service.MotionSensor);

      assert.ok(motionService, "the camera carries its motion sensor, the host of StatusActive and the (absent) StatusTampered characteristic");

      // The vacuity guard: StatusTampered is genuinely absent before the push, so a post-push presence would be a real materialization rather than a pre-existing one.
      assert.equal(motionService.testCharacteristic(Characteristic.StatusTampered), false, "no StatusTampered characteristic exists at adoption on a no-tamper camera");

      // Drive a genuine lifecycle-state transition: makeCameraConfig seeds state CONNECTED, so pushing DISCONNECTED is a real change that wakes the camera.state observer
      // and runs updateAvailability.
      store.pushCameraPatch(cameraConfig.id, { state: "DISCONNECTED" });

      await settle();

      // updateAvailability actually ran: it pushed StatusActive down to the now-offline reachability, so the StatusTampered-absence below is a live result and not a dead
      // observer.
      assert.equal(motionService.getCharacteristic(Characteristic.StatusActive).value, false,
        "updateAvailability ran - StatusActive reflects the now-offline reachability");

      // The guard held: updateAvailability skipped the StatusTampered re-apply because testCharacteristic reported it absent, so no phantom materialized. Removing the
      // testCharacteristic guard in updateAvailability (pushing StatusTampered unconditionally) lets updateCharacteristic lazily materialize the phantom -> RED.
      assert.equal(motionService.testCharacteristic(Characteristic.StatusTampered), false,
        "the availability projection's guard kept StatusTampered from materializing on a camera without tamper detection");
    } finally {

      camera.cleanup();
    }
  });

  test("a tamper event on a no-tamper camera latches isTampered but never materializes a phantom StatusTampered (the tamperEventHandler guard)", async () => {

    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { nvr } = makeTestNvr({ store });
    const accessory = makeTestAccessory("Test Camera", "uuid:tamper-phantom-2");
    const camera = construct(nvr, accessory, new TestCameraProjection(cameraConfig.id, store));

    await settle();

    try {

      const motionService = accessory.getService(Service.MotionSensor);

      assert.ok(motionService, "the camera carries its motion sensor");

      // The vacuity guard: StatusTampered is genuinely absent before the tamper event.
      assert.equal(motionService.testCharacteristic(Characteristic.StatusTampered), false, "no StatusTampered characteristic exists before the tamper event");

      // Deliver a tamper occurrence through the real ProtectEventDispatch the NVR double carries. The handler latches isTampered and logs unconditionally, but guards the
      // StatusTampered push behind testCharacteristic. The handler is synchronous, so the effect is asserted directly.
      nvr.events.tamperEventHandler(camera);

      // The latch is the single source of truth and runs regardless of the characteristic's presence - a camera with no StatusTampered still records the tamper.
      assert.equal(camera.isTampered, true, "the tamper event latched isTampered even though the camera carries no StatusTampered characteristic");

      // The guard held: no phantom materialized. Removing the testCharacteristic guard in tamperEventHandler (pushing StatusTampered unconditionally) lazily materializes
      // the phantom -> RED on this absence assertion, while the latch assertion above stays green.
      assert.equal(motionService.testCharacteristic(Characteristic.StatusTampered), false,
        "the tamper-event handler's guard kept StatusTampered from materializing on a camera without tamper detection");
    } finally {

      camera.cleanup();
    }
  });
});
