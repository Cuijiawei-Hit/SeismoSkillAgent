from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import sqlite3
from typing import Any
import uuid

import numpy as np


MODEL_NAME = "SeismoSkill/multilingual-MiniLM-L12-v2-fp16"
MODEL_REPOSITORY = "Xenova/paraphrase-multilingual-MiniLM-L12-v2"
SCHEMA_VERSION = 3
_MODELS: dict[str, Any] = {}


def embedding_model(root: Path):
    from .knowledge_snapshot import read_lock, locked_embedding
    _, lock_identity = read_lock(root)
    explicit_providers = os.getenv('SEISMO_EMBEDDING_PROVIDERS')
    key = str(root.resolve()) + ':' + str(lock_identity) + ':' + str(explicit_providers)
    if key not in _MODELS:
        from fastembed import TextEmbedding
        from fastembed.common.model_description import ModelSource, PoolingType
        import onnxruntime as ort

        if MODEL_NAME not in {item["model"] for item in TextEmbedding.list_supported_models()}:
            TextEmbedding.add_custom_model(
                model=MODEL_NAME, pooling=PoolingType.MEAN, normalization=True,
                sources=ModelSource(hf=MODEL_REPOSITORY), dim=384,
                model_file="onnx/model_fp16.onnx", size_in_gb=0.235,
                description="Multilingual sentence embeddings; mean pooling and L2 normalization",
            )
        providers = ["CPUExecutionProvider"]
        if explicit_providers is not None:
            providers = [part.strip() for part in explicit_providers.split(',') if part.strip()]
            if not providers or any(provider not in ort.get_available_providers() for provider in providers):
                raise ValueError('SEISMO_EMBEDDING_PROVIDERS must name available ONNX execution providers')
        elif "CUDAExecutionProvider" in ort.get_available_providers():
            if hasattr(ort, "preload_dlls"):
                ort.preload_dlls()
            providers.insert(0, "CUDAExecutionProvider")
        pin = locked_embedding(root, model_name=MODEL_NAME, repository=MODEL_REPOSITORY)
        _MODELS[key] = TextEmbedding(
            MODEL_NAME, cache_dir=str(root / "index" / "models"), threads=4,
            providers=providers,
            **{k:v for k,v in pin.items() if k in {'specific_model_path','local_files_only'}},
        )
    return _MODELS[key]


def _write_json(path: Path, payload: dict) -> None:
    temporary = path.with_suffix(".pending.json")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temporary, path)


