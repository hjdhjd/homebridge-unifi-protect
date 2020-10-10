/* Copyright(C) 2017-2020, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-stream.ts: Homebridge camera streaming delegate implementation for Protect.
 *
 * This module is heavily inspired by the homebridge and homebridge-camera-ffmpeg source code and
 * borrows heavily from both. Thank you for your contributions to the HomeKit world.
 */
import {
  API,
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
  SRTPCryptoSuites,
  SnapshotRequest,
  SnapshotRequestCallback,
  StartStreamRequest,
  StreamRequestCallback,
  StreamRequestTypes,
  StreamingRequest
} from "homebridge";
import {
  PROTECT_FFMPEG_AUDIO_FILTER_HIGHPASS,
  PROTECT_FFMPEG_AUDIO_FILTER_LOWPASS,
  PROTECT_FFMPEG_VERBOSE_DURATION
} from "./settings";
import { ProtectCameraConfig, ProtectOptions } from "./protect-types";
import { RtpDemuxer, RtpUtils } from "./protect-rtp";
import { FfmpegProcess } from "./protect-ffmpeg";
import { ProtectCamera } from "./protect-camera";
import { ProtectPlatform } from "./protect-platform";
import ffmpegPath from "ffmpeg-for-homebridge";

// Increase the listener limits to support Protect installations with more than 10 cameras. 100 seems like a reasonable default.
// eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-unsafe-member-access
require("events").EventEmitter.defaultMaxListeners = 100;

type SessionInfo = {
  address: string; // Address of the HAP controller.
  addressVersion: string;

  videoPort: number;
  videoReturnPort: number;
  videoCryptoSuite: SRTPCryptoSuites; // This should be saved if multiple suites are supported.
  videoSRTP: Buffer; // Key and salt concatenated.
  videoSSRC: number; // RTP synchronisation source.

  hasLibFdk: boolean; // Does the user have a version of ffmpeg that supports AAC?
  audioPort: number;
  audioIncomingRtcpPort: number;
  audioIncomingRtpPort: number; // Port to receive audio from the HomeKit microphone.
  rtpDemuxer: RtpDemuxer | null; // RTP demuxer needed for two-way audio.
  audioCryptoSuite: SRTPCryptoSuites;
  audioSRTP: Buffer;
  audioSSRC: number;
};

// Camera streaming delegate implementation for Protect.
export class ProtectStreamingDelegate implements CameraStreamingDelegate {
  private readonly api: API;
  private readonly config: ProtectOptions;
  public controller: CameraController;
  private debug: (message: string, ...parameters: unknown[]) => void;
  private readonly hap: HAP;
  public readonly log: Logging;
  public readonly name: () => string;
  private ongoingSessions: { [index: string]: { ffmpeg: FfmpegProcess[], rtpDemuxer: RtpDemuxer | null } };
  private pendingSessions: { [index: string]: SessionInfo };
  public readonly platform: ProtectPlatform;
  public readonly protectCamera: ProtectCamera;
  private verboseFfmpegTimer!: NodeJS.Timeout | null;
  public readonly videoProcessor: string;

  constructor(camera: ProtectCamera) {
    this.api = camera.api;
    this.config = camera.platform.config;
    this.debug = camera.platform.debug.bind(camera.platform);
    this.hap = camera.api.hap;
    this.log = camera.platform.log;
    this.name = camera.name.bind(camera);
    this.ongoingSessions = {};
    this.protectCamera = camera;
    this.pendingSessions = {};
    this.platform = camera.platform;
    this.videoProcessor = this.config.videoProcessor || ffmpegPath || "ffmpeg";

    // Setup for our camera controller.
    const options: CameraControllerOptions = {
      cameraStreamCount: 10, // HomeKit requires at least 2 streams, and HomeKit Secure Video requires 1.
      delegate: this,
      streamingOptions: {
        audio: {
          codecs: [
            {
              samplerate: AudioStreamingSamplerate.KHZ_16,
              type: AudioStreamingCodecType.AAC_ELD
            }
          ],

          twoWayAudio: this.protectCamera.twoWayAudio
        },

        supportedCryptoSuites: [this.hap.SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80],

        video: {
          codec: {
            levels: [this.hap.H264Level.LEVEL3_1, this.hap.H264Level.LEVEL3_2, this.hap.H264Level.LEVEL4_0],
            profiles: [this.hap.H264Profile.BASELINE, this.hap.H264Profile.MAIN, this.hap.H264Profile.HIGH]
          },

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
          ]
        }
      }
    };

