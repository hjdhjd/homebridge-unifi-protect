<SPAN ALIGN="CENTER" STYLE="text-align:center">
<DIV ALIGN="CENTER" STYLE="text-align:center">

[![homebridge-unifi-protect: Native HomeKit support for UniFi Protect](https://raw.githubusercontent.com/hjdhjd/homebridge-unifi-protect/main/images/homebridge-unifi-protect.svg)](https://github.com/hjdhjd/homebridge-unifi-protect)

# Homebridge UniFi Protect

[![Downloads](https://img.shields.io/npm/dt/homebridge-unifi-protect?color=%230559C9&logo=icloud&logoColor=%23FFFFFF&style=for-the-badge)](https://www.npmjs.com/package/homebridge-unifi-protect)
[![Version](https://img.shields.io/npm/v/homebridge-unifi-protect?color=%230559C9&label=Latest%20Version&logo=ubiquiti&logoColor=%23FFFFFF&style=for-the-badge)](https://www.npmjs.com/package/homebridge-unifi-protect)
[![UniFi Protect@Homebridge Discord](https://img.shields.io/discord/432663330281226270?color=0559C9&label=Discord&logo=discord&logoColor=%23FFFFFF&style=for-the-badge)](https://discord.gg/QXqfHEW)
[![verified-by-homebridge](https://img.shields.io/badge/homebridge-verified-blueviolet?color=%23491F59&style=for-the-badge&logoColor=%23FFFFFF&logo=homebridge)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)

## Complete HomeKit support for the UniFi Protect ecosystem using [Homebridge](https://homebridge.io).
</DIV>
</SPAN>

`homebridge-unifi-protect` is a [Homebridge](https://homebridge.io) plugin that provides HomeKit support to the [UniFi Protect](https://ui.com/camera-security) device ecosystem. [UniFi Protect](https://ui.com/camera-security) is [Ubiquiti's](https://www.ui.com) video security platform, with rich camera, doorbell, and NVR controller hardware options for you to choose from, as well as an app which you can use to view, configure and manage your video camera and doorbells.

### Viewport Support

A UniFi Protect Viewport is a small dedicated device that drives a TV or monitor to display a live view of your cameras. HBUP brings control of what that Viewport shows into HomeKit.

For each of the multiview layouts you've configured on your Protect controller, HBUP adds a switch to the Viewport's accessory in HomeKit. Flip one on and that layout becomes what the Viewport shows on screen. Only one can be displayed at a time, so turning one switch on turns the others off, mirroring how the device itself behaves.

The set of switches tracks your controller live...add, remove, or rename a layout in Protect and the switches follow along, with no need to restart Homebridge.

This makes for a nice automation building block. Want the Viewport by the front door to flip to your entryway cameras when the doorbell rings, then return to its usual layout a few minutes later? A pair of HomeKit automations toggling these switches will do exactly that.

#### A Note on Naming

Ubiquiti calls these camera layouts *multiviews* in the current Protect app. You may still see the older term *liveviews* in places, including in some of HBUP's own configuration and in the plugin's separate [liveview scenes](https://github.com/hjdhjd/homebridge-unifi-protect/blob/main/docs/Liveviews.md) feature, which uses the same underlying Protect construct for a completely different purpose (grouping cameras for motion-detection control). They're the same layouts either way...if you see *multiviews* in the Protect app, those are what these Viewport switches control.

#### MQTT

If you'd rather drive your Viewports from an MQTT-based automation flow, the `liveview` topic reports the currently displayed layout and lets you set it by name. See the [MQTT documentation](https://github.com/hjdhjd/homebridge-unifi-protect/blob/main/docs/MQTT.md) for the exact topics.
