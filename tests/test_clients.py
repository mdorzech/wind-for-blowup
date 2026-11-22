"""Tests for config, forecast parsing, the HTTP helper, Govee, ntfy, state and the CLI."""

import io
import json
import tempfile
import unittest
import urllib.error
from contextlib import redirect_stderr, redirect_stdout
from datetime import timedelta
from pathlib import Path
from unittest import mock

from windguard import cli
from windguard.config import ConfigError, Device, load_config, load_dotenv, parse_devices
from windguard.govee import GoveeClient, GoveeError
from windguard.http import HttpError, request_json
from windguard.notify import Notifier, NotifyError
from windguard.state import State, load_state, save_state
from windguard.weather import WeatherError, fetch_outlook, parse_outlook

from .helpers import NOW, PLUG_A

ENV = {
    "LATITUDE": "41.5",
    "LONGITUDE": "-87.5",
    "GOVEE_API_KEY": "key",
    "GOVEE_DEVICES": "H5080|AA:BB:CC:DD:EE:FF:00:11",
    "NTFY_TOPIC": "my-topic_1",
}


class TempDirTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = Path(tmp.name)

    def write(self, name: str, text: str) -> Path:
        path = self.dir / name
        path.write_text(text, encoding="utf-8")
        return path


class ConfigTests(TempDirTest):
    def load(self, toml="", **env_changes):
        env = {**ENV, **env_changes}
        return load_config(self.write("config.toml", toml), env)

    def test_defaults(self):
        cfg = self.load()
        self.assertEqual(cfg.lead_minutes, 30)
        self.assertEqual(cfg.gust_threshold_mph, 20)
        self.assertEqual(cfg.resume_below_mph, 17)
        self.assertEqual(cfg.lookahead_hours, 3)
        self.assertEqual(cfg.calm_minutes, 30)
        self.assertEqual(cfg.devices, (PLUG_A,))
        self.assertEqual(cfg.ntfy_server, "https://ntfy.sh")

    def test_overrides(self):
        cfg = self.load("[wind]\ngust_threshold_mph = 25\nresume_below_mph = 20\nlookahead_hours = 6\n")
        self.assertEqual((cfg.gust_threshold_mph, cfg.resume_below_mph, cfg.lookahead_hours), (25, 20, 6))

    def test_bad_values_are_rejected_with_a_clear_message(self):
        cases = [
            ("[wind]\ngust_threshold_mph = 0\n", {}, "gust_threshold_mph"),
            ("[wind]\ngust_threshold_mph = 'fast'\n", {}, "gust_threshold_mph"),
            ("[wind]\ngust_threshold_mph = true\n", {}, "gust_threshold_mph"),
            ("[wind]\nresume_below_mph = 30\n", {}, "resume_below_mph"),
            ("[wind]\nlookahead_hours = 0\n", {}, "lookahead_hours"),
            ("[wind]\nlookahead_hours = 2.5\n", {}, "lookahead_hours"),
            ("[wind]\nlead_minutes = -5\n", {}, "lead_minutes"),
            ("[wind]\nlead_minutes = 15.5\n", {}, "lead_minutes"),
            ("[wind]\nlookahead_hours = 1\nlead_minutes = 90\n", {}, "lead_minutes"),
            ("[wind]\ncalm_minutes = -1\n", {}, "calm_minutes"),
            ("[notify]\nntfy_server = 'http://ntfy.sh'\n", {}, "ntfy_server"),
            ("[notify]\nstatus_page_url = 'javascript:alert(1)'\n", {}, "status_page_url"),
            ("wind = 3\n", {}, "tables"),
            ("not toml [", {}, "TOML"),
            ("", {"LATITUDE": ""}, "LATITUDE"),
            ("", {"LATITUDE": "north"}, "LATITUDE"),
            ("", {"LATITUDE": "91"}, "LATITUDE"),
            ("", {"LATITUDE": "nan"}, "LATITUDE"),
            ("", {"LONGITUDE": "-181"}, "LONGITUDE"),
            ("", {"GOVEE_API_KEY": " "}, "GOVEE_API_KEY"),
            ("", {"GOVEE_DEVICES": ""}, "GOVEE_DEVICES"),
            ("", {"GOVEE_DEVICES": "H5080"}, "GOVEE_DEVICES"),
            ("", {"NTFY_TOPIC": ""}, "NTFY_TOPIC"),
            ("", {"NTFY_TOPIC": "bad topic/../x"}, "NTFY_TOPIC"),
        ]
        for toml, env, expected in cases:
            with self.subTest(toml=toml, env=env):
                with self.assertRaises(ConfigError) as caught:
                    self.load(toml, **env)
                self.assertIn(expected, str(caught.exception))

    def test_missing_config_file(self):
        with self.assertRaises(ConfigError):
            load_config(self.dir / "nope.toml", ENV)

    def test_parse_several_devices(self):
        devices = parse_devices(" H5080|AA:BB , H5081|CC:DD ,")
        self.assertEqual(devices, (Device("H5080", "AA:BB"), Device("H5081", "CC:DD")))

    def test_dotenv_does_not_override_real_environment(self):
        path = self.write(".env", "# comment\nA=from-file\nB='quoted'\nbroken line\n")
        env = {"A": "from-env"}
        load_dotenv(path, env)
        self.assertEqual(env, {"A": "from-env", "B": "quoted"})

    def test_repo_config_file_is_valid(self):
        repo_config = Path(__file__).resolve().parent.parent / "config.toml"
        cfg = load_config(repo_config, ENV)
        self.assertEqual(cfg.gust_threshold_mph, 20)


