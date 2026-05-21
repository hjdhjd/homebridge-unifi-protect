/* Copyright(C) 2019-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-livestream.ts: Protect livestream API manager.
 *
 * This module owns the pooled livestream connections for a single camera. One LivestreamManager instance lives on each ProtectCamera; it brokers access to the
 * underlying unifi-protect library (or FfmpegLivestreamProcess in the RTSP debug path) and provides an AsyncIterable subscription API to consumers.
 *
 * Architecture:
 *
 *   - A pooled LivestreamSession is created on the first subscribe() for a given (channel, lens) tuple. Subsequent subscriptions to the same tuple join the
 *     existing session via reference counting and share its underlying connection. A single websocket is multiplexed to N consumers via per-subscriber bounded
 *     queues...the session pushes each segment into every subscriber's queue, and each consumer pulls from its own queue independently.
 *
 *   - Each session is a finite-state machine modeled as a discriminated union with eight variants across three phases. Phase boundaries are encoded structurally:
 *     "provisioning-*" variants represent the bounded establishment phase, "live-*" variants represent the unbounded operational phase, and "terminated"
 *     represents the terminal phase. Crossing from provisioning into live is irreversible...the first segment ever delivered marks the transition.
 *
 *   - Timer ownership is structural. The provisioning deadline lives only in provisioning variants; the stall timer lives only in live-streaming; first-segment
 *     awaits, backoff timers, and so on each live in exactly the variant that owns them. Invalid timer/state combinations are unrepresentable in the type system.
 *     Switch statements over state.kind use a `never` exhaustiveness assertion in the default branch so adding a new variant fails to compile until every site is
 *     updated.
 *
 *   - Establishment is the phase boundary, not a side-channel boolean. The question "have we ever produced data" is answered by inspecting state.kind. There is
 *     no parallel field that could disagree with the FSM. Single source of truth.
 *
 *   - The consumer surface is AsyncIterable<Buffer> + AsyncDisposable. Consumers iterate segments via `for await` and dispose via `await using`. The first segment
 *     ever delivered both crosses the establishment boundary and resolves whenEstablished()...so once whenEstablished() returns true, subscription.initSegment is
 *     guaranteed non-null and consumers can use it directly without an async fallback. Terminal failures are typed exception classes thrown into the iterator:
 *     SessionEstablishmentError when provisioning never completed, SubscriberLagError when a slow consumer overflows its queue. Brief disconnects within the live
 *     phase are reported via an onDisconnect callback so consumers can flag downstream discontinuities (e.g., FFmpeg restart) without needing the data stream to
 *     terminate.
 *
 *   - Backpressure is per-subscriber. A slow consumer's queue overflow terminates only that subscriber (with SubscriberLagError); the session and other
 *     subscribers are unaffected. The original design's synchronous fan-out had no isolation...one slow handler blocked every other subscriber.
 */
import { FfmpegLivestreamProcess, type HomebridgePluginLogging } from "homebridge-plugin-utils";
import type { NvrHealthState } from "./protect-nvr-health.js";
import { PROTECT_SEGMENT_RESOLUTION } from "./settings.js";
import type { ProtectCamera } from "./devices/index.js";
import type { ProtectLivestream } from "unifi-protect";
import type { RtspEntry } from "./devices/protect-camera.js";

// Options passed to the ProtectLivestream.start() call. We ask for timestamps and a reasonable websocket chunk size.
const LIVESTREAM_OPTIONS = { chunkSize: 16384, emitTimestamps: true };

// Provisioning deadline, in milliseconds. The overall budget for getting a first segment out of a brand-new session...includes any number of internal connect
// attempts and backoff waits. When this deadline expires without ever delivering a segment the session is terminated with SessionEstablishmentError, all
// subscribers' iterators throw, and the session is removed from the pool. A subsequent subscribe() for the same tuple creates a fresh session.
const PROVISIONING_DEADLINE = 30 * 1000;

// Per-attempt first-segment timeout while provisioning, in milliseconds. Generous because the controller may need time to set up the camera's livestream endpoint
// after a connection is established. If this timer fires without a segment, we tear down the connection and back off before retrying. The provisioning deadline
// continues to run across all attempts.
const PROVISIONING_AWAIT_TIMEOUT = 8 * 1000;

// Backoff between provisioning attempts, in milliseconds. Constant rather than exponential because the deadline already bounds the total time...we want to
// retry promptly within the budget rather than slow down toward the end.
const PROVISIONING_BACKOFF = 2 * 1000;

// Stall-detection timeout while live-streaming, in milliseconds. If no segment arrives within this window we treat the stream as stalled and consult the
// recovery policy for what to do. Shorter than the library's 10-second heartbeat timeout so we catch stalls with our own recovery and backoff rather than
// letting the library's heartbeat fire with its noisier error logging.
const LIVE_STALL_TIMEOUT = 2 * 1000;

// Maximum duration, in milliseconds, that a deferred stall can soak before we force a reconnect anyway. Symmetric with LIVE_RESUME_AWAIT_TIMEOUT...8 seconds is
// already the codebase's "reasonable wait for a healthy session to deliver a segment," and reusing that constant of patience here keeps the per-session timing
// envelope coherent. Leaves a 2-second margin under the unifi-protect library's 10-second heartbeat so the library's own dead-stream detection remains a
// distinct safety net rather than a duplicate trigger.
const LIVE_DEFERRED_STALL_CEILING = 8 * 1000;

// First-segment timeout after a successful reconnect during the live phase, in milliseconds. Same envelope as the provisioning await...we just reconnected and
// are giving the controller time to resume segment delivery. If this fires we treat it as a failed reconnect and back off.
const LIVE_RESUME_AWAIT_TIMEOUT = 8 * 1000;

// Recovery backoff during the live phase, in milliseconds. Linear growth from base to cap...we don't have a hard deadline here (the stream proved itself
// once, environmental issues should be retried persistently) but we do throttle to avoid hammering the controller.
const LIVE_BACKOFF_BASE = 2 * 1000;
const LIVE_BACKOFF_INCREMENT = 5 * 1000;
const LIVE_BACKOFF_MAX = 30 * 1000;

// Consecutive internal recoveries before self-healing triggers a camera reboot. External recoveries (initiated by subscription.requestRestart()) do not count
// toward this threshold because they represent downstream failures, not livestream problems. The recovery counter resets to zero whenever a stall transitions
// the session out of live-streaming...so this threshold is reached only by sustained reconnect-failure sequences, never by transient stalls on a healthy stream.
const LIVE_SELF_HEAL_THRESHOLD = 10;

// Per-subscriber queue capacity, in segments. Each subscriber owns a bounded queue between the session's fan-out point and its own iteration cursor. Sized to
// absorb microsecond-scale jitter without indefinite growth...at our 100ms segment cadence this is roughly 1.6 seconds of buffering. A consumer that lags
// further than this is misbehaving and gets terminated with SubscriberLagError; the session and other subscribers continue unaffected.
const SUBSCRIBER_QUEUE_CAPACITY = 16;

// Public lifecycle observation for a subscription. Maps the internal FSM down to a stable contract for consumer code...internal refactors do not break it.
export type LivestreamSubscriptionState = "connecting" | "running" | "recovering" | "closed";

/**
 * Categorical urgency declared by the consumer of a subscription. The recovery policy reads the *highest* criticality across all subscribers on a session and
 * uses it as one of the inputs to its decision.
 *
 *   - `idle`: the consumer can tolerate brief upstream interruptions. The timeshift buffer maintaining a sliding window with no active HKSV recording is the
 *      canonical case. The session may opt to defer reconnects under controller stress because losing a few seconds of buffer maintenance is acceptable.
 *   - `active`: the consumer is doing latency-sensitive work that a deferred reconnect would harm. An HKSV event being recorded, an active HomeKit live-stream
 *      session, or a snapshot in progress all qualify. The session always reconnects immediately on stall regardless of controller health.
 *
 * Criticality is set via {@link LivestreamSubscription.elevateCriticality}, which returns a Disposable. The subscription stays elevated for as long as at least
 * one outstanding handle is held...holding handles composes naturally across overlapping consumers, and the `using` keyword (or explicit disposal) guarantees
 * cleanup even on exception or early return.
 */
export type SubscriberCriticality = "active" | "idle";

