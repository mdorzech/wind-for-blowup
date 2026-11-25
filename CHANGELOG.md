# Changelog

## 2.1.0 - 2026-11-24

- Installs on the iPhone Home Screen as an app, with its own push alerts (Web Push); ntfy is now optional.
- Phone alerts panel: turn alerts on with a one-time code, send a test, turn off.
- Works offline with the last loaded check.
- High wind is sustained wind of 25 mph or gusts of 35 mph.

## 2.0.0 - 2026-11-22

- Runs on Cloudflare Workers instead of GitHub Actions: checks every 5 minutes on time.
- Dashboard served by the Worker; Refresh runs a check directly (once a minute at most).
- State and 7-day history in Cloudflare D1. Python version removed; setup tools are npm scripts.
- Dashboard shows whether the plug is on, a forecast chart, history and an activity log.
- Longer back-off when the forecast service rate-limits.

## 1.1.0 - 2026-11-22

- Switch off a set time (`lead_minutes`, default 30) before gusts are forecast to
  reach the threshold, instead of as soon as they appear anywhere in the next 3 hours.
- Uses Open-Meteo's 15-minute forecast for timing.
- Status page shows "High wind expected at ..." with the planned switch-off time.

## 1.0.0 - 2026-11-22

- Wind check against the Open-Meteo forecast (current gusts plus look-ahead window).
- Switches Govee smart plugs off at the gust threshold; never switches them on.
- ntfy push notifications: shut-off, all-clear, and one-per-outage failure alerts.
- Scheduled GitHub Actions workflow with state kept on a `status` branch.
- Static status page and `status` command.
- `devices`, `test-notify` and `check --dry-run` setup commands.
