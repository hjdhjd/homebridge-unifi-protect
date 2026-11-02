/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * options-legacy.ts: Translation of retired per-member feature options into the selectable value options that carry them.
 */
import { ALL_CHOICES, buildCatalogIndex, buildConfigIndex, enumerateConfiguredEntries, formatValueList, isValidScopeId, resolveScope, sameEntries,
  selectValues } from "homebridge-plugin-utils";
import type { ConfigIndex, FeatureCategoryEntry, FeatureOptionEntry, Nullable } from "homebridge-plugin-utils";
import { SMART_DETECT_TYPES, STREAM_QUALITY_TIERS, featureOptionCategories, featureOptions } from "./options.ts";
import { USL_FOB_BUTTONS } from "./devices/fob-buttons.ts";

/* A family of retired feature options: one grammar the plugin used to spell a selection member by member, and the single value option that carries that selection
 * now. The families are named rather than enumerated from the catalog because the retired names are, by definition, no longer in it - this module is the only place
 * that still knows they existed.
 */
export type LegacyFamily = "fobButtons" | "objectSensors" | "occupancy" | "plates" | "relayOutputs" | "rtspPin" | "timeshiftPin";

// What the analysis of a configuration answers: the entries the engine should be built on, the families whose runtime reads still need the overlay, and the original
// entries the translation acted on.
export interface LegacyFeatureOptions {

  // The configured options with every engine-misread legacy shape rewritten into the canonical value grammar, order otherwise preserved - the engine's view.
  readonly engineOptions: readonly string[];

  // The families whose runtime selection must resolve through the overlay: raw legacy entries present, and no canonical value entry superseding them. An empty set is
  // the converged steady state, which is what makes a read on a migrated configuration cost one set-membership test.
  readonly families: ReadonlySet<LegacyFamily>;

  // The original legacy entries the translation rewrote, superseded, or overlaid, verbatim, for the startup narration. Empty when the configuration is already
  // canonical.
  readonly translated: readonly string[];
}

// One retired option, paired with the value its surviving option stores for it.
interface LegacyMember {

  // The retired option's expanded name, exactly as the synthetic catalog below declares it.
  readonly option: string;

  // The value the surviving option stores when this member is selected.
  readonly value: string;
}

// What one configured entry addresses, decoded through the synthetic catalog: a retired option, at a scope, in one enablement state.
interface LegacyAddress {

  readonly enabled: boolean;
  readonly option: string;
  readonly scope: string;
}

// What a retired option is to its family: one member of the selection, or the master whose name the surviving option kept.
interface LegacyRole {

  readonly family: LegacyFamily;
  readonly master: boolean;
}

/* The relay outputs the retired per-output options covered. The catalog enumerated exactly these two, so an output beyond them had no option of its own and resolved
 * hidden - which is why the retired entries can only ever SUBTRACT from a relay's live output list, never name one the catalog never knew.
 */
const LEGACY_RELAY_OUTPUTS: readonly string[] = [ "1", "2" ];

// The detection types the retired per-type occupancy options defaulted ON. Every other type defaulted off, and those defaults are what a composition resolves against
// wherever a configuration says nothing.
const LEGACY_OCCUPANCY_DEFAULTS: ReadonlySet<string> = new Set([ "Face", "Person" ]);

/* The synthetic legacy catalog: the old-grammar view of every family this module translates, declared as ordinary boolean options.
 *
 * Declaring the retired names is what lets the whole layer run on the engine's own primitives. `buildCatalogIndex` and `buildConfigIndex` read the user's raw
 * configuration exactly as production does, and `resolveScope` then answers any retired member's old effective state at any (device, controller) pair - so the
 * three-level precedence the engine has always owned keeps being owned by the engine, pointed at a catalog that describes the past. Nothing here reimplements
 * "device beats controller beats global beats default".
 *
 * Every entry is a plain boolean, with no default value. A boolean declaration never extracts a trailing segment as a value, so reading this catalog cannot
 * re-trigger the value registration the translation exists to remove...the analysis can ask what the old configuration meant without provoking the misreading it is
 * there to prevent.
 *
 * Two kinds of entry beyond the retired members earn their place here. A MASTER whose name the surviving option kept is declared so its own old effective state can
 * be resolved the same way everything else is. A SIBLING option sharing a master's name prefix is declared so the engine's own arbitration excludes it from any
 * scope reading: an entry addressing Motion.OccupancySensor.Duration is that option's entry, never the occupancy master scoped to an identifier called "Duration".
 */
