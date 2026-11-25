from __future__ import annotations

import argparse
import gzip
import json
import mimetypes
import os
import re
import shutil
import sqlite3
import threading
import uuid
from copy import deepcopy
from dataclasses import dataclass, field
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable
from urllib.parse import parse_qs, quote, unquote, urlparse

import numpy as np
from langgraph.types import Command
from langgraph.checkpoint.serde.jsonplus import JsonPlusSerializer
from langgraph.checkpoint.sqlite import SqliteSaver
from engineering_skills.healthcare.localization import (
    localize_assumptions,
    localize_damage_label,
    localize_hospital_name,
    localize_warning_dicts,
)
from engineering_skills.power.metric_standard import metric_standard_record
from .metric_policy import official_result as is_official_metric_record

from .audit import AuditStore, redact, public_endpoint
from .config import AgentConfigurationError, AgentSettings
from .decision_center import SeismoSkillDecisionCenter, review_memory_context
from .expert_memory import ExperiencePublication, ExpertMemoryStore
from .graph import build_agent_graph
from .evidence_usage import annotate_references, merge_evidence, verify_evidence_references
from .knowledge_index import HybridKnowledgeRetriever
from .llm import DeepSeekDecisionLLM, DecisionLLM, trace_llm_call
from .models import ExpertReviewDecision, FollowUpRequest, HumanDecision, RecoveryDecision
from .presentation import (
    EnglishPresentationBuilder,
    english_objective,
    english_session_title,
    presentation_cache_directory,
    presentation_artifact_views,
    project_audit_files,
    project_events,
    project_follow_ups,
    project_iterations,
    project_knowledge_evidence,
    project_plan,
    project_review,
    project_task_analysis,
    project_validation,
    sanitize_execution_trace,
    sanitize_visible,
)
from .prompts import follow_up_messages, normalize_output_language
from .request_parsing import extract_scenario_selection
from .session_report import (
    SESSION_REPORT_FILENAME as SESSION_REPORT_NAME,
    SESSION_REPORT_MEDIA_TYPE,
    SessionReportBuilder,
)
from .skill_bridge import SkillRegistryBridge
from .project_paths import project_paths, absolute_data_paths
from .metric_policy import (
    HISTORICAL_NOTICE, historical_result, clinical_record, comparison_status,
    period_metric_fields, summary_with_metric_status, treatment_window,
)
from .result_delivery import power_summary
from .power_scene import PowerSceneStore


PROJECT_ROOT = project_paths(validate=False).package_root
STATIC_ROOT = Path(__file__).with_name("web_static")
EXAMPLES_ROOT = PROJECT_ROOT / "examples"
MAX_REQUEST_BYTES = 2 * 1024 * 1024
SAFE_SESSION_RE = re.compile(r"^[A-Za-z0-9_.-]+$")

PRESETS = {
    "quick": {
        "label": "奥克兰最大概率情景",
        "description": "冻结的奥克兰综合电网数据；最大概率损伤状态。",
        "file": "auckland_power_context.json",
    },
    "formal": {
        "label": "奥克兰固定种子抽样情景",
        "description": "同一奥克兰数据；按种子生成单次损伤情景，各策略复用。",
        "file": "auckland_power_context.json",
    },
    "auckland": {
        "label": "奥克兰电网",
        "description": "奥克兰城市电力综合数据固定版本。",
        "file": "auckland_power_context.json",
    },
}

SAFE_OVERRIDE_FIELDS = {
    "assessment_mode",
    "scenario_selection",
    "mcs",
    "seed",
    "team_count",
    "control_time_days",
    "service_radius_minutes",
    "casualty_period",
    "treatment_horizon_hours",
    "time_step_days",
    "grading_model",
    "strategies",
    "ga_population",
    "ga_generations",
    "ga_crossover_rate",
    "ga_mutation_rate",
    "ga_elite_count",
    "optimization_sample_size",
    "report_title",
    "output_language",
    "model_profile",
    "treatment_parameters",
    "rapid_only_resource_loss",
    "decision_preferences",
    "severity_weights",
    "observations",
    "presentation_instructions",
    "pga_g", "power_damage_mode", "daily_work_hours", "team_efficiency", "repair_objective", "target_function", "repair_constraints",
}

SUGGESTED_TASKS = [
    "请以0.4g显式地震输入评估奥克兰电网，比较编号基准、功能增益排序和遗传算法修复策略，并生成完整报告。",
    "先分析奥克兰电网在0.4g情景下的设备和线路损伤、震后供电功率，暂不安排修复。",
    "使用3支工程队比较奥克兰电网的修复次序、开工完工时间与恢复曲线。",
    "电力系统的供电功能、恢复时间和韧性分别如何理解？请结合知识库解释。",
]
SUGGESTED_TASKS_EN = [
    "Assess the Auckland grid using an explicit 0.4g input. Compare ID baseline, functional-gain and genetic-algorithm repair strategies and produce a complete report.",
    "Assess asset and line damage and post-event electricity supply at 0.4g. Do not schedule repairs yet.",
    "Compare repair orders, crew schedules and recovery curves for the Auckland grid with three crews.",
    "Explain grid supply functionality, recovery time and resilience with knowledge-base evidence.",
]


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _safe_session_id(value: str) -> str:
    if not SAFE_SESSION_RE.fullmatch(value):
        raise ValueError("Invalid session id")
    return value


def _json_file(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"Expected JSON object in {path}")
    return value


def _absolute_data_paths(context: dict[str, Any], package_root: Path | None = None) -> dict[str, Any]:
    return absolute_data_paths(context,package_root or project_paths().package_root)


def load_preset(
    preset_id: str,
    overrides: dict[str, Any] | None = None,
    *,
    workspace_root: Path | None = None,
    user_message: str | None = None,
) -> dict[str, Any]:
    if preset_id not in PRESETS:
        raise ValueError(f"Unknown preset: {preset_id}")
    paths = project_paths(workspace_root,require_examples=True)
    example = paths.examples_root / PRESETS[preset_id]['file']
    if not example.is_file():
        raise ValueError(f'Preset input file does not exist in configured workspace: {example}')
    context = _json_file(example)
    if preset_id == "auckland" and user_message and extract_scenario_selection(user_message):
        # Defer an explicit PGA in the task to the decision center's normal parser.
        context.pop("scenario_selection", None)
    for key, value in (overrides or {}).items():
        if key not in SAFE_OVERRIDE_FIELDS:
            raise ValueError(f"Unsupported override field: {key}")
        context[key] = value
    language = str(context.get("output_language") or "zh-CN")
    if language not in {"zh-CN", "en-US"}:
        raise ValueError("output_language must be zh-CN or en-US")
    context["output_language"] = language
    if preset_id == "formal" and "power_damage_mode" not in (overrides or {}):
        context["power_damage_mode"] = "sampled"
    if language == "en-US" and "report_title" not in (overrides or {}):
        context["report_title"] = "Auckland Electricity System Seismic Resilience Assessment Report"
    from engineering_skills.power.schemas import PowerAnalysisContext
    context = _absolute_data_paths(context, paths.package_root)
    context = PowerAnalysisContext.model_validate(context).model_dump(mode="json")
    return _absolute_data_paths(context, paths.package_root)


def _interrupt_payload(result: dict[str, Any]) -> dict[str, Any] | None:
    interrupts = result.get("__interrupt__", [])
    if not interrupts:
        return None
    value = getattr(interrupts[0], "value", interrupts[0])
    return value if isinstance(value, dict) else {"message": str(value)}


def _read_events(root: Path, session_id: str) -> list[dict[str, Any]]:
    path = root.resolve() / _safe_session_id(session_id) / "events.jsonl"
    if not path.exists():
        return []
    events: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(event, dict):
            events.append(event)
    return events


def _compact_evidence(items: Any) -> list[dict[str, Any]]:
    if not isinstance(items, list):
        return []
    compacted: list[dict[str, Any]] = []
    for item in items[:8]:
        if not isinstance(item, dict):
            continue
        content = str(item.get("content") or "").strip().replace("\x00", "")
        compacted.append(
            {
                "evidence_id": item.get("evidence_id"),
                "title": item.get("title") or Path(str(item.get("source_path") or "")).name,
                "source_path": item.get("source_path"),
                "section": item.get("section"),
                "score": item.get("score", 0),
                "source_type": item.get("source_type"),
                "source_url": item.get("source_url"),
                "locator": item.get("locator"),
                "citation": item.get("citation"),
                "document_version": item.get("document_version"),
                "document_status": item.get("document_status", "unknown"),
                "time_validity": item.get("time_validity", "unknown"),
                "applicability": item.get("applicability"),
                "evidence_use": "advisory_only",
                "retrieval_scores": item.get("retrieval_scores", {}),
                "snippet": content[:320] + ("..." if len(content) > 320 else ""),
            }
        )
    return compacted


def _event_label(stage: str) -> str:
    labels = {
        "task_analysis": "任务理解完成",
        "skill_selection_guard": "注册表约束Skill选择",
        "knowledge_retrieval": "知识检索完成",
        "knowledge_answer": "知识回答生成",
        "execution_plan": "执行计划生成",
        "plan_validation": "工程参数校验",
        "human_review": "专家审批记录",
        "human_revision": "参数修订记录",
        "skill_execution_started": "Engineering Skills 分析与计算开始",
        "skill_execution_finished": "Engineering Skills 分析与计算完成",
        "skill_execution_failed": "Engineering Skills 分析与计算失败",
        "execution_recovery_decision": "执行异常恢复决策",
        "iteration_interpretation": "本轮结果解释完成",
        "result_review": "专家结果审查",
        "expert_feedback_resolution": "专家反馈转为参数修订",
        "feedback_clarification": "专家反馈澄清",
        "final_acceptance": "专家接受最终结果",
        "execution_rejected": "执行计划已拒绝",
        "web_runtime_error": "运行异常",
        "session_restore_error": "会话恢复异常",
        "follow_up_answer": "结果追问已回答",
        "follow_up_error": "结果追问失败",
        "session_report_error": "会话级报告生成失败",
    }
    return labels.get(stage, stage)


