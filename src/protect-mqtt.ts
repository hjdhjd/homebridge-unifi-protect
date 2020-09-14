/* Copyright(C) 2017-2020, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-mqtt.ts: MQTT connectivity class for UniFi Protect.
 */
import { Logging, PlatformAccessory } from "homebridge";
import mqtt, { MqttClient } from "mqtt";
import { ProtectApi } from "./protect-api";
import { ProtectNvr } from "./protect-nvr";
import { ProtectCameraConfig, ProtectNvrOptions } from "./protect-types";
import { PROTECT_MQTT_RECONNECT_INTERVAL } from "./settings";

export class ProtectMqtt {
  private config: ProtectNvrOptions;
  private debug: (message: string, ...parameters: unknown[]) => void;
  private isConnected: boolean;
  private log: Logging;
  private mqtt: MqttClient | null;
  private nvr: ProtectNvr;
  private nvrApi: ProtectApi;
  private subscriptions: { [index: string]: (cbBuffer: Buffer) => void };

  constructor(nvr: ProtectNvr) {
    this.config = nvr.config;
    this.debug = nvr.platform.debug.bind(nvr.platform);
    this.isConnected = false;
    this.log = nvr.platform.log;
    this.mqtt = null;
    this.nvr = nvr;
    this.nvrApi = nvr.nvrApi;
    this.subscriptions = {};

    if(!this.config.mqttUrl) {
      return;
    }

    this.configure();
  }

  // Connect to the MQTT broker.
  private configure(): void {

    // Try to connect to the MQTT broker and make sure we catch any URL errors.
    try {

      this.mqtt = mqtt.connect(this.config.mqttUrl, { reconnectPeriod: PROTECT_MQTT_RECONNECT_INTERVAL * 1000});

    } catch(error) {

      if(error instanceof Error) {

        switch(error.message) {
          case "Missing protocol":
            this.log("%s MQTT Broker: Invalid URL provided: %s.", this.nvrApi.getNvrName(), this.config.mqttUrl);
            break;

          default:
            this.log("%s MQTT Broker: Error: %s.", this.nvrApi.getNvrName(), error.message);
            break;
        }

      }

    }

    // We've been unable to even attempt to connect. It's likely we have a configuration issue - we're done here.
    if(!this.mqtt) {
      return;
    }

    // Notify the user when we connect to the broker.
    this.mqtt.on("connect", () => {
      this.isConnected = true;
      this.log("%s: Connected to MQTT broker: %s (topic: %s)", this.nvrApi.getNvrName(), this.config.mqttUrl, this.config.mqttTopic);
    });

    // Notify the user when we've disconnected.
    this.mqtt.on("close", () => {
      if(this.isConnected) {
        this.isConnected = false;
        this.log("%s: Disconnected from MQTT broker: %s", this.nvrApi.getNvrName(), this.config.mqttUrl);
      }
    });

    // Process inbound messages and pass it to the right message handler.
    this.mqtt.on("message", (topic: string, message: Buffer) => {

      if(this.subscriptions[topic]) {
        this.subscriptions[topic](message);
      }
    });

    // Notify the user when there's a connectivity error.
    this.mqtt.on("error", (error: NodeJS.ErrnoException) => {
      switch(error.code) {
        case "ECONNREFUSED":
          this.log("%s MQTT Broker: Connection refused (url: %s). Will retry again in %s minute%s.",
            this.nvrApi.getNvrName(), this.config.mqttUrl,
            PROTECT_MQTT_RECONNECT_INTERVAL / 60, PROTECT_MQTT_RECONNECT_INTERVAL / 60 > 1 ? "s": "");
          break;

        case "ECONNRESET":
          this.log("%s MQTT Broker: Connection reset (url: %s). Will retry again in %s minute%s.",
            this.nvrApi.getNvrName(), this.config.mqttUrl,
            PROTECT_MQTT_RECONNECT_INTERVAL / 60, PROTECT_MQTT_RECONNECT_INTERVAL / 60 > 1 ? "s": "");
          break;

        case "ENOTFOUND":
          this.mqtt?.end(true);
          this.log("%s MQTT Broker: Hostname or IP address not found. (url: %s).", this.nvrApi.getNvrName(), this.config.mqttUrl);
          break;

        default:
          this.log("%s MQTT Broker: %s (url: %s). Will retry again in %s minute%s.",
            this.nvrApi.getNvrName(), error, this.config.mqttUrl,
            PROTECT_MQTT_RECONNECT_INTERVAL / 60, PROTECT_MQTT_RECONNECT_INTERVAL / 60 > 1 ? "s": "");
          break;
      }
    });
  }

  // Publish an MQTT event to a broker.
  public publish(accessory: PlatformAccessory | string, topic: string, message: string): void {

    // No accessory, we're done.
    if(!accessory) {
      return;
    }

    // Check if we were passed the MAC as an input. Otherwise, assume it's the controller's MAC initially.
    let mac = typeof accessory === "string" ? accessory : (accessory.context.nvr as string);

    // Check to see if it's really a camera...if it is, use it's MAC address.
    if((typeof accessory !== "string") && ("camera" in accessory.context)) {
      mac = (accessory.context.camera as ProtectCameraConfig).mac;
    }

    this.debug("%s: MQTT publish: %s Message: %s.", this.nvrApi.getNvrName(), this.config.mqttTopic + "/" + mac + "/" + topic, message);

    // By default, we publish as: unifi/protect/mac/event/name
    this.mqtt?.publish(this.config.mqttTopic + "/" + mac + "/" + topic, message);
  }

  // Subscribe to an MQTT topic.
  public subscribe(accessory: PlatformAccessory | string, topic: string, callback: (cbBuffer: Buffer) => void): void {

    // No accessory, we're done.
    if(!accessory) {
      return;
    }

    // Check if we were passed the MAC as an input. Otherwise, assume it's the controller's MAC initially.
    let mac = typeof accessory === "string" ? accessory : (accessory.context.nvr as string);

    // Check to see if it's really a camera...if it is, use it's MAC address.
    if((typeof accessory !== "string") && ("camera" in accessory.context)) {
      mac = (accessory.context.camera as ProtectCameraConfig).mac;
    }

    const expandedTopic = this.config.mqttTopic + "/" + mac + "/" + topic;

    this.debug("%s: MQTT subscribe: %s.", this.nvrApi.getNvrName(), expandedTopic);

    // Add to our callback list.
    this.subscriptions[expandedTopic] = callback;

    // Tell MQTT we're subscribing to this event.
    // By default, we subscribe as: unifi/protect/mac/event/name.
    this.mqtt?.subscribe(expandedTopic);
  }
}
