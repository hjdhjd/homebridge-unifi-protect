/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * live-attach.test.ts: The live-attach reclassification end to end - a plain camera the controller late-flips to a doorbell composes its DoorbellCapability onto
 * the running instance in place, rebuilding only the one HAP object that cannot change in place (the CameraController), and exactly when it was built for the wrong
 * doorbell-ness.
 *
 * Suite C (live-attach) drives a real ProtectCamera constructed as a plain camera (isDoorbell false, a real stub-factory stream built with builtFor.isDoorbell false) and
 * pushes isDoorbell true: the always-armed isDoorbell observer attaches it, and the featureFlags observer drives the capability reconcile, whose controller-identity
 * reconcile fires the in-place controller rebuild a late doorbell-ness needs. The capability attaches, the Doorbell service is primary, the census grows to nineteen, the
 * accessory's ordered controller-event log shows EXACTLY one removeController then one configureController (the rebuild), the stream's builtFor.isDoorbell is now
 * true, the ring MQTT is registered exactly once, and one promotion INFO is logged. It then pins the no-churn cases: a construction-attach (a flag-true construction)
 * yields the same service set with ZERO removeController (the stub stream is built with builtFor.isDoorbell true, so the gate is a no-op), an unchanged re-push does
 * not re-attach or churn the controller, a within-drain flap self-collapses to no WARN and no churn, and a SETTLED demotion raises exactly one WARN while removing
 * nothing. Suite D (sweep-stale) pre-seeds a plain camera accessory with stale doorbell-only services and asserts removeServices strips exactly those - the chime
 * switches, the volume lightbulb, the auth sensor, and a message switch - while leaving the Doorbell, mute, HKSV-recording, and UFP-recording switches untouched, and
 * asserts the stub delegate's builtFor.isDoorbell tracks the constructed isDoorbell (the harness observability into the otherwise-frozen controller identity).
 *
 * Honesty notes recorded rather than papered over: the hub-side behavior of the rebuilt CameraController (the HKSV factory reset, the supported-config hash change) is a
 * live-gate concern - the harness proves the remove-then-configure ORDERING and COUNT at this event, which is the assertable contract; and the post-attach ring-delivery
 * path is exercised only to the registration boundary (the subscription is recorded), not through a live MQTT broker.
 */
import { G2_PRO_CHANNELS, G6_PRO_ENTRY_CHANNELS } from "../../camera.fixtures.ts";
import { Service, TestStateStore, controllerEvents, makeProtectState, makeTestAccessory } from "../../testing.helpers.ts";
import { TestCameraProjection, makeCameraConfig } from "../testing.helpers.ts";
import { describe, test } from "node:test";
import { logCount, settle } from "homebridge-plugin-utils/testing";
import { makeTestNvr, restoreAccessories } from "../../nvr/testing.helpers.ts";
import { ACCESSORY_SAVE_WINDOW_MS } from "homebridge-plugin-utils";
import type { Camera } from "unifi-protect";
import { ProtectCamera } from "./camera.ts";
import type { ProtectNvr } from "../../nvr/nvr.ts";
import { ProtectReservedNames } from "../../types.ts";
import type { TestProtectAccessory } from "../../testing.helpers.ts";
import type { TestProtectNvr } from "../../nvr/testing.helpers.ts";
import assert from "node:assert/strict";
import { configured } from "../device-base.ts";

// Construct a real ProtectCamera, with the casts confined to this one boundary - the instance under test is the production class and its composed capability.
function construct(nvr: TestProtectNvr, accessory: TestProtectAccessory, projection: TestCameraProjection): ProtectCamera {

  return configured(new ProtectCamera(nvr as unknown as ProtectNvr, accessory, projection as unknown as Camera));
}

