"""``skills.tier1_enforce``: a Tier 1 ``DO_NOT_INSTALL`` verdict refuses the install on every path.

Every install path reaches ``hermes_cli.skills_hub.do_install``: ``hermes skills install`` (what an agent
runs through the terminal tool too), the ``/skills install`` slash command, and ``hermes skills update``.
The scanner is a fake ``skillevaluator`` executable on PATH that writes a report shaped like the real JSON
reporter's (``legacy.messages`` carries ``skillspector risk score: N/100 (SEVERITY)`` above 50).
"""

import json
import os
import stat
import sys
from argparse import Namespace

import pytest

import hermes_cli.skills_hub as cli_hub

SECURITY = "Security & PII Scanning"


def _report(*, status="failed", messages=(), findings=()):
    return {"overall_passed": False, "results": [
        {"validator": SECURITY, "passed": status == "passed", "status": status, "findings": list(findings),
         "legacy": {"errors": [], "warnings": [], "messages": list(messages)}},
        {"validator": "PII Scan", "passed": True, "status": "passed", "findings": []},
    ]}


REPORTS = {
    "dni": _report(messages=["skillspector risk score: 72/100 (HIGH)"]),
    "dni_finding": _report(findings=[{"check_name": "skillspector_risk_score", "severity": "high",
                                      "message": "SkillSpector aggregate risk score 64/100 exceeds the policy threshold",
                                      "file_path": "SKILL.md", "line_number": None}]),
    "caution": _report(status="passed", messages=[]),
    "ok": _report(status="passed"),
    "incomplete": _report(status="incomplete"),
}


@pytest.fixture
def scanner(monkeypatch, tmp_path):
    """Install a fake ``skillevaluator`` on PATH; ``set(mode)`` picks a report, ``error``/``absent`` the failures."""
    bindir = tmp_path / "bin"
    bindir.mkdir()
    calls = tmp_path / "scanner-calls"
    mode_file = tmp_path / "scanner-mode"
    exe = bindir / "skillevaluator"
    exe.write_text(f"""#!{sys.executable}
import json, pathlib, sys
pathlib.Path({str(calls)!r}).open("a").write("x")
mode = pathlib.Path({str(mode_file)!r}).read_text()
if mode == "error":
    sys.exit(2)
out = pathlib.Path(sys.argv[sys.argv.index("-o") + 1])
(out / "skillevaluator-output-1.json").write_text(json.dumps(json.loads({json.dumps(REPORTS)!r})[mode]))
""")
    exe.chmod(exe.stat().st_mode | stat.S_IEXEC)
    base_path = os.pathsep.join(p for p in os.environ.get("PATH", "").split(os.pathsep)
                                if not os.path.exists(os.path.join(p, "skillevaluator")))

    class Scanner:
        def set(self, mode):
            if mode == "absent":
                monkeypatch.setenv("PATH", base_path)
            else:
                monkeypatch.setenv("PATH", f"{bindir}{os.pathsep}{base_path}")
                mode_file.write_text(mode)

        @property
        def runs(self):
            return len(calls.read_text()) if calls.exists() else 0

    return Scanner()


@pytest.fixture
def install_env(monkeypatch, tmp_path):
    """Wire ``do_install`` down to the real scan-policy decision for a safe community skill; config in a temp HOME."""
    import tools.skills_guard as guard
    import tools.skills_hub as hub
    import tools.skills_hub_install as hub_install

    home = tmp_path / "hermes-home"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))

    def set_config(enforce=None):
        skills = {} if enforce is None else {"tier1_enforce": enforce}
        monkeypatch.setattr("hermes_cli.config.load_config", lambda *a, **k: {"skills": skills})

    bundle = type("Bundle", (), {
        "name": "some-skill", "files": {"SKILL.md": "---\nname: some-skill\n---\n"},
        "source": "skills-sh", "identifier": "org/repo/some-skill", "trust_level": "community",
        "metadata": {},
    })()
    q_path = tmp_path / "skills" / ".hub" / "quarantine" / "some-skill"
    q_path.mkdir(parents=True)
    (q_path / "SKILL.md").write_text("---\nname: some-skill\n---\n")
    audit, installs = [], []

    monkeypatch.setattr(hub, "ensure_hub_dirs", lambda: None)
    monkeypatch.setattr(hub, "append_audit_log", lambda *a, **k: audit.append(a))
    monkeypatch.setattr(hub, "HubLockFile", lambda: type("Lock", (), {"get_installed": lambda self, n: None})())
    monkeypatch.setattr(cli_hub, "_sources", lambda: [type("Source", (), {"source_id": lambda self: "skills-sh"})()])
    monkeypatch.setattr(cli_hub, "_resolve_source_meta_and_bundle", lambda i, s: (None, bundle, s[0]))
    monkeypatch.setattr(cli_hub, "_record_skill_install", lambda *a, **k: None)
    monkeypatch.setattr(hub_install, "quarantine_bundle", lambda b: q_path)
    monkeypatch.setattr(cli_hub, "_scan_quarantined", lambda *a, **k: guard.ScanResult(
        skill_name="some-skill", source="org/repo/some-skill", trust_level="community", verdict="safe", findings=[]))

    def _install(q, name, category, b, result):
        installs.append(name)
        d = tmp_path / "skills" / name
        d.mkdir(parents=True, exist_ok=True)
        return d

    monkeypatch.setattr(hub_install, "install_from_quarantine", _install)
    monkeypatch.setattr(hub, "SKILLS_DIR", tmp_path / "skills")
    set_config(None)
    return Namespace(installs=installs, audit=audit, set_config=set_config, q_path=q_path)


