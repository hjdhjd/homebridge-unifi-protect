/* Copyright(C) 2017-2020, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-mqtt.ts: MQTT connectivity class for UniFi Protect.
 */
import { Logging, PlatformAccessory } from "homebridge";
import mqtt, { MqttClient } from "mqtt";
import { ProtectApi } from "./protect-api";
import { ProtectNvr } from "./protect-nvr";
import { ProtectNvrOptions } from "./protect-types";
import { PROTECT_MQTT_RECONNECT_INTERVAL } from "./settings";

export class ProtectMqtt {
  private config: ProtectNvrOptions;
  private debug: (message: string, ...parameters: any[]) => void;
  private isConnected: boolean;
  private log: Logging;
  private mqtt: MqttClient;
  private nvr: ProtectNvr;
  private nvrApi: ProtectApi;

  constructor(nvr: ProtectNvr) {
    this.config = nvr.config;
    this.debug = nvr.platform.debug.bind(nvr.platform);
    this.isConnected = false;
    this.log = nvr.platform.log;
    this.mqtt = null as any;
    this.nvr = nvr;
    this.nvrApi = nvr.nvrApi;

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
      switch(error.message) {
        case "Missing protocol":
          this.log("%s MQTT Broker: Invalid URL provided: %s.", this.nvrApi.getNvrName(), this.config.mqttUrl);
          break;

        default:
          this.log("%s MQTT Broker: Error: %s.", this.nvrApi.getNvrName(), error.message);
          break;
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
          this.mqtt.end(true);
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
  publish(accessory: PlatformAccessory, topic: string, message: string): void {

    // MQTT isn't configured, we're done.
    if(!this.isConnected) {
      return;
    }

    this.debug("%s: MQTT publish: %s Message: %s.", this.nvrApi.getNvrName(), this.config.mqttTopic + "/" + accessory.context.camera.mac + "/" + topic, message);

    // By default, we publish as: unifi/protect/mac/event/name
    this.mqtt.publish(this.config.mqttTopic + "/" + accessory.context.camera.mac + "/" + topic, message);
  }

  // Subscribe to an MQTT topic.
  subscribe(accessory: PlatformAccessory, topic: string, callback: (cbBuffer: Buffer) => void): void {

    // By default, we subscribe as: unifi/protect/mac/event/name.
    this.mqtt.on("connect", () => {
      this.mqtt.subscribe(this.config.mqttTopic + "/" + accessory.context.camera.mac + "/" + topic);
      this.debug("%s: MQTT subscribe: %s.", this.nvrApi.getNvrName(), this.config.mqttTopic + "/" + accessory.context.camera.mac + "/" + topic);
    });

    this.mqtt.on("message", (topic: string, message: Buffer) => {
      callback(message);
    });
  }
}
