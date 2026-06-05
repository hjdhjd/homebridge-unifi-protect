/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * mqtt.ts: Shared MQTT topic composition for homebridge-unifi-protect.
 */

// Compose a device-scoped MQTT topic tail: the owner's id - a device or controller MAC - as the leading path segment, joined to the topic tail by a single slash. This is
// the one place HBUP defines that format; HBPU's MqttClient then prefixes the configured topicPrefix, yielding the wire topic {topicPrefix}/{id}/{topic}. Every publisher
// routes through here - the ProtectBase self-scoped wrappers and the event and stream owners that publish on behalf of an arbitrary device alike - so the device-topic
// convention is single-sourced. The id is scope-agnostic - a device MAC and a controller MAC are just id values - so the same composer serves both the device-scoped
// publishers and the controller-scoped telemetry topic. HBPU's unsubscribe(id, topic) takes the id and tail separately and composes the same shape internally, so it
// deliberately does not use this helper.
export function mqttTopic(id: string, topic: string): string {

  return id + "/" + topic;
}
