/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * air-quality-policy.test.ts: Unit tests for the pure air-quality reading policy extracted to the importable leaf src/devices/air-quality-policy.ts.
 *
 * Every export here is a pure free function or a frozen shape - wire readings in, a boolean or a number out, no this, no HAP - so the natural coverage is to import the
 * REAL leaf and drive its truth tables directly, exactly as leak-policy.test.ts / stream-source-policy.test.ts drive theirs. The leaf owns the decisions the whole
 * air-quality surface rests on, so these tables are the highest-value pins: the not-capable signature that keeps a sensor without air-quality hardware from growing any
 * service, the AQI band edges (each boundary value AND the value one past it), the CO2 threshold comparison including the at-threshold case that must NOT alert, and the
 * vape predicate's status-alone rule - a reading carrying a number under an "unknown" status must never detect, which is exactly the case a value-aware formula would
 * get wrong.
 */
import { AIR_QUALITY_LEVELS, DISABLED_THRESHOLD_SETTINGS, DISABLED_VAPE_SENSITIVITY, NOT_CAPABLE_AIR_QUALITY, NOT_CAPABLE_METRIC, airQualityLevel,
  airQualityMetricLive, airQualityMetricReported, airQualityReporting, airQualitySensorCapable, co2AlertDetected, environmentalReading, environmentalServiceGate,
  vapeDetected } from "./air-quality-policy.ts";
import type { ProtectAirQualityMetric, ProtectAirQualityThresholdSettings, ProtectSensorAirQuality } from "unifi-protect";
import { describe, test } from "node:test";
import type { Nullable } from "homebridge-plugin-utils";
import assert from "node:assert/strict";

// A metric reading, spelled as the pair the controller sends. Sharing it keeps each case row legible and within the line width.
function metric(status: string, value: Nullable<number>): ProtectAirQualityMetric {

  return { status, value };
}

// A full block of readings, all quiet except the metrics a case names - the shape a real sensor sends, where every metric is always present.
function block(overrides: Partial<ProtectSensorAirQuality>): ProtectSensorAirQuality {

  return { ...NOT_CAPABLE_AIR_QUALITY, ...overrides };
}

