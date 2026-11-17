"""The month's Vertex cost from Google's counts, on synthetic Monitoring answers and a synthetic key (never live ones).

    python3 -m unittest discover -s contrib/tui-sidebar/tests -p 'test_*.py' -v
"""
from __future__ import annotations

import base64
import datetime as dt
import email.message
import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
import urllib.error
import urllib.parse
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

_SCRIPT = Path(__file__).resolve().parent.parent / "tui-widgets" / "bin" / "vertex_spend.py"
_spec = importlib.util.spec_from_file_location("vertex_spend", _SCRIPT)
assert _spec and _spec.loader
vs = importlib.util.module_from_spec(_spec)
sys.modules["vertex_spend"] = vs
_spec.loader.exec_module(vs)

TZ = dt.timezone(dt.timedelta(hours=-3))
NOW = dt.datetime(2026, 11, 10, 0, 0, tzinfo=TZ)
PROJECT = "example-project"
# A catalog-style input price per token (BRL list price of a Flash model's global text input SKU).
PRICES = {"gemini-3.8-flash": 9.152e-06}


class FakeMonitoring:
    """Answers the two metrics by name; records each request's URL and query."""

    def __init__(self, weighted, by_type, pages=1):
        self.weighted, self.by_type, self.pages, self.calls = weighted, by_type, pages, []

    def __call__(self, url, token):
        parsed = urllib.parse.urlparse(url)
        q = urllib.parse.parse_qs(parsed.query)
        self.calls.append((q, token, parsed.path))
        metric = q["filter"][0]
        if "consumed_token_throughput" in metric:
            rows = [{"resource": {"labels": {"model_user_id": m}}, "points": [{"value": {"int64Value": str(n)}}]}
                    for m, n in self.weighted.items()]
        else:
            rows = [{"metric": {"labels": {"type": t}}, "points": [{"value": {"int64Value": str(n)}}]}
                    for t, n in self.by_type.items()]
        page = int(q.get("pageToken", ["0"])[0])
        out: dict = {"timeSeries": rows if page == self.pages - 1 else []}
        if page < self.pages - 1:
            out["nextPageToken"] = str(page + 1)
        return out


def run_report(fake, prices=PRICES):
    return vs.report("tok", PROJECT, prices, "BRL", None, NOW, fake)


class TestCost(unittest.TestCase):
    def test_cost_is_googles_weighted_tokens_at_the_configured_input_price(self):
        # a real 9-day reading: 41,986,796 weighted tokens -> 384.26 at 9.152e-06 per token
        fake = FakeMonitoring({"gemini-3.8-flash": 41_986_796}, {"input": 247_188_399, "output": 1_053_502})
        r = run_report(fake)
        self.assertEqual(r["amount"], 384.26)
        self.assertEqual(r["tokens"], {"input": 247_188_399, "output": 1_053_502})
        self.assertEqual((r["month"], r["currency"], r["project"], r["source"], r["estimate"], r["unpriced_models"]),
                         ("2026-11", "BRL", PROJECT, "google-monitoring", True, []))

    def test_a_model_without_a_price_is_listed_not_guessed(self):
        fake = FakeMonitoring({"gemini-3.8-flash": 1_000_000, "gemini-4-argon": 5_000_000}, {})
        r = run_report(fake)
        self.assertEqual((r["amount"], r["unpriced_models"]), (9.15, ["gemini-4-argon"]))

    def test_the_query_covers_the_month_until_now_in_one_summed_bucket_of_the_project(self):
        fake = FakeMonitoring({}, {})
        run_report(fake)
        q, token, path = fake.calls[0]
        self.assertEqual(token, "tok")
        self.assertEqual(path, f"/v3/projects/{PROJECT}/timeSeries")
        self.assertEqual((q["interval.startTime"][0], q["interval.endTime"][0]),
                         ("2026-11-01T03:00:00Z", "2026-11-10T03:00:00Z"))
        self.assertEqual(q["aggregation.alignmentPeriod"][0], f"{9 * 86400}s")
        self.assertEqual((q["aggregation.perSeriesAligner"][0], q["aggregation.crossSeriesReducer"][0]),
                         ("ALIGN_SUM", "REDUCE_SUM"))

    def test_every_page_is_summed(self):
        fake = FakeMonitoring({"gemini-3.8-flash": 1_000_000}, {}, pages=3)
        self.assertEqual(run_report(fake)["amount"], 9.15)
        self.assertEqual(len([c for c in fake.calls if "consumed" in c[0]["filter"][0]]), 3)

    def test_an_unreachable_monitoring_is_unavailable_not_zero(self):
        def down(url, token):
            raise OSError("offline")
        with self.assertRaises(vs.Unavailable):
            run_report(down)

    def test_a_denied_reading_names_the_cause(self):
        def denied(url, token):
            raise urllib.error.HTTPError(url, 403, "Forbidden", email.message.Message(), None)
        with self.assertRaises(vs.Unavailable) as cm:
            run_report(denied)
        self.assertEqual(cm.exception.reason, "sem permissão no Monitoring")

    def test_a_past_month_ends_at_its_last_second(self):
        self.assertEqual(vs.month_window("2026-10", NOW)[2], dt.datetime(2026, 11, 1, tzinfo=TZ).timestamp())


