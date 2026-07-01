/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * camera-mqtt.test.ts: The camera-leaf MQTT handler-body net - the three registered-but-never-invoked subscribeGet / subscribeSet handler bodies the camera's
 * configureMqtt registers (camera.ts), driven against the REAL constructed ProtectCamera by FINDING each captured subscription on the TestMqttClient double and
 * INVOKING its getValue() / setValue(value, rawValue) closure directly.
 *
 * The registration and lifetime of these subscriptions are netted elsewhere (device-mqtt-topic.test.ts pins the MAC-scoped topic composition, mqtt-lifetime pins the
 * signal scoping); this suite nets the BODIES the HomeKit onSet machinery never reaches: the /rtsp GET (the JSON URL map with its isRtspEnabled filter), the /snapshot
 * SET (the value !== "true" gate routing to the stream's snapshot request), and the /doorbell ring SET (the value !== "true" gate routing to doorbellEventHandler). The
 * captured-handler idiom is the established one (chime.test.ts, viewer.test.ts, sensor.test.ts): find by topic / kind, then invoke the closure and assert its effect.
 *
 * The vacuity gate is two-part (carried from the device-* law): every gated handler HARD-asserts its captured subscription EXISTS as the FIRST discriminator (a
 * non-optional assert.ok on the closure) before any behavior assertion - a find(...) returning undefined whose closure is then optional-chained would let the test pass
 * vacuously. The ring's feature-gated registration is paired with a without-gate test that proves no /doorbell subscription is registered on a plain camera.
 *
 * The ring is captured through a TEST-LOCAL ProtectEventDispatch subclass that overrides doorbellEventHandler into a recording array (the pattern
 * doorbell-effects.test.ts established), injected through makeTestNvr's dispatch seam and read back off nvr.events - NOT the shared TestRecordingDispatch, which
 * overrides only motionEventHandler. The override captures the routing (which device the ring fired for); it deliberately does not re-test the handler's HomeKit effects,
 * which are event-dispatch.ts's own concern, and it arms no reset timer, so cleanup leaks no handle.
 *
 * Every constructed camera is unwound through cleanup() plus the harness abort in an afterEach, so no observe loop outlives the test.
 */
import type { Camera, ProtectCameraConfig } from "unifi-protect";
import { G2_PRO_CHANNELS, MIXED_RTSP_DISABLED_CHANNELS } from "../../camera.fixtures.ts";
import type { TestAccessory, TestLogEntry, TestMqttClient, TestProtectNvr } from "../../testing.helpers.ts";
import { TestCameraProjection, TestStateStore, makeCameraConfig, makeProtectState, makeTestAccessory, makeTestNvr, settle } from "../../testing.helpers.ts";
import { afterEach, describe, mock, test } from "node:test";
import type { ProtectAccessory } from "../../types.ts";
import { ProtectCamera } from "./camera.ts";
import { ProtectEventDispatch } from "../../nvr/event-dispatch.ts";
import type { ProtectNvr } from "../../nvr/nvr.ts";
import assert from "node:assert/strict";

// One captured doorbell-ring routing. The /doorbell SET body's observable effect is which device it routed to, so this is the shape the recording subclass captures - the
// same posture doorbell-effects.test.ts uses for its own routing assertions.
interface RingCall {

  id: string;
}

// A REAL ProtectEventDispatch whose doorbell delivery is overridden to record rather than touch HomeKit or arm a ring timer. The override's arity and parameter types
// mirror production's doorbellEventHandler (event-dispatch.ts) exactly, so it type-checks as a true override; the camera's /doorbell SET body calls
// this.nvr.events.doorbellEventHandler(this), so this captures exactly that routing without firing the real ring's HomeKit effects or arming its reset timer.
class RecordingRingDispatch extends ProtectEventDispatch {

  public readonly rings: RingCall[] = [];

  public override doorbellEventHandler(protectDevice: ProtectCamera): void {

    this.rings.push({ id: protectDevice.protectId });
  }
}

// The construction handle a test holds, so the afterEach can unwind the per-accessory abort regardless of which build the test ran. mqtt is the captured-subscription
// surface every body is found through; the build narrows the Nullable<TestMqttClient> before returning, so the non-null double is what every test invokes against.
interface BuiltCamera {

  accessory: TestAccessory;
  camera: ProtectCamera;
  cameraConfig: ProtectCameraConfig;
  controller: AbortController;
  logEntries: TestLogEntry[];
  mqtt: TestMqttClient;
  nvr: TestProtectNvr;
}

// Build a REAL plain ProtectCamera against the doubles, exactly as camera-onsets.test.ts's buildCamera assembles it, with two additions this suite needs: mqtt is always
// threaded true (the captured subscriptions are the surface under test), and an optional dispatch factory installs the recording ring double. The casts are confined to
// this seam - the instance is the production ProtectCamera and everything it runs is the production path. makeTestNvr returns mqtt as Nullable<TestMqttClient>, so the
// helper narrows it (a throwing guard, exactly as buildDoorbell / buildLight do) before returning the non-null double; otherwise every mqtt.subscriptions.find is a
// strict-null TS error.
async function buildCamera(options: { channels?: ProtectCameraConfig["channels"]; dispatch?: (nvr: ProtectNvr) => ProtectEventDispatch;
  featureFlags?: Partial<ProtectCameraConfig["featureFlags"]>; userOptions?: string[]; } = {}): Promise<BuiltCamera> {

  // The /rtsp filter test threads its own channel set (MIXED_RTSP_DISABLED_CHANNELS) through the channels override; every other test takes the G2_PRO_CHANNELS default.
  const cameraConfig = makeCameraConfig({ channels: options.channels ?? G2_PRO_CHANNELS, ...(options.featureFlags ? { featureFlags: options.featureFlags } : {}) });
  const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
  const { controller, logEntries, mqtt, nvr } = makeTestNvr({ ...(options.dispatch ? { dispatch: options.dispatch } : {}), mqtt: true, store,
    userOptions: options.userOptions });
  const accessory = makeTestAccessory("Test Camera", "uuid:74ACB9000001");
  const projection = new TestCameraProjection(cameraConfig.id, store);
  const camera = new ProtectCamera(nvr as unknown as ProtectNvr, accessory as unknown as ProtectAccessory, projection as unknown as Camera);

  // Settle the floating configure IIFE and the observe loops' lazy registration before any drive so the camera is fully wired (the stream is stood up, the subscriptions
  // are registered) when a handler is invoked.
  await settle();

  // makeTestNvr was called with mqtt: true, so the recording double is present; a guard narrows Nullable<TestMqttClient> to the non-null type and fails loudly if the
  // opt-in ever stops installing the double, mirroring buildDoorbell / buildLight.
  if(!mqtt) {

    throw new Error("The MQTT recording double was not installed despite mqtt: true.");
  }

  return { accessory, camera, cameraConfig, controller, logEntries, mqtt, nvr };
}

describe("camera-leaf MQTT handler bodies (camera-mqtt concern net)", () => {

  // The per-test handle, torn down in afterEach so each test's per-accessory abort unwinds and no observe loop outlives the test.
  let built: BuiltCamera | undefined;

  afterEach(() => {

    built?.camera.cleanup();
    built?.controller.abort();
    built = undefined;
  });

  describe("the /rtsp GET (the JSON RTSP URL map)", () => {

    test("returns the per-channel RTSP URL map composed from connectionHost, the controller RTSP port, and each channel's alias", async () => {

      // Assign the build handle to the suite-level binding (so the afterEach unwinds it) AND destructure the locals the find closure and assertions read, narrowing them
      // once to non-undefined - TS cannot prove the nullable suite-level built stays defined inside a nested closure.
      const { cameraConfig, mqtt } = built = await buildCamera();

      // HARD-assert the /rtsp GET subscription exists FIRST: an absent subscription whose getValue is optional-chained would let the parse / deepEqual pass vacuously.
      const rtsp = mqtt.subscriptions.find((subscription) => (subscription.kind === "get") && (subscription.topic === cameraConfig.mac + "/rtsp"));

      assert.ok(rtsp?.getValue, "the camera registered a /rtsp GET subscription");

      // G2_PRO_CHANNELS carries three RTSP-enabled channels (High / Medium / Low, aliases alias0 / alias1 / alias2). makeCameraConfig seeds connectionHost to the fixture
      // host, and makeNvrConfig seeds the secure rtsps port to FIXTURE_RTSPS_PORT (7441), so the body composes rtsps://<connectionHost>:<rtsps-port>/<alias>?enableSrtp
      // through the shared rtspUrl SSOT (secure scheme on the secure port). The URL string is the contract the body promises, so we assert it literally.
      const urls = JSON.parse(rtsp.getValue()) as Record<string, string>;

      assert.deepEqual(urls, {

        High: "rtsps://camera.test:7441/alias0?enableSrtp",
        Low: "rtsps://camera.test:7441/alias2?enableSrtp",
        Medium: "rtsps://camera.test:7441/alias1?enableSrtp"
      }, "the /rtsp GET returns one URL per RTSP-enabled channel, keyed by the channel name");
    });

    test("the isRtspEnabled filter drops a channel whose RTSP is disabled", async () => {

      // MIXED_RTSP_DISABLED_CHANNELS marks the Medium channel (id 1) isRtspEnabled: false; High (id 0) and Low (id 2) stay enabled. The body's .filter(channel =>
      // channel.isRtspEnabled) must drop Medium, so the URL map has no Medium key - a mutation removing the filter would re-include it, which this asserts against.
      const { cameraConfig, mqtt } = built = await buildCamera({ channels: MIXED_RTSP_DISABLED_CHANNELS });

      const rtsp = mqtt.subscriptions.find((subscription) => (subscription.kind === "get") && (subscription.topic === cameraConfig.mac + "/rtsp"));

      assert.ok(rtsp?.getValue, "the camera registered a /rtsp GET subscription");

      const urls = JSON.parse(rtsp.getValue()) as Record<string, string>;

      assert.equal(urls["Medium"], undefined, "the RTSP-disabled Medium channel is filtered out of the URL map");
      assert.equal(urls["High"], "rtsps://camera.test:7441/alias0?enableSrtp", "the RTSP-enabled High channel is present with its composed URL");
      assert.equal(urls["Low"], "rtsps://camera.test:7441/alias2?enableSrtp", "the RTSP-enabled Low channel is present with its composed URL");
    });
  });

  describe("the /snapshot SET (the value gate routing to the stream's snapshot request)", () => {

    test("a \"true\" value triggers exactly one snapshot request, and a non-\"true\" value triggers none", async () => {

      const { camera, cameraConfig, mqtt } = built = await buildCamera();

      // HARD-assert the camera's stream stood up FIRST: the body calls this.stream?.handleSnapshotRequest(), so an absent stream would optional-chain to a no-op and the
      // spy would record nothing, passing the gate test vacuously.
      assert.ok(camera.stream, "the camera's streaming delegate stood up at configure");

      const snapshot = mqtt.subscriptions.find((subscription) => (subscription.kind === "set") && (subscription.topic === cameraConfig.mac + "/snapshot"));

      assert.ok(snapshot?.setValue, "the camera registered a /snapshot SET subscription");

      // Spy on the stream's snapshot entry point so we observe the body's routing by call count rather than any controller effect (the stub takes no snapshots).
      const spy = mock.method(camera.stream, "handleSnapshotRequest");

      try {

        // The "true" value passes the value !== "true" gate and routes to the snapshot request exactly once.
        await snapshot.setValue("true", "true");
        await settle();

        assert.equal(spy.mock.callCount(), 1, "a \"true\" value triggered exactly one snapshot request");

        // A non-"true" value (and the numeric-string "1", which is also not the literal "true") is gated out and triggers no further request.
        await snapshot.setValue("false", "false");
        await snapshot.setValue("1", "1");
        await settle();

        assert.equal(spy.mock.callCount(), 1, "a non-\"true\" value is gated out and triggers no additional snapshot request");
      } finally {

        mock.reset();
      }
    });
  });

  describe("the /doorbell ring SET (the value gate routing to doorbellEventHandler)", () => {

    test("with Enable.Doorbell.Trigger, a \"true\" value routes one ring to doorbellEventHandler with this camera", async () => {

      // Inject the recording dispatch so nvr.events.doorbellEventHandler is the captured override; the /doorbell subscription registers when isDoorbell ||
      // hasFeature("Doorbell.Trigger"), so a plain camera with Enable.Doorbell.Trigger registers it without a doorbell capability.
      const dispatch = (nvr: ProtectNvr): ProtectEventDispatch => new RecordingRingDispatch(nvr);

      const { cameraConfig, mqtt, nvr } = built = await buildCamera({ dispatch, userOptions: ["Enable.Doorbell.Trigger"] });

      // HARD-assert the /doorbell SET subscription exists FIRST: with Enable.Doorbell.Trigger it registers, and an absent subscription would let the ring assertions pass
      // vacuously.
      const doorbell = mqtt.subscriptions.find((subscription) => (subscription.kind === "set") && (subscription.topic === cameraConfig.mac + "/doorbell"));

      assert.ok(doorbell?.setValue, "Enable.Doorbell.Trigger registers a /doorbell SET subscription on the plain camera");

      const ring = nvr.events as unknown as RecordingRingDispatch;

      assert.equal(ring.rings.length, 0, "no ring has fired before the SET");

      // The "true" value passes the value !== "true" gate and fires this.nvr.events.doorbellEventHandler(this) - no accessory.context write, no controller write. The
      // recording override captures the routing. The body is synchronous, but we settle anyway as a harmless belt.
      await doorbell.setValue("true", "true");
      await settle();

      assert.equal(ring.rings.length, 1, "the \"true\" value fired exactly one ring through doorbellEventHandler");
      assert.equal(ring.rings[0]?.id, cameraConfig.id, "the ring routed to this camera (the protectDevice argument is the camera itself)");
    });

    test("a non-\"true\" value fires no ring", async () => {

      const dispatch = (nvr: ProtectNvr): ProtectEventDispatch => new RecordingRingDispatch(nvr);

      const { cameraConfig, mqtt, nvr } = built = await buildCamera({ dispatch, userOptions: ["Enable.Doorbell.Trigger"] });

      const doorbell = mqtt.subscriptions.find((subscription) => (subscription.kind === "set") && (subscription.topic === cameraConfig.mac + "/doorbell"));

      assert.ok(doorbell?.setValue, "the /doorbell SET subscription registered");

      const ring = nvr.events as unknown as RecordingRingDispatch;

      // The "false" value is gated out by value !== "true" before doorbellEventHandler is reached, so no ring is routed.
      await doorbell.setValue("false", "false");
      await settle();

      assert.equal(ring.rings.length, 0, "a non-\"true\" value is gated out and fires no ring");
    });

    test("without Enable.Doorbell.Trigger, a plain camera registers no /doorbell subscription", async () => {

      // The vacuity guard: a plain camera that is not a doorbell and has not enabled the trigger registers no /doorbell subscription, proving the ring tests'
      // registration is feature-driven, not incidental.
      const { cameraConfig, mqtt } = built = await buildCamera();

      const doorbell = mqtt.subscriptions.find((subscription) => (subscription.kind === "set") && (subscription.topic === cameraConfig.mac + "/doorbell"));

      assert.equal(doorbell, undefined, "a plain camera without Enable.Doorbell.Trigger registers no /doorbell SET subscription");
    });
  });
});
