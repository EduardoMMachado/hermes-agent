"""Durable message-identity columns for SessionDB (schema v31): the codec between the live identity keys
(``agent.message_metadata``) and the ``message_uid`` / ``absorbed_message_uids`` / ``tool_call_uids`` /
``tool_call_uid`` columns, shared by the transcript writers, restore, and transcript repair."""

from __future__ import annotations

import json
from typing import Any, Dict, List, Mapping, MutableMapping, Optional, Tuple

from agent.message_metadata import ABSORBED_MESSAGE_UIDS, MESSAGE_UID, TOOL_CALL_UID, TOOL_CALL_UIDS, uid_list
from agent.message_sanitization import coalesce_tool_call_id
from hermes_state_common import _json_or


def _live_or_column(msg: Mapping[str, Any], live_key: str, column: str) -> Any:
    """Flushed dicts and batch rows carry the live key; import payloads carry the column name."""
    return msg.get(live_key) if live_key in msg else msg.get(column)


def _uid_list(value: Any) -> list[str]:
    """Normalize a uid list (a live list, or the JSON text an export/import carries) to unique non-empty
    strings in order; anything else is ``[]``."""
    if isinstance(value, str):
        value = _json_or(value, [], "Failed to deserialize a message uid list, falling back to []")
    return uid_list(value)


def _uid_map(value: Any) -> dict[str, Any]:
    """Normalize a ``{tool call id: uid}`` map (a live dict, or the JSON text an export/import carries): a
    non-empty string uid, or a list of them for a provider id repeated inside one row (one per occurrence,
    see ``merge_tool_call_uids``); anything else is dropped, and a non-map is ``{}``."""
    if isinstance(value, str):
        value = _json_or(value, {}, "Failed to deserialize a tool-call uid map, falling back to {}")
    if not isinstance(value, dict):
        return {}
    return {k: v for k, v in value.items() if isinstance(k, str) and k and (
        (isinstance(v, str) and v) or (isinstance(v, list) and v and all(isinstance(u, str) and u for u in v)))}


def _tool_call_uid_map(msg: Mapping[str, Any]) -> dict[str, Any]:
    return _uid_map(_live_or_column(msg, TOOL_CALL_UIDS, "tool_call_uids"))


def _absorbed_uids_json(msg: Mapping[str, Any]) -> Optional[str]:
    uids = _uid_list(_live_or_column(msg, ABSORBED_MESSAGE_UIDS, "absorbed_message_uids"))
    return json.dumps(uids) if uids else None


def _tool_call_uids_json(msg: Mapping[str, Any]) -> Optional[str]:
    uids = _tool_call_uid_map(msg)
    return json.dumps(uids, sort_keys=True) if uids else None


def _tool_call_uid_or_none(msg: Mapping[str, Any]) -> Optional[str]:
    uid = _live_or_column(msg, TOOL_CALL_UID, "tool_call_uid")
    return uid if isinstance(uid, str) and uid else None


def _live_extends(live_uid: Any, stored_uid: Any) -> bool:
    """A live per-occurrence list that starts with every stored occurrence: a fold's union not yet written."""
    stored = stored_uid if isinstance(stored_uid, list) else [stored_uid]
    return isinstance(live_uid, list) and live_uid[:len(stored)] == stored


def _fill_missing_tool_call_uids(row: Any, msg: MutableMapping[str, Any]) -> None:
    """Before a row-addressed rewrite serializes *msg*: stored uids for calls it still names but whose uid it
    lost (a clone), so the rewrite does not null them. A call the live dict dropped keeps no uid."""
    if not row["tool_call_uids"] or not isinstance(calls := msg.get("tool_calls"), list):
        return
    live = msg.get(TOOL_CALL_UIDS)
    live = live if isinstance(live, dict) else {}
    named = {coalesce_tool_call_id(tc) for tc in calls}
    if missing := {k: v for k, v in _uid_map(row["tool_call_uids"]).items() if k in named and k not in live}:
        msg[TOOL_CALL_UIDS] = {**live, **missing}


