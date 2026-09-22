"""Two lifecycle invariants, using real SQLite and a local GitHub HTTP contract."""
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from hermes_cli import kanban_db as kb
from hermes_cli.kanban_db_connect import connect


@pytest.fixture
def github(tmp_path, monkeypatch):
    state = {"conclusion": "success", "head": "a" * 40, "reads": 0, "requests": [],
             "no_protection": False, "rules_status": 200, "single_run": False}

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            state["requests"].append(self.path)
            sha = state["head"]
            if self.path == "/graphql":
                protection = None if state.get("no_protection") else {"requiredStatusChecks": [
                    {"context": "required", "app": {"databaseId": 1}}]}
                value = {"data": {"repository": {"pullRequest": {
                    "headRefOid": sha, "baseRefName": "main", "state": "OPEN",
                    "baseRef": {"branchProtectionRule": protection}}}}}
            elif "/rules/branches/" in self.path:
                if state.get("rules_status", 200) != 200:
                    self.send_error(state["rules_status"])
                    return
                value = state.get("rules", [[]])
            elif "/check-runs" in self.path:
                run = {"id": 42, "name": "required", "head_sha": sha,
                       "app": {"id": 1}, "status": "in_progress" if state["conclusion"] == "pending" else "completed", "conclusion": state["conclusion"],
                       "html_url": "https://github.com/acme/repo/actions/runs/42"}
                if state.get("stale"):
                    run["head_sha"] = "b" * 40
                runs = [] if state.get("missing") else [run]
                if state.get("single_run"):
                    value = [{"total_count": len(runs), "check_runs": runs}]
                else:
                    value = [{"total_count": 100 + len(runs), "check_runs": [
                        {**run, "id": 1000 + i, "name": "optional", "conclusion": "skipped"}
                        for i in range(100)]}, {"total_count": 100 + len(runs), "check_runs": runs}]
                if state.get("race"):
                    state["race"]()
                if state.get("head_change"):
                    state["head"] = "b" * 40
            elif "/statuses" in self.path:
                value = [[]]
            elif "/pulls/" in self.path:
                value = {"head": {"sha": sha}, "base": {"ref": "main"}, "state": "open"}
            else:
                self.send_error(404)
                return
            self.send_response(200)
            self.end_headers()
            self.wfile.write(json.dumps(value).encode())

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    shim = tmp_path / "bin"
    shim.mkdir()
    gh = shim / "gh"
    gh.write_text(f"#!{sys.executable}\nimport sys,os,urllib.request,urllib.error\n"
                  "path=sys.argv[2]\n"
                  "if 'rules/branches' in path and os.environ.get('PR_ACCEPTANCE_FORCE_RULES_INFRA'):\n"
                  "    sys.stderr.write('gh: Could not resolve host: github.com\\n')\n"
                  "    sys.exit(1)\n"
                  f"u='http://127.0.0.1:{server.server_port}/'+path\n"
                  "try:\n"
                  "    print(urllib.request.urlopen(u).read().decode())\n"
                  "except urllib.error.HTTPError as e:\n"
                  "    sys.stderr.write('gh: request failed (HTTP %d)\\n' % e.code)\n"
                  "    sys.exit(1)\n")
    gh.chmod(0o755)
    monkeypatch.setenv("PATH", str(shim) + os.pathsep + os.environ["PATH"])
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "home"))
    kb.init_db()
    try:
        yield state
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


@pytest.mark.linux_only
def test_pr_completion_requires_current_required_evidence(github):
    with connect() as conn:
        for conclusion in ("failure", "pending", "cancelled", "timed_out", "action_required", "neutral", "skipped", None, "success"):
            github.update(conclusion=conclusion, head="a" * 40)
            tid = kb.create_task(conn, title="Publish", completion_contract="acme/repo")
            ok = kb.complete_task(conn, tid, metadata={"published_pr": "https://github.com/acme/repo/pull/7"})
            assert ok is (conclusion == "success")
            task = kb.get_task(conn, tid)
            assert (task.status == "done") is ok
            receipts = [json.loads(r[0]) for r in conn.execute(
                "SELECT payload FROM task_events WHERE task_id=? AND kind='pr_acceptance'", (tid,))]
            assert receipts and receipts[-1]["head_sha"] == "a" * 40
            if not ok:
                assert task.status in {"running", "ready", "blocked", "review"}
                assert "retry" in receipts[-1]["recovery"]
                assert receipts[-1]["checks"][0]["id"] == 42
        for fault in ("missing", "stale", "head_change"):
            github.update(conclusion="success", head="a" * 40)
            github[fault] = True
            tid = kb.create_task(conn, title=fault, completion_contract="acme/repo")
            assert not kb.complete_task(conn, tid, metadata={"published_pr": "https://github.com/acme/repo/pull/7"})
            assert kb.get_task(conn, tid).status != "done"
            github.pop(fault)
        # Omission and a sibling repository cannot downgrade the stored declaration.
        tid = kb.create_task(conn, title="publish", completion_contract="acme/repo")
        assert not kb.complete_task(conn, tid, summary="local green")
        assert not kb.complete_task(conn, tid, metadata={"published_pr": "https://github.com/other/repo/pull/7"})
        before = len(github["requests"])
        local = kb.create_task(conn, title="local", completion_contract="local-only")
        assert kb.complete_task(conn, local, summary="https://github.com/acme/repo/pull/7 is background context")
        assert len(github["requests"]) == before


