"""Tests for the kanban worker turn-end stop guard.

The load-bearing property is that the nudge is scoped to the recipient's OWN run, not to
``tasks.status``. A card in a review cycle has two or three worker processes alive at
once; delivered to the wrong one, the nudge instructs ``kanban_complete`` (the author
approving his own work, marking the card done and killing the live review) or
``kanban_block`` (a false statement). The review-cycle tests below build a real board with
a closed run and a live successor under a different profile.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from agent.kanban_stop import (
    build_kanban_stop_nudge,
    kanban_stop_nudge_enabled,
    own_run_is_running,
    session_called_kanban_terminal,
)


@pytest.fixture
def clear_kanban_env(monkeypatch):
    for var in (
        "HERMES_KANBAN_TASK", "HERMES_KANBAN_STOP_NUDGE", "HERMES_KANBAN_RUN_ID",
        "HERMES_KANBAN_DB", "HERMES_KANBAN_BOARD",
    ):
        monkeypatch.delenv(var, raising=False)
    return monkeypatch


# --------------------------------------------------------------------------- board fixtures


def _board(tmp_path, monkeypatch):
    """A real kanban DB pinned into the env, as the dispatcher pins it at spawn."""
    from hermes_cli.kanban_db_connect import connect

    db = tmp_path / "board.db"
    conn = connect(db)
    monkeypatch.setenv("HERMES_KANBAN_DB", str(db))
    monkeypatch.setenv("HERMES_KANBAN_BOARD", "default")
    monkeypatch.delenv("HERMES_DELEGATED_CHILD_CONTEXT", raising=False)
    return conn


def _run_row(conn, task_id: str, *, profile: str, status: str, outcome=None):
    """Append one ``task_runs`` row directly.

    The lifecycle helpers can only produce ONE open run per card, which is precisely the
    shape that hides this defect: the bug needs a closed run plus a live successor under a
    different profile. Written at the table so the fixture can state that shape exactly.
    """
    cur = conn.execute(
        "INSERT INTO task_runs (task_id, profile, status, outcome, started_at, ended_at) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (task_id, profile, status, outcome, 1000, None if status == "running" else 2000),
    )
    conn.commit()
    return int(cur.lastrowid)


@pytest.fixture
def review_cycle(tmp_path, clear_kanban_env):
    """The measured board state of t_f6ce6efd at 10:13.

    Run 135 (``dev``) ended ``review_requested``; run 139 (``reviewer``) is live. The card
    row itself is ``running`` — which is what the defective guard read, and why the
    implementer's still-attached session got the notice.
    """
    from hermes_cli import kanban_db as kb

    conn = _board(tmp_path, clear_kanban_env)
    tid = kb.create_task(conn, title="B13", assignee="dev")
    conn.execute("UPDATE tasks SET status = 'running' WHERE id = ?", (tid,))
    conn.commit()
    closed = _run_row(conn, tid, profile="dev", status="review", outcome="review_requested")
    live = _run_row(conn, tid, profile="reviewer", status="running")
    # The defect's precondition: the CARD reads running while the implementer's run is closed.
    assert kb.get_task(conn, tid).status == "running"
    clear_kanban_env.setenv("HERMES_KANBAN_TASK", tid)
    return {"conn": conn, "task_id": tid, "closed_run": closed, "live_run": live}


def _as_profile(monkeypatch, tmp_path, name: str):
    """Run the rest of the test as profile ``name``, the way the dispatcher pins it:
    ``HERMES_HOME`` at that profile's root."""
    home = tmp_path / "profiles" / name
    home.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    from hermes_cli.profiles import get_active_profile_name
    assert get_active_profile_name() == name, "fixture did not actually switch profile"


# --------------------------------------------------------------------------- enable gate


def test_env_can_disable(clear_kanban_env):
    clear_kanban_env.setenv("HERMES_KANBAN_TASK", "t_abc")
    clear_kanban_env.setenv("HERMES_KANBAN_STOP_NUDGE", "0")
    assert kanban_stop_nudge_enabled() is False
    assert build_kanban_stop_nudge(messages=[]) is None


def test_nudge_disabled_inside_delegated_child(clear_kanban_env):
    from agent.delegation_context import delegated_child_context

    clear_kanban_env.setenv("HERMES_KANBAN_TASK", "t_parent")

    assert kanban_stop_nudge_enabled() is True
    with delegated_child_context():
        assert kanban_stop_nudge_enabled() is False
        assert build_kanban_stop_nudge(messages=[]) is None
    assert kanban_stop_nudge_enabled() is True