/**
 * The action a recovery policy returns when the session asks "what should I do about this stall?" Discriminated union so consumers exhaustively handle every
 * variant, with the FSM owning side effects and the policy owning decisions.
 *
 *   - `reconnect-now`: tear down the current connection and start a fresh one immediately. The classical recovery action.
 *   - `defer`: enter the `live-deferred` state and soak the stall for up to `ceilingMs` milliseconds. If a segment arrives during that window, we return to
 *      `live-streaming` without reconnecting. If the ceiling fires or a subscriber elevates criticality before then, we transition to `live-reconnecting`.
 */
export type RecoveryAction =
  { kind: "reconnect-now" } |
  { ceilingMs: number; kind: "defer" };

/**
 * Inputs to a recovery policy. Constructed by the manager from the live state at the moment a stall is detected; passed by value so the policy is a pure
 * function of these inputs.
 */
export interface RecoveryInput {

  // Total recovery attempts on this session so far. Threaded into the action so the FSM's backoff counter advances correctly.
  readonly attempts: number;

  // The highest criticality across all subscribers on the session at the moment of the stall.
  readonly criticality: SubscriberCriticality;

  // The current state of the controller as observed by the NVR-level health observer.
  readonly health: NvrHealthState;
}

/**
 * Pure-function recovery policy. Maps the explicit set of inputs to a typed action. Pure functions are great when there is no realistic second implementation
 * and no stateful policy behavior...both true here. Tests inject a fake by passing a different function reference.
 */
export type RecoveryPolicy = (input: RecoveryInput) => RecoveryAction;

/**
 * The plugin's default recovery policy.
 *
 * Decision matrix:
 *
 *   | Criticality | Health     | Action                                  |
 *   |-------------|------------|-----------------------------------------|
 *   | active      | any        | reconnect-now                           |
 *   | idle        | healthy    | reconnect-now                           |
 *   | idle        | degraded   | defer to LIVE_DEFERRED_STALL_CEILING    |
 *   | idle        | stressed   | defer to LIVE_DEFERRED_STALL_CEILING    |
 *
 * Reasoning: an `active` subscriber means HKSV is recording, a HomeKit live stream is open, or another latency-sensitive consumer is in flight. The pacing
 * system in the recording delegate provides a generous catch-up budget for the next reconnect to land successfully, but only if the reconnect is *attempted*
 * promptly. We always reconnect-now for active. For `idle` plus a healthy controller the cost of reconnecting is small and the behavior matches the prior
 * fast-recovery default. For `idle` plus a non-healthy controller we defer: reconnecting amplifies the stress that's already being seen and would likely fail
 * anyway, so we let the upstream try to recover on its own and let the ceiling catch the cases where it doesn't.
 */
const defaultRecoveryPolicy: RecoveryPolicy = (input): RecoveryAction => {

  if(input.criticality === "active") {

    return { kind: "reconnect-now" };
  }

  if(input.health === "healthy") {

    return { kind: "reconnect-now" };
  }

  return { ceilingMs: LIVE_DEFERRED_STALL_CEILING, kind: "defer" };
};

/**
 * Thrown into a subscription's iterator when the session terminates without ever delivering a segment. The provisioning phase exhausted its deadline. Consumers
 * should treat this as "this stream never came up" and decide whether to retry with a fresh subscribe().
 */
export class SessionEstablishmentError extends Error {

  public constructor(message: string, options?: ErrorOptions) {

    super(message, options);
    this.name = "SessionEstablishmentError";
  }
}

/**
 * Thrown into a subscription's iterator when its per-subscriber queue overflows because the consumer is not pulling fast enough. Only this subscriber is
 * terminated...the underlying session and any other subscribers continue unaffected. The original cause (the underlying queue overflow) is preserved via
 * Error.cause for diagnostics.
 */
export class SubscriberLagError extends Error {

  public constructor(message: string, options?: ErrorOptions) {

    super(message, options);
    this.name = "SubscriberLagError";
  }
}

/**
 * Shared classification and logging for errors thrown from a livestream subscription iterator. Used by all consumers so the typed-error handling lives in
 * exactly one place: SessionEstablishmentError is suppressed (already surfaced to the caller via whenEstablished() returning false, logging here would
 * duplicate the failure), SubscriberLagError surfaces a single user-friendly sentence at error level with the full error chain at debug for diagnostics, and
 * anything else is treated as unexpected. `consumer` is the subject of the log sentence (e.g. "Timeshift buffer", "Live streaming").
 */
export function logLivestreamIterationError(error: unknown, log: HomebridgePluginLogging, consumer: string): void {

  if(error instanceof SubscriberLagError) {

    // We surface a single sentence at error level so users see what happened and the most likely cause without a wall of stack frames. The full error chain,
    // including the QueueFullError cause, goes to debug for diagnostics.
    log.error(consumer + " fell behind the livestream and was disconnected. This typically indicates the Protect controller is under load.");
    log.debug(consumer + " lag termination details.", { error });

    return;
  }

  if(error instanceof SessionEstablishmentError) {

    return;
  }

  log.error(consumer + " iteration terminated unexpectedly.", { error });
}

/**
 * A subscription to a pooled Protect livestream for a single (channel, lens) tuple. Obtain one via LivestreamManager.subscribe(), iterate segments via `for
 * await`, and dispose via `await using`.
 *
 * Multiple subscribers on the same tuple share the underlying connection via internal reference counting...the connection is established on the first
 * subscribe() and torn down when the last subscription is disposed. Each subscription owns its own per-subscriber queue, so a slow consumer cannot block other
 * subscribers or the session itself.
 *
 * Iteration semantics: each subscription is its own iterator (calling `[Symbol.asyncIterator]()` returns `this`). Multiple consumers should each call
 * subscribe() to get their own subscription rather than sharing one...sharing would race for segments because next() is single-cursor.
 */
export interface LivestreamSubscription extends AsyncIterable<Buffer>, AsyncIterator<Buffer>, AsyncDisposable {

  readonly channel: number;

  // Stable per-subscription identity assigned at construction and never reused. Consumers that need to discriminate "is this the same subscription I was
  // iterating on?" across lifecycle transitions should compare ids rather than relying on object reference equality, which can silently fail under proxies,
  // wrappers, or decorators that may be introduced in the future.
  readonly id: string;
  readonly lens: number | undefined;

  // Synchronous peek at the fMP4 initialization segment, or null if not yet received. Guaranteed non-null inside the iteration loop body...the underlying library
  // delivers the init segment before the first regular segment.
  readonly initSegment: Buffer | null;

  // Public lifecycle observation. Maps the internal FSM to a stable four-variant contract...consumers compare against the literal strings in
  // LivestreamSubscriptionState rather than peeking at the internal FSM.
  readonly state: LivestreamSubscriptionState;

  /**
   * Current categorical criticality of this subscription. Aggregated across all subscribers on a session by the manager when deciding recovery policy. Reads
   * `active` while at least one elevation handle returned by {@link elevateCriticality} is outstanding; otherwise `idle`.
   */
  readonly criticality: SubscriberCriticality;

  /**
   * Elevate this subscription to `active` for the duration of the returned handle's lifetime. Composes via reference counting...multiple handles can be held
   * concurrently, and the subscription stays elevated until every handle is disposed. Pair with `using` for scope-bound elevation that cannot leak across early
   * returns or exceptions:
   *
   * ```ts
   * async function record(...): Promise<void> {
   *
   *   using _elevation = subscription.elevateCriticality();
   *
   *   // ...recording lifecycle...
   *
   *   // _elevation auto-disposes here, restoring criticality if this was the last handle.
   * }
   * ```
   */
  elevateCriticality(): Disposable;

  /**
   * Register a callback for visible disconnect events. Fires when the underlying connection is interrupted in a way that breaks segment continuity (stall
   * recovery, controller-initiated close, downstream restart request). Brief and transparent reconnects do not cause iteration to terminate...the iterator just
   * pauses and resumes when segments flow again. The callback is the side-channel that lets consumers flag a discontinuity for downstream processing (e.g., the
   * timeshift buffer flagging a pending discontinuity for the recording delegate).
   *
   * The callback receives `external: true` when the disconnect was initiated by the controller (a close event), and `external: false` when it was initiated by
   * our own stall recovery or a downstream requestRestart(). Consumers can use this to suppress redundant log messages for self-initiated recoveries.
   */
  onDisconnect(handler: (info: { external: boolean }) => void): void;

