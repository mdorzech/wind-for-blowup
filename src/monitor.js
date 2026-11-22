// One wind check: read the forecast, decide, switch plugs off, notify.
//
// The rules, in order:
//   1. Gusts at or above the threshold now, or forecast to reach it within the lead
//      time (default 30 minutes): hold the inflatables off. While holding, the hold
//      continues as long as the threshold is reached anywhere in the look-ahead
//      window, and plugs found on are switched off on every run. High wind further
//      out than the lead time is shown on the dashboard only.
//   2. While holding, once the peak has stayed below the resume level for the calm
//      period: tell the user the wind has passed. The user decides whether to turn
//      the inflatables back on; this program never switches anything on.
//   3. Any failure (forecast, plug, notification) is reported, and alerts are sent
//      once per failure streak rather than on every run.

import { GoveeError } from "./govee.js";
import { NotifyError } from "./notify.js";
import { WeatherError, firstTimeAtOrAbove, peakGust, peakTime } from "./weather.js";

export function newState() {
  return { hold: false, hold_since: null, calm_since: null, last_action: null, last_action_at: null, alerted: [] };
}

/** Saved state from an earlier run; anything missing or damaged falls back to a clean value. */
export function normalizeState(raw) {
  const state = newState();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return state;
  state.hold = raw.hold === true;
  for (const key of ["hold_since", "calm_since", "last_action", "last_action_at"]) {
    state[key] = typeof raw[key] === "string" ? raw[key] : null;
  }
  state.alerted = Array.isArray(raw.alerted) ? raw.alerted.filter((k) => typeof k === "string") : [];
  return state;
}

/** "7:00 PM" at the forecast location. */
export function localClock(date, offsetSeconds) {
  const local = new Date(date.getTime() + offsetSeconds * 1000);
  const h = local.getUTCHours();
  const m = String(local.getUTCMinutes()).padStart(2, "0");
  return `${h % 12 || 12}:${m} ${h < 12 ? "AM" : "PM"}`;
}

const mph = (v) => Math.round(v).toFixed(0);
const one = (v) => Math.round(v * 10) / 10;
const iso = (d) => d.toISOString();

async function readPlugs(devices, plug, log) {
  const states = [];
  for (let i = 0; i < devices.length; i += 1) {
    try {
      states.push(await plug.isOn(devices[i]));
    } catch (err) {
      if (!(err instanceof GoveeError)) throw err;
      log.warn?.(`plug ${i + 1} state unavailable: ${err.message}`);
      states.push(null);
    }
  }
  return states;
}

/** Switch off every plug not known to be off, updating `states`. */
async function switchOff(devices, plug, dryRun, states, log) {
  let switched = 0;
  let failed = 0;
  for (let i = 0; i < devices.length; i += 1) {
    if (states[i] === false) {
      log.info?.(`plug ${i + 1} is already off`);
      continue;
    }
    if (dryRun) {
      log.info?.(`dry run: would switch off plug ${i + 1}`);
      continue;
    }
    try {
      await plug.turnOff(devices[i]); // sent even when the state is unknown
      switched += 1;
      states[i] = false;
      log.info?.(`plug ${i + 1} switched off`);
    } catch (err) {
      if (!(err instanceof GoveeError)) throw err;
      failed += 1;
      log.error?.(`plug ${i + 1} could not be switched off: ${err.message}`);
    }
  }
  return { switched, failed };
}

