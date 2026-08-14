/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ui.mjs: Homebridge UniFi Protect webUI.
 */
"use strict";

import { controllers, controllersAwaitingMigration, hasValidCredentials, makeProtectConfig, primaryController, withControllerRemoved, withControllerSaved,
  withPrimaryCredentials } from "./protect-config.mjs";
import { FeatureOptions } from "homebridge-plugin-utils/featureOptions.js";
import { PluginConfigSession } from "homebridge-plugin-utils/pluginConfigSession.mjs";
import { webUi } from "homebridge-plugin-utils/webUi.mjs";
import { withDeadline } from "homebridge-plugin-utils/webUi-liveness.mjs";

/* The bound in seconds on the option-catalog fetch below. The bound exists so a bridge call that never settles rejects rather than wedging the cached promise for the
 * life of the session. The trade it carries: a fetch that is legitimately slow but would eventually have settled costs a retry cycle rather than resolving, which is
 * cheap beside the permanent wedge the bound prevents, because the cache clears on rejection and a later read refetches fresh. It is deliberately its own constant
 * rather than the wiring bound below, so the inner fetch and the envelope around it cannot expire together.
 */
const CATALOG_DEADLINE = 5;

/* The bound in seconds on each individual controller probe. This is not a worst-case bound and does not pretend to be one: the Protect transport caps each HTTP call
 * at three and a half seconds, and a probe's first-ever login runs up to four calls in sequence - a login attempt, a token fetch, the login retry, and then the
 * bootstrap fetch - so a genuinely worst-case login runs well past five seconds. Five admits the healthy case, where each of those answers far under its cap. A
 * controller slower than that reads as unreachable for this pass, keeps its per-controller settings, and is probed again at the next open, which is exactly the
 * posture an offline controller already gets.
 */
const PROBE_DEADLINE = 5;

/* The bound in seconds on the whole load-time wiring below. The page's own boot monitor fires its slow-boot notice and hides the spinner at ten seconds, so eight
 * settles the envelope provably inside it and a wiring step that hangs against an unresponsive host can never be what makes the settings panel look broken.
 *
 * The per-probe bounds above are what keep the realistic worst case inside this outer guard; this one exists for what they cannot cover, a catalog fetch or a session
 * open that goes pathological. An outer expiry writes nothing at all and the whole pass retries at the next open. A configuration that has already converged never
 * approaches either bound, because its envelope is the catalog fetch and the session open and nothing else.
 */
const WIRING_DEADLINE = 8;

/* The option catalog, fetched once per session from the plugin's own UI server (a local request to /getOptions, never a cloud call). The framework fetches the same
 * endpoint for its own catalog on every show cycle; the two reads are independent by design, since the framework exposes no handle to its copy. The cached promise is
 * cleared on failure so a later read retries rather than pinning a transient fault for the session, and the bound above is what makes a call that never answers into
 * a failure the clear can act on.
 */
let catalogPromise = null;

const getCatalog = () => {

  catalogPromise ??= withDeadline({ promise: homebridge.request("/getOptions"), seconds: CATALOG_DEADLINE }).then((response) => {

    // A response without the catalog shape the server publishes is a failure, not a default. Shaping it into an empty catalog would let the migration read every
    // option as unconfigured and compose entries against a catalog that never described them, so a malformed response throws and the wiring declines instead.
    if(!Array.isArray(response?.categories) || !response.categories.length || !response?.options || (typeof response.options !== "object")) {

      throw new Error("Received a malformed response from the plugin option catalog.");
    }

    return { categories: response.categories, options: response.options };
  }).catch((error) => {

    catalogPromise = null;

    throw error;
  });

  return catalogPromise;
};

// Execute our first run screen if we don't have valid Protect login credentials and a controller. The framework injects our primary platform-config entry, so this is
// a pure predicate over the persisted config rather than a reach into the feature-options page's state.
const firstRunIsRequired = ({ config }) => !hasValidCredentials(config);

// Initialize our first run screen with any information from our existing configuration. The injected config is the primary platform entry; we pre-populate the form
// from its primary controller, if one is already configured. Populating also blanks the card's verdict line, which is what a verdict a prior module copy painted
// wants: the frame and its elements outlive any single copy, so the line opens blank.
const firstRunOnStart = ({ config }) => {

  const controller = primaryController(config);

  firstRunCard.populate({ address: controller?.address ?? "", password: controller?.password ?? "", username: controller?.username ?? "" });

  return true;
};

/* The classes the login result line wears in every state. The tone rides on top of this base, so the line's blank, failure, and success states are one layout with
 * one color decision between them rather than a separate class string per state, which is what would let the states drift apart.
 */
const LOGIN_RESULT_CLASS = "hbup-result small mt-2";

/* Paint one card's login result line in the tone its outcome calls for - a Bootstrap text color, or an empty string for the blank state. Guidance sentences render
 * as text nodes separated by <br> elements, and the failure detail - when present - renders inside a <code class="text-danger"> via textContent, so a
 * controller-reported string is shown as text rather than interpreted as markup. Assembling DOM nodes here (rather than an innerHTML string) keeps that trust
 * boundary in one place, matching buildStatRow's discipline. The line keeps its height while blank, which is what stops the card from shifting under the user as a
 * validation answers.
 *
 * The row is handed in rather than looked up, because a page can hold several mounted cards at once and each one paints its own line.
 */
const renderVerdict = ({ detail = "", lines = [], row, tone = "" }) => {

  const nodes = [];

  for(const line of lines) {

    nodes.push(document.createTextNode(line), document.createElement("br"));
  }

  if(detail.length) {

    const errorCode = document.createElement("code");

    errorCode.className = "text-danger";
    errorCode.textContent = detail;
    nodes.push(errorCode);
  }

  row.className = tone.length ? (LOGIN_RESULT_CLASS + " " + tone) : LOGIN_RESULT_CLASS;
  row.replaceChildren(...nodes);
};

/* Validate a controller login against the UI server and paint the outcome, shared by every card's validate control, every card's Save, and the first-run submit
 * so none of them can drift apart. The browser cannot reach the Protect controller directly, so the request bridges through the plugin's UI server. Returns the
 * discovered device list on
 * success and null on any failure - a missing field, a rejected login, or a request that threw - with the result line already painted for every outcome but
 * success, whose message belongs to the caller (the validate control says so in words; the submit moves straight on to committing).
 *
 * The verdict surface arrives from the card that asked, so a page holding several cards paints each answer on the card it belongs to and no card's slow response
 * can paint over another's.
 */
