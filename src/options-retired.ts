/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * options-retired.ts: Protect's retired feature option families, declared as data over HBPU's translation, with the plate list rewrite and the settings page's
 * migration envelope beside them.
 */
import type { Nullable, RetiredController, RetiredFamily, RetiredMigration, RetiredOptions, RetiredTranslation } from "homebridge-plugin-utils";
import { SMART_DETECT_TYPES, STREAM_QUALITY_TIERS, featureOptionCategories, featureOptions } from "./options.ts";
import { createRetiredOptions, formatValueList, isValidScopeId, sameEntries } from "homebridge-plugin-utils";
import { USL_FOB_BUTTONS } from "./devices/fob-buttons.ts";

/* The relay outputs the retired per-output options covered. The catalog enumerated exactly these two, so an output beyond them had no option of its own and resolved
 * hidden - which is why the retired entries can only ever SUBTRACT from a relay's live output list, never name one the catalog never knew.
 */
const RETIRED_RELAY_OUTPUTS: readonly string[] = [ "1", "2" ];

// The detection types the retired per-type occupancy options defaulted ON. Every other type defaulted off, and those defaults are what a composition resolves against
// wherever a configuration says nothing.
const RETIRED_OCCUPANCY_DEFAULTS: ReadonlySet<string> = new Set([ "Face", "Person" ]);

/* The retired families, in the order their compositions are emitted and the startup narration names their entries, so a translated configuration reads the same
 * way run to run.
 *
 * The relay family is overlay-only because a relay's output count lives on the device, not in the configuration. Stating what a per-output subtraction leaves
 * standing takes the relay's live output list, so its retired entries stay in the boot view exactly as written, as entries for options the catalog does not
 * declare and the engine acts on none of, and the overlay gives them their meaning over each relay's own outputs.
 */
const RETIRED_FAMILIES: readonly RetiredFamily[] = [

  { members: USL_FOB_BUTTONS.map((button) => ({ default: true, option: "Fob.Button." + button.label, value: button.wireId })), option: "Fob.Buttons" },
  { keptName: true, members: [], option: "Motion.SmartDetect.ObjectSensors" },
  { keptName: true, members: SMART_DETECT_TYPES.map((type) => ({ default: RETIRED_OCCUPANCY_DEFAULTS.has(type.name), option: "Motion.OccupancySensor." + type.name,
    value: type.value })), option: "Motion.OccupancySensor" },
  { members: RETIRED_RELAY_OUTPUTS.map((output) => ({ default: true, option: "Relay.Output." + output, value: output })), option: "Relay.Outputs", overlayOnly: true },
  { members: STREAM_QUALITY_TIERS.map((entry) => ({ default: false, option: "Video.Rtsp.Only." + entry.choice, value: entry.choice })), option: "Video.Rtsp.Only" },
  { members: STREAM_QUALITY_TIERS.map((entry) => ({ default: false, option: "Video.Timeshift.Only." + entry.choice, value: entry.choice })),
    option: "Video.Timeshift.Only" }
];

// The translation over Protect's catalog, built once at module load, where HBPU refuses a family that cannot mean what it says before any configuration is read.
const retired = createRetiredOptions({ categories: featureOptionCategories, families: RETIRED_FAMILIES, options: featureOptions });

// The option whose value carried the retired plate grammar.
const PLATE_LIST_OPTION = "Motion.SmartDetect.ObjectSensors.LicensePlate";

/* Rewrite a plate list stored in the retired hyphen grammar into the shared comma grammar, or answer null when the value needs no rewrite.
 *
 * Plates are the one retired grammar that lived inside a VALUE rather than in option names: the list separated its entries with hyphens. Under that grammar a plate
 * could never itself contain a hyphen, so a value carrying one and no comma is unambiguously a hyphen-separated list and the rewrite is exact by construction. A value
 * already carrying a comma speaks the current grammar and is left exactly as the user wrote it.
 *
 * @param value - The stored value text.
 *
 * @returns The value in the shared list grammar, or null when it is already in it.
 */
