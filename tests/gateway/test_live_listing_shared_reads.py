"""Live RPC polls share only in-flight store facts, never authorization or live state."""
import asyncio
import contextlib
import json
import threading
from types import SimpleNamespace

import pytest
import pytest_asyncio


@pytest_asyncio.fixture
async def owner(tmp_path, monkeypatch):
    from gateway.config import GatewayConfig, Platform
    from gateway.session import SessionSource, SessionStore
    from gateway.session_authority import LiveSession, initialize_session_authority
    from gateway.session_controls import AuthorityConnection

    monkeypatch.setenv('HERMES_HOME', str(tmp_path))
    store = SessionStore(tmp_path / 'sessions', GatewayConfig())
    started, finish = asyncio.Event(), asyncio.Event()

    async def answer(event):
        started.set()
        await finish.wait()
        return event.text

    runner = SimpleNamespace(_session_db=store._db, session_store=store, _draining=False,
                             _handle_message=answer, _adapter_for_source=lambda source: None)
    authority = await initialize_session_authority(runner, profile_id='live', instance_id='owner')
    for sid in ('chat', 'other'):
        store._db.create_session(sid, source='telegram')
        authority.sessions[sid] = LiveSession(SessionSource(platform=Platform.TELEGRAM, chat_id=sid), sid)
    connection = AuthorityConnection(authority, object(), {'user_id': 'viewer'})
    from gateway.session_contract import SessionRef
    attached = await authority.attach(connection.actor, SessionRef('live', 'chat'), history=False)
    connection.subscriptions['chat'] = attached.subscription_id

    async def rpc(method, connection=connection, **params):
        return await connection.dispatch({'id': 1, 'method': method, 'params': params})

    yield SimpleNamespace(authority=authority, db=store._db, connection=connection, rpc=rpc,
                          started=started, finish=finish)
    finish.set()
    tasks = [live.task for live in authority.sessions.values() if live.task is not None]
    if tasks:
        await asyncio.gather(*tasks)


@contextlib.contextmanager
def blocked_read(owner, monkeypatch):
    """Block an actual listing read checkout, with a bounded off-thread deadlock escape on red."""
    from gateway import session_live_listing
    loop, loop_thread = asyncio.get_running_loop(), threading.get_ident()
    entered, release = asyncio.Event(), threading.Event()
    local = threading.local()
    original_facts, original_read = session_live_listing._store_facts, type(owner.db)._read_ctx
    calls, threads, queries = [], [], []

    class ReadConnection:
        def __init__(self, conn):
            self.conn = conn

        def execute(self, sql, *args):
            queries.append(sql)
            return self.conn.execute(sql, *args)

    def facts(db, batch):
        calls.append(tuple(batch))
        local.listing = True
        try:
            return original_facts(db, batch)
        finally:
            local.listing = False

    @contextlib.contextmanager
    def read(db, *args, **kwargs):
        if getattr(local, 'listing', False):
            threads.append(threading.get_ident())
            loop.call_soon_threadsafe(entered.set)
            assert release.wait(10), 'listing DB read was never released'
        with original_read(db, *args, **kwargs) as conn:
            yield ReadConnection(conn) if getattr(local, 'listing', False) else conn

    with monkeypatch.context() as patch:
        patch.setattr(session_live_listing, '_store_facts', facts)
        patch.setattr(type(owner.db), '_read_ctx', read)
        try:
            yield SimpleNamespace(entered=entered, release=release, calls=calls,
                                  threads=threads, queries=queries, loop_thread=loop_thread)
        finally:
            release.set()


@pytest.mark.asyncio
async def test_pollers_share_a_blocked_db_read_while_prompt_admission_advances(owner, monkeypatch):
    with blocked_read(owner, monkeypatch) as blocked:
        polls = [asyncio.create_task(owner.rpc(method)) for method in
                 ('session.list', 'session.active_list', 'session.list', 'session.active_list')]
        await asyncio.wait_for(blocked.entered.wait(), 5)
        # All four tasks have entered their production dispatch before this scheduled marker.
        marker = asyncio.Event()
        asyncio.get_running_loop().call_soon(marker.set)
        await marker.wait()
        try:
            reply = await asyncio.wait_for(owner.rpc('prompt.submit', session_id='chat',
                                                     submission_id='while-polling', text='hello'), 5)
            assert 'result' in reply, reply
            await asyncio.wait_for(owner.started.wait(), 5)
            assert not any(task.done() for task in polls)
        finally:
            blocked.release.set()
        results = await asyncio.gather(*polls)
        assert all('result' in reply for reply in results), results
        assert len(blocked.calls) == 1, blocked.calls
        assert len(blocked.queries) == 2, blocked.queries
        assert all(thread != blocked.loop_thread for thread in blocked.threads)


