/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webui/controller-actions.ts: The settings page's controller login check, its kept controller answers, and the controller save and removal that write them.
 */
import type { CommitConfig, CommitConfigResult, SaveAction, SaveCheckResult, SaveDelivery, SaveFlow, SaveFlowResult } from "homebridge-plugin-utils";
import type { ProtectConfig, ProtectControllerList, readDeviceListAnswer } from "./protect-config.ts";

/* The single home for the controller login check every card and the first-run submit share, for what the settings page remembers about each configured
 * controller, and for the configuration actions that change it - a controller's save and a controller's removal. The memory is private here and the page reads it
 * through a small handle, so the rule deciding whether an answer is worth keeping is stated once rather than at every site that fills one, and the seed, the
 * delete, and the generation bump each action makes stay out of reach of every reader that has no business making them.
 *
 * The module imports types alone, which the compiler erases, and names no browser global. Every reach beyond it is handed in: the UI-server bridge's request, the
 * framework's deadline, and the device-list reading the login check runs over, and the framework's coordinated write, the host's toast, the login check, the page's
 * read of its configuration, the configuration writers, the listed-address rule and its sentence, and the device-list processing the save and the removal run
 * over. A save runs through the save flow its card carries. That is what lets the whole of it run under node against recording doubles and the real save flow,
 * which puts a swapped toast severity, a put-back that restores the wrong address, a seed that lands after its write, and a login check that loses its bound in
 * front of a gate rather than in front of a user.
 */

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

// A login the controller refused, the one login a declined save carries.
type FailedLogin = Extract<ControllerLogin, { kind: "failed" }>;

// Why a save declined before its write: the listed-address refusal, or the login the controller refused.
type SaveRefusal = { kind: "listed" } | FailedLogin;

// One outcome as a press speaks it: the channel its toast is raised on, the words it carries, and the tone it paints in on the card.
interface SpokenOutcome {

  channel: "error" | "warning";
  outcome: { detail?: string; lines: string[] };
  tone: string;
}

// The message a thrown value carries, read the one way every failure on the page reads it: an error's own message, and anything else a host throws as its text.
const errorMessage = (error: unknown): string => (error instanceof Error) ? error.message : String(error);

/* The words of one outcome as the single message a toast carries: its sentences, then any failure detail, in the order the line shows them. An outcome is composed
 * once and delivered to whichever surface presents it, so the toast says exactly what the line would have said. The host renders the message as text, so a
 * controller-reported detail is never interpreted as markup here either.
 */
const toastMessage = ({ detail = "", lines = [] }: { detail?: string; lines?: readonly string[] }): string => [ ...lines, detail ].filter((part) => part.length)
  .join(" ");

/**
 * What the kept answers and the controller save and removal are built over: the page's own reach into the host, the framework, and the UI-server bridge.
 */
export interface ControllerActionsDependencies {

  readonly commitConfig: CommitConfig<ProtectConfig>;
  readonly controllerListedElsewhere: ProtectControllerList["controllerListedElsewhere"];
  readonly controllerListedWarning: string;
  readonly platformConfig: () => ProtectConfig | null;
  readonly processDeviceList: (list: { address: string; devices: Record<string, unknown>[] }) => Record<string, unknown>[];
  readonly requestControllerLogin: ControllerLoginRequest;
  readonly toast: Pick<HostToast, "error" | "success" | "warning">;
  readonly withControllerRemoved: ProtectControllerList["withControllerRemoved"];
  readonly withControllerSaved: ProtectControllerList["withControllerSaved"];
}

