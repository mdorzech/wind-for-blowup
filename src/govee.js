// Govee Open API client. It can read plug state and switch plugs OFF, never on.
import { HttpError, requestJson } from "./http.js";

export class GoveeError extends Error {}

const BASE_URL = "https://openapi.api.govee.com/router/api/v1";
const ON_OFF = "devices.capabilities.on_off";

export class GoveeClient {
  constructor(apiKey, fetchJson = requestJson) {
    this.headers = { "Govee-API-Key": apiKey };
    this.fetchJson = fetchJson;
  }

  async call(method, path, body) {
    let reply;
    try {
      reply = await this.fetchJson(method, BASE_URL + path, { headers: this.headers, body });
    } catch (err) {
      if (err instanceof HttpError) throw new GoveeError(err.message);
      throw err;
    }
    if (!reply || typeof reply !== "object" || Array.isArray(reply) || reply.code !== 200) {
      const code = reply && typeof reply === "object" && "code" in reply ? reply.code : "?";
      throw new GoveeError(`Govee rejected the request (code ${code})`);
    }
    return reply;
  }

  /** Every device on the account and whether it has an on/off switch. */
  async listDevices() {
    const data = (await this.call("GET", "/user/devices")).data || [];
    return data.map((item) => ({
      name: item.deviceName || "",
      sku: item.sku || "",
      device: item.device || "",
      switchable: (item.capabilities || []).some((c) => c.type === ON_OFF),
    }));
  }

  /** true/false for the plug's power state, or null when Govee does not report it. */
  async isOn(device) {
    const reply = await this.call("POST", "/device/state", {
      requestId: crypto.randomUUID(),
      payload: { sku: device.sku, device: device.device },
    });
    for (const capability of reply.payload?.capabilities || []) {
      if (capability.type === ON_OFF) {
        const value = capability.state?.value;
        if (value === 0 || value === 1) return value === 1;
      }
    }
    return null;
  }

  async turnOff(device) {
    await this.call("POST", "/device/control", {
      requestId: crypto.randomUUID(),
      payload: {
        sku: device.sku,
        device: device.device,
        capability: { type: ON_OFF, instance: "powerSwitch", value: 0 },
      },
    });
  }
}