def test_nudge_disabled_inside_non_dispatcher_context(clear_kanban_env):
    from agent.delegation_context import non_dispatcher_owned_context

    clear_kanban_env.setenv("HERMES_KANBAN_TASK", "t_parent")

    assert kanban_stop_nudge_enabled() is True
    with non_dispatcher_owned_context():
        assert kanban_stop_nudge_enabled() is False
        assert build_kanban_stop_nudge(messages=[]) is None
    assert kanban_stop_nudge_enabled() is True


# --------------------------------------------------------------------------- terminal-tool scan


def test_review_handoffs_are_terminal_tools():
    """``kanban_request_review`` / ``kanban_request_changes`` CLOSE the run. Omitting them
    is how the implementer's session at 10:13 was scored as "never called a terminal tool"
    after it had already handed the card to the reviewer."""
    for tool in ("kanban_complete", "kanban_block", "kanban_request_review", "kanban_request_changes"):
        messages = [
            {"role": "assistant", "content": "",
             "tool_calls": [{"id": "1", "type": "function", "function": {"name": tool, "arguments": "{}"}}]},
            {"role": "tool", "name": tool, "tool_call_id": "1", "content": "ok"},
        ]
        assert session_called_kanban_terminal(messages) is True, tool


def test_heartbeat_is_not_terminal():
    messages = [
        {"role": "assistant", "content": "Let me write the report.",
         "tool_calls": [{"id": "1", "type": "function", "function": {"name": "kanban_heartbeat", "arguments": "{}"}}]},
        {"role": "tool", "name": "kanban_heartbeat", "tool_call_id": "1", "content": "ok"},
    ]
    assert session_called_kanban_terminal(messages) is False


# --------------------------------------------------------------------------- own-run resolution
# AC1 + AC3: >=2 runs, an earlier one closed and a later one live under a DIFFERENT profile.


def test_closed_run_profile_gets_nothing(review_cycle, tmp_path, clear_kanban_env):
    """The measured 10:13 defect: the implementer's session, its run closed
    ``review_requested``, while the reviewer's run is live. It must receive NO notice.

    This is the assertion that reddens when the run/profile comparison is removed and the
    guard goes back to reading ``tasks.status``.
    """
    _as_profile(clear_kanban_env, tmp_path, "dev")
    tid = review_cycle["task_id"]

    # By pinned run id (how the dispatcher scopes a worker), and by profile alone
    # (a worker whose HERMES_KANBAN_RUN_ID was lost).
    clear_kanban_env.setenv("HERMES_KANBAN_RUN_ID", str(review_cycle["closed_run"]))
    assert own_run_is_running(tid) is False
    assert build_kanban_stop_nudge(messages=[], attempts=0) is None

    clear_kanban_env.delenv("HERMES_KANBAN_RUN_ID", raising=False)
    assert own_run_is_running(tid) is False
    assert build_kanban_stop_nudge(messages=[], attempts=0) is None


def test_live_run_profile_still_gets_the_notice(review_cycle, tmp_path, clear_kanban_env):
    """The other half: narrowing the scope must not silence the worker that IS running.
    Proving only the negative would pass with the guard deleted."""
    _as_profile(clear_kanban_env, tmp_path, "reviewer")
    tid = review_cycle["task_id"]

    clear_kanban_env.setenv("HERMES_KANBAN_RUN_ID", str(review_cycle["live_run"]))
    assert own_run_is_running(tid) is True
    nudge = build_kanban_stop_nudge(messages=[], attempts=0)
    assert nudge is not None
    assert "kanban_complete" in nudge and "kanban_block" in nudge
    assert tid in nudge

    clear_kanban_env.delenv("HERMES_KANBAN_RUN_ID", raising=False)
    assert own_run_is_running(tid) is True


def test_changes_requested_run_gets_nothing_for_the_successor(tmp_path, clear_kanban_env):
    """AC2, the 10:19 direction: the REVIEWER's run ended ``changes_requested`` and the
    implementer's rework run is live. ``kanban_complete`` there would approve work the
    reviewer just rejected."""
    from hermes_cli import kanban_db as kb

    conn = _board(tmp_path, clear_kanban_env)
    tid = kb.create_task(conn, title="B13", assignee="dev")
    conn.execute("UPDATE tasks SET status = 'running' WHERE id = ?", (tid,))
    conn.commit()
    closed = _run_row(conn, tid, profile="reviewer", status="ready", outcome="changes_requested")
    _run_row(conn, tid, profile="dev", status="running")
    clear_kanban_env.setenv("HERMES_KANBAN_TASK", tid)
    _as_profile(clear_kanban_env, tmp_path, "reviewer")

    clear_kanban_env.setenv("HERMES_KANBAN_RUN_ID", str(closed))
    assert own_run_is_running(tid) is False
    assert build_kanban_stop_nudge(messages=[], attempts=0) is None


