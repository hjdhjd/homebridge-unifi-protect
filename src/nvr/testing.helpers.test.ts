/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * testing.helpers.test.ts: Unit tests for the controller-subsystem test helpers in testing.helpers.ts.
 *
 * The NVR double is the controller every device test is constructed against, so a defect in the way it wires the removal gate, the reboot scheduler, its managed-device
 * registry, or its config builder would corrupt whole families of tests at once. These rows pin the surfaces production reaches for through its owner: the double's
 * wiring of the real removal gate and the removal tail behind it, its wiring of the real reboot scheduler and the recording count behind that, the MQTT recording
 * double, the accessory-family builder, and the read-through config getters.
 *
 * The removal and reboot rows drive their companions the way production does - facts and suppliers in, timers armed on a real TimerRegistry - so they drive time by
 * advancing the double's test clock. Each companion's own arithmetic, drain rules, and narration are asserted directly in nvr-removal.test.ts and nvr-reboot.test.ts;
 * what these rows assert is the DOUBLE: that its wiring resolves the same grace production resolves, that its recording walk reaches the same population production's
 * endpoint walk reaches, and that a fired decision lands on the double's accessory graph through its removal tail.
 */
import { PROTECT_NVR_REBOOT_CHECK_INTERVAL, PROTECT_NVR_REBOOT_INTERVAL } from "../settings.ts";
import { TestCameraProjection, makeCameraConfig, makeSensorConfig } from "../devices/testing.helpers.ts";
import { TestStateStore, accessoryUuid, makeProtectState, makeTestAccessory } from "../testing.helpers.ts";
import { describe, test } from "node:test";
import { formatLogEntry, settle } from "homebridge-plugin-utils/testing";
import { makeNvrConfig, makeTestAccessoryFamily, makeTestNvr, restoreAccessories } from "./testing.helpers.ts";
import { ACCESSORY_SAVE_WINDOW_MS } from "homebridge-plugin-utils";
import type { ProtectDevices } from "../types.ts";
import type { TestLogEntry } from "homebridge-plugin-utils/testing";
import assert from "node:assert/strict";

// Every "Delaying device removal" line the gate narrated, as the harness rendered it. The line carries the resolved grace, so the count of these lines is the
// schedule-dedup observable and the text is the exact-interval pin.
function delayingLines(entries: readonly TestLogEntry[]): string[] {

  return entries.filter((entry) => formatLogEntry(entry).includes("Delaying device removal")).map((entry) => formatLogEntry(entry));
}

// Every deferral line the reboot scheduler narrated. The line carries the recording count, so its text is the population pin the widening rows read.
function deferringLines(entries: readonly TestLogEntry[]): string[] {

  return entries.filter((entry) => formatLogEntry(entry).includes("Deferring scheduled controller reboot")).map((entry) => formatLogEntry(entry));
}

// The default reboot cadence in milliseconds, which is what a schedule entered with no explicit interval waits.
const DEFAULT_INTERVAL_MS = PROTECT_NVR_REBOOT_INTERVAL * 60 * 60 * 1000;

