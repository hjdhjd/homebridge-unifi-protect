/* Copyright(C) 2020-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * options.ts: Feature option and type definitions for UniFi Protect.
 */
import { ALL_CHOICES, mqttFeatureOptions } from "homebridge-plugin-utils";
import type { FeatureCategoryEntry, FeatureOptionChoice, FeatureOptionEntry } from "homebridge-plugin-utils";
import { PROTECT_DEVICE_REMOVAL_DELAY_INTERVAL, PROTECT_DOORBELL_CHIME_DURATION_DIGITAL, PROTECT_DOORBELL_RING_DELAY, PROTECT_FFMPEG_AUDIO_FILTER_FFTNR,
  PROTECT_FFMPEG_AUDIO_FILTER_HIGHPASS, PROTECT_FFMPEG_AUDIO_FILTER_LOWPASS, PROTECT_M3U_PLAYLIST_PORT, PROTECT_MOTION_DURATION, PROTECT_MQTT_TOPIC,
  PROTECT_NVR_REBOOT_INTERVAL, PROTECT_OCCUPANCY_DURATION, PROTECT_TRANSCODE_BITRATE, PROTECT_TRANSCODE_HIGH_LATENCY_BITRATE } from "./settings.ts";
import { FOB_BUTTON_CHOICES } from "./devices/fob-buttons.ts";

// Plugin configuration options.
export interface ProtectOptions {

  controllers: ProtectNvrOptions[];
  debugAll: boolean;
  options: string[];
  ringDelay: number;
  verboseFfmpeg: boolean;
  videoProcessor: string;
}

// NVR configuration options.
export interface ProtectNvrOptions {

  address: string;
  mqttTopic?: string;
  mqttUrl?: string;
  overrideAddress?: string;
  password: string;
  username: string;
}

// The plugin's webUI and documentation renderer make use of additional metadata to only surface the feature options relevant for a particular device. These properties
// ride in the opaque `meta` channel that homebridge-plugin-utils forwards back to us without interpreting, and provide that metadata.
//
// choiceDomain:        The values a source-backed picker offers at the scopes where no device record is in view, since a domain derived from a device cannot be read
//                      there. The webUI's resolver labels and offers this list rather than rendering a control with nothing in it.
// choiceLabels:        The display name each of a picker's values reads as, keyed by the value itself. The webUI's resolver renders these rather than deriving copy
//                      from a wire spelling, so a picker offers the same names the logs and the HomeKit accessories use.
// hasAccessFeature:    Properties in the UniFi Access metadata featureFlags object that must be enabled for this option to be exposed.
// hasCameraFeature:    Properties in the featureFlags object on cameras that must be enabled for this option to be exposed.
// hasFeature:          Properties in the featureFlags object that must be enabled for this option to be exposed.
// hasLightProperty:    Properties that must exist on the device object for a light device for this option to be exposed.
// hasProperty:         Properties that must exist on the device object for this option to be exposed.
// hasSensorProperty:   Properties that must exist on the device object for a sensor device for this option to be exposed.
// hasSmartObjectType:  Smart object detection capability that must exist for this option to be exposed.
// modelKey:            Device categories that the option applies to, or "all" for any device type.
export interface ProtectOptionMeta {

  choiceDomain?: string[];
  choiceLabels?: Readonly<Record<string, string>>;
  hasAccessFeature?: string[];
  hasCameraFeature?: string[];
  hasFeature?: string[];
  hasLightProperty?: string[];
  hasProperty?: string[];
  hasSensorProperty?: string[];
  hasSmartObjectType?: string[];
  modelKey?: string[];
}

// Category-level metadata mirroring the option-level channel above.
//
// featureByModel:  Per device-model featureFlags that must be enabled for the category to be exposed on that model. For example { sensor: ["motion"] } gates the
//                  category on a sensor's "motion" feature flag.
// modelKey:        Device categories that the category applies to, or "all" for any device type.
interface ProtectCategoryMeta {

  featureByModel?: Record<string, string[]>;
  modelKey?: string[];
}

// The MQTT option group, composed from the shared generator so every plugin exposing an MQTT broker offers the same options under the same names. Both entries are
// declared at controller scope: each configured Protect controller reaches its own broker and publishes under its own topic prefix.
const mqtt = mqttFeatureOptions({ defaultTopic: PROTECT_MQTT_TOPIC, scopes: ["controller"] });

