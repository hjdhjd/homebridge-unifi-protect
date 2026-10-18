/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * controller-actions.test.ts: The settings page's controller login check, its kept controller answers, and the controller save and removal that write them,
 * driven through the real save flow and recording doubles for every other reach the module makes outside itself.
 *
 * What these rows prove is the part of a save and a removal no type can state: that each outcome speaks in exactly its sentence, on exactly its channel, and
 * exactly once; that the seed a save makes lands BEFORE its write and only once its composer has a patch; that a press whose write did not land puts back what
 * its own seed replaced and nothing else; and that a press during a write starts nothing. Every row asserts the whole list of toasts and paints, so a second
 * delivery, or a delivery on the wrong surface, reddens it as surely as a missing one. The login check's rows run the real device-list reading behind a request
 * double and a deadline double, so the bound the check is built with and the signal it is handed are read where they reach the deadline.
 *
 * The card's save flow is the framework's own, imported from the package root, which is compiled from the same source as the page's browser module, so the rules
 * a press runs under are the ones the page runs under. The write double refuses a declared rename whose keys are not strings, as the framework refuses one ahead
 * of its queue, so a rename built from a value that is no sidebar key fails the save it reaches rather than recording as though the page had accepted it. The
 * addresses differ and each kept answer is a list of its own, so a put-back that restores the wrong thing cannot coincide with one that restores the right thing.
 */
import { CONTROLLER_LISTED_WARNING, controllerListedElsewhere, readDeviceListAnswer, withControllerRemoved, withControllerSaved }
  from "../homebridge-ui/public/protect-config.mjs";
import type { CommitConfig, CommitConfigResult, SaveAction } from "homebridge-plugin-utils";
import type { ControllerActions, ControllerCard, ControllerLogin, ControllerLoginRequest } from "../homebridge-ui/public/controller-actions.mjs";
import { describe, test } from "node:test";
import { makeControllerActions, makeControllerLogin } from "../homebridge-ui/public/controller-actions.mjs";
import type { ProtectConfig } from "../homebridge-ui/public/protect-config.mjs";
import assert from "node:assert/strict";
import { createSaveFlow } from "homebridge-plugin-utils";

// The address a save writes and a removal drops, the address an address-changing edit replaces, and a third address no save here touches.
const ADDRESS = "10.0.0.1";
const ORIGINAL_ADDRESS = "10.0.0.2";
const THIRD_ADDRESS = "10.0.0.3";

// The login the card holds beside its address.
const LOGIN = { password: "correct horse battery", username: "protect@example.com" };

// What the device-list double stamps onto every record it is handed, so a seed that skipped the processing is told apart from one that did not.
const PROCESSED = "processed-by-the-page";

// What a reader is told, transcribed from the module rather than referenced, so a sentence that drifts by a character in either place reddens a row.
const LISTED = "This controller is already listed.";
const SAVED = "This controller has been saved.";
const SAVED_STAGED = "This controller has been saved, but Homebridge could not write the configuration file. Save the plugin's settings to keep the change.";
const REMOVED_STAGED = "This controller has been removed, but Homebridge could not write the configuration file. Save the plugin's settings to keep the change.";
const SAVE_FAILURE = "Unable to save this controller.";
const REMOVE_FAILURE = "Unable to remove this controller.";

// What a refused write carries, worded unlike any sentence the module speaks, so a delivery that dropped the detail or spoke its own cannot pass.
const WRITE_FAILURE = "the host refused the write";

// What the login double answers for a refused login. The module owns none of these words, so a delivery that carries exactly them is one that delivered the
// login request's own reason.
const LOGIN_REFUSAL = { detail: "the controller refused this login", lines: [ "the login request's first sentence", "and its second" ] };

// One toast, by the channel it was raised on and the message it carried.
interface Toast {

  channel: "error" | "info" | "success" | "warning";
  text: string;
}

// One paint on the card's verdict line, which is the whole of what an outcome says on the card.
interface Paint {

  detail?: string;
  lines?: string[];
  tone?: string;
}

// What the kept answers held, and the generation they were on, at the moment the write ran. This is what places the seed and its bump ahead of the write rather
// than behind it, which no assertion made after the save resolves could tell apart.
interface WriteObservation {

  atAddress: Record<string, unknown>[] | undefined;
  atOriginal: Record<string, unknown>[] | undefined;
  generation: number;
}

/* One step of the write double's script. `natural` answers unchanged when the composer answered null and committed otherwise, which is what the page's write
 * does when the host takes it, and no other step answers unchanged; `unrecognized` answers a kind the page does not know, after calling the composer; the
 * others answer the kind they name, after calling the composer unless the name says the step answers before it.
 */
type WriteStep = "committed" | "failed" | "failedBeforeCompose" | "natural" | "rejected" | "rejectedBeforeCompose" | "staged" | "unrecognized";

// What the login request is handed for one press: the card's values as they stood at the press, and the press's own signal.
interface LoginRequest {

  address: string;
  password: string;
  signal: AbortSignal;
  username: string;
}

