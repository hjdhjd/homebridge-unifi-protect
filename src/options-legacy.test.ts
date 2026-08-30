/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * options-legacy.test.ts: The translation of retired per-member feature options into the value options that carry them, as a fixture table of exact input/output
 * pairs.
 *
 * Two halves are asserted separately because they answer different questions. The ANALYSIS says what the engine is built on and which families still need the
 * overlay, and its output is compared entry for entry - a translation that emitted an extra entry, dropped a user's unrelated text, or reordered the array would
 * change what the engine resolves. The OVERLAY says what a reader with its own device and controller in hand gets back, which is where the old grammar's exact
 * three-level precedence lives, and it is the half that can differ from the engine's post-analysis reading: a rewrite composed without topology cannot tell a
 * controller identifier from a device one, so the rows that pair a controller scope with a device scope pin the two answers separately and say which is which.
 *
 * This file names the retired option grammar throughout, deliberately: it is the only place that still knows those names existed, which is the exemption the
 * zero-residue sweeps carry for it.
 */
import { analyzeLegacyFeatureOptions, resolveLegacySelection } from "./options-legacy.ts";
import { describe, test } from "node:test";
import assert from "node:assert/strict";

// The controller these rows resolve against, a sibling controller that proves one controller's entries never answer for another, and two cameras beneath the first.
const CONTROLLER = "AABBCCDDEEFF";
const OTHER_CONTROLLER = "112233445566";
const CAMERA = "0123456789AB";
const OTHER_CAMERA = "BA9876543210";

// The tier picker's domain, in the spelling the catalog offers it.
const TIERS = [ "High", "Medium", "Low" ];

