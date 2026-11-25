# Wind for Blowup

Turns your inflatable decorations off before high wind arrives.

A free Cloudflare Worker checks the 15-minute wind forecast for your home
(Open-Meteo) every 5 minutes. When sustained wind is forecast to reach 25 mph or gusts 35 mph, it switches
your Govee smart plug off 30 minutes beforehand (or straight away if it is already
that windy) and sends a push notification to your phone. When the wind has passed
you get a second notification, and **you** decide whether to turn the inflatables
back on in the Govee app. This program never turns anything on.

The same Worker serves a dashboard: current wind, the forecast being watched,
whether the plug is on, a 7-day history and an activity log. Its **Refresh** button
runs a new check on the spot (at most once a minute).

## What you need

- A free [Cloudflare](https://dash.cloudflare.com/sign-up) account.
- A Govee API key: Govee Home app > Profile > Settings > **Apply for API Key**.
- An iPhone (iOS 16.4 or newer) or Android phone for alerts. Optionally the
  [ntfy](https://ntfy.sh) app as a second alert channel.
- [Node.js](https://nodejs.org) 20.12 or newer on your PC, for setup and deploying.

## Setup

1. **Install the tools:** `npm install`
2. **Fill in `.env`** (copy `.env.example`): `LATITUDE`, `LONGITUDE`, `GOVEE_API_KEY`,
   and optionally a long, hard-to-guess `NTFY_TOPIC` that you subscribe to in the ntfy app.
   Then run `npm run push-keys` to add the app alert keys and an alert code.
   `.env` is git-ignored; never commit it.
3. **Find your plug:** `npm run devices`, then copy the `SKU|DEVICE_ID` value of the
   inflatable plug into `GOVEE_DEVICES` (several plugs: separate with commas).
4. **Test locally:** `npm run test-notify` should buzz your phone, and
   `npm run dry-run` prints the wind and what the monitor would do, switching nothing.
5. **Sign in to Cloudflare:** `npx wrangler login`
6. **Create the database:** `npx wrangler d1 create wind-watch`, and put the
   `database_id` it prints into `wrangler.toml`.
7. **Deploy:** `npm run deploy`. Note the `https://wind-watch.<name>.workers.dev`
   address it prints: that is your dashboard.
8. **Add your private settings:** `npx wrangler secret bulk .env`. They are stored
   encrypted by Cloudflare and are never shown on the dashboard.
9. **Link notifications to the dashboard:** put the dashboard address in
   `STATUS_PAGE_URL` in `wrangler.toml` and deploy again.

The first scheduled check runs within 5 minutes; tap **Refresh** to run one now.

## Install on your iPhone

1. Open the dashboard address in **Safari**, tap **Share**, then **Add to Home Screen**.
2. Open **Wind Watch** from the Home Screen. Under **Phone alerts**, enter the
   `PUSH_CODE` from `.env` and tap **Turn on alerts**, then **Allow**.
3. Tap **Send a test alert**.

Alerts then arrive like any app's notifications, and tapping one opens the app. Do
this on each phone that should get alerts (up to 10). The code stops strangers who
find the address from signing up for your alerts.

## Settings (`wrangler.toml`, `[vars]`)

| Setting | Default | Meaning |
| --- | --- | --- |
| `SUSTAINED_THRESHOLD_MPH` | 25 | Sustained wind that counts as high wind (empty: gusts only) |
| `GUST_THRESHOLD_MPH` | 35 | Gust speed that counts as high wind |
| `LEAD_MINUTES` | 30 | Switch off this long before the high wind is forecast |
| `RESUME_BELOW_SUSTAINED_MPH` | 22 | Wind counts as passed once sustained wind is below this... |
| `RESUME_BELOW_MPH` | 32 | ...and gusts are below this |
| `LOOKAHEAD_HOURS` | 3 | How far ahead to read the forecast; the all-clear needs this whole window calm |
| `CALM_MINUTES` | 30 | How long it must stay calm before the all-clear |

Change a value, then `npm run deploy`. The check frequency is `crons` in the same file.

## Notifications you can get

| Message | Meaning |
| --- | --- |
| High wind: inflatables turned off | The plug was switched off |
| High wind expected | Wind is coming; the plug was already off |
| Inflatables turned off again | The plug was turned on during the wind and was switched off again |
| Wind has passed | Safe to turn back on, when you choose |
| Could not turn inflatables off (urgent) | The plug did not respond; turn it off yourself |
| Wind monitor cannot get the forecast (urgent) | You are unprotected until it recovers |

Alerts go to every phone with app alerts on, and to ntfy if `NTFY_TOPIC` is set.

Failure alerts are sent once per outage, not every 5 minutes.

## Commands

```
npm test              run the tests
npm run devices       list Govee devices
npm run test-notify   send a test notification through ntfy
npm run push-keys     add app alert keys and an alert code to .env
npm run dry-run       one check that switches nothing and notifies nobody
npm run deploy        publish to Cloudflare
npx wrangler tail     watch the live Worker's logs
```

No runtime packages: the Worker uses only the platform's built-in APIs.

## How it is built

- `src/monitor.js`: the rules (when to switch off, when to send the all-clear).
- `src/weather.js`, `src/govee.js`, `src/notify.js`: Open-Meteo, Govee, ntfy and app alerts.
- `src/webpush.js`: Web Push (encryption and VAPID signing) with built-in WebCrypto.
- `src/app.js`: saved state in Cloudflare D1, the dashboard's data and the Refresh check.
- `src/index.js`: Cloudflare entry point (5-minute cron and web requests).
- `public/index.html`: the dashboard; `public/sw.js` shows app alerts and keeps it working offline.

## Known limitations

- **Forecasts are not measurements.** A sudden local gust the forecast missed will
  not be caught. Stake and tether as usual.
- **While the plug is being held off, it is switched off again if you turn it on.**
  To override, raise `GUST_THRESHOLD_MPH` and deploy.
- **If the forecast service is down, nothing is switched.** You get an urgent
  notification instead.
- **The dashboard address is public** (it shows wind numbers and plug on/off only,
  no location, keys or device IDs), and anyone with it can tap Refresh. That only
  runs a check, at most once a minute, and a check can only ever turn the plug off.
- Speeds are in mph only.
