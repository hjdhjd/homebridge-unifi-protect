/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * command-error.test.ts: Unit tests for the shared device command-error helper (ProtectDevice.runDeviceCommand) and the write-through command path it single-sources.
 *
 * Device commands are write-through: this.device.update(payload) PATCHes the controller and throws the classified FatalError on a non-2xx, rather than returning null
 * on failure. runDeviceCommand is the one place that converts that throw contract into the boolean every HomeKit onSet handler branches on, and the one place a
 * user-initiated command failure is reported - an authorization failure earns the actionable "full management role" guidance, any other is reported with its underlying
 * cause, rendered through the family-wide formatErrorMessage so the reported sentence carries exactly one terminal period. These tests pin that contract against the
 * real production method, then exercise the command paths that route through it - setStatusLed and the night-vision and access-unlock onSet reverts - through real
 * HAP services.
 *
 * ProtectDevice is the smallest real surface that carries the helper: the abstract base's one abstract member is the family's configureDevice, which a near-empty
 * concrete leaf answers with an empty body and never runs, since it is built without being configured, so the leaf is a faithful instance whose runDeviceCommand,
 * setStatusLed, and statusLedCommand are all the base's own (the same admission reachability.test.ts relies on). The camera/light/etc. leaves are not
 * unit-constructable - they stand up a HAP accessory and, for cameras, the streaming stack as they are configured - so the leaf onSet closures themselves are modeled
 * here in the exact shape they ship, while the shared command path they all route through is the real one.
 */
import { Characteristic, Service, hap, makeTestAccessory } from "../testing.helpers.ts";
import { TestClock, capturingLog, linesAt } from "homebridge-plugin-utils/testing";
import { describe, test } from "node:test";
import type { Camera } from "unifi-protect";
import type { CapturingLog } from "homebridge-plugin-utils/testing";
import { ProtectAuthorizationError } from "unifi-protect";
import { ProtectDevice } from "./device.ts";
import type { ProtectHints } from "./device.ts";
import type { ProtectNvr } from "../nvr/nvr.ts";
import { TEST_CLOCK_EPOCH } from "../nvr/testing.helpers.ts";
import assert from "node:assert/strict";

// The smallest concrete leaf of the abstract base, mirroring reachability.test.ts. Beside the empty configureDevice ProtectDevice requires, this adds nothing but a
// public window onto the protected command helper - runDeviceCommand, setStatusLed, and statusLedCommand are all the base's own, inherited unchanged.
class TestProtectDevice extends ProtectDevice {

  protected override configureDevice(): boolean {

    return true;
  }

  public runCommand(action: string, command: () => Promise<unknown>): Promise<boolean> {

    return this.runDeviceCommand(action, command);
  }
}

// A constructed device plus the handles a command test reads: the projection's write-through update thunk, which resolves or rejects to drive the success and failure
// paths, and the capturing log behind the controller's logging root, whose error lines are the helper's single failure-report sink.
interface CommandHarness {

  device: { config: Record<string, unknown>; isOnline: boolean; modelKey: string; name: string; peek: () => Record<string, unknown>;
    update: (payload: unknown) => Promise<unknown>; };
  instance: TestProtectDevice;
  log: CapturingLog;
}

