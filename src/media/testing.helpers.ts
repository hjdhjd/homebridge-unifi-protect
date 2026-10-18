/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * testing.helpers.ts: The media-subsystem test helpers for homebridge-unifi-protect.
 *
 * This file owns the doubles the streaming, recording, timeshift, and snapshot tests drive: TestCameraHost, the reusable stand-in for the camera-host contract the
 * media classes read their configuration and channel selection through, plus the fMP4 fragment builders and the livestream-subscription doubles that feed a real
 * timeshift buffer without a controller or an FFmpeg process. The fragment builders compose genuine boxes through homebridge-plugin-utils' real writers, so what a
 * buffer parses here is what it would parse on the wire, and the controllable livestream double exposes the steering a recovery or discontinuity test needs.
 *
 * Fidelity to the cited contracts, not invention, is the line these doubles hold: the camera-host surface is the plugin's own, and the segment and subscription shapes
 * are unifi-protect's. The cross-cutting core - the HAP double, the state store, and the streaming and timeshift stubs - lives in the root harness every subsystem's
 * testing.helpers.ts imports from.
 */
import type { HomebridgePluginLogging, Nullable, RecordingProcessFactory } from "homebridge-plugin-utils";
import type { LivestreamDescription, LivestreamInit, LivestreamSubscriptionState, ProtectCameraConfig, Segment, SnapshotOptions, TalkbackSession } from "unifi-protect";
import type { LivestreamHostOptions, ProtectCameraHost } from "./camera-host.ts";
import { SAMPLE_FLAG_NON_SYNC, onAbort } from "homebridge-plugin-utils";
import type { TestClock, TestLogEntry } from "homebridge-plugin-utils/testing";
import { TestStateStore, makeProtectState, makeTestAccessory } from "../testing.helpers.ts";
import { makeBox, makeContainer, makeTrunBox } from "homebridge-plugin-utils/testing";
import type { API } from "homebridge";
import type { ChannelProfile } from "./resolution.ts";
import { G2_PRO_CHANNELS } from "../camera.fixtures.ts";
import type { LivestreamSubscription } from "./livestream.ts";
import type { ProtectAccessory } from "../types.ts";
import type { ProtectCameraHints } from "../devices/cameras/camera.ts";
import type { ProtectNvr } from "../nvr/nvr.ts";
import type { ProtectPlatform } from "../platform.ts";
import type { StreamingDelegate } from "./stream-delegate.ts";
import type { TestAccessory } from "../testing.helpers.ts";
import type { TestProtectNvr } from "../nvr/testing.helpers.ts";
import { makeCameraConfig } from "../devices/testing.helpers.ts";
import { makeTestNvr } from "../nvr/testing.helpers.ts";

/* The reusable camera-host test double: the small stand-in every media-delegate test constructs a delegate against, in place of a full ProtectCamera. The
 * ProtectCameraHost interface segregation (the dependency-inversion boundary on the camera side of the media stack) exists precisely so the streaming, recording,
 * snapshot, and timeshift delegates type their camera handle as this narrow contract rather than the concrete class - and this double is what cashes that in: it
 * structurally satisfies every member of ProtectCameraHost (the same compile-time proof the production ProtectCamera passes), so a delegate constructs against it
 * with no FFmpeg and no live camera.
 *
 * The shape mirrors TestStreamingDelegate's discipline: controllable fields a test sets to steer a branch (isReachable is the behavior-bearing one - the snapshot
 * delegate's reachability gate reads it), recordable call logs the behavior-bearing interfaces push their arguments into (so a later test asserts an interface was
 * invoked), and settable interface returns (snapshotResult is the Buffer snapshotFromController resolves, the value the two-sided snapshot test threads through the
 * delegate).
 *
 * The context half composes the EXISTING harness doubles rather than reinventing them: accessory is a real TestAccessory, and nvr/platform/api/log all flow from a
 * real makeTestNvr context (so the very next behavior step, which reads platform.codecSupport and nvr.mqtt, finds real doubles there, not sentinels that would
 * throw). The four context handles (accessory/api/nvr/platform) plus ufp are typed as their production types by the interface, which the intentionally-partial
 * doubles do not structurally satisfy, so each is bridged with a confined `as unknown as <ProductionType>` boundary cast - the same honest harness pattern the
 * construction suites use at their own construction-arg boundaries. The casts bridge the deliberate double->production gap only; tsc still verifies every member is
 * present and interface-typed, so the completeness proof holds.
 *
 * Member order mirrors TestStreamingDelegate: the fields group alphabetized (except where a boundary's return value is kept adjacent to its own call log), then the
 * methods group alphabetized (not one global run). The settable interface predicates hasFeature / selectChannel / selectSubstrateChannel are public arrow-function fields
 * so a test can reassign them, satisfying the interface's method members.
 */
