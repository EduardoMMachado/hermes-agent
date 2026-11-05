"""Five authenticated WebSocket clients must not let listing I/O block a prompt."""
import asyncio
from contextlib import AsyncExitStack
import json
from types import SimpleNamespace

import pytest

from tests.gateway.test_live_listing_shared_reads import blocked_read


@pytest.mark.asyncio
async def test_websocket_prompt_advances_while_four_pollers_share_blocked_sqlite(tmp_path, monkeypatch):
    import websockets
    from gateway.config import Platform
    from gateway.run import GatewayRunner
    from gateway.run_api import start_gateway_api, stop_gateway_api
    from gateway.session import SessionSource
    from gateway.session_authority import LiveSession, initialize_session_authority
    from gateway.session_controls import AuthorityConnection
    from hermes_cli import web_server

    monkeypatch.setenv('HERMES_HOME', str(tmp_path))
    runner = GatewayRunner()
    started, finish = asyncio.Event(), asyncio.Event()

    async def handle(event):
        started.set()
        await finish.wait()
        return event.text

    monkeypatch.setattr(runner, '_handle_message', handle)
    authority = await initialize_session_authority(runner, profile_id='default', instance_id='ws-poll-test')
    for sid in ('chat', 'other'):
        authority.db.create_session(sid, source='telegram')
        authority.sessions[sid] = LiveSession(SessionSource(platform=Platform.TELEGRAM, chat_id=sid), sid)

    entered = asyncio.Event()
    polling = set()
    original = AuthorityConnection.dispatch

    async def dispatch(connection, request):
        if str(request.get('id', '')).startswith('poll-'):
            polling.add(request['id'])
            if len(polling) == 4:
                entered.set()
        return await original(connection, request)

    monkeypatch.setattr(AuthorityConnection, 'dispatch', dispatch)

    async def reply(socket, request_id):
        async with asyncio.timeout(15):
            while True:
                frame = json.loads(await socket.recv())
                if frame.get('id') == request_id:
                    return frame

    api = await start_gateway_api(runner)
    try:
        port = api.socket.getsockname()[1]
        url = f'ws://127.0.0.1:{port}/api/ws?token={web_server._SESSION_TOKEN}'
        async with AsyncExitStack() as stack:
            sockets = [await stack.enter_async_context(websockets.connect(url)) for _ in range(5)]
            await sockets[4].send(json.dumps({'jsonrpc': '2.0', 'id': 'resume', 'method': 'session.resume',
                                              'params': {'session_id': 'chat'}}))
            resumed = await reply(sockets[4], 'resume')
            assert 'result' in resumed, resumed
            with blocked_read(SimpleNamespace(db=authority.db), monkeypatch) as blocked:
                polls = []
                for index, socket in enumerate(sockets[:4]):
                    request_id = f'poll-{index}'
                    method = 'session.list' if index % 2 == 0 else 'session.active_list'
                    await socket.send(json.dumps({'jsonrpc': '2.0', 'id': request_id, 'method': method, 'params': {}}))
                    polls.append(asyncio.create_task(reply(socket, request_id)))
                try:
                    await asyncio.wait_for(blocked.entered.wait(), 10)
                    await asyncio.wait_for(entered.wait(), 10)
                    await sockets[4].send(json.dumps({'jsonrpc': '2.0', 'id': 'prompt', 'method': 'prompt.submit',
                        'params': {'session_id': 'chat', 'input_id': 'websocket-polling', 'text': 'admit while polling'}}))
                    accepted = await asyncio.wait_for(reply(sockets[4], 'prompt'), 10)
                    assert 'result' in accepted, accepted
                    await asyncio.wait_for(started.wait(), 10)
                    assert not any(poll.done() for poll in polls)
                    assert len(blocked.calls) == 1, blocked.calls
                finally:
                    blocked.release.set()
                    finish.set()
                    results = await asyncio.gather(*polls, return_exceptions=True)
                assert all(isinstance(result, dict) and 'result' in result for result in results), results
                assert len(blocked.queries) == 2, blocked.queries
    finally:
        finish.set()
        tasks = [live.task for live in authority.sessions.values() if live.task is not None]
        if tasks:
            await asyncio.gather(*tasks)
        await stop_gateway_api(api)
