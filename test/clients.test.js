import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConfigError, loadConfig, parseDevices } from "../src/config.js";
import { GoveeClient, GoveeError } from "../src/govee.js";
import { addCheck, KEEP_EVENTS, normalizeHistory } from "../src/history.js";
import { HttpError, requestJson } from "../src/http.js";
import { Notifier, NotifyError } from "../src/notify.js";
import { WeatherError, fetchOutlook, firstTimeAtOrAbove, parseOutlook, peakGust, peakTime } from "../src/weather.js";
import { NOW, PLUG_A, makeConfig, quiet } from "./helpers.js";

const ENV = {
  LATITUDE: "41.5",
  LONGITUDE: "-87.5",
  GOVEE_API_KEY: "key",
  GOVEE_DEVICES: "H5080|AA:BB:CC:DD:EE:FF:00:11",
  NTFY_TOPIC: "my-topic_1",
};

describe("config", () => {
  it("has sensible defaults", () => {
    const cfg = loadConfig(ENV);
    assert.equal(cfg.gustThresholdMph, 20);
    assert.equal(cfg.resumeBelowMph, 17);
    assert.equal(cfg.lookaheadHours, 3);
    assert.equal(cfg.leadMinutes, 30);
    assert.equal(cfg.calmMinutes, 30);
    assert.equal(cfg.ntfyServer, "https://ntfy.sh");
    assert.deepEqual(cfg.devices, [{ sku: "H5080", device: "AA:BB:CC:DD:EE:FF:00:11" }]);
  });

  it("rejects bad values with a message naming the setting", () => {
    const cases = [
      [{ GUST_THRESHOLD_MPH: "0" }, "GUST_THRESHOLD_MPH"],
      [{ GUST_THRESHOLD_MPH: "fast" }, "GUST_THRESHOLD_MPH"],
      [{ RESUME_BELOW_MPH: "30" }, "RESUME_BELOW_MPH"],
      [{ LOOKAHEAD_HOURS: "0" }, "LOOKAHEAD_HOURS"],
      [{ LOOKAHEAD_HOURS: "2.5" }, "LOOKAHEAD_HOURS"],
      [{ LEAD_MINUTES: "-5" }, "LEAD_MINUTES"],
      [{ LOOKAHEAD_HOURS: "1", LEAD_MINUTES: "90" }, "LEAD_MINUTES"],
      [{ CALM_MINUTES: "-1" }, "CALM_MINUTES"],
      [{ NTFY_SERVER: "http://ntfy.sh" }, "NTFY_SERVER"],
      [{ STATUS_PAGE_URL: "javascript:alert(1)" }, "STATUS_PAGE_URL"],
      [{ LATITUDE: "" }, "LATITUDE"],
      [{ LATITUDE: "north" }, "LATITUDE"],
      [{ LATITUDE: "91" }, "LATITUDE"],
      [{ LONGITUDE: "-181" }, "LONGITUDE"],
      [{ GOVEE_API_KEY: " " }, "GOVEE_API_KEY"],
      [{ GOVEE_DEVICES: "" }, "GOVEE_DEVICES"],
      [{ GOVEE_DEVICES: "H5080" }, "GOVEE_DEVICES"],
      [{ NTFY_TOPIC: "bad topic/../x" }, "NTFY_TOPIC"],
    ];
    for (const [change, name] of cases) {
      assert.throws(() => loadConfig({ ...ENV, ...change }), (err) => err instanceof ConfigError && err.message.includes(name), name);
    }
  });

  it("parses several devices", () => {
    assert.deepEqual(parseDevices(" H5080|AA:BB , H5081|CC:DD ,"), [
      { sku: "H5080", device: "AA:BB" },
      { sku: "H5081", device: "CC:DD" },
    ]);
  });
});

function forecastPayload(gustsByStep, current = [6, 9]) {
  const base = Date.parse("2026-12-01T18:00:00Z") / 1000;
  const steps = Object.keys(gustsByStep).map(Number).sort((a, b) => a - b);
  return {
    utc_offset_seconds: -21600,
    current: { wind_speed_10m: current[0], wind_gusts_10m: current[1] },
    minutely_15: {
      time: steps.map((s) => base + s * 900),
      wind_speed_10m: steps.map(() => 5),
      wind_gusts_10m: steps.map((s) => gustsByStep[s]),
    },
  };
}