def _restore_row_identity(row: Any, msg: MutableMapping[str, Any]) -> None:
    """A stored row's uid and tool-call uids onto its live dict (the stored value wins). A live per-occurrence
    list that already holds the stored uid is kept: it is a fold's union the row has not been rewritten
    with yet, and replacing it with the stored single uid would strip the later occurrence."""
    if row[MESSAGE_UID]:
        msg[MESSAGE_UID] = row[MESSAGE_UID]
    if row["tool_call_uids"] and (stored := _uid_map(row["tool_call_uids"])):
        live = msg.get(TOOL_CALL_UIDS)
        live = live if isinstance(live, dict) else {}
        msg[TOOL_CALL_UIDS] = {**live, **{call_id: uid for call_id, uid in stored.items()
                                          if not _live_extends(live.get(call_id), uid)}}
    if row["tool_call_uid"]:
        msg[TOOL_CALL_UID] = row["tool_call_uid"]


def _restore_identity_columns(row: Any, msg: MutableMapping[str, Any]) -> None:
    """The stored identity columns onto a restored dict under their live keys (NULL/empty add nothing)."""
    _restore_row_identity(row, msg)
    if row["absorbed_message_uids"] and (absorbed := _uid_list(row["absorbed_message_uids"])):
        msg[ABSORBED_MESSAGE_UIDS] = absorbed


_NOTICE_DISPLAY_KINDS = frozenset({"process_complete", "internal_notification", "async_delegation_complete"})


_NOTICE_COPY_COLUMNS = ("message_uid", "role", "timestamp", "display_kind", "display_metadata")


def notification_display_copies(conn, session_id, messages):
    """Bound provenance I/O by UID batches, including inactive originals; never query per message.

    The existing UID index covers active rows only, so single-UID probes would repeatedly scan
    the session's archive. One bounded IN query serves every candidate and its conflict fence.
    """
    wanted = set()
    for msg in messages:
        uid = msg.get(MESSAGE_UID)
        if msg.get("role") != "user" or not isinstance(uid, str) or not uid:
            continue
        if msg.get("display_kind") is not None and msg["display_kind"] not in _NOTICE_DISPLAY_KINDS:
            continue
        wanted.add(uid)
        wanted.update(_uid_list(_live_or_column(msg, ABSORBED_MESSAGE_UIDS, "absorbed_message_uids")))
    copies = {}
    uids = sorted(wanted)
    for start in range(0, len(uids), 512):
        batch = uids[start:start + 512]
        placeholders = ",".join("?" for _ in batch)
        for row in conn.execute(
            f"SELECT {', '.join(_NOTICE_COPY_COLUMNS)} FROM messages "
            f"WHERE session_id = ? AND message_uid IN ({placeholders})", (session_id, *batch)):
            copies.setdefault(row[MESSAGE_UID], []).append(row)
    return copies


def remember_notification_display(copies, columns, values):
    """Keep the transaction-local snapshot current with rows inserted earlier in this batch."""
    row = dict(zip(columns, values))
    copies.setdefault(row[MESSAGE_UID], []).append({key: row[key] for key in _NOTICE_COPY_COLUMNS})


def _compatible_absorbed_notice(row, kind, metadata, decode_metadata):
    from agent.context_compressor import MODEL_ONLY_DISPLAY_METADATA_KEY

    if row["role"] != "user":
        return False
    peer_metadata = decode_metadata(row["display_metadata"])
    if row["display_kind"] == "internal_notification" and (peer_metadata or {}).get(MODEL_ONLY_DISPLAY_METADATA_KEY) is True:
        return True  # the producer, not the text, marks continuation scaffolding as non-human
    return row["display_kind"] == kind and peer_metadata == metadata


