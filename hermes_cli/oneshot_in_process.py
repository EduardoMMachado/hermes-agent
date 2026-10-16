"""Fork-only (EduardoMMachado/hermes-agent): run a finite chat turn in THIS process.

Upstream routes every chat launch through the gateway (3551045907): ``hermes chat --oneshot`` is a
client, and the turn runs inside the gateway with the GATEWAY's environment and config. The emana
dispatcher gives each worker its own environment — role identity read by the shell-hook guards,
the role's GitHub App token, and a per-role ``HERMES_MANAGED_DIR`` layer (model, reasoning,
memory off, role hooks). Those only reach the turn when the agent runs in the worker's own process.

Opt-in per profile with ``agent.oneshot_in_process: true``; only finite launches with a query
(``--oneshot`` / ``-Q`` plus ``-q`` / ``--query-file``) qualify, so interactive chat, the TUI and
Desktop keep upstream's gateway path.
"""
from __future__ import annotations


def wants_in_process(args) -> bool:
    finite = bool(getattr(args, "oneshot_exit", False) or getattr(args, "quiet", False))
    if not (finite and (getattr(args, "query", None) or getattr(args, "query_file", None))):
        return False
    from hermes_cli.config import load_config

    return bool((load_config().get("agent") or {}).get("oneshot_in_process"))


def run_and_exit(args) -> None:
    """Never returns: ``_run_and_exit_oneshot`` hard-exits with the run's code."""
    from hermes_cli.main import _run_and_exit_oneshot

    _run_and_exit_oneshot(
        args.query,
        model=getattr(args, "model", None),
        provider=getattr(args, "provider", None),
        toolsets=getattr(args, "toolsets", None),
        skills=getattr(args, "skills", None),
        usage_file=getattr(args, "usage_file", None),
        resume=getattr(args, "resume", None),
        reasoning=getattr(args, "reasoning", None),
        max_iterations=getattr(args, "max_turns", None),
    )
