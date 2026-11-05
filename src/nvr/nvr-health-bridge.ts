/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * nvr-health-bridge.ts: The controller's health diagnostics, as a companion between the library's observability wire and the root's decisions.
 *
 * The unifi-protect library publishes what it sees - every request outcome, every livestream recovery episode, every throttle - on process-global diagnostics channels
 * and on its connection monitor. This module owns the whole translation of that wire into the controller's health picture: which feeds become symptoms, how a state
 * change is narrated to the user, and whether observation is open at all. The design follows three principles:
 *
 *   1. Observation and narration here, execution at the root. The bridge holds no controller reference and reads no controller state. It answers the wire, it writes
 *      the state-transition lines through the injected log, and the one act reaching beyond itself - re-evaluating the removal-stability clock - is reached through
 *      the narrow {@link HealthBridgeActions} surface handed at construction. That is what keeps this a translation rather than a second controller.
 *
 *   2. Wire events and pushed facts are the only inputs. The channels and the connection rails supply the symptoms; the root pushes the lifecycle phase through
 *      {@link DiagnosticsHealthBridge.notePhase} and clears the history through {@link DiagnosticsHealthBridge.reset}. Nothing else can move the health picture, and
 *      the device graph never crosses - it arrives as the `ownsCamera` predicate alone.
 *
 *   3. The observer is wrapped, not absorbed. {@link NvrHealth} keeps the mechanism: the symptom buffer, the eviction window, the thresholds, the hysteresis. The
 *      bridge constructs exactly one, is its only `stateChange` listener, and republishes its state through a read-through getter, so the health arithmetic stays
 *      where it is already tested.
 *
 * The bridge is constructed once per controller and never rebuilt. Its channel subscriptions are process-global and detach on the controller's lifetime signal, while
 * the two connection rails are re-subscribed against each fresh client and handed back to the root to own alongside its other per-client subscriptions.
 */
import type { Clock, HomebridgePluginLogging } from "homebridge-plugin-utils";
import type { HttpRequestEndPayload, LivestreamRecoveryRecoveredPayload, LivestreamRecoveryStartedPayload } from "unifi-protect";
import { isRequestForController, isSuccessfulRequest } from "./nvr-policy.ts";
import { NvrHealth } from "./nvr-health.ts";
import type { NvrHealthState } from "./nvr-health.ts";
import type { NvrPhase } from "./nvr.ts";
import { exhaustiveGuard } from "../types.ts";
import { channels as protectChannels } from "unifi-protect";

/**
 * The act the bridge's decisions run, handed in at construction. It touches the controller's removal-stability clock, which is the root's territory, so the bridge
 * reaches it only through this surface and never holds the controller itself.
 */
export interface HealthBridgeActions {

  // Re-evaluate the controller's removal-stability clock. Health is one of the facts that decision rests on, so this runs on EVERY health transition - the silent
  // hysteresis step included, because a step toward recovery still moves the fact the conjunction reads.
  refreshRemovalStability: () => void;
}

/**
 * Construction options for {@link DiagnosticsHealthBridge}.
 */
export interface DiagnosticsHealthBridgeOptions {

  actions: HealthBridgeActions;
  // This controller's configured address. The library's HTTP diagnostics channel carries every request from every client in the process, so an exact host match
  // against this address is what scopes the request-outcome feed to this controller's own traffic.
  address: string;
  // The time source the bridge stamps every symptom from, handed on to the health observer as its eviction-window reference.
  clock: Clock;
  log: HomebridgePluginLogging;
  // Whether a camera id belongs to this controller's devices. The livestream channels are process-global too, and this narrow predicate is the only form the root's
  // graph knowledge takes here.
  ownsCamera: (cameraId: string) => boolean;
  // The controller's lifetime signal. The channel subscriptions detach on its abort, so teardown leaves nothing bound to a process-global channel.
  signal: AbortSignal;
}

/**
 * The connection surface the bridge consumes: the two throttle rails and nothing else. Expressing the dependency structurally rather than as the library's concrete
 * connection monitor keeps the bridge unable to reach the rest of the connection, and both callers satisfy it without a cast - the production monitor by its wider
 * event union, a test's recording double natively.
 *
 * The honest limit: method-parameter bivariance means a source implementing only ONE of the two rails would also assign, so this tells a wrong contract apart rather
 * than a partial one. Production implements the full connection event union and the test double implements both rails, so the residual is documented rather than
 * guarded against.
 */
export interface ThrottleRailSource {

