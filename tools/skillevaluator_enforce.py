#!/usr/bin/env python3
"""Opt-in enforcement of the SkillEvaluator Tier 1 ``security`` verdict on skill installs.

``skills.tier1_enforce`` (default **false**: the Tier 1 scan stays advisory, see ``skillevaluator_scan``)
refuses a skill install when the scan's SkillSpector static check says ``DO_NOT_INSTALL``. ``--force`` is the
reviewed exception; a forced install is written to the audit log with the verdict.

Fail closed: with enforcement on, a scan that cannot give a verdict (``skillevaluator`` missing, timed out,
crashed, unparseable, or its security check incomplete) also refuses the install. A gate that opens whenever
the scanner is absent is not a gate; ``--force`` covers the legitimate cases.
"""

from __future__ import annotations

import logging
from tools.skillevaluator_scan import Tier1Report

logger = logging.getLogger(__name__)

VERDICT_OK = "OK"
VERDICT_DO_NOT_INSTALL = "DO_NOT_INSTALL"
VERDICT_UNAVAILABLE = "SCAN_UNAVAILABLE"
VERDICT_INCOMPLETE = "SCAN_INCOMPLETE"

_FALSE = ("false", "0", "no", "off", "")


def tier1_enforce_enabled() -> bool:
    """``skills.tier1_enforce`` (default False). A config that cannot be read means "not enabled": the
    setting is opt-in, and an unreadable config breaks the install itself long before this matters."""
    try:
        from hermes_cli.config import load_config
        skills_cfg = load_config().get("skills") or {}
        value = skills_cfg.get("tier1_enforce", False) if isinstance(skills_cfg, dict) else False
        return value.strip().lower() not in _FALSE if isinstance(value, str) else bool(value)
    except Exception:  # health: allow BLE001 -- opt-in setting; unreadable config must not break installs
        logger.debug("tier1_enforce config unreadable; treating as off", exc_info=True)
        return False


def tier1_enforce_verdict(report: Tier1Report) -> tuple[str, str]:
    """``(verdict, detail)``; the install is allowed only for ``VERDICT_OK``."""
    if not report.available:
        return VERDICT_UNAVAILABLE, report.error or "scanner unavailable"
    if not report.security_checked:
        return VERDICT_INCOMPLETE, "the report has no security check"
    if report.security_incomplete:
        return VERDICT_INCOMPLETE, "the security check did not complete (is skillspector installed for skillevaluator?)"
    if report.skillspector_detail:
        return VERDICT_DO_NOT_INSTALL, f"SkillSpector static: {report.skillspector_detail}"
    return VERDICT_OK, ""


def tier1_block_message(identifier: str, verdict: str, detail: str) -> str:
    """User-facing refusal naming the cause and the reviewed exception."""
    if verdict == VERDICT_DO_NOT_INSTALL:
        why = f"the SkillEvaluator Tier 1 security check says DO_NOT_INSTALL for '{identifier}' ({detail})."
    else:
        why = (f"the SkillEvaluator Tier 1 scan could not give a verdict for '{identifier}' ({detail}), "
               "and `skills.tier1_enforce` refuses what it cannot check.")
    return (f"{why} To read the skill without installing, run `hermes skills inspect {identifier}`; "
            "after reviewing it, re-run with --force to install anyway, or set `skills.tier1_enforce: false`.")
