"""A canonical cron fire whose pre-agent gate skips the agent still ends the owner's session row.

The owner commits the fire's session row before ``run_job`` runs (``gateway/session_cron.py``
``operation('submit')``). Only ``_finalize_cron_session`` ended it, and that runs only after a
store was opened for an agent turn. A gated fire (monitor ``no_change``, wake gate
``wakeAgent=false``) returned before that, leaving a zero-message row with ``ended_at IS NULL``
that the live session feed lists forever (one per fire; only a gateway restart's
``startup_orphan_reap`` used to close them).
"""
from __future__ import annotations

import sqlite3
import sys

import pytest


@pytest.fixture
def hermes_env(tmp_path, monkeypatch, cron_owner):
    home = tmp_path / ".hermes"
    (home / "scripts").mkdir(parents=True)
    (home / "cron").mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    import importlib
    import hermes_constants
    importlib.reload(hermes_constants)
    import cron.jobs
    importlib.reload(cron.jobs)
    import cron.monitor
    importlib.reload(cron.monitor)
    import cron.scheduler
    importlib.reload(cron.scheduler)
    return home


def _stub_agent(monkeypatch, observed):
    """The LLM path without credentials: counts turns, answers with text."""
    class FakeAgent:
        def __init__(self, **kwargs):
            self.session_id = kwargs["session_id"]
            self.task_id = self.session_id

        def run_conversation(self, prompt, *_a, **_kw):
            observed["agent_runs"] = observed.get("agent_runs", 0) + 1
            return {"final_response": "agent done", "messages": []}

        def get_activity_summary(self):
            return {"seconds_since_activity": 0.0}

    fake_mod = type(sys)("run_agent")
    fake_mod.AIAgent = FakeAgent
    monkeypatch.setitem(sys.modules, "run_agent", fake_mod)
    from hermes_cli import runtime_provider as _rtp
    monkeypatch.setattr(_rtp, "resolve_runtime_provider", lambda **_kw: {
        "provider": "test", "api_key": "k", "base_url": "http://127.0.0.1:1", "api_mode": "chat_completions"})


def _open_cron_rows(home):
    conn = sqlite3.connect(f"file:{home / 'state.db'}?mode=ro", uri=True)
    try:
        return conn.execute(
            "SELECT id, end_reason FROM sessions WHERE source = 'cron' AND ended_at IS NULL").fetchall()
    finally:
        conn.close()


def _cron_rows(home):
    conn = sqlite3.connect(f"file:{home / 'state.db'}?mode=ro", uri=True)
    try:
        return conn.execute(
            "SELECT end_reason FROM sessions WHERE source = 'cron' ORDER BY rowid").fetchall()
    finally:
        conn.close()


def test_monitor_no_change_fire_ends_its_session(hermes_env, monkeypatch):
    from cron.jobs import create_job, get_job
    from cron.scheduler import SILENT_MARKER, run_job

    (hermes_env / "scripts" / "mon.sh").write_text("echo 'state A'\n", encoding="utf-8")
    job = create_job(prompt="Summarize what changed", model="test-model", schedule="every 5m",
                     monitor_script="mon.sh", deliver="local")
    observed: dict = {}
    _stub_agent(monkeypatch, observed)

    assert run_job(job)[0] is True  # first observation: a real (stubbed) turn
    assert observed["agent_runs"] == 1
    assert _open_cron_rows(hermes_env) == []

    success, doc, final, error = run_job(get_job(job["id"]))  # unchanged: agent suppressed
    assert (success, final, error) == (True, SILENT_MARKER, None) and "no_change" in doc
    assert observed["agent_runs"] == 1
    assert _open_cron_rows(hermes_env) == []  # the gated fire's row is ended, not left live
    gated_reason = _cron_rows(hermes_env)[-1][0]
    assert gated_reason == "cron_complete"  # a successful silent fire, not an incomplete one


def test_wake_gate_skip_ends_its_session(hermes_env, monkeypatch):
    from cron.jobs import create_job
    from cron.scheduler import SILENT_MARKER, run_job

    (hermes_env / "scripts" / "gate.sh").write_text("echo '{\"wakeAgent\": false}'\n", encoding="utf-8")
    job = create_job(prompt="Act if woken", model="test-model", schedule="every 5m",
                     script="gate.sh", deliver="local")
    observed: dict = {}
    _stub_agent(monkeypatch, observed)

    success, _doc, final, _error = run_job(job)
    assert (success, final) == (True, SILENT_MARKER)
    assert observed.get("agent_runs", 0) == 0
    assert _open_cron_rows(hermes_env) == []