class TestCredential(unittest.TestCase):
    KEY = {"type": "service_account", "private_key": "PEM",
           "client_email": "spend-reader@example-project.iam.gserviceaccount.com",
           "token_uri": "https://oauth2.googleapis.com/token"}

    def keychain(self, rc=0, stdout=None):
        out = base64.b64encode(json.dumps(self.KEY).encode()).decode() if stdout is None else stdout
        return lambda *a, **k: subprocess.CompletedProcess(a[0], rc, stdout=out, stderr="")

    def test_the_key_comes_from_the_configured_keychain_item_and_never_from_argv(self):
        seen = []
        run = self.keychain()

        def spy(cmd, **k):
            seen.append(cmd)
            return run(cmd, **k)
        self.assertEqual(vs.read_key("svc", "acct", spy)["client_email"], self.KEY["client_email"])
        self.assertEqual(seen[0], ["security", "find-generic-password", "-s", "svc", "-a", "acct", "-w"])

    def test_a_missing_or_malformed_keychain_item_is_unavailable(self):
        with self.assertRaises(vs.Unavailable):
            vs.read_key("s", "a", self.keychain(rc=44))
        with self.assertRaises(vs.Unavailable):
            vs.read_key("s", "a", self.keychain(stdout="not base64!"))
        with self.assertRaises(vs.Unavailable):
            vs.read_key("s", "a", self.keychain(stdout=base64.b64encode(b'{"type": "user"}').decode()))

    def test_the_jwt_asks_only_the_monitoring_read_scope_of_the_key_account(self):
        posted = {}

        def post(url, fields):
            posted.update(url=url, **fields)
            return {"access_token": "at"}
        tok = vs.sa_token(self.KEY, 1_800_000_000, sign=lambda k, s: b"sig", post=post)
        self.assertEqual(tok, "at")
        claims = json.loads(base64.urlsafe_b64decode(posted["assertion"].split(".")[1] + "=="))
        self.assertEqual((claims["iss"], claims["scope"], claims["aud"]),
                         (self.KEY["client_email"], "https://www.googleapis.com/auth/monitoring.read",
                          self.KEY["token_uri"]))
        self.assertEqual(claims["exp"] - claims["iat"], 600)
        self.assertEqual(posted["grant_type"], "urn:ietf:params:oauth:grant-type:jwt-bearer")

    def test_a_refused_token_exchange_is_unavailable(self):
        def post(url, fields):
            raise OSError("401")
        with self.assertRaises(vs.Unavailable):
            vs.sa_token(self.KEY, 0, sign=lambda k, s: b"sig", post=post)

    def test_openssl_gets_the_key_on_a_pipe_not_in_argv(self):
        calls = []

        def run(cmd, **k):
            calls.append((cmd, k))
            return subprocess.CompletedProcess(cmd, 0, stdout=b"sig", stderr=b"")
        self.assertEqual(vs.sign_rs256("SECRET-PEM", "a.b", run), b"sig")
        cmd, k = calls[0]
        self.assertNotIn("SECRET-PEM", " ".join(cmd))
        self.assertTrue(cmd[-1].startswith("/dev/fd/") and k["pass_fds"])


