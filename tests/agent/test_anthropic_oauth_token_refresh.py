"""A Claude Code subscription token is refreshed mid-session; the client must follow it.

The access token lives ~8h and `claude` rewrites ~/.claude/.credentials.json on its own
schedule. The Anthropic SDK freezes `auth_token` at construction, so a long session kept
presenting the token it started with and the API answered 401 "OAuth access token has been
revoked" — which reads like a sign-out but only means "stale". Retrying appeared to fix it
because some attempt eventually ran against a rebuilt client.
"""
import httpx
import pytest

from agent.anthropic_adapter import build_anthropic_client

NATIVE = "https://api.anthropic.com"
FOUNDRY = "https://example.services.ai.azure.com/anthropic"


def _stub_transport(seen):
    class Stub(httpx.BaseTransport):
        def handle_request(self, request):
            seen.append(request.headers.get("authorization", ""))
            return httpx.Response(
                200,
                json={
                    "id": "msg_1",
                    "type": "message",
                    "role": "assistant",
                    "content": [{"type": "text", "text": "ok"}],
                    "model": "claude-opus-5",
                    "stop_reason": "end_turn",
                    "usage": {"input_tokens": 1, "output_tokens": 1},
                },
                request=request,
            )

    return Stub()


def _headers(client):
    return {k.lower(): v for k, v in (client.default_headers or {}).items()}


def test_a_refreshed_token_reaches_the_next_request():
    """The regression: one client, two requests, a refresh in between."""
    current = {"token": "sk-ant-oat01-first"}
    client = build_anthropic_client(lambda: current["token"], base_url=NATIVE)
    sent: list[str] = []
    client._client._transport = _stub_transport(sent)

    client.messages.create(model="claude-opus-5", max_tokens=8, messages=[{"role": "user", "content": "hi"}])
    current["token"] = "sk-ant-oat01-second"  # `claude` refreshed the credential on disk
    client.messages.create(model="claude-opus-5", max_tokens=8, messages=[{"role": "user", "content": "hi"}])

    assert sent == ["Bearer sk-ant-oat01-first", "Bearer sk-ant-oat01-second"]


def test_the_token_is_minted_per_request_not_at_construction():
    calls = {"n": 0}

    def provider():
        calls["n"] += 1
        return "sk-ant-oat01-x"

    client = build_anthropic_client(provider, base_url=NATIVE)
    assert calls["n"] == 0, "constructing the client must not consume a token"

    client._client._transport = _stub_transport([])
    client.messages.create(model="claude-opus-5", max_tokens=8, messages=[{"role": "user", "content": "hi"}])
    assert calls["n"] == 1


def test_a_per_request_oauth_client_carries_the_claude_code_identity():
    """Anthropic routes OAuth by user-agent and betas; without them the API 500s.

    The static path sets these, and the per-request path must not be the one that drops
    them — that trade would swap a 401 for an intermittent 500.
    """
    headers = _headers(build_anthropic_client(lambda: "sk-ant-oat01-x", base_url=NATIVE))

    assert headers.get("x-app") == "cli"
    assert headers.get("user-agent", "").startswith("claude-code/")
    assert "oauth-2025-04-20" in headers.get("anthropic-beta", "")
    assert "claude-code-20250219" in headers.get("anthropic-beta", "")


def test_entra_id_on_foundry_keeps_its_own_identity():
    """The other caller of this path must not be handed Anthropic's OAuth identity."""
    client = build_anthropic_client(lambda: "entra-jwt", base_url=FOUNDRY)
    headers = _headers(client)

    assert headers.get("x-app") is None
    assert not headers.get("user-agent", "").startswith("claude-code/")
    assert client.auth_token == "entra-id-bearer-via-http-hook"


@pytest.mark.parametrize("base_url", [NATIVE, FOUNDRY])
def test_only_one_credential_header_is_sent(base_url):
    """Dual auth leaks a foreign credential to the endpoint (#26970, #105774)."""
    client = build_anthropic_client(lambda: "token", base_url=base_url)
    sent: list[str] = []
    client._client._transport = _stub_transport(sent)

    captured = {}

    class Recorder(httpx.BaseTransport):
        def handle_request(self, request):
            captured.update({k.lower(): v for k, v in request.headers.items()})
            return _stub_transport([]).handle_request(request)

    client._client._transport = Recorder()
    client.messages.create(model="claude-opus-5", max_tokens=8, messages=[{"role": "user", "content": "hi"}])

    assert "authorization" in captured
    assert "x-api-key" not in captured
