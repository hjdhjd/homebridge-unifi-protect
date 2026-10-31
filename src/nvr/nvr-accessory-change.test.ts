/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * nvr-accessory-change.test.ts: Each accessory's add to HomeKit and removal from it fails alone, at every place one is made, and a camera's asynchronous setup says
 * its own failure.
 *
 * The removal gate is driven directly, on its own test clock, as its own suite drives it. Every other row drives the real controller root through its connect port,
 * over the controller double's platform with a client double answering, because what each row asserts is what a throw costs the pass around it: login() resolving,
 * an observer loop still waking, and the stability sweep's timer returning normally when the test clock fires it. Each fault is one a running bridge can raise:
 * Homebridge refusing a registration, as a bridge already holding as many accessories as HomeKit allows refuses one, Homebridge refusing an unregistration, or a step
 * of a device's setup throwing. Every line said at error is read as the user reads it, so a sentence that drifts by a character reddens its row.
 */
import { Characteristic, Service, TestStateStore, accessoryUuid, makeProtectState, makeTestAccessory } from "../testing.helpers.ts";
import { G2_PRO_CHANNELS, G6_PRO_ENTRY_CHANNELS } from "../camera.fixtures.ts";
import type { PlatformAccessory, PlatformName, PluginIdentifier } from "homebridge";
import type { ProtectCameraConfig, ProtectClient, ProtectNvrConfig, ProtectNvrLiveviewConfig } from "unifi-protect";
import { ProtectReservedNames, packageCameraId } from "../types.ts";
import { TEST_CLOCK_EPOCH, makeConnectedClient, makeNvrConfig, makeRootPlatform, makeTestNvr, restoreAccessories } from "./testing.helpers.ts";
import { TestClock, assertNoUnhandledRejections, capturingLog, linesAt, settle, triggerGet } from "homebridge-plugin-utils/testing";
import type { TestHomebridgeApi, TestLogEntry } from "homebridge-plugin-utils/testing";
import { describe, test } from "node:test";
import { makeCameraConfig, makeLiveviewConfig } from "../devices/testing.helpers.ts";
import { PROTECT_NVR_REMOVAL_STABILITY_WINDOW } from "../settings.ts";
import type { ProtectAccessory } from "../types.ts";
import { ProtectCamera } from "../devices/cameras/camera.ts";
import { ProtectNvr } from "./nvr.ts";
import { RemovalStabilityGate } from "./nvr-removal.ts";
import type { StreamingCapability } from "../devices/cameras/streaming.ts";
import type { TestContext } from "node:test";
import type { TestProtectNvr } from "./testing.helpers.ts";
import assert from "node:assert/strict";

// The prefix on the controller root's own lines: the controller's name and its model.
const ROOT_PREFIX = "Test Controller [UniFi Dream Machine SE]";

// The prefix on the lines of the owners that manage the controller's own accessories, the system information and the liveviews: the controller's name alone.
const OWNER_PREFIX = "Test Controller";

// The controller's MAC, which every accessory those owners key is seeded from.
const NVR_MAC = makeNvrConfig().mac;

// A controller root ready to log in, with the handles a row reads and steers.
interface RootRig {

  api: TestHomebridgeApi;
  clock: TestClock;
  double: TestProtectNvr;
  logEntries: readonly TestLogEntry[];
  root: ProtectNvr;
  store: TestStateStore;
}

/* Build a controller root over the controller double's platform, whose store carries the cameras and liveviews a row names, and end its run when the row ends. The
 * controller has been up for a whole stability window, so the removal gate trusts it at login and its stability sweep comes due on the clock's next step, and its
 * record carries the hardware revision the security system writes onto its accessory.
 */
function makeRoot(t: TestContext, options: { cameras?: ProtectCameraConfig[]; liveviews?: ProtectNvrLiveviewConfig[]; userOptions?: string[] } = {}): RootRig {

  const clock = new TestClock(TEST_CLOCK_EPOCH);
  const nvrConfig: ProtectNvrConfig = { ...makeNvrConfig({ hardwareRevision: "1.0.0" }), firmwareVersion: "4.3.6",
    upSince: clock.now() - PROTECT_NVR_REMOVAL_STABILITY_WINDOW, version: "6.1.79" };
  const store = new TestStateStore(makeProtectState({ cameras: options.cameras ?? [], liveviews: options.liveviews ?? [], nvr: nvrConfig }));
  const { api, controller, logEntries, nvr: double } = makeTestNvr({ clock, store, userOptions: options.userOptions ?? [] });
  const client = makeConnectedClient({ nvrConfig, store });
  const { platform, shutdown } = makeRootPlatform(double);
  const root = new ProtectNvr(platform, double.config, async (): Promise<ProtectClient> => client);

  t.after(async () => {

    shutdown();
    controller.abort();

    await settle();
  });

  return { api, clock, double, logEntries, root, store };
}

