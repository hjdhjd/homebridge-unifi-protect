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

### Best Practices
I firmly believe that good software is opinionated. It should have a strong sense of what it's [north star is](https://github.com/hjdhjd/homebridge-unifi-protect#why), and what the user experience journey looks like. My north stars for `homebridge-unifi-protect`:

  * Create the very best HomeKit user experience for UniFi Protect users by making Protect integration as seamless as possible within the HomeKit ecosystem.
  * Enable to users to get up and running with minimal required end user configuration and have things *just work*.
  * Have things work in as native a manner as possible and honor the *intent* behind the design decisions Apple has chosen to make with HomeKit. In the areas where I've provided functionality that deviates from that principle, it will always disabled by default unless a user explicitly wishes to use that capability.

These best practices will evolve over time, but I wanted to provide some thoughts on some of the design choices I've made, and how you can enhance and tailor your own experience.

#### Homebridge
**Importance: high**

If you want to optimize performance and responsiveness of this plugin, you should run `homebridge-unifi-protect` as a child bridge within Homebridge. [Read more about child bridges and how to enable it in Homebridge here](https://github.com/homebridge/homebridge/wiki/Child-Bridges).

#### User Accounts
**Importance: high**

You **must** create a local user account in order for `homebridge-unifi-protect` to work correctly. You **should** enable this local use to have the *full management role* for UniFi Protect.

But wait, you're thinking, am I just giving a random plugin the ability to do crazy things on my system?! Nope. The *full management role* in UniFi Protect allows HBUP the ability to change individual camera settings, create liveviews, and do a handful of other relatively benign things. You're not giving this local user account the keys to your kingdom, but you are allowing the account to directly configure the UniFi Protect controller to more optimally work with `homebridge-unifi-protect`. If you don't feel comfortable doing so, that's always your perrogative. HBUP will log warnings when things aren't configured as optimally as it would prefer to, or when it encounters permissions issues due to it's role.

#### HomeKit Secure Video
**Importance: medium**

[HomeKit Secure Video](https://support.apple.com/guide/iphone/set-up-security-cameras-iph7bc5df9d9/ios) (HKSV) is one of the most used features in HBUP. It is also, unsurprisingly, CPU and and GPU intensive. The more cameras and the more motion events you have in your environment, the more HKSV analysis you will have. You can read more about [HKSV in HBUP](https://github.com/hjdhjd/homebridge-unifi-protect/blob/main/docs/HomeKitSecureVideo.md) if you'd like to dive in further.

For the best HKSV experience:

  * I recommend running HBUP on macOS, ideally running on an Apple Silicon Mac, with hardware acceleration enabled in HBUP.
  * Do not run Homebridge and HBUP on macOS in Docker or other containerized environments - you will lose the ability to enable hardware acceleration if you do so.

This is the setup I use every day. It's highly performant, with minimal overhead, and provides the best HKSV and livestream experience for users with sub-second livestream response times.

#### Motion Sensors, Motion Switches and Push Notifications
**Importance: medium**

Another frequently used feature is notification of motion events. Traditional motion events, UniFi Protect smart motion events, and HomeKit Secure Video provide overlapping functionality, depending on your needs.

I recommend that most users use [HomeKit Secure Video](https://support.apple.com/guide/iphone/set-up-security-cameras-iph7bc5df9d9/ios) to manage motion and event detection. Why? In short, it's what most people think of when they think of HomeKit motion events. HKSV is the only way to get truly rich push notifications from HomeKit. Instead of seeing *Motion detected* you can receive more specific alerts like *The "Garage" camera has detected a person.* You can also tailor these further to decide if you want to be alerted when animals or vehicles are detected, etc. Finally, you can manage what activity zones you want HKSV to use when deciding what to alert you about.

It's crucial that you keep in mind that if you change motion zones on the Protect controller from the default, it **will** impact what motion events HKSV sees. This may be desirable behavior in your circumstance, but you should be aware of this if you're wondering why a motion event may not be triggering an HKSV analysis event - HBUP only receives motion events when the Protect controller sends them to us. If you've told the Protect controller to ignore a portion of the camera's field of view, then HBUP will never be alerted. Why might this actually be desirable behavior in some scenarios? You might have a lower-powered system and want to limit the number of HKSV events being triggered so that, for instance, a tree moving in the camera's field of view doesn't trigger a motion event that HKSV will then analyze.

If you prefer not to use HKSV, then I would look to using the native UniFi Protect app or Protect controller webUI to manage your motion events. Best practices:

  * Configure motion zones and smart detection zones on the Protect controller to your preferences.
  * Decide whether you want to receive all motion events or only smart motion events (as dictated by what you configured on the Protect controller) to be used within HBUP. You will need to enable the *smart motion detection* feature option under the *Motion* section within the HBUP webUI.
  * You can configure when you want to receive notifications within the Home app under the *Status and Notifications* section of each camera. There are options that allow you to adjust for time of day, occupancy, and other options.
  * Don't enable motion switches unless you really need that functionality. This isn't the same thing as eliminating notification spam as you're about to read...

##### Motion Zones (non-HKSV recommendations)
Put the time into setting up and adjusting motion zones in UniFi Protect. Spend time in either the Protect app or the webUI and customize the sensitivity of those zones so that Protect only alerts when something of real interest happens for you.

You'll find this pays dividends and spending 30 minutes or an hour setting something like this up once pays off in the long run and gives you a better experience overall.

##### Enabling Notifications (non-HKSV recommendations)
Go into iOS, iPadOS, or macOS and turn on notifications for all your cameras, *and leave them on*. No, I haven't lost my mind. :smile: Let me explain...

Enabling notifications on all your cameras will ensure that iOS is alerted to when motion occurs and, crucially, *updates the snapshots of the cameras in the background*. What this means for you is that your HomeKit experience will feel more responsive and faster, because anytime there's a motion event, the Home app will refresh that image automatically in the background.

"But wait!" you say..."how do I not get spammed?!" Under each notification setting you'll see additional options for `Time` and `People`. **This** is where you can set how often you want to your iPhone to alert you to a motion event. The options are quite robust and very flexible. So...if you only want to be alerted when you aren't home, use the `People` option to only alert you when you (or everyone in your house if you choose) aren't home.

What this allows you to do is to have your cake and eat it too - when the Home app is alerted that a motion event has occurred, it will refresh it's snapshot in the background, every time. You only get alerted with a push notification if you really wanted to be and you can customize those notifications in flexible ways within the Home app.

##### Motion Switches
Motion switches exist as a way to tell HBUP to stop sending motion event updates to HomeKit when Protect detects them. There are situations where this may be what you really want to do so, but for the most part, this isn't really useful. What most users tend to want is control over the push notifications they receive on the iPhones and iPads. That's best done within the Home app notification settings for the camera, and not by disabling event updates from the camera to HomeKit. That's why, by default, motion switches are disabled - most users don't need them and they degrade from a responsive user experience in the Home app itself.