const requestControllerLogin = async ({ address, password, username, verdict }) => {

  // This request is the newest the moment it starts: the bump retires any response still in flight, and the value it answers is what this request's own resolution
  // checks against below. Whatever the last validation said is stale now too, so the line is blanked before the call rather than after it - a call that never
  // resolves must not leave an older verdict standing beside newer input.
  const generation = verdict.invalidate();

  if(!address?.length || !username?.length || !password?.length) {

    verdict.render({ lines: ["Please enter a valid UniFi Protect controller address, username and password."], tone: "text-danger" });

    return null;
  }

  try {

    const { devices, error } = await homebridge.request("/getDevices", { address: address, password: password, username: username });

    // A reopened panel mints a successor copy of this module, and an edit or a newer request retires this one within it - either way, a retired request must not
    // paint over what the copy or the request the user is looking at is showing.
    if(ui.epochSignal.aborted || !verdict.isCurrent(generation)) {

      return null;
    }

    // Couldn't connect to the Protect controller. The two guidance sentences frame the failure and the controller-sourced error detail arrives with the device-list
    // response, rendered as text so it is never interpreted as markup.
    if(!devices?.length) {

      verdict.render({ detail: error, lines: [ "Unable to login to the UniFi Protect controller.", "Please check your controller address, username, and password." ],
        tone: "text-danger" });

      return null;
    }

    return devices;
  } catch(err) {

    // A retired request's failure is nobody's news - the epoch and generation rules above govern this paint too.
    if(ui.epochSignal.aborted || !verdict.isCurrent(generation)) {

      return null;
    }

    // The UI server failing to start or respond lands here. Painting into the result line keeps the user on the form with the specific failure, while the
    // framework's toast stays the generic net for consumers without their own handling.
    verdict.render({ detail: (err instanceof Error) ? err.message : String(err), lines: ["Unable to validate your controller login."], tone: "text-danger" });

    return null;
  }
};

// Validate our Protect credentials and commit them.
const firstRunOnSubmit = async ({ commit, config }) => {

  const { address, password, username } = firstRunCard.values();

  const devices = await requestControllerLogin({ address, password, username, verdict: firstRunCard.verdict });

  if(!devices) {

    homebridge.hideSpinner();

    return false;
  }

  try {

    // Persist the validated credentials through the session's single write hook. We own the shape of the write - credentials live under the primary controller, which
    // withPrimaryCredentials encodes while preserving any additional controllers - and the session owns persistence and the preservation of sibling platform entries.
    await commit(withPrimaryCredentials(config, { address, password, username }));

    return true;
  } catch(err) {

    // The config write can reject. Painting into the result line keeps the user on the form with concrete guidance and the specific failure, and this catch resolves
    // first, so the framework's generic toast never fires for this plugin.
    firstRunCard.verdict.render({ detail: (err instanceof Error) ? err.message : String(err), lines: ["Unable to complete the plugin configuration."],
      tone: "text-danger" });
    homebridge.hideSpinner();

    return false;
  }
};

// The Protect API represents the controller itself as a device whose model key is "nvr" - every other model key belongs to a device the controller manages.
const isController = (device) => device.modelKey === "nvr";

/* The platform configuration the framework last injected into one of our hooks, or null before the first of them runs.
 *
 * The framework re-reads the host configuration into its own session immediately before it calls these hooks, so what is held here is the configuration the page
 * itself is working from rather than a snapshot taken at load. The docked editors populate their fields from it, which is a read the framework's render path gives
 * them no other way to make: the info-panel and connection-error bags carry the selection, not the configuration behind it.
 *
 * Nothing WRITES through this copy. Every write opens a session of its own and commits against what that session reads, so a stale copy here can only ever show a
 * stale field value in a collapsed card, never persist one.
 */
let injectedConfig = null;

/* Each controller address's device list, as this session last fetched it and already processed for the framework to render. One answer serves every reader that
 * needs it, which is why what is kept is the processed list rather than any narrower derivative of it: the device view returns it on every re-entry, a removal
 * derives from it the
 * MAC addresses a settings sweep would strip, and the sidebar reads the controller's own name from it. A controller login and bootstrap costs a user five to twenty
 * seconds of dead air, and almost nothing about a controller changes between one re-entry and the next, so that price is paid once per address per session and the
 * Refresh control is how a user asks to pay it again.
 *
 * Only an answer that actually arrived is ever kept. A fetch that fails answers no devices at all and writes nothing here, so the connection-error view and the
 * framework's own retry cycle always act on a live attempt rather than on a hopeful memory of one. The map lives as long as this module copy, which is the page's
 * own lifetime, so a reopened panel connects afresh.
 */
const devicesByAddress = new Map();

/* The generation the map above is on, bumped by every event that retires what it holds: a controller saved, a controller removed, and the Refresh control. A fetch
 * captures this value before it calls the bridge and compares it after, writing only when the two still agree.
 *
 * The bridge offers no cancellation, so a fetch issued before an invalidation cannot be recalled and would otherwise be free to land its pre-invalidation answer
 * afterwards - the same supersession problem a card's login verdict solves the same way. A retired fill costs one extra fetch at the next selection, where a stale
 * serve would cost the rest of the session. One counter covers every address deliberately: its only failure mode is that extra fetch, and a counter nobody can
 * misindex beats a map of counters somebody can.
 */
let cacheGeneration = 0;

/* Add the fields the webUI framework renders from, and mark the controller entry with the address the plugin reached it at. It touches the device records and
 * nothing on the page, which is what lets both writers into the map above run it: the device view's own fetch, and a save re-seeding from the answer its validation
 * just received. One helper is what keeps those two from processing the same list into two different shapes.
 */
const processDeviceList = ({ address, devices }) => {

  for(const device of devices) {

    device.name ??= device.marketName;
    device.serialNumber = device.mac;
    device.sidebarGroup = device.modelKey + "s";

    /* Stamp the configured address onto the controller entry, which is what lets the docked editor find the configuration item this node stands for. The
     * serialNumber the framework correlates on has just been overwritten with the MAC above, and a configuration file records the address the plugin connects to
     * and never a MAC, so the two can never be matched to each other - the stamp is the only thing carrying that correspondence across.
     */
    if(isController(device)) {

      device.hbupConfigAddress = address;
    }
  }

  return devices;
};

/* Show a controller's own name on its sidebar entry, which is something only a controller we have connected to can tell us - the configuration records an address
 * and the sidebar has nothing else to label the entry with until then. Every device fetch runs this, whether the list came off the wire or out of the map above: a
 * served list re-asserts the same string, and one uniform path is worth more than the assignment a divergent fast path would save.
 */
const patchControllerLabel = ({ address, devices }) => {

  const controllerDevice = devices.find(isController);

  if(!controllerDevice) {

    return;
  }

  const activeController = [...document.querySelectorAll("[data-navigation='controller']")].find((c) => c.getAttribute("data-device-serial") === address);

  if(activeController) {

    activeController.textContent = controllerDevice.name;
  }
};

