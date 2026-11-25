from __future__ import annotations

import hashlib
import json
import math
import os
import re
import sqlite3
import tempfile
import unicodedata
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

import numpy as np

from .knowledge import (
    DirectoryKnowledgeRetriever,
    _terms,
    document_metadata,
    evidence_document_fields,
    evidence_time_validity,
)
from .models import KnowledgeEvidence


INDEX_SCHEMA_VERSION = 2
DEFAULT_VECTOR_DIMENSION = 384
DEFAULT_CHUNK_CHARACTERS = 2200
DEFAULT_CHUNK_OVERLAP = 220
EMBEDDING_MODEL_VERSION = "deterministic_multilingual_feature_hashing_v2"
RERANKER_VERSION = "engineering_evidence_reranker_v2"
SUPPORTED_SUFFIXES = {".md", ".txt", ".json"}
EXCLUDED_PARTS = {"raw", "metadata", "index", "inbox", "tools", "datasets", "__pycache__"}
SOURCE_DROPZONES = {"区域医疗系统 (2)"}
TITLE_PREFIXES = ("题名:", "题名：", "Title:", "Title：")
URL_KEYS = ("官方来源", "官方入口", "官方目录", "来源链接", "URL", "url")
LOCATOR_HEADINGS = ("引用定位", "Citation", "引用信息")

DOMAIN_SYNONYMS = {
    "电力": ("电网", "供电", "electricity", "electric power", "power grid"),
    "电网": ("电力", "输电", "配电", "power network", "power grid"),
    "供电": ("负荷", "电网", "power supply", "served load"),
    "停电": ("失供", "缺供", "outage", "load shedding"),
    "变电站": ("变压器", "substation", "transformer"),
    "线路": ("输电", "支路", "transmission line", "branch"),
    "潮流": ("供电", "power flow", "load flow"),
    "医院": ("医疗", "hospital", "healthcare"),
    "医疗": ("医院", "hospital", "healthcare"),
    "抗震": ("地震", "seismic", "earthquake"),
    "地震": ("抗震", "seismic", "earthquake"),
    "恢复": ("修复", "重建", "recovery", "restoration"),
    "修复": ("恢复", "抢修", "repair", "recovery"),
    "可达性": ("通行", "交通", "accessibility", "travel time"),
    "韧性": ("功能恢复", "resilience", "functionality"),
    "伤员": ("救治", "伤亡", "casualty", "patient"),
    "易损性": ("脆弱性", "fragility", "vulnerability"),
    "功能": ("服务能力", "functionality", "service capacity"),
    "优化": ("调度", "排序", "optimization", "scheduling"),
}

INDEX_EXCLUDED_METADATA = re.compile(
    r"^\s*(?:[-*]\s*)?(?:文献ID|主题|原始来源|筛选依据)\s*[:：]",
    flags=re.IGNORECASE,
)


_SOURCE_IDENTIFIER = re.compile(
    r"(?<![a-z0-9])(?:"
    r"10\.\d{4,9}/[-._;()/:a-z0-9]+"
    r"|(?:gb\s*/?\s*[tz]|gb|(?:dl|nb)\s*/?\s*t|q\s*/?\s*gdw"
    r"|iso(?:\s*/\s*iec)?|iec|asce(?:\s*/\s*sei)?)"
    r"\s*-?\s*\d+(?:\s*[-:.]\s*\d+)*"
    r"|fema\s*-?\s*(?:[pe]\s*-?\s*)?\d+(?:\s*-\s*\d+)*"
    r"|nist\s*(?:sp|tn)\s*-?\s*\d+(?:\s*-\s*\d+)*"
    r"|hazus(?:\s+earthquake model(?:\s+technical manual)?)?\s*v?\s*\d+(?:\.\d+)+"
    r")(?![a-z0-9])"
)
_LOCATOR = re.compile(
    r"\b(table\b|fig(?:ure)?\b\.?|clause\b|section\b|sec\.|chapter\b|pages?\b|p\.)"
    r"\s*([a-z]?\d+(?:[.\-]\d+)*)"
    r"|([表图])\s*([a-z]?\d+(?:[.\-]\d+)*)"
    r"|第\s*(\d+(?:[.\-]\d+)*)\s*([章节条页])"
)
_LOCATOR_KIND = {
    "表": "table", "图": "figure", "fig": "figure", "条": "clause",
    "章": "chapter", "节": "section", "页": "page", "p": "page", "pages": "page",
    "sec": "section",
}
_IDENTITY_METADATA = {
    "doi", "version", "edition", "document version", "standard number",
    "版本", "版本号", "版次", "标准编号", "标准号", "规范编号",
}
_DISCOVERY_MARKERS = (
    "metadata_only", "summary_available", "abstract_only", "landing page",
    "national_standard_metadata", "标准正文需合法渠道获取",
)
_DASH_TRANSLATION = str.maketrans({"–": "-", "—": "-", "−": "-", "‑": "-"})


