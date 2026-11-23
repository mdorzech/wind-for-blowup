// Shared fixtures: fakes for the forecast, the plug, the notifier and D1.
import { GoveeError } from "../src/govee.js";
import { NotifyError } from "../src/notify.js";

// 18:10 UTC. Forecast steps from makeOutlook are 18:00, 18:15, 18:30, 18:45, ...
export const NOW = new Date("2026-12-01T18:10:00Z");
export const PLUG_A = { sku: "H5080", device: "AA:BB:CC:DD:EE:FF:00:11" };
export const PLUG_B = { sku: "H5080", device: "11:00:FF:EE:DD:CC:BB:AA" };
export const quiet = { info() {}, warn() {}, error() {} };

export function makeConfig(overrides = {}) {
  return {
    latitude: 41.5,
    longitude: -87.5,
    gustThresholdMph: 20,
    resumeBelowMph: 17,
    sustainedThresholdMph: null,
    resumeBelowSustainedMph: null,
    lookaheadHours: 3,
    leadMinutes: 30,
    calmMinutes: 30,
    goveeApiKey: "test-key",
    devices: [PLUG_A],
    ntfyServer: "https://ntfy.example",
    ntfyTopic: "test-topic",
    statusPageUrl: "",
    ...overrides,
  };
}

/** Current gust plus one 15-minute step per extra value, starting 18:00 UTC; local time is UTC-6. */
export function makeOutlook(currentGust, ...forecastGusts) {
  const start = Date.parse("2026-12-01T18:00:00Z");
  const gusts = forecastGusts.length ? forecastGusts : [currentGust];
  return {
    currentSpeed: currentGust * 0.6,
    currentGust,
    readings: gusts.map((g, i) => ({ time: new Date(start + i * 15 * 60000), speed: g * 0.6, gust: g })),
    utcOffsetSeconds: -6 * 3600,
  };
}

export class FakePlug {
  constructor({ on = true, stateFails = false, offFails = false } = {}) {
    Object.assign(this, { on, stateFails, offFails });
    this.offCalls = [];
    this.reads = 0;
  }
  async isOn() {
    this.reads += 1;
    if (this.stateFails) throw new GoveeError("state unavailable");
    return this.on;
  }
  async turnOff(device) {
    if (this.offFails) throw new GoveeError("plug offline");
    this.offCalls.push(device);
    this.on = false;
  }
}

export class FakeNotifier {
  constructor({ fails = false } = {}) {
    this.fails = fails;
    this.sent = [];
  }
  async send(title, message, { urgent = false } = {}) {
    if (this.fails) throw new NotifyError("ntfy down");
    this.sent.push({ title, message, urgent });
  }
  get titles() {
    return this.sent.map((s) => s.title);
  }
}

/** In-memory stand-in for the D1 calls the Worker makes. */
export class FakeD1 {
  constructor() {
    this.rows = new Map();
  }
  prepare(sql) {
    const db = this;
    let args = [];
    const stmt = {
      bind(...values) {
        args = values;
        return stmt;
      },
      async first() {
        const value = db.rows.get(args[0]);
        return value === undefined ? null : { value };
      },
      async run() {
        if (sql.startsWith("CREATE")) return { meta: { changes: 0 } };
        if (sql.startsWith("DELETE")) {
          db.rows.delete("lock");
          return { meta: { changes: 1 } };
        }
        if (sql.includes("'lock'")) {
          const [value, olderThan] = args;
          const current = db.rows.get("lock");
          if (current === undefined || Number(current) < olderThan) {
            db.rows.set("lock", value);
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        }
        db.rows.set(args[0], args[1]);
        return { meta: { changes: 1 } };
      },
    };
    return stmt;
  }
  async batch(statements) {
    for (const s of statements) await s.run();
  }
  doc(key) {
    const v = this.rows.get(key);
    return v === undefined ? undefined : JSON.parse(v);
  }
}