describe("harness growth: the NVR double's removal wiring", () => {

  test("the double's wiring resolves the registered DelayDeviceRemoval default and the fired grace removes through the tail", () => {

    const store = new TestStateStore(makeProtectState());
    const { api, clock, controller, logEntries, nvr } = makeTestNvr({ store });
    const accessory = makeTestAccessory("Victim", "74ACB9000201");

    restoreAccessories(nvr, [accessory]);

    try {

      // Take the controller through a disruption and back to stable on the double's test clock, so the grace below arms from a settled controller.
      nvr.restabilizeController();

      nvr.removals.schedule({ accessory: accessory, stillGone: () => true });

      assert.ok(nvr.platform.accessories.includes(accessory), "the accessory survives until the grace fires");

      // A second schedule while one is pending keeps the first deadline, and the gate does that silently - so the ONE narration line across BOTH calls is what proves
      // the redundant schedule deduped, and its text is the resolved-interval pin.
      nvr.removals.schedule({ accessory: accessory, stillGone: () => true });

      assert.deepEqual(delayingLines(logEntries), ["Victim: Delaying device removal for at least 60 seconds."],
        "exactly one delay line across both schedules, carrying the registered sixty-second default");

      clock.advance(60000);

      assert.equal(nvr.platform.accessories.includes(accessory), false, "the fired grace removed the accessory through the double's removal tail");
      assert.equal(api.calls.filter((call) => call.kind === "unregister").length, 1, "the fired grace unregistered the bridged accessory exactly once");
    } finally {

      controller.abort();
    }
  });

  test("an unstable controller schedules nothing through the double, and the same call arms once stability returns", () => {

    const store = new TestStateStore(makeProtectState());
    const { clock, controller, logEntries, nvr } = makeTestNvr({ store });
    const accessory = makeTestAccessory("Victim", "74ACB9000201");

    restoreAccessories(nvr, [accessory]);

    try {

      nvr.pushControllerStability(false);
      nvr.removals.schedule({ accessory: accessory, stillGone: () => true });

      // The gate checks stability before it narrates anything, so a suppressed schedule leaves no line at all - and nothing is armed to fire later.
      assert.deepEqual(delayingLines(logEntries), [], "an unstable controller schedules nothing and narrates nothing");

      clock.advance(600000);

      assert.ok(nvr.platform.accessories.includes(accessory), "no removal ran while the controller was unstable");

      // The positive control that keeps the suppression above from passing vacuously: the identical call, once stability returns, arms and fires.
      nvr.restabilizeController();
      nvr.removals.schedule({ accessory: accessory, stillGone: () => true });

      assert.equal(delayingLines(logEntries).length, 1, "the restabilized controller armed the grace the unstable one refused");

      clock.advance(60000);

      assert.equal(nvr.platform.accessories.includes(accessory), false, "the armed grace fired and removed the accessory");
    } finally {

      controller.abort();
    }
  });

  test("user-disabling DelayDeviceRemoval makes removal immediate and the tail is presence-guarded and bridged-gated", () => {

    const store = new TestStateStore(makeProtectState());
    const { api, controller, logEntries, nvr } = makeTestNvr({ store, userOptions: ["Disable.Nvr.DelayDeviceRemoval"] });
    const bystander = makeTestAccessory("Bystander", "74ACB9000202");
    const victim = makeTestAccessory("Victim", "74ACB9000201");

    // The victim is a cached accessory, restored onto the bridge. The bystander joins the platform array without joining the bridge, as a standalone accessory does,
    // so the tail's bridged gate has an accessory to refuse below.
    restoreAccessories(nvr, [victim]);
    nvr.platform.accessories.push(bystander);
    nvr.removals.schedule({ accessory: victim, stillGone: () => true });

    // The immediate path proves itself: the removal already happened when the call returned, and no delay was narrated because none was taken. The construction seed
    // leaves the controller stable, so this needs no clock ceremony at all.
    assert.deepEqual(nvr.platform.accessories, [bystander], "the disabled option removed the accessory synchronously");
    assert.deepEqual(delayingLines(logEntries), [], "no delay line is narrated on the immediate path");
    assert.equal(api.calls.filter((call) => call.kind === "unregister").length, 1, "a bridged accessory records exactly one unregister");

    // The presence guard: a double-removal must be a no-op, never a splice of an unrelated accessory.
    nvr.removeAccessoryFromHomeKit(victim);

    assert.deepEqual(nvr.platform.accessories, [bystander], "a stale double-removal leaves the platform array intact");

    // The bridged gate: an unbridged accessory is spliced but never unregistered.
    nvr.removeAccessoryFromHomeKit(bystander);

    assert.equal(nvr.platform.accessories.length, 0, "the unbridged accessory is spliced");
    assert.equal(api.calls.filter((call) => call.kind === "unregister").length, 1, "no unregister is recorded for an unbridged accessory");

    controller.abort();
  });

  /* Homebridge returns to its cache every accessory an update names, so a save still pending for an accessory the tail removes would bring it back at the next start.
   * A survivor and a victim are marked inside one save window, and the victim is removed before the window closes: the window's save names the survivor alone,
   * which is also what shows the window did close.
   */
  test("the removal tail drops a removed accessory's pending save, so the save its window closes on names only the survivor", () => {

    const store = new TestStateStore(makeProtectState());
    const { api, clock, controller, nvr } = makeTestNvr({ store });
    const survivor = makeTestAccessory("Survivor", "74ACB9000203");
    const victim = makeTestAccessory("Victim", "74ACB9000201");

    restoreAccessories(nvr, [ victim, survivor ]);

    try {

      nvr.platform.persistence.persist(victim, { detectMotion: false });
      nvr.platform.persistence.persist(survivor, { detectMotion: false });
      nvr.removeAccessoryFromHomeKit(victim);
      clock.advance(ACCESSORY_SAVE_WINDOW_MS);

      const saved = api.calls.filter((call) => call.kind === "update").flatMap((call) => call.accessories);

      assert.equal(api.calls.filter((call) => (call.kind === "unregister") && call.accessories.includes(victim)).length, 1, "the bridged victim was unregistered");
      assert.deepEqual(saved, [survivor], "the window's one save names the survivor and never the removed accessory");
    } finally {

      controller.abort();
    }
  });
});

