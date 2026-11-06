/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * options.test.ts: Coverage of the catalog surface - the standing-buffer options, the direct-RTSP channel pin, the absence of the superseded streaming and HKSV-record
 * option names, the landing of every feature option that supersedes a configuration property, the device-scoped custom name, the motion surface's scoping on the
 * camera's motion report, and the scope prose the option reference publishes.
 *
 * The catalog is plain data (featureOptionCategories plus the featureOptions map), so these are pure structure assertions. The end-to-end resolution of the new names
 * through the engine is proven where it steers behavior (the doorbell-construction pixel-ceiling test resolves a real timeshift channel pin, and the ring-delay and
 * override-address assertions drive their own resolution); this suite guards the catalog shape itself, including the map-key hazard that would silently drop a
 * category.
 *
 * One entry is guarded by its ABSENCE. Log.Debug is deliberately undeclared: it resolves at every scope through the engine's unrestricted walk for an option the
 * catalog does not know, the same mechanism the undocumented Debug.* namespace rides, and declaring it would surface it in the webUI and the generated documentation.
 */
import { PROTECT_DOORBELL_RING_DELAY, PROTECT_MQTT_TOPIC } from "./settings.ts";
import { SMART_DETECT_TYPES, describeOptionScope, featureOptionCategories, featureOptions, smartDetectLabel } from "./options.ts";
import { describe, test } from "node:test";
import { ALL_CHOICES } from "homebridge-plugin-utils";
import type { FeatureOptionEntry } from "homebridge-plugin-utils";
import type { ProtectOptionMeta } from "./options.ts";
import assert from "node:assert/strict";

// The option names defined under a category's options-map key, or an empty list when the key is absent.
function optionNames(category: string): string[] {

  return (featureOptions[category] ?? []).map((option) => option.name);
}

// One option's catalog entry, looked up the way the engine does - by its category key and its own name. The entry type carries the plugin's own annotation shape, so a
// pin can read the metadata an entry rides on rather than reaching for a cast at each assertion.
function optionEntry(category: string, name: string): FeatureOptionEntry<ProtectOptionMeta> | undefined {

  return featureOptions[category]?.find((option) => option.name === name);
}

// Every option the catalog declares, expanded to the lowercased "Category.Option" key the resolution engine matches on. An option with an empty name IS its category's
// own toggle, which is the expansion rule this mirrors.
function catalogKeys(): string[] {

  return Object.entries(featureOptions).flatMap(([ category, entries ]) => {

    return entries.map((entry) => (entry.name.length ? category + "." + entry.name : category).toLowerCase());
  });
}

