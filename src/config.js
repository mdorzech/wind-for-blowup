// Settings come from the Worker environment: private values are Cloudflare secrets,
// the rest are [vars] in wrangler.toml. Locally they come from .env.

export class ConfigError extends Error {}

const TOPIC_RE = /^[A-Za-z0-9_-]{1,64}$/;

function text(env, name) {
  return String(env[name] ?? "").trim();
}

function number(env, name, fallback) {
  const raw = text(env, name);
  if (raw === "") {
    if (fallback === undefined) throw new ConfigError(`${name} is not set`);
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new ConfigError(`${name} must be a number`);
  return value;
}

function whole(value, name, low, high) {
  if (!Number.isInteger(value) || value < low || value > high) {
    throw new ConfigError(`${name} must be a whole number between ${low} and ${high}`);
  }
  return value;
}

export function parseDevices(raw) {
  const devices = [];
  for (const part of String(raw ?? "").split(",")) {
    const entry = part.trim();
    if (!entry) continue;
    const bar = entry.indexOf("|");
    const sku = bar > 0 ? entry.slice(0, bar).trim() : "";
    const device = bar > 0 ? entry.slice(bar + 1).trim() : "";
    if (!sku || !device) {
      throw new ConfigError("GOVEE_DEVICES entries must look like SKU|DEVICE_ID, separated by commas");
    }
    devices.push({ sku, device });
  }
  if (!devices.length) throw new ConfigError("GOVEE_DEVICES is not set");
  return devices;
}

export function goveeApiKey(env) {
  const key = text(env, "GOVEE_API_KEY");
  if (!key) throw new ConfigError("GOVEE_API_KEY is not set");
  return key;
}

export function loadConfig(env) {
  const latitude = number(env, "LATITUDE");
  const longitude = number(env, "LONGITUDE");
  if (latitude < -90 || latitude > 90) throw new ConfigError("LATITUDE must be between -90 and 90");
  if (longitude < -180 || longitude > 180) throw new ConfigError("LONGITUDE must be between -180 and 180");

  const threshold = number(env, "GUST_THRESHOLD_MPH", 20);
  if (threshold < 1 || threshold > 150) throw new ConfigError("GUST_THRESHOLD_MPH must be between 1 and 150");
  const resume = number(env, "RESUME_BELOW_MPH", Math.max(threshold - 3, 0));
  if (resume < 0 || resume > threshold) {
    throw new ConfigError("RESUME_BELOW_MPH must be between 0 and the gust threshold");
  }
  const lookahead = whole(number(env, "LOOKAHEAD_HOURS", 3), "LOOKAHEAD_HOURS", 1, 48);
  const lead = whole(number(env, "LEAD_MINUTES", 30), "LEAD_MINUTES", 0, lookahead * 60);
  const calm = whole(number(env, "CALM_MINUTES", 30), "CALM_MINUTES", 0, 1440);

  const ntfyServer = (text(env, "NTFY_SERVER") || "https://ntfy.sh").replace(/\/+$/, "");
  if (!ntfyServer.startsWith("https://")) throw new ConfigError("NTFY_SERVER must start with https://");
  const statusPageUrl = text(env, "STATUS_PAGE_URL");
  if (statusPageUrl && !statusPageUrl.startsWith("https://")) {
    throw new ConfigError("STATUS_PAGE_URL must start with https:// or be empty");
  }
  const topic = text(env, "NTFY_TOPIC");
  if (!TOPIC_RE.test(topic)) throw new ConfigError("NTFY_TOPIC must be 1-64 letters, digits, '-' or '_'");

  return {
    latitude,
    longitude,
    gustThresholdMph: threshold,
    resumeBelowMph: resume,
    lookaheadHours: lookahead,
    leadMinutes: lead,
    calmMinutes: calm,
    goveeApiKey: goveeApiKey(env),
    devices: parseDevices(env.GOVEE_DEVICES),
    ntfyServer,
    ntfyTopic: topic,
    statusPageUrl,
  };
}
