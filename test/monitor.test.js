import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { localClock, newState, normalizeState, runCheck } from "../src/monitor.js";
import { WeatherError } from "../src/weather.js";
import { FakeNotifier, FakePlug, NOW, PLUG_A, PLUG_B, makeConfig, makeOutlook, quiet } from "./helpers.js";

async function check({ state, outlook, plug, notifier, now = NOW, error, dryRun = false, ...cfg } = {}) {
  plug ??= new FakePlug();
  notifier ??= new FakeNotifier();
  const result = await runCheck(makeConfig(cfg), state ?? newState(), now, {
    getOutlook: async () => {
      if (error) throw error;
      return outlook;
    },
    plug,
    notifier,
    dryRun,
    log: quiet,
  });
  return { ...result, plug, notifier };
}

const held = (extra = {}) => ({ ...newState(), hold: true, hold_since: "2026-12-01T17:00:00Z", ...extra });
const minutesBefore = (m) => new Date(NOW.getTime() - m * 60000).toISOString();

describe("windy", () => {
  it("turns the plug off when gusts reach the limit within the lead time, and notifies", async () => {
    const r = await check({ outlook: makeOutlook(8, 10, 20, 12) });
    assert.deepEqual(r.plug.offCalls, [PLUG_A]);
    assert.equal(r.state.hold, true);
    assert.equal(r.state.hold_since, NOW.toISOString());
    assert.deepEqual(r.notifier.titles, ["High wind: inflatables turned off"]);
    assert.match(r.notifier.sent[0].message, /High wind \(20 mph gusts\) from about 12:15 PM, peaking at 12 mph wind and 20 mph gusts/);
    assert.equal(r.ok, true);
    assert.equal(r.status.level, "hold");
    assert.equal(r.status.plug_on, false);
  });

  it("acts immediately when gusts are already at the limit", async () => {
    const r = await check({ outlook: makeOutlook(26, 10, 9) });
    assert.equal(r.plug.offCalls.length, 1);
    assert.match(r.notifier.sent[0].message, /right now/);
  });

  it("does nothing just below the limit", async () => {
    const r = await check({ outlook: makeOutlook(10, 19.9, 12) });
    assert.deepEqual(r.plug.offCalls, []);
    assert.deepEqual(r.notifier.sent, []);
    assert.equal(r.status.level, "ok");
    assert.equal(r.status.plug_on, true);
  });

  it("only warns on the dashboard when the wind is beyond the lead time", async () => {
    const r = await check({ outlook: makeOutlook(5, 10, 10, 10, 10, 25) }); // 19:00, 50 min away
    assert.deepEqual(r.plug.offCalls, []);
    assert.deepEqual(r.notifier.sent, []);
    assert.equal(r.status.level, "watch");
    assert.equal(r.status.headline, "High wind expected at 1:00 PM");
    assert.match(r.status.detail, /turned off at about 12:30 PM/);
    assert.equal(r.status.switch_off_at, "2026-12-01T18:30:00.000Z");
  });

  it("acts at exactly the lead time but not a minute before", async () => {
    const outlook = makeOutlook(5, 10, 10, 10, 25); // 18:45
    const at = await check({ outlook, now: new Date("2026-12-01T18:15:00Z") });
    assert.deepEqual(at.plug.offCalls, [PLUG_A]);
    const before = await check({ outlook, now: new Date("2026-12-01T18:14:00Z") });
    assert.deepEqual(before.plug.offCalls, []);
  });

  it("uses a longer lead time from the settings", async () => {
    const r = await check({ outlook: makeOutlook(5, 10, 10, 10, 10, 25), leadMinutes: 60 });
    assert.deepEqual(r.plug.offCalls, [PLUG_A]);
  });

  it("switches every plug", async () => {
    const plug = new FakePlug({ stateFails: true });
    await check({ outlook: makeOutlook(30), plug, devices: [PLUG_A, PLUG_B] });
    assert.deepEqual(plug.offCalls, [PLUG_A, PLUG_B]);
  });

  it("warns but sends no command when the plug is already off", async () => {
    const r = await check({ outlook: makeOutlook(30), plug: new FakePlug({ on: false }) });
    assert.deepEqual(r.plug.offCalls, []);
    assert.deepEqual(r.notifier.titles, ["High wind expected"]);
  });

  it("is silent while still windy and the plug stays off", async () => {
    const r = await check({ state: held(), outlook: makeOutlook(30), plug: new FakePlug({ on: false }) });
    assert.deepEqual(r.notifier.sent, []);
    assert.equal(r.state.hold_since, "2026-12-01T17:00:00Z");
  });

  it("switches the plug off again if it is turned on during the wind", async () => {
    const r = await check({ state: held(), outlook: makeOutlook(30) });
    assert.deepEqual(r.plug.offCalls, [PLUG_A]);
    assert.deepEqual(r.notifier.titles, ["Inflatables turned off again"]);
  });

  it("keeps holding while more wind is forecast beyond the lead time", async () => {
    const r = await check({
      state: held(),
      outlook: makeOutlook(5, 10, 10, 10, 10, 10, 10, 25),
      plug: new FakePlug({ on: false }),
    });
    assert.equal(r.state.hold, true);
    assert.equal(r.status.level, "hold");
  });
});

