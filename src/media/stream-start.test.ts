/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * stream-start.test.ts: Behavior coverage of a live view's start on the real streaming delegate - the command each kind of live view hands FFmpeg, the input a
 * buffer-backed view feeds it, and what a failed FFmpeg, a livestream that never establishes and an offline camera each do to the start - and of a two-way audio
 * view's prepare and start: its demuxer and ports, its return audio toward the camera or through the controller's talkback channel, and each way that path can end.
 *
 * Every row runs the real ProtectStreamingDelegate over the camera-host double, driven the way HomeKit drives it: a prepare, then a START through
 * handleStreamRequest. The delegate builds its FFmpeg processes through the platform's streaming process factory, here HBPU's TestStreamingProcessFactory, so a row
 * reads the command and the init a live view assembled from the recorded create call and drives the process it got back - its readiness, its stderr and its exit -
 * with no FFmpeg anywhere. The ports come from the platform double's real RTP port allocator, whose probes hold no socket open, or, for a row that reads a prepare's
 * reservations, from an allocator over HBPU's probe-socket double scripted with invented ports. A buffer-backed view runs on the delegate's own timeshift supervisor
 * over two controllable livestream doubles, the buffer's and then the view's, and its preload is read as the first bytes the process's stdin received.
 *
 * A two-way view builds its demuxer through HBPU's TestRtpDemuxerFactory, which binds nothing, so a row drives its first packet and its socket fault by hand. A view
 * relayed through the controller connects unifi-protect's real talkback session over the fake socket its testing entry ships, so a row reads what the session sent
 * and whether it closed from that socket, and reads the session's connect and send through the delegate's own lines. Every request, key, address, port, frame and
 * fragment here is invented.
 */
import { AudioRecordingCodecType, AudioStreamingCodecType, AudioStreamingSamplerate, FfmpegCodecs, H264Level, H264Profile, HOMEKIT_IDR_INTERVAL, HbpuAbortError,
  RtpPortAllocator, SRTPCryptoSuites, StreamRequestTypes, VideoCodecType, isHbpuAbortReason, parseFfmpegVersionParts } from "homebridge-plugin-utils";
import type { ControllableLivestreamDouble, TestCameraHost } from "./testing.helpers.ts";
import type { LivestreamDescription, ProtectCameraTalkbackConfig } from "unifi-protect";
import type { Nullable, VideoEncoderOptions } from "homebridge-plugin-utils";
import type { PrepareStreamRequest, PrepareStreamResponse, StartStreamRequest, VideoInfo } from "homebridge";
import { ProtectStreamingDelegate, isCleanTalkbackStop } from "./stream.ts";
import type { TestClock, TestLogEntry, TestSocketBind } from "homebridge-plugin-utils/testing";
import { TestExecProcessFactory, TestProbeSocketFactory, TestRtpDemuxerFactory, TestStreamingProcessFactory, capturingLog, expectAt, hardwareDecoderRefusalLine,
  linesAt, logCount, present, settle, settleUntil } from "homebridge-plugin-utils/testing";
import { after, describe, test } from "node:test";
import { endPendingProcesses, makeChannelProfile, makeControllableLivestreamDouble, makeKeyframeFragment, makeMediaSegment, makeNonKeyframeFragment,
  makeTestCameraHost } from "./testing.helpers.ts";
import type { ChannelProfile } from "./resolution.ts";
import { PROTECT_LIVE_VIEW_START_DEADLINE_MS } from "../settings.ts";
import { ProtectAbortedError } from "unifi-protect";
import { TestTalkbackFactory } from "unifi-protect/testing";
import type { TestTalkbackSocket } from "unifi-protect/testing";
import assert from "node:assert/strict";
import { hardwareDecodeCheckArgs } from "./timeshift-supervisor.ts";

// Every host this suite builds holds its own makeTestNvr AbortController. Aborting them at the end releases every signal a row left standing.
const controllers: AbortController[] = [];

after(() => {

  for(const controller of controllers) {

    controller.abort();
  }
});

// The probe size every live view here starts with, nonzero so the -probesize argument, the preload's floor and the self-tune's doubling each carry a value a row can
// tell from the default.
const PROBESIZE = 64;

// The audio packet time HomeKit negotiates for a high latency session, in milliseconds. A START carries it only when a row asks for a high latency view.
const HIGH_LATENCY_PACKET_TIME = 60;

// The bitrate of the channel each live view selects, in bits per second, so a re-encode targets HomeKit's request rather than the zero a fixture channel carries.
const CHANNEL_BITRATE = 4000000;

// The session HomeKit prepares and starts, and the client address and ports it negotiates for it.
const SESSION_ID = "test-live-view-session";
const HOMEKIT_ADDRESS = "192.168.1.20";
const VIDEO_PORT = 52000;
const AUDIO_PORT = 52002;

// The SRTP keys and salts HomeKit hands for each stream, at the lengths its crypto suite uses.
const VIDEO_KEY = Buffer.alloc(16, 1);
const VIDEO_SALT = Buffer.alloc(14, 2);
const AUDIO_KEY = Buffer.alloc(16, 3);
const AUDIO_SALT = Buffer.alloc(14, 4);

// HAP's one packetization mode, non-interleaved, by its number: HAP declares it as an ambient const enum, which TypeScript refuses to read under isolated modules,
// and HBPU mirrors no value for it.
// eslint-disable-next-line @typescript-eslint/no-unsafe-enum-assignment -- The number is the const enum member's own value, which TypeScript cannot import here.
const NON_INTERLEAVED: VideoInfo["packetizationMode"] = 0;

// The friendly sentence a known livestream API hiccup is answered with on a buffer-backed view, written out here rather than read from the module, which keeps it
// private.
const FRIENDLY_SENTENCE = "FFmpeg ended unexpectedly due to issues processing the media stream provided by the UniFi Protect livestream API. This error can be " +
  "safely ignored - it will occur occasionally.";

// The line FFmpeg writes when it runs out of probe size before it can estimate the stream's rate.
const PROBESIZE_LINE = "not enough frames to estimate rate; consider increasing probesize";

// A codec support whose FFmpeg carries the AAC encoder a live view's audio needs, on the host system the platform double's stub names, so a row with audio differs
// from one without only in the codec its FFmpeg can read.
const AAC_CODECS = FfmpegCodecs.fromState({ codecs: { aac: { decoders: new Set<string>(), encoders: new Set(["libfdk_aac"]) } }, cpuGeneration: 0,
  ffmpegExec: "ffmpeg", ffmpegVersion: "8.0", ffmpegVersionParts: parseFfmpegVersionParts("8.0"), gpuMem: 0, hostSystem: "macOS", hwAccels: new Set<string>(),
  verbose: false });

// A codec support for an Apple Silicon host whose FFmpeg carries VideoToolbox among its hardware accelerators, so a camera with hardware decoding on decodes its
// H.264 on the host's hardware decoder.
const APPLE_SILICON_CODECS = FfmpegCodecs.fromState({ codecs: {}, cpuGeneration: 0, ffmpegExec: "ffmpeg", ffmpegVersion: "8.0",
  ffmpegVersionParts: parseFfmpegVersionParts("8.0"), gpuMem: 0, hostSystem: "macOS.Apple", hwAccels: new Set(["videotoolbox"]), verbose: false });

// A stream described with an H.264 video track at an invented frame size, as unifi-protect reads a description from a livestream's init segment.
const H264_STREAM: LivestreamDescription = { tracks: [{ codec: "h264", height: 1080, id: 1, kind: "video", level: 40, profile: 77, width: 1920 }] };

// The sentence the quiet answer logs at debug for a failed FFmpeg pipeline, transcribed so a sentence that drifts in its one home reddens a row.
const QUIET_SENTENCE = "An FFmpeg pipeline whose failure is routine exited without completing, and its caller carries on without its output.";

// A codec support whose FFmpeg carries no AAC encoder, so a view whose camera and options ask for audio has no audio to send.
const NO_AAC_CODECS = FfmpegCodecs.fromState({ codecs: {}, cpuGeneration: 0, ffmpegExec: "ffmpeg", ffmpegVersion: "8.0",
  ffmpegVersionParts: parseFfmpegVersionParts("8.0"), gpuMem: 0, hostSystem: "macOS", hwAccels: new Set<string>(), verbose: false });

// The camera a two-way view talks back to: the address the controller reports for it, and the talkback settings its speaker takes, each invented. A direct view sends
// its return audio to that address at the settings' port, and every two-way view encodes its return audio at the settings' rate and channel count.
const CAMERA_ADDRESS = "192.168.1.30";
const TALKBACK_SETTINGS: ProtectCameraTalkbackConfig = { bindAddr: "0.0.0.0", bindPort: 48230, bitsPerSample: 16, channels: 1, filterAddr: null, filterPort: null,
  quality: 100, samplingRate: 22050, typeFmt: "aac", typeIn: "serverudp", url: "rtp://192.168.1.30:48230" };

