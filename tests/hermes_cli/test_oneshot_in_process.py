"""Fork-only contract: with ``agent.oneshot_in_process`` a finite query runs the agent in the
calling process (its env and HERMES_MANAGED_DIR reach the turn); without it, upstream's gateway
path is untouched. The env/managed-layer behaviour end to end is probed by
``emana.ai/.tmp/hermes-merge/probe-env.py`` against a fake provider and a live gateway."""
import argparse

from pathlib import Path

import pytest

from hermes_cli import main as hermes_main
from hermes_cli.oneshot_in_process import wants_in_process


def _args(**kw):
    base = dict(command="chat", oneshot_exit=False, quiet=False, query=None, query_file=None)
    base.update(kw)
    return argparse.Namespace(**base)


def _config(home: Path, body: str) -> None:
    (home / "config.yaml").write_text(body, encoding="utf-8")


@pytest.fixture
def home(tmp_path, monkeypatch):
    h = tmp_path / "home"
    h.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(h))
    monkeypatch.delenv("HERMES_MANAGED_DIR", raising=False)
    return h


def test_opted_in_query_file_oneshot_runs_in_process(home):
    _config(home, "agent:\n  oneshot_in_process: true\n")
    args = _args(oneshot_exit=True, quiet=True, query_file="prompt.md")
    assert wants_in_process(args)
    assert not hermes_main._chat_runs_at_gateway(args)  # hooks/plugins are discovered here


def test_the_role_layer_can_opt_in_through_the_managed_dir(home, tmp_path, monkeypatch):
    _config(home, "model:\n  default: x\n")
    managed = tmp_path / "managed"
    managed.mkdir()
    (managed / "config.yaml").write_text("agent:\n  oneshot_in_process: true\n", encoding="utf-8")
    monkeypatch.setenv("HERMES_MANAGED_DIR", str(managed))
    from hermes_cli import managed_scope
    managed_scope.invalidate_managed_cache()
    assert wants_in_process(_args(quiet=True, query="hi"))


@pytest.mark.parametrize("args", [
    _args(oneshot_exit=True, quiet=True, query="hi"),          # not opted in
])
def test_default_keeps_the_gateway_path(home, args):
    _config(home, "model:\n  default: x\n")
    assert not wants_in_process(args)
    assert hermes_main._chat_runs_at_gateway(args)


@pytest.mark.parametrize("args", [
    _args(),                                                   # interactive chat
    _args(query="hi"),                                         # -q seeding an interactive session
    _args(oneshot_exit=True),                                  # finite but no query
], ids=["interactive", "query-without-oneshot", "oneshot-without-query"])
def test_only_finite_queries_qualify_even_when_opted_in(home, args):
    _config(home, "agent:\n  oneshot_in_process: true\n")
    assert not wants_in_process(args)
