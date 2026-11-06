/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * options-retired.test.ts: The translation of retired per-member feature options into the value options that carry them, as a fixture table of exact input/output
 * pairs over Protect's own catalog and families.
 *
 * Two halves are asserted separately because they answer different questions. The BOOT VIEW says what the engine is built on and which families still need the
 * overlay, and its output is compared entry for entry - a translation that emitted an extra entry, dropped a user's unrelated text, or reordered the array would
 * change what the engine resolves. The OVERLAY says what a reader with its own device and controller in hand gets back, which is where the retired grammar's exact
 * three-level precedence lives, and it is the half that can differ from the engine's post-translation reading: a rewrite composed without topology cannot tell a
 * controller identifier from a device one, so the rows that pair a controller scope with a device scope assert the two answers separately and say which is which.
 *
 * This file names the retired option grammar throughout, deliberately: beside the module it tests, it is the only place that still knows those names existed, which
 * is the exemption the zero-residue sweeps carry for it.
 */
import type { RetiredController, RetiredTranslation } from "homebridge-plugin-utils";
import { composeMigrationPatch, migrateRetiredOptions, translateRetiredOptions } from "./options-retired.ts";
import { describe, test } from "node:test";
import assert from "node:assert/strict";

// The controller these rows resolve against, a sibling controller that proves one controller's entries never answer for another, and two cameras beneath the first.
const CONTROLLER = "AABBCCDDEEFF";
const OTHER_CONTROLLER = "112233445566";
const CAMERA = "0123456789AB";
const OTHER_CAMERA = "BA9876543210";

// The tier picker's domain, in the spelling the catalog offers it.
const TIERS = [ "High", "Medium", "Low" ];

// The surviving option of every retired family, in the order the module declares them, restated here rather than read from the module so a family it stopped
// declaring reddens every row that expects the family overlaid.
const FAMILY_OPTIONS = [ "Fob.Buttons", "Motion.SmartDetect.ObjectSensors", "Motion.OccupancySensor", "Relay.Outputs", "Video.Rtsp.Only", "Video.Timeshift.Only" ];

// The surviving options a translation still overlays, read through the overlay itself: an overlaid option answers a selection, and any other answers undefined.
function overlaid(translation: RetiredTranslation): string[] {

  return FAMILY_OPTIONS.filter((option) => translation.selection({ domain: [], option }) !== undefined);
}

