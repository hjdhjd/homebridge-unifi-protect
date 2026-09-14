/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * device-descriptor.ts: The pure consumer-side descriptor for rendering a UniFi Protect device or controller in a log line.
 *
 * This module owns the pure renders of a Protect device or controller's hardware identity: the model label a unit shows for itself, and the log descriptor composed
 * around it - "Name [Model]" plainly, or "Name [Model] (address: IP mac: MAC)" with its network detail for support triage. It is deliberately pure - `this`-free,
 * free of any device or controller I/O, and free of imports - so any consumer (the nvr composition root or a device class) can import it without forming a value-edge
 * that would couple the device layer to the root or to a sibling device class, keeping the device layer's module graph free of cross-sibling value edges, and both
 * renders are exhaustively testable from a plain config object.
 *
 * Why this lives in the plugin and not in the unifi-protect library: composing a human display string is presentation, which is a consumer concern. The library's job
 * is to expose structured fields (name, marketName, host, mac, type), and how a consumer formats them for a log line is the consumer's choice. This leaf establishes
 * the single source of truth for that format on the correct side of the boundary, so the discovery, unsupported, add, and remove log lines share one descriptor rather
 * than each re-deriving it inline.
 *
 * The format prefers the human marketName for the model label, falls back to the raw wire type, and renders "unknown" when a unit reports neither; the displayed name
 * falls back to the model when a device carries no user-assigned name; and the optional network suffix carries the address (omitted when the host is empty or absent)
 * and the MAC.
 */

// The two fields a Protect device or controller reports its hardware by. The controller omits the market name on some units and the hardware type on others, so both
// members are optional and every model read takes whichever one the unit reports.
interface DeviceModelConfig {

  readonly marketName?: string;
  readonly type?: string;
}

// The minimal config shape the descriptor reads - the model fields above plus the identity and network fields it renders. Every Protect device config and the NVR
// config satisfies it structurally, so the descriptor depends on exactly the fields it renders rather than on the full config unions - which keeps it a true leaf and
// lets a test drive it with a plain object. host is nullable because a LoRa device (a relay, a fob) reports no address at all; the render already treats a falsy host
// as "no address", so a null simply omits the address segment.
interface DeviceDescriptorConfig extends DeviceModelConfig {

  readonly host: string | null;
  readonly mac: string;
  readonly name?: string;
}

// Options for describeDevice. `includeNetwork` selects the rich "(address mac)" suffix; `name` overrides the displayed name - the controller passes its resolved
// controllerName here - and otherwise it falls back to the config's own name and then the model.
interface DescribeDeviceOptions {

  readonly includeNetwork?: boolean;
  readonly name?: string | null;
}

/**
 * Render the model label for a Protect device or controller.
 *
 * @param device - Any record carrying the controller's market name and hardware type, either of which the wire may omit.
 *
 * @returns The market name, the hardware type when the unit reports no market name, or "unknown" when it reports neither.
 */
export function describeDeviceModel(device: DeviceModelConfig): string {

  // The label prefers the human marketName and falls back to the raw wire type. We use `||`, not `??`, deliberately: the wire can deliver either field as an empty
  // string, and that empty string is the falsy edge we want to fall through on - `??` would keep it. Do not "correct" this to `??`. A unit reporting neither
  // field reads as "unknown", the same word the unifi-protect CLI inventory renders for it, so one device shows the same model in the CLI and here.
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- The falsy fall-through is the rule itself; `??` would keep an empty market name.
  return device.marketName || device.type || "unknown";
}

/**
 * Render a Protect device or controller config as a human-readable log descriptor.
 *
 * @param device - The device or NVR config to describe - any record carrying host, mac, an optional name, and the model fields the resolver above reads.
 * @param options - `includeNetwork` appends the address/MAC triage suffix; `name` overrides the displayed name.
 * @returns "Name [Model]" plainly, or "Name [Model] (address: IP mac: MAC)" when `includeNetwork` is set.
 */
export function describeDevice(device: DeviceDescriptorConfig, { includeNetwork = false, name }: DescribeDeviceOptions = {}): string {

  const model = describeDeviceModel(device);

  // The displayed name prefers the explicit override, then the config's own name, and falls back to the model when a device carries no user-assigned name.
  const label = (name ?? device.name ?? model) + " [" + model + "]";

  if(!includeNetwork) {

    return label;
  }

  // The rich suffix carries the network detail for support triage. The address segment is omitted when the host is empty; the MAC is always emitted.
  return label + " (" + (device.host ? "address: " + device.host + " " : "") + "mac: " + device.mac + ")";
}
