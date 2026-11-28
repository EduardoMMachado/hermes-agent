"""Tests for the advisory SkillEvaluator Tier 1 install scan.

The adapter (tools/skillevaluator_scan.py) must:
- classify secrets-class vs advisory findings correctly,
- degrade to an unavailable (no-op) report on every failure mode,
- never raise out of the install path helper.
"""

import json
import subprocess
import sys
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from tools.skillevaluator_scan import (
    Tier1Report,
    _parse_report,
    format_tier1_report,
    run_tier1_scan,
    tier1_advisory_enabled,
)

def _report_json(findings):
    return {
        "overall_passed": not findings,
        "results": [
            {"validator": "PII Scan", "passed": not findings, "findings": findings},
            {"validator": "Unicode Smuggling Detection", "passed": True, "findings": []},
        ],
    }

def _finding(check, severity="high", message="msg", file="SKILL.md", line=3):
    return {
        "check_name": check,
        "severity": severity,
        "message": message,
        "file_path": file,
        "line_number": line,
        "suggestion": "fix it",
    }

class TestParseReport:
    def test_clean_report(self):
        report = _parse_report(_report_json([]))
        assert report.available
        assert report.passed
        assert report.findings == []

    def test_pii_email_is_advisory_not_secrets(self):
        report = _parse_report(_report_json([
            _finding("emails", message="Non-placeholder email address: git@github.com"),
        ]))
        assert len(report.findings) == 1
        assert report.advisory_findings == report.findings
        assert report.secrets_findings == []

    def test_database_credentials_is_secrets_class(self):
        report = _parse_report(_report_json([
            _finding("database_credentials", severity="critical"),
        ]))
        assert len(report.secrets_findings) == 1
        assert report.advisory_findings == []

    def test_malformed_findings_skipped(self):
        raw = _report_json([_finding("emails")])
        raw["results"][0]["findings"].append("not-a-dict")
        report = _parse_report(raw)
        assert len(report.findings) == 1

    def test_incomplete_check_excluded_from_verdict(self):
        """A fail-with-zero-findings incomplete validator (e.g. SkillSpector
        consistency-check trip) must not fail the advisory verdict."""
        raw = _report_json([])
        raw["results"].append({
            "validator": "Security Scan",
            "passed": False,
            "status": "incomplete",
            "findings": [],
        })
        report = _parse_report(raw)
        assert report.passed
        assert report.findings == []
        assert report.incomplete_checks == ["Security Scan"]

    def test_incomplete_check_findings_preserved(self):
        """Partial evidence from an incomplete validator is kept as findings
        (Nir Paz review) — only the validator's pass/fail verdict is excluded."""
        raw = _report_json([])
        raw["results"].append({
            "validator": "Security Scan",
            "passed": False,
            "status": "incomplete",
            "findings": [_finding("hardcoded_secrets", severity="critical")],
        })
        report = _parse_report(raw)
        assert len(report.findings) == 1
        assert report.findings[0].is_secrets_class
        assert report.incomplete_checks == ["Security Scan"]
        # findings present -> report is not clean, even though the only
        # failing validator was incomplete
        assert not report.passed

