/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * nvr-policy.ts: Pure decision logic for the NVR controller root.
 *
 * This module is the home for all of the controller root's pure decision logic, separated from the ProtectNvr composition root that acts on it. It holds the
 * startup-resilient connect retry policy and its reading of a failed connect, the request-outcome classifier that feeds NvrHealth, induced-disruption and reboot-recency
 * gating, the induced-reboot resume decision, the per-episode livestream-recovery quiet latch, the scheduled-reboot deferral decision with its initial-delay arithmetic
 * and its recording-count rule, the span a scheduled reboot is expected to return within, the removal-stability arithmetic, the rule that resolves the address override
 * the cameras' RTSP URLs are composed against, and the reads of the controller's device inventory out of its state store. Each is a pure function of its inputs. They
 * live here, in a dependency-light leaf, rather than inside the ProtectNvr composition root, for the same reason unifi-protect keeps its reducer pure and
 * apart from its client and the plugin keeps the NvrHealth reducer apart from its event-sink wrapper: a decision separated from the effect it drives is independently
 * testable, and the test is the proof the separation is real. ProtectNvr transitively imports the entire device and media graph (cameras, streaming, snapshots); a pure
 * predicate should never have to stand that up to be exercised. This module imports only what its decisions read - unifi-protect's error classes and its readings of a
 * controller refusal and of a refused sign-in, its recovery and refusal schedules, its reboot anticipation window and its device-collection keys, and
 * homebridge-plugin-utils' transport fault table and its error and URL-host formatters - so it loads and tests in isolation.
 */
import type { ConnectionState, ProtectDeviceConfig, StateStore } from "unifi-protect";
import { DEVICE_COLLECTION_KEYS, PROTECT_REBOOT_ANTICIPATION_WINDOW_MS, PROTECT_RECOVERY_BACKOFF_KNOWN_MS, PROTECT_RECOVERY_BACKOFF_UNKNOWN_MS,
  PROTECT_RECOVERY_REFUSAL_SCHEDULE_MS, PROTECT_RECOVERY_STEADY_INTERVAL_MS, ProtectAuthorizationError, ProtectBootstrapError, ProtectConfigurationError, ProtectError,
  ProtectProtocolError, ProtectRequestError, isControllerRefusal, isSignInRefusal } from "unifi-protect";
import type { Nullable, RetryBackoff, TransportFailureKind } from "homebridge-plugin-utils";
import { classifyTransportError, connectionFaultLevel, formatErrorMessage, formatUrlHost } from "homebridge-plugin-utils";
import type { NvrPhase } from "./nvr.ts";

/**
 * Why a retried connect attempt failed, the tag a caller's repeat-demoting log compares with the one it remembers: every kind the transport classifier names, and what
 * a connect reads above that classifier. A host name that does not exist has a type apart from a resolver that is struggling, because the two are logged at different
 * levels, and a change of level is always a change of type. A refused identity and a refused privilege have a type each, because each asks a person for a different fix.
 */
export type ConnectFailureType = "no-such-host" | "rate-limit" | "refused-identity" | "refused-privilege" | "status" | "unreadable" | TransportFailureKind;

/**
 * A retried connect attempt's failure, as the connect retry policy reports it to the caller on every attempt.
 */
export interface ConnectFailure {

  /** The level a user reads it at: error when a person must act, and warning when it should fix itself. */
  readonly level: "error" | "warning";

  /** The reason the attempt failed, formatted as the text a user reads. */
  readonly reason: string;

  /** The tag the reason falls under, which a caller's repeat-demoting log compares. */
  readonly type: ConnectFailureType;
}

/**
 * The sentence a controller is refused in when its answer holds no record, or a record with no version or a MAC that is no string, none of which the plugin can run on.
 * It lives beside the reading of that failure rather than at a place that refuses, so every caller says the one sentence.
 */
export const UNREPORTED_CONTROLLER_RECORD = "The controller did not report its configuration or version.";

/**
 * Read a retried connect failure for the person reading the Homebridge log, from what unifi-protect exports and the homebridge-plugin-utils fault table. A refused
 * sign-in, a response nothing here can understand, a certificate nothing trusts and a host name that does not exist are errors, because each needs a person. Everything
 * else is a warning, because it should fix itself, a `quiet` answer included, since a retry that never ends always says why.
 *
 * What the table cannot see is read above it. Every error unifi-protect raises is a transport failure to the classifier, so a sign-in, a status and a response it could
 * not use all read as its codeless row. A value unifi-protect did not type carries no transport reading, so nothing fixes it by waiting, and the one a connect meets is
 * what the root's own attempt throws for a controller that did not report its configuration or version.
 *
 * @param error - The failure the attempt ended in.
 *
 * @returns The level and the type of the failure.
 */
