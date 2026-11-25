// Phone notifications: ntfy and/or the Home Screen app (Web Push).
import { HttpError, requestJson } from "./http.js";
import { sendPush } from "./webpush.js";

export class NotifyError extends Error {}

export class Notifier {
  constructor(server, topic, clickUrl = "", fetchJson = requestJson) {
    this.server = server;
    this.topic = topic;
    this.clickUrl = clickUrl;
    this.fetchJson = fetchJson;
  }

  async send(title, message, { urgent = false, tag = "wind_face" } = {}) {
    const body = { topic: this.topic, title, message, priority: urgent ? 5 : 3, tags: [tag] };
    if (this.clickUrl) body.click = this.clickUrl;
    try {
      await this.fetchJson("POST", `${this.server}/`, { body });
    } catch (err) {
      if (err instanceof HttpError) throw new NotifyError(err.message);
      throw err;
    }
  }
}

/** Push notifications to the Home Screen app (Web Push), one per saved subscription. */
export class PushNotifier {
  constructor(subscriptions, vapid, clickUrl = "/", { fetchFn, now } = {}) {
    this.subscriptions = subscriptions;
    this.vapid = vapid;
    this.clickUrl = clickUrl || "/";
    this.fetchFn = fetchFn;
    this.now = now;
    this.gone = new Set(); // endpoints the push service says no longer exist
  }

  async send(title, message, { urgent = false, tag = "wind" } = {}) {
    if (!this.subscriptions.length) throw new NotifyError("no phone has turned on app alerts");
    const payload = { title, body: message, url: this.clickUrl, tag, urgent };
    const results = await Promise.all(
      this.subscriptions.map((sub) =>
        sendPush(sub, payload, this.vapid, { urgent, fetchFn: this.fetchFn ?? fetch, now: this.now }),
      ),
    );
    results.forEach((r, i) => {
      if (r === "gone") this.gone.add(this.subscriptions[i].endpoint);
    });
    if (!results.includes("sent")) throw new NotifyError("app alert could not be delivered");
  }
}

/** Sends through every channel; succeeds if at least one delivers. */
export class AllNotifier {
  constructor(channels, log = console) {
    this.channels = channels;
    this.log = log;
  }

  async send(title, message, options = {}) {
    if (!this.channels.length) throw new NotifyError("no notification channel is set up");
    const results = await Promise.allSettled(this.channels.map((c) => c.send(title, message, options)));
    const failures = results.filter((r) => r.status === "rejected").map((r) => r.reason);
    for (const err of failures) if (!(err instanceof NotifyError)) throw err;
    if (failures.length === results.length) throw new NotifyError(failures.map((e) => e.message).join("; "));
    for (const err of failures) this.log.warn?.(`one notification channel failed: ${err.message}`);
  }
}