describe("feature-option retirement wave", () => {

  // The category entry (its webUI section and category-level meta gate) AND its options-map key must both exist - buildCatalogIndex silently skips a category with no
  // matching map key, so a present category entry alone would drop every option under it.
  test("the Video.Timeshift category is registered with both its catalog entry and its options-map key", () => {

    assert.ok(featureOptionCategories.some((category) => category.name === "Video.Timeshift"), "the Video.Timeshift category entry is present");
    assert.ok("Video.Timeshift" in featureOptions, "the Video.Timeshift options-map key is present, so the catalog does not silently drop the category");
  });

  // The livestream API serves every adopted camera, so the timeshift buffer's options apply to every camera: the category scopes to cameras and gates on nothing else.
  test("the Video.Timeshift category scopes to every camera and gates on nothing else", () => {

    const category = featureOptionCategories.find((entry) => entry.name === "Video.Timeshift");

    assert.ok(category, "the category exists");
    assert.deepEqual(category.meta, { modelKey: ["camera"] }, "the category scopes to cameras and carries no other gate");
  });

  // The standing-buffer options: the default-on livestreaming toggle plus the single channel pin the user picks a quality on.
  test("the standing-buffer options are defined with their defaults", () => {

    assert.deepEqual(optionNames("Video.Timeshift"), [ "Livestream", "Only" ], "the timeshift options are the livestream toggle and the channel pin");
    assert.equal(optionEntry("Video.Timeshift", "Livestream")?.default, true, "buffer-backed livestreaming defaults on");
  });

  /* Both channel pins are single-select pickers over the same three tiers. The choices are asserted at FULL depth - every label and every value, in order - because a
   * count-only assertion passes against a mistyped or reordered list, and these values are the exact text a stored configuration carries and the retired translation
   * emits. Asserting both entries at the same depth is what keeps the two pickers from drifting apart, since they derive from one table.
   *
   * The registered defaults differ by pin, and the difference is the whole point: the timeshift buffer feeds HomeKit Secure Video, snapshots, and buffer-backed live
   * views, so it presets High, while a direct-RTSP live view is the transport a constrained network reaches for and presets Medium. Each is the tier that applies
   * the moment the option is turned on with nothing chosen.
   */
  test("the channel pins are single-select tier pickers that preset a tier on enable", () => {

    for(const [ category, name, preset ] of [ [ "Video", "Rtsp.Only", "Medium" ], [ "Video.Timeshift", "Only", "High" ] ] as const) {

      const entry = optionEntry(category, name);

      assert.ok(entry, "the " + category + " channel pin exists");
      assert.deepEqual(entry.choices, [ { label: "High", value: "High" }, { label: "Medium", value: "Medium" }, { label: "Low", value: "Low" } ],
        "the " + category + " pin offers the three tiers, labels and values alike");
      assert.equal(entry.multiple, undefined, "a pin holds one tier, so it is not a list");
      assert.equal(entry.defaultValue, preset, "the " + category + " pin presets " + preset + " for an enable that names no tier");
      assert.equal(entry.default, false, "no pin applies until the user turns the option on");
    }
  });

  // The Video category's direct-RTSP pin is present, and the superseded Stream.UseApi toggle and Stream.Only.* pins are absent from the category.
  test("the direct-RTSP pin replaced the streaming options in the Video category", () => {

    const video = optionNames("Video");

    assert.ok(video.includes("Rtsp.Only"), "the direct-RTSP quality pin is present");
    assert.ok(!video.includes("Stream.UseApi"), "the retired Stream.UseApi toggle is gone");
    assert.ok(!video.some((name) => name.startsWith("Stream.Only")), "the retired streaming pins are gone");
  });

  // The catalog declares no per-quality boolean, so a configuration still naming one addresses nothing the engine knows - which is exactly why the translation layer
  // has to intercept those entries before the engine ever sees them.
  test("the per-quality channel pins are retired from both categories", () => {

    const video = optionNames("Video");
    const timeshift = optionNames("Video.Timeshift");

    assert.ok([ "Rtsp.Only.High", "Rtsp.Only.Medium", "Rtsp.Only.Low" ].every((name) => !video.includes(name)), "the retired direct-RTSP quality pins are gone");
    assert.ok([ "Only.High", "Only.Medium", "Only.Low" ].every((name) => !timeshift.includes(name)), "the retired timeshift quality pins are gone");
  });

  // The Video.HKSV category's record pins are absent, and its other options remain unaffected.
  test("the HKSV record pins are retired while its other options survive", () => {

    const hksv = optionNames("Video.HKSV");

    assert.ok(!hksv.some((name) => name.startsWith("Record.Only")), "the retired HKSV record pins are gone");
    assert.ok([ "StatusLedIndicator", "Recording.Switch" ].every((name) => hksv.includes(name)), "the surviving HKSV options are untouched");
  });

  /* The occupancy master is the selection itself: a multiple option over a source the settings page resolves from the camera in view, defaulting to the two detection
   * types the retired per-type options defaulted on. The default is spelled in the shared list grammar and in WIRE values, because that is the text the runtime reads
   * back and matches against what the controller delivers.
   */
  test("the occupancy master is a source-backed multiple selection defaulting to face and person", () => {

    const entry = optionEntry("Motion", "OccupancySensor");

    assert.ok(entry, "the occupancy option exists");
    assert.equal(entry.choices, "smartDetectTypes", "its choices come from the camera's own reported detection types");
    assert.equal(entry.multiple, true, "occupancy is driven by a list of types, not by one of them");
    assert.equal(entry.defaultValue, "face,person", "the default is the pair the retired per-type options defaulted on");
    assert.equal(entry.default, false, "no occupancy sensor exists until the user asks for one");
    assert.deepEqual(entry.meta?.choiceDomain, SMART_DETECT_TYPES.map((type) => type.value),
      "the entry carries the known-type domain the settings page offers where no camera is in view");
    assert.deepEqual(entry.meta.choiceLabels, Object.fromEntries(SMART_DETECT_TYPES.map((type) => [ type.value, type.label ])),
      "the entry carries the display names the picker renders each detection type as");
  });

  // The catalog declares no per-type occupancy boolean, while the duration sibling that shares their name prefix stands: it was never one of them, and an entry
  // addressing it has to keep resolving to it.
  test("the per-type occupancy options are retired while the duration sibling survives", () => {

    const motion = optionNames("Motion");

    assert.ok(SMART_DETECT_TYPES.every((type) => !motion.includes("OccupancySensor." + type.name)), "no per-type occupancy option remains");
    assert.ok(motion.includes("OccupancySensor.Duration"), "the occupancy duration option is untouched");
    assert.equal(motion.filter((name) => name.startsWith("OccupancySensor")).length, 2, "the master and its duration sibling are all that carry the name");
  });

  /* The object-sensor option is a selection over the same detection source, defaulting to the all-choices wildcard rather than to a list - a camera's detection types
   * are not knowable from the catalog, so a default naming them all is the only way to say "every type this camera reports" up front. It reads through the constant
   * rather than the bare character so the catalog and the engine's expansion cannot disagree about which spelling means everything.
   */
  test("the object sensors are a source-backed multiple selection defaulting to every reported type", () => {

    const entry = optionEntry("Motion", "SmartDetect.ObjectSensors");

    assert.ok(entry, "the object-sensor option exists");
    assert.equal(entry.choices, "smartDetectTypes", "its choices come from the camera's own reported detection types");
    assert.equal(entry.multiple, true, "a camera can carry a sensor for each type it detects");
    assert.equal(entry.defaultValue, ALL_CHOICES, "enabling it without choosing types covers every type the camera reports");
    assert.equal(entry.group, "SmartDetect", "it stays grouped under smart detection");
    assert.deepEqual(entry.meta?.choiceDomain, SMART_DETECT_TYPES.map((type) => type.value),
      "the entry carries the known-type domain the settings page offers where no camera is in view");
    assert.deepEqual(entry.meta.choiceLabels, Object.fromEntries(SMART_DETECT_TYPES.map((type) => [ type.value, type.label ])),
      "the entry carries the display names the picker renders each detection type as");
  });

  /* The fob's buttons are one inline-choice selection over a fixed table, so its choices are asserted at FULL depth - every label and every value, in order. The labels
   * carry the controller's position number in parentheses only where it says something the name does not: the numbered buttons read "Arm (1)" through "Panic (4)", and
   * Right and Left carry none, because their position label IS their name. The values are the wire ids a press arrives under, which is what makes the selection and the
   * router address one identity.
   */
  test("the fob buttons are one inline-choice selection over the button table", () => {

    const entry = optionEntry("Fob", "Buttons");

    assert.ok(entry, "the fob buttons option exists");
    assert.deepEqual(entry.choices, [

      { label: "Arm (1)", value: "arm" },
      { label: "Night (2)", value: "night" },
      { label: "Disarm (3)", value: "disarm" },
      { label: "Panic (4)", value: "panic" },
      { label: "Right", value: "right" },
      { label: "Left", value: "left" }
    ], "the six buttons are offered with their position labels only where those differ from their names");

    assert.equal(entry.multiple, true, "a fob exposes a list of buttons");
    assert.equal(entry.defaultValue, ALL_CHOICES, "every button is available until the user narrows the list");
    assert.equal(entry.default, true, "the buttons are exposed by default");
    assert.deepEqual(entry.meta?.modelKey, ["fob"], "the option applies to fobs alone");
  });

  // The catalog declares no per-button boolean, so a configuration still naming one addresses nothing the engine knows.
  test("the per-button fob options are retired", () => {

    const fob = optionNames("Fob");

    assert.deepEqual(fob, ["Buttons"], "the buttons selection is the whole of the fob category");
    assert.ok(!fob.some((name) => name.startsWith("Button.")), "no per-button option remains");
  });

  /* The relay outputs draw their choices from the relay in view rather than from a fixed list, which is what lets a relay of any size offer every output it reports.
   * The option's name deliberately does NOT extend the retired per-output names: a name shaped as their prefix would let a retired entry register as this option's own
   * value and quietly narrow the selection to whatever that entry named.
   */
  test("the relay outputs are a source-backed multiple selection over the relay's own outputs", () => {

    const entry = optionEntry("Relay", "Outputs");

    assert.ok(entry, "the relay outputs option exists");
    assert.equal(entry.choices, "relayOutputs", "its choices come from the relay's own reported outputs");
    assert.equal(entry.multiple, true, "a relay exposes a list of outputs");
    assert.equal(entry.defaultValue, ALL_CHOICES, "every output the relay reports is exposed until the user narrows the list");
    assert.equal(entry.default, true, "the outputs are exposed by default");
    assert.deepEqual(entry.meta?.choiceDomain, [ "1", "2" ], "the entry carries the pair the settings page offers where no relay is in view");
    assert.deepEqual(entry.meta.modelKey, ["relay"], "the option applies to relays alone");
  });

  // The catalog declares no per-output boolean, and the surviving name is not a prefix of the retired ones - which is what keeps a retired entry from reading as this
  // option's value.
  test("the per-output relay options are retired under a name that is not their prefix", () => {

    const relay = optionNames("Relay");

    assert.deepEqual(relay, ["Outputs"], "the outputs selection is the whole of the relay category");
    assert.ok(!relay.some((name) => name.startsWith("Output.")), "no per-output option remains");
  });

  /* The plate list is a free-form list rather than a picker: the plates a user wants matched cannot be enumerated from anything the plugin knows, so the option
   * declares no choices at all and the editor builds the list entry by entry. Declaring it a list is what puts it on the shared grammar the camera's read parses.
   */
  test("the license plate option is a free-form list with no choices", () => {

    const entry = optionEntry("Motion", "SmartDetect.ObjectSensors.LicensePlate");

    assert.ok(entry, "the license plate option exists");
    assert.equal(entry.multiple, true, "the plates are stored as a list");
    assert.equal(entry.choices, undefined, "there is nothing to pick from - the user supplies the plates");
    assert.equal(entry.defaultValue, "", "no plate is matched until the user names one");
    assert.equal(entry.group, "SmartDetect", "it stays grouped under smart detection");
  });
});