describe("harness growth: MQTT recording double and the family builder", () => {

  test("the MQTT double is opt-in and records publishes and subscription registrations with their init options", async () => {

    const store = new TestStateStore(makeProtectState());
    const withoutMqtt = makeTestNvr({ store });

    assert.equal(withoutMqtt.mqtt, null, "the default NVR double carries no MQTT client, matching an unconfigured broker");

    const { controller, mqtt } = makeTestNvr({ mqtt: true, store });

    assert.ok(mqtt, "opting in installs the recording double");

    const signal = new AbortController().signal;

    await mqtt.publish("74ACB9000001/motion", "true");
    mqtt.subscribeGet("74ACB9000001/motion", "motion", () => "false", { signal });

    assert.deepEqual(mqtt.published, [{ payload: "true", retain: false, topic: "74ACB9000001/motion" }], "publishes are recorded");
    assert.equal(mqtt.subscriptions.length, 1, "subscription registrations are recorded");
    assert.equal(mqtt.subscriptions[0]?.init.signal, signal, "the per-subscription init options - including the lifetime signal - are recorded");

    withoutMqtt.controller.abort();
    controller.abort();
  });

  test("the family builder produces a restart-shaped bridged pair with exact production context keys", () => {

    const store = new TestStateStore(makeProtectState());
    const { controller, nvr } = makeTestNvr({ store });
    const { packageAccessory, parentAccessory } = makeTestAccessoryFamily({ nvr });

    assert.deepEqual(nvr.platform.accessories, [ parentAccessory, packageAccessory ], "both cached accessories land in the platform array");
    assert.deepEqual(parentAccessory.context, { mac: "74ACB9000001", nvr: nvr.ufp.mac }, "the parent context carries the production mac and nvr keys");
    assert.deepEqual(packageAccessory.context, { nvr: nvr.ufp.mac, packageCamera: "74ACB9000001" }, "the package context carries nvr and packageCamera, never mac");
    assert.equal(packageAccessory.UUID, accessoryUuid("74ACB9000001.PackageCamera"), "the package UUID holds the persistence-critical identity-suffix fixture fixed");
    assert.ok(parentAccessory._associatedHAPAccessory.bridged && packageAccessory._associatedHAPAccessory.bridged,
      "a restart restore only ever contains bridged accessories");

    controller.abort();
  });
});