/**
 * Build the settings page's kept controller answers and the controller save and removal that write them, over the page's own reach into the host, the framework,
 * and the UI-server bridge.
 *
 * @param injected.commitConfig              - The feature-options page's coordinated write, which takes a composer and answers what became of it. A removal writes
 *                                             through it; a save writes through the save flow its card carries, which the page builds over the same write.
 * @param injected.controllerListedElsewhere - The rule that answers whether another configured controller already holds the address a save writes.
 * @param injected.controllerListedWarning   - The sentence a save speaks when that rule, or the writer asking it again, refuses the save.
 * @param injected.platformConfig            - The page's read of the platform configuration it last received, which the listed-address check is asked of.
 * @param injected.processDeviceList         - The page's decoration of a login's device list into the shape the framework renders from.
 * @param injected.requestControllerLogin    - The login request, which answers whether the controller accepted a login and reports nothing itself.
 * @param injected.toast                     - The host's toast surface, which is where a write that landed speaks, and where a save's failure speaks when no
 *                                             press delivery is left to carry it.
 * @param injected.withControllerRemoved     - The writer that composes a controller's removal.
 * @param injected.withControllerSaved       - The writer that composes a controller's save, answering null when another controller already holds its address.
 *
 * @returns The kept answers, the controller removal, and the controller save.
 */
