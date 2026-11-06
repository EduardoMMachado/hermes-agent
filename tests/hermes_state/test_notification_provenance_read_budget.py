"""Notification provenance must not add a database round trip per human message."""
import pytest

from hermes_state import SessionDB
from tests.hermes_state.test_notification_display_identity import BODY, META, NUDGE, UID, legacy_loss


@pytest.mark.parametrize('operation', ['read', 'rewrite'])
def test_history_recovers_notice_without_per_message_provenance_queries(tmp_path, operation):
    db = SessionDB(tmp_path / 'state.db')
    try:
        db.create_session('pipeline', source='cli')
        legacy_loss(db)
        db.append_messages_batch('pipeline', [
            {'role': 'user', 'content': f'Human message {index}', 'message_uid': f'human-{index}'}
            for index in range(600)
        ])
        messages = db.get_messages_as_conversation('pipeline', repair_alternation=False)
        if operation == 'rewrite':
            for message in messages:
                message['content'] += ' revised'
        queries = []
        with db._read_ctx() as connection:
            connection.set_trace_callback(queries.append)
        db._execute_write(lambda connection: connection.set_trace_callback(queries.append))
        try:
            if operation == 'rewrite':
                db.replace_messages('pipeline', messages, archive_dropped=True)
            rows = db.get_messages('pipeline')
        finally:
            with db._read_ctx() as connection:
                connection.set_trace_callback(None)
            db._execute_write(lambda connection: connection.set_trace_callback(None))
        assert len(rows) == 601
        assert rows[0]['display_kind'] == 'process_complete'
        assert all(not row.get('display_kind') for row in rows[1:])
        selects = [query for query in queries if query.lstrip().upper().startswith('SELECT')]
        budget = 12 if operation == 'read' else 32
        assert len(selects) <= budget, f'{operation} issued {len(selects)} SELECTs for 601 messages'
    finally:
        db.close()


def test_new_producer_stamp_is_visible_to_later_copy_in_same_insert_batch(tmp_path):
    db = SessionDB(tmp_path / 'batch.db')
    try:
        db.create_session('pipeline', source='cli')
        db.append_messages_batch('pipeline', [
            {'role': 'user', 'content': BODY, 'message_uid': UID, 'timestamp': 1793910273.234522,
             'display_kind': 'process_complete', 'display_metadata': META},
            {'role': 'user', 'content': BODY + NUDGE, 'message_uid': UID, 'timestamp': 1793910273.234522}
        ])
        row = db._read_one('SELECT display_kind,display_metadata FROM messages ORDER BY id DESC LIMIT 1')
        assert row is not None
        assert row['display_kind'] == 'process_complete'
        assert db._decode_display_metadata(row['display_metadata']) == META
    finally:
        db.close()
