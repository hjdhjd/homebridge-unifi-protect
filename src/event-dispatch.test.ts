/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * event-dispatch.test.ts: Unit tests for the typed event-firehose router and the controller telemetry publisher.
 *
 * Two layers are pinned here. The bare-motion de-duplication policy is a pure function (shouldDeliverBareMotion), so its truth table is exercised directly with no
 * mocks. The router and telemetry loops are exercised against the real production ProtectEventDispatch, constructed with the minimal mocks its constructor and the loops
 * actually read - a controlled client.events() / client.rawPackets() async stream, a getDeviceById over a fixed device map, an mqtt publish spy, and the feature-option
 * gate. The delivery methods are the dispatch decision's observable effect, so a thin recording subclass overrides them to capture exactly what the router routed; the
 * real run() applies the de-dup and the smart-detect gate before invoking them, so routing and policy are verified together. The casts are confined to the mock seam,
 * matching the posture the reachability and nvr suites already established; the instance under test is the production class.
 */
import { ACCESS_UNLOCK_DURATION, ProtectEventDispatch, shouldDeliverBareMotion } from "./event-dispatch.ts";
import type { AuthMethod, ProtectEventMetadata, TypedEvent } from "unifi-protect";
import { Characteristic, Service, makeTestAccessory } from "./testing.helpers.ts";
import type { ProtectCamera, ProtectDevice } from "./devices/index.ts";
import { describe, mock, test } from "node:test";
import type { Nullable } from "homebridge-plugin-utils";
import { PROTECT_DOORBELL_AUTHSENSOR_DURATION } from "./settings.ts";
import type { ProtectNvr } from "./nvr.ts";
import { ProtectReservedNames } from "./types.ts";
import type { TestAccessory } from "./testing.helpers.ts";
import assert from "node:assert/strict";
import diagnosticsChannel from "node:diagnostics_channel";

// A finite async stream over a fixed item list. The router and telemetry loops consume client.events() / client.rawPackets() with `for await`, so a terminating
// generator lets each loop complete on its own without the test needing to drive the abort signal.
async function *streamOf<T>(items: readonly T[]): AsyncGenerator<T> {

  for(const item of items) {

    yield item;
  }
}

// One captured delivery invocation. The router's observable effect is which delivery method it called, on which device, with which arguments; this is the shape the
// recording subclass records so the assertions can pin routing, de-duplication, and argument threading in one place.
interface DeliveryCall {

  action?: string;
  id: string;
  kind: "access" | "auth" | "doorbell" | "motion" | "tamper";
  lastRing?: Nullable<number>;
  metadata?: unknown;
  method?: AuthMethod;
  objects?: string[];
}

// A real ProtectEventDispatch whose delivery methods are overridden to record rather than touch HomeKit. run() still resolves the target device, applies the bare-motion
// de-duplication policy, and gates smart detections exactly as in production - only the terminal delivery is captured - so these tests pin the routing and policy, not
// the HAP-real characteristic writes (those stay live-validated).
class RecordingDispatch extends ProtectEventDispatch {

  public readonly calls: DeliveryCall[] = [];

  public override motionEventHandler(protectDevice: ProtectDevice, detectedObjects: string[] = [], metadata?: ProtectEventMetadata): void {

    this.calls.push({ id: protectDevice.ufp.id, kind: "motion", metadata, objects: detectedObjects });
  }

  public override doorbellEventHandler(protectDevice: ProtectCamera, lastRing: Nullable<number>): void {

    this.calls.push({ id: protectDevice.ufp.id, kind: "doorbell", lastRing });
  }

  public override accessEventHandler(protectDevice: ProtectCamera, action: string, metadata?: Record<string, unknown>): void {

    this.calls.push({ action, id: protectDevice.ufp.id, kind: "access", metadata });
  }

  public override tamperEventHandler(protectDevice: ProtectCamera): void {

    this.calls.push({ id: protectDevice.ufp.id, kind: "tamper" });
  }

  public override authEventHandler(protectDevice: ProtectCamera, method: AuthMethod, metadata?: ProtectEventMetadata): void {

    this.calls.push({ id: protectDevice.ufp.id, kind: "auth", metadata, method });
  }
}

// Options accepted by makeDispatch, all optional so each test names only the axes it varies.
interface DispatchOptions {

  devices?: Map<string, unknown>;
  events?: TypedEvent[];
  rawPackets?: unknown[];
  telemetryEnabled?: boolean;
}

// Build a mock camera projection carrying only the fields the router reads: identity, the camera model key (so cameraFor narrows to it), the smart-detection capability
// arrays, the smart-detection hint, and an optional HKSV-recording handle. Defaults model the common case - a capable camera with smart detection enabled and recording
// - so a test names only the axis it varies.
const makeCamera = (id: string, options: { hksvRecording?: boolean; smartCapable?: boolean; smartDetectEnabled?: boolean } = {}): unknown => {

  const { hksvRecording = true, smartCapable = true, smartDetectEnabled = true } = options;

  return {

    hints: { smartDetect: smartDetectEnabled },
    stream: hksvRecording ? { hksv: { isRecording: true } } : undefined,
    ufp: { featureFlags: { smartDetectAudioTypes: [], smartDetectTypes: smartCapable ? ["person"] : [] }, id, modelKey: "camera" }
  };
};