  /**
   * Resolves true once the session has produced its first segment (the establishment phase boundary), or false if the session terminates before establishing.
   * Callers typically await this immediately after subscribing to know that initSegment is available and segments are about to flow.
   */
  whenEstablished(): Promise<boolean>;

  /**
   * Request an external-initiated recovery of the underlying connection. Used by downstream consumers when their own processing has failed (e.g., FFmpeg timed
   * out during HKSV recording) and they need a fresh connection even though the underlying livestream may be healthy. No-op if the session is not in a state
   * where recovery makes sense (e.g., already recovering, or terminated).
   */
  requestRestart(): void;

  /**
   * Explicit asynchronous disposal. Idempotent...subsequent calls after the first are no-ops. Closes this subscription's iterator (any pending next() resolves
   * with done:true), removes it from the session's subscriber set, and tears down the underlying connection if this was the last subscriber. Compose with
   * `await using` for guaranteed disposal across early returns and exceptions.
   */
  [Symbol.asyncDispose](): Promise<void>;
}

// Internal FSM state. Modeled as a discriminated union across three phases. Provisioning variants are bounded by a deadline timer; live variants are unbounded
// (subject only to the self-heal threshold for consecutive recoveries). Each variant carries exactly the timers it owns.
type SessionState =
  // Provisioning phase: establishing the stream for the first time. Bounded by the overall deadline timer.
  // - connecting: a connect attempt is in flight (await on session.connection.start()).
  // - awaiting: the connection succeeded; we're waiting for the first segment.
  // - backoff: an attempt failed (connect failed, await timed out, or close fired); we're waiting before retrying.
  { deadline: NodeJS.Timeout; kind: "provisioning-connecting" } |
  { awaitTimer: NodeJS.Timeout; deadline: NodeJS.Timeout; kind: "provisioning-awaiting" } |
  { backoffTimer: NodeJS.Timeout; deadline: NodeJS.Timeout; kind: "provisioning-backoff" } |

  // Live phase: at least one segment has been delivered. Recovery is unbounded; the session continues retrying until self-heal triggers a camera reboot or the
  // last subscriber disposes.
  // - streaming: segments are flowing; stallTimer fires if none arrives.
  // - deferred: a stall fired while no subscriber was urgent and the controller was non-healthy; we are soaking the stall instead of reconnecting. A segment
  //   arrival returns us to streaming; the ceiling timer or a subscriber elevation forces a reconnect.
  // - resuming: just reconnected after a recovery; awaiting first segment with a longer timeout than the steady-state stall timer.
  // - reconnecting: a recovery attempt is in flight (connection.stop() then connection.start()).
  // - backoff: a recovery attempt failed; waiting before the next try.
  { kind: "live-streaming"; stallTimer: NodeJS.Timeout } |
  { ceilingTimer: NodeJS.Timeout; kind: "live-deferred"; stallStartTime: number } |
  { awaitTimer: NodeJS.Timeout; kind: "live-resuming"; recoveryAttempts: number } |
  { isExternal: boolean; kind: "live-reconnecting"; recoveryAttempts: number } |
  { backoffTimer: NodeJS.Timeout; kind: "live-backoff"; recoveryAttempts: number } |

  // Terminated phase: terminal. The reason discriminates how subscribers' iterators are closed.
  // - establishment-failed: provisioning deadline expired without ever delivering a segment. Subscribers throw SessionEstablishmentError.
  // - disposed: last subscriber released the session. Subscribers' iterators close gracefully (return done:true). Should not happen in practice (the session is
  //   removed from the pool when the last subscriber leaves), but included for completeness.
  // - shutdown: manager shutdown was called (typically NVR disconnect). Subscribers' iterators close gracefully.
  { kind: "terminated"; reason: TerminationReason };

type TerminationReason = "disposed" | "establishment-failed" | "shutdown";

// One pooled livestream session. Created on the first subscribe() for a (channel, lens) tuple and torn down when the last subscription is disposed (or on
// manager shutdown). The segmentHandler and closeHandler are bound arrow functions stored on the session so attach/detach on the underlying connection use the
// exact same reference.
interface LivestreamSession {

  readonly channel: number;
  readonly closeHandler: () => void;
  readonly connection: FfmpegLivestreamProcess | ProtectLivestream;
  readonly index: string;
  readonly lens: number | undefined;
  readonly segmentHandler: (segment: Buffer) => void;
  readonly segmentLength: number;
  readonly subscriptions: Set<LivestreamSubscriptionImpl>;

  // The establishment promise. Resolved true on the first segment ever (transition from provisioning-awaiting to live-streaming). Resolved false on terminal
  // termination during provisioning. Subscribers' whenEstablished() returns this promise.
  establishedPromise: Promise<boolean>;
  establishedResolve?: (value: boolean) => void;

  // Timestamp of the most recent segment delivered by the underlying connection. Undefined until the first segment arrives. Used by the recovery path to
  // report "last segment Ns ago" so users can distinguish a quick transient stall from a multi-minute outage.
  lastSegmentTime?: number;

  state: SessionState;
}

// Sentinel errors thrown from AsyncQueue.enqueue so callers can distinguish overflow from closed-while-enqueueing without parsing message strings. Internal
// to this module; consumers see the wrapped SubscriberLagError instead.
class QueueClosedError extends Error {

  public constructor() {

    super("Queue is closed.");
    this.name = "QueueClosedError";
  }
}

class QueueFullError extends Error {

  public constructor() {

    super("Queue is full.");
    this.name = "QueueFullError";
  }
}

/**
 * Per-subscriber bounded queue. Pushes from the session's segment fan-out, pulls from the consumer's iterator. Close has "stop now" semantics: any items still
 * buffered at close time are discarded, pending pulls resolve with done:true (graceful close) or reject with the supplied error (errored close). This matches
 * the livestream semantic where post-close items are stale segments tied to a torn-down connection. Enqueue throws QueueClosedError or QueueFullError;
 * callers decide policy.
 */
class AsyncQueue<T> {

  private closeError: Error | null;
  private closed: boolean;
  private items: T[];
  private readonly maxSize: number;
  private readonly waiters: { reject: (e: unknown) => void; resolve: (v: IteratorResult<T>) => void }[];

  public constructor(maxSize: number) {

    this.closeError = null;
    this.closed = false;
    this.items = [];
    this.maxSize = maxSize;
    this.waiters = [];
  }

  // Enqueue a value. If a consumer is already awaiting a value, deliver it directly. Otherwise buffer it. Throws QueueClosedError or QueueFullError so callers
  // can distinguish termination-after-close from overflow.
  public enqueue(value: T): void {

    if(this.closed) {

      throw new QueueClosedError();
    }

    const waiter = this.waiters.shift();

    if(waiter) {

      waiter.resolve({ done: false, value: value });

      return;
    }

    if(this.items.length >= this.maxSize) {

      throw new QueueFullError();
    }

    this.items.push(value);
  }

  // Dequeue. Resolves with the next value, or { done: true } on graceful close, or rejects with the close error on errored close. Once closed, buffered items
  // are discarded...post-close pulls always return done:true (or reject) immediately.
  // eslint-disable-next-line @typescript-eslint/promise-function-async
  public dequeue(): Promise<IteratorResult<T>> {

    if(this.closed) {

      return this.closeError ? Promise.reject(this.closeError) : Promise.resolve({ done: true, value: undefined });
    }

    if(this.items.length > 0) {

      return Promise.resolve({ done: false, value: this.items.shift() as T });
    }

    return new Promise<IteratorResult<T>>((resolve, reject): void => {

      this.waiters.push({ reject: reject, resolve: resolve });
    });
  }

  // Close the queue with "stop now" semantics. Buffered items are discarded (the producer's already-published-but-not-yet-consumed values are dropped). With no
  // error, pending pulls resolve with done:true and future pulls return done:true. With an error, pending pulls reject and future pulls reject with the same
  // error.
  public close(error?: Error): void {

    if(this.closed) {

      return;
    }

    this.closed = true;
    this.closeError = error ?? null;
    this.items = [];

    for(const waiter of this.waiters) {

      if(error) {

        waiter.reject(error);
      } else {

        waiter.resolve({ done: true, value: undefined });
      }
    }

    this.waiters.length = 0;
  }
}