// A camera record the root's membership reconcile adopts: its category and its adoption by this controller, over the setup read set makeCameraConfig builds.
function adoptedCamera(options: Parameters<typeof makeCameraConfig>[0]): ProtectCameraConfig {

  return { ...makeCameraConfig(options), isAdopted: true, isAdoptedByOther: false, modelKey: "camera" };
}

// Every line said at error, rendered as the user reads it.
function errors(rig: RootRig): string[] {

  return linesAt(rig.logEntries, "error");
}

// How many registrations Homebridge accepted that named the accessory a UUID identifies.
function registrations(api: TestHomebridgeApi, uuid: string): number {

  return api.calls.filter((call) => (call.kind === "register") && call.accessories.some((accessory) => accessory.UUID === uuid)).length;
}

// Have Homebridge refuse each registration naming the accessory a UUID identifies while the fault holds, as a bridge already holding as many accessories as HomeKit
// allows refuses a new one, and accept every other registration as it stands. The double refuses before Homebridge's own accessory cache takes the accessory, where a
// real full bridge refuses after it, so the rows built on it exercise the plugin's retry rather than a real full bridge.
function refuseRegistration(t: TestContext, options: { api: TestHomebridgeApi; fault?: { active: boolean }; uuid: string }): void {

  const { api, fault = { active: true }, uuid } = options;
  const register = api.registerPlatformAccessories.bind(api);

  t.mock.method(api, "registerPlatformAccessories", (pluginIdentifier: PluginIdentifier, platformName: PlatformName, accessories: PlatformAccessory[]): void => {

    if(fault.active && accessories.some((accessory) => accessory.UUID === uuid)) {

      throw new Error("Homebridge refused the registration");
    }

    register(pluginIdentifier, platformName, accessories);
  });
}

// Have Homebridge refuse every unregistration naming the accessory a UUID identifies, and accept every other unregistration as it stands.
function refuseUnregistration(t: TestContext, options: { api: TestHomebridgeApi; uuid: string }): void {

  const { api, uuid } = options;
  const unregister = api.unregisterPlatformAccessories.bind(api);

  t.mock.method(api, "unregisterPlatformAccessories", (pluginIdentifier: PluginIdentifier, platformName: PlatformName, accessories: PlatformAccessory[]): void => {

    if(accessories.some((accessory) => accessory.UUID === uuid)) {

      throw new Error("Homebridge refused the removal");
    }

    unregister(pluginIdentifier, platformName, accessories);
  });
}

/* A removal gate on its own test clock, trusting a controller up for a whole stability window, with the removal action recording each accessory it removes and the
 * gate's log capturing what it says.
 */
function makeGate(t: TestContext, graceSeconds: number): { clock: TestClock; errors: () => string[]; gate: RemovalStabilityGate; removed: ProtectAccessory[] } {

  const clock = new TestClock(TEST_CLOCK_EPOCH);
  const controller = new AbortController();
  const log = capturingLog();
  const removed: ProtectAccessory[] = [];
  const gate = new RemovalStabilityGate({ actions: { removeDevice: (accessory: ProtectAccessory): void => void removed.push(accessory), runSweep: (): void => undefined },
    clock, graceSeconds: (): number => graceSeconds, log, signal: controller.signal });

  t.after(() => controller.abort());
  gate.refresh({ good: true, upSince: clock.now() - PROTECT_NVR_REMOVAL_STABILITY_WINDOW });

  return { clock, errors: (): string[] => linesAt(log.entries, "error"), gate, removed };
}

