/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * stream-encode-policy.ts: the pure decisions of whether and how a live view's video is encoded, for UniFi Protect.
 *
 * Once the transport a live view draws from is settled (stream-source-policy.ts), three questions remain before an FFmpeg command line can be assembled: whether the
 * video is re-encoded at all, what source channel to ask the camera for, and - when we do re-encode - the exact encoder parameters. Each is a small decision over plain
 * facts about the HomeKit request and the camera, so all three live here as pure functions - no `this`, no I/O - and every cell is exhaustively unit-testable with
 * constructed inputs, matching the pure-module voice of stream-source-policy.ts, livestream-recovery-policy.ts, and resolution.ts. The streaming delegate keeps the
 * impure half: the `this`-state reads that feed these, the channel selection itself, and the FFmpeg argument rendering that consumes the results.
 *
 * The three results:
 *
 *   - TranscodeDecision: whether we re-encode, plus the high-latency reading of the connection that shapes the bitrate below.
 *   - ChannelRequest: the dimensions to hunt a source channel with, and whether to bias toward a richer one. The delegate makes the selection call itself, and the
 *     host's source-pixel cap it applies alongside the bias is a hardware capability rather than a decision, so that read stays there too.
 *   - VideoEncodingDecision: either a copy of the camera's own stream (carrying whether the fMP4 input needs its Annex B bitstream conversion) or a full
 *     encoder-options bag for homebridge-plugin-utils to render, plus the target bitrate the streaming-request log reports either way.
 *
 * Every bitrate this module accepts and returns is in kilobits per second. The camera's channel ceiling arrives from the controller in bits per second, so the delegate
 * converts before handing it over and the module stays unit-uniform.
 */
import type { H264Level, H264Profile, VideoEncoderOptions } from "homebridge-plugin-utils";
import { PROTECT_MAX_SOURCE_HEIGHT, PROTECT_MAX_SOURCE_WIDTH } from "../settings.ts";
import { HOMEKIT_IDR_INTERVAL } from "homebridge-plugin-utils";

// Whether this live view re-encodes the camera's video, and whether HomeKit negotiated a high-latency connection. The latency reading is returned alongside because the
// bitrate decision downstream consumes it, so it is derived once here rather than twice from the raw packet time.
export interface TranscodeDecision {

  isHighLatency: boolean;
  isTranscoding: boolean;
}

// What to ask the camera's channel selection for: the dimensions to match against, and whether to bias toward a richer channel than the target rather than the closest
// one at or below it.
export interface ChannelRequest {

  biasHigher: boolean;
  height: number;
  width: number;
}

// How the video reaches HomeKit. A "copy" passes the camera's own encode through untouched, and `transmux` states that the input is the livestream API's fMP4 and needs
// the Annex B bitstream conversion on the way out; a "transcode" carries the full encoder-options bag. The FFmpeg tokens for either arm are rendered by the delegate -
// this module decides, it does not spell command lines.
export type VideoEncoding = { mode: "copy"; transmux: boolean } |
  { encoderOptions: VideoEncoderOptions; mode: "transcode" };

// The resolved encoding decision: how the video is encoded, plus the target bitrate in kbps. The bitrate rides alongside rather than inside the transcode arm because
// the streaming-request log reports it for every session, copy-mode ones included.
export type VideoEncodingDecision = VideoEncoding & { targetBitrate: number };

/**
 * Resolve whether this live view's video is re-encoded, and read the connection's latency from the negotiated audio packet time. Pure and exhaustively testable.
 *
 * We transcode in the following circumstances:
 *
 *   1. The user has explicitly configured transcoding.
 *   2. The user has configured cropping for the video stream.
 *   3. We are on a high latency streaming session (e.g. cellular). If we're high latency, we'll transcode by default unless the user has asked us not to. Why? It
 *      generally results in a speedier experience, at the expense of some stream quality (HomeKit tends to request far lower bitrates than Protect is capable of
 *      producing).
 *   4. The codec in use on the Protect camera isn't H.264.
 *
 * How do we determine if we're a high latency connection? We look at the RTP packet time of the audio packet time for a hint. HomeKit uses values of 20, 30, 40, and
 * 60ms. We make an assumption, validated by lots of real-world testing, that when we see 60ms used by HomeKit, it's a high latency connection and act accordingly.
 *
 * @param input.crop                 - Whether the user has configured cropping for this camera's video stream.
 * @param input.packetTime           - The RTP audio packet time HomeKit negotiated for this session, in milliseconds.
 * @param input.transcode            - Whether the user has explicitly asked us to transcode this camera.
 * @param input.transcodeHighLatency - Whether high-latency transcoding is enabled for this camera.
 * @param input.videoCodec           - The camera's negotiated video codec; anything other than "h264" forces a transcode.
 *
 * @returns The resolved {@link TranscodeDecision}.
 */
