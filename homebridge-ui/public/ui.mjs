/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ui.mjs: Homebridge UniFi Protect webUI.
 */
"use strict";

import { CONTROLLER_LISTED_WARNING, controllerListedElsewhere, controllers, controllersAwaitingMigration, deviceListResult, hasValidCredentials, makeProtectConfig,
  primaryController, primaryListedElsewhere, readDeviceListAnswer, staleSelectionVerdict, withControllerRemoved, withControllerSaved, withPrimaryCredentials }
  from "./protect-config.mjs";
import { createActionGuard, withDeadline } from "homebridge-plugin-utils/webUi-liveness.mjs";
import { makeControllerActions, makeControllerLogin } from "./controller-actions.mjs";
import { FeatureOptions } from "homebridge-plugin-utils/featureOptions.js";
import { PluginConfigSession } from "homebridge-plugin-utils/pluginConfigSession.mjs";
import { createSaveFlow } from "homebridge-plugin-utils/webui/saveflow.js";
import { webUi } from "homebridge-plugin-utils/webUi.mjs";

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

/* The bound in seconds on a controller login check. The Protect transport caps each HTTP call, and a first login runs several calls in sequence, so the bound sits
 * well past a slow login and is reached only by a check whose answer is not coming. A check that outlasts it answers as the UI server's failure, carrying the
 * deadline's own sentence, rather than leaving the card waiting on a request that never settles.
 */
const LOGIN_DEADLINE = 30;

// Execute our first run screen if we don't have valid Protect login credentials and a controller. The framework injects our primary platform-config entry, so this is
// a pure predicate over the persisted config rather than a reach into the feature-options page's state.
const firstRunIsRequired = ({ config }) => !hasValidCredentials(config);

// Initialize our first run screen with any information from our existing configuration. The injected config is the primary platform entry; we pre-populate the form
// from its primary controller, if one is already configured.
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

// The controller login check every card's validate control, every card's Save, and the first-run submit share, bounded by LOGIN_DEADLINE. The bridge's request is
// reached through a closure rather than handed over as a reference, because the method reads its own object.
const requestControllerLogin = makeControllerLogin({ deadline: LOGIN_DEADLINE, readDeviceListAnswer, request: (path, body) => homebridge.request(path, body),
  withDeadline });

