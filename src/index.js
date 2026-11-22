// Cloudflare Worker: runs the wind check every 5 minutes (cron trigger), serves the
// dashboard (static assets) and its data, and runs a check when Refresh is tapped.
import { checkAndSave, handleRequest } from "./app.js";

export default {
  fetch(request, env) {
    return handleRequest(request, env);
  },
  scheduled(event, env, ctx) {
    ctx.waitUntil(
      checkAndSave(env).catch((err) => {
        console.error(`scheduled check failed: ${err?.message}`);
      }),
    );
  },
};
