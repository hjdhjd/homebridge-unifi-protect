<SPAN ALIGN="CENTER" STYLE="text-align:center">
<DIV ALIGN="CENTER" STYLE="text-align:center">

[![homebridge-unifi-protect: Native HomeKit support for UniFi Protect](https://raw.githubusercontent.com/hjdhjd/homebridge-unifi-protect/main/images/homebridge-unifi-protect.svg)](https://github.com/hjdhjd/homebridge-unifi-protect)

# Homebridge UniFi Protect

[![Downloads](https://img.shields.io/npm/dt/homebridge-unifi-protect?color=%230559C9&logo=icloud&logoColor=%23FFFFFF&style=for-the-badge)](https://www.npmjs.com/package/homebridge-unifi-protect)
[![Version](https://img.shields.io/npm/v/homebridge-unifi-protect?color=%230559C9&label=Homebridge%20UniFi%20Protect&logo=ubiquiti&logoColor=%23FFFFFF&style=for-the-badge)](https://www.npmjs.com/package/homebridge-unifi-protect)
[![UniFi Protect@Homebridge Discord](https://img.shields.io/discord/432663330281226270?color=0559C9&label=Discord&logo=discord&logoColor=%23FFFFFF&style=for-the-badge)](https://discord.gg/QXqfHEW)
[![verified-by-homebridge](https://img.shields.io/badge/homebridge-verified-blueviolet?color=%23491F59&style=for-the-badge&logoColor=%23FFFFFF&logo=homebridge)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)

## Complete HomeKit support for the UniFi Protect ecosystem using [Homebridge](https://homebridge.io).
</DIV>
</SPAN>

`homebridge-unifi-protect` is a [Homebridge](https://homebridge.io) plugin that provides HomeKit support to the [UniFi Protect](https://ui.com/camera-security) device ecosystem. [UniFi Protect](https://ui.com/camera-security) is [Ubiquiti's](https://www.ui.com) video security platform, with rich camera, doorbell, and NVR controller hardware options for you to choose from, as well as an app which you can use to view, configure and manage your video camera and doorbells.

### Troubleshooting
If you're on this page, you're probably frustrated and trying to figure out why HBUP isn't working. I've tried to make `homebridge-unifi-protect` easy to configure and setup, and for the vast majority of users, things *just work*. But...you being here, lucky reader, means something's not working and you're trying to figure out why and how to get things going. This page is intended to help you walk through troubleshooting two key areas - getting HBUP connected to UniFi Protect, and streaming video from HomeKit using this plugin.

### Checklist
Before going further, there are some quick checklist activities you should check. You may have already looked at these, but sometimes it can help to revisit a checklist to go through and see if you missed something.

* Are you running a beta version of iOS, iPadOS, macOS, tvOS, or UniFi Protect?
  * If so, I'm afraid you're on your own. **`homebridge-unifi-protect` does not support any beta versions of Apple or Ubiquiti platforms**. Beta software is beta for a reason - it's under active development and often has bugs or issues. Ubiquiti's beta firmwares in particular, I've found, to vary wildly in usability and quality.

* Are you running on the latest versions of `Homebridge` and `homebridge-unifi-protect`?

* Are you running in a firewalled environment?
  * It's popular in some circles to have a separate network at home for your IoT devices . Unfortunately, this is also a common source of issues relating to video streaming, almost always related to firewall rules or mDNS issues.

* Have you reviewed the [best practices documentation](https://github.com/hjdhjd/homebridge-unifi-protect/blob/main/docs/BestPractices.md)?

### <A NAME="user"></A>Logging In and Permissions
Getting `homebridge-unifi-protect` connected to UniFi Protect is the foundational step you need to complete to begin using this plugin. When users have issues logging in, the challenges tend to be in the following areas:

* Have you specified the right hostname or IP address for the UniFi Protect controller?
  * For most people, I'd recommend using an IP address over a hostname. This provides you more certainty and eliminates another potential error vector (DNS / hostname resolution) from being a factor.

* Have you correctly entered the username and password of the local user account you've created for HBUP?

* Are you using a Ubiquiti cloud account to login and have two-factor authentication configured?
  * Unfortunately, `homebridge-unifi-protect` does not support two-factor authentication. See the [documentation to create a local user account on your UniFi Protect controller](https://github.com/hjdhjd/homebridge-unifi-protect/blob/main/README.md#prerequisites).

* You can login, but nothing seems to work, or you can't see any cameras.
  * This is almost certainly a permissions problem.
    * If you can see cameras in HomeKit, but can't stream video:
      * Look in the Homebridge logs, you should see messages suggesting that you enable the administrator role for the user you're using to login to Protect.
      * Granting the full management role to the user you use for this plugin will provide you the most streamlined experience with the least amount of manual configuration on your part, and I'd strongly encourage you to do so.
    * If you can't see any cameras in HomeKit:
      * Check to make sure the user you're using for `homebridge-unifi-protect` has at least the view-only role, but ideally you'd enable the full management role for the user you are using with this plugin.
      * Without either of those privileges, you won't be able to see any cameras without enabling a role.

### <A NAME="network"></A>Network Issues
If you run homebridge in Docker, or a VM or VM-like environment, you might run into a network issue without realizing it due to situations with multiple network interface cards (NICs). By default, Homebridge listens for HomeKit requests on all the network interfaces it finds when it starts up. Homebridge, not `homebridge-unifi-protect`, decides which interface to use when streaming video.

**If your symptoms are something along the lines of "snapshots work, but video streaming doesn't", it's almost certainly a network interface issue.**

[You will need to select the correct advertised network interface in Homebridge](https://github.com/homebridge/homebridge/wiki/mDNS-Options#how-to-select-advertised-network-interfaces).

**Note: Setting advertised network interfaces doesn't always work as expected.** The FFmpeg command will be unaware of this information and will choose whatever outbound IP the environment gives it. One way of checking this, if you have a Mac with the Home app, is to run `tcpdump` while you try to stream the camera. You should see entries such as

```
13:57:08.547540 IP 192.168.2.16.42572 > 192.168.0.55.55490: UDP, length 371
13:57:08.547542 IP 192.168.2.16.59594 > 192.168.0.55.62642: UDP, length 120
```

The ports will correspond to those seen in the `FFmpeg` command if you turn on verbose logging. If you are seeing no entries then chances are you have firewall or routing issues. If you are seeing entries, but no video is streaming, then this is likely that the Home App is not expecting the *source IP* to be what it is. In the above case, even though the only ***advertised*** port was the "other" ethernet, it was not arriving via that route. Changing the advertisment to match should fix this.

### <A NAME="video"></A>Video Streaming
There are lots of things that can go wrong with video streaming, unfortunately. I want to start by providing a bit of background on how streaming actually works in HomeKit, homebridge and this plugin before getting into where things can break.

#### Background
Read about [video autoconfiguration in HBUP](https://github.com/hjdhjd/homebridge-unifi-protect/blob/main/docs/Autoconfiguration.md) for a primer on how stream selection, transcoding, and transmuxing works in HBUP.

  * The key to HomeKit video streaming, is understanding that **HomeKit decides what quality it wants to request, not the end user, nor HBUP**. What this means in practice is that you have no control over what HomeKit requests and what it can handle in response to that request when it comes to video streaming size and quality. There are options in HBUP to override these quality settings, but I would encourage you to get up and running first before tweaking options.

  * UniFi Protect typically allows you to have up to three different RTSP streams available per camera (for most camera types). Each stream represents a different quality level - *High*, *Medium*, and *Low*, and you may choose to stream using any of them so long as they are enabled (HBUP [autoconfigures](https://github.com/hjdhjd/homebridge-unifi-protect/blob/main/docs/Autoconfiguration.md) all the available RTSP streams, if it has the permissions to do so in Protect).

When HomeKit requests a stream of a specific quality, HBUP selects a stream that's closest to what's being requested, and send that back to your device. You can see that when you look at the Homebridge logs:

```
Streaming request from 1.2.3.4: 1280x720@30fps, 299 kbps. Transcoding 1280x720@30fps (Medium), 2,000 kbps.
```

What the above means is that a HomeKit client, in this case an iPhone, is requesting a stream of quality 1280x720@30fps at a bitrate of 299kbps. In response, HBUP looks at the available RTSP streams on the camera, an AI Pro, and selected the `Medium` RTSP profile to use.

#### Video Streaming Issues
This brings us to where the problems people encounter can come from. When that stream comes from Protect to HBUP, it's processed by `FFmpeg` before being sent on it's way to your iPhone. I've taken time to tune the parameters used within FFmpeg for Protect to get things working just right. Despite that, it's not always perfect.

Almost all of the streaming issues that aren't one of the simpler ones described above (firewall rules, etc.) boil down to two related things:

 * The quality of the stream is pushing more data at a faster rate than either FFmpeg can consume or the HomeKit device can consume (or both!).
 * When transcoding, the hardware that HBUP is running on is unable to keep up with the requirements of the stream that's being pushed through it.

##### Use The Low Stream
While the defaults work for most users, most of the time, sometimes the specifics of your own environment will make things off *just enough* that streaming doesn't work. The first, and easiest, step in addressing it is simple: **force HBUP to use a lower stream quality**. You can do that by forcing the use of the `Low` RTSP stream in the HBUP feature options webUI under the video section. If this works, then you're done and your HomeKit life is once more complete and all is right with the world. You can experiment and see if the `Medium` RTSP stream works after you're up and running.

I know that instinctively people may not like the idea of having higher-end Protect cameras and using what they perceive to be a low-quality stream. To that, I'd say a couple of things...the quality of the stream is actually *very* good relative to the very conservative bitrates HomeKit tends to request. Those bitrates can be overriden by tweaking your feature options, but in general, lower quality video streaming is just the nature of the HomeKit beast, I'm afraid. For the purposes of glancing at video on occasion, it's more than sufficient.

##### Transcoding
Transcoding is used by HBUP to ensure that video streams are in the form that HomeKit expects when it comes to format, quality, and dimensions. HBUP will take the closest match it can find to the request from HomeKit and will transcode the video stream in realtime to match the parameters being requested by HomeKit. When transcoding, you'll see a log entry in Homebridge like this:

```
Streaming request from 1.2.3.4: 1280x720@30fps, 299 kbps. Transcoding 1280x720@30fps (Medium), 2,000 kbps.
```

Transcoding has two significant implications:

  * It will consume more CPU on the device where you run Homebridge. If your device is underpowered, it may struggle to use higher quality streams.
  * The quality of the final stream will be reduced to comply with HomeKit's requested parameters. This is because HomeKit defaults to a very modest bitrate - 299kbps in the above example versus the 2,000kbps being provided by Protect - which represents a 6.5x reduction in quality!

You can tune when HBUP chooses to transcode by adjusting the options under the video section of the HBUP feature options webUI. If you're struggling with potential CPU constraints in your environment, you can force the use of a lower stream quality which should reduce the CPU load on your hardware. I would recommend starting with the `Low` quality stream and working your way up when it comes to quality to see what works best in your environment.

##### Final Thoughts
For quickly trying to get things up and running when you're struggling, always start by forcing the stream quality to `Low`. From there, experiment with the options to tune it to your environment.