// Construct a real ProtectDevice against the minimal mocks the command path reads: a projection carrying modelKey (statusLedCommand narrows on it), name (the log
// prefix), and the write-through update thunk; a platform whose plugin logging root captures the rendered failure line, carrying the test clock the spine's timer
// registry is built on, started at the harness epoch; and a real AbortSignal for composeSignals. The casts are confined to this construction point; the instance itself
// is the production class.
const makeDevice = (update: (payload: unknown) => Promise<unknown> = () => Promise.resolve({}), modelKey = "camera"): CommandHarness => {

  // The device derives its prefixed logger from the platform's plugin logging root, so the capture lives on pluginLog. A test reads the error lines rendered - the line
  // the real Homebridge sink would write - so it matches against the final substituted text.
  const log = capturingLog();
  // logName reads the live record through peek() (non-throwing), so the projection mock exposes it alongside config; the empty config makes describeDevice render the
  // same bare descriptor logName produces.
  const config = {};
  const device = { config, isOnline: true, modelKey, name: "Test Device", peek: (): Record<string, unknown> => config, update };
  const nvr = {

    client: { connection: { isHealthy: true } },
    platform: { api: { hap }, clock: new TestClock(TEST_CLOCK_EPOCH), log, pluginLog: log, testDebug: (): boolean => false },
    signal: new AbortController().signal
  };
  const instance = new TestProtectDevice(nvr as unknown as ProtectNvr, makeTestAccessory(), device as unknown as Camera);

  // The hints configure() resolves before a device logs its first line, which logName reads for the custom name. The vehicle never runs configure(), so it holds the
  // resting bag a device with no options set resolves: no custom name, so the prefix is the bare descriptor.
  const hints: ProtectHints = { enabled: true, logMotion: false, motionDuration: 10, nameOverride: null, nameOwned: false, occupancyDuration: 300, smartDetect: false,
    smartOccupancy: [], standalone: false };

  instance.hints = hints;

  return { device, instance, log };
};

// Assert exactly one failure line was reported and return it, narrowing past the noUncheckedIndexedAccess undefined so the caller can match against the message directly.
const onlyError = (errors: readonly string[]): string => {

  assert.equal(errors.length, 1, "exactly one failure line is reported");

  const [message] = errors;

  assert.ok(message, "the failure line is present");

  return message;
};

describe("runDeviceCommand (real ProtectDevice)", () => {

  test("a successful command returns true and logs nothing", async () => {

    const { instance, log } = makeDevice();
    let ran = false;
    const result = await instance.runCommand("turn the light on", async () => { ran = true; });

    assert.equal(result, true, "a command that resolves reports success");
    assert.equal(ran, true, "the supplied command thunk is invoked");
    assert.equal(linesAt(log.entries, "error").length, 0, "a successful command logs nothing");
  });

  test("an authorization failure returns false and logs the Administrator-role guidance", async () => {

    const { instance, log } = makeDevice();
    const result = await instance.runCommand("turn the light on", () => Promise.reject(new ProtectAuthorizationError("forbidden")));

    assert.equal(result, false, "an authorization failure reports failure");
    assert.match(onlyError(linesAt(log.entries, "error")), /Unable to turn the light on\. Please ensure this username has the full management role in UniFi Protect\./);
  });

  test("any other Error returns false and reports the action with its underlying cause", async () => {

    const { instance, log } = makeDevice();
    const result = await instance.runCommand("adjust the brightness to 50%", () => Promise.reject(new Error("connection refused")));

    assert.equal(result, false, "a transient failure reports failure");
    assert.match(onlyError(linesAt(log.entries, "error")), /Unable to adjust the brightness to 50%: connection refused\./);
  });

  test("a non-Error throw is reported through its string coercion", async () => {

    const { instance, log } = makeDevice();

    // We deliberately reject with a non-Error value to exercise runDeviceCommand's String(error) fallback - the branch that reports a thrown value that is not an Error.
    // Commands only ever throw classified Error subclasses, so this is the defensive path, and rejecting with a non-Error is the whole point of the assertion.
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- This test rejects with a non-Error value to exercise the fallback that reports one.
    const result = await instance.runCommand("set the doorbell message", () => Promise.reject("boom"));

    assert.equal(result, false);
    assert.match(onlyError(linesAt(log.entries, "error")), /Unable to set the doorbell message: boom\./);
  });

  test("a non-auth error whose message already ends in a period logs exactly one terminal period", async () => {

    const { instance, log } = makeDevice();

    // A classified error message is a full sentence ending in a period. The format string supplies its own terminal period, so without normalization the line would
    // end in a doubled "..". The helper renders the cause through formatErrorMessage, which strips the cause's trailing period so the sentence ends in exactly one.
    const result = await instance.runCommand("reboot the camera", () => Promise.reject(new Error("The camera is offline.")));

    assert.equal(result, false);
    assert.match(onlyError(linesAt(log.entries, "error")), /Unable to reboot the camera: The camera is offline\.$/);
    assert.doesNotMatch(onlyError(linesAt(log.entries, "error")), /\.\.$/);
  });

  test("a non-auth error whose message carries no terminal period still ends in exactly one", async () => {

    const { instance, log } = makeDevice();
    const result = await instance.runCommand("reboot the camera", () => Promise.reject(new Error("connection refused")));

    assert.equal(result, false);
    assert.match(onlyError(linesAt(log.entries, "error")), /Unable to reboot the camera: connection refused\.$/);
  });

  test("a non-auth error whose message ends in an ellipsis keeps the ellipsis intact", async () => {

    const { instance, log } = makeDevice();

    // formatErrorMessage strips exactly one trailing period - the doubled sentence terminator - so an intentional ellipsis survives: two of its periods remain and the
    // format string's own terminal period completes the three. This is the family-wide cause rendering, shared with every other error line in the plugin.
    const result = await instance.runCommand("reboot the camera", () => Promise.reject(new Error("retrying...")));

    assert.equal(result, false);
    assert.match(onlyError(linesAt(log.entries, "error")), /Unable to reboot the camera: retrying\.\.\.$/);
  });
});

