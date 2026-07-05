/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * leak-policy.test.ts: Unit tests for the pure per-channel leak-enablement policy (leakChannelEnabled) extracted to the importable leaf src/devices/leak-policy.ts.
 *
 * leakChannelEnabled is a pure free function - a sensor-facts context plus a channel in, a boolean out, no this, no HAP - so the natural coverage is to import the REAL
 * leaf and drive its truth table directly, exactly as motion-policy.test.ts / chime-volume.test.ts import their pure leaves. The leaf owns the model split between
 * single-channel mount-role devices and multi-channel live-leakSettings devices, so this truth table is the highest-value pin: it includes the regression case (the stuck
 * internal flag on a single-channel device that must NOT expose leak when the mount role is off) and the single-channel external suppression (the channel the device
 * never advertises).
 */
import type { LeakChannel, LeakChannelContext } from "./leak-policy.ts";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { leakChannelEnabled } from "./leak-policy.ts";

describe("per-channel leak-enablement policy (leakChannelEnabled)", () => {

  test("exposes a leak channel iff the device advertises it AND the model-correct enable signal is set", () => {

    // The policy across its axes: the device must HAVE the channel (channelNames), and it must be ENABLED by the model-correct signal - mountType "leak" for
    // single-channel mount-role devices (whose leakSettings is a stuck echo we ignore), the live leakSettings.is<C>Enabled for multi-channel environmental devices. The
    // regression case is the single-channel device with the stuck internal flag true and mountType NOT "leak": it must read false.
    // The channel-capability shapes the controller advertises: a single-channel UP-Sense exposes only "internal", a multi-channel USL-Environmental exposes both, and a
    // no-leak device exposes neither. Sharing them keeps each case row legible and within the line width.
    const solo = ["internal"];
    const dual = [ "internal", "external" ];
    const none: string[] = [];

    const cases: { channel: LeakChannel; context: LeakChannelContext; expected: boolean; label: string }[] = [

      // Single-channel UP-Sense (["internal"]): internal leak iff mountType "leak", regardless of the stuck leakSettings flag.
      { channel: "internal", context: { channelNames: solo, leakSettings: { isExternalEnabled: false, isInternalEnabled: true }, mountType: "leak" },
        expected: true, label: "single-channel, mountType leak, internal -> exposed" },
      { channel: "internal", context: { channelNames: solo, leakSettings: { isExternalEnabled: false, isInternalEnabled: false }, mountType: "leak" },
        expected: true, label: "single-channel, mountType leak, stuck flag false yet mount role on -> exposed (mount role is authoritative)" },

      // The REGRESSION case: the stuck internal flag is true but the mount role is off. A single-channel device's stuck leakSettings flag must never override the
      // mount-role signal, so the leaf reads false.
      { channel: "internal", context: { channelNames: solo, leakSettings: { isExternalEnabled: false, isInternalEnabled: true }, mountType: "none" },
        expected: false, label: "single-channel REGRESSION, mountType none, stuck flag true -> NOT exposed" },
      { channel: "internal", context: { channelNames: solo, leakSettings: { isExternalEnabled: false, isInternalEnabled: true }, mountType: "door" },
        expected: false, label: "single-channel, mountType door, stuck flag true -> NOT exposed (mount role is a different sensor)" },

      // Single-channel external suppression: the device never advertises "external", so the channel can never be a service regardless of any flag or mount role.
      { channel: "external", context: { channelNames: solo, leakSettings: { isExternalEnabled: true, isInternalEnabled: true }, mountType: "leak" },
        expected: false, label: "single-channel, external channel absent -> NEVER exposed" },

      // Multi-channel USL-Environmental (["internal","external"]): each channel iff its live leakSettings flag, independent of mountType.
      { channel: "internal", context: { channelNames: dual, leakSettings: { isExternalEnabled: false, isInternalEnabled: true }, mountType: "none" },
        expected: true, label: "multi-channel, internal flag on -> exposed" },
      { channel: "internal", context: { channelNames: dual, leakSettings: { isExternalEnabled: true, isInternalEnabled: false }, mountType: "none" },
        expected: false, label: "multi-channel, internal flag off -> NOT exposed" },
      { channel: "external", context: { channelNames: dual, leakSettings: { isExternalEnabled: true, isInternalEnabled: false }, mountType: "none" },
        expected: true, label: "multi-channel, external flag on -> exposed" },
      { channel: "external", context: { channelNames: dual, leakSettings: { isExternalEnabled: false, isInternalEnabled: true }, mountType: "none" },
        expected: false, label: "multi-channel, external flag off -> NOT exposed" },
      { channel: "internal", context: { channelNames: dual, leakSettings: { isExternalEnabled: true, isInternalEnabled: true }, mountType: "leak" },
        expected: true, label: "multi-channel, internal flag on, mountType leak ignored -> exposed (leakSettings is authoritative)" },

      // No capability at all (channelNames []): neither channel can ever be a service - the no-leak USL-Entry / all-quiet model.
      { channel: "internal", context: { channelNames: none, leakSettings: { isExternalEnabled: true, isInternalEnabled: true }, mountType: "leak" }, expected: false,
        label: "no channelNames, internal -> NEVER exposed" },
      { channel: "external", context: { channelNames: none, leakSettings: { isExternalEnabled: true, isInternalEnabled: true }, mountType: "leak" }, expected: false,
        label: "no channelNames, external -> NEVER exposed" }
    ];

    for(const { channel, context, expected, label } of cases) {

      assert.equal(leakChannelEnabled(context, channel), expected, label);
    }
  });
});
