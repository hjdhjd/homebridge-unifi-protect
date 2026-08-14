/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * stream.ts: Homebridge camera streaming delegate implementation for Protect.
 *
 * This module is heavily inspired by the homebridge and homebridge-camera-ffmpeg source code. Thank you for your contributions to the HomeKit world.
 */
import type { AudioOptionsIdentity, StreamingDelegate, StreamingDelegateFactory } from "./stream-delegate.ts";
import { AudioRecordingCodecType, AudioRecordingSamplerate, AudioStreamingCodecType, AudioStreamingSamplerate, BackpressureWriter, FfmpegOptions,
  FfmpegStreamingProcess, H264Level, H264Profile, HKSV_FRAGMENT_LENGTH, HbpuAbortError, MediaContainerType, RtpDemuxer, SRTPCryptoSuites, StreamRequestTypes,
  VideoCodecType, formatBps, formatErrorMessage, guardedDispatch, isHbpuAbortReason } from "homebridge-plugin-utils";
import type { CameraController, CameraControllerOptions, CameraStreamingDelegate, HAP, PrepareStreamCallback, PrepareStreamRequest, PrepareStreamResponse, Resolution,
  Service, SnapshotRequest, SnapshotRequestCallback, StartStreamRequest, StreamRequestCallback, StreamingRequest } from "homebridge";
import type { HomebridgePluginLogging, IpFamily, Nullable, PortReservation } from "homebridge-plugin-utils";
import { PROTECT_LIVESTREAM_ACTIVE_TOLERANCE_MS, PROTECT_LIVESTREAM_API_IDR_INTERVAL, PROTECT_PROBESIZE_OVERRIDE_MAX,
  PROTECT_PROBESIZE_OVERRIDE_PERMANENT_THRESHOLD, PROTECT_PROBESIZE_OVERRIDE_RESET_MS, PROTECT_TIMESHIFT_BUFFER_MAXDURATION } from "../settings.ts";
import { ProtectAbortedError, livestreamAudioSampleRate } from "unifi-protect";
import { ProtectReservedNames, isPackageCameraContext } from "../types.ts";
import { canUseLivestreamApi, resolveSessionSource } from "./stream-source-policy.ts";
import { guardedPublish, mqttTopic } from "../mqtt.ts";
import { resolveChannelRequest, resolveTranscodeDecision, resolveVideoEncoding } from "./stream-encode-policy.ts";
import type { ChannelProfile } from "./resolution.ts";
import type { LivestreamSubscription } from "./livestream.ts";
import type { ProtectCameraHost } from "./camera-host.ts";
import type { ProtectNvr } from "../nvr/nvr.ts";
import type { ProtectPlatform } from "../platform.ts";
import { ProtectRecordingDelegate } from "./record.ts";
import { ProtectSnapshot } from "./snapshot.ts";
import { ProtectStreamingFfmpegProcess } from "./stream-ffmpeg-process.ts";
import { ProtectTimeshiftSupervisor } from "./timeshift-supervisor.ts";
import type { TalkbackSession } from "unifi-protect";
import { logLivestreamIterationError } from "./livestream.ts";
import { streamingSamplerates } from "./stream-delegate.ts";

interface OngoingSessionEntry {

  // The per-session AbortController. Aborting it is the single teardown convergence point: it fans out to the demuxer, every FFmpeg, the backpressure writer, the
  // talkback session, and (via its signal) the livestream subscription.
  abortController: AbortController;
  ffmpeg: FfmpegStreamingProcess[];
  rtpDemuxer: Nullable<RtpDemuxer>;
  rtpPortReservations: PortReservation[];
  talkback?: TalkbackSession;
  toggleLight?: Service;
}

interface SessionInfo {

  // The per-session AbortController, created in prepareStream so it spans prepare -> start -> stop and covers the demuxer born in prepareStream.
  abortController: AbortController;

  // Address of the HomeKit client.
  address: string;
  addressVersion: IpFamily;

  audioCryptoSuite: SRTPCryptoSuites;
  audioIncomingRtcpPort: number;

  // Port to receive audio from the HomeKit microphone.
  audioIncomingRtpPort: number;
  audioPort: number;
  audioSRTP: Buffer;
  audioSSRC: number;

  // Does the user have a version of FFmpeg that supports AAC-ELD?
  hasAudioSupport: boolean;

  // RTP demuxer needed for two-way audio.
  rtpDemuxer: Nullable<RtpDemuxer>;

  // RTP port reservations.
  rtpPortReservations: PortReservation[];

  // The package-camera flashlight this session lit, if any, recorded so the single prepared-session disposal path (and a normal stop) can turn it back off. It is set at
  // the toggle site in startStream, after the session survives channel selection but before the establishment wait - the one window a failed start could otherwise leave
  // it latched on with no ongoing entry to reach it.
  toggleLight?: Service;

  // This should be saved if multiple suites are supported.
  videoCryptoSuite: SRTPCryptoSuites;
  videoPort: number;
  videoReturnPort: number;

  // Key and salt concatenated.
  videoSRTP: Buffer;

  // RTP synchronization source.
  videoSSRC: number;
}

// Classify a talkback teardown as a clean stop rather than a fault: either the session's own AbortController fired (our own teardown), or the shipped typed caller-abort
// surfaced. Both talkback failure sites in startStream - the open-call catch and the in-flight send catch - consume this one definition, so the clean-versus-fault
// decision lives in a single place. The signal.aborted arm is required, not the error type alone: a clean send-stop rejects with ProtectNetworkError rather than
// ProtectAbortedError, because the shared signal's abort listener races ahead of send's own onAbort.
function isCleanTalkbackStop(error: unknown, signal: AbortSignal): boolean {

  return signal.aborted || (error instanceof ProtectAbortedError);
}

/* One camera's probesize self-tuning: how many bytes FFmpeg is told to analyze before it may act on a stream, raised whenever FFmpeg gives up trying to make sense of
 * the input. The camera's configured probesize is the baseline, injected as a supplier rather than a value so this owns the whole effective-probesize story - a caller
 * cannot hand it a stale current value - and so a hint the user changes mid-life is picked up on the next read.
 *
 * The tuning moves through four states:
 *
 *   - Baseline: no elevation, no adjustments yet, no timer. Streams start at the camera's configured probesize.
 *   - Elevated: an adjustment raised the probesize and armed the auto-reset timer, so the elevation expires on its own.
 *   - Baseline with history: the timer fired and the elevation is gone, but the tally of adjustments remains.
 *   - Permanent: enough adjustments have accumulated that no timer is armed and the elevation stays until something winds the tuning back.
 *
 * The tally counts adjustments over the whole life of the delegate and deliberately survives an auto-reset, so a camera that needs an adjustment every few minutes
 * crosses PROTECT_PROBESIZE_OVERRIDE_PERMANENT_THRESHOLD just as surely as one that needs them back to back. Only reset() clears it - the roles that call it are a
 * genuine fresh start for the camera's streams. Each adjustment doubles the CURRENT effective probesize rather than the baseline, so repeated trouble compounds toward
 * PROTECT_PROBESIZE_OVERRIDE_MAX instead of arriving at the same elevation every time.
 */
class ProbesizeSelfTune {

  private readonly baseline: () => number;
  private elevated: number;
  private lifetimeAdjustments: number;
  private resetTimer?: NodeJS.Timeout;

  constructor(baseline: () => number) {

    this.baseline = baseline;
    this.elevated = 0;
    this.lifetimeAdjustments = 0;
  }

  /* Raise the probesize a step in response to FFmpeg failing to estimate the stream, and report whether the elevation is temporary.
   *
   * Increasing the probesize by a factor of two each time balances the latency implications for the user against ensuring we have a functional streaming experience.
   * Below the permanent threshold the elevation expires on its own, so the next stream attempt starts from the camera's normal baseline instead of carrying the penalty
   * indefinitely; the reset delay and the reasoning behind its length live with the named constant. At or above the threshold no timer is armed and the elevation
   * stands. The returned flag is the caller's cue for how to describe the adjustment to the user.
   */
  public adjust(): boolean {

    this.clearResetTimer();

    // Maintain statistics on how often we need to adjust our probesize. If this happens too frequently, we will default to a working value.
    this.lifetimeAdjustments++;
    this.elevated = Math.min(this.effective * 2, PROTECT_PROBESIZE_OVERRIDE_MAX);

    const isTemporary = this.lifetimeAdjustments < PROTECT_PROBESIZE_OVERRIDE_PERMANENT_THRESHOLD;

    if(isTemporary) {

      this.resetTimer = setTimeout(() => {

        this.elevated = 0;
        this.resetTimer = undefined;
      }, PROTECT_PROBESIZE_OVERRIDE_RESET_MS);
    }

    return isTemporary;
  }

  // Wind the tuning all the way back: the elevation, the lifetime tally, and any pending auto-reset end together, so the camera's next stream starts from its baseline
  // with a clean history.
  public reset(): void {

    this.clearResetTimer();
    this.elevated = 0;
    this.lifetimeAdjustments = 0;
  }

  // The probesize a stream should actually use right now: the elevation when one is in place, the camera's configured baseline otherwise.
  public get effective(): number {

    return this.elevated || this.baseline();
  }

  // Drop any pending auto-reset. Both an adjustment (which re-arms its own) and a reset need this, so the clear lives in one place.
  private clearResetTimer(): void {

    if(this.resetTimer) {

      clearTimeout(this.resetTimer);
      this.resetTimer = undefined;
    }
  }
}