// The canonical spelling of a Protect stream-quality tier, which is the form the streaming layer matches a channel profile's name against.
export type StreamQualityTier = "HIGH" | "LOW" | "MEDIUM";

/* The stream-quality tiers a channel pin can name. Each row pairs the canonical form the streaming layer steers on with the text the picker offers and the
 * configuration stores, so the two spellings are one table rather than two hand-authored lists that could drift apart. The rows read in descending quality order,
 * which is the order the pickers render and the order a pin resolves through when more than one tier is named at once...the best quality named is the one that wins.
 */
export const STREAM_QUALITY_TIERS: readonly { readonly choice: string; readonly tier: StreamQualityTier }[] = [

  { choice: "High", tier: "HIGH" },
  { choice: "Medium", tier: "MEDIUM" },
  { choice: "Low", tier: "LOW" }
];

// The picker list both channel pins offer, derived from the tier table above so a value the user stores and the tier the runtime steers on cannot be spelled apart.
const streamQualityChoices: readonly FeatureOptionChoice[] = STREAM_QUALITY_TIERS.map((entry) => ({ label: entry.choice, value: entry.choice }));

/* Every smart detection type Protect reports, paired with the display name a person reads it as and with the option name its own per-type feature option carried
 * before the detection selections became pickers. The value is the string the controller sends on the wire and the string a selection stores; the name is the
 * spelling the retired option used. The pairing is written out as data rather than derived, because "lowercase the first letter" describes most of these rows and
 * not all of them, and a rule with exceptions is a rule that eventually gets one wrong.
 *
 * The label column is the one place a detection type's display name is written, and every user-facing surface reads it: the settings page's picker copy, the
 * HomeKit contact sensor names a camera creates, and the log narration. The controller spells several of these types for its own protocol convenience - the audio
 * alarm family's "alrmCmonx" and its siblings say nothing to the person reading them - so the label is what faces the user, while the value stays the protocol
 * identity everywhere it is stored, published, matched, or addressed.
 *
 * This is also the settings page's fallback domain at the scopes where no camera record is in view. A picker there offers the known types rather than nothing at
 * all, because the retired per-type options were editable at every scope and an empty control would quietly retire that surface.
 */
export const SMART_DETECT_TYPES: readonly { readonly label: string; readonly name: string; readonly value: string }[] = [

  { label: "Animal", name: "Animal", value: "animal" },
  { label: "Face", name: "Face", value: "face" },
  { label: "License Plate", name: "LicensePlate", value: "licensePlate" },
  { label: "Package", name: "Package", value: "package" },
  { label: "Person", name: "Person", value: "person" },
  { label: "Vehicle", name: "Vehicle", value: "vehicle" },
  { label: "Baby Crying", name: "AlrmBabyCry", value: "alrmBabyCry" },
  { label: "Barking", name: "AlrmBark", value: "alrmBark" },
  { label: "Burglar", name: "AlrmBurglar", value: "alrmBurglar" },
  { label: "Car Horn", name: "AlrmCarHorn", value: "alrmCarHorn" },
  { label: "CO Alarm", name: "AlrmCmonx", value: "alrmCmonx" },
  { label: "Glass Breakage", name: "alrmGlassBreak", value: "alrmGlassBreak" },
  { label: "Siren", name: "AlrmSiren", value: "alrmSiren" },
  { label: "Smoke Alarm", name: "AlrmSmoke", value: "alrmSmoke" },
  { label: "Speaking", name: "AlrmSpeak", value: "alrmSpeak" },
  { label: "Smoke/CO Alarm", name: "Smoke_cmonx", value: "smoke_cmonx" }
];

// The detection types a picker offers where no camera record is in view, which is every scope above the device. Derived from the table above so the settings page and
// the translation always offer the same set.
const smartDetectDomain: string[] = SMART_DETECT_TYPES.map((type) => type.value);

// The display name each detection type reads as, keyed by the wire value that names it. Derived from the same table the domain above comes from, so the picker copy,
// the sensor names, and the log narration render one curated name rather than each keeping a copy of it.
const SMART_DETECT_LABELS: Readonly<Record<string, string>> = Object.fromEntries(SMART_DETECT_TYPES.map((type) => [ type.value, type.label ]));

