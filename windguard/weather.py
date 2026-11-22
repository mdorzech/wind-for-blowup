"""Wind forecast from Open-Meteo (free, no API key), in 15-minute steps."""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Callable
from urllib.parse import urlencode

from .http import HttpError, request_json

API_URL = "https://api.open-meteo.com/v1/forecast"
STEP = timedelta(minutes=15)


class WeatherError(Exception):
    """The forecast could not be fetched or understood."""


@dataclass(frozen=True)
class WindReading:
    time: datetime  # forecast time of this 15-minute step, UTC
    speed_mph: float
    gust_mph: float


@dataclass(frozen=True)
class Outlook:
    """Wind right now plus the 15-minute forecast steps inside the look-ahead window."""

    current_speed_mph: float
    current_gust_mph: float
    readings: tuple[WindReading, ...]
    utc_offset_seconds: int = 0  # local time at the forecast location

    @property
    def peak_gust_mph(self) -> float:
        return max([self.current_gust_mph, *(r.gust_mph for r in self.readings)])

    @property
    def peak_time(self) -> datetime | None:
        """When the peak is expected; None means the peak is the current reading."""
        if not self.readings:
            return None
        worst = max(self.readings, key=lambda r: r.gust_mph)
        return worst.time if worst.gust_mph > self.current_gust_mph else None

    def first_time_at_or_above(self, gust_mph: float) -> datetime | None:
        """Forecast time of the first step whose gusts reach gust_mph, if any."""
        for reading in self.readings:
            if reading.gust_mph >= gust_mph:
                return reading.time
        return None


def _reading(value: Any) -> float:
    number = float(value)  # raises TypeError for None
    if not math.isfinite(number) or number < 0:
        raise ValueError("wind reading out of range")
    return number


def parse_outlook(payload: Any, now: datetime, lookahead_hours: int) -> Outlook:
    """Turn an Open-Meteo response into an Outlook, keeping only steps in the window."""
    try:
        current = payload["current"]
        series = payload["minutely_15"]
        times = series["time"]
        speeds = series["wind_speed_10m"]
        gusts = series["wind_gusts_10m"]
        current_speed = _reading(current["wind_speed_10m"])
        current_gust = _reading(current["wind_gusts_10m"])
        if not (len(times) == len(speeds) == len(gusts)):
            raise ValueError("forecast arrays differ in length")
        offset = int(payload.get("utc_offset_seconds", 0))
        if abs(offset) > 16 * 3600:
            raise ValueError("utc offset out of range")
        window_end = now + timedelta(hours=lookahead_hours)
        readings = []
        for stamp, speed, gust in zip(times, speeds, gusts):
            moment = datetime.fromtimestamp(int(stamp), tz=timezone.utc)
            # Keep the step in progress and every step inside the window.
            if moment + STEP <= now or moment > window_end:
                continue
            readings.append(WindReading(moment, _reading(speed), _reading(gust)))
    except (KeyError, TypeError, ValueError, OverflowError, OSError) as exc:
        raise WeatherError(f"unexpected forecast format ({type(exc).__name__})") from exc
    if not readings:
        raise WeatherError("forecast contains no steps inside the look-ahead window")
    return Outlook(current_speed, max(current_gust, current_speed), tuple(readings), offset)


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
            "minutely_15": "wind_speed_10m,wind_gusts_10m",
            "wind_speed_unit": "mph",
            "timeformat": "unixtime",
            "timezone": "auto",
            "past_minutely_15": 4,
            "forecast_minutely_15": lookahead_hours * 4 + 4,
        }
    )
    try:
        payload = fetch("GET", f"{API_URL}?{query}")
    except HttpError as exc:
        raise WeatherError(str(exc)) from exc
    return parse_outlook(payload, now, lookahead_hours)