// What a row stands the module up over. Every member has a default, so a row names only what it is about.
interface StandOptions {

  hold?: Promise<void>;
  login?: ControllerLogin;
  malformedStarter?: boolean;
  onWrite?: () => void;
  pageConfig?: ProtectConfig;
  platform?: ProtectConfig;
  presented?: boolean;
  retireDuringLogin?: boolean;
  values?: { address: string; password: string; username: string };
  writes?: WriteStep[];
}

// A stood-up module and everything the doubles beneath it recorded.
interface Stand {

  actions: ControllerActions;
  card: ControllerCard;
  commit: CommitConfig<ProtectConfig>;
  commits: () => number;
  composed: unknown[];
  control: { disabled: boolean };
  loginCalls: LoginRequest[];
  paints: Paint[];
  renames: unknown[];
  seen: WriteObservation[];
  signals: AbortSignal[];
  starts: () => number;
  toasts: Toast[];
}

/* The device list this save's own login answers, fresh per call so the stamping one row does cannot reach another row's fixture.
 *
 * @returns The login's answer.
 */
function passed(): ControllerLogin {

  return { devices: [{ mac: "AABBCCDDEEFF", modelKey: "nvr", name: "the answer this save's own login received" }], kind: "passed" };
}

/* The device list this session was already holding for an address, a list of its own per call and unlike anything a login here answers.
 *
 * @param address - The address the answer is held under.
 *
 * @returns The answer.
 */
function priorAt(address: string): Record<string, unknown>[] {

  return [{ mac: address, modelKey: "nvr", name: "the answer already held for " + address }];
}

/* The one entry a recorder holds, asserted to be exactly one so a row reads it rather than a possibly absent one.
 *
 * @param list    - The recorder.
 * @param message - What the entry stands for.
 *
 * @returns The entry.
 */
function only<T>(list: T[], message: string): T {

  assert.equal(list.length, 1, message);

  const [entry] = list;

  assert.ok(entry !== undefined, message);

  return entry;
}

/* Stand the module up over the real save flow and recording doubles for every other reach it makes.
 *
 * The card's starter holds the page card's rule in miniature: each start retires the action before it, exactly as the card's guard does, and the card presents
 * the action or not as the row asks. The write double records the rename it was handed, calls the composer against the platform the row names, records what the
 * kept answers held at that moment, and answers what the row's script names.
 *
 * @returns The module and every recorder beneath it.
 */
function stand({ hold = Promise.resolve(), login = passed(), malformedStarter = false, onWrite, pageConfig = {}, platform = { controllers: [] },
  presented = true, retireDuringLogin = false, values = { ...LOGIN, address: ADDRESS }, writes = [] }: StandOptions = {}): Stand {

  const composed: unknown[] = [];
  const control = { disabled: false };
  const loginCalls: LoginRequest[] = [];
  const paints: Paint[] = [];
  const renames: unknown[] = [];
  const script = [...writes];
  const seen: WriteObservation[] = [];
  const signals: AbortSignal[] = [];
  const toasts: Toast[] = [];
  let commits = 0;
  let current: AbortController | null = null;
  let starts = 0;

  const toast = {

    error: (text: string): void => {

      toasts.push({ channel: "error", text });
    },
    info: (text: string): void => {

      toasts.push({ channel: "info", text });
    },
    success: (text: string): void => {

      toasts.push({ channel: "success", text });
    },
    warning: (text: string): void => {

      toasts.push({ channel: "warning", text });
    }
  };

  const start = (): SaveAction => {

    starts++;
    current?.abort();
    current = new AbortController();
    signals.push(current.signal);

    // A starter that answers without the members the flow reads is how a row rejects a press before any check runs.
    if(malformedStarter) {

      return {} as SaveAction;
    }

    return { presented: () => presented, signal: current.signal };
  };

  const commit: CommitConfig<ProtectConfig> = async (compose, options) => {

    // The rename this call declared, read as the framework reads it: absent declares none, and anything present whose keys are not strings is refused before
    // anything else happens, so nothing is composed or written for it.
    const rename: unknown = options?.rename;

    if(rename !== undefined) {

      if((typeof rename !== "object") || (rename === null) || !("from" in rename) || !("to" in rename) || (typeof rename.from !== "string") ||
        (typeof rename.to !== "string")) {

        throw new TypeError("A declared rename names the controller's previous and current sidebar keys, each a string.");
      }

      renames.push(rename);
    }

    commits++;

    const step = script.shift() ?? "natural";

    if(step === "failedBeforeCompose") {

      return { error: new Error(WRITE_FAILURE), kind: "failed" };
    }

    if(step === "rejectedBeforeCompose") {

      throw new Error(WRITE_FAILURE);
    }

    const patch = compose(platform);

    composed.push(patch);
    seen.push({ atAddress: actions.answers.get(ADDRESS), atOriginal: actions.answers.get(ORIGINAL_ADDRESS), generation: actions.answers.generation() });
    onWrite?.();

    await hold;

    switch(step) {

      case "committed": {

        return { kind: "committed" };
      }

      case "failed": {

        return { error: new Error(WRITE_FAILURE), kind: "failed" };
      }

      case "rejected": {

        throw new Error(WRITE_FAILURE);
      }

      case "staged": {

        return { error: new Error("the disk refused the save"), kind: "staged" };
      }

      // A kind this page does not know, which the real write never answers today, cast past the union it stands outside of.
      case "unrecognized": {

        return { kind: "an outcome the page does not know" } as unknown as CommitConfigResult;
      }

      default: {

        return (patch === null) ? { kind: "unchanged" } : { kind: "committed" };
      }
    }
  };

  const card: ControllerCard = {

    flow: createSaveFlow({ commit, control, start, toast }),
    values: () => ({ ...values }),
    verdict: {

      render: (options = {}): void => {

        paints.push(options);
      }
    }
  };

  const actions = makeControllerActions({

    commitConfig: commit,
    controllerListedElsewhere,
    controllerListedWarning: CONTROLLER_LISTED_WARNING,
    platformConfig: () => pageConfig,
    processDeviceList: ({ address, devices }) => {

      for(const record of devices) {

        record["processed"] = PROCESSED;
        record["processedAddress"] = address;
      }

      return devices;
    },
    requestControllerLogin: async (request) => {

      loginCalls.push(request);

      // A newer act on the card retiring the press while its login is in flight, which the flow reads once the check answers.
      if(retireDuringLogin) {

        current?.abort();
      }

      return login;
    },
    toast,
    withControllerRemoved,
    withControllerSaved
  });

  return { actions, card, commit, commits: (): number => commits, composed, control, loginCalls, paints, renames, seen, signals, starts: (): number => starts,
    toasts };
}

