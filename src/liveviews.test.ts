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
 * The motion fanout is netted NON-VACUOUSLY: a member camera is seeded into configuredDevices whose ufp.id matches a Protect-Scene liveview's slots[].cameras, its
 * accessory carrying a PLAIN Service.Switch (liveviews reads the plain Switch here, not the SWITCH_MOTION_SENSOR-subtyped one the security fanout reads). The member's
 * detectMotion starts FALSY and the scene switch is pre-seeded liveviewState false so the construction-time setSwitchState early-returns (getSwitchState === target),
 * making the later toggle a genuine false->true change - liveviews continue()s a member already at the target (liveviews.ts:316), so a member at the target would no-op.
 */
import { Characteristic, Service, TestStateStore, makeLiveviewConfig, makeNvrConfig, makeProtectState, makeTestAccessory, makeTestNvr, settle }
  from "./testing.helpers.ts";
import type { TestAccessory, TestLogEntry, TestMqttClient, TestProtectNvr, TestService } from "./testing.helpers.ts";
import { afterEach, describe, test } from "node:test";
import type { ProtectDevices } from "./types.ts";
import { ProtectLiveviews } from "./devices/liveviews.ts";
import type { ProtectNvr } from "./nvr.ts";
import type { ProtectNvrLiveviewConfig } from "unifi-protect";
import assert from "node:assert/strict";

// The controller MAC the makeNvrConfig record carries; the MQTT topic scope and the self-created accessory UUIDs derive from it (the platform double's uuid generator is
// (seed) => "uuid:" + seed). A literal so a drift in the fixture MAC breaks loudly.
const CONTROLLER_MAC = "74ACB9FFFFFF";

// The deterministic UUIDs the owner composes: hap.uuid.generate(mac + ".Security") for the security accessory and hap.uuid.generate(mac + ".Liveview." + NAME) for a
// switch, run through the (seed) => "uuid:" + seed generator. A literal / composer rather than free-form derivations so a drift in the UUID composition breaks loudly.
const SECURITY_UUID = "uuid:" + CONTROLLER_MAC + ".Security";

// The deterministic liveview-switch UUID for a given view name (the owner uppercases the name into the UUID seed). Reused across the switch-create / orphan / reserved
// tests so the assertions read the same composition the owner does.
function liveviewUuid(name: string): string {

  return "uuid:" + CONTROLLER_MAC + ".Liveview." + name.toUpperCase();
}

// The device log wrapper formats every line through util.format into a single string parameter prefixed with the controller name, so a log assertion matches a substring
// of that one formatted parameter at the given level, mirroring the nvr-systeminfo / security-system suites.
function loggedAt(entries: TestLogEntry[], level: TestLogEntry["level"], substring: string): boolean {

  return entries.some((entry) => (entry.level === level) && String(entry.parameters[0]).includes(substring));
}

// Seed a member-camera double into the NVR's configuredDevices registry so the liveviews motion fanout resolves it via getDeviceById. The liveviews fanout reads the
// member's PLAIN Service.Switch and its accessory.context.detectMotion (and accessoryName for the log), so the seeded accessory carries a plain Switch; detectMotion
// starts FALSY by default. Returns the member accessory and its plain motion switch for assertion.
function seedMember(nvr: TestProtectNvr, options: { detectMotion?: boolean; id: string; name: string; uuid: string }):
{ accessory: TestAccessory; motionSwitch: TestService } {

  const accessory = makeTestAccessory(options.name, options.uuid);

  accessory.context["detectMotion"] = options.detectMotion ?? false;

  // The PLAIN (no-subtype) Switch the liveviews fanout reads - distinct from the SWITCH_MOTION_SENSOR-subtyped one the security fanout reads.
  const motionSwitch = accessory.addService(new Service.Switch(options.name + " Motion"));

  motionSwitch.updateCharacteristic(Characteristic.On, accessory.context["detectMotion"]);

  // The managed-device double the fanout resolves through getDeviceById: it reads accessory / accessoryName / context. Cast through ProtectDevices at the seam.
  const member = { accessory, accessoryName: options.name, ufp: { id: options.id } } as unknown as ProtectDevices;

  nvr.configuredDevices.set(accessory.UUID, member);

  return { accessory, motionSwitch };
}

