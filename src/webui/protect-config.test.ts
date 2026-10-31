/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webui/protect-config.test.ts: The webUI's two-tier legacy-settings migration, exercised against the REAL feature-option engine and the REAL served catalog, so
 * the assertions bind to the same grammar the plugin's runtime resolves against rather than to a stand-in that could drift from either.
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
 *
 * The device-row namer is read the same way: each custom name is composed into the configuration through the engine's own setOption and read back through the
 * namer at the row's serialNumber, the MAC the live page addresses a row by, over rows shaped as the UI server answers them, the name it composed beside the
 * controller's own.
 */
import type { Assert, Equal } from "homebridge-plugin-utils/testing";
import { FeatureOptions, addressListedElsewhere, addressListingForm, displayedName, mqttConnectionSettings } from "homebridge-plugin-utils";
import { PROTECT_DOORBELL_RING_DELAY, PROTECT_MQTT_TOPIC } from "../settings.ts";
import type { ProtectConfig, ProtectConfigPatch, ProtectControllerConfig } from "./protect-config.ts";
import { describe, test } from "node:test";
import { deviceListResult, makeControllerList, makeProtectConfig, readDeviceListAnswer, staleSelectionVerdict } from "./protect-config.ts";
import { featureOptionCategories, featureOptions } from "../options.ts";
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

// The controller list's interpreters, and the migration and device-row namer under test, built exactly the way the webUI builds them: over HBPU's listed-address and
// display-name rules, imported here from the package root that is compiled from the same source as the page's browser copy, the real engine class, and the real served
// catalog.
const { controllerListedElsewhere, controllers, controllersAwaitingMigration, hasValidCredentials, primaryListedElsewhere, withControllerRemoved, withControllerSaved,
  withPrimaryCredentials } = makeControllerList({ addressListedElsewhere, addressListingForm });
const protectConfig = makeProtectConfig({ FeatureOptions, catalog: { categories: featureOptionCategories, options: featureOptions }, controllers, displayedName });

/* Compile-time shape exercise for the HBPU pieces the factories are built over. It never runs - the function is never called, and its leading underscore marks it,
 * with its bindings, as a compile-time exercise the typecheck reads - so it adds nothing to the runtime totals. Each injected piece's type is its HBPU export
 * exactly, so a declaration that lets one collapse to any or loosen to a signature of its own, which every runtime row in this suite would still pass against, fails
 * `npm run typecheck` here instead.
 */
const _injectedDependencyShapeExercises = (): void => {

  type _ListedElsewhereIsTheRule = Assert<Equal<Parameters<typeof makeControllerList>[0]["addressListedElsewhere"], typeof addressListedElsewhere>>;
  type _ListingFormIsTheRule = Assert<Equal<Parameters<typeof makeControllerList>[0]["addressListingForm"], typeof addressListingForm>>;
  type _InjectedEngineIsTheClass = Assert<Equal<Parameters<typeof makeProtectConfig>[0]["FeatureOptions"], typeof FeatureOptions>>;
  type _DisplayedNameIsTheRule = Assert<Equal<Parameters<typeof makeProtectConfig>[0]["displayedName"], typeof displayedName>>;
};

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

  test("a padded controller awaiting migration is read by its address as stored, and its entries move onto the MAC address its stored address resolved", () => {

    const padded = { ...CREDENTIALS, address: " " + ADDRESS + " " };
    const config: TestConfig = { controllers: [{ ...padded, mqttUrl: LEGACY_BROKER }] };
    const awaiting = controllersAwaitingMigration(config);

    // The wiring probes each awaiting controller with the address it was handed and keys the MAC address the probe answers by that same address, which the settings
    // server trims only for its connect.
    const macByAddress = new Map(awaiting.map(({ address }): [ string, string ] => [ address as string, CONTROLLER_MAC ]));
    const patch = migrated(config, macByAddress);

    assert.deepEqual(awaiting, [padded], "the controller awaits migration by its address as stored, padding included");
    assert.equal(engineWith(patch.options).value("Mqtt.Url", undefined, CONTROLLER_MAC), LEGACY_BROKER, "its broker moves onto the controller's MAC address");
    assert.deepEqual(patch.controllers, [padded], "and its item slims to the connection triple, keeping its address as stored");
  });
});

