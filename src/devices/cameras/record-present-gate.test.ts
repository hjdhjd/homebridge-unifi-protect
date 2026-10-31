/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * record-present-gate.test.ts: The observeState recordPresent gate during the removal grace. When a device is unadopted at the controller, its config record leaves the
 * store but its ProtectDevice wrapper lingers for the DelayDeviceRemoval grace. The gate (if(!this.recordPresent) continue) keeps every observe loop subscribed while
 * suppressing its handler, so an async-void capability handler never re-reads the vanished record and throws into the detached loop, and a re-adoption within the grace
 * resumes the handlers with no respawn. This drives a REAL ProtectCamera against the camera-construction harness doubles, as capability-reconcile.test.ts does, and is
 * SELF-VALIDATING: the positive liveness control (a present-record push reconciles and creates the sensor) proves the counter and the observer are live, so the
 * suppression assertion that follows cannot pass for the wrong reason. The global unhandledRejection channel and a loopFaultReporter spy are deliberately NOT consulted.
 */
import { Characteristic, Service, TestStateStore, makeProtectState, makeTestAccessory } from "../../testing.helpers.ts";
import { G2_PRO_CHANNELS, G6_PRO_ENTRY_CHANNELS } from "../../camera.fixtures.ts";
import { TestCameraProjection, makeCameraConfig } from "../testing.helpers.ts";
import { describe, test } from "node:test";
import { settle, triggerSet } from "homebridge-plugin-utils/testing";
import type { Camera } from "unifi-protect";
import { ProtectCamera } from "./camera.ts";
import type { ProtectNvr } from "../../nvr/nvr.ts";
import type { TestProtectAccessory } from "../../testing.helpers.ts";
import type { TestProtectNvr } from "../../nvr/testing.helpers.ts";
import assert from "node:assert/strict";
import { configured } from "../device-base.ts";
import { makeTestNvr } from "../../nvr/testing.helpers.ts";

// A ProtectCamera that counts its reconcileCapabilities invocations, so the test proves the async-void capability observer is LIVE (the count rises on a present-record
// push, alongside the service that reconcile creates) and then SUPPRESSED once the record vanishes (the count holds). The setup pass's own reconcile is counted too,
// so the count measures the live observer's invocations against the baseline read once setup has settled.
class CountingCamera extends ProtectCamera {

  public reconcileCount = 0;

  protected override async reconcileCapabilities(source: "construct" | "observe"): Promise<void> {

    this.reconcileCount++;

    return super.reconcileCapabilities(source);
  }
}

// Construct a real CountingCamera, with the casts confined to this one boundary - the instance under test is the production class and its real observe loops.
function construct(nvr: TestProtectNvr, accessory: TestProtectAccessory, projection: TestCameraProjection): CountingCamera {

  return configured(new CountingCamera(nvr as unknown as ProtectNvr, accessory, projection as unknown as Camera));
}

describe("the observeState recordPresent gate during the removal grace", () => {

  test("an async-void capability observer reconciles while the record is present and is suppressed once it vanishes (self-validating)", async () => {

    // A camera adopted WITHOUT the lux capability, so the ambient light sensor is absent at adoption - its later appearance is the observable proof the observer ran.
    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { hasLuxCheck: false } });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { controller, nvr } = makeTestNvr({ store });
    const accessory = makeTestAccessory("Test Camera", cameraConfig.mac);
    const camera = construct(nvr, accessory, new TestCameraProjection(cameraConfig.id, store));

    await settle();

    try {

      // The baseline after setup (the construct reconcile already counted), and the camera's full set of observe loops.
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
        "guarantee (the reconcileCount assertion above is what tells the two apart)");
    } finally {

      camera.cleanup();
      controller.abort();
    }
  });

  // #17/G2-D1: the camera capability getters read the throwing ufp projection, and the reconcile pass reads them on every kick - including after an await where the
  // record can vanish. Hardened through fromRecord, they report safe defaults over a vanished record rather than throwing, which keeps the supervisor's reconcile
  // pass safe across its many fire-and-forget kicks.
  test("the camera capability getters return safe defaults over a vanished record instead of throwing", async () => {

    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { controller, nvr } = makeTestNvr({ store });
    const accessory = makeTestAccessory("Test Camera", cameraConfig.mac);
    const camera = construct(nvr, accessory, new TestCameraProjection(cameraConfig.id, store));

    await settle();

    try {

      // With the record present, the getters read through the live projection normally.
      assert.equal(camera.usesTimeshiftLivestream, true, "usesTimeshiftLivestream reads true through the present record");
      assert.ok(camera.videoCodecName.length > 0, "videoCodecName reads a non-empty label through the present record");

      // The record vanishes (the camera unadopted, lingering in the removal grace). The getters must report their safe defaults, not throw on the vanished ufp read.
      store.removeCameraRecord(cameraConfig.id);

      await settle();

      assert.equal(camera.usesTimeshiftLivestream, false, "usesTimeshiftLivestream returns its false default over the vanished record");
      assert.equal(camera.videoCodecName, "", "videoCodecName returns its empty default over the vanished record");
    } finally {

      camera.cleanup();
      controller.abort();
    }
  });

  test("with name syncing on and the doorbell's record gone, a rename of its package camera's tile is put back with the package's suffix once", async () => {

    // The record vanishes for the doorbell and its package camera alike, since they share one projection, so the package's watch reads its owned name from the name its
    // own accessory carries, which already ends in the display suffix.
    const cameraConfig = makeCameraConfig({ channels: G6_PRO_ENTRY_CHANNELS, featureFlags: { hasPackageCamera: true, isDoorbell: true }, name: "Front Door" });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { controller, nvr } = makeTestNvr({ store, userOptions: ["Enable.Device.SyncName"] });
    const camera = construct(nvr, makeTestAccessory("Front Door", cameraConfig.mac), new TestCameraProjection(cameraConfig.id, store));

    await settle();

    try {

      const info = camera.packageCamera?.accessory.getService(Service.AccessoryInformation);

      assert.ok(info, "the package camera stands with its information service");
      assert.equal(info.getCharacteristic(Characteristic.ConfiguredName).value, "Front Door Package Camera", "precondition: the package carries its suffixed name");

      store.removeCameraRecord(cameraConfig.id);

      await settle();
      await triggerSet(info.getCharacteristic(Characteristic.ConfiguredName), "Den Camera");
      await settle();

      assert.equal(info.getCharacteristic(Characteristic.ConfiguredName).value, "Front Door Package Camera", "the restore put the name back with the suffix once");
    } finally {

      camera.cleanup();
      controller.abort();
    }
  });
});
