/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * mqtt.test.ts: Unit tests for the shared MQTT topic composer.
 *
 * mqttTopic is the single source of the device-scoped MQTT topic format: the owner id joined to the topic tail by one slash. Every publisher - the ProtectBase wrappers
 * and the event and stream owners - composes through it, so the wire topic stays {topicPrefix}/{id}/{topic} after homebridge-plugin-utils' MqttClient prefixes the
 * configured topic. These tests pin that composition directly against the pure function: a single-segment tail, a multi-segment tail (the smart-motion metadata shape),
 * and both id scopes - a device MAC and a controller MAC are just id values to the composer.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mqttTopic } from "./mqtt.ts";

describe("mqttTopic device-scoped composition", () => {

  test("joins a single-segment topic tail to the id with one slash", () => {

    assert.equal(mqttTopic("AABBCCDDEEFF", "motion"), "AABBCCDDEEFF/motion", "the id is the leading segment, joined to the tail by a single slash");
  });

  test("passes a multi-segment topic tail through unchanged", () => {

    assert.equal(mqttTopic("AABBCCDDEEFF", "motion/smart/person/metadata"), "AABBCCDDEEFF/motion/smart/person/metadata",
      "a multi-segment tail is joined by one slash; the remaining segments stay part of the tail HBPU forwards verbatim");
  });

  test("is scope-agnostic, composing a controller MAC the same way as a device MAC", () => {

    assert.equal(mqttTopic("112233445566", "telemetry"), "112233445566/telemetry", "the controller-scoped telemetry topic composes identically to a device topic");
  });
});
