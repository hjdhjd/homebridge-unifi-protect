/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-config.mjs: Pure interpreters over the injected Protect platform configuration.
 */
"use strict";

/* The single home for our plugin-config shape. Every function here is a pure interpreter of the primary platform-config entry the webUI framework injects into our
 * hooks - no I/O, no global reach. The framework owns reading and writing the persisted config through its session; this module owns the Protect-specific knowledge
 * of what a controller is and where credentials live. Keeping that knowledge in one place means a config-shape change is a single edit, and it keeps every hook in
 * ui.mjs a declarative one-liner over these helpers.
 *
 * Two settings substrates meet here. A feature option is where a setting lives, and a handful of configuration properties are a second home the plugin honors so that
 * a configuration nobody has opened the webUI on keeps working. Reconciling the two is the migration's whole job: it moves each property's value into the option that
 * supersedes it and marks the property for deletion. The module takes no imports at all - the engine class and the served option catalog are handed in - so the whole
 * of it is exercisable under node against the real engine and the real catalog, with no network and no DOM.
 */

// The configured controllers, normalized so callers never branch on undefined. On a fresh configuration the controllers array is absent; this yields an empty array.
export const controllers = (config) => config?.controllers ?? [];

// The primary controller entry (the first), or undefined on a fresh configuration.
export const primaryController = (config) => controllers(config)[0];

// Whether valid Protect login credentials exist for the primary controller - the gate the first-run flow consults to decide whether setup is still required.
export const hasValidCredentials = (config) => {

  const controller = primaryController(config);

  return Boolean(controller?.address?.length && controller?.username?.length && controller?.password?.length);
};

// Produce the controllers patch that writes the supplied credentials into the primary controller, preserving any additional controllers and the primary's other
// fields. On a true first run controllers[0] is undefined; object spread of undefined is a safe no-op that yields just the three credential fields, so no separate
// initialization is needed. Returned as a `{ controllers }` patch for the session's commit to merge onto the platform entry.
export const withPrimaryCredentials = (config, { address, password, username }) => {

  const next = [...controllers(config)];

  next[0] = { ...next[0], address, password, username };

  return { controllers: next };
};

/* Produce the controllers patch that writes one controller's connection triple, either onto the item it already has or as a new item at the end.
 *
 * The item the write lands on is found by the address the caller started from, not by the address being written, so an edit that changes a controller's address
 * replaces that controller rather than adding a second one beside it. An `originalAddress` that names no configured item - and the absent one an add passes -
 * appends instead, which is the whole of what distinguishes adding a controller from editing one.
 *
 * An edit carries every other key its item holds. A controller nobody has migrated yet still owns per-controller legacy settings, and the migration is the only
 * thing that retires those; a credential edit that rebuilt the item from the triple alone would silently discard settings the plugin is still running on.
 *
 * @param config     - The platform configuration entry.
 * @param controller - The connection triple to write, and the address of the item to write it onto.
 *
 * @returns The `{ controllers }` patch for the session's commit to merge onto the platform entry.
 */
export const withControllerSaved = (config, { address, originalAddress, password, username }) => {

  const items = controllers(config);
  const index = (originalAddress === undefined) ? -1 : items.findIndex((item) => item?.address === originalAddress);

  if(index === -1) {

    return { controllers: [ ...items, { address, password, username } ] };
  }

  const next = [...items];

  next[index] = { ...items[index], address, password, username };

  return { controllers: next };
};

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
 *     scope sits anywhere from the second segment onward across those three, so every one of them is tested.
 *
 * The cost of reading the grammar without the catalog that names where an option ends: an Enable entry in the legacy spelling whose VALUE text happens to contain
 * a bare MAC of its own, as a whole dot-delimited segment, reads as addressing that MAC. Sweeping such an entry is the wrong call in principle and an unreachable
 * one in practice - it takes a hand-authored value carrying the exact MAC of a device on the controller being removed - and the alternative, matching the trailing
 * segment alone, would leave the legacy scoped spelling standing, which is a failure a user would actually meet.
 */