describe("setStatusLed (real migrated command path)", () => {

  test("a successful set issues the ledSettings write-through update and reports success", async () => {

    let captured: unknown;
    const { instance, log } = makeDevice(async (payload) => { captured = payload; });
    const result = await instance.setStatusLed(true);

    assert.equal(result, true, "the accepted command reports success");
    assert.deepEqual(captured, { ledSettings: { isEnabled: true } }, "a camera/sensor routes the ledSettings payload through the projection's update");
    assert.equal(linesAt(log.entries, "error").length, 0, "a successful set logs nothing");
  });

  test("an authorization failure reports failure with the status-indicator action and the Administrator-role guidance", async () => {

    const { instance, log } = makeDevice(() => Promise.reject(new ProtectAuthorizationError("forbidden")));
    const result = await instance.setStatusLed(false);

    assert.equal(result, false);
    assert.match(onlyError(linesAt(log.entries, "error")),
      /Unable to turn the status indicator light off\. Please ensure this username has the full management role in UniFi Protect\./);
  });
});

describe("the onSet revert through HAP", () => {

  // The night-vision onSet shape both camera reactions ship: push the command through the shared helper, and on failure revert the switch to its prior state. The leaf
  // defers the revert through its deferred reflect in production; we apply it synchronously here so the HAP write is observable without a timer, and pre-set the
  // characteristic to the requested value first to model HAP applying the set to its read cache before the handler runs.
  const nightVisionOnSet = (harness: CommandHarness, service: Service) => async (value: boolean): Promise<void> => {

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
    assert.equal(linesAt(harness.log.entries, "error").length, 0);
  });

  test("a failed command reverts the switch to its prior state and logs the Administrator-role guidance", async () => {

    const harness = makeDevice(() => Promise.reject(new ProtectAuthorizationError("forbidden")));
    const service = makeTestAccessory().addService(Service.Switch, "Night Vision");
    const onChar = service.getCharacteristic(Characteristic.On);

    onChar.updateValue(true);
    await nightVisionOnSet(harness, service)(true);

    assert.equal(onChar.value, false, "the failed command reverts the switch to off");
    assert.match(onlyError(linesAt(harness.log.entries, "error")), /full management role/);
  });
});