describe("the removal gate", () => {

  test("a removal that throws as it runs at once is said once, and the removal scheduled behind it still runs", (t) => {

    const { errors: said, gate, removed } = makeGate(t, 0);
    const stuck = makeTestAccessory("Stuck Camera", "74ACB9000301");
    const departing = makeTestAccessory("Departing Camera", "74ACB9000302");

    assert.doesNotThrow(() => gate.schedule({ accessory: stuck, remove: (): never => {

      throw new Error("Homebridge refused the removal");
    }, stillGone: (): boolean => true }), "the removal's fault does not leave the gate");

    gate.schedule({ accessory: departing, stillGone: (): boolean => true });

    assert.deepEqual(removed, [departing], "the removal behind the fault runs");
    assert.deepEqual(said(), ["Unable to remove Stuck Camera from HomeKit: Homebridge refused the removal."], "and the fault is said once, naming the accessory");
  });

  test("a removal that throws when its grace ends is said once rather than escaping the timer, and the removal due beside it still runs", (t) => {

    const { clock, errors: said, gate, removed } = makeGate(t, 60);
    const stuck = makeTestAccessory("Stuck Camera", "74ACB9000311");
    const departing = makeTestAccessory("Departing Camera", "74ACB9000312");

    gate.schedule({ accessory: stuck, remove: (): never => {

      throw new Error("Homebridge refused the removal");
    }, stillGone: (): boolean => true });

    gate.schedule({ accessory: departing, stillGone: (): boolean => true });

    assert.deepEqual(removed, [], "each removal waits out its grace");
    assert.doesNotThrow(() => clock.advance(60 * 1000), "the removal's fault does not escape the timer its grace runs on");
    assert.deepEqual(removed, [departing], "the removal due beside the fault runs");
    assert.deepEqual(said(), ["Unable to remove Stuck Camera from HomeKit: Homebridge refused the removal."], "and the fault is said once, naming the accessory");
  });

  test("a re-check that throws when its grace ends is said once rather than escaping the timer, and the removal due beside it still runs", (t) => {

    const { clock, errors: said, gate, removed } = makeGate(t, 60);
    const stuck = makeTestAccessory("Stuck Camera", "74ACB9000321");
    const departing = makeTestAccessory("Departing Camera", "74ACB9000322");

    gate.schedule({ accessory: stuck, stillGone: (): never => {

      throw new Error("The controller record could not be read");
    } });

    gate.schedule({ accessory: departing, stillGone: (): boolean => true });

    assert.doesNotThrow(() => clock.advance(60 * 1000), "the re-check's fault does not escape the timer its grace runs on");
    assert.deepEqual(removed, [departing], "the removal due beside the fault runs, and the accessory whose re-check threw is not removed");
    assert.deepEqual(said(), ["Unable to remove Stuck Camera from HomeKit: The controller record could not be read."],
      "and the fault is said once, naming the accessory");
  });
});