def test_same_profile_succession_pins_the_run_id_branch(tmp_path, clear_kanban_env):
    """The shape the profile fallback CANNOT discriminate, and the case that makes the
    ``HERMES_KANBAN_RUN_ID`` comparison load-bearing.

    Same-profile succession is the common shape, not the exception: on the live platform
    board 84 of 109 closed-run -> successor pairs keep the same profile — a rework run
    after ``changes_requested`` is the same ``dev`` as the run it replaces, and t_e336bd76
    itself is one (run 155 ``dev``/``changes_requested`` -> run 161 ``dev``/``running``).
    AC2 is not scoped to a *different* profile, so it has to hold here too.

    Run id and profile disagree about every answer below, which is what nothing else in
    this file arranges. Replacing the ``run_id`` branch with ``pass`` reddens both halves:
    the closed run's ``False`` becomes ``None``, and the live run loses its nudge.
    """
    from hermes_cli import kanban_db as kb

    conn = _board(tmp_path, clear_kanban_env)
    tid = kb.create_task(conn, title="rework", assignee="dev")
    conn.execute("UPDATE tasks SET status = 'running' WHERE id = ?", (tid,))
    conn.commit()
    closed = _run_row(conn, tid, profile="dev", status="ready", outcome="changes_requested")
    live = _run_row(conn, tid, profile="dev", status="running")
    clear_kanban_env.setenv("HERMES_KANBAN_TASK", tid)
    _as_profile(clear_kanban_env, tmp_path, "dev")

    # The closed run's still-attached session: AC2, with the successor under its OWN
    # profile. Only the pinned run id can tell it apart from the live run.
    clear_kanban_env.setenv("HERMES_KANBAN_RUN_ID", str(closed))
    assert own_run_is_running(tid) is False
    assert build_kanban_stop_nudge(messages=[], attempts=0) is None

    # The live rework run, same profile: it must still be nudged. Without the run id the
    # profile says nothing here, so this ``True`` comes from the run id alone.
    clear_kanban_env.setenv("HERMES_KANBAN_RUN_ID", str(live))
    assert own_run_is_running(tid) is True
    assert build_kanban_stop_nudge(messages=[], attempts=0) is not None

    # And with the pin lost, the honest answer is "cannot tell" -> suppress. A profile
    # match is not evidence the live run is mine when this profile also owns a closed one;
    # answering True there is the misdelivery the card was opened for, on the fallback.
    clear_kanban_env.delenv("HERMES_KANBAN_RUN_ID", raising=False)
    assert own_run_is_running(tid) is None
    assert build_kanban_stop_nudge(messages=[], attempts=0) is None


def test_profile_fallback_still_decides_when_it_can(review_cycle, tmp_path, clear_kanban_env):
    """The fallback is a safety net, not dead code: with the pin lost it must still answer
    whenever the profile genuinely discriminates — ``False`` for a profile that owns no
    live run, ``True`` for the single run of its own profile on the card.

    Without this, making the ambiguous case ``None`` could be satisfied by neutering the
    fallback entirely, which would cost every unpinned worker its nudge.
    """
    from hermes_cli import kanban_db as kb

    tid = review_cycle["task_id"]  # closed dev + live reviewer
    clear_kanban_env.delenv("HERMES_KANBAN_RUN_ID", raising=False)

    _as_profile(clear_kanban_env, tmp_path, "dev")
    assert own_run_is_running(tid) is False, "dev owns no live run on this card"

    _as_profile(clear_kanban_env, tmp_path, "reviewer")
    assert own_run_is_running(tid) is True, "reviewer owns the card's only reviewer run"
    assert build_kanban_stop_nudge(messages=[], attempts=0) is not None

    # A fresh card with one run and no pin at all: the fallback is the only discriminator.
    conn = review_cycle["conn"]
    solo = kb.create_task(conn, title="solo", assignee="reviewer")
    conn.execute("UPDATE tasks SET status = 'running' WHERE id = ?", (solo,))
    conn.commit()
    _run_row(conn, solo, profile="reviewer", status="running")
    assert own_run_is_running(solo) is True


