"""Generated retry scaffolding has producer-owned provenance, unlike a human quote."""
from agent.context_compressor import MODEL_ONLY_DISPLAY_METADATA_KEY
from agent.conversation_loop import _CODEX_INCOMPLETE_NUDGE
from tests.agent.test_codex_reasoning_only_streak import _drive
from tests.agent.test_run_agent_codex_responses import (
    _build_agent, _codex_message_response, _codex_reasoning_only_response,
)


def test_reasoning_only_retry_marks_its_own_nudge_without_classifying_the_human(monkeypatch):
    agent = _build_agent(monkeypatch)
    _drive(agent, monkeypatch, [
        _codex_reasoning_only_response(encrypted_content='first'),
        _codex_reasoning_only_response(encrypted_content='second'),
        _codex_message_response('Recovered.'),
    ])
    result = agent.run_conversation('Please explain the retry.')
    assert result['final_response'] == 'Recovered.'
    generated = [message for message in agent._session_messages if message.get('content') == _CODEX_INCOMPLETE_NUDGE]
    assert generated
    assert all(message.get('display_kind') == 'internal_notification' for message in generated)
    assert all(message.get('display_metadata', {}).get(MODEL_ONLY_DISPLAY_METADATA_KEY) is True for message in generated)
    human = next(message for message in agent._session_messages if message.get('content') == 'Please explain the retry.')
    assert not human.get('display_kind')