describe("the legacy analysis", () => {

  // A configuration that names nothing retired is handed back untouched, reference contents and order alike, with no family overlaid and nothing to narrate. This is
  // the converged steady state every migrated installation reaches, and it is what makes the overlay cost nothing there.
  test("a canonical configuration passes through with no families and nothing translated", () => {

    const options = [ "Enable.Video.Rtsp.Only=High", "Disable.Device", "Enable.Motion.SmartDetect" ];
    const analysis = analyzeLegacyFeatureOptions(options);

    assert.deepEqual(analysis.engineOptions, options, "every entry survives in order");
    assert.equal(analysis.families.size, 0, "no family needs the overlay");
    assert.deepEqual(analysis.translated, [], "nothing was translated");
  });

  // Text the analysis cannot account for is the user's own, so it survives byte for byte. The analysis runs on every boot over every configuration, and a malformed
  // entry has to pass through rather than throw or be quietly rewritten.
  test("entries the analysis cannot account for pass through byte-verbatim", () => {

    const options = [ "", "NotAnAction.Video.Rtsp.Only.High", "Enable", "Enable.Some.Option.Nobody.Declares", "Disable.Video.Rtsp.Only.Purple" ];
    const analysis = analyzeLegacyFeatureOptions(options);

    assert.deepEqual(analysis.engineOptions, options, "the whole array survives untouched");
    assert.deepEqual(analysis.translated, [], "nothing was translated");
  });

  // The plain global case: one retired per-tier entry composes the canonical pin entry, the retired entry leaves the engine's view, and the family joins the overlay.
  test("a global per-tier entry composes the canonical pin", () => {

    const analysis = analyzeLegacyFeatureOptions(["Enable.Video.Rtsp.Only.High"]);

    assert.deepEqual(analysis.engineOptions, ["Enable.Video.Rtsp.Only=High"], "the retired entry is replaced by the canonical pin");
    assert.deepEqual([...analysis.families], ["rtspPin"], "the direct-RTSP family is overlaid");
    assert.deepEqual(analysis.translated, ["Enable.Video.Rtsp.Only.High"], "the original entry is named for the startup line");
  });

  // The device-scoped case, which the engine reading alone cannot rescue: a scoped retired entry registers a key that addresses no current option at all. The
  // canonical entry the analysis composes is what makes the pin resolve at that camera again.
  test("a device-scoped per-tier entry composes a scoped canonical pin", () => {

    const analysis = analyzeLegacyFeatureOptions(["Enable.Video.Rtsp.Only.Medium." + CAMERA]);

    assert.deepEqual(analysis.engineOptions, ["Enable.Video.Rtsp.Only." + CAMERA + "=Medium"], "the scoped pin is stated at the camera's own scope");
    assert.deepEqual([...analysis.families], ["rtspPin"], "the direct-RTSP family is overlaid");
  });

  /* Two tiers enabled at once resolve to the better of them, which is what the retired reader did: it walked the tiers from low to high and kept assigning, so the
   * highest quality named won regardless of the order the entries were written in. The engine's own reading of these two entries is first-wins over the array, which
   * would answer Low here - the composition is what corrects it.
   */
  test("a multi-tier configuration resolves to the best quality named, whatever the entry order", () => {

    const analysis = analyzeLegacyFeatureOptions([ "Enable.Video.Rtsp.Only.Low", "Enable.Video.Rtsp.Only.High" ]);

    assert.deepEqual(analysis.engineOptions, ["Enable.Video.Rtsp.Only=High"], "the high tier wins over the low one written before it");
    assert.deepEqual(analysis.translated, [ "Enable.Video.Rtsp.Only.Low", "Enable.Video.Rtsp.Only.High" ], "both retired entries are named");
  });

  // The two pin families translate independently: each carries its own retired names, its own option, and its own overlay membership.
  test("the two pin families translate side by side", () => {

    const analysis = analyzeLegacyFeatureOptions([ "Enable.Video.Rtsp.Only.High", "Enable.Video.Timeshift.Only.Low" ]);

    assert.deepEqual(analysis.engineOptions, [ "Enable.Video.Rtsp.Only=High", "Enable.Video.Timeshift.Only=Low" ], "each family states its own pin");
    assert.deepEqual([...analysis.families].toSorted(), [ "rtspPin", "timeshiftPin" ], "both families are overlaid");
  });

  // A scope that turns off every tier a broader scope turned on has something of its own to say, and the plain scoped Disable is what says it: without one, the camera
  // would inherit the global pin the user had switched off for it.
  test("a scope that disables every tier a broader scope enables composes the plain Disable", () => {

    const analysis = analyzeLegacyFeatureOptions([ "Enable.Video.Rtsp.Only.High", "Disable.Video.Rtsp.Only.High." + CAMERA ]);

    assert.deepEqual(analysis.engineOptions, [ "Enable.Video.Rtsp.Only=High", "Disable.Video.Rtsp.Only." + CAMERA ], "the camera's pin is turned off explicitly");
  });

  // A scope whose entries merely restate what it already inherits states nothing: a retired Disable of a tier nobody enabled is the default said twice, and emitting
  // an entry for it would manufacture configuration out of nothing.
  test("a scope restating what it already inherits composes nothing", () => {

    const analysis = analyzeLegacyFeatureOptions(["Disable.Video.Rtsp.Only.High." + CAMERA]);

    assert.deepEqual(analysis.engineOptions, [], "the retired entry leaves and nothing replaces it");
    assert.deepEqual(analysis.translated, ["Disable.Video.Rtsp.Only.High." + CAMERA], "the entry is still named for the startup line");
  });

  /* A canonical value the user wrote is evidence that they have adopted the current grammar, so it wins outright: the retired entries beside it leave the engine's
   * view, nothing is composed to compete with the value, and the family does NOT join the overlay. This is the row that tells the ruled composition apart from a
   * union, an intersection, or a silent legacy override - each of those would let the retired entry keep steering.
   */
  test("a canonical value supersedes the retired entries of its family outright", () => {

    const analysis = analyzeLegacyFeatureOptions([ "Enable.Video.Rtsp.Only.High", "Enable.Video.Rtsp.Only=Low" ]);

    assert.deepEqual(analysis.engineOptions, ["Enable.Video.Rtsp.Only=Low"], "the user's own value is what the engine is left with");
    assert.equal(analysis.families.size, 0, "a superseded family is not overlaid");
    assert.deepEqual(analysis.translated, ["Enable.Video.Rtsp.Only.High"], "the superseded entry is still named for the startup line");
  });

  // Supersession is per family: a canonical value for one pin says nothing about the other, so the second family keeps its overlay and its composition.
  test("supersession does not reach across families", () => {

    const analysis = analyzeLegacyFeatureOptions([ "Enable.Video.Rtsp.Only=Low", "Enable.Video.Timeshift.Only.High" ]);

    assert.deepEqual(analysis.engineOptions, [ "Enable.Video.Rtsp.Only=Low", "Enable.Video.Timeshift.Only=High" ], "only the timeshift family composes");
    assert.deepEqual([...analysis.families], ["timeshiftPin"], "only the timeshift family is overlaid");
  });
});