// Return the list of controllers from our plugin configuration, paired with a clean connection outcome - the list is configuration-derived, so no fetch is involved
// and no failure can occur. The framework injects our primary platform-config entry; we map each configured controller to the sidebar shape, deliberately carrying
// no credentials into the rendered list.
const getControllers = ({ config }) => {

  injectedConfig = config;

  /* Close an open Add Controller card here, which is the one place that covers every way the view can be rebuilt underneath it. Every rebuild routes through this
   * hook - a menu round trip's show(), an explicit refreshControllers(), and the connection-error view's own Retry, which re-enters show() without touching a menu
   * button - so closing here needs no per-path wiring and can miss none of them. The card's region is outside the framework's own reveal cycle, so its lifetime is
   * ours to end: a rebuild discards whatever was typed into it, which is what a view rebuilding out from under an unsaved form should do.
   */
  closeControllerEditor();

  /* Each entry is labeled with the controller's own name once this session has heard it, and with the configured address until then. The device list this session
   * already fetched is where that name comes from, so a repaint of the sidebar arrives carrying the same labels the user was already reading rather than reverting
   * every entry to its raw address until a controller is selected again.
   */
  return {

    controllers: controllers(config).map((controller) => ({ name: devicesByAddress.get(controller.address)?.find(isController)?.name ?? controller.address,
      serialNumber: controller.address })),
    error: ""
  };
};

// Return the list of devices associated with a given Protect controller, paired with the connection outcome. The framework injects the live platform config alongside
// the selected controller, so we can recover the selected controller's credentials (which the sidebar entries deliberately omit) without reaching for the config
// ourselves. A connection failure travels back on the result rather than through a separate request.
const getDevices = async (selectedController, { config }) => {

  injectedConfig = config;

  // The global context legitimately has no devices and no failure.
  if(!selectedController) {

    return { devices: [], error: "" };
  }

  // Find the entry in our plugin configuration. A sidebar entry can outlive a Settings-tab edit that removed its controller, so a miss is a carried failure with an
  // actionable message rather than a silent empty result that would render nothing the user can act on.
  const controller = controllers(config).find((c) => c.address === selectedController.serialNumber);

  if(!controller) {

    return { devices: [], error: "The selected controller is no longer in the plugin configuration." };
  }

  const cached = devicesByAddress.get(controller.address);

  // A controller this session has already reached answers from what it said then, ahead of any bridge call at all. Every tab re-entry and every re-select passes
  // through here, and repeating a full login and bootstrap for each of them is the wait the user notices most, for data that is almost never different.
  if(cached) {

    patchControllerLabel({ address: controller.address, devices: cached });

    return { devices: cached, error: "" };
  }

  // The generation this fetch belongs to, read before the call and checked against after it, so an answer that an invalidation has overtaken can complete without
  // being kept.
  const generation = cacheGeneration;

  // The browser cannot reach the Protect controller directly, so we bridge the request through the plugin's UI server, which holds the controller credentials. The
  // server returns the device list and the connection error together.
  const { devices, error } = await homebridge.request("/getDevices", { address: controller.address, password: controller.password, username: controller.username });

  processDeviceList({ address: controller.address, devices });
  patchControllerLabel({ address: controller.address, devices });

  // Remember what this controller answered with, so every later re-entry is served from it. A fetch that failed answers no devices at all and is never kept, which
  // is what keeps the connection-error view and its retry acting on live attempts; an answer a save or a removal overtook while it was in flight is dropped for the
  // same reason, at the cost of one more fetch the next time this controller is selected.
  if(devices.length && (generation === cacheGeneration)) {

    devicesByAddress.set(controller.address, devices);
  }

  return { devices, error };
};

// Only show feature options that are valid for the capabilities of this device.
const validOption = (device, option) => {

  // Each device's capability metadata takes a different shape, so five independent meta-gates test for exclusion below, and any one hiding the option is
  // enough: hasAccessFeature reads the Access device's feature flags, hasFeature reads the Protect device's feature flags, hasProperty checks whether the
  // named property is merely present on the device, modelKey compares the device's own model against the option's supported models, and hasSmartObjectType
  // compares the device's smart-detection capabilities against the option's supported smart-object types.
  if(device && (device.modelKey !== "nvr") && (
    (option.meta?.hasAccessFeature && (!device.accessDeviceMetadata?.featureFlags ||
      !option.meta?.hasAccessFeature.some(x => device.accessDeviceMetadata.featureFlags[x]))) ||
    (option.meta?.hasFeature && (!device.featureFlags || !option.meta?.hasFeature.some(x => device.featureFlags[x]))) ||
    (option.meta?.hasProperty && !option.meta?.hasProperty.some(x => x in device)) ||
    (option.meta?.modelKey && (option.meta?.modelKey !== "all") && !option.meta?.modelKey.includes(device.modelKey)) ||
    (option.meta?.hasSmartObjectType && device.featureFlags?.smartDetectTypes &&
      !option.meta?.hasSmartObjectType.some(x => device.featureFlags.smartDetectTypes.includes(x))))) {

    return false;
  }

  // Test for the explicit exclusion of a property if it's true.
  if(device && option.meta?.isNotProperty?.some(x => device[x] === true)) {

    return false;
  }

  // Test for device class-specific features and properties.
  switch(device?.modelKey) {

    case "camera":

      if(option.meta?.hasCameraFeature && !option.meta?.hasCameraFeature.some(x => device.featureFlags[x])) {

        return false;
      }

      break;

    case "light":

      if(option.meta?.hasLightProperty && !option.meta?.hasLightProperty.some(x => x in device)) {

        return false;
      }

      break;

    case "sensor":

      if(option.meta?.hasSensorProperty && !option.meta?.hasSensorProperty.some(x => x in device)) {

        return false;
      }

      break;

    default:

      break;
  }

  return true;
};

// Only show feature option categories that are valid for a particular device type.
const validOptionCategory = (device, category) => {

  // Always show all options at the global and controller level.
  if(!device || (device?.modelKey === "nvr")) {

    return true;
  }

  // Only show device categories we're explicitly interested in.
  if(!category.meta?.modelKey?.some(model => [ "all", device.modelKey ].includes(model))) {

    return false;
  }

  // Test for the explicit exclusion of a property if it's true.
  if(category.meta?.isNotProperty?.some(x => device[x] === true)) {

    return false;
  }

  // Test for the feature availability on a specific device type.
  if(category.meta?.featureByModel?.[device.modelKey]?.some(x => !device.featureFlags?.[x])) {

    return false;
  }

  return true;
};

