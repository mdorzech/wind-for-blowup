import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkAndSave, handleRequest } from "../src/app.js";
import { loadPush } from "../src/config.js";
import { AllNotifier, NotifyError, PushNotifier } from "../src/notify.js";
import { b64urlDecode, b64urlEncode, encryptPayload, generateVapidKeys, vapidHeader } from "../src/webpush.js";
import { FakeD1, FakeNotifier, FakePlug, NOW, makeOutlook, quiet } from "./helpers.js";

const subtle = crypto.subtle;
const dec = new TextDecoder();

/** A browser-side subscription with its private key, so tests can decrypt. */
async function makeBrowser(endpoint = "https://push.example/send/abc123") {
  const keys = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const sub = {
    endpoint,
    keys: { p256dh: b64urlEncode(await subtle.exportKey("raw", keys.publicKey)), auth: b64urlEncode(auth) },
  };
  return { sub, keys, auth };
}

async function hkdf(salt, ikm, info, len) {
  const k = await subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, k, len * 8));
}

/** RFC 8291 decryption, written independently of the sender. */
async function decrypt(browser, body) {
  const salt = body.slice(0, 16);
  const rs = new DataView(body.buffer, body.byteOffset).getUint32(16);
  const idlen = body[20];
  const asPublic = body.slice(21, 21 + idlen);
  const cipher = body.slice(21 + idlen);
  assert.equal(rs, 4096);
  const asKey = await subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const secret = new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: asKey }, browser.keys.privateKey, 256));
  const uaPublic = b64urlDecode(browser.sub.keys.p256dh);
  const te = new TextEncoder();
  const info = new Uint8Array([...te.encode("WebPush: info\0"), ...uaPublic, ...asPublic]);
  const ikm = await hkdf(browser.auth, secret, info, 32);
  const cek = await hkdf(salt, ikm, te.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, te.encode("Content-Encoding: nonce\0"), 12);
  const key = await subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const plain = new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, cipher));
  assert.equal(plain[plain.length - 1], 2, "last-record delimiter");
  return dec.decode(plain.slice(0, -1));
}

async function makeVapid() {
  return { ...(await generateVapidKeys()), subject: "https://wind.example/", code: "letmein-123" };
}

/** A push service stand-in that records (and decrypts) what it receives. */
function pushService(browsers, statusFor = () => 201) {
  const received = [];
  const fetchFn = async (url, init) => {
    const browser = browsers.find((b) => b.sub.endpoint === url);
    const text = browser ? await decrypt(browser, new Uint8Array(init.body)) : null;
    received.push({ url, headers: init.headers, text });
    return new Response(null, { status: statusFor(url) });
  };
  return { received, fetchFn };
}