export const makeControllerActions = ({ commitConfig, controllerListedElsewhere, controllerListedWarning, platformConfig, processDeviceList, requestControllerLogin,
  toast, withControllerRemoved, withControllerSaved }: ControllerActionsDependencies): ControllerActions => {

  /* Each controller address's device list, as this session last fetched it and already processed for the framework to render. One answer serves every reader that
   * needs it, which is why what is kept is the processed list rather than any narrower derivative of it: the device view returns it on every re-entry, a removal
   * derives from it the MAC addresses a settings sweep would strip, and the sidebar reads the controller's own name from it. A controller login and bootstrap costs
   * a user five to twenty seconds of dead air, and almost nothing about a controller changes between one re-entry and the next, so that price is paid once per
   * address per session and the Refresh control is how a user asks to pay it again.
   *
   * Only an answer that actually arrived is ever kept. A fetch that fails answers no devices at all and writes nothing here, so the connection-error view and the
   * framework's own retry cycle always act on a live attempt rather than on a hopeful memory of one. The map lives as long as the actions the page built, which is
   * the page's own lifetime, so a reopened panel connects afresh.
   */
  const byAddress = new Map<unknown, Record<string, unknown>[]>();

  /* The generation the map above is on, bumped by every event that retires what it holds: a controller saved, a controller removed, and the Refresh control. A
   * fetch captures this value before it calls the bridge and compares it after, writing only when the two still agree.
   *
   * The bridge offers no cancellation, so a fetch issued before an invalidation cannot be recalled and would otherwise be free to land its pre-invalidation answer
   * afterwards - the same supersession problem a card's login verdict has. The card settles it with an action guard, where each validation retires the one before
   * it; fetches for different addresses run side by side and none may retire another, so here an invalidation retires them all at once instead. A retired fill
   * costs one extra fetch at the next selection, where a stale serve would cost the rest of the session. One counter covers every address deliberately: its only
   * failure mode is that extra fetch, and a counter nobody can misindex beats a map of counters somebody can.
   */
  let generation = 0;

  /* The whole of what a reader may do with the kept answers: empty them, read the generation a fetch belongs to, read one address's answer, and offer an answer
   * for keeping. The seed, the delete, and the bump each action below makes are deliberately absent, because each is a step inside a write rather than something a
   * reader is ever right to do on its own.
   */
  const answers: ControllerAnswers = {

    // The Refresh control's whole handler: the generation moves so every fetch in flight loses its claim to be kept, and what is held goes.
    clear: () => {

      generation++;
      byAddress.clear();
    },

    // The generation a fetch captures before it calls the bridge, to hand back alongside the answer it receives.
    generation: () => generation,

    // One address's kept device list, or undefined where this session holds none for it.
    get: (address) => byAddress.get(address),

    /* Keep what a fetch answered, where it is still worth keeping, and say whether it was kept. A fetch that failed answers no devices and is never kept, which is
     * what keeps the connection-error view and its retry acting on live attempts; an answer a save or a removal overtook while it was in flight is dropped for the
     * same reason, at the cost of one more fetch the next time this controller is selected.
     */
    keep: ({ address, answer, generation: mark }) => {

      if(!answer.length || (mark !== generation)) {

        return false;
      }

      byAddress.set(address, answer);

      return true;
    }
  };

  // Put one address back to the answer it held, or take it out where it held none.
  const putBack = (address: string, prior: Record<string, unknown>[] | undefined): void => {

    if(prior === undefined) {

      byAddress.delete(address);

      return;
    }

    byAddress.set(address, prior);
  };

  /* Seed the kept answers for a save about to be written, and answer the restore that undoes the seed where the write does not land.
   *
   * The seed goes AHEAD of the write rather than after it, because the page re-reads through getControllers and getDevices inside the write and getDevices answers
   * from these answers: a seed made afterwards would leave the sidebar labeling the entry with its raw address and send the selection's refetch to a fresh login.
   * The generation moves, so every fetch still in flight loses its claim to be kept; an address change strands whatever was remembered under the address the user
   * replaced, which names nothing the configuration will hold; and the written address takes this save's own login answer, which logged into the controller with
   * exactly these credentials moments ago. The list is processed before anything here changes, so a list the processing cannot read leaves the answers as they were.
   *
   * What the answers held under each address the seed touches is read first, so the restore puts each one back exactly, or takes it out where there was none, and
   * moves the generation again so a fetch issued against the seeded state loses its claim too.
   */
  const seed = ({ address, devices, replacedAddress }: { address: string; devices: Record<string, unknown>[]; replacedAddress: string | undefined }): (() => void) => {

    const processed = processDeviceList({ address, devices });
    const priorAtAddress = byAddress.get(address);
    const priorAtReplaced = (replacedAddress === undefined) ? undefined : byAddress.get(replacedAddress);

    generation++;

    if(replacedAddress !== undefined) {

      byAddress.delete(replacedAddress);
    }

    byAddress.set(address, processed);

    return () => {

      putBack(address, priorAtAddress);

      if(replacedAddress !== undefined) {

        putBack(replacedAddress, priorAtReplaced);
      }

      generation++;
    };
  };

  /* Check that a card's address is not already listed, validate its login, and persist it, which is the whole of what Save means.
   *
   * A press runs through the save flow its card carries, which holds every press to the same rules. A press that arrives while a write is in flight starts nothing,
   * and the card's Save control is not pressable for the write's span. A press begins its action through the card's own starter, so only the card's own retiring
   * acts - an edit to its fields, a Validate press, or another Save - cancel it, and only while its check is in flight; once the write has started, nothing cancels
   * it. Closing the card, re-populating it, or taking it off screen is moving on rather than cancelling, so a pressed Save goes on to write if its check passes.
   *
   * The check starts nothing of its own, because a second action on the card would retire the press it belongs to. A save whose address another configured
   * controller already holds is refused before its login check, asked of the configuration the page last received: the answer needs no controller, and a user
   * should not wait on a login whose result would be thrown away. The login check comes next and a failure writes nothing at all: a controller the plugin cannot
   * log into is not a configuration worth saving.
   *
   * The write is handed to the feature-options page as a composer rather than made through a session of the card's own, because the page's store holds the options
   * array the user loaded and a write made behind it is one the next option edit writes back over. The page drains whatever option edits are in flight, composes
   * against the configuration as it then stands, writes and saves through the one session it owns, and re-establishes itself on what was written. The composer asks
   * the listed-address rule again of that configuration, which is how a save queued behind another that changed it is still refused, and only a patch it composes
   * seeds the kept answers.
   *
   * Success speaks through the host's toast rather than the card's line, because the page's re-establishment re-populates the docked card, which blanks its line,
   * and a re-entry discards the frame the card sits on altogether. A refusal speaks in the warning tone and a failure in the error tone, each through the press's own
   * delivery: on the card while the card still presents the press, and on the host's toast otherwise. A write that reached the host's memory but not its disk is a
   * save the user's own Save completes, so it warns and counts as saved.
   *
   * A press whose write did not land puts back what its seed replaced. Where another write seeded the same address in the meantime, that put-back can restore an
   * older answer than the one the configuration now holds; the cost is a stale sidebar label until the next Refresh.
   *
   * An address change replaces the controller's sidebar key, which is its configured address, so the write declares the change as a rename from the address the
   * card started from to the one it wrote, and the page's framework carries the selection onto it.
   *
   * @returns The address that was written, or null when nothing was.
   */
  const saveController = async ({ card, originalAddress }: { card: ControllerCard; originalAddress?: string }): Promise<string | null> => {

    const { address, password, username } = card.values();
    const replaced = Boolean(originalAddress) && (originalAddress !== address);

    // This press's delivery, kept from its check so a press the write rejects still speaks under the press's own rule, and the restore its composer answers once
    // it seeds. Each belongs to this press alone, so a later press on the same card can neither speak through this one's delivery nor undo this one's seed.
    let deliver: SaveDelivery | undefined;
    let restore: (() => void) | undefined;

    // Speak one outcome through a press's delivery: painted on the card in the outcome's tone while the card presents the press, and raised on the named toast
    // otherwise.
    const speak = (delivery: SaveDelivery, { channel, outcome, tone }: SpokenOutcome): void => delivery({ channel, paint: () => card.verdict.render({ ...outcome, tone }),
      text: toastMessage(outcome) });

    // The refusal of an address another controller already holds, which is guidance rather than failure, and a save's failure, which carries what went wrong.
    const listed: SpokenOutcome = { channel: "warning", outcome: { lines: [controllerListedWarning] }, tone: "text-warning" };
    const failure = (error: unknown): SpokenOutcome => ({ channel: "error", outcome: { detail: errorMessage(error), lines: ["Unable to save this controller."] },
      tone: "text-danger" });

    let result: SaveFlowResult<SaveAction, Record<string, unknown>[], SaveRefusal>;

    try {

      result = await card.flow.save({

        check: async (context): Promise<SaveCheckResult<Record<string, unknown>[], SaveRefusal>> => {

          deliver = context.deliver;

          if(controllerListedElsewhere(platformConfig(), { address, originalAddress })) {

            return { kind: "declined", reason: { kind: "listed" } };
          }

          // A login that answers retired belongs to a press a newer act on the card has already retired, and the flow answers that press superseded before it
          // reads what the check returned, so every declined answer the flow reads carries a login the controller refused.
          const login = await requestControllerLogin({ address, password, signal: context.signal, username });

          return (login.kind === "passed") ? { kind: "passed", value: login.devices } : { kind: "declined", reason: login as FailedLogin };
        },
        compose: (platform, devices) => {

          const patch = withControllerSaved(platform, { address, originalAddress, password, username });

          if(patch === null) {

            return null;
          }

          restore = seed({ address, devices, replacedAddress: replaced ? originalAddress : undefined });

          return patch;
        },

        // The framework refuses a rename whose keys are not strings, so an original address a hand edit left as anything else declares none rather than turning a
        // save that would write into a failure.
        rename: (replaced && (typeof originalAddress === "string") && (typeof address === "string")) ? { from: originalAddress, to: address } : undefined
      });
    } catch(error) {

      // A rejected press is a bug in code the press ran, and whatever its composer seeded goes back. It speaks through the delivery its check kept, under the
      // press's own rule, or through the host's error toast where the press rejected before any check ran.
      restore?.();

      if(deliver) {

        speak(deliver, failure(error));

        return null;
      }

      toast.error(toastMessage(failure(error).outcome));

      return null;
    }

    switch(result.kind) {

      case "declined": {

        speak(result.deliver, (result.reason.kind === "listed") ? listed : { channel: "error", outcome: result.reason.outcome, tone: "text-danger" });

        return null;
      }

      // The composer answered null, which it does only for an address another controller holds in the configuration the write composed over. Nothing was written
      // and nothing was seeded.
      case "unchanged": {

        speak(result.deliver, listed);

        return null;
      }

      case "failed": {

        restore?.();
        speak(result.deliver, failure(result.error));

        return null;
      }

      case "committed": {

        toast.success("This controller has been saved.");

        return address;
      }

      case "staged": {

        toast.warning("This controller has been saved, but Homebridge could not write the configuration file. Save the plugin's settings to keep the change.");

        return address;
      }

      // A busy press started nothing and a superseded one was retired before its write, so neither wrote anything or is owed anything. An outcome this page does
      // not recognize is one it cannot claim as a success.
      case "busy":
      case "superseded":
      default: {

        return null;
      }
    }
  };

  /* Remove a controller from the configuration, with the settings sweep the user chose.
   *
   * The write is handed to the feature-options page as a composer for the same reason a save's is: the page's store holds the options array the user loaded, and the
   * sweep's deletions written behind it are ones the next option edit writes back over. The page owns the session and re-establishes itself on what was written.
   *
   * Where the page comes to rest is the framework's own reconciliation rather than a click of ours. A removal from a ready page re-establishes it in place, and a
   * selection naming the removed controller falls back to the global scope. A removal from the connection-error view re-enters the page, which lands on the first
   * remaining controller, and a removal that leaves no controller at all re-enters it onto the screen that asks for one. A removal that landed therefore says
   * nothing, because where the page comes to rest is the visible outcome; a removal the host could not save to disk speaks through the toast, since the card it would
   * otherwise speak through leaves the page with the controller. A removal that failed paints on the card, which still stands for the controller it could not
   * remove.
   *
   * The cache work stays after the write, where it sits for a save's own reasons reversed: nothing the page re-reads inside the write consults the removed address
   * once the list drops it, so clearing afterwards costs a failed write nothing.
   */
  const removeController = async ({ address, card, macs }: { address: string; card: ControllerCard; macs: readonly string[] }): Promise<void> => {

    let result: CommitConfigResult;

    try {

      result = await commitConfig((platform) => withControllerRemoved(platform, { address, macs }));
    } catch(error) {

      card.verdict.render({ detail: errorMessage(error), lines: ["Unable to remove this controller."], tone: "text-danger" });

      return;
    }

    switch(result.kind) {

      // A removal that landed says nothing: where the page comes to rest is the visible outcome, and it needs no sentence beside it.
      case "committed": {

        break;
      }

      case "staged": {

        toast.warning("This controller has been removed, but Homebridge could not write the configuration file. Save the plugin's settings to keep the change.");

        break;
      }

      case "failed": {

        card.verdict.render({ detail: errorMessage(result.error), lines: ["Unable to remove this controller."], tone: "text-danger" });

        return;
      }

      // An outcome this page does not recognize is one it cannot treat as a removal, so nothing renders and the kept answers stay as they are.
      default: {

        return;
      }
    }

    // The controller is gone from the configuration, so what this session remembered about it goes with it, and the generation moves so a fetch that was already in
    // flight for that address cannot put it back. The settings sweep read its MAC addresses long before this, when the card was populated.
    generation++;
    byAddress.delete(address);
  };

  return { answers, removeController, saveController };
};