export function connectFailureReading(error: unknown): Pick<ConnectFailure, "level" | "type"> {

  const fault = (error instanceof ProtectBootstrapError) ? error.cause : error;

  if(isSignInRefusal(error)) {

    return { level: "error", type: (fault instanceof ProtectAuthorizationError) ? "refused-privilege" : "refused-identity" };
  }

  if(isControllerRefusal(error)) {

    return { level: "warning", type: "rate-limit" };
  }

  if(!(error instanceof ProtectError) || (error instanceof ProtectProtocolError) || ((error instanceof ProtectBootstrapError) && (error.stage !== "fetch"))) {

    return { level: "error", type: "unreadable" };
  }

  if(fault instanceof ProtectRequestError) {

    return { level: "warning", type: "status" };
  }

  const failure = classifyTransportError(error);
  const level = (connectionFaultLevel(failure, { open: false }) === "error") ? "error" : "warning";

  return { level, type: ((failure.kind === "dns") && (level === "error")) ? "no-such-host" : failure.kind };
}

// The library's recovery schedule for a fault it cannot explain, its staged delays and its steady floor composed into the shape its refusal schedule is published in,
// so the connect retry holds each schedule the same way. This mirrors how the library composes the same pair for its own recovery loop, and it reads the library's
// numbers rather than restating them.
const RECOVERY_SCHEDULE_MS = { backoff: [...PROTECT_RECOVERY_BACKOFF_UNKNOWN_MS], steady: PROTECT_RECOVERY_STEADY_INTERVAL_MS };

/**
 * The startup-resilient connect retry policy, as a pure stateful factory: the decision the retry consults after each failed attempt, and the wait it asks for before
 * the next one. A pure factory, so the schedule logic is testable without standing up a client - the separation of the retry *decision* from the connect *effect*.
 *
 * A refusal waits by the library's refusal schedule, and every other fault by its recovery schedule, the one its connection monitor walks for a fault it cannot
 * explain, so a controller that fails at startup is retried on the cadence the library keeps for one that fails mid-session. A refusal is the controller's answer
 * rather than the network's silence - the controller answered, and asking again moments later cannot change its answer. UniFi OS refuses sign-ins once an account
 * passes a threshold of failed attempts it does not publish, and a rate limit is the controller asking to be asked less often, so a refusal backs off slowly while a
 * controller that is merely slow to appear is probed at once and then at a quicker pace. Which faults are refusals, and how slowly a refusal is retried, are the
 * library's to publish, and the plugin reads them rather than restating them: what counts as a refusal is the reading the library's own recovery chooses its
 * schedule by, {@link isControllerRefusal}, every spelling of a refused identity, privilege or request rate, the one a refused bootstrap document read carries as
 * its cause included. The retry therefore paces a controller as recovery does, except that recovery alone also lengthens a wait toward a `Retry-After` hint a
 * controller sends, up to the refusal schedule's steady interval, a reading the library keeps inside its recovery.
 *
 * Each schedule is walked from its first rung when its class of fault begins, so a change of class restarts the new schedule rather than landing partway down it.
 * Each settles onto a steady floor it holds for as long as the run lasts, so every fault a controller or a network can recover from is retried, and the caller's
 * shutdown is what ends a run that never connects.
 *
 * The one fault the decision refuses to retry is an address no URL can carry, which unifi-protect refuses as a {@link ProtectConfigurationError} before it sends
 * anything. The same address is refused the same way on every attempt, so asking again can only repeat the refusal, and the decision answers false for it. The
 * veto answers ahead of the report below and leaves the run's state alone, because the run ends on it and the caller says why in words of its own.
 *
 * Every other failure is handed to `onFailure`, because a retry without end is otherwise silent for as long as it lasts, carrying what {@link connectFailureReading}
 * reads. The policy remembers none of what it reports, because the caller's repeat-demoting log is that memory and a second would disagree with it, so which of those
 * reports a user reads in full is that log's to decide.
 *
 * @param options - The callback that receives each failure the run reports, optional.
 *
 * @returns The `backoff` and `shouldRetry` pair for the retry options. They close over whether the last failure was a refusal and the run's rung on that class's
 * schedule.
 */
