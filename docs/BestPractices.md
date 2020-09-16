<SPAN ALIGN="CENTER" STYLE="text-align:center">
<DIV ALIGN="CENTER" STYLE="text-align:center">

[![homebridge-unifi-protect: Native HomeKit support for UniFi Protect](https://raw.githubusercontent.com/hjdhjd/homebridge-unifi-protect/master/homebridge-protect.svg)](https://github.com/hjdhjd/homebridge-unifi-protect)

# Homebridge UniFi Protect

[![Downloads](https://img.shields.io/npm/dt/homebridge-unifi-protect2?color=%230559C9&logo=icloud&logoColor=%23FFFFFF&style=for-the-badge)](https://www.npmjs.com/package/homebridge-unifi-protect)
[![Version](https://img.shields.io/npm/v/homebridge-unifi-protect?color=%230559C9&label=Homebridge%20UniFi%20Protect&logo=ubiquiti&logoColor=%23FFFFFF&style=for-the-badge)](https://www.npmjs.com/package/homebridge-unifi-protect)
[![UniFi Protect@Homebridge Discord](https://img.shields.io/discord/432663330281226270?color=0559C9&label=Discord&logo=discord&logoColor=%23FFFFFF&style=for-the-badge)](https://discord.gg/QXqfHEW)
[![verified-by-homebridge](https://img.shields.io/badge/homebridge-verified-blueviolet?color=%2357277C&style=for-the-badge&logoColor=%23FFFFFF&logo=data:image/svg%2bxml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI5OTIuMDkiIGhlaWdodD0iMTAwMCIgdmlld0JveD0iMCAwIDk5Mi4wOSAxMDAwIj48ZGVmcz48c3R5bGU+LmF7ZmlsbDojZmZmO308L3N0eWxlPjwvZGVmcz48cGF0aCBjbGFzcz0iYSIgZD0iTTk1MC4xOSw1MDguMDZhNDEuOTEsNDEuOTEsMCwwLDEtNDItNDEuOWMwLS40OC4zLS45MS4zLTEuNDJMODI1Ljg2LDM4Mi4xYTc0LjI2LDc0LjI2LDAsMCwxLTIxLjUxLTUyVjEzOC4yMmExNi4xMywxNi4xMywwLDAsMC0xNi4wOS0xNkg3MzYuNGExNi4xLDE2LjEsMCwwLDAtMTYsMTZWMjc0Ljg4bC0yMjAuMDktMjEzYTE2LjA4LDE2LjA4LDAsMCwwLTIyLjY0LjE5TDYyLjM0LDQ3Ny4zNGExNiwxNiwwLDAsMCwwLDIyLjY1bDM5LjM5LDM5LjQ5YTE2LjE4LDE2LjE4LDAsMCwwLDIyLjY0LDBMNDQzLjUyLDIyNS4wOWE3My43Miw3My43MiwwLDAsMSwxMDMuNjIuNDVMODYwLDUzOC4zOGE3My42MSw3My42MSwwLDAsMSwwLDEwNGwtMzguNDYsMzguNDdhNzMuODcsNzMuODcsMCwwLDEtMTAzLjIyLjc1TDQ5OC43OSw0NjguMjhhMTYuMDUsMTYuMDUsMCwwLDAtMjIuNjUuMjJMMjY1LjMsNjgwLjI5YTE2LjEzLDE2LjEzLDAsMCwwLDAsMjIuNjZsMzguOTIsMzlhMTYuMDYsMTYuMDYsMCwwLDAsMjIuNjUsMGwxMTQtMTEyLjM5YTczLjc1LDczLjc1LDAsMCwxLDEwMy4yMiwwbDExMywxMTEsLjQyLjQyYTczLjU0LDczLjU0LDAsMCwxLDAsMTA0TDU0NS4wOCw5NTcuMzV2LjcxYTQxLjk1LDQxLjk1LDAsMSwxLTQyLTQxLjk0Yy41MywwLC45NS4zLDEuNDQuM0w2MTYuNDMsODA0LjIzYTE2LjA5LDE2LjA5LDAsMCwwLDQuNzEtMTEuMzMsMTUuODUsMTUuODUsMCwwLDAtNC43OS0xMS4zMmwtMTEzLTExMWExNi4xMywxNi4xMywwLDAsMC0yMi42NiwwTDM2Ny4xNiw3ODIuNzlhNzMuNjYsNzMuNjYsMCwwLDEtMTAzLjY3LS4yN2wtMzktMzlhNzMuNjYsNzMuNjYsMCwwLDEsMC0xMDMuODZMNDM1LjE3LDQyNy44OGE3My43OSw3My43OSwwLDAsMSwxMDMuMzctLjlMNzU4LjEsNjM5Ljc1YTE2LjEzLDE2LjEzLDAsMCwwLDIyLjY2LDBsMzguNDMtMzguNDNhMTYuMTMsMTYuMTMsMCwwLDAsMC0yMi42Nkw1MDYuNSwyNjUuOTNhMTYuMTEsMTYuMTEsMCwwLDAtMjIuNjYsMEwxNjQuNjksNTgwLjQ0QTczLjY5LDczLjY5LDAsMCwxLDYxLjEsNTgwTDIxLjU3LDU0MC42OWwtLjExLS4xMmE3My40Niw3My40NiwwLDAsMSwuMTEtMTAzLjg4TDQzNi44NSwyMS40MUE3My44OSw3My44OSwwLDAsMSw1NDAsMjAuNTZMNjYyLjYzLDEzOS4zMnYtMS4xYTczLjYxLDczLjYxLDAsMCwxLDczLjU0LTczLjVINzg4YTczLjYxLDczLjYxLDAsMCwxLDczLjUsNzMuNVYzMjkuODFhMTYsMTYsMCwwLDAsNC43MSwxMS4zMmw4My4wNyw4My4wNWguNzlhNDEuOTQsNDEuOTQsMCwwLDEsLjA4LDgzLjg4WiIvPjwvc3ZnPg==)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)

## HomeKit support for the UniFi Protect ecosystem using [Homebridge](https://homebridge.io).
</DIV>
</SPAN>

`homebridge-unifi-protect` is a [Homebridge](https://homebridge.io) plugin that provides HomeKit support to the [UniFi Protect](https://unifi-network.ui.com/video-security) device ecosystem. [UniFi Protect](https://unifi-network.ui.com/video-security) is [Ubiquiti's](https://www.ui.com) next-generation video security platform, with rich camera, doorbell, and NVR controller hardware options for you to choose from, as well as an app which you can use to view, configure and manage your video camera and doorbells.

### Best Practices
I firmly believe that good software is opinionated. It should have a strong sense of what it's [north star is](https://github.com/hjdhjd/homebridge-unifi-protect#why), and what the user experience journey looks like. One of my guiding principles is that I'm trying to create the best HomeKit user experience for UniFi Protect users by making Protect integration as seamless as possible within the HomeKit ecosystem. Another north star is to have things work in as native a manner as possible and honor the intent behind the design decisions Apple has chosen to make with HomeKit. In the areas where I've provided functionality that deviates from that principle, it's always disabled by default unless a user explicitly wishes to use that capability.

These best practices will evolve over time, but I wanted to provide some information on some of the design choices I've made, and how you can enhance and tailor your own experience.

#### Motion Sensors, Motion Switches and Push Notifications
I suspect that by far the most used feature of `homebridge-unifi-protect` is the instantaneous rich notifications it provides to HomeKit when Protect detects motion. However, for environments where you have more than a couple of cameras, having notifications on all the time can lead to notification spam, particularly if you haven't taken the time to customize motion detection in Protect.

The north star in motion detection is:

  *Let each platform (Protect and HomeKit) do what it does best and don't duplicate configuration functionality unless you absolutely have to.*

What's that mean?

  * Configure motion zones in the Protect app or webUI - it's the best place to do so.
  * Enable notifications on *all* your Protect cameras in HomeKit.
  * Don't enable motion switches unless you really need that functionality. This isn't the same thing as eliminating notification spam as you're about to read...

##### Motion Zones
Put the time into setting up and adjusting motion zones in UniFi Protect, particularly with the *enhanced* motion detection algorithm. Spend time in either the Protect app or the webUI and customize the sensitivity of those zones so that Protect only alerts when something of real interest happens for you.

You'll find this pays huge dividends and spending 30 minutes or an hour setting something like this up once pays off in the long run and gives you a better experience overall.

##### Enabling Notifications
Go into iOS, iPadOS, or macOS and turn on notifications for all your cameras, *and leave them on*. No, I haven't lost my mind. :smile: Let me explain...

Enabling notifications on all your cameras will ensure that iOS is alerted to when motion occurs and, crucially, *updates the snapshots of the cameras in the background*. What this means for you is that your HomeKit experience will feel more responsive and faster, because anytime there's a motion event, the Home app will refresh that image automatically in the background.

"But wait!" you tell me..."how do I not get spammed?!" Under each notification setting you'll see additional options for `Time` and `People`. **This** is where you can set how often you want to your iPhone to alert you to a motion event. The options are quite robust and very flexible. So...if you only want to be alerted when you aren't home, use the `People` option to only alert you when you (or everyone in your house if you choose) aren't home.

What this allows you to do is to have your cake and eat it too - when the Home app is alerted that a motion event has occurred, it will refresh it's snapshot in the background, every time. You only get alerted with a push notification if you really wanted to be and you can customize those notifications in flexible ways within the Home app.

##### Motion Switches
Motion switches exist as a way to tell `homebridge-unifi-protect` to stop sending motion event updates to HomeKit when Protect detects them. There are situations where this may be what you really want to do so, but for the most part, this isn't really useful. What most users tend to actually want is control over the push notifications they receive on the iPhones and iPads. That's best done within the Home app notification settings for the camera, and not by disabling event updates from the camera to HomeKit. That's why, by default, motion switches are disabled - most users don't need them and they degrade from a responsive user experience in the Home app itself.
