/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-config.test.ts: The webUI's two-tier legacy-settings migration, exercised against the REAL feature-option engine and the REAL served catalog, so the pins
 * bind to the same grammar the plugin's runtime resolves against rather than to a stand-in that could drift from either.
 *
 * Two deletion shapes run through every claim here, and they are asserted differently on purpose. A TOP-LEVEL legacy property leaves as a PRESENT patch key whose
 * value is undefined, because the session's shallow-merge commit deletes exactly that shape while it skips an omitted key entirely; presence is therefore read with
 * Object.hasOwn and never with a comparison against undefined. A CONTROLLERS[] ITEM key leaves the other way about, by omission from the successor the migration
 * rebuilds, so what gets asserted there is its absence.
 *
 * Post-migration state resolves through the engine's own instruments rather than by matching entry strings, so a pin binds to the option grammar instead of to one
 * spelling of it. The closing round trip goes further and drives the plugin's actual resolution expressions - the debug gate, the ring-suppression window, the FFmpeg
 * logging gates, the FFmpeg path, the RTSP host override, and the MQTT pair - before and after the patch applies, which is what proves a migrated configuration runs
 * on the same effective values the legacy one did.
 */
import { FeatureOptions, mqttConnectionSettings } from "homebridge-plugin-utils";
import { PROTECT_DOORBELL_RING_DELAY, PROTECT_MQTT_TOPIC } from "./settings.ts";
import type { ProtectConfig, ProtectConfigPatch, ProtectControllerConfig } from "../homebridge-ui/public/protect-config.mjs";
import { controllersAwaitingMigration, hasValidCredentials, makeProtectConfig, withControllerRemoved, withControllerSaved }
  from "../homebridge-ui/public/protect-config.mjs";
import { describe, test } from "node:test";
import { featureOptionCategories, featureOptions } from "./options.ts";
import assert from "node:assert/strict";

// The controller these pins migrate, a sibling that proves one controller's entries never answer for another, and a camera beneath the first for the scope corner.
const CONTROLLER_MAC = "AABBCCDDEEFF";
const OTHER_MAC = "112233445566";
const CAMERA_MAC = "0123456789AB";

// The connection triple a configured controller converges to, and the address the configuration records - which is all a configuration has, since only a controller
// that answers a probe can supply the MAC address its settings are keyed by.
const ADDRESS = "10.0.0.1";
const CREDENTIALS = { address: ADDRESS, password: "correct horse battery", username: "protect@example.com" };

// The legacy values these pins carry, each deliberately different from its option's registered default.
const LEGACY_BROKER = "mqtt://127.0.0.1:1883";
const LEGACY_OVERRIDE = "protect.example.com";
const LEGACY_TOPIC = "home/protect";
const LEGACY_VIDEO_PROCESSOR = "/usr/local/bin/ffmpeg";

// The MAC address the wiring resolves for our controller when it answers, and the empty map standing for a pass where nothing did.
const RESOLVED = new Map([[ ADDRESS, CONTROLLER_MAC ]]);
const UNRESOLVED = new Map<string, string>();

// The migration under test, built exactly the way the webUI builds it: the real engine class and the real served catalog.
const protectConfig = makeProtectConfig({ FeatureOptions, catalog: { categories: featureOptionCategories, options: featureOptions } });

/* The configuration shapes these pins build. The module's own declaration types every legacy property as unknown, which is the honest shape of a hand-editable
 * config.json...narrowing the two fields the pins read back keeps the assertions free of casts without weakening anything the migration is handed.
 */
type TestConfig = ProtectConfig & { controllers?: ProtectControllerConfig[]; options?: string[] };

// A feature-option engine over the real catalog and the supplied entries, which is how every post-migration assertion here resolves an option.
function engineWith(options: string[] = []): FeatureOptions {

  return new FeatureOptions(featureOptionCategories, featureOptions, options);
}