export function createConnectRetryPolicy({ onFailure }: { onFailure?: (failure: ConnectFailure) => void } = {}): { backoff: RetryBackoff;
  shouldRetry: (error: unknown) => boolean; } {

  let refused = false;
  let rung = 0;

  return {

    /* The wait before the next attempt: the current class's rung on its schedule, or that schedule's steady floor once the rungs are spent. The retry hands this the
     * number of the attempt about to run, and it is ignored, because that number counts every attempt in the run while the rung is counted per class...reading it
     * would land a change of class partway down the new schedule. The retry asks for a wait only after the decision below has recorded the failure it follows.
     */
    backoff: (): number => {

      const schedule = refused ? PROTECT_RECOVERY_REFUSAL_SCHEDULE_MS : RECOVERY_SCHEDULE_MS;

      return schedule.backoff[rung - 1] ?? schedule.steady;
    },

    shouldRetry: (error: unknown): boolean => {

      // An address no URL can carry ends the run before anything is counted or reported, so no retrying reason reaches the caller ahead of its own report.
      if(error instanceof ProtectConfigurationError) {

        return false;
      }

      const refusal = isControllerRefusal(error);

      // A change of class restarts the rung count, so the wait that follows walks the new class's schedule from its first rung.
      if(refusal !== refused) {

        refused = refusal;
        rung = 0;
      }

      rung++;

      onFailure?.({ ...connectFailureReading(error), reason: formatErrorMessage(error) });

      return true;
    }
  };
}

/**
 * Whether a lifecycle phase change is legal. Two changes are refused: a same-phase change (the long-standing no-op), and any change OUT of "shuttingDown".
 * "shuttingDown" is one-way because entering it aborts the terminal shutdown signal and tears down the whole observe/firehose tree - nothing may resurrect a
 * torn-down controller's lifecycle, so a stale reboot timer, a late-resolving connect, or any other deferred wake that tries to move the phase onward is
 * rejected here rather than at each call site. Entering "shuttingDown" from any other phase stays legal. An options object because both arguments share the
 * NvrPhase type and a positional swap would silently invert the predicate - the same reason {@link shouldResumeFromInducedReboot} takes a named shape.
 */
export function canTransition(options: { from: NvrPhase; to: NvrPhase }): boolean {

  const { from, to } = options;

  return (from !== to) && (from !== "shuttingDown");
}

/**
 * Whether a livestream disruption is INDUCED - the controller is rebooting or shutting down because we asked it to - rather than ORGANIC. An induced disruption is
 * expected and already narrated at the controller level; an organic one is a single camera unexpectedly in trouble. It deliberately excludes "connecting", which is an
 * organic startup/reconnection window where a disruption should still surface to the user. The recovery policy's induced-disruption guard consults this directly; the
 * narrations that ask whether a disruption is expected consult {@link isDisruptionExpected}, of which this is the induced half.
 */
export function isInducedDisruption(phase: NvrPhase): boolean {

  return (phase === "rebooting") || (phase === "shuttingDown");
}

// Whether the plugin observed a controller reboot recently enough that a per-camera livestream interruption now is that reboot's tail (every camera blips on a controller
// reboot, narrated once at the controller level) rather than a genuine single-camera drop. lastRebootMs is the plugin's own-clock timestamp of the controllerRebooted
// event (the library's jitter-thresholded reboot detection), null until one is seen; null -> false so a blip with no recent reboot defaults to the loud, genuine-drop
// level.
export function isWithinRebootRecency(options: { lastRebootMs: Nullable<number>; nowMs: number; windowMs: number }): boolean {

  const { lastRebootMs, nowMs, windowMs } = options;

  return (lastRebootMs !== null) && ((nowMs - lastRebootMs) < windowMs);
}

/**
 * Whether a disruption happening right now is EXPECTED. This is the one classification every disruption-facing narration consults, so the same blip reads the same way
 * everywhere it is told rather than warning in one story and staying quiet in another. Expected means either half: a disruption the plugin induced
 * ({@link isInducedDisruption}), or one landing inside the settling tail of a reboot the plugin observed ({@link isWithinRebootRecency}). The tail half covers what the
 * phase alone cannot - a reboot's post-return re-establishment blip fires after the plugin has already concluded the reboot and resumed running, so the phase reads
 * organic by then. An expected disruption is already narrated once at the controller level and stays quiet per camera; an unexpected one is a single camera in genuine
 * trouble, where the noise is the signal.
 *
 * @param options - lastRebootMs: the plugin's own-clock timestamp of the last observed reboot, null until one is seen; nowMs: the current instant; phase: the
 *                  controller's lifecycle phase; windowMs: how long a reboot's settling tail lasts.
 *
 * @returns `true` when a disruption right now is one we expect.
 */