// Camera streaming delegate implementation for Protect.
export class ProtectStreamingDelegate implements CameraStreamingDelegate, StreamingDelegate {

  // The frozen audio-options identity the CameraController was built for, captured at construction from the same live-volatile inputs the audio options freeze below:
  // isDoorbell (the recording and streaming sample rates) and the two-way audio hint (the streaming twoWayAudio flag). The live capability reconcile reads this off
  // this.stream to detect a stale controller (a camera the controller late-reports as a doorbell or as having a speaker) and rebuilds only when a capability appeared.
  public readonly builtFor: AudioOptionsIdentity;
  public controller: CameraController;
  public readonly ffmpegOptions: FfmpegOptions;
  private readonly hap: HAP;
  public hksv: Nullable<ProtectRecordingDelegate>;
  public readonly log: HomebridgePluginLogging;
  private readonly nvr: ProtectNvr;
  private ongoingSessions: Map<string, OngoingSessionEntry>;
  private pendingSessions: Map<string, SessionInfo>;
  public readonly platform: ProtectPlatform;
  public readonly protectCamera: ProtectCameraHost;
  private readonly probesizeTuning: ProbesizeSelfTune;
  private snapshot: ProtectSnapshot;
  public timeshift: Nullable<ProtectTimeshiftSupervisor>;

  // Internal development only: alternates the resolved transport source between the timeshift buffer and RTSP when Debug.Video.Stream.ABTest is enabled, so a live
  // A/B comparison can run without restarting the plugin.
  private abTest = false;

  // Create an instance of a HomeKit streaming delegate.
  constructor(protectCamera: ProtectCameraHost, resolutions: [number, number, number][]) {

    this.builtFor = { isDoorbell: protectCamera.ufp.featureFlags.isDoorbell, twoWayAudio: protectCamera.hints.twoWayAudio };
    this.hap = protectCamera.api.hap;
    this.hksv = null;
    this.log = protectCamera.log;
    this.nvr = protectCamera.nvr;
    this.ongoingSessions = new Map();
    this.protectCamera = protectCamera;
    this.pendingSessions = new Map();
    this.platform = protectCamera.platform;
    this.probesizeTuning = new ProbesizeSelfTune(() => protectCamera.hints.probesize);
    this.timeshift = null;

    // Configure our hardware acceleration support.
    this.ffmpegOptions = new FfmpegOptions({

      codecSupport: this.platform.codecSupport,
      crop: this.protectCamera.hints.cropOptions,
      debug: this.platform.config.debugAll,
      hardwareDecoding: this.protectCamera.hints.hardwareDecoding,
      hardwareTranscoding: this.protectCamera.hints.hardwareTranscoding,
      log: this.log,
      name: (): string => this.protectCamera.accessoryName
    });

    // Encourage users to enable hardware-accelerated transcoding on macOS.
    if(!this.protectCamera.hints.hardwareTranscoding && !isPackageCameraContext(this.protectCamera.accessory.context) &&
      this.platform.codecSupport.hostSystem.startsWith("macOS.")) {

      this.log.warn("macOS detected: consider enabling hardware acceleration (located under the video feature options section in the HBUP webUI) for even better " +
        "performance and an improved user experience.");
    }

    // The timeshift supervisor - the lifecycle authority for the camera's standing buffer - is constructed for any camera that can use buffer-backed livestreaming: the
    // livestream-accessibility predicate, a strict superset of HKSV capability, so it also covers every HKSV-capable camera. This means the streaming arm and (when
    // present) the recording arm share one buffer lifecycle owner. The recording delegate is constructed only for an HKSV-capable camera and always finds its required
    // supervisor already in place, so a supervisor-less recording delegate is unrepresentable. An Access-adopted camera therefore gets the supervisor without a
    // recording delegate - the streaming-only column of the OR made flesh.
    if(canUseLivestreamApi(this.protectCamera.ufp)) {

      this.timeshift = new ProtectTimeshiftSupervisor(protectCamera);

      if(this.protectCamera.isHksvCapable) {

        this.hksv = new ProtectRecordingDelegate(protectCamera, this.timeshift);
      }
    }

    // Configure our snapshot handler.
    this.snapshot = new ProtectSnapshot(protectCamera);

    // Setup for our camera controller.
    const options: CameraControllerOptions = {

      // HomeKit requires at least 2 streams, and HomeKit Secure Video requires 1. We offer 10 so multiple concurrent HomeKit viewers (and HKSV recording alongside live
      // views) can each hold their own slot rather than contending for the minimum.
      cameraStreamCount: 10,

      // Our streaming delegate - aka us.
      delegate: this,

      // Our recording capabilities for HomeKit Secure Video.
      recording: !this.protectCamera.isHksvCapable || !this.hksv ? undefined : {

        delegate: this.hksv,

        options: {

          audio: {

            codecs: [
              {

                // The advertised recording sample rate follows the camera's livestream (fMP4) audio rate, which livestreamAudioSampleRate owns.
                samplerate: (livestreamAudioSampleRate(this.protectCamera.ufp) === 48000) ? AudioRecordingSamplerate.KHZ_48 : AudioRecordingSamplerate.KHZ_16,
                type: AudioRecordingCodecType.AAC_LC
              }
            ]
          },

          mediaContainerConfiguration: [
            {

              // The default HKSV segment length is 4000ms. It turns out that any setting less than that will disable HomeKit Secure Video.
              fragmentLength: HKSV_FRAGMENT_LENGTH,
              type: MediaContainerType.FRAGMENTED_MP4
            }
          ],

          // Maximum prebuffer length supported. In Protect, this is effectively unlimited, but HomeKit only seems to request a maximum of a 4000ms prebuffer.
          prebufferLength: PROTECT_TIMESHIFT_BUFFER_MAXDURATION,

          video: {

            parameters: {

              // Through admittedly anecdotal testing on various G3 and G4 models, UniFi Protect seems to support only the H.264 Main profile, though it does support
              // various H.264 levels, ranging from Level 3 through Level 5.1 (G4 Pro at maximum resolution). However, HomeKit only supports Level 3.1, 3.2, and 4.0
              // currently.
              levels: [ H264Level.LEVEL3_1, H264Level.LEVEL3_2, H264Level.LEVEL4_0 ],
              profiles: [H264Profile.MAIN]
            },

            resolutions: resolutions,

            type: VideoCodecType.H264
          }
        }
      },

      // Our motion sensor.
      sensors: !this.protectCamera.isHksvCapable ? undefined : {

        motion: this.protectCamera.accessory.getService(this.hap.Service.MotionSensor)
      },

      streamingOptions: {

        audio: {

          codecs: [

            {

              audioChannels: 1,
              bitrate: 0,

              // Protect doorbells and the Opus audio track over RTSP both use a 48 kHz audio sampling rate, which HomeKit doesn't support; the samplerate helper hands
              // HomeKit both 16 and 24 kHz to choose from there (each divides 48 cleanly) and just 16 kHz when the buffer-backed livestream API delivers it. This surface
              // is constructor-frozen, so the capability is sampled at construction here - which is safe precisely because it is a capability rather than a preference:
              // a camera's livestream-API reach does not change under it while the delegate stands.
              samplerate: streamingSamplerates({ canUseLivestreamApi: canUseLivestreamApi(this.protectCamera.ufp),
                isDoorbell: this.protectCamera.ufp.featureFlags.isDoorbell }),
              type: AudioStreamingCodecType.AAC_ELD
            }
          ],

          twoWayAudio: this.protectCamera.hints.twoWayAudio
        },

        supportedCryptoSuites: [SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80],

        video: {

          codec: {

            // Through admittedly anecdotal testing on various G3 and G4 models, UniFi Protect seems to support only the H.264 Main profile, though it does support
            // various H.264 levels, ranging from Level 3 through Level 5.1 (G4 Pro at maximum resolution). However, HomeKit only supports Level 3.1, 3.2, and 4.0
            // currently.
            levels: [ H264Level.LEVEL3_1, H264Level.LEVEL3_2, H264Level.LEVEL4_0 ],
            profiles: [H264Profile.MAIN]
          },

          // Retrieve the list of supported resolutions from the camera and apply our best guesses for how to map specific resolutions to the available RTSP streams on a
          // camera. Unfortunately, this creates challenges in doing on-the-fly RTSP changes in UniFi Protect. Once the list of supported resolutions is set here, there's
          // no going back unless a user restarts the plugin. Homebridge doesn't have a way to dynamically adjust the list of supported resolutions at this time.
          resolutions: resolutions
        }
      }
    };

    this.controller = new this.hap.CameraController(options);
  }

  // HomeKit image snapshot request handler. HomeKit invokes this without awaiting the returned value, so the async work is routed through guardedDispatch: a fault never
  // floats as an unhandled rejection, and when HomeKit supplied a callback it is answered exactly once (a fault before the answer is delivered to HomeKit through the
  // callback itself). The callback is optional here - an internal MQTT-only snapshot omits it - so we take the callback overload when it is present and the callback-less
  // overload when it is not.
  public handleSnapshotRequest(request?: SnapshotRequest, callback?: SnapshotRequestCallback): void {

    if(callback) {

      guardedDispatch({ callback, handler: (answer) => this.acquireAndPublishSnapshot(request, answer), label: "snapshot request", log: this.log });

      return;
    }

    guardedDispatch({ handler: () => this.acquireAndPublishSnapshot(request), label: "snapshot request", log: this.log });
  }