/* Keep a distinct prior answer under each address, the way a device fetch keeps one, and answer what was kept.
 *
 * @param actions   - The module whose kept answers to fill.
 * @param addresses - The addresses to fill.
 *
 * @returns Each address's kept answer.
 */
function prime(actions: ControllerActions, addresses: string[]): Map<string, Record<string, unknown>[]> {

  const kept = new Map<string, Record<string, unknown>[]>();

  for(const address of addresses) {

    const answer = priorAt(address);

    assert.equal(actions.answers.keep({ address, answer, generation: actions.answers.generation() }), true, "a prior answer for " + address + " is kept");
    kept.set(address, answer);
  }

  return kept;
}

/* Assert that every primed address still holds exactly what it was primed with, and that the generation has not moved.
 *
 * @param actions    - The module whose kept answers to read.
 * @param kept       - What was primed.
 * @param generation - The generation the answers were on before the press.
 * @param message    - What the press stands for.
 */
function assertUntouched(actions: ControllerActions, kept: Map<string, Record<string, unknown>[]>, generation: number, message: string): void {

  for(const [ address, answer ] of kept) {

    assert.equal(actions.answers.get(address), answer, message + " leaves the answer kept for " + address + " in place");
  }

  assert.equal(actions.answers.generation(), generation, message + " leaves the generation where it was");
}