// An IPv6 client a prepare can name in place of the IPv4 one, with no zone, and a camera address that carries one, which no destination can hold.
const HOMEKIT_IPV6_ADDRESS = "2001:db8::20";
const ZONED_CAMERA_ADDRESS = "fe80::30%lan0";

/* The ports a scripted two-way prepare's binds answer, in the order it reserves them: the RTCP port, the input port, the first of the RTP pair, and the video return
 * port. A single port and a pair's first are each asked for at random, and a pair's second by number, so the script answers that one with exactly the port after the
 * first, the only answer its bind accepts. The reserved ports are distinct and the pair's second is none of them, so no answer collides with a port the pool already
 * holds, which would cost the allocator a bind the script never names.
 */
const RTCP_PORT = 50000;
const INPUT_PORT = 50010;
const RTP_PORT = 50020;
const VIDEO_RETURN_PORT = 50030;
const TWO_WAY_BINDS: readonly TestSocketBind[] = [ RTCP_PORT, INPUT_PORT, RTP_PORT, RTP_PORT + 1, VIDEO_RETURN_PORT ];

// How many attempts HBPU's allocator makes at a reservation before it gives up. HBPU keeps the limit to itself, so it is written out here.
const RESERVE_ATTEMPTS = 10;

// The encoder options a re-encoded view of the START below resolves to: HomeKit's size, level, profile and bitrate, at the lower of its frame rate and the channel's.
const TRANSCODE_OPTIONS: VideoEncoderOptions = { bitrate: 2000, fps: 30, height: 720, idrInterval: HOMEKIT_IDR_INTERVAL, inputCodec: "h264", inputFps: 30,
  level: H264Level.LEVEL4_0, profile: H264Profile.MAIN, width: 1280 };

// Where a live view's input comes from: the standing timeshift buffer's pooled livestream, or a direct RTSP session.
type LiveViewInput = "buffer" | "rtsp";

// A kind of live view: its input, and whether it re-encodes the video.
interface LiveViewKind {

  input: LiveViewInput;
  transcode: boolean;
}

// Every kind of live view, each with the name its rows read under.
const KINDS: (LiveViewKind & { name: string })[] = [

  { input: "rtsp", name: "a direct-RTSP view copying the camera's video", transcode: false },
  { input: "rtsp", name: "a direct-RTSP view re-encoding the video", transcode: true },
  { input: "buffer", name: "a buffer-backed view copying the camera's video", transcode: false },
  { input: "buffer", name: "a buffer-backed view re-encoding the video", transcode: true }
];

// What the prepare answered for one stream: the port the session listens on and the SSRC it sends with.
interface PreparedSource {

  port: number;
  ssrc: number;
}

// How a two-way view takes HomeKit's audio back to the camera: straight to the camera over UDP, or relayed through the controller's talkback channel.
type TwoWayRoute = "direct" | "relayed";

// The HomeKit client a prepare names: its address, and the address family the prepare asks for.
interface HomeKitClient {

  address: string;
  family: PrepareStreamRequest["addressVersion"];
}

// A live view built on the real delegate before HomeKit prepares it, and the handles a row reads: the clock, the AbortController behind the host's harness, the
// delegate under test, the demuxer factory, the exec process factory and the streaming process factory it builds through, the sessions the delegate told HomeKit were
// over, the host, the captured log (the host's own when the row gave it one) and the platform's, the preload a buffer-backed view should feed FFmpeg first, the
// probe-socket double the allocator binds through when the row scripted it, the view's own livestream double, and the preload a high latency buffer-backed view
// should feed FFmpeg first, the buffer's whole window.
interface BuiltLiveView {

  clock: TestClock;
  controller: AbortController;
  delegate: ProtectStreamingDelegate;
  demuxers: TestRtpDemuxerFactory;
  exec: TestExecProcessFactory;
  factory: TestStreamingProcessFactory;
  forceStops: string[];
  host: TestCameraHost;
  logEntries: readonly TestLogEntry[];
  platformLogEntries: readonly TestLogEntry[];
  preload: Nullable<Buffer>;
  probes: Nullable<TestProbeSocketFactory>;
  view: Nullable<ControllableLivestreamDouble>;
  windowPreload: Nullable<Buffer>;
}

// A prepared live view: the built view and what the prepare answered for each stream.
interface LiveViewRig extends BuiltLiveView {

  prepared: { audio: PreparedSource; video: PreparedSource };
}

/* eslint-disable camelcase -- The keys are the ones HAP's streaming request types define. */

// The prepare HomeKit sends for the session: the client's address in the family the prepare asks for, the IPv4 client unless a row names another, and the port,
// SRTP key and salt it negotiated for each stream.
function prepareRequest(client: HomeKitClient = { address: HOMEKIT_ADDRESS, family: "ipv4" }): PrepareStreamRequest {

  return {

    addressVersion: client.family,
    audio: { port: AUDIO_PORT, srtpCryptoSuite: SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80, srtp_key: AUDIO_KEY, srtp_salt: AUDIO_SALT },
    sessionID: SESSION_ID,
    sourceAddress: "192.168.1.10",
    targetAddress: client.address,
    video: { port: VIDEO_PORT, srtpCryptoSuite: SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80, srtp_key: VIDEO_KEY, srtp_salt: VIDEO_SALT }
  };
}

// The START HomeKit sends for the session: H.264 Main video at the size, frame rate and bitrate ceiling written out below, and AAC-ELD audio at the given rate and
// packet time, by default one HomeKit negotiates for a session that is not high latency. The audio's bitrate ceiling and channel count are values a command would not
// carry unless it took them from the request.
function startRequest(sampleRate: AudioStreamingSamplerate, packetTime = 30): StartStreamRequest {

  return {

    audio: { bit_rate: 0, channel: 2, codec: AudioStreamingCodecType.AAC_ELD, comfortNoiseEnabled: false, comfort_pt: 13, max_bit_rate: 20, packet_time: packetTime,
      pt: 110, rtcp_interval: 5, sample_rate: sampleRate, ssrc: 1001 },
    sessionID: SESSION_ID,
    type: StreamRequestTypes.START,
    video: { codec: VideoCodecType.H264, fps: 30, height: 720, level: H264Level.LEVEL4_0, max_bit_rate: 2000, mtu: 1378, packetizationMode: NON_INTERLEAVED,
      profile: H264Profile.MAIN, pt: 99, rtcp_interval: 5, ssrc: 1002, width: 1280 }
  };
}

/* eslint-enable camelcase */

// One stream of the prepare's answer, read as the direct source the delegate answers with rather than a proxied one.
function preparedSource(source: PrepareStreamResponse["video"] | undefined): PreparedSource {

  assert.ok(source && ("ssrc" in source), "the prepare answered a direct source with its own port and SSRC");

  return { port: source.port, ssrc: source.ssrc };
}

// Prepare the session through the delegate, as HomeKit does ahead of every START, and hand back HomeKit's answer: the error the prepare failed with, or its response.
async function prepare(delegate: ProtectStreamingDelegate, request: PrepareStreamRequest = prepareRequest()):
Promise<{ error: Error | undefined; response: PrepareStreamResponse | undefined }> {

  const { promise, resolve } = Promise.withResolvers<{ error: Error | undefined; response: PrepareStreamResponse | undefined }>();

  delegate.prepareStream(request, (error?: Error, response?: PrepareStreamResponse): void => resolve({ error, response }));

  return promise;
}

// What a row asks of the view it arranges, beside its kind: each is described where buildLiveView reads it.
interface LiveViewOptions extends LiveViewKind {

  audio?: boolean;
  audioFilters?: string[];
  bufferDescription?: LivestreamDescription;
  client?: HomeKitClient;
  codecSupport?: FfmpegCodecs;
  demuxerBinds?: TestSocketBind[];
  features?: string[];
  floorPastLatestKeyframe?: boolean;
  hardwareDecoding?: boolean;
  holdTalkbackOpen?: boolean;
  ownLog?: boolean;
  portBinds?: readonly TestSocketBind[];
  twoWay?: TwoWayRoute;
  view?: ControllableLivestreamDouble;
}

/* Build a live view of the given kind on the real delegate, ready for HomeKit's prepare. A direct-RTSP view selects the channel itself. A buffer-backed view runs on
 * the delegate's own supervisor, whose buffer starts on the first queued livestream double and holds keyframe fragments with a fragment without one after each, so the
 * preload starts at the latest keyframe, and fewer fragments than the preload's window holds, so a high latency view's whole window is every one of them; the view
 * takes the second queued double, the one the row hands in or a fresh one. With audio on, the camera has a microphone, the audio option is on and the platform's
 * codec support carries an AAC encoder unless the row hands another, each in place before the delegate is built, and the camera answers the audio filters the row
 * names, none unless it names some. The camera answers the feature options the row names beside the audio option.
 *
 * A two-way view turns audio on and the two-way hint with it, direct to the camera or relayed through the controller, and gives the camera what a two-way START reads
 * of it: the address the controller reports for it and its speaker's talkback settings. Its demuxer is built through the rig's own demuxer double, whose binds the
 * row may script, and a relayed view's talkback session connects through the host's talkback factory, one that holds each open pending when the row asks.
 *
 * A row that reads a prepare's reservations hands the binds the allocator's probes answer, and the platform then reserves through an allocator over HBPU's
 * probe-socket double scripted with them. A row that tells the camera's lines from the platform's gives the host a capturing logger of its own before the delegate is
 * built, which the delegate then logs through.
 *
 * A row that turns hardware decoding on does so before the delegate is built, over a codec support it hands. A buffer-backed view's buffer reads its stream as the row
 * describes it, as no tracks unless it names some, and a stream it describes with a video track has the supervisor check that stream against the hardware decoder at
 * the buffer's first keyframe, inside the arrangement, through the rig's own exec process factory.
 */
