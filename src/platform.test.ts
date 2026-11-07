/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * platform.test.ts: The platform's construction-time wiring of the retired feature-option translation and its walk of the configured controllers, driven against
 * the REAL ProtectPlatform.
 *
 * The claims under test are wiring claims, so the real class is what has to make them: that the configured options reach the feature-option engine through the
 * analysis rather than raw, that a translated configuration says so once, and that the controller walk reads one entry per listed address, warns once for each
 * address listed more than once, reads an address trimmed and one that is not a string as no address, and reads a configured value that is not a list as no
 * controllers. Each is asserted through observable behavior - what the constructed engine resolves, and what the logger was handed - rather than by reading the
 * platform's internals, so the rows survive a change in how the wiring is spelled. The one internal read is the list of controllers the walk built, which the
 * platform keeps to itself, and which the trim rows read because a controller says nothing until it logs in.
 *
 * The launch rows are the one place the launch signal is emitted, and they stand in for what lies behind it: a mocked FFmpeg probe answers with a populated value, and
 * each row replaces login on the controllers it reads, unless it answers unifi-protect's connect with a client double to reach a real login's rejection, and a row
 * whose controller names a broker hands the platform HBPU's test MQTT factory, so no row reaches a real probe, a real controller or a real broker. A configuration
 * with no controllers returns before the walk. Most entries a row configures carry no credentials, so the walk builds no controller for them, and a row whose entry
 * carries credentials ends with Homebridge's shutdown, so the controller built for it lets go of what it subscribed to.
 *
 * Every option entry the translation rows configure is written in the RETIRED option grammar, deliberately and throughout: what those rows exist to prove is that such a
 * configuration reaches the engine translated. That is the exemption the zero-residue sweeps carry for this file, alongside the translation layer's own suite.
 *
 * The restore sweep's rows hand the platform an accessory the way Homebridge hands one back from its cache, and read and write it through HAP's own paths.
 */
import type { API, Logging } from "homebridge";
import { APIEvent, FeatureOptions, FfmpegCodecs, HAPStatus, Perms, createMqttClient, parseFfmpegVersionParts } from "homebridge-plugin-utils";
import type { CapturingLog, TestHomebridgeApi, TestLogEntry } from "homebridge-plugin-utils/testing";
import { Characteristic, Service, TestStateStore, makeProtectState, makeTestAccessory, makeTestApi } from "./testing.helpers.ts";
import type { ProtectNvrConfig, ProtectNvrLiveviewConfig } from "unifi-protect";
import { TestMqttClientFactory, assertNoUnhandledRejections, capturingLog, expectAt, hapStatus, settle, settlePastMqttEnd, settleUntil, triggerGet,
  triggerSet } from "homebridge-plugin-utils/testing";
import { describe, test } from "node:test";
import { featureOptionCategories, featureOptions } from "./options.ts";
import { makeConnectedClient, makeNvrConfig } from "./nvr/testing.helpers.ts";
import { ProtectClient } from "unifi-protect";
import type { ProtectNvr } from "./nvr/nvr.ts";
import { ProtectPlatform } from "./platform.ts";
import type { ProtectPlatformConfig } from "./types.ts";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";

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
 * its walk is done, and only the launch rows emit the signal it waits on, while a configuration with no controllers returns before anything on the API is touched.
 *
 * @param options              - The configured feature options the platform is constructed with.
 * @param controllers          - The configured controllers value, in whatever shape a hand edit could leave it, or absent for a configuration with none.
 * @param injected             - What a suite hands the platform as its fourth argument, passed only when a row names it, so the platform is otherwise built
 *                               with Homebridge's three.
 * @param injected.mqttFactory - The factory the platform's controllers build their MQTT clients through.
 *
 * @returns The API double the platform was handed, the constructed platform, and the capturing log every line its construction logged lands on.
 */
function buildPlatform(options: string[], controllers?: unknown, { mqttFactory }: { mqttFactory?: typeof createMqttClient } = {}):
{ api: TestHomebridgeApi; log: CapturingLog; platform: ProtectPlatform } {

  const log = capturingLog();
  // Homebridge's own logger is a callable object carrying a method per level, and the plugin's debug router wraps it, so the double has to be one too, a callable over
  // the capturing log. Its success and log channels record at info: the captured shape carries the four severities production actually branches on, and nothing here
  // asserts on either channel.
  const homebridgeLog = Object.assign((message: string, ...params: unknown[]): void => log.info(message, ...params), { debug: log.debug, error: log.error,
    info: log.info, log: log.info, success: log.info, warn: log.warn });
  const config: ProtectPlatformConfig = { controllers: controllers as ProtectPlatformConfig["controllers"], name: "UniFi Protect", options, platform: "UniFi Protect" };
  const api = makeTestApi();
  const homebridgeArguments = [ homebridgeLog as unknown as Logging, config, api as unknown as API ] as const;

  return { api, log, platform: (mqttFactory === undefined) ? new ProtectPlatform(...homebridgeArguments) :
    new ProtectPlatform(...homebridgeArguments, { mqttFactory }) };
}

