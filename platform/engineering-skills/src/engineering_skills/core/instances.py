"""Optional local SQLite index of frozen bindings and new execution records.

Opening a Registry or reading a missing store never creates a database. Existing
historical result files are not scanned, rewritten, or imported implicitly.
"""
from __future__ import annotations

import json
from contextlib import contextmanager
from pathlib import Path
import sqlite3

from .artifacts import canonical_json, hash_payload
from .exceptions import InstanceBindingError, InstanceStoreError
from .models import SkillBinding


class InstanceStore:
    def __init__(self, path):
        self.path = Path(path).resolve()

    @contextmanager
    def _connect(self, *, write=False):
        connection = None
        try:
            connection = self._open(write=write)
            with connection:
                yield connection
        finally:
            if connection is not None:
                connection.close()

    def _open(self, *, write):
        if write:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            connection = sqlite3.connect(self.path, timeout=15)
            try:
                connection.execute('PRAGMA busy_timeout=15000')
                # Serialize initial creation as well as binding writes. Do not
                # add tables to an unrelated or partially corrupted database.
                connection.execute('BEGIN IMMEDIATE')
                tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
                if tables and not {'store_metadata','bindings','executions'} <= tables:
                    raise InstanceStoreError('Existing database is not an intact instance store; refusing implicit migration')
                if tables:
                    row = connection.execute("SELECT value FROM store_metadata WHERE key='schema_version'").fetchone()
                    if not row or row[0] != '1':
                        raise InstanceStoreError('Unknown instance-store schema; refusing implicit migration')
                else:
                    connection.execute('CREATE TABLE store_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
                    connection.execute("INSERT INTO store_metadata VALUES ('schema_version','1')")
                    connection.execute('CREATE TABLE bindings (instance_id TEXT PRIMARY KEY, payload TEXT NOT NULL, sha256 TEXT NOT NULL)')
                    connection.execute('''CREATE TABLE executions (
                        instance_id TEXT NOT NULL, run_id TEXT NOT NULL, record TEXT NOT NULL,
                        PRIMARY KEY (instance_id,run_id))''')
                connection.commit()
            except Exception:
                connection.rollback()
                connection.close()
                raise
        else:
            connection = sqlite3.connect(self.path.as_uri()+'?mode=ro',uri=True,timeout=15)
        try:
            version = connection.execute("SELECT value FROM store_metadata WHERE key='schema_version'").fetchone()
            if not version or version[0] != '1':
                raise InstanceStoreError('Unknown instance-store schema; no automatic migration attempted')
        except Exception:
            connection.close()
            raise
        return connection

    @staticmethod
    def _binding(row):
        payload, checksum = row
        value = json.loads(payload)
        if hash_payload(value) != checksum:
            raise InstanceStoreError('Stored instance binding checksum mismatch')
        return SkillBinding.model_validate(value)

    def save(self, binding):
        value = binding.model_dump(mode='json')
        payload, checksum = canonical_json(value), hash_payload(value)
        try:
            with self._connect(write=True) as connection:
                connection.execute('BEGIN IMMEDIATE')
                row = connection.execute('SELECT payload,sha256 FROM bindings WHERE instance_id=?',(binding.instance_id,)).fetchone()
                if row is not None:
                    if self._binding(row) != binding:
                        raise InstanceBindingError('Instance ID is already bound to different stored inputs or implementation')
                else:
                    connection.execute('INSERT INTO bindings VALUES (?,?,?)',(binding.instance_id,payload,checksum))
        except sqlite3.Error as exc:
            raise InstanceStoreError(f'Cannot persist instance evidence: {exc}') from exc

    def load(self, instance_id):
        if not self.path.is_file(): return None
        try:
            with self._connect() as connection:
                row = connection.execute('SELECT payload,sha256 FROM bindings WHERE instance_id=?',(instance_id,)).fetchone()
                return self._binding(row) if row else None
        except (sqlite3.Error,ValueError) as exc:
            raise InstanceStoreError(f'Cannot read instance evidence: {exc}') from exc

    def list_bindings(self):
        if not self.path.is_file(): return []
        try:
            with self._connect() as connection:
                return [self._binding(row) for row in connection.execute('SELECT payload,sha256 FROM bindings ORDER BY instance_id')]
        except (sqlite3.Error,ValueError) as exc:
            raise InstanceStoreError(f'Cannot list instance evidence: {exc}') from exc

    def record_execution(self, binding, record):
        self.save(binding)
        payload = canonical_json(record)
        try:
            with self._connect(write=True) as connection:
                connection.execute('BEGIN IMMEDIATE')
                row = connection.execute('SELECT record FROM executions WHERE instance_id=? AND run_id=?',
                    (binding.instance_id,record['run_id'])).fetchone()
                if row and row[0] != payload:
                    raise InstanceStoreError('Execution evidence already exists; use a new run_id')
                if not row:
                    connection.execute('INSERT INTO executions VALUES (?,?,?)',
                        (binding.instance_id,record['run_id'],payload))
        except sqlite3.Error as exc:
            raise InstanceStoreError(f'Cannot index execution evidence: {exc}') from exc

    def executions(self, instance_id):
        if not self.path.is_file(): return []
        try:
            with self._connect() as connection:
                return [json.loads(row[0]) for row in connection.execute(
                    'SELECT record FROM executions WHERE instance_id=? ORDER BY run_id',(instance_id,))]
        except (sqlite3.Error,ValueError) as exc:
            raise InstanceStoreError(f'Cannot read execution evidence: {exc}') from exc