async function buildLiveView(options: LiveViewOptions): Promise<BuiltLiveView> {

  const audio = (options.audio === true) || (options.twoWay !== undefined);
  const demuxers = new TestRtpDemuxerFactory(options.demuxerBinds);
  const exec = new TestExecProcessFactory();
  const factory = new TestStreamingProcessFactory();
  const probes = options.portBinds ? new TestProbeSocketFactory(options.portBinds) : null;
  const { clock, controller, host, logEntries } = makeTestCameraHost({ codecSupport: options.codecSupport ?? (audio ? AAC_CODECS : undefined), execProcessFactory: exec,
    rtpDemuxerFactory: demuxers, rtpPorts: probes ? new RtpPortAllocator({ socketFactory: probes.create }) : undefined, streamingProcessFactory: factory });
  const hostLog = options.ownLog ? capturingLog() : null;

  controllers.push(controller);

  if(hostLog) {

    host.log = hostLog;
  }

  // A camera with cropping off carries no crop options at all, and the neutral hint bag fills them with zeros, which HBPU would render as a crop no camera asks
  // for. The arranged view carries none, so a re-encoding row reads the command a camera with cropping off is given.
  host.hints.cropOptions = undefined;
  host.hints.hardwareDecoding = options.hardwareDecoding ?? false;
  host.hints.probesize = PROBESIZE;
  host.hints.transcode = options.transcode;

  const features = [ ...(audio ? ["Audio"] : []), ...(options.features ?? []) ];

  host.hasFeature = (option: string): boolean => features.includes(option);

  if(audio) {

    const audioFilters = options.audioFilters ?? [];

    host.getAudioFilters = (): string[] => audioFilters;
    host.ufp = { ...host.ufp, featureFlags: { ...host.ufp.featureFlags, hasMic: true } };
  }

  if(options.twoWay) {

    host.hints.twoWayAudio = true;
    host.hints.twoWayAudioDirect = options.twoWay === "direct";
    host.ufp = { ...host.ufp, host: CAMERA_ADDRESS, talkbackSettings: TALKBACK_SETTINGS };
  }

  if(options.holdTalkbackOpen) {

    host.talkbackFactory = new TestTalkbackFactory({ autoOpen: false });
  }

  const fixture = makeChannelProfile(host);
  const profile: ChannelProfile = { ...fixture, channel: { ...fixture.channel, bitrate: CHANNEL_BITRATE } };
  const delegate = new ProtectStreamingDelegate(host, [[ 1920, 1080, 30 ]]);

  host.stream = delegate;

  // The delegate tells HomeKit a session is over through its controller's force-stop. HAP opened no session here, so the real method would find none and do nothing,
  // and a row reads the call through this record in its place.
  const forceStops: string[] = [];

  delegate.controller.forceStopStreamingSession = (sessionId: string): void => void forceStops.push(sessionId);

  let preload: Nullable<Buffer> = null;
  let view: Nullable<ControllableLivestreamDouble> = null;
  let windowPreload: Nullable<Buffer> = null;

  if(options.input === "rtsp") {

    host.selectChannel = (): ChannelProfile => profile;
  } else {

    const buffer = makeControllableLivestreamDouble({ description: options.bufferDescription });
    const fragments = [ makeKeyframeFragment(), makeNonKeyframeFragment(), makeKeyframeFragment(), makeNonKeyframeFragment() ];

    view = options.view ?? makeControllableLivestreamDouble();
    host.selectSubstrateChannel = (): ChannelProfile => profile;
    host.usesTimeshiftLivestream = true;
    host.livestreamSubscriptions = [ buffer, view ];

    await delegate.timeshift?.reconcile();

    for(const fragment of fragments) {

      buffer.push(makeMediaSegment(fragment));
    }

    await settle();

    assert.equal(delegate.timeshift?.buffer.time, fragments.length * (delegate.timeshift?.buffer.segmentLength ?? 0), "the buffer holds every fragment");
    assert.ok(buffer.initSegment, "the buffer's livestream carries its init segment");

    const fromLatestKeyframe = fragments.slice(2);

    // A row that asks for it raises the probe size a byte past what the fragments from the latest keyframe hold, so the preload has to back up to the fragment ahead of
    // that keyframe to meet it.
    if(options.floorPastLatestKeyframe) {

      host.hints.probesize = fromLatestKeyframe.reduce((bytes, fragment) => bytes + fragment.data.length, 0) + 1;
    }

    preload = Buffer.concat([ buffer.initSegment.data, ...(options.floorPastLatestKeyframe ? fragments.slice(1) : fromLatestKeyframe).map((fragment) => fragment.data) ]);
    windowPreload = Buffer.concat([ buffer.initSegment.data, ...fragments.map((fragment) => fragment.data) ]);
  }

  return { clock, controller, delegate, demuxers, exec, factory, forceStops, host, logEntries: hostLog?.entries ?? logEntries, platformLogEntries: logEntries, preload,
    probes, view, windowPreload };
}

// Build a live view of the given kind and prepare it, as HomeKit prepares every session ahead of its START, for the client the row names or the IPv4 one.
async function arrangeLiveView(options: LiveViewOptions): Promise<LiveViewRig> {

  const built = await buildLiveView(options);
  const { error, response } = await prepare(built.delegate, prepareRequest(options.client));

  if(error || !response) {

    throw error ?? new Error("The prepare answered with no response.");
  }

  return { ...built, prepared: { audio: preparedSource(response.audio), video: preparedSource(response.video) } };
}

// Send the START at the given audio rate and packet time, let the delegate run as far as it goes on its own, and hand back HomeKit's answers as they arrive. A row
// that names no packet time sends the one startRequest writes by default.
async function startLiveView(rig: LiveViewRig, sampleRate: AudioStreamingSamplerate = AudioStreamingSamplerate.KHZ_16, packetTime?: number):
Promise<(Error | undefined)[]> {

  const answers: (Error | undefined)[] = [];

  rig.delegate.handleStreamRequest(startRequest(sampleRate, packetTime), (error?: Error): void => void answers.push(error));

  await settle();

  return answers;
}

// Send the STOP for the session, as HomeKit does when its viewer leaves.
function stopSession(rig: BuiltLiveView): void {

  rig.delegate.handleStreamRequest({ sessionID: SESSION_ID, type: StreamRequestTypes.STOP }, (): void => undefined);
}

/* End a row: stop the session, end every process the row has not already ended through the shared teardown, as a killed child would end since the double has no
 * child to kill, and shut the supervisor and then the delegate down. The view's livestream is released last, so an establishment the row held open settles too. The
 * harness's own signal is ended with the row, which releases the timer the harness arms for itself, so a timer still armed after it is one the live view left behind.
 */
async function endLiveView(rig: BuiltLiveView): Promise<void> {

  stopSession(rig);

  await endPendingProcesses([ rig.exec, rig.factory ]);

  rig.delegate.timeshift?.shutdown();
  rig.delegate.shutdown();
  rig.view?.releaseEstablishment();
  rig.controller.abort();

  await settle();

  assert.equal(rig.clock.pending, 0, "the row leaves no timer armed on the platform's clock");
  assert.equal(rig.host.platform.rtpPorts.reservedCount, 0, "the row leaves no port reserved");
}

// The SRTP sink a live view sends its video to: HomeKit's payload type and the session's SSRC, key and salt, toward the client's video port.
function videoSink(rig: LiveViewRig): string {

  return "[f=rtp:select=v:payload_type=99:ssrc=" + rig.prepared.video.ssrc.toString() + ":flush_packets=1:packetsize=1200:srtp_out_suite=AES_CM_128_HMAC_SHA1_80:" +
    "srtp_out_params=" + Buffer.concat([ VIDEO_KEY, VIDEO_SALT ]).toString("base64") + "]srtp://192.168.1.20:52000?rtcpport=52000";
}

// The SRTP sink a live view sends its audio to, which a failure to open drops alone: HomeKit's payload type and the session's SSRC, key and salt, toward the
// client's audio port.
function audioSink(rig: LiveViewRig): string {

  return "|[f=rtp:select=a:onfail=ignore:payload_type=110:ssrc=" + rig.prepared.audio.ssrc.toString() + ":flush_packets=1:packetsize=384:" +
    "srtp_out_suite=AES_CM_128_HMAC_SHA1_80:srtp_out_params=" + Buffer.concat([ AUDIO_KEY, AUDIO_SALT ]).toString("base64") + "]srtp://192.168.1.20:52002?rtcpport=52002";
}