const legacyCategories: readonly FeatureCategoryEntry[] = [

  { description: "Fob", name: "Fob" },
  { description: "Motion & Occupancy", name: "Motion" },
  { description: "Relay", name: "Relay" },
  { description: "Video & Streaming", name: "Video" },
  { description: "Timeshift Buffer", name: "Video.Timeshift" }
];

const legacyOptions: Readonly<Record<string, readonly FeatureOptionEntry[]>> = {

  "Fob": USL_FOB_BUTTONS.map((button) => ({ default: true, description: "Retired per-button fob visibility.", name: "Button." + button.label })),
  "Motion": [

    { default: false, description: "Retired occupancy master.", name: "OccupancySensor" },
    { default: true, description: "Occupancy duration, declared so it is never read as the master scoped to its own name.", name: "OccupancySensor.Duration" },
    ...SMART_DETECT_TYPES.map((type) => ({ default: LEGACY_OCCUPANCY_DEFAULTS.has(type.name), description: "Retired per-type occupancy trigger.",
      name: "OccupancySensor." + type.name })),
    { default: false, description: "Retired object-sensor master.", name: "SmartDetect.ObjectSensors" },
    { default: false, description: "The plate list, declared so it is never read as the object-sensor master scoped to its own name.",
      name: "SmartDetect.ObjectSensors.LicensePlate" }
  ],
  "Relay": LEGACY_RELAY_OUTPUTS.map((output) => ({ default: true, description: "Retired per-output relay visibility.", name: "Output." + output })),
  "Video": STREAM_QUALITY_TIERS.map((entry) => ({ default: false, description: "Retired direct-RTSP channel pin.", name: "Rtsp.Only." + entry.choice })),
  "Video.Timeshift": STREAM_QUALITY_TIERS.map((entry) => ({ default: false, description: "Retired timeshift channel pin.", name: "Only." + entry.choice }))
};

const legacyCatalog = buildCatalogIndex(legacyCategories, legacyOptions);

// The configured-options index of an empty configuration, which is what a family's untouched default composition resolves through. Built once, since it never varies.
const defaultConfigIndex = buildConfigIndex(legacyCatalog, []);

/* The live catalog, consulted for exactly one question: has the user already written a canonical value for a family's surviving option? That is a question about the
 * current grammar, and the synthetic catalog above cannot answer it - its entries are boolean-shaped, so a payload-carrying entry never decomposes there at all.
 */
const currentCatalog = buildCatalogIndex(featureOptionCategories, featureOptions);

// The retired options of each family, paired with the value the surviving option stores for each. Order carries meaning for a single-select family: the first member
// a configuration enables is the one that wins, which for the channel pins is the descending-quality rule the retired per-tier options resolved through.
const FAMILY_MEMBERS: Readonly<Record<LegacyFamily, readonly LegacyMember[]>> = {

  fobButtons: USL_FOB_BUTTONS.map((button) => ({ option: "Fob.Button." + button.label, value: button.wireId })),
  objectSensors: [],
  occupancy: SMART_DETECT_TYPES.map((type) => ({ option: "Motion.OccupancySensor." + type.name, value: type.value })),
  plates: [],
  relayOutputs: LEGACY_RELAY_OUTPUTS.map((output) => ({ option: "Relay.Output." + output, value: output })),
  rtspPin: STREAM_QUALITY_TIERS.map((entry) => ({ option: "Video.Rtsp.Only." + entry.choice, value: entry.choice })),
  timeshiftPin: STREAM_QUALITY_TIERS.map((entry) => ({ option: "Video.Timeshift.Only." + entry.choice, value: entry.choice }))
};

