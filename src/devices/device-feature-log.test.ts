/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * device-feature-log.test.ts: Where each plain on or off feature option's line goes, read over the REAL option engine and the REAL owner classes.
 *
 * A feature option's line is stated once, where the option was set: on the plugin's log for a global entry, on the controller's for a controller entry, and on the
 * device's for a device entry, so a setting that covers many devices is said once up front rather than by each of them. Every logger writes to the one recorder the
 * controller double holds, so the prefix each writes is what tells the levels apart: the plugin's carries none, makeTestNvr's controllerPrefix gives the controller's
 * one, and a device's logger writes its own descriptor.
 */
import { Service, TestStateStore, makeProtectState, makeTestAccessory } from "../testing.helpers.ts";
import { TestCameraProjection, makeCameraConfig } from "./testing.helpers.ts";
import { afterEach, describe, test } from "node:test";
import { formatLogEntry, settle } from "homebridge-plugin-utils/testing";
import { makeNvrConfig, makeTestNvr } from "../nvr/testing.helpers.ts";
import type { Camera } from "unifi-protect";
import { G2_PRO_CHANNELS } from "../camera.fixtures.ts";
import { ProtectCamera } from "./cameras/camera.ts";
import type { ProtectNvr } from "../nvr/nvr.ts";
import { ProtectNvrSystemInfo } from "../nvr/nvr-systeminfo.ts";
import { ProtectReservedNames } from "../types.ts";
import { ProtectSecuritySystem } from "../liveviews/security-system.ts";
import type { TestCameraFeatureFlags } from "./testing.helpers.ts";
import type { TestProtectNvr } from "../nvr/testing.helpers.ts";
import assert from "node:assert/strict";
import { configured } from "./device-base.ts";

// The identifiers and the prefixes each level's entries and lines carry.
const CAMERA_MAC = "74ACB9000501";
const SECOND_CAMERA_MAC = "74ACB9000502";
const CONTROLLER_MAC = "74ACB9FFFFFF";
const CAMERA_PREFIX = "Test Camera [Test Camera Model]: ";
const CONTROLLER_NAME = "Test Controller";
const CONTROLLER_PREFIX = CONTROLLER_NAME + ": ";

// One option's line: the option, what a device's line calls it, what the controller's and the plugin's lines call it where that differs, the catalog default, the
// hardware the row's camera needs for the option to apply, and the camera that lacks it where the option needs hardware.
interface DeviceFeature {

  defaultOn?: boolean;
  featureFlags?: Partial<TestCameraFeatureFlags>;
  kindLabel?: string;
  label: string;
  option: string;
  withoutHardware?: Partial<TestCameraFeatureFlags>;
}

const DOORBELL = { isDoorbell: true };
const NO_MOTION = { hasMotionDetection: false };
const MOTION_SWITCH = { kindLabel: "Motion sensor switches", label: "Motion sensor switch", option: "Motion.Switch", withoutHardware: NO_MOTION };

const DEVICE_FEATURES: DeviceFeature[] = [

  MOTION_SWITCH,
  { kindLabel: "Motion sensor automation triggers", label: "Motion sensor automation trigger", option: "Motion.Trigger", withoutHardware: NO_MOTION },
  { featureFlags: { hasLedStatus: true }, kindLabel: "Status indicator light switches", label: "Status indicator light switch", option: "Device.StatusLed.Switch",
    withoutHardware: {} },
  { featureFlags: DOORBELL, kindLabel: "Doorbell mute switches", label: "Doorbell mute switch", option: "Doorbell.Mute", withoutHardware: {} },
  { kindLabel: "Doorbell automation triggers", label: "Doorbell automation trigger", option: "Doorbell.Trigger" },
  { featureFlags: DOORBELL, kindLabel: "Protect chime volume controls", label: "Protect chime volume control", option: "Doorbell.Volume.Dimmer" },
  { featureFlags: { ...DOORBELL, hasFingerprintSensor: true }, kindLabel: "Protect authentication contact sensors", label: "Protect authentication contact sensor",
    option: "Doorbell.AuthSensor", withoutHardware: DOORBELL },
  { featureFlags: { hasIcrSensitivity: true, hasInfrared: true }, kindLabel: "Night vision dimmers", label: "Night vision dimmer", option: "Device.NightVision.Dimmer",
    withoutHardware: {} },
  { kindLabel: "HKSV recording switches", label: "HKSV recording switch", option: "Video.HKSV.Recording.Switch", withoutHardware: NO_MOTION },
  { label: "UniFi Protect recording switches", option: "Nvr.Recording.Switch" },
  { defaultOn: true, label: "Higher quality snapshots", option: "Video.HighResSnapshots" }
];