class TestRunTier1Scan:
    def test_scanner_missing_degrades(self, tmp_path):
        with mock.patch("tools.skillevaluator_scan.shutil.which", return_value=None):
            report = run_tier1_scan(tmp_path)
        assert not report.available
        assert report.findings == []

    def test_scanner_timeout_degrades(self, tmp_path):
        with mock.patch("tools.skillevaluator_scan.shutil.which", return_value="/usr/bin/skillevaluator"), \
             mock.patch("tools.skillevaluator_scan.subprocess.run",
                        side_effect=subprocess.TimeoutExpired(cmd="x", timeout=1)):
            report = run_tier1_scan(tmp_path)
        assert not report.available

    def test_scanner_launch_failure_degrades(self, tmp_path):
        with mock.patch("tools.skillevaluator_scan.shutil.which", return_value="/usr/bin/skillevaluator"), \
             mock.patch("tools.skillevaluator_scan.subprocess.run", side_effect=OSError("boom")):
            report = run_tier1_scan(tmp_path)
        assert not report.available

    def test_no_json_report_degrades(self, tmp_path):
        with mock.patch("tools.skillevaluator_scan.shutil.which", return_value="/usr/bin/skillevaluator"), \
             mock.patch("tools.skillevaluator_scan.subprocess.run",
                        return_value=subprocess.CompletedProcess([], 1, "", "")):
            report = run_tier1_scan(tmp_path)
        assert not report.available

    def test_scanner_child_gets_no_hermes_pythonpath(self, tmp_path, monkeypatch):
        """The scanner is a separate Python. Run from the `hermes` launcher, the parent's PYTHONPATH names the
        Hermes repo root, and the child imported Hermes's pydantic_core built for another interpreter, crashed
        with no report, and tier1_enforce refused every hub install (`SCAN_UNAVAILABLE`)."""
        import tools.environments.local_pythonpath as lp
        repo_root = str(Path(__file__).resolve().parents[2])
        monkeypatch.setenv("PYTHONPATH", repo_root)
        monkeypatch.setattr(lp._state(), "_hermes_repo_root_aliases", [Path(repo_root)], raising=False)
        seen = {}

        def fake_run(cmd, **kwargs):
            seen["env"] = kwargs.get("env")
            return subprocess.CompletedProcess(cmd, 1, "", "")

        with mock.patch("tools.skillevaluator_scan.shutil.which", return_value="/usr/bin/skillevaluator"), \
             mock.patch("tools.skillevaluator_scan.subprocess.run", side_effect=fake_run):
            run_tier1_scan(tmp_path)
        assert seen["env"] is not None
        assert repo_root not in seen["env"].get("PYTHONPATH", "").split(":")

    def test_real_report_parsed(self, tmp_path):
        """subprocess.run mocked to drop a real-shaped report into outdir."""
        payload = _report_json([_finding("emails")])

        def fake_run(cmd, **kwargs):
            outdir = Path(cmd[cmd.index("-o") + 1])
            (outdir / "skillevaluator-output-1.json").write_text(json.dumps(payload))
            return subprocess.CompletedProcess(cmd, 1, "", "")

        with mock.patch("tools.skillevaluator_scan.shutil.which", return_value="/usr/bin/skillevaluator"), \
             mock.patch("tools.skillevaluator_scan.subprocess.run", side_effect=fake_run):
            report = run_tier1_scan(tmp_path)
        assert report.available
        assert not report.passed
        assert len(report.findings) == 1
        assert report.findings[0].check == "emails"

class TestFormatReport:
    def test_unavailable_is_empty(self):
        assert format_tier1_report(Tier1Report(available=False)) == ""

    def test_findings_show_location_and_secrets_tag(self):
        report = _parse_report(_report_json([
            _finding("database_credentials", severity="critical",
                     message="Database connection string with credentials"),
            _finding("emails", message="Non-placeholder email address: a@b.com", line=8),
        ]))
        text = format_tier1_report(report)
        assert "[SECRETS]" in text
        assert "SKILL.md:3" in text
        assert "SKILL.md:8" in text

    def test_incomplete_checks_noted(self):
        raw = _report_json([])
        raw["results"].append({
            "validator": "Security Scan",
            "passed": False,
            "status": "incomplete",
            "findings": [],
        })
        text = format_tier1_report(_parse_report(raw))
        assert "Security Scan" in text

    def test_limit_truncates(self):
        findings = [_finding("emails", message=f"m{i}", line=i) for i in range(1, 15)]
        report = _parse_report(_report_json(findings))
        text = format_tier1_report(report, limit=5)
        assert "9 more" in text