describe("air-quality reading policy", () => {

  test("the not-capable shapes spell the controller's own quiet defaults", () => {

    // The single definitions every fallback and fixture references. The metric pair is what a sensor without air-quality hardware reports on every metric; the threshold
    // shape is the NULLABLE, margin-less air-quality one, deliberately distinct from the sensor's top-level environmental thresholds.
    assert.deepEqual(NOT_CAPABLE_METRIC, { status: "unknown", value: null }, "the not-capable metric is an unknown status carrying no value");
    assert.deepEqual(DISABLED_THRESHOLD_SETTINGS, { highThreshold: null, isEnabled: false, lowThreshold: null },
      "the disabled threshold shape is nullable and carries no margin key");
    assert.deepEqual(DISABLED_VAPE_SENSITIVITY, { isEnabled: false, sensitivity: 0 }, "the disabled vape sensitivity is off at its lowest setting");
    assert.equal(Object.keys(NOT_CAPABLE_AIR_QUALITY).length, 12, "the not-capable block covers every metric the controller reports");

    for(const [ name, reading ] of Object.entries(NOT_CAPABLE_AIR_QUALITY)) {

      assert.deepEqual(reading, NOT_CAPABLE_METRIC, "the not-capable block reads the not-capable metric for " + name);
    }
  });

  test("the HomeKit level names mirror hap's AirQuality enum", () => {

    assert.deepEqual(AIR_QUALITY_LEVELS, { excellent: 1, fair: 3, good: 2, inferior: 4, poor: 5, unknown: 0 },
      "the named levels carry hap's UNKNOWN / EXCELLENT / GOOD / FAIR / INFERIOR / POOR values");
  });

  test("a metric is live when it carries a value OR its status is anything but unknown", () => {

    // The not-capable signature is the PAIR, so each half standing alone still reads live: a metric between readings under a known status, and a metric reporting a
    // number under a status we have never seen, both keep their surface alive.
    const cases: { expected: boolean; label: string; reading: ProtectAirQualityMetric }[] = [

      { expected: false, label: "unknown status, no value -> not live (the not-capable signature)", reading: metric("unknown", null) },
      { expected: true, label: "unknown status, a value -> live (a reading is a reading)", reading: metric("unknown", 42) },
      { expected: true, label: "neutral status, no value -> live (reporting, momentarily between readings)", reading: metric("neutral", null) },
      { expected: true, label: "neutral status, a value -> live", reading: metric("neutral", 42) }
    ];

    for(const { expected, label, reading } of cases) {

      assert.equal(airQualityMetricLive(reading), expected, label);
    }
  });

  test("a metric is reported only while it carries a number", () => {

    assert.equal(airQualityMetricReported(metric("neutral", 0)), true, "a zero reading is still a reading");
    assert.equal(airQualityMetricReported(metric("neutral", 34.79)), true, "a fractional reading is a reading");
    assert.equal(airQualityMetricReported(metric("neutral", null)), false, "a live metric between readings carries no reading");
    assert.equal(airQualityMetricReported(metric("unknown", null)), false, "a not-capable metric carries no reading");
  });

  test("the aqi mapping walks the EPA bands, each boundary and the value one past it", () => {

    // Every band edge plus its successor, so an off-by-one in any comparison reds exactly one row.
    const cases: { expected: number; label: string; reading: ProtectAirQualityMetric }[] = [

      { expected: AIR_QUALITY_LEVELS.unknown, label: "no reading -> unknown", reading: metric("unknown", null) },
      { expected: AIR_QUALITY_LEVELS.excellent, label: "0 -> excellent", reading: metric("neutral", 0) },
      { expected: AIR_QUALITY_LEVELS.excellent, label: "50 (the good-air ceiling) -> excellent", reading: metric("neutral", 50) },
      { expected: AIR_QUALITY_LEVELS.good, label: "51 -> good", reading: metric("neutral", 51) },
      { expected: AIR_QUALITY_LEVELS.good, label: "100 (the moderate ceiling) -> good", reading: metric("neutral", 100) },
      { expected: AIR_QUALITY_LEVELS.fair, label: "101 -> fair", reading: metric("neutral", 101) },
      { expected: AIR_QUALITY_LEVELS.fair, label: "150 (the sensitive-groups ceiling) -> fair", reading: metric("neutral", 150) },
      { expected: AIR_QUALITY_LEVELS.inferior, label: "151 -> inferior", reading: metric("neutral", 151) },
      { expected: AIR_QUALITY_LEVELS.inferior, label: "200 (the unhealthy ceiling) -> inferior", reading: metric("neutral", 200) },
      { expected: AIR_QUALITY_LEVELS.poor, label: "201 -> poor (very unhealthy and hazardous share HomeKit's worst level)", reading: metric("neutral", 201) }
    ];

    for(const { expected, label, reading } of cases) {

      assert.equal(airQualityLevel(reading), expected, label);
    }
  });

  test("the co2 alert fires only on an enabled, configured threshold the reading exceeds", () => {

    // The at-threshold row is the one that pins the comparison as strictly-greater: a reading sitting exactly on the user's number is not yet an alert.
    const cases: { expected: boolean; label: string; reading: ProtectAirQualityMetric; settings: ProtectAirQualityThresholdSettings }[] = [

      { expected: true, label: "enabled, threshold 1000, reading 1001 -> alert", reading: metric("neutral", 1001),
        settings: { highThreshold: 1000, isEnabled: true, lowThreshold: null } },
      { expected: false, label: "enabled, threshold 1000, reading exactly 1000 -> no alert (strictly greater)", reading: metric("neutral", 1000),
        settings: { highThreshold: 1000, isEnabled: true, lowThreshold: null } },
      { expected: false, label: "disabled, reading well past the threshold -> no alert (the user's own switch is absolute)", reading: metric("neutral", 5000),
        settings: { highThreshold: 1000, isEnabled: false, lowThreshold: null } },
      { expected: false, label: "enabled but no threshold configured -> no alert (nothing to compare against)", reading: metric("neutral", 5000),
        settings: { highThreshold: null, isEnabled: true, lowThreshold: null } },
      { expected: false, label: "enabled and configured but no reading -> no alert", reading: metric("neutral", null),
        settings: { highThreshold: 1000, isEnabled: true, lowThreshold: null } },
      { expected: false, label: "a low reading with a low threshold set -> no alert (lowThreshold is deliberately unread)", reading: metric("neutral", 100),
        settings: { highThreshold: 1000, isEnabled: true, lowThreshold: 400 } },
      { expected: false, label: "the disabled default -> no alert", reading: metric("neutral", 5000), settings: DISABLED_THRESHOLD_SETTINGS }
    ];

    for(const { expected, label, reading, settings } of cases) {

      assert.equal(co2AlertDetected(reading, settings), expected, label);
    }
  });

  test("vape detection reads the status alone, so a number under an unknown status never detects", () => {

    // The status-alone rule, pinned as documented behavior in both directions: an "unknown" status never detects even carrying a number (the case a value-aware formula
    // would get wrong), and a detection-class status detects even carrying none.
    const cases: { expected: boolean; label: string; reading: ProtectAirQualityMetric }[] = [

      { expected: false, label: "unknown status, no value -> no detection (not-capable)", reading: metric("unknown", null) },
      { expected: false, label: "unknown status WITH a value -> still no detection (status alone decides)", reading: metric("unknown", 7) },
      { expected: false, label: "neutral status -> no detection (the observed all-clear)", reading: metric("neutral", 0) },
      { expected: true, label: "any other status with a value -> detection", reading: metric("detected", 7) },
      { expected: true, label: "any other status with no value -> detection (a status-only report still alerts)", reading: metric("detected", null) }
    ];

    for(const { expected, label, reading } of cases) {

      assert.equal(vapeDetected(reading), expected, label);
    }
  });

  test("the service-capability predicates read the whole block, with MQTT the broader of the two", () => {

    // The air quality service needs a metric HomeKit can model; MQTT publishes whenever ANY metric reports, which is where the metrics HomeKit has no service for live.
    // The all-quiet row is the fleet regression gate: a sensor without air-quality hardware must answer false to both.
    const cases: { expectedReporting: boolean; expectedSensor: boolean; label: string; readings: ProtectSensorAirQuality }[] = [

      { expectedReporting: false, expectedSensor: false, label: "all quiet -> neither (a sensor without air-quality hardware)", readings: block({}) },
      { expectedReporting: true, expectedSensor: true, label: "aqi live -> both", readings: block({ aqi: metric("neutral", 12) }) },
      { expectedReporting: true, expectedSensor: true, label: "pm2p5 live -> both", readings: block({ pm2p5: metric("neutral", 3) }) },
      { expectedReporting: true, expectedSensor: true, label: "pm10p0 live -> both", readings: block({ pm10p0: metric("neutral", 5) }) },
      { expectedReporting: true, expectedSensor: false, label: "co2 alone -> MQTT only (HomeKit models it on its own service)",
        readings: block({ co2: metric("neutral", 800) }) },
      { expectedReporting: true, expectedSensor: false, label: "tvoc alone -> MQTT only (a unitless index, not a density HomeKit can show)",
        readings: block({ tvoc: metric("neutral", 34.79) }) },
      { expectedReporting: true, expectedSensor: false, label: "vape alone -> MQTT only", readings: block({ vape: metric("neutral", null) }) },
      { expectedReporting: true, expectedSensor: false, label: "voc alone -> MQTT only (no HomeKit surface)", readings: block({ voc: metric("neutral", 68) }) },
      { expectedReporting: true, expectedSensor: false, label: "pm1p0 alone -> MQTT only", readings: block({ pm1p0: metric("neutral", 2) }) },
      { expectedReporting: true, expectedSensor: false, label: "pm4p0 alone -> MQTT only", readings: block({ pm4p0: metric("neutral", 4) }) },
      { expectedReporting: true, expectedSensor: false, label: "nox alone -> MQTT only", readings: block({ nox: metric("neutral", 1) }) },
      { expectedReporting: true, expectedSensor: false, label: "humidity alone -> MQTT only", readings: block({ humidity: metric("neutral", 44) }) },
      { expectedReporting: true, expectedSensor: false, label: "temperature alone -> MQTT only", readings: block({ temperature: metric("neutral", 21) }) }
    ];

    for(const { expectedReporting, expectedSensor, label, readings } of cases) {

      assert.equal(airQualitySensorCapable(readings), expectedSensor, "air quality service: " + label);
      assert.equal(airQualityReporting(readings), expectedReporting, "MQTT publish: " + label);
    }
  });

  test("the environmental selector prefers the stats reading and falls back to the air-quality block", () => {

    // The precedence row uses two live, DISTINCT values: no device in evidence reports through both sources, so this synthetic case is the only thing that can catch an
    // inverted selector. The literal-zero row is the one a || would fail - zero degrees is a real temperature, not an absent reading - and the present-but-null stat
    // row tells `stat?.value ?? metric.value` apart from `(stat ?? metric).value`, which would answer null there.
    const cases: { expected: Nullable<number>; label: string; metric: ProtectAirQualityMetric; stat: ProtectAirQualityMetric | undefined }[] = [

      { expected: 21.5, label: "both sources live -> the stats reading wins", metric: metric("neutral", 23.92), stat: metric("", 21.5) },
      { expected: 0, label: "a stats reading of exactly 0 -> 0 (a real reading, not an absent one)", metric: metric("neutral", 23.92), stat: metric("", 0) },
      { expected: 23.92, label: "no stats block at all -> the air-quality reading (the UP Air Quality case)", metric: metric("neutral", 23.92), stat: undefined },
      { expected: 23.92, label: "a stats member present but carrying no value -> the air-quality reading", metric: metric("neutral", 23.92), stat: metric("", null) },
      { expected: null, label: "both sources quiet -> no reading at all", metric: NOT_CAPABLE_METRIC, stat: undefined },
      { expected: null, label: "a stats member present and quiet alongside a quiet metric -> no reading", metric: NOT_CAPABLE_METRIC, stat: metric("", null) }
    ];

    for(const { expected, label, metric: reading, stat } of cases) {

      assert.equal(environmentalReading({ metric: reading, stat }), expected, label);
    }
  });

  test("the shared service gate takes a toggle or a reporting capability, and holds an existing service only while the device is unreachable", () => {

    // The three sufficient conditions, each isolated with the other two false, then the pair that pins the hold term: the SAME inputs with only isReachable moving must
    // flip the answer. The reachable half of that pair is exactly what a naive toggle && (hasService || capability) composition gets wrong - it would hold a service
    // whose toggle just went off, or a stale cached service, forever.
    const cases: { expected: boolean; label: string; options: Parameters<typeof environmentalServiceGate>[0] }[] = [

      { expected: true, label: "the Protect toggle alone is sufficient (the USL temperature and humidity contract)",
        options: { capability: false, enabled: true, hasService: false, isReachable: true } },
      { expected: true, label: "a reporting capability alone is sufficient with the toggle off (the air-quality hardware case)",
        options: { capability: true, enabled: false, hasService: false, isReachable: true } },
      { expected: true, label: "a reporting capability with no toggle member at all (the air quality and carbon dioxide callers)",
        options: { capability: true, hasService: false, isReachable: true } },
      { expected: false, label: "no toggle member and nothing reporting -> no service",
        options: { capability: false, hasService: false, isReachable: true } },
      { expected: false, label: "an existing service whose measurement reads the off signature while we can see the device -> shed",
        options: { capability: false, enabled: false, hasService: true, isReachable: true } },
      { expected: true, label: "the same inputs with the device unreachable -> held through the offline window",
        options: { capability: false, enabled: false, hasService: true, isReachable: false } },
      { expected: false, label: "an unreachable device grows no service it did not already have",
        options: { capability: false, enabled: false, hasService: false, isReachable: false } }
    ];

    for(const { expected, label, options } of cases) {

      assert.equal(environmentalServiceGate(options), expected, label);
    }
  });
});