/* The label column of the detection-type table, which is the one place a type's display name is written and what every user-facing surface renders: the settings
 * page's picker copy, the HomeKit contact sensor names, and the log narration. The wire values stay the protocol identity, so every row here pins a value-to-name
 * pairing rather than a rename of the value itself.
 */
describe("smart detection display names", () => {

  // The humanizing rule the label reader falls back to, restated here rather than reached for in the module. A test that calls the implementation agrees with any
  // drift in it; a test that states the rule fails the moment the implementation stops following it.
  function humanized(value: string): string {

    return value.replace(/_/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(" ").filter((word) => word.length)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
  }

  // Every row of the pairing, in the table's own order, because a count-only or spot-check assertion passes against a mistyped, dropped, or reordered name and these
  // are the exact strings a user reads in the picker, on an accessory, and in the log.
  test("every detection type reads as the display name the table names for it", () => {

    assert.deepEqual(SMART_DETECT_TYPES.map((type) => [ type.value, smartDetectLabel(type.value) ]), [

      [ "animal", "Animal" ],
      [ "face", "Face" ],
      [ "licensePlate", "License Plate" ],
      [ "package", "Package" ],
      [ "person", "Person" ],
      [ "vehicle", "Vehicle" ],
      [ "alrmBabyCry", "Baby Crying" ],
      [ "alrmBark", "Barking" ],
      [ "alrmBurglar", "Burglar" ],
      [ "alrmCarHorn", "Car Horn" ],
      [ "alrmCmonx", "CO Alarm" ],
      [ "alrmGlassBreak", "Glass Breakage" ],
      [ "alrmSiren", "Siren" ],
      [ "alrmSmoke", "Smoke Alarm" ],
      [ "alrmSpeak", "Speaking" ],
      [ "smoke_cmonx", "Smoke/CO Alarm" ]
    ], "each wire value renders the name the pickers, the sensor names, and the logs all show");
  });

  // A type the table does not name is one a newer controller firmware has begun reporting. It reads through the humanizing rule rather than surfacing a wire
  // spelling, and both of that rule's splits are exercised: the camelCase joins and the underscores.
  test("a detection type the table does not name humanizes its wire spelling", () => {

    assert.equal(smartDetectLabel("futureAlarmThing"), "Future Alarm Thing", "a camelCase value reads as separate, capitalized words");
    assert.equal(smartDetectLabel("future_alarm_thing"), "Future Alarm Thing", "an underscore-joined value splits the same way");
    assert.equal(smartDetectLabel("futureAlarmThing"), humanized("futureAlarmThing"), "the fallback is the humanizing rule itself");
  });

  /* The curated column earns its place on the audio alarm family alone - the types Protect spells for its own protocol convenience. Every clean object type's label
   * is exactly what the humanizing rule produces from its value, "License Plate" among them, which is why that rule has to split camelCase joins rather than
   * capitalize at whitespace alone. Both directions are asserted, so a curated name added to a clean type or dropped from an alarm type fails here.
   */
  test("the clean object types read as their humanized values and the alarm family is the curated scope", () => {

    assert.deepEqual(SMART_DETECT_TYPES.filter((type) => type.label === humanized(type.value)).map((type) => type.value),
      [ "animal", "face", "licensePlate", "package", "person", "vehicle" ], "the clean object types need no curated name, License Plate included");
    assert.deepEqual(SMART_DETECT_TYPES.filter((type) => type.label !== humanized(type.value)).map((type) => type.value),
      [ "alrmBabyCry", "alrmBark", "alrmBurglar", "alrmCarHorn", "alrmCmonx", "alrmGlassBreak", "alrmSiren", "alrmSmoke", "alrmSpeak", "smoke_cmonx" ],
      "the alarm family is exactly the set the curated column renames");
  });
});

describe("the settings-consolidation option surface", () => {

  // The MQTT group is composed from the shared generator rather than hand-written, so both halves must land: the category entry AND its options-map key, since
  // buildCatalogIndex silently skips a category whose map key is missing and every option under it would resolve to nothing.
  test("the Mqtt category is registered with both its catalog entry and its options-map key", () => {

    assert.ok(featureOptionCategories.some((category) => category.name === "Mqtt"), "the Mqtt category entry is present");
    assert.ok("Mqtt" in featureOptions, "the Mqtt options-map key is present, so the catalog does not silently drop the category");
    assert.deepEqual(optionNames("Mqtt"), [ "Url", "Topic" ], "the generated group contributes the broker URL and the topic prefix");
  });

  /* The two generated MQTT entries carry deliberately opposite defaults, and the consolidated reads depend on it. Mqtt.Url defaults OFF so an unconfigured broker
   * resolves to null - the unambiguous "MQTT is off" the controller branches on. Mqtt.Topic defaults ON so an unconfigured topic resolves to the plugin's canonical
   * prefix, which is why the controller's topic read has to ask whether the option was configured at all before letting it outrank a legacy topic.
   */
  test("the Mqtt options carry their opposite defaults and resolve at controller scope", () => {

    const url = optionEntry("Mqtt", "Url");
    const topic = optionEntry("Mqtt", "Topic");

    assert.ok(url, "the broker URL option exists");
    assert.equal(url.default, false, "an unconfigured broker URL resolves to null rather than a value");
    assert.deepEqual(url.scopes, ["controller"], "each controller reaches its own broker");

    assert.ok(topic, "the topic prefix option exists");
    assert.equal(topic.default, true, "an unconfigured topic resolves to the registered default");
    assert.equal(topic.defaultValue, PROTECT_MQTT_TOPIC, "the registered default is the plugin's canonical topic prefix");
    assert.deepEqual(topic.scopes, ["controller"], "each controller publishes under its own prefix");
  });

  // The ring-suppression window lands as a per-device value option defaulting OFF, so a configuration that never enables it keeps delivering every ring as it arrives.
  // It declares no scopes, so it resolves at device, controller, and global alike - which is what lets one doorbell carry a delay its siblings do not.
  test("Doorbell.Ring.Delay lands as a default-off per-device value option", () => {

    const entry = optionEntry("Doorbell", "Ring.Delay");

    assert.ok(entry, "the ring delay option exists");
    assert.equal(entry.default, false, "no suppression window applies until the user asks for one");
    assert.equal(entry.defaultValue, PROTECT_DOORBELL_RING_DELAY, "enabling it pre-fills the suggested window");
    assert.equal(entry.scopes, undefined, "declaring no scopes leaves it resolvable at every level");
  });

  // Verbose FFmpeg logging lands as a per-camera flag, so one camera's streaming sessions can be traced without flooding the log with every other camera's.
  test("Log.FFmpeg lands as a default-off per-camera flag", () => {

    const entry = optionEntry("Log", "FFmpeg");

    assert.ok(entry, "the verbose FFmpeg logging option exists");
    assert.equal(entry.default, false, "verbose FFmpeg output stays off until asked for");
    assert.equal(entry.defaultValue, undefined, "it is a flag, not a value option");
  });

  // The livestream address override is a per-controller fact, so it declares controller scope alone: the engine skips a configured entry at any level the option does
  // not declare, which is what keeps a controller's override from being written where it could never apply.
  test("Nvr.OverrideAddress lands as a controller-scoped value option", () => {

    const entry = optionEntry("Nvr", "OverrideAddress");

    assert.ok(entry, "the address override option exists");
    assert.equal(entry.default, false, "no override applies until the user configures one");
    assert.equal(entry.defaultValue, "", "the pre-filled value is empty, so enabling it alone changes nothing");
    assert.deepEqual(entry.scopes, ["controller"], "an override belongs to one controller");
  });

  // The FFmpeg executable is one host-wide fact - the plugin launches one binary regardless of which camera it is serving - so this option declares global scope alone.
  test("Video.FFmpeg.Path lands as a globally-scoped value option", () => {

    const entry = optionEntry("Video", "FFmpeg.Path");

    assert.ok(entry, "the FFmpeg path option exists");
    assert.equal(entry.default, false, "the bundled build is used until the user names a path");
    assert.equal(entry.defaultValue, "", "the pre-filled value is empty, so enabling it alone changes nothing");
    assert.deepEqual(entry.scopes, ["global"], "one host runs one FFmpeg");
  });

  // Log.Debug is undeclared by design and must stay that way: the engine walks every scope for an option it does not know, which is exactly the per-device, per-
  // controller, and global resolution the debug router wants, while declaring it would publish it to the webUI and the generated documentation.
  test("Log.Debug appears nowhere in the catalog", () => {

    assert.ok(!catalogKeys().includes("log.debug"), "the debug option stays undeclared, resolving through the engine's unrestricted walk");
    assert.ok(!featureOptionCategories.some((category) => category.name.toLowerCase() === "log.debug"), "and it is not a category either");
  });
});

describe("the custom device name", () => {

  // A custom HomeKit name belongs to one device, so it declares device scope alone: the engine skips a configured entry at any level the option does not declare,
  // which is what keeps a controller-wide or global value from naming every device the same.
  test("Device.Name lands as a device-scoped value option", () => {

    const entry = optionEntry("Device", "Name");

    assert.ok(entry, "the custom name option exists");
    assert.equal(entry.default, false, "no custom name applies until the user sets one");
    assert.equal(entry.defaultValue, "", "the pre-filled value is empty, so enabling it alone names nothing");
    assert.deepEqual(entry.scopes, ["device"], "a custom name belongs to one device");
  });
});

describe("the settings page scoping of the motion surface", () => {

  /* HomeKit Secure Video and the motion surface follow whether Protect exposes a motion sensor for a camera, so the settings page scopes them on the camera's own
   * report through the existing grammar: a category gates on the camera's feature flag per model, and an option gates on it as a camera feature. Each entry's meta is
   * held whole, so a gate a later edit adds or drops shows here rather than in the webUI alone.
   */
  test("the Motion and HKSV categories and the HKSV and Motion log options gate on the camera's motion report", () => {

    const category = (name: string): unknown => featureOptionCategories.find((entry) => entry.name === name)?.meta;

    assert.deepEqual(category("Motion"), { featureByModel: { camera: ["hasMotionDetection"], sensor: ["motion"] }, modelKey: [ "camera", "light", "sensor" ] },
      "the Motion category shows for a camera Protect exposes a motion sensor for, and for lights and motion sensors");
    assert.deepEqual(category("Video.HKSV"), { featureByModel: { camera: ["hasMotionDetection"] }, modelKey: ["camera"] },
      "the HKSV category shows for a camera Protect exposes a motion sensor for");
    assert.deepEqual(optionEntry("Log", "HKSV")?.meta, { hasCameraFeature: ["hasMotionDetection"], modelKey: ["camera"] },
      "the HKSV log option shows for a camera Protect exposes a motion sensor for");
    assert.deepEqual(optionEntry("Log", "Motion")?.meta, { hasCameraFeature: ["hasMotionDetection"], hasProperty: [ "isMotionDetected", "isPirMotionDetected" ] },
      "the motion log option keeps its cross-model property gate and gates cameras on the motion report");
  });

  // The generated documentation's scope prose for the gated log options: the motion log keeps its cross-model phrase, since the property gate reads ahead of the
  // camera gate, and the HKSV log names the cameras it applies to through the motion report's own phrase.
  test("the scope prose names the motion report's phrase for the HKSV log and keeps the cross-model phrase for the motion log", () => {

    const motion = optionEntry("Log", "Motion");
    const hksv = optionEntry("Log", "HKSV");

    assert.ok(motion && hksv, "the motion and HKSV log options exist");
    assert.equal(describeOptionScope(motion), " <BR>*Supported on Protect devices that have a motion sensor.*", "the motion log keeps its cross-model scope");
    assert.equal(describeOptionScope(hksv), " <BR>*Supported on Protect cameras that have a motion sensor.*", "the HKSV log renders the motion report's phrase");
  });
});

describe("the option reference's scope prose", () => {

  // An option gated per device family names each family through that family's own gate, so the published reference lists every kind of device the option reaches
  // rather than whichever gate its entry happens to list first.
  test("an option gated on more than one device family names every family's gate", () => {

    const ambient = optionEntry("Device", "AmbientLightSensor");
    const statusLed = optionEntry("Device", "StatusLed.Switch");

    assert.ok(ambient && statusLed, "the ambient light sensor and status light switch options exist");
    assert.equal(describeOptionScope(ambient),
      " <BR>*Supported on Protect cameras that have an ambient light sensor and Protect sensors that have an ambient light sensor.*",
      "the ambient light sensor names its camera gate and its sensor gate");
    assert.equal(describeOptionScope(statusLed),
      " <BR>*Supported on Protect devices with a status LED, Protect lights, and Protect sensors that have a status indicator light.*",
      "the status light switch names its camera, light, and sensor gates");
  });

  // The motion properties share one phrase, so an option gated on more than one of them reads the phrase once rather than joining it to itself.
  test("flags that share one phrase name it once", () => {

    const motionSwitch = optionEntry("Motion", "Switch");

    assert.ok(motionSwitch, "the motion switch option exists");
    assert.deepEqual(motionSwitch.meta?.hasProperty, [ "isMotionDetected", "isPirMotionDetected" ], "the motion switch gates on each motion property");
    assert.equal(describeOptionScope(motionSwitch), " <BR>*Supported on Protect devices that have a motion sensor.*", "the shared phrase is named once");
  });

  // The device models are the catch-all behind the capability gates, and they too are read whole.
  test("an option scoped to several models and gated on no capability names every model", () => {

    const entry: FeatureOptionEntry<ProtectOptionMeta> = { default: false, description: "A scoped option.", meta: { modelKey: [ "camera", "light" ] }, name: "Scoped" };

    assert.equal(describeOptionScope(entry), " <BR>*Supported on Protect cameras and Protect lights.*", "every model is named");
    assert.equal(describeOptionScope({ default: false, description: "An unscoped option.", name: "Unscoped" }), undefined, "an option with no scope has no suffix");
  });
});
