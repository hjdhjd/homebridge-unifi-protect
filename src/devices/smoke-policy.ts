/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * smoke-policy.ts: The pure smoke and carbon monoxide detection policy for UniFi Protect sensors.
 *
 * This module owns every decision the smoke surface makes about a sensor: whether the hardware detects a given alarm type at all, whether either alarm is sounding, and
 * which of the detector's fault flags stand against which of its services. It is deliberately pure - `this`-free and free of any device or controller I/O, wire facts
 * in and a boolean or a typed tag out, with no presentation text anywhere - so the sensor leaf's consumers (the service gates, the characteristic writers, the transition
 * logs, and the smoke MQTT registrations) import it without value-importing a non-leaf module (the device layer's module-structure rule), and each truth table is
 * exhaustively testable without standing up a sensor accessory.
 *
 * Why a leaf at all: several consumers ask different questions of one status block - the service gate asks whether the hardware exists, the detection characteristic and
 * its MQTT topic ask whether an alarm is sounding, StatusFault asks whether anything is wrong at all, and the warn line asks WHICH things are wrong. Answering those ad
 * hoc at each call site would let the gate, the log, and the topic disagree about what "detected" means, and would scatter the fault composition across the sensor leaf.
 *
 * The grounding, from a controller-wide probe of every sensor model: the status block is populated on units of several models and null on other units of those same
 * models, so its presence says nothing about whether a sensor has detector hardware. The alarm-type advertisement says no more on its own, because a unit that only
 * listens for alarm sounds advertises exactly the types a detector does. Hardware is therefore a model-family question, and the advertisement answers the separate
 * question of which alarms that hardware detects. The block itself always arrives whole, so a consumer holding one has every member it needs from the same read.
 */
import type { ProtectSensorSmokeStatus } from "unifi-protect";

/**
 * The alarm types a UniFi Protect sensor advertises in `featureFlags.alarmTypes`, spelled once. These are protocol markers on the wire, so no call site spells them:
 * every consumer names the type through this record and lets the leaf do the comparison.
 */
export const SMOKE_ALARM_TYPES = { carbonMonoxide: "CO", smoke: "smoke" } as const;

/**
 * One of the alarm types the smoke surface projects, derived from {@link SMOKE_ALARM_TYPES} so the union and the wire spellings cannot drift apart.
 */
export type SmokeAlarmType = (typeof SMOKE_ALARM_TYPES)[keyof typeof SMOKE_ALARM_TYPES];

/**
 * A fault flag a detector reports, as the typed tag this leaf hands back for the device layer to turn into display text. The set is spelled out rather than derived with
 * a `keyof` over the wire type, whose open index signature would widen it to every string.
 */
export type SmokeFaultReason = "cleanSmokeSensor" | "coSensorFault" | "endOfLife" | "smokeSensorFault";

// Which flags fault which service, and the order a fault sentence reads them in. The carbon monoxide sensor answers for its own sensor fault and for the detector
// reaching end of life; the smoke sensor answers for its own sensor fault, the same shared end of life, and a chamber that needs cleaning. Composing the reason lists
// from these tables rather than from branches makes this the single statement of the mapping, and adding a flag is one entry rather than an edit everywhere it is asked
// about.
const CARBON_MONOXIDE_FAULTS: readonly SmokeFaultReason[] = [ "coSensorFault", "endOfLife" ];
const SMOKE_FAULTS: readonly SmokeFaultReason[] = [ "smokeSensorFault", "endOfLife", "cleanSmokeSensor" ];

/**
 * Decide whether a sensor record is smoke detector hardware, by its model family.
 *
 * The model decides because neither of the other candidate signals can. A UP Sense listens for smoke and carbon monoxide alarm SOUNDS, so it advertises those same two
 * alarm types under the same smoke channel and reports a full, zeroed status block beside them, and its featureFlags are a superset of the detector's - nothing in the
 * flags says "detector". The model family is the one stable hardware fact the wire carries about what a unit physically is.
 *
 * Both spellings are read because both are how the wire names a model: marketName is the controller's display model and type is the family identifier. The type is
 * matched by its family prefix rather than by one geography's exact value, so every regional variant is admitted...the same two-term rule the fob identity uses.
 *
 * The parameter is structural with optional members because the wire type declares both fields required while the controller can omit either, so the parameter states
 * the runtime truth and keeps the optional chain honest to the type checker without a lint directive. A ProtectSensorConfig is accepted directly, its required members
 * being assignable to optional ones, which is how the sensor module calls it.
 *
 * @param config - The sensor record's model fields: the controller's display model and the family type, either of which the wire may omit.
 *
 * @returns true when the record is smoke detector hardware.
 */
export function smokeDetectorHardware(config: { readonly marketName?: string; readonly type?: string }): boolean {

  return (config.marketName === "USL Smoke") || (config.type?.startsWith("USL-Smoke-") ?? false);
}

/**
 * Decide whether a detector advertises a given alarm type.
 *
 * The controller lists what a unit detects in `featureFlags.alarmTypes`. This is the advertisement half of the two-part rule: it is asked of a unit
 * {@link smokeDetectorHardware} admits, and it names which of the two services that hardware carries. A detector advertising nothing at all detects nothing.
 *
 * @param alarmTypes - The alarm types the controller advertises for this sensor, or undefined when it advertises none.
 * @param alarmType  - The alarm type under consideration.
 *
 * @returns true when the sensor advertises this alarm type.
 */
export function smokeAlarmCapable(alarmTypes: readonly string[] | undefined, alarmType: SmokeAlarmType): boolean {

  return alarmTypes?.includes(alarmType) ?? false;
}

/**
 * Read a status block's carbon monoxide alarm state.
 *
 * @param status - The detector's status block.
 *
 * @returns true when the detector reports a carbon monoxide alarm.
 */
export function carbonMonoxideDetected(status: ProtectSensorSmokeStatus): boolean {

  return status.coAlarm;
}

/**
 * Read a status block's smoke alarm state.
 *
 * Named here rather than read inline so the characteristic's read-through, the reconcile's own write, the transition log, and the MQTT topic can never disagree on what
 * "detected" means, and so a later refinement - a real-alarm capture teaching us the latched timestamp must be consulted too - lands in one place.
 *
 * @param status - The detector's status block.
 *
 * @returns true when the detector reports a smoke alarm.
 */
export function smokeDetected(status: ProtectSensorSmokeStatus): boolean {

  return status.smokeAlarm;
}

/**
 * List the fault flags standing against the carbon monoxide sensor, in the order its fault table declares them.
 *
 * @param status - The detector's status block.
 *
 * @returns The set flags as typed tags, empty when the carbon monoxide sensor reports nothing wrong.
 */
export function carbonMonoxideFaultReasons(status: ProtectSensorSmokeStatus): SmokeFaultReason[] {

  return CARBON_MONOXIDE_FAULTS.filter((reason) => status[reason]);
}

/**
 * List the fault flags standing against the smoke sensor, in the order its fault table declares them.
 *
 * @param status - The detector's status block.
 *
 * @returns The set flags as typed tags, empty when the smoke sensor reports nothing wrong.
 */
export function smokeFaultReasons(status: ProtectSensorSmokeStatus): SmokeFaultReason[] {

  return SMOKE_FAULTS.filter((reason) => status[reason]);
}

/**
 * Decide whether the carbon monoxide sensor is faulted: any flag in its own table is set.
 *
 * Every consumer asking "is this service faulted" reads this rather than re-deriving the rule, so StatusFault and the warn line always agree.
 *
 * @param status - The detector's status block.
 *
 * @returns true when the carbon monoxide sensor reports at least one fault.
 */
export function carbonMonoxideFault(status: ProtectSensorSmokeStatus): boolean {

  return carbonMonoxideFaultReasons(status).length > 0;
}

/**
 * Decide whether the smoke sensor is faulted: any flag in its own table is set.
 *
 * Every consumer asking "is this service faulted" reads this rather than re-deriving the rule, so StatusFault and the warn line always agree.
 *
 * @param status - The detector's status block.
 *
 * @returns true when the smoke sensor reports at least one fault.
 */
export function smokeFault(status: ProtectSensorSmokeStatus): boolean {

  return smokeFaultReasons(status).length > 0;
}