export class TestCameraHost implements ProtectCameraHost {

  public accessory: ProtectAccessory;
  public accessoryName = "Test Camera";
  public api: API;

  // The settable feature predicate; defaults to "no feature enabled", the quiet default the delegate construction paths read against.
  public hasFeature: (option: string) => boolean = () => false;

  // Whether the camera has an RTSP-enabled stream to draw a direct session from. Defaults true, so every media suite's standing assumption of an RTSP-capable camera
  // holds unchanged; a test about the no-RTSP population flips it.
  public hasRtspStream = true;

  // A complete neutral ProtectCameraHints literal - every boolean false, every number 0, every string empty, the nested cropOptions zeroed - so a delegate reads a fully
  // populated hint bag with no behavior turned on (crop false is required for the two-sided snapshot test, which must NOT enter the crop pass).
  public hints: ProtectCameraHints = {

    crop: false,
    cropOptions: { height: 0, width: 0, x: 0, y: 0 },
    enabled: false,
    hardwareDecoding: false,
    hardwareTranscoding: false,
    highResSnapshots: false,
    hksvRecordingIndicator: false,
    ledStatus: false,
    logDoorbell: false,
    logHksv: false,
    logMotion: false,
    motionDuration: 0,
    nightVision: false,
    occupancyDuration: 0,
    probesize: 0,
    rtspDefault: "",
    smartDetect: false,
    smartDetectSensors: false,
    smartOccupancy: [],
    standalone: false,
    substrateDefault: "",
    syncName: false,
    transcode: false,
    transcodeBitrate: 0,
    transcodeHighLatency: false,
    transcodeHighLatencyBitrate: 0,
    tsbStreaming: false,
    twoWayAudio: false,
    twoWayAudioDirect: false
  };

  // Whether this camera can back HomeKit Secure Video. Settable so a recording-behavior test can flip it; defaults false.
  public isHksvCapable = false;

  // The behavior-bearing reachability gate: the snapshot delegate returns null before any pipeline when this is false, so the two-sided snapshot test sets it both
  // ways. Defaults true.
  public isReachable = true;

  // Recordable call logs: each behavior-bearing interface pushes its arguments here so a later test can assert the interface was invoked exactly as expected.
  public readonly livestreamCalls: { channelProfile: ChannelProfile; opts?: LivestreamHostOptions }[] = [];

  // The segment-count knob the transmit test sets to fill the timeshift buffer: the number of keyframe-bearing media segments livestream() yields. Defaults 0, which
  // returns the inert (segment-less) livestream double so the construction suites stay on their unchanged path.
  public livestreamMediaSegments = 0;

  // The queue of test-provided subscriptions livestream() hands out in order: each call shifts the head, so a single start consumes one, and a start-twice or
  // id-identity test supplies two DISTINCT-id controllable doubles. When the queue is empty, livestream() falls back to the livestreamMediaSegments-selected parking /
  // inert double - the unchanged path the construction and recording-transmit suites stay on (they never set this queue).
  public livestreamSubscriptions: LivestreamSubscription[] = [];
  public log: HomebridgePluginLogging;

  // The bare device MAC for topic addressing, read through the device projection so it stays consistent with the ufp fixture's mac even if a test reassigns ufp. This is
  // the identity the narrowed live-state view does not carry; a delegate reads it (the MQTT snapshot topic) through protectCamera.mac.
  public get mac(): string {

    return this.ufp.mac;
  }

