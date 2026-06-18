/* Copyright(C) 2019-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * security-system.test.ts: The security-system half of the coupled controller-owner pair - behavior tests over a REAL constructed ProtectSecuritySystem.
 *
 * ProtectSecuritySystem is the second of the two coupled controller owners (liveviews owns its lifecycle and value-constructs it). This suite is the family unit of the
 * two-layer split: it constructs a REAL ProtectSecuritySystem(nvr, accessory) through the makeTestNvr double and nets its FULL public surface behavior-first - the
 * bespoke controller-branded configureInfo (including the unconditional HardwareRevision write), the SecuritySystem service state machine (current/target onGet/onSet
 * from the accessory's saved securityState), the feature-gated alarm switch, the updateDevice arm-states reconcile (the setProps validValues plus both <2-states no-call
 * returns), the MQTT get/set state map, the cross-camera setSecurityState motion fanout, and setSecurityAlarm. The sibling liveviews suite (liveviews.test.ts) nets only
 * the WIRING (that this class is created/destroyed on the Protect-liveview gate and updateDevice is called) and deliberately does NOT re-net these internals.
 *
 * The shape DIFFERS from the device families and this suite respects every departure (the controller-owner shape established by nvr-systeminfo.test.ts):
 *
 * - It extends ProtectBase, not ProtectDevice: the ctor is (nvr, accessory) and it RECEIVES its accessory (it does not self-create). It has ZERO self-observers - it is
 *   driven entirely by the liveviews owner (updateDevice), HomeKit onSet, and MQTT set - so this suite nets no observer reaction and asserts store.observerCount === 0.
 *   Teardown is aborting the AbortController behind nvr.signal (the controller terminal-shutdown signal), not a per-accessory cleanup().
 * - It publishes NOTHING on the hbup:observer:wake diagnostics channel, so this suite does NOT reuse the viewer / sensor wake-count scaffold.
 * - nvr.ufp reads THROUGH the store (the harness's read-through client.nvr.config getter), so the opt-in hardwareRevision seeded into the store's nvr slice is what the
 *   configureInfo HardwareRevision write reads - making that write non-vacuous.
 *
 * Two non-vacuity disciplines load-bearing here. First, the alarm-switch feature gate (Enable.SecuritySystem.Alarm, default off): the with-feature test passes the exact
 * string and HARD-asserts the alarm Switch exists FIRST, paired with a without-feature absence test. Second, the motion fanout is CHANGE-GATED (security-system.ts:410
 * writes only when detectMotion !== targetState), so the member's context.detectMotion is seeded FALSY before driving toward enabled, and the test asserts the switch
 * FLIPPED false->true and the "...Motion detection enabled." log FIRED - not merely that detectMotion ended true.
 */
import { Characteristic, Service, TestStateStore, makeLiveviewConfig, makeNvrConfig, makeProtectState, makeTestAccessory, makeTestNvr, settle }
  from "./testing.helpers.ts";
import type { ProtectAccessory, ProtectDevices } from "./types.ts";
import type { TestAccessory, TestLogEntry, TestMqttClient, TestProtectNvr, TestService } from "./testing.helpers.ts";
import { afterEach, describe, test } from "node:test";
import type { ProtectNvr } from "./nvr.ts";
import type { ProtectNvrLiveviewConfig } from "unifi-protect";
import { ProtectReservedNames } from "./types.ts";
import { ProtectSecuritySystem } from "./devices/security-system.ts";
import assert from "node:assert/strict";

// The controller MAC the makeNvrConfig record carries, and the MQTT topic scope (the mqttId is the controller MAC for a ProtectBase owner). A literal so a drift in the
// fixture MAC breaks loudly rather than silently following along.
const CONTROLLER_MAC = "74ACB9FFFFFF";

// The named HAP arm-state constants, read off the double's markers so the assertions and the production share one source. SecuritySystemCurrentState carries five
// distinct values; SecuritySystemTargetState four (DISARM === DISARMED === 3 under HAP-distinct names).
const CurrentState = Characteristic.SecuritySystemCurrentState;
const TargetState = Characteristic.SecuritySystemTargetState;

