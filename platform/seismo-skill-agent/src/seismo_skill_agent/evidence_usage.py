"""Trace evidence actually referenced by a workflow stage."""

from __future__ import annotations

import re
from typing import Any, Iterable

from .models import KnowledgeEvidence, KnowledgeReviewCheck

_REFERENCE = re.compile(r"\[KB:([^\]\s]+)\]")
_HISTORICAL = {"superseded", "withdrawn", "historical"}
_OUT_OF_DATE = {"expired", "not_yet_effective"}


def merge_evidence(*groups: Iterable[KnowledgeEvidence | dict[str, Any]],
                   limit: int = 6) -> list[dict[str, Any]]:
    """Keep query-specific hits first and avoid duplicates across queries."""
    if limit < 1:
        return []
    by_id: dict[str, dict[str, Any]] = {}
    for group in groups:
        for item in group:
            record = item.model_dump(mode="json") if isinstance(item, KnowledgeEvidence) else item
            if evidence_id := record.get("evidence_id"):
                by_id.setdefault(evidence_id, record)
                if len(by_id) >= limit:
                    return list(by_id.values())
    return list(by_id.values())


def verify_evidence_references(
    stage: str,
    sources: list[dict[str, Any]],
    *,
    text: str = "",
    reported_ids: Iterable[str] = (),
    checks: Iterable[KnowledgeReviewCheck] = (),
    output_language: str = "zh-CN",
) -> dict[str, Any]:
    """Check ID resolution and exact excerpts. This does not score claim entailment."""
    by_id = {item["evidence_id"]: item for item in sources if item.get("evidence_id")}
    declared_ids = dict.fromkeys([*_REFERENCE.findall(text), *reported_ids])
    accepted: list[dict[str, Any]] = []
    unverified_checks = 0
    for check in checks:
        item = by_id.get(check.evidence_id)
        excerpt = " ".join(check.source_excerpt.split())
        declared_ids.setdefault(check.evidence_id, None)
        if item is None or len(excerpt) < 12 or excerpt not in " ".join(str(item.get("content", "")).split()):
            unverified_checks += 1
            continue
        if _background_only(item):
            question = (
                "Verify the primary text, its current status and its applicability to this case."
                if output_language == "en-US"
                else "请核对原始全文、文件现行状态，以及它对本案是否适用。"
            )
            check = check.model_copy(update={
                "use": "verify_primary_source",
                "review_question": question,
            })
        accepted.append(check.model_dump(mode="json"))
    resolved = [
        {key: by_id[evidence_id].get(key) for key in (
            "evidence_id", "title", "section", "citation", "locator", "source_url",
            "document_version", "document_status", "time_validity", "evidence_scope",
        )} | {"purpose": "background_only" if _background_only(by_id[evidence_id]) else "review_reference"}
        for evidence_id in declared_ids if evidence_id in by_id
    ]
    return {
        "stage": stage,
        "provided_count": len(by_id),
        "resolved_references": resolved,
        "unknown_reference_count": sum(evidence_id not in by_id for evidence_id in declared_ids),
        "background_reference_count": sum(item["purpose"] == "background_only" for item in resolved),
        "review_checks": accepted,
        "unverified_check_count": unverified_checks,
    }


def annotate_references(text: str, usage: dict[str, Any], output_language: str) -> str:
    references = {item["evidence_id"]: item for item in usage["resolved_references"]}
    en = output_language == "en-US"

    def annotate(match: re.Match[str]) -> str:
        record = references.get(match[1])
        if record is None:
            return "[source not verified]" if en else "［引用来源未核实］"
        if record["purpose"] == "background_only":
            note = " (background only)" if en else "（仅供背景查证）"
            return match[0] + note
        return match[0]

    return _REFERENCE.sub(annotate, text)


def _background_only(item: dict[str, Any]) -> bool:
    return (
        item.get("document_status") in _HISTORICAL
        or item.get("time_validity") in _OUT_OF_DATE
        or item.get("evidence_scope") in {"catalog_only", "metadata_only", "discovery"}
        or bool((item.get("retrieval_scores") or {}).get("catalog_only"))
    )

