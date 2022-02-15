/* Copyright(C) 2017-2022, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-ffmpeg-record.ts: Provide FFmpeg process control to support HomeKit Secure Video.
 *
 */
import { CameraRecordingConfiguration, H264Level, H264Profile } from "homebridge";
import { FfmpegProcess } from "./protect-ffmpeg";
import { ProtectCamera } from "./protect-camera";

// FFmpeg HomeKit Streaming Video recording process management.
export class FfmpegRecordingProcess extends FfmpegProcess {

  private recordingBuffer: { data: Buffer, header: Buffer, length: number, type: string }[];

  // Create a new FFmpeg process instance.
  constructor(device: ProtectCamera, recordingConfig: CameraRecordingConfiguration, isAudioActive: boolean) {

    // Initialize our parent.
    super(device);

    // Initialize our recording buffer.
    this.recordingBuffer = [];

    // Determine which H.264 profile HomeKit is expecting from us.
    const requestedProfile = (recordingConfig.videoCodec.parameters.profile === H264Profile.HIGH) ? "high"
      : (recordingConfig.videoCodec.parameters.profile === H264Profile.MAIN) ? "main" : "baseline";

    const requestedLevel = (recordingConfig.videoCodec.parameters.level === H264Level.LEVEL4_0) ? "4.0"
      : (recordingConfig.videoCodec.parameters.level === H264Level.LEVEL3_2) ? "3.2" : "3.1";

    // Configure our video parameters for transcoding:
    //
    // -hide_banner:                                         Suppress printing the startup banner in FFmpeg.
    // -f mp4                                                Tell ffmpeg that it should expect an MP4-encoded input stream.
    // -i pipe:0                                             Use standard input to get video data.
    // -map 0:v                                              Selects the first available video track from the stream. Protect actually maps audio
    //                                                       and video tracks in opposite locations from where FFmpeg typically expects them. This
    //                                                       setting is a more general solution than naming the track locations directly in case
    //                                                       Protect changes this in the future.
    // -vcodec libx264                                       Copy the stream withour reencoding it.
    // -pix_fmt yuvj420p                                     Use the yuvj420p pixel format, which is what Protect uses.
    // -profile:v high                                       Use the H.264 high profile when encoding, which provides for better stream quality and size efficiency.
    // -preset veryfast                                      Use the veryfast encoding preset in libx264, which provides a good balance of encoding speed and quality.
    // -b:v bitrate                                          The average bitrate to use for this stream. This is specified by HomeKit Secure Video.
    // -bufsize size                                         This is the decoder buffer size, which drives the variability / quality of the output bitrate.
    // -maxrate bitrate                                      The maximum bitrate tolerance, used with -bufsize. We set this to effectively create a constant bitrate.
    // -force_key_frames expr:gte(t, n_forced * 4)           Force a specific keyframe interval in the fMP4 stream we are generating.
    // -fflags +genpts                                       Generate a presentation timestamp (PTS) if there's a valid decoding timestamp (DTS) and PTS is missing.
    // -reset_timestamps 1                                   Reset timestamps at the beginning of each segment to make the generated segments easier to consume.
    // -movflags frag_keyframe+empty_moov+default_base_moof  Start a new fragment at each keyframe, send the MOOV box at the beginning of the stream, and avoid
    //                                                       writing absolute byte positions for the segments we send.
    this.commandLineArgs = [

      "-hide_banner",
      "-f", "mp4",
      "-i", "pipe:0",
      "-map", "0:v",
      "-vcodec", this.protectCamera.stream.videoEncoder || "libx264",
      "-pix_fmt", "yuvj420p",
      "-profile:v", requestedProfile,
      "-level:v", requestedLevel,
      "-preset", "veryfast",
      "-b:v", recordingConfig.videoCodec.parameters.bitRate.toString() + "k",
      "-bufsize", (2 * recordingConfig.videoCodec.parameters.bitRate).toString() + "k",
      "-maxrate", recordingConfig.videoCodec.parameters.bitRate.toString() + "k",
      "-force_key_frames", "expr:gte(t, n_forced * " + (recordingConfig.videoCodec.parameters.iFrameInterval / 1000).toString() + ")",
      "-fflags", "+genpts",
      "-reset_timestamps", "1",
      "-movflags", "frag_keyframe+empty_moov+default_base_moof"
    ];

    if(isAudioActive) {

      // Configure the audio portion of the command line. Options we use are:
      //
      // -map 0:a      Selects the first available audio track from the stream. Protect actually maps audio
      //               and video tracks in opposite locations from where FFmpeg typically expects them. This
      //               setting is a more general solution than naming the track locations directly in case
      //               Protect changes this in the future.
      // -acodec copy  Copy the stream withour reencoding it.
      this.commandLineArgs.push(

        "-map", "0:a",
        "-acodec", "copy"
      );
    }

    // Configure our video parameters for outputting our final stream:
    //
    // -f mp4  Tell ffmpeg that it should create an MP4-encoded output stream.
    // pipe:1  Output the stream to standard output.
    this.commandLineArgs.push("-f", "mp4", "pipe:1");

    // Additional logging, but only if we're debugging.
    if(device.platform.verboseFfmpeg) {

      this.commandLineArgs.unshift("-loglevel", "level+verbose");
    }

    // Start the FFmpeg session.
    this.start();
  }

