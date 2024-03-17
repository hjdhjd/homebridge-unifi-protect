/* Copyright(C) 2017-2024, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-ffmpeg-record.ts: Provide FFmpeg process control to support HomeKit Secure Video.
 *
 */
import { ProtectCamera, RtspEntry } from "../devices/index.js";
import { CameraRecordingConfiguration } from "homebridge";
import { FfmpegProcess } from "./protect-ffmpeg.js";
import { once } from "node:events";

// FFmpeg HomeKit Streaming Video recording process management.
export class FfmpegRecordingProcess extends FfmpegProcess {

  private isLoggingErrors: boolean;
  private recordingBuffer: { data: Buffer, header: Buffer, length: number, type: string }[];

  // Create a new FFmpeg process instance.
  constructor(protectCamera: ProtectCamera, recordingConfig: CameraRecordingConfiguration, rtspEntry: RtspEntry, isAudioActive: boolean) {

    // Initialize our parent.
    super(protectCamera);

    // We want to log errors when they occur.
    this.isLoggingErrors = true;

    // Initialize our recording buffer.
    this.recordingBuffer = [];

    // -hide_banner     Suppress printing the startup banner in FFmpeg.
    // -nostats         Suppress printing progress reports while encoding in FFmpeg.
    // -fflags flags    Set the format flags to generate a presentation timestamp if it's missing and discard any corrupt packets rather than exit.
    this.commandLineArgs = [

      "-hide_banner",
      "-nostats",
      "-fflags", "+discardcorrupt+genpts"
    ];

    // If we're timeshifting, read from the timeshift buffer.
    if(protectCamera.hints.timeshift) {

      // Configure our video parameters for our input:
      //
      // -f mp4                      Tell ffmpeg that it should expect an MP4-encoded input stream.
      // -r fps                      Set the input frame rate for the video stream.
      // -i pipe:0                   Use standard input to get video data.
      this.commandLineArgs.push(

        "-f", "mp4",
        "-r", rtspEntry.channel.fps.toString(),
        "-i", "pipe:0"
      );

    } else {

      // We're not using the timeshift buffer, so let's use the RTSP stream as the input to HKSV.
      //
      // -probesize amount           How many bytes should be analyzed for stream information. We default to to analyze time should be spent analyzing
      //                             the input stream.
      // -max_delay 500000           Set an upper limit on how much time FFmpeg can take in demuxing packets.
      // -r fps                      Set the input frame rate for the video stream.
      // -rtsp_transport tcp         Tell the RTSP stream handler that we're looking for a TCP connection.
      // -i rtspEntry.url            RTSPS URL to get our input stream from.
      this.commandLineArgs.push(

        ...this.protectCamera.stream.ffmpegOptions.videoDecoder,
        "-probesize", this.protectCamera.stream.probesize.toString(),
        "-max_delay", "500000",
        "-r", rtspEntry.channel.fps.toString(),
        "-rtsp_transport", "tcp",
        "-i", rtspEntry.url
      );

    }

    // Configure our recording options for the video stream:
    //
    // -map 0:v:0                    Selects the first available video track from the stream. Protect actually maps audio
    //                               and video tracks in opposite locations from where FFmpeg typically expects them. This
    //                               setting is a more general solution than naming the track locations directly in case
    //                               Protect changes this in the future.
    //                               Yes, we included these above as well: they need to be included for every I/O stream to
    //                               maximize effectiveness it seems.
    // -reset_timestamps             Reset timestamps at the beginning of each segment.
    // -movflags flags               In the generated fMP4 stream: start a new fragment at each keyframe, write a blank MOOV box, and
    //                               avoid writing absolute offsets
    this.commandLineArgs.push(

      "-map", "0:v:0",
      ...this.protectCamera.stream.ffmpegOptions.recordEncoder(recordingConfig.videoCodec.resolution[0], recordingConfig.videoCodec.resolution[1],
        recordingConfig.videoCodec.resolution[2], recordingConfig.videoCodec.parameters.bitRate,
        recordingConfig.videoCodec.parameters.profile, recordingConfig.videoCodec.parameters.level,
        recordingConfig.videoCodec.parameters.iFrameInterval / 1000, rtspEntry.channel.fps),
      "-reset_timestamps", "1",
      "-movflags", "frag_keyframe+empty_moov+default_base_moof"
    );

    if(isAudioActive) {

      // Configure the audio portion of the command line. Options we use are:
      //
      // -map 0:a:0?                 Selects the first available audio track from the stream, if it exists. Protect actually maps audio and video tracks in opposite
      //                             locations from where FFmpeg typically expects them. This setting is a more general solution than naming the track locations directly
      //                             in case Protect changes this in the future.
      // -acodec copy                Copy the stream without reencoding it.
      this.commandLineArgs.push(

        "-map", "0:a:0?",
        "-acodec", "copy"
      );
    }

    // Configure our video parameters for outputting our final stream:
    //
    // -f mp4  Tell ffmpeg that it should create an MP4-encoded output stream.
    // pipe:1  Output the stream to standard output.
    this.commandLineArgs.push("-f", "mp4", "pipe:1");

    // Additional logging, but only if we're debugging.
    if(this.protectCamera.platform.verboseFfmpeg) {

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
    this.process?.stdout.on("data", dataListener = (buffer: Buffer): void => {

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

        // The MP4 container format is well-documented and designed around the concept of boxes. A box (or atom as they
        // used to be called), is at the center of an MP4 container. It's composed of an 8-byte header, followed by the data payload
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
        if(data.length < dataLength) {

          bufferRemaining = data;
          break;
        }

        // Add it to our queue to be eventually pushed out through our generator function.
        this.recordingBuffer.push({ data: data, header: header, length: dataLength, type: type });
        this.emit("mp4box");

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

  // Stop our FFmpeg process and cleanup after ourselves.
  protected stopProcess(): void {

    // Call our parent to get started.
    super.stopProcess();

    // Ensure that we clear out of our segment generator by guaranteeing an exit path.
    this.isEnded = true;
    this.emit("ffmpegStarted");
    this.emit("mp4box");
  }

  // Stop an FFmpeg process and cleanup.
  public stop(logErrors = this.isLoggingErrors): void {

    const savedLogErrors = this.isLoggingErrors;

    // Flag whether we should log abnormal exits (e.g. being killed) or not.
    this.isLoggingErrors = logErrors;

    // Call our parent to finish the job.
    super.stop();

    // Restore our previous logging state.
    this.isLoggingErrors = savedLogErrors;
  }

  // Log errors.
  protected logFfmpegError(exitCode: number, signal: NodeJS.Signals): void {

    // If we're ignoring errors, we're done.
    if(!this.isLoggingErrors) {

      return;
    }

    // Known HKSV-related errors due to occasional inconsistencies in the Protect livestream API.
    const ffmpegKnownHksvError = new RegExp(
      "(Invalid data found when processing input)|(Error splitting the input into NAL units\\.)|(Could not write header for output file #0)"
    );

    // See if we know about this error.
    if(this.stderrLog.some(x => ffmpegKnownHksvError.test(x))) {

      this.log.error("FFmpeg ended unexpectedly due to issues processing the media stream provided by the UniFi Protect livestream API. " +
        "This error can be safely ignored - they will occur occasionally.");
      return;
    }

    // Otherwise, revert to our default logging in our parent.
    super.logFfmpegError(exitCode, signal);
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

      // If the buffer is empty, wait for our FFmpeg process to produce more boxes.
      if(!this.recordingBuffer.length) {

        // eslint-disable-next-line no-await-in-loop
        await once(this, "mp4box");
      }

      // Grab the next fMP4 box from our buffer.
      const box = this.recordingBuffer.shift();

      // No fMP4 box, let's keep trying.
      if(!box) {

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
      // - a complete MOOF/MDAT pair. MOOF describes the sample locations and their sizes and MDAT contains the actual audio and video
      //   data related to that segment. This of MOOF as the audio/video data "header", and MDAT as the "payload".
      //
      // Once we see these, we combine all the segments in our queue to send back to HomeKit.
      if((box.type === "moov") || (box.type === "mdat")) {

        yield Buffer.concat(segment);
        segment = [];
      }
    }
  }
}
