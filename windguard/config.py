"""Configuration: non-sensitive settings from config.toml, private ones from the environment."""

from __future__ import annotations

import os
import re
import tomllib
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping, MutableMapping


class ConfigError(Exception):
    """The configuration is missing or invalid. The message is safe to show the user."""


@dataclass(frozen=True)
class Device:
    sku: str
    device_id: str


@dataclass(frozen=True)
class Config:
    latitude: float
    longitude: float
    gust_threshold_mph: float
    resume_below_mph: float
    lookahead_hours: int
    calm_minutes: int
    govee_api_key: str
    devices: tuple[Device, ...]
    ntfy_server: str
    ntfy_topic: str
    status_page_url: str


_TOPIC_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def load_dotenv(path: Path, env: MutableMapping[str, str]) -> None:
    """Load KEY=VALUE lines from a local .env file without overriding real environment variables."""
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        env.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def _number(value: object, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ConfigError(f"{name} must be a number")
    return float(value)


def _env_float(env: Mapping[str, str], name: str, low: float, high: float) -> float:
    raw = env.get(name, "").strip()
    if not raw:
        raise ConfigError(f"{name} is not set")
    try:
        value = float(raw)
    except ValueError:
        raise ConfigError(f"{name} must be a number") from None
    if not low <= value <= high:  # also rejects NaN
        raise ConfigError(f"{name} must be between {low:g} and {high:g}")
    return value


def parse_devices(raw: str) -> tuple[Device, ...]:
    """Parse 'SKU|DEVICE_ID' entries separated by commas (device IDs contain colons)."""
    devices = []
    for entry in (part.strip() for part in raw.split(",")):
        if not entry:
            continue
        sku, sep, device_id = entry.partition("|")
        if not sep or not sku.strip() or not device_id.strip():
            raise ConfigError("GOVEE_DEVICES entries must look like SKU|DEVICE_ID, separated by commas")
        devices.append(Device(sku.strip(), device_id.strip()))
    if not devices:
        raise ConfigError("GOVEE_DEVICES is not set (run 'python -m windguard devices' to find yours)")
    return tuple(devices)


def load_settings(path: Path) -> dict:
    try:
        with path.open("rb") as handle:
            return tomllib.load(handle)
    except FileNotFoundError:
        raise ConfigError(f"config file not found: {path}") from None
    except tomllib.TOMLDecodeError as exc:
        raise ConfigError(f"config file is not valid TOML: {exc}") from None


def govee_api_key(env: Mapping[str, str]) -> str:
    key = env.get("GOVEE_API_KEY", "").strip()
    if not key:
        raise ConfigError("GOVEE_API_KEY is not set")
    return key


def load_config(path: Path, env: Mapping[str, str] | None = None) -> Config:
    """Load and validate everything a wind check needs."""
    env = os.environ if env is None else env
    settings = load_settings(path)
    wind = settings.get("wind", {})
    notify = settings.get("notify", {})
    if not isinstance(wind, dict) or not isinstance(notify, dict):
        raise ConfigError("[wind] and [notify] must be tables")

    threshold = _number(wind.get("gust_threshold_mph", 20), "wind.gust_threshold_mph")
    if not 1 <= threshold <= 150:
        raise ConfigError("wind.gust_threshold_mph must be between 1 and 150")
    resume = _number(wind.get("resume_below_mph", max(threshold - 3, 0)), "wind.resume_below_mph")
    lookahead = _number(wind.get("lookahead_hours", 3), "wind.lookahead_hours")
    calm = _number(wind.get("calm_minutes", 30), "wind.calm_minutes")
    if not 0 <= resume <= threshold:
        raise ConfigError("wind.resume_below_mph must be between 0 and the gust threshold")
    if lookahead != int(lookahead) or not 1 <= lookahead <= 48:
        raise ConfigError("wind.lookahead_hours must be a whole number between 1 and 48")
    if calm != int(calm) or not 0 <= calm <= 1440:
        raise ConfigError("wind.calm_minutes must be a whole number between 0 and 1440")

    server = str(notify.get("ntfy_server", "https://ntfy.sh")).rstrip("/")
    if not server.startswith("https://"):
        raise ConfigError("notify.ntfy_server must start with https://")
    page_url = str(notify.get("status_page_url", "")).strip()
    if page_url and not page_url.startswith("https://"):
        raise ConfigError("notify.status_page_url must start with https:// or be empty")

    topic = env.get("NTFY_TOPIC", "").strip()
    if not _TOPIC_RE.match(topic):
        raise ConfigError("NTFY_TOPIC must be 1-64 letters, digits, '-' or '_'")

    return Config(
        latitude=_env_float(env, "LATITUDE", -90, 90),
        longitude=_env_float(env, "LONGITUDE", -180, 180),
        gust_threshold_mph=threshold,
        resume_below_mph=resume,
        lookahead_hours=int(lookahead),
        calm_minutes=int(calm),
        govee_api_key=govee_api_key(env),
        devices=parse_devices(env.get("GOVEE_DEVICES", "")),
        ntfy_server=server,
        ntfy_topic=topic,
        status_page_url=page_url,
    )