// Build a real ProtectEventDispatch (via the recording subclass) over a mock NVR exposing only what the constructor and the loops read. The published array captures
// every mqtt.publish call so the telemetry assertions can read the tuples back; under the v2 signature each tuple is [composed {id}/{topic} tail, payload]. The
// streams are finite, so run() / publishTelemetry() complete on their own without needing the signal to abort.
const makeDispatch = (options: DispatchOptions = {}): { dispatch: RecordingDispatch; published: unknown[][] } => {

  const { devices = new Map<string, unknown>(), events = [], rawPackets = [], telemetryEnabled = false } = options;
  const published: unknown[][] = [];
  const noop = (): void => { /* swallow log output in tests */ };
  const log = { debug: noop, error: noop, info: noop, warn: noop };
  const eventsFn = (): AsyncGenerator<TypedEvent> => streamOf(events);
  const rawPacketsFn = (): AsyncGenerator => streamOf(rawPackets);
  const getDeviceById = (id: string): unknown => devices.get(id) ?? null;
  const hasFeature = (): boolean => telemetryEnabled;
  const publish = (...args: unknown[]): void => { published.push(args); };

  const nvr = {

    client: { events: eventsFn, rawPackets: rawPacketsFn },
    getDeviceById,
    hasFeature,
    log,
    mqtt: { publish },
    platform: { api: { hap: {} }, config: {} },
    ufp: { mac: "AA:BB:CC:DD:EE:FF" }
  };

  return { dispatch: new RecordingDispatch(nvr as unknown as ProtectNvr), published };
};

// A never-aborting signal: the firehose / telemetry streams in these tests are finite, so the loops end on their own and the signal only needs to be a valid argument.
const liveSignal = (): AbortSignal => new AbortController().signal;

describe("bare-motion de-duplication policy (shouldDeliverBareMotion)", () => {

  test("fires bare motion in every case except a capable, smart-enabled camera that is not recording", () => {

    // The policy: fire = HKSV recording OR no smart capability OR smart detection disabled. The lone suppression is the case where smart detection is the source of
    // truth - the camera can smart-detect, the user enabled it, and HKSV is not separately demanding the motion - so the matching smartDetect event will fire instead.
    const cases: { expected: boolean; hksvRecording: boolean; smartCapable: boolean; smartDetectEnabled: boolean }[] = [

      { expected: true, hksvRecording: false, smartCapable: false, smartDetectEnabled: false },
      { expected: true, hksvRecording: false, smartCapable: false, smartDetectEnabled: true },
      { expected: true, hksvRecording: false, smartCapable: true, smartDetectEnabled: false },
      { expected: false, hksvRecording: false, smartCapable: true, smartDetectEnabled: true },
      { expected: true, hksvRecording: true, smartCapable: false, smartDetectEnabled: false },
      { expected: true, hksvRecording: true, smartCapable: false, smartDetectEnabled: true },
      { expected: true, hksvRecording: true, smartCapable: true, smartDetectEnabled: false },
      { expected: true, hksvRecording: true, smartCapable: true, smartDetectEnabled: true }
    ];

    for(const { expected, hksvRecording, smartCapable, smartDetectEnabled } of cases) {

      assert.equal(shouldDeliverBareMotion({ hksvRecording, smartCapable, smartDetectEnabled }), expected,
        "hksvRecording=" + String(hksvRecording) + " smartCapable=" + String(smartCapable) + " smartDetectEnabled=" + String(smartDetectEnabled));
    }
  });
});

