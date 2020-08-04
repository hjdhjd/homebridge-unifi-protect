/* Copyright(C) 2017-2020, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-stream.ts: Homebridge camera streaming delegate implementation for Protect.
 *
 * This module is heavily inspired by the homebridge and homebridge-camera-ffmpeg source code and
 * borrows heavily from both. Thank you for your contributions to the HomeKit world.
 */
import { spawn } from "child_process";
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
    // this.debug = camera.platform.log;
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
  handleSnapshotRequest(request: SnapshotRequest, callback: SnapshotRequestCallback): void {
    const fcmd = "-re -rtsp_transport tcp -i " + this.camera.cameraUrl + " -frames:v 1 -f image2 -";

    try {
      // Launch FFmpeg to grab this snapshot.
      const ffmpeg = spawn(this.videoProcessor, fcmd.split(/\s+/), { env: process.env });

      // Grab the image.
      let imageBuffer = Buffer.alloc(0);
      this.debug("%s: Image snapshot: %sx%s.", this.name, request.width, request.height);

      ffmpeg.stdout.on("data", (data: Uint8Array) => {
        imageBuffer = Buffer.concat([imageBuffer, data]);
      });

      ffmpeg.on("error", (error: string) => {
        this.log.error("%s: An error occurred while making a snapshot request: %s.", this.name, error);
      });

      ffmpeg.on("close", () => {
        callback(undefined, imageBuffer);
      });

    } catch(error) {
      this.log.error(error, this.name);
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

    // We're going to be encoding an H.264 stream.
    const vcodec = "libx264";

    // Accept whatever frame rate is requested of us.
    const fps = request.video.fps;

    // Set our packet size to be 188 - it's the smallest possible size we can use (must be a multiple of 188).
    // We do this primarily for speed and interactivity at the expense of some minor additional overhead.
    const mtu = 188;

    // Protect unfortunately has the video and audio streams backwards from what FFmpeg expects, so we map the
    // audio and video channels to the right streams.
    const mapaudio = "0:0";
    const mapvideo = "0:1";

    // Accept whatever bitrates are requested of us.
    const videoBitrate = request.video.max_bit_rate;
    const audioBitrate = request.audio.max_bit_rate;

    let fcmd = "-re -rtsp_transport tcp -i " + this.camera.cameraUrl;

    this.log("%s: Starting video stream: %sx%s, %s fps, %s kbps.",
      this.name, request.video.width, request.video.height, request.video.fps, request.video.max_bit_rate);

    // Configure our video parameters.
    const ffmpegVideoArgs =
      " -map " + mapvideo +
      " -vcodec " + vcodec +
      " -pix_fmt yuvj420p" +
      " -r " + fps +
      " -f rawvideo" +
      " " + this.platform.config.ffmpegOptions +
      " -b:v " + videoBitrate + "k" +
      " -bufsize " + 2 * videoBitrate + "k" +
      " -maxrate " + videoBitrate + "k" +
      " -payload_type " + request.video.pt;

    // Add the required RTP settings and encryption for the stream.
    const ffmpegVideoStream =
      " -ssrc " + sessionInfo.videoSSRC +
      " -f rtp" +
      " -srtp_out_suite AES_CM_128_HMAC_SHA1_80" +
      " -srtp_out_params " + sessionInfo.videoSRTP.toString("base64") +
      " srtp://" + sessionInfo.address + ":" + sessionInfo.videoPort +
      "?rtcpport=" + sessionInfo.videoPort +"&localrtcpport=" + sessionInfo.videoPort + "&pkt_size=" + mtu;

    // Assemble the final video command line.
    fcmd += ffmpegVideoArgs;
    fcmd += ffmpegVideoStream;

    // Configure the audio portion of the command line, but only if we have audio supported enabled (on by
    // default), and our version of FFmpeg supports libfdk_aac.
    if(this.camera && this.camera.accessory && this.camera.nvr &&
      this.camera.nvr.optionEnabled(this.camera.accessory.context.camera, "Audio") &&
      (await FfmpegProcess.codecEnabled(this.videoProcessor, "libfdk_aac"))) {
      // Configure our video parameters.
      const ffmpegAudioArgs =
        " -map " + mapaudio +
        " -acodec libfdk_aac" +
        " -profile:a aac_eld" +
        " -flags +global_header" +
        " -f null" +
        " -ar " + request.audio.sample_rate + "k" +
        " -b:a " + audioBitrate + "k" +
        " -bufsize " + audioBitrate + "k" +
        " -ac 1" +
        " -payload_type " + request.audio.pt;

      // Add the required RTP settings and encryption for the stream.
      const ffmpegAudioStream =
        " -ssrc " + sessionInfo.audioSSRC +
        " -f rtp" +
        " -srtp_out_suite AES_CM_128_HMAC_SHA1_80" +
        " -srtp_out_params " + sessionInfo.audioSRTP.toString("base64") +
        " srtp://" + sessionInfo.address + ":" + sessionInfo.audioPort +
        "?rtcpport=" + sessionInfo.audioPort + "&localrtcpport=" + sessionInfo.audioPort + "&pkt_size=188";

      fcmd += ffmpegAudioArgs;
      fcmd += ffmpegAudioStream;
    }

    // Additional logging, but only if we're debugging.
    if(this.platform.debugMode) {
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
