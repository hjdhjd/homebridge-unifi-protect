/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * mqtt.ts: Shared MQTT topic composition and publishing for homebridge-unifi-protect.
 */

import type { HomebridgePluginLogging, MqttClient, Nullable } from "homebridge-plugin-utils";
import { guardedDispatch } from "homebridge-plugin-utils";

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