  public nvr: ProtectNvr;
  public platform: ProtectPlatform;
  public readonly rebootCalls: number[] = [];

  // The error reboot() rejects with when set (default undefined = reboot resolves). A self-heal test sets this to drive the reboot-failure branch, where the timeshift
  // logs that the camera could not be rebooted; the call is still recorded in rebootCalls before the rejection, matching production's invoke-then-fail ordering.
  public rebootError?: Error;

  // The settable channel selectors; default null (no profile resolved), so the snapshot RTSP source - which would call selectChannel - never proceeds past its own
  // !stream guard anyway, keeping the two-sided test on the controller path.
  public selectChannel: (width: number, height: number, opts?: { biasHigher?: boolean; maxPixels?: number }) => Nullable<ChannelProfile> = () => null;
  public selectSubstrateChannel: () => Nullable<ChannelProfile> = () => null;
  public readonly setStatusLedCalls: boolean[] = [];

  // The settable Buffer snapshotFromController resolves - the value the two-sided snapshot test threads through the delegate's controller source.
  public snapshotResult: Buffer = Buffer.from("test-snapshot");
  public readonly snapshotFromControllerCalls: SnapshotOptions[] = [];

  // The streaming delegate handle the snapshot/recording/timeshift consumers read; default undefined so the snapshot timeshift/RTSP sources early-return on their
  // !stream guards and the pipeline falls through to the controller source.
  public stream: StreamingDelegate | undefined = undefined;
  public readonly talkbackCalls: { signal?: AbortSignal }[] = [];

  // The camera-narrowed Protect device projection; settable, default a G2 Pro config so featureFlags / videoCodec reads resolve to a real record.
  public ufp: Readonly<ProtectCameraConfig>;

  // Whether buffer-backed livestreaming is enabled and this camera is capable of it - the streaming demand arm of the standing buffer. Settable so a test can steer the
  // streaming arm on and off; defaults false.
  public usesTimeshiftLivestream = false;
  public videoCodecName = "h264";

  // Compose the context half from real harness doubles, bridging each to its interface-required production type at the confined boundary.
  public constructor(init: { accessory: TestAccessory; nvr: TestProtectNvr }) {

    // The double is a partial TestAccessory; the interface requires the production ProtectAccessory. The confined boundary cast bridges the deliberate gap.
    this.accessory = init.accessory as unknown as ProtectAccessory;

    // The api/log/platform/nvr handles all flow from the real makeTestNvr context. Each is a partial double the interface types as a production handle, so each
    // takes the same confined boundary cast.
    this.api = init.nvr.platform.api as unknown as API;
    this.log = init.nvr.log;
    this.nvr = init.nvr as unknown as ProtectNvr;
    this.platform = init.nvr.platform as unknown as ProtectPlatform;

    // The ufp record is the ONE confined cast makeCameraConfig already documents (it populates the verified read set and casts once to the full wire type), reused
    // here verbatim for the host's device projection.
    this.ufp = makeCameraConfig({ channels: G2_PRO_CHANNELS });
  }

  // The FFmpeg audio-filter chain; the stub builds none.
  public getAudioFilters(): string[] {

    return [];
  }

  // The recordable livestream interface. It records its arguments and hands back a LivestreamSubscription double whose profile is selected by this host's
  // livestreamMediaSegments knob: the default 0 yields the inert double (empty iterator, no-op dispose, "closed" state) the construction suites stay on, while a
  // positive count yields the established segment-yielding double (one init then that many keyframe-bearing media segments, then a parked iterator) the transmit net
  // fills its timeshift buffer from.
  public livestream(channelProfile: ChannelProfile, opts?: LivestreamHostOptions): LivestreamSubscription {

    this.livestreamCalls.push({ channelProfile, opts });

    // Hand out the next test-provided subscription from the queue, if any; otherwise fall back to the livestreamMediaSegments-selected parking / inert double. The queue
    // path is how a standalone timeshift test drives the SUT with a controllable double (and supplies two distinct doubles for the restart / id-identity targets); the
    // fallback preserves the unchanged behavior the construction and recording-transmit suites depend on (they never set the queue).
    return this.livestreamSubscriptions.shift() ?? makeLivestreamSubscriptionDouble({ mediaSegments: this.livestreamMediaSegments });
  }

