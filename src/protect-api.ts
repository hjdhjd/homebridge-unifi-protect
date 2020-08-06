/* Copyright(C) 2020, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-api.ts: Our UniFi Protect API implementation.
 */
import { Logging } from "homebridge";
import https from "https";
import fetch, { Headers, Response, RequestInfo, RequestInit } from "node-fetch";
import WebSocket from "ws";
import { ProtectPlatform } from "./protect-platform";
import {
  ProtectCameraChannelConfigInterface,
  ProtectCameraConfig,
  ProtectCameraConfigInterface,
  ProtectNvrBootstrap,
  ProtectNvrUserConfig
} from "./protect-types";
import { PROTECT_API_ERROR_LIMIT, PROTECT_API_RETRY_TIME } from "./settings";
import util from "util";

/*
 * The UniFi Protect API is largely undocumented and has been reverse engineered mostly through
 * the web interface, and trial and error.
 *
 * Here's how the UniFi Protect API works:
 *
 * 1. Login to the UniFi Protect NVR device (UCKgen2+, UDM-Pro, UNVR) and acquire security
 *    credentials for further calls to the API. The method for doing so varies between
 *    UnifiOS and non-UnifiOS devices.
 *
 * 2. Enumerate the list of UniFi Protect devices by calling the bootstrap URL. This
 *    contains almost everything you would want to know about this particular UniFi Protect NVR
 *    installation.
 *
 * Those are the basics and gets us up and running.
 */

export class ProtectApi {
  private apiErrorCount = 0;
  private apiLastSuccess = 0;
  bootstrap!: ProtectNvrBootstrap;
  Cameras!: Array<ProtectCameraConfig>;
  private debug: (message: string, ...parameters: any[]) => void;
  private eventHeartbeatTimer!: NodeJS.Timeout;
  eventListener!: WebSocket;
  eventListenerConfigured = false;
  private headers!: Headers;
  isAdminUser = false;
  isUnifiOs = false;
  private log: Logging;
  private loggedIn = false;
  private nvrAddress: string;
  private password: string;
  private username: string;

  // Initialize this instance with our login information.
  constructor(platform: ProtectPlatform, nvrAddress: string, username: string, password: string) {
    this.debug = platform.debug.bind(platform);
    this.log = platform.log;
    this.nvrAddress = nvrAddress;
    this.username = username;
    this.password = password;

    this.clearLoginCredentials();
  }

  // Identify which NVR device we're logging into and acquire a CSRF token if needed.
  private async acquireToken(): Promise<boolean> {
    // We only need to acquire a token if we aren't already logged in, or we don't already have a token,
    // or don't know which device type we're on.
    if(this.loggedIn || this.headers.has("X-CSRF-Token") || this.headers.has("Authorization")) {
      return true;
    }

    // UniFi OS has cross-site request forgery protection built into it's web management UI.
    // We use this fact to fingerprint it by connecting directly to the supplied NVR address
    // and see ifing there's a CSRF token waiting for us.
    let response = await this.fetch("https://" + this.nvrAddress, { method: "GET" }, false);

    if(response && response.ok) {
      const csrfToken = response.headers.get("X-CSRF-Token");

      // We found a token - we assume it's UniFi OS and we're all set.
      if(csrfToken) {
        this.headers.set("X-CSRF-Token", csrfToken);
        this.isUnifiOs = true;
        return true;
      }
    }

    // If we don't have a token, the only option left for us is to look for a UniFi Cloud Key Gen2+ device.
    response = await this.fetch("https://" + this.nvrAddress + ":7443/", { method: "GET" }, false);

    // If we're able to connect, we're good.
    if(response && response.ok) {
      return true;
    }

    // Couldn't deduce what type of NVR device we were connecting to.
    return false;
  }