export async function runCheck(cfg, previous, now, { getOutlook, plug, notifier, dryRun = false, log = console }) {
  const state = normalizeState(structuredClone(previous));
  const problems = [];
  const plugs = await readPlugs(cfg.devices, plug, log);
  const record = (action) => {
    state.last_action = action;
    state.last_action_at = iso(now);
  };

  async function send(title, message, options = {}) {
    if (dryRun) {
      log.info?.(`dry run: would notify: ${title} - ${message}`);
      return true;
    }
    try {
      await notifier.send(title, message, options);
      return true;
    } catch (err) {
      if (!(err instanceof NotifyError)) throw err;
      problems.push(`notification not delivered: ${err.message}`);
      log.error?.(`notification not delivered: ${err.message}`);
      return false;
    }
  }
  async function alertOnce(kind, title, message) {
    if (state.alerted.includes(kind)) return;
    if ((await send(title, message, { urgent: true, tag: "warning" })) && !dryRun) state.alerted.push(kind);
  }
  function clearAlert(kind) {
    const i = state.alerted.indexOf(kind);
    if (i < 0) return false;
    state.alerted.splice(i, 1);
    return true;
  }

  // --- forecast -------------------------------------------------------------
  let outlook;
  try {
    outlook = await getOutlook();
  } catch (err) {
    if (!(err instanceof WeatherError)) throw err;
    problems.push(`forecast unavailable: ${err.message}`);
    log.error?.(`forecast unavailable: ${err.message}`);
    await alertOnce(
      "weather",
      "Wind monitor cannot get the forecast",
      "Your inflatables are not being protected until this clears. If it is windy, turn them off yourself.",
    );
    return { state, status: withPlugs(buildStatus(cfg, state, now, null, problems, dryRun), plugs), ok: false };
  }
  if (clearAlert("weather")) {
    await send("Wind monitor is working again", "The forecast is available and checks have resumed.");
  }

  const peak = peakGust(outlook);
  const limit = cfg.gustThresholdMph;
  const offset = outlook.utcOffsetSeconds;
  const windyNow = outlook.currentGust >= limit;
  const onset = windyNow ? null : firstTimeAtOrAbove(outlook, limit);
  const leadMs = cfg.leadMinutes * 60 * 1000;
  const due = windyNow || (onset !== null && onset.getTime() - now.getTime() <= leadMs);
  log.info?.(
    `gusts now ${mph(outlook.currentGust)} mph, peak ${mph(peak)} mph in the next ${cfg.lookaheadHours} h ` +
      `(limit ${mph(limit)})${onset ? `, reaching the limit at ${localClock(onset, offset)}` : ""}`,
  );

  if (due || (state.hold && peak >= limit)) {
    // --- rule 1: windy now or within the lead time -> hold off -------------
    const entering = !state.hold;
    state.hold = true;
    state.calm_since = null;
    if (entering) state.hold_since = iso(now);
    const { switched, failed } = await switchOff(cfg.devices, plug, dryRun, plugs, log);
    const start = onset && onset > now ? `from about ${localClock(onset, offset)}` : "right now";
    const gusts = `Gusts reach ${mph(limit)} mph ${start}, peaking at ${mph(peak)} mph.`;

    if (failed) {
      problems.push(`${failed} plug(s) could not be switched off`);
      await alertOnce(
        "plug",
        "Could not turn inflatables off",
        `${gusts} The Govee plug did not respond. Turn the inflatables off yourself.`,
      );
    } else {
      clearAlert("plug");
    }

    if (switched) record("Switched inflatables off for wind");
    else if (dryRun) record("Would switch inflatables off for wind (dry run)");
    else if (entering && !failed) record("High wind; inflatables were already off");

    if (!failed) {
      if (entering && (switched || dryRun)) {
        await send("High wind: inflatables turned off", `${gusts} You will get a message when it has passed.`);
      } else if (entering) {
        await send("High wind expected", `${gusts} Your inflatables are already off. Leave them off until the all-clear.`);
      } else if (switched) {
        await send("Inflatables turned off again", `It is still too windy. ${gusts}`);
      }
    }
  } else if (state.hold) {
    // --- rule 2: holding -> wait for calm, then tell the user ---------------
    if (peak < cfg.resumeBelowMph) {
      const parsed = Date.parse(state.calm_since ?? "");
      const calmStart = Number.isFinite(parsed) ? new Date(parsed) : now;
      state.calm_since = iso(calmStart);
      if (now.getTime() - calmStart.getTime() >= cfg.calmMinutes * 60 * 1000) {
        const delivered = await send(
          "Wind has passed",
          `Gusts should stay under ${mph(cfg.resumeBelowMph)} mph for the next ${cfg.lookaheadHours} hours ` +
            `(peak ${mph(peak)} mph). Turn the inflatables back on in the Govee app when you are ready.`,
          { tag: "white_check_mark" },
        );
        if (delivered) {
          // otherwise keep holding and retry next run
          state.hold = false;
          state.hold_since = null;
          state.calm_since = null;
          clearAlert("plug");
          record("Wind passed; all-clear sent");
        }
      }
    } else {
      state.calm_since = null; // between resume level and limit: keep waiting
    }
  }

  const upcoming = !state.hold && onset !== null ? [onset, new Date(onset.getTime() - leadMs)] : null;
  const status = buildStatus(cfg, state, now, outlook, problems, dryRun, upcoming);
  return { state, status: withPlugs(status, plugs), ok: problems.length === 0 };
}

