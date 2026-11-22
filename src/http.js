// JSON-over-HTTPS with retries. URLs and header values are never logged or put in
// error messages: they can carry the location, the notification topic or an API key.

export class HttpError extends Error {}

const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function retryAfterMs(response, fallbackMs) {
  const seconds = Number(response.headers?.get?.("Retry-After"));
  const ms = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : fallbackMs;
  return Math.min(Math.max(ms, 1000), 60000);
}

export async function requestJson(method, url, options = {}) {
  const {
    headers = {},
    body,
    attempts = 4,
    timeoutMs = 15000,
    sleep = defaultSleep,
    fetchImpl = fetch,
    log = console,
  } = options;
  if (!/^https:\/\//i.test(url)) {
    throw new HttpError("refusing to send a request to a non-HTTPS URL");
  }
  const host = new URL(url).host;
  const allHeaders = { Accept: "application/json", "User-Agent": "wind-watch", ...headers };
  let payload;
  if (body !== undefined) {
    payload = JSON.stringify(body);
    allHeaders["Content-Type"] = "application/json";
  }

  let lastError = "no attempts made";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let waitMs = 2000 * attempt;
    let response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: allHeaders,
        body: payload,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      lastError = err?.name || "network error";
      response = null;
    }
    if (response) {
      if (response.ok) {
        const text = await response.text();
        if (!text) return {};
        try {
          return JSON.parse(text);
        } catch {
          throw new HttpError(`${host} returned a response that is not JSON`);
        }
      }
      lastError = `HTTP ${response.status}`;
      if (!RETRY_STATUS.has(response.status)) {
        throw new HttpError(`${host} answered ${lastError}`);
      }
      if (response.status === 429) {
        // Rate limited (shared cloud addresses hit this): back off much longer.
        waitMs = retryAfterMs(response, 15000 * attempt);
      }
    }
    log.warn?.(`${method} ${host} failed (${lastError}), attempt ${attempt} of ${attempts}`);
    if (attempt < attempts) await sleep(waitMs);
  }
  throw new HttpError(`${host} unreachable after ${attempts} attempts (${lastError})`);
}
