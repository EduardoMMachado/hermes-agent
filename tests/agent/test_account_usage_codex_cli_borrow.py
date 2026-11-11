"""Read-only Codex usage borrows the Codex CLI's still-valid token for the SAME account on a 401.

The Hermes Codex grant can expire while no Hermes session uses Codex (nothing refreshes it), yet the
Codex CLI on the machine keeps its own login fresh. The read-only usage path may READ that token to
measure the same ChatGPT account, but never refreshes it, never copies it into Hermes' store and
never uses another account's login. Loopback HTTP + real auth stores, no mocks of the fetch path.
"""

from __future__ import annotations

import base64
import json
import threading
import time
from datetime import UTC, datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from agent import account_usage
from agent.account_usage import fetch_account_usage


def _b64(part: dict) -> str:
    return base64.urlsafe_b64encode(json.dumps(part).encode()).decode().rstrip("=")


def _jwt(account_id: str, sub: str, exp_in: float, nonce: str) -> str:
    claims = {"sub": sub, "exp": int(time.time() + exp_in), "jti": nonce,
              "https://api.openai.com/auth": {"chatgpt_account_id": account_id}}
    return f"{_b64({'alg': 'none'})}.{_b64(claims)}.sig"


class _Usage:
    def __init__(self):
        self.requests: list[str] = []
        self.responses: dict[str, int] = {}
        outer = self

        class _H(BaseHTTPRequestHandler):
            def do_GET(self):
                token = (self.headers.get("Authorization") or "").removeprefix("Bearer ").strip()
                outer.requests.append(token)
                status = outer.responses.get(token, 401)
                now = datetime.now(UTC)
                body = json.dumps({"plan_type": "pro", "rate_limit": {
                    "primary_window": {"used_percent": 10.0, "reset_at": int((now + timedelta(hours=1)).timestamp()),
                                       "limit_window_seconds": 18000},
                    "secondary_window": {"used_percent": 95.0, "reset_at": int((now + timedelta(days=2)).timestamp()),
                                         "limit_window_seconds": 604800}}, "credits": {"has_credits": False}}
                                  if status == 200 else {"error": "unauthorized"}).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, format, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), _H)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}/backend-api/codex"

    def __enter__(self):
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        return self

    def __exit__(self, *exc):
        self.server.shutdown()


@pytest.fixture
def homes(monkeypatch, tmp_path):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "hermes"))
    monkeypatch.setenv("CODEX_HOME", str(tmp_path / "codex"))
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    (tmp_path / "hermes").mkdir()
    (tmp_path / "codex").mkdir()

    def write_cli(access: str, account_id: str = "acct-cli") -> bytes:
        raw = json.dumps({"tokens": {"access_token": access, "refresh_token": "cli-refresh-single-use",
                                     "account_id": account_id}}).encode()
        (tmp_path / "codex" / "auth.json").write_bytes(raw)
        return raw

    def forbid_refresh(**kw):
        raise AssertionError("the read-only path must never refresh a credential")

    from hermes_cli import auth as auth_mod
    monkeypatch.setattr(auth_mod, "resolve_codex_runtime_credentials", forbid_refresh)
    return tmp_path, write_cli


def _fetch(server, token):
    return fetch_account_usage("openai-codex", base_url=server.url, api_key=token, read_only=True)


def test_expired_hermes_token_reads_the_same_account_through_the_cli_login(homes):
    tmp, write_cli = homes
    expired = _jwt("acct-1", "user-1", -600, "hermes")
    cli = _jwt("acct-1", "user-1", 3600 * 19, "cli")
    before = write_cli(cli)
    with _Usage() as server:
        server.responses[cli] = 200
        snapshot = _fetch(server, expired)
    assert snapshot is not None
    assert [(w.label, w.used_percent) for w in snapshot.windows] == [("Session", 10.0), ("Weekly", 95.0)]
    assert server.requests == [expired, cli]
    assert (tmp / "codex" / "auth.json").read_bytes() == before, "the CLI file is never written"
    assert not (tmp / "hermes" / "auth.json").exists(), "the borrowed token is never stored in Hermes"


def test_another_accounts_cli_login_is_never_used(homes):
    _tmp, write_cli = homes
    expired = _jwt("acct-1", "user-1", -600, "hermes")
    other = _jwt("acct-2", "user-2", 3600, "cli")
    write_cli(other)
    with _Usage() as server:
        server.responses[other] = 200
        assert _fetch(server, expired) is None
    assert server.requests == [expired]


def test_an_expired_cli_login_is_not_borrowed(homes):
    _tmp, write_cli = homes
    expired = _jwt("acct-1", "user-1", -600, "hermes")
    stale = _jwt("acct-1", "user-1", -60, "cli")
    write_cli(stale)
    with _Usage() as server:
        server.responses[stale] = 200
        assert _fetch(server, expired) is None
    assert server.requests == [expired]


def test_opting_out_of_external_logins_keeps_the_cli_file_unread(homes, monkeypatch):
    _tmp, write_cli = homes
    expired = _jwt("acct-1", "user-1", -600, "hermes")
    cli = _jwt("acct-1", "user-1", 3600, "cli")
    write_cli(cli)
    monkeypatch.setattr("agent.credential_sources.adopt_external_logins_enabled", lambda: False)
    with _Usage() as server:
        server.responses[cli] = 200
        assert _fetch(server, expired) is None
    assert server.requests == [expired]


def test_without_a_cli_login_the_401_stays_unknown(homes):
    expired = _jwt("acct-1", "user-1", -600, "hermes")
    with _Usage() as server:
        assert _fetch(server, expired) is None
    assert server.requests == [expired]
    assert account_usage._codex_cli_token_for_same_account(expired) is None
