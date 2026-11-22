import json
import unittest
from datetime import timedelta

from windguard.monitor import run_check
from windguard.state import State
from windguard.weather import WeatherError

from .helpers import NOW, PLUG_A, PLUG_B, FakeNotifier, FakePlug, make_config, make_outlook


def check(state=None, outlook=None, plug=None, notifier=None, now=NOW, error=None, **cfg):
    plug = plug if plug is not None else FakePlug()
    notifier = notifier if notifier is not None else FakeNotifier()

    def get_outlook():
        if error:
            raise error
        return outlook

    result = run_check(
        make_config(**cfg), state or State(), now,
        get_outlook=get_outlook, plug=plug, notifier=notifier,
        dry_run=False,
    )
    return result, plug, notifier


class WindyTests(unittest.TestCase):
    def test_forecast_gust_at_threshold_turns_plug_off_and_notifies(self):
        result, plug, notifier = check(outlook=make_outlook(8, 10, 20, 12))
        self.assertEqual(plug.off_calls, [PLUG_A])
        self.assertTrue(result.state.hold)
        self.assertEqual(result.state.hold_since, NOW.isoformat())
        self.assertEqual(notifier.titles, ["High wind: inflatables turned off"])
        self.assertIn("20 mph", notifier.sent[0][1])
        self.assertTrue(result.ok)
        self.assertEqual(result.status["level"], "hold")

    def test_current_gust_alone_triggers(self):
        result, plug, notifier = check(outlook=make_outlook(26, 10, 9))
        self.assertEqual(len(plug.off_calls), 1)
        self.assertIn("right now", notifier.sent[0][1])

    def test_just_below_threshold_does_nothing(self):
        result, plug, notifier = check(outlook=make_outlook(10, 19.9, 12))
        self.assertEqual(plug.off_calls, [])
        self.assertEqual(notifier.sent, [])
        self.assertFalse(result.state.hold)
        self.assertEqual(result.status["level"], "ok")

    def test_peak_time_is_reported_in_local_time(self):
        # Peak is the 19:00 UTC hour; the outlook is UTC-6, so 1:00 PM local.
        _, _, notifier = check(outlook=make_outlook(5, 10, 30))
        self.assertIn("around 1:00 PM", notifier.sent[0][1])

    def test_all_plugs_are_switched(self):
        # FakePlug shares one on/off flag, so make the state unknown for both plugs.
        plug = FakePlug(state_fails=True)
        check(outlook=make_outlook(30), plug=plug, devices=(PLUG_A, PLUG_B))
        self.assertEqual(plug.off_calls, [PLUG_A, PLUG_B])

    def test_plug_already_off_sends_no_command_but_still_warns(self):
        result, plug, notifier = check(outlook=make_outlook(30), plug=FakePlug(on=False))
        self.assertEqual(plug.off_calls, [])
        self.assertEqual(notifier.titles, ["High wind expected"])
        self.assertTrue(result.state.hold)

    def test_unknown_plug_state_still_sends_off(self):
        _, plug, _ = check(outlook=make_outlook(30), plug=FakePlug(state_fails=True))
        self.assertEqual(plug.off_calls, [PLUG_A])

    def test_still_windy_and_plug_off_is_silent(self):
        held = State(hold=True, hold_since="2026-12-01T17:00:00+00:00")
        result, plug, notifier = check(state=held, outlook=make_outlook(30), plug=FakePlug(on=False))
        self.assertEqual(plug.off_calls, [])
        self.assertEqual(notifier.sent, [])
        self.assertEqual(result.state.hold_since, "2026-12-01T17:00:00+00:00")

    def test_plug_turned_back_on_during_wind_is_switched_off_again(self):
        held = State(hold=True, hold_since="2026-12-01T17:00:00+00:00")
        _, plug, notifier = check(state=held, outlook=make_outlook(30), plug=FakePlug(on=True))
        self.assertEqual(plug.off_calls, [PLUG_A])
        self.assertEqual(notifier.titles, ["Inflatables turned off again"])


class RecoveryTests(unittest.TestCase):
    HELD = State(hold=True, hold_since="2026-12-01T15:00:00+00:00")

    def test_first_calm_run_starts_the_clock_without_notifying(self):
        result, plug, notifier = check(state=self.HELD, outlook=make_outlook(8, 9, 10))
        self.assertTrue(result.state.hold)
        self.assertEqual(result.state.calm_since, NOW.isoformat())
        self.assertEqual(notifier.sent, [])
        self.assertEqual(plug.off_calls, [])

    def test_all_clear_after_calm_period_and_plug_is_never_switched(self):
        calm = State(hold=True, hold_since="x", calm_since=(NOW - timedelta(minutes=30)).isoformat())
        result, plug, notifier = check(state=calm, outlook=make_outlook(8, 9, 10))
        self.assertFalse(result.state.hold)
        self.assertIsNone(result.state.calm_since)
        self.assertEqual(notifier.titles, ["Wind has passed"])
        self.assertIn("Govee app", notifier.sent[0][1])
        self.assertEqual(plug.off_calls, [])
        self.assertEqual(result.status["level"], "ok")

    def test_calm_period_not_yet_over_keeps_holding(self):
        calm = State(hold=True, calm_since=(NOW - timedelta(minutes=29)).isoformat())
        result, _, notifier = check(state=calm, outlook=make_outlook(8))
        self.assertTrue(result.state.hold)
        self.assertEqual(notifier.sent, [])

    def test_between_resume_level_and_limit_resets_the_clock(self):
        calm = State(hold=True, calm_since=(NOW - timedelta(minutes=29)).isoformat())
        result, _, notifier = check(state=calm, outlook=make_outlook(8, 18))
        self.assertTrue(result.state.hold)
        self.assertIsNone(result.state.calm_since)
        self.assertEqual(notifier.sent, [])

    def test_wind_returning_resets_the_clock_and_enforces_off(self):
        calm = State(hold=True, calm_since=(NOW - timedelta(minutes=20)).isoformat())
        result, plug, _ = check(state=calm, outlook=make_outlook(8, 25), plug=FakePlug(on=False))
        self.assertTrue(result.state.hold)
        self.assertIsNone(result.state.calm_since)

    def test_zero_calm_minutes_gives_all_clear_on_first_calm_run(self):
        result, _, notifier = check(state=self.HELD, outlook=make_outlook(5), calm_minutes=0)
        self.assertFalse(result.state.hold)
        self.assertEqual(notifier.titles, ["Wind has passed"])

    def test_undelivered_all_clear_keeps_hold_so_it_is_retried(self):
        calm = State(hold=True, calm_since=(NOW - timedelta(hours=1)).isoformat())
        result, _, _ = check(state=calm, outlook=make_outlook(5), notifier=FakeNotifier(fails=True))
        self.assertTrue(result.state.hold)
        self.assertFalse(result.ok)

    def test_damaged_calm_timestamp_restarts_the_clock(self):
        result, _, notifier = check(state=State(hold=True, calm_since="garbage"), outlook=make_outlook(5))
        self.assertTrue(result.state.hold)
        self.assertEqual(result.state.calm_since, NOW.isoformat())


