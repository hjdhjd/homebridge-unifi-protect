/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * chime-commands.test.ts: Unit tests for the Phase-2C chime/doorbell migrations - the chime's speaker/buzzer play dispatch (ProtectChime.playTone) and the doorbell's
 * chime-volume read math and cross-device write (ProtectDoorbell.chimeVolumeFor / setChimeVolume).
 *
 * Two seams, two test strategies, by what the production code is:
 *
 * - playTone and setChimeVolume are user-initiated commands routed through the shared write-through seam (ProtectDevice.runDeviceCommand), which converts a v5 command's
 *   throw-or-resolve contract into the boolean the caller branches on and is the single failure log. We exercise that seam with the REAL production method (the same
 *   near-empty concrete leaf admission command-error.test.ts relies on), and model only the surrounding closure shape - the kind dispatch, the ringSettings join, the
 *   publish-on-success, the cross-device write payload, the early-return-on-first-failure - because the chime and doorbell leaves are not unit-constructable (the camera
 *   leaf transitively drags the streaming stack, and the doorbell extends it). The behavior under test that crosses the v5 boundary IS the real seam; the closure shape
 *   around it is the model.
 *
 * - chimeVolumeFor is a pure free function (config records in, a number out - no this, no HAP, no command). The natural way to cover such a helper is to import the real
 *   one and test it directly, exactly as device-reactions.test.ts imports the real sensorTamperState from sensor.ts. That works for sensor.ts because it is light and
 *   importable; it does NOT work for chimeVolumeFor, because its home (doorbell.ts) transitively imports the camera and streaming stack, which fails to resolve in the
 *   strip-types test runner. So chimeVolumeFor is modeled here in the exact shape it ships - swapping this local definition for an `import { chimeVolumeFor }` would
 *   upgrade these from contract tests to real-code coverage the moment the helper lives in an importable module. See the build report's fork on that extraction.
 */
import type { Camera, PlaySpeakerOptions } from "unifi-protect";
import { describe, test } from "node:test";
import type { PlatformAccessory } from "homebridge";
import { ProtectAuthorizationError } from "unifi-protect";
import { ProtectDevice } from "./devices/device.ts";
import type { ProtectNvr } from "./nvr.ts";
import assert from "node:assert/strict";
import { makeTestAccessory } from "./testing.helpers.ts";

// The smallest concrete leaf of the abstract base, mirroring command-error.test.ts. ProtectDevice declares no abstract members, so this adds nothing but a public window
// onto the protected command helper - runDeviceCommand is the base's own, inherited unchanged, the real write-through seam playTone and setChimeVolume route through.
class TestProtectDevice extends ProtectDevice {

  public runCommand(action: string, command: () => Promise<unknown>): Promise<boolean> {

    return this.runDeviceCommand(action, command);
  }
}

// A constructed real ProtectDevice plus the captured controller-log error lines (the helper's single failure-report sink). The instance is a vehicle for the real
// runDeviceCommand only - it is device-kind agnostic, since runDeviceCommand merely awaits the supplied thunk and maps a throw to false - so the play/write targets are
// modeled as separate lightweight chime objects below.
interface CommandHarness {

  errors: string[];
  instance: TestProtectDevice;
}

// Construct a real ProtectDevice against the minimal mocks runDeviceCommand reads: a projection carrying name (the log prefix) and modelKey; a platform whose log.error
// captures the formatted failure line; and a real AbortSignal for composeSignals. The casts are confined to this seam; the instance itself is the production class.
const makeHarness = (): CommandHarness => {

  const errors: string[] = [];
  const sink = (): void => undefined;
  const device = { config: {}, isOnline: true, modelKey: "chime", name: "Test Chime" };
  const nvr = {

    client: { connection: { isHealthy: true } },
    platform: { api: { hap: {} }, debug: sink, log: { debug: sink, error: (message: string): void => { errors.push(message); }, info: sink, warn: sink } },
    signal: new AbortController().signal
  };
  const instance = new TestProtectDevice(nvr as unknown as ProtectNvr, makeTestAccessory() as unknown as PlatformAccessory, device as unknown as Camera);

  return { errors, instance };
};

// Assert exactly one failure line was reported and return it, narrowing past the noUncheckedIndexedAccess undefined so the caller can match against the message directly.
const onlyError = (errors: string[]): string => {

  assert.equal(errors.length, 1, "exactly one failure line is reported");

  const [message] = errors;

  assert.ok(message, "the failure line is present");

  return message;
};

// A per-doorbell ring entry, carrying only the fields the volume math and the play join read.
interface RingSetting {

