import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkAndSave, handleRequest } from "../src/app.js";
import { FakeD1, FakeNotifier, FakePlug, NOW, makeOutlook, quiet } from "./helpers.js";

const SECRETS = {
  LATITUDE: "41.5",
  LONGITUDE: "-87.5",
  GOVEE_API_KEY: "key",
  GOVEE_DEVICES: "H5080|AA:BB:CC:DD:EE:FF:00:11",
  NTFY_TOPIC: "topic1",
};

function setup(outlook = makeOutlook(30)) {
  const env = { ...SECRETS, DB: new FakeD1() };
  const plug = new FakePlug();
  const notifier = new FakeNotifier();
  const deps = { getOutlook: async () => outlook, plug, notifier };
  return { env, plug, notifier, deps };
}

const post = (path) => new Request(`https://wind.example${path}`, { method: "POST" });
const get = (path) => new Request(`https://wind.example${path}`);

describe("worker", () => {
  it("runs a check and saves state, status and history", async () => {
    const { env, plug, notifier, deps } = setup();
    const result = await checkAndSave(env, { now: NOW, deps, log: quiet });
    assert.equal(result.ran, true);
    assert.equal(plug.offCalls.length, 1);
    assert.deepEqual(notifier.titles, ["High wind: inflatables turned off"]);
    assert.equal(env.DB.doc("state").hold, true);
    assert.equal(env.DB.doc("status").level, "hold");
    assert.equal(env.DB.doc("history").checks.length, 1);
    assert.equal(env.DB.doc("lock"), undefined, "lock released");
  });

  it("carries state between checks", async () => {
    const { env, deps } = setup();
    await checkAndSave(env, { now: NOW, deps, log: quiet });
    const later = new Date(NOW.getTime() + 5 * 60000);
    const second = setup();
    await checkAndSave(env, { now: later, deps: { ...second.deps, plug: new FakePlug({ on: false }) }, log: quiet });
    assert.deepEqual(second.notifier.sent, [], "no repeat notification while held");
    assert.equal(env.DB.doc("history").checks.length, 2);
  });

  it("serves status and history, 404 before the first check", async () => {
    const { env, deps } = setup();
    assert.equal((await handleRequest(get("/status.json"), env)).status, 404);
    await checkAndSave(env, { now: NOW, deps, log: quiet });
    const res = await handleRequest(get("/status.json"), env);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Cache-Control"), "no-store");
    assert.equal((await res.json()).level, "hold");
    assert.equal((await (await handleRequest(get("/history.json"), env)).json()).checks.length, 1);
  });

  it("runs a check when Refresh posts, at most once a minute", async () => {
    const { env, deps } = setup(makeOutlook(5));
    const first = await handleRequest(post("/api/check"), env, { now: NOW, deps, log: quiet });
    assert.equal(first.status, 200);
    assert.equal((await first.json()).ran, true);

    const soon = await handleRequest(post("/api/check"), env, {
      now: new Date(NOW.getTime() + 30000),
      deps,
      log: quiet,
    });
    const body = await soon.json();
    assert.equal(body.ran, false);
    assert.equal(body.reason, "recent");
    assert.equal(body.status.level, "ok");

    const later = await handleRequest(post("/api/check"), env, {
      now: new Date(NOW.getTime() + 61000),
      deps,
      log: quiet,
    });
    assert.equal((await later.json()).ran, true);
  });

  it("does not start a second check while one is running", async () => {
    const { env, deps } = setup(makeOutlook(5));
    env.DB.rows.set("lock", String(NOW.getTime() - 1000));
    const res = await handleRequest(post("/api/check"), env, { now: NOW, deps, log: quiet });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).reason, "running");
  });

  it("ignores a stale lock left by a check that died", async () => {
    const { env, deps } = setup(makeOutlook(5));
    env.DB.rows.set("lock", String(NOW.getTime() - 5 * 60000));
    const result = await checkAndSave(env, { now: NOW, deps, log: quiet });
    assert.equal(result.ran, true);
  });

  it("only accepts the right methods", async () => {
    const { env } = setup();
    assert.equal((await handleRequest(get("/api/check"), env)).status, 405);
    assert.equal((await handleRequest(post("/status.json"), env)).status, 405);
  });

  it("shows a settings problem on the dashboard instead of failing silently", async () => {
    const { env, deps } = setup();
    delete env.GOVEE_DEVICES;
    const result = await checkAndSave(env, { now: NOW, deps, log: quiet });
    assert.equal(result.status.level, "error");
    assert.match(result.status.detail, /GOVEE_DEVICES/);
    assert.equal(env.DB.doc("status").headline, "Monitor settings problem");
  });

  it("hands other paths to the dashboard files", async () => {
    const { env } = setup();
    env.ASSETS = { fetch: async () => new Response("page") };
    assert.equal(await (await handleRequest(get("/"), env)).text(), "page");
  });
});
