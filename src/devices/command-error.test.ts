/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * command-error.test.ts: Unit tests for the shared device command-error helper (ProtectDevice.runDeviceCommand) and the write-through command path it single-sources.
 *
 * Device commands are write-through: this.device.update(payload) PATCHes the controller and throws the classified FatalError on a non-2xx, rather than returning null
 * on failure. runDeviceCommand is the one seam that converts that throw contract into the boolean every HomeKit onSet handler branches on, and the one place a
 * user-initiated command failure is reported - an authorization failure earns the actionable "full management role" guidance, any other is reported with its underlying
 * cause, rendered through the family-wide formatErrorMessage so the reported sentence carries exactly one terminal period. These tests pin that contract against the
 * real production method, then exercise the command paths that route through it - setStatusLed and the night-vision and access-unlock onSet reverts - through the HAP
 * test-double.
 *
 * ProtectDevice is the smallest real surface that carries the helper: the abstract base declares no abstract members, so a near-empty concrete leaf is a faithful
 * instance whose runDeviceCommand, setStatusLed, and statusLedCommand are all the base's own (the same admission reachability.test.ts relies on). The camera/light/etc.
 * leaves are not unit-constructable - they stand up a HAP accessory and, for cameras, the streaming stack at construction - so the leaf onSet closures themselves are
 * modeled here in the exact shape they ship, while the shared command seam they all route through is the real one.
 */
import { Characteristic, Service, makeTestAccessory } from "../testing.helpers.ts";
import { describe, test } from "node:test";
import type { Camera } from "unifi-protect";
import type { ProtectAccessory } from "../types.ts";
import { ProtectAuthorizationError } from "unifi-protect";
import { ProtectDevice } from "./device.ts";
import type { ProtectNvr } from "../nvr/nvr.ts";
import type { TestService } from "../testing.helpers.ts";
import assert from "node:assert/strict";
import util from "node:util";

// The smallest concrete leaf of the abstract base, mirroring reachability.test.ts. ProtectDevice declares no abstract members, so this adds nothing but a public window
// onto the protected command helper - runDeviceCommand, setStatusLed, and statusLedCommand are all the base's own, inherited unchanged.
class TestProtectDevice extends ProtectDevice {

  public runCommand(action: string, command: () => Promise<unknown>): Promise<boolean> {

    return this.runDeviceCommand(action, command);
  }
}

// A constructed device plus the handles a command test reads: the captured controller-log error lines (the helper's single failure-report sink) and the projection's
// write-through update thunk, which resolves or rejects to drive the success and failure paths.
interface CommandHarness {

  device: { config: Record<string, unknown>; isOnline: boolean; modelKey: string; name: string; peek: () => Record<string, unknown>;
    update: (payload: unknown) => Promise<unknown>; };
  errors: string[];
  instance: TestProtectDevice;
}

// Construct a real ProtectDevice against the minimal mocks the command path reads: a projection carrying modelKey (statusLedCommand narrows on it), name (the log
// prefix), and the write-through update thunk; a platform whose plugin logging root captures the rendered failure line; and a real AbortSignal for composeSignals. The
// casts are confined to this construction point; the instance itself is the production class.
const makeDevice = (update: (payload: unknown) => Promise<unknown> = () => Promise.resolve({}), modelKey = "camera"): CommandHarness => {

  const errors: string[] = [];
  const sink = (): void => undefined;
  // The device derives its prefixed logger from the platform's plugin logging root, so the capture lives on pluginLog. error renders the line through util.format - the
  // line the real Homebridge sink would write - so a command test matches against the final substituted text; the other levels sink.
  const log = { debug: sink, error: (message: string, ...parameters: unknown[]): void => { errors.push(util.format(message, ...parameters)); }, info: sink, warn: sink };
  // logName reads the live record through peek() (non-throwing), so the projection mock exposes it alongside config; the empty config makes describeDevice render the
  // same bare descriptor logName produces.
  const config = {};
  const device = { config, isOnline: true, modelKey, name: "Test Device", peek: (): Record<string, unknown> => config, update };
  const hap = { Characteristic: { StatusActive: Characteristic.StatusActive } };
  const nvr = {

    client: { connection: { isHealthy: true } },
    platform: { api: { hap }, debug: sink, log, pluginLog: log },
    signal: new AbortController().signal
  };
  const instance = new TestProtectDevice(nvr as unknown as ProtectNvr, makeTestAccessory() as unknown as ProtectAccessory, device as unknown as Camera);

  return { device, errors, instance };
};

// Assert exactly one failure line was reported and return it, narrowing past the noUncheckedIndexedAccess undefined so the caller can match against the message directly.
const onlyError = (errors: string[]): string => {

  assert.equal(errors.length, 1, "exactly one failure line is reported");

  const [message] = errors;

  assert.ok(message, "the failure line is present");

  return message;
};

