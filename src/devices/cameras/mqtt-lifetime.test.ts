/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * mqtt-lifetime.test.ts: MQTT subscription lifetime - every registration is scoped to its owner's lifetime signal.
 *
 * The ProtectBase MQTT wrappers thread the owner-lifetime signal (observeSignal) into every subscribeGet / subscribeSet registration, so an owner's teardown
 * releases exactly that owner's handlers. This matters most on SHARED topics: the package camera's motion handlers live on the parent doorbell's MAC tuple, and a
 * tuple-wide unsubscribe would clobber the live parent's handlers - the per-subscription signal is the structural fix. What this suite pins is HBUP's side of the
 * seam: each registration carries a signal, the signal is the registering owner's (the package's registrations on the shared tuple carry the package's signal, not
 * the parent's), and each owner's cleanup aborts its own registrations' signals while leaving the other owner's live. The release-on-abort mechanics themselves -
 * removing exactly the aborted handler from the topic's handler set - are HBPU's per-subscription-signal contract, pinned by HBPU's own tests; re-testing them here
 * against a recording double would be vacuous.
 */
import { TestCameraProjection, TestStateStore, makeCameraConfig, makeProtectState, makeTestAccessory, makeTestNvr, settle } from "../../testing.helpers.ts";
import { describe, test } from "node:test";
import type { Camera } from "unifi-protect";
import { G6_PRO_ENTRY_CHANNELS } from "../../camera.fixtures.ts";
import type { ProtectAccessory } from "../../types.ts";
import { ProtectCamera } from "./camera.ts";
import type { ProtectNvr } from "../../nvr/nvr.ts";
import type { TestMqttSubscription } from "../../testing.helpers.ts";
import assert from "node:assert/strict";

describe("MQTT subscription lifetime (owner-signal scoping)", () => {

  test("every registration carries its owner's lifetime signal, and each owner's cleanup aborts exactly its own - including on the shared parent-mac tuple", async () => {

    const cameraConfig = makeCameraConfig({ channels: G6_PRO_ENTRY_CHANNELS, featureFlags: { hasPackageCamera: true, isDoorbell: true }, name: "Front Door" });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { controller, mqtt, nvr } = makeTestNvr({ mqtt: true, store });

    assert.ok(mqtt, "the recording MQTT double is installed");

    const doorbell = new ProtectCamera(nvr as unknown as ProtectNvr, makeTestAccessory("Front Door", "uuid:74ACB9000001") as unknown as ProtectAccessory,
      new TestCameraProjection(cameraConfig.id, store) as unknown as Camera);

    await settle();

    // Every registration the family made carries a live lifetime signal - none is registered unscoped.
    assert.ok(mqtt.subscriptions.length > 0, "the family registered MQTT subscriptions");
    assert.ok(mqtt.subscriptions.every((subscription) => subscription.init?.signal instanceof AbortSignal), "every registration carries a lifetime signal");
    assert.ok(mqtt.subscriptions.every((subscription) => subscription.init?.signal?.aborted === false), "every lifetime signal is live after construction");

    // The parent's signal, identified through a registration only the parent makes (the camera's RTSP information topic).
    const parentSignal = mqtt.subscriptions.find((subscription) => subscription.topic === "74ACB9000001/rtsp")?.init?.signal;

    assert.ok(parentSignal, "the parent's own registration identifies its lifetime signal");

    // The shared parent-MAC motion tuple: the parent and the package each hold a get/set pair on the SAME topic, the deliberate shared-topic quirk. The package's
    // pair must carry the package's own signal, never the parent's - that separation is exactly what makes a per-owner release possible on a shared topic.
    const motionSubscriptions: TestMqttSubscription[] = mqtt.subscriptions.filter((subscription) => subscription.topic === "74ACB9000001/motion");
    const packageMotionSubscriptions = motionSubscriptions.filter((subscription) => subscription.init?.signal !== parentSignal);

    assert.equal(motionSubscriptions.length, 4, "the parent and the package each registered a get/set pair on the shared motion topic");
    assert.equal(packageMotionSubscriptions.length, 2, "the package's pair carries its own lifetime signal, distinct from the parent's");

    // The package's teardown aborts the package's registrations - and ONLY the package's: the parent's handlers on the very same topic stay live.
    assert.ok(doorbell.packageCamera, "the package camera instance is live");
    doorbell.packageCamera.cleanup();

    await settle();

    assert.ok(packageMotionSubscriptions.every((subscription) => subscription.init?.signal?.aborted === true),
      "the package's registrations died with the package's lifetime");
    assert.equal(parentSignal.aborted, false, "the parent's registrations on the shared tuple survive the package's teardown");

    // The parent's teardown then releases the rest.
    doorbell.cleanup();

    await settle();

    assert.equal(parentSignal.aborted, true, "the parent's registrations die with the parent's lifetime");
    assert.ok(mqtt.subscriptions.every((subscription) => subscription.init?.signal?.aborted === true), "no registration's lifetime survives the family teardown");

    controller.abort();
  });
});