/* The controllers the walk built, in the order it built them. The platform keeps the list to itself, and a controller it builds logs nothing until it logs in,
 * which no row here reaches for real, so this is the one internal the rows read.
 *
 * @param platform - The constructed platform.
 *
 * @returns The controllers the walk constructed.
 */
function configuredControllers(platform: ProtectPlatform): ProtectNvr[] {

  return (platform as unknown as { controllers: ProtectNvr[] }).controllers;
}

describe("platform construction and the retired feature-option translation", () => {

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

  // The translation is retained where the device layer reads it, so a family still needing the overlay answers every reader that resolves a selection.
  test("construction retains which families still need the overlay", () => {

    const { platform } = buildPlatform(["Enable.Video.Rtsp.Only.High." + CAMERA]);

    assert.deepEqual(platform.retiredTranslation.selection({ device: CAMERA, domain: [ "High", "Medium", "Low" ], option: "Video.Rtsp.Only" }), ["High"],
      "the direct-RTSP family answers through the overlay");
    assert.deepEqual(platform.config.options, ["Enable.Video.Rtsp.Only.High." + CAMERA], "the raw entries stay as they were configured");
  });

  // A translated configuration says so exactly once, at warn, and names the entries it acted on so a user can see what was read and where to make it permanent.
  test("a translated configuration narrates once at warn with the entries it translated", () => {

    const { log } = buildPlatform([ "Enable.Video.Rtsp.Only.High", "Enable.Video.Timeshift.Only.Low" ]);
    const narrations = log.entries.filter((line) => line.message.includes("translated automatically at startup"));

    assert.equal(narrations.length, 1, "the translation is narrated once");
    assert.equal(narrations[0]?.level, "warn", "it is a warning, because the configuration on disk still speaks the older grammar");
    assert.deepEqual(narrations[0].params, [{ entries: [ "Enable.Video.Rtsp.Only.High", "Enable.Video.Timeshift.Only.Low" ] }],
      "the entries it acted on travel with it as context");
  });

  // A configuration already speaking the current grammar has nothing to say, so the line stays out of the log entirely rather than reporting an empty translation.
  test("a canonical configuration narrates nothing", () => {

    const { log } = buildPlatform(["Enable.Video.Rtsp.Only=High"]);

    assert.equal(log.entries.filter((line) => line.message.includes("translated automatically at startup")).length, 0, "nothing was translated, so nothing is said");
  });
});