describe("runDeviceCommand (real ProtectDevice)", () => {

  test("a successful command returns true and logs nothing", async () => {

    const { errors, instance } = makeDevice();
    let ran = false;
    const result = await instance.runCommand("turn the light on", async () => { ran = true; });

    assert.equal(result, true, "a command that resolves reports success");
    assert.equal(ran, true, "the supplied command thunk is invoked");
    assert.equal(errors.length, 0, "a successful command logs nothing");
  });

  test("an authorization failure returns false and logs the Administrator-role guidance", async () => {

    const { errors, instance } = makeDevice();
    const result = await instance.runCommand("turn the light on", () => Promise.reject(new ProtectAuthorizationError("forbidden")));

    assert.equal(result, false, "an authorization failure reports failure");
    assert.match(onlyError(errors), /Unable to turn the light on\. Please ensure this username has the full management role in UniFi Protect\./);
  });

  test("any other Error returns false and reports the action with its underlying cause", async () => {

    const { errors, instance } = makeDevice();
    const result = await instance.runCommand("adjust the brightness to 50%", () => Promise.reject(new Error("connection refused")));

    assert.equal(result, false, "a transient failure reports failure");
    assert.match(onlyError(errors), /Unable to adjust the brightness to 50%: connection refused\./);
  });

  test("a non-Error throw is reported through its string coercion", async () => {

    const { errors, instance } = makeDevice();

    // We deliberately reject with a non-Error value to exercise runDeviceCommand's String(error) fallback - the branch that reports a thrown value that is not an Error.
    // Commands only ever throw classified Error subclasses, so this is the defensive path, and rejecting with a non-Error is the whole point of the assertion.
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    const result = await instance.runCommand("set the doorbell message", () => Promise.reject("boom"));

    assert.equal(result, false);
    assert.match(onlyError(errors), /Unable to set the doorbell message: boom\./);
  });

  test("a non-auth error whose message already ends in a period logs exactly one terminal period", async () => {

    const { errors, instance } = makeDevice();

    // A classified error message is a full sentence ending in a period. The format string supplies its own terminal period, so without normalization the line would
    // end in a doubled "..". The helper renders the cause through formatErrorMessage, which strips the cause's trailing period so the sentence ends in exactly one.
    const result = await instance.runCommand("reboot the camera", () => Promise.reject(new Error("The camera is offline.")));

    assert.equal(result, false);
    assert.match(onlyError(errors), /Unable to reboot the camera: The camera is offline\.$/);
    assert.doesNotMatch(onlyError(errors), /\.\.$/);
  });

  test("a non-auth error whose message carries no terminal period still ends in exactly one", async () => {

    const { errors, instance } = makeDevice();
    const result = await instance.runCommand("reboot the camera", () => Promise.reject(new Error("connection refused")));

    assert.equal(result, false);
    assert.match(onlyError(errors), /Unable to reboot the camera: connection refused\.$/);
  });

  test("a non-auth error whose message ends in an ellipsis keeps the ellipsis intact", async () => {

    const { errors, instance } = makeDevice();

    // formatErrorMessage strips exactly one trailing period - the doubled sentence terminator - so an intentional ellipsis survives: two of its periods remain and the
    // format string's own terminal period completes the three. This is the family-wide cause rendering, shared with every other error line in the plugin.
    const result = await instance.runCommand("reboot the camera", () => Promise.reject(new Error("retrying...")));

    assert.equal(result, false);
    assert.match(onlyError(errors), /Unable to reboot the camera: retrying\.\.\.$/);
  });
});

describe("setStatusLed (real migrated command path)", () => {

  test("a successful set issues the ledSettings write-through update and reports success", async () => {

    let captured: unknown;
    const { errors, instance } = makeDevice(async (payload) => { captured = payload; });
    const result = await instance.setStatusLed(true);

    assert.equal(result, true, "the accepted command reports success");
    assert.deepEqual(captured, { ledSettings: { isEnabled: true } }, "a camera/sensor routes the ledSettings payload through the projection's update");
    assert.equal(errors.length, 0, "a successful set logs nothing");
  });

  test("an authorization failure reports failure with the status-indicator action and the Administrator-role guidance", async () => {

    const { errors, instance } = makeDevice(() => Promise.reject(new ProtectAuthorizationError("forbidden")));
    const result = await instance.setStatusLed(false);

    assert.equal(result, false);
    assert.match(onlyError(errors), /Unable to turn the status indicator light off\. Please ensure this username has the full management role in UniFi Protect\./);
  });
});