describe("weather", () => {
  it("keeps only steps inside the window", () => {
    const o = parseOutlook(forecastPayload({ "-2": 50, "-1": 50, 0: 11, 1: 12, 11: 13, 12: 14, 13: 50 }), NOW, 3);
    assert.deepEqual(o.readings.map((r) => r.gust), [11, 12, 13, 14]);
    assert.equal(peakGust(o), 14);
    assert.equal(peakTime(o).toISOString(), "2026-12-01T21:00:00.000Z");
    assert.equal(o.utcOffsetSeconds, -21600);
  });

  it("finds when gusts first reach a speed", () => {
    const o = parseOutlook(forecastPayload({ 0: 10, 1: 15, 2: 20, 3: 25 }), NOW, 3);
    assert.equal(firstTimeAtOrAbove(o, 20).toISOString(), "2026-12-01T18:30:00.000Z");
    assert.equal(firstTimeAtOrAbove(o, 30), null);
  });

  it("treats the current gust as the peak when it is highest", () => {
    const o = parseOutlook(forecastPayload({ 0: 10, 1: 12 }, [15, 28]), NOW, 3);
    assert.equal(peakGust(o), 28);
    assert.equal(peakTime(o), null);
  });

  it("rejects bad payloads", () => {
    const ragged = forecastPayload({ 0: 10, 1: 12 });
    ragged.minutely_15.wind_gusts_10m.pop();
    const noCurrent = forecastPayload({ 0: 10 });
    delete noCurrent.current;
    for (const payload of [
      forecastPayload({ 0: 10, 1: null }),
      forecastPayload({ 0: -5 }),
      ragged,
      noCurrent,
      forecastPayload({ "-5": 10, 20: 10 }),
      [],
      {},
      null,
    ]) {
      assert.throws(() => parseOutlook(payload, NOW, 3), WeatherError);
    }
  });

  it("builds the request and wraps network errors", async () => {
    let url;
    const o = await fetchOutlook(makeConfig(), NOW, async (_m, u) => {
      url = u;
      return forecastPayload({ 0: 10, 1: 22 });
    });
    assert.equal(peakGust(o), 22);
    for (const part of ["latitude=41.5000", "longitude=-87.5000", "wind_speed_unit=mph", "forecast_minutely_15=16"]) {
      assert.ok(url.includes(part), part);
    }
    await assert.rejects(
      fetchOutlook(makeConfig(), NOW, async () => {
        throw new HttpError("down");
      }),
      WeatherError,
    );
  });
});

function response(status, body = "{}", headers = {}) {
  return new Response(status === 204 ? null : body, { status, headers });
}

async function call(outcomes, options = {}) {
  const queue = [...outcomes];
  const requests = [];
  const sleeps = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  try {
    const result = await requestJson("POST", "https://x.example/path", {
      fetchImpl,
      sleep: async (ms) => sleeps.push(ms),
      log: quiet,
      ...options,
    });
    return { result, requests, sleeps };
  } catch (error) {
    return { error, requests, sleeps };
  }
}

describe("http", () => {
  it("sends a JSON body and headers", async () => {
    const r = await call([response(200, '{"ok":true}')], { body: { a: 1 }, headers: { "X-Key": "k" } });
    assert.deepEqual(r.result, { ok: true });
    assert.equal(r.requests[0].init.body, '{"a":1}');
    assert.equal(r.requests[0].init.headers["X-Key"], "k");
  });

  it("retries server and network errors, then succeeds", async () => {
    const r = await call([response(503), new TypeError("dns"), response(200)]);
    assert.deepEqual(r.result, {});
    assert.deepEqual(r.sleeps, [2000, 4000]);
  });

  it("backs off longer when rate limited, honouring Retry-After", async () => {
    const r = await call([response(429), response(429, "", { "Retry-After": "7" }), response(429), response(200)]);
    assert.deepEqual(r.sleeps, [15000, 7000, 45000]);
  });

  it("gives up after four attempts and does not retry client errors", async () => {
    const many = await call([response(500), response(502), response(503), response(504)]);
    assert.ok(many.error instanceof HttpError);
    assert.equal(many.requests.length, 4);
    const once = await call([response(401)]);
    assert.match(once.error.message, /401/);
    assert.equal(once.requests.length, 1);
  });

  it("refuses plain HTTP and non-JSON answers, and never leaks the URL", async () => {
    await assert.rejects(requestJson("GET", "http://x.example/"), HttpError);
    const bad = await call([response(200, "<html>")]);
    assert.match(bad.error.message, /not JSON/);
    const r = await call([response(403)]);
    assert.ok(!r.error.message.includes("/path"));
  });
});

