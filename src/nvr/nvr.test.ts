/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * nvr.test.ts: Unit tests for the controller root's pure decision logic - the startup-resilient connect retry policy, the request-outcome classifier, the
 * removal-stability arithmetic, the disruption-expectation gating (the classification, its induced and recency halves, and the episode-latch), the induced-reboot resume
 * decision, the scheduled-reboot arithmetic with the recording-count rule behind its deferral and the span of its expected return, and the address override rule - plus
 * the NvrHealth connection-input mapping those drive, and the real controller root's disabled-controller path, its stability sweep's liveviews pass, its connect retry,
 * its address override, the accessory cache saves its adoption asks for, the name it adds a camera under when the camera's own name sanitizes to nothing or the user gave
 * it a custom name, its removal of a package camera whose parent is gone, its device-removal cascade: the guards that leave an accessory alone, the name each removal is
 * logged under, the package camera a removal takes with it, and what a removal releases, and the lines its client logger shows through a scheduled reboot.
 *
 * ProtectNvr itself is a composition root: its constructor stands up the event handler and the controller logging, and it transitively owns the entire device and
 * media graph. The response is to keep the *decisions* it makes in a pure leaf module (nvr-policy.ts) and assert those here, exercising the controller's real
 * behavior (the connect retry's schedules and reports, request-outcome-to-symptom mapping) without mocking a client. The connect retry's schedules are walked through
 * HBPU's own retry on a test clock, so the rows read the waits the retry actually asked for. The connection-input mapping is verified against the real NvrHealth
 * with an injected clock, so the test proves both the mapping and the reducer/window behavior it feeds.
 *
 * The root's one external boundary is its connect port, so a path that is the root's own rather than a decision it delegates runs through the real root: it is built
 * over the controller double's platform with a client double answering the port, a row that needs the library's own refusal keeping that platform and running the
 * real connect in the double's place, and the platform's shutdown registration is run at the end of each row so no process-global diagnostics subscription outlives
 * it. The device-removal cascade runs
 * through the real root the same way: it is a companion the root constructs (nvr-removal-cascade.ts), and the controller double constructs the same one, so the
 * cascade these rows record is the code every removal in either runs. The controller's own MQTT availability statements run through the real root over HBPU's MQTT
 * double.
 */
import { ACCESSORY_SAVE_WINDOW_MS, APIEvent, retry } from "homebridge-plugin-utils";
import type { ConnectFailure, ConnectFailureType } from "./nvr-policy.ts";
import type { ConnectOptions, ProtectCameraConfig, ProtectClient, ProtectLogging, ProtectNvrConfig } from "unifi-protect";
import { G2_PRO_CHANNELS, G6_PRO_ENTRY_CHANNELS } from "../camera.fixtures.ts";
import { PROTECT_DEVICE_REMOVAL_DELAY_INTERVAL, PROTECT_NVR_REBOOT_CONFIRM_GRACE_MS, PROTECT_NVR_REBOOT_INTERVAL, PROTECT_NVR_REBOOT_MIN_INTERVAL,
  PROTECT_NVR_REMOVAL_STABILITY_WINDOW } from "../settings.ts";
import { PROTECT_REBOOT_ANTICIPATION_WINDOW_MS, PROTECT_RECOVERY_BACKOFF_KNOWN_MS, PROTECT_RECOVERY_BACKOFF_UNKNOWN_MS, PROTECT_RECOVERY_REFUSAL_SCHEDULE_MS,
  PROTECT_RECOVERY_STEADY_INTERVAL_MS, ProtectAbortedError, ProtectAuthError, ProtectAuthorizationError, ProtectBootstrapError, ProtectCertificateError,
  ProtectConfigurationError, ProtectNetworkError, ProtectProtocolError, ProtectRequestError, ProtectStallError, ProtectThrottledError, ProtectTimeoutError,
  channels as protectChannels } from "unifi-protect";
import { REBOOT_EXPECTED_RETURN_MS, canTransition, classifyRebootAttempt, computeInitialRebootDelay, computeStableSince, connectFailureReading, countActiveRecordingViews,
  createConnectRetryPolicy, createLivestreamEpisodeLatch, isDisruptionExpected, isInducedDisruption, isRequestForController, isStabilityWindowElapsed,
  isSuccessfulRequest, isWithinRebootRecency, resolveOverrideAddress, shouldResumeFromInducedReboot } from "./nvr-policy.ts";
import { TEST_CLOCK_EPOCH, TestConnection, makeConnectedClient, makeNvrConfig, makeRootPlatform, makeTestNvr,
  restoreAccessories } from "./testing.helpers.ts";
import { TestClock, TestMqttClient, assertNoUnhandledRejections, capturingLog, formatLogEntry, linesAt, logCount, loggedAt, settle,
  settleUntil } from "homebridge-plugin-utils/testing";
import type { TestHomebridgeApi, TestLogEntry } from "homebridge-plugin-utils/testing";
import { TestStateStore, accessoryUuid, makeProtectState, makeTestAccessory } from "../testing.helpers.ts";
import { describe, test } from "node:test";
import type { Nullable } from "homebridge-plugin-utils";
import { NvrHealth } from "./nvr-health.ts";
import type { NvrPhase } from "./nvr.ts";
import type { ProtectAccessory } from "../types.ts";
import { ProtectCamera } from "../devices/cameras/camera.ts";
import { ProtectNvr } from "./nvr.ts";
import type { TestProtectNvr } from "./testing.helpers.ts";
import assert from "node:assert/strict";
import { makeCameraConfig } from "../devices/testing.helpers.ts";
import { once } from "node:events";

// The instant each health observer's test clock starts at, so the sliding window is driven by the test rather than wall time. Any nonzero epoch serves: the rows stamp
// every symptom from the same clock the observer reads, so only the window's arithmetic reaches an assertion.
const HEALTH_CLOCK_EPOCH = 1000000;

// A failure as the platform raises it for a socket, its errno on the code a transport reads.
function errnoError(code: string, detail: string): Error {

  return Object.assign(new Error(detail), { code });
}

// A request's failure as unifi-protect's transport raises one for a socket: its network error, over the errno the platform failed the request with.
function networkFailure(code: string, detail: string): ProtectNetworkError {

  return new ProtectNetworkError("A network error occurred communicating with the UniFi Protect controller.", { cause: errnoError(code, detail) });
}

// A status the controller answered a request with, as unifi-protect's request error carries it.
function answered(statusCode: number): ProtectRequestError {

  return new ProtectRequestError("The UniFi Protect controller answered the request with HTTP status " + statusCode.toString() + ".", { statusCode });
}

// What a bootstrap's fetch stage raises when the document's read fails, which unifi-protect carries as the cause.
function fetchFailed(cause: Error): ProtectBootstrapError {

  return new ProtectBootstrapError("Unable to fetch the UniFi Protect controller bootstrap.", { cause, stage: "fetch" });
}

// A fault other than a refusal, which is what a controller that declines the connection raises, and the reason a user reads for it.
const networkError = networkFailure("ECONNREFUSED", "connect ECONNREFUSED 10.0.0.1:443");
const NETWORK_REASON = "A network error occurred communicating with the UniFi Protect controller: connect ECONNREFUSED 10.0.0.1:443";

// A refused sign-in, in the library's authentication error, the spelling a controller that rejects the configured credentials answers with.
const refusalError = new ProtectAuthError("bad credentials");

// A refused request rate in each of its spellings: bare, the 429 answer the library's request error carries, and wrapped, as the cause of the fetch-stage bootstrap
// error a refused bootstrap read arrives in.
const rateLimitError = answered(429);
const wrappedRateLimitError = fetchFailed(rateLimitError);

// A refused realtime upgrade, the codeless failure undici's empty WebSocket error leaves unifi-protect's socket to raise.
const realtimeRefusal = new ProtectNetworkError("The UniFi Protect realtime events API connection failed.", { cause: new TypeError("") });

// A deadline that elapsed with nothing answered, over the platform's own timeout rejection.
const deadlineError = new ProtectTimeoutError("The UniFi Protect controller did not respond before the request deadline elapsed.",
  { cause: new DOMException("The operation was aborted due to timeout", "TimeoutError"), elapsedMs: 3500 });

// The privilege refusal a bootstrap read can meet, which unifi-protect's request path raises for a 403 and its fetch stage wraps.
const privilegeRefusal = fetchFailed(new ProtectAuthorizationError("The account lacks the privileges this operation requires on the UniFi Protect controller.",
  { statusCode: 403 }));

// Every spelling of a refusal the library reads as one: a refused identity, in its authentication error, a refused privilege, in its authorization error, and a
// refused request rate, the 429 answer its request error carries.
const REFUSAL_SPELLINGS = [ refusalError, new ProtectAuthorizationError("not an administrator"), rateLimitError ];

/* Walk HBPU's retry over a fresh connect retry policy on a test clock: each attempt fails with the next of the given errors, and the attempt after the last of them
 * connects. Each pass lets the failed attempt reach the wait the retry asks the clock for, then steps the clock to that wait's deadline, so the run walks the
 * policy's schedules on virtual time as the controller root's retry walks them.
 *
 * @param failures - The error each attempt fails with, in attempt order.
 *
 * @returns Every wait the retry asked the clock for, in order, and every failure the policy reported.
 */
async function walkConnectRetry(failures: readonly Error[]): Promise<{ reports: ConnectFailure[]; waits: number[] }> {

  const clock = new TestClock();
  const reports: ConnectFailure[] = [];
  const { backoff, shouldRetry } = createConnectRetryPolicy({ onFailure: (failure: ConnectFailure): void => void reports.push(failure) });

  let attempt = 0;

  const run = retry(async (): Promise<string> => {

    const failure = failures[attempt++];

    if(failure) {

      throw failure;
    }

    return "connected";
  }, { attempts: Infinity, backoff, clock, shouldRetry });

  for(const [index] of failures.entries()) {

    // eslint-disable-next-line no-await-in-loop -- Each failed attempt has to reach its wait before the clock can step to that wait's deadline.
    await settleUntil(() => clock.pending > 0, { description: "the wait after failure " + (index + 1).toString() });
    clock.advanceToNext();
  }

  assert.equal(await run, "connected", "the attempt after the last failure connects, so the run ends on the controller accepting it");

  return { reports, waits: [...clock.requested] };
}

describe("connect retry policy", () => {

  test("a fault other than a refusal waits out the library's recovery schedule, then holds at its steady floor", async () => {

    // More than one failure past the last staged delay, so the floor is shown to hold rather than to be one more rung.
    const failures = Array.from({ length: PROTECT_RECOVERY_BACKOFF_UNKNOWN_MS.length + 2 }, () => networkError);

    assert.deepEqual((await walkConnectRetry(failures)).waits, [ ...PROTECT_RECOVERY_BACKOFF_UNKNOWN_MS, PROTECT_RECOVERY_STEADY_INTERVAL_MS,
      PROTECT_RECOVERY_STEADY_INTERVAL_MS ]);
  });

  test("a refused sign-in, privilege or request rate, in every spelling, waits out the library's refusal schedule, then holds at its floor", async () => {

    const { backoff, steady } = PROTECT_RECOVERY_REFUSAL_SCHEDULE_MS;
    // More than one failure past the last staged delay, so the floor is shown to hold rather than to be one more rung.
    const expected = [ ...backoff, steady, steady ];

    // Each spelling walks the whole schedule on its own, so a spelling the policy misread as an ordinary fault would open on the recovery schedule's first rung.
    for(const refusal of REFUSAL_SPELLINGS) {

      // eslint-disable-next-line no-await-in-loop -- Each spelling walks a retry of its own, and one walk at a time keeps each assertion's message its own spelling's.
      assert.deepEqual((await walkConnectRetry(Array.from({ length: expected.length }, () => refusal))).waits, expected, refusal.message);
    }

    // A refused identity, a refused privilege and a refused request rate are one class, so a run that moves among them walks one schedule rather than restarting it.
    const interleaved = Array.from({ length: expected.length }, (_, index) => REFUSAL_SPELLINGS[index % REFUSAL_SPELLINGS.length] ?? refusalError);

    assert.deepEqual((await walkConnectRetry(interleaved)).waits, expected);
  });

  test("a refusal a bootstrap error carries as its cause waits as the bare refusal does, and any other wrapped fault as an ordinary one", async () => {

    const { backoff, steady } = PROTECT_RECOVERY_REFUSAL_SCHEDULE_MS;
    const refusalWaits = [ ...backoff, steady, steady ];

    /* The library's bootstrap wraps a refused document read, whether the controller refused the session, a privilege or the request rate, as the cause of a
     * fetch-stage bootstrap error. That is a controller that answered and refused, so the wrapper waits exactly as the bare refusal does.
     */
    for(const refusal of REFUSAL_SPELLINGS) {

      const wrapped = new ProtectBootstrapError("Unable to fetch the UniFi Protect controller bootstrap.", { cause: refusal, stage: "fetch" });

      // eslint-disable-next-line no-await-in-loop -- Each wrapper walks a retry of its own, and one walk at a time keeps each assertion's message its own refusal's.
      assert.deepEqual((await walkConnectRetry(Array.from({ length: refusalWaits.length }, () => wrapped))).waits, refusalWaits, refusal.message);
    }

    // A document that arrived and could not be read carries no refusal, so its wrapper walks the recovery schedule like any other fault.
    const unreadable = new ProtectBootstrapError("Unable to parse the UniFi Protect controller bootstrap.",
      { cause: new SyntaxError("Unexpected end of JSON input"), stage: "parse" });

    assert.deepEqual((await walkConnectRetry(Array.from({ length: PROTECT_RECOVERY_BACKOFF_UNKNOWN_MS.length + 2 }, () => unreadable))).waits,
      [ ...PROTECT_RECOVERY_BACKOFF_UNKNOWN_MS, PROTECT_RECOVERY_STEADY_INTERVAL_MS, PROTECT_RECOVERY_STEADY_INTERVAL_MS ]);
  });

  test("a request the controller answered with a status other than a rate limit waits out the library's recovery schedule, bare or wrapped", async () => {

    const recoveryWaits = [ ...PROTECT_RECOVERY_BACKOFF_UNKNOWN_MS, PROTECT_RECOVERY_STEADY_INTERVAL_MS, PROTECT_RECOVERY_STEADY_INTERVAL_MS ];

    /* A 404 is an answer a controller gives while it reboots, and the library classifies it as the same request error it classifies a rate limit as. It refuses
     * nothing, because the controller is not yet serving the request rather than asking to be asked less often, so it walks the recovery schedule bare and as the
     * cause of a fetch-stage bootstrap error alike...a policy that read every request error as a refusal would open it on the refusal schedule's first rung.
     */
    const notFound = new ProtectRequestError("The UniFi Protect controller answered the request with HTTP status 404.", { statusCode: 404 });
    const wrapped = new ProtectBootstrapError("Unable to fetch the UniFi Protect controller bootstrap.", { cause: notFound, stage: "fetch" });

    for(const failure of [ notFound, wrapped ]) {

      // eslint-disable-next-line no-await-in-loop -- Each spelling walks a retry of its own, and one walk at a time keeps each assertion's message its own spelling's.
      assert.deepEqual((await walkConnectRetry(Array.from({ length: recoveryWaits.length }, () => failure))).waits, recoveryWaits, failure.message);
    }
  });

  test("a change of class restarts the new class's schedule at its first rung, whichever way the class changes", async () => {

    const [ firstRecovery, secondRecovery, thirdRecovery ] = PROTECT_RECOVERY_BACKOFF_UNKNOWN_MS;
    const [ firstRefusal, secondRefusal ] = PROTECT_RECOVERY_REFUSAL_SCHEDULE_MS.backoff;

    /* A run of ordinary faults, then refusals, then ordinary faults again. The retry hands each wait its own attempt number, which counts the whole run, so a wait
     * that read it would land each change partway down the new schedule rather than on its first rung.
     */
    const { waits } = await walkConnectRetry([ networkError, networkError, networkError, refusalError, refusalError, networkError, networkError ]);

    assert.deepEqual(waits, [ firstRecovery, secondRecovery, thirdRecovery, firstRefusal, secondRefusal, firstRecovery, secondRecovery ]);
  });

  test("every class of fault but a refused address is retried at every rung of its schedule, its steady floor included", () => {

    // More than one failure past the longer schedule's last staged delay, so each class is asked about on its floor as well as on each of its rungs.
    const run = Math.max(PROTECT_RECOVERY_BACKOFF_UNKNOWN_MS.length, PROTECT_RECOVERY_REFUSAL_SCHEDULE_MS.backoff.length) + 2;

    for(const failure of [ networkError, new TypeError("Cannot read properties of undefined (reading 'nvr')"), ...REFUSAL_SPELLINGS ]) {

      const { shouldRetry } = createConnectRetryPolicy();

      for(let attempt = 1; attempt <= run; attempt++) {

        assert.equal(shouldRetry(failure), true, "a fault the controller or the network can recover from is retried however long the run has lasted");
      }
    }
  });

  test("the connect retry policy stops at an address no URL can carry without reporting it, and retries a refused certificate, an unresolvable host and a " +
    "refused sign-in", () => {

    const reports: string[] = [];
    const { shouldRetry } = createConnectRetryPolicy({ onFailure: ({ reason }: ConnectFailure): void => void reports.push(reason) });

    // The library's own refusal of an address carrying more than a host and a port, worded as unifi-protect words it.
    assert.equal(shouldRetry(new ProtectConfigurationError("The controller address \"nvr.local/path\" carries more than a host and a port.")), false,
      "the same address is refused the same way on every attempt, so the run ends on the first");
    assert.deepEqual(reports, [], "and the veto reaches no report, so no retrying reason is said ahead of the caller's own line");

    /* The negative controls, each asked of the same policy, since the veto leaves the run's state alone. A refused certificate and an unresolvable host are faults an
     * operator fixes while the process runs, and a refused sign-in is fatal to the library yet still retried here, because a password corrected on the controller is
     * picked up by the next attempt...a veto reading the library's fatal class rather than the configuration class would stop the last of these.
     */
    const controls = [ new ProtectCertificateError({ cause: new Error("self-signed certificate"), host: "nvr.local" }),
      new ProtectNetworkError("Unable to resolve nvr.local.", { code: "ENOTFOUND" }), refusalError ];

    for(const control of controls) {

      assert.equal(shouldRetry(control), true, control.message);
    }

    assert.equal(reports.length, controls.length, "and each is reported as the retried fault it is");
  });

  test("a run reports every retried failure, a repeat of the same reason among them, because the memory of what was said is the caller's", async () => {

    /* Distinct error instances that read identically, which is the shape a refusal takes when each attempt throws afresh. A policy that held its own memory would hand
     * over the first of them alone, and the caller's repeat-demoting log would never see a repeat to demote.
     */
    const { reports } = await walkConnectRetry(Array.from({ length: 3 }, () => new ProtectAuthError("bad credentials")));

    assert.deepEqual(reports, Array.from({ length: 3 }, () => ({ level: "error", reason: "bad credentials", type: "refused-identity" })),
      "each attempt reports the reading and the text a user reads");

    // The same policy with no callback retries identically, so reporting is an addition to the verdict and never a change to it.
    assert.equal(createConnectRetryPolicy().shouldRetry(refusalError), true);
  });

  test("a report's reason carries the whole cause chain a user reads", async () => {

    const { reports } = await walkConnectRetry([fetchFailed(answered(503))]);

    assert.deepEqual(reports, [{ level: "warning",
      reason: "Unable to fetch the UniFi Protect controller bootstrap: The UniFi Protect controller answered the request with HTTP status 503", type: "status" }]);
  });

  test("a run that moves between failures reports each with its own reading, a return to an earlier failure included", async () => {

    const { reports } = await walkConnectRetry([ networkError, refusalError, networkError ]);

    assert.deepEqual(reports, [ { level: "warning", reason: NETWORK_REASON, type: "refused" }, { level: "error", reason: "bad credentials", type: "refused-identity" },
      { level: "warning", reason: NETWORK_REASON, type: "refused" } ]);
  });

  test("a rate limit reads as one whichever spelling it arrives in, and a run of them walks the refusal schedule without a restart", async () => {

    const { backoff, steady } = PROTECT_RECOVERY_REFUSAL_SCHEDULE_MS;
    const expected = [ ...backoff, steady, steady ];

    /* A rate limit's bare and wrapped spellings read as different texts while every attempt meets the same controller asking to be asked less often, so the type is what
     * a caller compares. The run keeps one class throughout, so it walks the refusal schedule without a restart.
     */
    const { reports, waits } = await walkConnectRetry(Array.from({ length: expected.length },
      (_, index) => ((index % 2) === 0) ? rateLimitError : wrappedRateLimitError));

    assert.deepEqual(reports.map(({ level, type }) => ({ level, type })), Array.from({ length: expected.length }, () => ({ level: "warning", type: "rate-limit" })));
    assert.deepEqual(waits, expected);
  });
});

describe("the reading of a failed connect", () => {

  // The shapes whose construction would not sit on a table row, each as unifi-protect raises it. The pool reset and the certificate refusal are hand-spelled, because no
  // connect raises them...the plugin never asks unifi-protect to verify a certificate.
  const PROTOCOL_MESSAGE = "The UniFi Protect controller returned a response that could not be parsed as JSON.";
  const parseFailed = new ProtectBootstrapError("Unable to parse the UniFi Protect controller bootstrap.",
    { cause: new ProtectProtocolError(PROTOCOL_MESSAGE, { cause: new SyntaxError("Unexpected end of JSON input") }), stage: "parse" });
  const applyFailed = new ProtectBootstrapError("Unable to apply the UniFi Protect controller bootstrap.",
    { cause: new TypeError("Cannot read properties of undefined (reading 'mac')"), stage: "apply" });
  const connectTimeout = new ProtectTimeoutError("The connection to the UniFi Protect controller timed out.",
    { cause: errnoError("UND_ERR_CONNECT_TIMEOUT", "Connect Timeout Error"), elapsedMs: 10000 });
  const retriesExhausted = new ProtectNetworkError("The response from the UniFi Protect controller did not match the range or length the request expected.",
    { cause: errnoError("UND_ERR_REQ_RETRY", "Request failed") });
  const poolReset = new ProtectNetworkError("The request was interrupted because the connection pool was reset.",
    { cause: errnoError("UND_ERR_DESTROYED", "The client is destroyed") });
  const stall = new ProtectStallError("The UniFi Protect realtime events API produced no data within the watchdog window.", { silentForMs: 300000 });
  const breaker = new ProtectThrottledError("Requests to the UniFi Protect controller are throttled after repeated failures.", { cooldownMs: 30000 });
  const aborted = new ProtectAbortedError("The request was aborted by the caller's signal.", { cause: new DOMException("This operation was aborted", "AbortError") });
  const certificate = new ProtectCertificateError({ cause: errnoError("DEPTH_ZERO_SELF_SIGNED_CERT", "self-signed certificate"), host: "nvr.local:443" });
  const refusedLogin = new ProtectAuthError("Unable to authenticate with the UniFi Protect controller. Please check the configured address, username, and password.");
  const refusedSession = new ProtectAuthError("Authentication with the UniFi Protect controller failed.", { statusCode: 401 });

  /* One row for each shape a connect can end in, spelled as unifi-protect raises it, its cause included, so a row reads what a real failure carries. The rows named
   * hand-spelled are the exceptions: no connect raises that shape, and each holds an arm or a floor that no real shape reaches. The reading's last arm is a catch-all, so
   * a shape nobody listed would read a level with no line in any diff, which is why each is listed rather than one standing for its class.
   */
  const READINGS: readonly { error: unknown; level: ConnectFailure["level"]; name: string; type: ConnectFailureType }[] = [

    { error: refusedLogin, level: "error", name: "a refused login", type: "refused-identity" },
    { error: fetchFailed(refusedSession), level: "error", name: "a refused session under a fetch wrapper", type: "refused-identity" },
    { error: privilegeRefusal.cause, level: "error", name: "a hand-spelled bare refused privilege", type: "refused-privilege" },
    { error: privilegeRefusal, level: "error", name: "a refused privilege under a fetch wrapper", type: "refused-privilege" },
    { error: answered(429), level: "warning", name: "a bare 429", type: "rate-limit" },
    { error: fetchFailed(answered(429)), level: "warning", name: "a wrapped 429", type: "rate-limit" },
    { error: answered(503), level: "warning", name: "a bare 503", type: "status" },
    { error: fetchFailed(answered(503)), level: "warning", name: "a wrapped 503", type: "status" },
    { error: answered(404), level: "warning", name: "a bare 404", type: "status" },
    { error: fetchFailed(answered(404)), level: "warning", name: "a wrapped 404", type: "status" },
    { error: answered(301), level: "warning", name: "a bare 301", type: "status" },
    { error: fetchFailed(answered(301)), level: "warning", name: "a wrapped 301", type: "status" },
    { error: new ProtectProtocolError(PROTOCOL_MESSAGE), level: "error", name: "a hand-spelled bare protocol error", type: "unreadable" },
    { error: parseFailed, level: "error", name: "a parse wrapper", type: "unreadable" },
    { error: applyFailed, level: "error", name: "an apply wrapper", type: "unreadable" },
    { error: new Error("A value unifi-protect did not type."), level: "error", name: "a hand-spelled plain Error", type: "unreadable" },
    { error: new TypeError("Cannot read properties of undefined (reading 'nvr')"), level: "error", name: "a hand-spelled bare TypeError", type: "unreadable" },
    { error: networkFailure("ECONNREFUSED", "connect ECONNREFUSED 10.0.0.1:443"), level: "warning", name: "ECONNREFUSED", type: "refused" },
    { error: networkFailure("ECONNRESET", "read ECONNRESET"), level: "warning", name: "ECONNRESET", type: "reset" },
    { error: networkFailure("EHOSTUNREACH", "connect EHOSTUNREACH 10.0.0.1:443"), level: "warning", name: "EHOSTUNREACH", type: "unreachable" },
    { error: networkFailure("EHOSTDOWN", "connect EHOSTDOWN 10.0.0.1:443"), level: "warning", name: "EHOSTDOWN", type: "unreachable" },
    { error: networkFailure("ENETDOWN", "connect ENETDOWN 10.0.0.1:443"), level: "warning", name: "ENETDOWN", type: "unreachable" },
    { error: networkFailure("ETIMEDOUT", "connect ETIMEDOUT 10.0.0.1:443"), level: "warning", name: "ETIMEDOUT", type: "unreachable" },
    { error: deadlineError, level: "warning", name: "a request deadline over its DOMException", type: "timeout" },
    { error: connectTimeout, level: "warning", name: "UND_ERR_CONNECT_TIMEOUT", type: "connect-timeout" },
    { error: networkFailure("UND_ERR_SOCKET", "other side closed"), level: "warning", name: "UND_ERR_SOCKET", type: "transport" },
    { error: retriesExhausted, level: "warning", name: "UND_ERR_REQ_RETRY", type: "retries-exhausted" },
    { error: poolReset, level: "warning", name: "a hand-spelled UND_ERR_DESTROYED", type: "destroyed" },
    { error: networkFailure("ERR_SSL_WRONG_VERSION_NUMBER", "wrong version number"), level: "warning", name: "ERR_SSL_WRONG_VERSION_NUMBER", type: "transport" },
    { error: realtimeRefusal, level: "warning", name: "a codeless realtime refusal", type: "transport" },
    { error: stall, level: "warning", name: "a stalled upgrade", type: "transport" },
    { error: breaker, level: "warning", name: "a hand-spelled open breaker", type: "transport" },
    { error: aborted, level: "warning", name: "an aborted request", type: "timeout" },
    { error: networkFailure("ENOTFOUND", "getaddrinfo ENOTFOUND nvr.invalid"), level: "error", name: "ENOTFOUND", type: "no-such-host" },
    { error: networkFailure("EAI_AGAIN", "getaddrinfo EAI_AGAIN nvr.local"), level: "warning", name: "EAI_AGAIN", type: "dns" },
    { error: certificate, level: "error", name: "a hand-spelled coded certificate refusal", type: "certificate" }
  ];

  for(const { error, level, name, type } of READINGS) {

    test(name + " reads " + type + " at " + level, () => {

      assert.deepEqual(connectFailureReading(error), { level, type });
    });
  }

  // A level belongs to a type alone, because a caller's repeat-demoting log compares the type and a repeat of one could otherwise hide a change of level.
  test("no type reads at more than one level", () => {

    const levels = new Map<ConnectFailureType, Set<string>>();

    for(const { error } of READINGS) {

      const { level, type } = connectFailureReading(error);

      levels.set(type, (levels.get(type) ?? new Set<string>()).add(level));
    }

    assert.deepEqual([...levels].filter(([ , read ]) => read.size > 1), []);
  });
});

describe("the address override rule", () => {

  /* The option outranks the legacy per-controller property. An option that sets nothing - unset, turned off, or enabled with an empty value - leaves the answer to
   * the legacy property, so an emptied field never resolves the cameras against nothing, and with neither source configured there is no override at all.
   */
  test("the option outranks the legacy property, and an option that sets nothing leaves the answer to it", () => {

    assert.deepEqual(resolveOverrideAddress({ legacy: "legacy.example", option: "option.example" }), { address: "option.example", kind: "resolved" },
      "the option outranks the legacy property");

    for(const option of [ undefined, null, "" ]) {

      const label = "option " + JSON.stringify(option);

      assert.deepEqual(resolveOverrideAddress({ legacy: "legacy.example", option }), { address: "legacy.example", kind: "resolved" },
        label + ": the legacy property answers");
      assert.deepEqual(resolveOverrideAddress({ legacy: undefined, option }), { kind: "absent" }, label + ": with no legacy property there is no override");
    }
  });

  /* A plain IPv6 address resolves as it stands, bracketed only where a URL is composed from it. One carrying an IPv6 zone cannot stand in a URL, so it is refused,
   * naming the address, whichever source supplies it, and a refused option never falls through to the legacy property it outranks.
   */
  test("an address carrying an IPv6 zone is refused whichever source supplies it, and a plain IPv6 address resolves as it stands", () => {

    assert.deepEqual(resolveOverrideAddress({ legacy: undefined, option: "fd00::1" }), { address: "fd00::1", kind: "resolved" }, "a plain IPv6 address resolves");
    assert.deepEqual(resolveOverrideAddress({ legacy: "fe80::1%en0", option: null }), { address: "fe80::1%en0", kind: "refused" },
      "a zoned legacy property is refused");
    assert.deepEqual(resolveOverrideAddress({ legacy: "legacy.example", option: "fe80::1%en0" }), { address: "fe80::1%en0", kind: "refused" },
      "a zoned option is refused rather than falling through to the legacy property");
  });
});

describe("request-outcome classifier", () => {

  test("a 2xx response is a success", () => {

    assert.equal(isSuccessfulRequest({ statusCode: 200 }), true);
    assert.equal(isSuccessfulRequest({ statusCode: 299 }), true);
  });

  test("a non-2xx response is a failure", () => {

    assert.equal(isSuccessfulRequest({ statusCode: 401 }), false);
    assert.equal(isSuccessfulRequest({ statusCode: 500 }), false);
    assert.equal(isSuccessfulRequest({ statusCode: 199 }), false);
    assert.equal(isSuccessfulRequest({ statusCode: 300 }), false);
  });

  test("a transport-level error is a failure even absent a status", () => {

    assert.equal(isSuccessfulRequest({ error: "ECONNRESET" }), false);
    assert.equal(isSuccessfulRequest({ error: "timeout", statusCode: 200 }), false);
  });

  test("an absent status with no error is a failure", () => {

    assert.equal(isSuccessfulRequest({}), false);
  });
});

describe("NvrHealth connection-input mapping", () => {

  test("a run of request failures drives the controller degraded then stressed", () => {

    const clock = new TestClock(HEALTH_CLOCK_EPOCH);
    const health = new NvrHealth(clock);

    // Five weighted failures cross the degraded threshold; twelve cross stressed. The mapping under test is request-outcome -> apiError/apiSuccess symptom; the
    // thresholds and window are the unchanged reducer behavior this exercises end to end.
    for(let count = 0; count < 5; count++) {

      health.observe({ at: clock.now(), kind: "apiError" });
    }

    assert.equal(health.state, "degraded");

    for(let count = 0; count < 7; count++) {

      health.observe({ at: clock.now(), kind: "apiError" });
    }

    assert.equal(health.state, "stressed");
  });

  test("request successes count as recovery evidence against failures", () => {

    const clock = new TestClock(HEALTH_CLOCK_EPOCH);
    const health = new NvrHealth(clock);

    // Drive to degraded, then feed successes: the weighted count falls below the release bound and the controller returns to healthy. This pins that a 2xx maps to
    // apiSuccess (recovery), the counterpart of the failure mapping.
    for(let count = 0; count < 6; count++) {

      health.observe({ at: clock.now(), kind: "apiError" });
    }

    assert.equal(health.state, "degraded");

    for(let count = 0; count < 6; count++) {

      health.observe({ at: clock.now(), kind: "apiSuccess" });
    }

    assert.equal(health.state, "healthy");
  });

  test("a library throttle latches stressed, and release alone does not auto-recover", () => {

    const clock = new TestClock(HEALTH_CLOCK_EPOCH);
    const health = new NvrHealth(clock);

    // throttleEntered maps to the libraryThrottleEntered symptom, which short-circuits to stressed regardless of the symptom count.
    health.observe({ at: clock.now(), kind: "libraryThrottleEntered" });
    assert.equal(health.state, "stressed");

    // throttleExited releases the latch but, by NvrHealth's documented contract, does NOT itself reset the state - recovery waits for organic improvement (success
    // events accumulating in the window), not the mere release. So after release the state steps down one level to degraded, not all the way to healthy.
    health.observe({ at: clock.now(), kind: "libraryThrottleReleased" });
    assert.equal(health.state, "degraded");

    // Organic recovery: a run of successes drives the weighted count below the release bound and returns the controller to healthy. This is the throttle-released-then-
    // recovered path the connection rails feed end to end.
    for(let count = 0; count < 4; count++) {

      health.observe({ at: clock.now(), kind: "apiSuccess" });
    }

    assert.equal(health.state, "healthy");
  });
});

describe("removal stability arithmetic", () => {

  // The stability window the production gate uses, restated here as a plain literal so these clock-free cases read independently of the settings constant.
  const windowMs = 600000;
  const nowMs = 1000000;

  test("a long-up controller at first good-state is trusted immediately", () => {

    // First good-state entry (hasStabilizedBefore false) with an uptime well past the window: the backdate clamps to exactly one window, so the window has already
    // elapsed at now and a removal is permitted right away.
    const stableSinceMs = computeStableSince({ hasStabilizedBefore: false, nowMs, uptimeMs: windowMs + 500000, windowMs });

    assert.equal(stableSinceMs, nowMs - windowMs);
    assert.equal(isStabilityWindowElapsed({ nowMs, stableSinceMs, windowMs }), true);
  });

  test("a short-up controller at first good-state must still wait out the remainder", () => {

    // First good-state entry with an uptime shorter than the window: the backdate counts from boot, so the gate stays closed now and opens only once the full window has
    // elapsed since boot (now + the uncovered remainder).
    const uptimeMs = 180000;
    const stableSinceMs = computeStableSince({ hasStabilizedBefore: false, nowMs, uptimeMs, windowMs });

    assert.equal(stableSinceMs, nowMs - uptimeMs);
    assert.equal(isStabilityWindowElapsed({ nowMs, stableSinceMs, windowMs }), false);
    assert.equal(isStabilityWindowElapsed({ nowMs: stableSinceMs + windowMs, stableSinceMs, windowMs }), true);
  });

  test("a recovery counts from now and ignores uptime", () => {

    // A later good-state entry (hasStabilizedBefore true) always counts from now regardless of how long the controller process has been up - a disruption we observed
    // resets our trust - so even a huge uptime leaves the gate closed until a fresh full window elapses.
    const stableSinceMs = computeStableSince({ hasStabilizedBefore: true, nowMs, uptimeMs: windowMs * 10, windowMs });

    assert.equal(stableSinceMs, nowMs);
    assert.equal(isStabilityWindowElapsed({ nowMs, stableSinceMs, windowMs }), false);
  });

  test("the window is elapsed at exactly the boundary", () => {

    // The gate is a >= comparison, so the instant the elapsed time equals the window the controller is stable; one millisecond before it is not.
    assert.equal(isStabilityWindowElapsed({ nowMs, stableSinceMs: nowMs - windowMs, windowMs }), true);
    assert.equal(isStabilityWindowElapsed({ nowMs, stableSinceMs: nowMs - windowMs + 1, windowMs }), false);
  });

  test("a null stable-since is never elapsed", () => {

    // Null means the controller is not currently good (mid-disruption), so the gate is closed no matter the window.
    assert.equal(isStabilityWindowElapsed({ nowMs, stableSinceMs: null, windowMs }), false);
  });
});

describe("livestream disruption gating", () => {

  // The induced predicate the livestream-subsystem sites share. We pin every phase so a wrong set is caught - including a `!== "running"` flip that would fold
  // `connecting` into the induced set and silence a startup/reconnection disruption the operator should see.
  test("isInducedDisruption is true only for the induced phases", () => {

    assert.equal(isInducedDisruption("running"), false);
    assert.equal(isInducedDisruption("connecting"), false);
    assert.equal(isInducedDisruption("rebooting"), true);
    assert.equal(isInducedDisruption("shuttingDown"), true);
  });

  // The recency half of the per-camera quiet gate - the second predicate the interruption edge ORs together. A blip inside the window of an observed reboot is that
  // reboot's tail (quiet); at or past the window, or with no reboot observed this process, it is a genuine drop (loud). The comparison is strict-less-than, so the
  // window boundary is pinned on BOTH sides. The null case pairs with a SMALL nowMs so a mutant dropping the `!== null` guard would compute 0 - null === 0 < window and
  // flip the case to true - the guard genuinely matters here rather than being masked by a large nowMs.
  test("isWithinRebootRecency is true only within the window of an observed reboot", () => {

    const windowMs = 60000;
    const lastRebootMs = 1000;

    // Observed well within the window: quiet.
    assert.equal(isWithinRebootRecency({ lastRebootMs, nowMs: lastRebootMs + 1, windowMs }), true);

    // The window boundary, both sides: one millisecond short is still within (<), exactly the window is out (the comparison is strict-less-than).
    assert.equal(isWithinRebootRecency({ lastRebootMs, nowMs: lastRebootMs + windowMs - 1, windowMs }), true);
    assert.equal(isWithinRebootRecency({ lastRebootMs, nowMs: lastRebootMs + windowMs, windowMs }), false);

    // Comfortably past the window: loud.
    assert.equal(isWithinRebootRecency({ lastRebootMs, nowMs: lastRebootMs + windowMs + 5000, windowMs }), false);

    // No reboot observed this process. The small nowMs means removing the null guard would compute 0 - null < window and wrongly read as within-window.
    assert.equal(isWithinRebootRecency({ lastRebootMs: null, nowMs: 0, windowMs }), false);
  });

  // The composed classification every disruption-facing narration consults. The cells cover each way an answer can arise: the induced half standing alone (no reboot has
  // ever been observed, so only the phase can answer yes), the settling-tail half standing alone (a controller already back to running), and the two ways the answer is
  // no - the window elapsed, and no reboot observed at all. A mutant dropping either half fails a cell.
  test("isDisruptionExpected is true for an induced phase or an observed reboot's settling tail", () => {

    const windowMs = 60000;
    const lastRebootMs = 1000;

    // The induced half alone: no reboot observed this process, so the phase is the only thing that can classify this as expected.
    assert.equal(isDisruptionExpected({ lastRebootMs: null, nowMs: 0, phase: "rebooting", windowMs }), true);

    // The settling-tail half alone: the plugin has concluded the reboot and returned to running, and the blip lands inside the observed reboot's window.
    assert.equal(isDisruptionExpected({ lastRebootMs, nowMs: lastRebootMs + 1, phase: "running", windowMs }), true);

    // A running controller with the window elapsed - a genuine single-camera drop, and the reason the tail half is a window rather than a permanent quieting.
    assert.equal(isDisruptionExpected({ lastRebootMs, nowMs: lastRebootMs + windowMs, phase: "running", windowMs }), false);

    // A running controller with no reboot observed this process: nothing makes this disruption expected.
    assert.equal(isDisruptionExpected({ lastRebootMs: null, nowMs: 0, phase: "running", windowMs }), false);
  });

  // The core latch protocol: the recovery edge reads the quiet/loud classification the interruption edge recorded, and the read drains the slot so a re-used key cannot
  // leak a prior episode's classification into a later one.
  test("the latch returns the recorded classification and drains on consume", () => {

    const latch = createLivestreamEpisodeLatch();

    latch.record("key1", "camA", true);
    assert.equal(latch.consume("key1"), true);

    // The first consume drained the slot, so a second consume of the same key sees no entry and defaults to the loud, genuine-drop level.
    assert.equal(latch.consume("key1"), false);
  });

  // An unrecorded key (a recovery with no matching interruption, e.g. a foreign controller's key our guard never recorded) defaults to the loud level, and an explicitly
  // loud classification round-trips as loud too.
  test("the latch defaults an unrecorded key to loud", () => {

    const latch = createLivestreamEpisodeLatch();

    assert.equal(latch.consume("absent"), false);

    latch.record("key1", "camA", false);
    assert.equal(latch.consume("key1"), false);
  });

  // A single camera can run concurrent livestream sessions under distinct pool keys (e.g. an HKSV record channel and a Home-app live view on another lens). Per-key
  // keying gives each session its own slot, so the second-and-later recoveries during a reboot read their own classification rather than aliasing onto a shared cameraId
  // slot.
  test("the latch isolates concurrent sessions of one camera by key", () => {

    const latch = createLivestreamEpisodeLatch();

    latch.record("camA:0", "camA", true);
    latch.record("camA:1", "camA", false);

    assert.equal(latch.consume("camA:0"), true);
    assert.equal(latch.consume("camA:1"), false);
  });

  // forgetCamera reclaims every entry for the named camera (the removal-chokepoint cleanup that prevents a started-but-never-recovered episode from leaking) and leaves
  // other cameras' entries untouched.
  test("forgetCamera reclaims only the named camera's entries", () => {

    const latch = createLivestreamEpisodeLatch();

    latch.record("camA:0", "camA", true);
    latch.record("camB:0", "camB", true);

    latch.forgetCamera("camA");

    assert.equal(latch.consume("camA:0"), false);
    assert.equal(latch.consume("camB:0"), true);
  });

  // A re-used key records over the prior slot, so a recovery reads the current episode's classification, never a stale one from a prior episode sharing the same key.
  test("recording a key overwrites a stale classification for that key", () => {

    const latch = createLivestreamEpisodeLatch();

    latch.record("camA:0", "camA", true);
    latch.record("camA:0", "camA", false);

    assert.equal(latch.consume("camA:0"), false);
  });
});

describe("induced-reboot resume decision", () => {

  // The recovery-edge predicate that concludes an induced reboot. The true case is a recovery edge while rebooting - the connection arriving at healthy from a
  // non-healthy state. Each false case deviates from that true case in exactly ONE conjunct, so a mutation that drops any conjunct fails at least one assertion: the
  // entry-healthy guard (from: "healthy"), the destination check (to: "degraded"), and the induced-phase gate across the other phases (running / connecting /
  // shuttingDown), including connecting so a startup edge never resumes.
  test("shouldResumeFromInducedReboot is true only on a recovery edge while rebooting", () => {

    // A genuine drop-and-recovery while we induced the reboot: resume.
    assert.equal(shouldResumeFromInducedReboot({ from: "reconnecting", phase: "rebooting", to: "healthy" }), true);

    // Single-conjunct deviations from the true case, each false.
    assert.equal(shouldResumeFromInducedReboot({ from: "healthy", phase: "rebooting", to: "healthy" }), false);
    assert.equal(shouldResumeFromInducedReboot({ from: "reconnecting", phase: "rebooting", to: "degraded" }), false);
    assert.equal(shouldResumeFromInducedReboot({ from: "reconnecting", phase: "running", to: "healthy" }), false);
    assert.equal(shouldResumeFromInducedReboot({ from: "reconnecting", phase: "connecting", to: "healthy" }), false);
    assert.equal(shouldResumeFromInducedReboot({ from: "reconnecting", phase: "shuttingDown", to: "healthy" }), false);
  });
});

describe("phase transition legality", () => {

  // canTransition owns every refusal the NVR's transition chokepoint honors: a same-phase change (a no-op), and any change out of the terminal
  // "shuttingDown". The same-phase rows and the shuttingDown-exit rows are false; every ordinary lifecycle change is legal, and entering "shuttingDown" from any
  // phase is legal. The shuttingDown-exit rows are precisely what a same-phase-only guard - the rule before the terminal one-way clause - would wrongly permit.
  test("canTransition refuses same-phase changes and any exit from shuttingDown", () => {

    const phases: NvrPhase[] = [ "connecting", "rebooting", "running", "shuttingDown" ];

    // A same-phase change is always a no-op, for every phase.
    for(const phase of phases) {

      assert.equal(canTransition({ from: phase, to: phase }), false);
    }

    // Leaving the terminal shutdown phase is refused for every destination.
    assert.equal(canTransition({ from: "shuttingDown", to: "connecting" }), false);
    assert.equal(canTransition({ from: "shuttingDown", to: "rebooting" }), false);
    assert.equal(canTransition({ from: "shuttingDown", to: "running" }), false);

    // The ordinary lifecycle changes are legal.
    assert.equal(canTransition({ from: "running", to: "rebooting" }), true);
    assert.equal(canTransition({ from: "rebooting", to: "running" }), true);
    assert.equal(canTransition({ from: "connecting", to: "running" }), true);

    // Entering shuttingDown from any other phase is always legal - the terminal phase is a one-way door that anyone may walk through.
    assert.equal(canTransition({ from: "connecting", to: "shuttingDown" }), true);
    assert.equal(canTransition({ from: "rebooting", to: "shuttingDown" }), true);
    assert.equal(canTransition({ from: "running", to: "shuttingDown" }), true);
  });
});

describe("controller request-host filter", () => {

  // The process-global HTTP diagnostics channel carries every client's requests, so each NVR keeps only its own by an EXACT string match of the payload's reported host
  // against its configured address - both descend from the one address this NVR passed to ProtectClient.connect(). The cross-contamination row is the one a substring
  // test gets wrong: "192.168.1.2" is a substring of "192.168.1.20", so a .includes() filter let a controller observe a neighbor's requests. The remaining rows pin the
  // exact-identity contract: a hostname prefix does not match, a mixed-case address matches only itself verbatim, a bare IPv6 literal does not match a bracketed form, a
  // ported address attributes as-is, and any non-URL host string attributes only when the configured address is that same string.
  test("isRequestForController matches only the exact configured host", () => {

    // The controller's own request counts.
    assert.equal(isRequestForController({ address: "192.168.1.2", host: "192.168.1.2" }), true);

    // The cross-contamination case: a neighbor whose host merely contains ours must not match.
    assert.equal(isRequestForController({ address: "192.168.1.2", host: "192.168.1.20" }), false);

    // A configured address that is a prefix of the reported host does not match - equality, not containment.
    assert.equal(isRequestForController({ address: "controller", host: "controller.example.com" }), false);

    // A mixed-case address matches its own verbatim host, and does NOT match a lowercased variant (a different controller's string) - exact identity, no case folding.
    assert.equal(isRequestForController({ address: "Controller.Local", host: "Controller.Local" }), true);
    assert.equal(isRequestForController({ address: "Controller.Local", host: "controller.local" }), false);

    // A bare IPv6 literal matches a bare literal and NOT a bracketed form - the payload carries the exact configured address, so no bracket normalization applies.
    assert.equal(isRequestForController({ address: "fe80::1", host: "fe80::1" }), true);
    assert.equal(isRequestForController({ address: "fe80::1", host: "[fe80::1]" }), false);

    // Exact identity keeps the port significant: a bare-host request does NOT match a ported configured address.
    assert.equal(isRequestForController({ address: "192.168.1.2:7443", host: "192.168.1.2" }), false);

    // A non-URL host string attributes only when the configured address is that same string.
    assert.equal(isRequestForController({ address: "notaurl", host: "notaurl" }), true);
    assert.equal(isRequestForController({ address: "192.168.1.2", host: "notaurl" }), false);

    // A ported address attributes to itself - the port is part of the exact identity.
    assert.equal(isRequestForController({ address: "1.2.3.4:8443", host: "1.2.3.4:8443" }), true);

    // Two controllers on one host at different ports stay distinct - the port is part of the exact identity.
    assert.equal(isRequestForController({ address: "1.2.3.4:8443", host: "1.2.3.4:9443" }), false);
  });
});

describe("scheduled-reboot arithmetic", () => {

  // The three-way decision a reboot attempt acts on. The ceiling comparison is strict-less-than, so the boundary is pinned on both sides: one millisecond short still
  // defers, exactly at the ceiling forces. The zero-recordings rows carry an elapsed time well past the ceiling, so a mutant that consulted the ceiling before the
  // recording count would answer "force" there and fail rather than passing by coincidence.
  test("classifyRebootAttempt defers only while recordings are active and the ceiling has headroom left", () => {

    const ceilingMs = 900000;

    // Nothing is recording, so the attempt proceeds however long the cycle has been running.
    assert.equal(classifyRebootAttempt({ activeRecordings: 0, ceilingMs, elapsedCycleMs: 0 }), "proceed");
    assert.equal(classifyRebootAttempt({ activeRecordings: 0, ceilingMs, elapsedCycleMs: ceilingMs + 60000 }), "proceed");

    // Recordings in flight with ceiling headroom left: hold the reboot back.
    assert.equal(classifyRebootAttempt({ activeRecordings: 1, ceilingMs, elapsedCycleMs: 0 }), "defer");
    assert.equal(classifyRebootAttempt({ activeRecordings: 3, ceilingMs, elapsedCycleMs: ceilingMs - 1 }), "defer");

    // At the ceiling and past it, an active recording does not earn a deferral.
    assert.equal(classifyRebootAttempt({ activeRecordings: 1, ceilingMs, elapsedCycleMs: ceilingMs }), "force");
    assert.equal(classifyRebootAttempt({ activeRecordings: 1, ceilingMs, elapsedCycleMs: ceilingMs + 60000 }), "force");
  });

  // The first fire's delay, anchored to the controller's own uptime so restarting the plugin does not reset the cadence. The zero-upSince row is the one a plain
  // subtraction gets wrong: it would treat the epoch as a boot time and compute a delay tens of thousands of hours in the past, flooring every fresh install at a
  // minute rather than the configured interval.
  test("computeInitialRebootDelay anchors the first fire to the controller's uptime", () => {

    const intervalMs = 6 * 60 * 60 * 1000;
    const nowMs = 1700000000000;

    // A controller that has only just booted waits the whole interval.
    assert.equal(computeInitialRebootDelay({ intervalMs, nowMs, upSince: nowMs }), intervalMs);

    // No boot time reported reads as no backdate at all, so the wait is the full interval.
    assert.equal(computeInitialRebootDelay({ intervalMs, nowMs, upSince: 0 }), intervalMs);

    // Uptime consumes the interval, and what remains of it is the wait.
    assert.equal(computeInitialRebootDelay({ intervalMs, nowMs, upSince: nowMs - (2 * 60 * 60 * 1000) }), 4 * 60 * 60 * 1000);

    // A controller up longer than the interval does not reboot the instant we connect - the floor leaves it a minute to settle first.
    assert.equal(computeInitialRebootDelay({ intervalMs, nowMs, upSince: nowMs - (2 * intervalMs) }), 60000);
  });

  // The span sums the library's own numbers, and the anticipation window is the margin that keeps a typical reboot's recovery from drawing a warning seconds before it
  // completes, which is why it reads as part of the sum rather than beside it. It also has to end before the shortest cycle can begin, or a next attempt would find it
  // armed.
  test("the expected return is the library's known-reboot schedule, one steady probe and its anticipation window, and ends before the shortest cycle", () => {

    assert.equal(REBOOT_EXPECTED_RETURN_MS, PROTECT_RECOVERY_BACKOFF_KNOWN_MS.reduce((total, wait) => total + wait, 0) + PROTECT_RECOVERY_STEADY_INTERVAL_MS +
      PROTECT_REBOOT_ANTICIPATION_WINDOW_MS);
    assert.ok(REBOOT_EXPECTED_RETURN_MS < (PROTECT_NVR_REBOOT_MIN_INTERVAL * 60 * 60 * 1000));
  });
});

describe("the active-recording count", () => {

  // The counting rule the scheduled-reboot deferral rests on, shared by every caller that has its own population to walk. The mixed row carries both shapes of absence
  // the real callers present - a camera that never acquired a streaming arm, and a view whose object carries no streaming member at all - so a rule that dropped
  // either optional hop would throw here rather than answer false.
  test("countActiveRecordingViews counts the transmitting views and nothing else", () => {

    assert.equal(countActiveRecordingViews([]), 0);

    assert.equal(countActiveRecordingViews([ { streaming: { isRecordingTransmitting: true } }, { streaming: { isRecordingTransmitting: false } }, { streaming: null },
      {} ]), 1);

    assert.equal(countActiveRecordingViews([ { streaming: { isRecordingTransmitting: true } }, { streaming: { isRecordingTransmitting: true } } ]), 2);
  });
});

describe("the controller root's disabled-controller path", () => {

  /* A controller the user disabled in HomeKit at its own scope connects, removes every accessory it owns, and then lets go of its console session. The client double
   * records its dispose and whether this controller's accessories were already gone when it ran, so the order is part of the assertion: a dispose ahead of the sweep
   * would leave the sweep reading a disposed client. What a live client would go on delivering to a root still wired to it - the library entering its throttle, which
   * the health bridge narrates at warn, and the controller dropping off and coming back - is then delivered through the connection, and nothing may be logged.
   */
  test("a controller disabled in HomeKit disconnects from the Protect controller after removing its accessories", async () => {

    const nvrConfig: ProtectNvrConfig = { ...makeNvrConfig(), firmwareVersion: "4.3.6", version: "6.1.79" };
    const store = new TestStateStore(makeProtectState({ nvr: nvrConfig }));
    const { controller, logEntries, nvr: double } = makeTestNvr({ store, userOptions: ["Disable.Device." + nvrConfig.mac] });
    const connection = new TestConnection();
    const disposals: boolean[] = [];

    // A cached camera and a cached liveview switch this controller owns, one for each of the disabled path's removal loops.
    const camera = makeTestAccessory("Test Camera", "74ACB9000001");
    const liveview = makeTestAccessory("Test Liveview", nvrConfig.mac + ".Liveview.TEST");

    camera.context = { mac: "74ACB9000001", nvr: nvrConfig.mac };
    liveview.context = { liveview: "Test", nvr: nvrConfig.mac };
    restoreAccessories(double, [ camera, liveview ]);

    const client = {

      [Symbol.asyncDispose]: async (): Promise<void> => {

        disposals.push(!double.platform.accessories.some((accessory) => accessory.context.nvr === nvrConfig.mac));
      },
      connection: connection,
      controllerName: "Test Controller",
      nvr: { config: nvrConfig },
      state: store
    };

    const { platform, shutdown } = makeRootPlatform(double);
    const root = new ProtectNvr(platform, double.config, async (): Promise<ProtectClient> => client as unknown as ProtectClient);

    try {

      await root.login();

      assert.ok(loggedAt(logEntries, "info", "Disabling this UniFi Protect controller in HomeKit."), "the controller took its disabled path");
      assert.deepEqual(disposals, [true], "the client was disposed once, after every accessory this controller owns was removed");
      assert.equal(connection.listenerCount, 0, "no connection subscription outlives the client");

      const settled = logEntries.length;

      connection.emit("throttleEntered");
      connection.emit("controllerLost");
      connection.emit("controllerRebooted");

      await settle();

      assert.deepEqual(logEntries.slice(settled).map(formatLogEntry), [], "nothing is logged after the sweep");
    } finally {

      shutdown();
      controller.abort();

      await settle();
    }
  });
});

describe("the controller root's stability sweep", () => {

  /* A controller that boots as the plugin starts is unsettled at login, so the removal gate refuses what the startup liveviews reconcile asks for: the removal of a
   * security system accessory Homebridge restored from its cache after its liveviews were deleted while the plugin was down. Nothing else asks again, because the
   * liveviews only change when the user edits them. The root's stability sweep runs once the stability window has passed, and its liveviews pass schedules the
   * removal, which lands when the removal delay ends. The clock stops a millisecond short of the window first, so a removal scheduled before the sweep reddens the row.
   */
  test("a security system left by liveviews deleted while the plugin was down is removed by the stability sweep's liveviews pass", async () => {

    const clock = new TestClock(TEST_CLOCK_EPOCH);
    const nvrConfig: ProtectNvrConfig = { ...makeNvrConfig(), firmwareVersion: "4.3.6", upSince: clock.now(), version: "6.1.79" };
    const store = new TestStateStore(makeProtectState({ nvr: nvrConfig }));
    const { api, controller, logEntries, nvr: double } = makeTestNvr({ clock, store });
    const ghost = makeTestAccessory("Security System", nvrConfig.mac + ".Security");

    ghost.context = { liveviewDerived: true, nvr: nvrConfig.mac };
    restoreAccessories(double, [ghost]);

    // The client a connected controller reads, whose store holds no liveview at all.
    const client = makeConnectedClient({ nvrConfig, store });
    const { platform, shutdown } = makeRootPlatform(double);
    const root = new ProtectNvr(platform, double.config, async (): Promise<ProtectClient> => client);
    const removalReason = "No plugin-specific liveviews found. Disabling the security system accessory associated with this UniFi Protect controller.";

    try {

      await root.login();
      await settle();

      assert.ok(loggedAt(logEntries, "info", "Connected to nvr.test (UniFi Protect 6.1.79 running on UniFi OS 4.3.6)."),
        "the controller connected and took its enabled path");

      clock.advance(PROTECT_NVR_REMOVAL_STABILITY_WINDOW - 1);

      assert.ok(double.platform.accessories.includes(ghost), "the security system stays while the controller settles");
      assert.equal(loggedAt(logEntries, "info", removalReason), false, "and the startup reconcile's removal was refused");

      clock.advance(1);

      assert.ok(loggedAt(logEntries, "info", removalReason), "the stability sweep's liveviews pass scheduled the removal");
      assert.ok(double.platform.accessories.includes(ghost), "the security system stays through the removal delay");

      clock.advance(PROTECT_DEVICE_REMOVAL_DELAY_INTERVAL * 1000);

      assert.equal(double.platform.accessories.includes(ghost), false, "the security system left when the removal delay ended");
      assert.ok(api.calls.some((call) => (call.kind === "unregister") && call.accessories.includes(ghost)), "and it was unregistered from HomeKit");

      shutdown();

      await settle();

      assert.equal(store.observerCount, 0, "every observe loop the root started ended with its shutdown");
    } finally {

      shutdown();
      controller.abort();

      await settle();
    }
  });
});

/* The line a controller whose address can never work logs once its connect retry stops, transcribed rather than referenced so a wording that drifts by a character
 * in its one home reddens a row.
 *
 * @param prefix - The controller's log prefix.
 * @param reason - The library's refusal, as the line carries it.
 *
 * @returns The line as the logger renders it.
 */
function addressRefused(prefix: string, reason: string): string {

  return prefix + ": Unable to connect to the Protect controller, and will not keep trying until its address is corrected in the plugin settings: " + reason;
}

describe("the controller root's connect retry", () => {

  /* A controller that refuses the configured sign-in at startup is retried for as long as the plugin runs, on the library's refusal schedule, and the user is told
   * why once rather than on every attempt. The connect port refuses every attempt and records the platform clock's time at each, so the spacing is read from the
   * attempts themselves, and the clock stops a millisecond short of each wait first, so a retry that came early reddens the row. The run is walked through every
   * staged delay and onto the schedule's floor, which a policy that stopped retrying after a few refusals would never reach. The attempt after the last wait is
   * still in flight when the plugin shuts down, and fails with the abort it is handed, as a sign-in torn down mid-request does. Shutdown is the only end of the run,
   * and an orderly one: the login returns and the aborted attempt is not reported.
   */
  test("a refused sign-in is reported once at error and retried on the library's refusal schedule until shutdown ends the run", async () => {

    const { clock, controller, logEntries, nvr: double } = makeTestNvr({ store: new TestStateStore(makeProtectState({ nvr: makeNvrConfig() })) });
    const { backoff, steady } = PROTECT_RECOVERY_REFUSAL_SCHEDULE_MS;
    // Every staged delay, then more than one wait at the floor, so the run is seen settling onto the floor and carrying on there rather than stopping.
    const waits = [ ...backoff, steady, steady ];
    const attempts: number[] = [];
    const { platform, shutdown } = makeRootPlatform(double);
    const root = new ProtectNvr(platform, double.config, async ({ signal }): Promise<ProtectClient> => {

      attempts.push(clock.now());

      if((attempts.length > waits.length) && signal) {

        await once(signal, "abort");

        signal.throwIfAborted();
      }

      throw refusalError;
    });

    try {

      const login = root.login();

      await settleUntil(() => attempts.length === 1, { description: "the first sign-in attempt" });

      for(const [ index, wait ] of waits.entries()) {

        clock.advance(wait - 1);

        // eslint-disable-next-line no-await-in-loop -- Each step reads the attempts the previous one let run, so the steps are serial by intent.
        await settle();

        assert.equal(attempts.length, index + 1, "no attempt runs before its wait on the refusal schedule has passed since the last refusal");

        clock.advance(1);

        // eslint-disable-next-line no-await-in-loop -- Each step reads the attempts the previous one let run, so the steps are serial by intent.
        await settleUntil(() => attempts.length === (index + 2), { description: "sign-in attempt " + (index + 2).toString() });
      }

      assert.deepEqual(attempts.slice(1).map((at, index) => at - (attempts[index] ?? 0)), waits,
        "each attempt after a refusal runs one wait of the refusal schedule after the one before it");
      assert.equal(logCount(logEntries, "error", "Unable to connect to the Protect controller, and will keep trying: bad credentials."), 1,
        "the refusal is reported once at error, and its repeats are not");

      const reported = logEntries.length;

      shutdown();

      await login;

      assert.equal(attempts.length, waits.length + 1, "shutdown ends the run without another attempt");
      assert.deepEqual(logEntries.slice(reported).filter((entry) => entry.level === "error").map(formatLogEntry), [],
        "and the attempt the shutdown aborted is not reported, so the run ends with nothing at error");
    } finally {

      shutdown();
      controller.abort();

      await settle();
    }
  });

  /* A controller whose configured address no URL can carry is refused by the library before anything is sent, and the same way on every attempt, so the run ends
   * on its first attempt with one line saying the address needs correcting and no retrying line ahead of it. The connect port refuses as the library does, worded
   * as unifi-protect words it. Nothing shuts the plugin down until the run has ended on its own, so the login returning is the retry stopping, and the controller
   * is left in its first phase with no client. The shutdown it still takes afterward has no client to dispose, and completes without a word or a stray rejection.
   */
  test("a login whose connect is refused as an address no URL can carry stops after its first attempt, waits for nothing, and says so once", async () => {

    const { clock, controller, logEntries, nvr: double } = makeTestNvr({ store: new TestStateStore(makeProtectState({ nvr: makeNvrConfig() })) });
    const refusal = "The controller address \"nvr.local/path\" carries more than a host and a port.";
    const { platform, shutdown } = makeRootPlatform(double);
    // The controller double's own removal gate arms a timer on the clock as the double is built, so what the root asks of the clock is read from here on.
    const armed = clock.requested.length;
    const pending = clock.pending;

    let attempts = 0;

    const root = new ProtectNvr(platform, { ...double.config, address: "nvr.local/path" }, async (): Promise<ProtectClient> => {

      attempts++;

      throw new ProtectConfigurationError(refusal);
    });

    try {

      // The login is started rather than awaited, so a retry that waited behind the refusal reddens the row here rather than leaving it hanging on that wait.
      let returned = false;

      const login = root.login().then((): void => {

        returned = true;
      });

      await settleUntil(() => returned, { description: "the login returning on its own, before any shutdown" });
      await login;

      assert.equal(attempts, 1, "the address is refused on the first attempt and never asked about again");
      assert.deepEqual(clock.requested.slice(armed), [], "so no wait is armed behind the refusal");
      assert.equal(clock.pending, pending, "and nothing more is left to come due");
      assert.deepEqual(linesAt(logEntries, "error"), [addressRefused("nvr.local/path", refusal)],
        "the refusal is said once, in the line that says the retry stopped, with no retrying line ahead of it");
      assert.equal(root.phase, "connecting", "the controller never connected, so it stays in its first phase");

      await assertNoUnhandledRejections(async (): Promise<void> => {

        shutdown();

        await settle();
      });

      assert.equal(root.phase, "shuttingDown", "the shutdown a controller that never connected still takes completes");
      assert.deepEqual(linesAt(logEntries, "error"), [addressRefused("nvr.local/path", refusal)], "and adds no line of its own");
    } finally {

      shutdown();
      controller.abort();

      await settle();
    }
  });

  /* A controller whose address carries credentials never connects, so every line it writes is prefixed with the name it takes from that address. The connect is the
   * real one, which refuses such an address before it sends anything, so the line saying the retry stopped carries the address wherever it names it: the prefix the
   * root takes from it, and the library's own refusal quoted after that prefix. Every level is captured, debug included, through the shutdown that ends the run: the
   * gate is turned on and a debug line arrives on the warn channel, so a line of any level that named the address raw would land here.
   */
  test("a controller that never connects prefixes its lines with its address as unifi-protect masks it, so the credentials reach no line", async () => {

    const { controller, logEntries, nvr: double } = makeTestNvr({ store: new TestStateStore(makeProtectState({ nvr: makeNvrConfig() })),
      userOptions: ["Enable.Log.Debug"] });
    const { platform, shutdown } = makeRootPlatform(double);
    const root = new ProtectNvr(platform, { ...double.config, address: "user:secret@10.0.0.1" });

    try {

      // The login is started rather than awaited, so a retry that waited behind the refusal reddens the row here rather than leaving it hanging on that wait.
      let returned = false;

      const login = root.login().then((): void => {

        returned = true;
      });

      await settleUntil(() => returned, { description: "the login returning on its own, before any shutdown" });
      await login;

      shutdown();

      await settle();

      assert.deepEqual(linesAt(logEntries, "error"), [addressRefused("***@10.0.0.1", "The controller address \"***@10.0.0.1\" carries more than a host and a port.")],
        "the prefix names the address masked through its last @, as the library's message does");
      assert.deepEqual(logEntries.map(formatLogEntry).filter((line) => line.includes("secret")), [], "and the password reaches no line at any level");
    } finally {

      shutdown();
      controller.abort();

      await settle();
    }
  });

  /* The same refusal arriving from an attempt the plugin's shutdown has already aborted. The policy vetoes it as it vetoes any refused address, so the retry
   * rejects at once, and the connect reads the shutdown before it says anything: a refused address meeting a shutdown in progress is as quiet as every other
   * attempt a shutdown ends, and the login returns with nothing at error.
   */
  test("a configuration error landing after shutdown began says nothing", async () => {

    const { controller, logEntries, nvr: double } = makeTestNvr({ store: new TestStateStore(makeProtectState({ nvr: makeNvrConfig() })) });
    const { platform, shutdown } = makeRootPlatform(double);

    let attempts = 0;

    const root = new ProtectNvr(platform, { ...double.config, address: "nvr.local/path" }, async ({ signal }): Promise<ProtectClient> => {

      attempts++;

      if(signal) {

        await once(signal, "abort");
      }

      throw new ProtectConfigurationError("The controller address \"nvr.local/path\" carries more than a host and a port.");
    });

    try {

      const login = root.login();

      await settleUntil(() => attempts === 1, { description: "the first connect attempt" });

      shutdown();

      await login;

      assert.equal(attempts, 1, "the attempt the shutdown met is the only one");
      assert.deepEqual(linesAt(logEntries, "error"), [], "and the refusal it ended on is not said, because the plugin was already shutting down");
    } finally {

      shutdown();
      controller.abort();

      await settle();
    }
  });
});

describe("the controller root's report of a startup failure by its kind", () => {

  // The line a startup rate limit is said with, and the line every other startup failure is said with, each transcribed so a wording that drifts reddens a row, and the
  // prefix the controller's log carries them under until it connects.
  const RATE_LIMITED_LINE = "Unable to connect to the Protect controller because it is rate limiting requests, and will keep trying on the slower refusal schedule.";
  const failedLine = (reason: string): string => "Unable to connect to the Protect controller, and will keep trying: " + reason + ".";
  const PREFIX = "nvr.test: ";

  // The reasons of the failures these rows read, each transcribed as the root's line carries it.
  const NETWORK_FAULT = "A network error occurred communicating with the UniFi Protect controller: ";
  const PRIVILEGE_REASON = "Unable to fetch the UniFi Protect controller bootstrap: The account lacks the privileges this operation requires on the UniFi Protect " +
    "controller";
  const STATUS_503 = "The UniFi Protect controller answered the request with HTTP status 503";

  /* Log the real root in against a connect port that fails one attempt for each of the given failures, in turn, then shut the plugin down while the attempt after the
   * last of them waits on its signal, as a sign-in torn down mid-request does, and answer the lines the run logged. Each failure's wait is read from what the retry asked
   * the platform's clock for and stepped once it has asked, so the run walks the schedule the policy chose on virtual time whichever classes of fault it moves between.
   *
   * The attempt the shutdown ends fails as unifi-protect fails one, which reads as a timeout. Every row therefore also holds the shutdown guard: whatever came before,
   * the attempt the shutdown ended is either a new type or a repeat of one, and neither writes a line.
   */
  async function loginFailing(failures: readonly Error[], { userOptions = [] }: { userOptions?: string[] } = {}): Promise<readonly TestLogEntry[]> {

    const { clock, controller, logEntries, nvr: double } = makeTestNvr({ store: new TestStateStore(makeProtectState({ nvr: makeNvrConfig() })), userOptions });
    const { platform, shutdown } = makeRootPlatform(double);

    let attempts = 0;

    const root = new ProtectNvr(platform, double.config, async ({ signal }): Promise<ProtectClient> => {

      const failure = failures[attempts++];

      if(failure) {

        throw failure;
      }

      assert.ok(signal, "the root runs each attempt under its retry's signal");

      await once(signal, "abort");

      throw new ProtectAbortedError("The request was aborted by the caller's signal.", { cause: signal.reason });
    });

    // The controller double's own removal gate arms a timer on the clock as the double is built, so the waits the retry asks for are read from here on.
    let waits = clock.requested.length;

    try {

      const login = root.login();

      for(const [index] of failures.entries()) {

        // eslint-disable-next-line no-await-in-loop -- Each step reads the wait the failure before it asked for, so the steps are serial by intent.
        await settleUntil(() => clock.requested.length > waits, { description: "the wait after failure " + (index + 1).toString() });

        waits = clock.requested.length;
        clock.advance(clock.requested.at(-1) ?? 0);

        // eslint-disable-next-line no-await-in-loop -- Each step reads the attempt the previous one let run, so the steps are serial by intent.
        await settleUntil(() => attempts === (index + 2), { description: "sign-in attempt " + (index + 2).toString() });
      }

      const said = logEntries.length;

      shutdown();

      await login;

      assert.deepEqual(logEntries.slice(said).map(formatLogEntry), [], "the attempt the shutdown ended writes nothing at any level");

      return logEntries;
    } finally {

      shutdown();
      controller.abort();

      await settle();
    }
  }

  test("a startup rate limit, bare or wrapped, is said once at warn across repeated attempts, and nothing is said at error", async () => {

    for(const failure of [ rateLimitError, wrappedRateLimitError ]) {

      // eslint-disable-next-line no-await-in-loop -- Each spelling logs a root in of its own, and one at a time keeps each assertion's message its own spelling's.
      const logEntries = await loginFailing(Array.from({ length: 3 }, () => failure));

      assert.equal(logCount(logEntries, "warn", RATE_LIMITED_LINE), 1, failure.message + ": the rate limit was said once at warn");
      assert.deepEqual(linesAt(logEntries, "error"), [], failure.message + ": and nothing was said at error");
    }
  });

  test("a startup rate limit alternating between bare and wrapped is said once at warn across the attempts, and nothing is said at error", async () => {

    // Every rung of the refusal schedule, so the spelling alternates on each attempt the run makes before the plugin shuts down.
    const logEntries = await loginFailing(PROTECT_RECOVERY_REFUSAL_SCHEDULE_MS.backoff.map((_, index) => ((index % 2) === 0) ? rateLimitError : wrappedRateLimitError));

    assert.equal(logCount(logEntries, "warn", RATE_LIMITED_LINE), 1, "the rate limit was said once at warn, however its spelling alternated");
    assert.deepEqual(linesAt(logEntries, "error"), [], "and nothing was said at error");
  });

  test("a refused sign-in is said once at error with its reason, because a person must act, and not as a rate limit", async () => {

    const logEntries = await loginFailing(Array.from({ length: 3 }, () => refusalError));

    assert.deepEqual(linesAt(logEntries, "error"), [PREFIX + failedLine("bad credentials")]);
    assert.equal(logCount(logEntries, "warn", RATE_LIMITED_LINE), 0);
  });

  test("a network failure is said once at warn with its reason, because it should fix itself", async () => {

    const logEntries = await loginFailing(Array.from({ length: 3 }, () => networkError));

    assert.deepEqual(linesAt(logEntries, "warn"), [PREFIX + failedLine(NETWORK_REASON)]);
    assert.deepEqual(linesAt(logEntries, "error"), [], "and nothing was said at error");
  });

  test("a wrapped 503 is said at warn in its whole sentence", async () => {

    const logEntries = await loginFailing([fetchFailed(answered(503))]);

    assert.deepEqual(linesAt(logEntries, "warn"), [PREFIX + failedLine("Unable to fetch the UniFi Protect controller bootstrap: " + STATUS_503)]);
    assert.deepEqual(linesAt(logEntries, "error"), []);
  });

  test("a rate limit, a 503 and a rate limit again are three warnings, whichever spelling the rate limit returns in", async () => {

    const logEntries = await loginFailing([ rateLimitError, answered(503), wrappedRateLimitError ]);

    assert.deepEqual(linesAt(logEntries, "warn"), [ PREFIX + RATE_LIMITED_LINE, PREFIX + failedLine(STATUS_503), PREFIX + RATE_LIMITED_LINE ]);
  });

  test("two errnos of one type alternating are one line, the first", async () => {

    const unreachable = networkFailure("EHOSTUNREACH", "connect EHOSTUNREACH 10.0.0.1:443");
    const hostDown = networkFailure("EHOSTDOWN", "connect EHOSTDOWN 10.0.0.1:443");
    const logEntries = await loginFailing([ unreachable, hostDown, unreachable ]);

    assert.deepEqual(linesAt(logEntries, "warn"), [PREFIX + failedLine(NETWORK_FAULT + "connect EHOSTUNREACH 10.0.0.1:443")]);
    assert.deepEqual(linesAt(logEntries, "error"), []);
  });

  test("a struggling resolver and then a host name that does not exist are a warning and then an error", async () => {

    const struggling = networkFailure("EAI_AGAIN", "getaddrinfo EAI_AGAIN nvr.local");
    const logEntries = await loginFailing([ struggling, networkFailure("ENOTFOUND", "getaddrinfo ENOTFOUND nvr.local") ]);

    assert.deepEqual(linesAt(logEntries, "warn"), [PREFIX + failedLine(NETWORK_FAULT + "getaddrinfo EAI_AGAIN nvr.local")]);
    assert.deepEqual(linesAt(logEntries, "error"), [PREFIX + failedLine(NETWORK_FAULT + "getaddrinfo ENOTFOUND nvr.local")]);
  });

  test("a refused identity and then a refused privilege are two errors, because each asks a person for a different fix", async () => {

    const logEntries = await loginFailing([ refusalError, privilegeRefusal ]);

    assert.deepEqual(linesAt(logEntries, "error"), [ PREFIX + failedLine("bad credentials"), PREFIX + failedLine(PRIVILEGE_REASON) ]);
  });

  test("a 503 and then a refused realtime upgrade are two warnings", async () => {

    const logEntries = await loginFailing([ answered(503), realtimeRefusal ]);

    assert.deepEqual(linesAt(logEntries, "warn"), [ PREFIX + failedLine(STATUS_503), PREFIX + failedLine("The UniFi Protect realtime events API connection failed") ]);
  });

  test("a type, another and the first again are three lines, because a return to an earlier type is said in full", async () => {

    const reset = networkFailure("ECONNRESET", "read ECONNRESET");
    const logEntries = await loginFailing([ networkError, networkError, reset, reset, networkError ]);

    assert.deepEqual(linesAt(logEntries, "warn"), [ PREFIX + failedLine(NETWORK_REASON), PREFIX + failedLine(NETWORK_FAULT + "read ECONNRESET"),
      PREFIX + failedLine(NETWORK_REASON) ]);
  });

  test("a repeat arrives with debug logging on, through the gate's warn channel, and nothing of it arrives with debug logging off", async () => {

    const on = await loginFailing([ networkError, networkError ], { userOptions: ["Enable.Log.Debug"] });
    const off = await loginFailing([ networkError, networkError ]);

    assert.equal(logCount(on, "warn", failedLine(NETWORK_REASON)), 2, "the first line and its repeat");
    assert.equal(logCount(off, "warn", failedLine(NETWORK_REASON)), 1, "the first line alone");
    assert.equal(logCount(off, "debug", failedLine(NETWORK_REASON)), 0, "and the gate drops the repeat rather than passing it on at debug");
  });

  // The helper asserts the silence itself. The attempt the shutdown ends reads a timeout, so it is a new type after a refused connection and a repeat after a deadline.
  test("a shutdown on a new type writes nothing", async () => {

    assert.deepEqual(linesAt(await loginFailing([networkError]), "warn"), [PREFIX + failedLine(NETWORK_REASON)]);
  });

  test("a shutdown on a repeat, with debug logging on, writes nothing", async () => {

    assert.equal((await loginFailing([deadlineError], { userOptions: ["Enable.Log.Debug"] })).length, 1, "the deadline's own line alone");
  });
});

describe("the controller root's address override", () => {

  /* The address the cameras' RTSP URLs are composed against when the user overrides it, resolved by the real root as it logs in: the option outranks the legacy
   * property, an option enabled but left empty falls through to that property, and a plain IPv6 address is kept for the URL composition to bracket. An address carrying
   * an IPv6 zone cannot stand in a URL, so it is set aside with one warning naming it, and the cameras fall through to the address the controller reports for each of
   * them, never to the legacy property an option outranks. The root is read twice after its login, and neither read may move the answer or say the warning again. The
   * controller double resolves the override through the same rule as it is built, and warns on its own, so each case counts only the lines logged after that.
   */
  test("the override address is resolved once at login, and one carrying an IPv6 zone is set aside with one warning", async () => {

    const zoneWarning = "The override address fe80::1%en0 carries an IPv6 zone, which a camera stream address cannot include. Cameras on this controller will use the " +
      "address the controller reports for each of them instead.";
    const cases: { expected: Nullable<string>; legacy?: string; option?: string; warnings: number }[] = [

      { expected: null, warnings: 0 },
      { expected: "option.example", legacy: "legacy.example", option: "option.example", warnings: 0 },
      { expected: "legacy.example", legacy: "legacy.example", option: "", warnings: 0 },
      { expected: "fd00::1", option: "fd00::1", warnings: 0 },
      { expected: null, legacy: "fe80::1%en0", warnings: 1 },
      { expected: null, legacy: "legacy.example", option: "fe80::1%en0", warnings: 1 }
    ];

    for(const { expected, legacy, option, warnings } of cases) {

      const label = "option " + (option ?? "absent") + ", legacy property " + (legacy ?? "absent");
      const clock = new TestClock(TEST_CLOCK_EPOCH);
      const nvrConfig: ProtectNvrConfig = { ...makeNvrConfig(), firmwareVersion: "4.3.6", upSince: clock.now(), version: "6.1.79" };
      const store = new TestStateStore(makeProtectState({ nvr: nvrConfig }));
      const { controller, logEntries, nvr: double } = makeTestNvr({ clock, ...((legacy !== undefined) ? { overrideAddress: legacy } : {}), store,
        userOptions: (option !== undefined) ? ["Enable.Nvr.OverrideAddress." + nvrConfig.mac + "=" + option] : [] });
      const built = logEntries.length;
      const client = makeConnectedClient({ nvrConfig, store });
      const { platform, shutdown } = makeRootPlatform(double);
      const root = new ProtectNvr(platform, double.config, async (): Promise<ProtectClient> => client);

      try {

        // eslint-disable-next-line no-await-in-loop -- Each case logs in a root of its own and ends its run before the next case builds one.
        await root.login();

        assert.equal(root.overrideAddress, expected, label + ": the override the cameras resolve against");
        assert.equal(root.overrideAddress, expected, label + ": a second read gives the same answer");
        assert.equal(logCount(logEntries.slice(built), "warn", zoneWarning), warnings, label + ": the warning is said once for a zoned address, and never otherwise");

        shutdown();

        // eslint-disable-next-line no-await-in-loop -- Each case logs in a root of its own and ends its run before the next case builds one.
        await settle();

        assert.equal(store.observerCount, 0, label + ": every observe loop the root started ended with its shutdown");
      } finally {

        shutdown();
        controller.abort();

        // eslint-disable-next-line no-await-in-loop -- Each case logs in a root of its own and ends its run before the next case builds one.
        await settle();
      }
    }
  });

  /* Each camera bakes its RTSP URLs into its channel profiles as it is built, so the root resolves the override before it adopts any camera. A root whose store carries
   * one camera and whose configuration carries an override logs in, and the camera's channel profiles compose against the override rather than against the camera's
   * connection host, which a resolution made only after the device observers start would leave them composed against.
   */
  test("the override address is resolved before the cameras are adopted, so a camera's channel profiles compose against it", async () => {

    const clock = new TestClock(TEST_CLOCK_EPOCH);
    const nvrConfig: ProtectNvrConfig = { ...makeNvrConfig(), firmwareVersion: "4.3.6", upSince: clock.now(), version: "6.1.79" };

    // The camera record carries what the root's membership reconcile reads before it constructs a camera, its category and its adoption by this controller, on top of
    // the construction read set makeCameraConfig builds.
    const cameraConfig: ProtectCameraConfig = { ...makeCameraConfig({ channels: G2_PRO_CHANNELS }), isAdopted: true, isAdoptedByOther: false, modelKey: "camera" };
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig], nvr: nvrConfig }));
    const { controller, nvr: double } = makeTestNvr({ clock, overrideAddress: "override.example", store });
    const client = makeConnectedClient({ nvrConfig, store });
    const { platform, shutdown } = makeRootPlatform(double);
    const root = new ProtectNvr(platform, double.config, async (): Promise<ProtectClient> => client);

    try {

      await root.login();
      await settle();

      const camera = root.getDeviceById(cameraConfig.id);

      assert.ok(camera instanceof ProtectCamera, "the root adopted the camera its store carries");
      assert.match(camera.selectChannel(1920, 1080)?.url ?? "", /^rtsps:\/\/override\.example:7441\/alias\d\?enableSrtp$/,
        "the camera's channel profiles compose against the override, not its connection host");

      shutdown();

      await settle();

      assert.equal(store.observerCount, 0, "every observe loop the root and its camera started ended with its shutdown");
    } finally {

      shutdown();
      controller.abort();

      await settle();
    }
  });
});

