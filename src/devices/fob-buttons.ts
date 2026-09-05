/* Copyright(C) 2019-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * fob-buttons.ts: The UniFi Protect fob button table and the picker choices derived from it.
 */
import type { FeatureOptionChoice, Nullable } from "homebridge-plugin-utils";

// One physical button on a UniFi Protect fob. index is the STABLE 1-based ServiceLabelIndex the button always carries in HomeKit (never a compacted visible-subset
// position, so a hidden earlier button never renumbers a later one), following the controller's own button numbering. label is the security-action display name.
// positionLabel is the display name the controller's position-hint labeling assigns the button. wireId is the lowercase protocol id the controller's buttonPressed
// occurrence carries in its `button` field, and it is what the buttons selection stores. label and wireId are deliberately distinct derivations - the protocol id is not
// a display string and must never drift toward one.
export interface FobButton {

  readonly index: number;
  readonly label: string;
  readonly positionLabel: string;
  readonly wireId: string;
}

// The fixed, region-agnostic button table for the UniFi fob family. The controller config carries no per-button array (a fob is a pure-input device whose presses arrive
// only as firehose occurrences), so the plugin authors the button set from live-captured wire truth: six buttons whose wire ids are stable across the controller's
// button-labeling modes. The indices follow the controller's own button numbering - the numbers its position-hint labeling assigns - so HomeKit's button ordering matches
// the controller's in both label modes. Because the wire ids are labeling-independent, this table, not the controller's labeling choice, is the button-identity source of
// truth, and it fixes each button's 1-based ServiceLabelIndex.
export const USL_FOB_BUTTONS: readonly FobButton[] = [

  { index: 1, label: "Arm", positionLabel: "1", wireId: "arm" },
  { index: 2, label: "Night", positionLabel: "2", wireId: "night" },
  { index: 3, label: "Disarm", positionLabel: "3", wireId: "disarm" },
  { index: 4, label: "Panic", positionLabel: "4", wireId: "panic" },
  { index: 5, label: "Right", positionLabel: "Right", wireId: "right" },
  { index: 6, label: "Left", positionLabel: "Left", wireId: "left" }
];

/* The buttons picker's choices, derived from the table above so the list a user picks from and the ids a press arrives under cannot drift apart. The stored value is
 * the wire id, since that is the identity the whole plugin addresses a button by.
 *
 * The label carries the controller's position number in parentheses only where it says something the label does not: the numbered buttons read "Arm (1)" through
 * "Panic (4)", which is how the settings page has always named them, while Right and Left carry no parenthetical because their position label IS their name and
 * "Right (Right)" tells a reader nothing.
 */
export const FOB_BUTTON_CHOICES: readonly FeatureOptionChoice[] = USL_FOB_BUTTONS.map((button) => ({

  label: (button.positionLabel === button.label) ? button.label : (button.label + " (" + button.positionLabel + ")"),
  value: button.wireId
}));

// The single region-agnostic chokepoint that decides which button table a fob record maps to, or null when the fob is not a recognized family. A fob is recognized when
// its marketName is exactly "USL Fob" OR its type carries the "USL-Fob-" family prefix, so a record missing both resolves to null rather than throwing. The parameter
// is structural with optional members because the wire type declares both fields required while the controller can omit either: the parameter states the runtime
// truth and keeps the nullish handling honest to the type checker, and a fob's full config is accepted directly, its required members being assignable to optional
// ones. The smoke detector's model-family predicate reads its two fields the same way.
export function resolveFobButtons(config: { readonly marketName?: string; readonly type?: string }): Nullable<readonly FobButton[]> {

  return ((config.marketName === "USL Fob") || (config.type?.startsWith("USL-Fob-") ?? false)) ? USL_FOB_BUTTONS : null;
}
