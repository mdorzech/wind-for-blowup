// The Worker's logic: storage, the saved check, and the HTTP routes. src/index.js wires
// these to Cloudflare (a module's named exports there must all be handlers).

import { ConfigError, loadConfig } from "./config.js";
import { GoveeClient } from "./govee.js";
import { addCheck, normalizeHistory } from "./history.js";
import { normalizeState, runCheck } from "./monitor.js";
import { Notifier } from "./notify.js";
import { fetchOutlook } from "./weather.js";

export const MANUAL_GAP_MS = 60 * 1000; // Refresh runs a check at most once a minute
const LOCK_MS = 4 * 60 * 1000; // a check that has not finished by then is assumed dead

// ---- storage: one small key/value table in D1 ----------------------------------

async function ensureTable(db) {
  await db.prepare("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)").run();
}

export async function getDoc(db, key) {
  const row = await db.prepare("SELECT value FROM kv WHERE key = ?").bind(key).first();
  if (!row) return null;
  try {
    return JSON.parse(row.value);
  } catch {
    return null;
  }
}

const UPSERT = "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value";

export async function putDocs(db, docs) {
  await db.batch(Object.entries(docs).map(([k, v]) => db.prepare(UPSERT).bind(k, JSON.stringify(v))));
}

/** Atomically take the check lock unless another check holds a fresh one. */
async function takeLock(db, nowMs) {
  const result = await db
    .prepare(
      "INSERT INTO kv (key, value) VALUES ('lock', ?1) ON CONFLICT(key) DO UPDATE SET value = ?1 " +
        "WHERE CAST(kv.value AS INTEGER) < ?2",
    )
    .bind(String(nowMs), nowMs - LOCK_MS)
    .run();
  return result.meta?.changes === 1;
}

async function releaseLock(db) {
  await db.prepare("DELETE FROM kv WHERE key = 'lock'").run();
}

// ---- the check ---------------------------------------------------------------

/**
 * Run one check and save state, status and history.
 * Returns {ran, reason?, status}. `deps` replaces the network clients in tests.
 */
export async function checkAndSave(env, { now = new Date(), manual = false, deps = {}, log = console } = {}) {
  const db = env.DB;
  await ensureTable(db);

  if (manual) {
    const last = await getDoc(db, "status");
    const lastMs = Date.parse(last?.checked_at ?? "");
    if (Number.isFinite(lastMs) && now.getTime() - lastMs < MANUAL_GAP_MS) {
      return { ran: false, reason: "recent", status: last };
    }
  }
  if (!(await takeLock(db, now.getTime()))) {
    return { ran: false, reason: "running", status: await getDoc(db, "status") };
  }

  try {
    let cfg;
    try {
      cfg = loadConfig(env);
    } catch (err) {
      if (!(err instanceof ConfigError)) throw err;
      log.error?.(`configuration problem: ${err.message}`);
      const status = settingsProblem(err.message, now);
      await putDocs(db, { status });
      return { ran: true, status };
    }

    const [savedState, savedHistory] = await Promise.all([getDoc(db, "state"), getDoc(db, "history")]);
    const result = await runCheck(cfg, normalizeState(savedState), now, {
      getOutlook: deps.getOutlook ?? (() => fetchOutlook(cfg, now)),
      plug: deps.plug ?? new GoveeClient(cfg.goveeApiKey),
      notifier: deps.notifier ?? new Notifier(cfg.ntfyServer, cfg.ntfyTopic, cfg.statusPageUrl),
      log,
    });
    const history = addCheck(normalizeHistory(savedHistory), result.status, now);
    await putDocs(db, { state: result.state, status: result.status, history });
    log.info?.(`${result.status.headline} - ${result.status.detail}`);
    return { ran: true, status: result.status };
  } finally {
    await releaseLock(db);
  }
}

function settingsProblem(message, now) {
  return {
    checked_at: now.toISOString(),
    level: "error",
    headline: "Monitor settings problem",
    detail: `${message}. Nothing is being checked until this is fixed.`,
    hold: false,
    problems: [`settings: ${message}`],
    forecast: [],
    current_speed_mph: null,
    current_gust_mph: null,
    peak_gust_mph: null,
    plugs: [],
    plug_on: null,
  };
}

// ---- HTTP --------------------------------------------------------------------

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export async function handleRequest(request, env, options = {}) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/status.json" || path === "/history.json") {
    if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "use GET" }, 405);
    await ensureTable(env.DB);
    const doc = await getDoc(env.DB, path === "/status.json" ? "status" : "history");
    return doc === null ? json({ error: "no checks yet" }, 404) : json(doc);
  }

  if (path === "/api/check") {
    if (request.method !== "POST") return json({ error: "use POST" }, 405);
    try {
      const result = await checkAndSave(env, { ...options, manual: true });
      return json(result, result.ran || result.reason === "recent" ? 200 : 409);
    } catch (err) {
      (options.log ?? console).error?.(`manual check failed: ${err?.message}`);
      return json({ ran: false, reason: "failed" }, 500);
    }
  }

  if (env.ASSETS) return env.ASSETS.fetch(request);
  return json({ error: "not found" }, 404);
}
