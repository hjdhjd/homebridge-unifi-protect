<SPAN ALIGN="CENTER" STYLE="text-align:center">
<DIV ALIGN="CENTER" STYLE="text-align:center">

[![homebridge-unifi-protect: Native HomeKit support for UniFi Protect](https://raw.githubusercontent.com/hjdhjd/homebridge-unifi-protect/master/homebridge-protect.svg)](https://github.com/hjdhjd/homebridge-unifi-protect)

# Homebridge UniFi Protect

[![Downloads](https://img.shields.io/npm/dt/homebridge-unifi-protect?color=%230559C9&logo=icloud&logoColor=%23FFFFFF&style=for-the-badge)](https://www.npmjs.com/package/homebridge-unifi-protect)
[![Version](https://img.shields.io/npm/v/homebridge-unifi-protect?color=%230559C9&label=Homebridge%20UniFi%20Protect&logo=ubiquiti&logoColor=%23FFFFFF&style=for-the-badge)](https://www.npmjs.com/package/homebridge-unifi-protect)
[![UniFi Protect@Homebridge Discord](https://img.shields.io/discord/432663330281226270?color=0559C9&label=Discord&logo=discord&logoColor=%23FFFFFF&style=for-the-badge)](https://discord.gg/QXqfHEW)
[![verified-by-homebridge](https://img.shields.io/badge/homebridge-verified-blueviolet?color=%23491F59&style=for-the-badge&logoColor=%23FFFFFF&logo=homebridge)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)

## HomeKit support for the UniFi Protect ecosystem using [Homebridge](https://homebridge.io).
</DIV>
</SPAN>

`homebridge-unifi-protect` is a [Homebridge](https://homebridge.io) plugin that provides HomeKit support to the [UniFi Protect](https://unifi-network.ui.com/video-security) device ecosystem. [UniFi Protect](https://unifi-network.ui.com/video-security) is [Ubiquiti's](https://www.ui.com) next-generation video security platform, with rich camera, doorbell, and NVR controller hardware options for you to choose from, as well as an app which you can use to view, configure and manage your video camera and doorbells.

### Troubleshooting
If you're on this page, you're probably frustrated and trying to figure out why isn't this plugin working. I've tried hard to make `homebridge-unifi-protect` easy to configure and setup, and for the vast majority of users, things work quite well. But...you being here, lucky reader, means something's not working and you're trying to figure out why and how to get things going. This page is intended to help you walk through troubleshooting two key areas - getting `homebridge-unifi-protect` connected to UniFi Protect, and streaming video from HomeKit using this plugin.

### Checklist
Before going further, there are some quick checklist activities you should check. You may have already looked at these, but sometimes it can help to have a checklist to go through and see if you missed something.

* Are you running a beta version of iOS, iPadOS, macOS, tvOS, or UniFi Protect?
  * If so, I'm afraid you're on your own. **`homebridge-unifi-protect` does not support any beta versions of Apple or Ubiquiti platforms**. Beta software is beta for a reason - it's under active development and often has bugs or issues. Ubiquiti's beta firmwares in particular, I've found, to vary wildly in usability and quality.

* Are you running on the latest version of `homebridge` and `homebridge-unifi-protect`?

* Are you running in a firewalled environment?
  * It's popular in some circles to have a separate network at home for your IoT devices . Unfortunately, this is also a common source of issues relating to video streaming, almost always related to firewall rules.

### <A NAME="user"></A>Logging In and Permissions
Getting `homebridge-unifi-protect` connected to UniFi Protect is the foundational step you need to complete to begin using this plugin. When users have issues logging in, the challenges tend to be in the following areas:

* Have you specified the right IP address for UniFi Protect?
  * For most people, I'd recommend using an IP address over a hostname. This provides you more certainty and eliminates another potential error vector (DNS / hostname resolution) from being a factor.

* Have you correctly entered your username and password?
  * I know this is a basic one...but believe me, it happens to all of us more than you think!

* Are you using a Ubiquiti cloud account to login and have two-factor authentication configured?
  * Unfortunately, `homebridge-unifi-protect` does not support two-factor authentication currently. You can create an additional local user within UniFi Protect and use that to login.

* You can login, but nothing seems to work, or you can't see any cameras.
  * This is almost certainly a permissions problem.
    * If you can see cameras in HomeKit, but can't stream video:
      * Look in the homebridge logs, you should see messages suggesting that you enable the administrator role for the user you're using to login to Protect.
      * Granting the administrator role to the user you use for this plugin will provide you the most streamlined experience with the least amount of manual configuration on your part, and I'd strongly encourage you to do so.
    * If you can't see any cameras in HomeKit:
      * Check to make sure the user you're using for `homebridge-unifi-protect` has at least the view-only role, but ideally you'd enable the administrator role for the user you are using with this plugin.
      * Without either of those privileges, you won't be able to see any cameras without enabling a role.

### <A NAME="network"></A>Network Issues
If you run homebridge in Docker, or a VM or VM-like environment, you might run into a network issue without realizing it due to situations with multiple network interface cards (NICs). By default, Homebridge listens for HomeKit requests on all the network interfaces it finds when it starts up. Historically, this has created a challenge for video-streaming plugins like `homebridge-unifi-protect` because the plugin doesn't have a way of knowing which interface the streaming request came from. So what this plugin, and pretty much all the other similar plugins do, is guess by looking for the default network interface on the system and assuming that's where video should be sent out of.

The good news is that the leading camera plugin developers and the Homebridge developers have been collaborating on a solution for this, and as of Homebridge 1.1.3, Homebridge now takes over responsibility for determining which interface and IP address to use when streaming video. This is an ideal solution because Homebridge is really who knows where the request came from and is in the best position to determine which interface to use to stream from.

If you're having issues with this plugin, or others, not using the correct network interface, I'd encourage you to upgrade to Homebridge 1.1.3 or greater and see if that resolves the issue.

If that still doesn't do the trick, take a closer look at [how to select advertised network interfaces in Homebridge](https://github.com/homebridge/homebridge/wiki/mDNS-Options#how-to-select-advertised-network-interfaces). **If your symptoms are something along the lines of "snapshots work, but video streaming doesn't", it's almost certainly a network interface issue.**

### <A NAME="push"></A>Push Notification Issues
The good news is that push notifications should just work by default. If they don't, and you've ruled out network issues as a cause, the next thing to look at is your system clock. Wait...what does your system clock have to do with notifications?

UniFi Protect provides a lot of notifications, and sometimes those notifications are duplicates or old ones we aren't interested in that happened in the past. As a result, `homebridge-unifi-protect` only alerts you to notifications that UniFi Protect alerts it to that happened in the last few seconds.

Why does this matter?

If you run `homebridge-unifi-protect` on a server that doesn't have a similar internal time to what UniFi Protect thinks is the time, then you might miss notifications if they're significantly different. By default most computers and UniFi Protect synchronize their clocks with the worldwide [NTP](https://www.ntp.org) time servers. Make sure that the server you run Homebridge on and UniFi Protect both agree on what time it is.

Assuming you've setup all of the above, the most common issue people have:

* Everything above is setup correctly, but you still don't receive notifications when motion or doorbell ring events happen.
  * This is almost certainly a clock-related issue on your UniFi Protect controller or the device where you are running Homebridge.
  * `homebridge-unifi-protect` checks the timestamps on any events received from Protect to ensure it's reasonably recent. If the event is too far in the past, it will be ignored.
  * To fix this, ensure the clock is accurate and up-to-date on your Protect controller and on the device where Homebridge is running.

### <A NAME="video"></A>Video Streaming
There are lots of things that can go wrong with video streaming, unfortunately. I want to start by providing a bit of background on how streaming actually works in HomeKit, homebridge and this plugin before getting into where things can break.

#### Background
The good news is that the video streams coming from UniFi Protect tend to be pretty close to pristine. They require very little massaging or manipulation to make them accessible through HomeKit. This means that there's no reencoding of a video stream that needs to happen in order to make the stream usable in HomeKit. That means the plugin has very modest CPU horsepower requirements, and you should have a smooth user experience. There are a couple of Protect-specific quirks when it comes to streaming, but I'm going to skip that here because it's uninteresting for the intended purpose of this page.

An essential aspect of HomeKit video streaming is understanding that **HomeKit decides what quality it wants to request, not the end user, nor the plugin**. What this means in practice is that you have no control over what HomeKit requests, and expects to receive, when it comes to video streaming size and quality.

A second essential aspect to understand is that UniFi Protect allows you to have up to three different RTSP streams available per camera. Each stream represents a different quality level - *High*, *Medium*, and *Low*, and you may choose to stream any of them, at any time, so long as they are enabled (`homebridge-unifi-protect` autoconfigures all the available RTSP streams, if it has the permissions to do so in Protect).

When HomeKit requests a stream of a specific quality, `homebridge-unifi-protect` attempts to intelligently select a stream that's closest to what's being requested, and send that back to your device. You can see that when you look at the Homebridge logs:

```
Streaming request from 1.2.3.4: 1920x1080@30fps, 802 kbps. Using RTSP stream profile: 3840x2160@24fps (High), 16000 kbps
```

What the above means is that a HomeKit client, in this case an Apple TV, is requesting a stream of quality 1920x1080@30fps. In response, `homebridge-unifi-protect` looks at the available RTSP streams on the camera, a G4 Pro, and selected the `High` RTSP profile to stream back. As you can see, the stream that the Apple TV is receiving back is significantly higher quality (4K) than what's being requested (1080p), and should look terrific on the Apple TV.

You can read about autoconfiguration of RTSP streams in `homebridge-unifi-protect` in the [autoconfiguration documentation](https://github.com/hjdhjd/homebridge-unifi-protect/blob/master/docs/Autoconfiguration.md).

#### Video Streaming Issues
This brings us to where the problems people encounter can come from. When that stream comes from Protect to `homebridge-unifi-protect`, it's processed by `FFmpeg` before being sent on it's way to your iPhone. I've taken a lot of time to tune the parameters used within FFmpeg for Protect to get things working just right. Despite that, it's not always perfect.

Recall that I said that the video stream coming from Protect is pretty close to pristine. That makes most of the job for FFmpeg simple - it doesn't need to reencode a video stream.

Where problems can arise is in pushing that stream over a network, be it your local WiFi network, or a cellular network. The enemy is twofold - packet size, and stream compatibility. To vastly simplify things for the purpose of troubleshooting, think of packet size as how many chunks of video data are sent to your iOS device at a time. The larger the packet size, the more data that gets sent at once. The smaller the data size, the more overhead and bandwidth required to get it there. There's a sweet spot, and it's extraordinarily system dependent and device dependent at times. It also relies on the fact that you have sufficient data to send at the right moments in time to the end user.

Almost all of the streaming issues that aren't one of the simpler ones described above (firewall rules, etc.) boil down to two related things:

 * The quality of the stream is pushing more data at a faster rate than either FFmpeg can consume or the HomeKit device can consume (or both!).
 * Packet size is too high or low to account for the stream that's coming from Protect, the processing time required, and the latency of the network connection.

##### Use The Low Stream
While the defaults work for most users, most of the time, sometimes the specifics of your own environment will make things off *just enough* that streaming doesn't work. The first, and easiest, step in addressing it is simple: **force `homebridge-unifi-protect` to use a lower stream quality**. You can do that by enabling the `Video.Stream.Only` [feature option](https://github.com/hjdhjd/homebridge-unifi-protect/blob/master/docs/FeatureOptions.md#video):

```
Enable.Video.Stream.Only.Low
```

This will tell `homebridge-unifi-protect` to only use the `Low` stream from Protect cameras. If this works, then you're done and your HomeKit life is once more complete and all is right with the world.

I know that instinctively, some people don't like the idea of having fancy Protect hardware and using what they perceive to be a low-quality stream. To that, I'd say a couple of things...the quality of the stream is actually *very* good and often better than most other IP-based camera systems that I've seen. Don't think twice about it. It's the nature of the HomeKit beast, I'm afraid. For the purposes of glancing at video on occasion, when you need it, it's more than sufficient. I get it's not what some people want to hear, but I wanted to share the facts for you to consider.

If you're one of the unlucky few who, after forcing the `Low` stream to be used for HomeKit still can't get streaming working, and you don't have any of the other issues above (e.g. firewall issues again), you're at the confluence of a latency challenge coupled with the packet size that's coming out of FFmpeg and we have to do more work to get the stream going through transcoding.

##### Transcoding
Transcoding should be viewed as a last resort to getting things working in your environment. This is because it will almost always look worse than getting the native RTSP stream working. When transcoding, `homebridge-unifi-protect` will take the closest match it can find to the request from HomeKit and will transcode (convert) the video stream in realtime to match the parameters being requested by HomeKit. When transcoding, you'll see a log entry in Homebridge like this:

```
Streaming request from 1.2.3.4: 1920x1080@30fps, 802 kbps. Transcoding RTSP stream profile: 3840x2160@24fps (High), 16000 kbps
```

Transcoding has two significant implications:

  * It will consume more CPU on the device where you run Homebridge. If your device is underpowered, it may struggle when it comes to higher quality streams.
  * The quality of the final stream will likely not be as high as it would be if you were able to get the native RTSP streams working above.

To enable transcoding, you'll need to enable the `Video.Transcode` [feature option](https://github.com/hjdhjd/homebridge-unifi-protect/blob/master/docs/FeatureOptions.md#video):

```
Enable.Video.Transcode
```

If that doesn't work, you can further pair transcoding with forcing a lower stream quality by also enabling the `Video.Stream.Only` feature option. I would recommend starting with `Enable.Video.Stream.Only.Low` and working your way up when it comes to quality to see what works best in your environment.

##### Final Thoughts
I would look at forcing the stream quality to low, or transcoding, as last resorts. It may well be that you need to use them when you're away from home and streaming remotely if `homebridge-unifi-protect` isn't doing the right thing by default. When you are home, however, you should be able to use different RTSP streaming profiles, if you choose to do so. See [feature option](https://github.com/hjdhjd/homebridge-unifi-protect/blob/master/docs/FeatureOptions.md) and look through the section on scope, in particular the section on how to use IP address-specific feature options.
