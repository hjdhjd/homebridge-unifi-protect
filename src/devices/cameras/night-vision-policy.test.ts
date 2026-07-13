/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * night-vision-policy.test.ts: Truth-table tests over the pure night-vision mapping - the wire classifier, the mode/brightness inverse, the quantization, the command
 * picks (brightness set, toggle-on, binary), and the icr round-trip. Every row exercises the exported pure functions directly, with concrete anchor numbers independent
 * of the module's own constants so a mutually-consistent wrong constant pair cannot pass under the self-referential round-trip alone.
 */
import { NIGHTVISION_ICR_FLOOR, NIGHTVISION_ICR_STEP, nightVisionActive, nightVisionBrightnessForMode, nightVisionCommandForLevel, nightVisionModeForToggleOn,
  nightVisionToggleCommand, parseNightVisionMode, quantizeNightVisionLevel } from "./night-vision-policy.ts";
import { describe, test } from "node:test";
import assert from "node:assert/strict";

describe("night-vision mode classifier", () => {

  test("narrows each recognized irLedMode and rejects an unknown value", () => {

    for(const mode of [ "auto", "autoFilterOnly", "custom", "customFilterOnly", "off", "on" ] as const) {

      assert.equal(parseNightVisionMode(mode), mode, "the recognized wire value narrows to itself");
    }

    assert.equal(parseNightVisionMode("bogus"), null, "an unrecognized wire value is rejected to null");
    assert.equal(parseNightVisionMode(""), null, "an empty wire value is rejected to null");
  });
});

describe("night-vision brightness inverse (per mode)", () => {

  test("maps each mode to its brightness, with the custom pair through the shared icr transform", () => {

    assert.equal(nightVisionBrightnessForMode({ icrCustomValue: 0, mode: "off" }), 0, "off maps to brightness 0");
    assert.equal(nightVisionBrightnessForMode({ icrCustomValue: 0, mode: "autoFilterOnly" }), 5, "autoFilterOnly maps to brightness 5");
    assert.equal(nightVisionBrightnessForMode({ icrCustomValue: 0, mode: "auto" }), 10, "auto maps to brightness 10");
    assert.equal(nightVisionBrightnessForMode({ icrCustomValue: 0, mode: "on" }), 100, "on maps to brightness 100");

    // Concrete anchor rows with hardcoded expected numbers, independent of the module's own constants, matching the shipped formula icr * 7 + 20.
    assert.equal(nightVisionBrightnessForMode({ icrCustomValue: 0, mode: "custom" }), 20, "icr 0 maps to brightness 20");
    assert.equal(nightVisionBrightnessForMode({ icrCustomValue: 4, mode: "customFilterOnly" }), 48, "icr 4 maps to brightness 48");
    assert.equal(nightVisionBrightnessForMode({ icrCustomValue: 10, mode: "custom" }), 90, "icr 10 maps to brightness 90");
  });
});

describe("night-vision active predicate", () => {

  test("every mode but off is active, and an unknown wire value reads active", () => {

    for(const mode of [ "auto", "autoFilterOnly", "custom", "customFilterOnly", "on" ] as const) {

      assert.equal(nightVisionActive(mode), true, "a non-off mode is active");
    }

    assert.equal(nightVisionActive("off"), false, "off is not active");
    assert.equal(nightVisionActive(null), true, "an unrecognized wire value reads as active, matching irLedMode !== off");
  });
});

describe("night-vision level quantization", () => {

  test("snaps raw brightness to the discrete stops at every boundary", () => {

    const rows: [ number, number ][] = [ [ 4, 0 ], [ 5, 5 ], [ 7, 5 ], [ 10, 10 ], [ 15, 10 ], [ 19, 10 ], [ 20, 20 ], [ 55, 55 ], [ 90, 90 ], [ 91, 100 ],
      [ 100, 100 ] ];

    for(const [ level, expected ] of rows) {

      assert.equal(quantizeNightVisionLevel(level), expected, "brightness " + level.toString() + " quantizes to " + expected.toString());
    }
  });
});