  // Log into UniFi Protect.
  private async loginProtect(): Promise<boolean> {
    // If we're already logged in, we're done.
    if(this.loggedIn) {
      return true;
    }

    // Make sure we have a token, or get one if needed.
    if(!(await this.acquireToken())) {
      return false;
    }

    // Log us in.
    const response = await this.fetch(this.authUrl(), {
      body: JSON.stringify({ username: this.username, password: this.password }),
      method: "POST"
    });

    if(!response) {
      return false;
    }

    // We're a UniFi OS device. Configure headers accordingly.
    const csrfToken = response.headers.get("X-CSRF-Token");
    const cookie = response.headers.get("Set-Cookie");
    this.loggedIn = true;

    if(csrfToken && cookie && this.headers.has("X-CSRF-Token")) {
      this.headers.set("Cookie", cookie);
      this.headers.set("X-CSRF-Token", csrfToken);
      // this.log("Successfully logged into UniFi Protect (UniFi OS).");
      return true;
    }

    // We're a UCK NVR device. Configure headers accordingly.
    const authToken = response.headers.get("Authorization");

    if(authToken) {
      this.headers.set("Authorization", "Bearer " + authToken);
      // this.log("Successfully logged into UniFi Protect (UniFi Cloud Key Gen2+).");
      return true;
    }

    // Clear out our login credentials and reset for another try.
    await this.clearLoginCredentials();

    return false;
  }

  // Get our UniFi Protect NVR configuration.
  private async bootstrapProtect(): Promise<boolean> {
    // Log us in if needed.
    if(!(await this.loginProtect())) {
      return false;
    }

    const response = await this.fetch(this.bootstrapUrl(), { method: "GET" });

    if(!response || !response.ok) {
      this.log("%s: Unable to retrieve NVR configuration information from UniFi Protect. Will retry again later.",
        this.nvrAddress);

      // Clear out our login credentials and reset for another try.
      await this.clearLoginCredentials();
      return false;
    }

    // Now let's get our NVR configuration information.
    let data = null;

    try {
      data = await response.json();
    } catch(error) {
      data = null;
      this.log("%s: Unable to parse response from UniFi Protect. Will retry again later.", this.nvrAddress);
    }

    // No camera information returned.
    if(!data || !data.cameras) {
      this.log("%s: Unable to retrieve camera information from UniFi Protect. Will retry again later.", this.nvrAddress);

      // Clear out our login credentials and reset for another try.
      await this.clearLoginCredentials();
      return false;
    }

    // On launch, let the user know we made it.
    const firstRun = this.bootstrap ? false : true;
    this.bootstrap = data;

    if(firstRun) {
      this.log("%s: Connected to the NVR API(address: %s mac: %s).", this.getNvrName(), data.nvr.host, data.nvr.mac);
    }

    // Capture the bootstrap if we're debugging.
    this.debug(util.inspect(this.bootstrap, { colors: true, sorted: true, depth: 10 }));

    // Check for admin user privileges or role changes.
    await this.checkAdminUserStatus(firstRun);

    // We're good. Now connect to the event listener API if we're a UniFi OS device, otherwise, we're done.
    return this.isUnifiOs ? this.launchEventListener() : true;
  }

  // Connect to the UniFi OS realtime events API.
  private async launchEventListener(): Promise<boolean> {
    // Log us in if needed.
    if(!(await this.loginProtect())) {
      return false;
    }

    // If we already have a listener, we're already all set.
    if(this.eventListener) {
      return true;
    }

    this.debug("System listener: %s", this.systemEventsUrl());

    try {
      const ws = new WebSocket(this.systemEventsUrl(), {
        rejectUnauthorized: false,
        headers: {
          Cookie: this.headers.get("Cookie") || ""
        }
      });

      if(!ws) {
        this.log("Unable to connect to system events API. Will retry again later.");
        this.eventListener = null as any;
        this.eventListenerConfigured = false;
        return false;
      }

      this.eventListener = ws;

      // Setup our heartbeat to ensure we can revive our connection if needed.
      this.eventListener.on("open", this.eventListenerHeartbeat);
      this.eventListener.on("ping", this.eventListenerHeartbeat);
      this.eventListener.on("close", () => {
        clearTimeout(this.eventHeartbeatTimer);
      });

      this.eventListener.on("error", (error) => {
        this.log("%s: %s", this.getNvrName(), error);
        this.eventListener.terminate();
        this.eventListener = null as any;
        this.eventListenerConfigured = false;
      });

      this.log("%s: Connected to the realtime system events API.", this.getNvrName());
    } catch(error) {
      this.log("%s: Error connecting to the system events API: %s", this.getNvrName(), error);
    }

    return true;
  }

