"""Exact-head GitHub acceptance for explicitly declared PR tasks.

Network work happens outside SQLite transactions. The lifecycle owner persists
receipts only after rechecking the captured run/status/contract under its lock.
"""
from __future__ import annotations

import json
import re
import subprocess
from urllib.parse import quote

_REPO = re.compile(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+")
_PR = re.compile(r"https://github\.com/([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)/pull/([1-9][0-9]*)")
_HTTP_STATUS = re.compile(r"\(HTTP (\d{3})\)")


class _GhHttpError(Exception):
    """A `gh api` call reached GitHub and got back a non-2xx HTTP status.

    Distinct from OSError/SubprocessError (gh missing, timeout, network down)
    and from ValueError/KeyError/TypeError (malformed/incomplete response):
    those are genuine infra failures. An HTTP status means GitHub answered —
    whether that answer counts as infra depends on the status and the caller.
    """

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


def validate_contract(value: str | None) -> str:
    if value is None or value == "local-only":
        return "local-only"
    if not isinstance(value, str) or not (_REPO.fullmatch(value) or _PR.fullmatch(value)):
        raise ValueError("completion_contract must be local-only, OWNER/REPO, or an exact GitHub PR URL")
    return value


def _api(endpoint: str, *, query: str | None = None, paginate: bool = False):
    command = ["gh", "api", endpoint, "--hostname", "github.com"]
    if query is not None:
        command += ["-f", "query=" + query]
    if paginate:
        command += ["--paginate", "--slurp"]
    result = subprocess.run(command, stdin=subprocess.DEVNULL, capture_output=True,
                            text=True, timeout=30)
    if result.returncode != 0:
        status_match = _HTTP_STATUS.search(result.stderr or "")
        if status_match:
            raise _GhHttpError(int(status_match.group(1)), "gh api returned an HTTP error")
        raise subprocess.CalledProcessError(result.returncode, command, result.stdout, result.stderr)
    value = json.loads(result.stdout)
    if isinstance(value, dict) and value.get("errors"):
        raise ValueError("GitHub returned incomplete GraphQL evidence")
    return value


def _finalize(receipt: dict, repo: str, number: int, sha: str, branch: str, outcomes: list) -> dict:
    # Re-read after all pages: old-head successes are never transferable.
    current = _api(f"repos/{repo}/pulls/{number}")
    if current["head"]["sha"] != sha or current["base"]["ref"] != branch or (current["state"] == "closed" and not current.get("merged")):
        receipt.update(classification="stale", detail="PR head/base changed while collecting evidence; retry.")
        return receipt
    receipt["classification"] = next((x for x in outcomes if x != "success"), "missing" if not outcomes else "success")
    receipt["ok"] = receipt["classification"] == "success"
    return receipt


def collect_acceptance(contract: str, published_pr: str | None) -> dict:
    receipt = {"ok": False, "classification": "missing", "head_sha": None,
               "pr_url": published_pr, "checks": [], "acceptance_rule": None,
               "recovery": "Fix required failures, rerun infrastructure checks or wait, then retry completion. "
                           "Use kanban_block if human input is needed; receipts remain on the task event log."}
    try:
        declared = _PR.fullmatch(contract)
        url = contract if declared else published_pr
        match = _PR.fullmatch(url or "")
        if not match or (not declared and match[1] != contract) or (declared and published_pr and published_pr != contract):
            receipt["detail"] = "Supply metadata.published_pr matching the persisted completion contract."
            return receipt
        repo, number = match[1], int(match[2])
        receipt["pr_url"] = url
        owner, name = repo.split("/")
        query = '''{repository(owner:%s,name:%s){pullRequest(number:%d){headRefOid baseRefName state
            baseRef{branchProtectionRule{requiredStatusChecks{context app{databaseId}}}}}}}''' % (
                json.dumps(owner), json.dumps(name), number)
        pr = _api("graphql", query=query)["data"]["repository"]["pullRequest"]
        sha, branch = pr["headRefOid"], pr["baseRefName"]
        receipt["head_sha"] = sha
        if not re.fullmatch(r"[0-9a-f]{40}", sha) or pr["state"] not in {"OPEN", "MERGED"}:
            raise ValueError("PR is closed or current head is unavailable")
        protection = (pr.get("baseRef") or {}).get("branchProtectionRule") or {}
        required = {(r["context"], (r.get("app") or {}).get("databaseId")) for r in protection.get("requiredStatusChecks", [])}
        # A 403/404 here means the repo's plan doesn't expose the rulesets API
        # (private repo without GitHub Pro/rulesets) — that is "no rulesets
        # readable", not an infra failure. Any other status (401, 5xx, ...) is
        # a genuine auth/availability problem and must still classify infra.
        rules_readable = True
        try:
            rules = _api(f"repos/{repo}/rules/branches/{quote(branch, safe='')}?per_page=100", paginate=True)
        except _GhHttpError as e:
            if e.status in (403, 404):
                rules = []
                rules_readable = False
            else:
                raise
        for page in rules:
            for rule in page:
                if rule["type"] == "required_status_checks":
                    required.update((r["context"], r.get("integration_id"))
                                    for r in rule["parameters"]["required_status_checks"])
        receipt["required"] = [{"context": c, "app_id": a} for c, a in sorted(required, key=str)]
        receipt["rules_readable"] = rules_readable
        if not required:
            if rules_readable:
                receipt["detail"] = "No repository-required checks are configured; explicitly use a local-only contract for non-CI tasks."
                return receipt
            # Fallback: no classic branch protection and no readable rulesets,
            # so there is no repository-required-checks evidence to collect.
            # The evidence that DOES exist is every check-run reported at the
            # exact head — accept only when all of them succeeded.
            receipt["acceptance_rule"] = "exact_head_all_check_runs"
            pages = _api(f"repos/{repo}/commits/{sha}/check-runs?per_page=100&filter=latest", paginate=True)
            runs = [run for page in pages for run in page["check_runs"]]
            if len({r["id"] for r in runs}) != pages[0]["total_count"]:
                raise ValueError("Incomplete check-run pagination")
            if not runs:
                receipt["detail"] = ("No repository-required checks are readable (rulesets API returned 403/404 "
                                      "and there is no classic branch protection) and no check-runs exist at the "
                                      "exact head; explicitly use a local-only contract for non-CI tasks.")
                receipt["classification"] = "missing"
                return receipt
            # A job disabled by `if:` at the workflow level produces no
            # evidence against this head either way — GitHub reports it as
            # skipped/neutral without ever running it. Under this fallback
            # (no repository-required checks exist to pin a context as
            # mandatory) such a check-run cannot be allowed to block
            # completion, or every future PR touching that workflow would be
            # stuck forever. It still must not be enough on its own: a head
            # where every check-run was skipped/neutral has no positive
            # evidence, so _finalize's "missing" default (empty outcomes)
            # applies. Anything else abnormal (failure, cancelled,
            # timed_out, action_required, stale, pending) is real negative
            # evidence and keeps blocking via the normal outcomes list.
            ignorable_fallback_outcomes = {"skipped", "neutral"}
            outcomes = []
            for run in runs:
                classification = _classify(run, sha, run.get("conclusion"), True)
                receipt["checks"].append({"name": run["name"], "id": run["id"],
                    "url": run.get("html_url") or run.get("target_url"),
                    "head_sha": run.get("head_sha", run.get("sha")),
                    "classification": classification, "conclusion": run.get("conclusion")})
                if classification not in ignorable_fallback_outcomes:
                    outcomes.append(classification)
            return _finalize(receipt, repo, number, sha, branch, outcomes)
        receipt["acceptance_rule"] = "repository_required_checks"
        pages = _api(f"repos/{repo}/commits/{sha}/check-runs?per_page=100&filter=latest", paginate=True)
        runs = [run for page in pages for run in page["check_runs"]]
        if len({r["id"] for r in runs}) != pages[0]["total_count"]:
            raise ValueError("Incomplete check-run pagination")
        statuses = [{**s, "sha": sha} for page in _api(f"repos/{repo}/commits/{sha}/statuses?per_page=100", paginate=True) for s in page]
        outcomes = []
        for context, app_id in sorted(required, key=str):
            matching = [r for r in runs if r["name"] == context and
                        (app_id in (None, -1) or r["app"]["id"] == app_id)]
            # A legacy status can satisfy an unpinned context, but never a check pinned to an app.
            legacy = [s for s in statuses if s["context"] == context] if app_id in (None, -1) else []
            selected = matching + ([max(legacy, key=lambda s: s["id"])] if legacy else [])
            if not selected:
                outcomes.append("missing")
                receipt["checks"].append({"name": context, "classification": "missing", "head_sha": sha})
            for check in selected:
                is_run = "conclusion" in check
                outcome = check.get("conclusion") if is_run else check["state"]
                classification = _classify(check, sha, outcome, is_run)
                outcomes.append(classification)
                receipt["checks"].append({"name": context, "id": check["id"],
                    "url": check.get("html_url") or check.get("target_url"),
                    "head_sha": check.get("head_sha", check.get("sha")),
                    "classification": classification, "conclusion": outcome})
        return _finalize(receipt, repo, number, sha, branch, outcomes)
    except (OSError, subprocess.SubprocessError, ValueError, KeyError, TypeError, IndexError, _GhHttpError):
        # Never persist gh stderr (credentials/host details); the failed phase is actionable.
        receipt.update(classification="infra", detail="GitHub acceptance evidence unavailable or incomplete; check gh authentication/API access and retry.")
        return receipt


def _classify(check: dict, sha: str, outcome: str | None, is_run: bool) -> str:
    if check.get("head_sha", check.get("sha")) != sha:
        return "stale"
    if is_run and check.get("status") != "completed":
        return "pending"
    # skipped/neutral get their own names (not lumped into "infra") so the
    # exact_head_all_check_runs fallback can tell "this job produced no
    # evidence" apart from a genuine infra-classified outcome. The
    # repository_required_checks path still blocks on them: they are simply
    # not "success", and _finalize takes the first non-success outcome.
    mapping: dict[str, str] = {"success": "success", "failure": "failure", "error": "infra",
                                "pending": "pending", "skipped": "skipped", "neutral": "neutral"}
    return mapping.get(outcome or "", "infra")