ARGS = ["--project", PROJECT, "--currency", "BRL", "--price", "gemini-3.8-flash=9.152e-06",
        "--keychain-service", "svc", "--keychain-account", "acct"]


class TestCli(unittest.TestCase):
    def run_main(self, argv, **patches):
        buf = io.StringIO()
        with mock.patch.multiple(vs, **patches), redirect_stdout(buf):
            code = vs.main(argv)
        return code, json.loads(buf.getvalue())

    def test_failure_prints_an_error_document_and_exits_nonzero(self):
        code, doc = self.run_main(["--json", *ARGS], read_key=mock.Mock(side_effect=vs.Unavailable(
            "sem credencial no Keychain")))
        self.assertEqual((code, doc), (1, {"error": "sem credencial no Keychain", "estimate": True}))

    def test_json_cli_prints_one_document_with_the_configured_item(self):
        fake = FakeMonitoring({"gemini-3.8-flash": 1_000_000}, {"input": 5, "output": 1})
        read_key = mock.Mock(return_value={})
        code, doc = self.run_main(["--json", *ARGS], read_key=read_key, sa_token=mock.Mock(return_value="t"),
                                  get_json=fake)
        self.assertEqual(code, 0)
        self.assertEqual((doc["tokens"], doc["amount"], doc["currency"]), ({"input": 5, "output": 1}, 9.15, "BRL"))
        read_key.assert_called_once_with("svc", "acct")

    def test_settings_come_from_the_config_file_section(self):
        cfg = {"vertexSpend": {"project": PROJECT, "currency": "USD", "inputPricePerToken": {"m": 1e-06},
                               "keychain": {"service": "svc", "account": "acct"}}}
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "tui-sidebar.json")
            with open(path, "w", encoding="utf-8") as f:
                json.dump(cfg, f)
            fake = FakeMonitoring({"m": 2_000_000, "other": 7}, {})
            code, doc = self.run_main(["--json", "--config", path], read_key=mock.Mock(return_value={}),
                                      sa_token=mock.Mock(return_value="t"), get_json=fake)
        self.assertEqual((code, doc["amount"], doc["currency"], doc["unpriced_models"]), (0, 2.0, "USD", ["other"]))

    def test_gcloud_path_needs_no_keychain_item(self):
        fake = FakeMonitoring({}, {})
        argv = ["--json", "--project", PROJECT, "--currency", "USD", "--price", "m=1e-06", "--token-from-gcloud"]
        read_key = mock.Mock()
        code, doc = self.run_main(argv, gcloud_token=mock.Mock(return_value="g"), read_key=read_key, get_json=fake)
        self.assertEqual((code, doc["amount"]), (0, 0.0))
        read_key.assert_not_called()
        self.assertEqual(fake.calls[0][1], "g")

    def test_incomplete_settings_are_an_error_document_not_a_guess(self):
        cases = [
            (["--json", "--currency", "BRL", "--price", "m=1e-06", "--token-from-gcloud"], "config inválida"),
            (["--json", "--project", PROJECT, "--currency", "BRL", "--token-from-gcloud"], "config inválida"),
            (["--json", "--project", PROJECT, "--currency", "BRL", "--price", "m=x", "--token-from-gcloud"],
             "config inválida"),
            (["--json", "--project", PROJECT, "--currency", "BRL", "--price", "m=-1", "--token-from-gcloud"],
             "config inválida"),
            (["--json", "--project", PROJECT, "--currency", "BRL", "--price", "m=1e-06"], "sem credencial configurada"),
            (["--json", "--config", "/nonexistent/tui-sidebar.json"], "config inválida"),
        ]
        for argv, reason in cases:
            with self.subTest(argv=argv):
                code, doc = self.run_main(argv, get_json=mock.Mock(side_effect=AssertionError("no network")))
                self.assertEqual((code, doc), (1, {"error": reason, "estimate": True}))


if __name__ == "__main__":
    unittest.main()
