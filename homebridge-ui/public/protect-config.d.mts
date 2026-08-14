/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-config.d.mts: Type declarations for the pure Protect platform-configuration interpreters.
 */
import type { FeatureCategoryEntry, FeatureOptionEntry, FeatureOptions } from "homebridge-plugin-utils";

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
 * The commit-shaped patch the migration produces. A consumed TOP-LEVEL legacy property rides here as a PRESENT key whose value is `undefined`, never as an omitted
 * key: the session's shallow-merge commit treats those two shapes oppositely, deleting the first and leaving the second untouched, and the type system cannot state
 * that difference. Assertions about this patch must therefore read own-property presence rather than compare against `undefined`.
 *
 * A controllers[] item key deletes the other way around, by omission from the freshly rebuilt successor, which is why no per-item key appears here at all - the whole
 * array rides instead, and only when at least one item's successor differs from the item it replaces.
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
 * The migration over a fetched catalog.
 */
export interface ProtectConfigInterpreter {

  migrate(config?: ProtectConfig, macByAddress?: ReadonlyMap<string, string>): ProtectConfigPatch | null;
}

/** The configured controllers, normalized so callers never branch on undefined. */
export declare const controllers: (config?: ProtectConfig) => ProtectControllerConfig[];

/** The configured controllers still carrying a per-controller legacy property, each reduced to the connection triple needed to reach it. */
export declare const controllersAwaitingMigration: (config?: ProtectConfig) => ProtectControllerCredentials[];

/** Whether valid Protect login credentials exist for the primary controller. */
export declare const hasValidCredentials: (config?: ProtectConfig) => boolean;

/**
 * Build the migration over an injected feature-option engine class and the served option catalog.
 *
 * @param injected.FeatureOptions - The feature-option engine class.
 * @param injected.catalog        - The served catalog.
 *
 * @returns The migration.
 */
export declare const makeProtectConfig: ({ FeatureOptions, catalog }: { FeatureOptions: typeof FeatureOptions; catalog: ProtectConfigCatalog }) =>
  ProtectConfigInterpreter;

/** The primary controller entry (the first), or undefined on a fresh configuration. */
export declare const primaryController: (config?: ProtectConfig) => ProtectControllerConfig | undefined;

/**
 * The patch that removes one controller, and - when a MAC set is supplied - strips every configured entry scoped to one of those MAC addresses. An empty or absent
 * MAC set carries no `options` array at all, which is what leaves the configured entries untouched rather than rewriting them to themselves.
 */
export declare const withControllerRemoved: (config: ProtectConfig | undefined, removal: { address: string; macs?: readonly string[] }) =>
  { controllers: ProtectControllerConfig[]; options?: string[] };

/**
 * The controllers patch that writes one controller's connection triple. An `originalAddress` naming a configured item replaces that item's credentials while
 * carrying every other key it holds; an absent or unmatched one appends a new item instead.
 */
export declare const withControllerSaved: (config: ProtectConfig | undefined,
  controller: { address: string; originalAddress?: string; password: string; username: string }) => { controllers: ProtectControllerConfig[] };

/** The controllers patch that writes the supplied credentials into the primary controller, preserving any additional controllers and the primary's other fields. */
export declare const withPrimaryCredentials: (config: ProtectConfig | undefined, credentials: { address: string; password: string; username: string }) =>
  { controllers: ProtectControllerConfig[] };
