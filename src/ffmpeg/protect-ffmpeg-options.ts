/* Copyright(C) 2023-2024, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-ffmpeg-options.ts: FFmpeg decoder and encoder options with hardware-accelerated codec support where available.
 */
import { H264Level, H264Profile } from "homebridge";
import { PROTECT_HOMEKIT_STREAMING_HEADROOM, PROTECT_RPI_GPU_MINIMUM } from "../settings.js";
import { ProtectCamera } from "../devices/index.js";
import { ProtectLogging } from "../protect-types.js";
import { ProtectPlatform } from "../protect-platform.js";

interface EncoderOptions {

  bitrate: number,
  fps: number,
  height: number,
  idrInterval: number,
  inputFps: number,
  level: H264Level,
  profile: H264Profile,
  useSmartQuality?: boolean,
  width: number
}

export class FfmpegOptions {

  private readonly hwPixelFormat: string[];
  private readonly log: ProtectLogging;
  private readonly platform: ProtectPlatform;
  private readonly protectCamera: ProtectCamera;

  // Create an instance of a HomeKit streaming delegate.
  constructor(protectCamera: ProtectCamera) {

    this.hwPixelFormat = [];
    this.log = protectCamera.log;
    this.platform = protectCamera.platform;
    this.protectCamera = protectCamera;

    // Configure our hardware acceleration support.
    this.configureHwAccel();
  }

  // Determine the video encoder to use when transcoding.
  private configureHwAccel(): boolean {

    let logMessage = "";

    // Utility to return which hardware acceleration features are currently available to us.
    const accelCategories = (): string => {

      const categories = [];

      if(this.protectCamera.hints.hardwareDecoding) {

        categories.push("decoding");
      }

      if(this.protectCamera.hints.hardwareTranscoding) {

        categories.push("transcoding");
      }

      return categories.join(" and ");
    };

    // Hardware-accelerated decoding is enabled by default, where supported. Let's select the decoder options accordingly where supported.
    if(this.protectCamera.hints.hardwareDecoding) {

      // Utility function to check that we have a specific decoder codec available to us.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const validateDecoder = (codec: string, pixelFormat: string[]): boolean => {

        if(!this.platform.codecSupport.hasDecoder("h264", codec)) {

          this.log.error("Unable to enable hardware-accelerated decoding. Your video processor does not have support for the " + codec + " decoder. " +
            "Using software decoding instead.");

          this.protectCamera.hints.hardwareDecoding = false;
          return false;
        }

        this.hwPixelFormat.push(...pixelFormat);

        return true;
      };

      // Utility function to check that we have a specific decoder codec available to us.
      const validateHwAccel = (accel: string, pixelFormat: string[]): boolean => {

        if(!this.platform.codecSupport.hasHwAccel(accel)) {

          this.log.error("Unable to enable hardware-accelerated decoding. Your video processor does not have support for the " + accel + " hardware accelerator. " +
            "Using software decoding instead.");

          this.protectCamera.hints.hardwareDecoding = false;

          return false;
        }

        this.hwPixelFormat.push(...pixelFormat);

        return true;
      };

      switch(this.platform.hostSystem) {

        case "macOS.Apple":
        case "macOS.Intel":

          // Verify that we have hardware-accelerated decoding available to us.
          validateHwAccel("videotoolbox", ["videotoolbox_vld", "nv12", "yuv420p"]);
          break;

        case "raspbian":

          // If it's less than the minimum hardware GPU memory we need on an Raspberry Pi, we revert back to our default decoder.
          if(this.platform.codecSupport.gpuMem < PROTECT_RPI_GPU_MINIMUM) {

            this.log.info("Disabling hardware-accelerated %s. Adjust the GPU memory configuration on your Raspberry Pi to at least %s MB to enable it.",
              accelCategories(), PROTECT_RPI_GPU_MINIMUM);

            this.protectCamera.hints.hardwareDecoding = false;
            this.protectCamera.hints.hardwareTranscoding = false;

            return false;
          }

          // Verify that we have the hardware decoder available to us. Unfortunately, at the moment, it seems that hardware decoding is flaky, at best, on Raspberry Pi.
          // validateDecoder("h264_mmal", [ "mmal", "yuv420p" ]);
          // validateDecoder("h264_v4l2m2ml", [ "yuv420p" ]);
          this.protectCamera.hints.hardwareDecoding = false;

          break;

        default:

          // Back to software decoding unless we're on a known system that always supports hardware decoding.
          this.protectCamera.hints.hardwareDecoding = false;

          break;
      }
    }