describe("the controller root's accessory cache saves", () => {

  /* A standalone accessory has no place in Homebridge's accessory cache: the cache's serializer refuses one, and a save that named one would fail every save of the
   * run. The root adopts a bridged camera and a standalone one, and marks each as it adds and configures it inside one save window. The window's save names the
   * bridged camera and never the standalone one, and every mark the adoption made goes out in that one save.
   */
  test("a standalone camera is never handed to the cache, while the bridged camera marked in the same window is saved in one update", async () => {

    const clock = new TestClock(TEST_CLOCK_EPOCH);
    const nvrConfig: ProtectNvrConfig = { ...makeNvrConfig(), firmwareVersion: "4.3.6", upSince: clock.now(), version: "6.1.79" };

    // Each camera record carries what the root's membership reconcile reads before it constructs a camera, its category and its adoption by this controller.
    const adopted = (options: { id: string; mac: string; name: string }): ProtectCameraConfig => ({ ...makeCameraConfig({ channels: G2_PRO_CHANNELS, ...options }),
      isAdopted: true, isAdoptedByOther: false, modelKey: "camera" });
    const bridgedConfig = adopted({ id: "camera-bridged", mac: "74ACB9000101", name: "Bridged Camera" });
    const standaloneConfig = adopted({ id: "camera-standalone", mac: "74ACB9000102", name: "Standalone Camera" });
    const store = new TestStateStore(makeProtectState({ cameras: [ bridgedConfig, standaloneConfig ], nvr: nvrConfig }));
    const { api, controller, nvr: double } = makeTestNvr({ clock, store, userOptions: ["Enable.Device.Standalone." + standaloneConfig.mac] });
    const client = makeConnectedClient({ nvrConfig, store });
    const { platform, shutdown } = makeRootPlatform(double);
    const root = new ProtectNvr(platform, double.config, async (): Promise<ProtectClient> => client);

    try {

      await root.login();
      await settle();

      const bridged = double.platform.accessories.find((accessory) => accessory.UUID === accessoryUuid(bridgedConfig.mac));
      const standalone = double.platform.accessories.find((accessory) => accessory.UUID === accessoryUuid(standaloneConfig.mac));

      assert.ok(bridged && standalone, "the root added the bridged camera and the standalone one");
      assert.ok(api.calls.some((call) => (call.kind === "publish") && call.accessories.includes(standalone)),
        "the standalone camera was published outside the bridge");
      assert.equal(api.calls.some((call) => call.kind === "update"), false, "nothing is saved while the adoption's window is open");

      clock.advance(ACCESSORY_SAVE_WINDOW_MS);

      const saves = api.calls.filter((call) => call.kind === "update");

      assert.equal(saves.length, 1, "every mark the adoption made went out in one save");
      assert.ok(saves[0]?.accessories.includes(bridged), "the save names the bridged camera");
      assert.equal(saves.some((call) => call.accessories.includes(standalone)), false, "no save names the standalone camera");
    } finally {

      shutdown();
      controller.abort();

      await settle();
    }
  });
});

