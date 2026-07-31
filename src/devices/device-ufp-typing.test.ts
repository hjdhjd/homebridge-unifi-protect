/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * device-ufp-typing.test.ts: The type-identity guard for the device spine's generic projection parameter and the config view it derives.
 *
 * ProtectDevice carries its concrete projection type as a generic parameter, and its ufp getter derives the identity-dropped live-state view from that parameter rather
 * than from a type each family spells out for itself. The getter body and fromRecord each need one cast to express that derivation, because TypeScript cannot reduce a
 * mapped type applied to an unresolved parameter constrained to a union. Those casts assert nothing a human wrote - the declared types are machine-derived - but they do
 * suppress the compiler's own check at exactly the point where a future edit could let a real type shift pass unnoticed.
 *
 * This suite is what makes such a shift impossible to miss. Every assertion below is type-level, so the gate that enforces them is the standalone typecheck pass
 * (tsconfig.json includes the colocated tests; the build project excludes them, so the build alone cannot see a failure here). Each pin uses the strict type-identity
 * relation - two types are identical when their two conditional-type signatures are mutually assignable - plus the weaker mutual-assignability relation alongside it, so
 * a break reports whether identity was lost or assignability was lost with it.
 *
 * What is pinned: each family's derived ufp type is exactly the identity-dropped view of that family's own config, and the bare parameterless form is exactly that view
 * over the whole category union. Between them the two casts cannot widen, narrow, or re-shape anything without a red gate.
 *
 * The one runtime test carries a fact the type pins cannot state: the identity narrowing is compile-time only. A live record still carries its id, mac, and modelKey at
 * runtime, so the whole force of dropping them from the view is the type - no code may read runtime absence as the guard.
 */
import type { ProtectAccessory, WithoutIdentity } from "../types.ts";
import type { ProtectCameraConfig, ProtectChimeConfig, ProtectDeviceConfig, ProtectFobConfig, ProtectLightConfig, ProtectRelayConfig, ProtectSensorConfig,
  ProtectViewerConfig, Sensor } from "unifi-protect";
import { TestBaseDevice, TestSensorProjection, makeSensorConfig } from "./testing.helpers.ts";
import { TestStateStore, makeProtectState, makeTestAccessory } from "../testing.helpers.ts";
import { after, describe, test } from "node:test";
import type { ProtectCamera } from "./cameras/camera.ts";
import type { ProtectChime } from "./chime.ts";
import type { ProtectDevice } from "./device.ts";
import type { ProtectFob } from "./fob.ts";
import type { ProtectLight } from "./light.ts";
import type { ProtectNvr } from "../nvr/nvr.ts";
import type { ProtectRelay } from "./relay.ts";
import type { ProtectSensor } from "./sensor.ts";
import type { ProtectViewer } from "./viewer.ts";
import assert from "node:assert/strict";
import { makeTestNvr } from "../nvr/testing.helpers.ts";

// Strict type identity. Two types are identical exactly when these two conditional-type signatures are mutually assignable - the relation TypeScript itself uses when it
// compares deferred conditional types, and the only relation strong enough to catch a shift that mere assignability would let through. Each inner signature deliberately
// uses its type parameter exactly once: that single occurrence IS the mechanism, because it leaves the checked type as the only thing the comparison can differ on. A
// formulation that used the parameter twice would measure something weaker, so the unnecessary-type-parameter rule is reporting the construction rather than a defect.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
type Equals<X, Y> = (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2) ? true : false;

// Mutual assignability: the weaker relation, reported alongside identity so a break says which of the two was lost.
type MutuallyAssignable<X, Y> = [X] extends [Y] ? ([Y] extends [X] ? true : false) : false;

// Each pin is written as a type that only resolves when its property holds, so a violated pin is a compile error at the pin itself rather than a value to eyeball.
type Pin<T extends true> = T;

/* The per-family pins. Each family's ufp type, derived from the projection parameter on its class header, must be exactly Readonly<WithoutIdentity<its own config>> - the
 * identity-dropped view of the config that family's projection wraps, and nothing wider. This is the assertion the ufp cast would otherwise be free to violate.
 */