describe("the legacy occupancy translation", () => {

  /* The plain global case. The retired per-type options carried mixed defaults - face and person on, everything else off - so a configuration that enables vehicle
   * beside the master composes all three, and the composition states them in the type table's own order.
   */
  test("global per-type entries compose the master's selection in wire values", () => {

    const analysis = analyzeLegacyFeatureOptions([ "Enable.Motion.OccupancySensor", "Enable.Motion.OccupancySensor.Vehicle" ]);

    assert.deepEqual(analysis.engineOptions, ["Enable.Motion.OccupancySensor=face,person,vehicle"], "the composed selection carries the wire values");
    assert.deepEqual([...analysis.families], ["occupancy"], "the occupancy family is overlaid");
    assert.deepEqual(analysis.translated, [ "Enable.Motion.OccupancySensor", "Enable.Motion.OccupancySensor.Vehicle" ], "both entries are named");
  });

  // A retired Disable subtracts a default-on type, which is the whole of how a user narrowed occupancy before the selection was a picker.
  test("a retired per-type Disable subtracts a default-on type", () => {

    const analysis = analyzeLegacyFeatureOptions([ "Enable.Motion.OccupancySensor", "Disable.Motion.OccupancySensor.Face" ]);

    assert.deepEqual(analysis.engineOptions, ["Enable.Motion.OccupancySensor=person"], "face is subtracted and person stands");
  });

  /* Every type switched off with occupancy still on is a real state, and it survives as the explicit empty payload - the spelling that says "the user emptied this
   * selection" rather than "the user said nothing", which is what a bare enable would read as and would resolve back to face and person.
   */
  test("an all-types-off selection with the master on survives as the explicit empty payload", () => {

    const analysis = analyzeLegacyFeatureOptions([ "Enable.Motion.OccupancySensor", "Disable.Motion.OccupancySensor.Face", "Disable.Motion.OccupancySensor.Person" ]);

    assert.deepEqual(analysis.engineOptions, ["Enable.Motion.OccupancySensor="], "the emptied selection is stated explicitly");
  });

  /* A dormant scope: per-type entries under a master the user never enabled. The selection was never live, and no entry form carries a selection under a Disable, so
   * it is dropped. The default-off master is already saying occupancy is off, so nothing needs to be composed to keep saying it - and the dropped entries are named
   * in the startup line, which is where a user learns their old per-type settings were read and set aside.
   */
  test("per-type entries under a disabled master are dropped and named", () => {

    const analysis = analyzeLegacyFeatureOptions(["Enable.Motion.OccupancySensor.Vehicle"]);

    assert.deepEqual(analysis.engineOptions, [], "nothing is composed for a selection that was never live");
    assert.deepEqual(analysis.translated, ["Enable.Motion.OccupancySensor.Vehicle"], "the dropped entry is named for the startup line");
  });

  /* The scoped bare master, which is this family's corrupting shape: the current catalog reads the trailing identifier of `Enable.Motion.OccupancySensor.<mac>` as
   * the option's GLOBAL value, so left alone it would enable occupancy for every device on every controller with a MAC address standing in as the selection. The
   * rewrite says what the user meant - occupancy on at that camera, with that camera's composed selection - and says nothing globally.
   */
  test("a scoped bare master is rewritten into the canonical scoped form", () => {

    const analysis = analyzeLegacyFeatureOptions(["Enable.Motion.OccupancySensor." + CAMERA]);

    assert.deepEqual(analysis.engineOptions, ["Enable.Motion.OccupancySensor." + CAMERA + "=face,person"], "the scoped enable keeps its scope and states its selection");
    assert.deepEqual([...analysis.families], ["occupancy"], "the occupancy family is overlaid");
  });

  // A GLOBAL bare master with no per-type entries anywhere is a spelling valid in both eras, so it is left exactly as written and nothing is translated at all.
  test("a global bare master with no per-type entries passes through untouched", () => {

    const analysis = analyzeLegacyFeatureOptions(["Enable.Motion.OccupancySensor"]);

    assert.deepEqual(analysis.engineOptions, ["Enable.Motion.OccupancySensor"], "the entry stands as written");
    assert.equal(analysis.families.size, 0, "there is nothing for the overlay to carry");
    assert.deepEqual(analysis.translated, [], "nothing was translated");
  });

  /* The sibling negative control. `Enable.Motion.OccupancySensor.Duration` is today's way to switch the occupancy duration option on as a toggle, and its address is
   * shaped exactly like a master scoped to an identifier called "Duration". It must pass through byte-verbatim: rewriting it would compose a phantom scope and take
   * the user's duration setting with it. The synthetic catalog declares the sibling for precisely this reason, so the engine's own arbitration settles which option
   * the address belongs to.
   */
  test("a bare enable of the duration sibling is never read as a scoped master", () => {

    const options = [ "Enable.Motion.OccupancySensor.Duration", "Enable.Motion.OccupancySensor", "Enable.Motion.OccupancySensor.Vehicle" ];
    const analysis = analyzeLegacyFeatureOptions(options);

    assert.ok(analysis.engineOptions.includes("Enable.Motion.OccupancySensor.Duration"), "the sibling entry survives byte-verbatim");
    assert.ok(!analysis.translated.includes("Enable.Motion.OccupancySensor.Duration"), "the sibling is not something the translation acted on");
    assert.deepEqual(analysis.engineOptions, [ "Enable.Motion.OccupancySensor.Duration", "Enable.Motion.OccupancySensor=face,person,vehicle" ],
      "the sibling stands beside the composed selection rather than being folded into it");
  });

  /* The supersede pair the mixed-configuration rule turns on. The common legacy shape is a bare master plus per-type entries and NO canonical value, and it must keep
   * resolving through the overlay - the bare enable of the option's own kept name spells the same thing in both eras and is not evidence of anything. Adding a
   * canonical value is: it supersedes the per-type entries outright, and the startup line names what it set aside.
   */
  test("a bare master enable never triggers supersession, and a canonical value does", () => {

    const legacy = analyzeLegacyFeatureOptions([ "Enable.Motion.OccupancySensor", "Enable.Motion.OccupancySensor.Vehicle" ]);

    assert.deepEqual([...legacy.families], ["occupancy"], "the common legacy shape keeps its overlay");

    const superseded = analyzeLegacyFeatureOptions([ "Enable.Motion.OccupancySensor.Vehicle", "Enable.Motion.OccupancySensor=vehicle" ]);

    assert.deepEqual(superseded.engineOptions, ["Enable.Motion.OccupancySensor=vehicle"], "the user's own value is what the engine is left with");
    assert.equal(superseded.families.size, 0, "a superseded family is not overlaid");
    assert.deepEqual(superseded.translated, ["Enable.Motion.OccupancySensor.Vehicle"], "the superseded entry is named for the startup line");
  });
});