  cameraId: string;
  repeatTimes: number;
  ringtoneId: string;
  volume: number;
}

// The volume helper modeled over the exact fields production reads (cameraIds membership, the per-doorbell ring's volume). Mirrors doorbell.ts's chimeVolumeFor verbatim:
// the mean of the per-doorbell ring volume across every chime assigned to this doorbell, or 0 when none is assigned.
const chimeVolumeFor = (chimes: readonly { cameraIds: string[]; ringSettings: RingSetting[] }[], cameraId: string): number => {

  let total = 0;
  let count = 0;

  for(const chime of chimes) {

    const ring = chime.cameraIds.includes(cameraId) ? chime.ringSettings.find(setting => setting.cameraId === cameraId) : undefined;

    if(!ring) {

      continue;
    }

    total += ring.volume;
    count++;
  }

  return count ? (total / count) : 0;
};

// A modeled chime projection target: its read-through config (the fields the play join and the volume write read), the two play commands, and the write-through update.
// The play/update thunks resolve or reject to drive the real runDeviceCommand seam, and capture their inputs so a test can assert the exact dispatch and payload.
interface ChimeTarget {

  config: { cameraIds: string[]; ringSettings: RingSetting[] };
  playBuzzer: () => Promise<void>;
  playSpeaker: (opts: PlaySpeakerOptions) => Promise<void>;
  update: (payload: unknown) => Promise<unknown>;
}

// Build a ring entry with sane defaults so a test names only the fields it cares about.
const makeRing = (overrides: Partial<RingSetting> = {}): RingSetting => ({ cameraId: "doorbell-1", repeatTimes: 1, ringtoneId: "tone-a", volume: 50, ...overrides });

// The chime's playTone dispatch, modeled in the shape it ships over the REAL runDeviceCommand seam. The kind discriminant selects playBuzzer vs playSpeaker (v5 split the
// two sound sources into distinct commands); for a speaker tone we source the configured repeat/volume from this chime's own ringSettings - the consumer-side join - and
// early-return false on a missing ring, so a missing ringtone is a clean no-op rather than a failed call. We publish the tone name only on a command the helper accepted.
const playTone = (harness: CommandHarness, device: ChimeTarget, published: string[]) => async (name: string, kind: "buzzer" | "speaker",
  tone?: string): Promise<boolean> => {

  let options: PlaySpeakerOptions = {};

  if((kind === "speaker") && tone) {

    const ring = device.config.ringSettings.find(setting => setting.ringtoneId === tone) ?? device.config.ringSettings[0];

    if(!ring) {

      return false;
    }

    options = { repeatTimes: ring.repeatTimes, ringtoneId: tone, volume: ring.volume };
  }

  const played = await harness.instance.runCommand("play " + name, () => (kind === "buzzer") ? device.playBuzzer() : device.playSpeaker(options));

  if(played) {

    published.push(name);
  }

  return played;
};

// The doorbell's setChimeVolume cross-device write, modeled in the shape it ships over the REAL runDeviceCommand seam. A chime can serve multiple doorbells, so we update
// the ring entry for THIS doorbell on every chime that serves it; each update is write-through (a single-entry ringSettings array with only the modified ring, matching
// v4's payload), the value is clamped non-negative, and we early-return on the first failure (v4 parity), publishing only after every assigned chime accepted the write.
const setChimeVolume = (harness: CommandHarness, chimes: ChimeTarget[], cameraId: string, published: string[]) => async (value: number): Promise<void> => {

  value = Math.max(value, 0);

  for(const chime of chimes.filter(chime => chime.config.cameraIds.includes(cameraId))) {

    const ring = chime.config.ringSettings.find(setting => setting.cameraId === cameraId);

    if(!ring) {

      continue;
    }

    // eslint-disable-next-line no-await-in-loop
    if(!(await harness.instance.runCommand("set the chime volume", () => chime.update({ ringSettings: [{ ...ring, volume: value }] })))) {

      return;
    }
  }

  published.push(value.toString());
};