// The option each family's members were folded into: what the runtime reads, what the translation emits, and what the supersede test watches for a canonical value.
const FAMILY_OPTION: Readonly<Record<LegacyFamily, string>> = {

  fobButtons: "Fob.Buttons",
  objectSensors: "Motion.SmartDetect.ObjectSensors",
  occupancy: "Motion.OccupancySensor",
  plates: "Motion.SmartDetect.ObjectSensors.LicensePlate",
  relayOutputs: "Relay.Outputs",
  rtspPin: "Video.Rtsp.Only",
  timeshiftPin: "Video.Timeshift.Only"
};

/* The families whose surviving option KEPT the name a retired master carried, so a retired master's scoped entry spells the same as an entry of the current option. The
 * current catalog reads the trailing segment of `Enable.Motion.OccupancySensor.<identifier>` as the scope it names, because an option declaring its choices keeps a bare
 * segment a scoped enable. Those entries are rewritten into the canonical scoped form, which says what the user meant in the one spelling every reader shares. A family
 * whose surviving option took a new name shares no spelling with its retired master and needs no rewrite.
 */
const KEPT_NAME_FAMILIES: ReadonlySet<LegacyFamily> = new Set<LegacyFamily>([ "objectSensors", "occupancy" ]);

/* The families whose retired enable meant EVERY member of whatever domain the device offers, rather than a list the configuration spelled out. Switching the object
 * sensors on created a contact sensor for each detection type a camera delivered, and the all-choices value is the current grammar's way of saying exactly that -
 * which is why this family's rewrite is exact and needs no overlay behind it.
 */
const ALL_MEMBERS_FAMILIES: ReadonlySet<LegacyFamily> = new Set<LegacyFamily>(["objectSensors"]);

/* The families whose retired entries stay in the engine's view exactly as written. A relay's retired entries are per-output subtractions, and stating what they leave
 * standing takes the live output list - a configuration string does not carry how many outputs a relay has. Leaving them alone costs nothing: they address names the
 * current catalog no longer declares, and because the surviving option took a NEW name rather than keeping a prefix of theirs, the engine reads them as entries for an
 * option it does not know and acts on none of them. The runtime overlay is what gives them their exact historic meaning, over each relay's own outputs.
 */
const PASS_THROUGH_FAMILIES: ReadonlySet<LegacyFamily> = new Set<LegacyFamily>(["relayOutputs"]);

// The families whose surviving option holds a single value rather than a list. A single-select composes to the first member a configuration enables; a list composes
// to every one of them.
const SINGLE_SELECT_FAMILIES: ReadonlySet<LegacyFamily> = new Set<LegacyFamily>([ "rtspPin", "timeshiftPin" ]);

// Every family, in a stable order, so the analysis and its narration read the same way run to run. The keys are read off the member table rather than listed a second
// time, so a family added there cannot be missed here; the assertion states what the table's own declared key type already guarantees.
const LEGACY_FAMILIES = Object.keys(FAMILY_MEMBERS) as readonly LegacyFamily[];

// The reverse of FAMILY_OPTION, so a runtime read that knows only the option name can ask which retired family it carries. Derived from the same table, so the two
// directions cannot disagree.
const OPTION_FAMILY: ReadonlyMap<string, LegacyFamily> = new Map(LEGACY_FAMILIES.map((family) => [ FAMILY_OPTION[family].toLowerCase(), family ]));

// Every retired option this module knows, mapped to the family it belongs to and what it is to that family. One registry, so decoding an entry and composing a family
// read the same table rather than two lists that could fall out of step.
const OPTION_ROLES = ((): ReadonlyMap<string, LegacyRole> => {

  const roles = new Map<string, LegacyRole>();

  for(const family of LEGACY_FAMILIES) {

    for(const member of FAMILY_MEMBERS[family]) {

      roles.set(member.option.toLowerCase(), { family, master: false });
    }

    if(KEPT_NAME_FAMILIES.has(family)) {

      roles.set(FAMILY_OPTION[family].toLowerCase(), { family, master: true });
    }
  }

  return roles;
})();

