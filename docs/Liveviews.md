<SPAN ALIGN="CENTER" STYLE="text-align:center">
<DIV ALIGN="CENTER" STYLE="text-align:center">

[![homebridge-unifi-protect2: Native HomeKit support for UniFi Protect](https://raw.githubusercontent.com/hjdhjd/homebridge-unifi-protect2/master/homebridge-protect.svg)](https://github.com/hjdhjd/homebridge-unifi-protect2)

# Homebridge UniFi Protect<SUP STYLE="font-size: smaller; color:#0559C9;">2</SUP>

[![Downloads](https://img.shields.io/npm/dt/homebridge-unifi-protect2?color=%230559C9&style=for-the-badge)](https://www.npmjs.com/package/homebridge-unifi-protect2)
[![Version](https://img.shields.io/npm/v/homebridge-unifi-protect2?color=%230559C9&label=UniFi%20Protect%202&logo=ubiquiti&logoColor=%230559C9&style=for-the-badge)](https://www.npmjs.com/package/homebridge-unifi-protect2)
[![verified-by-homebridge](https://img.shields.io/badge/homebridge-verified-blueviolet?color=%2357277C&style=for-the-badge)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)

## HomeKit support for the UniFi Protect ecosystem using [Homebridge](https://homebridge.io).
</DIV>
</SPAN>

`homebridge-unifi-protect2` is a [Homebridge](https://homebridge.io) plugin that provides HomeKit support to the [UniFi Protect](https://unifi-network.ui.com/video-security) device ecosystem. [UniFi Protect](https://unifi-network.ui.com/video-security) is [Ubiquiti's](https://www.ui.com) next-generation video security platform, with rich camera, doorbell, and NVR controller hardware options for you to choose from, as well as an app which you can use to view, configure and manage your video camera and doorbells.

### Liveview Scenes
Plugin-specific liveview scenes are really a way to further tailor how you activate or deactivate motion detection across multiple cameras in a single click. I wanted to provide a way for users to be able to create groups of cameras that can have motion detection toggled at a time and I experimented with a couple of ways to do it:

  * Use [HomeKit](https://www.apple.com/ios/home/) automation events to create scenes that activate or deactivate groups of cameras. While this works, it has scaling challenges with larger numbers of cameras and the [HomeKit](https://www.apple.com/ios/home/) UI. This also won't inform the user when those scenes are set, merely activate or deactivate those scenes.
  * Create a configuration option in the plugin to create a switch accessory that allows you to aggregate cameras and control them through a single switch. This one also doesn't notify users when a switch has been activated.

Ultimately, as I was playing more with the second option, I decided that configuring this through `config.json` or the Homebridge webUI was going to be cumbersome and a less than optimal user experience. What to do?

Well, the Protect webUI already has a nice feature called liveviews that allows you to create an aggregated view of cameras. It's straightforward to use and intuitive. Why not use that as a starting point to specify which cameras you want to group together? Then, what was the best way to give users options in how to do so - well, [HomeKit](https://www.apple.com/ios/home/) has a *security system accessory* that allows for setting multiple security states, and will notify the user when switching to any of those states. Seems very well-suited to the task, and that brings us to how all this works.

Finally, you might want to create a way to toggle multiple cameras at once in the form of a switch, either in addition to, or instead of, a security system accessory, so we support that too to give you as much flexibility as you'd like in tailoring your experience.

### <A NAME="security-system"></A>How to configure and use the liveview security system feature

First, we need to understand the security system accessory in [HomeKit](https://www.apple.com/ios/home/). This accessory is best described as a switch with multiple settings. You can set a security system accessory to the following states using the Home app:

| Security System State | Description
|-----------------------|----------------------------------
| **Home**              | Your home is occupied and the residents are active.
| **Away**              | Your home is unoccupied.
| **Night**             | Your home is occupied, and the residents are sleeping.
| **Off**               | disarmed.

Next, you have the UniFi Protect *Liveview* functionality in the Protect webUI. You can manage your liveviews by going to `https://your-protect-controller/liveview`. You can add, remove, or modify any liveviews you have setup in this interface.

Now, to put all the pieces together. What `homebridge-unifi-protect2` does is:

 * Periodically check the controller to see if we have certain liveviews configured.
 * If there are no liveviews specific to this plugin, then `homebridge-unifi-protect2` will remove the security system accessory (if it was previously present) from [HomeKit](https://www.apple.com/ios/home/) so we don't clutter up with unneeded accessories.
 * If you have configured plugin-specific liveviews, they will be linked to the security system state settings above. You don't need to configure all of them, you can configure certain ones and not others. If there's at least one plugin-specific liveview present, the security system accessory will appear in [HomeKit](https://www.apple.com/ios/home/).

Creating plugin-specific liveviews are as simple as ensuring they are named:

| Security System State | Liveview
|-----------------------|----------------------------------
| **Home**              | Protect-Home
| **Away**              | Protect-Away
| **Night**             | Protect-Night
| **Off**               | Protect-Off (this one is special though - see below)

Once configured, you can set the security system state in the Home app. When you select a setting - *Away* for example - it will lookup all the cameras associated with that liveview and activate motion detection for those cameras, **and it will disable motion detection on all other cameras**. Put another way - when using this feature, and you enable a specific security system state, only those cameras will have motion detection active. All other cameras will have motion detection set to off.

### <A NAME="switch"></A>How to configure and use the liveview switch feature

In addition to the above, `homebridge-unifi-protect2` can create switches based on arbitrary liveviews that you create. To use this feature, you create a liveview and choose a name for it beginning with `Protect-` followed by whatever you want to call this switch. The only reserved names are the ones above for the security system feature.

For example, if you configure a liveview named `Protect-Outside`, you'll see a switch created in the Home app called *UDM-Pro Outside*, assuming your controller is a UDM-Pro. Toggling the switch on and off will turn on and off motion detection in the cameras configured in the liveview.

There's a crucial difference between liveview switches and the liveview security system accessory: ***liveview switches only impact the cameras you've configured in that liveview***. The security system accessory will disable motion detection on all cameras not explicitly configured in a given liveview scene (with the exception of the *Off* scene, which is special - [see above](#security-system)).

### Some fun facts
  * You don't need to configure all the liveviews. If you have at least one, the security system accessory will appear. For security system states with no corresponding liveviews, nothing will happen.
  * UniFi Protect will allow you to have multiple liveviews with the same name. In this case, `homebridge-unifi-protect2` will pull all the cameras in all the liveviews with the same name and control them together.
  * There is a setting when editing liveviews called `Share view with others`. This makes a given liveview available to all users, instead of just the user you're currently logged in with. Why does this matter? If you use a different username and password for `homebridge-unifi-protect2` than the one you use to login, you'll want to ensure that any views you create are shared with all users so they can be used with other usernames. Alternatively, login to the Protect webUI with the same username you configured `homebridge-unifi-protect2` to configure liveviews for that user.
  * You don't need to restart the plugin to make any of this work. When you configure liveviews, they'll get detected and configured automagically.
  * The *Off* state is special. If you don't have a plugin-specific liveview for Off, it will default to turning off motion detection in [HomeKit](https://www.apple.com/ios/home/) for all cameras attached to this Protect controller. If you do create a plugin-specific liveview for *Off*, it will honor those settings instead.
