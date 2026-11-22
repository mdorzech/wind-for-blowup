"""One wind check: read the forecast, decide, switch plugs off, notify.

The rules, in order:
  1. Peak gust (now or within the look-ahead window) at or above the threshold:
     hold the inflatables off. Plugs found on are switched off on every windy run.
  2. While holding, once the peak has stayed below the resume level for the calm
     period: tell the user the wind has passed. The user decides whether to turn
     the inflatables back on; this program never switches anything on.
  3. Any failure (forecast, plug, notification) is reported, and alerts are sent
     once per failure streak rather than on every run.
"""

from __future__ import annotations

import copy
import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Protocol

from .config import Config, Device
from .govee import GoveeError
from .notify import NotifyError
from .state import State
from .weather import Outlook, WeatherError

log = logging.getLogger(__name__)


class Plug(Protocol):
    def is_on(self, device: Device) -> bool | None: ...
    def turn_off(self, device: Device) -> None: ...


class Sender(Protocol):
    def send(self, title: str, message: str, *, urgent: bool = False, tag: str = "wind_face") -> None: ...


@dataclass
class CheckResult:
    state: State
    status: dict[str, Any]
    ok: bool


def _local_clock(moment: datetime, offset_seconds: int) -> str:
    local = moment.astimezone(timezone(timedelta(seconds=offset_seconds)))
    return local.strftime("%I:%M %p").lstrip("0")


def _parse_time(value: str | None, fallback: datetime) -> datetime:
    try:
        parsed = datetime.fromisoformat(value) if value else fallback
    except (TypeError, ValueError):
        return fallback
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _switch_off(devices: tuple[Device, ...], plug: Plug, dry_run: bool) -> tuple[int, int]:
    """Switch off every plug that is not already off. Returns (switched, failed)."""
    switched = failed = 0
    for number, device in enumerate(devices, start=1):
        if dry_run:
            log.info("dry run: would switch off plug %d", number)
            continue
        try:
            already_off = plug.is_on(device) is False
        except GoveeError:
            already_off = False  # state unknown: send the off command anyway
        if already_off:
            log.info("plug %d is already off", number)
            continue
        try:
            plug.turn_off(device)
            switched += 1
            log.info("plug %d switched off", number)
        except GoveeError as exc:
            failed += 1
            log.error("plug %d could not be switched off: %s", number, exc)
    return switched, failed