describe("the controller root's adoption pass", () => {

  test("a camera whose setup throws costs the cameras beside it nothing, the camera list keeps observing, and a retry stands one live camera on its accessory",
    async (t) => {

      const faulty = adoptedCamera({ channels: G2_PRO_CHANNELS, id: "camera-faulty", mac: "74ACB9000401", name: "Faulty Camera" });
      const healthy = adoptedCamera({ channels: G2_PRO_CHANNELS, id: "camera-healthy", mac: "74ACB9000402", name: "Healthy Camera" });
      const second = adoptedCamera({ channels: G2_PRO_CHANNELS, id: "camera-second", mac: "74ACB9000403", name: "Second Camera" });
      const third = adoptedCamera({ channels: G2_PRO_CHANNELS, id: "camera-third", mac: "74ACB9000404", name: "Third Camera" });
      const rig = makeRoot(t, { cameras: [ faulty, healthy ], userOptions: ["Enable.Doorbell.Trigger"] });
      const failure = ROOT_PREFIX + ": Unable to add Faulty Camera [Test Camera Model] to HomeKit: The stale doorbell services could not be swept.";
      const fault = { active: true };
      const sweep = rig.root.removeStaleDoorbellServices.bind(rig.root);
      const streaming = t.mock.method(rig.root, "createStreamingCapability");

      // The faulty camera's setup throws at its last synchronous step, the stale doorbell service sweep a plain camera runs, after its asynchronous block has begun.
      t.mock.method(rig.root, "removeStaleDoorbellServices", (accessory: ProtectAccessory): void => {

        if(fault.active && (accessory.UUID === accessoryUuid(faulty.mac))) {

          throw new Error("The stale doorbell services could not be swept");
        }

        sweep(accessory);
      });

      // Whether the lifetime of each camera built on the faulty camera's accessory has ended, in the order they were built, read off the signal each camera handed
      // the streaming capability its asynchronous block acquired.
      const faultyLifetimes = (): boolean[] => streaming.mock.calls.filter((call) => call.arguments[0].accessory.UUID === accessoryUuid(faulty.mac))
        .map((call) => call.arguments[1].aborted);

      await assert.doesNotReject(rig.root.login(), "the startup population's fault does not leave login()");
      await settle();

      assert.ok(rig.root.getDeviceById(healthy.id) instanceof ProtectCamera, "the camera behind the fault is added");
      assert.equal(rig.root.getDeviceById(faulty.id), null, "and the camera whose setup threw is not");
      assert.deepEqual(errors(rig), [failure], "the fault is said once, through the controller's log, naming the camera");
      assert.deepEqual(faultyLifetimes(), [true], "and the camera whose setup threw was released, ending the lifetime its setup started");

      // A camera the controller adopts next wakes the camera list, whose pass retries the failed camera ahead of it while the fault still holds.
      rig.store.addCameraRecord(second);

      await settle();

      assert.ok(rig.root.getDeviceById(second.id) instanceof ProtectCamera, "the camera list's own pass adds the camera behind the fault");
      assert.deepEqual(errors(rig), [ failure, failure ], "and says the fault once more, for its own pass");

      // With the fault gone, the next change to the camera list retries the failed camera again, which only a camera list still observing can see.
      fault.active = false;
      rig.store.addCameraRecord(third);

      await settle();

      const retried = rig.root.getDeviceById(faulty.id);

      assert.ok(rig.root.getDeviceById(third.id) instanceof ProtectCamera, "the camera list is still observing");
      assert.ok(retried instanceof ProtectCamera, "and the failed camera is added on the retry");
      assert.equal(registrations(rig.api, accessoryUuid(faulty.mac)), 1, "on the accessory it registered the first time");
      assert.deepEqual(faultyLifetimes(), [ true, true, false ], "so one live camera stands on that accessory");

      // The doorbell trigger switch the live camera stood up, whose handler reads the ring state of the camera that bound it.
      const trigger = retried.accessory.getServiceById(Service.Switch, ProtectReservedNames.SWITCH_DOORBELL_TRIGGER)?.getCharacteristic(Characteristic.On);

      assert.ok(trigger, "the live camera stood its doorbell trigger switch up");

      retried.isRinging = true;

      assert.equal(await triggerGet(trigger), true, "whose handler answers from the live camera rather than a released one");
      assert.equal(errors(rig).length, 2, "and the retry that succeeded says nothing more");
    });
});

describe("the controller root's disabled-controller sweeps", () => {

  test("an accessory that cannot leave HomeKit costs the accessories behind it nothing in each sweep, and each sweep says it once", async (t) => {

    const rig = makeRoot(t, { userOptions: ["Disable.Device." + NVR_MAC] });
    const stuck = makeTestAccessory("Stuck Camera", "74ACB9000501");
    const departing = makeTestAccessory("Departing Camera", "74ACB9000502");
    const liveview = makeTestAccessory("Test Liveview", NVR_MAC + ".Liveview.TEST");
    const failure = ROOT_PREFIX + ": Unable to remove Stuck Camera from HomeKit: Homebridge refused the removal.";

    // Cached cameras, which the device sweep removes, and a cached liveview switch, which the device sweep leaves to its owner and the owner-managed sweep removes.
    stuck.context = { mac: "74ACB9000501", nvr: NVR_MAC };
    departing.context = { mac: "74ACB9000502", nvr: NVR_MAC };
    liveview.context = { liveview: "Test", nvr: NVR_MAC };
    restoreAccessories(rig.double, [ stuck, departing, liveview ]);
    refuseUnregistration(t, { api: rig.api, uuid: stuck.UUID });

    await assert.doesNotReject(rig.root.login(), "the removal's fault does not leave login()");

    assert.deepEqual(rig.double.platform.accessories, [stuck], "every accessory behind the one that cannot leave is removed, by whichever sweep removes it");
    assert.deepEqual(errors(rig), [ failure, failure ], "and each sweep says the fault once, through the controller's log, naming the accessory");
  });
});

