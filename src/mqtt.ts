/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * mqtt.ts: The MQTT topic catalog for UniFi Protect.
 */
import { mqttTopicCatalog } from "homebridge-plugin-utils";

/* The plugin's whole MQTT topic surface, declared once and read from here by everything that spells a topic. Every publish, get, and set site takes its tail and
 * the name its log lines carry from this catalog, the documentation renderer projects the same declaration into the two marked regions of docs/MQTT.md at the docs
 * build, and the builder checks the declaration the moment this module is evaluated: an entry carrying no message text at all, two entries producing the same wire
 * topic, and a malformed placeholder each fail the load rather than reaching a broker. A tail therefore has exactly one spelling in the plugin, and what the
 * document prints cannot disagree with what the plugin publishes.
 *
 * This module imports the library and nothing else - above all nothing from the device graph - because the documentation CLI loads it compiled and standalone,
 * exactly as it loads the feature-option catalog. A single import from the device side would drag that whole graph into the CLI's load.
 *
 * An entry's label is the noun the client's get and set log lines carry: it reaches subscribeGet and subscribeSet as the name of the thing being read or written,
 * and the user reads it in the sentence the client writes. The device column is documentation alone, projected into each row's device cell and read by nothing at
 * runtime, so its vocabulary fixes both the spelling of every device kind and the order each cell lists them in. A published topic and its get and set children are
 * one entry, so a topic whose get is answered by only one of the kinds that touch it still names every one of them.
 */