/* Render a wire identifier as a display name: split the underscores and the camelCase joins, then capitalize each word. This is the behavior twin of the settings
 * page's own humanizeChoice (homebridge-ui/public/ui.mjs), which does this job on the browser side where this module cannot be reached, so a change to the rule
 * belongs in both. It is deliberately not homebridge-plugin-utils' toStartCase, which capitalizes at whitespace alone and would leave "licensePlate" as one word.
 */
function humanizeDetectionType(value: string): string {

  return value.replace(/_/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(" ").filter((word) => word.length)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}

/**
 * Read the display name a smart detection type reads as.
 *
 * A type the table names answers with its curated label. Anything else is a type a newer Protect firmware has begun reporting, and the humanizing rule renders it
 * readably rather than surfacing a wire spelling to the person looking at it.
 *
 * @param value - The detection type, as the controller spells it on the wire.
 *
 * @returns The display name.
 */
export function smartDetectLabel(value: string): string {

  return SMART_DETECT_LABELS[value] ?? humanizeDetectionType(value);
}

/* eslint-disable @stylistic/max-len -- The catalog's category and option entries are one-line records, kept unwrapped by intent. */

// Feature option categories.
export const featureOptionCategories: FeatureCategoryEntry<ProtectCategoryMeta>[] = [

  { description: "Audio", meta: { modelKey: ["camera"] }, name: "Audio" },
  { description: "Device-wide", meta: { modelKey: ["all"] }, name: "Device" },
  { description: "Doorbell & Chime", meta: { modelKey: ["camera"] }, name: "Doorbell" },
  { description: "Fob", meta: { modelKey: ["fob"] }, name: "Fob" },
  { description: "Logging", meta: { modelKey: [ "camera", "light", "sensor" ] }, name: "Log" },
  { description: "Motion & Occupancy", meta: { featureByModel: { camera: ["hasMotionDetection"], sensor: ["motion"] }, modelKey: [ "camera", "light", "sensor" ] }, name: "Motion" },
  // The generated group carries no meta at all, so the cast widens nothing our own entries declare - it only bridges the generator's unannotated entry type into our
  // meta-typed array.
  mqtt.category as FeatureCategoryEntry<ProtectCategoryMeta>,
  { description: "Protect Controller", meta: { modelKey: [ "camera", "nvr" ] }, name: "Nvr" },
  { description: "Relay", meta: { modelKey: ["relay"] }, name: "Relay" },
  { description: "Security System", meta: { modelKey: ["nvr"] }, name: "SecuritySystem" },
  { description: "Sensor", meta: { modelKey: ["sensor"] }, name: "Sensor" },
  { description: "UniFi Access", meta: { modelKey: ["camera"] }, name: "UniFi.Access" },
  { description: "Video & Streaming", meta: { modelKey: ["camera"] }, name: "Video" },
  { description: "HomeKit Secure Video", meta: { featureByModel: { camera: ["hasMotionDetection"] }, modelKey: ["camera"] }, name: "Video.HKSV" },
  { description: "Timeshift Buffer", meta: { modelKey: ["camera"] }, name: "Video.Timeshift" }
];

export const featureOptions: Record<string, FeatureOptionEntry<ProtectOptionMeta>[]> = {

  // Audio options.
  "Audio": [

    { default: true, description: "Audio support.", meta: { hasFeature: ["hasMic"] }, name: "" },
    { default: false, description: "Audio filter for ambient noise suppression.", meta: { hasFeature: ["hasMic"] }, name: "Filter.Noise" },
    { default: true, defaultValue: PROTECT_FFMPEG_AUDIO_FILTER_FFTNR, description: "Noise reduction amount, in decibels, for the FFmpeg afftdn filter.", group: "Filter.Noise", name: "Filter.Noise.FftNr" },
    { default: true, defaultValue: PROTECT_FFMPEG_AUDIO_FILTER_HIGHPASS, description: "Frequency, in Hertz, for the FFmpeg highpass filter.", group: "Filter.Noise", name: "Filter.Noise.HighPass" },
    { default: true, defaultValue: PROTECT_FFMPEG_AUDIO_FILTER_LOWPASS, description: "Frequency, in Hertz, for the FFmpeg lowpass filter.", group: "Filter.Noise", name: "Filter.Noise.LowPass" },
    { default: true, description: "Two-way audio support on supported cameras.", meta: { hasFeature: ["hasSpeaker"] }, name: "TwoWay" },
    { default: false, description: "Send two-way audio directly to supported cameras, bypassing the controller. Useful for working around bugs in some Protect controller firmware versions.", group: "TwoWay", meta: { hasFeature: ["hasSpeaker"] }, name: "TwoWay.Direct" }
  ],

  // Device options.
  "Device": [

    { default: true, description: "Make this device available in HomeKit.", name: "" },
    { default: true, description: "Enable the status indicator light for this device in HomeKit.", meta: { hasFeature: ["hasLedStatus"], modelKey: ["camera"] }, name: "StatusLed" },
    { default: false, description: "Add a switch accessory to control the status indicator light in HomeKit.", meta: { hasCameraFeature: ["hasLedStatus"], hasLightProperty: ["lightDeviceSettings"], hasSensorProperty: ["ledSettings"], modelKey: [ "camera", "light", "relay", "sensor" ] }, name: "StatusLed.Switch" },
    { default: true, description: "Enable the night vision indicator light for this device in HomeKit.", meta: { hasFeature: ["hasLedIr"], modelKey: ["camera"] }, name: "NightVision" },
    { default: false, description: "Add a dimmer accessory to control the night vision state in HomeKit.", meta: { hasFeature: ["hasLedIr"], modelKey: ["camera"] }, name: "NightVision.Dimmer" },
    { default: true, description: "Enable the ambient light sensor for this device in HomeKit.", meta: { hasCameraFeature: ["hasLuxCheck"], hasSensorProperty: ["lightSettings"], modelKey: [ "camera", "sensor" ] }, name: "AmbientLightSensor" },
    { default: false, description: "Make this a standalone device in HomeKit that will need to be added to HomeKit through the Home app.", name: "Standalone" },
    { default: true, description: "Attempt to restart misbehaving devices. This is always done very conservatively and only after periods of extended device-specific issues.", meta: { modelKey: ["camera"] }, name: "SelfHealing" },
    { default: false, defaultValue: "", description: "Custom HomeKit name for this device and its parts. It always applies, so a rename in the Home app yields to it wherever HomeKit allows.", inputSize: 30, name: "Name", scopes: ["device"] },
    { default: false, description: "Synchronize the UniFi Protect name of this device and its parts with HomeKit. A rename in the Home app yields to it wherever HomeKit allows. A custom Name takes precedence.", name: "SyncName" }
  ],

  // Doorbell options.
  "Doorbell": [

    { default: false, description: "Add a contact sensor that gets activates when a fingerprint or NFC successfully authenticates on a Protect doorbell.", meta: { hasFeature: ["hasFingerprintSensor"] }, name: "AuthSensor" },
    { default: false, description: "Add a switch accessory to control whether HomeKit will chime when the doorbell is pressed.", name: "Mute" },
    { default: false, description: "Enable the doorbell messages feature.", meta: { hasFeature: ["isDoorbell"] }, name: "Messages" },
    { default: true, description: "Use messages saved to the Protect NVR as message switches.", group: "Messages", meta: { hasFeature: ["isDoorbell"] }, name: "Messages.FromDoorbell" },
    { default: false, description: "Add a dimmer accessory to control the Protect chime volume in HomeKit.", meta: { hasFeature: ["isDoorbell"] }, name: "Volume.Dimmer" },
    { default: false, description: "Add switch accessories to control the physical chimes attached to a Protect doorbell.", meta: { hasFeature: ["hasChime"] }, name: "PhysicalChime" },
    { default: true, defaultValue: PROTECT_DOORBELL_CHIME_DURATION_DIGITAL, description: "Chime duration, in milliseconds, of a digital physical chime attached to a Protect doorbell.", group: "PhysicalChime", meta: { hasFeature: ["hasChime"] }, name: "PhysicalChime.Duration.Digital" },
    { default: true, description: "Add a light accessory to control the flashlight on a Protect doorbell package camera.", meta: { hasFeature: ["hasPackageCamera"] }, name: "PackageCamera.Flashlight" },
    { default: false, description: "Add a switch accessory to trigger doorbell ring events on a Protect camera or doorbell.", name: "Trigger" },
    { default: false, defaultValue: PROTECT_DOORBELL_RING_DELAY, description: "Delay, in seconds, before a new doorbell ring event can be triggered, suppressing rapid duplicate rings.", meta: { hasFeature: ["isDoorbell"] }, name: "Ring.Delay" }
  ],

  // Fob options.
  "Fob": [

    { choices: FOB_BUTTON_CHOICES, default: true, defaultValue: ALL_CHOICES, description: "Make the selected fob buttons available in HomeKit. Every button is available by default; select specific buttons to expose only those.", meta: { modelKey: ["fob"] }, multiple: true, name: "Buttons" }
  ],

  // Logging options.
  "Log": [

    { default: true, description: "Log doorbell ring events in Homebridge.", meta: { modelKey: ["camera"] }, name: "Doorbell" },
    { default: false, description: "Log HomeKit Secure Video recording events in Homebridge.", meta: { hasCameraFeature: ["hasMotionDetection"], modelKey: ["camera"] }, name: "HKSV" },
    { default: false, description: "Log motion events in Homebridge.", meta: { hasCameraFeature: ["hasMotionDetection"], hasProperty: [ "isMotionDetected", "isPirMotionDetected" ] }, name: "Motion" },
    { default: false, description: "Log verbose FFmpeg output in Homebridge. Expect a significant amount of additional logging whenever FFmpeg is active.", meta: { modelKey: ["camera"] }, name: "FFmpeg" }
  ],

  // Motion options.
  "Motion": [

    { default: true, defaultValue: PROTECT_MOTION_DURATION, description: "Duration, in seconds, of a single motion event, before allowing a new one.", name: "Duration" },
    { choices: "smartDetectTypes", default: false, defaultValue: "face,person", description: "Add an occupancy sensor accessory using motion sensor activity to determine occupancy. By default, any motion will trigger occupancy. When the smart detection feature option is enabled, the detection types selected here drive occupancy instead, defaulting to face and person detection. Selecting none of them means no smart detection triggers occupancy at all.", meta: { choiceDomain: smartDetectDomain, choiceLabels: SMART_DETECT_LABELS, hasProperty: [ "isMotionDetected", "isPirMotionDetected" ] }, multiple: true, name: "OccupancySensor" },
    { default: true, defaultValue: PROTECT_OCCUPANCY_DURATION, description: "Duration, in seconds, to wait without receiving a motion event to determine when occupancy is no longer detected.", group: "OccupancySensor", name: "OccupancySensor.Duration" },
    { default: false, description: "Use UniFi Protect smart detection for HomeKit motion events when on a supported device.", meta: { hasFeature: ["hasSmartDetect"] }, name: "SmartDetect" },
    { choices: "smartDetectTypes", default: false, defaultValue: ALL_CHOICES, description: "Add contact sensors for the smart detection object types this camera reports. Every type it detects is included by default; select specific types to add sensors for only those.", group: "SmartDetect", meta: { choiceDomain: smartDetectDomain, choiceLabels: SMART_DETECT_LABELS, hasFeature: ["hasSmartDetect"] }, multiple: true, name: "SmartDetect.ObjectSensors" },
    { default: false, defaultValue: "", description: "Add a contact sensor accessory for each license plate you want UniFi Protect to match. Enter the plates one at a time; they are stored as a comma-separated list (e.g. PLATE1,PLATE2,PLATE3).", group: "SmartDetect", inputSize: 20, meta: { hasSmartObjectType: ["licensePlate"] }, multiple: true, name: "SmartDetect.ObjectSensors.LicensePlate" },
    { default: false, description: "Add a switch accessory to activate or deactivate motion detection in HomeKit.", meta: { hasProperty: [ "isMotionDetected", "isPirMotionDetected" ] }, name: "Switch" },
    { default: false, description: "Add a switch accessory to manually trigger a motion detection event in HomeKit.", meta: { hasProperty: [ "isMotionDetected", "isPirMotionDetected" ] }, name: "Trigger" }
  ],

  // MQTT options, generated alongside the category above by the shared generator. The cast is the option-side half of the category's: the generated entries carry no
  // meta of their own.
  [mqtt.category.name]: mqtt.options as FeatureOptionEntry<ProtectOptionMeta>[],

  // NVR options.
  "Nvr": [

    { default: false, defaultValue: PROTECT_M3U_PLAYLIST_PORT, description: "Publish an M3U playlist of Protect cameras on the specified port of this Homebridge server that is suitable for use in apps (e.g. Channels DVR) that can make camera livestreams available through them.", meta: { modelKey: ["nvr"] }, name: "Service.Playlist" },
    { default: true, defaultValue: PROTECT_DEVICE_REMOVAL_DELAY_INTERVAL, description: "Delay, in seconds, before removing devices that are no longer detected on the Protect controller. Removal is held off until the controller has been healthy for ten minutes, and this delay then applies.", meta: { modelKey: ["nvr"] }, name: "DelayDeviceRemoval" },
    { default: false, description: "Publish all the realtime telemetry received from the Protect controller to MQTT.", meta: { modelKey: ["nvr"] }, name: "Publish.Telemetry" },
    { default: false, defaultValue: PROTECT_NVR_REBOOT_INTERVAL, description: "Proactively reboot the UniFi Protect controller on a scheduled interval, in hours. Active HomeKit Secure Video recording events will be allowed to complete before rebooting. Use with care.", meta: { modelKey: ["nvr"] }, name: "Reboot" },
    { default: false, description: "Add switch accessories to control the native recording capabilities of the UniFi Protect NVR.", meta: { modelKey: ["camera"] }, name: "Recording.Switch" },
    { default: false, description: "Add sensor accessories to display the Protect controller system information (currently only the temperature).", meta: { modelKey: ["nvr"] }, name: "SystemInfo" },
    { default: false, defaultValue: "", description: "Override the address used when livestreaming from cameras attached to this controller. This option is intended for unusual network topologies and is unavailable for stacked controller configurations.", inputSize: 30, meta: { modelKey: ["nvr"] }, name: "OverrideAddress", scopes: ["controller"] }
  ],

  // Relay options.
  "Relay": [

    { choices: "relayOutputs", default: true, defaultValue: ALL_CHOICES, description: "Make the selected relay outputs available in HomeKit as switches. Every output the relay reports is available by default; select specific outputs to expose only those.", meta: { choiceDomain: [ "1", "2" ], modelKey: ["relay"] }, multiple: true, name: "Outputs" }
  ],

  // Security system options.
  "SecuritySystem": [

    { default: false, description: "Add a switch accessory to trigger the security system accessory, when using the liveview feature option.", name: "Alarm" }
  ],

  // Sensor options.
  "Sensor": [

    { default: false, description: "Add a contact sensor that opens when the sensor detects vaping.", name: "Vape" },
    { default: false, description: "Expose the Protect leak sensor as a contact sensor instead of a leak sensor. This is useful for automation scenarios since HomeKit contact sensors offer more flexible automation options than leak sensors, which are primarily designed for alerts.", name: "MoistureSensor" }
  ],

  // UniFi Access options.
  "UniFi.Access": [

    { default: true, description: "Add a lock accessory to unlock. Currently, Protect only supports unlocking Access readers with a camera on the same controller as Protect.", meta: { hasAccessFeature: ["supportUnlock"] }, name: "Lock" }
  ],

  // Video options.
  "Video": [

    { default: false, defaultValue: "", description: "Path to the FFmpeg executable HBUP uses for streaming and recording. Default: the bundled FFmpeg build for your platform, or the first FFmpeg found in your path.", inputSize: 40, name: "FFmpeg.Path", scopes: ["global"] },
    { default: true, description: "Use hardware-accelerated transcoding when available (Apple Macs, Intel Quick Sync Video-enabled CPUs, Raspberry Pi 4).", name: "Transcode.Hardware" },
    { default: true, description: "When streaming to low-latency clients (e.g. at home), transcode livestreams, instead of transmuxing them.", name: "Transcode" },
    { default: true, defaultValue: PROTECT_TRANSCODE_BITRATE, description: "Bitrate, in kilobits per second, to use when transcoding to low-latency (e.g. at home) clients, ignoring the bitrate HomeKit requests. HomeKit typically requests lower video quality than you may desire in your environment.", group: "Transcode", name: "Transcode.Bitrate" },
    { default: true, description: "When streaming to high-latency clients (e.g. cellular connections), transcode livestreams instead of transmuxing them.", name: "Transcode.HighLatency" },
    { default: true, defaultValue: PROTECT_TRANSCODE_HIGH_LATENCY_BITRATE, description: "Bitrate, in kilobits per second, to use when transcoding to high-latency (e.g. cellular) clients, ignoring the bitrate HomeKit requests. HomeKit typically requests lower video quality than you may desire in your environment.", group: "Transcode.HighLatency", name: "Transcode.HighLatency.Bitrate" },
    { choices: streamQualityChoices, default: false, defaultValue: "Medium", description: "When livestreaming directly from the camera over RTSP, force the use of a single video stream quality from the Protect controller. Choose exactly one of High, Medium, or Low. When this option is disabled, Protect negotiates the best available stream.", name: "Rtsp.Only" },
    { default: false, description: "Crop the camera video stream. Enabling this option will also force transcoding of livestreams.", name: "Crop" },
    { default: true, defaultValue: 0, description: "Left offset of the crop window, as a percentage of the original image width.", group: "Crop", name: "Crop.X" },
    { default: true, defaultValue: 0, description: "Top offset of the crop window, as a percentage of the original image height.", group: "Crop", name: "Crop.Y" },
    { default: true, defaultValue: 100, description: "Width of the crop window, as a percentage of original image width.", group: "Crop", name: "Crop.Width" },
    { default: true, defaultValue: 100, description: "Height of the crop window, as a percentage of original image height.", group: "Crop", name: "Crop.Height" },
    { default: true, description: "Enable higher quality snapshots.", name: "HighResSnapshots" }
  ],

  // HomeKit Secure Video options.
  "Video.HKSV": [

    { default: false, description: "Use the camera status indicator light to show when an HKSV event is being recorded.", name: "StatusLedIndicator" },
    { default: false, description: "Add a switch accessory to enable or disable HKSV event recording.", name: "Recording.Switch" }
  ],

  // Timeshift buffer options.
  "Video.Timeshift": [

    { default: true, description: "Maintain a rolling timeshift buffer of the camera's livestream to power live viewing, HomeKit Secure Video, and snapshots. Disabling this streams live views directly from the camera over RTSP whenever an RTSP-enabled stream is available.", name: "Livestream" },
    { choices: streamQualityChoices, default: false, defaultValue: "High", description: "Populate the timeshift buffer that feeds HomeKit Secure Video, buffer-backed live views, and snapshots from a single video stream quality on the Protect controller. Choose exactly one of High, Medium, or Low. When this option is disabled, Protect negotiates the best available stream.", name: "Only" }
  ]
};
/* eslint-enable @stylistic/max-len */

/* Documentation presentation. The maps and scope hooks below are build-time-only doc copy, colocated with the catalog they describe so all option-related
 * knowledge lives in one module. homebridge-plugin-utils' `prepare-docs` CLI optionally imports `describeOptionScope` / `describeCategoryScope` from this module and
 * threads them into the shared documentation renderer, which owns all base-shaped scaffolding (index, headings, anchors, the key cell, the default cell, the column
 * math) and delegates only the plugin-private scope prose to these hooks. They read the typed `meta` channel directly.
 */

// Human-readable expansion of each device model key, used by both hooks. The unknown-key fallback in each hook surfaces a raw key verbatim rather than swallowing it.
const modelMap: Record<string, string> = {

  "all": "all Protect device types",
  "camera": "Protect cameras",
  "fob": "Protect fobs",
  "light": "Protect lights",
  "nvr": "Protect controllers",
  "relay": "Protect relays",
  "sensor": "Protect sensors"
};

// Human-readable expansion of each capability flag an option can be gated on, surfaced in the per-option "Supported on" line.
const capabilityMap: Record<string, string> = {

  "hasChime": "Protect doorbells that have a physical chime",
  "hasFingerprintSensor": "Protect doorbells that have a fingerprint sensor",
  "hasLedIr": "Protect cameras that have infrared LEDs",
  "hasLedStatus": "Protect devices with a status LED",
  "hasLuxCheck": "Protect cameras that have an ambient light sensor",
  "hasMic": "Protect cameras that have a microphone",
  "hasMotionDetection": "Protect cameras that have a motion sensor",
  "hasMotionZones": "Protect cameras that have a motion sensor",
  "hasPackageCamera": "Protect doorbells that have a package camera",
  "hasSmartDetect": "Protect devices that support smart motion detection (e.g. G4-series cameras and better)",
  "hasSpeaker": "Protect devices that have a speaker (e.g. Protect doorbells)",
  "isDoorbell": "Protect devices that have a doorbell",
  "isMotionDetected": "Protect devices that have a motion sensor",
  "isPirMotionDetected": "Protect devices that have a motion sensor",
  "ledSettings": "Protect sensors that have a status indicator light",
  "licensePlate": "Protect devices that support license plate smart detection",
  "lightDeviceSettings": "Protect lights",
  "lightSettings": "Protect sensors that have an ambient light sensor",
  "supportUnlock": "Protect cameras paired with a UniFi Access reader that supports remote unlock"
};

// The capability keys an option can be gated on, in the ranks the option hook reads them. The property gate, which applies to every device model, reads ahead of
// the per-family gates, so an option scoped across device models that also gates cameras on a camera feature names its cross-model scope rather than the narrower
// camera phrase. The per-family gates share one rank because each gates a different device family, so an option carrying several of them names every family it
// applies to.
type ProtectScopeKey = "hasAccessFeature" | "hasCameraFeature" | "hasFeature" | "hasLightProperty" | "hasProperty" | "hasSensorProperty" | "hasSmartObjectType";

const scopeRanks: readonly (readonly ProtectScopeKey[])[] = [

  ["hasFeature"],
  ["hasProperty"],
  [ "hasCameraFeature", "hasLightProperty", "hasSensorProperty" ],
  ["hasSmartObjectType"],
  ["hasAccessFeature"]
];

// Module-scope list formatter for the scope sentence each hook builds. It handles "X", "X and Y", and "X, Y, and Z" uniformly.
const lf = new Intl.ListFormat("en", { style: "long", type: "conjunction" });

/**
 * Documentation hook: returns the device-scope sentence emitted under a category heading, naming the device models the category applies to, or `undefined` when the
 * category declares no model scope.
 *
 * @param category - The category entry whose `meta.modelKey` scope to describe.
 *
 * @returns The full "These option(s) apply to: ..." sentence, or `undefined` to omit the line.
 */
export const describeCategoryScope = (category: FeatureCategoryEntry<ProtectCategoryMeta>): string | undefined => {

  const models = category.meta?.modelKey;

  if(!models) {

    return undefined;
  }

  return "These option(s) apply to: " + lf.format(models.map(key => modelMap[key] ?? key)) + ".";
};

/**
 * Documentation hook: returns the "Supported on ..." suffix appended to an option's description cell, naming every capability or every device model the option is
 * gated on, or `undefined` when the option declares no scope. The first capability rank the option carries describes it, with the device models as the catch-all when
 * it carries none. Each list is read whole, so an option gated on several flags or scoped to several models names every one of them, and flags sharing one phrase name
 * it once. We use graceful map fallback (`?? flag` / `?? model`) so an unmapped key surfaces verbatim rather than the literal "undefined".
 *
 * @param option - The option entry whose `meta` scope to describe.
 *
 * @returns The full " <BR>*Supported on ...*" suffix, or `undefined` to omit it.
 */
export const describeOptionScope = (option: FeatureOptionEntry<ProtectOptionMeta>): string | undefined => {

  const meta: ProtectOptionMeta = option.meta ?? {};
  const capabilities = scopeRanks.map(rank => [...new Set(rank.flatMap(key => (meta[key] ?? []).map(flag => capabilityMap[flag] ?? flag)))]).find(prose => prose.length);
  const named = capabilities ?? [...new Set((meta.modelKey ?? []).map(model => modelMap[model] ?? model))];

  return named.length ? (" <BR>*Supported on " + lf.format(named) + ".*") : undefined;
};
