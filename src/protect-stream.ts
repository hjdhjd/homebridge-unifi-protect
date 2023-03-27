/* Copyright(C) 2017-2023, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-stream.ts: Homebridge camera streaming delegate implementation for Protect.
 *
 * This module is heavily inspired by the homebridge and homebridge-camera-ffmpeg source code. Thank you for your contributions to the HomeKit world.
 */
import { API, AudioRecordingCodecType, AudioRecordingSamplerate, AudioStreamingCodecType, AudioStreamingSamplerate, CameraController,
  CameraControllerOptions, CameraStreamingDelegate, H264Level, H264Profile, HAP, MediaContainerType, PrepareStreamCallback, PrepareStreamRequest, PrepareStreamResponse,
  SRTPCryptoSuites, SnapshotRequest, SnapshotRequestCallback, StartStreamRequest, StreamRequestCallback, StreamRequestTypes, StreamingRequest } from "homebridge";
import { PROTECT_FFMPEG_AUDIO_FILTER_FFTNR, PROTECT_FFMPEG_AUDIO_FILTER_HIGHPASS, PROTECT_FFMPEG_AUDIO_FILTER_LOWPASS,
  PROTECT_HKSV_SEGMENT_LENGTH, PROTECT_HKSV_TIMESHIFT_BUFFER_MAXLENGTH, PROTECT_SNAPSHOT_CACHE_MAXAGE } from "./settings.js";
