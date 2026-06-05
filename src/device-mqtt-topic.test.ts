/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * device-mqtt-topic.test.ts: Unit tests for the ProtectBase MQTT wrappers and the mqttId seam that single-source the device- and controller-scoped topic conventions.
 *
 * Every MQTT publish / subscribe routes through ProtectBase.publish, subscribeGet, and subscribeSet. Those wrappers are the one place HBUP composes an owner's mqttId
 * into the topic tail that HBPU's MqttClient then prefixes with the configured topic, so the wire topic is {topicPrefix}/{mqttId}/{subtopic} (subscribeGet / subscribeSet
 * additionally append the internal /get and /set suffixes). mqttId is the single seam the wrappers vary by: ProtectDevice overrides it to the device MAC (device scope),
 * while the controller-scoped owners (system information, liveviews, the security system) inherit the base default of the controller MAC (controller scope). These tests
 * pin both compositions against the real production wrappers, capturing the topic each forwards to a mock nvr.mqtt. The MQTT topic structure is a user-facing contract
 * (automations subscribe to it), so a changed composition is a regression these tests guard against. ProtectDevice and a bare ProtectBase leaf are the smallest real
 * surfaces that carry the wrappers: the abstract base declares no abstract members, so a near-empty concrete leaf is a faithful instance whose publish, subscribeGet, and
 * subscribeSet are all the base's own - the same admission command-error.test.ts and reachability.test.ts rely on.
 */
import { ProtectBase, ProtectDevice } from "./devices/device.ts";
import { describe, test } from "node:test";
import type { Camera } from "unifi-protect";
import type { PlatformAccessory } from "homebridge";
import type { ProtectNvr } from "./nvr.ts";
import assert from "node:assert/strict";
import { makeTestAccessory } from "./testing.helpers.ts";

// The smallest concrete leaf of the abstract base, mirroring command-error.test.ts: ProtectDevice declares no abstract members, so this adds nothing but a public window
// onto the three protected MQTT wrappers, inherited unchanged.
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

// Construct a real ProtectDevice against the minimal mocks the MQTT wrappers read: a projection carrying the MAC (this.ufp.mac reads through to this.device.config.mac),
// and an nvr whose mqtt captures the composed topic for each verb. The casts are confined to this seam; the instance itself is the production class.
const makeDevice = (): { capture: MqttCapture; instance: TestProtectDevice } => {

  const capture: MqttCapture = { publish: [], subscribeGet: [], subscribeSet: [] };
  const sink = (): void => undefined;
  const device = { config: { mac: MAC } };
  const mqtt = {

    publish: async (topic: string): Promise<void> => { capture.publish.push(topic); },
    subscribeGet: (topic: string): void => { capture.subscribeGet.push(topic); },
    subscribeSet: (topic: string): void => { capture.subscribeSet.push(topic); }
  };
  const nvr = {

    mqtt,
    platform: { api: { hap: {} }, debug: sink, log: { debug: sink, error: sink, info: sink, warn: sink } },
    signal: new AbortController().signal
  };
  const instance = new TestProtectDevice(nvr as unknown as ProtectNvr, makeTestAccessory() as unknown as PlatformAccessory, device as unknown as Camera);

  return { capture, instance };
};

// The controller MAC the base wrappers compose into every topic tail when no leaf overrides mqttId. Deliberately distinct from the device MAC so a controller-scope
// assertion cannot pass by accidentally reading the device MAC.
const NVR_MAC = "112233445566";

// Construct a bare ProtectBase against the minimal mocks its MQTT wrappers read: an nvr carrying the controller MAC (the base mqttId reads through to this.nvr.ufp.mac)
// and an mqtt that captures the composed topic for each verb. The casts are confined to this seam; the instance itself is the production base class.
const makeController = (): { capture: MqttCapture; instance: TestProtectBase } => {

  const capture: MqttCapture = { publish: [], subscribeGet: [], subscribeSet: [] };
  const sink = (): void => undefined;
  const mqtt = {

    publish: async (topic: string): Promise<void> => { capture.publish.push(topic); },
    subscribeGet: (topic: string): void => { capture.subscribeGet.push(topic); },
    subscribeSet: (topic: string): void => { capture.subscribeSet.push(topic); }
  };
  const nvr = {

    mqtt,
    platform: { api: { hap: {} }, debug: sink, log: { debug: sink, error: sink, info: sink, warn: sink } },
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
