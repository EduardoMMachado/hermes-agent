"""Notification authorship follows durable identity, never mutable prompt text."""

from copy import deepcopy
import json
from types import SimpleNamespace

import pytest

from agent.message_metadata import ABSORBED_MESSAGE_UIDS
from agent.context_compressor import MODEL_ONLY_DISPLAY_METADATA_KEY
from hermes_state import SessionDB

UID = "b11045929f4b49c38df3ad625fa42e66"
META = {"gateway_input_owner": "8db40249-b9d3-5a6c-b57b-c91d486cc951",
        "display_text": "Background Process Finished: review.py"}
BODY = "[Internal process completion: proc_bd88eb9f7e17]"
NUDGE = "\n\n[System: Your previous response contained only internal reasoning and never produced a visible answer or tool call. Do not keep thinking. Produce your final answer as plain text now (or make the tool call you were planning).]"


@pytest.fixture
def db(tmp_path):
    store = SessionDB(tmp_path / "state.db")
    store.create_session("pipeline", source="cli")
    yield store
    store.close()


def seed(db, kind="process_complete", metadata=None):
    return db.append_message("pipeline", "user", BODY, message_uid=UID,
                             timestamp=1793910273.234522, display_kind=kind,
                             display_metadata=META if metadata is None else metadata)


def seed_nudge(db):
    return db.append_message("pipeline", "user", NUDGE.strip(),
                             message_uid="b165561c7def48e6af01431158e7ede1",
                             display_kind="internal_notification",
                             display_metadata={MODEL_ONLY_DISPLAY_METADATA_KEY: True})


def rewrite(db):
    msg = db.get_messages_as_conversation("pipeline", repair_alternation=False)[0]
    seed_nudge(db)
    msg.pop("display_kind", None)
    msg.pop("display_metadata", None)
    msg["content"] += NUDGE
    msg[ABSORBED_MESSAGE_UIDS] = ["b165561c7def48e6af01431158e7ede1"]
    return msg


@pytest.mark.parametrize("writer", ["replace", "archive_replace", "compact", "append"])
def test_rewritten_notification_keeps_authorship(db, writer):
    seed(db)
    msg = rewrite(db)
    if writer == "replace":
        db.replace_messages("pipeline", [msg])
    elif writer == "archive_replace":
        db.replace_messages("pipeline", [msg], archive_dropped=True)
    elif writer == "compact":
        db.archive_and_compact("pipeline", [msg], tail_count=1)
    else:
        # A restored composite without a physical address inserts a new version.
        msg.pop("_row_id", None)
        db.append_messages_batch("pipeline", [msg])
    durable = dict(db._read_one("SELECT * FROM messages WHERE session_id=? AND active=1 ORDER BY id DESC LIMIT 1", ("pipeline",)))
    assert durable["display_kind"] == "process_complete"
    assert json.loads(durable["display_metadata"]) == META
    result = db.get_messages("pipeline")[-1]
    assert result["display_kind"] == "process_complete"
    assert result["display_metadata"] == META
    assert result["content"] == BODY + NUDGE
    assert result["message_uid"] == UID
    assert json.loads(result["absorbed_message_uids"]) == msg[ABSORBED_MESSAGE_UIDS]


def legacy_loss(db):
    """Inactive authentic original and owned scaffolding, changed active copy, stable UID."""
    original = seed(db)
    nudge = seed_nudge(db)
    # Insert fixture directly: future writer fixes must not conceal historical read failures.
    def write(conn):
        conn.execute("UPDATE messages SET active=0 WHERE id IN (?,?)", (original, nudge))
        return conn.execute("INSERT INTO messages (session_id,role,content,timestamp,message_uid,"
                            "absorbed_message_uids,active,api_content,token_count) VALUES (?,?,?,?,?,?,1,?,?)",
                            ("pipeline", "user", BODY + NUDGE, 1793910273.234522, UID,
                             json.dumps(["b165561c7def48e6af01431158e7ede1"]), "exact API bytes", 17)).lastrowid
    return db._execute_write(write)


