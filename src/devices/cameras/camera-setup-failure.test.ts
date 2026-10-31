/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * camera-setup-failure.test.ts: A camera whose setup throws part way, released through configured(), and the camera a later attempt stands on the same accessory.
 *
 * A camera's configureDevice starts an asynchronous block before its synchronous body ends: the capability reconcile, with the switches chained onto it, and the
 * streaming derivation, with the camera details behind it. When the synchronous body then throws, configured() releases the camera while that block is still under way,
 * and the block must write nothing more to the accessory: a later attempt may already stand a live camera there, and a handler the released camera bound would close
 * over it and replace the live camera's. These tests fail a real ProtectCamera's setup at the one synchronous step that follows the block's start, the doorbell
 * reconcile's stale-service sweep on a plain camera, through a one-shot throw on the controller double's sweep. The camera enables the doorbell trigger, whose switch
 * the block's switches stand up with an onGet reading the camera's ring state, and lux and status-light hardware over a CameraOperatingMode service restored from the
 * accessory cache, so the block's capability reconcile waits on a lux read and its camera details would bind the status indicator.
 */
import { Characteristic, Service, TestStateStore, makeProtectState, makeTestAccessory } from "../../testing.helpers.ts";
import { TestCameraProjection, makeCameraConfig } from "../testing.helpers.ts";
import { describe, test } from "node:test";
import { settle, triggerGet } from "homebridge-plugin-utils/testing";
import type { Camera } from "unifi-protect";
import { G2_PRO_CHANNELS } from "../../camera.fixtures.ts";
import { ProtectCamera } from "./camera.ts";
import type { ProtectNvr } from "../../nvr/nvr.ts";
import { ProtectReservedNames } from "../../types.ts";
import type { TestProtectAccessory } from "../../testing.helpers.ts";
import assert from "node:assert/strict";
import { configured } from "../device-base.ts";
import { makeTestNvr } from "../../nvr/testing.helpers.ts";

// The rig every test here shares: a plain camera with lux and status-light hardware, the doorbell trigger enabled, the recording MQTT double, and an accessory
// carrying the CameraOperatingMode service a restart restores from the accessory cache.
function makeRig(): { accessory: TestProtectAccessory; cameraConfig: ReturnType<typeof makeCameraConfig>; controller: AbortController;
  mqtt: NonNullable<ReturnType<typeof makeTestNvr>["mqtt"]>; nvr: ReturnType<typeof makeTestNvr>["nvr"]; store: TestStateStore; } {

  const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { hasLedStatus: true, hasLuxCheck: true } });
  const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
  const { controller, mqtt, nvr } = makeTestNvr({ mqtt: true, store, userOptions: ["Enable.Doorbell.Trigger"] });
  const accessory = makeTestAccessory("Test Camera", cameraConfig.mac);

  assert.ok(mqtt, "the recording MQTT double is installed");

  accessory.addService(Service.CameraOperatingMode, "Test Camera");

  return { accessory, cameraConfig, controller, mqtt, nvr, store };
}

// How many times a camera registered its RTSP information topic, read off the spy on the double's subscribeGet: one per camera setup that reached its MQTT interface.
function rtspRegistrations(subscribeGet: { mock: { calls: readonly { arguments: readonly unknown[] }[] } }): number {

  return subscribeGet.mock.calls.filter((call) => (typeof call.arguments[0] === "string") && call.arguments[0].endsWith("/rtsp")).length;
}

// The RTSP information registrations still live on the double, which releases an entry the moment its owner's lifetime ends.
function liveRtspGets(mqtt: NonNullable<ReturnType<typeof makeTestNvr>["mqtt"]>): number {

  return mqtt.subscriptions.filter((subscription) => subscription.topic.endsWith("/rtsp/get")).length;
}

// The doorbell trigger switches on the accessory, which the block's switches stand up on a live camera.
function triggerSwitches(accessory: TestProtectAccessory): InstanceType<typeof Service.Switch>[] {

  return accessory.services.filter((service) => (service.UUID === Service.Switch.UUID) && (service.subtype === ProtectReservedNames.SWITCH_DOORBELL_TRIGGER));
}

