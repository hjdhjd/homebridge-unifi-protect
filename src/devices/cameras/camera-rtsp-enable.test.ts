/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * camera-rtsp-enable.test.ts: The RTSP autoconfiguration net - the narrowed write-through enable in the camera's derivation (camera.ts) and its arms, driven against
 * the REAL constructed ProtectCamera.
 *
 * The contract under test: RTSP is enabled on a camera's behalf ONLY where the configuration genuinely streams over RTSP - live views drawn directly over RTSP, a
 * direct-RTSP quality pin, or the RTSP-debug buffer feed. Everything else reaches the camera through the livestream API, which serves any channel whether or not RTSP
 * is enabled on it, so a default-config camera issues no write at all and advertises every sane primary channel. When a configuration does need RTSP and the controller
 * declines the write - an account without the full management role, or any other failure - the camera narrates a warn and carries on, with its direct-RTSP selection
 * confined to the channels that are actually enabled. There is no failure latch: a later channels wake re-attempts the write.
 *
 * The terminals are asserted independently: a camera reporting no primary channels at all declines to advertise, while a camera with every channel RTSP-disabled, a
 * third-party camera included, advertises and is served through the livestream API.
 *
 * The exact advertised-list mathematics for the mixed regime are the resolution suite's golden-master concern (resolution.test.ts pins buildAdvertisedProfiles over
 * MIXED_RTSP_DISABLED_CHANNELS); this net asserts the device wiring - which arm ran, the exact PATCH payload, the narration, whether the delegate stood up, and which
 * channel each production selector resolves to - through the factory double and the production selection surface.
 *
 * Every constructed camera is unwound through cleanup() plus the harness abort in an afterEach, so no observe loop outlives the test.
 */
import { AI_PRO_CHANNELS, CAMERA_FIXTURES, G2_PRO_CHANNELS, G6_PRO_ENTRY_CHANNELS, MIXED_RTSP_DISABLED_CHANNELS, makeChannel } from "../../camera.fixtures.ts";
import type { Camera, ProtectCameraConfig } from "unifi-protect";
import { TestCameraProjection, makeCameraConfig } from "../testing.helpers.ts";
import { TestStateStore, makeProtectState, makeTestAccessory } from "../../testing.helpers.ts";
import { afterEach, describe, test } from "node:test";
import { logCount, loggedAt, settle } from "homebridge-plugin-utils/testing";
import type { CameraFixture } from "../../camera.fixtures.ts";
import { PACKAGE_CHANNEL_NAME } from "../../media/resolution.ts";
import { ProtectAuthorizationError } from "unifi-protect";
import { ProtectCamera } from "./camera.ts";
import type { ProtectNvr } from "../../nvr/nvr.ts";
import type { TestLogEntry } from "homebridge-plugin-utils/testing";
import type { TestStreamingDelegateFactory } from "../../testing.helpers.ts";
import assert from "node:assert/strict";
import { configured } from "../device-base.ts";
import { makeTestNvr } from "../../nvr/testing.helpers.ts";

// The authorization warn the degraded arm logs, asserted verbatim so the user-facing guidance is pinned, not paraphrased.
const AUTH_WARN = "Unable to enable RTSP on all of the camera's channels because this account does not have the full management role in UniFi Protect. " +
  "Direct RTSP streaming can only use channels that already have RTSP enabled. To make every streaming quality option available, grant the account the full " +
  "management role or enable RTSP on each of the camera's channels in the Protect webUI.";

// The feature option that switches live views to direct RTSP, which is what puts a camera in the population that genuinely needs the enable write.
const TOGGLE_OFF = ["Disable.Video.Timeshift.Livestream"];

// Resolve a named fixture from the golden-master corpus, failing loudly if the corpus ever renames it.
function fixtureByModel(model: string): CameraFixture {

  const fixture = CAMERA_FIXTURES.find((candidate) => candidate.model === model);

  assert.ok(fixture, "the golden-master corpus carries the " + model + " fixture");

  return fixture;
}

// Every channel of a set, RTSP-disabled - the regime a default-config controller now leaves untouched.
function allDisabled(channels: ProtectCameraConfig["channels"]): ProtectCameraConfig["channels"] {

  return channels.map((channel) => ({ ...channel, isRtspEnabled: false }));
}

// The construction handle a test holds: the projection carries the updateCalls / updateRejection levers, the factory records delegate creation, the store drives
// observer wakes, and the controller is the per-test unwind.
interface BuiltCamera {

