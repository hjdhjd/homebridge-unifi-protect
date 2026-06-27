/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * device-descriptor.ts: The pure consumer-side descriptor for rendering a UniFi Protect device or controller in a log line.
 *
 * This module owns one pure decision: how to render a Protect device or controller config as a human-readable log descriptor - "Name [Model]" plainly, or
 * "Name [Model] (address: IP mac: MAC)" with its network detail for support triage. It is deliberately pure - `this`-free, free of any device or controller I/O, and
 * free of imports - so any consumer (the nvr composition root or a device class) can import it without forming a value-edge that would couple the device layer to the
 * root or to a sibling device class (the device-layer module invariant), and the format is exhaustively testable from a plain config object.
 *
 * Why this lives in the plugin and not in the unifi-protect library: composing a human display string is presentation, which is a consumer concern. The library's job
 * is to expose structured fields (name, marketName, host, mac, type), and how a consumer formats them for a log line is the consumer's choice. This leaf establishes
 * the single source of truth for that format on the correct side of the boundary, so the discovery, unsupported, add, and remove log lines share one descriptor rather
 * than each re-deriving it inline.
 *
 * The format prefers the human marketName for the model label and falls back to the raw wire type; the displayed name falls back to the model when a device carries no
 * user-assigned name; and the optional network suffix carries the address (omitted when the host is empty) and the MAC.
 */

// The minimal config shape the descriptor reads. Every Protect device config and the NVR config satisfies it structurally, so the descriptor depends on exactly the
// fields it renders rather than on the full config unions - which keeps it a true leaf and lets a test drive it with a plain object.
interface DeviceDescriptorConfig {

  readonly host: string;
  readonly mac: string;
  readonly marketName: string;
  readonly name?: string;
  readonly type: string;
}

// Options for describeDevice. `includeNetwork` selects the rich "(address mac)" suffix; `name` overrides the displayed name - the controller passes its resolved
// controllerName here - and otherwise it falls back to the config's own name and then the model.
interface DescribeDeviceOptions {

  readonly includeNetwork?: boolean;
  readonly name?: string | null;
}

/**
 * Render a Protect device or controller config as a human-readable log descriptor.
 *
 * @param device - The device or NVR config to describe - any record carrying host, mac, marketName, an optional name, and type.
 * @param options - `includeNetwork` appends the address/MAC triage suffix; `name` overrides the displayed name.
 * @returns "Name [Model]" plainly, or "Name [Model] (address: IP mac: MAC)" when `includeNetwork` is set.
 */
export function describeDevice(device: DeviceDescriptorConfig, { includeNetwork = false, name }: DescribeDeviceOptions = {}): string {

  // The model label prefers the human marketName and falls back to the raw wire type. We use `||`, not `??`, deliberately: the wire can deliver marketName as an
  // empty string, and that empty string is the falsy edge we want to fall through on - `??` would keep it. Do not "correct" this to `??`.
  const model = device.marketName || device.type;

  // The displayed name prefers the explicit override, then the config's own name, and falls back to the model when a device carries no user-assigned name.
  const label = (name ?? device.name ?? model) + " [" + model + "]";

  if(!includeNetwork) {

    return label;
  }

  // The rich suffix carries the network detail for support triage. The address segment is omitted when the host is empty; the MAC is always emitted.
  return label + " (" + (device.host ? "address: " + device.host + " " : "") + "mac: " + device.mac + ")";
}
