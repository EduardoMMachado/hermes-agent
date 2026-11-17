#!/usr/bin/env python3
"""This calendar month's Vertex AI model cost of one Google Cloud project, from Google's own token counts. READ ONLY.

    python3 vertex_spend.py --project my-project --currency USD --price gemini-3.8-flash=3e-07 \\
        (--keychain-service S --keychain-account A | --token-from-gcloud) [--json] [--month 2026-11]
    python3 vertex_spend.py --config ~/.hermes/tui-sidebar.json [--json]   # reads its `vertexSpend` section

The TUI side bar runs this to show a metered month cost (see contrib/tui-sidebar/README.md). Standard library only.

Method:
  * Cloud Monitoring `aiplatform.googleapis.com/publisher/online_serving/consumed_token_throughput`, summed over the
    month (this machine's time zone) per model. Google weights every token by its burndown rate (for Gemini Flash
    models 1 input = 1, 1 cached input = 0.1, 1 output = 5, the same ratios as their prices), so
    cost = weighted tokens x the model's input price per token. `token_count` (input/output) is read too, for display
    and as a cross-check.
  * Price: the input price per token of each model, in the configured currency, as given by the caller (normally the
    Cloud Billing catalog's list price of the model's text input SKU). A model without a price is listed in
    `unpriced_models` and left out of the total; it is never estimated.
  * Credential: a service-account JSON key (a role with `monitoring.timeSeries.list` only, e.g.
    roles/monitoring.viewer), base64 in a macOS login Keychain generic password. It never reaches argv, a file or the
    output; openssl signs the JWT from a pipe. `--token-from-gcloud` uses the caller's own gcloud session instead.
Not included: taxes, credits, other services of the project. The provider's invoice is the source of truth.

A failed reading prints {"error": <reason>, "estimate": true} and exits 1; the reason is what the side bar shows.
"""
from __future__ import annotations

import argparse
import base64
import datetime as dt
import json
import math
import os
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Callable, Optional

SCOPE = "https://www.googleapis.com/auth/monitoring.read"
METRIC = "aiplatform.googleapis.com/publisher/online_serving/"
DEFAULT_PRICE_SOURCE = "configured input price per token"


class Unavailable(RuntimeError):
    """The reading failed; `reason` is what the side bar shows (never a fabricated amount)."""

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


def month_window(month: Optional[str], now: Optional[dt.datetime] = None) -> tuple:
    """(label, since, until) of a calendar month in this machine's time zone; until = now for the current month."""
    now = now or dt.datetime.now().astimezone()
    if month:
        first = dt.datetime.strptime(month, "%Y-%m").replace(tzinfo=now.tzinfo)
    else:
        first = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    following = (first.replace(day=28) + dt.timedelta(days=4)).replace(day=1)
    return first.strftime("%Y-%m"), first.timestamp(), min(following.timestamp(), now.timestamp())


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def sign_rs256(private_key: str, signing_input: str, run: Callable = subprocess.run) -> bytes:
    """openssl signs with the key on an inherited pipe: the key is never in argv or a file."""
    read_end, write_end = os.pipe()
    try:
        os.write(write_end, private_key.encode())
        os.close(write_end)
        write_end = -1
        r = run(["openssl", "dgst", "-sha256", "-sign", f"/dev/fd/{read_end}"], input=signing_input.encode(),
                capture_output=True, pass_fds=(read_end,), timeout=30)
    finally:
        os.close(read_end)
        if write_end != -1:
            os.close(write_end)
    if r.returncode != 0 or not r.stdout:
        raise Unavailable("chave do Keychain inválida")
    return r.stdout


def read_key(service: str, account: str, run: Callable = subprocess.run) -> dict:
    """The service-account key, base64 JSON in the login Keychain item (service, account)."""
    r = run(["security", "find-generic-password", "-s", service, "-a", account, "-w"],
            capture_output=True, text=True, timeout=30, stdin=subprocess.DEVNULL)
    if r.returncode != 0:
        raise Unavailable("sem credencial no Keychain")
    try:
        key = json.loads(base64.b64decode(r.stdout.strip(), validate=True))
        if key["type"] != "service_account" or not key["private_key"] or not key["client_email"]:
            raise ValueError
    except (ValueError, KeyError, TypeError):
        raise Unavailable("chave do Keychain inválida") from None
    return key


