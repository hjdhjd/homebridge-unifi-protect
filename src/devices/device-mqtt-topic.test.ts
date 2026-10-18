/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * device-mqtt-topic.test.ts: Unit tests for the ProtectBase MQTT wrappers and the mqttId override point that single-source the device- and controller-scoped
 * topic conventions.
 *
 * Every MQTT publish / subscribe routes through ProtectBase.publish, subscribeGet, and subscribeSet. Those wrappers are the one place the plugin composes an owner's
 * mqttId into the topic tail that homebridge-plugin-utils' MqttClient then prefixes with the configured topic, so the wire topic is {topicPrefix}/{mqttId}/{subtopic}
 * (subscribeGet / subscribeSet additionally append the internal /get and /set suffixes). mqttId is the single field the wrappers vary by: ProtectDevice overrides it to
 * the device MAC (device scope), while the controller-scoped owners (system information, liveviews, the security system) inherit the base default of the controller MAC
 * (controller scope). These tests pin both compositions against the real production wrappers, capturing the topic each forwards to a mock nvr.mqtt. The MQTT topic
 * structure is a user-facing contract (automations subscribe to it), so a changed composition is a regression these tests guard against. ProtectDevice and a bare
 * ProtectBase leaf are the smallest real surfaces that carry the wrappers: the abstract base declares no abstract members, so a near-empty concrete leaf is a faithful
 * instance whose publish, subscribeGet, and subscribeSet are all the base's own - the same admission command-error.test.ts and reachability.test.ts rely on.
 */
import { TestClock, TestMqttClient, settle } from "homebridge-plugin-utils/testing";
import { describe, test } from "node:test";
import type { Camera } from "unifi-protect";
import type { ProtectAccessory } from "../types.ts";
import { ProtectBase } from "./device-base.ts";
import { ProtectDevice } from "./device.ts";
import type { ProtectNvr } from "../nvr/nvr.ts";
import { TEST_CLOCK_EPOCH } from "../nvr/testing.helpers.ts";
import assert from "node:assert/strict";
import { makeTestAccessory } from "../testing.helpers.ts";
import util from "node:util";

// The smallest concrete leaf of the abstract base, mirroring command-error.test.ts: ProtectDevice declares no abstract members, so this adds nothing but a public window
// onto the protected MQTT wrappers this suite exercises, inherited unchanged.
class TestProtectDevice extends ProtectDevice {

  public emitPublish(topic: string, message: string): void {

    this.publish(topic, message);
  }

  public emitPublishState(topic: string, value: string): void {

    this.publishState(topic, value);
  }

  public emitRestateOnConnect(restate: () => void): void {

    this.restateOnConnect(restate);
  }

  public emitSubscribeGet(topic: string, type: string, getValue: () => string): void {

    this.subscribeGet(topic, type, getValue);
  }

  public emitSubscribeSet(topic: string, type: string, setValue: (value: string, rawValue: string) => Promise<void> | void): void {

    this.subscribeSet(topic, type, setValue);
  }
}

// A bare ProtectBase leaf (no mqttId override) exposing the same inherited MQTT wrappers, mirroring how the controller-scoped owners reach them. ProtectBase scopes its
// device-topic under the controller MAC by default, so this near-empty leaf pins that base default - the same near-empty-concrete-leaf admission command-error.test.ts
// and reachability.test.ts rely on, here against the abstract base directly.
class TestProtectBase extends ProtectBase {

  public emitPublish(topic: string, message: string): void {

    this.publish(topic, message);
  }

  public emitPublishState(topic: string, value: string): void {

    this.publishState(topic, value);
  }

  public emitSubscribeGet(topic: string, type: string, getValue: () => string): void {

    this.subscribeGet(topic, type, getValue);
  }

  public emitSubscribeSet(topic: string, type: string, setValue: (value: string, rawValue: string) => Promise<void> | void): void {

    this.subscribeSet(topic, type, setValue);
  }
}

// The topics each wrapper forwarded to nvr.mqtt, one array per verb so a test reads exactly what its wrapper composed.
interface MqttCapture {

  publish: string[];
  subscribeGet: string[];
  subscribeSet: string[];
}

// The device MAC the wrappers compose into every topic tail. An arbitrary but fixed value so the assertions read literally.
const MAC = "AABBCCDDEEFF";

// Construct a real ProtectDevice against the minimal mocks the MQTT wrappers read: the device-leaf mqttId sources the bare MAC from the persisted accessory context
// (context.mac), not this.ufp.mac, so we seed it on the accessory; an nvr whose mqtt captures the composed topic for each verb; and a platform carrying the test clock
// the spine's timer registry is built on, started at the harness epoch. The casts are confined to this construction step; the instance itself is the production class.
const makeDevice = (): { capture: MqttCapture; instance: TestProtectDevice } => {

  const capture: MqttCapture = { publish: [], subscribeGet: [], subscribeSet: [] };
  const sink = (): void => undefined;
  const log = { debug: sink, error: sink, info: sink, warn: sink };
  const device = { config: { mac: MAC } };
  const accessory = makeTestAccessory();

  accessory.context["mac"] = MAC;

  const mqtt = {

    publishGuarded: (topic: string): void => { capture.publish.push(topic); },
    subscribeGet: (topic: string): void => { capture.subscribeGet.push(topic); },
    subscribeSet: (topic: string): void => { capture.subscribeSet.push(topic); }
  };
  const nvr = {

    mqtt,
    platform: { api: { hap: {} }, clock: new TestClock(TEST_CLOCK_EPOCH), log, pluginLog: log, testDebug: (): boolean => false },
    signal: new AbortController().signal
  };
  const instance = new TestProtectDevice(nvr as unknown as ProtectNvr, accessory as unknown as ProtectAccessory, device as unknown as Camera);

  return { capture, instance };
};

