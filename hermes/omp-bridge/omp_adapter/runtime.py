"""OMP owns inference, tools, MCP, skills and history; Hermes is a thin host.

This module does not implement an OpenAI completion shim or import Hermes.
The Hermes chat facade lives in omp_rpc_client.py.
"""
import asyncio
import contextlib
from pathlib import Path
import uuid

from .transport import RPCError, Transport

_APPROVAL_MODES = {'always-ask', 'write', 'yolo'}


class _Permissions:
    """Permission/extension-UI bridge.

    OMP emits ``extension_ui_request`` events. A host UI attaches with
    ``attach_ui()`` and answers each request. With no UI:

    * ``permission_policy='deny'`` (default) fail-closes — used by isolated tests
      and always-ask launches.
    * ``permission_policy='allow'`` auto-confirms, matching a thin host that
      launched OMP with ``--approval-mode yolo`` because Hermes has no native
      OMP approval surface.
    """

    def __init__(self, runtime):
        self._runtime = runtime
        self.pending = {}  # request id -> loop timer handle

    def arm(self, request_id):
        """Called from turn() when an extension_ui_request arrives."""
        if self._runtime._ui_token is None:
            if self._runtime.permission_policy == 'allow':
                self._runtime._send_ui(request_id, {'confirmed': True, 'cancelled': False})
            else:
                self._runtime._send_ui(request_id, {'confirmed': False, 'cancelled': True})
            return
        loop = asyncio.get_running_loop()
        timer = loop.call_later(self._runtime.permission_timeout, self._deny, request_id)
        self.pending[request_id] = timer

    async def attach(self):
        token = uuid.uuid4().hex
        self._runtime._ui_token = token
        return token

    def _deny(self, request_id):
        timer = self.pending.pop(request_id, None)
        if timer is not None:
            timer.cancel()
            self._runtime._send_ui(request_id, {'confirmed': False, 'cancelled': True})

    async def respond(self, token, request_id, response):
        if token != self._runtime._ui_token:
            raise PermissionError('permission UI token mismatch')
        if request_id not in self.pending:
            raise KeyError(request_id)
        request_id_, timer = request_id, self.pending.pop(request_id)
        timer.cancel()
        self._runtime._send_ui(request_id_, {**response, 'confirmed': bool(response.get('confirmed', False))})

    async def detach(self, token):
        if token != self._runtime._ui_token:
            raise PermissionError('permission UI token mismatch')
        for request_id in list(self.pending):
            self._deny(request_id)
        self._runtime._ui_token = None