  // Get the list of UniFi Protect devices associated with a NVR.
  async refreshDevices(): Promise<boolean> {
    // Refresh the configuration from the NVR.
    if(!(await this.bootstrapProtect())) {
      return false;
    }

    this.debug(util.inspect(this.bootstrap, { colors: true, sorted: true, depth: 10 }));

    const newDeviceList: Array<ProtectCameraConfig> = this.bootstrap.cameras;

    // Notify the user about any new devices that we've discovered.
    if(newDeviceList) {
      newDeviceList.forEach((newDevice: ProtectCameraConfig) => {
        if(this.Cameras) {
          // We already know about this device.
          if(this.Cameras.some((x: ProtectCameraConfig) => x.mac === newDevice.mac)) {
            return;
          }
        }

        // We only want to discover managed devices.
        if(!newDevice.isManaged) {
          return;
        }

        // We've discovered a new device.
        this.log("%s: Discovered %s: %s.",
          this.getNvrName(), newDevice.modelKey, this.getDeviceName(newDevice, newDevice.name, true));

        this.debug(util.inspect(newDevice, { colors: true, sorted: true, depth: 10 }));
      });
    }

    // Notify the user about any devices that have disappeared.
    if(this.Cameras) {
      this.Cameras.forEach((existingDevice: ProtectCameraConfig) => {
        if(newDeviceList) {
          // This device still is visible.
          if(newDeviceList.some((x: ProtectCameraConfig) => x.mac === existingDevice.mac)) {
            return;
          }
        }

        // We've had a device disappear.
        this.debug("%s %s: Detected %s removal.",
          this.getNvrName(), this.getDeviceName(existingDevice), existingDevice.modelKey);

        this.debug(util.inspect(existingDevice, { colors: true, sorted: true, depth: 10 }));
      });
    }

    // Save the updated list of devices.
    this.Cameras = newDeviceList;
    return true;
  }

  // Validate if all RTSP channels enabled on all cameras.
  async isAllRtspConfigured(): Promise<boolean> {
    if(!this.bootstrap || !this.bootstrap.cameras) {
      return true;
    }

    // Look for any cameras with any non-RTSP enabled channels.
    return this.bootstrap.cameras.some(camera => camera.channels.some(channel => !channel.isRtspEnabled));
  }

  // Check admin privileges.
  private async checkAdminUserStatus(firstRun = false): Promise<boolean> {
    if(!this.bootstrap || !this.bootstrap.users) {
      return false;
    }

    // Save our prior state so we can detect role changes without having to restart.
    const oldAdminStatus = this.isAdminUser;

    // Find this user.
    const user = this.bootstrap.users.find((x: ProtectNvrUserConfig) => x.id === this.bootstrap.authUserId);

    if(!user || !user.allPermissions) {
      return false;
    }

    // Let's figure out this user's permissions.
    let newAdminStatus = false;
    for(const entry of user.allPermissions) {
      // Each permission line exists as: permissiontype:permissions:scope.
      const permType = entry.split(":");

      // We only care about camera permissions.
      if(permType[0] !== "camera") {
        continue;
      }

      // Get the individual permissions.
      const permissions = permType[1].split(",");

      // We found our administrative privileges - we're done.
      if(permissions.indexOf("write") !== -1) {
        newAdminStatus = true;
        break;
      }
    }

    this.isAdminUser = newAdminStatus;

    // Only admin users can activate RTSP streams. Inform the user on startup, or if we detect a role change.
    if(firstRun && !this.isAdminUser) {
      this.log("%s: The user '%s' requires the Administrator role in order to automatically configure camera RTSP streams.",
        this.getNvrName(), this.username);
    } else if(!firstRun && (oldAdminStatus !== this.isAdminUser)) {
      this.log("%s: Detected a role change for user '%s': the Administrator role has been %s.",
        this.getNvrName(), this.username, this.isAdminUser ? "enabled" : "disabled");
    }

    return true;
  }

