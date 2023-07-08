<SPAN ALIGN="CENTER" STYLE="text-align:center">
<DIV ALIGN="CENTER" STYLE="text-align:center">

[![homebridge-unifi-protect: Native HomeKit support for UniFi Protect](https://raw.githubusercontent.com/hjdhjd/homebridge-unifi-protect/main/images/homebridge-unifi-protect.svg)](https://github.com/hjdhjd/homebridge-unifi-protect)

# Homebridge UniFi Protect

[![Downloads](https://img.shields.io/npm/dt/homebridge-unifi-protect?color=%230559C9&logo=icloud&logoColor=%23FFFFFF&style=for-the-badge)](https://www.npmjs.com/package/homebridge-unifi-protect)
[![Version](https://img.shields.io/npm/v/homebridge-unifi-protect?color=%230559C9&label=Homebridge%20UniFi%20Protect&logo=ubiquiti&logoColor=%23FFFFFF&style=for-the-badge)](https://www.npmjs.com/package/homebridge-unifi-protect)
[![UniFi Protect@Homebridge Discord](https://img.shields.io/discord/432663330281226270?color=0559C9&label=Discord&logo=discord&logoColor=%23FFFFFF&style=for-the-badge)](https://discord.gg/QXqfHEW)
[![verified-by-homebridge](https://img.shields.io/badge/homebridge-verified-blueviolet?color=%23491F59&style=for-the-badge&logoColor=%23FFFFFF&logo=homebridge)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)

## HomeKit support for the UniFi Protect ecosystem using [Homebridge](https://homebridge.io).
</DIV>
</SPAN>

`homebridge-unifi-protect` is a [Homebridge](https://homebridge.io) plugin that provides HomeKit support to the [UniFi Protect](https://unifi-network.ui.com/video-security) device ecosystem. [UniFi Protect](https://unifi-network.ui.com/video-security) is [Ubiquiti's](https://www.ui.com) video security platform, with rich camera, doorbell, and NVR controller hardware options for you to choose from, as well as an app which you can use to view, configure and manage your video camera and doorbells.

### UniFi Protect Realtime Updates API
So...how does UniFi Protect provide realtime updates? On UniFi OS-based controllers, it uses a websocket called `updates`. This connection provides a realtime stream of health, status, and events that the cameras encounter - including motion events and doorbell ring events.

Reverse engineering the realtime updates API is a bit more difficult than the system events API because it's based on a binary protocol. The Protect system events API is a steady stream of JSONs published on all UniFi OS controllers over the `system` websocket. It's used by more than just UniFi Protect, which makes it interesting for future exploration.

The Protect realtime updates API, however, is a binary protocol published over the `updates` websocket, and until now has been undocumented. I spent time analyzing what's happening in the Protect browser webUI as well as observing the controller and various Protect versions themselves to reverse engineer what's going on. Pouring through obfuscated code is like solving a puzzle with all the pieces in front of you - you know it's all there, you're just not always sure how it fits together.

For the impatient, you can take a look at the code for how to decode and read the binary protocol here in [protect-updates-api.ts](https://github.com/hjdhjd/homebridge-unifi-protect/blob/main/src/protect-updates-api.ts). Aside from Homebridge-specific logging support, the code is independent and portable to other platforms. You'll probably want to grab type and interface information from [protect-types.ts](https://github.com/hjdhjd/homebridge-unifi-protect/blob/main/src/protect-types.ts) as well.

I welcome any additions or corrections to the protocol for the benefit of the community. I hope this helps others launch their own exploration and create new and interesting Protect-enabled capabilities.

#### Non-Ubiquiti Apps Using the Protect API
This list represents all known apps that are using the realtime updates API for UniFi Protect. If you're using the information you discovered on this page for your own UniFi Protect-based solution, please open an issue and I'm happy to add a link to it below. I hope this can serve as a repository of sorts for UniFi Protect-based apps and solutions in the community.

 * [homebridge-unifi-protect](https://github.com/hjdhjd/homebridge-unifi-protect): Seamless integration of UniFi Protect into HomeKit with support for cameras, doorbells, and more.

#### Connecting
 * Login to the UniFi Protect controller and obtain the bootstrap JSON. The URL is: `https://protect-nvr-ip/proxy/protect/api/bootstrap`. You can look through [protect-api.ts](https://github.com/hjdhjd/homebridge-unifi-protect/blob/main/src/protect-api.ts) for a better understanding of the Protect login process and how to obtain the bootstrap JSON.
 * Open the websocket to the updates URL. The URL is: `wss://protect-nvr-ip/proxy/protect/ws/updates?lastUpdateId?lastUpdateId=X`. You can grab lastUpdateId from the bootstrap JSON in the prior step. You can [see an example in protect-api.ts](https://github.com/hjdhjd/homebridge-unifi-protect/blob/1d0d28a8b020878ee8f478244bed7ec361b33779/src/protect-api.ts#L225).
 * Then you're ready to listen to messages. You can see an [example of this in protect-nvr.ts](https://github.com/hjdhjd/homebridge-unifi-protect/blob/1d0d28a8b020878ee8f478244bed7ec361b33779/src/protect-nvr.ts#L408).

Those are the basics and gets us up and running. Now, to explain how the updates API works...

#### Updates Websocket Binary Format
UniFi OS update data packets are used to provide a realtime stream of updates to Protect. It differs from the system events API in that the system events API appears to be shared across other applications (Network, Access, etc.) while the updates events API appears to only be utilized by Protect and not shared by other applications, although the protocol is shared.

The `updates` websocket is used by the UniFi Protect webUI and native applications to provide realtime updates back to the controller. UniFi cameras and doorbells also use a websocket to provide those same updates to the Protect controller. The `updates` websocket uses a binary protocol to encode data largely to minimize bandwidth requirements, and provide access to more than JSON data, if needed.

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

Let's look at each of these.

##### Header Frame
The header frame is required overhead since websockets provide only a transport medium. It's purpose is to tell us what's coming in the frame that follows.

A packet header is composed of 8 bytes in this order:

| Byte Offset    |  Description    | Bits    | Values
|----------------|-----------------|---------|-----------------------------------------
| 0              | Packet Type     | 8       | 1 - action frame, 2 - payload frame.
| 1              | Payload Format  | 8       | 1 - JSON object, 2 - UTF8-encoded string, 3 - Node Buffer.
| 2              | Deflated        | 8       | 0 - uncompressed, 1 - deflated / compressed ([zlib](https://nodejs.org/api/zlib.html)-based).
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

##### Data Frame
The final part of the update packet is the data frame. The data frame can be three different types of data - although in practice, JSONs are all that come across, I've found. Those types are:

| Payload Type |  Description
|--------------|------------------------------------------------------------------------------------
| 1            | JSON. If the action frame's `action` property is set to `update` and the `modelKey` property is not set to `event` (e.g. `camera`), this will **always** a subset of the [configuration bootstrap JSON](https://github.com/hjdhjd/homebridge-unifi-protect/blob/1d0d28a8b020878ee8f478244bed7ec361b33779/src/protect-types.ts#L6).
| 2            | A UTF8-encoded string.
| 3            | Node Buffer.

#### Tips
 * `update` actions are always tied to any valid modelKey that exists in the bootstrap JSON. The exception is `events` which is tied to the Protect events history list that it maintains. The supported modelKeys from the bootstrap JSON are: `bridge`, `camera`, `group`, `light`, `liveview`, `nvr`, `sensor`, `user`, and `viewer`.
 * `add` actions are always tied to the `event` modelKey and indicate the beginning of an event item in the Protect events list. A subsequent `update` action is sent signaling the end of the event capture, and it's confidence score for motion detection.
 * This is **not** the same thing as motion detection. If you want to detect motion, you should watch the `update` action for `camera` modelKeys, and look for a JSON that updates `lastMotion`. For doorbell rings, `lastRing`. The Protect events list is useful for the Protect app, but it's of limited utility to HomeKit, and it's slow relative to just looking for the `lastMotion` JSON that tends to be much more timely in its delivery. If you want true realtime updates, you want to look at the `update` action.
 * JSONs are only payload type that seems to be sent, although the protocol is designed to accept all three.
 * With the exception of `update` actions with a `modelKey` of `event`, JSONs are always a subset of the bootstrap JSON, indexed off of `modelKey`. So for a `modelKey` of `camera`, the data payload is always a subset of ProtectCameraConfigInterface (see [protect-types.ts](https://github.com/hjdhjd/homebridge-unifi-protect/blob/1d0d28a8b020878ee8f478244bed7ec361b33779/src/protect-types.ts#L108)).