describe("the legacy object-sensor translation", () => {

  /* This family kept its option name and never had per-type entries, so it has exactly one corrupting shape: the scoped bare master, whose trailing identifier the
   * current catalog reads as the option's global value. The rewrite says all-choices, which is exact - switching the object sensors on at a camera has always meant a
   * contact sensor for every type that camera delivers - and being exact is why this family needs no overlay behind it.
   */
  test("a scoped bare master is rewritten to the all-choices selection at that scope", () => {

    const analysis = analyzeLegacyFeatureOptions(["Enable.Motion.SmartDetect.ObjectSensors." + CAMERA]);

    assert.deepEqual(analysis.engineOptions, ["Enable.Motion.SmartDetect.ObjectSensors." + CAMERA + "=*"], "the scoped enable covers every type that camera delivers");
    assert.equal(analysis.families.size, 0, "the rewrite is exact, so nothing is overlaid");
    assert.deepEqual(analysis.translated, ["Enable.Motion.SmartDetect.ObjectSensors." + CAMERA], "the rewritten entry is named for the startup line");
  });

  // A global bare enable is a spelling valid in both eras and stands as written; the current catalog's own all-choices default is what makes it still mean everything.
  test("a global bare master passes through untouched", () => {

    const analysis = analyzeLegacyFeatureOptions(["Enable.Motion.SmartDetect.ObjectSensors"]);

    assert.deepEqual(analysis.engineOptions, ["Enable.Motion.SmartDetect.ObjectSensors"], "the entry stands as written");
    assert.deepEqual(analysis.translated, [], "nothing was translated");
  });

  /* The plate-sibling negative control, which is the same hazard shape the occupancy duration sibling carries. `Enable.Motion.SmartDetect.ObjectSensors.LicensePlate`
   * is today's way to switch the plate list on as a toggle, and its address is shaped exactly like the object-sensor master scoped to an identifier called
   * "LicensePlate". Without the sibling declared, the rewrite would corrupt it into a phantom device-scoped all-choices entry and take the user's plate sensors with
   * it. The value-bearing dotted form is structurally immune - its embedded dot cannot be a scope identifier - so the bare form is the one that needs the control.
   */
  test("a bare enable of the plate sibling is never read as a scoped master", () => {

    const options = [ "Enable.Motion.SmartDetect.ObjectSensors.LicensePlate", "Enable.Motion.SmartDetect.ObjectSensors." + CAMERA ];
    const analysis = analyzeLegacyFeatureOptions(options);

    assert.deepEqual(analysis.engineOptions, [ "Enable.Motion.SmartDetect.ObjectSensors.LicensePlate",
      "Enable.Motion.SmartDetect.ObjectSensors." + CAMERA + "=*" ], "the sibling survives byte-verbatim beside the rewritten scoped master");
    assert.deepEqual(analysis.translated, ["Enable.Motion.SmartDetect.ObjectSensors." + CAMERA], "only the scoped master was acted on");
  });

  // Supersession reaches this family too: a canonical value the user wrote is their own selection, and the retired scoped enable beside it is a leftover.
  test("a canonical value supersedes a scoped bare master", () => {

    const analysis = analyzeLegacyFeatureOptions([ "Enable.Motion.SmartDetect.ObjectSensors." + CAMERA, "Enable.Motion.SmartDetect.ObjectSensors=person" ]);

    assert.deepEqual(analysis.engineOptions, ["Enable.Motion.SmartDetect.ObjectSensors=person"], "the user's own value is what the engine is left with");
  });
});

