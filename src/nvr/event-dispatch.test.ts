/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * event-dispatch.test.ts: Unit tests for the typed event-firehose router and the controller telemetry publisher.
 *
 * The router and telemetry loops are exercised against the real production ProtectEventDispatch, constructed with the minimal mocks its constructor and the loops
 * actually read - a controlled client.events() / client.rawPackets() async stream, a getDeviceById over a fixed device map, an mqtt publish spy, and the feature-option
 * gate. The delivery methods are the dispatch decision's observable effect, so a thin recording subclass overrides them to capture exactly what the router routed; the
 * real run() applies the smart-detect gate before invoking them, so routing is verified against the production class. Bare camera motion is not a firehose arm -
 * the controller signals it as a lastMotion device-state advance, which the camera leaf observes directly, so its delivery policy (shouldDeliverBareMotion) and its
 * observe-driven routing live with the camera leaf and its tests, not here. The casts are confined to the mock seam, matching the posture the reachability and nvr suites
 * already established; the instance under test is the production class.
 */
import type { AuthMethod, ProtectEventMetadata, TypedEvent } from "unifi-protect";
import { Characteristic, Service, makeTestAccessory } from "../testing.helpers.ts";
import { describe, mock, test } from "node:test";
import { PROTECT_DOORBELL_AUTHSENSOR_DURATION } from "../settings.ts";
import type { ProtectCamera } from "../devices/cameras/camera.ts";
import type { ProtectDevice } from "../devices/device.ts";
import { ProtectEventDispatch } from "./event-dispatch.ts";
import type { ProtectNvr } from "./nvr.ts";
import { ProtectReservedNames } from "../types.ts";
import type { TestAccessory } from "../testing.helpers.ts";
import assert from "node:assert/strict";
import diagnosticsChannel from "node:diagnostics_channel";
import { format } from "node:util";

// A finite async stream over a fixed item list. The router and telemetry loops consume client.events() / client.rawPackets() with `for await`, so a terminating
// generator lets each loop complete on its own without the test needing to drive the abort signal.
async function *streamOf<T>(items: readonly T[]): AsyncGenerator<T> {

  for(const item of items) {

    yield item;
  }
}

// One captured delivery invocation. The router's observable effect is which delivery method it called, on which device, and with which arguments (the motion objects and
// metadata, the access action, the auth method); this is the shape the recording subclass records so the assertions can pin routing and argument threading in one place.
interface DeliveryCall {

  action?: string;
  button?: string;
  id: string;
  kind: "access" | "auth" | "button" | "doorbell" | "motion" | "tamper";
  metadata?: unknown;
  method?: AuthMethod;
  objects?: string[];
  pressType?: string;
}

// A real ProtectEventDispatch whose delivery methods are overridden to record rather than touch HomeKit. run() still resolves the target device and gates smart
// detections exactly as in production - only the terminal delivery is captured - so these tests pin the routing, not the HAP-real characteristic writes (those stay
// live-validated).
class RecordingDispatch extends ProtectEventDispatch {

  public readonly calls: DeliveryCall[] = [];

  public override motionEventHandler(protectDevice: ProtectDevice, detectedObjects: string[] = [], metadata?: ProtectEventMetadata): void {

    this.calls.push({ id: protectDevice.protectId, kind: "motion", metadata, objects: detectedObjects });
  }

  public override doorbellEventHandler(protectDevice: ProtectCamera): void {

    this.calls.push({ id: protectDevice.protectId, kind: "doorbell" });
  }

  public override accessEventHandler(protectDevice: ProtectCamera, action: string): void {

    this.calls.push({ action, id: protectDevice.protectId, kind: "access" });
  }

  public override tamperEventHandler(protectDevice: ProtectCamera): void {

    this.calls.push({ id: protectDevice.protectId, kind: "tamper" });
  }

  public override authEventHandler(protectDevice: ProtectCamera, method: AuthMethod, metadata?: ProtectEventMetadata): void {

    this.calls.push({ id: protectDevice.protectId, kind: "auth", metadata, method });
  }

