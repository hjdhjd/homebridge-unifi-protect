<SPAN ALIGN="CENTER" STYLE="text-align:center">
<DIV ALIGN="CENTER" STYLE="text-align:center">

[![homebridge-unifi-protect2: Native HomeKit support for UniFi Protect](https://raw.githubusercontent.com/hjdhjd/homebridge-unifi-protect2/master/homebridge-protect.svg)](https://github.com/hjdhjd/homebridge-unifi-protect2)

# Homebridge UniFi Protect<SUP STYLE="font-size: smaller; color:#0559C9;">2</SUP>

[![Downloads](https://img.shields.io/npm/dt/homebridge-unifi-protect2?color=%230559C9&style=for-the-badge)](https://www.npmjs.com/package/homebridge-unifi-protect2)
[![Version](https://img.shields.io/npm/v/homebridge-unifi-protect2?color=%230559C9&label=UniFi%20Protect%202&logo=ubiquiti&logoColor=%230559C9&style=for-the-badge)](https://www.npmjs.com/package/homebridge-unifi-protect2)
[![verified-by-homebridge](https://img.shields.io/badge/homebridge-verified-blueviolet?color=%2357277C&style=for-the-badge)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)

## HomeKit support for the UniFi Protect ecosystem using [Homebridge](https://homebridge.io).
</DIV>
</SPAN>

`homebridge-unifi-protect2` is a [Homebridge](https://homebridge.io) plugin that provides HomeKit support to the [UniFi Protect](https://unifi-network.ui.com/video-security) device ecosystem. [UniFi Protect](https://unifi-network.ui.com/video-security) is [Ubiquiti's](https://www.ui.com) next-generation video security platform, with rich camera, doorbell, and NVR controller hardware options for you to choose from, as well as an app which you can use to view, configure and manage your video camera and doorbells.

### MQTT Support
[MQTT](https://mqtt.org) is a popular Internet of Things (IoT) messaging protocol that can be used to weave together different smart devices and orchestrate or instrument them in an infinite number of ways. In short - it lets things that might not normally be able to talk to each other communicate across ecosystems, provided they can support MQTT.

I've provided MQTT support for those that are interested - I'm genuinely curious, if not a bit skeptical, at how many people actually want to use this capability. MQTT has a lot of nerd-credibility, and it was a fun small side project to mess around with. :smile:

### How to configure and use this feature

This documentation assumes you know what MQTT is, what an MQTT broker does, and how to configure it. Setting up an MQTT broker is beyond the scope of this documentation. There are plenty of guides available on how to do so just a search away.

`homebridge-unifi-protect2` will publish MQTT events if you've configured a broker in the controller-specific settings. We currently support publishing doorbell rings and motion sensor events over MQTT.

You configure MQTT settings within a `controller` configuration block. The settings are:

| Configuration Setting | Description
|-----------------------|----------------------------------
| **mqttUrl**           | The URL of your MQTT broker. **This must be in URL form**, e.g.: `mqtt://user@password:1.2.3.4`.
| **mqttTopic**         | The base topic to publish to. The default is: `unifi/protect`.

To reemphasize the above: **mqttUrl** must be a valid URL. Just entering a hostname will result in an error. The URL can use any of these protocols: `mqtt`, `mqtts`, `tcp`, `tls`, `ws`, `wss`.

When events are published, by default, the topics look like:

```sh
unifi/protect/1234567890AB/motion
unifi/protect/ABCDEF123456/doorbell
```

In the above examples, `1234567890AB` and `ABCDEF123456` are the MAC addresses of your cameras or doorbells. We use MAC addresses as an easy way to guarantee unique identifiers that won't change. `homebridge-unifi-protect2` provides you information about your cameras and their respective MAC addresses in the homebridge log on startup. Additionally, you can use the UniFi Protect app or webUI to lookup what the MAC addresses are of your cameras, should you need to do so.

The topics and messages that are published are:

| Topic                 | Message Published
|-----------------------|----------------------------------
| **doorbell**          | `true` when the doorbell is rung. Each press of the doorbell will trigger a new event.
| **motion**            | `true` when motion is detected. `false` when the motion event is reset.

### Some fun facts
  * MQTT support is disabled by default. It's enabled when an MQTT broker is specified in the configuration.
  * MQTT is configured per-controller. This allows you to have different MQTT brokers for different Protect controllers, if needed.
  * We only *publish* MQTT events, we do not subscribe to them. This means that `homebridge-unifi-protect2` can provide data to MQTT, but not act on anything published to perform an action itself.
  * If connectivity to the broker is lost, it will perpetually retry to connect in one-minute intervals.
  * If a bad URL is provided, MQTT support will not be enabled.