describe("chimeVolumeFor (modeled - doorbell.ts is not importable in the strip-types runner)", () => {

  test("no assigned chime reads as zero volume", () => {

    assert.equal(chimeVolumeFor([], "doorbell-1"), 0, "an empty chime set means this doorbell has no chime volume");
    assert.equal(chimeVolumeFor([{ cameraIds: ["other"], ringSettings: [makeRing({ cameraId: "other" })] }], "doorbell-1"), 0,
      "a chime serving only another doorbell contributes nothing");
  });

  test("a single assigned chime reads as that chime's ring volume", () => {

    const chimes = [{ cameraIds: ["doorbell-1"], ringSettings: [makeRing({ volume: 75 })] }];

    assert.equal(chimeVolumeFor(chimes, "doorbell-1"), 75, "one assigned chime reports its per-doorbell ring volume directly");
  });

  test("multiple assigned chimes read as the mean of their per-doorbell ring volumes", () => {

    const chimes = [

      { cameraIds: ["doorbell-1"], ringSettings: [makeRing({ volume: 40 })] },
      { cameraIds: ["doorbell-1"], ringSettings: [makeRing({ volume: 80 })] }
    ];

    assert.equal(chimeVolumeFor(chimes, "doorbell-1"), 60, "two assigned chimes report the mean of their ring volumes");
  });

  test("a chime assigned to this doorbell but carrying no ring for it is skipped", () => {

    const chimes = [

      { cameraIds: ["doorbell-1"], ringSettings: [] },
      { cameraIds: ["doorbell-1"], ringSettings: [makeRing({ volume: 90 })] }
    ];

    // The first chime lists the doorbell in cameraIds but has no matching ring entry, so it is skipped and does not dilute the mean toward zero.
    assert.equal(chimeVolumeFor(chimes, "doorbell-1"), 90, "a chime with no ring for this doorbell is skipped, not counted as zero");
  });

  test("a chime whose cameraIds excludes this doorbell is skipped even if a stray ring matches", () => {

    // cameraIds is the membership gate: a ring keyed to this doorbell on a chime that does not list the doorbell must not count, so the cameraIds check precedes the
    // ring lookup exactly as it does in production.
    const chimes = [{ cameraIds: ["other"], ringSettings: [makeRing({ cameraId: "doorbell-1", volume: 100 })] }];

    assert.equal(chimeVolumeFor(chimes, "doorbell-1"), 0, "membership is gated on cameraIds, not on a stray ring entry");
  });
});

