/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * nvr-accessory-change.ts: One accessory's add to HomeKit or removal from it, run so that its failure costs that accessory alone.
 *
 * Every add and every removal runs inside a pass over many accessories - the startup population inside login(), a membership or liveview observer's reconcile, the
 * stability sweep, a removal grace's timer - and each of those is a place where a throw does far more than fail one accessory. An observer loop that a throw leaves
 * ends for good, so its category takes no further adds or removals until a restart, a throw out of login() stops its controller until a restart, and a throw out of a
 * bare timer callback reaches Homebridge's process handler and takes the bridge down. So each add and each removal goes through this one function: it says a throw once
 * at error, in the sentence its act selects, and hands the pass back null so the pass goes on to the next accessory. The accessory whose change failed is retried by
 * whatever brings its pass around again...the next change to its category, the next stability sweep, or the next change to the flag its owner observes.
 *
 * Isolating a change is only half of retrying it safely. An owner whose setup threw has already been released by configured() before the throw reaches here, so a
 * retry stands one live instance on the accessory rather than a second beside a half-configured first.
 */
import type { HomebridgePluginLogging, Nullable } from "homebridge-plugin-utils";
import { formatErrorMessage } from "homebridge-plugin-utils";

/**
 * Options for {@link isolateAccessoryChange}.
 */
export interface AccessoryChangeOptions<T> {

  // Whether the change adds the accessory to HomeKit or removes it, which selects the sentence a failure is said in.
  act: "add" | "remove";
  // The change itself, run once.
  change: () => T;
  // The log the failure is said on: that of the owner the change belongs to, so the line carries the owner's prefix.
  log: HomebridgePluginLogging;
  // What failed, in the voice of the log it is said on: a device by its descriptor on the controller's log, an accessory by its display name, or an owner's own part
  // by its role, such as "the package camera" on the doorbell's log.
  name: string;
}

// The sentence each act says a failure in, with the name of what failed and then the error's message.
const FAILURE_SENTENCES = {

  add: "Unable to add %s to HomeKit: %s.",
  remove: "Unable to remove %s from HomeKit: %s."
} as const satisfies Record<AccessoryChangeOptions<unknown>["act"], string>;

/**
 * Run one accessory's add to HomeKit or removal from it, saying a throw once at error rather than letting it leave.
 *
 * @param options - See {@link AccessoryChangeOptions}.
 *
 * @returns What the change returned, or null when it threw.
 */
export function isolateAccessoryChange<T>(options: AccessoryChangeOptions<T>): Nullable<T> {

  const { act, change, log, name } = options;

  try {

    return change();
  } catch(error) {

    log.error(FAILURE_SENTENCES[act], name, formatErrorMessage(error));

    return null;
  }
}
