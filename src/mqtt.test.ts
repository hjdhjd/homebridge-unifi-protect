/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * mqtt.test.ts: Unit tests for the shared MQTT connection-settings resolver and topic composer.
 *
 * mqttTopic is the single source of the device-scoped MQTT topic format: the owner id joined to the topic tail by one slash. Every publisher - the ProtectBase wrappers
 * and the event and stream owners - composes through it, so the wire topic stays {topicPrefix}/{id}/{topic} after homebridge-plugin-utils' MqttClient prefixes the
 * configured topic. These tests pin that composition directly against the pure function: a single-segment tail, a multi-segment tail (the smart-motion metadata shape),
 * and both id scopes - a device MAC and a controller MAC are just id values to the composer.
 *
 * mqttConnectionSettings is what the controller resolves its broker and topic prefix through, and its pins drive the REAL feature-option engine over the REAL catalog
 * this plugin serves, so they bind to the same grammar the runtime resolves against rather than to a stand-in that could drift from it. The precedence they pin is
 * the whole point: a legacy topic property the user is publishing under today must survive an unconfigured topic option whose registered default would otherwise
 * answer for it.
 */
import { describe, test } from "node:test";
import { featureOptionCategories, featureOptions } from "./options.ts";
import { mqttConnectionSettings, mqttTopic } from "./mqtt.ts";
import { FeatureOptions } from "homebridge-plugin-utils";
import { PROTECT_MQTT_TOPIC } from "./settings.ts";
import assert from "node:assert/strict";

// The controller these pins resolve at. Every MQTT option in this plugin's catalog is declared at controller scope, so a scoped entry is the only configured form
// the resolver can meet.
const CONTROLLER_MAC = "AABBCCDDEEFF";

// The two brokers and two topics the precedence pins tell apart: one of each carried by a legacy schema property, one of each carried by a configured option.
const LEGACY_BROKER = "mqtt://127.0.0.1:1883";
const LEGACY_TOPIC = "home/protect";
const OPTION_BROKER = "mqtt://127.0.0.2:1883";
const OPTION_TOPIC = "attic/protect";

// A feature-option engine over the plugin's real catalog, carrying the supplied configured entries.
function engineWith(options: string[] = []): FeatureOptions {

  return new FeatureOptions(featureOptionCategories, featureOptions, options);
}

// The configured-options array holding one controller-scoped value entry, composed through the engine's own setOption rather than hand-typed, so these pins bind to
// the option grammar instead of to one spelling of it.
function scopedEntry(option: string, value: string): string[] {

  const engine = engineWith();

  engine.setOption({ enabled: true, id: CONTROLLER_MAC, option, value });

  return engine.configuredOptions;
}

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

describe("mqttConnectionSettings controller-scoped resolution", () => {

  test("resolves a legacy topic property when no topic entry is configured", () => {

    const settings = mqttConnectionSettings(engineWith(), { mqttTopic: LEGACY_TOPIC, mqttUrl: LEGACY_BROKER }, CONTROLLER_MAC);

    assert.deepEqual(settings, { brokerUrl: LEGACY_BROKER, topicPrefix: LEGACY_TOPIC },
      "an unconfigured topic option answers its registered default, so configured-ness must be read through scope() or a legacy topic silently stops being honored");
  });

  test("a configured controller-scoped topic outranks the legacy property", () => {

    const settings = mqttConnectionSettings(engineWith(scopedEntry("Mqtt.Topic", OPTION_TOPIC)), { mqttTopic: LEGACY_TOPIC, mqttUrl: LEGACY_BROKER }, CONTROLLER_MAC);

    assert.deepEqual(settings, { brokerUrl: LEGACY_BROKER, topicPrefix: OPTION_TOPIC }, "the user's own configured entry is their choice and supersedes the property");
  });

  test("a configured controller-scoped broker outranks the legacy property", () => {

    const settings = mqttConnectionSettings(engineWith(scopedEntry("Mqtt.Url", OPTION_BROKER)), { mqttTopic: LEGACY_TOPIC, mqttUrl: LEGACY_BROKER }, CONTROLLER_MAC);

    assert.deepEqual(settings, { brokerUrl: OPTION_BROKER, topicPrefix: LEGACY_TOPIC }, "the configured broker answers, and the unconfigured topic still falls back");
  });

  test("answers the canonical topic prefix when neither a configured topic nor a legacy one exists", () => {

    const settings = mqttConnectionSettings(engineWith(scopedEntry("Mqtt.Url", OPTION_BROKER)), {}, CONTROLLER_MAC);

    assert.deepEqual(settings, { brokerUrl: OPTION_BROKER, topicPrefix: PROTECT_MQTT_TOPIC }, "a controller publishing under nothing in particular uses our own prefix");
  });

  test("answers null when no broker is configured and none is carried by the legacy property", () => {

    assert.equal(mqttConnectionSettings(engineWith(), { mqttTopic: LEGACY_TOPIC }, CONTROLLER_MAC), null, "no broker anywhere means MQTT is off for this controller");
    assert.equal(mqttConnectionSettings(engineWith(), {}, CONTROLLER_MAC), null, "an empty controller configuration resolves the same way");
  });
});