describe("the system information sensors", () => {

  test("a system information add or removal that throws is said once, and login() goes on to adopt the controller's cameras", async (t) => {

    const camera = adoptedCamera({ channels: G2_PRO_CHANNELS, id: "camera-system", mac: "74ACB9000601", name: "Test Camera" });
    const uuid = accessoryUuid(NVR_MAC + ".NVRSystemInfo");

    // The add: the option is on, no system information accessory is cached, and Homebridge refuses the one the owner creates.
    const adding = makeRoot(t, { cameras: [camera], userOptions: ["Enable.Nvr.SystemInfo"] });

    refuseRegistration(t, { api: adding.api, uuid });

    await assert.doesNotReject(adding.root.login(), "the add's fault does not leave login()");

    assert.deepEqual(errors(adding), [OWNER_PREFIX + ": Unable to add the system information sensors to HomeKit: Homebridge refused the registration."],
      "the add's fault is said once, through the owner's log, naming the sensors by their role");
    assert.ok(adding.root.getDeviceById(camera.id) instanceof ProtectCamera, "and login() went on to adopt the camera");

    // The removal: the option is off, and Homebridge refuses to unregister the cached accessory the owner removes.
    const removing = makeRoot(t, { cameras: [camera], userOptions: ["Disable.Nvr.SystemInfo"] });
    const cached = makeTestAccessory("Test Controller", NVR_MAC + ".NVRSystemInfo");

    cached.context = { nvr: NVR_MAC, systemInfo: true };
    restoreAccessories(removing.double, [cached]);
    refuseUnregistration(t, { api: removing.api, uuid });

    await assert.doesNotReject(removing.root.login(), "the removal's fault does not leave login()");

    assert.deepEqual(errors(removing), [OWNER_PREFIX + ": Unable to remove the system information sensors from HomeKit: Homebridge refused the removal."],
      "the removal's fault is said once, through the owner's log, naming the sensors by their role");
    assert.ok(removing.root.getDeviceById(camera.id) instanceof ProtectCamera, "and login() went on to adopt the camera");
  });
});

describe("the liveviews owner's accessories", () => {

  test("a security system whose registration is refused is said once without leaving login() or the sweep's timer, and the next liveviews change adds it once",
    async (t) => {

      const away = makeLiveviewConfig({ id: "lv-away", name: "Protect-Away" });
      const home = makeLiveviewConfig({ id: "lv-home", name: "Protect-Home" });
      const rig = makeRoot(t, { liveviews: [away] });
      const failure = OWNER_PREFIX + ": Unable to add the security system to HomeKit: Homebridge refused the registration.";
      const fault = { active: true };
      const uuid = accessoryUuid(NVR_MAC + ".Security");

      refuseRegistration(t, { api: rig.api, fault, uuid });

      await assert.doesNotReject(rig.root.login(), "the startup liveviews reconcile's fault does not leave login()");

      assert.deepEqual(errors(rig), [failure], "the fault is said once, through the liveviews owner's log, naming the security system by its role");
      assert.doesNotThrow(() => rig.clock.advance(0), "the stability sweep's liveviews pass meets the same fault without it escaping the sweep's timer");
      assert.deepEqual(errors(rig), [ failure, failure ], "and says it once more, for its own pass");

      // With the fault gone, the next change to the liveviews retries the security system, which only a liveviews observer still observing can see.
      fault.active = false;
      rig.store.pushLiveviews([ away, home ]);

      await settle();

      const accessories = rig.double.platform.accessories.filter((accessory) => accessory.UUID === uuid);

      assert.equal(registrations(rig.api, uuid), 1, "the next liveviews change adds the security system, registering its accessory once");
      assert.equal(accessories.length, 1, "so one security system accessory stands on the platform");
      assert.ok(accessories[0]?.getService(Service.SecuritySystem), "carrying the security system the owner configured on it");
      assert.equal(errors(rig).length, 2, "and the retry that succeeded says nothing more");
    });

  test("a liveview switch whose registration is refused costs the switches behind it nothing, leaves neither login() nor the sweep's timer, and is added once " +
    "by the next liveviews change", async (t) => {

    const garage = makeLiveviewConfig({ id: "lv-garage", name: "Protect-Garage" });
    const porch = makeLiveviewConfig({ id: "lv-porch", name: "Protect-Porch" });
    const patio = makeLiveviewConfig({ id: "lv-patio", name: "Protect-Patio" });
    const rig = makeRoot(t, { liveviews: [ garage, porch ] });
    const failure = OWNER_PREFIX + ": Unable to add the Garage liveview switch to HomeKit: Homebridge refused the registration.";
    const fault = { active: true };
    const switchUuid = (view: string): string => accessoryUuid(NVR_MAC + ".Liveview." + view);

    refuseRegistration(t, { api: rig.api, fault, uuid: switchUuid("GARAGE") });

    await assert.doesNotReject(rig.root.login(), "the startup liveviews reconcile's fault does not leave login()");

    assert.equal(registrations(rig.api, switchUuid("PORCH")), 1, "the switch behind the fault is added");
    assert.deepEqual(errors(rig), [failure], "the fault is said once, through the liveviews owner's log, naming the switch by its view");
    assert.doesNotThrow(() => rig.clock.advance(0), "the stability sweep's liveviews pass meets the same fault without it escaping the sweep's timer");
    assert.deepEqual(errors(rig), [ failure, failure ], "and says it once more, for its own pass");

    // With the fault gone, the next change to the liveviews retries the switch, which only a liveviews observer still observing can see.
    fault.active = false;
    rig.store.pushLiveviews([ garage, porch, patio ]);

    await settle();

    assert.equal(registrations(rig.api, switchUuid("GARAGE")), 1, "the next liveviews change adds the failed switch, registering its accessory once");
    assert.equal(registrations(rig.api, switchUuid("PATIO")), 1, "beside the switch that change calls for");
    assert.equal(registrations(rig.api, switchUuid("PORCH")), 1, "and leaves the switch already standing as it was");
    assert.equal(errors(rig).length, 2, "and the retry that succeeded says nothing more");
  });
});