// The reusable construction helper: build a REAL ProtectLiveviews against the harness doubles and drive the initial reconcile by calling configureLiveviews() on the
// CONSTRUCTED instance (NOT nvr.liveviews - the double has no liveviews member). makeProtectState seeds the liveviews with DISTINCT ids per the makeLiveviewConfig
// distinct-id discipline; the casts are confined to the construction seam exactly as the family suites do. Optional cachedAccessories are pushed onto the array BEFORE
// construction (orphan-removal / pre-seeded-switch-state fixtures). The returned controller is aborted in teardown (a ProtectBase owner has no per-accessory cleanup()).
function buildLiveviews(harnessOptions: { cachedAccessories?: TestAccessory[]; liveviews?: ProtectNvrLiveviewConfig[]; userOptions?: string[] } = {}): {
  apiCalls: ReturnType<typeof makeTestNvr>["apiCalls"]; controller: AbortController; logEntries: TestLogEntry[]; mqtt: TestMqttClient; nvr: TestProtectNvr;
  owner: ProtectLiveviews; store: TestStateStore;
} {

  const store = new TestStateStore(makeProtectState({ liveviews: harnessOptions.liveviews ?? [], nvr: makeNvrConfig() }));
  const { apiCalls, controller, logEntries, mqtt, nvr } = makeTestNvr({ mqtt: true, store, userOptions: harnessOptions.userOptions });

  // makeTestNvr was called with mqtt: true, so the recording double is present; a guard narrows Nullable<TestMqttClient> to the non-null type without an assertion or a
  // same-type cast (either of which the house lint preset forbids in opposite directions), and fails loudly if the opt-in ever stops installing the double.
  if(!mqtt) {

    throw new Error("The MQTT recording double was not installed despite mqtt: true.");
  }

  for(const cached of harnessOptions.cachedAccessories ?? []) {

    nvr.platform.accessories.push(cached);
  }

  const owner = new ProtectLiveviews(nvr as unknown as ProtectNvr);

  // Drive the initial reconcile explicitly on the constructed instance (the NVR seeds this once at startup in production; the observer handles every later edit).
  owner.configureLiveviews();

  return { apiCalls, controller, logEntries, mqtt, nvr, owner, store };
}