  // The recordable reboot interface; records the call, then rejects with rebootError when one is set (the self-heal reboot-failure path) or resolves otherwise.
  public async reboot(): Promise<void> {

    this.rebootCalls.push(this.rebootCalls.length + 1);

    if(this.rebootError !== undefined) {

      throw this.rebootError;
    }
  }

  // The recordable status-LED interface; records every requested value and resolves true.
  public async setStatusLed(value: boolean): Promise<boolean> {

    this.setStatusLedCalls.push(value);

    return true;
  }

  // The behavior-bearing controller-snapshot interface: records the options and resolves the settable snapshotResult Buffer - the value the two-sided snapshot test
  // observes flow through the delegate's controller source.
  public async snapshotFromController(opts?: SnapshotOptions): Promise<Buffer> {

    this.snapshotFromControllerCalls.push(opts ?? {});

    return this.snapshotResult;
  }

  // The recordable talkback interface. NOT exercised by the construction suites - TalkbackSession has a private constructor and #private fields, so there is no
  // constructible literal; the never-called stub returns a confined sentinel cast, the same harness pattern TestStreamingDelegate uses for its opaque
  // CameraController sentinel.
  public async talkback(opts?: { signal?: AbortSignal }): Promise<TalkbackSession> {

    this.talkbackCalls.push(opts ?? {});

    // The opaque sentinel: TalkbackSession is uninstantiable from a test, and the construction suites never call talkback, so the return is a confined cast no
    // path reads.
    return { hbupTestSentinel: "talkback-session" } as unknown as TalkbackSession;
  }
}

// Synthesize a genuine fMP4 media fragment on the published fMP4 builders so the production isKeyframe TRUN-flag parse runs against REAL bytes on the REAL path - no
// isKeyframe injection point, so the test exercises the actual fMP4 keyframe coupling rather than a test-only divergence. The fragment is moof>traf>trun with a
// first_sample_flags-bearing trun (the builder sets the data_offset and first_sample_flags TRUN flags, sample_count 1, data_offset 0). The ONLY difference between a
// keyframe and a non-keyframe fragment is that first_sample_flags value: 0 leaves the SAMPLE_FLAG_NON_SYNC bit clear, marking a sync sample (a keyframe), while
// SAMPLE_FLAG_NON_SYNC sets it, marking a non-sync sample (a non-keyframe) the production parse rejects. The mdat carries an empty body - the timeshift never decodes
// the payload, it only parses the moof for keyframe-ness and concatenates the bytes. The returned data buffer is the moof+mdat pair a media Segment delivers. This is
// the single source of truth for both fragment kinds; makeKeyframeFragment and makeNonKeyframeFragment are the two thin selectors over it.
function makeMediaFragment(options: { keyframe?: boolean } = {}): { data: Buffer; mdat: Buffer; moof: Buffer } {

  const keyframe = options.keyframe ?? true;
  const moof = makeContainer("moof", [makeContainer("traf", [makeTrunBox({ sampleFlagsValue: keyframe ? 0 : SAMPLE_FLAG_NON_SYNC, useFirstSampleFlags: true })])]);
  const mdat = makeBox("mdat");

  return { data: Buffer.concat([ moof, mdat ]), mdat, moof };
}

// The keyframe-bearing fragment: makeMediaFragment with its default keyframe-true selection, so the production isKeyframe parse returns true. This is a thin
// wrapper whose default keyframe path writes first_sample_flags 0, so the KEYFRAME_FRAGMENT const, the segment-yielding parking double, and the keyframe
// self-test all read the identical bytes.
export function makeKeyframeFragment(): { data: Buffer; mdat: Buffer; moof: Buffer } {

  return makeMediaFragment();
}