// One configured entry, composed through the engine's own setOption rather than hand-typed, so a pin that starts from an existing entry starts from the canonical form
// the engine itself would have written.
function composedEntry(args: { enabled: boolean; id?: string; option: string; value?: string }): string {

  const engine = engineWith();

  engine.setOption(args);

  const [entry] = engine.configuredOptions;

  assert.ok(entry, "setting an option on a fresh engine should compose exactly one entry");

  return entry;
}

// The session's shallow-merge commit, in the one line these pins need of it: a patch key present with the value undefined lands as a present-and-undefined key, which
// is what makes it a deletion, and the controllers array replaces wholesale.
function applyPatch(config: TestConfig, patch: ProtectConfigPatch): TestConfig {

  return { ...config, ...patch };
}

// The entries in an options array that address a given option, case-insensitively, in either the enabled or the disabled form.
function entriesFor(options: string[] | undefined, option: string): string[] {

  const prefix = option.toLowerCase();

  return (options ?? []).filter((entry) => [ "disable." + prefix, "enable." + prefix ].some((form) => entry.toLowerCase().startsWith(form)));
}

// The patch a configuration migrates to, asserted to exist so each pin below reads a patch rather than a nullable one.
function migrated(config: TestConfig, macByAddress: ReadonlyMap<string, string> = UNRESOLVED): ProtectConfigPatch {

  const patch = protectConfig.migrate(config, macByAddress);

  assert.ok(patch, "the configuration should have produced a migration patch");

  return patch;
}

describe("protect webUI legacy-settings migration, top-level tier", () => {

  test("each top-level legacy property composes its option and leaves for deletion", () => {

    const patch = migrated({ debug: true, ringDelay: 20, verboseFfmpeg: true, videoProcessor: LEGACY_VIDEO_PROCESSOR });
    const engine = engineWith(patch.options);

    for(const property of [ "debug", "ringDelay", "verboseFfmpeg", "videoProcessor" ]) {

      assert.ok(Object.hasOwn(patch, property), property + " should ride the patch as a present key, which is what makes the commit delete it");
    }

    assert.equal(engine.test("Log.Debug"), true, "the debug flag lands as a global enable");
    assert.equal(engine.test("Log.FFmpeg"), true, "the verbose FFmpeg flag lands as a global enable");
    assert.equal(engine.getInteger("Doorbell.Ring.Delay"), 20, "the ring delay lands as a global value the engine parses back as a number");
    assert.equal(engine.value("Video.FFmpeg.Path"), LEGACY_VIDEO_PROCESSOR, "the FFmpeg path lands as a global value");
  });

  test("an inert or uninterpretable top-level value deletes without composing", () => {

    for(const [ property, value ] of [ [ "debug", false ], [ "debug", "yes" ], [ "ringDelay", 0 ], [ "ringDelay", "20" ],
      [ "videoProcessor", "" ] ] as [ string, unknown ][]) {

      const patch = migrated({ [property]: value });

      assert.ok(Object.hasOwn(patch, property), property + " should still be deleted, whatever value it was carrying");
      assert.ok(!Object.hasOwn(patch, "options"), property + " carrying an inert or uninterpretable value composes nothing, so no options array rides the patch");
    }
  });

  test("a configured global entry outranks the legacy property, which still leaves", () => {

    const configured = [ "Disable.Log.FFmpeg", "Enable.Video.FFmpeg.Path=/opt/ffmpeg" ];
    const config: TestConfig = { options: [...configured], verboseFfmpeg: true, videoProcessor: LEGACY_VIDEO_PROCESSOR };
    const patch = migrated(config);

    assert.ok(Object.hasOwn(patch, "verboseFfmpeg"), "the superseded property rides the patch for deletion");
    assert.ok(Object.hasOwn(patch, "videoProcessor"), "the superseded property rides the patch for deletion");
    assert.ok(!Object.hasOwn(patch, "options"), "an existing entry is the user's own choice, so nothing composes over it and no array rides");
    assert.deepEqual(applyPatch(config, patch).options, configured, "the entries the user configured survive byte-identical, an explicit disable among them");
  });

  test("a ring delay equal to the registered pre-fill still composes", () => {

    const patch = migrated({ ringDelay: PROTECT_DOORBELL_RING_DELAY });

    assert.equal(engineWith(patch.options).getInteger("Doorbell.Ring.Delay"), PROTECT_DOORBELL_RING_DELAY,
      "Doorbell.Ring.Delay is off by default, so an unconfigured option resolves to nothing at all and a delay that equals the webUI's pre-fill is an active choice");
  });

  test("a narrower-scoped entry neither stops the global compose nor is disturbed by it", () => {

    const scoped = composedEntry({ enabled: false, id: CAMERA_MAC, option: "Log.FFmpeg" });
    const patch = migrated({ options: [scoped], verboseFfmpeg: true });
    const engine = engineWith(patch.options);

    /* Perfect effective-value parity is unachievable by construction for a user carrying BOTH the legacy flag and a narrower-scoped entry: the legacy property
     * overrides even an explicit narrow disable today, while a global entry is always outranked by a narrower one. Composing anyway is the ruled answer, because
     * skipping it would delete the legacy key with no successor at all and change behavior at EVERY scope, which is strictly worse.
     */
    assert.ok(patch.options?.includes(scoped), "the device-scoped entry the user configured survives byte-identical");
    assert.equal(engine.test("Log.FFmpeg", CAMERA_MAC, CONTROLLER_MAC), false, "their explicit disable takes effect at its own device once the migration lands");
    assert.equal(engine.test("Log.FFmpeg"), true, "and the global entry the flag composed preserves the behavior at every scope that has no entry of its own");
  });

  test("the debug flag composes a bare global entry for an option the served catalog never declares", () => {

    const patch = migrated({ debug: true });

    assert.ok(!(featureOptions["Log"] ?? []).some((entry) => entry.name === "Debug"), "the served catalog declares no Log.Debug option, deliberately");
    assert.deepEqual(entriesFor(patch.options, "Log.Debug"), ["Enable.Log.Debug"], "an option the catalog does not know is not value-centric, so a bare enable composes");
    assert.equal(engineWith(patch.options).test("Log.Debug", CAMERA_MAC, CONTROLLER_MAC), true, "and that entry is what the plugin's own debug gate resolves through");
  });
});

