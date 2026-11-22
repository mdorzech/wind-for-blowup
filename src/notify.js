// Phone push notifications through ntfy.
import { HttpError, requestJson } from "./http.js";

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
