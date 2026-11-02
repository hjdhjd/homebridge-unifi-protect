/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webui/protect-config.ts: Pure interpreters over the injected Protect platform configuration.
 */
import type { FeatureCategoryEntry, FeatureOptionEntry, FeatureOptions, addressListedElsewhere, addressListingForm, displayedName } from "homebridge-plugin-utils";

/* The single home for our plugin-config shape. Every function here is a pure interpreter - of the primary platform-config entry the webUI framework injects into
 * our hooks, or of the UI server's answer about a controller's devices - with no I/O and no global reach. The framework owns reading and writing the persisted
 * config through its session; this module owns the Protect-specific knowledge of what a controller is, where credentials live, and what the UI server's device
 * list answered. Keeping that knowledge in one place means a config-shape change is a single edit, and it keeps every hook in ui.mjs a declarative one-liner over
 * these helpers.
 *
 * Two settings substrates meet here. A feature option is where a setting lives, and a handful of configuration properties are a second home the plugin honors so that
 * a configuration nobody has opened the webUI on keeps working. Reconciling the two is the migration's whole job: it moves each property's value into the option that
 * supersedes it and marks the property for deletion. The module imports types alone, which the compiler erases - the engine class, the served option catalog, HBPU's
 * listed-address rule, and HBPU's display-name rule are handed in - so it stays browser-safe and the whole of it is exercisable under node against the real engine,
 * the real catalog, and the real rules, with no network and no DOM.
 */

/**
 * One configured controller, as it actually arrives from the Homebridge UI. Every property is declared as an unknown-valued optional because that is the honest shape
 * of an object read back from a user's `config.json`: a property may be absent, may carry a hand-edited value of any type, and may be a retired name no part of the
 * plugin reads any more. Interpreting exactly that is what the module is for.
 */
export interface ProtectControllerConfig {

  [key: string]: unknown;
  address?: unknown;
  doorbellMessages?: unknown;
  mqttTopic?: unknown;
  mqttUrl?: unknown;
  name?: unknown;
  overrideAddress?: unknown;
  password?: unknown;
  username?: unknown;
}

/**
 * The primary platform-configuration entry, on the same terms the controller shape above states: every legacy property is unknown-valued because a user's
 * `config.json` is free to carry anything at all under these names, and telling an active choice apart from a hand-edit we decline to interpret is the migration's job
 * rather than the type system's.
 */
export interface ProtectConfig {

  controllers?: unknown;
  debug?: unknown;
  options?: unknown;
  ringDelay?: unknown;
  verboseFfmpeg?: unknown;
  videoProcessor?: unknown;
}

/**
 * The connection triple a caller needs in order to reach one controller. The values stay unknown because they are carried straight through from the configuration
 * without being validated: the UI server's own login is what finds out whether they work.
 */
export interface ProtectControllerCredentials {

  address: unknown;
  password: unknown;
  username: unknown;
}

/**
 * The option catalog the plugin's UI server publishes, as the migration consumes it.
 */
export interface ProtectConfigCatalog {

  categories: FeatureCategoryEntry[];
  options: Record<string, FeatureOptionEntry[]>;
}

/**
 * The commit-shaped patch the migration produces. A consumed TOP-LEVEL legacy property is carried here as a PRESENT key whose value is `undefined`, never as an
 * omitted key: the session's shallow-merge commit treats those two shapes oppositely, deleting the first and leaving the second untouched, and the type system cannot
 * state that difference. Assertions about this patch must therefore read own-property presence rather than compare against `undefined`.
 *
 * A controllers[] item key deletes the other way around, by omission from the freshly rebuilt successor, which is why no per-item key appears here at all - the whole
 * array is carried instead, and only when at least one item's successor differs from the item it replaces.
 */
export interface ProtectConfigPatch {

  controllers?: ProtectControllerConfig[];
  debug?: undefined;
  options?: string[];
  ringDelay?: undefined;
  verboseFfmpeg?: undefined;
  videoProcessor?: undefined;
}

/**
 * One device row of the UI server's answer, as the page names it. Every other field a row carries is the controller's record or the page's own processing, which
 * the namer reads nothing of.
 */
export interface ProtectDeviceRow {

  [key: string]: unknown;

  /** The name the UI server composed for the device as HomeKit names its accessory with no custom name applied, absent on the controller's own row. */
  homeKitName?: string;

  /** The name the controller reports. */
  name?: string;

  /** The device's MAC, the scope the framework addresses the row's options at. */
  serialNumber?: string;
}

/**
 * The migration and the device-row namer over a fetched catalog.
 */
export interface ProtectConfigInterpreter {

  /**
   * The namer for one configuration's device rows, over one engine for the whole list. A row shows the name the plugin applies to its device's accessory in HomeKit:
   * the custom name the user set where HomeKit can carry it, and the name the UI server composed otherwise, falling back to the name the row carries where it carries
   * no composed one, by HBPU's display-name rule.
   */
  deviceNamer(config?: ProtectConfig): (row: ProtectDeviceRow) => string;

  migrate(config?: ProtectConfig, macByAddress?: ReadonlyMap<string, string>): ProtectConfigPatch | null;
}

/**
 * The interpreters of the configured controller list, which makeControllerList builds over HBPU's listed-address rule. Each is declared as a property carrying a
 * function, which is what the factory builds, so a consumer is free to read one off the object and call it on its own.
 */
export interface ProtectControllerList {

  /**
   * Whether a controller save would be refused because another configured controller already holds the address it writes, compared in HBPU's listing form. A save
   * that writes its own item's address, in any spelling, is never refused. An address the rule gives no form is never listed.
   */
  controllerListedElsewhere: (config: ProtectConfig | null | undefined, save: { address?: unknown; originalAddress?: unknown }) => boolean;