  public override buttonEventHandler(protectDevice: ProtectDevice, button: string, pressType: string): void {

    this.calls.push({ button, id: protectDevice.protectId, kind: "button", pressType });
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
const makeCamera = (id: string, options: { hksvRecording?: boolean; recordPresent?: boolean; smartCapable?: boolean; smartDetectEnabled?: boolean } = {}): unknown => {

  const { hksvRecording = true, recordPresent = true, smartCapable = true, smartDetectEnabled = true } = options;

  // The delivery handlers read the top-level protectId and cameraFor reads modelKey and recordPresent (the non-throwing identity / presence accessors), so the mock
  // exposes them all alongside the projection. protectId mirrors the projection's id, exactly as the production device's protectId reads through to its config id.
  return {

    hints: { smartDetect: smartDetectEnabled },
    modelKey: "camera",
    protectId: id,
    recordPresent,
    stream: hksvRecording ? { hksv: { isRecording: true } } : undefined,
    ufp: { featureFlags: { smartDetectAudioTypes: [], smartDetectTypes: smartCapable ? ["person"] : [] }, id, modelKey: "camera" }
  };
};

// Build a mock fob-like device carrying a fob model key plus the fields the button router reads: identity (protectId) and presence (recordPresent). The
// buttonPressed case addresses by id and gates on recordPresent WITHOUT a modelKey narrow (unlike cameraFor), so the delivery is family-agnostic - a fob, or any
// button-bearing device, rides this path.
const makeFob = (id: string, options: { recordPresent?: boolean } = {}): unknown => {

  const { recordPresent = true } = options;

  return { modelKey: "fob", protectId: id, recordPresent };
};

// Build a real ProtectEventDispatch (via the recording subclass) over a mock NVR exposing only what the constructor and the loops read. The published array captures
// every mqtt.publish call so the telemetry assertions can read the tuples back; under the homebridge-plugin-utils signature each tuple is [composed {id}/{topic} tail,
// payload]. The streams are finite, so run() / publishTelemetry() complete on their own without needing the signal to abort.
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

describe("firehose router dispatch (real ProtectEventDispatch.run)", () => {

  test("routes a doorbell ring to the doorbell delivery on the addressed camera", async () => {

    const devices = new Map<string, unknown>([[ "cam1", makeCamera("cam1") ]]);
    const events: TypedEvent[] = [{ at: 1234, cameraId: "cam1", eventId: "e1", kind: "doorbellRing" }];
    const { dispatch } = makeDispatch({ devices, events });

    await dispatch.run(liveSignal());

    assert.deepEqual(dispatch.calls, [{ id: "cam1", kind: "doorbell" }]);
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
    // router strips them before delivery. The genuine "person" thumbnail survives and reaches the delivery; the source object is left untouched, since the firehose
    // event is read-only consumer data the unifi-protect library owns.
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
    // exact suppression that keeps "Create motion events" from spuriously tripping the smart-detection sensors. Filtering happens before the has-anything gate, so the
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

  test("routes an access door_bell occurrence to the access delivery, threading the action", async () => {

    const devices = new Map<string, unknown>([[ "cam1", makeCamera("cam1") ]]);
    const events: TypedEvent[] = [{ action: "door_bell", at: 1, deviceId: "cam1", eventId: "e1", kind: "accessEvent" }];
    const { dispatch } = makeDispatch({ devices, events });

    await dispatch.run(liveSignal());

    assert.deepEqual(dispatch.calls, [{ action: "door_bell", id: "cam1", kind: "access" }]);
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

      { at: 1, cameraId: "missing", eventId: "e1", kind: "smartDetect", objectTypes: ["person"] },
      { at: 2, cameraId: "missing", eventId: "e2", kind: "tamperDetected" },
      { at: 3, cameraId: "missing", eventId: "e3", kind: "authDetected", metadata: { nfc: { nfcId: "card-9", ulpId: "ulp-1" } }, method: "nfc" },
      { at: 4, cameraId: "missing", eventId: "e4", kind: "doorbellRing" },
      { action: "door_bell", at: 5, deviceId: "missing", eventId: "e5", kind: "accessEvent" }
    ];
    const { dispatch } = makeDispatch({ devices: new Map<string, unknown>(), events });

    await dispatch.run(liveSignal());

    assert.deepEqual(dispatch.calls, [], "an event addressing an unconfigured id routes nowhere, whatever its kind");
  });

  test("is a no-op when the addressed device is not a camera, for every activity kind", async () => {

    // A non-camera projection (e.g. a sensor) shares the id space but is never an activity target; cameraFor narrows it out for every kind. The mock is recordPresent so
    // the no-delivery assertion exercises the modelKey gate rather than the presence gate.
    const devices = new Map<string, unknown>([[ "sensor1", { modelKey: "sensor", recordPresent: true, ufp: { id: "sensor1", modelKey: "sensor" } } ]]);
    const events: TypedEvent[] = [

      { at: 1, cameraId: "sensor1", eventId: "e1", kind: "smartDetect", objectTypes: ["person"] },
      { at: 2, cameraId: "sensor1", eventId: "e2", kind: "tamperDetected" },
      { at: 3, cameraId: "sensor1", eventId: "e3", kind: "authDetected", metadata: { nfc: { nfcId: "card-9", ulpId: "ulp-1" } }, method: "nfc" },
      { at: 4, cameraId: "sensor1", eventId: "e4", kind: "doorbellRing" },
      { action: "door_bell", at: 5, deviceId: "sensor1", eventId: "e5", kind: "accessEvent" }
    ];
    const { dispatch } = makeDispatch({ devices, events });

    await dispatch.run(liveSignal());

    assert.deepEqual(dispatch.calls, [], "a non-camera match is not routed an activity event of any kind");
  });

  test("is a no-op when the addressed camera's controller record has vanished, for every activity kind", async () => {

    // A camera lingering in the removal grace (recordPresent false) is on its way out; cameraFor narrows it out for every kind, even though it is a camera by modelKey.
    const devices = new Map<string, unknown>([[ "cam1", makeCamera("cam1", { recordPresent: false }) ]]);
    const events: TypedEvent[] = [

      { at: 1, cameraId: "cam1", eventId: "e1", kind: "smartDetect", objectTypes: ["person"] },
      { at: 2, cameraId: "cam1", eventId: "e2", kind: "tamperDetected" },
      { at: 3, cameraId: "cam1", eventId: "e3", kind: "authDetected", metadata: { nfc: { nfcId: "card-9", ulpId: "ulp-1" } }, method: "nfc" },
      { at: 4, cameraId: "cam1", eventId: "e4", kind: "doorbellRing" },
      { action: "door_bell", at: 5, deviceId: "cam1", eventId: "e5", kind: "accessEvent" }
    ];
    const { dispatch } = makeDispatch({ devices, events });

    await dispatch.run(liveSignal());

    assert.deepEqual(dispatch.calls, [], "a camera whose controller record has vanished is not routed an activity event of any kind");
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

  test("routes a fob button press to the button delivery on the addressed device, threading the button and press type", async () => {

    const devices = new Map<string, unknown>([[ "fob1", makeFob("fob1") ]]);
    const events: TypedEvent[] = [{ at: 1, button: "panic", deviceId: "fob1", eventId: "e1", kind: "buttonPressed", pressType: "press" }];
    const { dispatch } = makeDispatch({ devices, events });

    await dispatch.run(liveSignal());

    assert.deepEqual(dispatch.calls, [{ button: "panic", id: "fob1", kind: "button", pressType: "press" }],
      "the press is routed to the addressed device's button delivery with the button and press type threaded");
  });

  test("is a no-op for a button press addressing an unconfigured device id", async () => {

    const events: TypedEvent[] = [{ at: 1, button: "panic", deviceId: "missing", eventId: "e1", kind: "buttonPressed", pressType: "press" }];
    const { dispatch } = makeDispatch({ devices: new Map<string, unknown>(), events });

    await dispatch.run(liveSignal());

    assert.deepEqual(dispatch.calls, [], "a button press addressing an unconfigured id routes nowhere");
  });

  test("is a no-op for a button press whose device record has vanished", async () => {

    // A device lingering in the removal grace (recordPresent false) is on its way out; the button router gates it out just as the camera-addressed deliveries do.
    const devices = new Map<string, unknown>([[ "fob1", makeFob("fob1", { recordPresent: false }) ]]);
    const events: TypedEvent[] = [{ at: 1, button: "panic", deviceId: "fob1", eventId: "e1", kind: "buttonPressed", pressType: "press" }];
    const { dispatch } = makeDispatch({ devices, events });

    await dispatch.run(liveSignal());

    assert.deepEqual(dispatch.calls, [], "a device whose controller record has vanished is not routed a button press");
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
        { action: "door_bell", at: 5, deviceId: "cam1", eventId: "e5", kind: "accessEvent" },
        { at: 6, button: "panic", deviceId: "cam1", eventId: "e6", kind: "buttonPressed", pressType: "press" }
      ];
      const { dispatch } = makeDispatch({ devices, events });

      await dispatch.run(liveSignal());

      assert.deepEqual(received, [

        { cameraId: "cam1", kind: "doorbellRing" },
        { cameraId: "cam1", kind: "smartDetect" },
        { cameraId: "cam1", kind: "tamperDetected" },
        { cameraId: "cam1", kind: "authDetected" },
        { cameraId: "cam1", kind: "accessEvent" },
        { cameraId: "cam1", kind: "buttonPressed" }
      ], "each delivered event publishes one milestone carrying its kind and the addressed device id");
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

// A real ProtectEventDispatch whose only override is doorbellEventHandler, recording the device id it was handed rather than running the ring delivery. The door_bell
// routing test pins that accessEventHandler delegates a UniFi Access intercom press to the doorbell ring delivery without re-running that delivery's body (no Doorbell
// service, no trigger switch, no MQTT timer), exactly the "pin routing, not HAP writes" posture the recording subclass above takes for the router.
class DoorbellRoutingDispatch extends ProtectEventDispatch {

  public readonly rings: string[] = [];

  public override doorbellEventHandler(protectDevice: ProtectCamera): void {

    this.rings.push(protectDevice.id);
  }
}

describe("access door_bell delivery (real ProtectEventDispatch.accessEventHandler)", () => {

  test("routes a UniFi Access door_bell occurrence to the doorbell ring delivery, and ignores a non-door_bell action", () => {

    // The real accessEventHandler reads nothing off the camera before delegating, and the spy reads only its id, so a bare nvr stub and a minimal camera stand-in are
    // all the routing needs.
    const noop = (): void => { /* swallow log output in tests */ };
    const log = { debug: noop, error: noop, info: noop, warn: noop };
    const nvr = { log, platform: { api: { hap: {} }, config: {} } };
    const dispatch = new DoorbellRoutingDispatch(nvr as unknown as ProtectNvr);
    const camera = { id: "cam-access" } as unknown as ProtectCamera;

    // A door_bell action is a doorbell ring: the handler delegates to doorbellEventHandler, which the spy records by id.
    dispatch.accessEventHandler(camera, "door_bell");

    assert.deepEqual(dispatch.rings, ["cam-access"], "a UniFi Access door_bell press is routed to the doorbell ring delivery");

    // A non-door_bell Access action does not ring: on the same dispatch, a later nfc_read leaves the recorded rings unchanged.
    dispatch.accessEventHandler(camera, "nfc_read");

    assert.deepEqual(dispatch.rings, ["cam-access"], "a non-door_bell Access action does not ring");
  });
});

// Build a real ProtectEventDispatch wired to the StatusTampered HAP double, plus a camera stand-in carrying the supplied TestAccessory and a mutable isTampered flag. The
// tamper delivery latches the camera tampered, so these drive the real method against real HAP-double services rather than recording the routing. Only the surface
// tamperEventHandler touches is mocked: the MotionSensor / StatusTampered identities on hap, and the camera's id, isTampered, log, and accessory.
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
// TestAccessory. The auth delivery trips the doorbell's authentication contact sensor, so these drive the real method against real HAP-double services rather than
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
  const camera = { accessory, id: "cam-auth", log, mac: "AA:BB:CC:DD:EE:FF", ufp: { mac: "AA:BB:CC:DD:EE:FF" } };

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

  test("publishes the auth MQTT even when the contact sensor is not configured", () => {

    // The AuthSensor contact service is off by default; the auth delivery publishes the authenticate event regardless, gating only the characteristic writes. A
    // recognized scan on an accessory with no ContactSensor must still publish - and must not throw - or the default configuration silently loses its auth MQTT.
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

// Build a real ProtectEventDispatch wired to the HAP doubles motionEventDelivery touches, plus a camera stand-in carrying the supplied TestAccessory and the motion
// hints the delivery reads. The info log is captured (formatted through util.format, as the real Homebridge logger renders its printf-style calls) so the assertions
// can pin the coalescing of simultaneous types and the strictly-grows enrichment dedup; mqtt.publish calls land in `published`. Smart detection and motion logging are
// enabled by default so a test names only the axis it varies. Every delivery arms a motionDuration reset timer, so the suite runs under mock timers.
const makeMotionDispatch = (accessory: TestAccessory, hints: Record<string, unknown> = {}): { camera: ProtectCamera; dispatch: ProtectEventDispatch;
  logged: string[]; published: unknown[][]; } => {

  const logged: string[] = [];
  const published: unknown[][] = [];
  const noop = (): void => { /* swallow non-info log output in tests */ };
  const log = { debug: noop, error: noop, info: (message: string, ...parameters: unknown[]): void => { logged.push(format(message, ...parameters)); }, warn: noop };
  const hap = {

    Characteristic: { ContactSensorState: Characteristic.ContactSensorState, MotionDetected: Characteristic.MotionDetected,
      OccupancyDetected: Characteristic.OccupancyDetected, On: Characteristic.On },
    Service: { ContactSensor: Service.ContactSensor, MotionSensor: Service.MotionSensor, OccupancySensor: Service.OccupancySensor, Switch: Service.Switch }
  };
  const publish = (...args: unknown[]): void => { published.push(args); };
  const nvr = { log, mqtt: { publish }, platform: { api: { hap }, config: {} } };
  const dispatch = new ProtectEventDispatch(nvr as unknown as ProtectNvr);
  const camera = {

    accessory,
    hints: { logMotion: true, motionDuration: 10, occupancyDuration: 10, smartDetect: true, smartOccupancy: [], ...hints },
    id: "cam-motion",
    log,
    mac: "AA:BB:CC:DD:EE:FF",
    ufp: { mac: "AA:BB:CC:DD:EE:FF" }
  };

  return { camera: camera as unknown as ProtectCamera, dispatch, logged, published };
};

// Run a test body under mock setTimeout so each delivery's motionDuration reset timer is controllable and never lingers on the real loop after the test.
const withMockTimers = (body: () => void): void => {

  mock.timers.enable({ apis: ["setTimeout"] });

  try {

    body();
  } finally {

    mock.timers.reset();
  }
};

describe("smart-detection delivery (real ProtectEventDispatch.motionEventHandler)", () => {

  test("coalesces simultaneous plain object types onto a single log line", () => withMockTimers(() => {

    const accessory = makeTestAccessory();

    accessory.addService(Service.MotionSensor, "Motion");

    const { camera, dispatch, logged } = makeMotionDispatch(accessory);

    dispatch.motionEventHandler(camera, [ "animal", "face", "person" ]);

    assert.deepEqual(logged, [ "Motion detected.", "Smart motion detected: animal, face, person." ],
      "the three simultaneous detections coalesce onto one line rather than three");
  }));

  test("logs a vehicle bare first, then re-logs it once as its metadata fills in", () => withMockTimers(() => {

    const accessory = makeTestAccessory();

    accessory.addService(Service.MotionSensor, "Motion");

    const { camera, dispatch, logged } = makeMotionDispatch(accessory);

    // First delivery: the controller has only identified a vehicle, no plate/color/type yet, so it logs as a bare detection.
    dispatch.motionEventHandler(camera, ["vehicle"]);

    // Second delivery within the window: color and body type have arrived, so the detection re-logs once with the enriched attributes.
    dispatch.motionEventHandler(camera, [], { detectedThumbnails: [{ attributes: { color: { confidence: 68, val: "black" },
      vehicleType: { confidence: 96, val: "suv" } }, type: "vehicle" }] });

    assert.deepEqual(logged, [

      "Motion detected.",
      "Smart motion detected: vehicle.",
      "Smart motion detected: vehicle (color: black [68% confidence], vehicleType: suv [96% confidence])."
    ], "the bare vehicle line is followed by exactly one enriched line");
  }));

  test("does not re-log a vehicle whose metadata has not grown", () => withMockTimers(() => {

    const accessory = makeTestAccessory();

    accessory.addService(Service.MotionSensor, "Motion");

    const { camera, dispatch, logged } = makeMotionDispatch(accessory);
    const thumbnail = { detectedThumbnails: [{ attributes: { color: { confidence: 68, val: "black" } }, type: "vehicle" }] };

    dispatch.motionEventHandler(camera, [], thumbnail);
    dispatch.motionEventHandler(camera, [], thumbnail);
    dispatch.motionEventHandler(camera, [], thumbnail);

    assert.deepEqual(logged.filter(line => line.startsWith("Smart motion detected")), ["Smart motion detected: vehicle (color: black [68% confidence])."],
      "the identical retriggers re-arm the timer but do not re-log the enriched line");
  }));

  test("does not re-log a plain detection that retriggers within the motion window", () => withMockTimers(() => {

    const accessory = makeTestAccessory();

    accessory.addService(Service.MotionSensor, "Motion");

    const { camera, dispatch, logged } = makeMotionDispatch(accessory);

    dispatch.motionEventHandler(camera, ["person"]);
    dispatch.motionEventHandler(camera, ["person"]);

    assert.deepEqual(logged.filter(line => line.startsWith("Smart motion detected")), ["Smart motion detected: person."],
      "the second person detection within the window re-arms the timer but does not re-log");
  }));

  test("trips the configured license-plate contact sensor and renders the plate into the log line", () => withMockTimers(() => {

    const accessory = makeTestAccessory();

    accessory.addService(Service.MotionSensor, "Motion");

    const plateSensor = accessory.addService(Service.ContactSensor, "Plate ABC123", ProtectReservedNames.CONTACT_MOTION_SMARTDETECT_LICENSE + ".ABC123");
    const { camera, dispatch, logged } = makeMotionDispatch(accessory);

    dispatch.motionEventHandler(camera, [], { detectedThumbnails: [{ confidence: 98, name: "ABC123", type: "vehicle" }] });

    assert.equal(plateSensor.getCharacteristic(Characteristic.ContactSensorState).value, Characteristic.ContactSensorState.CONTACT_NOT_DETECTED,
      "the matching plate contact sensor trips on the detection");
    assert.deepEqual(logged.filter(line => line.startsWith("Smart motion detected")),
      ["Smart motion detected: vehicle (license plate: ABC123 [98% confidence])."], "the plate is rendered into the enriched log line");
  }));

  test("suppresses all smart-detection logging when motion logging is disabled, but still trips the motion sensor", () => withMockTimers(() => {

    const accessory = makeTestAccessory();
    const motion = accessory.addService(Service.MotionSensor, "Motion");
    const { camera, dispatch, logged } = makeMotionDispatch(accessory, { logMotion: false });

    dispatch.motionEventHandler(camera, [ "animal", "face", "person" ]);

    assert.deepEqual(logged, [], "no lines are logged when motion logging is disabled");
    assert.equal(motion.getCharacteristic(Characteristic.MotionDetected).value, true, "the motion sensor still trips regardless of the logging hint");
  }));

  test("re-logs the enriched line in a fresh motion window after the reset timer fires", () => withMockTimers(() => {

    const accessory = makeTestAccessory();

    accessory.addService(Service.MotionSensor, "Motion");

    const { camera, dispatch, logged } = makeMotionDispatch(accessory, { motionDuration: 10 });
    const thumbnail = { detectedThumbnails: [{ attributes: { color: { confidence: 68, val: "black" } }, type: "vehicle" }] };

    dispatch.motionEventHandler(camera, [], thumbnail);

    // Advance past the motion window so the reset timer clears the per-type tracker, then deliver the same detection again - which must log afresh.
    mock.timers.tick(10 * 1000);
    dispatch.motionEventHandler(camera, [], thumbnail);

    assert.deepEqual(logged.filter(line => line.startsWith("Smart motion detected")),
      [ "Smart motion detected: vehicle (color: black [68% confidence]).", "Smart motion detected: vehicle (color: black [68% confidence])." ],
      "the detection re-logs once per motion window");
  }));

  test("logs a vehicle once when it arrives bare and enriched in the same delivery", () => withMockTimers(() => {

    const accessory = makeTestAccessory();

    accessory.addService(Service.MotionSensor, "Motion");

    const { camera, dispatch, logged } = makeMotionDispatch(accessory);

    // The smartDetect firehose event carries the object type in objectTypes AND its enriched detail in detectedThumbnails within one payload, so the same type is
    // processed both bare and enriched in a single delivery; it must produce exactly one (enriched) line, never an additional bare coalesced line.
    dispatch.motionEventHandler(camera, ["vehicle"], { detectedThumbnails: [{ attributes: { color: { confidence: 68, val: "black" },
      vehicleType: { confidence: 96, val: "suv" } }, type: "vehicle" }] });

    assert.deepEqual(logged.filter(line => line.startsWith("Smart motion detected")),
      ["Smart motion detected: vehicle (color: black [68% confidence], vehicleType: suv [96% confidence])."],
      "the vehicle logs once enriched, never also as a bare coalesced line");
  }));

  test("in one delivery coalesces plain types and logs a rich type on its own enriched line", () => withMockTimers(() => {

    const accessory = makeTestAccessory();

    accessory.addService(Service.MotionSensor, "Motion");

    const { camera, dispatch, logged } = makeMotionDispatch(accessory);

    dispatch.motionEventHandler(camera, [ "person", "vehicle" ], { detectedThumbnails: [{ attributes: { color: { confidence: 68, val: "black" },
      vehicleType: { confidence: 96, val: "suv" } }, type: "vehicle" }] });

    assert.deepEqual(logged.filter(line => line.startsWith("Smart motion detected")), [

      "Smart motion detected: vehicle (color: black [68% confidence], vehicleType: suv [96% confidence]).",
      "Smart motion detected: person."
    ], "the plain person coalesces on its own line and the enriched vehicle is not also listed there");
  }));

  test("publishes the per-type MQTT state once and the metadata topic only as it grows", () => withMockTimers(() => {

    const accessory = makeTestAccessory();

    accessory.addService(Service.MotionSensor, "Motion");

    const { camera, dispatch, published } = makeMotionDispatch(accessory);
    const thumbnail = { detectedThumbnails: [{ attributes: { color: { confidence: 68, val: "black" } }, type: "vehicle" }] };

    dispatch.motionEventHandler(camera, [], thumbnail);
    dispatch.motionEventHandler(camera, [], thumbnail);

    const topics = published.map(entry => String(entry[0]));

    assert.equal(topics.filter(topic => topic.endsWith("/motion/smart/vehicle")).length, 1, "the per-type state publishes once on first detection");

    const metadata = published.filter(entry => String(entry[0]).endsWith("/motion/smart/vehicle/metadata"));

    assert.equal(metadata.length, 1, "the metadata publishes once and not again on an identical retrigger");
    assert.deepEqual(JSON.parse(String(metadata[0]?.[1])), { color: { confidence: 68, val: "black" }, type: "vehicle" },
      "the metadata payload matches the enricher output");
  }));

  test("with motion logging off, publishes MQTT state and metadata but logs nothing", () => withMockTimers(() => {

    const accessory = makeTestAccessory();

    accessory.addService(Service.MotionSensor, "Motion");

    const { camera, dispatch, logged, published } = makeMotionDispatch(accessory, { logMotion: false });

    dispatch.motionEventHandler(camera, [], { detectedThumbnails: [{ attributes: { color: { confidence: 68, val: "black" } }, type: "vehicle" }] });

    const topics = published.map(entry => String(entry[0]));

    // MQTT is gated only on MQTT being configured: both the per-type state and the rich metadata publish regardless of the console-logging hint (deduped, not
    // suppressed).
    assert.ok(topics.some(topic => topic.endsWith("/motion/smart/vehicle")), "the per-type state publishes on MQTT regardless of the logging hint");
    assert.ok(topics.some(topic => topic.endsWith("/motion/smart/vehicle/metadata")), "the metadata publishes on MQTT regardless of the logging hint");
    assert.deepEqual(logged, [], "but nothing is logged when motion logging is disabled");
  }));

  test("clearing a device's timers also clears its smart-detect log high-water marks", () => withMockTimers(() => {

    const accessory = makeTestAccessory();

    accessory.addService(Service.MotionSensor, "Motion");

    const { camera, dispatch, logged } = makeMotionDispatch(accessory);
    const thumbnail = { detectedThumbnails: [{ attributes: { color: { confidence: 68, val: "black" } }, type: "vehicle" }] };

    dispatch.motionEventHandler(camera, [], thumbnail);

    // clearEventTimersForDevice clears the reset timers WITHOUT firing them, so the high-water marks must be swept explicitly or the next detection would be suppressed.
    dispatch.clearEventTimersForDevice("cam-motion");
    dispatch.motionEventHandler(camera, [], thumbnail);

    assert.deepEqual(logged.filter(line => line.startsWith("Smart motion detected")),
      [ "Smart motion detected: vehicle (color: black [68% confidence]).", "Smart motion detected: vehicle (color: black [68% confidence])." ],
      "after the device's timers are cleared, the next detection logs afresh rather than being suppressed by a stale high-water mark");
  }));
});