describe("live-attach reclassification (suite C)", () => {

  test("a late isDoorbell flip composes the capability in place and rebuilds the controller exactly once", async () => {

    const cameraConfig = makeCameraConfig({ channels: G6_PRO_ENTRY_CHANNELS, featureFlags: { isDoorbell: false }, name: "Front Door" });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { controller, logEntries, mqtt, nvr } = makeTestNvr({ mqtt: true, store });
    const accessory = makeTestAccessory("Front Door", "74ACB9000001");
    const camera = construct(nvr, accessory, new TestCameraProjection(cameraConfig.id, store));

    await settle();

    // Preconditions: a plain camera with no capability, a stream built for a non-doorbell, no Doorbell service, and no ring MQTT registration.
    assert.equal(camera.doorbell, null, "the plain camera carries no doorbell capability before the flip");
    assert.equal(camera.stream?.builtFor.isDoorbell, false, "the construction-built stream was built for a non-doorbell");
    assert.equal(accessory.getService(Service.Doorbell), undefined, "no Doorbell service exists before the flip");

    const churnBaseline = controllerEvents(accessory).length;
    const ringBefore = mqtt?.subscriptions.filter((subscription) => subscription.topic.endsWith("/doorbell/set")).length ?? 0;

    assert.equal(ringBefore, 0, "the plain camera registered no ring-trigger MQTT");

    // The promotion: the controller now reports this camera as a doorbell.
    store.pushCameraFeatureFlags(cameraConfig.id, { isDoorbell: true });

    await settle();

    // The capability composed onto the running instance, the Doorbell service is present and primary, and the census grew to nineteen (the capability four onto the
    // plain-camera-plus-base fifteen, which already carries the always-armed isDoorbell observer, the bare-motion lastMotion observer, the capability-reconcile
    // featureFlags observer, the Access-lock supportUnlock observer, and the HomeKit Secure Video eligibility observer).
    assert.ok(camera.doorbell, "the doorbell capability attached onto the live camera");

    const doorbellService = accessory.getService(Service.Doorbell);

    assert.ok(doorbellService, "the Doorbell service now exists");
    assert.equal(doorbellService.isPrimaryService, true, "the Doorbell service is primary");
    assert.equal(store.observerCount, 20, "the promoted camera carries the doorbell census, with its MQTT availability observer");

    // The rebuild fires exactly one removeController then one configureController, in that order, at this event, since the CameraController is the one HAP
    // object that cannot change in place and must be torn down and reconfigured to pick up the HKSV factory reset and supported-config hash change.
    const churn = controllerEvents(accessory).slice(churnBaseline);

    assert.equal(churn.length, 2, "the rebuild fired exactly two controller events");
    assert.equal(churn[0]?.kind, "remove", "the first controller event is the removeController");
    assert.equal(churn[1]?.kind, "configure", "the second controller event is the configureController");

    // The freshly built stream is now built for a doorbell, and the ring MQTT registered exactly once.
    assert.equal(camera.stream.builtFor.isDoorbell, true, "the rebuilt stream is now built for a doorbell");
    assert.equal(mqtt?.subscriptions.filter((subscription) => subscription.topic.endsWith("/doorbell/set")).length, 1, "the ring-trigger MQTT registered exactly once");

    // Exactly one user-facing promotion INFO.
    assert.equal(logCount(logEntries, "info", "now reports this camera as a doorbell"), 1, "the promotion logged exactly one INFO line");

    controller.abort();
  });

  test("a construction-attach yields the same service set with zero controller churn", async () => {

    const cameraConfig = makeCameraConfig({ channels: G6_PRO_ENTRY_CHANNELS, featureFlags: { isDoorbell: true }, name: "Front Door" });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { controller, nvr } = makeTestNvr({ store });
    const accessory = makeTestAccessory("Front Door", "74ACB9000002");
    const camera = construct(nvr, accessory, new TestCameraProjection(cameraConfig.id, store));

    await settle();

    // The same end state as the late flip - the capability and a primary Doorbell service - but the stream was built for a doorbell at construction, so the rebuild gate
    // never fired: exactly one configureController and ZERO removeController.
    assert.ok(camera.doorbell, "the construction-attach produced the capability");
    assert.equal(accessory.getService(Service.Doorbell)?.isPrimaryService, true, "the Doorbell service is present and primary");
    assert.deepEqual(controllerEvents(accessory).map((event) => event.kind), ["configure"],
      "a construction-attach registered its controller exactly once and removed none - no stale controller to rebuild");
    assert.equal(camera.stream?.builtFor.isDoorbell, true, "the construction-built stream was built for a doorbell from the start");

    controller.abort();
  });

  test("a repeated isDoorbell push does not re-attach or churn the controller", async () => {

    const cameraConfig = makeCameraConfig({ channels: G6_PRO_ENTRY_CHANNELS, featureFlags: { isDoorbell: false }, name: "Front Door" });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { controller, nvr } = makeTestNvr({ store });
    const accessory = makeTestAccessory("Front Door", "74ACB9000003");
    const camera = construct(nvr, accessory, new TestCameraProjection(cameraConfig.id, store));

    await settle();
    store.pushCameraFeatureFlags(cameraConfig.id, { isDoorbell: true });
    await settle();

    const capabilityAfterFirst = camera.doorbell;
    const churnAfterFirst = controllerEvents(accessory).length;

    // A second push of the same value: the store dedups it, but even a redundant wake resolves to "none" (hasCapability true, isDoorbell true), so nothing re-attaches
    // and the controller does not churn.
    store.pushCameraFeatureFlags(cameraConfig.id, { isDoorbell: true });
    await settle();

    assert.equal(camera.doorbell, capabilityAfterFirst, "the same capability instance persists - no re-attach");
    assert.equal(controllerEvents(accessory).length, churnAfterFirst, "the redundant push drove zero further controller churn");

    controller.abort();
  });

  test("a within-drain flap self-collapses to no warning and no controller churn", async () => {

    const cameraConfig = makeCameraConfig({ channels: G6_PRO_ENTRY_CHANNELS, featureFlags: { isDoorbell: true }, name: "Front Door" });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { controller, logEntries, nvr } = makeTestNvr({ store });
    const accessory = makeTestAccessory("Front Door", "74ACB9000004");
    const camera = construct(nvr, accessory, new TestCameraProjection(cameraConfig.id, store));

    await settle();

    const warnBaseline = logEntries.filter((entry) => entry.level === "warn").length;
    const churnBaseline = controllerEvents(accessory).length;

    // The flap: isDoorbell drops then returns before any consumer drains. The reconcile re-reads live state, which has recovered to true, so it resolves to "none".
    store.pushCameraFeatureFlags(cameraConfig.id, { isDoorbell: false });
    store.pushCameraFeatureFlags(cameraConfig.id, { isDoorbell: true });

    await settle();

    assert.ok(camera.doorbell, "the capability survives the flap");
    assert.equal(logEntries.filter((entry) => entry.level === "warn").length, warnBaseline, "the within-drain flap raised no withdrawal warning");
    assert.equal(controllerEvents(accessory).length, churnBaseline, "the flap drove zero controller churn");

    controller.abort();
  });

  test("a settled demotion raises exactly one withdrawal warning and removes nothing", async () => {

    // The doorbell carries a microphone, so the demotion's block keeps a true flag and is a reading rather than the controller's drain frame.
    const cameraConfig = makeCameraConfig({ channels: G6_PRO_ENTRY_CHANNELS, featureFlags: { hasMic: true, isDoorbell: true }, name: "Front Door" });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { controller, logEntries, nvr } = makeTestNvr({ store });
    const accessory = makeTestAccessory("Front Door", "74ACB9000005");
    const camera = construct(nvr, accessory, new TestCameraProjection(cameraConfig.id, store));

    await settle();

    const warnBaseline = logEntries.filter((entry) => entry.level === "warn").length;

    // The demotion: isDoorbell drops and settles. The reconcile resolves to "report-withdrawn" - observability-only.
    store.pushCameraFeatureFlags(cameraConfig.id, { isDoorbell: false });

    await settle();

    assert.equal(logEntries.filter((entry) => entry.level === "warn").length - warnBaseline, 1, "the settled demotion logged exactly one withdrawal warning");
    assert.ok(camera.doorbell, "the capability remains attached - the withdrawal removes nothing (promotion-only)");
    assert.ok(accessory.getService(Service.Doorbell), "the Doorbell service remains after the demotion warning");

    controller.abort();
  });

  /* The controller's drain frame against a real demotion. A deep re-adopt delivers the whole featureFlags block with every flag false before the real values follow,
   * so the doorbell reads false alongside every other flag and the narrator has to read the block as no reading: no withdrawal is warned and the doorbell's services
   * stay. Once the real values land, a genuine demotion - isDoorbell false beside a microphone the block still reports - warns exactly once.
   */
  test("the drain frame raises no doorbell withdrawal and keeps the services, while a demotion beside a true flag warns once", async () => {

    const cameraConfig = makeCameraConfig({ channels: G6_PRO_ENTRY_CHANNELS, featureFlags: { hasMic: true, isDoorbell: true }, name: "Front Door" });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { controller, logEntries, nvr } = makeTestNvr({ store });
    const accessory = makeTestAccessory("Front Door", "74ACB9000006");
    const camera = construct(nvr, accessory, new TestCameraProjection(cameraConfig.id, store));
    const withdrawal = "no longer reports this camera as a doorbell";

    await settle();

    assert.ok(camera.doorbell, "the doorbell capability attached at construction");

    store.pushCameraFeatureFlagsDrain(cameraConfig.id);

    await settle();

    assert.equal(camera.ufp.featureFlags.isDoorbell, false, "the vacuity guard: the drain frame reads the doorbell false");
    assert.equal(logCount(logEntries, "warn", withdrawal), 0, "the drain frame raised no doorbell withdrawal");
    assert.ok(camera.doorbell, "the capability remains attached across the drain frame");
    assert.ok(accessory.getService(Service.Doorbell), "the Doorbell service remains across the drain frame");

    // The real values land, then the controller genuinely stops reporting the doorbell while the microphone stays reported.
    store.pushCameraFeatureFlags(cameraConfig.id, { hasMic: true, hasMotionDetection: true, isDoorbell: true });

    await settle();

    store.pushCameraFeatureFlags(cameraConfig.id, { isDoorbell: false });

    await settle();

    assert.equal(logCount(logEntries, "warn", withdrawal), 1, "the genuine demotion raised exactly one doorbell withdrawal");
    assert.ok(accessory.getService(Service.Doorbell), "the Doorbell service remains after the demotion warning");

    camera.cleanup();
    controller.abort();
  });
});