  /**
   * The configured controllers, one entry per listed address: the stored entries themselves in their stored order, keeping the first entry at each address and
   * every entry whose address has no form, and leaving out every later entry at an address and every entry that is not an object, or an empty list when the
   * configuration holds no list.
   */
  controllers: (config?: ProtectConfig) => ProtectControllerConfig[];

  /** The configured controllers still carrying a per-controller legacy property, each reduced to the connection triple needed to reach it. */
  controllersAwaitingMigration: (config?: ProtectConfig) => ProtectControllerCredentials[];

  /** Whether valid Protect login credentials exist for the primary controller. */
  hasValidCredentials: (config?: ProtectConfig) => boolean;

  /** The primary controller entry (the first), or undefined on a fresh configuration. */
  primaryController: (config?: ProtectConfig) => ProtectControllerConfig | undefined;

  /**
   * Whether the first-run save would be refused because a controller after the primary already holds the address it writes, by the rule a controller save is
   * refused under, with the primary as the save's target.
   */
  primaryListedElsewhere: (config: ProtectConfig | null | undefined, credentials: { address?: unknown }) => boolean;

  /**
   * The patch that removes one controller, and - when a MAC set is supplied - strips every configured entry scoped to one of those MAC addresses. An empty or
   * absent MAC set carries no `options` array at all, which is what leaves the configured entries untouched rather than rewriting them to themselves.
   */
  withControllerRemoved: (config: ProtectConfig | undefined, removal: { address: string; macs?: readonly string[] }) => { controllers: ProtectControllerConfig[];
    options?: string[]; };

  /**
   * The controllers patch that writes one controller's connection triple. An `originalAddress` naming a configured item replaces that item's credentials while
   * carrying every other key it holds; an absent or unmatched one appends a new item instead. Null means the address is already listed and nothing is to be
   * written.
   */
  withControllerSaved: (config: ProtectConfig | undefined, controller: { address: string; originalAddress?: string; password: string; username: string }) =>
    { controllers: ProtectControllerConfig[] } | null;

  /**
   * The controllers patch that writes the supplied credentials into the primary controller, preserving the additional controllers the configured list holds, one
   * entry per listed address, and the primary's other fields. Null means a controller after the primary already holds the address.
   */
  withPrimaryCredentials: (config: ProtectConfig | undefined, credentials: { address: string; password: string; username: string }) =>
    { controllers: ProtectControllerConfig[] } | null;
}

/**
 * One reading of the UI server's device-list answer: the list itself, the controller the server could not reach with the reason it captured, the UI server's own
 * failure, or a sidebar entry whose controller left the configuration. Every failure carries no devices and the headline its surfaces render it under.
 */
export type DeviceListVerdict = { devices: Record<string, unknown>[]; kind: "list"; message: string } |
  { devices: Record<string, unknown>[]; headline: string; kind: "unreachable"; message: string } |
  { devices: Record<string, unknown>[]; guidance: string; headline: string; kind: "serverFailure" | "staleSelection"; message: string };

/** The result the framework's device-list hook answers, carrying a failure's own headline and guidance where it has them. */
export interface DeviceListResult {

  devices: Record<string, unknown>[];
  error: string;
  guidance?: string;
  headline?: string;
}

// The headline for a controller the plugin could not reach, rendered as the framework's error-view headline above the controller's own reason.
const CONNECTION_FAILURE_HEADLINE = "Unable to connect to the UniFi Protect controller.";

// The headline for a UI server that failed to answer or answered in a shape it never writes, rendered as the framework's error-view headline.
const SERVER_FAILURE_HEADLINE = "The plugin's UI server did not answer as expected.";

// Why a UI server failure happened when nothing more specific is known: an answer in a shape the server never writes, or a failed request that carried no message.
const SERVER_FAILURE_MESSAGE = "The plugin's UI server answered in an unrecognized shape.";

// What to do about a UI server failure, rendered beneath its headline in place of the page's own guidance, which would send the user after the controller.
const SERVER_FAILURE_GUIDANCE = "Reload this page. If it keeps happening, restart Homebridge and check its log for the reason.";

// The headline for a sidebar entry whose controller left the configuration, rendered as the framework's error-view headline.
const STALE_SELECTION_HEADLINE = "This controller is no longer in the plugin configuration.";

// Why a sidebar entry cannot be listed, rendered as the error view's detail beneath the headline above.
const STALE_SELECTION_MESSAGE = "Its entry left the configuration after the sidebar was built.";

// What to do about a sidebar entry whose controller left the configuration, rendered as the error view's guidance.
const STALE_SELECTION_GUIDANCE = "Refresh the controller list to take it off the sidebar.";

// The UI server failure, carrying the message that explains it. The message is never empty, because the framework reads an empty failure message as a healthy
// controller with nothing to list. Each call composes a fresh verdict, so no two verdicts share a device array.
const serverFailure = (message: string = SERVER_FAILURE_MESSAGE): DeviceListVerdict => ({ devices: [], guidance: SERVER_FAILURE_GUIDANCE,
  headline: SERVER_FAILURE_HEADLINE, kind: "serverFailure", message: message.length ? message : SERVER_FAILURE_MESSAGE });

// Whether a fulfilled answer is in the one shape the UI server writes for a device list: an object carrying a device array and an error string.
const isDeviceListAnswer = (answer: unknown): answer is { devices: Record<string, unknown>[]; error: string } => (typeof answer === "object") && (answer !== null) &&
  ("devices" in answer) && Array.isArray(answer.devices) && ("error" in answer) && (typeof answer.error === "string");