def _compact_events(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    for event in events:
        stage = str(event.get("stage") or "unknown")
        payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
        detail: dict[str, Any] = {}
        if stage == "task_analysis":
            analysis = payload.get("task_analysis", {})
            detail = {
                "objective": analysis.get("objective"),
                "assessment_mode": analysis.get("assessment_mode"),
                "component_id": analysis.get("recommended_component_id"),
            }
        elif stage == "skill_selection_guard":
            detail = {
                "proposed": payload.get("proposed_component_id"),
                "selected": payload.get("selected_component_id"),
                "reason": payload.get("reason"),
            }
        elif stage == "knowledge_retrieval":
            detail = {"evidence_count": len(payload.get("knowledge_evidence", []))}
        elif stage == "execution_plan":
            plan = payload.get("plan", {})
            detail = {
                "component_id": plan.get("component_id"),
                "skill_count": len(plan.get("selected_skill_ids", [])),
            }
        elif stage == "plan_validation":
            validation = payload.get("validation", {})
            detail = {
                "valid": validation.get("valid"),
                "issue_count": len(validation.get("issues", [])),
            }
        elif stage in {"human_review", "human_revision", "result_review", "feedback_clarification", "execution_recovery_decision"}:
            detail = {"action": payload.get("action"), "feedback": payload.get("feedback")}
            if payload.get("iteration") is not None:
                detail["iteration"] = payload.get("iteration")
        elif stage == "expert_feedback_resolution":
            detail = {
                "iteration": payload.get("iteration"),
                "can_execute": payload.get("can_execute"),
                "payload_patch": payload.get("payload_patch"),
            }
        elif stage in {"iteration_interpretation", "final_acceptance"}:
            detail = {
                "iteration": payload.get("iteration"),
                "run_id": payload.get("run_id"),
            }
        elif stage.startswith("skill_execution"):
            execution_trace = payload.get("execution_trace", [])
            detail = {
                "component_id": payload.get("component_id") or payload.get("skill_id"),
                "run_id": payload.get("run_id"),
                "status": payload.get("status"),
                "artifact_count": len(payload.get("artifacts", [])),
                "node_count": len(execution_trace) if isinstance(execution_trace, list) else 0,
                "duration_seconds": payload.get("provenance", {}).get("duration_seconds")
                if isinstance(payload.get("provenance"), dict)
                else None,
            }
        elif stage in {"web_runtime_error", "session_report_error"}:
            detail = {"message": payload.get("message")}
            if payload.get("reason") is not None:
                detail["reason"] = payload.get("reason")
        elif stage in {"follow_up_answer", "follow_up_error"}:
            detail = {
                "message_id": payload.get("message_id"),
                "question": payload.get("question"),
                "actor_role": payload.get("actor_role"),
                "message": payload.get("message"),
            }
        output.append(
            {
                "timestamp": event.get("timestamp"),
                "stage": stage,
                "label": _event_label(stage),
                "detail": detail,
            }
        )
    return output


def _state_from_events(events: list[dict[str, Any]]) -> dict[str, Any]:
    state: dict[str, Any] = {}
    mappings = {
        "task_analysis": ("task_analysis",),
        "knowledge_retrieval": ("knowledge_evidence",),
        "knowledge_answer": ("final_answer", "errors", "status"),
        "execution_plan": ("plan", "status"),
        "plan_validation": ("plan", "validation", "status"),
        "iteration_interpretation": (
            "current_interpretation",
            "iteration_history",
            "errors",
            "status",
        ),
        "execution_rejected": ("final_answer", "status"),
    }
    for event in events:
        payload = event.get("payload")
        if not isinstance(payload, dict):
            continue
        for key in mappings.get(str(event.get("stage")), ()):
            if key in payload:
                state[key] = payload[key]
    return state


def _skill_progress(
    events: list[dict[str, Any]],
    status: str,
    skill_run_root: Path,
    catalog: list[dict[str, Any]],
) -> dict[str, Any] | None:
    started = next(
        (
            event.get("payload", {})
            for event in reversed(events)
            if event.get("stage") == "skill_execution_started"
            and isinstance(event.get("payload"), dict)
        ),
        None,
    )
    if not started:
        return None
    run_id = started.get("run_id")
    component_id = started.get("component_id")
    if not isinstance(run_id, str) or not isinstance(component_id, str):
        return None
    component_ids = list(started.get("selected_skill_ids", []))
    manifest = next((item for item in catalog if item.get("id") == component_id), None)
    if not component_ids:
        component_ids = list(manifest.get("dependencies", [])) if manifest else []
    if not component_ids:
        component_ids = [component_id]
    run_directory = skill_run_root.resolve() / run_id
    rows: list[dict[str, Any]] = []
    first_incomplete = True
    for child_id in component_ids:
        child_directory = run_directory / child_id
        completed = (child_directory / "result.json").is_file()
        running = (
            status == "executing"
            and not completed
            and first_incomplete
        )
        if completed:
            first_incomplete = True
        elif running:
            first_incomplete = False
        rows.append(
            {
                "component_id": child_id,
                "status": "completed" if completed else "running" if running else "pending",
            }
        )
    completed_count = sum(item["status"] == "completed" for item in rows)
    return {
        "run_id": run_id,
        "completed": completed_count,
        "total": len(rows),
        "components": rows,
    }


def _resolved_containment_path(path: Path) -> Path:
    """Resolve links first, then normalize Windows DOS/UNC namespace aliases.

    During concurrent mkdir, ntpath.realpath may retain ``\\\\?\\`` on just
    one operand (different initial/final missing-path Win32 errors). Comparing
    that anchor with ordinary C: or UNC anchors falsely rejects a safe path.
    Converting both resolved operands to the extended namespace preserves link
    targets and literal names; it does not use a lexical string-prefix check.
    """
    resolved = path.resolve()
    if os.name == 'nt':
        value = str(resolved)
        if re.match(r'^[A-Za-z]:\\', value):
            return Path('\\\\?\\' + value)
        if value.startswith('\\\\') and not value.startswith(('\\\\?\\', '\\\\.\\')):
            return Path('\\\\?\\UNC\\' + value[2:])
    return resolved


def _is_within(path: Path, roots: list[Path]) -> bool:
    resolved = _resolved_containment_path(path)
    for root in roots:
        try:
            resolved.relative_to(_resolved_containment_path(root))
            return True
        except ValueError:
            continue
    return False


def _available_artifact_path(path: Path, roots: list[Path]) -> Path | None:
    """Resolve an artifact under current roots, including a migrated old root."""
    resolved = path.resolve()
    if resolved.is_file() and _is_within(resolved, roots):
        return resolved

    parts = path.parts
    for root in roots:
        resolved_root = root.resolve()
        marker = resolved_root.name.casefold()
        for index in range(len(parts) - 1, -1, -1):
            if parts[index].casefold() != marker:
                continue
            candidate = resolved_root.joinpath(*parts[index + 1 :]).resolve()
            if candidate.is_file() and _is_within(candidate, [resolved_root]):
                return candidate
    return None


def _artifact_views(
    result: dict[str, Any] | None,
    session_id: str,
    iteration: int | None = None,
) -> list[dict[str, Any]]:
    if not isinstance(result, dict):
        return []
    views: list[dict[str, Any]] = []
    for index, artifact in enumerate(result.get("artifacts", [])):
        if not isinstance(artifact, dict):
            continue
        path = Path(str(artifact.get("path") or ""))
        media_type = str(artifact.get("media_type") or mimetypes.guess_type(path.name)[0] or "application/octet-stream")
        url = f"/api/sessions/{session_id}/artifacts/{index}"
        if iteration is not None:
            url = f"/api/sessions/{session_id}/iterations/{iteration}/artifacts/{index}"
        views.append(
            {
                "index": index,
                "name": path.name,
                "media_type": media_type,
                "description": artifact.get("description"),
                "size_bytes": artifact.get("size_bytes"),
                "checksum_sha256": artifact.get("checksum_sha256"),
                "kind": "image" if media_type.startswith("image/") else "document",
                "category": _artifact_category(path, media_type),
                "source_skill_id": _artifact_source_skill(path),
                "url": url,
            }
        )
    return views


def _session_report_directory(agent_run_root: Path, session_id: str) -> Path:
    root = agent_run_root.resolve()
    directory = (
        root / _safe_session_id(session_id) / "session-report" / "artifacts"
    ).resolve()
    if not _is_within(directory, [root]):
        raise PermissionError("Session report directory is outside agent_run_root")
    return directory


def _session_artifact_paths(
    agent_run_root: Path,
    session_id: str,
) -> list[Path]:
    directory = _session_report_directory(agent_run_root, session_id)
    if not directory.is_dir():
        return []
    paths: list[Path] = []
    for candidate in directory.iterdir():
        if candidate.name.startswith("."):
            continue
        path = candidate.resolve()
        if not path.is_file() or not _is_within(path, [directory]):
            continue
        paths.append(path)
    return sorted(
        paths,
        key=lambda path: (path.name != SESSION_REPORT_NAME, path.name.lower()),
    )


def _session_artifact_views(
    agent_run_root: Path,
    session_id: str,
    output_language: str = "zh-CN",
) -> list[dict[str, Any]]:
    description = (
        "Final multi-round session report containing computations, expert reviews, and follow-up answers."
        if output_language == "en-US"
        else "包含各轮计算、专家复核与追问回答的多轮会话最终报告。"
    )
    views: list[dict[str, Any]] = []
    for index, path in enumerate(_session_artifact_paths(agent_run_root, session_id)):
        media_type = str(
            mimetypes.guess_type(path.name)[0]
            or (
                SESSION_REPORT_MEDIA_TYPE
                if path.suffix.lower() == ".docx"
                else "application/octet-stream"
            )
        )
        views.append(
            {
                "index": index,
                "name": path.name,
                "media_type": media_type,
                "description": description,
                "size_bytes": path.stat().st_size,
                "kind": "document",
                "category": "report",
                "source_skill_id": "session_report",
                "url": f"/api/sessions/{session_id}/session-artifacts/{index}",
            }
        )
    return views


def _artifact_category(path: Path, media_type: str) -> str:
    if media_type.startswith("image/"):
        return "figure"
    if path.suffix.lower() in {".docx", ".xlsx", ".pdf"}:
        return "report"
    lowered = path.name.lower()
    if "trace" in lowered or "manifest" in lowered or lowered in {
        "events.jsonl",
        "final_state.json",
        "session.json",
    }:
        return "traceability"
    if path.suffix.lower() == ".json":
        return "structured_result"
    return "machine_artifact"


def _artifact_source_skill(path: Path) -> str | None:
    parts = list(path.parts)
    if "artifacts" not in parts:
        return None
    reverse_index = list(reversed(parts)).index("artifacts")
    index = len(parts) - 1 - reverse_index
    return parts[index - 1] if index > 0 else None


def _delivery_view(result: dict[str, Any] | None) -> dict[str, Any] | None:
    if not isinstance(result, dict) or not isinstance(result.get("data"), dict):
        return None
    delivery = result["data"].get("delivery_bundle")
    if not isinstance(delivery, dict):
        return None
    keep = {
        "schema_version",
        "delivery_kind",
        "result_scope",
        "run_id",
        "objective",
        "report_title",
        "presentation_instructions",
        "presentation_revision_id",
        "presentation_changes",
        "word_table_row_limit",
        "generated_at",
        "assessment_mode",
        "output_language",
        "requested_skill_ids",
        "execution_target_skill_ids",
        "executed_components",
        "scenario_ids",
        "hospital_count",
        "hospital_entities",
        "target_system", "city", "node_count", "branch_count", "generator_count", "network", "inventory", "damage", "function", "recovery", "basic_recovery", "resilience", "impact", "figures", "metric_standard", "dataset_version", "dataset_fingerprint",
        "sections",
        "warnings",
        "assumptions",
        "generated_files",
        "narrative",
        "status",
        "error",
    }
    view = {key: deepcopy(value) for key, value in delivery.items() if key in keep}
    if "presentation_revision_id" not in view and result["data"].get("presentation_revision_id"):
        view["presentation_revision_id"] = result["data"]["presentation_revision_id"]
    return view


def _execution_trace_view(result: dict[str, Any] | None) -> list[dict[str, Any]]:
    if not isinstance(result, dict) or not isinstance(result.get("data"), dict):
        return []
    data = result["data"]
    delivery = data.get("delivery_bundle")
    trace = delivery.get("execution_trace", []) if isinstance(delivery, dict) else data.get("node_trace", [])
    output: list[dict[str, Any]] = []
    for node in trace if isinstance(trace, list) else []:
        if not isinstance(node, dict):
            continue
        artifacts = []
        for artifact in node.get("artifacts", []):
            if not isinstance(artifact, dict):
                continue
            path = Path(str(artifact.get("path") or ""))
            artifacts.append(
                {
                    "name": path.name,
                    "media_type": artifact.get("media_type"),
                    "description": artifact.get("description"),
                    "size_bytes": artifact.get("size_bytes"),
                    "checksum_sha256": artifact.get("checksum_sha256"),
                }
            )
        output.append(
            {
                key: deepcopy(node.get(key))
                for key in (
                    "skill_id",
                    "skill_version",
                    "component_kind",
                    "status",
                    "execution_status",
                    "reused_from_run_id",
                    "output_validation",
                    "duration_seconds",
                    "assessment_mode",
                    "seed",
                    "input_hash",
                    "model_versions",
                    "started_at",
                    "finished_at",
                    "warning_count",
                    "assumption_count",
                )
            }
            | {"artifacts": artifacts}
        )
    return output


def _audit_file_views(agent_run_root: Path, session_id: str) -> list[dict[str, Any]]:
    directory = agent_run_root.resolve() / _safe_session_id(session_id)
    files = []
    descriptions = {
        "events.jsonl": "不可覆盖的会话阶段事件",
        "final_state.json": "智能体最终状态快照",
        "session.json": "会话元数据",
    }
    media_types = {
        "events.jsonl": "application/x-ndjson",
        "final_state.json": "application/json",
        "session.json": "application/json",
    }
    for name in ("events.jsonl", "final_state.json", "session.json"):
        path = directory / name
        if not path.is_file():
            continue
        files.append(
            {
                "name": name,
                "media_type": media_types[name],
                "description": descriptions[name],
                "size_bytes": path.stat().st_size,
                "kind": "document",
                "category": "traceability",
                "source_skill_id": "agent_runtime",
                "url": f"/api/sessions/{session_id}/audit/{name}",
            }
        )
    return files


def _localize_report_summary(
    summary: dict[str, Any], output_language: str
) -> dict[str, Any]:
    localized = deepcopy(summary)
    if output_language != "en-US":
        return localized

    sections = localized.get("result_sections")
    if isinstance(sections, dict):
        localized["result_sections"] = {
            str(skill_id): _localize_report_summary(section, output_language)
            if isinstance(section, dict)
            else section
            for skill_id, section in sections.items()
        }

    localized["warnings"] = localize_warning_dicts(
        localized.get("warnings", []), output_language
    )
    for collection_name in (
        "hospital_entities",
        "hospital_summary",
        "hospital_resource_summary",
        "hospital_component_risk_summary",
        "hospital_service_risk_summary",
        "casualty_hospital_load",
        "top_dispatch_routes",
        "representative_repair_schedule",
    ):
        for row in localized.get(collection_name, []):
            if not isinstance(row, dict):
                continue
            hospital_id = str(row.get("hospital_id") or "")
            if hospital_id and row.get("hospital_name"):
                row["hospital_name"] = localize_hospital_name(
                    hospital_id, str(row["hospital_name"]), output_language
                )
            if row.get("modal_damage_label"):
                row["modal_damage_label"] = localize_damage_label(
                    str(row["modal_damage_label"]), output_language
                )
    decision_support = localized.get("decision_support")
    if isinstance(decision_support, dict):
        for plan in decision_support.get("hospital_intervention_plans", []):
            if not isinstance(plan, dict):
                continue
            hospital_id = str(plan.get("hospital_id") or "")
            if hospital_id and plan.get("hospital_name"):
                plan["hospital_name"] = localize_hospital_name(
                    hospital_id,
                    str(plan["hospital_name"]),
                    output_language,
                )

    localized["damage_labels"] = [
        localize_damage_label(str(label), output_language)
        for label in localized.get("damage_labels", [])
    ]
    target_data = localized.get("target_data")
    if isinstance(target_data, dict) and isinstance(target_data.get("damage_labels"), list):
        target_data["damage_labels"] = [
            localize_damage_label(str(label), output_language)
            for label in target_data["damage_labels"]
        ]
    for row in localized.get("robust_orders", []):
        if not isinstance(row, dict):
            continue
        order = [str(item) for item in row.get("order", [])]
        source_names = row.get("order_names", [])
        if not isinstance(source_names, list):
            source_names = []
        names = [
            localize_hospital_name(
                hospital_id,
                str(source_names[index])
                if index < len(source_names)
                else hospital_id,
                output_language,
            )
            for index, hospital_id in enumerate(order)
        ]
        row["order_names"] = names
        row["order_display"] = " -> ".join(
            f"{hospital_id} {name}" for hospital_id, name in zip(order, names)
        )
    return localized


def _report_summary(
    result: dict[str, Any] | None,
    allowed_roots: list[Path],
    output_language: str = "zh-CN",
    requested_skill_ids: list[str] | None = None,
) -> dict[str, Any] | None:
    if not isinstance(result, dict):
        return None
    power_data = result.get("data", {})
    nodes = power_data.get("node_results", {}) if isinstance(power_data, dict) else {}
    if isinstance(nodes, dict) and any(str(key).startswith("power_system.") for key in nodes):
        summary = power_summary(nodes, requested_skill_ids or power_data.get("requested_skill_ids") or power_data.get("target_skill_ids"), language=output_language)
        summary["warnings"] = result.get("warnings", [])
        summary["provenance"] = result.get("provenance", {})
        return summary
    for artifact in result.get("artifacts", []):
        if not isinstance(artifact, dict):
            continue
        original_path = Path(str(artifact.get("path") or ""))
        if original_path.name != "resilience_summary.json":
            continue
        path = _available_artifact_path(original_path, allowed_roots)
        if path is None:
            continue
        try:
            summary = _json_file(path)
        except (OSError, ValueError, json.JSONDecodeError):
            return None
        keep = {
            "metric_standard",
            "dataset_fingerprint",
            "assessment_mode",
            "model_profile",
            "severity_weights",
            "treatment_parameters",
            "decision_preferences",
            "recommended_strategies",
            "quantitative_interpretation",
            "methodology",
            "presentation_instructions",
            "dataset_profile",
            "mcs",
            "seed",
            "scenario_count",
            "hospital_count",
            "demand_node_count",
            "total_population",
            "team_count",
            "control_time_days",
            "recovery_threshold",
            "service_radius_minutes",
            "treatment_horizon_hours",
            "casualty_period",
            "primary_strategy",
            "event_pga_g",
            "hospital_entities",
            "data_quality",
            "scenario_summary",
            "hospital_summary",
            "hospital_resource_summary",
            "hospital_component_risk_summary",
            "hospital_service_risk_summary",
            "node_accessibility_summary",
            "casualty_summary",
            "casualty_hospital_load",
            "top_dispatch_routes",
            "recovery_strategy_summary",
            "robust_orders",
            "representative_repair_schedule",
            "resilience_grades",
            "decision_support",
            "warnings",
            "provenance",
        }
        return summary_with_metric_status(_localize_report_summary(
            {key: value for key, value in summary.items() if key in keep},
            output_language,
        ))

    data = result.get("data")
    if not isinstance(data, dict):
        return None
    targets = data.get("target_skill_ids")
    node_results = data.get("node_results")
    if not isinstance(targets, list) or not targets:
        target_id = str(result.get("skill_id") or "")
        if not target_id:
            return None
        targets = [target_id]
        node_results = {target_id: data}
    elif not isinstance(node_results, dict):
        return None
    else:
        target_id = str(targets[-1])
    target_data = node_results.get(target_id)
    if not isinstance(target_data, dict):
        return None

    requested = [
        str(item)
        for item in (requested_skill_ids or targets)
        if isinstance(item, str) and item
    ]
    display_skill_ids = [
        skill_id
        for skill_id in node_results
        if skill_id in requested and isinstance(node_results.get(skill_id), dict)
    ]
    if not display_skill_ids:
        display_skill_ids = [target_id]

    scenario_data = node_results.get("earthquake_scenario_interpretation", {})
    entities = (
        scenario_data.get("hospitals", [])
        if isinstance(scenario_data, dict)
        else []
    )
    mcs = next(
        (
            node_data.get("mcs")
            for node_data in node_results.values()
            if isinstance(node_data, dict) and node_data.get("mcs") is not None
        ),
        None,
    )
    summary: dict[str, Any] = {
        "metric_standard": data.get("metric_standard"),
        "model_profile": data.get("model_profile"),
        "dataset_fingerprint": data.get("dataset_fingerprint"),
        "control_time_days": data.get("control_time_days"),
        "treatment_horizon_hours": data.get("treatment_horizon_hours"),
        "seed": data.get("seed"),
        "result_scope": "multi_target" if len(display_skill_ids) > 1 else "partial",
        "partial_kind": target_id,
        "assessment_mode": data.get("assessment_mode"),
        "target_skill_ids": targets,
        "requested_skill_ids": display_skill_ids,
        "executed_components": data.get("executed_components", []),
        "mcs": mcs,
        "hospital_count": (
            scenario_data.get("hospital_count")
            if isinstance(scenario_data, dict)
            else None
        ),
        "hospital_entities": entities,
        "warnings": result.get("warnings", []),
        "provenance": result.get("provenance", {}),
        "target_data": _bounded_result_data(target_data),
    }
    result_sections: dict[str, dict[str, Any]] = {}
    for skill_id in display_skill_ids:
        node_data = node_results.get(skill_id)
        if not isinstance(node_data, dict):
            continue
        if skill_id == "hospital_damage_assessment":
            result_sections[skill_id] = _hospital_damage_summary(node_data, entities)
        elif skill_id == "hospital_function_degradation":
            result_sections[skill_id] = _hospital_function_summary(node_data, entities)
        elif skill_id == "road_accessibility_analysis":
            result_sections[skill_id] = _road_accessibility_summary(node_data)
        elif skill_id == "casualty_dispatch_treatment":
            result_sections[skill_id] = _casualty_response_summary(
                node_data, entities, allowed_roots
            )
        elif skill_id == "recovery_optimization":
            result_sections[skill_id] = _recovery_optimization_summary(
                node_data, entities
            )
        else:
            result_sections[skill_id] = {
                "target_data": _bounded_result_data(node_data)
            }
    summary["result_sections"] = result_sections
    if len(display_skill_ids) == 1 and display_skill_ids[0] in result_sections:
        summary.update(result_sections[display_skill_ids[0]])
    return summary_with_metric_status(_localize_report_summary(summary, output_language))


def _follow_up_fields(value: Any, fields: tuple[str, ...]) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    return {field: value[field] for field in fields if field in value}


def _follow_up_rows(
    value: Any,
    fields: tuple[str, ...],
    limit: int | None = None,
) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    rows = [
        _follow_up_fields(row, fields)
        for row in value
        if isinstance(row, dict)
    ]
    return rows if limit is None else rows[:limit]


def _prompt_bounded(value: Any, depth: int = 0) -> Any:
    if depth >= 5:
        return "[truncated]"
    if isinstance(value, dict):
        output: dict[str, Any] = {}
        for key, child in list(value.items())[:24]:
            if key in {"provenance", "dag", "node_trace", "execution_trace"}:
                continue
            output[str(key)] = _prompt_bounded(child, depth + 1)
        return output
    if isinstance(value, list):
        return [_prompt_bounded(item, depth + 1) for item in value[:12]]
    if isinstance(value, str) and len(value) > 2400:
        return value[:2400] + "...[truncated]"
    return value


def _top_rows_per_hospital(
    value: Any,
    *,
    count: int,
    rank_field: str | None = None,
    score_field: str | None = None,
) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    groups: dict[str, list[dict[str, Any]]] = {}
    for row in value:
        if not isinstance(row, dict):
            continue
        groups.setdefault(str(row.get("hospital_id") or "unknown"), []).append(row)
    output: list[dict[str, Any]] = []
    for hospital_id in sorted(groups):
        rows = groups[hospital_id]
        if rank_field:
            rows.sort(
                key=lambda row: float(row.get(rank_field) or 10**9)
            )
        elif score_field:
            rows.sort(
                key=lambda row: float(row.get(score_field) or 0.0),
                reverse=True,
            )
        output.extend(rows[:count])
    return output


def _compact_hospital_intervention_plans(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    plan_fields = (
        "scenario_id",
        "hospital_id",
        "hospital_name",
        "priority",
        "mobilization_rank",
        "vulnerability_rank",
        "criticality_rank",
        "modal_damage_state",
        "expected_damage_state",
        "probability_ds_ge_3",
        "function_retention_ratio",
        "median_repair_time_days",
        "first_action",
        "diagnostic_statement",
        "schedule",
        "schedule_summary",
        "sequencing_note",
        "field_update_requirements",
    )
    component_fields = (
        "component_id",
        "component",
        "location",
        "mean_failure_probability",
        "hotspot_failure_probability",
        "risk_level",
        "functional_consequence",
        "immediate_action",
        "repair_action",
        "verification",
    )
    service_fields = (
        "service_key",
        "service",
        "retention_ratio",
        "loss_ratio",
        "priority",
        "state",
        "functional_consequence",
        "continuity_action",
        "verification",
    )
    output: list[dict[str, Any]] = []
    for row in value:
        if not isinstance(row, dict):
            continue
        compact = _follow_up_fields(row, plan_fields)
        compact["top_component_actions"] = _follow_up_rows(
            row.get("component_actions"), component_fields, 2
        )
        compact["top_service_actions"] = _follow_up_rows(
            row.get("service_actions"), service_fields, 2
        )
        output.append(compact)
    return output


def _follow_up_topics(question: str | None) -> set[str]:
    if not question:
        return {"damage", "function", "accessibility", "casualty", "recovery"}
    normalized = question.lower()
    keyword_groups = {
        "damage": (
            "损伤",
            "易损",
            "构件",
            "层间位移",
            "idr",
            "damage",
            "fragility",
            "component",
        ),
        "function": (
            "功能退化",
            "功能保有",
            "服务能力",
            "科室",
            "设备",
            "病床",
            "医生",
            "护士",
            "手术室",
            "影像",
            "function degradation",
            "service capacity",
            "resource",
            "staff",
            "operating room",
        ),
        "accessibility": (
            "可达",
            "道路",
            "交通",
            "需求点",
            "服务半径",
            "accessib",
            "road",
            "travel time",
            "service radius",
        ),
        "casualty": (
            "伤员",
            "伤亡",
            "救治",
            "接诊",
            "生存",
            "分派",
            "casualty",
            "treatment",
            "dispatch",
            "survival",
        ),
        "recovery": (
            "修复",
            "恢复",
            "韧性",
            "工程队",
            "工期",
            "排序",
            "次序",
            "策略",
            "ga",
            "recovery",
            "resilience",
            "repair team",
            "schedule",
            "order",
        ),
    }
    topics = {
        topic
        for topic, keywords in keyword_groups.items()
        if any(keyword in normalized for keyword in keywords)
    }
    return topics or set(keyword_groups)


def _compact_report_for_follow_up(
    report: dict[str, Any] | None,
    question: str | None = None,
) -> dict[str, Any]:
    if not isinstance(report, dict):
        return {}
    if report.get("target_system") == "power_system":
        return {key: _prompt_bounded(report.get(key)) for key in (
            "target_system", "city", "metric_standard", "dataset_fingerprint", "dataset_version", "pga_g", "power_damage_mode", "seed",
            "damage_scenario_fingerprint", "node_count", "branch_count", "function", "recovery", "basic_recovery", "resilience", "impact", "warnings")}
    scalar_fields = (
        "metric_standard",
        "metric_standard_status",
        "metric_standard_notice",
        "historical_read_only",
        "model_profile",
        "dataset_fingerprint",
        "treatment_horizon_hours",
        "result_scope",
        "partial_kind",
        "assessment_mode",
        "dataset_profile",
        "mcs",
        "seed",
        "scenario_count",
        "hospital_count",
        "demand_node_count",
        "total_population",
        "team_count",
        "control_time_days",
        "service_radius_minutes",
        "primary_strategy",
        "event_pga_g",
        "target_skill_ids",
        "requested_skill_ids",
        "executed_components",
        "data_quality",
    )
    output = _follow_up_fields(report, scalar_fields)
    output["hospital_entities"] = _follow_up_rows(
        report.get("hospital_entities"),
        ("hospital_id", "hospital_name", "longitude", "latitude"),
    )
    output["scenario_summary"] = _follow_up_rows(
        report.get("scenario_summary"),
        (
            "scenario_id",
            "treatment_coverage_by_period",
            *period_metric_fields(treatment_window(report)),
            "pga_g",
            "mean_initial_function",
            "p05_initial_function",
            "p95_initial_function",
            "mean_final_function",
            "p05_final_function",
            "p95_final_function",
            "mean_resilience",
            "p05_resilience",
            "p95_resilience",
            "functionality_loss_area",
            "downtime_to_threshold_days",
            "threshold_reached_fraction",
            "mean_recovery_time_days",
            "p05_recovery_time_days",
            "p95_recovery_time_days",
            "covered_population_ratio",
            "unreachable_population",
            "overall_resilience_level",
        ),
    )
    output["hospital_summary"] = _follow_up_rows(
        report.get("hospital_summary"),
        (
            "scenario_id",
            "hospital_id",
            "hospital_name",
            "modal_damage_state",
            "expected_damage_state",
            "probability_ds_ge_3",
            "mean_max_idr",
            "p05_max_idr",
            "p95_max_idr",
            "mean_repair_time_days",
            "p50_repair_time_days",
            "p95_repair_time_days",
            "mean_function_ratio",
            "p05_function_ratio",
            "p95_function_ratio",
            "mean_function_loss",
            "probability_function_below_0_5",
            "criticality_score",
            "infrastructure_availability",
            "doctor_retention_ratio",
            "nurse_retention_ratio",
            "anesthetist_retention_ratio",
            "radiologist_retention_ratio",
            "radiology_retention_ratio",
            "operating_room_retention_ratio",
            "bed_retention_ratio",
        ),
    )
    output["hospital_resource_summary"] = _follow_up_rows(
        report.get("hospital_resource_summary"),
        (
            "scenario_id",
            "hospital_id",
            "hospital_name",
            "resource",
            "pre_event_quantity",
            "mean_post_event_quantity",
            "retention_ratio",
        ),
    )

    component_rows = _top_rows_per_hospital(
        report.get("hospital_component_risk_summary"),
        count=2,
        rank_field="risk_rank_within_hospital",
    )
    output["top_component_risks"] = _follow_up_rows(
        component_rows,
        (
            "scenario_id",
            "hospital_id",
            "hospital_name",
            "component_id",
            "component",
            "location",
            "mean_failure_probability",
            "p95_failure_probability",
            "hotspot_failure_probability",
            "risk_level",
            "decision_score",
            "functional_consequence",
            "immediate_action",
            "repair_action",
            "verification",
        ),
    )
    service_rows = _top_rows_per_hospital(
        report.get("hospital_service_risk_summary"),
        count=2,
        score_field="loss_ratio",
    )
    output["top_service_risks"] = _follow_up_rows(
        service_rows,
        (
            "scenario_id",
            "hospital_id",
            "hospital_name",
            "service_key",
            "service",
            "retention_ratio",
            "loss_ratio",
            "priority",
            "state",
            "functional_consequence",
            "continuity_action",
            "verification",
        ),
    )

    accessibility = report.get("node_accessibility_summary")
    selected_accessibility: list[dict[str, Any]] = []
    if isinstance(accessibility, list):
        rows = [row for row in accessibility if isinstance(row, dict)]
        worst = sorted(
            rows,
            key=lambda row: float(row.get("mean_accessibility_ratio") or 0.0),
        )[:12]
        populous = sorted(
            rows,
            key=lambda row: float(row.get("population") or 0.0),
            reverse=True,
        )[:4]
        seen: set[str] = set()
        for row in [*worst, *populous]:
            key = str(row.get("demand_node_id") or id(row))
            if key not in seen:
                seen.add(key)
                selected_accessibility.append(row)
    output["priority_accessibility_nodes"] = _follow_up_rows(
        selected_accessibility,
        (
            "scenario_id",
            "demand_node_id",
            "population",
            "pre_accessibility",
            "mean_post_accessibility",
            "mean_accessibility_ratio",
            "p05_accessibility_ratio",
            "p95_accessibility_ratio",
            "nearest_hospital_time_minutes",
            "accessible_hospital_count",
            "day_expected_casualties",
            "night_expected_casualties",
        ),
    )
    output["casualty_summary"] = _prompt_bounded(report.get("casualty_summary", []))
    output["casualty_hospital_load"] = _prompt_bounded(
        report.get("casualty_hospital_load", [])
    )
    output["top_dispatch_routes"] = _follow_up_rows(
        report.get("top_dispatch_routes"),
        (
            "period",
            "scenario_id",
            "rank",
            "demand_node_id",
            "hospital_id",
            "hospital_name",
            "mean_dispatched_casualties",
            "travel_time_minutes",
        ),
        15,
    )
    for key in (
        "recovery_strategy_summary",
        "robust_orders",
        "representative_repair_schedule",
        "resilience_grades",
        "warnings",
    ):
        output[key] = _prompt_bounded(report.get(key, []))

    decision_support = report.get("decision_support")
    if isinstance(decision_support, dict):
        output["decision_support"] = {
            **_follow_up_fields(
                decision_support,
                (
                    "decision_level",
                    "generated_by",
                    "decision_objective",
                    "highest_scenario",
                    "decision_summary",
                    "component_level_optimization_status",
                    "strategy_recommendation",
                    "evidence_use_statement",
                    "expert_confirmation_required",
                ),
            ),
            "priority_actions": _prompt_bounded(
                decision_support.get("priority_actions", [])
            ),
            "hospital_intervention_plans": _compact_hospital_intervention_plans(
                decision_support.get("hospital_intervention_plans")
            ),
        }
    if "target_data" in report:
        output["target_data"] = _prompt_bounded(report.get("target_data"))
    if "result_sections" in report:
        output["result_sections"] = _prompt_bounded(report.get("result_sections"))

    topics = _follow_up_topics(question)
    base_keys = {
        *scalar_fields,
        "hospital_entities",
        "scenario_summary",
        "warnings",
        "target_data",
        "result_sections",
    }
    topic_keys = {
        "damage": {"hospital_summary", "top_component_risks"},
        "function": {
            "hospital_summary",
            "hospital_resource_summary",
            "top_service_risks",
        },
        "accessibility": {"priority_accessibility_nodes", "top_dispatch_routes"},
        "casualty": {
            "casualty_summary",
            "casualty_hospital_load",
            "top_dispatch_routes",
        },
        "recovery": {
            "recovery_strategy_summary",
            "robust_orders",
            "representative_repair_schedule",
            "resilience_grades",
        },
    }
    allowed_keys = set(base_keys)
    for topic in topics:
        allowed_keys.update(topic_keys[topic])
    filtered = {key: value for key, value in output.items() if key in allowed_keys}

    compact_decision = output.get("decision_support")
    if isinstance(compact_decision, dict):
        decision_keys = {
            "decision_level",
            "generated_by",
            "decision_objective",
            "highest_scenario",
            "decision_summary",
            "component_level_optimization_status",
            "strategy_recommendation",
            "evidence_use_statement",
            "expert_confirmation_required",
        }
        if topics & {"damage", "function"}:
            decision_keys.add("priority_actions")
        action_detail_requested = question is None or any(
            keyword in str(question).lower()
            for keyword in (
                "怎么修",
                "如何修",
                "哪个医院",
                "构件",
                "部件",
                "处置",
                "行动",
                "措施",
                "intervention",
                "repair action",
                "which hospital",
                "component",
            )
        )
        if action_detail_requested and topics & {"damage", "function", "recovery"}:
            decision_keys.add("priority_actions")
            decision_keys.add("hospital_intervention_plans")
        filtered["decision_support"] = {
            key: value
            for key, value in compact_decision.items()
            if key in decision_keys
        }
    return filtered


def _compact_plan_for_follow_up(plan: Any) -> dict[str, Any]:
    if not isinstance(plan, dict):
        return {}
    output = _follow_up_fields(
        plan,
        (
            "component_id",
            "input_profile_id",
            "task_objective",
            "requested_skill_ids",
            "selected_skill_ids",
            "target_skill_ids",
            "composition_mode",
            "rationale",
        ),
    )
    payload = plan.get("request_payload")
    if isinstance(payload, dict):
        output["parameters"] = {
            key: _prompt_bounded(payload[key])
            for key in SAFE_OVERRIDE_FIELDS
            if key in payload
        }
    return output


def _compact_prior_follow_ups(
    follow_ups: Any,
    limit: int = 3,
) -> list[dict[str, Any]]:
    if not isinstance(follow_ups, list) or limit <= 0:
        return []
    answered = [
        item
        for item in follow_ups
        if isinstance(item, dict)
        and item.get("status") == "answered"
        and isinstance(item.get("answer"), str)
    ][-limit:]
    output: list[dict[str, Any]] = []
    for item in answered:
        output.append(
            redact(
                {
                    "record_type": "follow_up",
                    "message_id": item.get("message_id"),
                    "iteration": item.get("iteration"),
                    "run_id": item.get("run_id"),
                    "question": str(item.get("question") or "")[:1200],
                    "answer": str(item.get("answer") or "")[:2400],
                    "answered_at": item.get("answered_at"),
                }
            )
        )
    return output


def _follow_up_result_context(
    result: Any,
    report_summary: dict[str, Any] | None,
    interpretation: Any = None,
    question: str | None = None,
) -> dict[str, Any]:
    if not isinstance(result, dict):
        return {}
    context = _follow_up_fields(
        result,
        ("status", "skill_id", "skill_version", "run_id", "warnings", "assumptions"),
    )
    if isinstance(interpretation, str) and interpretation.strip():
        context["engineering_interpretation"] = interpretation[:8000]
    compact_report = _compact_report_for_follow_up(report_summary, question)
    if compact_report:
        context["report_summary"] = compact_report
    else:
        fallback = SkillRegistryBridge.summarize_result(result)
        context["result_data"] = _prompt_bounded(fallback.get("data", {}))
    return context


def _compact_follow_up_evidence(value: Any) -> list[dict[str, Any]]:
    return _follow_up_rows(
        value,
        (
            "evidence_id",
            "title",
            "content",
            "score",
            "source_type",
            "citation",
            "locator",
            "document_version",
            "document_status",
            "time_validity",
            "applicability",
            "evidence_use",
        ),
        8,
    )


def _bounded_result_data(value: Any, depth: int = 0) -> Any:
    if depth >= 5:
        return "[truncated]"
    if isinstance(value, dict):
        items = list(value.items())
        output = {
            str(key): _bounded_result_data(child, depth + 1)
            for key, child in items[:30]
            if key not in {"damage_artifact", "dataset_artifacts"}
        }
        if len(items) > 30:
            output["_truncated_keys"] = len(items) - 30
        return output
    if isinstance(value, list):
        output = [_bounded_result_data(child, depth + 1) for child in value[:20]]
        if len(value) > 20:
            output.append({"_truncated_items": len(value) - 20})
        return output
    return value


def _hospital_damage_summary(
    target_data: dict[str, Any],
    entities: list[Any],
) -> dict[str, Any]:
    entity_rows = [item for item in entities if isinstance(item, dict)]
    entity_by_id = {
        str(item.get("hospital_id")): item
        for item in entity_rows
        if item.get("hospital_id")
    }
    labels = [
        str(item) for item in target_data.get("damage_labels", [])
    ]
    scenario_summary: list[dict[str, Any]] = []
    hospital_summary: list[dict[str, Any]] = []
    for scenario in target_data.get("scenarios", []):
        if not isinstance(scenario, dict):
            continue
        scenario_id = str(scenario.get("scenario_id") or "")
        try:
            pga_g = float(scenario_id.lower().removesuffix("g"))
        except ValueError:
            pga_g = None
        probabilities = scenario.get("hospital_damage_probabilities", [])
        max_idr = scenario.get("mean_max_idr", [])
        repair_days = scenario.get("mean_repair_time_days", [])
        failure = scenario.get("hospital_failure_probability", [])
        count = max(
            len(probabilities) if isinstance(probabilities, list) else 0,
            len(entity_rows),
        )
        for index in range(count):
            hospital_id = (
                str(entity_rows[index].get("hospital_id"))
                if index < len(entity_rows)
                else f"H{index + 1}"
            )
            entity = entity_by_id.get(hospital_id, {})
            name = str(entity.get("hospital_name") or hospital_id)
            name = re.sub(rf"^{re.escape(hospital_id)}\s*", "", name)
            row_probabilities = (
                probabilities[index]
                if isinstance(probabilities, list)
                and index < len(probabilities)
                and isinstance(probabilities[index], list)
                else []
            )
            modal_state = (
                max(
                    range(len(row_probabilities)),
                    key=lambda item: float(row_probabilities[item]),
                )
                if row_probabilities
                else None
            )
            modal_probability = (
                float(row_probabilities[modal_state])
                if modal_state is not None
                else None
            )
            hospital_summary.append(
                {
                    "scenario_id": scenario_id,
                    "hospital_id": hospital_id,
                    "hospital_name": name,
                    "modal_damage_state": modal_state,
                    "modal_damage_label": (
                        labels[modal_state]
                        if modal_state is not None and modal_state < len(labels)
                        else None
                    ),
                    "modal_damage_probability": modal_probability,
                    "probability_any_damage": (
                        1.0 - float(row_probabilities[0])
                        if row_probabilities
                        else None
                    ),
                    "mean_max_idr": (
                        max_idr[index]
                        if isinstance(max_idr, list) and index < len(max_idr)
                        else None
                    ),
                    "mean_repair_time_days": (
                        repair_days[index]
                        if isinstance(repair_days, list)
                        and index < len(repair_days)
                        else None
                    ),
                    "hospital_failure_probability": (
                        failure[index]
                        if isinstance(failure, list) and index < len(failure)
                        else None
                    ),
                }
            )
        numeric_idr = [
            float(item) for item in max_idr
            if isinstance(item, (int, float))
        ] if isinstance(max_idr, list) else []
        numeric_repair = [
            float(item) for item in repair_days
            if isinstance(item, (int, float))
        ] if isinstance(repair_days, list) else []
        numeric_failure = [
            float(item) for item in failure
            if isinstance(item, (int, float))
        ] if isinstance(failure, list) else []
        scenario_summary.append(
            {
                "scenario_id": scenario_id,
                "pga_g": pga_g,
                "system_failure_probability": scenario.get(
                    "system_failure_probability"
                ),
                "mean_hospital_failure_probability": (
                    sum(numeric_failure) / len(numeric_failure)
                    if numeric_failure
                    else None
                ),
                "mean_max_idr": (
                    sum(numeric_idr) / len(numeric_idr)
                    if numeric_idr
                    else None
                ),
                "mean_repair_time_days": (
                    sum(numeric_repair) / len(numeric_repair)
                    if numeric_repair
                    else None
                ),
            }
        )
    return {
        "scenario_summary": scenario_summary,
        "hospital_summary": hospital_summary,
        "damage_labels": labels,
        "component_count": target_data.get("component_count"),
        "unsupported_component_count": target_data.get(
            "unsupported_component_count"
        ),
        "vulnerability_curve": target_data.get("vulnerability_curve", []),
    }


def _hospital_identity(
    entities: list[Any],
    index: int,
    hospital_ids: list[Any] | None = None,
    hospital_names: list[Any] | None = None,
) -> tuple[str, str]:
    entity_rows = [item for item in entities if isinstance(item, dict)]
    hospital_id = (
        str(hospital_ids[index])
        if hospital_ids and index < len(hospital_ids)
        else str(entity_rows[index].get("hospital_id"))
        if index < len(entity_rows) and entity_rows[index].get("hospital_id")
        else f"H{index + 1}"
    )
    entity = next(
        (
            item
            for item in entity_rows
            if str(item.get("hospital_id") or "") == hospital_id
        ),
        {},
    )
    name = (
        str(hospital_names[index])
        if hospital_names and index < len(hospital_names)
        else str(entity.get("hospital_name") or hospital_id)
    )
    return hospital_id, re.sub(rf"^{re.escape(hospital_id)}\s*", "", name)


def _hospital_function_summary(
    target_data: dict[str, Any],
    entities: list[Any],
) -> dict[str, Any]:
    hospital_ids = target_data.get("hospital_ids", [])
    hospital_names = target_data.get("hospital_names", [])
    severity_names = [str(item) for item in target_data.get("severity_names", [])]
    scenario_summary: list[dict[str, Any]] = []
    hospital_rows: list[dict[str, Any]] = []
    for scenario in target_data.get("scenarios", []):
        if not isinstance(scenario, dict):
            continue
        scenario_id = str(scenario.get("scenario_id") or "")
        ratios = scenario.get("mean_function_ratio", [])
        losses = scenario.get("mean_function_loss", [])
        p05_losses = scenario.get("p05_function_loss", [])
        p95_losses = scenario.get("p95_function_loss", [])
        capacity_1h = scenario.get("mean_treatment_capacity_1h", [])
        capacity_72h = scenario.get("mean_treatment_capacity_72h", [])
        weighted_capacity = scenario.get(
            "mean_weighted_treatment_capacity_72h",
            scenario.get("mean_weighted_capacity_72h", []),
        )
        count = max(
            len(ratios) if isinstance(ratios, list) else 0,
            len(hospital_ids) if isinstance(hospital_ids, list) else 0,
            len([item for item in entities if isinstance(item, dict)]),
        )
        for index in range(count):
            hospital_id, hospital_name = _hospital_identity(
                entities,
                index,
                hospital_ids if isinstance(hospital_ids, list) else None,
                hospital_names if isinstance(hospital_names, list) else None,
            )
            hospital_rows.append(
                {
                    "scenario_id": scenario_id,
                    "hospital_id": hospital_id,
                    "hospital_name": hospital_name,
                    "mean_function_ratio": ratios[index]
                    if isinstance(ratios, list) and index < len(ratios)
                    else None,
                    "mean_function_loss": losses[index]
                    if isinstance(losses, list) and index < len(losses)
                    else None,
                    "p05_function_loss": p05_losses[index]
                    if isinstance(p05_losses, list) and index < len(p05_losses)
                    else None,
                    "p95_function_loss": p95_losses[index]
                    if isinstance(p95_losses, list) and index < len(p95_losses)
                    else None,
                    "mean_treatment_capacity_1h": capacity_1h[index]
                    if isinstance(capacity_1h, list) and index < len(capacity_1h)
                    else [],
                    "mean_treatment_capacity_72h": capacity_72h[index]
                    if isinstance(capacity_72h, list) and index < len(capacity_72h)
                    else [],
                    "mean_weighted_treatment_capacity_72h": weighted_capacity[index]
                    if isinstance(weighted_capacity, list)
                    and index < len(weighted_capacity)
                    else None,
                }
            )
        numeric_ratios = [
            float(item) for item in ratios if isinstance(item, (int, float))
        ] if isinstance(ratios, list) else []
        numeric_losses = [
            float(item) for item in losses if isinstance(item, (int, float))
        ] if isinstance(losses, list) else []
        scenario_summary.append(
            {
                "scenario_id": scenario_id,
                "mean_function_ratio": sum(numeric_ratios) / len(numeric_ratios)
                if numeric_ratios
                else None,
                "mean_function_loss": sum(numeric_losses) / len(numeric_losses)
                if numeric_losses
                else None,
                "minimum_function_ratio": min(numeric_ratios)
                if numeric_ratios
                else None,
            }
        )
    return {
        "scenario_summary": scenario_summary,
        "hospital_function_summary": hospital_rows,
        "severity_names": severity_names,
        "treatment_capacity_unit": target_data.get("treatment_capacity_unit"),
        "functionality_definition": target_data.get("functionality_definition"),
        "fallback_evaluation_count": target_data.get("fallback_evaluation_count"),
    }


def _casualty_response_summary(
    target_data: dict[str, Any],
    entities: list[Any],
    allowed_roots: list[Path],
) -> dict[str, Any]:
    scenario_summary: list[dict[str, Any]] = []
    horizon = treatment_window(target_data)
    scenario_ids: list[str] = []
    active_indices = [int(index) for index in target_data.get("emergency_severity_indices", [0, 1, 2])]
    for scenario in target_data.get("scenarios", []):
        if not isinstance(scenario, dict):
            continue
        scenario_id = str(scenario.get("scenario_id") or "")
        if scenario_id not in scenario_ids:
            scenario_ids.append(scenario_id)
        total_demand = scenario.get("mean_total_demand", [])
        treated = scenario.get("mean_treated_capacity", [])
        unmet = scenario.get("mean_unmet_demand", [])
        survivor_adjusted = scenario.get("mean_survivor_adjusted_treatment", [])
        scenario_summary.append(
            {
                "period": scenario.get("period"),
                "scenario_id": scenario_id,
                "treatment_horizon_hours": horizon,
                **{key: scenario.get(key) for key in period_metric_fields(horizon)},
                "mean_total_demand": total_demand,
                "mean_treated_capacity": treated,
                "mean_instantaneous_treatable_capacity": scenario.get("mean_instantaneous_treatable_capacity", []),
                "mean_unmet_demand": unmet,
                "mean_survivor_adjusted_treatment": survivor_adjusted,
                "treatment_rate_by_severity": scenario.get("treatment_rate_by_severity", scenario.get("treatment_fulfillment_by_severity", [])),
                "instantaneous_treatment_rate_by_severity": scenario.get("instantaneous_treatment_rate_by_severity", []),
                "severe_instantaneous_treatment_rate": scenario.get("severe_instantaneous_treatment_rate"),
                "treatment_fulfillment_by_severity": scenario.get("treatment_fulfillment_by_severity", []),
                "survival_fulfillment_by_severity": scenario.get("survival_fulfillment_by_severity", []),
                "mean_care_start_hours": scenario.get("mean_care_start_hours", []),
                "total_demand": sum(float(total_demand[index]) for index in active_indices),
                "total_treated": sum(float(treated[index]) for index in active_indices),
                "total_unmet": sum(float(unmet[index]) for index in active_indices),
                "total_survivor_adjusted": sum(
                    float(survivor_adjusted[index]) for index in active_indices
                ),
            }
        )

    hospital_load: list[dict[str, Any]] = []
    artifact = target_data.get("casualty_artifact")
    artifact_path = (
        _available_artifact_path(
            Path(str(artifact.get("path") or "")),
            allowed_roots,
        )
        if isinstance(artifact, dict)
        else None
    )
    if artifact_path is not None:
        try:
            with np.load(artifact_path, allow_pickle=False) as arrays:
                hospital_demand = arrays["hospital_demand"]
                treated_capacity = arrays["treated_capacity"]
                unmet_demand = arrays["unmet_demand"]
                survivor_adjusted = arrays["survivor_adjusted"]
                periods = [str(item) for item in target_data.get("periods", [])]
                for period_index in range(hospital_demand.shape[0]):
                    period = periods[period_index] if period_index < len(periods) else str(period_index)
                    for scenario_index in range(hospital_demand.shape[1]):
                        scenario_id = (
                            scenario_ids[scenario_index]
                            if scenario_index < len(scenario_ids)
                            else str(scenario_index)
                        )
                        assigned_mean = hospital_demand[period_index, scenario_index].mean(axis=0)
                        treated_mean = treated_capacity[period_index, scenario_index].mean(axis=0)
                        unmet_mean = unmet_demand[period_index, scenario_index].mean(axis=0)
                        survivor_mean = survivor_adjusted[period_index, scenario_index].mean(axis=0)
                        for hospital_index in range(assigned_mean.shape[0]):
                            hospital_id, hospital_name = _hospital_identity(
                                entities, hospital_index
                            )
                            assigned_values = assigned_mean[hospital_index].tolist()
                            treated_values = treated_mean[hospital_index].tolist()
                            unmet_values = unmet_mean[hospital_index].tolist()
                            survivor_values = survivor_mean[hospital_index].tolist()
                            hospital_load.append(
                                {
                                    "period": period,
                                    "scenario_id": scenario_id,
                                    "hospital_id": hospital_id,
                                    "hospital_name": hospital_name,
                                    "mean_assigned_by_severity": assigned_values,
                                    "mean_treated_by_severity": treated_values,
                                    "mean_unmet_by_severity": unmet_values,
                                    "mean_survivor_adjusted_by_severity": survivor_values,
                                    "mean_assigned_total": float(sum(assigned_values[index] for index in active_indices)),
                                    "mean_treated_total": float(sum(treated_values[index] for index in active_indices)),
                                    "mean_unmet_total": float(sum(unmet_values[index] for index in active_indices)),
                                    "mean_survivor_adjusted_total": float(
                                        sum(survivor_values[index] for index in active_indices)
                                    ),
                                }
                            )
        except (OSError, ValueError, KeyError, IndexError):
            hospital_load = []
    return {
        "scenario_summary": scenario_summary,
        "casualty_hospital_load": hospital_load,
        "treatment_horizon_hours": horizon,
        "periods": target_data.get("periods", []),
        "severity_labels": target_data.get("severity_labels", []),
        "emergency_severity_indices": active_indices,
        "emergency_severity_labels": target_data.get("emergency_severity_labels", []),
        "demand_conservation_max_error": target_data.get(
            "demand_conservation_max_error"
        ),
    }


def _recovery_optimization_summary(
    target_data: dict[str, Any],
    entities: list[Any],
) -> dict[str, Any]:
    rows: list[dict[str, Any]] = []
    robust_orders: list[dict[str, Any]] = []
    for scenario in target_data.get("scenarios", []):
        if not isinstance(scenario, dict):
            continue
        row = {
            key: value
            for key, value in scenario.items()
            if key
            in {
                "strategy",
                "scenario_id",
                "mean_resilience",
                "p05_resilience",
                "p95_resilience",
                "mean_recovery_time_days",
                "p95_recovery_time_days",
                "training_improvement",
            }
        }
        order = scenario.get("implementable_order")
        if isinstance(order, list) and order:
            order_ids = [str(item) for item in order]
            entity_rows = [item for item in entities if isinstance(item, dict)]
            names: list[str] = []
            for hospital_id in order_ids:
                entity = next(
                    (
                        item
                        for item in entity_rows
                        if str(item.get("hospital_id") or "") == hospital_id
                    ),
                    {},
                )
                name = str(entity.get("hospital_name") or hospital_id)
                names.append(re.sub(rf"^{re.escape(hospital_id)}\s*", "", name))
            row["implementable_order"] = order_ids
            row["order_names"] = names
            robust_orders.append(
                {
                    "scenario_id": row.get("scenario_id"),
                    "strategy": row.get("strategy"),
                    "order": order_ids,
                    "order_names": names,
                    "order_display": " -> ".join(
                        f"{hospital_id} {name}"
                        for hospital_id, name in zip(order_ids, names)
                    ),
                }
            )
        rows.append(row)
    return {
        "recovery_strategy_summary": rows,
        "robust_orders": robust_orders,
        "team_count": target_data.get("team_count"),
        "control_time_days": target_data.get("control_time_days"),
        "strategies": target_data.get("strategies", []),
    }


def _road_accessibility_summary(target_data: dict[str, Any]) -> dict[str, Any]:
    scenario_summary: list[dict[str, Any]] = []
    for scenario in target_data.get("scenarios", []):
        if not isinstance(scenario, dict):
            continue
        scenario_id = str(scenario.get("scenario_id") or "")
        try:
            pga_g = float(scenario_id.lower().removesuffix("g"))
        except ValueError:
            pga_g = None
        scenario_summary.append(
            {
                "scenario_id": scenario_id,
                "pga_g": pga_g,
                "population_coverage_ratio": scenario.get(
                    "population_coverage_ratio"
                ),
                "covered_population": scenario.get("covered_population"),
                "unreachable_population": scenario.get("unreachable_population"),
                "population_weighted_nearest_time_minutes": scenario.get(
                    "population_weighted_nearest_time_minutes"
                ),
                "mean_accessible_hospital_count": scenario.get(
                    "mean_accessible_hospital_count"
                ),
                "hospital_catchment_population": scenario.get(
                    "hospital_catchment_population", []
                ),
            }
        )
    return {
        "scenario_summary": scenario_summary,
        "service_radius_minutes": target_data.get("service_radius_minutes"),
        "decay_model": target_data.get("decay_model"),
    }


def _iteration_views(
    history: Any,
    session_id: str,
    allowed_roots: list[Path],
    output_language: str = "zh-CN",
    requested_skill_ids: list[str] | None = None,
) -> list[dict[str, Any]]:
    if not isinstance(history, list):
        return []
    output: list[dict[str, Any]] = []
    for record in history:
        if not isinstance(record, dict) or not isinstance(record.get("skill_result"), dict):
            continue
        result = record["skill_result"]
        try:
            iteration = int(record.get("iteration"))
        except (TypeError, ValueError):
            continue
        output.append(
            {
                "iteration": iteration,
                "run_id": record.get("run_id") or result.get("run_id"),
                "completed_at": record.get("completed_at"),
                "reviewed_at": record.get("reviewed_at"),
                "plan": record.get("plan"),
                "interpretation": record.get("interpretation"),
                "expert_decision": record.get("expert_decision"),
                "result": {
                    "status": result.get("status"),
                    "skill_id": result.get("skill_id"),
                    "run_id": result.get("run_id"),
                    "warnings": localize_warning_dicts(
                        result.get("warnings", []), output_language
                    ),
                    "assumptions": localize_assumptions(
                        result.get("assumptions", []), output_language
                    ),
                    "provenance": result.get("provenance", {}),
                },
                "report_summary": _report_summary(
                    result,
                    allowed_roots,
                    output_language,
                    requested_skill_ids,
                ),
                "result_delivery": _delivery_view(result),
                "execution_trace": _execution_trace_view(result),
                "artifacts": _artifact_views(result, session_id, iteration),
            }
        )
    return output


@dataclass
class SessionRuntime:
    session_id: str
    user_message: str
    preset_id: str
    request_context: dict[str, Any]
    graph: Any
    config: dict[str, Any]
    created_at: str = field(default_factory=_utc_now)
    updated_at: str = field(default_factory=_utc_now)
    status: str = "received"
    result: dict[str, Any] = field(default_factory=dict)
    interrupt: dict[str, Any] | None = None
    error: str | None = None
    historical_read_only: bool = False
    follow_ups: list[dict[str, Any]] = field(default_factory=list)
    worker: threading.Thread | None = field(default=None, repr=False)
    lock: threading.RLock = field(default_factory=threading.RLock, repr=False)
    report_lock: threading.RLock = field(default_factory=threading.RLock, repr=False)


class SessionManager:
    def __init__(
        self,
        settings: AgentSettings,
        llm_factory: Callable[[AgentSettings], DecisionLLM] | None = None,
    ) -> None:
        self.settings = settings
        self.llm_factory = llm_factory or (lambda current: DeepSeekDecisionLLM(current))
        self.settings.agent_run_root.mkdir(parents=True, exist_ok=True)
        checkpoint_root = self.settings.agent_run_root / "_state"
        checkpoint_root.mkdir(parents=True, exist_ok=True)
        self._checkpoint_connection = sqlite3.connect(
            checkpoint_root / "langgraph.sqlite3",
            check_same_thread=False,
        )
        self._checkpoint_connection.execute("PRAGMA journal_mode=WAL")
        self._checkpoint_connection.execute("PRAGMA busy_timeout=5000")
        self.checkpointer = SqliteSaver(
            self._checkpoint_connection,
            serde=JsonPlusSerializer(
                allowed_msgpack_modules=[("langgraph", "types")],
            ),
        )
        self.audit = AuditStore(settings.agent_run_root)
        self.expert_memory = ExpertMemoryStore(settings.agent_run_root / "expert_memory.sqlite3")
        self.knowledge = HybridKnowledgeRetriever(
            settings.knowledge_root,
            auto_build=settings.knowledge_auto_build,
        )
        self.sessions: dict[str, SessionRuntime] = {}
        self.lock = threading.RLock()
        self.bridge = SkillRegistryBridge(settings.skill_run_root)
        self.catalog = self.bridge.target_catalog()
        self.presentation_builder = EnglishPresentationBuilder()
        self.session_report_builder = SessionReportBuilder()
        self.power_scenes = PowerSceneStore(
            settings.workspace_root or project_paths(validate=False).workspace_root,
            self.allowed_artifact_roots,
        )
        self._restore_sessions()

    @property
    def allowed_artifact_roots(self) -> list[Path]:
        return [self.settings.skill_run_root.resolve(), self.settings.agent_run_root.resolve()]

    def _new_graph(self):
        llm = self.llm_factory(self.settings)
        center = SeismoSkillDecisionCenter(
            self.settings,
            llm,
            retriever=self.knowledge,
            skill_bridge=self.bridge,
            expert_memory=self.expert_memory,
        )
        return build_agent_graph(center, checkpointer=self.checkpointer)

    def _session_metadata_path(self, session_id: str) -> Path:
        return self.settings.agent_run_root.resolve() / _safe_session_id(session_id) / "session.json"

    def _persist_runtime(self, runtime: SessionRuntime) -> None:
        with runtime.lock:
            payload = {
                "schema_version": 1,
                "metric_standard": (
                    None if runtime.historical_read_only
                    else metric_standard_record(runtime.request_context.get("treatment_horizon_hours", 72))
                ),
                "session_id": runtime.session_id,
                "user_message": runtime.user_message,
                "preset_id": runtime.preset_id,
                "request_context": runtime.request_context,
                "created_at": runtime.created_at,
                "updated_at": runtime.updated_at,
                "status": runtime.status,
                "interrupt": runtime.interrupt,
                "error": runtime.error,
                "follow_ups": runtime.follow_ups,
            }
        path = self._session_metadata_path(runtime.session_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(".json.tmp")
        temporary.write_text(
            json.dumps(redact(payload), ensure_ascii=False, indent=2, default=str),
            encoding="utf-8",
        )
        temporary.replace(path)

    def _refresh_session_report(
        self,
        runtime: SessionRuntime,
        *,
        status: str | None = None,
        raise_on_error: bool = False,
        reason: str = "background_refresh",
    ) -> Path | None:
        if runtime.historical_read_only or historical_result(runtime.result.get("skill_result")):
            existing = _session_artifact_paths(self.settings.agent_run_root, runtime.session_id)
            return existing[0] if existing else None
        try:
            with runtime.report_lock:
                with runtime.lock:
                    state = deepcopy(runtime.result)
                    follow_ups = deepcopy(runtime.follow_ups)
                    report_status = status or runtime.status
                    output_language = normalize_output_language(
                        runtime.request_context.get("output_language")
                    )
                analysis = (
                    state.get("task_analysis")
                    if isinstance(state.get("task_analysis"), dict)
                    else None
                )
                requested_skill_ids = (
                    [
                        str(item)
                        for item in analysis.get("requested_capabilities", [])
                        if isinstance(item, str) and item
                    ]
                    if isinstance(analysis, dict)
                    else []
                )
                iterations = _iteration_views(
                    state.get("iteration_history", []),
                    runtime.session_id,
                    self.allowed_artifact_roots,
                    output_language,
                    requested_skill_ids,
                )
                if not iterations:
                    return None
                output_directory = _session_report_directory(
                    self.settings.agent_run_root,
                    runtime.session_id,
                )
                output_directory.mkdir(parents=True, exist_ok=True)
                generated = Path(
                    self.session_report_builder.build(
                        session_id=runtime.session_id,
                        user_message=runtime.user_message,
                        status=report_status,
                        iterations=iterations,
                        follow_ups=follow_ups,
                        final_answer=state.get("final_answer")
                        if isinstance(state.get("final_answer"), str)
                        else None,
                        output_language=output_language,
                        output_path=output_directory,
                    )
                ).resolve()
                if (
                    not generated.is_file()
                    or not _is_within(generated, [output_directory])
                    or not _is_within(generated, self.allowed_artifact_roots)
                ):
                    raise PermissionError(
                        "Session report builder returned an unavailable artifact"
                    )
                return generated
        except Exception as exc:
            message = f"{type(exc).__name__}: {exc}"
            try:
                self.audit.record(
                    runtime.session_id,
                    "session_report_error",
                    {"reason": reason, "message": message},
                )
            except Exception:
                pass
            if raise_on_error:
                raise RuntimeError(
                    "Unable to refresh the session report; a stale report was not served."
                ) from exc
            return None

    def _ensure_session_report(self, runtime: SessionRuntime) -> None:
        with runtime.lock:
            history = runtime.result.get("iteration_history", [])
        has_iteration = any(
            isinstance(item, dict) and isinstance(item.get("skill_result"), dict)
            for item in history
        ) if isinstance(history, list) else False
        if has_iteration:
            self._refresh_session_report(runtime, reason="session_restore")

    def _restore_sessions(self) -> None:
        metadata_files = sorted(self.settings.agent_run_root.glob("*/session.json"))
        for path in metadata_files:
            try:
                payload = _json_file(path)
                session_id = _safe_session_id(str(payload["session_id"]))
                config = {"configurable": {"thread_id": session_id}}
                graph = self._new_graph()
                snapshot = graph.get_state(config)
                values = dict(snapshot.values) if snapshot.values else {}
                interrupt_payload = _interrupt_payload(
                    {"__interrupt__": list(snapshot.interrupts)}
                )
                has_pending_work = bool(snapshot.next) and interrupt_payload is None
                status = str(values.get("status") or payload.get("status") or "received")
                if has_pending_work:
                    status = "recovering"
                runtime = SessionRuntime(
                    session_id=session_id,
                    user_message=str(payload.get("user_message") or values.get("user_message") or ""),
                    preset_id=str(payload.get("preset_id") or "quick"),
                    request_context=payload.get("request_context")
                    if isinstance(payload.get("request_context"), dict)
                    else dict(values.get("request_context") or {}),
                    graph=graph,
                    config=config,
                    created_at=str(payload.get("created_at") or _utc_now()),
                    updated_at=str(payload.get("updated_at") or _utc_now()),
                    status=status,
                    result=values,
                    interrupt=interrupt_payload,
                    error=payload.get("error"),
                    follow_ups=payload.get("follow_ups")
                    if isinstance(payload.get("follow_ups"), list)
                    else [],
                )
            except Exception as exc:
                self.audit.record(
                    path.parent.name,
                    "session_restore_error",
                    {"message": f"{type(exc).__name__}: {exc}"},
                )
                continue
            self.sessions[session_id] = runtime
            clinical = bool(runtime.request_context.get("dataset_source")) or clinical_record(runtime.result.get("skill_result", {}).get("data"))
            legacy = (clinical and not is_official_metric_record(payload)) or historical_result(runtime.result.get("skill_result"))
            if legacy:
                runtime.historical_read_only = True
                runtime.interrupt = None
                has_pending_work = False
                runtime.status = "succeeded"
            else:
                self._ensure_session_report(runtime)
            if has_pending_work and not legacy:
                self._start_worker(runtime, resume_from_checkpoint=True)

    def close(self) -> None:
        with self.lock:
            runtimes = list(self.sessions.values())
        for runtime in runtimes:
            worker = runtime.worker
            if worker is not None and worker.is_alive():
                worker.join(timeout=5)
        self._checkpoint_connection.close()

    def create_session(
        self,
        user_message: str,
        preset_id: str = "quick",
        overrides: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        message = user_message.strip()
        if not message:
            raise ValueError("请输入需要评估或决策的问题。")
        if len(message) > 12000:
            raise ValueError("问题内容过长，请控制在12000字符以内。")
        context = load_preset(
            preset_id, overrides, workspace_root=self.settings.workspace_root, user_message=message
        )
        output_language = normalize_output_language(context.get("output_language"))
        context["output_language"] = output_language
        session_id = f"web-{datetime.now().strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:8]}"
        graph = self._new_graph()
        runtime = SessionRuntime(
            session_id=session_id,
            user_message=message,
            preset_id=preset_id,
            request_context=context,
            graph=graph,
            config={"configurable": {"thread_id": session_id}},
            status="analyzing",
        )
        with self.lock:
            self.sessions[session_id] = runtime
        self._persist_runtime(runtime)
        self._start_worker(runtime, initial=True)
        return self.session_view(session_id)

    def _start_worker(
        self,
        runtime: SessionRuntime,
        *,
        initial: bool = False,
        decision: dict[str, Any] | None = None,
        resume_from_checkpoint: bool = False,
    ) -> None:
        def target() -> None:
            try:
                if initial:
                    state = {
                        "session_id": runtime.session_id,
                        "user_message": runtime.user_message,
                        "request_context": runtime.request_context,
                        "output_language": runtime.request_context.get("output_language", "zh-CN"),
                        "status": "received",
                        "errors": [],
                    }
                    result = runtime.graph.invoke(state, config=runtime.config)
                elif resume_from_checkpoint:
                    result = runtime.graph.invoke(None, config=runtime.config)
                else:
                    result = runtime.graph.invoke(Command(resume=decision), config=runtime.config)
                interrupt_payload = _interrupt_payload(result)
                result_status = (
                    str(result.get("status") or "awaiting_approval")
                    if interrupt_payload is not None
                    else str(result.get("status") or "succeeded")
                )
                with runtime.lock:
                    runtime.result = result
                    runtime.updated_at = _utc_now()
                self._refresh_session_report(
                    runtime,
                    status=result_status,
                    reason="graph_return",
                )
                with runtime.lock:
                    runtime.interrupt = interrupt_payload
                    runtime.status = result_status
                    runtime.worker = None
                self._persist_runtime(runtime)
            except Exception as exc:
                message = f"{type(exc).__name__}: {exc}"
                with runtime.lock:
                    runtime.status = "failed"
                    runtime.error = message
                    runtime.interrupt = None
                    runtime.updated_at = _utc_now()
                    runtime.worker = None
                self.audit.record(runtime.session_id, "web_runtime_error", {"message": message})
                self._persist_runtime(runtime)

        worker = threading.Thread(
            target=target,
            name=f"seismo-session-{runtime.session_id}",
            daemon=True,
        )
        with runtime.lock:
            runtime.worker = worker
        worker.start()

    def decide(self, session_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        runtime = self._get(session_id)
        if getattr(runtime, "historical_read_only", False) or historical_result(getattr(runtime, "result", {}).get("skill_result")):
            raise ValueError(HISTORICAL_NOTICE)
        with runtime.lock:
            if runtime.worker is not None and runtime.worker.is_alive():
                raise RuntimeError("当前会话仍在处理上一项操作。")
            if runtime.interrupt is None:
                raise RuntimeError("当前会话没有等待处理的人工审核。")
            review_type = runtime.interrupt.get("type")
            allowed_actions = runtime.interrupt.get("allowed_actions")
        if review_type in {"result_review", "feedback_clarification"}:
            decision = ExpertReviewDecision.model_validate(payload).model_dump(mode="json")
            if decision["reviewer_role"] not in {"domain_expert", "emergency_manager"}:
                raise ValueError("Result review requires domain_expert or emergency_manager role")
        elif review_type == "execution_recovery":
            decision = RecoveryDecision.model_validate(payload).model_dump(mode="json")
        else:
            decision = HumanDecision.model_validate(payload).model_dump(mode="json")
        if review_type == "request_revision" and decision["action"] == "approve":
            raise ValueError("当前计划校验未通过，只能修改参数或拒绝执行。")
        if isinstance(allowed_actions, list) and decision["action"] not in allowed_actions:
            raise ValueError(f"当前审查阶段不允许操作：{decision['action']}")
        with runtime.lock:
            runtime.interrupt = None
            runtime.error = None
            runtime.status = {
                "edit": "revalidating",
                "revise": "processing_feedback",
                "approve": "executing",
                "accept": "finalizing",
                "reject": "finalizing",
                "retry": "executing",
            }[decision["action"]]
            runtime.updated_at = _utc_now()
        self._persist_runtime(runtime)
        self._start_worker(runtime, decision=decision)
        return self.session_view(session_id)

    @staticmethod
    def _expert_memory_scope(state: dict[str, Any]) -> tuple[str, str] | None:
        scope = state.get("expert_memory_scope")
        if not isinstance(scope, dict):
            return None
        domain, target_system = scope.get("domain"), scope.get("target_system")
        if isinstance(domain, str) and domain and isinstance(target_system, str) and target_system:
            return domain, target_system
        return None

    def _expert_memory_view(self, session_id: str, state: dict[str, Any]) -> dict[str, Any]:
        scope = self._expert_memory_scope(state)
        try:
            notes = self.expert_memory.notes(session_id)
            if scope is None:
                return {"available": False, "notes": notes, "experiences": [], "retrieved": []}
            _, retrieved = review_memory_context(self.expert_memory, {**state, "session_id": session_id})
            return {
                "available": True,
                "scope": {"domain": scope[0], "target_system": scope[1]},
                "notes": notes,
                "experiences": self.expert_memory.experiences(*scope, session_id=session_id),
                "retrieved": retrieved,
            }
        except (sqlite3.Error, OSError):
            return {"available": False, "notes": [], "experiences": [], "retrieved": [], "storage_unavailable": True}

    def update_expert_memory(self, session_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        action = payload.get("action")
        if action not in ("confirm", "withdraw", "publish", "revoke"):
            raise ValueError("Unknown expert-memory action.")
        item_key = "item_id" if action == "revoke" else "note_id"
        allowed = {"action", item_key, "reviewer"}
        if action == "publish":
            allowed.add("publication")
        if set(payload) - allowed:
            raise ValueError("Unexpected fields in expert-memory request.")
        item_id, reviewer = payload.get(item_key), payload.get("reviewer")
        if not isinstance(item_id, str) or not item_id.strip() or len(item_id) > 128:
            raise ValueError(f"A valid {item_key} is required.")
        if not isinstance(reviewer, str) or not reviewer.strip() or len(reviewer.strip()) > 128:
            raise ValueError("A reviewer name or identifier is required.")
        reviewer = reviewer.strip()
        with self.lock:
            runtime = self._get(session_id)
            with runtime.lock:
                if runtime.historical_read_only or historical_result(runtime.result.get("skill_result")):
                    raise ValueError(HISTORICAL_NOTICE)
                if runtime.worker is not None and runtime.worker.is_alive():
                    raise RuntimeError("Wait until the current session operation finishes before reviewing its memory.")
                state = runtime.result
                scope = self._expert_memory_scope(state)
                if action in ("publish", "revoke") and scope is None:
                    raise ValueError("A validated engineering case scope is required to publish or revoke experience.")
                audit_detail = {"action": action, item_key: item_id}
                try:
                    if action in ("confirm", "withdraw"):
                        self.expert_memory.review_note(session_id, item_id, "confirmed" if action == "confirm" else "withdrawn", reviewer)
                    elif action == "publish":
                        publication = payload.get("publication")
                        if not isinstance(publication, dict) or set(publication) - {"principle", "applicability", "tags", "valid_until"}:
                            raise ValueError("Publication must contain the reviewed principle, applicability and optional tags or expiry date.")
                        domain, target_system = scope
                        note = next((record for record in self.expert_memory.notes(session_id) if record["id"] == item_id), None)
                        if note is None:
                            raise KeyError("Feedback note was not found in this session")
                        if (note.get("domain"), note.get("target_system")) != scope:
                            raise ValueError("Cross-case publication requires the note's original scope to match the current validated case scope.")
                        record = self.expert_memory.publish(
                            session_id, item_id, ExperiencePublication.model_validate({**publication, "reviewer": reviewer}),
                            domain=domain, target_system=target_system,
                        )
                        audit_detail["item_id"] = record["id"]
                    else:
                        domain, target_system = scope
                        self.expert_memory.revoke(item_id, reviewer, domain=domain, target_system=target_system, session_id=session_id)
                except (sqlite3.Error, OSError) as exc:
                    raise RuntimeError("Expert memory is temporarily unavailable.") from exc
                self.audit.record(session_id, "expert_memory_review", audit_detail)
                return self._expert_memory_view(session_id, state)

    def ask_follow_up(self, session_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        runtime = self._get(session_id)
        if runtime.historical_read_only or historical_result(runtime.result.get("skill_result")):
            raise ValueError(HISTORICAL_NOTICE)
        request = FollowUpRequest.model_validate(payload)
        with runtime.lock:
            if runtime.worker is not None and runtime.worker.is_alive():
                raise RuntimeError("当前会话仍在处理上一项操作。")
            if runtime.status not in {"awaiting_result_review", "succeeded"}:
                raise RuntimeError("只有在工程结果生成后才能对当前结果追问。")
            previous_status = runtime.status
            state = dict(runtime.result)
            current_result = (
                state.get("skill_result")
                if isinstance(state.get("skill_result"), dict)
                else {}
            )
            current_run_id = str(current_result.get("run_id") or "") or None
            try:
                current_iteration = int(state.get("iteration"))
            except (TypeError, ValueError):
                current_iteration = None
            if current_iteration is None:
                history = state.get("iteration_history", [])
                iteration_numbers = []
                for record in history if isinstance(history, list) else []:
                    if not isinstance(record, dict):
                        continue
                    try:
                        iteration_numbers.append(int(record.get("iteration")))
                    except (TypeError, ValueError):
                        continue
                current_iteration = max(iteration_numbers, default=None)
            item = {
                "message_id": f"follow-up-{uuid.uuid4().hex[:10]}",
                "question": request.question,
                "actor": request.actor,
                "actor_role": request.actor_role,
                "iteration": current_iteration,
                "run_id": current_run_id,
                "asked_at": _utc_now(),
                "status": "answering",
                "answer": None,
            }
            runtime.follow_ups.append(item)
            runtime.status = "answering"
            runtime.updated_at = _utc_now()
        self._persist_runtime(runtime)

        def target() -> None:
            try:
                with runtime.lock:
                    state = dict(runtime.result)
                    prior_follow_ups = _compact_prior_follow_ups(
                        runtime.follow_ups[:-1]
                    )
                result = state.get("skill_result") if isinstance(state.get("skill_result"), dict) else {}
                report_summary = _report_summary(
                    result,
                    self.allowed_artifact_roots,
                    runtime.request_context.get("output_language", "zh-CN"),
                )
                result_summary = _follow_up_result_context(
                    result,
                    report_summary,
                    state.get("current_interpretation"),
                    request.question,
                )
                history = []
                current_run_id = str(result.get("run_id") or "")
                for record in state.get("iteration_history", []):
                    if not isinstance(record, dict):
                        continue
                    historical_result = (
                        record.get("skill_result")
                        if isinstance(record.get("skill_result"), dict)
                        else {}
                    )
                    historical_run_id = str(
                        record.get("run_id") or historical_result.get("run_id") or ""
                    )
                    if current_run_id and historical_run_id == current_run_id:
                        continue
                    historical_report = _report_summary(
                        historical_result,
                        self.allowed_artifact_roots,
                        runtime.request_context.get("output_language", "zh-CN"),
                    )
                    compatibility = comparison_status(report_summary, historical_report)
                    if not compatibility["comparable"]:
                        history.append({"iteration": record.get("iteration"), "run_id": historical_run_id,
                            "comparison_status": compatibility,
                            "notice": "Different/unknown metric, data or evaluation window; no numerical improvement comparison."})
                        continue
                    history.append(
                        {
                            "comparison_status": compatibility,
                            "iteration": record.get("iteration"),
                            "run_id": historical_run_id,
                            "plan": _compact_plan_for_follow_up(record.get("plan")),
                            "result": _follow_up_result_context(
                                historical_result,
                                historical_report,
                                record.get("interpretation"),
                                request.question,
                            ),
                            "expert_decision": _prompt_bounded(
                                record.get("expert_decision")
                            ),
                        }
                    )
                history.extend(prior_follow_ups)
                case_memory, experience_memory = review_memory_context(self.expert_memory, state)
                prior_evidence = self.knowledge.current_evidence(state.get("knowledge_evidence", []))
                focused_evidence = self.knowledge.retrieve([request.question])
                evidence = _compact_follow_up_evidence(
                    merge_evidence(focused_evidence, prior_evidence, limit=6)
                )
                messages = follow_up_messages(
                    request.question,
                    _compact_plan_for_follow_up(state.get("plan")),
                    result_summary,
                    evidence,
                    history,
                    runtime.request_context.get("output_language", "zh-CN"),
                    case_memory=case_memory,
                    experience_memory=experience_memory,
                )
                context_characters = sum(len(message.get("content", "")) for message in messages)
                answer = trace_llm_call(self.llm_factory(self.settings), 'text',messages,
                    audit_store=self.audit,session_id=runtime.session_id,stage='follow_up',
                    iteration=int(state.get('iteration',0)),run_id=current_run_id or None,
                    message_id=item['message_id'])
                cited = verify_evidence_references("follow_up", evidence, text=answer)
                answer = annotate_references(
                    answer, cited, normalize_output_language(runtime.request_context.get("output_language"))
                )
                self.audit.record(runtime.session_id, "knowledge_usage", {
                    **cited, "iteration": current_iteration, "run_id": current_run_id,
                    "message_id": item["message_id"],
                })
                with runtime.lock:
                    item["status"] = "answered"
                    item["answer"] = answer
                    item["context_characters"] = context_characters
                    item["answered_at"] = _utc_now()
                    runtime.updated_at = _utc_now()
                self.audit.record(
                    runtime.session_id,
                    "follow_up_answer",
                    {
                        "message_id": item["message_id"],
                        "question": request.question,
                        "answer": answer,
                        "actor": request.actor,
                        "actor_role": request.actor_role,
                        "context_characters": context_characters,
                    },
                )
                self._refresh_session_report(
                    runtime,
                    status=previous_status,
                    reason="follow_up_answer",
                )
                with runtime.lock:
                    # Advertise readiness only after the revised report is built.
                    runtime.status = previous_status
                    runtime.worker = None
            except Exception as exc:
                message = f"{type(exc).__name__}: {exc}"
                with runtime.lock:
                    item["status"] = "failed"
                    item["error"] = message
                    runtime.status = previous_status
                    runtime.updated_at = _utc_now()
                    runtime.worker = None
                self.audit.record(
                    runtime.session_id,
                    "follow_up_error",
                    {"message_id": item["message_id"], "message": message},
                )
            finally:
                self._persist_runtime(runtime)

        worker = threading.Thread(
            target=target,
            name=f"seismo-follow-up-{runtime.session_id}",
            daemon=True,
        )
        with runtime.lock:
            runtime.worker = worker
        worker.start()
        return self.session_view(session_id)

    def _get(self, session_id: str) -> SessionRuntime:
        safe_id = _safe_session_id(session_id)
        with self.lock:
            runtime = self.sessions.get(safe_id)
        if runtime is None:
            raise KeyError("Session not found")
        return runtime

    def list_sessions(self, display_language: str | None = None) -> list[dict[str, Any]]:
        with self.lock:
            sessions = list(self.sessions.values())
        sessions.sort(key=lambda item: item.created_at, reverse=True)
        requested_language = (
            normalize_output_language(display_language)
            if display_language is not None
            else None
        )
        output: list[dict[str, Any]] = []
        for item in sessions:
            with item.lock:
                analysis = item.result.get("task_analysis")
                plan = item.result.get("plan")
            source_language = item.request_context.get("output_language", "zh-CN")
            language = requested_language or source_language
            title = item.user_message
            if language == "en-US":
                title = english_session_title(
                    analysis if isinstance(analysis, dict) else None,
                    plan if isinstance(plan, dict) else None,
                    item.request_context,
                )
            output.append(
                {
                "session_id": item.session_id,
                "user_message": title,
                "preset_id": item.preset_id,
                "output_language": language,
                "source_output_language": source_language,
                "status": item.status,
                "created_at": item.created_at,
                "updated_at": item.updated_at,
                }
            )
        from .builtin_demo import BuiltinDemo
        demo = BuiltinDemo(self.settings.workspace_root)
        if demo.available:
            output.append(demo.listing(display_language))
        return output

    def delete_session(self, session_id: str) -> dict[str, Any]:
        safe_id = _safe_session_id(session_id)
        with self.lock:
            runtime = self.sessions.get(safe_id)
            if runtime is None:
                raise KeyError("Session not found")
            with runtime.lock:
                if runtime.worker is not None and runtime.worker.is_alive():
                    if runtime.request_context.get("output_language") == "en-US":
                        message = "The task is still running and cannot be deleted until the current operation finishes."
                    else:
                        message = "任务仍在处理中，请等待当前操作完成后再删除。"
                    raise RuntimeError(message)
                try:
                    self.expert_memory.delete_session(safe_id)
                except (sqlite3.Error, OSError) as exc:
                    raise RuntimeError("Expert memory is temporarily unavailable. The session has been retained.") from exc
                runtime.status = "deleting"
                state = deepcopy(runtime.result)
            del self.sessions[safe_id]

        run_ids: set[str] = set()

        def collect_run_id(value: Any) -> None:
            if not isinstance(value, dict):
                return
            run_id = value.get("run_id")
            if isinstance(run_id, str) and SAFE_SESSION_RE.fullmatch(run_id):
                run_ids.add(run_id)
            nested = value.get("skill_result")
            if isinstance(nested, dict):
                collect_run_id(nested)

        collect_run_id(state.get("skill_result"))
        for record in state.get("iteration_history", []):
            collect_run_id(record)

        self.checkpointer.delete_thread(safe_id)
        skill_root = self.settings.skill_run_root.resolve()
        for run_id in run_ids:
            run_directory = (skill_root / run_id).resolve()
            if run_directory == skill_root or not _is_within(run_directory, [skill_root]):
                raise PermissionError("Refusing to delete a run directory outside skill_run_root")
            if run_directory.is_dir():
                shutil.rmtree(run_directory)
            presentation_directory = presentation_cache_directory(skill_root, run_id)
            if presentation_directory.is_dir():
                shutil.rmtree(presentation_directory)

        session_root = self.settings.agent_run_root.resolve()
        session_directory = (session_root / safe_id).resolve()
        if session_directory == session_root or not _is_within(
            session_directory, [session_root]
        ):
            raise PermissionError("Refusing to delete a session outside agent_run_root")
        if session_directory.is_dir():
            shutil.rmtree(session_directory)

        return {
            "session_id": safe_id,
            "deleted": True,
            "deleted_run_count": len(run_ids),
        }

    def power_scene(self, session_id: str, iteration: int | None = None) -> dict[str, Any]:
        """Read an authorized session's saved geometry/events without graph execution."""
        from .builtin_demo import BuiltinDemo, SESSION_ID
        if session_id == SESSION_ID:
            return BuiltinDemo(self.settings.workspace_root).scene(iteration)
        runtime = self._get(session_id)
        with runtime.lock:
            state = runtime.result
            result = state.get("skill_result")
            history = state.get("iteration_history") or []
            if iteration is not None:
                record = next((item for item in history if item.get("iteration") == iteration), None)
                if record is None:
                    raise KeyError("Saved computation round not found")
            else:
                run_id = result.get("run_id") if isinstance(result, dict) else None
                record = next((item for item in reversed(history) if item.get("run_id") == run_id), None)
            if isinstance(record, dict):
                result = record.get("skill_result")
                iteration = record.get("iteration")
            if not isinstance(result, dict):
                raise KeyError("This session has no saved electrical computation")
        return self.power_scenes.scene(result, iteration)

    def session_view(
        self,
        session_id: str,
        display_language: str | None = None,
    ) -> dict[str, Any]:
        from .builtin_demo import BuiltinDemo, SESSION_ID
        if session_id == SESSION_ID:
            return BuiltinDemo(self.settings.workspace_root).view(display_language)
        runtime = self._get(session_id)
        events = _read_events(self.settings.agent_run_root, session_id)
        event_state = _state_from_events(events)
        with runtime.lock:
            state = {**event_state, **runtime.result}
            skill_result = state.get("skill_result") if isinstance(state.get("skill_result"), dict) else None
            validation = state.get("validation") if isinstance(state.get("validation"), dict) else None
            analysis = state.get("task_analysis") if isinstance(state.get("task_analysis"), dict) else None
            plan = state.get("plan") if isinstance(state.get("plan"), dict) else None
            evidence = state.get("knowledge_evidence", [])
            iteration_history = state.get("iteration_history", [])
            status = runtime.status
            interrupt_payload = runtime.interrupt
            error = runtime.error
            updated_at = runtime.updated_at
            follow_ups = deepcopy(runtime.follow_ups)
        failed_attempt = state.get("skill_error")
        recovery_attempt = None
        result_plan = plan
        result_evidence = evidence
        if isinstance(failed_attempt, dict) and failed_attempt.get("run_id"):
            retained_run_id = skill_result.get("run_id") if skill_result else None
            recovery_attempt = {**failed_attempt, "retained_result": None}
            if retained_run_id:
                recovery_attempt["retained_result"] = {
                    "run_id": retained_run_id,
                    "iteration": state.get("iteration"),
                }
                # Keep the previous result's presentation bound to its executed plan.
                result_plan = next(
                    (
                        record.get("plan")
                        for record in reversed(iteration_history)
                        if isinstance(record, dict) and record.get("run_id") == retained_run_id
                    ),
                    None,
                )
                result_evidence = []
        compact_result = None
        source_output_language = runtime.request_context.get("output_language", "zh-CN")
        output_language = normalize_output_language(
            display_language or source_output_language
        )
        requested_skill_ids = (
            [
                str(item)
                for item in analysis.get("requested_capabilities", [])
                if isinstance(item, str) and item
            ]
            if isinstance(analysis, dict)
            else []
        )
        projection = None
        if output_language == "en-US" and skill_result is not None and not historical_result(skill_result):
            try:
                projection = self.presentation_builder.build(
                    skill_result=skill_result,
                    analysis=analysis,
                    plan=result_plan,
                    evidence=result_evidence,
                    request_context=runtime.request_context,
                )
            except Exception as exc:
                self.audit.record(
                    runtime.session_id,
                    "presentation_projection_error",
                    {"language": output_language, "message": f"{type(exc).__name__}: {exc}"},
                )
        if skill_result is not None:
            compact_result = {
                "status": skill_result.get("status"),
                "skill_id": skill_result.get("skill_id"),
                "run_id": skill_result.get("run_id"),
                "warnings": localize_warning_dicts(
                    skill_result.get("warnings", []), output_language
                ),
                "assumptions": localize_assumptions(
                    skill_result.get("assumptions", []), output_language
                ),
                "provenance": skill_result.get("provenance", {}),
                "requested_skill_ids": skill_result.get("data", {}).get(
                    "requested_skill_ids", []
                )
                if isinstance(skill_result.get("data"), dict)
                else [],
                "execution_target_skill_ids": skill_result.get("data", {}).get(
                    "execution_target_skill_ids", []
                )
                if isinstance(skill_result.get("data"), dict)
                else [],
            }

        report_summary = (
            projection.get("report_summary")
            if isinstance(projection, dict) and isinstance(projection.get("report_summary"), dict)
            else _report_summary(
                skill_result,
                self.allowed_artifact_roots,
                output_language,
                requested_skill_ids,
            )
        )
        result_delivery = (
            projection.get("result_delivery")
            if isinstance(projection, dict) and isinstance(projection.get("result_delivery"), dict)
            else _delivery_view(skill_result)
        )
        execution_trace = (
            projection.get("execution_trace", [])
            if isinstance(projection, dict)
            else _execution_trace_view(skill_result)
        )
        artifact_views = (
            presentation_artifact_views(projection, runtime.session_id)
            if isinstance(projection, dict)
            else _artifact_views(skill_result, runtime.session_id)
        )
        audit_files = _audit_file_views(
            self.settings.agent_run_root, runtime.session_id
        )
        session_artifacts = _session_artifact_views(
            self.settings.agent_run_root,
            runtime.session_id,
            output_language,
        )
        compact_events = _compact_events(events)
        iterations = _iteration_views(
            iteration_history,
            runtime.session_id,
            self.allowed_artifact_roots,
            output_language,
            requested_skill_ids,
        )
        for item in iterations:
            item["comparison_status"] = comparison_status(report_summary, item.get("report_summary"))

        user_message = runtime.user_message
        analysis_view = analysis
        evidence_view = _compact_evidence(evidence)
        plan_view = plan
        validation_view = validation
        review_view = interrupt_payload
        final_answer = state.get("final_answer")
        current_interpretation = state.get("current_interpretation")
        error_view = error
        errors_view = state.get("errors", [])
        follow_up_views = follow_ups

        if output_language == "en-US":
            objective = english_objective(
                analysis,
                plan,
                runtime.request_context,
            )
            user_message = english_session_title(
                analysis,
                plan,
                runtime.request_context,
            )
            analysis_view = project_task_analysis(
                analysis,
                plan,
                runtime.request_context,
            )
            projected_evidence = project_knowledge_evidence(evidence)
            evidence_view = _compact_evidence(projected_evidence)
            plan_view = project_plan(plan, analysis, runtime.request_context)
            validation_view = project_validation(validation, objective)
            interpretation = (
                projection.get("interpretation")
                if isinstance(projection, dict)
                else None
            )
            current_interpretation = interpretation or sanitize_visible(
                current_interpretation
            )
            final_answer = sanitize_visible(final_answer)
            if status != "rejected" and interpretation:
                final_answer = interpretation
            review_view = project_review(interrupt_payload, current_interpretation)
            recovery_attempt = sanitize_visible(recovery_attempt)
            report_summary = sanitize_visible(report_summary)
            result_delivery = sanitize_visible(result_delivery)
            execution_trace = sanitize_execution_trace(execution_trace)
            audit_files = project_audit_files(audit_files)
            compact_events = project_events(compact_events, objective)
            iterations = project_iterations(
                iterations,
                analysis=analysis,
                request_context=runtime.request_context,
                projection=projection,
            )
            if isinstance(projection, dict):
                projected_run_id = str(
                    projection.get("source_signature", {}).get("run_id") or ""
                )
                for item in iterations:
                    if str(item.get("run_id") or "") == projected_run_id:
                        item["artifacts"] = deepcopy(artifact_views)
            follow_up_views = project_follow_ups(follow_ups)
            error_view = sanitize_visible(error)
            errors_view = sanitize_visible(state.get("errors", []))
            if compact_result is not None:
                compact_result = sanitize_visible(compact_result)
        return redact(
            {
                "session_id": runtime.session_id,
                "user_message": user_message,
                "preset_id": runtime.preset_id,
                "output_language": output_language,
                "source_output_language": source_output_language,
                "display_language": output_language,
                "status": status,
                "historical_read_only": runtime.historical_read_only or historical_result(skill_result),
                "metric_standard_status": "historical_unverified" if runtime.historical_read_only or historical_result(skill_result) else "official",
                "created_at": runtime.created_at,
                "updated_at": updated_at,
                "task_analysis": analysis_view,
                "knowledge_evidence": evidence_view,
                "knowledge_usage": [
                    event["payload"] for event in events[-100:]
                    if event.get("stage") == "knowledge_usage" and isinstance(event.get("payload"), dict)
                ][-10:],
                "expert_memory": self._expert_memory_view(session_id, state),
                "plan": plan_view,
                "validation": validation_view,
                "review": review_view,
                "recovery_attempt": recovery_attempt,
                "final_answer": final_answer,
                "current_interpretation": current_interpretation,
                "iteration": state.get("iteration", 0),
                "iterations": iterations,
                "errors": errors_view,
                "error": error_view,
                "follow_ups": follow_up_views,
                "skill_result": compact_result,
                "skill_progress": _skill_progress(
                    events,
                    status,
                    self.settings.skill_run_root,
                    self.catalog,
                ),
                "report_summary": report_summary,
                "result_delivery": result_delivery,
                "execution_trace": execution_trace,
                "artifacts": artifact_views,
                "session_artifacts": session_artifacts,
                "audit_files": audit_files,
                "events": compact_events,
            }
        )

    def presentation_artifact(
        self,
        session_id: str,
        language: str,
        index: int,
    ) -> tuple[Path, str]:
        if normalize_output_language(language) != "en-US":
            raise KeyError("Presentation artifact not found")
        runtime = self._get(session_id)
        with runtime.lock:
            skill_result = runtime.result.get("skill_result")
            analysis = runtime.result.get("task_analysis")
            plan = runtime.result.get("plan")
            evidence = runtime.result.get("knowledge_evidence", [])
        if not isinstance(skill_result, dict):
            raise KeyError("Presentation artifact not found")
        projection = self.presentation_builder.build(
            skill_result=skill_result,
            analysis=analysis if isinstance(analysis, dict) else None,
            plan=plan if isinstance(plan, dict) else None,
            evidence=evidence,
            request_context=runtime.request_context,
        )
        artifacts = projection.get("artifacts", []) if isinstance(projection, dict) else []
        if index < 0 or index >= len(artifacts):
            raise KeyError("Presentation artifact not found")
        artifact = artifacts[index]
        if not isinstance(artifact, dict):
            raise KeyError("Presentation artifact not found")
        path = _available_artifact_path(
            Path(str(artifact.get("path") or "")),
            self.allowed_artifact_roots,
        )
        if path is None:
            raise PermissionError("Presentation artifact is outside allowed run roots")
        media_type = str(
            artifact.get("media_type")
            or mimetypes.guess_type(path.name)[0]
            or "application/octet-stream"
        )
        return path, media_type

    def artifact(
        self,
        session_id: str,
        index: int,
        iteration: int | None = None,
    ) -> tuple[Path, str]:
        runtime = self._get(session_id)
        with runtime.lock:
            result = runtime.result.get("skill_result")
            if iteration is not None:
                history = runtime.result.get("iteration_history", [])
                record = next(
                    (
                        item
                        for item in history
                        if isinstance(item, dict) and item.get("iteration") == iteration
                    ),
                    None,
                )
                result = record.get("skill_result") if isinstance(record, dict) else None
            artifacts = result.get("artifacts", []) if isinstance(result, dict) else []
        if index < 0 or index >= len(artifacts):
            raise KeyError("Artifact not found")
        artifact = artifacts[index]
        if not isinstance(artifact, dict):
            raise KeyError("Artifact not found")
        path = _available_artifact_path(
            Path(str(artifact.get("path") or "")),
            self.allowed_artifact_roots,
        )
        if path is None:
            raise PermissionError("Artifact path is unavailable")
        media_type = str(artifact.get("media_type") or mimetypes.guess_type(path.name)[0] or "application/octet-stream")
        return path, media_type

    def session_artifact(
        self,
        session_id: str,
        index: int,
    ) -> tuple[Path, str]:
        runtime = self._get(session_id)
        with runtime.lock:
            if runtime.worker is not None and runtime.worker.is_alive():
                raise RuntimeError(
                    "The session is still processing; its final report is not ready for download."
                )
        generated = self._refresh_session_report(
            runtime,
            raise_on_error=True,
            reason="artifact_download",
        )
        if generated is None:
            raise KeyError("Session artifact not found")
        directory = _session_report_directory(
            self.settings.agent_run_root,
            runtime.session_id,
        )
        artifacts = _session_artifact_paths(
            self.settings.agent_run_root,
            runtime.session_id,
        )
        if index < 0 or index >= len(artifacts):
            raise KeyError("Session artifact not found")
        path = artifacts[index].resolve()
        if (
            not path.is_file()
            or not _is_within(path, [directory])
            or not _is_within(path, self.allowed_artifact_roots)
        ):
            raise PermissionError("Session artifact path is unavailable")
        media_type = str(
            mimetypes.guess_type(path.name)[0]
            or (
                SESSION_REPORT_MEDIA_TYPE
                if path.suffix.lower() == ".docx"
                else "application/octet-stream"
            )
        )
        return path, media_type

    def audit_file(self, session_id: str, name: str) -> tuple[Path, str]:
        safe_id = _safe_session_id(session_id)
        allowed = {
            "events.jsonl": "application/x-ndjson",
            "final_state.json": "application/json",
            "session.json": "application/json",
        }
        if name not in allowed:
            raise KeyError("Audit file not found")
        path = self.settings.agent_run_root.resolve() / safe_id / name
        if not path.is_file() or not _is_within(path, [self.settings.agent_run_root]):
            raise KeyError("Audit file not found")
        return path, allowed[name]

    def health(self) -> dict[str, Any]:
        examples_root = project_paths(self.settings.workspace_root, validate=False).examples_root
        from .builtin_demo import BuiltinDemo, SESSION_ID
        return {
            "status": "ok",
            "default_demo_session_id": SESSION_ID if BuiltinDemo(self.settings.workspace_root).available else None,
            "api_key_configured": self.settings.deepseek_api_key is not None,
            "base_url": public_endpoint(self.settings.deepseek_base_url),
            "model": self.settings.deepseek_model,
            "agent_architecture": "single_llm_decision_center",
            "engineering_planning": "llm_targets_global_registry_dag",
            "human_review_required": True,
            "result_review_required": True,
            "checkpoint_backend": "sqlite",
            "knowledge_index": self.knowledge.status(),
            "skill_count": len(self.catalog),
            "skills": self.catalog,
            "presets": [
                {"id": key, **{name: value for name, value in preset.items() if name != "file"}}
                for key, preset in PRESETS.items()
                if (examples_root / preset["file"]).is_file()
            ],
            "suggested_tasks": SUGGESTED_TASKS,
            "suggested_tasks_by_language": {
                "zh-CN": SUGGESTED_TASKS,
                "en-US": SUGGESTED_TASKS_EN,
            },
            "supported_output_languages": ["zh-CN", "en-US"],
        }


class AgentHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], manager: SessionManager, static_root: Path) -> None:
        super().__init__(address, AgentRequestHandler)
        self.manager = manager
        self.static_root = static_root

    def server_close(self) -> None:
        super().server_close()
        close = getattr(self.manager, "close", None)
        if callable(close):
            close()


class AgentRequestHandler(BaseHTTPRequestHandler):
    server: AgentHTTPServer
    server_version = "SeismoSkillAgent/0.2"
    sys_version = ""

    def log_message(self, format: str, *args: Any) -> None:
        print(f"[{self.log_date_time_string()}] {format % args}")

    def _headers(self, status: int, content_type: str, length: int | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "no-store" if content_type.startswith("application/json") else "public, max-age=60")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "SAMEORIGIN")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        if length is not None:
            self.send_header("Content-Length", str(length))
        self.end_headers()

    def _json(self, payload: Any, status: int = HTTPStatus.OK) -> None:
        body = json.dumps(payload, ensure_ascii=False, default=str).encode("utf-8")
        self._headers(status, "application/json; charset=utf-8", len(body))
        self.wfile.write(body)

    def _error(self, status: int, message: str) -> None:
        self._json({"error": message}, status)

    def _body(self) -> dict[str, Any]:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as exc:
            raise ValueError("Invalid Content-Length") from exc
        if length <= 0 or length > MAX_REQUEST_BYTES:
            raise ValueError("请求体为空或超过2MB限制。")
        payload = json.loads(self.rfile.read(length).decode("utf-8"))
        if not isinstance(payload, dict):
            raise ValueError("请求体必须是JSON对象。")
        return payload

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        query = parse_qs(parsed.query)
        display_language = query.get("language", [None])[0]
        try:
            if path == "/api/health":
                self._json(self.server.manager.health())
                return
            if path == "/api/sessions":
                self._json(
                    {
                        "sessions": self.server.manager.list_sessions(
                            display_language
                        )
                    }
                )
                return
            if path == "/api/power-case":
                self._power_scene_json(self.server.manager.power_scenes.case())
                return
            reference_figure_match = re.fullmatch(r"/api/sessions/([^/]+)/reference-figures(?:/([A-Za-z0-9_-]+)\.(png|svg|pdf))?", path)
            if reference_figure_match:
                from . import reference_figures

                session_id = _safe_session_id(reference_figure_match.group(1))
                raw_iteration = query.get("iteration", [None])[0]
                iteration = int(raw_iteration) if raw_iteration is not None else None
                if iteration is not None and iteration < 1:
                    raise ValueError("Computation round must be positive")
                view = self.server.manager.session_view(session_id, display_language)
                cache_root = self.server.manager.settings.agent_run_root / "_presentation" / "reference-figures"
                if reference_figure_match.group(2):
                    artifact = reference_figures.artifact(
                        view, iteration, reference_figure_match.group(2), reference_figure_match.group(3),
                        cache_root, revision=query.get("revision", [None])[0],
                    )
                    self._send_artifact(artifact, mimetypes.guess_type(artifact.name)[0] or "application/octet-stream", parsed.query)
                else:
                    self._json(reference_figures.manifest(view, iteration, cache_root, f"/api/sessions/{session_id}/reference-figures"))
                return
            scene_match = re.fullmatch(r"/api/sessions/([^/]+)/power-scene", path)
            if scene_match:
                raw_iteration = query.get("iteration", [None])[0]
                iteration = int(raw_iteration) if raw_iteration is not None else None
                if iteration is not None and iteration < 1:
                    raise ValueError("Computation round must be positive")
                self._power_scene_json(self.server.manager.power_scene(
                    _safe_session_id(scene_match.group(1)), iteration))
                return
            presentation_artifact_match = re.fullmatch(
                r"/api/sessions/([^/]+)/presentation/(en-US|zh-CN)/artifacts/(\d+)",
                path,
            )
            if presentation_artifact_match:
                session_id = _safe_session_id(presentation_artifact_match.group(1))
                artifact, media_type = self.server.manager.presentation_artifact(
                    session_id,
                    presentation_artifact_match.group(2),
                    int(presentation_artifact_match.group(3)),
                )
                self._send_artifact(artifact, media_type, parsed.query)
                return
            session_artifact_match = re.fullmatch(
                r"/api/sessions/([^/]+)/session-artifacts/(\d+)", path
            )
            if session_artifact_match:
                session_id = _safe_session_id(session_artifact_match.group(1))
                artifact, media_type = self.server.manager.session_artifact(
                    session_id,
                    int(session_artifact_match.group(2)),
                )
                self._send_artifact(artifact, media_type, parsed.query)
                return
            iteration_artifact_match = re.fullmatch(
                r"/api/sessions/([^/]+)/iterations/(\d+)/artifacts/(\d+)", path
            )
            if iteration_artifact_match:
                session_id = _safe_session_id(iteration_artifact_match.group(1))
                artifact, media_type = self.server.manager.artifact(
                    session_id,
                    int(iteration_artifact_match.group(3)),
                    int(iteration_artifact_match.group(2)),
                )
                self._send_artifact(artifact, media_type, parsed.query)
                return
            artifact_match = re.fullmatch(r"/api/sessions/([^/]+)/artifacts/(\d+)", path)
            if artifact_match:
                session_id = _safe_session_id(artifact_match.group(1))
                artifact, media_type = self.server.manager.artifact(session_id, int(artifact_match.group(2)))
                self._send_artifact(artifact, media_type, parsed.query)
                return
            audit_match = re.fullmatch(
                r"/api/sessions/([^/]+)/audit/(events\.jsonl|final_state\.json|session\.json)",
                path,
            )
            if audit_match:
                session_id = _safe_session_id(audit_match.group(1))
                artifact, media_type = self.server.manager.audit_file(
                    session_id, audit_match.group(2)
                )
                self._send_artifact(artifact, media_type, parsed.query)
                return
            session_match = re.fullmatch(r"/api/sessions/([^/]+)", path)
            if session_match:
                self._json(
                    self.server.manager.session_view(
                        _safe_session_id(session_match.group(1)),
                        display_language,
                    )
                )
                return
            if path in {"/", "/index.html"}:
                self._static("index.html")
                return
            demo_asset = re.fullmatch(r"/demo/auckland/([A-Za-z0-9_.-]+)", path)
            if demo_asset:
                from .builtin_demo import BuiltinDemo
                asset = BuiltinDemo(self.server.manager.settings.workspace_root).artifact(demo_asset.group(1))
                self._send_artifact(asset, mimetypes.guess_type(asset.name)[0] or "application/octet-stream", parsed.query)
                return
            if path in {"/styles.css", "/app.js", "/lucide.min.js", "/power-scene.js", "/power-scene.css", "/power-workbench.js", "/power-workbench.css"} or path.startswith("/vendor/"):
                self._static(path.lstrip("/"))
                return
            self._error(HTTPStatus.NOT_FOUND, "Not found")
        except KeyError as exc:
            self._error(HTTPStatus.NOT_FOUND, str(exc))
        except PermissionError as exc:
            self._error(HTTPStatus.FORBIDDEN, str(exc))
        except ValueError as exc:
            self._error(HTTPStatus.BAD_REQUEST, str(exc))
        except RuntimeError as exc:
            self._error(HTTPStatus.SERVICE_UNAVAILABLE, str(exc))

    def _send_artifact(self, artifact: Path, media_type: str, query: str) -> None:
        body = artifact.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", media_type)
        disposition = "attachment" if parse_qs(query).get("download") else "inline"
        encoded_name = quote(artifact.name, safe="")
        self.send_header("Content-Disposition", f"{disposition}; filename*=UTF-8''{encoded_name}")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        display_language = parse_qs(parsed.query).get("language", [None])[0]
        try:
            payload = self._body()
            if path == "/api/sessions":
                overrides = payload.get("overrides") or {}
                if not isinstance(overrides, dict):
                    raise ValueError("overrides必须是JSON对象。")
                view = self.server.manager.create_session(
                    str(payload.get("message") or ""),
                    str(payload.get("preset") or "quick"),
                    overrides,
                )
                self._json(view, HTTPStatus.ACCEPTED)
                return
            match = re.fullmatch(r"/api/sessions/([^/]+)/decision", path)
            if match:
                session_id = _safe_session_id(match.group(1))
                view = self.server.manager.decide(session_id, payload)
                if display_language is not None:
                    view = self.server.manager.session_view(session_id, display_language)
                self._json(view, HTTPStatus.ACCEPTED)
                return
            message_match = re.fullmatch(r"/api/sessions/([^/]+)/messages", path)
            if message_match:
                session_id = _safe_session_id(message_match.group(1))
                view = self.server.manager.ask_follow_up(session_id, payload)
                if display_language is not None:
                    view = self.server.manager.session_view(session_id, display_language)
                self._json(view, HTTPStatus.ACCEPTED)
                return
            memory_match = re.fullmatch(r"/api/sessions/([^/]+)/expert-memory", path)
            if memory_match:
                if self.headers.get_content_type() != "application/json":
                    raise ValueError("Expert-memory requests require application/json.")
                session_id = _safe_session_id(memory_match.group(1))
                self._json(self.server.manager.update_expert_memory(session_id, payload))
                return
            self._error(HTTPStatus.NOT_FOUND, "Not found")
        except json.JSONDecodeError:
            self._error(HTTPStatus.BAD_REQUEST, "请求体不是有效JSON。")
        except KeyError as exc:
            self._error(HTTPStatus.NOT_FOUND, str(exc))
        except (ValueError, AgentConfigurationError) as exc:
            self._error(HTTPStatus.BAD_REQUEST, str(exc))
        except RuntimeError as exc:
            self._error(HTTPStatus.CONFLICT, str(exc))

    def do_DELETE(self) -> None:  # noqa: N802
        path = unquote(urlparse(self.path).path)
        try:
            session_match = re.fullmatch(r"/api/sessions/([^/]+)", path)
            if session_match:
                result = self.server.manager.delete_session(
                    _safe_session_id(session_match.group(1))
                )
                self._json(result)
                return
            self._error(HTTPStatus.NOT_FOUND, "Not found")
        except KeyError as exc:
            self._error(HTTPStatus.NOT_FOUND, str(exc))
        except PermissionError as exc:
            self._error(HTTPStatus.FORBIDDEN, str(exc))
        except ValueError as exc:
            self._error(HTTPStatus.BAD_REQUEST, str(exc))
        except RuntimeError as exc:
            self._error(HTTPStatus.CONFLICT, str(exc))

    def _power_scene_json(self, payload: Any) -> None:
        """Compress ID-keyed saved event frames; never send repeated full geometry."""
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
        compressed = "gzip" in self.headers.get("Accept-Encoding", "").lower()
        if compressed:
            body = gzip.compress(body, compresslevel=5)
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "SAMEORIGIN")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Vary", "Accept-Encoding")
        if compressed:
            self.send_header("Content-Encoding", "gzip")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _static(self, name: str) -> None:
        allowed = {"index.html", "styles.css", "app.js", "lucide.min.js", "power-scene.js", "power-scene.css", "power-workbench.js", "power-workbench.css"}
        root = self.server.static_root.resolve()
        path = (root / name).resolve()
        vendor = name.startswith("vendor/") and path.suffix.lower() in {".js", ".css", ".png", ".jpg", ".svg", ".gif", ".woff", ".woff2", ".ttf", ".txt", ".json", ".wasm", ".xml"}
        if not path.is_relative_to(root) or (name not in allowed and not vendor):
            self._error(HTTPStatus.NOT_FOUND, "Not found")
            return
        if not path.is_file():
            self._error(HTTPStatus.NOT_FOUND, "Frontend asset not found")
            return
        body = path.read_bytes()
        content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        if content_type.startswith("text/") or content_type == "application/javascript":
            content_type += "; charset=utf-8"
        self._headers(HTTPStatus.OK, content_type, len(body))
        self.wfile.write(body)


def create_server(
    host: str,
    port: int,
    settings: AgentSettings,
    *,
    llm_factory: Callable[[AgentSettings], DecisionLLM] | None = None,
    static_root: Path = STATIC_ROOT,
) -> AgentHTTPServer:
    return AgentHTTPServer((host, port), SessionManager(settings, llm_factory), static_root)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="seismo-skill-agent-web")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        settings = AgentSettings.from_env(require_api_key=False)
        server = create_server(args.host, args.port, settings)
    except (AgentConfigurationError, OSError, ValueError) as exc:
        print(f"error: {exc}")
        return 2
    print(f"SeismoSkill Agent Web: http://{args.host}:{server.server_port}")
    try:
        server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
