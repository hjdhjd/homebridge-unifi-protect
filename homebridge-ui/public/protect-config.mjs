/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-config.mjs: Pure interpreters over the injected Protect platform configuration.
 */
"use strict";

/* The single home for our plugin-config shape. Every function here is a pure interpreter of the primary platform-config entry the webUI framework injects into our
 * hooks - no I/O, no global reach. The framework owns reading and writing the persisted config through its session; this module owns the Protect-specific knowledge
 * of what a controller is and where credentials live. Keeping that knowledge in one place means a config-shape change is a single edit, and it keeps every hook in
 * ui.mjs a declarative one-liner over these helpers.
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
// initialization is needed. Returned as a `{ controllers }` patch for the session's commit seam to merge onto the platform entry.
export const withPrimaryCredentials = (config, { address, password, username }) => {

  const next = [...controllers(config)];

  next[0] = { ...next[0], address, password, username };

  return { controllers: next };
};