/**
 * Internal subscription implementation. Not exported...consumers see only the LivestreamSubscription interface. The subscription owns a per-subscriber AsyncQueue
 * for segment delivery; each call to next() pops one segment from the queue (or awaits if empty). Termination is signaled by closing the queue: gracefully (the
 * iterator returns done:true) or with a typed error (the iterator throws).
 *
 * The subscription IS its own iterator. [Symbol.asyncIterator]() returns this. Multiple consumers should each subscribe() rather than sharing one subscription.
 */
class LivestreamSubscriptionImpl implements LivestreamSubscription {

  // Process-local monotonic counter used to mint stable subscription ids. A counter is sufficient here (no cross-process uniqueness needed) and keeps ids
  // cheap, comparable, and greppable in logs.
  private static instanceCounter = 0;

  public readonly channel: number;
  public readonly id: string;
  public readonly lens: number | undefined;

  // Outstanding count of elevation handles. The subscription is `active` while at least one handle is held; `idle` otherwise. Tracked as a refcount so multiple
  // overlapping consumers compose naturally - acquiring two handles does not double-elevate, and releasing one of two leaves the subscription elevated.
  private criticalityRefCount: number;

  private disconnectHandler?: (info: { external: boolean }) => void;
  private disposed: boolean;
  private readonly manager: LivestreamManager;
  private readonly queue: AsyncQueue<Buffer>;
  private readonly session: LivestreamSession;

  public constructor(manager: LivestreamManager, session: LivestreamSession) {

    this.channel = session.channel;
    this.criticalityRefCount = 0;
    this.disposed = false;
    this.id = "sub-" + session.index + "-" + (++LivestreamSubscriptionImpl.instanceCounter).toString();
    this.lens = session.lens;
    this.manager = manager;
    this.queue = new AsyncQueue<Buffer>(SUBSCRIBER_QUEUE_CAPACITY);
    this.session = session;
  }

  // Synchronous peek at the init segment via the underlying connection's getter.
  public get initSegment(): Buffer | null {

    return this.session.connection.initSegment ?? null;
  }

  // Public state observation. Maps the eight-variant FSM down to four stable consumer-facing states. Exhaustive over SessionState.kind...adding a new variant
  // without updating this mapping fails to compile.
  public get state(): LivestreamSubscriptionState {

    if(this.disposed) {

      return "closed";
    }

    const kind = this.session.state.kind;

    switch(kind) {

      case "provisioning-connecting":
      case "provisioning-awaiting":
      case "provisioning-backoff":

        return "connecting";

      case "live-streaming":

        return "running";

      case "live-deferred":
      case "live-resuming":
      case "live-reconnecting":
      case "live-backoff":

        return "recovering";

      case "terminated":

        return "closed";

      default: {

        const exhaustive: never = kind;

        throw new Error("Unhandled session state in LivestreamSubscription.state: " + String(exhaustive));
      }
    }
  }

  // Current categorical criticality. Derived from the elevation refcount: any outstanding handle puts us in `active`; otherwise `idle`. O(1) read.
  public get criticality(): SubscriberCriticality {

    return (this.criticalityRefCount > 0) ? "active" : "idle";
  }

  // Acquire an elevation handle. Bumps the refcount and, if this is the 0->1 transition, notifies the manager so it can re-evaluate any in-flight deferred-stall
  // state on the session (an elevation while in `live-deferred` is the trigger to escalate to immediate reconnect). The returned Disposable releases the
  // elevation on dispose; pair with `using` for guaranteed scope-bound elevation.
  public elevateCriticality(): Disposable {

    if(this.disposed) {

      // The subscription has already been disposed. We still hand back a no-op disposable so callers using `using` don't crash...the consumer's intent was
      // expressed but cannot affect a torn-down session.
      return { [Symbol.dispose]: (): void => { /* No-op: subscription disposed before elevation. */ } };
    }

    const wasIdle = (this.criticalityRefCount === 0);

    this.criticalityRefCount++;

    if(wasIdle) {

      this.manager.onSubscriberCriticalityChange(this.session);
    }

    let released = false;

    return {

      [Symbol.dispose]: (): void => {

        // Idempotent disposal. Multiple disposes of the same handle do not unbalance the refcount.
        if(released) {

          return;
        }

        released = true;
        this.criticalityRefCount--;

        if(this.criticalityRefCount === 0) {

          this.manager.onSubscriberCriticalityChange(this.session);
        }
      }
    };
  }

  // Register a typed disconnect handler. Replaces any previous handler.
  public onDisconnect(handler: (info: { external: boolean }) => void): void {

    this.disconnectHandler = handler;
  }

  // Returns a promise that resolves true once the session establishes (first segment delivered), false if the session terminates before establishing.
  // eslint-disable-next-line @typescript-eslint/promise-function-async
  public whenEstablished(): Promise<boolean> {

    if(this.disposed) {

      return Promise.resolve(false);
    }

    return this.session.establishedPromise;
  }

  // Delegate external-restart requests to the manager.
  public requestRestart(): void {

    if(this.disposed) {

      return;
    }

    this.manager.requestRecovery(this.session);
  }

  // The subscription IS its own iterator. Returning `this` ensures multiple [Symbol.asyncIterator]() calls return the same single-cursor iterator (sharing it
  // across multiple `for await` loops would race). Callers wanting parallel iteration should subscribe() multiple times.
  public [Symbol.asyncIterator](): this {

    return this;
  }

  // Pull one segment from the per-subscriber queue. Resolves with the next segment, or { done: true } on graceful disposal/shutdown, or rejects with a typed
  // error on terminal failure (SessionEstablishmentError, SubscriberLagError).
  // eslint-disable-next-line @typescript-eslint/promise-function-async
  public next(): Promise<IteratorResult<Buffer>> {

    return this.queue.dequeue();
  }

  // Iterator return semantics: cleanly terminate iteration. Disposes the subscription so the queue closes and the manager refcount decrements.
  public async return(): Promise<IteratorResult<Buffer>> {

    await this[Symbol.asyncDispose]();

    return { done: true, value: undefined };
  }

  // Iterator throw semantics: propagate the error to the caller after disposing. Standard contract for AsyncIterator.
  public async throw(error?: unknown): Promise<IteratorResult<Buffer>> {

    await this[Symbol.asyncDispose]();

    throw error;
  }

  // Explicit disposal. Closes the queue gracefully so any pending next() resolves with done:true, then releases the subscription from the session. The work is
  // synchronous; the Promise return type satisfies the AsyncDisposable contract.
  // eslint-disable-next-line @typescript-eslint/promise-function-async
  public [Symbol.asyncDispose](): Promise<void> {

    if(this.disposed) {

      return Promise.resolve();
    }

    this.disposed = true;
    this.disconnectHandler = undefined;
    this.queue.close();
    this.manager.releaseSubscription(this.session, this);

    return Promise.resolve();
  }

  // Internal: deliver a segment to this subscription via its queue. If the queue is full (consumer too slow), terminate this subscription with SubscriberLagError
  // and release it from the session. Other subscribers and the session continue unaffected. The original queue-overflow error is preserved via Error.cause for
  // diagnostic chains. QueueClosedError from a concurrent teardown is swallowed...the path that closed the queue also handles subscription cleanup, so there is
  // nothing for us to do here and wrapping it as a lag error would misattribute the cause.
  public deliverSegment(segment: Buffer): void {

    if(this.disposed) {

      return;
    }

    try {

      this.queue.enqueue(segment);
    } catch(error) {

      if(!(error instanceof QueueFullError)) {

        return;
      }

      this.terminateWithError(new SubscriberLagError("Subscriber lagged behind the livestream by more than " + SUBSCRIBER_QUEUE_CAPACITY.toString() +
        " segments and was terminated.", { cause: error }));
    }
  }

  // Internal: deliver a disconnect notification to this subscription's handler.
  public deliverDisconnect(info: { external: boolean }): void {

    this.disconnectHandler?.(info);
  }

  // Internal: mark this subscription terminated without releasing it from the session. Closes the per-subscriber queue (gracefully if no error, with the error
  // otherwise), clears the disconnect handler, and flips the disposed flag. Idempotent. Used by terminateSession's iteration over subscribers, where the session
  // is itself going down and per-subscriber release would be redundant (and would trigger a recursive terminateSession call caught only by the terminated guard).
  public markTerminated(error?: Error): void {

    if(this.disposed) {

      return;
    }

    this.disposed = true;
    this.disconnectHandler = undefined;
    this.queue.close(error);
  }