/**
 * What the login check is built over: the bound on one check, the device-list reading, the UI-server bridge's request, and the framework's deadline. The reading's
 * type is declared here at module scope, where `typeof` names the imported function, rather than in the factory's parameter, where the same words would name the
 * parameter itself.
 */
export interface ControllerLoginDependencies {

  readonly deadline: number;
  readonly readDeviceListAnswer: typeof readDeviceListAnswer;
  readonly request: (path: string, payload: unknown) => Promise<unknown>;
  readonly withDeadline: (options: { promise: Promise<unknown>; seconds: number; signal?: AbortSignal }) => Promise<unknown>;
}

/**
 * Build the controller login check over the page's own reach into the UI-server bridge and the framework's deadline. The check validates a controller login against
 * the UI server and answers what came of it, and every card's validate control, every card's Save, and the first-run submit share it so none of them can drift
 * apart. The browser cannot reach the Protect controller directly, so the request bridges through the plugin's UI server.
 *
 * It answers an outcome and reports nothing itself: passed with the controller's device list, failed with the sentences and the detail that a missing field, a
 * rejected login, or a request that threw calls for, or retired when the signal it was handed aborted before the answer arrived. Each caller delivers the outcome
 * under its own rule: the validate control and the first-run submit through the action they started, which paints while the card presents it and drops it
 * otherwise, and a Save through its press's delivery, which still reaches the user through the host's toast once the card no longer presents the press.
 *
 * The signal is the caller's action's own, so an edit to the card's fields or a newer act on the card retires the request. Starting that action is the caller's
 * act, because the caller speaks through it once this answers, and because a Save and the first-run submit each ask whether the address is already listed before
 * this check begins.
 *
 * The check is bounded, because the bridge has no timeout of its own and a UI server that never answers would otherwise leave the card waiting for good. A check
 * that outlasts the bound settles as the UI server's failure, with the deadline's own sentence as its detail. The deadline takes the caller's signal, so a retired
 * check settles at once rather than waiting out the bound. The bridge offers no cancellation, so a retired or expired request still runs to its answer at the
 * host, where that answer is dropped.
 *
 * @param injected.deadline             - The bound on one check, in seconds.
 * @param injected.readDeviceListAnswer - The one reading of the UI server's device-list answer, which the check's outcome is composed from.
 * @param injected.request              - The UI-server bridge's request, taking a path and a payload.
 * @param injected.withDeadline         - The framework's deadline, which races an await against the bound and the caller's signal.
 *
 * @returns The login check.
 */