  on(event: "throttleEntered" | "throttleExited", handler: () => void): Disposable;
}

/**
 * The health diagnostics for one controller: the observer, the wire feeding it, and the user-facing narration of every state it moves through.
 */
export class DiagnosticsHealthBridge {

  readonly #actions: HealthBridgeActions;

  readonly #address: string;

  readonly #clock: Clock;

  readonly #health: NvrHealth;

  readonly #log: HomebridgePluginLogging;

  readonly #ownsCamera: (cameraId: string) => boolean;

  readonly #signal: AbortSignal;

  // Whether the diagnostics channels are already attached. The guard behind wireDiagnostics being safe to call more than once: a second subscription to the same
  // channel would weigh every wire event twice.
  #wired = false;

  public constructor(options: DiagnosticsHealthBridgeOptions) {

    this.#actions = options.actions;
    this.#address = options.address;
    this.#clock = options.clock;
    this.#log = options.log;
    this.#ownsCamera = options.ownsCamera;
    this.#signal = options.signal;
    this.#health = new NvrHealth(options.clock);

    /* Born suspended, matching the controller's `connecting` posture at construction: no organic baseline exists yet against which stress could be weighed, and the
     * errors of initial credential validation are real without being evidence of controller load. No symptom can slip in ahead of this regardless, because no feed
     * is attached until wireDiagnostics runs - the construction window carries no subscription at all, by structure rather than by ordering.
     */
    this.#health.suspend();

    // Surface health transitions at the NVR level. Per-component logs (per-camera stalls, per-request errors) are demoted to debug under non-healthy state...the
    // user already has the explanatory NVR-level signal and does not need an N-camera fan-out of correlated noise.
    //
    // Direction-aware rules keep the narrative coherent for an operator scanning the log:
    //
    //   - Recovery is logged at info, because it is good news and asks nothing of anyone. An operator scanning warnings for "is anything currently broken?" reads
    //     the alerts alone, and the line that closes them sits among the controller's other lifecycle lines.
    //   - The hysteresis step from `stressed` back to `degraded` is silent. That transition means recovery is in progress, not that things are getting worse,
    //     and logging "responding slowly..." on the way down would read as a fresh alert. The next transition (`degraded` -> `healthy`) is the one worth
    //     surfacing.
    this.#health.on("stateChange", (next, previous) => {

      switch(next) {

        case "healthy":

          this.#log.info("The Protect controller is responsive again.");

          break;

        case "degraded":

          if(previous === "stressed") {

            // Hysteresis step on the way down. The closing line fires when we hit healthy.
            break;
          }

          this.#log.warn("The Protect controller is responding slowly or with intermittent errors. Reducing reconnect attempts until conditions improve.");

          break;

        case "stressed":

          this.#log.warn("The Protect controller is under sustained load. Pausing background operations until conditions improve. Active recordings and live " +
            "streams continue.");

          break;

        default:

          exhaustiveGuard(next);
      }