  // Acquire a snapshot and publish it to MQTT. Answers the supplied callback (when HomeKit provided one) with the image or a retrieval failure, then publishes the
  // snapshot as a data URL. Shared by both handleSnapshotRequest dispatch branches so the acquisition and publish path is written once.
  private async acquireAndPublishSnapshot(request?: SnapshotRequest, answer?: SnapshotRequestCallback): Promise<void> {

    const snapshot = await this.snapshot.getSnapshot(request);

    // No snapshot was returned - we're done here.
    if(!snapshot) {

      answer?.(new Error(this.protectCamera.accessoryName + ": Unable to retrieve a snapshot"));

      return;
    }

    // Return the image to HomeKit.
    answer?.(undefined, snapshot);

    // Publish the snapshot as a data URL to MQTT, if configured.
    guardedPublish(this.log, this.nvr.mqtt, mqttTopic(this.protectCamera.mac, "snapshot"), "data:image/jpeg;base64," + snapshot.toString("base64"));
  }

  // Prepare to launch the video stream. HomeKit invokes this without awaiting, so the async preparation is routed through guardedDispatch: a fault never floats and the
  // callback is answered exactly once (a fault before the response is delivered to HomeKit through the callback itself).
  public prepareStream(request: PrepareStreamRequest, callback: PrepareStreamCallback): void {

    guardedDispatch({ callback, handler: (answer) => this.runPrepareStream(request, answer), label: "stream preparation", log: this.log });
  }

  // Reserve the RTP plumbing and build the pending session for a stream, answering the guarded callback with the prepared response or a failure.
  private async runPrepareStream(request: PrepareStreamRequest, callback: PrepareStreamCallback): Promise<void> {

    // If we aren't reachable, we're done before touching the live config. isReachable is total (it reads through the record non-throwing), so a camera whose controller
    // record has vanished is reported unavailable rather than throwing on the featureFlags read below. Mirrors the startStream guard.
    if(!this.protectCamera.isReachable) {

      const errorMessage = "Unable to prepare the video stream: the camera is offline or unavailable.";

      this.log.error(errorMessage);
      callback(new Error(this.protectCamera.accessoryName + ": " + errorMessage));

      return;
    }

    // The per-session AbortController. We create it here so it spans prepare -> start -> stop and covers the demuxer born below; it is the single teardown
    // convergence point that stopStream aborts.
    const abortController = new AbortController();
    const rtpPortReservations: PortReservation[] = [];

    // Reserve one or two consecutive UDP ports through the homebridge-plugin-utils allocator. The allocator throws on failure (no -1 sentinel), so the caller wraps
    // the whole reservation sequence in a try/catch. We push the returned reservation handle into rtpPortReservations and return it so the call site can read its
    // port; a count: 2 handle owns port and port + 1 atomically, so there is no separate +1 push.
    const reservePort = async (ipFamily: IpFamily = "ipv4", count: (1 | 2) = 1): Promise<PortReservation> => {

      const reservation = await this.platform.rtpPorts.reserve({ count, ipFamily, signal: abortController.signal });

      rtpPortReservations.push(reservation);

      return reservation;
    };

    // Check if the camera has a microphone and if we have audio support is enabled in the plugin.
    const isAudioEnabled = this.protectCamera.ufp.featureFlags.hasMic && this.protectCamera.hasFeature("Audio");

    // We need to check for AAC support because it's going to determine whether we support audio.
    const hasAudioSupport = isAudioEnabled && (this.ffmpegOptions.audioEncoder().length > 0);

    const audioSSRC = this.hap.CameraController.generateSynchronisationSource();

    if(!hasAudioSupport) {

      this.log.info("Audio support disabled.%s", isAudioEnabled ? " A version of FFmpeg that is compiled with fdk_aac support is required to support audio." : "");
    }

    let rtpDemuxer: Nullable<RtpDemuxer> = null;
    let audioIncomingPort = -1;
    let audioIncomingRtcpPort: number;
    let audioIncomingRtpPort = -1;
    let videoReturnPort: number;

    try {

      // Setup our audio plumbing. The two-way-audio ports (audioIncomingPort, audioIncomingRtpPort) are only reserved when two-way audio is active.
      audioIncomingRtcpPort = (await reservePort(request.addressVersion)).port;

      if(hasAudioSupport && this.protectCamera.hints.twoWayAudio) {

        audioIncomingPort = (await reservePort(request.addressVersion)).port;

        // The audioIncomingRtpPort reservation owns port and port + 1 (FFmpeg's "RTP port N implies RTCP port N+1" convention), so we only read its first port.
        audioIncomingRtpPort = (await reservePort(request.addressVersion, 2)).port;

        // Setup the RTP demuxer for two-way audio scenarios. The talkback URL is no longer fetched here - camera.talkback() negotiates it in startStream.
        rtpDemuxer = new RtpDemuxer({ inputPort: audioIncomingPort, ipFamily: request.addressVersion, log: this.log, rtcpPort: audioIncomingRtcpPort,
          rtpPort: audioIncomingRtpPort, signal: abortController.signal });
      }

      // Setup our video plumbing.
      videoReturnPort = (await reservePort(request.addressVersion)).port;
    } catch(error) {

      // The reservation failed, or the caller aborted mid-reservation. We surface the underlying reason so a runtime fault is never mistaken for port exhaustion, then
      // tear down anything already built, release the already-acquired handles, and fail the prepare. This routes to callback(error) rather than logging then calling
      // back with unusable ports.
      this.log.error("Unable to reserve the UDP ports needed to begin streaming: %s.", formatErrorMessage(error));

      abortController.abort();

      for(const reservation of rtpPortReservations) {

        void reservation[Symbol.asyncDispose]();
      }

      callback(new Error(this.protectCamera.accessoryName + ": Unable to reserve the UDP ports needed to begin streaming."));

      return;
    }

    const videoSSRC = this.hap.CameraController.generateSynchronisationSource();

    const sessionInfo: SessionInfo = {

      abortController: abortController,
      address: request.targetAddress,
      addressVersion: request.addressVersion,

      audioCryptoSuite: request.audio.srtpCryptoSuite,
      audioIncomingRtcpPort: audioIncomingRtcpPort,
      audioIncomingRtpPort: audioIncomingRtpPort,
      audioPort: request.audio.port,
      audioSRTP: Buffer.concat([ request.audio.srtp_key, request.audio.srtp_salt ]),
      audioSSRC: audioSSRC,

      hasAudioSupport: hasAudioSupport,
      rtpDemuxer: rtpDemuxer,
      rtpPortReservations: rtpPortReservations,

      videoCryptoSuite: request.video.srtpCryptoSuite,
      videoPort: request.video.port,
      videoReturnPort: videoReturnPort,
      videoSRTP: Buffer.concat([ request.video.srtp_key, request.video.srtp_salt ]),
      videoSSRC: videoSSRC
    };

    // Prepare the response stream. Here's where we figure out if we're doing two-way audio or not. For two-way audio, we need to use a demuxer to separate RTP and RTCP
    // packets. For traditional video/audio streaming, we want to keep it simple and don't use a demuxer.
    const response: PrepareStreamResponse = {

      audio: {

        port: (hasAudioSupport && this.protectCamera.hints.twoWayAudio) ? audioIncomingPort : audioIncomingRtcpPort,
        // eslint-disable-next-line camelcase
        srtp_key: request.audio.srtp_key,
        // eslint-disable-next-line camelcase
        srtp_salt: request.audio.srtp_salt,
        ssrc: audioSSRC
      },

      video: {

        port: videoReturnPort,
        // eslint-disable-next-line camelcase
        srtp_key: request.video.srtp_key,
        // eslint-disable-next-line camelcase
        srtp_salt: request.video.srtp_salt,
        ssrc: videoSSRC
      }
    };

    // Add it to the pending session queue so we're ready to start when we're called upon.
    this.pendingSessions.set(request.sessionID, sessionInfo);
    callback(undefined, response);
  }