export function resolveTranscodeDecision(input: { crop: boolean; packetTime: number; transcode: boolean; transcodeHighLatency: boolean;
  videoCodec: string; }): TranscodeDecision {

  const isHighLatency = input.packetTime >= 60;

  return {

    isHighLatency,
    isTranscoding: input.transcode || input.crop || (isHighLatency && input.transcodeHighLatency) || (input.videoCodec !== "h264")
  };
}

/**
 * Resolve the source channel to hunt for: the dimensions to match against, and whether to bias toward a richer channel. Pure and exhaustively testable.
 *
 * When the live encode runs on the host's hardware encoder we bias toward the highest-quality source the pipeline can ingest, because fixed-function encoders perform
 * better with higher-bitrate sources; a software encode is fed a source matched to the requested resolution instead, so the CPU cost tracks what HomeKit actually asked
 * for. A copy-mode session takes the requested dimensions with no bias at all - there is no encoder to feed, so the closest channel at or below the request is exactly
 * what we want.
 *
 * The single bias flag carries the whole "hunt a rich source under whatever ceiling this host can ingest" posture: the delegate reads it to decide whether to apply the
 * host's source-pixel cap alongside the bias, because the two are one posture rather than two independent choices.
 *
 * @param input.isTranscoding       - Whether this session re-encodes the video, from {@link resolveTranscodeDecision}.
 * @param input.requestHeight       - The frame height HomeKit requested, in pixels.
 * @param input.requestWidth        - The frame width HomeKit requested, in pixels.
 * @param input.usesHardwareEncoder - Whether this host encodes live video on hardware.
 *
 * @returns The resolved {@link ChannelRequest}.
 */
export function resolveChannelRequest(input: { isTranscoding: boolean; requestHeight: number; requestWidth: number; usesHardwareEncoder: boolean }): ChannelRequest {

  const wantsRichestSource = input.isTranscoding && input.usesHardwareEncoder;

  return {

    biasHigher: input.isTranscoding,
    height: wantsRichestSource ? PROTECT_MAX_SOURCE_HEIGHT : input.requestHeight,
    width: wantsRichestSource ? PROTECT_MAX_SOURCE_WIDTH : input.requestWidth
  };
}