describe("protect webUI legacy-settings migration, per-controller tier", () => {

  test("a reachable controller's settings land at controller scope while its item slims to the connection triple", () => {

    const controller = { ...CREDENTIALS, doorbellMessages: [{ message: "Away" }], mqttTopic: LEGACY_TOPIC, mqttUrl: LEGACY_BROKER, name: "Front Gate",
      overrideAddress: LEGACY_OVERRIDE, region: "us-east" };
    const patch = migrated({ controllers: [controller] }, RESOLVED);
    const engine = engineWith(patch.options);
    const item = patch.controllers?.[0] ?? {};

    assert.deepEqual(item, CREDENTIALS, "the successor is exactly the connection triple");

    for(const key of [ "doorbellMessages", "mqttTopic", "mqttUrl", "name", "overrideAddress", "region" ]) {

      assert.ok(!Object.hasOwn(item, key), key + " leaves the item by omission from the rebuilt successor, whether it was migrated, retired, or unknown");
    }

    assert.equal(engine.value("Mqtt.Url", undefined, CONTROLLER_MAC), LEGACY_BROKER, "the broker resolves at the controller's own scope");
    assert.equal(engine.value("Mqtt.Topic", undefined, CONTROLLER_MAC), LEGACY_TOPIC, "the topic resolves at the controller's own scope");
    assert.equal(engine.value("Nvr.OverrideAddress", undefined, CONTROLLER_MAC), LEGACY_OVERRIDE, "the override address resolves at the controller's own scope");
  });

  test("a topic equal to the registered default composes nothing, while the broker beside it composes", () => {

    const patch = migrated({ controllers: [{ ...CREDENTIALS, mqttTopic: PROTECT_MQTT_TOPIC, mqttUrl: LEGACY_BROKER }] }, RESOLVED);
    const engine = engineWith(patch.options);

    assert.equal(engine.scope("Mqtt.Topic", undefined, CONTROLLER_MAC), "none",
      "Mqtt.Topic is on by default and already answers this exact value unconfigured, so restating it would manufacture configuration out of nothing");
    assert.equal(engine.value("Mqtt.Url", undefined, CONTROLLER_MAC), LEGACY_BROKER, "the broker is off by default, so its value is an active choice and composes");
    assert.ok(!Object.hasOwn(patch.controllers?.[0] ?? {}, "mqttTopic"), "the property leaves the item either way, composed or not");
  });

  test("an entry already answering a controller's read outranks the property, and a sibling's entry never answers for it", () => {

    const own = composedEntry({ enabled: true, id: CONTROLLER_MAC, option: "Mqtt.Url", value: "mqtt://configured:1883" });
    const sibling = composedEntry({ enabled: true, id: OTHER_MAC, option: "Nvr.OverrideAddress", value: "sibling.example.com" });
    const patch = migrated({ controllers: [{ ...CREDENTIALS, mqttUrl: LEGACY_BROKER, overrideAddress: LEGACY_OVERRIDE }], options: [ own, sibling ] }, RESOLVED);
    const engine = engineWith(patch.options);

    assert.equal(engine.value("Mqtt.Url", undefined, CONTROLLER_MAC), "mqtt://configured:1883", "the entry that already answers this controller's read stands");
    assert.equal(engine.value("Nvr.OverrideAddress", undefined, CONTROLLER_MAC), LEGACY_OVERRIDE,
      "a sibling controller's entry answers only for that sibling, so this controller's legacy override still composes");
    assert.equal(engine.value("Nvr.OverrideAddress", undefined, OTHER_MAC), "sibling.example.com", "and the sibling's own entry comes through untouched");
    assert.deepEqual(patch.controllers?.[0], CREDENTIALS, "the item slims either way: a property whose option was already configured still leaves");
  });

  test("an unreachable controller keeps its per-controller settings while its retired keys still leave", () => {

    const config: TestConfig = { controllers: [{ ...CREDENTIALS, doorbellMessages: [], mqttTopic: LEGACY_TOPIC, mqttUrl: LEGACY_BROKER, name: "Front Gate",
      overrideAddress: LEGACY_OVERRIDE }] };
    const patch = migrated(config, UNRESOLVED);
    const item = patch.controllers?.[0] ?? {};

    assert.deepEqual(item, { ...CREDENTIALS, mqttTopic: LEGACY_TOPIC, mqttUrl: LEGACY_BROKER, overrideAddress: LEGACY_OVERRIDE },
      "the per-controller keys carry forward unchanged, because there is no MAC address for them to land against");
    assert.ok(!Object.hasOwn(item, "doorbellMessages"), "a retired key needs no identity, so it leaves on this path too");
    assert.ok(!Object.hasOwn(item, "name"), "a retired key needs no identity, so it leaves on this path too");
    assert.ok(!Object.hasOwn(patch, "options"), "nothing composed, because nothing could be addressed");
    assert.deepEqual(controllersAwaitingMigration(applyPatch(config, patch)), [CREDENTIALS], "the item is still named as awaiting migration, so a later open retries");
  });
});

