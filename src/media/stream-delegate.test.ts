/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * stream-delegate.test.ts: Red-green coverage of the pure helpers the streaming-delegate abstractions export - the controller identity's rising edge and its one
 * derivation, the streaming-samplerate advertisement, and the recording audio format helpers.
 *
 * The rising edge is walked over every term of the identity, each term moved alone against an otherwise equal record, so a term the edge forgets reads as a miss. The
 * derivation is read term by term against the media host double, and both the production delegate and the stub factory are shown to capture exactly what the derivation
 * answers, so the identity a controller is built for and the identity the reconcile checks it against cannot drift apart. The samplerate table walks the doorbell
 * axis. The recording audio format helpers are walked row by row: the format read from a description, the stand-in, the mapping between hertz and HomeKit's
 * recording rates in both directions, the advertisement a stream's format becomes, the copy-or-transcode match with each way it can fail, and the log rendering.
 */
import { AudioRecordingCodecType, AudioRecordingSamplerate, AudioStreamingSamplerate } from "homebridge-plugin-utils";
import { RECORDING_AUDIO_STAND_IN, controllerCapabilityAppeared, controllerIdentityOf, describeAudioFormat, livestreamAudioFormat, recordingAdvertisementOf,
  recordingAudioMatches, recordingSamplerateOf, sampleRateHzOf, streamingSamplerates } from "./stream-delegate.ts";
import { after, describe, test } from "node:test";
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
const NONE: ControllerIdentity = { hksvCapable: false, isDoorbell: false, twoWayAudio: false };
const ALL: ControllerIdentity = { hksvCapable: true, isDoorbell: true, twoWayAudio: true };

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

    // A camera that is not a doorbell, without two-way audio, and not HKSV-capable reads as every term false.
    const plain = makeCameraConfig({ channels: G2_PRO_CHANNELS });

    host.ufp = plain;

    assert.deepEqual(controllerIdentityOf(host), NONE, "a camera with none of the capabilities reads every term false");

    // The eligibility term follows the host's isHksvCapable, and only that.
    host.isHksvCapable = true;

    assert.deepEqual(controllerIdentityOf(host), { ...NONE, hksvCapable: true }, "HKSV eligibility raises the eligibility term alone");

    // The doorbell term follows the record's featureFlags.isDoorbell, and only that.
    host.isHksvCapable = false;
    host.ufp = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { isDoorbell: true } });

    assert.deepEqual(controllerIdentityOf(host), { ...NONE, isDoorbell: true }, "a doorbell raises the doorbell term alone");

    // The two-way audio term follows the camera's two-way audio hint, and only that.
    host.ufp = plain;
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
    assert.deepEqual(new TestStreamingDelegateFactory().create(host, { audioFormat: null, probe: null, profiles: [], resolutions: [] }).builtFor, expected,
      "the stub factory captured the same derivation over the same host");
  });
});

describe("streamingSamplerates - the doorbell axis", () => {

  test("a doorbell advertises the 16 and 24 kHz streaming rates", () => {

    assert.deepEqual(streamingSamplerates({ isDoorbell: true }), [ AudioStreamingSamplerate.KHZ_16, AudioStreamingSamplerate.KHZ_24 ]);
  });

  test("every other camera advertises the 16 kHz streaming rate alone", () => {

    assert.equal(streamingSamplerates({ isDoorbell: false }), AudioStreamingSamplerate.KHZ_16);
  });
});

