/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * light.test.ts: The reference family - behavior tests over a REAL constructed ProtectLight.
 *
 * ProtectLight is the simplest device class that still exercises the whole device template - accessory info, a primary Lightbulb service, the default-on motion
 * sensor, MQTT, and four narrow state observers - so this suite is the per-family pattern the chime / viewer / sensor / controller steps copy: a read-through
 * projection double, a config builder, per-slice push helpers, and behavior-FIRST assertions (observer count, the four slice reactions, topic composition). Every
 * assertion drives the REAL production class and, for the motion routing, the REAL ProtectEventDispatch contract through a recording subclass - never a modeled
 * stand-in for the leaf.
 *
 * The light's lastMotion observer routes to nvr.events.motionEventHandler, which in production arms a motionDuration-second reset setTimeout on the dispatch's own
 * eventTimers map - a handle light.cleanup() cannot clear. A real-dispatch motion test would therefore leak a dangling timer. The established suite idiom (see
 * event-dispatch.test.ts) is a recording subclass that overrides the delivery method to record into an array and arm no timer; injecting it through the harness's
 * dispatch-injection seam is the clean, reusable way to assert the observer's routing (called on truthy, suppressed on falsy) with no leaked handle.
 *
 * The isolation model is per-test-fresh, not a single shared before(): a beforeEach builds a fresh light so recording.calls, the characteristic state, the observer
 * baselines, and store.observerCount are clean every test with no cross-test ordering coupling. The wake log is windowed per push via a captured baseline, so a wake
 * assertion is robust regardless of isolation. This buildLight-plus-beforeEach skeleton is the copyable reference; only makeLightConfig, TestLightProjection, the
 * slice keys, the light's per-slice observer count, and the leaf-specific reactions are light-particular.
 */
import { Characteristic, Service, TestLightProjection, TestRecordingDispatch, TestStateStore, makeLightConfig, makeProtectState, makeTestAccessory, makeTestNvr, settle }
  from "../testing.helpers.ts";
import type { TestAccessory, TestMqttClient } from "../testing.helpers.ts";
import { after, before, beforeEach, describe, mock, test } from "node:test";
import type { Light } from "unifi-protect";
import type { ObserverWakePayload } from "../diagnostics.ts";
import type { ProtectAccessory } from "../types.ts";
import type { ProtectEventDispatch } from "../nvr/event-dispatch.ts";
import { ProtectLight } from "./light.ts";
import type { ProtectLightConfig } from "unifi-protect";
import type { ProtectNvr } from "../nvr/nvr.ts";
import { ProtectReservedNames } from "../types.ts";
import assert from "node:assert/strict";
import diagnosticsChannel from "node:diagnostics_channel";

// The reusable construction helper: build a REAL ProtectLight against the harness doubles, with the recording dispatch injected through the NVR double's dispatch seam.
// The casts are confined to the construction seam exactly as camera-construction.test.ts does; the instance under test is the production class, running its real
// configureHints / configureDevice / spawnObservers paths. The injected recording dispatch is read off nvr.events after construction rather than captured from the
// factory closure - reading it back avoids both the assignment-expression smell and a TS2454 definite-assignment error on a factory-captured binding.
function buildLight(configOptions: Parameters<typeof makeLightConfig>[0] = {}, harnessOptions: { userOptions?: string[] } = {}): {
  accessory: TestAccessory; light: ProtectLight; lightConfig: ProtectLightConfig; lightProjection: TestLightProjection; mqtt: TestMqttClient;
  recording: TestRecordingDispatch; store: TestStateStore;
} {

  const lightConfig = makeLightConfig(configOptions);
  const store = new TestStateStore(makeProtectState({ lights: [lightConfig] }));
  const { mqtt, nvr } = makeTestNvr({ dispatch: (innerNvr: ProtectNvr): ProtectEventDispatch => new TestRecordingDispatch(innerNvr), mqtt: true, store,
    userOptions: harnessOptions.userOptions });
  const recording = nvr.events as TestRecordingDispatch;
  const accessory = makeTestAccessory("Test Light", "uuid:test-light");

  // The projection is named (not cast inline) so the MQTT SET-body tests read its updateCalls / set its updateRejection on the SAME instance the light's onSet
  // write-through reaches; the lone construction-seam cast is confined to the new ProtectLight(...) call.
  const projection = new TestLightProjection(lightConfig.id, store);
  const light = new ProtectLight(nvr as unknown as ProtectNvr, accessory as unknown as ProtectAccessory, projection as unknown as Light);

  // makeTestNvr was called with mqtt: true, so the recording double is present; a guard narrows Nullable<TestMqttClient> to the non-null type without an assertion or a
  // same-type cast (either of which the house lint preset forbids in opposite directions), and fails loudly if the opt-in ever stops installing the double.
  if(!mqtt) {

    throw new Error("The MQTT recording double was not installed despite mqtt: true.");
  }

  return { accessory, light, lightConfig, lightProjection: projection, mqtt, recording, store };
}

