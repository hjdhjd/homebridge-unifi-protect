/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * stream-delegate.test.ts: Red-green coverage of the pure helpers the streaming-delegate abstractions export - the controller identity's rising edge and its one
 * derivation, and the streaming-samplerate advertisement.
 *
 * The rising edge is walked over every term of the identity, each term moved alone against an otherwise equal record, so a term the edge forgets reads as a miss. The
 * derivation is read term by term against the media host double, and both the production delegate and the stub factory are shown to capture exactly what the derivation
 * answers, so the identity a controller is built for and the identity the reconcile checks it against cannot drift apart. The samplerate table walks the doorbell and
 * capability axes.
 */
import { after, describe, test } from "node:test";
import { controllerCapabilityAppeared, controllerIdentityOf, streamingSamplerates } from "./stream-delegate.ts";
import { AudioStreamingSamplerate } from "homebridge-plugin-utils";
import type { ControllerIdentity } from "./stream-delegate.ts";
import { G2_PRO_CHANNELS } from "../camera.fixtures.ts";
import { ProtectStreamingDelegate } from "./stream.ts";
import { TestStreamingDelegateFactory } from "../testing.helpers.ts";
import assert from "node:assert/strict";
import { makeCameraConfig } from "../devices/testing.helpers.ts";
import { makeTestCameraHost } from "./testing.helpers.ts";

// Every host this suite builds holds its own makeTestNvr AbortController, aborted once at the end so no harness signal outlives the suite.
const controllers: AbortController[] = [];

after(() => {

  for(const controller of controllers) {

    controller.abort();
  }
});

// The identity with every term false, and the identity with every term true. Each is typed as the record, so a term the identity gains is a compile error here until
// both literals carry it - which is what keeps the per-term walks below exhaustive.
const NONE: ControllerIdentity = { canUseLivestreamApi: false, hksvCapable: false, isDoorbell: false, twoWayAudio: false };
const ALL: ControllerIdentity = { canUseLivestreamApi: true, hksvCapable: true, isDoorbell: true, twoWayAudio: true };

// Every term of the identity, read off the exhaustive literal above.
const TERMS = Object.keys(NONE) as (keyof ControllerIdentity)[];

describe("controllerCapabilityAppeared - the rising edge over every term", () => {

  test("each term rising from false to true on its own is an appearance", () => {

    for(const term of TERMS) {

      assert.equal(controllerCapabilityAppeared(NONE, { ...NONE, [term]: true }), true, term + " rising is an appearance");
    }
  });

  test("each term falling from true to false on its own is no appearance", () => {

    for(const term of TERMS) {

      assert.equal(controllerCapabilityAppeared(ALL, { ...ALL, [term]: false }), false, term + " falling is no appearance");
    }
  });

  test("equal identities are no appearance, with every term false and with every term true", () => {

    assert.equal(controllerCapabilityAppeared(NONE, NONE), false, "an all-false identity against itself is no appearance");
    assert.equal(controllerCapabilityAppeared(ALL, ALL), false, "an all-true identity against itself is no appearance");
  });

  // The edge asks whether any term rose, not whether the identity moved on balance: a term rising alongside another falling still warrants the rebuild that carries
  // the risen term, while the fallen one is left as it was built.
  test("each term rising while every other term falls is still an appearance", () => {

    for(const term of TERMS) {

      assert.equal(controllerCapabilityAppeared({ ...ALL, [term]: false }, { ...NONE, [term]: true }), true, term + " rising beside the others falling is an appearance");
    }
  });
});