    // If we've enabled hardware-accelerated transcoding, let's select the encoder options accordingly where supported.
    if(this.protectCamera.hints.hardwareTranscoding) {

      // Utility function to check that we have a specific encoder codec available to us.
      const validateEncoder = (codec: string): boolean => {

        if(!this.platform.codecSupport.hasEncoder("h264", codec)) {

          this.log.error("Unable to enable hardware-accelerated transcoding. Your video processor does not have support for the " + codec + " encoder. " +
            "Using software transcoding instead.");

          this.protectCamera.hints.hardwareTranscoding = false;

          return false;
        }

        return true;
      };

      switch(this.platform.hostSystem) {

        case "macOS.Apple":
        case "macOS.Intel":

          // Verify that we have the hardware encoder available to us.
          validateEncoder("h264_videotoolbox");

          // Validate that we have access to the AudioToolbox AAC encoder.
          if(!this.platform.codecSupport.hasEncoder("aac", "aac_at")) {

            this.log.error("Your video processor does not have support for the native macOS AAC encoder, aac_at. Will attempt to use libfdk_aac instead.");
          }

          break;

        case "raspbian":

          // Verify that we have the hardware encoder available to us.
          validateEncoder("h264_v4l2m2m");

          logMessage = "Raspberry Pi hardware acceleration will be used for livestreaming. " +
            "HomeKit Secure Video recordings are not supported by the hardware encoder and will use software transcoding instead";

          // Ensure we have the pixel format the Raspberry Pi GPU is expecting available to us, if it isn't already.
          if(!this.hwPixelFormat.includes("yuv420p")) {

            this.hwPixelFormat.push("yuv420p");
          }

          break;

        default:

          // Let's see if we have Intel QuickSync hardware decoding available to us.
          if(this.platform.codecSupport.hasHwAccel("qsv") &&
            this.platform.codecSupport.hasDecoder("h264", "h264_qsv") && this.platform.codecSupport.hasEncoder("h264", "h264_qsv")) {

            this.protectCamera.hints.hardwareDecoding = true;
            this.hwPixelFormat.push("qsv", "yuv420p");
            logMessage = "Intel Quick Sync Video";
          } else {

            // Back to software encoding.
            this.protectCamera.hints.hardwareDecoding = false;
            this.protectCamera.hints.hardwareTranscoding = false;
          }

          break;
      }
    }

    // Inform the user.
    if(this.protectCamera.hints.hardwareDecoding || this.protectCamera.hints.hardwareTranscoding) {

      this.protectCamera.logFeature("Video.Transcode.Hardware",
        "Hardware-accelerated " + accelCategories() + " enabled" + (logMessage.length ? ": " + logMessage : "") + ".");
    }

    // Encourage users to enable hardware accelerated transcoding on macOS.
    if(!this.protectCamera.hints.hardwareTranscoding && !this.protectCamera.accessory.context.packageCamera && this.platform.hostSystem.startsWith("macOS.")) {

      this.log.warn("macOS detected: consider enabling hardware acceleration (located under the video feature options section in the HBUP webUI) for even better " +
        "performance and an improved user experience.");
    }

