/* Copyright(C) 2020, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-types.ts: Type definitions for UniFi Protect.
 */
// An semi-complete description of the UniFi Protect NVR bootstrap JSON.
export interface ProtectNvrBootstrapInterface {
  accessKey: string,
  authUserId: string,
  bridges: any[],
  cameras: ProtectCameraConfig[],
  cloudPortalUrl: string,
  groups: any[],
  lastUpdateId: string,
  lights: any[],
  liveviews: ProtectNvrLiveviewConfig[],
  nvr: ProtectNvrConfig,
  sensors: any[],
  users: ProtectNvrUserConfig[],
  viewers: any[]
}

// A semi-complete description of the UniFi Protect NVR configuration JSON.
export interface ProtectNvrConfigInterface {
  availableUpdate: string,
  canAutoUpdate: boolean,
  cloudConnectionError: string,
  disableAudio: boolean,
  doorbellSettings: {
    defaultMessageText: string,
    defaultMessageResetTimeoutMs: number,
    customMessages: string[],
    allMessages: {
      type: string,
      text: string
    }[]
  },
  enableAutomaticBackups: boolean,
  enableCrashReporting: boolean,
  enableStatsReporting: boolean,
  errorCode: string,
  featureFlags: {
    beta: boolean,
    dev: boolean
  },
  firmwareVersion: string,
  hardwareId: string,
  hardwarePlatform: string,
  hardwareRevision: string,
  host: string,
  hostType: string,
  hosts: string[],
  id: string,
  isAdopted: boolean,
  isAway: boolean,
  isConnectedToCloud: boolean,
  isHardware: boolean,
  isSetup: boolean,
  isSshEnabled: boolean,
  isStation: boolean,
  isStatsGatheringEnabled: boolean,
  isUpdating: boolean,
  lastSeen: number,
  lastUpdateAt: string,
  locationSettings: {
    isAway: boolean,
    isGeofencingEnabled: boolean,
    latitude: number,
    longitude: number,
    radius: number
  },
  mac: string,
  modelKey: string,
  name: string,
  network: string,
  ports: {
    cameraEvents: number,
    cameraHttps: number,
    cameraTcp: number,
    discoveryClient: number,
    elementsWss: number,
    emsCLI: number,
    emsLiveFLV: number,
    http: number,
    https: number,
    liveWs: number,
    liveWss: number,
    rtmp: number,
    rtsp: number,
    tcpStreams: number,
    ucore: number,
    ump: number
  },
  recordingRetentionDurationMs: string,
  releaseChannel: string,
  setupCode: string,
  storageInfo: any,
  timeFormat: string,
  timezone: string,
  type: string,
  uiVersion: string,
  upSince: number,
  uptime: number,
  version: string,
  wifiSettings: any
}

// A semi-complete description of the UniFi Protect camera JSON.
export interface ProtectCameraConfigInterface {
  apMac: string,
  apRssi: string,
  audioBitrate: number,
  canManage: boolean,
  channels: ProtectCameraChannelConfigInterface[],
  connectionHost: string,
  featureFlags: {
    canAdjustIrLedLevel: boolean,
    canMagicZoom: boolean,
    canOpticalZoom: boolean,
    canTouchFocus: boolean,
    hasAccelerometer: boolean,
    hasAec: boolean,
    hasAutoICROnly: boolean,
    hasBattery: boolean,
    hasBluetooth: boolean,
    hasChime: boolean,
    hasExternalIr: boolean,
    hasHdr: boolean,
    hasIcrSensitivity: boolean,
    hasLcdScreen: boolean,
    hasLdc: boolean,
    hasLedIr: boolean,
    hasLedStatus: boolean,
    hasLineIn: boolean,
    hasMic: boolean,
    hasMotionZones: boolean,
    hasPrivacyMask: boolean,
    hasRtc: boolean,
    hasSdCard: boolean,
    hasSpeaker: boolean,
    hasWifi: boolean
  },
  firmwareBuild: string,
  firmwareVersion: string,
  hardwareRevision: string,
  hasSpeaker: boolean,
  hasWifi: boolean,
  hdrMode: boolean,
  host: string,
  id: string,
  isAdopted: boolean,
  isAdopting: boolean,
  isAttemptingToConnect: boolean,
  isConnected: boolean,
  isDark: boolean,
  isHidden: boolean,
  isManaged: boolean,
  isMicEnabled: boolean,
  isMotionDetected: boolean,
  isProbingForWifi: boolean,
  isProvisioned: boolean,
  isRebooting: boolean,
  isRecording: boolean,
  isSshEnabled: boolean,
  isUpdating: boolean,
  ispSettings: {
    aeMode: string,
    brightness: number,
    contrast: number,
    dZoomCenterX: number,
    dZoomCenterY: number,
    dZoomScale: number,
    dZoomStreamId: number,
    denoise: number,
    focusMode: string,
    focusPosition: number,
    hue: number,
    icrSensitivity: number,
    irLedLevel: number,
    irLedMode: string,
    is3dnrEnabled: boolean,
    isAggressiveAntiFlickerEnabled: boolean,
    isAutoRotateEnabled: boolean,
    isExternalIrEnabled: boolean,
    isFlippedHorizontal: boolean,
    isFlippedVertical: boolean,
    isLdcEnabled: boolean,
    isPauseMotionEnabled: boolean,
    saturation: number,
    sharpness: number,
    touchFocusX: number,
    touchFocusY: number,
    wdr: number,
    zoomPosition: number
  },
  lastMotion: number,
  lastRing: number,
  lastSeen: number,
  lcdMessage: {
    resetAt: number | null,
    text: string,
    type: string
  },
  ledSettings: {
    blinkRate: number,
    isEnabled: boolean
  },
  mac: string,
  micVolume: number,
  modelKey: string
  name: string,
  osdSettings: {
    isDateEnabled: boolean,
    isDebugEnabled: boolean,
    isLogoEnabled: boolean,
    isNameEnabled: boolean
  },
  phyRate: number,
  pirSettings: {
    pirMotionClipLength: number,
    pirSensitivity: number,
    timelapseFrameInterval: number,
    timelapseTransferInterval: number
  },
  platform: string,
  state: string,
  type: string,
  wifiConnectionState: {
    channel: number,
    frequency: number,
    phyRate: number,
    signalQuality: number,
    signalStrength: number
  }
}