  camera: ProtectCamera;
  cameraConfig: ProtectCameraConfig;
  controller: AbortController;
  factory: TestStreamingDelegateFactory;
  logEntries: readonly TestLogEntry[];
  projection: TestCameraProjection;
  store: TestStateStore;
}

/* Build a REAL plain ProtectCamera against the doubles, exactly as the sibling camera suites assemble it, with the additions this net needs: an optional updateRejection
 * installed on the projection BEFORE construction so the construction-time enable write drives the failure arm, the feature-option strings that decide whether the
 * configuration needs RTSP at all, the third-party marker, so a row can show that a third-party camera follows the same rule as every other camera, and a gate that holds
 * the write until a row opens it, so a stop can land while the write is in flight. The casts are confined to this constructor call - the instance is the production
 * ProtectCamera and everything it runs is the production path.
 */
async function buildCamera(options: { channels: ProtectCameraConfig["channels"]; isThirdPartyCamera?: boolean; updateGate?: Promise<void>; updateRejection?: Error;
  userOptions?: string[]; }): Promise<BuiltCamera> {

  const cameraConfig = makeCameraConfig({ channels: options.channels, isThirdPartyCamera: options.isThirdPartyCamera });
  const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
  const { controller, factory, logEntries, nvr } = makeTestNvr({ store, userOptions: options.userOptions });
  const projection = new TestCameraProjection(cameraConfig.id, store);

  projection.updateRejection = options.updateRejection ?? null;

  if(options.updateGate) {

    const { updateGate } = options;
    const answer = projection.update.bind(projection);

    projection.update = async (payload: unknown): Promise<TestCameraProjection> => {

      await updateGate;

      return answer(payload);
    };
  }

  const accessory = makeTestAccessory("RTSP Enable Camera", cameraConfig.mac);
  const camera = configured(new ProtectCamera(nvr as unknown as ProtectNvr, accessory, projection as unknown as Camera));

  // Settle the floating configure IIFE and the observe loops' lazy registration before any assertion, so the enable write and any delegate construction complete.
  await settle();

  return { camera, cameraConfig, controller, factory, logEntries, projection, store };
}

