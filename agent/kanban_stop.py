"""Turn-end guard for kanban workers, which must end with ``kanban_complete`` or
``kanban_block``. Some models narrate the next step and stop with no tool calls;
Hermes treats that as a clean exit → ``rc=0`` → dispatcher ``protocol_violation``.
Policy-only: return a bounded synthetic nudge so the loop continues instead of exiting.

The nudge is scoped to the recipient's OWN run, never to ``tasks.status``. A card in a
review cycle has two or three worker processes alive at once (the implementer's process
outlives its ``review_requested`` handoff while the reviewer's run is live, and vice
versa), so "the card is running" says nothing about whether *this* session still owns it.
Delivered to the wrong one, the instruction is actively harmful: ``kanban_complete`` from
the implementer while the reviewer runs is the author approving his own work — and would
mark the card done, promote its children and kill the live review — while ``kanban_block``
is a false statement in every one of these cases. So the gate is board state for this
run (:func:`own_run_is_running`), mirroring ``kanban_db.goal_run_status``, which binds the
goal loop to ``expected_run_id`` for the same reason.
"""

from __future__ import annotations

import logging
import os
from typing import Any, Iterable, Optional

from agent.delegation_context import owned_kanban_task

logger = logging.getLogger("agent.kanban_stop")


# Every tool that CLOSES the worker's run. The review handoffs belong here as much as
# complete/block: ``kanban_request_review`` ends the run ``review_requested`` and
# ``kanban_request_changes`` ends it ``changes_requested``. Omitting them made the guard
# nudge a worker that had already handed the card off, toward a tool it must not call.
_TERMINAL_KANBAN_TOOLS = frozenset({
    "kanban_complete", "kanban_block", "kanban_request_review", "kanban_request_changes",
})

_DEFAULT_MAX_ATTEMPTS = 2


def kanban_stop_nudge_enabled() -> bool:
    """On when ``HERMES_KANBAN_TASK`` is set for the dispatcher-owned worker, unless
    ``HERMES_KANBAN_STOP_NUDGE`` disables it. In-process delegate_task children and cron runs
    inherit the env var but own no board task and carry no kanban toolset."""
    if (os.environ.get("HERMES_KANBAN_STOP_NUDGE") or "").strip().lower() in {"0", "false", "no", "off"}:
        return False
    return bool(owned_kanban_task())


def _tool_call_name(tc: Any) -> str:
    """Tool name from a dict or object tool call (``function.name`` first, then ``name``)."""
    if isinstance(tc, dict):
        fn = tc.get("function")
        return str((fn.get("name") if isinstance(fn, dict) else tc.get("name")) or "")
    fn = getattr(tc, "function", None)
    return str((getattr(fn, "name", "") if fn is not None else getattr(tc, "name", "")) or "")


def session_called_kanban_terminal(messages: Iterable[dict] | None) -> bool:
    """True if this conversation already invoked a run-closing kanban tool.

    Reported intent, not board state: a terminal call that FAILED (parents reopened, a
    live-claim fence) leaves the run open, so this is not the nudge gate — it only
    describes what the session tried. :func:`own_run_is_running` is the authority.
    """
    for msg in filter(lambda m: isinstance(m, dict), messages or ()):
        role = msg.get("role")
        if role == "assistant" and any(
            _tool_call_name(tc) in _TERMINAL_KANBAN_TOOLS for tc in msg.get("tool_calls") or []
        ):
            return True
        if role == "tool" and str(msg.get("name") or "") in _TERMINAL_KANBAN_TOOLS:
            return True
    return False


def _env_run_id() -> Optional[int]:
    """This worker's own ``task_runs`` row id, as pinned by the dispatcher at spawn."""
    raw = (os.environ.get("HERMES_KANBAN_RUN_ID") or "").strip()
    try:
        return int(raw) if raw else None
    except ValueError:
        logger.debug("invalid HERMES_KANBAN_RUN_ID=%r", raw)
        return None


def _normalized_profile(profile: Optional[str]) -> str:
    """Canonical comparison form for a profile name (``task_runs.profile`` is stored
    canonicalized from ``tasks.assignee``)."""
    name = (profile or "").strip()
    if not name:
        return ""
    try:
        from hermes_cli.profiles import normalize_profile_name
        return (normalize_profile_name(name) or name).strip().lower()
    except Exception:
        return name.lower()


def _session_profile() -> str:
    """The profile this worker session runs under (the dispatcher pins ``HERMES_HOME``
    to the assignee profile's root at spawn)."""
    try:
        from hermes_cli.profiles import get_active_profile_name
        return get_active_profile_name() or ""
    except Exception:
        logger.debug("could not resolve the active profile name", exc_info=True)
        return ""


