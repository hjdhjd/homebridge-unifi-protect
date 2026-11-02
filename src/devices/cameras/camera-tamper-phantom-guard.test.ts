/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * camera-tamper-phantom-guard.test.ts: The StatusTampered phantom guard across both camera push sites.
 *
 * A camera's StatusTampered indicator is an OPTIONAL characteristic on its MotionSensor, created only when both the hardware capability and the user setting are present.
 * The latched tamper value is re-applied onto that characteristic by the camera state reaction (updateCameraState, camera.ts, driven by the lifecycle-state
 * observer) and the firehose tamper delivery (tamperEventHandler, event-dispatch.ts). HAP's updateCharacteristic routes through getCharacteristic, which lazily
 * materializes an absent optional characteristic, so an UNGUARDED push on a camera without tamper detection sprouts an always-false phantom StatusTampered. Both
 * sites guard the push behind testCharacteristic, mirroring how the sensor family fans StatusTampered out (sensor.ts) - the latch and the log stay
 * unconditional, only the HomeKit push is gated on the characteristic's real presence.
 *
 * This suite drives a REAL constructed ProtectCamera against the camera-construction harness doubles and asserts each guard behavior-FIRST: construct a camera with no
 * tamper detection (the construct reconcile prunes StatusTampered), exercise a push site, and assert the characteristic never materialized while the side that must
 * still run (the state observer's wake, the isTampered latch) did. The mutation each test turns on - removing the testCharacteristic guard at the site under test - is
 * traced in its comments and materializes the phantom, turning the absence assertion RED. The package camera goes through the guarded base camera state reaction, so it
 * needs no bespoke updateCameraState override of its own; that its reaction carries the guard is asserted by doorbell-construction.test.ts.
 */
import { Characteristic, Service, TestStateStore, makeProtectState, makeTestAccessory } from "../../testing.helpers.ts";
import { TestCameraProjection, makeCameraConfig } from "../testing.helpers.ts";
import { describe, test } from "node:test";
import type { Camera } from "unifi-protect";
import { G2_PRO_CHANNELS } from "../../camera.fixtures.ts";
import { ProtectCamera } from "./camera.ts";
import type { ProtectNvr } from "../../nvr/nvr.ts";
import type { TestProtectAccessory } from "../../testing.helpers.ts";
import type { TestProtectNvr } from "../../nvr/testing.helpers.ts";
import assert from "node:assert/strict";
import { channels } from "../../diagnostics.ts";
import { configured } from "../device-base.ts";
import { makeTestNvr } from "../../nvr/testing.helpers.ts";
import { settle } from "homebridge-plugin-utils/testing";

// Construct a real ProtectCamera, with the casts confined to this one construction call - the instance under test is the production class and its real configure path.
// A doorbell config (isDoorbell plus hasPackageCamera) composes the doorbell capability, which creates the package camera reachable through the camera's packageCamera
// getter.
function construct(nvr: TestProtectNvr, accessory: TestProtectAccessory, projection: TestCameraProjection): ProtectCamera {

  return configured(new ProtectCamera(nvr as unknown as ProtectNvr, accessory, projection as unknown as Camera));
}

describe("the StatusTampered phantom guard - camera availability and tamper-event push sites", () => {

  test("a lifecycle-state transition on a no-tamper camera never materializes a phantom StatusTampered (the updateCameraState guard)", async () => {

    // A camera the controller adopts WITHOUT tamper detection: the makeCameraConfig defaults leave hasTamperDetection and enableTamperDetection false, so the construct
    // reconcile's tamper gate prunes and no StatusTampered exists at adoption.
    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { controller, nvr } = makeTestNvr({ store });
    const accessory = makeTestAccessory("Test Camera", cameraConfig.mac);
    const camera = construct(nvr, accessory, new TestCameraProjection(cameraConfig.id, store));
    const wakes: string[] = [];
    const noteWake = (message: unknown): void => void wakes.push((message as { key: string }).key);

    await settle();

    channels.observerWake.subscribe(noteWake);

    try {

      const motionService = accessory.getService(Service.MotionSensor);

      assert.ok(motionService, "the camera carries its motion sensor, the host of the (absent) StatusTampered characteristic");

      // The vacuity guard: StatusTampered is genuinely absent before the push, so a post-push presence would be a real materialization rather than a pre-existing one.
      assert.equal(motionService.testCharacteristic(Characteristic.StatusTampered), false, "no StatusTampered characteristic exists at adoption on a no-tamper camera");

      // Drive a genuine lifecycle-state transition: makeCameraConfig seeds state CONNECTED, so pushing DISCONNECTED is a real change that wakes the camera.state observer
      // and runs updateCameraState.
      store.pushCameraPatch(cameraConfig.id, { state: "DISCONNECTED" });

      await settle();

      // updateCameraState actually ran: the lifecycle-state observer that runs it woke on the push, so the StatusTampered-absence below is a live result and not a dead
      // observer.
      assert.ok(wakes.includes("camera.state"), "the lifecycle-state observer woke and ran updateCameraState");

      // The guard held: updateCameraState skipped the StatusTampered re-apply because testCharacteristic reported it absent, so no phantom materialized. Removing the
      // testCharacteristic guard in updateCameraState (pushing StatusTampered unconditionally) lets updateCharacteristic lazily materialize the phantom -> RED.
      assert.equal(motionService.testCharacteristic(Characteristic.StatusTampered), false,
        "the camera state reaction's guard kept StatusTampered from materializing on a camera without tamper detection");
    } finally {

      channels.observerWake.unsubscribe(noteWake);
      camera.cleanup();
      controller.abort();
    }
  });

  test("a tamper event on a no-tamper camera latches isTampered but never materializes a phantom StatusTampered (the tamperEventHandler guard)", async () => {

    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { controller, nvr } = makeTestNvr({ store });
    const accessory = makeTestAccessory("Test Camera", cameraConfig.mac);
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
      controller.abort();
    }
  });
});
