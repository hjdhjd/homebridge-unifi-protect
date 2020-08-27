/* Copyright(C) 2017-2020, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-rtp.ts: RTP-related utilities to slice and dice RTP streams.
 *
 * This module is heavily inspired by the homebridge and homebridge-camera-ffmpeg source code and
 * borrows heavily from both. Thank you for your contributions to the HomeKit world.
 */
import { createSocket } from "dgram";
import getPort from "get-port";
import { Logging } from "homebridge";
import { ProtectStreamingDelegate } from "./protect-stream";
import { PROTECT_TWOWAY_HEARTBEAT_INTERVAL } from "./settings";

// What this function does is create two socket pipes to split traffic coming in from serverPort and
// pipe it out to returnAudioPort and twowayAudioPort.
//
// In order to support two-way audio, we send out the inbound RTP traffic from serverPort to twowayAudioPort.
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
  private serverPort: number;
  public readonly socket;

  // Create an instance of RTPSplitter.
  constructor(streamingDelegate: ProtectStreamingDelegate, ipFamily: ("ipv4" | "ipv6") , serverPort: number, returnAudioPort: number, twowayAudioPort: number) {

    this.debug = streamingDelegate.debug;
    this.delegate = streamingDelegate;
    this.log = streamingDelegate.log;
    this.name = streamingDelegate.name;
    this.serverPort = serverPort;
    this.socket = createSocket(ipFamily === "ipv6" ? "udp6" : "udp4" );

    // Catch errors when they happen on our splitter.
    this.socket.on("error", (error)  => {
      this.log("%s: RTPSplitter Error: %s", this.name, error);
      this.socket.close();
    });

    // Split the message into RTP and RTCP packets.
    this.socket.on("message", (msg) => {

      // Send RTP packets to the return audio port.
      if(this.isRtpMessage(msg)) {
        this.socket.send(msg, twowayAudioPort, "127.0.0.1");
      } else {

        // Save this RTCP message for heartbeat purposes for the return audio port.
        this.heartbeatMsg = Buffer.from(msg);

        // Clear the old heartbeat timer.
        clearTimeout(this.heartbeatTimer);
        this.heartbeat(twowayAudioPort);

        // RTCP control packets should go to the RTCP port.
        this.socket.send(msg, returnAudioPort, "127.0.0.1");
      }
    });

    this.debug("%s: Creating an RtpSplitter instance - inbound port: %s, twoway audio port: %s, return audio port: %s.",
      this.name, this.serverPort, twowayAudioPort, returnAudioPort);

    // Take the socket live.
    this.socket.bind(this.serverPort);
  }

  // Send a regular heartbeat to FFmpeg to ensure the pipe remains open and the process alive.
  private heartbeat(port: number): void {

    // Clear the old heartbeat timer.
    clearTimeout(this.heartbeatTimer);

    // Send a heartbeat to FFmpeg every 3.5 seconds to keep things open. FFmpeg has a five-second timeout
    // in reading input, and we want to be comfortably within the margin for error to ensure the process
    // continues to run.
    const self = this;
    this.heartbeatTimer = setTimeout(() => {
      this.debug("Sending ffmpeg a heartbeat.");

      self.socket.send(self.heartbeatMsg, port, "127.0.0.1");
      self.heartbeat(port);
    }, PROTECT_TWOWAY_HEARTBEAT_INTERVAL * 1000);
  }

  // Close the socket and cleanup.
  close(): void {
    this.debug("%s: Closing the RtpSplitter instance on port %s.", this.name, this.serverPort);

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

// RTP-related utilities.
export class RtpUtils {

  // Reserve consecutive ports for use with FFmpeg. FFmpeg currently lacks the ability to specify both the RTP
  // and RTCP ports. It always assumes, by convention, that when you specify an RTP port, the RTCP port is the
  // RTP port + 1. In order to work around that challenge, we need to always ensure that when we reserve multiple
  // ports for RTP (primarily for two-way audio) that we we are reserving consecutive ports only.
  public static async reservePorts(count = 1): Promise<number[]> {

    // Get the first port.
    const port = await getPort();
    const ports = [port];

    // If we're requesting additional consecutive ports, keep searching until they're found.
    for(let i = 1; i < count; i++) {
      const targetConsecutivePort = port + i;
      const openPort = await getPort({ port: targetConsecutivePort });

      // Unable to reserve the next consecutive port. Roll the dice again and hope for the best.
      if(openPort !== targetConsecutivePort) {
        return this.reservePorts(count);
      }

      ports.push(openPort);
    }

    return ports;
  }
}