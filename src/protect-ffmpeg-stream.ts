/* Copyright(C) 2017-2024, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-ffmpeg-stream.ts: Provide FFmpeg process control to support HomeKit livestreaming.
 *
 */
import { ChildProcessWithoutNullStreams } from "child_process";
import { FfmpegProcess } from "./protect-ffmpeg.js";
import { ProtectStreamingDelegate } from "./protect-stream.js";
import { StreamRequestCallback } from "homebridge";
import { createSocket } from "node:dgram";

// FFmpeg streaming process management.
export class FfmpegStreamingProcess extends FfmpegProcess {

  private delegate: ProtectStreamingDelegate;
  private sessionId: string;
  private streamTimeout?: NodeJS.Timeout;

  // Create a new FFmpeg process instance.
  constructor(delegate: ProtectStreamingDelegate, sessionId: string, commandLineArgs: string[], returnPort?: { addressVersion: string, port: number },
    callback?: StreamRequestCallback) {

    // Initialize our parent.
    super(delegate.protectCamera);

    this.delegate = delegate;
    this.sessionId = sessionId;

    // Create the return port for FFmpeg, if requested to do so. The only time we don't do this is when we're standing up
    // a two-way audio stream - in that case, the audio work is done through RtpSplitter and not here.
    if(returnPort) {

      this.createSocket(returnPort);
    }

    // Start it up, with appropriate error handling.
    this.start(commandLineArgs, callback, async (errorMessage: string) => {

      // Stop the stream.
      await this.delegate.stopStream(this.sessionId);

      // Let homebridge know what happened and stop the stream if we've already started.
      if(!this.isStarted && this.callback) {

        this.callback(new Error(errorMessage));
        this.callback = null;
        return;
      }

      // Tell Homebridge to forcibly stop the streaming session.
      this.delegate.controller.forceStopStreamingSession(this.sessionId);
      void this.delegate.stopStream(this.sessionId);
    });
  }

  // Create the port for FFmpeg to send data through.
  private createSocket(portInfo: { addressVersion: string, port: number }): void {

    let errorListener: (error: Error) => void;
    let messageListener: () => void;
    const socket = createSocket(portInfo.addressVersion === "ipv6" ? "udp6" : "udp4");

    // Cleanup after ourselves when the socket closes.
    socket.once("close", () => {

      if(this.streamTimeout) {

        clearTimeout(this.streamTimeout);
      }

      socket.removeListener("error", errorListener);
      socket.removeListener("message", messageListener);
    });

    // Handle potential network errors.
    socket.on("error", errorListener = (error: Error): void => {

      this.log.error("Socket error: %s.", error.name);
      void this.delegate.stopStream(this.sessionId);
    });

    // Manage our video streams in case we haven't received a stop request, but we're in fact dead zombies.
    socket.on("message", messageListener = (): void => {

      // Clear our last canary.
      if(this.streamTimeout) {

        clearTimeout(this.streamTimeout);
      }

      // Set our new canary.
      this.streamTimeout = setTimeout(() => {

        this.log.debug("Video stream appears to be inactive for 5 seconds. Stopping stream.", this.protectCamera.name);

        this.delegate.controller.forceStopStreamingSession(this.sessionId);
        void this.delegate.stopStream(this.sessionId);
      }, 5000);
    });

    // Bind to the port we're opening.
    socket.bind(portInfo.port, (portInfo.addressVersion === "ipv6") ? "::1" : "127.0.0.1");
  }

  // Return the actual FFmpeg process.
  public get ffmpegProcess(): ChildProcessWithoutNullStreams | null {

    return this.process;
  }

  // Log errors.
  protected logFfmpegError(exitCode: number, signal: NodeJS.Signals): void {

    const probesizeRegex = new RegExp("not enough frames to estimate rate; consider increasing probesize");

    // Known streaming-related errors due to the performance and latency tweaks we've made to the FFmpeg command line.
    for(const line of this.stderrLog) {

      // Test for probesize errors.
      if(probesizeRegex.test(line)) {

        // Let the streaming delegate know to adjust it's parameters for the next run and inform the user.
        this.delegate.adjustProbeSize();
        return;
      }
    }

    // Otherwise, revert to our default logging in our parent.
    super.logFfmpegError(exitCode, signal);
  }
}