/* The configured-options index for one configuration, memoized on the array itself. Homebridge hands a plugin one configured-options array for the life of the
 * process, so an overlay read costs one index build per boot rather than one per read. Identity is the whole of the key, so there is no staleness surface: a caller
 * handing over a different array gets that array's own index, and the array the platform holds never changes underneath us.
 */
const configIndexes = new WeakMap<readonly string[], ConfigIndex>();

function legacyConfigIndex(options: readonly string[]): ConfigIndex {

  const existing = configIndexes.get(options);

  if(existing) {

    return existing;
  }

  const built = buildConfigIndex(legacyCatalog, options);

  configIndexes.set(options, built);

  return built;
}

/* Decode one configured entry as an address of a retired option, or answer null when it addresses none.
 *
 * The rules are the engine's own, read from the address side: an entry opens with an Enable or Disable action, everything after it is the address, an address that is
 * itself a declared option names that option at the global scope, and an address that extends a declared option by one legal scope segment names that option at that
 * scope. Testing the whole address against the catalog first is what keeps a sibling option from reading as its neighbor scoped to the sibling's own name - the same
 * arbitration the engine applies when it decides which option a dotted address belongs to.
 *
 * An entry carrying the payload delimiter addresses nothing here: no retired option ever carried a payload, so a delimiter marks the current grammar and the entry is
 * the user's own canonical text.
 *
 * @param entry - The raw configured-options entry.
 *
 * @returns What the entry addresses, or null when it addresses no retired option.
 */
function decodeLegacyAddress(entry: string): Nullable<LegacyAddress> {

  const dotIndex = entry.indexOf(".");

  if(dotIndex === -1) {

    return null;
  }

  const action = entry.slice(0, dotIndex).toLowerCase();

  if((action !== "enable") && (action !== "disable")) {

    return null;
  }

  const tail = entry.slice(dotIndex + 1);
  const tailLower = tail.toLowerCase();

  if(tailLower.includes("=")) {

    return null;
  }

  const enabled = action === "enable";

  if(tailLower in legacyCatalog.defaults) {

    return { enabled, option: tailLower, scope: "" };
  }

  const separatorIndex = tailLower.lastIndexOf(".");

  if(separatorIndex === -1) {

    return null;
  }

  const option = tailLower.slice(0, separatorIndex);
  const scope = tail.slice(separatorIndex + 1);

  return ((option in legacyCatalog.defaults) && isValidScopeId(scope)) ? { enabled, option, scope } : null;
}

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

  const prefix = "Enable." + FAMILY_OPTION.plates;

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

/* Compose one family's selection at a scope, by asking the engine for each retired member's old effective state there.
 *
 * The caller decides what "there" means. The runtime overlay passes the reader's real device and controller, which is the exact three-level resolution the old
 * per-member reads performed. The in-memory rewrite passes a single scope identifier as the device level, because a configuration string cannot say whether an
 * identifier names a device or a controller; the walk then reads that scope and the global level beneath it, which is the pair a rewrite can compose without
 * topology.
 *
 * @param args
 * @param args.configIndex - The configured-options index over the raw configuration.
 * @param args.controller  - Optional controller scope identifier.
 * @param args.device      - Optional device scope identifier.
 * @param args.family      - The family to compose.
 *
 * @returns The values the family's surviving option would store for that selection, in table order.
 */
function composeFamily({ configIndex, controller, device, family }: { configIndex: ConfigIndex; controller?: string; device?: string; family: LegacyFamily }): string[] {

  const selected: string[] = [];

  for(const member of FAMILY_MEMBERS[family]) {

    if(!resolveScope({ catalog: legacyCatalog, configIndex, controller, device, option: member.option }).enabled) {

      continue;
    }

    selected.push(member.value);

    if(SINGLE_SELECT_FAMILIES.has(family)) {

      break;
    }
  }

  return selected;
}

// Whether a family's retired master option resolved enabled at a scope, which for a kept-name family decides whether that scope's selection was ever live. The scope
// identifier goes in at the device level for the same reason the composition's does: a configuration string cannot say whether an identifier names a device.
function masterEnabled({ configIndex, controller, family, scope }: { configIndex: ConfigIndex; controller?: string; family: LegacyFamily; scope: string }): boolean {

  return resolveScope({ catalog: legacyCatalog, configIndex, controller, device: scope.length ? scope : undefined, option: FAMILY_OPTION[family] }).enabled;
}