describe("the controller root's device names", () => {

  // Every accessory the root hands Homebridge, read as the call hands it: whether the root registered it on the bridge or published it on its own, its UUID, and the
  // display name it carries at that moment, which the configure pass after the call moves on from.
  const captureMintedNames = (api: TestHomebridgeApi): { kind: "publish" | "register"; name: string; uuid: string }[] => {

    const minted: { kind: "publish" | "register"; name: string; uuid: string }[] = [];
    const publish = api.publishExternalAccessories.bind(api);
    const register = api.registerPlatformAccessories.bind(api);

    api.publishExternalAccessories = (pluginIdentifier, accessories): void => {

      minted.push(...accessories.map((accessory) => ({ kind: "publish" as const, name: accessory.displayName, uuid: accessory.UUID })));
      publish(pluginIdentifier, accessories);
    };

    api.registerPlatformAccessories = (pluginIdentifier, platformName, accessories): void => {

      minted.push(...accessories.map((accessory) => ({ kind: "register" as const, name: accessory.displayName, uuid: accessory.UUID })));
      register(pluginIdentifier, platformName, accessories);
    };

    return minted;
  };

  /* HAP refuses an accessory whose display name is empty, and a Protect name that is empty sanitizes to nothing, so the root adds such a camera under its market
   * name, as it adds a camera reporting no name at all. Each camera is adopted at login and registered on the bridge under the name it was added under.
   */
  for(const { name, title } of [ { name: "", title: "a camera whose Protect name is empty is added to HomeKit under its market name" },
    { name: undefined, title: "a camera reporting no Protect name is added to HomeKit under its market name" } ]) {

    test(title, async () => {

      const clock = new TestClock(TEST_CLOCK_EPOCH);
      const nvrConfig: ProtectNvrConfig = { ...makeNvrConfig(), firmwareVersion: "4.3.6", upSince: clock.now(), version: "6.1.79" };

      // The camera record carries what the root's membership reconcile reads before it constructs a camera, with its name set after the builder, whose own default
      // would otherwise stand in for an absent one.
      const cameraConfig: ProtectCameraConfig = { ...makeCameraConfig({ channels: G2_PRO_CHANNELS }), isAdopted: true, isAdoptedByOther: false, modelKey: "camera",
        name };
      const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig], nvr: nvrConfig }));
      const { api, controller, nvr: double } = makeTestNvr({ clock, store });
      const client = makeConnectedClient({ nvrConfig, store });
      const { platform, shutdown } = makeRootPlatform(double);
      const root = new ProtectNvr(platform, double.config, async (): Promise<ProtectClient> => client);

      try {

        await root.login();
        await settle();

        const accessory = double.platform.accessories.find((candidate) => candidate.UUID === accessoryUuid(cameraConfig.mac));

        assert.ok(accessory, "the root added the camera");
        assert.equal(accessory.displayName, "Test Camera Model", "the camera was added under its market name");
        assert.ok(api.calls.some((call) => (call.kind === "register") && call.accessories.includes(accessory)),
          "the camera was registered on the bridge under that name");
      } finally {

        shutdown();
        controller.abort();

        await settle();
      }
    });
  }

  /* A camera the user gave a custom name is minted under it, because a standalone camera is published under the name it is minted with before its configure pass
   * runs. The configure pass names the accessory as well, so the name is read as the root hands the accessory to Homebridge: the double records the accessory
   * itself, which the configure pass then renames, and only a read at the call sees the name the camera was minted under. A custom name HomeKit can carry nothing
   * of counts as none, so the camera is minted under the name the controller reports for it, never under an empty one HAP would refuse.
   */
  for(const { expected, override, standalone, title } of [

    { expected: "Porch", override: "Porch", standalone: false, title: "a camera with a custom name is registered on the bridge under it" },
    { expected: "Front Door", override: "🙂", standalone: false,
      title: "a camera whose custom name HomeKit can carry nothing of is registered under the name the controller reports for it" },
    { expected: "Porch", override: "Porch", standalone: true, title: "a standalone camera with a custom name is published under it" }
  ]) {

    test(title, async () => {

      const clock = new TestClock(TEST_CLOCK_EPOCH);
      const nvrConfig: ProtectNvrConfig = { ...makeNvrConfig(), firmwareVersion: "4.3.6", upSince: clock.now(), version: "6.1.79" };
      const cameraConfig: ProtectCameraConfig = { ...makeCameraConfig({ channels: G2_PRO_CHANNELS, name: "Front Door" }), isAdopted: true, isAdoptedByOther: false,
        modelKey: "camera" };
      const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig], nvr: nvrConfig }));
      const { api, controller, nvr: double } = makeTestNvr({ clock, store, userOptions: [ "Enable.Device.Name." + cameraConfig.mac + "=" + override,
        ...(standalone ? ["Enable.Device.Standalone." + cameraConfig.mac] : []) ] });
      const client = makeConnectedClient({ nvrConfig, store });
      const { platform, shutdown } = makeRootPlatform(double);
      const root = new ProtectNvr(platform, double.config, async (): Promise<ProtectClient> => client);
      const minted = captureMintedNames(api);

      try {

        await root.login();
        await settle();

        assert.deepEqual(minted.filter((entry) => entry.uuid === accessoryUuid(cameraConfig.mac)), [{ kind: standalone ? "publish" : "register", name: expected,
          uuid: accessoryUuid(cameraConfig.mac) }], "the camera was handed to Homebridge once, under the name it was minted with");
      } finally {

        shutdown();
        controller.abort();

        await settle();
      }
    });
  }
});