// Validate our Protect credentials and commit them.
const firstRunOnSubmit = async ({ commit, config }) => {

  const { address, password, username } = firstRunCard.values();
  const action = firstRunCard.verdict.start();

  /* An address a controller after the primary already holds is refused before the login check, by the rule a controller save is refused under, because the
   * answer needs no controller and the user should not wait on a login whose result would be thrown away. The card's action is started first, as a save's is,
   * so a validation still in flight cannot paint over the refusal.
   */
  if(primaryListedElsewhere(config, { address })) {

    firstRunCard.verdict.render({ lines: [CONTROLLER_LISTED_WARNING], tone: "text-warning" });

    return false;
  }

  const login = await requestControllerLogin({ address, password, signal: action.signal, username });

  // A failed login is delivered through the action the submit started, which paints while the card presents it, and a retired one says nothing.
  if(login.kind !== "passed") {

    if(login.kind === "failed") {

      action.report({ ...login.outcome, tone: "text-danger" });
    }

    return false;
  }

  try {

    // Persist the validated credentials through the session's single write hook. We own the shape of the write - credentials live under the primary controller, which
    // withPrimaryCredentials encodes while preserving the additional controllers the configured list holds - and the session owns persistence and the preservation of
    // sibling platform entries.
    await commit(withPrimaryCredentials(config, { address, password, username }));

    return true;
  } catch(err) {

    // The config write can reject. Painting into the result line keeps the user on the form with concrete guidance and the specific failure, and this catch resolves
    // first, so the framework's generic toast never fires for this plugin.
    firstRunCard.verdict.render({ detail: (err instanceof Error) ? err.message : String(err), lines: ["Unable to complete the plugin configuration."],
      tone: "text-danger" });

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
 * Nothing WRITES through this copy. A save or a removal composes against the configuration the page's coordinated write hands its composer at the moment of the
 * write, and the load-time migration against what its own session reads, so a stale copy here never persists. A save's listed-address check does read it, ahead
 * of the login check, so a stale copy can refuse a save the composer would accept, which the user retries once the page has caught up. It can never let a
 * duplicate through, because the composer asks the same rule of the configuration the write composes over, and its refusal is the one that decides.
 */
let injectedConfig = null;

/* Add the fields the webUI framework renders from, and mark the controller entry with the address the plugin reached it at. It touches the device records and
 * nothing on the page, which is what lets every filler of the kept controller answers run it: the device view's own fetch, and a save seeding from the answer its
 * login just received. One helper is what keeps them from processing the same list into shapes that differ.
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
 * and the sidebar has nothing else to label the entry with until then. Every device fetch runs this, whether the list came off the wire or out of the kept
 * answers: a served list re-asserts the same string, and one uniform path is worth more than the assignment a divergent fast path would save.
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

/* The settings page's kept controller answers and the controller save and removal that write them, built once for this page copy. Everything those actions reach
 * outside themselves is handed in from here, because each of those reaches is the page's to own: the framework's coordinated write, the host's toast, the login
 * request over the UI-server bridge, the configuration the page last received, the configuration writers, the listed-address rule and its sentence, and the
 * device-list processing. What the actions keep about each controller stays theirs, and the page reads it back through the handle alone.
 */
// The page's coordinated write, stated once and handed to the controller actions and to each card's save flow. It is reached through a closure rather than
// handed over as a reference, because the framework page is constructed further down and the method reads its own object: taking the reference at call time
// is what binds it to the page that exists by then.
const commitConfig = (compose, options) => ui.featureOptions.commitConfig(compose, options);

const { answers, removeController, saveController } = makeControllerActions({

  commitConfig,
  controllerListedElsewhere,
  controllerListedWarning: CONTROLLER_LISTED_WARNING,
  platformConfig: () => injectedConfig,
  processDeviceList,
  requestControllerLogin,
  toast: homebridge.toast,
  withControllerRemoved,
  withControllerSaved
});

// Return the list of controllers from our plugin configuration, paired with a clean connection outcome - the list is configuration-derived, so no fetch is involved
// and no failure can occur. The framework injects our primary platform-config entry; we map each configured controller to the sidebar shape, deliberately carrying
// no credentials into the rendered list.
const getControllers = ({ config }) => {

  injectedConfig = config;

  /* Each entry is labeled with the controller's own name once this session has heard it, and with the configured address until then. The device list this session
   * already fetched is where that name comes from, so a repaint of the sidebar arrives carrying the same labels the user was already reading rather than reverting
   * every entry to its raw address until a controller is selected again.
   */
  return {

    controllers: controllers(config).map((controller) => ({ name: answers.get(controller.address)?.find(isController)?.name ?? controller.address,
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

  // Find the entry in our plugin configuration. A sidebar entry can outlive a Settings-tab edit that removed its controller, so a miss is a carried failure whose
  // copy names what became of the entry and what to do about it, rather than a silent empty result that would render nothing the user can act on.
  const controller = controllers(config).find((c) => c.address === selectedController.serialNumber);

  if(!controller) {

    return deviceListResult(staleSelectionVerdict());
  }

  const cached = answers.get(controller.address);

  // A controller this session has already reached answers from what it said then, ahead of any bridge call at all. Every tab re-entry and every re-select passes
  // through here, and repeating a full login and bootstrap for each of them is the wait the user notices most, for data that is almost never different.
  if(cached) {

    patchControllerLabel({ address: controller.address, devices: cached });

    return { devices: cached, error: "" };
  }

  // The generation this fetch belongs to, read before the call and checked against after it, so an answer that an invalidation has overtaken can complete without
  // being kept.
  const generation = answers.generation();

  /* The browser cannot reach the Protect controller directly, so we bridge the request through the plugin's UI server, which holds the controller credentials. The
   * server returns the device list and the connection error together. A request the bridge rejects is read too rather than thrown at the framework, whose copy for
   * a hook that throws sends the user after the controller when the fault is the UI server's own.
   */
  const [settled] = await Promise.allSettled([homebridge.request("/getDevices", { address: controller.address, password: controller.password,
    username: controller.username })]);
  const verdict = readDeviceListAnswer(settled);

  processDeviceList({ address: controller.address, devices: verdict.devices });
  patchControllerLabel({ address: controller.address, devices: verdict.devices });

  // Offer what this controller answered for keeping, so every later re-entry is served from it. Whether it is worth keeping is the kept answers' own rule.
  answers.keep({ address: controller.address, answer: verdict.devices, generation });

  return deviceListResult(verdict);
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
 * @param options.onSave         - Invoked by the Save control, when the caller offers one. A card offering a Save carries the save flow its presses run through.
 * @param options.removalAddress - A read of the configured address the card stands for, which a removal acts on and its confirmation names, when the caller offers
 *                                 removal.
 * @param options.signal         - The caller's own lifecycle, when it has one. The card's teardown composes with it.
 *
 * @returns The card's surface: close, its save flow or null, populate, values, and the verdict line.
 */
const mountConnectionCard = ({ container, heading, helper, noSweepReason = "", onCancel, onRemove, onSave, removalAddress, signal }) => {

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

  /* This card's latest-action-wins guard over its validations, including the one every Save runs before it writes. It belongs to the card rather than to the
   * module so two mounted cards cannot retire each other's actions: each action takes the guard's signal as it starts and reads it after resolving, so only the
   * newest action ON THIS CARD acts on its answer - an older one that loses the race discards itself rather than painting over what newer input or a newer action
   * has put on screen, and a Save waiting on it writes nothing. An edit retires the action in flight too, which is what keeps a slow verdict from landing beside
   * input it no longer describes.
   *
   * The guard has no parent, because only this card's own acts retire an action: an edit, a Validate press, or another Save. Closing the card, hiding it, or
   * populating it with another controller is moving on rather than retiring, so none of them stops a pressed Save, which goes on to write if its check passes;
   * where each answer lands is the presentation rule start() states below. The UI-server bridge carries no abort surface, so a retired request still runs to its
   * answer and is dropped there rather than cancelled on the wire.
   */
  const guard = createActionGuard();

  // The population the card is presenting, which every populate moves on. An action captures it when it starts, which is how the card tells an answer about what it
  // shows now from an answer about what it showed when the action began.
  let population = 0;

  // The MAC addresses a removal would offer to strip settings for, as the caller's last population named them.
  let removalMacs = [];

  const verdict = {

    render: (options = {}) => renderVerdict({ ...options, row }),

    // Retire any action still in flight without starting another, and blank the line. An edit calls for this, because the verdict standing there describes input the
    // card no longer holds.
    retire: () => {

      renderVerdict({ row });
      guard.cancel();
    },

    /* Blank the line and begin an action, answering its signal, whether the card presents it, and the paint that lands an outcome on the line only while it does.
     * The card presents an action while the card is open, the action has not been retired, the card still holds the population it held when the action began, and
     * the line is on screen, all read at the moment it is asked or an outcome is painted. A validation's outcome that the card no longer presents is dropped,
     * because nothing it found changed anything. A Save delivers through its save flow instead, which reads this same rule and raises the host's toast where the
     * paint would drop, because the Save writes whether or not anyone is still looking at its card.
     *
     * Whether the line is on screen is read at delivery rather than tracked, because a card leaves the screen without closing in many ways, and most of them run
     * none of this page's code: a device selection hides the docked editor, a disclosure collapses over it, another tab hides the whole view, and the
     * connection-error view's panel is detached when the framework leaves that view. checkVisibility() answers false for every one of them - a detached element, a
     * display: none ancestor, and hidden content alike.
     */
    start: () => {

      renderVerdict({ row });

      const signal = guard.start();
      const startedUnder = population;
      const presented = () => !cardSignal.aborted && !signal.aborted && (population === startedUnder) && row.checkVisibility();

      return {

        presented,
        report: (outcome) => {

          if(presented()) {

            renderVerdict({ ...outcome, row });
          }
        },
        signal
      };
    }
  };

  /* This card's save flow, built once beside its guard when the caller offers a Save. The flow's one piece of state across presses is whether a write is in flight,
   * so a flow belongs to the card it serves: a press during this card's write starts nothing and the card's Save control is not pressable for that span, while
   * another card's write refuses nothing here. It begins each press through the card's own starter, so a Save retires and is retired by the card's other actions
   * exactly as they retire each other, and it delivers each outcome under the presentation rule that starter answers.
   */
  const flow = onSave ? createSaveFlow({

    commit: commitConfig,
    control: control("save"),
    start: verdict.start,
    toast: homebridge.toast
  }) : null;

  // Put the removal confirmation away. Every path that changes what the card is describing takes it back to its unarmed state, so a confirmation can never outlive
  // the controller it was naming.
  const disarmRemoval = () => removeConfirm.classList.add("d-none");

  /* Arm the removal confirmation, naming the controller in words rather than in a browser dialog. The name is the configured address the removal acts on, read as
   * the confirmation arms, rather than whatever the address field holds, so an unsaved edit of the field cannot make the prompt name one controller while the
   * removal drops another. The sweep is offered as the follow-on choice it is: the settings a user configured for a controller's devices are worth keeping when
   * that controller is coming back under a new address, and worth deleting when it is gone for good, and only the user knows which. Without a device list there
   * is nothing to offer, so the card says why instead of pretending the choice exists.
   */
  const armRemoval = () => {

    const sweepable = removalMacs.length > 0;

    card.querySelector("[data-role='removePrompt']").textContent = "Remove " + removalAddress() + " from this plugin? " + (sweepable ?
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

    // The save flow this card's Save presses run through, or null for a card that offers no Save.
    flow,

    /* Fill the card in from a configured controller, and name what a removal would strip alongside it. Populating is also what disarms a standing removal
     * confirmation and blanks the verdict line: both describe whatever the card was showing a moment ago, and the card is now describing something else. It moves
     * the card to a new population and retires nothing, so an action still in flight goes on and the presentation rule in start() decides where its answers land.
     */
    populate: ({ address, macs = [], password, username }) => {

      fields.address.value = address;
      fields.password.value = password;
      fields.username.value = username;
      removalMacs = macs;
      population++;

      disarmRemoval();
      renderVerdict({ row });
    },

    // What the user has typed, which is what every validation and every write reads.
    values: () => ({ address: fields.address.value, password: fields.password.value, username: fields.username.value }),
    verdict
  };

  // Each masked credential's reveal, bound from the markup itself: a toggle declares the field it serves, so the card grows a reveal without this wiring changing.
  for(const toggle of card.querySelectorAll("[data-reveal]")) {

    toggle.addEventListener("click", () => toggleReveal({ input: fields[toggle.dataset.reveal], toggle }), { signal: cardSignal });
  }

  // An edit to any credential retires the verdict standing beside it, so the line never describes anything but the current input.
  for(const field of Object.values(fields)) {

    field.addEventListener("input", () => verdict.retire(), { signal: cardSignal });
  }

  control("validate").addEventListener("click", () => void onValidateLogin({ button: control("validate"), card: surface }), { signal: cardSignal });

  if(onCancel) {

    control("cancel").classList.remove("d-none");
    control("cancel").addEventListener("click", onCancel, { signal: cardSignal });
  }

  if(onSave) {

    control("save").classList.remove("d-none");
    control("save").addEventListener("click", () => void onSave(), { signal: cardSignal });
  }

  if(onRemove) {

    control("remove").classList.remove("d-none");
    control("remove").addEventListener("click", armRemoval, { signal: cardSignal });
    control("removeCancel").addEventListener("click", disarmRemoval, { signal: cardSignal });

    control("removeConfirmed").addEventListener("click", () => {

      disarmRemoval();
      void onRemove({ macs: [] });
    }, { signal: cardSignal });

    control("removeSwept").addEventListener("click", () => {

      disarmRemoval();
      void onRemove({ macs: removalMacs });
    }, { signal: cardSignal });
  }

  container.replaceChildren(card);

  return surface;
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

      const edited = configAddress;
      const saved = await saveController({ card, originalAddress: edited });

      /* The card now stands for the address it just wrote. Following it is what keeps an address change an edit: without this, a second save would look for the
       * address the user replaced, find nothing, and append a duplicate controller beside the one it meant to edit. A save outlives a repopulation, so the card
       * follows only while it still stands for the item this save edited...once it has been pointed at another controller, following would aim that controller's
       * next save or removal at the item this one wrote.
       */
      if((saved !== null) && (configAddress === edited)) {

        configAddress = saved;
      }
    },
    removalAddress: () => configAddress,
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
        macs: sweepable ? (answers.get(address)?.map((device) => device.mac).filter((mac) => typeof mac === "string") ?? []) : [],
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

// Render a wire identifier as picker copy: split the camelCase joins and the underscores, then capitalize each word. It answers for any value whose catalog entry
// carries no curated display name, which makes it the browser-side twin of the plugin's own smartDetectLabel fallback (src/options.ts) - a change to the rule
// belongs in both. Local to this file and deliberately small, matching the device-status formatter above rather than reaching for a dependency the page does not
// otherwise carry.
const humanizeChoice = (value) => value.replace(/_/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(" ").filter((word) => word.length)
  .map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");

// Parameters for our feature options webUI.
const featureOptionsParams = {

  connectionErrorPanel: showControllerErrorPanel,
  getControllers: getControllers,
  getDevices: getDevices,
  infoPanel: showProtectDetails,
  sidebar: {

    controllerLabel: "Protect Controllers",

    /* The refresh action the framework docks on the controller-list heading. Reloading the world is clearing the kept controller answers: the handler is
     * invalidation and nothing more, because the framework owns everything around it - the re-entry through its own show(), the boot affordance that clothes the
     * refetch, and the control's in-flight state. The selection landing back on the first controller is what reloading costs, the same landing every framework
     * re-entry makes.
     */
    refresh: {

      label: "Refresh controllers",
      onRefresh: () => answers.clear()
    }
  },
  ui: {

    // The choice sources our catalog names, each resolving the list its picker offers for whatever is currently in view. Every one runs on each projection recompute
    // and must be pure, cheap, and incapable of throwing - a resolver that throws after the page has booted fails silently, taking its picker's list with it.
    choices: {

      /* The outputs a relay reports, named the way the relay itself names them and stored as the 1-based numbers the user sees on the switches. A record carrying an
       * outputs array answers that relay's own outputs, which is what lets a relay of any size offer every output it has; every other shape answers the pair the
       * catalog entry carries, the editable surface the global and controller scopes have always had.
       */
      relayOutputs: ({ device, option }) => {

        const outputs = device?.outputs;

        if(!Array.isArray(outputs)) {

          return (option?.meta?.choiceDomain ?? []).map((value) => ({ label: "Output " + value, value: value }));
        }

        return outputs.filter((output) => Number.isInteger(output?.id)).map((output) => ({

          label: (typeof output.name === "string") && output.name.length ? output.name : ("Output " + (output.id + 1).toString()),
          value: (output.id + 1).toString()
        }));
      },

      /* The detection types a camera reports. A record carrying a featureFlags block with either detection array answers that camera's own types, since a picker
       * should offer what the hardware in view actually detects. Every other shape - the global scope, where there is no device at all, and the controller record the
       * page selects on load - answers the domain the catalog entry carries, because those scopes were editable when each detection type had a feature option of its
       * own and a control with nothing in it would quietly take that away.
       *
       * Either domain reads its copy from the catalog entry's own label map, so the picker offers the same display names the logs and the HomeKit accessories use.
       * A type the map does not name is one a newer controller firmware reports, and the humanizing rule renders it readably.
       */
      smartDetectTypes: ({ device, option }) => {

        const flags = device?.featureFlags;
        const audioTypes = flags?.smartDetectAudioTypes;
        const objectTypes = flags?.smartDetectTypes;
        const reported = Array.isArray(audioTypes) || Array.isArray(objectTypes);
        const domain = reported ? [ ...(Array.isArray(audioTypes) ? audioTypes : []), ...(Array.isArray(objectTypes) ? objectTypes : []) ] :
          (option?.meta?.choiceDomain ?? []);

        return domain.filter((value) => typeof value === "string")
          .map((value) => ({ label: option?.meta?.choiceLabels?.[value] ?? humanizeChoice(value), value: value }))
          .sort((a, b) => a.label.localeCompare(b.label));
      }
    },

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
 * with one call that holds for the life of the page. Theming is a page concern rather than a view one, so the first-run page, the feature-options view, and the
 * support tab all wear it from here. The promise is voided rather than awaited because the framework owns its rejection posture: a failed initial lighting-mode read
 * still leaves the sheets adopted and the host's theme signals followed, so the next announcement the host makes brings the page into step.
 */
void ui.registerTheming();

/* Validate a card's controller login on demand. It is early feedback and nothing else: every path that commits anything - the first-run submit, a card's own Save -
 * validates the login through this same helper first, so a user who never presses the control is no worse off, and one who does learns whether their login works
 * before committing a configuration.
 */
const onValidateLogin = async ({ button, card }) => {

  button.disabled = true;

  try {

    const action = card.verdict.start();
    const login = await requestControllerLogin({ ...card.values(), signal: action.signal });

    // Every outcome is said through the same action the check ran under, so an answer about a controller the card has moved on from, or about a card that has left
    // the screen, is dropped rather than painted where nobody asked for it.
    switch(login.kind) {

      case "passed": {

        action.report({ lines: ["Your UniFi Protect controller login is valid."], tone: "text-success" });

        break;
      }

      case "failed": {

        action.report({ ...login.outcome, tone: "text-danger" });

        break;
      }

      // A retired login belongs to an action a newer act on the card already replaced, so it says nothing at all.
      default: {

        break;
      }
    }
  } finally {

    // The re-enable is unconditional: the invocation that disabled the control is the only thing that can balance its own disable.
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

/* The takeover handle the open Add Controller card holds the page's content area with, or null when the affordance is closed.
 *
 * The card stands in the content area through the framework's takeover, so the framework hides and restores its own regions around the card and ends the takeover
 * itself when the user moves the selection in the sidebar, another open takes the area, or the page cycle ends - a navigate-away, or a write that re-enters the
 * page. A save or a removal the page re-establishes in place leaves it standing. Whatever ends it, the handle's abort is the one place this reference is cleared
 * and the card torn down, so no exit path can leave the reference naming a card that is gone.
 */
let addCardTakeover = null;

// Put the Add Controller card away by giving the page's content area back, discarding whatever was typed into it. With no card open there is no takeover to
// release, so every exit path can call this without first asking whether the affordance is open.
const closeControllerEditor = () => {

  addCardTakeover?.release();
};

/* Open a blank card as the whole of the feature-options view's main content.
 *
 * The card is handed to the framework's takeover inside an element of its own, made fresh for each open and carrying the compact-card class the page's style
 * block keys on, and the framework hides its own regions while the card holds the area and restores them when the takeover ends. The handle's signal is the
 * card's lifetime, so the card's listeners leave with the takeover however it ends. A second open takes the area again and the framework ends the first card's
 * takeover as it does, so the area passes from one card to the next with no flash of the page beneath.
 */
const openControllerEditor = () => {

  const element = document.createElement("div");

  element.className = "hbup-compact-card";

  const takeover = ui.featureOptions.takeover(element);

  const card = mountConnectionCard({

    container: element,
    heading: "Add a UniFi Protect controller",
    helper: "Enter the controller's address and a local user's login. The login is validated against the controller before anything is saved.",
    onCancel: () => closeControllerEditor(),
    onSave: async () => {

      const saved = await saveController({ card, originalAddress: undefined });

      /* A save that wrote something gives the area back itself, whatever the write did to the page: an in-place re-establishment leaves the takeover standing, and
       * a re-entry has already ended it, where the release does nothing. It releases this card's own handle rather than going through the close above, because the
       * save resolves after an await and by then the area may belong to a later open.
       */
      if(saved !== null) {

        takeover.release();
      }
    },
    signal: takeover.signal
  });

  addCardTakeover = takeover;

  // Every end of the takeover arrives here as one abort - this plugin's own release, a sidebar selection, a later open, or the page cycle ending - so the reference
  // is cleared and the card torn down along a single path whichever of them it was.
  takeover.signal.addEventListener("abort", () => {

    addCardTakeover = null;
    card.close();
  }, { once: true });
};

// Wire the plugin's own page controls. The controls are part of this page's markup and live as long as the page does, so their listeners carry no signal.
document.getElementById("hbupAddController").addEventListener("click", () => openControllerEditor());

// The load-time wiring's own lifecycle. Aborting it is how an envelope that failed or expired tells a continuation still running underneath it that it must not stage
// anything after the fact, and its signal is the one every cancellation point below reads.
const wiringController = new AbortController();
const wiringSignal = wiringController.signal;

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
 * recalled, because the session takes no signal and the deadline bounds only the await, so the check narrows the window in which an expired envelope still writes to
 * that in-flight instant rather than closing it.
 *
 * When the envelope fails, nothing has been written and the page loads exactly as it otherwise would. No read this webUI performs consults the consolidated
 * settings - first run reads the connection triple, which stays in the configuration file - so a session whose fetches are failing still routes, still runs first
 * run, and simply leaves the migration to a session whose fetches succeed.
 */
const wireProtectConfig = async () => {

  /* The catalog is the framework's own page-lifetime read of it, the one its feature-options boot shares, so the migration composes against exactly what the page
   * renders. That read rejects an answer without the catalog shape the server publishes rather than shaping it into an empty catalog, because an empty one would let
   * the migration read every option as unconfigured and compose entries against a catalog that never described them. A malformed answer, a missed deadline, and a
   * failed request each decline the wiring here, before the session opens, so nothing is written and the page loads as it otherwise would.
   */
  const protectConfig = makeProtectConfig({ FeatureOptions, catalog: await ui.featureOptions.catalog() });

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

    const [settled] = await Promise.allSettled([withDeadline({ promise: homebridge.request("/getDevices", { address, password, username }),
      seconds: PROBE_DEADLINE, signal: wiringSignal })]);

    // The controller reports itself as a device whose model key is "nvr", so it is found by that key rather than by its position in the list. A probe that failed
    // in any way reads as a verdict with no devices, so it finds nothing.
    const mac = readDeviceListAnswer(settled).devices.find(isController)?.mac;

    if(mac) {

      macByAddress.set(address, mac);
    }
  }));

  const migratePatch = protectConfig.migrate(session.platform, macByAddress);

  /* Fold the feature-option translation into the same envelope, as a second writer over the first one's output. The composition is a sequence rather than a merge: the
   * server composes the final patch from the property migration's own and the translation it then runs, so exactly one options array is ever written.
   *
   * The first call carries no topology at all, which makes it both the cheap detector and the rewrite for every family that needs none. A converged configuration
   * answers here with nothing remaining and nothing to write, and the flow stops - it never probes a controller and never touches the disk.
   */
  const composed = await withDeadline({ promise: homebridge.request("/translateOptions", { migratePatch, platformOptions: session.platform?.options ?? [] }),
    seconds: PROBE_DEADLINE, signal: wiringSignal }).catch(() => null);

  let patch = composed ? composed.patch : migratePatch;

  /* A family that still carries retired entries is one whose exact rewrite needs to know which controller its scopes sit under, so the flow widens its probes past the
   * controllers that were awaiting a MAC address and asks every configured controller for its devices. This is the only path that pays for the wider probe, and a
   * configuration with nothing left to place never reaches it.
   *
   * Each probe is bounded exactly as the pass above bounds its own, and a controller that does not answer simply contributes no topology: the families whose scopes it
   * would have placed keep their entries for a later open, and the runtime overlay keeps honoring them meanwhile.
   */
  if(composed?.legacyRemaining && !wiringSignal.aborted) {

    const topology = (await Promise.all(controllers(session.platform).map(async ({ address, password, username }) => {

      const [settled] = await Promise.allSettled([withDeadline({ promise: homebridge.request("/getDevices", { address, password, username }),
        seconds: PROBE_DEADLINE, signal: wiringSignal })]);
      const { devices } = readDeviceListAnswer(settled);
      const mac = devices.find(isController)?.mac;

      return mac ? { devices: devices.filter((device) => !isController(device) && device?.mac).map((device) => ({ mac: device.mac })), mac } : null;
    }))).filter((entry) => entry);

    const widened = await withDeadline({ promise: homebridge.request("/translateOptions", { migratePatch, platformOptions: session.platform?.options ?? [], topology }),
      seconds: PROBE_DEADLINE, signal: wiringSignal }).catch(() => null);

    if(widened) {

      patch = widened.patch;
    }
  }

  // The signal is read immediately before the write, so an envelope that expired while the probes were still running cannot stage a patch after the fact.
  if(patch && !wiringSignal.aborted) {

    await session.commit(patch);

    // The signal is read a second time, because the commit itself was an await and the envelope may have expired across it. A save the deadline overtakes is skipped
    // rather than forced, which leaves the migration staged for the user's own save - the weaker outcome, and the honest one.
    if(!wiringSignal.aborted) {

      await session.persist();
    }
  }
};

try {

  await withDeadline({ promise: wireProtectConfig(), seconds: WIRING_DEADLINE });
} catch(error) {

  wiringController.abort(error);
}

// Display the webUI.
ui.show();