  // Internal: terminate the subscription with a typed error AND release it from the session. Used by deliverSegment's overflow path where a single subscriber is
  // terminating itself; the session may tear down if we were the last subscriber.
  public terminateWithError(error: Error): void {

    if(this.disposed) {

      return;
    }

    this.markTerminated(error);
    this.manager.releaseSubscription(this.session, this);
  }
}

/**
 * LivestreamManager brokers pooled access to the UniFi Protect livestream API for a single camera. Consumers acquire a subscription via subscribe(), attach
 * handlers, iterate, and dispose when done. The manager handles pooling, reference counting, FSM transitions, stall detection, self-healing, and backoff
 * internally.
 */
export class LivestreamManager {

  private readonly protectCamera: ProtectCamera;
  private readonly recoveryPolicy: RecoveryPolicy;
  private readonly sessions: Map<string, LivestreamSession>;

  // Constructor accepts a recovery policy override for testing and for hypothetical per-camera variation. In production the default policy is the right answer
  // for every camera; the parameter exists so tests can inject a deterministic policy without spinning up the manager's full surface.
  public constructor(protectCamera: ProtectCamera, recoveryPolicy: RecoveryPolicy = defaultRecoveryPolicy) {

    this.protectCamera = protectCamera;
    this.recoveryPolicy = recoveryPolicy;
    this.sessions = new Map();
  }

  /**
   * Create or join a subscription for the given RTSP entry. Returns the subscription handle synchronously...the underlying connection begins establishing in the
   * background and completes by the time whenEstablished() resolves true (or false on establishment failure). Each subscriber owns its own queue, so segment
   * delivery to one subscriber cannot block another.
   */
  public subscribe(rtspEntry: RtspEntry, segmentLength: number = PROTECT_SEGMENT_RESOLUTION): LivestreamSubscription {

    const { index } = this.getIndex(rtspEntry);

    let session = this.sessions.get(index);
    const isNewSession = !session;

    if(!session) {

      session = this.createSession(rtspEntry, segmentLength);
      this.sessions.set(index, session);
    }

    const subscription = new LivestreamSubscriptionImpl(this, session);

    session.subscriptions.add(subscription);

    if(isNewSession) {

      // Fresh session...kick off provisioning. enterProvisioningConnecting runs synchronously up to its first await before yielding, so the caller's
      // synchronous handler attachment completes before any event can fire.
      void this.enterProvisioningConnecting(session);
    }

    return subscription;
  }

  // Tear down all active sessions and subscriptions. Called from ProtectNvr.disconnect() to ensure no zombie sessions survive a controller reboot cycle.
  public shutdown(): void {

    for(const session of [...this.sessions.values()]) {

      this.terminateSession(session, "shutdown");
    }
  }

  // Called by a subscription's requestRestart(). Initiates an external recovery if the session is in a state where it makes sense...both live-streaming (segments
  // flowing) and live-resuming (just reconnected, awaiting first segment) are post-establishment states where a downstream consumer might detect a problem and
  // want a fresh connection. Provisioning has its own bounded retry mechanism and should not be interrupted; live-reconnecting and live-backoff are already
  // recovering. Terminated is a no-op. Exhaustive over SessionState.kind...adding a new variant fails to compile until handled here.
  public requestRecovery(session: LivestreamSession): void {

    switch(session.state.kind) {

      case "live-streaming":

        clearTimeout(session.state.stallTimer);
        this.fireDisconnect(session, false);
        void this.enterLiveReconnecting(session, true, 0);

        break;

      case "live-resuming":

        clearTimeout(session.state.awaitTimer);
        this.fireDisconnect(session, false);
        void this.enterLiveReconnecting(session, true, 0);

        break;

      case "live-deferred":

        // External request to recover during a deferred stall. We were soaking the stall passively; an explicit recovery request escalates immediately.
        clearTimeout(session.state.ceilingTimer);
        this.fireDisconnect(session, false);
        void this.enterLiveReconnecting(session, true, 0);

        break;

      case "provisioning-connecting":
      case "provisioning-awaiting":
      case "provisioning-backoff":
      case "live-reconnecting":
      case "live-backoff":
      case "terminated":

        // Provisioning has its own bounded retry; live-reconnecting and live-backoff are already recovering; terminated is a no-op. Ignore.
        break;

      default: {

        const exhaustive: never = session.state;

        throw new Error("Unhandled session state in requestRecovery: " + String(exhaustive));
      }
    }
  }

  /**
   * Called by a subscription when its elevation refcount changes (0->1 or 1->0). Used as the escalation trigger for the `live-deferred` state: an idle session
   * that gains an active subscriber should reconnect immediately instead of waiting out the deferral ceiling, because a latency-sensitive consumer just attached
   * and needs fresh data. Falls through harmlessly for any other state - the manager's policy is checked at the moment of stall, not on every criticality
   * transition.
   */
  public onSubscriberCriticalityChange(session: LivestreamSession): void {

    if(session.state.kind !== "live-deferred") {

      return;
    }

    // Only escalate when the aggregate criticality across this session has just become active. A 1->0 transition while deferred is fine - we keep soaking.
    if(this.maxSubscriberCriticality(session) !== "active") {

      return;
    }

    const deferredSec = ((Date.now() - session.state.stallStartTime) / 1000).toFixed(1);

    clearTimeout(session.state.ceilingTimer);
    this.protectCamera.log.debug("Escalating deferred stall after %ss: an HKSV recording or live stream started.", deferredSec);
    void this.enterLiveReconnecting(session, false, 0);
  }

  // Record a livestream symptom on the NVR-health observer. The kind discriminator is the only varying input; everything else (timestamp and camera identity)
  // is constant across all call sites in this class, so threading them through every observation is repetition without information. Typed to the livestream-only
  // subset of HealthSymptom so non-livestream variants (which don't carry a cameraId) can't accidentally route through here.
  private reportLivestreamSymptom(kind: "livestreamRecovery" | "livestreamStall"): void {

    this.protectCamera.nvr.health.observe({ at: Date.now(), cameraId: this.protectCamera.ufp.id, kind: kind });
  }

  // Aggregate the highest criticality across all subscribers on a session. `active` dominates `idle`...if any subscriber is active, the session is treated as
  // active for policy purposes.
  private maxSubscriberCriticality(session: LivestreamSession): SubscriberCriticality {

    for(const subscription of session.subscriptions) {

      if(subscription.criticality === "active") {

        return "active";
      }
    }

    return "idle";
  }

  // Called by a subscription's [Symbol.asyncDispose]() and from terminateWithError(). Removes the subscription from the session and tears the session down if it
  // was the last subscriber.
  public releaseSubscription(session: LivestreamSession, subscription: LivestreamSubscriptionImpl): void {

    if(!session.subscriptions.has(subscription)) {

      return;
    }

    session.subscriptions.delete(subscription);

    if((session.subscriptions.size === 0) && this.sessions.has(session.index)) {

      this.terminateSession(session, "disposed");
    }
  }

  // Compute the session pool index for an RTSP entry. When a secondary lens is specified the channel must always be 0 for the livestream API.
  private getIndex(rtspEntry: RtspEntry): { channel: number; index: string; lens: number | undefined } {

    const channel = (rtspEntry.lens === undefined) ? rtspEntry.channel.id : 0;
    const lens = rtspEntry.lens;

    return { channel: channel, index: channel.toString() + ((lens !== undefined) ? "." + lens.toString() : ""), lens: lens };
  }