describe("the legacy fob translation", () => {

  // The six retired per-button options all defaulted ON, so hiding one meant disabling its own option and the composition of what remains is the five that stand.
  test("a global per-button Disable composes the five buttons that remain", () => {

    const analysis = analyzeLegacyFeatureOptions(["Disable.Fob.Button.Panic"]);

    assert.deepEqual(analysis.engineOptions, ["Enable.Fob.Buttons=arm,night,disarm,right,left"], "the composition names the surviving buttons in table order");
    assert.deepEqual([...analysis.families], ["fobButtons"], "the fob family is overlaid");
  });

  // The same shape at a fob's own scope, which the current catalog cannot read at all on its own: the retired scoped entry addresses no declared option.
  test("a device-scoped per-button Disable composes that fob's own selection", () => {

    const analysis = analyzeLegacyFeatureOptions(["Disable.Fob.Button.Panic." + CAMERA]);

    assert.deepEqual(analysis.engineOptions, ["Enable.Fob.Buttons." + CAMERA + "=arm,night,disarm,right,left"], "the fob's own scope states its own selection");
  });

  /* Every button disabled at a scope is an empty selection, and for this family the empty selection and a disabled option coincide - either way the fob exposes no
   * button services at all - so the plain Disable says it exactly, with no dependence on how an empty payload reads.
   */
  test("a scope with every button disabled composes the plain Disable", () => {

    const analysis = analyzeLegacyFeatureOptions([ "Disable.Fob.Button.Arm", "Disable.Fob.Button.Night", "Disable.Fob.Button.Disarm", "Disable.Fob.Button.Panic",
      "Disable.Fob.Button.Right", "Disable.Fob.Button.Left" ]);

    assert.deepEqual(analysis.engineOptions, ["Disable.Fob.Buttons"], "no button survives, which the plain Disable states");
  });

  // A global subtraction layers with a device-scoped one: the fob's own scope composes BOTH, since the global entry still resolves beneath it.
  test("a globally hidden button stays hidden at a fob scope whose own entries touch a different button", () => {

    const analysis = analyzeLegacyFeatureOptions([ "Disable.Fob.Button.Panic", "Disable.Fob.Button.Left." + CAMERA ]);

    assert.deepEqual(analysis.engineOptions, [ "Enable.Fob.Buttons=arm,night,disarm,right,left",
      "Enable.Fob.Buttons." + CAMERA + "=arm,night,disarm,right" ], "the fob's scope composes its own subtraction on top of the global one");
  });
});

describe("the legacy relay translation", () => {

  /* This family's retired entries stay in the engine's view exactly as written, which is the one family that works that way. Stating what a per-output subtraction
   * leaves standing takes the relay's live output list, and a configuration string does not carry it - so nothing is composed here and the overlay is what gives the
   * entries their meaning, over each relay's own outputs. The engine reads them as entries for an option it does not declare and acts on none of them.
   */
  test("retired per-output entries pass through untouched while the family joins the overlay", () => {

    const analysis = analyzeLegacyFeatureOptions(["Disable.Relay.Output.2"]);

    assert.deepEqual(analysis.engineOptions, ["Disable.Relay.Output.2"], "the entry stays exactly where it was");
    assert.deepEqual([...analysis.families], ["relayOutputs"], "the relay family is overlaid");
    assert.deepEqual(analysis.translated, ["Disable.Relay.Output.2"], "the overlaid entry is named for the startup line");
  });

  // A canonical selection supersedes them, so the family leaves the overlay and the retired entry stops meaning anything at all.
  test("a canonical selection supersedes the retired per-output entries", () => {

    const analysis = analyzeLegacyFeatureOptions([ "Disable.Relay.Output.2", "Enable.Relay.Outputs=1,2,3" ]);

    assert.deepEqual(analysis.engineOptions, [ "Disable.Relay.Output.2", "Enable.Relay.Outputs=1,2,3" ], "neither entry is rewritten");
    assert.equal(analysis.families.size, 0, "a superseded family is not overlaid, so the retired entry no longer answers for anything");
  });
});