@pytest.mark.asyncio
async def test_cancelling_one_waiter_keeps_the_shared_read_and_drops_completed_results(owner, monkeypatch):
    with blocked_read(owner, monkeypatch) as blocked:
        first = asyncio.create_task(owner.rpc('session.list'))
        second = asyncio.create_task(owner.rpc('session.active_list'))
        await asyncio.wait_for(blocked.entered.wait(), 5)
        first.cancel()
        with pytest.raises(asyncio.CancelledError):
            await first
        blocked.release.set()
        assert 'result' in await second
        assert len(blocked.calls) == 1
        owner.db.set_session_hidden('other', True)
        reply = await owner.rpc('session.list')
        assert {row['id'] for row in reply['result']['sessions']} == {'chat'}
        assert len(blocked.calls) == 2  # no TTL or completed-result cache


@pytest.mark.asyncio
async def test_live_overlay_and_authorization_are_rechecked_after_the_read(owner, monkeypatch):
    from gateway.config import Platform
    from gateway.session import SessionSource
    with blocked_read(owner, monkeypatch) as blocked:
        poll = asyncio.create_task(owner.rpc('session.active_list'))
        await asyncio.wait_for(blocked.entered.wait(), 5)
        live = owner.authority.sessions['chat']
        with live.event_stream.lock:
            live.settling['settling'] = {'admission_id': 'settling', 'seq': 1, 'status': 'started'}
        monkeypatch.setattr(live.controls, 'snapshot', lambda *args: ({'kind': 'approval'},))
        # A handoff changed this live object's owner while the store read waited.
        other = owner.authority.sessions['other']
        other.source = SessionSource(platform=Platform.LOCAL, chat_id='other', user_id='someone-else')
        blocked.release.set()
        rows = {row['id']: row for row in (await poll)['result']['sessions']}
        assert rows['chat']['status'] == 'waiting'
        assert 'other' not in rows
        live.settling.clear()
        assert (await owner.rpc('session.active_list'))['result']['sessions'][0]['status'] == 'idle'


@pytest.mark.asyncio
async def test_history_mount_authorization_never_reads_sqlite_on_the_loop(owner, monkeypatch):
    from gateway.session_authority import LiveSession
    from hermes_state_mutation_binding import BINDING_PREFIX
    owner.db.create_session('imported', source='import')
    owner.db.set_meta(BINDING_PREFIX + 'imported', json.dumps(['live', owner.connection.actor.subject]))
    live = owner.authority.sessions['imported'] = LiveSession(None, 'history:imported')
    live.subscribers['reader'] = owner.connection.actor
    loop_thread, on_loop = threading.get_ident(), []
    original = type(owner.db)._read_ctx

    def read(db, *args, **kwargs):
        if threading.get_ident() == loop_thread:
            on_loop.append(True)
        return original(db, *args, **kwargs)

    monkeypatch.setattr(type(owner.db), '_read_ctx', read)
    reply = await owner.rpc('session.active_list')
    assert 'imported' in {row['id'] for row in reply['result']['sessions']}
    assert not on_loop, 'history authorization performed SQLite work on the owner loop'


@pytest.mark.asyncio
async def test_shared_reads_remain_batched_for_more_than_one_batch(owner, monkeypatch):
    from gateway.session_authority import LiveSession
    for index in range(260):
        sid = f'extra-{index}'
        owner.db.create_session(sid, source='telegram')
        owner.authority.sessions[sid] = LiveSession(None, sid)
    with blocked_read(owner, monkeypatch) as blocked:
        polls = [asyncio.create_task(owner.rpc('session.active_list')) for _ in range(4)]
        await asyncio.wait_for(blocked.entered.wait(), 5)
        blocked.release.set()
        replies = await asyncio.gather(*polls)
        assert all(len(reply['result']['sessions']) == 262 for reply in replies)
        assert len(blocked.calls) == 2, blocked.calls
        assert len(blocked.queries) == 4, blocked.queries