def forecast_payload(gusts_by_step: dict, current=(6.0, 9.0), offset=-21600):
    """Open-Meteo-style payload; keys are 15-minute steps counted from 18:00 UTC."""
    base = NOW.replace(minute=0)
    steps = sorted(gusts_by_step)
    return {
        "utc_offset_seconds": offset,
        "current": {"wind_speed_10m": current[0], "wind_gusts_10m": current[1]},
        "minutely_15": {
            "time": [int((base + timedelta(minutes=15 * s)).timestamp()) for s in steps],
            "wind_speed_10m": [5.0 for _ in steps],
            "wind_gusts_10m": [gusts_by_step[s] for s in steps],
        },
    }


class WeatherTests(unittest.TestCase):
    def test_only_steps_in_the_window_count(self):
        # NOW is 18:10. A 3 h window keeps the 18:00 step (in progress) through 21:00 (step 12).
        payload = forecast_payload({-2: 50, -1: 50, 0: 11, 1: 12, 11: 13, 12: 14, 13: 50, 14: 50})
        outlook = parse_outlook(payload, NOW, 3)
        self.assertEqual([r.gust_mph for r in outlook.readings], [11, 12, 13, 14])
        self.assertEqual(outlook.peak_gust_mph, 14)
        self.assertEqual(outlook.peak_time, NOW.replace(minute=0) + timedelta(hours=3))
        self.assertEqual(outlook.utc_offset_seconds, -21600)

    def test_first_time_at_or_above(self):
        outlook = parse_outlook(forecast_payload({0: 10, 1: 15, 2: 20, 3: 25, 4: 12}), NOW, 3)
        self.assertEqual(outlook.first_time_at_or_above(20), NOW.replace(minute=30))
        self.assertIsNone(outlook.first_time_at_or_above(30))

    def test_current_gust_can_be_the_peak(self):
        outlook = parse_outlook(forecast_payload({0: 10, 1: 12}, current=(15, 28)), NOW, 3)
        self.assertEqual(outlook.peak_gust_mph, 28)
        self.assertIsNone(outlook.peak_time)

    def test_bad_payloads_raise_weather_error(self):
        missing_gust = forecast_payload({0: 10, 1: None})
        negative = forecast_payload({0: -5})
        ragged = forecast_payload({0: 10, 1: 12})
        ragged["minutely_15"]["wind_gusts_10m"].pop()
        no_current = forecast_payload({0: 10})
        del no_current["current"]
        outside = forecast_payload({-5: 10, 20: 10})
        for name, payload in [
            ("missing", missing_gust), ("negative", negative), ("ragged", ragged),
            ("no current", no_current), ("outside window", outside),
            ("not a dict", []), ("empty", {}), ("error body", {"error": True, "reason": "x"}),
        ]:
            with self.subTest(name):
                with self.assertRaises(WeatherError):
                    parse_outlook(payload, NOW, 3)

    def test_fetch_builds_request_and_wraps_http_errors(self):
        calls = []

        def fetch(method, url, **kwargs):
            calls.append((method, url))
            return forecast_payload({0: 10, 1: 22})

        outlook = fetch_outlook(41.5, -87.5, 3, NOW, fetch=fetch)
        self.assertEqual(outlook.peak_gust_mph, 22)
        method, url = calls[0]
        self.assertEqual(method, "GET")
        self.assertTrue(url.startswith("https://api.open-meteo.com/v1/forecast?"))
        for part in ("latitude=41.5000", "longitude=-87.5000", "wind_speed_unit=mph", "timeformat=unixtime",
                     "minutely_15=wind_speed_10m%2Cwind_gusts_10m", "forecast_minutely_15=16"):
            self.assertIn(part, url)

        def broken(method, url, **kwargs):
            raise HttpError("down")

        with self.assertRaises(WeatherError):
            fetch_outlook(41.5, -87.5, 3, NOW, fetch=broken)