  // Prepare and start our FFmpeg process.
  protected configureProcess(): void {

    let dataListener: (buffer: Buffer) => void;

    // Call our parent to get started.
    super.configureProcess();

    // Initialize our variables that we need to process incoming FFmpeg packets.
    let header = Buffer.alloc(0);
    let bufferRemaining = Buffer.alloc(0);
    let dataLength = 0;
    let type = "";

    // Process FFmpeg output and parse out the fMP4 stream it's generating for HomeKit Secure Video.
    this.process?.stdout?.on("data", dataListener = (buffer: Buffer): void => {

      // If we have anything left from the last buffer we processed, prepend it to this buffer.
      if(bufferRemaining.length > 0) {

        buffer = Buffer.concat([bufferRemaining, buffer]);
        bufferRemaining = Buffer.alloc(0);
      }

      let offset = 0;

      // FFmpeg is outputting an fMP4 stream that's suitable for HomeKit Secure Video. However, we can't just
      // pass this stream directly back to HomeKit since we're using a generator-based API to send packets back to
      // HKSV. Here, we take on the task of parsing the fMP4 stream that's being generated and split it up into the
      // MP4 boxes that HAP-NodeJS is ultimately expecting.
      for(;;) {

        let data;

        // The MP4 container format is well-documented format that is based around the concept of boxes. A box (or atom as they
        // used to be called), is at the center of the MP4 format. It's composed of an 8-byte header, followed by the data payload
        // it carries.

        // No existing header, let's start a new box.
        if(!header.length) {

          // Grab the header. The first four bytes represents the length of the entire box. Second four bytes represent the box type.
          header = buffer.slice(0, 8);

          // Now we retrieve the length of the box and subtract the length of the header to get the length of the data portion of the box.
          dataLength = header.readUInt32BE(0) - 8;

          // Get the type of the box. This is always a string and has a funky history to it that makes for an interesting read!
          type = header.slice(4).toString();

          // Finally, we get the data portion of the box.
          data = buffer.slice(8, dataLength + 8);
          offset = 8;
        } else {

          // Grab the data from our buffer.
          data = buffer.slice(0, dataLength);
          offset = 0;
        }

        // If we don't have enough data in this buffer, save what we have for the next buffer we see and append it there.
        if(data.length < (dataLength - offset)) {

          bufferRemaining = data;
          break;
        }

        // Add it to our queue to be eventually pushed out through our generator function.
        this.recordingBuffer.push({ data: data, header: header, length: dataLength, type: type });

        // Prepare to start a new box for the next buffer that we will be processing.
        data = Buffer.alloc(0);
        header = Buffer.alloc(0);
        type = "";

        // We've parsed an entire box, and there's no more data in this buffer to parse.
        if(buffer.length === (offset + dataLength)) {

          dataLength = 0;
          break;
        }

        // If there's anything left in the buffer, move us to the new box and let's keep iterating.
        buffer = buffer.slice(offset + dataLength);
        dataLength = 0;
      }
    });

    // Make sure we cleanup our listeners when we're done.
    this.process?.once("exit", () => {

      this.process?.stdout?.removeListener("data", dataListener);
    });
  }

  // Generate complete segments from an FFmpeg output stream that HomeKit Secure Video can process.
  public async *segmentGenerator(): AsyncGenerator<Buffer> {

    let segment: Buffer[] = [];

    // Loop forever, generating either FTYP/MOOV box pairs or MOOF/MDAT box pairs for HomeKit Secure Video.
    for(;;) {

      // FFmpeg has finished it's output - we're done.
      if(this.isEnded) {

        return;
      }

      // If we haven't seen any output from FFmpeg yet, sleep for a very short period of time to wait for it.
      // You might think there should be a longer sleep interval here, given the typical HKSV-requested segment
      // size, but since we have a several-second buffer that gets fed to FFmpeg on startup, FFmpeg is likely to
      // generate output very quickly after startup.
      if(!this.isStarted) {

        // eslint-disable-next-line no-await-in-loop
        await this.nvr.sleep(100);
        continue;
      }

      // Grab the next fMP4 box from our buffer.
      const box = this.recordingBuffer.shift();

      // If the buffer is empty, sleep for a second. We sleep a longer interval here because the buffer is likely
      // to populate no more than once a second, and in reality, more likely longer than that in most cases. Smaller
      // boxes (e.g. MOOF) will be buffered faster than larger ones like MDAT that carry the bulk of the audio / video
      // data.
      if(!box) {

        // eslint-disable-next-line no-await-in-loop
        await this.nvr.sleep(1000);
        continue;
      }

      // Queue up this fMP4 box to send back to HomeKit.
      segment.push(box.header, box.data);

      // What we want to send are two types of complete segments, made up of multiple MP4 boxes:
      //
      // - a complete MOOV box, usually with an accompanying FTYP box, that's sent at the very
      //   beginning of any valid fMP4 stream. HomeKit Secure Video looks for this before anything
      //   else.
      //
      // - a complete MOOF/MDAT pair. MOOF describes XXX and MDAT describes the actual audio and video
      //   data related to that segment.
      //
      // Once we see these, we combine all the segments in our queue to send back to HomeKit.
      if((box.type === "moov") || (box.type === "mdat")) {

        yield Buffer.concat(segment);
        segment = [];
      }
    }
  }
}