describe("protect webUI controller writers, saving", () => {

  test("an edit replaces the credential triple on the item its original address names", () => {

    const patch = withControllerSaved({ controllers: [{ ...CREDENTIALS }] },
      { address: ADDRESS, originalAddress: ADDRESS, password: "new secret", username: "new@example.com" });

    assert.ok(patch, "an edit writing exactly the address its item stores is never refused");
    assert.deepEqual(patch.controllers, [{ address: ADDRESS, password: "new secret", username: "new@example.com" }],
      "the triple lands on the item that was already there");
  });

  test("an address change edits that item rather than adding a second one beside it", () => {

    const patch = withControllerSaved({ controllers: [{ ...CREDENTIALS }] },
      { address: "10.0.0.9", originalAddress: ADDRESS, password: CREDENTIALS.password, username: CREDENTIALS.username });

    assert.ok(patch, "an address no other controller holds is written");
    assert.equal(patch.controllers.length, 1, "the address the write started from is what finds the item, so a changed address replaces rather than duplicates");
    assert.deepEqual(patch.controllers[0], { ...CREDENTIALS, address: "10.0.0.9" }, "and the item now carries the new address");
  });

  test("an edit carries every other key the item holds", () => {

    const item = { ...CREDENTIALS, mqttTopic: LEGACY_TOPIC, mqttUrl: LEGACY_BROKER, overrideAddress: LEGACY_OVERRIDE };
    const patch = withControllerSaved({ controllers: [item] },
      { address: ADDRESS, originalAddress: ADDRESS, password: "new secret", username: CREDENTIALS.username });

    assert.ok(patch, "an edit writing exactly the address its item stores is never refused");
    assert.deepEqual(patch.controllers[0], { ...item, password: "new secret" },
      "an un-migrated controller still owns per-controller settings the plugin runs on, and only the migration retires those");
  });

  test("an add appends, and an original address that names no configured item appends too", () => {

    const added = { address: "10.0.0.9", password: "another secret", username: "another@example.com" };
    const appended = withControllerSaved({ controllers: [{ ...CREDENTIALS }] }, added);
    const unmatched = withControllerSaved({ controllers: [{ ...CREDENTIALS }] }, { ...added, originalAddress: "10.0.0.250" });

    assert.ok(appended, "an add at a free address is written");
    assert.deepEqual(appended.controllers, [ CREDENTIALS, added ], "an absent original address is what makes a write an add");
    assert.ok(unmatched, "an edit whose item left the configuration, writing a free address, is written");
    assert.deepEqual(unmatched.controllers, [ CREDENTIALS, added ], "and an original address matching no item falls back to the same append rather than writing nothing");
    assert.equal(withControllerSaved({ controllers: [{ ...CREDENTIALS }] }, { ...added, address: ADDRESS }), null,
      "while an add at the address the configured controller already holds is refused, so the append never writes a second item at one address");
  });

  test("every other configured controller carries through byte-identical", () => {

    const other = { address: "10.0.0.2", mqttUrl: LEGACY_BROKER, password: "sibling secret", username: "sibling@example.com" };
    const patch = withControllerSaved({ controllers: [ { ...CREDENTIALS }, other ] },
      { address: ADDRESS, originalAddress: ADDRESS, password: "new secret", username: CREDENTIALS.username });

    assert.ok(patch, "an edit writing exactly the address its item stores is never refused");
    assert.equal(patch.controllers[1], other, "an item the write does not name is carried across by reference, so nothing about it can be reshaped in passing");
  });
});

// The save the listed-address rule is asked about, in the shape the early check and the writer each take.
interface SaveRequest {

  address: string;
  originalAddress?: string;
  password: string;
  username: string;
}

// The login a save in these rows writes, which the rule never reads and the writer carries through.
const LOGIN = { password: CREDENTIALS.password, username: CREDENTIALS.username };

/* Assert that a save is refused, by the early check the page makes before its login check and by the writer the write composes through alike, so every row
 * below also proves the two agree.
 *
 * @param config  - The configuration the save is asked of.
 * @param save    - The save.
 * @param message - What the refusal stands for, for the assertion messages.
 */
function assertRefused(config: TestConfig, save: SaveRequest, message: string): void {

  assert.equal(controllerListedElsewhere(config, save), true, message + ", by the early check");
  assert.equal(withControllerSaved(config, save), null, message + ", by the writer");
}

/* Assert that a save is accepted by the early check and the writer alike, and answer the controllers the writer composes for it, which a row then reads.
 *
 * @param config  - The configuration the save is asked of.
 * @param save    - The save.
 * @param message - What the acceptance stands for, for the assertion messages.
 *
 * @returns The controllers array the writer composed.
 */
function accepted(config: TestConfig, save: SaveRequest, message: string): ProtectControllerConfig[] {

  assert.equal(controllerListedElsewhere(config, save), false, message + ", by the early check");

  const patch = withControllerSaved(config, save);

  assert.ok(patch, message + ", by the writer");

  return patch.controllers;
}