export type CameraUfpIsExact = Pin<Equals<ProtectCamera["ufp"], Readonly<WithoutIdentity<ProtectCameraConfig>>>>;
export type CameraUfpIsMutuallyAssignable = Pin<MutuallyAssignable<ProtectCamera["ufp"], Readonly<WithoutIdentity<ProtectCameraConfig>>>>;
export type ChimeUfpIsExact = Pin<Equals<ProtectChime["ufp"], Readonly<WithoutIdentity<ProtectChimeConfig>>>>;
export type ChimeUfpIsMutuallyAssignable = Pin<MutuallyAssignable<ProtectChime["ufp"], Readonly<WithoutIdentity<ProtectChimeConfig>>>>;
export type FobUfpIsExact = Pin<Equals<ProtectFob["ufp"], Readonly<WithoutIdentity<ProtectFobConfig>>>>;
export type FobUfpIsMutuallyAssignable = Pin<MutuallyAssignable<ProtectFob["ufp"], Readonly<WithoutIdentity<ProtectFobConfig>>>>;
export type LightUfpIsExact = Pin<Equals<ProtectLight["ufp"], Readonly<WithoutIdentity<ProtectLightConfig>>>>;
export type LightUfpIsMutuallyAssignable = Pin<MutuallyAssignable<ProtectLight["ufp"], Readonly<WithoutIdentity<ProtectLightConfig>>>>;
export type RelayUfpIsExact = Pin<Equals<ProtectRelay["ufp"], Readonly<WithoutIdentity<ProtectRelayConfig>>>>;
export type RelayUfpIsMutuallyAssignable = Pin<MutuallyAssignable<ProtectRelay["ufp"], Readonly<WithoutIdentity<ProtectRelayConfig>>>>;
export type SensorUfpIsExact = Pin<Equals<ProtectSensor["ufp"], Readonly<WithoutIdentity<ProtectSensorConfig>>>>;
export type SensorUfpIsMutuallyAssignable = Pin<MutuallyAssignable<ProtectSensor["ufp"], Readonly<WithoutIdentity<ProtectSensorConfig>>>>;
export type ViewerUfpIsExact = Pin<Equals<ProtectViewer["ufp"], Readonly<WithoutIdentity<ProtectViewerConfig>>>>;
export type ViewerUfpIsMutuallyAssignable = Pin<MutuallyAssignable<ProtectViewer["ufp"], Readonly<WithoutIdentity<ProtectViewerConfig>>>>;

/* The bare-form pins. A parameterless ProtectDevice reference - the NVR's device iterator, the event dispatcher's base-typed receivers, a test stand-in that extends the
 * spine directly - resolves the parameter to its default, the full category union. That form must stay the identity-dropped view over that whole union, neither collapsed
 * to the members' common keys nor widened past them.
 */
export type BareUfpIsExact = Pin<Equals<ProtectDevice["ufp"], Readonly<WithoutIdentity<ProtectDeviceConfig>>>>;
export type BareUfpIsMutuallyAssignable = Pin<MutuallyAssignable<ProtectDevice["ufp"], Readonly<WithoutIdentity<ProtectDeviceConfig>>>>;

// The union must survive as a union rather than reduce: a field only one family carries stays reachable on the bare form through its own member.
export type BareUfpKeepsCameraMember = Pin<Extract<ProtectDevice["ufp"], { videoCodec: unknown }> extends never ? false : true>;
export type BareUfpKeepsSensorMember = Pin<Extract<ProtectDevice["ufp"], { mountType: unknown }> extends never ? false : true>;

// The category tag narrows to a family's own literal where the parameter is concrete, and stays the full union on the bare form. A silent loss here would take every
// tag-driven branch with it.
export type SensorModelKeyIsItsLiteral = Pin<Equals<ProtectSensor["modelKey"], "sensor">>;
export type BareModelKeyIsTheUnion = Pin<Equals<ProtectDevice["modelKey"], ProtectDeviceConfig["modelKey"]>>;

describe("the device config view's runtime relationship to its compile-time narrowing", () => {

  const store = new TestStateStore(makeProtectState({ sensors: [makeSensorConfig({ id: "sensor-ufp-typing", mac: "74ACB9000042" })] }));
  const { controller, nvr } = makeTestNvr({ store });
  const accessory = makeTestAccessory("Test Sensor", "uuid:sensor-ufp-typing");
  const projection = new TestSensorProjection("sensor-ufp-typing", store) as unknown as Sensor;
  const device = new TestBaseDevice(nvr as unknown as ProtectNvr, accessory as unknown as ProtectAccessory, projection);

  after(() => controller.abort());

  test("the identity narrowing is compile-time only: the live record still carries its identity keys, so the type is the whole guard", () => {

    // The view is the live record itself - dropping the identity keys is a type-level remap with no runtime projection step - so every identity key is still present at
    // runtime. Anything that needs identity reads the dedicated accessors below; nothing may read runtime absence as the guard, because there is none.
    const view: Record<string, unknown> = device.ufp;

    assert.equal("id" in view, true, "the live record still carries id at runtime; only the type drops it");
    assert.equal("mac" in view, true, "the live record still carries mac at runtime; only the type drops it");
    assert.equal("modelKey" in view, true, "the live record still carries modelKey at runtime; only the type drops it");

    // The dedicated non-throwing accessors are the sanctioned identity reads, and they resolve the same values the record carries.
    assert.equal(device.protectId, "sensor-ufp-typing", "protectId reads the controller device id off the projection");
    assert.equal(device.modelKey, "sensor", "modelKey reads the category tag off the projection");
  });
});