// The same, for an option a controller reads with no device beneath it, each standing up its owner on the double.
interface ControllerFeature {

  label: string;
  option: string;
  stand: (nvr: TestProtectNvr) => Promise<void> | void;
}

const CONTROLLER_FEATURES: ControllerFeature[] = [

  { label: "Security system alarm switch", option: "SecuritySystem.Alarm",
    stand: (nvr): void => void configured(new ProtectSecuritySystem(nvr as unknown as ProtectNvr, makeTestAccessory("Test Security", "74ACB9000600"))) },
  { label: "Protect controller telemetry", option: "Nvr.Publish.Telemetry",
    stand: async (nvr): Promise<void> => {

      // The publisher reads the raw packets once its line is said, and a finite stream ends it there.
      (nvr.client as unknown as { rawPackets: () => AsyncGenerator }).rawPackets = async function *(): AsyncGenerator {

        // The double delivers no packets.
      };

      await (nvr as unknown as ProtectNvr).events.publishTelemetry(nvr.signal);
    } },
  { label: "System information sensors", option: "NVR.SystemInfo",
    stand: (nvr): void => void configured(new ProtectNvrSystemInfo(nvr as unknown as ProtectNvr)) }
];

// Every harness controller this suite opens, drained after each test.
const controllers: AbortController[] = [];

// The info lines in a recorder naming one of the labels.
function linesNaming(logEntries: ReturnType<typeof makeTestNvr>["logEntries"], labels: string[]): string[] {

  return logEntries.filter(({ level }) => level === "info").map(formatLogEntry).filter((line) => labels.some((label) => line.includes(label)));
}

// Stand cameras on one controller double and read back the lines naming a feature, in the order they were logged.
async function cameraLines(feature: Pick<DeviceFeature, "featureFlags" | "kindLabel" | "label">, userOptions: string[], macs: string[] = [CAMERA_MAC]):
Promise<string[]> {

  const configs = macs.map((mac, index) => makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: feature.featureFlags ?? {}, id: "camera-" + index.toString(), mac,
    name: "Test Camera" }));
  const store = new TestStateStore(makeProtectState({ cameras: configs }));
  const { controller, logEntries, nvr } = makeTestNvr({ controllerPrefix: CONTROLLER_NAME, store, userOptions });

  controllers.push(controller);

  for(const config of configs) {

    configured(new ProtectCamera(nvr as unknown as ProtectNvr, makeTestAccessory("Test Camera", config.mac),
      new TestCameraProjection(config.id, store) as unknown as Camera));
  }

  await settle();

  return linesNaming(logEntries, [ feature.label, feature.kindLabel ?? feature.label ]);
}

