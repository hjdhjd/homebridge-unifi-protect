/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * leak-policy.ts: The pure per-channel leak-enablement policy for UniFi Protect sensors.
 *
 * This module owns one pure decision: whether a given leak channel on a sensor should be exposed as a HomeKit service, given the device's own capability and the
 * model-correct enable signal. It is deliberately pure - `this`-free and free of any device or controller I/O, three sensor facts in and a boolean out - so the sensor
 * leaf's three leak consumers (the service gate, the enabled-sensors log, and the leak MQTT registration) import it without value-importing a non-leaf module (the
 * device-layer module invariant), and its truth table is exhaustively testable without standing up a sensor accessory.
 *
 * Why a leaf at all: the leak ENABLE signal differs by sensor model, and a single raw flag no longer expresses the truth for every device. The single-channel UP-Sense
 * (featureFlags.waterLeak.channelNames ["internal"]) drives leak via its physical mount role - the user sets mountType "leak" - while its leakSettings.isInternalEnabled
 * is a STUCK capability echo (always true, never moves). The multi-channel USL-Environmental (["internal","external"]) exposes LIVE per-channel toggles via
 * leakSettings.is<C>Enabled, with mountType "none". A single conditional in the gate would re-introduce the bug (the stuck-true flag wins) and leave the log and MQTT
 * keying on the raw flag - three divergent truths. Encapsulating the model split here gives one documented home, consumed identically by all three paths.
 */

/**
 * The two leak channels a UniFi Protect sensor can expose. Single-channel devices carry only "internal"; multi-channel environmental devices carry both.
 */
export type LeakChannel = "external" | "internal";

/**
 * The sensor facts the leak policy reads, extracted off the projection as primitives so the leaf stays pure and library-decoupled. The caller pulls channelNames off
 * featureFlags.waterLeak, and leakSettings / mountType off the sensor config.
 */
export interface LeakChannelContext {

  channelNames: readonly string[];
  leakSettings: { isExternalEnabled: boolean; isInternalEnabled: boolean };
  mountType: string;
}

/**
 * Decide whether a leak channel should be exposed as a HomeKit service.
 *
 * The device must HAVE the channel (the capability the controller advertises in featureFlags.waterLeak.channelNames) and it must be ENABLED by the model-correct signal.
 * Single-channel devices (UFP-SENSE, channelNames ["internal"]) drive leak via the physical mount role - their leakSettings.isInternalEnabled is a stuck capability echo
 * (always true), so we IGNORE it and read mountType === "leak". Multi-channel devices (USL-Environmental, ["internal","external"]) expose LIVE per-channel toggles, so we
 * honor leakSettings. ASSUMPTION (documented, accepted): channel arity is the derivable proxy for which enable signal is authoritative - single-channel => mount-role,
 * multi-channel => live leakSettings. This holds for all known hardware. It could mis-gate in two directions only a future device could introduce: a single-channel
 * device whose leakSettings is genuinely LIVE (we would wrongly read mountType), or a multi-channel device whose leakSettings is a stuck echo (we would wrongly trust the
 * flag). If either ships, THIS leaf is the single chokepoint to add a per-capability override - the three consumers never need to change.
 *
 * @param context - The sensor facts the policy reads: the advertised leak channelNames, the leakSettings toggles, and the mountType.
 * @param channel - The leak channel under consideration: "internal" or "external".
 *
 * @returns true when the channel should be exposed as a HomeKit service, false when it should not.
 */
export function leakChannelEnabled(context: LeakChannelContext, channel: LeakChannel): boolean {

  // Capability gate: the controller must advertise this channel at all. Absent it, the channel can never be a service - this is the single-channel external suppression.
  if(!context.channelNames.includes(channel)) {

    return false;
  }

  // Single-channel mount-role devices: the user enables leak by setting mountType "leak"; leakSettings is a stuck echo we deliberately ignore.
  if(context.channelNames.length === 1) {

    return context.mountType === "leak";
  }

  // Multi-channel environmental devices: honor the live per-channel leakSettings toggle for the requested channel.
  return (channel === "external") ? context.leakSettings.isExternalEnabled : context.leakSettings.isInternalEnabled;
}