/* Read the UI server's answer to a device-list request, which is the one place that answer is interpreted, so the device view, the login check, and the
 * migration's probes cannot read one answer differently.
 *
 * The server answers a device list with an empty error when it reached the controller, and an empty list with the reason it captured when it did not, which is
 * empty when it captured none. Anything else is an answer in a shape the server never writes, and reads as the UI server's own failure rather than as an empty
 * controller, because guessing at it is how a malformed answer becomes a silently empty page. A request the bridge rejected is the UI server's failure too,
 * carrying the rejection's own message, or the unrecognized-shape sentence when it carried none. A failure verdict carries the headline its surfaces render it
 * under, and a guidance line only where the page's own standing guidance would send the user after the wrong thing.
 *
 * @param settlement - The request's settlement, in the shape Promise.allSettled answers: fulfilled with the server's answer, or rejected with what it threw.
 *
 * @returns The verdict: its kind, its devices, its message, and for a failure its headline and the guidance it carries.
 */
export const readDeviceListAnswer = (settlement: PromiseSettledResult<unknown>): DeviceListVerdict => {

  /* The bridge rejects with the plain object the host's UI server sends, which carries a message, and the page's own deadline rejects with an error, which carries
   * one too, so the message is read off whatever was thrown rather than off an error alone. A rejection that is itself a non-empty string is its own message, and
   * anything else carries the unrecognized-shape sentence, because rendering an object as text would show the user nothing they can act on.
   */
  if(settlement.status === "rejected") {

    const reason: unknown = settlement.reason;
    const message = ((((typeof reason === "object") && (reason !== null)) || (typeof reason === "function")) && ("message" in reason)) ? reason.message : undefined;

    return serverFailure((typeof message === "string") ? message : ((typeof reason === "string") ? reason : undefined));
  }

  const answer = settlement.value;

  if(!isDeviceListAnswer(answer)) {

    return serverFailure();
  }

  // The controller could not be reached. The page's own guidance line already sends the user to the connection editor beneath the error, so the verdict carries
  // none of its own.
  if(!answer.devices.length) {

    return { devices: [], headline: CONNECTION_FAILURE_HEADLINE, kind: "unreachable", message: answer.error };
  }

  return answer.error.length ? serverFailure() : { devices: answer.devices, kind: "list", message: "" };
};

/* The verdict of a sidebar entry whose controller left the configuration after the sidebar was built. It is composed here beside the device-list verdicts because
 * it is one: every device-list outcome the page hands the framework goes through the one result composition below, so the copy for this failure lives with the
 * copy for every other. Each call composes a fresh verdict, so no two results share a device array.
 */
export const staleSelectionVerdict = (): DeviceListVerdict => ({ devices: [], guidance: STALE_SELECTION_GUIDANCE, headline: STALE_SELECTION_HEADLINE,
  kind: "staleSelection", message: STALE_SELECTION_MESSAGE });

/* Map a device-list verdict onto the result the framework's device-list hook answers, with each outcome's own copy beside it. A success carries its devices and
 * an empty error, and a failure carries no devices, its message, its headline, and its guidance where it has one. Only the members an outcome carries are
 * written, because an absent member is how the framework's contract says its own wording applies. An unreachable controller whose reason the server could not
 * capture maps to an empty error, which the framework renders as it renders that answer from the server directly.
 *
 * No success needs a nothing-to-list notice: every device list the UI server answers opens with the controller's own record, so the shortest list a reachable
 * controller can produce still carries a node to select and an options table to render against it.
 */
export const deviceListResult = (verdict: DeviceListVerdict): DeviceListResult => {

  const result: DeviceListResult = { devices: verdict.devices, error: verdict.message };

  if(verdict.kind !== "list") {

    result.headline = verdict.headline;

    if("guidance" in verdict) {

      result.guidance = verdict.guidance;
    }
  }

  return result;
};

// What a save says when the address it writes is one another configured controller already holds. It is stated once, here beside the rule that refuses such a
// save, and the page hands it to every surface that speaks the refusal.
export const CONTROLLER_LISTED_WARNING = "This controller is already listed.";

// Whether a configured controllers[] item is an object, the one shape whose members every reader of an entry reads. A hand edit can leave anything else there.
const isControllerEntry = (item: unknown): item is ProtectControllerConfig => (typeof item === "object") && (item !== null);

// The index of the item a save writes onto: the one whose address is exactly the address the save started from, or -1 for an add and for an original address no
// item holds. The writer and the early check find their target here alike, so they ask the rule about the same item.
const saveTarget = (items: ProtectControllerConfig[], originalAddress: unknown): number => (originalAddress === undefined) ? -1 :
  items.findIndex((item) => item.address === originalAddress);

/* Whether one configured-options entry addresses a scope named by any of the supplied MAC addresses, and the whole of what the orphan sweep decides an entry on.
 *
 * The rules are DERIVED FROM THE ENGINE'S OWN ENTRY PARSER rather than from any single spelling, because several spellings resolve to one scope and stripping only
 * the canonical one would leave a removed controller's settings behind in the other forms. Reading the parser's grammar from the scope's side, an entry addresses
 * a scope when:
 *
 *   - It opens with an Enable or a Disable action, case-insensitively, followed by a dot. Anything else is not an entry the parser resolves at all.
 *   - Everything ahead of the first payload delimiter addresses; everything behind it is value text, where a MAC-shaped string is data rather than a scope. The
 *     address is right-trimmed at the delimiter exactly as the parser trims it, so a hand-spaced entry reads as the tight form.
 *   - Within that address, the first dot-delimited segment always belongs to the option name, so a scope can only be named at the second segment or later.
 *   - A Disable entry carries no value reading whatsoever, so its only scope is its trailing segment: `Disable.Option.MAC`.
 *   - An Enable entry additionally carries the value readings, which put the scope ahead of the value: `Enable.Option.MAC` bare, `Enable.Option.MAC=value` in the
 *     canonical form, and `Enable.Option.MAC.value` in the legacy spelling the parser still accepts from configurations written before the delimiter existed. The
 *     scope sits anywhere from the second segment onward across those spellings, so every one of them is tested. On a free-form value option the bare spelling's
 *     segment is the global value rather than a scope, and sweeping one that happens to spell a swept MAC costs nothing, so the test does not tell the two apart.
 *
 * The cost of reading the grammar without the catalog that names where an option ends: an Enable entry in the legacy spelling whose VALUE text happens to contain
 * a bare MAC of its own, as a whole dot-delimited segment, reads as addressing that MAC. Sweeping such an entry is the wrong call in principle and an unreachable
 * one in practice - it takes a hand-authored value carrying the exact MAC of a device on the controller being removed - and the alternative, matching the trailing
 * segment alone, would leave the legacy scoped spelling standing, which is a failure a user would actually meet.
 */