def run_check(
    cfg: Config,
    previous: State,
    now: datetime,
    *,
    get_outlook: Callable[[], Outlook],
    plug: Plug,
    notifier: Sender,
    dry_run: bool = False,
) -> CheckResult:
    state = copy.deepcopy(previous)
    problems: list[str] = []

    def send(title: str, message: str, *, urgent: bool = False, tag: str = "wind_face") -> bool:
        if dry_run:
            log.info("dry run: would notify: %s - %s", title, message)
            return True
        try:
            notifier.send(title, message, urgent=urgent, tag=tag)
            return True
        except NotifyError as exc:
            problems.append(f"notification not delivered: {exc}")
            log.error("notification not delivered: %s", exc)
            return False

    def alert_once(kind: str, title: str, message: str) -> None:
        if kind not in state.alerted and send(title, message, urgent=True, tag="warning") and not dry_run:
            state.alerted.append(kind)

    def clear_alert(kind: str) -> bool:
        if kind in state.alerted:
            state.alerted.remove(kind)
            return True
        return False

    # --- forecast -----------------------------------------------------------
    try:
        outlook = get_outlook()
    except WeatherError as exc:
        problems.append(f"forecast unavailable: {exc}")
        log.error("forecast unavailable: %s", exc)
        alert_once(
            "weather",
            "Wind monitor cannot get the forecast",
            "Your inflatables are not being protected until this clears. "
            "If it is windy, turn them off yourself.",
        )
        return CheckResult(state, _status(cfg, state, now, None, problems, dry_run), False)

    if clear_alert("weather"):
        send("Wind monitor is working again", "The forecast is available and checks have resumed.")

    peak = outlook.peak_gust_mph
    peak_time = outlook.peak_time
    when = f"around {_local_clock(peak_time, outlook.utc_offset_seconds)}" if peak_time else "right now"
    log.info(
        "gusts now %.0f mph, peak %.0f mph in the next %d h (limit %.0f)",
        outlook.current_gust_mph, peak, cfg.lookahead_hours, cfg.gust_threshold_mph,
    )

    # --- rule 1: windy -> hold off ------------------------------------------
    if peak >= cfg.gust_threshold_mph:
        entering = not state.hold
        state.hold = True
        state.calm_since = None
        if entering:
            state.hold_since = now.isoformat()
        switched, failed = _switch_off(cfg.devices, plug, dry_run)
        gusts = f"Gusts up to {peak:.0f} mph {when} (limit {cfg.gust_threshold_mph:.0f} mph)."

        if failed:
            problems.append(f"{failed} plug(s) could not be switched off")
            alert_once(
                "plug",
                "Could not turn inflatables off",
                f"{gusts} The Govee plug did not respond. Turn the inflatables off yourself.",
            )
        else:
            clear_alert("plug")

        if switched:
            state.record("Switched inflatables off for wind", now)
        elif entering and not failed:
            state.record("High wind; inflatables were already off", now)

        if not failed:
            if entering and (switched or dry_run):
                send("High wind: inflatables turned off", f"{gusts} You will get a message when it has passed.")
            elif entering:
                send("High wind expected", f"{gusts} Your inflatables are already off. Leave them off until the all-clear.")
            elif switched:
                send("Inflatables turned off again", f"It is still too windy. {gusts}")

    # --- rule 2: holding -> wait for calm, then tell the user ----------------
    elif state.hold:
        if peak < cfg.resume_below_mph:
            calm_start = _parse_time(state.calm_since, now)
            state.calm_since = calm_start.isoformat()
            if now - calm_start >= timedelta(minutes=cfg.calm_minutes):
                delivered = send(
                    "Wind has passed",
                    f"Gusts should stay under {cfg.resume_below_mph:.0f} mph for the next "
                    f"{cfg.lookahead_hours} hours (peak {peak:.0f} mph). "
                    "Turn the inflatables back on in the Govee app when you are ready.",
                    tag="white_check_mark",
                )
                if delivered:  # keep holding and retry next run if the message did not go out
                    state.hold = False
                    state.hold_since = None
                    state.calm_since = None
                    clear_alert("plug")
                    state.record("Wind passed; all-clear sent", now)
        else:
            state.calm_since = None  # between resume level and limit: keep waiting

    return CheckResult(state, _status(cfg, state, now, outlook, problems, dry_run), not problems)


def _status(
    cfg: Config,
    state: State,
    now: datetime,
    outlook: Outlook | None,
    problems: list[str],
    dry_run: bool,
) -> dict[str, Any]:
    """Build the public status document. It must never contain location, keys or device IDs."""
    if outlook is None:
        level, headline = "error", "Monitor problem: no forecast"
        detail = "The forecast could not be read, so the inflatables are not being protected."
    elif state.hold:
        level, headline = "hold", "Inflatables held off for wind"
        if state.calm_since:
            detail = "Wind is easing. You will be notified once it has stayed calm."
        else:
            detail = f"Peak gust {outlook.peak_gust_mph:.0f} mph, limit {cfg.gust_threshold_mph:.0f} mph."
    else:
        level, headline = "ok", "Wind is fine"
        detail = (
            f"Peak gust {outlook.peak_gust_mph:.0f} mph in the next {cfg.lookahead_hours} hours, "
            f"limit {cfg.gust_threshold_mph:.0f} mph."
        )
    if outlook is not None and problems:
        level = "error"
        headline = "Monitor problem"
        detail = "; ".join(problems)

    status: dict[str, Any] = {
        "checked_at": now.isoformat(),
        "level": level,
        "headline": headline,
        "detail": detail,
        "hold": state.hold,
        "hold_since": state.hold_since,
        "last_action": state.last_action,
        "last_action_at": state.last_action_at,
        "threshold_mph": cfg.gust_threshold_mph,
        "resume_below_mph": cfg.resume_below_mph,
        "lookahead_hours": cfg.lookahead_hours,
        "problems": problems,
        "dry_run": dry_run,
        "current_speed_mph": None,
        "current_gust_mph": None,
        "peak_gust_mph": None,
        "peak_time": None,
        "hours": [],
    }
    if outlook is not None:
        status.update(
            current_speed_mph=round(outlook.current_speed_mph, 1),
            current_gust_mph=round(outlook.current_gust_mph, 1),
            peak_gust_mph=round(outlook.peak_gust_mph, 1),
            peak_time=outlook.peak_time.isoformat() if outlook.peak_time else None,
            hours=[
                {"time": h.time.isoformat(), "speed_mph": round(h.speed_mph, 1), "gust_mph": round(h.gust_mph, 1)}
                for h in outlook.hours
            ],
        )
    return status