def _reference_text(text: str) -> str:
    return unicodedata.normalize("NFKC", text).casefold().translate(_DASH_TRANSLATION)


def _source_identifiers(text: str) -> set[str]:
    identifiers = set()
    for match in _SOURCE_IDENTIFIER.finditer(_reference_text(text)):
        value = re.sub(r"\s+", "", match.group()).rstrip(".,;)")
        if not value.startswith("10."):
            value = value.replace("/", "").replace(":", "-")
            value = re.sub(r"^fema-?([pe])?-?", r"fema\1", value)
            value = re.sub(r"^hazus[a-z]+", "hazus", value)
        identifiers.add(value)
    return identifiers


def _locators(text: str) -> set[tuple[str, str]]:
    locators = set()
    for english, english_number, chinese, chinese_number, ordinal, suffix in _LOCATOR.findall(
        _reference_text(text)
    ):
        kind = (english or chinese or suffix).rstrip(".")
        locators.add((_LOCATOR_KIND.get(kind, kind), english_number or chinese_number or ordinal))
    return locators


def _document_identifiers(title: str, path: str, citation: str, metadata: dict[str, str]) -> set[str]:
    identifiers = _source_identifiers(f"{title}\n{path}\n{citation}")
    for name, value in metadata.items():
        if name.casefold().replace("_", " ") in _IDENTITY_METADATA:
            identifiers.update(_source_identifiers(value))
    return identifiers


def _matching_identifiers(query: set[str], document: set[str]) -> set[str]:
    # Queries often omit the edition year of a standard. An explicit year or DOI
    # still has to match in full.
    editionless = {
        re.sub(r"-[12][0-9]{3}$", "", identifier)
        for identifier in document if not identifier.startswith("10.")
    }
    return query & (document | editionless)


def _discovery_only(metadata: dict[str, str]) -> bool:
    values = " ".join(
        metadata.get(name, "")
        for name in ("内容状态", "采集状态", "资料类别", "版本", "访问与版权")
    ).casefold()
    return metadata.get("仅保存元数据") == "是" or any(
        marker in values for marker in _DISCOVERY_MARKERS
    )


def _catalog_excerpt(content: str) -> bool:
    """Recognize actual TOC excerpts, including flattened PDF dotted leaders.

    An isolated figure caption, a decimal, or a prose mention of a catalogue is
    not enough. This is a query-time qualifier; saved chunks and vectors stay
    unchanged.
    """
    text = unicodedata.normalize("NFKC", content)
    leaders = re.findall(r"(?:\.{3,}|…{2,}|·{4,})\s*(?:\d{1,4}|[ivxlcdm]{1,8})(?=\s|$)", text, re.I)
    if len(leaders) >= 2:
        return True
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    entries = [line for line in lines if re.search(
        r"^(?:(?:图|表)\s*[A-Za-z]?\d+(?:[.\-]\d+)*|\d+(?:\.\d+){0,3})\s*\S.{2,80}\s+\d{1,4}$", line
    )]
    return len(entries) >= 3 and len(entries) / max(len(lines), 1) >= .6


def _catalog_request(query: str) -> bool:
    if re.search(r"(?:不要|不看|排除|无需|不是).{0,8}(?:目录|目次|图表索引)", query):
        return False
    return bool(re.search(r"目录|目次|图表索引|table\s+of\s+contents", query, re.I))


def _metadata_excerpt(content: str) -> bool:
    lines = [line.strip() for line in content.splitlines() if line.strip()]
    fields = sum(bool(re.match(
        r"^(?:[-*]\s*)?(?:题名|作者|年份|版本|版次|文献ID|主题|原始来源|筛选关键词|筛选依据|Title|Author|Year|DOI)\s*[:：]", line, re.I
    )) for line in lines)
    return fields >= 2 and fields / max(len(lines), 1) >= .75


def _header_metadata(text: str) -> dict[str, str]:
    """Read declared unbulleted paper headers without reinterpreting the body.

    Older immutable indexes stored only bullet metadata. Keep that indexed
    dictionary for integrity checks, then supplement display qualifiers from the
    verified source header. Page numbers and authors are never inferred.
    """
    allowed = {"题名", "文献ID", "主题", "原始来源", "作者", "年份", "版次", "版本", "版本号",
               "有效状态", "现行状态", "生效日期", "实施日期", "适用范围", "官方来源", "来源链接", "URL"}
    declared: list[str] = []
    for line in text.splitlines()[:40]:
        if re.match(r"\s*(?:---\s*正文|#{1,6}\s|---\s*$)", line):
            break
        match = re.match(r"^\s*(?:[-*]\s*)?([^:：]{1,40})[:：]\s*(.+?)\s*$", line)
        if match and match.group(1).strip() in allowed:
            declared.append("- " + match.group(1).strip() + ": " + match.group(2).strip())
        elif declared and not line.strip():
            break
    return document_metadata("\n".join(declared))


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _source_files(root: Path) -> list[Path]:
    files: list[Path] = []
    for path in root.rglob("*"):
        if not path.is_file() or path.suffix.lower() not in SUPPORTED_SUFFIXES:
            continue
        relative = path.relative_to(root)
        parent_parts = set(relative.parts[:-1])
        if parent_parts & EXCLUDED_PARTS or parent_parts & SOURCE_DROPZONES:
            continue
        files.append(path)
    return sorted(files)


