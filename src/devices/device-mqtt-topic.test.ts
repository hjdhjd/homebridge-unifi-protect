/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * device-mqtt-topic.test.ts: Unit tests for the ProtectBase MQTT wrappers and the mqttId seam that single-source the device- and controller-scoped topic conventions.
 *
 * Every MQTT publish / subscribe routes through ProtectBase.publish, subscribeGet, and subscribeSet. Those wrappers are the one place the plugin composes an owner's
 * mqttId into the topic tail that homebridge-plugin-utils' MqttClient then prefixes with the configured topic, so the wire topic is {topicPrefix}/{mqttId}/{subtopic}
 * (subscribeGet / subscribeSet additionally append the internal /get and /set suffixes). mqttId is the single seam the wrappers vary by: ProtectDevice overrides it to
 * the device MAC (device scope), while the controller-scoped owners (system information, liveviews, the security system) inherit the base default of the controller MAC
 * (controller scope). These tests pin both compositions against the real production wrappers, capturing the topic each forwards to a mock nvr.mqtt. The MQTT topic
 * structure is a user-facing contract (automations subscribe to it), so a changed composition is a regression these tests guard against. ProtectDevice and a bare
 * ProtectBase leaf are the smallest real surfaces that carry the wrappers: the abstract base declares no abstract members, so a near-empty concrete leaf is a faithful
 * instance whose publish, subscribeGet, and subscribeSet are all the base's own - the same admission command-error.test.ts and reachability.test.ts rely on.
 */
import { TestMqttClient, makeTestAccessory, settle } from "../testing.helpers.ts";
import { describe, test } from "node:test";
import type { Camera } from "unifi-protect";
import type { ProtectAccessory } from "../types.ts";
import { ProtectBase } from "./device-base.ts";
import { ProtectDevice } from "./device.ts";
import type { ProtectNvr } from "../nvr/nvr.ts";
import assert from "node:assert/strict";
import util from "node:util";

// The smallest concrete leaf of the abstract base, mirroring command-error.test.ts: ProtectDevice declares no abstract members, so this adds nothing but a public window
// onto the protected MQTT wrappers this suite exercises, inherited unchanged.
class TestProtectDevice extends ProtectDevice {

  public emitPublish(topic: string, message: string): void {

    this.publish(topic, message);
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
// (context.mac), not this.ufp.mac, so we seed it on the accessory; and an nvr whose mqtt captures the composed topic for each verb. The casts are confined to this seam;
// the instance itself is the production class.
const makeDevice = (): { capture: MqttCapture; instance: TestProtectDevice } => {

  const capture: MqttCapture = { publish: [], subscribeGet: [], subscribeSet: [] };
  const sink = (): void => undefined;
  const log = { debug: sink, error: sink, info: sink, warn: sink };
  const device = { config: { mac: MAC } };
  const accessory = makeTestAccessory();

  accessory.context["mac"] = MAC;

  const mqtt = {

    publish: async (topic: string): Promise<void> => { capture.publish.push(topic); },
    subscribeGet: (topic: string): void => { capture.subscribeGet.push(topic); },
    subscribeSet: (topic: string): void => { capture.subscribeSet.push(topic); }
  };
  const nvr = {

    mqtt,
    platform: { api: { hap: {} }, debug: sink, log, pluginLog: log },
    signal: new AbortController().signal
  };
  const instance = new TestProtectDevice(nvr as unknown as ProtectNvr, accessory as unknown as ProtectAccessory, device as unknown as Camera);

  return { capture, instance };
};

// Construct the same real ProtectDevice, but wired to a real TestMqttClient (so its injectable rejection lever drives the funnel's guarded-publish failure path) and a
// capturing error log (so the guard's reported line is observable). error renders through util.format - the line the real Homebridge sink would write - the same posture
// command-error.test.ts uses; the other levels sink.
const makeGuardedDevice = (): { errors: string[]; instance: TestProtectDevice; mqtt: TestMqttClient } => {

  const errors: string[] = [];
  const sink = (): void => undefined;
  const log = { debug: sink, error: (message: string, ...parameters: unknown[]): void => { errors.push(util.format(message, ...parameters)); }, info: sink, warn: sink };
  const mqtt = new TestMqttClient();
  // logName reads the live record through peek() (non-throwing) when the prefixed logger renders a line, so the projection mock exposes it alongside config - without it,
  // the guard's error render would throw inside its own catch and be swallowed. The empty-but-present config makes describeDevice render the same bare descriptor.
  const config = { mac: MAC };
  const device = { config, peek: (): Record<string, unknown> => config };
  const accessory = makeTestAccessory();

  accessory.context["mac"] = MAC;

  const nvr = {

    mqtt,
    platform: { api: { hap: {} }, debug: sink, log, pluginLog: log },
    signal: new AbortController().signal
  };
  const instance = new TestProtectDevice(nvr as unknown as ProtectNvr, accessory as unknown as ProtectAccessory, device as unknown as Camera);

  return { errors, instance, mqtt };
};

// The controller MAC the base wrappers compose into every topic tail when no leaf overrides mqttId. Deliberately distinct from the device MAC so a controller-scope
// assertion cannot pass by accidentally reading the device MAC.
const NVR_MAC = "112233445566";

// Construct a bare ProtectBase against the minimal mocks its MQTT wrappers read: an nvr carrying the controller MAC (the base mqttId reads through to this.nvr.ufp.mac)
// and an mqtt that captures the composed topic for each verb. The casts are confined to this seam; the instance itself is the production base class.
const makeController = (): { capture: MqttCapture; instance: TestProtectBase } => {

  const capture: MqttCapture = { publish: [], subscribeGet: [], subscribeSet: [] };
  const sink = (): void => undefined;
  const log = { debug: sink, error: sink, info: sink, warn: sink };
  const mqtt = {

    publish: async (topic: string): Promise<void> => { capture.publish.push(topic); },
    subscribeGet: (topic: string): void => { capture.subscribeGet.push(topic); },
    subscribeSet: (topic: string): void => { capture.subscribeSet.push(topic); }
  };
  const nvr = {

    mqtt,
    platform: { api: { hap: {} }, debug: sink, log, pluginLog: log },
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

  test("a rejected publish is reported under the guard's publish-specific label and floats no unhandled rejection", async () => {

    const { errors, instance, mqtt } = makeGuardedDevice();

    // Arm the rejection lever so the funnel's publish rejects, driving guardedDispatch's failure path rather than recording the message.
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
    assert.equal(errors.length, 1, "the guard reported exactly one failure line");
    assert.match(errors[0] ?? "", /MQTT publish \(AABBCCDDEEFF\/motion\) handler failed/,
      "the reported line carries the publish-specific label naming the full topic");
  });
});

describe("ProtectBase controller-scope MQTT topic composition", () => {

  test("publish composes the controller MAC into the topic tail", () => {

    const { capture, instance } = makeController();

    instance.emitPublish("securitysystem", "Home");

    assert.deepEqual(capture.publish, [NVR_MAC + "/securitysystem"], "publish prefixes the controller MAC onto the supplied topic tail");
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
