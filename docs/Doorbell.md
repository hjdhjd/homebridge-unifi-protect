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

### Doorbell Support
If you're reading this, chances are you own, or would like to own, a [UniFi Protect doorbell](https://store.ui.com/us/en?category=cameras-doorbells). HBUP supports the following features for Protect doorbells:

  * Two-way Audio Support
    * `homebridge-unifi-protect` supports two-way audio, and it works well with one notable caveat: a lack of acoustic echo cancelation, or AEC.

  * Doorbell Ring Support
    * `homebridge-unifi-protect` fully supports doorbell ring notifications. When you ring the doorbell, you'll get a notification on your iOS/macOS devices, including a snapshot of whose at the door. These snapshots tied to notifications are often called *rich notifications*.

  * Doorbell Camera and Motion Detection Support
    * Since the Protect doorbells are essentially a camera as far as UniFi Protect goes, `homebridge-unifi-protect` supports all the same features as other UniFi Protect cameras, including motion detection and blazing fast and responsive video streaming.

  * Package Camera Support
    * For UniFi Protect doorbells that have package cameras, HBUP supports those as well, making them available to you in HomeKit - including full support for HomeKit Secure Video for package cameras.

  * Doorbell Messages
    * Some UniFi Protect doorbells feature an LCD screen that can display messages for people at the doorbell to see. Messages can be set indefinitely, selected from a preexisting list after the doorbell is rung, or you can type in a message in realtime at any point. `homebridge-unifi-protect` has full support for setting messages on your doorbell, including automation capabilities should you choose to use them.

### <A NAME="doorbell-twoway"></A>Two-way Audio
  * Protect cameras and doorbells that support two-way audio are *full-duplex*, meaning they transmit and receive audio simultaneously. This creates a problem - without using some method to eliminate your own voice from what gets picked up by the speaker, ***you will inevitably hear your own voice back whenever you use the microphone in the Home app***, however the person standing in front of the doorbell will hear things normally.

  * Unfortunately, AEC is not a solved problem in the open source community quite yet, though there are great commercial options. There are a couple of glimmers of hope: Protect cameras appear to actually support AEC, though there doesn't appear to be a straightforward way to access this capability at the moment. The second is that, things *do* work quite well, aside from the unfortunate challenge around AEC for the person using the Home app.

  * Two-way audio is enabled by default. You can disable it, through the two-way audio feature option under the Audio section of the HBUP feature options webUI.

  * Finally, since someone will inevitably ask: Ring and Nest-Cam (terrific plugins by terrific developers) - don't have this problem because Ring and Nest send all audio back to Ring and Nest's servers where audio is processed and dealt with, including AEC.

### <A NAME="doorbell-ring"></A>Doorbell Rings

