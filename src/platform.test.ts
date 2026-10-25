/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * platform.test.ts: The platform's construction-time wiring of the legacy feature-option translation and its walk of the configured controllers, driven against
 * the REAL ProtectPlatform.
 *
 * The claims under test are wiring claims, so the real class is what has to make them: that the configured options reach the feature-option engine through the
 * analysis rather than raw, that a translated configuration says so once, and that the controller walk reads one entry per listed address, warns once for each
 * address listed more than once, and reads a configured value that is not a list as no controllers. Each is asserted through observable behavior - what the
 * constructed engine resolves, and what the logger was handed - rather than by reading the platform's internals, so the rows survive a change in how the wiring is
 * spelled.
 *
 * No row reaches a controller login, an FFmpeg probe, or the Homebridge launch handshake. A configuration with no controllers returns before the walk, and every
 * controller entry a row configures carries no credentials, so the walk builds no controller and the launch handler it registers is never called.
 *
 * Every option entry configured here is written in the RETIRED option grammar, deliberately and throughout: what these rows exist to prove is that such a
 * configuration reaches the engine translated. That is the exemption the zero-residue sweeps carry for this file, alongside the translation layer's own suite.
 */
import type { API, Logging } from "homebridge";
import { describe, test } from "node:test";
import { featureOptionCategories, featureOptions } from "./options.ts";
import { FeatureOptions } from "homebridge-plugin-utils";
import { ProtectPlatform } from "./platform.ts";
import type { ProtectPlatformConfig } from "./types.ts";
import type { TestLogEntry } from "homebridge-plugin-utils/testing";
import assert from "node:assert/strict";
import { makeTestApi } from "./testing.helpers.ts";

// The controller and camera these rows resolve against.
const CONTROLLER = "AABBCCDDEEFF";
const CAMERA = "0123456789AB";

// The lines the controller walk logs, transcribed rather than referenced so a sentence that drifts by a character in its one home reddens a row. Each is the whole
// line a row expects, level and parameters included.
const LISTED_AGAIN = "The controller %s is listed more than once in the plugin configuration. Only its first entry is used. Saving that controller in the plugin " +
  "settings removes the extra entries.";
const NO_CONTROLLERS: TestLogEntry = { level: "info", message: "No UniFi Protect controllers have been configured.", params: [] };
const NO_CREDENTIALS: TestLogEntry = { level: "info", message: "No UniFi Protect login credentials have been configured.", params: [] };
const NO_HOST: TestLogEntry = { level: "info", message: "No host or IP address has been configured.", params: [] };

/* The warning the walk logs for an address listed more than once.
 *
 * @param address - The address as the first entry at it stores it.
 *
 * @returns The line.
 */
function listedAgain(address: string): TestLogEntry {

  return { level: "warn", message: LISTED_AGAIN, params: [address] };
}

/* Build the platform against the smallest doubles its construction reaches.
 *
 * The logger is a callable object because Homebridge's own logger is: the plugin's debug router wraps it, so a plain record would not survive the wrap. The API double
 * is HBPU's, over the Homebridge runtime the root harness loads, and it emits nothing on its own: a configuration with controllers registers its launch handler once
 * its walk is done, and nothing here launches, while a configuration with no controllers returns before anything on the API is touched.
 *
 * @param options     - The configured feature options the platform is constructed with.
 * @param controllers - The configured controllers value, in whatever shape a hand edit could leave it, or absent for a configuration with none.
 *
 * @returns The constructed platform and every line its construction logged.
 */
function buildPlatform(options: string[], controllers?: unknown): { lines: TestLogEntry[]; platform: ProtectPlatform } {

  const lines: TestLogEntry[] = [];
  const sink = (level: TestLogEntry["level"]) => (message: string, ...params: unknown[]): void => {

    lines.push({ level, message, params });
  };
  // Homebridge's own logger is a callable object carrying a method per level, and the plugin's debug router wraps it, so the double has to be one too. Its success and
  // log channels record at info: the captured shape carries the four severities production actually branches on, and nothing here asserts on either channel.
  const log = Object.assign(sink("info"), { debug: sink("debug"), error: sink("error"), info: sink("info"), log: sink("info"), success: sink("info"),
    warn: sink("warn") });
  const config: ProtectPlatformConfig = { controllers: controllers as ProtectPlatformConfig["controllers"], name: "UniFi Protect", options, platform: "UniFi Protect" };
  const api = makeTestApi();

  return { lines, platform: new ProtectPlatform(log as unknown as Logging, config, api as unknown as API) };
}