  // Consume Segments from a livestream subscription and write them through to FFmpeg via the supplied BackpressureWriter. FFmpeg needs a valid fMP4 header before any
  // MOOF/MDAT data, so we prepend the header exactly once on the first media: either the pre-existing timeshift buffer slice (which already contains the init segment
  // followed by recent frames) or the subscription's cached init segment data on its own. The unifi-protect library's pool yields the init as its own Segment, so we
  // SKIP the init-typed segment here (writing both the prepended init data and the init segment would double-write the fMP4 header and corrupt FFmpeg's -f mp4 input)
  // and consume the cached initSegment.data instead. Error classification is centralised in logLivestreamIterationError so every livestream consumer uses identical
  // phrasing.
  private async consumeStreamSegments(ffmpegStream: ProtectStreamingFfmpegProcess, subscription: LivestreamSubscription, segmentWriter: BackpressureWriter,
    tsBuffer: Nullable<Buffer>): Promise<void> {

    let headerWritten = false;

    try {

      for await (const segment of subscription) {

        // The init segment is consumed through the cached subscription.initSegment getter and prepended once below as the header, not written here. Skip it.
        if(segment.type === "init") {

          continue;
        }

        // The first media segment after a genuine reconnect carries discontinuity:true: its tfdt baseMediaDecodeTime has been rebased near zero (a backward timeline
        // jump). Our live -f mp4 input carries +discardcorrupt / ignore_err but NOT +genpts, so feeding the rebased fragment would corrupt FFmpeg's demux. We end
        // FFmpeg's stdin instead - the .exited force-stop bridge then re-establishes the HomeKit session cleanly, ending the stream on every visible disconnect (the
        // discontinuity marker sources that decision inline). A unifi-protect-side timeline-continuity alternative (stitching the timeline across reconnects rather
        // than ending) is backlogged. This check is BEFORE the write so the rebased fragment is never forwarded; it mirrors timeshift.ts's check-before-forward
        // ordering.
        if(segment.discontinuity) {

          ffmpegStream.stdin.end();

          return;
        }

        // Prepend the fMP4 header once, on the first media segment. The whenEstablished contract guarantees subscription.initSegment is non-null by the time media
        // flows...the unifi-protect library delivers the init segment before the first media segment. If the library ever violates this and we see a null header
        // here, fail the stream cleanly rather than feeding FFmpeg MOOF/MDAT chunks without a header (which would silently corrupt the output).
        if(!headerWritten) {

          headerWritten = true;

          const header = tsBuffer ?? subscription.initSegment?.data;

          if(!header) {

            this.log.error("Live streaming aborted: the livestream API delivered its first segment before the initialization segment.");
            ffmpegStream.stdin.end();

            return;
          }

          void segmentWriter.write(header).catch((error: unknown) => this.log.debug("Live stream backpressure write dropped.", { error }));
        }

        // Write the media fragment. The homebridge-plugin-utils write() returns a typed-rejecting Promise; the .catch (debug) swallows BackpressureClosedStreamError /
        // signal.reason on teardown (the common case when FFmpeg exits mid-write). No highWaterMark (unbounded) and no segment-count accounting, unlike HKSV.
        void segmentWriter.write(segment.data).catch((error: unknown) => this.log.debug("Live stream backpressure write dropped.", { error }));
      }
    } catch(error) {

      logLivestreamIterationError({ consumer: "Live streaming", error, log: this.log });

      // The iterator terminated out-of-band (the subscription is disposed, no more segments will arrive). Ending FFmpeg's stdin lets the process wrap up cleanly
      // on its own schedule rather than waiting for its internal stall timeout to fire. There is no consumer-side reboot here - the live and HKSV-timeshift
      // consumers share one pooled session and the timeshift owns the single reboot anchor; logLivestreamIterationError already warns on the recovery give-up.
      ffmpegStream.stdin.end();
    }
  }