function rewritePlateValue(value: string): Nullable<string> {

  if(!value.includes("-") || value.includes(",")) {

    return null;
  }

  return formatValueList(value.split("-").filter((plate) => plate.length));
}

/* Rewrite one configured entry carrying a retired plate list, or answer null when the entry carries none.
 *
 * Both spellings the engine accepts are read here, because a configuration can carry either: the canonical form, where the payload delimiter ends the address, and the
 * retired dot form, where a single trailing segment is the global value and a longer tail is a scope identifier followed by it. Whichever it was written in, the result
 * is the canonical form with the value re-composed - the prefix and the scope survive exactly, so the entry keeps addressing what it always addressed.
 *
 * Only an Enable entry is read at all. The engine's own parser short-circuits every Disable before it extracts a value, so a Disable addressing this option carries no
 * value to rewrite and passes through as the user's own text.
 *
 * @param entry - The raw configured-options entry.
 *
 * @returns The rewritten entry, or null when the entry carries no retired plate list.
 */
function rewritePlateEntry(entry: string): Nullable<string> {

  const prefix = "Enable." + PLATE_LIST_OPTION;

  if(!entry.toLowerCase().startsWith(prefix.toLowerCase())) {

    return null;
  }

  const head = entry.slice(0, prefix.length);
  const remainder = entry.slice(prefix.length);
  const payloadIndex = remainder.indexOf("=");

  if(payloadIndex !== -1) {

    const address = remainder.slice(0, payloadIndex);

    // The address is the option alone, or the option plus one legal scope segment. Anything else is a shape this rewrite has no reading for.
    if(address.length && !(address.startsWith(".") && isValidScopeId(address.slice(1)))) {

      return null;
    }

    const rewritten = rewritePlateValue(remainder.slice(payloadIndex + 1));

    return (rewritten === null) ? null : (head + address + "=" + rewritten);
  }

  if(!remainder.startsWith(".")) {

    return null;
  }

  const tail = remainder.slice(1);
  const separatorIndex = tail.indexOf(".");
  const scope = (separatorIndex === -1) ? "" : tail.slice(0, separatorIndex);

  if(scope.length && !isValidScopeId(scope)) {

    return null;
  }

  const rewritten = rewritePlateValue((separatorIndex === -1) ? tail : tail.slice(separatorIndex + 1));

  return (rewritten === null) ? null : (head + (scope.length ? ("." + scope) : "") + "=" + rewritten);
}

/* Re-compose every retired plate list in a configuration in place, answering the configuration and the original entries that carried one, or the input array itself
 * when none did. A plate list addresses an option the catalog still declares, so nothing is composed for it and nothing is dropped. It is the one retired grammar
 * that lives inside a value rather than in option names, which is why it is rewritten here rather than declared as a family. HBPU reads a plate entry as the
 * user's own text in either spelling, so the order the passes run in matters to the startup narration alone, which names the plate entries first.
 */
function rewritePlates(configuredOptions: readonly string[]): { configuredOptions: readonly string[]; rewritten: readonly string[] } {

  const plated: string[] = [];
  const rewritten: string[] = [];

  for(const entry of configuredOptions) {

    const plates = rewritePlateEntry(entry);

    plated.push(plates ?? entry);

    if(plates !== null) {

      rewritten.push(entry);
    }
  }

  return { configuredOptions: rewritten.length ? plated : configuredOptions, rewritten };
}

/**
 * Read a configuration written for any version of this plugin and answer what the current engine should be built on, with the overlay a reader holding its own
 * device and controller consults before the engine.
 *
 * Retired plate lists re-compose in place first, and HBPU's translation then composes the families, so every surviving entry keeps its position with the
 * compositions after them, and the entries named for the startup narration list the plate entries ahead of the families' own.
 *
 * @param configuredOptions - The configured feature options, exactly as they appear in the configuration.
 *
 * @returns The boot view, the overlay, and the entries the translation acted on.
 */
