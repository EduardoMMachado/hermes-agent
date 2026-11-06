"""A notification followed by a genuine human request must not swallow that request."""
import pytest

from agent.agent_runtime_helpers import repair_message_sequence
from agent.context_compressor import MODEL_ONLY_DISPLAY_METADATA_KEY
from hermes_state import SessionDB
from tests.hermes_state.test_notification_display_identity import BODY, META, NUDGE, UID


@pytest.mark.parametrize('internal_followup', [False, True])
def test_recovery_distinguishes_human_followup_from_owned_model_only_nudge(tmp_path, internal_followup):
    db = SessionDB(tmp_path / 'state.db')
    try:
        db.create_session('pipeline', source='cli')
        db.append_message('pipeline', 'user', BODY, message_uid=UID, timestamp=1793910273.234522,
                          display_kind='process_complete', display_metadata=META)
        # Same text is deliberately ambiguous: only producer-owned metadata establishes origin.
        metadata = ({'display_kind': 'internal_notification',
                     'display_metadata': {MODEL_ONLY_DISPLAY_METADATA_KEY: True}}
                    if internal_followup else {})
        db.append_message('pipeline', 'user', NUDGE.strip(), **metadata)
        messages = db.get_messages_as_conversation('pipeline', repair_alternation=False)
        assert repair_message_sequence(None, messages) == 1
        messages[0].pop('display_kind', None)
        messages[0].pop('display_metadata', None)
        db.replace_messages('pipeline', messages, archive_dropped=True)
        result = db.get_messages('pipeline')[0]
        if internal_followup:
            assert result['display_kind'] == 'process_complete'
        else:
            assert not result.get('display_kind'), 'A real human continuation became an internal notice'
            assert NUDGE.strip() in result['content']
    finally:
        db.close()