describe("sweep-stale removal and the controller-identity observability (suite D)", () => {

  test("removeServices strips exactly the doorbell-only services, leaving the Doorbell, mute, HKSV, and UFP services untouched", () => {

    // The SSOT removal contract, exercised directly through the NVR's sweep hook (which routes to the real DoorbellCapability.removeServices). We hand-seed an accessory
    // with the doorbell-only services a demoted-while-down doorbell would leave behind, plus the camera-level / owned-elsewhere services that must survive, then assert
    // the sweep strips exactly the former. Driving removeServices directly isolates its own selectivity from the feature-gated construction configures (the mute switch,
    // HKSV switch, and Doorbell service each have their own removers in the construction path).
    const store = new TestStateStore(makeProtectState({ cameras: [makeCameraConfig({ channels: G6_PRO_ENTRY_CHANNELS, featureFlags: { isDoorbell: false } })] }));
    const { api, clock, controller, nvr } = makeTestNvr({ store });
    const accessory = makeTestAccessory("Front Door", "74ACB9000006");

    // The accessory is the cached one a restart restores, on the bridge, so the persistence saves it.
    restoreAccessories(nvr, [accessory]);

    // The doorbell-only services that must be removed.
    accessory.addService(Service.Switch, "Physical Chime None", ProtectReservedNames.SWITCH_DOORBELL_CHIME_NONE);
    accessory.addService(Service.Lightbulb, "Chime Volume", ProtectReservedNames.LIGHTBULB_DOORBELL_VOLUME);
    accessory.addService(Service.ContactSensor, "Authenticated", ProtectReservedNames.CONTACT_AUTHSENSOR);
    accessory.addService(Service.Switch, "Welcome Home", "LCD.Welcome Home");

    // The camera-level / owned-elsewhere services that MUST survive the sweep.
    accessory.addService(Service.Doorbell, "Doorbell");
    accessory.addService(Service.Switch, "Doorbell Mute", ProtectReservedNames.SWITCH_DOORBELL_MUTE);
    accessory.addService(Service.Switch, "HKSV Recording", ProtectReservedNames.SWITCH_HKSV_RECORDING);
    accessory.addService(Service.Switch, "UFP Recording Always", ProtectReservedNames.SWITCH_UFP_RECORDING_ALWAYS);

    nvr.removeStaleDoorbellServices(accessory);

    // The doorbell-only services are gone.
    assert.equal(accessory.getServiceById(Service.Switch, ProtectReservedNames.SWITCH_DOORBELL_CHIME_NONE), undefined, "the physical-chime switch was swept");
    assert.equal(accessory.getServiceById(Service.Lightbulb, ProtectReservedNames.LIGHTBULB_DOORBELL_VOLUME), undefined, "the chime-volume lightbulb was swept");
    assert.equal(accessory.getServiceById(Service.ContactSensor, ProtectReservedNames.CONTACT_AUTHSENSOR), undefined, "the auth contact sensor was swept");
    assert.equal(accessory.getServiceById(Service.Switch, "LCD.Welcome Home"), undefined, "the non-reserved message switch was swept");

    // The camera-level / owned-elsewhere services survive - removeServices deliberately excludes them.
    assert.ok(accessory.getService(Service.Doorbell), "the Doorbell service is untouched (left to configureDoorbellTrigger's own removal arm)");
    assert.ok(accessory.getServiceById(Service.Switch, ProtectReservedNames.SWITCH_DOORBELL_MUTE), "the mute switch is untouched by removeServices");
    assert.ok(accessory.getServiceById(Service.Switch, ProtectReservedNames.SWITCH_HKSV_RECORDING), "the HKSV-recording switch is untouched by removeServices");
    assert.ok(accessory.getServiceById(Service.Switch, ProtectReservedNames.SWITCH_UFP_RECORDING_ALWAYS), "the UFP-recording switch is untouched by removeServices");

    // A sweep that removed something marks the accessory, so the window it opened saves it once, while a sweep with nothing left to remove marks nothing, so a steady
    // plain camera's sweep asks for no save.
    const saves = (): number => api.calls.filter((call) => (call.kind === "update") && call.accessories.includes(accessory)).length;

    clock.advance(ACCESSORY_SAVE_WINDOW_MS);

    assert.equal(saves(), 1, "the sweep that removed services saved the accessory once");

    nvr.removeStaleDoorbellServices(accessory);
    clock.advance(ACCESSORY_SAVE_WINDOW_MS);

    assert.equal(saves(), 1, "a sweep with nothing left to remove asks for no save");

    controller.abort();
  });

  test("a plain-camera construction with no capability runs the sweep-stale arm, removing the seeded doorbell-only services", async () => {

    // The construction-path proof that the reconcile's sweep-stale arm fires: a plain camera (isDoorbell false) attaches no capability, so reconcileDoorbellCapability
    // resolves to "sweep-stale" and runs the removal. We assert the doorbell-only services seeded before construction are gone afterward - the camera-level services are
    // governed by their own feature-gated configures and are not the subject here (the direct removeServices test above pins the selectivity).
    const cameraConfig = makeCameraConfig({ channels: G6_PRO_ENTRY_CHANNELS, featureFlags: { isDoorbell: false }, name: "Front Door" });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { controller, nvr } = makeTestNvr({ store });
    const accessory = makeTestAccessory("Front Door", "74ACB9000009");

    accessory.addService(Service.Switch, "Physical Chime None", ProtectReservedNames.SWITCH_DOORBELL_CHIME_NONE);
    accessory.addService(Service.Lightbulb, "Chime Volume", ProtectReservedNames.LIGHTBULB_DOORBELL_VOLUME);
    accessory.addService(Service.ContactSensor, "Authenticated", ProtectReservedNames.CONTACT_AUTHSENSOR);

    const camera = construct(nvr, accessory, new TestCameraProjection(cameraConfig.id, store));

    await settle();

    assert.equal(camera.doorbell, null, "the plain camera attached no doorbell capability, so the reconcile resolved to sweep-stale");
    assert.equal(accessory.getServiceById(Service.Switch, ProtectReservedNames.SWITCH_DOORBELL_CHIME_NONE), undefined, "the stale physical-chime switch was swept");
    assert.equal(accessory.getServiceById(Service.Lightbulb, ProtectReservedNames.LIGHTBULB_DOORBELL_VOLUME), undefined, "the stale chime-volume lightbulb was swept");
    assert.equal(accessory.getServiceById(Service.ContactSensor, ProtectReservedNames.CONTACT_AUTHSENSOR), undefined, "the stale auth contact sensor was swept");

    controller.abort();
  });

  test("the stub delegate's builtFor.isDoorbell tracks the constructed isDoorbell - the harness observability into the frozen controller identity", async () => {

    // A plain camera builds a stream for a non-doorbell; a doorbell builds one for a doorbell. This is the harness window into the otherwise constructor-frozen
    // controller identity, and it is exactly the value the capability reconcile's staleness gate reads.
    const plainConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { isDoorbell: false } });
    const plainStore = new TestStateStore(makeProtectState({ cameras: [plainConfig] }));
    const plain = makeTestNvr({ store: plainStore });
    const plainCamera = construct(plain.nvr, makeTestAccessory("Plain", "74ACB9000007"), new TestCameraProjection(plainConfig.id, plainStore));

    const doorbellConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { isDoorbell: true } });
    const doorbellStore = new TestStateStore(makeProtectState({ cameras: [doorbellConfig] }));
    const door = makeTestNvr({ store: doorbellStore });
    const doorbellCamera = construct(door.nvr, makeTestAccessory("Doorbell", "74ACB9000008"), new TestCameraProjection(doorbellConfig.id, doorbellStore));

    await settle();

    assert.equal(plainCamera.stream?.builtFor.isDoorbell, false, "a plain camera's stream is built for a non-doorbell");
    assert.equal(doorbellCamera.stream?.builtFor.isDoorbell, true, "a doorbell's stream is built for a doorbell");

    plain.controller.abort();
    door.controller.abort();
  });
});
