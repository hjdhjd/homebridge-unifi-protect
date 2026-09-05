/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * smoke-policy.test.ts: Unit tests for the pure smoke and carbon monoxide detection policy extracted to the importable leaf src/devices/smoke-policy.ts.
 *
 * Every export here is a pure free function or a frozen shape - wire facts in, a boolean or a typed tag out, no this, no HAP - so the natural coverage is to import the
 * REAL leaf and drive its truth tables directly, exactly as leak-policy.test.ts / air-quality-policy.test.ts drive theirs. The leaf owns the decisions the whole smoke
 * surface rests on, so these tables are the highest-value rows: the two-part rule that keeps a sensor with no detector hardware from growing either service - its model
 * half, where a listener carrying a detector's whole advertisement is still no detector, and its advertisement half, which names which of the two services detector
 * hardware carries (with the glass-break unit's own alarm-type list as the input that tells an advertisement read apart from a bare presence check) - the detection
 * predicates that must answer for their own alarm and no other, and the fault tables, where the same end-of-life flag faults both services while each sensor's own fault
 * faults only its own.
 *
 * The at-rest block comes from the device harness's makeSmokeStatus rather than being respelled here, so the leaf's tables and the sensor family's fixtures read one
 * statement of what a healthy detector reports.
 */
import { SMOKE_ALARM_TYPES, carbonMonoxideDetected, carbonMonoxideFault, carbonMonoxideFaultReasons, smokeAlarmCapable, smokeDetected, smokeDetectorHardware,
  smokeFault, smokeFaultReasons } from "./smoke-policy.ts";
import { describe, test } from "node:test";
import type { ProtectSensorSmokeStatus } from "unifi-protect";
import type { SmokeFaultReason } from "./smoke-policy.ts";
import assert from "node:assert/strict";
import { makeSmokeStatus } from "./testing.helpers.ts";

describe("smoke and carbon monoxide detection policy", () => {

  test("the alarm-type vocabulary carries the controller's own wire spellings", () => {

    // The wire markers live here and nowhere else, capital CO included, so no call site ever spells one.
    assert.deepEqual(SMOKE_ALARM_TYPES, { carbonMonoxide: "CO", smoke: "smoke" }, "the two alarm types are spelled exactly as the controller advertises them");
  });

  test("a sensor is smoke detector hardware only by its model family", () => {

    // The model half of the rule, and the listener row is the one that carries it: that unit advertises exactly what a detector advertises and reports a full status
    // block, so the model is all that tells the two apart. Matching the type by its family prefix rather than by one geography's exact value is what admits every
    // regional variant, and the boundary row holds that prefix to the family rather than to the stem it shares.
    const cases: { config: { marketName?: string; type?: string }; expected: boolean; label: string }[] = [

      { config: { marketName: "USL Smoke", type: "USL-Smoke-US" }, expected: true, label: "the detector as the controller reports it" },
      { config: { marketName: "Test Sensor Model", type: "USL-Smoke-EU" }, expected: true, label: "another geography's type under the family prefix" },
      { config: { marketName: "USL Smoke" }, expected: true, label: "the market name alone, with the type absent at runtime" },
      { config: { marketName: "UP Sense", type: "UFP-SENSE" }, expected: false, label: "the listener advertising a detector's own alarm types" },
      { config: { marketName: "USL GlassBreak", type: "USL-GlassBreak-US" }, expected: false, label: "the glass-break unit" },
      { config: { type: "USL-SmokeExtra-US" }, expected: false, label: "a type sharing the stem without the family hyphen" },
      { config: {}, expected: false, label: "a record carrying neither field" }
    ];

    for(const { config, expected, label } of cases) {

      assert.equal(smokeDetectorHardware(config), expected, "detector hardware for " + label);
    }
  });

  test("a sensor detects an alarm type only when the controller advertises that type", () => {

    // The advertisement half of the rule, asked of a unit the model half has already admitted, and it names which of the two services that hardware carries. The
    // glass-break row is the input that tells this apart from a bare presence check: that unit advertises an alarm-type list of its own while detecting neither smoke
    // nor carbon monoxide.
    const both = [ "smoke", "CO" ];
    const smokeOnly = ["smoke"];
    const glassBreakOnly = ["glassBreak"];
    const none: string[] = [];

    const cases: { alarmTypes: string[] | undefined; carbonMonoxide: boolean; label: string; smoke: boolean }[] = [

      { alarmTypes: both, carbonMonoxide: true, label: "a dual detector advertising both types", smoke: true },
      { alarmTypes: smokeOnly, carbonMonoxide: false, label: "a detector advertising smoke alone", smoke: true },
      { alarmTypes: glassBreakOnly, carbonMonoxide: false, label: "the glass-break unit's own alarm-type list", smoke: false },
      { alarmTypes: none, carbonMonoxide: false, label: "an empty advertisement", smoke: false },
      { alarmTypes: undefined, carbonMonoxide: false, label: "no advertisement at all", smoke: false }
    ];

    for(const { alarmTypes, carbonMonoxide, label, smoke } of cases) {

      assert.equal(smokeAlarmCapable(alarmTypes, SMOKE_ALARM_TYPES.smoke), smoke, "smoke capability for " + label);
      assert.equal(smokeAlarmCapable(alarmTypes, SMOKE_ALARM_TYPES.carbonMonoxide), carbonMonoxide, "carbon monoxide capability for " + label);
    }
  });

  test("each detection predicate answers for its own alarm and for no other reading", () => {

    assert.equal(smokeDetected(makeSmokeStatus()), false, "an at-rest detector reports no smoke");
    assert.equal(carbonMonoxideDetected(makeSmokeStatus()), false, "an at-rest detector reports no carbon monoxide");
    assert.equal(smokeDetected(makeSmokeStatus({ smokeAlarm: true })), true, "a sounding smoke alarm reads detected");
    assert.equal(carbonMonoxideDetected(makeSmokeStatus({ smokeAlarm: true })), false, "a sounding smoke alarm is not a carbon monoxide alarm");
    assert.equal(carbonMonoxideDetected(makeSmokeStatus({ coAlarm: true })), true, "a sounding carbon monoxide alarm reads detected");
    assert.equal(smokeDetected(makeSmokeStatus({ coAlarm: true })), false, "a sounding carbon monoxide alarm is not a smoke alarm");

    // The raw readings are telemetry rather than alarms. A detector running its self-test moves both of them with neither alarm sounding, which is exactly what the
    // field capture of a real self-test shows, so a predicate that consulted the numbers would report an alarm nobody heard.
    const selfTest = makeSmokeStatus({ coValue: 1, smokeValue: 3410, testing: true });

    assert.equal(smokeDetected(selfTest), false, "a self-test moving the raw readings raises no smoke alarm");
    assert.equal(carbonMonoxideDetected(selfTest), false, "a self-test moving the raw readings raises no carbon monoxide alarm");
  });

  test("each service's fault reasons come from its own table, in that table's order, and its fault boolean agrees with them", () => {

    // The whole mapping in one table: each flag alone, the shared end-of-life flag that faults both services, every flag at once (which is what proves the fixed order
    // and proves a flag outside a service's own table never faults it), and the at-rest block that faults neither.
    const cases: { carbonMonoxide: SmokeFaultReason[]; flags: Partial<ProtectSensorSmokeStatus>; label: string; smoke: SmokeFaultReason[] }[] = [

      { carbonMonoxide: [], flags: {}, label: "an at-rest detector", smoke: [] },
      { carbonMonoxide: [], flags: { smokeSensorFault: true }, label: "the smoke sensor's own fault alone", smoke: ["smokeSensorFault"] },
      { carbonMonoxide: ["coSensorFault"], flags: { coSensorFault: true }, label: "the carbon monoxide sensor's own fault alone", smoke: [] },
      { carbonMonoxide: [], flags: { cleanSmokeSensor: true }, label: "a chamber needing cleaning, which is the smoke sensor's alone", smoke: ["cleanSmokeSensor"] },
      { carbonMonoxide: ["endOfLife"], flags: { endOfLife: true }, label: "end of life, which faults both services", smoke: ["endOfLife"] },
      { carbonMonoxide: ["endOfLife"], flags: { cleanSmokeSensor: true, endOfLife: true }, label: "cleaning alongside end of life",
        smoke: [ "endOfLife", "cleanSmokeSensor" ] },
      { carbonMonoxide: [ "coSensorFault", "endOfLife" ], flags: { cleanSmokeSensor: true, coSensorFault: true, endOfLife: true, smokeSensorFault: true },
        label: "every fault flag at once", smoke: [ "smokeSensorFault", "endOfLife", "cleanSmokeSensor" ] }
    ];

    for(const { carbonMonoxide, flags, label, smoke } of cases) {

      const status = makeSmokeStatus(flags);

      assert.deepEqual(smokeFaultReasons(status), smoke, "the smoke sensor's fault reasons for " + label);
      assert.deepEqual(carbonMonoxideFaultReasons(status), carbonMonoxide, "the carbon monoxide sensor's fault reasons for " + label);
      assert.equal(smokeFault(status), (smoke.length > 0), "the smoke fault boolean agrees with its own reasons list for " + label);
      assert.equal(carbonMonoxideFault(status), (carbonMonoxide.length > 0), "the carbon monoxide fault boolean agrees with its own reasons list for " + label);
    }
  });
});
