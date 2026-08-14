/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * options.test.ts: Coverage of the catalog surface - the standing-buffer options, the direct-RTSP pins, the absence of the superseded streaming and HKSV-record option
 * names, and the landing of every setting that migrated from the configuration schema onto a feature option.
 *
 * The catalog is plain data (featureOptionCategories plus the featureOptions map), so these are pure structure assertions. The end-to-end resolution of the new names
 * through the engine is proven where it steers behavior (the doorbell-construction pixel-ceiling test pins a real Video.Timeshift.Only.High, and the ring-delay and
 * override-address pins drive their own resolution); this suite guards the catalog shape itself, including the map-key hazard that would silently drop a category.
 *
 * One entry is guarded by its ABSENCE. Log.Debug is deliberately undeclared: it resolves at every scope through the engine's unrestricted walk for an option the
 * catalog does not know, the same mechanism the undocumented Debug.* namespace rides, and declaring it would surface it in the webUI and the generated documentation.
 */
import { PROTECT_DOORBELL_RING_DELAY, PROTECT_MQTT_TOPIC } from "./settings.ts";
import { describe, test } from "node:test";
import { featureOptionCategories, featureOptions } from "./options.ts";
import type { FeatureOptionEntry } from "homebridge-plugin-utils";
import assert from "node:assert/strict";

// The option names defined under a category's options-map key, or an empty list when the key is absent.
function optionNames(category: string): string[] {

  return (featureOptions[category] ?? []).map((option) => option.name);
}

// One option's catalog entry, looked up the way the engine does - by its category key and its own name.
function optionEntry(category: string, name: string): FeatureOptionEntry | undefined {

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

  // The category carries exactly the Video.HKSV parity gate - hidden for third-party cameras, scoped to cameras - and deliberately no isAdoptedByAccessApp hide, since
  // Access-adopted cameras join the streaming arm and the toggle does real work for them.
  test("the Video.Timeshift category carries the third-party-camera parity gate and no Access hide", () => {

    const category = featureOptionCategories.find((entry) => entry.name === "Video.Timeshift");

    assert.ok(category, "the category exists");
    assert.deepEqual(category.meta?.isNotProperty, ["isThirdPartyCamera"], "the category hides for third-party cameras and nothing else");
    assert.deepEqual(category.meta?.modelKey, ["camera"], "the category scopes to cameras");
  });

  // The standing-buffer options: the default-on livestreaming toggle plus the source-agnostic per-quality channel pins.
  test("the standing-buffer options are defined with their defaults", () => {

    assert.deepEqual(optionNames("Video.Timeshift"), [ "Livestream", "Only.High", "Only.Medium", "Only.Low" ],
      "the timeshift options are the livestream toggle and the three channel pins");
    assert.equal(featureOptions["Video.Timeshift"]?.find((option) => option.name === "Livestream")?.default, true, "buffer-backed livestreaming defaults on");
  });

  // The Video category's direct-RTSP quality pins are present, and the superseded Stream.UseApi toggle and Stream.Only.* pins are absent from the category.
  test("the direct-RTSP pins replaced the streaming options in the Video category", () => {

    const video = optionNames("Video");

    assert.ok([ "Rtsp.Only.High", "Rtsp.Only.Medium", "Rtsp.Only.Low" ].every((name) => video.includes(name)), "the direct-RTSP quality pins are present");
    assert.ok(!video.includes("Stream.UseApi"), "the retired Stream.UseApi toggle is gone");
    assert.ok(!video.some((name) => name.startsWith("Stream.Only")), "the retired streaming pins are gone");
  });

  // The Video.HKSV category's record pins are absent, and its other options remain unaffected.
  test("the HKSV record pins are retired while its other options survive", () => {

    const hksv = optionNames("Video.HKSV");

    assert.ok(!hksv.some((name) => name.startsWith("Record.Only")), "the retired HKSV record pins are gone");
    assert.ok([ "StatusLedIndicator", "Recording.Switch" ].every((name) => hksv.includes(name)), "the surviving HKSV options are untouched");
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
