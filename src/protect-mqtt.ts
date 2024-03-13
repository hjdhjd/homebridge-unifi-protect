/* Copyright(C) 2017-2024, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-mqtt.ts: MQTT connectivity class for UniFi Protect.
 */
import mqtt, { MqttClient } from "mqtt";
import { PROTECT_MQTT_RECONNECT_INTERVAL } from "./settings.js";
import { PlatformAccessory } from "homebridge";
import { ProtectApi } from "unifi-protect";
import { ProtectLogging } from "./protect-types.js";
import { ProtectNvr } from "./protect-nvr.js";
import { ProtectNvrOptions } from "./protect-options.js";

export class ProtectMqtt {

  private config: ProtectNvrOptions;
  private isConnected: boolean;
  private log: ProtectLogging;
  private mqtt: MqttClient | null;
  private nvr: ProtectNvr;
  private subscriptions: { [index: string]: (cbBuffer: Buffer) => void };
  private ufpApi: ProtectApi;

  constructor(nvr: ProtectNvr) {

    this.config = nvr.config;
    this.isConnected = false;
    this.log = nvr.log;
    this.mqtt = null;
    this.nvr = nvr;
    this.subscriptions = {};
    this.ufpApi = nvr.ufpApi;

    if(!this.config.mqttUrl) {

      return;
    }

    this.configure();
  }

  // Connect to the MQTT broker.
  private configure(): void {

    // Try to connect to the MQTT broker and make sure we catch any URL errors.
    try {

      this.mqtt = mqtt.connect(this.config.mqttUrl, { reconnectPeriod: PROTECT_MQTT_RECONNECT_INTERVAL * 1000, rejectUnauthorized: false});

    } catch(error) {

      if(error instanceof Error) {

        switch(error.message) {

          case "Missing protocol":

            this.log.error("MQTT Broker: Invalid URL provided: %s.", this.config.mqttUrl);
            break;

          default:

            this.log.error("MQTT Broker: Error: %s.", error.message);
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

      // Magic incantation to redact passwords.
      const redact = /^(?<pre>.*:\/{0,2}.*:)(?<pass>.*)(?<post>@.*)/;

      this.log.info("Connected to MQTT broker: %s (topic: %s).", this.config.mqttUrl.replace(redact, "$<pre>REDACTED$<post>"), this.config.mqttTopic);
    });

    // Notify the user when we've disconnected.
    this.mqtt.on("close", () => {

      if(this.isConnected) {

        this.isConnected = false;

        // Magic incantation to redact passwords.
        const redact = /^(?<pre>.*:\/{0,2}.*:)(?<pass>.*)(?<post>@.*)/;

        this.log.info("Disconnected from MQTT broker: %s.", this.config.mqttUrl.replace(redact, "$<pre>REDACTED$<post>"));
      }
    });

    // Process inbound messages and pass it to the right message handler.
    this.mqtt.on("message", (topic: string, message: Buffer) => {

      if(this.subscriptions[topic]) {

        this.subscriptions[topic](message);
      }
    });

    // Notify the user when there's a connectivity error.
    this.mqtt.on("error", (error: Error) => {

      switch((error as NodeJS.ErrnoException).code) {

        case "ECONNREFUSED":

          this.log.error("MQTT Broker: Connection refused (url: %s). Will retry again in %s minute%s.", this.config.mqttUrl,
            PROTECT_MQTT_RECONNECT_INTERVAL / 60, PROTECT_MQTT_RECONNECT_INTERVAL / 60 > 1 ? "s": "");
          break;

        case "ECONNRESET":

          this.log.error("MQTT Broker: Connection reset (url: %s). Will retry again in %s minute%s.", this.config.mqttUrl,
            PROTECT_MQTT_RECONNECT_INTERVAL / 60, PROTECT_MQTT_RECONNECT_INTERVAL / 60 > 1 ? "s": "");
          break;

        case "ENOTFOUND":

          this.mqtt?.end(true);
          this.log.error("MQTT Broker: Hostname or IP address not found. (url: %s).", this.config.mqttUrl);
          break;

        default:

          this.log.error("MQTT Broker: %s (url: %s). Will retry again in %s minute%s.", error, this.config.mqttUrl,
            PROTECT_MQTT_RECONNECT_INTERVAL / 60, PROTECT_MQTT_RECONNECT_INTERVAL / 60 > 1 ? "s": "");
          break;
      }
    });
  }

  // Publish an MQTT event to a broker.
  public publish(accessory: PlatformAccessory | string, topic: string, message: string): void {

    const expandedTopic = this.expandTopic(accessory, topic);

    // No valid topic returned, we're done.
    if(!expandedTopic) {

      return;
    }

    this.log.debug("MQTT publish: %s Message: %s.", expandedTopic, message);

    // By default, we publish as: unifi/protect/mac/event/name
    this.mqtt?.publish(expandedTopic, message);
  }

  // Subscribe to an MQTT topic.
  public subscribe(accessory: PlatformAccessory | string, topic: string, callback: (cbBuffer: Buffer) => void): void {

    const expandedTopic = this.expandTopic(accessory, topic);

    // No valid topic returned, we're done.
    if(!expandedTopic) {

      return;
    }

    this.log.debug("MQTT subscribe: %s.", expandedTopic);

    // Add to our callback list.
    this.subscriptions[expandedTopic] = callback;

    // Tell MQTT we're subscribing to this event.
    // By default, we subscribe as: unifi/protect/mac/event/name.
    this.mqtt?.subscribe(expandedTopic);
  }

  // Subscribe to a specific MQTT topic and publish a value on a get request.
  public subscribeGet(accessory: PlatformAccessory, topic: string, type: string, getValue: () => string): void {

    // Return the current status of a given sensor.
    this.subscribe(accessory, topic + "/get", (message: Buffer) => {

      const value = message.toString().toLowerCase();

      // When we get the right message, we return the system information JSON.
      if(value !== "true") {

        return;
      }

      this.publish(accessory, topic, getValue());
      (this.nvr.configuredDevices[accessory.UUID]?.log ?? this.log).info("MQTT: %s status published.", type);
    });
  }

  // Subscribe to a specific MQTT topic and set a value on a set request.
  public subscribeSet(accessory: PlatformAccessory, topic: string, type: string, setValue: (value: string) => void): void {

    // Return the current status of a given sensor.
    this.subscribe(accessory, topic + "/set", (message: Buffer) => {

      const value = message.toString().toLowerCase();

      // Set our value and inform the user.
      setValue(value);
      (this.nvr.configuredDevices[accessory.UUID]?.log ?? this.log).info("MQTT: set message received for %s: %s.", type, value);
    });
  }

  // Unsubscribe to an MQTT topic.
  public unsubscribe(accessory: PlatformAccessory | string, topic: string): void {

    const expandedTopic = this.expandTopic(accessory, topic);

    // No valid topic returned, we're done.
    if(!expandedTopic) {

      return;
    }

    delete this.subscriptions[expandedTopic];
  }

  // Expand a topic to a unique, fully formed one.
  private expandTopic(accessory: PlatformAccessory | string, topic: string) : string | null {

    // No accessory, we're done.
    if(!accessory) {

      return null;
    }

    // Check if we were passed the MAC as an input. Otherwise, assume it's the controller's MAC initially.
    let mac = (typeof accessory === "string") ? accessory : (accessory.context.nvr as string);

    // Check to see if it's really a Protect device...if it is, use it's MAC address.
    if((typeof accessory !== "string") && ("mac" in accessory.context)) {

      mac = accessory.context.mac as string;
    }

    return this.config.mqttTopic + "/" + mac + "/" + topic;
  }
}