def restore_notification_display(copies, msg: MutableMapping[str, Any], decode_metadata) -> None:
    """Recover presentation from authentic copies of the FIRST constituent, never from prompt text.

    Stable UIDs name occurrences, including rewrites with changed bodies. Absorbed UIDs are only a
    conflict fence: inheriting solely from an absorbed notice would relabel a human merge survivor.
    Conflicting producer stamps, roles or timestamps fail closed. No payload field is changed.
    """
    uid = msg.get(MESSAGE_UID)
    if msg.get("role") != "user" or not isinstance(uid, str) or not uid:
        return
    kind = msg.get("display_kind")
    if kind is not None and kind not in _NOTICE_DISPLAY_KINDS:
        return
    rows = copies.get(uid, ())
    stamps = []
    for row in rows:
        if row["role"] != "user" or (msg.get("timestamp") is not None and msg["timestamp"] != row["timestamp"]):
            return
        if row["display_kind"] is None:
            continue  # missing stamps on rewritten copies are exactly what is being recovered
        metadata = decode_metadata(row["display_metadata"])
        if row["display_kind"] not in _NOTICE_DISPLAY_KINDS or metadata is None:
            return
        stamps.append((row["display_kind"], metadata, row["timestamp"]))
    if not stamps:
        return
    donor_kind, donor_meta, _timestamp = stamps[0]
    if any(stamp != stamps[0] for stamp in stamps[1:]) or (kind is not None and kind != donor_kind):
        return
    current = decode_metadata(msg.get("display_metadata"))
    if msg.get("display_metadata") is not None and current is None:
        return
    if any(key in donor_meta and donor_meta[key] != value for key, value in (current or {}).items()):
        return
    for absorbed in _uid_list(_live_or_column(msg, ABSORBED_MESSAGE_UIDS, "absorbed_message_uids")):
        if absorbed == uid:
            return  # malformed self-absorption is not evidence
        peers = copies.get(absorbed, ())
        if not peers or any(not _compatible_absorbed_notice(peer, donor_kind, donor_meta, decode_metadata) for peer in peers):
            return
    msg["display_kind"] = donor_kind
    msg["display_metadata"] = {**donor_meta, **(current or {})}


def notification_display_rows(db, rows, *, session_id=None):
    """Read-only presentation reconciliation shared by raw history and conversation projections.

    Same-session indexed UID lookups on THIS store handle inactive originals too. Copy rows only;
    neither the database nor caller-owned model messages are edited by a history read.
    """
    def read(conn):
        result = [dict(row) for row in rows]
        sessions = {}
        for msg in result:
            sessions.setdefault(msg.get("session_id", session_id), []).append(msg)
        for owner, messages in sessions.items():
            copies = notification_display_copies(conn, owner, messages)
            for msg in messages:
                if msg.get("role") == "user" and (msg.get("display_kind") is None or msg.get("display_metadata") is None):
                    restore_notification_display(copies, msg, db._decode_display_metadata)
        return result
    return db._read_retrying_ioerr(read)


def _stable_tool_key(row: Any) -> Optional[tuple[Any, ...]]:
    """Display-dedupe key of a tool-calling assistant row built from its stable call ids instead of the arguments a
    prune rewrites (#117750: a pruned carried-forward copy must collapse with its durable original). ``None`` for
    every other row and for an incomplete id set, so the caller keeps the full content key: a tool RESULT row keeps
    its payload in the key, because folding the archived full output into its pruned stub would drop the original
    from compacted history and transcript exports, and distinct id-less calls never merge."""
    if row["role"] != "assistant":
        return None
    calls = _json_or(row["tool_calls"] or "[]", [], "Failed to deserialize tool_calls, falling back to []")
    call_ids = tuple(coalesce_tool_call_id(tc) for tc in calls or ())
    if call_ids and all(call_ids):
        return ("assistant", None, row["timestamp"], row["tool_call_id"], call_ids, row["tool_name"])
    return None
