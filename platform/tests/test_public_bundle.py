from hashlib import sha256
import json
from pathlib import Path
import sys
import zipfile

import pytest

from seismo_skill_agent.builtin_demo import BuiltinDemo
from seismo_skill_agent.semantic_knowledge import SemanticKnowledgeIndex, MODEL_NAME


def test_example_is_read_only_and_assets_stay_in_example_directory(tmp_path):
    root = tmp_path / 'seismo-skill-agent/demo/auckland'
    root.mkdir(parents=True)
    for name, value in [('session.en.json', {'session_id': 'demo-auckland', 'is_demo': True}),
                        ('session.zh.json', {'session_id': 'demo-auckland', 'is_demo': True}),
                        ('scene.json', {'iteration': 1})]:
        (root / name).write_text(json.dumps(value), encoding='utf-8')
    demo = BuiltinDemo(tmp_path)
    assert demo.available
    first = demo.view()
    first['is_demo'] = False
    assert demo.view()['is_demo'] is True
    assert demo.scene(1) == {'iteration': 1}
    for invalid in ('../secret', '..', '/secret', 'hidden\\secret', '.private'):
        with pytest.raises(ValueError): demo.artifact(invalid)
    with pytest.raises(KeyError): demo.scene(2)


def test_extracted_knowledge_uses_content_lock_instead_of_original_timestamps(tmp_path, monkeypatch):
    monkeypatch.delenv('SEISMO_KNOWLEDGE_LOCK', raising=False)
    root = tmp_path / 'knowledge-base'
    text = root / 'curated/source.txt'
    text.parent.mkdir(parents=True)
    text.write_text('saved electricity evidence', encoding='utf-8')
    index = root / 'index/semantic-v3/build-demo'
    index.mkdir(parents=True)
    (root / 'index/semantic-active.json').write_text(json.dumps({'directory': 'semantic-v3/build-demo'}))
    (index / 'knowledge.sqlite3').write_bytes(b'saved-database')
    (index / 'vectors.faiss').write_bytes(b'saved-vectors')
    manifest = {'schema_version': 3, 'embedding_model': MODEL_NAME, 'complete': True,
                'source_signature': {'file_count': 1, 'total_size': text.stat().st_size, 'latest_mtime_ns': 1}}
    (index / 'manifest.json').write_text(json.dumps(manifest))
    lock = {'schema_version': 1, 'corpus_files': {'curated/source.txt': sha256(text.read_bytes()).hexdigest()},
            'index': {'directory': 'index/semantic-v3/build-demo',
                      'files': {'manifest.json': sha256((index / 'manifest.json').read_bytes()).hexdigest()}}}
    (tmp_path / 'reproducibility').mkdir()
    (tmp_path / 'reproducibility/knowledge.lock.json').write_text(json.dumps(lock))
    knowledge = SemanticKnowledgeIndex(root)
    assert knowledge.status()['ready'] and not knowledge.status()['stale']
    text.write_text('changed electricity evidence', encoding='utf-8')
    assert knowledge.status()['stale']


def test_release_scan_rejects_a_key_inside_a_report(tmp_path, monkeypatch):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
    from export_public_release import scan
    key = 'unit-test-secret-not-a-provider-credential'
    monkeypatch.setenv('DEEPSEEK_API_KEY', key)
    with zipfile.ZipFile(tmp_path / 'report.docx', 'w', zipfile.ZIP_DEFLATED) as archive:
        archive.writestr('word/document.xml', '<text>' + key + '</text>')
    with pytest.raises(ValueError, match='Credential found in document'):
        scan(tmp_path)


def test_public_path_cleanup_preserves_source_urls():
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
    from export_public_release import portable
    assert portable('https://example.org/source/data.json') == 'https://example.org/source/data.json'
    assert portable('H:/private/folder/source.json') == 'source.json'