describe("protect webUI controller writers, the listed-address rule", () => {

  test("an add at an address another controller holds is refused, and an add at a free address appends", () => {

    const config: TestConfig = { controllers: [{ ...CREDENTIALS }] };

    assertRefused(config, { ...LOGIN, address: ADDRESS }, "an add at the address the configured controller holds is refused");
    assert.deepEqual(accepted(config, { ...LOGIN, address: "10.0.0.9" }, "an add at a free address is accepted"), [ CREDENTIALS, { ...LOGIN, address: "10.0.0.9" } ],
      "and it appends beside the controller already there");
  });

  test("an edit moving onto another controller's address is refused, and one writing its own stored address beside a repeated entry saves the first entry alone", () => {

    const second = { ...LOGIN, address: "10.0.0.2" };

    assertRefused({ controllers: [ { ...CREDENTIALS }, second ] }, { ...LOGIN, address: ADDRESS, originalAddress: "10.0.0.2" },
      "an edit moving the second controller onto the first one's address is refused");

    // A configuration that already carries more than one item at an address, which the refusal stops new saves from making. The page reads the first item there
    // alone, so an edit lands on it and the write leaves the later item out.
    const twins = [ { ...CREDENTIALS }, { ...CREDENTIALS, username: "twin@example.com" } ];

    assert.deepEqual(accepted({ controllers: twins }, { ...CREDENTIALS, originalAddress: ADDRESS, password: "new secret" },
      "an edit writing exactly the address its item stores is accepted"), [{ ...CREDENTIALS, password: "new secret" }],
    "and the saved list holds the edited first entry alone");
  });

  test("an edit changing only the letter case of its own address is accepted, and over a case-variant pair it writes the first entry alone", () => {

    const host = { ...LOGIN, address: "unifi.local" };

    assert.deepEqual(accepted({ controllers: [host] }, { ...LOGIN, address: "UNIFI.local", originalAddress: "unifi.local" },
      "a case-only edit of a controller no other controller shares an address with is accepted"), [{ ...LOGIN, address: "UNIFI.local" }],
    "and the address is stored exactly as typed");

    // A case-variant pair, which the folded comparison reads as one controller: the page reads the first entry alone, so the edit moves that entry onto the
    // spelling the later one holds and the write leaves the later one out.
    assert.deepEqual(accepted({ controllers: [ host, { ...LOGIN, address: "UNIFI.local" } ] }, { ...LOGIN, address: "UNIFI.local", originalAddress: "unifi.local" },
      "a case-only edit onto the spelling a later entry at its own address holds is accepted"), [{ ...LOGIN, address: "UNIFI.local" }],
    "and it writes the edited first entry alone");
  });

  test("an edit whose original address matches no controller is refused at a held address and appends at a free one", () => {

    const config: TestConfig = { controllers: [{ ...CREDENTIALS }] };

    assertRefused(config, { ...LOGIN, address: ADDRESS, originalAddress: "10.0.0.250" },
      "an edit whose item left the configuration, writing an address another controller holds, is refused rather than appended");
    assert.deepEqual(accepted(config, { ...LOGIN, address: "10.0.0.9", originalAddress: "10.0.0.250" }, "the same edit at a free address is accepted"),
      [ CREDENTIALS, { ...LOGIN, address: "10.0.0.9" } ], "and it appends, because an original address that names no item is an add");
  });

  test("the comparison folds every spelling of a held console, and an address naming another host or another port is accepted and stored as typed", () => {

    const config: TestConfig = { controllers: [ { ...LOGIN, address: "unifi.local" }, { ...LOGIN, address: "fe80::1" } ] };

    // Letter case, surrounding space, a trailing dot on the host, the default HTTPS port, and an IPv6 literal with or without its brackets, compressed or written
    // out, each name a held console, so each is refused.
    for(const address of [ "UNIFI.LOCAL", " unifi.local", "unifi.local\t", "  Unifi.Local  ", "unifi.local.", "unifi.local:443", "FE80::1", "[fe80::1]",
      "[FE80:0:0:0:0:0:0:1]" ]) {

      assertRefused(config, { ...LOGIN, address }, "an add at " + JSON.stringify(address) + " names a held address in another spelling");
    }

    // A port other than the default and a host differing in a character the form keeps each name another console as far as the rule can see, so each is accepted.
    for(const address of [ "unifi.local:8443", "unifi.lan", "[fe80::2]" ]) {

      assert.deepEqual(accepted(config, { ...LOGIN, address }, "an add at " + JSON.stringify(address) + " differs in what the form keeps").at(-1),
        { ...LOGIN, address }, "and it appends exactly as typed");
    }

    assert.deepEqual(accepted({ controllers: [{ ...CREDENTIALS }] }, { ...LOGIN, address: " 10.0.0.9 " }, "a padded free address is accepted").at(-1),
      { ...LOGIN, address: " 10.0.0.9 " }, "and is stored with its padding, because the fold is for comparing and never for writing");
  });

  test("the fold reads the stored side too, so a stored address carrying padding and another case still holds its form", () => {

    // The stored spelling is the padded, mixed-case one and the written spelling is plain, so a rule that folded only the written address would accept these.
    const config: TestConfig = { controllers: [{ ...LOGIN, address: "  UniFi.Local\t" }] };

    for(const address of [ "unifi.local", "UNIFI.LOCAL", " unifi.local " ]) {

      assertRefused(config, { ...LOGIN, address }, "an add at " + JSON.stringify(address) + " names the stored address once both sides are folded");
    }
  });

  test("an entry with no address, an empty one, or one that is not a string never matches, and an empty or blank written address is never listed", () => {

    const entries: ProtectControllerConfig[] = [ { ...LOGIN }, { ...LOGIN, address: "" }, { ...LOGIN, address: 42 } ];

    for(const entry of entries) {

      const label = "beside an entry whose address is " + JSON.stringify(entry.address ?? null);

      assert.deepEqual(accepted({ controllers: [entry] }, { ...LOGIN, address: "42" }, "an add of \"42\" " + label + " is accepted"),
        [ entry, { ...LOGIN, address: "42" } ], "and it appends " + label);
    }

    const unaddressed: TestConfig = { controllers: [ { ...LOGIN, address: "" }, { ...LOGIN } ] };

    for(const address of [ "", "   " ]) {

      accepted(unaddressed, { ...LOGIN, address }, "a written address of " + JSON.stringify(address) + " has no form, so it is never listed");
    }
  });

  test("first run is refused at an address a later controller holds, and accepted at the primary's own stored address, writing the primary alone beside a repeat", () => {

    const later = { ...LOGIN, address: ADDRESS, mqttUrl: LEGACY_BROKER };
    const primary = { address: "10.0.0.9", name: "Front Gate", password: "old secret", username: CREDENTIALS.username };
    const written = withPrimaryCredentials({ controllers: [ primary, { ...LOGIN, address: "10.0.0.2" } ] }, { ...LOGIN, address: "10.0.0.8" });

    assert.ok(written, "an address no other controller holds is written onto the primary");
    assert.deepEqual(written.controllers, [ { ...primary, ...LOGIN, address: "10.0.0.8" }, { ...LOGIN, address: "10.0.0.2" } ],
      "the primary keeps its other keys and every later controller stands");
    assert.equal(primaryListedElsewhere({ controllers: [ primary, { ...LOGIN, address: "10.0.0.2" } ] }, { address: "10.0.0.8" }), false,
      "and the early check agrees");

    assert.equal(withPrimaryCredentials({ controllers: [ primary, later ] }, { ...CREDENTIALS }), null, "an address a later controller holds is refused");
    assert.equal(primaryListedElsewhere({ controllers: [ primary, later ] }, { address: ADDRESS }), true, "and the early check agrees");

    // The usual first run writes the address the primary already stores, alone or beside a later entry repeating it, and neither may be refused. The page reads
    // the primary alone at its address, so the write beside a repeat holds the primary alone.
    for(const others of [ [], [later] ]) {

      const config: TestConfig = { controllers: [ { ...CREDENTIALS }, ...others ] };
      const label = others.length ? " beside a later entry repeating it" : " alone";
      const own = withPrimaryCredentials(config, { ...CREDENTIALS, password: "new secret" });

      assert.ok(own, "the primary's own stored address is accepted" + label);
      assert.deepEqual(own.controllers, [{ ...CREDENTIALS, password: "new secret" }], "and written onto the primary, which the write holds alone" + label);
      assert.equal(primaryListedElsewhere(config, { address: ADDRESS }), false, "and the early check agrees" + label);
    }

    assert.equal(primaryListedElsewhere({}, { address: ADDRESS }), false, "and a fresh configuration has nothing to refuse");
  });

  test("first run accepts a case-only change of the primary's address, and beside a later entry at its form writes the primary alone", () => {

    const primary = { ...LOGIN, address: "unifi.local" };
    const alone = withPrimaryCredentials({ controllers: [primary] }, { ...LOGIN, address: "UNIFI.LOCAL" });

    assert.ok(alone, "a case-only change of the primary's address is accepted when no later controller holds its form");
    assert.deepEqual(alone.controllers, [{ ...LOGIN, address: "UNIFI.LOCAL" }], "and stored exactly as typed");
    assert.equal(primaryListedElsewhere({ controllers: [primary] }, { address: "UNIFI.LOCAL" }), false, "and the early check agrees");

    // A later entry at the primary's form repeats the primary, which the page reads as the primary alone, so the change is accepted and the write leaves the later
    // entry out.
    const shared: TestConfig = { controllers: [ primary, { ...LOGIN, address: "Unifi.Local" } ] };
    const beside = withPrimaryCredentials(shared, { ...LOGIN, address: "UNIFI.LOCAL" });

    assert.ok(beside, "a case-only change is accepted beside a later entry at the primary's form");
    assert.deepEqual(beside.controllers, [{ ...LOGIN, address: "UNIFI.LOCAL" }], "and the write holds the primary alone, stored exactly as typed");
    assert.equal(primaryListedElsewhere(shared, { address: "UNIFI.LOCAL" }), false, "and the early check agrees");
  });
});