describe("firehose router dispatch (real ProtectEventDispatch.run)", () => {

  test("routes a doorbell ring to the doorbell delivery on the addressed camera, threading the timestamp", async () => {

    const devices = new Map<string, unknown>([[ "cam1", makeCamera("cam1") ]]);
    const events: TypedEvent[] = [{ at: 1234, cameraId: "cam1", eventId: "e1", kind: "doorbellRing" }];
    const { dispatch } = makeDispatch({ devices, events });

    await dispatch.run(liveSignal());

    assert.deepEqual(dispatch.calls, [{ id: "cam1", kind: "doorbell", lastRing: 1234 }]);
  });

  test("routes a smart detection to the motion delivery, threading the object types and metadata", async () => {

    const devices = new Map<string, unknown>([[ "cam1", makeCamera("cam1", { smartDetectEnabled: true }) ]]);
    const metadata = { detectedThumbnails: [{ type: "person" }] };
    const events: TypedEvent[] = [{ at: 1, cameraId: "cam1", eventId: "e1", kind: "smartDetect", metadata, objectTypes: [ "person", "vehicle" ] }];
    const { dispatch } = makeDispatch({ devices, events });

    await dispatch.run(liveSignal());

    assert.deepEqual(dispatch.calls, [{ id: "cam1", kind: "motion", metadata, objects: [ "person", "vehicle" ] }],
      "the smart detection is delivered as motion with its object types and metadata threaded through");
  });

  test("filters \"motion\"-tagged thumbnails out of the delivered smart-detection metadata without mutating the source", async () => {

    // With "Create motion events" enabled, Protect tags some detections as plain "motion" inside a smart event's thumbnails; those are not true smart detections, so the
    // router strips them before delivery (preserving the v4 leaf's filter). The genuine "person" thumbnail survives and reaches the delivery; the source object is left
    // untouched, since the firehose event is read-only consumer data v5 owns.
    const devices = new Map<string, unknown>([[ "cam1", makeCamera("cam1", { smartDetectEnabled: true }) ]]);
    const metadata = { detectedThumbnails: [ { type: "person" }, { type: "motion" } ] };
    const events: TypedEvent[] = [{ at: 1, cameraId: "cam1", eventId: "e1", kind: "smartDetect", metadata, objectTypes: ["person"] }];
    const { dispatch } = makeDispatch({ devices, events });

    await dispatch.run(liveSignal());

    assert.deepEqual(dispatch.calls, [{ id: "cam1", kind: "motion", metadata: { detectedThumbnails: [{ type: "person" }] }, objects: ["person"] }],
      "the \"motion\" thumbnail is dropped from the delivered metadata while the genuine smart-detection thumbnail survives");
    assert.deepEqual(metadata.detectedThumbnails, [ { type: "person" }, { type: "motion" } ],
      "the classifier's metadata object is not mutated - the filter builds a copy");
  });

  test("suppresses a smart detection that carries only \"motion\" thumbnails and no object types", async () => {

    // An event whose thumbnails are all "motion" and which carries no smart object types collapses to nothing after the filter, so it must not reach the delivery - the
    // exact v4 suppression that keeps "Create motion events" from spuriously tripping the smart-detection sensors. Filtering happens before the has-anything gate, so the
    // emptied thumbnail list fails the gate.
    const devices = new Map<string, unknown>([[ "cam1", makeCamera("cam1", { smartDetectEnabled: true }) ]]);
    const metadata = { detectedThumbnails: [ { type: "motion" }, { type: "motion" } ] };
    const events: TypedEvent[] = [{ at: 1, cameraId: "cam1", eventId: "e1", kind: "smartDetect", metadata, objectTypes: [] }];
    const { dispatch } = makeDispatch({ devices, events });

    await dispatch.run(liveSignal());

    assert.deepEqual(dispatch.calls, [], "an all-\"motion\"-thumbnail event with no object types is suppressed after the filter empties it");
  });

  test("delivers a smart detection carrying only a surviving thumbnail when no object types are present", async () => {

    // The inverse of the suppression case: an event with no smart object types but a genuine (non-"motion") thumbnail survives the filter, so the has-anything gate's OR
    // lets it through and it reaches the delivery. This guards the gate from being narrowed to require object types.
    const devices = new Map<string, unknown>([[ "cam1", makeCamera("cam1", { smartDetectEnabled: true }) ]]);
    const metadata = { detectedThumbnails: [{ type: "person" }] };
    const events: TypedEvent[] = [{ at: 1, cameraId: "cam1", eventId: "e1", kind: "smartDetect", metadata, objectTypes: [] }];
    const { dispatch } = makeDispatch({ devices, events });

    await dispatch.run(liveSignal());

    assert.deepEqual(dispatch.calls, [{ id: "cam1", kind: "motion", metadata: { detectedThumbnails: [{ type: "person" }] }, objects: [] }],
      "a thumbnail-only smart detection with no object types is still delivered");
  });

  test("does not deliver a smart detection when the camera has smart detection disabled", async () => {

    const devices = new Map<string, unknown>([[ "cam1", makeCamera("cam1", { smartDetectEnabled: false }) ]]);
    const events: TypedEvent[] = [{ at: 1, cameraId: "cam1", eventId: "e1", kind: "smartDetect", objectTypes: ["person"] }];
    const { dispatch } = makeDispatch({ devices, events });

    await dispatch.run(liveSignal());

    assert.deepEqual(dispatch.calls, [], "a smart detection is dropped when the user has smart detection turned off");
  });

  test("delivers bare motion only when the de-duplication policy says smart detection is not the source of truth", async () => {

    // cam1 has no smart capability -> bare motion must fire. cam2 is capable and smart-enabled and not recording -> bare motion must be suppressed (smartDetect owns it).
    const devices = new Map<string, unknown>([

      [ "cam1", makeCamera("cam1", { hksvRecording: false, smartCapable: false, smartDetectEnabled: false }) ],
      [ "cam2", makeCamera("cam2", { hksvRecording: false, smartCapable: true, smartDetectEnabled: true }) ]
    ]);
    const events: TypedEvent[] = [

      { at: 1, cameraId: "cam1", eventId: "e1", kind: "motionDetected" },
      { at: 2, cameraId: "cam2", eventId: "e2", kind: "motionDetected" }
    ];
    const { dispatch } = makeDispatch({ devices, events });

    await dispatch.run(liveSignal());

    assert.deepEqual(dispatch.calls, [{ id: "cam1", kind: "motion", metadata: undefined, objects: [] }],
      "bare motion fires for the non-smart camera and is suppressed for the smart-capable, smart-enabled one");
  });

  test("routes a successful access door-open to the access delivery, threading the action and metadata", async () => {

    const devices = new Map<string, unknown>([[ "cam1", makeCamera("cam1") ]]);
    const metadata = { openSuccess: true };
    const events: TypedEvent[] = [{ action: "open_door", at: 1, deviceId: "cam1", eventId: "e1", kind: "accessEvent", metadata }];
    const { dispatch } = makeDispatch({ devices, events });

    await dispatch.run(liveSignal());

    assert.deepEqual(dispatch.calls, [{ action: "open_door", id: "cam1", kind: "access", metadata }]);
  });

  test("routes a camera tamper occurrence to the tamper delivery on the addressed camera", async () => {

    const devices = new Map<string, unknown>([[ "cam1", makeCamera("cam1") ]]);
    const events: TypedEvent[] = [{ at: 1, cameraId: "cam1", eventId: "e1", kind: "tamperDetected" }];
    const { dispatch } = makeDispatch({ devices, events });

    await dispatch.run(liveSignal());

    assert.deepEqual(dispatch.calls, [{ id: "cam1", kind: "tamper" }], "the tamper occurrence is routed to the camera's tamper delivery");
  });

  test("routes a doorbell auth scan to the auth delivery on the addressed camera, threading the metadata", async () => {

    const devices = new Map<string, unknown>([[ "cam1", makeCamera("cam1") ]]);
    const metadata = { nfc: { nfcId: "card-9", ulpId: "ulp-1" } };
    const events: TypedEvent[] = [{ at: 1, cameraId: "cam1", eventId: "e1", kind: "authDetected", metadata, method: "nfc" }];
    const { dispatch } = makeDispatch({ devices, events });

    await dispatch.run(liveSignal());

    assert.deepEqual(dispatch.calls, [{ id: "cam1", kind: "auth", metadata, method: "nfc" }],
      "the auth scan is routed to the camera's auth delivery with its method and metadata threaded");
  });

  test("is a no-op when the addressed device is absent, for every activity kind", async () => {

    // Every activity kind resolves its target through getDeviceById; an unconfigured id routes nowhere whatever the kind.
    const events: TypedEvent[] = [

      { at: 1, cameraId: "missing", eventId: "e1", kind: "motionDetected" },
      { at: 2, cameraId: "missing", eventId: "e2", kind: "smartDetect", objectTypes: ["person"] },
      { at: 3, cameraId: "missing", eventId: "e3", kind: "tamperDetected" },
      { at: 4, cameraId: "missing", eventId: "e4", kind: "authDetected", metadata: { nfc: { nfcId: "card-9", ulpId: "ulp-1" } }, method: "nfc" },
      { at: 5, cameraId: "missing", eventId: "e5", kind: "doorbellRing" },
      { action: "open_door", at: 6, deviceId: "missing", eventId: "e6", kind: "accessEvent", metadata: { openSuccess: true } }
    ];
    const { dispatch } = makeDispatch({ devices: new Map<string, unknown>(), events });

    await dispatch.run(liveSignal());

    assert.deepEqual(dispatch.calls, [], "an event addressing an unconfigured id routes nowhere, whatever its kind");
  });

  test("is a no-op when the addressed device is not a camera, for every activity kind", async () => {

    // A non-camera projection (e.g. a sensor) shares the id space but is never an activity target; cameraFor narrows it out for every kind.
    const devices = new Map<string, unknown>([[ "sensor1", { ufp: { id: "sensor1", modelKey: "sensor" } } ]]);
    const events: TypedEvent[] = [

      { at: 1, cameraId: "sensor1", eventId: "e1", kind: "motionDetected" },
      { at: 2, cameraId: "sensor1", eventId: "e2", kind: "smartDetect", objectTypes: ["person"] },
      { at: 3, cameraId: "sensor1", eventId: "e3", kind: "tamperDetected" },
      { at: 4, cameraId: "sensor1", eventId: "e4", kind: "authDetected", metadata: { nfc: { nfcId: "card-9", ulpId: "ulp-1" } }, method: "nfc" },
      { at: 5, cameraId: "sensor1", eventId: "e5", kind: "doorbellRing" },
      { action: "open_door", at: 6, deviceId: "sensor1", eventId: "e6", kind: "accessEvent", metadata: { openSuccess: true } }
    ];
    const { dispatch } = makeDispatch({ devices, events });

    await dispatch.run(liveSignal());

    assert.deepEqual(dispatch.calls, [], "a non-camera match is not routed an activity event of any kind");
  });

  test("ignores state-transition kinds, which are the observe loops' concern", async () => {

    const devices = new Map<string, unknown>([[ "cam1", makeCamera("cam1") ]]);
    const events: TypedEvent[] = [

      { data: { id: "cam1" }, id: "cam1", kind: "deviceAdded", modelKey: "camera" } as unknown as TypedEvent,
      { id: "cam1", kind: "devicePatched", modelKey: "camera", patch: {} } as unknown as TypedEvent,
      { id: "cam1", kind: "deviceRemoved", modelKey: "camera" }
    ];
    const { dispatch } = makeDispatch({ devices, events });

    await dispatch.run(liveSignal());

    assert.deepEqual(dispatch.calls, [], "state transitions never reach a delivery method");
  });
});