export function translateRetiredOptions(configuredOptions: readonly string[]): RetiredTranslation {

  const plates = rewritePlates(configuredOptions);
  const translation = retired.translate(plates.configuredOptions);

  if(!plates.rewritten.length) {

    return translation;
  }

  return { ...translation, translated: [ ...plates.rewritten, ...translation.translated ] };
}

// The durable migration.

/* The patch the settings page's own property migration produces, and the envelope this module composes into. The options array is present only when that migration
 * rewrote one - a controllers-only patch is a live shape and carries no options key at all, which is why every reader here tests for the KEY rather than for the patch.
 */
export interface MigrationPatch {

  readonly options?: readonly string[];
  readonly [key: string]: unknown;
}

/**
 * Rewrite a configuration's retired feature option entries into the current grammar, permanently, as far as the supplied topology makes exact.
 *
 * This is the same translation the platform performs in memory on every boot, with the one thing that pass cannot have: the topology. Retired plate lists
 * re-compose in place first, exact wherever they are found, and HBPU's rewrite then composes each family through the controllers that answered this pass.
 *
 * The controllers default to an empty list rather than staying omitted, because HBPU reads an omitted list as a plugin with no controller level and would compose a
 * device scope against the global level alone. Every Protect device sits beneath a controller, so a pass with no topology places no scope: a family naming one keeps
 * its entries exactly as written and reports itself remaining, while a family whose scopes are all global migrates exactly.
 *
 * @param args
 * @param args.configuredOptions - The configured feature options to rewrite.
 * @param args.controllers       - Optional. The controllers that answered this pass, each with the devices beneath it. Omit it for the topology-free pass.
 *
 * @returns The rewritten options and whether any family still waits for a wider topology.
 */
export function migrateRetiredOptions({ configuredOptions, controllers = [] }: Parameters<RetiredOptions["migrate"]>[0]): RetiredMigration {

  return retired.migrate({ configuredOptions: rewritePlates(configuredOptions).configuredOptions, controllers });
}

/**
 * Compose the single patch a settings-page open should commit, or `null` when there is nothing to write.
 *
 * Two writers meet here and only one array can be written, so the composition is deliberately a sequence rather than a merge: the property migration produces its patch
 * first, and the feature-option translation runs over whatever that patch left standing. Which array that is turns on the PRESENCE OF THE OPTIONS KEY, never on the patch
 * object - a controllers-only patch is a live shape, and reading its absent key would hand the translation an empty array and erase the user's settings.
 *
 * A null property patch is the common case, not an exceptional one: virtually every existing installation finished that migration long ago. It must never be read as
 * "nothing to do", or the feature-option translation would never converge and the startup line promising it would be false.
 *
 * @param args
 * @param args.controllers     - The controllers that answered this pass, each with the devices beneath it. Omit it for the topology-free pass.
 * @param args.migratePatch    - The patch the property migration produced, or null when it produced none.
 * @param args.platformOptions - The configuration's own feature options, which the translation runs over when the patch carries no options key.
 *
 * @returns The patch to commit (or null), and whether any family still carries retired entries.
 */
export function composeMigrationPatch({ controllers, migratePatch, platformOptions }: { controllers?: readonly RetiredController[];
  migratePatch?: Nullable<MigrationPatch>; platformOptions?: readonly string[]; }): { patch: Nullable<MigrationPatch>; remaining: boolean } {

  const source = (migratePatch && ("options" in migratePatch) && Array.isArray(migratePatch.options)) ? migratePatch.options :
    (Array.isArray(platformOptions) ? platformOptions : []);
  const migration = migrateRetiredOptions({ configuredOptions: source, controllers });

  // Whether the translation says something the configured options do not, entry for entry, which is what decides whether a rewrite is worth committing at all.
  const translated = !sameEntries(source, migration.configuredOptions, (left, right) => left === right);

  if(!migratePatch && !translated) {

    return { patch: null, remaining: migration.remaining };
  }

  return { patch: translated ? { ...migratePatch, options: [...migration.configuredOptions] } : (migratePatch ?? null), remaining: migration.remaining };
}
