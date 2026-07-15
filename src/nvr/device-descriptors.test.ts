/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * device-descriptors.test.ts: Completeness of the NVR's category -> HomeKit-class construction. The descriptor registry on ProtectNvr wires each DeviceCollectionKey to
 * the class it builds; the registry's rows are correlated so a mis-wired row is already a compile error, and this suite pins the same category -> class construction at
 * runtime by building a real device for every category off the harness doubles and asserting it is the expected class reporting its own category.
 */
import type { Camera, Chime, DeviceCollectionKey, Fob, Light, Relay, Sensor, Viewer } from "unifi-protect";
import { TestCameraProjection, TestChimeProjection, TestFobProjection, TestLightProjection, TestRelayProjection, TestSensorProjection, TestStateStore,
  TestViewerProjection, makeCameraConfig, makeChimeConfig, makeFobConfig, makeLightConfig, makeProtectState, makeRelayConfig, makeSensorConfig, makeTestAccessory,
  makeTestNvr, makeViewerConfig, settle } from "../testing.helpers.ts";
import { describe, test } from "node:test";
import { DEVICE_COLLECTION_KEYS } from "unifi-protect";
import { G2_PRO_CHANNELS } from "../camera.fixtures.ts";
import type { ProtectAccessory } from "../types.ts";
import { ProtectCamera } from "../devices/cameras/camera.ts";
import { ProtectChime } from "../devices/chime.ts";
import type { ProtectDevice } from "../devices/device.ts";
import { ProtectFob } from "../devices/fob.ts";
import { ProtectLight } from "../devices/light.ts";
import type { ProtectNvr } from "./nvr.ts";
import { ProtectRelay } from "../devices/relay.ts";
import { ProtectSensor } from "../devices/sensor.ts";
import { ProtectViewer } from "../devices/viewer.ts";
import assert from "node:assert/strict";

// One category's construction against the harness doubles: seed a store with the category's config, build the real ProtectDevice off its Test projection, and hand back
// the constructed device plus the harness abort controller so the caller can unwind the observe loops the construction spawned. The construction-seam casts mirror every
// device-family suite; the instance itself is the production class running its real configure and spawnObservers paths.
interface Row {

  build: () => { controller: AbortController; device: ProtectDevice };
  category: DeviceCollectionKey;
  expected: abstract new (...args: never[]) => ProtectDevice;
}

const rows: Row[] = [
  {

    build: () => {

      const config = makeCameraConfig({ channels: G2_PRO_CHANNELS });
      const store = new TestStateStore(makeProtectState({ cameras: [config] }));
      const { controller, nvr } = makeTestNvr({ store });
      const accessory = makeTestAccessory("Descriptor Camera", "uuid:descriptor-camera");
      const projection = new TestCameraProjection(config.id, store);

      return { controller, device: new ProtectCamera(nvr as unknown as ProtectNvr, accessory as unknown as ProtectAccessory, projection as unknown as Camera) };
    },
    category: "camera",
    expected: ProtectCamera
  },
  {

    build: () => {

      const config = makeChimeConfig();
      const store = new TestStateStore(makeProtectState({ chimes: [config] }));
      const { controller, nvr } = makeTestNvr({ store });
      const accessory = makeTestAccessory("Descriptor Chime", "uuid:descriptor-chime");
      const projection = new TestChimeProjection(config.id, store);

      return { controller, device: new ProtectChime(nvr as unknown as ProtectNvr, accessory as unknown as ProtectAccessory, projection as unknown as Chime) };
    },
    category: "chime",
    expected: ProtectChime
  },
  {

    build: () => {

      const config = makeFobConfig();
      const store = new TestStateStore(makeProtectState({ fobs: [config] }));
      const { controller, nvr } = makeTestNvr({ store });
      const accessory = makeTestAccessory("Descriptor Fob", "uuid:descriptor-fob");
      const projection = new TestFobProjection(config.id, store);

      return { controller, device: new ProtectFob(nvr as unknown as ProtectNvr, accessory as unknown as ProtectAccessory, projection as unknown as Fob) };
    },
    category: "fob",
    expected: ProtectFob
  },
  {

    build: () => {

      const config = makeLightConfig();
      const store = new TestStateStore(makeProtectState({ lights: [config] }));
      const { controller, nvr } = makeTestNvr({ store });
      const accessory = makeTestAccessory("Descriptor Light", "uuid:descriptor-light");
      const projection = new TestLightProjection(config.id, store);

      return { controller, device: new ProtectLight(nvr as unknown as ProtectNvr, accessory as unknown as ProtectAccessory, projection as unknown as Light) };
    },
    category: "light",
    expected: ProtectLight
  },
  {

    build: () => {

      const config = makeRelayConfig();
      const store = new TestStateStore(makeProtectState({ relays: [config] }));
      const { controller, nvr } = makeTestNvr({ store });
      const accessory = makeTestAccessory("Descriptor Relay", "uuid:descriptor-relay");
      const projection = new TestRelayProjection(config.id, store);

      return { controller, device: new ProtectRelay(nvr as unknown as ProtectNvr, accessory as unknown as ProtectAccessory, projection as unknown as Relay) };
    },
    category: "relay",
    expected: ProtectRelay
  },
  {

    build: () => {

      const config = makeSensorConfig();
      const store = new TestStateStore(makeProtectState({ sensors: [config] }));
      const { controller, nvr } = makeTestNvr({ store });
      const accessory = makeTestAccessory("Descriptor Sensor", "uuid:descriptor-sensor");
      const projection = new TestSensorProjection(config.id, store);

      return { controller, device: new ProtectSensor(nvr as unknown as ProtectNvr, accessory as unknown as ProtectAccessory, projection as unknown as Sensor) };
    },
    category: "sensor",
    expected: ProtectSensor
  },
  {

    build: () => {

      const config = makeViewerConfig();
      const store = new TestStateStore(makeProtectState({ viewers: [config] }));
      const { controller, nvr } = makeTestNvr({ store });
      const accessory = makeTestAccessory("Descriptor Viewer", "uuid:descriptor-viewer");
      const projection = new TestViewerProjection(config.id, store);

      return { controller, device: new ProtectViewer(nvr as unknown as ProtectNvr, accessory as unknown as ProtectAccessory, projection as unknown as Viewer) };
    },
    category: "viewer",
    expected: ProtectViewer
  }
];

describe("device descriptor registry completeness", () => {

  test("every device-collection category builds its expected HomeKit class from the harness doubles", async () => {

    // Coverage cannot fall behind the library vocabulary: there is exactly one construction row per DeviceCollectionKey.
    assert.deepEqual(rows.map((row) => row.category).sort(), [...DEVICE_COLLECTION_KEYS].sort());

    const built = rows.map((row) => ({ category: row.category, expected: row.expected, ...row.build() }));

    for(const { category, device, expected } of built) {

      assert.ok(device instanceof expected, "the " + category + " category constructs its expected HomeKit class");
      assert.equal(device.modelKey, category, "the constructed " + category + " device reports its own category as modelKey");
    }

    // Unwind every observe loop the constructions spawned before the suite ends.
    for(const { controller } of built) {

      controller.abort();
    }

    await settle();
  });
});