/* Build one row of the device-stats grid. We construct DOM nodes directly via createElement / textContent rather than concatenating into innerHTML so any HTML
 * metacharacter in a device field (model, MAC address, IP address) renders as text instead of being interpreted as markup. The discovery boundary is the trust line,
 * and treating controller-reported strings as data rather than HTML is the cleanest place to enforce it.
 */
const buildStatRow = (label, value, valueClassName) => {

  const item = document.createElement("div");

  item.className = "stat-item";

  const labelSpan = document.createElement("span");

  labelSpan.className = "stat-label";
  labelSpan.textContent = label;

  const valueSpan = document.createElement("span");

  valueSpan.className = valueClassName;
  valueSpan.textContent = value ?? "";

  item.append(labelSpan, valueSpan);

  return item;
};

// The number of cards this module copy has mounted, which is what makes each clone's field ids unique within the page.
let cardInstances = 0;

/* Mount one connection card into a caller's container and hand back the surface that caller drives it through.
 *
 * One card serves every place a controller's connection is entered or edited, so the markup lives in a template and each caller mounts a clone of it. A clone
 * cannot carry the ids the template would otherwise hold - two mounted cards would answer the same lookup and each label would point at whichever field the
 * document happened to reach first - so every element is addressed by a data attribute and each field is given an id of this instance's own, with the label that
 * names it pointed at that id so the association survives cloning.
 *
 * The caller declares what it offers by supplying handlers: a card with no onSave shows no Save control, and one with no onRemove shows no Remove. Validation is
 * the exception and is always offered, because it costs nothing and is the whole reason a user can find out whether a login works before committing it.
 *
 * @param options.container      - The element the card mounts into, whose children it replaces.
 * @param options.heading        - The card's heading, null for no heading at all, or absent to keep the template's own wording.
 * @param options.helper         - The card's explanatory line, on the same terms as the heading.
 * @param options.noSweepReason  - What the removal confirmation says when there are no device settings it can offer to strip.
 * @param options.onCancel       - Invoked by the Cancel control, when the caller offers one.
 * @param options.onRemove       - Invoked with the MAC addresses to strip once a removal is confirmed, when the caller offers removal.
 * @param options.onSave         - Invoked by the Save control, when the caller offers one.
 * @param options.signal         - The caller's own lifecycle, when it has one. The card's teardown composes with it.
 *
 * @returns The card's surface: close, populate, values, and the verdict line.
 */
const mountConnectionCard = ({ container, heading, helper, noSweepReason = "", onCancel, onRemove, onSave, signal }) => {

  const card = document.getElementById("hbupConnectionCard").content.firstElementChild.cloneNode(true);
  const fields = {};
  const instance = ++cardInstances;

  for(const field of card.querySelectorAll("[data-field]")) {

    const name = field.dataset.field;

    field.id = "hbupCard" + instance + "-" + name;
    card.querySelector("[data-label-for='" + name + "']").htmlFor = field.id;
    fields[name] = field;
  }

  // Every selector below reads an attribute this module's own template wrote, never anything a user or a controller supplied, so the composition is not a place
  // untrusted text can reach.
  const control = (action) => card.querySelector("[data-action='" + action + "']");
  const removeConfirm = card.querySelector("[data-role='removeConfirm']");
  const row = card.querySelector("[data-role='verdict']");

  // The card's own teardown, composed with whatever lifetime the caller gave it, so a caller that closes its card retires the card's wiring without disturbing
  // anything else the caller registered.
  const teardown = new AbortController();
  const cardSignal = signal ? AbortSignal.any([ signal, teardown.signal ]) : teardown.signal;

  /* The generation of this card's newest login validation. It belongs to the card rather than to the module so two mounted cards cannot invalidate each other's
   * verdicts: each request captures the value as it starts and checks it after resolving, so only the newest request ON THIS CARD can paint - an older response
   * that loses the race discards itself rather than painting over what newer input or a newer request has put on screen. An edit bumps the generation too, which
   * is what keeps a slow verdict from landing beside input it no longer describes. The UI-server bridge carries no abort surface, so supersession is enforced at
   * the paint rather than on the wire.
   */
  let generation = 0;

  // The MAC addresses a removal would offer to strip settings for, as the caller's last population named them.
  let removalMacs = [];

  const verdict = {

    // Retire any validation still in flight, blank the line, and answer the generation this card is now on.
    invalidate: () => {

      renderVerdict({ row });

      return ++generation;
    },

    // Whether a validation that started at the supplied generation is still the newest one this card issued.
    isCurrent: (mark) => mark === generation,
    render: (options = {}) => renderVerdict({ ...options, row })
  };

  // Put the removal confirmation away. Every path that changes what the card is describing takes it back to its unarmed state, so a confirmation can never outlive
  // the controller it was naming.
  const disarmRemoval = () => removeConfirm.classList.add("d-none");

  /* Arm the removal confirmation, naming the controller in words rather than in a browser dialog. The sweep is offered as the follow-on choice it is: the settings
   * a user configured for a controller's devices are worth keeping when that controller is coming back under a new address, and worth deleting when it is gone for
   * good, and only the user knows which. Without a device list there is nothing to offer, so the card says why instead of pretending the choice exists.
   */
  const armRemoval = () => {

    const sweepable = removalMacs.length > 0;

    card.querySelector("[data-role='removePrompt']").textContent = "Remove " + fields.address.value + " from this plugin? " + (sweepable ?
      "You can also delete every feature option that was set for this controller and the devices it brought with it." : noSweepReason);
    control("removeSwept").classList.toggle("d-none", !sweepable);
    removeConfirm.classList.remove("d-none");
  };

  // The caller's own framing, where it wants something other than the first-run wording the template carries. A caller that wants no framing at all passes null,
  // which takes the element out of the flow rather than leaving an empty line of space behind.
  for(const [ role, copy ] of [ [ "heading", heading ], [ "helper", helper ] ]) {

    if(copy === undefined) {

      continue;
    }

    const element = card.querySelector("[data-role='" + role + "']");

    element.classList.toggle("d-none", !copy);
    element.textContent = copy ?? "";
  }

  const surface = {

    // Retire the card's wiring and take it off the page. Only a caller whose card is transient calls this; the docked cards live as long as the mount that
    // created them and are torn down by the mount signal instead.
    close: () => {

      teardown.abort();
      card.remove();
    },

    /* Fill the card in from a configured controller, and name what a removal would strip alongside it. Populating is also what disarms a standing removal
     * confirmation and blanks the verdict line: both describe whatever the card was showing a moment ago, and the card is now describing something else.
     */
    populate: ({ address, macs = [], password, username }) => {

      fields.address.value = address;
      fields.password.value = password;
      fields.username.value = username;
      removalMacs = macs;

      disarmRemoval();
      verdict.invalidate();
    },

    // What the user has typed, which is what every validation and every write reads.
    values: () => ({ address: fields.address.value, password: fields.password.value, username: fields.username.value }),
    verdict
  };

  // Each masked credential's reveal, bound from the markup itself: a toggle declares the field it serves, so the card grows a reveal without this wiring changing.
  for(const toggle of card.querySelectorAll("[data-reveal]")) {

    ui.on(toggle, "click", () => toggleReveal({ input: fields[toggle.dataset.reveal], toggle }), { signal: cardSignal });
  }

  // An edit to any credential retires the verdict standing beside it, so the line never describes anything but the current input.
  for(const field of Object.values(fields)) {

    ui.on(field, "input", () => verdict.invalidate(), { signal: cardSignal });
  }

  ui.on(control("validate"), "click", () => void onValidateLogin({ button: control("validate"), card: surface }), { signal: cardSignal });

  if(onCancel) {

    control("cancel").classList.remove("d-none");
    ui.on(control("cancel"), "click", onCancel, { signal: cardSignal });
  }

  if(onSave) {

    control("save").classList.remove("d-none");
    ui.on(control("save"), "click", () => void onSave(), { signal: cardSignal });
  }

  if(onRemove) {

    control("remove").classList.remove("d-none");
    ui.on(control("remove"), "click", armRemoval, { signal: cardSignal });
    ui.on(control("removeCancel"), "click", disarmRemoval, { signal: cardSignal });

    ui.on(control("removeConfirmed"), "click", () => {

      disarmRemoval();
      void onRemove({ macs: [] });
    }, { signal: cardSignal });

    ui.on(control("removeSwept"), "click", () => {

      disarmRemoval();
      void onRemove({ macs: removalMacs });
    }, { signal: cardSignal });
  }

  container.replaceChildren(card);

  return surface;
};