// The exact command a live view of the given kind hands FFmpeg for the START above, from the shared head to the tee. The encoders, and the decoder flags a row hands,
// are HBPU's renders of the options a view hands them, so their arguments are read from the delegate's own FFmpeg options, and everything else is written out.
function expectedArgs(rig: LiveViewRig, kind: LiveViewKind & { audio?: boolean; audioFilters?: string[]; decoder?: string[]; sampleRateKhz?: number }): string[] {

  const input = (kind.input === "buffer") ? [ "-f", "mp4", "-i", "pipe:0" ] : [ "-avioflags", "direct", "-rtsp_transport", "tcp", "-i", "rtsps://test" ];
  const copy = (kind.input === "buffer") ? [ "-codec:v", "copy", "-bsf:v", "h264_mp4toannexb" ] : [ "-codec:v", "copy" ];
  const audioMap = (kind.input === "buffer") ? "0:a:0?" : "0:a:1?";

  return [

    "-hide_banner", "-nostats", "-fflags", "+discardcorrupt", "-err_detect", "ignore_err", ...(kind.decoder ?? []), "-max_delay", "500000", "-flags", "low_delay",
    "-probesize", "64",
    ...input,
    "-map", "0:v:0",
    ...(kind.audio ? [ "-map", audioMap ] : []),
    ...(kind.transcode ? rig.delegate.ffmpegOptions.streamEncoder(TRANSCODE_OPTIONS) : copy),
    "-metadata", "comment=Test Camera Livestream",
    ...(kind.audio ? [ ...rig.delegate.ffmpegOptions.audioEncoder(), "-flags:a", "+global_header", "-profile:a", "38", "-ar",
      (kind.sampleRateKhz ?? 16).toString() + "k", "-b:a", "20k", "-ac", "2" ] : []),
    ...(kind.audioFilters?.length ? [ "-filter:a", kind.audioFilters.join(", ") ] : []),
    "-f", "tee", videoSink(rig) + (kind.audio ? audioSink(rig) : "")
  ];
}

// The live view's process, the one create call a START without two-way audio makes.
function liveViewCall(rig: LiveViewRig): TestStreamingProcessFactory["createCalls"][number] {

  assert.equal(rig.factory.createCalls.length, 1, "the live view built one process");

  return expectAt(rig.factory.createCalls, 0, "the live view's process");
}

/* Start a live view and read what every kind shares: one process, built over the delegate's FFmpeg options, carrying the exact command, the health watchdog on the
 * session's video return port and no onTimeout, with HomeKit answered when the process is ready and not before. The process is handed back ready.
 */
async function startReadyLiveView(rig: LiveViewRig, kind: LiveViewKind): Promise<TestStreamingProcessFactory["createCalls"][number]> {

  const answers = await startLiveView(rig);
  const call = liveViewCall(rig);

  assert.equal(call.options, rig.delegate.ffmpegOptions, "the process runs over the delegate's FFmpeg options");
  assert.deepEqual(call.init.args, expectedArgs(rig, kind), "the exact command, from the shared head to the tee's video sink");
  assert.equal(call.init.args.some((argument) => argument.includes("crop=")), false, "a camera with cropping off is given no crop filter");
  assert.deepEqual(call.init.returnPort, { ipFamily: "ipv4", port: rig.prepared.video.port }, "the health watchdog listens on the session's video return port");
  assert.equal(call.init.onTimeout, undefined, "no onTimeout is handed, so a watchdog timeout keeps HBPU's warning");
  assert.equal(call.init.signal?.aborted, false, "the process's signal stands while the session runs");
  assert.equal(answers.length, 0, "HomeKit is not answered before the process is ready");

  call.process.resolveReady();
  await settle();

  assert.deepEqual(answers, [undefined], "HomeKit is answered once the process is ready");

  return call;
}

// A session the bridge ended after its process failed: stopped once, with the session's signal ended by the stop.
function assertStopped(rig: LiveViewRig, call: TestStreamingProcessFactory["createCalls"][number]): void {

  assert.deepEqual(rig.forceStops, [SESSION_ID], "HomeKit is told the session is over, once");
  assert.equal(logCount(rig.logEntries, "info", "Stopped video streaming session."), 1, "the session is stopped once");
  assert.ok(isHbpuAbortReason(call.init.signal?.reason, "shutdown"), "the stop ended the session's signal");
}

describe("a live view's start - the command, the process's init and HomeKit's answer", () => {

  for(const kind of KINDS.filter(({ input }) => input === "rtsp")) {

    test(kind.name + " hands FFmpeg its exact command, and the session's stop ends the process's signal", async () => {

      const rig = await arrangeLiveView(kind);
      const call = await startReadyLiveView(rig, kind);

      stopSession(rig);

      assert.ok(isHbpuAbortReason(call.init.signal?.reason, "shutdown"), "the process's signal is the session's, which the stop ends");

      await endLiveView(rig);
    });
  }

  // The buffer's latest keyframe meets the probe size, so the preload is the init segment and the fragments from that keyframe on. It reaches FFmpeg as the header the
  // first media fragment brings.
  for(const kind of KINDS.filter(({ input }) => input === "buffer")) {

    test(kind.name + " hands FFmpeg its exact command, and feeds it the init segment and the fragments from the latest keyframe first", async () => {

      const rig = await arrangeLiveView(kind);
      const call = await startReadyLiveView(rig, kind);

      assert.ok(rig.preload, "the vacuity guard: the row arranged a preload");
      assert.equal(call.process.stdinWrites.length, 0, "nothing reaches FFmpeg before the view's first media fragment");

      rig.view?.push(makeMediaSegment(makeKeyframeFragment()));
      await settle();

      assert.ok(expectAt(call.process.stdinWrites, 0, "the first write").equals(rig.preload), "the first write is the preload, exact bytes");
      assert.deepEqual(rig.logEntries.filter(({ level, message }) => (level === "debug") && (message === "Live view preload.")).map(({ params }) => params),
        [[{ bytes: rig.preload.length, probesize: PROBESIZE }]], "the preload's debug line carries its size and the probe size");

      stopSession(rig);

      assert.ok(isHbpuAbortReason(call.init.signal?.reason, "shutdown"), "the process's signal is the session's, which the stop ends");

      await endLiveView(rig);
    });
  }

  // A probe size the fragments from the latest keyframe do not reach backs the preload up a fragment at a time until it is met, so FFmpeg is never handed less than
  // it probes and still opens on the latest keyframe.
  test("a buffer-backed view whose latest keyframe leaves less than the probe size preloads from the fragment ahead of it", async () => {

    const rig = await arrangeLiveView({ floorPastLatestKeyframe: true, input: "buffer", transcode: false });

    await startLiveView(rig);

    const call = liveViewCall(rig);
    const args = call.init.args ?? [];

    assert.ok(rig.preload, "the vacuity guard: the row arranged a preload");
    assert.equal(args[args.indexOf("-probesize") + 1], rig.host.hints.probesize.toString(), "FFmpeg is told the probe size the preload was held to");

    rig.view?.push(makeMediaSegment(makeKeyframeFragment()));
    await settle();

    assert.ok(expectAt(call.process.stdinWrites, 0, "the first write").equals(rig.preload),
      "the first write is the preload backed up to meet the probe size, exact bytes");

    await endLiveView(rig);
  });

  // A high latency START takes the buffer's whole window rather than the start at its latest keyframe, so FFmpeg is first handed every fragment the window holds,
  // the fragments ahead of that keyframe among them, where the same buffer gives a view that is not high latency the shorter preload from the keyframe.
  test("a high latency buffer-backed view feeds FFmpeg the init segment and the buffer's whole window first", async () => {

    const rig = await arrangeLiveView({ input: "buffer", transcode: false });

    await startLiveView(rig, AudioStreamingSamplerate.KHZ_16, HIGH_LATENCY_PACKET_TIME);

    const call = liveViewCall(rig);

    assert.ok(rig.preload, "the vacuity guard: the row arranged the preload from the latest keyframe");
    assert.ok(rig.windowPreload, "the vacuity guard: the row arranged the whole window");
    assert.ok(rig.windowPreload.length > rig.preload.length, "the vacuity guard: the whole window is longer than the preload from the latest keyframe");

    rig.view?.push(makeMediaSegment(makeKeyframeFragment()));
    await settle();

    assert.ok(expectAt(call.process.stdinWrites, 0, "the first write").equals(rig.windowPreload), "the first write is the whole window, exact bytes");

    await endLiveView(rig);
  });

  test("no kind's command carries -ss", async () => {

    for(const kind of KINDS) {

      // eslint-disable-next-line no-await-in-loop -- Each kind is its own assertion, started and ended before the next.
      const rig = await arrangeLiveView(kind);

      // eslint-disable-next-line no-await-in-loop -- As above.
      await startLiveView(rig);

      assert.equal(liveViewCall(rig).init.args?.includes("-ss"), false, kind.name + " starts its input where FFmpeg finds it");

      // eslint-disable-next-line no-await-in-loop -- As above.
      await endLiveView(rig);
    }
  });

  // With audio on, the command maps the input's audio track, encodes it at the rate HomeKit requested, and the tee carries the audio sink beside the video's.
  for(const input of [ "rtsp", "buffer" ] as const) {

    test("a " + ((input === "rtsp") ? "direct-RTSP" : "buffer-backed") + " view with audio maps its input's audio track and sends it at 16 and 24 kHz", async () => {

      for(const [ sampleRate, sampleRateKhz ] of [ [ AudioStreamingSamplerate.KHZ_16, 16 ], [ AudioStreamingSamplerate.KHZ_24, 24 ] ] as const) {

        // eslint-disable-next-line no-await-in-loop -- Each rate is its own assertion, started and ended before the next.
        const rig = await arrangeLiveView({ audio: true, input, transcode: false });

        // eslint-disable-next-line no-await-in-loop -- As above.
        await startLiveView(rig, sampleRate);

        assert.deepEqual(liveViewCall(rig).init.args, expectedArgs(rig, { audio: true, input, sampleRateKhz, transcode: false }),
          "the exact command with audio at " + sampleRateKhz.toString() + " kHz");
        assert.deepEqual(liveViewCall(rig).init.returnPort, { ipFamily: "ipv4", port: rig.prepared.video.port },
          "a view with audio and no two-way audio keeps the health watchdog on the session's video return port");

        // eslint-disable-next-line no-await-in-loop -- As above.
        await endLiveView(rig);
      }
    });
  }

  // The camera's audio filters, when it has any, follow the audio encoding as one -filter:a.
  test("a view whose camera filters its audio carries the filters as one -filter:a after the audio encoding", async () => {

    const audioFilters = [ "highpass=f=200", "lowpass=f=1000" ];
    const rig = await arrangeLiveView({ audio: true, audioFilters, input: "rtsp", transcode: false });

    await startLiveView(rig);

    assert.deepEqual(liveViewCall(rig).init.args, expectedArgs(rig, { audio: true, audioFilters, input: "rtsp", transcode: false }),
      "the exact command with the camera's audio filters");

    await endLiveView(rig);
  });
});