describe("platform construction and the configured controllers", () => {

  /* One address in spellings the settings page reads as one controller, by the listed-address rule the page and the walk share. The first repeat is a spelling the
   * first entry does not store, so a warning that named the repeated spelling rather than the first entry's would redden the row, and the single credentials line is
   * the walk reading the first entry alone.
   */
  test("entries at one address in its exact, case-varied, space-padded, dotted, and default-port spellings warn once, naming the first entry's address", () => {

    const { log } = buildPlatform([], [ { address: "UniFi.local" }, { address: "UNIFI.LOCAL" }, { address: "  unifi.local\t" }, { address: "unifi.local." },
      { address: "UniFi.local:443" }, { address: "UniFi.local" } ]);

    assert.deepEqual(log.entries, [ NO_CREDENTIALS, listedAgain("UniFi.local") ],
      "the first entry is read, and the first repeat warns once with the address as the first entry stores it while every repeat is skipped");
  });

  // An IPv6 literal names one console with or without its brackets, and a port other than the default names another console, so only the bracketed repeat warns.
  test("an IPv6 address repeated in its bracketed spelling warns once, and the same host on another port is read as its own controller", () => {

    const { log } = buildPlatform([], [ { address: "fe80::1" }, { address: "[FE80::1]" }, { address: "unifi.local" }, { address: "unifi.local:8443" } ]);

    assert.deepEqual(log.entries, [ NO_CREDENTIALS, listedAgain("fe80::1"), NO_CREDENTIALS, NO_CREDENTIALS ],
      "the bracketed repeat is skipped with one warning naming the first entry's address, and the entry on another port is read beside the bare host");
  });

  // However many entries repeat an address, the warning is about the address, so it is logged once for it, naming the address as the first entry stores it.
  test("entries at two addresses, one of them repeated twice more, warn once", () => {

    const { log } = buildPlatform([], [ { address: "10.0.0.1" }, { address: "10.0.0.2" }, { address: " 10.0.0.1 " }, { address: "10.0.0.1" } ]);

    assert.deepEqual(log.entries, [ NO_CREDENTIALS, NO_CREDENTIALS, listedAgain("10.0.0.1") ],
      "each address's first entry is read, and the repeated address warns once however many entries repeat it");
  });

  /* An entry with no address has no form to repeat, so entries with no address are never one controller and each still reaches the address check. An address a hand
   * edit left a number is no address at all, so it reaches the same check rather than the credentials one behind it.
   */
  test("entries at distinct addresses, and entries with no address, warn nothing", () => {

    const { log } = buildPlatform([], [ { address: "10.0.0.1" }, { address: "10.0.0.2" }, {}, {}, { address: "" }, { address: "" }, { address: 10001 } ]);

    assert.deepEqual(log.entries, [ NO_CREDENTIALS, NO_CREDENTIALS, NO_HOST, NO_HOST, NO_HOST, NO_HOST, NO_HOST ],
      "every entry is read and nothing is reported, because no address repeats, and the entry a hand edit left a number is read as one with no address");
  });

  /* An address padded with spaces is the controller its trimmed form names, because the listed-address rule reads the padded and trimmed forms as one address while
   * unifi-protect refuses the padded one. The padded entry listed first is the case that matters: kept with its spaces, it would be the one entry the platform reads,
   * and the clean entry behind it the one skipped. Each entry carries credentials so the walk builds its controller, and the username tells the two apart.
   */
  test("a padded entry before its clean form is one controller at the trimmed address, warned about once", (t) => {

    const { api, log, platform } = buildPlatform([], [ { address: " 10.0.0.1 ", password: "password", username: "padded" },
      { address: "10.0.0.1", password: "password", username: "clean" } ]);

    t.after(() => void api.emit(APIEvent.SHUTDOWN));

    assert.deepEqual(log.entries, [listedAgain("10.0.0.1")], "the repeat warns once, naming the address as the plugin reads it");
    assert.deepEqual(configuredControllers(platform).map((controller) => [ controller.config.address, controller.config.username ]), [[ "10.0.0.1", "padded" ]],
      "and the first entry is the one constructed, at its trimmed address");
  });

  test("a padded entry alone reaches its controller trimmed, and the entry Homebridge handed over is left as it stands", (t) => {

    const entry = { address: "\tunifi.local  ", password: "password", username: "username" };
    const { api, log, platform } = buildPlatform([], [entry]);
    const [controller] = configuredControllers(platform);

    t.after(() => void api.emit(APIEvent.SHUTDOWN));

    assert.ok(controller, "the entry carries an address and credentials, so a controller is constructed for it");
    assert.equal(controller.config.address, "unifi.local", "the controller connects to the trimmed address, the form unifi-protect can carry");
    assert.deepEqual(log.entries, [], "a single entry repeats nothing");

    // A controller that has not connected prefixes its lines with its configured address, so a line it logs shows the form its prefix reads.
    controller.log.info("Probing the prefix.");

    assert.deepEqual(log.entries, [{ level: "info", message: "unifi.local: Probing the prefix.", params: [] }],
      "and its lines are prefixed with that form until it connects");
    assert.equal(entry.address, "\tunifi.local  ", "the trim reads a copy, so Homebridge's own configuration object keeps what it was handed");
  });

  // A string is the shape a walk with no list check reads character by character, logging a line for each; an object and a number are controls, which read as no
  // controllers with no list check too.
  test("a controllers value that is not a list reads as no controllers", () => {

    for(const [ value, label ] of [ [ { address: "10.0.0.1" }, "an object" ], [ "unifi.local", "a non-empty string" ], [ 42, "a number" ] ] as [ unknown, string ][]) {

      assert.deepEqual(buildPlatform([], value).log.entries, [NO_CONTROLLERS], label + " logs the no-controllers line once and nothing about an address or credentials");
    }
  });

  // A hand edit can leave anything in the list, and an entry that is not an object carries nothing to read, so it is passed over without a line.
  test("a list holding null and a string beside one entry with no credentials constructs and reads the one entry", () => {

    const { log } = buildPlatform([], [ null, "unifi.local", { address: "10.0.0.1" } ]);

    assert.deepEqual(log.entries, [NO_CREDENTIALS], "construction completes, and only the one entry is read");
  });

  // Homebridge hands the platform three arguments, so the factory its controllers build their MQTT clients through is the one that reaches a real broker.
  test("a platform built with three arguments holds createMqttClient as its factory", () => {

    const { platform } = buildPlatform([]);

    assert.equal(platform.mqttFactory, createMqttClient, "the controllers build their clients through HBPU's own factory");
  });
});