describe("a camera whose setup throws part way", () => {

  test("the camera is released, and the setup already under way writes nothing more to its accessory", async (t) => {

    const { accessory, cameraConfig, controller, mqtt, nvr, store } = makeRig();
    const failure = new Error("The stale doorbell services could not be swept.");

    const subscribeGet = t.mock.method(mqtt, "subscribeGet");

    t.mock.method(nvr, "removeStaleDoorbellServices", (): never => { throw failure; }, { times: 1 });

    const camera = new ProtectCamera(nvr as unknown as ProtectNvr, accessory, new TestCameraProjection(cameraConfig.id, store) as unknown as Camera);

    try {

      assert.throws(() => configured(camera), (error: unknown) => error === failure, "configured() rethrows the setup's own error");
      assert.equal(camera.canConfigureStream, false, "the release marked the camera deleted, so no streaming delegate is ever built for it");
      assert.equal(rtspRegistrations(subscribeGet), 1, "the setup registered the camera's MQTT interface before it threw");
      assert.equal(liveRtspGets(mqtt), 0, "the release ended the camera's lifetime, and the MQTT registrations its setup made with it");

      // Let the block the setup started run to its end: the lux read, the switches chained onto the capability reconcile, and the streaming derivation.
      await settle();

      assert.equal(triggerSwitches(accessory).length, 0, "the released camera stood up none of the switches its block chains onto the capability reconcile");

      const operatingMode = accessory.getService(Service.CameraOperatingMode);

      assert.ok(operatingMode, "the restored CameraOperatingMode service is on the accessory");
      assert.equal(operatingMode.testCharacteristic(Characteristic.CameraOperatingModeIndicator), false,
        "the released camera's block configured no camera details on the restored operating-mode service");
    } finally {

      controller.abort();
    }
  });

  test("a later attempt stands one live camera on the accessory, and its handlers answer from that camera when the released camera's setup settles after it",
    async (t) => {

      const { accessory, cameraConfig, controller, mqtt, nvr, store } = makeRig();
      const failure = new Error("The stale doorbell services could not be swept.");
      const firstProjection = new TestCameraProjection(cameraConfig.id, store);
      const lux = Promise.withResolvers<number>();

      // Hold the released camera's lux read open, so its block is still waiting when the later attempt configures and settles: the order a long-running controller
      // gives a retry that lands while the failed camera waits on the controller.
      const subscribeGet = t.mock.method(mqtt, "subscribeGet");

      t.mock.method(firstProjection, "lux", async (): Promise<number> => lux.promise);
      t.mock.method(nvr, "removeStaleDoorbellServices", (): never => { throw failure; }, { times: 1 });

      const first = new ProtectCamera(nvr as unknown as ProtectNvr, accessory, firstProjection as unknown as Camera);

      assert.throws(() => configured(first), (error: unknown) => error === failure, "the first attempt's setup threw");

      const second = configured(new ProtectCamera(nvr as unknown as ProtectNvr, accessory, new TestCameraProjection(cameraConfig.id, store) as unknown as Camera));

      try {

        await settle();

        // The released camera's lux read answers here, after the live camera has finished its own setup.
        lux.resolve(100);

        await settle();

        assert.equal(rtspRegistrations(subscribeGet), 2, "each attempt registered the camera's MQTT interface");
        assert.equal(liveRtspGets(mqtt), 1, "the first attempt's registrations ended with its release, so one live camera answers on the accessory");

        const switches = triggerSwitches(accessory);

        assert.equal(switches.length, 1, "the accessory carries one doorbell trigger switch");

        const trigger = switches[0]?.getCharacteristic(Characteristic.On);

        assert.ok(trigger, "the doorbell trigger switch carries its On characteristic");

        second.isRinging = true;

        assert.equal(await triggerGet(trigger), true, "the trigger's handler answers from the live camera, not the released one");
      } finally {

        second.cleanup();
        controller.abort();
      }
    });
});
