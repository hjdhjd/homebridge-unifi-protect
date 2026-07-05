/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * live-attach.test.ts: The live-attach reclassification end to end - a plain camera the controller late-flips to a doorbell composes its DoorbellCapability onto
 * the running instance in place, rebuilding only the one HAP object that cannot change in place (the CameraController), and exactly when it was built for the wrong
 * doorbell-ness.
 *
 * Suite C (live-attach) drives a real ProtectCamera constructed as a plain camera (isDoorbell false, a real stub-factory stream built with builtFor.isDoorbell false) and
 * pushes isDoorbell true: the always-armed isDoorbell observer attaches it, and the featureFlags observer drives the capability reconcile, whose audio rebuild
 * fires the in-place controller rebuild a late doorbell-ness needs. The capability attaches, the Doorbell service is primary, the census grows to seventeen, the
 * accessory's ordered controller-event log shows EXACTLY one removeController then one configureController (the rebuild), the stream's builtFor.isDoorbell is now
 * true, the ring MQTT is registered exactly once, and one promotion INFO is logged. It then pins the no-churn cases: a construction-attach (a flag-true construction)
 * yields the same service set with ZERO removeController (the stub stream is built with builtFor.isDoorbell true, so the gate is a no-op), an idempotent re-push does
 * not re-attach or churn the controller, a within-drain flap self-collapses to no WARN and no churn, and a SETTLED demotion raises exactly one WARN while removing
 * nothing. Suite D (sweep-stale) pre-seeds a plain camera accessory with stale doorbell-only services and asserts removeServices strips exactly those - the chime
 * switches, the volume lightbulb, the auth sensor, and a message switch - while leaving the Doorbell, mute, HKSV-recording, and UFP-recording switches untouched, and
 * asserts the stub delegate's builtFor.isDoorbell tracks the constructed isDoorbell (the harness observability into the otherwise-frozen audio derivation).
 *
 * Honesty notes recorded rather than papered over: the hub-side behavior of the rebuilt CameraController (the HKSV factory reset, the supported-config hash change) is a
 * live-gate concern - the harness proves the remove-then-configure ORDERING and COUNT at this event, which is the assertable contract; and the post-attach ring-delivery
 * path is exercised only to the registration boundary (the subscription is recorded), not through a live MQTT broker.
 */
import { G2_PRO_CHANNELS, G6_PRO_ENTRY_CHANNELS } from "../../camera.fixtures.ts";
import { Service, TestCameraProjection, TestStateStore, makeCameraConfig, makeProtectState, makeTestAccessory, makeTestNvr, settle } from "../../testing.helpers.ts";
import type { TestAccessory, TestLogEntry, TestProtectNvr } from "../../testing.helpers.ts";
import { describe, test } from "node:test";
import type { Camera } from "unifi-protect";
import type { ProtectAccessory } from "../../types.ts";
import { ProtectCamera } from "./camera.ts";
import type { ProtectNvr } from "../../nvr/nvr.ts";
import { ProtectReservedNames } from "../../types.ts";
import assert from "node:assert/strict";

// Construct a real ProtectCamera, with the casts confined to this one seam - the instance under test is the production class and its composed capability.
function construct(nvr: TestProtectNvr, accessory: TestAccessory, projection: TestCameraProjection): ProtectCamera {

  return new ProtectCamera(nvr as unknown as ProtectNvr, accessory as unknown as ProtectAccessory, projection as unknown as Camera);
}

// The count of log lines at the given level whose first format string contains the given fragment - the harness records the raw parameters,
// so we match the message template.
function countLogs(entries: TestLogEntry[], level: TestLogEntry["level"], fragment: string): number {

  return entries.filter((entry) => (entry.level === level) && (typeof entry.parameters[0] === "string") && entry.parameters[0].includes(fragment)).length;
}