describe("the boot view", () => {

  // A configuration that names nothing retired is handed back untouched, reference contents and order alike, with no family overlaid and nothing to narrate. This is
  // the converged steady state every migrated installation reaches, and it is what makes the overlay cost nothing there.
  test("a canonical configuration passes through with no families and nothing translated", () => {

    const options = [ "Enable.Video.Rtsp.Only=High", "Disable.Device", "Enable.Motion.SmartDetect" ];
    const translation = translateRetiredOptions(options);

    assert.deepEqual(translation.configuredOptions, options, "every entry survives in order");
    assert.deepEqual(overlaid(translation), [], "no family needs the overlay");
    assert.deepEqual(translation.translated, [], "nothing was translated");
  });

  // Text the translation cannot account for is the user's own, so it survives byte for byte. The translation runs on every boot over every configuration, and a malformed
  // entry has to pass through rather than throw or be quietly rewritten.
  test("entries the analysis cannot account for pass through byte-verbatim", () => {

    const options = [ "", "NotAnAction.Video.Rtsp.Only.High", "Enable", "Enable.Some.Option.Nobody.Declares", "Disable.Video.Rtsp.Only.Purple" ];
    const translation = translateRetiredOptions(options);

    assert.deepEqual(translation.configuredOptions, options, "the whole array survives untouched");
    assert.deepEqual(translation.translated, [], "nothing was translated");
  });

  // The plain global case: one retired per-tier entry composes the canonical pin entry, the retired entry leaves the engine's view, and the family joins the overlay.
  test("a global per-tier entry composes the canonical pin", () => {

    const translation = translateRetiredOptions(["Enable.Video.Rtsp.Only.High"]);

    assert.deepEqual(translation.configuredOptions, ["Enable.Video.Rtsp.Only=High"], "the retired entry is replaced by the canonical pin");
    assert.deepEqual(overlaid(translation), ["Video.Rtsp.Only"], "the direct-RTSP family is overlaid");
    assert.deepEqual(translation.translated, ["Enable.Video.Rtsp.Only.High"], "the original entry is named for the startup line");
  });

  // The device-scoped case, which the engine reading alone cannot rescue: a scoped retired entry registers a key that addresses no current option at all. The
  // canonical entry the translation composes is what makes the pin resolve at that camera again.
  test("a device-scoped per-tier entry composes a scoped canonical pin", () => {

    const translation = translateRetiredOptions(["Enable.Video.Rtsp.Only.Medium." + CAMERA]);

    assert.deepEqual(translation.configuredOptions, ["Enable.Video.Rtsp.Only." + CAMERA + "=Medium"], "the scoped pin is stated at the camera's own scope");
    assert.deepEqual(overlaid(translation), ["Video.Rtsp.Only"], "the direct-RTSP family is overlaid");
  });

  /* Two tiers enabled at once resolve to the better of them, which is what the retired reader did: it walked the tiers from low to high and kept assigning, so the
   * highest quality named won regardless of the order the entries were written in. The engine's own reading of these two entries is first-wins over the array, which
   * would answer Low here - the composition is what corrects it.
   */
  test("a multi-tier configuration resolves to the best quality named, whatever the entry order", () => {

    const translation = translateRetiredOptions([ "Enable.Video.Rtsp.Only.Low", "Enable.Video.Rtsp.Only.High" ]);

    assert.deepEqual(translation.configuredOptions, ["Enable.Video.Rtsp.Only=High"], "the high tier wins over the low one written before it");
    assert.deepEqual(translation.translated, [ "Enable.Video.Rtsp.Only.Low", "Enable.Video.Rtsp.Only.High" ], "both retired entries are named");
  });

  // The two pin families translate independently: each carries its own retired names, its own option, and its own overlay membership.
  test("the two pin families translate side by side", () => {

    const translation = translateRetiredOptions([ "Enable.Video.Rtsp.Only.High", "Enable.Video.Timeshift.Only.Low" ]);

    assert.deepEqual(translation.configuredOptions, [ "Enable.Video.Rtsp.Only=High", "Enable.Video.Timeshift.Only=Low" ], "each family states its own pin");
    assert.deepEqual(overlaid(translation), [ "Video.Rtsp.Only", "Video.Timeshift.Only" ], "both families are overlaid");
  });

  // A scope that turns off every tier a broader scope turned on has something of its own to say, and the plain scoped Disable is what says it: without one, the camera
  // would inherit the global pin the user had switched off for it.
  test("a scope that disables every tier a broader scope enables composes the plain Disable", () => {

    const translation = translateRetiredOptions([ "Enable.Video.Rtsp.Only.High", "Disable.Video.Rtsp.Only.High." + CAMERA ]);

    assert.deepEqual(translation.configuredOptions, [ "Enable.Video.Rtsp.Only=High", "Disable.Video.Rtsp.Only." + CAMERA ], "the camera's pin is turned off explicitly");
  });

  // A scope whose entries merely restate what it already inherits states nothing: a retired Disable of a tier nobody enabled is the default said twice, and emitting
  // an entry for it would manufacture configuration out of nothing.
  test("a scope restating what it already inherits composes nothing", () => {

    const translation = translateRetiredOptions(["Disable.Video.Rtsp.Only.High." + CAMERA]);

    assert.deepEqual(translation.configuredOptions, [], "the retired entry leaves and nothing replaces it");
    assert.deepEqual(translation.translated, ["Disable.Video.Rtsp.Only.High." + CAMERA], "the entry is still named for the startup line");
  });

  /* A canonical value the user wrote is evidence that they have adopted the current grammar, so it wins outright: the retired entries beside it leave the engine's
   * view, nothing is composed to compete with the value, and the family does NOT join the overlay. This is the row that tells the ruled composition apart from a
   * union, an intersection, or a silent retired override - each of those would let the retired entry keep steering.
   */
  test("a canonical value supersedes the retired entries of its family outright", () => {

    const translation = translateRetiredOptions([ "Enable.Video.Rtsp.Only.High", "Enable.Video.Rtsp.Only=Low" ]);

    assert.deepEqual(translation.configuredOptions, ["Enable.Video.Rtsp.Only=Low"], "the user's own value is what the engine is left with");
    assert.deepEqual(overlaid(translation), [], "a superseded family is not overlaid");
    assert.deepEqual(translation.translated, ["Enable.Video.Rtsp.Only.High"], "the superseded entry is still named for the startup line");
  });

  // Supersession is per family: a canonical value for one pin says nothing about the other, so the second family keeps its overlay and its composition.
  test("supersession does not reach across families", () => {

    const translation = translateRetiredOptions([ "Enable.Video.Rtsp.Only=Low", "Enable.Video.Timeshift.Only.High" ]);

    assert.deepEqual(translation.configuredOptions, [ "Enable.Video.Rtsp.Only=Low", "Enable.Video.Timeshift.Only=High" ], "only the timeshift family composes");
    assert.deepEqual(overlaid(translation), ["Video.Timeshift.Only"], "only the timeshift family is overlaid");
  });

  /* A surviving option that took a new name did not exist in the retired grammar, so any entry for it is the user's own, bare or valued, and at any scope - one naming
   * another device included. It supersedes its family outright: the family's retired entries leave the boot view, nothing is composed beside them, and the overlay
   * answers nothing for it. An overlay-only family's retired entries stay in the boot view as written, where they address options the catalog does not declare.
   */
  test("a bare entry for a surviving option that took a new name supersedes its family at any scope", () => {

    for(const [ configured, kept ] of [ [ [ "Disable.Fob.Button.Panic", "Enable.Fob.Buttons" ], ["Enable.Fob.Buttons"] ],
      [ [ "Enable.Video.Rtsp.Only.High", "Disable.Video.Rtsp.Only" ], ["Disable.Video.Rtsp.Only"] ],
      [ [ "Enable.Video.Timeshift.Only.High." + CAMERA, "Disable.Video.Timeshift.Only." + OTHER_CAMERA ], ["Disable.Video.Timeshift.Only." + OTHER_CAMERA] ],
      [ [ "Disable.Relay.Output.2", "Disable.Relay.Outputs." + OTHER_CAMERA ], [ "Disable.Relay.Output.2", "Disable.Relay.Outputs." + OTHER_CAMERA ] ] ] as const) {

      const translation = translateRetiredOptions(configured);

      assert.deepEqual(translation.configuredOptions, kept, "the user's own entry is what the engine is left with: " + configured.join(", "));
      assert.deepEqual(overlaid(translation), [], "and no family is overlaid: " + configured.join(", "));
    }
  });

  /* Several families in one configuration, their entries written in an order that matches none of the families' own. The boot view keeps every surviving entry where
   * it stood - the relay's entries as written and the plate list re-composed in place - and states the compositions after them in the order the families are
   * declared. The startup narration names the plate entry first and then each family's entries in that same declared order, so a translated configuration reads the
   * same way wherever its entries sit.
   */
  test("families compose and narrate in their declared order, whatever order their entries appear in", () => {

    const translation = translateRetiredOptions([ "Enable.Video.Timeshift.Only.Low", "Enable.Video.Rtsp.Only.High", "Disable.Relay.Output.2",
      "Enable.Motion.OccupancySensor", "Enable.Motion.OccupancySensor.Vehicle", "Enable.Motion.SmartDetect.ObjectSensors." + CAMERA, "Disable.Fob.Button.Panic",
      "Enable.Motion.SmartDetect.ObjectSensors.LicensePlate.ABC123-XYZ789" ]);

    assert.deepEqual(translation.configuredOptions, [ "Disable.Relay.Output.2", "Enable.Motion.SmartDetect.ObjectSensors.LicensePlate=ABC123,XYZ789",
      "Enable.Fob.Buttons=arm,night,disarm,right,left", "Enable.Motion.SmartDetect.ObjectSensors." + CAMERA + "=*", "Enable.Motion.OccupancySensor=face,person,vehicle",
      "Enable.Video.Rtsp.Only=High", "Enable.Video.Timeshift.Only=Low" ], "the surviving entries keep their places and the compositions follow in declared order");
    assert.deepEqual(translation.translated, [ "Enable.Motion.SmartDetect.ObjectSensors.LicensePlate.ABC123-XYZ789", "Disable.Fob.Button.Panic",
      "Enable.Motion.SmartDetect.ObjectSensors." + CAMERA, "Enable.Motion.OccupancySensor", "Enable.Motion.OccupancySensor.Vehicle", "Disable.Relay.Output.2",
      "Enable.Video.Rtsp.Only.High", "Enable.Video.Timeshift.Only.Low" ], "the narration names the plate entry and then each family's entries in declared order");
  });
});