@pytest.mark.linux_only
def test_acceptance_receipts_and_terminal_write_share_run_ownership(github):
    with connect() as conn:
        for conclusion in ("success", "failure"):
            tid = kb.create_task(conn, title="race", completion_contract="acme/repo")
            owner = kb.claim_task(conn, tid)
            run_id = owner.current_run_id
            def reclaim():
                with connect() as rival:
                    assert kb.block_task(rival, tid, reason="Reassigned during acceptance")
                    assert kb.unblock_task(rival, tid)
                    github["replacement"] = kb.claim_task(rival, tid).current_run_id
            github.update(conclusion=conclusion, race=reclaim)
            assert not kb.complete_task(conn, tid, expected_run_id=run_id,
                metadata={"published_pr": "https://github.com/acme/repo/pull/7"})
            assert kb.get_task(conn, tid).current_run_id == github["replacement"]
            assert github["replacement"] != run_id
            assert kb.get_task(conn, tid).status != "done"
            assert conn.execute("SELECT count(*) FROM task_events WHERE task_id=? AND kind='pr_acceptance'", (tid,)).fetchone()[0] == 0
            github.pop("race")


@pytest.mark.linux_only
def test_rules_403_falls_back_to_exact_head_check_runs(github):
    """Private repo, no readable rulesets (403) and no classic branch protection:
    acceptance is decided by every check-run at the exact head, not by
    'no repository-required checks configured'."""
    github["no_protection"] = True
    github["rules_status"] = 403
    github["single_run"] = True
    with connect() as conn:
        # 1. exact head has a successful check-run -> completes.
        github.update(conclusion="success", head="a" * 40)
        tid = kb.create_task(conn, title="green", completion_contract="acme/repo")
        assert kb.complete_task(conn, tid, metadata={"published_pr": "https://github.com/acme/repo/pull/7"})
        receipt = json.loads(conn.execute(
            "SELECT payload FROM task_events WHERE task_id=? AND kind='pr_acceptance' ORDER BY id DESC",
            (tid,)).fetchone()[0])
        assert receipt["ok"] is True
        assert receipt["acceptance_rule"] == "exact_head_all_check_runs"
        assert receipt["rules_readable"] is False

        # 2. exact head has no check-run at all -> cannot complete.
        github.update(conclusion="success", head="a" * 40)
        github["missing"] = True
        tid = kb.create_task(conn, title="no-runs", completion_contract="acme/repo")
        assert not kb.complete_task(conn, tid, metadata={"published_pr": "https://github.com/acme/repo/pull/7"})
        assert kb.get_task(conn, tid).status != "done"
        github.pop("missing")

        # 3. exact head has a failing check-run -> cannot complete.
        github.update(conclusion="failure", head="a" * 40)
        tid = kb.create_task(conn, title="red", completion_contract="acme/repo")
        assert not kb.complete_task(conn, tid, metadata={"published_pr": "https://github.com/acme/repo/pull/7"})
        assert kb.get_task(conn, tid).status != "done"

        # 4. the check-run belongs to a different SHA than the exact head -> cannot complete.
        github.update(conclusion="success", head="a" * 40)
        github["stale"] = True
        tid = kb.create_task(conn, title="stale-run", completion_contract="acme/repo")
        assert not kb.complete_task(conn, tid, metadata={"published_pr": "https://github.com/acme/repo/pull/7"})
        assert kb.get_task(conn, tid).status != "done"
        github.pop("stale")


@pytest.mark.linux_only
def test_rules_403_is_distinguished_from_genuine_infra_failure(github, monkeypatch):
    """A 403/404 reading the rulesets endpoint means 'no rulesets readable' and
    is not classification=infra when the repo has branch protection to fall back
    on. A real auth/network failure (any other non-2xx from gh) must still
    classify infra."""
    with connect() as conn:
        # Branch protection exists; 403 on rules/branches is a benign "not readable".
        github["rules_status"] = 403
        github.update(conclusion="success", head="a" * 40)
        tid = kb.create_task(conn, title="rules-403-with-protection", completion_contract="acme/repo")
        assert kb.complete_task(conn, tid, metadata={"published_pr": "https://github.com/acme/repo/pull/7"})
        receipt = json.loads(conn.execute(
            "SELECT payload FROM task_events WHERE task_id=? AND kind='pr_acceptance' ORDER BY id DESC",
            (tid,)).fetchone()[0])
        assert receipt["classification"] == "success"
        assert receipt["rules_readable"] is False

        # A genuine gh failure on the same endpoint (non-HTTP, e.g. network/auth)
        # must still classify infra and must not silently fall back.
        github["rules_status"] = 200
        monkeypatch.setenv("PR_ACCEPTANCE_FORCE_RULES_INFRA", "1")
        tid = kb.create_task(conn, title="rules-network-failure", completion_contract="acme/repo")
        assert not kb.complete_task(conn, tid, metadata={"published_pr": "https://github.com/acme/repo/pull/7"})
        receipt = json.loads(conn.execute(
            "SELECT payload FROM task_events WHERE task_id=? AND kind='pr_acceptance' ORDER BY id DESC",
            (tid,)).fetchone()[0])
        assert receipt["classification"] == "infra"
        monkeypatch.delenv("PR_ACCEPTANCE_FORCE_RULES_INFRA", raising=False)