describe("the controller root's orphan package camera removal", () => {

  /* A package camera whose parent doorbell is gone carries no MAC of its own, so it has no package camera of its own to take with it. The platform holds the orphan
   * beside a device accessory of another controller and one of this controller, each restored onto the bridge, and removing the orphan takes it alone. The
   * controller has only just come up, so the removal gate holds its stability sweep back and nothing but this removal reaches the platform.
   */
  test("removing a package camera whose parent is gone removes that accessory alone", async () => {

    const clock = new TestClock(TEST_CLOCK_EPOCH);
    const nvrConfig: ProtectNvrConfig = { ...makeNvrConfig(), firmwareVersion: "4.3.6", upSince: clock.now(), version: "6.1.79" };
    const store = new TestStateStore(makeProtectState({ nvr: nvrConfig }));
    const { api, controller, logEntries, nvr: double } = makeTestNvr({ clock, store });
    const orphan = makeTestAccessory("Front Door Package Camera", "74ACB9000001.PackageCamera");
    const foreign = makeTestAccessory("Other Controller Camera", "74ACB9000002");
    const own = makeTestAccessory("Garage Camera", "74ACB9000003");

    orphan.context = { nvr: nvrConfig.mac, packageCamera: "74ACB9000001" };
    foreign.context = { mac: "74ACB9000002", nvr: "AABBCCDDEEFF" };
    own.context = { mac: "74ACB9000003", nvr: nvrConfig.mac };
    restoreAccessories(double, [ orphan, foreign, own ]);

    const client = makeConnectedClient({ nvrConfig, store });
    const { platform, shutdown } = makeRootPlatform(double);
    const root = new ProtectNvr(platform, double.config, async (): Promise<ProtectClient> => client);

    try {

      await root.login();
      await settle();

      const logged = logEntries.length;

      root.removeHomeKitDevice(orphan);

      assert.deepEqual(logEntries.slice(logged).map(formatLogEntry),
        ["Test Controller [UniFi Dream Machine SE]: Front Door Package Camera: Removing device from HomeKit."], "the removal logs its one line");
      assert.equal(double.platform.accessories.includes(orphan), false, "the orphan left the platform");
      assert.ok(double.platform.accessories.includes(foreign) && double.platform.accessories.includes(own), "both bystanders stay on the platform");
      assert.deepEqual(api.calls.filter((call) => call.kind === "unregister").flatMap((call) => call.accessories), [orphan], "the orphan alone was unregistered");
    } finally {

      shutdown();
      controller.abort();

      await settle();
    }
  });
});