def _source_signature(root: Path, paths: Iterable[Path] | None = None) -> dict[str, int]:
    file_list = list(paths) if paths is not None else _source_files(root)
    total_size = 0
    latest_mtime_ns = 0
    for path in file_list:
        stat = path.stat()
        total_size += stat.st_size
        latest_mtime_ns = max(latest_mtime_ns, stat.st_mtime_ns)
    return {
        "file_count": len(file_list),
        "total_size": total_size,
        "latest_mtime_ns": latest_mtime_ns,
    }


def _read_text(path: Path, source_bytes: bytes | None = None) -> str:
    raw = path.read_bytes() if source_bytes is None else source_bytes
    text = raw.decode("utf-8", errors="replace").replace("\x00", "")
    if path.suffix.lower() == ".json":
        try:
            text = json.dumps(json.loads(text), ensure_ascii=False, indent=2)
        except json.JSONDecodeError:
            pass
    return text


def _indexable_text(text: str) -> str:
    """Remove broad catalog labels that otherwise dominate semantic retrieval."""
    return "\n".join(
        line for line in text.splitlines() if not INDEX_EXCLUDED_METADATA.match(line)
    )


def _title(text: str, path: Path) -> str:
    for line in text.splitlines()[:30]:
        stripped = line.strip()
        for prefix in TITLE_PREFIXES:
            if stripped.startswith(prefix):
                value = stripped[len(prefix) :].strip()
                if value:
                    return value
        if stripped.startswith("# "):
            return stripped[2:].strip() or path.stem
    return path.stem


def _source_type(relative_path: Path, metadata: dict[str, str]) -> str:
    parts = set(relative_path.parts)
    if "papers" in parts:
        return "paper"
    if "standards" in parts:
        return "standard"
    if "policies" in parts:
        return "policy"
    if "reports" in parts:
        return "report"
    if "cases" in parts or "disaster_knowledge" in parts:
        return "case_or_disaster_knowledge"
    if "authoritative_discovery" in parts or "online_sources" in parts:
        return metadata.get("资料类别") or metadata.get("证据用途") or "authoritative_source"
    return "knowledge_document"


def _source_url(metadata: dict[str, str]) -> str | None:
    for key in URL_KEYS:
        value = metadata.get(key)
        if value and value.startswith(("http://", "https://")):
            return value
    return None


def _section_blocks(text: str) -> list[tuple[str | None, str]]:
    blocks: list[tuple[str | None, str]] = []
    section: str | None = None
    buffer: list[str] = []
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("#"):
            if buffer:
                content = "\n".join(buffer).strip()
                if content:
                    blocks.append((section, content))
                buffer = []
            section = stripped.lstrip("#").strip() or None
        elif stripped:
            buffer.append(stripped)
        elif buffer:
            content = "\n".join(buffer).strip()
            if content:
                blocks.append((section, content))
            buffer = []
    if buffer:
        content = "\n".join(buffer).strip()
        if content:
            blocks.append((section, content))
    return blocks or [(None, text.strip())]


def _chunks(text: str, chunk_characters: int, overlap: int) -> list[tuple[str | None, str]]:
    output: list[tuple[str | None, str]] = []
    for section, content in _section_blocks(text):
        if len(content) <= chunk_characters:
            output.append((section, content))
            continue
        start = 0
        while start < len(content):
            end = min(start + chunk_characters, len(content))
            if end < len(content):
                boundary = max(content.rfind("。", start, end), content.rfind("\n", start, end))
                if boundary > start + chunk_characters // 2:
                    end = boundary + 1
            output.append((section, content[start:end].strip()))
            if end >= len(content):
                break
            start = max(end - overlap, start + 1)
    return [(section, content) for section, content in output if content]


def _expanded_text(text: str) -> str:
    additions: list[str] = []
    lowered = text.lower()
    for anchor, synonyms in DOMAIN_SYNONYMS.items():
        if anchor.lower() in lowered:
            additions.extend(synonyms)
    return f"{text} {' '.join(additions)}" if additions else text


def _search_tokens(text: str, limit: int = 1600) -> list[str]:
    counter: Counter[str] = Counter(_terms(_expanded_text(text)))
    return [term for term, _ in counter.most_common(limit)]