/* Compose the canonical entry that states a family's selection at one scope, or answer null when the scope has nothing of its own to say.
 *
 * For a family whose surviving option took a new name, a scope earns an entry exactly when its composed selection differs from what it would inherit without one: the
 * global scope against the catalog's own defaults, a named scope against the global composition. That single test is what keeps the rewrite minimal and exact at once
 * - a scope merely restating what it already inherits emits nothing, and a scope that turns off everything a broader scope turned on emits the plain Disable.
 *
 * A KEPT-NAME family reads differently, because its entries carry an enablement as well as a selection. A scope where the master resolved enabled states its
 * selection outright, empty payload included - that spelling is the explicit empty selection, and it is what a configuration that had every type switched off with
 * occupancy still on has always meant. A scope where the master resolved disabled states nothing at all: the entry that disabled it is not one this translation
 * touches, so it is still there saying so, and the selection under it was never live. The retired entries at such a scope are dropped, and the startup narration
 * names them.
 *
 * The controller is supplied only by a pass that KNOWS the topology: with it, a device scope composes and inherits through its true hierarchy rather than through the
 * scope-plus-global approximation a bare configuration string admits. Without it, both readings fall back to that approximation, which is exactly what the in-memory
 * rewrite can offer and why the runtime overlay carries the exact answer instead.
 *
 * @param args
 * @param args.configIndex - The configured-options index over the raw configuration.
 * @param args.controller  - Optional controller the scope sits under.
 * @param args.family      - The family to state.
 * @param args.scope       - The scope identifier, empty for the global scope.
 *
 * @returns The canonical entry, or null when the scope needs none.
 */
function composeEmission(args: { configIndex: ConfigIndex; controller?: string; family: LegacyFamily; scope: string }): Nullable<string> {

  const { configIndex, controller, family, scope } = args;

  const here = composeFamily({ configIndex, controller, device: scope.length ? scope : undefined, family });
  const address = FAMILY_OPTION[family] + (scope.length ? ("." + scope) : "");

  if(KEPT_NAME_FAMILIES.has(family)) {

    const payload = ALL_MEMBERS_FAMILIES.has(family) ? ALL_CHOICES : formatValueList(here);

    return masterEnabled({ configIndex, controller, family, scope }) ? ("Enable." + address + "=" + payload) : null;
  }

  const inherited = scope.length ? composeFamily({ configIndex, controller, family }) : composeFamily({ configIndex: defaultConfigIndex, family });

  if(sameEntries(here, inherited, (left, right) => left === right)) {

    return null;
  }

  if(!here.length) {

    return "Disable." + address;
  }

  // The list grammar composes the payload for every family alike. A single-select composition is one member long by construction, so the join hands back that member
  // unchanged and there is no second spelling of the stored form to keep in step.
  return "Enable." + address + "=" + formatValueList(here);
}

/* Whether the user has already written a canonical value for a family's surviving option, at any scope, which is the evidence that they have adopted the current
 * grammar and that the retired entries beside it are leftovers rather than live settings.
 *
 * Only entries carrying the payload delimiter are read, and that restriction is the whole of what makes the test honest. The retired dot forms also decompose into
 * values against the live catalog - a retired per-member entry can register its member name as the surviving option's value - so a test that accepted every value
 * reading would call the ordinary legacy configuration superseded and discard the user's settings. A bare enable or disable of the surviving option's own name
 * carries no value at all, spells the same thing in both eras, and is deliberately not evidence either.
 *
 * @param args
 * @param args.canonicalOptions - The configured entries carrying a payload delimiter.
 * @param args.family           - The family to test.
 *
 * @returns True when a canonical value for the family's option is configured somewhere.
 */
function isSuperseded({ canonicalOptions, family }: { canonicalOptions: readonly string[]; family: LegacyFamily }): boolean {

  for(const entry of enumerateConfiguredEntries({ catalog: currentCatalog, configuredOptions: canonicalOptions, option: FAMILY_OPTION[family] })) {

    if(entry.value !== undefined) {

      return true;
    }
  }

  return false;
}

