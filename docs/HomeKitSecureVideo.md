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

`homebridge-unifi-protect` is a [Homebridge](https://homebridge.io) plugin that provides HomeKit support to the [UniFi Protect](https://unifi-network.ui.com/video-security) device ecosystem. [UniFi Protect](https://unifi-network.ui.com/video-security) is [Ubiquiti's](https://www.ui.com) next-generation video security platform, with rich camera, doorbell, and other smart home options for you to choose from, as well as an app which you can use to view, configure and manage your video camera, doorbells, and more.

### HomeKit Secure Video Support
HomeKit Secure Video has been a feature in HomeKit since the launch of iOS 13. It provides for several things:

  * The ability to securely record and store motion events of interest using a HomeKit hub (Apple TV, HomePod mini, etc.).
  * Intelligent analysis of those events for specific things like animals, people, and vehicles.
  * Facial recognition based on your own photo library for people it recognizes in your recorded motion events.
  * Granular notifications based on the analysis of those motions events (animal detected, package detected, etc.).

`homebridge-unifi-protect` fully supports HomeKit Secure Video, without the need for additional software or plugins. We use the UniFi Protect livestream API and FFmpeg to provide a seamless native user experience.

#### Configuring HKSV For UniFi Protect

  * Once you enable HomeKit Secure Video for your cameras in the Home app, you can configure the types of events and objects you're interested in recording and being informed about.
  * On a technical level, HKSV asks `homebridge-unifi-protect` to maintain a buffer - a few seconds of video (in practice, HomeKit always requests four seconds of history). Think of this buffer like a timeshifting DVR that's constantly updating. When a motion event occurs, we send the buffer to HomeKit, and continue to do so as long as HomeKit requests it.
  * It's important to note: **HomeKit decides how long each event will be, by default**. In practice, I've seen events as long 5 or 10 minutes in high-traffic areas. HomeKit continues to record an event for as long as it thinks there's some motion of interest to the user.
  * In practice, if you place a camera in a very high traffic area, say a kitchen or a family room, and enable HKSV, you're likely going to get very long motion events captured in HomeKit. It's not a bug, it's the way HomeKit Secure Video is designed. :smile: You can modify this behavior with the [`Video.HKSV.Recording.MaxDuration` feature option](https://github.com/hjdhjd/homebridge-unifi-protect/blob/master/docs/FeatureOptions.md#video), which allows you to set an upward limit on how long each HKSV event recording can be.

#### Interactions With UniFi Protect Smart Motion Detection
UniFi Protect has it's own smart motion detection capabilities that [can be used](https://github.com/hjdhjd/homebridge-unifi-protect/blob/master/docs/FeatureOptions.md#motion) with `homebridge-unifi-protect`. When you have smart motion detection enabled and you have HomeKit Secure Video is enabled **and** configured in the Home app to record events, `homebridge-unifi-protect` is faced with a dilemma: when do I notify a user of a motion detection event?

When HKSV is both enabled and configured, `homebridge-unifi-protect` will not use the smart motion detection capabilities of UniFi Protect to alert you to a motion event and instead use HKSV to do so. Why? If the user has made an active decision to enable HKSV, we need to let HomeKit determine when to notify the user of an event of interest, and only HKSV. Otherwise, you run the risk of being spammed with motion event notifications, or missing motion events altogether.

However, if you have the smart motion detection object sensors feature option enabled (`Motion.SmartDetect.ObjectSensors`), you will still receive contact sensor updates for those object types as UniFi Protect detects them. It's important to note: smart object contact sensors are not related, nor connected, to HKSV. HKSV is a bit of a black box and handles everything independently without or knowledge or ability to know what it's detected by design. It's entirely possible that the smart object sensors will detect (or not detect) a certain object that HKSV does or doesn't detect.

#### Camera Properties Exposed In HomeKit Secure video
HomeKit Secure Video is more than recorded events with some AI/ML applied to it. In many ways, it's like a "camera v2" accessory being exposed in HomeKit and gives us access to much richer capabilities and settings. In the case of UniFi Protect, one of those settings is the **Camera Status Light** setting in the Home app. It allows you to turn on or off the **Camera Status Light** setting for a HomeKit-enabled camera. In the UniFi Protect world, that means the ability to turn on or off the status LED on a camera. That's great functionality, but there's also a bug in the Home app itself related to this. Specifically, the camera status light setting *is initially forced on by the Home app*. There is no way to actually force this to default to what is currently set on the UniFi Protect controller, and sync accordingly. We are left with a situation where, if I want to provide access to this feature - which I do - you are forced into having to turn off the camera status light, *in the Home app* in order to have a setting that *sticks*. It's annoying. It's frustrating. It a bug in the Home app as of iOS 15, not in the plugin. I would prefer to keep the state synced across HomeKit and Protect, so any state changes in the camera status light sync across seamlessly, which is what the user should be able to expect, but unfortunately, this bug in the Home app makes that impossible at the moment.

#### How HomeKit Secure Video Works
HKSV, in practice, works quite well for most things. Apple created a pretty robust system that leverages it's home-based devices such as HomePod minis and Apple TVs for the heavy lifting of analyzing video.

  * To protect the performance and integrity of those Apple home-based devices it uses for processing video, there are specific requirements for video.

  * HKSV takes a very specific video stream and analyzes it. It typically requests the preceding four seconds of video before a motion event, followed by whatever video the camera continues to see. Think of it as a timeshifted DVR - it wants to watch the past four seconds and then continue watching until it asks to stop.
  * That stream is analyzed based on what HKSV is looking for (people, animals, etc.) and continues to capture video until HKSV feels it's got nothing *interesting* left in the video. So, someone walking past the camera, for instance, may trigger a recording of 20-30 seconds, but a group of people moving around in front of the camera may generate a much longer recorded clip.
  * That recorded video event is then sent to iCloud and the alert notifications are sent to your iPhone, etc. based on whatever your notification settings.

The Home hub devices are doing object recognition, in essence. Given their realtime performance requirements and the need to scale, Apple has imposed very specific and rigid requirements on the incoming video stream in order to get things working with a good Apple-y user experience. That allows your Apple TV to be able to analyze a motion video event while displaying that shiny 4K HDR video on your fancy television without stuttering. Why do I use that example? Because I made my Apple TV stutter constantly while developing and testing HKSV support for `homebridge-unifi-protect`. The reason we need to transcode video at the moment, unfortunately, is because Home hubs are so very particular about what they receive when it comes to those video clips - anything above a bitrate of 2000kbps and you quickly degrade Home hub performance. Anything that's not exactly the amount of timeshifted buffer (four seconds!) it's looking for, and suddenly timestamps are wrong within the Home app UI when you review a recorded event.

All of the above is based on observed behavior and conversations with other people. I'm sure someone much smarter than I may eventually find more definitive or better insights into the inner workings of the black box that is HomeKit Secure Video, but I doubt Apple is going to tell us much anytime soon. 😄

For the best experience with HBUP and HKSV, you should run Homebridge and HBUP on decent hardware and not your several-year-old RPi or other aging CPU platform. There may be ways to run HBUP and HKSV on those platforms, but they are all going to begin to compromise the user experience in various ways. Stay tuned for more on that.

#### Performance Considerations
HKSV in `homebridge-unifi-protect` works very well by default, if you have a decently performant and modern machine that you're running it on. The price you pay for having HKSV comes primarily in the area of CPU. HBUP *will need to transcode** any video it sends to a Home hub for analysis. The good and bad news is that it only happens when motion is detected, which triggers an analysis cycle by the Home hub. If you have a lot of cameras and a lot of motion events, expect this to happen often and the requisite consumption of CPU.

If you're struggling to get HKSV working in HBUP, try the following:

  * Try forcing HBUP to only use the lowest quality video stream as a starting point. You do this by using the [`Video.Stream.Only.Low` feature option](https://github.com/hjdhjd/homebridge-unifi-protect/blob/master/docs/FeatureOptions.md#video), as described in the [troubleshooting documentation](https://github.com/hjdhjd/homebridge-unifi-protect/blob/master/docs/Troubleshooting.md#use-the-low-stream).

The above recommendation should help you get up and running in most lower-powered environments.

#### Things To Be Aware Of
  * You must have the administrator role enabled for the UniFi Protect username you choose to use with `homebridge-unifi-protect`. Without it, HKSV won't work correctly or at all in most cases.
  * HomeKit hubs are quite particular about the exact format of the video it receives. We use FFmpeg to transcode the video to the exact format HomeKit is requesting. In practice, even in large camera environments, this shouldn't result in a degradation in performance. We try to match the input stream to FFmpeg as closely as we can to what HomeKit is looking for, minimizing most of the computing overhead associated with transcoding.
  * Occasional errors will occur - HomeKit hubs can be finicky at times. It's not typically something to be concerned about, and please don't open issues for infrequent errors that will be logged. As both HKSV and `homebridge-unifi-protect` continue to evolve, these will become more and more rare instances.

#### Some Fun Facts
  * I've had HKSV events run as long as 10+ minutes and they work quite well.
  * The video quality that HKSV requests can be quite a bit less than the video quality of the native UniFi Protect camera capabilities, particularly for 4K-capable cameras.
  * HKSV can almost be thought of as HomeKit camera implementation 2.0. With it comes the ability to more directly access even more capabilities of your UniFi Protect cameras, such as the camera status light which you can now modify from within the Home app.
  * UniFi Protect's own smart motion detection works as well, or better than, HKSV in my testing. It detects things much more quickly, and does a better job overall. However, there's one thing that only HKSV can do: provide tailored notifications to let you know about specific object types it's detected, individual facial recognition in your recorded motion events based on your photo library, and a Home-app-based-UI for navigating recorded motion events. And that's the tradeoff you're making. To get HKSV, you need beefier hardware and a network setup. Not generally an issue for most UniFi-centric homes.
  * No, you do not need to keep rebooting your Home hubs to make things work. The hubs are fine - they are quite robust actually, in my experience. If there's a problem, it's unlikely to be in the Home hub itself.
