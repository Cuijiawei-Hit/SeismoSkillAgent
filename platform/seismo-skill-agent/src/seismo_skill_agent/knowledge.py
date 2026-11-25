from __future__ import annotations

import hashlib
import json
import re
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Protocol

from .models import KnowledgeEvidence


class KnowledgeRetriever(Protocol):
    def retrieve(self, queries: list[str], limit: int = 6) -> list[KnowledgeEvidence]: ...


class NullKnowledgeRetriever:
    def retrieve(self, queries: list[str], limit: int = 6) -> list[KnowledgeEvidence]:
        return []


def _terms(text: str) -> set[str]:
    lowered = text.lower()
    latin = set(re.findall(r"[a-z0-9_]{2,}", lowered))
    chinese_runs = re.findall(r"[\u4e00-\u9fff]+", lowered)
    chinese = {
        run[index : index + 2]
        for run in chinese_runs
        for index in range(max(len(run) - 1, 1))
        if len(run[index : index + 2]) == 2
    }
    return latin | chinese


def document_metadata(text: str) -> dict[str, str]:
    output: dict[str, str] = {}
    for line in text.splitlines()[:180]:
        match = re.match(r"^\s*[-*]\s*([^:：]{1,40})[:：]\s*(.+?)\s*$", line)
        if match:
            output.setdefault(match.group(1).strip(), match.group(2).strip().strip("`"))
    return output


def evidence_time_validity(effective_from: str | None, effective_until: str | None) -> str:
    """Assess declared dates only. A date interval does not verify a regulation."""
    if not effective_from and not effective_until:
        return "unknown"
    try:
        start = date.fromisoformat(effective_from) if effective_from else None
        end = date.fromisoformat(effective_until) if effective_until else None
    except ValueError:
        return "unknown"
    if start and end and start > end:
        return "unknown"
    today = datetime.now(timezone.utc).date()
    if end and today > end:
        return "expired"
    if start and today < start:
        return "not_yet_effective"
    return "within_declared_bounds"


def evidence_document_fields(metadata: dict[str, str]) -> dict[str, Any]:
    """Carry source-declared qualifiers without granting authority to a document."""
    fields = {key.casefold().replace("_", " "): value for key, value in metadata.items()}

    def first(*keys: str) -> str | None:
        return next((fields[key] for key in keys if fields.get(key)), None)

    status_text = first("有效状态", "现行状态", "document status", "normative status", "status")
    status = (status_text or "").casefold()
    if status in {"withdrawn", "repealed", "revoked"} or ("已废止" in status or "已撤销" in status):
        lifecycle = "withdrawn"
    elif status == "superseded" or ("已" in status and "替代" in status):
        lifecycle = "superseded"
    elif status == "historical" or status.startswith("历史"):
        lifecycle = "historical"
    elif status in {"current", "active", "in force", "现行", "现行规划", "现行政策指导"}:
        lifecycle = "current"
    else:
        lifecycle = "unknown"
    start = first("生效日期", "实施日期", "effective from", "effective date")
    end = first("失效日期", "到期日期", "effective until", "expiry date")
    return {
        "document_version": first("版次", "版本", "版本号", "document version", "version", "edition"),
        "document_status": lifecycle,
        "document_status_text": status_text,
        "effective_from": start,
        "effective_until": end,
        "time_validity": evidence_time_validity(start, end),
        "applicability": first("适用范围", "适用对象", "适用地区", "applicability", "applicability scope", "jurisdiction"),
    }


class DirectoryKnowledgeRetriever:
    """Small deterministic retriever used before the FAISS knowledge base is populated."""

    supported_suffixes = {".md", ".txt", ".json"}
    excluded_parts = {"raw", "metadata", "index", "inbox", "tools", "datasets", "__pycache__"}
    source_dropzones = {"区域医疗系统 (2)"}

    def __init__(self, root: Path) -> None:
        self.root = Path(root)

    def retrieve(self, queries: list[str], limit: int = 6) -> list[KnowledgeEvidence]:
        if not self.root.exists() or not queries:
            return []
        query_terms = _terms(" ".join(queries))
        if not query_terms:
            return []
        candidates: list[KnowledgeEvidence] = []
        resolved_root = self.root.resolve()
        for path in sorted(self.root.rglob("*")):
            if not path.is_file() or path.suffix.lower() not in self.supported_suffixes:
                continue
            relative_path = path.relative_to(self.root)
            relative_parts = set(relative_path.parts[:-1])
            if relative_parts & self.excluded_parts:
                continue
            if relative_parts & self.source_dropzones:
                continue
            try:
                if not path.resolve().is_relative_to(resolved_root):
                    continue
                source_bytes = path.read_bytes()
                text = source_bytes.decode("utf-8")
            except (OSError, RuntimeError, UnicodeDecodeError):
                continue
            if path.suffix.lower() == ".json":
                try:
                    text = json.dumps(json.loads(text), ensure_ascii=False, indent=2)
                except json.JSONDecodeError:
                    pass
            document_fields = evidence_document_fields(document_metadata(text))
            source_sha256 = hashlib.sha256(source_bytes).hexdigest()
            title = path.stem
            for line in text.splitlines()[:20]:
                stripped_line = line.strip()
                for prefix in ("题名:", "题名：", "Title:", "Title："):
                    if stripped_line.startswith(prefix):
                        parsed_title = stripped_line[len(prefix) :].strip()
                        if parsed_title:
                            title = parsed_title
                        break
                else:
                    continue
                break
            section = None
            chunks: list[tuple[str | None, str]] = []
            buffer: list[str] = []
            for line in text.splitlines():
                if line.startswith("#"):
                    if buffer:
                        chunks.append((section, "\n".join(buffer).strip()))
                        buffer = []
                    section = line.lstrip("#").strip() or None
                elif line.strip():
                    buffer.append(line)
                elif buffer:
                    chunks.append((section, "\n".join(buffer).strip()))
                    buffer = []
            if buffer:
                chunks.append((section, "\n".join(buffer).strip()))
            for index, (chunk_section, content) in enumerate(chunks):
                content_terms = _terms(content)
                overlap = len(query_terms & content_terms)
                if overlap == 0:
                    continue
                title_overlap = len(query_terms & _terms(title))
                score = (overlap + 3 * title_overlap) / max(4 * len(query_terms), 1)
                digest = hashlib.sha256(f"{path}:{index}".encode("utf-8")).hexdigest()[:16]
                candidates.append(
                    KnowledgeEvidence(
                        evidence_id=f"kb-{digest}",
                        title=title,
                        source_path=str(path.resolve()),
                        section=chunk_section,
                        content=content[:2000],
                        score=score,
                        source_sha256=source_sha256,
                        **document_fields,
                    )
                )
        selected: list[KnowledgeEvidence] = []
        seen_paths: set[str] = set()
        for candidate in sorted(candidates, key=lambda item: (-item.score, item.source_path)):
            if candidate.source_path in seen_paths:
                continue
            selected.append(candidate)
            seen_paths.add(candidate.source_path)
            if len(selected) >= limit:
                break
        return selected
