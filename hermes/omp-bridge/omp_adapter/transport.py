"""Async stdio transport. One event loop; bounded waits, no secrets logged."""
import asyncio
import contextlib
import os
import signal
import uuid

from .codec import Decoder, encode_input


def _host_env():
    """Keep OMP's own PATH plus the bins Hermes/Homebrew actually use.

    Gateway/cron inherit a short PATH (no Homebrew node, no ~/.local/bin). Cursor
    and OpenCode inside OMP are model providers, but OMP MCP/skills still spawn
    node/bun from PATH — missing those is the ``[Errno 2] ... /opt/homebrew/bin/node``
    class of failure.
    """
    env = os.environ.copy()
    extras = [
        '/opt/homebrew/bin',
        '/usr/local/bin',
        os.path.expanduser('~/.local/bin'),
        os.path.expanduser('~/.hermes/node/bin'),
    ]
    env['PATH'] = os.pathsep.join(extras + [env.get('PATH', '')])
    env.setdefault('HOME', os.path.expanduser('~'))
    return env

class RPCError(RuntimeError):
    def __init__(self, response):
        self.response = response
        super().__init__(f"OMP {response.get('command')}: {response.get('error', 'request failed')}")

class Transport:
    def __init__(self, argv, cwd):
        self.argv = list(argv)
        self.cwd = cwd
        self.process = None
        self.pending = {}
        self.subscribers = set()
        self.failure = None
        self.stderr_bytes = 0
        self._tasks = []
        self._write_lock = asyncio.Lock()
        self._closing = False

    @property
    def pending_count(self):
        return len(self.pending)

    def subscribe(self):
        queue = asyncio.Queue(maxsize=128)
        self.subscribers.add(queue)
        if self.failure:
            queue.put_nowait(self.failure)
        return queue

    def unsubscribe(self, queue):
        self.subscribers.discard(queue)

    def _publish(self, event):
        for queue in self.subscribers:
            queue.put_nowait(event)

    def _fail(self, error):
        if self.failure is not None:
            return
        self.failure = error
        for future in self.pending.values():
            if not future.done():
                future.set_exception(error)
        for queue in self.subscribers:
            # A slow consumer must receive a terminal error, never silent event loss.
            while queue.full():
                queue.get_nowait()
            queue.put_nowait(error)

    async def start(self, timeout=35):
        if self.process is not None:
            raise RuntimeError('transport is single-use')
        ready_queue = self.subscribe()
        try:
            self.process = await asyncio.create_subprocess_exec(*self.argv, cwd=self.cwd,
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE, start_new_session=True,
                env=_host_env())
            self._tasks = [asyncio.create_task(self._read()), asyncio.create_task(self._drain_stderr())]
            async with asyncio.timeout(timeout):
                while True:
                    ready = await ready_queue.get()
                    if isinstance(ready, Exception):
                        raise ready
                    if ready.get('type') == 'ready':
                        break
                if 2 not in ready.get('supportedProtocolVersions', []):
                    raise RuntimeError('OMP protocol 2 unavailable')
                if await self.request('negotiate_protocol', protocolVersion=2) != {'protocolVersion':2}:
                    raise RuntimeError('invalid protocol negotiation')
            return ready
        except BaseException:
            await self.close(timeout=1)
            raise
        finally:
            self.unsubscribe(ready_queue)

    async def _read(self):
        decoder = Decoder()
        try:
            while data := await self.process.stdout.read(65536):
                for message in decoder.feed(data):
                    if message.get('type') == 'response':
                        future = self.pending.get(message.get('id'))
                        if future is not None and not future.done():
                            future.set_result(message)
                    self._publish(message)
            decoder.finish()
            self._fail(EOFError('OMP output closed'))
        except Exception as exc:
            self._fail(exc)

    async def _drain_stderr(self):
        while data := await self.process.stderr.read(8192):
            self.stderr_bytes += len(data)

    async def send(self, message):
        wire = encode_input(message)
        if self.failure:
            raise self.failure
        if self.process is None or self.process.returncode is not None:
            raise RuntimeError('OMP is not running')
        async with self._write_lock:
            self.process.stdin.write(wire)
            await self.process.stdin.drain()

    async def request(self, command, *, timeout=30, **fields):
        if 'id' in fields or 'type' in fields:
            raise ValueError('request identifiers are transport-owned')
        ident = uuid.uuid4().hex
        future = asyncio.get_running_loop().create_future()
        self.pending[ident] = future
        try:
            await self.send({'type':command, 'id':ident, **fields})
            response = await asyncio.wait_for(future, timeout)
            if response.get('success') is not True:
                raise RPCError(response)
            return response.get('data')
        finally:
            self.pending.pop(ident, None)
            if not future.done():
                future.cancel()

    async def close(self, timeout=3):
        if self._closing:
            return
        self._closing = True
        try:
            if self.process is not None:
                if self.process.returncode is None:
                    self.process.stdin.close()
                    try:
                        await asyncio.wait_for(self.process.wait(), timeout)
                    except TimeoutError:
                        with contextlib.suppress(ProcessLookupError):
                            os.killpg(self.process.pid, signal.SIGTERM)
                        try:
                            await asyncio.wait_for(self.process.wait(), timeout)
                        except TimeoutError:
                            with contextlib.suppress(ProcessLookupError):
                                os.killpg(self.process.pid, signal.SIGKILL)
                            await asyncio.wait_for(self.process.wait(), timeout)
                for task in self._tasks:
                    task.cancel()
                await asyncio.gather(*self._tasks, return_exceptions=True)
            self._fail(EOFError('OMP transport closed'))
        finally:
            self._closing = False