// The controllers values a hand edit can leave that are not a list, each beside the label its assertions name it by.
const NOT_A_LIST = [ [ undefined, "undefined" ], [ null, "null" ], [ { address: ADDRESS }, "an object" ], [ "unifi.local", "a non-empty string" ],
  [ "", "an empty string" ], [ 42, "a number" ] ] as [ unknown, string ][];

describe("protect webUI configured controllers, one entry per listed address", () => {

  test("a controllers value that is not a list reads as no controllers", () => {

    for(const [ value, label ] of NOT_A_LIST) {

      assert.deepEqual(controllers({ controllers: value }), [], label + " reads as an empty list");
    }
  });

  // Every reader of the list goes through the helper, so a value that is not a list reaches none of them as anything but an empty list. The credentials gate is a
  // control that answers the same for these values whether or not the helper checks for a list.
  test("over a controllers value that is not a list, first run is required, passable, and writes a list holding the one new entry", () => {

    for(const [ value, label ] of NOT_A_LIST) {

      const config: ProtectConfig = { controllers: value };

      assert.equal(hasValidCredentials(config), false, label + " holds no valid credentials, so first run is required");
      assert.equal(primaryListedElsewhere(config, { address: ADDRESS }), false, label + " lists no address, and the early check answers without throwing");
      assert.deepEqual(withPrimaryCredentials(config, { ...CREDENTIALS })?.controllers, [CREDENTIALS], label + " is written as a list holding the one new entry");
    }
  });

  // The gate reads the address as the plugin does, trimmed and only as a string. An array is a non-string with a length of its own, so it needs the string check
  // rather than the length check alone, and the padded real address is the other half: the trim reads past the spaces rather than refusing an address for them.
  test("an address of spaces alone, or one that is not a string, holds no valid credentials, so first run is required", () => {

    for(const [ address, label ] of [ [ "   ", "an address of spaces alone" ], [ 42, "a number" ], [ [ADDRESS], "an array" ] ] as [ unknown, string ][]) {

      assert.equal(hasValidCredentials({ controllers: [{ ...CREDENTIALS, address }] }), false, label + " holds no valid credentials, so first run is required");
    }

    assert.equal(hasValidCredentials({ controllers: [{ ...CREDENTIALS, address: " " + ADDRESS + " " }] }), true, "a padded real address still holds valid credentials");
  });

  test("an entry that is not an object is left out, and the object entries beside it are kept in their stored order as the stored objects", () => {

    const first = { ...CREDENTIALS };
    const second = { ...LOGIN, address: "10.0.0.2" };
    const read = controllers({ controllers: [ null, first, "unifi.local", second, 42 ] });

    assert.equal(read.length, 2, "null, a string, and a number are left out");
    assert.equal(read[0], first, "the first object entry is kept as the stored object itself");
    assert.equal(read[1], second, "and so is the second, in its stored order");
  });

  // The comparison form is the listed-address rule's own, so the list the page reads and the refusal a save meets agree on which entries are one controller.
  test("the first entry at an address is kept and every later entry at it is left out, by the form the listed-address rule compares in", () => {

    const first = { ...LOGIN, address: "unifi.local" };

    for(const [ repeat, label ] of [ [ "unifi.local", "the exact address" ], [ "UNIFI.Local", "the address in another case" ],
      [ "  unifi.local\t", "the address with surrounding space" ], [ "unifi.local.", "the address with a trailing dot" ],
      [ "UniFi.local:443", "the address with the default port" ] ] as [ string, string ][]) {

      const read = controllers({ controllers: [ first, { ...LOGIN, address: repeat } ] });

      assert.equal(read.length, 1, "a later entry at " + label + " is left out");
      assert.equal(read[0], first, "and the first entry is kept as the stored object, beside a later entry at " + label);
    }

    // An entry whose address has no form never repeats another, so every one of these is kept, an absent address and an empty one each appearing more than once.
    const distinct: ProtectControllerConfig[] = [ { ...LOGIN, address: "10.0.0.2" }, { ...LOGIN, address: "10.0.0.1" }, { ...LOGIN, address: "unifi.local." },
      { ...LOGIN, address: "unifi.local:8443" } ];
    const formless: ProtectControllerConfig[] = [ { ...LOGIN }, { ...LOGIN, address: "" }, { ...LOGIN, address: "   " }, { ...LOGIN, address: 42 }, { ...LOGIN },
      { ...LOGIN, address: "" } ];

    assert.deepEqual(controllers({ controllers: distinct }).map((item) => distinct.indexOf(item)), [ 0, 1, 2, 3 ],
      "entries at different addresses are each kept as the stored object, in their stored order");
    assert.deepEqual(controllers({ controllers: formless }).map((item) => formless.indexOf(item)), [ 0, 1, 2, 3, 4, 5 ],
      "and every entry whose address has no form is kept as the stored object, in its stored order");
  });

  test("a save over a repeated address writes the edited first entry and no entry at the address after it, and a removal takes every spelling of its address", () => {

    const other = { ...LOGIN, address: "10.0.0.2" };
    const saved = withControllerSaved({ controllers: [ { ...CREDENTIALS }, other, { ...CREDENTIALS, username: "twin@example.com" } ] },
      { ...CREDENTIALS, originalAddress: ADDRESS, password: "new secret" });

    assert.ok(saved, "the edit is written");
    assert.deepEqual(saved.controllers, [ { ...CREDENTIALS, password: "new secret" }, other ],
      "with the edited first entry, the other address's entry, and no entry at the edited address after them");

    const removed = withControllerRemoved({ controllers: [ { ...LOGIN, address: "unifi.local" }, { ...LOGIN, address: "UNIFI.local" }, other ] },
      { address: "unifi.local" });

    assert.deepEqual(removed.controllers, [other], "a removal takes the address's first entry, and the entry differing from it only in letter case leaves with it");
  });

  test("the controllers awaiting migration are read one entry per listed address, and a repeated entry alone causes no write", () => {

    const both: TestConfig = { controllers: [ { ...CREDENTIALS, mqttUrl: LEGACY_BROKER },
      { ...CREDENTIALS, mqttUrl: "mqtt://10.0.0.5:1883", username: "twin@example.com" } ] };
    const laterOnly: TestConfig = { controllers: [ { ...CREDENTIALS }, { ...CREDENTIALS, mqttUrl: LEGACY_BROKER, username: "twin@example.com" } ] };

    assert.deepEqual(controllersAwaitingMigration(both), [CREDENTIALS],
      "where every entry at an address carries a legacy setting, the first entry's triple alone awaits migration");
    assert.deepEqual(controllersAwaitingMigration(laterOnly), [], "where only the later entry carries one, nothing awaits migration");
    assert.equal(protectConfig.migrate(laterOnly, RESOLVED), null, "and the migration over it has nothing to do, so the repeated entry stays where it is");
  });

  test("the migration over a repeated address composes the first entry's value alone and writes one successor there", () => {

    const config: TestConfig = { controllers: [ { ...CREDENTIALS, mqttUrl: LEGACY_BROKER },
      { ...CREDENTIALS, mqttUrl: "mqtt://10.0.0.5:1883", username: "twin@example.com" } ] };
    const patch = migrated(config, RESOLVED);

    assert.equal(engineWith(patch.options).value("Mqtt.Url", undefined, CONTROLLER_MAC), LEGACY_BROKER, "the first entry's broker composes at the controller's scope");
    assert.equal(entriesFor(patch.options, "Mqtt.Url").length, 1, "and the later entry's broker composes nothing");
    assert.deepEqual(patch.controllers, [CREDENTIALS], "and one successor is written at the address, the first entry's");

    // A topic equal to the registered default composes nothing, which leaves the controller's scope open, so a later entry read here would compose its own topic.
    const defaulted: TestConfig = { controllers: [ { ...CREDENTIALS, mqttTopic: PROTECT_MQTT_TOPIC },
      { ...CREDENTIALS, mqttTopic: LEGACY_TOPIC, username: "twin@example.com" } ] };
    const defaultedPatch = migrated(defaulted, RESOLVED);

    assert.equal(engineWith(defaultedPatch.options).scope("Mqtt.Topic", undefined, CONTROLLER_MAC), "none",
      "the later entry's topic composes nothing where the first entry's default composed nothing");
    assert.deepEqual(defaultedPatch.controllers, [CREDENTIALS], "and one successor is written at the address");
  });

  test("the migration over an entry that is not an object, beside a controller with nothing to migrate, writes nothing", () => {

    assert.equal(protectConfig.migrate({ controllers: [ "unifi.local", { ...CREDENTIALS } ] }, RESOLVED), null,
      "an entry that is not an object causes no write, because the migration reads the list the page reads");
  });
});