export const mqttTopics = mqttTopicCatalog({

  airquality: { devices: ["sensor"], get: "`true` will trigger a publish event of the current air quality metrics for a UniFi Protect sensor.", label: "air quality",
    publish: "`JSON` containing every air quality metric a UniFi Protect sensor reports: `aqi`, `co2`, `humidity`, `nox`, `pm10p0`, `pm1p0`, `pm2p5`, `pm4p0`, " +
      "`temperature`, `tvoc`, `vape`, and `voc`. Each is an object in the format `{\"status\": \"neutral\", \"value\": 42}`, where `value` is `null` whenever that " +
      "metric isn't currently reporting a reading. Sensors without air quality hardware never publish this topic.", topic: "airquality" },
  alarm: { devices: ["sensor"], get: "`true` will trigger a publish event of the current alarm state for a UniFi Protect sensor.", label: "alarm sound",
    publish: "`true` or `false` when a UniFi Protect sensor detects a recognized alarm sound.", topic: "alarm" },
  ambientlight: { devices: [ "camera", "sensor" ], get: "`true` will trigger a publish event of the ambient light level, in lux, for a UniFi Protect sensor.",
    label: "ambient light", publish: "Ambient light level, in lux, from a UniFi Protect sensor or a camera's ambient light sensor.", topic: "ambientlight" },
  authenticate: { devices: ["doorbell"], label: "authentication",
    publish: "`{type: \"fingerprint\"}` or `{type: \"nfc\", id: cardId}`. Publishes upon a successful authentication using fingerprint or NFC. `id` is included " +
      "only for NFC and contains the card ID as detected by the doorbell.", topic: "authenticate" },
  button: { devices: ["fob"], label: "fob button",
    publish: "`{\"button\": \"arm\", \"pressType\": \"single\"}` when a UniFi Protect fob button is pressed. `button` is the button that was pressed and " +
      "`pressType` is the gesture. Published for every press, including buttons you've hidden in HomeKit.", topic: "button" },
  carbonmonoxide: { devices: ["sensor"],
    get: "`true` will trigger a publish event of the current carbon monoxide alarm state for a UniFi Protect smoke detector.", label: "carbon monoxide",
    publish: "`true` or `false` when a UniFi Protect smoke detector detects carbon monoxide.", topic: "carbonmonoxide" },
  chime: { devices: ["doorbell"], get: "`true` will trigger a publish event of the volume level for a UniFi Protect doorbell.", label: "chime volume",
    publish: "A number between 0 and 100 that represents the current volume of the chime as a percentage.",
    set: "A number between 0 and 100 that will set the volume level for a UniFi Protect doorbell.", topic: "chime" },
  contact: { devices: ["sensor"],
    get: "`true` will trigger a publish event of the current contact state for a UniFi Protect sensor. Note: UniFi Protect will set this state differently " +
      "depending on the placement type you select in the Protect app or the Protect webUI.", label: "contact sensor",
    publish: "`true` or `false` when a UniFi Protect sensor detects contact. Note: UniFi Protect will set this state differently depending on the placement type " +
      "you select in the Protect app or the Protect webUI.", topic: "contact" },
  doorbell: { devices: [ "camera", "doorbell" ], label: "doorbell ring",
    publish: "`true` when the doorbell is rung, `false` when the ring ends. Each press of the doorbell will trigger a new event.",
    set: "`true` will trigger the camera (if set as doorbell) or doorbell to generate a ring event.", topic: "doorbell" },
  glassbreak: { devices: ["sensor"], get: "`true` will trigger a publish event of the current glass break state for a UniFi Protect sensor.", label: "glass break",
    publish: "`true` or `false` when a UniFi Protect sensor detects the sound of breaking glass.", topic: "glassbreak" },
  humidity: { devices: ["sensor"], get: "`true` will trigger a publish event of the humidity level, as a percentage, for a UniFi Protect sensor.", label: "humidity",
    publish: "Humidity percentage level on a UniFi Protect sensor.", topic: "humidity" },
  leak: { devices: ["sensor"], get: "`true` will trigger a publish event of the current leak sensor state for a UniFi Protect sensor.", label: "leak sensor",
    publish: "`true` or `false` when a UniFi Protect sensor detects a leak.", topic: "leak" },
  leakExternal: { devices: ["sensor"], get: "`true` will trigger a publish event of the current external leak sensor state for a UniFi Protect sensor.",
    label: "external leak sensor", publish: "`true` or `false` when a UniFi Protect sensor detects a leak using the external leak sensor.", topic: "leak-external" },
  light: { devices: ["light"], get: "`true` or `false` when a UniFi Protect light is on or off.", label: "light",
    publish: "`true` or `false` when a UniFi Protect light is on or off.", set: "`true` or `false` to turn on or off a UniFi Protect light.", topic: "light" },
  lightBrightness: { devices: ["light"],
    get: "`true` will trigger a publish event of the light brightness level, as a percentage, for a UniFi Protect light.", label: "light brightness",
    publish: "A number between 0 and 100 that represents the current brightness as a percentage.",
    set: "A number between 0 and 100 that will set the brightness level of a UniFi Protect light.", topic: "light/brightness" },
  liveview: { devices: ["viewer"],
    get: "`true` will request that the plugin publish the current liveview being displayed on a UniFi Protect Viewport.", label: "liveview",
    publish: "The current liveview being displayed on a UniFi Protect Viewport.",
    set: "The name of a liveview to be set as the currently displayed liveview on a Protect viewer.", topic: "liveview" },
  liveviews: { devices: ["controller"], get: "`true` will trigger a publish event of all liveviews to the `liveviews` topic.", label: "liveview scenes",
    publish: "`[{name: \"LiveviewName\", state: true}, {name: \"AnotherLiveview\", state: false}]`. `state` can be `true` or `false`, indicating whether a " +
      "liveview scene is active.",
    set: "A JSON-compatible array in the format `[{\"name\": \"view1\", \"state\": true }, ...]` This will activate or deactivate one of more liveviews, " +
      "depending on the respective state.", topic: "liveviews" },
  message: { devices: ["doorbell"],
    get: "`true` will trigger a publish event of the current message JSON for the doorbell. See [Doorbell Messages](#doorbell-messages) for additional " +
      "documentation.", label: "doorbell message",
    publish: "`{message: \"Some Message\", duration: 60}`. See [Doorbell Messages](#doorbell-messages) for additional documentation.",
    set: "A JSON in the format `{\"message\":\"Some Message\",\"duration\":60}`. See [Doorbell Messages](#doorbell-messages) for additional documentation.",
    topic: "message" },
  motion: { devices: [ "camera", "light", "sensor" ], get: "`true` will trigger a publish event of the motion sensor state.", label: "motion",
    publish: "`true` when motion is detected. `false` when the motion event is reset.", set: "`true` will trigger a motion event on the motion sensor.",
    topic: "motion" },
  occupancy: { devices: [ "camera", "light", "sensor" ], get: "`true` will trigger a publish event of the occupancy sensor state.", label: "occupancy",
    publish: "`true` when occupancy is detected. `false` when occupancy is no longer detected.", topic: "occupancy" },
  relayOutput: { devices: ["relay"], get: "`true` will trigger a publish of the relay output's current on/off state.", label: "relay output",
    publish: "`true` or `false` for the on/off state of a relay output. Outputs are numbered starting at 1.",
    set: "`true` or `false` to turn a relay output on or off.", topic: "relay/{output}" },
  rtsp: { devices: ["camera"],
    get: "`true` will request that the plugin publish a message to the `rtsp` topic containing a JSON of RTSP URLs for the camera or doorbell.",
    label: "RTSP information",
    publish: "`{name: \"URL\"}`. Represents a JSON containing the RTSP URLs for whichever of this camera's channels currently have RTSP enabled, which is an " +
      "empty JSON object when none of them do. `Name` is the name assigned by UniFi Protect to the RTSP URL. `URL` represents the URL that can be used for " +
      "streaming.", topic: "rtsp" },
  securitysystem: { devices: ["controller"], get: "`true` will trigger a publish event of the current state of the security system accessory.",
    label: "security system state",
    publish: "One of `Alarm`, `Away`, `Home`, `Night`, `Off`. This message is published every time the security state is set.",
    set: "One of `AlarmOff`, `AlarmOn`, `Away`, `Home`, `Night`, `Off`. This will set the respective state on the security system accessory.",
    topic: "securitysystem" },
  smartMotion: { devices: ["camera"], label: "smart motion",
    publish: "`true` when a smart motion event is detected for *object*. `false` when the smart motion event is reset. Valid *object* types include visual " +
      "detection (`animal`, `face`, `licensePlate`, `package`, `person`, `vehicle`) and audio detection (`alrmBabyCry`, `alrmBark`, `alrmBurglar`, " +
      "`alrmCarHorn`, `alrmCmonx`, `alrmGlassBreak`, `alrmSiren`, `alrmSmoke`, `alrmSpeak`, `smoke_cmonx`). If what you want to listen for is whether a motion " +
      "event is sent to HomeKit, use the `motion` topic instead.", topic: "motion/smart/{object}" },
  smartMotionMetadata: { devices: ["camera"], label: "smart motion metadata",
    publish: "`JSON` when metadata associated with a smart motion detection event is available from Protect such as license plate information, vehicle type, or " +
      "color. Currently, this is only valid for `vehicle` smart motion events.", topic: "motion/smart/{object}/metadata" },
  smoke: { devices: ["sensor"], get: "`true` will trigger a publish event of the current smoke alarm state for a UniFi Protect smoke detector.", label: "smoke",
    publish: "`true` or `false` when a UniFi Protect smoke detector detects smoke.", topic: "smoke" },
  smokedetector: { devices: ["sensor"],
    get: "`true` will trigger a publish event of the current status of a UniFi Protect smoke detector.", label: "smoke detector status",
    publish: "`JSON` containing the full status of a UniFi Protect smoke detector: the `smokeAlarm` and `coAlarm` states, the raw `smokeValue` and `coValue` " +
      "readings, `testing`, `alarmSilenced`, `troubleHushed`, the `smokeSensorFault`, `coSensorFault`, `cleanSmokeSensor`, and `endOfLife` flags, `batteryLow` and " +
      "`batteryVoltage`, `enabled`, `ready`, `wasMounted`, and the `smokeAlarmTriggeredAt`, `coAlarmTriggeredAt`, `alarmSilencedAt`, and `troubleSilencedAt` " +
      "timestamps, each `null` when that event has never occurred. Sensors without smoke detector hardware never publish this topic.", topic: "smokedetector" },
  snapshot: { devices: ["camera"], label: "snapshot",
    publish: "A [data URL](https://developer.mozilla.org/en-US/docs/Web/HTTP/Basics_of_HTTP/Data_URIs) containing a base64-encoded JPEG of the snapshot that was " +
      "requested (either by HomeKit or MQTT).", set: "`true` will trigger the camera to generate a snapshot.", topic: "snapshot" },
  systeminfo: { devices: ["controller"], get: "`true` will trigger a publish of the current controller system information to the `systeminfo` topic.",
    label: "system information", publish: "`JSON` containing the current Protect controller system information.", topic: "systeminfo" },
  telemetry: { devices: ["controller"], label: "telemetry",
    publish: "All UniFi Protect telemetry from the realtime events API. This is the raw feed - you're on your own to parse through it for the messages you may be " +
      "interested in. This is published to the controller MAC address.", topic: "telemetry" },
  temperature: { devices: ["sensor"], get: "`true` will trigger a publish event of the temperature, in Celsius, for a UniFi Protect sensor.", label: "temperature",
    publish: "Temperature, in Celsius, on a UniFi Protect sensor.", topic: "temperature" },
  tone: { devices: ["chime"], label: "chime tone", publish: "`buzzer` or `chime` when a UniFi Protect chime plays the corresponding tone.",
    set: "A value of either `buzzer` or `chime` will play the selected tone on a UniFi Protect chime.", topic: "tone" },
  vape: { devices: ["sensor"], get: "`true` will trigger a publish event of the current vape detection state for a UniFi Protect sensor.", label: "vape detection",
    publish: "`true` or `false` when a UniFi Protect sensor detects vaping.", topic: "vape" }
}, {

  heading: "Protect Device Type",
  vocabulary: {

    camera: "Camera",
    chime: "Chime",
    controller: "Controller",
    doorbell: "Doorbell",
    fob: "Fob",
    light: "Light",
    relay: "Relay",
    sensor: "Sensor",
    viewer: "Viewport"
  }
});