// The handles a row drives its removal through and reads its outcome from.
interface LoggedInRoot {

  api: TestHomebridgeApi;
  clientLog: ProtectLogging;
  clock: TestClock;
  connection: TestConnection;
  double: TestProtectNvr;
  logEntries: readonly TestLogEntry[];
  root: ProtectNvr;
  stop: () => Promise<void>;
  store: TestStateStore;
}

// A camera record the root adopts at login: the record makeCameraConfig builds, with the category and the adoption by this controller the membership reconcile reads
// before it constructs a camera.
function adopted(config: ProtectCameraConfig): ProtectCameraConfig {

  return { ...config, isAdopted: true, isAdoptedByOther: false, modelKey: "camera" };
}

// The camera most rows adopt, and the doorbell whose package camera the camera cascade takes with it.
const PORCH = adopted(makeCameraConfig({ channels: G2_PRO_CHANNELS, id: "camera-porch", mac: "74ACB9000101", name: "Porch Camera" }));
const FRONT_DOOR = adopted(makeCameraConfig({ channels: G6_PRO_ENTRY_CHANNELS, featureFlags: { hasPackageCamera: true, isDoorbell: true }, id: "camera-front-door",
  mac: "74ACB9000001", name: "Front Door" }));

/* Log a real controller root in over the controller double's platform: the row's accessories restored onto the bridge first, as Homebridge restores its cache before
 * the plugin logs in, and the row's camera records in the store the root connects to. The controller reports an uptime starting now, so the removal gate stays
 * unsettled and its stability sweep never runs, and nothing but the row's own removal reaches the platform. stop ends the run: Homebridge's shutdown, the double's
 * controller and a settle, so no observe loop or process-global subscription outlives the row.
 */
