"""State carried between scheduled runs (each run starts on a fresh machine)."""

from __future__ import annotations

import json
import logging
from dataclasses import asdict, dataclass, field, fields
from datetime import datetime
from pathlib import Path

log = logging.getLogger(__name__)


@dataclass
class State:
    hold: bool = False  # True while the inflatables are being kept off for wind
    hold_since: str | None = None
    calm_since: str | None = None
    last_action: str | None = None
    last_action_at: str | None = None
    alerted: list[str] = field(default_factory=list)  # failure kinds already notified

    def record(self, action: str, now: datetime) -> None:
        self.last_action = action
        self.last_action_at = now.isoformat()


def load_state(path: Path) -> State:
    """Read saved state; a missing or damaged file means a clean start."""
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        known = {f.name for f in fields(State)}
        state = State(**{k: v for k, v in raw.items() if k in known})
    except FileNotFoundError:
        return State()
    except (ValueError, TypeError, AttributeError, OSError) as exc:
        log.warning("state file unreadable (%s); starting clean", type(exc).__name__)
        return State()
    state.hold = state.hold is True
    if not isinstance(state.alerted, list):
        state.alerted = []
    for name in ("hold_since", "calm_since", "last_action", "last_action_at"):
        if not isinstance(getattr(state, name), (str, type(None))):
            setattr(state, name, None)
    return state


def save_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


def save_state(path: Path, state: State) -> None:
    save_json(path, asdict(state))