/* Validate a card's login and persist it, which is the whole of what Save means.
 *
 * Validation comes first and a failure writes nothing at all: a controller the plugin cannot log into is not a configuration worth saving, and the card's own
 * verdict line already says why. The write then opens a session of its own rather than riding the feature-options page's long-lived one, because that page's
 * session is driven by its debounced option-persist effect and a card has no business staging anything behind it.
 *
 * The re-entry through refreshControllers() at the end is a correctness step rather than a repaint. The page's own session holds a replica of the configuration
 * that its option-persist effect writes from, and a save through an independent session leaves that replica describing the controllers as they were - so the next
 * option edit would quietly write the pre-save controller list back over this one. Re-entry re-reads the host configuration into that session before it repaints.
 * The window it cannot close is the instant between this commit and that re-read: an option edit whose debounce flushes inside it can still clobber, the same
 * in-flight instant every write on this page carries.
 *
 * @returns The address that was written, or null when nothing was.
 */
const saveController = async ({ card, originalAddress }) => {

  const { address, password, username } = card.values();
  const devices = await requestControllerLogin({ address, password, username, verdict: card.verdict });

  if(!devices) {

    return null;
  }

  try {

    const session = await PluginConfigSession.open({ host: homebridge, name: webUiParams.name });

    // The epoch is read immediately before the write, and again after it, on the same terms the load-time wiring reads it: a reopened panel retires this copy, and
    // a retired copy must not write configuration underneath the copy the user is looking at.
    if(ui.epochSignal.aborted) {

      return null;
    }

    await session.commit(withControllerSaved(session.platform, { address, originalAddress, password, username }));

    if(ui.epochSignal.aborted) {

      return null;
    }

    await homebridge.savePluginConfig();
  } catch(err) {

    card.verdict.render({ detail: (err instanceof Error) ? err.message : String(err), lines: ["Unable to save this controller."], tone: "text-danger" });

    return null;
  }

  card.verdict.render({ lines: ["This controller has been saved."], tone: "text-success" });

  /* What this session remembers about the controllers is now a write behind, so the generation moves and every fetch still in flight loses its claim to be kept.
   * An address change also strands whatever was remembered under the address the user replaced, which names nothing the configuration holds any more; the Add
   * Controller path has no previous address and strands nothing.
   */
  cacheGeneration++;

  if(originalAddress && (originalAddress !== address)) {

    devicesByAddress.delete(originalAddress);
  }

  /* The address that was just written is then re-seeded from this save's own validation, which logged into the controller with exactly these credentials moments
   * ago and came back with its device list. That is newer than anything a deletion would have left behind, so the repaint below labels the entry with the
   * controller's live name rather than falling back to the raw address, and the next selection is served rather than reconnecting.
   */
  devicesByAddress.set(address, processDeviceList({ address, devices }));

  await ui.featureOptions.refreshControllers();

  return address;
};

/* Remove a controller from the configuration, with the settings sweep the user chose.
 *
 * The write closes with the same re-entry Save makes, for the same reason, and then lands the page on the global view. That landing is not cosmetic: the node the
 * page was showing has just left the configuration, and the sidebar repaint replaces the controller list without moving the selection, so a page left alone would
 * go on showing a controller that no longer exists. The framework's own Global Options link is the affordance for that, so the landing is a click on the page's
 * own navigation rather than a reach into state the framework owns.
 */
const removeController = async ({ address, card, macs }) => {

  try {

    const session = await PluginConfigSession.open({ host: homebridge, name: webUiParams.name });

    if(ui.epochSignal.aborted) {

      return;
    }

    await session.commit(withControllerRemoved(session.platform, { address, macs }));

    if(ui.epochSignal.aborted) {

      return;
    }

    await homebridge.savePluginConfig();
  } catch(err) {

    card.verdict.render({ detail: (err instanceof Error) ? err.message : String(err), lines: ["Unable to remove this controller."], tone: "text-danger" });

    return;
  }

  // The controller is gone from the configuration, so what this session remembered about it goes with it, and the generation moves so a fetch that was already in
  // flight for that address cannot put it back. The settings sweep read its MAC addresses long before this, when the card was populated.
  cacheGeneration++;
  devicesByAddress.delete(address);

  await ui.featureOptions.refreshControllers();

  document.querySelector("#controllersContainer .nav-link[data-navigation='global']")?.click();
};

/* Mount a card that edits a controller already in the configuration, in whichever home the caller names.
 *
 * Each home differs in where it sits and in what a removal can offer, and in nothing else. The docked editor rides a reachable controller's own stats panel
 * and can strip the settings of every device that controller answered with; the editor the connection-error view hosts reaches a controller the page cannot talk
 * to at all, where no device list exists and removal is offered on its own. Both correlate to a configuration item by address, both validate before they write,
 * and both follow the address they wrote so a second save edits the same item rather than appending a duplicate beside it.
 *
 * @param options.collapsible   - Whether the card sits behind a disclosure the user opens, which the docked editor does and the error-view editor does not.
 * @param options.container     - The element this editor owns entirely, including its visibility.
 * @param options.heading       - The card's heading, on the card factory's own terms.
 * @param options.helper        - The card's explanatory line, on the card factory's own terms.
 * @param options.noSweepReason - What a removal says when it has no device settings to offer to strip.
 * @param options.signal        - The mount's lifecycle signal.
 * @param options.sweepable     - Whether a removal may offer to strip the controller's device settings.
 *
 * @returns The editor's surface: the per-render call that shows, hides, and re-populates it.
 */