describe("ProtectChime.playTone dispatch (real runDeviceCommand seam)", () => {

  test("a speaker tone joins the configured repeat/volume from ringSettings and plays the speaker", async () => {

    const harness = makeHarness();
    const published: string[] = [];
    let captured: PlaySpeakerOptions | undefined;
    const device: ChimeTarget = {

      config: { cameraIds: [], ringSettings: [makeRing({ repeatTimes: 3, ringtoneId: "tone-b", volume: 65 })] },
      playBuzzer: () => Promise.reject(new Error("the buzzer must not be played for a speaker tone")),
      playSpeaker: (opts) => {

        captured = opts;

        return Promise.resolve();
      },
      update: () => Promise.resolve({})
    };
    const result = await playTone(harness, device, published)("Tone B", "speaker", "tone-b");

    assert.equal(result, true, "an accepted speaker command reports success");
    assert.deepEqual(captured, { repeatTimes: 3, ringtoneId: "tone-b", volume: 65 }, "the configured repeat/volume for the selected ringtone is joined into the payload");
    assert.deepEqual(published, ["Tone B"], "an accepted tone is published by name");
    assert.equal(harness.errors.length, 0, "a successful play logs nothing");
  });

  test("a speaker tone with no matching ringtone falls back to the first ring entry", async () => {

    const harness = makeHarness();
    const published: string[] = [];
    let captured: PlaySpeakerOptions | undefined;
    const device: ChimeTarget = {

      config: { cameraIds: [], ringSettings: [makeRing({ repeatTimes: 2, ringtoneId: "tone-a", volume: 30 })] },
      playBuzzer: () => Promise.resolve(),
      playSpeaker: (opts) => {

        captured = opts;

        return Promise.resolve();
      },
      update: () => Promise.resolve({})
    };

    // The requested ringtone id is absent, so the join falls back to ringSettings[0] for the playback values while still sending the requested ringtoneId.
    const result = await playTone(harness, device, published)("Missing", "speaker", "tone-z");

    assert.equal(result, true);
    assert.deepEqual(captured, { repeatTimes: 2, ringtoneId: "tone-z", volume: 30 }, "the first ring entry supplies the playback values when the id does not match");
  });

  test("a speaker tone with an empty ringSettings is a clean no-op, not a failed call", async () => {

    const harness = makeHarness();
    const published: string[] = [];
    let played = false;
    const device: ChimeTarget = {

      config: { cameraIds: [], ringSettings: [] },
      playBuzzer: () => Promise.resolve(),
      playSpeaker: () => {

        played = true;

        return Promise.resolve();
      },
      update: () => Promise.resolve({})
    };
    const result = await playTone(harness, device, published)("Tone A", "speaker", "tone-a");

    assert.equal(result, false, "a missing ring resolves to a no-op false rather than issuing a doomed command");
    assert.equal(played, false, "the speaker command is never issued when there is no ring to source playback from");
    assert.deepEqual(published, [], "a no-op play publishes nothing");
    assert.equal(harness.errors.length, 0, "a no-op play is not a failure and logs nothing");
  });

  test("a buzzer plays the buzzer, never the speaker, and takes no ringtone join", async () => {

    const harness = makeHarness();
    const published: string[] = [];
    let buzzed = false;
    const device: ChimeTarget = {

      config: { cameraIds: [], ringSettings: [makeRing()] },
      playBuzzer: () => {

        buzzed = true;

        return Promise.resolve();
      },
      playSpeaker: () => Promise.reject(new Error("the speaker must not be played for a buzzer")),
      update: () => Promise.resolve({})
    };
    const result = await playTone(harness, device, published)("buzzer", "buzzer", "tone-a");

    assert.equal(result, true);
    assert.equal(buzzed, true, "the buzzer dispatches to playBuzzer");
    assert.deepEqual(published, ["buzzer"], "an accepted buzzer is published by name");
  });

  test("a speaker tone with no tone selected plays the chime's default ringtone with an empty payload", async () => {

    const harness = makeHarness();
    const published: string[] = [];
    let captured: PlaySpeakerOptions | undefined;
    const device: ChimeTarget = {

      config: { cameraIds: [], ringSettings: [makeRing()] },
      playBuzzer: () => Promise.resolve(),
      playSpeaker: (opts) => {

        captured = opts;

        return Promise.resolve();
      },
      update: () => Promise.resolve({})
    };

    // The MQTT "chime" tone path plays the speaker with no specific ringtone; an empty options object lets the controller play the chime's default ringtone.
    const result = await playTone(harness, device, published)("chime", "speaker");

    assert.equal(result, true);
    assert.deepEqual(captured, {}, "no selected tone sends an empty payload so the controller plays the default ringtone");
  });

  test("a rejected command reports failure through the shared helper and publishes nothing", async () => {

    const harness = makeHarness();
    const published: string[] = [];
    const device: ChimeTarget = {

      config: { cameraIds: [], ringSettings: [makeRing()] },
      playBuzzer: () => Promise.reject(new Error("The chime is unreachable.")),
      playSpeaker: () => Promise.resolve(),
      update: () => Promise.resolve({})
    };
    const result = await playTone(harness, device, published)("buzzer", "buzzer");

    assert.equal(result, false, "a rejected command reports failure");
    assert.deepEqual(published, [], "a failed play publishes nothing");
    assert.match(onlyError(harness.errors), /Unable to play buzzer: The chime is unreachable\.$/);
  });

  test("an authorization failure earns the Administrator-role guidance", async () => {

    const harness = makeHarness();
    const published: string[] = [];
    const device: ChimeTarget = {

      config: { cameraIds: [], ringSettings: [makeRing({ ringtoneId: "tone-a" })] },
      playBuzzer: () => Promise.resolve(),
      playSpeaker: () => Promise.reject(new ProtectAuthorizationError("forbidden")),
      update: () => Promise.resolve({})
    };
    const result = await playTone(harness, device, published)("Tone A", "speaker", "tone-a");

    assert.equal(result, false);
    assert.match(onlyError(harness.errors), /Unable to play Tone A\. Please ensure this username has the Administrator role in UniFi Protect\./);
  });
});

