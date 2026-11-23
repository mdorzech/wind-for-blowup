// Wind forecast from Open-Meteo (free, no key), in 15-minute steps.
import { HttpError, requestJson } from "./http.js";

export class WeatherError extends Error {}

const API_URL = "https://api.open-meteo.com/v1/forecast";
const STEP_MS = 15 * 60 * 1000;

function reading(value) {
  if (value === null || value === undefined || value === "") throw new WeatherError("missing wind reading");
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new WeatherError("wind reading out of range");
  return n;
}

/** Turn an Open-Meteo response into an outlook, keeping only steps in the look-ahead window. */
export function parseOutlook(payload, now, lookaheadHours) {
  let outlook;
  try {
    const current = payload.current;
    const series = payload.minutely_15;
    const times = series.time;
    const speeds = series.wind_speed_10m;
    const gusts = series.wind_gusts_10m;
    if (!Array.isArray(times) || !Array.isArray(speeds) || !Array.isArray(gusts)) {
      throw new WeatherError("forecast arrays missing");
    }
    if (times.length !== speeds.length || times.length !== gusts.length) {
      throw new WeatherError("forecast arrays differ in length");
    }
    const offset = Number(payload.utc_offset_seconds ?? 0);
    if (!Number.isInteger(offset) || Math.abs(offset) > 16 * 3600) throw new WeatherError("utc offset out of range");
    const currentSpeed = reading(current.wind_speed_10m);
    const currentGust = reading(current.wind_gusts_10m);
    const nowMs = now.getTime();
    const windowEnd = nowMs + lookaheadHours * 3600 * 1000;
    const readings = [];
    for (let i = 0; i < times.length; i += 1) {
      const t = Number(times[i]) * 1000;
      if (!Number.isFinite(t)) throw new WeatherError("bad forecast time");
      // Keep the step in progress and every step inside the window.
      if (t + STEP_MS <= nowMs || t > windowEnd) continue;
      readings.push({ time: new Date(t), speed: reading(speeds[i]), gust: reading(gusts[i]) });
    }
    outlook = {
      currentSpeed,
      currentGust: Math.max(currentGust, currentSpeed),
      readings,
      utcOffsetSeconds: offset,
    };
  } catch (err) {
    if (err instanceof WeatherError) throw new WeatherError(`unexpected forecast format (${err.message})`);
    throw new WeatherError(`unexpected forecast format (${err?.name || "error"})`);
  }
  if (!outlook.readings.length) throw new WeatherError("forecast contains no steps inside the look-ahead window");
  return outlook;
}

export function peakGust(outlook) {
  return Math.max(outlook.currentGust, ...outlook.readings.map((r) => r.gust));
}

export function peakSpeed(outlook) {
  return Math.max(outlook.currentSpeed, ...outlook.readings.map((r) => r.speed));
}

/** Forecast time of the first step for which `isHigh(speed, gust)` is true, if any. */
export function firstTimeWhere(outlook, isHigh) {
  const hit = outlook.readings.find((r) => isHigh(r.speed, r.gust));
  return hit ? hit.time : null;
}

/** When the peak is expected; null means the peak is the current reading. */
export function peakTime(outlook) {
  let worst = null;
  for (const r of outlook.readings) if (!worst || r.gust > worst.gust) worst = r;
  return worst && worst.gust > outlook.currentGust ? worst.time : null;
}

/** Forecast time of the first step whose gusts reach `mph`, if any. */
export function firstTimeAtOrAbove(outlook, mph) {
  const hit = outlook.readings.find((r) => r.gust >= mph);
  return hit ? hit.time : null;
}

export async function fetchOutlook(cfg, now, fetchJson = requestJson) {
  const query = new URLSearchParams({
    latitude: cfg.latitude.toFixed(4),
    longitude: cfg.longitude.toFixed(4),
    current: "wind_speed_10m,wind_gusts_10m",
    minutely_15: "wind_speed_10m,wind_gusts_10m",
    wind_speed_unit: "mph",
    timeformat: "unixtime",
    timezone: "auto",
    past_minutely_15: "4",
    forecast_minutely_15: String(cfg.lookaheadHours * 4 + 4),
  });
  let payload;
  try {
    payload = await fetchJson("GET", `${API_URL}?${query}`);
  } catch (err) {
    if (err instanceof HttpError) throw new WeatherError(err.message);
    throw err;
  }
  return parseOutlook(payload, now, cfg.lookaheadHours);
}