  // Launch the Protect video (and audio) stream.
  private async startStream(request: StartStreamRequest, callback: StreamRequestCallback): Promise<void> {

    const sessionInfo = this.pendingSessions.get(request.sessionID);

    if(!sessionInfo) {

      callback(new Error("Unable to find the pending session."));

      return;
    }

    const sdpIpVersion = sessionInfo.addressVersion === "ipv6" ? "IP6" : "IP4";

    // If we aren't connected, we're done.
    if(!this.protectCamera.isReachable) {

      const errorMessage = "Unable to start video stream: the camera is offline or unavailable.";

      this.log.error(errorMessage);
      callback(new Error(this.protectCamera.accessoryName + ": " + errorMessage));
      this.disposePreparedSession(request.sessionID, sessionInfo);

      return;
    }

    // Decide whether this session re-encodes the video, and read the connection's latency from the negotiated audio packet time. Both are a pure policy over the user's
    // configured hints and the camera's codec - stream-encode-policy.ts carries the full rationale for each circumstance that forces a transcode.
    const { isHighLatency, isTranscoding } = resolveTranscodeDecision({

      crop: this.protectCamera.hints.crop,
      packetTime: request.audio.packet_time,
      transcode: this.protectCamera.hints.transcode,
      transcodeHighLatency: this.protectCamera.hints.transcodeHighLatency,
      videoCodec: this.protectCamera.ufp.videoCodec
    });

    // Resolve which transport this live view draws from: the standing timeshift buffer's pooled socket, or a direct RTSP session. The decision is a pure policy over the
    // camera's current facts (the buffer-backed-livestreaming toggle, the recording demand, the buffer's liveness, the package preference, the AV1 constraint, whether
    // an RTSP-enabled stream exists to dial, whether the camera can reach the livestream API, and the internal A/B test). The A/B test flip is captured and the toggle
    // advanced here so the policy itself stays pure.
    const abTestFlip = this.abTest && this.protectCamera.hasFeature("Debug.Video.Stream.ABTest");

    this.abTest = !this.abTest;

    const decision = resolveSessionSource({

      abTestFlip: abTestFlip,
      bufferStarted: this.timeshift?.buffer.isStarted ?? false,
      canUseBuffer: canUseLivestreamApi(this.protectCamera.ufp),
      hasRecordingDemand: this.hksv?.isRecording ?? false,
      hasRtspStream: this.protectCamera.hasRtspStream,
      isPackageCamera: isPackageCameraContext(this.protectCamera.accessory.context),
      usesTimeshiftLivestream: this.protectCamera.usesTimeshiftLivestream,
      videoCodec: this.protectCamera.ufp.videoCodec
    });

    // A momentarily-down buffer that should be running gets a fire-and-forget wake, so it re-establishes behind whatever transport serves this request.
    if(decision.kick) {

      void this.timeshift?.reconcile();
    }

    // useTsb is captured as the streaming subclass's per-session suppressLivestreamApiErrors flag and drives the pooled-input pipeline below; both buffer-backed sources
    // set it. The channel profile is seeded per source in one place: the running buffer's channel for "buffer", the substrate policy's channel for the transient
    // "bufferDegraded" API session (so no direct-RTSP option leaks into it and the socket lands on the key the buffer revives onto), and left null for the direct-RTSP
    // selection below otherwise.
    let useTsb: boolean;
    let channelProfile: Nullable<ChannelProfile>;

    switch(decision.source) {

      case "buffer": {

        useTsb = true;
        channelProfile = this.timeshift?.buffer.channelProfile ?? null;

        break;
      }

      case "bufferDegraded": {

        useTsb = true;
        channelProfile = this.timeshift?.buffer.channelProfile ?? this.protectCamera.selectSubstrateChannel();

        break;
      }

      case "rtsp": {

        useTsb = false;
        channelProfile = null;

        break;
      }

      default: {

        // "unavailable": a camera that can reach neither transport. It cannot use the timeshift buffer, and it has nothing to dial over RTSP either - a camera that CAN
        // reach the livestream API always takes the buffer path instead, so this cell serves only cameras the API cannot reach. The policy's cause member picks the
        // remedy, so nothing here re-derives the codec or capability facts the decision already weighed.
        const errorMessage = (decision.cause === "av1") ?
          "Unable to start video stream: FFmpeg does not currently support AV1-encoded RTSP streams, and this camera cannot use the timeshift buffer." :
          "Unable to start video stream: this camera cannot use the timeshift buffer and none of its channels have a usable RTSP stream enabled. Enable at least one " +
            "RTSP stream for this camera in the UniFi Protect webUI.";

        this.log.error(errorMessage);
        callback(new Error(this.protectCamera.accessoryName + ": " + errorMessage));
        this.disposePreparedSession(request.sessionID, sessionInfo);

        return;
      }
    }

    // Whether this host encodes live video on hardware is frozen when the FFmpeg options are constructed, so one read serves both the source-dimension bias below and
    // the hardware-acceleration hint in the streaming-request log further down.
    const usesHardwareEncoder = this.ffmpegOptions.hardwareEncodes("stream");

    // Find the best RTSP stream based on what we're looking for. The dimensions and the bias are a pure policy; the selection call and the host's source-pixel cap - a
    // hardware capability rather than a decision - stay here.
    const channelRequest = resolveChannelRequest({

      isTranscoding,
      requestHeight: request.video.height,
      requestWidth: request.video.width,
      usesHardwareEncoder
    });

    channelProfile ??= this.protectCamera.selectChannel(channelRequest.width, channelRequest.height,
      channelRequest.biasHigher ? { biasHigher: true, maxPixels: this.ffmpegOptions.maxSourcePixels("stream") } : undefined);

    if(!channelProfile) {

      const errorMessage = "Unable to start video stream: no valid RTSP stream profile was found.";

      this.log.error("%s %sx%s, %s fps, %s kbps.", errorMessage,
        request.video.width, request.video.height, request.video.fps, request.video.max_bit_rate.toLocaleString("en-US"));

      callback(new Error(this.protectCamera.accessoryName + ": " + errorMessage));
      this.disposePreparedSession(request.sessionID, sessionInfo);

      return;
    }

    // Decide how the video reaches HomeKit - copied from the camera or re-encoded - and the bitrate we target either way. The channel's bitrate ceiling arrives from the
    // controller in bits per second and the policy works in kbps throughout, so we convert it here at the boundary.
    const encoding = resolveVideoEncoding({

      channelBitrate: channelProfile.channel.bitrate / 1000,
      channelFps: channelProfile.channel.fps,
      cpuGeneration: this.platform.codecSupport.cpuGeneration,
      hostSystem: this.platform.codecSupport.hostSystem,
      isHighLatency,
      isPackageCamera: isPackageCameraContext(this.protectCamera.accessory.context),
      isTranscoding,
      requestBitrate: request.video.max_bit_rate,
      requestFps: request.video.fps,
      requestHeight: request.video.height,
      requestLevel: request.video.level,
      requestProfile: request.video.profile,
      requestWidth: request.video.width,
      transcodeBitrate: this.protectCamera.hints.transcodeBitrate,
      transcodeHighLatencyBitrate: this.protectCamera.hints.transcodeHighLatencyBitrate,
      useTsb
    });

    // If we are streaming the package camera, and it's dark outside, activate the flashlight on the camera. We record the lit service on the session itself so the single
    // prepared-session disposal path can turn it back off on any failed start, and stopStream can turn it off on a normal stop - the session field is the one record of
    // the toggle.
    if(isPackageCameraContext(this.protectCamera.accessory.context)) {

      const flashlightService = this.protectCamera.accessory.getServiceById(this.hap.Service.Lightbulb, ProtectReservedNames.LIGHTBULB_PACKAGE_FLASHLIGHT);

      // If we're already on, we assume the user's activated it and we'll leave it untouched. Otherwise, we'll toggle it on and off when we begin and end streaming.
      if(this.protectCamera.ufp.isDark && flashlightService && !flashlightService.getCharacteristic(this.hap.Characteristic.On).value) {

        // We explicitly want to call the set handler for the flashlight.
        flashlightService.setCharacteristic(this.hap.Characteristic.On, true);
        sessionInfo.toggleLight = flashlightService;
      }
    }

    // If we have the timeshift buffer enabled, and we've selected the same quality for the livestream as our timeshift buffer, we use the timeshift buffer to
    // significantly accelerate our livestream startup. Using the timeshift buffer provides advantages:
    //
    // - Since we typically have several seconds of video already queued up in the timeshift buffer, FFmpeg will get a significant speed up in startup performance.
    //   FFmpeg takes time at the beginning of each session to analyze the input before allowing you to perform any action. By using the timeshift buffer, we're able to
    //   give FFmpeg all that data right at the beginning, effectively reducing that startup time to the point of being imperceptible.
    //
    // - Since we are using an already existing connection to the Protect controller, we don't need to create another connection which incurs an additional delay, as well
    //   as a resource hit on the Protect controller.
    const tsBuffer: Nullable<Buffer> = useTsb ? (this.timeshift?.buffer.getLast(PROTECT_LIVESTREAM_API_IDR_INTERVAL * 1000) ?? null) : null;

    // -hide_banner                     Suppress printing the startup banner in FFmpeg.
    // -nostats                         Suppress printing progress reports while encoding in FFmpeg.
    // -fflags +discardcorrupt          Discard any corrupt packets and continue rather than exit.
    // -err_detect ignore_err           Ignore decoding errors and continue rather than exit.
    // [video decoder]                  The camera codec's input video decoder flags - hardware-accelerated where available, from the FFmpeg options helper.
    // -max_delay 500000                Set an upper limit on how much time FFmpeg can take in demuxing packets, in microseconds.
    // -flags low_delay                 Tell FFmpeg to optimize for low delay / realtime decoding.
    // -probesize number                How many bytes should be analyzed for stream information.
    const ffmpegArgs = [

      "-hide_banner",
      "-nostats",
      "-fflags", "+discardcorrupt",
      "-err_detect", "ignore_err",
      ...this.ffmpegOptions.videoDecoder(this.protectCamera.ufp.videoCodec),
      "-max_delay", "500000",
      "-flags", "low_delay",
      "-probesize", this.probesize.toString()
    ];

    if(useTsb) {

      // -f mp4                         Tell ffmpeg that it should expect an MP4-encoded input stream.
      // -i pipe:0                      Use standard input to get video data.
      ffmpegArgs.push(

        "-f", "mp4",
        "-i", "pipe:0"
      );
    } else {

      // -avioflags direct              Tell FFmpeg to minimize buffering to reduce latency for more realtime processing.
      // -rtsp_transport tcp            Tell the RTSP stream handler that we're looking for a TCP connection.
      // -i channelProfile.url               RTSPS URL to get our input stream from.
      ffmpegArgs.push(

        "-avioflags", "direct",
        "-rtsp_transport", "tcp",
        "-i", channelProfile.url
      );
    }

    // Select the streams our single tee-muxed output carries. Protect actually maps audio and video tracks in opposite locations from where FFmpeg typically expects
    // them, so we name the track locations generally rather than positionally in case Protect changes this in the future. The video map always binds, and a bound
    // explicit map disables FFmpeg's automatic stream selection for the whole output...that is load-bearing for the audio map's optionality: when the input carries no
    // audio track (the livestream API can transiently deliver an fMP4 without one, and an RTSP stream can carry a track layout the index-specific map misses), the
    // audio map simply matches nothing rather than inviting automatic selection to improvise a substitute into the audio sink.
    //
    // -map 0:v:0                       Selects the first available video track from the stream.
    // -map 0:a:0?                      Selects the first available audio track from the stream, if it exists. On the RTSP path we select the second audio track instead,
    //                                  to take advantage of the higher fidelity potentially available to us there. The livestream API only provides an AAC track.
    ffmpegArgs.push(

      "-map", "0:v:0"
    );

    if(sessionInfo.hasAudioSupport) {

      ffmpegArgs.push(

        "-map", useTsb ? "0:a:0?" : "0:a:1?"
      );
    }

    // Inform the user.
    const hinting = [];

    // Lightning bolt, using the default emoji presentation. We use this to indicate hardware acceleration.
    hinting.push(...(isTranscoding && usesHardwareEncoder ? ["\u{26A1}\u{FE0F}"] : []));

    // Gear, using the text presentation modifier. We use this to indicate that we're transcoding.
    hinting.push(...(isTranscoding ? ["\u{26ED}\u{FE0E}"] : []));

    // Hourglass, using the text presentation modifier. We use this to indicate high latency connections.
    hinting.push(...((request.audio.packet_time === 60) ? ["\u{29D6}\u{FE0E}"] : []));

    // Speaker, using the text presentation modifier. We use this to indicate that we're applying audio filters for noise reduction.
    hinting.push(...(sessionInfo.hasAudioSupport && (this.protectCamera.hasFeature("Audio.Filter.Noise")) ? ["\u{1F50A}\u{FE0E}"] : []));

    hinting.push(...(hinting.length ? [""] : []));

    this.log.info("%sStreaming request: %sx%s@%sfps, %s. Using %s [%s], %s [%s].", hinting.join(" "), request.video.width, request.video.height, request.video.fps,
      formatBps(encoding.targetBitrate * 1000), channelProfile.name, this.protectCamera.videoCodecName,
      formatBps(channelProfile.channel.bitrate), useTsb ? "TSB/" + (this.protectCamera.hasFeature("Debug.Video.Timeshift.UseRtsp") ? "RTSP" : "API") : "RTSP");

    // Render the encoding the policy resolved. The decision is already made - all that happens here is turning it into FFmpeg arguments.
    if(encoding.mode === "transcode") {

      // Configure our video parameters for transcoding.
      ffmpegArgs.push(...this.ffmpegOptions.streamEncoder(encoding.encoderOptions));
    } else {

      // Configure our video parameters for just copying the input stream from Protect - it tends to be quite solid in most cases:
      //
      // -codec:v copy                  Copy the stream without reencoding it.
      ffmpegArgs.push(

        "-codec:v", "copy"
      );

      // The livestream API needs to be transmuxed before we use it directly.
      if(encoding.transmux) {

        // -bsf:v h264_mp4toannexb    Convert the livestream container format from MP4 to MPEG-TS.
        ffmpegArgs.push("-bsf:v", "h264_mp4toannexb");
      }
    }

    // -metadata                        Set the metadata to the name of the camera to distinguish between FFmpeg sessions.
    ffmpegArgs.push(

      "-metadata", "comment=" + this.protectCamera.accessoryName + " Livestream"
    );

    // Configure the audio portion of the command line, if we have a version of FFmpeg that supports the audio codecs we need. Options we use are:
    //
    // -codec:a                         Encode using the codecs available to us on given platforms.
    // -profile:a 38                    Specify enhanced, low-delay AAC for HomeKit.
    // -flags:a +global_header          Sets the global header in the audio bitstream. Needed for FDK-AAC to correctly initialize. For encoders like aac_at it becomes a
    //                                  no-op. The :a specifier is load-bearing: with a single output, an unqualified option binds to every stream it can apply to, and
    //                                  a global header on the video encoder would strip the in-band SPS and PPS that HomeKit requires from RTP video.
    // -ar samplerate                   Sample rate to use for this audio. This is specified by HomeKit.
    // -b:a bitrate                     Bitrate to use for this audio stream. This is specified by HomeKit.
    // -ac number                       Set the number of audio channels.
    if(sessionInfo.hasAudioSupport) {

      // Configure our audio parameters.
      ffmpegArgs.push(

        ...this.ffmpegOptions.audioEncoder(),
        "-flags:a", "+global_header",
        "-profile:a", "38",
        "-ar", request.audio.sample_rate.toString() + "k",
        "-b:a", request.audio.max_bit_rate.toString() + "k",
        "-ac", request.audio.channel.toString()
      );

      // If we are audio filtering, address it here.
      // The input sample rate FFmpeg's audio filters operate on is the camera's livestream (fMP4) audio rate that livestreamAudioSampleRate owns, independent of the
      // output rate HomeKit requests. getAudioFilters checks each filter's frequency against that rate's Nyquist limit, so a doorbell's higher source rate lifts the
      // ceiling far enough that a user's 8-24 kHz highpass/lowpass passes through on a doorbell.
      const afOptions = this.protectCamera.getAudioFilters(livestreamAudioSampleRate(this.protectCamera.ufp));

      if(afOptions.length) {

        ffmpegArgs.push("-filter:a", afOptions.join(", "));
      }
    }

    // Send the stream to HomeKit through a single tee-muxed output rather than two top-level outputs. The distinction is load-bearing: a top-level output that ends up
    // with no streams is a fatal error for the entire command, while a tee sink is isolable...this is the shape that lets a session survive its optional audio map
    // matching nothing. Video and audio are routed to their negotiated SRTP destinations with per-sink select filters, and only the audio sink carries onfail=ignore:
    // an input without an audio track costs us that sink alone, degrading the session to video-only - the truth of the input - while a failure on the video sink
    // keeps tee's default behavior and ends the session loudly. Because no input to this command is synthetic or unbounded, every output stream ends when the camera
    // input does, and FFmpeg's organic exit on input EOF is a design invariant here...the teardown in consumeStreamSegments depends on it.
    //
    // The options inside each sink's brackets combine tee's own per-sink directives - format, stream routing, and failure policy - with options that pass through to
    // that sink's RTP muxer and SRTP protocol:
    //
    // f=rtp                            Use the RTP muxer for this sink.
    // select=v / select=a              Route only the selected stream type to this sink.
    // onfail=ignore                    We set this only on the audio sink: a sink that fails to open or write is dropped while the remaining sinks continue.
    // payload_type=num                 Payload type for the RTP stream. This is negotiated by HomeKit and is usually 99 for H.264 video and 110 for AAC-ELD audio.
    // ssrc=num                         Synchronization source stream identifier. Random number negotiated by HomeKit to identify this stream.
    // flush_packets=1                  Ensure we flush our write buffer after each muxed packet.
    // packetsize=num                   Use a packetsize of 1200 for video, which should be no more than the HomeKit livestreaming MTU (1378 for IPv4 and 1228 for IPv6).
    //                                  For audio, HomeKit livestreaming wants a block size of 480 samples when using AAC-ELD - we loosely interpret that to mean less
    //                                  than 480 bytes per packet and use 384 since it's divisible by 16 kHz and 24 kHz.
    // srtp_out_suite=enc               Specify the output encryption encoding suites.
    // srtp_out_params=params           Specify the output encoding parameters. This is negotiated by HomeKit. The value is safe within tee's sink syntax: the suite's
    //                                  fixed 30-byte key and salt encode to exactly 40 base64 characters with no "=" padding, and the remainder of the base64 alphabet
    //                                  carries no meaning to tee's option parser.
    const videoSink = "[f=rtp:select=v:payload_type=" + request.video.pt.toString() + ":ssrc=" + sessionInfo.videoSSRC.toString() +
      ":flush_packets=1:packetsize=1200:srtp_out_suite=AES_CM_128_HMAC_SHA1_80:srtp_out_params=" + sessionInfo.videoSRTP.toString("base64") +
      "]srtp://" + sessionInfo.address + ":" + sessionInfo.videoPort.toString() + "?rtcpport=" + sessionInfo.videoPort.toString();

    const audioSink = !sessionInfo.hasAudioSupport ? "" :
      "|[f=rtp:select=a:onfail=ignore:payload_type=" + request.audio.pt.toString() + ":ssrc=" + sessionInfo.audioSSRC.toString() +
      ":flush_packets=1:packetsize=384:srtp_out_suite=AES_CM_128_HMAC_SHA1_80:srtp_out_params=" + sessionInfo.audioSRTP.toString("base64") +
      "]srtp://" + sessionInfo.address + ":" + sessionInfo.audioPort.toString() + "?rtcpport=" + sessionInfo.audioPort.toString();

    ffmpegArgs.push(

      "-f", "tee",
      videoSink + audioSink
    );

    // Additional logging, but only if we're debugging.
    if(this.protectCamera.hasFeature("Log.FFmpeg") || this.protectCamera.hasFeature("Debug.Video.FFmpeg") || this.platform.config.verboseFfmpeg) {

      ffmpegArgs.push("-loglevel", "level+verbose");
    }

    if(this.platform.config.debugAll) {

      ffmpegArgs.push("-loglevel", "level+debug");
    }

    // Combine everything and start an instance of FFmpeg. The video health watchdog (returnPort) is supplied ONLY for non-two-way-audio sessions: a two-way-audio
    // session demuxes its packet flow externally, so arming the internal 5-second inbound-silence watchdog there would risk a false force-stop on every two-way live
    // view. The homebridge-plugin-utils process spawns the child synchronously on construction. The subclass implements failed-teardown logging (benign-API
    // suppression gated on useTsb, plus probesize self-tuning) through the logFailedTeardown hook.
    const ffmpegStream = new ProtectStreamingFfmpegProcess(this.ffmpegOptions, {

      args: ffmpegArgs,
      onProbesizeError: (): void => this.adjustProbeSize(),
      returnPort: (sessionInfo.hasAudioSupport && this.protectCamera.hints.twoWayAudio) ? undefined :
        { ipFamily: sessionInfo.addressVersion, port: sessionInfo.videoReturnPort },
      signal: sessionInfo.abortController.signal,
      suppressLivestreamApiErrors: useTsb
    });

    // Bridge FFmpeg's ready signal to HomeKit's StreamRequestCallback, exactly once, for all input sources. ready resolves on FFmpeg's first stderr byte regardless
    // of source and rejects on a spawn failure (-> callback(error)). We prefer the underlying cause on the reject path so an ENOENT surfaces usefully rather than the
    // bare abort-reason name. ready settles once, so this calls back exactly once; the whenEstablished await below gates only whether to keep or bail the session,
    // never the callback.
    void ffmpegStream.ready.then(() => callback(undefined), (reason: unknown) => callback(new Error(this.protectCamera.accessoryName + ": " +
      (((reason instanceof HbpuAbortError) && (reason.cause instanceof Error)) ? reason.cause.message : String(reason)))));

    let segmentWriter: Nullable<BackpressureWriter> = null;
    let subscription: Nullable<LivestreamSubscription> = null;

    // Force-stop bridge: when FFmpeg exits, reclaim the subscription and writer, and (when the session is still live and the exit was organic, not a self-initiated
    // shutdown) force HomeKit to reclaim the streaming slot. We observe BOTH settlements of exited - it rejects on the never-spawned/ENOENT path, and a never-spawned
    // FFmpeg still needs its subscription/writer reclaimed - so the same cleanup runs on either branch. The organic discriminator reads signal.reason: stopStream
    // aborts with an explicit HbpuAbortError("shutdown"), so isHbpuAbortReason(reason, "shutdown") suppresses the self-stop double-fire; the entry-existence guard is
    // defense-in-depth. This is the started-then-died force-stop, and the returnPort watchdog timeout flows through the same path.
    const bridge = (): void => {

      void subscription?.[Symbol.asyncDispose]();
      segmentWriter?.abort();

      if(this.ongoingSessions.has(request.sessionID) && !isHbpuAbortReason(ffmpegStream.signal.reason, "shutdown")) {

        this.controller.forceStopStreamingSession(request.sessionID);
        this.stopStream(request.sessionID);
      }
    };

    void ffmpegStream.exited.then(() => bridge(), () => bridge());

    if(useTsb) {

      // Feed segments to FFmpeg with backpressure handling...if FFmpeg can't keep up, segments are queued and written when it's ready.
      segmentWriter = new BackpressureWriter(() => ffmpegStream.stdin, { signal: sessionInfo.abortController.signal });

      // Subscribe to the pooled livestream via the camera seam. This call is synchronous and returns the subscription handle immediately; the underlying connection
      // begins establishing in the background. We start consuming segments below within the same synchronous frame, before any asynchronous segment can be delivered.
      //
      // A live view is always active (no idle phase, unlike the timeshift's transmit toggle), so the recovery urgency closure is the constant active tolerance: the
      // pool reconnects immediately on a stall because a HomeKit live view is latency-sensitive. The value only matters when the controller is unhealthy.
      //
      // POOL-SHARING INVARIANT: the unifi-protect library's pool sharing key includes segmentLength/chunkSize/timestamps. The live and HKSV-timeshift subscribers
      // share ONE pooled session only because BOTH go through this same seam with the same defaults - the live call OMITS segmentLength, so the seam default
      // (PROTECT_SEGMENT_RESOLUTION = 100) matches the timeshift's explicit 100. If either consumer's opts ever diverge, the session silently splits into two sockets
      // (double controller load, broken self-heal/discontinuity coupling).
      subscription = this.protectCamera.livestream(channelProfile, { signal: sessionInfo.abortController.signal, urgency: () => PROTECT_LIVESTREAM_ACTIVE_TOLERANCE_MS });

      // Drive the segment iterator in the background.
      void this.consumeStreamSegments(ffmpegStream, subscription, segmentWriter, tsBuffer);

      // Wait for the session to establish. If it fails (provisioning deadline expired), dispose the prepared session and bail. The FFmpeg was spawned above before this
      // await, so it must be torn down here rather than left to sit until its returnPort watchdog fires; aborting the umbrella controller inside the disposal helper
      // cascades through the shared signal to the FFmpeg, the writer, and the subscription, so no separate manual teardown of the three is needed.
      if(!(await subscription.whenEstablished())) {

        this.disposePreparedSession(request.sessionID, sessionInfo);

        return;
      }

      // Re-validate the pending session's identity now that the establishment wait has returned. A concurrent stopStream during the wait aborts this session's
      // controller and drops it from the pending map, yet whenEstablished can still resolve true off another subscriber sharing the pooled socket - so without this
      // check we would register an ongoing entry for a session already torn down, with no path left to ever remove it. On a mismatch we dispose defensively (safe to
      // repeat: the concurrent stop's abort already ran) and bail. We do not answer the StreamRequestCallback here: it is owned by the FFmpeg ready bridge above, which
      // the abort settles exactly once, so an explicit callback would double-answer. This closes the stop-during-establishment race; an organic FFmpeg exit during the
      // same wait is an adjacent race tracked separately.
      if(this.pendingSessions.get(request.sessionID) !== sessionInfo) {

        this.disposePreparedSession(request.sessionID, sessionInfo);

        return;
      }
    }

    // Some housekeeping for our FFmpeg and demuxer sessions.
    this.ongoingSessions.set(request.sessionID, {

      abortController: sessionInfo.abortController,
      ffmpeg: [ffmpegStream],
      rtpDemuxer: sessionInfo.rtpDemuxer,
      rtpPortReservations: sessionInfo.rtpPortReservations,
      toggleLight: sessionInfo.toggleLight
    });

    this.pendingSessions.delete(request.sessionID);

    // If we aren't doing two-way audio, we're done here. For two-way audio...we have some more plumbing to do.
    if(!sessionInfo.hasAudioSupport || !this.protectCamera.hints.twoWayAudio) {

      return;
    }

    // Session description protocol message that FFmpeg will share with HomeKit.
    // SDP messages tell the other side of the connection what we're expecting to receive.
    //
    // Parameters are:
    //
    // v             Protocol version - always 0.
    // o             Originator and session identifier.
    // s             Session description.
    // c             Connection information.
    // t             Timestamps for the start and end of the session.
    // m             Media type - audio, adhering to RTP/AVP, payload type 110.
    // b             Bandwidth information - application specific, 16k or 24k.
    // a=rtpmap      Payload type 110 corresponds to an MP4 stream. Format is MPEG4-GENERIC/<audio clock rate>/<audio channels>
    // a=fmtp        For payload type 110, use these format parameters.
    // a=crypto      Crypto suite to use for this session.
    const sdpReturnAudio = [

      "v=0",
      "o=- 0 0 IN " + sdpIpVersion + " 127.0.0.1",
      "s=" + this.protectCamera.accessoryName + " Audio Talkback",
      "c=IN " + sdpIpVersion + " " + sessionInfo.address,
      "t=0 0",
      "m=audio " + sessionInfo.audioIncomingRtpPort.toString() + " RTP/AVP " + request.audio.pt.toString(),
      "b=AS:24",
      "a=rtpmap:110 MPEG4-GENERIC/" + ((request.audio.sample_rate === AudioStreamingSamplerate.KHZ_16) ? "16000" : "24000") + "/" + request.audio.channel.toString(),
      "a=fmtp:110 profile-level-id=1;mode=AAC-hbr;sizelength=13;indexlength=3;indexdeltalength=3; config=" +
        ((request.audio.sample_rate === AudioStreamingSamplerate.KHZ_16) ? "F8F0212C00BC00" : "F8EC212C00BC00"),
      "a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:" + sessionInfo.audioSRTP.toString("base64")
    ].join("\n");

    // Configure the audio portion of the command line, if we have a version of FFmpeg that supports the audio codecs we need. Options we use are:
    //
    // -hide_banner           Suppress printing the startup banner in FFmpeg.
    // -nostats               Suppress printing progress reports while encoding in FFmpeg.
    // -protocol_whitelist    Set the list of allowed protocols for this FFmpeg session.
    // -f sdp                 Specify that our input will be an SDP file.
    // -codec:a               Decode AAC input using the specified decoder.
    // -i pipe:0              Read input from standard input.
    // -codec:a               Encode to AAC. This format is set by Protect.
    // -flags +global_header  Sets the global header in the bitstream.
    // -ar                    Sets the audio rate to what Protect is expecting.
    // -b:a                   Bitrate to use for this audio stream based on what HomeKit is providing us.
    // -ac                    Sets the channel layout of the audio stream based on what Protect is expecting.
    // -f adts                Transmit an ADTS stream.
    // pipe:1                 Output the ADTS stream to standard output.
    const ffmpegReturnAudioCmd = [

      "-hide_banner",
      "-nostats",
      "-protocol_whitelist", "crypto,file,pipe,rtp,udp",
      "-f", "sdp",
      "-codec:a", this.ffmpegOptions.audioDecoder,
      "-i", "pipe:0",
      "-map", "0:a:0",
      ...this.ffmpegOptions.audioEncoder(),
      "-flags", "+global_header",
      "-ar", this.protectCamera.ufp.talkbackSettings.samplingRate.toString(),
      "-b:a", request.audio.max_bit_rate.toString() + "k",
      "-ac", this.protectCamera.ufp.talkbackSettings.channels.toString(),
      "-f", "adts"
    ];

    if(this.protectCamera.hints.twoWayAudioDirect) {

      ffmpegReturnAudioCmd.push("udp://" + this.protectCamera.ufp.host + ":" + this.protectCamera.ufp.talkbackSettings.bindPort.toString());
    } else {

      ffmpegReturnAudioCmd.push("pipe:1");
    }

    // Additional logging, but only if we're debugging.
    if(this.protectCamera.hasFeature("Log.FFmpeg") || this.platform.config.verboseFfmpeg) {

      ffmpegReturnAudioCmd.push("-loglevel", "level+verbose");
    }

    if(this.platform.config.debugAll) {

      ffmpegReturnAudioCmd.push("-loglevel", "level+debug");
    }

    // Wait for the first RTP packet to be forwarded before launching the return-audio FFmpeg. mediaReady resolves on the first forwarded RTP and rejects if the demuxer
    // aborts before any RTP arrives. That rejection has two reachable causes: our own session tearing down (the session signal aborted - a clean stop with nothing to
    // say), or the demuxer's socket faulting beneath a session that lives on (return audio is lost for the rest of the session, and the catch narrates it). The
    // null-narrow mirrors prepareStream: rtpDemuxer is non-null whenever two-way audio is active, which is the only path that reaches here.
    if(sessionInfo.rtpDemuxer) {

      try {

        await sessionInfo.rtpDemuxer.mediaReady;
      } catch(error) {

        // The demuxer settles this promise only from its teardown convergence: the rejection means either our own session is ending, or the demuxer's socket faulted
        // beneath a session that lives on. isCleanTalkbackStop already owns that distinction for the talkback pipeline - route through it rather than re-deriving it.
        // On teardown there is nothing to say; on a fault, the session continues without return audio, and that deserves one plain line - the demuxer has already
        // logged the underlying socket error itself.
        if(isCleanTalkbackStop(error, sessionInfo.abortController.signal)) {

          this.log.debug("Session teardown ended the two-way audio handshake before the first return packet arrived.");

          return;
        }

        this.log.info("Two-way audio is unavailable for the remainder of this session. The audio return channel could not be established.");

        return;
      }
    }

    // Fire up the return-audio FFmpeg and start processing the incoming audio. This is constructed UNCONDITIONALLY: the twoWayAudioDirect path needs it to push
    // udp://camera, and the controller-relayed path drains its ADTS stdout into the talkback session. It uses the plain FfmpegStreamingProcess (no returnPort
    // watchdog because it is outbound, and no subclass suppression/probesize because that is a livestream-API concern). The homebridge-plugin-utils process spawns
    // on construction, so stdin is available immediately for the SDP.
    const ffmpegReturnAudio = new FfmpegStreamingProcess(this.ffmpegOptions, { args: ffmpegReturnAudioCmd, signal: sessionInfo.abortController.signal });

    // Setup housekeeping for the twoway FFmpeg session.
    this.ongoingSessions.get(request.sessionID)?.ffmpeg.push(ffmpegReturnAudio);

    // Feed the SDP session description to FFmpeg on stdin.
    ffmpegReturnAudio.stdin.end(sdpReturnAudio + "\n");

    // Send the audio through the Protect controller's talkback channel, unless we are talking directly to the camera over UDP (twoWayAudioDirect), in which case
    // FFmpeg already pushes udp://camera from the command above and there is no talkback session to open.
    if(!this.protectCamera.hints.twoWayAudioDirect) {

      try {

        // Open the talkback channel. camera.talkback() negotiates the WebSocket and connects atomically (returns a live session or throws); it throws
        // ProtectUnsupportedError for a camera with no speaker. It must be open before tb.send (send throws unless the session is live). We store the session on the
        // ongoing entry as a stopStream backstop immediately after opening.
        const tb = await this.protectCamera.talkback({ signal: sessionInfo.abortController.signal });
        const entry = this.ongoingSessions.get(request.sessionID);

        if(entry) {

          entry.talkback = tb;
        }

        // Drain the return-audio FFmpeg's ADTS stdout into the talkback session. send() resolves only when stdout is exhausted (the return-audio lifetime), so it is
        // detached, not awaited. A Node Readable is an AsyncIterable<Buffer>, so stdout feeds in with no adapter. We dispose the session when send settles (the
        // return-audio FFmpeg ended or faulted), proactively closing on return-audio exit; it is idempotent with the stopStream abort backstop.
        void tb.send(ffmpegReturnAudio.stdout, { signal: sessionInfo.abortController.signal }).catch((error: unknown) => {

          // A clean in-flight stop is the normal end of every two-way-audio session, so we note it at debug and stay quiet. A genuine mid-stream fault still surfaces as
          // an error. The shared predicate owns the clean-versus-fault decision.
          if(isCleanTalkbackStop(error, sessionInfo.abortController.signal)) {

            this.log.debug("Return audio channel closed.", { error });

            return;
          }

          this.log.error("The return audio channel encountered an error: %s.", formatErrorMessage(error));
        }).finally(() => void tb[Symbol.asyncDispose]());
      } catch(error) {

        // Classify the talkback open failure through the shared predicate. A clean stop - the session's own teardown, or the shipped typed caller-abort - means the
        // caller hung up during negotiation before the session opened, so we note it plainly rather than as an error. A genuine fault (a camera with no speaker, a
        // negotiation or open failure) keeps the error path. Either way we continue without talkback.
        if(isCleanTalkbackStop(error, sessionInfo.abortController.signal)) {

          this.log.info("The talkback connection was stopped.");
        } else {

          this.log.error("Unable to connect to the return audio channel: %s.", formatErrorMessage(error));
        }
      }
    }
  }