/**
 * Read a configuration written for any version of this plugin and answer what the current engine should be built on.
 *
 * A configuration can carry entries naming options the catalog no longer declares, and several of those shapes are not merely stale: read through the current
 * catalog they decompose into values of the very options that superseded them, so the engine would act on a reading the user never wrote. The analysis rewrites every
 * such shape into the canonical grammar before the engine sees it, and reports which families still need the runtime overlay for their exact historic meaning. An
 * entry it cannot account for passes through byte-verbatim, because a configuration file is the user's own text.
 *
 * @param options - The configured feature options, exactly as they appear in the configuration.
 *
 * @returns The engine's view of the configuration, the families needing the overlay, and the entries the translation acted on.
 */
export function analyzeLegacyFeatureOptions(options: readonly string[]): LegacyFeatureOptions {

  const configIndex = legacyConfigIndex(options);
  const canonicalOptions = options.filter((entry) => entry.includes("="));
  const consumed = new Set<number>();
  const emissions: string[] = [];
  const families = new Set<LegacyFamily>();
  const rewrites = new Map<number, string>();
  const translated: string[] = [];

  // The retired entries each family carries, in configuration order, decoded once so every pass below reads the same decoding.
  const addressed = new Map<LegacyFamily, { address: LegacyAddress; index: number; raw: string; role: LegacyRole }[]>();

  for(const [ index, raw ] of options.entries()) {

    // A retired plate list is rewritten in place: it addresses an option the catalog still declares, so nothing is composed for it and nothing is dropped.
    const plates = rewritePlateEntry(raw);

    if(plates !== null) {

      rewrites.set(index, plates);
      translated.push(raw);

      continue;
    }

    const address = decodeLegacyAddress(raw);
    const role = address ? OPTION_ROLES.get(address.option) : undefined;

    if(!address || !role) {

      continue;
    }

    const found = addressed.get(role.family) ?? [];

    found.push({ address, index, raw, role });
    addressed.set(role.family, found);
  }

  for(const family of LEGACY_FAMILIES) {

    const found = addressed.get(family) ?? [];

    /* The scopes this family has something to say at. A scope with retired MEMBER entries always qualifies, since that is the selection to be composed. A scope
     * carrying a bare ENABLE of a kept-name master qualifies too, even with no member entries of its own: that entry is the corrupting shape, and rewriting it into
     * the canonical scoped form is what removes the global reading the current catalog would otherwise take from it. A master entry at the GLOBAL scope is not on
     * this list - it spells the same thing in both eras - so it stands untouched unless a member entry brings the global scope in anyway.
     */
    const scopes = new Set(found.filter(({ address, role }) => !role.master || (address.enabled && address.scope.length)).map(({ address }) => address.scope));

    if(!scopes.size) {

      continue;
    }

    /* Every entry this family contributes leaves the engine's view, whatever happens next: superseded or translated, its shape is one the current catalog misreads.
     * A master entry leaves only where its own scope is being restated, because that is the only place a replacement is composed for it - a Disable is never
     * consumed, since nothing this translation emits could say what it says.
     */
    const passThrough = PASS_THROUGH_FAMILIES.has(family);

    for(const { address, index, raw, role } of found) {

      if(role.master && !(address.enabled && scopes.has(address.scope))) {

        continue;
      }

      if(!passThrough) {

        consumed.add(index);
      }

      translated.push(raw);
    }

    // A canonical value the user wrote outranks the retired entries outright, so the family neither emits a composition nor joins the overlay.
    if(isSuperseded({ canonicalOptions, family })) {

      continue;
    }

    /* A family needs the overlay exactly when it HAS retired members: their composition is what a rewrite can only approximate, since a configuration string cannot
     * say which identifiers name controllers. A family with no members has nothing to compose - its one rewrite states the whole of what the retired entry meant - so
     * its post-translation reading is already the truth and the overlay would have nothing to add.
     */
    if(FAMILY_MEMBERS[family].length) {

      families.add(family);
    }

    // A pass-through family composes nothing: its entries stay where they are, and the overlay above is the whole of how they reach the runtime.
    if(passThrough) {

      continue;
    }

    for(const scope of scopes) {

      const emission = composeEmission({ configIndex, family, scope });

      if(emission) {

        emissions.push(emission);
      }
    }
  }

  const engineOptions = options.flatMap((entry, index) => consumed.has(index) ? [] : [rewrites.get(index) ?? entry]).concat(emissions);

  return { engineOptions, families, translated };
}