    return this.protectCamera.hints.hardwareTranscoding;
  }

  // Return the audio encoder options to use when transcoding.
  public get audioEncoder(): string[] {

    // If we don't have libfdk_aac available to us, we're essentially dead in the water.
    let encoderOptions: string[] = [];

    // Utility function to return a default audio encoder codec.
    const defaultAudioEncoderOptions = (): string[] => {

      if(this.platform.codecSupport.hasEncoder("aac", "libfdk_aac")) {

        // Default to libfdk_aac since FFmpeg doesn't natively support AAC-ELD. We use the following options by default:
        //
        // -acodec libfdk_aac          Use the libfdk_aac encoder.
        // -afterburner 1              Increases audio quality at the expense of needing a little bit more computational power in libfdk_aac.
        // -eld_sbr 1                  Use spectral band replication to further enhance audio.
        // -eld_v2 1                   Use the enhanced low delay v2 standard for better audio characteristics.
        return [

          "-acodec", "libfdk_aac",
          "-afterburner", "1",
          "-eld_sbr", "1",
          "-eld_v2", "1"
        ];
      } else {

        return [];
      }
    };

    switch(this.platform.hostSystem) {

      case "macOS.Apple":
      case "macOS.Intel":

        // If we don't have audiotoolbox available, let's default back to libfdk_aac.
        if(!this.platform.codecSupport.hasEncoder("aac", "aac_at")) {

          encoderOptions = defaultAudioEncoderOptions();
          break;
        }

        // aac_at is the macOS audio encoder API. We use the following options:
        //
        // -acodec aac_at            Use the aac_at encoder on macOS.
        // -aac_at_mode cvbr         Use the constrained variable bitrate setting to allow the encoder to optimize audio, while remaining within the requested bitrates.
        encoderOptions = [

          "-acodec", "aac_at",
          "-aac_at_mode", "cvbr"
        ];

        break;

      default:

        encoderOptions = defaultAudioEncoderOptions();

        break;
    }

    return encoderOptions;
  }

  // Return the audio encoder to use when decoding.
  public get audioDecoder(): string {

    return "libfdk_aac";
  }

  // Return the video decoder options to use when decoding video.
  public get videoDecoder(): string[] {

    // Default to no special decoder options for inbound streams.
    let decoderOptions: string[] = [];

    // If we've enabled hardware-accelerated transcoding, let's select decoder options accordingly where supported.
    if(this.protectCamera.hints.hardwareDecoding) {

      switch(this.platform.hostSystem) {

        case "macOS.Apple":
        case "macOS.Intel":

          // h264_videotoolbox is the macOS hardware decoder and encoder API. We use the following options for decoding video:
          //
          // -hwaccel videotoolbox   Select Video Toolbox for hardware-accelerated H.264 decoding.
          decoderOptions = [

            "-hwaccel", "videotoolbox"
          ];

          break;

        case "raspbian":

          // h264_mmal is the preferred Raspberry Pi hardware decoder codec. We use the following options for decoding video:
          //
          // -c:v h264_mmal          Select the Multimedia Abstraction Layer codec for hardware-accelerated H.264 processing.
          decoderOptions = [

            // "-c:v", "h264_mmal"
          ];

          break;

        default:

          // h264_qsv is the Intel Quick Sync Video hardware encoder and decoder.
          //
          // -hwaccel qsv            Select Quick Sync Video to enable hardware-accelerated H.264 decoding.
          // -c:v h264_qsv           Select the Quick Sync Video codec for hardware-accelerated H.264 processing.
          decoderOptions = [

            "-hwaccel", "qsv",
            "-hwaccel_output_format", "qsv",
            "-c:v", "h264_qsv"
          ];

          break;
      }
    }

    return decoderOptions;
  }

  // Return the FFmpeg crop filter options, if configured to do so.
  public get cropFilter(): string {

    // If we haven't enabled cropping, tell the crop filter to do nothing.
    if(!this.protectCamera.hints.crop) {

      return "crop=w=iw*100:h=ih*100:x=iw*0:y=ih*0";
    }

    // Generate our crop filter based on what the user has configured.
    return "crop=" + [

      "w=iw*" + this.protectCamera.hints.cropOptions.width.toString(),
      "h=ih*" + this.protectCamera.hints.cropOptions.height.toString(),
      "x=iw*" + this.protectCamera.hints.cropOptions.x.toString(),
      "y=ih*" + this.protectCamera.hints.cropOptions.y.toString()
    ].join(":");
  }

  // Utility function to provide our default encoder options.
  private defaultVideoEncoderOptions(options: EncoderOptions): string[] {

    const videoFilters = [];

    // Default smart quality to true.
    if(options.useSmartQuality === undefined) {

      options.useSmartQuality = true;
    }

    // Set our FFmpeg video filter options:
    //
    // format=                     Set the pixel formats we want to target for output.
    videoFilters.push("format=" + [ ...new Set([ ...this.hwPixelFormat, "yuvj420p" ]) ].join("|"));

    // fps=fps=                    Use the fps filter to provide the frame rate requested by HomeKit. This has better performance characteristics for Protect
    //                             rather than using "-r". We only need to apply this filter if our input and output frame rates aren't already identical.
    if(options.fps !== options.inputFps) {

      videoFilters.push("fps=fps=" + options.fps.toString());
    }

    // scale=-2:min(ih\,height)    Scale the video to the size that's being requested while respecting aspect ratios and ensuring our final dimensions are
    //                             a power of two.
    videoFilters.push("scale=-2:min(ih\\," + options.height.toString() + ")");

    // Default to the tried-and-true libx264. We use the following options by default:
    //
    // -c:v libx264                  Use the excellent libx264 H.264 encoder by default, unless the user explicitly overrides it.
    // -preset veryfast              Use the veryfast encoding preset in libx264, which provides a good balance of encoding speed and quality.
    // -profile:v                    Use the H.264 profile that HomeKit is requesting when encoding.
    // -level:v                      Use the H.264 profile level that HomeKit is requesting when encoding.
    // -noautoscale                  Don't attempt to scale the video stream automatically.
    // -bf 0                         Disable B-frames when encoding to increase compatibility against occasionally finicky HomeKit clients.
    // -filter:v                     Set the pixel format and scale the video to the size we want while respecting aspect ratios and ensuring our final
    //                               dimensions are a power of two.
    // -g:v                          Set the group of pictures to the number of frames per second * the interval in between keyframes to ensure a solid
    //                               livestreamng exerience.
    // -bufsize size                 This is the decoder buffer size, which drives the variability / quality of the output bitrate.
    // -maxrate bitrate              The maximum bitrate tolerance, used with -bufsize. This provides an upper bound on bitrate, with a little bit extra to
    //                               allow encoders some variation in order to maximize quality while honoring bandwidth constraints.
    const encoderOptions = [

      // If the user has specified a video encoder, let's use it instead.
      "-c:v", this.platform.config.videoEncoder ?? "libx264",
      "-preset", "veryfast",
      "-profile:v", this.getH264Profile(options.profile),
      "-level:v", this.getH264Level(options.level),
      "-noautoscale",
      "-bf", "0",
      "-filter:v", videoFilters.join(", "),
      "-g:v", (options.fps * options.idrInterval).toString(),
      "-bufsize", (2 * options.bitrate).toString() + "k",
      "-maxrate", (options.bitrate + (options.useSmartQuality ? PROTECT_HOMEKIT_STREAMING_HEADROOM : 0)).toString() + "k"
    ];

    // Using libx264's constant rate factor mode produces generally better results across the board. We use a capped CRF approach, allowing libx264 to
    // make intelligent choices about how to adjust bitrate to achieve a certain quality level depending on the complexity of the scene being encoded, but
    // constraining it to a maximum bitrate to stay within the bandwidth constraints HomeKit is requesting.
    if(options.useSmartQuality) {

      // -crf 20                     Use a constant rate factor of 20, to allow libx264 the ability to vary bitrates to achieve the visual quality we
      //                             want, constrained by our maximum bitrate.
      encoderOptions.push("-crf", "20");
    } else {

      // For recording HKSV, we really want to maintain a tight rein on bitrate and don't want to freelance with perceived quality for two reasons - HKSV
      // is very latency sensitive and it's also very particular about bitrates and the specific format of the stream it receives. The second reason is that
      // HKSV typically requests bitrates of around 2000kbps, which results in a reasonably high quality recording, as opposed to the typical 2-300kbps
      // that livestreaming from the Home app itself generates. Those lower bitrates in livestreaming really benefit from the magic that using a good CRF value
      // can produce in libx264.
      encoderOptions.push("-b:v", options.bitrate.toString() + "k");
    }

    return encoderOptions;
  }

  // Return the video encoder options to use for HKSV.
  public recordEncoder(options: EncoderOptions): string[] {

    // We always disable smart quality when recording due to HomeKit's strict requirements here.
    options.useSmartQuality = false;

    // Generaly, we default to using the same encoding options we use to transcode livestreams, unless we have platform-specific quirks we need to address,
    // such as where we can have hardware-accelerated transcoded livestreaming, but not hardware-accelerated HKSV event recording. The other noteworthy
    // aspect here is that HKSV is quite specific in what it wants, and isn't vary tolerant of creative license in how you may choose to alter bitrate to
    // address quality. When we call our encoders, we also let them know we don't want any additional quality optimizations when transcoding HKSV events.
    switch(this.platform.hostSystem) {

      case "raspbian":

        // Raspberry Pi struggles with hardware-accelerated HKSV event recording due to issues in the FFmpeg codec driver, currently. We hope this improves
        // over time and can offer it to Pi users, or develop a workaround. For now, we default to libx264.
        return this.defaultVideoEncoderOptions(options);
        break;

      default:

        // By default, we use the same options for HKSV and streaming.
        return this.streamEncoder(options);
    }
  }

  // Return the video encoder options to use when transcoding.
  public streamEncoder(options: EncoderOptions): string[] {

    // Default smart quality to true.
    if(options.useSmartQuality === undefined) {

      options.useSmartQuality = true;
    }

    // In case we don't have a defined pixel format.
    if(!this.hwPixelFormat.length) {

      this.hwPixelFormat.push("yuvj420p");
    }

    // If we aren't hardware-accelerated, we default to libx264.
    if(!this.protectCamera.hints.hardwareTranscoding) {

      return this.defaultVideoEncoderOptions(options);
    }

    // If we've enabled hardware-accelerated transcoding, let's select encoder options accordingly.
    //
    // We begin by adjusting the maximum bitrate tolerance used with -bufsize. This provides an upper bound on bitrate, with a little bit extra to allow encoders some
    // variation in order to maximize quality while honoring bandwidth constraints.
    const adjustedMaxBitrate = options.bitrate + (options.useSmartQuality ? PROTECT_HOMEKIT_STREAMING_HEADROOM : 0);

    // Check the input and output frame rates to see if we need to change it.
    const useFpsFilter = options.fps !== options.inputFps;

    // Initialize our options.
    const encoderOptions = [];
    let videoFilters = [];

    // Set our FFmpeg video filter options:
    //
    // format=                     Set the pixel formats we want to target for output.
    videoFilters.push("format=" + this.hwPixelFormat.join("|"));

    // fps=fps=                    Use the fps filter to provide the frame rate requested by HomeKit. This has better performance characteristics for Protect
    //                             rather than using "-r". We only need to apply this filter if our input and output frame rates aren't already identical.
    if(useFpsFilter) {

      videoFilters.push("fps=fps=" + options.fps.toString());
    }

    // scale=-2:min(ih\,height)    Scale the video to the size that's being requested while respecting aspect ratios and ensuring our final dimensions are
    //                             a power of two.
    videoFilters.push("scale=-2:min(ih\\," + options.height.toString() + ")");

    // Crop the stream, if the user has requested it.
    if(this.protectCamera.hints.crop) {

      videoFilters.push(this.cropFilter);
    }

    switch(this.platform.hostSystem) {

      case "macOS.Apple":

        // h264_videotoolbox is the macOS hardware encoder API. We use the following options on Apple Silicon:
        //
        // -c:v                    Specify the macOS hardware encoder, h264_videotoolbox.
        // -allow_sw 1             Allow the use of the software encoder if the hardware encoder is occupied or unavailable.
        //                         This allows us to scale when we get multiple streaming requests simultaneously that might consume all the available encode engines.
        // -realtime 1             We prefer speed over quality - if the encoder has to make a choice, sacrifice one for the other.
        // -coder cabac            Use the cabac encoder for better video quality with the encoding profiles we use in HBUP.
        // -profile:v              Use the H.264 profile that HomeKit is requesting when encoding.
        // -level:v 0              We override what HomeKit requests for the H.264 profile level on macOS when we're using hardware-accelerated transcoding because
        //                         the hardware encoder is particular about how to use levels. Setting it to 0 allows the encoder to decide for itself.
        // -bf 0                   Disable B-frames when encoding to increase compatibility against occasionally finicky HomeKit clients.
        // -noautoscale            Don't attempt to scale the video stream automatically.
        // -filter:v               Set the pixel format, adjust the frame rate if needed, and scale the video to the size we want while respecting aspect ratios and
        //                         ensuring our final dimensions are a power of two.
        // -g:v                    Set the group of pictures to the number of frames per second * the interval in between keyframes to ensure a solid
        //                         livestreamng exerience.
        // -bufsize size           This is the decoder buffer size, which drives the variability / quality of the output bitrate.
        // -maxrate bitrate        The maximum bitrate tolerance used in concert with -bufsize to constrain the maximum bitrate permitted.
        encoderOptions.push(

          "-c:v", "h264_videotoolbox",
          "-allow_sw", "1",
          "-realtime", "1",
          "-coder", "cabac",
          "-profile:v", this.getH264Profile(options.profile),
          "-level:v", "0",
          "-bf", "0",
          "-noautoscale",
          "-filter:v", videoFilters.join(", "),
          "-g:v", (options.fps * options.idrInterval).toString(),
          "-bufsize", (2 * options.bitrate).toString() + "k",
          "-maxrate", adjustedMaxBitrate.toString() + "k"
        );

        if(options.useSmartQuality) {

          // -q:v 90               Use a fixed quality scale of 90, to allow videotoolbox the ability to vary bitrates to achieve the visual quality we want,
          //                       constrained by our maximum bitrate. This is an Apple Silicon-specific feature.
          encoderOptions.push("-q:v", "90");
        } else {

          // -b:v                  Average bitrate that's being requested by HomeKit.
          encoderOptions.push("-b:v", options.bitrate.toString() + "k");
        }

        return encoderOptions;

        break;

      case "macOS.Intel":

        // h264_videotoolbox is the macOS hardware encoder API. We use the following options on Intel-based Macs:
        //
        // -c:v                    Specify the macOS hardware encoder, h264_videotoolbox.
        // -allow_sw 1             Allow the use of the software encoder if the hardware encoder is occupied or unavailable.
        //                         This allows us to scale when we get multiple streaming requests simultaneously that might consume all the available encode engines.
        // -realtime 1             We prefer speed over quality - if the encoder has to make a choice, sacrifice one for the other.
        // -coder cabac            Use the cabac encoder for better video quality with the encoding profiles we use in HBUP.
        // -profile:v              Use the H.264 profile that HomeKit is requesting when encoding.
        // -level:v 0              We override what HomeKit requests for the H.264 profile level on macOS when we're using hardware-accelerated transcoding because
        //                         the hardware encoder is particular about how to use levels. Setting it to 0 allows the encoder to decide for itself.
        // -bf 0                   Disable B-frames when encoding to increase compatibility against occasionally finicky HomeKit clients.
        // -noautoscale            Don't attempt to scale the video stream automatically.
        // -filter:v               Set the pixel format, adjust the frame rate if needed, and scale the video to the size we want while respecting aspect ratios and
        //                         ensuring our final dimensions are a power of two.
        // -b:v                    Average bitrate that's being requested by HomeKit. We can't use a quality constraint and allow for more optimization of the bitrate
        //                         on Intel-based Macs due to hardware / API limitations.
        // -g:v                    Set the group of pictures to the number of frames per second * the interval in between keyframes to ensure a solid
        //                         livestreamng exerience.
        // -bufsize size           This is the decoder buffer size, which drives the variability / quality of the output bitrate.
        // -maxrate bitrate        The maximum bitrate tolerance used in concert with -bufsize to constrain the maximum bitrate permitted.
        return [

          "-c:v", "h264_videotoolbox",
          "-allow_sw", "1",
          "-realtime", "1",
          "-coder", "cabac",
          "-profile:v", this.getH264Profile(options.profile),
          "-level:v", "0",
          "-bf", "0",
          "-noautoscale",
          "-filter:v", videoFilters.join(", "),
          "-b:v", options.bitrate.toString() + "k",
          "-g:v", (options.fps * options.idrInterval).toString(),
          "-bufsize", (2 * options.bitrate).toString() + "k",
          "-maxrate", adjustedMaxBitrate.toString() + "k"
        ];

        break;

      case "raspbian":

        // h264_v4l2m2m is the preferred interface to the Raspberry Pi hardware encoder API. We use the following options:
        //
        // -c:v                    Specify the Raspberry Pi hardware encoder, h264_v4l2m2m.
        // -noautoscale            Don't attempt to scale the video stream automatically.
        // -filter:v               Set the pixel format, adjust the frame rate if needed, and scale the video to the size we want while respecting aspect ratios and
        //                         ensuring our final dimensions are a power of two.
        // -b:v                    Average bitrate that's being requested by HomeKit. We can't use a quality constraint and allow for more optimization of the bitrate
        //                         due to v4l2m2m limitations.
        // -g:v                    Set the group of pictures to the number of frames per second * the interval in between keyframes to ensure a solid
        //                         livestreamng exerience.
        // -bufsize size           This is the decoder buffer size, which drives the variability / quality of the output bitrate.
        // -maxrate bitrate        The maximum bitrate tolerance used in concert with -bufsize to constrain the maximum bitrate permitted.
        return [

          "-c:v", "h264_v4l2m2m",
          "-profile:v", this.getH264Profile(options.profile, true),
          "-bf", "0",
          "-noautoscale",
          "-reset_timestamps", "1",
          "-filter:v", videoFilters.join(", "),
          "-b:v", options.bitrate.toString() + "k",
          "-g:v", (options.fps * options.idrInterval).toString(),
          "-bufsize", (2 * options.bitrate).toString() + "k",
          "-maxrate", adjustedMaxBitrate.toString() + "k"
        ];

        break;

      default:

        // Clear out any prior video filters.
        videoFilters = [];

        // We execute the following GPU-accelerated operations using the Quick Sync Video post-processing filter:
        //
        // format=same             Set the output pixel format to the same as the input, since it's already in the GPU.
        // w=...:h...              Scale the video to the size that's being requested while respecting aspect ratios.
        videoFilters.push("vpp_qsv=" + [

          "format=same",
          "w=min(iw\\, (iw / ih) * " + options.height.toString() + ")",
          "h=min(ih\\, " + options.height.toString() + ")"
        ].join(":"));

        // fps=fps=                Use the fps filter to provide the frame rate requested by HomeKit. This has better performance characteristics for Protect
        //                         rather than using "-r". We only need to apply this filter if our input and output frame rates aren't already identical.
        if(useFpsFilter) {

          videoFilters.push("fps=fps=" + options.fps.toString());
        }

        // h264_qsv is the Intel Quick Sync Video hardware encoder API. We use the following options:
        //
        // -c:v                    Specify the macOS hardware encoder, h264_videotoolbox.
        // -profile:v              Use the H.264 profile that HomeKit is requesting when encoding.
        // -level:v 0              We override what HomeKit requests for the H.264 profile level when we're using hardware-accelerated transcoding because
        //                         the hardware encoder will determine which levels to use. Setting it to 0 allows the encoder to decide for itself.
        // -bf 0                   Disable B-frames when encoding to increase compatibility against occasionally finicky HomeKit clients.
        // -noautoscale            Don't attempt to scale the video stream automatically.
        // -init_hw_device         Initialize our hardware accelerator and assign it a name to be used in the FFmpeg command line.
        // -filter_hw_device       Specify the hardware accelerator to be used with our video filter pipeline.
        // -filter:v               Set the pixel format, adjust the frame rate if needed, and scale the video to the size we want while respecting aspect ratios and
        //                         ensuring our final dimensions are a power of two.
        // -g:v                    Set the group of pictures to the number of frames per second * the interval in between keyframes to ensure a solid
        //                         livestreamng exerience.
        // -bufsize size           This is the decoder buffer size, which drives the variability / quality of the output bitrate.
        // -maxrate bitrate        The maximum bitrate tolerance used in concert with -bufsize to constrain the maximum bitrate permitted.
        encoderOptions.push(

          "-c:v", "h264_qsv",
          "-profile:v", this.getH264Profile(options.profile),
          "-level:v", "0",
          "-bf", "0",
          "-noautoscale",
          "-init_hw_device", "qsv=hw",
          "-filter_hw_device", "hw",
          "-filter:v", videoFilters.join(", "),
          "-g:v", (options.fps * options.idrInterval).toString(),
          "-bufsize", (2 * options.bitrate).toString() + "k",
          "-maxrate", adjustedMaxBitrate.toString() + "k"
        );

        if(options.useSmartQuality) {

          // -global_quality 20    Use a global quality setting of 20, to allow QSV the ability to vary bitrates to achieve the visual quality we want,
          //                       constrained by our maximum bitrate. This leverages a QSV-specific feature known as intelligent constant quality.
          encoderOptions.push("-global_quality", "20");
        } else {

          // -b:v                  Average bitrate that's being requested by HomeKit.
          encoderOptions.push("-b:v", options.bitrate.toString() + "k");
        }

        return encoderOptions;

        break;
    }
  }

  // Use the host system information to determine which recording channel to use by default for HKSV.
  public get recordingDefaultChannel(): string | undefined {

    switch(this.platform.hostSystem) {

      case "raspbian":

        // For constrained CPU environments like Raspberry Pi, we default to recording from the highest quality channel we can, that's at or below 1080p. That provides
        // a reasonable default, while still allowing users who really want to, to be able to specify something else.
        return this.protectCamera.findRtsp(1920, 1080, { maxPixels: this.hostSystemMaxPixels })?.channel.name ?? undefined;

        break;

      default:

        // We default to no preference for the default Protect camera channel.
        return this.protectCamera.hints.hardwareTranscoding ? "High" : undefined;
    }
  }

  // Return the maximum pixel count supported by a specific hardware encoder on the host system.
  public get hostSystemMaxPixels(): number {

    if(this.protectCamera.hints.hardwareTranscoding) {

      switch(this.platform.hostSystem) {

        case "raspbian":

          // For constrained environments like Raspberry Pi, when hardware transcoding has been selected for a camera, we limit the available source streams to no more
          // than 1080p. In practice, that means that devices like the G4 Pro can't use their highest quality stream for transcoding due to the limitations of the
          // Raspberry Pi GPU that cannot support higher pixel counts.
          return 1920 * 1080;

          break;

        default:

          break;
      }
    }

    return Infinity;
  }

  // Translate HomeKit H.264 level information for FFmpeg.
  private getH264Level(level: H264Level, numeric = false): string {

    switch(level) {

      case H264Level.LEVEL3_1:

        return numeric ? "31" : "3.1";
        break;

      case H264Level.LEVEL3_2:

        return numeric ? "32" : "3.2";
        break;

      case H264Level.LEVEL4_0:

        return numeric ? "40" : "4.0";
        break;

      default:

        return numeric ? "31" : "3.1";
        break;
    }
  }

  // Translate HomeKit H.264 profile information for FFmpeg.
  private getH264Profile(profile: H264Profile, numeric = false): string {

    switch(profile) {

      case H264Profile.BASELINE:

        return numeric ? "66" : "baseline";
        break;

      case H264Profile.HIGH:

        return numeric ? "100" : "high";
        break;

      case H264Profile.MAIN:

        return numeric ? "77" : "main";
        break;

      default:

        return numeric ? "77" : "main";
        break;
    }
  }
}
