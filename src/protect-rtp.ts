/* Copyright(C) 2017-2020, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-rtp.ts: RTP-related utilities to slice and dice RTP streams.
 *
 * This module is heavily inspired by the homebridge and homebridge-camera-ffmpeg source code and
 * borrows heavily from both. Thank you for your contributions to the HomeKit world.
 */
import { createSocket } from "dgram";
import { Logging } from "homebridge";
import { ProtectStreamingDelegate } from "./protect-stream";

// What this function does is create two socket pipes to split traffic coming in from serverPort and
// pipe it out two audioRTCPPort and returnAudioPort.
//
// In order to support two-way audio, we send a complete copy of the inbound traffic from serverPort to
// returnAudioPort.
//
// For the audio channel that supports the video stream we're sending to the user, we only want to send the RTCP
// information, because that channel is receiving all it's data (audio and video) from the video stream. RTCP
// provides quality and statistics information back to HomeKit.
//
// Credit to @dgreif and @brandawg93 who graciously shared their code as a starting point, and their collaboration
// in answering the questions needed to bring all this together. A special thank you to @Sunoo for the many hours of
// discussion and brainstorming on this and other topics.
export class RtpSplitter {
  private debug: (message: string, ...parameters: any[]) => void;
  private delegate: ProtectStreamingDelegate;
  private heartbeatTimer!: NodeJS.Timeout;
  private heartbeatMsg!: Buffer;
  private log: Logging;
  private name: string;
  private inboundPort: number;
  public readonly socket;

  // Create an instance of RTPSplitter.
  constructor(streamingDelegate: ProtectStreamingDelegate, ipFamily: ("ipv4" | "ipv6") , serverPort: number, audioRTCPPort: number, returnAudioPort: number) {

    this.debug = streamingDelegate.debug;
    this.delegate = streamingDelegate;
    this.inboundPort = serverPort;
    this.log = streamingDelegate.log;
    this.name = streamingDelegate.name;
    this.socket = createSocket(ipFamily === "ipv6" ? "udp6" : "udp4" );

    // Catch errors when they happen on our splitter.
    this.socket.on("error", (error)  => {
      this.log("%s: RTPSplitter Error: %s", this.name, error);
      this.socket.close();
    });

    // Split the message into RTP and RTCP packets.
    this.socket.on("message", (msg) => {

      // Always send RTP and RTCP packets to both sides of the splitter.
      this.socket.send(msg, returnAudioPort, "127.0.0.1");

      // RTCP control packets should go to the RTCP port.
      if(!this.isRtpMessage(msg)) {

        // Save this RTCP message for heartbeat purposes.
        this.heartbeatMsg = Buffer.from(msg);

        // Clear the old heartbeat timer.
        clearTimeout(this.heartbeatTimer);
        this.heartbeat(returnAudioPort);

        this.socket.send(msg, audioRTCPPort, "127.0.0.1");
      }
    });

    this.debug("%s: Creating an RtpSplitter instance - inbound port: %s, return audio port: %s, audio RTCP port: %s.",
      this.name, this.inboundPort, returnAudioPort, audioRTCPPort);

    // Take the socket live.
    this.socket.bind(this.inboundPort);
  }

  // Send a regular heartbeat to FFmpeg to ensure the pipe remains open and the process alive.
  private heartbeat(returnAudioPort: number): void {

    // Clear the old heartbeat timer.
    clearTimeout(this.heartbeatTimer);

    // Send a heartbeat to FFmpeg every 3.5 seconds to keep things open. FFmpeg has a five-second timeout
    // in reading input, and we want to be comfortably within the margin for error to ensure the process
    // continues to run.
    const self = this;
    this.heartbeatTimer = setTimeout(() => {
      this.debug("Sending ffmpeg a heartbeat.");

      self.socket.send(self.heartbeatMsg, returnAudioPort, "127.0.0.1");
      self.heartbeat(returnAudioPort);
    }, 3.5 * 1000);
  }

  // Close the socket and cleanup.
  close(): void {
    this.debug("%s: Closing the RtpSplitter instance on port %s.", this.name, this.inboundPort);

    clearTimeout(this.heartbeatTimer);
    this.socket.close();
  }

  // Retrieve the payload information from a packet to discern what the packet payload is.
  private getPayloadType(message: Buffer): number {
    return message.readUInt8(1) & 0x7f;
  }

  // Return whether or not a packet is RTP (or not).
  private isRtpMessage(message: Buffer): boolean {
    const payloadType = this.getPayloadType(message);

    return (payloadType > 90) || (payloadType === 0);
  }
}
