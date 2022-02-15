/* Copyright(C) 2017-2022, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-ffmpeg-stream.ts: Provide FFmpeg process control to support HomeKit livestreaming.
 *
 */
import { FfmpegProcess, PortInterface } from "./protect-ffmpeg";
import { ChildProcessWithoutNullStreams } from "child_process";
import { ProtectStreamingDelegate } from "./protect-stream";
import { StreamRequestCallback } from "homebridge";
import { createSocket } from "dgram";

// FFmpeg streaming process management.
export class FfmpegStreamingProcess extends FfmpegProcess {

  private delegate: ProtectStreamingDelegate;
  private sessionId: string;
  private streamTimeout?: NodeJS.Timeout;

  // Create a new FFmpeg process instance.
  constructor(delegate: ProtectStreamingDelegate, sessionId: string, commandLineArgs: string[], returnPort?: PortInterface, callback?: StreamRequestCallback) {

    // Initialize our parent.
    super(delegate.protectCamera);

    this.delegate = delegate;
    this.sessionId = sessionId;

    // Create the return port for FFmpeg, if requested to do so. The only time we don't do this is when we're standing up
    // a two-way audio stream - in that case, the audio work is done through RtpSplitter and not here.
    if(returnPort) {

      this.createSocket(returnPort);
    }

    this.start(commandLineArgs, callback, async (errorMessage: string) => {

      // Stop the stream.
      await this.delegate.stopStream(this.sessionId);

      // Temporarily increase logging verbosity.
      this.delegate.setVerboseFfmpeg();

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
  private createSocket(portInfo: PortInterface): void {

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

      this.log.error("%s: Socket error: %s.", this.name(), error.name);
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

        this.debug("%s: video stream appears to be inactive for 5 seconds. Stopping stream.", this.name());

        this.delegate.controller.forceStopStreamingSession(this.sessionId);
        void this.delegate.stopStream(this.sessionId);
      }, 5000);
    });

    // Bind to the port we're opening.
    socket.bind(portInfo.port);
  }

  // Return the actual FFmpeg process.
  public get ffmpegProcess(): ChildProcessWithoutNullStreams | null {

    return this.process;
  }

}