describe("live-attach reclassification (suite C)", () => {

  test("a late isDoorbell flip composes the capability in place and rebuilds the controller exactly once", async () => {

    const cameraConfig = makeCameraConfig({ channels: G6_PRO_ENTRY_CHANNELS, featureFlags: { isDoorbell: false }, name: "Front Door" });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { controller, logEntries, mqtt, nvr } = makeTestNvr({ mqtt: true, store });
    const accessory = makeTestAccessory("Front Door", "uuid:74ACB9000001");
    const camera = construct(nvr, accessory, new TestCameraProjection(cameraConfig.id, store));

    await settle();

    // Preconditions: a plain camera with no capability, a stream built for a non-doorbell, no Doorbell service, and no ring MQTT registration.
    assert.equal(camera.doorbell, null, "the plain camera carries no doorbell capability before the flip");
    assert.equal(camera.stream?.builtFor.isDoorbell, false, "the construction-built stream was built for a non-doorbell");
    assert.equal(accessory.getService(Service.Doorbell), undefined, "no Doorbell service exists before the flip");

    const churnBaseline = accessory.controllerEvents.length;
    const ringBefore = mqtt?.subscriptions.filter((subscription) => subscription.topic.endsWith("/doorbell")).length ?? 0;

    assert.equal(ringBefore, 0, "the plain camera registered no ring-trigger MQTT");

    // The promotion: the controller now reports this camera as a doorbell.
    store.pushCameraFeatureFlags(cameraConfig.id, { isDoorbell: true });

    await settle();

    // The capability composed onto the running instance, the Doorbell service is present and primary, and the census grew to seventeen (the capability four onto the
    // plain-camera-plus-base thirteen, which already carries the always-armed isDoorbell observer, the bare-motion lastMotion observer, the capability-reconcile
    // featureFlags observer, and the Access-lock supportUnlock observer).
    assert.ok(camera.doorbell, "the doorbell capability attached onto the live camera");

    const doorbellService = accessory.getService(Service.Doorbell);

    assert.ok(doorbellService, "the Doorbell service now exists");
    assert.equal(doorbellService.isPrimary, true, "the Doorbell service is primary");
    assert.equal(store.observerCount, 17, "the promoted camera carries the seventeen-observer doorbell census");

    // The rebuild fires exactly one removeController then one configureController, in that order, at this event, since the CameraController is the one HAP
    // object that cannot change in place and must be torn down and reconfigured to pick up the HKSV factory reset and supported-config hash change.
    const churn = accessory.controllerEvents.slice(churnBaseline);

    assert.equal(churn.length, 2, "the rebuild fired exactly two controller events");
    assert.equal(churn[0]?.kind, "remove", "the first controller event is the removeController");
    assert.equal(churn[1]?.kind, "configure", "the second controller event is the configureController");

    // The freshly built stream is now built for a doorbell, and the ring MQTT registered exactly once.
    assert.equal(camera.stream?.builtFor.isDoorbell, true, "the rebuilt stream is now built for a doorbell");
    assert.equal(mqtt?.subscriptions.filter((subscription) => subscription.topic.endsWith("/doorbell")).length, 1, "the ring-trigger MQTT registered exactly once");

    // Exactly one user-facing promotion INFO.
    assert.equal(countLogs(logEntries, "info", "now reports this camera as a doorbell"), 1, "the promotion logged exactly one INFO line");

    controller.abort();
  });

  test("a construction-attach yields the same service set with zero controller churn", async () => {

    const cameraConfig = makeCameraConfig({ channels: G6_PRO_ENTRY_CHANNELS, featureFlags: { isDoorbell: true }, name: "Front Door" });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { controller, nvr } = makeTestNvr({ store });
    const accessory = makeTestAccessory("Front Door", "uuid:74ACB9000002");
    const camera = construct(nvr, accessory, new TestCameraProjection(cameraConfig.id, store));

    await settle();

    // The same end state as the late flip - the capability and a primary Doorbell service - but the stream was built for a doorbell at construction, so the rebuild gate
    // never fired: exactly one configureController and ZERO removeController.
    assert.ok(camera.doorbell, "the construction-attach produced the capability");
    assert.equal(accessory.getService(Service.Doorbell)?.isPrimary, true, "the Doorbell service is present and primary");
    assert.equal(accessory.removeControllerCalls.length, 0, "a construction-attach performs zero removeController - no stale controller to rebuild");
    assert.equal(accessory.configureControllerCalls.length, 1, "the construction-attach registered its controller exactly once");
    assert.equal(camera.stream?.builtFor.isDoorbell, true, "the construction-built stream was built for a doorbell from the start");

    controller.abort();
  });

  test("an idempotent re-push of isDoorbell does not re-attach or churn the controller", async () => {

    const cameraConfig = makeCameraConfig({ channels: G6_PRO_ENTRY_CHANNELS, featureFlags: { isDoorbell: false }, name: "Front Door" });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { controller, nvr } = makeTestNvr({ store });
    const accessory = makeTestAccessory("Front Door", "uuid:74ACB9000003");
    const camera = construct(nvr, accessory, new TestCameraProjection(cameraConfig.id, store));

    await settle();
    store.pushCameraFeatureFlags(cameraConfig.id, { isDoorbell: true });
    await settle();

    const capabilityAfterFirst = camera.doorbell;
    const churnAfterFirst = accessory.controllerEvents.length;

    // A second push of the same value: the store dedups it, but even a redundant wake resolves to "none" (hasCapability true, isDoorbell true), so nothing re-attaches
    // and the controller does not churn.
    store.pushCameraFeatureFlags(cameraConfig.id, { isDoorbell: true });
    await settle();

    assert.equal(camera.doorbell, capabilityAfterFirst, "the same capability instance persists - no re-attach");
    assert.equal(accessory.controllerEvents.length, churnAfterFirst, "the redundant push drove zero further controller churn");

    controller.abort();
  });

  test("a within-drain flap self-collapses to no warning and no controller churn", async () => {

    const cameraConfig = makeCameraConfig({ channels: G6_PRO_ENTRY_CHANNELS, featureFlags: { isDoorbell: true }, name: "Front Door" });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { controller, logEntries, nvr } = makeTestNvr({ store });
    const accessory = makeTestAccessory("Front Door", "uuid:74ACB9000004");
    const camera = construct(nvr, accessory, new TestCameraProjection(cameraConfig.id, store));

    await settle();

    const warnBaseline = logEntries.filter((entry) => entry.level === "warn").length;
    const churnBaseline = accessory.controllerEvents.length;

    // The flap: isDoorbell drops then returns before any consumer drains. The reconcile re-reads live state, which has recovered to true, so it resolves to "none".
    store.pushCameraFeatureFlags(cameraConfig.id, { isDoorbell: false });
    store.pushCameraFeatureFlags(cameraConfig.id, { isDoorbell: true });

    await settle();

    assert.ok(camera.doorbell, "the capability survives the flap");
    assert.equal(logEntries.filter((entry) => entry.level === "warn").length, warnBaseline, "the within-drain flap raised no withdrawal warning");
    assert.equal(accessory.controllerEvents.length, churnBaseline, "the flap drove zero controller churn");

    controller.abort();
  });

  test("a settled demotion raises exactly one withdrawal warning and removes nothing", async () => {

    const cameraConfig = makeCameraConfig({ channels: G6_PRO_ENTRY_CHANNELS, featureFlags: { isDoorbell: true }, name: "Front Door" });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { controller, logEntries, nvr } = makeTestNvr({ store });
    const accessory = makeTestAccessory("Front Door", "uuid:74ACB9000005");
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
});

describe("sweep-stale removal and the audio-derivation observability (suite D)", () => {

  test("removeServices strips exactly the doorbell-only services, leaving the Doorbell, mute, HKSV, and UFP services untouched", () => {

    // The SSOT removal contract, exercised directly through the NVR's sweep seam (which routes to the real DoorbellCapability.removeServices). We hand-seed an accessory
    // with the doorbell-only services a demoted-while-down doorbell would leave behind, plus the camera-level / owned-elsewhere services that must survive, then assert
    // the sweep strips exactly the former. Driving removeServices directly isolates its own selectivity from the feature-gated construction configures (the mute switch,
    // HKSV switch, and Doorbell service each have their own removers in the construction path).
    const store = new TestStateStore(makeProtectState({ cameras: [makeCameraConfig({ channels: G6_PRO_ENTRY_CHANNELS, featureFlags: { isDoorbell: false } })] }));
    const { controller, nvr } = makeTestNvr({ store });
    const accessory = makeTestAccessory("Front Door", "uuid:74ACB9000006");

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

    nvr.removeStaleDoorbellServices(accessory as unknown as ProtectAccessory);

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

    controller.abort();
  });

  test("a plain-camera construction with no capability runs the sweep-stale arm, removing the seeded doorbell-only services", async () => {

    // The construction-path proof that the reconcile's sweep-stale arm fires: a plain camera (isDoorbell false) attaches no capability, so reconcileDoorbellCapability
    // resolves to "sweep-stale" and runs the removal. We assert the doorbell-only services seeded before construction are gone afterward - the camera-level services are
    // governed by their own feature-gated configures and are not the subject here (the direct removeServices test above pins the selectivity).
    const cameraConfig = makeCameraConfig({ channels: G6_PRO_ENTRY_CHANNELS, featureFlags: { isDoorbell: false }, name: "Front Door" });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { controller, nvr } = makeTestNvr({ store });
    const accessory = makeTestAccessory("Front Door", "uuid:74ACB9000009");

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

  test("the stub delegate's builtFor.isDoorbell tracks the constructed isDoorbell - the harness observability into the frozen audio derivation", async () => {

    // A plain camera builds a stream for a non-doorbell; a doorbell builds one for a doorbell. This is the only harness window into the otherwise constructor-frozen
    // audio-options derivation, and it is exactly the value the capability reconcile's staleness gate reads.
    const plainConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { isDoorbell: false } });
    const plainStore = new TestStateStore(makeProtectState({ cameras: [plainConfig] }));
    const plain = makeTestNvr({ store: plainStore });
    const plainCamera = construct(plain.nvr, makeTestAccessory("Plain", "uuid:74ACB9000007"), new TestCameraProjection(plainConfig.id, plainStore));

    const doorbellConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { isDoorbell: true } });
    const doorbellStore = new TestStateStore(makeProtectState({ cameras: [doorbellConfig] }));
    const door = makeTestNvr({ store: doorbellStore });
    const doorbellCamera = construct(door.nvr, makeTestAccessory("Doorbell", "uuid:74ACB9000008"), new TestCameraProjection(doorbellConfig.id, doorbellStore));

    await settle();

    assert.equal(plainCamera.stream?.builtFor.isDoorbell, false, "a plain camera's stream is built for a non-doorbell");
    assert.equal(doorbellCamera.stream?.builtFor.isDoorbell, true, "a doorbell's stream is built for a doorbell");

    plain.controller.abort();
    door.controller.abort();
  });
});
