/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * testing.helpers.test.ts: Unit tests for the controller-subsystem test helpers in testing.helpers.ts.
 *
 * The NVR double is the controller every device test is constructed against, so a defect in its removal machinery, its managed-device registry, or its config builder
 * would corrupt whole families of tests at once. These rows pin the surfaces production reaches for through its owner: the removal timers and stability gate, the MQTT
 * recording double, the accessory-family builder, and the read-through config getters.
 */
import { TestCameraProjection, makeCameraConfig, makeSensorConfig } from "../devices/testing.helpers.ts";
import { TestStateStore, makeProtectState, makeTestAccessory } from "../testing.helpers.ts";
import { describe, test } from "node:test";
import { makeNvrConfig, makeTestAccessoryFamily, makeTestNvr } from "./testing.helpers.ts";
import type { ProtectDevices } from "../types.ts";
import assert from "node:assert/strict";

describe("harness growth: NVR removal machinery", () => {

  test("scheduleDeviceRemoval honors the registered DelayDeviceRemoval default and the fire body re-checks stability and stillGone", () => {

    const store = new TestStateStore(makeProtectState());
    const { nvr } = makeTestNvr({ store });
    const accessory = makeTestAccessory("Victim", "uuid:victim");

    nvr.platform.accessories.push(accessory);
    nvr.scheduleDeviceRemoval({ accessory, stillGone: () => true });

    // The registered default is 60 seconds, so the schedule defers rather than removing immediately.
    assert.equal(nvr.scheduledRemovals.length, 1, "the schedule decision is recorded");
    assert.equal(nvr.scheduledRemovals[0]?.interval, 60, "the interval resolves to the registered DelayDeviceRemoval default");
    assert.ok(nvr.removalTimers.has(accessory.UUID), "a manually-fireable timer entry is recorded");
    assert.ok(nvr.platform.accessories.includes(accessory), "the accessory survives until the grace fires");

    // A second schedule while one is pending is idempotent, mirroring production.
    nvr.scheduleDeviceRemoval({ accessory, stillGone: () => true });

    assert.equal(nvr.scheduledRemovals.length, 1, "a pending removal dedups a re-schedule");

    nvr.removalTimers.get(accessory.UUID)?.fire();

    assert.equal(nvr.platform.accessories.includes(accessory), false, "the fired grace removes the accessory through the tail");
    assert.equal(nvr.removalTimers.size, 0, "the fired timer entry is deleted");
  });

  test("the stability gate suppresses scheduling and a stale fire after cancellation is a no-op", () => {

    const store = new TestStateStore(makeProtectState());
    const { nvr } = makeTestNvr({ store });
    const accessory = makeTestAccessory("Victim", "uuid:victim");

    nvr.platform.accessories.push(accessory);
    nvr.removalStable = false;
    nvr.scheduleDeviceRemoval({ accessory, stillGone: () => true });

    assert.equal(nvr.scheduledRemovals.length, 0, "an unstable controller schedules nothing");

    nvr.removalStable = true;
    nvr.scheduleDeviceRemoval({ accessory, stillGone: () => true });

    const entry = nvr.removalTimers.get(accessory.UUID);

    nvr.cancelDeviceRemovalFor(accessory.UUID);

    assert.deepEqual(nvr.cancelledRemovals, [accessory.UUID], "the cancellation is recorded");

    // A captured stale fire after cancellation still runs its body, but the production-mirroring re-checks make it harmless when stillGone holds; here we prove the
    // presence guard half by firing after the accessory was already removed another way.
    nvr.removeAccessoryFromHomeKit(accessory);
    entry?.fire();

    assert.equal(nvr.platform.accessories.length, 0, "the stale fire is a no-op against the already-removed accessory");
  });

  test("user-disabling DelayDeviceRemoval makes removal immediate and the tail is presence-guarded and bridged-gated", () => {

    const store = new TestStateStore(makeProtectState());
    const { apiCalls, nvr } = makeTestNvr({ store, userOptions: ["Disable.Nvr.DelayDeviceRemoval"] });
    const bystander = makeTestAccessory("Bystander", "uuid:bystander");
    const victim = makeTestAccessory("Victim", "uuid:victim");

    nvr.platform.accessories.push(victim, bystander);
    nvr.scheduleDeviceRemoval({ accessory: victim, stillGone: () => true });

    assert.equal(nvr.scheduledRemovals[0]?.interval, 0, "the disabled option resolves to the immediate path");
    assert.equal(nvr.removalTimers.size, 0, "no timer is recorded on the immediate path");
    assert.deepEqual(nvr.platform.accessories, [bystander], "the accessory is removed synchronously");
    assert.equal(apiCalls.filter((call) => call.kind === "unregister").length, 1, "a bridged accessory records exactly one unregister");

    // The presence guard: a double-removal must be a no-op, never a splice of an unrelated accessory.
    nvr.removeAccessoryFromHomeKit(victim);

    assert.deepEqual(nvr.platform.accessories, [bystander], "a stale double-removal leaves the platform array intact");

    // The bridged gate: an unbridged accessory is spliced but never unregistered.
    bystander._associatedHAPAccessory.bridged = false;
    nvr.removeAccessoryFromHomeKit(bystander);

    assert.equal(nvr.platform.accessories.length, 0, "the unbridged accessory is spliced");
    assert.equal(apiCalls.filter((call) => call.kind === "unregister").length, 1, "no unregister is recorded for an unbridged accessory");
  });
});