// Construct the same real ProtectDevice, but wired to a real TestMqttClient (so its injectable rejection lever drives the client's guarded-publish failure path) and a
// capturing error log (so the reported line is observable). The double reports on the log it is handed at construction, which is the same capturing sink the device
// logs through, so one array collects the line either origin would write. error renders through util.format - the line the real Homebridge sink would write - the same
// posture command-error.test.ts uses; the other levels sink.
const makeGuardedDevice = (): { errors: string[]; instance: TestProtectDevice; mqtt: TestMqttClient; record: { present: boolean } } => {

  const errors: string[] = [];
  const sink = (): void => undefined;
  const log = { debug: sink, error: (message: string, ...parameters: unknown[]): void => { errors.push(util.format(message, ...parameters)); }, info: sink, warn: sink };
  const mqtt = new TestMqttClient({ log });
  // logName reads the live record through peek() (non-throwing) when the prefixed logger renders a line, so the projection mock exposes it alongside config. The
  // empty-but-present config makes describeDevice render the same bare descriptor. The record lever stands in for a removal's grace, when peek() finds no record.
  const config = { mac: MAC };
  const record = { present: true };
  const device = { config, peek: (): Record<string, unknown> | undefined => (record.present ? config : undefined) };
  const accessory = makeTestAccessory();

  accessory.context["mac"] = MAC;

  const nvr = {

    mqtt,
    platform: { api: { hap: {} }, clock: new TestClock(TEST_CLOCK_EPOCH), log, pluginLog: log, testDebug: (): boolean => false },
    signal: new AbortController().signal
  };
  const instance = new TestProtectDevice(nvr as unknown as ProtectNvr, accessory as unknown as ProtectAccessory, device as unknown as Camera);

  return { errors, instance, mqtt, record };
};

// The controller MAC the base wrappers compose into every topic tail when no leaf overrides mqttId. Deliberately distinct from the device MAC so a controller-scope
// assertion cannot pass by accidentally reading the device MAC.
const NVR_MAC = "112233445566";

// Construct a bare ProtectBase against the minimal mocks its MQTT wrappers read: an nvr carrying the controller MAC (the base mqttId reads through to this.nvr.ufp.mac)
// and an mqtt that captures the composed topic for each verb, with the same platform test clock the spine's timer registry is built on. The casts are confined to this
// construction step; the instance itself is the production base class.
const makeController = (): { capture: MqttCapture; instance: TestProtectBase } => {

  const capture: MqttCapture = { publish: [], subscribeGet: [], subscribeSet: [] };
  const sink = (): void => undefined;
  const log = { debug: sink, error: sink, info: sink, warn: sink };
  const mqtt = {

    publishGuarded: (topic: string): void => { capture.publish.push(topic); },
    subscribeGet: (topic: string): void => { capture.subscribeGet.push(topic); },
    subscribeSet: (topic: string): void => { capture.subscribeSet.push(topic); }
  };
  const nvr = {

    mqtt,
    platform: { api: { hap: {} }, clock: new TestClock(TEST_CLOCK_EPOCH), log, pluginLog: log, testDebug: (): boolean => false },
    ufp: { mac: NVR_MAC }
  };
  const instance = new TestProtectBase(nvr as unknown as ProtectNvr);

  return { capture, instance };
};

describe("ProtectDevice MQTT topic composition", () => {

  test("publish composes the device MAC into the topic tail", () => {

    const { capture, instance } = makeDevice();

    instance.emitPublish("motion", "true");

    assert.deepEqual(capture.publish, [MAC + "/motion"], "publish prefixes the device MAC onto the supplied topic tail");
  });

  test("subscribeGet composes the device MAC into the topic tail", () => {

    const { capture, instance } = makeDevice();

    instance.emitSubscribeGet("occupancy", "occupancy", () => "true");

    assert.deepEqual(capture.subscribeGet, [MAC + "/occupancy"], "subscribeGet prefixes the device MAC onto the supplied topic tail");
  });

  test("subscribeSet composes the device MAC into the topic tail", () => {

    const { capture, instance } = makeDevice();

    instance.emitSubscribeSet("light", "light", () => undefined);

    assert.deepEqual(capture.subscribeSet, [MAC + "/light"], "subscribeSet prefixes the device MAC onto the supplied topic tail");
  });
});