const addressesSweptScope = (entry: unknown, macs: readonly string[]): boolean => {

  if(typeof entry !== "string") {

    return false;
  }

  const dotIndex = entry.indexOf(".");

  if(dotIndex === -1) {

    return false;
  }

  const action = entry.slice(0, dotIndex).toLowerCase();

  if((action !== "enable") && (action !== "disable")) {

    return false;
  }

  const tail = entry.slice(dotIndex + 1).toLowerCase();
  const payloadIndex = tail.indexOf("=");
  const segments = ((payloadIndex === -1) ? tail : tail.slice(0, payloadIndex).trimEnd()).split(".");

  if(segments.length < 2) {

    return false;
  }

  return ((action === "enable") ? segments.slice(1) : segments.slice(-1)).some((segment) => macs.includes(segment));
};

/* The legacy TOP-LEVEL configuration properties, each paired with the feature option that supersedes it and the kind of value it carries, listed in the order the
 * migration visits them, which is the order their entries are composed in. The const assertion keeps every property name a literal, which is what lets the
 * migration read each one off the configuration by its own key. These need no identity to move: the option each one lands on is a plain global entry, so they
 * migrate on the first open of any configuration that still carries them.
 *
 * The kind is declared here rather than read off the catalog because the two value properties are genuinely different types on the wire - a ring delay is a number
 * and an executable path is a string - and the compose rules turn on that difference. Log.Debug is the one landing the served catalog does not declare at all: it is
 * an undocumented diagnostic switch the plugin resolves through the same option grammar as everything else, and the engine composes a bare enable entry for a key it
 * does not recognize, which is exactly the entry the plugin's own read of it resolves.
 */
const TIER_ONE_SETTINGS = [

  { kind: "flag", option: "Log.Debug", property: "debug" },
  { kind: "number", option: "Doorbell.Ring.Delay", property: "ringDelay" },
  { kind: "flag", option: "Log.FFmpeg", property: "verboseFfmpeg" },
  { kind: "string", option: "Video.FFmpeg.Path", property: "videoProcessor" }
] as const;

/* The legacy PER-CONTROLLER configuration properties, each paired with the feature option that supersedes it at controller scope, listed in the order the migration
 * visits them. These cannot move on the strength of the configuration alone: an option entry is addressed by the controller's MAC address, and a configuration file
 * records only the address the plugin connects to, so a controller has to actually answer before its settings have anywhere to land. The wiring probes for the MAC
 * and hands in what it resolved; an item whose controller stayed silent keeps its properties and gets another chance at the next open.
 */
const TIER_TWO_SETTINGS = [

  { option: "Mqtt.Topic", property: "mqttTopic" },
  { option: "Mqtt.Url", property: "mqttUrl" },
  { option: "Nvr.OverrideAddress", property: "overrideAddress" }
] as const;

// A top-level legacy value in each shape that composes an entry, by the kind of value it carries.
type TierOneChoice = { kind: "flag"; value: true } | { kind: "number"; value: number } | { kind: "string"; value: string };

// A per-controller legacy value beside what the compose rule reads it against: the engine over the configuration, the controller's MAC, and the option it lands on.
interface ScopedSetting {

  engine: FeatureOptions;
  mac: string;
  option: string;
  value: unknown;
}

/* The keys a controllers[] item converges to: the connection triple the plugin logs in with, and nothing else. Each item's successor is rebuilt from this list rather
 * than edited down from the original, which is what retires a key by simply never carrying it - the per-controller display name and the doorbell message presets both
 * leave that way, as does any key a hand-edit left behind that neither the plugin nor its configuration schema reads. An item key therefore deletes by OMISSION,
 * which is the opposite of how a top-level property deletes, and the migration's assertions have to read the two differently.
 */
const CONNECTION_KEYS = [ "address", "password", "username" ];

// The feature option a device's custom HomeKit name is stored under, at the device's own scope, which is the one scope the option declares and where the plugin
// reads it.
const DEVICE_NAME_OPTION = "Device.Name";

// Whether a rebuilt successor carries exactly what the item it replaces carried. This decides whether the controllers array rides the patch at all, and it is what
// makes the rewrite converge: once every item is already its own connection triple, no successor differs and a later pass leaves the array alone.
const unchanged = (item: ProtectControllerConfig, successor: ProtectControllerConfig): boolean => {

  const keys = Object.keys(successor);

  return (Object.keys(item).length === keys.length) && keys.every((key) => item[key] === successor[key]);
};

/* Whether a configured credential carries a length, read the way the credentials gate reads the username and the password: a string that is not empty, and any
 * other value whose length property is truthy, which a hand edit can leave, since the gate holds only the address to being a string.
 */
