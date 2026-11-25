"""Content-addressed local knowledge/embedding locks; never download or rebuild."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path


def sha256(path: Path) -> str:
    value = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(block)
    return value.hexdigest()


def _inside(root: Path, relative: str) -> Path:
    path = (root / relative).resolve()
    if not path.is_relative_to(root.resolve()):
        raise ValueError('Knowledge lock path leaves its root')
    return path


def read_lock(root: Path) -> tuple[dict | None, str | None]:
    explicit = os.getenv('SEISMO_KNOWLEDGE_LOCK')
    path = Path(explicit) if explicit else root.parent / 'reproducibility/knowledge.lock.json'
    if not path.is_file():
        if explicit:
            raise ValueError('Explicit SEISMO_KNOWLEDGE_LOCK does not exist')
        return None, None
    raw = path.read_bytes()
    lock = json.loads(raw)
    if lock.get('schema_version') != 1:
        raise ValueError('Unsupported knowledge lock schema')
    return lock, hashlib.sha256(raw).hexdigest()


def locked_embedding(root: Path, *, model_name: str, repository: str) -> dict:
    lock, identity = read_lock(root)
    if lock is None:
        return {}
    if lock['embedding']['model_name'] != model_name or lock['embedding']['repository'] != repository:
        raise ValueError('Knowledge lock embedding model does not match the configured model')
    directory = _inside(root, lock['embedding']['directory'])
    expected_files = lock['embedding']['files']
    if not expected_files:
        raise ValueError('Knowledge lock has no embedding file hashes')
    for name, expected in expected_files.items():
        path = _inside(directory, name)
        if not path.is_file() or sha256(path) != expected:
            raise ValueError(f'Pinned embedding content mismatch: {name}')
    return {'specific_model_path': str(directory), 'local_files_only': True,
            'lock_sha256': identity, 'cached_revision': lock['embedding']['cached_revision']}


def verify_locked_index(root: Path, index_root: Path, vector_sha256: str) -> None:
    lock, _ = read_lock(root)
    if lock is None:
        return
    if index_root.resolve() != _inside(root, lock['index']['directory']):
        raise ValueError('Active knowledge index differs from its release lock')
    for name, expected in lock['index']['files'].items():
        path = _inside(index_root, name)
        actual = vector_sha256 if name == 'vectors.faiss' else sha256(path)
        if actual != expected:
            raise ValueError(f'Pinned knowledge index content mismatch: {name}')


def create_lock(root: Path) -> dict:
    """Read the actual cached revision and contents, without inferring remote state."""
    from .knowledge_index import _source_files
    from .semantic_knowledge import MODEL_NAME, MODEL_REPOSITORY
    root = root.resolve()
    pointer = json.loads((root / 'index/semantic-active.json').read_text(encoding='utf-8'))
    index_root = _inside(root / 'index', pointer['directory'])
    manifest = json.loads((index_root / 'manifest.json').read_text(encoding='utf-8'))
    cache = root / 'index/models' / ('models--' + MODEL_REPOSITORY.replace('/', '--'))
    revision = (cache / 'refs/main').read_text(encoding='utf-8').strip()
    if not revision or any(c not in '0123456789abcdef' for c in revision):
        raise ValueError('Cached model revision is not a hexadecimal snapshot identifier')
    model_root = _inside(cache / 'snapshots', revision)
    model_files = {p.relative_to(model_root).as_posix(): sha256(p)
                   for p in sorted(model_root.rglob('*')) if p.is_file()}
    if 'onnx/model_fp16.onnx' not in model_files or 'tokenizer.json' not in model_files:
        raise ValueError('Cached embedding model is incomplete')
    index_files = {name: sha256(index_root / name)
                   for name in ['manifest.json','knowledge.sqlite3','vectors.faiss']}
    if index_files['vectors.faiss'] != manifest['vector_sha256']:
        raise ValueError('Actual vector checksum differs from the existing manifest')
    return {'schema_version':1, 'scope':'current_local_release_not_historical_experiment',
        'embedding': {'model_name':MODEL_NAME,'repository':MODEL_REPOSITORY,
            'cached_revision':revision,'remote_revision_verified':False,
            'directory':model_root.relative_to(root).as_posix(),'files':model_files},
        'index':{'directory':index_root.relative_to(root).as_posix(),'files':index_files,
            'document_count':manifest['document_count'],'chunk_count':manifest['chunk_count'],
            'vector_count':manifest['vector_count']},
        'corpus_files':{p.relative_to(root).as_posix():sha256(p) for p in _source_files(root)}}


def verify_lock(root: Path, *, include_corpus: bool = True) -> dict:
    lock, identity = read_lock(root)
    if lock is None:
        raise ValueError('No knowledge release lock found')
    embedding = locked_embedding(root, model_name=lock['embedding']['model_name'], repository=lock['embedding']['repository'])
    index_root = _inside(root,lock['index']['directory'])
    verify_locked_index(root,index_root,sha256(index_root/'vectors.faiss'))
    if include_corpus:
        from .knowledge_index import _source_files
        expected = lock['corpus_files']
        actual = {p.relative_to(root).as_posix():sha256(p) for p in _source_files(root)}
        if actual != expected:
            raise ValueError('Knowledge corpus file inventory or content differs from the release lock')
    return {'valid':True,'lock_sha256':identity,'model_revision':embedding['cached_revision'],
            'corpus_files_checked':len(lock['corpus_files']) if include_corpus else 0,
            'index_files_checked':len(lock['index']['files']),
            'embedding_files_checked':len(lock['embedding']['files'])}
