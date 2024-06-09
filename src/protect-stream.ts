/* Copyright(C) 2017-2024, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-stream.ts: Homebridge camera streaming delegate implementation for Protect.
 *
 * This module is heavily inspired by the homebridge and homebridge-camera-ffmpeg source code. Thank you for your contributions to the HomeKit world.
 */
import { API, AudioRecordingCodecType, AudioRecordingSamplerate, AudioStreamingCodecType, AudioStreamingSamplerate, CameraController,
  CameraControllerOptions, CameraStreamingDelegate, H264Level, H264Profile, HAP, MediaContainerType, PrepareStreamCallback, PrepareStreamRequest, PrepareStreamResponse,
  SRTPCryptoSuites, SnapshotRequest, SnapshotRequestCallback, StartStreamRequest, StreamRequestCallback, StreamRequestTypes, StreamingRequest } from "homebridge";
import { FfmpegOptions, FfmpegStreamingProcess } from "./ffmpeg/index.js";
import { HomebridgePluginLogging, RtpDemuxer } from "homebridge-plugin-utils";
import { PROTECT_FFMPEG_AUDIO_FILTER_FFTNR, PROTECT_HKSV_SEGMENT_LENGTH, PROTECT_HKSV_TIMESHIFT_BUFFER_MAXLENGTH, PROTECT_HOMEKIT_IDR_INTERVAL } from "./settings.js";
import { ProtectCamera } from "./devices/index.js";
import { ProtectNvr } from "./protect-nvr.js";
import { ProtectPlatform } from "./protect-platform.js";
import { ProtectRecordingDelegate } from "./protect-record.js";
import { ProtectSnapshot } from "./protect-snapshot.js";
import WebSocket from "ws";
import { once } from "node:events";

type SessionInfo = {

  address: string; // Address of the HomeKit client.
  addressVersion: string;

  audioCryptoSuite: SRTPCryptoSuites;
  audioIncomingRtcpPort: number;
  audioIncomingRtpPort: number; // Port to receive audio from the HomeKit microphone.
  audioPort: number;
  audioSRTP: Buffer;
  audioSSRC: number;

  hasAudioSupport: boolean; // Does the user have a version of FFmpeg that supports AAC-ELD?

  rtpDemuxer: RtpDemuxer | null; // RTP demuxer needed for two-way audio.
  rtpPortReservations: number[]; // RTP port reservations.

  talkBack: string | null; // Talkback websocket needed for two-way audio.

  videoCryptoSuite: SRTPCryptoSuites; // This should be saved if multiple suites are supported.
  videoPort: number;
  videoReturnPort: number;
  videoSRTP: Buffer; // Key and salt concatenated.
  videoSSRC: number; // RTP synchronisation source.
};

// Camera streaming delegate implementation for Protect.
export class ProtectStreamingDelegate implements CameraStreamingDelegate {

  private readonly api: API;
  public controller: CameraController;
  public readonly ffmpegOptions: FfmpegOptions;
  private readonly hap: HAP;
  public hksv: ProtectRecordingDelegate | null;
  public readonly log: HomebridgePluginLogging;
  private readonly nvr: ProtectNvr;
  private ongoingSessions: { [index: string]: { ffmpeg: FfmpegStreamingProcess[], rtpDemuxer: RtpDemuxer | null, rtpPortReservations: number[] } };
  private pendingSessions: { [index: string]: SessionInfo };
  public readonly platform: ProtectPlatform;
  public readonly protectCamera: ProtectCamera;
  private probesizeOverride: number;
  private probesizeOverrideCount: number;
  private probesizeOverrideTimeout?: NodeJS.Timeout;
  private snapshot: ProtectSnapshot;
  public verboseFfmpeg: boolean;
  private abTest = true;

