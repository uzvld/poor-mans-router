"""Atomic host/native identity mapping; macOS/POSIX single-owner leases.

Callers supply a profile identity and private state paths. No Hermes imports,
profile mutation, credential storage, session globbing, or last-session fallback.
"""
import fcntl
import hashlib
import json
import os
import time as _time
from pathlib import Path
import sqlite3

class MappingStore:
    # Upper bound during which a concurrent host (another Hermes client in the
    # same session that just finished a turn and is still tearing down) may hold
    # the lease. A turn's runtime is short-lived, so 30s is generous — real
    # contention (model switches toggling omp on/off) resolves in milliseconds.
    _LEASE_WAIT_SECONDS = 30.0
    _LEASE_POLL_SECONDS = 0.05

    def __init__(self, path, session_root):
        self.path = Path(path).resolve()
        self.session_root = Path(session_root).resolve()
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.session_root.mkdir(parents=True, exist_ok=True, mode=0o700)
        with sqlite3.connect(self.path) as db:
            db.execute('''CREATE TABLE IF NOT EXISTS mappings (
                profile TEXT NOT NULL, host_id TEXT NOT NULL, cwd TEXT NOT NULL,
                native_id TEXT NOT NULL, session_file TEXT NOT NULL, model_id TEXT NOT NULL,
                PRIMARY KEY(profile, host_id))''')
        os.chmod(self.path, 0o600)

    def acquire(self, profile, host_id):
        key = hashlib.sha256(json.dumps([str(profile), host_id]).encode()).hexdigest()
        folder = self.path.parent / 'leases'
        folder.mkdir(exist_ok=True, mode=0o700)
        handle = open(folder / key, 'a+b')
        # Wait (bounded) instead of failing on a busy lease: several Hermes
        # clients for one session overlap during model switches — the previous
        # omp runtime spins down while the next starts, and a hard non-blocking
        # failure surfaced as BlockingIOError [Errno 35] that retried uselessly.
        # Serialize on the flock with a timeout.
        deadline = _time.monotonic() + self._LEASE_WAIT_SECONDS
        try:
            while True:
                try:
                    fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    return handle
                except BlockingIOError:
                    if _time.monotonic() >= deadline:
                        raise
                    _time.sleep(self._LEASE_POLL_SECONDS)
        except BaseException:
            handle.close()
            raise

    def _session_file(self, value, *, exists):
        path = Path(value)
        if not path.is_absolute():
            raise ValueError('native session file must be absolute')
        path = path.resolve()
        if not path.is_relative_to(self.session_root):
            raise ValueError('native session is outside the owned session root')
        if exists and not path.is_file():
            raise FileNotFoundError(path)
        return str(path)

    def get(self, profile, host_id, cwd):
        with sqlite3.connect(self.path) as db:
            db.row_factory = sqlite3.Row
            row = db.execute('SELECT * FROM mappings WHERE profile=? AND host_id=?',
                             (str(profile), host_id)).fetchone()
        if row is None:
            return None
        result = dict(row)
        if result['cwd'] != str(Path(cwd).resolve()):
            raise ValueError('resume cwd differs from persisted cwd')
        result['session_file'] = self._session_file(result['session_file'], exists=True)
        return result

    def save(self, profile, host_id, cwd, state):
        ident = state.get('sessionId')
        if not isinstance(ident, str) or not ident:
            raise ValueError('missing native session identity')
        # OMP can allocate its filename before lazily writing the first message.
        file = self._session_file(state['sessionFile'], exists=False)
        model = state['model']
        if not all(isinstance(model.get(k), str) and model[k] for k in ('provider', 'id')):
            raise ValueError('missing native model identity')
        with sqlite3.connect(self.path) as db:
            db.execute('INSERT OR REPLACE INTO mappings VALUES (?, ?, ?, ?, ?, ?)',
                (str(profile), host_id, str(Path(cwd).resolve()), ident, file,
                 model['provider'] + '/' + model['id']))