describe("a plain feature option's line", () => {

  afterEach(() => {

    for(const controller of controllers.splice(0)) {

      controller.abort();
    }
  });

  for(const feature of DEVICE_FEATURES) {

    const kind = feature.kindLabel ?? feature.label;
    const [ on, off, set, clear ] = feature.defaultOn ? [ "Disable.", "Enable.", "disabled.", "enabled." ] : [ "Enable.", "Disable.", "enabled.", "disabled." ];

    test(feature.option + " is stated once at the level that set it", async () => {

      assert.deepEqual(await cameraLines(feature, []), [], "the defaults say nothing");
      assert.deepEqual(await cameraLines(feature, [on + feature.option]), [kind + " " + set], "a global entry is the plugin's line");
      assert.deepEqual(await cameraLines(feature, [on + feature.option + "." + CONTROLLER_MAC]), [CONTROLLER_PREFIX + kind + " " + set],
        "a controller entry is the controller's");
      assert.deepEqual(await cameraLines(feature, [on + feature.option + "." + CAMERA_MAC]), [CAMERA_PREFIX + feature.label + " " + set],
        "a device entry is the device's");
      assert.deepEqual(await cameraLines(feature, [ on + feature.option, off + feature.option + "." + CAMERA_MAC ]), [CAMERA_PREFIX + feature.label + " " + clear],
        "a device beneath a global setting states its own, and nothing else speaks for it");
    });

    // A feature that needs hardware says nothing on a camera without it, whichever level set it, because no line it could write would be true of this camera.
    if(feature.withoutHardware) {

      const featureFlags = feature.withoutHardware;

      test(feature.option + " says nothing on a camera without the hardware", async () => {

        for(const entry of [ "Enable." + feature.option, "Enable." + feature.option + "." + CONTROLLER_MAC, "Enable." + feature.option + "." + CAMERA_MAC ]) {

          // eslint-disable-next-line no-await-in-loop -- Each level is its own assertion.
          assert.deepEqual(await cameraLines({ ...feature, featureFlags }, [entry]), [], entry + " leaves the camera silent");
        }
      });
    }
  }

  test("a global setting is said once across every device", async () => {

    assert.deepEqual(await cameraLines(MOTION_SWITCH, ["Enable.Motion.Switch"], [ CAMERA_MAC, SECOND_CAMERA_MAC ]), ["Motion sensor switches enabled."]);
  });

  test("a controller setting is said once across every device", async () => {

    assert.deepEqual(await cameraLines(MOTION_SWITCH, ["Enable.Motion.Switch." + CONTROLLER_MAC], [ CAMERA_MAC, SECOND_CAMERA_MAC ]),
      [CONTROLLER_PREFIX + "Motion sensor switches enabled."]);
  });

  // The catalog scopes the option to a camera with a status light, so a camera with none stands no switch with the option on, and one the cache restored comes off.
  test("a camera with no status light stands no status light switch, and a restored one comes off", async () => {

    const standSwitch = async (featureFlags: Partial<TestCameraFeatureFlags>, options: { restored?: boolean } = {}): Promise<boolean> => {

      const config = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags, id: "camera-0", mac: CAMERA_MAC, name: "Test Camera" });
      const store = new TestStateStore(makeProtectState({ cameras: [config] }));
      const { controller, nvr } = makeTestNvr({ store, userOptions: ["Enable.Device.StatusLed.Switch"] });
      const accessory = makeTestAccessory("Test Camera", CAMERA_MAC);

      controllers.push(controller);

      if(options.restored) {

        accessory.addService(Service.Switch, "Test Camera Status Indicator", ProtectReservedNames.SWITCH_STATUS_LED);
      }

      configured(new ProtectCamera(nvr as unknown as ProtectNvr, accessory, new TestCameraProjection(config.id, store) as unknown as Camera));

      await settle();

      return !!accessory.getServiceById(Service.Switch, ProtectReservedNames.SWITCH_STATUS_LED);
    };

    assert.equal(await standSwitch({ hasLedStatus: true }), true, "a camera with a status light stands the switch");
    assert.equal(await standSwitch({}), false, "a camera with none does not");
    assert.equal(await standSwitch({}, { restored: true }), false, "and one the cache restored comes off");
    assert.equal(await standSwitch({ hasLedStatus: true }, { restored: true }), true, "where a camera with a status light keeps it");
  });

  // The package camera's device line reads its parent doorbell's MAC, the entry hasFeature reads, where the id it answers to carries a suffix no entry addresses.
  test("a package camera states the parent doorbell's device entry, and a capable parent has said it first", async () => {

    const flags = { hasMic: true, hasPackageCamera: true, isDoorbell: true };
    const lines = async (featureFlags: Partial<TestCameraFeatureFlags>): Promise<string[]> => cameraLines({ ...MOTION_SWITCH, featureFlags },
      ["Enable.Motion.Switch." + CAMERA_MAC]);

    assert.deepEqual(await lines(flags), [CAMERA_PREFIX + "Motion sensor switch enabled."], "one line, the parent's, since the package camera reads the same entry");

    const packageLines = await lines({ ...flags, hasMotionDetection: false });

    assert.equal(packageLines.length, 1, "one line");
    assert.match(packageLines.join(), /Package Camera .*: Motion sensor switch enabled\.$/u, "the package camera's own, since its parent stands no motion sensor");
  });

  for(const feature of CONTROLLER_FEATURES) {

    test(feature.option + " is stated once at the level that set it", async () => {

      const lines = async (userOptions: string[]): Promise<string[]> => {

        const store = new TestStateStore(makeProtectState({ nvr: makeNvrConfig({ hardwareRevision: "1.0" }) }));
        const { controller, logEntries, nvr } = makeTestNvr({ controllerPrefix: CONTROLLER_NAME, store, userOptions });

        controllers.push(controller);

        await feature.stand(nvr);
        await settle();

        return linesNaming(logEntries, [feature.label]);
      };

      assert.deepEqual(await lines([]), [], "the defaults say nothing");
      assert.deepEqual(await lines(["Enable." + feature.option]), [feature.label + " enabled."], "a global entry is the plugin's line");
      assert.deepEqual(await lines(["Enable." + feature.option + "." + CONTROLLER_MAC]), [CONTROLLER_PREFIX + feature.label + " enabled."],
        "a controller entry is the controller's");
      assert.deepEqual(await lines([ "Enable." + feature.option, "Disable." + feature.option + "." + CONTROLLER_MAC ]),
        [CONTROLLER_PREFIX + feature.label + " disabled."], "a controller beneath a global setting states its own");
    });
  }
});