describe("the legacy plate translation", () => {

  /* Plates are the one retired grammar that lived inside a value rather than in option names: the list separated its entries with hyphens. A plate could never itself
   * contain a hyphen under that grammar, so a value carrying one and no comma is unambiguously a list and the rewrite is exact. The option's own name and scope are
   * untouched; only the value re-composes.
   */
  test("a hyphen-separated plate list re-composes into the shared list grammar", () => {

    const analysis = analyzeLegacyFeatureOptions(["Enable.Motion.SmartDetect.ObjectSensors.LicensePlate.ABC123-XYZ789"]);

    assert.deepEqual(analysis.engineOptions, ["Enable.Motion.SmartDetect.ObjectSensors.LicensePlate=ABC123,XYZ789"], "the plates are joined by the list delimiter");
    assert.equal(analysis.families.size, 0, "the rewrite is exact, so nothing is overlaid");
    assert.deepEqual(analysis.translated, ["Enable.Motion.SmartDetect.ObjectSensors.LicensePlate.ABC123-XYZ789"], "the rewritten entry is named for the startup line");
  });

  // The same rewrite reaches a value written in the canonical form, since a configuration can carry a hyphen list on either spelling.
  test("a hyphen list written in the canonical form re-composes too", () => {

    const analysis = analyzeLegacyFeatureOptions(["Enable.Motion.SmartDetect.ObjectSensors.LicensePlate=ABC123-XYZ789"]);

    assert.deepEqual(analysis.engineOptions, ["Enable.Motion.SmartDetect.ObjectSensors.LicensePlate=ABC123,XYZ789"], "the value re-composes in place");
  });

  // The scope survives the rewrite exactly, so a camera-scoped plate list keeps addressing that camera.
  test("a scoped plate list keeps its scope through the rewrite", () => {

    const analysis = analyzeLegacyFeatureOptions(["Enable.Motion.SmartDetect.ObjectSensors.LicensePlate." + CAMERA + ".ABC123-XYZ789"]);

    assert.deepEqual(analysis.engineOptions, ["Enable.Motion.SmartDetect.ObjectSensors.LicensePlate." + CAMERA + "=ABC123,XYZ789"],
      "the camera scope and the re-composed value both stand");
  });

  // A value already speaking the current grammar is the user's own text and is left exactly as written, translated list included.
  test("a comma-separated plate list is untouched", () => {

    const options = ["Enable.Motion.SmartDetect.ObjectSensors.LicensePlate=ABC123,XYZ789"];
    const analysis = analyzeLegacyFeatureOptions(options);

    assert.deepEqual(analysis.engineOptions, options, "the entry stands as written");
    assert.deepEqual(analysis.translated, [], "nothing was translated");
  });

  // A single plate carries no delimiter of either kind, so there is nothing to re-compose and the entry passes through.
  test("a single-plate value is untouched", () => {

    const options = ["Enable.Motion.SmartDetect.ObjectSensors.LicensePlate.ABC123"];
    const analysis = analyzeLegacyFeatureOptions(options);

    assert.deepEqual(analysis.engineOptions, options, "the entry stands as written");
    assert.deepEqual(analysis.translated, [], "nothing was translated");
  });
});

