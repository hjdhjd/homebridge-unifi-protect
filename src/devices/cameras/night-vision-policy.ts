/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * night-vision-policy.ts: the pure mapping between a camera's infrared night-vision mode and its HomeKit brightness, for UniFi Protect.
 *
 * A camera's night vision is a HomeKit dimmer: the brightness picks one of a small set of controller irLedMode values, and the mode maps back to a displayed brightness.
 * The controller types irLedMode as a bare string, so this module is the plugin's single owner of the recognized value set and of the two-way transform between it and
 * the HomeKit percentage. Every decision - snapping a raw brightness to a discrete stop, choosing the command for a brightness set, the On-toggle pick, the binary
 * characteristic's pick, and the inverse getter - lives here as a pure function with no `this` and no I/O, matching the pure-module voice of stream-source-policy.ts. A
 * raw wire value crosses into the narrow mode through exactly one classifier, so unknown-value handling has a single home and every internal map stays exhaustive.
 */

// The closed set of irLedMode values the controller uses. The wire types irLedMode as a bare string; this module narrows a raw value into (or rejects it from) this set
// through parseNightVisionMode, and every other function here takes the narrow type.
export type NightVisionMode = "auto" | "autoFilterOnly" | "custom" | "customFilterOnly" | "off" | "on";

// The infrared-cutoff-removal (icr) custom value maps to a HomeKit percentage by one linear transform, named once and shared by both directions: the forward math
// (brightness -> icr) and the inverse (icr -> brightness). The controller's icrCustomValue ranges 0..10, which these map onto 20..90 percent.
export const NIGHTVISION_ICR_FLOOR = 20;
export const NIGHTVISION_ICR_STEP = 7;

/* A command that sets night vision on the controller, as a discriminated union keyed on irLedMode: one arm for the four fixed modes, one for the custom pair. The custom
 * arm's icrCustomValue is optional because the toggle-on path deliberately omits it - it sends mode only, so the controller keeps whatever custom value it last had - so
 * a present icrCustomValue on a fixed mode is unrepresentable.
 */
export type NightVisionCommand = { irLedMode: "auto" | "autoFilterOnly" | "off" | "on" } | { icrCustomValue?: number; irLedMode: "custom" | "customFilterOnly" };

// Narrow a raw irLedMode string to a NightVisionMode, or null for an unrecognized value. The one wire-boundary classifier: unknown-value handling lives here, so every
// other function in the module takes the narrow type and its maps stay exhaustive.
export function parseNightVisionMode(raw: string): NightVisionMode | null {

  switch(raw) {

    case "auto":
    case "autoFilterOnly":
    case "custom":
    case "customFilterOnly":
    case "off":
    case "on":

      return raw;

    default:

      return null;
  }
}

// Whether night vision is active for a mode: any mode other than "off". A null - an unrecognized wire value - reads as active, matching the shipped `irLedMode !== "off"`
// semantics of the binary getter.
export function nightVisionActive(mode: NightVisionMode | null): boolean {

  return mode !== "off";
}

// The command for the binary NightVision characteristic: auto when turning on, off when turning off.
export function nightVisionToggleCommand(value: boolean): NightVisionCommand {

  return { irLedMode: value ? "auto" : "off" };
}

// The brightness a mode maps to - the inverse of the level math: off 0, autoFilterOnly 5, auto 10, on 100, and the custom pair through the shared icr transform. Total
// over the narrow mode; the unknown case lives in the classifier, not here.
export function nightVisionBrightnessForMode(options: { icrCustomValue: number; mode: NightVisionMode }): number {

  const { icrCustomValue, mode } = options;

  switch(mode) {

    case "off":

      return 0;

    case "autoFilterOnly":

      return 5;

    case "auto":

      return 10;

    case "on":

      return 100;

    case "custom":
    case "customFilterOnly":

      return (icrCustomValue * NIGHTVISION_ICR_STEP) + NIGHTVISION_ICR_FLOOR;
  }
}

// Snap a raw brightness to the discrete stops night vision recognizes: below 5 -> 0, the open 5..10 band -> 5, the open 10..20 band -> 10, above 90 -> 100, and every
// other value unchanged (the exact 5, 10, and 100 stops and the 20..90 custom range pass through).
export function quantizeNightVisionLevel(level: number): number {

  if(level < 5) {

    return 0;
  }

  if((level > 5) && (level < 10)) {

    return 5;
  }

  if((level > 10) && (level < 20)) {

    return 10;
  }

  if(level > 90) {

    return 100;
  }

  return level;
}

// The mode-preserving custom pick: customFilterOnly when the current mode is a FilterOnly variant, else custom - so a filter-only camera stays on its filter-only custom
// arm rather than dropping the filter.
function customModeFor(currentMode: NightVisionMode | null): "custom" | "customFilterOnly" {

  return ((currentMode === "autoFilterOnly") || (currentMode === "customFilterOnly")) ? "customFilterOnly" : "custom";
}

// The command and reflected brightness for a raw dimmer brightness set: quantize, then map each stop to its mode. The custom range computes the icrCustomValue through
// the shared transform and reflects the brightness that value maps back to (Protect's granularity is coarser than HomeKit's, so the reflected value can differ from set).
export function nightVisionCommandForLevel(options: { currentMode: NightVisionMode | null; level: number }): { command: NightVisionCommand; reflectedLevel: number } {

  const { currentMode, level } = options;

  switch(quantizeNightVisionLevel(level)) {

    case 0:

      return { command: { irLedMode: "off" }, reflectedLevel: 0 };

    case 5:

      return { command: { irLedMode: "autoFilterOnly" }, reflectedLevel: 5 };

    case 10:

      return { command: { irLedMode: "auto" }, reflectedLevel: 10 };

    case 100:

      return { command: { irLedMode: "on" }, reflectedLevel: 100 };

    default: {

      const icrCustomValue = Math.round((quantizeNightVisionLevel(level) - NIGHTVISION_ICR_FLOOR) / NIGHTVISION_ICR_STEP);

      return { command: { icrCustomValue, irLedMode: customModeFor(currentMode) }, reflectedLevel: (icrCustomValue * NIGHTVISION_ICR_STEP) + NIGHTVISION_ICR_FLOOR };
    }
  }
}

// The command for turning the dimmer On, over the same table but never selecting "off" (turning on must not turn night vision off) and never sending an icrCustomValue
// (the custom arm is mode only, so the controller keeps its current custom value): quantize the current brightness, then 5 -> autoFilterOnly, 10 -> auto, 100 -> on, and
// anything else -> the mode-preserving custom pick.
export function nightVisionModeForToggleOn(options: { currentLevel: number; currentMode: NightVisionMode | null }): NightVisionCommand {

  const { currentLevel, currentMode } = options;

  switch(quantizeNightVisionLevel(currentLevel)) {

    case 5:

      return { irLedMode: "autoFilterOnly" };

    case 10:

      return { irLedMode: "auto" };

    case 100:

      return { irLedMode: "on" };

    default:

      return { irLedMode: customModeFor(currentMode) };
  }
}