describe("firehose dispatch diagnostics (hbup:firehose:dispatch)", () => {

  test("publishes a dispatch milestone for each delivered event, naming its kind and camera", async () => {

    const received: unknown[] = [];
    const onDispatch = (message: unknown): void => { received.push(message); };

    diagnosticsChannel.subscribe("hbup:firehose:dispatch", onDispatch);

    try {

      const devices = new Map<string, unknown>([[ "cam1", makeCamera("cam1", { smartDetectEnabled: true }) ]]);
      const events: TypedEvent[] = [

        { at: 1, cameraId: "cam1", eventId: "e1", kind: "doorbellRing" },
        { at: 2, cameraId: "cam1", eventId: "e2", kind: "smartDetect", objectTypes: ["person"] },
        { at: 3, cameraId: "cam1", eventId: "e3", kind: "tamperDetected" },
        { at: 4, cameraId: "cam1", eventId: "e4", kind: "authDetected", metadata: { nfc: { nfcId: "card-9" } }, method: "nfc" },
        { action: "open_door", at: 5, deviceId: "cam1", eventId: "e5", kind: "accessEvent", metadata: { openSuccess: true } }
      ];
      const { dispatch } = makeDispatch({ devices, events });

      await dispatch.run(liveSignal());

      assert.deepEqual(received, [

        { cameraId: "cam1", kind: "doorbellRing" },
        { cameraId: "cam1", kind: "smartDetect" },
        { cameraId: "cam1", kind: "tamperDetected" },
        { cameraId: "cam1", kind: "authDetected" },
        { cameraId: "cam1", kind: "accessEvent" }
      ], "each delivered event publishes one milestone carrying its kind and the addressed camera id");
    } finally {

      diagnosticsChannel.unsubscribe("hbup:firehose:dispatch", onDispatch);
    }
  });

  test("publishes no dispatch milestone for an event the router suppresses", async () => {

    const received: unknown[] = [];
    const onDispatch = (message: unknown): void => { received.push(message); };

    diagnosticsChannel.subscribe("hbup:firehose:dispatch", onDispatch);

    try {

      // A bare motion on a smart-capable, smart-enabled, not-recording camera is suppressed by the de-dup policy. The milestone is published only when an event actually
      // reaches a delivery method, so the suppressed event produces nothing.
      const devices = new Map<string, unknown>([[ "cam1", makeCamera("cam1", { hksvRecording: false, smartCapable: true, smartDetectEnabled: true }) ]]);
      const events: TypedEvent[] = [{ at: 1, cameraId: "cam1", eventId: "e1", kind: "motionDetected" }];
      const { dispatch } = makeDispatch({ devices, events });

      await dispatch.run(liveSignal());

      assert.deepEqual(received, [], "a suppressed event never publishes a dispatch milestone");
    } finally {

      diagnosticsChannel.unsubscribe("hbup:firehose:dispatch", onDispatch);
    }
  });
});

