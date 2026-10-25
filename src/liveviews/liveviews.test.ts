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
 *   registerPlatformAccessories (recorded into the platform double's apiCalls + platform.accessories). Teardown is aborting the AbortController behind nvr.signal.
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
import { Characteristic, Service, TestStateStore, makeProtectState, makeTestAccessory } from "../testing.helpers.ts";
import type { TestAccessory, TestService } from "../testing.helpers.ts";
import type { TestLogEntry, TestMqttClient } from "homebridge-plugin-utils/testing";
import { afterEach, describe, test } from "node:test";
import { logCount, loggedAt, settle } from "homebridge-plugin-utils/testing";
import { makeNvrConfig, makeTestNvr } from "../nvr/testing.helpers.ts";
import { PROTECT_DEVICE_REMOVAL_DELAY_INTERVAL } from "../settings.ts";
import type { ProtectDevices } from "../types.ts";
import { ProtectLiveviews } from "./liveviews.ts";
import type { ProtectNvr } from "../nvr/nvr.ts";
import type { ProtectNvrLiveviewConfig } from "unifi-protect";
import { ProtectReservedNames } from "../types.ts";
import type { TestProtectNvr } from "../nvr/testing.helpers.ts";
import assert from "node:assert/strict";
import { makeLiveviewConfig } from "../devices/testing.helpers.ts";

// The controller MAC the makeNvrConfig record carries; the MQTT topic scope and the self-created accessory UUIDs derive from it (the platform double's uuid generator is
// (seed) => "uuid:" + seed). A literal so a drift in the fixture MAC breaks loudly.
const CONTROLLER_MAC = "74ACB9FFFFFF";

// The deterministic UUIDs the owner composes: hap.uuid.generate(mac + ".Security") for the security accessory and hap.uuid.generate(mac + ".Liveview." + NAME) for a
// switch, run through the (seed) => "uuid:" + seed generator. A literal / composer rather than free-form derivations so a drift in the UUID composition breaks loudly.
const SECURITY_UUID = "uuid:" + CONTROLLER_MAC + ".Security";

// The removal delay a liveview-derived accessory waits out once the removal gate schedules it: the user's DelayDeviceRemoval interval at its default, in milliseconds
// on the controller double's test clock.
const REMOVAL_GRACE_MS = PROTECT_DEVICE_REMOVAL_DELAY_INTERVAL * 1000;

// The deterministic liveview-switch UUID for a given view name (the owner uppercases the name into the UUID seed). Reused across the switch-create / orphan / reserved
// tests so the assertions read the same composition the owner does.
function liveviewUuid(name: string): string {

  return "uuid:" + CONTROLLER_MAC + ".Liveview." + name.toUpperCase();
}

// Seed a member-camera double into the NVR's configuredDevices registry so the liveviews motion fanout resolves it via getDeviceById. The fanout targets the member's
// SWITCH_MOTION_SENSOR-subtyped Switch and its accessory.context.detectMotion (and accessoryName for the log). The accessory carries that subtyped switch PLUS a plain,
// unsubtyped decoy Switch sitting FIRST: a scene toggle must land on the subtyped switch alone, so the decoy's untouched state is what proves the subtyped lookup, not a
// plain one. detectMotion starts FALSY by default. Returns the member accessory, its plain decoy switch, and its subtyped motion switch for assertion.
function seedMember(nvr: TestProtectNvr, options: { detectMotion?: boolean; id: string; name: string; uuid: string }):
{ accessory: TestAccessory; decoySwitch: TestService; motionSwitch: TestService } {

  const accessory = makeTestAccessory(options.name, options.uuid);

  accessory.context["detectMotion"] = options.detectMotion ?? false;

  // The plain, unsubtyped decoy Switch added FIRST - the service getService(Service.Switch) resolves to. A scene toggle must NEVER touch it; the subtyped lookup is what
  // keeps it untouched.
  const decoySwitch = accessory.addService(new Service.Switch(options.name + " Decoy"));

  decoySwitch.updateCharacteristic(Characteristic.On, false);

  // The SWITCH_MOTION_SENSOR-subtyped Switch the liveviews fanout targets, seeded from the member's detectMotion.
  const motionSwitch = accessory.addService(new Service.Switch(options.name + " Motion", ProtectReservedNames.SWITCH_MOTION_SENSOR));

  motionSwitch.updateCharacteristic(Characteristic.On, accessory.context["detectMotion"]);

  // The managed-device double the fanout resolves through getDeviceById, which now matches on the non-throwing protectId: it reads accessory / accessoryName / context.
  // Cast through ProtectDevices at the construction boundary.
  const member = { accessory, accessoryName: options.name, protectId: options.id, ufp: { id: options.id } } as unknown as ProtectDevices;

  nvr.configuredDevices.set(accessory.UUID, member);

  return { accessory, decoySwitch, motionSwitch };
}

// The reusable construction helper: build a REAL ProtectLiveviews against the harness doubles and drive the initial reconcile by calling configureLiveviews() on the
// CONSTRUCTED instance (NOT nvr.liveviews - the double has no liveviews member). makeProtectState seeds the liveviews with DISTINCT ids per the makeLiveviewConfig
// distinct-id discipline; the casts are confined to the construction boundary exactly as the family suites do. Optional cachedAccessories are pushed onto the array
// BEFORE construction (orphan-removal / pre-seeded-switch-state fixtures), and an unstable controller leaves good state before the initial reconcile, the posture of a
// controller that has only just come up. The returned controller is aborted in teardown: the fixture tears down through the controller it built, the scope that owns
// every registration the test created.
function buildLiveviews(harnessOptions: { cachedAccessories?: TestAccessory[]; disconnected?: boolean; liveviews?: ProtectNvrLiveviewConfig[]; mac?: string;
  sharedPlatform?: { accessories: TestAccessory[]; apiCalls: ReturnType<typeof makeTestNvr>["apiCalls"] }; unstable?: boolean; userOptions?: string[]; } = {}): {
  apiCalls: ReturnType<typeof makeTestNvr>["apiCalls"]; controller: AbortController; logEntries: readonly TestLogEntry[]; mqtt: TestMqttClient; nvr: TestProtectNvr;
  owner: ProtectLiveviews; store: TestStateStore;
} {

  const store = new TestStateStore(makeProtectState({ liveviews: harnessOptions.liveviews ?? [], nvr: makeNvrConfig({ mac: harnessOptions.mac }) }));
  const { apiCalls, controller, logEntries, mqtt, nvr } = makeTestNvr({ mqtt: true, sharedPlatform: harnessOptions.sharedPlatform, store,
    userOptions: harnessOptions.userOptions });

  // makeTestNvr was called with mqtt: true, so the recording double is present; a guard narrows Nullable<TestMqttClient> to the non-null type without an assertion or a
  // same-type cast (either of which the house lint preset forbids in opposite directions), and fails loudly if the opt-in ever stops installing the double.
  if(!mqtt) {

    throw new Error("The MQTT recording double was not installed despite mqtt: true.");
  }

  for(const cached of harnessOptions.cachedAccessories ?? []) {

    nvr.platform.accessories.push(cached);
  }

  // A disconnected double is the production startup shape: the liveviews owner is built before the broker acknowledges the first session.
  mqtt.connected = !(harnessOptions.disconnected ?? false);

  if(harnessOptions.unstable) {

    nvr.pushControllerStability(false);
  }

  const owner = new ProtectLiveviews(nvr as unknown as ProtectNvr);

  // Drive the initial reconcile explicitly on the constructed instance (the NVR seeds this once at startup in production; the observer handles every later edit).
  owner.configureLiveviews();

  return { apiCalls, controller, logEntries, mqtt, nvr, owner, store };
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
    assert.ok(built.apiCalls.some((call) => (call.kind === "register") && call.accessories.includes(security)), "the platform double recorded a register call for it");
    assert.ok(loggedAt(built.logEntries, "info", "Enabling the security system accessory."), "the security-enable info line logged");

    // The sibling was constructed (its configureDevice ran), proven by the SecuritySystem service materializing on the security accessory.
    assert.ok(security.getService(Service.SecuritySystem), "the ProtectSecuritySystem sibling was constructed - its SecuritySystem service exists");

    // The wiring proof that updateDevice RAN: the sibling's TargetState setProps landed non-empty (its sole updateDevice effect). We assert only that it landed, NOT the
    // full validValues logic (security-system.test.ts owns that), keeping the two-layer boundary.
    const validValues = security.getService(Service.SecuritySystem)?.getCharacteristic(Characteristic.SecuritySystemTargetState).props?.validValues;

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
    assert.ok(built.apiCalls.some((call) => (call.kind === "unregister") && call.accessories.some((candidate) => candidate.UUID === SECURITY_UUID)),
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

    // Re-add the arm liveview: the owner builds a FRESH security system whose constructor subscribes anew. Exactly one securitysystem get registration is now live (the
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
    assert.ok(built.apiCalls.some((call) => (call.kind === "register") && call.accessories.includes(switchAccessory)),
      "the platform double recorded a register call for it");
    assert.ok(switchAccessory.getService(Service.Switch), "the switch accessory carries a Switch service");
    assert.ok(loggedAt(built.logEntries, "info", "Configuring plugin-specific liveview switch: Scene."), "the configure-switch info line logged the view name");
  });

  test("a reserved Protect-Away/Home/Night/Off name creates NO liveview switch (it is reserved for the security system)", async () => {

    const built = buildLiveviews({ liveviews: [makeLiveviewConfig({ id: "lv-home", name: "Protect-Home" })] });

    activeController = built.controller;

    await settle();

    // Protect-Home matches the security-system regex and the switch regex's negative lookahead excludes it, so no liveview switch accessory is created.
    const switchAccessory = built.nvr.platform.accessories.find((accessory) => accessory.UUID === liveviewUuid("Home"));

    assert.equal(switchAccessory, undefined, "a reserved arm-state name creates no liveview switch accessory");
    assert.equal(built.apiCalls.some((call) => (call.kind === "register") && call.accessories.some((candidate) => candidate.UUID === liveviewUuid("Home"))),
      false, "no switch register call was recorded for the reserved name");
  });

  test("an orphan liveview switch (its liveview removed/renamed) is unregistered and logs the removal", async () => {

    // Pre-seed a cached switch accessory whose context.liveview ("Ghost") matches no current liveview, so the orphan-removal path removes one rather than no-opping.
    const orphan = makeTestAccessory("Ghost Liveview", liveviewUuid("Ghost"));

    orphan.context["liveview"] = "Ghost";
    orphan.context["nvr"] = CONTROLLER_MAC;
    orphan.addService(new Service.Switch("Ghost"));

    const built = buildLiveviews({ cachedAccessories: [orphan], liveviews: [makeLiveviewConfig({ id: "lv-scene", name: "Protect-Scene" })] });

    activeController = built.controller;

    await settle();

    // The removal gate scheduled the orphan's removal, which lands once the removal delay ends.
    assert.ok(built.nvr.platform.accessories.includes(orphan), "the orphan switch stays through the removal delay");

    built.nvr.platform.clock.advance(REMOVAL_GRACE_MS);

    assert.equal(built.nvr.platform.accessories.includes(orphan), false, "the orphan switch accessory was spliced out of the platform array");
    assert.ok(built.apiCalls.some((call) => (call.kind === "unregister") && call.accessories.includes(orphan)),
      "the platform double recorded an unregister call for the orphan");
    assert.ok(loggedAt(built.logEntries, "info", "Removing plugin-specific liveview switch: Ghost."), "the orphan-removal info line logged the stale view name");
  });

  test("toggling a liveview scene switch fans motion onto its member camera (flips false->true) and publishes - NON-VACUOUS", async () => {

    // Pre-seed the scene switch accessory with liveviewState false so the construction-time setSwitchState(false) early-returns (getSwitchState === target), keeping the
    // later toggle a genuine false->true change. The member's detectMotion starts FALSY so the fanout's continue-when-already-at-target guard does not skip it.
    const sceneAccessory = makeTestAccessory("Controller Scene", liveviewUuid("Scene"));

    sceneAccessory.context["liveview"] = "Scene";
    sceneAccessory.context["liveviewState"] = false;
    sceneAccessory.context["nvr"] = CONTROLLER_MAC;
    sceneAccessory.addService(new Service.Switch("Controller Scene"));

    const built = buildLiveviews({

      cachedAccessories: [sceneAccessory],
      liveviews: [makeLiveviewConfig({ cameras: ["camera-scene"], id: "lv-scene", name: "Protect-Scene" })]
    });

    activeController = built.controller;

    const member = seedMember(built.nvr, { detectMotion: false, id: "camera-scene", name: "Scene Camera", uuid: "uuid:scene-camera" });

    await settle();

    // Precondition: the member starts off (both its subtyped motion switch and its plain decoy read off), and the scene switch (pre-seeded liveviewState false) reads
    // off, so the toggle is a genuine change.
    assert.equal(member.accessory.context["detectMotion"], false, "the member camera starts with motion detection off");
    assert.equal(member.motionSwitch.getCharacteristic(Characteristic.On).value, false, "the member's subtyped motion switch starts off");
    assert.equal(member.decoySwitch.getCharacteristic(Characteristic.On).value, false, "the member's plain decoy switch starts off");

    const sceneSwitch = sceneAccessory.getService(Service.Switch);

    assert.ok(sceneSwitch, "the scene switch service exists");

    const publishedBefore = built.mqtt.published.length;

    // Toggle the scene switch on through its real onSet (HomeKit's set path).
    await sceneSwitch.getCharacteristic(Characteristic.On).triggerSet(true);

    // The member FLIPPED on (the discriminating assertion: false -> true) and its context updated. The write landed on the SUBTYPED switch; the plain decoy stayed off -
    // the getServiceById(Switch, SWITCH_MOTION_SENSOR) lookup is what keeps the decoy untouched (a plain getService would have flipped the decoy instead).
    assert.equal(member.motionSwitch.getCharacteristic(Characteristic.On).value, true, "the member's subtyped motion switch flipped on for the scene");
    assert.equal(member.decoySwitch.getCharacteristic(Characteristic.On).value, false, "the member's plain decoy switch was left untouched");
    assert.equal(member.accessory.context["detectMotion"], true, "the member's detectMotion context flipped to true");
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
    const member = seedMember(built.nvr, { detectMotion: false, id: "camera-scene", name: "Scene Camera", uuid: "uuid:scene-camera" });

    await settle();

    const subscription = built.mqtt.subscriptions.find((entry) => (entry.kind === "set") && (entry.topic === CONTROLLER_MAC + "/liveviews/set"));

    assert.ok(subscription, "the liveviews SET subscription composed the controller-MAC topic");
    assert.equal(member.accessory.context["detectMotion"], false, "the member camera starts with motion detection off");

    const publishedBefore = built.mqtt.published.length;

    // A well-formed payload drives the scene through the switch's own onSet (setCharacteristic), which fans motion onto the member cameras exactly as a HomeKit tap does.
    // The set is fire-and-forget, so settle before asserting the downstream effects. A status-only updateCharacteristic never runs the handler, so this test goes red
    // on that mutation - the scene never reaches the member cameras.
    await built.mqtt.invokeSet(CONTROLLER_MAC + "/liveviews/set", JSON.stringify([{ name: "Scene", state: true }]));

    await settle();

    assert.equal(member.accessory.context["detectMotion"], true, "the MQTT-commanded scene flipped the member's detectMotion on");
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

    // Controller B's distinct MAC and the deterministic UUID of its Other switch (the owner uppercases the view name into the seed the (seed) => "uuid:" + seed
    // generator runs).
    const MAC_B = "74ACB9AAAAAA";
    const otherSwitchUuid = "uuid:" + MAC_B + ".Liveview.OTHER";

    // Controller A owns a Protect-Scene liveview; controller B owns a Protect-Other liveview. They share ONE platform accessories array and registration recorder,
    // mirroring production's single ProtectPlatform, but carry DISTINCT controller MACs so each owner scopes its switches by the context MAC.
    const controllerA = buildLiveviews({ liveviews: [makeLiveviewConfig({ id: "lv-scene", name: "Protect-Scene" })] });

    activeController = controllerA.controller;

    const controllerB = buildLiveviews({ liveviews: [makeLiveviewConfig({ id: "lv-other", name: "Protect-Other" })], mac: MAC_B,
      sharedPlatform: { accessories: controllerA.nvr.platform.accessories, apiCalls: controllerA.apiCalls } });

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
    assert.equal(controllerA.apiCalls.some((call) => (call.kind === "unregister") && call.accessories.some((candidate) => candidate.UUID === otherSwitchUuid)), false,
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
    const ghostOne = makeTestAccessory("Ghost One", liveviewUuid("GhostOne"));

    ghostOne.context["liveview"] = "GhostOne";
    ghostOne.context["nvr"] = CONTROLLER_MAC;
    ghostOne.addService(new Service.Switch("Ghost One"));

    const ghostTwo = makeTestAccessory("Ghost Two", liveviewUuid("GhostTwo"));

    ghostTwo.context["liveview"] = "GhostTwo";
    ghostTwo.context["nvr"] = CONTROLLER_MAC;
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

  // A switch whose liveview is removed leaves through the removal gate rather than at once: it stays through the user's removal delay with its MQTT get and set still
  // answering, and leaves when the delay ends with its liveview still gone. Its name leaves with it, so the liveview's return builds the switch anew.
  test("a switch whose liveview is removed keeps answering MQTT through the removal delay and leaves when it ends", async () => {

    const built = buildLiveviews({ liveviews: [makeLiveviewConfig({ id: "lv-scene", name: "Protect-Scene" })] });

    activeController = built.controller;

    await settle();

    const sceneSwitch = built.nvr.platform.accessories.find((accessory) => accessory.UUID === liveviewUuid("Scene"));

    assert.ok(sceneSwitch, "the Scene switch exists");

    built.store.pushLiveviews([makeLiveviewConfig({ id: "lv-garden", name: "Protect-Garden" })]);

    await settle();

    assert.ok(loggedAt(built.logEntries, "info", "Removing plugin-specific liveview switch: Scene."), "the removal is narrated as it is scheduled");
    assert.ok(built.nvr.platform.accessories.includes(sceneSwitch), "the switch stays through the removal delay");

    const payload = JSON.parse(await built.mqtt.invokeGet(CONTROLLER_MAC + "/liveviews/get") ?? "[]") as { name: string }[];

    assert.ok(payload.some((entry) => entry.name === "Scene"), "the MQTT get still answers for the switch through the removal delay");

    await built.mqtt.invokeSet(CONTROLLER_MAC + "/liveviews/set", JSON.stringify([{ name: "Scene", state: true }]));
    await settle();

    assert.ok(loggedAt(built.logEntries, "info", "Liveview scene updated via MQTT: Scene."), "the MQTT set still reaches the switch through the removal delay");

    built.nvr.platform.clock.advance(REMOVAL_GRACE_MS);

    assert.equal(built.nvr.platform.accessories.includes(sceneSwitch), false, "the switch left when the removal delay ended with its liveview still gone");

    built.store.pushLiveviews([ makeLiveviewConfig({ id: "lv-garden", name: "Protect-Garden" }), makeLiveviewConfig({ id: "lv-scene", name: "Protect-Scene" }) ]);

    await settle();

    assert.ok(built.nvr.platform.accessories.some((accessory) => accessory.UUID === liveviewUuid("Scene")), "the returning liveview built its switch anew");
  });

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

  // A security system accessory Homebridge restores from its cache after its liveviews were deleted while Homebridge was down has no security system to remove it.
  // The reconcile finds it through the membership delta and removes it under the gate: nothing is scheduled while the controller is still unsettled from its start,
  // and the reconcile the stability sweep re-runs schedules it at the first stability.
  test("a security system accessory left by liveviews deleted while Homebridge was down is removed at the first stability", async () => {

    const ghost = makeTestAccessory("Security System", SECURITY_UUID);

    ghost.context["nvr"] = CONTROLLER_MAC;
    ghost.context["securityState"] = Characteristic.SecuritySystemCurrentState.AWAY_ARM;
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
    assert.ok(built.apiCalls.some((call) => (call.kind === "unregister") && call.accessories.includes(ghost)), "and it was unregistered from HomeKit");
  });

  // Each kind of accessory the liveviews owner derives carries the one marker the controller's device removal passes read, and each context write is saved.
  test("the switches and the security system carry the liveview-derived marker, and each context write is saved", async () => {

    const built = buildLiveviews({ liveviews: [ makeLiveviewConfig({ id: "lv-away", name: "Protect-Away" }),
      makeLiveviewConfig({ id: "lv-scene", name: "Protect-Scene" }) ] });

    activeController = built.controller;

    await settle();

    const security = built.nvr.platform.accessories.find((accessory) => accessory.UUID === SECURITY_UUID);
    const sceneSwitch = built.nvr.platform.accessories.find((accessory) => accessory.UUID === liveviewUuid("Scene"));
    const saved = (accessory: TestAccessory): boolean => built.apiCalls.some((call) => (call.kind === "update") && call.accessories.includes(accessory));

    assert.ok(security && sceneSwitch, "the security system and the Scene switch exist");
    assert.equal(security.context["liveviewDerived"], true, "the security system carries the marker");
    assert.equal(sceneSwitch.context["liveviewDerived"], true, "the switch carries the marker");
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
    const sceneAccessory = makeTestAccessory("Controller Scene", liveviewUuid("Scene"));

    sceneAccessory.context["liveview"] = "Scene";
    sceneAccessory.context["liveviewState"] = false;
    sceneAccessory.context["nvr"] = CONTROLLER_MAC;
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
      await sceneSwitch.getCharacteristic(Characteristic.On).triggerSet(true);
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
