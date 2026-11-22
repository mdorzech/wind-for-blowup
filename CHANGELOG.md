# Changelog

## 1.0.0 - 2026-11-22

- Wind check against the Open-Meteo forecast (current gusts plus look-ahead window).
- Switches Govee smart plugs off at the gust threshold; never switches them on.
- ntfy push notifications: shut-off, all-clear, and one-per-outage failure alerts.
- Scheduled GitHub Actions workflow with state kept on a `status` branch.
- Static status page and `status` command.
- `devices`, `test-notify` and `check --dry-run` setup commands.