def _hash_vector(text: str, dimension: int, title: str | None = None) -> np.ndarray:
    vector = np.zeros(dimension, dtype=np.float32)
    counts = Counter(_search_tokens(text, limit=2400))
    if title:
        for term in _search_tokens(title, limit=200):
            counts[term] += 3
    for term, count in counts.items():
        digest = hashlib.blake2b(term.encode("utf-8"), digest_size=8).digest()
        raw = int.from_bytes(digest, "little", signed=False)
        index = raw % dimension
        sign = 1.0 if (raw >> 63) == 0 else -1.0
        vector[index] += sign * (1.0 + math.log(float(count)))
    norm = float(np.linalg.norm(vector))
    if norm:
        vector /= norm
    return vector


def _citation(title: str, metadata: dict[str, str], source_url: str | None, text: str) -> tuple[str, str | None]:
    institution = metadata.get("发布机构") or metadata.get("来源机构") or metadata.get("作者")
    year = metadata.get("发布日期") or metadata.get("发布或事件日期") or metadata.get("年份")
    pieces = [item for item in (institution, year, title) if item]
    citation = ". ".join(pieces)
    if source_url:
        citation = f"{citation}. {source_url}" if citation else source_url
    locator = None
    blocks = _section_blocks(text)
    for section, content in blocks:
        if section and any(anchor.lower() in section.lower() for anchor in LOCATOR_HEADINGS):
            locator = content[:500].strip()
            break
    return citation or title, locator


def _authority_score(metadata: dict[str, str], source_type: str) -> float:
    joined = " ".join(metadata.values()).lower()
    if "a_policy_framework" in joined or source_type in {"standard", "policy"}:
        return 1.0
    if "b_technical_guidance" in joined or "official" in joined or "官方" in joined:
        return 0.9
    if source_type == "paper":
        return 0.8
    if "c_case_evidence" in joined or "case" in source_type:
        return 0.7
    return 0.5


