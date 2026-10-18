/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * controller-actions.d.mts: Type declarations for the settings page's controller login check, its kept controller answers, and the controller save and removal.
 */
import type { CommitConfig, SaveFlow } from "homebridge-plugin-utils";
import type { ProtectConfig, controllerListedElsewhere, readDeviceListAnswer, withControllerRemoved, withControllerSaved } from "./protect-config.mjs";

/** The host's toast surface, one function per severity a delivery can name. */
export interface HostToast {

  error: (message: string) => void;
  info: (message: string) => void;
  success: (message: string) => void;
  warning: (message: string) => void;
}

/** The sentences and the detail one login outcome shows, in the shape a card's line and a toast each read. */
export interface LoginOutcome {

  detail?: string;
  lines: string[];
}

/**
 * What the login request answers: the controller's device list when it accepted the login, the outcome to show when it did not, or retired when the action the
 * request ran under was retired before it answered.
 */
export type ControllerLogin = { devices: Record<string, unknown>[]; kind: "passed" } | { kind: "failed"; outcome: LoginOutcome } | { kind: "retired" };

/**
 * The controller login check: given a card's address and login and the signal of the action it runs under, it answers what came of validating that login. The page
 * builds one with makeControllerLogin and hands it to every surface that checks a login, the controller save among them.
 */
export type ControllerLoginRequest = (request: { address: string; password: string; signal: AbortSignal; username: string }) => Promise<ControllerLogin>;

/** The part of a connection card an action reads: its save flow, what the user has entered, and the verdict line a save's outcome and a removal's failure paint on. */
export interface ControllerCard {

  flow: SaveFlow<ProtectConfig>;
  values: () => { address: string; password: string; username: string };
  verdict: { render: (options?: { detail?: string; lines?: string[]; tone?: string }) => void };
}

/**
 * The kept controller answers as a reader may use them. Each is declared as a property carrying a function rather than as a method, which is what the module
 * actually builds - an object of arrow functions closed over the private map and its generation - so a consumer is free to read one off the handle and call it on
 * its own.
 */
export interface ControllerAnswers {

  clear: () => void;
  generation: () => number;
  get: (address: unknown) => Record<string, unknown>[] | undefined;
  keep: (fill: { address: unknown; answer: Record<string, unknown>[]; generation: number }) => boolean;
}

/**
 * What the factory answers with: the kept answers the page reads its controllers through, and the controller save and removal that write them. The save resolves to
 * the address that was written, or to null when nothing was.
 */
export interface ControllerActions {

  answers: ControllerAnswers;
  removeController: (removal: { address: string; card: ControllerCard; macs: readonly string[] }) => Promise<void>;
  saveController: (save: { card: ControllerCard; originalAddress?: string }) => Promise<string | null>;
}

/**
 * Build the settings page's kept controller answers and the controller save and removal that write them, over the page's own reach into the host, the framework,
 * and the UI-server bridge.
 *
 * @param injected.commitConfig              - The feature-options page's coordinated write, which a removal writes through.
 * @param injected.controllerListedElsewhere - The rule that answers whether another configured controller already holds the address a save writes.
 * @param injected.controllerListedWarning   - The sentence a save speaks when that rule, or the writer asking it again, refuses the save.
 * @param injected.platformConfig            - The page's read of the platform configuration it last received, or null before it has received one.
 * @param injected.processDeviceList         - The page's decoration of a login's device list into the shape the framework renders from.
 * @param injected.requestControllerLogin    - The login request, which answers whether the controller accepted a login and reports nothing itself.
 * @param injected.toast                     - The host's toast surface.
 * @param injected.withControllerRemoved     - The writer that composes a controller's removal.
 * @param injected.withControllerSaved       - The writer that composes a controller's save, answering null when another controller already holds its address.
 *
 * @returns The kept answers, the controller removal, and the controller save.
 */
export declare const makeControllerActions: (injected: {
  commitConfig: CommitConfig<ProtectConfig>;
  controllerListedElsewhere: typeof controllerListedElsewhere;
  controllerListedWarning: string;
  platformConfig: () => ProtectConfig | null;
  processDeviceList: (list: { address: string; devices: Record<string, unknown>[] }) => Record<string, unknown>[];
  requestControllerLogin: ControllerLoginRequest;
  toast: Pick<HostToast, "error" | "success" | "warning">;
  withControllerRemoved: typeof withControllerRemoved;
  withControllerSaved: typeof withControllerSaved; }) => ControllerActions;

/**
 * Build the controller login check over the UI-server bridge's request and the framework's deadline. A check that outlasts the deadline answers as the UI server's
 * failure with the deadline's own sentence as its detail, and a check whose signal aborts settles at once.
 *
 * @param injected.deadline             - The bound on one check, in seconds.
 * @param injected.readDeviceListAnswer - The one reading of the UI server's device-list answer, which the check's outcome is composed from.
 * @param injected.request              - The UI-server bridge's request, taking a path and a payload.
 * @param injected.withDeadline         - The framework's deadline, which races an await against the bound and the caller's signal.
 *
 * @returns The login check.
 */
export declare const makeControllerLogin: (injected: {
  deadline: number;
  readDeviceListAnswer: typeof readDeviceListAnswer;
  request: (path: string, payload: unknown) => Promise<unknown>;
  withDeadline: (options: { promise: Promise<unknown>; seconds: number; signal?: AbortSignal }) => Promise<unknown>; }) => ControllerLoginRequest;