describe("protect webUI controller writers, saving", () => {

  test("an edit replaces the credential triple on the item its original address names", () => {

    const patch = withControllerSaved({ controllers: [{ ...CREDENTIALS }] },
      { address: ADDRESS, originalAddress: ADDRESS, password: "new secret", username: "new@example.com" });

    assert.deepEqual(patch.controllers, [{ address: ADDRESS, password: "new secret", username: "new@example.com" }],
      "the triple lands on the item that was already there");
  });

  test("an address change edits that item rather than adding a second one beside it", () => {

    const patch = withControllerSaved({ controllers: [{ ...CREDENTIALS }] },
      { address: "10.0.0.9", originalAddress: ADDRESS, password: CREDENTIALS.password, username: CREDENTIALS.username });

    assert.equal(patch.controllers.length, 1, "the address the write started from is what finds the item, so a changed address replaces rather than duplicates");
    assert.deepEqual(patch.controllers[0], { ...CREDENTIALS, address: "10.0.0.9" }, "and the item now carries the new address");
  });

  test("an edit carries every other key the item holds", () => {

    const item = { ...CREDENTIALS, mqttTopic: LEGACY_TOPIC, mqttUrl: LEGACY_BROKER, overrideAddress: LEGACY_OVERRIDE };
    const patch = withControllerSaved({ controllers: [item] },
      { address: ADDRESS, originalAddress: ADDRESS, password: "new secret", username: CREDENTIALS.username });

    assert.deepEqual(patch.controllers[0], { ...item, password: "new secret" },
      "an un-migrated controller still owns per-controller settings the plugin runs on, and only the migration retires those");
  });

  test("an add appends, and an original address that names no configured item appends too", () => {

    const added = { address: "10.0.0.9", password: "another secret", username: "another@example.com" };
    const appended = withControllerSaved({ controllers: [{ ...CREDENTIALS }] }, added);

    assert.deepEqual(appended.controllers, [ CREDENTIALS, added ], "an absent original address is what makes a write an add");
    assert.deepEqual(withControllerSaved({ controllers: [{ ...CREDENTIALS }] }, { ...added, originalAddress: "10.0.0.250" }).controllers, [ CREDENTIALS, added ],
      "and an original address matching no item falls back to the same append rather than writing nothing");
  });

  test("every other configured controller carries through byte-identical", () => {

    const other = { address: "10.0.0.2", mqttUrl: LEGACY_BROKER, password: "sibling secret", username: "sibling@example.com" };
    const patch = withControllerSaved({ controllers: [ { ...CREDENTIALS }, other ] },
      { address: ADDRESS, originalAddress: ADDRESS, password: "new secret", username: CREDENTIALS.username });

    assert.equal(patch.controllers[1], other, "an item the write does not name is carried across by reference, so nothing about it can be reshaped in passing");
  });
});