async function logIn(options: { accessories?: ProtectAccessory[]; cameras?: ProtectCameraConfig[]; mqtt?: TestMqttClient; userOptions?: string[] } = {}):
Promise<LoggedInRoot> {

  const clock = new TestClock(TEST_CLOCK_EPOCH);
  const nvrConfig: ProtectNvrConfig = { ...makeNvrConfig(), firmwareVersion: "4.3.6", upSince: clock.now(), version: "6.1.79" };
  const store = new TestStateStore(makeProtectState({ cameras: options.cameras ?? [], nvr: nvrConfig }));
  const { api, controller, logEntries, nvr: double } = makeTestNvr({ clock, store, userOptions: options.userOptions });

  restoreAccessories(double, options.accessories ?? []);

  const client = makeConnectedClient({ nvrConfig, store });
  const { platform, shutdown } = makeRootPlatform(double);
  const connects: ConnectOptions[] = [];
  const root = new ProtectNvr(platform, double.config, async (connect: ConnectOptions): Promise<ProtectClient> => {

    connects.push(connect);

    return client;
  });

  // The root builds no client of its own beside one already standing, which is how an MQTT double reaches a row.
  root.mqtt = (options.mqtt ?? null) as unknown as ProtectNvr["mqtt"];

  await root.login();
  await settle();

  // The logger the root handed the library, which is the one way the library's lines reach it.
  const clientLog = connects[0]?.log;

  assert.ok(clientLog, "the root hands the library its logger at connect");

  const stop = async (): Promise<void> => {

    shutdown();
    controller.abort();

    await settle();
  };

  return { api, clientLog, clock, connection: client.connection as unknown as TestConnection, double, logEntries, root, stop, store };
}

describe("the controller root's MQTT availability", () => {

  const CONTROLLER_MAC = makeNvrConfig().mac;

  // Every statement made on a MAC's availability topic, as its word and whether it was retained, in order.
  function statements(mqtt: TestMqttClient, mac: string): string[] {

    return mqtt.published.filter(({ topic }) => topic === (mac + "/availability")).map(({ payload, retain }) => String(payload) + (retain ? " retained" : ""));
  }

  // An MQTT double recording its own lines, standing with no broker session unless a row says otherwise.
  function standMqtt({ connected = false }: { connected?: boolean } = {}): { lines: readonly TestLogEntry[]; mqtt: TestMqttClient } {

    const log = capturingLog();
    const mqtt = new TestMqttClient({ log });

    mqtt.connected = connected;

    return { lines: log.entries, mqtt };
  }

  // Liveviews restate themselves on a session, so a session's order reads against something the controller's statement has to come ahead of.
  test("a session opens with HBPU's statement and then the controller's, ahead of every other restatement", async () => {

    const { mqtt } = standMqtt();
    const { stop } = await logIn({ cameras: [PORCH], mqtt });

    try {

      assert.deepEqual(statements(mqtt, CONTROLLER_MAC), [], "no session, so nothing was stated");

      mqtt.connected = true;

      assert.deepEqual(mqtt.published.slice(0, 2).map(({ topic }) => topic), [ "availability", CONTROLLER_MAC + "/availability" ]);
      assert.deepEqual(statements(mqtt, CONTROLLER_MAC), ["online retained"], "the controller reads online");
      assert.deepEqual(statements(mqtt, PORCH.mac), ["online retained"], "and so does the camera, stating its own");
    } finally {

      await stop();
    }
  });

  // The loop states on every transition, and the verdict decides what it says, so a blip the verdict does not read leaves the statement standing.
  test("the controller and its devices state each transition of the verdict, and a blip it does not read says nothing", async () => {

    const { mqtt } = standMqtt({ connected: true });
    const { connection, stop } = await logIn({ cameras: [PORCH], mqtt });

    try {

      mqtt.connected = false;
      mqtt.connected = true;

      const mark = mqtt.published.length;

      connection.isHealthy = false;
      connection.transition({ from: "healthy", to: "degraded" });

      await settle();

      assert.equal(mqtt.published.length, mark, "a degraded connection the verdict does not read says nothing");

      connection.isLost = true;
      connection.transition({ from: "degraded", to: "lost" });

      await settle();

      assert.equal(statements(mqtt, CONTROLLER_MAC).at(-1), "offline retained", "the controller's loss is stated");
      assert.equal(statements(mqtt, PORCH.mac).at(-1), "offline retained", "and on the camera it feeds");

      connection.isHealthy = true;
      connection.isLost = false;
      connection.transition({ from: "lost", to: "healthy" });

      await settle();

      assert.equal(statements(mqtt, CONTROLLER_MAC).at(-1), "online retained", "the recovery is stated");
      assert.equal(statements(mqtt, PORCH.mac).at(-1), "online retained", "and on the camera");
    } finally {

      await stop();
    }
  });

  // The root reports an uptime starting at login, so the removal gate refuses to mark anything, and the statement goes out ahead of it regardless.
  test("a device leaving the adopted set is stated offline ahead of the stability gate, as a vanished record and as an unadopted one", async () => {

    const SHED = adopted(makeCameraConfig({ channels: G2_PRO_CHANNELS, id: "camera-shed", mac: "74ACB9000102", name: "Shed Camera" }));
    const { mqtt } = standMqtt({ connected: true });
    const { root, stop, store } = await logIn({ cameras: [ PORCH, SHED ], mqtt });

    try {

      mqtt.connected = false;
      mqtt.connected = true;

      store.removeCameraRecord(PORCH.id);
      store.pushCameraPatch(SHED.id, { isAdopted: false });

      await settle();

      assert.equal(statements(mqtt, PORCH.mac).at(-1), "offline retained", "the vanished record reached the broker");
      assert.equal(statements(mqtt, SHED.mac).at(-1), "offline retained", "and the unadopted one");
      assert.equal(root.removals.removalStable, false, "with the removal gate closed");
    } finally {

      await stop();
    }
  });

  // A statement made with no session is refused and never repeated, so an accessory that stands with nothing serving it is told again at each session, and a removal no
  // session heard is held for the next one and told once.
  test("an unclaimed restored accessory is stated offline at each session, a removal before the first session once, and a live device only by itself", async () => {

    const unclaimed = makeTestAccessory("Old Camera", "74ACB9000103");
    const removed = adopted(makeCameraConfig({ channels: G2_PRO_CHANNELS, id: "camera-removed", mac: "74ACB9000104", name: "Removed Camera" }));

    const foreign = makeTestAccessory("Foreign Camera", "74ACB9000107");

    unclaimed.context = { mac: "74ACB9000103", nvr: CONTROLLER_MAC };
    foreign.context = { mac: "74ACB9000107", nvr: "AABBCCDDEEFF" };

    const { mqtt } = standMqtt();
    const { double, root, stop } = await logIn({ accessories: [ foreign, unclaimed ], cameras: [ PORCH, removed ], mqtt });

    try {

      const accessory = double.platform.accessories.find(({ UUID }) => UUID === accessoryUuid(removed.mac));

      assert.ok(accessory, "the root added the camera it goes on to remove");

      root.removeHomeKitDevice(accessory);

      assert.deepEqual(mqtt.published, [], "no session, so nothing reached the broker");

      mqtt.connected = true;

      assert.deepEqual(mqtt.published.slice(0, 2).map(({ topic }) => topic), [ "availability", CONTROLLER_MAC + "/availability" ],
        "the controller's statement opens the session, ahead of the removal it holds");
      assert.deepEqual(statements(mqtt, unclaimed.context.mac ?? ""), ["offline retained"], "the accessory nothing serves reads offline");
      assert.deepEqual(statements(mqtt, removed.mac), ["offline retained"], "a removal no session heard is stated at the first session");
      assert.deepEqual(statements(mqtt, PORCH.mac), ["online retained"], "and the live camera reads only what it says itself");
      assert.deepEqual(statements(mqtt, "74ACB9000107"), [], "and another controller's accessory is that controller's to state");

      mqtt.connected = false;
      mqtt.connected = true;

      assert.deepEqual(statements(mqtt, unclaimed.context.mac ?? ""), [ "offline retained", "offline retained" ],
        "a later session is told again, since each starts from nothing");
      assert.deepEqual(statements(mqtt, removed.mac), ["offline retained"], "and the removal is not stated again");
    } finally {

      await stop();
    }
  });

  test("a removal during a session states the device offline once, and a later session says nothing more", async () => {

    const { mqtt } = standMqtt({ connected: true });
    const { double, root, stop } = await logIn({ cameras: [PORCH], mqtt });

    try {

      mqtt.connected = false;
      mqtt.connected = true;

      const accessory = double.platform.accessories.find(({ UUID }) => UUID === accessoryUuid(PORCH.mac));

      assert.ok(accessory, "the root added the camera");

      root.removeHomeKitDevice(accessory);

      assert.equal(statements(mqtt, PORCH.mac).at(-1), "offline retained", "the removal's statement goes out with the session standing");

      const heard = statements(mqtt, PORCH.mac).length;

      mqtt.connected = false;
      mqtt.connected = true;

      assert.equal(statements(mqtt, PORCH.mac).length, heard, "and a later session is told nothing more");
    } finally {

      await stop();
    }
  });

  // The hold and its drain read whether a session stands, never whether one ever stood, so an outage after earlier sessions holds a removal as a start with none does.
  // The session that returns is what replaces the online this camera left retained.
  test("a removal in a mid-run outage states one offline at the session that returns, and nothing at one more", async () => {

    const { mqtt } = standMqtt({ connected: true });
    const { double, root, stop } = await logIn({ cameras: [PORCH], mqtt });

    try {

      mqtt.connected = false;
      mqtt.connected = true;

      assert.equal(statements(mqtt, PORCH.mac).at(-1), "online retained", "the camera stated itself at an earlier session");

      const accessory = double.platform.accessories.find(({ UUID }) => UUID === accessoryUuid(PORCH.mac));

      assert.ok(accessory, "the root added the camera");

      mqtt.connected = false;

      root.removeHomeKitDevice(accessory);

      mqtt.connected = true;

      assert.equal(statements(mqtt, PORCH.mac).at(-1), "offline retained", "the returning session hears the removal");

      const heard = statements(mqtt, PORCH.mac).length;

      mqtt.connected = false;
      mqtt.connected = true;

      assert.equal(statements(mqtt, PORCH.mac).length, heard, "and one more session hears nothing");
    } finally {

      await stop();
    }
  });

  // What comes back under the same MAC states its own availability, so a removal earlier in the run leaves nothing to contradict it.
  test("a device removed and adopted again in the same run is stated only by itself", async () => {

    const { mqtt } = standMqtt();
    const { double, root, stop } = await logIn({ cameras: [PORCH], mqtt });

    try {

      const accessory = double.platform.accessories.find(({ UUID }) => UUID === accessoryUuid(PORCH.mac));

      assert.ok(accessory, "the root added the camera");

      root.removeHomeKitDevice(accessory);
      root.addHomeKitDevice(PORCH);

      mqtt.connected = true;

      assert.deepEqual(statements(mqtt, PORCH.mac), ["online retained"], "the session hears the live device and nothing contradicting it");
    } finally {

      await stop();
    }
  });

  // A session drops a held MAC whether it states it or passes it over. A passed-over MAC left held would have the session after the device's next removal say an offline
  // a standing session already heard.
  test("a MAC passed over at a session is dropped, so a later removal is not repeated", async () => {

    const { mqtt } = standMqtt();
    const { double, root, stop } = await logIn({ cameras: [PORCH], mqtt });

    try {

      const accessory = double.platform.accessories.find(({ UUID }) => UUID === accessoryUuid(PORCH.mac));

      assert.ok(accessory, "the root added the camera");

      root.removeHomeKitDevice(accessory);
      root.addHomeKitDevice(PORCH);

      mqtt.connected = true;

      assert.deepEqual(statements(mqtt, PORCH.mac), ["online retained"], "the session passes over the MAC, the device adopted again stating itself");

      const readopted = double.platform.accessories.find(({ UUID }) => UUID === accessoryUuid(PORCH.mac));

      assert.ok(readopted, "the root added the camera again");

      root.removeHomeKitDevice(readopted);

      assert.deepEqual(statements(mqtt, PORCH.mac), [ "online retained", "offline retained" ], "the later removal is stated with the session standing");

      mqtt.connected = false;
      mqtt.connected = true;

      assert.deepEqual(statements(mqtt, PORCH.mac), [ "online retained", "offline retained" ], "and a later session repeats nothing");
    } finally {

      await stop();
    }
  });

  // What a held MAC is owed reads who serves it, never the controller's verdict, so a session starting through a lost controller states it as any other does.
  test("a held MAC is stated at a session that starts through a lost controller", async () => {

    const { mqtt } = standMqtt();
    const { connection, double, root, stop } = await logIn({ cameras: [PORCH], mqtt });

    try {

      const accessory = double.platform.accessories.find(({ UUID }) => UUID === accessoryUuid(PORCH.mac));

      assert.ok(accessory, "the root added the camera");

      root.removeHomeKitDevice(accessory);

      connection.isLost = true;
      mqtt.connected = true;

      assert.equal(statements(mqtt, CONTROLLER_MAC).at(-1), "offline retained", "the session opens on the controller reading lost");
      assert.deepEqual(statements(mqtt, PORCH.mac), ["offline retained"], "and hears the removal all the same");
    } finally {

      await stop();
    }
  });

  // A removal that fails leaves its accessory standing and claimed, which no session restates, with the device already let go, so the hold alone speaks for it.
  test("a removal whose unregister throws with no session states one offline at the first session, none at the second, and online on re-adoption", async () => {

    const { mqtt } = standMqtt();
    const { api, double, root, stop } = await logIn({ cameras: [PORCH], mqtt });

    try {

      const accessory = double.platform.accessories.find(({ UUID }) => UUID === accessoryUuid(PORCH.mac));

      assert.ok(accessory, "the root added the camera");

      const unregister = api.unregisterPlatformAccessories.bind(api);

      api.unregisterPlatformAccessories = (): void => {

        throw new Error("HAP refused the removal.");
      };

      assert.throws(() => root.removeHomeKitDevice(accessory), /HAP refused the removal/);

      api.unregisterPlatformAccessories = unregister;

      assert.ok(double.platform.accessories.includes(accessory), "the failed removal left its accessory standing");

      mqtt.connected = true;

      assert.deepEqual(statements(mqtt, PORCH.mac), ["offline retained"], "the first session hears the removal");

      mqtt.connected = false;
      mqtt.connected = true;

      assert.deepEqual(statements(mqtt, PORCH.mac), ["offline retained"], "a second session hears nothing more");

      root.addHomeKitDevice(PORCH);

      assert.deepEqual(statements(mqtt, PORCH.mac), [ "offline retained", "online retained" ], "and the device adopted again states itself");
    } finally {

      await stop();
    }
  });

  // A setup that throws ahead of seeding its context leaves an accessory carrying no MAC, which no session restates, and no device in configuredDevices, so nothing
  // serves the MAC and the hold alone says so.
  test("a re-adoption whose setup throws states one offline at the first session", async (t) => {

    const { mqtt } = standMqtt();
    const { double, root, stop } = await logIn({ cameras: [PORCH], mqtt });

    try {

      const accessory = double.platform.accessories.find(({ UUID }) => UUID === accessoryUuid(PORCH.mac));

      assert.ok(accessory, "the root added the camera");

      root.removeHomeKitDevice(accessory);

      t.mock.method(ProtectCamera.prototype as unknown as { configureHints: () => boolean }, "configureHints", (): boolean => {

        throw new Error("The camera's setup could not start.");
      });

      assert.throws(() => root.addHomeKitDevice(PORCH), /could not start/);
      assert.equal(root.configuredDevices.has(accessoryUuid(PORCH.mac)), false, "the device whose setup threw is not recorded");
      assert.equal(double.platform.accessories.find(({ UUID }) => UUID === accessoryUuid(PORCH.mac))?.context.mac, undefined, "and its accessory carries no MAC");

      mqtt.connected = true;

      assert.deepEqual(statements(mqtt, PORCH.mac), ["offline retained"], "the session hears one offline");
    } finally {

      await stop();
    }
  });

  // The device moved: another controller's accessory stands on the MAC this one holds, and that controller states it, so a word from here would speak over a live device.
  test("a MAC held by this controller and standing under another controller's context is not stated by this one", async () => {

    const moved = makeTestAccessory("Porch Camera", PORCH.mac);

    moved.context = { mac: PORCH.mac, nvr: "AABBCCDDEEFF" };

    const { mqtt } = standMqtt();
    const { double, root, stop } = await logIn({ cameras: [PORCH], mqtt });

    try {

      const accessory = double.platform.accessories.find(({ UUID }) => UUID === accessoryUuid(PORCH.mac));

      assert.ok(accessory, "the root added the camera");

      root.removeHomeKitDevice(accessory);
      double.platform.accessories.push(moved);

      mqtt.connected = true;

      assert.deepEqual(statements(mqtt, PORCH.mac), [], "the session states nothing on the other controller's device");
    } finally {

      await stop();
    }
  });

  // A device the user disabled has no MQTT surface, so a removal held for lack of a session stays silent at the session that reads it.
  test("a disabled device's removal with no session stays silent at the next session", async () => {

    const restored = makeTestAccessory("Disabled Camera", "74ACB9000105");
    const disabled = adopted(makeCameraConfig({ channels: G2_PRO_CHANNELS, id: "camera-disabled", mac: "74ACB9000105", name: "Disabled Camera" }));

    restored.context = { mac: disabled.mac, nvr: CONTROLLER_MAC };

    const { mqtt } = standMqtt();
    const { double, stop } = await logIn({ accessories: [restored], cameras: [disabled], mqtt, userOptions: ["Disable.Device." + disabled.mac] });

    try {

      assert.equal(double.platform.accessories.includes(restored), false, "the restored accessory left HomeKit with no session standing");

      mqtt.connected = true;

      assert.deepEqual(mqtt.published.filter(({ topic }) => topic.startsWith(disabled.mac)), [], "the session says nothing of it");
    } finally {

      await stop();
    }
  });

  // A device's availability topic is its MAC's, so an accessory carrying no MAC has none to be stated on, whatever left it standing.
  test("a standing unclaimed accessory with no MAC is stated on no topic at a session", async () => {

    const stray = makeTestAccessory("Stray Accessory", "74ACB9000109.Stray");

    stray.context = { nvr: CONTROLLER_MAC };

    const { mqtt } = standMqtt();
    const { double, stop } = await logIn({ accessories: [stray], mqtt });

    try {

      assert.ok(double.platform.accessories.includes(stray), "the accessory stands");
      assert.equal(double.platform.isAccessoryClaimed(stray), false, "with no owner claiming it");

      mqtt.connected = true;

      assert.deepEqual(mqtt.published.filter(({ topic }) => topic.endsWith("/availability")).map(({ topic }) => topic), [CONTROLLER_MAC + "/availability"],
        "the session states the controller alone");
    } finally {

      await stop();
    }
  });

  // A package camera's topic is its parent's, so the removal of an orphan one has no topic of its own to state, and no parent's to speak over.
  test("removing a package camera whose parent is gone states nothing", async () => {

    const orphan = makeTestAccessory("Orphan Package Camera", "74ACB9000108.PackageCamera");

    orphan.context = { nvr: CONTROLLER_MAC, packageCamera: "74ACB9000108" };

    const { mqtt } = standMqtt({ connected: true });
    const { double, root, stop } = await logIn({ accessories: [orphan], mqtt });

    try {

      root.removeHomeKitDevice(orphan);

      assert.equal(double.platform.accessories.includes(orphan), false, "the removal ran");
      assert.deepEqual(statements(mqtt, "74ACB9000108"), [], "and it said nothing on its parent's topic");
      assert.deepEqual(statements(mqtt, ""), [], "nor on a topic with no MAC in it");

      mqtt.connected = false;
      mqtt.connected = true;

      assert.deepEqual(statements(mqtt, ""), [], "and a later session is told nothing about it");
    } finally {

      await stop();
    }
  });

  // A device the user disabled has no MQTT surface, so its restored accessory's removal says nothing with a session standing, and neither does a later session. An
  // accessory of its that a failed removal left standing is the same device, so it is not stated as an unserved one either.
  test("a disabled device states nothing, on its restored accessory's removal or at a later session", async () => {

    const restored = makeTestAccessory("Disabled Camera", "74ACB9000105");
    const disabled = adopted(makeCameraConfig({ channels: G2_PRO_CHANNELS, id: "camera-disabled", mac: "74ACB9000105", name: "Disabled Camera" }));
    const neverAdded = adopted(makeCameraConfig({ channels: G2_PRO_CHANNELS, id: "camera-never", mac: "74ACB9000106", name: "Never Camera" }));

    restored.context = { mac: disabled.mac, nvr: CONTROLLER_MAC };

    const { mqtt } = standMqtt({ connected: true });
    const { double, stop } = await logIn({ accessories: [restored], cameras: [ disabled, neverAdded ], mqtt,
      userOptions: [ "Disable.Device." + disabled.mac, "Disable.Device." + neverAdded.mac ] });

    try {

      assert.equal(double.platform.accessories.includes(restored), false, "the restored accessory left HomeKit");
      assert.deepEqual(statements(mqtt, disabled.mac), [], "its removal said nothing with a session standing");

      double.platform.accessories.push(restored);

      mqtt.connected = false;
      mqtt.connected = true;

      assert.deepEqual(mqtt.published.filter(({ topic }) => topic.startsWith(disabled.mac)), [], "a later session says nothing of it, standing or not");
      assert.deepEqual(mqtt.published.filter(({ topic }) => topic.startsWith(neverAdded.mac)), [], "and a disabled device with no accessory has no MQTT surface at all");
    } finally {

      double.platform.accessories.splice(double.platform.accessories.indexOf(restored), 1);

      await stop();
    }
  });

  // Aborting first would release every word with the lifetime it lives under, so what the row reads is the words themselves and no complaint that any went unsaid.
  test("shutdown states the controller's and each device's offline, and only then ends the controller's lifetime", async () => {

    const { lines, mqtt } = standMqtt({ connected: true });
    const { root, stop } = await logIn({ cameras: [PORCH], mqtt });

    try {

      const signalAtWords: boolean[] = [];

      mqtt.onEnd(() => void signalAtWords.push(root.signal.aborted));

      await stop();
      await settleUntil(() => root.phase === "shuttingDown", { description: "the root to finish its shutdown" });

      assert.equal(statements(mqtt, CONTROLLER_MAC).at(-1), "offline retained", "the controller's word");
      assert.equal(statements(mqtt, PORCH.mac).at(-1), "offline retained", "and the camera's");
      assert.deepEqual(signalAtWords, [false], "each stated while the controller's lifetime held");
      assert.equal(root.signal.aborted, true, "which the shutdown then ended");
      assert.equal(lines.some(({ message }) => message.includes("went unsaid")), false, "with no word left unsaid");
    } finally {

      await stop();
    }
  });

  // HBPU weighs a change-gated publish against whatever the topic last said, so a final word through that gate would say nothing here, and a subscriber reading the end
  // of the session would never see the word that ends it.
  test("the controller's final word goes out past the change gate, on a topic that already reads offline", async () => {

    const { mqtt } = standMqtt({ connected: true });
    const { connection, root, stop } = await logIn({ mqtt });

    try {

      mqtt.connected = false;
      mqtt.connected = true;

      connection.isLost = true;
      connection.transition({ from: "healthy", to: "lost" });

      await settle();

      assert.equal(statements(mqtt, CONTROLLER_MAC).at(-1), "offline retained", "the loss is already on the topic");

      const said = statements(mqtt, CONTROLLER_MAC).length;

      await stop();
      await settleUntil(() => root.phase === "shuttingDown", { description: "the root to finish its shutdown" });

      assert.deepEqual(statements(mqtt, CONTROLLER_MAC).slice(said), ["offline retained"], "and the final word says so again");
    } finally {

      await stop();
    }
  });

  // With no client there is nothing to wait on, so the whole of the shutdown stays in the event's own turn, which the rest of the root's teardown has always counted on.
  test("a controller with no MQTT client shuts down in the shutdown event's own turn", async () => {

    const { double, root, stop } = await logIn();

    try {

      double.platform.api.emit(APIEvent.SHUTDOWN);

      assert.equal(root.phase, "shuttingDown", "the phase moved before the event returned");
    } finally {

      await stop();
    }
  });
});