describe("a live view's failed FFmpeg, answered through the process double", () => {

  test("a known livestream line ends a buffer-backed view with the friendly sentence, and the session stops", async () => {

    const rig = await arrangeLiveView({ input: "buffer", transcode: false });
    const call = await startReadyLiveView(rig, { input: "buffer", transcode: false });

    call.process.stderrLog = ["moov atom not found"];
    call.process.exit({ exitCode: 1, exitSignal: null });
    await settle();

    assert.equal(logCount(rig.logEntries, "error", FRIENDLY_SENTENCE), 1, "the friendly sentence is logged at error, once");
    assertStopped(rig, call);

    await endLiveView(rig);
  });

  test("the same line ends a direct-RTSP view without the friendly sentence, and the session stops", async () => {

    const rig = await arrangeLiveView({ input: "rtsp", transcode: false });
    const call = await startReadyLiveView(rig, { input: "rtsp", transcode: false });

    call.process.stderrLog = ["moov atom not found"];
    call.process.exit({ exitCode: 1, exitSignal: null });
    await settle();

    assert.equal(logCount(rig.logEntries, "error", FRIENDLY_SENTENCE), 0, "a direct-RTSP view leaves the failure to HBPU's report");
    assertStopped(rig, call);

    await endLiveView(rig);
  });

  test("the probe-size line doubles the probe size once, and the session stops", async () => {

    const rig = await arrangeLiveView({ input: "rtsp", transcode: false });
    const call = await startReadyLiveView(rig, { input: "rtsp", transcode: false });

    assert.equal(rig.delegate.probesize, PROBESIZE, "the vacuity guard: the view started at the camera's probe size");

    call.process.stderrLog = [PROBESIZE_LINE];
    call.process.exit({ exitCode: 1, exitSignal: null });
    await settle();

    assert.equal(rig.delegate.probesize, PROBESIZE * 2, "the probe size is doubled once");
    assert.equal(logCount(rig.logEntries, "error", "to use safer values at the expense of some additional streaming startup latency"), 1,
      "the self-tune says so once");
    assertStopped(rig, call);

    await endLiveView(rig);
  });

  // The camera's logger and the platform's are one recorder in the harness unless a row gives the camera its own, which is what tells a line the camera logged from
  // one the platform did.
  test("with the camera's own logger, the friendly sentence lands on the camera's logger and not on the platform's", async () => {

    const rig = await arrangeLiveView({ input: "buffer", ownLog: true, transcode: false });
    const call = await startReadyLiveView(rig, { input: "buffer", transcode: false });

    call.process.stderrLog = ["moov atom not found"];
    call.process.exit({ exitCode: 1, exitSignal: null });
    await settle();

    assert.equal(logCount(rig.logEntries, "error", FRIENDLY_SENTENCE), 1, "the friendly sentence is logged on the camera's logger, once");
    assert.equal(logCount(rig.platformLogEntries, "error", FRIENDLY_SENTENCE), 0, "and never on the platform's");
    assertStopped(rig, call);

    await endLiveView(rig);
  });
});

describe("a live view's start that ends before it runs", () => {

  test("a livestream that misses the start deadline answers HomeKit once with an error, aborts the process, and leaves no session to start again", async () => {

    const rig = await arrangeLiveView({ input: "buffer", transcode: false, view: makeControllableLivestreamDouble({ deferEstablishment: true }) });
    const answers = await startLiveView(rig);
    const call = liveViewCall(rig);

    assert.equal(answers.length, 0, "the view is still waiting on its livestream");

    rig.clock.advance(PROTECT_LIVE_VIEW_START_DEADLINE_MS - 1);
    await settle();

    assert.equal(answers.length, 0, "the view is still waiting a millisecond before its deadline");

    rig.clock.advance(1);
    await settle();

    assert.equal(answers.length, 1, "HomeKit is answered once");
    assert.ok(answers[0] instanceof Error, "HomeKit is answered with an error");
    assert.equal(call.process.signal.aborted, true, "the process's signal is aborted");

    const retry = await startLiveView(rig);

    assert.deepEqual(retry.map((answer) => answer?.message), ["Unable to find the pending session."], "a second START finds no pending session");
    assert.equal(rig.factory.createCalls.length, 1, "the second START builds no process");

    await endLiveView(rig);
  });

  test("a camera that is offline at START answers HomeKit with the offline error, logs it, and builds no process", async () => {

    const rig = await arrangeLiveView({ input: "rtsp", transcode: false });

    rig.host.isReachable = false;

    const answers = await startLiveView(rig);

    assert.deepEqual(answers.map((answer) => answer?.message), ["Test Camera: Unable to start video stream: the camera is offline or unavailable."],
      "HomeKit is answered with the offline error");
    assert.equal(logCount(rig.logEntries, "error", "Unable to start video stream: the camera is offline or unavailable."), 1, "the line is logged at error");
    assert.equal(rig.factory.createCalls.length, 0, "no process is built");
    assert.equal(rig.host.platform.rtpPorts.reservedCount, 0, "the failed start releases the session's ports itself, since HomeKit sends no stop for it");

    await endLiveView(rig);
  });
});

// The lines a two-way view's return audio and talkback write, transcribed rather than referenced so a sentence that drifts by a character in its one home reddens a
// row.
const UNAVAILABLE_LINE = "Two-way audio is unavailable for the remainder of this session. The audio return channel could not be established.";
const HANDSHAKE_ENDED_LINE = "Session teardown ended the two-way audio handshake before the first return packet arrived.";
const CHANNEL_CLOSED_LINE = "Return audio channel closed.";
const TALKBACK_STOPPED_LINE = "The talkback connection was stopped.";
const STOPPED_LINE = "Stopped video streaming session.";
const ZONE_LINE = "Unable to start two-way audio: the camera's IPv6 address carries a zone, which a return audio destination cannot include.";

// The exact command a two-way view's return audio hands FFmpeg for the START above: the session description on its input, HomeKit's audio decoded and encoded as
// AAC-LC in ADTS at the camera speaker's rate and channel count, with the bitrate left to the encoder, and sent to the camera directly or to FFmpeg's standard output
// for the controller's talkback channel. The audio codecs are HBPU's renders over the delegate's own FFmpeg options, and everything else is written out.
function returnAudioArgs(rig: LiveViewRig, route: TwoWayRoute): string[] {

  return [

    "-hide_banner", "-nostats", "-protocol_whitelist", "crypto,file,pipe,rtp,udp", "-f", "sdp", "-codec:a", rig.delegate.ffmpegOptions.audioDecoder, "-i", "pipe:0",
    "-map", "0:a:0", ...rig.delegate.ffmpegOptions.audioEncoder({ codec: AudioRecordingCodecType.AAC_LC }), "-flags", "+global_header", "-ar", "22050", "-ac", "1",
    "-f", "adts", (route === "direct") ? "udp://192.168.1.30:48230" : "pipe:1"
  ];
}

