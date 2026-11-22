"""Wind forecast from Open-Meteo (free, no API key)."""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Callable
from urllib.parse import urlencode

from .http import HttpError, request_json

API_URL = "https://api.open-meteo.com/v1/forecast"


class WeatherError(Exception):
    """The forecast could not be fetched or understood."""


@dataclass(frozen=True)
class HourWind:
    time: datetime  # start of the forecast hour, UTC
    speed_mph: float
    gust_mph: float


@dataclass(frozen=True)
class Outlook:
    """Wind right now plus the forecast hours inside the look-ahead window."""

    current_speed_mph: float
    current_gust_mph: float
    hours: tuple[HourWind, ...]
    utc_offset_seconds: int = 0  # local time at the forecast location

    @property
    def peak_gust_mph(self) -> float:
        return max([self.current_gust_mph, *(h.gust_mph for h in self.hours)])

    @property
    def peak_time(self) -> datetime | None:
        """When the peak is expected; None means the peak is the current reading."""
        if not self.hours:
            return None
        worst = max(self.hours, key=lambda h: h.gust_mph)
        return worst.time if worst.gust_mph > self.current_gust_mph else None


def _reading(value: Any) -> float:
    number = float(value)  # raises TypeError for None
    if not math.isfinite(number) or number < 0:
        raise ValueError("wind reading out of range")
    return number


def parse_outlook(payload: Any, now: datetime, lookahead_hours: int) -> Outlook:
    """Turn an Open-Meteo response into an Outlook, keeping only hours in the window."""
    try:
        current = payload["current"]
        hourly = payload["hourly"]
        times = hourly["time"]
        speeds = hourly["wind_speed_10m"]
        gusts = hourly["wind_gusts_10m"]
        current_speed = _reading(current["wind_speed_10m"])
        current_gust = _reading(current["wind_gusts_10m"])
        if not (len(times) == len(speeds) == len(gusts)):
            raise ValueError("hourly arrays differ in length")
        offset = int(payload.get("utc_offset_seconds", 0))
        if abs(offset) > 16 * 3600:
            raise ValueError("utc offset out of range")
        window_end = now + timedelta(hours=lookahead_hours)
        hours = []
        for stamp, speed, gust in zip(times, speeds, gusts):
            start = datetime.fromtimestamp(int(stamp), tz=timezone.utc)
            # Keep the hour in progress and every hour that starts inside the window.
            if start + timedelta(hours=1) <= now or start > window_end:
                continue
            hours.append(HourWind(start, _reading(speed), _reading(gust)))
    except (KeyError, TypeError, ValueError, OverflowError, OSError) as exc:
        raise WeatherError(f"unexpected forecast format ({type(exc).__name__})") from exc
    if not hours:
        raise WeatherError("forecast contains no hours inside the look-ahead window")
    return Outlook(current_speed, max(current_gust, current_speed), tuple(hours), offset)


def fetch_outlook(
    latitude: float,
    longitude: float,
    lookahead_hours: int,
    now: datetime,
    fetch: Callable[..., Any] = request_json,
) -> Outlook:
    query = urlencode(
        {
            "latitude": f"{latitude:.4f}",
            "longitude": f"{longitude:.4f}",
            "current": "wind_speed_10m,wind_gusts_10m",
            "hourly": "wind_speed_10m,wind_gusts_10m",
            "wind_speed_unit": "mph",
            "timeformat": "unixtime",
            "timezone": "auto",
            "past_days": 1,
            "forecast_days": 3,
        }
    )
    try:
        payload = fetch("GET", f"{API_URL}?{query}")
    except HttpError as exc:
        raise WeatherError(str(exc)) from exc
    return parse_outlook(payload, now, lookahead_hours)
