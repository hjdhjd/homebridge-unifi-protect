/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * mqtt.ts: Shared MQTT connection settings, topic composition, and publishing for homebridge-unifi-protect.
 */

import type { FeatureOptions, HomebridgePluginLogging, MqttClient, Nullable } from "homebridge-plugin-utils";
import { PROTECT_MQTT_TOPIC } from "./settings.ts";
import { guardedDispatch } from "homebridge-plugin-utils";

/* Resolve the MQTT broker and topic prefix for one controller, or null when that controller has no broker anywhere and MQTT is therefore off for it. Both settings
 * resolve at the controller's own scope first, with the legacy per-controller schema properties as the transition fallback, so a configuration nobody has opened the
 * webUI on keeps working exactly as it did.
 *
 * The two reads ask their question differently, and deliberately. The broker option defaults off, so an unconfigured broker resolves to nothing and the legacy
 * property answers through the nullish fallback. The topic option carries an always-on default, so reading its value would answer that default even when the user
 * has configured nothing...which would silently outrank a legacy topic. Configured-ness for the topic is therefore read through scope(), and only a topic the user
 * actually configured supersedes the legacy property. With neither configured, the plugin's canonical topic prefix answers.
 */
export function mqttConnectionSettings(featureOptions: FeatureOptions, config: { mqttTopic?: string; mqttUrl?: string },
  mac: string): Nullable<{ brokerUrl: string; topicPrefix: string }> {

  const brokerUrl = featureOptions.value("Mqtt.Url", undefined, mac) ?? config.mqttUrl;

  if(!brokerUrl) {

    return null;
  }

  const topicPrefix = (featureOptions.scope("Mqtt.Topic", undefined, mac) !== "none") ? featureOptions.value("Mqtt.Topic", undefined, mac) : config.mqttTopic;

  return { brokerUrl, topicPrefix: topicPrefix ?? PROTECT_MQTT_TOPIC };
}

// Compose a device-scoped MQTT topic tail: the owner's id - a device or controller MAC - as the leading path segment, joined to the topic tail by a single slash. This is
// the one place the plugin defines that format; homebridge-plugin-utils' MqttClient then prefixes the configured topicPrefix, yielding the wire topic
// {topicPrefix}/{id}/{topic}. Every publisher routes through here - the ProtectBase self-scoped wrappers and the event and stream owners that publish on behalf of an
// arbitrary device alike - so the device-topic convention is single-sourced. The id is scope-agnostic - a device MAC and a controller MAC are just id values - so the
// same composer serves both the device-scoped publishers and the controller-scoped telemetry topic. homebridge-plugin-utils' unsubscribe(id, topic) takes the id and tail
// separately and composes the same shape internally, so it deliberately does not use this helper.
export function mqttTopic(id: string, topic: string): string {

  return id + "/" + topic;
}

// Publish an MQTT message through guardedDispatch, so a rejected publish - the broker vanishing mid-write, a teardown race - lands in the log under a
// publish-specific label instead of floating as an unhandled rejection. Publishing is fire-and-forget by design; the guard makes the rare failure visible,
// not awaited. The caller composes the full topic, because topic composition is the one thing the call sites legitimately differ on.
export function guardedPublish(log: HomebridgePluginLogging, mqtt: Nullable<MqttClient>, topic: string, message: string): void {

  guardedDispatch({ handler: async (): Promise<void> => { await mqtt?.publish(topic, message); }, label: "MQTT publish (" + topic + ")", log });
}