const mountControllerEditor = ({ collapsible = false, container, heading, helper, noSweepReason, signal, sweepable = false }) => {

  const slot = document.createElement("div");

  if(collapsible) {

    const disclosure = document.createElement("details");
    const summary = document.createElement("summary");

    summary.textContent = "Controller connection settings";
    disclosure.append(summary, slot);
    container.replaceChildren(disclosure);
  } else {

    container.replaceChildren(slot);
  }

  // The configured address this card currently stands for, which is the item a save writes onto and a removal drops.
  let configAddress = null;

  const card = mountConnectionCard({

    container: slot,
    heading,
    helper,
    noSweepReason,
    onRemove: ({ macs }) => removeController({ address: configAddress, card, macs }),
    onSave: async () => {

      const saved = await saveController({ card, originalAddress: configAddress });

      // The card now stands for the address it just wrote. Following it is what keeps an address change an edit: without this, a second save would look for the
      // address the user replaced, find nothing, and append a duplicate controller beside the one it meant to edit.
      if(saved !== null) {

        configAddress = saved;
      }
    },
    signal
  });

  return {

    render: (address) => {

      // Nothing to edit: the render is a device or the global view, or the page has no controller in scope at all.
      if(!address) {

        container.classList.add("d-none");

        return;
      }

      container.classList.remove("d-none");
      configAddress = address;

      const item = controllers(injectedConfig).find((controller) => controller?.address === address);

      /* The MAC addresses a removal could offer to strip are read out of this controller's remembered device list here rather than stored beside it, so the one
       * answer this session holds is the only thing describing what a controller brought with it. A controller this session never reached has nothing remembered
       * and offers removal without the sweep, which is the case the card's own no-sweep wording is written for.
       */
      card.populate({

        address: address,
        macs: sweepable ? (devicesByAddress.get(address)?.map((device) => device.mac).filter((mac) => typeof mac === "string") ?? []) : [],
        password: item?.password ?? "",
        username: item?.username ?? ""
      });
    }
  };
};

/* The card the framework's connection-error view hosts, paired with the mount it belongs to, or null before the first error render.
 *
 * This is the one path that reaches a controller the page cannot talk to, and those are exactly the controllers a user most needs to fix or remove: a wrong
 * password, a changed address, or a console that is off all leave the controller stranded at the error view, which every other editing surface sits behind.
 */
let errorPanel = null;

// Render our own panel inside the framework's connection-error view. The panel element and the signal are the mount's own and arrive unchanged on every error
// render, so the card is built once and re-populated afterwards, exactly as the docked editor is.
const showControllerErrorPanel = ({ controller, panel, signal }) => {

  if(errorPanel?.signal !== signal) {

    // The compact-card class keys the page's style block, so this card's controls render at the panel's own type rhythm rather than the full-size card scale.
    panel.classList.add("hbup-compact-card");

    errorPanel = { editor: mountControllerEditor({

      container: panel,
      heading: "Controller connection settings",
      helper: "Update this controller's address or login, or remove it from this plugin.",
      noSweepReason: "This controller cannot be reached, so the feature options set for its devices cannot be identified and will be left in place.",
      signal
    }), signal };
  }

  // A controller-less error render - a configuration read that failed, or a controller list that never arrived - has nothing for this card to edit.
  errorPanel.editor.render(controller?.serialNumber ?? null);
};

/* The two sub-containers this hook renders through, paired with the mount they belong to, or null before the first render of the session.
 *
 * The framework hands the same panel element to every render of one mount and never clears it between mounts, so the pair is built once per mount - keyed on the
 * mount's own signal, which is the device-info view's stated once-ness idiom - and REPLACES whatever the panel is holding rather than appending to it. A superseded
 * mount's pair from an earlier show() cycle would otherwise accumulate beneath the new one, since the framework's own clear excludes this container.
 *
 * Splitting the panel is what lets two kinds of content share the region without one wiping the other. The stats region describes the current selection and is
 * rebuilt every time that selection moves; the dock beside it holds content whose lifetime is the mount's rather than the selection's, so the per-render rebuild
 * must never reach it.
 */
let detailsPanel = null;

// Show the details for this device.
const showProtectDetails = ({ device, panel, signal }) => {

  if(detailsPanel?.signal !== signal) {

    const dock = document.createElement("div");
    const statsRegion = document.createElement("div");

    // The compact-card class keys the page's style block, so the standing editor's controls render at the panel's own type rhythm rather than the full-size
    // card scale.
    dock.className = "hbup-compact-card";

    panel.replaceChildren(statsRegion, dock);

    detailsPanel = { editor: mountControllerEditor({

      collapsible: true,
      container: dock,
      heading: null,
      helper: "Update this controller's address or login, or remove it from this plugin.",
      noSweepReason: "This controller has not answered with a device list in this session, so the feature options set for its devices cannot be identified and " +
        "will be left in place.",
      signal,
      sweepable: true
    }), signal, statsRegion };
  }

  const { editor, statsRegion } = detailsPanel;

  /* The docked editor rides the controller's own node and nothing else. A controller render shows it, collapsed, and re-populates it from the configuration; a
   * device render and the global render both leave it out of sight, because a device is not a thing whose login can be edited. It is created once per mount and
   * only toggled here, which is what keeps its wiring alive across the selection changes that rebuild the stats grid beside it.
   */
  editor.render((device && isController(device)) ? (device.hbupConfigAddress ?? null) : null);

  // No device specified, we must be in a global context.
  if(!device) {

    statsRegion.textContent = "";

    return;
  }

  // Compute the IP-address value: cameras and most devices report a host. A device without one is reached over LoRa (SuperLink) or, for a sensor specifically, over
  // Bluetooth. The relay is a LoRa device but reports a null connectionType on the wire, so we key it by model instead; everything else reports none.
  const isSuperLink = (device.connectionType === "lora") || (device.modelKey === "relay");

  const ipValue = device.host ?? (isSuperLink ? "SuperLink Device" : ((device.modelKey === "sensor") ? "Bluetooth Device" : "None"));

  // Compute the status value: title-case the device state when present, otherwise report a connected controller.
  const statusValue = ("state" in device) ? (device.state.charAt(0).toUpperCase() + device.state.slice(1).toLowerCase()) : "Connected";

  // Build the device-details grid fresh so successive selections do not stack stale rows.
  const grid = document.createElement("div");

  grid.className = "device-stats-grid";
  grid.append(

    buildStatRow("Model", device.marketName ?? device.type, "stat-value"),
    buildStatRow("MAC Address", device.mac, "stat-value fo-monospace"),
    buildStatRow("IP Address", ipValue, "stat-value fo-monospace"),
    buildStatRow("Status", statusValue, "stat-value")
  );

  statsRegion.replaceChildren(grid);
};