describe("the occupancy translation", () => {

  /* The plain global case. The retired per-type options carried mixed defaults - face and person on, everything else off - so a configuration that enables vehicle
   * beside the master composes all three, and the composition states them in the type table's own order.
   */
  test("global per-type entries compose the master's selection in wire values", () => {

    const translation = translateRetiredOptions([ "Enable.Motion.OccupancySensor", "Enable.Motion.OccupancySensor.Vehicle" ]);

    assert.deepEqual(translation.configuredOptions, ["Enable.Motion.OccupancySensor=face,person,vehicle"], "the composed selection carries the wire values");
    assert.deepEqual(overlaid(translation), ["Motion.OccupancySensor"], "the occupancy family is overlaid");
    assert.deepEqual(translation.translated, [ "Enable.Motion.OccupancySensor", "Enable.Motion.OccupancySensor.Vehicle" ], "both entries are named");
  });

  // A retired Disable subtracts a default-on type, which is the whole of how a user narrowed occupancy before the selection was a picker.
  test("a retired per-type Disable subtracts a default-on type", () => {

    const translation = translateRetiredOptions([ "Enable.Motion.OccupancySensor", "Disable.Motion.OccupancySensor.Face" ]);

    assert.deepEqual(translation.configuredOptions, ["Enable.Motion.OccupancySensor=person"], "face is subtracted and person stands");
  });

  /* Every type switched off with occupancy still on is a real state, and it survives as the explicit empty payload - the spelling that says "the user emptied this
   * selection" rather than "the user said nothing", which is what a bare enable would read as and would resolve back to face and person.
   */
  test("an all-types-off selection with the master on survives as the explicit empty payload", () => {

    const translation = translateRetiredOptions([ "Enable.Motion.OccupancySensor", "Disable.Motion.OccupancySensor.Face", "Disable.Motion.OccupancySensor.Person" ]);

    assert.deepEqual(translation.configuredOptions, ["Enable.Motion.OccupancySensor="], "the emptied selection is stated explicitly");
  });

  /* A dormant scope: per-type entries under a master the user never enabled. The selection was never live, and no entry form carries a selection under a Disable, so
   * it is dropped. The default-off master is already saying occupancy is off, so nothing needs to be composed to keep saying it - and the dropped entries are named
   * in the startup line, which is where a user learns their old per-type settings were read and set aside.
   */
  test("per-type entries under a disabled master are dropped and named", () => {

    const translation = translateRetiredOptions(["Enable.Motion.OccupancySensor.Vehicle"]);

    assert.deepEqual(translation.configuredOptions, [], "nothing is composed for a selection that was never live");
    assert.deepEqual(translation.translated, ["Enable.Motion.OccupancySensor.Vehicle"], "the dropped entry is named for the startup line");
  });

  /* The scoped bare master, which is this family's corrupting shape: the current catalog reads the trailing identifier of `Enable.Motion.OccupancySensor.<mac>` as
   * the option's GLOBAL value, so left alone it would enable occupancy for every device on every controller with a MAC address standing in as the selection. The
   * rewrite says what the user meant - occupancy on at that camera, with that camera's composed selection - and says nothing globally.
   */
  test("a scoped bare master is rewritten into the canonical scoped form", () => {

    const translation = translateRetiredOptions(["Enable.Motion.OccupancySensor." + CAMERA]);

    assert.deepEqual(translation.configuredOptions, ["Enable.Motion.OccupancySensor." + CAMERA + "=face,person"],
      "the scoped enable keeps its scope and states its selection");
    assert.deepEqual(overlaid(translation), ["Motion.OccupancySensor"], "the occupancy family is overlaid");
  });

  // A GLOBAL bare master with no per-type entries anywhere is a spelling valid in both eras, so it is left exactly as written and nothing is translated at all.
  test("a global bare master with no per-type entries passes through untouched", () => {

    const translation = translateRetiredOptions(["Enable.Motion.OccupancySensor"]);

    assert.deepEqual(translation.configuredOptions, ["Enable.Motion.OccupancySensor"], "the entry stands as written");
    assert.deepEqual(overlaid(translation), [], "there is nothing for the overlay to carry");
    assert.deepEqual(translation.translated, [], "nothing was translated");
  });

  /* The sibling negative control. `Enable.Motion.OccupancySensor.Duration` is today's way to switch the occupancy duration option on as a toggle, and its address is
   * shaped exactly like a master scoped to an identifier called "Duration". It must pass through byte-verbatim: rewriting it would compose a phantom scope and take
   * the user's duration setting with it. The retired catalog declares the sibling for precisely this reason, so the engine's own arbitration settles which option
   * the address belongs to.
   */
  test("a bare enable of the duration sibling is never read as a scoped master", () => {

    const options = [ "Enable.Motion.OccupancySensor.Duration", "Enable.Motion.OccupancySensor", "Enable.Motion.OccupancySensor.Vehicle" ];
    const translation = translateRetiredOptions(options);

    assert.ok(translation.configuredOptions.includes("Enable.Motion.OccupancySensor.Duration"), "the sibling entry survives byte-verbatim");
    assert.ok(!translation.translated.includes("Enable.Motion.OccupancySensor.Duration"), "the sibling is not something the translation acted on");
    assert.deepEqual(translation.configuredOptions, [ "Enable.Motion.OccupancySensor.Duration", "Enable.Motion.OccupancySensor=face,person,vehicle" ],
      "the sibling stands beside the composed selection rather than being folded into it");
  });

  /* The supersede pair the mixed-configuration rule turns on. The common retired shape is a bare master plus per-type entries and NO canonical value, and it must keep
   * resolving through the overlay - the bare enable of the option's own kept name spells the same thing in both eras and is not evidence of anything. Adding a
   * canonical value is: it supersedes the per-type entries outright, and the startup line names what it set aside.
   */
  test("a bare master enable never triggers supersession, and a canonical value does", () => {

    const retiredShape = translateRetiredOptions([ "Enable.Motion.OccupancySensor", "Enable.Motion.OccupancySensor.Vehicle" ]);

    assert.deepEqual(overlaid(retiredShape), ["Motion.OccupancySensor"], "the common retired shape keeps its overlay");

    const superseded = translateRetiredOptions([ "Enable.Motion.OccupancySensor.Vehicle", "Enable.Motion.OccupancySensor=vehicle" ]);

    assert.deepEqual(superseded.configuredOptions, ["Enable.Motion.OccupancySensor=vehicle"], "the user's own value is what the engine is left with");
    assert.deepEqual(overlaid(superseded), [], "a superseded family is not overlaid");
    assert.deepEqual(superseded.translated, ["Enable.Motion.OccupancySensor.Vehicle"], "the superseded entry is named for the startup line");
  });
});