describe("protect webUI controller writers, removal and the orphan sweep", () => {

  test("removal drops the item its address names, and an empty MAC set leaves the configured options untouched", () => {

    const other = { address: "10.0.0.2", password: "sibling secret", username: "sibling@example.com" };
    const patch = withControllerRemoved({ controllers: [ { ...CREDENTIALS }, other ], options: ["Enable.Log.FFmpeg." + CONTROLLER_MAC] }, { address: ADDRESS });

    assert.deepEqual(patch.controllers, [other], "the item the address names is gone and every other item stands");
    assert.ok(!Object.hasOwn(patch, "options"),
      "with no MAC set there is no sweep, and carrying no options array at all is what leaves every configured entry exactly where it was");
  });

  test("the sweep strips every spelling the engine's own parser resolves to a swept MAC", () => {

    /* Each form below is first proven to address a MAC scope through the engine itself, so these pins bind to the parser's grammar rather than to a reading of it:
     * the bare enable and the bare disable, the canonical entry whose value rides behind the payload delimiter, and the legacy dot spelling the parser still
     * accepts from configurations hand-authored before that delimiter existed.
     */
    const bareDisable = "Disable.Log.FFmpeg." + CAMERA_MAC;
    const bareEnable = "Enable.Log.FFmpeg." + CONTROLLER_MAC;
    const legacyPayload = "Enable.Nvr.OverrideAddress." + CONTROLLER_MAC + "." + LEGACY_OVERRIDE;
    const lowerCased = "enable.mqtt.topic." + CONTROLLER_MAC.toLowerCase() + "=" + LEGACY_TOPIC;
    const valuePayload = "Enable.Mqtt.Url." + CONTROLLER_MAC + "=" + LEGACY_BROKER;

    assert.equal(engineWith([bareEnable]).test("Log.FFmpeg", undefined, CONTROLLER_MAC), true, "the bare enable addresses the controller's own scope");
    assert.equal(engineWith([bareDisable]).test("Log.FFmpeg", CAMERA_MAC, CONTROLLER_MAC), false, "the bare disable addresses the device's own scope");
    assert.equal(engineWith([valuePayload]).value("Mqtt.Url", undefined, CONTROLLER_MAC), LEGACY_BROKER, "the canonical payload form addresses the controller");
    assert.equal(engineWith([legacyPayload]).value("Nvr.OverrideAddress", undefined, CONTROLLER_MAC), LEGACY_OVERRIDE, "and so does the legacy dot spelling");
    assert.equal(engineWith([lowerCased]).value("Mqtt.Topic", undefined, CONTROLLER_MAC), LEGACY_TOPIC, "an entry's casing says nothing about the scope it names");

    const options = [ bareDisable, bareEnable, legacyPayload, lowerCased, valuePayload ];
    const patch = withControllerRemoved({ controllers: [{ ...CREDENTIALS }], options }, { address: ADDRESS, macs: [ CONTROLLER_MAC, CAMERA_MAC ] });

    assert.deepEqual(patch.options, [], "every spelling that resolves to a swept MAC leaves with the controller it belonged to");
    assert.deepEqual(withControllerRemoved({ controllers: [{ ...CREDENTIALS }], options }, { address: ADDRESS,
      macs: [ CONTROLLER_MAC.toLowerCase(), CAMERA_MAC.toLowerCase() ] }).options, [], "and the match is case-insensitive from either side");
  });

  test("an entry that does not address a swept scope survives the sweep", () => {

    // A scope is named by a whole segment of an entry's address. A MAC that is merely part of a longer segment, or that sits in the value behind the payload
    // delimiter, is text the entry carries rather than a scope it addresses, and a sibling controller's own entries are none of this removal's business.
    const survivors = [

      "Enable.Log.Debug",
      "Enable.Log.FFmpeg." + OTHER_MAC,
      "Enable.Log.FFmpeg." + CONTROLLER_MAC + "00",
      "Enable.Mqtt.Url=mqtt://" + CONTROLLER_MAC + ":1883",
      "Enable.Mqtt.Topic." + OTHER_MAC + "=protect/" + CAMERA_MAC
    ];

    const patch = withControllerRemoved({ controllers: [{ ...CREDENTIALS }], options: [...survivors] },
      { address: ADDRESS, macs: [ CONTROLLER_MAC, CAMERA_MAC ] });

    assert.deepEqual(patch.options, survivors, "a global entry, a sibling's entry, and a MAC that names no scope all come through the sweep untouched");
  });

  test("removing the last controller leaves a configuration the first-run gate reads as unconfigured", () => {

    const patch = withControllerRemoved({ controllers: [{ ...CREDENTIALS }] }, { address: ADDRESS });

    assert.deepEqual(patch.controllers, [], "the only controller is gone");
    assert.equal(hasValidCredentials({ controllers: patch.controllers }), false,
      "which needs no special casing at all: the next open simply runs first run, exactly as it does for a configuration nobody has filled in yet");
  });
});