      // Re-evaluate the removal stability clock - health is one of the facts `good` depends on. A drop out of healthy resets the clock and cancels every pending
      // removal; a return to healthy (with phase running and the connection healthy) re-stamps it and re-arms the sweep.
      this.#actions.refreshRemovalStability();
    });
  }

  /**
   * Follow the controller's lifecycle phase. Observation is open only in `running`: every other phase is initial setup, an induced disruption, or termination, and
   * none of them is an organic baseline against which stress can be meaningfully weighed.
   *
   * @param phase - The controller's current lifecycle phase.
   */
  public notePhase(phase: NvrPhase): void {

    if(phase === "running") {

      this.#health.resume();
    } else {

      this.#health.suspend();
    }
  }

  /**
   * Clear the health history, so what came before a reconnect no longer biases what follows it. The observer deliberately emits no state change on a reset, which is
   * what keeps a reconnect from narrating a "responsive again" line the user never had a matching alert for.
   */
  public reset(): void {

    this.#health.reset();
  }

  /**
   * The controller's current health. The read every stress-aware decision consults - the root's good-state conjunction and the livestream recovery policy alike.
   */
  public get state(): NvrHealthState {

    return this.#health.state;
  }

  /**
   * Translate a client's throttle rails into health symptoms, returning both subscriptions for the caller to own. The bridge holds nothing on this half: the rails
   * belong to a single client and are replaced along with it, so their lifetime stays in the root's one array of per-client subscriptions, where a single home is
   * what leaves the per-connect rebuild and the disconnect drain impossible to half-apply.
   *
   * Stateless, so a repeat call simply subscribes a fresh pair and the caller's array replacement is what retires the previous one.
   *
   * @param connection - The client's connection monitor, consumed as its two throttle rails alone.
   *
   * @returns The two rail subscriptions, in the caller's ownership.
   */
  public wireClient(connection: ThrottleRailSource): Disposable[] {

    return [

      connection.on("throttleEntered", () => this.#health.observe({ at: this.#clock.now(), kind: "libraryThrottleEntered" })),
      connection.on("throttleExited", () => this.#health.observe({ at: this.#clock.now(), kind: "libraryThrottleReleased" }))
    ];
  }

  /**
   * Attach the health feeds to the unifi-protect library's process-global diagnostics channels. This is a separate act from construction because the root wires only
   * past its credential guard, which is what keeps a misconfigured controller from ever subscribing.
   *
   * These channels carry the feeds. `http:request:end` is the request-outcome half: a 2xx is recovery evidence and everything else - a transport error, or a non-2xx
   * status - is a stress symptom, scoped to this controller by an exact host match. `recovery:started` (a stream was disrupted and an episode begins) and
   * `recovery:recovered` (it resumed) are the livestream half: one stress symptom per disruption episode and one recovery symptom per recovery, so a recovered
   * episode nets zero while a failed one stays +1 - correct stress accounting with no double count. The recovery-lifecycle channels are chosen over the narrower
   * `stall:detected` deliberately: every detected stall begins an episode, so consuming both would double-count, and the episode edge also catches the socket-close
   * disruptions the stall channel never sees. `recovery:exhausted` feeds no symptom - a given-up episode is the root's ledger and narration territory - and
   * `session:closed` / `codec:changed` are neither health nor log signals.
   *
   * Safe to call more than once: a repeat call is a no-op, so no wire event can ever be weighed twice.
   */
  public wireDiagnostics(): void {

    if(this.#wired) {

      return;
    }

    this.#wired = true;

    // The request-outcome feed. The channel carries every request from every client in the process, so we filter on an exact host match - the payload's reported host
    // equals this controller's configured address, both descending from the same address the controller passes to ProtectClient.connect() - to keep each controller's
    // health scoped to its own traffic. Observation is gated by the observer's suspend/resume, so symptoms during connecting or induced disruptions are dropped.
    const onRequestEnd = (message: unknown): void => {

      const payload = message as HttpRequestEndPayload;

      if(!isRequestForController({ address: this.#address, host: payload.host })) {

        return;
      }

      this.#health.observe({ at: this.#clock.now(), kind: isSuccessfulRequest(payload) ? "apiSuccess" : "apiError" });
    };

    /* The livestream feeds. Both filter to this controller's own cameras: the channels are shared by every controller in the process, so an unfiltered symptom would
     * let another controller's trouble weigh on this one's health. A package-camera stream carries its PARENT camera's device id, so the predicate resolves the
     * parent and the symptom is attributed there - correct, since there is no separate package-camera device to attribute it to.
     */
    const onRecoveryStarted = (message: unknown): void => {

      const payload = message as LivestreamRecoveryStartedPayload;

      if(!this.#ownsCamera(payload.cameraId)) {

        return;
      }

      this.#health.observe({ at: this.#clock.now(), cameraId: payload.cameraId, kind: "livestreamStall" });
    };

    const onRecoveryRecovered = (message: unknown): void => {

      const payload = message as LivestreamRecoveryRecoveredPayload;

      if(!this.#ownsCamera(payload.cameraId)) {

        return;
      }

      this.#health.observe({ at: this.#clock.now(), cameraId: payload.cameraId, kind: "livestreamRecovery" });
    };

    protectChannels.httpRequestEnd.subscribe(onRequestEnd);
    protectChannels.livestreamRecoveryStarted.subscribe(onRecoveryStarted);
    protectChannels.livestreamRecoveryRecovered.subscribe(onRecoveryRecovered);

    // Detach every subscription on the controller's lifetime signal. The library's channels are process-global and outlive any single client, so an explicit
    // unsubscribe at teardown is what keeps these subscriptions leak-free.
    this.#signal.addEventListener("abort", () => {

      protectChannels.httpRequestEnd.unsubscribe(onRequestEnd);
      protectChannels.livestreamRecoveryStarted.unsubscribe(onRecoveryStarted);
      protectChannels.livestreamRecoveryRecovered.unsubscribe(onRecoveryRecovered);
    }, { once: true });
  }
}