class SemanticKnowledgeIndex:
    """Versioned LlamaIndex/FAISS index with complete source-chunk lineage."""

    def __init__(self, root: Path):
        self.root = Path(root).resolve()
        self.pointer = self.root / "index" / "semantic-active.json"
        self.index_root = self.root / "index" / "semantic-v3"
        self.database_path = self.index_root / "knowledge.sqlite3"
        self.faiss_path = self.index_root / "vectors.faiss"
        self.manifest_path = self.index_root / "manifest.json"
        self._store = None
        self._portable_verification = None
        if self.pointer.is_file():
            pointer = json.loads(self.pointer.read_text(encoding="utf-8"))
            candidate = (self.root / "index" / pointer["directory"]).resolve()
            if not candidate.is_relative_to((self.root / "index").resolve()):
                raise ValueError("Semantic index pointer leaves the knowledge index directory")
            self.index_root = candidate
            self.database_path = candidate / "knowledge.sqlite3"
            self.faiss_path = candidate / "vectors.faiss"
            self.manifest_path = candidate / "manifest.json"

    def status(self) -> dict[str, Any]:
        from .knowledge_index import _source_signature
        manifest = json.loads(self.manifest_path.read_text(encoding="utf-8")) if self.manifest_path.is_file() else {}
        ready = (manifest.get("schema_version") == SCHEMA_VERSION
                 and manifest.get("embedding_model") == MODEL_NAME
                 and self.database_path.is_file() and self.faiss_path.is_file()
                 and manifest.get("complete") is True)
        signature = _source_signature(self.root)
        stale = not ready or manifest.get("source_signature") != signature
        if ready and stale:
            # Extraction may change mtimes. Accept only a complete release whose
            # source bytes and active manifest match their retained content lock.
            from .knowledge_snapshot import read_lock, sha256
            from .knowledge_index import _source_files
            lock, identity = read_lock(self.root)
            key = (json.dumps(signature, sort_keys=True), identity)
            if self._portable_verification is None or self._portable_verification[0] != key:
                valid = False
                if lock and lock.get('corpus_files') and lock.get('index', {}).get('files'):
                    expected = lock['corpus_files']
                    actual = {p.relative_to(self.root).as_posix(): sha256(p) for p in _source_files(self.root)}
                    valid = (actual == expected
                             and self.index_root.resolve() == (self.root / lock['index']['directory']).resolve()
                             and sha256(self.manifest_path) == lock['index']['files'].get('manifest.json'))
                self._portable_verification = (key, valid)
            stale = not self._portable_verification[1]
        return {**manifest, "ready": ready, "stale": stale,
                "database_path": str(self.database_path), "vectors_path": str(self.faiss_path)}

    def build(self, force: bool = False) -> dict[str, Any]:
        from .knowledge_index import KnowledgeIndexBuilder, _indexable_text, _utc_now
        from llama_index.core.node_parser import SentenceSplitter
        from llama_index.core.schema import TextNode
        from llama_index.vector_stores.faiss import FaissVectorStore
        from tokenizers import Tokenizer
        import faiss

        existing = self.status()
        if not force and existing.get("ready") and not existing.get("stale"):
            return existing
        from .knowledge_snapshot import read_lock
        if read_lock(self.root)[0] is not None:
            raise ValueError('Knowledge release is locked; create a new explicit release before rebuilding')
        directory = self.root / "index" / "semantic-v3" / f"build-{uuid.uuid4().hex[:12]}"
        directory.mkdir(parents=True)
        lexical = KnowledgeIndexBuilder(self.root)
        lexical_status = lexical.status()
        if not lexical_status.get("ready") or lexical_status.get("stale"):
            lexical = KnowledgeIndexBuilder(self.root, index_directory=directory / "lexical")
            lexical_status = lexical.build(force=True)
        db_path = directory / "knowledge.sqlite3"
        with sqlite3.connect(lexical.database_path) as source, sqlite3.connect(db_path) as destination:
            source.backup(destination)
        model = embedding_model(self.root)
        tokenizer = Tokenizer.from_str(model.model.tokenizer.to_str())
        tokenizer.no_truncation()
        tokenizer.no_padding()
        # Match the model's 128-token context; never silently truncate a long evidence chunk.
        splitter = SentenceSplitter(chunk_size=112, chunk_overlap=16,
                                    tokenizer=lambda value: tokenizer.encode(value, add_special_tokens=False).ids)
        index = faiss.IndexFlatIP(384)
        store = FaissVectorStore(faiss_index=index)
        connection = sqlite3.connect(db_path)
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA synchronous=NORMAL")
        connection.execute("CREATE TABLE semantic_spans (vector_id INTEGER PRIMARY KEY, chunk_id TEXT NOT NULL, excerpt TEXT NOT NULL)")
        connection.execute("CREATE INDEX semantic_chunk_idx ON semantic_spans(chunk_id)")
        connection.commit()
        reader = sqlite3.connect(db_path)
        rows = reader.execute("SELECT chunk_id, content FROM chunks ORDER BY rowid")
        nodes: list[Any] = []
        origins: list[tuple[str, str]] = []
        processed = 0
        checkpoint = 0

        def flush() -> None:
            if not nodes:
                return
            vectors = list(model.embed([node.text for node in nodes], batch_size=64))
            for node, vector in zip(nodes, vectors, strict=True):
                vector = np.asarray(vector, dtype=np.float32)
                if not np.all(np.isfinite(vector)) or np.linalg.norm(vector) < 1e-6:
                    raise ValueError("Nonfinite or zero semantic embedding")
                node.embedding = (vector / np.linalg.norm(vector)).tolist()
            ids = store.add(nodes)
            connection.executemany("INSERT INTO semantic_spans VALUES (?, ?, ?)",
                                   [(int(key), chunk, excerpt) for key, (chunk, excerpt) in zip(ids, origins, strict=True)])
            nodes.clear()
            origins.clear()

        try:
            for chunk_id, content in rows:
                for part, excerpt in enumerate(splitter.split_text(_indexable_text(content))):
                    if not excerpt.strip():
                        continue
                    nodes.append(TextNode(id_=f"{chunk_id}-semantic-{part}", text=excerpt))
                    origins.append((chunk_id, excerpt))
                processed += 1
                if len(nodes) >= 512:
                    flush()
                if processed - checkpoint >= 1000:
                    connection.commit()
                    checkpoint = processed
                    progress = {"chunks_processed": processed, "total_chunks": lexical_status["chunk_count"],
                                "semantic_vectors": index.ntotal, "complete": False}
                    _write_json(directory / "progress.json", progress)
                    print(json.dumps(progress), flush=True)
            flush()
            connection.commit()
            count = connection.execute("SELECT COUNT(*) FROM semantic_spans").fetchone()[0]
            if count != index.ntotal or count == 0 or processed != lexical_status["chunk_count"]:
                raise ValueError("Semantic index coverage or vector mapping is incomplete")
        finally:
            reader.close()
            connection.close()
        # FAISS's filename API does not reliably support Windows Unicode paths.
        (directory / "vectors.faiss").write_bytes(faiss.serialize_index(index).tobytes())
        manifest = {
            "schema_version": SCHEMA_VERSION, "complete": True, "built_at": _utc_now(),
            "source_signature": lexical_status["source_signature"],
            "document_count": lexical_status["document_count"], "chunk_count": processed,
            "vector_count": int(index.ntotal), "vector_dimension": 384,
            "embedding_model": MODEL_NAME, "model_repository": MODEL_REPOSITORY,
            "vector_backend": "faiss", "sparse_backend": "sqlite_fts5",
            "parser": "llama_index.core.SentenceSplitter", "vector_store": "llama_index.vector_stores.faiss.FaissVectorStore",
            "chunk_tokens": 112, "overlap_tokens": 16, "reranker": "hybrid_evidence_reranker_v3",
            "coverage": "All indexed source chunks; semantic spans retain original chunk IDs and citations",
        }
        manifest["vector_sha256"] = hashlib.sha256((directory / "vectors.faiss").read_bytes()).hexdigest()
        _write_json(directory / "manifest.json", manifest)
        _write_json(self.pointer, {"directory": str(directory.relative_to(self.root / "index"))})
        self.__init__(self.root)
        return self.status()

    def candidates(self, query: str, limit: int) -> dict[str, dict[str, Any]]:
        from llama_index.core.vector_stores.types import VectorStoreQuery
        from llama_index.vector_stores.faiss import FaissVectorStore
        import faiss
        if self._store is None:
            data = self.faiss_path.read_bytes()
            manifest = json.loads(self.manifest_path.read_text(encoding="utf-8"))
            if hashlib.sha256(data).hexdigest() != manifest["vector_sha256"]:
                raise ValueError("Semantic vector index checksum mismatch")
            from .knowledge_snapshot import verify_locked_index
            verify_locked_index(self.root, self.index_root, hashlib.sha256(data).hexdigest())
            self._store = FaissVectorStore(faiss_index=faiss.deserialize_index(np.frombuffer(data, dtype=np.uint8).copy()))
        vector = next(embedding_model(self.root).query_embed(query))
        result = self._store.query(VectorStoreQuery(query_embedding=np.asarray(vector, dtype=float).tolist(), similarity_top_k=limit))
        candidates: dict[str, dict[str, Any]] = {}
        with sqlite3.connect(self.database_path) as connection:
            for key, score in zip(result.ids or [], result.similarities or [], strict=True):
                row = connection.execute("SELECT s.chunk_id, c.document_row_id FROM semantic_spans s JOIN chunks c ON c.chunk_id=s.chunk_id WHERE s.vector_id=?", (int(key),)).fetchone()
                if row and score > candidates.get(row[0], {}).get("vector", -1):
                    candidates[row[0]] = {"document_row_id": row[1], "vector": max(float(score), 0.0), "sparse": 0.0}
        return candidates
