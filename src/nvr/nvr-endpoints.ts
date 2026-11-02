/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * nvr-endpoints.ts: The walk over every HomeKit device endpoint a controller manages, and the active-recording count taken over it.
 *
 * A package camera hangs off the doorbell capability composed on its parent camera rather than off the controller's configured devices, so every controller-wide push
 * or read walks the endpoints this module yields instead of hand-fanning the package at each site, and the controller root and its test double count active
 * recordings over that one walk. The walk narrows by the camera class, which this module value-imports, so it lives apart from the pure policy leaf, which imports
 * nothing with a lifetime.
 */
import { ProtectCamera } from "../devices/cameras/camera.ts";
import type { ProtectDevice } from "../devices/device.ts";
import type { ProtectDevices } from "../types.ts";
import { countActiveRecordingViews } from "./nvr-policy.ts";

/**
 * Every HomeKit device endpoint a controller manages: each configured device and, immediately after a camera-family device that carries one, its package camera. Any
 * controller-wide push or read (the connection loop's notice, the probesize reset, the disconnect teardown, the scheduled reboot's active-recording count) walks this
 * iterator. A consumer that needs camera-typed members narrows with instanceof ProtectCamera - sound and cast-free, since package cameras are ProtectCamera
 * subclasses, and the parent's packageCamera getter delegates to the capability.
 *
 * @param devices - The controller's configured devices.
 *
 * @returns An iterator over every endpoint, each package camera right after its parent.
 */
export function *deviceEndpoints(devices: ReadonlyMap<string, ProtectDevices>): Generator<ProtectDevice> {

  for(const device of devices.values()) {

    yield device;

    if((device instanceof ProtectCamera) && device.packageCamera) {

      yield device.packageCamera;
    }
  }
}

/**
 * How many camera views a controller manages are actively transmitting HKSV recordings, which is what the scheduled reboot's deferral decision rests on. Every camera
 * view counts - package cameras alongside their parents - because a package recording an event has as much claim to finish it as its parent does, and the endpoints
 * walk is what reaches both. The walk is this module's, while the counting rule itself lives once in nvr-policy.ts.
 *
 * @param devices - The controller's configured devices.
 *
 * @returns How many camera views are transmitting.
 */
export function countActiveHksvRecordings(devices: ReadonlyMap<string, ProtectDevices>): number {

  const views: ProtectCamera[] = [];

  for(const device of deviceEndpoints(devices)) {

    if(!(device instanceof ProtectCamera)) {

      continue;
    }

    views.push(device);
  }

  return countActiveRecordingViews(views);
}