describe("recovery", () => {
  it("starts the calm clock without notifying", async () => {
    const r = await check({ state: held(), outlook: makeOutlook(8, 9, 10) });
    assert.equal(r.state.hold, true);
    assert.equal(r.state.calm_since, NOW.toISOString());
    assert.deepEqual(r.notifier.sent, []);
  });

  it("sends the all-clear after the calm period and never switches anything", async () => {
    const r = await check({ state: held({ calm_since: minutesBefore(30) }), outlook: makeOutlook(8, 9, 10) });
    assert.equal(r.state.hold, false);
    assert.deepEqual(r.notifier.titles, ["Wind has passed"]);
    assert.match(r.notifier.sent[0].message, /Govee app/);
    assert.deepEqual(r.plug.offCalls, []);
    assert.equal(r.status.level, "ok");
  });

  it("keeps waiting before the calm period ends", async () => {
    const r = await check({ state: held({ calm_since: minutesBefore(29) }), outlook: makeOutlook(8) });
    assert.equal(r.state.hold, true);
    assert.deepEqual(r.notifier.sent, []);
  });

  it("restarts the clock between the resume level and the limit", async () => {
    const r = await check({ state: held({ calm_since: minutesBefore(29) }), outlook: makeOutlook(8, 18) });
    assert.equal(r.state.calm_since, null);
  });

  it("retries an undelivered all-clear next time", async () => {
    const r = await check({
      state: held({ calm_since: minutesBefore(60) }),
      outlook: makeOutlook(5),
      notifier: new FakeNotifier({ fails: true }),
    });
    assert.equal(r.state.hold, true);
    assert.equal(r.ok, false);
  });

  it("restarts the clock if the saved time is damaged", async () => {
    const r = await check({ state: held({ calm_since: "garbage" }), outlook: makeOutlook(5) });
    assert.equal(r.state.calm_since, NOW.toISOString());
  });
});

describe("sustained wind limit (25 mph wind or 35 mph gusts)", () => {
  const limits = { gustThresholdMph: 35, resumeBelowMph: 32, sustainedThresholdMph: 25, resumeBelowSustainedMph: 22 };
  // Readings with explicit wind speed and gusts, from 18:00 UTC in 15-minute steps.
  const outlookOf = (current, ...steps) => ({
    currentSpeed: current[0],
    currentGust: current[1],
    readings: steps.map(([speed, gust], i) => ({ time: new Date(Date.parse("2026-12-01T18:00:00Z") + i * 900000), speed, gust })),
    utcOffsetSeconds: -6 * 3600,
  });

  it("turns off for sustained wind even when gusts stay under 35", async () => {
    const r = await check({ ...limits, outlook: outlookOf([10, 15], [12, 18], [26, 30]) });
    assert.deepEqual(r.plug.offCalls, [PLUG_A]);
    assert.match(r.notifier.sent[0].message, /High wind \(25 mph wind or 35 mph gusts\) from about 12:15 PM/);
  });

  it("turns off for gusts even when the wind stays under 25", async () => {
    const r = await check({ ...limits, outlook: outlookOf([10, 15], [12, 36]) });
    assert.deepEqual(r.plug.offCalls, [PLUG_A]);
  });

  it("ignores 28 mph gusts and 20 mph wind, which the old 20 mph gust limit would have caught", async () => {
    const r = await check({ ...limits, outlook: outlookOf([15, 22], [20, 28], [18, 26]) });
    assert.deepEqual(r.plug.offCalls, []);
    assert.equal(r.status.level, "ok");
    assert.equal(r.status.sustained_threshold_mph, 25);
    assert.equal(r.status.peak_speed_mph, 20);
    assert.match(r.status.detail, /Limits: 25 mph wind or 35 mph gusts/);
  });

  it("acts immediately when the wind is already at 25", async () => {
    const r = await check({ ...limits, outlook: outlookOf([25, 30], [10, 15]) });
    assert.deepEqual(r.plug.offCalls, [PLUG_A]);
    assert.match(r.notifier.sent[0].message, /right now/);
  });

  it("waits for both wind and gusts to calm before the all-clear", async () => {
    const calmSince = minutesBefore(30);
    const windy = await check({ ...limits, state: held({ calm_since: calmSince }), outlook: outlookOf([23, 25], [23, 25]) });
    assert.equal(windy.state.hold, true, "wind 23 is above the 22 resume level");
    assert.equal(windy.state.calm_since, null);
    const calm = await check({ ...limits, state: held({ calm_since: calmSince }), outlook: outlookOf([15, 25], [15, 25]) });
    assert.equal(calm.state.hold, false);
    assert.match(calm.notifier.sent[0].message, /Gusts should stay under 32 mph and wind under 22 mph/);
  });
});