describe("platform construction and the legacy feature-option translation", () => {

  /* The wiring row: a device-scoped retired pin entry resolves at that camera once the platform has built its engine. It is device-scoped on purpose - a scoped
   * retired entry registers a key that addresses no current option, so the engine reads nothing from it on its own. The control below builds the same engine on the
   * RAW array and shows exactly that, which is what makes this row red against a platform that forgot to route its options through the analysis.
   */
  test("construction routes the configured options through the analysis into the engine", () => {

    const options = ["Enable.Video.Rtsp.Only.High." + CAMERA];
    const { platform } = buildPlatform(options);

    assert.equal(platform.featureOptions.value("Video.Rtsp.Only", CAMERA, CONTROLLER), "High", "the translated pin resolves at the camera");
    assert.equal(new FeatureOptions(featureOptionCategories, featureOptions, [...options]).value("Video.Rtsp.Only", CAMERA, CONTROLLER), null,
      "the same engine built on the raw array resolves nothing, which is what the analysis is there to prevent");
  });

  // The analysis result is retained where the device layer reads it, so a family still needing the overlay is visible to every reader that resolves a selection.
  test("construction retains which families still need the overlay", () => {

    const { platform } = buildPlatform(["Enable.Video.Rtsp.Only.High." + CAMERA]);

    assert.deepEqual([...platform.legacyOptions.families], ["rtspPin"], "the direct-RTSP family is marked for the overlay");
    assert.deepEqual(platform.config.options, ["Enable.Video.Rtsp.Only.High." + CAMERA], "the raw entries stay where the overlay reads them");
  });

  // A translated configuration says so exactly once, at warn, and names the entries it acted on so a user can see what was read and where to make it permanent.
  test("a translated configuration narrates once at warn with the entries it translated", () => {

    const { lines } = buildPlatform([ "Enable.Video.Rtsp.Only.High", "Enable.Video.Timeshift.Only.Low" ]);
    const narrations = lines.filter((line) => line.message.includes("translated automatically at startup"));

    assert.equal(narrations.length, 1, "the translation is narrated once");
    assert.equal(narrations[0]?.level, "warn", "it is a warning, because the configuration on disk still speaks the older grammar");
    assert.deepEqual(narrations[0].params, [{ entries: [ "Enable.Video.Rtsp.Only.High", "Enable.Video.Timeshift.Only.Low" ] }],
      "the entries it acted on ride along as context");
  });

  // A configuration already speaking the current grammar has nothing to say, so the line stays out of the log entirely rather than reporting an empty translation.
  test("a canonical configuration narrates nothing", () => {

    const { lines } = buildPlatform(["Enable.Video.Rtsp.Only=High"]);

    assert.equal(lines.filter((line) => line.message.includes("translated automatically at startup")).length, 0, "nothing was translated, so nothing is said");
  });
});

describe("platform construction and the configured controllers", () => {

  /* One address in spellings the settings page reads as one controller, by the listed-address rule the page and the walk share. The first repeat is a spelling the
   * first entry does not store, so a warning that named the repeated spelling rather than the first entry's would redden the row, and the single credentials line is
   * the walk reading the first entry alone.
   */
  test("entries at one address in its exact, case-varied, space-padded, dotted, and default-port spellings warn once, naming the first entry's address", () => {

    const { lines } = buildPlatform([], [ { address: "UniFi.local" }, { address: "UNIFI.LOCAL" }, { address: "  unifi.local\t" }, { address: "unifi.local." },
      { address: "UniFi.local:443" }, { address: "UniFi.local" } ]);

    assert.deepEqual(lines, [ NO_CREDENTIALS, listedAgain("UniFi.local") ],
      "the first entry is read, and the first repeat warns once with the address as the first entry stores it while every repeat is skipped");
  });

  // An IPv6 literal names one console with or without its brackets, and a port other than the default names another console, so only the bracketed repeat warns.
  test("an IPv6 address repeated in its bracketed spelling warns once, and the same host on another port is read as its own controller", () => {

    const { lines } = buildPlatform([], [ { address: "fe80::1" }, { address: "[FE80::1]" }, { address: "unifi.local" }, { address: "unifi.local:8443" } ]);

    assert.deepEqual(lines, [ NO_CREDENTIALS, listedAgain("fe80::1"), NO_CREDENTIALS, NO_CREDENTIALS ],
      "the bracketed repeat is skipped with one warning naming the first entry's address, and the entry on another port is read beside the bare host");
  });

  // However many entries repeat an address, the warning is about the address, so it is logged once for it, naming the address as the first entry stores it.
  test("entries at two addresses, one of them repeated twice more, warn once", () => {

    const { lines } = buildPlatform([], [ { address: "10.0.0.1" }, { address: "10.0.0.2" }, { address: " 10.0.0.1 " }, { address: "10.0.0.1" } ]);

    assert.deepEqual(lines, [ NO_CREDENTIALS, NO_CREDENTIALS, listedAgain("10.0.0.1") ],
      "each address's first entry is read, and the repeated address warns once however many entries repeat it");
  });

  // An entry with no address has no form to repeat, so entries with no address are never one controller and each still reaches the address check.
  test("entries at distinct addresses, and entries with no address, warn nothing", () => {

    const { lines } = buildPlatform([], [ { address: "10.0.0.1" }, { address: "10.0.0.2" }, {}, {}, { address: "" }, { address: "" } ]);

    assert.deepEqual(lines, [ NO_CREDENTIALS, NO_CREDENTIALS, NO_HOST, NO_HOST, NO_HOST, NO_HOST ],
      "every entry is read and nothing is reported, because no address repeats");
  });

  // A string is the shape a walk with no list check reads character by character, logging a line for each; an object and a number are controls, which read as no
  // controllers with no list check too.
  test("a controllers value that is not a list reads as no controllers", () => {

    for(const [ value, label ] of [ [ { address: "10.0.0.1" }, "an object" ], [ "unifi.local", "a non-empty string" ], [ 42, "a number" ] ] as [ unknown, string ][]) {

      assert.deepEqual(buildPlatform([], value).lines, [NO_CONTROLLERS], label + " logs the no-controllers line once and nothing about an address or credentials");
    }
  });

  // A hand edit can leave anything in the list, and an entry that is not an object carries nothing to read, so it is passed over without a line.
  test("a list holding null and a string beside one entry with no credentials constructs and reads the one entry", () => {

    const { lines } = buildPlatform([], [ null, "unifi.local", { address: "10.0.0.1" } ]);

    assert.deepEqual(lines, [NO_CREDENTIALS], "construction completes, and only the one entry is read");
  });
});
