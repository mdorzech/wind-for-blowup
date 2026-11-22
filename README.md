# Wind for Blowup

Turns your inflatable decorations off before high wind arrives.

Every 15 minutes a free GitHub Actions job reads the 15-minute wind forecast for
your home (Open-Meteo). When gusts are forecast to reach 20 mph, it switches your
Govee smart plug off 30 minutes beforehand (or straight away if it is already that
windy) and sends a push notification to your phone.
When the wind has passed you get a second notification, and **you** decide whether
to turn the inflatables back on in the Govee app. This program never turns
anything on.

Nothing has to stay running at home.

## What you need

- A GitHub account (free).
- A Govee API key: Govee Home app > Profile > Settings > **Apply for API Key**
  (it arrives by email).
- The [ntfy](https://ntfy.sh) app on your phone (free, no account).
- Python 3.11 or newer on your PC, only for the one-time setup commands below.

## Setup

1. **Put this folder in a GitHub repository.** A *private* repository keeps
   everything to yourself. A *public* one additionally lets you use the free
   status web page (step 6).

2. **Create a local `.env`** by copying `.env.example`, and fill in `LATITUDE`,
   `LONGITUDE` and `GOVEE_API_KEY`. `.env` is git-ignored; never commit it.

3. **Find your plug:**

   ```
   python -m windguard devices
   ```

   Copy the `SKU|DEVICE_ID` value of the inflatable plug into `GOVEE_DEVICES` in
   `.env`. Several plugs: separate them with commas. If your plug is not listed,
   or is marked "no on/off switch", Govee's API does not support that model.

4. **Set up notifications.** Pick a long, hard-to-guess topic name (anyone who
   knows it can read your notifications), put it in `NTFY_TOPIC`, and subscribe
   to the same name in the ntfy phone app. Then:

   ```
   python -m windguard test-notify
   python -m windguard check --dry-run
   ```

   The first should buzz your phone. The second prints the current wind and what
   the monitor would do, without switching anything.

5. **Add the five values as repository secrets:** GitHub > your repository >
   Settings > Secrets and variables > Actions > New repository secret.
   Names: `LATITUDE`, `LONGITUDE`, `GOVEE_API_KEY`, `GOVEE_DEVICES`, `NTFY_TOPIC`.

   Then open the **Actions** tab, choose **Wind check**, and press **Run
   workflow** once to confirm it works. After that it runs on its own.

6. **Optional status page (public repositories, or paid GitHub plans).**
   Settings > Pages > Deploy from a branch > `status` / root. The page shows
   current wind, the forecast being watched and the last action. Put its address
   in `status_page_url` in `config.toml` so tapping a notification opens it.
   The page contains wind numbers only: no location, keys or device IDs.
   Without Pages, each run's summary in the Actions tab shows the same facts.

## Settings (`config.toml`)

| Setting | Default | Meaning |
| --- | --- | --- |
| `gust_threshold_mph` | 20 | Gust speed that counts as high wind |
| `lead_minutes` | 30 | Switch off this long before the high wind is forecast |
| `resume_below_mph` | 17 | Wind counts as passed below this |
| `lookahead_hours` | 3 | How far ahead to read the forecast; the all-clear needs this whole window calm |
| `calm_minutes` | 30 | How long it must stay calm before the all-clear |

## Notifications you can get

| Message | Meaning |
| --- | --- |
| High wind: inflatables turned off | The plug was switched off |
| High wind expected | Wind is coming; the plug was already off |
| Inflatables turned off again | The plug was turned on during the wind and was switched off again |
| Wind has passed | Safe to turn back on, when you choose |
| Could not turn inflatables off (urgent) | The plug did not respond; turn it off yourself |
| Wind monitor cannot get the forecast (urgent) | You are unprotected until it recovers |

Failure alerts are sent once per outage, not every 15 minutes.

## Commands

```
python -m windguard check [--dry-run]   run one wind check
python -m windguard devices             list Govee devices
python -m windguard test-notify         send a test notification
python -m windguard status              show the last check's result
```

## Tests

```
python -m unittest discover -s tests -t .
```

No packages to install; the project uses only the Python standard library.

## Known limitations

- **GitHub's scheduler is best-effort.** Runs are often 5-20 minutes late and are
  occasionally skipped. With a 30-minute lead, a late run can mean the plug goes
  off only shortly before (or just after) the wind starts. Raise `lead_minutes`
  for more margin.
- **GitHub pauses schedules in repositories with no activity for 60 days.** It
  emails you first; re-enable the workflow in the Actions tab, or push any small
  commit at the start of each season.
- **Forecasts are not measurements.** A sudden local gust the forecast missed will
  not be caught. Stake and tether as usual.
- **While the plug is being held off, it is switched off again if you turn it on.**
  To override, raise the threshold or disable the workflow.
- **If the forecast service is down, nothing is switched.** You get an urgent
  notification instead.
- Speeds are in mph only. Windy periods inside a daily display schedule you run
  in the Govee app are handled naturally: an "off" command to an off plug is harmless,
  but a Govee schedule that turns the plug *on* during a hold will be countered
  only at the next check (up to about 15 minutes later).