describe("real ProtectLiveviews construction and controller-owner wiring", () => {

  // The per-test controller, tracked so afterEach aborts whichever build the test made (the ProtectBase owner has no per-accessory cleanup; aborting the controller
  // behind nvr.signal is the teardown).
  let activeController: AbortController | undefined;

  afterEach(() => {

    activeController?.abort();
    activeController = undefined;
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

  test("removing the last Protect liveview unregisters the security accessory and logs the disable", async () => {

    const built = buildLiveviews({ liveviews: [makeLiveviewConfig({ id: "lv-away", name: "Protect-Away" })] });

    activeController = built.controller;

    await settle();

    assert.ok(built.nvr.platform.accessories.some((accessory) => accessory.UUID === SECURITY_UUID), "the security accessory exists after the initial reconcile");

    // Replace the liveviews with one that is NOT a Protect arm/off liveview, then reconcile via a pushLiveviews (the observer-driven path).
    built.store.pushLiveviews([makeLiveviewConfig({ id: "lv-scene", name: "Protect-Scene" })]);

    await settle();

    assert.equal(built.nvr.platform.accessories.some((accessory) => accessory.UUID === SECURITY_UUID), false,
      "the security accessory was spliced out when no Protect arm/off liveview remained");
    assert.ok(built.apiCalls.some((call) => (call.kind === "unregister") && call.accessories.some((candidate) => candidate.UUID === SECURITY_UUID)),
      "the platform double recorded an unregister call for the security accessory");
    assert.ok(loggedAt(built.logEntries, "info", "Disabling the security system accessory"), "the security-disable info line logged");
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

    // Precondition: the member starts off, and the scene switch (pre-seeded liveviewState false) reads off, so the toggle is a genuine change.
    assert.equal(member.accessory.context["detectMotion"], false, "the member camera starts with motion detection off");
    assert.equal(member.motionSwitch.getCharacteristic(Characteristic.On).value, false, "the member's plain motion switch starts off");

    const sceneSwitch = sceneAccessory.getService(Service.Switch);

    assert.ok(sceneSwitch, "the scene switch service exists");

    const publishedBefore = built.mqtt.published.length;

    // Toggle the scene switch on through its real onSet (HomeKit's set path).
    await sceneSwitch.getCharacteristic(Characteristic.On).triggerSet(true);

    // The member FLIPPED on (the discriminating assertion: false -> true) and its context updated.
    assert.equal(member.motionSwitch.getCharacteristic(Characteristic.On).value, true, "the member's plain motion switch flipped on for the scene");
    assert.equal(member.accessory.context["detectMotion"], true, "the member's detectMotion context flipped to true");
    assert.ok(loggedAt(built.logEntries, "info", "Scene -> Scene Camera: Motion detection enabled."),
      "the per-member motion-enabled line fired with the scene and member");

    // The scene publish carries the liveview name and the new state.
    assert.ok(built.mqtt.published.slice(publishedBefore).some((published) => (published.topic === CONTROLLER_MAC + "/liveviews") && published.message.includes("Scene")),
      "the accepted scene toggle published the liveview state on the controller-scoped topic");
  });

  test("the liveviews MQTT GET composes the controller-MAC topic and returns the JSON of switch states", async () => {

    const built = buildLiveviews({ liveviews: [makeLiveviewConfig({ id: "lv-scene", name: "Protect-Scene" })] });

    activeController = built.controller;

    await settle();

    const subscription = built.mqtt.subscriptions.find((entry) => (entry.kind === "get") && (entry.topic === CONTROLLER_MAC + "/liveviews"));

    assert.ok(subscription?.getValue, "the liveviews GET subscription composed the controller-MAC topic and captured a getValue handler");

    // The handler returns the JSON array of { name, state } for every liveview switch. The seeded Protect-Scene switch is present.
    const payload = JSON.parse(subscription.getValue()) as { name: string; state: boolean }[];

    assert.ok(payload.some((entry) => entry.name === "Scene"), "the GET handler stringifies the liveview switch states, carrying the Scene switch");
    assert.equal(subscription.init?.signal, built.nvr.signal, "the GET registration carries the controller lifetime signal");
  });

  test("the liveviews MQTT SET parses a JSON payload to update the matching switch, and bad JSON logs the error", async () => {

    const built = buildLiveviews({ liveviews: [makeLiveviewConfig({ id: "lv-scene", name: "Protect-Scene" })] });

    activeController = built.controller;

    await settle();

    const subscription = built.mqtt.subscriptions.find((entry) => (entry.kind === "set") && (entry.topic === CONTROLLER_MAC + "/liveviews"));

    assert.ok(subscription?.setValue, "the liveviews SET subscription captured a setValue handler");

    const sceneAccessory = built.nvr.platform.accessories.find((accessory) => accessory.UUID === liveviewUuid("Scene"));
    const sceneSwitch = sceneAccessory?.getService(Service.Switch);

    assert.ok(sceneSwitch, "the Scene switch accessory and its Switch service exist");

    // The switch starts On true (construction initialized it from the default liveviewState), so SET it to FALSE - a genuine change - so suppressing the update would be
    // caught rather than coinciding with the already-current value.
    assert.equal(sceneSwitch.getCharacteristic(Characteristic.On).value, true, "the Scene switch starts on after construction");

    // A well-formed payload updates the matching switch's On characteristic to the requested state and logs the MQTT-update confirmation.
    await subscription.setValue(JSON.stringify([{ name: "Scene", state: false }]), JSON.stringify([{ name: "Scene", state: false }]));

    assert.equal(sceneSwitch.getCharacteristic(Characteristic.On).value, false, "the SET flipped the matching liveview switch On characteristic to the requested state");
    assert.ok(loggedAt(built.logEntries, "info", "Liveview scene updated via MQTT: Scene."), "the MQTT-update info line logged");

    // Bad JSON logs the invalid-JSON error and changes nothing.
    await subscription.setValue("not json", "not json");

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
});