// The headlines, reasons, and guidance each device-list outcome renders under, transcribed rather than referenced so a sentence that drifts by a character in its
// one home reddens a row.
const CONNECTION_FAILURE_HEADLINE = "Unable to connect to the UniFi Protect controller.";
const SERVER_FAILURE_HEADLINE = "The plugin's UI server did not answer as expected.";
const SERVER_FAILURE_MESSAGE = "The plugin's UI server answered in an unrecognized shape.";
const SERVER_FAILURE_GUIDANCE = "Reload this page. If it keeps happening, restart Homebridge and check its log for the reason.";

// The device list a reachable controller answers, opening with the controller's own record as every list the UI server answers does.
const LISTED_DEVICES = [ { mac: CONTROLLER_MAC, modelKey: "nvr" }, { mac: CAMERA_MAC, modelKey: "camera" } ];

// The server's answer as the bridge resolved it, and the request the bridge rejected, in the settlement shape the reading takes.
const answered = (value: unknown): PromiseSettledResult<unknown> => ({ status: "fulfilled", value });
const rejected = (reason: unknown): PromiseSettledResult<unknown> => ({ reason, status: "rejected" });

describe("protect webUI device-list outcomes", () => {

  test("a device list with an empty error is the list, and its result carries the devices and no copy at all", () => {

    const verdict = readDeviceListAnswer(answered({ devices: LISTED_DEVICES, error: "" }));
    const result = deviceListResult(verdict);

    assert.deepEqual(verdict, { devices: LISTED_DEVICES, kind: "list", message: "" }, "the list reads as itself");
    assert.deepEqual(result, { devices: LISTED_DEVICES, error: "" }, "and hands the framework its devices with an empty error");
    assert.deepEqual(Object.keys(result).sort(), [ "devices", "error" ], "a success carries no headline and no guidance");
  });

  test("an empty list with the server's reason is the unreachable controller, under its own headline and with no guidance", () => {

    const verdict = readDeviceListAnswer(answered({ devices: [], error: "Invalid username or password." }));
    const result = deviceListResult(verdict);

    assert.deepEqual(verdict, { devices: [], headline: CONNECTION_FAILURE_HEADLINE, kind: "unreachable", message: "Invalid username or password." },
      "the verdict carries the server's own reason under the headline that names the controller");
    assert.deepEqual(result, { devices: [], error: "Invalid username or password.", headline: CONNECTION_FAILURE_HEADLINE },
      "and its result carries no devices and no guidance, so the page's own guidance line stands beneath the server's text");
  });

  test("an empty list with an empty error reads as unreachable and maps to an empty hook error", () => {

    const verdict = readDeviceListAnswer(answered({ devices: [], error: "" }));

    assert.deepEqual(verdict, { devices: [], headline: CONNECTION_FAILURE_HEADLINE, kind: "unreachable", message: "" },
      "a failure whose reason the server could not capture is still the unreachable controller");
    assert.deepEqual(deviceListResult(verdict), { devices: [], error: "", headline: CONNECTION_FAILURE_HEADLINE },
      "and its result carries no devices, an empty error, and no guidance, so the page shows what it shows for that answer from the server directly");
  });

  test("an answer in any shape the server never writes is the UI server failure, carrying the unrecognized-shape sentence", () => {

    const malformed: unknown[] = [ undefined, null, "a string", 42, [], {}, { error: "" }, { error: 42 }, { devices: "a string", error: "" },
      { devices: [], error: 42 }, { devices: LISTED_DEVICES, error: "a reason beside a list" } ];

    for(const answer of malformed) {

      const label = (JSON.stringify(answer) as string | undefined) ?? "undefined";
      const verdict = readDeviceListAnswer(answered(answer));

      assert.deepEqual(verdict, { devices: [], guidance: SERVER_FAILURE_GUIDANCE, headline: SERVER_FAILURE_HEADLINE, kind: "serverFailure",
        message: SERVER_FAILURE_MESSAGE }, label + " reads as the UI server failure rather than as an empty controller");
      assert.deepEqual(deviceListResult(verdict), { devices: [], error: SERVER_FAILURE_MESSAGE, guidance: SERVER_FAILURE_GUIDANCE, headline: SERVER_FAILURE_HEADLINE },
        label + " maps to a failure with no devices, its sentence, its headline, and its own guidance");
    }
  });

  test("a rejected request is the UI server failure carrying the rejection's own message, or the unrecognized-shape sentence when it has none", () => {

    assert.deepEqual(deviceListResult(readDeviceListAnswer(rejected(new Error("The UI server did not respond.")))),
      { devices: [], error: "The UI server did not respond.", guidance: SERVER_FAILURE_GUIDANCE, headline: SERVER_FAILURE_HEADLINE },
      "a rejection with a message carries that message under the UI server's headline");
    assert.deepEqual(deviceListResult(readDeviceListAnswer(rejected({ message: "Not Found", path: "/getDevices" }))),
      { devices: [], error: "Not Found", guidance: SERVER_FAILURE_GUIDANCE, headline: SERVER_FAILURE_HEADLINE },
      "a plain-object rejection, the shape the host's bridge rejects with, carries its own message rather than the object rendered as text");

    // An empty failure message reads as a healthy controller, so a rejection that carries no message of its own carries the unrecognized-shape sentence.
    for(const [ reason, label ] of [ [ { error: "a detail with no message" }, "a plain-object rejection with no message" ], [ undefined, "a rejection of undefined" ],
      [ new Error(""), "an error with an empty message" ] ] as [ unknown, string ][]) {

      assert.deepEqual(deviceListResult(readDeviceListAnswer(rejected(reason))),
        { devices: [], error: SERVER_FAILURE_MESSAGE, guidance: SERVER_FAILURE_GUIDANCE, headline: SERVER_FAILURE_HEADLINE },
        label + " carries the unrecognized-shape sentence");
    }
  });

  test("a sidebar entry whose controller left the configuration states its own headline, reason, and guidance", () => {

    assert.deepEqual(deviceListResult(staleSelectionVerdict()), { devices: [], error: "Its entry left the configuration after the sidebar was built.",
      guidance: "Refresh the controller list to take it off the sidebar.", headline: "This controller is no longer in the plugin configuration." },
    "the stale entry carries no devices and all of its own copy");
  });

  test("no two results share a device array", () => {

    assert.notEqual(staleSelectionVerdict().devices, staleSelectionVerdict().devices, "every stale verdict composes a fresh array");
    assert.notEqual(readDeviceListAnswer(answered({})).devices, readDeviceListAnswer(answered({})).devices, "as does every UI server failure");
    assert.notEqual(readDeviceListAnswer(answered({ devices: [], error: "" })).devices, readDeviceListAnswer(answered({ devices: [], error: "" })).devices,
      "and every unreachable verdict");
  });
});