export function isDisruptionExpected(options: { lastRebootMs: Nullable<number>; nowMs: number; phase: NvrPhase; windowMs: number }): boolean {

  const { lastRebootMs, nowMs, phase, windowMs } = options;

  return isInducedDisruption(phase) || isWithinRebootRecency({ lastRebootMs, nowMs, windowMs });
}

// Whether the plugin should conclude its induced reboot and return to running, given a connection-state transition and the current phase. True only on a RECOVERY edge
// while rebooting: the connection arrived at healthy (events flowing again) from a non-healthy state, so a genuine drop-and-recovery completed. The from !== "healthy"
// conjunct is the staleness guard - the plugin is already healthy when it enters rebooting, but that is not an edge, and any real reboot first drops the connection, so
// the recovery edge cannot fire on the entry-healthy state. This depends on nothing but the connection's own health journey, so it is ordering-independent and
// strand-proof.
export function shouldResumeFromInducedReboot(options: { from: ConnectionState; phase: NvrPhase; to: ConnectionState }): boolean {

  const { from, phase, to } = options;

  return (phase === "rebooting") && (to === "healthy") && (from !== "healthy");
}

/**
 * Create a per-episode livestream-recovery quiet-classification latch. A livestream recovery episode opens (interruption) and later closes (recovery) on two independent
 * unifi-protect library events; the recovery edge cannot read the controller phase reliably (the controller has already returned), so it must consult what the
 * interruption edge recorded. What it records is `quiet` - whether the episode should be logged quietly (the reboot-tail-or-induced case) rather than at warn (a
 * genuine single-camera drop). Keyed by the library's livestream pool `key` (one slot per concurrent session, not per camera). The owner records at interruption and
 * consumes at both episode terminals - the recovery, which reads the classification, and the policy's give-up, which drains the slot without reading it - so the
 * ledger holds only episodes in flight; `forgetCamera` reclaims any entries a camera removed mid-episode left behind. The Map is owned here, never exposed -
 * mirroring createConnectRetryPolicy's encapsulated state.
 */
export function createLivestreamEpisodeLatch(): {
  consume: (key: string) => boolean;
  forgetCamera: (cameraId: string) => void;
  record: (key: string, cameraId: string, quiet: boolean) => void;
} {

  const episodes = new Map<string, { cameraId: string; quiet: boolean }>();

  return {

    consume: (key: string): boolean => {

      const episode = episodes.get(key);

      episodes.delete(key);

      return episode?.quiet ?? false;
    },
    forgetCamera: (cameraId: string): void => {

      for(const [ key, episode ] of episodes) {

        if(episode.cameraId === cameraId) {

          episodes.delete(key);
        }
      }
    },
    record: (key: string, cameraId: string, quiet: boolean): void => {

      episodes.set(key, { cameraId, quiet });
    }
  };
}

/**
 * Whether a completed HTTP request belongs to this controller, from the unifi-protect library's process-global `http:request:end` diagnostic payload. The channel
 * carries every request from every client in the process, so each NVR filters by host to keep its health scoped to its own controller. The payload's `host` is the exact
 * address the client was built against, and this NVR passes its configured `address` to `connect()`, so an exact string comparison against that same address
 * attributes a request precisely - both strings descend from one configuration value. Exact identity keeps the port significant: a ported address ("1.2.3.4:8443")
 * attributes to itself, two controllers on one host at different ports stay distinct, and a mixed-case address matches itself verbatim.
 *
 * @param options - The configured controller `address` and the payload's reported `host`.
 *
 * @returns `true` when the request's host is exactly this controller's configured address.
 */
export function isRequestForController(options: { address: string; host: string }): boolean {

  return options.host === options.address;
}

/**
 * Whether a completed HTTP request was successful, from the unifi-protect library's `http:request:end` diagnostic payload: no transport-level error, and a 2xx status.
 * Everything else - a transport error, an absent status, or a non-2xx response - is a failure. Isolated so the request-outcome-to-health-symptom mapping the NVR feeds
 * into NvrHealth is testable apart from the diagnostics-channel subscription that drives it.
 *
 * @param payload - The request-end payload (only `error` and `statusCode` are read).
 *
 * @returns `true` when the request succeeded.
 */