  // Process incoming stream requests. HomeKit invokes this without awaiting; the START case is async (startStream), so the whole dispatch is routed through
  // guardedDispatch to keep a fault from floating and to answer the callback exactly once. The RECONFIGURE and STOP cases are synchronous and answer immediately.
  public handleStreamRequest(request: StreamingRequest, callback: StreamRequestCallback): void {

    guardedDispatch({ callback, handler: (answer) => this.runStreamRequest(request, answer), label: "stream request", log: this.log });
  }

  // Dispatch a HomeKit stream request to its handler, answering the guarded callback. START launches the session (and answers through the FFmpeg ready bridge inside
  // startStream); RECONFIGURE and STOP answer synchronously.
  private async runStreamRequest(request: StreamingRequest, callback: StreamRequestCallback): Promise<void> {

    switch(request.type) {

      case StreamRequestTypes.START:

        await this.startStream(request, callback);

        break;

      case StreamRequestTypes.RECONFIGURE:

        // Once FFmpeg is updated to support this, we'll enable this one.
        this.log.debug("Streaming parameters adjustment requested by HomeKit: %sx%s, %s fps, %s.",
          request.video.width, request.video.height, request.video.fps, formatBps(request.video.max_bit_rate));

        callback();

        break;

      case StreamRequestTypes.STOP:
      default:

        this.stopStream(request.sessionID);
        callback();

        break;
    }
  }

