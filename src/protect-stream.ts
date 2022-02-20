/* Copyright(C) 2017-2022, HJD (https://github.com/hjdhjd). All rights reserved.
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
import { FetchError, ProtectCameraConfig } from "unifi-protect";
import {
  PROTECT_FFMPEG_AUDIO_FILTER_HIGHPASS,
  PROTECT_FFMPEG_AUDIO_FILTER_LOWPASS,
  PROTECT_HKSV_BUFFER_LENGTH,
  PROTECT_HKSV_SEGMENT_LENGTH
} from "./settings";
import { ProtectCamera, RtspEntry } from "./protect-camera";
import { FfmpegStreamingProcess } from "./protect-ffmpeg-stream";
import { ProtectOptions } from "./protect-options";
import { ProtectPlatform } from "./protect-platform";
import { ProtectRecordingDelegate } from "./protect-record";
import { RtpDemuxer } from "./protect-rtp";
import WebSocket from "ws";
import ffmpegPath from "ffmpeg-for-homebridge";
import { reservePorts } from "@homebridge/camera-utils";

// Increase the listener limits to support Protect installations with more than 10 cameras. 100 seems like a reasonable default.
// eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-unsafe-member-access
require("events").EventEmitter.defaultMaxListeners = 100;

type SessionInfo = {
  address: string; // Address of the HomeKit client.
  addressVersion: string;

  videoPort: number;
  videoReturnPort: number;
  videoCryptoSuite: SRTPCryptoSuites; // This should be saved if multiple suites are supported.
  videoSRTP: Buffer; // Key and salt concatenated.
  videoSSRC: number; // RTP synchronisation source.

  hasLibFdk: boolean; // Does the user have a version of FFmpeg that supports AAC?
  audioPort: number;
  audioIncomingRtcpPort: number;
  audioIncomingRtpPort: number; // Port to receive audio from the HomeKit microphone.
  rtpDemuxer: RtpDemuxer | null; // RTP demuxer needed for two-way audio.
  talkBack: string | null; // Talkback websocket needed for two-way audio.
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
  public hksv: ProtectRecordingDelegate | null;
  public readonly log: Logging;
  public readonly name: () => string;
  private ongoingSessions: { [index: string]: { ffmpeg: FfmpegStreamingProcess[], rtpDemuxer: RtpDemuxer | null } };
  private pendingSessions: { [index: string]: SessionInfo };
  public readonly platform: ProtectPlatform;
  public readonly protectCamera: ProtectCamera;
  private rtspEntry: RtspEntry | null;
  private savedBitrate: number;
  private snapshotCache: { [index: string]: { image: Buffer, time: number } };
  public verboseFfmpeg: boolean;
  public readonly videoEncoder!: string;
  public readonly videoProcessor: string;

  constructor(protectCamera: ProtectCamera, resolutions: [number, number, number][]) {

    this.api = protectCamera.api;
    this.config = protectCamera.platform.config;
    this.debug = protectCamera.platform.debug.bind(protectCamera.platform);
    this.hap = protectCamera.api.hap;
    this.hksv = null;
    this.log = protectCamera.platform.log;
    this.name = protectCamera.name.bind(protectCamera);
    this.ongoingSessions = {};
    this.protectCamera = protectCamera;
    this.pendingSessions = {};
    this.platform = protectCamera.platform;
    this.rtspEntry = null;
    this.savedBitrate = 0;
    this.snapshotCache = {};
    this.verboseFfmpeg = false;
    this.videoEncoder = this.config.videoEncoder || "libx264";
    this.videoProcessor = this.config.videoProcessor || ffmpegPath || "ffmpeg";

    // Setup for HKSV, if enabled.
    if(this.protectCamera.isHksv) {
      this.hksv = new ProtectRecordingDelegate(protectCamera);
    }

    // Setup for our camera controller.
    const options: CameraControllerOptions = {

      // HomeKit requires at least 2 streams, and HomeKit Secure Video requires 1.
      cameraStreamCount: 10,

      // Our streaming delegate - aka us.
      delegate: this,

      // Our recording capabilities for HomeKit Secure Video.
      recording: !this.protectCamera.isHksv ? undefined : {

        delegate: this.hksv as ProtectRecordingDelegate,

        options: {

          audio: {

            codecs: [
              {

                // Protect supports a 48 KHz sampling rate, and the low complexity AAC profile.
                samplerate: this.api.hap.AudioRecordingSamplerate.KHZ_48,
                type: this.api.hap.AudioRecordingCodecType.AAC_LC
              }
            ]
          },

          mediaContainerConfiguration: [
            {

              // The default HKSV segment length is 4000ms. It turns out that any setting less than that will disable
              // HomeKit Secure Video.
              fragmentLength: PROTECT_HKSV_SEGMENT_LENGTH,
              type: this.api.hap.MediaContainerType.FRAGMENTED_MP4
            }
          ],

          // Maximum prebuffer length supported. In Protect, this is effectively unlimited, but HomeKit only seems to
          // request a maximum of a 4000ms prebuffer.
          prebufferLength: PROTECT_HKSV_BUFFER_LENGTH,

          video: {

            parameters: {

              // Through admittedly anecdotal testing on various G3 and G4 models, UniFi Protect seems to support
              // only the H.264 Main profile, though it does support various H.264 levels, ranging from Level 3
              // through Level 5.1 (G4 Pro at maximum resolution). However, HomeKit only supports Level 3.1, 3.2,
              // and 4.0 currently.
              levels: [this.hap.H264Level.LEVEL3_1, this.hap.H264Level.LEVEL3_2, this.hap.H264Level.LEVEL4_0],
              profiles: [ this.hap.H264Profile.MAIN ]
            },

            resolutions: resolutions,

            type: this.api.hap.VideoCodecType.H264
          }
        }
      },

      // Our motion sensor.
      sensors: !this.protectCamera.isHksv ? undefined : {

        motion: this.protectCamera.accessory.getService(this.hap.Service.MotionSensor)
      },

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
            // Through admittedly anecdotal testing on various G3 and G4 models, UniFi Protect seems to support
            // only the H.264 Main profile, though it does support various H.264 levels, ranging from Level 3
            // through Level 5.1 (G4 Pro at maximum resolution). However, HomeKit only supports Level 3.1, 3.2,
            // and 4.0 currently.
            levels: [this.hap.H264Level.LEVEL3_1, this.hap.H264Level.LEVEL3_2, this.hap.H264Level.LEVEL4_0],
            profiles: [ this.hap.H264Profile.MAIN ]
          },

          // Retrieve the list of supported resolutions from the camera and apply our best guesses for how to
          // map specific resolutions to the available RTSP streams on a camera. Unfortunately, this creates
          // challenges in doing on-the-fly RTSP changes in UniFi Protect. Once the list of supported
          // resolutions is set here, there's no going back unless a user reboots. Homebridge doesn't have a way
          // to dynamically adjust the list of supported resolutions at this time.
          resolutions: resolutions
        }
      }
    };

    this.controller = new this.hap.CameraController(options);
  }

  // HomeKit image snapshot request handler.
  public async handleSnapshotRequest(request?: SnapshotRequest, callback?: SnapshotRequestCallback): Promise<void> {

    const snapshot = await this.getSnapshot(request);

    // No snapshot was returned - we're done here.
    if(!snapshot) {

      if(callback) {
        callback(new Error(this.name() + ": Unable to retrieve a snapshot"));
      }

      return;
    }

    // Return the image to HomeKit.
    if(callback) {
      callback(undefined, snapshot);
    }

    // Publish the snapshot as a data URL to MQTT, if configured.
    this.protectCamera.nvr.mqtt?.publish(this.protectCamera.accessory, "snapshot", "data:image/jpeg;base64," + snapshot.toString("base64"));
  }

  // Prepare to launch the video stream.
  public async prepareStream(request: PrepareStreamRequest, callback: PrepareStreamCallback): Promise<void> {

    const cameraConfig = this.protectCamera.accessory.context.device as ProtectCameraConfig;

    // Check if audio support is enabled.
    const isAudioEnabled = this.protectCamera.nvr.optionEnabled(cameraConfig, "Audio", true, request.targetAddress);

    // We need to check for AAC support because it's going to determine whether we support audio.
    const hasLibFdk = isAudioEnabled && (await FfmpegStreamingProcess.codecEnabled(this.videoProcessor, "libfdk_aac", this.log));

    // Setup our audio plumbing.
    const audioIncomingRtcpPort = (await reservePorts({ count: 1 }))[0];
    const audioIncomingPort = (hasLibFdk && this.protectCamera.twoWayAudio) ? (await reservePorts({ count: 1 }))[0] : -1;
    const audioIncomingRtpPort = (hasLibFdk && this.protectCamera.twoWayAudio) ? (await reservePorts({ count: 2 }))[0] : -1;
    const audioSSRC = this.hap.CameraController.generateSynchronisationSource();

    if(!hasLibFdk) {
      this.log.info("%s: Audio support disabled.%s", this.name(),
        isAudioEnabled ? " A version of FFmpeg that is compiled with fdk_aac support is required to support audio." : "");
    }

    let rtpDemuxer = null;
    let talkBack = null;

    if(hasLibFdk && this.protectCamera.twoWayAudio) {

      // Setup the RTP demuxer for two-way audio scenarios.
      rtpDemuxer = new RtpDemuxer(this, request.addressVersion, audioIncomingPort, audioIncomingRtcpPort, audioIncomingRtpPort);

      // Request the talkback websocket from the controller.
      const params = new URLSearchParams({ camera: cameraConfig.id });
      talkBack = await this.protectCamera.nvr.nvrApi.getWsEndpoint(this.protectCamera.nvr.nvrApi.wsUrl() + "/talkback?" + params.toString());

      // Something went wrong and we don't have a talkback websocket.
      if(!talkBack) {

        this.log.error("%s: Unable to open the return audio channel.", this.name());
      }
    }

    // Setup our video plumbing.
    const videoReturnPort = (await reservePorts({ count: 1 }))[0];
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
      talkBack: talkBack,

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
  private async startStream(request: StartStreamRequest, callback: StreamRequestCallback): Promise<void> {

    const cameraConfig = this.protectCamera.accessory.context.device as ProtectCameraConfig;
    const sessionInfo = this.pendingSessions[request.sessionID];
    const sdpIpVersion = sessionInfo.addressVersion === "ipv6" ? "IP6 ": "IP4";

    // If we aren't connected, we're done.
    if(cameraConfig.state !== "CONNECTED") {
      const errorMessage = "Unable to start video stream: the camera is offline or unavailable.";

      this.log.error("%s: %s", this.name(), errorMessage);
      callback(new Error(this.name() + ": " + errorMessage));
      return;
    }

    // Find the best RTSP stream based on what we're looking for.
    this.rtspEntry = this.protectCamera.findRtsp(request.video.width, request.video.height, cameraConfig, sessionInfo.address);

    if(!this.rtspEntry) {

      const errorMessage = "Unable to start video stream: no valid RTSP stream profile was found.";

      this.log.error("%s: %s %sx%s, %s fps, %s kbps.", this.name(), errorMessage,
        request.video.width, request.video.height, request.video.fps, request.video.max_bit_rate);

      callback(new Error(this.name() + ": " + errorMessage));
      return;
    }

    // Save our current bitrate before we modify it, but only if we're the first stream to catch concurrent streaming clients.
    if(!this.savedBitrate) {

      this.savedBitrate = this.protectCamera.getBitrate(this.rtspEntry.channel.id);

      if(this.savedBitrate < 0) {

        this.savedBitrate = 0;
      }
    }

    // Set the desired bitrate in Protect. We don't need to for this to return, because Protect
    // will adapt the stream once it processes the configuration change.
    await this.protectCamera.setBitrate(this.rtspEntry.channel.id, request.video.max_bit_rate * 1000);

    // Are we transcoding?
    const isTranscoding = this.protectCamera.nvr.optionEnabled(cameraConfig, "Video.Transcode", false, sessionInfo.address);

    // Set our packet size to be 564. Why? MPEG transport stream (TS) packets are 188 bytes in size each.
    // These packets transmit the video data that you ultimately see on your screen and are transmitted using
    // UDP. Each UDP packet is 1316 bytes in size, before being encapsulated in IP. We want to get as many
    // TS packets as we can, within reason, in those UDP packets. This translates to 1316 / 188 = 7 TS packets
    // as a limit of what can be pushed through a single UDP packet. Here's the problem...you need to have
    // enough data to fill that pipe, all the time. Network latency, FFmpeg overhead, and the speed / quality of
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

    // -hide_banner                     Suppress printing the startup banner in FFmpeg.
    // -probesize 2048                  How many bytes should be analyzed for stream information. We default to to analyze time should be spent analyzing
    //                                  the input stream, in microseconds.
    // -max_delay 500000                Set an upper limit on how much time FFmpeg can take in demuxing packets.
    // -fflags +flush_packets+nobuffer  Set format flags to ensure that packets are written out immediately and that latency due to buffering is reduced.
    // -flush_packets 1                 Flush the underlying I/O stream after each packet to further reduce latency.
    // -r fps                           Set the input frame rate for the video stream.
    // -rtsp_transport tcp              Tell the RTSP stream handler that we're looking for a TCP connection.
    // -i this.rtspEntry.url            RTSPS URL to get our input stream from.
    // -map 0:v                         selects the first available video track from the stream. Protect actually maps audio
    //                                  and video tracks in opposite locations from where FFmpeg typically expects them. This
    //                                  setting is a more general solution than naming the track locations directly in case
    //                                  Protect changes this in the future.
    //                                  Yes, we included these above as well: they need to be included for every I/O stream to maximize effectiveness it seems.
    // -fflags +flush_packets+nobuffer  Set format flags to ensure that packets are written out immediately and that latency due to buffering is reduced.
    // -flush_packets 1                 Flush the underlying I/O stream after each packet to further reduce latency.
    const ffmpegArgs = [

      "-hide_banner",
      "-probesize", "2048",
      "-max_delay", "500000",
      "-fflags", "+flush_packets+nobuffer",
      "-flush_packets", "1",
      "-r", this.rtspEntry.channel.fps.toString(),
      "-rtsp_transport", "tcp",
      "-i", this.rtspEntry.url,
      "-map", "0:v",
      "-fflags", "+flush_packets+nobuffer",
      "-flush_packets", "1"
    ];

    // Inform the user.
    this.log.info("%s: Streaming request from %s: %sx%s@%sfps, %s kbps. %s %s, %s kbps.",
      this.name(), sessionInfo.address, request.video.width, request.video.height, request.video.fps, request.video.max_bit_rate,
      isTranscoding ? "Transcoding" : "Using", this.rtspEntry.name, this.rtspEntry.channel.bitrate / 1000);

    // Check to see if we're transcoding. If we are, set the right FFmpeg encoder options. If not, copy the video stream.
    if(isTranscoding) {

      // Configure our video parameters for transcoding:
      //
      // -vcodec libx264     Copy the stream withour reencoding it.
      // -pix_fmt yuvj420p   Use the yuvj420p pixel format, which is what Protect uses.
      // -profile:v high     Use the H.264 high profile when encoding, which provides for better stream quality and size efficiency.
      // -preset veryfast    Use the veryfast encoding preset in libx264, which provides a good balance of encoding speed and quality.
      // -bf 0               Disable B-frames when encoding to increase compatibility against occasionally finicky HomeKit clients.
      // -b:v bitrate        The average bitrate to use for this stream. This is specified by HomeKit.
      // -bufsize size       This is the decoder buffer size, which drives the variability / quality of the output bitrate.
      // -maxrate bitrate    The maximum bitrate tolerance, used with -bufsize. We set this to max_bit_rate to effectively
      //                     create a constant bitrate.
      // -filter:v fps=fps=  Use the fps filter to get to the frame rate requested by HomeKit. This has better performance characteristics
      //                     for Protect rather than using "-r".
      ffmpegArgs.push(

        "-vcodec", this.videoEncoder,
        "-pix_fmt", "yuvj420p",
        "-profile:v", "high",
        "-preset", "veryfast",
        "-bf", "0",
        "-b:v", request.video.max_bit_rate.toString() + "k",
        "-bufsize", (2 * request.video.max_bit_rate).toString() + "k",
        "-maxrate", request.video.max_bit_rate.toString() + "k",
        "-filter:v", "fps=fps=" + request.video.fps.toString()
      );

    } else {

      // Configure our video parameters for just copying the input stream from Protect - it tends to be quite solid in most cases:
      //
      // -vcodec copy        Copy the stream withour reencoding it.
      ffmpegArgs.push(

        "-vcodec", "copy"
      );
    }

    // Add in any user-specified options for FFmpeg.
    if(this.platform.config.ffmpegOptions) {

      ffmpegArgs.push(...this.platform.config.ffmpegOptions);
    }

    // Configure our video parameters for SRTP streaming:
    //
    // -fflags +flush_packets+nobuffer  Set format flags to ensure that packets are written out immediately and that latency due to buffering is reduced.
    // -flush_packets 1                 Flush the underlying I/O stream after each packet to further reduce latency.
    // -payload_type num                Payload type for the RTP stream. This is negotiated by HomeKit and is usually 99 for H.264 video.
    // -ssrc                            Synchronization source stream identifier. Random number negotiated by HomeKit to identify this stream.
    // -f rtp                           Specify that we're using the RTP protocol.
    // -srtp_out_suite enc              Specify the output encryption encoding suites.
    // -srtp_out_params params          Specify the output encoding parameters. This is negotiated by HomeKit.
    ffmpegArgs.push(

      "-fflags", "+flush_packets+nobuffer",
      "-flush_packets", "1",
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
    // -map 0:a                         Selects the first available audio track from the stream. Protect actually maps audio
    //                                  and video tracks in opposite locations from where FFmpeg typically expects them. This
    //                                  setting is a more general solution than naming the track locations directly in case
    //                                  Protect changes this in the future.
    // -acodec libfdk_aac               Encode to AAC.
    // -profile:a aac_eld               Specify enhanced, low-delay AAC for HomeKit.
    // -flags +global_header            Sets the global header in the bitstream.
    // -fflags +flush_packets+nobuffer  Set format flags to ensure that packets are written out immediately and that latency due to buffering is reduced.
    // -flush_packets 1                 Flush the underlying I/O stream after each packet to further reduce latency.
    // -f null                          Null filter to pass the audio unchanged without running through a muxing operation.
    // -ar samplerate                   Sample rate to use for this audio. This is specified by HomeKit.
    // -b:a bitrate                     Bitrate to use for this audio. This is specified by HomeKit.
    // -bufsize size                    This is the decoder buffer size, which drives the variability / quality of the output bitrate.
    // -ac 1                            Set the number of audio channels to 1.
    if(sessionInfo.hasLibFdk) {

      // Configure our audio parameters.
      ffmpegArgs.push(

        "-map", "0:a",
        "-acodec", "libfdk_aac",
        "-profile:a", "aac_eld",
        "-flags", "+global_header",
        "-fflags", "+flush_packets+nobuffer",
        "-flush_packets", "1",
        "-f", "null",
        "-ar", request.audio.sample_rate.toString() + "k",
        "-b:a", request.audio.max_bit_rate.toString() + "k",
        "-bufsize", (2 * request.audio.max_bit_rate).toString() + "k",
        "-ac", "1"
      );

      // If we are audio filtering, address it here.
      if(this.protectCamera.nvr.optionEnabled(cameraConfig, "Audio.Filter.Noise", false, sessionInfo.address)) {

        let highpass;
        let lowpass;

        // See what the user has set for the highpass filter for this camera.
        highpass = parseInt(this.protectCamera.nvr.optionGet(cameraConfig, "Audio.Filter.Noise.HighPass", sessionInfo.address) ?? "");

        // If we have an invalid setting, use the defaults.
        if((highpass !== highpass) || (highpass < 0)) {
          highpass = PROTECT_FFMPEG_AUDIO_FILTER_HIGHPASS;
        }

        // See what the user has set for the highpass filter for this camera.
        lowpass = parseInt(this.protectCamera.nvr.optionGet(cameraConfig, "Audio.Filter.Noise.LowPass", sessionInfo.address) ?? "");

        // If we have an invalid setting, use the defaults.
        if((lowpass !== lowpass) || (lowpass < 0)) {
          lowpass = PROTECT_FFMPEG_AUDIO_FILTER_LOWPASS;
        }

        ffmpegArgs.push("-af", "highpass=f=" + highpass.toString() + ",lowpass=f=" + lowpass.toString());
      }

      // Add the required RTP settings and encryption for the stream:
      //
      // -fflags +flush_packets+nobuffer  Set format flags to ensure that packets are written out immediately and that latency due to buffering is reduced.
      // -flush_packets 1                 Flush the underlying I/O stream after each packet to further reduce latency.
      // -payload_type num                Payload type for the RTP stream. This is negotiated by HomeKit and is usually 110 for AAC-ELD audio.
      // -ssrc                            synchronization source stream identifier. Random number negotiated by HomeKit to identify this stream.
      // -f rtp                           Specify that we're using the RTP protocol.
      // -srtp_out_suite enc              Specify the output encryption encoding suites.
      // -srtp_out_params params          Specify the output encoding parameters. This is negotiated by HomeKit.
      ffmpegArgs.push(

        "-fflags", "+flush_packets+nobuffer",
        "-flush_packets", "1",
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
    if(this.platform.verboseFfmpeg || this.verboseFfmpeg) {

      ffmpegArgs.push("-loglevel", "level+verbose");
    }

    if(this.platform.config.debugAll) {

      ffmpegArgs.push("-loglevel", "level+debug");
    }

    // Combine everything and start an instance of FFmpeg.
    const ffmpegStream = new FfmpegStreamingProcess(this, request.sessionID, ffmpegArgs,
      (sessionInfo.hasLibFdk && this.protectCamera.twoWayAudio) ? undefined : { addressVersion: sessionInfo.addressVersion, port: sessionInfo.videoReturnPort },
      callback);

    // Some housekeeping for our FFmpeg and demuxer sessions.
    this.ongoingSessions[request.sessionID] = { ffmpeg: [ ffmpegStream ], rtpDemuxer: sessionInfo.rtpDemuxer };
    delete this.pendingSessions[request.sessionID];

    // If we aren't doing two-way audio, we're done here. For two-way audio...we have some more plumbing to do.
    if(!sessionInfo.hasLibFdk || !this.protectCamera.twoWayAudio) {

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
    // b             Bandwidth information - application specific, 24k.
    // a=rtpmap      Payload type 110 corresponds to an MP4 stream.
    // a=fmtp        For payload type 110, use these format parameters.
    // a=crypto      Crypto suite to use for this session.
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
    // -protocol_whitelist    Set the list of allowed protocols for this FFmpeg session.
    // -f sdp                 Specify that our input will be an SDP file.
    // -acodec libfdk_aac     Decode AAC input.
    // -i pipe:0              Read input from standard input.
    // -map 0:a               Selects the first available audio track from the stream.
    // -acodec aac            Encode to AAC. This is set by Protect.
    // -fflags +flush_packets+nobuffer  Set format flags to ensure that packets are written out immediately and that latency due to buffering is reduced.
    // -flush_packets 1                 Flush the underlying I/O stream after each packet to further reduce latency.
    // -flags +global_header  Sets the global header in the bitstream.
    // -ar samplerate         Sample rate to use for this audio. This is specified by Protect.
    // -b:a bitrate           Bitrate to use for this audio. This is specified by Protect.
    // -ac 1                  Set the number of audio channels to 1. This is specified by Protect.
    // -f adts                Transmit an ADTS stream.
    // pipe:1                 Output the ADTS stream to standard output.
    const ffmpegReturnAudioCmd = [

      "-protocol_whitelist", "pipe,udp,rtp,file,crypto",
      "-f", "sdp",
      "-acodec", "libfdk_aac",
      "-ac", cameraConfig.talkbackSettings.channels.toString(),
      "-i", "pipe:0",
      "-acodec", cameraConfig.talkbackSettings.typeFmt,
      "-fflags", "flush_packets",
      "-flush_packets", "1",
      "-flags", "+global_header",
      "-ar", cameraConfig.talkbackSettings.samplingRate.toString(),
      "-b:a", "64k",
      "-f", "adts",
      "pipe:1"
    ];

    // Additional logging, but only if we're debugging.
    if(this.platform.verboseFfmpeg || this.verboseFfmpeg) {

      ffmpegReturnAudioCmd.push("-loglevel", "level+verbose");
    }

    if(this.platform.config.debugAll) {

      ffmpegReturnAudioCmd.push("-loglevel", "level+debug");
    }

    try {

      // Now it's time to talkback.
      let ws: WebSocket | null = null;
      let isTalkbackLive = false;
      let dataListener: (data: Buffer) => void;
      let openListener: () => void;

      if(sessionInfo.talkBack) {

        // Open the talkback connection.
        ws = new WebSocket(sessionInfo.talkBack, { rejectUnauthorized: false });
        isTalkbackLive = true;

        // Catch any errors and inform the user, if needed.
        ws?.once("error", (error) => {

          // Ignore timeout errors, but notify the user about anything else.
          if((error as NodeJS.ErrnoException).code !== "ETIMEDOUT") {

            this.log.error("%s: Error in communicating with the return audio channel: %s", this.name(), error);
          }

          ws?.terminate();
        });

        // Catch any stray open events after we've closed.
        ws?.on("open", openListener = (): void => {

          // If we've somehow opened after we've wrapped up talkback, terminate the connection.
          if(!isTalkbackLive) {

            ws?.terminate();
          }
        });

        // Cleanup after ourselves on close.
        ws?.once("close", () => {

          ws?.removeListener("open", openListener);
        });
      }

      // Fire up FFmpeg.
      const ffmpegReturnAudio = new FfmpegStreamingProcess(this, request.sessionID, ffmpegReturnAudioCmd);

      // Setup housekeeping for the twoway FFmpeg session.
      this.ongoingSessions[request.sessionID].ffmpeg.push(ffmpegReturnAudio);

      // This is an unfortunate, but necessary, workaround for low-power systems that struggle to keep up at times. Writing the
      // SDP header through stdin creates a small race condition - namely that we need to wait for FFmpeg to be completely
      // ready to take input via stdin before we give it the SDP description through stdin. It's possible to launch the FFmpeg
      // process and complete this write sequence before stdin is actually up and running on FFmpeg. Waiting for a small amount
      // of time to write to stdin, allows us to try to wait more effectively FFmpeg to be ready before sending the SDP description.
      setTimeout(() => {

        // Feed the SDP session description to FFmpeg on stdin.
        ffmpegReturnAudio.stdin?.end(sdpReturnAudio + "\n");
      }, 100);

      // Send the audio.
      ffmpegReturnAudio.stdout?.on("data", dataListener = (data: Buffer): void => {

        ws?.send(data, (error: Error | undefined): void => {

          // This happens when an error condition is encountered on sending data to the websocket.
          // We assume the worst and close our talkback channel.
          if(error) {

            ws?.terminate();
          }
        });
      });

      // Make sure we terminate the talkback websocket when we're done.
      ffmpegReturnAudio.ffmpegProcess?.once("exit", () => {

        // Make sure we catch any stray connections that may be too slow to open.
        isTalkbackLive = false;

        // Close the websocket.
        if((ws?.readyState === WebSocket.CLOSING) || (ws?.readyState === WebSocket.OPEN)) {

          ws?.terminate();
        }

        ffmpegReturnAudio.stdout?.removeListener("data", dataListener);
      });
    } catch(error) {

      this.log.error("%s: Unable to connect to the return audio channel: %s", this.name(), error);
    }
  }

  // Process incoming stream requests.
  public async handleStreamRequest(request: StreamingRequest, callback: StreamRequestCallback): Promise<void> {

    switch(request.type) {

      case StreamRequestTypes.START:

        await this.startStream(request, callback);
        break;

      case StreamRequestTypes.RECONFIGURE:

        // Once FFmpeg is updated to support this, we'll enable this one.
        this.log.info("%s: Streaming parameters adjustment requested by HomeKit: %sx%s, %s fps, %s kbps.",
          this.name(), request.video.width, request.video.height, request.video.fps, request.video.max_bit_rate);

        // Set the desired bitrate in Protect.
        if(this.rtspEntry) {

          await this.protectCamera.setBitrate(this.rtspEntry.channel.id, request.video.max_bit_rate * 1000);
        }

        callback();
        break;

      case StreamRequestTypes.STOP:
      default:

        await this.stopStream(request.sessionID);
        callback();
        break;
    }
  }

  // Retrieve a cached snapshot, if available.
  private getCachedSnapshot(cameraMac: string): Buffer | null {

    // If we have an image from the last few seconds, we can use it. Otherwise, we're done.
    if(!this.snapshotCache[cameraMac] || ((Date.now() - this.snapshotCache[cameraMac].time) > (60 * 1000))) {
      delete this.snapshotCache[cameraMac];
      return null;
    }

    return this.snapshotCache[cameraMac].image;
  }

  // Take a snapshot.
  private async getSnapshot(request?: SnapshotRequest): Promise<Buffer | null> {

    const cameraConfig = this.protectCamera.accessory.context.device as ProtectCameraConfig;
    const params = new URLSearchParams({ force: "true" });

    // If we aren't connected, we're done.
    if(cameraConfig.state !== "CONNECTED") {
      this.log.error("%s: Unable to retrieve a snapshot: the camera is offline or unavailable.", this.name());
      return null;
    }

    // If we have details of the snapshot request, use it to request the right size.
    if(request) {
      params.append("width", request.width.toString());
      params.append("height", request.height.toString());
    }

    // Request the image from the controller.
    const response = await this.protectCamera.nvr.nvrApi.fetch(this.protectCamera.snapshotUrl + "?" + params.toString(), { method: "GET" }, true, false);

    // Occasional snapshot failures will happen. The controller isn't always able to generate them if
    // it's already generating one, or it's requested too quickly after the last one.
    if(!response?.ok) {

      // See if we have an image cached that we can use instead.
      const cachedSnapshot = this.getCachedSnapshot(cameraConfig.mac);

      if(cachedSnapshot) {
        this.log.error("%s: Unable to retrieve a snapshot. Using the most recent cached snapshot instead.", this.name());
        return cachedSnapshot;
      }

      this.log.error("%s: Unable to retrieve a snapshot.%s",
        this.name(),
        response ? " " + response.status.toString() + " - " + response.statusText + "." : "");

      return null;
    }

    try {

      // Retrieve the image.
      this.snapshotCache[cameraConfig.mac] = { image: Buffer.from(await response.arrayBuffer()), time: Date.now() };
      return this.snapshotCache[cameraConfig.mac].image;

    } catch(error) {

      if(error instanceof FetchError) {
        let cachedSnapshot;

        switch(error.code) {
          case "ERR_STREAM_PREMATURE_CLOSE":

            cachedSnapshot = this.getCachedSnapshot(cameraConfig.mac);

            if(cachedSnapshot) {
              this.log.error("%s: Unable to retrieve a snapshot. Using a cached snapshot instead.", this.name());
              return cachedSnapshot;
            }

            this.log.error("%s: Unable to retrieve a snapshot: the Protect controller closed the connection prematurely.", this.name());
            return null;
            break;

          default:
            this.log.error("%s: Unknown error: %s", this.name(), error.message);
            return null;
            break;
        }
      }

      this.log.error("%s: An error occurred while making a snapshot request: %s.", this.name(), error);
      return null;
    }
  }

  // Close a video stream.
  public async stopStream(sessionId: string): Promise<void> {

    try {

      // Stop any FFmpeg instances we have running.
      if(this.ongoingSessions[sessionId]) {

        for(const ffmpegProcess of this.ongoingSessions[sessionId].ffmpeg) {
          ffmpegProcess.stop();
        }

        // Close the demuxer, if we have one.
        this.ongoingSessions[sessionId].rtpDemuxer?.close();

        // Inform the user.
        this.log.info("%s: Stopped video streaming session.", this.name());
      }

      // Delete the entries.
      delete this.pendingSessions[sessionId];
      delete this.ongoingSessions[sessionId];

      // If we've completed all streaming sessions, restore any changed settings, such as bitrate, for HomeKit Secure Video.
      if(!this.ongoingSessions.length) {

        if(this.hksv?.isRecording) {

          // Restore HKSV settings.
          await this.hksv.updateRecordingActive(this.hksv.isRecording);
        } else if(this.savedBitrate) {

          // Restore our original bitrate.
          if(this.rtspEntry) {

            await this.protectCamera.setBitrate(this.rtspEntry.channel.id, this.savedBitrate);
          }

          this.savedBitrate = 0;
        }
      }

    } catch(error) {

      this.log.error("%s: Error occurred while ending the FFmpeg video processes: %s.", this.name(), error);
    }
  }

  // Shutdown all our video streams.
  public async shutdown(): Promise<void> {

    for(const session of Object.keys(this.ongoingSessions)) {

      // eslint-disable-next-line no-await-in-loop
      await this.stopStream(session);
    }
  }
}
