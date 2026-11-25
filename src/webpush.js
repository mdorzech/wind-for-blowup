// Web Push (RFC 8030/8291/8292) with only the platform's WebCrypto: VAPID-signed,
// aes128gcm-encrypted messages to the Home Screen app's push subscriptions.

const enc = new TextEncoder();

export function b64urlEncode(bytes) {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(text) {
  const s = String(text).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s + "=".repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8);
  return new Uint8Array(bits);
}

/** A VAPID key pair as base64url strings: public = 65-byte raw point, private = 32-byte d. */
export async function generateVapidKeys() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const publicKey = b64urlEncode(await crypto.subtle.exportKey("raw", pair.publicKey));
  const privateKey = (await crypto.subtle.exportKey("jwk", pair.privateKey)).d;
  return { publicKey, privateKey };
}

export function isValidSubscription(sub) {
  if (!sub || typeof sub !== "object") return false;
  let url;
  try {
    url = new URL(sub.endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || sub.endpoint.length > 1024) return false;
  try {
    return b64urlDecode(sub.keys?.p256dh).length === 65 && b64urlDecode(sub.keys?.auth).length === 16;
  } catch {
    return false;
  }
}

/** Encrypt `payload` (a string) for one subscription: the aes128gcm request body. */
export async function encryptPayload(sub, payload, { salt, localKeys } = {}) {
  const uaPublic = b64urlDecode(sub.keys.p256dh);
  const authSecret = b64urlDecode(sub.keys.auth);
  salt ??= crypto.getRandomValues(new Uint8Array(16));
  localKeys ??= await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", localKeys.publicKey));

  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, localKeys.privateKey, 256),
  );
  const ikm = await hkdf(authSecret, ecdhSecret, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);

  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const plain = concat(enc.encode(payload), new Uint8Array([2])); // single, last record
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, plain));

  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  return concat(header, asPublic, cipher);
}

/** The VAPID Authorization header for a push service origin. */
export async function vapidHeader(endpoint, vapid, now = new Date()) {
  const pub = b64urlDecode(vapid.publicKey);
  const jwk = {
    kty: "EC",
    crv: "P-256",
    x: b64urlEncode(pub.slice(1, 33)),
    y: b64urlEncode(pub.slice(33, 65)),
    d: vapid.privateKey,
  };
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const head = b64urlEncode(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64urlEncode(
    enc.encode(
      JSON.stringify({
        aud: new URL(endpoint).origin,
        exp: Math.floor(now.getTime() / 1000) + 12 * 3600,
        sub: vapid.subject,
      }),
    ),
  );
  const signed = `${head}.${claims}`;
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(signed));
  return `vapid t=${signed}.${b64urlEncode(sig)}, k=${vapid.publicKey}`;
}

/**
 * Send one message. Returns "sent", "gone" (subscription no longer exists: forget it)
 * or "failed".
 */
export async function sendPush(sub, message, vapid, { urgent = false, fetchFn = fetch, now } = {}) {
  try {
    const body = await encryptPayload(sub, JSON.stringify(message));
    const res = await fetchFn(sub.endpoint, {
      method: "POST",
      headers: {
        Authorization: await vapidHeader(sub.endpoint, vapid, now),
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: "43200",
        Urgency: urgent ? "high" : "normal",
      },
      body,
    });
    if (res.status === 404 || res.status === 410) return "gone";
    return res.ok ? "sent" : "failed";
  } catch {
    return "failed";
  }
}