class FakeResponse:
    def __init__(self, body: bytes):
        self._body = body

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def http_error(code, headers=None):
    return urllib.error.HTTPError("https://x.example/", code, "err", headers, None)


class HttpTests(unittest.TestCase):
    def call(self, outcomes, **kwargs):
        outcomes = list(outcomes)
        requests, sleeps = [], []

        def opener(request, timeout):
            requests.append(request)
            outcome = outcomes.pop(0)
            if isinstance(outcome, Exception):
                raise outcome
            return FakeResponse(outcome)

        result = None
        error = None
        try:
            result = request_json("POST", "https://x.example/path", opener=opener, sleep=sleeps.append, **kwargs)
        except HttpError as exc:
            error = exc
        return result, error, requests, sleeps

    def test_success_sends_json_body_and_headers(self):
        result, error, requests, _ = self.call([b'{"ok": true}'], body={"a": 1}, headers={"X-Key": "k"})
        self.assertEqual(result, {"ok": True})
        self.assertIsNone(error)
        self.assertEqual(json.loads(requests[0].data), {"a": 1})
        self.assertEqual(requests[0].get_header("X-key"), "k")
        self.assertEqual(requests[0].get_header("Content-type"), "application/json")

    def test_retries_then_succeeds(self):
        result, error, requests, sleeps = self.call([http_error(503), urllib.error.URLError("dns"), b"{}"])
        self.assertEqual(result, {})
        self.assertEqual(len(requests), 3)
        self.assertEqual(sleeps, [2.0, 4.0])

    def test_gives_up_after_four_attempts(self):
        _, error, requests, _ = self.call([http_error(500), TimeoutError(), http_error(502), http_error(503)])
        self.assertIsNotNone(error)
        self.assertEqual(len(requests), 4)

    def test_rate_limit_backs_off_longer(self):
        import email.message
        with_header = email.message.Message()
        with_header["Retry-After"] = "7"
        result, _, _, sleeps = self.call([http_error(429), http_error(429, with_header), http_error(429), b"{}"])
        self.assertEqual(result, {})
        self.assertEqual(sleeps, [15.0, 7.0, 45.0])

    def test_client_errors_are_not_retried(self):
        _, error, requests, _ = self.call([http_error(401)])
        self.assertIn("401", str(error))
        self.assertEqual(len(requests), 1)

    def test_non_json_response_is_an_error(self):
        _, error, _, _ = self.call([b"<html>oops</html>"])
        self.assertIn("not JSON", str(error))

    def test_plain_http_is_refused(self):
        with self.assertRaises(HttpError):
            request_json("GET", "http://x.example/")

    def test_errors_never_contain_the_url_path_or_query(self):
        requests = []

        def opener(request, timeout):
            requests.append(request)
            raise http_error(403)

        with self.assertRaises(HttpError) as caught:
            request_json("GET", "https://x.example/secret-topic?latitude=41.5", opener=opener)
        self.assertNotIn("secret-topic", str(caught.exception))
        self.assertNotIn("41.5", str(caught.exception))