/**
 * Return the retired family a feature option carries, or null when the option supersedes none.
 *
 * Every runtime read routes its overlay question through this one lookup, so the option a consumer names and the family the analysis tracked are joined in a single
 * table rather than at each call site.
 *
 * @param option - The feature option name, matched without regard to casing.
 *
 * @returns The family the option carries, or null.
 */
export function legacyFamilyForOption(option: string): Nullable<LegacyFamily> {

  return OPTION_FAMILY.get(option.toLowerCase()) ?? null;
}

/**
 * Resolve one family's selection the way the retired per-member options resolved it, for a reader that knows its own device and controller.
 *
 * This is the runtime overlay, and the topology is what makes it exact where the in-memory rewrite can only approximate: the reader supplies the real device and
 * controller identifiers, so the engine's own three-level walk over the synthetic catalog answers precisely what the old per-member reads answered. Every consumer
 * routes through this one function; nothing else re-derives the old precedence.
 *
 * @param args
 * @param args.controller - Optional controller scope identifier.
 * @param args.device     - Optional device scope identifier.
 * @param args.domain     - The values the option offers in this context, which the answer is expressed in.
 * @param args.family     - The family to resolve.
 * @param args.options    - The configured feature options, exactly as they appear in the configuration.
 *
 * @returns The selected values, in the domain's own spelling and order.
 */
export function resolveLegacySelection({ controller, device, domain, family, options }: { controller?: string; device?: string; domain: readonly string[];
  family: LegacyFamily; options: readonly string[]; }): readonly string[] {

  const selected = composeFamily({ configIndex: legacyConfigIndex(options), controller, device, family });

  return selectValues({ domain, multiple: true, value: formatValueList(selected) }).selected;
}

// The durable migration.

/* One device the settings page found on a controller, as the migration needs to see it. Only the identifier matters: what the migration takes from the topology is the
 * ability to say which controller a scope identifier sits under, which is the whole of what makes its composition exact.
 */
export interface LegacyTopologyDevice {

  readonly mac: string;
}

// One controller and the devices beneath it, as the settings page's own probes report them.
export interface LegacyTopologyController {

  readonly devices: readonly LegacyTopologyDevice[];
  readonly mac: string;
}

// What a durable rewrite of a configuration answers.
export interface LegacyMigration {

  // Whether any family kept its retired entries because the topology this pass had could not place one of their scopes. The caller reads it as "probe wider and come
  // back"; a converged configuration answers false and the caller does nothing further.
  readonly legacyRemaining: boolean;

  // The configured options with every retired entry this pass could rewrite exactly replaced by its canonical form.
  readonly options: readonly string[];
}

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
 * This is the same translation the platform performs in memory on every boot, with the one thing that pass cannot have: the topology. Knowing which identifiers name
 * controllers and which name devices beneath them is what lets each scope's selection compose through its TRUE three-level walk rather than through the scope-plus-global
 * approximation a bare configuration string admits. Where that holds, the rewrite is exact and the retired entries are dropped for good.
 *
 * Retirement is per family. A family carrying a scope this topology cannot place - a device on a controller that did not answer its probe - keeps its entries exactly as
 * written and is reported as remaining, so a later pass with more topology finishes it. Nothing is guessed at, and the runtime overlay keeps honoring what stays.
 *
 * @param args
 * @param args.controllers - The controllers that answered this pass, each with the devices beneath it. Omit it for the cheap detector and the topology-free rewrite.
 * @param args.options     - The configured feature options to rewrite.
 *
 * @returns The rewritten options and whether any family still carries retired entries.
 */
