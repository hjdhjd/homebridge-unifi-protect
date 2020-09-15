<SPAN ALIGN="CENTER" STYLE="text-align:center">
<DIV ALIGN="CENTER" STYLE="text-align:center">

[![homebridge-unifi-protect: Native HomeKit support for UniFi Protect](https://raw.githubusercontent.com/hjdhjd/homebridge-unifi-protect/master/homebridge-protect.svg)](https://github.com/hjdhjd/homebridge-unifi-protect)

# Homebridge UniFi Protect<SUP STYLE="font-size: smaller; color:#0559C9;">2</SUP>

[![Downloads](https://img.shields.io/npm/dt/homebridge-unifi-protect2?color=%230559C9&logo=icloud&logoColor=%23FFFFFF&style=for-the-badge)](https://www.npmjs.com/package/homebridge-unifi-protect)
[![Version](https://img.shields.io/npm/v/homebridge-unifi-protect?color=%230559C9&label=UniFi%20Protect&logo=ubiquiti&logoColor=%23FFFFFF&style=for-the-badge)](https://www.npmjs.com/package/homebridge-unifi-protect)
[![UniFi Protect@Homebridge Discord](https://img.shields.io/discord/432663330281226270?color=0559C9&label=Discord&logo=discord&logoColor=%23FFFFFF&style=for-the-badge)](https://discord.gg/QXqfHEW)
[![verified-by-homebridge](https://img.shields.io/badge/homebridge-verified-blueviolet?color=%2357277C&style=for-the-badge&logoColor=%23FFFFFF&logo=data:image/svg%2bxml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI5OTIuMDkiIGhlaWdodD0iMTAwMCIgdmlld0JveD0iMCAwIDk5Mi4wOSAxMDAwIj48ZGVmcz48c3R5bGU+LmF7ZmlsbDojZmZmO308L3N0eWxlPjwvZGVmcz48cGF0aCBjbGFzcz0iYSIgZD0iTTk1MC4xOSw1MDguMDZhNDEuOTEsNDEuOTEsMCwwLDEtNDItNDEuOWMwLS40OC4zLS45MS4zLTEuNDJMODI1Ljg2LDM4Mi4xYTc0LjI2LDc0LjI2LDAsMCwxLTIxLjUxLTUyVjEzOC4yMmExNi4xMywxNi4xMywwLDAsMC0xNi4wOS0xNkg3MzYuNGExNi4xLDE2LjEsMCwwLDAtMTYsMTZWMjc0Ljg4bC0yMjAuMDktMjEzYTE2LjA4LDE2LjA4LDAsMCwwLTIyLjY0LjE5TDYyLjM0LDQ3Ny4zNGExNiwxNiwwLDAsMCwwLDIyLjY1bDM5LjM5LDM5LjQ5YTE2LjE4LDE2LjE4LDAsMCwwLDIyLjY0LDBMNDQzLjUyLDIyNS4wOWE3My43Miw3My43MiwwLDAsMSwxMDMuNjIuNDVMODYwLDUzOC4zOGE3My42MSw3My42MSwwLDAsMSwwLDEwNGwtMzguNDYsMzguNDdhNzMuODcsNzMuODcsMCwwLDEtMTAzLjIyLjc1TDQ5OC43OSw0NjguMjhhMTYuMDUsMTYuMDUsMCwwLDAtMjIuNjUuMjJMMjY1LjMsNjgwLjI5YTE2LjEzLDE2LjEzLDAsMCwwLDAsMjIuNjZsMzguOTIsMzlhMTYuMDYsMTYuMDYsMCwwLDAsMjIuNjUsMGwxMTQtMTEyLjM5YTczLjc1LDczLjc1LDAsMCwxLDEwMy4yMiwwbDExMywxMTEsLjQyLjQyYTczLjU0LDczLjU0LDAsMCwxLDAsMTA0TDU0NS4wOCw5NTcuMzV2LjcxYTQxLjk1LDQxLjk1LDAsMSwxLTQyLTQxLjk0Yy41MywwLC45NS4zLDEuNDQuM0w2MTYuNDMsODA0LjIzYTE2LjA5LDE2LjA5LDAsMCwwLDQuNzEtMTEuMzMsMTUuODUsMTUuODUsMCwwLDAtNC43OS0xMS4zMmwtMTEzLTExMWExNi4xMywxNi4xMywwLDAsMC0yMi42NiwwTDM2Ny4xNiw3ODIuNzlhNzMuNjYsNzMuNjYsMCwwLDEtMTAzLjY3LS4yN2wtMzktMzlhNzMuNjYsNzMuNjYsMCwwLDEsMC0xMDMuODZMNDM1LjE3LDQyNy44OGE3My43OSw3My43OSwwLDAsMSwxMDMuMzctLjlMNzU4LjEsNjM5Ljc1YTE2LjEzLDE2LjEzLDAsMCwwLDIyLjY2LDBsMzguNDMtMzguNDNhMTYuMTMsMTYuMTMsMCwwLDAsMC0yMi42Nkw1MDYuNSwyNjUuOTNhMTYuMTEsMTYuMTEsMCwwLDAtMjIuNjYsMEwxNjQuNjksNTgwLjQ0QTczLjY5LDczLjY5LDAsMCwxLDYxLjEsNTgwTDIxLjU3LDU0MC42OWwtLjExLS4xMmE3My40Niw3My40NiwwLDAsMSwuMTEtMTAzLjg4TDQzNi44NSwyMS40MUE3My44OSw3My44OSwwLDAsMSw1NDAsMjAuNTZMNjYyLjYzLDEzOS4zMnYtMS4xYTczLjYxLDczLjYxLDAsMCwxLDczLjU0LTczLjVINzg4YTczLjYxLDczLjYxLDAsMCwxLDczLjUsNzMuNVYzMjkuODFhMTYsMTYsMCwwLDAsNC43MSwxMS4zMmw4My4wNyw4My4wNWguNzlhNDEuOTQsNDEuOTQsMCwwLDEsLjA4LDgzLjg4WiIvPjwvc3ZnPg==)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)

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

### Logging In and Permissions
Getting `homebridge-unifi-protect` connected to UniFi Protect is the foundational step you need to complete to begin using this plugin. When users have issues logging in, the challenges tend to be in the following areas:

* Have you specified the right IP address for UniFi Protect?
  * For most people, I'd recommend using an IP address over a hostname. This provides you more certainty and eliminates another potential error vector (DNS / hostname resolution) from being a factor.

* Have you correctly entered your username and password?
  * I know this is a basic one...but believe me, it happens more than you think to all of us!

* Are you using a Ubiquiti cloud account to login and have two-factor authentication configured?
  * Unfortunately, `homebridge-unifi-protect` does not support two-factor authentication currently. You can create an additional local user within UniFi Protect and use that to login.

* You can login, but nothing seems to work.
  * This is almost certainly a permissions problem. If you look in the homebridge logs, you should see messages suggesting that you enable the administrator role for the user you're using to login to Protect. Granting the administrator role to the user you use for this plugin will provide you the most streamlined experience with the least amount of manual configuration on your part, and I'd strongly encourage you to do so.

### Network Issues
If you run homebridge in Docker, or a VM or VM-like environment, you might run into a network issue without realizing it due to situations with multiple network interface cards (NICs). By default, Homebridge listens for HomeKit requests on all the network interfaces it finds when it starts up. Historically, this has created a challenge for video-streaming plugins like `homebridge-unifi-protect` because the plugin doesn't have a way of knowing which interface the streaming request came from. So what this plugin, and pretty much all the other similar plugins do, is guess by looking for the default network interface on the system and assuming that's where video should be sent out of.

The good news is that the leading camera plugin developers and the Homebridge developers have been collaborating on a solution for this, and as of Homebridge 1.1.3, Homebridge now takes over responsibility for determining which interface and IP address to use when streaming video. This is an ideal solution because Homebridge is really who knows where the request came from and is in the best position to determine which interface to use to stream from.

If you're having issues with this plugin, or others, not using the correct network interface, I'd encourage you to upgrade to Homebridge 1.1.3 or greater and see if that resolves the issue.

### Push Notification Issues
The good news is that push notifications should just work by default. If they don't, and you've ruled out network issues as a cause, the next thing to look at is your system clock. Wait...what does your system clock have to do with notifications?

UniFi Protect provides a lot of notifications, and sometimes those notifications are duplicates or old ones we aren't interested in that happened in the past. As a result, `homebridge-unifi-protect` only alerts you to notifications that UniFi Protect alerts it to that happened in the last few seconds.

Why does this matter?

If you run `homebridge-unifi-protect` on a server that doesn't have a similar internal time to what UniFi Protect thinks is the time, then you might miss notifications if they're significantly different. By default most computers and UniFi Protect synchronize their clocks with the worldwide [NTP](https://www.ntp.org) time servers. Make sure that the server you run Homebridge on and UniFi Protect both agree on what time it is.

### Video Streaming
There are lots of things that can go wrong with video streaming, unfortunately. I want to start by providing a bit of background on how streaming actually works in HomeKit, homebridge and this plugin before getting into where things can break.

#### Background
The good news is that the video streams coming from UniFi Protect tend to be pretty close to pristine. They require very little massaging or manipulation to make them accessible through HomeKit. That's terrific because for you, the end user, this means that there's no reencoding of a video stream that needs to happen or other crazy gymnastics in order to make the stream usable in HomeKit. Which also means that this plugin has very modest CPU horsepower needs relative to other plugins that may need to reencode their video streams, which can be quite CPU intensive. There are a couple of Protect-specific quirks, but I'm going to skip that here because it's uninteresting for the intended purpose of this page.

Something that's essential to understand is that you, the end user, do not get to dictate the quality of the video stream that you see on your iPhone, iPad, or otherwise. **HomeKit decides what quality stream it wants to request, not the end user, nor the plugin**. There's a common misperception that users can somehow force higher-quality video in HomeKit to stream to your phone. You really can't. What you can do is decide what the original quality of the stream is that ultimately gets restreamed at whatever rate HomeKit decides to ask for. So what's that mean? `homebridge-unifi-protect` tries to be intelligent about which Protect stream quality to choose when a streaming request comes in. You can read about that in the [autoconfiguration documentation](https://github.com/hjdhjd/homebridge-unifi-protect/blob/master/docs/Autoconfiguration.md). In a nutshell, the plugin tries to grab the highest-quality stream that's practical and that HomeKit can process. For 4K-enabled cameras, you're never, ever, going to be able to stream in 4K in HomeKit because HomeKit currently only supports video streaming for up to 1080p. I'm sure that'll change in the future, and when it does, we'll be ready for it. But in the meantime it makes little sense to try to hand a 4K-quality stream to HomeKit, and it can lead to other issues as you'll see soon.

#### Video Streaming Issues
This brings us to where the problems people encounter can come from. When that stream comes from Protect to `homebridge-unifi-protect`, it's processed by `FFmpeg` before being sent on it's way to your iPhone. I've taken a lot of time to tune the parameters used within FFmpeg for Protect, and gone through many hours of testing to get things working just right. Despite that, it's not always perfect.

Recall that I said that the video stream coming from Protect is pretty close to pristine. That makes most of the job for FFmpeg pretty easy, actually. Where problems can arise is in pushing that stream over a network, be it your local WiFi network, or a cellular network. The enemy is packet size. To vastly simplify things for the purpose of troubleshooting, think of packet size as how many chunks of video data are sent to your iOS device at a time. The larger the packet size, the more data that gets sent at once. The smaller the data size, the more overhead and bandwidth required to get it there. There's a sweet spot, and it's extraordinarily system dependent and device dependent at times. It also relies on the fact that you have sufficient data to send at the right moments in time to the end user.

Almost all of the streaming issues that aren't one of the simpler ones described above (firewall rules, etc.) boil down to two related things:

 * The quality of the stream is pushing more data at a faster rate than FFmpeg, on your platform, can consume.
 * Packet size is too high or low to account for the stream that's coming from Protect, the processing time required, and the latency of the network connection.

While the defaults work for most users, most of the time, sometimes the specifics of your own environment will make things off *just enough* that streaming doesn't work. The first, and easiest, step in addressing it is simple: **force `homebridge-unifi-protect` to use a lower stream quality**. You can do that by enabling the `StreamOnly` [feature option](https://github.com/hjdhjd/homebridge-unifi-protect/blob/master/docs/FeatureOptions.md): `Enable.StreamOnly.Low`. This will tell `homebridge-unifi-protect` to only use the `Low` stream from Protect cameras. If this works, then you're done and your HomeKit life is once more complete and all is right with the world.

I know that instinctively, some people don't like the idea of having fancy Protect hardware and using what they perceive to be a low-quality stream. To that, I'd say a couple of things...the quality of the stream is actually *very* good and far better than most other IP-based camera systems that I've seen. Don't think twice about it. Remember: you're viewing video on an iPhone that's already going to have a lower bitrate and video quality than whatever is coming out of Protect. It's the nature of the HomeKit beast, I'm afraid. For the purposes of glancing at video on occasion, when you need it, it's more than sufficient. I get it's not what some people want to hear, but I wanted to just lay the facts out there for you to consider.

If you're one of the unlucky few who, after forcing the `Low` stream to be used for HomeKit still can't get streaming working, and you don't have any of the other issues above (e.g. firewall issues again), you're at the confluence of a latency challenge coupled with the packet size that's coming out of FFmpeg. More to come on solving that one.