  // Enable RTSP stream support on an attached Protect device.
  async enableRtsp(device: ProtectCameraConfigInterface): Promise<ProtectCameraConfig> {
    // Log us in if needed.
    if(!(await this.loginProtect())) {
      return null as any;
    }

    // Only admin users can activate RTSP streams.
    if(!this.isAdminUser) {
      return null as any;
    }

    // At the moment, we only know about camera devices.
    if(device.modelKey !== "camera") {
      return null as any;
    }

    // Do we have any non-RTSP enabled channels? If not, we're done.
    if(!device.channels.some(channel => !channel.isRtspEnabled)) {
      return device;
    }

    // Enable RTSP on all available channels.
    device.channels = device.channels.map((channel: ProtectCameraChannelConfigInterface) => {
      channel.isRtspEnabled = true;
      return channel;
    });

    // Update Protect with the new configuration.
    const response = await this.fetch(this.camerasUrl() + "/" + device.id, {
      body: JSON.stringify({ channels: device.channels }),
      method: "PATCH"
    }, true, false);

    if(!response || !response.ok) {
      this.apiErrorCount++;

      if(response.status === 403) {
        this.log("%s %s: Insufficient privileges to enable RTSP on all channels. Please ensure this username has the Administrator role assigned in UniFi Protect.",
          this.getNvrName(), this.getDeviceName(device));
      } else {
        this.log("%s %s: Unable to enable RTSP on all channels: %s.", this.getNvrName(), this.getDeviceName(device), response.status);
      }

      // We still return our camera object if there is at least one RTSP channel enabled.
      return device;
    }

    // Since we have taken responsibility for decoding response types, we need to reset our API backoff count.
    this.apiErrorCount = 0;
    this.apiLastSuccess = Date.now();

    // Everything worked, save the new channel array.
    return await response.json();
  }

  // Utility to generate a nicely formatted NVR string.
  getNvrName(): string {
    // Our NVR string, if it exists, appears as:
    // NVR [NVR Type].
    // Otherwise, we appear as NVRaddress.
    if(this.bootstrap && this.bootstrap.nvr) {
      return this.bootstrap.nvr.name + " [" + this.bootstrap.nvr.type + "]";
    } else {
      return this.nvrAddress;
    }
  }

  // Utility to generate a nicely formatted device string.
  getDeviceName(device: ProtectCameraConfig, name: string = device.name, deviceInfo = false): string {
    // A completely enumerated device will appear as:
    // DeviceName [Device Type] (address: IP address, mac: MAC address).
    return name + " [" + device.type + "]" +
      (deviceInfo ? " (address: " + device.host + " mac: " + device.mac + ")" : "");
  }

  // Return the URL to directly access cameras, adjusting for Protect NVR variants.
  camerasUrl(): string {
    // Updating the channels on a UCK Gen2+ device is done through: https://protect-nvr-ip:7443/api/cameras/CAMERAID.
    // Boostrapping a UniFi OS device is fone through: https://protect-nvr-ip/proxy/protect/api/cameras/CAMERAID.
    return "https://" + this.nvrAddress + (this.isUnifiOs ? "/proxy/protect/api/cameras" : ":7443/api/cameras");
  }

  // Return the right authentication URL, depending on which Protect NVR platform we are using.
  private authUrl(): string {
    // Authenticating a UCK Gen2+ device is done through: https://protect-nvr-ip:7443/api/auth.
    // Authenticating a UniFi OS device is fone through: https://protect-nvr-ip/api/auth/login.
    return "https://" + this.nvrAddress + (this.isUnifiOs ? "/api/auth/login" : ":7443/api/auth");
  }

  // Return the right bootstrap URL, depending on which Protect NVR platform we are using.
  private bootstrapUrl(): string {
    // Boostrapping a UCK Gen2+ device is done through: https://protect-nvr-ip:7443/api/bootstrap.
    // Boostrapping a UniFi OS device is fone through: https://protect-nvr-ip/proxy/protect/api/bootstrap.
    return "https://" + this.nvrAddress + (this.isUnifiOs ? "/proxy/protect/api/bootstrap" : ":7443/api/bootstrap");
  }