  // Construct a new pooled session. Creates the underlying connection, wires up segment and close handlers, and initializes the establishment promise.
  private createSession(rtspEntry: RtspEntry, segmentLength: number): LivestreamSession {

    const { channel, index, lens } = this.getIndex(rtspEntry);

    let connection: FfmpegLivestreamProcess | ProtectLivestream;

    if(this.protectCamera.hasFeature("Debug.Video.HKSV.UseRtsp") && this.protectCamera.stream?.hksv?.recordingConfiguration) {

      connection = new FfmpegLivestreamProcess(this.protectCamera.stream.ffmpegOptions, this.protectCamera.stream.hksv.recordingConfiguration,
        { codec: this.protectCamera.ufp.videoCodec, enableAudio: this.protectCamera.stream.hksv.isAudioActive, url: rtspEntry.url });
    } else {

      connection = this.protectCamera.nvr.ufpApi.createLivestream();
    }

    const { promise: establishedPromise, resolve: establishedResolve } = Promise.withResolvers<boolean>();

    // The state field's deadline timer callback closes over the `session` binding declared on the next line. JavaScript closures capture bindings rather than
    // values, so even though the setTimeout call evaluates before the const assignment completes, the callback resolves `session` correctly when it fires later.
    const session: LivestreamSession = {

      channel: channel,
      closeHandler: (): void => {

        this.onClose(session);
      },
      connection: connection,
      establishedPromise: establishedPromise,
      establishedResolve: establishedResolve,
      index: index,
      lens: lens,
      segmentHandler: (segment: Buffer): void => {

        this.onSegment(session, segment);
      },
      segmentLength: segmentLength,
      state: { deadline: setTimeout((): void => { this.onProvisioningDeadline(session); }, PROVISIONING_DEADLINE), kind: "provisioning-connecting" },
      subscriptions: new Set()
    };

    connection.on("segment", session.segmentHandler);
    connection.on("close", session.closeHandler);

    return session;
  }

  // Start (or restart) the underlying connection. Branches on connection type to handle the sync/async difference. Returns true on success, false on failure.
  // Errors are caught and translated to false so callers can use a single boolean check.
  private async startConnection(session: LivestreamSession): Promise<boolean> {

    try {

      if(session.connection instanceof FfmpegLivestreamProcess) {

        session.connection.segmentLength = session.segmentLength;
        session.connection.start();

        return true;
      }

      return await session.connection.start(this.protectCamera.ufp.id, session.channel,
        { ...LIVESTREAM_OPTIONS, lens: session.lens, requestId: this.protectCamera.name + ":" + session.index, segmentLength: session.segmentLength });
    } catch {

      return false;
    }
  }

  // Provisioning: attempt a connect. Accepts entry from any provisioning state (initial entry from createSession, or retry from a backoff/await timer firing).
  // The function owns its own state transition...callers do not need to pre-transition. The deadline is preserved across all provisioning transitions; the
  // source state's inner per-attempt timer (awaitTimer or backoffTimer) is cleared to prevent orphans. On success, transitions to provisioning-awaiting; on
  // failure, transitions to provisioning-backoff. Calls from live-* or terminated states are stale and ignored.
  private async enterProvisioningConnecting(session: LivestreamSession): Promise<void> {

    let deadline: NodeJS.Timeout;

    switch(session.state.kind) {

      case "provisioning-connecting":

        deadline = session.state.deadline;

        break;

      case "provisioning-awaiting":

        deadline = session.state.deadline;
        clearTimeout(session.state.awaitTimer);

        break;

      case "provisioning-backoff":

        deadline = session.state.deadline;
        clearTimeout(session.state.backoffTimer);

        break;

      case "live-streaming":
      case "live-deferred":
      case "live-resuming":
      case "live-reconnecting":
      case "live-backoff":
      case "terminated":

        return;

      default: {

        const exhaustive: never = session.state;

        throw new Error("Unhandled session state in enterProvisioningConnecting: " + String(exhaustive));
      }
    }

    session.state = { deadline: deadline, kind: "provisioning-connecting" };

    const success = await this.startConnection(session);

    // If the session was terminated during the await (typically by the provisioning deadline expiring or by manager shutdown), it is no longer in the pool and
    // we have nothing more to do. The terminateSession() path is the single anchor that removes the session from the map; checking pool membership here is the
    // canonical "are we still alive?" guard.
    if(!this.sessions.has(session.index)) {

      return;
    }

    if(!success) {

      const backoffTimer = setTimeout((): void => { void this.enterProvisioningConnecting(session); }, PROVISIONING_BACKOFF);

      session.state = { backoffTimer: backoffTimer, deadline: deadline, kind: "provisioning-backoff" };

      return;
    }

    // Connection is up. Wait for the first segment with a per-attempt timeout.
    const awaitTimer = setTimeout((): void => { this.onProvisioningAwaitTimeout(session); }, PROVISIONING_AWAIT_TIMEOUT);

    session.state = { awaitTimer: awaitTimer, deadline: deadline, kind: "provisioning-awaiting" };
  }

  // Provisioning-awaiting: per-attempt first-segment timeout fired. Tear down this attempt and back off before the next one.
  private onProvisioningAwaitTimeout(session: LivestreamSession): void {

    if(session.state.kind !== "provisioning-awaiting") {

      return;
    }

    const deadline = session.state.deadline;

    session.connection.stop();

    const backoffTimer = setTimeout((): void => void this.enterProvisioningConnecting(session), PROVISIONING_BACKOFF);

    session.state = { backoffTimer: backoffTimer, deadline: deadline, kind: "provisioning-backoff" };
  }

  // Provisioning-deadline: overall budget for getting a first segment ever has expired. Terminate the session with establishment-failed; subscribers' iterators
  // throw SessionEstablishmentError on their next pull. Exhaustive over SessionState.kind...adding a new variant fails to compile until handled here.
  private onProvisioningDeadline(session: LivestreamSession): void {

    switch(session.state.kind) {

      case "provisioning-connecting":
      case "provisioning-awaiting":
      case "provisioning-backoff":

        this.protectCamera.log.error("Unable to establish a livestream connection within %ss. Giving up.", (PROVISIONING_DEADLINE / 1000).toString());
        this.terminateSession(session, "establishment-failed");

        break;

      case "live-streaming":
      case "live-deferred":
      case "live-resuming":
      case "live-reconnecting":
      case "live-backoff":
      case "terminated":

        // The deadline timer should have been cleared by the transition out of provisioning. If we somehow reach this branch the timer fired before clearing;
        // ignore defensively.
        break;

      default: {

        const exhaustive: never = session.state;

        throw new Error("Unhandled session state in onProvisioningDeadline: " + String(exhaustive));
      }
    }
  }

  // Live: enter the streaming state. Arms a stall timer that fires if no segment arrives within LIVE_STALL_TIMEOUT.
  private enterLiveStreaming(session: LivestreamSession): void {

    const stallTimer = setTimeout((): void => { this.onLiveStallTimeout(session); }, LIVE_STALL_TIMEOUT);

    session.state = { kind: "live-streaming", stallTimer: stallTimer };

    // Resolve the establishment promise on the very first transition into live-streaming. Subsequent re-entries (after recovery) leave the promise alone...it's
    // already resolved. The presence of establishedResolve discriminates first-entry from re-entry.
    if(session.establishedResolve) {

      session.establishedResolve(true);
      session.establishedResolve = undefined;
    }
  }

  // Live: stall timer fired during streaming. Consult the recovery policy to decide what to do. If the policy says reconnect-now we follow the classical
  // path. If it says defer we enter the live-deferred state and soak the stall - a segment arrival will return us to streaming, the ceiling timer will force a
  // reconnect, or a subscriber criticality elevation will escalate to immediate reconnect.
  private onLiveStallTimeout(session: LivestreamSession): void {

    if(session.state.kind !== "live-streaming") {

      return;
    }

    // Report the stall to the NVR-health observer. This is what makes the recovery decision a *correlated* one: when several cameras stall within the same
    // window, the health state moves to degraded or stressed and the policy below will tilt toward defer instead of reconnect-now, breaking the reconnect-storm
    // cascade that amplifies upstream stress.
    this.reportLivestreamSymptom("livestreamStall");

    const action = this.recoveryPolicy({

      attempts: 0,
      criticality: this.maxSubscriberCriticality(session),
      health: this.protectCamera.nvr.health.state
    });

    switch(action.kind) {

      case "reconnect-now":

        this.fireDisconnect(session, false);
        void this.enterLiveReconnecting(session, false, 0);

        break;

      case "defer":

        this.enterLiveDeferred(session, action.ceilingMs);

        break;

      default: {

        const exhaustive: never = action;

        throw new Error("Unhandled recovery action: " + String(exhaustive));
      }
    }
  }