    this.controller = new this.hap.CameraController(options);
  }

  // HomeKit image snapshot request handler.
  public async handleSnapshotRequest(request: SnapshotRequest, callback: SnapshotRequestCallback): Promise<void> {

    const snapshot = await this.getSnapshot(request);

    if(!snapshot) {
      callback(new Error(this.name() + ": Unable to retrieve snapshot"));
      return;
    }

    // Return the image to HomeKit.
    callback(undefined, snapshot);

    // Publish the snapshot as a data URL to MQTT, if configured.
    this.protectCamera.nvr.mqtt?.publish(this.protectCamera.accessory, "snapshot", "data:image/jpeg;base64," + snapshot.toString("base64"));
  }

  // Prepare to launch the video stream.
  public async prepareStream(request: PrepareStreamRequest, callback: PrepareStreamCallback): Promise<void> {

    // We need to check for AAC support because it's going to determine whether we support audio.
    const hasLibFdk = await FfmpegProcess.codecEnabled(this.videoProcessor, "libfdk_aac");

    // Setup our audio plumbing.
    const audioIncomingRtcpPort = (await RtpUtils.reservePorts())[0];
    const audioIncomingPort = (hasLibFdk && this.protectCamera.twoWayAudio) ? (await RtpUtils.reservePorts())[0] : -1;
    const audioIncomingRtpPort = (hasLibFdk && this.protectCamera.twoWayAudio) ? (await RtpUtils.reservePorts(2))[0] : -1;
    const audioSSRC = this.hap.CameraController.generateSynchronisationSource();

    if(!hasLibFdk) {
      this.log.info("%s: Audio support disabled. A version of FFmpeg that is compiled with fdk_aac support is required to support audio.",
        this.name());
    }

    // Setup the RTP demuxer for two-way audio scenarios.
    const rtpDemuxer = (hasLibFdk && this.protectCamera.twoWayAudio) ?
      new RtpDemuxer(this, request.addressVersion, audioIncomingPort, audioIncomingRtcpPort, audioIncomingRtpPort) : null;

    // Setup our video plumbing.
    const videoReturnPort = (await RtpUtils.reservePorts())[0];
    const videoSSRC = this.hap.CameraController.generateSynchronisationSource();

    const sessionInfo: SessionInfo = {
      address: request.targetAddress,
      addressVersion: request.addressVersion,

      audioCryptoSuite: request.audio.srtpCryptoSuite,
      audioIncomingRtcpPort: audioIncomingRtcpPort,
      audioIncomingRtpPort: audioIncomingRtpPort,
      audioPort: request.audio.port,
      audioSRTP: Buffer.concat([request.audio.srtp_key, request.audio.srtp_salt]),
      audioSSRC: audioSSRC,

      hasLibFdk: hasLibFdk,
      rtpDemuxer: rtpDemuxer,

      videoCryptoSuite: request.video.srtpCryptoSuite,
      videoPort: request.video.port,
      videoReturnPort: videoReturnPort,
      videoSRTP: Buffer.concat([request.video.srtp_key, request.video.srtp_salt]),
      videoSSRC: videoSSRC
    };

    // Prepare the response stream. Here's where we figure out if we're doing two-way audio or not. For two-way audio,
    // we need to use a demuxer to separate RTP and RTCP packets. For traditional video/audio streaming, we want to keep
    // it simple and don't use a demuxer.
    const response: PrepareStreamResponse = {
      audio: {
        port: (hasLibFdk && this.protectCamera.twoWayAudio) ? audioIncomingPort : audioIncomingRtcpPort,
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
    this.pendingSessions[request.sessionID] = sessionInfo;
    callback(undefined, response);
  }

  // Launch the Protect video (and audio) stream.
  private startStream(request: StartStreamRequest, callback: StreamRequestCallback): void {

    const cameraConfig = this.protectCamera.accessory.context.camera as ProtectCameraConfig;
    const sessionInfo = this.pendingSessions[request.sessionID];
    const sdpIpVersion = sessionInfo.addressVersion === "ipv6" ? "IP6 ": "IP4";

    // If we aren't connected, we're done.
    if(cameraConfig.state !== "CONNECTED") {
      const errorMessage = "Unable to start video stream - the camera is offline or unavailable.";

      this.log.error("%s: %s", this.name(), errorMessage);
      callback(new Error(this.name() + ": " + errorMessage));
      return;
    }

    // Set our packet size to be 564. Why? MPEG transport stream (TS) packets are 188 bytes in size each.
    // These packets transmit the video data that you ultimately see on your screen and are transmitted using
    // UDP. Each UDP packet is 1316 bytes in size, before being encapsulated in IP. We want to get as many
    // TS packets as we can, within reason, in those UDP packets. This translates to 1316 / 188 = 7 TS packets
    // as a limit of what can be pushed through a single UDP packet. Here's the problem...you need to have
    // enough data to fill that pipe, all the time. Network latency, ffmpeg overhead, and the speed / quality of
    // the original camera stream all play a role here, and as you can imagine, there's a nearly endless set of
    // combinations to decide how to best fill that pipe. Set it too low, and you're incurring extra overhead by
    // pushing less video data to clients in each packet, though you're increasing interactivity by getting
    // whatever data you have to the end user. Set it too high, and startup latency becomes unacceptable
    // when you begin a stream.
    //
    // For audio, you have a latency problem and a packet size that's too big will force the audio to sound choppy
    // - so we opt to increase responsiveness at the risk of more overhead. This gives the end user a much better
    // audio experience, at a marginal cost in bandwidth overhead.
    //
    // Through experimentation, I've found a sweet spot of 188 * 3 = 564 for video on Protect cameras. In my testing,
    // adjusting the packet size beyond 564 did not have a material impact in improving the startup time, and often had
    // a negative impact.
    const videomtu = 188 * 3;
    const audiomtu = 188 * 1;

    // -hide_banner:        suppress printing the startup banner in FFmpeg.
    // -rtsp_transport tcp: tell the RTSP stream handler that we're looking for a TCP connection.
    const ffmpegArgs = [ "-hide_banner", "-rtsp_transport", "tcp", "-i", this.protectCamera.cameraUrl ];

    this.log.info("%s: HomeKit video stream request received: %sx%s, %s fps, %s kbps.",
      this.name(), request.video.width, request.video.height, request.video.fps, request.video.max_bit_rate);

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
    // -ssrc                   synchronization source stream identifier. Random number negotiated by HomeKit to identify this stream.
    // -f rtp                  specify that we're using the RTP protocol.
    // -srtp_out_suite enc     specify the output encryption encoding suites.
    // -srtp_out_params params specify the output encoding parameters. This is negotiated by HomeKit.
    ffmpegArgs.push(
      "-map", "0:v",
      "-vcodec", "copy",
      "-f", "rawvideo",
      "-pix_fmt", "yuvj420p",
      "-r", request.video.fps.toString(),
      ...this.platform.config.ffmpegOptions.split(" "),
      "-b:v", request.video.max_bit_rate.toString() + "k",
      "-bufsize", (2 * request.video.max_bit_rate).toString() + "k",
      "-maxrate", request.video.max_bit_rate.toString() + "k",
      "-payload_type", request.video.pt.toString(),
      "-ssrc", sessionInfo.videoSSRC.toString(),
      "-f", "rtp",
      "-srtp_out_suite", "AES_CM_128_HMAC_SHA1_80",
      "-srtp_out_params", sessionInfo.videoSRTP.toString("base64"),
      "srtp://" + sessionInfo.address + ":" + sessionInfo.videoPort.toString() + "?rtcpport=" + sessionInfo.videoPort.toString() +
      "&localrtcpport=" + sessionInfo.videoPort.toString() + "&pkt_size=" + videomtu.toString()
    );

    // Configure the audio portion of the command line, if we have a version of FFmpeg supports libfdk_aac. Options we use are:
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
    if(sessionInfo.hasLibFdk) {

      // Configure our audio parameters.
      ffmpegArgs.push(
        "-map", "0:a",
        "-acodec", "libfdk_aac",
        "-profile:a", "aac_eld",
        "-flags", "+global_header",
        "-f", "null",
        "-ar", request.audio.sample_rate.toString() + "k",
        "-b:a", request.audio.max_bit_rate.toString() + "k",
        "-bufsize", (2 * request.audio.max_bit_rate).toString() + "k",
        "-ac", "1"
      );

      // If we are audio filtering, address it here.
      if(this.protectCamera.nvr.optionEnabled(cameraConfig, "NoiseFilter", false)) {
        let highpass;
        let lowpass;

        // See what the user has set for the highpass filter for this camera.
        highpass = parseInt(this.protectCamera.nvr.optionGet(cameraConfig, "NoiseFilter.HighPass") ?? "");

        // If we have an invalid setting, use the defaults.
        if((highpass !== highpass) || (highpass < 0)) {
          highpass = PROTECT_FFMPEG_AUDIO_FILTER_HIGHPASS;
        }

        // See what the user has set for the highpass filter for this camera.
        lowpass = parseInt(this.protectCamera.nvr.optionGet(cameraConfig, "NoiseFilter.LowPass") ?? "");

        // If we have an invalid setting, use the defaults.
        if((lowpass !== lowpass) || (lowpass < 0)) {
          lowpass = PROTECT_FFMPEG_AUDIO_FILTER_LOWPASS;
        }

        ffmpegArgs.push("-af", "highpass=f=" + highpass.toString() + ",lowpass=f=" + lowpass.toString());
      }

      // Add the required RTP settings and encryption for the stream:
      // -payload_type num       payload type for the RTP stream. This is negotiated by HomeKit and is usually 110 for AAC-ELD audio.
      // -ssrc                   synchronization source stream identifier. Random number negotiated by HomeKit to identify this stream.
      // -f rtp                  specify that we're using the RTP protocol.
      // -srtp_out_suite enc     specify the output encryption encoding suites.
      // -srtp_out_params params specify the output encoding parameters. This is negotiated by HomeKit.
      ffmpegArgs.push(
        "-payload_type", request.audio.pt.toString(),
        "-ssrc", sessionInfo.audioSSRC.toString(),
        "-f", "rtp",
        "-srtp_out_suite", "AES_CM_128_HMAC_SHA1_80",
        "-srtp_out_params", sessionInfo.audioSRTP.toString("base64"),
        "srtp://" + sessionInfo.address + ":" + sessionInfo.audioPort.toString() + "?rtcpport=" + sessionInfo.audioPort.toString() +
        "&localrtcpport=" + sessionInfo.audioPort.toString() + "&pkt_size=" + audiomtu.toString()
      );
    }

    // Additional logging, but only if we're debugging.
    if(this.platform.verboseFfmpeg) {
      ffmpegArgs.push("-loglevel", "level+verbose");
    }

    if(this.platform.config.debugAll) {
      ffmpegArgs.push("-loglevel", "level+debug");
    }

    // Combine everything and start an instance of FFmpeg.
    const ffmpeg = new FfmpegProcess(this, request.sessionID, ffmpegArgs,
      (sessionInfo.hasLibFdk && this.protectCamera.twoWayAudio) ? undefined : { addressVersion: sessionInfo.addressVersion, port: sessionInfo.videoReturnPort },
      callback);

    // Some housekeeping for our FFmpeg and demuxer sessions.
    this.ongoingSessions[request.sessionID] = { ffmpeg: [ ffmpeg ], rtpDemuxer: sessionInfo.rtpDemuxer };
    delete this.pendingSessions[request.sessionID];

    // If we aren't doing two-way audio, we're done here. For two-way audio...we have some more plumbing to do.
    if(!sessionInfo.hasLibFdk || !this.protectCamera.twoWayAudio) {
      return;
    }

    // Session description protocol message that FFmpeg will share with HomeKit.
    // SDP messages tell the other side of the connection what we're expecting to receive.
    //
    // Parameters are:
    // v             protocol version - always 0.
    // o             originator and session identifier.
    // s             session description.
    // c             connection information.
    // t             timestamps for the start and end of the session.
    // m             media type - audio, adhering to RTP/AVP, payload type 110.
    // b             bandwidth information - application specific, 24k.
    // a=rtpmap      payload type 110 corresponds to an MP4 stream.
    // a=fmtp        for payload type 110, use these format parameters.
    // a=crypto      crypto suite to use for this session.
    const sdpReturnAudio = [
      "v=0",
      "o=- 0 0 IN " + sdpIpVersion + " 127.0.0.1",
      "s=" + this.name() + " Audio Talkback",
      "c=IN " + sdpIpVersion + " " + sessionInfo.address,
      "t=0 0",
      "m=audio " + sessionInfo.audioIncomingRtpPort.toString() + " RTP/AVP 110",
      "b=AS:24",
      "a=rtpmap:110 MPEG4-GENERIC/16000/1",
      "a=fmtp:110 profile-level-id=1;mode=AAC-hbr;sizelength=13;indexlength=3;indexdeltalength=3; config=F8F0212C00BC00",
      "a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:" + sessionInfo.audioSRTP.toString("base64")
    ].join("\n");


    // Configure the audio portion of the command line, if we have a version of FFmpeg supports libfdk_aac. Options we use are:
    //
    // -protocol_whitelist   set the list of allowed protocols for this ffmpeg session.
    // -f sdp                specify that our input will be an SDP file.
    // -acodec libfdk_aac    decode AAC input.
    // -i pipe:0             read input from standard input.
    // -map 0:a              selects the first available audio track from the stream.
    // -acodec aac           encode to AAC. This is set by Protect.
    // -flags +global_header sets the global header in the bitstream.
    // -ar samplerate        sample rate to use for this audio. This is specified by Protect.
    // -b:a bitrate          bitrate to use for this audio. This is specified by Protect.
    // -ac 1                 set the number of audio channels to 1. This is specified by Protect.
    // -f adts               transmit an ADTS stream.
    const ffmpegReturnAudioCmd = [
      "-hide_banner",
      "-protocol_whitelist", "pipe,udp,rtp,file,crypto",
      "-f", "sdp",
      "-acodec", "libfdk_aac",
      "-i", "pipe:0",
      "-acodec", cameraConfig.talkbackSettings.typeFmt,
      "-flags", "+global_header",
      "-ar", cameraConfig.talkbackSettings.samplingRate.toString(),
      "-b:a", "64k",
      "-ac", cameraConfig.talkbackSettings.channels.toString(),
      "-f", "adts",
      "udp://" + cameraConfig.host + ":" + cameraConfig.talkbackSettings.bindPort.toString()
    ];

    // Additional logging, but only if we're debugging.
    if(this.platform.verboseFfmpeg) {
      ffmpegReturnAudioCmd.push("-loglevel", "level+verbose");
    }

    if(this.platform.config.debugAll) {
      ffmpegReturnAudioCmd.push("-loglevel", "level+debug");
    }

    const ffmpegReturnAudio = new FfmpegProcess(this, request.sessionID, ffmpegReturnAudioCmd);

    // Housekeeping for the twoway FFmpeg session.
    this.ongoingSessions[request.sessionID].ffmpeg.push(ffmpegReturnAudio);

    // Feed the SDP session description to ffmpeg on stdin.
    ffmpegReturnAudio.getStdin()?.write(sdpReturnAudio);
    ffmpegReturnAudio.getStdin()?.end();
  }

  // Process incoming stream requests.
  public handleStreamRequest(request: StreamingRequest, callback: StreamRequestCallback): void {

    switch(request.type) {
      case StreamRequestTypes.START:
        this.startStream(request, callback);
        break;

      case StreamRequestTypes.RECONFIGURE:
        // Once ffmpeg is updated to support this, we'll enable this one.
        this.debug("%s: Ignoring request to reconfigure: %sx%s, %s fps, %s kbps.",
          this.name(), request.video.width, request.video.height, request.video.fps, request.video.max_bit_rate);
        callback();
        break;

      case StreamRequestTypes.STOP:
      default:
        this.stopStream(request.sessionID);
        callback();
        break;
    }
  }

  // Take a snapshot.
  public async getSnapshot(request?: SnapshotRequest): Promise<Buffer | null> {

    const cameraConfig = this.protectCamera.accessory.context.camera as ProtectCameraConfig;
    const params = new URLSearchParams({ force: "true" });

    // If we aren't connected, we're done.
    if(cameraConfig.state !== "CONNECTED") {
      this.log.error("%s: Unable to retrieve snapshot - the camera is offline or unavailable.", this.name());
      return null;
    }

    // If we have details of the snapshot request, use it to request the right size.
    if(request) {
      params.append("width", request.width.toString());
      params.append("height", request.height.toString());
    }

    // Occasional snapshot failures will happen. The controller isn't always able to generate them if
    // it's already generating one, or it's requested too quickly after the last one.

    // Request the image from the controller.
    const response = await this.protectCamera.nvr.nvrApi.fetch(this.protectCamera.snapshotUrl + "?" + params.toString(), { method: "GET" }, true, false);

    if(!response?.ok) {
      this.log.error("%s: Unable to retrieve snapshot.", this.name());
      return null;
    }

    try {

      // Process and return the image.
      return await response.buffer();

    } catch(error) {

      this.log.error("%s: An error occurred while making a snapshot request: %s.", this.name(), error);
      return null;
    }
  }

  // Close a video stream.
  public stopStream(sessionId: string): void {

    try {

      // Stop any FFmpeg instances we have running.
      if(this.ongoingSessions[sessionId]) {
        for(const ffmpegProcess of this.ongoingSessions[sessionId].ffmpeg) {
          ffmpegProcess.stop();
        }
      }

      // Close the demuxer, if we have one.
      this.ongoingSessions[sessionId]?.rtpDemuxer?.close();

      // Delete the entries.
      delete this.pendingSessions[sessionId];
      delete this.ongoingSessions[sessionId];

      // Inform the user.
      this.log.info("%s: Stopped video streaming session.", this.name());

    } catch(error) {

      this.log.error("%s: Error occurred while ending the FFmpeg video processes: %s.", this.name(), error);
    }
  }

  // Shutdown all our video streams.
  public shutdown(): void {
    for(const session of Object.keys(this.ongoingSessions)) {
      this.stopStream(session);
    }
  }

  // Temporarily increase the verbosity of FFmpeg output for end users.
  public setVerboseFfmpeg(): void {

    // If we're already increased our logging, we're done.
    if(this.platform.verboseFfmpeg || this.verboseFfmpegTimer) {
      return;
    }

    // Set a timer to revert back to normal behavior.
    this.verboseFfmpegTimer = setTimeout(() => {
      this.platform.verboseFfmpeg = false;
      this.log.info("Returning FFmpeg logging output to normal levels.");

      // Clear out the old timer.
      this.verboseFfmpegTimer = null;
    }, PROTECT_FFMPEG_VERBOSE_DURATION * 60 * 1000);

    this.log.info("FFmpeg exited unexpectedly." +
      " Increasing logging output of FFmpeg for the next %s minutes to provide additional detail for future attempts to stream video.", PROTECT_FFMPEG_VERBOSE_DURATION);

    this.platform.verboseFfmpeg = true;
  }
}