// Parameters for our feature options webUI.
const featureOptionsParams = {

  connectionErrorPanel: showControllerErrorPanel,
  getControllers: getControllers,
  getDevices: getDevices,
  infoPanel: showProtectDetails,
  sidebar: {

    controllerLabel: "Protect Controllers",

    /* The refresh action the framework docks on the controller-list heading. Reloading the world is one generation bump and one cleared map: the handler is
     * invalidation and nothing more, because the framework owns everything around it - the re-entry through its own show(), the boot affordance that clothes the
     * refetch, and the control's in-flight state. The selection landing back on the first controller is what reloading costs, the same landing every framework
     * re-entry makes.
     */
    refresh: {

      label: "Refresh controllers",
      onRefresh: () => {

        cacheGeneration++;
        devicesByAddress.clear();
      }
    }
  },
  ui: {

    // The delay before the connection-error view re-enables its retry button, overriding the library's five-second default. A UniFi Protect controller can take well
    // over five seconds to authenticate and return its bootstrap, so twenty seconds keeps an impatient user from hammering retry while the first connection attempt is
    // still in flight.
    // The copy the framework's boot affordance shows while a controller connection is in flight, in place of its generic default.
    connectingMessage: "Connecting to your UniFi Protect controller...",
    // The guidance line for a controller that cannot be reached, pointing at the connection editor mounted beneath the error rather than at a tab the reader is
    // already on.
    controllerFailureGuidance: "You can correct this controller's connection details below, or retry.",
    controllerRetryEnableDelayMs: 20000,
    isController: isController,
    validOption: validOption,
    validOptionCategory: validOptionCategory
  }
};

// Parameters for our plugin webUI.
const webUiParams = {

  featureOptions: featureOptionsParams,
  firstRun: {

    isRequired: firstRunIsRequired,
    onStart: firstRunOnStart,
    onSubmit: firstRunOnSubmit
  },
  name: "UniFi Protect"
};

// Instantiate the webUI.
const ui = new webUi(webUiParams);

/* Adopt the framework's theming for this page - the design tokens, the themed canvas, the dark-mode corrections, the page-kit classes, and the host's own accent -
 * with one call that holds for as long as this module copy owns the window. Theming is a page concern rather than a view one, so the first-run page, the
 * feature-options view, and the support tab all wear it from here. The promise is voided rather than awaited because the framework owns its rejection posture: a
 * failed initial lighting-mode read still leaves the sheets adopted and the host's theme signals followed, so the next announcement the host makes brings the page
 * into step.
 */
void ui.registerTheming();

/* Validate a card's controller login on demand. It is early feedback and nothing else: every path that commits anything - the first-run submit, a card's own Save -
 * validates the login through this same helper first, so a user who never presses the control is no worse off, and one who does learns whether their login works
 * before committing a configuration.
 */
const onValidateLogin = async ({ button, card }) => {

  button.disabled = true;

  try {

    const devices = await requestControllerLogin({ ...card.values(), verdict: card.verdict });

    // The epoch signal is read after the await: a reopened panel mints a successor copy of this module, and a retired copy must not paint over what the copy the
    // user is looking at is showing. The helper paints every failure itself, so only the success verdict is ours to say.
    if(ui.epochSignal.aborted || !devices) {

      return;
    }

    card.verdict.render({ lines: ["Your UniFi Protect controller login is valid."], tone: "text-success" });
  } finally {

    // The re-enable is unconditional, superseded copy or not: the invocation that disabled the control is the only thing that can balance its own disable.
    button.disabled = false;
  }
};

// A reveal toggle's accessible name, naming what the NEXT click will do rather than what the field is doing now, which is what a control announced as a button
// wants to say. The subject is the field's own plain name, so each toggle on the page announces which credential it acts on.
const revealLabel = (subject, revealed) => (revealed ? "Hide the " : "Show the ") + subject + ".";

/* Flip one masked credential between hidden and shown. A toggle names the field it serves and the subject its accessible name uses on its own data attributes, so a
 * field gains a reveal by carrying a button in the markup rather than by growing a handler of its own.
 *
 * The field's type, the toggle's accessible name, and its pressed state describe one state between them, so they are written together and no path can move one and
 * leave the others saying something else. Nothing here touches a value: whether a secret is on screen right now says nothing about the configuration.
 */
const toggleReveal = ({ input, toggle }) => {

  const revealed = input.type === "password";

  input.type = revealed ? "text" : "password";
  toggle.setAttribute("aria-label", revealLabel(toggle.dataset.revealSubject, revealed));
  toggle.setAttribute("aria-pressed", revealed ? "true" : "false");
};

/* The first-run page's own card, mounted into the slot the template vacated. It is mounted here rather than at first-run start because the page's markup is present
 * before this module loads while the first-run hooks run later, so one mount at load serves every call the framework makes into them afterwards.
 */
const firstRunCard = mountConnectionCard({ container: document.getElementById("hbupFirstRunCard") });

/* The card the Add Controller affordance opens, or null when the affordance is closed.
 *
 * Its region sits outside the framework's own reveal cycle, so nothing the framework does opens or closes it and its whole lifetime is ours. That is why it closes
 * on every exit path rather than being left standing: an unsaved card that survived a view rebuild would be describing a page that no longer exists behind it.
 */
let addCard = null;

// Put the Add Controller card away and give the feature-options view back its main content, discarding whatever was typed into it. Closing an already-closed
// affordance is nothing at all, which is what lets every exit path call it without first asking whether it is open.
const closeControllerEditor = () => {

  if(!addCard) {

    return;
  }

  addCard.close();
  addCard = null;

  document.getElementById("hbupControllerEditor").style.display = "none";
  document.getElementById("hbupFeatureContent").style.display = "";
};

/* Open a blank card as the whole of the feature-options view's main content.
 *
 * The framework's own regions are hidden by hiding the wrapper this plugin put around them, never by writing on the regions themselves: the framework sets their
 * display on its own teardown-and-reveal schedule, and two writers on one element would eventually disagree. Hiding a wrapper of our own leaves everything the
 * framework wrote exactly as it wrote it, so restoring the view is a single assignment and the framework never notices the card was there.
 */
