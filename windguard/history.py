"""Rolling history for the dashboard: one compact row per check plus a log of actions.

Like the status file, it is published and must never hold location, keys or device IDs.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)

KEEP_CHECKS = timedelta(days=7)
KEEP_EVENTS = 100


def load_history(path: Path) -> dict[str, list]:
    """Read saved history; a missing or damaged file means an empty history."""
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        checks = raw.get("checks", [])
        events = raw.get("events", [])
        if not isinstance(checks, list) or not isinstance(events, list):
            raise ValueError("history lists missing")
        return {"checks": checks, "events": events}
    except FileNotFoundError:
        pass
    except (ValueError, AttributeError, OSError) as exc:
        log.warning("history file unreadable (%s); starting a new one", type(exc).__name__)
    return {"checks": [], "events": []}


def _time(value: Any) -> datetime | None:
    try:
        return datetime.fromisoformat(value)
    except (TypeError, ValueError):
        return None


def add_check(history: dict[str, list], status: dict[str, Any], now: datetime) -> dict[str, list]:
    """Append this check and its action (if new), and drop rows older than seven days."""
    checks = [
        row for row in history["checks"]
        if isinstance(row, list) and row and (t := _time(row[0])) and now - t <= KEEP_CHECKS
    ]
    checks.append([
        now.isoformat(timespec="seconds"),
        status.get("current_gust_mph"),
        status.get("peak_gust_mph"),
        1 if status.get("hold") else 0,
        status.get("level"),
        {True: 1, False: 0}.get(status.get("plug_on")),  # None when unknown
    ])

    events = [e for e in history["events"] if isinstance(e, dict)]
    action, at = status.get("last_action"), status.get("last_action_at")
    if action and at and not any(e.get("at") == at for e in events):
        events.append({"at": at, "text": action})
    for problem in status.get("problems", []):
        text = f"Problem: {problem}"
        if not events or events[-1].get("text") != text:
            events.append({"at": now.isoformat(timespec="seconds"), "text": text})
    return {"checks": checks, "events": events[-KEEP_EVENTS:]}


def save_history(path: Path, history: dict[str, list]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(history, separators=(",", ":")) + "\n", encoding="utf-8")