const addressesSweptScope = (entry, macs) => {

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

/* Produce the patch that removes one controller, and optionally the configuration entries scoped to the devices it brought with it.
 *
 * The two halves are deliberately separable. Dropping the item is what removal means and always happens; stripping the entries is the user's own follow-on choice,
 * because the settings they configured for those devices are worth keeping when a controller is being re-added under a new address, and worth deleting when it is
 * gone for good. An empty MAC set therefore carries no options array at all, which leaves every configured entry exactly where it was.
 *
 * @param config  - The platform configuration entry.
 * @param removal - The address of the controller to drop, and the MAC addresses whose entries to strip with it.
 *
 * @returns The patch for the session's commit to merge onto the platform entry.
 */
export const withControllerRemoved = (config, { address, macs = [] }) => {

  const remaining = controllers(config).filter((item) => item?.address !== address);

  if(!macs.length) {

    return { controllers: remaining };
  }

  // The comparison runs in lower case on both sides: the parser lowercases an entry's address before it resolves a scope, so a MAC's casing in the configuration
  // file says nothing about which scope it names.
  const swept = macs.map((mac) => String(mac).toLowerCase());

  return { controllers: remaining, options: (Array.isArray(config?.options) ? config.options : []).filter((entry) => !addressesSweptScope(entry, swept)) };
};

/* The legacy TOP-LEVEL configuration properties, each paired with the feature option that supersedes it and the kind of value it carries. These need no identity to
 * move: the option each one lands on is a plain global entry, so they migrate on the first open of any configuration that still carries them.
 *
 * The kind is declared here rather than read off the catalog because the two value properties are genuinely different types on the wire - a ring delay is a number
 * and an executable path is a string - and the compose rules turn on that difference. Log.Debug is the one landing the served catalog does not declare at all: it is
 * an undocumented diagnostic switch the plugin resolves through the same option grammar as everything else, and the engine composes a bare enable entry for a key it
 * does not recognize, which is exactly the entry the plugin's own read of it resolves.
 */
const TIER_ONE_SETTINGS = {

  debug: { kind: "flag", option: "Log.Debug" },
  ringDelay: { kind: "number", option: "Doorbell.Ring.Delay" },
  verboseFfmpeg: { kind: "flag", option: "Log.FFmpeg" },
  videoProcessor: { kind: "string", option: "Video.FFmpeg.Path" }
};

/* The legacy PER-CONTROLLER configuration properties, each paired with the feature option that supersedes it at controller scope. These cannot move on the strength
 * of the configuration alone: an option entry is addressed by the controller's MAC address, and a configuration file records only the address the plugin connects
 * to, so a controller has to actually answer before its settings have anywhere to land. The wiring probes for the MAC and hands in what it resolved; an item whose
 * controller stayed silent keeps its properties and gets another chance at the next open.
 */
const TIER_TWO_SETTINGS = {

  mqttTopic: "Mqtt.Topic",
  mqttUrl: "Mqtt.Url",
  overrideAddress: "Nvr.OverrideAddress"
};

/* The keys a controllers[] item converges to: the connection triple the plugin logs in with, and nothing else. Each item's successor is rebuilt from this list rather
 * than edited down from the original, which is what retires a key by simply never carrying it - the per-controller display name and the doorbell message presets both
 * leave that way, as does any key a hand-edit left behind that neither the plugin nor its configuration schema reads. An item key therefore deletes by OMISSION,
 * which is the opposite of how a top-level property deletes, and the migration's assertions have to read the two differently.
 */
const CONNECTION_KEYS = [ "address", "password", "username" ];

// Whether a rebuilt successor carries exactly what the item it replaces carried. This decides whether the controllers array rides the patch at all, and it is what
// makes the rewrite converge: once every item is already its own connection triple, no successor differs and a later pass leaves the array alone.
const unchanged = (item, successor) => {

  const keys = Object.keys(successor);

  return (Object.keys(item ?? {}).length === keys.length) && keys.every((key) => item[key] === successor[key]);
};

/* The configured controllers still carrying at least one per-controller legacy property, each reduced to the connection triple a caller needs in order to reach it.
 * This is what lets the wiring probe exactly the controllers whose settings still need a MAC address, and skip the network entirely once every one of them has
 * converged.
 *
 * A configuration we cannot parse answers the empty array rather than throwing, on the same terms the migration declines one: the caller's next move is a network
 * probe, and there is nothing here worth probing for.
 *
 * @param config - The platform configuration entry.
 *
 * @returns The connection triple of each controller whose per-controller settings have not migrated yet.
 */
export const controllersAwaitingMigration = (config) => {

  if(!Array.isArray(config?.controllers)) {

    return [];
  }

  const properties = Object.keys(TIER_TWO_SETTINGS);

  return config.controllers.filter((item) => properties.some((property) => item?.[property] !== undefined))
    .map((item) => ({ address: item.address, password: item.password, username: item.username }));
};

/* Build the migration over an injected feature-option engine class and the option catalog the plugin's own UI server publishes. Injecting both is what keeps this
 * module import-free and exercisable under node against the real engine and the real catalog, rather than against a stand-in that could drift from either.
 *
 * @param injected.FeatureOptions - The feature-option engine class.
 * @param injected.catalog        - The served catalog, carrying its categories and its options record.
 *
 * @returns The interpreter: the legacy-settings migration.
 */
export const makeProtectConfig = ({ FeatureOptions, catalog }) => {

  // A feature-option engine over the served catalog and the config's own entries. The array is handed in directly rather than copied: the engine's set-option path is
  // a pure transform that composes a fresh array and reassigns its own field, so the array it was given is never written to.
  const engineFor = (config) => new FeatureOptions(catalog.categories, catalog.options, Array.isArray(config?.options) ? config.options : []);

  /* The served catalog's own entry for an option name, or undefined when the catalog declares no such option. The composition is the feature-option engine's own rule
   * - a category name joined to an option name by a dot, with a nameless option addressing its category alone - stated here rather than imported because this module
   * is deliberately import-free and receives the catalog as data. Every question the migration asks of the catalog resolves through this one walk, so no two readings
   * of it can disagree.
   */
  const catalogEntry = (option) => {

    for(const [ category, entries ] of Object.entries(catalog?.options ?? {})) {

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
  const registeredDefault = (option) => catalogEntry(option)?.defaultValue;

  // Whether an option is enabled by default, which is what decides whether its registered default is already the answer the user gets. A default-on value option
  // resolves to that default when nothing is configured; a default-off one resolves to nothing at all, and the plugin falls back to a constant of its own.
  const defaultsOn = (option) => catalogEntry(option)?.default === true;

  /* Whether a top-level legacy value is an active choice worth composing as an option entry. Each kind states the one shape that qualifies: a flag composes on the
   * boolean true alone, a numeric value on a finite number above zero, and a string value on a non-empty string. Everything else deletes without composing - false,
   * zero, and the empty string all mean what an absent option already means, and a value of an uninterpretable type is a hand-edit we decline to guess at.
   *
   * The byte-equal-to-registered-default rule deliberately does not apply at this tier. Every value option landed here is off by default, so an unconfigured one
   * resolves to nothing and the plugin falls back...its registered default is the webUI's pre-fill and nothing more. A ring delay of exactly that pre-fill is a
   * working setting the user chose, and dropping it would silently stop suppressing their duplicate rings.
   */
  const composes = ({ kind, value }) => {

    switch(kind) {

      case "flag":

        return value === true;

      case "number":

        return Number.isFinite(value) && (value > 0);

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
  const composesScoped = ({ engine, mac, option, value }) => {

    if((typeof value !== "string") || !value.length || (engine.scope(option, undefined, mac) !== "none")) {

      return false;
    }

    return !defaultsOn(option) || (value !== registeredDefault(option));
  };

  return {

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
     * @param config       - The platform configuration entry.
     * @param macByAddress - The MAC address resolved for each controller address that answered a probe this pass.
     *
     * @returns The patch to commit, or null when there is nothing to do.
     */
    migrate: (config, macByAddress) => {

      if(!config || ((config.controllers !== undefined) && !Array.isArray(config.controllers)) ||
        ((config.options !== undefined) && !Array.isArray(config.options))) {

        return null;
      }

      const engine = engineFor(config);
      const patch = {};
      const successors = [];

      let composed = false;
      let rewritten = false;

      for(const [ property, { kind, option } ] of Object.entries(TIER_ONE_SETTINGS)) {

        const value = config[property];

        // A key present with the value undefined is the terminal shape this very patch produces, so it reads as absent and a second pass stages nothing for it.
        if(value === undefined) {

          continue;
        }

        patch[property] = undefined;

        if(!composes({ kind, value }) || engine.exists(option)) {

          continue;
        }

        // A flag's whole payload is the entry's existence, so it composes with no value at all; a value option carries the value the property was holding.
        engine.setOption((kind === "flag") ? { enabled: true, option } : { enabled: true, option, value });
        composed = true;
      }

      /* The per-controller tier and the controllers[] rewrite ride together, because they are one pass over the same items. Each successor is rebuilt from the
       * connection triple rather than edited down from the original, so a retired key, an unknown key, and a consumed legacy key all leave the same way: by never
       * being carried.
       */
      for(const item of config.controllers ?? []) {

        const mac = macByAddress?.get(item?.address);
        const successor = {};

        for(const key of CONNECTION_KEYS) {

          if(item?.[key] !== undefined) {

            successor[key] = item[key];
          }
        }

        for(const [ property, option ] of Object.entries(TIER_TWO_SETTINGS)) {

          const value = item?.[property];

          if(value === undefined) {

            continue;
          }

          // With no MAC address there is nowhere for this setting to land, so it stays exactly where it is rather than being dropped on the floor.
          if(!mac) {

            successor[property] = value;

            continue;
          }

          if(composesScoped({ engine, mac, option, value })) {

            engine.setOption({ enabled: true, id: mac, option, value });
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