describe("the platform's launch of its controllers", () => {

  const FIRST = { address: "10.0.0.1", password: "password", username: "username" };
  const SECOND = { address: "10.0.0.2", password: "password", username: "username" };
  // A controller past connect says its lines under the name it connected to rather than its address, so a row reaching a real login reads the sentence alone.
  const LOGIN_REJECTED_SENTENCE = "Unable to finish starting the Protect controller: %s. Stopping it until Homebridge is restarted.";
  const LOGIN_REJECTED = "10.0.0.1: " + LOGIN_REJECTED_SENTENCE;
  const STOP_REJECTED = "10.0.0.1: Unable to finish stopping the Protect controller: %s.";

  // Stand in for a working FFmpeg, so the launch reaches each controller's login with no process started. The mock is the row's own, and the row's end restores it.
  function answerProbe(t: TestContext): void {

    const ffmpegVersionParts = parseFfmpegVersionParts("8.0");
    const state = { codecs: {}, cpuGeneration: 0, ffmpegExec: "ffmpeg", ffmpegVersion: "8.0", ffmpegVersionParts, gpuMem: 0, hostSystem: "macOS.Apple",
      hwAccels: new Set<string>(), verbose: false };

    t.mock.method(FfmpegCodecs, "probe", async (): Promise<FfmpegCodecs> => FfmpegCodecs.fromState(state));
  }

  /* Stand up a controller whose real login rejects past connect. unifi-protect's connect answers with a client double holding a liveview whose name cannot be read
   * as text, so the login builds the controller's MQTT client and then rejects in the liveviews' reconcile: the real rejection the catch exists for. The controller is
   * up past the stability window, so its sweep is armed when the login rejects. The mocks are the row's own, and the row's end is Homebridge's shutdown.
   *
   * @param t                   - The row's context.
   * @param options             - The controller's entry and the platform's MQTT factory.
   * @param options.entry       - The configured entry the controller is built from (omitted, FIRST).
   * @param options.mqttFactory - The factory handed to the platform (omitted, the platform is built with Homebridge's three arguments).
   *
   * @returns The API double, the controller, the controller record it connects to, the platform, and the capturing log every line lands on.
   */
  function rejectPastConnect(t: TestContext, { entry = FIRST, mqttFactory }: { entry?: unknown; mqttFactory?: typeof createMqttClient } = {}):
  { api: TestHomebridgeApi; controller: ProtectNvr; log: CapturingLog; nvrConfig: ProtectNvrConfig; platform: ProtectPlatform } {

    answerProbe(t);

    const nvrConfig: ProtectNvrConfig = { ...makeNvrConfig(), firmwareVersion: "4.3.6", upSince: 1, version: "7.3.70" };
    const liveview = { id: "liveview", isDefault: false, isGlobal: true, layout: 1, modelKey: "liveview", name: { toString: 7 }, owner: "user", slots: [] };
    const store = new TestStateStore(makeProtectState({ liveviews: [liveview as unknown as ProtectNvrLiveviewConfig], nvr: nvrConfig }));
    const client = makeConnectedClient({ nvrConfig, store });

    t.mock.method(ProtectClient, "connect", async (): Promise<ProtectClient> => client);

    const { api, log, platform } = buildPlatform([], [entry], { mqttFactory });
    const [controller] = configuredControllers(platform);

    t.after(() => void api.emit(APIEvent.SHUTDOWN));

    assert.ok(controller, "the entry carries an address and credentials, so a controller is constructed for it");

    return { api, controller, log, nvrConfig, platform };
  }

  /* A login that rejects floats out of the launch, where nothing awaits it, and a rejection that floats ends Homebridge, or a child bridge, for everyone. So the launch
   * answers for each login at its own call: the line lands on the controller that rejected, under its prefix with its reason's whole chain, that controller stops, and
   * the controller ahead of it, its own login still pending, is untouched...a launch that waited on the first login would never reach the second.
   */
  test("a rejected login is said on that controller's log and stops it, no rejection floats, and another controller's login still runs", async (t) => {

    answerProbe(t);

    const { api, log, platform } = buildPlatform([], [ SECOND, FIRST ]);
    const [ other, controller ] = configuredControllers(platform);

    t.after(() => void api.emit(APIEvent.SHUTDOWN));

    assert.ok(other && controller, "each entry carries an address and credentials, so a controller is constructed for each");

    other.login = async (): Promise<void> => {

      await once(other.signal, "abort");
    };

    controller.login = async (): Promise<void> => {

      throw new TypeError("The record is gone.", { cause: new Error("A cause beneath it.") });
    };

    await assertNoUnhandledRejections(async (): Promise<void> => {

      api.emit(APIEvent.DID_FINISH_LAUNCHING);

      await settleUntil(() => controller.signal.aborted, { description: "the rejected login's stop" });
    });

    assert.deepEqual(log.entries, [{ level: "error", message: LOGIN_REJECTED, params: ["The record is gone: A cause beneath it"] }],
      "the line is said once at error on the controller's own prefix, its reason keeping its chain");
    assert.equal(controller.phase, "shuttingDown", "the controller that rejected is stopped");
    assert.equal(other.signal.aborted, false, "and the other controller's signal holds");
    assert.equal(other.phase, "connecting", "with its login still under way");
  });

  // The line has to reach the log whatever the stop goes on to do, so it comes ahead of the stop's first wait.
  test("the line stands on the log while the stop's MQTT end is held", async (t) => {

    const { promise, resolve }: PromiseWithResolvers<void> = Promise.withResolvers();
    const factory = new TestMqttClientFactory({ holdEnd: promise });
    const { api, controller, log } = rejectPastConnect(t, { entry: { ...FIRST, mqttUrl: "mqtt://127.0.0.1:1" }, mqttFactory: factory.create });
    const errors = (): TestLogEntry[] => log.entries.filter(({ level }) => level === "error");

    t.after(() => resolve());

    await assertNoUnhandledRejections(async (): Promise<void> => {

      api.emit(APIEvent.DID_FINISH_LAUNCHING);

      await settleUntil(() => errors().length > 0, { description: "the line" });
      await settlePastMqttEnd();

      assert.equal(errors().length, 1, "the line is said once at error");
      assert.ok(errors()[0]?.message.endsWith(LOGIN_REJECTED_SENTENCE), "on the controller's own log");
      assert.equal(controller.signal.aborted, false, "while the end holds the stop back");
      assert.equal(factory.createCalls.length, 1, "the login built one MQTT client");
      assert.ok(expectAt(factory.createCalls, 0, "the controller's MQTT client").client, "and built it before it rejected");

      resolve();

      await settleUntil(() => controller.signal.aborted, { description: "the stop" });
    });

    assert.equal(controller.phase, "shuttingDown");
  });

  /* The control for the held stop above: with nothing holding it, the end the stop begins has finished once settlePastMqttEnd resolves, so the held row's reads measure
   * its hold. The settle starts inside a wrapper on the real login as its promise rejects, ahead of the platform's catch, so its turns count from the moment the
   * rejection reaches the platform: a catch that waited a turn before its stop would leave the end unfinished when the settle resolves, a delay that a settle started
   * once the line was read would absorb.
   */
  test("a stop after a rejected login, nothing holding its MQTT end, finishes the end within the turns an unheld end takes", async (t) => {

    const factory = new TestMqttClientFactory();
    const { api, controller } = rejectPastConnect(t, { entry: { ...FIRST, mqttUrl: "mqtt://127.0.0.1:1" }, mqttFactory: factory.create });
    const login = controller.login.bind(controller);

    let past: Promise<void> | undefined;

    controller.login = async (): Promise<void> => {

      try {

        await login();
      } catch(error) {

        past = settlePastMqttEnd();

        throw error;
      }
    };

    await assertNoUnhandledRejections(async (): Promise<void> => {

      api.emit(APIEvent.DID_FINISH_LAUNCHING);

      await settleUntil(() => past !== undefined, { description: "the login to reject" });
      await past;

      assert.equal(expectAt(factory.createCalls, 0, "the controller's MQTT client").client?.signal.aborted, true, "the client's end has finished");
    });
  });

  /* A stop that rejects is the last thing that could float out of the launch, so the controller says it on a line of its own and it costs that controller alone. The one
   * run it holds cannot reject, so a later Homebridge shutdown reads it, and its listener, which voids what it is handed, has nothing to raise.
   */
  test("a stop that rejects writes its line, leaves the other controller's signal holding, and a later Homebridge shutdown floats nothing", async (t) => {

    answerProbe(t);

    const { api, log, platform } = buildPlatform([], [ FIRST, SECOND ]);
    const [ controller, other ] = configuredControllers(platform);

    t.after(() => void api.emit(APIEvent.SHUTDOWN));

    assert.ok(controller && other, "each entry carries an address and credentials, so a controller is constructed for each");

    controller.client = { [Symbol.asyncDispose]: async (): Promise<void> => {

      throw new Error("The disposal failed.", { cause: new Error("A cause beneath it.") });
    } } as unknown as ProtectClient;

    controller.login = async (): Promise<void> => {

      throw new TypeError("The record is gone.");
    };

    other.login = async (): Promise<void> => {

      await once(other.signal, "abort");
    };

    await assertNoUnhandledRejections(async (): Promise<void> => {

      api.emit(APIEvent.DID_FINISH_LAUNCHING);

      await settleUntil(() => log.entries.length > 1, { description: "the stop's line" });

      assert.equal(other.signal.aborted, false, "the other controller's signal holds");
      assert.equal(other.phase, "connecting", "with its login still under way");

      api.emit(APIEvent.SHUTDOWN);

      await settle();
    });

    assert.deepEqual(log.entries, [ { level: "error", message: LOGIN_REJECTED, params: ["The record is gone"] },
      { level: "error", message: STOP_REJECTED, params: ["The disposal failed: A cause beneath it"] } ]);
    assert.equal(controller.phase, "shuttingDown", "the sequence reached its transition ahead of the disposal");
  });

  // Homebridge's listener voids what it is handed, so a stop it asked for first has no caller to read a rejection, and the line has to stand for that stop on its own.
  test("a stop that rejects after Homebridge asked first writes its line and floats nothing", async () => {

    const { api, log, platform } = buildPlatform([], [FIRST]);
    const [controller] = configuredControllers(platform);

    assert.ok(controller, "the entry carries an address and credentials, so a controller is constructed for it");

    controller.client = { [Symbol.asyncDispose]: async (): Promise<void> => {

      throw new Error("The disposal failed.", { cause: new Error("A cause beneath it.") });
    } } as unknown as ProtectClient;

    await assertNoUnhandledRejections(async (): Promise<void> => {

      api.emit(APIEvent.SHUTDOWN);

      await settle();
    });

    assert.deepEqual(log.entries, [{ level: "error", message: STOP_REJECTED, params: ["The disposal failed: A cause beneath it"] }]);
    assert.equal(controller.phase, "shuttingDown", "the sequence reached its transition ahead of the disposal");
  });

  // The controller's sweep is armed when its login rejects, and the restored orphan is what that sweep would remove.
  test("a login that really rejects past connect stops its controller, and its sweep removes nothing", async (t) => {

    const { api, controller, log, nvrConfig, platform } = rejectPastConnect(t);
    const orphan = makeTestAccessory("Orphan", "AABBCCFFFFFF");

    orphan.context = { mac: "AABBCCFFFFFF", nvr: nvrConfig.mac };
    platform.configureAccessory(orphan);

    await assertNoUnhandledRejections(async (): Promise<void> => {

      api.emit(APIEvent.DID_FINISH_LAUNCHING);

      await settleUntil(() => controller.signal.aborted, { description: "the stop" });
      await settle();
    });

    const errors = log.entries.filter(({ level }) => level === "error");

    assert.equal(errors.length, 1, "the line is said once at error");
    assert.ok(errors[0]?.message.endsWith(LOGIN_REJECTED_SENTENCE));
    assert.equal(controller.phase, "shuttingDown");
    assert.equal(controller.isAvailable, false);
    assert.ok(platform.accessories.includes(orphan), "the orphan stays, because the stop kept the sweep from running");
    assert.equal(log.entries.some(({ message }) => [ "Delaying", "Removing" ].some((word) => message.includes(word))), false, "and nothing says the sweep ran");
  });

  // A shutdown that tears a login down is our own doing, so what it rejects with is no reason to report. An aborted signal means this controller is already stopping.
  test("a login rejected once its controller's signal has aborted writes nothing", async (t) => {

    answerProbe(t);

    const { api, log, platform } = buildPlatform([], [FIRST]);
    const [controller] = configuredControllers(platform);

    t.after(() => void api.emit(APIEvent.SHUTDOWN));

    assert.ok(controller, "the entry carries an address and credentials, so a controller is constructed for it");

    let started = false;

    controller.login = async (): Promise<void> => {

      started = true;

      await once(controller.signal, "abort");

      throw new TypeError("The record is gone.");
    };

    await assertNoUnhandledRejections(async (): Promise<void> => {

      api.emit(APIEvent.DID_FINISH_LAUNCHING);

      await settleUntil(() => started, { description: "the login to start" });

      api.emit(APIEvent.SHUTDOWN);

      await settle();
    });

    assert.deepEqual(log.entries, [], "the rejection is read, and nothing is said about it");
  });
});