describe("controller telemetry publisher (real ProtectEventDispatch.publishTelemetry)", () => {

  test("publishes every raw frame to the controller telemetry topic when enabled", async () => {

    const rawPackets = [ { header: { modelKey: "camera" }, payload: { a: 1 } }, { header: { modelKey: "event" }, payload: { b: 2 } } ];
    const { dispatch, published } = makeDispatch({ rawPackets, telemetryEnabled: true });

    await dispatch.publishTelemetry(liveSignal());

    assert.equal(published.length, 2, "each raw frame is republished once");
    assert.deepEqual(published[0], [ "AA:BB:CC:DD:EE:FF/telemetry", JSON.stringify(rawPackets[0]) ], "the first frame is published verbatim to the telemetry topic");
    assert.deepEqual(published[1], [ "AA:BB:CC:DD:EE:FF/telemetry", JSON.stringify(rawPackets[1]) ], "the second frame is published verbatim to the telemetry topic");
  });

  test("publishes nothing when telemetry is disabled", async () => {

    const rawPackets = [{ header: { modelKey: "camera" }, payload: { a: 1 } }];
    const { dispatch, published } = makeDispatch({ rawPackets, telemetryEnabled: false });

    await dispatch.publishTelemetry(liveSignal());

    assert.deepEqual(published, [], "a disabled controller never publishes telemetry");
  });
});

// Build a real ProtectEventDispatch (not the recording subclass) wired to a populated HAP double, plus a camera stand-in whose accessory is the supplied TestAccessory.
// The access-unlock delivery is the one step-4 handler that is genuinely restructured (the others moved verbatim from v4), so these tests drive the real method against
// real HAP-double services rather than recording the routing. Only the surface accessEventHandler touches is mocked: the lock service / characteristic identities on hap,
// and the camera's id, log, and accessory.
const makeAccessDispatch = (accessory: TestAccessory): { camera: ProtectCamera; dispatch: ProtectEventDispatch } => {

  const noop = (): void => { /* swallow log output in tests */ };
  const log = { debug: noop, error: noop, info: noop, warn: noop };
  const hap = {

    Characteristic: { LockCurrentState: Characteristic.LockCurrentState, LockTargetState: Characteristic.LockTargetState },
    Service: { LockMechanism: Service.LockMechanism }
  };
  const nvr = { log, platform: { api: { hap }, config: {} } };
  const dispatch = new ProtectEventDispatch(nvr as unknown as ProtectNvr);
  const camera = { accessory, id: "cam-access", log };

  return { camera: camera as unknown as ProtectCamera, dispatch };
};