class FailureTests(unittest.TestCase):
    def test_forecast_failure_alerts_once_and_never_touches_the_plug(self):
        result, plug, notifier = check(error=WeatherError("api down"))
        self.assertFalse(result.ok)
        self.assertEqual(plug.off_calls, [])
        self.assertEqual(notifier.titles, ["Wind monitor cannot get the forecast"])
        self.assertTrue(notifier.sent[0][2])  # urgent
        self.assertEqual(result.status["level"], "error")

        again, _, notifier2 = check(state=result.state, error=WeatherError("api down"))
        self.assertEqual(notifier2.sent, [])
        self.assertFalse(again.ok)

    def test_forecast_failure_keeps_an_existing_hold(self):
        held = State(hold=True, hold_since="x")
        result, _, _ = check(state=held, error=WeatherError("api down"))
        self.assertTrue(result.state.hold)

    def test_forecast_recovery_is_announced_and_alert_rearmed(self):
        result, _, notifier = check(state=State(alerted=["weather"]), outlook=make_outlook(5))
        self.assertEqual(notifier.titles, ["Wind monitor is working again"])
        self.assertEqual(result.state.alerted, [])

    def test_plug_failure_sends_urgent_alert_once_and_retries_next_run(self):
        result, plug, notifier = check(outlook=make_outlook(30), plug=FakePlug(off_fails=True))
        self.assertFalse(result.ok)
        self.assertTrue(result.state.hold)
        self.assertEqual(notifier.titles, ["Could not turn inflatables off"])
        self.assertTrue(notifier.sent[0][2])
        self.assertEqual(result.status["level"], "error")

        again, plug2, notifier2 = check(state=result.state, outlook=make_outlook(30), plug=FakePlug(off_fails=True))
        self.assertEqual(notifier2.sent, [])  # no repeat alert
        self.assertFalse(again.ok)

        fixed, plug3, notifier3 = check(state=again.state, outlook=make_outlook(30), plug=FakePlug())
        self.assertEqual(plug3.off_calls, [PLUG_A])  # retried and succeeded
        self.assertEqual(notifier3.titles, ["Inflatables turned off again"])
        self.assertNotIn("plug", fixed.state.alerted)
        self.assertTrue(fixed.ok)

    def test_notification_failure_still_turns_plug_off(self):
        result, plug, _ = check(outlook=make_outlook(30), notifier=FakeNotifier(fails=True))
        self.assertEqual(plug.off_calls, [PLUG_A])
        self.assertTrue(result.state.hold)
        self.assertFalse(result.ok)

    def test_input_state_is_not_mutated(self):
        original = State()
        check(state=original, outlook=make_outlook(30))
        self.assertFalse(original.hold)


class DryRunAndStatusTests(unittest.TestCase):
    def test_dry_run_switches_nothing_and_notifies_nobody(self):
        plug, notifier = FakePlug(), FakeNotifier()
        result = run_check(
            make_config(), State(), NOW,
            get_outlook=lambda: make_outlook(40), plug=plug, notifier=notifier, dry_run=True,
        )
        self.assertEqual(plug.off_calls, [])
        self.assertEqual(notifier.sent, [])
        self.assertTrue(result.status["dry_run"])
        self.assertEqual(result.state.last_action, "Would switch inflatables off for wind (dry run)")

    def test_status_contains_no_private_values(self):
        cfg = make_config()
        result, _, _ = check(outlook=make_outlook(30))
        text = json.dumps(result.status)
        for private in (cfg.govee_api_key, cfg.ntfy_topic, PLUG_A.device_id, "41.5", "-87.5"):
            self.assertNotIn(private, text)

    def test_status_reports_wind_numbers_and_hours(self):
        result, _, _ = check(outlook=make_outlook(10, 12, 15))
        status = result.status
        self.assertEqual(status["current_gust_mph"], 10)
        self.assertEqual(status["peak_gust_mph"], 15)
        self.assertEqual(len(status["hours"]), 2)
        self.assertEqual(status["threshold_mph"], 20)


if __name__ == "__main__":
    unittest.main()
