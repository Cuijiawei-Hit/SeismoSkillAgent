from hashlib import sha256
from pathlib import Path

from seismo_skill_agent.knowledge_index import (
    HybridKnowledgeRetriever, KnowledgeIndexBuilder, _catalog_excerpt,
    _catalog_request, _header_metadata,
)


def test_flattened_toc_is_distinct_from_a_figure_caption_and_body():
    assert _catalog_excerpt('.......... 54 图 3.16 道路阻塞延迟时间........ 55 图3.17 修复时间....... 56')
    assert _catalog_excerpt('图1.1 电网拓扑 12\n图1.2 恢复曲线 14\n图1.3 修复参数 18')
    assert not _catalog_excerpt('图3.16显示道路阻塞延迟。延迟时间为1.5小时，之后采用电网功能逐事件回算。')
    assert not _catalog_excerpt('本节说明目录中的修复参数。图3.16为道路阻塞时间与电网恢复曲线。')
    assert _catalog_request('请给出这篇文献的图表目录')
    assert not _catalog_request('不要目录，请给出正文中的电网恢复方法')


def test_unbulleted_headers_do_not_infer_metadata_from_the_article_body():
    text = '题名: 电网恢复研究\n作者: 示例作者\n年份: 2024\n版本: v2\n原始来源: reference.pdf\n\n--- 正文 ---\n版本: 正文中的其他对象\n'
    header = _header_metadata(text)
    assert header['作者'] == '示例作者'
    assert header['版本'] == 'v2'
    assert '页码' not in header
    assert _header_metadata('# 正文\n版本: 不属于头部\n') == {}


def test_rank_prefers_verified_same_document_body_without_rebuilding_index(tmp_path):
    paper = tmp_path / 'curated/papers/power_energy_system_resilience/paper.txt'
    paper.parent.mkdir(parents=True)
    paper.write_text(
        '题名: 电网功能恢复\n作者: 示例作者\n年份: 2024\n版本: 第二版\n\n'
        '# 目录\n电网功能恢复............. 12\n电网功能恢复曲线........... 15\n'
        '# 恢复方法\n电网功能恢复按照每次修复完成后重新求解供电，逐事件形成恢复曲线。\n', encoding='utf-8')
    KnowledgeIndexBuilder(tmp_path).build()
    retriever = HybridKnowledgeRetriever(tmp_path)
    manifest = retriever.builder.manifest_path
    source_digest = sha256(paper.read_bytes()).hexdigest()
    index_digest = sha256(manifest.read_bytes()).hexdigest()
    evidence = retriever.retrieve(['电网功能恢复曲线'], limit=1)[0]
    assert '逐事件' in evidence.content
    assert evidence.retrieval_scores['catalog_only'] == 0
    assert evidence.document_version == '第二版'
    assert '示例作者' in evidence.citation
    assert evidence.source_sha256 == source_digest
    assert sha256(manifest.read_bytes()).hexdigest() == index_digest
    assert sha256(paper.read_bytes()).hexdigest() == source_digest
    assert retriever.current_evidence([evidence.model_dump(mode='json')])