@pytest.mark.parametrize("reader", ["raw", "display", "resume", "conversation"])
def test_legacy_loss_recovers_on_read_without_db_or_prompt_mutation(db, reader):
    row_id = legacy_loss(db)
    before = dict(db._read_one("SELECT * FROM messages WHERE id=?", (row_id,)))
    if reader == "raw":
        rows = db.get_messages("pipeline")
    elif reader == "display":
        rows = db.get_messages("pipeline", include_compacted=True)
    elif reader == "resume":
        model, rows = db.get_resume_conversations("pipeline")
        assert model[0]["content"] == BODY + NUDGE
        assert model[0]["api_content"] == "exact API bytes"
    else:
        rows = db.get_messages_as_conversation("pipeline", repair_alternation=False)
    assert rows[0].get("display_kind") == "process_complete"
    assert rows[0]["display_metadata"] == META
    assert rows[0]["content"] == BODY + NUDGE
    after = dict(db._read_one("SELECT * FROM messages WHERE id=?", (row_id,)))
    # Display reads may lazily populate their existing index, never transcript payload.
    for key, value in before.items():
        if key not in {"display_order", "display_identity"}:
            assert after[key] == value, key


@pytest.mark.parametrize("conflict", ["kind", "owner", "timestamp", "role", "session", "absorbed"])
def test_conflicting_identity_never_reclassifies_user(db, conflict):
    row_id = legacy_loss(db)
    def change(conn):
        original = conn.execute("SELECT id FROM messages WHERE active=0").fetchone()[0]
        if conflict in {"kind", "owner"}:
            conn.execute("INSERT INTO messages (session_id,role,content,timestamp,message_uid,display_kind,display_metadata,active) "
                         "SELECT session_id,role,content,timestamp,message_uid,?,?,0 FROM messages WHERE id=?",
                         ("internal_notification" if conflict == "kind" else "process_complete",
                          json.dumps({**META, "gateway_input_owner": "different"}) if conflict == "owner" else json.dumps(META), original))
            return
        statements = {
            "timestamp": ("UPDATE messages SET timestamp=timestamp+1 WHERE id=?", (original,)),
            "role": ("UPDATE messages SET role='assistant' WHERE id=?", (original,)),
            "absorbed": ("UPDATE messages SET message_uid='human',absorbed_message_uids=? WHERE id=?", (json.dumps([UID]), row_id)),
        }
        conn.execute(*statements[conflict])
    if conflict == "session":
        db.create_session("other", source="cli")
        db._execute_write(lambda conn: conn.execute("UPDATE messages SET session_id='other' WHERE active=0"))
    else:
        db._execute_write(change)
    assert not db.get_messages("pipeline")[0].get("display_kind")


def test_human_identical_body_and_other_profile_stay_human(db, tmp_path):
    seed(db)
    db.append_message("pipeline", "assistant", "ack")
    db.append_message("pipeline", "user", BODY + NUDGE, timestamp=1793910273.234522)
    assert not db.get_messages("pipeline")[-1].get("display_kind")
    other = SessionDB(tmp_path / "other-profile" / "state.db")
    try:
        other.create_session("pipeline", source="cli")
        other.append_message("pipeline", "user", BODY, message_uid=UID, timestamp=1793910273.234522)
        assert not other.get_messages("pipeline")[0].get("display_kind")
    finally:
        other.close()


@pytest.mark.parametrize("kind", ["process_complete", "internal_notification", "async_delegation_complete"])
def test_real_alternation_merge_then_replacement_keeps_producer_kind(db, kind):
    from agent.agent_runtime_helpers import repair_message_sequence

    seed(db, kind=kind)
    seed_nudge(db)
    messages = db.get_messages_as_conversation("pipeline", repair_alternation=False)
    assert repair_message_sequence(None, messages) == 1
    assert len(messages) == 1
    assert messages[0]["message_uid"] == UID
    assert messages[0][ABSORBED_MESSAGE_UIDS]
    # The gateway stamps presentation after flush; an in-memory merge may never have seen it.
    messages[0].pop("display_kind", None)
    messages[0].pop("display_metadata", None)
    content = messages[0]["content"]
    db.replace_messages("pipeline", messages, archive_dropped=True)
    raw = dict(db._read_one("SELECT * FROM messages WHERE session_id='pipeline' AND active=1"))
    assert raw["display_kind"] == kind
    assert json.loads(raw["display_metadata"]) == META
    assert raw["content"] == content
    assert db.get_resume_conversations("pipeline")[1][0]["display_kind"] == kind