describe("failures", () => {
  it("alerts once when the forecast fails and never touches the plug", async () => {
    const first = await check({ error: new WeatherError("api down") });
    assert.equal(first.ok, false);
    assert.deepEqual(first.plug.offCalls, []);
    assert.deepEqual(first.notifier.titles, ["Wind monitor cannot get the forecast"]);
    assert.equal(first.notifier.sent[0].urgent, true);
    assert.equal(first.status.level, "error");
    assert.equal(first.status.plug_on, true);
    const again = await check({ state: first.state, error: new WeatherError("api down") });
    assert.deepEqual(again.notifier.sent, []);
  });

  it("announces recovery", async () => {
    const r = await check({ state: { ...newState(), alerted: ["weather"] }, outlook: makeOutlook(5) });
    assert.deepEqual(r.notifier.titles, ["Wind monitor is working again"]);
    assert.deepEqual(r.state.alerted, []);
  });

  it("alerts once when the plug cannot be switched off, and retries", async () => {
    const first = await check({ outlook: makeOutlook(30), plug: new FakePlug({ offFails: true }) });
    assert.deepEqual(first.notifier.titles, ["Could not turn inflatables off"]);
    assert.equal(first.status.plug_on, true);
    const again = await check({ state: first.state, outlook: makeOutlook(30), plug: new FakePlug({ offFails: true }) });
    assert.deepEqual(again.notifier.sent, []);
    const fixed = await check({ state: again.state, outlook: makeOutlook(30) });
    assert.deepEqual(fixed.plug.offCalls, [PLUG_A]);
    assert.ok(!fixed.state.alerted.includes("plug"));
  });

  it("still turns the plug off when notifications fail", async () => {
    const r = await check({ outlook: makeOutlook(30), notifier: new FakeNotifier({ fails: true }) });
    assert.deepEqual(r.plug.offCalls, [PLUG_A]);
    assert.equal(r.ok, false);
  });

  it("does not change the state it was given", async () => {
    const original = newState();
    await check({ state: original, outlook: makeOutlook(30) });
    assert.equal(original.hold, false);
  });
});

describe("plug state and status", () => {
  it("reads each plug once per check", async () => {
    const plug = new FakePlug();
    await check({ outlook: makeOutlook(30), plug });
    assert.equal(plug.reads, 1);
  });

  it("reports unknown when Govee cannot say", async () => {
    const r = await check({ outlook: makeOutlook(5), plug: new FakePlug({ stateFails: true }) });
    assert.equal(r.status.plug_on, null);
  });

  it("counts any plug on as on", async () => {
    const plug = new FakePlug();
    plug.isOn = async (d) => d === PLUG_B;
    const r = await check({ outlook: makeOutlook(5), plug, devices: [PLUG_A, PLUG_B] });
    assert.deepEqual(r.status.plugs, [false, true]);
    assert.equal(r.status.plug_on, true);
  });

  it("dry run switches nothing and notifies nobody", async () => {
    const r = await check({ outlook: makeOutlook(40), dryRun: true });
    assert.deepEqual(r.plug.offCalls, []);
    assert.deepEqual(r.notifier.sent, []);
    assert.equal(r.status.dry_run, true);
    assert.equal(r.state.last_action, "Would switch inflatables off for wind (dry run)");
  });

  it("status holds no private values", async () => {
    const r = await check({ outlook: makeOutlook(30) });
    const text = JSON.stringify(r.status);
    for (const secret of ["test-key", "test-topic", PLUG_A.device, "41.5", "-87.5"]) {
      assert.ok(!text.includes(secret), secret);
    }
  });

  it("normalizes damaged saved state", () => {
    assert.deepEqual(normalizeState(null), newState());
    assert.deepEqual(normalizeState({ hold: "yes", alerted: "plug", calm_since: 5, last_action: "x" }), {
      ...newState(),
      last_action: "x",
    });
  });

  it("formats local clock times", () => {
    assert.equal(localClock(new Date("2026-12-01T00:05:00Z"), 0), "12:05 AM");
    assert.equal(localClock(new Date("2026-12-01T00:05:00Z"), -5 * 3600), "7:05 PM");
    assert.equal(localClock(new Date("2026-12-01T12:00:00Z"), 0), "12:00 PM");
  });
});
