<SPAN ALIGN="CENTER" STYLE="text-align:center">
<DIV ALIGN="CENTER" STYLE="text-align:center">

[![homebridge-unifi-protect: Native HomeKit support for UniFi Protect](https://raw.githubusercontent.com/hjdhjd/homebridge-unifi-protect/master/homebridge-protect.svg)](https://github.com/hjdhjd/homebridge-unifi-protect)

# Homebridge UniFi Protect

[![Downloads](https://img.shields.io/npm/dt/homebridge-unifi-protect2?color=%230559C9&logo=icloud&logoColor=%23FFFFFF&style=for-the-badge)](https://www.npmjs.com/package/homebridge-unifi-protect)
[![Version](https://img.shields.io/npm/v/homebridge-unifi-protect?color=%230559C9&label=UniFi%20Protect&logo=ubiquiti&logoColor=%23FFFFFF&style=for-the-badge)](https://www.npmjs.com/package/homebridge-unifi-protect)
[![verified-by-homebridge](https://img.shields.io/badge/homebridge-verified-blueviolet?color=%2357277C&style=for-the-badge)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)

## HomeKit support for the UniFi Protect ecosystem using [Homebridge](https://homebridge.io).
</DIV>
</SPAN>

`homebridge-unifi-protect` is a [Homebridge](https://homebridge.io) plugin that provides HomeKit support to the [UniFi Protect](https://unifi-network.ui.com/video-security) device ecosystem. [UniFi Protect](https://unifi-network.ui.com/video-security) is [Ubiquiti's](https://www.ui.com) next-generation video security platform, with rich camera, doorbell, and NVR controller hardware options for you to choose from, as well as an app which you can use to view, configure and manage your video camera and doorbells.

### Realtime Updates API
So...how does UniFi Protect provide realtime updates? On UniFi OS-based controllers, it uses a websocket called `updates`. This connection provides a realtime stream of health, status, and events that the cameras encounter - including motion events and doorbell ring events.

#### Connecting
 * Login to the UniFi Protect controller, obtain the bootstrap JSON. The URL is: `https://protect-nvr-ip/proxy/protect/api/bootstrap`.
 * Open the websocket to the updates URL. The URL is: `https://protect-nvr-ip/proxy/protect/ws/update?lastUpdateId?lastUpdateId=X`. You can grab lastUpdateId from the bootstrap JSON in the prior step. You can [see an example in protect-api.ts](https://github.com/hjdhjd/homebridge-unifi-protect/blob/373a7eed543e2cc6f6719122b7728cf8c0c9d238/src/protect-api.ts#L225).
 * Then you're ready to listen to messages. You can see an [example of this in protect-nvr.ts](https://github.com/hjdhjd/homebridge-unifi-protect/blob/373a7eed543e2cc6f6719122b7728cf8c0c9d238/src/protect-nvr.ts#L408).

Those are the basics and gets us up and running. Now, to explain how the updates API works...

#### Updates API Format
UniFi OS update data packets are used to provide a realtime stream of updates to Protect. It differs from the system events API in that the system events API appears to be shared across other applications (Network, Access, etc.) while the updates events API appears to only be utilized by Protect and not shared by other applications, although the protocol is shared.

So how does it all work? Cameras continuously stream updates to the UniFi Protect controller containing things like camera health, statistics, and - crucially for us - events such as motion and doorbell ring. A complete update packet is composed of four frames:

```sh
 Header Frame (8 bytes)
 ----------------------
 Action Frame
 ----------------------
 Header Frame (8 bytes)
 ----------------------
 Data Frame
```

##### Header Frame
The header frame is required overhead since websockets provide only a transport medium. It's purpose is to tell us what's coming in the frame that follows.

A packet header is composed of 8 bytes in this order:

| Byte Offset    |  Description    | Bits    | Values
|----------------|-----------------|---------|-----------------------------------------
| 0              | Packet Type     | 8       | 1 - action frame, 2 - payload frame.
| 1              | Payload Format  | 8       | 1 - JSON object, 2 - UTF8-encoded string, 3 - Node Buffer.
| 2              | Deflated        | 8       | 0 - uncompressed, 1 - deflated / compressed ([zlib](https://www.npmjs.com/package/zlib)-based).
| 3              | Unknown         | 8       | Always 0. Possibly reserved for future use by Ubiquiti?
| 4-7            | Payload Size    | 32      | Size of payload in network-byte order (big endian).

If the header has marked the payload as deflated (compressed), you'll need to inflate (uncompress) the payload before you can use it.

##### Action Frame
The action frame identifies what the action and category that the update contains:

| Property    |  Description
|-------------|------------------------------------------------------------------------------------
| action      |  What action is being taken. Known actions are `add` and `update`.
| id          |  The identifier for the device we're updating.
| modelKey    |  The device model category that we're updating.
| newUpdateId |  A new UUID generated on a per-update basis. This can be safely ignored it seems.

The final part of the update packet is the data frame. The data frame can be three different types of data - although in practice, I've only seen JSONs come across. Those types are:

| Payload Type |  Description
|--------------|------------------------------------------------------------------------------------
| 1            | JSON. If the action frame's `action` property is set to `update` and the `modelKey` property is not set to `event` (e.g. `camera`), this will **always** a subset of the [configuration bootstrap JSON](https://github.com/hjdhjd/homebridge-unifi-protect/blob/6743d06170f5cfb052db4d38244c1185c1c3b002/src/protect-types.ts#L6).
| 2            | A UTF8-encoded string.
| 3            | Node Buffer.

#### Tips
 * `update` actions are always tied to the following modelKeys: `camera`, `event`, `nvr`, and `user`.
 * `add` actions are always tied to the `event` modelKey and indicate the beginning of an event item in the Protect events list. A subsequent `update` action is sent signaling the end of the event capture, and it's confidence score for motion detection.
 * This is **not** the same thing as motion detection. If you want to detect motion, you should watch the `update` action for `camera` modelKeys, and look for a JSON that updates lastMotion. For doorbell rings, lastRing. The Protect events list is useful for the Protect app, but it's of limited utility to HomeKit, and it's slow relative to just looking for the lastMotion JSON that is. If you want true realtime updates, you want to look at the `update` action.
 * JSONs are only payload type that seems to be sent, although the protocol is designed to accept all three.
 * With the exception of `update` actions with a `modelKey` of `event`, JSONs are always a subset of the bootstrap JSON, indexed off of `modelKey`. So for a `modelKey` of `camera`, the data payload is always a subset of ProtectCameraConfigInterface (see [protect-types.ts](https://github.com/hjdhjd/homebridge-unifi-protect/blob/373a7eed543e2cc6f6719122b7728cf8c0c9d238/src/protect-types.ts#L108)).
