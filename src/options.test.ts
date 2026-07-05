/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * options.test.ts: Coverage of the timeshift catalog - the standing-buffer options, the direct-RTSP pins, and the absence of the superseded streaming and HKSV-record
 * option names from the catalog surface.
 *
 * The catalog is plain data (featureOptionCategories plus the featureOptions map), so these are pure structure assertions. The end-to-end resolution of the new names
 * through the engine is proven where it steers behavior (the doorbell-construction pixel-ceiling test pins a real Video.Timeshift.Only.High); this suite guards the
 * catalog shape itself, including the map-key hazard that would silently drop a category.
 */
import { describe, test } from "node:test";
import { featureOptionCategories, featureOptions } from "./options.ts";
import assert from "node:assert/strict";

// The option names defined under a category's options-map key, or an empty list when the key is absent.
function optionNames(category: string): string[] {

  return (featureOptions[category] ?? []).map((option) => option.name);
}

describe("feature-option retirement wave", () => {

  // The category entry (its webUI section and category-level meta gate) AND its options-map key must both exist - buildCatalogIndex silently skips a category with no
  // matching map key, so a present category entry alone would drop every option under it.
  test("the Video.Timeshift category is registered with both its catalog entry and its options-map key", () => {

    assert.ok(featureOptionCategories.some((category) => category.name === "Video.Timeshift"), "the Video.Timeshift category entry is present");
    assert.ok("Video.Timeshift" in featureOptions, "the Video.Timeshift options-map key is present, so the catalog does not silently drop the category");
  });

  // The category carries exactly the Video.HKSV parity gate - hidden for third-party cameras, scoped to cameras - and deliberately no isAdoptedByAccessApp hide, since
  // Access-adopted cameras join the streaming arm and the toggle does real work for them.
  test("the Video.Timeshift category carries the third-party-camera parity gate and no Access hide", () => {

    const category = featureOptionCategories.find((entry) => entry.name === "Video.Timeshift");

    assert.ok(category, "the category exists");
    assert.deepEqual(category.meta?.isNotProperty, ["isThirdPartyCamera"], "the category hides for third-party cameras and nothing else");
    assert.deepEqual(category.meta?.modelKey, ["camera"], "the category scopes to cameras");
  });

  // The standing-buffer options: the default-on livestreaming toggle plus the source-agnostic per-quality channel pins.
  test("the standing-buffer options are defined with their defaults", () => {

    assert.deepEqual(optionNames("Video.Timeshift"), [ "Livestream", "Only.High", "Only.Medium", "Only.Low" ],
      "the timeshift options are the livestream toggle and the three channel pins");
    assert.equal(featureOptions["Video.Timeshift"]?.find((option) => option.name === "Livestream")?.default, true, "buffer-backed livestreaming defaults on");
  });

  // The Video category's direct-RTSP quality pins are present, and the superseded Stream.UseApi toggle and Stream.Only.* pins are absent from the category.
  test("the direct-RTSP pins replaced the streaming options in the Video category", () => {

    const video = optionNames("Video");

    assert.ok([ "Rtsp.Only.High", "Rtsp.Only.Medium", "Rtsp.Only.Low" ].every((name) => video.includes(name)), "the direct-RTSP quality pins are present");
    assert.ok(!video.includes("Stream.UseApi"), "the retired Stream.UseApi toggle is gone");
    assert.ok(!video.some((name) => name.startsWith("Stream.Only")), "the retired streaming pins are gone");
  });

  // The Video.HKSV category's record pins are absent, and its other options remain unaffected.
  test("the HKSV record pins are retired while its other options survive", () => {

    const hksv = optionNames("Video.HKSV");

    assert.ok(!hksv.some((name) => name.startsWith("Record.Only")), "the retired HKSV record pins are gone");
    assert.ok([ "StatusLedIndicator", "Recording.Switch" ].every((name) => hksv.includes(name)), "the surviving HKSV options are untouched");
  });
});