export function isSuccessfulRequest(payload: { error?: string; statusCode?: number }): boolean {

  return (payload.error === undefined) && (payload.statusCode !== undefined) && (payload.statusCode >= 200) && (payload.statusCode < 300);
}

// Compute the timestamp from which the controller's current continuous good-state period should be counted for the removal stability gate. On the very first good-state
// entry of the plugin's life (no prior observation) we trust the controller's own uptime: a controller already up longer than the window is treated as immediately
// stable. On every later recovery we count from now, because a disruption we observed resets our trust regardless of how long the controller process has been up.
export function computeStableSince(options: { hasStabilizedBefore: boolean; nowMs: number; uptimeMs: number; windowMs: number }): number {

  const { hasStabilizedBefore, nowMs, uptimeMs, windowMs } = options;

  return hasStabilizedBefore ? nowMs : (nowMs - Math.min(uptimeMs, windowMs));
}

// Whether the controller has been continuously good for at least the stability window - the gate every destructive removal must pass. Null means "not currently good".
export function isStabilityWindowElapsed(options: { nowMs: number; stableSinceMs: Nullable<number>; windowMs: number }): boolean {

  const { nowMs, stableSinceMs, windowMs } = options;

  return (stableSinceMs !== null) && ((nowMs - stableSinceMs) >= windowMs);
}

/**
 * What a scheduled-reboot attempt should do when its timer fires. `proceed` is the ordinary case - nothing is recording, so the reboot goes ahead. `defer` holds the
 * reboot back because camera views are actively transmitting HKSV recordings and the cumulative deferral ceiling has not yet elapsed. `force` reboots anyway: views are
 * still transmitting, but the ceiling has been reached and an open-ended series of recordings must not postpone the reboot indefinitely.
 */
export type RebootAttemptDecision = "defer" | "force" | "proceed";

/**
 * What a scheduled-reboot attempt should do, given how many camera views are transmitting HKSV recordings right now and how long this reboot cycle has already spent
 * deferring. The ceiling comparison is strict-less-than, so an elapsed time exactly at the ceiling forces rather than defers - the ceiling is a bound the deferral chain
 * may reach but not exceed.
 *
 * @param options - activeRecordings: how many camera views are transmitting as of this attempt; ceilingMs: the cumulative deferral ceiling; elapsedCycleMs: how long
 *                  this cycle has been deferring, which is zero on the originally-scheduled attempt.
 *
 * @returns The decision this attempt should act on.
 */
export function classifyRebootAttempt(options: { activeRecordings: number; ceilingMs: number; elapsedCycleMs: number }): RebootAttemptDecision {

  const { activeRecordings, ceilingMs, elapsedCycleMs } = options;

  if(activeRecordings === 0) {

    return "proceed";
  }

  return (elapsedCycleMs < ceilingMs) ? "defer" : "force";
}

/**
 * How long to wait before the first scheduled reboot of this process. The schedule is anchored to the controller's own uptime so restarting the plugin does not reset
 * the reboot cadence, and a controller already up longer than the interval waits a short floor rather than rebooting the instant we connect - which lets everything
 * settle after startup first. An upSince of zero reads as no boot time reported, so the wait is the full interval rather than a backdate from the epoch.
 *
 * @param options - intervalMs: the configured reboot interval; nowMs: the current instant; upSince: the controller's self-reported boot time.
 *
 * @returns The delay, in milliseconds, until the first reboot attempt.
 */
export function computeInitialRebootDelay(options: { intervalMs: number; nowMs: number; upSince: number }): number {

  const { intervalMs, nowMs, upSince } = options;
  const uptimeMs = upSince ? (nowMs - upSince) : 0;

  return Math.max(intervalMs - uptimeMs, 60 * 1000);
}

/**
 * How long, in milliseconds from the controller accepting the command, a scheduled reboot may take before it counts as overdue: the library's known-reboot schedule, one
 * more probe at its steady interval, and its anticipation window as margin. The span counts from acceptance while the probes count from the fault that follows it, so
 * the margin keeps a typical reboot's recovery from drawing a warning seconds before it completes. It reads the library's numbers rather than restating them.
 */
