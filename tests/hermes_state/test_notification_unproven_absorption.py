"""Origin evidence for every absorbed constituent is required before relabeling a merge."""
import pytest

from agent.message_metadata import ABSORBED_MESSAGE_UIDS
from hermes_state import SessionDB
from tests.hermes_state.test_notification_display_identity import BODY, META, NUDGE, UID


@pytest.mark.parametrize('absorbed', ['missing', 'plain-human'])
def test_missing_or_unclassified_absorbed_copy_cannot_authorize_notice_recovery(tmp_path, absorbed):
    db = SessionDB(tmp_path / 'state.db')
    try:
        db.create_session('pipeline', source='cli')
        db.append_message('pipeline', 'user', BODY, message_uid=UID, timestamp=1793910273.234522,
                          display_kind='process_complete', display_metadata=META)
        message = db.get_messages_as_conversation('pipeline', repair_alternation=False)[0]
        message.pop('display_kind', None)
        message.pop('display_metadata', None)
        message['content'] += NUDGE
        message[ABSORBED_MESSAGE_UIDS] = [absorbed]
        if absorbed == 'plain-human':
            db.append_message('pipeline', 'user', NUDGE.strip(), message_uid=absorbed)
        db.replace_messages('pipeline', [message], archive_dropped=True)
        assert not db.get_messages('pipeline')[0].get('display_kind')
    finally:
        db.close()