describe("migrated onSet revert through the HAP test-double", () => {

  // The night-vision onSet shape both camera reactions ship: push the command through the shared helper, and on failure revert the switch to its prior state. The leaf
  // defers the revert via setTimeout(50) in production; we apply it synchronously here so the HAP-double write is observable without a timer, and pre-set the
  // characteristic to the requested value first to model HAP applying the set to its read cache before the handler runs.
  const nightVisionOnSet = (harness: CommandHarness, service: TestService) => async (value: boolean): Promise<void> => {

    if(!(await harness.instance.runCommand("set night vision to " + (value ? "auto" : "off"),
      () => harness.device.update({ ispSettings: { irLedMode: value ? "auto" : "off" } })))) {

      service.updateCharacteristic(Characteristic.On, !value);
    }
  };

  test("an accepted command leaves the switch at the requested state and logs nothing", async () => {

    const harness = makeDevice(() => Promise.resolve({}));
    const service = makeTestAccessory().addService(Service.Switch, "Night Vision");
    const onChar = service.getCharacteristic(Characteristic.On);

    onChar.updateValue(true);
    await nightVisionOnSet(harness, service)(true);

    assert.equal(onChar.value, true, "a successful command does not revert the switch");
    assert.equal(harness.errors.length, 0);
  });

  test("a failed command reverts the switch to its prior state and logs the Administrator-role guidance", async () => {

    const harness = makeDevice(() => Promise.reject(new ProtectAuthorizationError("forbidden")));
    const service = makeTestAccessory().addService(Service.Switch, "Night Vision");
    const onChar = service.getCharacteristic(Characteristic.On);

    onChar.updateValue(true);
    await nightVisionOnSet(harness, service)(true);

    assert.equal(onChar.value, false, "the failed command reverts the switch to off");
    assert.match(onlyError(harness.errors), /full management role/);
  });
});

describe("access unlock onSet (real runDeviceCommand)", () => {

  // The access-unlock onSet shape the camera ships: push the unlock through the shared helper and, on failure, revert BOTH lock characteristics to SECURED. Production
  // defers the revert via setTimeout(50); we apply it synchronously so the writes are observable without a timer. The success path schedules an auto-re-lock on
  // a live keyed timer we do not model here, so we assert only that a successful unlock neither reverts the lock nor logs.
  const unlockOnSet = (harness: CommandHarness, service: TestService, unlock: () => Promise<unknown>) => async (): Promise<void> => {

    if(!(await harness.instance.runCommand("unlock the Access device", unlock))) {

      service.updateCharacteristic(Characteristic.LockTargetState, Characteristic.LockTargetState.SECURED);
      service.updateCharacteristic(Characteristic.LockCurrentState, Characteristic.LockCurrentState.SECURED);
    }
  };

  test("a failed unlock reverts both lock characteristics to SECURED and reports the cause", async () => {

    const harness = makeDevice();
    const service = makeTestAccessory().addService(Service.LockMechanism, "Lock");
    const current = service.getCharacteristic(Characteristic.LockCurrentState);
    const target = service.getCharacteristic(Characteristic.LockTargetState);

    // Model HomeKit's optimistic state: the set that brought us into the handler already moved both characteristics to UNSECURED.
    current.updateValue(Characteristic.LockCurrentState.UNSECURED);
    target.updateValue(Characteristic.LockTargetState.UNSECURED);

    await unlockOnSet(harness, service, () => Promise.reject(new Error("The Access device is unreachable.")))();

    assert.equal(current.value, Characteristic.LockCurrentState.SECURED, "a failed unlock reverts the current state to SECURED");
    assert.equal(target.value, Characteristic.LockTargetState.SECURED, "a failed unlock reverts the target state to SECURED");
    assert.match(onlyError(harness.errors), /Unable to unlock the Access device: The Access device is unreachable\.$/);
  });

  test("a successful unlock neither reverts the lock nor logs", async () => {

    const harness = makeDevice();
    const service = makeTestAccessory().addService(Service.LockMechanism, "Lock");
    const current = service.getCharacteristic(Characteristic.LockCurrentState);
    const target = service.getCharacteristic(Characteristic.LockTargetState);

    current.updateValue(Characteristic.LockCurrentState.UNSECURED);
    target.updateValue(Characteristic.LockTargetState.UNSECURED);

    await unlockOnSet(harness, service, () => Promise.resolve())();

    assert.equal(current.value, Characteristic.LockCurrentState.UNSECURED, "a successful unlock leaves the optimistic UNSECURED current state in place");
    assert.equal(target.value, Characteristic.LockTargetState.UNSECURED, "a successful unlock leaves the optimistic UNSECURED target in place");
    assert.equal(harness.errors.length, 0, "a successful unlock logs nothing");
  });

  test("an authorization failure reverts the lock and reports the Administrator-role guidance", async () => {

    const harness = makeDevice();
    const service = makeTestAccessory().addService(Service.LockMechanism, "Lock");
    const target = service.getCharacteristic(Characteristic.LockTargetState);

    target.updateValue(Characteristic.LockTargetState.UNSECURED);

    await unlockOnSet(harness, service, () => Promise.reject(new ProtectAuthorizationError("forbidden")))();

    assert.equal(target.value, Characteristic.LockTargetState.SECURED, "an authorization failure still reverts the lock to SECURED");
    assert.match(onlyError(harness.errors), /Unable to unlock the Access device\. Please ensure this username has the full management role in UniFi Protect\./);
  });
});