describe("the object-sensor translation", () => {

  /* This family kept its option name and never had per-type entries, so it has exactly one corrupting shape: the scoped bare master, whose trailing identifier the
   * current catalog reads as the option's global value. The rewrite says all-choices, which is exact - switching the object sensors on at a camera has always meant a
   * contact sensor for every type that camera delivers - and being exact is why this family needs no overlay behind it.
   */
  test("a scoped bare master is rewritten to the all-choices selection at that scope", () => {

    const translation = translateRetiredOptions(["Enable.Motion.SmartDetect.ObjectSensors." + CAMERA]);

    assert.deepEqual(translation.configuredOptions, ["Enable.Motion.SmartDetect.ObjectSensors." + CAMERA + "=*"],
      "the scoped enable covers every type that camera delivers");
    assert.deepEqual(overlaid(translation), [], "the rewrite is exact, so nothing is overlaid");
    assert.deepEqual(translation.translated, ["Enable.Motion.SmartDetect.ObjectSensors." + CAMERA], "the rewritten entry is named for the startup line");
  });

  // A global bare enable is a spelling valid in both eras and stands as written; the current catalog's own all-choices default is what makes it still mean everything.
  test("a global bare master passes through untouched", () => {

    const translation = translateRetiredOptions(["Enable.Motion.SmartDetect.ObjectSensors"]);

    assert.deepEqual(translation.configuredOptions, ["Enable.Motion.SmartDetect.ObjectSensors"], "the entry stands as written");
    assert.deepEqual(translation.translated, [], "nothing was translated");
  });

  /* The plate-sibling negative control, which is the same hazard shape the occupancy duration sibling carries. `Enable.Motion.SmartDetect.ObjectSensors.LicensePlate`
   * is today's way to switch the plate list on as a toggle, and its address is shaped exactly like the object-sensor master scoped to an identifier called
   * "LicensePlate". Without the sibling declared, the rewrite would corrupt it into a phantom device-scoped all-choices entry and take the user's plate sensors with
   * it. The value-bearing dotted form is structurally immune - its embedded dot cannot be a scope identifier - so the bare form is the one that needs the control.
   */
  test("a bare enable of the plate sibling is never read as a scoped master", () => {

    const options = [ "Enable.Motion.SmartDetect.ObjectSensors.LicensePlate", "Enable.Motion.SmartDetect.ObjectSensors." + CAMERA ];
    const translation = translateRetiredOptions(options);

    assert.deepEqual(translation.configuredOptions, [ "Enable.Motion.SmartDetect.ObjectSensors.LicensePlate",
      "Enable.Motion.SmartDetect.ObjectSensors." + CAMERA + "=*" ], "the sibling survives byte-verbatim beside the rewritten scoped master");
    assert.deepEqual(translation.translated, ["Enable.Motion.SmartDetect.ObjectSensors." + CAMERA], "only the scoped master was acted on");
  });

  // Supersession reaches this family too: a canonical value the user wrote is their own selection, and the retired scoped enable beside it is a leftover.
  test("a canonical value supersedes a scoped bare master", () => {

    const translation = translateRetiredOptions([ "Enable.Motion.SmartDetect.ObjectSensors." + CAMERA, "Enable.Motion.SmartDetect.ObjectSensors=person" ]);

    assert.deepEqual(translation.configuredOptions, ["Enable.Motion.SmartDetect.ObjectSensors=person"], "the user's own value is what the engine is left with");
  });
});

describe("the fob translation", () => {

  // The six retired per-button options all defaulted ON, so hiding one meant disabling its own option and the composition of what remains is the five that stand.
  test("a global per-button Disable composes the five buttons that remain", () => {

    const translation = translateRetiredOptions(["Disable.Fob.Button.Panic"]);

    assert.deepEqual(translation.configuredOptions, ["Enable.Fob.Buttons=arm,night,disarm,right,left"], "the composition names the surviving buttons in table order");
    assert.deepEqual(overlaid(translation), ["Fob.Buttons"], "the fob family is overlaid");
  });

  // The same shape at a fob's own scope, which the current catalog cannot read at all on its own: the retired scoped entry addresses no declared option.
  test("a device-scoped per-button Disable composes that fob's own selection", () => {

    const translation = translateRetiredOptions(["Disable.Fob.Button.Panic." + CAMERA]);

    assert.deepEqual(translation.configuredOptions, ["Enable.Fob.Buttons." + CAMERA + "=arm,night,disarm,right,left"], "the fob's own scope states its own selection");
  });

  /* Every button disabled at a scope is an empty selection, and for this family the empty selection and a disabled option coincide - either way the fob exposes no
   * button services at all - so the plain Disable says it exactly, with no dependence on how an empty payload reads.
   */
  test("a scope with every button disabled composes the plain Disable", () => {

    const translation = translateRetiredOptions([ "Disable.Fob.Button.Arm", "Disable.Fob.Button.Night", "Disable.Fob.Button.Disarm", "Disable.Fob.Button.Panic",
      "Disable.Fob.Button.Right", "Disable.Fob.Button.Left" ]);

    assert.deepEqual(translation.configuredOptions, ["Disable.Fob.Buttons"], "no button survives, which the plain Disable states");
  });

  // A global subtraction layers with a device-scoped one: the fob's own scope composes BOTH, since the global entry still resolves beneath it.
  test("a globally hidden button stays hidden at a fob scope whose own entries touch a different button", () => {

    const translation = translateRetiredOptions([ "Disable.Fob.Button.Panic", "Disable.Fob.Button.Left." + CAMERA ]);

    assert.deepEqual(translation.configuredOptions, [ "Enable.Fob.Buttons=arm,night,disarm,right,left",
      "Enable.Fob.Buttons." + CAMERA + "=arm,night,disarm,right" ], "the fob's scope composes its own subtraction on top of the global one");
  });

  /* A fob scope earns an entry exactly when its selection differs, entry by entry, from what it inherits. The scope's list and the one it inherits are the same length
   * here and neither is empty, because those are the only shapes where the comparison reads the entries at all: a length mismatch or an empty pair answers without
   * looking at a single member.
   * The first configuration restates the global selection at the fob's scope, and the second trades one inherited button for another at the same length.
   */
  test("a fob scope that restates what it inherits composes nothing, and one that trades a button for another composes its own selection", () => {

    const restated = translateRetiredOptions([ "Disable.Fob.Button.Panic", "Disable.Fob.Button.Panic." + CAMERA ]);

    assert.deepEqual(restated.configuredOptions, ["Enable.Fob.Buttons=arm,night,disarm,right,left"], "the restated scope composes no entry of its own");

    const traded = translateRetiredOptions([ "Disable.Fob.Button.Panic", "Disable.Fob.Button.Left." + CAMERA, "Enable.Fob.Button.Panic." + CAMERA ]);

    assert.deepEqual(traded.configuredOptions, [ "Enable.Fob.Buttons=arm,night,disarm,right,left", "Enable.Fob.Buttons." + CAMERA + "=arm,night,disarm,panic,right" ],
      "the scope whose selection differs at the same length composes its own entry");
  });

  /* A scope selecting every button the retired options covered states the all-choices value rather than listing them, because that value is the fob option's own
   * default: the scope keeps tracking whatever buttons the fob reports, which a literal list of the retired buttons would freeze.
   */
  test("a fob scope selecting every retired button composes the all-choices value", () => {

    const translation = translateRetiredOptions([ "Disable.Fob.Button.Panic", "Enable.Fob.Button.Panic." + CAMERA ]);

    assert.deepEqual(translation.configuredOptions, [ "Enable.Fob.Buttons=arm,night,disarm,right,left", "Enable.Fob.Buttons." + CAMERA + "=*" ],
      "the global subtraction stands and the fob's own re-enable restores every button");
  });

  // A scope spelled in different casings is one scope, since an identifier matches without regard to case: its entries compose once, in the spelling it first
  // appeared in.
  test("a fob scope spelled in different casings composes once", () => {

    const translation = translateRetiredOptions([ "Disable.Fob.Button.Panic." + CAMERA, "Disable.Fob.Button.Left." + CAMERA.toLowerCase() ]);

    assert.deepEqual(translation.configuredOptions, ["Enable.Fob.Buttons." + CAMERA + "=arm,night,disarm,right"], "both subtractions compose at the one scope");
  });
});