  // Live: enter the deferred-stall state. Used when the recovery policy decides that an immediate reconnect would be wasteful or harmful (idle subscribers under
  // a non-healthy controller). The state arms a ceiling timer that forces a reconnect if the stall does not resolve organically; in the meantime, a segment
  // arrival will return us to live-streaming, and a subscriber elevation will escalate to immediate reconnect via onSubscriberCriticalityChange.
  //
  // We deliberately do NOT fireDisconnect here: the underlying connection is still alive (we just haven't seen a segment), and reporting a disconnect to
  // subscribers would cause downstream consumers (e.g., the timeshift buffer) to flag a discontinuity for a transient gap that may resolve on its own. The
  // disconnect signal is reserved for actual reconnects, which fire it in enterLiveReconnecting.
  private enterLiveDeferred(session: LivestreamSession, ceilingMs: number): void {

    const ceilingTimer = setTimeout((): void => { this.onLiveDeferredCeiling(session); }, ceilingMs);

    session.state = { ceilingTimer: ceilingTimer, kind: "live-deferred", stallStartTime: Date.now() };

    this.protectCamera.log.debug("Stall detected; deferring reconnect for up to %ss while controller is %s.", (ceilingMs / 1000).toString(),
      this.protectCamera.nvr.health.state);
  }

  // Live-deferred: the ceiling timer fired. The stall has not resolved organically and no subscriber escalation arrived. Force a reconnect now. The
  // stallStartTime captured on entry lets us report how long the deferral soaked before the reconnect, which is the operational telemetry that lets a future
  // reader correlate "deferred stall" log entries with "reconnect" log entries on the same session.
  private onLiveDeferredCeiling(session: LivestreamSession): void {

    if(session.state.kind !== "live-deferred") {

      return;
    }

    const deferredSec = ((Date.now() - session.state.stallStartTime) / 1000).toFixed(1);

    this.protectCamera.log.debug("Deferred livestream stall ceiling reached after %ss; reconnecting.", deferredSec);
    this.fireDisconnect(session, false);
    void this.enterLiveReconnecting(session, false, 0);
  }

  // Live: tear down the current connection and attempt a fresh start. On success, enter live-resuming to wait for the first post-reconnect segment. On failure,
  // enter live-backoff with linearly growing backoff.
  private async enterLiveReconnecting(session: LivestreamSession, isExternal: boolean, recoveryAttempts: number): Promise<void> {

    session.state = { isExternal: isExternal, kind: "live-reconnecting", recoveryAttempts: recoveryAttempts };

    const streamType = this.protectCamera.hasFeature("Debug.Video.HKSV.UseRtsp") ? "RTSP stream" : "livestream API";

    // Render the last-segment interval when it's long enough to be a meaningful stall duration. Elapsed below LIVE_STALL_TIMEOUT means the disconnect fired
    // before our own stall timer would have (a controller-initiated close arriving within the stall window), so there is no stall duration to report...the
    // log falls back to "brief" rather than rendering an awkward "0s stall". Above the threshold, we report seconds so users can tell a transient blip
    // apart from a multi-minute outage.
    const elapsedMs = (session.lastSegmentTime !== undefined) ? Date.now() - session.lastSegmentTime : null;
    const sinceLastSegment = ((elapsedMs !== null) && (elapsedMs >= LIVE_STALL_TIMEOUT)) ? Math.round(elapsedMs / 1000).toString() + "s" : null;

    if(isExternal) {

      this.protectCamera.log.warn("Restarting the %s to recover from a recording failure.", streamType);
    } else if(recoveryAttempts === 0) {

      // Demote per-camera reconnect logs to debug when the controller is non-healthy. The NVR-level state-transition log already explains correlated stress;
      // emitting an N-camera fan-out of "reconnecting after stall" warnings on top of it is noise. When the controller is healthy, the warning is the right
      // level - an isolated reconnect is worth surfacing.
      const message = "Reconnecting to the " + streamType + " after a " + (sinceLastSegment ?? "brief") + " stall.";

      if(this.protectCamera.nvr.health.state === "healthy") {

        this.protectCamera.log.warn(message);
      } else {

        this.protectCamera.log.debug(message);
      }
    } else if(this.protectCamera.hasFeature("Device.SelfHealing") && (recoveryAttempts === (LIVE_SELF_HEAL_THRESHOLD - 1))) {

      // Threshold-anchored warning: this is the last reconnect before self-heal triggers a camera reboot. Users get a "we've been trying for a while, and a
      // reboot is next if this fails" signal without per-retry log noise during the intervening attempts.
      this.protectCamera.log.warn("Livestream recovery has failed %s times%s. A camera reboot will follow if this attempt also fails.",
        recoveryAttempts.toString(), sinceLastSegment ? " (last segment " + sinceLastSegment + " ago)" : "");
    }

    // Stop the current connection. The library's stop() removes its close listener from the websocket before closing it, so this does not trigger our onClose
    // handler and will not start a duplicate recovery cycle.
    session.connection.stop();

    // If the controller is unreachable or throttled or the camera is offline, back off and retry later.
    if(!this.protectCamera.nvr.ufpApi.bootstrap || this.protectCamera.nvr.ufpApi.isThrottled || !this.protectCamera.isOnline) {

      this.enterLiveBackoff(session, recoveryAttempts + 1);

      return;
    }

    // Self-heal: after a configured number of consecutive internal recoveries, reboot the camera to reset its livestream endpoint. External recoveries
    // (initiated by a downstream consumer) do not count toward this threshold...they reflect downstream failures, not stream problems.
    if(!isExternal && this.protectCamera.hasFeature("Device.SelfHealing") && (recoveryAttempts >= LIVE_SELF_HEAL_THRESHOLD)) {

      this.protectCamera.log.warn("Restarting the camera to reset its connection to the livestream API.");

      const response = await this.protectCamera.nvr.ufpApi.retrieve(this.protectCamera.nvr.ufpApi.getApiEndpoint(this.protectCamera.ufp.modelKey) + "/" +
        this.protectCamera.ufp.id + "/reboot", { body: JSON.stringify({}), method: "POST" });

      // The session may have been terminated (manager shutdown) during the await. Pool membership is the canonical liveness guard.
      if(!this.sessions.has(session.index)) {

        return;
      }

      if(!this.protectCamera.nvr.ufpApi.responseOk(response?.statusCode)) {

        this.protectCamera.log.error("Unable to restart the camera.");
        this.enterLiveBackoff(session, 0);

        return;
      }

      // Reset the recovery counter after a successful self-heal so we don't keep rebooting in tight loops.
      this.enterLiveBackoff(session, 0);

      return;
    }

    const success = await this.startConnection(session);

    // The session may have been terminated (manager shutdown) during the await. Pool membership is the canonical liveness guard.
    if(!this.sessions.has(session.index)) {

      return;
    }

    if(!success) {

      this.enterLiveBackoff(session, recoveryAttempts + 1);

      return;
    }

    // Connection is up. Wait for the first post-reconnect segment.
    const awaitTimer = setTimeout((): void => { this.onLiveResumeAwaitTimeout(session); }, LIVE_RESUME_AWAIT_TIMEOUT);

    session.state = { awaitTimer: awaitTimer, kind: "live-resuming", recoveryAttempts: recoveryAttempts };
  }

  // Live-resuming: per-attempt first-post-reconnect segment timeout fired. Tear down this attempt and back off.
  private onLiveResumeAwaitTimeout(session: LivestreamSession): void {

    if(session.state.kind !== "live-resuming") {

      return;
    }

    const recoveryAttempts = session.state.recoveryAttempts + 1;

    session.connection.stop();

    this.enterLiveBackoff(session, recoveryAttempts);
  }

  // Live-backoff: park the session in waiting with a linearly growing backoff timer. When the timer fires, attempt another reconnect.
  private enterLiveBackoff(session: LivestreamSession, recoveryAttempts: number): void {

    const backoffMs = Math.min(LIVE_BACKOFF_BASE + (recoveryAttempts * LIVE_BACKOFF_INCREMENT), LIVE_BACKOFF_MAX);
    const backoffTimer = setTimeout((): void => void this.enterLiveReconnecting(session, false, recoveryAttempts), backoffMs);

    session.state = { backoffTimer: backoffTimer, kind: "live-backoff", recoveryAttempts: recoveryAttempts };
  }