describe("web push", () => {
  it("encrypts so the browser can decrypt (RFC 8291)", async () => {
    const browser = await makeBrowser();
    const body = await encryptPayload(browser.sub, '{"title":"Hi"}');
    assert.equal(await decrypt(browser, body), '{"title":"Hi"}');
  });

  it("signs a VAPID token the push service can verify", async () => {
    const vapid = await makeVapid();
    const header = await vapidHeader("https://web.push.apple.com/abc", vapid, NOW);
    const [, token, k] = header.match(/^vapid t=([^,]+), k=(.+)$/);
    assert.equal(k, vapid.publicKey);
    const [h, c, s] = token.split(".");
    const claims = JSON.parse(dec.decode(b64urlDecode(c)));
    assert.equal(claims.aud, "https://web.push.apple.com");
    assert.equal(claims.sub, "https://wind.example/");
    assert.ok(claims.exp > NOW.getTime() / 1000);
    const pub = await subtle.importKey(
      "raw", b64urlDecode(vapid.publicKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"],
    );
    const ok = await subtle.verify(
      { name: "ECDSA", hash: "SHA-256" }, pub, b64urlDecode(s), new TextEncoder().encode(`${h}.${c}`),
    );
    assert.ok(ok, "signature verifies");
  });

  it("sends to every phone and remembers the ones that are gone", async () => {
    const vapid = await makeVapid();
    const a = await makeBrowser("https://push.example/a");
    const b = await makeBrowser("https://push.example/b");
    const svc = pushService([a, b], (url) => (url.endsWith("/b") ? 410 : 201));
    const n = new PushNotifier([a.sub, b.sub], vapid, "https://wind.example/", { fetchFn: svc.fetchFn });
    await n.send("High wind", "Turned off", { urgent: true });
    assert.equal(svc.received.length, 2);
    assert.deepEqual(JSON.parse(svc.received[0].text), {
      title: "High wind", body: "Turned off", url: "https://wind.example/", tag: "wind", urgent: true,
    });
    assert.equal(svc.received[0].headers.Urgency, "high");
    assert.deepEqual([...n.gone], ["https://push.example/b"]);
  });

  it("fails only when no channel delivers", async () => {
    const ok = new FakeNotifier();
    await new AllNotifier([ok, new FakeNotifier({ fails: true })], quiet).send("T", "M");
    assert.deepEqual(ok.titles, ["T"]);
    await assert.rejects(new AllNotifier([new FakeNotifier({ fails: true })], quiet).send("T", "M"), NotifyError);
    await assert.rejects(new AllNotifier([], quiet).send("T", "M"), NotifyError);
  });

  it("is off until all push settings are present", () => {
    assert.equal(loadPush({}), null);
    const env = { VAPID_PUBLIC_KEY: "p", VAPID_PRIVATE_KEY: "k", PUSH_CODE: "c", STATUS_PAGE_URL: "https://w.example/" };
    assert.deepEqual(loadPush(env), { publicKey: "p", privateKey: "k", subject: "https://w.example/", code: "c" });
    assert.equal(loadPush({ ...env, PUSH_CODE: "" }), null);
  });
});

describe("app alert routes", () => {
  async function setup() {
    const vapid = await makeVapid();
    const env = {
      LATITUDE: "41.5",
      LONGITUDE: "-87.5",
      GOVEE_API_KEY: "key",
      GOVEE_DEVICES: "H5080|AA:BB",
      VAPID_PUBLIC_KEY: vapid.publicKey,
      VAPID_PRIVATE_KEY: vapid.privateKey,
      PUSH_CODE: vapid.code,
      STATUS_PAGE_URL: "https://wind.example/",
      DB: new FakeD1(),
    };
    return { env, vapid };
  }
  const post = (path, body) =>
    new Request(`https://wind.example${path}`, { method: "POST", body: JSON.stringify(body) });
  const config = () => new Request("https://wind.example/api/push/config");

  it("shares the public key, never the private key or code", async () => {
    const { env, vapid } = await setup();
    assert.deepEqual(await (await handleRequest(config(), env)).json(), { enabled: true, publicKey: vapid.publicKey });
    delete env.PUSH_CODE;
    assert.equal((await (await handleRequest(config(), env)).json()).enabled, false);
  });

  it("subscribes only with the right code", async () => {
    const { env, vapid } = await setup();
    const phone = await makeBrowser();
    const wrong = await handleRequest(post("/api/push/subscribe", { subscription: phone.sub, code: "nope" }), env);
    assert.equal(wrong.status, 403);
    assert.equal(env.DB.doc("push_subs"), undefined);
    const bad = { endpoint: "http://insecure.example/x", keys: phone.sub.keys };
    assert.equal((await handleRequest(post("/api/push/subscribe", { subscription: bad, code: vapid.code }), env)).status, 400);
    const ok = await handleRequest(post("/api/push/subscribe", { subscription: phone.sub, code: vapid.code }), env);
    assert.equal(ok.status, 200);
    await handleRequest(post("/api/push/subscribe", { subscription: phone.sub, code: vapid.code }), env);
    assert.equal(env.DB.doc("push_subs").length, 1, "subscribing twice keeps one entry");
  });

  it("sends a test and unsubscribes a known phone only", async () => {
    const { env, vapid } = await setup();
    const phone = await makeBrowser();
    await handleRequest(post("/api/push/subscribe", { subscription: phone.sub, code: vapid.code }), env);
    const svc = pushService([phone]);
    const stranger = await makeBrowser("https://push.example/stranger");
    const denied = await handleRequest(post("/api/push/test", { subscription: stranger.sub }), env, { fetchFn: svc.fetchFn });
    assert.equal(denied.status, 404);
    const res = await handleRequest(post("/api/push/test", { subscription: phone.sub }), env, { fetchFn: svc.fetchFn });
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(svc.received[0].text).title, "Wind Watch test");
    assert.equal((await handleRequest(post("/api/push/unsubscribe", { subscription: phone.sub }), env)).status, 200);
    assert.deepEqual(env.DB.doc("push_subs"), []);
  });

  it("alerts subscribed phones during a check and drops dead subscriptions", async () => {
    const { env, vapid } = await setup();
    const live = await makeBrowser("https://push.example/live");
    const dead = await makeBrowser("https://push.example/dead");
    for (const p of [live, dead]) {
      await handleRequest(post("/api/push/subscribe", { subscription: p.sub, code: vapid.code }), env);
    }
    const svc = pushService([live, dead], (url) => (url.endsWith("/dead") ? 410 : 201));
    const deps = { getOutlook: async () => makeOutlook(30), plug: new FakePlug(), fetchFn: svc.fetchFn };
    const result = await checkAndSave(env, { now: NOW, deps, log: quiet });
    assert.equal(result.status.level, "hold");
    assert.deepEqual(result.status.problems, []);
    assert.equal(JSON.parse(svc.received[0].text).title, "High wind: inflatables turned off");
    assert.deepEqual(env.DB.doc("push_subs").map((s) => s.endpoint), ["https://push.example/live"]);
  });
});
