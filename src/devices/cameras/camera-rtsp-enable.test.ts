/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * camera-rtsp-enable.test.ts: The RTSP autoconfiguration net - the write-through enable in refreshChannelProfiles (camera.ts) and its two arms, driven against the
 * REAL constructed ProtectCamera.
 *
 * The gate under test: when any channel reads isRtspEnabled false, the camera PATCHes the full channel array with RTSP enabled everywhere and defers the streaming
 * surface to the channels observer's re-run once the change reconciles (the success arm). When the controller declines the write - an account without the full
 * management role, or any other failure - the camera narrates a warn and streams from the channels that are already enabled (the degraded arm), with the zero-enabled
 * case falling through to the established "No RTSP profiles found" terminal. There is no failure latch: a later channels wake re-attempts the write.
 *
 * The exact advertised-list mathematics for the mixed regime are the resolution suite's golden-master concern (resolution.test.ts pins buildAdvertisedProfiles over
 * MIXED_RTSP_DISABLED_CHANNELS); this net asserts the device wiring - which arm ran, the exact PATCH payload, the narration, whether the delegate stood up, and that
 * the published profiles never reach into a disabled channel - through the factory double and the production selectChannel surface.
 *
 * Every constructed camera is unwound through cleanup() plus the harness abort in an afterEach, so no observe loop outlives the test.
 */
import { CAMERA_FIXTURES, G2_PRO_CHANNELS, MIXED_RTSP_DISABLED_CHANNELS } from "../../camera.fixtures.ts";
import type { Camera, ProtectCameraConfig } from "unifi-protect";
import { TestCameraProjection, TestStateStore, makeCameraConfig, makeProtectState, makeTestAccessory, makeTestNvr, settle } from "../../testing.helpers.ts";
import type { TestLogEntry, TestStreamingDelegateFactory } from "../../testing.helpers.ts";
import { afterEach, describe, test } from "node:test";
import type { CameraFixture } from "../../camera.fixtures.ts";
import type { ProtectAccessory } from "../../types.ts";
import { ProtectAuthorizationError } from "unifi-protect";
import { ProtectCamera } from "./camera.ts";
import type { ProtectNvr } from "../../nvr/nvr.ts";
import assert from "node:assert/strict";

// The authorization warn the degraded arm logs, asserted verbatim so the user-facing guidance is pinned, not paraphrased.
const AUTH_WARN = "Unable to enable RTSP on all of the camera's channels because this account does not have the full management role in UniFi Protect. " +
  "HomeKit streaming can only use channels that already have RTSP enabled. To make every streaming quality option available, grant the account the full " +
  "management role or enable RTSP on each of the camera's channels in the Protect webUI.";

// A log assertion matches a substring of entry.formatted at the given level, mirroring the established loggedAt idiom: the device logger prefixes every line with the
// device descriptor, so substring matching is the faithful comparison.
function loggedAt(entries: TestLogEntry[], level: TestLogEntry["level"], substring: string): boolean {

  return entries.some((entry) => (entry.level === level) && entry.formatted.includes(substring));
}

// Count the entries at a level carrying a substring, for the re-attempt assertions that pin cadence rather than mere presence.
function countLoggedAt(entries: TestLogEntry[], level: TestLogEntry["level"], substring: string): number {

  return entries.filter((entry) => (entry.level === level) && entry.formatted.includes(substring)).length;
}

// Resolve a named fixture from the golden-master corpus, failing loudly if the corpus ever renames it.
function fixtureByModel(model: string): CameraFixture {

  const fixture = CAMERA_FIXTURES.find((candidate) => candidate.model === model);

  assert.ok(fixture, "the golden-master corpus carries the " + model + " fixture");

  return fixture;
}

// The construction handle a test holds: the projection carries the updateCalls / updateRejection levers, the factory records delegate creation, the store drives
// observer wakes, and the controller is the per-test unwind.
interface BuiltCamera {

  camera: ProtectCamera;
  cameraConfig: ProtectCameraConfig;
  controller: AbortController;
  factory: TestStreamingDelegateFactory;
  logEntries: TestLogEntry[];
  projection: TestCameraProjection;
  store: TestStateStore;
}