describe("the relay translation", () => {

  /* This family's retired entries stay in the engine's view exactly as written, which is the one family that works that way. Stating what a per-output subtraction
   * leaves standing takes the relay's live output list, and a configuration string does not carry it - so nothing is composed here and the overlay is what gives the
   * entries their meaning, over each relay's own outputs. The engine reads them as entries for an option it does not declare and acts on none of them.
   */
  test("retired per-output entries pass through untouched while the family joins the overlay", () => {

    const translation = translateRetiredOptions(["Disable.Relay.Output.2"]);

    assert.deepEqual(translation.configuredOptions, ["Disable.Relay.Output.2"], "the entry stays exactly where it was");
    assert.deepEqual(overlaid(translation), ["Relay.Outputs"], "the relay family is overlaid");
    assert.deepEqual(translation.translated, ["Disable.Relay.Output.2"], "the overlaid entry is named for the startup line");
  });

  // A canonical selection supersedes them, so the family leaves the overlay and the retired entry stops meaning anything at all.
  test("a canonical selection supersedes the retired per-output entries", () => {

    const translation = translateRetiredOptions([ "Disable.Relay.Output.2", "Enable.Relay.Outputs=1,2,3" ]);

    assert.deepEqual(translation.configuredOptions, [ "Disable.Relay.Output.2", "Enable.Relay.Outputs=1,2,3" ], "neither entry is rewritten");
    assert.deepEqual(overlaid(translation), [], "a superseded family is not overlaid, so the retired entry no longer answers for anything");
  });
});

describe("the plate translation", () => {

  /* Plates are the one retired grammar that lived inside a value rather than in option names: the list separated its entries with hyphens. A plate could never itself
   * contain a hyphen under that grammar, so a value carrying one and no comma is unambiguously a list and the rewrite is exact. The option's own name and scope are
   * untouched; only the value re-composes.
   */
  test("a hyphen-separated plate list re-composes into the shared list grammar", () => {

    const translation = translateRetiredOptions(["Enable.Motion.SmartDetect.ObjectSensors.LicensePlate.ABC123-XYZ789"]);

    assert.deepEqual(translation.configuredOptions, ["Enable.Motion.SmartDetect.ObjectSensors.LicensePlate=ABC123,XYZ789"],
      "the plates are joined by the list delimiter");
    assert.deepEqual(overlaid(translation), [], "the rewrite is exact, so nothing is overlaid");
    assert.deepEqual(translation.translated, ["Enable.Motion.SmartDetect.ObjectSensors.LicensePlate.ABC123-XYZ789"], "the rewritten entry is named for the startup line");
  });

  // The same rewrite reaches a value written in the canonical form, since a configuration can carry a hyphen list on either spelling.
  test("a hyphen list written in the canonical form re-composes too", () => {

    const translation = translateRetiredOptions(["Enable.Motion.SmartDetect.ObjectSensors.LicensePlate=ABC123-XYZ789"]);

    assert.deepEqual(translation.configuredOptions, ["Enable.Motion.SmartDetect.ObjectSensors.LicensePlate=ABC123,XYZ789"], "the value re-composes in place");
  });

  // The scope survives the rewrite exactly, so a camera-scoped plate list keeps addressing that camera.
  test("a scoped plate list keeps its scope through the rewrite", () => {

    const translation = translateRetiredOptions(["Enable.Motion.SmartDetect.ObjectSensors.LicensePlate." + CAMERA + ".ABC123-XYZ789"]);

    assert.deepEqual(translation.configuredOptions, ["Enable.Motion.SmartDetect.ObjectSensors.LicensePlate." + CAMERA + "=ABC123,XYZ789"],
      "the camera scope and the re-composed value both stand");
  });

  // A value already speaking the current grammar is the user's own text and is left exactly as written, translated list included.
  test("a comma-separated plate list is untouched", () => {

    const options = ["Enable.Motion.SmartDetect.ObjectSensors.LicensePlate=ABC123,XYZ789"];
    const translation = translateRetiredOptions(options);

    assert.deepEqual(translation.configuredOptions, options, "the entry stands as written");
    assert.deepEqual(translation.translated, [], "nothing was translated");
  });

  // A single plate carries no delimiter of either kind, so there is nothing to re-compose and the entry passes through.
  test("a single-plate value is untouched", () => {

    const options = ["Enable.Motion.SmartDetect.ObjectSensors.LicensePlate.ABC123"];
    const translation = translateRetiredOptions(options);

    assert.deepEqual(translation.configuredOptions, options, "the entry stands as written");
    assert.deepEqual(translation.translated, [], "nothing was translated");
  });

  // A plate list re-composes before the families translate, so the startup narration names it ahead of every family's entries, and the boot view keeps it where it
  // was written with the compositions after it.
  test("a plate list beside a family entry is narrated first and keeps its place", () => {

    const translation = translateRetiredOptions([ "Enable.Video.Rtsp.Only.High", "Enable.Motion.SmartDetect.ObjectSensors.LicensePlate.ABC123-XYZ789" ]);

    assert.deepEqual(translation.configuredOptions, [ "Enable.Motion.SmartDetect.ObjectSensors.LicensePlate=ABC123,XYZ789", "Enable.Video.Rtsp.Only=High" ],
      "the plate list re-composes in place and the pin composition follows it");
    assert.deepEqual(translation.translated, [ "Enable.Motion.SmartDetect.ObjectSensors.LicensePlate.ABC123-XYZ789", "Enable.Video.Rtsp.Only.High" ],
      "the plate entry is named first");
  });
});