[HomeKit](https://www.apple.com/home-app/) is a great home automation platform in many ways. Where there are gaps in HomeKit support, plugins like this one help to fill it by providing HomeKit support for devices without native HomeKit support. Every so often, however, you run into something that really is a limitation of the HomeKit platform that you need to work around. Doorbell ring automation is one of those things.

This plugin supports HomeKit's native video doorbell and doorbell ring functionality. What HomeKit lacks though is a way to trigger an automation when a ring occurs. There's currently no way to say something like *when the doorbell rings, and it's nighttime, turn on the front porch lights*. Until Apple chooses to provide that capability, what can we do?

Enter automation support for doorbell ring events in this plugin. If you choose to enable support for doorbell ring automation, you can create HomeKit automations based on doorbell ring events. Here's how it works:

  * Enable the doorbell trigger feature option under the Doorbell section of the HBUP feature options webUI.

  * This will create a switch service on the doorbell. Whenever the doorbell rings, the switch will turn on for a few seconds before resetting to the *off* state again.

  * You can create automations in HomeKit based on this by using the switch as a proxy for the doorbell ring. Turning on the switch will trigger a doorbell ring event.

### <A NAME="doorbell-messages"></A>Doorbell Messages

Before we get to configuring this feature in HomeKit, let's discuss what this feature is and what design decisions I've chosen to make in implementing this feature for HomeKit.

#### How Doorbell Messages Work In UniFi Protect

The messages feature in some UniFi Protect doorbells are essentially an LCD display on the doorbell that users can configure. The LCD display actually remains off until it detects motion, at which point it will display *WELCOME* or whatever message may have been placed there indefinitely by the user. Users can set a message at any time on the doorbell.

UniFi Protect has a couple of default messages built in, specifically:

  * Do not disturb
  * Leave package at door

These messages are always available to you in the UniFi Protect app and they can't be deleted or hidden. In addition to those, you can type in any message you'd like, using the UniFi Protect app, up to a limit of 30 characters. You can choose to save any message you create, making it easy to quickly select it from a list the next time you're in the app.

When you select a message to be displayed, you can also set a duration for that message. The message duration tells UniFi Protect how long to leave the message on the screen before returning to the default message *WELCOME*. By default, when a message is selected, it remains visible for 60 seconds. You can also configure messages using the UniFi Protect app.

#### How Doorbell Messages Work In `homebridge-unifi-protect`

There are a few challenges in implementing this feature for HomeKit, but the most significant one is that there's no way to take direct user input, like text. So what do we do? I decided to take the essence of this feature - preconfigured messages that you can set for arbitrary durations - and make it available through HomeKit as a switch.

Here's how it works:

  * `homebridge-unifi-protect` will read, in realtime, any messages that are saved in UniFi Protect. That means at a minimum, you'll always have the built in *Do not disturb* and *Leave package at door* messages available to you, in addition to any other messages you choose to setup in the UniFi Protect app.

    * This gives you the flexibility to add and remove messages at a whim, and this plugin will make sure those messages are available for you to use in HomeKit on a dynamic basis. What you get, is the simplicity of having a single place for all the messages you want to use with your doorbell - whether it's using the UniFi Protect iOS app or the Home app.

    * **Messages you set within the Home app that come from UniFi Protect will always have a 60 second duration.** This is because Protect doesn't allow you to save a duration, only the message. There's no way for me to tell how long you intended to display this message for, so we do what Protect does by default - display the selected message for 60 seconds.

  * You can also configure messages in Homebridge - either in addition to, or in place of, whatever is saved in UniFi Protect.

    * This approach provides you the most customization, but it comes at the expense of needing to reboot Homebridge whenever you want to make changes. In practice, I don't find this to be much of an issue when you combine this with the previous option. The combination allows you to use the flexibility provided in configuring messages through Homebridge, with the convenience of more ad hoc messages that you may need on a temporary basis.

    * Messages configured within the HBUP webUI can have duration information associated with them. **You can choose to display a message indefinitely, or for any amount of time you choose, without restriction.**

  * All configured messages - those that come from UniFi Protect and those that you configure in Homebridge - will be made available as individual switches on the doorbell accessory in the Home app. You can set or clear a given message by activating or deactivating the associated switch in the Home app.

    * Any message switch that's made available through HomeKit will reflect it's true state, whether it was activated within the Home app or through the UniFi Protect app. You'll always know what's being displayed on the doorbell, so long as it's *not* an ad hoc message that hasn't been saved in the UniFi Protect interface.

  * When someone rings the doorbell, you'll receive a rich notification. If you swipe down on that notification, you'll see a complete list of all the message switches associated with the doorbell. While two-way audio isn't available through HomeKit, you *can* select any of the preset messages you've configured to communicate with the person who rang the doorbell.

#### Configuring the Doorbell Messages Feature

Doorbell messages can be configured using the HBUP webUI:

  * Go to the **Settings** tab, then select **UniFi Protect Controllers** and then **Doorbell Message Presets**.
  * You can configure a default doorbell message as well as an unlimited number of additional messages to be made available as message switches within HomeKit.

To configure the behavior of this feature, see the HBUP feature options webUI, under the Doorbell feature options section.

### Some Fun Facts
  * There is a 30 character limit to what can be displayed on the LCD.
  * No, you can't use emojis. Would've been nice, right?
  * No, you can't have newlines / carriage returns either. These are limitations in what the doorbell displays, not ones imposed by `homebridge-unifi-protect`. In my testing, it supports basic formatting and regular text, and that's it.
  * No, you can't display cool icons like the builtin *do not disturb* and *leave package at door* settings do. Would be nice, but these just aren't accessible. Would be an awesome feature to have though, if Ubiquiti chooses to make it customizable in the future.
  * You get more flexibility in formatting when using the plugin-centric configuration option rather than configuring messages in Protect directly. Protect will always uppercase any message you enter. `homebridge-unifi-protect` will honor whatever case and formatting you enter.
  * There's no practical limit to the number of messages you can configure.
