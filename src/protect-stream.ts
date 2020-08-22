/* Copyright(C) 2017-2020, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-stream.ts: Homebridge camera streaming delegate implementation for Protect.
 *
 * This module is heavily inspired by the homebridge and homebridge-camera-ffmpeg source code and
 * borrows heavily from both. Thank you for your contributions to the HomeKit world.
 */
import getPort from "get-port";
import {
  API,
  APIEvent,
  AudioStreamingCodecType,
  AudioStreamingSamplerate,
  CameraController,
  CameraControllerOptions,
  CameraStreamingDelegate,
  HAP,
  Logging,
  PrepareStreamCallback,
  PrepareStreamRequest,
  PrepareStreamResponse,
  SnapshotRequest,
  SnapshotRequestCallback,
  SRTPCryptoSuites,
  StartStreamRequest,
  StreamingRequest,
  StreamRequestCallback,
  StreamRequestTypes
} from "homebridge";
import ip from "ip";
import { ProtectCamera } from "./protect-camera";
import { FfmpegProcess } from "./protect-ffmpeg";
import { ProtectPlatform } from "./protect-platform";
import { ProtectOptions } from "./protect-types";

const beVerbose = false;

// Bring in a precompiled ffmpeg binary that meets our requirements, if available.
const pathToFfmpeg = require("ffmpeg-for-homebridge"); // eslint-disable-line @typescript-eslint/no-var-requires

// Increase the listener limits to support Protect installations with more than 10 cameras. 100 seems like a reasonable default.
require("events").EventEmitter.defaultMaxListeners = 100; // eslint-disable-line @typescript-eslint/no-var-requires

type SessionInfo = {
  address: string; // Address of the HAP controller.

  videoPort: number;
  videoReturnPort: number;
  videoCryptoSuite: SRTPCryptoSuites; // This should be saved if multiple suites are supported.
  videoSRTP: Buffer; // Key and salt concatenated.
  videoSSRC: number; // RTP synchronisation source.

  audioPort: number;
  audioReturnPort: number;
  audioCryptoSuite: SRTPCryptoSuites;
  audioSRTP: Buffer;
  audioSSRC: number;
};

// Camera streaming delegate implementation for Protect.
export class ProtectStreamingDelegate implements CameraStreamingDelegate {
  private readonly api: API;
  private readonly camera: ProtectCamera;
  private readonly config: ProtectOptions;
  private debug: (message: string, ...parameters: any[]) => void;
  private readonly hap: HAP;
  private readonly log: Logging;
  readonly name: string;
  readonly platform: ProtectPlatform;
  readonly videoProcessor: string;
  private readonly interfaceName = "public";
  controller: CameraController;

  // Keep track of streaming sessions.
  pendingSessions: Record<string, SessionInfo> = {};
  ongoingSessions: Record<string, FfmpegProcess> = {};

  constructor(camera: ProtectCamera) {
    this.api = camera.api;
    this.camera = camera;
    this.config = camera.platform.config;
    this.debug = camera.debug.bind(camera.platform);
    this.hap = camera.api.hap;
    this.log = camera.platform.log;
    this.name = camera.accessory.displayName;
    this.platform = camera.platform;
    this.videoProcessor = this.config.videoProcessor || pathToFfmpeg || "ffmpeg";

    this.api.on(APIEvent.SHUTDOWN, () => {
      for(const session in this.ongoingSessions) {
        this.stopStream(session);
      }
    });

    // Setup for our camera controller.
    const options: CameraControllerOptions = {
      cameraStreamCount: 2, // HomeKit requires at least 2 streams, and HomeKit Secure Video requires 1.
      delegate: this,
      streamingOptions: {
        supportedCryptoSuites: [this.hap.SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80],
        video: {
          resolutions: [
            // Width, height, framerate.
            [1920, 1080, 30],
            [1280, 960, 30],
            [1280, 720, 30],
            [1024, 768, 30],
            [640, 480, 30],
            [640, 360, 30],
            [480, 360, 30],
            [480, 270, 30],
            [320, 240, 30],
            [320, 240, 15],   // Apple Watch requires this configuration
            [320, 180, 30]
          ],
          codec: {
            profiles: [this.hap.H264Profile.BASELINE, this.hap.H264Profile.MAIN, this.hap.H264Profile.HIGH],
            levels: [this.hap.H264Level.LEVEL3_1, this.hap.H264Level.LEVEL3_2, this.hap.H264Level.LEVEL4_0]
          }
        },
        audio: {
          codecs: [
            {
              type: AudioStreamingCodecType.AAC_ELD,
              samplerate: AudioStreamingSamplerate.KHZ_16
            }
          ]
        }
      }
    };
    this.controller = new this.hap.CameraController(options);
  }

