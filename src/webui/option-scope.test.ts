/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webui/option-scope.test.ts: The settings page's option and category scoping, run against the real option catalog and controller-shaped device records.
 *
 * The sensor records are the shapes controllers send. Every sensor carries the same settings blocks and the same air-quality block whatever its hardware, and the
 * models differ in the feature flags they advertise and the readings they report, so a gate that reads a block's presence offers every sensor the same options. The
 * flags below are each model's own as controllers report them, the UP Air Quality's empty flags and live vape reading among them. The live-reading rule the page keeps
 * is held to the plugin's own airQualityMetricLive over one table of readings, so a change to either fails here.
 */
import type { FeatureCategoryEntry, FeatureOptionEntry } from "homebridge-plugin-utils";
import { NOT_CAPABLE_METRIC, airQualityMetricLive } from "../devices/air-quality-policy.ts";
import type { ProtectCategoryMeta, ProtectOptionMeta } from "../options.ts";
import { describe, test } from "node:test";
import { featureOptionCategories, featureOptions } from "../options.ts";
import { validOption, validOptionCategory } from "./option-scope.ts";
import type { ProtectAirQualityMetric } from "unifi-protect";
import type { ScopedDevice } from "./option-scope.ts";
import assert from "node:assert/strict";

// One option's catalog entry, by its category key and its own name. A test that names an option the catalog no longer carries fails here rather than passing on nothing.
function option(category: string, name: string): FeatureOptionEntry<ProtectOptionMeta> {

  const entry = featureOptions[category]?.find((candidate) => candidate.name === name);

  assert.ok(entry, "the catalog carries " + category + "." + name);

  return entry;
}

// One category's catalog entry, by its name.
function category(name: string): FeatureCategoryEntry<ProtectCategoryMeta> {

  const entry = featureOptionCategories.find((candidate) => candidate.name === name);

  assert.ok(entry, "the catalog carries the " + name + " category");

  return entry;
}

// A single-channel hardware advertisement, the shape a feature flag takes for most sensor hardware.
const CHANNEL = { channelCount: 1 };

// The vape reading a UP Air Quality reports while nothing is detected: live, at zero.
const IDLE_VAPE: ProtectAirQualityMetric = { status: "neutral", value: 0 };

// A sensor record: the settings blocks and the air-quality block every sensor carries, with the model's own feature flags and readings.
function sensor(options: { featureFlags: Record<string, unknown>; internalLeakEnabled?: boolean; vape?: ProtectAirQualityMetric }): ScopedDevice {

  return {

    airQuality: { co2: NOT_CAPABLE_METRIC, vape: options.vape ?? NOT_CAPABLE_METRIC },
    featureFlags: options.featureFlags,
    leakSettings: { isExternalEnabled: false, isInternalEnabled: options.internalLeakEnabled ?? false },
    ledSettings: { activityFeedback: true, isEnabled: true },
    lightSettings: { highThreshold: null, isEnabled: false, lowThreshold: null, margin: 10 },
    modelKey: "sensor"
  };
}

// The sensor models, each with the feature flags it advertises. The UP Air Quality advertises no flags at all, and carries a leak setting turned on with no leak
// hardware behind it.
const SENSORS = {

  "UP Air Quality": sensor({ featureFlags: {}, internalLeakEnabled: true, vape: IDLE_VAPE }),
  "UP Sense": sensor({ featureFlags: { acceleration: CHANNEL, alarmTypes: [ "smoke", "CO" ], button: CHANNEL, humidity: CHANNEL, isBidirectional: true, led: CHANNEL,
    light: CHANNEL, motion: CHANNEL, open: CHANNEL, smoke: CHANNEL, tamper: CHANNEL, temperature: CHANNEL,
    waterLeak: { channelCount: 1, channelNames: ["internal"] } } }),
  "USL Entry": sensor({ featureFlags: { button: CHANNEL, isBidirectional: true, led: CHANNEL, open: CHANNEL, tamper: CHANNEL } }),
  "USL Environmental": sensor({ featureFlags: { button: CHANNEL, humidity: CHANNEL, isBidirectional: true, light: CHANNEL, temperature: CHANNEL,
    waterLeak: { channelCount: 2, channelNames: [ "internal", "external" ] } } }),
  "USL Smoke": sensor({ featureFlags: { alarmTypes: [ "smoke", "CO" ], button: CHANNEL, isBidirectional: true, smoke: CHANNEL } })
} satisfies Record<string, ScopedDevice>;

