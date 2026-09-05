/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * mqtt.test.ts: Unit tests for the MQTT topic catalog and the broker and topic resolution a controller builds its client from.
 *
 * The resolution rows drive the library's resolver over this plugin's OWN feature-option catalog rather than a stand-in, so what they assert is the behavior a
 * running configuration actually gets, including how the engine answers an option nobody has configured. Every fixture broker and topic below is deliberately
 * unlike the canonical prefix, so a row that lands on the canonical answer landed there because the resolver chose it.
 *
 * Importing the topic catalog runs the builder's own validation, so a declaration carrying two entries with the same wire topic, an entry with no message text at
 * all, or a malformed placeholder fails this whole file at load rather than reaching a broker.
 */
import { FeatureOptions, mqttConnectionSettings, resolveMqttTopic } from "homebridge-plugin-utils";
import { describe, test } from "node:test";
import { featureOptionCategories, featureOptions } from "./options.ts";
import { PROTECT_MQTT_TOPIC } from "./settings.ts";
import assert from "node:assert/strict";
import { mqttTopics } from "./mqtt.ts";

// The controller every row below resolves at. Both MQTT options are declared at controller scope in this plugin's catalog, so a scoped entry is the only configured
// form the resolver can meet.
const CONTROLLER_MAC = "AABBCCDDEEFF";

// The two brokers and two topics the precedence rows tell apart: one of each carried by a legacy schema property, one of each carried by a configured option.
const LEGACY_BROKER = "mqtt://127.0.0.1:1883";
const LEGACY_TOPIC = "home/protect";
const OPTION_BROKER = "mqtt://127.0.0.2:1883";
const OPTION_TOPIC = "attic/protect";

// A feature-option engine over the plugin's real catalog, carrying the supplied configured entries.
function engineWith(options: string[] = []): FeatureOptions {

  return new FeatureOptions(featureOptionCategories, featureOptions, options);
}

// The configured-options array holding one controller-scoped value entry, composed through the engine's own setOption rather than hand-typed, so these rows bind to
// the option grammar instead of to one spelling of it.
function scopedEntry(option: string, value: string): string[] {

  const engine = engineWith();

  engine.setOption({ enabled: true, id: CONTROLLER_MAC, option, value });

  return engine.configuredOptions;
}

// Resolve one controller's broker and topic exactly as the NVR does at construction.
function resolve(configured: string[], config: { mqttTopic?: string; mqttUrl?: string }): ReturnType<typeof mqttConnectionSettings> {

  return mqttConnectionSettings({ config, controller: CONTROLLER_MAC, featureOptions: engineWith(configured) });
}