describe("the recording audio format helpers", () => {

  // A video track and an audio track as unifi-protect describes them, assembled per row.
  const VIDEO = { codec: "h264", height: 1080, id: 1, kind: "video", level: 40, profile: 77, width: 1920 } as const;
  const AAC = { channels: 1, codec: "aac", id: 2, kind: "audio", sampleRate: 8000 } as const;

  // HomeKit's selected recording codec at a given rate, one channel and AAC-LC unless a row says otherwise.
  function selected(samplerate: AudioRecordingSamplerate): { audioChannels?: number; samplerate: AudioRecordingSamplerate; type: AudioRecordingCodecType } {

    return { audioChannels: 1, samplerate, type: AudioRecordingCodecType.AAC_LC };
  }

  test("livestreamAudioFormat reads the first audio track, and nothing for an unreadable first audio track, a video-only stream, or no tracks", () => {

    assert.deepEqual(livestreamAudioFormat({ tracks: [ VIDEO, AAC ] }), { channels: 1, codec: "aac", sampleRate: 8000 }, "an AAC track reads as its format");
    assert.deepEqual(livestreamAudioFormat({ tracks: [ VIDEO, { channels: 2, codec: "opus", id: 2, kind: "audio", sampleRate: 48000 } ] }),
      { channels: 2, codec: "opus", sampleRate: 48000 }, "an Opus track reads as its format");
    assert.equal(livestreamAudioFormat({ tracks: [ { codec: "unknown", id: 2, kind: "audio", sampleEntry: "ulaw" }, { ...AAC, id: 3 } ] }), null,
      "an unreadable first audio track reads as nothing, though a readable one follows, because the first audio track is the one the recording maps");
    assert.equal(livestreamAudioFormat({ tracks: [VIDEO] }), null, "a video-only stream reads as nothing");
    assert.equal(livestreamAudioFormat({ tracks: [] }), null, "a stream with no tracks reads as nothing");
  });

  test("the stand-in is AAC at 16000 Hz in one channel, advertised as HomeKit's 16 kHz recording rate", () => {

    assert.deepEqual(RECORDING_AUDIO_STAND_IN, { format: { channels: 1, codec: "aac", sampleRate: 16000 }, samplerate: AudioRecordingSamplerate.KHZ_16 });
  });

  test("recordingSamplerateOf names each HomeKit recording rate, and nothing for a rate HomeKit has no member for; sampleRateHzOf is its inverse", () => {

    const table: [number, AudioRecordingSamplerate][] = [ [ 8000, AudioRecordingSamplerate.KHZ_8 ], [ 16000, AudioRecordingSamplerate.KHZ_16 ],
      [ 24000, AudioRecordingSamplerate.KHZ_24 ], [ 32000, AudioRecordingSamplerate.KHZ_32 ], [ 44100, AudioRecordingSamplerate.KHZ_44_1 ],
      [ 48000, AudioRecordingSamplerate.KHZ_48 ] ];

    for(const [ hz, samplerate ] of table) {

      assert.equal(recordingSamplerateOf(hz), samplerate, String(hz) + " Hz names its recording rate");
      assert.equal(sampleRateHzOf(samplerate), hz, "the recording rate maps back to " + String(hz) + " Hz");
    }

    assert.equal(recordingSamplerateOf(22050), null, "22050 Hz has no recording rate");
  });

  test("recordingAdvertisementOf advertises AAC-LC in one channel at the stream's rate, and the whole stand-in for a stream not read or a rate HomeKit cannot express",
    () => {

      assert.deepEqual(recordingAdvertisementOf({ channels: 1, codec: "aac", sampleRate: 8000 }), { format: { channels: 1, codec: "aac", sampleRate: 8000 },
        samplerate: AudioRecordingSamplerate.KHZ_8 }, "an 8000 Hz mono stream advertises itself at the 8 kHz recording rate");
      assert.deepEqual(recordingAdvertisementOf({ channels: 2, codec: "aac", sampleRate: 16000 }), { format: { channels: 1, codec: "aac", sampleRate: 16000 },
        samplerate: AudioRecordingSamplerate.KHZ_16 }, "a stereo stream advertises its rate in one channel");
      assert.deepEqual(recordingAdvertisementOf({ channels: 2, codec: "opus", sampleRate: 48000 }), { format: { channels: 1, codec: "aac", sampleRate: 48000 },
        samplerate: AudioRecordingSamplerate.KHZ_48 }, "an Opus stream advertises AAC at its rate in one channel");
      assert.deepEqual(recordingAdvertisementOf({ channels: 1, codec: "aac", sampleRate: 22050 }), RECORDING_AUDIO_STAND_IN,
        "a 22050 Hz stream, a rate HomeKit has no recording member for, advertises the whole stand-in");
      assert.deepEqual(recordingAdvertisementOf(null), RECORDING_AUDIO_STAND_IN, "a stream whose audio was not read advertises the stand-in");
    });

  test("recordingAudioMatches holds only for an AAC stream at the selected AAC-LC rate and channel count", () => {

    const format = { channels: 1, codec: "aac", sampleRate: 16000 } as const;

    assert.equal(recordingAudioMatches(format, selected(AudioRecordingSamplerate.KHZ_16)), true, "an equal format matches");
    assert.equal(recordingAudioMatches(format, selected(AudioRecordingSamplerate.KHZ_24)), false, "a rate mismatch does not");
    assert.equal(recordingAudioMatches({ ...format, channels: 2 }, selected(AudioRecordingSamplerate.KHZ_16)), false, "a channel mismatch does not");
    assert.equal(recordingAudioMatches({ ...format, codec: "opus" }, selected(AudioRecordingSamplerate.KHZ_16)), false, "an Opus stream does not");
    assert.equal(recordingAudioMatches(format, { ...selected(AudioRecordingSamplerate.KHZ_16), type: AudioRecordingCodecType.AAC_ELD }), false,
      "a selected codec other than AAC-LC does not");
    assert.equal(recordingAudioMatches(format, { samplerate: AudioRecordingSamplerate.KHZ_16, type: AudioRecordingCodecType.AAC_LC }), true,
      "an absent channel count reads as one, so a mono stream matches");
    assert.equal(recordingAudioMatches(null, selected(AudioRecordingSamplerate.KHZ_16)), false, "a stream whose audio was not read does not");
  });

  test("describeAudioFormat renders the rate and the channels for a log line, naming the codec only for Opus", () => {

    assert.equal(describeAudioFormat(RECORDING_AUDIO_STAND_IN.format), "16 kHz mono");
    assert.equal(describeAudioFormat({ channels: 1, codec: "aac", sampleRate: 8000 }), "8 kHz mono");
    assert.equal(describeAudioFormat({ channels: 2, codec: "aac", sampleRate: 16000 }), "16 kHz stereo", "a two-channel stream renders as stereo");
    assert.equal(describeAudioFormat({ channels: 2, codec: "opus", sampleRate: 48000 }), "48 kHz stereo Opus",
      "an Opus stream names its codec, so formats that differ by codec alone read differently");
  });
});