export const makeControllerLogin = ({ deadline, readDeviceListAnswer, request, withDeadline }: ControllerLoginDependencies): ControllerLoginRequest => async ({ address,
  password, signal, username }) => {

  if(!address.length || !username.length || !password.length) {

    return { kind: "failed", outcome: { lines: ["Please enter a valid UniFi Protect controller address, username and password."] } };
  }

  const [settled] = await Promise.allSettled([withDeadline({ promise: request("/getDevices", { address, password, username }), seconds: deadline, signal })]);

  // An edit to this card's fields, or a newer validation or Save on it, retires this one. A retired request answers nothing to show, whether the bridge answered
  // or failed, so it never paints over what the newer input or action is showing, and a Save waiting on it writes nothing.
  if(signal.aborted) {

    return { kind: "retired" };
  }

  const verdict = readDeviceListAnswer(settled);

  switch(verdict.kind) {

    case "list": {

      return { devices: verdict.devices, kind: "passed" };
    }

    // Couldn't connect to the Protect controller. The guidance sentences frame the failure and the controller-sourced error detail arrives with the device-list
    // response, rendered as text so it is never interpreted as markup.
    case "unreachable": {

      return { kind: "failed", outcome: { detail: verdict.message, lines: [ "Unable to login to the UniFi Protect controller.",
        "Please check your controller address, username, and password." ] } };
    }

    // The UI server failing to start, failing to respond within the bound, or answering in a shape it never writes lands here. Answering the specific failure keeps
    // it on the card for a user still looking at it, while the framework's toast stays the generic net for consumers without their own handling.
    default: {

      return { kind: "failed", outcome: { detail: verdict.message, lines: ["Unable to validate your controller login."] } };
    }
  }
};