/**
 * Resolve how this live view's video reaches HomeKit - copied straight from the camera, or re-encoded under a full set of encoder options - and the bitrate we target
 * either way. Pure and exhaustively testable.
 *
 * The ordered decision:
 *
 *   1. Target bitrate, seeded from what HomeKit asked for. A transcode honors the user's configured transcode bitrate when they have set one (the high-latency bitrate
 *      on a high-latency session), then comes down to the input channel's own ceiling if it is above it - we cannot produce more bitrate than the source carries. A
 *      copy passes the request through untouched, since the camera's own encode is what it is.
 *   2. Interpolation. When on high-performance hardware like Apple Silicon, using the TSB, and we don't have low-FPS cameras like the package camera, enable the use of
 *      the CPU-intensive FFmpeg minterpolate filter to enable very smooth video, especially when there's motion involved. M3+ Apple Silicon environments are able to
 *      reliably use this filter in realtime and with great results. I'm hoping to be able to enable this in the future for other platforms.
 *   3. The encoding itself. A transcode composes the encoder-options bag homebridge-plugin-utils renders, taking its frame rate from the source channel while
 *      interpolating (the filters resample to the rate HomeKit asked for). A copy reports only whether the input needs transmuxing.
 *
 * @param input.channelBitrate              - The selected source channel's bitrate ceiling, in kbps; the delegate converts it from the controller's bits per second.
 * @param input.channelFps                  - The selected source channel's frame rate.
 * @param input.cpuGeneration               - The host CPU's generation, as the platform's codec support detected it.
 * @param input.hostSystem                  - The host platform; only "macOS.Apple" admits interpolation today.
 * @param input.isHighLatency               - Whether HomeKit negotiated a high-latency session, from {@link resolveTranscodeDecision}.
 * @param input.isPackageCamera             - Whether this is the doorbell's package camera.
 * @param input.isTranscoding               - Whether this session re-encodes the video, from {@link resolveTranscodeDecision}.
 * @param input.requestBitrate              - The maximum bitrate HomeKit requested, in kbps.
 * @param input.requestFps                  - The frame rate HomeKit requested.
 * @param input.requestHeight               - The frame height HomeKit requested, in pixels.
 * @param input.requestLevel                - The H.264 level HomeKit requested.
 * @param input.requestProfile              - The H.264 profile HomeKit requested.
 * @param input.requestWidth                - The frame width HomeKit requested, in pixels.
 * @param input.transcodeBitrate            - The user's configured transcode bitrate, in kbps; zero leaves HomeKit's request in place.
 * @param input.transcodeHighLatencyBitrate - The user's configured high-latency transcode bitrate, in kbps; zero leaves HomeKit's request in place.
 * @param input.useTsb                      - Whether this session rides the timeshift buffer's pooled fMP4 socket rather than direct RTSP.
 *
 * @returns The resolved {@link VideoEncodingDecision}.
 */
export function resolveVideoEncoding(input: { channelBitrate: number; channelFps: number; cpuGeneration: number; hostSystem: string; isHighLatency: boolean;
  isPackageCamera: boolean; isTranscoding: boolean; requestBitrate: number; requestFps: number; requestHeight: number; requestLevel: H264Level;
  requestProfile: H264Profile; requestWidth: number; transcodeBitrate: number; transcodeHighLatencyBitrate: number; useTsb: boolean; }): VideoEncodingDecision {

  // 1. Set the initial bitrate we should use for this request based on what HomeKit is requesting.
  let targetBitrate = input.requestBitrate;

  if(input.isTranscoding) {

    // If we have specified the bitrates we want to use when transcoding, let's honor those here.
    if(input.isHighLatency && (input.transcodeHighLatencyBitrate > 0)) {

      targetBitrate = input.transcodeHighLatencyBitrate;
    } else if(!input.isHighLatency && (input.transcodeBitrate > 0)) {

      targetBitrate = input.transcodeBitrate;
    }

    // If we're targeting a bitrate that's beyond the capabilities of our input channel, match the bitrate of the input channel.
    if(targetBitrate > input.channelBitrate) {

      targetBitrate = input.channelBitrate;
    }
  }

  // 2. Decide whether to interpolate. See the ordered decision above for where this filter pays for itself and where it does not.
  const useInterpolationFilter = input.useTsb && !input.isPackageCamera && ((input.hostSystem === "macOS.Apple") && (input.cpuGeneration >= 3));

  // 3. Copy the camera's stream through when we are not transcoding; the livestream API's fMP4 is the one input that needs transmuxing on the way out.
  if(!input.isTranscoding) {

    return { mode: "copy", targetBitrate, transmux: input.useTsb };
  }

  return {

    encoderOptions: {

      bitrate: targetBitrate,
      fps: useInterpolationFilter ? input.channelFps : input.requestFps,
      height: input.requestHeight,
      idrInterval: HOMEKIT_IDR_INTERVAL,
      inputFps: input.channelFps,
      level: input.requestLevel,
      profile: input.requestProfile,
      // When interpolating, hand the encoder the fps and interpolation filters to smooth the presentation timestamps; it composes them into its own chain and bridges
      // any GPU-to-CPU download transfer itself.
      ...(useInterpolationFilter ? { videoFilters: [ "fps=" + input.requestFps.toString(),
        "minterpolate=fps=" + input.requestFps.toString() + ":mi_mode=mci:mc_mode=aobmc:me=fss:me_mode=bidir:vsbmc=1:scd=none" ] } : {}),
      width: input.requestWidth
    },
    mode: "transcode",
    targetBitrate
  };
}