const carriesLength = (value: unknown): boolean => {

  if(typeof value === "string") {

    return value.length > 0;
  }

  return ((((typeof value === "object") && (value !== null)) || (typeof value === "function")) && ("length" in value)) && Boolean(value.length);
};

/**
 * What the controller list's interpreters are built over: HBPU's listed-address rule. Each piece's type is declared here at module scope, where `typeof` names the
 * imported function, rather than in the factory's parameter, where the same words would name the parameter itself.
 */
export interface ProtectControllerListDependencies {

  readonly addressListedElsewhere: typeof addressListedElsewhere;
  readonly addressListingForm: typeof addressListingForm;
}

/* Build the interpreters of the configured controller list over HBPU's listed-address rule: its listing form, the form addresses are compared in, and its check of
 * whether a saved address is already listed at another position. Every interpreter here reads the list one entry per listed address, so each one needs the
 * rule, and handing the rule in is what keeps this module's imports to types alone, which the compiler erases, while the page, its suites, and the plugin all read a
 * controller's address through the one rule. What counts as one address is the rule's to state; what this module states is which entry at an address is kept, and
 * what a save may write.
 *
 * Every lookup on the page stays exact, because a lookup asks which stored entry a key names and the stored string is that key. The refusal asks a different
 * question - whether a new entry would name a controller already listed - and the plugin uses only the first entry at an address, skipping every later one at
 * startup, so a listed address typed again in another spelling would write an entry the plugin never uses. An address the rule gives no form - absent, empty, or
 * not a string, any of which a hand edit can leave - never matches, so an empty field is left to the login check's own sentence rather than read as a listed
 * address.
 *
 * @param injected.addressListedElsewhere - HBPU's check of whether an address being saved is already listed at another position.
 * @param injected.addressListingForm     - HBPU's listing form of an address, or null for a value that has none.
 *
 * @returns The interpreters of the configured controller list, each under the name the page calls it by.
 */
