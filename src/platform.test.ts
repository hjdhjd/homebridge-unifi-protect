/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * platform.test.ts: The platform's construction-time wiring of the legacy feature-option translation, driven against the REAL ProtectPlatform.
 *
 * The claim under test is a wiring claim, so the real class is what has to make it: that the configured options reach the feature-option engine through the analysis
 * rather than raw, and that a translated configuration says so once. Both are asserted through observable behavior - what the constructed engine resolves, and what
 * the logger was handed - rather than by reading the platform's internals, so the rows survive a change in how the wiring is spelled.
 *
 * Construction stops at the no-controllers early return, which is deliberate: everything this file asserts happens before it, and stopping there keeps the rows free
 * of controller logins, FFmpeg probes, and the Homebridge launch handshake.
 *
 * Every configuration here is written in the RETIRED option grammar, deliberately and throughout: what these rows exist to prove is that such a configuration reaches
 * the engine translated. That is the exemption the zero-residue sweeps carry for this file, alongside the translation layer's own suite.
 */
import type { API, Logging } from "homebridge";
import { describe, test } from "node:test";
import { featureOptionCategories, featureOptions } from "./options.ts";
import { FeatureOptions } from "homebridge-plugin-utils";
import { ProtectPlatform } from "./platform.ts";
import type { ProtectPlatformConfig } from "./types.ts";
import assert from "node:assert/strict";

// The controller and camera these rows resolve against.
const CONTROLLER = "AABBCCDDEEFF";
const CAMERA = "0123456789AB";

// One captured line from the logger double, carrying the severity, the message, and whatever context rode alongside it.
interface CapturedLine {

  level: string;
  message: string;
  parameters: unknown[];
}

/* Build the platform against the smallest doubles its construction reaches.
 *
 * The logger is a callable object because Homebridge's own logger is: the plugin's debug router wraps it, so a plain record would not survive the wrap. The API double
 * is empty because a configuration with no controllers returns before anything on it is touched - the launch handshake and the HAP namespaces are both past that point.
 *
 * @param options - The configured feature options the platform is constructed with.
 *
 * @returns The constructed platform and every line its construction logged.
 */
function buildPlatform(options: string[]): { lines: CapturedLine[]; platform: ProtectPlatform } {

  const lines: CapturedLine[] = [];
  const sink = (level: string) => (message: string, ...parameters: unknown[]): void => {

    lines.push({ level, message, parameters });
  };
  const log = Object.assign(sink("info"), { debug: sink("debug"), error: sink("error"), info: sink("info"), log: sink("info"), success: sink("success"),
    warn: sink("warn") });
  const config: ProtectPlatformConfig = { name: "UniFi Protect", options, platform: "UniFi Protect" };

  return { lines, platform: new ProtectPlatform(log as unknown as Logging, config, {} as unknown as API) };
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
    assert.deepEqual(narrations[0]?.parameters, [{ entries: [ "Enable.Video.Rtsp.Only.High", "Enable.Video.Timeshift.Only.Low" ] }],
      "the entries it acted on ride along as context");
  });

  // A configuration already speaking the current grammar has nothing to say, so the line stays out of the log entirely rather than reporting an empty translation.
  test("a canonical configuration narrates nothing", () => {

    const { lines } = buildPlatform(["Enable.Video.Rtsp.Only=High"]);

    assert.equal(lines.filter((line) => line.message.includes("translated automatically at startup")).length, 0, "nothing was translated, so nothing is said");
  });
});