describe("harness growth: MQTT recording double and the family builder", () => {

  test("the MQTT double is opt-in and records publishes and subscription registrations with their init options", async () => {

    const store = new TestStateStore(makeProtectState());
    const withoutMqtt = makeTestNvr({ store });

    assert.equal(withoutMqtt.mqtt, null, "the default NVR double carries no MQTT client, matching an unconfigured broker");

    const { mqtt } = makeTestNvr({ mqtt: true, store });

    assert.ok(mqtt, "opting in installs the recording double");

    const signal = new AbortController().signal;

    await mqtt.publish("74ACB9000001/motion", "true");
    mqtt.subscribeGet("74ACB9000001/motion", "motion", () => "false", { signal });

    assert.deepEqual(mqtt.published, [{ message: "true", topic: "74ACB9000001/motion" }], "publishes are recorded");
    assert.equal(mqtt.subscriptions.length, 1, "subscription registrations are recorded");
    assert.equal(mqtt.subscriptions[0]?.init?.signal, signal, "the per-subscription init options - including the lifetime signal - are recorded");
  });

  test("the family builder produces a restart-shaped bridged pair with exact production context keys", () => {

    const store = new TestStateStore(makeProtectState());
    const { nvr } = makeTestNvr({ store });
    const { packageAccessory, parentAccessory } = makeTestAccessoryFamily({ nvr });

    assert.deepEqual(nvr.platform.accessories, [ parentAccessory, packageAccessory ], "both cached accessories land in the platform array");
    assert.deepEqual(parentAccessory.context, { mac: "74ACB9000001", nvr: nvr.ufp.mac }, "the parent context carries the production mac and nvr keys");
    assert.deepEqual(packageAccessory.context, { nvr: nvr.ufp.mac, packageCamera: "74ACB9000001" }, "the package context carries nvr and packageCamera, never mac");
    assert.equal(packageAccessory.UUID, "uuid:74ACB9000001.PackageCamera", "the package UUID pins the persistence-critical identity-suffix fixture");
    assert.ok(parentAccessory._associatedHAPAccessory.bridged && packageAccessory._associatedHAPAccessory.bridged,
      "a restart restore only ever contains bridged accessories");
  });
});

