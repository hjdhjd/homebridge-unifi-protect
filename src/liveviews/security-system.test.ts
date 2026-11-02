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
 *   Its MQTT registrations bind an owner-lifetime signal (its own AbortController composed with nvr.signal), so teardown is EITHER aborting nvr.signal (the controller
 *   terminal shutdown) OR the owner's own cleanup() - the accessory unwinds independently of the plugin when the liveviews owner removes it.
 * - It publishes NOTHING on the hbup:observer:wake diagnostics channel, so this suite does NOT reuse the viewer / sensor wake-count scaffold.
 * - nvr.ufp reads THROUGH the store (the harness's read-through client.nvr.config getter), so the opt-in hardwareRevision seeded into the store's nvr slice is what the
 *   configureInfo HardwareRevision write reads - making that write non-vacuous.
 *
 * Two non-vacuity disciplines matter here, both required rather than incidental. First, the alarm-switch feature gate (Enable.SecuritySystem.Alarm, default off): the
 * with-feature test passes the exact string and HARD-asserts the alarm Switch exists FIRST, paired with a without-feature absence test. Second, the motion fanout is
 * CHANGE-GATED (security-system.ts writes only when detectMotion !== targetState), so the member's context.detectMotion is seeded FALSY before driving toward enabled,
 * and the test asserts the switch FLIPPED false->true and the "...Motion detection enabled." log FIRED - not merely that detectMotion ended true.
 */
import { Characteristic, Service, TestStateStore, makeProtectState, makeTestAccessory } from "../testing.helpers.ts";
import type { TestLogEntry, TestMqttClient } from "homebridge-plugin-utils/testing";
import { afterEach, describe, test } from "node:test";
import { hapStatus, loggedAt, settle, triggerGet, triggerSet } from "homebridge-plugin-utils/testing";
import { makeNvrConfig, makeTestNvr, restoreAccessories } from "../nvr/testing.helpers.ts";
import { HAPStatus } from "homebridge-plugin-utils";
import type { ProtectDevices } from "../types.ts";
import type { ProtectNvr } from "../nvr/nvr.ts";
import type { ProtectNvrLiveviewConfig } from "unifi-protect";
import { ProtectReservedNames } from "../types.ts";
import { ProtectSecuritySystem } from "./security-system.ts";
import type { TestProtectAccessory } from "../testing.helpers.ts";
import type { TestProtectNvr } from "../nvr/testing.helpers.ts";
import assert from "node:assert/strict";
import { configured } from "../devices/device-base.ts";
import { makeLiveviewConfig } from "../devices/testing.helpers.ts";

// The controller MAC the makeNvrConfig record carries, and the MQTT topic scope (the mqttId is the controller MAC for a ProtectBase owner). A literal so a drift in the
// fixture MAC breaks loudly rather than silently following along.
const CONTROLLER_MAC = "74ACB9FFFFFF";

// The named HAP arm-state constants, read off HAP's own characteristic classes so the assertions and the production share one source. SecuritySystemCurrentState
// carries five distinct values; SecuritySystemTargetState four (DISARM === DISARMED === 3 under HAP-distinct names).
const CurrentState = Characteristic.SecuritySystemCurrentState;
const TargetState = Characteristic.SecuritySystemTargetState;

// The security accessory's TargetState characteristic, the one HomeKit's arm and disarm requests write. The SecuritySystem service is asserted present first, so an
// absent service fails here rather than reaching the trigger as nothing to write.
function targetStateOf(accessory: TestProtectAccessory): Characteristic {

  const security = accessory.getService(Service.SecuritySystem);

  assert.ok(security, "the SecuritySystem service exists");

  return security.getCharacteristic(TargetState);
}

// Seed a member device double into the NVR's configuredDevices registry AND the platform accessories array so the cross-camera motion fanout resolves it. The fanout
// resolves each platform accessory to its configuredDevices entry, gates on the device's recordPresent (a vanished record is skipped), the controller-MAC context, and
// the camera-family modelKey, matches the member by its non-throwing protectId against the liveview's slots[].cameras, then flips its SWITCH_MOTION_SENSOR-subtyped
// Switch and context.detectMotion. The member's detectMotion is seeded FALSY by default so a drive toward enabled is a genuine change (the write is change-gated), and
// its modelKey defaults to "camera" so the camera-family gate admits it; a sensor/light member overrides modelKey to prove the gate skips it. The accessory is seeded
// by the member's MAC and restored onto the bridge, as a device's cached accessory is. Returns member and switch.
function seedMember(nvr: TestProtectNvr, options: { detectMotion?: boolean; id: string; mac: string; modelKey?: string; name: string; recordPresent?: boolean }):
{ accessory: TestProtectAccessory; motionSwitch: Service } {

  const accessory = makeTestAccessory(options.name, options.mac);

  accessory.context.nvr = CONTROLLER_MAC;
  accessory.context.detectMotion = options.detectMotion ?? false;

  // The member's motion switch is the SWITCH_MOTION_SENSOR-subtyped Switch the security fanout reads (distinct from the security accessory's own plain alarm Switch).
  const motionSwitch = accessory.addService(new Service.Switch(options.name + " Motion", ProtectReservedNames.SWITCH_MOTION_SENSOR));

  motionSwitch.updateCharacteristic(Characteristic.On, accessory.context.detectMotion);
  restoreAccessories(nvr, [accessory]);

  // The managed-device double the fanout resolves through configuredDevices: the security path gates each member on recordPresent and modelKey, and matches on the
  // non-throwing protectId. Cast through ProtectDevices at the construction boundary.
  const member = { accessory, accessoryName: options.name, modelKey: options.modelKey ?? "camera", protectId: options.id, recordPresent: options.recordPresent ?? true,
    ufp: { id: options.id } } as unknown as ProtectDevices;

  nvr.configuredDevices.set(accessory.UUID, member);

  return { accessory, motionSwitch };
}

// The reusable construction helper: build a REAL ProtectSecuritySystem against the harness doubles. makeProtectState seeds the Protect-* liveviews (DISTINCT ids per the
// makeLiveviewConfig distinct-id discipline) and the nvr record carrying the opt-in hardwareRevision so configureInfo's HardwareRevision write reads a real value; the
// casts are confined to construction exactly as the family suites do. The owner RECEIVES its accessory (it does not self-create), so the test supplies one. The seed
// hook runs against the controller double before the owner is built, standing in for the cameras a restart has already constructed when the security system shows
// its saved scene. The returned controller is the AbortController behind nvr.signal, aborted in teardown: the fixture tears down through the controller it built, the
// scope that owns every registration the test created.
function buildSecuritySystem(
  harnessOptions: { accessory?: TestProtectAccessory; disconnected?: boolean; hardwareRevision?: string; liveviews?: ProtectNvrLiveviewConfig[];
    seed?: (nvr: TestProtectNvr) => void; userOptions?: string[]; } = {}): {
  accessory: TestProtectAccessory; controller: AbortController; logEntries: readonly TestLogEntry[]; mqtt: TestMqttClient; nvr: TestProtectNvr;
  owner: ProtectSecuritySystem; store: TestStateStore;
} {

  const nvrConfig = makeNvrConfig({ hardwareRevision: harnessOptions.hardwareRevision ?? "1.0.0" });
  const store = new TestStateStore(makeProtectState({ liveviews: harnessOptions.liveviews ?? [], nvr: nvrConfig }));
  const { controller, logEntries, mqtt, nvr } = makeTestNvr({ mqtt: true, store, userOptions: harnessOptions.userOptions });
  const accessory = harnessOptions.accessory ?? makeTestAccessory("Security System", CONTROLLER_MAC + ".Security");

  // makeTestNvr was called with mqtt: true, so the recording double is present; a guard narrows Nullable<TestMqttClient> to the non-null type without an assertion or a
  // same-type cast (either of which the house lint preset forbids in opposite directions), and fails loudly if the opt-in ever stops installing the double.
  if(!mqtt) {

    throw new Error("The MQTT recording double was not installed despite mqtt: true.");
  }

  // A disconnected double is the production startup shape: the security system is built before the broker acknowledges the first session.
  mqtt.connected = !(harnessOptions.disconnected ?? false);

  harnessOptions.seed?.(nvr);

  const owner = configured(new ProtectSecuritySystem(nvr as unknown as ProtectNvr, accessory));

  return { accessory, controller, logEntries, mqtt, nvr, owner, store };
}

describe("real ProtectSecuritySystem construction and controller-owner behavior", () => {

  // The per-test controller, tracked so afterEach aborts whichever build the test made (aborting the controller behind nvr.signal is the fixture's teardown, the scope
  // that owns every registration the test created).
  let activeController: AbortController | undefined;

  afterEach(() => {

    activeController?.abort();
    activeController = undefined;
  });

  test("construction materializes the SecuritySystem service, initializes current/target from the saved state, and writes the controller-branded info", async () => {

    const built = buildSecuritySystem({ liveviews: [makeLiveviewConfig({ id: "lv-off", name: "Protect-Off" })] });

    activeController = built.controller;

    await settle();

    // HARD-assert the SecuritySystem service exists FIRST (non-optional), so a missing service fails here rather than letting the reads below pass vacuously.
    const security = built.accessory.getService(Service.SecuritySystem);

    assert.ok(security, "the SecuritySystem service was acquired at construction");

    // An accessory the user has never set carries no saved state, so current initializes to DISARMED and target to DISARM: the security system shows Off.
    assert.equal(security.getCharacteristic(CurrentState).value, CurrentState.DISARMED, "CurrentState initialized to DISARMED with no saved state");
    assert.equal(security.getCharacteristic(TargetState).value, TargetState.DISARM, "TargetState initialized to DISARM with no saved state");

    // The current-state onGet reads through the saved state (alarm-aware); with no alarm and no saved state it returns DISARMED.
    assert.equal(await triggerGet(security.getCharacteristic(CurrentState)), CurrentState.DISARMED, "the CurrentState onGet reads Off with no saved securityState");

    // The bespoke configureInfo wrote the controller-branded identity; HardwareRevision is non-vacuous via the opt-in hardwareRevision.
    const info = built.accessory.getService(Service.AccessoryInformation);

    assert.equal(info?.getCharacteristic(Characteristic.Manufacturer).value, "github.com/hjdhjd", "configureInfo wrote the github.com/hjdhjd Manufacturer");
    assert.equal(info.getCharacteristic(Characteristic.Model).value, "UniFi Protect Liveview Security System", "configureInfo wrote the liveview security-system Model");
    assert.equal(info.getCharacteristic(Characteristic.SerialNumber).value, CONTROLLER_MAC + ".Security", "configureInfo wrote the mac+.Security SerialNumber");
    assert.equal(info.getCharacteristic(Characteristic.HardwareRevision).value, "1.0.0", "configureInfo wrote the controller hardwareRevision unconditionally");

    // The context was reset to carry the controller MAC and no state of the plugin's own, and the owner registers ZERO self-observers (it is owner-driven).
    assert.equal(built.accessory.context.nvr, CONTROLLER_MAC, "configureDevice reset the context to carry the controller MAC");
    assert.equal(built.accessory.context.securityState, undefined, "configureDevice stores no security state the user has not set");
    assert.equal(built.store.observerCount, 0, "the security-system owner registers no self-observers - it is driven by the liveviews owner, HomeKit onSet, and MQTT");
  });

  test("a saved AWAY_ARM securityState in the incoming context initializes the service to AWAY_ARM rather than the default", async () => {

    // Pre-seed the accessory context with a saved AWAY_ARM state BEFORE construction so configureDevice preserves it through the context wipe (the restore-the-scene
    // path).
    const accessory = makeTestAccessory("Security System", CONTROLLER_MAC + ".Security");

    accessory.context.securityState = CurrentState.AWAY_ARM;

    const built = buildSecuritySystem({ accessory });

    activeController = built.controller;

    await settle();

    const security = built.accessory.getService(Service.SecuritySystem);

    assert.ok(security, "the SecuritySystem service exists");
    assert.equal(security.getCharacteristic(CurrentState).value, CurrentState.AWAY_ARM, "CurrentState restored the saved AWAY_ARM state");
    assert.equal(security.getCharacteristic(TargetState).value, TargetState.AWAY_ARM, "TargetState mapped the saved AWAY_ARM state to its target");
  });

  test("with the alarm feature enabled the alarm Switch exists and logs; without it the Switch is absent (the vacuity-gated pair)", async () => {

    const enabled = buildSecuritySystem({ liveviews: [makeLiveviewConfig({ id: "lv-off", name: "Protect-Off" })], userOptions: ["Enable.SecuritySystem.Alarm"] });

    activeController = enabled.controller;

    await settle();

    // HARD-assert the alarm Switch (the plain, no-subtype Switch) exists FIRST - the feature-gate non-vacuity discipline. The exact Enable.SecuritySystem.Alarm string.
    const alarm = enabled.accessory.getService(Service.Switch);

    assert.ok(alarm, "the SecuritySystem.Alarm feature on materializes the alarm Switch");
    assert.ok(loggedAt(enabled.logEntries, "info", "Enabling the security alarm switch on the security system accessory."), "the alarm-enabled info line logged");

    // The On onGet starts false (no alarm), and the onSet routes to setSecurityAlarm.
    assert.equal(await triggerGet(alarm.getCharacteristic(Characteristic.On)), false, "the alarm On onGet reads the un-triggered alarm state");

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
    assert.deepEqual(target?.props.validValues, [ TargetState.DISARM, TargetState.AWAY_ARM ], "the validValues narrowed to DISARM + AWAY_ARM for the lone Protect-Away");
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

    // The production order is DISARM (always first), then Away, then Home (STAY_ARM), then Night (the Away/Home/Night iteration order in security-system.ts).
    assert.deepEqual(target?.props.validValues, [ TargetState.DISARM, TargetState.AWAY_ARM, TargetState.STAY_ARM, TargetState.NIGHT_ARM ],
      "the validValues carry every available arm state in the production order");
  });

  test("updateDevice makes NO setProps call when there are no liveviews (the !liveviews.length early return)", async () => {

    const built = buildSecuritySystem({ liveviews: [] });

    activeController = built.controller;

    await settle();

    assert.equal(built.owner.updateDevice(), false, "updateDevice returns false with no liveviews configured");

    // HAP builds every characteristic with its kind's full props, every arm state among TargetState's valid values, so an early return that never reached setProps
    // leaves the props exactly as HAP built them.
    assert.deepEqual(targetStateOf(built.accessory).props, new TargetState().props, "the no-liveviews early return never reached setProps");
  });

  test("updateDevice narrows the TargetState menu to disarm-only when only a non-arm liveview remains (the D4 blessed change)", async () => {

    // A lone Protect-Off liveview adds no arm state (DISARM is always present, Off is not Away/Home/Night), so availableSecurityStates stays [DISARM]. setProps lands
    // unconditionally even when fewer than two arm states are available, so removing the last arm liveview re-narrows the Home app's menu to disarm-only rather than
    // leaving the previous menu in place - a non-Protect liveview behaves identically.
    const built = buildSecuritySystem({ liveviews: [makeLiveviewConfig({ id: "lv-off", name: "Protect-Off" })] });

    activeController = built.controller;

    await settle();

    assert.equal(built.owner.updateDevice(), true, "updateDevice returns true and applies the narrowed menu rather than early-returning");

    const target = built.accessory.getService(Service.SecuritySystem)?.getCharacteristic(TargetState);

    assert.deepEqual(target?.props.validValues, [TargetState.DISARM], "the validValues re-narrowed to disarm-only");
  });

  test("updateDevice snaps an out-of-menu TargetState to DISARM without running a sweep (the D5 blessed change)", async () => {

    // Start with a saved AWAY_ARM state and a Protect-Away liveview so TargetState initializes to AWAY_ARM and it is in the menu.
    const accessory = makeTestAccessory("Security System", CONTROLLER_MAC + ".Security");

    accessory.context.securityState = CurrentState.AWAY_ARM;

    const built = buildSecuritySystem({ accessory, liveviews: [makeLiveviewConfig({ cameras: ["camera-away"], id: "lv-away", name: "Protect-Away" })] });

    activeController = built.controller;

    // A camera member so a sweep, if one wrongly ran, would flip its motion - the D5 correction must run NO sweep.
    const camera = seedMember(built.nvr, { detectMotion: false, id: "camera-away", mac: "74ACB9000101", name: "Away Camera" });

    await settle();

    const target = built.accessory.getService(Service.SecuritySystem)?.getCharacteristic(TargetState);

    assert.equal(target?.value, TargetState.AWAY_ARM, "TargetState starts on the saved AWAY_ARM");

    // While the Away liveview exists, AWAY_ARM is in the menu, so updateDevice leaves the selection alone.
    built.owner.updateDevice();

    assert.deepEqual(target.props.validValues, [ TargetState.DISARM, TargetState.AWAY_ARM ], "AWAY_ARM is in the menu while its liveview exists");
    assert.equal(target.value, TargetState.AWAY_ARM, "TargetState stays AWAY_ARM while it is reachable - no snap");

    const publishedBefore = built.mqtt.published.length;

    // Remove the Away liveview, leaving only a non-arm liveview: AWAY_ARM falls out of the recomputed menu, so updateDevice snaps the displayed target to DISARM.
    built.store.pushLiveviews([makeLiveviewConfig({ id: "lv-off", name: "Protect-Off" })]);
    built.owner.updateDevice();

    assert.deepEqual(target.props.validValues, [TargetState.DISARM], "the menu re-narrowed to disarm-only");
    assert.equal(target.value, TargetState.DISARM, "the out-of-menu AWAY_ARM snapped to DISARM as display truth");

    // The snap is display-only: updateCharacteristic fires no onSet, so no sweep ran - the camera's motion state is unchanged and nothing published.
    assert.equal(camera.accessory.context.detectMotion, false, "the D5 snap ran no sweep - the camera member's detectMotion is unchanged");
    assert.equal(built.mqtt.published.length, publishedBefore, "the D5 snap published nothing - it is a display-only correction");
  });

  test("the securitysystem MQTT GET composes the controller-MAC topic and returns the current state string", async () => {

    const built = buildSecuritySystem();

    activeController = built.controller;

    await settle();

    // The mqttId is the controller MAC, so the GET subscription composes {controllerMAC}/securitysystem.
    const subscription = built.mqtt.subscriptions.find((entry) => (entry.kind === "get") && (entry.topic === CONTROLLER_MAC + "/securitysystem/get"));

    assert.ok(subscription, "the securitysystem GET subscription composed the controller-MAC topic and captured a getValue handler");

    // With no saved state, currentSecuritySystemState maps the absent state to "Off".
    assert.equal(await built.mqtt.invokeGet(CONTROLLER_MAC + "/securitysystem/get"), "Off",
      "the GET handler returns the human-readable state string for a security system with no saved state");

    // The GET registration binds the owner-lifetime signal, not nvr.signal: it is live at rest, and cleanup() aborts it while the controller-lifetime nvr.signal stays
    // live - the security system unwinds independently of the plugin.
    assert.equal(subscription.init.signal?.aborted, false, "the GET registration's owner-lifetime signal is live at rest");

    built.owner.cleanup();

    assert.equal(subscription.init.signal.aborted, true, "cleanup() aborted the owner-lifetime signal that scopes the GET registration");
    assert.equal(built.nvr.signal.aborted, false, "the controller-lifetime nvr.signal stayed live - the owner unwinds independently of the plugin");
  });

  test("the securitysystem MQTT SET maps home/away/night/off to setSecurityState and a bad value logs the error", async () => {

    // Seed a Protect-Away liveview with a member camera so the away set has a real scene to apply (driving the fanout incidentally; the fanout itself is netted below).
    const built = buildSecuritySystem({ liveviews: [makeLiveviewConfig({ cameras: ["camera-away"], id: "lv-away", name: "Protect-Away" })] });

    activeController = built.controller;

    seedMember(built.nvr, { id: "camera-away", mac: "74ACB9000101", name: "Away Camera" });

    await settle();

    const subscription = built.mqtt.subscriptions.find((entry) => (entry.kind === "set") && (entry.topic === CONTROLLER_MAC + "/securitysystem/set"));

    assert.ok(subscription, "the securitysystem SET subscription composed the controller-MAC topic");

    // "away" maps to AWAY_ARM and drives setSecurityState - the CurrentState lands on AWAY_ARM and the state publishes.
    await built.mqtt.invokeSet(CONTROLLER_MAC + "/securitysystem/set", "away");

    assert.equal(built.accessory.getService(Service.SecuritySystem)?.getCharacteristic(CurrentState).value, CurrentState.AWAY_ARM,
      "the away MQTT value drove setSecurityState to AWAY_ARM");
    assert.deepEqual(built.mqtt.publishedTo(CONTROLLER_MAC + "/securitysystem").map((entry) => entry.payload), [ "Off", "Away" ],
      "the build stated the Off state once and the away set stated the Away state once");

    // "off" maps to DISARM and disarms.
    await built.mqtt.invokeSet(CONTROLLER_MAC + "/securitysystem/set", "off");

    assert.equal(built.accessory.getService(Service.SecuritySystem)?.getCharacteristic(CurrentState).value, CurrentState.DISARMED,
      "the off MQTT value disarmed the system");

    // A bad value logs the error and changes nothing.
    await built.mqtt.invokeSet(CONTROLLER_MAC + "/securitysystem/set", "garbage");

    assert.ok(loggedAt(built.logEntries, "error", "Unable to process MQTT security system setting: garbage."), "a bad MQTT value logs the error");
  });

  // The security system has no record to say it is leaving, so the liveviews that call for it are what turn its verdict, whatever the removal gate holds. The removal is
  // pending through the delay, a controller not yet stable schedules none, and a flap drops the one the gate held, so the verdict reads the same with or without one.
  // MQTT keeps answering for the accessory that stays, and the verdict is read on each call, so a liveview that returns clears the refusal with nothing rebound.
  for(const row of [
    { flapAfter: false, flapBefore: false, pending: true, title: "through the removal delay" },
    { flapAfter: false, flapBefore: true, pending: false, title: "with the controller not yet stable" },
    { flapAfter: true, flapBefore: false, pending: false, title: "after a flap dropped the removal" }
  ]) {

    test("with its calling liveview deleted a read and a write refuse " + row.title + ", its MQTT get and set answer, and its return answers each", async () => {

      const away = makeLiveviewConfig({ cameras: ["camera-away"], id: "lv-away", name: "Protect-Away" });
      const ordinary = makeLiveviewConfig({ id: "lv-ordinary", name: "Front Door" });
      const built = buildSecuritySystem({ liveviews: [ away, ordinary ] });
      const flap = (): void => {

        built.nvr.pushControllerStability(false);
        built.nvr.pushControllerStability(true);
      };

      activeController = built.controller;

      await settle();

      const current = built.accessory.getService(Service.SecuritySystem)?.getCharacteristic(CurrentState);
      const target = targetStateOf(built.accessory);

      assert.ok(current, "the SecuritySystem service exists");
      assert.equal(built.owner.isAvailable, true, "with a liveview calling for it, the security system answers");

      if(row.flapBefore) {

        flap();
      }

      built.store.pushLiveviews([ordinary]);
      built.nvr.removals.schedule({ accessory: built.accessory, remove: () => undefined, stillGone: () => true });

      if(row.flapAfter) {

        assert.equal(built.nvr.removals.isPending(built.accessory.UUID), true, "the gate held the removal ahead of the flap");

        flap();
      }

      assert.equal(built.nvr.removals.isPending(built.accessory.UUID), row.pending, "the removal gate holds what this posture leaves it");
      assert.equal(built.owner.isAvailable, false, "and the deleted liveview turns the verdict");

      await assert.rejects(triggerGet(current), hapStatus(HAPStatus.SERVICE_COMMUNICATION_FAILURE), "a read refuses");
      await assert.rejects(triggerSet(target, TargetState.AWAY_ARM), hapStatus(HAPStatus.SERVICE_COMMUNICATION_FAILURE), "and so does a write");

      assert.equal(await built.mqtt.invokeGet(CONTROLLER_MAC + "/securitysystem/get"), "Off", "the MQTT get answers");

      await built.mqtt.invokeSet(CONTROLLER_MAC + "/securitysystem/set", "away");

      assert.equal(current.value, CurrentState.AWAY_ARM, "and the MQTT set applies its scene");
      assert.equal(await built.mqtt.invokeGet(CONTROLLER_MAC + "/securitysystem/get"), "Away", "which the get then reads");

      built.store.pushLiveviews([ away, ordinary ]);

      assert.equal(built.owner.isAvailable, true, "the returning liveview clears the verdict");

      await assert.doesNotReject(triggerGet(current), "and a read answers again");
      await assert.doesNotReject(triggerSet(target, TargetState.DISARM), "and so does a write");
    });
  }

  // A Disarm sweeps motion detection off every camera whenever any liveview stands, so with an ordinary liveview standing the refusal is all that stops a tap on a
  // security system that is leaving from turning motion detection off, with nothing left in HomeKit to turn it back on. The same tap once the liveview returns does
  // sweep, so this reads the refusal rather than a tap with nothing to do.
  test("a Disarm with the calling liveview deleted and an ordinary one standing refuses, and leaves each camera's motion detection as it was", async () => {

    const away = makeLiveviewConfig({ cameras: ["camera-away"], id: "lv-away", name: "Protect-Away" });
    const ordinary = makeLiveviewConfig({ id: "lv-ordinary", name: "Front Door" });
    const built = buildSecuritySystem({ liveviews: [ away, ordinary ] });

    activeController = built.controller;

    const member = seedMember(built.nvr, { detectMotion: true, id: "camera-away", mac: "74ACB9000102", name: "Away Camera" });
    const other = seedMember(built.nvr, { detectMotion: true, id: "camera-other", mac: "74ACB9000103", name: "Other Camera" });
    const target = targetStateOf(built.accessory);

    await settle();

    built.store.pushLiveviews([ordinary]);

    await assert.rejects(triggerSet(target, TargetState.DISARM), hapStatus(HAPStatus.SERVICE_COMMUNICATION_FAILURE), "the Disarm refuses");

    assert.equal(member.accessory.context.detectMotion, true, "the member camera keeps its motion detection");
    assert.equal(other.accessory.context.detectMotion, true, "and so does the camera beside it");
    assert.equal(member.motionSwitch.getCharacteristic(Characteristic.On).value, true, "and the member's motion switch stays on");

    built.store.pushLiveviews([ away, ordinary ]);

    await triggerSet(target, TargetState.DISARM);

    assert.equal(member.accessory.context.detectMotion, false, "with the liveview back the same Disarm sweeps the member camera");
    assert.equal(other.accessory.context.detectMotion, false, "and the camera beside it");
  });

  test("the securitysystem MQTT SET refuses AlarmOn and AlarmOff with SecuritySystem.Alarm off, and drives the alarm with it on", async () => {

    // The alarm state belongs to the SecuritySystem.Alarm feature. With it off an alarm value is refused and logged as an unknown value is, driving no state and
    // publishing nothing; the same value with the feature on drives the alarm, so the refusal is the option's alone.
    const disabled = buildSecuritySystem();
    const enabled = buildSecuritySystem({ userOptions: ["Enable.SecuritySystem.Alarm"] });

    try {

      await settle();

      const publishedBefore = disabled.mqtt.publishedTo("/securitysystem").length;

      await disabled.mqtt.invokeSet(CONTROLLER_MAC + "/securitysystem/set", "AlarmOn");

      assert.equal(disabled.accessory.getService(Service.SecuritySystem)?.getCharacteristic(CurrentState).value, CurrentState.DISARMED,
        "an AlarmOn with the feature off leaves the held Off state");
      assert.equal(await disabled.mqtt.invokeGet(CONTROLLER_MAC + "/securitysystem/get"), "Off", "the GET still answers the held state, never Alarm");
      assert.ok(loggedAt(disabled.logEntries, "error", "Unable to process MQTT security system setting: alarmon."),
        "the refused AlarmOn is logged as an unknown value is");

      await disabled.mqtt.invokeSet(CONTROLLER_MAC + "/securitysystem/set", "AlarmOff");

      assert.ok(loggedAt(disabled.logEntries, "error", "Unable to process MQTT security system setting: alarmoff."),
        "the refused AlarmOff is logged as an unknown value is");
      assert.deepEqual(disabled.mqtt.publishedTo("/securitysystem").slice(publishedBefore).map((entry) => entry.payload), ["Off"],
        "the refused alarm values publish nothing, so the one statement after them is the GET's answer");

      await enabled.mqtt.invokeSet(CONTROLLER_MAC + "/securitysystem/set", "AlarmOn");

      assert.equal(enabled.accessory.getService(Service.SecuritySystem)?.getCharacteristic(CurrentState).value, CurrentState.ALARM_TRIGGERED,
        "an AlarmOn with the feature on drives the alarm");
      assert.ok(enabled.mqtt.publishedTo("/securitysystem").some((entry) => entry.payload === "Alarm"), "the driven alarm publishes the Alarm state");
    } finally {

      disabled.controller.abort();
      enabled.controller.abort();
    }
  });

  test("setSecurityState fans motion onto a matching member camera (flips false->true), skips a non-member, and publishes - NON-VACUOUS", async () => {

    // A Protect-Home liveview carrying one member camera id, DISTINCT ids on the liveview seeds.
    const built = buildSecuritySystem({ liveviews: [makeLiveviewConfig({ cameras: ["camera-home"], id: "lv-home", name: "Protect-Home" })] });

    activeController = built.controller;

    // The matching member (its ufp.id matches the Protect-Home slot camera) with detectMotion seeded FALSY, plus a non-member camera the fanout must NOT touch.
    const member = seedMember(built.nvr, { detectMotion: false, id: "camera-home", mac: "74ACB9000102", name: "Home Camera" });
    const nonMember = seedMember(built.nvr, { detectMotion: false, id: "camera-other", mac: "74ACB9000103", name: "Other Camera" });

    await settle();

    // Precondition: the member starts with motion OFF so the drive toward enabled is a genuine change (the write is change-gated on detectMotion !== targetState).
    assert.equal(member.accessory.context.detectMotion, false, "the member camera starts with motion detection off");
    assert.equal(member.motionSwitch.getCharacteristic(Characteristic.On).value, false, "the member motion switch starts off");

    // Drive the STAY_ARM scene through the real TargetState onSet (HomeKit's set path).
    await triggerSet(targetStateOf(built.accessory), TargetState.STAY_ARM);

    // The member FLIPPED on (the distinguishing assertion: false -> true, not merely ended true) and its context updated.
    assert.equal(member.motionSwitch.getCharacteristic(Characteristic.On).value, true, "the member's motion switch flipped on for the armed scene");
    assert.equal(member.accessory.context.detectMotion, true, "the member's detectMotion context flipped to true");

    // The production line is "%s -> %s: Motion detection %s." where viewScene is the lowercased "protect-home"; the formatted parameter carries the member and enabled.
    assert.ok(loggedAt(built.logEntries, "info", "protect-home -> Home Camera: Motion detection enabled."),
      "the per-member motion-enabled line fired with the scene and member");

    // The non-member was untouched (its id is not in the Protect-Home liveview).
    assert.equal(nonMember.accessory.context.detectMotion, false, "the non-member camera was left untouched");
    assert.equal(nonMember.motionSwitch.getCharacteristic(Characteristic.On).value, false, "the non-member motion switch stayed off");

    // CurrentState landed on STAY_ARM and the state published.
    assert.equal(built.accessory.getService(Service.SecuritySystem)?.getCharacteristic(CurrentState).value, CurrentState.STAY_ARM, "CurrentState landed on STAY_ARM");
    assert.ok(built.mqtt.published.some((published) => (published.topic === CONTROLLER_MAC + "/securitysystem") && (published.payload === "Home")),
      "the armed scene published the Home state");

    // Now drive the disarm direction from the true start to net the change the OTHER way (false-gate proven both directions).
    await triggerSet(targetStateOf(built.accessory), TargetState.DISARM);

    assert.equal(member.motionSwitch.getCharacteristic(Characteristic.On).value, false, "disarming flipped the member's motion switch back off");
    assert.equal(member.accessory.context.detectMotion, false, "disarming reset the member's detectMotion context");
    assert.ok(loggedAt(built.logEntries, "info", "Motion detection disabled."), "the per-member motion-disabled line fired on disarm");
  });

  test("setSecurityState skips a member whose controller record has vanished (the recordPresent gate) - FAILS WITHOUT THE GATE", async () => {

    // A Protect-Home liveview carrying TWO member camera ids: one present, one graced (its record vanished while it lingers in the removal grace).
    const built = buildSecuritySystem({ liveviews: [makeLiveviewConfig({ cameras: [ "camera-present", "camera-graced" ], id: "lv-home", name: "Protect-Home" })] });

    activeController = built.controller;

    // Both ids are in the SAME target liveview - the only difference is recordPresent. The graced member must be skipped by the security fanout's recordPresent gate
    // BEFORE the protectId match, so removing that gate would flip its motion switch true (this is what the test would catch).
    const present = seedMember(built.nvr, { detectMotion: false, id: "camera-present", mac: "74ACB9000104", name: "Present Camera" });
    const graced = seedMember(built.nvr, { detectMotion: false, id: "camera-graced", mac: "74ACB9000105", name: "Graced Camera", recordPresent: false });

    await settle();

    assert.equal(graced.motionSwitch.getCharacteristic(Characteristic.On).value, false, "the graced member starts with motion detection off");

    // Drive the STAY_ARM scene through the real TargetState onSet.
    await triggerSet(targetStateOf(built.accessory), TargetState.STAY_ARM);

    // The present member flipped on (its id is in the liveview and its record is present).
    assert.equal(present.motionSwitch.getCharacteristic(Characteristic.On).value, true, "the present member's motion switch flipped on for the armed scene");

    // The DISTINGUISHING assertions: the graced member's id is ALSO in the target liveview, so deleting the recordPresent gate would flip it true; the gate skips it
    // because its record has vanished, so its motion switch and detectMotion context stay untouched.
    assert.equal(graced.motionSwitch.getCharacteristic(Characteristic.On).value, false,
      "the recordPresent gate skipped the graced member - its motion switch stayed off despite its id matching the target liveview");
    assert.equal(graced.accessory.context.detectMotion, false, "the graced member's detectMotion context was left untouched");
  });

  test("setSecurityState sweeps only camera-family members - a sensor keeps its motion delivery through arm and disarm (the D3 blessed change)", async () => {

    // A Protect-Home liveview carrying one camera member. The sensor is NOT a liveview member (a sensor can never be one), seeded with detectMotion TRUE: the sweep must
    // leave it untouched through BOTH arm and disarm because the modelKey !== "camera" gate skips it before any state write. Without that gate an arm would find the
    // sensor a non-member and latch its detectMotion off (true -> false) - that is the distinguishing assertion.
    const built = buildSecuritySystem({ liveviews: [makeLiveviewConfig({ cameras: ["camera-home"], id: "lv-home", name: "Protect-Home" })] });

    activeController = built.controller;

    const camera = seedMember(built.nvr, { detectMotion: false, id: "camera-home", mac: "74ACB9000102", name: "Home Camera" });
    const sensor = seedMember(built.nvr, { detectMotion: true, id: "sensor-1", mac: "74ACB9000106", modelKey: "sensor", name: "Motion Sensor" });

    await settle();

    // Arm STAY_ARM: the camera member flips on, the sensor is skipped by the modelKey gate and keeps its detectMotion.
    await triggerSet(targetStateOf(built.accessory), TargetState.STAY_ARM);

    assert.equal(camera.accessory.context.detectMotion, true, "the camera member flipped on for the armed scene");
    assert.equal(sensor.accessory.context.detectMotion, true, "the sensor's detectMotion survived the arm - the modelKey gate skipped it");
    assert.equal(sensor.motionSwitch.getCharacteristic(Characteristic.On).value, true, "the sensor's motion switch was left untouched by the arm");

    // Disarm: the camera goes off, the sensor is STILL skipped and keeps its detectMotion (a disarm would otherwise latch every device off).
    await triggerSet(targetStateOf(built.accessory), TargetState.DISARM);

    assert.equal(camera.accessory.context.detectMotion, false, "the camera member went off on disarm");
    assert.equal(sensor.accessory.context.detectMotion, true, "the sensor's detectMotion survived the disarm too - its motion delivery is never latched off");
  });

  // A HomeKit write refuses with no liveviews standing, since none calls for the security system, so the MQTT set is the path that reaches the early return.
  test("setSecurityState early-returns with no liveviews configured (no state change, no publish)", async () => {

    const built = buildSecuritySystem({ liveviews: [] });

    activeController = built.controller;

    await settle();

    const publishedBefore = built.mqtt.published.length;

    await assert.rejects(triggerSet(targetStateOf(built.accessory), TargetState.AWAY_ARM), hapStatus(HAPStatus.SERVICE_COMMUNICATION_FAILURE),
      "a HomeKit write refuses with no liveviews standing");

    // With no liveviews the setSecurityState early-returns before any state write or publish.
    await built.mqtt.invokeSet(CONTROLLER_MAC + "/securitysystem/set", "away");

    assert.equal(built.accessory.getService(Service.SecuritySystem)?.getCharacteristic(CurrentState).value, CurrentState.DISARMED,
      "with no liveviews CurrentState stays Off - the early return fired");
    assert.equal(built.mqtt.published.length, publishedBefore, "the no-liveviews early return published nothing");
  });

  test("setSecurityState with a liveview but no member cameras for the target takes the no-target branch (state updates, the guidance logs)", async () => {

    // A Protect-Home liveview with NO member cameras: arming STAY_ARM finds no target cameras, so the no-target branch updates and publishes the state, as every other
    // set path does, and logs the create-a-liveview guidance.
    const built = buildSecuritySystem({ liveviews: [makeLiveviewConfig({ id: "lv-home", name: "Protect-Home" })] });

    activeController = built.controller;

    await settle();

    await triggerSet(targetStateOf(built.accessory), TargetState.STAY_ARM);

    assert.equal(built.accessory.getService(Service.SecuritySystem)?.getCharacteristic(CurrentState).value, CurrentState.STAY_ARM,
      "the no-target branch still updates CurrentState for the user");
    assert.deepEqual(built.mqtt.publishedTo(CONTROLLER_MAC + "/securitysystem").map((entry) => entry.payload), [ "Off", "Home" ],
      "the build stated the Off state once and the no-target branch published the Home state once");
    assert.ok(loggedAt(built.logEntries, "info", "No liveview configured for this security system state."), "the no-target branch logged the create-a-liveview guidance");
  });

  test("setSecurityState on the no-target branch clears a triggered alarm and publishes the scene, as the member path does", async () => {

    // The alarm is driven first, so the no-target arm has a latch to clear: the alarm Switch turns off, CurrentState shows the scene, and the publish names the scene
    // rather than the alarm.
    const built = buildSecuritySystem({ liveviews: [makeLiveviewConfig({ id: "lv-home", name: "Protect-Home" })], userOptions: ["Enable.SecuritySystem.Alarm"] });

    activeController = built.controller;

    await settle();
    await built.mqtt.invokeSet(CONTROLLER_MAC + "/securitysystem/set", "AlarmOn");
    await triggerSet(targetStateOf(built.accessory), TargetState.STAY_ARM);

    assert.equal(built.accessory.getService(Service.Switch)?.getCharacteristic(Characteristic.On).value, false, "the no-target arm turned the alarm Switch off");
    assert.equal(built.accessory.getService(Service.SecuritySystem)?.getCharacteristic(CurrentState).value, CurrentState.STAY_ARM, "CurrentState shows the scene");
    assert.deepEqual(built.mqtt.publishedTo(CONTROLLER_MAC + "/securitysystem").map((entry) => entry.payload), [ "Off", "Alarm", "Home" ],
      "the publish after the no-target arm names the scene, the alarm cleared");
  });

  test("setSecurityAlarm triggers the ALARM_TRIGGERED current state and the alarm Switch, and a reset returns to the held state", async () => {

    // A saved STAY_ARM is the held state, so the reset is told apart from the Off a security system with no saved state shows.
    const accessory = makeTestAccessory("Security System", CONTROLLER_MAC + ".Security");

    accessory.context.securityState = CurrentState.STAY_ARM;

    const built = buildSecuritySystem({ accessory, liveviews: [makeLiveviewConfig({ id: "lv-off", name: "Protect-Off" })],
      userOptions: ["Enable.SecuritySystem.Alarm"] });

    activeController = built.controller;

    await settle();

    const alarm = built.accessory.getService(Service.Switch);

    assert.ok(alarm, "the alarm Switch exists");

    // Trigger the alarm through the real On onSet (HomeKit's set path).
    await triggerSet(alarm.getCharacteristic(Characteristic.On), true);

    assert.equal(built.accessory.getService(Service.SecuritySystem)?.getCharacteristic(CurrentState).value, CurrentState.ALARM_TRIGGERED,
      "triggering the alarm drove CurrentState to ALARM_TRIGGERED");
    assert.equal(alarm.getCharacteristic(Characteristic.On).value, true, "the alarm Switch reflects the triggered state");
    assert.ok(built.mqtt.published.some((published) => (published.topic === CONTROLLER_MAC + "/securitysystem") && (published.payload === "Alarm")),
      "the alarm published the Alarm state");

    // Reset returns to the held securityState, the saved STAY_ARM.
    await triggerSet(alarm.getCharacteristic(Characteristic.On), false);

    assert.equal(built.accessory.getService(Service.SecuritySystem)?.getCharacteristic(CurrentState).value, CurrentState.STAY_ARM,
      "resetting the alarm returns CurrentState to the held STAY_ARM state");
    assert.equal(alarm.getCharacteristic(Characteristic.On).value, false, "the alarm Switch reflects the reset state");
  });

  test("aborting the controller signal ends the MQTT subscription lifetime", async () => {

    const built = buildSecuritySystem();

    activeController = built.controller;

    await settle();

    const subscription = built.mqtt.subscriptions.find((entry) => (entry.kind === "get") && (entry.topic === CONTROLLER_MAC + "/securitysystem/get"));

    assert.equal(subscription?.init.signal?.aborted, false, "the GET registration's lifetime is live before the controller abort");

    built.controller.abort();

    await settle();

    assert.equal(subscription.init.signal.aborted, true, "the GET registration's lifetime ended with the controller abort");
    assert.equal(built.store.observerCount, 0, "the owner-driven security system registers and leaks no observers");
  });
});

describe("the security system's state stated as it is built and restated per broker session", () => {

  test("it states its current state once as it is built, and a session restore restates it once", async () => {

    const built = buildSecuritySystem();

    try {

      await settle();

      assert.equal(built.mqtt.publishedTo("/securitysystem").length, 1, "the current state is stated once as the security system is built");

      built.mqtt.connected = false;
      await settle();
      built.mqtt.connected = true;
      await settle();

      assert.equal(built.mqtt.publishedTo("/securitysystem").length, 2, "the restore restates the current state once more");
    } finally {

      built.controller.abort();
    }
  });

  test("built while no session is held, it records nothing until the session starts, then its current state once", async () => {

    const built = buildSecuritySystem({ disconnected: true });

    try {

      await settle();

      assert.equal(built.mqtt.published.length, 0, "the statement made with no session held is refused");

      built.mqtt.connected = true;
      await settle();

      assert.equal(built.mqtt.publishedTo("/securitysystem").length, 1, "the first session states the current state once");
    } finally {

      built.controller.abort();
    }
  });

  test("a state set while the session is down is restated once, as the current state, when the session returns", async () => {

    const built = buildSecuritySystem({ liveviews: [makeLiveviewConfig({ cameras: ["camera-home"], id: "lv-home", name: "Protect-Home" })] });

    try {

      await settle();

      built.mqtt.connected = false;
      await settle();
      await triggerSet(targetStateOf(built.accessory), TargetState.STAY_ARM);
      await settle();

      assert.equal(built.mqtt.publishedTo("/securitysystem").length, 1, "only the build statement is recorded, the set made with no session held being refused");

      built.mqtt.connected = true;
      await settle();

      assert.deepEqual(built.mqtt.publishedTo("/securitysystem").slice(1).map((entry) => entry.payload), ["Home"], "the returning session hears the current state once");
    } finally {

      built.controller.abort();
    }
  });
});

describe("the security system's saved scene shown as it is built", () => {

  /* A restart constructs every camera before the liveviews owner builds the security system, and each camera persists its own motion detection setting, which is the
   * source of truth for it. The saved scene is shown as the security system is built and nothing is applied, so a camera the user changed after setting the scene
   * keeps that choice: here the saved scene is armed away, its liveview names one camera, and every camera starts with motion detection on, the one the scene leaves
   * out included.
   */
  test("a saved scene is shown as the security system is built, nothing is applied to the cameras, and the build states its state once", async () => {

    const accessory = makeTestAccessory("Security System", CONTROLLER_MAC + ".Security");
    const cameras: ReturnType<typeof seedMember>[] = [];

    accessory.context.securityState = CurrentState.AWAY_ARM;

    const built = buildSecuritySystem({ accessory, liveviews: [makeLiveviewConfig({ cameras: ["camera-away"], id: "lv-away", name: "Protect-Away" })],
      seed: (nvr) => void cameras.push(seedMember(nvr, { detectMotion: true, id: "camera-away", mac: "74ACB9000101", name: "Away Camera" }),
        seedMember(nvr, { detectMotion: true, id: "camera-other", mac: "74ACB9000103", name: "Other Camera" })) });

    try {

      await settle();

      const [ member, nonMember ] = cameras;
      const security = built.accessory.getService(Service.SecuritySystem);

      assert.ok(member && nonMember, "the cameras were constructed before the security system was built");
      assert.equal(security?.getCharacteristic(CurrentState).value, CurrentState.AWAY_ARM, "the security system shows the saved scene");
      assert.equal(security.getCharacteristic(TargetState).value, TargetState.AWAY_ARM, "and its target state shows the saved scene");
      assert.equal(member.accessory.context.detectMotion, true, "the camera the scene names keeps motion detection on");
      assert.equal(nonMember.accessory.context.detectMotion, true, "the camera the scene leaves out keeps the motion detection setting it persists itself");
      assert.equal(nonMember.motionSwitch.getCharacteristic(Characteristic.On).value, true, "and its motion switch still shows motion detection on");
      assert.ok(!loggedAt(built.logEntries, "info", "Setting the liveview scene"), "no scene was applied");
      assert.deepEqual(built.mqtt.publishedTo("/securitysystem").map((entry) => entry.payload), ["Away"], "the build states the saved state once and only once");
    } finally {

      built.controller.abort();
    }
  });

  /* An accessory the user has never set carries no saved scene. It shows Off, stores no state of the plugin's own, and applies nothing to the cameras: applying Off,
   * or any default scene, would turn off motion detection on the camera here, which no Protect-Home slot names.
   */
  test("a security system the user has never set shows Off, stores no state, and applies no scene", async () => {

    const cameras: ReturnType<typeof seedMember>[] = [];
    const built = buildSecuritySystem({ liveviews: [makeLiveviewConfig({ cameras: ["camera-home"], id: "lv-home", name: "Protect-Home" })],
      seed: (nvr) => void cameras.push(seedMember(nvr, { detectMotion: true, id: "camera-other", mac: "74ACB9000103", name: "Other Camera" })) });

    try {

      await settle();

      const [nonMember] = cameras;
      const security = built.accessory.getService(Service.SecuritySystem);

      assert.ok(nonMember, "the camera was constructed before the security system was built");
      assert.equal(security?.getCharacteristic(CurrentState).value, CurrentState.DISARMED, "the security system shows Off");
      assert.equal(security.getCharacteristic(TargetState).value, TargetState.DISARM, "and its target state shows Off");
      assert.deepEqual(built.mqtt.publishedTo("/securitysystem").map((entry) => entry.payload), ["Off"], "the build states Off once and only once");
      assert.equal(built.accessory.context.securityState, undefined, "no security state is stored until the user sets one");
      assert.equal(nonMember.accessory.context.detectMotion, true, "a camera no scene names keeps motion detection on");
      assert.ok(!loggedAt(built.logEntries, "info", "Setting the liveview scene"), "no scene was applied");
      assert.ok(!loggedAt(built.logEntries, "info", "No liveview configured for this security system state."), "no scene was attempted");
    } finally {

      built.controller.abort();
    }
  });
});