describe("RTSP autoconfiguration write-through (deriveAdvertisedStreams)", () => {

  // The per-test handle, torn down in afterEach so each test's per-accessory abort unwinds and no observe loop outlives the test.
  let built: BuiltCamera | undefined;

  afterEach(() => {

    built?.camera.cleanup();
    built?.controller.abort();
    built = undefined;
  });

  test("a default-config camera issues no write, advertises every sane channel, and confines direct-RTSP selection to the enabled ones", async () => {

    const { camera, factory, logEntries, projection } = built = await buildCamera({ channels: MIXED_RTSP_DISABLED_CHANNELS });

    // Nothing about this configuration streams over RTSP, so the camera never touches the controller's channel config and never defers its own surface behind a write.
    assert.equal(projection.updateCalls.length, 0, "a default-config camera issues no enable write at all");
    assert.equal(logCount(logEntries, "warn", "Unable to enable RTSP"), 0, "a camera that never writes narrates no failure");
    assert.equal(factory.createCalls.length, 1, "the delegate stands up immediately, with no write to wait on");

    // Every sane primary channel is advertised, RTSP-disabled Medium included - the mixed regime is channel-identical to the G6 Instant corpus fixture, so its
    // golden-master expectation applies verbatim.
    assert.deepEqual(factory.createCalls[0]?.resolutions, fixtureByModel("G6 Instant").expected.map((entry) => entry.resolution),
      "the advertised resolutions equal the golden-master expectation for the full channel set");

    // The direct-RTSP selector still answers from the enabled subset alone: the Medium channel's own native resolution resolves to Low, the nearest enabled entry
    // below the request. Asserting the resolved identity (not merely "not Medium") is what fails a wrong-but-enabled selection too.
    assert.equal(camera.selectChannel(1280, 720)?.channel.id, 2, "the direct-RTSP selection lands on the Low channel exactly");
    assert.equal(camera.hasRtspStream, true, "the camera has RTSP-enabled streams to dial");
  });

  test("the substrate selector reads the full published list while direct RTSP reads only the enabled subset", async () => {

    // Only Low is RTSP-enabled; High and Medium are not.
    const { camera } = built = await buildCamera({ channels: AI_PRO_CHANNELS.map((channel) => ((channel.id === 2) ? channel : { ...channel, isRtspEnabled: false })) });

    assert.equal(camera.hasRtspStream, true, "one enabled channel is enough to report an RTSP stream");
    assert.equal(camera.selectChannel(3840, 2160)?.channel.id, 2, "the direct-RTSP selection falls to Low, the only enabled channel");
    assert.equal(camera.selectSubstrateChannel()?.channel.id, 0, "the buffer substrate takes High, the highest channel in the full published list");
  });

  test("the substrate pin reaches an RTSP-disabled channel while the direct-RTSP pin misses it", async () => {

    // The substrate pin selects over the full published list, so it reaches the RTSP-disabled Medium channel that feeds the buffer perfectly well over the API.
    const substratePinned = await buildCamera({ channels: MIXED_RTSP_DISABLED_CHANNELS, userOptions: ["Enable.Video.Timeshift.Only=Medium"] });

    built = substratePinned;

    assert.equal(substratePinned.projection.updateCalls.length, 0, "a substrate pin is served over the livestream API and triggers no enable write");
    assert.equal(substratePinned.camera.selectSubstrateChannel()?.channel.id, 1, "the substrate pin resolves to the RTSP-disabled Medium channel");

    substratePinned.camera.cleanup();
    substratePinned.controller.abort();

    /* The direct-RTSP pin is the opposite case, and its arrangement matters: the pin term alone makes the write necessary here (the toggle is on and the debug flag
     * off), so the write must be declined for the derivation to proceed from the mixed state at all - an unhandled write would defer the surface forever.
     */
    const { camera, projection } = built = await buildCamera({ channels: MIXED_RTSP_DISABLED_CHANNELS,
      updateRejection: new ProtectAuthorizationError("forbidden"), userOptions: ["Enable.Video.Rtsp.Only=Medium"] });

    assert.equal(projection.updateCalls.length, 1, "the direct-RTSP quality pin alone makes the enable write necessary");
    assert.ok(camera.selectSubstrateChannel(), "the published list genuinely exists, so the pin miss below is a real miss rather than an empty list");
    assert.equal(camera.selectChannel(1280, 720), null, "the direct-RTSP pin misses a channel that is not RTSP-enabled");
  });

  /* The preset rows. Each pin registers a tier as its catalog default - High for the timeshift buffer, Medium for direct RTSP - so an enable that stores no tier
   * resolves that tier rather than collapsing to no pin at all. These read camera.hints directly, because the timeshift preset selects the very channel the unpinned
   * substrate policy computes on its own, and only the hint tells a preset apart from an absent pin. Every direct-RTSP half is arranged the way the stored-tier row
   * above is: the pin alone makes the enable write necessary, so the write must be declined for the derivation to proceed from the mixed state rather than deferring
   * the streaming surface behind a write that never lands.
   */
  test("either pin enabled with no stored tier resolves the preset its catalog entry registers", async () => {

    const substratePinned = await buildCamera({ channels: MIXED_RTSP_DISABLED_CHANNELS, userOptions: ["Enable.Video.Timeshift.Only"] });

    built = substratePinned;

    assert.equal(substratePinned.camera.hints.substrateDefault, "HIGH", "a bare timeshift enable resolves the High preset");
    assert.equal(substratePinned.camera.selectSubstrateChannel()?.channel.id, 0, "the preset steers the substrate selection to the High channel");

    substratePinned.camera.cleanup();
    substratePinned.controller.abort();

    const { camera, projection } = built = await buildCamera({ channels: MIXED_RTSP_DISABLED_CHANNELS,
      updateRejection: new ProtectAuthorizationError("forbidden"), userOptions: ["Enable.Video.Rtsp.Only"] });

    assert.equal(camera.hints.rtspDefault, "MEDIUM", "a bare direct-RTSP enable resolves the Medium preset");
    assert.equal(projection.updateCalls.length, 1, "the preset is a pin like any other, so it makes the enable write necessary");
    assert.equal(camera.selectChannel(1280, 720), null, "the preset pin misses the Medium channel, which is not RTSP-enabled");
  });

  /* A hand-authored "Enable.<option>=" is the other enable form, and it lands on the same preset: the engine reads an empty stored payload on an option holding a
   * single value as unspecified rather than as a choice, so it resolves onward exactly as a bare enable does. This row is what surfaces a change to that engine
   * contract here rather than in the field.
   */
  test("an explicitly emptied pin resolves the same preset a bare enable does", async () => {

    const substratePinned = await buildCamera({ channels: MIXED_RTSP_DISABLED_CHANNELS, userOptions: ["Enable.Video.Timeshift.Only="] });

    built = substratePinned;

    assert.equal(substratePinned.camera.hints.substrateDefault, "HIGH", "the emptied timeshift pin resolves the High preset");

    substratePinned.camera.cleanup();
    substratePinned.controller.abort();

    const { camera } = built = await buildCamera({ channels: MIXED_RTSP_DISABLED_CHANNELS,
      updateRejection: new ProtectAuthorizationError("forbidden"), userOptions: ["Enable.Video.Rtsp.Only="] });

    assert.equal(camera.hints.rtspDefault, "MEDIUM", "the emptied direct-RTSP pin resolves the Medium preset");
  });

  // Disabling the option is how a configuration says it wants no pin, and a configuration that never mentions the pin at all says the same thing, since neither pin
  // is on by default. Both readings must reach the hints unset - a preset leaking into either one would pin every camera in the field.
  test("a disabled pin and an unmentioned pin both resolve no tier at all", async () => {

    const disabled = await buildCamera({ channels: MIXED_RTSP_DISABLED_CHANNELS,
      userOptions: [ "Disable.Video.Rtsp.Only", "Disable.Video.Timeshift.Only" ] });

    built = disabled;

    assert.equal(disabled.camera.hints.rtspDefault, undefined, "the disabled direct-RTSP pin names no tier");
    assert.equal(disabled.camera.hints.substrateDefault, undefined, "the disabled timeshift pin names no tier");

    disabled.camera.cleanup();
    disabled.controller.abort();

    const { camera, projection } = built = await buildCamera({ channels: MIXED_RTSP_DISABLED_CHANNELS });

    assert.equal(camera.hints.rtspDefault, undefined, "a default-config camera pins no direct-RTSP tier");
    assert.equal(camera.hints.substrateDefault, undefined, "a default-config camera pins no timeshift tier");
    assert.equal(projection.updateCalls.length, 0, "and it still issues no enable write, since nothing pins a channel");
  });

  // A tier the configuration stores outranks the preset outright. Both halves store a tier the preset is not, so a resolution that fell back would be visible.
  test("a stored tier resolves ahead of the preset", async () => {

    const substratePinned = await buildCamera({ channels: MIXED_RTSP_DISABLED_CHANNELS, userOptions: ["Enable.Video.Timeshift.Only=Low"] });

    built = substratePinned;

    assert.equal(substratePinned.camera.hints.substrateDefault, "LOW", "the stored Low tier resolves rather than the High preset");
    assert.equal(substratePinned.camera.selectSubstrateChannel()?.channel.id, 2, "the stored tier steers the substrate to the Low channel");

    substratePinned.camera.cleanup();
    substratePinned.controller.abort();

    const { camera } = built = await buildCamera({ channels: MIXED_RTSP_DISABLED_CHANNELS,
      updateRejection: new ProtectAuthorizationError("forbidden"), userOptions: ["Enable.Video.Rtsp.Only=High"] });

    assert.equal(camera.hints.rtspDefault, "HIGH", "the stored High tier resolves rather than the Medium preset");
  });

  /* A stored tier matches the tier table without regard to casing and answers in the table's own spelling, which is the spelling the runtime steers on. The preset
   * never stands in for a stored tier - it answers a pin that stores nothing at all - so a casing the table failed to match would pin nothing here rather than
   * quietly resolving the preset, and both halves would read as a miss.
   */
  test("a stored tier in a different casing still names its tier", async () => {

    const substratePinned = await buildCamera({ channels: MIXED_RTSP_DISABLED_CHANNELS, userOptions: ["Enable.Video.Timeshift.Only=high"] });

    built = substratePinned;

    assert.equal(substratePinned.camera.hints.substrateDefault, "HIGH", "the lowercase spelling names the High tier");
    assert.equal(substratePinned.camera.selectSubstrateChannel()?.channel.id, 0, "the folded tier steers the substrate to the High channel");

    substratePinned.camera.cleanup();
    substratePinned.controller.abort();

    const { camera } = built = await buildCamera({ channels: MIXED_RTSP_DISABLED_CHANNELS,
      updateRejection: new ProtectAuthorizationError("forbidden"), userOptions: ["Enable.Video.Rtsp.Only=high"] });

    assert.equal(camera.hints.rtspDefault, "HIGH", "the lowercase spelling names the High tier, and not the Medium preset");
  });

  /* Each pin is a single declaration - its own copy says to choose exactly one tier - so the whole stored text is the one candidate the tier table is asked for. A
   * hand-edited payload naming several tiers, and the wildcard that stands for a picker's entire domain, are both values the table does not carry, so each pins
   * nothing at all rather than being guessed at.
   */
  test("a multi-tier payload and the wildcard each pin no tier at all", async () => {

    const substratePinned = await buildCamera({ channels: MIXED_RTSP_DISABLED_CHANNELS, userOptions: ["Enable.Video.Timeshift.Only=High,Medium"] });

    built = substratePinned;

    assert.equal(substratePinned.camera.hints.substrateDefault, undefined, "a payload naming two tiers names none of them");
    assert.equal(substratePinned.camera.selectSubstrateChannel()?.channel.id, 0, "the substrate policy computes its own answer, exactly as it does for an " +
      "unpinned camera");

    substratePinned.camera.cleanup();
    substratePinned.controller.abort();

    const { camera, projection } = built = await buildCamera({ channels: MIXED_RTSP_DISABLED_CHANNELS, userOptions: ["Enable.Video.Rtsp.Only=*"] });

    assert.equal(camera.hints.rtspDefault, undefined, "the wildcard names no single tier");
    assert.equal(projection.updateCalls.length, 0, "and nothing pins a channel, so the camera issues no enable write");
  });

  /* A family still carrying retired entries resolves through the overlay, and no preset reaches it: the retired grammar said "pin" by naming a tier, so an entry
   * that names none pins none. The witness is a retired entry that turns a tier OFF at this camera - it puts the family on the overlay while selecting nothing - so a
   * preset leaking onto the overlay path would read as a High pin here instead of no pin.
   */
  test("a retired-overlaid family resolves through the overlay and never gains a preset", async () => {

    const { camera } = built = await buildCamera({ channels: MIXED_RTSP_DISABLED_CHANNELS,
      userOptions: ["Disable.Video.Timeshift.Only.High.74ACB9000001"] });

    assert.equal(camera.hints.substrateDefault, undefined, "the overlaid family selects nothing, and the preset does not fill in behind it");
    assert.equal(camera.selectSubstrateChannel()?.channel.id, 0, "the substrate policy computes its own answer, exactly as it does for an unpinned camera");
  });

  /* An overlaid empty selection names no tier, asserted where the engine alone would resolve one. The controller carries the retired High entry and this camera
   * turns it off, so the overlay answers the empty selection while the engine's own reading inherits the controller's High, and a camera that fell through to the
   * engine on an empty overlay answer would name the High tier here. While the overlay answers, the camera also skips its stored read: a camera that read it would
   * find the controller's High beside an empty selection and set it aside as an unrecognized quality. That narration is a debug line. The camera-scoped Log.Debug
   * entry opens this camera's debug gate, and HBPU routes a debug line through the gate to warn, so the row counts the narration at warn. The declined enable write
   * is what lets the tier assertion fail: a camera that named the High tier would need RTSP enabled, and the projection double records an accepted write without
   * applying it, so the derivation would return before it set the hint and the row would read undefined either way.
   */
  test("an overlaid empty selection names no tier and skips the stored read, where the engine alone would resolve the controller's High", async () => {

    const { camera, logEntries } = built = await buildCamera({ channels: MIXED_RTSP_DISABLED_CHANNELS, updateRejection: new ProtectAuthorizationError("forbidden"),
      userOptions: [ "Enable.Log.Debug.74ACB9000001", "Enable.Video.Rtsp.Only.High.74ACB9FFFFFF", "Disable.Video.Rtsp.Only.High.74ACB9000001" ] });

    assert.equal(camera.hints.rtspDefault, undefined, "the overlay's empty answer names no tier, and the controller's High does not fill in behind it");
    assert.equal(logCount(logEntries, "warn", "Ignoring an unrecognized stream quality"), 0,
      "the camera skips its stored read while the overlay answers, so no quality is set aside");
  });

  /* The end-to-end translation proof, written in the retired per-tier grammar a long-lived configuration still carries, one row per pin family. Both literals are
   * DEVICE-SCOPED on purpose: a scoped retired entry registers a key that addresses no current option at all, so the feature-option engine reading the raw array
   * resolves nothing from it. A global literal would slip through on the engine's own incidental reading and prove nothing about the translation.
   * These rows are here to prove that a configuration nobody has opened the settings page on still steers as it did.
   */
  test("a device-scoped pin in the retired per-tier grammar still steers both selectors", async () => {

    const substratePinned = await buildCamera({ channels: MIXED_RTSP_DISABLED_CHANNELS, userOptions: ["Enable.Video.Timeshift.Only.Medium.74ACB9000001"] });

    built = substratePinned;

    assert.equal(substratePinned.camera.selectSubstrateChannel()?.channel.id, 1, "the retired timeshift pin resolves to the RTSP-disabled Medium channel");

    substratePinned.camera.cleanup();
    substratePinned.controller.abort();

    // The direct-RTSP half, arranged exactly as the canonical row above is: the pin term alone makes the enable write necessary, and the write is declined so the
    // derivation proceeds from the mixed state rather than deferring the surface forever.
    const { camera, projection } = built = await buildCamera({ channels: MIXED_RTSP_DISABLED_CHANNELS,
      updateRejection: new ProtectAuthorizationError("forbidden"), userOptions: ["Enable.Video.Rtsp.Only.Medium.74ACB9000001"] });

    assert.equal(projection.updateCalls.length, 1, "the retired direct-RTSP pin alone makes the enable write necessary");
    assert.equal(camera.selectChannel(1280, 720), null, "the retired direct-RTSP pin misses a channel that is not RTSP-enabled");
  });

  test("a direct-RTSP configuration PATCHes every channel field-intact, defers the delegate, and completes through the channels observer", async () => {

    const { cameraConfig, factory, logEntries, projection, store } = built =
      await buildCamera({ channels: MIXED_RTSP_DISABLED_CHANNELS, userOptions: TOGGLE_OFF });

    // Exactly one write, carrying the FULL channel array: every field of every channel preserved by the spread, isRtspEnabled true throughout. The full-field deepEqual
    // pins the spread itself - a payload that dropped width/height/fps would corrupt the controller's channel config and must fail here.
    const enabledChannels = MIXED_RTSP_DISABLED_CHANNELS.map((channel) => ({ ...channel, isRtspEnabled: true }));

    assert.equal(projection.updateCalls.length, 1, "a direct-RTSP camera needing RTSP triggers exactly one enable write");
    assert.deepEqual(projection.updateCalls[0]?.payload, { channels: enabledChannels }, "the PATCH carries the complete channel array, field-intact, RTSP-enabled");

    // The accepted write narrates nothing and defers the streaming surface to the reconcile.
    assert.equal(factory.createCalls.length, 0, "no delegate stands up until the channels observer re-runs against the reconciled state");
    assert.equal(logCount(logEntries, "warn", "Unable to enable RTSP"), 0, "an accepted enable logs no warning");

    // The controller's reconciled state arrives: every channel now reads enabled. The observer re-run stands the delegate up and issues no further write.
    store.pushCameraPatch(cameraConfig.id, { channels: enabledChannels });

    await settle();

    assert.equal(factory.createCalls.length, 1, "the observer re-run stood the delegate up exactly once");
    assert.equal(projection.updateCalls.length, 1, "the fully-enabled re-run issues no redundant write");
  });

  test("an authorization failure warns with the dual remedy and streams from the already-enabled channels", async () => {

    const { camera, factory, logEntries, projection } = built =
      await buildCamera({ channels: MIXED_RTSP_DISABLED_CHANNELS, updateRejection: new ProtectAuthorizationError("forbidden"), userOptions: TOGGLE_OFF });

    // The write was attempted, declined, and narrated at warn - verbatim, so the guidance text is pinned.
    assert.equal(projection.updateCalls.length, 1, "the enable write was attempted despite the limited account");
    assert.ok(loggedAt(logEntries, "warn", AUTH_WARN), "the authorization warn carries the full dual-remedy guidance");
    assert.equal(logCount(logEntries, "error", "Unable to enable RTSP"), 0, "the degraded arm is a warn, never an error");

    // The camera streams anyway: the delegate stands up, and the direct-RTSP selection resolves within the enabled subset.
    assert.equal(factory.createCalls.length, 1, "the delegate stands up from the already-enabled channels");
    assert.equal(camera.selectChannel(3840, 2160)?.channel.id, 0, "the High channel's native resolution selects the High channel");
    assert.equal(camera.selectChannel(640, 360)?.channel.id, 2, "the Low channel's native resolution selects the Low channel");
    assert.equal(camera.selectChannel(1280, 720)?.channel.id, 2, "the disabled Medium channel's native resolution resolves to Low, the nearest enabled entry");
  });

  test("a non-authorization failure warns with its underlying cause and proceeds identically", async () => {

    const { factory, logEntries, projection } = built =
      await buildCamera({ channels: MIXED_RTSP_DISABLED_CHANNELS, updateRejection: new Error("The controller rejected the request."), userOptions: TOGGLE_OFF });

    assert.equal(projection.updateCalls.length, 1, "the enable write was attempted");
    assert.ok(loggedAt(logEntries, "warn",
      "Unable to enable RTSP on all of the camera's channels: The controller rejected the request. Direct RTSP streaming can only use channels that already have RTSP " +
      "enabled."), "the generic-failure warn renders the cause as one clean sentence");
    assert.equal(factory.createCalls.length, 1, "the degraded arm stands the delegate up from the already-enabled channels");
  });

  // A stop disposes the client, which rejects a write still in flight. The controller declined nothing, so there is nothing to warn about, and deriving past it would say
  // recordings use a stand-in format with nothing recording.
  test("an enable write that rejects after the observe signal aborts writes no line and derives nothing", async () => {

    const { promise, resolve }: PromiseWithResolvers<void> = Promise.withResolvers();
    const { controller, factory, logEntries, projection } = built = await buildCamera({ channels: MIXED_RTSP_DISABLED_CHANNELS, updateGate: promise,
      updateRejection: new Error("The client is destroyed."), userOptions: TOGGLE_OFF });
    const lines = logEntries.length;

    controller.abort();
    resolve();

    await settle();

    assert.equal(projection.updateCalls.length, 1, "the write was in flight when the signal aborted");
    assert.deepEqual(logEntries.slice(lines), [], "the rejection is read, and nothing is said about it");
    assert.equal(factory.createCalls.length, 0, "and nothing derives past it");
  });

  test("a third-party camera with every channel RTSP-disabled stands its delegate up under default config, writing nothing and declining nothing", async () => {

    const { factory, logEntries, projection } = built = await buildCamera({ channels: allDisabled(G2_PRO_CHANNELS), isThirdPartyCamera: true });

    assert.equal(projection.updateCalls.length, 0, "nothing needs RTSP, so no enable write is attempted");
    assert.equal(logCount(logEntries, "info", "none of its channels have a usable RTSP stream enabled"), 0, "no line declines to advertise the camera");
    assert.equal(factory.createCalls.length, 1, "the third-party camera stands its delegate up, served through the livestream API");
  });

  test("a camera with every channel RTSP-disabled stands its delegate up under default config - the headline inversion", async () => {

    const { camera, factory, projection } = built = await buildCamera({ channels: allDisabled(G2_PRO_CHANNELS) });

    assert.equal(projection.updateCalls.length, 0, "nothing needs RTSP, so no write is attempted");
    assert.equal(factory.createCalls.length, 1, "the camera advertises and stands its delegate up with zero RTSP-enabled channels");
    assert.equal(camera.hasRtspStream, false, "the camera honestly reports that it has no RTSP stream to dial");
    assert.equal(camera.selectChannel(1920, 1080), null, "the direct-RTSP selector answers nothing, since nothing is enabled");
    assert.ok(camera.selectSubstrateChannel(), "the buffer substrate resolves anyway - the livestream API serves the channel regardless");
  });

  test("a toggle-off camera with every channel RTSP-disabled still advertises, its live views degrading to the buffer", async () => {

    const { camera, factory, logEntries, projection } = built = await buildCamera({ channels: allDisabled(G2_PRO_CHANNELS),
      updateRejection: new ProtectAuthorizationError("forbidden"), userOptions: TOGGLE_OFF });

    assert.equal(projection.updateCalls.length, 1, "the direct-RTSP configuration attempted the enable write");
    assert.ok(loggedAt(logEntries, "warn", AUTH_WARN), "the declined write narrates the authorization warn");

    // A direct-RTSP preference the camera cannot honor is not a reason to hide it: HomeKit Secure Video, snapshots, and buffer-served live views all stay reachable.
    assert.equal(factory.createCalls.length, 1, "the toggle-off camera advertises anyway");
    assert.equal(camera.hasRtspStream, false, "there is still nothing to dial directly");
    assert.ok(camera.selectSubstrateChannel(), "the buffer substrate resolves, so the buffer, HKSV, and snapshots all have a channel");
  });

  test("a later channels wake re-attempts the declined write - there is no failure latch", async () => {

    const { cameraConfig, logEntries, projection, store } = built =
      await buildCamera({ channels: MIXED_RTSP_DISABLED_CHANNELS, updateRejection: new ProtectAuthorizationError("forbidden"), userOptions: TOGGLE_OFF });

    assert.equal(projection.updateCalls.length, 1, "the construction-time write was attempted once");

    // A genuine channels change arrives - the High channel's frame rate moves - while the Medium channel still reads disabled and the account is still limited. The
    // observer re-run must attempt the write again and warn again: a future "already failed" cache would break the self-heal path this test pins.
    store.pushCameraPatch(cameraConfig.id,
      { channels: MIXED_RTSP_DISABLED_CHANNELS.map((channel) => ((channel.id === 0) ? { ...channel, fps: 24 } : channel)) });

    await settle();

    assert.equal(projection.updateCalls.length, 2, "the channels wake re-attempted the enable write");
    assert.equal(logCount(logEntries, "warn", AUTH_WARN), 2, "each declined attempt narrates its own warn");
  });

  test("a camera reporting only a package channel reports no usable video channels and stands up nothing", async () => {

    const { factory, logEntries, projection } = built =
      await buildCamera({ channels: [makeChannel({ fps: 15, height: 1200, id: 0, name: PACKAGE_CHANNEL_NAME, width: 1600 })] });

    assert.ok(loggedAt(logEntries, "info", "No usable video channels were found for this camera."), "the zero-primary-channel terminal says what it found");
    assert.equal(projection.updateCalls.length, 0, "the terminal is reached without any write attempt");
    assert.equal(factory.createCalls.length, 0, "a camera with no primary channel stands up no delegate");
  });
});