describe("protect webUI device-row naming", () => {

  // A camera row as the live page holds it: the UI server's record, carrying the name the server composed for the camera beside the name the controller reports, and
  // the page's serialNumber, which is the camera's MAC. The controller reports an emoji-only name, which HomeKit can carry nothing of, so the server composed the
  // camera's model for it, and a namer that read the controller's name in place of the composed one would show a different name.
  const cameraRow = { homeKitName: "G4 Doorbell Pro", mac: CAMERA_MAC, marketName: "G4 Doorbell Pro", modelKey: "camera", name: "🙂", serialNumber: CAMERA_MAC };

  // The entry storing one custom name at a device's scope, composed through the engine's own setOption, so the namer reads back the grammar the page writes.
  const customName = (value: string, id = CAMERA_MAC): string => composedEntry({ enabled: true, id, option: "Device.Name", value });

  test("a row shows the custom name HomeKit can carry, sanitized as HomeKit carries it", () => {

    assert.equal(protectConfig.deviceNamer({ options: [customName("Porch")] })(cameraRow), "Porch", "the custom name names the row");
    assert.equal(protectConfig.deviceNamer({ options: [customName("Bedtime 🌙")] })(cameraRow), "Bedtime",
      "a custom name HomeKit cleans is shown as HomeKit carries it");
  });

  test("a row whose custom name HomeKit can carry nothing of, or that has none, shows the name the UI server composed, sanitized", () => {

    for(const value of [ "🙂", "---" ]) {

      assert.equal(protectConfig.deviceNamer({ options: [customName(value)] })(cameraRow), "G4 Doorbell Pro",
        "the custom name " + JSON.stringify(value) + " counts as none");
    }

    assert.equal(protectConfig.deviceNamer({ options: [] })(cameraRow), "G4 Doorbell Pro", "a row with no custom name shows the composed name");
    assert.equal(protectConfig.deviceNamer({ options: [] })({ ...cameraRow, homeKitName: "Front Door 🌙" }), "Front Door", "the composed name is shown sanitized");
  });

  test("a row carrying no composed name shows the name it carries", () => {

    const { homeKitName: _homeKitName, ...uncomposed } = { ...cameraRow, name: "Front|Door" };

    assert.equal(protectConfig.deviceNamer({ options: [] })(uncomposed), "Front Door", "the controller's name for the device is the fallback, sanitized");
    assert.equal(protectConfig.deviceNamer({ options: [customName("Porch")] })(uncomposed), "Porch", "and a custom name still names the row");
  });

  test("a controller row is unchanged", () => {

    // The controller's own row carries no composed name, and a custom name set for one of its devices is read at that device's scope alone.
    const controllerRow = { mac: CONTROLLER_MAC, modelKey: "nvr", name: "Home NVR", serialNumber: CONTROLLER_MAC };

    assert.equal(protectConfig.deviceNamer({ options: [customName("Porch")] })(controllerRow), "Home NVR", "the controller row shows its own name");
  });

  test("a custom name is read back through the engine at the row's own serialNumber and nowhere else", () => {

    // A custom name stored for another device names only that device, and one written globally names nothing, because the option declares device scope alone.
    const namer = protectConfig.deviceNamer({ options: [ customName("Porch", OTHER_MAC), "Enable.Device.Name=Everywhere" ] });

    assert.equal(namer(cameraRow), "G4 Doorbell Pro", "neither entry names this row");
    assert.equal(namer({ ...cameraRow, mac: OTHER_MAC, serialNumber: OTHER_MAC }), "Porch", "and the other device's row is named by its own entry");
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