def post_form(url: str, fields: dict, timeout: float = 20) -> dict:
    req = urllib.request.Request(url, data=urllib.parse.urlencode(fields).encode(), method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def get_json(url: str, token: str, timeout: float = 20) -> dict:
    req = urllib.request.Request(url, headers={"Authorization": "Bearer " + token})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def sa_token(key: dict, now: float, sign: Callable = sign_rs256, post: Callable = post_form) -> str:
    header = _b64url(json.dumps({"alg": "RS256", "typ": "JWT"}, separators=(",", ":")).encode())
    claims = _b64url(json.dumps({"iss": key["client_email"], "scope": SCOPE, "aud": key["token_uri"],
                                 "iat": int(now), "exp": int(now) + 600}, separators=(",", ":")).encode())
    unsigned = f"{header}.{claims}"
    assertion = f"{unsigned}.{_b64url(sign(key['private_key'], unsigned))}"
    try:
        return post(key["token_uri"], {"grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
                                       "assertion": assertion})["access_token"]
    except (urllib.error.URLError, OSError, KeyError, ValueError):
        raise Unavailable("Google recusou a credencial") from None


def gcloud_token(run: Callable = subprocess.run) -> str:
    """Developer path (--token-from-gcloud): the caller's own gcloud session."""
    r = run(["gcloud", "auth", "print-access-token"], capture_output=True, text=True, timeout=60)
    if r.returncode != 0:
        raise Unavailable("sessão do gcloud expirada")
    return r.stdout.strip()


_UTC = dt.timezone(dt.timedelta(0))  # not datetime.UTC: this script must also run on Python < 3.11


def _iso(t: float) -> str:
    return dt.datetime.fromtimestamp(t, _UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def sums(project: str, metric: str, by: str, since: float, until: float, token: str,
         get: Callable = get_json) -> dict:
    """{label value: total} of a DELTA metric over [since, until] (one bucket, summed across series)."""
    params = {"filter": f'metric.type="{METRIC}{metric}"', "interval.startTime": _iso(since),
              "interval.endTime": _iso(until), "aggregation.alignmentPeriod": f"{max(60, int(until - since))}s",
              "aggregation.perSeriesAligner": "ALIGN_SUM", "aggregation.crossSeriesReducer": "REDUCE_SUM",
              "aggregation.groupByFields": by}
    base = (f"https://monitoring.googleapis.com/v3/projects/{urllib.parse.quote(project, safe='')}/timeSeries?"
            + urllib.parse.urlencode(params))
    out: dict = {}
    url = base
    while True:
        try:
            d = get(url, token)
        except urllib.error.HTTPError as e:
            raise Unavailable("sem permissão no Monitoring" if e.code in (401, 403)
                              else "Google Monitoring indisponível") from None
        except (urllib.error.URLError, OSError, ValueError):
            raise Unavailable("Google Monitoring indisponível") from None
        for s in d.get("timeSeries", []):
            labels = {**s.get("resource", {}).get("labels", {}), **s.get("metric", {}).get("labels", {})}
            k = labels.get(by.rsplit(".", 1)[-1], "")
            out[k] = out.get(k, 0) + sum(int(p["value"].get("int64Value", 0)) for p in s.get("points", []))
        if not d.get("nextPageToken"):
            return out
        url = base + "&pageToken=" + urllib.parse.quote(d["nextPageToken"])


def report(token: str, project: str, prices: dict, currency: str, month: Optional[str] = None,
           now: Optional[dt.datetime] = None, get: Optional[Callable] = None,
           price_source: str = DEFAULT_PRICE_SOURCE) -> dict:
    """The month's cost: weighted tokens of each priced model x its input price per token."""
    now = now or dt.datetime.now().astimezone()
    get = get or get_json
    label, since, until = month_window(month, now)
    weighted = sums(project, "consumed_token_throughput", "resource.label.model_user_id", since, until, token, get)
    by_type = sums(project, "token_count", "metric.label.type", since, until, token, get)
    out = {"month": label, "project": project, "currency": currency, "amount": 0.0,
           "weighted_tokens": sum(weighted.values()),
           "tokens": {"input": by_type.get("input", 0), "output": by_type.get("output", 0)},
           "models": {}, "unpriced_models": [], "source": "google-monitoring", "estimate": True,
           "price_source": price_source, "generated_at": now.isoformat(timespec="seconds")}
    for model, n in sorted(weighted.items()):
        price = prices.get(model)
        if price is None:
            out["unpriced_models"].append(model)
            continue
        out["models"][model] = round(n * price, 2)
        out["amount"] += n * price
    out["amount"] = round(out["amount"], 2)
    return out


def _valid_price(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) and v > 0


def settings(args: argparse.Namespace) -> dict:
    """The effective settings: the config file's `vertexSpend` section, overridden by explicit arguments."""
    section: dict = {}
    if args.config:
        try:
            with open(os.path.expanduser(args.config), encoding="utf-8") as f:
                section = json.load(f).get("vertexSpend") or {}
            if not isinstance(section, dict):
                raise ValueError
        except (OSError, ValueError, AttributeError):
            raise Unavailable("config inválida") from None
    raw_keychain = section.get("keychain")
    keychain: dict = raw_keychain if isinstance(raw_keychain, dict) else {}
    configured = section.get("inputPricePerToken") or {}
    if not isinstance(configured, dict):
        raise Unavailable("config inválida")
    prices = dict(configured)
    for item in args.price:
        model, _, value = item.partition("=")
        try:
            prices[model.strip()] = float(value)
        except ValueError:
            raise Unavailable("config inválida") from None
    s = {"project": args.project or section.get("project"),
         "currency": args.currency or section.get("currency"),
         "prices": prices,
         "service": args.keychain_service or keychain.get("service"),
         "account": args.keychain_account or keychain.get("account"),
         "gcloud": args.token_from_gcloud or section.get("tokenFromGcloud") is True,
         "price_source": args.price_source or section.get("priceSource") or DEFAULT_PRICE_SOURCE}
    if not (isinstance(s["project"], str) and s["project"] and isinstance(s["currency"], str)
            and len(s["currency"]) == 3 and prices and all(_valid_price(v) for v in prices.values())):
        raise Unavailable("config inválida")
    if not s["gcloud"] and not (s["service"] and s["account"]):
        raise Unavailable("sem credencial configurada")
    return s


def parse_args(argv=None) -> argparse.Namespace:
    ap = argparse.ArgumentParser(description=(__doc__ or "").split("\n\n")[0])
    ap.add_argument("--config", help="JSON file whose `vertexSpend` section supplies the settings below")
    ap.add_argument("--project", help="Google Cloud project id")
    ap.add_argument("--currency", help="ISO 4217 code of the prices (BRL, USD, ...)")
    ap.add_argument("--price", action="append", default=[], metavar="MODEL=PRICE",
                    help="input price per token of a model, in --currency (repeatable)")
    ap.add_argument("--price-source", help="free text recorded in the output (where the prices came from)")
    ap.add_argument("--keychain-service", help="login Keychain generic-password service holding the key")
    ap.add_argument("--keychain-account", help="login Keychain generic-password account holding the key")
    ap.add_argument("--month", default=None, help="YYYY-MM (default: the current month)")
    ap.add_argument("--json", action="store_true", help="one JSON document (what the TUI side bar reads)")
    ap.add_argument("--token-from-gcloud", action="store_true", help="use the caller's gcloud session")
    return ap.parse_args(argv)


def main(argv=None) -> int:
    args = parse_args(argv)
    try:
        s = settings(args)
        token = gcloud_token() if s["gcloud"] else sa_token(read_key(s["service"], s["account"]), time.time())
        out = report(token, s["project"], s["prices"], s["currency"], args.month, price_source=s["price_source"])
    except Unavailable as e:
        out = {"error": e.reason, "estimate": True}
    if args.json:
        json.dump(out, sys.stdout, ensure_ascii=False)
        sys.stdout.write("\n")
    elif "error" in out:
        print(f"Vertex: unavailable ({out['error']})")
    else:
        print(f"Vertex {out['project']} {out['month']}: {out['amount']:.2f} {out['currency']} at list price "
              f"({out['tokens']['input']:,} input / {out['tokens']['output']:,} output tokens)")
    return 0 if "error" not in out else 1


if __name__ == "__main__":
    sys.exit(main())