  // Dispose a prepared (pending) session. This is the single teardown body for a session that was prepared but never became a registered ongoing session: every path
  // that ends a never-registered session routes through it. Aborting the umbrella AbortController is the convergence point - it fans out through the shared signal to
  // the demuxer and any FFmpeg, backpressure writer, and livestream subscription hung off it - while the port reservations and the pending-map entry are released
  // explicitly (the abort alone does not free them), and a package-camera flashlight this session lit is turned back off. It is safe to call more than once:
  // AbortController.abort and PortReservation disposal are both safe to repeat, so routing several paths (including one that may already have partially torn down in a
  // race) through this one body never double-releases.
  private disposePreparedSession(sessionId: string, sessionInfo: SessionInfo): void {

    sessionInfo.abortController.abort(new HbpuAbortError("shutdown"));

    // Turn the package-camera flashlight back off if this session lit it. We explicitly want to call the set handler for the flashlight.
    sessionInfo.toggleLight?.setCharacteristic(this.hap.Characteristic.On, false);

    // Release the port reservations. Disposal is a pure in-memory release that resolves on the same microtask (no I/O), so the fire-and-forget keeps this synchronous.
    for(const reservation of sessionInfo.rtpPortReservations) {

      void reservation[Symbol.asyncDispose]();
    }

    this.pendingSessions.delete(sessionId);
  }