export const REBOOT_EXPECTED_RETURN_MS = PROTECT_RECOVERY_BACKOFF_KNOWN_MS.reduce((total, wait) => total + wait, 0) + PROTECT_RECOVERY_STEADY_INTERVAL_MS +
  PROTECT_REBOOT_ANTICIPATION_WINDOW_MS;

/**
 * How many of the given camera views are actively transmitting a HomeKit Secure Video recording - the one definition of the rule the scheduled-reboot deferral rests
 * on. The caller owns which views it walks and this owns what counts, so the controller and the harness can each present their own population to one shared rule.
 * Structurally typed over the single member it reads, which keeps it clear of the device classes entirely; both hops are optional because a view may carry no streaming
 * member at all and a camera that has not yet acquired one answers null.
 *
 * @param views - The camera views to count.
 *
 * @returns How many of them are transmitting.
 */
export function countActiveRecordingViews(views: Iterable<{ streaming?: Nullable<{ isRecordingTransmitting: boolean }> }>): number {

  let count = 0;

  for(const view of views) {

    if(view.streaming?.isRecordingTransmitting) {

      count++;
    }
  }

  return count;
}

/**
 * The read surface of a controller's state store that the device-inventory reads take: its current state and its own selector catalog.
 */
export type StoreReadSurface = Pick<StateStore, "selectors" | "snapshot">;

/**
 * Every device config record the controller reports, across every device category, flattened from one snapshot of its state store through the store's own selector
 * catalog. Each reader of the controller's device inventory takes it from here, so none re-derives it from a held copy.
 *
 * @param state - The controller's state store.
 *
 * @returns Every device config record the store holds, category by category.
 */
export function deviceInventory(state: StoreReadSurface): ProtectDeviceConfig[] {

  const snapshot = state.snapshot();

  return DEVICE_COLLECTION_KEYS.flatMap((key): readonly ProtectDeviceConfig[] => state.selectors[key].all(snapshot));
}

/**
 * The device config record the controller reports for a MAC, read from its device inventory, or null when it reports none.
 *
 * @param options       - Lookup inputs.
 * @param options.mac   - The device MAC to look for.
 * @param options.state - The controller's state store.
 *
 * @returns The record the controller reports for the MAC, or null.
 */
export function deviceConfigByMac(options: { mac: string; state: StoreReadSurface }): Nullable<ProtectDeviceConfig> {

  const { mac, state } = options;

  return deviceInventory(state).find((config) => config.mac === mac) ?? null;
}

/**
 * The answer the address override rule gives for one controller: absent when no override is configured, resolved with the address the cameras' RTSP URLs are composed
 * against, or refused with the configured address a URL cannot carry, which the caller names in its warning.
 */
export type OverrideAddressResolution = { kind: "absent" } | { address: string; kind: "resolved" } | { address: string; kind: "refused" };

/**
 * The warning a caller says once for an override the address override rule refuses, as a format string logged with the refused address. It lives beside the rule
 * rather than in the rule's answer, which stays a pure resolution, so every caller that resolves an override says the one sentence.
 */
export const OVERRIDE_ADDRESS_ZONE_WARNING = "The override address %s carries an IPv6 zone, which a camera stream address cannot include. Cameras on this controller " +
  "will use the address the controller reports for each of them instead.";

/**
 * Resolve the address override for a controller's cameras: the address override option, else the legacy per-controller override property, with an option enabled but
 * left empty counting as absent, so an emptied field falls through to the legacy property rather than resolving against nothing. The address is free text, and an
 * IPv6 address carrying a zone cannot stand in a URL, so such an override is refused, and each camera resolves its RTSP URLs against the address the controller
 * reports for it instead. formatUrlHost is the judge of what a URL can carry, the same formatter the RTSP URLs are composed through, so the check and the composition
 * can never disagree. The controller root resolves through this one rule, and so does the test double the device suites run against.
 *
 * @param options        - Override inputs.
 * @param options.legacy - The legacy per-controller override property, undefined when it is not set.
 * @param options.option - The address override option's value at controller scope, null or undefined when the option sets none.
 *
 * @returns The resolution: absent, resolved with the address, or refused with the address set aside.
 */
export function resolveOverrideAddress(options: { legacy: string | undefined; option: Nullable<string | undefined> }): OverrideAddressResolution {

  const { legacy, option } = options;
  const address = (option?.length ? option : undefined) ?? legacy;

  if(address === undefined) {

    return { kind: "absent" };
  }

  try {

    formatUrlHost(address);
  } catch {

    return { address, kind: "refused" };
  }

  return { address, kind: "resolved" };
}