// The session description a two-way view's return audio reads HomeKit's audio by: the client's address in its family, the RTP port the demuxer forwards to, the clock
// rate and config of the audio rate the START asked for, and the session's audio key and salt.
function returnAudioSdp(options: { client?: HomeKitClient; rtpPort: number; sampleRateKhz?: number }): string {

  const client: HomeKitClient = options.client ?? { address: HOMEKIT_ADDRESS, family: "ipv4" };
  const family = (client.family === "ipv6") ? "IP6" : "IP4";
  const at24 = options.sampleRateKhz === 24;

  return [ "v=0", "o=- 0 0 IN " + family + " 127.0.0.1", "s=Test Camera Audio Talkback", "c=IN " + family + " " + client.address, "t=0 0",
    "m=audio " + options.rtpPort.toString() + " RTP/AVP 110", "b=AS:24", "a=rtpmap:110 MPEG4-GENERIC/" + (at24 ? "24000" : "16000") + "/2",
    "a=fmtp:110 profile-level-id=1;mode=AAC-hbr;sizelength=13;indexlength=3;indexdeltalength=3; config=" + (at24 ? "F8EC212C00BC00" : "F8F0212C00BC00"),
    "a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:" + Buffer.concat([ AUDIO_KEY, AUDIO_SALT ]).toString("base64") ].join("\n") + "\n";
}

// Start a two-way view and answer HomeKit: the START, then the live view's process ready, which HomeKit's answer waits on. The view then waits on its demuxer's first
// packet, and its process is handed back.
async function startTwoWayView(rig: LiveViewRig, sampleRate: AudioStreamingSamplerate = AudioStreamingSamplerate.KHZ_16):
Promise<TestStreamingProcessFactory["createCalls"][number]> {

  const answers = await startLiveView(rig, sampleRate);
  const call = expectAt(rig.factory.createCalls, 0, "the live view's process");

  call.process.resolveReady();
  await settle();

  assert.deepEqual(answers, [undefined], "HomeKit is answered once the live view's process is ready");

  return call;
}

// Forward the demuxer's first packet, as HomeKit's first return audio does, and hand back the return-audio process the view builds once it has.
async function forwardFirstPacket(rig: LiveViewRig): Promise<TestStreamingProcessFactory["createCalls"][number]> {

  expectAt(rig.demuxers.createCalls, 0, "the view's demuxer").demuxer.resolveMediaReady();
  await settle();

  return expectAt(rig.factory.createCalls, 1, "the return-audio process");
}

// The socket a relayed view's talkback session dialed, read through a flag its connect call's socket sets, so a session that never dials fails the row at once rather
// than at the suite's timeout.
async function dialedSocket(rig: LiveViewRig): Promise<TestTalkbackSocket> {

  const dialed: { socket?: TestTalkbackSocket } = {};

  void expectAt(rig.host.talkbackFactory.connectCalls, 0, "the talkback connect").socket.then((socket) => {

    dialed.socket = socket;
  }, () => undefined);

  await settleUntil(() => dialed.socket !== undefined, { description: "the talkback session to dial" });

  return present(dialed.socket, "the socket the talkback session dialed");
}

// A view whose two-way audio faltered runs on: the session's signal stands, HomeKit is told nothing is over, and the session is never stopped.
function assertRunningOn(rig: LiveViewRig, call: TestStreamingProcessFactory["createCalls"][number]): void {

  assert.equal(call.init.signal?.aborted, false, "the session's signal stands");
  assert.deepEqual(rig.forceStops, [], "HomeKit is told nothing is over");
  assert.equal(logCount(rig.logEntries, "info", STOPPED_LINE), 0, "the session is not stopped");
}

// A talkback session that has closed, read from its socket: only the session's own teardown asks the socket to close, and that teardown removes every listener the
// session added.
function assertClosed(socket: TestTalkbackSocket): void {

  assert.equal(socket.closeRequested, true, "the session asked its socket to close");
  assert.equal(socket.listenerCount(), 0, "the session left no listener on its socket");
}

describe("a two-way audio view's prepare - the demuxer and the session's ports", () => {

  test("a two-way prepare builds one demuxer through the platform's factory on the session's ports, and a STOP with no START ends it and releases them", async () => {

    const rig = await arrangeLiveView({ input: "rtsp", ownLog: true, portBinds: TWO_WAY_BINDS, transcode: false, twoWay: "relayed" });

    assert.equal(rig.demuxers.createCalls.length, 1, "the prepare built one demuxer");

    const { demuxer, init } = expectAt(rig.demuxers.createCalls, 0, "the view's demuxer");

    assert.equal(init.clock, rig.host.platform.clock, "the demuxer runs on the platform's clock");
    assert.equal(init.log, rig.host.log, "the demuxer logs as the camera");
    assert.notEqual(init.log, rig.host.platform.pluginLog, "and not as the platform");
    assert.equal(init.ipFamily, "ipv4", "the demuxer binds in the family the prepare asked for");
    assert.equal(init.signal?.aborted, false, "the demuxer's signal stands while the session is prepared");
    assert.deepEqual([ init.rtcpPort, init.inputPort, init.rtpPort ], [ RTCP_PORT, INPUT_PORT, RTP_PORT ],
      "the demuxer's RTCP, input and RTP ports are the prepare's reservations, in the order it made them");
    assert.deepEqual(rig.probes?.binds, [ 0, 0, 0, RTP_PORT + 1, 0 ], "the prepare made each reservation its script answers");
    assert.equal(rig.prepared.audio.port, INPUT_PORT, "HomeKit is answered the demuxer's input port");

    stopSession(rig);

    assert.equal(demuxer.aborted, true, "a STOP with no START ends the demuxer's signal");
    assert.equal(rig.host.platform.rtpPorts.reservedCount, 0, "and leaves no port reserved");

    await endLiveView(rig);

    const plain = await arrangeLiveView({ audio: true, input: "rtsp", transcode: false });

    assert.equal(plain.demuxers.createCalls.length, 0, "a view with the two-way hint off builds no demuxer");

    await endLiveView(plain);
  });

  test("a view with the two-way hint on and no AAC encoder builds no demuxer, and its process keeps the video return port", async () => {

    const rig = await arrangeLiveView({ codecSupport: NO_AAC_CODECS, input: "rtsp", transcode: false, twoWay: "relayed" });

    assert.equal(rig.demuxers.createCalls.length, 0, "a view with no audio to send builds no demuxer");

    await startLiveView(rig);

    assert.deepEqual(liveViewCall(rig).init.returnPort, { ipFamily: "ipv4", port: rig.prepared.video.port },
      "the health watchdog listens on the session's video return port");

    await endLiveView(rig);
  });

  // The script answers the RTCP port, the input port and the RTP pair, and then refuses the video port at every attempt the allocator makes, so the fourth
  // reservation is the one that fails, after the demuxer is built.
  test("a two-way prepare whose video port is refused at every attempt answers HomeKit the reservation error, ends its demuxer and releases every port", async () => {

    const refusedVideoPort = Array<TestSocketBind>(RESERVE_ATTEMPTS).fill("refused");
    const rig = await buildLiveView({ input: "rtsp", portBinds: [ RTCP_PORT, INPUT_PORT, RTP_PORT, RTP_PORT + 1, ...refusedVideoPort ], transcode: false,
      twoWay: "relayed" });
    const { error, response } = await prepare(rig.delegate);

    assert.equal(error?.message, "Test Camera: Unable to reserve the UDP ports needed to begin streaming.", "HomeKit is answered the reservation error");
    assert.equal(response, undefined, "and no response");
    assert.equal(logCount(rig.logEntries, "error", "Unable to reserve the UDP ports needed to begin streaming: RtpPortAllocator: unable to reserve a port after " +
      RESERVE_ATTEMPTS.toString() + " attempts"), 1, "the reservation's own error is logged once");
    assert.equal(expectAt(rig.demuxers.createCalls, 0, "the view's demuxer").demuxer.aborted, true, "the failed prepare ends the demuxer it built");
    assert.equal(rig.host.platform.rtpPorts.reservedCount, 0, "and releases every port it had reserved");
    assert.deepEqual(rig.probes?.binds, [ 0, 0, 0, RTP_PORT + 1, ...Array<number>(RESERVE_ATTEMPTS).fill(0) ], "the video port was asked for at every attempt");

    await endLiveView(rig);
  });
});