const openControllerEditor = () => {

  const region = document.getElementById("hbupControllerEditor");

  // A second click while the affordance is already open would otherwise mount a second card over the first and leak the first one's wiring.
  closeControllerEditor();

  addCard = mountConnectionCard({

    container: region,
    heading: "Add a UniFi Protect controller",
    helper: "Enter the controller's address and a local user's login. The login is validated against the controller before anything is saved.",
    onCancel: () => closeControllerEditor(),
    onSave: () => saveController({ card: addCard, originalAddress: undefined })
  });

  document.getElementById("hbupFeatureContent").style.display = "none";
  region.style.display = "";
};

/* Wire the plugin's own page controls. Every binding registers through the facade, so a superseded module copy's handlers die when a newer copy claims the window.
 *
 * The lookups hand their result straight to the facade: a nullish target declares that surface absent, so registering against a control this page's markup omits
 * is the facade's own documented no-op and costs that control's wiring alone.
 */
ui.on(document.getElementById("hbupAddController"), "click", () => openControllerEditor());

/* A sidebar navigation click closes the Add Controller card, so choosing somewhere else to be takes effect at once rather than at the next rebuild. The rebuild
 * paths close it too, at the controller hook they all pass through; this is for the immediacy the rebuild cannot give, since navigating within an already-rendered
 * view rebuilds nothing. The binding is delegated from the plugin's own column, so it survives every repaint the framework makes to the sidebar inside it.
 */
ui.on(document.getElementById("hbupSidebarColumn"), "click", (event) => {

  if(event.target.closest(".nav-link[data-navigation]")) {

    closeControllerEditor();
  }
});

// The load-time wiring's own lifecycle. Aborting it is how an envelope that failed or expired tells a continuation still running underneath it that it must not stage
// anything after the fact.
const wiringController = new AbortController();

/* The signal the wiring's cancellation points read: the envelope's own controller, bounded by this module copy's claim on the window. The epoch half matters because
 * a reopened settings panel mints a successor copy and retires this one, so whichever of the two aborts first cancels a superseded copy's wiring at the same
 * chokepoints the deadline uses, rather than letting a retired copy write configuration underneath the copy the user is looking at.
 */
const wiringSignal = ui.epochBounded(wiringController.signal);

/* Run the legacy-settings migration, once, at load.
 *
 * The envelope is awaited here rather than at module top, so the page's chrome arms immediately instead of waiting on a bridge round trip. ui.show() runs only after
 * the envelope settles, which is the ordering that matters: the framework opens its own configuration session inside the launch path ui.show() starts, so every
 * replica it hands to a hook - the first-run config, the feature-options page's persist path - is read after the migration has settled, and none of them can commit
 * a pre-migration snapshot over it.
 *
 * A migration that composes a patch persists it itself, without waiting for the user to press Save. Most people never open this panel to save anything, so a
 * migration that waited for one would leave a fleet split between two configuration shapes indefinitely, and the plumbing that reconciles them could never retire.
 * The write is gated on there being a patch, which is what bounds the cost: only a pass that actually found legacy settings writes at all, so a converged
 * configuration's every later open finds nothing to do and reaches neither the controllers nor the disk.
 *
 * Reopening the panel is convergent. Each open imports a fresh copy of this module whose wiring runs independently, and a copy reading an already-migrated
 * configuration composes nothing and writes nothing. Two genuinely simultaneous wirings are where the honest bound sits: they read the same configuration but may
 * resolve different sets of reachable controllers, so their patches need not be identical and the later commit is the one that stands. Nothing is lost to that -
 * whatever the earlier pass migrated is still sitting in the configuration the later one read, and the next open migrates it again.
 *
 * One further bound, stated plainly: the check before the commit is the last cancellation point. A commit whose bridge round trip is already in flight cannot be
 * recalled, because the session takes no signal and the deadline bounds only the await, so composing the epoch into the signal narrows the stale-write window to
 * that in-flight instant rather than closing it.
 *
 * When the envelope fails, nothing has been written and the page loads exactly as it otherwise would. No read this webUI performs consults the consolidated
 * settings - first run reads the connection triple, which stays in the configuration file - so a session whose fetches are failing still routes, still runs first
 * run, and simply leaves the migration to a session whose fetches succeed.
 */
const wireProtectConfig = async () => {

  const protectConfig = makeProtectConfig({ FeatureOptions, catalog: await getCatalog() });

  // The library's session is the single conduit the framework's own writes use, so the patch merges onto a replica synced just now rather than onto a snapshot taken
  // before the page opened. The name seeds the primary platform entry, and it is read from the same constant the framework is configured with so the two cannot drift.
  const session = await PluginConfigSession.open({ host: homebridge, name: webUiParams.name });

  /* Resolve a MAC address for each controller whose per-controller settings still need one. The probes run in parallel because each performs a full controller login
   * and bootstrap, and serializing them would multiply the open-time wait by the number of controllers configured.
   *
   * Each probe is bounded individually, and that is what delivers the per-controller isolation the migration depends on. A deadline bounds only the await - the
   * request itself cannot be recalled - so without a per-probe bound a single slow or hung controller would stall the shared wait past the envelope, abort the
   * wiring, and discard the ENTIRE pass, the top-level settings and every other controller's resolved work included, on every open until that one controller sped up.
   * Bounded, it costs nobody but itself. A probe that throws, that reports a login failure, that answers no devices, or that its own deadline overtakes contributes
   * no entry at all, and the controller it names simply keeps its settings for another day.
   */
  const macByAddress = new Map();

  await Promise.all(controllersAwaitingMigration(session.platform).map(async ({ address, password, username }) => {

    const response = await withDeadline({ promise: homebridge.request("/getDevices", { address, password, username }), seconds: PROBE_DEADLINE,
      signal: wiringSignal }).catch(() => null);

    // The controller reports itself as a device whose model key is "nvr", so it is found by that key rather than by its position in the list.
    const mac = response?.devices?.find(isController)?.mac;

    if(mac) {

      macByAddress.set(address, mac);
    }
  }));

  const patch = protectConfig.migrate(session.platform, macByAddress);

  // The signal is read immediately before the write, so an envelope that expired while the probes were still running - or a copy the window has retired - cannot
  // stage a patch after the fact.
  if(patch && !wiringSignal.aborted) {

    await session.commit(patch);

    // The signal is read a second time, because the commit itself was an await and the envelope may have expired across it. A save the deadline overtakes is skipped
    // rather than forced, which leaves the migration staged for the user's own save - the weaker outcome, and the honest one.
    if(!wiringSignal.aborted) {

      await homebridge.savePluginConfig();
    }
  }
};

try {

  await withDeadline({ promise: wireProtectConfig(), seconds: WIRING_DEADLINE, signal: wiringSignal });
} catch(error) {

  wiringController.abort(error);
}

// Display the webUI.
ui.show();