describe("access unlock delivery (real ProtectEventDispatch.accessEventHandler)", () => {

  test("a successful door-open unlocks the Access lock, then re-secures it after the window", () => {

    mock.timers.enable({ apis: ["setTimeout"] });

    try {

      const accessory = makeTestAccessory();
      const lock = accessory.addService(Service.LockMechanism, "Access Lock", ProtectReservedNames.LOCK_ACCESS);
      const { camera, dispatch } = makeAccessDispatch(accessory);

      dispatch.accessEventHandler(camera, "open_door", { openSuccess: true });

      assert.equal(lock.getCharacteristic(Characteristic.LockCurrentState).value, Characteristic.LockCurrentState.UNSECURED, "the lock reads unlocked immediately");
      assert.equal(lock.getCharacteristic(Characteristic.LockTargetState).value, Characteristic.LockTargetState.UNSECURED, "the lock target is unlocked immediately");

      // Advancing past the re-secure window fires the timer that returns the lock to its resting (secured) state.
      mock.timers.tick(ACCESS_UNLOCK_DURATION);

      assert.equal(lock.getCharacteristic(Characteristic.LockCurrentState).value, Characteristic.LockCurrentState.SECURED, "the lock re-secures after the window");
      assert.equal(lock.getCharacteristic(Characteristic.LockTargetState).value, Characteristic.LockTargetState.SECURED, "the lock target re-secures after the window");
    } finally {

      mock.timers.reset();
    }
  });

  test("ignores an access event whose action is not a door open", () => {

    const accessory = makeTestAccessory();
    const lock = accessory.addService(Service.LockMechanism, "Access Lock", ProtectReservedNames.LOCK_ACCESS);
    const { camera, dispatch } = makeAccessDispatch(accessory);

    dispatch.accessEventHandler(camera, "nfc_read", { openSuccess: true });

    assert.equal(lock.testCharacteristic(Characteristic.LockCurrentState), false, "a non-door-open action never touches the lock");
  });

  test("ignores a door-open that did not succeed", () => {

    const accessory = makeTestAccessory();
    const lock = accessory.addService(Service.LockMechanism, "Access Lock", ProtectReservedNames.LOCK_ACCESS);
    const { camera, dispatch } = makeAccessDispatch(accessory);

    dispatch.accessEventHandler(camera, "open_door", { openSuccess: false });

    assert.equal(lock.testCharacteristic(Characteristic.LockCurrentState), false, "an unsuccessful door-open never touches the lock");
  });

  test("is a no-op when the camera has no Access lock service", () => {

    // No lock service on the accessory; the handler resolves nothing and returns without throwing.
    const accessory = makeTestAccessory();
    const { camera, dispatch } = makeAccessDispatch(accessory);

    assert.doesNotThrow(() => dispatch.accessEventHandler(camera, "open_door", { openSuccess: true }),
      "an accessory without an Access lock is handled cleanly");
  });

  test("a second unlock before the window cancels the pending re-lock rather than racing it", () => {

    mock.timers.enable({ apis: ["setTimeout"] });

    try {

      const accessory = makeTestAccessory();
      const lock = accessory.addService(Service.LockMechanism, "Access Lock", ProtectReservedNames.LOCK_ACCESS);
      const { camera, dispatch } = makeAccessDispatch(accessory);

      // First unlock schedules a re-lock at ACCESS_UNLOCK_DURATION.
      dispatch.accessEventHandler(camera, "open_door", { openSuccess: true });

      // Advance to just before that first re-lock would fire, then unlock again - which must clear the pending re-lock and schedule a fresh one.
      mock.timers.tick(ACCESS_UNLOCK_DURATION - 1);
      dispatch.accessEventHandler(camera, "open_door", { openSuccess: true });

      // Crossing the first window's original deadline must NOT re-secure: the first timer was cleared, so the lock is still unlocked one tick past where it would
      // have fired.
      mock.timers.tick(1);
      assert.equal(lock.getCharacteristic(Characteristic.LockCurrentState).value, Characteristic.LockCurrentState.UNSECURED,
        "the cancelled re-lock does not fire at the first window's deadline");

      // The fresh timer fires a full window after the second unlock, re-securing exactly once.
      mock.timers.tick(ACCESS_UNLOCK_DURATION);
      assert.equal(lock.getCharacteristic(Characteristic.LockCurrentState).value, Characteristic.LockCurrentState.SECURED,
        "the rescheduled re-lock fires a full window after the second unlock");
    } finally {

      mock.timers.reset();
    }
  });
});

// Build a real ProtectEventDispatch wired to the StatusTampered HAP double, plus a camera stand-in carrying the supplied TestAccessory and a mutable isTampered flag. The
// tamper delivery is the step-5 relocation of the v4 leaf's tamper latch, so these drive the real method against real HAP-double services rather than recording the
// routing. Only the surface tamperEventHandler touches is mocked: the MotionSensor / StatusTampered identities on hap, and the camera's id, isTampered, log, and
// accessory.
const makeTamperDispatch = (accessory: TestAccessory): { camera: ProtectCamera; dispatch: ProtectEventDispatch } => {

  const noop = (): void => { /* swallow log output in tests */ };
  const log = { debug: noop, error: noop, info: noop, warn: noop };
  const hap = { Characteristic: { StatusTampered: Characteristic.StatusTampered }, Service: { MotionSensor: Service.MotionSensor } };
  const nvr = { log, platform: { api: { hap }, config: {} } };
  const dispatch = new ProtectEventDispatch(nvr as unknown as ProtectNvr);
  const camera = { accessory, id: "cam-tamper", isTampered: false, log };

  return { camera: camera as unknown as ProtectCamera, dispatch };
};

