/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * air-quality-policy.ts: The pure air-quality reading policy for UniFi Protect sensors.
 *
 * This module owns every decision the air-quality surface makes about a sensor's readings: whether a metric is reporting at all, whether it carries a usable number, how
 * an AQI reading maps onto HomeKit's air-quality levels, when the controller's configured CO2 threshold is exceeded, when a vape status counts as a detection, and which
 * services a given block of readings can support. It is deliberately pure - `this`-free and free of any device or controller I/O, wire readings in and a boolean or a
 * number out - so the sensor leaf's consumers (the service gates, the characteristic writers, and the air-quality MQTT publish) import it without value-importing a
 * non-leaf module (the device layer's module-structure rule), and each truth table is exhaustively testable without standing up a sensor accessory.
 *
 * Why a leaf at all: the air-quality block is twelve metrics wide and every consumer asks a different question of it - the air quality service asks whether any of the
 * metrics HomeKit can model are reporting, the MQTT publish asks whether ANY metric is, each density characteristic asks whether its own metric carries a reading, and
 * the CO2 and vape services ask model-specific questions of a metric plus its settings. Answering those ad hoc at each call site would scatter one liveness rule across
 * the sensor leaf and let the service gate, the log, and the MQTT topic disagree about what "reporting" means. This is also where the read-source policy lives: the
 * controller reports a sensor's temperature and humidity in two places, and the choice between the stats block and the air-quality block is made here rather than at
 * each service. The two sources are disjoint by hardware in all the evidence we have, so one selector answers for the whole fleet.
 *
 * The grounding, from a controller-wide probe of every sensor model: a Protect sensor with no air-quality hardware still carries the full twelve-metric block, with
 * every metric reading { status: "unknown", value: null }. Capability therefore cannot be decided by property presence - the property is always there - so every gate
 * here reads values and statuses instead.
 */
import type { ProtectAirQualityMetric, ProtectAirQualityThresholdSettings, ProtectSensorAirQuality } from "unifi-protect";
import type { Nullable } from "homebridge-plugin-utils";

// The twelve metrics the controller reports, named once. Reading through this list rather than the block's own keys keeps every decision here scoped to the metrics we
// actually model, since the wire type carries an open index signature that a future firmware could widen underneath us.
const AIR_QUALITY_METRICS = [ "aqi", "co2", "humidity", "nox", "pm10p0", "pm1p0", "pm2p5", "pm4p0", "temperature", "tvoc", "vape", "voc" ] as const;

// The metrics HomeKit's air quality service can model: the index itself plus the particulate densities HomeKit has a mass-concentration characteristic for. A sensor
// reporting any of them earns the service. The gas readings are deliberately absent - Protect reports them as unitless indexes, which HomeKit has no home for.
const SENSOR_SERVICE_METRICS = [ "aqi", "pm10p0", "pm2p5" ] as const;

/**
 * The reading a sensor reports for a metric its hardware does not measure: an "unknown" status carrying no value. This is the single definition of that shape - the
 * sensor's read-through fallbacks and the test fixtures reference it rather than restating the pair - and the one place the "unknown" status string is spelled, which
 * {@link airQualityMetricLive} and {@link vapeDetected} then compare against.
 */
export const NOT_CAPABLE_METRIC: Readonly<ProtectAirQualityMetric> = { status: "unknown", value: null };

/**
 * A complete air-quality block in which nothing is capable: every metric reads the not-capable shape. This is what a sensor whose record has vanished reports, and what
 * a test fixture defaults to, so neither has to restate twelve metrics of quiet.
 */
export const NOT_CAPABLE_AIR_QUALITY: Readonly<ProtectSensorAirQuality> = {

  aqi: NOT_CAPABLE_METRIC,
  co2: NOT_CAPABLE_METRIC,
  humidity: NOT_CAPABLE_METRIC,
  nox: NOT_CAPABLE_METRIC,
  pm10p0: NOT_CAPABLE_METRIC,
  pm1p0: NOT_CAPABLE_METRIC,
  pm2p5: NOT_CAPABLE_METRIC,
  pm4p0: NOT_CAPABLE_METRIC,
  temperature: NOT_CAPABLE_METRIC,
  tvoc: NOT_CAPABLE_METRIC,
  vape: NOT_CAPABLE_METRIC,
  voc: NOT_CAPABLE_METRIC
};

/**
 * The answer an MQTT get gives for a temperature or humidity reading no source is currently reporting. The get contract is that it ALWAYS answers, so it needs a
 * stand-in for "nothing to say" that a subscriber can recognize; both readings are reported in units where a negative number is either impossible (humidity) or far
 * outside anything a Protect sensor measures (temperature). Named once here so the two get subscriptions cannot drift apart on what the stand-in is.
 */
export const NO_READING = -1;

/**
 * A per-metric alert threshold with nothing configured. The air-quality thresholds are nullable and carry no margin, a different shape from the sensor's top-level
 * environmental threshold settings, so this constant is what a fallback or a fixture reaches for rather than the top-level shape.
 */
export const DISABLED_THRESHOLD_SETTINGS: Readonly<ProtectAirQualityThresholdSettings> = { highThreshold: null, isEnabled: false, lowThreshold: null };

/**
 * Vape detection turned off on the controller, at its lowest sensitivity. The fallback a vanished record reports and the quiet default a fixture starts from.
 */
export const DISABLED_VAPE_SENSITIVITY: Readonly<{ isEnabled: boolean; sensitivity: number }> = { isEnabled: false, sensitivity: 0 };

/**
 * The HomeKit air quality levels, by name. The numbers mirror hap's Characteristic.AirQuality enum (UNKNOWN through POOR), named here so the mapping below and its
 * truth table read as levels rather than as magic numbers.
 */
export const AIR_QUALITY_LEVELS = { excellent: 1, fair: 3, good: 2, inferior: 4, poor: 5, unknown: 0 } as const;

/**
 * Decide whether a metric is reporting at all.
 *
 * A metric is live when it carries a value OR its status is something other than "unknown". Either half standing alone is deliberate: the not-capable signature the
 * controller reports is the PAIR - an "unknown" status with no value - so a metric that has a status but is momentarily between readings, or one reporting a value
 * under a status we have never seen, both still count as live. This is the gate that keeps a sensor without air-quality hardware from ever growing the services.
 *
 * @param metric - The metric reading to examine.
 *
 * @returns true when the sensor is reporting this metric.
 */
export function airQualityMetricLive(metric: ProtectAirQualityMetric): boolean {

  return (metric.value !== null) || (metric.status !== NOT_CAPABLE_METRIC.status);
}

/**
 * Decide whether a metric carries a usable reading right now, narrowing its value to a number for the caller.
 *
 * Written as a type guard so every downstream numeric use - a density characteristic write, a threshold comparison - sits behind the null check by construction rather
 * than by a caller remembering to repeat it.
 *
 * @param metric - The metric reading to examine.
 *
 * @returns true when the metric currently carries a number.
 */
export function airQualityMetricReported(metric: ProtectAirQualityMetric): metric is ProtectAirQualityMetric & { value: number } {

  return metric.value !== null;
}

/**
 * Map an AQI reading onto a HomeKit air quality level.
 *
 * The bands are the US EPA AQI breakpoints, collapsed onto HomeKit's five levels: good air (0-50) reads excellent, moderate (51-100) reads good, unhealthy for
 * sensitive groups (101-150) reads fair, unhealthy (151-200) reads inferior, and everything above - very unhealthy and hazardous, which HomeKit has no separate level
 * for - reads poor. A metric with no reading reports unknown, which is what HomeKit shows for a sensor that cannot answer. The numeric bands are deliberate: the
 * controller's own status vocabulary for this metric is incompletely observed, so the number is the trustworthy input.
 *
 * @param aqi - The sensor's aqi metric reading.
 *
 * @returns The HomeKit air quality level for this reading.
 */
export function airQualityLevel(aqi: ProtectAirQualityMetric): number {

  if(!airQualityMetricReported(aqi)) {

    return AIR_QUALITY_LEVELS.unknown;
  }

  if(aqi.value <= 50) {

    return AIR_QUALITY_LEVELS.excellent;
  }

  if(aqi.value <= 100) {

    return AIR_QUALITY_LEVELS.good;
  }

  if(aqi.value <= 150) {

    return AIR_QUALITY_LEVELS.fair;
  }

  if(aqi.value <= 200) {

    return AIR_QUALITY_LEVELS.inferior;
  }

  return AIR_QUALITY_LEVELS.poor;
}

/**
 * Decide whether a CO2 reading has crossed the alert threshold the user configured on the controller.
 *
 * The controller's own threshold is the single source of truth here: the user sets it in the Protect app, so HomeKit's alert should fire exactly when Protect's does
 * rather than at a second number we invent. The metric's own status field is deliberately unread - its vocabulary is unverified, so branching on it would encode a
 * guess - and lowThreshold is deliberately unread because a low CO2 reading is not an alarm condition. Revisit either only once the status vocabulary is enumerated
 * from field evidence.
 *
 * @param co2      - The sensor's co2 metric reading.
 * @param settings - The controller's co2 threshold settings.
 *
 * @returns true when HomeKit should report an abnormal CO2 level.
 */
export function co2AlertDetected(co2: ProtectAirQualityMetric, settings: ProtectAirQualityThresholdSettings): boolean {

  return settings.isEnabled && (settings.highThreshold !== null) && airQualityMetricReported(co2) && (co2.value > settings.highThreshold);
}

/**
 * Decide whether a vape reading counts as a detection.
 *
 * This reads the status ALONE. The controller's full vocabulary for this metric is undocumented - only "neutral" and "unknown" have been observed on the wire - so
 * anything beyond those two is read as a detection, erring toward alerting on a surface that is opt-in and off by default. Reading the status alone also means a
 * reading that carries a number under an "unknown" status never detects, and a detection-class status with no number still does. The raw status always rides the
 * air-quality MQTT topic, so a user who sees a spurious detection can name the status that caused it.
 *
 * @param vape - The sensor's vape metric reading.
 *
 * @returns true when the sensor is reporting vaping.
 */
export function vapeDetected(vape: ProtectAirQualityMetric): boolean {

  return (vape.status !== NOT_CAPABLE_METRIC.status) && (vape.status !== "neutral");
}

/**
 * Decide whether a block of readings can support the HomeKit air quality service: any of the metrics HomeKit models - the index and the three densities - is reporting.
 *
 * @param airQuality - The sensor's air-quality readings.
 *
 * @returns true when the sensor reports at least one metric the air quality service can show.
 */
export function airQualitySensorCapable(airQuality: ProtectSensorAirQuality): boolean {

  return SENSOR_SERVICE_METRICS.some((metric) => airQualityMetricLive(airQuality[metric]));
}

/**
 * Decide whether a block of readings is worth publishing: any metric at all is reporting.
 *
 * Broader than {@link airQualitySensorCapable} on purpose - MQTT carries the full-fidelity telemetry, including the metrics HomeKit has no service for - so a sensor
 * that reports only, say, particulate counts HomeKit cannot show still publishes, while a sensor with no air-quality hardware publishes nothing at all.
 *
 * @param airQuality - The sensor's air-quality readings.
 *
 * @returns true when the sensor reports at least one air-quality metric.
 */
export function airQualityReporting(airQuality: ProtectSensorAirQuality): boolean {

  return AIR_QUALITY_METRICS.some((metric) => airQualityMetricLive(airQuality[metric]));
}

/**
 * Choose the reading a sensor's temperature or humidity service should show, from the two places the controller reports those measurements.
 *
 * The stats block is consulted first because it is the source the UP Sense and USL-Environmental families report through, alongside the per-metric threshold toggle a
 * user sets on the controller. The air-quality block is the fallback, and it is what lights up UP Air Quality hardware: that hardware reports temperature and humidity
 * as part of its air-quality telemetry and leaves the stats block at the not-capable signature. Every field bootstrap and controller-wide probe we have shows the two
 * sources disjoint by hardware - no sensor reports through both - so the ordering here is a stable tiebreak rather than a contest between live values.
 *
 * An options object rather than two positional parameters, because both members are the same metric type: a swapped pair would compile silently and invert the
 * precedence, which no test of a disjoint fleet would catch.
 *
 * @param options - metric: this measurement's reading from the air-quality block; stat: this measurement's reading from the stats block, absent on hardware that
 *                  populates no stats at all.
 *
 * @returns The reading to show, or null when neither source is reporting - which the caller answers by holding whatever HomeKit already shows.
 */
export function environmentalReading(options: { metric: ProtectAirQualityMetric; stat: ProtectAirQualityMetric | undefined }): Nullable<number> {

  return options.stat?.value ?? options.metric.value;
}

/**
 * Decide whether a capability-driven sensor service should exist right now. This is the one lifecycle rule the air quality, carbon dioxide, temperature, and humidity
 * services all share, so every sibling gives the same answer to the same lifecycle event.
 *
 * Three ways a service earns its place, each sufficient on its own:
 *
 * A Protect-side toggle. The temperature and humidity services answer to the user's top-level threshold toggles, so an enabled toggle carries the service whether or
 * not a reading has arrived yet, and turning it off in the Protect app takes the service away on the next patch. Those two are the only callers with such a toggle -
 * the air quality and carbon dioxide services omit the member - so a toggle can never be wired onto a service that must not have one.
 *
 * A reporting capability. On air-quality hardware a live measurement materializes the service with no toggle at all. The two signals are independent, and disjoint by
 * hardware in all the evidence we have, so neither is required to be present for the other to work.
 *
 * An existing service while the device is UNREACHABLE. An offline device's quiet readings carry no user intent, so a controller outage or a battery sensor dropping
 * off holds every service it already had rather than churning the accessory's configuration. This is the service-level form of the same asymmetry the presence-driven
 * characteristics apply one level down.
 *
 * While the device IS reachable, a measurement reading the not-capable signature sheds its service on that pass. That signature is how the controller reports a
 * measurement the user turned off in the Protect app - or one the hardware cannot make, which the wire does not tell apart and this gate does not need to - so
 * shedding on it is what reconciles a Protect-side enable or disable into HomeKit within a patch or two, in both directions. It is also what lets a service restored
 * from the accessory cache onto hardware that never reports go away on the first pass, with no feature option needed to clean it up.
 *
 * Why not homebridge-plugin-utils' capabilityGate: its hold on an existing service is unconditional under a true toggle, which would pin a toggled-off service in
 * place, keep a stale cached service through anything, and leave a user-disabled measurement's service standing forever.
 *
 * @param options - capability: whether the measurement behind this service is reporting; enabled: the Protect-side toggle, where the service has one; hasService:
 *                  whether the accessory already carries the service; isReachable: whether we can currently see the device.
 *
 * @returns true when the service should exist.
 */
export function environmentalServiceGate(options: { capability: boolean; enabled?: boolean; hasService: boolean; isReachable: boolean }): boolean {

  return (options.enabled ?? false) || options.capability || (options.hasService && !options.isReachable);
}