describe("the overlay", () => {

  // The overlay answers only for a family the configuration still carries in the retired grammar, so a configuration naming nothing retired answers undefined and the
  // reader reads the engine as it always does.
  test("an unconfigured family leaves the reader to the engine", () => {

    assert.equal(translateRetiredOptions([]).selection({ controller: CONTROLLER, device: CAMERA, domain: TIERS, option: "Video.Rtsp.Only" }), undefined);
  });

  // A global retired entry reaches every camera, which is what a global entry has always meant.
  test("a global per-tier entry reaches every camera", () => {

    const options = ["Enable.Video.Rtsp.Only.Medium"];

    assert.deepEqual(translateRetiredOptions(options).selection({ controller: CONTROLLER, device: CAMERA, domain: TIERS, option: "Video.Rtsp.Only" }), ["Medium"]);
    assert.deepEqual(translateRetiredOptions(options).selection({ controller: OTHER_CONTROLLER, device: OTHER_CAMERA, domain: TIERS, option: "Video.Rtsp.Only" }),
      ["Medium"]);
  });

  // A device-scoped entry reaches exactly its own camera. This is the reading the engine cannot produce on its own, so a no-op translation layer fails it.
  test("a device-scoped per-tier entry reaches only its own camera", () => {

    const options = ["Enable.Video.Rtsp.Only.High." + CAMERA];

    assert.deepEqual(translateRetiredOptions(options).selection({ controller: CONTROLLER, device: CAMERA, domain: TIERS, option: "Video.Rtsp.Only" }), ["High"]);
    assert.deepEqual(translateRetiredOptions(options).selection({ controller: CONTROLLER, device: OTHER_CAMERA, domain: TIERS, option: "Video.Rtsp.Only" }), []);
  });

  /* The three-level row the overlay exists for. A controller-scoped High and a device-scoped Medium compose the way they always have: each tier resolves through its
   * own three-level walk - the device level for Medium, the controller level for High - and the better quality of the two enabled tiers wins, so the camera keeps
   * resolving High. A reader that only knew the camera's own scope would answer Medium, and an aggregation blind to which controller the camera sits under would leak
   * the pin to a camera on another controller, so the sibling half is asserted beside it.
   */
  test("a controller-scoped tier composes with a device-scoped tier and the best quality still wins", () => {

    const options = [ "Enable.Video.Rtsp.Only.High." + CONTROLLER, "Enable.Video.Rtsp.Only.Medium." + CAMERA ];

    assert.deepEqual(translateRetiredOptions(options).selection({ controller: CONTROLLER, device: CAMERA, domain: TIERS, option: "Video.Rtsp.Only" }), ["High"],
      "the controller-scoped high tier still outranks the camera's medium one");
    assert.deepEqual(translateRetiredOptions(options).selection({ controller: OTHER_CONTROLLER, device: OTHER_CAMERA, domain: TIERS, option: "Video.Rtsp.Only" }), [],
      "a camera under another controller is reached by neither entry");
  });

  /* The same pairing read through the translation is deliberately approximate, and this row documents the split rather than papering over it. A rewrite works on strings
   * alone, where nothing says which identifier names a controller and which names a camera, so each scope composes from itself plus the global level: the camera's own
   * entry wins there and the engine reads Medium. The runtime never takes that path while the family is overlaid, which is exactly why the overlay exists.
   */
  test("the analysis composes the same pairing per scope, which is the documented approximation", () => {

    const translation = translateRetiredOptions([ "Enable.Video.Rtsp.Only.High." + CONTROLLER, "Enable.Video.Rtsp.Only.Medium." + CAMERA ]);

    assert.deepEqual(translation.configuredOptions, [ "Enable.Video.Rtsp.Only." + CONTROLLER + "=High", "Enable.Video.Rtsp.Only." + CAMERA + "=Medium" ],
      "each scope states what it composes on its own");
    assert.deepEqual(overlaid(translation), ["Video.Rtsp.Only"], "the family stays overlaid, which is what keeps the runtime exact");
  });

  // A camera whose retired entries disable every tier its controller enabled resolves to no pin at all, which is the subtractive half of the same walk.
  test("a device-scoped disable of the controller's tier resolves to no pin", () => {

    const options = [ "Enable.Video.Rtsp.Only.High." + CONTROLLER, "Disable.Video.Rtsp.Only.High." + CAMERA ];

    assert.deepEqual(translateRetiredOptions(options).selection({ controller: CONTROLLER, device: CAMERA, domain: TIERS, option: "Video.Rtsp.Only" }), []);
    assert.deepEqual(translateRetiredOptions(options).selection({ controller: CONTROLLER, device: OTHER_CAMERA, domain: TIERS, option: "Video.Rtsp.Only" }), ["High"]);
  });

  // Matching folds case on the option-name segments, because the storage format always has: a configuration hand-written years ago in any casing keeps resolving.
  test("retired option names match without regard to casing", () => {

    const options = ["enable.video.RTSP.only.HIGH"];

    assert.deepEqual(translateRetiredOptions(options).selection({ controller: CONTROLLER, device: CAMERA, domain: TIERS, option: "Video.Rtsp.Only" }), ["High"]);
  });

  // The answer is expressed in the caller's own domain spelling, so a reader that hands over uppercase tiers gets uppercase tiers back.
  test("the selection is answered in the domain's own spelling", () => {

    const options = ["Enable.Video.Timeshift.Only.Low"];

    assert.deepEqual(translateRetiredOptions(options).selection({ controller: CONTROLLER, device: CAMERA, domain: [ "HIGH", "MEDIUM", "LOW" ],
      option: "Video.Timeshift.Only" }), ["LOW"]);
  });

  // A selection is intersected with what the caller says the device offers right now, so a type the retired configuration named but the camera does not report is
  // absent rather than handed back as a member of a domain it never belonged to.
  test("the occupancy selection is confined to the domain the caller offers", () => {

    const options = [ "Enable.Motion.OccupancySensor", "Enable.Motion.OccupancySensor.Vehicle" ];

    assert.deepEqual(translateRetiredOptions(options).selection({ controller: CONTROLLER, device: CAMERA, domain: [ "person", "vehicle" ],
      option: "Motion.OccupancySensor" }), [ "person", "vehicle" ], "face is composed but the camera does not offer it, so it drops");
  });

  /* The three-level occupancy row: a camera whose master enable arrives only by CONTROLLER inheritance keeps its selection, and a controller-scoped per-type entry
   * composes with a device-scoped one. A reader blind to which controller a camera sits under would answer the sibling camera the same way, so the no-leak half is
   * asserted beside it.
   */
  test("a controller-scoped type composes with a device-scoped type and never leaks to another controller", () => {

    const options = [ "Enable.Motion.OccupancySensor." + CONTROLLER, "Disable.Motion.OccupancySensor.Face." + CONTROLLER,
      "Enable.Motion.OccupancySensor.Vehicle." + CAMERA ];
    const domain = [ "face", "person", "vehicle" ];

    assert.deepEqual(translateRetiredOptions(options).selection({ controller: CONTROLLER, device: CAMERA, domain, option: "Motion.OccupancySensor" }),
      [ "person", "vehicle" ], "the controller's face subtraction and the camera's vehicle addition compose");
    assert.deepEqual(translateRetiredOptions(options).selection({ controller: CONTROLLER, device: OTHER_CAMERA, domain, option: "Motion.OccupancySensor" }), ["person"],
      "a sibling camera under the same controller inherits the subtraction but not the camera-scoped addition");
    assert.deepEqual(translateRetiredOptions(options).selection({ controller: OTHER_CONTROLLER, device: OTHER_CAMERA, domain, option: "Motion.OccupancySensor" }),
      [ "face", "person" ], "a camera under another controller keeps the retired defaults, untouched by either entry");
  });

  /* The three-level fob row, and the case a scope-blind overlay gets wrong: a controller-scoped subtraction of one button composes with a device-scoped subtraction of
   * another at the fob beneath that controller, while a sibling fob under a DIFFERENT controller keeps the controller-scoped button. Without the caller's own
   * controller in hand, the sibling would lose a button nobody hid for it.
   */
  test("a controller-scoped button subtraction composes with a device-scoped one and never leaks to another controller", () => {

    const options = [ "Disable.Fob.Button.Panic." + CONTROLLER, "Disable.Fob.Button.Left." + CAMERA ];
    const domain = [ "arm", "night", "disarm", "panic", "right", "left" ];

    assert.deepEqual(translateRetiredOptions(options).selection({ controller: CONTROLLER, device: CAMERA, domain, option: "Fob.Buttons" }),
      [ "arm", "night", "disarm", "right" ], "the fob loses both the controller's button and its own");
    assert.deepEqual(translateRetiredOptions(options).selection({ controller: CONTROLLER, device: OTHER_CAMERA, domain, option: "Fob.Buttons" }),
      [ "arm", "night", "disarm", "right", "left" ], "a sibling fob under the same controller loses only the controller's button");
    assert.deepEqual(translateRetiredOptions(options).selection({ controller: OTHER_CONTROLLER, device: OTHER_CAMERA, domain, option: "Fob.Buttons" }), domain,
      "a fob under another controller keeps every button");
  });

  /* The three-level relay row, resolved against a THREE-output relay so both halves of the retired behavior show at once. A controller-scoped subtraction composes with
   * a device-scoped one at the relay beneath that controller, and the third output stays hidden everywhere the retired entries reach - it had no option of its own
   * under that grammar and resolved hidden, which is the meaning the overlay has to keep. A relay under another controller is untouched by either entry.
   */
  test("a controller-scoped output subtraction composes with a device-scoped one and never leaks to another controller", () => {

    const options = [ "Disable.Relay.Output.1." + CONTROLLER, "Disable.Relay.Output.2." + CAMERA ];
    const domain = [ "1", "2", "3" ];

    assert.deepEqual(translateRetiredOptions(options).selection({ controller: CONTROLLER, device: CAMERA, domain, option: "Relay.Outputs" }), [],
      "the relay loses both the controller's output and its own, and the third was never offered");
    assert.deepEqual(translateRetiredOptions(options).selection({ controller: CONTROLLER, device: OTHER_CAMERA, domain, option: "Relay.Outputs" }), ["2"],
      "a sibling relay under the same controller loses only the controller's output");
    assert.deepEqual(translateRetiredOptions(options).selection({ controller: OTHER_CONTROLLER, device: OTHER_CAMERA, domain, option: "Relay.Outputs" }), [ "1", "2" ],
      "a relay under another controller keeps both outputs the retired catalog knew, and still not the third");
  });
});