describe("controller save, each outcome's delivery and answer", () => {

  for(const presented of [ true, false ]) {

    const label = presented ? " (the card presents the press)" : " (the card no longer presents the press)";

    test("a committed save raises the success toast and answers the written address" + label, async () => {

      const s = stand({ presented });

      assert.equal(await s.actions.saveController({ card: s.card }), ADDRESS, "a committed save answers the address it wrote");
      assert.deepEqual(s.toasts, [{ channel: "success", text: SAVED }], "its confirmation is always a toast, never the line");
      assert.deepEqual(s.paints, [], "and nothing is painted");
    });

    test("a staged save raises the warning toast and answers the written address" + label, async () => {

      const s = stand({ presented, writes: ["staged"] });

      assert.equal(await s.actions.saveController({ card: s.card }), ADDRESS, "a save the host took into memory but not onto disk counts as saved");
      assert.deepEqual(s.toasts, [{ channel: "warning", text: SAVED_STAGED }], "and it warns that the user's own Save completes it");
      assert.deepEqual(s.paints, [], "and nothing is painted");
    });

    test("an address another controller is listed at is declined on the warning channel, before any login or write" + label, async () => {

      const s = stand({ pageConfig: { controllers: [{ ...LOGIN, address: ADDRESS }] }, presented });
      const kept = prime(s.actions, [ ADDRESS, THIRD_ADDRESS ]);
      const generation = s.actions.answers.generation();

      assert.equal(await s.actions.saveController({ card: s.card }), null, "a refused save answers null");
      assert.deepEqual(s.paints, presented ? [{ lines: [LISTED], tone: "text-warning" }] : [], "the refusal paints in the warning tone while presented");
      assert.deepEqual(s.toasts, presented ? [] : [{ channel: "warning", text: LISTED }], "and raises the warning toast otherwise");
      assert.equal(s.loginCalls.length, 0, "no login is requested for it");
      assert.equal(s.commits(), 0, "and nothing is written");
      assertUntouched(s.actions, kept, generation, "a declined press");
    });

    test("a declined login delivers exactly the reason the login request answered, on the error channel" + label, async () => {

      const s = stand({ login: { kind: "failed", outcome: LOGIN_REFUSAL }, presented });
      const kept = prime(s.actions, [ ADDRESS, THIRD_ADDRESS ]);
      const generation = s.actions.answers.generation();

      assert.equal(await s.actions.saveController({ card: s.card }), null, "a declined save answers null");
      assert.deepEqual(s.paints, presented ? [{ ...LOGIN_REFUSAL, tone: "text-danger" }] : [], "the reason paints in the danger tone with its detail while presented");
      assert.deepEqual(s.toasts, presented ? [] : [{ channel: "error", text: "the login request's first sentence and its second the controller refused this login" }],
        "and raises the error toast with its sentences and its detail joined otherwise");
      assert.equal(s.commits(), 0, "and nothing is written");
      assertUntouched(s.actions, kept, generation, "a declined press");
    });

    test("an address the page's copy lacks but the written configuration holds ends unchanged, with no seed and no write" + label, async () => {

      const s = stand({ platform: { controllers: [{ ...LOGIN, address: ADDRESS }] }, presented });
      const kept = prime(s.actions, [THIRD_ADDRESS]);
      const generation = s.actions.answers.generation();

      assert.equal(await s.actions.saveController({ card: s.card }), null, "a save the composer refused answers null");
      assert.deepEqual(s.composed, [null], "the composer was asked against the written configuration and answered null");
      assert.deepEqual(s.paints, presented ? [{ lines: [LISTED], tone: "text-warning" }] : [], "the refusal paints in the warning tone while presented");
      assert.deepEqual(s.toasts, presented ? [] : [{ channel: "warning", text: LISTED }], "and raises the warning toast otherwise");
      assert.equal(s.actions.answers.get(ADDRESS), undefined, "nothing was seeded at the refused address");
      assertUntouched(s.actions, kept, generation, "an unchanged press");
    });

    test("a failed write delivers the save's failure with the write's own reason" + label, async () => {

      const s = stand({ presented, writes: ["failed"] });

      assert.equal(await s.actions.saveController({ card: s.card }), null, "a failed save answers null");
      assert.deepEqual(s.paints, presented ? [{ detail: WRITE_FAILURE, lines: [SAVE_FAILURE], tone: "text-danger" }] : [], "it paints while presented");
      assert.deepEqual(s.toasts, presented ? [] : [{ channel: "error", text: SAVE_FAILURE + " " + WRITE_FAILURE }], "and raises the error toast otherwise");
    });

    test("a press rejected after its check delivers the save's failure through the check's own delivery" + label, async () => {

      const s = stand({ presented, writes: ["rejected"] });

      assert.equal(await s.actions.saveController({ card: s.card }), null, "a rejected press answers null");
      assert.deepEqual(s.paints, presented ? [{ detail: WRITE_FAILURE, lines: [SAVE_FAILURE], tone: "text-danger" }] : [], "it paints while presented");
      assert.deepEqual(s.toasts, presented ? [] : [{ channel: "error", text: SAVE_FAILURE + " " + WRITE_FAILURE }], "and raises the error toast otherwise");
    });

    test("a press the card retires during its check ends superseded, says nothing, and writes nothing" + label, async () => {

      const s = stand({ presented, retireDuringLogin: true });
      const kept = prime(s.actions, [ ADDRESS, THIRD_ADDRESS ]);
      const generation = s.actions.answers.generation();

      assert.equal(await s.actions.saveController({ card: s.card }), null, "a superseded press answers null");
      assert.deepEqual(s.toasts, [], "it raises no toast");
      assert.deepEqual(s.paints, [], "and paints nothing");
      assert.equal(s.commits(), 0, "and the write is never called");
      assertUntouched(s.actions, kept, generation, "a superseded press");
    });

    test("a press during a write starts nothing, says nothing, and the write is the only one" + label, async () => {

      const { promise: held, resolve: release } = Promise.withResolvers<undefined>();
      const { promise: atWrite, resolve: reached } = Promise.withResolvers<undefined>();
      const s = stand({ hold: held, onWrite: () => reached(undefined), presented });
      const first = s.actions.saveController({ card: s.card });

      await atWrite;

      assert.equal(s.control.disabled, true, "the Save control is not pressable while the write is in flight");
      assert.equal(await s.actions.saveController({ card: s.card }), null, "a second press during the write answers null");
      assert.equal(s.starts(), 1, "and starts no action of its own, so it cannot retire the write's");

      release(undefined);

      assert.equal(await first, ADDRESS, "the first press goes on to its own result");
      assert.equal(s.commits(), 1, "two presses on one card make one write");
      assert.equal(s.control.disabled, false, "and the Save control is pressable again once the write settles");
      assert.deepEqual(s.toasts, [{ channel: "success", text: SAVED }], "only the write's own outcome is delivered");
      assert.deepEqual(s.paints, [], "and nothing is painted");
    });
  }

  test("a press rejected before any check ran raises the save's failure on the error toast", async () => {

    const s = stand({ malformedStarter: true });
    const result = await s.actions.saveController({ card: s.card });
    const raised = only(s.toasts, "exactly one toast is raised");

    assert.equal(result, null, "a rejected press answers null");
    assert.equal(raised.channel, "error", "on the error channel");
    assert.ok(raised.text.startsWith(SAVE_FAILURE + " "), "carrying the save's failure sentence followed by what the press rejected with");
    assert.deepEqual(s.paints, [], "and nothing is painted, because no check kept a delivery to paint through");
    assert.equal(s.loginCalls.length, 0, "no login is requested");
    assert.equal(s.commits(), 0, "and nothing is written");
  });
});