describe("A2 controller owners: the widened makeNvrConfig, the read-through client.nvr.config getter, and pushNvrPatch", () => {

  test("makeNvrConfig populates the controller-owner read set and preserves the load-bearing mac / host / ports byte-for-byte", () => {

    const defaults = makeNvrConfig();

    // The construction read set the real ProtectNvrSystemInfo needs: a populated systemInfo (the initial pass dereferences systemInfo.cpu.temperature with no optional
    // chaining and the MQTT handler JSON.stringifies the whole object), a marketName / name for the accessory display name and setInfo's Model, and a type for the Model
    // fallback.
    assert.equal(defaults.systemInfo.cpu.temperature, 40, "systemInfo.cpu.temperature defaults to a number so the initial-pass deref succeeds");
    assert.equal(defaults.marketName, "UniFi Dream Machine SE", "marketName defaults so the accessory name and setInfo's Model resolve");
    assert.equal(defaults.name, "Test Controller", "name defaults so sanitizeName(nvr.ufp.name) resolves");
    assert.equal(defaults.type, "UDMPRO", "type defaults so setInfo's marketName ?? type Model fallback is non-empty");

    // LOAD-BEARING: the chime / ringtone nvrMac filter and the makeRingtoneConfig nvrMac default both depend on this exact mac, and the golden-master channel URLs depend
    // on the exact host / ports, so the widening must only ADD fields.
    assert.equal(defaults.mac, "74ACB9FFFFFF", "the controller mac is preserved byte-for-byte");
    assert.equal(defaults.host, "nvr.test", "the host is preserved byte-for-byte");
    assert.deepEqual(defaults.ports, { rtsp: 7447, rtsps: 7441 }, "the RTSP(S) ports are preserved byte-for-byte");

    // hardwareRevision is intentionally absent so setInfo's HardwareRevision length-guard stays short-circuited (the security-system config owns that marker).
    assert.equal((defaults as { hardwareRevision?: string }).hardwareRevision, undefined, "hardwareRevision is left unset so setInfo skips the HardwareRevision write");

    // The temperature option overrides systemInfo.cpu.temperature so the observer reaction can be driven to a known value.
    const warm = makeNvrConfig({ temperature: 42 });

    assert.equal(warm.systemInfo.cpu.temperature, 42, "the temperature option moves systemInfo.cpu.temperature");
  });

  test("client.nvr.config reads THROUGH the store's nvr slice and falls back to a stable default when the slice is null", () => {

    // Seed the store nvr slice non-null: nvr.ufp must read the SEEDED record (not a held value), so the systemInfo temperature reads through to the production getter.
    const seededStore = new TestStateStore(makeProtectState({ nvr: makeNvrConfig({ temperature: 42 }) }));
    const { nvr: seededNvr } = makeTestNvr({ store: seededStore });

    assert.equal(seededNvr.ufp.systemInfo.cpu.temperature, 42, "nvr.ufp reads through the seeded store nvr slice, not a held default");

    // A pushNvrPatch moving systemInfo by reference is reflected by nvr.ufp - the SSOT read-through that lets the owner's observer reaction be non-vacuous.
    seededStore.pushNvrPatch({ systemInfo: { ...seededNvr.ufp.systemInfo, cpu: { ...seededNvr.ufp.systemInfo.cpu, temperature: 99 } } });

    assert.equal(seededNvr.ufp.systemInfo.cpu.temperature, 99, "a pushNvrPatch is reflected by nvr.ufp through the read-through getter");

    // A store with NO nvr slice falls back to the stable default (the existing camera consumers never seed the slice and must keep reading a fixed record).
    const emptyStore = new TestStateStore(makeProtectState());
    const { nvr: emptyNvr } = makeTestNvr({ store: emptyStore });

    assert.equal(emptyNvr.ufp.mac, "74ACB9FFFFFF", "an unseeded nvr slice falls back to the stable default controller record");
    assert.ok(Object.is(emptyNvr.ufp, emptyNvr.ufp), "the fallback default is a stable reference across reads");
  });

  test("pushNvrPatch rebuilds only the nvr slice with a fresh systemInfo reference and guards an absent slice", () => {

    const sensor = makeSensorConfig({ id: "sensor-x" });
    const store = new TestStateStore(makeProtectState({ nvr: makeNvrConfig(), sensors: [sensor] }));
    const before = store.snapshot();
    const beforeNvr = before.nvr;

    assert.ok(beforeNvr, "the seeded store carries an nvr slice");

    store.pushNvrPatch({ systemInfo: { ...beforeNvr.systemInfo, cpu: { ...beforeNvr.systemInfo.cpu, temperature: 55 } } });

    const after = store.snapshot();

    assert.notEqual(after.nvr, beforeNvr, "the patched nvr record is a fresh reference");
    assert.notEqual(after.nvr?.systemInfo, beforeNvr.systemInfo, "the systemInfo is a fresh reference so a narrow systemInfo selector wakes");
    assert.equal(after.nvr?.systemInfo.cpu.temperature, 55, "the patch applied to the nvr record");
    assert.ok(Object.is(after.sensors, before.sensors), "the untouched sensors slice keeps its reference");
    assert.ok(Object.is(after.sensors.get("sensor-x"), before.sensors.get("sensor-x")), "the untouched sensor record keeps its reference");

    // The slice-absent guard: a null nvr slice cannot be patched (the patch composes over the live record).
    const emptyStore = new TestStateStore(makeProtectState());

    assert.throws(() => emptyStore.pushNvrPatch({ systemInfo: beforeNvr.systemInfo }), /The nvr record to patch is not present in the store double/,
      "patching an absent nvr slice throws the store-double guard");
  });
});