class OMPRuntime:
    provider = 'omp'

    def __init__(self, store, profile, host_id, cwd, *, command=None, permission_timeout=120,
                 approval_mode='always-ask', permission_policy='deny'):
        self.store, self.profile, self.host_id = store, str(profile), host_id
        self.cwd = Path(cwd).resolve()
        self.command = list(command or ['/opt/homebrew/bin/omp'])
        self.permission_timeout = permission_timeout
        mode = str(approval_mode or 'always-ask').strip().lower()
        self.approval_mode = mode if mode in _APPROVAL_MODES else 'always-ask'
        policy = str(permission_policy or 'deny').strip().lower()
        self.permission_policy = 'allow' if policy == 'allow' else 'deny'
        self.transport = None
        self.lease = None
        self.state = None
        self._turn_active = False
        self._ui_token = None
        self._ui_sends = set()
        self.permissions = _Permissions(self)

    async def start(self, timeout=35):
        if self.transport is not None:
            raise RuntimeError('runtime is single-use; construct a new instance for resume')
        self.lease = self.store.acquire(self.profile, self.host_id)
        try:
            prior = self.store.get(self.profile, self.host_id, self.cwd)
            argv = self.command + ['--mode', 'rpc-ui', '--cwd', str(self.cwd),
                '--session-dir', str(self.store.session_root),
                '--approval-mode', self.approval_mode]
            if self.approval_mode == 'yolo':
                argv.append('--auto-approve')
            if prior:
                argv += ['--resume', prior['session_file']]
            self.transport = Transport(argv, self.cwd)
            await self.transport.start(timeout)
            await self.refresh_state()
            if prior and (prior['native_id'] != self.state['sessionId'] or
                          prior['session_file'] != self.state['sessionFile']):
                raise ValueError('OMP resumed a different native session')
            return self
        except BaseException:
            await self.close()
            raise

    async def refresh_state(self):
        state = await self.transport.request('get_state')
        self.store.save(self.profile, self.host_id, self.cwd, state)
        self.state = state
        return state

    async def models(self):
        data = await self.transport.request('get_available_models')
        return [{'provider': self.provider, 'id': m['provider'] + '/' + m['id'], 'native': m}
                for m in data['models']]

    async def commands(self):
        return (await self.transport.request('get_available_commands'))['commands']

    async def set_model(self, model_id):
        if self._turn_active:
            raise RuntimeError('cannot switch model during a turn')
        provider, sep, native_id = model_id.partition('/')
        if not sep or not provider or not native_id:
            raise ValueError('model must retain native provider/model ID')
        await self.transport.request('set_model', provider=provider, modelId=native_id)
        await self.refresh_state()

    async def turn(self, text, *, timeout=90, follow_up=False):
        if self._turn_active:
            raise RuntimeError('one turn at a time; use steer or follow_up explicitly')
        if not isinstance(text, str):
            raise TypeError('native input must be a string')
        self._turn_active = True
        events = self.transport.subscribe()
        ident = uuid.uuid4().hex
        complete = False
        started = False
        command = 'follow_up' if follow_up else 'prompt'
        try:
            await self.transport.send({'type': command, 'id': ident, 'message': text})
            async with asyncio.timeout(timeout):
                while True:
                    event = await events.get()
                    if isinstance(event, Exception):
                        raise event
                    kind = event.get('type')
                    if kind == 'extension_ui_request':
                        self.permissions.arm(event.get('id'))
                    yield {'provider': self.provider, 'host_session_id': self.host_id, 'event': event}
                    if kind == 'response' and event.get('id') == ident:
                        if event.get('success') is not True:
                            raise RPCError(event)
                        if isinstance(event.get('data'), dict) and event['data'].get('agentInvoked') is False:
                            complete = True
                    if kind == 'prompt_result' and event.get('id') == ident and event.get('agentInvoked') is False:
                        complete = True
                    if kind == 'agent_start':
                        started = True
                    if kind == 'agent_end' and started:
                        complete = True
                    if complete:
                        break
            await self.refresh_state()
        finally:
            self.transport.unsubscribe(events)
            self._turn_active = False
            if not complete:
                # Failure/timeout/cancel is not replayed: it may already have executed tools.
                with contextlib.suppress(Exception):
                    await self.transport.request('abort', timeout=2)

    async def abort(self):
        return await self.transport.request('abort', timeout=5)

    def _send_ui(self, request_id, response):
        """Fire-and-forget an extension_ui_response on the process stdout."""
        async def send():
            try:
                await self.transport.send({'type': 'extension_ui_response', 'id': request_id, **response})
            except Exception:
                pass
        task = asyncio.ensure_future(send())
        self._ui_sends.add(task)
        task.add_done_callback(self._ui_sends.discard)

    def attach_ui(self):
        return self._make_token()

    def _make_token(self):
        token = uuid.uuid4().hex
        self._ui_token = token
        return token

    async def respond_ui(self, token, request_id, response):
        await self.permissions.respond(token, request_id, response)

    async def detach_ui(self, token):
        await self.permissions.detach(token)

    async def close(self):
        try:
            if self.transport:
                with contextlib.suppress(Exception):
                    await self.transport.request('abort', timeout=2)
                await self.transport.close()
        finally:
            if self.lease:
                self.lease.close()
                self.lease = None