// The device log wrapper formats every line through util.format into a single string parameter prefixed with the controller name (for example "Test Controller:
// Enabling the security alarm switch..."), so a log assertion matches a substring of that one formatted parameter at the given level, mirroring the sibling suites.
function loggedAt(entries: TestLogEntry[], level: TestLogEntry["level"], substring: string): boolean {

  return entries.some((entry) => (entry.level === level) && String(entry.parameters[0]).includes(substring));
}

// Seed a member-camera double into the NVR's configuredDevices registry AND the platform accessories array so the cross-camera motion fanout resolves it. The fanout
// resolves each platform accessory to nvr.configuredDevices.get(accessory.UUID)?.ufp, gates on accessory.context.nvr === the controller MAC, matches the member by
// ufp.id against the liveview's slots[].cameras, then flips its SWITCH_MOTION_SENSOR-subtyped Switch and context.detectMotion. The member's detectMotion is seeded FALSY
// by default so a drive toward enabled is a genuine change (the write is change-gated). Returns the member accessory and its motion switch for assertion.
function seedMember(nvr: TestProtectNvr, options: { detectMotion?: boolean; id: string; name: string; uuid: string }):
{ accessory: TestAccessory; motionSwitch: TestService } {

  const accessory = makeTestAccessory(options.name, options.uuid);

  accessory.context["nvr"] = CONTROLLER_MAC;
  accessory.context["detectMotion"] = options.detectMotion ?? false;

  // The member's motion switch is the SWITCH_MOTION_SENSOR-subtyped Switch the security fanout reads (distinct from the security accessory's own plain alarm Switch).
  const motionSwitch = accessory.addService(new Service.Switch(options.name + " Motion", ProtectReservedNames.SWITCH_MOTION_SENSOR));

  motionSwitch.updateCharacteristic(Characteristic.On, accessory.context["detectMotion"]);
  nvr.platform.accessories.push(accessory);

  // The managed-device double the fanout resolves through configuredDevices: the security path reads only ufp.id. Cast through ProtectDevices at the construction seam.
  const member = { accessory, accessoryName: options.name, ufp: { id: options.id } } as unknown as ProtectDevices;

  nvr.configuredDevices.set(accessory.UUID, member);

  return { accessory, motionSwitch };
}

// The reusable construction helper: build a REAL ProtectSecuritySystem against the harness doubles. makeProtectState seeds the Protect-* liveviews (DISTINCT ids per the
// makeLiveviewConfig distinct-id discipline) and the nvr record carrying the opt-in hardwareRevision so configureInfo's HardwareRevision write reads a real value; the
// casts are confined to the construction seam exactly as the family suites do. The owner RECEIVES its accessory (it does not self-create), so the test supplies one. The
// returned controller is the AbortController behind nvr.signal, aborted in teardown (a ProtectBase owner has no per-accessory cleanup()).
function buildSecuritySystem(
  harnessOptions: { accessory?: TestAccessory; hardwareRevision?: string; liveviews?: ProtectNvrLiveviewConfig[]; userOptions?: string[] } = {}): {
  accessory: TestAccessory; controller: AbortController; logEntries: TestLogEntry[]; mqtt: TestMqttClient; nvr: TestProtectNvr; owner: ProtectSecuritySystem;
  store: TestStateStore;
} {

  const nvrConfig = makeNvrConfig({ hardwareRevision: harnessOptions.hardwareRevision ?? "1.0.0" });
  const store = new TestStateStore(makeProtectState({ liveviews: harnessOptions.liveviews ?? [], nvr: nvrConfig }));
  const { controller, logEntries, mqtt, nvr } = makeTestNvr({ mqtt: true, store, userOptions: harnessOptions.userOptions });
  const accessory = harnessOptions.accessory ?? makeTestAccessory("Security System", "uuid:" + CONTROLLER_MAC + ".Security");

  // makeTestNvr was called with mqtt: true, so the recording double is present; a guard narrows Nullable<TestMqttClient> to the non-null type without an assertion or a
  // same-type cast (either of which the house lint preset forbids in opposite directions), and fails loudly if the opt-in ever stops installing the double.
  if(!mqtt) {

    throw new Error("The MQTT recording double was not installed despite mqtt: true.");
  }

  const owner = new ProtectSecuritySystem(nvr as unknown as ProtectNvr, accessory as unknown as ProtectAccessory);

  return { accessory, controller, logEntries, mqtt, nvr, owner, store };
}

