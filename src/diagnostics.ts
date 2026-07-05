/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * diagnostics.ts: Named node:diagnostics_channel publishers for homebridge-unifi-protect.
 */
import type { TypedEvent } from "unifi-protect";
import diagnosticsChannel from "node:diagnostics_channel";

/**
 * The plugin's forward-only observability surface, expressed as `node:diagnostics_channel` publishers - the very primitive the unifi-protect library uses for its own
 * channels, so there is one observability idiom across the plugin and the library it consumes. A subscriber attaches to a channel to watch an internal lifecycle
 * event without the plugin having to grow bespoke logging hooks or per-event callback parameters; every publisher gates on `hasSubscribers` before building a
 * payload, so there is exactly zero cost when nobody is listening.
 *
 * Channel names follow a stable `hbup:<subsystem>:<event>` taxonomy and are declared exactly once here; call sites import the publisher they need rather than
 * re-deriving the channel-name string, so a rename is a single edit and a typo is impossible at the call site. This is the mirror of the library's diagnostics
 * module, kept deliberately small: the channels declared here - firehose dispatch, controller lifecycle, the per-accessory observer-wake, and the
 * reachability fan-out - cover the plugin's internal lifecycle and per-device reaction points.
 */
export const channels = {

  // The typed-firehose router dispatched an activity event (smart detection, tamper, doorbell ring, access, authentication, or button press) to a HomeKit delivery
  // method. Fires once per routed event that reaches a delivery method, carrying the discriminated kind and, when a target accessory was resolved, the addressed
  // camera id.
  firehoseDispatch: diagnosticsChannel.channel("hbup:firehose:dispatch"),

  // An NVR-level lifecycle transition: the terminal shutdown abort, the controller-state milestones observed from the connection monitor, and the post-connect
  // "connected" announcement. The single forward-only window onto the controller's lifecycle from the plugin's side.
  nvrLifecycle: diagnosticsChannel.channel("hbup:nvr:lifecycle"),

  // A per-accessory narrow-selector observer yielded - its watched slice changed and its reaction is about to run. The single forward-only window onto the
  // per-device reaction model, naming which accessory woke and which slice triggered it, so a debug subscriber can confirm an observer wakes only on its own field
  // rather than on routine config churn.
  observerWake: diagnosticsChannel.channel("hbup:observer:wake"),

  // The NVR's connection-observe loop pushed a reachability change out to an accessory's StatusActive fan-out (the N+1 topology: one reader of controller health,
  // a push to many accessories). Fires per accessory whose reachability actually flipped.
  reachabilityFanout: diagnosticsChannel.channel("hbup:reachability:fanout")
} as const;

/**
 * Payload published on {@link channels.firehoseDispatch}. `kind` is the dispatched event's discriminated kind (e.g. `smartDetect`, `tamperDetected`, `doorbellRing`,
 * `accessEvent`, `authDetected`, `buttonPressed`); `cameraId` is the addressed camera/device id, present whenever the router resolved a target accessory.
 */
export interface FirehoseDispatchPayload {

  cameraId?: string;
  kind: TypedEvent["kind"];
}

/**
 * Payload published on {@link channels.nvrLifecycle}. `event` names the lifecycle milestone: `connected` after a successful connect, `shuttingDown` at the terminal
 * abort chokepoint, and `controllerLost` / `controllerRebooted` / `controllerRecovered` as forwarded from the connection monitor's events.
 */
export interface NvrLifecyclePayload {

  event: "connected" | "controllerLost" | "controllerRebooted" | "controllerRecovered" | "shuttingDown";
}

/**
 * Payload published on {@link channels.reachabilityFanout}. `accessoryId` is the HomeKit accessory UUID; `was` and `now` are the StatusActive value before and
 * after the fan-out, so a subscriber sees the actual reachability flip rather than every idempotent rewrite.
 */
export interface ReachabilityFanoutPayload {

  accessoryId: string;
  now: boolean;
  was: boolean;
}

/**
 * Payload published on {@link channels.observerWake}. `accessoryId` is the HomeKit accessory UUID whose observer woke; `key` is the stable, dotted tag naming the watched
 * slice (e.g. `"camera.videoCodec"`, `"camera.ledSettings"`, `"sensor.tamperingDetectedAt"`), so a subscriber can attribute each wake to the exact reaction it drives.
 */
export interface ObserverWakePayload {

  accessoryId: string;
  key: string;
}
