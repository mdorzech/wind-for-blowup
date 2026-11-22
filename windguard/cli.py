"""Command line: python -m windguard <check|devices|test-notify|status>."""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Sequence

from . import __version__
from .config import ConfigError, govee_api_key, load_config, load_dotenv
from .govee import GoveeClient, GoveeError
from .history import add_check, load_history, save_history
from .monitor import run_check
from .notify import Notifier, NotifyError
from .state import load_state, save_json, save_state
from .weather import fetch_outlook

log = logging.getLogger("windguard")


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="windguard",
        description="Turns inflatables off (Govee smart plug) before high wind arrives.",
    )
    parser.add_argument("--version", action="version", version=__version__)
    sub = parser.add_subparsers(dest="command", required=True)

    check = sub.add_parser("check", help="run one wind check")
    check.add_argument("--config", type=Path, default=Path("config.toml"))
    check.add_argument("--state", type=Path, default=Path("public/state.json"))
    check.add_argument("--status", type=Path, default=Path("public/status.json"))
    check.add_argument("--history", type=Path, default=Path("public/history.json"))
    check.add_argument("--dry-run", action="store_true", help="switch nothing, notify nobody, save no state")

    sub.add_parser("devices", help="list your Govee devices and the value to use in GOVEE_DEVICES")

    test = sub.add_parser("test-notify", help="send a test notification to your phone")
    test.add_argument("--config", type=Path, default=Path("config.toml"))

    status = sub.add_parser("status", help="show the result of the last check")
    status.add_argument("--status", type=Path, default=Path("public/status.json"))
    return parser


def _summary(status: dict) -> str:
    lines = [f"{status['headline']} - {status['detail']}"]
    if status.get("current_gust_mph") is not None:
        lines.append(
            f"Now: wind {status['current_speed_mph']} mph, gusts {status['current_gust_mph']} mph. "
            f"Peak gust next {status['lookahead_hours']} h: {status['peak_gust_mph']} mph "
            f"(limit {status['threshold_mph']} mph)."
        )
    if status.get("last_action"):
        lines.append(f"Last action: {status['last_action']} ({status['last_action_at']})")
    for problem in status.get("problems", []):
        lines.append(f"Problem: {problem}")
    lines.append(f"Checked: {status['checked_at']}" + (" (dry run)" if status.get("dry_run") else ""))
    return "\n".join(lines)


def _cmd_check(args: argparse.Namespace) -> int:
    cfg = load_config(args.config)
    now = datetime.now(timezone.utc)
    result = run_check(
        cfg,
        load_state(args.state),
        now,
        get_outlook=lambda: fetch_outlook(cfg.latitude, cfg.longitude, cfg.lookahead_hours, now),
        plug=GoveeClient(cfg.govee_api_key),
        notifier=Notifier(cfg.ntfy_server, cfg.ntfy_topic, cfg.status_page_url),
        dry_run=args.dry_run,
    )
    if not args.dry_run:
        save_state(args.state, result.state)
        save_json(args.status, result.status)
        save_history(args.history, add_check(load_history(args.history), result.status, now))
    summary = _summary(result.status)
    print(summary)
    step_summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if step_summary:
        with open(step_summary, "a", encoding="utf-8") as handle:
            handle.write("### Wind check\n\n" + summary.replace("\n", "  \n") + "\n")
    return 0 if result.ok else 1


def _cmd_devices(_: argparse.Namespace) -> int:
    devices = GoveeClient(govee_api_key(os.environ)).list_devices()
    if not devices:
        print("No devices found on this Govee account.")
        return 1
    print("Copy the first column of your inflatable plug(s) into GOVEE_DEVICES (comma-separated):\n")
    for device in devices:
        note = "" if device["switchable"] else "   (no on/off switch - cannot be used)"
        print(f"  {device['sku']}|{device['device_id']}   {device['name']}{note}")
    return 0


def _cmd_test_notify(args: argparse.Namespace) -> int:
    cfg = load_config(args.config)
    Notifier(cfg.ntfy_server, cfg.ntfy_topic, cfg.status_page_url).send(
        "Wind monitor test", "Notifications are working."
    )
    print("Test notification sent. Check your phone.")
    return 0


def _cmd_status(args: argparse.Namespace) -> int:
    try:
        status = json.loads(args.status.read_text(encoding="utf-8"))
        print(_summary(status))
    except FileNotFoundError:
        print("No check has run yet.")
        return 1
    except (ValueError, KeyError, TypeError):
        print("The status file is damaged; it will be rewritten by the next check.")
        return 1
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s", stream=sys.stderr)
    load_dotenv(Path(".env"), os.environ)
    commands = {
        "check": _cmd_check,
        "devices": _cmd_devices,
        "test-notify": _cmd_test_notify,
        "status": _cmd_status,
    }
    try:
        return commands[args.command](args)
    except ConfigError as exc:
        print(f"Configuration problem: {exc}", file=sys.stderr)
        return 2
    except (GoveeError, NotifyError) as exc:
        print(f"Failed: {exc}", file=sys.stderr)
        return 1
