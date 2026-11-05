/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * liveviews.test.ts: The liveviews half of the coupled controller-owner pair - WIRING/composition tests over a REAL constructed ProtectLiveviews.
 *
 * ProtectLiveviews is the self-creating owner of the coupled controller-owner pair: it value-constructs the ProtectSecuritySystem sibling, owns its accessory's
 * lifecycle, creates and orphan-removes the per-liveview switches, and fans member-camera motion through getDeviceById. This suite is the WIRING layer of the split: it
 * constructs a REAL ProtectLiveviews(nvr) and asserts the COMPOSITION - that the security accessory is created/destroyed on the Protect-liveview gate and updateDevice is
 * driven, that the switches reconcile (create / orphan-removal), that the motion fanout fires, and that the MQTT get/set wiring works. It deliberately does NOT re-net
 * ProtectSecuritySystem's internals (the state machine, the alarm, the MQTT state map, the setProps validValues logic) - those live in security-system.test.ts. The only
 * cross-sibling assertion here is the lightest wiring proof that updateDevice RAN: the sibling's TargetState setProps landed non-empty (its sole updateDevice effect).
 *
 * The shape DIFFERS from the device families and this suite respects every departure (the controller-owner shape established by nvr-systeminfo.test.ts):
 *
 * - It extends ProtectBase, not ProtectDevice: the ctor is (nvr) only. It self-creates the security accessory and the switch accessories via api.platformAccessory +
 *   registerPlatformAccessories (recorded among the API double's calls and in platform.accessories). Teardown is aborting the AbortController behind nvr.signal.
 * - It has ONE observer (nvr.liveviews) and publishes NOTHING on the hbup:observer:wake diagnostics channel, so this suite nets that observer by its REACTION (a
 *   pushLiveviews reconciles a new switch) and the store.observerCount, never a wake count.
 * - nvr.ufp / nvr.client.liveviews read THROUGH the store (the harness's read-through getters), so the seeded liveviews and a later pushLiveviews are what the owner
 *   reconciles against.
 *
 * The motion fanout is netted NON-VACUOUSLY: a member camera is seeded into configuredDevices whose ufp.id matches a Protect-Scene liveview's slots[].cameras. Its
 * accessory carries the SWITCH_MOTION_SENSOR-subtyped Switch the liveviews fanout targets (the same subtype the security fanout reads) PLUS a plain, unsubtyped decoy
 * Switch sitting first on the accessory: a scene toggle must land on the subtyped switch and leave the decoy untouched, which is what makes the subtyped-lookup fix
 * discriminating. The member's detectMotion starts FALSY and the scene switch is pre-seeded liveviewState false so the construction-time setSwitchState early-returns
 * (getSwitchState === target), making the later toggle a genuine false->true change - setSwitchState in liveviews.ts continue()s a member already at its target, so it
 * would no-op.
 */
import { ACCESSORY_SAVE_WINDOW_MS, HAPStatus } from "homebridge-plugin-utils";
import { Characteristic, Service, TestStateStore, accessoryUuid, makeProtectState, makeTestAccessory } from "../testing.helpers.ts";
import type { ProtectAccessory, ProtectDevices } from "../types.ts";
import type { TestLogEntry, TestMqttClient } from "homebridge-plugin-utils/testing";
import { afterEach, describe, test } from "node:test";
import { hapStatus, logCount, loggedAt, settle, triggerGet, triggerSet } from "homebridge-plugin-utils/testing";
import { makeNvrConfig, makeTestNvr, restoreAccessories } from "../nvr/testing.helpers.ts";
import { PROTECT_DEVICE_REMOVAL_DELAY_INTERVAL } from "../settings.ts";
import { ProtectLiveviews } from "./liveviews.ts";
import type { ProtectNvr } from "../nvr/nvr.ts";
import type { ProtectNvrLiveviewConfig } from "unifi-protect";
import { ProtectReservedNames } from "../types.ts";
import type { TestProtectAccessory } from "../testing.helpers.ts";
import type { TestProtectNvr } from "../nvr/testing.helpers.ts";
import assert from "node:assert/strict";
import { configured } from "../devices/device-base.ts";
import { makeLiveviewConfig } from "../devices/testing.helpers.ts";

// The controller MAC the makeNvrConfig record carries; the MQTT topic scope and the self-created accessory UUIDs derive from it. A literal so a drift in the fixture
// MAC breaks loudly.
const CONTROLLER_MAC = "74ACB9FFFFFF";

// The identities the owner composes, each seeding its accessory's UUID through HAP's generator: mac + ".Security" for the security accessory and
// mac + ".Liveview." + NAME for a switch. A literal / composer rather than free-form derivations so a drift in the identity composition breaks loudly, and a cached
// accessory a row builds is seeded by the same identity so the owner finds it by its UUID as it finds a restored one.
const SECURITY_SEED = CONTROLLER_MAC + ".Security";
const SECURITY_UUID = accessoryUuid(SECURITY_SEED);

// The removal delay a liveview-derived accessory waits out once the removal gate schedules it: the user's DelayDeviceRemoval interval at its default, in milliseconds
// on the controller double's test clock.
const REMOVAL_GRACE_MS = PROTECT_DEVICE_REMOVAL_DELAY_INTERVAL * 1000;

// The deterministic liveview-switch identity for a given view name (the owner uppercases the name into the seed), and the UUID HAP derives from it. Reused across the
// switch-create / orphan / reserved tests so the assertions read the same composition the owner does.
function liveviewSeed(name: string): string {

  return CONTROLLER_MAC + ".Liveview." + name.toUpperCase();
}

function liveviewUuid(name: string): string {

  return accessoryUuid(liveviewSeed(name));
}

// Seed a member-camera double into the NVR's configuredDevices registry so the liveviews motion fanout resolves it via getDeviceById. The fanout targets the member's
// SWITCH_MOTION_SENSOR-subtyped Switch and its accessory.context.detectMotion (and accessoryName for the log). The accessory carries that subtyped switch PLUS a plain,
// unsubtyped decoy Switch sitting FIRST: a scene toggle must land on the subtyped switch alone, so the decoy's untouched state is what proves the subtyped lookup, not a
// plain one. detectMotion starts FALSY by default. The accessory is seeded by the member's MAC, as production seeds a camera's. Returns the member accessory, its plain
// decoy switch, and its subtyped motion switch for assertion.
function seedMember(nvr: TestProtectNvr, options: { detectMotion?: boolean; id: string; mac: string; name: string }):
{ accessory: TestProtectAccessory; decoySwitch: Service; motionSwitch: Service } {

  const accessory = makeTestAccessory(options.name, options.mac);

  accessory.context.detectMotion = options.detectMotion ?? false;

  // The plain, unsubtyped decoy Switch added FIRST - the service getService(Service.Switch) resolves to. A scene toggle must NEVER touch it; the subtyped lookup is what
  // keeps it untouched.
  const decoySwitch = accessory.addService(new Service.Switch(options.name + " Decoy"));

  decoySwitch.updateCharacteristic(Characteristic.On, false);

  // The SWITCH_MOTION_SENSOR-subtyped Switch the liveviews fanout targets, seeded from the member's detectMotion.
  const motionSwitch = accessory.addService(new Service.Switch(options.name + " Motion", ProtectReservedNames.SWITCH_MOTION_SENSOR));

  motionSwitch.updateCharacteristic(Characteristic.On, accessory.context.detectMotion);

  // The managed-device double the fanout resolves through getDeviceById, which now matches on the non-throwing protectId: it reads accessory / accessoryName / context.
  // Cast through ProtectDevices at the construction boundary.
  const member = { accessory, accessoryName: options.name, protectId: options.id, ufp: { id: options.id } } as unknown as ProtectDevices;

  nvr.configuredDevices.set(accessory.UUID, member);

  return { accessory, decoySwitch, motionSwitch };
}

// The reusable construction helper: build a REAL ProtectLiveviews against the harness doubles and drive the initial reconcile by calling configureLiveviews() on the
// CONSTRUCTED instance (NOT nvr.liveviews - the double has no liveviews member). makeProtectState seeds the liveviews with DISTINCT ids per the makeLiveviewConfig
// distinct-id discipline; the casts are confined to the construction boundary exactly as the family suites do. Optional cachedAccessories are restored onto the bridge
// and into the platform array BEFORE construction (orphan-removal / pre-seeded-switch-state fixtures), as Homebridge restores a cached accessory, and an unstable
// controller leaves good state before the initial reconcile, the posture of a controller that has only just come up. The controller record carries the MAC and name
// a row gives it, so a row can stand the owner up under any controller name, one that sanitizes to nothing included. The returned controller is aborted in teardown:
// the fixture tears down through the controller it built, the scope that owns every registration the test created.
function buildLiveviews(harnessOptions: { cachedAccessories?: TestProtectAccessory[]; disconnected?: boolean; liveviews?: ProtectNvrLiveviewConfig[]; mac?: string;
  name?: string; sharedPlatform?: { accessories: ProtectAccessory[]; api: ReturnType<typeof makeTestNvr>["api"] }; unstable?: boolean; userOptions?: string[]; } = {}): {
  api: ReturnType<typeof makeTestNvr>["api"]; controller: AbortController; logEntries: readonly TestLogEntry[]; mqtt: TestMqttClient; nvr: TestProtectNvr;
  owner: ProtectLiveviews; store: TestStateStore;
} {

  const store = new TestStateStore(makeProtectState({ liveviews: harnessOptions.liveviews ?? [], nvr: makeNvrConfig({ hardwareRevision: "1.0.0",
    mac: harnessOptions.mac, name: harnessOptions.name }) }));
  const { api, controller, logEntries, mqtt, nvr } = makeTestNvr({ mqtt: true, sharedPlatform: harnessOptions.sharedPlatform, store,
    userOptions: harnessOptions.userOptions });

  // makeTestNvr was called with mqtt: true, so the recording double is present; a guard narrows Nullable<TestMqttClient> to the non-null type without an assertion or a
  // same-type cast (either of which the house lint preset forbids in opposite directions), and fails loudly if the opt-in ever stops installing the double.
  if(!mqtt) {

    throw new Error("The MQTT recording double was not installed despite mqtt: true.");
  }

  restoreAccessories(nvr, harnessOptions.cachedAccessories ?? []);

  // A disconnected double is the production startup shape: the liveviews owner is built before the broker acknowledges the first session.
  mqtt.connected = !(harnessOptions.disconnected ?? false);

  if(harnessOptions.unstable) {

    nvr.pushControllerStability(false);
  }

  const owner = configured(new ProtectLiveviews(nvr as unknown as ProtectNvr));

  // Drive the initial reconcile explicitly on the constructed instance (the NVR seeds this once at startup in production; the observer handles every later edit).
  owner.configureLiveviews();

  return { api, controller, logEntries, mqtt, nvr, owner, store };
}

describe("real ProtectLiveviews construction and controller-owner wiring", () => {

  // The per-test controller, tracked so afterEach aborts whichever build the test made (aborting the controller behind nvr.signal is the fixture's teardown, the scope
  // that owns every registration the test created). A multi-controller test pushes its additional controllers onto extraControllers so afterEach unwinds every owner it
  // built.
  let activeController: AbortController | undefined;
  const extraControllers: AbortController[] = [];

  afterEach(() => {

    activeController?.abort();
    activeController = undefined;

    for(const controller of extraControllers) {

      controller.abort();
    }

    extraControllers.length = 0;
  });

  test("a Protect-Away liveview self-creates the security accessory, constructs the sibling, drives updateDevice, and logs the enable", async () => {

    const built = buildLiveviews({ liveviews: [makeLiveviewConfig({ id: "lv-away", name: "Protect-Away" })] });

    activeController = built.controller;

    await settle();

    // The security accessory was self-created at the deterministic UUID and registered - both the platform array and the register recorder must show it.
    const security = built.nvr.platform.accessories.find((accessory) => accessory.UUID === SECURITY_UUID);

    assert.ok(security, "the owner self-created the security accessory at the mac-derived .Security UUID and pushed it onto the platform accessories array");
    assert.ok(built.api.calls.some((call) => (call.kind === "register") && call.accessories.includes(security)), "the platform double recorded a register call for it");
    assert.ok(loggedAt(built.logEntries, "info", "Enabling the security system accessory."), "the security-enable info line logged");

    // The sibling was constructed (its configureDevice ran), proven by the SecuritySystem service materializing on the security accessory.
    assert.ok(security.getService(Service.SecuritySystem), "the ProtectSecuritySystem sibling was constructed - its SecuritySystem service exists");

    // The wiring proof that updateDevice RAN: the sibling's TargetState setProps landed non-empty (its sole updateDevice effect). We assert only that it landed, NOT the
    // full validValues logic (security-system.test.ts owns that), keeping the two-layer boundary.
    const validValues = security.getService(Service.SecuritySystem)?.getCharacteristic(Characteristic.SecuritySystemTargetState).props.validValues;

    assert.ok(validValues && (validValues.length >= 2), "updateDevice ran on the sibling - the TargetState validValues narrowed to the available arm states");
  });

  test("removing the last Protect liveview logs the disable and unregisters the security accessory once the removal delay has passed", async () => {

    const built = buildLiveviews({ liveviews: [makeLiveviewConfig({ id: "lv-away", name: "Protect-Away" })] });

    activeController = built.controller;

    await settle();

    assert.ok(built.nvr.platform.accessories.some((accessory) => accessory.UUID === SECURITY_UUID), "the security accessory exists after the initial reconcile");

    // Replace the liveviews with one that is NOT a Protect arm/off liveview, then reconcile via a pushLiveviews (the observer-driven path).
    built.store.pushLiveviews([makeLiveviewConfig({ id: "lv-scene", name: "Protect-Scene" })]);

    await settle();

    // The removal gate scheduled the removal: the accessory stays through the removal delay and leaves when it ends.
    assert.ok(built.nvr.platform.accessories.some((accessory) => accessory.UUID === SECURITY_UUID), "the security accessory stays through the removal delay");

    built.nvr.platform.clock.advance(REMOVAL_GRACE_MS);

    assert.equal(built.nvr.platform.accessories.some((accessory) => accessory.UUID === SECURITY_UUID), false,
      "the security accessory was spliced out when no Protect arm/off liveview remained");
    assert.ok(built.api.calls.some((call) => (call.kind === "unregister") && call.accessories.some((candidate) => candidate.UUID === SECURITY_UUID)),
      "the platform double recorded an unregister call for the security accessory");
    assert.ok(loggedAt(built.logEntries, "info", "Disabling the security system accessory"), "the security-disable info line logged");
  });

  test("removing the security system via the owner's removal branch aborts its MQTT registrations, and a re-add yields exactly one live pair", async () => {

    const built = buildLiveviews({ liveviews: [makeLiveviewConfig({ id: "lv-away", name: "Protect-Away" })] });

    activeController = built.controller;

    await settle();

    // The owner constructed the security system, which registered its securitysystem get/set MQTT handlers on its owner-lifetime signal. Capture both live.
    const getSubscription = built.mqtt.subscriptions.find((entry) => (entry.kind === "get") && (entry.topic === CONTROLLER_MAC + "/securitysystem/get"));
    const setSubscription = built.mqtt.subscriptions.find((entry) => (entry.kind === "set") && (entry.topic === CONTROLLER_MAC + "/securitysystem/set"));

    assert.ok(getSubscription?.init.signal && setSubscription?.init.signal, "the security system registered its securitysystem get and set handlers");
    assert.equal(getSubscription.init.signal.aborted, false, "the get registration is live before removal");
    assert.equal(setSubscription.init.signal.aborted, false, "the set registration is live before removal");

    // Remove the security system through the OWNER's removal branch: replacing the last arm liveview with a non-arm one drives the observer into configureSecuritySystem,
    // which schedules the removal whose action calls securitySystem.cleanup(). The handlers keep answering through the removal delay, and once it ends the captured
    // handlers' owner-lifetime signal must abort while the controller-lifetime nvr.signal stays live. An isolated cleanup() call would not exercise this path - the fix
    // is the removal branch invoking it.
    built.store.pushLiveviews([makeLiveviewConfig({ id: "lv-scene", name: "Protect-Scene" })]);

    await settle();

    assert.equal(getSubscription.init.signal.aborted, false, "the security get registration still answers through the removal delay");

    built.nvr.platform.clock.advance(REMOVAL_GRACE_MS);

    assert.equal(getSubscription.init.signal.aborted, true, "removing the last arm liveview aborted the security get registration through the owner's cleanup()");
    assert.equal(setSubscription.init.signal.aborted, true, "removing the last arm liveview aborted the security set registration through the owner's cleanup()");
    assert.equal(built.nvr.signal.aborted, false, "the controller-lifetime nvr.signal stayed live - only the removed accessory's registrations unwound");

    // Re-add the arm liveview: the owner builds a FRESH security system whose configure() subscribes anew. Exactly one securitysystem get registration is now live (the
    // new one) while the prior pair stays aborted - a remove/re-add cycle stacks no live handlers.
    built.store.pushLiveviews([makeLiveviewConfig({ id: "lv-away", name: "Protect-Away" })]);

    await settle();

    const liveGetSubscriptions = built.mqtt.subscriptions.filter((entry) => (entry.kind === "get") && (entry.topic === CONTROLLER_MAC + "/securitysystem/get") &&
      (entry.init.signal?.aborted === false));

    assert.equal(liveGetSubscriptions.length, 1, "after the re-add exactly one securitysystem get registration is live - the remove/re-add cycle leaked no handlers");
  });

  test("a custom Protect-<name> liveview creates a switch accessory carrying a Switch service and logs the configure line", async () => {

    const built = buildLiveviews({ liveviews: [makeLiveviewConfig({ id: "lv-scene", name: "Protect-Scene" })] });

    activeController = built.controller;

    await settle();

    // The switch accessory was self-created at the deterministic Liveview UUID and registered.
    const switchAccessory = built.nvr.platform.accessories.find((accessory) => accessory.UUID === liveviewUuid("Scene"));

    assert.ok(switchAccessory, "the owner self-created the liveview switch accessory at the mac-derived Liveview UUID");
    assert.ok(built.api.calls.some((call) => (call.kind === "register") && call.accessories.includes(switchAccessory)),
      "the platform double recorded a register call for it");
    assert.ok(switchAccessory.getService(Service.Switch), "the switch accessory carries a Switch service");
    assert.ok(loggedAt(built.logEntries, "info", "Configuring plugin-specific liveview switch: Scene."), "the configure-switch info line logged the view name");
  });

  test("a new liveview switch carries the name the Home app edits, and a switch restored from the cache keeps the characteristics it carries", async () => {

    // A switch an earlier run built, restored from the cache with no name the Home app edits, beside a liveview that calls for a switch the owner creates.
    const restored = makeTestAccessory("Controller Den", liveviewSeed("Den"));

    restored.context.liveview = "Den";
    restored.context.nvr = CONTROLLER_MAC;

    const restoredSwitch = restored.addService(new Service.Switch("Controller Den"));
    const restoredCharacteristics = restoredSwitch.characteristics.map((characteristic) => characteristic.UUID);

    const built = buildLiveviews({ cachedAccessories: [restored],
      liveviews: [ makeLiveviewConfig({ id: "lv-den", name: "Protect-Den" }), makeLiveviewConfig({ id: "lv-scene", name: "Protect-Scene" }) ] });

    activeController = built.controller;

    await settle();

    const created = built.nvr.platform.accessories.find((accessory) => accessory.UUID === liveviewUuid("Scene"))?.getService(Service.Switch);

    assert.ok(created, "the owner created the Scene switch");
    assert.ok(created.testCharacteristic(Characteristic.ConfiguredName), "the new switch carries the name the Home app edits");
    assert.equal(created.getCharacteristic(Characteristic.ConfiguredName).value, created.displayName, "and that name is the switch's own");
    assert.equal(restored.getService(Service.Switch), restoredSwitch, "the restored accessory keeps the switch it carries");
    assert.deepEqual(restoredSwitch.characteristics.map((characteristic) => characteristic.UUID), restoredCharacteristics,
      "and that switch keeps exactly the characteristics it was restored with, so it gains no name the Home app edits");
  });

  test("a controller with an empty name adds its security system accessory under its market name", async () => {

    // HAP refuses an accessory whose display name is empty, and the controller's empty name sanitizes to nothing, so the security system takes the market name.
    const built = buildLiveviews({ liveviews: [makeLiveviewConfig({ id: "lv-away", name: "Protect-Away" })], name: "" });

    activeController = built.controller;

    await settle();

    const security = built.nvr.platform.accessories.find((accessory) => accessory.UUID === SECURITY_UUID);

    assert.ok(security, "the owner self-created the security accessory under a controller with an empty name");
    assert.equal(security.displayName, "UniFi Dream Machine SE", "the security accessory was added under the controller's market name");
    assert.ok(built.api.calls.some((call) => (call.kind === "register") && call.accessories.includes(security)),
      "the security accessory was registered under that name");
  });

  // A switch's name joins the controller's name and the view's and is sanitized whole, so an empty controller name leaves the view name alone and a character HomeKit
  // refuses only at a name's end stays when the view name follows it. Only a switch whose controller and view names each sanitize to nothing falls to the controller's
  // market name, because HAP refuses an accessory whose display name is empty.
  for(const row of [
    { controllerName: "", expected: "Scene",
      title: "a controller with an empty name adds a liveview switch under the view name alone", viewName: "Scene" },
    { controllerName: "Home -", expected: "Home - Scene",
      title: "a controller name ending in a character HomeKit refuses at a name's end keeps it in a liveview switch's name", viewName: "Scene" },
    { controllerName: "🙂", expected: "UniFi Dream Machine SE",
      title: "a liveview switch whose controller and view names each sanitize to nothing is added under the controller's market name", viewName: "🙂" }
  ]) {

    test(row.title, async () => {

      const built = buildLiveviews({ liveviews: [makeLiveviewConfig({ id: "lv-named", name: "Protect-" + row.viewName })], name: row.controllerName });

      activeController = built.controller;

      await settle();

      const switchAccessory = built.nvr.platform.accessories.find((accessory) => accessory.UUID === liveviewUuid(row.viewName));

      assert.ok(switchAccessory, "the owner self-created the liveview switch under the controller name " + JSON.stringify(row.controllerName));
      assert.equal(switchAccessory.displayName, row.expected, "the switch was added under " + JSON.stringify(row.expected));
      assert.ok(built.api.calls.some((call) => (call.kind === "register") && call.accessories.includes(switchAccessory)), "the switch was registered under that name");
    });
  }

  test("a reserved Protect-Away/Home/Night/Off name creates NO liveview switch (it is reserved for the security system)", async () => {

    const built = buildLiveviews({ liveviews: [makeLiveviewConfig({ id: "lv-home", name: "Protect-Home" })] });

    activeController = built.controller;

    await settle();

    // Protect-Home matches the security-system regex and the switch regex's negative lookahead excludes it, so no liveview switch accessory is created.
    const switchAccessory = built.nvr.platform.accessories.find((accessory) => accessory.UUID === liveviewUuid("Home"));

    assert.equal(switchAccessory, undefined, "a reserved arm-state name creates no liveview switch accessory");
    assert.equal(built.api.calls.some((call) => (call.kind === "register") && call.accessories.some((candidate) => candidate.UUID === liveviewUuid("Home"))),
      false, "no switch register call was recorded for the reserved name");
  });

  // A reserved name is read in any case: it calls for the security system and creates no switch.
  test("a liveview name in another case, protect-away, builds the security system and no switch", async () => {

    const built = buildLiveviews({ liveviews: [makeLiveviewConfig({ id: "lv-away", name: "protect-away" })] });

    activeController = built.controller;

    await settle();

    const security = built.nvr.platform.accessories.find((accessory) => accessory.UUID === SECURITY_UUID);

    assert.ok(security?.getService(Service.SecuritySystem), "the liveview called for the security system in spite of its case");
    assert.equal(built.nvr.platform.accessories.find((accessory) => accessory.UUID === liveviewUuid("away")), undefined, "the reserved name creates no switch");
  });

  test("an orphan liveview switch (its liveview removed/renamed) is unregistered and logs the removal", async () => {

    // Pre-seed a cached switch accessory whose context.liveview ("Ghost") matches no current liveview, so the orphan-removal path removes one rather than no-opping.
    const orphan = makeTestAccessory("Ghost Liveview", liveviewSeed("Ghost"));

    orphan.context.liveview = "Ghost";
    orphan.context.nvr = CONTROLLER_MAC;
    orphan.addService(new Service.Switch("Ghost"));

    const built = buildLiveviews({ cachedAccessories: [orphan], liveviews: [makeLiveviewConfig({ id: "lv-scene", name: "Protect-Scene" })] });

    activeController = built.controller;

    await settle();

    // The removal gate scheduled the orphan's removal, which lands once the removal delay ends.
    assert.ok(built.nvr.platform.accessories.includes(orphan), "the orphan switch stays through the removal delay");

    built.nvr.platform.clock.advance(REMOVAL_GRACE_MS);

    assert.equal(built.nvr.platform.accessories.includes(orphan), false, "the orphan switch accessory was spliced out of the platform array");
    assert.ok(built.api.calls.some((call) => (call.kind === "unregister") && call.accessories.includes(orphan)),
      "the platform double recorded an unregister call for the orphan");
    assert.ok(loggedAt(built.logEntries, "info", "Removing plugin-specific liveview switch: Ghost."), "the orphan-removal info line logged the stale view name");
  });

  test("toggling a liveview scene switch fans motion onto its member camera (flips false->true) and publishes - NON-VACUOUS", async () => {

    // Pre-seed the scene switch accessory with liveviewState false so the construction-time setSwitchState(false) early-returns (getSwitchState === target), keeping the
    // later toggle a genuine false->true change. The member's detectMotion starts FALSY so the fanout's continue-when-already-at-target guard does not skip it.
    const sceneAccessory = makeTestAccessory("Controller Scene", liveviewSeed("Scene"));

    sceneAccessory.context.liveview = "Scene";
    sceneAccessory.context.liveviewState = false;
    sceneAccessory.context.nvr = CONTROLLER_MAC;
    sceneAccessory.addService(new Service.Switch("Controller Scene"));

    const built = buildLiveviews({

      cachedAccessories: [sceneAccessory],
      liveviews: [makeLiveviewConfig({ cameras: ["camera-scene"], id: "lv-scene", name: "Protect-Scene" })]
    });

    activeController = built.controller;

    const member = seedMember(built.nvr, { detectMotion: false, id: "camera-scene", mac: "74ACB9000301", name: "Scene Camera" });

    await settle();

    // Precondition: the member starts off (both its subtyped motion switch and its plain decoy read off), and the scene switch (pre-seeded liveviewState false) reads
    // off, so the toggle is a genuine change.
    assert.equal(member.accessory.context.detectMotion, false, "the member camera starts with motion detection off");
    assert.equal(member.motionSwitch.getCharacteristic(Characteristic.On).value, false, "the member's subtyped motion switch starts off");
    assert.equal(member.decoySwitch.getCharacteristic(Characteristic.On).value, false, "the member's plain decoy switch starts off");

    const sceneSwitch = sceneAccessory.getService(Service.Switch);

    assert.ok(sceneSwitch, "the scene switch service exists");

    const publishedBefore = built.mqtt.published.length;

    // Toggle the scene switch on through its real onSet (HomeKit's set path).
    await triggerSet(sceneSwitch.getCharacteristic(Characteristic.On), true);

    // The member FLIPPED on (the discriminating assertion: false -> true) and its context updated. The write landed on the SUBTYPED switch; the plain decoy stayed off -
    // the getServiceById(Switch, SWITCH_MOTION_SENSOR) lookup is what keeps the decoy untouched (a plain getService would have flipped the decoy instead).
    assert.equal(member.motionSwitch.getCharacteristic(Characteristic.On).value, true, "the member's subtyped motion switch flipped on for the scene");
    assert.equal(member.decoySwitch.getCharacteristic(Characteristic.On).value, false, "the member's plain decoy switch was left untouched");
    assert.equal(member.accessory.context.detectMotion, true, "the member's detectMotion context flipped to true");
    assert.ok(loggedAt(built.logEntries, "info", "Scene -> Scene Camera: Motion detection enabled."),
      "the per-member motion-enabled line fired with the scene and member");

    // The scene publish carries the liveview name and the new state.
    assert.ok(built.mqtt.published.slice(publishedBefore).some((published) => (published.topic === CONTROLLER_MAC + "/liveviews") && published.payload.includes("Scene")),
      "the accepted scene toggle published the liveview state on the controller-scoped topic");
  });

  test("the liveviews MQTT GET composes the controller-MAC topic and returns the JSON of switch states", async () => {

    const built = buildLiveviews({ liveviews: [makeLiveviewConfig({ id: "lv-scene", name: "Protect-Scene" })] });

    activeController = built.controller;

    await settle();

    const subscription = built.mqtt.subscriptions.find((entry) => (entry.kind === "get") && (entry.topic === CONTROLLER_MAC + "/liveviews/get"));

    assert.ok(subscription, "the liveviews GET subscription composed the controller-MAC topic");

    // The handler returns the JSON array of { name, state } for every liveview switch. The seeded Protect-Scene switch is present.
    const payload = JSON.parse(await built.mqtt.invokeGet(CONTROLLER_MAC + "/liveviews/get") ?? "[]") as { name: string; state: boolean }[];

    assert.ok(payload.some((entry) => entry.name === "Scene"), "the GET handler stringifies the liveview switch states, carrying the Scene switch");

    // The subscription is scoped to this owner's composed lifetime, which for a controller owner is the controller connection: live while the controller runs, and over
    // the moment the controller signal aborts. Asserted behaviorally rather than by object identity, because the composed signal is a derived signal that fires when
    // nvr.signal does rather than being nvr.signal itself.
    assert.equal(subscription.init.signal?.aborted, false, "the GET registration's lifetime is live while the controller runs");

    built.controller.abort();

    assert.equal(subscription.init.signal.aborted, true, "the GET registration's lifetime ended with the controller abort");
  });

  test("the liveviews MQTT SET applies the commanded scene to its member cameras, rejects a non-array payload, and logs bad JSON", async () => {

    const built = buildLiveviews({ liveviews: [makeLiveviewConfig({ cameras: ["camera-scene"], id: "lv-scene", name: "Protect-Scene" })] });

    activeController = built.controller;

    // A member camera seeded with detectMotion FALSE, divergent from the commanded ON state, so applying the scene is a genuine false->true change (setSwitchState is
    // change-gated and would otherwise no-op).
    const member = seedMember(built.nvr, { detectMotion: false, id: "camera-scene", mac: "74ACB9000301", name: "Scene Camera" });

    await settle();

    const subscription = built.mqtt.subscriptions.find((entry) => (entry.kind === "set") && (entry.topic === CONTROLLER_MAC + "/liveviews/set"));

    assert.ok(subscription, "the liveviews SET subscription composed the controller-MAC topic");
    assert.equal(member.accessory.context.detectMotion, false, "the member camera starts with motion detection off");

    const publishedBefore = built.mqtt.published.length;

    // A well-formed payload drives the scene through the switch's own onSet (setCharacteristic), which fans motion onto the member cameras exactly as a HomeKit tap does.
    // The set is fire-and-forget, so settle before asserting the downstream effects. A status-only updateCharacteristic never runs the handler, so this test goes red
    // on that mutation - the scene never reaches the member cameras.
    await built.mqtt.invokeSet(CONTROLLER_MAC + "/liveviews/set", JSON.stringify([{ name: "Scene", state: true }]));

    await settle();

    assert.equal(member.accessory.context.detectMotion, true, "the MQTT-commanded scene flipped the member's detectMotion on");
    assert.equal(member.motionSwitch.getCharacteristic(Characteristic.On).value, true, "the member's subtyped motion switch updated for the scene");
    assert.ok(loggedAt(built.logEntries, "info", "Liveview scene updated via MQTT: Scene."), "the MQTT-update info line logged");
    assert.ok(built.mqtt.published.slice(publishedBefore).some((published) => (published.topic === CONTROLLER_MAC + "/liveviews") && published.payload.includes("Scene")),
      "the applied scene published the liveview state on the controller-scoped topic");

    // A non-array payload (top-level null) is the handled failure, not a crash: the Array.isArray guard logs the validation error and the handler returns without
    // throwing (an unguarded length read on a non-array value throws a TypeError - the crash this test forbids).
    await built.mqtt.invokeSet(CONTROLLER_MAC + "/liveviews/set", "null");

    assert.ok(loggedAt(built.logEntries, "error", "The payload contained no liveviews."), "a non-array MQTT payload logs the validation error and does not throw");

    // Bad JSON logs the invalid-JSON error and changes nothing.
    await built.mqtt.invokeSet(CONTROLLER_MAC + "/liveviews/set", "not json");

    assert.ok(loggedAt(built.logEntries, "error", "Invalid JSON."), "malformed MQTT JSON logs the invalid-JSON error");
  });

  // An entry's name is read only with a switch standing to compare it to, so a malformed entry with none standing has nothing to fault on.
  test("a malformed entry with no switch standing moves on", async () => {

    const built = buildLiveviews({ liveviews: [] });

    activeController = built.controller;

    await assert.doesNotReject(built.mqtt.invokeSet(CONTROLLER_MAC + "/liveviews/set", JSON.stringify([{ state: true }])), "the entry with no name moves on");
  });

  // A view with no cameras gives a set nothing to move, which the body's own early return reads as well, so it logs no scene update and its switch stays where it
  // reads. A view whose cameras are all unresolved still has cameras, and only the body's loop knows nothing moved there, so it logs its update line and moves its On.
  // Each switch starts off so a set to on is a genuine change.
  test("a set on a liveview with no cameras moves nothing and logs no scene update, while one whose cameras are all unresolved logs it and moves its On", async () => {

    const built = buildLiveviews({ liveviews: [ makeLiveviewConfig({ id: "lv-empty", name: "Protect-Empty" }),
      makeLiveviewConfig({ cameras: ["camera-missing"], id: "lv-missing", name: "Protect-Missing" }) ] });

    activeController = built.controller;

    await settle();

    const onOf = (viewName: string): Characteristic | undefined => built.nvr.platform.accessories.find((accessory) => accessory.UUID === liveviewUuid(viewName))?.
      getService(Service.Switch)?.getCharacteristic(Characteristic.On);
    const on = onOf("Empty");
    const missingOn = onOf("Missing");

    assert.ok(on && missingOn, "each liveview's switch stands");

    on.updateValue(false);
    missingOn.updateValue(false);

    await built.mqtt.invokeSet(CONTROLLER_MAC + "/liveviews/set", JSON.stringify([{ name: "Empty", state: true }]));
    await settle();

    assert.equal(on.value, false, "the set on the view with no cameras moves nothing");
    assert.equal(loggedAt(built.logEntries, "info", "Liveview scene updated via MQTT"), false, "and logs no scene update");

    await built.mqtt.invokeSet(CONTROLLER_MAC + "/liveviews/set", JSON.stringify([{ name: "Missing", state: true }]));
    await settle();

    assert.equal(missingOn.value, true, "the set on the view whose cameras are all unresolved moves its On");
    assert.ok(loggedAt(built.logEntries, "info", "Liveview scene updated via MQTT: Missing."), "and its update line");
  });

  test("the single nvr.liveviews observer reconciles a new switch on a pushLiveviews, and teardown deregisters it", async () => {

    const built = buildLiveviews({ liveviews: [makeLiveviewConfig({ id: "lv-scene", name: "Protect-Scene" })] });

    activeController = built.controller;

    await settle();

    assert.equal(built.store.observerCount, 1, "the single nvr.liveviews observer is registered against the store double");

    // The REACTION: a pushLiveviews adding a new custom liveview reconciles a new switch accessory (DISTINCT ids per the distinct-id discipline).
    built.store.pushLiveviews([ makeLiveviewConfig({ id: "lv-scene", name: "Protect-Scene" }), makeLiveviewConfig({ id: "lv-new", name: "Protect-NewScene" }) ]);

    await settle();

    assert.ok(built.nvr.platform.accessories.some((accessory) => accessory.UUID === liveviewUuid("NewScene")),
      "the observer reconciled a new switch accessory for the pushed liveview");

    // Teardown via the controller signal, then confirm the observer deregistered and a later push does not reconcile.
    const accessoriesBefore = built.nvr.platform.accessories.length;

    built.controller.abort();

    await settle();

    assert.equal(built.store.observerCount, 0, "the observer deregistered through the controller signal");

    built.store.pushLiveviews([makeLiveviewConfig({ id: "lv-after", name: "Protect-AfterTeardown" })]);

    await settle();

    assert.equal(built.nvr.platform.accessories.length, accessoriesBefore, "a push after teardown reconciles nothing - the reaction is gone");
  });

  test("controller A's reconcile leaves controller B's liveview switch untouched, and each controller's MQTT addresses only its own switches", async () => {

    // Controller B's distinct MAC and the deterministic UUID of its Other switch (the owner uppercases the view name into the seed HAP's generator derives the UUID
    // from).
    const MAC_B = "74ACB9AAAAAA";
    const otherSwitchUuid = accessoryUuid(MAC_B + ".Liveview.OTHER");

    // Controller A owns a Protect-Scene liveview; controller B owns a Protect-Other liveview. They share ONE platform accessories array and Homebridge API double,
    // mirroring production's single ProtectPlatform, but carry DISTINCT controller MACs so each owner scopes its switches by the context MAC.
    const controllerA = buildLiveviews({ liveviews: [makeLiveviewConfig({ id: "lv-scene", name: "Protect-Scene" })] });

    activeController = controllerA.controller;

    const controllerB = buildLiveviews({ liveviews: [makeLiveviewConfig({ id: "lv-other", name: "Protect-Other" })], mac: MAC_B,
      sharedPlatform: { accessories: controllerA.nvr.platform.accessories, api: controllerA.api } });

    extraControllers.push(controllerB.controller);

    await settle();

    const sceneSwitch = controllerA.nvr.platform.accessories.find((accessory) => accessory.UUID === liveviewUuid("Scene"));
    const otherSwitch = controllerA.nvr.platform.accessories.find((accessory) => accessory.UUID === otherSwitchUuid);

    assert.ok(sceneSwitch, "controller A created its Scene switch on the shared platform");
    assert.ok(otherSwitch, "controller B created its Other switch on the shared platform");

    // Re-run controller A's reconcile. Its orphan sweep filters to its own controller MAC (this.platform.accessories.filter(x => this.isOwnedLiveviewSwitch(x))), so
    // controller B's Other switch is never iterated. Without the MAC scoping this pass would find B's switch, fail to match "Protect-Other" against A's liveviews, and
    // unregister it - the proof point for this test.
    controllerA.owner.configureLiveviews();

    await settle();

    assert.ok(controllerA.nvr.platform.accessories.includes(otherSwitch), "controller B's Other switch survived controller A's reconcile");
    assert.ok(controllerA.nvr.platform.accessories.includes(sceneSwitch), "controller A's own Scene switch was preserved");
    assert.equal(controllerA.api.calls.some((call) => (call.kind === "unregister") && call.accessories.some((candidate) => candidate.UUID === otherSwitchUuid)), false,
      "no unregister call was recorded for controller B's switch");

    // Each controller's MQTT GET addresses only its own switches: A returns Scene and not Other, B returns Other and not Scene.
    const getA = controllerA.mqtt.subscriptions.find((entry) => (entry.kind === "get") && (entry.topic === CONTROLLER_MAC + "/liveviews/get"));
    const getB = controllerB.mqtt.subscriptions.find((entry) => (entry.kind === "get") && (entry.topic === MAC_B + "/liveviews/get"));

    assert.ok(getA && getB, "both controllers registered their controller-scoped liveviews GET handlers");

    const payloadA = JSON.parse(await controllerA.mqtt.invokeGet(CONTROLLER_MAC + "/liveviews/get") ?? "") as { name: string }[];
    const payloadB = JSON.parse(await controllerB.mqtt.invokeGet(MAC_B + "/liveviews/get") ?? "") as { name: string }[];

    assert.ok(payloadA.some((entry) => entry.name === "Scene") && !payloadA.some((entry) => entry.name === "Other"),
      "controller A's GET returned only its own Scene switch");
    assert.ok(payloadB.some((entry) => entry.name === "Other") && !payloadB.some((entry) => entry.name === "Scene"),
      "controller B's GET returned only its own Other switch");
  });

  test("a single reconcile pass sweeps two ADJACENT orphan liveview switches - the snapshot iteration never skips the shifted neighbor", async () => {

    // Two cached orphan switches, ADJACENT in the platform array, both scoped to this controller and matching no current liveview.
    const ghostOne = makeTestAccessory("Ghost One", liveviewSeed("GhostOne"));

    ghostOne.context.liveview = "GhostOne";
    ghostOne.context.nvr = CONTROLLER_MAC;
    ghostOne.addService(new Service.Switch("Ghost One"));

    const ghostTwo = makeTestAccessory("Ghost Two", liveviewSeed("GhostTwo"));

    ghostTwo.context.liveview = "GhostTwo";
    ghostTwo.context.nvr = CONTROLLER_MAC;
    ghostTwo.addService(new Service.Switch("Ghost Two"));

    // One reconcile pass must schedule BOTH orphans, and one removal delay remove them. The filtered-snapshot iteration is what proves it: an in-place splice over the
    // live array (the mutation this test forbids) shifts the second orphan into the just-vacated slot, which is exactly what this test would catch.
    const built = buildLiveviews({ cachedAccessories: [ ghostOne, ghostTwo ], liveviews: [] });

    activeController = built.controller;

    await settle();

    built.nvr.platform.clock.advance(REMOVAL_GRACE_MS);

    assert.equal(built.nvr.platform.accessories.includes(ghostOne), false, "the first adjacent orphan was swept");
    assert.equal(built.nvr.platform.accessories.includes(ghostTwo), false, "the second adjacent orphan was swept in the SAME pass - not skipped by an index shift");
  });
});

describe("the liveviews reconcile through the membership delta and the removal gate", () => {

  // The per-test controller, tracked so afterEach aborts whichever build the test made.
  let activeController: AbortController | undefined;

  afterEach(() => {

    activeController?.abort();
    activeController = undefined;
  });

  // A switch whose liveview is removed leaves through the removal gate rather than at once: it stays through the user's removal delay with its MQTT get still answering
  // and its MQTT set skipping it, and leaves when the delay ends with its liveview still gone. Its name leaves with it, so the liveview's return builds the switch anew.
  test("a switch whose liveview is removed keeps answering its MQTT get through the removal delay, skips its set, and leaves when it ends", async () => {

    const built = buildLiveviews({ liveviews: [makeLiveviewConfig({ id: "lv-scene", name: "Protect-Scene" })] });

    activeController = built.controller;

    await settle();

    const sceneSwitch = built.nvr.platform.accessories.find((accessory) => accessory.UUID === liveviewUuid("Scene"));
    const on = sceneSwitch?.getService(Service.Switch)?.getCharacteristic(Characteristic.On);

    assert.ok(sceneSwitch && on, "the Scene switch exists");

    built.store.pushLiveviews([makeLiveviewConfig({ id: "lv-garden", name: "Protect-Garden" })]);

    await settle();

    assert.ok(loggedAt(built.logEntries, "info", "Removing plugin-specific liveview switch: Scene."), "the removal is narrated as it is scheduled");
    assert.ok(built.nvr.platform.accessories.includes(sceneSwitch), "the switch stays through the removal delay");

    const payload = JSON.parse(await built.mqtt.invokeGet(CONTROLLER_MAC + "/liveviews/get") ?? "[]") as { name: string }[];

    assert.ok(payload.some((entry) => entry.name === "Scene"), "the MQTT get still answers for the switch through the removal delay");

    const held = on.value;

    await built.mqtt.invokeSet(CONTROLLER_MAC + "/liveviews/set", JSON.stringify([{ name: "Scene", state: !held }]));
    await settle();

    assert.equal(on.value, held, "the MQTT set moves nothing through the removal delay");
    assert.equal(loggedAt(built.logEntries, "info", "Liveview scene updated via MQTT"), false, "and logs no scene update");

    built.nvr.platform.clock.advance(REMOVAL_GRACE_MS);

    assert.equal(built.nvr.platform.accessories.includes(sceneSwitch), false, "the switch left when the removal delay ended with its liveview still gone");

    built.store.pushLiveviews([ makeLiveviewConfig({ id: "lv-garden", name: "Protect-Garden" }), makeLiveviewConfig({ id: "lv-scene", name: "Protect-Scene" }) ]);

    await settle();

    assert.ok(built.nvr.platform.accessories.some((accessory) => accessory.UUID === liveviewUuid("Scene")), "the returning liveview built its switch anew");
  });

  // What a deleted liveview leaves the removal gate holding, each reached as the controller reaches it: a controller stable for its window schedules the removal, one not
  // yet stable schedules nothing, and a flap during the delay drops the removal it held. The verdict reads the liveview, so it reads the same in each.
  const GATE_POSTURES = [
    { flapAfter: false, flapBefore: false, pending: true, title: "through the removal delay" },
    { flapAfter: false, flapBefore: true, pending: false, title: "with the controller not yet stable" },
    { flapAfter: true, flapBefore: false, pending: false, title: "after a flap dropped the removal" }
  ];

  // Delete liveviews down to those a row names, in the posture it names.
  async function deleteInPosture(built: ReturnType<typeof buildLiveviews>, posture: (typeof GATE_POSTURES)[number], remaining: ProtectNvrLiveviewConfig[]):
  Promise<void> {

    const flap = (): void => {

      built.nvr.pushControllerStability(false);
      built.nvr.pushControllerStability(true);
    };

    if(posture.flapBefore) {

      flap();
    }

    built.store.pushLiveviews(remaining);

    await settle();

    if(posture.flapAfter) {

      flap();
    }
  }

  // One owner holds many switches, so the refusal reads each switch's own liveview: the one whose liveview is gone refuses and the one beside it answers. An MQTT get
  // keeps answering for the accessory that stays and an MQTT set claims nothing for it, and the verdict is read on each call, so a liveview's return clears the refusal
  // and the skip with nothing rebound. The Scene view carries a camera so the set on its return has something to move.
  for(const posture of GATE_POSTURES) {

    test("a switch whose liveview is deleted refuses a read and a write " + posture.title + ", its MQTT get answers, its MQTT set claims nothing, and its return " +
      "answers each", async () => {

      const garden = makeLiveviewConfig({ id: "lv-garden", name: "Protect-Garden" });
      const scene = makeLiveviewConfig({ cameras: ["camera-scene"], id: "lv-scene", name: "Protect-Scene" });
      const built = buildLiveviews({ liveviews: [ garden, scene ] });

      activeController = built.controller;

      await settle();

      const member = seedMember(built.nvr, { detectMotion: true, id: "camera-scene", mac: "74ACB9000303", name: "Scene Camera" });
      const sceneSwitch = built.nvr.platform.accessories.find((accessory) => accessory.UUID === liveviewUuid("Scene"));
      const on = sceneSwitch?.getService(Service.Switch)?.getCharacteristic(Characteristic.On);
      const gardenOn = built.nvr.platform.accessories.find((accessory) => accessory.UUID === liveviewUuid("Garden"))?.getService(Service.Switch)?.
        getCharacteristic(Characteristic.On);

      assert.ok(sceneSwitch && on && gardenOn, "each liveview's switch stands");

      await assert.doesNotReject(triggerGet(on), "a switch its liveview calls for answers");

      await deleteInPosture(built, posture, [garden]);

      assert.equal(built.nvr.removals.isPending(sceneSwitch.UUID), posture.pending, "the removal gate holds what this posture leaves it");

      await assert.rejects(triggerGet(on), hapStatus(HAPStatus.SERVICE_COMMUNICATION_FAILURE), "a read refuses");
      await assert.rejects(triggerSet(on, true), hapStatus(HAPStatus.SERVICE_COMMUNICATION_FAILURE), "and so does a write");
      await assert.doesNotReject(triggerGet(gardenOn), "and the switch beside it keeps answering a read");
      await assert.doesNotReject(triggerSet(gardenOn, true), "and a write");

      const payload = JSON.parse(await built.mqtt.invokeGet(CONTROLLER_MAC + "/liveviews/get") ?? "[]") as { name: string }[];

      assert.ok(payload.some((entry) => entry.name === "Scene"), "the MQTT get answers for the switch");

      const held = on.value;

      await built.mqtt.invokeSet(CONTROLLER_MAC + "/liveviews/set", JSON.stringify([{ name: "Scene", state: !held }]));
      await settle();

      assert.equal(on.value, held, "the MQTT set moves nothing");
      assert.equal(loggedAt(built.logEntries, "info", "Liveview scene updated via MQTT"), false, "and logs no scene update");

      built.store.pushLiveviews([ garden, scene ]);

      await settle();

      assert.equal(built.nvr.removals.isPending(sceneSwitch.UUID), false, "the liveview's return leaves no removal pending");

      await built.mqtt.invokeSet(CONTROLLER_MAC + "/liveviews/set", JSON.stringify([{ name: "scene", state: !held }]));
      await settle();

      assert.equal(on.value, !held, "the liveview's return applies a set, whatever case it names the liveview in");
      assert.ok(loggedAt(built.logEntries, "info", "Liveview scene updated via MQTT: Scene."), "and logs the scene update");
      assert.equal(member.accessory.context.detectMotion, false, "and the scene reaches its member camera");

      await assert.doesNotReject(triggerGet(on), "and a read answers again");
      await assert.doesNotReject(triggerSet(on, true), "and so does a write");
    });
  }

  // A payload's entries are read one at a time, so the entry naming a deleted liveview's switch costs the ones behind it nothing.
  test("a payload naming a deleted liveview's switch ahead of a live one applies the live entry alone", async () => {

    const garden = makeLiveviewConfig({ cameras: ["camera-garden"], id: "lv-garden", name: "Protect-Garden" });
    const built = buildLiveviews({ liveviews: [ garden, makeLiveviewConfig({ id: "lv-scene", name: "Protect-Scene" }) ] });

    activeController = built.controller;

    await settle();

    const member = seedMember(built.nvr, { detectMotion: false, id: "camera-garden", mac: "74ACB9000302", name: "Garden Camera" });
    const on = built.nvr.platform.accessories.find((accessory) => accessory.UUID === liveviewUuid("Scene"))?.getService(Service.Switch)?.
      getCharacteristic(Characteristic.On);

    assert.ok(on, "the Scene switch stands");

    built.store.pushLiveviews([garden]);

    await settle();

    const held = on.value;

    await built.mqtt.invokeSet(CONTROLLER_MAC + "/liveviews/set", JSON.stringify([ { name: "Scene", state: !held }, { name: "Garden", state: true } ]));
    await settle();

    assert.equal(on.value, held, "the deleted liveview's switch moves nothing");
    assert.equal(loggedAt(built.logEntries, "info", "Liveview scene updated via MQTT: Scene."), false, "and logs no scene update");
    assert.equal(member.accessory.context.detectMotion, true, "the live entry behind it applies its scene to its member camera");
    assert.ok(loggedAt(built.logEntries, "info", "Liveview scene updated via MQTT: Garden."), "and logs its scene update");
  });

  // The security system's half of the refusal is its own verdict, whose suite reads it against the store directly. These rows read it through the reconcile, with an
  // ordinary liveview standing so the list reads non-empty, and through each posture the gate can hold while the accessory stays.
  for(const posture of GATE_POSTURES) {

    test("a security system whose calling liveview is deleted refuses " + posture.title + ", its MQTT get and set answering, and answers on its return", async () => {

      const away = makeLiveviewConfig({ id: "lv-away", name: "Protect-Away" });
      const ordinary = makeLiveviewConfig({ id: "lv-ordinary", name: "Front Door" });
      const built = buildLiveviews({ liveviews: [ away, ordinary ] });

      activeController = built.controller;

      await settle();

      const security = built.nvr.platform.accessories.find((accessory) => accessory.UUID === SECURITY_UUID);
      const current = security?.getService(Service.SecuritySystem)?.getCharacteristic(Characteristic.SecuritySystemCurrentState);
      const target = security?.getService(Service.SecuritySystem)?.getCharacteristic(Characteristic.SecuritySystemTargetState);

      assert.ok(security && current && target, "the security system stands");

      await assert.doesNotReject(triggerGet(target), "a security system its liveview calls for answers");

      await deleteInPosture(built, posture, [ordinary]);

      assert.equal(built.nvr.removals.isPending(SECURITY_UUID), posture.pending, "the removal gate holds what this posture leaves it");
      assert.ok(built.nvr.platform.accessories.includes(security), "and the accessory stays");

      await assert.rejects(triggerGet(target), hapStatus(HAPStatus.SERVICE_COMMUNICATION_FAILURE), "a read refuses");
      await assert.rejects(triggerSet(target, Characteristic.SecuritySystemTargetState.DISARM), hapStatus(HAPStatus.SERVICE_COMMUNICATION_FAILURE),
        "and so does a write");

      assert.equal(await built.mqtt.invokeGet(CONTROLLER_MAC + "/securitysystem/get"), "Off", "the MQTT get answers");

      await built.mqtt.invokeSet(CONTROLLER_MAC + "/securitysystem/set", "away");

      assert.equal(current.value, Characteristic.SecuritySystemCurrentState.AWAY_ARM, "and the MQTT set applies its scene");

      built.store.pushLiveviews([ away, ordinary ]);

      await settle();

      assert.equal(built.nvr.removals.isPending(SECURITY_UUID), false, "the liveview's return leaves no removal pending");

      await assert.doesNotReject(triggerGet(target), "the liveview's return answers a read again");
      await assert.doesNotReject(triggerSet(target, Characteristic.SecuritySystemTargetState.DISARM), "and a write");
    });
  }

  // The removal gate holds every removal until the controller has been settled for its stability window, so a liveview removed while the controller is unsettled
  // schedules nothing. The controller's stability sweep re-runs this reconcile once the window has passed, and that pass schedules the removal.
  test("a removal the gate refuses while the controller is unsettled is scheduled by the reconcile the stability sweep re-runs", async () => {

    const built = buildLiveviews({ liveviews: [makeLiveviewConfig({ id: "lv-scene", name: "Protect-Scene" })] });

    activeController = built.controller;

    await settle();

    const sceneSwitch = built.nvr.platform.accessories.find((accessory) => accessory.UUID === liveviewUuid("Scene"));

    assert.ok(sceneSwitch, "the Scene switch exists");

    built.nvr.pushControllerStability(false);
    built.store.pushLiveviews([]);

    await settle();

    built.nvr.platform.clock.advance(REMOVAL_GRACE_MS);

    assert.ok(built.nvr.platform.accessories.includes(sceneSwitch), "nothing is removed while the controller is unsettled");
    assert.equal(loggedAt(built.logEntries, "info", "Removing plugin-specific liveview switch: Scene."), false, "and nothing is scheduled");

    // Stability returns, and the controller's sweep re-runs the reconcile.
    built.nvr.restabilizeController();
    built.owner.configureLiveviews();

    assert.ok(loggedAt(built.logEntries, "info", "Removing plugin-specific liveview switch: Scene."), "the re-run reconcile scheduled the removal");
    assert.ok(built.nvr.platform.accessories.includes(sceneSwitch), "the switch stays through the removal delay");

    built.nvr.platform.clock.advance(REMOVAL_GRACE_MS);

    assert.equal(built.nvr.platform.accessories.includes(sceneSwitch), false, "the switch left when the removal delay ended");
  });

  /* A liveview that returns during the removal delay cancels the pending removal, so its switch stays the configured switch it was, never rebuilt. The cancel is what
   * lets a later removal wait a full delay of its own: the gate keeps the first deadline an accessory was given, so a removal left pending would fire at its original
   * deadline once the liveview was gone again.
   */
  test("a liveview that returns during the removal delay keeps its switch, and a later removal waits a full delay of its own", async () => {

    const built = buildLiveviews({ liveviews: [makeLiveviewConfig({ id: "lv-scene", name: "Protect-Scene" })] });

    activeController = built.controller;

    await settle();

    const sceneSwitch = built.nvr.platform.accessories.find((accessory) => accessory.UUID === liveviewUuid("Scene"));

    assert.ok(sceneSwitch, "the Scene switch exists");

    built.store.pushLiveviews([]);

    await settle();

    built.nvr.platform.clock.advance(REMOVAL_GRACE_MS / 2);
    built.store.pushLiveviews([makeLiveviewConfig({ id: "lv-scene", name: "Protect-Scene" })]);

    await settle();

    built.nvr.platform.clock.advance(REMOVAL_GRACE_MS);

    assert.ok(built.nvr.platform.accessories.includes(sceneSwitch), "the switch whose liveview returned stayed past the removal delay");
    assert.equal(logCount(built.logEntries, "info", "Configuring plugin-specific liveview switch: Scene."), 1, "the switch was never rebuilt");

    // The liveview leaves, returns a quarter of the delay later, and leaves again a quarter after that. The second departure's removal waits a full delay from
    // then, so the switch is still here at the first departure's deadline and leaves at the second's.
    built.store.pushLiveviews([]);

    await settle();

    built.nvr.platform.clock.advance(REMOVAL_GRACE_MS / 4);
    built.store.pushLiveviews([makeLiveviewConfig({ id: "lv-scene", name: "Protect-Scene" })]);

    await settle();

    built.nvr.platform.clock.advance(REMOVAL_GRACE_MS / 4);
    built.store.pushLiveviews([]);

    await settle();

    built.nvr.platform.clock.advance(REMOVAL_GRACE_MS / 2);

    assert.ok(built.nvr.platform.accessories.includes(sceneSwitch), "the later removal waits a full delay of its own, past the earlier deadline");

    built.nvr.platform.clock.advance(REMOVAL_GRACE_MS / 2);

    assert.equal(built.nvr.platform.accessories.includes(sceneSwitch), false, "and the switch leaves when that delay ends");
  });

  /* A plugin-specific liveview that returns during the security system's removal delay cancels the pending removal, so the security system stays the one it was, never
   * rebuilt. The cancel is what lets a later removal wait a full delay of its own, exactly as it is for a switch: the gate keeps the first deadline an accessory was
   * given, so a removal left pending would fire at its original deadline once the liveviews were gone again.
   */
  test("a security liveview that returns during the removal delay keeps the security system, and a later removal waits a full delay of its own", async () => {

    const built = buildLiveviews({ liveviews: [makeLiveviewConfig({ id: "lv-away", name: "Protect-Away" })] });

    activeController = built.controller;

    await settle();

    const security = built.nvr.platform.accessories.find((accessory) => accessory.UUID === SECURITY_UUID);

    assert.ok(security, "the security system exists");

    built.store.pushLiveviews([]);

    await settle();

    built.nvr.platform.clock.advance(REMOVAL_GRACE_MS / 2);
    built.store.pushLiveviews([makeLiveviewConfig({ id: "lv-away", name: "Protect-Away" })]);

    await settle();

    built.nvr.platform.clock.advance(REMOVAL_GRACE_MS);

    assert.ok(built.nvr.platform.accessories.includes(security), "the security system whose liveview returned stayed past the removal delay");
    assert.equal(logCount(built.logEntries, "info", "Plugin-specific liveviews have been detected. Enabling the security system accessory."), 1,
      "the security system was never rebuilt");

    // The liveview leaves, returns a quarter of the delay later, and leaves again a quarter after that. The second departure's removal waits a full delay from
    // then, so the security system is still here at the first departure's deadline and leaves at the second's.
    built.store.pushLiveviews([]);

    await settle();

    built.nvr.platform.clock.advance(REMOVAL_GRACE_MS / 4);
    built.store.pushLiveviews([makeLiveviewConfig({ id: "lv-away", name: "Protect-Away" })]);

    await settle();

    built.nvr.platform.clock.advance(REMOVAL_GRACE_MS / 4);
    built.store.pushLiveviews([]);

    await settle();

    built.nvr.platform.clock.advance(REMOVAL_GRACE_MS / 2);

    assert.ok(built.nvr.platform.accessories.includes(security), "the later removal waits a full delay of its own, past the earlier deadline");

    built.nvr.platform.clock.advance(REMOVAL_GRACE_MS / 2);

    assert.equal(built.nvr.platform.accessories.includes(security), false, "and the security system leaves when that delay ends");
  });

  /* A liveview can return with the removal's timer firing ahead of the reconcile that would cancel it: the controller's update has reached the store, and the observe
   * loop has not yet woken. The re-check at the fire is what keeps each accessory then, because it reads the store rather than the last reconcile's answer.
   */
  test("a liveview returning with the removal's timer firing ahead of the reconcile keeps its switch and the security system", async () => {

    const liveviews = [ makeLiveviewConfig({ id: "lv-away", name: "Protect-Away" }), makeLiveviewConfig({ id: "lv-scene", name: "Protect-Scene" }) ];
    const built = buildLiveviews({ liveviews });

    activeController = built.controller;

    await settle();

    const security = built.nvr.platform.accessories.find((accessory) => accessory.UUID === SECURITY_UUID);
    const sceneSwitch = built.nvr.platform.accessories.find((accessory) => accessory.UUID === liveviewUuid("Scene"));

    assert.ok(security && sceneSwitch, "the security system and the Scene switch exist");

    built.store.pushLiveviews([]);

    await settle();

    // The observe loop wakes on a later turn, so nothing here settles between the return and the fire, and no reconcile runs ahead of the timer.
    built.store.pushLiveviews(liveviews);
    built.nvr.platform.clock.advance(REMOVAL_GRACE_MS);

    assert.ok(built.nvr.platform.accessories.includes(security), "the security system stayed, its re-check reading the returned liveview");
    assert.ok(built.nvr.platform.accessories.includes(sceneSwitch), "the switch stayed, its re-check reading the returned liveview");

    await settle();

    assert.equal(logCount(built.logEntries, "info", "Plugin-specific liveviews have been detected. Enabling the security system accessory."), 1,
      "the reconcile that follows finds the security system standing and builds no other");
    assert.equal(logCount(built.logEntries, "info", "Configuring plugin-specific liveview switch: Scene."), 1, "and finds the switch standing and builds no other");
  });

  // A security system accessory Homebridge restores from its cache after its liveviews were deleted while Homebridge was down has no security system to remove it.
  // The reconcile finds it through the membership delta and removes it under the gate: nothing is scheduled while the controller is still unsettled from its start,
  // and the reconcile the stability sweep re-runs schedules it at the first stability.
  test("a security system accessory left by liveviews deleted while Homebridge was down is removed at the first stability", async () => {

    const ghost = makeTestAccessory("Security System", SECURITY_SEED);

    ghost.context.nvr = CONTROLLER_MAC;
    ghost.context.securityState = Characteristic.SecuritySystemCurrentState.AWAY_ARM;
    ghost.addService(new Service.SecuritySystem("Security System"));

    const built = buildLiveviews({ cachedAccessories: [ghost], liveviews: [makeLiveviewConfig({ id: "lv-scene", name: "Protect-Scene" })], unstable: true });

    activeController = built.controller;

    await settle();

    built.nvr.platform.clock.advance(REMOVAL_GRACE_MS);

    assert.ok(built.nvr.platform.accessories.includes(ghost), "the ghost stays while the controller is unsettled");

    built.nvr.restabilizeController();
    built.owner.configureLiveviews();

    assert.ok(loggedAt(built.logEntries, "info", "No plugin-specific liveviews found. Disabling the security system accessory"),
      "the first stability scheduled its removal");

    built.nvr.platform.clock.advance(REMOVAL_GRACE_MS);

    assert.equal(built.nvr.platform.accessories.includes(ghost), false, "the ghost left when the removal delay ended");
    assert.ok(built.api.calls.some((call) => (call.kind === "unregister") && call.accessories.includes(ghost)), "and it was unregistered from HomeKit");
  });

  // Each kind of accessory the liveviews owner derives carries the one marker the controller's device removal passes read, and each context write is saved once the
  // save window it opened closes.
  test("the switches and the security system carry the liveview-derived marker, and each context write is saved", async () => {

    const built = buildLiveviews({ liveviews: [ makeLiveviewConfig({ id: "lv-away", name: "Protect-Away" }),
      makeLiveviewConfig({ id: "lv-scene", name: "Protect-Scene" }) ] });

    activeController = built.controller;

    await settle();

    built.nvr.platform.clock.advance(ACCESSORY_SAVE_WINDOW_MS);

    const security = built.nvr.platform.accessories.find((accessory) => accessory.UUID === SECURITY_UUID);
    const sceneSwitch = built.nvr.platform.accessories.find((accessory) => accessory.UUID === liveviewUuid("Scene"));
    const saved = (accessory: ProtectAccessory): boolean => built.api.calls.some((call) => (call.kind === "update") && call.accessories.includes(accessory));

    assert.ok(security && sceneSwitch, "the security system and the Scene switch exist");
    assert.equal(security.context.liveviewDerived, true, "the security system carries the marker");
    assert.equal(sceneSwitch.context.liveviewDerived, true, "the switch carries the marker");
    assert.ok(saved(security), "the security system's context was saved");
    assert.ok(saved(sceneSwitch), "the switch's context was saved");
  });
});

describe("the liveviews owner's whole list restated per broker session", () => {

  test("a session restore restates the whole owned-switch list once, however often the liveviews reconfigured before it", async () => {

    const built = buildLiveviews({ liveviews: [ makeLiveviewConfig({ id: "lv-scene", name: "Protect-Scene" }),
      makeLiveviewConfig({ id: "lv-garden", name: "Protect-Garden" }) ] });

    try {

      await settle();

      const asBuilt = built.mqtt.publishedTo("/liveviews").length;

      built.owner.configureLiveviews();
      built.mqtt.connected = false;
      await settle();
      built.mqtt.connected = true;
      await settle();

      const restated = built.mqtt.publishedTo("/liveviews").slice(asBuilt);

      assert.equal(restated.length, 1, "the restore restates the whole list once, one registration standing behind the configure guard");
      assert.equal((JSON.parse(restated[0]?.payload.toString() ?? "[]") as unknown[]).length, 2, "the restatement carries the whole owned-switch list");
    } finally {

      built.controller.abort();
    }
  });

  // The whole-list statements among a run of recorded liveviews publishes: every entry carrying more than the one switch a switch change states.
  const wholeLists = (entries: TestMqttClient["published"]): TestMqttClient["published"] => {

    return entries.filter((entry) => (JSON.parse(entry.payload.toString()) as unknown[]).length > 1);
  };

  const scene = (): ProtectNvrLiveviewConfig => makeLiveviewConfig({ id: "lv-scene", name: "Protect-Scene" });

  for(const row of [ { liveviews: [ scene(), makeLiveviewConfig({ id: "lv-garden", name: "Protect-Garden" }) ], title: "two switches" },
    { liveviews: [scene()], title: "one switch whose restored state matches its cameras" } ]) {

    test("an owner built with " + row.title + " states no whole list as it is built", async () => {

      const built = buildLiveviews({ liveviews: row.liveviews });

      try {

        await settle();

        assert.equal(wholeLists(built.mqtt.publishedTo("/liveviews")).length, 0, "only a switch whose restored state differs is stated, as a one-element list");

        if(row.liveviews.length === 1) {

          assert.equal(built.mqtt.publishedTo("/liveviews").length, 0, "a switch whose restored state matches its cameras is not stated");
        }
      } finally {

        built.controller.abort();
      }
    });
  }

  test("an owner built while no session is held records nothing until the session starts, then the whole list once", async () => {

    const built = buildLiveviews({ disconnected: true, liveviews: [ makeLiveviewConfig({ id: "lv-scene", name: "Protect-Scene" }),
      makeLiveviewConfig({ id: "lv-garden", name: "Protect-Garden" }) ] });

    try {

      await settle();

      assert.equal(built.mqtt.published.length, 0, "the statements made with no session held are refused");

      built.mqtt.connected = true;
      await settle();

      assert.equal(built.mqtt.publishedTo("/liveviews").length, 1, "the first session states the list once");
      assert.equal(wholeLists(built.mqtt.publishedTo("/liveviews")).length, 1, "the first session's statement is the whole owned-switch list");
    } finally {

      built.controller.abort();
    }
  });

  test("a switch toggled while the session is down is restated in the whole list, with its new state, when the session returns", async () => {

    // Pre-seed the scene switch off, as the toggle row above does, so the construction-time sync leaves it off and the toggle is a genuine change.
    const sceneAccessory = makeTestAccessory("Controller Scene", liveviewSeed("Scene"));

    sceneAccessory.context.liveview = "Scene";
    sceneAccessory.context.liveviewState = false;
    sceneAccessory.context.nvr = CONTROLLER_MAC;
    sceneAccessory.addService(new Service.Switch("Controller Scene"));

    const built = buildLiveviews({ cachedAccessories: [sceneAccessory],
      liveviews: [ makeLiveviewConfig({ id: "lv-scene", name: "Protect-Scene" }), makeLiveviewConfig({ id: "lv-garden", name: "Protect-Garden" }) ] });

    try {

      await settle();

      const sceneSwitch = sceneAccessory.getService(Service.Switch);

      assert.ok(sceneSwitch, "the scene switch service exists");

      const asBuilt = built.mqtt.publishedTo("/liveviews").length;

      built.mqtt.connected = false;
      await settle();
      await triggerSet(sceneSwitch.getCharacteristic(Characteristic.On), true);
      await settle();

      assert.equal(built.mqtt.publishedTo("/liveviews").length, asBuilt, "the toggle made with no session held is refused");

      built.mqtt.connected = true;
      await settle();

      const restated = built.mqtt.publishedTo("/liveviews").slice(asBuilt).map((entry) => JSON.parse(entry.payload.toString()) as { name: string; state: unknown }[]);

      assert.equal(restated.length, 1, "the returning session hears the whole list once");
      assert.deepEqual(restated[0]?.find((entry) => entry.name === "Scene"), { name: "Scene", state: true }, "the whole list carries the toggled switch's new state");
    } finally {

      built.controller.abort();
    }
  });
});