describe("controller save, the check, the composer, and the rename", () => {

  test("a press calls the card's starter once, so its check cannot retire the press it belongs to", async () => {

    const s = stand();

    assert.equal(await s.actions.saveController({ card: s.card }), ADDRESS, "the press writes");
    assert.equal(s.starts(), 1, "and the card's starter ran exactly once for it");
  });

  test("the login request receives the card's values as they stood at the press and the press's own signal", async () => {

    const values = { address: ADDRESS, password: "a secret typed at the press", username: "press@example.com" };
    const s = stand({ platform: { controllers: [{ ...LOGIN, address: ORIGINAL_ADDRESS }] }, values });

    assert.equal(await s.actions.saveController({ card: s.card, originalAddress: ORIGINAL_ADDRESS }), ADDRESS, "the address-changing edit writes");

    const request = only(s.loginCalls, "the press made one login request");

    assert.deepEqual({ address: request.address, password: request.password, username: request.username }, values,
      "the request carries the card's written address, password, and username, not the address the edit replaced");
    assert.equal(request.signal, only(s.signals, "the press began one action"), "and the signal of the action the press began");
  });

  test("a listed address with a blank field answers the listed sentence and makes no login request", async () => {

    const s = stand({ pageConfig: { controllers: [{ ...LOGIN, address: ADDRESS }] }, values: { address: ADDRESS, password: "", username: "" } });

    assert.equal(await s.actions.saveController({ card: s.card }), null, "the save answers null");
    assert.deepEqual(s.paints, [{ lines: [LISTED], tone: "text-warning" }], "the listed sentence is what the card says, ahead of any missing-field sentence");
    assert.equal(s.loginCalls.length, 0, "because the listed-address check comes first and no login is requested");
  });

  test("an Add save declares no rename and appends", async () => {

    const third = { ...LOGIN, address: THIRD_ADDRESS };
    const s = stand({ platform: { controllers: [third] } });

    assert.equal(await s.actions.saveController({ card: s.card }), ADDRESS, "an add answers the address it wrote");
    assert.deepEqual(s.renames, [], "it declares no rename");
    assert.deepEqual(s.composed, [{ controllers: [ third, { ...LOGIN, address: ADDRESS } ] }], "and its composer appends beside the controller already there");
  });

  test("the write refuses a rename whose keys are not strings, and an original address that is not a string declares none", async () => {

    const s = stand();

    await assert.rejects(s.commit(() => null, { rename: { from: 42 as unknown as string, to: ADDRESS } }), TypeError,
      "the write double refuses a malformed rename, as the framework does");

    assert.equal(await s.actions.saveController({ card: s.card, originalAddress: 42 as unknown as string }), ADDRESS,
      "a save whose original address a hand edit left as a number still writes");
    assert.deepEqual(s.renames, [], "because it declares no rename the write would refuse");
  });

  for(const step of [ "committed", "staged" ] as const) {

    test("the seed is the processed login answer, lands ahead of the write, and survives a " + step + " write", async () => {

      const s = stand({ writes: [step] });
      const before = s.actions.answers.generation();

      assert.equal(await s.actions.saveController({ card: s.card }), ADDRESS, "the save answers the address it wrote");

      const seen = only(s.seen, "the write ran once");
      const seeded = seen.atAddress;

      assert.ok(seeded, "the written address already held an answer inside the write");
      assert.ok(seen.generation > before, "and the generation had already moved inside the write");

      for(const record of seeded) {

        assert.equal(record["processed"], PROCESSED, "the seed is the processed list, not the raw login answer");
        assert.equal(record["processedAddress"], ADDRESS, "processed for the address the save wrote");
        assert.equal(record["name"], "the answer this save's own login received", "and it is this save's own login answer");
      }

      assert.equal(s.actions.answers.get(ADDRESS), seeded, "the seed is still in place after the write");
      assert.equal(s.actions.answers.keep({ address: THIRD_ADDRESS, answer: priorAt(THIRD_ADDRESS), generation: before }), false,
        "and a fetch that captured its generation before the save is refused afterwards");
    });

    test("a " + step + " address-changing edit answers the new address, declares the rename, and drops the original's entry at the seed", async () => {

      const s = stand({ platform: { controllers: [{ ...LOGIN, address: ORIGINAL_ADDRESS }] }, writes: [step] });

      prime(s.actions, [ORIGINAL_ADDRESS]);

      assert.equal(await s.actions.saveController({ card: s.card, originalAddress: ORIGINAL_ADDRESS }), ADDRESS, "the edit answers the new address, not the old one");
      assert.deepEqual(s.renames, [{ from: ORIGINAL_ADDRESS, to: ADDRESS }], "and declares the rename from the old sidebar key to the new one");
      assert.equal(only(s.seen, "the write ran once").atOriginal, undefined, "the original address's entry was already gone inside the write");
      assert.equal(s.actions.answers.get(ORIGINAL_ADDRESS), undefined, "and stays gone after it");
      assert.deepEqual(s.composed, [{ controllers: [{ ...LOGIN, address: ADDRESS }] }], "and the composer replaced the item rather than appending one");
    });
  }

  test("an edit that keeps its address declares no rename", async () => {

    const s = stand({ platform: { controllers: [{ ...LOGIN, address: ADDRESS }] }, values: { ...LOGIN, address: ADDRESS, password: "new secret" } });

    assert.equal(await s.actions.saveController({ card: s.card, originalAddress: ADDRESS }), ADDRESS, "the edit answers its address");
    assert.deepEqual(s.renames, [], "and declares no rename, because no sidebar key moved");
  });
});

