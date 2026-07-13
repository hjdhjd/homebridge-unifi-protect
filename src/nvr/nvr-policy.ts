/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * nvr-policy.ts: Pure decision logic for the NVR controller root.
 *
 * This module is the home for all of the controller root's pure decision logic, separated from the ProtectNvr composition root that acts on it. It holds the
 * startup-resilient connect retry policy, the HomeKit-membership set diff at the heart of device sync, the request-outcome classifier that feeds NvrHealth,
 * induced-disruption and reboot-recency gating, the induced-reboot resume decision, the per-episode livestream-recovery quiet latch, and the removal-stability
 * arithmetic. Each is a pure function of its inputs. They live here, in a dependency-light leaf, rather than inside the ProtectNvr composition root, for the same reason
 * the unifi-protect library keeps its reducer pure and apart from its client and the plugin keeps the NvrHealth reducer apart from its event-sink wrapper: a decision
 * separated from the effect it drives is independently testable, and the test is the proof the separation is real. ProtectNvr transitively imports the entire device and
 * media graph (cameras, streaming, snapshots); a 5-line set diff should never have to stand that up to be exercised. This module imports only the auth-error type it
 * branches on and the shared failure-limit constant, so it loads and tests in isolation.
 */
import type { ConnectionState } from "unifi-protect";
import type { Nullable } from "homebridge-plugin-utils";
import type { NvrPhase } from "./nvr.ts";
import { PROTECT_AUTH_FAILURE_LIMIT } from "../settings.ts";
import { ProtectAuthError } from "unifi-protect";

/**
 * The startup-resilient connect retry policy, as a pure stateful predicate factory. Authentication faults get a small consecutive budget so a controller still sorting
 * out its own auth state recovers, but genuinely-wrong credentials fail fast rather than looping forever. Any non-auth
 * fault (network, transient) resets the budget, so a slow-to-appear controller is retried without bound. A pure factory so the budget logic is testable without standing
 * up a client - the separation of the retry *decision* from the connect *effect*.
 *
 * @param limit - The consecutive-auth-failure ceiling. Defaults to {@link PROTECT_AUTH_FAILURE_LIMIT}.
 *
 * @returns A `shouldRetry` predicate suitable for the retry() options; it closes over the running consecutive-auth count.
 */
export function createConnectRetryPolicy(limit = PROTECT_AUTH_FAILURE_LIMIT): { shouldRetry: (error: unknown) => boolean } {

  let consecutiveAuth = 0;

  return {

    shouldRetry: (error: unknown): boolean => {

      if(error instanceof ProtectAuthError) {

        return ++consecutiveAuth < limit;
      }

      consecutiveAuth = 0;

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
 * organic startup/reconnection window where a disruption should still surface to the user. The recovery policy's induced-disruption guard consults this directly. The
 * per-camera disruption logs consult a SUPERSET - induced OR {@link isWithinRebootRecency} - because a controller reboot's post-return re-establishment blip fires
 * after the plugin has already concluded the reboot and left the induced phase, so the phase alone no longer recognizes that blip as the reboot's tail.
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
 * consumes at recovery; `forgetCamera` reclaims any entries a removed camera left behind (a started-without-recovery episode would otherwise never be consumed). The Map
 * is owned here, never exposed - mirroring createConnectRetryPolicy's encapsulated state.
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
 * The HomeKit-membership delta between the controller's adopted-id set and the ids we have already configured, as a pure set diff. `toAdd` is the adopted ids we have
 * not configured; `toRemove` is the configured ids no longer adopted. This single set diff drives the whole of device sync - one engine for both adoption and
 * unadoption; isolating it makes the reconcile read as decision (this pure diff) then effect (add/remove). Order-preserving relative to the inputs.
 *
 * @param adoptedIds    - The controller's current adopted ids for one device category.
 * @param configuredIds - The ids we have already configured in that category.
 *
 * @returns The ids to add and the ids to remove.
 */
export function membershipDelta(adoptedIds: readonly string[], configuredIds: readonly string[]): { toAdd: string[]; toRemove: string[] } {

  const adopted = new Set(adoptedIds);
  const configured = new Set(configuredIds);

  return { toAdd: adoptedIds.filter(id => !configured.has(id)), toRemove: configuredIds.filter(id => !adopted.has(id)) };
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