  // Return the system events API URL, if it's supported by this UniFi Protect device type.
  private systemEventsUrl(): string {
    // UCK Gen2+ devices don't support the websockets events API.
    if(!this.isUnifiOs) {
      return "";
    }

    return "wss://" + this.nvrAddress + "/api/ws/system";
  }

  // Utility to check the heartbeat of our listener.
  private eventListenerHeartbeat() {
    const self = this;

    clearTimeout(this.eventHeartbeatTimer);

    // Use `WebSocket#terminate()`, which immediately destroys the connection,
    // instead of `WebSocket#close()`, which waits for the close timer.
    // Delay should be equal to the interval at which your server
    // sends out pings plus a conservative assumption of the latency.
    this.eventHeartbeatTimer = setTimeout(() => {
      if(self.eventListener) {
        self.eventListener.terminate();
        self.eventListener = null as any;
        self.eventListenerConfigured = false;
      }
    }, 300 * 1000);
  }

  // Utility to clear out old login credentials or attempts.
  private async clearLoginCredentials() {
    this.isAdminUser = false;
    this.isUnifiOs = false;
    this.loggedIn = false;
    this.bootstrap = null as any;

    if(this.eventListener) {
      this.eventListener.terminate();
      this.eventListener = null as any;
      this.eventListenerConfigured = false;
    }

    this.headers = new Headers();
    this.headers.set("Content-Type", "application/json");
  }

  // Utility to let us streamline error handling and return checking from the Protect API.
  async fetch(url: RequestInfo, options: RequestInit = { method: "GET"}, logErrors = true, decodeResponse = true): Promise<Response> {
    let response: Response;

    // Since Protect often uses self-signed certificates, we need to disable TLS validation.
    const httpsAgent = new https.Agent({ rejectUnauthorized: false });

    options.agent = httpsAgent;
    options.headers = this.headers;

    try {
      const now = Date.now();

      // Throttle this after ten attempts.
      if(this.apiErrorCount >= PROTECT_API_ERROR_LIMIT) {
        // Let the user know we've got an API problem.
        if(this.apiErrorCount === PROTECT_API_ERROR_LIMIT) {
          this.log("%s: Throttling API calls due to errors with the %s previous attempts. I'll retry again in %s minutes.",
            this.getNvrName(), this.apiErrorCount, PROTECT_API_RETRY_TIME / 60);
          this.apiErrorCount++;
          this.apiLastSuccess = now;
          return null as any;
        }

        // Throttle our API calls.
        if((this.apiLastSuccess + (PROTECT_API_RETRY_TIME * 1000)) > now) {
          return null as any;
        }

        // Inform the user that we're out of the penalty box and try again.
        this.log("%s: Resuming connectivity to the UniFi Protect API after throttling for %s minutes.",
          this.getNvrName(), PROTECT_API_RETRY_TIME / 60);
        this.apiErrorCount = 0;
      }

      response = await fetch(url, options);

      // The caller will sort through responses instead of us.
      if(!decodeResponse) {
        return response;
      }

      // Bad username and password.
      if(response.status === 401) {
        this.log("Invalid login credentials given. Please check your login and password.");
        this.apiErrorCount++;
        return null as any;
      }

      // Insufficient privileges.
      if(response.status === 403) {
        this.apiErrorCount++;
        this.log("Insufficient privileges for this user. Please check the roles assigned to this user and ensure it has sufficient privileges.");
        return null as any;
      }

      // Some other unknown error occurred.
      if(!response.ok) {
        this.apiErrorCount++;
        this.log("Error: %s - %s", response.status, response.statusText);
        return null as any;
      }

      this.apiLastSuccess = Date.now();
      this.apiErrorCount = 0;
      return response;
    } catch(error) {
      this.apiErrorCount++;

      switch(error.code) {
        case "ECONNREFUSED":
          this.log("%s: Connection refused.", this.nvrAddress);
          break;

        case "ECONNRESET":
          this.log("%s: Connection reset.", this.nvrAddress);
          break;

        case "ENOTFOUND":
          this.log("%s: Hostname or IP address not found. Please ensure the address you configured for this UniFi Protect controller is correct.",
            this.nvrAddress);
          break;

        default:
          if(logErrors) {
            this.log(error);
          }
      }

      return null as any;
    }
  }
}