  // HomeKit image snapshot request handler.
  async handleSnapshotRequest(request: SnapshotRequest, callback: SnapshotRequestCallback): Promise<void> {
    const params = new URLSearchParams({ force: "true", width: request.width as any, height: request.height as any });

    this.debug("%s: HomeKit snapshot request: %sx%s. Retrieving image from Protect: %s?%s", this.name, request.width, request.height, this.camera.snapshotUrl, params);

    const response = await this.camera.nvr.nvrApi.fetch(this.camera.snapshotUrl + "?" + params, { method: "GET" }, true, false);

    if(!response?.ok) {
      this.log("%s: Unable to retrieve snapshot.", this.name);
      callback(new Error(this.name + ": Unable to retrieve snapshot."));
      return;
    }

    try {
      const buffer = await response.buffer();
      callback(undefined, buffer);
    } catch(error) {
      this.log.error("%s: An error occurred while making a snapshot request: %s.", this.name, error);
      callback(error);
    }
  }

  // Prepare to launch the video stream.
  async prepareStream(request: PrepareStreamRequest, callback: PrepareStreamCallback): Promise<void> {
    const videoReturnPort = await getPort();
    const videoSSRC = this.hap.CameraController.generateSynchronisationSource();
    const audioReturnPort = await getPort();
    const audioSSRC = this.hap.CameraController.generateSynchronisationSource();

    const sessionInfo: SessionInfo = {
      address: request.targetAddress,

      videoPort: request.video.port,
      videoReturnPort: videoReturnPort,
      videoCryptoSuite: request.video.srtpCryptoSuite,
      videoSRTP: Buffer.concat([request.video.srtp_key, request.video.srtp_salt]),
      videoSSRC: videoSSRC,

      audioPort: request.audio.port,
      audioReturnPort: audioReturnPort,
      audioCryptoSuite: request.audio.srtpCryptoSuite,
      audioSRTP: Buffer.concat([request.audio.srtp_key, request.audio.srtp_salt]),
      audioSSRC: audioSSRC
    };

    const currentAddress = ip.address("public", request.addressVersion);

    const response: PrepareStreamResponse = {
      address: currentAddress,

      video: {
        port: videoReturnPort,
        ssrc: videoSSRC,

        srtp_key: request.video.srtp_key,
        srtp_salt: request.video.srtp_salt
      },

      audio: {
        port: audioReturnPort,
        ssrc: audioSSRC,

        srtp_key: request.audio.srtp_key,
        srtp_salt: request.audio.srtp_salt
      }
    };

    // Add it to the pending session queue so we're ready to start when we're called upon.
    this.pendingSessions[request.sessionID] = sessionInfo;
    callback(undefined, response);
  }

