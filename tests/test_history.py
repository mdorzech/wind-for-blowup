import json
import tempfile
import unittest
from datetime import timedelta
from pathlib import Path

from windguard.history import KEEP_EVENTS, add_check, load_history, save_history

from .helpers import NOW


def status(**overrides):
    base = {
        "current_gust_mph": 12.5, "peak_gust_mph": 24.4, "hold": False, "level": "watch",
        "last_action": None, "last_action_at": None, "problems": [],
    }
    base.update(overrides)
    return base


class HistoryTests(unittest.TestCase):
    def test_adds_a_compact_row_per_check(self):
        history = add_check({"checks": [], "events": []}, status(hold=True, level="hold", plug_on=False), NOW)
        self.assertEqual(history["checks"], [["2026-12-01T18:10:00+00:00", 12.5, 24.4, 1, "hold", 0]])
        history = add_check(history, status(plug_on=True), NOW)
        history = add_check(history, status(plug_on=None), NOW)
        self.assertEqual([row[5] for row in history["checks"]], [0, 1, None])
        self.assertEqual(history["events"], [])

    def test_drops_checks_older_than_seven_days(self):
        old = (NOW - timedelta(days=7, minutes=1)).isoformat()
        recent = (NOW - timedelta(days=6)).isoformat()
        history = {"checks": [[old, 1, 1, 0, "ok"], [recent, 2, 2, 0, "ok"], "junk", []], "events": []}
        history = add_check(history, status(), NOW)
        self.assertEqual([row[0] for row in history["checks"]], [recent, NOW.isoformat()])

    def test_logs_each_action_once(self):
        at = NOW.isoformat()
        history = {"checks": [], "events": []}
        for _ in range(3):
            history = add_check(history, status(last_action="Switched inflatables off for wind", last_action_at=at), NOW)
        self.assertEqual(history["events"], [{"at": at, "text": "Switched inflatables off for wind"}])

    def test_logs_a_problem_once_while_it_repeats(self):
        history = {"checks": [], "events": []}
        for minutes in (0, 5, 10):
            history = add_check(history, status(problems=["forecast unavailable"]), NOW + timedelta(minutes=minutes))
        self.assertEqual(len(history["events"]), 1)
        self.assertEqual(history["events"][0]["text"], "Problem: forecast unavailable")

    def test_keeps_the_newest_events(self):
        events = [{"at": f"2026-11-{i:02d}", "text": "x"} for i in range(1, KEEP_EVENTS + 1)]
        history = add_check({"checks": [], "events": events}, status(last_action="new", last_action_at="z"), NOW)
        self.assertEqual(len(history["events"]), KEEP_EVENTS)
        self.assertEqual(history["events"][-1]["text"], "new")

    def test_round_trip_and_damaged_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "sub" / "history.json"
            self.assertEqual(load_history(path), {"checks": [], "events": []})
            saved = add_check({"checks": [], "events": []}, status(), NOW)
            save_history(path, saved)
            self.assertEqual(load_history(path), saved)
            for text in ("", "nope", "[]", '{"checks": 5}'):
                with self.subTest(text=text):
                    path.write_text(text)
                    self.assertEqual(load_history(path), {"checks": [], "events": []})

    def test_history_holds_no_private_values(self):
        history = add_check({"checks": [], "events": []}, status(), NOW)
        text = json.dumps(history)
        for private in ("test-key", "test-topic", "AA:BB", "41.5"):
            self.assertNotIn(private, text)


if __name__ == "__main__":
    unittest.main()
