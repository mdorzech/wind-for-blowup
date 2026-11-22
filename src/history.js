// Rolling history for the dashboard: one compact row per check plus a log of actions.
// Like the status, it is public and must never hold location, keys or device IDs.

const KEEP_CHECKS_MS = 7 * 24 * 3600 * 1000;
export const KEEP_EVENTS = 100;

export function normalizeHistory(raw) {
  const checks = Array.isArray(raw?.checks) ? raw.checks : [];
  const events = Array.isArray(raw?.events) ? raw.events : [];
  return { checks, events };
}

/** Append this check and its action (if new), and drop rows older than seven days. */
export function addCheck(history, status, now) {
  const nowMs = now.getTime();
  const checks = history.checks.filter((row) => {
    if (!Array.isArray(row) || !row.length) return false;
    const t = Date.parse(row[0]);
    return Number.isFinite(t) && nowMs - t <= KEEP_CHECKS_MS;
  });
  checks.push([
    now.toISOString().replace(/\.\d{3}Z$/, "Z"),
    status.current_gust_mph,
    status.peak_gust_mph,
    status.hold ? 1 : 0,
    status.level,
    status.plug_on === true ? 1 : status.plug_on === false ? 0 : null,
  ]);

  const events = history.events.filter((e) => e && typeof e === "object" && !Array.isArray(e));
  const action = status.last_action;
  const at = status.last_action_at;
  if (action && at && !events.some((e) => e.at === at)) events.push({ at, text: action });
  for (const problem of status.problems || []) {
    const text = `Problem: ${problem}`;
    if (!events.length || events[events.length - 1].text !== text) {
      events.push({ at: now.toISOString(), text });
    }
  }
  return { checks, events: events.slice(-KEEP_EVENTS) };
}