describe("ProtectDoorbell.setChimeVolume cross-device write (real runDeviceCommand seam)", () => {

  // Build a chime target whose update captures its payload, for asserting the exact write-through PATCH shape.
  const makeChime = (cameraIds: string[], ringSettings: RingSetting[], captures: unknown[]): ChimeTarget => ({

    config: { cameraIds, ringSettings },
    playBuzzer: () => Promise.resolve(),
    playSpeaker: () => Promise.resolve(),
    update: (payload) => {

      captures.push(payload);

      return Promise.resolve({});
    }
  });

  test("a single assigned chime is PATCHed with a single-entry ringSettings carrying the modified ring, then published", async () => {

    const harness = makeHarness();
    const published: string[] = [];
    const captures: unknown[] = [];
    const chimes = [makeChime(["doorbell-1"], [makeRing({ ringtoneId: "tone-a", volume: 20 })], captures)];

    await setChimeVolume(harness, chimes, "doorbell-1", published)(70);

    assert.deepEqual(captures, [{ ringSettings: [{ cameraId: "doorbell-1", repeatTimes: 1, ringtoneId: "tone-a", volume: 70 }] }],
      "the PATCH carries one ring entry: this doorbell's ring with only the volume changed");
    assert.deepEqual(published, ["70"], "the new volume is published once after the write is accepted");
    assert.equal(harness.errors.length, 0, "an accepted write logs nothing");
  });

  test("a negative value is clamped to zero in the payload", async () => {

    const harness = makeHarness();
    const published: string[] = [];
    const captures: unknown[] = [];
    const chimes = [makeChime(["doorbell-1"], [makeRing()], captures)];

    await setChimeVolume(harness, chimes, "doorbell-1", published)(-15);

    assert.deepEqual(captures, [{ ringSettings: [{ cameraId: "doorbell-1", repeatTimes: 1, ringtoneId: "tone-a", volume: 0 }] }], "a negative volume clamps to zero");
    assert.deepEqual(published, ["0"], "the clamped value is what we publish");
  });

  test("every chime serving this doorbell is updated, and the volume is published once", async () => {

    const harness = makeHarness();
    const published: string[] = [];
    const captures: unknown[] = [];
    const chimes = [

      makeChime(["doorbell-1"], [makeRing({ ringtoneId: "tone-a", volume: 10 })], captures),
      makeChime([ "doorbell-1", "doorbell-2" ], [makeRing({ ringtoneId: "tone-b", volume: 20 })], captures)
    ];

    await setChimeVolume(harness, chimes, "doorbell-1", published)(55);

    assert.equal(captures.length, 2, "both chimes serving this doorbell are written");
    assert.deepEqual(published, ["55"], "the volume is published once after all assigned chimes accept the write");
  });

  test("a chime that does not serve this doorbell is left untouched", async () => {

    const harness = makeHarness();
    const published: string[] = [];
    const captures: unknown[] = [];
    const chimes = [

      makeChime(["other"], [makeRing({ cameraId: "other" })], captures),
      makeChime(["doorbell-1"], [makeRing()], captures)
    ];

    await setChimeVolume(harness, chimes, "doorbell-1", published)(45);

    assert.equal(captures.length, 1, "only the chime that serves this doorbell is written");
    assert.deepEqual(published, ["45"]);
  });

  test("a chime serving this doorbell but carrying no ring for it is skipped without a write", async () => {

    const harness = makeHarness();
    const published: string[] = [];
    const captures: unknown[] = [];
    const chimes = [

      makeChime(["doorbell-1"], [], captures),
      makeChime(["doorbell-1"], [makeRing()], captures)
    ];

    await setChimeVolume(harness, chimes, "doorbell-1", published)(35);

    assert.equal(captures.length, 1, "the chime with no ring for this doorbell is skipped; the loop continues to the next");
    assert.deepEqual(published, ["35"]);
  });

  test("the first failed write early-returns: no later chime is written and nothing is published", async () => {

    const harness = makeHarness();
    const published: string[] = [];
    const captures: unknown[] = [];
    const rejecting: ChimeTarget = {

      config: { cameraIds: ["doorbell-1"], ringSettings: [makeRing()] },
      playBuzzer: () => Promise.resolve(),
      playSpeaker: () => Promise.resolve(),
      update: () => Promise.reject(new Error("The chime rejected the write."))
    };
    const chimes = [ rejecting, makeChime(["doorbell-1"], [makeRing()], captures) ];

    await setChimeVolume(harness, chimes, "doorbell-1", published)(25);

    assert.equal(captures.length, 0, "the second chime is never written once the first write fails");
    assert.deepEqual(published, [], "a failed write publishes nothing");
    assert.match(onlyError(harness.errors), /Unable to set the chime volume: The chime rejected the write\.$/);
  });

  test("an authorization failure on the write earns the Administrator-role guidance", async () => {

    const harness = makeHarness();
    const published: string[] = [];
    const rejecting: ChimeTarget = {

      config: { cameraIds: ["doorbell-1"], ringSettings: [makeRing()] },
      playBuzzer: () => Promise.resolve(),
      playSpeaker: () => Promise.resolve(),
      update: () => Promise.reject(new ProtectAuthorizationError("forbidden"))
    };

    await setChimeVolume(harness, [rejecting], "doorbell-1", published)(25);

    assert.deepEqual(published, []);
    assert.match(onlyError(harness.errors), /Unable to set the chime volume\. Please ensure this username has the Administrator role in UniFi Protect\./);
  });
});