def own_run_is_running(
    task_id: str, *, run_id: Optional[int] = None, profile: Optional[str] = None,
) -> Optional[bool]:
    """Whether the recipient's OWN run is the one still ``running`` on ``task_id``.

    ``True`` only with positive evidence: a ``task_runs`` row in ``status='running'``
    that is this session's run (by ``HERMES_KANBAN_RUN_ID``, else by profile). ``False``
    when the card's live run belongs to someone else or nothing is running at all.
    ``None`` — cannot tell — when the board could not be read, carries no run for the
    card, or the profile fallback cannot separate this session from an earlier run of
    its own profile on the same card.

    Reading ``tasks.status`` instead is the defect this replaces: ``running`` is true of
    the CARD while a successor run works it, and says nothing about the session being
    addressed.
    """
    task_id = (task_id or "").strip()
    if not task_id:
        return None
    if run_id is None:
        run_id = _env_run_id()
    mine = _normalized_profile(_session_profile() if profile is None else profile)
    try:
        from hermes_cli import kanban_db as kb
        from hermes_cli import kanban_db_connect as kbc

        with kbc.connect_closing() as conn:
            runs = kb.list_runs(conn, task_id)
    except Exception:
        logger.debug("kanban stop guard: board read failed for %s", task_id, exc_info=True)
        return None
    if not runs:
        # No run history for this id on the board we resolved — the card is not ours to
        # reason about (wrong board, archived, hand-set env). Not evidence of anything.
        return None
    running = [r for r in runs if (r.status or "") == "running"]
    if not running:
        return False
    if run_id is not None:
        return any(int(r.id) == int(run_id) for r in running)
    # No pinned run id. The only discriminator left is the profile the live run is booked
    # under, and it separates the recipient from the live run only when this profile owns
    # exactly one run on the card. Same-profile succession is the COMMON shape, not the
    # exception: on the live platform board 84 of 109 closed-run -> successor pairs keep
    # the same profile (a rework run after `changes_requested` is the same `dev` as the
    # run it replaces, and this very card is one of them). There, a profile match is not
    # evidence that the live run is MINE — the recipient may equally be the closed
    # predecessor whose process is still attached, which is the misdelivery this function
    # exists to stop. So it answers "cannot tell" and fails closed, as everywhere else.
    if not mine:
        return None
    if not any(_normalized_profile(r.profile) == mine for r in running):
        return False
    if any(_normalized_profile(r.profile) == mine for r in runs if (r.status or "") != "running"):
        return None
    return True


def build_kanban_stop_nudge(
    *,
    messages: Iterable[dict] | None = None,
    attempts: int = 0,
    max_attempts: int = _DEFAULT_MAX_ATTEMPTS,
    task_id: Optional[str] = None,
) -> Optional[str]:
    """Synthetic follow-up when a kanban worker exits without a terminal tool; ``None`` when
    the guard should not fire (not a kanban worker, budget exhausted, or this session's own
    run is no longer the card's live run)."""
    if not kanban_stop_nudge_enabled() or attempts >= max_attempts:
        return None

    tid = (task_id or os.environ.get("HERMES_KANBAN_TASK") or "").strip()
    # Positive confirmation only. An unreadable board (``None``) suppresses: a missed nudge
    # costs one dispatcher retry, whose budget exists for exactly this, while a misdelivered
    # one instructs a false ``done`` or a false ``blocked`` on someone else's live run.
    if own_run_is_running(tid) is not True:
        return None

    return (
        "[System: You are a Hermes kanban worker. A plain-text reply is NOT a "
        "terminal state for the board.\n\n"
        f"Task `{tid or 'this task'}` is still `running` under YOUR run. Ending now "
        "without a board tool causes a protocol violation (clean exit with no "
        "`kanban_complete` / `kanban_block`).\n\n"
        "Do this immediately in your next response — do not narrate intent:\n"
        "1. Finish any remaining deliverable (write the required file(s) now).\n"
        "2. Call `kanban_complete(summary=..., artifacts=[...])` if the work "
        "is done, OR `kanban_block(reason=...)` if you are blocked.\n\n"
        "Never end a turn with only a promise of future action. Repeated "
        "protocol violations will block this task and require manual intervention.]"
    )


__all__ = [
    "build_kanban_stop_nudge", "kanban_stop_nudge_enabled", "own_run_is_running",
    "session_called_kanban_terminal",
]