describe("the settings page's sensor option scoping", () => {

  // Each model is offered exactly the options its hardware can use. Every model has a status light, and the ambient light, leak, and vape options follow the hardware
  // each model advertises rather than the settings blocks every sensor carries.
  test("each sensor model is offered the options its hardware can use", () => {

    const cases = [

      { ambient: false, device: SENSORS["UP Air Quality"], leak: false, model: "UP Air Quality", vape: true },
      { ambient: true, device: SENSORS["UP Sense"], leak: true, model: "UP Sense", vape: false },
      { ambient: false, device: SENSORS["USL Entry"], leak: false, model: "USL Entry", vape: false },
      { ambient: true, device: SENSORS["USL Environmental"], leak: true, model: "USL Environmental", vape: false },
      { ambient: false, device: SENSORS["USL Smoke"], leak: false, model: "USL Smoke", vape: false }
    ];

    for(const { ambient, device, leak, model, vape } of cases) {

      assert.equal(validOption(device, option("Device", "AmbientLightSensor")), ambient, model + ": the ambient light sensor");
      assert.equal(validOption(device, option("Sensor", "MoistureSensor")), leak, model + ": the leak contact sensor");
      assert.equal(validOption(device, option("Sensor", "Vape")), vape, model + ": the vape contact sensor");
      assert.equal(validOption(device, option("Device", "StatusLed.Switch")), true, model + ": the status light switch");
    }
  });

  // The page keeps its own copy of the live-reading rule, since it loads only the modules compiled from its folder. Every form a reading takes must get the plugin's
  // answer, so the vape option is offered exactly when the plugin would stand up the vape sensor's reading.
  test("the live-reading rule agrees with the plugin's own for every form a reading takes", () => {

    const readings: ProtectAirQualityMetric[] = [ NOT_CAPABLE_METRIC, IDLE_VAPE, { status: "unknown", value: 3 }, { status: "neutral", value: null },
      { status: "", value: null }, { status: "high", value: 12 } ];
    const vape = option("Sensor", "Vape");

    for(const reading of readings) {

      assert.equal(validOption(sensor({ featureFlags: {}, vape: reading }), vape), airQualityMetricLive(reading), "the reading " + JSON.stringify(reading));
    }
  });
});

describe("the settings page's option and category scoping across device models", () => {

  // The global and controller scopes hold every option, since a setting made there reaches devices of every model.
  test("every option and category shows at the global and controller scopes", () => {

    const controller: ScopedDevice = { modelKey: "nvr" };

    for(const entry of Object.values(featureOptions).flat()) {

      assert.equal(validOption(undefined, entry), true, "the global scope offers " + entry.name);
      assert.equal(validOption(controller, entry), true, "the controller scope offers " + entry.name);
    }

    for(const entry of featureOptionCategories) {

      assert.equal(validOptionCategory(undefined, entry), true, "the global scope offers the " + entry.name + " category");
      assert.equal(validOptionCategory(controller, entry), true, "the controller scope offers the " + entry.name + " category");
    }
  });

  // A camera's gates read its own feature flags, as a sensor's do.
  test("a camera is offered the ambient light sensor only when it has one", () => {

    const ambient = option("Device", "AmbientLightSensor");

    assert.equal(validOption({ featureFlags: { hasLuxCheck: true }, modelKey: "camera" }, ambient), true, "a camera with an ambient light sensor");
    assert.equal(validOption({ featureFlags: { hasLuxCheck: false }, modelKey: "camera" }, ambient), false, "a camera without one");
  });

  // An option's model scope names the models it applies to, and "all" names every model.
  test("an option applies to the models its scope names", () => {

    const scoped = (modelKey: string[]): FeatureOptionEntry<ProtectOptionMeta> => ({ default: false, description: "A scoped option.", meta: { modelKey },
      name: "Scoped" });

    assert.equal(validOption(SENSORS["USL Entry"], scoped(["all"])), true, "an option for every model applies to a sensor");
    assert.equal(validOption(SENSORS["USL Entry"], scoped([ "camera", "sensor" ])), true, "an option naming sensors applies to a sensor");
    assert.equal(validOption(SENSORS["USL Entry"], scoped(["camera"])), false, "an option naming only cameras does not apply to a sensor");
  });

  // A category applies to the models it names, and where it requires feature flags of a model, only to a device of that model carrying them.
  test("a category applies to the models it names and the hardware it requires of them", () => {

    assert.equal(validOptionCategory(SENSORS["USL Smoke"], category("Device")), true, "the device-wide category applies to every model");
    assert.equal(validOptionCategory(SENSORS["USL Entry"], category("Sensor")), true, "the sensor category applies to a sensor");
    assert.equal(validOptionCategory({ featureFlags: {}, modelKey: "camera" }, category("Sensor")), false, "the sensor category does not apply to a camera");
    assert.equal(validOptionCategory(SENSORS["UP Sense"], category("Motion")), true, "the motion category applies to a sensor with motion hardware");
    assert.equal(validOptionCategory(SENSORS["USL Entry"], category("Motion")), false, "the motion category does not apply to a sensor without it");
  });
});