// The non-keyframe-bearing fragment: makeMediaFragment with keyframe false, so the trun first_sample_flags carries SAMPLE_FLAG_NON_SYNC and the production isKeyframe
// parse returns false on the REAL path. The timeshift suite pushes this through the controllable double to exercise the discontinuity keyframe-gate (a
// discontinuity-marked non-keyframe must defer the discontinuity emit until a clean keyframe arrives) and to drive any non-keyframe classification. Built at the use
// site rather than cached in a module const so there is no unused-when-the-suite-changes SSOT cruft to drift.
export function makeNonKeyframeFragment(): { data: Buffer; mdat: Buffer; moof: Buffer } {

  return makeMediaFragment({ keyframe: false });
}

// The one keyframe fragment and init buffer the segment-yielding double reuses across every yield. The timeshift never mutates segment bytes (it parses and concatenates
// them), so sharing one instance is safe and avoids re-synthesizing the boxes per call. The init bytes are placeholders that carry no readable moov, so the description
// every double's init carries by default is the one the library reads from such bytes: no tracks, which is a stream with no readable audio track.
const KEYFRAME_FRAGMENT = makeKeyframeFragment();
const INIT_SEGMENT_DATA = Buffer.from("test-init-segment");
const NO_TRACKS: LivestreamDescription = { tracks: [] };

/* Build a LivestreamSubscription double for the camera-host stub's livestream interface, in one of two profiles selected by the requested media-segment count:
 *
 *   - mediaSegments === 0 (the default): the byte-identical INERT profile the construction tests rely on - initSegment null, state "closed", whenEstablished resolves
 *     false, an empty iterator, no-op reassess/dispose. The construction suites never exercise it; it exists only so the host's livestream return type-checks
 *     against the production type.
 *   - mediaSegments > 0: the ESTABLISHED segment-yielding profile - initSegment populated, state "live", whenEstablished resolves true, and an iterator yielding one init
 *     segment then mediaSegments keyframe-bearing media segments so the timeshift fills its buffer with real fMP4 the production isKeyframe parse accepts.
 *
 * Required, not incidental: after yielding its media segments the established iterator MUST PARK, never completing. A finite generator returns done, which ends the
 * timeshift's consumeSegments for-await, runs its finally -> finalizeSubscription -> clearBuffer, and wipes the just-filled buffer (the this.subscription?.id ===
 * subscription.id guard is true by then, because start() commits this.subscription mid-drain) - so timeshift.time falls back to zero and the transmit gate would always
 * decline. We park by owning an internal AbortController: [Symbol.asyncDispose] aborts it, and the generator, after its media loop, awaits a promise that resolves on
 * that abort (resolves immediately if already aborted, else via a one-shot "abort" listener). The for-await therefore never completes while filling, the buffer survives,
 * and a real timeshift.stop()/dispose still releases it cleanly. whenEstablished resolves true immediately while the consumer fills its buffer by draining the parking
 * iterator to its park point; a single settle() in the test drains all the microtask-resolved yields before the park, because the generator crosses no macrotask/timer
 * boundary (were one ever added, a single settle() would silently under-drain).
 *
 * The established profile's init carries the description option, defaulting to no tracks, so a recording test steers the audio format the buffer reads from it.
 */
export function makeLivestreamSubscriptionDouble(options: { description?: LivestreamDescription; mediaSegments?: number } = {}): LivestreamSubscription {

  const mediaSegments = options.mediaSegments ?? 0;
  const init = { codec: "h264", data: INIT_SEGMENT_DATA, description: options.description ?? NO_TRACKS };

  // The inert profile: preserved byte-for-byte so the construction suites stay green.
  if(mediaSegments === 0) {

    return {

      id: "test-livestream-subscription",
      initSegment: null,
      reassess: (): void => { /* No-op: the double has no recovery loop to re-decide. */ },
      state: "closed",
      whenEstablished: async (): Promise<boolean> => false,
      [Symbol.asyncIterator]: async function *(): AsyncGenerator<Segment> { /* The double delivers no segments. */ },
      [Symbol.asyncDispose]: async (): Promise<void> => { /* No-op: the double owns no resources to release. */ }
    };
  }

  // The established profile owns a dispose-abort controller so its iterator can park after the media loop. Disposing aborts it, releasing the park.
  const disposed = new AbortController();

  return {

    id: "test-livestream-subscription",
    initSegment: init,
    reassess: (): void => { /* No-op: the double has no recovery loop to re-decide. */ },
    state: "live",
    whenEstablished: async (): Promise<boolean> => true,
    [Symbol.asyncIterator]: async function *(): AsyncGenerator<Segment> {

      yield { ...init, type: "init" };

      for(let i = 0; i < mediaSegments; i++) {

        yield { data: KEYFRAME_FRAGMENT.data, mdat: KEYFRAME_FRAGMENT.mdat, moof: KEYFRAME_FRAGMENT.moof, type: "media" };
      }

      // Park: await the dispose-abort so the consumer's for-await never completes and the filled buffer survives. onAbort resolves the park at once when the double is
      // already disposed, and otherwise on the one-shot abort.
      await new Promise<void>((resolve) => {

        onAbort(disposed.signal, () => resolve());
      });
    },
    [Symbol.asyncDispose]: async (): Promise<void> => { disposed.abort(); }
  };
}