describe("mqttConnectionSettings controller-scoped resolution", () => {

  test("answers null when no broker is configured anywhere", () => {

    assert.equal(resolve([], {}), null, "an empty controller configuration means MQTT is off for this controller");

    // A topic with no broker behind it is still no broker, so the topic never gets a client to be the prefix of.
    assert.equal(resolve([], { mqttTopic: LEGACY_TOPIC }), null, "a topic on its own is not a broker");
  });

  test("resolves exactly the pair the legacy properties carry when no option is configured", () => {

    assert.deepEqual(resolve([], { mqttTopic: LEGACY_TOPIC, mqttUrl: LEGACY_BROKER }), { brokerUrl: LEGACY_BROKER, topicPrefix: LEGACY_TOPIC },
      "a configuration nobody has opened the settings on keeps publishing where it always published");
  });

  test("a configured option supersedes the legacy property it stands in for", () => {

    assert.deepEqual(resolve(scopedEntry("Mqtt.Url", OPTION_BROKER), { mqttTopic: LEGACY_TOPIC, mqttUrl: LEGACY_BROKER }),
      { brokerUrl: OPTION_BROKER, topicPrefix: LEGACY_TOPIC }, "the configured broker answers and the untouched topic still yields to its property");

    assert.deepEqual(resolve(scopedEntry("Mqtt.Topic", OPTION_TOPIC), { mqttTopic: LEGACY_TOPIC, mqttUrl: LEGACY_BROKER }),
      { brokerUrl: LEGACY_BROKER, topicPrefix: OPTION_TOPIC }, "the configured topic answers and the untouched broker still yields to its property");
  });

  test("a topic option the user turned off leaves MQTT off for that controller", () => {

    /* An option the user configured answers in every state it can be in, and off is one of those states. A controller whose topic option is off is a controller
     * whose MQTT is off, even with a perfectly usable legacy pair beside it: the user reached for the option and said no, and a configuration property does not
     * get to speak over that.
     */
    assert.equal(resolve(["Disable.Mqtt.Topic." + CONTROLLER_MAC], { mqttTopic: LEGACY_TOPIC, mqttUrl: LEGACY_BROKER }), null,
      "the option the user turned off is the whole answer");
  });

  test("a broker option enabled without a value leaves MQTT off for that controller", () => {

    /* The same rule read from the broker side. The entry is written out rather than composed through setOption because the grammar has no scoped spelling for
     * "enabled here, nothing given" - setOption reduces that request to clearing the scope - so a hand-edited configuration file is the only way to reach this
     * state, and it is exactly the state a user reaches by emptying the field.
     */
    assert.equal(resolve(["Enable.Mqtt.Url." + CONTROLLER_MAC], { mqttUrl: LEGACY_BROKER }), null, "an option enabled with nothing in it is the user saying no");
  });

  test("an empty topic property beside a broker resolves the canonical prefix", () => {

    // A blank topic field is what produces an empty property, and the client refuses an empty prefix outright, so reading it as unset is what keeps a controller
    // whose user configured a broker publishing at all.
    assert.deepEqual(resolve([], { mqttTopic: "", mqttUrl: LEGACY_BROKER }), { brokerUrl: LEGACY_BROKER, topicPrefix: PROTECT_MQTT_TOPIC },
      "an empty topic reads as no topic, and the canonical prefix answers for it");
  });

  test("answers the canonical topic prefix when no topic is configured anywhere", () => {

    assert.deepEqual(resolve([], { mqttUrl: LEGACY_BROKER }), { brokerUrl: LEGACY_BROKER, topicPrefix: PROTECT_MQTT_TOPIC },
      "a controller publishing under nothing in particular publishes under our own prefix");
  });
});

describe("the MQTT topic catalog", () => {

  test("declares the wire topics every subscriber already relies on", () => {

    /* The tails are the plugin's external contract: an automation subscribes to the string on the broker, not to the entry key beside it. They are asserted
     * literally here rather than derived from the catalog under test, so adding or respelling a topic is a conscious edit in this file as well as in the
     * declaration.
     */
    assert.deepEqual(Object.fromEntries(Object.entries(mqttTopics).map(([ key, entry ]) => [ key, entry.topic ])), {

      airquality: "airquality",
      alarm: "alarm",
      ambientlight: "ambientlight",
      authenticate: "authenticate",
      button: "button",
      carbonmonoxide: "carbonmonoxide",
      chime: "chime",
      contact: "contact",
      doorbell: "doorbell",
      glassbreak: "glassbreak",
      humidity: "humidity",
      leak: "leak",
      leakExternal: "leak-external",
      light: "light",
      lightBrightness: "light/brightness",
      liveview: "liveview",
      liveviews: "liveviews",
      message: "message",
      motion: "motion",
      occupancy: "occupancy",
      relayOutput: "relay/{output}",
      rtsp: "rtsp",
      securitysystem: "securitysystem",
      smartMotion: "motion/smart/{object}",
      smartMotionMetadata: "motion/smart/{object}/metadata",
      smoke: "smoke",
      smokedetector: "smokedetector",
      snapshot: "snapshot",
      systeminfo: "systeminfo",
      telemetry: "telemetry",
      temperature: "temperature",
      tone: "tone",
      vape: "vape"
    });
  });

  test("resolves a template only against the parameter name it carries", () => {

    // A template resolved against the name it declares puts the caller's value on the wire, which is the relay output's whole numbering scheme.
    assert.equal(resolveMqttTopic(mqttTopics.relayOutput.topic, { output: "3" }), "relay/3");

    /* The refusal is asserted in both halves at once. The directive is the compile-time half: the parameter record's keys are derived from the template's own
     * literal type, so a misspelled name is an error here - and an unused directive is an error too, which is what fails this row the moment the catalog is
     * declared in a shape that widens every topic to a plain string. The throw is the runtime half, which answers wherever no literal type survives.
     */
    // @ts-expect-error - the template names "object", so a record keyed "objects" carries a parameter this topic does not have.
    assert.throws(() => resolveMqttTopic(mqttTopics.smartMotion.topic, { objects: "person" }), /object/);
  });
});