describe("access unlock onSet (real runDeviceCommand)", () => {

  // The access-unlock onSet shape the camera ships: push the unlock through the shared helper and, on failure, revert BOTH lock characteristics to SECURED. Production
  // defers the revert through its deferred reflect; we apply it synchronously so the writes are observable without a timer. On success, production reports the
  // momentary unlock by pushing the UNSECURED current state and schedules an auto re-lock on a live keyed timer we do not model here, so we assert the report and that
  // nothing logs.
  const unlockOnSet = (harness: CommandHarness, service: Service, unlock: () => Promise<unknown>) => async (): Promise<void> => {

    if(!(await harness.instance.runCommand("unlock the Access device", unlock))) {

      service.updateCharacteristic(Characteristic.LockTargetState, Characteristic.LockTargetState.SECURED);
      service.updateCharacteristic(Characteristic.LockCurrentState, Characteristic.LockCurrentState.SECURED);

      return;
    }

    service.updateCharacteristic(Characteristic.LockCurrentState, Characteristic.LockCurrentState.UNSECURED);
  };

  test("a failed unlock reverts both lock characteristics to SECURED and reports the cause", async () => {

    const harness = makeDevice();
    const service = makeTestAccessory().addService(Service.LockMechanism, "Lock");
    const current = service.getCharacteristic(Characteristic.LockCurrentState);
    const target = service.getCharacteristic(Characteristic.LockTargetState);

    // HomeKit's set moved the target to UNSECURED on the way into the handler; we pre-seed current UNSECURED as well so the failure revert below is observable as a
    // genuine write rather than a default value.
    current.updateValue(Characteristic.LockCurrentState.UNSECURED);
    target.updateValue(Characteristic.LockTargetState.UNSECURED);

    await unlockOnSet(harness, service, () => Promise.reject(new Error("The Access device is unreachable.")))();

    assert.equal(current.value, Characteristic.LockCurrentState.SECURED, "a failed unlock reverts the current state to SECURED");
    assert.equal(target.value, Characteristic.LockTargetState.SECURED, "a failed unlock reverts the target state to SECURED");
    assert.match(onlyError(linesAt(harness.log.entries, "error")), /Unable to unlock the Access device: The Access device is unreachable\.$/);
  });

  test("a successful unlock reports the momentary unlock and logs nothing", async () => {

    const harness = makeDevice();
    const service = makeTestAccessory().addService(Service.LockMechanism, "Lock");
    const current = service.getCharacteristic(Characteristic.LockCurrentState);
    const target = service.getCharacteristic(Characteristic.LockTargetState);

    // HomeKit's set moves only the target on the way into the handler; current stays SECURED until the success path reports the momentary unlock.
    current.updateValue(Characteristic.LockCurrentState.SECURED);
    target.updateValue(Characteristic.LockTargetState.UNSECURED);

    await unlockOnSet(harness, service, () => Promise.resolve())();

    assert.equal(current.value, Characteristic.LockCurrentState.UNSECURED, "a successful unlock pushed the momentary UNSECURED current state");
    assert.equal(target.value, Characteristic.LockTargetState.UNSECURED, "a successful unlock leaves HomeKit's UNSECURED target in place");
    assert.equal(linesAt(harness.log.entries, "error").length, 0, "a successful unlock logs nothing");
  });

  test("an authorization failure reverts the lock and reports the Administrator-role guidance", async () => {

    const harness = makeDevice();
    const service = makeTestAccessory().addService(Service.LockMechanism, "Lock");
    const target = service.getCharacteristic(Characteristic.LockTargetState);

    target.updateValue(Characteristic.LockTargetState.UNSECURED);

    await unlockOnSet(harness, service, () => Promise.reject(new ProtectAuthorizationError("forbidden")))();

    assert.equal(target.value, Characteristic.LockTargetState.SECURED, "an authorization failure still reverts the lock to SECURED");
    assert.match(onlyError(linesAt(harness.log.entries, "error")),
      /Unable to unlock the Access device\. Please ensure this username has the full management role in UniFi Protect\./);
  });
});