import { ProtectCamera, ProtectPackageCamera, RtspEntry } from "./protect-camera.js";
import { FetchError } from "unifi-protect";
import { FfmpegStreamingProcess } from "./protect-ffmpeg-stream.js";
import { ProtectLogging } from "./protect-types.js";
import { ProtectNvr } from "./protect-nvr.js";
import { ProtectOptions } from "./protect-options.js";
import { ProtectPlatform } from "./protect-platform.js";
import { ProtectRecordingDelegate } from "./protect-record.js";
import { RtpDemuxer } from "./protect-rtp.js";
import WebSocket from "ws";
import events from "node:events";
import ffmpegPath from "ffmpeg-for-homebridge";
import { platform } from "node:process";

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
  rtpPortReservations: number[]; // RTP port reservations.
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
  private readonly hap: HAP;
  public hksv: ProtectRecordingDelegate | null;
  public readonly log: ProtectLogging;
  private readonly nvr: ProtectNvr;
  private ongoingSessions: { [index: string]: { ffmpeg: FfmpegStreamingProcess[], rtpDemuxer: RtpDemuxer | null, rtpPortReservations: number[] } };
  private pendingSessions: { [index: string]: SessionInfo };
  public readonly platform: ProtectPlatform;
  public readonly protectCamera: ProtectCamera | ProtectPackageCamera;
  private probesizeOverride: number;
  private probesizeOverrideCount: number;
  private probesizeOverrideTimeout?: NodeJS.Timeout;
  private rtspEntry: RtspEntry | null;
  private savedBitrate: number;
  private snapshotCache: { [index: string]: { image: Buffer, time: number } };
  public verboseFfmpeg: boolean;
  public readonly videoEncoderOptions!: string[];
  public readonly videoProcessor: string;

  // Create an instance of a HomeKit streaming delegate.
  constructor(protectCamera: ProtectCamera, resolutions: [number, number, number][]) {

    this.api = protectCamera.api;
    this.config = protectCamera.platform.config;
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
    this.rtspEntry = null;
    this.savedBitrate = 0;
    this.snapshotCache = {};
    this.verboseFfmpeg = false;
    this.videoEncoderOptions = this.getVideoEncoderOptions();
    this.videoProcessor = this.config.videoProcessor || ffmpegPath || "ffmpeg";

    // Setup for HKSV, if enabled.
    if(this.protectCamera.hasHksv) {

      this.hksv = new ProtectRecordingDelegate(protectCamera);
    }

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
              levels: [H264Level.LEVEL3_1, H264Level.LEVEL3_2, H264Level.LEVEL4_0],
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
              samplerate: AudioStreamingSamplerate.KHZ_24,
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

    const snapshot = await this.getSnapshot(request);

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
    this.nvr.mqtt?.publish(this.protectCamera.accessory, "snapshot", "data:image/jpeg;base64," + snapshot.toString("base64"));
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
      const assignedPort = await this.platform.rtpPorts.reservePort(ipFamily, portCount);

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

    // Check if audio support is enabled.
    const isAudioEnabled = this.nvr.optionEnabled(this.protectCamera.ufp, "Audio", true, request.targetAddress);

    // We need to check for AAC support because it's going to determine whether we support audio.
    const hasLibFdk = isAudioEnabled && (await FfmpegStreamingProcess.codecEnabled(this.videoProcessor, "libfdk_aac", this.log));

    // Setup our audio plumbing.
    const audioIncomingRtcpPort = (await reservePort(request.addressVersion));
    const audioIncomingPort = (hasLibFdk && this.protectCamera.hints.twoWayAudio) ? (await reservePort(request.addressVersion)) : -1;
    const audioIncomingRtpPort = (hasLibFdk && this.protectCamera.hints.twoWayAudio) ? (await reservePort(request.addressVersion, 2)) : -1;

    const audioSSRC = this.hap.CameraController.generateSynchronisationSource();

    if(!hasLibFdk) {

      this.log.info("Audio support disabled.%s", isAudioEnabled ? " A version of FFmpeg that is compiled with fdk_aac support is required to support audio." : "");
    }

    let rtpDemuxer = null;
    let talkBack = null;

    if(hasLibFdk && this.protectCamera.hints.twoWayAudio) {

      // Setup the RTP demuxer for two-way audio scenarios.
      rtpDemuxer = new RtpDemuxer(this, request.addressVersion, audioIncomingPort, audioIncomingRtcpPort, audioIncomingRtpPort);

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

      hasLibFdk: hasLibFdk,
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

        port: (hasLibFdk && this.protectCamera.hints.twoWayAudio) ? audioIncomingPort : audioIncomingRtcpPort,
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
    const sdpIpVersion = sessionInfo.addressVersion === "ipv6" ? "IP6 ": "IP4";

    // If we aren't connected, we're done.
    if(this.protectCamera.ufp.state !== "CONNECTED") {
      const errorMessage = "Unable to start video stream: the camera is offline or unavailable.";

      this.log.error(errorMessage);
      callback(new Error(this.protectCamera.name + ": " + errorMessage));
      return;
    }

    // Find the best RTSP stream based on what we're looking for.
    this.rtspEntry = this.protectCamera.findRtsp(request.video.width, request.video.height, this.protectCamera.ufp, sessionInfo.address);

    if(!this.rtspEntry) {

      const errorMessage = "Unable to start video stream: no valid RTSP stream profile was found.";

      this.log.error("%s %sx%s, %s fps, %s kbps.", errorMessage,
        request.video.width, request.video.height, request.video.fps, request.video.max_bit_rate);

      callback(new Error(this.protectCamera.name + ": " + errorMessage));
      return;
    }

    // Save our current bitrate before we modify it, but only if we're the first stream - we don't want to do this for
    // concurrent streaming clients for this camera.
    if(!this.savedBitrate) {

      this.savedBitrate = this.protectCamera.getBitrate(this.rtspEntry.channel.id);

      if(this.savedBitrate < 0) {

        this.savedBitrate = 0;
      }
    }

    // Set the desired bitrate in Protect. We don't need to for this to return, because Protect
    // will adapt the stream once it processes the configuration change.
    await this.protectCamera.setBitrate(this.rtspEntry.channel.id, request.video.max_bit_rate * 1000);

    // Has the user explicitly configured transcoding, or are we a high latency session (e.g. cellular)? If we're high latency, we'll transcode
    // by default unless the user has asked us not to. Why? It generally results in a speedier experience, at the expense of some stream quality
    // (HomeKit tends to request far lower bitrates than Protect is capable of producing).
    //
    // How do we determine if we're a high latency connection? We look at the RTP packet time of the audio packet time for a hint. HomeKit uses values
    // of 20, 30, 40, and 60ms. We make an assumption, validated by lots of real-world testing, that when we see 60ms used by HomeKit, it's a
    // high latency connection and act accordingly.
    const isTranscoding = this.protectCamera.hints.transcode || ((request.audio.packet_time >= 60) && this.protectCamera.hints.transcodeHighLatency);

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
    // -probesize number                How many bytes should be analyzed for stream information.
    // -max_delay 500000                Set an upper limit on how much time FFmpeg can take in demuxing packets, in microseconds.
    // -r fps                           Set the input frame rate for the video stream.
    // -rtsp_transport tcp              Tell the RTSP stream handler that we're looking for a TCP connection.
    // -i this.rtspEntry.url            RTSPS URL to get our input stream from.
    // -map 0:v:0                       selects the first available video track from the stream. Protect actually maps audio
    //                                  and video tracks in opposite locations from where FFmpeg typically expects them. This
    //                                  setting is a more general solution than naming the track locations directly in case
    //                                  Protect changes this in the future.
    //
    //                                  Yes, we included these above as well: they need to be included for each I/O stream to maximize effectiveness it seems.
    const ffmpegArgs = [

      "-hide_banner",
      "-probesize", this.probesizeOverride ? this.probesizeOverride.toString() : this.protectCamera.hints.probesize.toString(),
      "-max_delay", "500000",
      "-r", this.rtspEntry.channel.fps.toString(),
      "-rtsp_transport", "tcp",
      "-i", this.rtspEntry.url,
      "-map", "0:v:0"
    ];

    // Inform the user.
    this.log.info("Streaming request from %s%s: %sx%s@%sfps, %s kbps. %s %s, %s kbps. Audio packet time = %s",
      sessionInfo.address, (request.audio.packet_time === 60) ? " (high latency connection)" : "",
      request.video.width, request.video.height, request.video.fps, request.video.max_bit_rate,
      isTranscoding ? (this.protectCamera.hasHwAccel ? "Hardware accelerated transcoding" : "Transcoding") : "Using",
      this.rtspEntry.name, this.rtspEntry.channel.bitrate / 1000, request.audio.packet_time);

    // Check to see if we're transcoding. If we are, set the right FFmpeg encoder options. If not, copy the video stream.
    if(isTranscoding) {

      // Configure our video parameters for transcoding:
      //
      // -profile:v high     Use the H.264 high profile when encoding, which provides for better stream quality and size efficiency.
      // -level:v high       Use the H.264 profile level that HomeKit is requesting when encoding.
      // -bf 0               Disable B-frames when encoding to increase compatibility against occasionally finicky HomeKit clients.
      // -b:v bitrate        The average bitrate to use for this stream. This is specified by HomeKit.
      // -bufsize size       This is the decoder buffer size, which drives the variability / quality of the output bitrate.
      // -maxrate bitrate    The maximum bitrate tolerance, used with -bufsize. We set this with max_bit_rate to effectively
      //                     create a constant bitrate.
      // -filter:v fps=fps=  Use the fps filter to get to the frame rate requested by HomeKit. This has better performance characteristics
      //                     for Protect rather than using "-r".
      ffmpegArgs.push(
        ...this.videoEncoderOptions,
        "-profile:v", this.getH264Profile(request.video.profile),
        "-level:v", this.getH264Level(request.video.level),
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
      "&localrtcpport=" + sessionInfo.videoPort.toString() + "&pkt_size=" + videomtu.toString()
    );

    // Configure the audio portion of the command line, if we have a version of FFmpeg supports libfdk_aac. Options we use are:
    //
    // -map 0:a:0                       Selects the first available audio track from the stream. Protect actually maps audio
    //                                  and video tracks in opposite locations from where FFmpeg typically expects them. This
    //                                  setting is a more general solution than naming the track locations directly in case
    //                                  Protect changes this in the future.
    // -acodec libfdk_aac               Encode to AAC.
    // -profile:a aac_eld               Specify enhanced, low-delay AAC for HomeKit.
    // -flags +global_header            Sets the global header in the bitstream.
    // -f null                          Null filter to pass the audio unchanged without running through a muxing operation.
    // -ar samplerate                   Sample rate to use for this audio. This is specified by HomeKit.
    // -b:a bitrate                     Bitrate to use for this audio. This is specified by HomeKit.
    // -bufsize size                    This is the decoder buffer size, which drives the variability / quality of the output bitrate.
    // -ac 1                            Set the number of audio channels to 1.
    if(sessionInfo.hasLibFdk) {

      // Configure our audio parameters.
      ffmpegArgs.push(

        "-map", "0:a:0",
        "-acodec", "libfdk_aac",
        "-profile:a", "aac_eld",
        "-flags", "+global_header",
        "-f", "null",
        "-ar", request.audio.sample_rate.toString() + "k",
        "-afterburner", "1",
        "-eld_sbr", "1",
        "-eld_v2", "1",
        "-b:a", request.audio.max_bit_rate.toString() + "k",
        "-bufsize", (2 * request.audio.max_bit_rate).toString() + "k",
        "-ac", "1"
      );

      // If we are audio filtering, address it here.
      if(this.nvr.optionEnabled(this.protectCamera.ufp, "Audio.Filter.Noise", false, sessionInfo.address)) {

        const afOptions = [];

        // See what the user has set for the afftdn filter for this camera.
        let fftNr = parseFloat(this.nvr.optionGet(this.protectCamera.ufp, "Audio.Filter.Noise.FftNr", sessionInfo.address) ?? "");

        // If we have an invalid setting, use the defaults.
        if((fftNr !== fftNr) || (fftNr < 0.01) || (fftNr > 97)) {

          fftNr = (fftNr > 97) ? 97 : ((fftNr < 0.01) ? 0.01 : PROTECT_FFMPEG_AUDIO_FILTER_FFTNR);
        }

        // nt=w  Focus on eliminating white noise.
        // om=o  Output the filtered audio.
        // tn=1  Enable noise tracking.
        // tr=1  Enable residual tracking.
        // nr=X  Noise reduction value in decibels.
        afOptions.push("afftdn=nt=w:om=o:tn=1:tr=1:nr=" + fftNr.toString());

        let highpass: number | string | undefined = this.nvr.optionGet(this.protectCamera.ufp, "Audio.Filter.Noise.HighPass", sessionInfo.address) ??
          (this.nvr.optionEnabled(this.protectCamera.ufp, "Audio.Filter.Noise.HighPass", false) ? PROTECT_FFMPEG_AUDIO_FILTER_HIGHPASS.toString() : undefined);

        let lowpass: number | string | undefined = this.nvr.optionGet(this.protectCamera.ufp, "Audio.Filter.Noise.LowPass", sessionInfo.address) ??
          (this.nvr.optionEnabled(this.protectCamera.ufp, "Audio.Filter.Noise.LowPass", false) ? PROTECT_FFMPEG_AUDIO_FILTER_LOWPASS.toString() : undefined);

        // Only set the highpass and lowpass filters if the user has explicitly enabled them.
        if((highpass !== undefined) || (lowpass !== undefined)) {

          // See what the user has set for the highpass filter for this camera.
          highpass = parseInt(highpass ?? "");

          // If we have an invalid setting, use the defaults.
          if((highpass !== highpass) || (highpass < 0)) {
            highpass = PROTECT_FFMPEG_AUDIO_FILTER_HIGHPASS;
          }

          // See what the user has set for the highpass filter for this camera.
          lowpass = parseInt(lowpass ?? "");

          // If we have an invalid setting, use the defaults.
          if((lowpass !== lowpass) || (lowpass < 0)) {

            lowpass = PROTECT_FFMPEG_AUDIO_FILTER_LOWPASS;
          }

          afOptions.push("highpass=f=" + highpass.toString(), "lowpass=f=" + lowpass.toString());
        }

        // Return the assembled audio filter option.
        ffmpegArgs.push("-af", afOptions.join(","));
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
      (sessionInfo.hasLibFdk && this.protectCamera.hints.twoWayAudio) ? undefined : { addressVersion: sessionInfo.addressVersion, port: sessionInfo.videoReturnPort },
      callback);

    // Some housekeeping for our FFmpeg and demuxer sessions.
    this.ongoingSessions[request.sessionID] = {

      ffmpeg: [ ffmpegStream ],
      rtpDemuxer: sessionInfo.rtpDemuxer,
      rtpPortReservations: sessionInfo.rtpPortReservations
    };

    delete this.pendingSessions[request.sessionID];

    // If we aren't doing two-way audio, we're done here. For two-way audio...we have some more plumbing to do.
    if(!sessionInfo.hasLibFdk || !this.protectCamera.hints.twoWayAudio) {

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
    // a=rtpmap      Payload type 110 corresponds to an MP4 stream. Format is MPEG4-GENERIC/<audio clock rate>/<audio channels>
    // a=fmtp        For payload type 110, use these format parameters.
    // a=crypto      Crypto suite to use for this session.
    const sdpReturnAudio = [

      "v=0",
      "o=- 0 0 IN " + sdpIpVersion + " 127.0.0.1",
      "s=" + this.protectCamera.name + " Audio Talkback",
      "c=IN " + sdpIpVersion + " " + sessionInfo.address,
      "t=0 0",
      "m=audio " + sessionInfo.audioIncomingRtpPort.toString() + " RTP/AVP 110",
      "b=AS:24",
      "a=rtpmap:110 MPEG4-GENERIC/24000/1",
      "a=fmtp:110 profile-level-id=1;mode=AAC-hbr;sizelength=13;indexlength=3;indexdeltalength=3; config=F8EC212C00BC00",
      "a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:" + sessionInfo.audioSRTP.toString("base64")
    ].join("\n");

    // Configure the audio portion of the command line, if we have a version of FFmpeg supports libfdk_aac. Options we use are:
    //
    // -hide_banner           Suppress printing the startup banner in FFmpeg.
    // -protocol_whitelist    Set the list of allowed protocols for this FFmpeg session.
    // -f sdp                 Specify that our input will be an SDP file.
    // -acodec libfdk_aac     Decode AAC input.
    // -i pipe:0              Read input from standard input.
    // -acodec libfdk_aac     Encode to AAC. This format is set by Protect.
    // -flags +global_header  Sets the global header in the bitstream.
    // -afterburner 1         Increases audio quality at the expense of needing a little bit more computational power in libfdk_aac.
    // -eld_sbr 1             Use spectral band replication to further enhance audio.
    // -eld_v2 1              Use the enhanced low delay v2 standard for better audio characteristics.
    // -af                    Use the aformat audio filter to set the channel layout to mono and use the Protect-provided sample
    //                        rate to produce the right audio needed for talkback.
    // -f adts                Transmit an ADTS stream.
    // pipe:1                 Output the ADTS stream to standard output.
    const ffmpegReturnAudioCmd = [

      "-hide_banner",
      "-protocol_whitelist", "crypto,file,pipe,rtp,udp",
      "-f", "sdp",
      "-acodec", "libfdk_aac",
      "-i", "pipe:0",
      "-acodec", "libfdk_aac",
      "-flags", "+global_header",
      "-afterburner", "1",
      "-eld_sbr", "1",
      "-eld_v2", "1",
      "-af", "aformat=channel_layouts=mono:sample_rates=" + this.protectCamera.ufp.talkbackSettings.samplingRate.toString(),
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

            this.log.error("Error in communicating with the return audio channel: %s", error);
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

      // Wait for the first RTP packet to be received before trying to launch FFmpeg.
      if(sessionInfo.rtpDemuxer) {

        await events.once(sessionInfo.rtpDemuxer, "rtp");

        // If we've already closed the RTP demuxer, we're done here,
        if(!sessionInfo.rtpDemuxer.isRunning) {

          // Clean up our talkback websocket.
          ws?.terminate();
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
        this.log.info("Streaming parameters adjustment requested by HomeKit: %sx%s, %s fps, %s kbps.",
          request.video.width, request.video.height, request.video.fps, request.video.max_bit_rate);

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
    if(!this.snapshotCache[cameraMac] || ((Date.now() - this.snapshotCache[cameraMac].time) > (PROTECT_SNAPSHOT_CACHE_MAXAGE * 1000))) {

      delete this.snapshotCache[cameraMac];
      return null;
    }

    return this.snapshotCache[cameraMac].image;
  }

  // Take a snapshot.
  public async getSnapshot(request?: SnapshotRequest, isLoggingErrors = true): Promise<Buffer | null> {

    const logError = (message: string, ...parameters: unknown[]): void => {

      // We don't need to log errors for snapshot cache refreshes.
      if(isLoggingErrors) {

        this.log.error(message, ...parameters);
      }
    };

    const params = new URLSearchParams({ ts: Date.now().toString() });

    // If we aren't connected, we're done.
    if(this.protectCamera.ufp.state !== "CONNECTED") {

      logError("Unable to retrieve a snapshot: the camera is offline or unavailable.");
      return null;
    }

    // If we have details of the snapshot request, use it to request the right size.
    if(request) {

      params.append("h", request.height.toString());
      params.append("w", request.width.toString());
    }

    // Don't log the inevitable API errors related to response delays from the Protect controller.
    const savedLogState = this.nvr.logApiErrors;

    if(!isLoggingErrors) {

      this.nvr.logApiErrors = false;
    }

    // Request the image from the controller.
    const response = await this.nvr.ufpApi.fetch(this.protectCamera.snapshotUrl + "?" + params.toString(), { method: "GET" }, true, false);

    if(!isLoggingErrors) {

      this.nvr.logApiErrors = savedLogState;
    }

    // Occasional snapshot failures will happen. The controller isn't always able to generate them if it's already generating one,
    // or it's requested too quickly after the last one.
    if(!response?.ok) {

      // See if we have an image cached that we can use instead.
      const cachedSnapshot = this.getCachedSnapshot(this.protectCamera.ufp.mac);

      if(cachedSnapshot) {

        logError("Unable to retrieve a snapshot. Using the most recent cached snapshot instead.");
        return cachedSnapshot;
      }

      logError("Unable to retrieve a snapshot.%s", response ? " " + response.status.toString() + " - " + response.statusText + "." : "");

      return null;
    }

    try {

      // Retrieve the image.
      this.snapshotCache[this.protectCamera.ufp.mac] = { image: Buffer.from(await response.arrayBuffer()), time: Date.now() };
      return this.snapshotCache[this.protectCamera.ufp.mac].image;
    } catch(error) {

      if(error instanceof FetchError) {
        let cachedSnapshot;

        switch(error.code) {

          case "ERR_STREAM_PREMATURE_CLOSE":

            cachedSnapshot = this.getCachedSnapshot(this.protectCamera.ufp.mac);

            if(cachedSnapshot) {

              logError("Unable to retrieve a snapshot. Using a cached snapshot instead.");
              return cachedSnapshot;
            }

            logError("Unable to retrieve a snapshot: the Protect controller closed the connection prematurely.");
            return null;
            break;

          default:

            this.log.error("Unknown error: %s", error.message);
            return null;
            break;
        }
      }

      this.log.error("An error occurred while making a snapshot request: %s.", error);
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
        this.log.info("Stopped video streaming session.");

        // Release our port reservations.
        this.ongoingSessions[sessionId].rtpPortReservations.map(x => this.platform.rtpPorts.freePort(x));
      }

      // On the off chance we were signaled to prepare to start streaming, but never actually started streaming, cleanup after ourselves.
      if(this.pendingSessions[sessionId]) {

        // Release our port reservations.
        this.pendingSessions[sessionId].rtpPortReservations.map(x => this.platform.rtpPorts.freePort(x));
      }

      // Delete the entries.
      delete this.pendingSessions[sessionId];
      delete this.ongoingSessions[sessionId];

      // If we've completed all streaming sessions, restore any changed settings, such as bitrate, for HomeKit Secure Video.
      if(!this.ongoingSessions.length) {

        if(this.hksv?.isRecording) {

          // Restart the timeshift buffer now that we've stopped streaming.
          await this.hksv.restartTimeshifting();
        } else if(this.savedBitrate) {

          // Restore our original bitrate.
          if(this.rtspEntry) {

            await this.protectCamera.setBitrate(this.rtspEntry.channel.id, this.savedBitrate);
          }

          this.savedBitrate = 0;
        }
      }

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
    this.probesizeOverride = (this.probesizeOverride ? this.probesizeOverride : this.protectCamera.hints.probesize) * 2;

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

  // Translate HomeKit H.264 level information for FFmpeg.
  public getH264Level(level: H264Level): string {

    switch(level) {

      case H264Level.LEVEL3_1:

        return "3.1";
        break;

      case H264Level.LEVEL3_2:

        return "3.2";
        break;

      case H264Level.LEVEL4_0:

        return "4.0";
        break;

      default:

        return "3.1";
        break;
    }
  }

  // Translate HomeKit H.264 profile information for FFmpeg.
  public getH264Profile(profile: H264Profile): string {

    switch(profile) {

      case H264Profile.BASELINE:

        return "baseline";
        break;

      case H264Profile.HIGH:

        return "high";
        break;

      case H264Profile.MAIN:

        return "main";
        break;

      default:

        return "main";
        break;
    }
  }

  // Determine the video encoder to use when transcoding.
  private getVideoEncoderOptions(): string[] {

    // Default to the tried-and-true libx264. We use the following options by default:
    //
    // -pix_fmt yuvj420p             Use the yuvj420p pixel format, which is what Protect uses.
    // -preset veryfast              Use the veryfast encoding preset in libx264, which provides a good balance of encoding
    //                               speed and quality.
    let encoder = "libx264";
    let encoderOptions = "-pix_fmt yuvj420p -preset veryfast";

    // If the user has specified a video encoder, let's use it.
    if(this.config.videoEncoder) {

      encoder = this.config.videoEncoder;
    }

    // If we've enabled hardware-accelerated transcoding, Let's deduce what we are running on, and select encoder options accordingly.
    if(this.protectCamera.hints.hardwareTranscoding) {

      this.protectCamera.hasHwAccel = true;

      switch(platform) {

        case "darwin":

          // h264_videotoolbox is the macOS hardware encoder API. We use the following options by default:
          //
          // -pix_fmt nv12           videotoolbox doesn't support the full yuvj420p pixel format, so we use nv12 to get us close.
          // -coder cabac            Use the cabac encoder for better video quality with the encoding profiles we use in HBUP.
          encoder = "h264_videotoolbox";
          encoderOptions = "-pix_fmt nv12 -coder cabac";
          break;

        default:

          // Back to software encoding.
          this.protectCamera.hasHwAccel = false;
          break;
      }
    }

    return ["-vcodec", encoder, ...encoderOptions.split(" ")];
  }
}