describe("camera tamper delivery (real ProtectEventDispatch.tamperEventHandler)", () => {

  test("a tamper occurrence latches the camera tampered and trips StatusTampered on its motion sensor", () => {

    const accessory = makeTestAccessory();
    const motion = accessory.addService(Service.MotionSensor, "Motion");

    motion.getCharacteristic(Characteristic.StatusTampered);

    const { camera, dispatch } = makeTamperDispatch(accessory);

    dispatch.tamperEventHandler(camera);

    assert.equal(camera.isTampered, true, "the camera latches tampered");
    assert.equal(motion.getCharacteristic(Characteristic.StatusTampered).value, true, "the motion sensor's StatusTampered trips on the tamper occurrence");
  });

  test("the tamper latch is one-way: a repeat occurrence does not re-trip once latched", () => {

    const accessory = makeTestAccessory();
    const motion = accessory.addService(Service.MotionSensor, "Motion");
    const { camera, dispatch } = makeTamperDispatch(accessory);

    dispatch.tamperEventHandler(camera);

    // Manually clear the characteristic, then deliver a second occurrence. Because the camera is already latched, the handler returns early and must NOT re-write
    // StatusTampered - so it stays at the value we just cleared it to, proving the latch suppressed the repeat.
    motion.updateCharacteristic(Characteristic.StatusTampered, false);
    dispatch.tamperEventHandler(camera);

    assert.equal(motion.getCharacteristic(Characteristic.StatusTampered).value, false, "the latched camera does not re-trip StatusTampered on a repeat occurrence");
  });

  test("latches the camera even when it has no motion sensor to display the state", () => {

    // A camera without a motion sensor still latches tampered (the flag the availability projection and onGet read); the characteristic write is simply skipped.
    const accessory = makeTestAccessory();
    const { camera, dispatch } = makeTamperDispatch(accessory);

    assert.doesNotThrow(() => dispatch.tamperEventHandler(camera), "a camera without a motion sensor is handled cleanly");
    assert.equal(camera.isTampered, true, "the camera latches tampered regardless of whether a motion sensor exists to display it");
  });
});

// Build a real ProtectEventDispatch wired to the ContactSensor / ContactSensorState HAP double and an mqtt publish spy, plus a camera stand-in carrying the supplied
// TestAccessory. The auth delivery is the step-5 relocation of the v4 doorbell auth handler, so these drive the real method against real HAP-double services rather than
// recording the routing. Only the surface authEventHandler touches is mocked: the ContactSensor / ContactSensorState identities on hap, the camera's accessory / id / log
// / ufp.mac, and an mqtt.publish spy whose calls land in `published`.
const makeAuthDispatch = (accessory: TestAccessory): { camera: ProtectCamera; dispatch: ProtectEventDispatch; published: unknown[][] } => {

  const published: unknown[][] = [];
  const noop = (): void => { /* swallow log output in tests */ };
  const log = { debug: noop, error: noop, info: noop, warn: noop };
  const hap = { Characteristic: { ContactSensorState: Characteristic.ContactSensorState }, Service: { ContactSensor: Service.ContactSensor } };
  const publish = (...args: unknown[]): void => { published.push(args); };
  const nvr = { log, mqtt: { publish }, platform: { api: { hap }, config: {} } };
  const dispatch = new ProtectEventDispatch(nvr as unknown as ProtectNvr);
  const camera = { accessory, id: "cam-auth", log, ufp: { mac: "AA:BB:CC:DD:EE:FF" } };

  return { camera: camera as unknown as ProtectCamera, dispatch, published };
};