class KnowledgeIndexBuilder:
    def __init__(
        self,
        knowledge_root: Path,
        *,
        vector_dimension: int = DEFAULT_VECTOR_DIMENSION,
        chunk_characters: int = DEFAULT_CHUNK_CHARACTERS,
        chunk_overlap: int = DEFAULT_CHUNK_OVERLAP,
        index_directory: Path | None = None,
    ) -> None:
        self.root = Path(knowledge_root).resolve()
        self.index_root = index_directory or self.root / "index"
        self.database_path = self.index_root / "knowledge.sqlite3"
        self.vectors_path = self.index_root / "document_vectors.npz"
        self.faiss_path = self.index_root / "document_vectors.faiss"
        self.manifest_path = self.index_root / "manifest.json"
        self.vector_dimension = vector_dimension
        self.chunk_characters = chunk_characters
        self.chunk_overlap = chunk_overlap

    def status(self) -> dict[str, Any]:
        manifest: dict[str, Any] = {}
        if self.manifest_path.exists():
            try:
                manifest = json.loads(self.manifest_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                manifest = {}
        current_signature = _source_signature(self.root)
        ready = self.database_path.is_file() and self.vectors_path.is_file() and bool(manifest)
        compatible = (
            manifest.get("schema_version") == INDEX_SCHEMA_VERSION
            and manifest.get("embedding_model") == EMBEDDING_MODEL_VERSION
        )
        return {
            **manifest,
            "ready": ready,
            "stale": (
                not ready
                or not compatible
                or manifest.get("source_signature") != current_signature
            ),
            "database_path": str(self.database_path),
            "vectors_path": str(self.vectors_path),
        }

    def build(self, force: bool = False) -> dict[str, Any]:
        paths = _source_files(self.root)
        source_signature = _source_signature(self.root, paths)
        existing = self.status()
        if not force and existing.get("ready") and not existing.get("stale"):
            return existing
        self.index_root.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="seismo-kb-", dir=self.index_root) as directory:
            temporary = Path(directory)
            database_path = temporary / "knowledge.sqlite3"
            vectors_path = temporary / "document_vectors.npz"
            connection = sqlite3.connect(database_path)
            connection.executescript(
                """
                PRAGMA journal_mode=OFF;
                PRAGMA synchronous=OFF;
                CREATE TABLE documents (
                    row_id INTEGER PRIMARY KEY,
                    document_id TEXT NOT NULL UNIQUE,
                    title TEXT NOT NULL,
                    source_path TEXT NOT NULL,
                    relative_path TEXT NOT NULL,
                    source_type TEXT NOT NULL,
                    source_url TEXT,
                    citation TEXT,
                    locator TEXT,
                    authority REAL NOT NULL,
                    metadata_json TEXT NOT NULL
                );
                CREATE TABLE chunks (
                    chunk_id TEXT PRIMARY KEY,
                    document_row_id INTEGER NOT NULL,
                    section TEXT,
                    content TEXT NOT NULL,
                    search_tokens TEXT NOT NULL
                );
                CREATE INDEX chunks_document_idx ON chunks(document_row_id);
                CREATE VIRTUAL TABLE chunk_fts USING fts5(
                    chunk_id UNINDEXED,
                    document_row_id UNINDEXED,
                    search_tokens,
                    title,
                    content,
                    tokenize='unicode61 remove_diacritics 2'
                );
                """
            )
            vectors = np.zeros((len(paths), self.vector_dimension), dtype=np.float32)
            indexed_documents = 0
            indexed_chunks = 0
            for row_id, path in enumerate(paths):
                text = _read_text(path)
                if not text.strip():
                    continue
                relative = path.relative_to(self.root)
                title = _title(text, path)
                metadata = document_metadata(text)
                source_type = _source_type(relative, metadata)
                source_url = _source_url(metadata)
                citation, locator = _citation(title, metadata, source_url, text)
                document_id = hashlib.sha256(str(relative).encode("utf-8")).hexdigest()[:20]
                authority = _authority_score(metadata, source_type)
                connection.execute(
                    "INSERT INTO documents VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        row_id,
                        document_id,
                        title,
                        str(path.resolve()),
                        str(relative),
                        source_type,
                        source_url,
                        citation,
                        locator,
                        authority,
                        json.dumps(metadata, ensure_ascii=False),
                    ),
                )
                vector_text = _indexable_text(text)[:16000]
                vectors[row_id] = _hash_vector(vector_text, self.vector_dimension, title=title)
                for chunk_index, (section, content) in enumerate(
                    _chunks(text, self.chunk_characters, self.chunk_overlap)
                ):
                    chunk_id = f"{document_id}-{chunk_index:04d}"
                    indexable_content = _indexable_text(content)
                    search_tokens = " ".join(
                        _search_tokens(f"{title} {section or ''} {indexable_content}")
                    )
                    connection.execute(
                        "INSERT INTO chunks VALUES (?, ?, ?, ?, ?)",
                        (chunk_id, row_id, section, content, search_tokens),
                    )
                    connection.execute(
                        "INSERT INTO chunk_fts VALUES (?, ?, ?, ?, ?)",
                        (chunk_id, row_id, search_tokens, title, indexable_content),
                    )
                    indexed_chunks += 1
                indexed_documents += 1
                if indexed_documents % 500 == 0:
                    connection.commit()
            connection.commit()
            connection.close()
            np.savez_compressed(vectors_path, vectors=vectors)
            vector_backend = "numpy"
            try:
                import faiss  # type: ignore

                index = faiss.IndexFlatIP(self.vector_dimension)
                index.add(vectors)
                faiss.write_index(index, str(temporary / "document_vectors.faiss"))
                vector_backend = "faiss"
            except (ImportError, OSError, RuntimeError):
                pass
            manifest = {
                "schema_version": INDEX_SCHEMA_VERSION,
                "built_at": _utc_now(),
                "source_signature": source_signature,
                "document_count": indexed_documents,
                "chunk_count": indexed_chunks,
                "vector_dimension": self.vector_dimension,
                "embedding_model": EMBEDDING_MODEL_VERSION,
                "vector_backend": vector_backend,
                "sparse_backend": "sqlite_fts5",
                "reranker": RERANKER_VERSION,
            }
            (temporary / "manifest.json").write_text(
                json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
            )
            os.replace(database_path, self.database_path)
            os.replace(vectors_path, self.vectors_path)
            temporary_faiss = temporary / "document_vectors.faiss"
            if temporary_faiss.exists():
                os.replace(temporary_faiss, self.faiss_path)
            elif self.faiss_path.exists():
                self.faiss_path.unlink()
            os.replace(temporary / "manifest.json", self.manifest_path)
        return self.status()