describe("govee", () => {
  const client = (reply, calls = []) =>
    new GoveeClient("secret-key", async (method, url, opts) => {
      calls.push({ method, url, opts });
      if (reply instanceof Error) throw reply;
      return reply;
    });

  it("turns a plug off with powerSwitch 0", async () => {
    const calls = [];
    await client({ code: 200 }, calls).turnOff(PLUG_A);
    assert.equal(calls[0].url, "https://openapi.api.govee.com/router/api/v1/device/control");
    assert.deepEqual(calls[0].opts.headers, { "Govee-API-Key": "secret-key" });
    assert.deepEqual(calls[0].opts.body.payload.capability, {
      type: "devices.capabilities.on_off",
      instance: "powerSwitch",
      value: 0,
    });
  });

  it("has no way to turn a plug on", () => {
    assert.equal(GoveeClient.prototype.turnOn, undefined);
  });

  it("reads power state", async () => {
    const reply = (value) => ({
      code: 200,
      payload: { capabilities: [{ type: "devices.capabilities.on_off", state: { value } }] },
    });
    assert.equal(await client(reply(1)).isOn(PLUG_A), true);
    assert.equal(await client(reply(0)).isOn(PLUG_A), false);
    assert.equal(await client(reply("")).isOn(PLUG_A), null);
  });

  it("turns failures into GoveeError", async () => {
    for (const reply of [{ code: 400 }, [], new HttpError("down")]) {
      await assert.rejects(client(reply).turnOff(PLUG_A), GoveeError);
    }
  });
});

describe("notify", () => {
  it("posts JSON to the server root", async () => {
    const calls = [];
    await new Notifier("https://ntfy.example", "t1", "https://me.example/", async (m, u, o) => calls.push({ m, u, o }))
      .send("Title", "Body", { urgent: true, tag: "warning" });
    assert.equal(calls[0].u, "https://ntfy.example/");
    assert.deepEqual(calls[0].o.body, {
      topic: "t1",
      title: "Title",
      message: "Body",
      priority: 5,
      tags: ["warning"],
      click: "https://me.example/",
    });
  });

  it("turns failures into NotifyError", async () => {
    const n = new Notifier("https://ntfy.example", "t", "", async () => {
      throw new HttpError("down");
    });
    await assert.rejects(n.send("T", "B"), NotifyError);
  });
});

describe("history", () => {
  const status = (extra = {}) => ({
    current_gust_mph: 12.5,
    peak_gust_mph: 24.4,
    hold: false,
    level: "watch",
    plug_on: true,
    problems: [],
    ...extra,
  });

  it("adds a compact row and drops rows older than seven days", () => {
    const old = new Date(NOW.getTime() - (7 * 24 * 60 + 1) * 60000).toISOString();
    const h = addCheck({ checks: [[old, 1, 1, 0, "ok"], "junk"], events: [] }, status({ plug_on: false }), NOW);
    assert.deepEqual(h.checks, [["2026-12-01T18:10:00Z", 12.5, 24.4, 0, "watch", 0]]);
  });

  it("logs each action once and repeated problems once", () => {
    let h = normalizeHistory(null);
    for (let i = 0; i < 3; i += 1) {
      h = addCheck(h, status({ last_action: "Switched off", last_action_at: "x", problems: ["forecast down"] }), NOW);
    }
    assert.deepEqual(h.events.map((e) => e.text), ["Switched off", "Problem: forecast down"]);
  });

  it("keeps the newest events", () => {
    const events = Array.from({ length: KEEP_EVENTS }, (_, i) => ({ at: `e${i}`, text: "x" }));
    const h = addCheck({ checks: [], events }, status({ last_action: "new", last_action_at: "z" }), NOW);
    assert.equal(h.events.length, KEEP_EVENTS);
    assert.equal(h.events.at(-1).text, "new");
  });
});