describe("controllerIdentityOf - the one derivation of the identity", () => {

  test("reads each term from its own camera fact", () => {

    const { controller, host } = makeTestCameraHost();

    controllers.push(controller);

    // A third-party camera with no AI Port, not a doorbell, without two-way audio, and not HKSV-capable reads as every term false.
    const unreachable = makeCameraConfig({ channels: G2_PRO_CHANNELS, isThirdPartyCamera: true });

    host.ufp = unreachable;

    assert.deepEqual(controllerIdentityOf(host), NONE, "a camera with none of the capabilities reads every term false");

    // The reach term follows the livestream-API predicate over the record, and only that: an AI Port pairing gives the third-party camera reach.
    host.ufp = makeCameraConfig({ channels: G2_PRO_CHANNELS, isPairedWithAiPort: true, isThirdPartyCamera: true });

    assert.deepEqual(controllerIdentityOf(host), { ...NONE, canUseLivestreamApi: true }, "livestream-API reach raises the reach term alone");

    // The eligibility term follows the host's isHksvCapable, and only that.
    host.ufp = unreachable;
    host.isHksvCapable = true;

    assert.deepEqual(controllerIdentityOf(host), { ...NONE, hksvCapable: true }, "HKSV eligibility raises the eligibility term alone");

    // The doorbell term follows the record's featureFlags.isDoorbell, and only that.
    host.isHksvCapable = false;
    host.ufp = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { isDoorbell: true }, isThirdPartyCamera: true });

    assert.deepEqual(controllerIdentityOf(host), { ...NONE, isDoorbell: true }, "a doorbell raises the doorbell term alone");

    // The two-way audio term follows the camera's two-way audio hint, and only that.
    host.ufp = unreachable;
    host.hints.twoWayAudio = true;

    assert.deepEqual(controllerIdentityOf(host), { ...NONE, twoWayAudio: true }, "the two-way audio hint raises the two-way audio term alone");
  });

  test("the production delegate and the stub factory are each built for exactly what the derivation answers", () => {

    const { controller, host } = makeTestCameraHost();

    controllers.push(controller);

    // A first-party doorbell with two-way audio that can back HKSV: every term raised.
    host.ufp = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { isDoorbell: true } });
    host.hints.twoWayAudio = true;
    host.isHksvCapable = true;

    const expected = controllerIdentityOf(host);

    assert.deepEqual(expected, ALL, "the vacuity guard: the host raises every term, so an identity captured from fixed values would differ");
    assert.deepEqual(new ProtectStreamingDelegate(host, [[ 1920, 1080, 30 ]]).builtFor, expected, "the production delegate captured the derivation over its host");
    assert.deepEqual(new TestStreamingDelegateFactory().create(host, []).builtFor, expected, "the stub factory captured the same derivation over the same host");
  });
});

describe("streamingSamplerates - the doorbell and capability axes", () => {

  test("a doorbell advertises both 16 and 24 kHz in every population", () => {

    assert.deepEqual(streamingSamplerates({ canUseLivestreamApi: true, isDoorbell: true }),
      [ AudioStreamingSamplerate.KHZ_16, AudioStreamingSamplerate.KHZ_24 ]);
    assert.deepEqual(streamingSamplerates({ canUseLivestreamApi: false, isDoorbell: true }),
      [ AudioStreamingSamplerate.KHZ_16, AudioStreamingSamplerate.KHZ_24 ]);
  });

  // The capability, not the user's transport preference, is what decides: a camera that can reach the livestream API may serve any given session from the 16 kHz buffer
  // track whatever the toggle says, so it advertises only what every one of its sessions can actually deliver.
  test("a non-doorbell that can reach the livestream API advertises just 16 kHz", () => {

    assert.equal(streamingSamplerates({ canUseLivestreamApi: true, isDoorbell: false }), AudioStreamingSamplerate.KHZ_16);
  });

  test("a non-doorbell that cannot reach the livestream API is RTSP-served and advertises both 16 and 24 kHz", () => {

    assert.deepEqual(streamingSamplerates({ canUseLivestreamApi: false, isDoorbell: false }),
      [ AudioStreamingSamplerate.KHZ_16, AudioStreamingSamplerate.KHZ_24 ]);
  });
});