describe("the device-removal cascade", () => {

  // The controller every row's root logs in as, and another controller, whose accessories this root leaves alone.
  const CONTROLLER_MAC = makeNvrConfig().mac;
  const OTHER_CONTROLLER_MAC = "AABBCCDDEEFF";

  // The prefix the root's logger puts on every line once it has connected: the controller's name and its model.
  const PREFIX = "Test Controller [UniFi Dream Machine SE]: ";

  // Every accessory the root handed Homebridge to unregister, in order.
  function unregistered(api: TestHomebridgeApi): ProtectAccessory[] {

    return api.calls.filter((call) => call.kind === "unregister").flatMap((call) => call.accessories);
  }

  // The accessory the root added for a camera record, found by the UUID production derives from its MAC.
  function accessoryOf(double: TestProtectNvr, mac: string): ProtectAccessory {

    const accessory = double.platform.accessories.find((candidate) => candidate.UUID === accessoryUuid(mac));

    assert.ok(accessory, "the root added the accessory for " + mac);

    return accessory;
  }

  // An accessory restored onto the bridge with the context a row gives it.
  function cached(name: string, seed: string, context: ProtectAccessory["context"]): ProtectAccessory {

    const accessory = makeTestAccessory(name, seed);

    accessory.context = context;

    return accessory;
  }

  test("an accessory no longer on the platform is left alone, so a removal that already ran is a no-op", async () => {

    // A device accessory of this controller that is not on the platform, as one an earlier removal already took off it is not.
    const gone = cached("Garage Camera", "74ACB9000003", { mac: "74ACB9000003", nvr: CONTROLLER_MAC });
    const { api, logEntries, root, stop } = await logIn();

    try {

      const logged = logEntries.length;

      root.removeHomeKitDevice(gone);

      assert.deepEqual(logEntries.slice(logged).map(formatLogEntry), [], "nothing is logged");
      assert.deepEqual(unregistered(api), [], "nothing is unregistered");
    } finally {

      await stop();
    }
  });

  test("an accessory of another controller is left alone", async () => {

    const foreign = cached("Other Controller Camera", "74ACB9000002", { mac: "74ACB9000002", nvr: OTHER_CONTROLLER_MAC });
    const { api, double, logEntries, root, stop } = await logIn({ accessories: [foreign] });

    try {

      const logged = logEntries.length;

      root.removeHomeKitDevice(foreign);

      assert.deepEqual(logEntries.slice(logged).map(formatLogEntry), [], "nothing is logged");
      assert.ok(double.platform.accessories.includes(foreign), "the accessory stays on the platform");
      assert.deepEqual(unregistered(api), [], "nothing is unregistered");
    } finally {

      await stop();
    }
  });

  test("the system information accessory is left to the owner that manages it", async () => {

    const { api, double, logEntries, root, stop } = await logIn({ userOptions: ["Enable.NVR.SystemInfo"] });

    try {

      const systemInfo = double.platform.accessories.find((accessory) => accessory.context.systemInfo);

      assert.ok(systemInfo, "the root's system information owner added its accessory at login");

      const logged = logEntries.length;

      root.removeHomeKitDevice(systemInfo);

      assert.deepEqual(logEntries.slice(logged).map(formatLogEntry), [], "nothing is logged");
      assert.ok(double.platform.accessories.includes(systemInfo), "the accessory stays on the platform");
      assert.deepEqual(unregistered(api), [], "nothing is unregistered");
    } finally {

      await stop();
    }
  });

  test("an accessory the liveviews owner derives is left to that owner", async () => {

    const liveview = cached("Front Door Liveview", CONTROLLER_MAC + ".Liveview.FRONTDOOR", { liveview: "Front Door", liveviewDerived: true, nvr: CONTROLLER_MAC });
    const { api, double, logEntries, root, stop } = await logIn({ accessories: [liveview] });

    try {

      const logged = logEntries.length;

      root.removeHomeKitDevice(liveview);

      assert.deepEqual(logEntries.slice(logged).map(formatLogEntry), [], "nothing is logged");
      assert.ok(double.platform.accessories.includes(liveview), "the accessory stays on the platform");
      assert.deepEqual(unregistered(api), [], "nothing is unregistered");
    } finally {

      await stop();
    }
  });

  test("an accessory of this controller carrying no MAC that is not a package camera is left alone", async () => {

    const unmanaged = cached("Unmanaged Accessory", CONTROLLER_MAC + ".Unmanaged", { nvr: CONTROLLER_MAC });
    const { api, double, logEntries, root, stop } = await logIn({ accessories: [unmanaged] });

    try {

      const logged = logEntries.length;

      root.removeHomeKitDevice(unmanaged);

      assert.deepEqual(logEntries.slice(logged).map(formatLogEntry), [], "nothing is logged");
      assert.ok(double.platform.accessories.includes(unmanaged), "the accessory stays on the platform");
      assert.deepEqual(unregistered(api), [], "nothing is unregistered");
    } finally {

      await stop();
    }
  });

  test("a package camera whose parent still stands is left for the parent's removal", async () => {

    const parent = cached("Front Door", "74ACB9000001", { mac: "74ACB9000001", nvr: CONTROLLER_MAC });
    const packageCamera = cached("Front Door Package Camera", "74ACB9000001.PackageCamera", { nvr: CONTROLLER_MAC, packageCamera: "74ACB9000001" });
    const { api, double, logEntries, root, stop } = await logIn({ accessories: [ parent, packageCamera ] });

    try {

      const logged = logEntries.length;

      root.removeHomeKitDevice(packageCamera);

      assert.deepEqual(logEntries.slice(logged).map(formatLogEntry), [], "nothing is logged");
      assert.ok(double.platform.accessories.includes(packageCamera) && double.platform.accessories.includes(parent), "both accessories stay on the platform");
      assert.deepEqual(unregistered(api), [], "nothing is unregistered");
    } finally {

      await stop();
    }
  });

  test("a configured device is named from its wrapper's live record", async () => {

    const { api, double, logEntries, root, stop } = await logIn({ cameras: [PORCH] });

    try {

      const accessory = accessoryOf(double, PORCH.mac);
      const logged = logEntries.length;

      root.removeHomeKitDevice(accessory);

      assert.deepEqual(logEntries.slice(logged).map(formatLogEntry), [PREFIX + "Porch Camera [Test Camera Model]: Removing camera from HomeKit."],
        "the removal names the camera from its live record");
      assert.equal(double.platform.accessories.includes(accessory), false, "the accessory left the platform");
      assert.deepEqual(unregistered(api), [accessory], "the accessory was unregistered");
    } finally {

      await stop();
    }
  });

  test("a configured device whose record is gone is named from the record the controller reports for its MAC", async () => {

    const { double, logEntries, root, stop, store } = await logIn({ cameras: [PORCH] });

    try {

      const accessory = accessoryOf(double, PORCH.mac);

      // The controller drops the camera's record and reports the same MAC again under a new id, so the wrapper's own record is gone while the MAC still resolves.
      store.removeCameraRecord(PORCH.id);
      store.addCameraRecord({ ...PORCH, id: "camera-porch-readopted", name: "Porch Camera Readopted" });

      await settle();

      const logged = logEntries.length;

      root.removeHomeKitDevice(accessory);

      assert.deepEqual(logEntries.slice(logged).map(formatLogEntry), [PREFIX + "Porch Camera Readopted [Test Camera Model]: Removing camera from HomeKit."],
        "the removal names the camera from the record its MAC resolves to");
      assert.equal(double.platform.accessories.includes(accessory), false, "the accessory left the platform");
    } finally {

      await stop();
    }
  });

  test("a configured device with no record at all is named from its accessory name", async () => {

    const { api, double, logEntries, root, stop, store } = await logIn({ cameras: [PORCH] });

    try {

      const accessory = accessoryOf(double, PORCH.mac);

      store.removeCameraRecord(PORCH.id);

      await settle();

      // The accessory's AccessoryInformation Name, which the wrapper's accessory name reads, is set apart from its display name, so the line shows which one it took.
      accessory.getService(api.hap.Service.AccessoryInformation)?.updateCharacteristic(api.hap.Characteristic.Name, "Porch Camera Information");

      assert.notEqual(accessory.displayName, "Porch Camera Information", "the display name and the accessory name differ");

      const logged = logEntries.length;

      root.removeHomeKitDevice(accessory);

      assert.deepEqual(logEntries.slice(logged).map(formatLogEntry), [PREFIX + "Porch Camera Information: Removing device from HomeKit."],
        "the removal names the device from its accessory name");
      assert.equal(double.platform.accessories.includes(accessory), false, "the accessory left the platform");
    } finally {

      await stop();
    }
  });

  test("an accessory with no configured device is named from its display name", async () => {

    const garage = cached("Garage Camera", "74ACB9000003", { mac: "74ACB9000003", nvr: CONTROLLER_MAC });
    const { api, double, logEntries, root, stop } = await logIn({ accessories: [garage] });

    try {

      const logged = logEntries.length;

      root.removeHomeKitDevice(garage);

      assert.deepEqual(logEntries.slice(logged).map(formatLogEntry), [PREFIX + "Garage Camera: Removing device from HomeKit."],
        "the removal names the accessory from its display name");
      assert.equal(double.platform.accessories.includes(garage), false, "the accessory left the platform");
      assert.deepEqual(unregistered(api), [garage], "the accessory was unregistered");
    } finally {

      await stop();
    }
  });

  test("a standalone device's removal tells the user to finish it in the Home app, and hands Homebridge nothing to unregister", async () => {

    const { api, double, logEntries, root, stop } = await logIn({ cameras: [PORCH], userOptions: ["Enable.Device.Standalone." + PORCH.mac] });

    try {

      const accessory = accessoryOf(double, PORCH.mac);

      assert.equal(accessory._associatedHAPAccessory.bridged, false, "the standalone camera was published outside the bridge");

      const logged = logEntries.length;

      root.removeHomeKitDevice(accessory);

      assert.deepEqual(logEntries.slice(logged).map(formatLogEntry), [PREFIX + "Porch Camera [Test Camera Model]: Removing camera from HomeKit. You will need to " +
        "manually delete the device in the Home app to complete the removal."], "the removal line carries the guidance");
      assert.equal(double.platform.accessories.includes(accessory), false, "the accessory left the platform");
      assert.deepEqual(unregistered(api), [], "nothing is unregistered");
    } finally {

      await stop();
    }
  });

  test("removing a doorbell removes its package camera with it", async () => {

    const { api, double, logEntries, root, stop } = await logIn({ cameras: [FRONT_DOOR] });

    try {

      const doorbell = accessoryOf(double, FRONT_DOOR.mac);
      const packageCamera = accessoryOf(double, FRONT_DOOR.mac + ".PackageCamera");
      const logged = logEntries.length;

      root.removeHomeKitDevice(doorbell);

      assert.deepEqual(logEntries.slice(logged).map(formatLogEntry), [PREFIX + "Front Door [Test Camera Model]: Removing camera from HomeKit."],
        "the removal logs the doorbell's line alone");
      assert.equal(double.platform.accessories.includes(doorbell) || double.platform.accessories.includes(packageCamera), false, "both accessories left the platform");
      assert.deepEqual(unregistered(api), [ doorbell, packageCamera ], "the doorbell and its package camera were unregistered");
    } finally {

      await stop();
    }
  });

  test("removing an unknown device removes the package camera that names its MAC", async () => {

    const parent = cached("Front Door", "74ACB9000001", { mac: "74ACB9000001", nvr: CONTROLLER_MAC });
    const packageCamera = cached("Front Door Package Camera", "74ACB9000001.PackageCamera", { nvr: CONTROLLER_MAC, packageCamera: "74ACB9000001" });
    const { api, double, logEntries, root, stop } = await logIn({ accessories: [ parent, packageCamera ] });

    try {

      const logged = logEntries.length;

      root.removeHomeKitDevice(parent);

      assert.deepEqual(logEntries.slice(logged).map(formatLogEntry), [PREFIX + "Front Door: Removing device from HomeKit."],
        "the removal logs the unknown device's line alone");
      assert.equal(double.platform.accessories.includes(parent) || double.platform.accessories.includes(packageCamera), false, "both accessories left the platform");
      assert.deepEqual(unregistered(api), [ parent, packageCamera ], "the device and the package camera were unregistered");
    } finally {

      await stop();
    }
  });

  test("removal cleans up the configured device, so its observers end", async () => {

    const { double, logEntries, root, stop, store } = await logIn({ cameras: [PORCH] });

    try {

      const observers = store.observerCount;
      const logged = logEntries.length;

      root.removeHomeKitDevice(accessoryOf(double, PORCH.mac));

      await settle();

      assert.deepEqual(logEntries.slice(logged).map(formatLogEntry), [PREFIX + "Porch Camera [Test Camera Model]: Removing camera from HomeKit."],
        "the removal logs its one line");
      assert.ok(store.observerCount < observers, "the camera's observers ended with its cleanup");
    } finally {

      await stop();
    }
  });

  test("removal retires the device from the event dispatcher, so its inflight motion is cleared", async () => {

    const { double, logEntries, root, stop } = await logIn({ cameras: [PORCH] });

    try {

      const device = root.getDeviceById(PORCH.id);

      assert.ok(device, "the root adopted the camera");

      root.events.motionEventHandler(device);

      assert.equal(root.events.hasInflightMotion(device.id), true, "the motion event is inflight");

      const logged = logEntries.length;

      root.removeHomeKitDevice(accessoryOf(double, PORCH.mac));

      assert.deepEqual(logEntries.slice(logged).map(formatLogEntry), [PREFIX + "Porch Camera [Test Camera Model]: Removing camera from HomeKit."],
        "the removal logs its one line");
      assert.equal(root.events.hasInflightMotion(device.id), false, "the retirement cleared the inflight motion");
    } finally {

      await stop();
    }
  });

  test("removal drops the device from the configured devices", async () => {

    const { double, logEntries, root, stop } = await logIn({ cameras: [PORCH] });

    try {

      const accessory = accessoryOf(double, PORCH.mac);

      assert.equal(root.configuredDevices.has(accessory.UUID), true, "the camera is configured");

      const logged = logEntries.length;

      root.removeHomeKitDevice(accessory);

      assert.deepEqual(logEntries.slice(logged).map(formatLogEntry), [PREFIX + "Porch Camera [Test Camera Model]: Removing camera from HomeKit."],
        "the removal logs its one line");
      assert.equal(root.configuredDevices.has(accessory.UUID), false, "the camera is no longer configured");
    } finally {

      await stop();
    }
  });

  /* A livestream episode a camera opens is closed by its recovery, and one the camera's removal leaves open is reclaimed with it. A controller reboot the root observes
   * makes the episode the camera opens a quiet one, the camera is removed with the episode still open and adopted again, and its recovery is then published: an
   * episode the removal reclaimed reads as a new, unclassified one, so the recovery is said at warn. Every episode this row opens is closed before it ends, so nothing
   * it published is left open on the process-global channels.
   */
  test("removal reclaims the livestream episode a removed camera left open", async () => {

    const { connection, double, logEntries, root, stop } = await logIn({ cameras: [PORCH] });
    const key = PORCH.id + ".livestream";

    try {

      connection.emit("controllerRebooted");

      const opened = logEntries.length;

      protectChannels.livestreamRecoveryStarted.publish({ attempts: 0, cameraId: PORCH.id, key, sinceLastSegmentMs: 0 });

      assert.deepEqual(logEntries.slice(opened).filter((entry) => entry.level === "warn").map(formatLogEntry), [],
        "the reboot the root observed made the episode a quiet one");

      root.removeHomeKitDevice(accessoryOf(double, PORCH.mac));

      assert.equal(root.addHomeKitDevice(PORCH), true, "the camera was adopted again");

      await settle();

      const recovered = logEntries.length;

      protectChannels.livestreamRecoveryRecovered.publish({ cameraId: PORCH.id, downtimeMs: 1000, key });

      assert.deepEqual(logEntries.slice(recovered).map((entry) => [ entry.level, formatLogEntry(entry) ]),
        [[ "warn", "Porch Camera [Test Camera Model]: The livestream has recovered after 1 s." ]], "the recovery of the reclaimed episode is said at warn");
    } finally {

      await stop();
    }
  });
});