def test_readonly_reopen_recovers_without_any_writes(db):
    row_id = legacy_loss(db)
    reader = SessionDB(db.db_path, read_only=True)
    try:
        assert reader.get_resume_conversations("pipeline")[1][0]["display_metadata"] == META
        assert reader.get_messages("pipeline")[0]["display_kind"] == "process_complete"
        assert db._read_one("SELECT display_kind FROM messages WHERE id=?", (row_id,))[0] is None
    finally:
        reader.close()


def test_recovery_is_invisible_to_real_api_builder_and_token_estimator(db):
    from agent.model_metadata import estimate_messages_tokens_rough
    from agent.turn_context import build_api_messages

    legacy_loss(db)
    recovered = db.get_resume_conversations("pipeline")[0]
    without_display = deepcopy(recovered)
    for msg in without_display:
        msg.pop("display_kind", None)
        msg.pop("display_metadata", None)
    before = deepcopy(recovered)
    agent = SimpleNamespace(api_mode="chat_completions", ephemeral_system_prompt=None,
                            _compression_warning=None, _current_turn_timestamp=1793910304.0,
                            _copy_reasoning_content_for_api=lambda source, target: None,
                            _should_sanitize_tool_calls=lambda: False)
    def wire(messages):
        return build_api_messages(agent, messages, current_turn_user_idx=None,
                                  ext_prefetch_cache="", plugin_user_context="", moa_config=None,
                                  active_system_prompt="fixed cached system prompt")
    assert wire(recovered) == wire(without_display)
    assert wire(recovered)[0][-1]["content"] == "exact API bytes"
    assert estimate_messages_tokens_rough(recovered) == estimate_messages_tokens_rough(without_display)
    assert recovered == before


@pytest.mark.parametrize("row_address", [False, True])
def test_versioned_in_place_rewrite_preserves_late_producer_stamp(db, row_address):
    from agent.message_metadata import DB_ROW_SNAPSHOT
    from agent.transcript_repair import transcript_row_snapshot

    row_id = db.append_message("pipeline", "user", BODY, message_uid=UID, timestamp=1793910273.234522)
    original = dict(db._read_one("SELECT * FROM messages WHERE id=?", (row_id,)))
    msg = {"role": "user", "content": BODY + NUDGE, "message_uid": UID,
           "timestamp": original["timestamp"], DB_ROW_SNAPSHOT: transcript_row_snapshot(original)}
    if row_address:
        msg["_row_id"] = row_id
    assert db.set_latest_matching_message_display_kind("pipeline", role="user", content=BODY,
                                                      display_kind="process_complete", display_metadata=META)
    db.append_messages_batch("pipeline", [msg])
    stored = dict(db._read_one("SELECT * FROM messages WHERE id=?", (row_id,)))
    assert stored["display_kind"] == "process_complete"
    assert json.loads(stored["display_metadata"]) == META
    assert stored["content"] == BODY + NUDGE
    assert len(db.get_messages("pipeline", include_inactive=True)) == 1


def test_duplicate_uid_with_untyped_wrong_role_fails_closed(db):
    legacy_loss(db)
    db.append_message("pipeline", "assistant", "collision", message_uid=UID, timestamp=1793910273.234522)
    assert not db.get_messages("pipeline")[0].get("display_kind")


def test_absorbed_conflicting_producer_and_malformed_metadata_fail_closed(db):
    row_id = legacy_loss(db)
    other_uid = "b165561c7def48e6af01431158e7ede1"
    db.append_message("pipeline", "user", "other producer", message_uid=other_uid,
                      display_kind="internal_notification", display_metadata={"display_text": "other"})
    assert not db.get_messages("pipeline")[0].get("display_kind")
    db._execute_write(lambda conn: conn.execute("UPDATE messages SET display_metadata='broken' WHERE active=0"))
    assert not db.get_messages("pipeline")[0].get("display_kind")
    assert db._read_one("SELECT content FROM messages WHERE id=?", (row_id,))[0] == BODY + NUDGE