// Build a REAL plain ProtectCamera against the doubles, exactly as the sibling camera suites assemble it, with the one addition this net needs: an optional
// updateRejection installed on the projection BEFORE construction, so the construction-time enable write drives the failure arm. The casts are confined to this
// constructor call - the instance is the production ProtectCamera and everything it runs is the production path.
async function buildCamera(options: { channels: ProtectCameraConfig["channels"]; updateRejection?: Error }): Promise<BuiltCamera> {

  const cameraConfig = makeCameraConfig({ channels: options.channels });
  const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
  const { controller, factory, logEntries, nvr } = makeTestNvr({ store });
  const projection = new TestCameraProjection(cameraConfig.id, store);

  projection.updateRejection = options.updateRejection ?? null;

  const accessory = makeTestAccessory("RTSP Enable Camera", "44444444-5555-6666-7777-888888888888");
  const camera = new ProtectCamera(nvr as unknown as ProtectNvr, accessory as unknown as ProtectAccessory, projection as unknown as Camera);

  // Settle the floating configure IIFE and the observe loops' lazy registration before any assertion, so the enable write and any delegate construction complete.
  await settle();

  return { camera, cameraConfig, controller, factory, logEntries, projection, store };
}

describe("RTSP autoconfiguration write-through (refreshChannelProfiles)", () => {

  // The per-test handle, torn down in afterEach so each test's per-accessory abort unwinds and no observe loop outlives the test.
  let built: BuiltCamera | undefined;

  afterEach(() => {

    built?.camera.cleanup();
    built?.controller.abort();
    built = undefined;
  });

  test("the success arm PATCHes every channel field-intact, defers the delegate, and completes through the channels observer", async () => {

    const { cameraConfig, factory, logEntries, projection, store } = built = await buildCamera({ channels: MIXED_RTSP_DISABLED_CHANNELS });

    // Exactly one write, carrying the FULL channel array: every field of every channel preserved by the spread, isRtspEnabled true throughout. The full-field deepEqual
    // pins the spread itself - a payload that dropped width/height/fps would corrupt the controller's channel config and must fail here.
    const enabledChannels = MIXED_RTSP_DISABLED_CHANNELS.map((channel) => ({ ...channel, isRtspEnabled: true }));

    assert.equal(projection.updateCalls.length, 1, "a channel needing RTSP triggers exactly one enable write");
    assert.deepEqual(projection.updateCalls[0]?.payload, { channels: enabledChannels }, "the PATCH carries the complete channel array, field-intact, RTSP-enabled");

    // The accepted write narrates nothing and defers the streaming surface to the reconcile.
    assert.equal(factory.createCalls.length, 0, "no delegate stands up until the channels observer re-runs against the reconciled state");
    assert.equal(countLoggedAt(logEntries, "warn", "Unable to enable RTSP"), 0, "an accepted enable logs no warning");

    // The controller's reconciled state arrives: every channel now reads enabled. The observer re-run builds the full advertised list - the enabled mixed regime is
    // channel-identical to the G6 Instant corpus fixture, so the golden-master expectation applies verbatim - and issues no further write.
    store.pushCameraPatch(cameraConfig.id, { channels: enabledChannels });

    await settle();

    assert.equal(factory.createCalls.length, 1, "the observer re-run stood the delegate up exactly once");
    assert.deepEqual(factory.createCalls[0]?.resolutions, fixtureByModel("G6 Instant").expected.map((entry) => entry.resolution),
      "the advertised resolutions equal the golden-master expectation for the fully-enabled channel set");
    assert.equal(projection.updateCalls.length, 1, "the fully-enabled re-run issues no redundant write");
  });

  test("an authorization failure warns with the dual remedy and streams from the already-enabled channels", async () => {

    const { camera, factory, logEntries, projection } = built =
      await buildCamera({ channels: MIXED_RTSP_DISABLED_CHANNELS, updateRejection: new ProtectAuthorizationError("forbidden") });

    // The write was attempted, declined, and narrated at warn - verbatim, so the guidance text is pinned.
    assert.equal(projection.updateCalls.length, 1, "the enable write was attempted despite the limited account");
    assert.ok(loggedAt(logEntries, "warn", AUTH_WARN), "the authorization warn carries the full dual-remedy guidance");
    assert.equal(countLoggedAt(logEntries, "error", "Unable to enable RTSP"), 0, "the degraded arm is a warn, never an error");

    // The camera streams anyway: the delegate stands up from the enabled subset, and the published profiles never reach into the disabled Medium channel. The exact
    // advertised mathematics for this regime are the resolution suite's golden-master; here we pin the wiring through the production selection surface.
    assert.equal(factory.createCalls.length, 1, "the delegate stands up from the already-enabled channels");

    const high = camera.selectChannel(3840, 2160);
    const low = camera.selectChannel(640, 360);
    const remapped = camera.selectChannel(1280, 720);

    assert.equal(high?.channel.id, 0, "the High channel's native resolution selects the High channel");
    assert.equal(low?.channel.id, 2, "the Low channel's native resolution selects the Low channel");
    assert.ok(remapped, "the disabled Medium channel's native resolution still resolves against the published profiles");
    assert.notEqual(remapped.channel.id, 1, "no published profile reaches into the RTSP-disabled channel");
  });

  test("a non-authorization failure warns with its underlying cause and proceeds identically", async () => {

    const { factory, logEntries, projection } = built =
      await buildCamera({ channels: MIXED_RTSP_DISABLED_CHANNELS, updateRejection: new Error("The controller rejected the request.") });

    assert.equal(projection.updateCalls.length, 1, "the enable write was attempted");
    assert.ok(loggedAt(logEntries, "warn",
      "Unable to enable RTSP on all of the camera's channels: The controller rejected the request. HomeKit streaming can only use channels that already have RTSP " +
      "enabled."), "the generic-failure warn renders the cause as one clean sentence");
    assert.equal(factory.createCalls.length, 1, "the degraded arm stands the delegate up from the already-enabled channels");
  });

  test("a failing write with zero enabled channels warns, reports no RTSP profiles, and stands up no delegate", async () => {

    const allDisabled = G2_PRO_CHANNELS.map((channel) => ({ ...channel, isRtspEnabled: false }));

    const { factory, logEntries, projection } = built =
      await buildCamera({ channels: allDisabled, updateRejection: new ProtectAuthorizationError("forbidden") });

    assert.equal(projection.updateCalls.length, 1, "the enable write was attempted");
    assert.ok(loggedAt(logEntries, "warn", AUTH_WARN), "the failed write narrates the authorization warn");
    assert.ok(loggedAt(logEntries, "info", "No RTSP profiles found for this camera."), "the zero-enabled terminal reports the established no-profiles guidance");
    assert.equal(factory.createCalls.length, 0, "no delegate stands up without a single RTSP-enabled channel");
  });

  test("a later channels wake re-attempts the declined write - there is no failure latch", async () => {

    const { cameraConfig, logEntries, projection, store } = built =
      await buildCamera({ channels: MIXED_RTSP_DISABLED_CHANNELS, updateRejection: new ProtectAuthorizationError("forbidden") });

    assert.equal(projection.updateCalls.length, 1, "the construction-time write was attempted once");

    // A genuine channels change arrives - the High channel's frame rate moves - while the Medium channel still reads disabled and the account is still limited. The
    // observer re-run must attempt the write again and warn again: a future "already failed" cache would break the self-heal path this test pins.
    store.pushCameraPatch(cameraConfig.id,
      { channels: MIXED_RTSP_DISABLED_CHANNELS.map((channel) => ((channel.id === 0) ? { ...channel, fps: 24 } : channel)) });

    await settle();

    assert.equal(projection.updateCalls.length, 2, "the channels wake re-attempted the enable write");
    assert.equal(countLoggedAt(logEntries, "warn", AUTH_WARN), 2, "each declined attempt narrates its own warn");
  });
});
