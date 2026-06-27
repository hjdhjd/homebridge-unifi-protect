/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * smart-detect-metadata.ts: Per-type rich-metadata rendering for UniFi Protect smart detections.
 */
import type { Nullable } from "homebridge-plugin-utils";
import type { ProtectEventMetadataDetectedThumbnail } from "unifi-protect";

/**
 * A single detected smart-object occurrence, as the event router assembles it from the classified firehose. It carries the object type plus the optional rich-detection
 * fields the controller attaches: a license-plate string in `name`, a `confidence` score, and the structured thumbnail `payload` whose `attributes` hold per-type
 * telemetry such as a vehicle's color and body type.
 */
export interface SmartDetectEventItem {

  confidence?: number;
  name?: string;
  payload?: ProtectEventMetadataDetectedThumbnail;
  type: string;
}

/**
 * A per-type renderer for the rich metadata a smart detection carries.
 *
 * The {@link SMART_DETECT_ENRICHERS} registry maps a smart-detection object type to its enricher and is the single source of truth for how that type's telemetry is
 * surfaced - both as the human-readable attribute fragments appended to the log line and as the structured payload mirrored to MQTT. Supporting a new type as UniFi
 * Protect ships richer metadata for it is one new registry entry; the delivery and log-dedup policy in the event router are generic over this interface and need no
 * change.
 */
export interface SmartDetectEnricher {

  /** The human-readable attribute fragments for this detection, e.g. `[ "color: black [68% confidence]", "vehicleType: suv [96% confidence]" ]`. Returns an empty array
   * when the controller has not yet attached any rich metadata, which the router treats as a plain detection and coalesces onto the shared log line. The router re-logs a
   * detection only when this list grows IN LENGTH, so progressively-enriched telemetry is captured at its fullest without re-logging the in-window noise; a later
   * same-length re-read that only changes existing values does not re-log. An enricher should therefore surface each new piece of telemetry as an additional fragment.
   */
  readonly attributes: (item: SmartDetectEventItem) => string[];

  /** The structured payload mirrored to the type's `motion/smart/<type>/metadata` MQTT topic, or `null` when there is no metadata to publish. */
  readonly mqtt: (item: SmartDetectEventItem) => Nullable<Record<string, unknown>>;
}

// Render a single "<label>: <value> [<confidence>% confidence]" fragment, the shared shape every rich attribute uses in the log line.
function attributeFragment(label: string, value: string, confidence: number): string {

  return label + ": " + value + " [" + String(confidence) + "% confidence]";
}

/* The vehicle enricher. UniFi Protect attaches a license plate (as the detection's `name`), a body color, and a body type to a vehicle smart detection, and these arrive
 * progressively as the controller analyzes the clip. We surface whichever are present, in a stable order, so the log line and the MQTT payload grow coherently as the
 * controller enriches the detection.
 */
const vehicleEnricher: SmartDetectEnricher = {

  attributes: (item: SmartDetectEventItem): string[] => {

    const attributes: string[] = [];

    // The license plate arrives as the detection's name, carrying the detection-level confidence.
    if(item.name) {

      attributes.push(attributeFragment("license plate", item.name, item.confidence ?? 0));
    }

    // Color and body type arrive as structured thumbnail attributes, each with its own confidence.
    for(const attribute of [ "color", "vehicleType" ] as const) {

      const detail = item.payload?.attributes?.[attribute];

      if(detail) {

        attributes.push(attributeFragment(attribute, detail.val ?? "", detail.confidence ?? 0));
      }
    }

    return attributes;
  },

  mqtt: (item: SmartDetectEventItem): Nullable<Record<string, unknown>> => {

    const color = item.payload?.attributes?.color;
    const vehicleType = item.payload?.attributes?.vehicleType;

    // With no plate, color, or body type there is nothing structured to publish.
    if(!item.name?.length && !color && !vehicleType) {

      return null;
    }

    return {

      ...(Number.isFinite(item.confidence) && { confidence: item.confidence }),
      ...(item.name?.length && { name: item.name }),
      type: item.type,
      ...(color && { color }),
      ...(vehicleType && { vehicleType })
    };
  }
};

/* The registry mapping a smart-detection object type to its rich-metadata enricher. Today only vehicles carry structured telemetry; as UniFi Protect ships richer
 * metadata for other smart-detection types (packages, animals, faces, ...), each becomes one new entry here and the event router's generic delivery picks it up with no
 * further change. Types absent from this map are plain detections: the router coalesces them onto a single log line and never re-logs them within a motion window.
 */
export const SMART_DETECT_ENRICHERS: ReadonlyMap<string, SmartDetectEnricher> = new Map<string, SmartDetectEnricher>([

  [ "vehicle", vehicleEnricher ]
]);