class TestConfigGate:

    def test_disabled_via_config(self):
        with mock.patch("hermes_cli.config.load_config",
                        return_value={"skills": {"tier1_advisory": False}}):
            assert not tier1_advisory_enabled()

    def test_string_false_disabled(self):
        with mock.patch("hermes_cli.config.load_config",
                        return_value={"skills": {"tier1_advisory": "false"}}):
            assert not tier1_advisory_enabled()

    def test_config_error_defaults_enabled(self):
        with mock.patch("hermes_cli.config.load_config", side_effect=RuntimeError):
            assert tier1_advisory_enabled()

class TestInstallPathHelper:
    """_print_tier1_advisory must never raise and never block."""

    def test_helper_never_raises_on_scanner_error(self, tmp_path):
        from hermes_cli.skills_hub import _print_tier1_advisory
        console = mock.MagicMock()
        with mock.patch("tools.skillevaluator_scan.run_tier1_scan",
                        side_effect=RuntimeError("boom")):
            _print_tier1_advisory(tmp_path, console)  # must not raise

    def test_helper_silent_when_unavailable(self, tmp_path):
        from hermes_cli.skills_hub import _print_tier1_advisory
        console = mock.MagicMock()
        with mock.patch("tools.skillevaluator_scan.run_tier1_scan",
                        return_value=Tier1Report(available=False)):
            _print_tier1_advisory(tmp_path, console)
        console.print.assert_not_called()

    def test_helper_silent_when_disabled(self, tmp_path):
        from hermes_cli.skills_hub import _print_tier1_advisory
        console = mock.MagicMock()
        with mock.patch("tools.skillevaluator_scan.tier1_advisory_enabled",
                        return_value=False), \
             mock.patch("tools.skillevaluator_scan.run_tier1_scan") as scan:
            _print_tier1_advisory(tmp_path, console)
        scan.assert_not_called()
        console.print.assert_not_called()

    def test_helper_prints_findings_and_continues(self, tmp_path):
        from hermes_cli.skills_hub import _print_tier1_advisory
        console = mock.MagicMock()
        report = _parse_report(_report_json([
            _finding("emails", message="Non-placeholder email: a@b.com"),
        ]))
        with mock.patch("tools.skillevaluator_scan.run_tier1_scan",
                        return_value=report):
            _print_tier1_advisory(tmp_path, console)
        assert console.print.called


class TestSecurityVerdict:
    """The security verdict ``skills.tier1_enforce`` reads: SkillEvaluator drops SkillSpector's
    ``recommendation``, so DO_NOT_INSTALL is derived from the risk-score message/finding (score > 50)."""

    @staticmethod
    def _security(**kw):
        res = {"validator": "Security & PII Scanning", "passed": True, "status": "passed", "findings": [],
               "legacy": {"messages": []}}
        res.update(kw)
        return _parse_report({"results": [res]})

    def test_score_above_50_message_is_do_not_install(self):
        r = self._security(legacy={"messages": ["skillspector risk score: 51/100 (HIGH)"]})
        assert r.security_checked and r.skillspector_detail == "risk score 51/100 (HIGH)"

    def test_score_of_50_or_less_is_not(self):
        assert not self._security(legacy={"messages": ["skillspector risk score: 50/100 (MEDIUM)"]}).skillspector_detail

    def test_risk_score_finding_is_do_not_install(self):
        r = self._security(findings=[_finding("skillspector_risk_score", message="aggregate risk score 64/100")])
        assert r.skillspector_detail

    def test_no_security_validator_is_not_checked(self):
        r = _parse_report(_report_json([]))
        assert not r.security_checked and not r.skillspector_detail

    def test_incomplete_security_check_is_flagged(self):
        r = self._security(status="incomplete")
        assert r.security_incomplete and r.security_checked

    def test_message_on_another_validator_is_ignored(self):
        r = _parse_report({"results": [{"validator": "PII Scan", "legacy": {
            "messages": ["skillspector risk score: 90/100 (CRITICAL)"]}}]})
        assert not r.skillspector_detail