describe("real ProtectSecuritySystem construction and controller-owner behavior", () => {

  // The per-test controller, tracked so afterEach aborts whichever build the test made (the ProtectBase owner has no per-accessory cleanup; aborting the controller
  // behind nvr.signal is the teardown).
  let activeController: AbortController | undefined;

  afterEach(() => {

    activeController?.abort();
    activeController = undefined;
  });

  test("construction materializes the SecuritySystem service, initializes current/target from the saved state, and writes the controller-branded info", async () => {

    const built = buildSecuritySystem();

    activeController = built.controller;

    await settle();

    // HARD-assert the SecuritySystem service exists FIRST (non-optional) - the marker-first construction discipline.
    const security = built.accessory.getService(Service.SecuritySystem);

    assert.ok(security, "the SecuritySystem service was acquired at construction");

    // The default saved state is STAY_ARM (configureDevice seeds it when context.securityState is undefined), so current initializes to STAY_ARM and target to STAY_ARM.
    assert.equal(security.getCharacteristic(CurrentState).value, CurrentState.STAY_ARM, "CurrentState initialized to the saved STAY_ARM default");
    assert.equal(security.getCharacteristic(TargetState).value, TargetState.STAY_ARM, "TargetState initialized to the saved STAY_ARM default");

    // The current-state onGet reads through the saved state (alarm-aware); with no alarm it returns the saved STAY_ARM.
    assert.equal(await security.getCharacteristic(CurrentState).triggerGet(), CurrentState.STAY_ARM, "the CurrentState onGet reads through the saved securityState");

    // The bespoke configureInfo wrote the controller-branded identity; HardwareRevision is non-vacuous via the opt-in hardwareRevision.
    const info = built.accessory.getService(Service.AccessoryInformation);

    assert.equal(info?.getCharacteristic(Characteristic.Manufacturer).value, "github.com/hjdhjd", "configureInfo wrote the github.com/hjdhjd Manufacturer");
    assert.equal(info?.getCharacteristic(Characteristic.Model).value, "UniFi Protect Liveview Security System", "configureInfo wrote the liveview security-system Model");
    assert.equal(info?.getCharacteristic(Characteristic.SerialNumber).value, CONTROLLER_MAC + ".Security", "configureInfo wrote the mac+.Security SerialNumber");
    assert.equal(info?.getCharacteristic(Characteristic.HardwareRevision).value, "1.0.0", "configureInfo wrote the controller hardwareRevision unconditionally");

    // The context was reset to carry the controller MAC and the saved state, and the owner registers ZERO self-observers (it is owner-driven).
    assert.equal(built.accessory.context["nvr"], CONTROLLER_MAC, "configureDevice reset the context to carry the controller MAC");
    assert.equal(built.store.observerCount, 0, "the security-system owner registers no self-observers - it is driven by the liveviews owner, HomeKit onSet, and MQTT");
  });

  test("a saved AWAY_ARM securityState in the incoming context initializes the service to AWAY_ARM rather than the default", async () => {

    // Pre-seed the accessory context with a saved AWAY_ARM state BEFORE construction so configureDevice preserves it through the context wipe (the restore-the-scene
    // path).
    const accessory = makeTestAccessory("Security System", "uuid:" + CONTROLLER_MAC + ".Security");

    accessory.context["securityState"] = CurrentState.AWAY_ARM;

    const built = buildSecuritySystem({ accessory });

    activeController = built.controller;

    await settle();

    const security = built.accessory.getService(Service.SecuritySystem);

    assert.ok(security, "the SecuritySystem service exists");
    assert.equal(security.getCharacteristic(CurrentState).value, CurrentState.AWAY_ARM, "CurrentState restored the saved AWAY_ARM state");
    assert.equal(security.getCharacteristic(TargetState).value, TargetState.AWAY_ARM, "TargetState mapped the saved AWAY_ARM state to its target");
  });

  test("with the alarm feature enabled the alarm Switch exists and logs; without it the Switch is absent (the vacuity-gated pair)", async () => {

    const enabled = buildSecuritySystem({ userOptions: ["Enable.SecuritySystem.Alarm"] });

    activeController = enabled.controller;

    await settle();

    // HARD-assert the alarm Switch (the plain, no-subtype Switch) exists FIRST - the feature-gate non-vacuity discipline. The exact Enable.SecuritySystem.Alarm string.
    const alarm = enabled.accessory.getService(Service.Switch);

    assert.ok(alarm, "the SecuritySystem.Alarm feature on materializes the alarm Switch");
    assert.ok(loggedAt(enabled.logEntries, "info", "Enabling the security alarm switch on the security system accessory."), "the alarm-enabled info line logged");

    // The On onGet starts false (no alarm), and the onSet routes to setSecurityAlarm.
    assert.equal(await alarm.getCharacteristic(Characteristic.On).triggerGet(), false, "the alarm On onGet reads the un-triggered alarm state");

    // Without the feature the alarm Switch is absent (the pair).
    enabled.controller.abort();

    const disabled = buildSecuritySystem();

    activeController = disabled.controller;

    await settle();

    assert.equal(disabled.accessory.getService(Service.Switch), undefined, "without the feature the alarm Switch is not configured");
  });

  test("updateDevice narrows the TargetState validValues to the available arm states for a single seeded Protect-Away liveview", async () => {

    const built = buildSecuritySystem({ liveviews: [makeLiveviewConfig({ id: "lv-away", name: "Protect-Away" })] });

    activeController = built.controller;

    await settle();

    // updateDevice is invoked through the public API exactly as the liveviews owner drives it.
    assert.equal(built.owner.updateDevice(), true, "updateDevice returns true when at least two arm states are available");

    const target = built.accessory.getService(Service.SecuritySystem)?.getCharacteristic(TargetState);

    // DISARM is always present; Protect-Away adds AWAY_ARM, in the production order (DISARM seeded first, then Away/Home/Night as configured).
    assert.deepEqual(target?.props?.validValues, [ TargetState.DISARM, TargetState.AWAY_ARM ], "the validValues narrowed to DISARM + AWAY_ARM for the lone Protect-Away");
  });

  test("updateDevice with all three Protect arm liveviews narrows the validValues to DISARM + AWAY + STAY + NIGHT in production order", async () => {

    // DISTINCT ids per the makeLiveviewConfig distinct-id discipline - same-id seeds would collapse to one map entry.
    const built = buildSecuritySystem({ liveviews: [
      makeLiveviewConfig({ id: "lv-away", name: "Protect-Away" }),
      makeLiveviewConfig({ id: "lv-home", name: "Protect-Home" }),
      makeLiveviewConfig({ id: "lv-night", name: "Protect-Night" })
    ] });

    activeController = built.controller;

    await settle();

    assert.equal(built.owner.updateDevice(), true, "updateDevice returns true with the full set of arm states");

    const target = built.accessory.getService(Service.SecuritySystem)?.getCharacteristic(TargetState);

    // The production order is DISARM (always first), then Away, then Home (STAY_ARM), then Night (the iteration order in security-system.ts:275-278).
    assert.deepEqual(target?.props?.validValues, [ TargetState.DISARM, TargetState.AWAY_ARM, TargetState.STAY_ARM, TargetState.NIGHT_ARM ],
      "the validValues carry every available arm state in the production order");
  });

  test("updateDevice makes NO setProps call when there are no liveviews (the !liveviews.length early return)", async () => {

    const built = buildSecuritySystem({ liveviews: [] });

    activeController = built.controller;

    await settle();

    assert.equal(built.owner.updateDevice(), false, "updateDevice returns false with no liveviews configured");
    assert.equal(built.accessory.getService(Service.SecuritySystem)?.getCharacteristic(TargetState).props, undefined,
      "the no-liveviews early return never reached setProps");
  });

  test("updateDevice makes NO setProps call when only a single non-arm liveview is present (the <2-states early return)", async () => {

    // A lone Protect-Off liveview adds no arm state (DISARM is always present, Off is not Away/Home/Night), so availableSecurityStates stays length 1 and the <2 return
    // fires before setProps - a non-Protect liveview would behave identically.
    const built = buildSecuritySystem({ liveviews: [makeLiveviewConfig({ id: "lv-off", name: "Protect-Off" })] });

    activeController = built.controller;

    await settle();

    assert.equal(built.owner.updateDevice(), false, "updateDevice returns false when fewer than two arm states are available");
    assert.equal(built.accessory.getService(Service.SecuritySystem)?.getCharacteristic(TargetState).props, undefined,
      "the <2-states early return never reached setProps");
  });

  test("the securitysystem MQTT GET composes the controller-MAC topic and returns the current state string", async () => {

    const built = buildSecuritySystem();

    activeController = built.controller;

    await settle();

    // The mqttId is the controller MAC, so the GET subscription composes {controllerMAC}/securitysystem.
    const subscription = built.mqtt.subscriptions.find((entry) => (entry.kind === "get") && (entry.topic === CONTROLLER_MAC + "/securitysystem"));

    assert.ok(subscription?.getValue, "the securitysystem GET subscription composed the controller-MAC topic and captured a getValue handler");

    // The default saved state is STAY_ARM, which currentSecuritySystemState maps to "Home".
    assert.equal(subscription.getValue(), "Home", "the GET handler returns the human-readable state string for the saved STAY_ARM state");
    assert.equal(subscription.init?.signal, built.nvr.signal, "the GET registration carries the controller lifetime signal");
  });

  test("the securitysystem MQTT SET maps home/away/night/off to setSecurityState and a bad value logs the error", async () => {

    // Seed a Protect-Away liveview with a member camera so the away set has a real scene to apply (driving the fanout incidentally; the fanout itself is netted below).
    const built = buildSecuritySystem({ liveviews: [makeLiveviewConfig({ cameras: ["camera-away"], id: "lv-away", name: "Protect-Away" })] });

    activeController = built.controller;

    seedMember(built.nvr, { id: "camera-away", name: "Away Camera", uuid: "uuid:away-camera" });

    await settle();

    const subscription = built.mqtt.subscriptions.find((entry) => (entry.kind === "set") && (entry.topic === CONTROLLER_MAC + "/securitysystem"));

    assert.ok(subscription?.setValue, "the securitysystem SET subscription captured a setValue handler");

    // "away" maps to AWAY_ARM and drives setSecurityState - the CurrentState lands on AWAY_ARM and the state publishes.
    await subscription.setValue("away", "away");

    assert.equal(built.accessory.getService(Service.SecuritySystem)?.getCharacteristic(CurrentState).value, CurrentState.AWAY_ARM,
      "the away MQTT value drove setSecurityState to AWAY_ARM");
    assert.ok(built.mqtt.published.some((published) => (published.topic === CONTROLLER_MAC + "/securitysystem") && (published.message === "Away")),
      "the away set published the Away state");

    // "off" maps to DISARM and disarms.
    await subscription.setValue("off", "off");

    assert.equal(built.accessory.getService(Service.SecuritySystem)?.getCharacteristic(CurrentState).value, CurrentState.DISARMED,
      "the off MQTT value disarmed the system");

    // A bad value logs the error and changes nothing.
    await subscription.setValue("garbage", "garbage");

    assert.ok(loggedAt(built.logEntries, "error", "Unable to process MQTT security system setting: garbage."), "a bad MQTT value logs the error");
  });

  test("setSecurityState fans motion onto a matching member camera (flips false->true), skips a non-member, and publishes - NON-VACUOUS", async () => {

    // A Protect-Home liveview carrying one member camera id, DISTINCT ids on the liveview seeds.
    const built = buildSecuritySystem({ liveviews: [makeLiveviewConfig({ cameras: ["camera-home"], id: "lv-home", name: "Protect-Home" })] });

    activeController = built.controller;

    // The matching member (its ufp.id matches the Protect-Home slot camera) with detectMotion seeded FALSY, plus a non-member camera the fanout must NOT touch.
    const member = seedMember(built.nvr, { detectMotion: false, id: "camera-home", name: "Home Camera", uuid: "uuid:home-camera" });
    const nonMember = seedMember(built.nvr, { detectMotion: false, id: "camera-other", name: "Other Camera", uuid: "uuid:other-camera" });

    await settle();

    // Precondition: the member starts with motion OFF so the drive toward enabled is a genuine change (the write is change-gated on detectMotion !== targetState).
    assert.equal(member.accessory.context["detectMotion"], false, "the member camera starts with motion detection off");
    assert.equal(member.motionSwitch.getCharacteristic(Characteristic.On).value, false, "the member motion switch starts off");

    // Drive the STAY_ARM scene through the real TargetState onSet (HomeKit's set path).
    await built.accessory.getService(Service.SecuritySystem)?.getCharacteristic(TargetState).triggerSet(TargetState.STAY_ARM);

    // The member FLIPPED on (the discriminating assertion: false -> true, not merely ended true) and its context updated.
    assert.equal(member.motionSwitch.getCharacteristic(Characteristic.On).value, true, "the member's motion switch flipped on for the armed scene");
    assert.equal(member.accessory.context["detectMotion"], true, "the member's detectMotion context flipped to true");

    // The production line is "%s -> %s: Motion detection %s." where viewScene is the lowercased "protect-home"; the formatted parameter carries the member and enabled.
    assert.ok(loggedAt(built.logEntries, "info", "protect-home -> Home Camera: Motion detection enabled."),
      "the per-member motion-enabled line fired with the scene and member");

    // The non-member was untouched (its id is not in the Protect-Home liveview).
    assert.equal(nonMember.accessory.context["detectMotion"], false, "the non-member camera was left untouched");
    assert.equal(nonMember.motionSwitch.getCharacteristic(Characteristic.On).value, false, "the non-member motion switch stayed off");

    // CurrentState landed on STAY_ARM and the state published.
    assert.equal(built.accessory.getService(Service.SecuritySystem)?.getCharacteristic(CurrentState).value, CurrentState.STAY_ARM, "CurrentState landed on STAY_ARM");
    assert.ok(built.mqtt.published.some((published) => (published.topic === CONTROLLER_MAC + "/securitysystem") && (published.message === "Home")),
      "the armed scene published the Home state");

    // Now drive the disarm direction from the true start to net the change the OTHER way (false-gate proven both directions).
    await built.accessory.getService(Service.SecuritySystem)?.getCharacteristic(TargetState).triggerSet(TargetState.DISARM);

    assert.equal(member.motionSwitch.getCharacteristic(Characteristic.On).value, false, "disarming flipped the member's motion switch back off");
    assert.equal(member.accessory.context["detectMotion"], false, "disarming reset the member's detectMotion context");
    assert.ok(loggedAt(built.logEntries, "info", "Motion detection disabled."), "the per-member motion-disabled line fired on disarm");
  });

  test("setSecurityState early-returns with no liveviews configured (no state change, no publish)", async () => {

    const built = buildSecuritySystem({ liveviews: [] });

    activeController = built.controller;

    await settle();

    const publishedBefore = built.mqtt.published.length;

    // With no liveviews the setSecurityState early-returns before any state write or publish.
    await built.accessory.getService(Service.SecuritySystem)?.getCharacteristic(TargetState).triggerSet(TargetState.AWAY_ARM);

    assert.equal(built.accessory.getService(Service.SecuritySystem)?.getCharacteristic(CurrentState).value, CurrentState.STAY_ARM,
      "with no liveviews CurrentState stays at the saved default - the early return fired");
    assert.equal(built.mqtt.published.length, publishedBefore, "the no-liveviews early return published nothing");
  });

  test("setSecurityState with a liveview but no member cameras for the target takes the no-target branch (state updates, the guidance logs)", async () => {

    // A Protect-Home liveview with NO member cameras: arming STAY_ARM finds no target cameras, so the no-target branch updates state and logs the create-a-liveview
    // guidance.
    const built = buildSecuritySystem({ liveviews: [makeLiveviewConfig({ id: "lv-home", name: "Protect-Home" })] });

    activeController = built.controller;

    await settle();

    await built.accessory.getService(Service.SecuritySystem)?.getCharacteristic(TargetState).triggerSet(TargetState.STAY_ARM);

    assert.equal(built.accessory.getService(Service.SecuritySystem)?.getCharacteristic(CurrentState).value, CurrentState.STAY_ARM,
      "the no-target branch still updates CurrentState for the user");
    assert.ok(loggedAt(built.logEntries, "info", "No liveview configured for this security system state."), "the no-target branch logged the create-a-liveview guidance");
  });

  test("setSecurityAlarm triggers the ALARM_TRIGGERED current state and the alarm Switch, and a reset returns to the held state", async () => {

    const built = buildSecuritySystem({ userOptions: ["Enable.SecuritySystem.Alarm"] });

    activeController = built.controller;

    await settle();

    const alarm = built.accessory.getService(Service.Switch);

    assert.ok(alarm, "the alarm Switch exists");

    // Trigger the alarm through the real On onSet (HomeKit's set path).
    await alarm.getCharacteristic(Characteristic.On).triggerSet(true);

    assert.equal(built.accessory.getService(Service.SecuritySystem)?.getCharacteristic(CurrentState).value, CurrentState.ALARM_TRIGGERED,
      "triggering the alarm drove CurrentState to ALARM_TRIGGERED");
    assert.equal(alarm.getCharacteristic(Characteristic.On).value, true, "the alarm Switch reflects the triggered state");
    assert.ok(built.mqtt.published.some((published) => (published.topic === CONTROLLER_MAC + "/securitysystem") && (published.message === "Alarm")),
      "the alarm published the Alarm state");

    // Reset returns to the held securityState (STAY_ARM by default).
    await alarm.getCharacteristic(Characteristic.On).triggerSet(false);

    assert.equal(built.accessory.getService(Service.SecuritySystem)?.getCharacteristic(CurrentState).value, CurrentState.STAY_ARM,
      "resetting the alarm returns CurrentState to the held STAY_ARM state");
    assert.equal(alarm.getCharacteristic(Characteristic.On).value, false, "the alarm Switch reflects the reset state");
  });

  test("aborting the controller signal ends the MQTT subscription lifetime", async () => {

    const built = buildSecuritySystem();

    activeController = built.controller;

    await settle();

    const subscription = built.mqtt.subscriptions.find((entry) => (entry.kind === "get") && (entry.topic === CONTROLLER_MAC + "/securitysystem"));

    assert.equal(subscription?.init?.signal?.aborted, false, "the GET registration's lifetime is live before the controller abort");

    built.controller.abort();

    await settle();

    assert.equal(subscription?.init?.signal?.aborted, true, "the GET registration's lifetime ended with the controller abort");
    assert.equal(built.store.observerCount, 0, "the owner-driven security system registers and leaks no observers");
  });
});
