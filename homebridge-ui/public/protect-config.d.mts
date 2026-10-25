/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-config.d.mts: Type declarations for the pure Protect platform-configuration interpreters.
 */
import type { FeatureCategoryEntry, FeatureOptionEntry, FeatureOptions, addressListedElsewhere, addressListingForm } from "homebridge-plugin-utils";

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
  withControllerRemoved: (config: ProtectConfig | undefined, removal: { address: string; macs?: readonly string[] }) =>
    { controllers: ProtectControllerConfig[]; options?: string[] };

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

/** What a save says when the address it writes is one another configured controller already holds. */
export declare const CONTROLLER_LISTED_WARNING: string;

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

/** Map a device-list verdict onto the result the framework's device-list hook answers, writing only the copy the outcome carries. */
export declare const deviceListResult: (verdict: DeviceListVerdict) => DeviceListResult;

/**
 * Build the interpreters of the configured controller list over HBPU's listed-address rule, handed in so the module stays import-free.
 *
 * @param injected.addressListedElsewhere - HBPU's check of whether an address being saved is already listed at another position.
 * @param injected.addressListingForm     - HBPU's listing form of an address.
 *
 * @returns The interpreters of the configured controller list.
 */
export declare const makeControllerList: ({ addressListedElsewhere, addressListingForm }: { addressListedElsewhere: typeof addressListedElsewhere;
  addressListingForm: typeof addressListingForm }) => ProtectControllerList;

/**
 * Build the migration over an injected feature-option engine class, the served option catalog, and the configured controller list's reader.
 *
 * @param injected.FeatureOptions - The feature-option engine class.
 * @param injected.catalog        - The served catalog.
 * @param injected.controllers    - The configured controllers, one entry per listed address, as makeControllerList reads them.
 *
 * @returns The migration.
 */
export declare const makeProtectConfig: ({ FeatureOptions, catalog, controllers }: { FeatureOptions: typeof FeatureOptions; catalog: ProtectConfigCatalog;
  controllers: ProtectControllerList["controllers"] }) => ProtectConfigInterpreter;

/** Read the UI server's answer to a device-list request, or the rejection the request settled with, into the one verdict every reader of it shares. */
export declare const readDeviceListAnswer: (settlement: PromiseSettledResult<unknown>) => DeviceListVerdict;

/** The verdict of a sidebar entry whose controller left the configuration after the sidebar was built. */
export declare const staleSelectionVerdict: () => DeviceListVerdict;