class GoveeTests(unittest.TestCase):
    def client(self, reply):
        self.calls = []

        def fetch(method, url, **kwargs):
            self.calls.append((method, url, kwargs))
            if isinstance(reply, Exception):
                raise reply
            return reply

        return GoveeClient("secret-key", fetch=fetch)

    def test_turn_off_sends_power_switch_zero(self):
        self.client({"code": 200, "message": "success"}).turn_off(PLUG_A)
        method, url, kwargs = self.calls[0]
        self.assertEqual((method, url), ("POST", "https://openapi.api.govee.com/router/api/v1/device/control"))
        self.assertEqual(kwargs["headers"], {"Govee-API-Key": "secret-key"})
        payload = kwargs["body"]["payload"]
        self.assertEqual(payload["sku"], "H5080")
        self.assertEqual(payload["device"], PLUG_A.device_id)
        self.assertEqual(
            payload["capability"],
            {"type": "devices.capabilities.on_off", "instance": "powerSwitch", "value": 0},
        )
        self.assertTrue(kwargs["body"]["requestId"])

    def test_client_has_no_way_to_turn_a_plug_on(self):
        self.assertFalse(hasattr(GoveeClient, "turn_on"))

    def test_is_on_reads_power_state(self):
        def reply(value):
            return {"code": 200, "payload": {"capabilities": [
                {"type": "devices.capabilities.online", "instance": "online", "state": {"value": True}},
                {"type": "devices.capabilities.on_off", "instance": "powerSwitch", "state": {"value": value}},
            ]}}

        self.assertIs(self.client(reply(1)).is_on(PLUG_A), True)
        self.assertIs(self.client(reply(0)).is_on(PLUG_A), False)
        self.assertIsNone(self.client(reply("")).is_on(PLUG_A))
        self.assertIsNone(self.client({"code": 200, "payload": {}}).is_on(PLUG_A))

    def test_list_devices(self):
        reply = {"code": 200, "data": [
            {"sku": "H5080", "device": "AA:BB", "deviceName": "Santa",
             "capabilities": [{"type": "devices.capabilities.on_off", "instance": "powerSwitch"}]},
            {"sku": "H5179", "device": "CC:DD", "deviceName": "Thermometer", "capabilities": []},
        ]}
        devices = self.client(reply).list_devices()
        self.assertEqual(devices[0], {"name": "Santa", "sku": "H5080", "device_id": "AA:BB", "switchable": True})
        self.assertFalse(devices[1]["switchable"])

    def test_failures_become_govee_errors(self):
        for reply in ({"code": 400, "message": "bad"}, [], HttpError("down")):
            with self.subTest(reply=reply):
                with self.assertRaises(GoveeError):
                    self.client(reply).turn_off(PLUG_A)


class NotifierTests(unittest.TestCase):
    def test_send_posts_json_to_server_root(self):
        calls = []
        notifier = Notifier("https://ntfy.example", "topic1", "https://me.example/status",
                            fetch=lambda m, u, **k: calls.append((m, u, k)))
        notifier.send("Title", "Body", urgent=True, tag="warning")
        method, url, kwargs = calls[0]
        self.assertEqual((method, url), ("POST", "https://ntfy.example/"))
        self.assertEqual(kwargs["body"], {
            "topic": "topic1", "title": "Title", "message": "Body",
            "priority": 5, "tags": ["warning"], "click": "https://me.example/status",
        })

    def test_no_click_url_and_normal_priority(self):
        calls = []
        Notifier("https://ntfy.example", "t", fetch=lambda m, u, **k: calls.append(k)).send("T", "B")
        self.assertNotIn("click", calls[0]["body"])
        self.assertEqual(calls[0]["body"]["priority"], 3)

    def test_failure_becomes_notify_error(self):
        def fetch(method, url, **kwargs):
            raise HttpError("down")

        with self.assertRaises(NotifyError):
            Notifier("https://ntfy.example", "t", fetch=fetch).send("T", "B")


class StateTests(TempDirTest):
    def test_round_trip(self):
        path = self.dir / "sub" / "state.json"
        state = State(hold=True, hold_since="a", calm_since="b", alerted=["plug"])
        state.record("Switched off", NOW)
        save_state(path, state)
        self.assertEqual(load_state(path), state)

    def test_missing_or_damaged_file_gives_clean_state(self):
        self.assertEqual(load_state(self.dir / "nope.json"), State())
        for text in ("", "not json", "[1, 2]", '"text"', "null"):
            with self.subTest(text=text):
                self.assertEqual(load_state(self.write("state.json", text)), State())

    def test_unknown_keys_and_wrong_types_are_tolerated(self):
        path = self.write("state.json", json.dumps(
            {"hold": "yes", "alerted": "plug", "calm_since": 5, "extra": 1, "last_action": "x"}))
        state = load_state(path)
        self.assertFalse(state.hold)
        self.assertEqual(state.alerted, [])
        self.assertIsNone(state.calm_since)
        self.assertEqual(state.last_action, "x")


