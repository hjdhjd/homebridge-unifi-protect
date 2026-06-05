/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * camera-best-effort.test.ts: Unit tests for the two migrated camera operations that deliberately bypass the shared command-error helper - the ambient-light query and
 * the package-camera flashlight heartbeat.
 *
 * Both are best-effort, cadenced calls onto the live v5 projection (this.device.lux() and this.device.turnOnFlashlight()): the lux query runs on a 60-second poll, the
 * flashlight pulse on a retry-and-timer keepalive. Because a higher-level cadence re-issues each one, a failure is swallowed to a no-op sentinel - the lux query's -1
 * ("no reading", which the poll skips on) and the flashlight pulse's false (stop the heartbeat, reflect the switch off) - rather than routed through runDeviceCommand,
 * which would log every failed poll or pulse. That is the one-sentence reason these two do not share the command-error seam the configuration writes use.
 *
 * The camera and package-camera leaves are not unit-constructable - the camera leaf transitively drags the streaming stack and both stand up a HAP accessory at
 * construction (the same admission command-error.test.ts discloses) - so each closure is modeled here in the exact shape it ships, over injected reachability and a
 * device thunk, and exercised across its reachable/success/zero/throw paths. There is no shared command seam to anchor against here, by design: the behavior under test
 * IS the local sentinel mapping, so the model carries the whole of it.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

// The getLux closure (camera.ts configureAmbientLightSensor) modeled in the shape it ships: skip the query when unreachable, otherwise read the live lux value, floor a
// genuine zero to HomeKit's 0.0001 minimum, and map any throw - a malformed body, a non-2xx, an unreachable mid-flight - to the -1 "no reading" sentinel.
const getLux = (isReachable: boolean, lux: () => Promise<number>) => async (): Promise<number> => {

  if(!isReachable) {

    return -1;
  }

  try {

    let reading = await lux();

    reading ||= 0.0001;

    return reading;
  } catch {

    return -1;
  }
};

// The flashlight retry-inner closure (camera-package.ts) modeled in the shape it ships: stop when unreachable, otherwise pulse the flashlight and map success to true and
// any throw to false. The pulse is momentary and re-issued by the surrounding retry/timer, so a failure is swallowed silently rather than logged.
const pulseFlashlight = (isReachable: boolean, turnOnFlashlight: () => Promise<void>) => async (): Promise<boolean> => {

  if(!isReachable) {

    return false;
  }

  try {

    await turnOnFlashlight();

    return true;
  } catch {

    return false;
  }
};

describe("ambient-light query closure (getLux)", () => {

  test("an unreachable camera returns the -1 no-reading sentinel without issuing the query", async () => {

    let queried = false;
    const reading = await getLux(false, async () => {

      queried = true;

      return 5;
    })();

    assert.equal(reading, -1, "an unreachable camera skips straight to the no-reading sentinel");
    assert.equal(queried, false, "the doomed query is never issued");
  });

  test("a positive reading is returned unchanged", async () => {

    const reading = await getLux(true, () => Promise.resolve(42.5))();

    assert.equal(reading, 42.5, "a real reading passes through untouched");
  });

  test("a genuine zero reading is floored to HomeKit's 0.0001 minimum", async () => {

    const reading = await getLux(true, () => Promise.resolve(0))();

    assert.equal(reading, 0.0001, "a zero reading is floored to the HomeKit minimum rather than reported as zero");
  });

  test("a thrown reading maps to the -1 no-reading sentinel", async () => {

    // This is the blessed stricter behavior: a malformed or missing reading (the library throws ProtectProtocolError on a non-numeric body) becomes "no reading" and the
    // poll skips the update, rather than v4's "treat a malformed body as min-light 0.0001".
    const reading = await getLux(true, () => Promise.reject(new Error("The lux response did not contain a numeric illuminance reading.")))();

    assert.equal(reading, -1, "any failure to read becomes the no-reading sentinel");
  });
});

describe("package-camera flashlight heartbeat closure (pulseFlashlight)", () => {

  test("an unreachable camera stops the heartbeat without pulsing", async () => {

    let pulsed = false;
    const lit = await pulseFlashlight(false, async () => { pulsed = true; })();

    assert.equal(lit, false, "an unreachable camera reflects the flashlight off");
    assert.equal(pulsed, false, "the doomed pulse is never issued");
  });

  test("a successful pulse reports the flashlight lit", async () => {

    const lit = await pulseFlashlight(true, () => Promise.resolve())();

    assert.equal(lit, true, "a pulse the controller accepts keeps the flashlight lit");
  });

  test("a failed pulse is swallowed to off rather than thrown or logged", async () => {

    const lit = await pulseFlashlight(true, () => Promise.reject(new Error("The flashlight pulse was rejected.")))();

    assert.equal(lit, false, "a failed pulse stops the heartbeat by reflecting off, with no error surfaced");
  });
});
