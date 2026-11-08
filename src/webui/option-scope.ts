/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webui/option-scope.ts: Which feature options and option categories the settings page offers for a device.
 */
import type { FeatureCategoryEntry, FeatureOptionEntry } from "homebridge-plugin-utils";
import type { ProtectCategoryMeta, ProtectOptionMeta } from "../options.ts";

/* The settings page offers a device only the options its hardware can use. Each catalog entry declares what it needs in its meta, and the decisions here read those
 * declarations against the device record the controller sent, as the controller states it: feature flags name the hardware a device carries, while a property's
 * presence says only that the record has the field. That difference matters for sensors, whose records carry every settings block and every air-quality reading
 * whatever the sensor's hardware, so a sensor option gates on the sensor's feature flags or on a live reading rather than on a block being there.
 *
 * The module imports types alone, which the compiler erases, and names no browser global, so the page loads it compiled and the same decisions run under node against
 * controller records.
 */

// An air-quality reading as the controller sends it.
interface ScopedReading {

  status: string;
  value: number | null;
}

/** The fields of a controller device record the scope decisions read. Every other field of the record is read only for its presence. */
export interface ScopedDevice {

  [key: string]: unknown;
  accessDeviceMetadata?: { featureFlags?: Record<string, unknown> };
  airQuality?: Record<string, ScopedReading | undefined>;
  featureFlags?: Record<string, unknown> & { smartDetectTypes?: string[] };
  modelKey: string;
}

/* Whether an air-quality reading is live. The controller reports a reading its hardware does not measure as an "unknown" status carrying no value, and anything else
 * is live. The plugin decides the same thing with airQualityMetricLive in src/devices/air-quality-policy.ts, and the rule is kept here as well because the page loads
 * only the modules compiled from this folder. The settings page's tests hold the two to the same answers, so a change to either fails there first.
 */
const isLiveReading = (reading: ScopedReading | undefined): boolean => (reading !== undefined) && ((reading.value !== null) || (reading.status !== "unknown"));

/**
 * Decide whether the settings page offers an option for a device. Every option shows at the global and controller scopes. For a device, each gate the option's meta
 * declares must pass: the gates that apply to every device model first, then the gates of the device's own family.
 *
 * @param device - The device record, or undefined at the global scope.
 * @param option - The option's catalog entry.
 *
 * @returns True when the option applies to the device.
 */
export function validOption(device: ScopedDevice | undefined, option: FeatureOptionEntry<ProtectOptionMeta>): boolean {

  if(!device || (device.modelKey === "nvr")) {

    return true;
  }

  const meta: ProtectOptionMeta = option.meta ?? {};
  const flags = device.featureFlags;
  const smartDetectTypes = flags?.smartDetectTypes;

  // Each device's capability metadata takes a different shape, so each gate reads its own: hasAccessFeature reads the Access device's feature flags, hasFeature reads
  // the Protect device's feature flags, hasProperty checks whether the named property is merely present on the device, modelKey compares the device's own model
  // against the option's supported models, and hasSmartObjectType compares the device's smart detection capabilities against the option's supported object types.
  if((meta.hasAccessFeature && !meta.hasAccessFeature.some((flag) => device.accessDeviceMetadata?.featureFlags?.[flag])) ||
    (meta.hasFeature && !meta.hasFeature.some((flag) => flags?.[flag])) ||
    (meta.hasProperty && !meta.hasProperty.some((property) => property in device)) ||
    (meta.modelKey && !meta.modelKey.includes("all") && !meta.modelKey.includes(device.modelKey)) ||
    (meta.hasSmartObjectType && smartDetectTypes && !meta.hasSmartObjectType.some((type) => smartDetectTypes.includes(type)))) {

    return false;
  }

  switch(device.modelKey) {

    case "camera": {

      return !meta.hasCameraFeature || meta.hasCameraFeature.some((flag) => flags?.[flag]);
    }

    case "light": {

      return !meta.hasLightProperty || meta.hasLightProperty.some((property) => property in device);
    }

    case "sensor": {

      return (!meta.hasSensorProperty || meta.hasSensorProperty.some((property) => property in device)) &&
        (!meta.hasSensorFeature || meta.hasSensorFeature.some((flag) => flags?.[flag])) &&
        (!meta.hasAirQualityMetric || meta.hasAirQualityMetric.some((metric) => isLiveReading(device.airQuality?.[metric])));
    }

    default: {

      return true;
    }
  }
}

/**
 * Decide whether the settings page offers an option category for a device. Every category shows at the global and controller scopes. For a device, the category
 * must apply to the device's model, and the device must carry every feature flag the category requires of that model.
 *
 * @param device   - The device record, or undefined at the global scope.
 * @param category - The category's catalog entry.
 *
 * @returns True when the category applies to the device.
 */
export function validOptionCategory(device: ScopedDevice | undefined, category: FeatureCategoryEntry<ProtectCategoryMeta>): boolean {

  if(!device || (device.modelKey === "nvr")) {

    return true;
  }

  const appliesToModel = category.meta?.modelKey?.some((model) => [ "all", device.modelKey ].includes(model)) ?? false;
  const lacksRequiredFlag = category.meta?.featureByModel?.[device.modelKey]?.some((flag) => !device.featureFlags?.[flag]) ?? false;

  return appliesToModel && !lacksRequiredFlag;
}