describe("the durable migration", () => {

  // The topology the settings page's probes gather: one controller with two cameras beneath it, and a sibling controller with one.
  const TOPOLOGY: RetiredController[] = [

    { devices: [ CAMERA, OTHER_CAMERA ], id: CONTROLLER },
    { devices: ["CC0011223344"], id: OTHER_CONTROLLER }
  ];

  // With no topology at all, a family whose scopes are all global rewrites exactly - there is no hierarchy to place - and nothing is reported as remaining.
  test("a global-only configuration migrates with no topology and reports nothing remaining", () => {

    const migration = migrateRetiredOptions({ configuredOptions: ["Enable.Video.Rtsp.Only.High"] });

    assert.deepEqual(migration.configuredOptions, ["Enable.Video.Rtsp.Only=High"], "the pin is stated canonically");
    assert.equal(migration.remaining, false, "nothing is left for a later pass");
  });

  // A scoped entry cannot be placed without topology, so the family keeps its entries untouched and says so. Nothing is guessed at and nothing is lost.
  test("a scoped entry with no topology keeps its family's entries and reports them remaining", () => {

    const options = ["Enable.Video.Rtsp.Only.Medium." + CAMERA];
    const migration = migrateRetiredOptions({ configuredOptions: options });

    assert.deepEqual(migration.configuredOptions, options, "the entries stand exactly as written");
    assert.equal(migration.remaining, true, "the caller is told to probe wider and come back");
  });

  /* Every Protect device sits beneath a controller, so an omitted topology and an empty one are the same pass: neither places a scope, and a scoped family keeps its
   * entries whole and reports itself remaining either way rather than composing a device scope against the global level alone.
   */
  test("an omitted topology and an empty one place nothing alike", () => {

    const options = ["Enable.Video.Rtsp.Only.Medium." + CAMERA];

    for(const migration of [ migrateRetiredOptions({ configuredOptions: options }), migrateRetiredOptions({ configuredOptions: options, controllers: [] }) ]) {

      assert.deepEqual(migration.configuredOptions, options, "the entries stand exactly as written");
      assert.equal(migration.remaining, true, "the caller is told to probe wider and come back");
    }
  });

  /* The topology-exact composition, and the reason the migration waits for topology at all. A controller-scoped subtraction and a device-scoped addition compose at the
   * camera through its TRUE three-level walk, which the in-memory rewrite cannot reach: without knowing that this camera sits under that controller, the camera's own
   * scope composes against the global level alone and loses the controller's subtraction. The written entry is what the runtime reads from then on, so it has to be the
   * exact one.
   */
  test("a controller-plus-device composition migrates exactly once the topology places the scopes", () => {

    const options = [ "Enable.Motion.OccupancySensor." + CONTROLLER, "Disable.Motion.OccupancySensor.Face." + CONTROLLER,
      "Enable.Motion.OccupancySensor.Vehicle." + CAMERA ];
    const migration = migrateRetiredOptions({ configuredOptions: options, controllers: TOPOLOGY });

    assert.equal(migration.remaining, false, "every scope was placed, so nothing is left for a later pass");
    assert.deepEqual(migration.configuredOptions, [ "Enable.Motion.OccupancySensor." + CONTROLLER + "=person",
      "Enable.Motion.OccupancySensor." + CAMERA + "=person,vehicle" ], "the camera keeps the controller's subtraction and its own addition");

    // The same configuration without topology composes the camera's scope against the global level alone, which is the approximation this pass exists to replace.
    assert.deepEqual(migrateRetiredOptions({ configuredOptions: options }).remaining, true, "without topology the family waits rather than writing the approximation");
  });

  // A controller identifier matches without regard to case, so a controller-scoped family migrates through a topology that spells the controller and its devices in
  // another casing, and the composition keeps the spelling the configuration wrote.
  test("a controller scope migrates through a topology spelled in another casing", () => {

    const migration = migrateRetiredOptions({ configuredOptions: ["Enable.Video.Rtsp.Only.High." + CONTROLLER],
      controllers: [{ devices: [CAMERA.toLowerCase()], id: CONTROLLER.toLowerCase() }] });

    assert.deepEqual(migration.configuredOptions, ["Enable.Video.Rtsp.Only." + CONTROLLER + "=High"], "the controller's pin is stated at its own scope");
    assert.equal(migration.remaining, false, "the scope was placed, so nothing is left for a later pass");
  });

  // Retirement is per family: one family whose scopes the topology places migrates while another whose scope it cannot keeps its entries, in a single pass.
  test("a family the topology cannot place waits while its neighbors migrate", () => {

    const options = [ "Enable.Video.Rtsp.Only.High", "Enable.Video.Timeshift.Only.Low.EEFF00112233" ];
    const migration = migrateRetiredOptions({ configuredOptions: options, controllers: TOPOLOGY });

    assert.deepEqual(migration.configuredOptions, [ "Enable.Video.Timeshift.Only.Low.EEFF00112233", "Enable.Video.Rtsp.Only=High" ],
      "the placeable family is rewritten and the unplaceable one stands exactly as written");
    assert.equal(migration.remaining, true, "the unplaceable family is reported so a later pass can finish it");
  });

  // The plate rewrite needs no topology at all, so it lands on the very first pass alongside every other topology-free family.
  test("a retired plate list migrates on the topology-free pass", () => {

    const migration = migrateRetiredOptions({ configuredOptions: ["Enable.Motion.SmartDetect.ObjectSensors.LicensePlate.ABC123-XYZ789"] });

    assert.deepEqual(migration.configuredOptions, ["Enable.Motion.SmartDetect.ObjectSensors.LicensePlate=ABC123,XYZ789"], "the plates are re-composed in place");
    assert.equal(migration.remaining, false, "nothing about a plate list needs topology");
  });

  // A superseded family's retired entries carry no meaning, so the migration simply drops them rather than composing anything to replace them.
  test("a superseded family's retired entries are dropped outright", () => {

    const migration = migrateRetiredOptions({ configuredOptions: [ "Enable.Video.Rtsp.Only.High", "Enable.Video.Rtsp.Only=Low" ] });

    assert.deepEqual(migration.configuredOptions, ["Enable.Video.Rtsp.Only=Low"], "the user's own value is all that is left");
    assert.equal(migration.remaining, false, "a superseded family needs no later pass");
  });
});

