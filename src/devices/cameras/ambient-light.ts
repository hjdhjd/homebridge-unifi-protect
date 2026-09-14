/* Copyright(C) 2019-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ambient-light.ts: Ambient light capability for UniFi Protect cameras.
 */
import type { Camera, ProtectCameraConfig } from "unifi-protect";
import type { ProtectCamera } from "./camera.ts";
import { ProtectDeviceCapability } from "../device-capability.ts";
import type { ProtectNvr } from "../../nvr/nvr.ts";
import type { Service } from "homebridge";
import type { WithoutIdentity } from "../../types.ts";
import { capabilityGate } from "homebridge-plugin-utils";
import { mqttTopics } from "../../mqtt.ts";

/* The ambient light capability composed onto a ProtectCamera: the HomeKit LightSensor a camera with lux-reading hardware advertises, its 60-second controller poll, its
 * two read handlers, and its MQTT reading. The whole surface is capability-held - the last-known reading lives here and nothing outside this class touches it - which is
 * what makes the boundary clean enough to own: the host's only interest in it is the one availability push below.
 *
 * It implements reconcile() and not configure(): every line of its body is convergence. The gate re-decides the sensor's existence from live capability and user state,
 * the service is acquired get-or-create, and the handlers and the poll are RE-BOUND on every call rather than only on first creation. That re-bind is not redundant
 * work...re-binding an onGet replaces the single handler (handlers do not stack) and the registry's keyed setInterval replaces its timer, so a repeat call is a no-op
 * that costs one cheap controller read, and it is exactly what re-establishes the runtime wiring after a Homebridge restart, which restores the cached LightSensor
 * service but never its handlers or its poll.
 *
 * TEARDOWN. The poll needs no presence check of its own. The inherited timer registry is bound to this capability's lifetime signal, so an abort at any level - the
 * controller connection, the host camera, or this capability - drains the armed interval and makes any later registration inert; a timer can never fire into a torn-down
 * capability. What the drain cannot retract is a continuation already suspended at the poll's controller read, so the poll re-checks that signal after its await, before
 * it writes to HomeKit or MQTT.
 */
export class AmbientLightCapability extends ProtectDeviceCapability<ProtectCamera> {

  // The live Camera projection this capability reads and calls lux() against, handed in by the owning camera at construction.
  readonly #device: Camera;
  // The last-known ambient light reading, in lux. Seeded to zero, which HomeKit cannot represent, so the first genuine read (or the initial-read floor below) replaces it
  // before anything displays it. It is the poll's change-detection baseline and the value the CurrentAmbientLightLevel handler reports.
  #ambientLight = 0;

  // Construct the capability against its owning camera. The camera passes itself, its own live projection handle, and its protected per-accessory signal from inside its
  // own class body, so no visibility widening is needed.
  constructor(nvr: ProtectNvr, init: { device: Camera; host: ProtectCamera; signal: AbortSignal }) {

    super(nvr, { host: init.host, signal: init.signal });

    this.#device = init.device;
  }

  // The owning camera projection's live STATE, narrowed to drop device identity (id/mac/modelKey) - the capability-held projection each capability types for itself,
  // since the host contract deliberately exposes neither the projection nor its config view.
  private get ufp(): Readonly<WithoutIdentity<ProtectCameraConfig>> {

    return this.#device.config;
  }

  // Converge the ambient light sensor against the camera's lux capability and the user's toggle.
  public override async reconcile(): Promise<void> {

    // Gate the ambient light sensor on the camera's lux capability (conservative) and the user's Device.AmbientLightSensor toggle (absolute) via capabilityGate; the gate
    // sits above the poll registration below, so a hidden sensor registers no interval.
    if(!this.validService(this.hap.Service.LightSensor,
      capabilityGate({ capability: this.ufp.featureFlags.hasLuxCheck, toggle: this.hasFeature("Device.AmbientLightSensor") }))) {

      return;
    }

    // Acquire the service.
    const service = this.acquireService(this.hap.Service.LightSensor, undefined, undefined, (lightSensorService: Service) => {

      lightSensorService.addOptionalCharacteristic(this.hap.Characteristic.StatusActive);
    });

    // Read the camera's current lux level, mapping every failure to the -1 no-reading sentinel that both callers below skip on.
    const getLux = async (): Promise<number> => {

      // Skip the query when the controller or camera is unreachable; the request would only fail.
      if(!this.isReachable) {

        return -1;
      }

      try {

        // The library validates the reading and throws on a malformed body, so any failure - unreachable mid-flight, a non-2xx, or a non-numeric reading - means "no
        // reading" and we skip the update; a genuine zero reading is floored to HomeKit's 0.0001 minimum.
        let lux = await this.#device.lux();

        lux ||= 0.0001;

        return lux;
      } catch {

        return -1;
      }
    };

    // Update the ambient light sensor at regular intervals.
    const updateAmbientLight = async (): Promise<void> => {

      // Grab the current ambient light level.
      const lux = await getLux();

      // A teardown that lands while the read is in flight cannot retract this continuation: the registry's drain stops the NEXT fire, but this one is already past its
      // timer and suspended at the await. So we re-check our own lifetime before writing anything, and a capability torn down mid-read writes to neither HomeKit nor
      // MQTT.
      if(this.signal.aborted) {

        return;
      }

      // Nothing to update, we're done.
      if((this.#ambientLight === lux) || (lux === -1)) {

        return;
      }

      // Update the sensor.
      service.updateCharacteristic(this.hap.Characteristic.CurrentAmbientLightLevel, this.#ambientLight = lux);

      // Publish the state.
      this.publish(mqttTopics.ambientlight.topic, this.#ambientLight.toString());
    };

    // Poll every 60 seconds - ambient light changes slowly enough that a faster cadence would only add controller chatter without a visible HomeKit benefit.
    this.timers.setInterval("ambientLight", () => void updateAmbientLight(), 60 * 1000);

    // Retrieve the active state when requested.
    service.getCharacteristic(this.hap.Characteristic.StatusActive).onGet(() => this.isReachable);

    // Initialize the sensor's reading. We adopt only a genuine reading: a failed read (-1 - the camera unreachable, or the lux capability transiently withdrawn during a
    // controller reconnect) leaves the last-known value in place rather than stamping the HomeKit display to the floor, mirroring the 60-second poll's skip-on-(-1) guard
    // above. On the first reconcile there is no prior reading - the field seeds 0, which HomeKit cannot represent - so we floor to the minimum only in that case.
    const reading = await getLux();

    if(reading !== -1) {

      this.#ambientLight = reading;
    } else if(this.#ambientLight === 0) {

      this.#ambientLight = 0.0001;
    }

    // Retrieve the current light level when requested.
    service.getCharacteristic(this.hap.Characteristic.CurrentAmbientLightLevel).onGet(() => this.#ambientLight);

    service.updateCharacteristic(this.hap.Characteristic.CurrentAmbientLightLevel, this.#ambientLight);
    service.updateCharacteristic(this.hap.Characteristic.StatusActive, this.isReachable);
  }

  // Reflect the host's reachability onto the sensor's StatusActive characteristic, composed by the camera's availability projection. The service is resolved at call time
  // rather than held, so a push that arrives before the first reconcile - or after the gate has pruned the sensor - finds nothing and no-ops.
  public updateAvailability(): void {

    this.accessory.getService(this.hap.Service.LightSensor)?.updateCharacteristic(this.hap.Characteristic.StatusActive, this.isReachable);
  }
}