describe("real ProtectLight construction and observer behavior", () => {

  // The one observer-wake subscription for the whole suite, installed before any construction and removed once in the unconditional teardown. A leaked subscriber would
  // flip hasSubscribers for every later test in the process, so it is removed exactly once.
  const wakeLog: ObserverWakePayload[] = [];
  const onWake = (message: unknown): void => { wakeLog.push(message as ObserverWakePayload); };

  // The per-test-fresh handles, rebuilt in beforeEach so every test starts from a clean light, clean recording, and clean wake baseline.
  let accessory: TestAccessory;
  let constructionWakes = 0;
  let light: ProtectLight;
  let lightConfig: ProtectLightConfig;
  let lightProjection: TestLightProjection;
  let mqtt: TestMqttClient;
  let recording: TestRecordingDispatch;
  let store: TestStateStore;

  before(() => {

    diagnosticsChannel.subscribe("hbup:observer:wake", onWake);
  });

  after(() => {

    diagnosticsChannel.unsubscribe("hbup:observer:wake", onWake);
  });

  beforeEach(async () => {

    ({ accessory, light, lightConfig, lightProjection, mqtt, recording, store } = buildLight({ isLightOn: true, ledLevel: 4 }));

    // Settle the observe loops' lazy registration before any test asserts, then snapshot the construction-wake count and reset the window so each test measures only
    // its own pushes.
    await settle();

    constructionWakes = wakeLog.length;
    wakeLog.length = 0;
  });

  test("six observers register, construction wakes none, and the default-on motion surface exists", () => {

    assert.equal(store.observerCount, 6, "the two base observers plus the light's four are registered against the store double");
    assert.equal(constructionWakes, 0, "no observer wake was published during construction - observers arm against the baseline and stay silent");
    assert.ok(accessory.getService(Service.MotionSensor), "configureMotionSensor is default-on, so the light carries a MotionSensor service the motion tests depend on");
  });

  test("cleanup unwinds all six observers, and a value-changing push afterward wakes nothing", async () => {

    light.cleanup();

    // The per-accessory abort propagates through every observe loop; each loop's finally deregisters it. Settle the microtask unwinding, then prove the set is empty.
    await settle();

    assert.equal(store.observerCount, 0, "every observer deregistered through the teardown");

    // The leak detector's positive half: a push that WOULD wake the isLightOn observer if anything survived produces zero wakes - proving the observers truly
    // deregistered rather than that the push was inert.
    const teardownBaseline = wakeLog.length;

    store.pushLightPatch(lightConfig.id, { isLightOn: false });

    await settle();

    assert.equal(wakeLog.length, teardownBaseline, "a push after cleanup wakes nothing");
  });

  test("initialization reflects the config: On true and Brightness mapped from ledLevel 4 to 60 percent", () => {

    const service = accessory.getService(Service.Lightbulb);

    assert.ok(service, "the Lightbulb service exists");
    assert.equal(service.getCharacteristic(Characteristic.On).value, true, "On initialized from isLightOn");
    assert.equal(service.getCharacteristic(Characteristic.Brightness).value, 60, "Brightness initialized from ledLevelToBrightness(4)");
  });

  test("onGet reads through to the live config: On from isLightOn, Brightness from the LED-level math", async () => {

    const service = accessory.getService(Service.Lightbulb);

    assert.ok(service, "the Lightbulb service exists");
    assert.equal(await service.getCharacteristic(Characteristic.On).triggerGet(), true, "the On getter reads isLightOn");
    assert.equal(await service.getCharacteristic(Characteristic.Brightness).triggerGet(), 60, "the Brightness getter maps ledLevel 4 to 60 percent");
  });

  test("an isLightOn push wakes exactly the isLightOn observer and updates the Lightbulb On characteristic", async () => {

    const baseline = wakeLog.length;

    store.pushLightPatch(lightConfig.id, { isLightOn: false });

    await settle();

    assert.deepEqual(wakeLog.slice(baseline), [{ accessoryId: accessory.UUID, key: "light.isLightOn" }], "exactly the isLightOn observer woke for this slice");
    assert.equal(accessory.getService(Service.Lightbulb)?.getCharacteristic(Characteristic.On).value, false, "the reaction pushed the new power state to On");
  });

  test("a nested ledLevel push wakes only the ledLevel observer and re-derives Brightness, leaving the indicator observer dormant", async () => {

    const baseline = wakeLog.length;

    // The composing push moves only ledLevel; the primitive isIndicatorEnabled selector dedups on its unchanged reference, so observer 4 must stay parked.
    store.pushLightDeviceSettings(lightConfig.id, { ledLevel: 6 });

    await settle();

    assert.deepEqual(wakeLog.slice(baseline), [{ accessoryId: accessory.UUID, key: "light.ledLevel" }], "only the ledLevel observer woke; the indicator stayed dormant");
    assert.equal(accessory.getService(Service.Lightbulb)?.getCharacteristic(Characteristic.Brightness).value, 100, "the reaction re-derived Brightness from ledLevel 6");
  });

  test("a truthy lastMotion push wakes the motion observer and routes to the dispatch firehose exactly once", async () => {

    const baseline = wakeLog.length;

    // A fixed truthy timestamp literal rather than Date.now(), so the push is deterministic.
    store.pushLightPatch(lightConfig.id, { lastMotion: 1700000000000 });

    await settle();

    assert.deepEqual(wakeLog.slice(baseline), [{ accessoryId: accessory.UUID, key: "light.lastMotion" }], "exactly the lastMotion observer woke");
    assert.deepEqual(recording.calls, [{ id: lightConfig.id, kind: "motion" }], "the truthy detection routed to motionEventHandler exactly once");
  });

  test("a falsy-but-changed lastMotion push wakes the motion observer yet the if-guard suppresses delivery", async () => {

    const baseline = wakeLog.length;

    // 0 is falsy, but Object.is(0, null) is false, so the selector's reference dedup does NOT suppress the wake - the observer WAKES and the production if(lastMotion)
    // guard, not a dead observer, is what skips delivery. The wake half is what makes "calls empty" non-vacuous.
    store.pushLightPatch(lightConfig.id, { lastMotion: 0 });

    await settle();

    assert.deepEqual(wakeLog.slice(baseline), [{ accessoryId: accessory.UUID, key: "light.lastMotion" }], "the lastMotion observer woke on the changed-to-falsy value");
    assert.deepEqual(recording.calls, [], "the if(lastMotion) guard suppressed delivery for the falsy timestamp");
  });

  test("with the status-LED switch feature enabled, an isIndicatorEnabled push wakes its observer and updates the switch", async () => {

    // A feature-enabled variant: enabling Device.StatusLed.Switch materializes the SWITCH_STATUS_LED-subtyped Switch the observer drives.
    const enabled = buildLight({ isLightOn: true, ledLevel: 4 }, { userOptions: ["Enable.Device.StatusLed.Switch"] });

    await settle();

    const ledSwitch = enabled.accessory.getServiceById(Service.Switch, ProtectReservedNames.SWITCH_STATUS_LED);

    assert.ok(ledSwitch, "enabling the feature created the status-indicator Switch");

    const baseline = wakeLog.length;

    enabled.store.pushLightDeviceSettings(enabled.lightConfig.id, { isIndicatorEnabled: true });

    await settle();

    assert.deepEqual(wakeLog.slice(baseline), [{ accessoryId: enabled.accessory.UUID, key: "light.isIndicatorEnabled" }],
      "exactly the isIndicatorEnabled observer woke");
    assert.equal(ledSwitch.getCharacteristic(Characteristic.On).value, true, "the reaction pushed the indicator state to the status-LED switch");

    enabled.light.cleanup();
  });

  test("MQTT subscriptions compose the device-MAC-scoped topic tails the light registers", () => {

    const tails = mqtt.subscriptions.map((subscription) => subscription.topic);

    // The light's own get/set wrappers plus the default-on motion sensor's get/set wrapper, each MAC-scoped. We assert every tail the light registers so the topic
    // composition coverage is honest about the full set, not just the light-particular ones.
    assert.ok(tails.includes(lightConfig.mac + "/light"), "the light status subscription composed the device-scoped tail");
    assert.ok(tails.includes(lightConfig.mac + "/light/brightness"), "the light brightness subscription composed the device-scoped tail");
    assert.ok(tails.includes(lightConfig.mac + "/motion"), "the default-on motion sensor's subscription composed the device-scoped tail");
  });

  describe("the light MQTT handler bodies (the /light and /light/brightness get/set bodies)", () => {

    // The topic composition above is netted; these tests find each captured subscription by its MAC-scoped tail and INVOKE its getValue / setValue closure - the handler
    // body the HomeKit onSet machinery never reaches. The beforeEach builds { isLightOn: true, ledLevel: 4 } -> On true, Brightness ledLevelToBrightness(4) = 60. The SET
    // bodies drive the Lightbulb On / Brightness onSet, which write through this.device.update on the named lightProjection (the harness addition this step unlocked).

    test("the /light GET reads the live power state as a string", () => {

      // HARD-assert the /light GET subscription exists FIRST: an absent subscription whose getValue is optional-chained would let the value assertion pass vacuously.
      const get = mqtt.subscriptions.find((subscription) => (subscription.kind === "get") && (subscription.topic === lightConfig.mac + "/light"));

      assert.ok(get?.getValue, "the light registered a /light GET subscription");
      assert.equal(get.getValue(), "true", "the /light GET reads isLightOn true as the string \"true\"");
    });

    test("the /light/brightness GET reads the LED-level-mapped brightness as a string", () => {

      const get = mqtt.subscriptions.find((subscription) => (subscription.kind === "get") && (subscription.topic === lightConfig.mac + "/light/brightness"));

      assert.ok(get?.getValue, "the light registered a /light/brightness GET subscription");
      assert.equal(get.getValue(), "60", "the /light/brightness GET maps ledLevel 4 to 60 percent");
    });

    test("a /light SET of \"true\" drives the power write and publishes \"true\"", async () => {

      const set = mqtt.subscriptions.find((subscription) => (subscription.kind === "set") && (subscription.topic === lightConfig.mac + "/light"));

      assert.ok(set?.setValue, "the light registered a /light SET subscription");

      // The body's getService(Lightbulb)?.setCharacteristic(On, value === "true") fires the On onSet, which writes through device.update({ lightOnSettings: {
      // isLedForceOn } }) then publishes. setCharacteristic is fire-and-forget, so settle past the onSet before asserting.
      await set.setValue("true", "true");
      await settle();

      assert.deepEqual(lightProjection.updateCalls, [{ payload: { lightOnSettings: { isLedForceOn: true } } }],
        "the /light SET of \"true\" wrote the force-on power state through device.update");
      assert.deepEqual(mqtt.published.filter((entry) => entry.topic === lightConfig.mac + "/light"), [{ message: "true", topic: lightConfig.mac + "/light" }],
        "the accepted power write published \"true\" on the light topic");
    });

    test("a /light SET of a non-\"true\" value drives the power-off write and publishes \"false\"", async () => {

      const set = mqtt.subscriptions.find((subscription) => (subscription.kind === "set") && (subscription.topic === lightConfig.mac + "/light"));

      assert.ok(set?.setValue, "the light registered a /light SET subscription");

      // value === "true" is false for "false", so the On onSet receives false: device.update({ lightOnSettings: { isLedForceOn: false } }) and publish "false". The
      // boolean is the discriminator that kills a mutation of the value === "true" comparison.
      await set.setValue("false", "false");
      await settle();

      assert.deepEqual(lightProjection.updateCalls, [{ payload: { lightOnSettings: { isLedForceOn: false } } }],
        "a non-\"true\" /light SET wrote the force-off power state through device.update");
      assert.deepEqual(mqtt.published.filter((entry) => entry.topic === lightConfig.mac + "/light"), [{ message: "false", topic: lightConfig.mac + "/light" }],
        "the accepted power-off write published \"false\" on the light topic");
    });

    test("a valid /light/brightness SET maps the percentage to an LED level, publishes the round-tripped brightness, and reflects it after 50ms", async () => {

      // The 50ms reflect uses the GLOBAL setTimeout; settle is one setImmediate and does NOT advance it, so the reflect needs mock.timers + tick(50).
      mock.timers.enable({ apis: ["setTimeout"] });

      try {

        const set = mqtt.subscriptions.find((subscription) => (subscription.kind === "set") && (subscription.topic === lightConfig.mac + "/light/brightness"));

        assert.ok(set?.setValue, "the light registered a /light/brightness SET subscription");

        // The body parses "55", passes the gate, and setCharacteristic(Brightness, 55) -> the Brightness onSet -> brightnessToLedLevel(55) = Math.round(55/20 + 1) = 4 ->
        // device.update({ lightDeviceSettings: { ledLevel: 4 } }), then schedules the 50ms reflect and publishes ledLevelToBrightness(4) = 60. The 55 -> 60 round-trip is
        // the granularity contract.
        await set.setValue("55", "55");
        await settle();

        assert.deepEqual(lightProjection.updateCalls, [{ payload: { lightDeviceSettings: { ledLevel: 4 } } }],
          "the /light/brightness SET of \"55\" mapped to LED level 4 and wrote it through device.update");
        assert.deepEqual(mqtt.published.filter((entry) => entry.topic === lightConfig.mac + "/light/brightness"),
          [{ message: "60", topic: lightConfig.mac + "/light/brightness" }], "the write published the round-tripped brightness (55 in, 60 published)");

        // The 50ms reflect snaps the Lightbulb Brightness to the LED-level-mapped value, reconciling HomeKit's finer granularity with Protect's 1-6 levels.
        mock.timers.tick(50);

        assert.equal(accessory.getService(Service.Lightbulb)?.getCharacteristic(Characteristic.Brightness).value, 60,
          "the 50ms reflect snapped the Lightbulb Brightness to the LED-level-mapped 60 percent");
      } finally {

        mock.timers.reset();
      }
    });

    test("a non-numeric /light/brightness SET is gated out: no write, no publish", async () => {

      const set = mqtt.subscriptions.find((subscription) => (subscription.kind === "set") && (subscription.topic === lightConfig.mac + "/light/brightness"));

      assert.ok(set?.setValue, "the /light/brightness SET subscription registered");

      // "abc" parses to NaN, so the isNaN gate returns before any setCharacteristic - no onSet, no write, no publish.
      await set.setValue("abc", "abc");
      await settle();

      assert.equal(lightProjection.updateCalls.length, 0, "a NaN brightness is gated out before the Lightbulb drive, so no write happens");
      assert.equal(mqtt.published.filter((entry) => entry.topic === lightConfig.mac + "/light/brightness").length, 0, "a gated-out brightness publishes nothing");
    });

    test("an out-of-range /light/brightness SET (above 100 or below 0) is gated out: no write, no publish", async () => {

      const set = mqtt.subscriptions.find((subscription) => (subscription.kind === "set") && (subscription.topic === lightConfig.mac + "/light/brightness"));

      assert.ok(set?.setValue, "the /light/brightness SET subscription registered");

      // Both 150 ( > 100 ) and -5 ( < 0 ) fail the (brightness < 0) || (brightness > 100) gate, so neither reaches the Lightbulb drive.
      await set.setValue("150", "150");
      await set.setValue("-5", "-5");
      await settle();

      assert.equal(lightProjection.updateCalls.length, 0, "an out-of-range brightness is gated out, so no write happens");
      assert.equal(mqtt.published.filter((entry) => entry.topic === lightConfig.mac + "/light/brightness").length, 0, "an out-of-range brightness publishes nothing");
    });
  });
});