describe("night-vision command for a brightness set", () => {

  test("maps each stop to its command and reflected brightness", () => {

    assert.deepEqual(nightVisionCommandForLevel({ currentMode: "off", level: 4 }), { command: { irLedMode: "off" }, reflectedLevel: 0 }, "below 5 sets off");
    assert.deepEqual(nightVisionCommandForLevel({ currentMode: "off", level: 5 }), { command: { irLedMode: "autoFilterOnly" }, reflectedLevel: 5 },
      "5 sets autoFilterOnly");
    assert.deepEqual(nightVisionCommandForLevel({ currentMode: "off", level: 10 }), { command: { irLedMode: "auto" }, reflectedLevel: 10 }, "10 sets auto");
    assert.deepEqual(nightVisionCommandForLevel({ currentMode: "off", level: 95 }), { command: { irLedMode: "on" }, reflectedLevel: 100 }, "above 90 sets on");

    // Concrete anchor: brightness 55 -> icr 5, reflected 55, matching the shipped formula.
    assert.deepEqual(nightVisionCommandForLevel({ currentMode: "custom", level: 55 }), { command: { icrCustomValue: 5, irLedMode: "custom" }, reflectedLevel: 55 },
      "brightness 55 sets icr 5 on the custom arm and reflects 55");

    // Mode-preserving: a FilterOnly current mode keeps the filter on the custom arm.
    assert.deepEqual(nightVisionCommandForLevel({ currentMode: "autoFilterOnly", level: 55 }),
      { command: { icrCustomValue: 5, irLedMode: "customFilterOnly" }, reflectedLevel: 55 }, "a filter-only current mode keeps the filter on the custom arm");
  });

  test("the icr round-trip holds for every custom value 0..10", () => {

    for(let icr = 0; icr <= 10; icr++) {

      const level = (icr * NIGHTVISION_ICR_STEP) + NIGHTVISION_ICR_FLOOR;
      const { command, reflectedLevel } = nightVisionCommandForLevel({ currentMode: "custom", level });

      assert.ok("icrCustomValue" in command, "the custom-range command carries an icrCustomValue");
      assert.equal(command.icrCustomValue, icr, "the level maps back to its own icr value");
      assert.equal(reflectedLevel, level, "the reflected brightness round-trips to the set brightness");
      assert.equal(nightVisionBrightnessForMode({ icrCustomValue: icr, mode: "custom" }), reflectedLevel, "the inverse getter agrees with the reflected brightness");
    }
  });
});

describe("night-vision toggle-on pick", () => {

  test("picks the mode from the quantized current brightness, never off, and turns on at 100 (the drift fix)", () => {

    assert.deepEqual(nightVisionModeForToggleOn({ currentLevel: 5, currentMode: "off" }), { irLedMode: "autoFilterOnly" }, "brightness 5 toggles on to autoFilterOnly");
    assert.deepEqual(nightVisionModeForToggleOn({ currentLevel: 10, currentMode: "off" }), { irLedMode: "auto" }, "brightness 10 toggles on to auto");

    // THE RED ROW: brightness 100 turns night vision on, not into the custom arm.
    assert.deepEqual(nightVisionModeForToggleOn({ currentLevel: 100, currentMode: "custom" }), { irLedMode: "on" }, "turning on at brightness 100 sets irLedMode on");

    // A low/zero level still turns on (never off), mode-preserving; a mid-range level lands on the custom arm without an icrCustomValue.
    assert.deepEqual(nightVisionModeForToggleOn({ currentLevel: 0, currentMode: "customFilterOnly" }), { irLedMode: "customFilterOnly" },
      "turning on at a zero level never turns the mode off - it preserves the filter-only custom arm");
    assert.deepEqual(nightVisionModeForToggleOn({ currentLevel: 55, currentMode: "off" }), { irLedMode: "custom" },
      "turning on at a mid-range level lands on the custom arm, mode-only, so the controller keeps its custom value");
  });
});

describe("night-vision binary toggle command", () => {

  test("auto when turning on, off when turning off", () => {

    assert.deepEqual(nightVisionToggleCommand(true), { irLedMode: "auto" }, "turning the binary characteristic on sets auto");
    assert.deepEqual(nightVisionToggleCommand(false), { irLedMode: "off" }, "turning the binary characteristic off sets off");
  });
});

// Union shape (a compile-time row, no runtime assertion): NightVisionCommand's fixed-mode arm carries no icrCustomValue key, so a fixed-mode command with an
// icrCustomValue - `{ icrCustomValue: 3, irLedMode: "off" }` typed as NightVisionCommand - does not type-check. The typecheck gate is the assertion.