export const makeControllerList = ({ addressListedElsewhere, addressListingForm }: ProtectControllerListDependencies): ProtectControllerList => {

  /* The configured controllers, one entry per listed address: the stored entries in their stored order, with every entry after the first at one listing form left
   * out, and an empty list when the configuration holds no list at all, so a caller never branches on what a hand edit left there. An entry that is not an object
   * is left out too, because every reader reads an entry's members, and an entry whose address has no form is never a repeat and is always kept.
   *
   * The first entry at an address is the one kept because it is the one the plugin uses: startup skips every later entry at that address. The page therefore
   * reads, edits, lists, and removes that same entry, and every write composed over this list persists the list as read, which is how a repeated entry leaves the
   * configuration file. The entries are the stored objects themselves rather than copies, so a writer carries each entry it does not name across untouched.
   */
  const controllers = (config?: ProtectConfig | null): ProtectControllerConfig[] => {

    if(!Array.isArray(config?.controllers)) {

      return [];
    }

    const listed = new Set<string>();

    return config.controllers.filter((item: unknown): item is ProtectControllerConfig => {

      if(!isControllerEntry(item)) {

        return false;
      }

      const form = addressListingForm(item.address);

      if(form === null) {

        return true;
      }

      if(listed.has(form)) {

        return false;
      }

      listed.add(form);

      return true;
    });
  };

  // The primary controller entry (the first), or undefined on a fresh configuration.
  const primaryController = (config?: ProtectConfig): ProtectControllerConfig | undefined => controllers(config)[0];

  /* Whether valid Protect login credentials exist for the primary controller - the gate the first-run flow consults to decide whether setup is still required.
   *
   * The address is read as the plugin reads it: only a string is an address, and it is read trimmed, so an address of spaces alone, or a hand edit that left something
   * other than a string, is one the plugin skips and one first run asks for again.
   */
  const hasValidCredentials = (config?: ProtectConfig): boolean => {

    const controller = primaryController(config);

    return (typeof controller?.address === "string") && Boolean(controller.address.trim().length) && carriesLength(controller.username) &&
      carriesLength(controller.password);
  };

  /* Whether the address a save writes onto the item at `index` is held by any other configured item, the index being -1 for a save with no target, which
   * appends. This is the one question the save's writer, the first-run writer, and the page's early checks all ask of the rule, so none of them can disagree about
   * what counts as the same controller.
   *
   * The items are the configured controllers as the page reads them, one entry per listed address, so no position but the target's own holds the target's form,
   * and a save that writes its target's own address in any spelling is never refused.
   */
  const heldElsewhere = (items: ProtectControllerConfig[], index: number, address: unknown): boolean => addressListedElsewhere({ address,
    addresses: items.map((item) => item.address), index });

  /* Whether a controller save would be refused because another configured controller already holds the address it writes, asked of the configuration the page
   * last received so a save can answer before its login check. The writer asks the same rule again against the configuration the write composes over, and its
   * answer is the one that decides. A stale configuration can make the answers differ - this one can refuse a save the writer would accept, which the user
   * retries, or pass one the writer then refuses - but it can never let a duplicate through.
   *
   * @param config - The platform configuration entry.
   * @param save   - The address the save writes, and the address of the item it started from, absent for an add.
   *
   * @returns True when another configured controller already holds the written address.
   */
  const controllerListedElsewhere = (config: ProtectConfig | null | undefined, { address, originalAddress }: { address?: unknown;
    originalAddress?: unknown; }): boolean => {

    const items = controllers(config);

    return heldElsewhere(items, saveTarget(items, originalAddress), address);
  };

  /* Whether the first-run save would be refused because a controller after the primary already holds the address it writes. The first-run save always writes
   * onto the primary, so the primary is the rule's target, and a first run that writes the primary's own address in any spelling is never refused, because the
   * page reads one entry per listed address and no later entry it reads holds the primary's form.
   *
   * @param config      - The platform configuration entry.
   * @param credentials - The credentials the first-run form would write, of which only the address is read.
   *
   * @returns True when another configured controller already holds the written address.
   */
  const primaryListedElsewhere = (config: ProtectConfig | null | undefined, { address }: { address?: unknown }): boolean => heldElsewhere(controllers(config), 0,
    address);

  /* Produce the controllers patch that writes the supplied credentials into the primary controller, preserving the additional controllers the configured list
   * holds, one entry per listed address, and the primary's other fields. On a true first run controllers[0] is undefined; object spread of undefined is a safe
   * no-op that yields just the credential fields, so no separate initialization is needed.
   *
   * @param config      - The platform configuration entry.
   * @param credentials - The connection triple to write onto the primary controller.
   *
   * @returns The `{ controllers }` patch for the session's commit to merge onto the platform entry, or null when a controller after the primary already holds the
   *          address, by the rule a controller save is refused under.
   */
  const withPrimaryCredentials = (config: ProtectConfig | undefined, { address, password, username }: { address: string; password: string;
    username: string; }): { controllers: ProtectControllerConfig[] } | null => {

    const next = [...controllers(config)];

    if(heldElsewhere(next, 0, address)) {

      return null;
    }

    next[0] = { ...next[0], address, password, username };

    return { controllers: next };
  };

  /* Produce the controllers patch that writes one controller's connection triple, either onto the item it already has or as a new item at the end.
   *
   * The item the write lands on is found by the address the caller started from, not by the address being written, so an edit that changes a controller's
   * address replaces that controller rather than adding a second one beside it. An `originalAddress` that names no configured item - and the absent one an add
   * passes - appends instead, which is the whole of what distinguishes adding a controller from editing one.
   *
   * A save whose written address another item already holds is refused rather than composed, on the append and the replace alike. The writer runs against the
   * configuration the write composes over, so this is the refusal that decides, including for a save queued behind another that changed the configuration after
   * the page last read it.
   *
   * An edit carries every other key its item holds. A controller nobody has migrated yet still owns per-controller legacy settings, and the migration is the only
   * thing that retires those; a credential edit that rebuilt the item from the triple alone would silently discard settings the plugin is still running on.
   *
   * @param config     - The platform configuration entry.
   * @param controller - The connection triple to write, and the address of the item to write it onto.
   *
   * @returns The `{ controllers }` patch for the session's commit to merge onto the platform entry, or null when the address is already listed and nothing is to
   *          be written.
   */
  const withControllerSaved = (config: ProtectConfig | undefined, { address, originalAddress, password, username }: { address: string; originalAddress?: string;
    password: string; username: string; }): { controllers: ProtectControllerConfig[] } | null => {

    const items = controllers(config);
    const index = saveTarget(items, originalAddress);

    if(heldElsewhere(items, index, address)) {

      return null;
    }

    if(index === -1) {

      return { controllers: [ ...items, { address, password, username } ] };
    }

    const next = [...items];

    next[index] = { ...items[index], address, password, username };

    return { controllers: next };
  };

  /* Produce the patch that removes one controller, and optionally the configuration entries scoped to the devices it brought with it.
   *
   * The two halves are deliberately separable. Dropping the item is what removal means and always happens; stripping the entries is the user's own follow-on
   * choice, because the settings they configured for those devices are worth keeping when a controller is being re-added under a new address, and worth deleting
   * when it is gone for good. An empty MAC set therefore carries no options array at all, which leaves every configured entry exactly where it was.
   *
   * @param config  - The platform configuration entry.
   * @param removal - The address of the controller to drop, and the MAC addresses whose entries to strip with it.
   *
   * @returns The patch for the session's commit to merge onto the platform entry.
   */
  const withControllerRemoved = (config: ProtectConfig | undefined, { address, macs = [] }: { address: string;
    macs?: readonly string[]; }): { controllers: ProtectControllerConfig[]; options?: string[] } => {

    const remaining = controllers(config).filter((item) => item.address !== address);

    if(!macs.length) {

      return { controllers: remaining };
    }

    // The comparison runs in lower case on both sides: the parser lowercases an entry's address before it resolves a scope, so a MAC's casing in the
    // configuration file says nothing about which scope it names.
    const swept = macs.map((mac) => mac.toLowerCase());

    return { controllers: remaining, options: (Array.isArray(config?.options) ? config.options : []).filter((entry) => !addressesSweptScope(entry, swept)) };
  };

  /* The configured controllers still carrying at least one per-controller legacy property, each reduced to the connection triple a caller needs in order to reach
   * it. This is what lets the wiring probe exactly the controllers whose settings still need a MAC address, and skip the network entirely once every one of them
   * has converged.
   *
   * A configuration we cannot parse answers the empty array rather than throwing, on the same terms the migration declines one: the caller's next move is a
   * network probe, and there is nothing here worth probing for.
   *
   * @param config - The platform configuration entry.
   *
   * @returns The connection triple of each controller whose per-controller settings have not migrated yet.
   */
  const controllersAwaitingMigration = (config?: ProtectConfig): ProtectControllerCredentials[] => {

    if(!Array.isArray(config?.controllers)) {

      return [];
    }

    // The controllers as the page reads them, one entry per listed address, so a repeated address is probed for the entry the plugin uses and for no other.
    return controllers(config).filter((item) => TIER_TWO_SETTINGS.some(({ property }) => item[property] !== undefined))
      .map((item) => ({ address: item.address, password: item.password, username: item.username }));
  };

  return { controllerListedElsewhere, controllers, controllersAwaitingMigration, hasValidCredentials, primaryController, primaryListedElsewhere, withControllerRemoved,
    withControllerSaved, withPrimaryCredentials };
};