describe("the legacy overlay", () => {

  // The overlay answers in the caller's own domain spelling, and a configuration naming nothing retired selects nothing.
  test("an unconfigured family selects nothing", () => {

    assert.deepEqual(resolveLegacySelection({ controller: CONTROLLER, device: CAMERA, domain: TIERS, family: "rtspPin", options: [] }), []);
  });

  // A global retired entry reaches every camera, which is what a global entry has always meant.
  test("a global per-tier entry reaches every camera", () => {

    const options = ["Enable.Video.Rtsp.Only.Medium"];

    assert.deepEqual(resolveLegacySelection({ controller: CONTROLLER, device: CAMERA, domain: TIERS, family: "rtspPin", options }), ["Medium"]);
    assert.deepEqual(resolveLegacySelection({ controller: OTHER_CONTROLLER, device: OTHER_CAMERA, domain: TIERS, family: "rtspPin", options }), ["Medium"]);
  });

  // A device-scoped entry reaches exactly its own camera. This is the reading the engine cannot produce on its own, so a no-op translation layer fails it.
  test("a device-scoped per-tier entry reaches only its own camera", () => {

    const options = ["Enable.Video.Rtsp.Only.High." + CAMERA];

    assert.deepEqual(resolveLegacySelection({ controller: CONTROLLER, device: CAMERA, domain: TIERS, family: "rtspPin", options }), ["High"]);
    assert.deepEqual(resolveLegacySelection({ controller: CONTROLLER, device: OTHER_CAMERA, domain: TIERS, family: "rtspPin", options }), []);
  });

  /* The three-level row the overlay exists for. A controller-scoped High and a device-scoped Medium compose the way they always have: each tier resolves through its
   * own three-level walk - the device level for Medium, the controller level for High - and the better quality of the two enabled tiers wins, so the camera keeps
   * resolving High. A reader that only knew the camera's own scope would answer Medium, and an aggregation blind to which controller the camera sits under would leak
   * the pin to a camera on another controller, so the sibling half is asserted beside it.
   */
  test("a controller-scoped tier composes with a device-scoped tier and the best quality still wins", () => {

    const options = [ "Enable.Video.Rtsp.Only.High." + CONTROLLER, "Enable.Video.Rtsp.Only.Medium." + CAMERA ];

    assert.deepEqual(resolveLegacySelection({ controller: CONTROLLER, device: CAMERA, domain: TIERS, family: "rtspPin", options }), ["High"],
      "the controller-scoped high tier still outranks the camera's medium one");
    assert.deepEqual(resolveLegacySelection({ controller: OTHER_CONTROLLER, device: OTHER_CAMERA, domain: TIERS, family: "rtspPin", options }), [],
      "a camera under another controller is reached by neither entry");
  });

  /* The same pairing read through the analysis is deliberately approximate, and this row documents the split rather than papering over it. A rewrite works on strings
   * alone, where nothing says which identifier names a controller and which names a camera, so each scope composes from itself plus the global level: the camera's own
   * entry wins there and the engine reads Medium. The runtime never takes that path while the family is overlaid, which is exactly why the overlay exists.
   */
  test("the analysis composes the same pairing per scope, which is the documented approximation", () => {

    const analysis = analyzeLegacyFeatureOptions([ "Enable.Video.Rtsp.Only.High." + CONTROLLER, "Enable.Video.Rtsp.Only.Medium." + CAMERA ]);

    assert.deepEqual(analysis.engineOptions, [ "Enable.Video.Rtsp.Only." + CONTROLLER + "=High", "Enable.Video.Rtsp.Only." + CAMERA + "=Medium" ],
      "each scope states what it composes on its own");
    assert.deepEqual([...analysis.families], ["rtspPin"], "the family stays overlaid, which is what keeps the runtime exact");
  });

  // A camera whose retired entries disable every tier its controller enabled resolves to no pin at all, which is the subtractive half of the same walk.
  test("a device-scoped disable of the controller's tier resolves to no pin", () => {

    const options = [ "Enable.Video.Rtsp.Only.High." + CONTROLLER, "Disable.Video.Rtsp.Only.High." + CAMERA ];

    assert.deepEqual(resolveLegacySelection({ controller: CONTROLLER, device: CAMERA, domain: TIERS, family: "rtspPin", options }), []);
    assert.deepEqual(resolveLegacySelection({ controller: CONTROLLER, device: OTHER_CAMERA, domain: TIERS, family: "rtspPin", options }), ["High"]);
  });

  // Matching folds case on the option-name segments, because the storage format always has: a configuration hand-written years ago in any casing keeps resolving.
  test("retired option names match without regard to casing", () => {

    const options = ["enable.video.RTSP.only.HIGH"];

    assert.deepEqual(resolveLegacySelection({ controller: CONTROLLER, device: CAMERA, domain: TIERS, family: "rtspPin", options }), ["High"]);
  });

  // The answer is expressed in the caller's own domain spelling, so a reader that hands over uppercase tiers gets uppercase tiers back.
  test("the selection is answered in the domain's own spelling", () => {

    const options = ["Enable.Video.Timeshift.Only.Low"];

    assert.deepEqual(resolveLegacySelection({ controller: CONTROLLER, device: CAMERA, domain: [ "HIGH", "MEDIUM", "LOW" ], family: "timeshiftPin", options }),
      ["LOW"]);
  });

  // A selection is intersected with what the caller says the device offers right now, so a type the retired configuration named but the camera does not report is
  // absent rather than handed back as a member of a domain it never belonged to.
  test("the occupancy selection is confined to the domain the caller offers", () => {

    const options = [ "Enable.Motion.OccupancySensor", "Enable.Motion.OccupancySensor.Vehicle" ];

    assert.deepEqual(resolveLegacySelection({ controller: CONTROLLER, device: CAMERA, domain: [ "person", "vehicle" ], family: "occupancy", options }),
      [ "person", "vehicle" ], "face is composed but the camera does not offer it, so it drops");
  });

  /* The three-level occupancy row: a camera whose master enable arrives only by CONTROLLER inheritance keeps its selection, and a controller-scoped per-type entry
   * composes with a device-scoped one. A reader blind to which controller a camera sits under would answer the sibling camera the same way, so the no-leak half is
   * asserted beside it.
   */
  test("a controller-scoped type composes with a device-scoped type and never leaks to another controller", () => {

    const options = [ "Enable.Motion.OccupancySensor." + CONTROLLER, "Disable.Motion.OccupancySensor.Face." + CONTROLLER,
      "Enable.Motion.OccupancySensor.Vehicle." + CAMERA ];
    const domain = [ "face", "person", "vehicle" ];

    assert.deepEqual(resolveLegacySelection({ controller: CONTROLLER, device: CAMERA, domain, family: "occupancy", options }), [ "person", "vehicle" ],
      "the controller's face subtraction and the camera's vehicle addition compose");
    assert.deepEqual(resolveLegacySelection({ controller: CONTROLLER, device: OTHER_CAMERA, domain, family: "occupancy", options }), ["person"],
      "a sibling camera under the same controller inherits the subtraction but not the camera-scoped addition");
    assert.deepEqual(resolveLegacySelection({ controller: OTHER_CONTROLLER, device: OTHER_CAMERA, domain, family: "occupancy", options }), [ "face", "person" ],
      "a camera under another controller keeps the retired defaults, untouched by either entry");
  });

  /* The three-level fob row, and the case a scope-blind overlay gets wrong: a controller-scoped subtraction of one button composes with a device-scoped subtraction of
   * another at the fob beneath that controller, while a sibling fob under a DIFFERENT controller keeps the controller-scoped button. Without the caller's own
   * controller in hand, the sibling would lose a button nobody hid for it.
   */
  test("a controller-scoped button subtraction composes with a device-scoped one and never leaks to another controller", () => {

    const options = [ "Disable.Fob.Button.Panic." + CONTROLLER, "Disable.Fob.Button.Left." + CAMERA ];
    const domain = [ "arm", "night", "disarm", "panic", "right", "left" ];

    assert.deepEqual(resolveLegacySelection({ controller: CONTROLLER, device: CAMERA, domain, family: "fobButtons", options }),
      [ "arm", "night", "disarm", "right" ], "the fob loses both the controller's button and its own");
    assert.deepEqual(resolveLegacySelection({ controller: CONTROLLER, device: OTHER_CAMERA, domain, family: "fobButtons", options }),
      [ "arm", "night", "disarm", "right", "left" ], "a sibling fob under the same controller loses only the controller's button");
    assert.deepEqual(resolveLegacySelection({ controller: OTHER_CONTROLLER, device: OTHER_CAMERA, domain, family: "fobButtons", options }), domain,
      "a fob under another controller keeps every button");
  });

  /* The three-level relay row, resolved against a THREE-output relay so both halves of the retired behavior show at once. A controller-scoped subtraction composes with
   * a device-scoped one at the relay beneath that controller, and the third output stays hidden everywhere the retired entries reach - it had no option of its own
   * under that grammar and resolved hidden, which is the meaning the overlay has to keep. A relay under another controller is untouched by either entry.
   */
  test("a controller-scoped output subtraction composes with a device-scoped one and never leaks to another controller", () => {

    const options = [ "Disable.Relay.Output.1." + CONTROLLER, "Disable.Relay.Output.2." + CAMERA ];
    const domain = [ "1", "2", "3" ];

    assert.deepEqual(resolveLegacySelection({ controller: CONTROLLER, device: CAMERA, domain, family: "relayOutputs", options }), [],
      "the relay loses both the controller's output and its own, and the third was never offered");
    assert.deepEqual(resolveLegacySelection({ controller: CONTROLLER, device: OTHER_CAMERA, domain, family: "relayOutputs", options }), ["2"],
      "a sibling relay under the same controller loses only the controller's output");
    assert.deepEqual(resolveLegacySelection({ controller: OTHER_CONTROLLER, device: OTHER_CAMERA, domain, family: "relayOutputs", options }), [ "1", "2" ],
      "a relay under another controller keeps both outputs the retired catalog knew, and still not the third");
  });
});