describe("the doorbell's accessories", () => {

  test("a package camera whose registration is refused costs its doorbell nothing, leaves neither login() nor the sweep's timer, and is added once by the next " +
    "change to the package camera flag", async (t) => {

    const config = adoptedCamera({ channels: G6_PRO_ENTRY_CHANNELS, featureFlags: { hasPackageCamera: true, isDoorbell: true }, id: "camera-doorbell",
      mac: "74ACB9000701", name: "Front Door" });
    const rig = makeRoot(t, { cameras: [config] });
    // The doorbell capability's own log carries its camera's name, without the model the camera's lines add.
    const failure = "Front Door: Unable to add the package camera to HomeKit: Homebridge refused the registration.";
    const fault = { active: true };
    const packages = t.mock.method(rig.root, "createPackageCamera");
    const uuid = accessoryUuid(packageCameraId(config.mac));

    refuseRegistration(t, { api: rig.api, fault, uuid });

    await assert.doesNotReject(rig.root.login(), "the package camera's fault does not leave login()");
    await settle();

    const camera = rig.root.getDeviceById(config.id);

    assert.ok(camera instanceof ProtectCamera, "the doorbell is added");
    assert.ok(camera.doorbell, "with its doorbell capability attached");
    assert.equal(camera.packageCamera, null, "and without the package camera whose add failed");
    assert.deepEqual(errors(rig), [failure], "the fault is said once, through the doorbell's log, naming the package camera by its role");
    assert.doesNotThrow(() => rig.clock.advance(0), "the stability sweep's package camera pass meets the same fault without it escaping the sweep's timer");
    assert.deepEqual(errors(rig), [ failure, failure ], "and says it once more, for its own pass");

    // With the fault gone, the controller withdraws the package camera and reports it again, and the package camera observer's reconcile retries the add.
    fault.active = false;
    rig.store.pushCameraFeatureFlags(config.id, { hasPackageCamera: false });

    await settle();

    rig.store.pushCameraFeatureFlags(config.id, { hasPackageCamera: true });

    await settle();

    assert.ok(camera.packageCamera, "the next change to the package camera flag adds the package camera");
    assert.equal(registrations(rig.api, uuid), 1, "registering its accessory once");
    assert.equal(packages.mock.callCount(), 1, "and building one package camera, since no refused attempt got as far as building one");
    assert.equal(errors(rig).length, 2, "and the retry that succeeded says nothing more");
  });

  test("a doorbell attach whose setup throws when the controller promotes a camera is said once, the doorbell status loop keeps observing, and its next " +
    "promotion attaches one doorbell", async (t) => {

    const config = adoptedCamera({ channels: G6_PRO_ENTRY_CHANNELS, featureFlags: { hasPackageCamera: true }, id: "camera-entry", mac: "74ACB9000801",
      name: "Front Door" });
    const rig = makeRoot(t, { cameras: [config] });
    const packages = t.mock.method(rig.root, "createPackageCamera");
    const uuid = accessoryUuid(packageCameraId(config.mac));

    // Whether the lifetime of each package camera a doorbell built has ended, in the order they were built.
    const packageLifetimes = (): (boolean | undefined)[] => packages.mock.calls.map((call) => (call.result ? !call.result.canConfigureStream : undefined));

    await rig.root.login();
    await settle();

    const camera = rig.root.getDeviceById(config.id);

    assert.ok(camera instanceof ProtectCamera, "the camera is added");
    assert.equal(camera.doorbell, null, "with no doorbell, since the controller does not report it as one");

    // The doorbell's setup throws once, at the step after it stands its package camera up, so the failed doorbell has started something its release must end.
    t.mock.method(camera, "configureDoorbellService", (): never => {

      throw new Error("The Doorbell service could not be stood up");
    }, { times: 1 });

    rig.store.pushCameraFeatureFlags(config.id, { isDoorbell: true });

    await settle();

    assert.equal(camera.doorbell, null, "the failed attach leaves no doorbell");
    assert.deepEqual(errors(rig), ["Front Door [Test Camera Model]: Unable to add the doorbell to HomeKit: The Doorbell service could not be stood up."],
      "the fault is said once, through the camera's log, and the doorbell status loop does not end on it");
    assert.deepEqual(packageLifetimes(), [true], "the failed doorbell's package camera was released with it");

    // The controller withdraws the doorbell report and makes it again, and the doorbell status observer's reconcile retries the attach.
    rig.store.pushCameraFeatureFlags(config.id, { isDoorbell: false });

    await settle();

    rig.store.pushCameraFeatureFlags(config.id, { isDoorbell: true });

    await settle();

    assert.ok(camera.doorbell, "the next promotion attaches the doorbell, which only a doorbell status loop still observing can see");
    assert.equal(registrations(rig.api, uuid), 1, "its package camera stands on the accessory the failed attempt registered");
    assert.deepEqual(packageLifetimes(), [ true, false ], "so one live package camera stands on that accessory");
    assert.equal(camera.packageCamera, packages.mock.calls[1]?.result, "and it is the one the doorbell holds");
    assert.equal(errors(rig).length, 1, "and the retry that succeeded says nothing more");
  });
});