def _cli(monkeypatch, *flags):
    """``hermes skills install ...`` through the real entry point (what the terminal tool runs); exit code."""
    from hermes_cli.main import main
    monkeypatch.setattr(sys, "argv", ["hermes", "skills", "install", "org/repo/some-skill", "--yes", *flags])
    try:
        main()
    except SystemExit as exc:
        return exc.code or 0
    return 0


def _slash(*flags):
    cli_hub.handle_skills_slash(" ".join(["/skills", "install", "org/repo/some-skill", *flags]))


PATHS = {"cli": lambda mp, *f: _cli(mp, *f), "slash": lambda mp, *f: _slash(*f)}


def _refused(path, exit_code, env, out):
    assert env.installs == []
    assert "Not installed:" in out
    if path == "cli":
        assert exit_code == 1
    assert env.audit and env.audit[-1][0] == "BLOCKED"


@pytest.mark.parametrize("path", sorted(PATHS))
@pytest.mark.parametrize("mode", ["dni", "dni_finding"])
def test_do_not_install_is_refused_when_enforced(monkeypatch, capsys, install_env, scanner, path, mode):
    install_env.set_config(True)
    scanner.set(mode)
    code = PATHS[path](monkeypatch)
    out = capsys.readouterr().out
    _refused(path, code, install_env, out)
    assert "DO_NOT_INSTALL" in out and "--force" in out


@pytest.mark.parametrize("path", sorted(PATHS))
def test_force_installs_and_logs_the_verdict(monkeypatch, capsys, install_env, scanner, caplog, path):
    install_env.set_config(True)
    scanner.set("dni")
    code = PATHS[path](monkeypatch, "--force")
    out = capsys.readouterr().out
    assert install_env.installs == ["some-skill"] and not code
    assert "installing despite Tier 1 verdict DO_NOT_INSTALL" in out
    forced = [row for row in install_env.audit if row[0] == "FORCED"]
    assert forced and forced[0][4] == "DO_NOT_INSTALL" and "risk score 72/100 (HIGH)" in forced[0][5]


@pytest.mark.parametrize("path", sorted(PATHS))
@pytest.mark.parametrize("mode", ["ok", "caution"])
def test_clean_and_caution_verdicts_install_when_enforced(monkeypatch, install_env, scanner, path, mode):
    install_env.set_config(True)
    scanner.set(mode)
    assert not PATHS[path](monkeypatch)
    assert install_env.installs == ["some-skill"]
    assert scanner.runs == 1  # the advisory print reuses the enforcement scan


@pytest.mark.parametrize("path", sorted(PATHS))
@pytest.mark.parametrize("mode", ["absent", "error", "incomplete"])
def test_fails_closed_when_the_scanner_cannot_judge(monkeypatch, capsys, install_env, scanner, path, mode):
    install_env.set_config(True)
    scanner.set(mode)
    code = PATHS[path](monkeypatch)
    out = capsys.readouterr().out
    _refused(path, code, install_env, out)
    assert "could not give a verdict" in out and "--force" in out


@pytest.mark.parametrize("mode", ["absent", "error", "incomplete"])
def test_force_overrides_an_unavailable_scanner(monkeypatch, install_env, scanner, mode):
    install_env.set_config(True)
    scanner.set(mode)
    assert not _cli(monkeypatch, "--force")
    assert install_env.installs == ["some-skill"]
    assert [row[4] for row in install_env.audit if row[0] == "FORCED"]


@pytest.mark.parametrize("config", [None, False, "false"])
@pytest.mark.parametrize("mode", ["dni", "absent", "error"])
def test_default_off_leaves_the_install_unchanged(monkeypatch, install_env, scanner, config, mode):
    install_env.set_config(config)
    scanner.set(mode)
    assert not _cli(monkeypatch)
    assert install_env.installs == ["some-skill"]
    assert not install_env.audit


def test_update_is_gated_and_its_force_is_the_exception(monkeypatch, capsys, install_env, scanner):
    """``do_update`` always reinstalls with force=True; that must not bypass the gate."""
    install_env.set_config(True)
    scanner.set("dni")
    monkeypatch.setattr("tools.skills_hub_install.check_for_skill_updates", lambda name=None: [
        {"name": "some-skill", "identifier": "org/repo/some-skill", "status": "update_available",
         "source": "skills-sh"}])
    monkeypatch.setattr("tools.skills_hub.HubLockFile", lambda: type("Lock", (), {
        "get_installed": lambda self, n: None})())
    assert cli_hub.do_update() is False
    assert install_env.installs == []
    assert cli_hub.do_update(force=True) is None
    assert install_env.installs == ["some-skill"]