export function migrateLegacyFeatureOptions(args: { controllers?: readonly LegacyTopologyController[]; options: readonly string[] }): LegacyMigration {

  const { controllers, options } = args;

  const configIndex = legacyConfigIndex(options);
  const canonicalOptions = options.filter((entry) => entry.includes("="));
  const consumed = new Set<number>();
  const emissions: string[] = [];
  const rewrites = new Map<number, string>();

  // The controller each identifier resolves under: a controller answers for itself, and a device answers for the controller it was found on. An identifier absent from
  // this map is one the topology cannot place, which is what makes a family's rewrite wait for a later pass.
  const controllerFor = new Map<string, string>();

  for(const controller of controllers ?? []) {

    controllerFor.set(controller.mac.toLowerCase(), controller.mac);

    for(const device of controller.devices) {

      controllerFor.set(device.mac.toLowerCase(), controller.mac);
    }
  }

  let legacyRemaining = false;

  const addressed = new Map<LegacyFamily, { address: LegacyAddress; index: number; role: LegacyRole }[]>();

  for(const [ index, raw ] of options.entries()) {

    // A retired plate list needs no topology at all: its rewrite is a value re-composition, exact wherever it is found.
    const plates = rewritePlateEntry(raw);

    if(plates !== null) {

      rewrites.set(index, plates);

      continue;
    }

    const address = decodeLegacyAddress(raw);
    const role = address ? OPTION_ROLES.get(address.option) : undefined;

    if(!address || !role) {

      continue;
    }

    const found = addressed.get(role.family) ?? [];

    found.push({ address, index, role });
    addressed.set(role.family, found);
  }

  for(const family of LEGACY_FAMILIES) {

    const found = addressed.get(family) ?? [];
    const scopes = new Set(found.filter(({ address, role }) => !role.master || (address.enabled && address.scope.length)).map(({ address }) => address.scope));

    if(!scopes.size) {

      continue;
    }

    // A canonical value already supersedes this family, so its retired entries carry no meaning and simply leave.
    if(isSuperseded({ canonicalOptions, family })) {

      for(const { address, index, role } of found) {

        if(!role.master || (address.enabled && scopes.has(address.scope))) {

          consumed.add(index);
        }
      }

      continue;
    }

    // Every scope this family names has to be placeable, or the rewrite would compose one of them against the wrong hierarchy. A single unplaceable scope holds the
    // whole family back rather than half-migrating it.
    if([...scopes].some((scope) => scope.length && !controllerFor.has(scope.toLowerCase()))) {

      legacyRemaining = true;

      continue;
    }

    for(const { address, index, role } of found) {

      if(!role.master || (address.enabled && scopes.has(address.scope))) {

        consumed.add(index);
      }
    }

    for(const scope of scopes) {

      const controller = scope.length ? controllerFor.get(scope.toLowerCase()) : undefined;
      const emission = composeEmission({ configIndex, controller: (controller === scope) ? undefined : controller, family, scope });

      if(emission) {

        emissions.push(emission);
      }
    }
  }

  return { legacyRemaining, options: options.flatMap((entry, index) => consumed.has(index) ? [] : [rewrites.get(index) ?? entry]).concat(emissions) };
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
export function composeMigrationPatch({ controllers, migratePatch, platformOptions }: { controllers?: readonly LegacyTopologyController[];
  migratePatch?: Nullable<MigrationPatch>; platformOptions?: readonly string[]; }): { legacyRemaining: boolean; patch: Nullable<MigrationPatch> } {

  const source = (migratePatch && ("options" in migratePatch) && Array.isArray(migratePatch.options)) ? migratePatch.options :
    (Array.isArray(platformOptions) ? platformOptions : []);
  const migration = migrateLegacyFeatureOptions({ controllers, options: source });

  // Whether the translation says something the configured options do not, entry for entry, which is what decides whether a rewrite is worth committing at all.
  const translated = !sameEntries(source, migration.options, (left, right) => left === right);

  if(!migratePatch && !translated) {

    return { legacyRemaining: migration.legacyRemaining, patch: null };
  }

  return { legacyRemaining: migration.legacyRemaining, patch: translated ? { ...migratePatch, options: [...migration.options] } : (migratePatch ?? null) };
}