describe("controller save, an unwritten press puts back what its own seed replaced", () => {

  for(const step of [ "failedBeforeCompose", "rejectedBeforeCompose" ] as const) {

    test("a press whose write answers before its composer (" + step + ") leaves every kept answer and the generation as they were", async () => {

      const s = stand({ platform: { controllers: [{ ...LOGIN, address: ORIGINAL_ADDRESS }] }, writes: [step] });
      const kept = prime(s.actions, [ ADDRESS, ORIGINAL_ADDRESS, THIRD_ADDRESS ]);
      const generation = s.actions.answers.generation();

      assert.equal(await s.actions.saveController({ card: s.card, originalAddress: ORIGINAL_ADDRESS }), null, "the press answers null");
      assert.deepEqual(s.composed, [], "its composer never ran");
      assertUntouched(s.actions, kept, generation, "a press that never seeded");
    });
  }

  for(const step of [ "failed", "rejected" ] as const) {

    test("a press whose write " + step + " after its composer puts each prior back exactly and leaves a third address alone", async () => {

      const s = stand({ platform: { controllers: [{ ...LOGIN, address: ORIGINAL_ADDRESS }] }, writes: [step] });
      const kept = prime(s.actions, [ ADDRESS, ORIGINAL_ADDRESS, THIRD_ADDRESS ]);
      const generation = s.actions.answers.generation();

      assert.equal(await s.actions.saveController({ card: s.card, originalAddress: ORIGINAL_ADDRESS }), null, "the press answers null");

      const seen = only(s.seen, "the write ran once");

      assert.notEqual(seen.atAddress, kept.get(ADDRESS), "the seed had replaced the written address's answer inside the write");
      assert.equal(seen.atOriginal, undefined, "and had dropped the original address's entry");

      for(const [ address, answer ] of kept) {

        assert.equal(s.actions.answers.get(address), answer, "the answer kept for " + address + " is back exactly as it was");
      }

      assert.equal(s.actions.answers.generation(), generation + 2, "and the generation moved once for the seed and once for the put-back");
    });
  }

  test("a put-back takes out an address the kept answers held nothing for", async () => {

    const s = stand({ writes: ["failed"] });

    assert.equal(await s.actions.saveController({ card: s.card }), null, "the failed add answers null");
    assert.ok(only(s.seen, "the write ran once").atAddress, "the seed had filled the written address inside the write");
    assert.equal(s.actions.answers.get(ADDRESS), undefined, "and the put-back takes it out again, because nothing was held there before");
  });

  test("a press that seeds and commits, followed by a press that fails before its composer, keeps the first press's seed", async () => {

    const s = stand({ writes: [ "committed", "failedBeforeCompose" ] });

    assert.equal(await s.actions.saveController({ card: s.card }), ADDRESS, "the first press writes");

    const seeded = s.actions.answers.get(ADDRESS);

    assert.ok(seeded, "and seeds the written address");
    assert.equal(await s.actions.saveController({ card: s.card }), null, "the second press fails before its composer runs");
    assert.equal(s.actions.answers.get(ADDRESS), seeded, "and the first press's seed stands, because a put-back belongs to the press that seeded");
  });
});

