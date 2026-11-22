"""Shared test fixtures: fakes for the forecast, the plug and the notifier."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from windguard.config import Config, Device
from windguard.govee import GoveeError
from windguard.notify import NotifyError
from windguard.weather import HourWind, Outlook

NOW = datetime(2026, 12, 1, 18, 10, tzinfo=timezone.utc)
PLUG_A = Device("H5080", "AA:BB:CC:DD:EE:FF:00:11")
PLUG_B = Device("H5080", "11:00:FF:EE:DD:CC:BB:AA")


def make_config(**overrides) -> Config:
    values = dict(
        latitude=41.5,
        longitude=-87.5,
        gust_threshold_mph=20.0,
        resume_below_mph=17.0,
        lookahead_hours=3,
        calm_minutes=30,
        govee_api_key="test-key",
        devices=(PLUG_A,),
        ntfy_server="https://ntfy.example",
        ntfy_topic="test-topic",
        status_page_url="",
    )
    values.update(overrides)
    return Config(**values)


def make_outlook(current_gust: float, *forecast_gusts: float) -> Outlook:
    """Outlook with the given current gust and one forecast hour per extra value."""
    start = NOW.replace(minute=0)
    hours = tuple(
        HourWind(start + timedelta(hours=i), gust * 0.6, gust)
        for i, gust in enumerate(forecast_gusts or (current_gust,))
    )
    return Outlook(current_gust * 0.6, current_gust, hours, utc_offset_seconds=-6 * 3600)


class FakePlug:
    def __init__(self, on=True, state_fails=False, off_fails=False):
        self.on = on
        self.state_fails = state_fails
        self.off_fails = off_fails
        self.off_calls: list[Device] = []

    def is_on(self, device):
        if self.state_fails:
            raise GoveeError("state unavailable")
        return self.on

    def turn_off(self, device):
        if self.off_fails:
            raise GoveeError("plug offline")
        self.off_calls.append(device)
        self.on = False


class FakeNotifier:
    def __init__(self, fails=False):
        self.fails = fails
        self.sent: list[tuple[str, str, bool]] = []

    def send(self, title, message, *, urgent=False, tag="wind_face"):
        if self.fails:
            raise NotifyError("ntfy down")
        self.sent.append((title, message, urgent))

    @property
    def titles(self) -> list[str]:
        return [title for title, _, _ in self.sent]
