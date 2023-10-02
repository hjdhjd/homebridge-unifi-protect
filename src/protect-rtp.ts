/* Copyright(C) 2017-2023, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-rtp.ts: RTP-related utilities to slice and dice RTP streams.
 *
 * This module is heavily inspired by the homebridge and homebridge-camera-ffmpeg source code and
 * borrows heavily from both. Thank you for your contributions to the HomeKit world.
 */
import { EventEmitter, once } from "node:events";
import { PROTECT_TWOWAY_HEARTBEAT_INTERVAL } from "./settings.js";
import { ProtectLogging } from "./protect-types.js";
import { ProtectStreamingDelegate } from "./protect-stream.js";
import { createSocket } from "node:dgram";

/*
 * Here's the problem this class solves: FFmpeg doesn't support multiplexing RTP and RTCP data on a single UDP port (RFC 5761). If it did, we wouldn't need this
 * workaround for HomeKit compatibility, which does multiplex RTP and RTCP over a single UDP port.
 *
 * This class inspects all packets coming in from inputPort and demultiplexes RTP and RTCP traffic to rtpPort and rtcpPort, respectively.
 *
 * Credit to @dgreif and @brandawg93 who graciously shared their code as a starting point, and their collaboration in answering the questions needed to bring all this
 * together. A special thank you to @Sunoo for the many hours of discussion and brainstorming on this and other topics.
 */
export class RtpDemuxer extends EventEmitter {

  private delegate: ProtectStreamingDelegate;
  private heartbeatTimer!: NodeJS.Timeout;
  private heartbeatMsg!: Buffer;
  private _isRunning: boolean;
  private log: ProtectLogging;
  private inputPort: number;
  public readonly socket;

  // Create an instance of RtpDemuxer.
  constructor(streamingDelegate: ProtectStreamingDelegate, ipFamily: ("ipv4" | "ipv6") , inputPort: number, rtcpPort: number, rtpPort: number) {

    super();

    this._isRunning = false;
    this.delegate = streamingDelegate;
    this.log = streamingDelegate.log;
    this.inputPort = inputPort;
    this.socket = createSocket(ipFamily === "ipv6" ? "udp6" : "udp4" );

    // Catch errors when they happen on our demuxer.
    this.socket.on("error", (error)  => {

      this.log.error("RtpDemuxer Error: %s", error);
      this.socket.close();
    });

    // Split the message into RTP and RTCP packets.
    this.socket.on("message", (msg) => {

      // Send RTP packets to the RTP port.
      if(this.isRtpMessage(msg)) {

        this.emit("rtp");
        this.socket.send(msg, rtpPort);

      } else {

        // Save this RTCP message for heartbeat purposes for the RTP port. This works because RTCP packets will be ignored
        // by ffmpeg on the RTP port, effectively providing a heartbeat to ensure FFmpeg doesn't timeout if there's an
        // extended delay between data transmission.
        this.heartbeatMsg = Buffer.from(msg);

        // Clear the old heartbeat timer.
        clearTimeout(this.heartbeatTimer);
        this.heartbeat(rtpPort);

        // RTCP control packets should go to the RTCP port.
        this.socket.send(msg, rtcpPort);
      }
    });

    this.log.debug("Creating an RtpDemuxer instance - inbound port: %s, RTCP port: %s, RTP port: %s.", this.inputPort, rtcpPort, rtpPort);

    // Take the socket live.
    this.socket.bind(this.inputPort);
    this._isRunning = true;
  }

  // Send a regular heartbeat to FFmpeg to ensure the pipe remains open and the process alive.
  private heartbeat(port: number): void {

    // Clear the old heartbeat timer.
    clearTimeout(this.heartbeatTimer);

    // Send a heartbeat to FFmpeg every few seconds to keep things open. FFmpeg has a five-second timeout
    // in reading input, and we want to be comfortably within the margin for error to ensure the process
    // continues to run.
    this.heartbeatTimer = setTimeout(() => {

      this.log.debug("Sending ffmpeg a heartbeat.");

      this.socket.send(this.heartbeatMsg, port);
      this.heartbeat(port);

    }, PROTECT_TWOWAY_HEARTBEAT_INTERVAL * 1000);
  }