describe("kept controller answers", () => {

  test("keep holds a list under the current generation and refuses an empty list or a moved generation; clear empties and moves the generation", () => {

    const s = stand();
    const generation = s.actions.answers.generation();
    const answer = priorAt(ADDRESS);

    assert.equal(s.actions.answers.keep({ address: ADDRESS, answer: [], generation }), false, "an empty list, which is what a failed fetch answers, is refused");
    assert.equal(s.actions.answers.get(ADDRESS), undefined, "and nothing is kept for it");
    assert.equal(s.actions.answers.keep({ address: ADDRESS, answer, generation: generation - 1 }), false, "a list from a generation that has moved is refused");
    assert.equal(s.actions.answers.get(ADDRESS), undefined, "and nothing is kept for it either");
    assert.equal(s.actions.answers.keep({ address: ADDRESS, answer, generation }), true, "a list under the current generation is kept");
    assert.equal(s.actions.answers.get(ADDRESS), answer, "and served as it was kept");

    s.actions.answers.clear();

    assert.equal(s.actions.answers.get(ADDRESS), undefined, "clear empties the kept answers");
    assert.equal(s.actions.answers.generation(), generation + 1, "and moves the generation");
  });
});

describe("controller removal", () => {

  for(const step of [ "committed", "staged" ] as const) {

    test("a " + step + " removal drops the address's entry after the write and leaves every other entry", async () => {

      const s = stand({ platform: { controllers: [ { ...LOGIN, address: ADDRESS }, { ...LOGIN, address: ORIGINAL_ADDRESS } ] }, writes: [step] });
      const kept = prime(s.actions, [ ADDRESS, ORIGINAL_ADDRESS ]);
      const generation = s.actions.answers.generation();

      await s.actions.removeController({ address: ADDRESS, card: s.card, macs: [] });

      assert.deepEqual(s.composed, [{ controllers: [{ ...LOGIN, address: ORIGINAL_ADDRESS }] }], "the removal composes the configuration without the address");
      assert.equal(only(s.seen, "the write ran once").atAddress, kept.get(ADDRESS), "the address's entry was still in place inside the write");
      assert.equal(s.actions.answers.get(ADDRESS), undefined, "and is gone after it");
      assert.equal(s.actions.answers.get(ORIGINAL_ADDRESS), kept.get(ORIGINAL_ADDRESS), "while another address's entry stands");
      assert.equal(s.actions.answers.generation(), generation + 1, "and the generation moved so a fetch in flight cannot put the entry back");
      assert.deepEqual(s.toasts, (step === "staged") ? [{ channel: "warning", text: REMOVED_STAGED }] : [],
        "a committed removal raises no toast, and a staged one warns that the user's own Save completes it");
      assert.deepEqual(s.paints, [], "and neither paints anything");
    });
  }

  for(const step of [ "failed", "rejected", "unrecognized" ] as const) {

    test("a removal whose write is " + step + " does no cache work", async () => {

      const s = stand({ platform: { controllers: [{ ...LOGIN, address: ADDRESS }] }, writes: [step] });
      const kept = prime(s.actions, [ ADDRESS, ORIGINAL_ADDRESS ]);
      const generation = s.actions.answers.generation();

      await s.actions.removeController({ address: ADDRESS, card: s.card, macs: [] });

      assertUntouched(s.actions, kept, generation, "a removal that did not land");
      assert.deepEqual(s.paints, (step === "unrecognized") ? [] : [{ detail: WRITE_FAILURE, lines: [REMOVE_FAILURE], tone: "text-danger" }],
        "a failed or rejected removal paints its failure with the detail on the card, and an outcome the page does not recognize paints nothing");
      assert.deepEqual(s.toasts, [], "and none of them raises a toast");
    });
  }
});

// What the login check says for each of its outcomes, transcribed from the module rather than referenced, so a sentence that drifts by a character reddens a row.
const MISSING_FIELD = "Please enter a valid UniFi Protect controller address, username and password.";
const LOGIN_REFUSED = [ "Unable to login to the UniFi Protect controller.", "Please check your controller address, username, and password." ];
const LOGIN_UNVALIDATED = "Unable to validate your controller login.";

// The sentence the framework's deadline rejects with on expiry, for a check built with a thirty-second bound.
const DEADLINE_EXPIRED = "The request did not complete within 30 seconds.";

// The device list a reachable controller answers, opening with the controller's own record.
const LISTED_DEVICES = [{ mac: "AABBCCDDEEFF", modelKey: "nvr" }];

// What the deadline double is handed for one check.
interface DeadlineCall {

  promise: Promise<unknown>;
  seconds: number;
  signal?: AbortSignal;
}

// One request the bridge double is handed.
interface BridgeRequest {

  path: string;
  payload: unknown;
}

// What a row builds the login check over. The bound has a default, so a row names it only where the row is about it.
interface LoginStandOptions {

  answer: () => Promise<unknown>;
  expiry?: Error;
  onRequest?: () => void;
  seconds?: number;
}

// A built login check and everything its doubles recorded.
interface LoginStand {

  check: ControllerLoginRequest;
  deadlines: DeadlineCall[];
  requests: BridgeRequest[];
}

/* Build the login check over a bridge double, a deadline double, and the real device-list reading.
 *
 * The bridge double records each request, runs the row's own step where it has one, and hands back the very promise the row's answer makes, so the deadline can
 * be read for receiving it by identity. The deadline double records what it was handed and answers the promise it was handed, unless the row scripts a rejection,
 * which stands for the framework's deadline expiring before the bridge answers.
 *
 * @returns The check and every recorder beneath it.
 */