describe("a two-way audio view's start - the live view, the return audio and the talkback session", () => {

  test("a two-way view's process carries no return port, and no second process is built before the demuxer's first packet", async () => {

    const rig = await arrangeLiveView({ input: "rtsp", transcode: false, twoWay: "relayed" });
    const call = await startTwoWayView(rig);

    assert.deepEqual(call.init.args, expectedArgs(rig, { audio: true, input: "rtsp", transcode: false }), "the live view's exact command, with audio");
    assert.equal(call.init.returnPort, undefined, "a two-way view arms no health watchdog, since its inbound packets flow through the demuxer");
    assert.equal(rig.factory.createCalls.length, 1, "no return-audio process is built before the demuxer's first packet");

    await endLiveView(rig);
  });

  for(const [ sampleRate, sampleRateKhz ] of [ [ AudioStreamingSamplerate.KHZ_16, 16 ], [ AudioStreamingSamplerate.KHZ_24, 24 ] ] as const) {

    test("a direct view at " + sampleRateKhz.toString() + " kHz builds its return audio toward the camera after the first packet, and never opens the talkback",
      async () => {

        const rig = await arrangeLiveView({ input: "rtsp", transcode: false, twoWay: "direct" });
        const call = await startTwoWayView(rig, sampleRate);
        const returnAudio = await forwardFirstPacket(rig);

        assert.equal(returnAudio.options, rig.delegate.ffmpegOptions, "the return audio runs over the delegate's FFmpeg options");
        assert.deepEqual(returnAudio.init.args, returnAudioArgs(rig, "direct"), "the exact command, ending at the camera's UDP destination");
        assert.deepEqual(Object.keys(returnAudio.init).toSorted(), [ "args", "signal" ], "the init carries the command and the signal and nothing more");
        assert.equal(returnAudio.init.signal, call.init.signal, "the return audio runs on the session's signal");
        assert.deepEqual(returnAudio.process.stdinWrites.map((chunk) => chunk.toString()),
          [returnAudioSdp({ rtpPort: expectAt(rig.demuxers.createCalls, 0, "the view's demuxer").init.rtpPort, sampleRateKhz })],
          "the one write to the return audio is its session description, naming the demuxer's RTP port");
        assert.equal(rig.host.talkbackFactory.connectCalls.length, 0, "a direct view never opens the talkback");

        await endLiveView(rig);
      });
  }

  test("a relayed view sends its return audio through the talkback session in order, and the return audio's exit closes the session", async () => {

    const rig = await arrangeLiveView({ input: "rtsp", transcode: false, twoWay: "relayed" });
    const call = await startTwoWayView(rig);
    const returnAudio = await forwardFirstPacket(rig);

    assert.deepEqual(returnAudio.init.args, returnAudioArgs(rig, "relayed"), "the exact command, ending at FFmpeg's standard output");
    assert.equal(rig.host.talkbackFactory.connectCalls.length, 1, "the view connects one talkback session");
    assert.equal(expectAt(rig.host.talkbackFactory.connectCalls, 0, "the talkback connect").signal, call.init.signal, "the talkback connects on the session's signal");

    const socket = await dialedSocket(rig);
    const frames = [ "an invented return audio frame", "a second invented return audio frame" ];

    // The session opens, answers its connect and starts draining the return audio's output a turn after it dials, and each frame then crosses on a turn of its own.
    await settle();
    returnAudio.process.writeStdout(Buffer.from(expectAt(frames, 0, "the first frame")));
    await settle();
    returnAudio.process.writeStdout(Buffer.from(expectAt(frames, 1, "the second frame")));
    await settle();

    assert.deepEqual(socket.sent.map((frame) => Buffer.from(frame).toString()), frames, "each frame the return audio wrote reached the socket, in order");
    assert.equal(socket.closeRequested, false, "the vacuity guard: the session is open while the return audio runs");

    returnAudio.process.exit({ exitCode: 0, exitSignal: null });
    await settle();

    assertClosed(socket);

    await endLiveView(rig);
  });

  test("a demuxer whose bind is refused costs the session its return audio with one info line, and the view runs on", async () => {

    const rig = await arrangeLiveView({ demuxerBinds: ["refused"], input: "rtsp", transcode: false, twoWay: "relayed" });
    const call = await startTwoWayView(rig);

    assert.equal(logCount(rig.logEntries, "info", UNAVAILABLE_LINE), 1, "the session's lost return audio is said at info, once");
    assert.equal(rig.factory.createCalls.length, 1, "no return-audio process is built");
    assertRunningOn(rig, call);

    await endLiveView(rig);
  });

  test("a demuxer whose socket faults after its bind costs the session its return audio with one info line, and the view runs on", async () => {

    const rig = await arrangeLiveView({ input: "rtsp", transcode: false, twoWay: "relayed" });
    const call = await startTwoWayView(rig);

    expectAt(rig.demuxers.createCalls, 0, "the view's demuxer").demuxer.failSocket(new Error("An invented demuxer socket fault."));
    await settle();

    assert.equal(logCount(rig.logEntries, "info", UNAVAILABLE_LINE), 1, "the session's lost return audio is said at info, once");
    assert.equal(rig.factory.createCalls.length, 1, "no return-audio process is built");
    assertRunningOn(rig, call);

    await endLiveView(rig);
  });

  test("a stop before the demuxer's first packet ends the handshake at debug alone, and builds no return audio", async () => {

    const rig = await arrangeLiveView({ input: "rtsp", transcode: false, twoWay: "relayed" });

    await startTwoWayView(rig);
    stopSession(rig);
    await settle();

    assert.equal(logCount(rig.logEntries, "debug", HANDSHAKE_ENDED_LINE), 1, "the stop's end of the handshake is noted at debug, once");
    assert.equal(logCount(rig.logEntries, "info", UNAVAILABLE_LINE), 0, "and never said as lost return audio");
    assert.equal(rig.factory.createCalls.length, 1, "no return-audio process is built");

    await endLiveView(rig);
  });

  test("a talkback connection that fails before it opens is logged at error once, and the view runs on", async () => {

    const rig = await arrangeLiveView({ holdTalkbackOpen: true, input: "rtsp", transcode: false, twoWay: "relayed" });
    const call = await startTwoWayView(rig);

    await forwardFirstPacket(rig);

    const socket = await dialedSocket(rig);

    socket.emitError(new Error("An invented talkback connection fault."));
    await settle();

    assert.equal(logCount(rig.logEntries, "error", "Unable to connect to the return audio channel"), 1, "the failed connection is logged at error, once");
    assertRunningOn(rig, call);

    await endLiveView(rig);
  });

  test("a talkback channel that faults while the return audio drains is logged at error once", async () => {

    const rig = await arrangeLiveView({ input: "rtsp", transcode: false, twoWay: "relayed" });
    const call = await startTwoWayView(rig);

    await forwardFirstPacket(rig);

    const socket = await dialedSocket(rig);

    await settle();

    assert.equal(socket.closeRequested, false, "the vacuity guard: the session is open while the return audio drains");

    socket.emitError(new Error("An invented talkback channel fault."));
    await settle();

    assert.equal(logCount(rig.logEntries, "error", "The return audio channel encountered an error"), 1, "the channel's fault is logged at error, once");
    assertRunningOn(rig, call);

    await endLiveView(rig);
  });

  test("a stop while the return audio drains closes the channel at debug and logs nothing at error", async () => {

    const rig = await arrangeLiveView({ input: "rtsp", transcode: false, twoWay: "relayed" });

    await startTwoWayView(rig);
    await forwardFirstPacket(rig);
    await dialedSocket(rig);
    await settle();

    stopSession(rig);
    await settle();

    assert.equal(logCount(rig.logEntries, "debug", CHANNEL_CLOSED_LINE), 1, "the stop's close of the channel is noted at debug, once");
    assert.deepEqual(linesAt(rig.logEntries, "error"), [], "nothing is logged at error");

    await endLiveView(rig);
  });

  test("the stop ends the demuxer's signal and closes the talkback session", async () => {

    const rig = await arrangeLiveView({ input: "rtsp", transcode: false, twoWay: "relayed" });

    await startTwoWayView(rig);
    await forwardFirstPacket(rig);

    const socket = await dialedSocket(rig);

    await settle();

    assert.equal(socket.closeRequested, false, "the vacuity guard: the session is open while the return audio drains");

    stopSession(rig);
    await settle();

    assert.ok(isHbpuAbortReason(expectAt(rig.demuxers.createCalls, 0, "the view's demuxer").demuxer.signal.reason, "shutdown"), "the stop ended the demuxer's signal");
    assertClosed(socket);

    await endLiveView(rig);
  });

  test("a stop after the talkback session dials and before it opens says the connection was stopped, at info and once", async () => {

    const rig = await arrangeLiveView({ holdTalkbackOpen: true, input: "rtsp", transcode: false, twoWay: "relayed" });

    await startTwoWayView(rig);
    await forwardFirstPacket(rig);

    const socket = await dialedSocket(rig);

    stopSession(rig);
    await settle();

    assert.equal(logCount(rig.logEntries, "info", TALKBACK_STOPPED_LINE), 1, "the stopped connection is said at info, once");
    assert.deepEqual(linesAt(rig.logEntries, "error"), [], "nothing is logged at error");
    assert.equal(socket.closeRequested, true, "the stop closed the session's socket");

    await endLiveView(rig);
  });

  /* The open lands in the same turn as the view's stop, ahead of it, so the session finishes opening only once the stop has run and the view it opened for is gone.
   * The view keeps no session it has no entry for, and the send the session is handed then meets the stop's own abort, so the channel's close is noted at debug.
   */
  test("a talkback session that finishes opening after its view stopped is closed at debug, and never said to be stopped", async () => {

    const rig = await arrangeLiveView({ holdTalkbackOpen: true, input: "rtsp", transcode: false, twoWay: "relayed" });

    await startTwoWayView(rig);
    await forwardFirstPacket(rig);

    const socket = await dialedSocket(rig);

    socket.emitOpen();
    stopSession(rig);
    await settle();

    assert.deepEqual(rig.logEntries.filter(({ message }) => [ STOPPED_LINE, CHANNEL_CLOSED_LINE ].includes(message)).map(({ level, message }) => level + ": " + message),
      [ "info: " + STOPPED_LINE, "debug: " + CHANNEL_CLOSED_LINE ], "the stop's own line, then the channel's close at debug, once each");
    assert.equal(logCount(rig.logEntries, "info", TALKBACK_STOPPED_LINE), 0, "the session is never said to be stopped while connecting");
    assert.deepEqual(linesAt(rig.logEntries, "error"), [], "nothing is logged at error");
    assertClosed(socket);

    await endLiveView(rig);
  });

  test("a direct view whose camera address carries an IPv6 zone logs the zone at error once, builds no return audio, and runs on", async () => {

    const rig = await arrangeLiveView({ input: "rtsp", transcode: false, twoWay: "direct" });

    rig.host.ufp = { ...rig.host.ufp, host: ZONED_CAMERA_ADDRESS };

    const call = await startTwoWayView(rig);

    expectAt(rig.demuxers.createCalls, 0, "the view's demuxer").demuxer.resolveMediaReady();
    await settle();

    assert.deepEqual(rig.logEntries.filter(({ level }) => level === "error"), [{ level: "error", message: ZONE_LINE, params: [{ address: ZONED_CAMERA_ADDRESS }] }],
      "the zone line is logged at error once, with the camera's address");
    assert.equal(rig.factory.createCalls.length, 1, "no return-audio process is built, even once the first packet arrives");
    assertRunningOn(rig, call);

    await endLiveView(rig);
  });

  test("the return audio's command carries -loglevel level+verbose under the Log.FFmpeg option and level+debug under the platform's debug setting", async () => {

    const verbose = await arrangeLiveView({ features: ["Log.FFmpeg"], input: "rtsp", transcode: false, twoWay: "direct" });

    await startTwoWayView(verbose);

    assert.deepEqual((await forwardFirstPacket(verbose)).init.args, [ ...returnAudioArgs(verbose, "direct"), "-loglevel", "level+verbose" ],
      "the exact command, verbose under the camera's FFmpeg logging option");

    await endLiveView(verbose);

    const debug = await arrangeLiveView({ input: "rtsp", transcode: false, twoWay: "direct" });

    debug.host.platform.config.debugAll = true;
    await startTwoWayView(debug);

    assert.deepEqual((await forwardFirstPacket(debug)).init.args, [ ...returnAudioArgs(debug, "direct"), "-loglevel", "level+debug" ],
      "the exact command, at debug under the platform's debug setting");

    await endLiveView(debug);
  });

  test("a direct view prepared for an IPv6 client builds its demuxer in the IPv6 family and names that client in its session description", async () => {

    const client: HomeKitClient = { address: HOMEKIT_IPV6_ADDRESS, family: "ipv6" };
    const rig = await arrangeLiveView({ client, input: "rtsp", portBinds: TWO_WAY_BINDS, transcode: false, twoWay: "direct" });

    assert.equal(expectAt(rig.demuxers.createCalls, 0, "the view's demuxer").init.ipFamily, "ipv6", "the demuxer binds in the IPv6 family the prepare asked for");

    await startTwoWayView(rig);

    const returnAudio = await forwardFirstPacket(rig);

    assert.deepEqual(returnAudio.process.stdinWrites.map((chunk) => chunk.toString()), [returnAudioSdp({ client, rtpPort: RTP_PORT })],
      "the session description names IPv6 and the client's address");

    await endLiveView(rig);
  });
});

