# Decisions log

| Date | Decision | Reason |
| --- | --- | --- |
| 2026-11-22 | Runs in the cloud on a free scheduler (GitHub Actions, every 15 min) | Owner's choice; nothing at home has to stay on |
| 2026-11-22 | Shut-off at 20 mph gusts, configurable | Owner's choice |
| 2026-11-22 | After wind passes: notify only, the owner turns things back on | Owner's choice |
| 2026-11-22 | Interface: CLI + status page + phone notifications | Owner's choice |
| 2026-11-22 | The Govee client has no "turn on" method at all | Makes "never switches on" a property of the code, not a convention |
| 2026-11-22 | Open-Meteo for forecasts | Free, no key, hourly gusts |
| 2026-11-22 | ntfy for push notifications | Free, no account; topic name is the only secret |
| 2026-11-22 | Python standard library only | Nothing to install or audit; fast scheduled runs |
| 2026-11-22 | State and status page force-pushed to a `status` branch | Scheduled runs are stateless; works in private repos; doubles as a Pages source |
| 2026-11-22 | Location, key, device IDs, topic are secrets; never written to status files or logs | Status branch may be public |
| 2026-11-22 | Resume level 3 mph under the threshold plus a 30-minute calm period | Stops repeated off/all-clear messages on borderline days |
| 2026-11-22 | Failure alerts once per outage | Reviewer condition; avoids a notification every 15 minutes |
| 2026-11-22 | Switch off 30 min before forecast high wind (configurable `lead_minutes`) | Owner's request; replaces "anywhere in next 3 h" |
| 2026-11-22 | 15-minute forecast steps; "high wind time" = first step at or above the threshold | Hourly steps too coarse for a 30-minute lead |
| 2026-11-22 | Once held, stay held while the threshold appears anywhere in the 3 h window | Avoids an all-clear between two gusty spells |
| 2026-11-22 | Forecast outage switches nothing | Not specified by the owner; simplest safe behaviour, documented as a limitation |