/** Plug power states by position only (never device IDs), plus an overall summary. */
function withPlugs(status, plugs) {
  status.plugs = plugs;
  if (plugs.some((p) => p === true)) status.plug_on = true;
  else if (plugs.length && plugs.every((p) => p === false)) status.plug_on = false;
  else status.plug_on = null;
  return status;
}

/** The public status document. It must never contain location, keys or device IDs. */
export function buildStatus(cfg, state, now, outlook, problems, dryRun, upcoming = null) {
  let level;
  let headline;
  let detail;
  const limit = mph(cfg.gustThresholdMph);
  if (outlook && upcoming) {
    const [onset, switchOffAt] = upcoming;
    level = "watch";
    headline = `High wind expected at ${localClock(onset, outlook.utcOffsetSeconds)}`;
    detail =
      `Gusts reach ${limit} mph then. The inflatables will be turned off at about ` +
      `${localClock(switchOffAt, outlook.utcOffsetSeconds)}.`;
  } else if (!outlook) {
    level = "error";
    headline = "Monitor problem: no forecast";
    detail = "The forecast could not be read, so the inflatables are not being protected.";
  } else if (state.hold) {
    level = "hold";
    headline = "Inflatables held off for wind";
    detail = state.calm_since
      ? "Wind is easing. You will be notified once it has stayed calm."
      : `Peak gust ${mph(peakGust(outlook))} mph, limit ${limit} mph.`;
  } else {
    level = "ok";
    headline = "Wind is fine";
    detail = `Peak gust ${mph(peakGust(outlook))} mph in the next ${cfg.lookaheadHours} hours, limit ${limit} mph.`;
  }
  if (outlook && problems.length) {
    level = "error";
    headline = "Monitor problem";
    detail = problems.join("; ");
  }

  const pt = outlook ? peakTime(outlook) : null;
  return {
    checked_at: iso(now),
    level,
    headline,
    detail,
    hold: state.hold,
    hold_since: state.hold_since,
    last_action: state.last_action,
    last_action_at: state.last_action_at,
    threshold_mph: cfg.gustThresholdMph,
    resume_below_mph: cfg.resumeBelowMph,
    lookahead_hours: cfg.lookaheadHours,
    lead_minutes: cfg.leadMinutes,
    high_wind_at: upcoming ? iso(upcoming[0]) : null,
    switch_off_at: upcoming ? iso(upcoming[1]) : null,
    problems,
    dry_run: dryRun,
    current_speed_mph: outlook ? one(outlook.currentSpeed) : null,
    current_gust_mph: outlook ? one(outlook.currentGust) : null,
    peak_gust_mph: outlook ? one(peakGust(outlook)) : null,
    peak_time: pt ? iso(pt) : null,
    forecast: outlook
      ? outlook.readings.map((r) => ({ time: iso(r.time), speed_mph: one(r.speed), gust_mph: one(r.gust) }))
      : [],
  };
}