/**
 * What the migration and the device-row namer are built over: the feature-option engine class, the served catalog, the configured controller list's reader, and
 * HBPU's display-name rule. The engine's and the rule's types are declared here at module scope, where `typeof` names the imported class and function, rather than
 * in the factory's parameter, where the same words would name the parameter itself.
 */
export interface ProtectConfigDependencies {

  readonly FeatureOptions: typeof FeatureOptions;
  readonly catalog: ProtectConfigCatalog;
  readonly controllers: ProtectControllerList["controllers"];
  readonly displayedName: typeof displayedName;
}

/* Build the migration and the device-row namer over an injected feature-option engine class, the option catalog the plugin's own UI server publishes, the configured
 * controller list as the page reads it, and HBPU's display-name rule. Injecting them is what keeps this module's imports to types alone, which the compiler erases,
 * so it stays browser-safe and exercisable under node against the real engine, the real catalog, and the real rule, rather than against a stand-in that could drift
 * from any of them, and reading the list through the page's own reader is what makes a pass compose for the entry at each address the page shows and the plugin uses.
 *
 * @param injected.FeatureOptions - The feature-option engine class.
 * @param injected.catalog        - The served catalog, carrying its categories and its options record.
 * @param injected.controllers    - The configured controllers, one entry per listed address, as the reader makeControllerList builds answers them.
 * @param injected.displayedName  - HBPU's display-name rule, which answers the custom name where one resolves and the fallback otherwise, as HomeKit carries it.
 *
 * @returns The interpreter: the legacy-settings migration, and the device-row namer the sidebar names its device links through.
 */