def test_single_live_run_is_the_happy_path(tmp_path, clear_kanban_env):
    """The ordinary one-run card: the guard must keep firing. This case passes over the
    defect on its own, which is why it is not the regression test."""
    from hermes_cli import kanban_db as kb

    conn = _board(tmp_path, clear_kanban_env)
    tid = kb.create_task(conn, title="solo", assignee="dev")
    conn.execute("UPDATE tasks SET status = 'running' WHERE id = ?", (tid,))
    conn.commit()
    run = _run_row(conn, tid, profile="dev", status="running")
    clear_kanban_env.setenv("HERMES_KANBAN_TASK", tid)
    clear_kanban_env.setenv("HERMES_KANBAN_RUN_ID", str(run))
    _as_profile(clear_kanban_env, tmp_path, "dev")

    assert own_run_is_running(tid) is True
    assert build_kanban_stop_nudge(messages=[], attempts=0) is not None


def test_no_nudge_once_the_run_is_closed(tmp_path, clear_kanban_env):
    """After a successful ``kanban_complete`` the run is closed — board state, not the
    message scan, is what ends the nudging."""
    from hermes_cli import kanban_db as kb

    conn = _board(tmp_path, clear_kanban_env)
    tid = kb.create_task(conn, title="solo", assignee="dev")
    run = _run_row(conn, tid, profile="dev", status="done", outcome="completed")
    conn.execute("UPDATE tasks SET status = 'done' WHERE id = ?", (tid,))
    conn.commit()
    clear_kanban_env.setenv("HERMES_KANBAN_TASK", tid)
    clear_kanban_env.setenv("HERMES_KANBAN_RUN_ID", str(run))
    _as_profile(clear_kanban_env, tmp_path, "dev")

    assert own_run_is_running(tid) is False
    assert build_kanban_stop_nudge(messages=[], attempts=0) is None


def test_budget_is_still_enforced(tmp_path, clear_kanban_env):
    from hermes_cli import kanban_db as kb

    conn = _board(tmp_path, clear_kanban_env)
    tid = kb.create_task(conn, title="solo", assignee="dev")
    conn.execute("UPDATE tasks SET status = 'running' WHERE id = ?", (tid,))
    conn.commit()
    run = _run_row(conn, tid, profile="dev", status="running")
    clear_kanban_env.setenv("HERMES_KANBAN_TASK", tid)
    clear_kanban_env.setenv("HERMES_KANBAN_RUN_ID", str(run))
    _as_profile(clear_kanban_env, tmp_path, "dev")

    assert build_kanban_stop_nudge(messages=[], attempts=1) is not None
    assert build_kanban_stop_nudge(messages=[], attempts=2) is None


def test_board_without_the_card_suppresses(clear_kanban_env, tmp_path):
    """Fail CLOSED, half one: the board reads fine but carries no run for this id (wrong
    board, archived, hand-set env). A missed nudge costs one dispatcher retry — whose
    budget exists for exactly this — while a misdelivered one instructs a false ``done``
    on a live run."""
    clear_kanban_env.setenv("HERMES_KANBAN_TASK", "t_nonexistent")
    clear_kanban_env.setenv("HERMES_KANBAN_DB", str(tmp_path / "empty.db"))
    clear_kanban_env.setenv("HERMES_KANBAN_BOARD", "default")
    assert own_run_is_running("t_nonexistent") is None
    assert build_kanban_stop_nudge(messages=[], attempts=0) is None


def test_board_read_failure_suppresses(review_cycle, tmp_path, clear_kanban_env):
    """Fail CLOSED, half two: the read itself RAISES (locked db, permissions, a schema the
    binary does not know).

    This is a separate branch from "the board has no such card", and it is the branch that
    matters most: it fires on a card the guard otherwise WOULD nudge. Measured on the
    pristine tree — the empty-board test above never reaches the ``except`` (it returns at
    ``not runs``), so without this case flipping that handler to ``return True`` keeps the
    whole suite green while restoring the misdelivery the card was opened for.
    """
    from hermes_cli import kanban_db_connect as kbc

    tid = review_cycle["task_id"]
    _as_profile(clear_kanban_env, tmp_path, "reviewer")
    clear_kanban_env.setenv("HERMES_KANBAN_RUN_ID", str(review_cycle["live_run"]))

    # Precondition: with a readable board this very session IS nudged. Without this the
    # test could pass for the wrong reason (suppressed by scope, not by the read failure).
    assert own_run_is_running(tid) is True
    assert build_kanban_stop_nudge(messages=[], attempts=0) is not None

    def _boom(*args, **kwargs):
        raise sqlite3.OperationalError("database is locked")

    clear_kanban_env.setattr(kbc, "connect_closing", _boom)
    assert own_run_is_running(tid) is None
    assert build_kanban_stop_nudge(messages=[], attempts=0) is None