describe("a camera's asynchronous setup", () => {

  test("a step of a camera's asynchronous setup that throws is said once through the camera's log, leaving the camera added as far as its setup got", async (t) => {

    const config = adoptedCamera({ channels: G2_PRO_CHANNELS, id: "camera-async", mac: "74ACB9000901", name: "Test Camera" });
    const rig = makeRoot(t, { cameras: [config], userOptions: ["Enable.Doorbell.Trigger"] });
    const create = rig.root.createStreamingCapability.bind(rig.root);

    // The camera's streaming reconcile rejects the first time it runs, which is the step of the asynchronous block the camera details wait on.
    t.mock.method(rig.root, "createStreamingCapability", (camera: ProtectCamera, signal: AbortSignal): StreamingCapability => {

      const capability = create(camera, signal);

      t.mock.method(capability, "reconcile", async (): Promise<void> => {

        throw new Error("The stream could not be derived");
      }, { times: 1 });

      return capability;
    });

    await assertNoUnhandledRejections(async (): Promise<void> => {

      await rig.root.login();
      await settle();
    });

    const camera = rig.root.getDeviceById(config.id);

    assert.ok(camera instanceof ProtectCamera, "the camera stays added");
    assert.deepEqual(errors(rig), ["Test Camera [Test Camera Model]: Unable to finish adding this camera to HomeKit: The stream could not be derived."],
      "the fault is said once, through the camera's log");
    assert.ok(camera.accessory.getServiceById(Service.Switch, ProtectReservedNames.SWITCH_DOORBELL_TRIGGER),
      "and the switches the block stands up beside the failed step are in place");
  });
});