describe("doorbell auth delivery (real ProtectEventDispatch.authEventHandler)", () => {

  test("a recognized fingerprint trips the auth contact sensor, then resets it after the window", () => {

    mock.timers.enable({ apis: ["setTimeout"] });

    try {

      const accessory = makeTestAccessory();
      const contact = accessory.addService(Service.ContactSensor, "Authenticated", ProtectReservedNames.CONTACT_AUTHSENSOR);
      const { camera, dispatch } = makeAuthDispatch(accessory);

      dispatch.authEventHandler(camera, "fingerprint", { fingerprint: { ulpId: "ulp-1" } });

      assert.equal(contact.getCharacteristic(Characteristic.ContactSensorState).value, Characteristic.ContactSensorState.CONTACT_NOT_DETECTED,
        "a recognized fingerprint trips the sensor to its authenticated (not-detected) state");

      // Advancing past the auth window fires the timer that returns the sensor to its resting (detected / not-authenticated) state.
      mock.timers.tick(PROTECT_DOORBELL_AUTHSENSOR_DURATION);

      assert.equal(contact.getCharacteristic(Characteristic.ContactSensorState).value, Characteristic.ContactSensorState.CONTACT_DETECTED,
        "the sensor resets to its resting state after the auth window");
    } finally {

      mock.timers.reset();
    }
  });

  test("a recognized NFC card trips the sensor and publishes the card credential to MQTT", () => {

    const accessory = makeTestAccessory();
    const contact = accessory.addService(Service.ContactSensor, "Authenticated", ProtectReservedNames.CONTACT_AUTHSENSOR);
    const { camera, dispatch, published } = makeAuthDispatch(accessory);

    dispatch.authEventHandler(camera, "nfc", { nfc: { nfcId: "card-9", ulpId: "ulp-2" } });

    assert.equal(contact.getCharacteristic(Characteristic.ContactSensorState).value, Characteristic.ContactSensorState.CONTACT_NOT_DETECTED,
      "a recognized card trips the sensor to its authenticated state");
    assert.deepEqual(published, [[ "AA:BB:CC:DD:EE:FF/authenticate", JSON.stringify({ id: "card-9", type: "nfc" }) ]],
      "the NFC credential is published with its card id and method");
  });

  test("a recognized fingerprint publishes the fingerprint method to MQTT with no card id", () => {

    const accessory = makeTestAccessory();

    accessory.addService(Service.ContactSensor, "Authenticated", ProtectReservedNames.CONTACT_AUTHSENSOR);

    const { camera, dispatch, published } = makeAuthDispatch(accessory);

    dispatch.authEventHandler(camera, "fingerprint", { fingerprint: { ulpId: "ulp-1" } });

    assert.deepEqual(published, [[ "AA:BB:CC:DD:EE:FF/authenticate", JSON.stringify({ type: "fingerprint" }) ]],
      "the fingerprint method is published with no card id");
  });

  test("an unrecognized scan leaves the sensor at rest and publishes nothing", () => {

    const accessory = makeTestAccessory();
    const contact = accessory.addService(Service.ContactSensor, "Authenticated", ProtectReservedNames.CONTACT_AUTHSENSOR);
    const { camera, dispatch, published } = makeAuthDispatch(accessory);

    // A scan that matched no identity carries its credential sub-object without a ulpId; the sensor stays detected (not authenticated) and nothing is published.
    dispatch.authEventHandler(camera, "fingerprint", { fingerprint: {} });

    assert.equal(contact.getCharacteristic(Characteristic.ContactSensorState).value, Characteristic.ContactSensorState.CONTACT_DETECTED,
      "an unrecognized scan leaves the sensor in its resting (not-authenticated) state");
    assert.deepEqual(published, [], "an unrecognized scan is an attempt, not an authentication, so it publishes nothing");
  });

  test("publishes the auth MQTT even when the contact sensor is not configured (v4 parity)", () => {

    // The AuthSensor contact service is off by default; the v4 handler published the authenticate event regardless, gating only the characteristic writes. A recognized
    // scan on an accessory with no ContactSensor must still publish - and must not throw - or the default configuration silently loses its auth MQTT.
    const accessory = makeTestAccessory();
    const { camera, dispatch, published } = makeAuthDispatch(accessory);

    assert.doesNotThrow(() => dispatch.authEventHandler(camera, "nfc", { nfc: { nfcId: "card-9", ulpId: "ulp-2" } }),
      "a recognized scan without a contact service is handled cleanly");
    assert.deepEqual(published, [[ "AA:BB:CC:DD:EE:FF/authenticate", JSON.stringify({ id: "card-9", type: "nfc" }) ]],
      "the auth MQTT publishes regardless of whether the contact sensor is configured");
  });

  test("a second scan before the window cancels the pending reset rather than racing it", () => {

    mock.timers.enable({ apis: ["setTimeout"] });

    try {

      const accessory = makeTestAccessory();
      const contact = accessory.addService(Service.ContactSensor, "Authenticated", ProtectReservedNames.CONTACT_AUTHSENSOR);
      const { camera, dispatch } = makeAuthDispatch(accessory);

      // First scan trips the sensor and schedules a reset at PROTECT_DOORBELL_AUTHSENSOR_DURATION.
      dispatch.authEventHandler(camera, "fingerprint", { fingerprint: { ulpId: "ulp-1" } });

      // Advance to just before that reset would fire, then scan again - which must clear the pending reset and schedule a fresh one.
      mock.timers.tick(PROTECT_DOORBELL_AUTHSENSOR_DURATION - 1);
      dispatch.authEventHandler(camera, "fingerprint", { fingerprint: { ulpId: "ulp-1" } });

      // Crossing the first window's original deadline must NOT reset: the first timer was cleared, so the sensor is still authenticated one tick past where it would
      // have fired.
      mock.timers.tick(1);
      assert.equal(contact.getCharacteristic(Characteristic.ContactSensorState).value, Characteristic.ContactSensorState.CONTACT_NOT_DETECTED,
        "the cancelled reset does not fire at the first window's deadline");

      // The fresh timer fires a full window after the second scan, resetting exactly once.
      mock.timers.tick(PROTECT_DOORBELL_AUTHSENSOR_DURATION);
      assert.equal(contact.getCharacteristic(Characteristic.ContactSensorState).value, Characteristic.ContactSensorState.CONTACT_DETECTED,
        "the rescheduled reset fires a full window after the second scan");
    } finally {

      mock.timers.reset();
    }
  });
});
