/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-nvr-policy.ts: Pure decision logic for the NVR controller root.
 *
 * The three decisions the v5 controller-root inversion introduces - the startup-resilient connect retry policy, the HomeKit-membership set diff that subsumes the v4
 * poll-and-event device sync, and the request-outcome classifier that feeds NvrHealth - are pure functions of their inputs. They live here, in a dependency-light leaf,
 * rather than inside the ProtectNvr composition root, for the same reason v5 keeps its reducer pure and apart from its client and HBUP keeps the NvrHealth reducer apart
 * from its event-sink wrapper: a decision separated from the effect it drives is independently testable, and the test is the proof the separation is real. ProtectNvr
 * transitively imports the entire device and media graph (cameras, streaming, snapshots); a 5-line set diff should never have to stand that up to be exercised. This
 * module imports only the auth-error type it branches on and the shared failure-limit constant, so it loads and tests in isolation.
 */
import { PROTECT_AUTH_FAILURE_LIMIT } from "./settings.ts";
import { ProtectAuthError } from "unifi-protect";

/**
 * The startup-resilient connect retry policy, as a pure stateful predicate factory. Authentication faults get a small consecutive budget so a controller still sorting
 * out its own auth state recovers, but genuinely-wrong credentials fail fast rather than looping forever (the v4 defect that retried login indefinitely). Any non-auth
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
 * The HomeKit-membership delta between the controller's adopted-id set and the ids we have already configured, as a pure set diff. `toAdd` is the adopted ids we have
 * not configured; `toRemove` is the configured ids no longer adopted. This is the heart of the inversion that subsumes the v4 poll-driven sync and the event-driven
 * adopt/unadopt into one engine; isolating it makes the reconcile read as decision (this pure diff) then effect (add/remove). Order-preserving relative to the inputs.
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
 * Whether a completed HTTP request was successful, from v5's `http:request:end` diagnostic payload: no transport-level error, and a 2xx status. Everything else - a
 * transport error, an absent status, or a non-2xx response - is a failure. Isolated so the request-outcome-to-health-symptom mapping the NVR feeds into NvrHealth is
 * testable apart from the diagnostics-channel subscription that drives it.
 *
 * @param payload - The request-end payload (only `error` and `statusCode` are read).
 *
 * @returns `true` when the request succeeded.
 */
export function isSuccessfulRequest(payload: { error?: string; statusCode?: number }): boolean {

  return (payload.error === undefined) && (payload.statusCode !== undefined) && (payload.statusCode >= 200) && (payload.statusCode < 300);
}