  // Close the socket and cleanup.
  public close(): void {

    this.log.debug("Closing the RtpDemuxer instance on port %s.", this.inputPort);

    clearTimeout(this.heartbeatTimer);
    this.socket.close();
    this._isRunning = false;
    this.emit("rtp");
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

  // Inform people whether we are up and running or not.
  public get isRunning(): boolean {

    return this._isRunning;
  }
}

/* RTP port allocator class that keeps track of UDP ports that are currently earmarked for use. We need this when allocating ports that we use for various network
 * activities such as demuxing FFmpeg or opening up other sockets. Otherwise, we run a risk (especially in environment where there are many such requests) of allocating
 * the same port multiple times and end up erroring out unceremoniously.
 */
export class RtpPortAllocator {

  private portsInUse: { [index: number]: boolean };

  // Instantiate our port retrieval.
  constructor() {

    // Initialize our in use tracker.
    this.portsInUse = {};
  }

  // Find an available UDP port by binding to one to validate it's availability.
  private async getPort(ipFamily: string, port = 0): Promise<number> {

    try {

      // Keep looping until we find what we're looking for: local UDP ports that are unspoken for.
      for(;;) {

        // Create a datagram socket, so we can use it to find a port.
        const socket = createSocket(ipFamily === "ipv6" ? "udp6" : "udp4");

        // Exclude this socket from Node's reference counting so we don't have issues later.
        socket.unref();

        // Listen for the bind event.
        const eventListener = once(socket, "listening");

        // Bind to the port in question. If port is set to 0, we'll get a randomly generated port generated for us.
        socket.bind(port);

        // Ensure we wait for the socket to be bound.
        // eslint-disable-next-line no-await-in-loop
        await eventListener;

        // Retrieve the port number we've gotten from the bind request.
        const assignedPort = socket.address().port;

        // We're done with the socket, let's cleanup.
        socket.close();

        // Check to see if the port is one we're already using. If it is, try again.
        if(this.portsInUse[assignedPort]) {

          continue;
        }

        // Now let's mark the port in use.
        this.portsInUse[assignedPort] = true;

        // Return the port.
        return assignedPort;
      }
    } catch(error) {

      return -1;
    }
  }

  // Reserve consecutive ports for use with FFmpeg. FFmpeg currently lacks the ability to specify both the RTP and RTCP ports.
  // FFmpeg always assumes, by convention, that when you specify an RTP port, the RTCP port is the RTP port + 1. In order to
  // work around that challenge, we need to always ensure that when we reserve multiple ports for RTP (primarily for two-way audio)
  // that we we are reserving consecutive ports only.
  public async reservePort(ipFamily: ("ipv4" | "ipv6") = "ipv4", portCount: (1 | 2) = 1, attempts = 0): Promise<number> {

    // Sanity check and make sure we're not requesting any more than two ports at a time, or if we've exceeded our attempt limit.
    if(((portCount !== 1) && (portCount !== 2)) || (attempts > 10)) {

      return -1;
    }

    let firstPort = 0;

    // Find the appropriate number of ports being requested.
    for(let i = 0; i < portCount; i++) {

      // eslint-disable-next-line no-await-in-loop
      const assignedPort = await this.getPort(ipFamily, firstPort ? firstPort + 1 : 0);

      // We haven't gotten a port, let's try again.
      if(assignedPort === -1) {

        // If we've gotten the first port of a pair of ports, make sure we release it here.
        if(firstPort) {

          this.freePort(firstPort);
        }

        // We still haven't found what we're looking for...keep looking.
        return this.reservePort(ipFamily, portCount, attempts++);
      }

      // We've seen the first port we may be looking for, let's save it.
      if(!firstPort) {

        firstPort = assignedPort;
      }
    }

    // Return the first port we've found.
    return firstPort;
  }

  // Delete a port reservation that's no longer needed.
  public freePort(port: number): void {

    delete this.portsInUse[port];
  }
}