  // Underlying connection segment handler. Drives the establishment transition, re-arms the stall timer, fans out to every subscription.
  private onSegment(session: LivestreamSession, segment: Buffer): void {

    switch(session.state.kind) {

      case "provisioning-awaiting":

        // First segment ever. Cross the establishment phase boundary into live-streaming. The deadline timer is no longer relevant.
        clearTimeout(session.state.awaitTimer);
        clearTimeout(session.state.deadline);
        this.enterLiveStreaming(session);

        break;

      case "live-resuming":

        // First segment after a reconnect. Clear the resume timer and re-enter streaming. The recoveryAttempts counter resets on the next stall→reconnect
        // transition (onLiveStallTimeout always passes 0), so no forgiveness mechanic is needed here. Report a livestream recovery to the NVR-health observer
        // so success after a reconnect counts as evidence of recovery in the symptom window.
        clearTimeout(session.state.awaitTimer);
        this.reportLivestreamSymptom("livestreamRecovery");
        this.enterLiveStreaming(session);

        break;

      case "live-deferred":

        // A segment arrived while we were soaking a deferred stall. The stall resolved organically: we did not need to reconnect, and the controller is
        // delivering data again. Clear the ceiling timer, return to live-streaming, and report the recovery to the NVR-health observer.
        clearTimeout(session.state.ceilingTimer);
        this.reportLivestreamSymptom("livestreamRecovery");
        this.enterLiveStreaming(session);

        break;

      case "live-streaming":

        // Steady-state segment delivery. Re-arm the stall timer.
        clearTimeout(session.state.stallTimer);
        session.state = { kind: "live-streaming", stallTimer: setTimeout((): void => { this.onLiveStallTimeout(session); }, LIVE_STALL_TIMEOUT) };

        break;

      case "provisioning-connecting":
      case "provisioning-backoff":
      case "live-reconnecting":
      case "live-backoff":
      case "terminated":

        // Segments arriving in these states are stale (e.g., between connection.stop() and the corresponding "close" event). Discard so subscribers do not
        // receive segments tied to a torn-down connection.
        return;

      default: {

        const exhaustive: never = session.state;

        throw new Error("Unhandled session state in onSegment: " + String(exhaustive));
      }
    }

    // Stamp the most recent live-segment time. Read by enterLiveReconnecting to report stall duration in recovery logs, so users can tell a transient blip
    // apart from a multi-minute outage at a glance.
    session.lastSegmentTime = Date.now();

    // Fan out to all subscribers. Each subscriber owns a per-subscriber queue; a slow consumer cannot block the others or the session itself. The outer
    // try/catch is defense-in-depth: deliverSegment handles its own enqueue overflow internally and converts it to a SubscriberLagError, but the resulting
    // termination cascade calls into the unifi-protect library (connection.off / connection.stop) which we cannot guarantee will never throw. If that cascade
    // throws we log and continue iterating so one subscriber's library-level failure doesn't strand the others.
    for(const subscription of session.subscriptions) {

      try {

        subscription.deliverSegment(segment);
      } catch(error) {

        this.protectCamera.log.error("Internal error during livestream segment delivery.", { error });
      }
    }
  }

  // Underlying connection close handler. Fires when the controller closes the websocket. Our own connection.stop() calls during recovery do not trigger this
  // handler...the unifi-protect library detaches its close listener before closing the socket, so close events from our initiated stops are suppressed before
  // they reach us.
  private onClose(session: LivestreamSession): void {

    switch(session.state.kind) {

      case "provisioning-connecting":
      case "provisioning-awaiting": {

        // Close during provisioning is just another failed attempt. Back off and try again.
        if(session.state.kind === "provisioning-awaiting") {

          clearTimeout(session.state.awaitTimer);
        }

        const backoffTimer = setTimeout((): void => { void this.enterProvisioningConnecting(session); }, PROVISIONING_BACKOFF);

        session.state = { backoffTimer: backoffTimer, deadline: session.state.deadline, kind: "provisioning-backoff" };

        break;
      }

      case "live-streaming":

        clearTimeout(session.state.stallTimer);
        this.fireDisconnect(session, true);
        void this.enterLiveReconnecting(session, false, 0);

        break;

      case "live-resuming":

        clearTimeout(session.state.awaitTimer);
        this.fireDisconnect(session, true);
        void this.enterLiveReconnecting(session, false, session.state.recoveryAttempts);

        break;

      case "live-deferred":

        // Controller closed the underlying socket while we were soaking a deferred stall. The deferral premise (the connection might recover on its own) no
        // longer holds; escalate to immediate reconnect.
        clearTimeout(session.state.ceilingTimer);
        this.fireDisconnect(session, true);
        void this.enterLiveReconnecting(session, false, 0);

        break;

      case "provisioning-backoff":
      case "live-reconnecting":
      case "live-backoff":
      case "terminated":

        // No live socket: provisioning-backoff and live-backoff are between attempts (connection already stopped); live-reconnecting just called connection.stop()
        // (the library's stop() detaches its close listener so this branch should not fire); terminated has detached our handler entirely. In all four cases a
        // close event here is either redundant or impossible, so ignore.
        break;

      default: {

        const exhaustive: never = session.state;

        throw new Error("Unhandled session state in onClose: " + String(exhaustive));
      }
    }
  }

  // Notify all subscribers of a disconnect. The external flag tells consumers whether the disconnect came from the controller (true) or from our internal
  // recovery path (false). Consumers can use this to suppress redundant log messages for self-initiated recoveries.
  private fireDisconnect(session: LivestreamSession, external: boolean): void {

    for(const subscription of session.subscriptions) {

      try {

        subscription.deliverDisconnect({ external: external });
      } catch(error) {

        this.protectCamera.log.error("Internal error during livestream disconnect notification.", { error });
      }
    }
  }

  // Terminate a session. Closes all subscriber iterators (gracefully or with a typed error depending on reason), tears down internal state, and removes the
  // session from the pool.
  private terminateSession(session: LivestreamSession, reason: TerminationReason): void {

    if(session.state.kind === "terminated") {

      return;
    }

    // Clear any timers owned by the current state.
    this.clearStateTimers(session);

    session.state = { kind: "terminated", reason: reason };

    // Resolve the establishment promise to false if it hasn't been resolved yet. Pending whenEstablished() awaits unblock with false.
    if(session.establishedResolve) {

      session.establishedResolve(false);
      session.establishedResolve = undefined;
    }

    // Mark each subscription terminated with the appropriate semantic. establishment-failed throws SessionEstablishmentError into the iterator; disposed and
    // shutdown close gracefully (iterators return done:true). We use markTerminated directly rather than terminateWithError because the session is already
    // tearing down...the per-subscriber release call inside terminateWithError would loop back here (caught by the terminated guard, but wastefully).
    const error = (reason === "establishment-failed") ? new SessionEstablishmentError("The livestream session terminated before delivering its first segment.") :
      undefined;

    for(const subscription of session.subscriptions) {

      subscription.markTerminated(error);
    }

    session.subscriptions.clear();

    // Detach from the underlying connection and remove ourselves from the pool.
    session.connection.off("segment", session.segmentHandler);
    session.connection.off("close", session.closeHandler);
    session.connection.stop();

    this.sessions.delete(session.index);
  }

  // Clear whatever timers are owned by the session's current state. Used during termination and as part of internal cleanup.
  private clearStateTimers(session: LivestreamSession): void {

    switch(session.state.kind) {

      case "provisioning-connecting":

        clearTimeout(session.state.deadline);

        break;

      case "provisioning-awaiting":

        clearTimeout(session.state.awaitTimer);
        clearTimeout(session.state.deadline);

        break;

      case "provisioning-backoff":

        clearTimeout(session.state.backoffTimer);
        clearTimeout(session.state.deadline);

        break;

      case "live-streaming":

        clearTimeout(session.state.stallTimer);

        break;

      case "live-deferred":

        clearTimeout(session.state.ceilingTimer);

        break;

      case "live-resuming":

        clearTimeout(session.state.awaitTimer);

        break;

      case "live-backoff":

        clearTimeout(session.state.backoffTimer);

        break;

      case "live-reconnecting":
      case "terminated":

        // No owned timers...nothing to clear.
        break;

      default: {

        const exhaustive: never = session.state;

        throw new Error("Unhandled session state in clearStateTimers: " + String(exhaustive));
      }
    }
  }
}