function standLogin({ answer, expiry, onRequest, seconds = 30 }: LoginStandOptions): LoginStand {

  const deadlines: DeadlineCall[] = [];
  const requests: BridgeRequest[] = [];
  const check = makeControllerLogin({

    deadline: seconds,
    readDeviceListAnswer,
    request: (path, payload) => {

      requests.push({ path, payload });
      onRequest?.();

      return answer();
    },
    withDeadline: async (options) => {

      deadlines.push(options);

      return expiry ? Promise.reject(expiry) : options.promise;
    }
  });

  return { check, deadlines, requests };
}

// The card's values and a signal no act retires, each of which a row overrides where the row is about it.
function loginRequest(overrides: Partial<LoginRequest> = {}): LoginRequest {

  return { ...LOGIN, address: ADDRESS, signal: new AbortController().signal, ...overrides };
}

describe("controller login check", () => {

  for(const field of [ "address", "password", "username" ] as const) {

    test("a missing " + field + " answers failed with the field sentence and makes no request", async () => {

      const s = standLogin({ answer: async () => ({ devices: LISTED_DEVICES, error: "" }) });

      assert.deepEqual(await s.check(loginRequest({ [field]: "" })), { kind: "failed", outcome: { lines: [MISSING_FIELD] } },
        "a blank " + field + " answers the field sentence");
      assert.deepEqual(s.requests, [], "and no request reaches the bridge for it");
    });
  }

  test("a device list answers passed with the devices, and the request carries the card's values", async () => {

    const s = standLogin({ answer: async () => ({ devices: LISTED_DEVICES, error: "" }) });

    assert.deepEqual(await s.check(loginRequest()), { devices: LISTED_DEVICES, kind: "passed" }, "a list answers passed with the controller's devices");
    assert.deepEqual(s.requests, [{ path: "/getDevices", payload: { ...LOGIN, address: ADDRESS } }],
      "and the one request asks the UI server for the devices with the address, password, and username alone");
  });

  test("an empty list with the server's reason answers failed with the login sentences and the reason as detail", async () => {

    const s = standLogin({ answer: async () => ({ devices: [], error: "Invalid username or password." }) });

    assert.deepEqual(await s.check(loginRequest()), { kind: "failed", outcome: { detail: "Invalid username or password.", lines: LOGIN_REFUSED } },
      "a controller that refused the login is the refused-login outcome carrying the controller's own reason");
  });

  test("a rejected request answers failed with the validation sentence and the rejection's message as detail", async () => {

    const s = standLogin({ answer: async () => Promise.reject(new Error("The UI server did not respond.")) });

    assert.deepEqual(await s.check(loginRequest()), { kind: "failed", outcome: { detail: "The UI server did not respond.", lines: [LOGIN_UNVALIDATED] } },
      "a request the bridge rejected is the UI server's failure carrying the rejection's own message");
  });

  test("the deadline is handed the request's own promise, the seconds the check was built with, and the caller's signal itself", async () => {

    const answered = Promise.resolve({ devices: LISTED_DEVICES, error: "" });
    const s = standLogin({ answer: () => answered, seconds: 17 });
    const request = loginRequest();

    await s.check(request);

    const deadline = only(s.deadlines, "the check bounds its one request once");

    assert.equal(deadline.promise, answered, "around the very promise the bridge's request answered");
    assert.equal(deadline.seconds, 17, "with the bound the check was built with");
    assert.equal(deadline.signal, request.signal, "and with the caller's own signal, so a retired check settles at once");
  });

  test("a deadline that expires answers failed with the validation sentence and the deadline's own sentence as detail", async () => {

    const s = standLogin({ answer: () => new Promise(() => undefined), expiry: new Error(DEADLINE_EXPIRED) });

    assert.deepEqual(await s.check(loginRequest()), { kind: "failed", outcome: { detail: DEADLINE_EXPIRED, lines: [LOGIN_UNVALIDATED] } },
      "a UI server that never answers is the UI server's failure, with the deadline's sentence saying how long the check waited");
  });

  // The card retires the check while its request is in flight, which is the moment a newer act on the card lands in practice.
  for(const [ settlement, answer ] of [ [ "fulfilled", async (): Promise<unknown> => ({ devices: LISTED_DEVICES, error: "" }) ],
    [ "rejected", async (): Promise<unknown> => Promise.reject(new Error("The UI server did not respond.")) ] ] as [ string, () => Promise<unknown> ][]) {

    test("a signal aborted before the settlement is read answers retired where the request " + settlement, async () => {

      const controller = new AbortController();
      const s = standLogin({ answer, onRequest: () => controller.abort() });

      assert.deepEqual(await s.check(loginRequest({ signal: controller.signal })), { kind: "retired" },
        "a check its card retired while the request was in flight answers retired, with nothing to show");
    });
  }
});