class HybridKnowledgeRetriever:
    """Persistent hybrid retriever with vector, FTS5, reranking and citation metadata."""

    def __init__(
        self,
        knowledge_root: Path,
        *,
        auto_build: bool = False,
        fallback: DirectoryKnowledgeRetriever | None = None,
        ranking: str = "stage_aware",
    ) -> None:
        if ranking not in {"stage_aware", "baseline"}:
            raise ValueError(f"Unknown knowledge ranking mode: {ranking!r}")
        self.ranking = ranking
        self.root = Path(knowledge_root).resolve()
        self.builder = KnowledgeIndexBuilder(self.root)
        from .semantic_knowledge import SemanticKnowledgeIndex
        semantic = SemanticKnowledgeIndex(self.root)
        self.semantic = semantic if semantic.status().get("ready") else None
        if self.semantic is not None:
            self.builder = semantic
        self.fallback = fallback or DirectoryKnowledgeRetriever(self.root)
        self._vectors: np.ndarray | None = None
        self._faiss: Any = None
        self._loaded_revision: str | None = None
        if auto_build and not self.builder.status().get("ready"):
            self.builder.build()

    def status(self) -> dict[str, Any]:
        status = self.builder.status()
        status["retrieval_mode"] = "llamaindex_semantic_faiss" if self.semantic else "legacy_feature_hashing"
        status["degraded"] = self.semantic is None
        status["ranking"] = self.ranking
        if status["ready"] and status["stale"]:
            status["evidence_status"] = "stale_index_withheld"
            status["index_revision"] = None
            status["evidence_available"] = False
        elif not status["ready"]:
            status["evidence_status"] = "live_directory_advisory"
            status["index_revision"] = None
            status["evidence_available"] = True
        else:
            identity = {key: status.get(key) for key in (
                "built_at", "source_signature", "schema_version", "vector_sha256", "retrieval_mode",
            )}
            status["evidence_status"] = "indexed_advisory"
            status["index_revision"] = hashlib.sha256(
                json.dumps(identity, sort_keys=True).encode("utf-8")
            ).hexdigest()
            status["evidence_available"] = True
        return status

    def _source_bytes(self, path: Path) -> bytes | None:
        try:
            resolved = path.resolve()
            return resolved.read_bytes() if resolved.is_relative_to(self.root) else None
        except (OSError, RuntimeError):
            return None

    def current_evidence(self, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Recheck retained evidence before a new decision or revision uses it."""
        status = self.status()
        if not status["evidence_available"]:
            return []
        revision = status["index_revision"]
        current = []
        for item in items:
            if item.get("index_revision") != revision or not item.get("source_sha256"):
                continue
            path = item.get("source_path")
            if not isinstance(path, str) or not path:
                continue
            source_bytes = self._source_bytes(Path(path))
            if source_bytes is None or hashlib.sha256(source_bytes).hexdigest() != item["source_sha256"]:
                continue
            current.append({
                **item,
                "evidence_use": "advisory_only",
                "time_validity": evidence_time_validity(item.get("effective_from"), item.get("effective_until")),
            })
        return current

    def _load_vectors(self) -> np.ndarray:
        if self._vectors is None:
            self._vectors = np.load(self.builder.vectors_path)["vectors"].astype(np.float32)
        return self._vectors

    def _vector_candidates(self, query: str, limit: int) -> dict[int, float]:
        status = self.builder.status()
        dimension = int(status.get("vector_dimension") or DEFAULT_VECTOR_DIMENSION)
        query_vector = _hash_vector(query, dimension)
        if not np.any(query_vector):
            return {}
        if status.get("vector_backend") == "faiss" and self.builder.faiss_path.exists():
            try:
                if self._faiss is None:
                    import faiss  # type: ignore

                    self._faiss = faiss.read_index(str(self.builder.faiss_path))
                scores, indices = self._faiss.search(query_vector.reshape(1, -1), limit)
                return {
                    int(index): max(float(score), 0.0)
                    for index, score in zip(indices[0], scores[0], strict=True)
                    if index >= 0
                }
            except (ImportError, OSError, RuntimeError):
                pass
        vectors = self._load_vectors()
        scores = vectors @ query_vector
        count = min(limit, scores.size)
        if count <= 0:
            return {}
        indices = np.argpartition(scores, -count)[-count:]
        indices = indices[np.argsort(scores[indices])[::-1]]
        return {int(index): max(float(scores[index]), 0.0) for index in indices}

    @staticmethod
    def _fts_query(query: str) -> str:
        terms = _search_tokens(query, limit=80)
        safe = [f'"{term.replace(chr(34), "")}"' for term in terms if term.strip()]
        return " OR ".join(safe)

    def _sparse_candidates(
        self,
        connection: sqlite3.Connection,
        query: str,
        limit: int,
    ) -> dict[str, dict[str, Any]]:
        expression = self._fts_query(query)
        if not expression:
            return {}
        rows = connection.execute(
            """
            SELECT chunk_id, CAST(document_row_id AS INTEGER) AS document_row_id,
                   title, content, bm25(chunk_fts, 0.0, 0.0, 1.8, 3.0, 1.0) AS rank
            FROM chunk_fts WHERE chunk_fts MATCH ? ORDER BY rank LIMIT ?
            """,
            (expression, limit),
        ).fetchall()
        raw_scores = [max(-float(row[4]), 0.0) for row in rows]
        maximum = max(raw_scores, default=1.0) or 1.0
        return {
            str(row[0]): {
                "document_row_id": int(row[1]),
                "sparse": raw / maximum,
            }
            for row, raw in zip(rows, raw_scores, strict=True)
        }

    @staticmethod
    def _best_chunk_for_document(
        connection: sqlite3.Connection,
        document_row_id: int,
        query_terms: set[str],
    ) -> str | None:
        rows = connection.execute(
            "SELECT chunk_id, section, content FROM chunks WHERE document_row_id=?",
            (document_row_id,),
        ).fetchall()
        if not rows:
            return None
        return max(
            rows,
            key=lambda row: len(
                query_terms & _terms(_indexable_text(f"{row[1] or ''} {row[2]}"))
            ),
        )[0]

    @staticmethod
    def _identifier_candidates(
        connection: sqlite3.Connection,
        identities: set[str],
        locators: set[tuple[str, str]],
        query_terms: set[str],
    ) -> dict[str, dict[str, Any]]:
        """Recover exact cited documents even if vector and BM25 top-N omitted them."""
        candidates: dict[str, dict[str, Any]] = {}
        for identifier in sorted(identities):
            # Scan the small document catalog, then use the existing chunk FK index.
            if identifier.startswith("10.") and "/" in identifier:
                fragment = identifier.split("/", 1)[1]
            else:
                fragment = re.search(r"[0-9]+", identifier).group()
            like = f"%{fragment}%"
            rows = connection.execute(
                """
                SELECT row_id, title, relative_path, citation, metadata_json
                FROM documents
                WHERE title LIKE ? OR relative_path LIKE ? OR citation LIKE ?
                      OR metadata_json LIKE ?
                ORDER BY authority DESC, relative_path
                """,
                (like, like, like, like),
            )
            matched = 0
            for row in rows:
                if not _matching_identifiers(
                    {identifier}, _document_identifiers(row[1], row[2], row[3], json.loads(row[4]))
                ):
                    continue
                chunks = connection.execute(
                    "SELECT chunk_id, section, content FROM chunks WHERE document_row_id=?",
                    (row[0],),
                ).fetchall()
                chunks.sort(
                    key=lambda chunk: (
                        -len(locators & _locators(f"{chunk[1] or ''} {chunk[2]}")),
                        -len(query_terms & _terms(_indexable_text(f"{chunk[1] or ''} {chunk[2]}"))),
                        chunk[0],
                    )
                )
                for chunk in chunks[:8]:
                    candidates.setdefault(str(chunk[0]), {"document_row_id": row[0]})
                matched += 1
                if matched == 12:
                    break
        return candidates

    def retrieve(
        self,
        queries: list[str],
        limit: int = 6,
        filters: dict[str, Any] | None = None,
    ) -> list[KnowledgeEvidence]:
        status = self.status()
        if not status["evidence_available"]:
            return []
        if not status.get("ready"):
            return self.fallback.retrieve(queries, limit=limit)
        revision = status["index_revision"]
        if revision != self._loaded_revision:
            self._loaded_revision = revision
            self._vectors = None
            self._faiss = None
        query = " ".join(item.strip() for item in queries if item.strip())
        if not query:
            return []
        catalog_requested = _catalog_request(query)
        identities = _source_identifiers(query) if self.ranking == "stage_aware" else set()
        locators = _locators(query) if self.ranking == "stage_aware" else set()
        raw_query_terms = _terms(query)
        query_terms = _terms(_expanded_text(query))
        vector_candidates = {} if self.semantic else self._vector_candidates(query, max(limit * 12, 60))
        connection = sqlite3.connect(self.builder.database_path)
        connection.row_factory = sqlite3.Row
        sparse_candidates = self._sparse_candidates(connection, query, max(limit * 20, 100))
        candidates: dict[str, dict[str, Any]] = dict(sparse_candidates)
        if self.semantic:
            for chunk_id, semantic_item in self.semantic.candidates(query, max(limit * 20, 120)).items():
                item = candidates.setdefault(chunk_id, semantic_item)
                item["vector"] = semantic_item["vector"]
        for document_row_id, vector_score in vector_candidates.items():
            chunk_id = self._best_chunk_for_document(connection, document_row_id, query_terms)
            if chunk_id is None:
                continue
            item = candidates.setdefault(
                chunk_id,
                {"document_row_id": document_row_id, "sparse": 0.0},
            )
            item["vector"] = vector_score
        for chunk_id, exact_candidate in self._identifier_candidates(
            connection, identities, locators, raw_query_terms
        ).items():
            candidates.setdefault(chunk_id, exact_candidate)
        requested_source_types = set((filters or {}).get("source_types", []))
        requested_skills = set((filters or {}).get("skill_ids", []))
        ranked: list[tuple[tuple[float, ...], KnowledgeEvidence, str, dict[str, str]]] = []
        for chunk_id, retrieval in candidates.items():
            row = connection.execute(
                """
                SELECT c.section, c.content, d.document_id, d.title, d.source_path,
                       d.source_type, d.source_url, d.citation, d.locator, d.authority,
                       d.metadata_json, d.relative_path
                FROM chunks c JOIN documents d ON d.row_id=c.document_row_id
                WHERE c.chunk_id=?
                """,
                (chunk_id,),
            ).fetchone()
            if row is None:
                continue
            if requested_source_types and row[5] not in requested_source_types:
                continue
            metadata = json.loads(row[10])
            supported = _terms(metadata.get("支撑的 Engineering Skills", ""))
            if requested_skills and not requested_skills.intersection(supported):
                skill_boost = 0.0
            elif requested_skills:
                skill_boost = 0.06
            else:
                skill_boost = 0.0
            title_terms = _terms(row[3])
            title_matches = len(raw_query_terms & title_terms)
            title_recall = title_matches / max(len(raw_query_terms), 1)
            title_precision = title_matches / max(len(title_terms), 1)
            title_relevance = (
                2.0 * title_recall * title_precision / (title_recall + title_precision)
                if title_recall + title_precision
                else 0.0
            )
            content_overlap = len(
                raw_query_terms & _terms(_indexable_text(row[1]))
            ) / max(len(raw_query_terms), 1)
            vector_score = float(retrieval.get("vector", vector_candidates.get(int(retrieval["document_row_id"]), 0.0)))
            sparse_score = float(retrieval.get("sparse", 0.0))
            authority = float(row[9])
            score = min(
                1.0,
                0.34 * vector_score
                + 0.24 * sparse_score
                + 0.22 * min(title_relevance * 2.5, 1.0)
                + 0.08 * min(content_overlap * 2.0, 1.0)
                + 0.06 * authority
                + skill_boost,
            )
            qualifiers = evidence_document_fields(metadata)
            rank_key: tuple[float, ...] = (score,)
            reference_features: dict[str, float] = {}
            if self.ranking == "stage_aware":
                identifier_matches = len(_matching_identifiers(
                    identities, _document_identifiers(row[3], row[11], row[7], metadata)
                )) if identities else 0
                excerpt_matches = len(locators & _locators(f"{row[0] or ''} {row[1]}")) if locators else 0
                catalog_excerpt = _catalog_excerpt(row[1])
                metadata_excerpt = _metadata_excerpt(row[1])
                catalog_only = _discovery_only(metadata) or catalog_excerpt or metadata_excerpt
                inactive = qualifiers["time_validity"] in {"expired", "not_yet_effective"} or (
                    qualifiers["document_status"] in {"withdrawn", "superseded", "historical"}
                )
                direct_locator_matches = excerpt_matches if not catalog_only else 0
                # A named source takes precedence. An unqualified table number is
                # common across sources, so it only boosts an otherwise relevant hit.
                if identities:
                    rank_key = (float(identifier_matches), float(not catalog_only) if not catalog_requested else 0.0, float(direct_locator_matches), score)
                elif locators:
                    rank_key = (float(not catalog_only) if not catalog_requested else 0.0, score + 0.08 * min(direct_locator_matches, 2))
                elif not catalog_requested:
                    rank_key = (float(not catalog_only), score)
                reference_features = {
                    "identifier_matches": float(identifier_matches),
                    "excerpt_locator_matches": float(direct_locator_matches),
                    "catalog_only": float(catalog_only),
                    "catalog_excerpt": float(catalog_excerpt),
                    "metadata_excerpt": float(metadata_excerpt),
                    "inactive_document": float(inactive),
                }
            evidence = KnowledgeEvidence(
                evidence_id=f"kb-{chunk_id}",
                title=row[3],
                source_path=str(self.root / row[11]),
                section=row[0],
                content=row[1][:2600],
                score=max(score, 0.0),
                source_type=row[5],
                source_url=row[6],
                locator=row[8],
                citation=row[7],
                index_revision=revision,
                **qualifiers,
                retrieval_scores={
                    **reference_features,
                    "vector": vector_score,
                    "sparse": sparse_score,
                    "title": title_relevance,
                    "title_recall": title_recall,
                    "title_precision": title_precision,
                    "content": content_overlap,
                    "authority": authority,
                    "semantic_model": 1.0 if self.semantic else 0.0,
                },
            )
            ranked.append((rank_key, evidence, row[1], metadata))
        connection.close()
        selected: list[KnowledgeEvidence] = []
        seen_paths: set[str] = set()
        source_counts: Counter[str] = Counter()
        for _, evidence, indexed_excerpt, indexed_metadata in sorted(
            ranked, key=lambda item: (tuple(-value for value in item[0]), item[1].source_path)
        ):
            if evidence.source_path in seen_paths:
                continue
            if source_counts[evidence.source_type or "unknown"] >= max(2, math.ceil(limit / 2)):
                continue
            path = Path(evidence.source_path)
            source_bytes = self._source_bytes(path)
            if source_bytes is None:
                continue
            # Older case indexes used a coarse corpus signature. Check selected
            # excerpts and their qualifiers against the source before serving them.
            source_text = _read_text(path, source_bytes)
            if (
                _title(source_text, path) != evidence.title
                or document_metadata(source_text) != indexed_metadata
                or not any(
                    section == evidence.section and indexed_excerpt in section_text
                    for section, section_text in _section_blocks(source_text)
                )
            ):
                continue
            display_metadata = {**_header_metadata(source_text), **indexed_metadata}
            citation, _ = _citation(evidence.title, display_metadata, evidence.source_url, source_text)
            selected.append(evidence.model_copy(update={
                "source_sha256": hashlib.sha256(source_bytes).hexdigest(),
                **evidence_document_fields(display_metadata),
                "citation": citation,
            }))
            seen_paths.add(evidence.source_path)
            source_counts[evidence.source_type or "unknown"] += 1
            if len(selected) >= limit:
                break
        return selected