describe("the restore sweep", () => {

  // Nothing maintains a restored value until an owner takes the accessory over, so it refuses until then, and from the claim on it follows that owner. A characteristic
  // an owner binds late, or only ever writes, stays on the sweep's handler after the claim, which is why the sweep follows the owner rather than refusing outright.
  test("a restored accessory refuses outside its identity until an owner claims it, then follows the owner, and refuses again once released", async () => {

    const { platform } = buildPlatform([]);
    const accessory = makeTestAccessory("Restored");
    const service = accessory.addService(new Service.Switch("Restored Switch"));
    const on = service.getCharacteristic(Characteristic.On);

    service.addCharacteristic(Characteristic.ConfiguredName);
    on.updateValue(true);
    platform.configureAccessory(accessory);

    await assert.rejects(triggerGet(on), hapStatus(HAPStatus.SERVICE_COMMUNICATION_FAILURE), "an unclaimed accessory refuses");

    for(const identity of [ service.getCharacteristic(Characteristic.Name), service.getCharacteristic(Characteristic.ConfiguredName),
      accessory.getService(Service.AccessoryInformation)?.getCharacteristic(Characteristic.Manufacturer) ]) {

      assert.ok(identity, "the fixture carries the identity characteristic");

      // eslint-disable-next-line no-await-in-loop -- Each read is its own assertion.
      await assert.doesNotReject(triggerGet(identity), identity.displayName + " answers as identity");
    }

    const owner = { isAvailable: true };

    platform.claimAccessory(accessory, owner);

    assert.equal(await triggerGet(on), true, "a claimed accessory answers the value it holds");

    owner.isAvailable = false;

    await assert.rejects(triggerGet(on), hapStatus(HAPStatus.SERVICE_COMMUNICATION_FAILURE), "and refuses when its owner does");

    owner.isAvailable = true;
    assert.equal(platform.isAccessoryClaimed(accessory), true, "the claim reads as held");

    platform.releaseAccessory(accessory);

    assert.equal(platform.isAccessoryClaimed(accessory), false, "and the release lets it go");

    await assert.rejects(triggerGet(on), hapStatus(HAPStatus.SERVICE_COMMUNICATION_FAILURE), "and a released accessory has no owner to follow");
  });

  // With no set handler HAP stores a write and reports success, so a hub's write to an accessory nothing stands behind would read as done. Each write here goes through
  // HAP's own write path, which is where a refused write stores nothing.
  test("a restored accessory refuses a write and stores nothing until an owner claims it, then takes the write while its owner answers", async () => {

    const { platform } = buildPlatform([]);
    const accessory = makeTestAccessory("Restored");
    const on = accessory.addService(new Service.Switch("Restored Switch")).getCharacteristic(Characteristic.On);
    const lock = accessory.addService(new Service.LockMechanism("Restored Lock")).getCharacteristic(Characteristic.LockTargetState);

    on.updateValue(true);
    lock.updateValue(Characteristic.LockTargetState.SECURED);
    platform.configureAccessory(accessory);

    await assert.rejects(triggerSet(on, false), hapStatus(HAPStatus.SERVICE_COMMUNICATION_FAILURE), "an unclaimed accessory refuses a write");
    await assert.rejects(triggerSet(lock, Characteristic.LockTargetState.UNSECURED), hapStatus(HAPStatus.SERVICE_COMMUNICATION_FAILURE), "and so does a lock");

    assert.equal(on.value, true, "the switch holds the value it restored");
    assert.equal(lock.value, Characteristic.LockTargetState.SECURED, "and so does the lock");

    const owner = { isAvailable: true };

    platform.claimAccessory(accessory, owner);

    await assert.doesNotReject(triggerSet(on, false), "a characteristic no owner bound takes the write once its accessory is claimed");

    assert.equal(on.value, false, "and stores it");

    owner.isAvailable = false;

    await assert.rejects(triggerSet(on, true), hapStatus(HAPStatus.SERVICE_COMMUNICATION_FAILURE), "and refuses when its owner does");

    assert.equal(on.value, false, "storing nothing");

    owner.isAvailable = true;
    platform.releaseAccessory(accessory);

    await assert.rejects(triggerSet(on, true), hapStatus(HAPStatus.SERVICE_COMMUNICATION_FAILURE), "and a released accessory has no owner to follow");
  });

  // HAP holds one write handler per characteristic, so an owner's replaces the sweep's outright, and what the owner bound decides the write from then on.
  test("an owner's own write handler replaces the sweep's, and the sweep is not consulted again", async () => {

    const { platform } = buildPlatform([]);
    const accessory = makeTestAccessory("Restored");
    const on = accessory.addService(new Service.Switch("Restored Switch")).getCharacteristic(Characteristic.On);
    const writes: unknown[] = [];

    platform.configureAccessory(accessory);
    on.onSet((value) => void writes.push(value));

    await assert.doesNotReject(triggerSet(on, true), "the owner's handler answers, with no claim standing for the sweep to read");

    assert.deepEqual(writes, [true], "and it ran");
    assert.equal(on.value, true, "and HAP stored what it accepted");
  });

  // A name is the user's to edit whatever the plugin knows. HAP's own writes to a characteristic it holds, StatusActive on a camera's sensors among them, arrive through
  // the entry point a write handler sits on, so a handler on one HomeKit cannot write would swallow them, which handleSetRequest reads here directly.
  test("a name and a characteristic carrying no write permission take no write handler", async () => {

    const { platform } = buildPlatform([]);
    const accessory = makeTestAccessory("Restored");
    const sensor = accessory.addService(new Service.MotionSensor("Restored Motion"));
    const active = sensor.getCharacteristic(Characteristic.StatusActive);
    const name = sensor.addCharacteristic(Characteristic.ConfiguredName);

    active.updateValue(false);
    name.updateValue("Before");
    platform.configureAccessory(accessory);

    assert.equal(active.props.perms.includes(Perms.PAIRED_WRITE), false, "the fixture's StatusActive carries no write permission");
    assert.equal(name.props.perms.includes(Perms.PAIRED_WRITE), true, "and its name does");

    await assert.rejects(triggerGet(active), hapStatus(HAPStatus.SERVICE_COMMUNICATION_FAILURE), "StatusActive still refuses a read");
    await assert.doesNotReject(active.handleSetRequest(true), "and HAP's own write to it lands");

    assert.equal(active.value, true, "storing the value HAP wrote");

    await assert.doesNotReject(triggerSet(name, "After"), "and an unclaimed accessory's name takes the user's edit");

    assert.equal(name.value, "After", "storing it");
  });

  // HAP reuses a camera controller's restored services and serves their characteristics through getters of its own, which an onGet here would displace. StreamingStatus
  // is the exception, because HAP only ever writes it, and it is what a restored camera with nothing else to refuse answers with.
  test("a restored camera's controller services keep HAP's getters, and their StreamingStatus alone refuses", async () => {

    const { platform } = buildPlatform([]);
    const accessory = makeTestAccessory("Restored Camera");
    const stream = accessory.addService(new Service.CameraRTPStreamManagement("Stream", "0"));
    const setupEndpoints = stream.getCharacteristic(Characteristic.SetupEndpoints);
    let legacyReads = 0;

    setupEndpoints.on("get", (callback) => {

      legacyReads++;
      callback(null, "");
    });

    const controllerServices = [ stream, accessory.addService(Service.CameraRecordingManagement), accessory.addService(Service.CameraOperatingMode),
      accessory.addService(Service.DataStreamTransportManagement), accessory.addService(Service.Microphone), accessory.addService(Service.Speaker) ];

    platform.configureAccessory(accessory);

    await assert.rejects(triggerGet(stream.getCharacteristic(Characteristic.StreamingStatus)), hapStatus(HAPStatus.SERVICE_COMMUNICATION_FAILURE),
      "StreamingStatus refuses until the camera is claimed");

    const readable = controllerServices.flatMap(({ characteristics }) => characteristics)
      .filter((characteristic) => (characteristic.UUID !== Characteristic.StreamingStatus.UUID) && characteristic.props.perms.includes("pr" as never));

    assert.ok(readable.length, "the fixture carries characteristics HAP serves");

    for(const characteristic of readable) {

      // eslint-disable-next-line no-await-in-loop -- Each read is its own assertion.
      await assert.doesNotReject(triggerGet(characteristic), characteristic.displayName + " stays HAP's while the camera is unclaimed");
    }

    assert.equal(legacyReads, 1, "HAP's own getter still answers its read, undisplaced");

    let legacyWrites = 0;

    setupEndpoints.on("set", (_value, callback) => {

      legacyWrites++;
      callback(null);
    });

    await assert.doesNotReject(triggerSet(setupEndpoints, ""), "HAP's own write listener takes the write while the camera is unclaimed");

    assert.equal(legacyWrites, 1, "undisplaced");
  });

  // The global Device option decides whether a controller logs in, and has no say over the sweep: a restored accessory no owner will ever claim refuses, and stays
  // registered, so turning the plugin back on finds it where the user left it.
  test("a globally disabled plugin's restored accessories refuse and stay registered", async (t) => {

    const { api, platform } = buildPlatform(["Disable.Device"], [{ address: "10.0.0.1", password: "password", username: "username" }]);
    const [controller] = configuredControllers(platform);
    const accessory = makeTestAccessory("Restored");
    const on = accessory.addService(new Service.Switch("Restored Switch")).getCharacteristic(Characteristic.On);

    t.after(() => void api.emit(APIEvent.SHUTDOWN));

    platform.configureAccessory(accessory);

    assert.ok(controller, "the entry carries an address and credentials, so a controller is constructed for it");

    await controller.login();

    await assert.rejects(triggerGet(on), hapStatus(HAPStatus.SERVICE_COMMUNICATION_FAILURE), "the restored accessory refuses");
    assert.ok(platform.accessories.includes(accessory), "and stays registered");
  });
});