describe("protect webUI legacy-settings migration, whole-pass behavior", () => {

  test("both tiers compose through one engine and ride one options array", () => {

    const patch = migrated({ controllers: [{ ...CREDENTIALS, mqttUrl: LEGACY_BROKER }], debug: true, videoProcessor: LEGACY_VIDEO_PROCESSOR }, RESOLVED);
    const engine = engineWith(patch.options);

    assert.equal(engine.test("Log.Debug"), true, "the top-level flag is in the array");
    assert.equal(engine.value("Video.FFmpeg.Path"), LEGACY_VIDEO_PROCESSOR, "so is the top-level value");
    assert.equal(engine.value("Mqtt.Url", undefined, CONTROLLER_MAC), LEGACY_BROKER,
      "and so is the controller-scoped entry: two writers would each answer a whole array and the commit would keep only the last of them");
  });

  test("a migrated configuration converges, and one that never carried a legacy setting has nothing to do", () => {

    const config: TestConfig = { controllers: [{ ...CREDENTIALS, mqttUrl: LEGACY_BROKER, name: "Front Gate" }], debug: true, ringDelay: 20 };
    const converged = applyPatch(config, migrated(config, RESOLVED));

    assert.equal(protectConfig.migrate(converged, RESOLVED), null, "a second pass over the migrated configuration finds nothing left to do");
    assert.deepEqual(controllersAwaitingMigration(converged), [], "and nothing is left for the wiring to probe");
    assert.equal(protectConfig.migrate({ controllers: [CREDENTIALS] }), null,
      "a configuration that never carried a legacy setting answers null, and needs no resolved MAC address to say so");
  });

  test("a substrate we cannot parse declines the whole pass, while an absent one does not", () => {

    assert.equal(protectConfig.migrate(undefined), null, "an absent configuration has nothing to migrate");
    assert.equal(protectConfig.migrate({ debug: true, options: "nonsense" }), null, "an options field that is present but is not an array declines the pass");
    assert.equal(protectConfig.migrate({ controllers: "nonsense", debug: true }), null, "a controllers field that is present but is not an array declines it too");
    assert.deepEqual(controllersAwaitingMigration({ controllers: "nonsense" }), [], "and the probe list answers empty rather than throwing on the same substrate");

    const patch = migrated({ debug: true });

    assert.ok(Object.hasOwn(patch, "debug"), "a configuration with no controllers key at all is a valid absence, and still migrates its top-level properties");
    assert.ok(!Object.hasOwn(patch, "controllers"), "and stages no controllers array, because there were none to rewrite");
  });

  test("every migrated setting resolves to the same effective value the legacy configuration ran on", () => {

    const config: TestConfig = { controllers: [{ ...CREDENTIALS, mqttTopic: LEGACY_TOPIC, mqttUrl: LEGACY_BROKER, overrideAddress: LEGACY_OVERRIDE }],
      debug: true, options: [], ringDelay: 20, verboseFfmpeg: true, videoProcessor: LEGACY_VIDEO_PROCESSOR };

    /* The plugin's own resolution expressions, driven here exactly as their call sites drive them: the debug gate in the platform, the ring-suppression window in the
     * event dispatcher, the FFmpeg logging gate in the streaming delegate, the FFmpeg path the platform resolves at construction, the camera's RTSP host override,
     * and the controller's MQTT pair through the shared resolver. Each reads option-first with the legacy property behind it, which is what makes the before and the
     * after comparable at all.
     */
    const resolve = (state: TestConfig): Record<string, unknown> => {

      const engine = engineWith(state.options);
      const controller = (state.controllers?.[0] ?? {}) as { mqttTopic?: string; mqttUrl?: string; overrideAddress?: string };
      const ffmpegExec = engine.value("Video.FFmpeg.Path");
      const override = engine.value("Nvr.OverrideAddress", undefined, CONTROLLER_MAC);

      return {

        mqtt: mqttConnectionSettings({ config: controller, controller: CONTROLLER_MAC, featureOptions: engine }),
        ringDelay: engine.getInteger("Doorbell.Ring.Delay", CAMERA_MAC, CONTROLLER_MAC) ?? state.ringDelay ?? 0,
        rtspHost: (override?.length ? override : undefined) ?? controller.overrideAddress,
        testDebug: (state.debug === true) || engine.test("Log.Debug", CAMERA_MAC, CONTROLLER_MAC),
        verboseFfmpeg: engine.test("Log.FFmpeg", CAMERA_MAC, CONTROLLER_MAC) || (state.verboseFfmpeg === true),
        videoProcessor: (ffmpegExec?.length ? ffmpegExec : undefined) ?? state.videoProcessor
      };
    };

    const before = resolve(config);

    assert.deepEqual(resolve(applyPatch(config, migrated(config, RESOLVED))), before,
      "every setting the migration moved resolves to the value the plugin was running on before it moved");
    assert.deepEqual(before, { mqtt: { brokerUrl: LEGACY_BROKER, topicPrefix: LEGACY_TOPIC }, ringDelay: 20, rtspHost: LEGACY_OVERRIDE, testDebug: true,
      verboseFfmpeg: true, videoProcessor: LEGACY_VIDEO_PROCESSOR }, "and the values being compared are the legacy configuration's own, not two matching blanks");
  });
});