describe("the migration envelope", () => {

  /* The common install: the property migration finished long ago and answers null, while the feature options still speak the retired grammar. A null property patch
   * must never read as "nothing to do" - virtually every existing configuration is in exactly this state, and reading it that way would leave the translation to never
   * converge and the startup line promising it to be false.
   */
  test("a null property patch with a translation to make still commits", () => {

    const composed = composeMigrationPatch({ migratePatch: null, platformOptions: ["Enable.Video.Rtsp.Only.High"] });

    assert.deepEqual(composed.patch, { options: ["Enable.Video.Rtsp.Only=High"] }, "the translation alone is worth a write");
  });

  /* A controllers-only patch is a live shape: the property migration can rewrite the controllers array while carrying no options key at all. What selects the array the
   * translation runs over is the PRESENCE OF THAT KEY, never the patch object - reading an absent key would hand the translation an empty array and erase the user's
   * settings on the way to writing it back.
   */
  test("a controllers-only patch composes with the configuration's own options intact", () => {

    const composed = composeMigrationPatch({ migratePatch: { controllers: [{ address: "10.0.0.1" }] }, platformOptions: ["Enable.Video.Rtsp.Only.High"] });

    assert.deepEqual(composed.patch, { controllers: [{ address: "10.0.0.1" }], options: ["Enable.Video.Rtsp.Only=High"] },
      "the controllers rewrite and the translated options share one patch");
  });

  // Two writers, one options array: the translation runs over what the property migration produced, so the final patch carries the composition rather than a race.
  test("both writers compose into one options write", () => {

    const composed = composeMigrationPatch({ migratePatch: { options: [ "Enable.Doorbell.Ring.Delay=5", "Enable.Video.Rtsp.Only.High" ], ringDelay: undefined },
      platformOptions: ["Enable.Video.Rtsp.Only.High"] });

    assert.deepEqual(composed.patch, { options: [ "Enable.Doorbell.Ring.Delay=5", "Enable.Video.Rtsp.Only=High" ], ringDelay: undefined },
      "the property migration's own entries survive and the retired one beside them is rewritten");
  });

  // A converged configuration with nothing for either writer to do answers null, which is what keeps a settings-page open from touching the disk at all.
  test("neither writer having anything to do answers null", () => {

    const composed = composeMigrationPatch({ migratePatch: null, platformOptions: ["Enable.Video.Rtsp.Only=High"] });

    assert.equal(composed.patch, null, "nothing is written");
    assert.equal(composed.remaining, false, "and nothing is left to place");
  });

  // A property patch the translation finds nothing to add to is committed exactly as it arrived, with no options key manufactured for it.
  test("a property patch the translation leaves alone commits unchanged", () => {

    const migratePatch = { controllers: [{ address: "10.0.0.1" }] };
    const composed = composeMigrationPatch({ migratePatch, platformOptions: ["Enable.Video.Rtsp.Only=High"] });

    assert.deepEqual(composed.patch, migratePatch, "the patch is handed back as it came, carrying no options key it never had");
  });

  // The detector half the settings page gates its wider controller probes on: a scoped entry the topology-free pass cannot place is reported, and nothing is written
  // for its family until a pass that can place it.
  test("the envelope reports a family still needing topology", () => {

    const composed = composeMigrationPatch({ migratePatch: null, platformOptions: ["Enable.Video.Rtsp.Only.Medium." + CAMERA] });

    assert.equal(composed.remaining, true, "the page is told to probe wider");
    assert.equal(composed.patch, null, "and nothing is written in the meantime");
  });
});