@pytest.mark.asyncio
async def test_shared_history_facts_do_not_share_actor_authorization(owner, monkeypatch):
    from gateway.session_authority import LiveSession
    from gateway.session_controls import AuthorityConnection
    from hermes_state_mutation_binding import BINDING_PREFIX
    owner.db.create_session('imported', source='import')
    owner.db.set_meta(BINDING_PREFIX + 'imported', json.dumps(['live', owner.connection.actor.subject]))
    live = owner.authority.sessions['imported'] = LiveSession(None, 'history:imported')
    live.subscribers['reader'] = owner.connection.actor
    stranger = AuthorityConnection(owner.authority, object(), {'user_id': 'stranger'})
    mismatch = AuthorityConnection(owner.authority, object(), {'user_id': 'viewer', 'profile_id': 'foreign'})
    with blocked_read(owner, monkeypatch) as blocked:
        first = asyncio.create_task(owner.rpc('session.active_list'))
        second = asyncio.create_task(owner.rpc('session.active_list', connection=stranger))
        await asyncio.wait_for(blocked.entered.wait(), 5)
        blocked.release.set()
        own, foreign = await asyncio.gather(first, second)
        assert 'imported' in {row['id'] for row in own['result']['sessions']}
        assert 'imported' not in {row['id'] for row in foreign['result']['sessions']}
        assert len(blocked.calls) == 1
        assert (await owner.rpc('session.active_list', connection=mismatch))['result']['sessions'] == []


@pytest.mark.asyncio
async def test_same_batch_ids_in_another_authority_never_share_a_store_read(owner, monkeypatch, tmp_path):
    from gateway.session_authority import LiveSession, SessionAuthority
    from gateway.session_controls import AuthorityConnection
    from hermes_state import SessionDB
    db = SessionDB(db_path=tmp_path / 'second.db')
    try:
        for sid in ('chat', 'other'):
            db.create_session(sid, source='telegram', model='secondary')
        authority = SessionAuthority(owner.authority.runner, profile_id='second', instance_id='owner', db=db, epoch=1)
        authority.sessions = {sid: LiveSession(None, sid) for sid in ('chat', 'other')}
        second = AuthorityConnection(authority, object(), {'user_id': 'viewer'})
        with blocked_read(owner, monkeypatch) as blocked:
            first_poll = asyncio.create_task(owner.rpc('session.active_list'))
            second_poll = asyncio.create_task(owner.rpc('session.active_list', connection=second))
            await asyncio.wait_for(blocked.entered.wait(), 5)
            blocked.release.set()
            primary, secondary = await asyncio.gather(first_poll, second_poll)
            assert {row['model'] for row in primary['result']['sessions']} == {''}
            assert {row['model'] for row in secondary['result']['sessions']} == {'secondary'}
            assert len(blocked.calls) == 2
    finally:
        db.close()


@pytest.mark.asyncio
async def test_detach_and_delete_can_finish_while_listing_reads_wait(owner, monkeypatch):
    row = owner.db.get_session('other')
    with blocked_read(owner, monkeypatch) as blocked:
        poll = asyncio.create_task(owner.rpc('session.active_list'))
        await asyncio.wait_for(blocked.entered.wait(), 5)
        try:
            detached = await asyncio.wait_for(owner.rpc('session.detach', session_id='chat',
                subscription_id=owner.connection.subscriptions['chat']), 5)
            assert detached['result']['detached'], detached
            deleted = await asyncio.wait_for(owner.rpc('session.mutate', session_id='other', request_id='delete',
                expected_revision=row['runtime_revision'], expected_generation=row['runtime_generation'],
                operation='delete', payload={}), 5)
            assert deleted['result']['deleted_ids'] == ['other'], deleted
        finally:
            blocked.release.set()
        assert 'other' not in {row['id'] for row in (await poll)['result']['sessions']}
        assert 'other' not in owner.authority.sessions


@pytest.mark.asyncio
async def test_a_shared_store_error_reaches_every_waiter_and_the_next_poll_retries(owner, monkeypatch):
    import sqlite3
    from gateway import session_live_listing
    original = session_live_listing._store_facts
    entered, release = asyncio.Event(), threading.Event()
    loop = asyncio.get_running_loop()
    calls = []

    def broken(db, batch):
        calls.append(tuple(batch))
        loop.call_soon_threadsafe(entered.set)
        assert release.wait(10)
        raise sqlite3.OperationalError('injected listing read failure')

    monkeypatch.setattr(session_live_listing, '_store_facts', broken)
    polls = [asyncio.create_task(owner.rpc('session.active_list')) for _ in range(3)]
    try:
        await asyncio.wait_for(entered.wait(), 5)
    finally:
        release.set()
    replies = await asyncio.gather(*polls)
    assert all(reply['error']['message'] == 'storage_unavailable' for reply in replies)
    assert len(calls) == 1
    monkeypatch.setattr(session_live_listing, '_store_facts', original)
    assert 'result' in await owner.rpc('session.active_list')