describe("ProtectDevice MQTT publish guard", () => {

  test("a rejected publish is reported by the client's guarded path and floats no unhandled rejection", async () => {

    const { errors, instance, mqtt } = makeGuardedDevice();

    // Arm the rejection lever so the publish the wrapper hands off rejects, driving the client's guarded failure path rather than recording the message.
    mqtt.publishRejection = new Error("the broker connection dropped");

    // Capture any unhandled rejection the guarded publish might float, so the test proves the guard consumed the rejection rather than merely logging alongside a float.
    const floats: unknown[] = [];
    const onFloat = (reason: unknown): void => { floats.push(reason); };

    process.on("unhandledRejection", onFloat);

    try {

      instance.emitPublish("motion", "true");

      await settle();
    } finally {

      process.off("unhandledRejection", onFloat);
    }

    assert.equal(floats.length, 0, "the rejected publish did not float an unhandled rejection");
    assert.equal(errors.length, 1, "the guarded path reported exactly one failure line");
    assert.match(errors[0] ?? "", /Unable to publish to the MQTT topic AABBCCDDEEFF\/motion/,
      "the reported line names the composed topic the publish was attempted on");
  });
});

describe("ProtectDevice MQTT state publish", () => {

  test("publishState composes the device MAC into the topic tail as publish does", () => {

    const { capture, instance } = makeDevice();

    instance.emitPublishState("contact", "true");

    assert.deepEqual(capture.publish, [MAC + "/contact"], "publishState prefixes the device MAC onto the supplied topic tail");
  });

  test("publishState sends a changed value and leaves an unchanged one unsent", () => {

    const { instance, mqtt } = makeGuardedDevice();

    instance.emitPublishState("contact", "true");
    instance.emitPublishState("contact", "true");

    assert.equal(mqtt.publishedTo("contact").length, 1, "a repeat of the value the topic last carried records nothing");

    instance.emitPublishState("contact", "false");

    assert.deepEqual(mqtt.publishedTo("contact").map((entry) => entry.payload), [ "true", "false" ], "a changed value records once more");
  });
});

describe("ProtectDevice MQTT restatement registration", () => {

  // Flip the double's session lever off and back on, settling after each edge so the connect handlers have run.
  const restoreSession = async (mqtt: TestMqttClient): Promise<void> => {

    mqtt.connected = false;
    await settle();
    mqtt.connected = true;
    await settle();
  };

  test("the registration runs nothing when it is made and runs once when a later session starts", async () => {

    const { instance, mqtt } = makeGuardedDevice();
    let runs = 0;

    instance.emitRestateOnConnect(() => { runs++; });
    await settle();

    assert.equal(runs, 0, "registering into a held session runs nothing, since the owner states its held state as it is built");

    await restoreSession(mqtt);

    assert.equal(runs, 1, "the session that starts after the registration runs the restatement once");
  });

  test("a torn-down owner's registration does not run", async () => {

    const { instance, mqtt } = makeGuardedDevice();
    let runs = 0;

    instance.emitRestateOnConnect(() => { runs++; });
    instance.cleanup();
    await restoreSession(mqtt);

    assert.equal(runs, 0, "the owner's teardown released its registration");
  });

  test("a restatement does not run while the owner's record is absent", async () => {

    const { instance, mqtt, record } = makeGuardedDevice();
    let runs = 0;

    instance.emitRestateOnConnect(() => { runs++; });
    record.present = false;
    await restoreSession(mqtt);

    assert.equal(runs, 0, "a device lingering in its removal grace has no record to restate");

    record.present = true;
    await restoreSession(mqtt);

    assert.equal(runs, 1, "the restatement runs again once the record is back");
  });
});

describe("ProtectBase controller-scope MQTT topic composition", () => {

  test("publish composes the controller MAC into the topic tail", () => {

    const { capture, instance } = makeController();

    instance.emitPublish("securitysystem", "Home");

    assert.deepEqual(capture.publish, [NVR_MAC + "/securitysystem"], "publish prefixes the controller MAC onto the supplied topic tail");
  });

  test("publishState composes the controller MAC into the topic tail as publish does", () => {

    const { capture, instance } = makeController();

    instance.emitPublishState("liveviews", "[]");

    assert.deepEqual(capture.publish, [NVR_MAC + "/liveviews"], "publishState prefixes the controller MAC onto the supplied topic tail");
  });

  test("subscribeGet composes the controller MAC into the topic tail", () => {

    const { capture, instance } = makeController();

    instance.emitSubscribeGet("systeminfo", "system information", () => "{}");

    assert.deepEqual(capture.subscribeGet, [NVR_MAC + "/systeminfo"], "subscribeGet prefixes the controller MAC onto the supplied topic tail");
  });

  test("subscribeSet composes the controller MAC into the topic tail", () => {

    const { capture, instance } = makeController();

    instance.emitSubscribeSet("securitysystem", "security system state", () => undefined);

    assert.deepEqual(capture.subscribeSet, [NVR_MAC + "/securitysystem"], "subscribeSet prefixes the controller MAC onto the supplied topic tail");
  });
});