class CliTests(TempDirTest):
    def run_cli(self, *argv, env=None):
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.dict("os.environ", env if env is not None else ENV, clear=True), \
                mock.patch.object(cli, "load_dotenv"), redirect_stdout(out), redirect_stderr(err):
            code = cli.main(list(argv))
        return code, out.getvalue(), err.getvalue()

    def check_args(self, *extra):
        return ("check", "--config", str(self.write("config.toml", "")),
                "--state", str(self.dir / "public" / "state.json"),
                "--status", str(self.dir / "public" / "status.json"),
                "--history", str(self.dir / "public" / "history.json"), *extra)

    def test_check_end_to_end_with_faked_network(self):
        sent = []

        def fake_request(method, url, **kwargs):
            sent.append((method, url, kwargs.get("body")))
            if "open-meteo" in url:
                return forecast_payload({0: 10, 1: 31})
            if url.endswith("/device/state"):
                return {"code": 200, "payload": {"capabilities": [
                    {"type": "devices.capabilities.on_off", "state": {"value": 1}}]}}
            return {"code": 200}

        with mock.patch("windguard.cli.datetime") as fake_datetime:
            fake_datetime.now.return_value = NOW
            # Route every network client the CLI builds through the fake.
            with mock.patch.object(cli, "fetch_outlook",
                                   lambda lat, lon, hours, now: fetch_outlook_with(fake_request, lat, lon, hours, now)), \
                    mock.patch.object(cli, "GoveeClient", lambda key: GoveeClient(key, fetch=fake_request)), \
                    mock.patch.object(cli, "Notifier", lambda s, t, c: Notifier(s, t, c, fetch=fake_request)):
                code, out, _ = self.run_cli(*self.check_args())

        self.assertEqual(code, 0)
        self.assertIn("Inflatables held off for wind", out)
        urls = [url for _, url, _ in sent]
        self.assertTrue(any(url.endswith("/device/control") for url in urls))
        self.assertIn("https://ntfy.sh/", urls)
        state = json.loads((self.dir / "public" / "state.json").read_text())
        status = json.loads((self.dir / "public" / "status.json").read_text())
        self.assertTrue(state["hold"])
        self.assertEqual(status["peak_gust_mph"], 31)
        history = json.loads((self.dir / "public" / "history.json").read_text())
        self.assertEqual(len(history["checks"]), 1)
        self.assertEqual(history["events"][0]["text"], "Switched inflatables off for wind")

    def test_config_problem_exits_2_with_message_and_no_traceback(self):
        code, _, err = self.run_cli(*self.check_args(), env={})
        self.assertEqual(code, 2)
        self.assertIn("Configuration problem", err)
        self.assertNotIn("Traceback", err)

    def test_status_before_any_check(self):
        code, out, _ = self.run_cli("status", "--status", str(self.dir / "none.json"))
        self.assertEqual(code, 1)
        self.assertIn("No check has run yet", out)

    def test_status_with_damaged_file(self):
        code, out, _ = self.run_cli("status", "--status", str(self.write("status.json", "{}")))
        self.assertEqual(code, 1)
        self.assertIn("damaged", out)

    def test_devices_prints_copyable_values(self):
        fake = mock.Mock()
        fake.list_devices.return_value = [
            {"name": "Santa", "sku": "H5080", "device_id": "AA:BB", "switchable": True}]
        with mock.patch.object(cli, "GoveeClient", return_value=fake):
            code, out, _ = self.run_cli("devices")
        self.assertEqual(code, 0)
        self.assertIn("H5080|AA:BB   Santa", out)

    def test_devices_api_failure_exits_1(self):
        fake = mock.Mock()
        fake.list_devices.side_effect = GoveeError("Govee rejected the request (code 401)")
        with mock.patch.object(cli, "GoveeClient", return_value=fake):
            code, _, err = self.run_cli("devices")
        self.assertEqual(code, 1)
        self.assertIn("401", err)


def fetch_outlook_with(fake_request, lat, lon, hours, now):
    return fetch_outlook(lat, lon, hours, now, fetch=fake_request)


if __name__ == "__main__":
    unittest.main()