// A process-local monotonic counter minting a distinct default id per controllable double. Distinct ids are required: the timeshift's consumeSegments finally guards
// teardown on this.subscription?.id === subscription.id, so a restart test (start A, then start B) and the id-identity guard test need two doubles whose ids genuinely
// differ - or the guard cannot tell them apart and the test is vacuous.
let controllableLivestreamCounter = 0;

/**
 * The controllable livestream-subscription double: a queue-driven LivestreamSubscription a test feeds segments into one at a time and can end or throw-into, plus a
 * recording surface for behavior-first assertions. It generalizes makeLivestreamSubscriptionDouble's drain-loop/park iterator so a standalone ProtectTimeshiftBuffer test
 * can drive the SUT's full emission/lifecycle surface (an init segment, keyframe and non-keyframe media, a discontinuity-marked segment, a graceful end, and an iterator
 * error) without a recording delegate in the loop.
 *
 * @property disposed       - True once the double's asyncDispose ran; a test asserts a start-validation failure or a stop disposed the subscription.
 * @property end            - Enqueue a graceful end. Processed AFTER any already-queued segments (drain-then-close), so queued media is never dropped, then the iterator
 *                            returns and the timeshift's consumeSegments finally runs.
 * @property push           - Enqueue one media (or init) segment and wake the iterator. One push plus one settle() processes exactly that one segment; MULTIPLE pushes
 *                            plus one settle() drain all of them in a single macrotask, so an intermediate-state test must settle() after EACH push.
 * @property reassessCalls  - The number of times the timeshift called reassess() (its transmit-start recovery escalation).
 * @property releaseEstablishment - Resolve a deferred whenEstablished() to true, committing a start that was held in flight; the release handle for the
 *                                  deferEstablishment gate.
 * @property throwError     - Enqueue an iterator error. Processed after queued segments, then thrown into the for-await so the timeshift classifies it (and self-heals).
 */
export interface ControllableLivestreamDouble extends LivestreamSubscription {

  readonly disposed: boolean;
  end(): void;
  push(segment: Segment): void;
  readonly reassessCalls: number;
  // Resolve a deferred whenEstablished() to true, committing a start that was held in flight - the release handle for the deferEstablishment gate.
  releaseEstablishment(): void;
  throwError(error: unknown): void;
}

/* Build a controllable LivestreamSubscription double for a standalone timeshift behavior test.
 *
 * The iterator is the lost-wakeup-safe drain-loop the parking double established, generalized to a runtime-fed queue: it holds a queue of items
 * ({ kind: "segment" } | { kind: "end" } | { kind: "error" }), and on each turn it DRAINS THE WHOLE QUEUE - shifting and acting on every queued item (yield a segment,
 * return on end, throw on error) - and ONLY parks on a fresh one-shot resolver when the queue is empty and the double is not yet terminated; on wake it RE-CHECKS the
 * queue and continues the drain. Draining the whole queue per wake is required: a naive park/yield-one/re-park strands a second segment pushed under one wake
 * (empirically reproduced), so a two-push-then-drain self-test would observe only the first.
 *
 * The park keeps isStarted true: while the queue is open and the double is not ended/disposed the generator NEVER completes (it parks), so the timeshift's
 * consumeSegments for-await stays open, its finally does not run, the subscription stays committed, and timeshift.isStarted reports true. end()/throwError()/dispose are
 * the iterator-termination drivers that feed that finally: each enqueues its terminal item AFTER any queued segments (drain-then-close, so queued media is not
 * dropped) and wakes the iterator. whenEstablished resolves immediately (default true) so start() commits the subscription before the test pushes media; setting
 * deferEstablishment instead holds whenEstablished open until releaseEstablishment() resolves it true, so a start can be held in flight across a racing shutdown().
 *
 * The terminal transition is one-shot and safe to repeat: once the generator has returned (end/dispose) or thrown (error), the double is terminated and
 * push/end/throwError and a second dispose are NO-OPS, and the parking resolver is resolved at most once (guarded so no double-resolve). asyncDispose records disposed =
 * true and signals a graceful end if the double is not already terminated.
 */