describe("a live view's command - the hardware decoder's flags, a refusal its buffer's check reads, and the log level", () => {

  for(const input of [ "rtsp", "buffer" ] as const) {

    test("a " + ((input === "rtsp") ? "direct-RTSP" : "buffer-backed") + " view with hardware decoding on carries the hardware decoder's flags at their place",
      async () => {

        const rig = await arrangeLiveView({ codecSupport: APPLE_SILICON_CODECS, hardwareDecoding: true, input, transcode: false });
        const decoder = rig.delegate.ffmpegOptions.videoDecoder({ inputCodec: rig.host.ufp.videoCodec });

        assert.ok(decoder.length > 0, "the vacuity guard: HBPU renders hardware decoder flags for the camera's codec on this host");

        await startLiveView(rig);

        assert.deepEqual(liveViewCall(rig).init.args, expectedArgs(rig, { decoder, input, transcode: false }),
          "the exact command, with the decoder's flags in their place");
        assert.equal(rig.exec.createCalls.length, 0, "the view's livestream describes no video track, so no decoder check runs");

        await endLiveView(rig);
      });
  }

  /* The buffer's stream carries an H.264 video track, so its first keyframe, inside the arrangement, has the supervisor check that stream against the hardware
   * decoder over the delegate's own FFmpeg options. The row reads that run before anything marks the options, so a view that decodes in software afterwards can only
   * be the refusal's doing.
   */
  test("a refusal the buffer's decoder check reads marks the delegate's options, and the live view that follows carries no decoder flags", async () => {

    const rig = await arrangeLiveView({ bufferDescription: H264_STREAM, codecSupport: APPLE_SILICON_CODECS, hardwareDecoding: true, input: "buffer", transcode: false });
    const options = rig.delegate.ffmpegOptions;
    const decoder = options.videoDecoder({ inputCodec: "h264" });
    const check = expectAt(rig.exec.createCalls, 0, "the decoder check's run");

    assert.equal(rig.exec.createCalls.length, 1, "the buffer's first keyframe ran one decoder check");
    assert.equal(check.options, options, "the check runs over the delegate's own FFmpeg options");
    assert.ok(decoder.length > 0, "the vacuity guard: HBPU renders hardware decoder flags for the stream on this host");
    assert.deepEqual(check.init.args, hardwareDecodeCheckArgs(decoder), "the check decodes the keyframe with the hardware decoder's flags");
    assert.equal(check.init.onFailed?.({ reason: new HbpuAbortError("failed", { cause: { exitCode: 1, exitSignal: null } }), stderrLog: [] }), "handled",
      "the check's run is handed the quiet answer");
    assert.equal(logCount(rig.logEntries, "debug", QUIET_SENTENCE), 1, "which answers a failure with the quiet sentence");
    assert.equal(options.hardwareDecoderRefused, false, "the vacuity guard: nothing has marked the options yet");

    check.process.stderrLog = [hardwareDecoderRefusalLine];
    check.process.exit({ exitCode: 0, exitSignal: null });
    await settle();

    assert.equal(options.hardwareDecoderRefused, true, "the refusal the check read marks the delegate's options");

    await startLiveView(rig);

    assert.deepEqual(liveViewCall(rig).init.args, expectedArgs(rig, { input: "buffer", transcode: false }), "the live view decodes in software, with no decoder flags");

    await endLiveView(rig);
  });

  test("the live view's command carries -loglevel level+verbose under the Log.FFmpeg option and level+debug under the platform's debug setting", async () => {

    const verbose = await arrangeLiveView({ features: ["Log.FFmpeg"], input: "rtsp", transcode: false });

    await startLiveView(verbose);

    assert.deepEqual(liveViewCall(verbose).init.args, [ ...expectedArgs(verbose, { input: "rtsp", transcode: false }), "-loglevel", "level+verbose" ],
      "the exact command, verbose under the camera's FFmpeg logging option");

    await endLiveView(verbose);

    const debug = await arrangeLiveView({ input: "rtsp", transcode: false });

    debug.host.platform.config.debugAll = true;
    await startLiveView(debug);

    assert.deepEqual(liveViewCall(debug).init.args, [ ...expectedArgs(debug, { input: "rtsp", transcode: false }), "-loglevel", "level+debug" ],
      "the exact command, at debug under the platform's debug setting");

    await endLiveView(debug);
  });
});

describe("isCleanTalkbackStop - a clean talkback stop told from a fault", () => {

  // The relayed rows hold the signal's arm through a real session's stop. No row can raise unifi-protect's typed abort under a standing signal through the session,
  // since the test factory's endpoint lookup always answers, so the decision is read directly: a controller connection disposed while a talkback connects ends it
  // with that abort while the view's own signal stands.
  test("unifi-protect's typed abort is a clean stop while the session's signal stands, any error is one once it has ended, and another error is a fault", () => {

    const standing = new AbortController();
    const ended = new AbortController();

    ended.abort(new HbpuAbortError("shutdown"));

    assert.equal(isCleanTalkbackStop(new ProtectAbortedError("An invented abort."), standing.signal), true, "a typed abort under a standing signal is a clean stop");
    assert.equal(isCleanTalkbackStop(new Error("An invented fault."), ended.signal), true, "any rejection after the session's own teardown is a clean stop");
    assert.equal(isCleanTalkbackStop(new Error("An invented fault."), standing.signal), false, "another error under a standing signal is a fault");
  });
});