@pytest.mark.asyncio
async def test_fresh_admission_states_and_unpublished_settlement_are_not_cached(owner):
    from hermes_state_runtime import (admit_session_input, begin_runtime_epoch, claim_session_input,
                                      recover_session_inputs, settle_session_input)

    async def status():
        reply = await owner.rpc('session.active_list')
        return next(row['status'] for row in reply['result']['sessions'] if row['id'] == 'chat')

    assert await status() == 'idle'
    await asyncio.to_thread(admit_session_input, owner.db, epoch=owner.authority.epoch,
        principal_id=owner.connection.actor.subject, session_id='chat', request_id='queued', payload={'text': 'hi'})
    assert await status() == 'starting'
    claim = await asyncio.to_thread(claim_session_input, owner.db, epoch=owner.authority.epoch, session_id='chat')
    assert isinstance(claim, dict)
    assert await status() == 'working'
    live = owner.authority.sessions['chat']
    with live.event_stream.lock:
        live.settling[claim['admission_id']] = claim
    await asyncio.to_thread(settle_session_input, owner.db, epoch=owner.authority.epoch,
        admission_id=claim['admission_id'], generation=claim['generation'], outcome='completed')
    assert await status() == 'working'  # terminal in SQLite, completion not published
    with live.event_stream.lock:
        live.settling.clear()
    assert await status() == 'idle'
    await asyncio.to_thread(admit_session_input, owner.db, epoch=owner.authority.epoch,
        principal_id=owner.connection.actor.subject, session_id='chat', request_id='lost', payload={'text': 'lost'})
    await asyncio.to_thread(claim_session_input, owner.db, epoch=owner.authority.epoch, session_id='chat')
    epoch = await asyncio.to_thread(begin_runtime_epoch, owner.db, instance_id='replacement')
    await asyncio.to_thread(recover_session_inputs, owner.db, epoch=epoch)
    # Preserve active_list's existing projection: unknown without queued followers is idle,
    # not working; the canonical handle still carries unknown.
    from gateway.session_contract import SessionRef
    handle = await owner.authority.resolve(owner.connection.actor, SessionRef('live', 'chat'))
    assert handle.execution_state == 'unknown'
    assert await status() == 'idle'
    reply = await owner.rpc('session.list')
    assert next(row for row in reply['result']['sessions'] if row['id'] == 'chat')['running'] is False


@pytest.mark.asyncio
async def test_genuine_closed_hidden_and_internal_local_sessions_keep_their_population(tmp_path, monkeypatch):
    from gateway.session_controls import AuthorityConnection
    from tests.gateway.test_local_source_labels import _authority, _create
    authority, store = await _authority(tmp_path, monkeypatch)
    conn = AuthorityConnection(authority, SimpleNamespace(write=lambda frame: None), {'user_id': 'owner'})
    try:
        chat = await _create(conn, authority, store, 'cli', 'visible')
        hidden = await _create(conn, authority, store, 'cli', 'hidden')
        internal = await _create(conn, authority, store, 'tool', 'internal')
        closed = await _create(conn, authority, store, 'cli', 'closed')
        authority.db.set_session_hidden(hidden, True)
        # An observer legitimately pins the closed live object past last-viewer retirement.
        authority.sessions[closed].event_stream.observers.add(lambda frame: None)
        reply = await conn.dispatch({'id': 1, 'method': 'session.detach', 'params': {
            'session_id': closed, 'subscription_id': conn.subscriptions[closed], 'end_reason': 'tui_close'}})
        assert reply['result']['detached'], reply
        assert authority.db.get_session(closed)['ended_at'] is not None
        assert closed in authority.sessions
        for method, params, expected in (
                ('session.list', {}, {chat}),
                ('session.list', {'include_hidden': True}, {chat, hidden}),
                ('session.active_list', {}, {chat, hidden})):
            reply = await conn.dispatch({'id': 2, 'method': method, 'params': params})
            assert {row['id'] for row in reply['result']['sessions']} == expected, (internal, reply)
    finally:
        await conn.close()
        authority.db.close()