export function makeControllableLivestreamDouble(options: { deferEstablishment?: boolean; description?: LivestreamDescription; id?: string;
  initSegment?: LivestreamInit | null; state?: LivestreamSubscriptionState; whenEstablished?: boolean; } = {}): ControllableLivestreamDouble {

  // The runtime-fed item queue and the lifecycle flags. terminated latches once the generator returns or throws, after which every control method no-ops.
  const queue: ({ kind: "segment"; segment: Segment } | { kind: "end" } | { kind: "error"; error: unknown })[] = [];
  let terminated = false;
  let disposed = false;
  let reassessCalls = 0;

  // Resolve the init segment, distinguishing "option omitted" (default to a populated init so start() commits, described by the description option or as no tracks)
  // from "option explicitly null" (the start-validation arm the timeshift declines on). A plain ?? cannot make that distinction - it treats an explicit null as nullish
  // and would override it with the default - so we branch on strict undefined.
  const initSegment = (options.initSegment === undefined) ? { codec: "h264", data: INIT_SEGMENT_DATA, description: options.description ?? NO_TRACKS } :
    options.initSegment;

  // The one-shot park resolver: the generator stores its resolver here before awaiting, and wake() resolves and clears it. Holding at most one resolver and clearing it
  // on resolve guarantees no double-resolve and no stale wake.
  let wakeResolver: (() => void) | null = null;

  // The deferred-establishment gate for the shutdown-versus-in-flight-start race. When deferEstablishment is set, whenEstablished() parks on this resolver until the
  // test calls releaseEstablishment(), so a start can be held in flight while shutdown() runs and then committed afterward. The release resolves to true specifically,
  // since a release-to-decline would never commit the subscription. Without the gate, whenEstablished resolves immediately.
  let establishmentResolver: ((established: boolean) => void) | null = null;

  // Wake a parked generator, if one is parked. Resolving and clearing in one step keeps the resolver one-shot.
  const wake = (): void => {

    const resolve = wakeResolver;

    wakeResolver = null;
    resolve?.();
  };

  // Enqueue an item and wake the iterator, unless the double has already terminated (in which case every control method is a no-op).
  const enqueue = (item: { kind: "segment"; segment: Segment } | { kind: "end" } | { kind: "error"; error: unknown }): void => {

    if(terminated) {

      return;
    }

    queue.push(item);
    wake();
  };

  return {

    get disposed(): boolean {

      return disposed;
    },
    end: (): void => enqueue({ kind: "end" }),
    id: options.id ?? ("controllable-livestream-" + (++controllableLivestreamCounter).toString()),
    initSegment,
    push: (segment: Segment): void => enqueue({ kind: "segment", segment }),
    reassess: (): void => { reassessCalls++; },
    get reassessCalls(): number {

      return reassessCalls;
    },
    releaseEstablishment: (): void => {

      const resolve = establishmentResolver;

      establishmentResolver = null;
      resolve?.(true);
    },
    state: options.state ?? "live",
    throwError: (error: unknown): void => enqueue({ error, kind: "error" }),
    whenEstablished: async (): Promise<boolean> => {

      if(options.deferEstablishment) {

        return new Promise<boolean>((resolve) => { establishmentResolver = resolve; });
      }

      return options.whenEstablished ?? true;
    },
    [Symbol.asyncIterator]: async function *(): AsyncGenerator<Segment> {

      // The drain-loop: process the whole queue, then park only when it is empty and we have not yet terminated. On wake, the outer while re-checks the queue.
      while(!terminated) {

        // Drain every queued item before considering a park, so no item pushed under a single wake is stranded.
        while(queue.length > 0) {

          const item = queue.shift();

          if(!item) {

            break;
          }

          switch(item.kind) {

            case "end": {

              terminated = true;

              return;
            }

            case "error": {

              terminated = true;

              throw item.error;
            }

            case "segment": {

              yield item.segment;

              break;
            }

            default: {

              throw new Error("The controllable livestream double received an unknown queue item kind.");
            }
          }
        }

        // The queue is empty, so park on a fresh one-shot resolver until a control method wakes us, then re-check the queue. For the one consumer the double
        // serves, the loop's condition is the only terminated check the park needs: the drain sets the flag only where it leaves the generator at once.
        // eslint-disable-next-line no-await-in-loop -- The park is intentionally serial: the generator suspends here until a push/end/throwError/dispose wakes it.
        await new Promise<void>((resolve) => { wakeResolver = resolve; });
      }
    },
    [Symbol.asyncDispose]: async (): Promise<void> => {

      // Record the dispose and, if the double has not already terminated, signal a graceful end so the parked iterator completes its finally. Safe to repeat: a second
      // dispose after termination no-ops via the enqueue terminated-guard.
      disposed = true;
      enqueue({ kind: "end" });
    }
  };
}

