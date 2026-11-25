// Local setup tools. Reads settings from .env in the current folder.
//   node scripts/cli.mjs devices      list Govee devices and the GOVEE_DEVICES value for each
//   node scripts/cli.mjs test-notify  send a test notification to your phone
//   node scripts/cli.mjs dry-run      run one check that switches nothing and notifies nobody
//   node scripts/cli.mjs push-keys    add Home Screen app alert keys and an alert code to .env
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { ConfigError, goveeApiKey, loadConfig } from "../src/config.js";
import { GoveeClient, GoveeError } from "../src/govee.js";
import { newState, runCheck } from "../src/monitor.js";
import { Notifier, NotifyError } from "../src/notify.js";
import { fetchOutlook } from "../src/weather.js";
import { b64urlEncode, generateVapidKeys } from "../src/webpush.js";

const TOML_DEFAULTS = {
  SUSTAINED_THRESHOLD_MPH: "25",
  GUST_THRESHOLD_MPH: "35",
  LEAD_MINUTES: "30",
  RESUME_BELOW_SUSTAINED_MPH: "22",
  RESUME_BELOW_MPH: "32",
  LOOKAHEAD_HOURS: "3",
  CALM_MINUTES: "30",
};

async function main(command) {
  if (existsSync(".env")) process.loadEnvFile(".env");
  const env = { ...TOML_DEFAULTS, ...process.env };

  if (command === "devices") {
    const devices = await new GoveeClient(goveeApiKey(env)).listDevices();
    if (!devices.length) {
      console.log("No devices found on this Govee account.");
      return 1;
    }
    console.log("Copy the first column of your inflatable plug(s) into GOVEE_DEVICES (comma-separated):\n");
    for (const d of devices) {
      console.log(`  ${d.sku}|${d.device}   ${d.name}${d.switchable ? "" : "   (no on/off switch - cannot be used)"}`);
    }
    return 0;
  }

  if (command === "push-keys") {
    const existing = existsSync(".env") ? readFileSync(".env", "utf8") : "";
    if (/^VAPID_PRIVATE_KEY=./m.test(existing)) {
      console.log("App alert keys are already in .env. Nothing changed.");
      return 0;
    }
    const keys = await generateVapidKeys();
    const code = b64urlEncode(crypto.getRandomValues(new Uint8Array(9)));
    appendFileSync(
      ".env",
      (existing && !existing.endsWith("\n") ? "\n" : "") +
        [
          "",
          "# Home Screen app alerts (from npm run push-keys). PUSH_CODE is typed once on each phone.",
          `VAPID_PUBLIC_KEY=${keys.publicKey}`,
          `VAPID_PRIVATE_KEY=${keys.privateKey}`,
          `PUSH_CODE=${code}`,
          "",
        ].join("\n"),
    );
    console.log("Added app alert keys and PUSH_CODE to .env.");
    console.log("Next: npx.cmd wrangler secret bulk .env");
    return 0;
  }

  if (command === "test-notify") {
    const cfg = loadConfig(env);
    if (!cfg.ntfyTopic) {
      console.log("NTFY_TOPIC is empty, so ntfy is off. Use Send a test alert in the app instead.");
      return 1;
    }
    await new Notifier(cfg.ntfyServer, cfg.ntfyTopic, cfg.statusPageUrl).send("Wind monitor test", "Notifications are working.");
    console.log("Test notification sent. Check your phone.");
    return 0;
  }

  if (command === "dry-run") {
    const cfg = loadConfig(env);
    const now = new Date();
    const { status } = await runCheck(cfg, newState(), now, {
      getOutlook: () => fetchOutlook(cfg, now),
      plug: new GoveeClient(cfg.goveeApiKey),
      notifier: new Notifier(cfg.ntfyServer, cfg.ntfyTopic),
      dryRun: true,
    });
    console.log(`${status.headline} - ${status.detail}`);
    if (status.current_gust_mph !== null) {
      console.log(
        `Now: wind ${status.current_speed_mph} mph, gusts ${status.current_gust_mph} mph. ` +
          `Peak gust next ${status.lookahead_hours} h: ${status.peak_gust_mph} mph (limit ${status.threshold_mph} mph).`,
      );
    }
    const plug = status.plug_on === true ? "on" : status.plug_on === false ? "off" : "unknown";
    console.log(`Plug: ${plug}`);
    return status.problems.length ? 1 : 0;
  }

  console.log("Usage: node scripts/cli.mjs <devices|test-notify|dry-run|push-keys>");
  return 2;
}

try {
  process.exitCode = await main(process.argv[2]);
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(`Configuration problem: ${err.message}`);
    process.exitCode = 2;
  } else if (err instanceof GoveeError || err instanceof NotifyError) {
    console.error(`Failed: ${err.message}`);
    process.exitCode = 1;
  } else {
    throw err;
  }
}