// A semi-complete description of the UniFi Protect camera channel JSON.
export interface ProtectCameraChannelConfigInterface {
  bitrate: number,
  enabled: boolean,
  fps: number,
  fpsValues: number[],
  height: number,
  id: string,
  idrInterval: number,
  isRtspEnabled: boolean,
  maxBitrate: number,
  minBitrate: number,
  minClientAdaptiveBitRate: number,
  minMotionAdaptiveBitRate: number,
  name: string,
  rtspAlias: string,
  videoId: string,
  width: number
}

// A semi-complete description of the UniFi Protect NVR liveview JSON.
export interface ProtectNvrLiveviewConfigInterface {
  id: string,
  isDefault: boolean,
  isGlobal: boolean,
  layout: number,
  modelKey: string,
  name: string,
  owner: string,
  slots: { cameras: string[], cycleInterval: number, cycleMode: string } []
}

// A semi-complete description of the UniFi Protect NVR user JSON.
export interface ProtectNvrUserConfigInterface {
  alertRules: any[],
  allPermissions: string[],
  cloudAccount: string,
  email: string,
  enableNotifications: boolean,
  firstName: string,
  groups: string[],
  hasAcceptedInvite: boolean,
  id: string,
  isOwner: boolean,
  lastLoginIp: string,
  lastLoginTime: number,
  lastName: string,
  localUsername: string,
  location: {
    isAway: boolean,
    latitude: string,
    longitude: string },
  modelKey: string,
  name: string,
  permissions: string[],
  role: string,
  settings: {
    flags: string[]
  },
  syncSso: boolean
}

// A semi-complete description of the UniFi Protect system events JSON.
export interface ProtectNvrSystemEventInterface {
  apps: {
    apps: any[],
    controllers: ProtectNvrSystemEventController[]
  },
  system: any,
  type: string
}

// A semi-complete description of the UniFi Protect system events controller JSON.
export interface ProtectNvrSystemEventControllerInterface {
  harddriveRequired: true,
  info: {
    events: number[],
    isAdopted: boolean,
    isConnectedToCloud: boolean,
    isSetup: boolean,
    lastMotion: number,
    lastMotionCamera: string,
    lastMotionCameraAddress: string,
    lastMotionCameraModel: string,
    managedCameras: number,
    offlineCameras: number,
    oldestRecording: number,
    onlineCameras: number,
    recordingSpaceTotal: number,
    recordingSpaceUsed: number,
    retentionTime: number,
    startedAt: number,
    throughput: number,
    timeFormat: string,
    updateAvailable: boolean,
    updateVersion: string
  },
  installState: string,
  isConfigured: boolean,
  isInstalled: boolean,
  isRunning: boolean,
  name: string,
  port: number,
  required: boolean,
  state: string,
  status: string,
  statusMessage: string,
  swaiVersion: number,
  type: string,
  ui: {
    apiPrefix: string,
    baseUrl: string,
    cdnPublicPaths: string[],
    entrypoint: string,
    hotkey: string,
    icon: string,
    publicPath: string,
    swaiVersion: number
  },
  uiNpmPackageName: string,
  uiVersion: string,
  unadoptedDevices: any[],
  updateAvailable: string,
  version: string
}

// Plugin configuration options.
export interface ProtectOptions {
  debugAll: boolean,
  ffmpegOptions: string,
  motionDuration: number,
  controllers: ProtectNvrOptions[],
  options: string[],
  verboseFfmpeg: boolean,
  videoProcessor: string
}

// NVR configuration options.
export interface ProtectNvrOptions {
  address: string,
  doorbellMessages: {
    duration: number,
    message: string
  }[],
  mqttTopic: string,
  mqttUrl: string,
  name: string,
  refreshInterval: number,
  username: string,
  password: string
}

// This type declaration make all properties optional recursively including nested objects. This should
// only be used on JSON objects only. Otherwise...you're going to end up with class methods marked as
// optional as well. Credit for this belongs to: https://github.com/joonhocho/tsdef. #Grateful
export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends Array<infer I> ? Array<DeepPartial<I>> : DeepPartial<T[P]>
};

// We use types instead of interfaces here because we can more easily set the entire thing as readonly.
// Unfortunately, interfaces can't be quickly set as readonly in Typescript without marking each and
// every property as readonly along the way.
export type ProtectNvrBootstrap = Readonly<ProtectNvrBootstrapInterface>;
export type ProtectNvrConfig = Readonly<ProtectNvrConfigInterface>;
export type ProtectCameraConfig = Readonly<ProtectCameraConfigInterface>;
export type ProtectCameraConfigPayload = DeepPartial<ProtectCameraConfigInterface>;
export type ProtectCameraChannelConfig = Readonly<ProtectCameraChannelConfigInterface>;
export type ProtectNvrLiveviewConfig = Readonly<ProtectNvrLiveviewConfigInterface>;
export type ProtectNvrSystemEvent = Readonly<ProtectNvrSystemEventInterface>;
export type ProtectNvrSystemEventController = Readonly<ProtectNvrSystemEventControllerInterface>;
export type ProtectNvrUserConfig = Readonly<ProtectNvrUserConfigInterface>;