describe("A2 controller owners: the widened makeNvrConfig, the read-through client.nvr.config getter, and pushNvrPatch", () => {

  test("makeNvrConfig populates the controller-owner read set and preserves the required mac / host / ports byte-for-byte", () => {

    const defaults = makeNvrConfig();

    // The construction read set the real ProtectNvrSystemInfo needs: a populated systemInfo (the initial pass dereferences systemInfo.cpu.temperature with no optional
    // chaining and the MQTT handler JSON.stringifies the whole object), a marketName / name for the accessory display name and setInfo's Model, and a type for the Model
    // fallback.
    assert.equal(defaults.systemInfo.cpu.temperature, 40, "systemInfo.cpu.temperature defaults to a number so the initial-pass deref succeeds");
    assert.equal(defaults.marketName, "UniFi Dream Machine SE", "marketName defaults so the accessory name and setInfo's Model resolve");
    assert.equal(defaults.name, "Test Controller", "name defaults so sanitizeName(nvr.ufp.name) resolves");
    assert.equal(defaults.type, "UDMPRO", "type defaults so the model resolver has a hardware type to fall back on");

    // REQUIRED EXACTLY AS WRITTEN: the chime / ringtone nvrMac filter and the makeRingtoneConfig nvrMac default both depend on this exact mac, and the golden-master
    // channel URLs depend on the exact host / ports, so the widening must only ADD fields.
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
    const { controller: seededController, nvr: seededNvr } = makeTestNvr({ store: seededStore });

    assert.equal(seededNvr.ufp.systemInfo.cpu.temperature, 42, "nvr.ufp reads through the seeded store nvr slice, not a held default");

    // A pushNvrPatch moving systemInfo by reference is reflected by nvr.ufp - the SSOT read-through that lets the owner's observer reaction be non-vacuous.
    seededStore.pushNvrPatch({ systemInfo: { ...seededNvr.ufp.systemInfo, cpu: { ...seededNvr.ufp.systemInfo.cpu, temperature: 99 } } });

    assert.equal(seededNvr.ufp.systemInfo.cpu.temperature, 99, "a pushNvrPatch is reflected by nvr.ufp through the read-through getter");

    // A store with NO nvr slice falls back to the stable default (the existing camera consumers never seed the slice and must keep reading a fixed record).
    const emptyStore = new TestStateStore(makeProtectState());
    const { controller: emptyController, nvr: emptyNvr } = makeTestNvr({ store: emptyStore });

    assert.equal(emptyNvr.ufp.mac, "74ACB9FFFFFF", "an unseeded nvr slice falls back to the stable default controller record");
    assert.ok(Object.is(emptyNvr.ufp, emptyNvr.ufp), "the fallback default is a stable reference across reads");

    seededController.abort();
    emptyController.abort();
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
    // removeCameraRecord, not merely "not throw" against a stub that could never throw. (membershipDelta is an unrelated set-diff guard, not a survival proxy.)
    const camera = makeCameraConfig({ channels: [] });
    const store = new TestStateStore(makeProtectState({ cameras: [camera] }));
    const { controller, nvr } = makeTestNvr({ store });
    const projection = new TestCameraProjection(camera.id, store);
    const accessory = makeTestAccessory("Member Camera", camera.mac);
    const member = { accessory, accessoryName: "Member Camera", protectId: projection.id, get ufp() { return projection.config; } } as unknown as ProtectDevices;

    nvr.configuredDevices.set(accessory.UUID, member);

    // Present: getDeviceById resolves the member by its protectId, mirroring the production one-liner, and returns null for an unmatched id.
    assert.equal(nvr.getDeviceById(camera.id), member, "getDeviceById finds the seeded member by its protectId");
    assert.equal(nvr.getDeviceById("camera-absent"), null, "getDeviceById returns null when no managed device matches the id");

    // The record vanishes from the store. Reading the member's ufp would now throw, but getDeviceById matches on the non-throwing protectId, so it still resolves it.
    store.removeCameraRecord(camera.id);

    assert.throws(() => member.ufp, "the member's ufp reads through the store and throws once the record is removed - the absence case is genuinely store-backed");
    assert.equal(nvr.getDeviceById(camera.id), member, "getDeviceById still resolves the member by its non-throwing protectId after the record vanished");

    controller.abort();
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

describe("harness growth: the NVR double's reboot wiring", () => {

  test("constructing the double enters no reboot schedule and moves no phase", async () => {

    const store = new TestStateStore(makeProtectState());
    const { clock, controller, logEntries, nvr } = makeTestNvr({ store });

    try {

      // Nothing entered the schedule, so running the clock well past the default cadence must produce no attempt at all. This is what keeps the embedded scheduler
      // inert for every other suite in the harness.
      clock.advance(2 * DEFAULT_INTERVAL_MS);

      await settle();

      assert.equal(nvr.rebootCalls, 0, "no reboot was commanded");
      assert.equal(nvr.phase, "running", "the lifecycle phase is where the double starts it");
      assert.deepEqual(logEntries.filter((entry) => formatLogEntry(entry).includes("reboot")), [], "the scheduler narrated nothing");
    } finally {

      controller.abort();
    }
  });

  test("a transmitting package camera defers the scheduled reboot on its own, and both views count together", async () => {

    const store = new TestStateStore(makeProtectState());
    const { clock, controller, logEntries, nvr } = makeTestNvr({ store });

    // A parent that is not recording, carrying a package view that is. Only a walk that reaches package cameras sees this recording at all, so the count below is
    // exactly what the endpoint walk added.
    const camera = { packageCamera: { streaming: { isRecordingTransmitting: true } }, protectId: "cam-widening",
      streaming: { isRecordingTransmitting: false } };

    nvr.configuredDevices.set(accessoryUuid("cam-widening"), camera as unknown as ProtectDevices);

    try {

      // An upSince of zero reads as no boot time reported, so the first attempt lands a full cadence from now.
      nvr.reboot.schedule({ upSince: 0 });
      clock.advance(DEFAULT_INTERVAL_MS);

      await settle();

      assert.equal(nvr.rebootCalls, 0, "the transmitting package held the reboot back by itself");
      assert.deepEqual(deferringLines(logEntries), ["Deferring scheduled controller reboot: 1 camera is actively recording HKSV events."],
        "the package alone accounts for the count");

      // The parent starts recording too, and the next check counts the two views as two.
      camera.streaming.isRecordingTransmitting = true;
      clock.advance(PROTECT_NVR_REBOOT_CHECK_INTERVAL);

      await settle();

      assert.equal(deferringLines(logEntries).at(-1), "Deferring scheduled controller reboot: 2 cameras are actively recording HKSV events.",
        "a parent and its package are counted as the two views they are");
    } finally {

      controller.abort();
    }
  });

  test("a package inside its removal grace still defers the reboot while it is recording", async () => {

    const store = new TestStateStore(makeProtectState());
    const { clock, controller, logEntries, nvr } = makeTestNvr({ store, userOptions: ["Enable.Nvr.DelayDeviceRemoval.3600"] });
    const packageAccessory = makeTestAccessory("Back Door Package Camera", "74ACB9000204.PackageCamera");
    const camera = { packageCamera: { streaming: { isRecordingTransmitting: true } }, protectId: "cam-grace", streaming: { isRecordingTransmitting: false } };

    restoreAccessories(nvr, [packageAccessory]);
    nvr.configuredDevices.set(accessoryUuid("cam-grace"), camera as unknown as ProtectDevices);

    try {

      nvr.restabilizeController();

      // The package is on its way out: a delayed removal is armed against its accessory, with an hour to run and a predicate that would keep it.
      nvr.removals.schedule({ accessory: packageAccessory, stillGone: () => false });

      assert.deepEqual(delayingLines(logEntries), ["Back Door Package Camera: Delaying device removal for at least 3600 seconds."],
        "the removal grace is armed and pending");

      // Fire a reboot attempt well inside that grace: a long-up controller floors at a minute, far short of the hour the grace still has.
      nvr.reboot.schedule({ upSince: clock.now() - (2 * DEFAULT_INTERVAL_MS) });
      clock.advance(60000);

      await settle();

      assert.ok(nvr.platform.accessories.includes(packageAccessory), "the grace has not fired, so the package is still inside it");
      assert.deepEqual(deferringLines(logEntries), ["Deferring scheduled controller reboot: 1 camera is actively recording HKSV events."],
        "a pending removal does not exclude a view that is actively recording");
    } finally {

      controller.abort();
    }
  });
});
