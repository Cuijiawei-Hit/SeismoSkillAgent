"""Session-specific feedback notes and reviewed, advisory experience records."""

from __future__ import annotations

from collections.abc import Iterable, Iterator
from contextlib import contextmanager
from datetime import date, datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import sqlite3
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator


class FeedbackMemoryDraft(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    kind: Literal["fact", "hard_constraint", "preference", "rationale", "open_question"]
    text: str = Field(min_length=1, max_length=1000)
    source_excerpt: str = Field(min_length=1, max_length=1000)


class ExperiencePublication(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    principle: str = Field(min_length=1, max_length=1600)
    applicability: str = Field(min_length=1, max_length=1000)
    tags: list[str] = Field(default_factory=list, max_length=12)
    reviewer: str = Field(min_length=1, max_length=128)
    valid_until: date | None = None

    @field_validator("tags")
    @classmethod
    def _bounded_tags(cls, tags: list[str]) -> list[str]:
        trimmed = list(dict.fromkeys(tag.strip() for tag in tags))
        if any(not tag or len(tag) > 64 for tag in trimmed):
            raise ValueError("Each experience tag must contain 1 to 64 characters")
        return trimmed


_TABLES = """
CREATE TABLE IF NOT EXISTS feedback_notes (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    iteration INTEGER NOT NULL CHECK (iteration >= 0),
    kind TEXT NOT NULL,
    text TEXT NOT NULL,
    source_excerpt TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('proposed', 'confirmed', 'withdrawn')),
    domain TEXT,
    target_system TEXT,
    reviewer TEXT,
    created_at TEXT NOT NULL,
    reviewed_at TEXT
);
CREATE INDEX IF NOT EXISTS memory_notes_by_session ON feedback_notes(session_id, iteration);
CREATE TABLE IF NOT EXISTS expert_experiences (
    id TEXT PRIMARY KEY,
    origin_note_id TEXT NOT NULL UNIQUE,
    version INTEGER NOT NULL,
    domain TEXT NOT NULL,
    target_system TEXT NOT NULL,
    principle TEXT NOT NULL,
    applicability TEXT NOT NULL,
    tags TEXT NOT NULL,
    reviewer TEXT NOT NULL,
    valid_until TEXT,
    created_at TEXT NOT NULL,
    revoked_at TEXT,
    revoked_by TEXT
);
CREATE INDEX IF NOT EXISTS experiences_by_scope ON expert_experiences(domain, target_system);
"""

_ADVISORY_KEYS = (
    "id", "item_id", "version", "domain", "target_system", "principle",
    "applicability", "tags", "valid_until", "status",
)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _stable_id(*parts: str | int) -> str:
    payload = json.dumps(parts, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _case_note(row: sqlite3.Row) -> dict[str, Any]:
    record = dict(row)
    record["note_id"] = record["id"]
    return record


def _experience(row: sqlite3.Row) -> dict[str, Any]:
    record = dict(row)
    del record["origin_note_id"]
    record["item_id"] = record["id"]
    record["tags"] = json.loads(record["tags"])
    today = datetime.now(timezone.utc).date().isoformat()
    if record["revoked_at"]:
        record["status"] = "revoked"
    elif record["valid_until"] and record["valid_until"] < today:
        record["status"] = "expired"
    else:
        record["status"] = "active"
    return record


def _advisory(record: dict[str, Any]) -> dict[str, Any]:
    return {key: record[key] for key in _ADVISORY_KEYS}


def _terms(text: str) -> set[str]:
    text = text.casefold()
    terms = set(re.findall(r"[a-z0-9_]{2,}", text))
    for run in re.findall(r"[\u4e00-\u9fff]+", text):
        terms.update(run[index:index + 2] for index in range(len(run) - 1))
    return terms


def _reviewer(value: str) -> str:
    value = value.strip()
    if not value or len(value) > 128:
        raise ValueError("Reviewer must contain 1 to 128 characters")
    return value


def _note_columns(connection: sqlite3.Connection) -> set[str]:
    return {row["name"] for row in connection.execute("PRAGMA table_info(feedback_notes)")}


class ExpertMemoryStore:
    """Local, single-workspace persistence. Scopes separate data use by case and domain."""

    def __init__(self, path: Path) -> None:
        self.path = Path(path)

    @contextmanager
    def _connection(self, *, write: bool = False) -> Iterator[sqlite3.Connection]:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(self.path, timeout=10)
        connection.row_factory = sqlite3.Row
        try:
            connection.executescript(_TABLES)
            if not {"domain", "target_system"} <= _note_columns(connection):
                with connection:
                    connection.execute("BEGIN IMMEDIATE")
                    columns = _note_columns(connection)
                    for column in ("domain", "target_system"):
                        if column not in columns:
                            connection.execute(f"ALTER TABLE feedback_notes ADD COLUMN {column} TEXT")
            with connection:
                if write:
                    connection.execute("BEGIN IMMEDIATE")
                yield connection
        finally:
            connection.close()

    def propose(
        self,
        session_id: str,
        iteration: int,
        feedback: str,
        drafts: Iterable[FeedbackMemoryDraft | dict[str, Any]],
        *,
        domain: str | None = None,
        target_system: str | None = None,
    ) -> list[dict[str, Any]]:
        """Capture candidates with a literal excerpt. Confirmation remains a separate action."""
        domain = domain.strip() if domain is not None else None
        target_system = target_system.strip() if target_system is not None else None
        scope: tuple[str, ...] = ()
        if domain is not None or target_system is not None:
            if not domain or not target_system:
                raise ValueError("A scoped note requires a domain and target system")
            scope = (domain, target_system)
        candidates: dict[str, FeedbackMemoryDraft] = {}
        for raw in drafts:
            try:
                draft = FeedbackMemoryDraft.model_validate(raw)
            except ValidationError:
                continue
            if draft.source_excerpt in feedback:
                note_id = _stable_id(session_id, iteration, draft.kind, draft.text, draft.source_excerpt, *scope)
                candidates[note_id] = draft
        if not candidates:
            return []

        with self._connection(write=True) as connection:
            for note_id, draft in candidates.items():
                connection.execute(
                    "INSERT OR IGNORE INTO feedback_notes "
                    "(id, session_id, iteration, kind, text, source_excerpt, status, created_at, domain, target_system) "
                    "VALUES (?, ?, ?, ?, ?, ?, 'proposed', ?, ?, ?)",
                    (note_id, session_id, iteration, draft.kind, draft.text, draft.source_excerpt,
                     _now(), domain, target_system),
                )
            records = [self._find_note(connection, session_id, note_id) for note_id in candidates]
        return [_case_note(row) for row in records if row["status"] != "withdrawn"]

    @staticmethod
    def _find_note(connection: sqlite3.Connection, session_id: str, note_id: str) -> sqlite3.Row:
        row = connection.execute(
            "SELECT * FROM feedback_notes WHERE session_id = ? AND id = ?",
            (session_id, note_id),
        ).fetchone()
        if row is None:
            raise KeyError("Feedback note was not found in this session")
        return row

    def notes(self, session_id: str, confirmed_only: bool = False) -> list[dict[str, Any]]:
        if not self.path.exists():
            return []
        with self._connection() as connection:
            rows = connection.execute(
                "SELECT * FROM feedback_notes WHERE session_id = ? "
                "AND (? = 0 OR status = 'confirmed') ORDER BY iteration, created_at, id",
                (session_id, int(confirmed_only)),
            ).fetchall()
        return [_case_note(row) for row in rows]

    def review_note(
        self, session_id: str, note_id: str, status: Literal["confirmed", "withdrawn"], reviewer: str,
    ) -> dict[str, Any]:
        if status not in {"confirmed", "withdrawn"}:
            raise ValueError("Unknown feedback note review status")
        reviewer = _reviewer(reviewer)
        if not self.path.exists():
            raise KeyError("Feedback note was not found in this session")
        with self._connection(write=True) as connection:
            note = self._find_note(connection, session_id, note_id)
            if note["status"] == status:
                return _case_note(note)
            if note["status"] == "withdrawn":
                raise ValueError("A withdrawn note requires a new submission and review")
            now = _now()
            connection.execute(
                "UPDATE feedback_notes SET status = ?, reviewer = ?, reviewed_at = ? WHERE id = ?",
                (status, reviewer, now, note_id),
            )
            if status == "withdrawn":
                connection.execute(
                    "UPDATE expert_experiences SET revoked_at = ?, revoked_by = ?, version = version + 1 "
                    "WHERE origin_note_id = ? AND revoked_at IS NULL",
                    (now, reviewer, note_id),
                )
            return _case_note(self._find_note(connection, session_id, note_id))

    def publish(
        self, session_id: str, note_id: str, publication: ExperiencePublication | dict[str, Any],
        *, domain: str, target_system: str,
    ) -> dict[str, Any]:
        publication = ExperiencePublication.model_validate(publication)
        domain, target_system = domain.strip(), target_system.strip()
        if not domain or not target_system:
            raise ValueError("An experience requires a domain and target system")
        if not self.path.exists():
            raise KeyError("Feedback note was not found in this session")
        with self._connection(write=True) as connection:
            note = self._find_note(connection, session_id, note_id)
            if note["status"] != "confirmed" or note["kind"] == "open_question":
                raise ValueError("Publication requires a confirmed note other than an open question")
            note_scope = (note["domain"], note["target_system"])
            if any(note_scope) and note_scope != (domain, target_system):
                raise ValueError("Publication scope must match the confirmed note's origin scope")
            item_id = _stable_id("experience", note_id)
            existing = connection.execute(
                "SELECT * FROM expert_experiences WHERE id = ?", (item_id,),
            ).fetchone()
            valid_until = publication.valid_until.isoformat() if publication.valid_until else None
            tags = json.dumps(publication.tags, ensure_ascii=False)
            values = (domain, target_system, publication.principle, publication.applicability,
                      tags, publication.reviewer, valid_until)
            if existing is not None:
                keys = ("domain", "target_system", "principle", "applicability", "tags", "reviewer", "valid_until")
                if existing["revoked_at"] is None and tuple(existing[key] for key in keys) == values:
                    return _experience(existing)
                raise ValueError("An existing experience is immutable; review a new note for a replacement")
            connection.execute(
                "INSERT INTO expert_experiences "
                "(id, origin_note_id, version, domain, target_system, principle, applicability, tags, "
                " reviewer, valid_until, created_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)",
                (item_id, note_id, *values, _now()),
            )
            result = connection.execute("SELECT * FROM expert_experiences WHERE id = ?", (item_id,)).fetchone()
        return _experience(result)

    def experiences(
        self, domain: str, target_system: str, *, session_id: str | None = None,
    ) -> list[dict[str, Any]]:
        if not self.path.exists():
            return []
        with self._connection() as connection:
            rows = connection.execute(
                "SELECT e.* FROM expert_experiences e "
                "WHERE e.domain = ? AND e.target_system = ? AND (? IS NULL OR EXISTS "
                "(SELECT 1 FROM feedback_notes n WHERE n.id = e.origin_note_id AND n.session_id = ?)) "
                "ORDER BY e.created_at DESC, e.id",
                (domain, target_system, session_id, session_id),
            ).fetchall()
        return [_experience(row) for row in rows]

    def revoke(
        self, item_id: str, reviewer: str, *, domain: str, target_system: str,
        session_id: str | None = None,
    ) -> dict[str, Any]:
        reviewer = _reviewer(reviewer)
        if not self.path.exists():
            raise KeyError("Experience was not found in this scope")
        with self._connection(write=True) as connection:
            row = connection.execute(
                "SELECT e.* FROM expert_experiences e WHERE e.id = ? AND e.domain = ? AND e.target_system = ? "
                "AND (? IS NULL OR EXISTS (SELECT 1 FROM feedback_notes n WHERE n.id = e.origin_note_id "
                "AND n.session_id = ?))",
                (item_id, domain, target_system, session_id, session_id),
            ).fetchone()
            if row is None:
                raise KeyError("Experience was not found in this scope")
            if row["revoked_at"] is None:
                connection.execute(
                    "UPDATE expert_experiences SET revoked_at = ?, revoked_by = ?, version = version + 1 WHERE id = ?",
                    (_now(), reviewer, item_id),
                )
                row = connection.execute("SELECT * FROM expert_experiences WHERE id = ?", (item_id,)).fetchone()
        return _experience(row)

    def retrieve(
        self, query: str, domain: str, target_system: str, limit: int = 4,
    ) -> list[dict[str, Any]]:
        """Return eligible advisory matches. Lexical overlap does not establish applicability."""
        query_terms = _terms(query[:12000])
        if not query_terms or limit <= 0:
            return []
        ranked: list[tuple[int, dict[str, Any]]] = []
        for experience in self.experiences(domain, target_system):
            if experience["status"] != "active":
                continue
            tag_terms = _terms(" ".join(experience["tags"]))
            content_terms = _terms(f"{experience['principle']} {experience['applicability']}")
            score = 3 * len(query_terms & tag_terms) + len(query_terms & content_terms)
            if score:
                ranked.append((score, experience))
        ranked.sort(key=lambda item: item[0], reverse=True)
        return [_advisory(record) for _, record in ranked[:limit]]

    def current_experiences(
        self, domain: str, target_system: str, ids: Iterable[str],
    ) -> list[dict[str, Any]]:
        requested = list(dict.fromkeys(ids))
        if not requested:
            return []
        active = {record["id"]: record for record in self.experiences(domain, target_system)
                  if record["status"] == "active"}
        return [_advisory(active[item_id]) for item_id in requested if item_id in active]

    def delete_session(self, session_id: str) -> None:
        if not self.path.exists():
            return
        with self._connection(write=True) as connection:
            connection.execute(
                "UPDATE expert_experiences SET revoked_at = ?, revoked_by = 'origin_session_deleted', "
                "version = version + 1 WHERE revoked_at IS NULL AND origin_note_id IN "
                "(SELECT id FROM feedback_notes WHERE session_id = ?)",
                (_now(), session_id),
            )
            connection.execute("DELETE FROM feedback_notes WHERE session_id = ?", (session_id,))