export const makeProtectConfig = ({ FeatureOptions, catalog, controllers, displayedName }: ProtectConfigDependencies): ProtectConfigInterpreter => {

  // A feature-option engine over the served catalog and the config's own entries. The array is handed in directly rather than copied: the engine's set-option path is
  // a pure transform that composes a fresh array and reassigns its own field, so the array it was given is never written to.
  const engineFor = (config?: ProtectConfig): FeatureOptions => new FeatureOptions(catalog.categories, catalog.options,
    Array.isArray(config?.options) ? config.options : []);

  /* The served catalog's own entry for an option name, or undefined when the catalog declares no such option. The composition is the feature-option engine's own rule
   * - a category name joined to an option name by a dot, with a nameless option addressing its category alone - stated here rather than imported because this module
   * imports types alone and receives the catalog as data. Every question the migration asks of the catalog resolves through this one walk, so no two readings of it
   * can disagree.
   */
  const catalogEntry = (option: string): FeatureOptionEntry | undefined => {

    for(const [ category, entries ] of Object.entries(catalog.options)) {

      for(const entry of entries) {

        if((entry.name ? category + "." + entry.name : category) === option) {

          return entry;
        }
      }
    }

    return undefined;
  };

  // The value the catalog registers as an option's default, read from the served entry's own defaultValue field. The engine exposes a same-named method that answers
  // a different question - the boolean enabled-state default - so this reads the catalog data instead.
  const registeredDefault = (option: string): FeatureOptionEntry["defaultValue"] => catalogEntry(option)?.defaultValue;

  // Whether an option is enabled by default, which is what decides whether its registered default is already the answer the user gets. A default-on value option
  // resolves to that default when nothing is configured; a default-off one resolves to nothing at all, and the plugin falls back to a constant of its own.
  const defaultsOn = (option: string): boolean => catalogEntry(option)?.default === true;

  /* Whether a top-level legacy value is an active choice worth composing as an option entry. Each kind states the one shape that qualifies: a flag composes on the
   * boolean true alone, a numeric value on a finite number above zero, and a string value on a non-empty string. Everything else deletes without composing - false,
   * zero, and the empty string all mean what an absent option already means, and a value of an uninterpretable type is a hand-edit we decline to guess at.
   *
   * The byte-equal-to-registered-default rule deliberately does not apply at this tier. Every value option landed here is off by default, so an unconfigured one
   * resolves to nothing and the plugin falls back...its registered default is the webUI's pre-fill and nothing more. A ring delay of exactly that pre-fill is a
   * working setting the user chose, and dropping it would silently stop suppressing their duplicate rings.
   */
  const composes = (setting: { kind: TierOneChoice["kind"]; value: unknown }): setting is TierOneChoice => {

    const { kind, value } = setting;

    switch(kind) {

      case "flag":

        return value === true;

      case "number":

        return (typeof value === "number") && Number.isFinite(value) && (value > 0);

      case "string":

        return (typeof value === "string") && (value.length > 0);

      default:

        return false;
    }
  };

  /* Whether a per-controller legacy value composes a controller-scoped entry. Configured-ness is asked through scope() rather than exists(), because the compose
   * target is a controller-scoped entry and ANY entry that already answers this controller's read outranks the property at runtime - the same expression the plugin's
   * own MQTT resolution consults, so this module's question and the runtime's stay the same question.
   *
   * A value byte-equal to the option's registered default composes nothing, but only for an option that is on by default: that is the only kind whose unconfigured
   * read already answers the registered default, so an entry restating it would manufacture configuration out of nothing. The MQTT topic prefix is the one such
   * option here, and reading the default off the catalog rather than naming it keeps that comparison honest if the plugin ever changes what it publishes under.
   */
  const composesScoped = (setting: ScopedSetting): setting is ScopedSetting & { value: string } => {

    const { engine, mac, option, value } = setting;

    if((typeof value !== "string") || !value.length || (engine.scope(option, undefined, mac) !== "none")) {

      return false;
    }

    return !defaultsOn(option) || (value !== registeredDefault(option));
  };

  return {

    /* Name the device rows of one configuration by the name the plugin applies to each device's accessory in HomeKit: the custom name the user set where HomeKit can
     * carry it, and the name the UI server composed for the device otherwise, through HBPU's display-name rule. One engine over the configuration names every row,
     * so a page naming a whole list pays for one catalog index rather than one per row. The custom name is read at the row's serialNumber, the device's MAC the
     * framework addresses the row by, which is the scope the plugin reads it at. A row carrying no composed name, the controller's own among them, falls back to the
     * name it carries.
     *
     * The rule is applied here rather than in the UI server's answer, so a custom name being edited shows on the page before anything is saved and without a round
     * trip, and the answer itself carries the composed name alone, so a row the page keeps never carries a custom name it would go on showing once that custom
     * name is cleared.
     *
     * @param config - The platform configuration entry, the edited one when the page names rows under an edit.
     *
     * @returns The namer: a device row in, the name the page shows for it out.
     */
    deviceNamer: (config?: ProtectConfig): ((row: ProtectDeviceRow) => string) => {

      const engine = engineFor(config);

      return (row) => displayedName({ fallback: row.homeKitName ?? row.name ?? "", override: engine.value(DEVICE_NAME_OPTION, row.serialNumber) });
    },

    /* Move the legacy configuration properties into their feature options, as a patch for the session to stage. This is transitional work with a planned end: once a
     * configuration has been all the way through it, there is nothing left to find and every later pass answers null.
     *
     * A property present with a defined value always leaves. A top-level one is carried on the patch as an explicitly undefined key, so the session's shallow-merge
     * commit deletes it rather than skipping it; a per-controller one leaves by never being carried into the rebuilt item. Whether a value ALSO becomes an option
     * entry follows the compose rules above, and an option the user has already configured outranks the property either way - their own entry is their choice, and
     * the plugin's reads already resolve it ahead of the fallback. The property still leaves in that case, because two homes for one setting is the thing this
     * migration exists to end.
     *
     * The two tiers differ only in what they need to know. A top-level property migrates unconditionally. A per-controller property needs the controller's MAC
     * address, which only a controller that answered this pass can supply, so an item whose address is absent from the map keeps its per-controller keys unchanged
     * and converges at a later open. Everything composes through ONE engine and rides ONE options array, because each engine answers `configuredOptions` as its own
     * complete snapshot: two writers would each produce a whole array and the shallow-merge commit would keep only the last of them, silently discarding everything
     * the other one composed.
     *
     * Two substrates decline the whole pass. A `controllers` or an `options` field that is present but is not an array is one we cannot parse, and we do not guess at
     * it. Absent is not the same thing and is entirely valid: a configuration with no controllers key at all still migrates its top-level properties.
     *
     * The map is read with each item's address as it is stored, whatever its type, so it is typed here for any key the caller resolved a MAC under.
     *
     * @param config       - The platform configuration entry.
     * @param macByAddress - The MAC address resolved for each controller address that answered a probe this pass.
     *
     * @returns The patch to commit, or null when there is nothing to do.
     */
    migrate: (config?: ProtectConfig, macByAddress?: ReadonlyMap<unknown, string>): ProtectConfigPatch | null => {

      if(!config || ((config.controllers !== undefined) && !Array.isArray(config.controllers)) ||
        ((config.options !== undefined) && !Array.isArray(config.options))) {

        return null;
      }

      const engine = engineFor(config);
      const patch: ProtectConfigPatch = {};
      const successors: ProtectControllerConfig[] = [];

      let composed = false;
      let rewritten = false;

      for(const { kind, option, property } of TIER_ONE_SETTINGS) {

        const value = config[property];

        // A key present with the value undefined is the terminal shape this very patch produces, so it reads as absent and a second pass stages nothing for it.
        if(value === undefined) {

          continue;
        }

        patch[property] = undefined;

        const setting = { kind, value };

        if(!composes(setting) || engine.exists(option)) {

          continue;
        }

        // A flag's whole payload is the entry's existence, so it composes with no value at all; a value option carries the value the property was holding.
        engine.setOption((setting.kind === "flag") ? { enabled: true, option } : { enabled: true, option, value: setting.value });
        composed = true;
      }

      /* The per-controller tier and the controllers[] rewrite happen together, because they are one pass over the same items. Each successor is rebuilt from the
       * connection triple rather than edited down from the original, so a retired key, an unknown key, and a consumed legacy key all leave the same way: by never
       * being carried.
       *
       * The items are the controllers as the page reads them, one entry per listed address, so at a repeated address a pass reads, composes, and carries forward
       * the entry the plugin uses and no other, and a rewrite writes the list without the later entries. A pass with nothing to migrate writes nothing, so a
       * repeated entry alone never causes a write.
       */
      for(const item of controllers(config)) {

        const mac = macByAddress?.get(item.address);
        const successor: ProtectControllerConfig = {};

        for(const key of CONNECTION_KEYS) {

          if(item[key] !== undefined) {

            successor[key] = item[key];
          }
        }

        for(const { option, property } of TIER_TWO_SETTINGS) {

          const value = item[property];

          if(value === undefined) {

            continue;
          }

          // With no MAC address there is nowhere for this setting to land, so it stays exactly where it is rather than being dropped on the floor.
          if(!mac) {

            successor[property] = value;

            continue;
          }

          const setting = { engine, mac, option, value };

          if(composesScoped(setting)) {

            engine.setOption({ enabled: true, id: mac, option, value: setting.value });
            composed = true;
          }
        }

        successors.push(successor);
        rewritten ||= !unchanged(item, successor);
      }

      if(composed) {

        patch.options = engine.configuredOptions;
      }

      if(rewritten) {

        patch.controllers = successors;
      }

      return Object.keys(patch).length ? patch : null;
    }
  };
};
