/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * device-descriptor.ts: The pure consumer-side renders of a UniFi Protect device or controller's displayed name, for a log line and for HomeKit.
 *
 * This module owns the pure renders of a Protect device or controller's identity: the model label a unit shows for itself, the name HomeKit shows for an accessory
 * standing for it, and the log descriptor composed around them - "Name [Model]" plainly, or "Name [Model] (address: IP mac: MAC)" with its network detail for
 * support triage. It is deliberately pure - `this`-free, free of any device or controller I/O, and holding one value import, HBPU's naming rule - so any consumer (the
 * nvr composition root, the controller's own accessories, a device class or the settings server) can import it without forming a value-edge that would couple the
 * device layer to the root or to a sibling device class, keeping the device layer's module graph free of cross-sibling value edges, and every render is exhaustively
 * testable from a plain config object.
 *
 * Why this lives in the plugin and not in the unifi-protect library: composing a human display string is presentation, which is a consumer concern. The library's job
 * is to expose structured fields (name, marketName, host, mac, type), and how a consumer formats them for a log line or a HomeKit name is the consumer's choice. This
 * leaf establishes the single source of truth for each on the correct side of the boundary, so the discovery, unsupported, add, and remove log lines share one
 * descriptor, and each accessory standing for a device or the controller itself is named by one rule, which a liveview switch falls back to, rather than each
 * re-deriving it inline.
 *
 * The format prefers the human marketName for the model label, falls back to the raw wire type, and renders "unknown" when a unit reports neither; the displayed name
 * falls back to the model when a unit carries no user-assigned name or an empty one, and in HomeKit, where the name is sanitized to what HomeKit accepts, also when the
 * name sanitizes to nothing, and a custom name the user set for a device in the plugin's settings comes ahead of them wherever HomeKit can carry it; and the optional
 * network suffix carries the address (omitted when the host is empty or absent) and the MAC.
 */
import { resolveNameOverride, sanitizeName } from "homebridge-plugin-utils";
import type { Nullable } from "homebridge-plugin-utils";

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

// Options for deviceDisplayName. `override` is the raw value of the device's Device.Name option, as the option engine answers it, which the name rule resolves itself so
// a caller may hand it over as read.
interface DeviceDisplayNameOptions {

  readonly override?: Nullable<string>;
}

/**
 * Treat an empty name as a missing one. An empty name names nothing, so it answers as absent and a `??` chain falls through it to the next name exactly as it falls
 * through a missing one.
 *
 * @param name - The name to read, or a missing one.
 *
 * @returns The name when it carries something, and `undefined` otherwise.
 */
export function nonEmptyName(name: Nullable<string> | undefined): string | undefined {

  return name?.length ? name : undefined;
}

/**
 * Render the model label for a Protect device or controller.
 *
 * @param device - Any record carrying the controller's market name and hardware type, either of which the wire may omit.
 *
 * @returns The market name, the hardware type when the unit reports no market name, or "unknown" when it reports neither.
 */
export function describeDeviceModel(device: DeviceModelConfig): string {

  // The label prefers the human marketName and falls back to the raw wire type. The wire can deliver either field as an empty string, which falls through as an
  // absent field does. A unit reporting neither field reads as "unknown", the same word the unifi-protect CLI inventory renders for it, so one device shows the same
  // model in the CLI and here.
  return nonEmptyName(device.marketName) ?? nonEmptyName(device.type) ?? "unknown";
}

/**
 * The name HomeKit shows for an accessory standing for a Protect device or controller, and the device's own name the rule passed over to reach it.
 */
export interface DeviceDisplayNaming {

  /** The name HomeKit shows, as HomeKit's naming rules leave it, which is never empty. */
  readonly name: string;

  /** The device's own name the rule passed over because HomeKit can display nothing of it, or `null` when a custom name applies or the rule passed over none. */
  readonly passedOver: Nullable<string>;
}

/**
 * Derive the name HomeKit shows for each accessory standing for a Protect device or controller itself, and the device's own name the rule passed over to reach it,
 * from one walk. An accessory named for more than its device composes its own name, and a liveview switch falls back to this rule when its composed name sanitizes
 * to nothing.
 *
 * @param device           - Any record carrying the model fields the label above reads and an optional user-assigned name.
 * @param options          - Optional. The device's custom name.
 * @param options.override - Optional. The raw value of the device's Device.Name option, resolved here through HBPU's custom-name rule.
 *
 * @returns The name: the sanitized custom name where one resolves, the sanitized name otherwise, the sanitized model label when the name sanitizes to nothing, or
 *          "unknown" when the model label does too. Beside it, the device's own name where it carries something and sanitizes to nothing, the name a user set on the
 *          controller and would look for in HomeKit, and `null` otherwise.
 */
export function deviceDisplayNaming(device: DeviceModelConfig & { name?: string }, { override }: DeviceDisplayNameOptions = {}): DeviceDisplayNaming {

  // HAP refuses an accessory whose display name is empty, and a name that is empty, blank or made only of characters HomeKit disallows sanitizes to nothing, so each
  // step falls through on an empty sanitized result rather than on an absent field alone. Whether a custom name counts at all is HBPU's rule, which refuses one HomeKit
  // can carry nothing of, so a refused one falls through to the device's own name as if the user had set none, and one it resolves names the device ahead of its own
  // name, which the walk then never passes over. The literal last step names the accessory when the model sanitizes away too.
  const custom = resolveNameOverride(override);

  if(custom !== null) {

    return { name: sanitizeName(custom), passedOver: null };
  }

  const name = sanitizeName(device.name ?? "");

  if(name.length) {

    return { name, passedOver: null };
  }

  return { name: sanitizeName(describeDeviceModel(device)) || "unknown", passedOver: nonEmptyName(device.name) ?? null };
}

/**
 * Derive the name HomeKit shows for each accessory standing for a Protect device or controller itself, the name {@link deviceDisplayNaming} answers.
 *
 * @param device           - Any record carrying the model fields the label above reads and an optional user-assigned name.
 * @param options          - Optional. The device's custom name.
 * @param options.override - Optional. The raw value of the device's Device.Name option, resolved here through HBPU's custom-name rule.
 *
 * @returns The sanitized custom name where one resolves, the sanitized name otherwise, the sanitized model label when the name sanitizes to nothing, or "unknown" when
 *          the model label does too.
 */
export function deviceDisplayName(device: DeviceModelConfig & { name?: string }, options: DeviceDisplayNameOptions = {}): string {

  return deviceDisplayNaming(device, options).name;
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

  // The displayed name prefers the explicit override, then the config's own name, and falls back to the model when a unit carries no user-assigned name or an empty
  // one, as the HomeKit name does. The log keeps the raw name rather than the sanitized one, so a line shows what the controller reports.
  const label = (nonEmptyName(name) ?? nonEmptyName(device.name) ?? model) + " [" + model + "]";

  if(!includeNetwork) {

    return label;
  }

  // The rich suffix carries the network detail for support triage. The address segment is omitted when the host is empty; the MAC is always emitted.
  return label + " (" + (device.host ? "address: " + device.host + " " : "") + "mac: " + device.mac + ")";
}