  // Create an instance of a HomeKit streaming delegate.
  constructor(protectCamera: ProtectCamera, resolutions: [number, number, number][]) {

    this.api = protectCamera.api;
    this.hap = protectCamera.api.hap;
    this.hksv = null;
    this.log = protectCamera.log;
    this.nvr = protectCamera.nvr;
    this.ongoingSessions = {};
    this.protectCamera = protectCamera;
    this.pendingSessions = {};
    this.platform = protectCamera.platform;
    this.probesizeOverride = 0;
    this.probesizeOverrideCount = 0;
    this.verboseFfmpeg = false;

    // Configure our hardware acceleration support.
    this.ffmpegOptions = new FfmpegOptions(protectCamera);

    // Setup for HKSV, if enabled.
    if(this.protectCamera.hasHksv) {

      this.hksv = new ProtectRecordingDelegate(protectCamera);
    }

    // Configure our snapshot handler.
    this.snapshot = new ProtectSnapshot(protectCamera);

    // Setup for our camera controller.
    const options: CameraControllerOptions = {

      // HomeKit requires at least 2 streams, and HomeKit Secure Video requires 1.
      cameraStreamCount: 10,

      // Our streaming delegate - aka us.
      delegate: this,

      // Our recording capabilities for HomeKit Secure Video.
      recording: !this.protectCamera.hasHksv ? undefined : {

        delegate: this.hksv as ProtectRecordingDelegate,

        options: {

          audio: {

            codecs: [
              {

                // Protect supports a 48 KHz sampling rate, and the low complexity AAC profile.
                samplerate: AudioRecordingSamplerate.KHZ_48,
                type: AudioRecordingCodecType.AAC_LC
              }
            ]
          },

          mediaContainerConfiguration: [
            {

              // The default HKSV segment length is 4000ms. It turns out that any setting less than that will disable
              // HomeKit Secure Video.
              fragmentLength: PROTECT_HKSV_SEGMENT_LENGTH,
              type: MediaContainerType.FRAGMENTED_MP4
            }
          ],

          // Maximum prebuffer length supported. In Protect, this is effectively unlimited, but HomeKit only seems to
          // request a maximum of a 4000ms prebuffer.
          prebufferLength: PROTECT_HKSV_TIMESHIFT_BUFFER_MAXLENGTH,

          video: {

            parameters: {

              // Through admittedly anecdotal testing on various G3 and G4 models, UniFi Protect seems to support
              // only the H.264 Main profile, though it does support various H.264 levels, ranging from Level 3
              // through Level 5.1 (G4 Pro at maximum resolution). However, HomeKit only supports Level 3.1, 3.2,
              // and 4.0 currently.
              levels: [ H264Level.LEVEL3_1, H264Level.LEVEL3_2, H264Level.LEVEL4_0 ],
              profiles: [ H264Profile.MAIN ]
            },

            resolutions: resolutions,

            type: this.api.hap.VideoCodecType.H264
          }
        }
      },

      // Our motion sensor.
      sensors: !this.protectCamera.hasHksv ? undefined : {

        motion: this.protectCamera.accessory.getService(this.hap.Service.MotionSensor)
      },

      streamingOptions: {

        audio: {

          codecs: [

            {

              audioChannels: 1,
              bitrate: 0,
              samplerate: [ AudioStreamingSamplerate.KHZ_16, AudioStreamingSamplerate.KHZ_24 ],
              type: AudioStreamingCodecType.AAC_ELD
            }
          ],

          twoWayAudio: this.protectCamera.hints.twoWayAudio
        },

        supportedCryptoSuites: [ this.hap.SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80 ],

        video: {

          codec: {

            // Through admittedly anecdotal testing on various G3 and G4 models, UniFi Protect seems to support
            // only the H.264 Main profile, though it does support various H.264 levels, ranging from Level 3
            // through Level 5.1 (G4 Pro at maximum resolution). However, HomeKit only supports Level 3.1, 3.2,
            // and 4.0 currently.
            levels: [ H264Level.LEVEL3_1, H264Level.LEVEL3_2, H264Level.LEVEL4_0 ],
            profiles: [ H264Profile.MAIN ]
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

    const snapshot = await this.snapshot.getSnapshot(request);

    // No snapshot was returned - we're done here.
    if(!snapshot) {

      if(callback) {

        callback(new Error(this.protectCamera.name + ": Unable to retrieve a snapshot"));
      }

      return;
    }

    // Return the image to HomeKit.
    if(callback) {

      callback(undefined, snapshot);
    }

    // Publish the snapshot as a data URL to MQTT, if configured.
    this.nvr.mqtt?.publish(this.protectCamera.ufp.mac, "snapshot", "data:image/jpeg;base64," + snapshot.toString("base64"));
  }

  // Prepare to launch the video stream.
  public async prepareStream(request: PrepareStreamRequest, callback: PrepareStreamCallback): Promise<void> {

    let reservePortFailed = false;
    const rtpPortReservations: number[] = [];

    // We use this utility to identify errors in reserving UDP ports for our use.
    const reservePort = async (ipFamily: ("ipv4" | "ipv6") = "ipv4", portCount: (1 | 2) = 1): Promise<number> => {

      // If we've already failed, don't keep trying to find more ports.
      if(reservePortFailed) {

        return -1;
      }

      // Retrieve the ports we're looking for.
      const assignedPort = await this.platform.rtpPorts.reserve(ipFamily, portCount);

      // We didn't get the ports we requested.
      if(assignedPort === -1) {

        reservePortFailed = true;
      } else {

        // Add this reservation the list of ports we've successfully requested.
        rtpPortReservations.push(assignedPort);

        if(portCount === 2) {

          rtpPortReservations.push(assignedPort + 1);
        }
      }

      // Return them.
      return assignedPort;
    };

    // Check if the camera has a microphone and if we have audio support is enabled in the plugin.
    const isAudioEnabled = this.protectCamera.ufp.featureFlags.hasMic && this.protectCamera.hasFeature("Audio");

    // We need to check for AAC support because it's going to determine whether we support audio.
    const hasAudioSupport = isAudioEnabled && (this.ffmpegOptions.audioEncoder.length > 0);

    // Setup our audio plumbing.
    const audioIncomingRtcpPort = (await reservePort(request.addressVersion));
    const audioIncomingPort = (hasAudioSupport && this.protectCamera.hints.twoWayAudio) ? (await reservePort(request.addressVersion)) : -1;
    const audioIncomingRtpPort = (hasAudioSupport && this.protectCamera.hints.twoWayAudio) ? (await reservePort(request.addressVersion, 2)) : -1;

    const audioSSRC = this.hap.CameraController.generateSynchronisationSource();

    if(!hasAudioSupport) {

      this.log.info("Audio support disabled.%s", isAudioEnabled ? " A version of FFmpeg that is compiled with fdk_aac support is required to support audio." : "");
    }

    let rtpDemuxer = null;
    let talkBack = null;

    if(hasAudioSupport && this.protectCamera.hints.twoWayAudio) {

      // Setup the RTP demuxer for two-way audio scenarios.
      rtpDemuxer = new RtpDemuxer(request.addressVersion, audioIncomingPort, audioIncomingRtcpPort, audioIncomingRtpPort, this.log);

      // Request the talkback websocket from the controller.
      const params = new URLSearchParams({ camera: this.protectCamera.ufp.id });

      talkBack = await this.nvr.ufpApi.getWsEndpoint("talkback", params);

      // Something went wrong and we don't have a talkback websocket.
      if(!talkBack) {

        this.log.error("Unable to open the return audio channel.");
      }
    }

    // Setup our video plumbing.
    const videoReturnPort = (await reservePort(request.addressVersion));
    const videoSSRC = this.hap.CameraController.generateSynchronisationSource();

    // If we've had failures to retrieve the UDP ports we're looking for, inform the user.
    if(reservePortFailed) {

      this.log.error("Unable to reserve the UDP ports needed to begin streaming.");
    }

    const sessionInfo: SessionInfo = {

      address: request.targetAddress,
      addressVersion: request.addressVersion,

      audioCryptoSuite: request.audio.srtpCryptoSuite,
      audioIncomingRtcpPort: audioIncomingRtcpPort,
      audioIncomingRtpPort: audioIncomingRtpPort,
      audioPort: request.audio.port,
      audioSRTP: Buffer.concat([request.audio.srtp_key, request.audio.srtp_salt]),
      audioSSRC: audioSSRC,

      hasAudioSupport: hasAudioSupport,
      rtpDemuxer: rtpDemuxer,
      rtpPortReservations: rtpPortReservations,
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
    this.pendingSessions[request.sessionID] = sessionInfo;
    callback(undefined, response);
  }

  // Launch the Protect video (and audio) stream.
  private async startStream(request: StartStreamRequest, callback: StreamRequestCallback): Promise<void> {

    const sessionInfo = this.pendingSessions[request.sessionID];
    const sdpIpVersion = sessionInfo.addressVersion === "ipv6" ? "IP6" : "IP4";

    // If we aren't connected, we're done.
    if(!this.protectCamera.isOnline) {

      const errorMessage = "Unable to start video stream: the camera is offline or unavailable.";

      this.log.error(errorMessage);
      callback(new Error(this.protectCamera.name + ": " + errorMessage));

      return;
    }

    // We transcode based in the following circumstances:
    //
    //   1. The user has explicitly configured transcoding.
    //   2. The user has configured cropping for the video stream.
    //   3. We are on a high latency streaming session (e.g. cellular). If we're high latency, we'll transcode by default unless the user has asked us not to. Why? It
    //      generally results in a speedier experience, at the expense of some stream quality (HomeKit tends to request far lower bitrates than Protect is capable of
    //      producing).
    //   4. The codec in use on the Protect camera isn't H.264.
    //
    // How do we determine if we're a high latency connection? We look at the RTP packet time of the audio packet time for a hint. HomeKit uses values of 20, 30, 40,
    // and 60ms. We make an assumption, validated by lots of real-world testing, that when we see 60ms used by HomeKit, it's a high latency connection and act
    // accordingly.
    const isHighLatency = request.audio.packet_time >= 60;
    const isTranscoding = this.protectCamera.hints.transcode || this.protectCamera.hints.crop || (isHighLatency && this.protectCamera.hints.transcodeHighLatency) ||
      (this.protectCamera.ufp.videoCodec !== "h264");

    // Set the initial bitrate we should use for this request based on what HomeKit is requesting.
    let targetBitrate = request.video.max_bit_rate;

    // Override the stream quality selection if we know they're problematic on the Protect controller.
    const overrideStream = this.protectCamera.hints.apiStreaming && ["AI Pro", "G4 Pro"].includes(this.protectCamera.ufp.marketName);
    let rtspEntry;

    // Find the best RTSP stream based on what we're looking for.
    if(isTranscoding) {

      // If we have hardware transcoding enabled, we treat it uniquely and get the highest quality stream we can. Fixed-function hardware transcoders tend to perform
      // better with higher bitrate sources. Wel also want to generally bias ourselves toward higher quality streams where possible.
      rtspEntry = this.protectCamera.findRtsp(
        (this.protectCamera.hints.hardwareTranscoding || overrideStream) ? 3840 : request.video.width,
        (this.protectCamera.hints.hardwareTranscoding || overrideStream) ? 2160 : request.video.height,
        { biasHigher: true, maxPixels: this.ffmpegOptions.hostSystemMaxPixels }
      );

      // If we have specified the bitrates we want to use when transcoding, let's honor those here.
      if(isHighLatency && (this.protectCamera.hints.transcodeHighLatencyBitrate > 0)) {

        targetBitrate = this.protectCamera.hints.transcodeHighLatencyBitrate;
      } else if(!isHighLatency && (this.protectCamera.hints.transcodeBitrate > 0)) {

        targetBitrate = this.protectCamera.hints.transcodeBitrate;
      }

      // If we're targeting a bitrate that's beyond the capabilities of our input channel, match the bitrate of the input channel.
      if(rtspEntry && (targetBitrate > (rtspEntry.channel.bitrate / 1000))) {

        targetBitrate = rtspEntry.channel.bitrate / 1000;
      }
    } else {

      rtspEntry = this.protectCamera.findRtsp(overrideStream ? 3840 : request.video.width, overrideStream ? 2160 : request.video.height);
    }

    if(!rtspEntry) {

      const errorMessage = "Unable to start video stream: no valid RTSP stream profile was found.";

      this.log.error("%s %sx%s, %s fps, %s kbps.", errorMessage,
        request.video.width, request.video.height, request.video.fps, request.video.max_bit_rate.toLocaleString("en-US"));

      callback(new Error(this.protectCamera.name + ": " + errorMessage));

      return;
    }

    let tsBuffer: Buffer | null;

    // If we have the timeshift buffer enabled, and it's the right quality channel, we use that as our livestream source. Otherwise, we revert to the RTSP stream from the
    // Protect controller. Using the timeshift buffer has a few advantages.
    //
    // - Typically, we have several seconds of video already queued up in the timeshift buffer, the FFmpeg startup process will get a significant speed up in performance.
    //   FFmpeg takes time at the beginning of each session to analyze the input before allowing you to perform any action. By using the timeshift buffer, we're able to
    //   give FFmpeg all that data right at the beginning, effectively reducing that startup time to the point of being imperceptible.
    //
    // - Since we are using an already existing connection to the Protect controller, we don't need to create another connection which incurs an additional delay, as well
    //   as a resource hit on the Protect controller.
    const useApi = this.protectCamera.hints.apiStreaming && this.protectCamera.hints.timeshift &&
      (!this.protectCamera.hints.streamingDefault || (this.protectCamera.hints.streamingDefault.toLowerCase() === this.hksv?.rtspEntry?.channel.name.toLowerCase()));

    // -hide_banner                     Suppress printing the startup banner in FFmpeg.
    // -nostats                         Suppress printing progress reports while encoding in FFmpeg.
    // -fflags flags                    Set format flags to discard any corrupt packets rather than exit.
    // -max_delay 500000                Set an upper limit on how much time FFmpeg can take in demuxing packets, in microseconds.
    // -flags low_delay                 Tell FFmpeg to optimize for low delay / realtime decoding.
    //
    //                                  Yes, we included these above as well: they need to be included for each I/O stream to maximize effectiveness it seems.
    const ffmpegArgs = [

      "-hide_banner",
      "-nostats",
      "-fflags", "+discardcorrupt",
      ...this.ffmpegOptions.videoDecoder,
      "-max_delay", "500000",
      "-flags", "low_delay"
    ];

    if(useApi) {

      tsBuffer = this.hksv?.timeshift.getLast(100) ?? null;

      // -probesize number              How many bytes should be analyzed for stream information.
      // -r fps                         Set the input frame rate for the video stream.
      // -f mp4                         Tell ffmpeg that it should expect an MP4-encoded input stream.
      // -i pipe:0                      Use standard input to get video data.
      // -enc_time_base demux           Set the encoder timebase to avoid timebase adjustments at the encoder layer.
      // -fps_mode passthrough          Pass through the framerate as defined by the Protect stream. This avoids frame duplication.
      // -muxdelay 0                    Set the maximum demux decode delay to 0.
      // -video_track_timescale 90000   Set the timescale to what Protect sends out.
      ffmpegArgs.push(

        "-probesize", tsBuffer?.length.toString() ?? "32768",
        "-r", this.hksv?.rtspEntry?.channel.fps.toString() ?? "30",
        "-f", "mp4",
        "-i", "pipe:0",
        "-enc_time_base", "demux",
        "-fps_mode", "passthrough",
        "-muxdelay", "0",
        "-video_track_timescale", "90000"
      );
    } else {

      // -probesize number              How many bytes should be analyzed for stream information.
      // -avioflags direct              Tell FFmpeg to minimize buffering to reduce latency for more realtime processing.
      // -r fps                         Set the input frame rate for the video stream.
      // -rtsp_transport tcp            Tell the RTSP stream handler that we're looking for a TCP connection.
      // -i rtspEntry.url               RTSPS URL to get our input stream from.
      ffmpegArgs.push(

        "-probesize", this.probesize.toString(),
        "-avioflags", "direct",
        "-r", rtspEntry.channel.fps.toString(),
        "-rtsp_transport", "tcp",
        "-i", rtspEntry.url
      );
    }

    // -map 0:v:0                       selects the first available video track from the stream. Protect actually maps audio
    //                                  and video tracks in opposite locations from where FFmpeg typically expects them. This
    //                                  setting is a more general solution than naming the track locations directly in case
    //                                  Protect changes this in the future.
    ffmpegArgs.push("-map", "0:v:0");

    // Inform the user.
    this.log.info("Streaming request from %s%s: %sx%s@%sfps, %s kbps. %s %s, %s kbps.",
      sessionInfo.address, (request.audio.packet_time === 60) ? " (high latency connection)" : "",
      request.video.width, request.video.height, request.video.fps, targetBitrate.toLocaleString("en-US"),
      isTranscoding ? (this.protectCamera.hints.hardwareTranscoding ? "Hardware accelerated transcoding" : "Transcoding") : "Using",
      rtspEntry.name + " [" + (useApi ? "API" : "RTSP") + "]", (rtspEntry.channel.bitrate / 1000).toLocaleString("en-US"));

    // Check to see if we're transcoding. If we are, set the right FFmpeg encoder options. If not, copy the video stream.
    if(isTranscoding) {

      // Configure our video parameters for transcoding.
      ffmpegArgs.push(...this.ffmpegOptions.streamEncoder({

        bitrate: targetBitrate,
        fps: rtspEntry.channel.fps,
        height: request.video.height,
        idrInterval: PROTECT_HOMEKIT_IDR_INTERVAL,
        inputFps: rtspEntry.channel.fps,
        level: request.video.level,
        profile: request.video.profile,
        width: request.video.width
      }));
    } else {

      // Configure our video parameters for just copying the input stream from Protect - it tends to be quite solid in most cases:
      //
      // -vcodec copy                   Copy the stream withour reencoding it.
      ffmpegArgs.push(

        "-vcodec", "copy"
      );

      // The livestream API needs to be transmuxed before we use it directly.
      if(useApi) {

        // -r bsf:v h264_mp4toannexb    Convert the livestream container format from MP4 to MPEG-TS.
        ffmpegArgs.push("-bsf:v", "h264_mp4toannexb");
      }
    }

    // Add in any user-specified options for FFmpeg.
    if(this.platform.config.ffmpegOptions) {

      ffmpegArgs.push(...this.platform.config.ffmpegOptions);
    }

    // Configure our video parameters for SRTP streaming:
    //
    // -payload_type num                Payload type for the RTP stream. This is negotiated by HomeKit and is usually 99 for H.264 video.
    // -ssrc                            Synchronization source stream identifier. Random number negotiated by HomeKit to identify this stream.
    // -f rtp                           Specify that we're using the RTP protocol.
    // -srtp_out_suite enc              Specify the output encryption encoding suites.
    // -srtp_out_params params          Specify the output encoding parameters. This is negotiated by HomeKit.
    ffmpegArgs.push(

      "-payload_type", request.video.pt.toString(),
      "-ssrc", sessionInfo.videoSSRC.toString(),
      "-f", "rtp",
      "-srtp_out_suite", "AES_CM_128_HMAC_SHA1_80",
      "-srtp_out_params", sessionInfo.videoSRTP.toString("base64"),
      "srtp://" + sessionInfo.address + ":" + sessionInfo.videoPort.toString() + "?rtcpport=" + sessionInfo.videoPort.toString() +
        "&pkt_size=" + request.video.mtu.toString()
    );

    // Configure the audio portion of the command line, if we have a version of FFmpeg supports the audio codecs we need. Options we use are:
    //
    // -map 0:a:0?                      Selects the first available audio track from the stream, if it exists. Protect actually maps audio
    //                                  and video tracks in opposite locations from where FFmpeg typically expects them. This
    //                                  setting is a more general solution than naming the track locations directly in case
    //                                  Protect changes this in the future.
    // -acodec                          Encode using the codecs available to us on given platforms.
    // -profile:a 38                    Specify enhanced, low-delay AAC for HomeKit.
    // -flags +global_header            Sets the global header in the bitstream.
    // -f null                          Null filter to pass the audio unchanged without running through a muxing operation.
    // -ar samplerate                   Sample rate to use for this audio. This is specified by HomeKit.
    // -b:a bitrate                     Bitrate to use for this audio stream. This is specified by HomeKit.
    // -bufsize size                    This is the decoder buffer size, which drives the variability / quality of the output bitrate.
    // -ac 1                            Set the number of audio channels to 1.
    if(sessionInfo.hasAudioSupport) {

      // Configure our audio parameters.
      ffmpegArgs.push(

        "-map", "0:a:0?",
        ...this.ffmpegOptions.audioEncoder,
        "-profile:a", "38",
        "-flags", "+global_header",
        "-f", "null",
        "-ar", request.audio.sample_rate.toString() + "k",
        "-b:a", request.audio.max_bit_rate.toString() + "k",
        "-bufsize", (2 * request.audio.max_bit_rate).toString() + "k",
        "-ac", request.audio.channel.toString()
      );

      // If we are audio filtering, address it here.
      if(this.protectCamera.hasFeature("Audio.Filter.Noise")) {

        const afOptions = [];

        // See what the user has set for the afftdn filter for this camera.
        let fftNr = this.protectCamera.getFeatureFloat("Audio.Filter.Noise.FftNr") ?? PROTECT_FFMPEG_AUDIO_FILTER_FFTNR;

        // If we have an invalid setting, use the defaults.
        if((fftNr < 0.01) || (fftNr > 97)) {

          fftNr = (fftNr > 97) ? 97 : ((fftNr < 0.01) ? 0.01 : fftNr);
        }

        // The afftdn filter options we use are:
        //
        // nt=w  Focus on eliminating white noise.
        // om=o  Output the filtered audio.
        // tn=1  Enable noise tracking.
        // tr=1  Enable residual tracking.
        // nr=X  Noise reduction value in decibels.
        afOptions.push("afftdn=nt=w:om=o:tn=1:tr=1:nr=" + fftNr.toString());

        const highpass = this.protectCamera.getFeatureNumber("Audio.Filter.Noise.HighPass");
        const lowpass = this.protectCamera.getFeatureNumber("Audio.Filter.Noise.LowPass");

        // Only set the highpass and lowpass filters if the user has explicitly enabled them.
        if(highpass !== undefined) {

          afOptions.push("highpass=f=" + highpass.toString());
        }

        if(lowpass !== undefined) {

          afOptions.push("lowpass=f=" + lowpass.toString());
        }

        // Return the assembled audio filter option.
        ffmpegArgs.push("-af", afOptions.join(", "));
      }

      // Add the required RTP settings and encryption for the stream:
      //
      // -payload_type num                Payload type for the RTP stream. This is negotiated by HomeKit and is usually 110 for AAC-ELD audio.
      // -ssrc                            synchronization source stream identifier. Random number negotiated by HomeKit to identify this stream.
      // -f rtp                           Specify that we're using the RTP protocol.
      // -srtp_out_suite enc              Specify the output encryption encoding suites.
      // -srtp_out_params params          Specify the output encoding parameters. This is negotiated by HomeKit.
      ffmpegArgs.push(

        "-payload_type", request.audio.pt.toString(),
        "-ssrc", sessionInfo.audioSSRC.toString(),
        "-f", "rtp",
        "-srtp_out_suite", "AES_CM_128_HMAC_SHA1_80",
        "-srtp_out_params", sessionInfo.audioSRTP.toString("base64"),
        "srtp://" + sessionInfo.address + ":" + sessionInfo.audioPort.toString() + "?rtcpport=" + sessionInfo.audioPort.toString() + "&pkt_size=188"
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
      (sessionInfo.hasAudioSupport && this.protectCamera.hints.twoWayAudio) ? undefined :
        { addressVersion: sessionInfo.addressVersion, port: sessionInfo.videoReturnPort },
      callback);

    if(useApi) {

      const livestream = this.protectCamera.livestream.acquire(rtspEntry.channel.id, rtspEntry.lens);
      let seenInitSegment = false;

      // If we're using a timeshift buffer, let's use that to livestream. It has the dual benefit of reducing the workload on the Protect controller since it's already
      // providing a livestream to us and it also improves performance by ensuring there's several seconds of video ready to immediately transmit.
      const livestreamListener = async (segment: Buffer): Promise<void> => {

        if(!seenInitSegment) {

          if(this.hksv?.timeshift.isStarted &&
            (((this.hksv?.timeshift.lens === undefined) && (this.hksv?.timeshift.channel === rtspEntry.channel.id)) ||
            ((this.hksv?.timeshift.lens !== undefined) && (this.hksv?.timeshift.lens === rtspEntry.lens)))) {

            ffmpegStream.stdin?.write(tsBuffer ?? (await livestream.getInitSegment()));
            seenInitSegment = true;
          } else {

            ffmpegStream.stdin?.write(await livestream.getInitSegment());
            seenInitSegment = true;
          }
        }

        // Send the segment to FFmpeg for processing.
        ffmpegStream.stdin?.write(segment);
      };

      const closeListener = (): void => void ffmpegStream.ffmpegProcess?.stdin.end();

      livestream.on("close", closeListener);

      // Ensure we cleanup on exit.
      ffmpegStream.ffmpegProcess?.once("exit", () => {

        this.protectCamera.livestream.stop(rtspEntry.channel.id, rtspEntry.lens);
        livestream.off("segment", livestreamListener);
        livestream.off("close", closeListener);
      });

      // Transmit video from our livestream as soon as it arrives.
      livestream.on("segment", livestreamListener);

      // Kickoff our livestream.
      if(!(await this.protectCamera.livestream.start(rtspEntry.channel.id, rtspEntry.lens))) {

        livestream.off("segment", livestreamListener);
        livestream.off("close", closeListener);

        return;
      }
    }

    // Some housekeeping for our FFmpeg and demuxer sessions.
    this.ongoingSessions[request.sessionID] = {

      ffmpeg: [ ffmpegStream ],
      rtpDemuxer: sessionInfo.rtpDemuxer,
      rtpPortReservations: sessionInfo.rtpPortReservations
    };

    delete this.pendingSessions[request.sessionID];

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
      "s=" + this.protectCamera.name + " Audio Talkback",
      "c=IN " + sdpIpVersion + " " + sessionInfo.address,
      "t=0 0",
      "m=audio " + sessionInfo.audioIncomingRtpPort.toString() + " RTP/AVP " + request.audio.pt.toString(),
      "b=AS:24",
      "a=rtpmap:110 MPEG4-GENERIC/" + ((request.audio.sample_rate === AudioStreamingSamplerate.KHZ_16) ? "16000" : "24000") + "/" + request.audio.channel.toString(),
      "a=fmtp:110 profile-level-id=1;mode=AAC-hbr;sizelength=13;indexlength=3;indexdeltalength=3; config=" +
        ((request.audio.sample_rate === AudioStreamingSamplerate.KHZ_16) ? "F8F0212C00BC00" : "F8EC212C00BC00"),
      "a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:" + sessionInfo.audioSRTP.toString("base64")
    ].join("\n");

    // Configure the audio portion of the command line, if we have a version of FFmpeg supports the audio codecs we need. Options we use are:
    //
    // -hide_banner           Suppress printing the startup banner in FFmpeg.
    // -nostats               Suppress printing progress reports while encoding in FFmpeg.
    // -protocol_whitelist    Set the list of allowed protocols for this FFmpeg session.
    // -f sdp                 Specify that our input will be an SDP file.
    // -acodec                Decode AAC input using the specified decoder.
    // -i pipe:0              Read input from standard input.
    // -acodec                Encode to AAC. This format is set by Protect.
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
      "-acodec", this.ffmpegOptions.audioDecoder,
      "-i", "pipe:0",
      "-map", "0:a:0",
      ...this.ffmpegOptions.audioEncoder,
      "-flags", "+global_header",
      "-ar", this.protectCamera.ufp.talkbackSettings.samplingRate.toString(),
      "-b:a", request.audio.max_bit_rate.toString() + "k",
      "-ac", this.protectCamera.ufp.talkbackSettings.channels.toString(),
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
      const wsCleanup = (): void => {

        // Close the websocket.
        if(ws?.readyState !== WebSocket.CLOSED) {

          ws?.terminate();
        }
      };

      if(sessionInfo.talkBack) {

        // Open the talkback connection.
        ws = new WebSocket(sessionInfo.talkBack, { rejectUnauthorized: false });
        isTalkbackLive = true;

        // Catch any errors and inform the user, if needed.
        ws?.once("error", (error) => {

          // Ignore timeout errors, but notify the user about anything else.
          if(((error as NodeJS.ErrnoException).code !== "ETIMEDOUT") &&
            !error.toString().startsWith("Error: WebSocket was closed before the connection was established")) {

            this.log.error("Error in communicating with the return audio channel: %s", error);
          }

          // Clean up our talkback websocket.
          wsCleanup();
        });

        // Catch any stray open events after we've closed.
        ws?.on("open", openListener = (): void => {

          // If we've somehow opened after we've wrapped up talkback, terminate the connection.
          if(!isTalkbackLive) {

            // Clean up our talkback websocket.
            wsCleanup();
          }
        });

        // Cleanup after ourselves on close.
        ws?.once("close", () => {

          ws?.off("open", openListener);
        });
      }

      // Wait for the first RTP packet to be received before trying to launch FFmpeg.
      if(sessionInfo.rtpDemuxer) {

        await once(sessionInfo.rtpDemuxer, "rtp");

        // If we've already closed the RTP demuxer, we're done here,
        if(!sessionInfo.rtpDemuxer.isRunning) {

          // Clean up our talkback websocket.
          wsCleanup();

          return;
        }
      }

      // Fire up FFmpeg and start processing the incoming audio.
      const ffmpegReturnAudio = new FfmpegStreamingProcess(this, request.sessionID, ffmpegReturnAudioCmd);

      // Setup housekeeping for the twoway FFmpeg session.
      this.ongoingSessions[request.sessionID].ffmpeg.push(ffmpegReturnAudio);

      // Feed the SDP session description to FFmpeg on stdin.
      ffmpegReturnAudio.stdin?.end(sdpReturnAudio + "\n");

      // Send the audio.
      ffmpegReturnAudio.stdout?.on("data", dataListener = (data: Buffer): void => {

        ws?.send(data, (error: Error | undefined): void => {

          // This happens when an error condition is encountered on sending data to the websocket. We assume the worst and close our talkback channel.
          if(error) {

            wsCleanup();
          }
        });
      });

      // Make sure we terminate the talkback websocket when we're done.
      ffmpegReturnAudio.ffmpegProcess?.once("exit", () => {

        // Make sure we catch any stray connections that may be too slow to open.
        isTalkbackLive = false;

        // Clean up our talkback websocket.
        wsCleanup();

        ffmpegReturnAudio.stdout?.off("data", dataListener);
      });
    } catch(error) {

      this.log.error("Unable to connect to the return audio channel: %s", error);
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
        this.log.debug("Streaming parameters adjustment requested by HomeKit: %sx%s, %s fps, %s kbps.",
          request.video.width, request.video.height, request.video.fps, request.video.max_bit_rate.toLocaleString("en-US"));

        callback();

        break;

      case StreamRequestTypes.STOP:
      default:

        await this.stopStream(request.sessionID);
        callback();

        break;
    }
  }

  // Close a video stream.
  public async stopStream(sessionId: string): Promise<void> {

    try {

      // Stop any FFmpeg instances we have running.
      if(this.ongoingSessions[sessionId]) {

        this.ongoingSessions[sessionId].ffmpeg.map(ffmpegProcess => ffmpegProcess.stop());

        // Close the demuxer, if we have one.
        this.ongoingSessions[sessionId].rtpDemuxer?.close();

        // Inform the user.
        this.log.info("Stopped video streaming session.");

        // Release our port reservations.
        this.ongoingSessions[sessionId].rtpPortReservations.map(x => this.platform.rtpPorts.cancel(x));
      }

      // On the off chance we were signaled to prepare to start streaming, but never actually started streaming, cleanup after ourselves.
      if(this.pendingSessions[sessionId]) {

        // Release our port reservations.
        this.pendingSessions[sessionId].rtpPortReservations.map(x => this.platform.rtpPorts.cancel(x));
      }

      // Delete the entries.
      delete this.pendingSessions[sessionId];
      delete this.ongoingSessions[sessionId];
    } catch(error) {

      this.log.error("Error occurred while ending the FFmpeg video processes: %s.", error);
    }
  }

  // Shutdown all our video streams.
  public async shutdown(): Promise<void> {

    for(const session of Object.keys(this.ongoingSessions)) {

      // eslint-disable-next-line no-await-in-loop
      await this.stopStream(session);
    }
  }

  // Adjust our probe hints.
  public adjustProbeSize(): void {

    if(this.probesizeOverrideTimeout) {

      clearTimeout(this.probesizeOverrideTimeout);
      this.probesizeOverrideTimeout = undefined;
    }

    // Maintain statistics on how often we need to adjust our probesize. If this happens too frequently, we will default to a working value.
    this.probesizeOverrideCount++;

    // Increase the probesize by a factor of two each time we need to do something about it. This idea is to balance the latency implications
    // for the user, but also ensuring we have a functional streaming experience.
    this.probesizeOverride = this.probesize * 2;

    // Safety check to make sure this never gets too crazy.
    if(this.probesizeOverride > 5000000) {

      this.probesizeOverride = 5000000;
    }

    this.log.error("The FFmpeg process ended unexpectedly due to issues with the media stream provided by the UniFi Protect livestream API. " +
    "Adjusting the settings we use for FFmpeg %s to use safer values at the expense of some additional streaming startup latency.",
    this.probesizeOverrideCount < 10 ? "temporarily" : "permanently");

    // If this happens often enough, keep the override in place permanently.
    if(this.probesizeOverrideCount < 10) {

      this.probesizeOverrideTimeout = setTimeout(() => {

        this.probesizeOverride = 0;
        this.probesizeOverrideTimeout = undefined;
      }, 1000 * 60 * 10);
    }
  }

  // Utility to return the currently set probesize for a camera.
  public get probesize(): number {

    return this.probesizeOverride ? this.probesizeOverride : this.protectCamera.hints.probesize;
  }
}