  // Close a video stream.
  public stopStream(sessionId: string): void {

    try {

      // Stop any FFmpeg instances we have running.
      const ongoingSession = this.ongoingSessions.get(sessionId);

      if(ongoingSession) {

        // Single-abort teardown. The per-session AbortController is the SOLE teardown trigger: it fans out (via its signal) to the demuxer, every FFmpeg, the
        // backpressure writer, the talkback session, and the livestream subscription. The explicit HbpuAbortError("shutdown") reason is load-bearing - the .exited
        // force-stop bridge reads isHbpuAbortReason(reason, "shutdown") to suppress the self-stop double-fire; a bare abort() would set the reason to a DOMException
        // the discriminator never matches.
        ongoingSession.abortController.abort(new HbpuAbortError("shutdown"));

        // Dispose the talkback session as a backstop. The abort above already closed it through the shared signal, so this is an idempotent no-op (no double error).
        void ongoingSession.talkback?.[Symbol.asyncDispose]();

        // Turn off the flashlight on package cameras, if enabled. This HomeKit-state side effect cannot fold into the abort, so it stays explicit. We explicitly want
        // to call the set handler for the flashlight.
        ongoingSession.toggleLight?.setCharacteristic(this.hap.Characteristic.On, false);

        // Inform the user.
        this.log.info("Stopped video streaming session.");

        // Release our port reservations. Disposal is a pure in-memory release that resolves on the same microtask (no I/O), so the fire-and-forget keeps stopStream
        // synchronous.
        for(const reservation of ongoingSession.rtpPortReservations) {

          void reservation[Symbol.asyncDispose]();
        }
      }

      // On the off chance we were signaled to prepare to start streaming, but never actually started streaming, cleanup after ourselves through the shared disposal
      // helper. It aborts the pending session's controller (tearing down the RtpDemuxer that prepareStream bound, which releasing the ports alone would not close),
      // releases the reservations, turns off a lit flashlight, and deletes the pending-map entry - so no separate pending delete is needed below.
      const pendingSession = this.pendingSessions.get(sessionId);

      if(pendingSession) {

        this.disposePreparedSession(sessionId, pendingSession);
      }

      // Delete the ongoing entry. The pending entry, if there was one, was already deleted by the disposal helper.
      this.ongoingSessions.delete(sessionId);
    } catch(error) {

      this.log.error("Unable to cleanly end the FFmpeg video processes: %s.", formatErrorMessage(error));
    }
  }

  /* Shut down all our video streams and end this camera's probesize self-tuning with them.
   *
   * Every path that calls shutdown is ending this instance's service life, so the teardown here is total: every session the delegate still holds ends, streaming or
   * still establishing, and the self-tuning story ends with them. A pending auto-reset timer would otherwise keep a retired delegate reachable for the remainder of its
   * window, and resetProbesizeOverride owns the clear-and-reset, so the tuning state and its timer always end together.
   *
   * Safe to call more than once - a repeat call finds no sessions and nothing to reset. That holds structurally rather than through a latch: both session maps drain on
   * the first call, and the reset assigns fixed values, so a latch field here would add state without adding a guarantee.
   */
  public shutdown(): void {

    for(const session of this.ongoingSessions.keys()) {

      this.stopStream(session);
    }

    // A session still mid-establishment holds a spawned FFmpeg, an RTP demuxer, port reservations, and an establishing subscription on its umbrella controller, and the
    // loop above walks only the registered ongoing sessions. Routing each pending session through the shared disposal aborts its resources as one cascade under the
    // same "shutdown" reason stopStream uses, so neither a session resource nor a later "failed" classification can outlive the delegate. Deleting the current entry
    // during the iteration is safe, as is calling the helper more than once. Each disposal is caught on its own, mirroring stopStream's log-and-swallow posture, so one
    // failure strands neither the sessions behind it nor the reset below.
    for(const [ sessionId, sessionInfo ] of this.pendingSessions) {

      try {

        this.disposePreparedSession(sessionId, sessionInfo);
      } catch(error) {

        this.log.error("Unable to cleanly end the FFmpeg video processes: %s.", formatErrorMessage(error));
      }
    }

    this.resetProbesizeOverride();
  }

  // Adjust our probe hints.
  public adjustProbeSize(): void {

    const isTemporary = this.probesizeTuning.adjust();

    this.log.error("The FFmpeg process ended unexpectedly due to issues with the media stream provided by the UniFi Protect livestream API. " +
    "Adjusting the settings we use for FFmpeg %s to use safer values at the expense of some additional streaming startup latency.",
    isTemporary ? "temporarily" : "permanently");
  }

  /* Reset the probesize self-tuning back to this camera's baseline.
   *
   * This is the single owner of the clear-and-reset: the override, its retry count, and any pending auto-reset timer end together here, so every role that needs the
   * tuning wound back routes through this one body rather than reaching for the timer itself. The override and its retry count accumulate as FFmpeg repeatedly fails to
   * estimate the stream rate, and at the permanent ceiling (PROTECT_PROBESIZE_OVERRIDE_PERMANENT_THRESHOLD adjustments) no auto-reset timer is armed, so the elevated
   * probesize - and the startup latency it costs - otherwise persists for the whole life of the delegate.
   *
   * A controller reboot restarts this camera's stream from scratch, the natural boundary to clear the latch and let it re-tune from its baseline; the NVR calls this on
   * the reboot edge, where the trade-off is one possibly-wasted baseline spawn on a chronically-flaky camera in exchange for not penalizing every camera forever -
   * probesize is read only when ffmpegArgs is built at spawn, so this never disturbs an in-flight process, and a fresh failure cheaply re-arms it. The delegate's own
   * shutdown is the terminal role instead: nothing re-arms afterward, and the point of the reset is to leave no timer pending on an instance whose service life is over.
   */
  public resetProbesizeOverride(): void {

    this.probesizeTuning.reset();
  }

  // Utility to return the currently set probesize for a camera.
  public get probesize(): number {

    return this.probesizeTuning.effective;
  }
}

// The production StreamingDelegateFactory: builds the concrete FFmpeg-backed delegate. The platform holds this typed as the abstraction; a test platform substitutes a
// stub. The factory's create is exactly a constructor call, so wiring construction through it is behavior-neutral.
export const streamingDelegateFactory: StreamingDelegateFactory = {

  create: (camera: ProtectCameraHost, resolutions: Resolution[]): StreamingDelegate => new ProtectStreamingDelegate(camera, resolutions)
};