/**
 * Build a TestCameraHost wired to a real makeTestNvr context, returning the host plus its test-side handles. This is the media-delegate counterpart to makeTestNvr: it
 * composes the existing doubles (a TestStateStore-backed makeTestNvr context and a TestAccessory) into the camera-host interface every media-delegate test constructs
 * against, so a delegate is unit-constructed with no real camera. The single boundary casts live inside TestCameraHost's constructor (the doubles are not the production
 * handle types); the host returned here is the production-interface-typed double.
 *
 * @param options - clock: an optional controllable TestClock forwarded into the makeTestNvr platform double's clock interface and re-returned, so a test holds the one
 *                  clock every delegate built against this host reads through platform.clock - the recording delegate's transmit pacing and the streaming delegate's
 *                  probesize reset among them - and advances it to fire what is due (omitted, makeTestNvr creates a fresh TestClock seeded at TEST_CLOCK_EPOCH);
 *                  recordingProcessFactory: the test recording-process factory injected into the makeTestNvr platform double's recordingProcessFactory interface, so a
 *                  transmit test's delegate constructs its FFmpeg process through the test double (omitted, makeTestNvr installs a fresh default factory); userOptions:
 *                  feature-option config strings forwarded to the makeTestNvr context's REAL FeatureOptions engine (for a later behavior test that steers a feature-gated
 *                  delegate path); the default empty context is the quiet-default host.
 *
 * @returns accessory: the TestAccessory backing the host; clock: the controllable TestClock installed on the platform double (the one clock every delegate built against
 *          this host reads, so a test advances it to release the recording delegate's transmit pacing or to fire the streaming delegate's probesize reset); controller:
 *          the AbortController behind the context's signal (abort it in suite teardown); host: the TestCameraHost double under test; logEntries: every line the
 *          construction and transmit paths logged (so a transmit test can assert on captured telemetry); nvr: the NVR double backing the context.
 */
export function makeTestCameraHost(options: { clock?: TestClock; recordingProcessFactory?: RecordingProcessFactory; userOptions?: string[] } = {}):
{ accessory: TestAccessory; clock: TestClock; controller: AbortController; host: TestCameraHost; logEntries: readonly TestLogEntry[]; nvr: TestProtectNvr } {

  const store = new TestStateStore(makeProtectState());
  const { clock, controller, logEntries, nvr } = makeTestNvr({ clock: options.clock, recordingProcessFactory: options.recordingProcessFactory, store,
    userOptions: options.userOptions });
  const accessory = makeTestAccessory();
  const host = new TestCameraHost({ accessory, nvr });

  return { accessory, clock, controller, host, logEntries, nvr };
}