  // Launch the Protect video stream.
  private async startStream(request: StartStreamRequest, callback: StreamRequestCallback): Promise<void> {
    const sessionInfo = this.pendingSessions[request.sessionID];

    // Set our packet size to be 564. Why? MPEG transport stream (TS) packets are 188 bytes in size each.
    // These packets transmit the video data that you ultimately see on your screen and are transmitted using
    // UDP. Each UDP packet is 1316 bytes in size, before being encapsulated in IP. We want to get as many
    // TS packets as we can, within reason, in those UDP packets. This translates to 1316 / 188 = 7 TS packets
    // as a limit of what can be pushed through over a network connection. Here's the problem...you need to have
    // enough data to fill that pipe, all the time. Network latency, ffmpeg overhead, and the speed / quality of
    // the original camera stream all play a role here, and as you can imagine, there's a nearly endless set of
    // combinations to deciding how to fill that pipe. Set it too low, and you're incurring extra overhead in
    // pushing less data to clients, though you're increasing interactivity by getting whatever data you have to
    // the end user. Set it too high, and startup latency becomes unacceptable when you're trying to stream.
    //
    // For audio, you have a latency problem and a packet size that's too big will force the audio to sound choppy
    // - so we opt to increase responsiveness at the risk of more overhead. This gives the end user a much better
    // audio experience, at a very marginal cost in bandwidth overhead.
    //
    // Through experimentation, I've found a sweet spot of 188 * 3 = 564 for video on Protect cameras. This works
    // very well for G3-series cameras, and pretty well for G4-series cameras. The G4s tend to push a lot more data
    // which drives the latency higher when you're first starting up a stream. In my testing, adjusting the packet
    // size beyond 564 did not have a material impact in improving the startup time of a G4 camera, but did have
    // a negative impact on G3 cameras.
    const videomtu = 188 * 3;
    const audiomtu = 188 * 1;

    // -rtsp_transport tcp: tell the RTSP stream handler that we're looking for a TCP connection.
    let fcmd = "-rtsp_transport tcp -i " + this.camera.cameraUrl;

    this.log("%s: HomeKit video stream request received: %sx%s, %s fps, %s kbps.",
      this.name, request.video.width, request.video.height, request.video.fps, request.video.max_bit_rate);

    // Configure our video parameters:
    // -map 0:v           selects the first available video track from the stream. Protect actually maps audio
    //                    and video tracks in opposite locations from where ffmpeg typically expects them. This
    //                    setting is a more general solution than naming the track locations directly in case
    //                    Protect changes this in n the future.
    // -vcodec copy       copy the stream withour reencoding it.
    // -f rawvideo        specify that we're using raw video.
    // -pix_fmt yuvj420p  use the yuvj420p pixel format, which is what Protect uses.
    // -r fps             frame rate to use for this stream. This is specified by HomeKit.
    // -b:v bitrate       the average bitrate to use for this stream. This is specified by HomeKit.
    // -bufsize size      this is the decoder buffer size, which drives the variability / quality of the output bitrate.
    // -maxrate bitrate   the maximum bitrate tolerance, used with -bufsize. We set this to max_bit_rate to effectively
    //                    create a constant bitrate.
    // -payload_type num  payload type for the RTP stream. This is negotiated by HomeKit and is usually 99 for H.264 video.
    const ffmpegVideoArgs =
      " -map 0:v" +
      " -vcodec copy" +
      " -f rawvideo" +
      " -pix_fmt yuvj420p" +
      " -r " + request.video.fps +
      " " + this.platform.config.ffmpegOptions +
      " -b:v " + request.video.max_bit_rate + "k" +
      " -bufsize " + (2 * request.video.max_bit_rate) + "k" +
      " -maxrate " + request.video.max_bit_rate + "k" +
      " -payload_type " + request.video.pt;

    // Add the required RTP settings and encryption for the stream:
    // -ssrc                   synchronization source stream identifier. Random number negotiated by HomeKit to identify this stream.
    // -f rtp                  specify that we're using the RTP protocol.
    // -srtp_out_suite enc     specify the output encryption encoding suites.
    // -srtp_out_params params specify the output encoding parameters. This is negotiated by HomeKit.
    const ffmpegVideoStream =
      " -ssrc " + sessionInfo.videoSSRC +
      " -f rtp" +
      " -srtp_out_suite AES_CM_128_HMAC_SHA1_80" +
      " -srtp_out_params " + sessionInfo.videoSRTP.toString("base64") +
      " srtp://" + sessionInfo.address + ":" + sessionInfo.videoPort +
      "?rtcpport=" + sessionInfo.videoPort +"&localrtcpport=" + sessionInfo.videoPort + "&pkt_size=" + videomtu;

    // Assemble the final video command line.
    fcmd += ffmpegVideoArgs;
    fcmd += ffmpegVideoStream;

    // Configure the audio portion of the command line, but only if we have audio supported enabled (on by
    // default), and our version of FFmpeg supports libfdk_aac. Options we use are:
    //
    // -map 0:a              selects the first available audio track from the stream. Protect actually maps audio
    //                       and video tracks in opposite locations from where ffmpeg typically expects them. This
    //                       setting is a more general solution than naming the track locations directly in case
    //                       Protect changes this in the future.
    // -acodec libfdk_aac    encode to AAC.
    // -profile:a aac_eld    specify enhanced, low-delay AAC for HomeKit.
    // -flags +global_header sets the global header in the bitstream.
    // -f null               null filter to pass the audio unchanged without running through a muxing operation.
    // -ar samplerate        sample rate to use for this audio. This is specified by HomeKit.
    // -b:a bitrate          bitrate to use for this audio. This is specified by HomeKit.
    // -bufsize size         this is the decoder buffer size, which drives the variability / quality of the output bitrate.
    // -ac 1                 set the number of audio channels to 1.
    // -payload_type num     payload type for the RTP stream. This is negotiated by HomeKit and is usually 110 for AAC-ELD audio.
    if(await FfmpegProcess.codecEnabled(this.videoProcessor, "libfdk_aac")) {

      // Configure our video parameters.
      const ffmpegAudioArgs =
        " -map 0:a" +
        " -acodec libfdk_aac" +
        " -profile:a aac_eld" +
        " -flags +global_header" +
        " -f null" +
        " -ar " + request.audio.sample_rate + "k" +
        " -b:a " + request.audio.max_bit_rate + "k" +
        " -bufsize " + (2 * request.audio.max_bit_rate) + "k" +
        " -ac 1" +
        " -payload_type " + request.audio.pt;

      // Add the required RTP settings and encryption for the stream:
      // -ssrc                   synchronization source stream identifier. Random number negotiated by HomeKit to identify this stream.
      // -f rtp                  specify that we're using the RTP protocol.
      // -srtp_out_suite enc     specify the output encryption encoding suites.
      // -srtp_out_params params specify the output encoding parameters. This is negotiated by HomeKit.
      const ffmpegAudioStream =
        " -ssrc " + sessionInfo.audioSSRC +
        " -f rtp" +
        " -srtp_out_suite AES_CM_128_HMAC_SHA1_80" +
        " -srtp_out_params " + sessionInfo.audioSRTP.toString("base64") +
        " srtp://" + sessionInfo.address + ":" + sessionInfo.audioPort +
        "?rtcpport=" + sessionInfo.audioPort + "&localrtcpport=" + sessionInfo.audioPort + "&pkt_size=" + audiomtu;

      fcmd += ffmpegAudioArgs;
      fcmd += ffmpegAudioStream;
    }

    // Additional logging, but only if we're debugging.
    if(beVerbose || this.platform.debugMode) {
      fcmd += " -loglevel level+verbose";
    }

    // Combine everything and start an instance of FFmpeg.
    const ffmpeg = new FfmpegProcess(this, request.sessionID, fcmd, sessionInfo.videoReturnPort, callback);

    // Some housekeeping for our FFmpeg sessions.
    this.ongoingSessions[request.sessionID] = ffmpeg;
    delete this.pendingSessions[request.sessionID];
  }

  // Process incoming stream requests.
  handleStreamRequest(request: StreamingRequest, callback: StreamRequestCallback): void {

    switch(request.type) {
      case StreamRequestTypes.START:
        this.startStream(request, callback);
        break;

      case StreamRequestTypes.RECONFIGURE:
        // Once ffmpeg is updated to support this, we'll enable this one.
        this.log("%s: Ignoring request to reconfigure: %sx%s, %s fps, %s kbps.",
          this.name, request.video.width, request.video.height, request.video.fps, request.video.max_bit_rate);
        callback();
        break;

      case StreamRequestTypes.STOP:
      default:
        this.stopStream(request.sessionID);
        callback();
        break;
    }
  }

  // Close a video stream.
  public stopStream(sessionId: string): void {
    try {
      if (this.ongoingSessions[sessionId]) {
        const ffmpegProcess = this.ongoingSessions[sessionId];
        if(ffmpegProcess) {
          ffmpegProcess.stop();
        }
      }
      delete this.ongoingSessions[sessionId];
      this.log.info("%s: Stopped video stream.", this.name);
    } catch(error) {
      this.log.error("%s: Error occurred terminating video process: %s", this.name, error);
    }
  }
}