/* The package camera's own split: advertisement and the buffer substrate turn on the package channel's EXISTENCE, while its direct-RTSP view turns on the channel's
 * RTSP flag. The pin runs both directions across a live flag flip, so a hardcoded answer on either member cannot pass.
 */
describe("package camera: existence advertises, the RTSP flag gates only the direct view", () => {

  const controllers: AbortController[] = [];

  afterEach(() => {

    for(const controller of controllers) {

      controller.abort();
    }

    controllers.length = 0;
  });

  test("an RTSP-disabled package channel advertises and buffers, and its direct view opens the moment the flag flips on", async () => {

    // The full G6 Pro Entry channel set with the package channel's RTSP switched off - the regime a default-config controller now leaves exactly as it found it.
    const channels = G6_PRO_ENTRY_CHANNELS.map((channel) => ((channel.name === PACKAGE_CHANNEL_NAME) ? { ...channel, isRtspEnabled: false } : channel));
    const cameraConfig = makeCameraConfig({ channels, featureFlags: { hasPackageCamera: true, isDoorbell: true }, name: "Front Door" });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { controller, nvr } = makeTestNvr({ store });

    controllers.push(controller);

    const doorbell = configured(new ProtectCamera(nvr as unknown as ProtectNvr, makeTestAccessory("Front Door", "74ACB9000003"),
      new TestCameraProjection(cameraConfig.id, store) as unknown as Camera));

    await settle();

    const packageCamera = doorbell.packageCamera;

    assert.ok(packageCamera, "the package camera was composed");

    // Advertisement and the buffer substrate both live: the livestream API serves the package channel whether or not RTSP is enabled on it.
    assert.ok(packageCamera.deriveAdvertisedStreams(), "the package advertises from the channel's existence alone");
    assert.ok(packageCamera.selectSubstrateChannel(), "the buffer substrate resolves the package channel");
    assert.equal(packageCamera.selectChannel(), null, "the direct-RTSP view answers nothing while the channel's RTSP is off");
    assert.equal(packageCamera.hasRtspStream, false, "the package honestly reports no RTSP stream to dial");

    // The admin enables RTSP on the package channel. Both RTSP-facing members must move together.
    store.pushCameraPatch(cameraConfig.id, { channels: G6_PRO_ENTRY_CHANNELS });

    await settle();

    assert.ok(packageCamera.selectChannel(), "the direct-RTSP view opens once the channel's RTSP is enabled");
    assert.equal(packageCamera.hasRtspStream, true, "the package reports the RTSP stream it now has");

    doorbell.cleanup();

    await settle();
  });
});