describe("A2 controller owners, commit 2: the managed-device registry and the new NVR builder option", () => {

  test("getDeviceById resolves a seeded managed device by protectId and survives a vanished record", () => {

    // A store-backed member, not a static stub: its ufp reads through the store (and throws once the record is removed) while its protectId comes from the projection's
    // stable id field and stays non-throwing. That is what makes the absence assertion non-vacuous - getDeviceById must keep resolving by protectId after a
    // removeCameraRecord, not merely "not throw" against a stub that could never throw. (membershipDelta is an orthogonal set-diff guard, not a survival proxy.)
    const camera = makeCameraConfig({ channels: [] });
    const store = new TestStateStore(makeProtectState({ cameras: [camera] }));
    const { nvr } = makeTestNvr({ store });
    const projection = new TestCameraProjection(camera.id, store);
    const accessory = makeTestAccessory("Member Camera", "uuid:member-camera");
    const member = { accessory, accessoryName: "Member Camera", protectId: projection.id, get ufp() { return projection.config; } } as unknown as ProtectDevices;

    nvr.configuredDevices.set(accessory.UUID, member);

    // Present: getDeviceById resolves the member by its protectId, mirroring the production one-liner, and returns null for an unmatched id.
    assert.equal(nvr.getDeviceById(camera.id), member, "getDeviceById finds the seeded member by its protectId");
    assert.equal(nvr.getDeviceById("camera-absent"), null, "getDeviceById returns null when no managed device matches the id");

    // The record vanishes from the store. Reading the member's ufp would now throw, but getDeviceById matches on the non-throwing protectId, so it still resolves it.
    store.removeCameraRecord(camera.id);

    assert.throws(() => member.ufp, "the member's ufp reads through the store and throws once the record is removed - the absence case is genuinely store-backed");
    assert.equal(nvr.getDeviceById(camera.id), member, "getDeviceById still resolves the member by its non-throwing protectId after the record vanished");
  });

  test("makeNvrConfig leaves hardwareRevision absent by default and lands an opted-in value (the committed undefined assertion is unchanged)", () => {

    // The OPT-IN contract: the default still omits the field (the committed default-omission assertion at the top of this file stays green), while an explicitly-passed
    // value lands so the security-system owner's unconditional HardwareRevision write is non-vacuous. The conditional spread keeps the key ABSENT (not present-as-
    // undefined) on the default, so an `in` check sees the pre-marker shape.
    const defaults = makeNvrConfig() as { hardwareRevision?: string };

    assert.equal(defaults.hardwareRevision, undefined, "the default makeNvrConfig leaves hardwareRevision unset");
    assert.equal("hardwareRevision" in defaults, false, "the default omits the key entirely rather than carrying it as present-but-undefined");

    const opted = makeNvrConfig({ hardwareRevision: "1.0.0" }) as { hardwareRevision?: string };

    assert.equal(opted.hardwareRevision, "1.0.0", "an opted-in hardwareRevision lands on the record for the security-system owner to write");
  });
});