describe("the controller root's client logger through a scheduled reboot", () => {

  // The cadence an enabled-without-a-value schedule waits, and the lines these rows drive the root's client logger with, each with the context the library attaches.
  const REBOOT_INTERVAL_MS = PROTECT_NVR_REBOOT_INTERVAL * 60 * 60 * 1000;
  const LIBRARY_ERROR = "A line the library logs at the error level.";
  const LIBRARY_WARN = "A line the library logs at the warn level.";
  const OVERDUE_LINE = "The Protect controller has not returned from its scheduled reboot.";

  // Log a root in and run its schedule to the moment the controller accepts the command. A genuine reboot drops the connection within seconds, so this one reads
  // unhealthy, which leaves the no-op confirmation inert and the outage the row's own to stand.
  async function acceptReboot(options: Parameters<typeof logIn>[0] = {}): Promise<LoggedInRoot> {

    const logged = await logIn(options);

    logged.root.reboot.schedule({ upSince: TEST_CLOCK_EPOCH });
    logged.clock.advance(REBOOT_INTERVAL_MS);

    await settle();

    logged.connection.isHealthy = false;

    return logged;
  }

  // Say one line at each gated level through the root's client logger, as the library says them.
  function sayBoth(clientLog: ProtectLogging): void {

    clientLog.warn(LIBRARY_WARN, { level: "warn" });
    clientLog.error(LIBRARY_ERROR, { level: "error" });
  }

  test("with no reboot in progress, a warn and an error show at once", async () => {

    const { clientLog, logEntries, root, stop } = await logIn();

    try {

      assert.equal(root.reboot.isRebootOnTime, false, "nothing holds the gate");

      sayBoth(clientLog);

      assert.equal(logCount(logEntries, "warn", LIBRARY_WARN), 1, "the warn shows");
      assert.equal(logCount(logEntries, "error", LIBRARY_ERROR), 1, "and so does the error");
    } finally {

      await stop();
    }
  });

  test("a reboot on time shows neither level and logs no line of the plugin's, and each still echoes to debug", async () => {

    const { clientLog, clock, connection, logEntries, stop } = await acceptReboot();

    try {

      connection.isRebooting = true;
      sayBoth(clientLog);
      clock.advance(REBOOT_EXPECTED_RETURN_MS - 1);

      assert.equal(logCount(logEntries, "warn", LIBRARY_WARN), 0, "the warn is hidden");
      assert.equal(logCount(logEntries, "error", LIBRARY_ERROR), 0, "and so is the error");
      assert.equal(logCount(logEntries, "warn", OVERDUE_LINE), 0, "and the plugin has nothing to say yet");
      assert.equal(logCount(logEntries, "debug", LIBRARY_WARN), 1, "the warn still reaches debug");
      assert.equal(logCount(logEntries, "debug", LIBRARY_ERROR), 1, "and so does the error");
    } finally {

      await stop();
    }
  });

  test("a reboot past the bound logs the plugin's line once, replays nothing, and shows each level afterward", async () => {

    const { clientLog, clock, connection, logEntries, stop } = await acceptReboot();

    try {

      connection.isRebooting = true;
      sayBoth(clientLog);
      clock.advance(REBOOT_EXPECTED_RETURN_MS);

      assert.equal(logCount(logEntries, "warn", OVERDUE_LINE), 1, "the bound logs the plugin's line");
      assert.equal(logCount(logEntries, "warn", LIBRARY_WARN), 0, "and no hidden warn comes back with it");
      assert.equal(logCount(logEntries, "error", LIBRARY_ERROR), 0, "nor any hidden error");

      sayBoth(clientLog);

      assert.equal(logCount(logEntries, "warn", LIBRARY_WARN), 1, "a warn past the bound shows");
      assert.equal(logCount(logEntries, "error", LIBRARY_ERROR), 1, "and so does an error, a refused sign-in among them");

      clock.advance(REBOOT_EXPECTED_RETURN_MS);

      assert.equal(logCount(logEntries, "warn", OVERDUE_LINE), 1, "and the plugin's line is said once");
    } finally {

      await stop();
    }
  });

  // The bound reads the verdict, so each fact on its own counts as a controller still out, and a connection that has concluded neither does not.
  for(const { expected, facts, name } of [

    { expected: 1, facts: { isLost: true, isRebooting: false }, name: "lost alone" },
    { expected: 1, facts: { isLost: false, isRebooting: true }, name: "rebooting alone" },
    { expected: 0, facts: { isLost: false, isRebooting: false }, name: "neither lost nor rebooting" }
  ]) {

    test("the bound with the controller " + name + " logs " + String(expected) + " line", async () => {

      const { clock, connection, logEntries, stop } = await acceptReboot();

      try {

        Object.assign(connection, facts);
        clock.advance(REBOOT_EXPECTED_RETURN_MS);

        assert.equal(logCount(logEntries, "warn", OVERDUE_LINE), expected);
      } finally {

        await stop();
      }
    });
  }

  test("a recovery before the bound logs nothing, a warn after it shows at once, and a later loss meets no bound", async () => {

    const { clientLog, clock, connection, logEntries, root, stop } = await acceptReboot();

    try {

      connection.isRebooting = true;
      connection.transition({ from: "healthy", to: "lost" });

      await settle();

      connection.isHealthy = true;
      connection.isRebooting = false;
      connection.transition({ from: "lost", to: "healthy" });

      await settle();

      assert.equal(root.phase, "running", "the recovery edge concluded the reboot");
      assert.equal(root.reboot.isRebootOnTime, false, "and opened the gate");

      sayBoth(clientLog);

      assert.equal(logCount(logEntries, "warn", LIBRARY_WARN), 1, "a warn after the recovery shows at once");
      assert.equal(logCount(logEntries, "error", LIBRARY_ERROR), 1, "and so does an error");

      connection.isLost = true;
      clock.advance(REBOOT_EXPECTED_RETURN_MS);

      assert.equal(logCount(logEntries, "warn", OVERDUE_LINE), 0, "a later loss meets no bound");
    } finally {

      await stop();
    }
  });

  test("a controller that never restarted opens the gate at the grace, and a later loss meets no bound", async () => {

    const { clientLog, clock, connection, logEntries, root, stop } = await logIn();

    try {

      root.reboot.schedule({ upSince: TEST_CLOCK_EPOCH });
      clock.advance(REBOOT_INTERVAL_MS);

      await settle();

      assert.equal(root.reboot.isRebootOnTime, true, "the accepted command closed the gate");

      clock.advance(PROTECT_NVR_REBOOT_CONFIRM_GRACE_MS);

      assert.equal(root.phase, "running", "the no-op confirmation found a healthy controller and resumed");
      assert.equal(root.reboot.isRebootOnTime, false, "and opened the gate");

      sayBoth(clientLog);

      assert.equal(logCount(logEntries, "warn", LIBRARY_WARN), 1, "a warn after it shows at once");
      assert.equal(logCount(logEntries, "error", LIBRARY_ERROR), 1, "and so does an error");

      connection.isLost = true;
      clock.advance(REBOOT_EXPECTED_RETURN_MS);

      assert.equal(logCount(logEntries, "warn", OVERDUE_LINE), 0, "a later loss meets no bound");
    } finally {

      await stop();
    }
  });

  test("a command in flight shows each level, in the phase that hides nothing of it", async () => {

    const { clientLog, clock, logEntries, root, stop } = await logIn();
    const { promise, resolve }: PromiseWithResolvers<void> = Promise.withResolvers();

    try {

      root.client.reboot = async (): Promise<void> => promise;
      root.reboot.schedule({ upSince: TEST_CLOCK_EPOCH });
      clock.advance(REBOOT_INTERVAL_MS);

      await settle();

      assert.equal(root.phase, "rebooting", "the attempt moved the phase ahead of the command");

      sayBoth(clientLog);

      assert.equal(logCount(logEntries, "warn", LIBRARY_WARN), 1, "the controller has accepted nothing, so a warn shows");
      assert.equal(logCount(logEntries, "error", LIBRARY_ERROR), 1, "and so does an error");

      resolve();

      await settle();

      sayBoth(clientLog);

      assert.equal(logCount(logEntries, "warn", LIBRARY_WARN), 1, "the accepted command hides the next warn");
      assert.equal(logCount(logEntries, "error", LIBRARY_ERROR), 1, "and the next error");
    } finally {

      resolve();

      await stop();
    }
  });

  test("a refused command shows each level, on the way out of the phase and past it", async () => {

    const { clientLog, clock, logEntries, root, stop } = await logIn();
    const { promise, reject }: PromiseWithResolvers<void> = Promise.withResolvers();

    try {

      root.client.reboot = async (): Promise<void> => promise;
      root.reboot.schedule({ upSince: TEST_CLOCK_EPOCH });
      clock.advance(REBOOT_INTERVAL_MS);

      await settle();

      reject(new Error("The controller refused the command."));

      await settle();

      assert.equal(root.phase, "running", "the attempt rolled back");
      assert.ok(loggedAt(logEntries, "error", "Unable to reboot the Protect controller: The controller refused the command."), "and said so");

      sayBoth(clientLog);

      assert.equal(logCount(logEntries, "warn", LIBRARY_WARN), 1, "a warn shows");
      assert.equal(logCount(logEntries, "error", LIBRARY_ERROR), 1, "and so does an error");
    } finally {

      await stop();
    }
  });

  // A recovery during the command's flight ends the reboot ahead of the command's answer, with no key yet for it to clear, so the answer must arm none. Armed anyway, the
  // gate would hide the library's lines with the phase running, for a reboot that is over, and nothing but the bound would open it.
  test("a recovery during the command's flight leaves the gate open once the command is accepted, and meets no bound", async () => {

    const { clientLog, clock, connection, logEntries, root, stop } = await logIn();
    const { promise, resolve }: PromiseWithResolvers<void> = Promise.withResolvers();

    try {

      root.client.reboot = async (): Promise<void> => promise;
      root.reboot.schedule({ upSince: TEST_CLOCK_EPOCH });
      clock.advance(REBOOT_INTERVAL_MS);

      await settle();

      assert.equal(root.phase, "rebooting", "the attempt moved the phase ahead of the command");

      connection.isHealthy = false;
      connection.transition({ from: "healthy", to: "lost" });

      await settle();

      connection.isHealthy = true;
      connection.transition({ from: "lost", to: "healthy" });

      await settle();

      assert.equal(root.phase, "running", "the recovery edge ended the reboot ahead of the command's answer");

      resolve();

      await settle();

      assert.equal(root.reboot.isRebootOnTime, false, "the accepted command armed nothing");

      sayBoth(clientLog);

      assert.equal(logCount(logEntries, "warn", LIBRARY_WARN), 1, "so a warn shows");
      assert.equal(logCount(logEntries, "error", LIBRARY_ERROR), 1, "and so does an error");

      connection.isLost = true;
      clock.advance(REBOOT_EXPECTED_RETURN_MS);

      assert.equal(logCount(logEntries, "warn", OVERDUE_LINE), 0, "and a later loss meets no bound");

      let commands = 0;

      connection.isLost = false;
      root.client.reboot = async (): Promise<void> => {

        commands++;
      };

      clock.advance(REBOOT_INTERVAL_MS);

      await settle();

      assert.equal(commands, 1, "and the next cycle still comes round");
    } finally {

      resolve();

      await stop();
    }
  });

  // An MQTT client's end holds the terminal phase back while the final words go out, and the expected return has already ended by then, so this is the one window where
  // the gate's opening shows: nothing has been torn down yet, so a line the library says here is a true one.
  test("a shutdown in the middle of a reboot, an MQTT client still ending, opens the gate with a warn and an error showing", async () => {

    const mqtt = new TestMqttClient({ log: capturingLog() });

    mqtt.connected = true;

    const { clientLog, connection, double, logEntries, root, stop } = await acceptReboot({ mqtt });
    const { promise, resolve }: PromiseWithResolvers<void> = Promise.withResolvers();

    try {

      connection.isRebooting = true;

      assert.equal(root.reboot.isRebootOnTime, true, "the accepted command closed the gate");

      mqtt.onEnd(async (): Promise<void> => promise);
      double.platform.api.emit(APIEvent.SHUTDOWN);

      assert.equal(root.phase, "rebooting", "the client's end holds the terminal phase back");
      assert.equal(root.reboot.isRebootOnTime, false, "with the gate already open");

      sayBoth(clientLog);

      assert.equal(logCount(logEntries, "warn", LIBRARY_WARN), 1, "so a warn shows");
      assert.equal(logCount(logEntries, "error", LIBRARY_ERROR), 1, "and so does an error");
    } finally {

      resolve();

      await stop();
    }
  });

  test("a shutdown in the middle of a reboot shows a warn, hides an error and meets no bound", async () => {

    const { clientLog, clock, connection, logEntries, root, stop } = await acceptReboot();

    try {

      connection.isRebooting = true;

      await stop();

      assert.equal(root.phase, "shuttingDown", "the shutdown ran");
      assert.equal(root.reboot.isRebootOnTime, false, "and opened the gate");

      sayBoth(clientLog);

      assert.equal(logCount(logEntries, "warn", LIBRARY_WARN), 1, "a warn shows");
      assert.equal(logCount(logEntries, "error", LIBRARY_ERROR), 0, "and an error stays hidden in the terminal phase");

      clock.advance(REBOOT_EXPECTED_RETURN_MS);

      assert.equal(logCount(logEntries, "warn", OVERDUE_LINE), 0, "no bound survived the shutdown");
    } finally {

      await stop();
    }
  });
});

describe("the controller root's availability verdict", () => {

  // The root reads the library's conclusions about the connection, never its health, and its shared removal tail is what lets go of an accessory's claim. Each is the
  // real root over the double's platform, its connection levers moved directly.
  test("the verdict reads the connection's loss and reboot facts, never its health, and the removal tail releases a claim", async () => {

    const nvrConfig: ProtectNvrConfig = { ...makeNvrConfig(), firmwareVersion: "4.3.6", upSince: TEST_CLOCK_EPOCH, version: "6.1.79" };
    const store = new TestStateStore(makeProtectState({ nvr: nvrConfig }));
    const { controller, nvr: double } = makeTestNvr({ store });
    const client = makeConnectedClient({ nvrConfig, store });
    const { platform, shutdown } = makeRootPlatform(double);
    const root = new ProtectNvr(platform, double.config, async (): Promise<ProtectClient> => client);
    const connection = client.connection as unknown as TestConnection;

    try {

      await root.login();
      await settle();

      assert.equal(root.isAvailable, true, "a connected controller is available");

      connection.isHealthy = false;

      assert.equal(root.isAvailable, true, "a degraded connection that has concluded nothing leaves it available");

      connection.isLost = true;

      assert.equal(root.isAvailable, false, "a concluded loss does not");

      connection.isLost = false;
      connection.isRebooting = true;

      assert.equal(root.isAvailable, false, "and neither does a reboot");

      connection.isRebooting = false;
      connection.isHealthy = true;

      const accessory = makeTestAccessory("Test Camera", "74ACB9000001");

      accessory.context = { mac: "74ACB9000001", nvr: nvrConfig.mac };
      restoreAccessories(double, [accessory]);
      double.platform.claimAccessory(accessory, root);

      root.removeAccessoryFromHomeKit(accessory);

      assert.equal(double.platform.claims.has(accessory.UUID), false, "the shared removal tail released the claim");
    } finally {

      shutdown();
      controller.abort();

      await settle();
    }
  });
});
